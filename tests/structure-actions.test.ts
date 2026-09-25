/**
 * Structural editing, against the running application.
 *
 * The governing rule of the batch, in one sentence: **a structural change
 * creates a page layout draft and never changes the live composition.** Almost
 * everything below is that sentence asked in a different way — what the visitor
 * sees before and after, what the preview shows, and what happens when two
 * screens edit the same layout.
 *
 * Everything goes through the real Server Actions over HTTP with the session
 * cookie, the CSRF token and the origin a browser sends, and is read back from
 * the database and from the real rendered pages.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { callAction, type ActionResponse } from "./helpers/action";
import { giveFresh } from "./helpers/fixtures";
import { get } from "./helpers/http";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { startServer, isBuilt, BUILD_HINT, type Server } from "./helpers/server";
import { signIn, type TestSession } from "./helpers/session";

import type { ActionState } from "@/lib/admin/actions";
import { ITEM_ID_KEY } from "@/lib/cms/item-id";
import { readDraftStructure, type DraftStructure } from "@/lib/cms/structure";
import type { StyleDocument } from "@/lib/cms/styles";
import type { VisualStructureResult } from "@/lib/visual-editor/content";

const PORT = 3445;
const VE_ACTIONS = "app/(backoffice)/admin/visual-editor/actions.ts";
const PAGE_ACTIONS = "app/(backoffice)/admin/(shell)/pages/actions.ts";
const VE_ROUTE = "/admin/visual-editor";

let database = "";
let sql: Sql;
let server: Server;
let owner: TestSession;
let viewer: TestSession;

type PageRow = { id: number; slug: string; revision: number; draft_structure: unknown };
type SectionRow = {
  id: number;
  page_id: number;
  block_type: string;
  position: number;
  is_published: boolean;
  is_draft_only: boolean;
  revision: number;
  draft: Record<string, unknown> | null;
  published: Record<string, unknown>;
  styles: Record<string, unknown>;
  draft_styles: Record<string, unknown> | null;
  animation: string;
};

const pageBySlug = async (slug: string): Promise<PageRow> => {
  const [row] = await sql<PageRow[]>`
    select id, slug, revision, draft_structure from pages where slug = ${slug}`;
  assert.ok(row, `no page ${slug}`);
  return row;
};

const sectionsOf = async (pageId: number): Promise<SectionRow[]> =>
  sql<SectionRow[]>`
    select id, page_id, block_type, position, is_published, is_draft_only, revision,
           draft, published, styles, draft_styles, animation
      from page_sections where page_id = ${pageId}
     order by position asc, id asc`;

const sectionById = async (id: number): Promise<SectionRow | undefined> =>
  (
    await sql<SectionRow[]>`
      select id, page_id, block_type, position, is_published, is_draft_only, revision,
             draft, published, styles, draft_styles, animation
        from page_sections where id = ${id}`
  )[0];

const structureOf = async (pageId: number): Promise<DraftStructure | null> => {
  const [row] = await sql<{ draft_structure: unknown }[]>`
    select draft_structure from pages where id = ${pageId}`;
  return readDraftStructure(row?.draft_structure);
};

const idsIn = (structure: DraftStructure | null): number[] =>
  structure ? structure.sections.map((entry) => entry.sectionId) : [];

/** The block types a rendered page shows, in document order. */
/**
 * The page-level publication, as an editor's screen calls it.
 *
 * Batch 10 replaced "Publish all drafts" — which published content and styles
 * and silently left the layout behind — with one action that publishes
 * everything a page has saved. The tests below were written against the old
 * promise that it "never publishes structure"; that promise was the defect,
 * and they now assert the structural publication instead.
 */
const publishSavedChanges = (
  origin: string,
  page: { id: number; slug: string; revision: number },
  csrf: string,
  cookie: string,
) => {
  const form = new FormData();
  form.set("_csrf", csrf);
  form.set("pageId", String(page.id));
  form.set("expectedRevision", String(page.revision));
  return callAction<ActionState>({
    origin,
    route: `/admin/pages/${page.slug}`,
    file: PAGE_ACTIONS,
    action: "publishPage",
    args: [{ ok: false }, form],
    cookie,
  });
};

const orderOf = (html: string): string[] =>
  [...html.matchAll(/data-section="([^"]+)"/g)].map((match) => match[1]!);

/** Back the page out of every layout edit, so each test starts level. */
async function reset(slug: string): Promise<PageRow> {
  const page = await pageBySlug(slug);
  await sql`delete from page_sections where page_id = ${page.id} and is_draft_only = true`;
  await sql`update pages set draft_structure = null where id = ${page.id}`;
  return pageBySlug(slug);
}

function answered<T>(response: ActionResponse<T>): T {
  assert.ok(response.value, `the action returned nothing (status ${response.status})`);
  return response.value;
}

/** A Visual Editor structural action, called the way the panel calls it. */
function structural(
  action: string,
  page: { id: number; revision: number },
  fields: Record<string, string | number> = {},
  options: { cookie?: string | null; csrf?: string | null } = {},
) {
  const form = new FormData();
  const csrf = options.csrf === undefined ? owner.csrfToken : options.csrf;
  if (csrf !== null) form.set("_csrf", csrf);
  form.set("pageId", String(page.id));
  form.set("expectedRevision", String(page.revision));
  for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
  return callAction<VisualStructureResult>({
    origin: server.origin,
    route: VE_ROUTE,
    file: VE_ACTIONS,
    action,
    args: [form],
    cookie: options.cookie === undefined ? owner.cookie : (options.cookie ?? undefined),
  });
}

/** A Pages-screen structural action, called the way that screen calls it. */
function adminAction(action: string, fields: Record<string, string | number>) {
  const form = new FormData();
  form.set("_csrf", owner.csrfToken);
  for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
  return callAction<ActionState>({
    origin: server.origin,
    route: "/admin/pages",
    file: PAGE_ACTIONS,
    action,
    args: [{ ok: false }, form],
    cookie: owner.cookie,
  });
}

