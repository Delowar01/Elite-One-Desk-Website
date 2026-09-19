/**
 * Motion drafts, preview and the publication lifecycle, against the running
 * application.
 *
 * The governing rule of the batch, in one sentence: **editing a section's
 * entrance must not change the live site's animation until the motion draft is
 * explicitly published.** Everything here goes through the real Server Actions
 * over HTTP with the session cookie, the CSRF token and the origin a browser
 * sends, and is read back from the database and from the real rendered pages —
 * so what is asserted is what a visitor and an editor actually get, not what a
 * unit test was told.
 *
 * Motion is the third draft domain beside content and style, sharing one row
 * and one `page_sections.revision`. Most of what follows is therefore about
 * isolation: which column a save reaches, which composition reads which
 * column, and what the other two domains are doing while motion is saved.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { callAction, type ActionResponse } from "./helpers/action";
import { giveFresh } from "./helpers/fixtures";
import { formsOn, get, submitForm } from "./helpers/http";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { startServer, isBuilt, BUILD_HINT, type Server } from "./helpers/server";
import { signIn, type TestSession } from "./helpers/session";

import { MOTION_CLASS, type MotionPreset } from "@/lib/cms/motion";
import { STYLE_DOCUMENT_VERSION } from "@/lib/cms/styles";
import type {
  VisualMotionSaveResult,
  VisualSectionLoad,
  VisualStyleSaveResult,
} from "@/lib/visual-editor/content";

const PORT = 3446;
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
  styles: Record<string, unknown>;
  draft_styles: Record<string, unknown> | null;
  is_published: boolean;
  is_draft_only: boolean;
  animation: string;
  draft_animation: string | null;
  position: number;
  updated_by: number | null;
};

const row = async (id: number): Promise<SectionRow> => {
  const [found] = await sql<SectionRow[]>`
    select id, page_id, revision, block_type, draft, published, styles, draft_styles,
           is_published, is_draft_only, animation, draft_animation, position, updated_by
      from page_sections where id = ${id}
  `;
  assert.ok(found, `section ${id} is missing`);
  return found;
};

/**
 * A section with all three draft domains cleared, so each test starts level.
 *
 * Only the draft columns, and only by SQL. `composePublished` never reads a
 * draft, so clearing one cannot change a cached public page — which is why
 * setting the *published* entrance is `setLive`'s job below and goes through
 * the real publish path instead.
 */
async function find(slug: string, blockType: string): Promise<SectionRow> {
  const [found] = await sql<{ id: number }[]>`
    select s.id from page_sections s join pages p on p.id = s.page_id
     where p.slug = ${slug} and s.block_type = ${blockType}
     order by s.position limit 1
  `;
  assert.ok(found, `no ${blockType} on /${slug}`);
  await sql`
    update page_sections set draft = null, draft_styles = null, draft_animation = null
     where id = ${found.id}
  `;
  return row(found.id);
}

const pageRevision = async (pageId: number): Promise<number> => {
  const [found] = await sql<{ revision: number }[]>`
    select revision from pages where id = ${pageId}
  `;
  return found!.revision;
};

function answered<T>(response: ActionResponse<T>): T {
  assert.ok(response.value, `the action returned nothing (status ${response.status})`);
  return response.value;
}

function saveMotion(
  section: { id: number; page_id: number; revision: number },
  motion: string,
  options: {
    cookie?: string | null;
    csrf?: string | null;
    pageId?: number;
    revision?: number;
    omit?: boolean;
  } = {},
) {
  const form = new FormData();
  const csrf = options.csrf === undefined ? owner.csrfToken : options.csrf;
  if (csrf !== null) form.set("_csrf", csrf);
  form.set("sectionId", String(section.id));
  form.set("pageId", String(options.pageId ?? section.page_id));
  form.set("expectedRevision", String(options.revision ?? section.revision));
  if (!options.omit) form.set("motion", motion);
  return callAction<VisualMotionSaveResult>({
    origin: server.origin,
    route: VE_ROUTE,
    file: VE_ACTIONS,
    action: "saveVisualSectionMotion",
    args: [form],
    cookie: options.cookie === undefined ? owner.cookie : (options.cookie ?? undefined),
  });
}

function saveStyles(section: { id: number; page_id: number; revision: number }, styles: unknown) {
  const form = new FormData();
  form.set("_csrf", owner.csrfToken);
  form.set("sectionId", String(section.id));
  form.set("pageId", String(section.page_id));
  form.set("expectedRevision", String(section.revision));
  form.set("styles", JSON.stringify(styles));
  return callAction<VisualStyleSaveResult>({
    origin: server.origin,
    route: VE_ROUTE,
    file: VE_ACTIONS,
    action: "saveVisualSectionStyles",
    args: [form],
    cookie: owner.cookie,
  });
}

function saveContent(
  section: { id: number; page_id: number; revision: number },
  values: Record<string, unknown>,
) {
  const form = new FormData();
  form.set("_csrf", owner.csrfToken);
  form.set("sectionId", String(section.id));
  form.set("pageId", String(section.page_id));
  form.set("expectedRevision", String(section.revision));
  form.set("values", JSON.stringify(values));
  return callAction<{ ok: boolean; section?: { revision: number } }>({
    origin: server.origin,
    route: VE_ROUTE,
    file: VE_ACTIONS,
    action: "saveVisualSectionDraft",
    args: [form],
    cookie: owner.cookie,
  });
}

const loadSection = (sectionId: number, pageId: number, session: TestSession = owner) =>
  callAction<VisualSectionLoad>({
    origin: server.origin,
    route: VE_ROUTE,
    file: VE_ACTIONS,
    action: "loadVisualSection",
    args: [sectionId, pageId],
    cookie: session.cookie,
  });

