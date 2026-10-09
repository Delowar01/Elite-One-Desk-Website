/**
 * A migration runs while the PREVIOUS release is still serving.
 *
 * `deploy.sh` migrates and seeds at step 10 and only stops the service and
 * switches the runtime at steps 12–13, so for the minutes in between, the old
 * code is reading and writing the new schema — and a runtime rollback puts it
 * back on that schema for good, because a rollback never reverses a migration.
 * A routine migration therefore has to be backward-compatible, and this is
 * where that is checked rather than assumed.
 *
 * Two checks, and they cover different things. The first runs the previous
 * release's own table definitions — the commit named in `deploy/previous-release`,
 * not the historical `LEGACY_REF` fixture — against the migrated schema. It reads
 * every table that release defines, which catches a dropped, renamed or retyped
 * column; and it then writes the way that release writes, which catches the other
 * half. The old runtime keeps saving during those minutes, with column lists that
 * omit everything added since, so a new NOT NULL column whose default does not
 * cover an old INSERT breaks production in a way no SELECT would reveal. It runs
 * on this release's fresh install, and again on a database that release built
 * with its own migrate and seed and this release then upgraded, as a deploy
 * upgrades production — followed by that release's own scripts again, as a
 * rollback deploy would run them. The second check reads the migration SQL and
 * refuses destructive DDL outright unless somebody marked it as a deliberate
 * contraction.
 *
 * Neither proves semantic compatibility: a column that still exists but now
 * means something different, a default that changes behaviour, a backfill the
 * old code mishandles. That remains policy — DEPLOYMENT.md §9.2 — and review.
 * Nor does the probe run that release's own query code or its exact dependency
 * versions: it runs that release's schema module on this checkout's
 * `node_modules` (see `compatTree`).
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";

import { LEGACY_REF, REPO_ROOT, compatRef, dbUrl, scriptEnv, uniqueName } from "./helpers/env";
import { WORK, compatTree, giveFresh, removeWorktree, resolveCommit, worktreeAt } from "./helpers/fixtures";
import { connect, dropDatabase, recreateDatabase } from "./helpers/pg";
import { migrate, runScript, seed } from "./helpers/run";

/**
 * The runtime production served before Batch 20, which deployed `902a0e6` and
 * kept this one's runtime on the server as its rollback copy. It is a
 * historical fallback, no longer the previous release, and it is proved here as
 * well as — never instead of — the release `deploy/previous-release` names.
 */
const HISTORICAL_RUNTIME = "b807663610982d32d84301852fff77fd7f36f9e8";

const created: string[] = [];
/** Shipped artwork a previous release's seed writes; never into the directory other test files serve from. */
const UPLOADS = path.join(WORK, `compat-uploads-${process.pid}`);
after(() => {
  for (const name of created) dropDatabase(name);
  rmSync(UPLOADS, { recursive: true, force: true });
});