before(async () => {
  assert.ok(isBuilt(), BUILD_HINT);
  database = giveFresh("structure_actions");
  sql = connect(database);
  owner = await signIn(sql);
  await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    select 'viewer@test.invalid', 'Read Only', 'unused', id, true
      from roles where key = 'viewer'`;
  viewer = await signIn(sql, "viewer");
  server = await startServer(database, PORT);
});

after(async () => {
  await server?.stop();
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
});

/* -------------------------------------------------------------------------- */

describe("adding a section adds it to the layout, not to the site", () => {
  test("the row is pending, the live page is untouched, and preview shows it", async () => {
    const page = await reset("about");
    const before = await sectionsOf(page.id);
    const live = orderOf((await get(server.origin, "/about")).html);

    const added = answered(await structural("addPageSection", page, { blockType: "stats" }));
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.ok(added.ok);
    const id = added.sectionId!;

    const row = (await sectionById(id))!;
    assert.equal(row.is_draft_only, true, "the new row is not pending");
    assert.equal(row.is_published, false, "the new row was published");
    assert.equal(row.block_type, "stats");
    // Editable immediately, and with something to promote when the layout is
    // published — both columns carry the block's defaults.
    assert.ok(row.draft && Object.keys(row.draft).length > 0, "no editable draft");
    assert.ok(Object.keys(row.published).length > 0, "no published defaults");

    // Nothing that was already there moved.
    const now = await sectionsOf(page.id);
    for (const established of before) {
      const after = now.find((candidate) => candidate.id === established.id)!;
      assert.equal(after.position, established.position, "a live position moved");
      assert.equal(after.is_published, established.is_published, "a live visibility moved");
    }
    assert.ok(row.position > Math.max(...before.map((r) => r.position)), "the row took a live slot");

    // The page's counter moved once, and the document names the new section.
    const after = await pageBySlug("about");
    assert.equal(after.revision, page.revision + 1);
    assert.deepEqual(idsIn(await structureOf(page.id)), [...before.map((r) => r.id), id]);

    // A visitor sees exactly what they saw; an editor sees one more section.
    assert.deepEqual(orderOf((await get(server.origin, "/about")).html), live);
    const preview = orderOf(
      (await get(server.origin, "/about?preview=1", { cookie: owner.cookie })).html,
    );
    assert.deepEqual(preview, [...live, "stats"]);
  });

  test("it can be placed after a section rather than at the end", async () => {
    const page = await reset("about");
    const rows = await sectionsOf(page.id);
    const anchor = rows[0]!.id;

    const added = answered(
      await structural("addPageSection", page, { blockType: "stats", afterSectionId: anchor }),
    );
    assert.ok(added.ok);
    assert.deepEqual(idsIn(await structureOf(page.id)), [
      anchor,
      added.sectionId!,
      ...rows.slice(1).map((r) => r.id),
    ]);
  });

  test("an anchor that is not in the layout is refused", async () => {
    const page = await reset("about");
    const other = (await sectionsOf((await pageBySlug("home")).id))[0]!;
    const refused = answered(
      await structural("addPageSection", page, { blockType: "stats", afterSectionId: other.id }),
    );
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(await structureOf(page.id), null, "a layout draft was written anyway");
  });

  test("a block the registry does not offer this page is refused, and nothing is written", async () => {
    const page = await reset("about");
    const before = (await sectionsOf(page.id)).length;
    for (const blockType of ["", "not-a-block", "quick-links", "hero"]) {
      const refused = answered(await structural("addPageSection", page, { blockType }));
      assert.equal(refused.ok, false, blockType);
    }
    assert.equal((await sectionsOf(page.id)).length, before, "a row was created anyway");
    assert.equal((await pageBySlug("about")).revision, page.revision, "the counter moved");
  });

  test("a stale screen's Add creates nothing at all", async () => {
    const page = await reset("about");
    const before = (await sectionsOf(page.id)).length;

    // Somebody else moves the layout first.
    answered(await structural("addPageSection", page, { blockType: "stats" }));
    const middle = (await sectionsOf(page.id)).length;

    // …and the first screen tries against the revision it was built from.
    const refused = answered(await structural("addPageSection", page, { blockType: "stats" }));
    assert.equal(refused.ok, false);
    assert.ok(!refused.ok && refused.reason === "conflict", JSON.stringify(refused));
    // The row the refused attempt inserted has to be gone with it: a pending
    // section no document lists cannot be reached from any layout.
    assert.equal((await sectionsOf(page.id)).length, middle, "an orphan row survived");
    assert.equal(middle, before + 1);
  });
});

/* -------------------------------------------------------------------------- */

describe("duplicating copies what the editor sees, into the layout only", () => {
  test("the copy is pending, sits after the source, and shares nothing but its look", async () => {
    const page = await reset("home");
    const rows = await sectionsOf(page.id);
    const source = rows.find((row) => row.block_type === "quick-links")!;
    const live = orderOf((await get(server.origin, "/")).html);

    // Give the source something worth copying, in both domains.
    await sql`update page_sections
                 set draft_styles = ${sql.json({ v: 1, nodes: { "field:title": { base: { textColor: "orange" } } } })}::jsonb
               where id = ${source.id}`;

    const copied = answered(await structural("duplicatePageSection", page, { sectionId: source.id }));
    assert.equal(copied.ok, true, JSON.stringify(copied));
    assert.ok(copied.ok);
    const copy = (await sectionById(copied.sectionId!))!;

    assert.equal(copy.is_draft_only, true);
    assert.equal(copy.is_published, false);
    assert.equal(copy.block_type, source.block_type);
    assert.equal(copy.animation, source.animation, "the copy previews differently");

    // Immediately after the source in the layout, and nowhere near the live order.
    const order = idsIn(await structureOf(page.id));
    assert.equal(order[order.indexOf(source.id) + 1], copy.id);
    const afterRows = await sectionsOf(page.id);
    for (const established of rows) {
      assert.equal(
        afterRows.find((r) => r.id === established.id)!.position,
        established.position,
        "a live position was renumbered to make room",
      );
    }

    // Content came across, validated, with identities of its own.
    const sourceNow = (await sectionById(source.id))!;
    const sourceIds = ((sourceNow.draft ?? sourceNow.published).links as Record<string, unknown>[])
      .map((row) => String(row[ITEM_ID_KEY]));
    const copyIds = ((copy.draft as Record<string, unknown>).links as Record<string, unknown>[])
      .map((row) => String(row[ITEM_ID_KEY]));
    assert.equal(copyIds.length, sourceIds.length, "the rows did not come across");
    for (const id of copyIds) assert.ok(!sourceIds.includes(id), "the copy shares a row identity");

    // …and the styles came across pointing at the copy's rows.
    const copyStyles = copy.draft_styles as StyleDocument;
    assert.deepEqual(copyStyles.nodes["field:title"], { base: { textColor: "orange" } });

    // The original is exactly as it was.
    assert.deepEqual(sourceNow.published, source.published);
    assert.equal(sourceNow.position, source.position);
    assert.equal(sourceNow.is_published, source.is_published);

    // And a visitor sees no change at all.
    assert.deepEqual(orderOf((await get(server.origin, "/")).html), live);
  });

  test("an item-level style follows the row it was copied from", async () => {
    const page = await reset("home");
    const source = (await sectionsOf(page.id)).find((row) => row.block_type === "quick-links")!;
    const links = (source.draft ?? source.published).links as Record<string, unknown>[];
    const first = String(links[0]![ITEM_ID_KEY]);

    await sql`update page_sections
                 set draft_styles = ${sql.json({
                   v: 1,
                   nodes: { [`field:links/item:${first}`]: { base: { radius: "lg" } } },
                 })}::jsonb
               where id = ${source.id}`;

    const copied = answered(await structural("duplicatePageSection", page, { sectionId: source.id }));
    assert.ok(copied.ok);
    const copy = (await sectionById(copied.sectionId!))!;
    const copyFirst = String(
      ((copy.draft as Record<string, unknown>).links as Record<string, unknown>[])[0]![ITEM_ID_KEY],
    );

    const nodes = (copy.draft_styles as StyleDocument).nodes;
    assert.deepEqual(nodes[`field:links/item:${copyFirst}`], { base: { radius: "lg" } });
    assert.equal(nodes[`field:links/item:${first}`], undefined, "the copy points at the original's row");
    assert.notEqual(copyFirst, first);
  });

  test("a duplicated section keeps its layout, on the container and on the copy's own rows", async () => {
    /**
     * §24. The list container is addressed by field name, which the copy shares,
     * and a row is addressed by an id the copy does not — so the container's
     * grid has to survive unchanged and the row's width has to move onto the new
     * row. Anything left pointing at the original's id would be an override the
     * copy shows and its owner cannot find.
     */
    const page = await reset("home");
    const source = (await sectionsOf(page.id)).find((row) => row.block_type === "quick-links")!;
    const links = (source.draft ?? source.published).links as Record<string, unknown>[];
    const first = String(links[0]![ITEM_ID_KEY]);

    await sql`update page_sections
                 set draft_styles = ${sql.json({
                   v: 1,
                   nodes: {
                     root: { base: { layout: "flex", alignItems: "center", minHeight: "half-screen" } },
                     "field:links": { base: { layout: "grid", columns: 4 }, mobile: { columns: 1 } },
                     [`field:links/item:${first}`]: { base: { width: "half", glow: "soft" } },
                   },
                 })}::jsonb
               where id = ${source.id}`;

    const copied = answered(await structural("duplicatePageSection", page, { sectionId: source.id }));
    assert.ok(copied.ok);
    const copy = (await sectionById(copied.sectionId!))!;
    const copyFirst = String(
      ((copy.draft as Record<string, unknown>).links as Record<string, unknown>[])[0]![ITEM_ID_KEY],
    );
    const nodes = (copy.draft_styles as StyleDocument).nodes;

    assert.deepEqual(nodes.root, {
      base: { layout: "flex", alignItems: "center", minHeight: "half-screen" },
    });
    assert.deepEqual(nodes["field:links"], { base: { layout: "grid", columns: 4 }, mobile: { columns: 1 } });
    assert.deepEqual(nodes[`field:links/item:${copyFirst}`], { base: { width: "half", glow: "soft" } });
    for (const key of Object.keys(nodes)) {
      assert.ok(!key.includes(first), `${key} still names the original's row`);
    }
  });

  test("a stale duplicate leaves no orphan", async () => {
    const page = await reset("about");
    const source = (await sectionsOf(page.id))[0]!;
    answered(await structural("duplicatePageSection", page, { sectionId: source.id }));
    const middle = (await sectionsOf(page.id)).length;

    const refused = answered(await structural("duplicatePageSection", page, { sectionId: source.id }));
    assert.ok(!refused.ok && refused.reason === "conflict");
    assert.equal((await sectionsOf(page.id)).length, middle, "an orphan copy survived");
  });
});