/** The one form on a page whose markup carries all of these. */
function formWith(html: string, ...needles: string[]): string {
  const form = formsOn(html).find((candidate) => needles.every((n) => candidate.includes(n)));
  if (!form) throw new Error(`no form contains ${needles.join(" + ")}`);
  return form;
}

/**
 * The section wrapper's opening tag, found by its block type.
 *
 * `data-section` is on the wrapper on every page — public, preview and canvas
 * alike — which is what makes it the right handle here: the same test can ask
 * a visitor's page and an editor's canvas the same question.
 */
function sectionTag(html: string, blockType: string): string | null {
  // Bounded to one tag: the streamed flight payload at the end of the document
  // quotes these attributes back, and matching there would read a script.
  return new RegExp(`<div[^<>]*data-section="${blockType}"[^<>]*>`).exec(html)?.[0] ?? null;
}

const classOf = (tag: string | null): string => /class="([^"]*)"/.exec(tag ?? "")?.[1] ?? "";

const BRIDGE = "0123456789abcdef0123456789abcdef";
const canvas = (path: string) =>
  get(server.origin, `${path}${path.includes("?") ? "&" : "?"}preview=1&editor=1&bridge=${BRIDGE}`, {
    cookie: owner.cookie,
  });
const preview = (path: string) =>
  get(server.origin, `${path}${path.includes("?") ? "&" : "?"}preview=1`, { cookie: owner.cookie });

/** The section editor screen, and the entrance its menu is showing. */
async function sectionScreen(sectionId: number) {
  const screen = await get(server.origin, `/admin/pages/section/${sectionId}`, {
    cookie: owner.cookie,
  });
  const select = /<select[^>]*name="animation"[\s\S]*?<\/select>/.exec(screen.html)?.[0] ?? "";
  const selected = /<option[^>]*value="([^"]*)"[^>]*selected/.exec(select)?.[1] ?? null;
  return { html: screen.html, select, selected };
}

/**
 * Press one of the section editor's buttons.
 *
 * "Save draft", "Publish draft" and "Discard draft" go through the real
 * markup, so what is submitted is what the screen is actually showing — which
 * is the point when the thing under test is a menu's selected option. With no
 * `animation` given, `submitForm` sends whatever option carries `selected`,
 * exactly as a browser would.
 *
 * "Save and publish" is the form's *second* action, reached from a button's
 * `formAction`, and a button is not an input — so it is called the way React
 * calls it, with the previous state and the same fields.
 */
async function submitSection(
  sectionId: number,
  button: "Save draft" | "Publish draft" | "Discard",
  animation?: string,
) {
  const url = `/admin/pages/section/${sectionId}`;
  const screen = await get(server.origin, url, { cookie: owner.cookie });
  const form =
    button === "Save draft"
      ? formWith(screen.html, 'name="animation"')
      : formWith(screen.html, 'name="expectedRevision"', `>${button}<`);
  return submitForm(
    server.origin,
    url,
    form,
    owner.cookie,
    animation === undefined ? {} : { animation },
  );
}

async function saveAndPublish(section: SectionRow, animation: string) {
  const form = new FormData();
  form.set("_csrf", owner.csrfToken);
  form.set("id", String(section.id));
  form.set("expectedRevision", String(section.revision));
  form.set("values", JSON.stringify(section.published));
  form.set("animation", animation);
  return answered(
    await callAction<{ ok: boolean; message?: string }>({
      origin: server.origin,
      route: `/admin/pages/section/${section.id}`,
      file: "app/(backoffice)/admin/(shell)/pages/actions.ts",
      action: "saveSectionAndPublish",
      args: [{ ok: false }, form],
      cookie: owner.cookie,
    }),
  );
}

/**
 * A section whose *published* entrance is this preset, drafts cleared.
 *
 * Set through "Save and publish" rather than with an UPDATE, because the live
 * page is cached under the `pages` tag and only the real action drops it. A
 * SQL poke would leave the cache holding the previous render, and the test
 * would then be asserting against a page nobody is being served.
 */
async function setLive(slug: string, blockType: string, animation: MotionPreset): Promise<SectionRow> {
  const section = await find(slug, blockType);
  const published = await saveAndPublish(section, animation);
  assert.equal(published.ok, true, JSON.stringify(published));
  const after = await row(section.id);
  assert.equal(after.animation, animation);
  return after;
}

