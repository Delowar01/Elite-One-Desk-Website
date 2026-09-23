/**
 * Draft → publish → history → restore, against the running application.
 *
 * The governing rule of the batch, in one sentence: **a page's saved changes
 * become the live page in one atomic act, and every act that changes the live
 * page leaves a restore point.** Everything here goes through the real Server
 * Actions over HTTP with the session cookie, the CSRF token and the origin a
 * browser sends, and is read back from the database and from the real rendered
 * pages.
 *
 * The highest-value case is the equivalence one: what the authenticated preview
 * showed immediately before publication is what a visitor gets immediately
 * after. Everything else — the refusals, the guards, the deletions — exists so
 * that this either happens completely or does not happen at all.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { callAction, type ActionResponse } from "./helpers/action";
import { giveFresh } from "./helpers/fixtures";
import { get } from "./helpers/http";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { startServer, isBuilt, BUILD_HINT, type Server } from "./helpers/server";
import { signIn, type TestSession } from "./helpers/session";

import { DRAFT_STRUCTURE_VERSION } from "@/lib/cms/structure";
import { STYLE_DOCUMENT_VERSION } from "@/lib/cms/styles";
import {
  KEEP_PAGE_VERSIONS,
  type PageActionResult,
  type PageSummaryView,
} from "@/lib/visual-editor/publish";

const PORT = 3447;
const VE_ACTIONS = "app/(backoffice)/admin/visual-editor/actions.ts";
const PAGE_ACTIONS = "app/(backoffice)/admin/(shell)/pages/actions.ts";
const VE_ROUTE = "/admin/visual-editor";

let database = "";
let sql: Sql;
let server: Server;
let owner: TestSession;
let viewer: TestSession;

type SectionRow = {
  id: number;
  page_id: number;
  revision: number;
  block_type: string;
  draft: Record<string, unknown> | null;
  published: Record<string, unknown>;
  styles: Record<string, unknown>;
  draft_styles: Record<string, unknown> | null;
  is_published: boolean;
  is_draft_only: boolean;
  animation: string;
  draft_animation: string | null;
  position: number;
};

type PageRow = { id: number; slug: string; revision: number; draft_structure: unknown };

const pageBySlug = async (slug: string): Promise<PageRow> => {
  const [row] = await sql<PageRow[]>`
    select id, slug, revision, draft_structure from pages where slug = ${slug}`;
  assert.ok(row, `no page ${slug}`);
  return row;
};

const sectionsOf = async (pageId: number): Promise<SectionRow[]> =>
  sql<SectionRow[]>`
    select id, page_id, revision, block_type, draft, published, styles, draft_styles,
           is_published, is_draft_only, animation, draft_animation, position
      from page_sections where page_id = ${pageId}
     order by position asc, id asc`;

const sectionById = async (id: number): Promise<SectionRow | null> => {
  const [row] = await sql<SectionRow[]>`
    select id, page_id, revision, block_type, draft, published, styles, draft_styles,
           is_published, is_draft_only, animation, draft_animation, position
      from page_sections where id = ${id}`;
  return row ?? null;
};

const versionCount = async (pageId: number): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from page_versions where page_id = ${pageId}`)[0]!.n;

const versionsOf = async (pageId: number) =>
  sql<{ id: number; label: string; actor_name: string; created_by: number | null }[]>`
    select id, label, actor_name, created_by from page_versions
     where page_id = ${pageId} order by created_at desc, id desc`;

const logCount = async (action: string): Promise<number> =>
  (await sql<{ n: number }[]>`select count(*)::int as n from activity_logs where action = ${action}`)[0]!.n;

function answered<T>(response: ActionResponse<T>): T {
  assert.ok(response.value, `the action returned nothing (status ${response.status})`);
  return response.value;
}

/**
 * Back a page out of every pending edit *and* every published one.
 *
 * Publication deletes rows, so a test that removes a section leaves the page
 * permanently shorter for everything that runs after it. Clearing the draft
 * columns is therefore not enough: the sections themselves are restored from a
 * copy taken before the first test, with their original ids, so each test sees
 * the page the fixture shipped whatever the one before it published.
 */
async function reset(slug: string): Promise<PageRow> {
  const page = await pageBySlug(slug);
  await sql`delete from page_sections where page_id = ${page.id}`;
  await sql`insert into page_sections select * from eodt_sections_backup where page_id = ${page.id}`;
  // The sequence is deliberately left alone: every restored id came from it
  // already, so it is past them — and lowering it would hand a later insert an
  // id another page's pending row is still using.
  await sql`update pages set draft_structure = null, revision = revision + 1 where id = ${page.id}`;
  await sql`delete from page_versions where page_id = ${page.id}`;
  return pageBySlug(slug);
}

const editorAction = <T>(action: string, form: FormData, session = owner) =>
  callAction<T>({
    origin: server.origin,
    route: VE_ROUTE,
    file: VE_ACTIONS,
    action,
    args: [form],
    cookie: session.cookie,
  });

function pageForm(page: { id: number; revision: number }, session = owner, extra: Record<string, string> = {}) {
  const form = new FormData();
  form.set("_csrf", session.csrfToken);
  form.set("pageId", String(page.id));
  form.set("expectedRevision", String(page.revision));
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return form;
}

const publish = (page: { id: number; revision: number }, session = owner) =>
  editorAction<PageActionResult>("publishPageFromEditor", pageForm(page, session), session);

const discardAll = (page: { id: number; revision: number }, session = owner) =>
  editorAction<PageActionResult>("discardPageFromEditor", pageForm(page, session), session);

const restore = (page: { id: number; revision: number }, versionId: number, session = owner) =>
  editorAction<PageActionResult>(
    "restoreVersionFromEditor",
    pageForm(page, session, { versionId: String(versionId) }),
    session,
  );

const summaryOf = (pageId: number, session = owner) =>
  callAction<PageSummaryView | null>({
    origin: server.origin,
    route: VE_ROUTE,
    file: VE_ACTIONS,
    action: "loadPageSummary",
    args: [pageId],
    cookie: session.cookie,
  });

/** A structural operation through the editor's own action. */
const structural = (action: string, page: PageRow, extra: Record<string, string>) =>
  editorAction<{ ok: boolean; revision?: number; sectionId?: number | null; message?: string }>(
    action,
    pageForm(page, owner, extra),
  );

const orderOf = (html: string): string[] =>
  [...html.matchAll(/data-section="([^"]+)"/g)].map((match) => match[1]!);

const livePath = (slug: string) => (slug === "home" ? "/" : `/${slug}`);
const live = async (slug: string) => (await get(server.origin, livePath(slug))).html;
const preview = async (slug: string) =>
  (await get(server.origin, `${livePath(slug)}?preview=1`, { cookie: owner.cookie })).html;

const styleDoc = (nodes: Record<string, unknown>) =>
  ({ v: STYLE_DOCUMENT_VERSION, nodes }) as unknown as Record<string, never>;