/* -------------------------------------------------------------------------- */

describe("reordering is a document, not a renumbering", () => {
  test("preview follows the new order and the live page keeps the old one", async () => {
    const page = await reset("about");
    const rows = await sectionsOf(page.id);
    const live = orderOf((await get(server.origin, "/about")).html);
    const reversed = [...rows].reverse().map((row) => row.id);

    const moved = answered(
      await structural("reorderPageStructure", page, { order: JSON.stringify(reversed) }),
    );
    assert.equal(moved.ok, true, JSON.stringify(moved));
    assert.deepEqual(idsIn(await structureOf(page.id)), reversed);

    // Not one live position moved.
    const afterRows = await sectionsOf(page.id);
    for (const row of rows) {
      assert.equal(afterRows.find((r) => r.id === row.id)!.position, row.position);
    }

    assert.deepEqual(orderOf((await get(server.origin, "/about")).html), live, "the site reordered");
    const preview = orderOf(
      (await get(server.origin, "/about?preview=1", { cookie: owner.cookie })).html,
    );
    assert.deepEqual(preview, [...live].reverse());
  });

  test("visibility is carried across a reorder", async () => {
    const page = await reset("about");
    const rows = await sectionsOf(page.id);
    const hidden = rows[1]!.id;

    const first = answered(
      await structural("setPageSectionVisibility", page, { sectionId: hidden, visible: "false" }),
    );
    assert.ok(first.ok);

    const moved = answered(
      await structural(
        "reorderPageStructure",
        { id: page.id, revision: first.revision },
        { order: JSON.stringify([...rows].reverse().map((r) => r.id)) },
      ),
    );
    assert.ok(moved.ok);
    const entry = (await structureOf(page.id))!.sections.find((e) => e.sectionId === hidden);
    assert.equal(entry?.visible, false, "reordering decided something about visibility");
  });

  test("a list that is not a permutation is refused, and nothing is written", async () => {
    const page = await reset("about");
    const rows = (await sectionsOf(page.id)).map((row) => row.id);
    const home = await pageBySlug("home");
    const homeBefore = await structureOf(home.id);
    const homeRevision = home.revision;
    const foreign = (await sectionsOf(home.id))[0]!.id;

    for (const order of [
      [...rows, foreign],
      [...rows.slice(1)],
      [...rows, rows[0]!],
      [rows[0]!, rows[0]!, ...rows.slice(2)],
      [],
      ["nope"],
    ]) {
      const refused = answered(
        await structural("reorderPageStructure", page, { order: JSON.stringify(order) }),
      );
      assert.equal(refused.ok, false, JSON.stringify(order));
    }
    assert.equal(await structureOf(page.id), null, "a refused order was written");
    assert.equal((await pageBySlug("about")).revision, page.revision);

    // …and the foreign section's own page was not touched either — neither its
    // layout nor its counter, so the refusal was not quietly a removal there.
    assert.deepEqual(await structureOf(home.id), homeBefore, "another page's layout was changed");
    assert.equal((await pageBySlug("home")).revision, homeRevision, "another page's counter moved");
  });
});

/* -------------------------------------------------------------------------- */

describe("hiding is an intention", () => {
  test("preview still renders it, the site still shows it, and the row is unchanged", async () => {
    const page = await reset("about");
    const rows = await sectionsOf(page.id);
    const target = rows[1]!;
    const live = orderOf((await get(server.origin, "/about")).html);

    const hidden = answered(
      await structural("setPageSectionVisibility", page, { sectionId: target.id, visible: "false" }),
    );
    assert.equal(hidden.ok, true, JSON.stringify(hidden));

    const row = (await sectionById(target.id))!;
    assert.equal(row.is_published, target.is_published, "a style intention flipped a live flag");
    assert.equal(row.revision, target.revision, "the section's own counter moved");

    // Still rendered for the editor — they have to be able to reach it.
    const preview = orderOf(
      (await get(server.origin, "/about?preview=1", { cookie: owner.cookie })).html,
    );
    assert.deepEqual(preview, live, "a hidden section vanished from the editor's canvas");
    assert.deepEqual(orderOf((await get(server.origin, "/about")).html), live, "the site changed");

    // …and back again.
    const shown = answered(
      await structural(
        "setPageSectionVisibility",
        { id: page.id, revision: hidden.revision },
        { sectionId: target.id, visible: "true" },
      ),
    );
    assert.ok(shown.ok);
    assert.equal((await sectionById(target.id))!.is_published, target.is_published);
  });
});

/* -------------------------------------------------------------------------- */

describe("removing is reversible, and the row stays put", () => {
  test("an established section leaves the layout and keeps everything else", async () => {
    const page = await reset("about");
    const rows = await sectionsOf(page.id);
    const target = rows[2]!;
    const live = orderOf((await get(server.origin, "/about")).html);

    const removed = answered(await structural("removePageSection", page, { sectionId: target.id }));
    assert.equal(removed.ok, true, JSON.stringify(removed));

    const row = (await sectionById(target.id))!;
    assert.ok(row, "the row was deleted");
    assert.equal(row.is_published, target.is_published);
    assert.equal(row.position, target.position);
    assert.deepEqual(row.published, target.published);

    assert.ok(!idsIn(await structureOf(page.id)).includes(target.id));
    assert.deepEqual(orderOf((await get(server.origin, "/about")).html), live, "the site lost it");
    const preview = orderOf(
      (await get(server.origin, "/about?preview=1", { cookie: owner.cookie })).html,
    );
    assert.equal(preview.length, live.length - 1, "preview kept a removed section");

    // Restoring brings back the same row, near where the live page has it.
    const restored = answered(
      await structural(
        "restorePageSection",
        { id: page.id, revision: removed.revision },
        { sectionId: target.id },
      ),
    );
    assert.ok(restored.ok);
    assert.equal(restored.sectionId, target.id, "a different section came back");
    assert.deepEqual(idsIn(await structureOf(page.id)), rows.map((r) => r.id));
    assert.equal((await sectionsOf(page.id)).length, rows.length, "a row was recreated");
  });

  test("a pending section is removed the same reversible way", async () => {
    const page = await reset("about");
    const added = answered(await structural("addPageSection", page, { blockType: "stats" }));
    assert.ok(added.ok);
    const id = added.sectionId!;

    const removed = answered(
      await structural("removePageSection", { id: page.id, revision: added.revision }, { sectionId: id }),
    );
    assert.ok(removed.ok);
    // Still there: a click that threw away an afternoon's work would be the only
    // irreversible structural operation in the set.
    assert.ok(await sectionById(id), "a pending row was deleted by a removal");
    assert.ok(!idsIn(await structureOf(page.id)).includes(id));

    // `/about` has a stats section of its own, so the count is what changes:
    // one fewer than the layout held a moment ago.
    const preview = orderOf(
      (await get(server.origin, "/about?preview=1", { cookie: owner.cookie })).html,
    );
    assert.equal(preview.length, idsIn(await structureOf(page.id)).length);
    assert.ok(!idsIn(await structureOf(page.id)).includes(id));

    const restored = answered(
      await structural(
        "restorePageSection",
        { id: page.id, revision: removed.revision },
        { sectionId: id },
      ),
    );
    assert.ok(restored.ok);
    assert.equal(restored.sectionId, id, "restoring made a second row");
    assert.equal((await sectionsOf(page.id)).filter((r) => r.is_draft_only).length, 1);
  });

  test("removing something twice, or restoring something present, is refused", async () => {
    const page = await reset("about");
    const target = (await sectionsOf(page.id))[0]!;
    const removed = answered(await structural("removePageSection", page, { sectionId: target.id }));
    assert.ok(removed.ok);

    const again = answered(
      await structural(
        "removePageSection",
        { id: page.id, revision: removed.revision },
        { sectionId: target.id },
      ),
    );
    assert.equal(again.ok, false);

    const restored = answered(
      await structural(
        "restorePageSection",
        { id: page.id, revision: removed.revision },
        { sectionId: target.id },
      ),
    );
    assert.ok(restored.ok);
    const twice = answered(
      await structural(
        "restorePageSection",
        { id: page.id, revision: restored.revision },
        { sectionId: target.id },
      ),
    );
    assert.equal(twice.ok, false);
  });
});

