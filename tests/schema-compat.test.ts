/**
 * A migration runs while the PREVIOUS release is still serving.
 *
 * `deploy.sh` migrates at step 10 and switches the runtime at step 14, so for
 * the minutes in between, the old code is reading the new schema. A routine
 * migration therefore has to be backward-compatible, and this is where that is
 * checked rather than assumed.
 *
 * Two checks, and they cover different things. The first runs the previous
 * release's own table definitions against the migrated schema — it catches a
 * dropped, renamed or retyped column, which is the common mistake. The second
 * reads the migration SQL and refuses destructive DDL outright unless somebody
 * marked it as a deliberate contraction.
 *
 * Neither proves semantic compatibility: a column that still exists but now
 * means something different, a default that changes behaviour, a backfill the
 * old code mishandles. That remains policy — DEPLOYMENT.md §9.2 — and review.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";

import { LEGACY_REF, REPO_ROOT, dbUrl, scriptEnv } from "./helpers/env";
import { giveLegacy, legacyTree } from "./helpers/fixtures";
import { dropDatabase } from "./helpers/pg";

const created: string[] = [];
after(() => {
  for (const name of created) dropDatabase(name);
});

describe(`the release at ${LEGACY_REF} can still read the migrated schema`, () => {
  test("every table the old release defines is still readable", () => {
    // `giveLegacy` is precisely the shape this needs: that release's seed with
    // every migration since applied on top — old data, new schema.
    const database = giveLegacy("compat");
    created.push(database);
    const tree = legacyTree();

    // A probe written into the old checkout, using the OLD release's own schema
    // definitions and its own drizzle. If the new schema dropped or renamed a
    // column the old code names, the select fails here exactly as it would fail
    // in production between migrate and switch.
    const probe = path.join(tree, "compat-probe.mts");
    writeFileSync(
      probe,
      [
        'import { drizzle } from "drizzle-orm/postgres-js";',
        'import postgres from "postgres";',
        'import * as schema from "./src/lib/db/schema";',
        "",
        "const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });",
        "const db = drizzle(sql);",
        "const failures: string[] = [];",
        "for (const [name, table] of Object.entries(schema)) {",
        '  if (!table || typeof table !== "object") continue;',
        '  if (!Object.getOwnPropertySymbols(table).some((s) => String(s).includes("drizzle:Name"))) continue;',
        "  try {",
        "    // eslint-disable-next-line @typescript-eslint/no-explicit-any",
        "    await db.select().from(table as any).limit(1);",
        "  } catch (error) {",
        "    failures.push(`${name}: ${(error as Error).message}`);",
        "  }",
        "}",
        "await sql.end();",
        'if (failures.length) { console.error("INCOMPATIBLE\\n" + failures.join("\\n")); process.exit(1); }',
        'console.log("COMPATIBLE");',
      ].join("\n"),
      "utf8",
    );

    const result = spawnSync("npx", ["tsx", "compat-probe.mts"], {
      cwd: tree,
      encoding: "utf8",
      env: scriptEnv(dbUrl(database)),
      maxBuffer: 16 * 1024 * 1024,
    });
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    assert.equal(result.status, 0, `the old release cannot read the new schema:\n${output}`);
    assert.match(output, /COMPATIBLE/);
  });
});

describe("migrations stay additive", () => {
  /**
   * Contractions — dropping the column nobody reads any more — are legitimate,
   * but they belong in a later release than the one that stopped reading it.
   * The marker makes that a decision somebody wrote down rather than a line
   * that slipped through.
   */
  const DESTRUCTIVE = [
    /\bDROP\s+COLUMN\b/i,
    /\bDROP\s+TABLE\b/i,
    /\bRENAME\s+(COLUMN|TO)\b/i,
    /\bALTER\s+COLUMN\s+\S+\s+SET\s+NOT\s+NULL\b/i,
    /\bALTER\s+COLUMN\s+\S+\s+(SET\s+DATA\s+)?TYPE\b/i,
    /\bDROP\s+(CONSTRAINT|DEFAULT)\b/i,
  ];
  const APPROVED = /--\s*contract:\s*approved\b/i;

  test("no migration drops, renames or narrows anything without an approval marker", () => {
    const dir = path.join(REPO_ROOT, "drizzle");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    assert.ok(files.length > 0, "there should be migrations to check");

    const offenders: string[] = [];
    for (const file of files) {
      const sql = readFileSync(path.join(dir, file), "utf8");
      if (APPROVED.test(sql)) continue;
      for (const pattern of DESTRUCTIVE) {
        const hit = pattern.exec(sql);
        if (hit) offenders.push(`${file}: ${hit[0]}`);
      }
    }
    assert.deepEqual(
      offenders,
      [],
      "a routine migration runs while the previous release is still serving. " +
        "If this contraction is deliberate, ship it in a release after the one " +
        "that stopped reading the column, and mark the file `-- contract: approved <reason>`.",
    );
  });
});
