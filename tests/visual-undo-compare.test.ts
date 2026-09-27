/**
 * Undo, Redo and Version Compare against a running server (Batch 16).
 *
 * The pure rules live in `tests/undo-history.test.ts` and
 * `tests/version-compare.test.ts`. What only a server can answer is here:
 *
 *   · an Undo is an ordinary save — the same action, the same revision guard,
 *     a revision at a time, and a stale one is refused as a conflict, which is
 *     what makes the editor throw its history away;
 *   · a layout Undo is an ordinary structural operation, and the one thing
 *     Batch 16 added to them — putting a removed section back *exactly* where
 *     it was, the way it was — is guarded like every other;
 *   · a comparison is read-only, private, never indexed, only ever this page's
 *     own history, only for someone who may read the page's history, and drawn
 *     by the real site, at rest, from published values and never a draft.
 *
 * Numbers in the test names are the Batch 16 brief's §56 and §57 items.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { callAction, type ActionResponse } from "./helpers/action";
import { giveFresh } from "./helpers/fixtures";
import { get } from "./helpers/http";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { BUILD_HINT, isBuilt, startServer, type Server } from "./helpers/server";
import { signIn, type TestSession } from "./helpers/session";

import type { PageStructure } from "@/lib/cms/structure";
import { DYNAMIC_DISCLAIMER, GLOBAL_DISCLAIMER, MEDIA_DISCLAIMER } from "@/lib/visual-editor/compare";
import type { VisualStructureResult } from "@/lib/visual-editor/content";
import type { PageActionResult } from "@/lib/visual-editor/publish";

const PORT = 3451;
const VE_ACTIONS = "app/(backoffice)/admin/visual-editor/actions.ts";
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
};

const row = async (id: number): Promise<SectionRow> => {
  const [found] = await sql<SectionRow[]>`
    select id, page_id, revision, block_type, draft, published from page_sections where id = ${id}`;
  assert.ok(found, `section ${id} is missing`);
  return found;
};
const pageBySlug = async (slug: string) => {
  const [found] = await sql<{ id: number; slug: string; revision: number }[]>`
    select id, slug, revision from pages where slug = ${slug}`;
  assert.ok(found, `no page ${slug}`);
  return found;
};
const sectionOf = async (slug: string, blockType: string): Promise<SectionRow> => {
  const page = await pageBySlug(slug);
  const [found] = await sql<{ id: number }[]>`
    select id from page_sections where page_id = ${page.id} and block_type = ${blockType} order by position limit 1`;
  assert.ok(found, `no ${blockType} on /${slug}`);
  return row(found.id);
};
async function reset(slug: string) {
  const page = await pageBySlug(slug);
  await sql`delete from page_sections where page_id = ${page.id}`;
  await sql`insert into page_sections select * from eodt_sections_backup where page_id = ${page.id}`;
  await sql`update pages set draft_structure = null, revision = revision + 1 where id = ${page.id}`;
  await sql`delete from page_versions where page_id = ${page.id}`;
  return pageBySlug(slug);
}
function answered<T>(response: ActionResponse<T>): T {
  assert.ok(response.value, `the action returned nothing (status ${response.status})`);
  return response.value;
}

type SaveResult = { ok: boolean; reason?: string; section?: { revision: number; values: Record<string, unknown> } };
function saveContent(section: { id: number; page_id: number }, revision: number, values: Record<string, unknown>) {
  const form = new FormData();
  form.set("_csrf", owner.csrfToken);
  form.set("sectionId", String(section.id));
  form.set("pageId", String(section.page_id));
  form.set("expectedRevision", String(revision));
  form.set("values", JSON.stringify(values));
  return callAction<SaveResult>({
    origin: server.origin,
    route: VE_ROUTE,
    file: VE_ACTIONS,
    action: "saveVisualSectionDraft",
    args: [form],
    cookie: owner.cookie,
  });
}

function structural(
  action: string,
  page: { id: number; revision: number },
  fields: Record<string, string | number> = {},
  as: TestSession = owner,
) {
  const form = new FormData();
  form.set("_csrf", as.csrfToken);
  form.set("pageId", String(page.id));
  form.set("expectedRevision", String(page.revision));
  for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
  return callAction<VisualStructureResult>({
    origin: server.origin,
    route: VE_ROUTE,
    file: VE_ACTIONS,
    action,
    args: [form],
    cookie: as.cookie,
  });
}

const pageForm = (page: { id: number; revision: number }, extra: Record<string, string> = {}) => {
  const form = new FormData();
  form.set("_csrf", owner.csrfToken);
  form.set("pageId", String(page.id));
  form.set("expectedRevision", String(page.revision));
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return form;
};
const editorAction = <T>(action: string, form: FormData) =>
  callAction<T>({ origin: server.origin, route: VE_ROUTE, file: VE_ACTIONS, action, args: [form], cookie: owner.cookie });
const publish = async (slug: string) =>
  answered(await editorAction<PageActionResult>("publishPageFromEditor", pageForm(await pageBySlug(slug))));

/** The draft layout, in order, as `[id, visible]` pairs. */
const layout = (structure: PageStructure | null) =>
  (structure?.structure.sections ?? []).map((entry) => [entry.sectionId, entry.visible] as const);