/* -------------------------------------------------------------------------- */

describe("discarding the layout puts the page back", () => {
  test("every kind of pending change goes, and nothing established does", async () => {
    const page = await reset("about");
    const rows = await sectionsOf(page.id);
    const live = orderOf((await get(server.origin, "/about")).html);

    // A content draft on an established section, which is not this button's.
    await sql`update page_sections set draft = ${sql.json({ title: { en: "Kept", ar: "" } })}::jsonb
               where id = ${rows[0]!.id}`;

    let revision = page.revision;
    const added = answered(await structural("addPageSection", { id: page.id, revision }, { blockType: "stats" }));
    assert.ok(added.ok);
    revision = added.revision;
    const copied = answered(
      await structural("duplicatePageSection", { id: page.id, revision }, { sectionId: rows[1]!.id }),
    );
    assert.ok(copied.ok);
    revision = copied.revision;
    const hidden = answered(
      await structural(
        "setPageSectionVisibility",
        { id: page.id, revision },
        { sectionId: rows[1]!.id, visible: "false" },
      ),
    );
    assert.ok(hidden.ok);
    revision = hidden.revision;
    const removed = answered(
      await structural("removePageSection", { id: page.id, revision }, { sectionId: rows[2]!.id }),
    );
    assert.ok(removed.ok);
    revision = removed.revision;
    const reordered = answered(
      await structural(
        "reorderPageStructure",
        { id: page.id, revision },
        {
          order: JSON.stringify(
            [...idsIn(await structureOf(page.id))].reverse(),
          ),
        },
      ),
    );
    assert.ok(reordered.ok);
    revision = reordered.revision;

    assert.equal((await sectionsOf(page.id)).filter((r) => r.is_draft_only).length, 2);

    const discarded = answered(await structural("discardPageLayout", { id: page.id, revision }));
    assert.equal(discarded.ok, true, JSON.stringify(discarded));

    const after = await pageBySlug("about");
    assert.equal(after.draft_structure, null, "the layout draft survived");
    assert.equal(after.revision, revision + 1);

    const now = await sectionsOf(page.id);
    assert.equal(now.filter((r) => r.is_draft_only).length, 0, "a pending row survived");
    assert.deepEqual(now.map((r) => r.id), rows.map((r) => r.id), "an established row was touched");
    for (const row of rows) {
      const still = now.find((r) => r.id === row.id)!;
      assert.equal(still.position, row.position);
      assert.equal(still.is_published, row.is_published);
    }
    // The content draft on an established section is a different kind of
    // unpublished work and is not this button's to throw away.
    assert.ok((await sectionById(rows[0]!.id))!.draft, "a content draft was discarded with the layout");

    assert.deepEqual(orderOf((await get(server.origin, "/about")).html), live);
    const preview = orderOf(
      (await get(server.origin, "/about?preview=1", { cookie: owner.cookie })).html,
    );
    assert.deepEqual(preview, live, "preview did not return to the established page");
  });

  test("a stale discard deletes nothing", async () => {
    const page = await reset("about");
    const added = answered(await structural("addPageSection", page, { blockType: "stats" }));
    assert.ok(added.ok);

    const refused = answered(await structural("discardPageLayout", page));
    assert.ok(!refused.ok && refused.reason === "conflict", JSON.stringify(refused));
    assert.ok(await sectionById(added.sectionId!), "a stale discard deleted a pending row");
    assert.ok(await structureOf(page.id), "a stale discard cleared the layout");
  });
});

/* -------------------------------------------------------------------------- */

describe("structure and content are different timelines", () => {
  test("a content save and a layout change do not collide, in either order", async () => {
    const page = await reset("about");
    const section = (await sectionsOf(page.id))[0]!;

    // Content first.
    const content = new FormData();
    content.set("_csrf", owner.csrfToken);
    content.set("sectionId", String(section.id));
    content.set("pageId", String(page.id));
    content.set("expectedRevision", String(section.revision));
    content.set("values", JSON.stringify({ title: { en: "Independent", ar: "" } }));
    const saved = answered(
      await callAction<{ ok: boolean }>({
        origin: server.origin,
        route: VE_ROUTE,
        file: VE_ACTIONS,
        action: "saveVisualSectionDraft",
        args: [content],
        cookie: owner.cookie,
      }),
    );
    assert.equal(saved.ok, true, JSON.stringify(saved));
    // The page's counter did not move for a section's content.
    assert.equal((await pageBySlug("about")).revision, page.revision);

    // …and the layout change still succeeds against the revision it read.
    const moved = answered(
      await structural("reorderPageStructure", page, {
        order: JSON.stringify([...(await sectionsOf(page.id))].reverse().map((r) => r.id)),
      }),
    );
    assert.equal(moved.ok, true, JSON.stringify(moved));
    // …and the section's own counter did not move for a layout change.
    assert.equal((await sectionById(section.id))!.revision, section.revision + 1);
  });

  test("a style save and a layout change do not collide either", async () => {
    const page = await reset("terms");
    const section = (await sectionsOf(page.id))[0]!;

    const moved = answered(
      await structural("reorderPageStructure", page, {
        order: JSON.stringify([...(await sectionsOf(page.id))].reverse().map((r) => r.id)),
      }),
    );
    assert.ok(moved.ok);

    const styles = new FormData();
    styles.set("_csrf", owner.csrfToken);
    styles.set("sectionId", String(section.id));
    styles.set("pageId", String(page.id));
    styles.set("expectedRevision", String(section.revision));
    styles.set("styles", JSON.stringify({ v: 1, nodes: { root: { base: { opacity: 0.5 } } } }));
    const saved = answered(
      await callAction<{ ok: boolean }>({
        origin: server.origin,
        route: VE_ROUTE,
        file: VE_ACTIONS,
        action: "saveVisualSectionStyles",
        args: [styles],
        cookie: owner.cookie,
      }),
    );
    assert.equal(saved.ok, true, "a layout change made a style save conflict");
    assert.equal((await pageBySlug("terms")).revision, moved.revision, "a style save moved the page");
  });
});

/* -------------------------------------------------------------------------- */

describe("two screens on one layout", () => {
  test("the first change wins and the second is told so", async () => {
    const page = await reset("about");
    const rows = (await sectionsOf(page.id)).map((row) => row.id);

    // Both tabs read the same revision.
    const a = { id: page.id, revision: page.revision };
    const b = { id: page.id, revision: page.revision };

    const first = answered(
      await structural("reorderPageStructure", a, { order: JSON.stringify([...rows].reverse()) }),
    );
    assert.ok(first.ok);

    const second = answered(
      await structural("setPageSectionVisibility", b, { sectionId: rows[0]!, visible: "false" }),
    );
    assert.equal(second.ok, false);
    assert.ok(!second.ok && second.reason === "conflict", JSON.stringify(second));
    assert.match(!second.ok ? second.message : "", /layout changed/i);

    // A's work is whole and B changed nothing.
    assert.deepEqual(idsIn(await structureOf(page.id)), [...rows].reverse());
    const entry = (await structureOf(page.id))!.sections.find((e) => e.sectionId === rows[0]!);
    assert.equal(entry?.visible, true, "the refused change landed anyway");
    assert.equal((await pageBySlug("about")).revision, page.revision + 1);
  });

  test("the same person in two tabs conflicts exactly the same way", async () => {
    const page = await reset("about");
    const rows = (await sectionsOf(page.id)).map((row) => row.id);
    answered(await structural("removePageSection", page, { sectionId: rows[0]! }));
    const refused = answered(await structural("removePageSection", page, { sectionId: rows[1]! }));
    assert.ok(!refused.ok && refused.reason === "conflict");
    assert.deepEqual(idsIn(await structureOf(page.id)), rows.slice(1));
  });

  test("a form with no revision at all is refused rather than defaulted", async () => {
    const page = await reset("about");
    const form = new FormData();
    form.set("_csrf", owner.csrfToken);
    form.set("pageId", String(page.id));
    form.set("blockType", "stats");
    const refused = answered(
      await callAction<VisualStructureResult>({
        origin: server.origin,
        route: VE_ROUTE,
        file: VE_ACTIONS,
        action: "addPageSection",
        args: [form],
        cookie: owner.cookie,
      }),
    );
    assert.equal(refused.ok, false);
    assert.equal((await sectionsOf(page.id)).filter((r) => r.is_draft_only).length, 0);
  });
});