/** The tables a commit's own schema module defines, read from git — independently of the probe that reads them. */
function tablesAt(ref: string): string[] {
  const shown = spawnSync("git", ["show", `${resolveCommit(ref)}:src/lib/db/schema.ts`], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(shown.status, 0, `${ref} has no src/lib/db/schema.ts: ${shown.stderr}`);
  return [...shown.stdout.matchAll(/pgTable\(\s*"([^"]+)"/g)].map((match) => match[1]!).sort();
}

/** The migrations a commit's own journal lists, in order. */
function journalAt(ref: string | null): string[] {
  const text = ref
    ? spawnSync("git", ["show", `${resolveCommit(ref)}:drizzle/meta/_journal.json`], { cwd: REPO_ROOT, encoding: "utf8" }).stdout
    : readFileSync(path.join(REPO_ROOT, "drizzle", "meta", "_journal.json"), "utf8");
  return (JSON.parse(text) as { entries: { tag: string }[] }).entries.map((entry) => entry.tag);
}

/** What the probe must have written for a release with these tables — every write that release makes on a table a migration since then touched or could touch. */
function expectedWrites(tables: string[]): string[] {
  const writes = [
    "page_sections",
    "service_categories",
    "seo_metadata, its own column list",
    "seo_metadata, as its SEO screen saves",
  ];
  if (tables.includes("page_versions")) writes.push("page_sections + pages, revision-guarded", "page_versions");
  if (tables.includes("reusable_components")) writes.push("reusable_components + versions");
  return writes.sort();
}

/**
 * The probe the previous release runs from its own checkout: its own schema
 * module and its own column lists — nothing of this release. It reads every
 * table that module defines and prints their SQL names, then writes the way
 * that release writes, one named group at a time, and prints the groups that
 * landed. Written into the release's tree and run there with `tsx`.
 */
const PROBE = [
  'import { and, eq, sql as raw } from "drizzle-orm";',
  'import { drizzle } from "drizzle-orm/postgres-js";',
  'import postgres from "postgres";',
  'import * as schema from "./src/lib/db/schema";',
  "",
  "// eslint-disable-next-line @typescript-eslint/no-explicit-any",
  "const s = schema as Record<string, any>;",
  "const client = postgres(process.env.DATABASE_URL!, { max: 1, onnotice: () => {} });",
  "const db = drizzle(client);",
  "const failures: string[] = [];",
  "const probed: string[] = [];",
  "const wrote: string[] = [];",
  'const expected = JSON.parse(process.env.COMPAT_EXPECT_SEO || "[]") as Array<{ type: string; key: string; titleEn: string; entityId: number }>;',
  "async function group(name: string, body: () => Promise<void>) {",
  "  try { await body(); wrote.push(name); } catch (error) { failures.push(name + \": \" + (error as Error).message); }",
  "}",
  "const has = (table: string, ...columns: string[]) => Boolean(s[table]) && columns.every((column) => Boolean(s[table][column]));",
  "",
  "// Reads: every table its schema defines, naming every column it defines.",
  "for (const [name, table] of Object.entries(s)) {",
  '  if (!table || typeof table !== "object") continue;',
  '  const symbol = Object.getOwnPropertySymbols(table).find((sym) => String(sym).includes("drizzle:Name"));',
  "  if (!symbol) continue;",
  "  probed.push(String(table[symbol]));",
  "  try { await db.select().from(table).limit(1); } catch (error) { failures.push(name + \": \" + (error as Error).message); }",
  "}",
  "",
  "const [page] = await db.select().from(s.pages).limit(1);",
  'if (!page) failures.push("the database has no pages");',
  "const [anySection] = await db.select().from(s.pageSections).limit(1);",
  'if (!anySection) failures.push("the database has no sections");',
  "",
  "// Its admin's section writes, naming only the columns its schema knows: insert,",
  "// save a draft, publish it, remove it.",
  'await group("page_sections", async () => {',
  '  const [row] = await db.insert(s.pageSections).values({ pageId: page.id, blockType: "rich-text", position: 9999, isPublished: false, published: { title: { en: "compat", ar: "" } } }).returning({ id: s.pageSections.id });',
  '  await db.update(s.pageSections).set({ draft: { title: { en: "draft", ar: "" } }, updatedAt: new Date() }).where(eq(s.pageSections.id, row.id));',
  '  await db.update(s.pageSections).set({ published: { title: { en: "published", ar: "" } }, draft: null, isPublished: true, updatedAt: new Date() }).where(eq(s.pageSections.id, row.id));',
  "  await db.delete(s.pageSections).where(eq(s.pageSections.id, row.id));",
  "});",
  "",
  "// Its Visual Editor adding a section: a draft-only row and the page structure",
  "// that lists it, in one transaction, each write guarded by its revision — and a",
  "// stale write refused.",
  'if (has("pageSections", "isDraftOnly", "revision") && has("pages", "draftStructure", "revision")) {',
  '  await group("page_sections + pages, revision-guarded", async () => {',
  "    await db.transaction(async (tx) => {",
  '      const [row] = await tx.insert(s.pageSections).values({ pageId: page.id, blockType: "rich-text", position: 9998, isPublished: false, isDraftOnly: true, published: { title: { en: "compat", ar: "" } }, draft: { title: { en: "compat", ar: "" } } }).returning({ id: s.pageSections.id, revision: s.pageSections.revision });',
  "      const [current] = await tx.select({ revision: s.pages.revision }).from(s.pages).where(eq(s.pages.id, page.id));",
  "      const moved = await tx.update(s.pages).set({ draftStructure: { version: 1, sections: [{ sectionId: row.id, visible: true }] }, revision: raw`${s.pages.revision} + 1`, updatedAt: new Date() }).where(and(eq(s.pages.id, page.id), eq(s.pages.revision, current.revision))).returning({ revision: s.pages.revision });",
  '      if (moved.length !== 1 || moved[0].revision !== current.revision + 1) throw new Error("the guarded page write did not land");',
  '      const saved = await tx.update(s.pageSections).set({ draft: { title: { en: "edited", ar: "" } }, revision: raw`${s.pageSections.revision} + 1`, updatedAt: new Date() }).where(and(eq(s.pageSections.id, row.id), eq(s.pageSections.revision, row.revision))).returning({ revision: s.pageSections.revision });',
  '      if (saved.length !== 1) throw new Error("the guarded section write did not land");',
  "      const stale = await tx.update(s.pageSections).set({ draft: null, revision: raw`${s.pageSections.revision} + 1` }).where(and(eq(s.pageSections.id, row.id), eq(s.pageSections.revision, row.revision))).returning({ id: s.pageSections.id });",
  '      if (stale.length !== 0) throw new Error("a stale guarded write landed");',
  "      await tx.delete(s.pageSections).where(eq(s.pageSections.id, row.id));",
  "      await tx.update(s.pages).set({ draftStructure: null }).where(eq(s.pages.id, page.id));",
  "    });",
  "  });",
  "}",
  "",
  "// Its page history: a restore point written, read back and removed.",
  'if (has("pageVersions", "snapshot")) {',
  '  await group("page_versions", async () => {',
  '    const [row] = await db.insert(s.pageVersions).values({ pageId: page.id, label: "compat", snapshot: { compat: true }, actorName: "Compatibility probe" }).returning({ id: s.pageVersions.id });',
  "    const [read] = await db.select().from(s.pageVersions).where(eq(s.pageVersions.id, row.id));",
  '    if (!read || read.label !== "compat") throw new Error("the restore point did not read back");',
  "    await db.delete(s.pageVersions).where(eq(s.pageVersions.id, row.id));",
  "  });",
  "}",
  "",
  "// Its reusable components: a published component with a version, a guarded",
  "// draft save, and a delete that takes its versions with it.",
  'if (has("reusableComponents", "revision") && has("reusableComponentVersions", "values")) {',
  '  await group("reusable_components + versions", async () => {',
  '    const values = { label: { en: "compat", ar: "" } };',
  '    const [component] = await db.insert(s.reusableComponents).values({ kind: "cta", name: "Compatibility probe", published: values, draft: null, publishedVersion: 1, publishedAt: new Date() }).returning();',
  '    await db.insert(s.reusableComponentVersions).values({ componentId: component.id, version: 1, values, label: "Before publishing", actorName: "Compatibility probe" });',
  "    const moved = await db.update(s.reusableComponents).set({ draft: values, revision: raw`${s.reusableComponents.revision} + 1`, updatedAt: new Date() }).where(and(eq(s.reusableComponents.id, component.id), eq(s.reusableComponents.revision, component.revision))).returning({ revision: s.reusableComponents.revision });",
  '    if (moved.length !== 1) throw new Error("the guarded component write did not land");',
  "    await db.delete(s.reusableComponents).where(eq(s.reusableComponents.id, component.id));",
  "    const left = await db.select().from(s.reusableComponentVersions).where(eq(s.reusableComponentVersions.componentId, component.id));",
  '    if (left.length) throw new Error("its versions outlived it");',
  "  });",
  "}",
  "",
  "// Its category screen: an insert with its own column list — none of the",
  "// columns added since, `cta_href` (0006, NOT NULL) among them — an update, the",
  "// sort-order swap, a delete.",
  'if (has("serviceCategories", "slug")) {',
  '  await group("service_categories", async () => {',
  '    const values = { titleEn: "Compatibility probe", titleAr: "", taglineEn: "", taglineAr: "", summaryEn: "", summaryAr: "", bodyEn: "", bodyAr: "", ctaLabelEn: "", ctaLabelAr: "", icon: "desk", imageId: null, sortOrder: 9999, isPublished: false };',
  '    const [row] = await db.insert(s.serviceCategories).values({ ...values, slug: "compatibility-probe" }).returning({ id: s.serviceCategories.id });',
  '    await db.update(s.serviceCategories).set({ ...values, titleEn: "Compatibility probe, edited", updatedAt: new Date() }).where(eq(s.serviceCategories.id, row.id));',
  "    const [other] = await db.select({ id: s.serviceCategories.id, sortOrder: s.serviceCategories.sortOrder }).from(s.serviceCategories).where(raw`${s.serviceCategories.id} <> ${row.id}`).limit(1);",
  "    if (other) {",
  "      await db.transaction(async (tx) => {",
  "        await tx.update(s.serviceCategories).set({ sortOrder: other.sortOrder }).where(eq(s.serviceCategories.id, row.id));",
  "        await tx.update(s.serviceCategories).set({ sortOrder: 9999 }).where(eq(s.serviceCategories.id, other.id));",
  "      });",
  "      await db.update(s.serviceCategories).set({ sortOrder: other.sortOrder }).where(eq(s.serviceCategories.id, other.id));",
  "    }",
  '    const columns = await client`select column_name from information_schema.columns where table_name = ${"service_categories"} and column_name = ${"cta_href"}`;',
  "    if (columns.length) {",
  "      const [stored] = await client`select cta_href from service_categories where id = ${row.id}`;",
  '      if (stored.cta_href !== "") throw new Error("cta_href is " + JSON.stringify(stored.cta_href) + ", not the empty default");',
  "    }",
  "    await db.delete(s.serviceCategories).where(eq(s.serviceCategories.id, row.id));",
  "  });",
  "}",
  "",
  "// An upsert on (entity_type, entity_key) with a narrow column list — none of",
  "// the columns 0007 adds — and a delete by the same pair. The upsert needs a",
  "// unique index on exactly that pair; a migration that dropped or widened it",
  "// would fail here, not in a SELECT.",
  'await group("seo_metadata, its own column list", async () => {',
  '  const where = and(eq(s.seoMetadata.entityType, "destination"), eq(s.seoMetadata.entityKey, "compat-probe"));',
  '  for (const titleEn of ["compat", "compat again"]) {',
  '    await db.insert(s.seoMetadata).values({ entityType: "destination", entityKey: "compat-probe", titleEn, noindex: false }).onConflictDoUpdate({ target: [s.seoMetadata.entityType, s.seoMetadata.entityKey], set: { titleEn, updatedAt: new Date() } });',
  "  }",
  "  const written = await db.select().from(s.seoMetadata).where(where);",
  '  if (written.length !== 1 || written[0].titleEn !== "compat again") throw new Error("the upsert left " + written.length + " row(s)");',
  "  await db.delete(s.seoMetadata).where(where);",
  "});",
  "",
  "// Its SEO screen as it saves: the whole row (eleven columns, none of 0007's),",
  "// on one of its own types at a real record's address, upserted twice, then",
  "// cleared — and the clear removes exactly that row.",
  'if (has("seoMetadata", "ogImageId", "canonicalUrl")) {',
  '  await group("seo_metadata, as its SEO screen saves", async () => {',
  '    const [target] = await client`select p.slug from pages p where not exists (select 1 from seo_metadata m where m.entity_type = ${"page"} and m.entity_key = p.slug) order by p.id limit 1`;',
  '    if (!target) throw new Error("no page without an override to save one for");',
  "    const [image] = await client`select id from media order by id limit 1`;",
  "    const imageId = image ? image.id : null;",
  '    const where = and(eq(s.seoMetadata.entityType, "page"), eq(s.seoMetadata.entityKey, target.slug));',
  '    for (const titleEn of ["Compatibility probe", "Compatibility probe, saved again"]) {',
  '      const values = { entityType: "page", entityKey: target.slug, titleEn, titleAr: "", descriptionEn: "Saved the way its screen saves", descriptionAr: "", canonicalUrl: "", ogTitle: "Share title", ogDescription: "Share words", ogImageId: imageId, noindex: false };',
  "      await db.insert(s.seoMetadata).values(values).onConflictDoUpdate({ target: [s.seoMetadata.entityType, s.seoMetadata.entityKey], set: { ...values, updatedAt: new Date() } });",
  "    }",
  "    const rows = await db.select().from(s.seoMetadata).where(where);",
  '    if (rows.length !== 1 || rows[0].titleEn !== "Compatibility probe, saved again" || rows[0].ogImageId !== imageId) throw new Error("the upsert left " + rows.length + " row(s)");',
  "    const removed = await db.delete(s.seoMetadata).where(where).returning({ id: s.seoMetadata.id });",
  '    if (removed.length !== 1) throw new Error("its clear removed " + removed.length + " row(s)");',
  "  });",
  "}",
  "",
  "// After a deploy has reconciled the table: every override it wrote is still",
  "// found where it looks — by type and address — with its words, and its save on",
  "// a row this release has bound to its record leaves the binding alone.",
  "if (expected.length) {",
  '  await group("seo_metadata, read and saved by address after the reconcile", async () => {',
  '    const byAddress = new Map((await db.select().from(s.seoMetadata)).map((row: { entityType: string; entityKey: string }) => [row.entityType + ":" + row.entityKey, row]));',
  "    for (const row of expected) {",
  '      const found = byAddress.get(row.type + ":" + row.key) as { titleEn: string } | undefined;',
  '      if (!found) throw new Error(row.type + ":" + row.key + " is no longer where it looks for it");',
  '      if (found.titleEn !== row.titleEn) throw new Error(row.type + ":" + row.key + " lost its words");',
  "    }",
  "    const first = expected[0];",
  '    const values = { entityType: first.type, entityKey: first.key, titleEn: first.titleEn + ", saved by its screen", titleAr: "", descriptionEn: "", descriptionAr: "", canonicalUrl: "", ogTitle: "", ogDescription: "", ogImageId: null, noindex: false };',
  "    await db.insert(s.seoMetadata).values(values).onConflictDoUpdate({ target: [s.seoMetadata.entityType, s.seoMetadata.entityKey], set: { ...values, updatedAt: new Date() } });",
  "    const [bound] = await client`select entity_id, title_en from seo_metadata where entity_type = ${first.type} and entity_key = ${first.key}`;",
  '    if (bound.entity_id !== first.entityId) throw new Error("its save moved the binding: entity_id is " + bound.entity_id);',
  '    if (bound.title_en !== values.titleEn) throw new Error("its save did not land");',
  "  });",
  "}",
  "",
  "await client.end();",
  'console.log("PROBED " + JSON.stringify([...probed].sort()));',
  'console.log("WROTE " + JSON.stringify([...wrote].sort()));',
  'if (failures.length) { console.error("INCOMPATIBLE\\n" + failures.join("\\n")); process.exit(1); }',
  'console.log("COMPATIBLE " + probed.length + " tables, reads and writes");',
].join("\n");

type Probe = { status: number | null; output: string; probed: string[]; wrote: string[] };

/** Runs the probe in `tree` against `database`; `expectSeo` names overrides the release wrote before the deploy. */
function runProbe(
  tree: string,
  database: string,
  expectSeo: Array<{ type: string; key: string; titleEn: string; entityId: number }> = [],
): Probe {
  writeFileSync(path.join(tree, "compat-probe.mts"), PROBE, "utf8");
  const result = spawnSync("npx", ["tsx", "compat-probe.mts"], {
    cwd: tree,
    encoding: "utf8",
    env: scriptEnv(dbUrl(database), { COMPAT_EXPECT_SEO: JSON.stringify(expectSeo) }),
    maxBuffer: 16 * 1024 * 1024,
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const list = (label: string) => JSON.parse(new RegExp(`^${label} (\\[.*\\])$`, "m").exec(output)?.[1] ?? "[]") as string[];
  return { status: result.status, output, probed: list("PROBED"), wrote: list("WROTE") };
}

/** The release's own `tsx` script, from its own checkout, against `database`. */
function ownScript(tree: string, script: string, database: string): void {
  const result = spawnSync("npx", ["tsx", script], {
    cwd: tree,
    encoding: "utf8",
    env: scriptEnv(dbUrl(database), { UPLOAD_DIR: UPLOADS }),
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `its own ${script} failed: ${result.stderr || result.stdout}`);
}

/** Every probe must have read exactly the tables that release defines, and written the way it writes. */
function assertProbe(probe: Probe, ref: string, extraWrites: string[] = []): void {
  assert.equal(probe.status, 0, `the release at ${ref.slice(0, 7)} cannot read or write the schema this one produces:\n${probe.output}`);
  assert.match(probe.output, /^COMPATIBLE \d+ tables, reads and writes$/m);
  // Not a floor: every table its own schema module defines, by name — so a
  // table it reads that the probe skipped, or a probe that found no schema,
  // fails here.
  assert.deepEqual(probe.probed, tablesAt(ref), "the probe did not read exactly the tables that release defines");
  for (const write of [...expectedWrites(tablesAt(ref)), ...extraWrites]) {
    assert.ok(probe.wrote.includes(write), `the probe never wrote "${write}":\n${probe.output}`);
  }
}

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

  test("every table that release defines is still readable, and still writable, on this release's fresh install", async () => {
    // The schema and data THIS release produces: its migrate, then its seed.
    const database = giveFresh("compat");
    created.push(database);
    // The fixture is a dump reused while it exists: one made before the last
    // migration was added would be probed in place of the schema that ships.
    const sql = connect(database);
    try {
      const [{ applied }] = await sql<{ applied: number }[]>`select count(*)::int as applied from drizzle.__drizzle_migrations`;
      assert.equal(applied, journalAt(null).length, "the fresh fixture predates this release's migrations — rebuild it (REBUILD_FIXTURES=1)");
    } finally {
      await sql.end({ timeout: 5 });
    }

    const probe = runProbe(compatTree(), database);
    assertProbe(probe, compatRef());
    console.log(`  ${/COMPATIBLE.*/.exec(probe.output)?.[0]} @ ${compatRef().slice(0, 7)} (fresh install)`);
  });

  test("the deploy path: its own database, upgraded by this release, read and written by it — then its own scripts again, as a rollback deploy runs them", async () => {
    const ref = compatRef();
    const tree = compatTree();

    // The premise: production's database was built by that release's own
    // migration files, and this release's are those same files plus its own.
    const theirs = journalAt(ref);
    const ours = journalAt(null);
    assert.deepEqual(ours.slice(0, theirs.length), theirs, "this release does not carry that release's migrations as they were");
    for (const tag of theirs) {
      const same = spawnSync("git", ["diff", "--quiet", resolveCommit(ref), "HEAD", "--", `drizzle/${tag}.sql`], { cwd: REPO_ROOT });
      assert.equal(same.status, 0, `drizzle/${tag}.sql changed since ${ref.slice(0, 7)} — production was built by the old one`);
    }

    // Production's shape: that release's own migrate and seed, from its own checkout.
    mkdirSync(UPLOADS, { recursive: true });
    const database = uniqueName("compat_deploy");
    recreateDatabase(database);
    created.push(database);
    for (const script of ["scripts/migrate.ts", "scripts/seed.ts"]) ownScript(tree, script, database);

    const sql = connect(database);
    try {
      const applied = async () =>
        (await sql<{ n: number }[]>`select count(*)::int as n from drizzle.__drizzle_migrations`)[0]!.n;
      assert.equal(await applied(), theirs.length, `that release is migrations ${theirs[0]}…${theirs.at(-1)}`);

      // Its SEO overrides as its screen saves them: by type and address, its
      // columns only, on records of each of its own types.
      const one = async <T,>(query: Promise<T[]>) => {
        const [row] = await query;
        assert.ok(row, "the seeded database lacks a record the probe needs");
        return row;
      };
      const image = await one(sql<{ id: number }[]>`select id from media order by id limit 1`);
      const page = await one(sql<{ id: number; slug: string }[]>`select id, slug from pages where slug = 'about'`);
      const category = await one(sql<{ id: number; slug: string }[]>`select id, slug from service_categories where is_published order by id limit 1`);
      const service = await one(sql<{ id: number; address: string }[]>`
        select s.id, c.slug || '/' || s.slug as address from services s join service_categories c on c.id = s.category_id
         where s.is_published and c.is_published order by s.id limit 1`);
      const tour = await one(sql<{ id: number; slug: string }[]>`select id, slug from travel_packages order by id limit 1`);
      const overrides = [
        { type: "page", key: page.slug, titleEn: "About, as its SEO screen saved it", entityId: page.id },
        { type: "category", key: category.slug, titleEn: "A category, as its SEO screen saved it", entityId: category.id },
        { type: "service", key: service.address, titleEn: "A service, as its SEO screen saved it", entityId: service.id },
        { type: "package", key: tour.slug, titleEn: "A package, as its SEO screen saved it", entityId: tour.id },
      ];
      for (const row of overrides) {
        await sql`
          insert into seo_metadata (entity_type, entity_key, title_en, description_en, og_image_id, noindex)
          values (${row.type}, ${row.key}, ${row.titleEn}, ${`Words for ${row.key}`}, ${image.id}, false)`;
      }

      // The deploy, steps 10–11: this release's migrate (its migrations, the
      // row-id backfill, the first SEO reconcile), its seed and its permission check.
      const migrated = migrate(database);
      assert.equal(migrated.code, 0, migrated.output.slice(-3000));
      assert.match(migrated.output, /SEO records:/);
      const seeded = seed(database);
      assert.equal(seeded.code, 0, seeded.output.slice(-3000));
      const checked = runScript("scripts/check-permissions.ts", database);
      assert.equal(checked.code, 0, checked.output.slice(-3000));
      assert.equal(await applied(), ours.length, `the upgraded database is migrations ${ours[0]}…${ours.at(-1)}`);
      for (const row of overrides) {
        const [now] = await sql<{ entity_key: string; entity_id: number | null; title_en: string; og_image_id: number | null }[]>`
          select entity_key, entity_id, title_en, og_image_id from seo_metadata where entity_type = ${row.type} and entity_key = ${row.key}`;
        assert.ok(now, `${row.type}:${row.key} is no longer at its address after the reconcile`);
        assert.equal(now.entity_id, row.entityId, `${row.type}:${row.key} was not bound to its record`);
        assert.equal(now.title_en, row.titleEn);
        assert.equal(now.og_image_id, image.id, `${row.type}:${row.key} lost its share image`);
      }

      // The old runtime between migrate and switch, and after a runtime rollback.
      const during = runProbe(tree, database, overrides);
      assertProbe(during, ref, ["seo_metadata, read and saved by address after the reconcile"]);
      console.log(`  ${/COMPATIBLE.*/.exec(during.output)?.[0]} @ ${ref.slice(0, 7)} (its own database, upgraded)`);

      // A rollback deploy: its own migrate (nothing left to apply), seed and
      // permission check, against the upgraded database; then its probe again.
      for (const script of ["scripts/migrate.ts", "scripts/seed.ts"]) ownScript(tree, script, database);
      if (existsSync(path.join(tree, "scripts", "check-permissions.ts"))) ownScript(tree, "scripts/check-permissions.ts", database);
      assert.equal(await applied(), ours.length, "its own migrate applied or removed a migration on the upgraded database");
      const rolledBack = runProbe(tree, database);
      assertProbe(rolledBack, ref);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  test("and the runtime before it, kept on the server as a historical rollback, still reads and writes it too", () => {
    // Not the gate — `deploy/previous-release` is. A second proof, for the
    // older runtime Batch 20 left on the server.
    const dir = path.join(WORK, `compat-historical-${process.pid}`);
    try {
      const tree = worktreeAt(HISTORICAL_RUNTIME, dir);
      const database = giveFresh("compat_historical");
      created.push(database);
      const probe = runProbe(tree, database);
      assertProbe(probe, HISTORICAL_RUNTIME);
      console.log(`  ${/COMPATIBLE.*/.exec(probe.output)?.[0]} @ ${HISTORICAL_RUNTIME.slice(0, 7)} (historical rollback)`);
    } finally {
      removeWorktree(dir);
    }
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
    //
    // On a tree of its own (Batch 19A). The shared compatibility tree is in use
    // by other test files at the same moment — they run the previous release's
    // own migrate and seed from it — and swapping it under them made one or
    // the other fail at random ("… compat-tree already exists").
    const first = resolveCommit(compatRef());
    const second = resolveCommit(LEGACY_REF);
    assert.notEqual(first, second, "the two refs must differ for this to prove anything");

    const dir = path.join(WORK, `swap-tree-${process.pid}`);
    const original = process.env.COMPAT_REF;
    try {
      assert.equal(headOf(worktreeAt(compatRef(), dir)), first);

      process.env.COMPAT_REF = LEGACY_REF;
      assert.equal(
        headOf(worktreeAt(compatRef(), dir)),
        second,
        "the worktree should have been rebuilt at the new ref, not reused",
      );

      // Back to the ref the run started with — the documented default, or the
      // one a `COMPAT_REF=<ref>` run named (Batch 21: deleting it here made
      // every such run fail this check against a ref it never asked for).
      if (original === undefined) delete process.env.COMPAT_REF;
      else process.env.COMPAT_REF = original;
      assert.equal(headOf(worktreeAt(compatRef(), dir)), first, "and rebuilt again when the ref changes back");
    } finally {
      if (original === undefined) delete process.env.COMPAT_REF;
      else process.env.COMPAT_REF = original;
      removeWorktree(dir);
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