before(async () => {
  assert.ok(isBuilt(), BUILD_HINT);
  database = giveFresh("page_publish");
  sql = connect(database);
  owner = await signIn(sql);
  await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    select 'viewer@test.invalid', 'Read Only', 'unused', id, true from roles where key = 'viewer'
  `;
  viewer = await signIn(sql, "viewer");
  // The pristine composition of every page, for `reset` to put back.
  await sql`create table eodt_sections_backup as select * from page_sections`;
  server = await startServer(database, PORT);
});

after(async () => {
  await server?.stop();
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
});

/* -------------------------------------------------------------------------- */

describe("what the page says is waiting is what the database says", () => {
  test("a clean page has nothing to publish and nothing to discard", async () => {
    const page = await reset("privacy");
    const summary = answered(await summaryOf(page.id));
    assert.ok(summary);
    assert.equal(summary.publishable, false);
    assert.equal(summary.discardable, false);
    assert.equal(summary.contentDrafts, 0);
    assert.equal(summary.hasLayoutDraft, false);
    assert.equal(summary.revision, page.revision);
  });

  test("each draft domain is counted, and only on sections that will survive", async () => {
    const page = await reset("terms");
    const rows = await sectionsOf(page.id);
    await sql`update page_sections set draft = ${sql.json({ title: { en: "A", ar: "" } })}::jsonb where id = ${rows[0]!.id}`;
    await sql`update page_sections set draft_styles = ${sql.json(styleDoc({}))}::jsonb where id = ${rows[1]!.id}`;
    await sql`update page_sections set draft_animation = 'fade' where id = ${rows[1]!.id}`;

    const summary = answered(await summaryOf(page.id));
    assert.ok(summary);
    assert.equal(summary.contentDrafts, 1);
    assert.equal(summary.styleDrafts, 1);
    assert.equal(summary.motionDrafts, 1);
    assert.equal(summary.publishable, true);
    assert.equal(summary.discardable, true);
  });

  test("a draft on a section the layout removes is not counted, because it will not be published", async () => {
    const page = await reset("disclaimer");
    const rows = await sectionsOf(page.id);
    await sql`update page_sections set draft = ${sql.json({ title: { en: "Doomed", ar: "" } })}::jsonb
               where id = ${rows[1]!.id}`;
    answered(await structural("removePageSection", page, { sectionId: String(rows[1]!.id) }));

    const summary = answered(await summaryOf(page.id));
    assert.ok(summary);
    assert.equal(summary.contentDrafts, 0, "a draft on a doomed section was counted as publishable");
    assert.equal(summary.removed, 1);
    assert.equal(summary.publishable, true);
  });

  test("a corrupt layout is discardable but never publishable", async () => {
    const page = await reset("privacy");
    await sql`update pages set draft_structure = ${sql.json({ v: 1, sections: [{ sectionId: "x" }] })}::jsonb
               where id = ${page.id}`;
    const summary = answered(await summaryOf(page.id));
    assert.ok(summary);
    assert.equal(summary.layoutCorrupt, true);
    assert.equal(summary.publishable, false);
    assert.equal(summary.discardable, true);
  });

  test("a reader may see it and may not act on it", async () => {
    const page = await reset("terms");
    assert.ok(answered(await summaryOf(page.id, viewer)));
    const refused = answered(await publish(page, viewer));
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, "denied");
  });
});

/* -------------------------------------------------------------------------- */

describe("publishing a page is one act, or none of it", () => {
  test("a page with nothing waiting is refused, and no version is written", async () => {
    const page = await reset("privacy");
    const before = await versionCount(page.id);
    const refused = answered(await publish(page));
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, "nothing");
    assert.equal(await versionCount(page.id), before);
    assert.equal((await pageBySlug("privacy")).revision, page.revision);
  });

  test("section drafts alone publish, leaving membership and order exactly as they were", async () => {
    const page = await reset("terms");
    const rows = await sectionsOf(page.id);
    const order = rows.map((row) => row.id);
    await sql`update page_sections set draft = ${sql.json({ title: { en: "Words now live", ar: "" } })}::jsonb
               where id = ${rows[0]!.id}`;
    await sql`update page_sections set draft_animation = 'scale-in' where id = ${rows[1]!.id}`;

    const done = answered(await publish(page));
    assert.equal(done.ok, true, JSON.stringify(done));

    const after = await sectionsOf(page.id);
    assert.deepEqual(after.map((row) => row.id), order, "publishing drafts changed the membership");
    assert.equal((after[0]!.published.title as { en: string }).en, "Words now live");
    assert.equal(after[0]!.draft, null);
    assert.equal(after[1]!.animation, "scale-in");
    assert.equal(after[1]!.draft_animation, null);
    assert.equal((await pageBySlug("terms")).draft_structure, null);
    // A page-level publication is a checkpoint even when only sections moved.
    assert.ok(done.ok && done.revision > page.revision);
  });

  test("a reorder alone publishes, and the public order follows the preview's", async () => {
    const page = await reset("disclaimer");
    const rows = await sectionsOf(page.id);
    const flipped = [rows[1]!.id, rows[0]!.id, ...rows.slice(2).map((row) => row.id)];
    answered(await structural("reorderPageStructure", page, { order: JSON.stringify(flipped) }));

    const before = orderOf(await live("disclaimer"));
    const intended = orderOf(await preview("disclaimer"));
    assert.notDeepEqual(before, intended, "the fixture's reorder changed nothing");

    const current = await pageBySlug("disclaimer");
    assert.equal(answered(await publish(current)).ok, true);

    assert.deepEqual(orderOf(await live("disclaimer")), intended);
    assert.equal((await pageBySlug("disclaimer")).draft_structure, null);
    // Contiguous from zero, not the gaps the old positions happened to have.
    const after = await sectionsOf(page.id);
    assert.deepEqual(after.map((row) => row.position), after.map((_, index) => index));
  });

  test("hiding alone publishes, and only the layout may do that", async () => {
    const page = await reset("privacy");
    const rows = await sectionsOf(page.id);
    const target = rows[1]!;
    assert.equal(target.is_published, true);
    answered(
      await structural("setPageSectionVisibility", page, {
        sectionId: String(target.id),
        visible: "false",
      }),
    );

    const current = await pageBySlug("privacy");
    assert.equal(answered(await publish(current)).ok, true);
    assert.equal((await sectionById(target.id))!.is_published, false);
    assert.ok(!orderOf(await live("privacy")).includes(target.block_type));
  });

  test("showing alone publishes too", async () => {
    const page = await reset("privacy");
    const rows = await sectionsOf(page.id);
    const target = rows[1]!;
    await sql`update page_sections set is_published = false where id = ${target.id}`;
    const fresh = await pageBySlug("privacy");
    answered(
      await structural("setPageSectionVisibility", fresh, {
        sectionId: String(target.id),
        visible: "true",
      }),
    );
    assert.equal(answered(await publish(await pageBySlug("privacy"))).ok, true);
    assert.equal((await sectionById(target.id))!.is_published, true);
  });

  test("adding alone publishes: one row, established in place", async () => {
    const page = await reset("about");
    const added = answered(await structural("addPageSection", page, { blockType: "stats" }));
    assert.ok(added.ok && added.sectionId);
    const newId = added.sectionId!;
    assert.equal((await sectionById(newId))!.is_draft_only, true);

    const done = answered(await publish(await pageBySlug("about")));
    assert.equal(done.ok, true, JSON.stringify(done));

    const row = (await sectionById(newId))!;
    assert.equal(row.id, newId, "the section was recreated under another id");
    assert.equal(row.is_draft_only, false);
    assert.equal(row.is_published, true);
    assert.equal(row.draft, null);
    assert.ok(orderOf(await live("about")).includes("stats"));
  });

  test("removing alone publishes: the row is deleted, not hidden", async () => {
    // Hiding an omitted section would make Remove mean Hide — the row would
    // come back the next time the structure was seeded.
    const page = await reset("disclaimer");
    const rows = await sectionsOf(page.id);
    const doomed = rows[rows.length - 1]!;
    answered(await structural("removePageSection", page, { sectionId: String(doomed.id) }));

    assert.equal(answered(await publish(await pageBySlug("disclaimer"))).ok, true);
    assert.equal(await sectionById(doomed.id), null, "a removed section was only hidden");
  });

  test("a pending section the layout leaves out is deleted, and nobody ever saw it", async () => {
    const page = await reset("about");
    const added = answered(await structural("addPageSection", page, { blockType: "stats" }));
    const orphan = added.sectionId!;
    const fresh = await pageBySlug("about");
    answered(await structural("removePageSection", fresh, { sectionId: String(orphan) }));

    // Something else has to be publishable, or the page is a no-op.
    const rows = await sectionsOf(page.id);
    await sql`update page_sections set draft = ${sql.json({ title: { en: "Keep", ar: "" } })}::jsonb
               where id = ${rows[0]!.id}`;

    assert.equal(answered(await publish(await pageBySlug("about"))).ok, true);
    assert.equal(await sectionById(orphan), null, "an orphan pending row survived publication");
  });

  test("an empty layout is a real intention: it publishes a page with no sections", async () => {
    // The one case strictness must not collapse with corruption: this is an
    // editor deliberately emptying a page, and it has to be possible.
    const page = await reset("contact");
    for (const row of await sectionsOf(page.id)) {
      const fresh = await pageBySlug("contact");
      answered(await structural("removePageSection", fresh, { sectionId: String(row.id) }));
    }
    const current = await pageBySlug("contact");
    assert.equal(answered(await publish(current)).ok, true);
    assert.equal((await sectionsOf(page.id)).length, 0);
    assert.deepEqual(orderOf(await live("contact")), []);
  });

  test("everything at once, in one transaction and one restore point", async () => {
    const page = await reset("about");
    const rows = await sectionsOf(page.id);
    const [first, second, third] = rows;
    assert.ok(first && second && third);

    await sql`update page_sections set draft = ${sql.json({ title: { en: "Mixed content", ar: "" } })}::jsonb
               where id = ${first.id}`;
    await sql`update page_sections set draft_styles = ${sql.json(styleDoc({ root: { base: { align: "center" } } }))}::jsonb
               where id = ${second.id}`;
    await sql`update page_sections set draft_animation = 'slide-in' where id = ${third.id}`;

    const added = answered(await structural("addPageSection", await pageBySlug("about"), { blockType: "stats" }));
    const newId = added.sectionId!;
    const doomed = rows[rows.length - 1]!;
    answered(
      await structural("removePageSection", await pageBySlug("about"), { sectionId: String(doomed.id) }),
    );
    answered(
      await structural("setPageSectionVisibility", await pageBySlug("about"), {
        sectionId: String(second.id),
        visible: "false",
      }),
    );

    const intended = orderOf(await preview("about"));
    const versions = await versionCount(page.id);

    const done = answered(await publish(await pageBySlug("about")));
    assert.equal(done.ok, true, JSON.stringify(done));

    assert.equal(await versionCount(page.id), versions + 1, "one publication, one restore point");
    assert.equal((await sectionById(first.id))!.draft, null);
    assert.equal((await sectionById(second.id))!.draft_styles, null);
    assert.equal((await sectionById(second.id))!.is_published, false);
    assert.equal((await sectionById(third.id))!.animation, "slide-in");
    assert.equal((await sectionById(newId))!.is_draft_only, false);
    assert.equal(await sectionById(doomed.id), null);
    assert.equal((await pageBySlug("about")).draft_structure, null);

    // The hidden one is in the preview and not on the live page, which is the
    // one legitimate difference between the two compositions.
    const published = orderOf(await live("about"));
    assert.deepEqual(published, intended.filter((_, index) => index !== intended.indexOf(second.block_type)));
  });
});

/* -------------------------------------------------------------------------- */

describe("the preview an editor approved is the page a visitor gets", () => {
  test("membership, order, words, styles and motion all cross over together", async () => {
    const page = await reset("terms");
    const rows = await sectionsOf(page.id);
    await sql`update page_sections set draft = ${sql.json({ title: { en: "Equivalence", ar: "" } })}::jsonb
               where id = ${rows[0]!.id}`;
    await sql`update page_sections set draft_animation = 'fade' where id = ${rows[0]!.id}`;
    await sql`update page_sections set draft_styles = ${sql.json(styleDoc({ root: { base: { align: "center" } } }))}::jsonb
               where id = ${rows[1]!.id}`;
    answered(
      await structural("reorderPageStructure", await pageBySlug("terms"), {
        order: JSON.stringify([rows[1]!.id, rows[0]!.id, ...rows.slice(2).map((r) => r.id)]),
      }),
    );

    const before = await preview("terms");
    const intendedOrder = orderOf(before);
    assert.ok(before.includes("Equivalence"), "the preview is not showing the draft");

    assert.equal(answered(await publish(await pageBySlug("terms"))).ok, true);

    const html = await live("terms");
    assert.deepEqual(orderOf(html), intendedOrder, "the public order is not the previewed one");
    assert.ok(html.includes("Equivalence"), "the published words are not live");
    assert.match(html, /class="reveal reveal-fade"/, "the published entrance is not live");
    assert.match(html, /text-align:\s*center/, "the published style is not live");

    // …and none of the editor's plumbing crossed over with it.
    assert.ok(!/data-eod-/.test(html), "editor marks reached a visitor");
    assert.ok(!/data-draft="true"/.test(html), "a draft mark reached a visitor");
  });
});

/* -------------------------------------------------------------------------- */

describe("a publication that cannot be completed changes nothing", () => {
  const untouched = async (page: PageRow, rows: SectionRow[], versions: number) => {
    assert.equal((await pageBySlug(page.slug)).revision, page.revision, "the page revision moved");
    assert.equal(await versionCount(page.id), versions, "a failed publish wrote history");
    for (const row of rows) {
      assert.deepEqual(await sectionById(row.id), row, `section ${row.id} moved`);
    }
  };

  test("a stale page revision is refused", async () => {
    const page = await reset("privacy");
    const rows = await sectionsOf(page.id);
    await sql`update page_sections set draft = ${sql.json({ title: { en: "X", ar: "" } })}::jsonb where id = ${rows[0]!.id}`;
    const now = await sectionsOf(page.id);
    const versions = await versionCount(page.id);

    const refused = answered(await publish({ id: page.id, revision: page.revision + 7 }));
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, "conflict");
    await untouched(page, now, versions);
  });

  test("a section that moves mid-publication rolls the whole page back", async () => {
    const page = await reset("terms");
    const rows = await sectionsOf(page.id);
    for (const row of rows.slice(0, 2)) {
      await sql`update page_sections set draft = ${sql.json({ title: { en: "Racing", ar: "" } })}::jsonb where id = ${row.id}`;
    }
    const now = await sectionsOf(page.id);
    const versions = await versionCount(page.id);

    // Publishing one section bumps every sibling, so whichever row the
    // transaction reaches second is guaranteed to have moved.
    await sql.unsafe(`
      create or replace function eodt_race() returns trigger as $$
      begin
        update page_sections set revision = revision + 1
         where page_id = new.page_id and id <> new.id;
        return null;
      end $$ language plpgsql;
      create trigger eodt_race after update on page_sections
        for each row when (old.draft is not null and new.draft is null)
        execute function eodt_race();
    `);
    try {
      const refused = answered(await publish(await pageBySlug("terms")));
      assert.equal(refused.ok, false);
      assert.equal(!refused.ok && refused.reason, "section_conflict");
    } finally {
      await sql.unsafe(`drop trigger eodt_race on page_sections; drop function eodt_race();`);
    }

    assert.equal(await versionCount(page.id), versions, "a rolled-back publish left a restore point");
    for (const row of now) {
      const after = (await sectionById(row.id))!;
      assert.ok(after.draft, "a section was published on its own");
      assert.deepEqual(after.published, row.published);
    }
  });

  test("a corrupt stored layout is refused, and never read as an empty page", async () => {
    const page = await reset("disclaimer");
    const rows = await sectionsOf(page.id);
    await sql`update pages set draft_structure = ${sql.json({ v: 1, sections: [{ sectionId: rows[0]!.id, visible: "yes" }] })}::jsonb
               where id = ${page.id}`;
    const current = await pageBySlug("disclaimer");
    const versions = await versionCount(page.id);

    const refused = answered(await publish(current));
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, "corrupt_structure");
    await untouched(current, rows, versions);
    assert.equal((await sectionsOf(page.id)).length, rows.length, "a corrupt layout deleted sections");
  });

  test("an unreadable motion draft on a section being kept is refused", async () => {
    const page = await reset("privacy");
    const rows = await sectionsOf(page.id);
    await sql`update page_sections set draft_animation = 'nonsense' where id = ${rows[0]!.id}`;
    const now = await sectionsOf(page.id);
    const versions = await versionCount(page.id);

    const refused = answered(await publish(await pageBySlug("privacy")));
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, "invalid_motion");
    await untouched(page, now, versions);
  });

  test("…but not one on a section the layout is deleting anyway", async () => {
    // The row is going; refusing the page because of a value on it would be
    // strictness about something that will not exist.
    const page = await reset("disclaimer");
    const rows = await sectionsOf(page.id);
    const doomed = rows[rows.length - 1]!;
    await sql`update page_sections set draft_animation = 'nonsense' where id = ${doomed.id}`;
    answered(await structural("removePageSection", await pageBySlug("disclaimer"), { sectionId: String(doomed.id) }));

    const done = answered(await publish(await pageBySlug("disclaimer")));
    assert.equal(done.ok, true, JSON.stringify(done));
    assert.equal(await sectionById(doomed.id), null);
  });
});

/* -------------------------------------------------------------------------- */

describe("history is written by publication and by nothing else", () => {
  test("saving drafts writes no history at all", async () => {
    const page = await reset("terms");
    const rows = await sectionsOf(page.id);
    const before = await versionCount(page.id);

    // Every draft-saving action the editor has, several times over.
    for (let i = 0; i < 3; i += 1) {
      const section = (await sectionById(rows[0]!.id))!;
      const form = new FormData();
      form.set("_csrf", owner.csrfToken);
      form.set("sectionId", String(section.id));
      form.set("pageId", String(page.id));
      form.set("expectedRevision", String(section.revision));
      form.set("values", JSON.stringify({ ...section.published, title: { en: `Typing ${i}`, ar: "" } }));
      answered(await editorAction<{ ok: boolean }>("saveVisualSectionDraft", form));
    }
    const styled = (await sectionById(rows[1]!.id))!;
    const styleForm = new FormData();
    styleForm.set("_csrf", owner.csrfToken);
    styleForm.set("sectionId", String(styled.id));
    styleForm.set("pageId", String(page.id));
    styleForm.set("expectedRevision", String(styled.revision));
    styleForm.set("styles", JSON.stringify(styleDoc({})));
    answered(await editorAction<{ ok: boolean }>("saveVisualSectionStyles", styleForm));

    answered(await structural("reorderPageStructure", await pageBySlug("terms"), {
      order: JSON.stringify((await sectionsOf(page.id)).map((row) => row.id).reverse()),
    }));

    assert.ok((await sectionById(rows[0]!.id))!.revision > rows[0]!.revision, "no draft was saved");
    assert.equal(await versionCount(page.id), before, "saving a draft wrote a restore point");

    // …and one publication writes exactly one.
    assert.equal(answered(await publish(await pageBySlug("terms"))).ok, true);
    assert.equal(await versionCount(page.id), before + 1);
  });

  test("the restore point is the state *before* the publication, and says so", async () => {
    const page = await reset("privacy");
    const rows = await sectionsOf(page.id);
    const wasLive = (rows[0]!.published.title as { en: string } | undefined)?.en ?? "";
    await sql`update page_sections set draft = ${sql.json({ title: { en: "After", ar: "" } })}::jsonb where id = ${rows[0]!.id}`;

    assert.equal(answered(await publish(await pageBySlug("privacy"))).ok, true);

    const [version] = await versionsOf(page.id);
    assert.ok(version);
    assert.match(version.label, /Before publishing/);
    assert.ok(version.actor_name.length > 0, "the restore point has no actor");
    assert.equal(version.created_by, owner.userId);

    const [row] = await sql<{ snapshot: { sections: { published: Record<string, unknown> }[] } }[]>`
      select snapshot from page_versions where id = ${version.id}`;
    const snapshotTitle = (row!.snapshot.sections[0]!.published.title as { en: string } | undefined)?.en ?? "";
    assert.equal(snapshotTitle, wasLive, "the restore point recorded the state after publishing");
  });

  test("publishing one section from the ordinary admin writes one too", async () => {
    const page = await reset("terms");
    const section = (await sectionsOf(page.id))[0]!;
    await sql`update page_sections set draft = ${sql.json({ title: { en: "One section", ar: "" } })}::jsonb
               where id = ${section.id}`;
    const before = await versionCount(page.id);

    const form = new FormData();
    form.set("_csrf", owner.csrfToken);
    form.set("id", String(section.id));
    form.set("expectedRevision", String((await sectionById(section.id))!.revision));
    const published = answered(
      await callAction<{ ok: boolean; message?: string }>({
        origin: server.origin,
        route: `/admin/pages/section/${section.id}`,
        file: PAGE_ACTIONS,
        action: "publishSection",
        args: [{ ok: false }, form],
        cookie: owner.cookie,
      }),
    );
    assert.equal(published.ok, true, JSON.stringify(published));
    assert.equal(await versionCount(page.id), before + 1);
    const [version] = await versionsOf(page.id);
    assert.match(version!.label, /Before publishing the .* section/);
  });

  test("Save and publish writes one, and a refused one writes none", async () => {
    const page = await reset("privacy");
    const section = (await sectionsOf(page.id))[0]!;
    const before = await versionCount(page.id);

    const ok = new FormData();
    ok.set("_csrf", owner.csrfToken);
    ok.set("id", String(section.id));
    ok.set("expectedRevision", String(section.revision));
    ok.set("values", JSON.stringify({ ...section.published, title: { en: "Straight out", ar: "" } }));
    const done = answered(
      await callAction<{ ok: boolean }>({
        origin: server.origin,
        route: `/admin/pages/section/${section.id}`,
        file: PAGE_ACTIONS,
        action: "saveSectionAndPublish",
        args: [{ ok: false }, ok],
        cookie: owner.cookie,
      }),
    );
    assert.equal(done.ok, true);
    assert.equal(await versionCount(page.id), before + 1);

    // A stale revision is refused, and leaves history alone.
    const stale = new FormData();
    stale.set("_csrf", owner.csrfToken);
    stale.set("id", String(section.id));
    stale.set("expectedRevision", String(section.revision));
    stale.set("values", JSON.stringify({ ...section.published, title: { en: "Too late", ar: "" } }));
    const refused = answered(
      await callAction<{ ok: boolean }>({
        origin: server.origin,
        route: `/admin/pages/section/${section.id}`,
        file: PAGE_ACTIONS,
        action: "saveSectionAndPublish",
        args: [{ ok: false }, stale],
        cookie: owner.cookie,
      }),
    );
    assert.equal(refused.ok, false);
    assert.equal(await versionCount(page.id), before + 1, "a refused publish wrote history");
  });

  test("history is bounded, newest kept", async () => {
    const page = await reset("disclaimer");
    const section = (await sectionsOf(page.id))[0]!;
    for (let i = 0; i < KEEP_PAGE_VERSIONS + 4; i += 1) {
      await sql`update page_sections set draft = ${sql.json({ title: { en: `Round ${i}`, ar: "" } })}::jsonb
                 where id = ${section.id}`;
      assert.equal(answered(await publish(await pageBySlug("disclaimer"))).ok, true, `round ${i}`);
    }
    assert.equal(await versionCount(page.id), KEEP_PAGE_VERSIONS);
    const rows = await versionsOf(page.id);
    assert.equal(rows.length, KEEP_PAGE_VERSIONS);
    // The newest survives: it is the one anybody would reach for.
    const [row] = await sql<{ snapshot: { sections: { published: Record<string, unknown> }[] } }[]>`
      select snapshot from page_versions where id = ${rows[0]!.id}`;
    const title = (row!.snapshot.sections[0]!.published.title as { en: string }).en;
    assert.equal(title, `Round ${KEEP_PAGE_VERSIONS + 2}`);
  });

  test("the page-level publication is logged truthfully, and a refusal is not logged", async () => {
    const page = await reset("terms");
    const rows = await sectionsOf(page.id);
    await sql`update page_sections set draft = ${sql.json({ title: { en: "Logged", ar: "" } })}::jsonb where id = ${rows[0]!.id}`;
    const before = await logCount("page.changes_published");

    assert.equal(answered(await publish(await pageBySlug("terms"))).ok, true);
    assert.equal(await logCount("page.changes_published"), before + 1);

    const refused = answered(await publish({ id: page.id, revision: 0 }));
    assert.equal(refused.ok, false);
    assert.equal(await logCount("page.changes_published"), before + 1, "a refusal was logged as a publish");
  });
});

/* -------------------------------------------------------------------------- */

describe("restoring puts a published version back as drafts, never as the page", () => {
  /** Publish A, then B, and hand back the restore point holding A. */
  async function twoStates(slug: string) {
    const page = await reset(slug);
    const section = (await sectionsOf(page.id))[0]!;
    await sql`update page_sections set published = ${sql.json({ ...section.published, title: { en: "State A", ar: "" } })}::jsonb
               where id = ${section.id}`;
    await sql`update page_sections set draft = ${sql.json({ ...section.published, title: { en: "State B", ar: "" } })}::jsonb
               where id = ${section.id}`;
    assert.equal(answered(await publish(await pageBySlug(slug))).ok, true);
    const [version] = await versionsOf(page.id);
    return { page: await pageBySlug(slug), section, versionId: version!.id };
  }

  test("the central case: A, publish B, restore A, preview A, publish, A is live", async () => {
    const { page, section, versionId } = await twoStates("privacy");
    assert.ok((await live("privacy")).includes("State B"), "B is not live");

    const restored = answered(await restore(page, versionId));
    assert.equal(restored.ok, true, JSON.stringify(restored));

    // Nothing a visitor can see has changed…
    const html = await live("privacy");
    assert.ok(html.includes("State B"), "restoring changed the live page");
    assert.ok(!html.includes("State A"));
    assert.equal((await sectionById(section.id))!.is_published, true);
    assert.equal(((await sectionById(section.id))!.published.title as { en: string }).en, "State B");
    // …and the preview shows the historical state.
    assert.ok((await preview("privacy")).includes("State A"), "the preview is not showing the restore");

    const versions = await versionCount(page.id);
    assert.equal(answered(await publish(await pageBySlug("privacy"))).ok, true);
    assert.ok((await live("privacy")).includes("State A"), "publishing the restore did not land");
    // …and publishing the restore records the state it replaced.
    assert.equal(await versionCount(page.id), versions + 1);
    const [newest] = await versionsOf(page.id);
    const [row] = await sql<{ snapshot: { sections: { published: Record<string, unknown> }[] } }[]>`
      select snapshot from page_versions where id = ${newest!.id}`;
    assert.equal((row!.snapshot.sections[0]!.published.title as { en: string }).en, "State B");
  });

  test("a restore can be abandoned, and the page comes back clean", async () => {
    const { page, versionId } = await twoStates("terms");
    assert.equal(answered(await restore(page, versionId)).ok, true);
    assert.ok(answered(await summaryOf(page.id))!.discardable);

    assert.equal(answered(await discardAll(await pageBySlug("terms"))).ok, true);
    const summary = answered(await summaryOf(page.id));
    assert.equal(summary!.discardable, false, "the page is not clean after discarding a restore");
    assert.equal(summary!.publishable, false);
    assert.ok((await live("terms")).includes("State B"), "discarding a restore changed the live page");
  });

  test("a page with saved work refuses a restore rather than replacing it", async () => {
    const { section, versionId } = await twoStates("disclaimer");
    await sql`update page_sections set draft = ${sql.json({ title: { en: "Somebody's work", ar: "" } })}::jsonb
               where id = ${section.id}`;

    const refused = answered(await restore(await pageBySlug("disclaimer"), versionId));
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, "not_clean");
    assert.equal(
      ((await sectionById(section.id))!.draft!.title as { en: string }).en,
      "Somebody's work",
      "a refused restore overwrote a draft",
    );
    assert.equal((await pageBySlug("disclaimer")).draft_structure, null);
  });

  test("a version belonging to another page is refused", async () => {
    const mine = await twoStates("privacy");
    const other = await reset("terms");
    const refused = answered(await restore(other, mine.versionId));
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, "wrong_page");
    assert.equal((await pageBySlug("terms")).draft_structure, null);
  });

  test("a version that does not exist is refused", async () => {
    const page = await reset("terms");
    const refused = answered(await restore(page, 999_999));
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, "missing");
  });

  test("a snapshot this build cannot read is refused, not treated as an empty page", async () => {
    // The dangerous case: the tolerant reader turns this into "a page with no
    // sections", and restoring that stages the removal of everything.
    const { page, versionId } = await twoStates("about");
    await sql`update page_versions set snapshot = ${sql.json({ v: 9, sections: [] })}::jsonb
               where id = ${versionId}`;
    const rows = await sectionsOf(page.id);

    const refused = answered(await restore(await pageBySlug("about"), versionId));
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, "unsupported");
    assert.equal((await pageBySlug("about")).draft_structure, null, "an unsupported restore wrote a layout");
    assert.deepEqual((await sectionsOf(page.id)).map((row) => row.id), rows.map((row) => row.id));
  });

  test("a section deleted since the version comes back as a new pending row", async () => {
    const page = await reset("about");
    const rows = await sectionsOf(page.id);
    const doomed = rows[rows.length - 1]!;
    const blockType = doomed.block_type;

    answered(await structural("removePageSection", page, { sectionId: String(doomed.id) }));
    assert.equal(answered(await publish(await pageBySlug("about"))).ok, true);
    assert.equal(await sectionById(doomed.id), null);
    const [version] = await versionsOf(page.id);

    assert.equal(answered(await restore(await pageBySlug("about"), version!.id)).ok, true);
    const recreated = (await sectionsOf(page.id)).find((row) => row.is_draft_only);
    assert.ok(recreated, "the deleted section was not recreated");
    assert.equal(recreated.block_type, blockType);
    assert.notEqual(recreated.id, doomed.id, "the row came back under its old id");
    assert.equal(recreated.is_published, false);
    assert.ok(!orderOf(await live("about")).includes(blockType), "a recreated section reached a visitor");
    assert.ok(orderOf(await preview("about")).includes(blockType), "it is not in the preview");

    assert.equal(answered(await publish(await pageBySlug("about"))).ok, true);
    const established = (await sectionById(recreated.id))!;
    assert.equal(established.is_draft_only, false);
    assert.equal(established.is_published, true);
    assert.ok(orderOf(await live("about")).includes(blockType), "the restored section is not live");
  });

  test("a hidden section stays hidden through capture, restore and publication", async () => {
    // Snapshots record established *hidden* sections on purpose, so history is
    // the page's composition rather than the HTML a visitor happened to get.
    const page = await reset("privacy");
    const rows = await sectionsOf(page.id);
    const target = rows[1]!;
    await sql`update page_sections set is_published = false,
                     published = ${sql.json({ ...target.published, title: { en: "Hidden A", ar: "" } })}::jsonb
               where id = ${target.id}`;
    await sql`update page_sections set draft = ${sql.json({ ...target.published, title: { en: "Hidden B", ar: "" } })}::jsonb
               where id = ${target.id}`;
    assert.equal(answered(await publish(await pageBySlug("privacy"))).ok, true);
    assert.equal((await sectionById(target.id))!.is_published, false, "publishing content unhid a section");
    const [version] = await versionsOf(page.id);

    assert.equal(answered(await restore(await pageBySlug("privacy"), version!.id)).ok, true);
    assert.equal(answered(await publish(await pageBySlug("privacy"))).ok, true);

    const after = (await sectionById(target.id))!;
    assert.equal(after.is_published, false, "restoring a hidden section made it visible");
    assert.equal((after.published.title as { en: string }).en, "Hidden A");
  });

  test("a successful restore is logged as a restore, not as a publication", async () => {
    const { page, versionId } = await twoStates("terms");
    const before = await logCount("page.version_restored_to_draft");
    assert.equal(answered(await restore(page, versionId)).ok, true);
    assert.equal(await logCount("page.version_restored_to_draft"), before + 1);
  });

  test("a reader may read history and may not restore", async () => {
    const { page, versionId } = await twoStates("disclaimer");
    const history = answered(
      await callAction<{ versions: unknown[] } | null>({
        origin: server.origin,
        route: VE_ROUTE,
        file: VE_ACTIONS,
        action: "loadPageHistory",
        args: [page.id],
        cookie: viewer.cookie,
      }),
    );
    assert.ok(history && history.versions.length > 0, "a reader cannot see history");

    const refused = answered(await restore(page, versionId, viewer));
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, "denied");
  });
});

/* -------------------------------------------------------------------------- */

describe("discarding a page's saved changes leaves the live page alone", () => {
  test("every domain goes, pending rows go, and the layout goes", async () => {
    const page = await reset("about");
    const rows = await sectionsOf(page.id);
    const before = rows.map((row) => ({ id: row.id, published: row.published, is_published: row.is_published, position: row.position }));
    const html = await live("about");

    await sql`update page_sections set draft = ${sql.json({ title: { en: "Never", ar: "" } })}::jsonb where id = ${rows[0]!.id}`;
    await sql`update page_sections set draft_styles = ${sql.json(styleDoc({ root: { base: { align: "center" } } }))}::jsonb where id = ${rows[1]!.id}`;
    await sql`update page_sections set draft_animation = 'none' where id = ${rows[2]!.id}`;
    const added = answered(await structural("addPageSection", await pageBySlug("about"), { blockType: "stats" }));
    const pending = added.sectionId!;
    answered(
      await structural("removePageSection", await pageBySlug("about"), { sectionId: String(rows[0]!.id) }),
    );

    const done = answered(await discardAll(await pageBySlug("about")));
    assert.equal(done.ok, true, JSON.stringify(done));

    for (const row of await sectionsOf(page.id)) {
      assert.equal(row.draft, null, `section ${row.id} kept a content draft`);
      assert.equal(row.draft_styles, null, `section ${row.id} kept a style draft`);
      assert.equal(row.draft_animation, null, `section ${row.id} kept a motion draft`);
      assert.equal(row.is_draft_only, false, `section ${row.id} is still pending`);
    }
    assert.equal(await sectionById(pending), null, "a pending row survived the discard");
    assert.equal((await pageBySlug("about")).draft_structure, null);

    // Nothing a visitor sees moved.
    for (const row of before) {
      const after = (await sectionById(row.id))!;
      assert.deepEqual(after.published, row.published);
      assert.equal(after.is_published, row.is_published);
      assert.equal(after.position, row.position);
    }
    assert.deepEqual(orderOf(await live("about")), orderOf(html));
  });

  test("a page with nothing saved is refused", async () => {
    const page = await reset("privacy");
    const refused = answered(await discardAll(page));
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, "nothing");
  });

  test("a stale page revision is refused, and nothing is half-cleared", async () => {
    const page = await reset("terms");
    const rows = await sectionsOf(page.id);
    await sql`update page_sections set draft = ${sql.json({ title: { en: "Kept", ar: "" } })}::jsonb where id = ${rows[0]!.id}`;
    await sql`update page_sections set draft_styles = ${sql.json(styleDoc({}))}::jsonb where id = ${rows[1]!.id}`;

    const refused = answered(await discardAll({ id: page.id, revision: page.revision + 5 }));
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, "conflict");
    assert.ok((await sectionById(rows[0]!.id))!.draft, "a refused discard cleared a draft");
    assert.ok((await sectionById(rows[1]!.id))!.draft_styles, "a refused discard cleared a style draft");
  });

  test("it is logged, and it writes no restore point", async () => {
    const page = await reset("disclaimer");
    const rows = await sectionsOf(page.id);
    await sql`update page_sections set draft = ${sql.json({ title: { en: "Gone", ar: "" } })}::jsonb where id = ${rows[0]!.id}`;
    const versions = await versionCount(page.id);
    const before = await logCount("page.drafts_discarded");

    assert.equal(answered(await discardAll(await pageBySlug("disclaimer"))).ok, true);
    assert.equal(await logCount("page.drafts_discarded"), before + 1);
    // Nothing a visitor saw changed, so there is nothing to restore to.
    assert.equal(await versionCount(page.id), versions, "discarding wrote a restore point");
  });

  test("a layout draft nobody can read can still be discarded", async () => {
    const page = await reset("privacy");
    await sql`update pages set draft_structure = ${sql.json({ v: 1, sections: [{ sectionId: 1.5 }] })}::jsonb
               where id = ${page.id}`;
    const current = await pageBySlug("privacy");
    assert.equal(answered(await publish(current)).ok, false);
    assert.equal(answered(await discardAll(current)).ok, true);
    assert.equal((await pageBySlug("privacy")).draft_structure, null);
  });
});

/* -------------------------------------------------------------------------- */

describe("a visitor sees nothing until somebody publishes", () => {
  test("saving in all three domains and rearranging the page changes nothing public", async () => {
    const page = await reset("terms");
    const rows = await sectionsOf(page.id);
    const html = await live("terms");

    await sql`update page_sections set draft = ${sql.json({ title: { en: "Invisible", ar: "" } })}::jsonb where id = ${rows[0]!.id}`;
    await sql`update page_sections set draft_styles = ${sql.json(styleDoc({ root: { base: { opacity: 0.2 } } }))}::jsonb where id = ${rows[0]!.id}`;
    await sql`update page_sections set draft_animation = 'none' where id = ${rows[0]!.id}`;
    answered(await structural("reorderPageStructure", await pageBySlug("terms"), {
      order: JSON.stringify(rows.map((row) => row.id).reverse()),
    }));
    answered(await structural("addPageSection", await pageBySlug("terms"), { blockType: "rich-text" }));

    const after = await live("terms");
    // The composition, not the document: every response carries a fresh CSP
    // nonce, so comparing the whole page would be comparing the nonce.
    assert.deepEqual(orderOf(after), orderOf(html), "a saved layout reached a visitor");
    assert.ok(!after.includes("Invisible"), "a saved draft reached a visitor");
    assert.ok(!/opacity:\s*0\.2/.test(after), "a saved style reached a visitor");
    // …and the preview shows all of it.
    const previewed = await preview("terms");
    assert.ok(previewed.includes("Invisible"));
    assert.notDeepEqual(orderOf(previewed), orderOf(after));
  });

  test("the structural draft column is the only thing a layout edit writes", async () => {
    const page = await reset("disclaimer");
    const rows = await sectionsOf(page.id);
    answered(await structural("reorderPageStructure", page, {
      order: JSON.stringify(rows.map((row) => row.id).reverse()),
    }));
    for (const row of rows) {
      const after = (await sectionById(row.id))!;
      assert.equal(after.position, row.position, "a layout draft moved a live position");
      assert.equal(after.is_published, row.is_published, "a layout draft moved a live visibility");
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("the structure a publication seeds from is the page it just wrote", () => {
  test("after publishing, the layout draft is gone and seeds clean", async () => {
    const page = await reset("about");
    const rows = await sectionsOf(page.id);
    answered(await structural("reorderPageStructure", page, {
      order: JSON.stringify([rows[2]!.id, rows[0]!.id, rows[1]!.id, ...rows.slice(3).map((r) => r.id)]),
    }));
    assert.equal(answered(await publish(await pageBySlug("about"))).ok, true);

    assert.equal((await pageBySlug("about")).draft_structure, null);
    const summary = answered(await summaryOf(page.id));
    assert.equal(summary!.hasLayoutDraft, false);
    assert.equal(summary!.layoutChanged, false);
    assert.equal(summary!.publishable, false);

    const structure = answered(
      await callAction<{ structure: { sections: { sectionId: number }[] } } | null>({
        origin: server.origin,
        route: VE_ROUTE,
        file: VE_ACTIONS,
        action: "loadPageStructure",
        args: [page.id],
        cookie: owner.cookie,
      }),
    );
    assert.deepEqual(
      structure!.structure.sections.map((entry) => entry.sectionId),
      (await sectionsOf(page.id)).map((row) => row.id),
      "the seeded layout does not match the published page",
    );
  });

  test("a section untouched by a publication keeps its revision", async () => {
    const page = await reset("terms");
    const rows = await sectionsOf(page.id);
    await sql`update page_sections set draft = ${sql.json({ title: { en: "Only me", ar: "" } })}::jsonb where id = ${rows[0]!.id}`;
    const others = rows.slice(1).map((row) => ({ id: row.id, revision: row.revision }));

    assert.equal(answered(await publish(await pageBySlug("terms"))).ok, true);

    assert.equal((await sectionById(rows[0]!.id))!.revision, rows[0]!.revision + 1);
    for (const row of others) {
      assert.equal(
        (await sectionById(row.id))!.revision,
        row.revision,
        "publishing bumped a section it did not change",
      );
    }
  });

  test("a changed row moves exactly once, whatever changed about it", async () => {
    const page = await reset("privacy");
    const rows = await sectionsOf(page.id);
    const target = rows[1]!;
    await sql`update page_sections set draft = ${sql.json({ title: { en: "All at once", ar: "" } })}::jsonb,
                     draft_styles = ${sql.json(styleDoc({ root: { base: { align: "center" } } }))}::jsonb,
                     draft_animation = 'fade'
               where id = ${target.id}`;
    answered(
      await structural("setPageSectionVisibility", await pageBySlug("privacy"), {
        sectionId: String(target.id),
        visible: "false",
      }),
    );
    answered(await structural("reorderPageStructure", await pageBySlug("privacy"), {
      order: JSON.stringify([target.id, ...rows.filter((r) => r.id !== target.id).map((r) => r.id)]),
    }));
    const now = (await sectionById(target.id))!;

    assert.equal(answered(await publish(await pageBySlug("privacy"))).ok, true);
    assert.equal(
      (await sectionById(target.id))!.revision,
      now.revision + 1,
      "one publication moved one row's revision more than once",
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("the structural draft version is what this build writes", () => {
  test("a layout draft carries this build's version", async () => {
    await reset("terms");
    const page = await pageBySlug("terms");
    const rows = await sectionsOf(page.id);
    answered(await structural("reorderPageStructure", page, {
      order: JSON.stringify(rows.map((row) => row.id).reverse()),
    }));
    const stored = (await pageBySlug("terms")).draft_structure as { v: number };
    assert.equal(stored.v, DRAFT_STRUCTURE_VERSION);
  });
});

/* -------------------------------------------------------------------------- */

describe("a page-wide operation holds every row it reasons about", () => {
  /**
   * A second connection, used to hold a lock while an action runs.
   *
   * The races these tests are about are all of one shape: an operation reads a
   * page, decides something from what it read, and writes — and a save lands in
   * between. Reproducing that with timing would be a coin toss dressed up as a
   * test, so the gap is held open with a real database lock instead, and the
   * action genuinely blocks on it.
   */
  const barriers: Sql[] = [];
  after(async () => {
    for (const connection of barriers) await connection.end({ timeout: 5 }).catch(() => undefined);
  });

  type Held = {
    /** Let the holder finish: it runs its write, commits, and the lock is gone. */
    release: () => Promise<void>;
  };

  /**
   * Take `lock` on a second connection and return only once it is genuinely
   * held, so the operation under test is launched into a lock that already
   * exists rather than into a race to take one. `then` is the colleague's
   * write, committed in the same transaction the moment the hold is released.
   */
  async function hold(
    lock: (tx: Sql) => Promise<unknown>,
    then?: (tx: Sql) => Promise<unknown>,
  ): Promise<Held> {
    const connection = connect(database);
    barriers.push(connection);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    let acquired!: () => void;
    const locked = new Promise<void>((resolve) => {
      acquired = resolve;
    });
    let failure: unknown = null;
    const holding = connection
      .begin(async (tx) => {
        await lock(tx as unknown as Sql);
        acquired();
        await gate;
        if (then) await then(tx as unknown as Sql);
      })
      .catch((error: unknown) => {
        failure = error;
        acquired();
      });
    await locked;
    if (failure) throw failure;
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        open();
        await holding;
        if (failure) throw failure;
      },
    };
  }

  /** Wait until `n` backends are blocked on a lock — the deterministic barrier. */
  async function waitForBlocked(n: number): Promise<boolean> {
    for (let i = 0; i < 200; i += 1) {
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock'`;
      if ((row?.n ?? 0) >= n) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  }

  test("a restore blocked by a concurrent save sees the save and refuses", async () => {
    // The exact sequence Batch 10 claimed to prevent and did not: the restore
    // reads three null draft columns, concludes the page is clean, and an
    // autosave fills one in before it writes over the top.
    const page = await reset("privacy");
    const section = (await sectionsOf(page.id))[0]!;
    await sql`update page_sections set published = jsonb_set(published, '{title,en}', '"Historic"')
               where id = ${section.id}`;
    await sql`update page_sections set draft = ${sql.json({ title: { en: "Published", ar: "" } })}::jsonb
               where id = ${section.id}`;
    assert.equal(answered(await publish(await pageBySlug("privacy"))).ok, true);
    const [version] = await versionsOf(page.id);

    // Hold the section row, so the restore blocks the moment it tries to lock.
    const held = await hold(
      (tx) => tx`select id from page_sections where id = ${section.id} for update`,
      // The colleague's autosave, committed while the restore waits.
      (tx) => tx`update page_sections
                    set draft = ${sql.json({ title: { en: "Typed during the restore", ar: "" } })}::jsonb,
                        revision = revision + 1
                  where id = ${section.id}`,
    );

    const attempt = restore(await pageBySlug("privacy"), version!.id);
    let blocked = false;
    try {
      blocked = await waitForBlocked(1);
    } finally {
      await held.release();
    }

    const refused = answered(await attempt);
    assert.ok(blocked, "the restore did not block on the locked row");
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(!refused.ok && refused.reason, "not_clean");
    assert.equal(
      ((await sectionById(section.id))!.draft!.title as { en: string }).en,
      "Typed during the restore",
      "the restore overwrote a draft that was saved while it waited",
    );
    assert.equal((await pageBySlug("privacy")).draft_structure, null);
  });

  test("…and a save that arrives after a restore conflicts instead of winning", async () => {
    const page = await reset("terms");
    const section = (await sectionsOf(page.id))[0]!;
    await sql`update page_sections set draft = ${sql.json({ title: { en: "Published", ar: "" } })}::jsonb
               where id = ${section.id}`;
    assert.equal(answered(await publish(await pageBySlug("terms"))).ok, true);
    const [version] = await versionsOf(page.id);

    const stale = (await sectionById(section.id))!.revision;
    assert.equal(answered(await restore(await pageBySlug("terms"), version!.id)).ok, true);

    // The editor that was open before the restore names the old revision.
    const form = new FormData();
    form.set("_csrf", owner.csrfToken);
    form.set("sectionId", String(section.id));
    form.set("pageId", String(page.id));
    form.set("expectedRevision", String(stale));
    form.set("values", JSON.stringify({ title: { en: "Written against the old page", ar: "" } }));
    const refused = answered(
      await editorAction<{ ok: boolean; reason?: string }>("saveVisualSectionDraft", form),
    );
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "conflict");
  });

  test("a restore makes every re-interpreted section stale, removals included", async () => {
    /**
     * A section the historical layout leaves out is staged for removal, which
     * changes what it *is* as completely as new draft values would — so an
     * editor holding it must be told. It used to keep its revision, because
     * only the rows receiving draft values were bumped.
     */
    const page = await reset("about");
    const rows = await sectionsOf(page.id);
    const doomed = rows[rows.length - 1]!;

    // Publish a page without that section, so history holds a layout that
    // omits it and restoring stages its removal.
    answered(await structural("removePageSection", page, { sectionId: String(doomed.id) }));
    assert.equal(answered(await publish(await pageBySlug("about"))).ok, true);
    assert.equal(await sectionById(doomed.id), null);

    // Put it back and publish, so the current page has it again.
    const [withoutIt] = await versionsOf(page.id);
    assert.equal(answered(await restore(await pageBySlug("about"), withoutIt!.id)).ok, true);
    assert.equal(answered(await discardAll(await pageBySlug("about"))).ok, true);

    const current = await sectionsOf(page.id);
    const keeper = current[0]!;
    await sql`update page_sections set draft = ${sql.json({ title: { en: "New live", ar: "" } })}::jsonb
               where id = ${keeper.id}`;
    assert.equal(answered(await publish(await pageBySlug("about"))).ok, true);
    const [newest] = await versionsOf(page.id);

    const before = new Map((await sectionsOf(page.id)).map((row) => [row.id, row.revision]));
    assert.equal(answered(await restore(await pageBySlug("about"), newest!.id)).ok, true);

    for (const [id, revision] of before) {
      const after = (await sectionById(id))!;
      assert.equal(
        after.revision,
        revision + 1,
        `section ${id} did not become stale (was ${revision}, now ${after.revision})`,
      );
    }
    // …and exactly once. A recreated row is new and is not in `before`.
    const recreated = (await sectionsOf(page.id)).filter((row) => !before.has(row.id));
    for (const row of recreated) assert.equal(row.is_draft_only, true);
  });

  test("a discard blocked by a save deletes the row it actually read", async () => {
    const page = await reset("disclaimer");
    const added = answered(
      await structural("addPageSection", page, { blockType: "rich-text" }),
    );
    const pending = added.sectionId!;
    await sql`update page_sections set draft = ${sql.json({ body: { en: "First", ar: "" } })}::jsonb
               where id = ${pending}`;

    const held = await hold(
      (tx) => tx`select id from page_sections where id = ${pending} for update`,
      (tx) => tx`update page_sections
                    set draft = ${sql.json({ body: { en: "Second, while discarding", ar: "" } })}::jsonb,
                        revision = revision + 1
                  where id = ${pending}`,
    );

    const attempt = discardAll(await pageBySlug("disclaimer"));
    let blocked = false;
    try {
      blocked = await waitForBlocked(1);
    } finally {
      await held.release();
    }

    const done = answered(await attempt);
    assert.ok(blocked, "the discard did not block on the locked row");
    // Either outcome is coherent; what must not happen is a silent delete of a
    // revision the discard never reviewed.
    if (done.ok) {
      assert.equal(await sectionById(pending), null, "the pending row survived a successful discard");
    } else {
      assert.equal(!done.ok && done.reason, "conflict");
      assert.ok(await sectionById(pending), "a refused discard deleted the row anyway");
      assert.equal(
        ((await sectionById(pending))!.draft!.body as { en: string }).en,
        "Second, while discarding",
      );
    }
    assert.equal((await pageBySlug("disclaimer")).draft_structure, done.ok ? null : (await pageBySlug("disclaimer")).draft_structure);
  });

  test("…and a save that arrives after a discard finds the row gone", async () => {
    const page = await reset("disclaimer");
    const added = answered(await structural("addPageSection", page, { blockType: "rich-text" }));
    const pending = added.sectionId!;
    const row = (await sectionById(pending))!;

    assert.equal(answered(await discardAll(await pageBySlug("disclaimer"))).ok, true);
    assert.equal(await sectionById(pending), null);

    const form = new FormData();
    form.set("_csrf", owner.csrfToken);
    form.set("sectionId", String(pending));
    form.set("pageId", String(page.id));
    form.set("expectedRevision", String(row.revision));
    form.set("values", JSON.stringify({ body: { en: "Too late", ar: "" } }));
    const refused = answered(
      await editorAction<{ ok: boolean; reason?: string }>("saveVisualSectionDraft", form),
    );
    assert.equal(refused.ok, false);
    assert.equal(refused.reason, "missing");
    assert.equal(await sectionById(pending), null, "a refused save resurrected the row");
  });

  test("two sections publishing at once produce linear history, never two copies of A", async () => {
    /**
     * The defect this exists for: both transactions snapshot the live page
     * before either writes, so history holds the same state twice and there is
     * no restore point for the one in between. The page row is the
     * serialisation point — taken before the snapshot, by every path that
     * writes one.
     */
    const page = await reset("about");
    const rows = await sectionsOf(page.id);
    const [x, y] = rows;
    assert.ok(x && y);

    await sql`update page_sections set published = jsonb_set(published, '{title,en}', '"A-x"') where id = ${x.id}`;
    await sql`update page_sections set published = jsonb_set(published, '{title,en}', '"A-y"') where id = ${y.id}`;
    await sql`update page_sections set draft = ${sql.json({ title: { en: "B-x", ar: "" } })}::jsonb where id = ${x.id}`;
    await sql`update page_sections set draft = ${sql.json({ title: { en: "B-y", ar: "" } })}::jsonb where id = ${y.id}`;
    const fresh = await sectionsOf(page.id);
    const revisionOf = new Map(fresh.map((row) => [row.id, row.revision]));

    const publishOne = (id: number) => {
      const form = new FormData();
      form.set("_csrf", owner.csrfToken);
      form.set("id", String(id));
      form.set("expectedRevision", String(revisionOf.get(id)));
      return callAction<{ ok: boolean; message?: string }>({
        origin: server.origin,
        route: `/admin/pages/section/${id}`,
        file: PAGE_ACTIONS,
        action: "publishSection",
        args: [{ ok: false }, form],
        cookie: owner.cookie,
      });
    };

    // Hold the page row, so both publications queue behind it rather than
    // racing each other to the snapshot.
    const held = await hold((tx) => tx`select id from pages where id = ${page.id} for update`);

    const both = Promise.all([publishOne(x.id), publishOne(y.id)]);
    let blocked = false;
    try {
      blocked = await waitForBlocked(2);
    } finally {
      await held.release();
    }

    const [first, second] = await both;
    assert.ok(blocked, "both publications did not block on the page row");
    assert.equal(answered(first).ok, true, JSON.stringify(answered(first)));
    assert.equal(answered(second).ok, true, JSON.stringify(answered(second)));

    // Both went live…
    assert.equal(((await sectionById(x.id))!.published.title as { en: string }).en, "B-x");
    assert.equal(((await sectionById(y.id))!.published.title as { en: string }).en, "B-y");

    // …and history is a chain, not two copies of where it started.
    const history = await versionsOf(page.id);
    assert.equal(history.length, 2, `${history.length} restore points`);
    const titles = await Promise.all(
      history.map(async (version) => {
        const [row] = await sql<{ snapshot: { sections: { sourceSectionId: number; published: Record<string, unknown> }[] } }[]>`
          select snapshot from page_versions where id = ${version.id}`;
        const find = (id: number) =>
          (row!.snapshot.sections.find((entry) => entry.sourceSectionId === id)?.published.title as
            | { en: string }
            | undefined)?.en ?? "";
        return { x: find(x.id), y: find(y.id) };
      }),
    );
    // Newest first: the second publication saw the first one's result.
    const [newer, older] = titles;
    assert.deepEqual(older, { x: "A-x", y: "A-y" }, "the older restore point is not the starting state");
    assert.ok(
      (newer!.x === "B-x" && newer!.y === "A-y") || (newer!.x === "A-x" && newer!.y === "B-y"),
      `the newer restore point is not the intermediate state: ${JSON.stringify(newer)}`,
    );
    assert.notDeepEqual(newer, older, "history holds the same state twice");
  });
});