/* -------------------------------------------------------------------------- */

describe("who may restructure", () => {
  test("a reader may not, through any operation", async () => {
    const page = await reset("about");
    const rows = (await sectionsOf(page.id)).map((row) => row.id);
    const attempts: Array<[string, Record<string, string | number>]> = [
      ["addPageSection", { blockType: "stats" }],
      ["duplicatePageSection", { sectionId: rows[0]! }],
      ["removePageSection", { sectionId: rows[0]! }],
      ["restorePageSection", { sectionId: rows[0]! }],
      ["setPageSectionVisibility", { sectionId: rows[0]!, visible: "false" }],
      ["reorderPageStructure", { order: JSON.stringify([...rows].reverse()) }],
      ["discardPageLayout", {}],
    ];
    for (const [action, fields] of attempts) {
      const refused = answered(
        await structural(action, page, fields, { cookie: viewer.cookie, csrf: viewer.csrfToken }),
      );
      assert.equal(refused.ok, false, action);
    }
    assert.equal(await structureOf(page.id), null, "a reader changed the layout");
    assert.equal((await pageBySlug("about")).revision, page.revision);
    assert.equal((await sectionsOf(page.id)).length, rows.length);
  });

  test("a request without the session's own token is refused", async () => {
    const page = await reset("about");
    for (const csrf of [null, "not-the-token"]) {
      const refused = answered(await structural("addPageSection", page, { blockType: "stats" }, { csrf }));
      assert.equal(refused.ok, false, String(csrf));
    }
    const signedOut = answered(
      await structural("addPageSection", page, { blockType: "stats" }, { cookie: null }),
    );
    assert.equal(signedOut.ok, false);
    assert.equal(await structureOf(page.id), null);
  });

  test("one page's layout cannot name another page's section", async () => {
    const about = await reset("about");
    const home = await reset("home");
    const foreign = (await sectionsOf(home.id))[0]!.id;

    for (const action of [
      "duplicatePageSection",
      "removePageSection",
      "restorePageSection",
      "setPageSectionVisibility",
    ]) {
      const refused = answered(
        await structural(action, about, { sectionId: foreign, visible: "false" }),
      );
      assert.equal(refused.ok, false, action);
    }
    assert.equal(await structureOf(about.id), null, "another page's section entered this layout");
    assert.equal(await structureOf(home.id), null, "the other page's layout was changed");
    assert.equal((await pageBySlug("home")).revision, home.revision);
  });
});

/* -------------------------------------------------------------------------- */

describe("the Pages screen edits the same layout draft", () => {
  test("Add, Move, Hide, Duplicate and Delete all stop at the draft", async () => {
    const page = await reset("about");
    const rows = await sectionsOf(page.id);
    const live = orderOf((await get(server.origin, "/about")).html);
    let revision = page.revision;
    const next = async () => {
      revision = (await pageBySlug("about")).revision;
      return revision;
    };

    const added = answered(
      await adminAction("addSection", {
        pageId: page.id,
        expectedRevision: revision,
        blockType: "stats",
      }),
    );
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.match(added.message ?? "", /layout draft/i);
    assert.ok(!/live/i.test(added.message ?? ""), added.message);

    const moved = answered(
      await adminAction("moveSection", {
        pageId: page.id,
        id: rows[1]!.id,
        direction: "up",
        expectedRevision: await next(),
      }),
    );
    assert.equal(moved.ok, true, JSON.stringify(moved));

    const hidden = answered(
      await adminAction("toggleSection", {
        pageId: page.id,
        id: rows[0]!.id,
        visible: "false",
        expectedRevision: await next(),
      }),
    );
    assert.equal(hidden.ok, true, JSON.stringify(hidden));

    const duplicated = answered(
      await adminAction("duplicateSection", {
        pageId: page.id,
        id: rows[2]!.id,
        expectedRevision: await next(),
      }),
    );
    assert.equal(duplicated.ok, true, JSON.stringify(duplicated));

    const deleted = answered(
      await adminAction("deleteSection", {
        pageId: page.id,
        id: rows[3]!.id,
        expectedRevision: await next(),
      }),
    );
    assert.equal(deleted.ok, true, JSON.stringify(deleted));

    // Not one live row changed, and the visitor's page is identical.
    const now = await sectionsOf(page.id);
    for (const row of rows) {
      const still = now.find((r) => r.id === row.id)!;
      assert.ok(still, `row ${row.id} was deleted`);
      assert.equal(still.position, row.position, "a live position moved");
      assert.equal(still.is_published, row.is_published, "a live visibility moved");
    }
    assert.deepEqual(orderOf((await get(server.origin, "/about")).html), live);

    // …and everything happened in the document instead.
    const structure = (await structureOf(page.id))!;
    assert.ok(!idsIn(structure).includes(rows[3]!.id), "Delete did not remove it from the layout");
    assert.equal(
      structure.sections.find((e) => e.sectionId === rows[0]!.id)?.visible,
      false,
      "Hide did not reach the layout",
    );
    assert.equal(now.filter((r) => r.is_draft_only).length, 2, "Add and Duplicate did not create rows");
  });

  test("a stale Pages screen conflicts like any other", async () => {
    const page = await reset("about");
    const rows = (await sectionsOf(page.id)).map((row) => row.id);
    answered(
      await adminAction("deleteSection", {
        pageId: page.id,
        id: rows[0]!,
        expectedRevision: page.revision,
      }),
    );
    const refused = answered(
      await adminAction("toggleSection", {
        pageId: page.id,
        id: rows[1]!,
        visible: "false",
        expectedRevision: page.revision,
      }),
    );
    assert.equal(refused.ok, false);
    assert.match(refused.message ?? "", /layout changed/i);
    assert.equal(
      (await structureOf(page.id))!.sections.find((e) => e.sectionId === rows[1]!)?.visible,
      true,
    );
  });

  test("Restore is available from the Pages screen too", async () => {
    const page = await reset("about");
    const target = (await sectionsOf(page.id))[0]!.id;
    answered(
      await adminAction("deleteSection", {
        pageId: page.id,
        id: target,
        expectedRevision: page.revision,
      }),
    );
    const back = answered(
      await adminAction("restoreSection", {
        pageId: page.id,
        id: target,
        expectedRevision: (await pageBySlug("about")).revision,
      }),
    );
    assert.equal(back.ok, true, JSON.stringify(back));
    assert.ok(idsIn(await structureOf(page.id)).includes(target));
  });

  test("Discard layout is available there as well", async () => {
    const page = await reset("about");
    answered(
      await adminAction("addSection", {
        pageId: page.id,
        expectedRevision: page.revision,
        blockType: "stats",
      }),
    );
    const discarded = answered(
      await adminAction("discardLayout", {
        pageId: page.id,
        expectedRevision: (await pageBySlug("about")).revision,
      }),
    );
    assert.equal(discarded.ok, true, JSON.stringify(discarded));
    assert.equal((await pageBySlug("about")).draft_structure, null);
    assert.equal((await sectionsOf(page.id)).filter((r) => r.is_draft_only).length, 0);
  });

  test("the screen carries the page revision into every structural form", async () => {
    const page = await reset("about");
    const screen = await get(server.origin, "/admin/pages/about", { cookie: owner.cookie });
    assert.match(screen.html, new RegExp(`name="expectedRevision"[^>]*value="${page.revision}"`));
    assert.match(screen.html, /Add section/);
  });
});

