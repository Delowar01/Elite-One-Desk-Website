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
      original: { id: number; blockType: string; published: Values; restores: Values }[];
      outcome: { ok: boolean; reason?: string; recreated?: number[]; updated?: number[] };
      pruned: number;
    }>(
      name,
      `
import { asc, eq } from "drizzle-orm";

import { getBlock } from "@/lib/cms/blocks";
import { validateBlockValues } from "@/lib/cms/validate";
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

const outcome = await restoreVersionToDraft(versionId, pageId);

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
  // What the registry makes of each section's published values — the shape a
  // restored draft is expected to arrive in, computed here rather than
  // hard-coded so the test cannot drift from the block definitions.
  original: original.map(({ id, blockType, published }) => ({
    id,
    blockType,
    published,
    restores: validateBlockValues(getBlock(blockType)!, published),
  })),
  outcome: outcome.ok
    ? { ok: true, recreated: outcome.recreated, updated: outcome.updated }
    : { ok: false, reason: outcome.reason },
  pruned: await prunePageVersions(pageId, 1),
});
process.exit(0);
`,
    );

    assert.equal(out.outcome.ok, true, `the restore was refused: ${out.outcome.reason}`);
    assert.equal(out.versions, 2, "both versions should be listed");
    assert.equal(out.pruned, 1, "the history ceiling should drop the older one");

    const first = out.original[0]!;
    const deleted = out.original[1]!;
    const kept = new Map(out.kept.map((row) => [row.id, row]));

    // The vandalised section keeps its vandalism on the published side …
    const vandalised = kept.get(first.id)!;
    assert.deepEqual(vandalised.published, { headline: { en: "VANDALISED", ar: "VANDALISED" } });
    // … and the history arrives beside it, as a draft — rebuilt through the
    // block registry on the way out, which is what keeps a stored snapshot from
    // being a route around the CMS's own validation.
    assert.deepEqual(vandalised.draft, first.restores);
    // Every section the snapshot still matches gets its history as a draft —
    // all of them except the one that was deleted, which is recreated instead.
    assert.deepEqual(
      out.outcome.updated,
      out.original.filter((row) => row.id !== deleted.id).map((row) => row.id),
    );
    assert.equal(vandalised.isPublished, true, "a restore changed a visibility flag");

    // The deleted section is back as a row nobody visiting the site can see.
    assert.equal(out.recreated.length, 1, "the deleted section was not recreated");
    const recreated = out.recreated[0]!;
    const [row] = await sql<{ is_published: boolean; published: Values; draft: Values; block_type: string }[]>`
      select is_published, published, draft, block_type from page_sections where id = ${recreated}
    `;
    assert.equal(row!.is_published, false, "a restore published a section");
    assert.equal(row!.block_type, deleted.blockType);
    assert.deepEqual(row!.draft, deleted.restores, "the history did not come back");
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

/* -------------------------------------------------------------------------- */