/* -------------------------------------------------------------------------- */

describe("a publication says what actually happened to the page it names", () => {
  test("a published page is told its changes are live", async () => {
    const page = await reset("terms");
    assert.equal((await sql<{ is_published: boolean }[]>`
      select is_published from pages where id = ${page.id}`)[0]!.is_published, true);
    const rows = await sectionsOf(page.id);
    await sql`update page_sections set draft = ${sql.json({ title: { en: "Live now", ar: "" } })}::jsonb
               where id = ${rows[0]!.id}`;

    const done = answered(await publish(await pageBySlug("terms")));
    assert.equal(done.ok, true);
    assert.match(done.ok ? done.message : "", /saved changes are live now/i);
  });

  test("an unpublished page is not told it is live, because it is not", async () => {
    // `pages.is_published` is page settings and this action never touches it,
    // so the old unconditional "the page is live now" sent an editor looking
    // for a page a visitor cannot reach.
    const page = await reset("disclaimer");
    await sql`update pages set is_published = false where id = ${page.id}`;
    const rows = await sectionsOf(page.id);
    await sql`update page_sections set draft = ${sql.json({ title: { en: "Still hidden", ar: "" } })}::jsonb
               where id = ${rows[0]!.id}`;

    const done = answered(await publish(await pageBySlug("disclaimer")));
    assert.equal(done.ok, true);
    assert.ok(!/is live now/i.test(done.ok ? done.message : ""), done.ok ? done.message : "");
    assert.match(done.ok ? done.message : "", /still unpublished/i);

    // …and the setting itself is untouched.
    assert.equal((await sql<{ is_published: boolean }[]>`
      select is_published from pages where id = ${page.id}`)[0]!.is_published, false);
    await sql`update pages set is_published = true where id = ${page.id}`;
  });
});

