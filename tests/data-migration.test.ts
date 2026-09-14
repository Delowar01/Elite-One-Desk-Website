/**
 * The data foundation against a real database.
 *
 * Three things are measured here, none of which can be checked without one:
 *
 *  · the row-id backfill arrives with the ordinary `npm run db:migrate`, so a
 *    release needs no hand-run command and `deploy/deploy.sh` needs no change;
 *  · it adds `_id` and nothing else, and a second run writes nothing;
 *  · the concurrency guard and the version/restore path behave against real
 *    rows — including the rule that a restore is never live.
 *
 * The modules in the last group are marked `server-only`, so they are driven
 * the way the server drives them rather than imported here: see `helpers/probe`.
 */
import assert from "node:assert/strict";
import { after, describe, test } from "node:test";

import { backfillItemIds, repeatableFields, withoutItemIds } from "@/lib/cms/backfill";
import { getBlock } from "@/lib/cms/blocks";
import { hasStableItemIds, isItemId } from "@/lib/cms/item-id";

import { giveFresh, giveLegacy } from "./helpers/fixtures";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { probeValue } from "./helpers/probe";
import { migrate } from "./helpers/run";

type Values = Record<string, unknown> | null;

type SectionRow = {
  id: number;
  block_type: string;
  published: Values;
  draft: Values;
  updated_at: Date;
  revision: number;
  position: number;
  is_published: boolean;
};

const opened: Array<{ name: string; sql: Sql }> = [];

function open(name: string): Sql {
  const sql = connect(name);
  opened.push({ name, sql });
  return sql;
}

after(async () => {
  for (const { name, sql } of opened) {
    await sql.end({ timeout: 5 });
    dropDatabase(name);
  }
});

const sections = (sql: Sql) =>
  sql<SectionRow[]>`
    select id, block_type, published, draft, updated_at, revision, position, is_published
    from page_sections
    order by id
  `;

/** Every repeatable list in a section, by the registry's reckoning. */
function lists(row: SectionRow): Array<{ where: string; rows: Record<string, unknown>[] }> {
  const block = getBlock(row.block_type);
  if (!block) return [];
  const out: Array<{ where: string; rows: Record<string, unknown>[] }> = [];
  for (const document of ["published", "draft"] as const) {
    const values = row[document];
    if (!values) continue;
    for (const field of repeatableFields(block)) {
      const value = values[field];
      if (Array.isArray(value) && value.length) {
        out.push({ where: `#${row.id} ${row.block_type}.${document}.${field}`, rows: value });
      }
    }
  }
  return out;
}

const allLists = (rows: SectionRow[]) => rows.flatMap(lists);

/**
 * A JSON document as a `jsonb` parameter — and the reason the cast is spelt out
 * twice.
 *
 * `${document}::jsonb` is not enough. PostgreSQL resolves such a parameter as
 * `jsonb`, the driver is then entitled to encode the string it was handed a
 * second time, and what lands in the column is the whole document as one JSON
 * *string*. Naming it `text` first settles the type before the cast, so the
 * server parses the text exactly once. The shipped backfill sidesteps the
 * question entirely by writing through Drizzle; this test writes raw SQL on
 * purpose, so it has to answer it.
 */
const jsonb = (value: unknown) => JSON.stringify(value);

/* -------------------------------------------------------------------------- */