/* -------------------------------------------------------------------------- */

describe("a pending section cannot be published on its own", () => {
  test("Save and publish, and Publish draft, both refuse and say why", async () => {
    const page = await reset("about");
    const added = answered(await structural("addPageSection", page, { blockType: "stats" }));
    assert.ok(added.ok);
    const id = added.sectionId!;
    const row = (await sectionById(id))!;

    const publish = new FormData();
    publish.set("_csrf", owner.csrfToken);
    publish.set("id", String(id));
    publish.set("expectedRevision", String(row.revision));
    publish.set("values", JSON.stringify({ title: { en: "Not live", ar: "" } }));
    const refused = answered(
      await callAction<ActionState>({
        origin: server.origin,
        route: `/admin/pages/section/${id}`,
        file: PAGE_ACTIONS,
        action: "saveSectionAndPublish",
        args: [{ ok: false }, publish],
        cookie: owner.cookie,
      }),
    );
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.match(refused.message ?? "", /unpublished layout/i);
    assert.ok(!/live now/i.test(refused.message ?? ""));

    const after = (await sectionById(id))!;
    assert.equal(after.is_published, false, "a pending section was published");
    assert.equal(after.is_draft_only, true);

    const publishDraft = new FormData();
    publishDraft.set("_csrf", owner.csrfToken);
    publishDraft.set("id", String(id));
    publishDraft.set("expectedRevision", String(after.revision));
    const second = answered(
      await callAction<ActionState>({
        origin: server.origin,
        route: `/admin/pages/section/${id}`,
        file: PAGE_ACTIONS,
        action: "publishSection",
        args: [{ ok: false }, publishDraft],
        cookie: owner.cookie,
      }),
    );
    assert.equal(second.ok, false);
    assert.match(second.message ?? "", /unpublished layout/i);
  });

  test("but saving a draft on it is ordinary work", async () => {
    const page = await reset("about");
    const added = answered(await structural("addPageSection", page, { blockType: "stats" }));
    assert.ok(added.ok);
    const id = added.sectionId!;
    const row = (await sectionById(id))!;

    const form = new FormData();
    form.set("_csrf", owner.csrfToken);
    form.set("sectionId", String(id));
    form.set("pageId", String(page.id));
    form.set("expectedRevision", String(row.revision));
    form.set("values", JSON.stringify({ title: { en: "Being written", ar: "" } }));
    const saved = answered(
      await callAction<{ ok: boolean }>({
        origin: server.origin,
        route: VE_ROUTE,
        file: VE_ACTIONS,
        action: "saveVisualSectionDraft",
        args: [form],
        cookie: owner.cookie,
      }),
    );
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(
      ((await sectionById(id))!.draft as { title: { en: string } }).title.en,
      "Being written",
    );

    // …and the editor is told, rather than offered a button that lies.
    const screen = await get(server.origin, `/admin/pages/section/${id}`, { cookie: owner.cookie });
    assert.match(screen.html, /part of an unpublished layout/i);
    assert.ok(!screen.html.includes("Save and publish"), "a pending section offered Publish");
  });

  test("Publishing the page's saved changes establishes a pending section", async () => {
    // The old page-level button deliberately skipped pending sections, because
    // it could not publish the layout that gave them a place. Batch 10's can,
    // so a section added in the editor becomes an ordinary established one.
    const page = await reset("about");
    const established = (await sectionsOf(page.id))[0]!;
    await sql`update page_sections set draft = ${sql.json({ title: { en: "Ready", ar: "" } })}::jsonb
               where id = ${established.id}`;
    const added = answered(await structural("addPageSection", page, { blockType: "stats" }));
    assert.ok(added.ok);
    const pending = added.sectionId!;

    const current = await pageBySlug("about");
    const published = answered(
      await publishSavedChanges(server.origin, current, owner.csrfToken, owner.cookie),
    );
    assert.equal(published.ok, true, JSON.stringify(published));

    // The established one went out…
    const now = (await sectionById(established.id))!;
    assert.equal(now.draft, null);
    assert.equal((now.published as { title: { en: string } }).title.en, "Ready");

    // …and so did the pending one, as one row rather than a copy.
    const row = (await sectionById(pending))!;
    assert.equal(row.is_draft_only, false, "a published section is still pending");
    assert.equal(row.is_published, true, "the layout said visible and it is not");
    assert.equal(row.draft, null, "its draft was not promoted");
    assert.equal(await structureOf(page.id), null, "the layout draft was not cleared");
    assert.ok(
      orderOf((await get(server.origin, "/about")).html).includes("stats"),
      "the new section is not on the live page",
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("a structural action belongs to the screen that submitted it", () => {
  /**
   * The page comes from the form, never from the section.
   *
   * Looking the page up from the section id sounds defensive and proves the
   * wrong thing: it establishes that the section belongs to *some* page, not to
   * the one whose screen submitted the request. Two pages on the same revision
   * — ordinary, since every page starts at one — would then let Home's screen
   * restructure About. So these tests deliberately put both pages on the same
   * revision first: a test that passed because the revisions happened to differ
   * would be proving nothing.
   */
  async function levelled(): Promise<{ home: PageRow; about: PageRow }> {
    await reset("home");
    await reset("about");
    await sql`update pages set revision = 7 where slug in ('home', 'about')`;
    return { home: await pageBySlug("home"), about: await pageBySlug("about") };
  }

  test("Home's screen cannot restructure About, even at the same revision", async () => {
    const { home, about } = await levelled();
    assert.equal(home.revision, about.revision, "the setup did not level the revisions");
    const foreign = (await sectionsOf(about.id))[0]!.id;
    const homeRows = await sectionsOf(home.id);
    const aboutRows = await sectionsOf(about.id);

    const loggedBefore = (
      await sql<{ count: number }[]>`
        select count(*)::int as count from activity_logs
         where action like 'section.layout_%' or action like 'page.layout_%'`
    )[0]!.count;

    const attempts: Array<[string, Record<string, string | number>]> = [
      ["moveSection", { id: foreign, direction: "up" }],
      ["duplicateSection", { id: foreign }],
      ["toggleSection", { id: foreign, visible: "false" }],
      ["deleteSection", { id: foreign }],
      ["restoreSection", { id: foreign }],
    ];
    for (const [action, fields] of attempts) {
      const refused = answered(
        await adminAction(action, { pageId: home.id, expectedRevision: home.revision, ...fields }),
      );
      assert.equal(refused.ok, false, `${action} was allowed`);
    }

    // Neither page's layout, rows or counter moved.
    assert.equal(await structureOf(home.id), null, "Home's layout was written");
    assert.equal(await structureOf(about.id), null, "About's layout was written");
    assert.deepEqual((await sectionsOf(home.id)).map((r) => r.id), homeRows.map((r) => r.id));
    assert.deepEqual((await sectionsOf(about.id)).map((r) => r.id), aboutRows.map((r) => r.id));
    assert.equal((await pageBySlug("home")).revision, home.revision);
    assert.equal((await pageBySlug("about")).revision, about.revision);

    // …and not one of the five was logged as a success.
    const loggedAfter = (
      await sql<{ count: number }[]>`
        select count(*)::int as count from activity_logs
         where action like 'section.layout_%' or action like 'page.layout_%'`
    )[0]!.count;
    assert.equal(loggedAfter, loggedBefore, "a refused structural action was logged as done");
  });

  test("the Visual Editor refuses the same thing, at the same revision", async () => {
    const { home, about } = await levelled();
    const foreign = (await sectionsOf(about.id))[0]!.id;

    for (const action of [
      "duplicatePageSection",
      "removePageSection",
      "restorePageSection",
      "setPageSectionVisibility",
    ]) {
      const refused = answered(
        await structural(action, home, { sectionId: foreign, visible: "false" }),
      );
      assert.equal(refused.ok, false, action);
    }
    assert.equal(await structureOf(home.id), null);
    assert.equal(await structureOf(about.id), null);
    assert.equal((await pageBySlug("about")).revision, about.revision);
  });

  test("a row-level form with no page at all is refused rather than repaired", async () => {
    const page = await reset("about");
    const target = (await sectionsOf(page.id))[0]!.id;
    for (const action of ["deleteSection", "duplicateSection", "restoreSection"]) {
      const refused = answered(
        await adminAction(action, { id: target, expectedRevision: page.revision }),
      );
      assert.equal(refused.ok, false, action);
    }
    assert.equal(await structureOf(page.id), null);
    assert.equal((await pageBySlug("about")).revision, page.revision);
  });

  test("and with its own page it still does all five things", async () => {
    const page = await reset("about");
    const rows = (await sectionsOf(page.id)).map((row) => row.id);
    const at = async () => (await pageBySlug("about")).revision;

    const moved = answered(
      await adminAction("moveSection", {
        pageId: page.id,
        id: rows[1]!,
        direction: "up",
        expectedRevision: await at(),
      }),
    );
    assert.equal(moved.ok, true, JSON.stringify(moved));
    assert.deepEqual(idsIn(await structureOf(page.id)).slice(0, 2), [rows[1]!, rows[0]!]);

    const hidden = answered(
      await adminAction("toggleSection", {
        pageId: page.id,
        id: rows[0]!,
        visible: "false",
        expectedRevision: await at(),
      }),
    );
    assert.equal(hidden.ok, true, JSON.stringify(hidden));

    const copied = answered(
      await adminAction("duplicateSection", {
        pageId: page.id,
        id: rows[0]!,
        expectedRevision: await at(),
      }),
    );
    assert.equal(copied.ok, true, JSON.stringify(copied));

    const removed = answered(
      await adminAction("deleteSection", {
        pageId: page.id,
        id: rows[2]!,
        expectedRevision: await at(),
      }),
    );
    assert.equal(removed.ok, true, JSON.stringify(removed));

    const restored = answered(
      await adminAction("restoreSection", {
        pageId: page.id,
        id: rows[2]!,
        expectedRevision: await at(),
      }),
    );
    assert.equal(restored.ok, true, JSON.stringify(restored));

    // …and the page's own screen is showing the layout that resulted, at the
    // revision the next action will have to name.
    const revision = await at();
    const screen = await get(server.origin, "/admin/pages/about", { cookie: owner.cookie });
    assert.match(screen.html, new RegExp(`name="expectedRevision"[^>]*value="${revision}"`));
    assert.match(screen.html, /Layout draft/);
    // Every structural form on this screen names the page it belongs to.
    assert.match(screen.html, /name="pageId"/);
  });
});

/* -------------------------------------------------------------------------- */

describe("a visibility nobody sent is not a decision to hide", () => {
  const BAD = ["", "0", "1", "TRUE", "True", "yes", "garbage", "null", "undefined"];

  test("the Visual Editor refuses every value that is not exactly true or false", async () => {
    const page = await reset("about");
    const target = (await sectionsOf(page.id))[0]!;
    const rowBefore = await sectionById(target.id);

    for (const visible of BAD) {
      const refused = answered(
        await structural("setPageSectionVisibility", page, { sectionId: target.id, visible }),
      );
      assert.equal(refused.ok, false, `"${visible}" was accepted`);
    }
    // …and one with the field missing altogether.
    const form = new FormData();
    form.set("_csrf", owner.csrfToken);
    form.set("pageId", String(page.id));
    form.set("expectedRevision", String(page.revision));
    form.set("sectionId", String(target.id));
    const missing = answered(
      await callAction<VisualStructureResult>({
        origin: server.origin,
        route: VE_ROUTE,
        file: VE_ACTIONS,
        action: "setPageSectionVisibility",
        args: [form],
        cookie: owner.cookie,
      }),
    );
    assert.equal(missing.ok, false, "a missing field was read as hide");

    assert.equal(await structureOf(page.id), null, "a malformed request wrote a layout");
    assert.equal((await pageBySlug("about")).revision, page.revision);
    assert.equal((await sectionById(target.id))!.is_published, rowBefore!.is_published);
  });

  test("the Pages screen refuses them too", async () => {
    const page = await reset("about");
    const target = (await sectionsOf(page.id))[0]!;

    for (const visible of BAD) {
      const refused = answered(
        await adminAction("toggleSection", {
          pageId: page.id,
          id: target.id,
          visible,
          expectedRevision: page.revision,
        }),
      );
      assert.equal(refused.ok, false, `"${visible}" was accepted`);
    }
    const missing = answered(
      await adminAction("toggleSection", {
        pageId: page.id,
        id: target.id,
        expectedRevision: page.revision,
      }),
    );
    assert.equal(missing.ok, false, "a missing field was read as hide");
    assert.equal(await structureOf(page.id), null);
    assert.equal((await pageBySlug("about")).revision, page.revision);
  });

  test("and both still accept the two values that mean something", async () => {
    const page = await reset("about");
    const target = (await sectionsOf(page.id))[0]!;

    const hidden = answered(
      await structural("setPageSectionVisibility", page, {
        sectionId: target.id,
        visible: "false",
      }),
    );
    assert.equal(hidden.ok, true, JSON.stringify(hidden));
    assert.equal(
      (await structureOf(page.id))!.sections.find((e) => e.sectionId === target.id)?.visible,
      false,
    );

    const shown = answered(
      await adminAction("toggleSection", {
        pageId: page.id,
        id: target.id,
        visible: "true",
        expectedRevision: (await pageBySlug("about")).revision,
      }),
    );
    assert.equal(shown.ok, true, JSON.stringify(shown));
    assert.equal(
      (await structureOf(page.id))!.sections.find((e) => e.sectionId === target.id)?.visible,
      true,
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("publishing content does not publish a section", () => {
  /**
   * Publishing used to set `is_published: true`, which made sense when that was
   * the only way a section became visible. With a layout draft it is how a
   * hidden section quietly appears on the live site: an editor fixes a typo on
   * a section the page is not showing, presses Publish, and the section goes
   * live because the two decisions shared one write. They are not one decision.
   */
  const hide = async (sectionId: number) => {
    await sql`update page_sections set is_published = false where id = ${sectionId}`;
    return (await sectionById(sectionId))!;
  };

  test("Save and publish writes the words and leaves the section hidden", async () => {
    const page = await reset("terms");
    const section = await hide((await sectionsOf(page.id))[1]!.id);
    const live = orderOf((await get(server.origin, "/terms")).html);

    const form = new FormData();
    form.set("_csrf", owner.csrfToken);
    form.set("id", String(section.id));
    form.set("expectedRevision", String(section.revision));
    form.set("values", JSON.stringify({ title: { en: "Published but hidden", ar: "" } }));
    const published = answered(
      await callAction<ActionState>({
        origin: server.origin,
        route: `/admin/pages/section/${section.id}`,
        file: PAGE_ACTIONS,
        action: "saveSectionAndPublish",
        args: [{ ok: false }, form],
        cookie: owner.cookie,
      }),
    );
    assert.equal(published.ok, true, JSON.stringify(published));
    // The words the editor reads describe what actually happened.
    assert.match(published.message ?? "", /remains hidden on the live page/i);
    assert.ok(!/live now/i.test(published.message ?? ""), published.message);

    const after = (await sectionById(section.id))!;
    assert.equal((after.published as { title: { en: string } }).title.en, "Published but hidden");
    assert.equal(after.draft, null);
    assert.equal(after.revision, section.revision + 1);
    assert.equal(after.is_published, false, "publishing content made the section live");
    assert.equal(after.is_draft_only, false);

    // Nothing structural moved, and the visitor's page is identical.
    assert.equal(await structureOf(page.id), null);
    assert.equal((await pageBySlug("terms")).revision, page.revision);
    assert.deepEqual(orderOf((await get(server.origin, "/terms")).html), live);
  });

  test("Publish draft promotes the draft and leaves the section hidden", async () => {
    const page = await reset("terms");
    const section = await hide((await sectionsOf(page.id))[1]!.id);
    await sql`update page_sections set draft = ${sql.json({ title: { en: "From a draft", ar: "" } })}::jsonb
               where id = ${section.id}`;
    const current = (await sectionById(section.id))!;
    const live = orderOf((await get(server.origin, "/terms")).html);

    const form = new FormData();
    form.set("_csrf", owner.csrfToken);
    form.set("id", String(section.id));
    form.set("expectedRevision", String(current.revision));
    const published = answered(
      await callAction<ActionState>({
        origin: server.origin,
        route: `/admin/pages/section/${section.id}`,
        file: PAGE_ACTIONS,
        action: "publishSection",
        args: [{ ok: false }, form],
        cookie: owner.cookie,
      }),
    );
    assert.equal(published.ok, true, JSON.stringify(published));
    assert.match(published.message ?? "", /remains hidden on the live page/i);

    const after = (await sectionById(section.id))!;
    assert.equal((after.published as { title: { en: string } }).title.en, "From a draft");
    assert.equal(after.draft, null);
    assert.equal(after.is_published, false, "Publish draft made the section live");
    assert.equal(await structureOf(page.id), null);
    assert.deepEqual(orderOf((await get(server.origin, "/terms")).html), live);
  });

  test("Publishing the page promotes every draft and applies the layout's visibility", async () => {
    const page = await reset("disclaimer");
    const rows = await sectionsOf(page.id);
    const visible = rows[0]!;
    const hidden = await hide(rows[1]!.id);
    const live = orderOf((await get(server.origin, "/disclaimer")).html);

    for (const id of [visible.id, hidden.id]) {
      await sql`update page_sections set draft = ${sql.json({ title: { en: "Both ready", ar: "" } })}::jsonb
                 where id = ${id}`;
    }

    const current = await pageBySlug("disclaimer");
    const published = answered(
      await publishSavedChanges(server.origin, current, owner.csrfToken, owner.cookie),
    );
    assert.equal(published.ok, true, JSON.stringify(published));

    const afterVisible = (await sectionById(visible.id))!;
    const afterHidden = (await sectionById(hidden.id))!;
    assert.equal(afterVisible.draft, null);
    assert.equal(afterHidden.draft, null);
    assert.equal((afterVisible.published as { title: { en: string } }).title.en, "Both ready");
    assert.equal((afterHidden.published as { title: { en: string } }).title.en, "Both ready");

    /**
     * With no layout draft, the composition is the live one — so visibility is
     * unchanged even though this action *can* change it. The rule that moved in
     * Batch 10 is where visibility may be published from, not whether content
     * publication may do it: it still may not.
     */
    assert.equal(afterVisible.is_published, true, "a visible section stopped being visible");
    assert.equal(afterHidden.is_published, false, "a hidden section was made live");
    assert.equal(await structureOf(page.id), null);
    assert.deepEqual(orderOf((await get(server.origin, "/disclaimer")).html), live);
    // A page-level publication is a checkpoint, so the page's own revision moves.
    assert.ok(
      (await pageBySlug("disclaimer")).revision > current.revision,
      "the page revision did not advance",
    );
  });


  test("a visible section publishes exactly as it always did", async () => {
    const page = await reset("privacy");
    const section = (await sectionsOf(page.id))[1]!;
    assert.equal(section.is_published, true, "the fixture's section is not visible");
    const live = orderOf((await get(server.origin, "/privacy")).html);

    const form = new FormData();
    form.set("_csrf", owner.csrfToken);
    form.set("id", String(section.id));
    form.set("expectedRevision", String(section.revision));
    form.set("values", JSON.stringify({ title: { en: "Still live", ar: "" } }));
    const published = answered(
      await callAction<ActionState>({
        origin: server.origin,
        route: `/admin/pages/section/${section.id}`,
        file: PAGE_ACTIONS,
        action: "saveSectionAndPublish",
        args: [{ ok: false }, form],
        cookie: owner.cookie,
      }),
    );
    assert.equal(published.ok, true, JSON.stringify(published));
    assert.match(published.message ?? "", /live now/i);

    const after = (await sectionById(section.id))!;
    assert.equal((after.published as { title: { en: string } }).title.en, "Still live");
    assert.equal(after.is_published, true);
    const now = await get(server.origin, "/privacy");
    assert.deepEqual(orderOf(now.html), live);
    assert.ok(now.html.includes("Still live"), "the published words did not reach the visitor");
  });
});

/* -------------------------------------------------------------------------- */

describe("nothing structural reaches a visitor", () => {
  test("no layout document, no revision, no removed sections, no editor code", async () => {
    const page = await reset("about");
    const rows = (await sectionsOf(page.id)).map((row) => row.id);
    let revision = page.revision;
    const added = answered(await structural("addPageSection", { id: page.id, revision }, { blockType: "stats" }));
    assert.ok(added.ok);
    revision = added.revision;
    answered(await structural("removePageSection", { id: page.id, revision }, { sectionId: rows[1]! }));

    const live = await get(server.origin, "/about");
    assert.ok(!live.html.includes("draft_structure"));
    assert.ok(!live.html.includes("draftStructure"));
    assert.ok(!live.html.includes('"sections":'), "a layout document reached the page");
    assert.ok(!live.html.includes("data-eod-"), "editor markup reached a visitor");
    assert.ok(!live.html.includes("data-removed-sections"));
    assert.ok(!live.html.includes("Discard layout"));
    assert.ok(!live.html.includes("data-block-picker"));
    // The removed section is still on the live page, because removal is pending.
    assert.equal(orderOf(live.html).length, rows.length);
  });
});

/* -------------------------------------------------------------------------- */

describe("a restored version's layout is an ordinary layout", () => {
  /**
   * Restoring a version already writes pending rows and a structure document
   * together. The structural editor has to understand that state without
   * knowing where it came from — so the operations below run against a layout
   * nobody in this test built with the Add button.
   */
  test("its pending rows can be reordered, hidden, removed and discarded", async () => {
    const page = await reset("about");
    const rows = await sectionsOf(page.id);

    // The shape a restore leaves behind: a pending row, and a document naming
    // it alongside the established ones.
    const [pending] = await sql<{ id: number }[]>`
      insert into page_sections (page_id, block_type, position, is_published, is_draft_only, published, draft)
      values (${page.id}, 'stats', ${rows.length + 5}, false, true, '{}'::jsonb, '{}'::jsonb)
      returning id`;
    const restored = {
      v: 1,
      sections: [
        { sectionId: pending!.id, visible: true },
        ...rows.map((row) => ({ sectionId: row.id, visible: row.is_published })),
      ],
    };
    await sql`update pages set draft_structure = ${sql.json(restored)}::jsonb,
                               revision = revision + 1 where id = ${page.id}`;
    let revision = (await pageBySlug("about")).revision;

    // The editor reads it as-is, pending row first.
    assert.deepEqual(idsIn(await structureOf(page.id)), [pending!.id, ...rows.map((r) => r.id)]);
    const preview = orderOf(
      (await get(server.origin, "/about?preview=1", { cookie: owner.cookie })).html,
    );
    assert.equal(preview[0], "stats", "the restored layout was not previewed");

    const hidden = answered(
      await structural(
        "setPageSectionVisibility",
        { id: page.id, revision },
        { sectionId: pending!.id, visible: "false" },
      ),
    );
    assert.equal(hidden.ok, true, JSON.stringify(hidden));
    revision = hidden.revision;

    const moved = answered(
      await structural(
        "reorderPageStructure",
        { id: page.id, revision },
        { order: JSON.stringify([...rows.map((r) => r.id), pending!.id]) },
      ),
    );
    assert.ok(moved.ok);
    revision = moved.revision;

    // …and discarding cleans up a row no Add button created.
    const discarded = answered(await structural("discardPageLayout", { id: page.id, revision }));
    assert.ok(discarded.ok);
    assert.equal(await sectionById(pending!.id), undefined, "a restored pending row survived");
    assert.equal((await pageBySlug("about")).draft_structure, null);
    assert.deepEqual((await sectionsOf(page.id)).map((r) => r.id), rows.map((r) => r.id));
  });
});