/* -------------------------------------------------------------------------- */

describe("a reader may see a page's history and may not change anything", () => {
  test("the Pages screen shows history to a content.view user", async () => {
    const page = await reset("privacy");
    const rows = await sectionsOf(page.id);
    await sql`update page_sections set draft = ${sql.json({ title: { en: "For history", ar: "" } })}::jsonb
               where id = ${rows[0]!.id}`;
    assert.equal(answered(await publish(await pageBySlug("privacy"))).ok, true);

    const screen = await get(server.origin, "/admin/pages/privacy", { cookie: viewer.cookie });
    assert.equal(screen.status, 200);
    assert.match(screen.html, /Version history/, "a reader cannot see the history section");
    assert.match(screen.html, /Current live/);
    assert.match(screen.html, /Before publishing/, "no restore point is listed");

    // …and nothing that would change anything.
    assert.ok(!/Restore to draft/.test(screen.html), "a reader was offered Restore");
    assert.ok(!/Publish saved changes/.test(screen.html), "a reader was offered Publish");
    assert.ok(!/Discard all saved changes/.test(screen.html), "a reader was offered Discard");
  });

  test("…and the actions refuse that user directly", async () => {
    const page = await pageBySlug("privacy");
    const [version] = await versionsOf(page.id);
    for (const [action, extra] of [
      ["publishPageFromEditor", {}],
      ["discardPageFromEditor", {}],
      ["restoreVersionFromEditor", { versionId: String(version!.id) }],
    ] as const) {
      const refused = answered(
        await editorAction<PageActionResult>(action, pageForm(page, viewer, extra), viewer),
      );
      assert.equal(refused.ok, false, action);
      assert.equal(!refused.ok && refused.reason, "denied", action);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("a section screen is told what it wrote", () => {
  /**
   * The normal Admin section editor has to be authoritative for its *next*
   * action: the revision it submits is the one it was built with, so if it
   * never learns the new one, the next save is refused as a conflict by a
   * screen that had just saved successfully.
   *
   * It used to learn it only from the page Next re-renders as part of the
   * action's response — and that tree is applied best-effort. When the router
   * dropped it, it dropped the action's own returned state with it, so
   * `useActionState` never fired at all: two to seven of twelve consecutive
   * saves, measured, with the server having rendered the right revision twice
   * each time. Two things changed. The write's answer now carries the row, and
   * the revalidation that was poisoning that answer happens in `after()`, once
   * the response has already gone.
   *
   * What is asserted here is the first half — the answer itself. The second is
   * `admin-section.mts`, which drives the real screen.
   */
  const sectionForm = (
    session: TestSession,
    values: Record<string, string>,
  ) => {
    const form = new FormData();
    form.set("_csrf", session.csrfToken);
    for (const [key, value] of Object.entries(values)) form.set(key, value);
    return form;
  };

  const sectionAction = (action: string, form: FormData, session = owner) =>
    callAction<{
      ok: boolean;
      message?: string;
      section?: {
        revision: number;
        draftKind: string;
        animation: string;
        isDraftOnly: boolean;
        values?: Record<string, unknown>;
      };
    }>({
      origin: server.origin,
      route: "/admin/pages/section/1",
      file: PAGE_ACTIONS,
      action,
      args: [{ ok: false }, form],
      cookie: session.cookie,
    });

  test("a draft save answers with the row it just wrote", async () => {
    const page = await reset("privacy");
    const [section] = await sectionsOf(page.id);
    const before = section!.revision;

    const saved = answered(
      await sectionAction(
        "saveSectionDraft",
        sectionForm(owner, {
          id: String(section!.id),
          expectedRevision: String(before),
          values: JSON.stringify({ title: { en: "Told to the screen", ar: "" } }),
        }),
      ),
    );
    assert.equal(saved.ok, true, saved.message);
    assert.ok(saved.section, "the answer carried no row");
    assert.equal(saved.section!.revision, before + 1, "the answer named the old revision");
    assert.equal(saved.section!.draftKind, "content");
    assert.equal(saved.section!.isDraftOnly, false);
    assert.ok(!saved.section!.values, "a save must not replace the fields");

    // …and the revision it named is the one the next write must use.
    const again = answered(
      await sectionAction(
        "saveSectionDraft",
        sectionForm(owner, {
          id: String(section!.id),
          expectedRevision: String(saved.section!.revision),
          values: JSON.stringify({ title: { en: "And again", ar: "" } }),
        }),
      ),
    );
    assert.equal(again.ok, true, again.message);
    assert.equal(again.section!.revision, before + 2);
  });

  test("the revision it named is the only one the next write accepts", async () => {
    const page = await reset("terms");
    const [section] = await sectionsOf(page.id);
    const before = section!.revision;
    const saved = answered(
      await sectionAction(
        "saveSectionDraft",
        sectionForm(owner, {
          id: String(section!.id),
          expectedRevision: String(before),
          values: JSON.stringify({ title: { en: "First", ar: "" } }),
        }),
      ),
    );
    assert.equal(saved.ok, true);

    // Submitting the revision the screen was *built* with — what a screen that
    // never learned the answer would send.
    const stale = answered(
      await sectionAction(
        "saveSectionDraft",
        sectionForm(owner, {
          id: String(section!.id),
          expectedRevision: String(before),
          values: JSON.stringify({ title: { en: "Second", ar: "" } }),
        }),
      ),
    );
    assert.equal(stale.ok, false, "a stale revision was accepted");
    const [row] = await sql<{ draft: { title?: { en?: string } } | null }[]>`
      select draft from page_sections where id = ${section!.id}`;
    assert.equal(row!.draft?.title?.en, "First", "the refused write landed anyway");
  });

  test("a discard answers with the values the fields must go back to", async () => {
    const page = await reset("disclaimer");
    const [section] = await sectionsOf(page.id);
    const published = (
      await sql<{ published: { title?: { en?: string } } }[]>`
        select published from page_sections where id = ${section!.id}`
    )[0]!.published;

    const saved = answered(
      await sectionAction(
        "saveSectionDraft",
        sectionForm(owner, {
          id: String(section!.id),
          expectedRevision: String(section!.revision),
          values: JSON.stringify({ title: { en: "Thought better of", ar: "" } }),
        }),
      ),
    );
    assert.equal(saved.ok, true, saved.message);

    const discarded = answered(
      await sectionAction(
        "discardDraft",
        sectionForm(owner, {
          id: String(section!.id),
          expectedRevision: String(saved.section!.revision),
        }),
      ),
    );
    assert.equal(discarded.ok, true, discarded.message);
    assert.equal(discarded.section!.draftKind, "none");
    assert.ok(discarded.section!.values, "a discard must hand the fields back their values");
    assert.equal(
      (discarded.section!.values!.title as { en?: string } | undefined)?.en,
      published.title?.en,
      "the fields would have kept the discarded wording",
    );
  });

  test("a publication answers with a row that has nothing waiting", async () => {
    const page = await reset("about");
    const [section] = await sectionsOf(page.id);
    const saved = answered(
      await sectionAction(
        "saveSectionAndPublish",
        sectionForm(owner, {
          id: String(section!.id),
          expectedRevision: String(section!.revision),
          values: JSON.stringify({ title: { en: "Straight out", ar: "" } }),
        }),
      ),
    );
    assert.equal(saved.ok, true, saved.message);
    assert.equal(saved.section!.draftKind, "none");
    assert.equal(saved.section!.revision, section!.revision + 1);
    assert.match(saved.message ?? "", /live now|published/i);
  });

  test("a refused write answers with no row at all", async () => {
    const page = await reset("privacy");
    const [section] = await sectionsOf(page.id);
    const refused = answered(
      await sectionAction(
        "saveSectionDraft",
        sectionForm(owner, {
          id: String(section!.id),
          expectedRevision: String(section!.revision + 99),
          values: JSON.stringify({ title: { en: "Nope", ar: "" } }),
        }),
      ),
    );
    assert.equal(refused.ok, false);
    assert.ok(!refused.section, "a refusal must not move the screen on");
  });
});