describe("a version belongs to one page, and a restore cannot cross to another", () => {
  test("a version of another page is refused by name, and nothing is written", async () => {
    const name = giveFresh("restore_wrong_page");
    const sql = open(name);

    const out = probeValue<{
      wrongPage: { ok: boolean; reason?: string };
      missing: { ok: boolean; reason?: string };
      right: { ok: boolean; reason?: string };
      aboutAfter: { draft: Values; draftStructure: Values; revision: number }[];
    }>(
      name,
      `
import { asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { pageSections, pages } from "@/lib/db/schema";
import { restoreVersionToDraft, savePageVersion } from "@/lib/versions";

const [home] = await db.select().from(pages).where(eq(pages.slug, "home")).limit(1);
const [about] = await db.select().from(pages).where(eq(pages.slug, "about")).limit(1);

// A version of the HOME page, offered to the ABOUT page.
const homeVersion = await savePageVersion({ pageId: home.id, label: "home" });

const wrongPage = await restoreVersionToDraft(homeVersion, about.id);
const missing = await restoreVersionToDraft(2147483000, about.id);

const aboutAfter = await db
  .select({ draft: pageSections.draft, revision: pageSections.revision })
  .from(pageSections)
  .where(eq(pageSections.pageId, about.id))
  .orderBy(asc(pageSections.id));
const [aboutPage] = await db.select().from(pages).where(eq(pages.id, about.id)).limit(1);

// And the same version offered to the page it actually belongs to.
const right = await restoreVersionToDraft(homeVersion, home.id);

emit({
  wrongPage: wrongPage.ok ? { ok: true } : { ok: false, reason: wrongPage.reason },
  missing: missing.ok ? { ok: true } : { ok: false, reason: missing.reason },
  right: right.ok ? { ok: true } : { ok: false, reason: right.reason },
  aboutAfter: aboutAfter.map((row) => ({
    draft: row.draft,
    draftStructure: aboutPage.draftStructure ?? null,
    revision: row.revision,
  })),
});
process.exit(0);
`,
    );

    assert.deepEqual(out.wrongPage, { ok: false, reason: "wrong_page" });
    assert.deepEqual(out.missing, { ok: false, reason: "missing" });
    assert.deepEqual(out.right, { ok: true }, "the page's own version should restore");

    // The refused restore touched nothing on the page it was aimed at.
    assert.ok(out.aboutAfter.length > 0, "the about page has no sections to check");
    for (const row of out.aboutAfter) {
      assert.equal(row.draft, null, "a refused restore wrote a draft");
      assert.equal(row.draftStructure, null, "a refused restore wrote a draft structure");
      assert.equal(row.revision, 0, "a refused restore bumped a revision");
    }

    // Belt and braces, read back outside the probe.
    const [about] = await sql<{ id: number }[]>`select id from pages where slug = 'about'`;
    const rows = await sql<{ n: number }[]>`
      select count(*)::int as n from page_sections where page_id = ${about!.id} and draft is not null
    `;
    assert.equal(rows[0]!.n, 0);
  });

  test("a plan naming a foreign section is refused whole, and writes nothing", async () => {
    const name = giveFresh("restore_foreign_section");
    const sql = open(name);

    /**
     * The plan below is one no planner produces: it names a section of the
     * ABOUT page in a restore of the HOME page, in `drafts` **and** in `order`.
     *
     * `order` is the half that matters and the half that was missed. Scoping
     * each UPDATE by `page_id` already stopped the foreign row being written
     * to — but the page's `draft_structure` is built from `plan.order`, so the
     * foreign id sailed into HOME's structure regardless, and HOME would then
     * have been carrying a pointer to somebody else's section.
     *
     * The answer is fail-closed: one stranger abandons the whole plan before a
     * single statement runs. So this asserts absence everywhere — no draft on
     * either page, no structure, no revision moved, no recreated row.
     */
    const before = await sql<{ n: number }[]>`select count(*)::int as n from page_sections`;

    const out = probeValue<{
      result: { ok: boolean; reason?: string; sectionIds?: number[] };
      missingSection: { ok: boolean; reason?: string; sectionIds?: number[] };
      foreign: { id: number; draft: Values; revision: number };
      own: { id: number; draft: Values; revision: number };
      homePage: { draftStructure: Values; revision: number };
      aboutId: number;
      sections: number;
    }>(
      name,
      `
import { asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { pageSections, pages } from "@/lib/db/schema";
import { applyRestorePlan } from "@/lib/versions";

const [home] = await db.select().from(pages).where(eq(pages.slug, "home")).limit(1);
const [about] = await db.select().from(pages).where(eq(pages.slug, "about")).limit(1);

const pick = (pageId: number) =>
  db
    .select({ id: pageSections.id })
    .from(pageSections)
    .where(eq(pageSections.pageId, pageId))
    .orderBy(asc(pageSections.id))
    .limit(1);

const [homeSection] = await pick(home.id);
const [aboutSection] = await pick(about.id);

const draft = { headline: { en: "SHOULD NOT LAND", ar: "" } };
const styles = { v: 1, nodes: {} };

const result = await applyRestorePlan({
  pageId: home.id,
  drafts: [
    { sectionId: homeSection.id, draft, draftStyles: styles, draftAnimation: "fade-up" },
    { sectionId: aboutSection.id, draft, draftStyles: styles, draftAnimation: "fade-up" },
  ],
  // A recreate entry too, so the test can prove no inserted row survives the
  // abandoned transaction.
  recreate: [
    { blockType: "rich-text", draft, draftStyles: styles, draftAnimation: "fade-up", visible: true },
  ],
  untouched: [],
  order: [
    { kind: "existing", sectionId: homeSection.id, visible: true },
    { kind: "existing", sectionId: aboutSection.id, visible: true },
    { kind: "recreate", index: 0, visible: true },
  ],
});

// A section that has been deleted since the plan was made is the same answer.
const missingSection = await applyRestorePlan({
  pageId: home.id,
  drafts: [{ sectionId: 2147483000, draft, draftStyles: styles, draftAnimation: "fade-up" }],
  recreate: [],
  untouched: [],
  order: [{ kind: "existing", sectionId: 2147483000, visible: true }],
});

const readOne = async (id: number) => {
  const [row] = await db
    .select({ id: pageSections.id, draft: pageSections.draft, revision: pageSections.revision })
    .from(pageSections)
    .where(eq(pageSections.id, id))
    .limit(1);
  return row;
};
const [homePage] = await db
  .select({ draftStructure: pages.draftStructure, revision: pages.revision })
  .from(pages)
  .where(eq(pages.id, home.id))
  .limit(1);
const all = await db.select({ id: pageSections.id }).from(pageSections);

emit({
  result,
  missingSection,
  foreign: await readOne(aboutSection.id),
  own: await readOne(homeSection.id),
  homePage,
  aboutId: aboutSection.id,
  sections: all.length,
});
process.exit(0);
`,
    );

    // Refused by name, and it says which sections were the problem.
    assert.equal(out.result.ok, false, "an invalid plan was applied");
    assert.equal(out.result.reason, "unowned_sections");
    assert.deepEqual(out.result.sectionIds, [out.aboutId]);
    assert.deepEqual(out.missingSection, { ok: false, reason: "unowned_sections", sectionIds: [2147483000] });

    // The foreign section is untouched …
    assert.equal(out.foreign.draft, null, "a plan for one page wrote into another page's section");
    assert.equal(out.foreign.revision, 0, "a foreign section's revision moved");

    // … and so is the plan's *own* section: the rejection is atomic, not partial.
    assert.equal(out.own.draft, null, "a rejected plan was partly applied");
    assert.equal(out.own.revision, 0, "a rejected plan moved a revision");

    // The page structure never saw the foreign id, and the page did not move.
    assert.equal(out.homePage.draftStructure, null, "a rejected plan wrote a draft structure");
    assert.equal(out.homePage.revision, 0, "a rejected plan bumped the page revision");

    // And no recreated row survived the abandoned transaction.
    assert.equal(out.sections, before[0]!.n, "a rejected plan left a section behind");

    const [after] = await sql<{ drafts: number; structures: number }[]>`
      select
        (select count(*)::int from page_sections where draft is not null) as drafts,
        (select count(*)::int from pages where draft_structure is not null) as structures
    `;
    assert.deepEqual(after, { drafts: 0, structures: 0 });
  });
});