/** The HTML before the streamed flight payload, which quotes attributes back. */
const markup = (html: string) => {
  const at = html.search(/<script[^>]*>\s*\(?self\.__next_f/);
  return at < 0 ? html : html.slice(0, at);
};
const count = (html: string, needle: string) => markup(html).split(needle).length - 1;

/** A comparison pane, with its headers. */
async function pane(path: string, cookie?: string) {
  const response = await fetch(`${server.origin}${path}`, {
    headers: cookie ? { cookie } : {},
    redirect: "manual",
  });
  return {
    status: response.status,
    robots: response.headers.get("x-robots-tag"),
    cache: response.headers.get("cache-control"),
    html: await response.text(),
  };
}

/**
 * Everything a comparison could conceivably write to, as text: pages, their
 * sections, their history and the activity log. Sessions are left out — a
 * signed-in request may refresh its own session's last-seen time, which is the
 * session's business and not the page's.
 */
async function fingerprint(): Promise<string> {
  const [state] = await sql<{ pages: string; sections: string; versions: string; activity: string }[]>`
    select
      (select coalesce(json_agg(p order by p.id)::text, '') from pages p) as pages,
      (select coalesce(json_agg(s order by s.id)::text, '') from page_sections s) as sections,
      (select coalesce(json_agg(v order by v.id)::text, '') from page_versions v) as versions,
      (select count(*)::text || ':' || coalesce(max(id), 0)::text from activity_logs) as activity`;
  return JSON.stringify(state);
}

before(async () => {
  assert.ok(isBuilt(), BUILD_HINT);
  database = giveFresh("visual_undo_compare");
  sql = connect(database);
  owner = await signIn(sql);
  await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    select 'viewer@test.invalid', 'Read Only', 'unused', id, true
      from roles where key = 'viewer'
  `;
  viewer = await signIn(sql, "viewer");
  await sql`create table eodt_sections_backup as select * from page_sections`;
  server = await startServer(database, PORT);
});

after(async () => {
  await server?.stop();
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
});

/* ========================================================================== */
/* Undo is an ordinary save                                                   */
/* ========================================================================== */

describe("20–22 · an Undo reaches the server as an ordinary save, a revision at a time", () => {
  test("typed → autosaved → undone → redone: every step is the same save action, guarded", async () => {
    await reset("about");
    const text = await sectionOf("about", "rich-text");
    const versionsBefore = (await sql<{ n: number }[]>`select count(*)::int as n from page_versions`)[0]!.n;
    const original = text.published;
    const title = original.title as { en: string; ar: string };
    const typed = { ...original, title: { ...title, en: `${title.en} plus` } };

    // The edit, autosaved.
    const first = answered(await saveContent(text, text.revision, typed));
    assert.equal(first.ok, true, JSON.stringify(first));
    const afterEdit = await row(text.id);
    assert.equal(afterEdit.revision, text.revision + 1);
    assert.deepEqual(afterEdit.draft?.title, typed.title);

    // Undo: the earlier values, saved on top — the draft moves on, a revision later.
    const undone = answered(await saveContent(text, afterEdit.revision, original));
    assert.equal(undone.ok, true, JSON.stringify(undone));
    const afterUndo = await row(text.id);
    assert.equal(afterUndo.revision, afterEdit.revision + 1);
    assert.deepEqual(afterUndo.draft?.title, original.title);

    // Save now at the undone state is the same call, and changes nothing more.
    // Redo: the edit again.
    const redone = answered(await saveContent(text, afterUndo.revision, typed));
    assert.equal(redone.ok, true);
    const afterRedo = await row(text.id);
    assert.equal(afterRedo.revision, afterUndo.revision + 1);
    assert.deepEqual(afterRedo.draft?.title, typed.title);

    // Nothing was published and nothing went into Version History.
    assert.deepEqual((await row(text.id)).published, original);
    assert.equal((await sql<{ n: number }[]>`select count(*)::int as n from page_versions`)[0]!.n, versionsBefore);
  });

  test("31 · an Undo computed against a revision that moved elsewhere is refused as a conflict", async () => {
    await reset("about");
    const text = await sectionOf("about", "rich-text");
    const title = text.published.title as { en: string; ar: string };
    const edited = { ...text.published, title: { ...title, en: "Somebody else" } };
    assert.equal(answered(await saveContent(text, text.revision, edited)).ok, true);
    // This editor's Undo still names the old revision.
    const stale = answered(await saveContent(text, text.revision, text.published));
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, "conflict");
    assert.deepEqual((await row(text.id)).draft?.title, edited.title, "the other editor's work survived");
  });
});

/* ========================================================================== */
/* Layout Undo: the structure service's own operations                        */
/* ========================================================================== */

describe("23–30 · a layout Undo is one of the structure service's own operations", () => {
  test("23–24 · a reorder and its Undo and Redo are reorders, each guarded on the page revision", async () => {
    let page = await reset("about");
    const ids = (await sql<{ id: number }[]>`select id from page_sections where page_id = ${page.id} order by position`).map((r) => r.id);
    const moved = [ids[1]!, ids[0]!, ...ids.slice(2)];
    const one = answered(await structural("reorderPageStructure", page, { order: JSON.stringify(moved) }));
    assert.equal(one.ok, true);
    page = await pageBySlug("about");
    const back = answered(await structural("reorderPageStructure", page, { order: JSON.stringify(ids) }));
    assert.equal(back.ok, true);
    assert.deepEqual(layout(back.ok ? back.structure : null).map(([id]) => id), ids);
    // A Redo that names the revision before the Undo is refused, not replayed.
    const stale = answered(await structural("reorderPageStructure", page, { order: JSON.stringify(moved) }));
    assert.equal(stale.ok, false);
    assert.equal(stale.ok ? null : stale.reason, "conflict");
  });

  test("29 · remove Undo puts the section back exactly where it was, and hidden if it was hidden", async () => {
    let page = await reset("about");
    const ids = (await sql<{ id: number }[]>`select id from page_sections where page_id = ${page.id} order by position`).map((r) => r.id);
    const target = ids[2]!;
    // Hidden first, then removed.
    assert.equal(answered(await structural("setPageSectionVisibility", page, { sectionId: target, visible: "false" })).ok, true);
    page = await pageBySlug("about");
    assert.equal(answered(await structural("removePageSection", page, { sectionId: target })).ok, true);
    page = await pageBySlug("about");
    const restored = answered(
      await structural("restorePageSection", page, {
        sectionId: target,
        placement: "1",
        beforeSectionId: ids[3]!,
        visible: "false",
      }),
    );
    assert.equal(restored.ok, true, JSON.stringify(restored));
    const sections = layout(restored.ok ? restored.structure : null);
    assert.deepEqual(sections.map(([id]) => id), ids, "back in its own place");
    assert.deepEqual(sections[2], [target, false], "and still hidden");
  });

  test("27 · add Undo leaves the new row pending; Redo puts the very same row back, with its content, at the end", async () => {
    let page = await reset("about");
    const added = answered(await structural("addPageSection", page, { blockType: "rich-text" }));
    assert.equal(added.ok, true);
    const id = added.ok ? added.sectionId! : 0;
    const [fresh] = await sql<{ id: number; page_id: number; revision: number }[]>`
      select id, page_id, revision from page_sections where id = ${id}`;
    const words = { eyebrow: { en: "", ar: "" }, title: { en: "Added and kept", ar: "" }, body: { en: "<p>Kept.</p>", ar: "" } };
    assert.equal(answered(await saveContent(fresh!, fresh!.revision, words)).ok, true);

    page = await pageBySlug("about");
    const removed = answered(await structural("removePageSection", page, { sectionId: id }));
    assert.equal(removed.ok, true);
    assert.ok(!layout(removed.ok ? removed.structure : null).some(([sectionId]) => sectionId === id));
    assert.ok((await sql`select 1 from page_sections where id = ${id}`).length === 1, "the pending row was deleted");

    page = await pageBySlug("about");
    const redone = answered(
      await structural("restorePageSection", page, { sectionId: id, placement: "1", beforeSectionId: "end", visible: "true" }),
    );
    assert.equal(redone.ok, true, JSON.stringify(redone));
    const sections = layout(redone.ok ? redone.structure : null);
    assert.deepEqual(sections[sections.length - 1], [id, true]);
    assert.deepEqual((await row(id)).draft?.title, words.title, "the content came back with the row");
  });

  test("a placement is refused when it names a section outside the layout, or cannot be read", async () => {
    let page = await reset("about");
    const ids = (await sql<{ id: number }[]>`select id from page_sections where page_id = ${page.id} order by position`).map((r) => r.id);
    assert.equal(answered(await structural("removePageSection", page, { sectionId: ids[1]! })).ok, true);
    page = await pageBySlug("about");
    const home = await pageBySlug("home");
    const [foreign] = await sql<{ id: number }[]>`select id from page_sections where page_id = ${home.id} limit 1`;

    const outsider = answered(
      await structural("restorePageSection", page, { sectionId: ids[1]!, placement: "1", beforeSectionId: foreign!.id, visible: "true" }),
    );
    assert.equal(outsider.ok, false);
    assert.match(outsider.ok ? "" : outsider.message, /not in the layout you are editing/);

    const malformed: Record<string, string>[] = [
      { beforeSectionId: "abc", visible: "true" },
      { beforeSectionId: String(ids[2]!), visible: "maybe" },
      { beforeSectionId: "-4", visible: "true" },
      { visible: "true" },
    ];
    for (const fields of malformed) {
      const refused = answered(await structural("restorePageSection", page, { sectionId: ids[1]!, placement: "1", ...fields }));
      assert.equal(refused.ok, false, JSON.stringify(fields));
      assert.equal(refused.ok ? null : refused.reason, "invalid");
    }
    assert.equal((await pageBySlug("about")).revision, page.revision, "a refused placement moved nothing");

    // Stale revision: a conflict, like every other layout write.
    const stale = answered(
      await structural(
        "restorePageSection",
        { id: page.id, revision: page.revision - 1 },
        { sectionId: ids[1]!, placement: "1", beforeSectionId: "end", visible: "true" },
      ),
    );
    assert.equal(stale.ok ? null : stale.reason, "conflict");

    // And only somebody who may edit the page may do it at all.
    const denied = answered(
      await structural("restorePageSection", page, { sectionId: ids[1]!, placement: "1", beforeSectionId: "end", visible: "true" }, viewer),
    );
    assert.equal(denied.ok, false);
    assert.equal(denied.ok ? null : denied.reason, "denied");
  });
});

/* ========================================================================== */
/* Version Compare                                                            */
/* ========================================================================== */

describe("Version Compare: this page's own history, read-only, private, drawn at rest", () => {
  let aboutId = 0;
  let v1 = 0;
  let homeVersion = 0;
  let unreadable = 0;
  let v1Title = "";
  let publishedTitle = "";
  const DRAFT_TITLE = "Draft only — never in a comparison";

  before(async () => {
    const about = await reset("about");
    aboutId = about.id;
    const text = await sectionOf("about", "rich-text");
    const title = text.published.title as { en: string; ar: string };
    v1Title = title.en;
    // Not containing the version's title, so "shows one and not the other" can be asked.
    publishedTitle = "Republished heading for the comparison";
    assert.ok(!publishedTitle.includes(v1Title) && !v1Title.includes(publishedTitle));

    // Publication 1 writes version v1: the state before it, i.e. the seed.
    const changed = { ...text.published, title: { ...title, en: publishedTitle } };
    assert.equal(answered(await saveContent(text, text.revision, changed)).ok, true);
    assert.equal((await publish("about")).ok, true);
    [{ id: v1 }] = await sql<{ id: number }[]>`select id from page_versions where page_id = ${aboutId} order by id desc limit 1`;

    // A draft on top of the published page — which the comparison must never show.
    const now = await row(text.id);
    const drafted = { ...now.published, title: { ...(now.published.title as object), en: DRAFT_TITLE } };
    assert.equal(answered(await saveContent(now, now.revision, drafted)).ok, true);

    // A version of another page.
    await reset("home");
    const hero = await sectionOf("home", "hero");
    const headline = hero.published.headline as { en: string; ar: string };
    assert.equal(
      answered(await saveContent(hero, hero.revision, { ...hero.published, headline: { ...headline, en: `${headline.en}!` } })).ok,
      true,
    );
    assert.equal((await publish("home")).ok, true);
    [{ id: homeVersion }] = await sql<{ id: number }[]>`select id from page_versions where page_id = (select id from pages where slug = 'home') order by id desc limit 1`;

    // A snapshot this build cannot read.
    [{ id: unreadable }] = await sql<{ id: number }[]>`
      insert into page_versions (page_id, label, snapshot, actor_name)
      values (${aboutId}, 'From the future', ${sql.json({ v: 99, sections: [] })}, 'Test')
      returning id`;
  });

  const screen = (query: string, cookie = owner.cookie) => get(server.origin, `/admin/compare?${query}`, { cookie });

  test("40 · 44 · 49 · 50 · the screen compares a version of this page with the current published page", async () => {
    const page = await screen(`page=${aboutId}&version=${v1}`);
    assert.equal(page.status, 200);
    const html = markup(page.html);
    assert.match(html, /Compare versions/);
    assert.match(html, /Current published/);
    assert.match(html, new RegExp(`#${v1}`));
    // The content difference, published → published, in words.
    assert.match(html, /Title \(English\)/);
    assert.ok(html.includes(v1Title), "the version's title is not in the summary");
    assert.ok(html.includes(publishedTitle), "the published title is not in the summary");
    assert.ok(!html.includes(DRAFT_TITLE), "a draft reached the comparison");
    assert.match(html, /1 with content changes/);
    // What a version does not hold, said on the screen.
    assert.ok(html.includes(GLOBAL_DISCLAIMER));
    assert.ok(html.includes(MEDIA_DISCLAIMER));
    assert.ok(html.includes(DYNAMIC_DISCLAIMER), "About has Statistics and a closing call to action, both live");
    assert.match(html, /Statistics \(the “show statistics” site setting\)/);
    // Never indexed.
    assert.match(page.html, /<meta name="robots" content="noindex, nofollow/);
  });

  test("41 · a version of another page is refused — on the screen and in a pane", async () => {
    const page = await screen(`page=${aboutId}&version=${homeVersion}`);
    assert.equal(page.status, 200);
    assert.match(page.html, /That version belongs to a different page\./);
    assert.ok(!page.html.includes("Current published"));
    const framed = await pane(`/about?compare=v${homeVersion}`, owner.cookie);
    assert.equal(framed.status, 404);
    // Nor may it be the other side of a comparison.
    const against = await screen(`page=${aboutId}&version=${v1}&against=${homeVersion}`);
    assert.match(against.html, /That version belongs to a different page\./);
  });

  test("42 · an unreadable snapshot is refused by name, never rebuilt into an empty page", async () => {
    const page = await screen(`page=${aboutId}&version=${unreadable}`);
    assert.match(page.html, /That version was saved by a different build and cannot be shown here\./);
    const framed = await pane(`/about?compare=v${unreadable}`, owner.cookie);
    assert.equal(framed.status, 404);
  });

  test("missing, malformed and self-comparisons are refused in words", async () => {
    assert.match((await screen(`page=${aboutId}&version=999999`)).html, /That version no longer exists\./);
    assert.match((await screen(`page=${aboutId}&version=abc`)).html, /Choose a version from this page/);
    assert.match((await screen(`version=${v1}`)).html, /Choose a version from a page/);
    assert.match((await screen(`page=999999&version=${v1}`)).html, /That page no longer exists\./);
    assert.match((await screen(`page=${aboutId}&version=${v1}&against=${v1}`)).html, /Choose a different version/);
    for (const junk of ['{"v":1,"sections":[]}', "v0", "v-1", "published2", "vv1", "v12345678901"]) {
      const framed = await pane(`/about?compare=${encodeURIComponent(junk)}`, owner.cookie);
      assert.equal(framed.status, 404, junk);
    }
  });

  test("44 · 45 · the panes are the real site in each edition — English left to right, Arabic right to left", async () => {
    const english = await pane(`/about?compare=v${v1}`, owner.cookie);
    assert.equal(english.status, 200);
    assert.match(english.html, /<html[^>]*lang="en"[^>]*dir="ltr"/);
    assert.ok(markup(english.html).includes(v1Title));
    const arabic = await pane(`/ar/about?compare=v${v1}`, owner.cookie);
    assert.equal(arabic.status, 200);
    assert.match(arabic.html, /<html[^>]*lang="ar"[^>]*dir="rtl"/);
    const snapshot = (await sql<{ snapshot: { sections: { blockType: string; published: { title?: { ar?: string } } }[] } }[]>`
      select snapshot from page_versions where id = ${v1}`)[0]!.snapshot;
    const arabicTitle = snapshot.sections.find((section) => section.blockType === "rich-text")!.published.title!.ar!;
    assert.ok(arabicTitle && markup(arabic.html).includes(arabicTitle), "the Arabic pane does not show the version's Arabic text");
  });

  test("49 · 50 · 62 · the current side is published, never a draft, and every section is drawn at rest", async () => {
    for (const path of [`/about?compare=published`, `/about?compare=v${v1}`, `/ar/about?compare=published`]) {
      const framed = await pane(path, owner.cookie);
      assert.equal(framed.status, 200, path);
      const html = markup(framed.html);
      assert.ok(!html.includes(DRAFT_TITLE), `${path} shows a draft`);
      // Six visible sections on About, each on a still wrapper that names its row.
      assert.equal(count(html, "data-eod-still"), 6, path);
      assert.equal(count(html, "data-eod-compare="), 6, path);
      // No editor motion at all, and every section wrapper is the plain element:
      // no entrance class, no reveal lifecycle waiting to run. (A block's own
      // inner reveals keep their class; the stylesheet holds them finished —
      // see the still-parity test in tests/version-compare.test.ts.)
      for (const marker of ["data-m-reveal", "data-m-px", "data-m-hv", "data-m-words", "data-m-w="]) {
        assert.equal(count(html, marker), 0, `${path} carries ${marker}`);
      }
      for (const wrapper of html.match(/<div[^>]*data-eod-still[^>]*>/g) ?? []) {
        assert.ok(!/class="[^"]*(?:reveal|fade|slide|scale)/.test(wrapper), `${path}: ${wrapper}`);
        assert.ok(!/data-shown/.test(wrapper), `${path}: ${wrapper}`);
      }
      // No editor: no addresses, no bridge, no preview banner.
      assert.equal(count(html, "data-eod-address"), 0, path);
      assert.equal(count(html, "data-eod-draft"), 0, path);
      assert.ok(!/Preview — /i.test(html), path);
    }
    const published = markup((await pane(`/about?compare=published`, owner.cookie)).html);
    assert.ok(published.includes(publishedTitle), "the published side does not show the published title");
  });

  test("46–48 · the chosen width and language are the screen's state, the same for both panes", async () => {
    for (const [device, label] of [
      ["desktop", "Desktop"],
      ["tablet", "Tablet"],
      ["mobile", "Mobile"],
    ] as const) {
      const html = markup((await screen(`page=${aboutId}&version=${v1}&device=${device}&lang=ar`)).html);
      const pressed = [...html.matchAll(/<button[^>]*aria-pressed="true"[^>]*>([\s\S]*?)<\/button>/g)].map((match) => match[1]!);
      assert.ok(pressed.some((inner) => inner.includes(label)), `${device} is not the pressed width`);
      assert.ok(pressed.some((inner) => inner.includes("العربية")), "Arabic is not the pressed language");
      assert.equal(pressed.length, 2, "one width and one language, for both panes");
    }
    const unknown = markup((await screen(`page=${aboutId}&version=${v1}&device=watch`)).html);
    assert.match(unknown, /<button[^>]*aria-pressed="true"[^>]*>[\s\S]*?Desktop/);
  });

  test("67 · a pane is private and never indexed — whoever asks", async () => {
    for (const cookie of [owner.cookie, viewer.cookie, undefined]) {
      for (const path of [`/about?compare=v${v1}`, `/?compare=published`, `/ar/about?compare=published`]) {
        const framed = await pane(path, cookie);
        assert.equal(framed.robots, "noindex, nofollow, noarchive", path);
        assert.equal(framed.cache, "private, no-store, max-age=0", path);
      }
    }
    // An ordinary visit keeps its ordinary headers.
    const plain = await pane(`/about`);
    assert.equal(plain.robots, null);
  });

  test("a visitor who asks for a pane gets the live page: nothing historical, nothing still", async () => {
    const framed = await pane(`/about?compare=v${v1}`);
    assert.equal(framed.status, 200);
    const html = markup(framed.html);
    assert.equal(count(html, "data-eod-still"), 0);
    assert.ok(!html.includes(v1Title) || v1Title === publishedTitle, "a visitor saw a historical title");
    assert.ok(html.includes(publishedTitle));
    // And the screen itself sends them to sign in.
    const anonymous = await get(server.origin, `/admin/compare?page=${aboutId}&version=${v1}`);
    assert.ok([302, 303, 307].includes(anonymous.status), String(anonymous.status));
    assert.match(anonymous.location ?? "", /\/admin\/login/);
  });

  test("a reader who may see page history may compare, but is offered no Restore", async () => {
    const page = await screen(`page=${aboutId}&version=${v1}`, viewer.cookie);
    assert.equal(page.status, 200);
    assert.match(page.html, /Current published/);
    assert.ok(!page.html.includes("Restore version #"), "a read-only session was offered Restore");
    const framed = await pane(`/about?compare=v${v1}`, viewer.cookie);
    assert.equal(count(markup(framed.html), "data-eod-still"), 6);
  });

  test("without content.view there is no comparison at all — the screen refuses and a pane is the live page", async () => {
    const [grant] = await sql<{ role_id: number; permission_id: number }[]>`
      select rp.role_id, rp.permission_id from role_permissions rp
        join roles r on r.id = rp.role_id join permissions p on p.id = rp.permission_id
       where r.key = 'viewer' and p.key = 'content.view'`;
    assert.ok(grant, "the viewer role has no content.view to take away");
    await sql`delete from role_permissions where role_id = ${grant.role_id} and permission_id = ${grant.permission_id}`;
    try {
      const page = await screen(`page=${aboutId}&version=${v1}`, viewer.cookie);
      assert.ok([302, 303, 307].includes(page.status), String(page.status));
      assert.match(page.location ?? "", /\/admin\?denied=1/);
      const framed = await pane(`/about?compare=v${v1}`, viewer.cookie);
      assert.equal(framed.status, 200);
      assert.equal(count(markup(framed.html), "data-eod-still"), 0);
      const foreign = await pane(`/about?compare=v${homeVersion}`, viewer.cookie);
      assert.equal(foreign.status, 200, "a refused comparison must not reveal whether a version exists");
    } finally {
      await sql`insert into role_permissions (role_id, permission_id) values (${grant.role_id}, ${grant.permission_id})`;
    }
  });

  test("43 · 65 · looking writes nothing: no draft, no revision, no version, no activity", async () => {
    const before = await fingerprint();
    const versions = (await sql<{ n: number }[]>`select count(*)::int as n from page_versions`)[0]!.n;
    for (const query of [
      `page=${aboutId}&version=${v1}`,
      `page=${aboutId}&version=${v1}&lang=ar`,
      `page=${aboutId}&version=${v1}&device=tablet`,
      `page=${aboutId}&version=${v1}&device=mobile&lang=ar`,
      `page=${aboutId}&version=${homeVersion}`,
      `page=${aboutId}&version=${unreadable}`,
    ]) {
      assert.equal((await screen(query)).status, 200, query);
    }
    for (const path of [
      `/about?compare=v${v1}`,
      `/ar/about?compare=v${v1}`,
      `/about?compare=published`,
      `/ar/about?compare=published`,
      `/about?compare=v${v1}&r=3`,
      `/about?compare=v${homeVersion}`,
    ]) {
      await pane(path, owner.cookie);
      await pane(path, viewer.cookie);
      await pane(path);
    }
    assert.equal(await fingerprint(), before, "a comparison wrote to the database");
    assert.equal((await sql<{ n: number }[]>`select count(*)::int as n from page_versions`)[0]!.n, versions);
  });

  test("66 · Restore from a comparison is the ordinary restore — blocked by drafts, and then allowed", async () => {
    // A draft is pending, so the ordinary rule applies and the screen says so.
    const blocked = markup((await screen(`page=${aboutId}&version=${v1}`)).html);
    assert.match(blocked, /Restore version #\d+ to draft/);
    assert.ok(blocked.includes("Publish or discard the current saved changes before restoring a historical version."));

    // With the draft discarded, the same action the button calls restores v1 into drafts.
    const page = await pageBySlug("about");
    assert.equal(answered(await editorAction<PageActionResult>("discardPageFromEditor", pageForm(page))).ok, true);
    const versions = (await sql<{ n: number }[]>`select count(*)::int as n from page_versions where page_id = ${aboutId}`)[0]!.n;
    const restored = answered(
      await editorAction<PageActionResult>("restoreVersionFromEditor", pageForm(await pageBySlug("about"), { versionId: String(v1) })),
    );
    assert.equal(restored.ok, true, JSON.stringify(restored));
    const text = await sectionOf("about", "rich-text");
    assert.equal((text.draft?.title as { en: string }).en, v1Title, "the restore did not stage the version");
    assert.equal((text.published.title as { en: string }).en, publishedTitle, "a restore changed the live page");
    assert.equal(
      (await sql<{ n: number }[]>`select count(*)::int as n from page_versions where page_id = ${aboutId}`)[0]!.n,
      versions,
      "a restore wrote a version of its own",
    );
  });

  test("two versions of the same page compare with each other, the older on the left", async () => {
    // Last, because it publishes: the restore above left v1's values staged,
    // and publishing them writes v2 — the state before, with the republished
    // heading.
    assert.equal((await publish("about")).ok, true);
    const [{ id: v2 }] = await sql<{ id: number }[]>`
      select id from page_versions where page_id = ${aboutId} and id <> ${unreadable} order by id desc limit 1`;
    assert.ok(v2 > v1);
    for (const query of [`page=${aboutId}&version=${v2}&against=${v1}`, `page=${aboutId}&version=${v1}&against=${v2}`]) {
      const page = await screen(query);
      assert.equal(page.status, 200, query);
      const html = markup(page.html);
      assert.match(html, new RegExp(`aria-label="Left pane: [^"]*#${v1}"`), query);
      assert.match(html, new RegExp(`aria-label="Right pane: [^"]*#${v2}"`), query);
      assert.ok(!/aria-label="Right pane: Current published"/.test(html), query);
      assert.ok(html.includes(v1Title) && html.includes(publishedTitle), query);
    }
  });
});
