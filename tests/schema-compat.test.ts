/**
 * A migration runs while the PREVIOUS release is still serving.
 *
 * `deploy.sh` migrates at step 10 and switches the runtime at step 14, so for
 * the minutes in between, the old code is reading the new schema. A routine
 * migration therefore has to be backward-compatible, and this is where that is
 * checked rather than assumed.
 *
 * Two checks, and they cover different things. The first runs the previous
 * release's own table definitions — the commit named in `deploy/previous-release`,
 * not the historical `LEGACY_REF` fixture — against the migrated schema. It reads
 * every table, which catches a dropped, renamed or retyped column; and it then
 * writes, which catches the other half. The old runtime keeps saving during
 * those minutes, with a column list that omits everything added since, so a new
 * NOT NULL column whose default does not cover an old INSERT breaks production
 * in a way no SELECT would reveal. The second check reads the migration SQL and
 * refuses destructive DDL outright unless somebody marked it as a deliberate
 * contraction.
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

import { LEGACY_REF, REPO_ROOT, compatRef, dbUrl, scriptEnv } from "./helpers/env";
import { compatTree, giveFresh, resolveCommit } from "./helpers/fixtures";
import { dropDatabase } from "./helpers/pg";

const created: string[] = [];
after(() => {
  for (const name of created) dropDatabase(name);
});

describe("the release in production can still read the migrated schema", () => {
  test("the compatibility reference names a real, earlier commit", () => {
    const ref = compatRef();
    const resolved = spawnSync("git", ["rev-parse", `${ref}^{commit}`], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    });
    assert.equal(resolved.status, 0, `deploy/previous-release names no commit: ${ref}`);
    const sha = resolved.stdout.trim();

    const head = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" })
      .stdout.trim();
    assert.notEqual(sha, head, "the previous release cannot be the candidate release");

    const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", sha, "HEAD"], {
      cwd: REPO_ROOT,
    });
    assert.equal(ancestor.status, 0, `${sha} is not an ancestor of HEAD — is it really deployed?`);
  });

  test("every table that release defines is still readable, and still writable", () => {
    // The schema and data THIS release produces: migrate then seed, which is
    // deploy steps 10 and 11. The probe below is the old runtime at step 12,
    // reading it before the switch at step 14.
    const database = giveFresh("compat");
    created.push(database);
    const tree = compatTree();

    // Written into the previous release's checkout and run there, so it uses
    // that release's own table definitions and its own drizzle. A column it
    // names that the new schema dropped, renamed or retyped fails here exactly
    // as it would fail in production between migrate and switch.
    const probe = path.join(tree, "compat-probe.mts");
    writeFileSync(
      probe,
      [
        'import { eq } from "drizzle-orm";',
        'import { drizzle } from "drizzle-orm/postgres-js";',
        'import postgres from "postgres";',
        'import * as schema from "./src/lib/db/schema";',
        "",
        "const sql = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });",
        "const db = drizzle(sql);",
        "const failures: string[] = [];",
        "let checked = 0;",
        "for (const [name, table] of Object.entries(schema)) {",
        '  if (!table || typeof table !== "object") continue;',
        '  if (!Object.getOwnPropertySymbols(table).some((s) => String(s).includes("drizzle:Name"))) continue;',
        "  checked += 1;",
        "  try {",
        "    // eslint-disable-next-line @typescript-eslint/no-explicit-any",
        "    await db.select().from(table as any).limit(1);",
        "  } catch (error) {",
        "    failures.push(`${name}: ${(error as Error).message}`);",
        "  }",
        "}",
        "",
        "// Reading is not the whole job. Between migrate and switch the old",
        "// runtime is also SAVING: it inserts section rows and updates drafts",
        "// with its own column list, which omits every column added since. A",
        "// NOT NULL column without a usable default would fail here and only",
        "// here — a SELECT would not have noticed.",
        "try {",
        "  const [page] = await db.select().from(schema.pages).limit(1);",
        "  if (!page) throw new Error(\"the fixture has no pages\");",
        "  const existing = await db.select().from(schema.pageSections).limit(1);",
        "  if (!existing.length) throw new Error(\"the fixture has no sections\");",
        "",
        "  // Insert, naming only the columns this release knows about.",
        "  const [inserted] = await db",
        "    .insert(schema.pageSections)",
        "    .values({",
        "      pageId: page.id,",
        "      blockType: \"rich-text\",",
        "      position: 9999,",
        "      isPublished: false,",
        "      published: { title: { en: \"compat\", ar: \"\" } },",
        "    })",
        "    .returning({ id: schema.pageSections.id });",
        "",
        "  // Save a draft, then publish it, the way the admin does.",
        "  await db",
        "    .update(schema.pageSections)",
        "    .set({ draft: { title: { en: \"draft\", ar: \"\" } }, updatedAt: new Date() })",
        "    .where(eq(schema.pageSections.id, inserted!.id));",
        "  await db",
        "    .update(schema.pageSections)",
        "    .set({",
        "      published: { title: { en: \"published\", ar: \"\" } },",
        "      draft: null,",
        "      isPublished: true,",
        "      updatedAt: new Date(),",
        "    })",
        "    .where(eq(schema.pageSections.id, inserted!.id));",
        "",
        "  await db.delete(schema.pageSections).where(eq(schema.pageSections.id, inserted!.id));",
        "} catch (error) {",
        "  failures.push(`writes: ${(error as Error).message}`);",
        "}",
        "await sql.end();",
        'if (failures.length) { console.error("INCOMPATIBLE\\n" + failures.join("\\n")); process.exit(1); }',
        'console.log(`COMPATIBLE ${checked} tables, reads and writes`);',
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
    assert.equal(
      result.status,
      0,
      `the release at ${compatRef()} cannot read the schema this one produces:\n${output}`,
    );
    assert.match(output, /COMPATIBLE \d+ tables, reads and writes/);
    console.log(`  ${/COMPATIBLE.*/.exec(output)?.[0]} @ ${compatRef().slice(0, 7)}`);
    // A probe that checked nothing would pass silently.
    const checked = Number(/COMPATIBLE (\d+) tables/.exec(output)?.[1] ?? "0");
    assert.ok(checked >= 10, `only ${checked} tables were probed — the probe found no schema`);
  });
});

describe("the compatibility worktree is the release it claims to be", () => {
  const headOf = (dir: string) =>
    spawnSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).stdout.trim();

  test("its HEAD is the resolved compatibility ref, not merely a tree that exists", () => {
    const wanted = resolveCommit(compatRef());
    assert.equal(headOf(compatTree()), wanted, "the probe would otherwise run the wrong release");
  });

  test("a tree built for one ref is replaced when the ref changes", () => {
    // The defect this guards: `deploy/previous-release` changes every release,
    // and the old helper returned any directory containing a package.json. The
    // probe then ran the previous-previous release's definitions and passed.
    //
    // Two real commits from this repository's own history, no production
    // anywhere near it.
    const first = resolveCommit(compatRef());
    const second = resolveCommit(LEGACY_REF);
    assert.notEqual(first, second, "the two refs must differ for this to prove anything");

    const original = process.env.COMPAT_REF;
    try {
      assert.equal(headOf(compatTree()), first);

      process.env.COMPAT_REF = LEGACY_REF;
      assert.equal(
        headOf(compatTree()),
        second,
        "the worktree should have been rebuilt at the new ref, not reused",
      );

      // And back, so the rest of the run sees the tree it expects.
      delete process.env.COMPAT_REF;
      assert.equal(headOf(compatTree()), first, "and rebuilt again when the ref changes back");
    } finally {
      if (original === undefined) delete process.env.COMPAT_REF;
      else process.env.COMPAT_REF = original;
    }
  });

  test("git's own worktree list agrees, with no stale entries", () => {
    const listed = spawnSync("git", ["worktree", "list", "--porcelain"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).stdout;
    const tree = compatTree();
    const entry = listed
      .split("\n\n")
      .find((block) => block.split("\n")[0] === `worktree ${tree}`);
    assert.ok(entry, `git does not know about ${tree} — its metadata is inconsistent`);
    assert.ok(
      entry.includes(`HEAD ${resolveCommit(compatRef())}`),
      "git and the working tree disagree about which commit is checked out",
    );
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