before(async () => {
  assert.ok(isBuilt(), BUILD_HINT);
  database = giveFresh("visual_motion");
  sql = connect(database);
  owner = await signIn(sql);
  await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    select 'viewer@test.invalid', 'Read Only', 'unused', id, true
      from roles where key = 'viewer'
  `;
  viewer = await signIn(sql, "viewer");
  server = await startServer(database, PORT);
});

after(async () => {
  await server?.stop();
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
});

/* -------------------------------------------------------------------------- */

describe("a motion save writes one column, and it is not the live one", () => {
  test("the preset lands in draft_animation and the published column does not move", async () => {
    const before = await setLive("privacy", "page-hero", "fade-up");
    const saved = answered(await saveMotion(before, "scale-in"));
    assert.equal(saved.ok, true);

    const after = await row(before.id);
    assert.equal(after.draft_animation, "scale-in");
    assert.equal(after.animation, "fade-up", "the live entrance moved");
    assert.equal(saved.ok && saved.motion, "scale-in");
    assert.equal(saved.ok && saved.revision, after.revision);
  });

  test("nothing else on the row is touched", async () => {
    const before = await setLive("terms", "page-hero", "fade");
    answered(await saveMotion(before, "slide-in"));
    const after = await row(before.id);

    assert.deepEqual(after.published, before.published);
    assert.equal(after.draft, before.draft);
    assert.deepEqual(after.styles, before.styles);
    assert.equal(after.draft_styles, before.draft_styles);
    assert.equal(after.is_published, before.is_published);
    assert.equal(after.is_draft_only, before.is_draft_only);
    assert.equal(after.position, before.position);
    assert.equal(after.block_type, before.block_type);
  });

  test("the section's revision moves and the page's does not", async () => {
    // Two timelines, deliberately independent: a layout draft belongs to the
    // page, a motion draft belongs to the section. Bumping the page here would
    // make every open Layers panel conflict on somebody choosing "Fade only".
    const before = await find("disclaimer", "page-hero");
    const pageBefore = await pageRevision(before.page_id);

    answered(await saveMotion(before, "fade"));

    const after = await row(before.id);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(await pageRevision(before.page_id), pageBefore);

    const [page] = await sql<{ draft_structure: unknown }[]>`
      select draft_structure from pages where id = ${before.page_id}
    `;
    assert.equal(page!.draft_structure, null, "a motion save wrote a layout draft");
  });

  test("“none” is stored, because it is a preset and not an absence", async () => {
    const before = await setLive("privacy", "rich-text", "fade-up");
    answered(await saveMotion(before, "none"));
    const after = await row(before.id);
    assert.equal(after.draft_animation, "none");
    assert.equal(after.animation, "fade-up");
  });

  test("a preset matching what is published is still stored here", async () => {
    // Unlike the ordinary section form, which folds a matching choice back to
    // null because motion rides along with a content save there. Here the
    // editor pressed "Save motion" about motion specifically.
    const before = await setLive("terms", "rich-text", "fade");
    answered(await saveMotion(before, "fade"));
    assert.equal((await row(before.id)).draft_animation, "fade");
  });

  test("the author is recorded", async () => {
    const before = await find("disclaimer", "rich-text");
    answered(await saveMotion(before, "scale-in"));
    assert.equal((await row(before.id)).updated_by, owner.userId);
  });

  test("the activity log says motion, not content and not styles", async () => {
    const section = await find("privacy", "page-hero");
    const [{ count: before }] = await sql<{ count: number }[]>`
      select count(*)::int as count from activity_logs where action = 'section.motion_draft_saved'
    `;
    answered(await saveMotion(section, "slide-in"));
    const [{ count: after }] = await sql<{ count: number }[]>`
      select count(*)::int as count from activity_logs where action = 'section.motion_draft_saved'
    `;
    assert.equal(after, before + 1);

    const [entry] = await sql<{ action: string; user_id: number; entity_id: number }[]>`
      select action, user_id, entity_id from activity_logs
       where entity_type = 'section' and entity_id = ${section.id}
       order by id desc limit 1
    `;
    assert.equal(entry!.action, "section.motion_draft_saved");
    assert.equal(entry!.user_id, owner.userId);
  });
});

/* -------------------------------------------------------------------------- */

describe("a motion save is refused for the same reasons every other save is", () => {
  test("a reader may look but not choose", async () => {
    const section = await find("terms", "page-hero");
    const refused = answered(await saveMotion(section, "fade", { cookie: viewer.cookie, csrf: viewer.csrfToken }));
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, "denied");
    assert.equal((await row(section.id)).draft_animation, null);
  });

  test("a reader can still read the section, entrance included", async () => {
    const section = await setLive("terms", "page-hero", "scale-in");
    const loaded = answered(await loadSection(section.id, section.page_id, viewer));
    assert.equal(loaded.ok, true);
    assert.equal(loaded.ok && loaded.section.motion, "scale-in");
    assert.equal(loaded.ok && loaded.section.hasMotionDraft, false);
  });

  test("without the session's token, nothing is written", async () => {
    const section = await find("disclaimer", "page-hero");
    const refused = answered(await saveMotion(section, "fade", { csrf: null }));
    assert.equal(refused.ok, false);
    assert.equal((await row(section.id)).draft_animation, null);
  });

  test("with somebody else's token, nothing is written", async () => {
    const section = await find("disclaimer", "page-hero");
    const refused = answered(await saveMotion(section, "fade", { csrf: "not-the-token" }));
    assert.equal(refused.ok, false);
    assert.equal((await row(section.id)).draft_animation, null);
  });

  test("without a session at all, nothing is written", async () => {
    const section = await find("privacy", "rich-text");
    const refused = answered(await saveMotion(section, "fade", { cookie: null }));
    assert.equal(refused.ok, false);
    assert.equal((await row(section.id)).draft_animation, null);
  });

  test("a section belonging to another page is refused, not obeyed", async () => {
    const section = await find("terms", "rich-text");
    const [other] = await sql<{ id: number }[]>`
      select id from pages where id <> ${section.page_id} order by id limit 1
    `;
    const refused = answered(await saveMotion(section, "fade", { pageId: other!.id }));
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, "wrong_page");
    assert.equal((await row(section.id)).draft_animation, null);
  });

  test("a section that no longer exists is refused", async () => {
    const refused = answered(
      await saveMotion({ id: 999_999, page_id: 1, revision: 0 }, "fade"),
    );
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, "missing");
  });

  test("a preset outside the vocabulary is refused and nothing is written", async () => {
    const section = await find("privacy", "page-hero");
    for (const bad of ["fade-down", "FADE", "fade-up ", "", "reveal"]) {
      const refused = answered(await saveMotion(section, bad));
      assert.equal(refused.ok, false, `${JSON.stringify(bad)} was accepted`);
      assert.equal(!refused.ok && refused.reason, "invalid");
    }
    assert.equal((await row(section.id)).draft_animation, null);
    assert.equal((await row(section.id)).revision, section.revision);
  });

  test("a missing preset is refused rather than defaulted", async () => {
    const section = await find("terms", "page-hero");
    const refused = answered(await saveMotion(section, "", { omit: true }));
    assert.equal(refused.ok, false);
    assert.equal((await row(section.id)).draft_animation, null);
  });

  test("an unreadable revision is refused", async () => {
    const section = await find("disclaimer", "rich-text");
    const refused = answered(await saveMotion(section, "fade", { revision: -1 }));
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, "invalid");
    assert.equal((await row(section.id)).draft_animation, null);
  });
});

/* -------------------------------------------------------------------------- */

describe("three domains, one revision", () => {
  test("a stale motion save is refused and hands back the version that won", async () => {
    const section = await setLive("privacy", "page-hero", "fade-up");
    // Somebody else saves first, in a different domain.
    answered(await saveStyles(section, { v: STYLE_DOCUMENT_VERSION, nodes: { root: { base: { align: "center" } } } }));

    const refused = answered(await saveMotion(section, "scale-in"));
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, "conflict");
    assert.equal((await row(section.id)).draft_animation, null, "a stale save still wrote");

    // The conflict carries the authoritative reading of all three domains, so
    // the panel can replace what it holds rather than guess at a merge.
    assert.ok(!refused.ok && "section" in refused && refused.section);
    const latest = (refused as { section: { revision: number; motion: MotionPreset; hasMotionDraft: boolean; hasStyleDraft: boolean; hasDraft: boolean; styles: unknown; values: unknown } }).section;
    assert.equal(latest.revision, section.revision + 1);
    assert.equal(latest.hasStyleDraft, true);
    assert.equal(latest.hasMotionDraft, false);
    assert.equal(latest.motion, "fade-up");
    assert.ok(latest.values);
    assert.ok(latest.styles);
  });

  test("motion, style and content can each be saved in turn against the revision the last one produced", async () => {
    let section = await setLive("terms", "page-hero", "fade-up");

    const motion = answered(await saveMotion(section, "slide-in"));
    assert.equal(motion.ok, true);
    section = await row(section.id);

    const styles = answered(await saveStyles(section, { v: STYLE_DOCUMENT_VERSION, nodes: {} }));
    assert.equal(styles.ok, true);
    section = await row(section.id);

    const content = answered(await saveContent(section, section.published));
    assert.equal(content.ok, true);

    const after = await row(section.id);
    assert.equal(after.draft_animation, "slide-in");
    assert.notEqual(after.draft_styles, null);
    assert.notEqual(after.draft, null);
    assert.equal(after.animation, "fade-up", "publishing happened by accident");
  });

  test("a style save leaves a motion draft exactly where it was", async () => {
    let section = await setLive("disclaimer", "page-hero", "fade");
    answered(await saveMotion(section, "none"));
    section = await row(section.id);

    answered(await saveStyles(section, { v: STYLE_DOCUMENT_VERSION, nodes: { root: { base: { opacity: 0.5 } } } }));
    const after = await row(section.id);
    assert.equal(after.draft_animation, "none");
    assert.equal(after.animation, "fade");
  });

  test("a content save leaves a motion draft exactly where it was", async () => {
    let section = await setLive("privacy", "rich-text", "scale-in");
    answered(await saveMotion(section, "fade"));
    section = await row(section.id);

    answered(await saveContent(section, section.published));
    const after = await row(section.id);
    assert.equal(after.draft_animation, "fade");
    assert.equal(after.animation, "scale-in");
  });

  test("a motion save leaves unsaved content and style drafts where they were", async () => {
    let section = await setLive("terms", "rich-text", "fade-up");
    answered(await saveContent(section, section.published));
    section = await row(section.id);
    answered(await saveStyles(section, { v: STYLE_DOCUMENT_VERSION, nodes: { root: { base: { align: "center" } } } }));
    section = await row(section.id);
    const before = await row(section.id);

    answered(await saveMotion(section, "slide-in"));
    const after = await row(section.id);
    assert.deepEqual(after.draft, before.draft);
    assert.deepEqual(after.draft_styles, before.draft_styles);
    assert.equal(after.draft_animation, "slide-in");
  });

  test("the loaded section reports the draft preset, not the published one", async () => {
    const section = await setLive("disclaimer", "rich-text", "fade-up");
    answered(await saveMotion(section, "scale-in"));
    const loaded = answered(await loadSection(section.id, section.page_id));
    assert.equal(loaded.ok, true);
    assert.equal(loaded.ok && loaded.section.motion, "scale-in");
    assert.equal(loaded.ok && loaded.section.hasMotionDraft, true);
  });
});

/* -------------------------------------------------------------------------- */

describe("what moves on the live page, and what only moves in preview", () => {
  const classes = (preset: MotionPreset) => MOTION_CLASS[preset];

  test("a published entrance is on the section wrapper a visitor gets", async () => {
    const section = await setLive("privacy", "page-hero", "scale-in");
    const live = await get(server.origin, "/privacy");
    assert.equal(classOf(sectionTag(live.html, "page-hero")), classes("scale-in"));
    assert.equal(section.animation, "scale-in");
  });

  test("every preset renders its own classes, and only its own", async () => {
    for (const preset of ["fade-up", "fade", "slide-in", "scale-in"] as const) {
      await setLive("terms", "page-hero", preset);
      const live = await get(server.origin, "/terms");
      assert.equal(
        classOf(sectionTag(live.html, "page-hero")),
        classes(preset),
        `${preset} rendered the wrong classes`,
      );
    }
  });

  test("“none” renders no class at all, and no data-shown either", async () => {
    await setLive("disclaimer", "page-hero", "none");
    const live = await get(server.origin, "/disclaimer");
    const tag = sectionTag(live.html, "page-hero");
    assert.ok(tag, "the section is missing");
    assert.ok(!/\bclass=/.test(tag), `"none" still carries a class: ${tag}`);
    assert.ok(!/data-shown/.test(tag), `"none" still carries data-shown: ${tag}`);
    assert.match(tag, /data-section="page-hero"/);
  });

  test("a section that moves starts hidden and says so", async () => {
    await setLive("privacy", "page-hero", "fade-up");
    const live = await get(server.origin, "/privacy");
    assert.match(sectionTag(live.html, "page-hero")!, /data-shown="false"/);
  });

  test("a motion draft changes preview and leaves the live page alone", async () => {
    const section = await setLive("terms", "page-hero", "fade-up");
    answered(await saveMotion(section, "slide-in"));

    const live = await get(server.origin, "/terms");
    assert.equal(classOf(sectionTag(live.html, "page-hero")), classes("fade-up"));

    const draft = await preview("/terms");
    assert.equal(classOf(sectionTag(draft.html, "page-hero")), classes("slide-in"));

    const editing = await canvas("/terms");
    assert.equal(classOf(sectionTag(editing.html, "page-hero")), classes("slide-in"));
  });

  test("a draft of “none” removes the entrance in preview and nowhere else", async () => {
    const section = await setLive("disclaimer", "page-hero", "fade-up");
    answered(await saveMotion(section, "none"));

    const live = await get(server.origin, "/disclaimer");
    assert.equal(classOf(sectionTag(live.html, "page-hero")), classes("fade-up"));

    const draft = await preview("/disclaimer");
    const tag = sectionTag(draft.html, "page-hero");
    assert.ok(!/\bclass=/.test(tag!), `preview still carries a class: ${tag}`);
  });

  test("the address and the editor marks survive a moving wrapper", async () => {
    // One element, one address, whether or not it moves. A wrapper added
    // around the section would have moved every `root` address.
    const section = await setLive("privacy", "page-hero", "fade-up");
    const editing = await canvas("/privacy");
    const tag = sectionTag(editing.html, "page-hero");
    assert.ok(tag, "the section is missing from the canvas");
    assert.match(tag, new RegExp(`data-eod-address="section:${section.id}"`));
    assert.match(tag, /data-eod-kind="section"/);
    assert.match(tag, /data-eod-node=""/);
    assert.match(tag, /class="reveal"/);
  });

  test("a root style override still lands on the same element", async () => {
    const section = await setLive("terms", "page-hero", "scale-in");
    answered(
      await saveStyles(section, {
        v: STYLE_DOCUMENT_VERSION,
        nodes: { root: { base: { align: "center", padBlock: 4 } } },
      }),
    );
    const editing = await canvas("/terms");
    const tag = sectionTag(editing.html, "page-hero");
    assert.match(tag!, /class="reveal reveal-scale"/);
    assert.match(tag!, /text-align:\s*center/);
  });

  test("a root opacity travels as the finished state, not as an inline opacity", async () => {
    // An inline `opacity` on a `.reveal` would show the section at half
    // strength before it revealed and leave the fade nothing to travel.
    const section = await setLive("disclaimer", "page-hero", "fade-up");
    answered(
      await saveStyles(section, {
        v: STYLE_DOCUMENT_VERSION,
        nodes: { root: { base: { opacity: 0.4 }, tablet: { opacity: 0.6 } } },
      }),
    );
    const editing = await canvas("/disclaimer");
    const tag = sectionTag(editing.html, "page-hero")!;
    assert.match(tag, /--eod-node-opacity:\s*0\.4/);
    assert.ok(!/(^|;|")\s*opacity:/.test(tag), `an inline opacity survived: ${tag}`);
    // And at the breakpoints, by the declaration name the stylesheet reads.
    assert.match(tag, /data-rs-t="[^"]*reveal-opacity/);
    assert.match(tag, /--rs-t-opacity:\s*0\.6/);
  });

  test("a section with no entrance takes the ordinary opacity rule", async () => {
    const section = await setLive("privacy", "rich-text", "none");
    answered(
      await saveStyles(section, {
        v: STYLE_DOCUMENT_VERSION,
        nodes: { root: { base: { opacity: 0.4 }, mobile: { opacity: 0.2 } } },
      }),
    );
    const editing = await canvas("/privacy");
    const tag = sectionTag(editing.html, "rich-text")!;
    assert.match(tag, /opacity:\s*0\.4/);
    assert.ok(!/--eod-node-opacity/.test(tag), `"none" renamed an opacity: ${tag}`);
    assert.match(tag, /data-rs-m="[^"]*\bopacity\b/);
    assert.ok(!/reveal-opacity/.test(tag));
  });

  test("the blocks inside keep their own reveals", async () => {
    // Section entrance is one more reveal around the outside, not a
    // replacement for the ones a block runs itself.
    await setLive("privacy", "page-hero", "fade-up");
    const live = await get(server.origin, "/privacy");
    const inner = (live.html.match(/class="reveal[^"]*"/g) ?? []).length;
    assert.ok(inner > 1, `only ${inner} reveal on the page`);
  });

  test("a visitor gets no editor marks on a moving section", async () => {
    await setLive("terms", "page-hero", "slide-in");
    const live = await get(server.origin, "/terms");
    const tag = sectionTag(live.html, "page-hero")!;
    assert.ok(!/data-eod-/.test(tag), `editor marks reached a visitor: ${tag}`);
    assert.match(tag, /class="reveal reveal-left"/);
  });
});

/* -------------------------------------------------------------------------- */

describe("the ordinary section editor saves motion as a draft", () => {
  test("choosing a different entrance writes the draft column, never the live one", async () => {
    const section = await setLive("privacy", "page-hero", "fade-up");
    const saved = await submitSection(section.id, "Save draft", "scale-in");
    assert.ok(!/Reload the page/i.test(saved.html), "the save was refused");

    const after = await row(section.id);
    assert.equal(after.draft_animation, "scale-in");
    assert.equal(after.animation, "fade-up", "a draft save changed the live page");
  });

  test("choosing the entrance that is already live withdraws the draft instead of storing it", async () => {
    // A motion draft is a pending *change*. Storing "fade-up" against a
    // section already publishing fade-up would badge a section nobody has
    // changed and arm Publish all with nothing to publish.
    const section = await setLive("terms", "page-hero", "fade");
    await submitSection(section.id, "Save draft", "scale-in");
    assert.equal((await row(section.id)).draft_animation, "scale-in");

    await submitSection(section.id, "Save draft", "fade");
    assert.equal((await row(section.id)).draft_animation, null);
    assert.equal((await row(section.id)).animation, "fade");
  });

  test("the menu shows the draft when there is one, and the live value when there is not", async () => {
    const section = await setLive("disclaimer", "page-hero", "fade");
    assert.equal((await sectionScreen(section.id)).selected, "fade");

    answered(await saveMotion(await row(section.id), "slide-in"));
    assert.equal((await sectionScreen(section.id)).selected, "slide-in");
  });

  test("the menu offers exactly the five presets", async () => {
    const section = await find("privacy", "page-hero");
    const { select } = await sectionScreen(section.id);
    const values = [...select.matchAll(/<option[^>]*value="([^"]*)"/g)].map((m) => m[1]);
    assert.deepEqual(values, ["fade-up", "fade", "slide-in", "scale-in", "none"]);
  });

  test("the screen calls it a section entrance", async () => {
    const section = await find("terms", "page-hero");
    const { html } = await sectionScreen(section.id);
    assert.match(html, /Section entrance/);
    assert.match(html, /Saved as a draft/);
  });

  test("an entrance outside the five is refused and nothing is written", async () => {
    const section = await setLive("disclaimer", "page-hero", "fade");
    const refused = await submitSection(section.id, "Save draft", "fade-sideways");
    assert.match(refused.html, /not one of the available options/i);
    const after = await row(section.id);
    assert.equal(after.draft_animation, null);
    assert.equal(after.animation, "fade");
    assert.equal(after.revision, section.revision);
  });

  test("“Save and publish” puts the entrance live and clears the draft", async () => {
    let section = await setLive("privacy", "rich-text", "fade-up");
    answered(await saveMotion(section, "none"));
    section = await row(section.id);

    const published = await saveAndPublish(section, "slide-in");
    assert.equal(published.ok, true, JSON.stringify(published));

    const after = await row(section.id);
    assert.equal(after.animation, "slide-in");
    assert.equal(after.draft_animation, null);
    assert.equal(after.is_published, section.is_published, "publishing changed visibility");
  });

  test("publishing the draft promotes motion with everything else, in one write", async () => {
    let section = await setLive("terms", "rich-text", "fade-up");
    answered(await saveMotion(section, "scale-in"));
    section = await row(section.id);
    answered(await saveStyles(section, { v: STYLE_DOCUMENT_VERSION, nodes: { root: { base: { align: "center" } } } }));
    section = await row(section.id);
    const revisionBefore = section.revision;

    const published = await submitSection(section.id, "Publish draft");
    assert.ok(!/Reload the page/i.test(published.html), "publishing was refused");

    const after = await row(section.id);
    assert.equal(after.animation, "scale-in");
    assert.equal(after.draft_animation, null);
    assert.deepEqual(after.styles, { v: STYLE_DOCUMENT_VERSION, nodes: { root: { base: { align: "center" } } } });
    assert.equal(after.draft_styles, null);
    assert.equal(after.revision, revisionBefore + 1, "publishing took more than one write");
  });

  test("a motion-only draft is publishable on its own", async () => {
    const section = await setLive("disclaimer", "rich-text", "fade-up");
    answered(await saveMotion(section, "fade"));

    const screen = await get(server.origin, `/admin/pages/section/${section.id}`, { cookie: owner.cookie });
    assert.match(screen.html, /Motion draft/);

    const published = await submitSection(section.id, "Publish draft");
    assert.ok(!/no draft to publish/i.test(published.html), "a motion draft was not seen as a draft");

    const after = await row(section.id);
    assert.equal(after.animation, "fade");
    assert.equal(after.draft_animation, null);
    assert.deepEqual(after.published, section.published, "content was republished");
  });

  test("discarding clears the motion draft with the other two", async () => {
    let section = await setLive("privacy", "page-hero", "fade-up");
    answered(await saveMotion(section, "scale-in"));
    section = await row(section.id);
    answered(await saveContent(section, section.published));

    const discarded = await submitSection(section.id, "Discard");
    assert.ok(!/Reload the page/i.test(discarded.html), "the discard was refused");

    const after = await row(section.id);
    assert.equal(after.draft_animation, null);
    assert.equal(after.draft, null);
    assert.equal(after.draft_styles, null);
    assert.equal(after.animation, "fade-up");
  });

  test("an unpublished entrance is not on the live page even after a draft save", async () => {
    const section = await setLive("terms", "page-hero", "fade-up");
    await submitSection(section.id, "Save draft", "none");
    const live = await get(server.origin, "/terms");
    assert.equal(classOf(sectionTag(live.html, "page-hero")), "reveal");
  });
});

/* -------------------------------------------------------------------------- */

describe("the page screen counts motion as a draft", () => {
  test("a motion-only draft is badged as one", async () => {
    const section = await setLive("privacy", "page-hero", "fade-up");
    answered(await saveMotion(section, "slide-in"));
    const screen = await get(server.origin, "/admin/pages/privacy", { cookie: owner.cookie });
    assert.match(screen.html, /Motion draft/);
  });

  test("“Publish all drafts” picks up a section whose only draft is motion", async () => {
    // The filter used to be content-or-styles, so a motion-only section would
    // have been left behind by the button that claims to publish the page.
    const section = await setLive("terms", "page-hero", "fade-up");
    answered(await saveMotion(section, "scale-in"));

    const form = new FormData();
    form.set("_csrf", owner.csrfToken);
    form.set("pageId", String(section.page_id));
    const published = answered(
      await callAction<{ ok: boolean; message?: string }>({
        origin: server.origin,
        route: "/admin/pages/terms",
        file: "app/(backoffice)/admin/(shell)/pages/actions.ts",
        action: "publishAllDrafts",
        args: [{ ok: false }, form],
        cookie: owner.cookie,
      }),
    );
    assert.equal(published.ok, true, JSON.stringify(published));

    const after = await row(section.id);
    assert.equal(after.animation, "scale-in");
    assert.equal(after.draft_animation, null);
  });
});

/* -------------------------------------------------------------------------- */

describe("a section that only exists in a layout draft", () => {
  /** Add one through the editor, exactly as the Blocks panel does. */
  async function pending(slug: string): Promise<SectionRow> {
    const [page] = await sql<{ id: number; revision: number }[]>`
      select id, revision from pages where slug = ${slug}
    `;
    const form = new FormData();
    form.set("_csrf", owner.csrfToken);
    form.set("pageId", String(page!.id));
    form.set("expectedRevision", String(page!.revision));
    form.set("blockType", "rich-text");
    const added = answered(
      await callAction<{ ok: boolean; sectionId: number | null; message?: string }>({
        origin: server.origin,
        route: VE_ROUTE,
        file: VE_ACTIONS,
        action: "addPageSection",
        args: [form],
        cookie: owner.cookie,
      }),
    );
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.ok(added.sectionId);
    return row(added.sectionId);
  }

  test("takes a motion draft like any other — saving one is ordinary work", async () => {
    const section = await pending("privacy");
    assert.equal(section.is_draft_only, true);

    const saved = answered(await saveMotion(section, "scale-in"));
    assert.equal(saved.ok, true, JSON.stringify(saved));

    const after = await row(section.id);
    assert.equal(after.draft_animation, "scale-in");
    assert.equal(after.is_draft_only, true, "saving motion published the section into the layout");
    assert.equal(after.is_published, false);
  });

  test("…and “Publish all drafts” still leaves it where it is", async () => {
    // Content and layout are published by different acts. A pending section's
    // entrance going live with the page's content would make a section a
    // visitor cannot reach report itself as published.
    const section = await pending("terms");
    answered(await saveMotion(section, "fade"));

    const form = new FormData();
    form.set("_csrf", owner.csrfToken);
    form.set("pageId", String(section.page_id));
    await callAction<{ ok: boolean }>({
      origin: server.origin,
      route: "/admin/pages/terms",
      file: "app/(backoffice)/admin/(shell)/pages/actions.ts",
      action: "publishAllDrafts",
      args: [{ ok: false }, form],
      cookie: owner.cookie,
    });

    const after = await row(section.id);
    assert.equal(after.draft_animation, "fade", "a pending section's motion was published");
    assert.equal(after.is_draft_only, true);
  });

  test("…and it previews with its own entrance", async () => {
    const section = await pending("disclaimer");
    answered(await saveMotion(section, "none"));

    const draft = await preview("/disclaimer");
    // The pending section is the last rich-text on the page; the entrance it
    // previews with is the draft, so it carries no class.
    const tags = draft.html.match(/<div[^<>]*data-section="rich-text"[^<>]*>/g) ?? [];
    assert.ok(tags.length > 0, "the pending section is not in the preview");
    assert.ok(
      tags.some((tag) => !/\bclass=/.test(tag)),
      `no pending section previewed without an entrance: ${tags.join(" | ")}`,
    );

    const live = await get(server.origin, "/disclaimer");
    const liveTags = live.html.match(/<div[^<>]*data-section="rich-text"[^<>]*>/g) ?? [];
    assert.ok(
      liveTags.every((tag) => /\bclass="reveal/.test(tag)),
      "a pending section reached a visitor",
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("a stored motion draft nobody can read", () => {
  /**
   * The only way to make one is to write it directly, which is the point: a
   * value outside the vocabulary cannot arrive through either save path, so
   * what is being tested is what the rest of the system does when it finds one
   * anyway — a hand-edited row, a restore from before the vocabulary, a bug
   * somewhere upstream.
   */
  async function corrupt(slug: string, blockType: string, live: MotionPreset): Promise<SectionRow> {
    const section = await setLive(slug, blockType, live);
    await sql`update page_sections set draft_animation = 'nonsense' where id = ${section.id}`;
    return row(section.id);
  }

  const logCount = async (action: string): Promise<number> =>
    (await sql<{ count: number }[]>`
       select count(*)::int as count from activity_logs where action = ${action}`)[0]!.count;

  test("a visitor gets the published entrance, untouched", async () => {
    await corrupt("privacy", "page-hero", "slide-in");
    const live = await get(server.origin, "/privacy");
    assert.equal(classOf(sectionTag(live.html, "page-hero")), MOTION_CLASS["slide-in"]);
  });

  test("preview fails closed onto the same one, rather than inventing the default", async () => {
    await corrupt("terms", "page-hero", "scale-in");
    const draft = await preview("/terms");
    assert.equal(
      classOf(sectionTag(draft.html, "page-hero")),
      MOTION_CLASS["scale-in"],
      "preview invented an entrance nobody chose",
    );
  });

  test("the Visual Editor shows the safe preset and still says a draft is pending", async () => {
    const section = await corrupt("disclaimer", "page-hero", "slide-in");
    const loaded = answered(await loadSection(section.id, section.page_id));
    assert.equal(loaded.ok, true);
    assert.equal(loaded.ok && loaded.section.motion, "slide-in");
    assert.equal(loaded.ok && loaded.section.hasMotionDraft, true);
    // Reading repairs nothing and writes nothing.
    assert.deepEqual(await row(section.id), section);
  });

  test("the section editor's menu shows it too, with the draft badge beside it", async () => {
    const section = await corrupt("privacy", "rich-text", "scale-in");
    const screen = await sectionScreen(section.id);
    assert.equal(screen.selected, "scale-in", "the menu claimed an entrance nobody chose");
    assert.match(screen.html, /Motion draft/);
    assert.deepEqual(await row(section.id), section);
  });

  test("Publish draft is refused, and nothing at all moves", async () => {
    const section = await corrupt("terms", "rich-text", "slide-in");
    const before = await logCount("section.published");

    const refused = await submitSection(section.id, "Publish draft");
    assert.match(refused.html, /motion draft is no longer valid/i);

    const after = await row(section.id);
    assert.equal(after.animation, "slide-in");
    assert.equal(after.draft_animation, "nonsense");
    assert.equal(after.revision, section.revision, "a refused publish moved the revision");
    assert.deepEqual(after.published, section.published);
    assert.deepEqual(after.styles, section.styles);
    assert.equal(await logCount("section.published"), before, "a refused publish was logged as one");
  });

  test("Publish all is refused atomically — a valid draft elsewhere on the page is left alone", async () => {
    const broken = await corrupt("disclaimer", "page-hero", "slide-in");
    const healthy = await setLive("disclaimer", "rich-text", "fade-up");
    answered(await saveMotion(healthy, "scale-in"));
    const healthyBefore = await row(healthy.id);
    const logged = await logCount("page.published");

    const form = new FormData();
    form.set("_csrf", owner.csrfToken);
    form.set("pageId", String(broken.page_id));
    const refused = answered(
      await callAction<{ ok: boolean; message?: string }>({
        origin: server.origin,
        route: "/admin/pages/disclaimer",
        file: "app/(backoffice)/admin/(shell)/pages/actions.ts",
        action: "publishAllDrafts",
        args: [{ ok: false }, form],
        cookie: owner.cookie,
      }),
    );
    assert.equal(refused.ok, false);
    assert.match(String(refused.message), /motion draft that is no longer valid/i);

    // Nothing published, nothing cleared, no revision moved, no success log.
    assert.deepEqual(await row(broken.id), broken);
    assert.deepEqual(await row(healthy.id), healthyBefore);
    assert.equal((await row(healthy.id)).draft_animation, "scale-in", "a valid draft was published anyway");
    assert.equal((await row(healthy.id)).animation, "fade-up");
    assert.equal(await logCount("page.published"), logged, "a refused Publish all was logged as one");
  });

  test("Discard clears it without needing it to be readable", async () => {
    // Discard deletes pending state; it does not publish it. An unreadable
    // draft must always have a way out, or a section is stuck for good.
    const section = await corrupt("privacy", "page-hero", "slide-in");
    const discarded = await submitSection(section.id, "Discard");
    assert.ok(!/Reload the page/i.test(discarded.html), "the discard was refused");

    const after = await row(section.id);
    assert.equal(after.draft_animation, null);
    assert.equal(after.animation, "slide-in", "discarding changed the live entrance");
    assert.equal(after.revision, section.revision + 1, "discard took more than one write");

    const live = await get(server.origin, "/privacy");
    assert.equal(classOf(sectionTag(live.html, "page-hero")), MOTION_CLASS["slide-in"]);
  });

  test("saving a valid preset in the Visual Editor repairs it", async () => {
    const section = await corrupt("terms", "page-hero", "slide-in");
    const saved = answered(await saveMotion(section, "fade"));
    assert.equal(saved.ok, true, JSON.stringify(saved));

    const after = await row(section.id);
    assert.equal(after.draft_animation, "fade");
    assert.equal(after.animation, "slide-in", "a repair published something");
    assert.equal(after.revision, section.revision + 1);

    const draft = await preview("/terms");
    assert.equal(classOf(sectionTag(draft.html, "page-hero")), MOTION_CLASS.fade);
  });

  test("…and so does saving a valid preset on the ordinary section form", async () => {
    const section = await corrupt("disclaimer", "rich-text", "scale-in");
    const saved = await submitSection(section.id, "Save draft", "fade");
    assert.ok(!/Reload the page/i.test(saved.html), "the save was refused");

    const after = await row(section.id);
    assert.equal(after.draft_animation, "fade");
    assert.equal(after.animation, "scale-in");
  });

  test("…and the repaired draft then publishes normally", async () => {
    const section = await corrupt("privacy", "rich-text", "slide-in");
    answered(await saveMotion(await row(section.id), "scale-in"));

    const published = await submitSection(section.id, "Publish draft");
    assert.ok(!/no longer valid/i.test(published.html), "a repaired draft was still refused");

    const after = await row(section.id);
    assert.equal(after.animation, "scale-in");
    assert.equal(after.draft_animation, null);
  });
});

/* -------------------------------------------------------------------------- */

describe("a legacy value in the live column is survivable, not publishable intent", () => {
  test("a published entrance nobody recognises renders as the default, everywhere", async () => {
    const section = await find("terms", "rich-text");
    await sql`update page_sections set animation = 'legacy-value' where id = ${section.id}`;
    const before = await row(section.id);

    // Preview is uncached, so this is the value just written rather than a
    // cached render of the previous one.
    const draft = await preview("/terms");
    assert.equal(classOf(sectionTag(draft.html, "rich-text")), MOTION_CLASS["fade-up"]);
    assert.deepEqual(await row(section.id), before, "rendering wrote to the database");

    const loaded = answered(await loadSection(section.id, section.page_id));
    assert.equal(loaded.ok && loaded.section.motion, "fade-up");
    assert.equal(loaded.ok && loaded.section.hasMotionDraft, false);
    assert.deepEqual(await row(section.id), before);
  });

  test("and publishing a section on top of it is not refused — only a bad draft is", async () => {
    const section = await find("disclaimer", "page-hero");
    await sql`update page_sections set animation = 'legacy-value' where id = ${section.id}`;
    answered(await saveContent(await row(section.id), section.published));

    const published = await submitSection(section.id, "Publish draft");
    assert.ok(!/no longer valid/i.test(published.html), "a legacy live value blocked a content publish");
    const after = await row(section.id);
    assert.equal(after.draft, null);
    // Untouched: no motion draft, so publishing had no motion to promote.
    assert.equal(after.animation, "legacy-value");
  });
});