/* -------------------------------------------------------------------------- */

describe("a restore makes every open editor stale", () => {
  test("revisions move, the stale autosave conflicts, and the restored draft survives", async () => {
    const name = giveFresh("restore_revisions");
    const sql = open(name);

    const out = probeValue<{
      sectionBefore: number;
      pageBefore: number;
      sectionAfter: number;
      pageAfter: number;
      staleSection: unknown;
      stalePage: unknown;
      freshSection: unknown;
      restoredDraft: Values;
      structureAfterStale: Values;
      restoredUpdatedBy: number | null;
    }>(
      name,
      `
import { asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { updatePageGuarded, updateSectionGuarded } from "@/lib/db/revision";
import { pageSections, pages } from "@/lib/db/schema";
import { restoreVersionToDraft, savePageVersion } from "@/lib/versions";

const [page] = await db.select().from(pages).where(eq(pages.slug, "home")).limit(1);
const [section] = await db
  .select()
  .from(pageSections)
  .where(eq(pageSections.pageId, page.id))
  .orderBy(asc(pageSections.position), asc(pageSections.id))
  .limit(1);

// An editor opens the page and reads these two numbers.
const sectionBefore = section.revision;
const pageBefore = page.revision;

const versionId = await savePageVersion({ pageId: page.id, label: "before a restore" });
const restored = await restoreVersionToDraft(versionId, page.id);
if (!restored.ok) throw new Error("the restore was refused: " + restored.reason);

const after = async () => {
  const [s] = await db.select().from(pageSections).where(eq(pageSections.id, section.id)).limit(1);
  const [p] = await db.select().from(pages).where(eq(pages.id, page.id)).limit(1);
  return { s, p };
};
const { s: sectionRow, p: pageRow } = await after();

// The editor, who has been looking at a screen that is now out of date, sends
// the autosave it was always going to send.
const staleSection = await updateSectionGuarded(section.id, sectionBefore, {
  draft: { headline: { en: "STALE AUTOSAVE", ar: "" } },
});
const stalePage = await updatePageGuarded(page.id, pageBefore, {
  draftStructure: { v: 1, sections: [] },
});

// Reading the new number first is what lets a save through.
const freshSection = await updateSectionGuarded(section.id, sectionRow.revision, {
  draftAnimation: "fade",
});

const { s: finalSection, p: finalPage } = await after();

emit({
  sectionBefore,
  pageBefore,
  sectionAfter: sectionRow.revision,
  pageAfter: pageRow.revision,
  staleSection,
  stalePage,
  freshSection,
  restoredDraft: finalSection.draft,
  structureAfterStale: finalPage.draftStructure,
  restoredUpdatedBy: sectionRow.updatedBy,
});
process.exit(0);
`,
    );

    assert.equal(out.sectionAfter, out.sectionBefore + 1, "a restore did not bump the section revision");
    assert.equal(out.pageAfter, out.pageBefore + 1, "a restore did not bump the page revision");

    assert.deepEqual(out.staleSection, { ok: false, reason: "conflict" }, "a stale autosave was accepted");
    assert.deepEqual(out.stalePage, { ok: false, reason: "conflict" });
    assert.deepEqual(out.freshSection, { ok: true, revision: out.sectionAfter + 1 });

    // The restored draft is still there — the stale save did not overwrite it.
    assert.ok(out.restoredDraft && typeof out.restoredDraft === "object");
    assert.notDeepEqual(
      out.restoredDraft,
      { headline: { en: "STALE AUTOSAVE", ar: "" } },
      "the stale autosave overwrote the restore",
    );
    assert.ok(
      !JSON.stringify(out.restoredDraft).includes("STALE AUTOSAVE"),
      "the stale autosave reached the restored draft",
    );
    // And the page's draft order survived its own stale write.
    assert.ok(
      Array.isArray((out.structureAfterStale as { sections?: unknown[] } | null)?.sections) &&
        ((out.structureAfterStale as { sections: unknown[] }).sections.length > 0),
      "the stale page save emptied the restored draft structure",
    );

    const [row] = await sql<{ revision: number }[]>`
      select s.revision from page_sections s
        join pages p on p.id = s.page_id
       where p.slug = 'home'
       order by s.position, s.id
       limit 1
    `;
    assert.equal(row!.revision, out.sectionAfter + 1);
  });
});

