import "./env";

import { asc, eq, gt } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

import { backfillItemIds } from "../src/lib/cms/backfill";
import { pageSections } from "../src/lib/db/schema";

/**
 * Applies every pending migration and exits. Run by `npm run db:migrate` and by
 * the deployment script before the new release is started.
 */

type Db = ReturnType<typeof drizzle>;

/**
 * Gives the rows already in the database the stable ids that new saves get.
 *
 * This is a data migration, and it runs here rather than as a command somebody
 * has to remember: `deploy.sh` already calls `npm run db:migrate`, so the
 * normal release is enough and the hardened deploy flow needs no change. It is
 * deliberately not a `.sql` file — which fields are repeatable is decided by
 * the block registry in TypeScript, and a hand-written SQL list of field names
 * would be a second copy of that registry, wrong the first time a block gains
 * a list.
 *
 * The write goes through Drizzle rather than through hand-built SQL, and that
 * is not a matter of taste: it is the same statement the admin panel uses to
 * save a section, so these two columns are written in exactly one way in this
 * repository. Getting the encoding of a `jsonb` parameter subtly wrong stores
 * the whole section as one JSON *string* — every page on the site, gone — and
 * the way not to get it wrong is not to have a second opinion about it.
 *
 * Safe to run against a database it has already run against: `backfillItemIds`
 * returns `null` for a section whose rows all carry a well-formed, unique id,
 * so the second run reads everything and writes nothing. Safe to interrupt,
 * too — each section is its own statement, so a half-finished run is simply
 * finished by the next one. That is why there is no wrapping transaction: the
 * work is idempotent, and holding write locks across the whole table while the
 * previous release is still serving buys nothing.
 *
 * `updated_at` and `revision` are deliberately left alone. Nobody edited these
 * sections; stamping them would make the admin's "last changed" column lie.
 *
 * During the deploy window the previous release is still serving and still
 * saving. Its validator does not know `_id` and would drop the key from any
 * section an editor saved in those few minutes — harmless, because nothing
 * references a row id yet, and the next save under the new release stamps it
 * again.
 */
async function backfillRowIds(db: Db): Promise<void> {
  let after = 0;
  let scanned = 0;
  let stamped = 0;

  for (;;) {
    const rows = await db
      .select({
        id: pageSections.id,
        blockType: pageSections.blockType,
        published: pageSections.published,
        draft: pageSections.draft,
      })
      .from(pageSections)
      .where(gt(pageSections.id, after))
      .orderBy(asc(pageSections.id))
      .limit(500);
    if (rows.length === 0) break;

    for (const row of rows) {
      after = row.id;
      scanned += 1;

      const published = backfillItemIds(row.blockType, row.published);
      const draft = backfillItemIds(row.blockType, row.draft);
      if (!published && !draft) continue;

      await db
        .update(pageSections)
        .set({ ...(published ? { published } : {}), ...(draft ? { draft } : {}) })
        .where(eq(pageSections.id, row.id));
      stamped += 1;
    }
  }

  console.log(
    stamped === 0
      ? `Row ids: nothing to do (${scanned} sections already stable).`
      : `Row ids: ${stamped} of ${scanned} sections stamped.`,
  );
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const client = postgres(url, { max: 1 });
  try {
    const db = drizzle(client);
    await migrate(db, { migrationsFolder: "./drizzle" });
    console.log("Migrations applied.");
    await backfillRowIds(db);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