describe("row ids arrive with the ordinary migration", () => {
  test("a database seeded before this batch comes out of db:migrate stamped", async () => {
    // The legacy fixture is the pre-cutover seed with this branch's migration
    // applied on top — the same sequence a deployment performs. Nothing in the
    // test stamps anything; if these rows have ids, `npm run db:migrate` put
    // them there.
    const sql = open(giveLegacy("ids_legacy"));
    const rows = await sections(sql);
    assert.ok(rows.length > 0, "the fixture has no sections");

    const found = allLists(rows);
    assert.ok(found.length >= 3, `expected repeatable lists in the fixture, found ${found.length}`);
    for (const list of found) assert.ok(hasStableItemIds(list.rows), list.where);
  });

  test("stripping the ids and migrating again puts them back and changes nothing else", async () => {
    const name = giveFresh("ids_backfill");
    const sql = open(name);

    // Wind the database back to the shape it had before this batch: no `_id`
    // anywhere. Written with raw SQL so `updated_at` and `revision` are left
    // exactly as the seed left them — they are part of what is compared.
    const seeded = await sections(sql);
    for (const row of seeded) {
      await sql`
        update page_sections
        set published = ${jsonb(withoutItemIds(row.published ?? {}))}::text::jsonb
        where id = ${row.id}
      `;
    }
    const before = await sections(sql);
    assert.ok(allLists(before).length >= 3, "nothing repeatable to stamp");
    for (const list of allLists(before)) {
      assert.ok(!hasStableItemIds(list.rows), `${list.where} was already stamped`);
    }

    const result = migrate(name);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Row ids: \d+ of \d+ sections stamped\./);

    const now = await sections(sql);
    assert.equal(now.length, before.length, "the backfill added or removed a section");

    for (const [index, row] of now.entries()) {
      const was = before[index]!;
      assert.equal(row.id, was.id);
      // The equivalence that matters: identical documents apart from `_id`.
      assert.deepEqual(withoutItemIds(row.published), withoutItemIds(was.published), `#${row.id} published`);
      assert.deepEqual(withoutItemIds(row.draft), withoutItemIds(was.draft), `#${row.id} draft`);
      // And nothing an editor or the site reads has moved.
      assert.equal(row.position, was.position, `#${row.id} position`);
      assert.equal(row.is_published, was.is_published, `#${row.id} visibility`);
      assert.equal(row.revision, was.revision, `#${row.id} revision`);
      assert.equal(
        row.updated_at.toISOString(),
        was.updated_at.toISOString(),
        `#${row.id} was stamped as edited by a migration nobody asked for`,
      );
    }

    for (const list of allLists(now)) assert.ok(hasStableItemIds(list.rows), list.where);
  });

  test("a second migration finds nothing to do and writes nothing", async () => {
    const name = giveFresh("ids_idempotent");
    const sql = open(name);

    const first = migrate(name);
    assert.equal(first.code, 0, first.output);
    const after1 = await sections(sql);

    const second = migrate(name);
    assert.equal(second.code, 0, second.output);
    assert.match(second.output, /Row ids: nothing to do \(\d+ sections already stable\)\./);

    const after2 = await sections(sql);
    assert.deepEqual(
      after2.map((row) => ({ ...row, updated_at: row.updated_at.toISOString() })),
      after1.map((row) => ({ ...row, updated_at: row.updated_at.toISOString() })),
    );
  });

  test("a draft is stamped too, and an id already there is kept", async () => {
    const name = giveFresh("ids_drafts");
    const sql = open(name);

    const [quick] = await sql<SectionRow[]>`
      select id, block_type, published, draft, updated_at, revision, position, is_published
      from page_sections where block_type = 'quick-links' limit 1
    `;
    assert.ok(quick, "the fixture has no quick-links section");

    const kept = "i_kkkkkkkkkk";
    await sql`
      update page_sections
      set draft = ${jsonb({
        links: [
          { label: { en: "One", ar: "١" }, href: "/a", icon: "", image: "" },
          { label: { en: "Two", ar: "٢" }, href: "/b", icon: "", image: "", _id: kept },
        ],
      })}::text::jsonb
      where id = ${quick.id}
    `;

    assert.equal(migrate(name).code, 0);

    const [row] = await sql<SectionRow[]>`select id, block_type, published, draft, updated_at, revision, position, is_published from page_sections where id = ${quick.id}`;
    const draftLinks = (row!.draft as { links: Record<string, unknown>[] }).links;
    assert.ok(hasStableItemIds(draftLinks));
    assert.equal(draftLinks[1]!["_id"], kept, "an existing id was replaced");
    assert.ok(isItemId(draftLinks[0]!["_id"]));
    assert.deepEqual(
      draftLinks.map((r) => (r.label as { en: string }).en),
      ["One", "Two"],
    );
  });

  test("a section of a type the registry does not know is left completely alone", async () => {
    const name = giveFresh("ids_unknown");
    const sql = open(name);

    const [page] = await sql<{ id: number }[]>`select id from pages where slug = 'home'`;
    const junk = { links: [{ label: "not ours" }] };
    const [inserted] = await sql<{ id: number }[]>`
      insert into page_sections (page_id, block_type, position, is_published, published)
      values (${page!.id}, 'no-such-block', 99, false, ${jsonb(junk)}::text::jsonb)
      returning id
    `;

    assert.equal(migrate(name).code, 0);

    const [row] = await sql<SectionRow[]>`select id, block_type, published, draft, updated_at, revision, position, is_published from page_sections where id = ${inserted!.id}`;
    assert.deepEqual(row!.published, junk, "the backfill guessed at a block it does not know");
  });

  test("a fresh installation lands in the same state a migrated one does", async () => {
    // `db:migrate` runs before `db:seed`, so the backfill can never see the
    // rows the seed is about to write. The seed stamps them itself; if it
    // stopped, a new site would be the only one whose rows have no identity.
    const sql = open(giveFresh("ids_seeded"));
    const found = allLists(await sections(sql));
    assert.ok(found.length >= 3);
    for (const list of found) assert.ok(hasStableItemIds(list.rows), list.where);
  });

  test("what the backfill would do to the fixture now is nothing", async () => {
    const sql = open(giveFresh("ids_settled"));
    for (const row of await sections(sql)) {
      assert.equal(backfillItemIds(row.block_type, row.published), null, `#${row.id} published`);
      assert.equal(backfillItemIds(row.block_type, row.draft), null, `#${row.id} draft`);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("a save has to name the revision it read", () => {
  test("the second writer is told, rather than quietly winning", async () => {
    const name = giveFresh("revision_guard");
    const sql = open(name);
    const [section] = await sql<{ id: number }[]>`select id from page_sections order by id limit 1`;
    const [page] = await sql<{ id: number }[]>`select id from pages where slug = 'home'`;

    const out = probeValue<{
      first: unknown;
      stale: unknown;
      next: unknown;
      missing: unknown;
      pageFirst: unknown;
      pageStale: unknown;
    }>(
      name,
      `
import { updateSectionGuarded, updatePageGuarded } from "@/lib/db/revision";

const id = ${section!.id};
const pageId = ${page!.id};

const first = await updateSectionGuarded(id, 0, { draft: { winner: "first" } });
const stale = await updateSectionGuarded(id, 0, { draft: { winner: "stale" } });
const next = await updateSectionGuarded(id, 1, { draft: { winner: "second" } });
const missing = await updateSectionGuarded(2147483000, 0, { draft: {} });

const pageFirst = await updatePageGuarded(pageId, 0, { draftStructure: { v: 1, sections: [] } });
const pageStale = await updatePageGuarded(pageId, 0, { draftStructure: { v: 1, sections: [] } });

emit({ first, stale, next, missing, pageFirst, pageStale });
process.exit(0);
`,
    );

    assert.deepEqual(out.first, { ok: true, revision: 1 });
    assert.deepEqual(out.stale, { ok: false, reason: "conflict" });
    assert.deepEqual(out.next, { ok: true, revision: 2 });
    assert.deepEqual(out.missing, { ok: false, reason: "missing" }, "a deleted row is not a conflict");
    assert.deepEqual(out.pageFirst, { ok: true, revision: 1 });
    assert.deepEqual(out.pageStale, { ok: false, reason: "conflict" });

    // The losing write left nothing behind at all.
    const [row] = await sql<{ draft: Values; revision: number }[]>`
      select draft, revision from page_sections where id = ${section!.id}
    `;
    assert.deepEqual(row!.draft, { winner: "second" });
    assert.equal(row!.revision, 2);
  });
});

/* -------------------------------------------------------------------------- */

describe("restoring a version puts nothing on the live site", () => {
  test("history comes back as a draft, and the published page is untouched", async () => {
    const name = giveFresh("versions_restore");
    const sql = open(name);
    const [page] = await sql<{ id: number }[]>`select id from pages where slug = 'home'`;

    const out = probeValue<{
      versions: number;
      kept: {
        id: number;
        published: Values;
        draft: Values;
        position: number;
        isPublished: boolean;
      }[];
      recreated: number[];
      draftStructure: { v: number; sections: { sectionId: number; visible: boolean }[] } | null;
      original: { id: number; blockType: string; published: Values }[];
      pruned: number;
    }>(
      name,
      `
import { asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { pageSections, pages } from "@/lib/db/schema";
import {
  listPageVersions,
  prunePageVersions,
  restoreVersionToDraft,
  savePageVersion,
} from "@/lib/versions";

const pageId = ${page!.id};
const read = () =>
  db
    .select({
      id: pageSections.id,
      blockType: pageSections.blockType,
      published: pageSections.published,
      draft: pageSections.draft,
      position: pageSections.position,
      isPublished: pageSections.isPublished,
    })
    .from(pageSections)
    .where(eq(pageSections.pageId, pageId))
    .orderBy(asc(pageSections.position), asc(pageSections.id));

const original = await read();
const versionId = await savePageVersion({ pageId, label: "before", actorName: "Integration" });
await savePageVersion({ pageId, label: "second", actorName: "Integration" });

// Now break the page the way an editor would: delete one section outright and
// overwrite another's published values.
await db.delete(pageSections).where(eq(pageSections.id, original[1].id));
await db
  .update(pageSections)
  .set({ published: { headline: { en: "VANDALISED", ar: "VANDALISED" } } })
  .where(eq(pageSections.id, original[0].id));

await restoreVersionToDraft(versionId, pageId);

const now = await read();
const survivors = new Set(original.map((row) => row.id));
const [pageRow] = await db.select().from(pages).where(eq(pages.id, pageId)).limit(1);

emit({
  versions: (await listPageVersions(pageId)).length,
  kept: now
    .filter((row) => survivors.has(row.id))
    .map(({ id, published, draft, position, isPublished }) => ({ id, published, draft, position, isPublished })),
  recreated: now.filter((row) => !survivors.has(row.id)).map((row) => row.id),
  draftStructure: pageRow.draftStructure ?? null,
  original: original.map(({ id, blockType, published }) => ({ id, blockType, published })),
  pruned: await prunePageVersions(pageId, 1),
});
process.exit(0);
`,
    );

    assert.equal(out.versions, 2, "both versions should be listed");
    assert.equal(out.pruned, 1, "the history ceiling should drop the older one");

    const first = out.original[0]!;
    const deleted = out.original[1]!;
    const kept = new Map(out.kept.map((row) => [row.id, row]));

    // The vandalised section keeps its vandalism on the published side …
    const vandalised = kept.get(first.id)!;
    assert.deepEqual(vandalised.published, { headline: { en: "VANDALISED", ar: "VANDALISED" } });
    // … and the history arrives beside it, as a draft.
    assert.deepEqual(vandalised.draft, first.published);
    assert.equal(vandalised.isPublished, true, "a restore changed a visibility flag");

    // The deleted section is back as a row nobody visiting the site can see.
    assert.equal(out.recreated.length, 1, "the deleted section was not recreated");
    const recreated = out.recreated[0]!;
    const [row] = await sql<{ is_published: boolean; published: Values; draft: Values; block_type: string }[]>`
      select is_published, published, draft, block_type from page_sections where id = ${recreated}
    `;
    assert.equal(row!.is_published, false, "a restore published a section");
    assert.equal(row!.block_type, deleted.blockType);
    assert.deepEqual(row!.draft, deleted.published, "the history did not come back");
    for (const value of Object.values(row!.published ?? {})) {
      assert.ok(
        value === "" || value === false || value === 0 || value === null ||
          (Array.isArray(value) && value.length === 0) ||
          (typeof value === "object" && Object.values(value as object).every((v) => v === "")),
        `a recreated section was published with content: ${JSON.stringify(value)}`,
      );
    }

    // The order the restore intends is recorded as a draft, with the recreated
    // section back in the middle rather than appended.
    const structure = out.draftStructure!;
    assert.equal(structure.v, 1);
    assert.equal(structure.sections[0]!.sectionId, first.id);
    assert.equal(structure.sections[1]!.sectionId, recreated, "the section came back in the wrong place");
    assert.equal(structure.sections.length, out.original.length);
  });
});