/* -------------------------------------------------------------------------- */

describe("updated_by is attribution, and never the guard", () => {
  test("a guarded write records who; a stale one records nothing", async () => {
    const name = giveFresh("updated_by");
    const sql = open(name);

    const out = probeValue<{
      users: number[];
      first: unknown;
      stale: unknown;
      sameActorAgain: unknown;
      afterFirst: { revision: number; updatedBy: number | null; draft: Values };
      afterStale: { revision: number; updatedBy: number | null; draft: Values };
      afterSame: { revision: number; updatedBy: number | null; draft: Values };
      pageFirst: unknown;
      pageStale: unknown;
      pageAfterStale: { revision: number; updatedBy: number | null };
      restoreUpdatedBy: { section: number | null; page: number | null; recreatedSeen: boolean };
    }>(
      name,
      `
import { asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { updatePageGuarded, updateSectionGuarded } from "@/lib/db/revision";
import { pageSections, pages, users } from "@/lib/db/schema";
import { applyRestorePlan, planRestore, capturePageSnapshot } from "@/lib/versions";

const everyone = await db.select({ id: users.id }).from(users).orderBy(asc(users.id));
const alice = everyone[0].id;

const [page] = await db.select().from(pages).where(eq(pages.slug, "home")).limit(1);
const [section] = await db
  .select()
  .from(pageSections)
  .where(eq(pageSections.pageId, page.id))
  .orderBy(asc(pageSections.position), asc(pageSections.id))
  .limit(1);

const readSection = async () => {
  const [row] = await db
    .select({ revision: pageSections.revision, updatedBy: pageSections.updatedBy, draft: pageSections.draft })
    .from(pageSections)
    .where(eq(pageSections.id, section.id))
    .limit(1);
  return row;
};
const readPage = async () => {
  const [row] = await db
    .select({ revision: pages.revision, updatedBy: pages.updatedBy })
    .from(pages)
    .where(eq(pages.id, page.id))
    .limit(1);
  return row;
};

// 1. A guarded write stores the intended actor and moves the counter.
const first = await updateSectionGuarded(section.id, section.revision, {
  draft: { headline: { en: "FIRST", ar: "" } },
  updatedBy: alice,
});
const afterFirst = await readSection();

// 2. A stale write by anybody changes nothing — not the draft, not the actor.
const stale = await updateSectionGuarded(section.id, section.revision, {
  draft: { headline: { en: "STALE", ar: "" } },
  updatedBy: null,
});
const afterStale = await readSection();

// 3. The SAME actor writing again is still a distinct write, told apart by the
//    counter rather than by who did it — which is why updated_by cannot be the
//    guard.
const sameActorAgain = await updateSectionGuarded(section.id, afterStale.revision, {
  draft: { headline: { en: "SECOND", ar: "" } },
  updatedBy: alice,
});
const afterSame = await readSection();

const pageFirst = await updatePageGuarded(page.id, page.revision, {
  draftStructure: { v: 1, sections: [] },
  updatedBy: alice,
});
const pageStale = await updatePageGuarded(page.id, page.revision, {
  draftStructure: { v: 1, sections: [{ sectionId: section.id, visible: false }] },
  updatedBy: null,
});
const pageAfterStale = await readPage();

// A restore attributes too, on every row it writes.
const snapshot = await capturePageSnapshot(page.id);
await db.delete(pageSections).where(eq(pageSections.id, section.id));
const plan = await planRestore(page.id, snapshot);
const applied = await applyRestorePlan(plan, { userId: alice });
if (!applied.ok) throw new Error("the restore was refused: " + applied.reason);

const [someExisting] = await db
  .select({ updatedBy: pageSections.updatedBy })
  .from(pageSections)
  .where(eq(pageSections.id, plan.drafts[0].sectionId))
  .limit(1);
const [recreatedRow] = applied.recreated.length
  ? await db
      .select({ updatedBy: pageSections.updatedBy })
      .from(pageSections)
      .where(eq(pageSections.id, applied.recreated[0]))
      .limit(1)
  : [undefined];

emit({
  users: everyone.map((row) => row.id),
  first,
  stale,
  sameActorAgain,
  afterFirst,
  afterStale,
  afterSame,
  pageFirst,
  pageStale,
  pageAfterStale,
  restoreUpdatedBy: {
    section: someExisting?.updatedBy ?? null,
    page: (await readPage()).updatedBy,
    recreatedSeen: recreatedRow ? recreatedRow.updatedBy === alice : false,
  },
});
process.exit(0);
`,
    );

    const alice = out.users[0]!;

    // 1 — attribution is stored, and the counter moved.
    assert.deepEqual(out.first, { ok: true, revision: out.afterFirst.revision });
    assert.equal(out.afterFirst.updatedBy, alice);
    assert.deepEqual(out.afterFirst.draft, { headline: { en: "FIRST", ar: "" } });

    // 2 — the stale write changed nothing at all, attribution included.
    assert.deepEqual(out.stale, { ok: false, reason: "conflict" });
    assert.deepEqual(out.afterStale, out.afterFirst, "a rejected write still changed the row");
    assert.equal(out.afterStale.updatedBy, alice, "a rejected write rewrote the attribution");

    // 3 — two writes by one actor are told apart by revision, not by actor.
    assert.deepEqual(out.sameActorAgain, { ok: true, revision: out.afterFirst.revision + 1 });
    assert.equal(out.afterSame.updatedBy, alice, "the same actor, and a different write");
    assert.notEqual(out.afterSame.revision, out.afterFirst.revision);
    assert.deepEqual(out.afterSame.draft, { headline: { en: "SECOND", ar: "" } });

    // The page-level primitive behaves the same way.
    assert.deepEqual(out.pageFirst, { ok: true, revision: out.pageAfterStale.revision });
    assert.deepEqual(out.pageStale, { ok: false, reason: "conflict" });
    assert.equal(out.pageAfterStale.updatedBy, alice);

    // And a restore attributes every row it writes.
    assert.equal(out.restoreUpdatedBy.section, alice, "a restored draft has no author");
    assert.equal(out.restoreUpdatedBy.page, alice, "a restored draft structure has no author");
    assert.equal(out.restoreUpdatedBy.recreatedSeen, true, "a recreated section has no author");

    const [row] = await sql<{ updated_by: number | null }[]>`
      select updated_by from pages where slug = 'home'
    `;
    assert.equal(row!.updated_by, alice);
  });
});

/* -------------------------------------------------------------------------- */

describe("a hidden section and a pending one are not the same thing", () => {
  /**
   * Both sit at `is_published = false`, both can carry a draft, and both can
   * have empty published values — so nothing about the row says which it is
   * except `is_draft_only`. What hangs on getting it right: a snapshot of the
   * published page must keep the hidden section (and keep it hidden), and must
   * not contain a section nobody has published yet; and when Batch 8 discards a
   * structural draft, the hidden one must survive and the pending one may not.
   */
  test("a hidden established section is in the snapshot, hidden; a draft-only one is not", async () => {
    const name = giveFresh("draft_only_snapshot");
    const sql = open(name);

    const out = probeValue<{
      hiddenId: number;
      draftOnlyId: number;
      snapshot: { sourceSectionId: number; visible: boolean; blockType: string }[];
      defaults: { isDraftOnly: boolean };
    }>(
      name,
      `
import { asc, eq } from "drizzle-orm";

import { emptyValues } from "@/lib/cms/values";
import { getBlock } from "@/lib/cms/blocks";
import { db } from "@/lib/db";
import { pageSections, pages } from "@/lib/db/schema";
import { capturePageSnapshot } from "@/lib/versions";

const [page] = await db.select().from(pages).where(eq(pages.slug, "home")).limit(1);
const live = await db
  .select()
  .from(pageSections)
  .where(eq(pageSections.pageId, page.id))
  .orderBy(asc(pageSections.position), asc(pageSections.id));

// An established section the editor has hidden. Nothing else about it changes.
await db
  .update(pageSections)
  .set({ isPublished: false })
  .where(eq(pageSections.id, live[1].id));

// A pending one, shaped the way a restore or a new editor block shapes it.
const block = getBlock("rich-text");
const [pending] = await db
  .insert(pageSections)
  .values({
    pageId: page.id,
    blockType: "rich-text",
    position: 999,
    isPublished: false,
    isDraftOnly: true,
    published: emptyValues(block),
    draft: { title: { en: "NOT PUBLISHED YET", ar: "" } },
  })
  .returning({ id: pageSections.id });

const snapshot = await capturePageSnapshot(page.id);

// And the column's default, which is what every row written before this
// migration — and by the previous release — lands on.
const [anyExisting] = await db
  .select({ isDraftOnly: pageSections.isDraftOnly })
  .from(pageSections)
  .where(eq(pageSections.id, live[0].id))
  .limit(1);

emit({
  hiddenId: live[1].id,
  draftOnlyId: pending.id,
  snapshot: snapshot.sections.map((section) => ({
    sourceSectionId: section.sourceSectionId,
    visible: section.visible,
    blockType: section.blockType,
  })),
  defaults: anyExisting,
});
process.exit(0);
`,
    );

    const byId = new Map(out.snapshot.map((section) => [section.sourceSectionId, section]));

    // The hidden section is in the snapshot, and its hiddenness is the fact
    // history has to keep — restoring this version must put it back hidden,
    // not leave it out.
    const hidden = byId.get(out.hiddenId);
    assert.ok(hidden, "a hidden established section was dropped from the snapshot");
    assert.equal(hidden.visible, false, "the snapshot forgot that the section was hidden");

    // The pending one was never part of the published page, so it is not in a
    // snapshot of it.
    assert.ok(
      !byId.has(out.draftOnlyId),
      "a section nobody has published reached a snapshot of the published page",
    );

    // Filtering on `isPublished` would have got both of these wrong.
    assert.equal(out.defaults.isDraftOnly, false, "an established row did not default to established");

    const [counts] = await sql<{ established: number; pending: number }[]>`
      select
        count(*) filter (where is_draft_only = false)::int as established,
        count(*) filter (where is_draft_only)::int as pending
      from page_sections s join pages p on p.id = s.page_id
      where p.slug = 'home'
    `;
    assert.equal(counts!.pending, 1);
    assert.equal(out.snapshot.length, counts!.established);
  });

  test("a section a restore brings back is draft-only until somebody publishes it", async () => {
    const name = giveFresh("draft_only_restore");
    const sql = open(name);

    const out = probeValue<{
      deletedId: number;
      recreated: number[];
      row: { isDraftOnly: boolean; isPublished: boolean; blockType: string; draft: Values };
      secondSnapshot: number[];
      firstSnapshot: number[];
      inStructure: boolean;
    }>(
      name,
      `
import { asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { pageSections, pages } from "@/lib/db/schema";
import { capturePageSnapshot, restoreVersionToDraft, savePageVersion } from "@/lib/versions";

const [page] = await db.select().from(pages).where(eq(pages.slug, "home")).limit(1);
const live = await db
  .select()
  .from(pageSections)
  .where(eq(pageSections.pageId, page.id))
  .orderBy(asc(pageSections.position), asc(pageSections.id));

const firstSnapshot = await capturePageSnapshot(page.id);
const versionId = await savePageVersion({ pageId: page.id, label: "before the delete" });

const deleted = live[2];
await db.delete(pageSections).where(eq(pageSections.id, deleted.id));

const restored = await restoreVersionToDraft(versionId, page.id);
if (!restored.ok) throw new Error("the restore was refused: " + restored.reason);

const [row] = await db
  .select({
    isDraftOnly: pageSections.isDraftOnly,
    isPublished: pageSections.isPublished,
    blockType: pageSections.blockType,
    draft: pageSections.draft,
  })
  .from(pageSections)
  .where(eq(pageSections.id, restored.recreated[0]))
  .limit(1);

// A snapshot taken now is of the page as published — which no longer includes
// the deleted section, and does not yet include the pending replacement.
const secondSnapshot = await capturePageSnapshot(page.id);
const [pageRow] = await db.select().from(pages).where(eq(pages.id, page.id)).limit(1);
const structure = pageRow.draftStructure ?? { sections: [] };

emit({
  deletedId: deleted.id,
  recreated: restored.recreated,
  row,
  firstSnapshot: firstSnapshot.sections.map((s) => s.sourceSectionId),
  secondSnapshot: secondSnapshot.sections.map((s) => s.sourceSectionId),
  inStructure: structure.sections.some((s) => s.sectionId === restored.recreated[0]),
});
process.exit(0);
`,
    );

    assert.equal(out.recreated.length, 1, "the deleted section was not recreated");
    const recreated = out.recreated[0]!;

    assert.equal(out.row.isDraftOnly, true, "a restored section was treated as established");
    assert.equal(out.row.isPublished, false, "a restore published a section");
    assert.ok(out.row.draft, "the recreated section carries no draft");

    // It is where a pending section belongs: in the draft structure, and out of
    // the published composition.
    assert.ok(out.inStructure, "the recreated section is not in the draft order");
    assert.ok(out.firstSnapshot.includes(out.deletedId), "the original was not in the first snapshot");
    assert.ok(
      !out.secondSnapshot.includes(recreated),
      "a restored section reached a snapshot before anybody published it",
    );
    assert.ok(!out.secondSnapshot.includes(out.deletedId), "a deleted section is still in the snapshot");

    const [row] = await sql<{ is_draft_only: boolean; is_published: boolean }[]>`
      select is_draft_only, is_published from page_sections where id = ${recreated}
    `;
    assert.deepEqual(row, { is_draft_only: true, is_published: false });
  });
});
