/**
 * Granular permissions (Batch 18), against the running application.
 *
 * Every case here calls the real Server Actions — the Visual Editor's, the
 * classic Pages screen's and the reusable components' — as a signed-in user
 * whose role holds exactly the keys the case names. Roles are the four system
 * roles (`roles.key` is an enum), so "a content editor", "a stylist" or "a
 * publisher" is the Editor or Viewer role re-granted for the case; grants are
 * read from the database on every request, so the same cookie sees each new
 * combination at once — which is also how revocation is tested.
 *
 * Nothing is inferred from a hidden button. A refusal is asserted by what the
 * action answered and by what the database did not do: no revision moved, no
 * draft or published column changed, no version or activity row was written.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { callAction } from "./helpers/action";
import { giveFresh } from "./helpers/fixtures";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { BUILD_HINT, isBuilt, startServer, type Server } from "./helpers/server";
import { signIn, type TestSession } from "./helpers/session";

import { DENIED } from "@/lib/auth/authority";
import { PERMISSIONS, type PermissionKey } from "@/lib/auth/permissions";
import { linkSlot, readReuse, setOverride } from "@/lib/cms/reuse/reference";
import type { ReuseCatalogEntry, ReuseComponentView } from "@/lib/cms/reuse/view";
import type { PageStructure } from "@/lib/cms/structure";

const PORT = 3471;
const VE = "app/(backoffice)/admin/visual-editor/actions.ts";
const PAGES = "app/(backoffice)/admin/(shell)/pages/actions.ts";
const RC = "app/(backoffice)/admin/(shell)/components/actions.ts";
const NAV = "app/(backoffice)/admin/(shell)/navigation/actions.ts";
const SETTINGS = "app/(backoffice)/admin/(shell)/settings/actions.ts";
const USERS = "app/(backoffice)/admin/(shell)/users/actions.ts";

let database = "";
let sql: Sql;
let server: Server;
let owner: TestSession;
/** The Editor role's user — re-granted for each case. */
let actor: TestSession;
/** The Admin role's user, on the Admin role's defaults. */
let admin: TestSession;
let editorRoleId = 0;

type Values = Record<string, unknown>;
type Answer = { ok: boolean; reason?: string; message?: string } & Record<string, unknown>;
type Section = {
  id: number;
  page_id: number;
  revision: number;
  block_type: string;
  draft: Values | null;
  published: Values;
  styles: Values;
  draft_styles: Values | null;
  animation: string;
  draft_animation: string | null;
  motion_config: Values | null;
  draft_motion_config: Values | null;
  is_draft_only: boolean;
};

/** Reading, and nothing else — the floor every case below builds on. */
const READ: PermissionKey[] = ["dashboard.view", "content.view", "visual_editor.view", "components.view"];

/** The Editor role holds exactly these keys; `actor` is signed in as it. */
async function as(keys: readonly PermissionKey[]): Promise<TestSession> {
  await sql`delete from role_permissions where role_id = ${editorRoleId}`;
  if (keys.length) {
    await sql`
      insert into role_permissions (role_id, permission_id)
      select ${editorRoleId}, id from permissions where key = any(${keys as string[]})`;
  }
  return actor;
}

const form = (fields: Record<string, string | number>, session: TestSession, csrf: string | null = session.csrfToken) => {
  const data = new FormData();
  if (csrf !== null) data.set("_csrf", csrf);
  for (const [key, value] of Object.entries(fields)) data.set(key, String(value));
  return data;
};

const invoke = async (file: string, route: string, action: string, args: unknown[], session: TestSession) =>
  (await callAction<Answer>({ origin: server.origin, route, file, action, args, cookie: session.cookie })).value;

const ve = (action: string, fields: Record<string, string | number>, session: TestSession) =>
  invoke(VE, "/admin/visual-editor", action, [form(fields, session)], session);
const classic = (action: string, fields: Record<string, string | number>, session: TestSession) =>
  invoke(PAGES, "/admin/pages", action, [{ ok: false }, form(fields, session)], session);
const rc = (action: string, fields: Record<string, string | number>, session: TestSession) =>
  invoke(RC, "/admin/components", action, [form(fields, session)], session);

/** A refusal: `ok: false`, in words that name the missing capability. */
function refused(answer: Answer | null, what: string, message?: string): void {
  assert.ok(answer, `${what}: the action returned nothing`);
  assert.equal(answer.ok, false, `${what} was allowed`);
  if (message) assert.equal(answer.message, message, `${what}: ${answer.message}`);
  else assert.match(String(answer.message), /does not allow|needs permission/, `${what}: ${answer.message}`);
}

function allowed(answer: Answer | null, what: string): Answer {
  assert.ok(answer, `${what}: the action returned nothing`);
  assert.equal(answer.ok, true, `${what} was refused: ${answer.message}`);
  return answer;
}

const row = async (id: number): Promise<Section> => {
  const [found] = await sql<Section[]>`
    select id, page_id, revision, block_type, draft, published, styles, draft_styles, animation,
           draft_animation, motion_config, draft_motion_config, is_draft_only
      from page_sections where id = ${id}`;
  assert.ok(found, `section ${id} is missing`);
  return found;
};
const pageBySlug = async (slug: string) => {
  const [found] = await sql<{ id: number; revision: number; is_published: boolean; title_en: string; title_ar: string }[]>`
    select id, revision, is_published, title_en, title_ar from pages where slug = ${slug}`;
  assert.ok(found, `no page ${slug}`);
  return found;
};
const sectionOf = async (slug: string, blockType: string): Promise<Section> => {
  const page = await pageBySlug(slug);
  const [found] = await sql<{ id: number }[]>`
    select id from page_sections where page_id = ${page.id} and block_type = ${blockType} and not is_draft_only
     order by position limit 1`;
  assert.ok(found, `no ${blockType} on /${slug}`);
  return row(found.id);
};
const current = (section: Section): Values => section.draft ?? section.published;

/**
 * Everything a page or component write could move, as one string: every page
 * row, every section row whole, every component, and the counts and last id of
 * page versions, component versions and the activity log. Two equal strings
 * mean a refused request left no trace anywhere a write could have gone.
 */
async function stateOf(): Promise<string> {
  const pages = await sql`
    select id, slug, revision, draft_structure, is_published, title_en, title_ar, updated_at from pages order by id`;
  const sections = await sql`
    select id, page_id, revision, position, is_published, is_draft_only, published, draft, styles, draft_styles,
           animation, draft_animation, motion_config, draft_motion_config, updated_at
      from page_sections order by id`;
  const components = await sql`
    select id, revision, status, name, published_version, published, draft from reusable_components order by id`;
  const counts = await sql`
    select (select count(*) from page_versions)::int as versions,
           (select count(*) from reusable_component_versions)::int as component_versions,
           (select count(*) from activity_logs)::int as activity,
           (select coalesce(max(id), 0) from activity_logs)::int as last_activity`;
  return JSON.stringify({ pages, sections, components, counts });
}

/* Saves and reads, each named the way the editor sends it ------------------ */

const saveContent = (section: Section, values: Values, session: TestSession) =>
  ve("saveVisualSectionDraft", { sectionId: section.id, pageId: section.page_id, expectedRevision: section.revision, values: JSON.stringify(values) }, session);
const saveStyles = (section: Section, styles: unknown, session: TestSession) =>
  ve("saveVisualSectionStyles", { sectionId: section.id, pageId: section.page_id, expectedRevision: section.revision, styles: JSON.stringify(styles) }, session);
const saveMotion = (section: Section, document: unknown, session: TestSession) =>
  ve("saveVisualSectionMotion", { sectionId: section.id, pageId: section.page_id, expectedRevision: section.revision, motionDocument: JSON.stringify(document) }, session);
const structural = async (action: string, slug: string, fields: Record<string, string | number>, session: TestSession) => {
  const page = await pageBySlug(slug);
  return ve(action, { pageId: page.id, expectedRevision: page.revision, ...fields }, session);
};
const pageAct = async (action: "publishPageFromEditor" | "discardPageFromEditor", slug: string, session: TestSession) => {
  const page = await pageBySlug(slug);
  return ve(action, { pageId: page.id, expectedRevision: page.revision }, session);
};
const loadSection = (section: Section, session: TestSession) =>
  invoke(VE, "/admin/visual-editor", "loadVisualSection", [section.id, section.page_id], session);
const catalog = async (session: TestSession) =>
  (await callAction<ReuseCatalogEntry[] | null>({ origin: server.origin, route: "/admin/components", file: RC, action: "loadReusableCatalog", args: [], cookie: session.cookie })).value;
const componentView = async (id: number, session: TestSession) =>
  (await callAction<ReuseComponentView | null>({ origin: server.origin, route: "/admin/components", file: RC, action: "loadReusableComponent", args: [id], cookie: session.cookie })).value;
const componentRow = async (id: number) => {
  const [found] = await sql<{ id: number; revision: number; status: string; name: string; published_version: number; draft: Values | null; published: Values | null }[]>`
    select id, revision, status, name, published_version, draft, published from reusable_components where id = ${id}`;
  return found ?? null;
};
const activityCount = async (action: string) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from activity_logs where action = ${action}`)[0]!.n;

/** A CTA made and published by the owner, for linking. */
async function ownerCta(name: string, en: string, href: string): Promise<ReuseComponentView> {
  const made = allowed(
    await rc("createReusableComponent", { kind: "cta", name, values: JSON.stringify({ label: { en, ar: "" }, href }), publish: "1" }, owner),
    `owner creates ${name}`,
  );
  return made.component as ReuseComponentView;
}

/** The localised text fields a change is written into — the first one a block has. */
const TEXT_FIELDS = ["headline", "title", "eyebrow", "body"];
const textField = (values: Values): string => {
  const key = TEXT_FIELDS.find((name) => {
    const field = values[name];
    return Boolean(field && typeof field === "object" && "en" in (field as Values));
  });
  if (!key) throw new Error("no localised text field");
  return key;
};

/** A text change on a section's first localised field, so a save has something to say. */
function edited(section: Section, text: string): Values {
  const values = { ...current(section) };
  const key = textField(values);
  values[key] = { ...(values[key] as Values), en: text };
  return values;
}

/** The English text `edited` writes, read back. */
const textOf = (values: Values): string => String(((values[textField(values)] as Values) ?? {}).en ?? "");

before(async () => {
  assert.ok(isBuilt(), BUILD_HINT);
  database = giveFresh("permissions_granular");
  sql = connect(database);
  owner = await signIn(sql);
  const [editor] = await sql<{ id: number }[]>`select id from roles where key = 'editor'`;
  editorRoleId = editor!.id;
  await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    select 'granular-actor@test.invalid', 'Granular Actor', 'unused', id, true from roles where key = 'editor'`;
  await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    select 'granular-admin@test.invalid', 'Granular Admin', 'unused', id, true from roles where key = 'admin'`;
  actor = await signIn(sql, "editor");
  admin = await signIn(sql, "admin");
  server = await startServer(database, PORT);
});

after(async () => {
  await server?.stop();
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
});

/* ========================================================================== */

describe("1–2, 31–33 · a viewer reads everything and writes nothing", () => {
  test("1 · reads: a section, the layout, the summary, the history, the components", async () => {
    const viewer = await as(READ);
    const hero = await sectionOf("home", "hero");
    const loaded = await loadSection(hero, viewer);
    assert.equal(loaded?.ok, true, JSON.stringify(loaded));
    const page = await pageBySlug("home");
    const structure = (await callAction<PageStructure | null>({ origin: server.origin, route: "/admin/visual-editor", file: VE, action: "loadPageStructure", args: [page.id], cookie: viewer.cookie })).value;
    assert.ok(structure?.structure.sections.length, "the layout was withheld from a reader");
    const summary = await invoke(VE, "/admin/visual-editor", "loadPageSummary", [page.id], viewer);
    assert.ok(summary, "the page summary was withheld from a reader");
    const history = await invoke(VE, "/admin/visual-editor", "loadPageHistory", [page.id], viewer);
    assert.ok(history, "the page history was withheld from a reader");
    assert.ok(Array.isArray(await catalog(viewer)), "the component list was withheld from a reader");
  });

  test("2, 31–33 · every write, in every domain and on every screen, is refused — and nothing anywhere moves", async () => {
    const cta = await ownerCta("Viewer probe CTA", "Viewer probe", "/viewer-probe");
    // Something for the page-level acts to find: a content draft on About.
    const about = await sectionOf("about", "rich-text");
    allowed(await saveContent(about, edited(about, "Prepared by the owner"), owner), "owner prepares a draft");
    const viewer = await as(READ);
    const hero = await sectionOf("home", "hero");
    const final = await sectionOf("about", "final-cta");
    const home = await pageBySlug("home");
    const before = await stateOf();

    const writes: [string, Answer | null][] = [
      ["content", await saveContent(hero, edited(hero, "Viewer was here"), viewer)],
      ["style", await saveStyles(hero, { v: 1, nodes: { root: { base: { padBlock: 3 } } } }, viewer)],
      ["motion", await saveMotion(hero, { v: 1, section: { base: { entrance: "fade" } }, nodes: {} }, viewer)],
      ["detach", await ve("detachVisualInstance", { sectionId: final.id, pageId: final.page_id, expectedRevision: final.revision, slot: "primaryCta", expectedComponentVersion: 1 }, viewer)],
      ["reorder", await structural("reorderPageStructure", "home", { order: JSON.stringify([]) }, viewer)],
      ["visibility", await structural("setPageSectionVisibility", "home", { sectionId: hero.id, visible: "false" }, viewer)],
      ["add", await structural("addPageSection", "home", { blockType: "rich-text" }, viewer)],
      ["duplicate", await structural("duplicatePageSection", "home", { sectionId: hero.id }, viewer)],
      ["remove", await structural("removePageSection", "home", { sectionId: hero.id }, viewer)],
      ["restore section", await structural("restorePageSection", "home", { sectionId: hero.id }, viewer)],
      ["discard layout", await structural("discardPageLayout", "home", {}, viewer)],
      ["publish page", await pageAct("publishPageFromEditor", "about", viewer)],
      ["discard page", await pageAct("discardPageFromEditor", "about", viewer)],
      ["restore version", await ve("restoreVersionFromEditor", { pageId: home.id, versionId: 1 }, viewer)],
      ["classic save", await classic("saveSectionDraft", { id: hero.id, expectedRevision: hero.revision, values: JSON.stringify(edited(hero, "Classic viewer")) }, viewer)],
      ["classic save and publish", await classic("saveSectionAndPublish", { id: hero.id, expectedRevision: hero.revision, values: JSON.stringify(edited(hero, "Classic viewer")) }, viewer)],
      ["classic publish section", await classic("publishSection", { id: about.id, expectedRevision: (await row(about.id)).revision }, viewer)],
      ["classic discard section", await classic("discardDraft", { id: about.id, expectedRevision: (await row(about.id)).revision }, viewer)],
      ["classic publish page", await classic("publishPage", { pageId: about.page_id, expectedRevision: (await pageBySlug("about")).revision }, viewer)],
      ["classic discard page", await classic("discardPageDrafts", { pageId: about.page_id, expectedRevision: (await pageBySlug("about")).revision }, viewer)],
      ["classic restore version", await classic("restorePageVersion", { pageId: home.id, versionId: 1 }, viewer)],
      ["classic create page", await classic("createPage", { titleEn: "Viewer page", slug: "viewer-page" }, viewer)],
      ["classic page settings", await classic("updatePage", { id: home.id, titleEn: "Hijacked", titleAr: "", isPublished: "on" }, viewer)],
      ["classic delete page", await classic("deletePage", { id: home.id }, viewer)],
      ["classic toggle", await classic("toggleSection", { pageId: home.id, id: hero.id, expectedRevision: home.revision, visible: "false" }, viewer)],
      ["classic move", await classic("moveSection", { pageId: home.id, id: hero.id, expectedRevision: home.revision, direction: "down" }, viewer)],
      ["classic reorder", await classic("reorderSections", { pageId: home.id, expectedRevision: home.revision, order: JSON.stringify([]) }, viewer)],
      ["classic add", await classic("addSection", { pageId: home.id, expectedRevision: home.revision, blockType: "rich-text" }, viewer)],
      ["classic duplicate", await classic("duplicateSection", { pageId: home.id, id: hero.id, expectedRevision: home.revision }, viewer)],
      ["classic delete section", await classic("deleteSection", { pageId: home.id, id: hero.id, expectedRevision: home.revision }, viewer)],
      ["classic restore section", await classic("restoreSection", { pageId: home.id, id: hero.id, expectedRevision: home.revision }, viewer)],
      ["classic discard layout", await classic("discardLayout", { pageId: home.id, expectedRevision: home.revision }, viewer)],
      ["component create", await rc("createReusableComponent", { kind: "cta", name: "Viewer CTA", values: "{}", publish: "0" }, viewer)],
      ["component from section", await rc("createReusableFromSection", { sectionId: hero.id, pageId: hero.page_id, slot: "primaryCta", name: "Viewer copy", publish: "0" }, viewer)],
      ["component save", await rc("saveReusableDraft", { id: cta.id, expectedRevision: cta.revision, values: JSON.stringify({ label: { en: "x", ar: "" }, href: "/x" }) }, viewer)],
      ["component discard", await rc("discardReusableDraft", { id: cta.id, expectedRevision: cta.revision }, viewer)],
      ["component publish", await rc("publishReusable", { id: cta.id, expectedRevision: cta.revision }, viewer)],
      ["component restore", await rc("restoreReusableVersion", { id: cta.id, versionId: 1, expectedRevision: cta.revision }, viewer)],
      ["component rename", await rc("renameReusable", { id: cta.id, expectedRevision: cta.revision, name: "Renamed by a viewer" }, viewer)],
      ["component archive", await rc("archiveReusable", { id: cta.id, expectedRevision: cta.revision, archived: "1" }, viewer)],
      ["component delete", await rc("deleteReusable", { id: cta.id, expectedRevision: cta.revision }, viewer)],
    ];
    for (const [what, answer] of writes) refused(answer, what);
    assert.equal(await stateOf(), before, "a refused request changed a page, a section, a component, a version or the activity log");
    allowed(await pageAct("discardPageFromEditor", "about", owner), "owner cleans up");
  });
});

/* ========================================================================== */

describe("3–7 · a content editor edits content, and only content", () => {
  test("3 · content.edit saves a content draft — the revision moves and the activity says so", async () => {
    const editor = await as([...READ, "content.edit"]);
    const hero = await sectionOf("home", "hero");
    const logged = await activityCount("section.draft_saved");
    const saved = allowed(await saveContent(hero, edited(hero, "Content editor words"), editor), "content save");
    const after = await row(hero.id);
    assert.equal(after.revision, hero.revision + 1);
    assert.equal((after.draft!.headline as Values).en, "Content editor words");
    assert.equal(await activityCount("section.draft_saved"), logged + 1);
    assert.ok(saved);
  });

  test("4–7 · …and cannot style, move, restructure or publish — nothing moves", async () => {
    const editor = await as([...READ, "content.edit"]);
    const hero = await sectionOf("home", "hero");
    const before = await stateOf();
    refused(await saveStyles(hero, { v: 1, nodes: { root: { base: { padBlock: 5 } } } }, editor), "style", DENIED.editStyle);
    refused(await saveMotion(hero, { v: 1, section: { base: { entrance: "fade" } }, nodes: {} }, editor), "motion", DENIED.editMotion);
    const layout = (await callAction<PageStructure | null>({ origin: server.origin, route: "/admin/visual-editor", file: VE, action: "loadPageStructure", args: [hero.page_id], cookie: editor.cookie })).value!;
    const order = layout.structure.sections.map((entry) => entry.sectionId);
    refused(await structural("reorderPageStructure", "home", { order: JSON.stringify([...order].reverse()) }, editor), "reorder", DENIED.editStructure);
    refused(await pageAct("publishPageFromEditor", "home", editor), "publish", DENIED.publish);
    refused(await classic("publishPage", { pageId: hero.page_id, expectedRevision: (await pageBySlug("home")).revision }, editor), "classic publish", DENIED.publish);
    refused(await classic("publishSection", { id: hero.id, expectedRevision: hero.revision }, editor), "single-section publish", DENIED.publish);
    refused(await classic("saveSectionAndPublish", { id: hero.id, expectedRevision: hero.revision, values: JSON.stringify(current(hero)) }, editor), "save and publish", DENIED.saveAndPublish);
    refused(await ve("restoreVersionFromEditor", { pageId: hero.page_id, versionId: 1 }, editor), "restore to draft", DENIED.publish);
    refused(await pageAct("discardPageFromEditor", "home", editor), "page discard", DENIED.publish);
    assert.equal(await stateOf(), before);
    allowed(await pageAct("discardPageFromEditor", "home", owner), "owner cleans up");
  });
});

/* ========================================================================== */

describe("8–12 · standard and advanced styling, one document", () => {
  const standard = (padBlock: number) => ({ v: 1, nodes: { root: { base: { padBlock } } } });

  test("8, 10 · content.style saves standard tokens, and advanced ones already there ride through untouched", async () => {
    const section = await sectionOf("about", "image-text");
    // The owner lays down advanced tokens first: the style draft baseline.
    allowed(
      await saveStyles(section, { v: 1, nodes: { root: { base: { width: "half", textColor: "muted" }, tablet: { layout: "grid", columns: 2 } } } }, owner),
      "owner sets advanced tokens",
    );
    const stylist = await as([...READ, "content.style"]);
    const withAdvanced = await row(section.id);
    const saved = allowed(
      await saveStyles(withAdvanced, { v: 1, nodes: { root: { base: { width: "half", textColor: "strong", padBlock: 4 }, tablet: { layout: "grid", columns: 2 } } } }, stylist),
      "a standard change beside advanced tokens",
    );
    const stored = await row(section.id);
    assert.equal(stored.revision, withAdvanced.revision + 1);
    assert.deepEqual(stored.draft_styles, {
      v: 1,
      nodes: { root: { base: { textColor: "strong", padBlock: 4, width: "half" }, tablet: { layout: "grid", columns: 2 } } },
    });
    assert.ok(saved);
  });

  test("9 · content.style alone cannot add, alter, remove or reset an advanced token — on any node, at any width", async () => {
    const section = await sectionOf("about", "image-text");
    const stylist = await as([...READ, "content.style"]);
    const baseline = await row(section.id);
    const base = baseline.draft_styles as { v: number; nodes: Record<string, Record<string, Values>> };
    const before = await stateOf();
    const attempts: [string, unknown][] = [
      ["add glow", { v: 1, nodes: { root: { ...base.nodes.root, base: { ...base.nodes.root!.base, glow: "soft" } } } }],
      ["alter width", { v: 1, nodes: { root: { ...base.nodes.root, base: { ...base.nodes.root!.base, width: "third" } } } }],
      ["remove a tablet layout", { v: 1, nodes: { root: { base: base.nodes.root!.base } } }],
      ["reset the node", { v: 1, nodes: {} }],
      ["advanced on another node", { v: 1, nodes: { ...base.nodes, "field:title": { base: { overflow: "hidden" } } } }],
      ["advanced at mobile only", { v: 1, nodes: { root: { ...base.nodes.root, mobile: { direction: "column" } } } }],
    ];
    for (const [what, styles] of attempts) {
      refused(await saveStyles(baseline, styles, stylist), what, DENIED.editAdvancedStyle);
    }
    assert.equal(await stateOf(), before, "a refused advanced change moved something");
    // Resetting only what the role may change is allowed, and the advanced tokens stay.
    allowed(
      await saveStyles(baseline, { v: 1, nodes: { root: { base: { width: "half" }, tablet: { layout: "grid", columns: 2 } } } }, stylist),
      "reset of the standard tokens only",
    );
    assert.deepEqual((await row(section.id)).draft_styles, { v: 1, nodes: { root: { base: { width: "half" }, tablet: { layout: "grid", columns: 2 } } } });
  });

  test("…and the published styles are the baseline when there is no style draft", async () => {
    const section = await sectionOf("about", "image-text");
    allowed(await pageAct("publishPageFromEditor", "about", owner), "owner publishes the advanced tokens");
    const published = await row(section.id);
    assert.equal(published.draft_styles, null);
    const stylist = await as([...READ, "content.style"]);
    refused(await saveStyles(published, standard(2), stylist), "dropping published advanced tokens", DENIED.editAdvancedStyle);
    allowed(
      await saveStyles(published, { v: 1, nodes: { root: { base: { width: "half", padBlock: 2 }, tablet: { layout: "grid", columns: 2 } } } }, stylist),
      "a standard change keeping the published advanced tokens",
    );
    allowed(await pageAct("discardPageFromEditor", "about", owner), "owner cleans up");
  });

  test("11 · content.style with content.advanced_style changes advanced tokens", async () => {
    const section = await sectionOf("about", "image-text");
    const both = await as([...READ, "content.style", "content.advanced_style"]);
    const before = await row(section.id);
    allowed(
      await saveStyles(before, { v: 1, nodes: { root: { base: { width: "full", glow: "accent" } } } }, both),
      "advanced styling with both keys",
    );
    assert.deepEqual((await row(section.id)).draft_styles, { v: 1, nodes: { root: { base: { width: "full", glow: "accent" } } } });
    allowed(await pageAct("discardPageFromEditor", "about", owner), "owner cleans up");
  });

  test("12 · content.advanced_style without content.style is no styling authority at all", async () => {
    const section = await sectionOf("about", "image-text");
    const advancedOnly = await as([...READ, "content.advanced_style"]);
    const before = await stateOf();
    refused(await saveStyles(section, standard(6), advancedOnly), "a standard change", DENIED.editStyle);
    refused(await saveStyles(section, { v: 1, nodes: { root: { base: { width: "third" } } } }, advancedOnly), "an advanced change", DENIED.editStyle);
    assert.equal(await stateOf(), before);
  });
});

/* ========================================================================== */

describe("13–16 · motion, layout and publishing are three more separate capabilities", () => {
  test("13 · content.motion saves motion — and not content, styles or layout", async () => {
    const motion = await as([...READ, "content.motion"]);
    const section = await sectionOf("about", "rich-text");
    allowed(await saveMotion(section, { v: 1, section: { base: { entrance: "fade" } }, nodes: {} }, motion), "motion save");
    const after = await row(section.id);
    assert.equal(after.revision, section.revision + 1);
    assert.ok(after.draft_motion_config, "the motion draft was not written");
    const before = await stateOf();
    refused(await saveContent(after, edited(after, "Motion editor words"), motion), "content", DENIED.editContent);
    refused(await saveStyles(after, { v: 1, nodes: { root: { base: { padBlock: 2 } } } }, motion), "style", DENIED.editStyle);
    refused(await structural("setPageSectionVisibility", "about", { sectionId: section.id, visible: "false" }, motion), "layout", DENIED.editStructure);
    assert.equal(await stateOf(), before);
    allowed(await pageAct("discardPageFromEditor", "about", owner), "owner cleans up");
  });

  test("14 · content.structure reorders, hides, adds, duplicates, removes and restores — and cannot publish", async () => {
    const layout = await as([...READ, "content.structure"]);
    const page = await pageBySlug("privacy");
    const structure = (await callAction<PageStructure | null>({ origin: server.origin, route: "/admin/visual-editor", file: VE, action: "loadPageStructure", args: [page.id], cookie: layout.cookie })).value!;
    const order = structure.structure.sections.map((entry) => entry.sectionId);
    allowed(await structural("reorderPageStructure", "privacy", { order: JSON.stringify([...order].reverse()) }, layout), "reorder");
    allowed(await structural("setPageSectionVisibility", "privacy", { sectionId: order[1]!, visible: "false" }, layout), "hide");
    const added = allowed(await structural("addPageSection", "privacy", { blockType: "rich-text" }, layout), "add");
    allowed(await structural("duplicatePageSection", "privacy", { sectionId: order[1]! }, layout), "duplicate");
    allowed(await structural("removePageSection", "privacy", { sectionId: Number(added.sectionId) }, layout), "remove");
    allowed(await structural("restorePageSection", "privacy", { sectionId: Number(added.sectionId) }, layout), "restore");
    assert.ok((await pageBySlug("privacy")).revision > page.revision, "the layout draft did not move");
    const before = await stateOf();
    refused(await pageAct("publishPageFromEditor", "privacy", layout), "publish", DENIED.publish);
    refused(await classic("publishPage", { pageId: page.id, expectedRevision: (await pageBySlug("privacy")).revision }, layout), "classic publish", DENIED.publish);
    const rich = await sectionOf("privacy", "rich-text");
    refused(await saveContent(rich, edited(rich, "Layout editor words"), layout), "content", DENIED.editContent);
    assert.equal(await stateOf(), before);
    allowed(await structural("discardPageLayout", "privacy", {}, layout), "discard layout is a layout operation");
  });

  test("15–16 · content.publish publishes prepared drafts, and changes nothing it may not edit", async () => {
    const section = await sectionOf("terms", "rich-text");
    allowed(await saveContent(section, edited(section, "Prepared for the publisher"), owner), "owner prepares");
    const publisher = await as([...READ, "content.publish"]);
    const before = await stateOf();
    const prepared = await row(section.id);
    refused(await saveContent(prepared, edited(prepared, "Publisher's own words"), publisher), "content", DENIED.editContent);
    refused(await saveStyles(prepared, { v: 1, nodes: { root: { base: { padBlock: 1 } } } }, publisher), "style", DENIED.editStyle);
    refused(await saveMotion(prepared, { v: 1, section: { base: { entrance: "fade" } }, nodes: {} }, publisher), "motion", DENIED.editMotion);
    refused(await classic("saveSectionDraft", { id: prepared.id, expectedRevision: prepared.revision, values: JSON.stringify(edited(prepared, "Classic publisher")) }, publisher), "classic save", DENIED.editContent);
    refused(await classic("saveSectionAndPublish", { id: prepared.id, expectedRevision: prepared.revision, values: JSON.stringify(edited(prepared, "Classic publisher")) }, publisher), "classic save and publish", DENIED.saveAndPublish);
    assert.equal(await stateOf(), before);
    allowed(await pageAct("publishPageFromEditor", "terms", publisher), "the publisher publishes");
    const live = await row(section.id);
    assert.equal(live.draft, null);
    assert.equal(textOf(live.published), "Prepared for the publisher");
    // A single section, published on the classic screen, the same way.
    allowed(await saveContent(live, edited(live, "Second preparation"), owner), "owner prepares again");
    const again = await row(section.id);
    allowed(await classic("publishSection", { id: again.id, expectedRevision: again.revision }, publisher), "single-section publish");
    assert.equal((await row(section.id)).draft, null);
  });

  test("a publisher needs content.view too: publishing a page is publishing what one can see", async () => {
    const section = await sectionOf("disclaimer", "rich-text");
    allowed(await saveContent(section, edited(section, "Waiting"), owner), "owner prepares");
    const blind = await as(["dashboard.view", "content.publish"]);
    const before = await stateOf();
    refused(await pageAct("publishPageFromEditor", "disclaimer", blind), "publish without content.view", DENIED.publish);
    assert.equal(await stateOf(), before);
    allowed(await pageAct("discardPageFromEditor", "disclaimer", owner), "owner cleans up");
  });
});

/* ========================================================================== */

describe("2 · content.manage is kept for a rollback and authorizes nothing here", () => {
  test("a role holding only the legacy key is refused every granular operation", async () => {
    const cta = await ownerCta("Legacy probe CTA", "Legacy", "/legacy");
    const legacy = await as(["dashboard.view", "content.view", "visual_editor.view", "content.manage"]);
    const hero = await sectionOf("home", "hero");
    const before = await stateOf();
    refused(await saveContent(hero, edited(hero, "Legacy words"), legacy), "content");
    refused(await saveStyles(hero, { v: 1, nodes: { root: { base: { padBlock: 2 } } } }, legacy), "style");
    refused(await saveMotion(hero, { v: 1, section: { base: { entrance: "fade" } }, nodes: {} }, legacy), "motion");
    refused(await structural("setPageSectionVisibility", "home", { sectionId: hero.id, visible: "false" }, legacy), "layout");
    refused(await pageAct("publishPageFromEditor", "home", legacy), "publish");
    refused(await classic("saveSectionDraft", { id: hero.id, expectedRevision: hero.revision, values: JSON.stringify(edited(hero, "x")) }, legacy), "classic save");
    refused(await classic("publishSection", { id: hero.id, expectedRevision: hero.revision }, legacy), "classic publish");
    refused(await rc("createReusableComponent", { kind: "cta", name: "Legacy CTA", values: "{}", publish: "0" }, legacy), "component create");
    refused(await rc("publishReusable", { id: cta.id, expectedRevision: cta.revision }, legacy), "component publish");
    assert.equal(await stateOf(), before);
  });
});

/* ========================================================================== */

describe("17–22 · reusable components: view, edit, publish and lifecycle are separate", () => {
  test("components.view reads; without it the list and a component are withheld", async () => {
    const cta = await ownerCta("Viewing probe", "Seen", "/seen");
    const reader = await as([...READ]);
    assert.ok((await catalog(reader))?.some((entry) => entry.id === cta.id));
    assert.ok(await componentView(cta.id, reader));
    const blind = await as(["dashboard.view", "content.view", "visual_editor.view"]);
    assert.equal(await catalog(blind), null);
    assert.equal(await componentView(cta.id, blind), null);
  });

  test("17 · components.edit makes and saves drafts, and cannot publish or archive", async () => {
    const author = await as([...READ, "components.edit"]);
    const made = allowed(await rc("createReusableComponent", { kind: "cta", name: "Author's CTA", values: JSON.stringify({ label: { en: "Draft", ar: "" }, href: "/draft" }), publish: "0" }, author), "create a draft");
    const component = made.component as ReuseComponentView;
    const saved = allowed(await rc("saveReusableDraft", { id: component.id, expectedRevision: component.revision, values: JSON.stringify({ label: { en: "Draft 2", ar: "" }, href: "/draft" }) }, author), "save the draft");
    const view = saved.component as ReuseComponentView;
    allowed(await rc("renameReusable", { id: view.id, expectedRevision: view.revision, name: "Author's CTA, renamed" }, author), "rename");
    const stored = (await componentRow(component.id))!;
    const before = await stateOf();
    refused(await rc("publishReusable", { id: stored.id, expectedRevision: stored.revision }, author), "publish", DENIED.publishComponents);
    refused(await rc("createReusableComponent", { kind: "cta", name: "Published at once", values: JSON.stringify({ label: { en: "x", ar: "" }, href: "/x" }), publish: "1" }, author), "create and publish", DENIED.createPublishedComponent);
    refused(await rc("archiveReusable", { id: stored.id, expectedRevision: stored.revision, archived: "1" }, author), "archive", DENIED.componentLifecycle);
    refused(await rc("deleteReusable", { id: stored.id, expectedRevision: stored.revision }, author), "delete", DENIED.componentLifecycle);
    assert.equal(await stateOf(), before);
  });

  test("18–19 · components.publish publishes a saved draft, and cannot change a word of it", async () => {
    const [target] = await sql<{ id: number }[]>`select id from reusable_components where name = 'Author''s CTA, renamed'`;
    const stored = (await componentRow(target!.id))!;
    const publisher = await as([...READ, "components.publish"]);
    const before = await stateOf();
    refused(await rc("saveReusableDraft", { id: stored.id, expectedRevision: stored.revision, values: JSON.stringify({ label: { en: "Publisher's words", ar: "" }, href: "/p" }) }, publisher), "edit the draft", DENIED.editComponents);
    refused(await rc("discardReusableDraft", { id: stored.id, expectedRevision: stored.revision }, publisher), "discard the draft", DENIED.editComponents);
    refused(await rc("renameReusable", { id: stored.id, expectedRevision: stored.revision, name: "Publisher renamed it" }, publisher), "rename", DENIED.editComponents);
    refused(await rc("restoreReusableVersion", { id: stored.id, versionId: 1, expectedRevision: stored.revision }, publisher), "restore a version to the draft", DENIED.editComponents);
    assert.equal(await stateOf(), before);
    allowed(await rc("publishReusable", { id: stored.id, expectedRevision: stored.revision }, publisher), "publish");
    const live = (await componentRow(stored.id))!;
    assert.equal(live.published_version, 1);
    assert.deepEqual(live.published, { label: { en: "Draft 2", ar: "" }, href: "/draft" }, "what was published is the author's draft, unchanged");
  });

  test("20 · components.lifecycle archives, unarchives and deletes; edit and publish together cannot", async () => {
    const cta = await ownerCta("Lifecycle probe", "Life", "/life");
    const both = await as([...READ, "components.edit", "components.publish"]);
    const before = await stateOf();
    refused(await rc("archiveReusable", { id: cta.id, expectedRevision: cta.revision, archived: "1" }, both), "archive", DENIED.componentLifecycle);
    refused(await rc("deleteReusable", { id: cta.id, expectedRevision: cta.revision }, both), "delete", DENIED.componentLifecycle);
    assert.equal(await stateOf(), before);
    const keeper = await as([...READ, "components.lifecycle"]);
    const archived = allowed(await rc("archiveReusable", { id: cta.id, expectedRevision: cta.revision, archived: "1" }, keeper), "archive");
    const view = archived.component as ReuseComponentView;
    const unarchived = allowed(await rc("archiveReusable", { id: view.id, expectedRevision: view.revision, archived: "0" }, keeper), "unarchive");
    const again = unarchived.component as ReuseComponentView;
    allowed(await rc("deleteReusable", { id: again.id, expectedRevision: again.revision }, keeper), "delete an unused component");
    assert.equal(await componentRow(cta.id), null);
  });

  test("a component write needs components.view as well — the answer is the component whole", async () => {
    const blindAuthor = await as(["dashboard.view", "content.view", "components.edit"]);
    const before = await stateOf();
    refused(await rc("createReusableComponent", { kind: "cta", name: "Blind CTA", values: "{}", publish: "0" }, blindAuthor), "create without components.view", DENIED.editComponents);
    assert.equal(await stateOf(), before);
  });

  test("21 · every page and component permission together still reaches no site setting and no menu", async () => {
    const everything = await as([
      ...READ,
      "content.edit", "content.style", "content.advanced_style", "content.motion", "content.structure", "content.publish",
      "components.edit", "components.publish", "components.lifecycle", "content.manage",
    ]);
    const settingsForm = (fields: Record<string, string>) => [{ ok: false }, form(fields, everything)];
    const brand = await invoke(SETTINGS, "/admin/settings", "saveBrand", settingsForm({ siteNameEn: "Component Co" }), everything);
    refused(brand, "brand", "You do not have permission to do that.");
    const whatsapp = await invoke(SETTINGS, "/admin/settings", "saveWhatsapp", settingsForm({ number: "966500000999" }), everything);
    refused(whatsapp, "WhatsApp", "You do not have permission to do that.");
    const nav = await invoke(NAV, "/admin/navigation", "saveNavItem", settingsForm({ menu: "header", labelEn: "Nope", href: "/" }), everything);
    refused(nav, "navigation", "You do not have permission to do that.");
  });

  test("22 · create, publish and link checks every effect before it creates anything", async () => {
    const section = await sectionOf("about", "final-cta");
    const count = async () => (await sql<{ n: number }[]>`select count(*)::int as n from reusable_components`)[0]!.n;
    const attempt = (session: TestSession, publish: "0" | "1", name: string) =>
      rc("createReusableFromSection", { sectionId: section.id, pageId: section.page_id, slot: "primaryCta", name, publish }, session);
    const full: PermissionKey[] = [...READ, "content.edit", "components.edit", "components.publish"];
    // Each missing piece refuses the whole, and nothing is made.
    for (const missing of ["content.edit", "components.edit", "components.publish", "components.view", "content.view"] as const) {
      const session = await as(full.filter((key) => key !== missing));
      const before = await count();
      refused(await attempt(session, "1", `Missing ${missing}`), `create, publish and link without ${missing}`);
      assert.equal(await count(), before, `a component was made without ${missing}`);
    }
    // A draft needs only reading the section and editing components.
    const draftOnly = await as([...READ, "components.edit"]);
    allowed(await attempt(draftOnly, "0", "Draft from the section"), "a draft from the section");
    refused(await attempt(draftOnly, "1", "Draft author publishing"), "the draft author asking to publish", DENIED.saveAsReusablePublished);
    const noEdit = await as([...READ, "content.edit", "components.publish"]);
    refused(await attempt(noEdit, "0", "No component edit"), "a draft without components.edit", DENIED.saveAsReusableDraft);
    // All of it: created, published — and the link is the ordinary content save.
    const all = await as(full);
    const made = allowed(await attempt(all, "1", "Create publish link"), "create, publish and link");
    const component = made.component as ReuseComponentView;
    assert.equal(component.publishedVersion, 1);
    const linkedValues = linkSlot(section.block_type, current(section), "primaryCta", { id: component.id, kind: component.kind, values: component.published! });
    allowed(await saveContent(section, linkedValues!, all), "the link");
    assert.equal(readReuse((await row(section.id)).draft, section.block_type).primaryCta?.c, component.id);
    allowed(await pageAct("discardPageFromEditor", "about", owner), "owner cleans up");
  });

  test("a page's own use of a component: content.edit plus components.view — typing into an override is only content", async () => {
    const cta = await ownerCta("Instance probe", "Instance", "/instance");
    const section = await sectionOf("about", "final-cta");
    const contentOnly = await as(["dashboard.view", "content.view", "visual_editor.view", "content.edit"]);
    const linked = linkSlot(section.block_type, current(section), "primaryCta", { id: cta.id, kind: cta.kind, values: cta.published! })!;
    const before = await stateOf();
    refused(await saveContent(section, linked, contentOnly), "link without components.view", DENIED.reuseInstance);
    assert.equal(await stateOf(), before);
    // The owner links it; overriding is switching part of the reference, the same rule.
    allowed(await saveContent(section, linked, owner), "owner links");
    const withLink = await row(section.id);
    const overridden = setOverride(section.block_type, current(withLink), "primaryCta", "primaryCtaLabel.en", true, "Instance")!;
    refused(await saveContent(withLink, overridden, contentOnly), "override without components.view", DENIED.reuseInstance);
    refused(
      await ve("detachVisualInstance", { sectionId: withLink.id, pageId: withLink.page_id, expectedRevision: withLink.revision, slot: "primaryCta", expectedComponentVersion: 1 }, contentOnly),
      "detach without components.view",
      DENIED.reuseInstance,
    );
    // With the override on (the owner's), typing into it is ordinary page content.
    allowed(await saveContent(withLink, overridden, owner), "owner overrides");
    const withOverride = await row(section.id);
    const typed = { ...current(withOverride), primaryCtaLabel: { ...(current(withOverride).primaryCtaLabel as Values), en: "Typed here" } };
    allowed(await saveContent(withOverride, typed, contentOnly), "typing into an override");
    allowed(await pageAct("discardPageFromEditor", "about", owner), "owner cleans up");
  });

  test("adding a reusable section is layout, content and component viewing together", async () => {
    const [block] = await sql<{ id: number }[]>`select id from reusable_components where kind = 'block:rich-text' and status = 'active' and published_version > 0 limit 1`;
    let componentId = block?.id;
    if (!componentId) {
      const made = allowed(
        await rc("createReusableComponent", { kind: "block:rich-text", name: "Shared words", values: JSON.stringify({ title: { en: "Shared", ar: "" }, body: { en: "<p>Shared body</p>", ar: "" } }), publish: "1" }, owner),
        "owner makes a reusable block",
      );
      componentId = (made.component as ReuseComponentView).id;
    }
    const layoutOnly = await as([...READ, "content.structure"]);
    const before = await stateOf();
    refused(await structural("addPageSection", "privacy", { blockType: "rich-text", componentId: componentId! }, layoutOnly), "a reusable section, layout only", DENIED.addReusableSection);
    assert.equal(await stateOf(), before);
    const layoutAndContent = await as([...READ, "content.structure", "content.edit"]);
    allowed(await structural("addPageSection", "privacy", { blockType: "rich-text", componentId: componentId! }, layoutAndContent), "a reusable section with all three");
    allowed(await structural("discardPageLayout", "privacy", {}, owner), "owner cleans up");
  });
});

/* ========================================================================== */

describe("23–25 · the canvas and the history are not ways round a permission", () => {
  test("23 · what a direct edit writes is a content save — refused for a viewer and for a stylist", async () => {
    const hero = await sectionOf("home", "hero");
    const before = await stateOf();
    for (const keys of [READ, [...READ, "content.style", "content.advanced_style"]] as PermissionKey[][]) {
      const session = await as(keys);
      refused(await saveContent(hero, edited(hero, "Typed on the canvas"), session), `a canvas edit as ${keys.join("+")}`, DENIED.editContent);
    }
    assert.equal(await stateOf(), before);
  });

  test("24–25 · an Undo or a Redo of an advanced change, after the permission is gone, is refused where it saves", async () => {
    const section = await sectionOf("contact", "page-hero");
    const stylist = await as([...READ, "content.style", "content.advanced_style"]);
    const beforeDoc = { v: 1, nodes: {} };
    const afterDoc = { v: 1, nodes: { root: { base: { minHeight: "half-screen" } } } };
    // The action: an advanced change, saved.
    allowed(await saveStyles(section, afterDoc, stylist), "the advanced change");
    // The permission goes; the browser still holds the history.
    const revoked = await as([...READ, "content.style"]);
    const changed = await row(section.id);
    const state = await stateOf();
    // Undo replays `before` through the same save — refused, nothing moves.
    refused(await saveStyles(changed, beforeDoc, revoked), "Undo of an advanced change", DENIED.editAdvancedStyle);
    assert.equal(await stateOf(), state);
    // And Redo of the same step, from a buffer that had been undone, likewise.
    refused(await saveStyles(changed, { v: 1, nodes: { root: { base: { minHeight: "screen" } } } }, revoked), "Redo of an advanced change", DENIED.editAdvancedStyle);
    assert.equal(await stateOf(), state);
    // A standard change is still the stylist's to make.
    allowed(await saveStyles(changed, { v: 1, nodes: { root: { base: { minHeight: "half-screen", padBlock: 2 } } } }, revoked), "a standard change after the revocation");
    allowed(await pageAct("discardPageFromEditor", "contact", owner), "owner cleans up");
  });

  test("24–25 · layout Undo and Redo are layout requests, refused once content.structure is gone", async () => {
    const layout = await as([...READ, "content.structure"]);
    const page = await pageBySlug("terms");
    const hero = await sectionOf("terms", "page-hero");
    allowed(await structural("setPageSectionVisibility", "terms", { sectionId: hero.id, visible: "false" }, layout), "hide");
    const gone = await as([...READ]);
    const before = await stateOf();
    refused(await structural("setPageSectionVisibility", "terms", { sectionId: hero.id, visible: "true" }, gone), "Undo of a hide", DENIED.editStructure);
    refused(await structural("restorePageSection", "terms", { sectionId: hero.id, placement: "1", beforeSectionId: "end", visible: "true" }, gone), "an exact-placement restore", DENIED.editStructure);
    assert.equal(await stateOf(), before);
    assert.ok((await pageBySlug("terms")).revision > page.revision);
    allowed(await structural("discardPageLayout", "terms", {}, owner), "owner cleans up");
  });
});

/* ========================================================================== */

describe("26–27 · the classic screens obey the same rules", () => {
  test("26 · a stylist or a motion editor cannot save words through the classic form", async () => {
    const hero = await sectionOf("home", "hero");
    const before = await stateOf();
    for (const keys of [[...READ, "content.style"], [...READ, "content.motion"]] as PermissionKey[][]) {
      const session = await as(keys);
      refused(
        await classic("saveSectionDraft", { id: hero.id, expectedRevision: hero.revision, values: JSON.stringify(edited(hero, "Classic words")) }, session),
        `classic save as ${keys.at(-1)}`,
        DENIED.editContent,
      );
    }
    assert.equal(await stateOf(), before);
  });

  test("26 · a content editor's classic save may not move the entrance — and leaves it alone when the menu is absent or unchanged", async () => {
    const hero = await sectionOf("home", "hero");
    const editor = await as([...READ, "content.edit"]);
    const before = await stateOf();
    const other = hero.animation === "fade" ? "scale-in" : "fade";
    refused(
      await classic("saveSectionDraft", { id: hero.id, expectedRevision: hero.revision, values: JSON.stringify(edited(hero, "With motion")), animation: other }, editor),
      "an entrance change",
      DENIED.editMotion,
    );
    assert.equal(await stateOf(), before);
    // The menu left as it showed: no motion change, the words save.
    allowed(
      await classic("saveSectionDraft", { id: hero.id, expectedRevision: hero.revision, values: JSON.stringify(edited(hero, "Menu untouched")), animation: hero.draft_animation ?? hero.animation }, editor),
      "a classic save with the entrance unchanged",
    );
    const saved = await row(hero.id);
    assert.equal(saved.draft_animation, hero.draft_animation);
    // The menu absent — a disabled control — is no opinion about motion at all.
    allowed(
      await classic("saveSectionDraft", { id: saved.id, expectedRevision: saved.revision, values: JSON.stringify(edited(saved, "Menu absent")) }, editor),
      "a classic save without the entrance",
    );
    assert.equal((await row(hero.id)).draft_animation, hero.draft_animation);
    allowed(await pageAct("discardPageFromEditor", "home", owner), "owner cleans up");
  });

  test("27 · the classic publish, discard, restore and page-settings routes all need content.publish", async () => {
    const section = await sectionOf("privacy", "rich-text");
    allowed(await saveContent(section, edited(section, "Waiting on privacy"), owner), "owner prepares");
    const prepared = await row(section.id);
    const page = await pageBySlug("privacy");
    const editor = await as([...READ, "content.edit", "content.structure"]);
    const before = await stateOf();
    refused(await classic("publishSection", { id: prepared.id, expectedRevision: prepared.revision }, editor), "publish a section", DENIED.publish);
    refused(await classic("discardDraft", { id: prepared.id, expectedRevision: prepared.revision }, editor), "discard a section's drafts", DENIED.publish);
    refused(await classic("publishPage", { pageId: page.id, expectedRevision: page.revision }, editor), "publish the page", DENIED.publish);
    refused(await classic("discardPageDrafts", { pageId: page.id, expectedRevision: page.revision }, editor), "discard the page", DENIED.publish);
    refused(await classic("restorePageVersion", { pageId: page.id, versionId: 1 }, editor), "restore a version", DENIED.publish);
    refused(await classic("updatePage", { id: page.id, titleEn: page.title_en, titleAr: page.title_ar }, editor), "unpublish the page", DENIED.publish);
    refused(await classic("saveSectionAndPublish", { id: prepared.id, expectedRevision: prepared.revision, values: JSON.stringify(current(prepared)) }, editor), "save and publish", DENIED.saveAndPublish);
    assert.equal(await stateOf(), before);
    allowed(await pageAct("discardPageFromEditor", "privacy", owner), "owner cleans up");
  });

  test("page settings: publishing switches the page, a title needs editing too — titles are live", async () => {
    const page = await pageBySlug("disclaimer");
    const publisher = await as([...READ, "content.publish"]);
    allowed(await classic("updatePage", { id: page.id, titleEn: page.title_en, titleAr: page.title_ar }, publisher), "unpublish");
    assert.equal((await pageBySlug("disclaimer")).is_published, false);
    allowed(await classic("updatePage", { id: page.id, titleEn: page.title_en, titleAr: page.title_ar, isPublished: "on" }, publisher), "publish again");
    const before = await stateOf();
    refused(await classic("updatePage", { id: page.id, titleEn: "A new live title", titleAr: page.title_ar, isPublished: "on" }, publisher), "rename", DENIED.renamePage);
    assert.equal(await stateOf(), before);
    const both = await as([...READ, "content.publish", "content.edit"]);
    allowed(await classic("updatePage", { id: page.id, titleEn: "A new live title", titleAr: page.title_ar, isPublished: "on" }, both), "rename with both");
    assert.equal((await pageBySlug("disclaimer")).title_en, "A new live title");
  });

  test("a new page is layout and content; deleting one is layout and publishing", async () => {
    const editor = await as([...READ, "content.edit"]);
    const before = await stateOf();
    refused(await classic("createPage", { titleEn: "Editor page", slug: "editor-page" }, editor), "create without layout", DENIED.createPage);
    assert.equal(await stateOf(), before);
    const builder = await as([...READ, "content.edit", "content.structure"]);
    await classic("createPage", { titleEn: "Builder page", slug: "builder-page" }, builder);
    const [made] = await sql<{ id: number }[]>`select id from pages where slug = 'builder-page'`;
    assert.ok(made, "the page was not created");
    const stateAfterCreate = await stateOf();
    refused(await classic("deletePage", { id: made.id }, builder), "delete without publish", DENIED.deletePage);
    assert.equal(await stateOf(), stateAfterCreate);
    const remover = await as([...READ, "content.structure", "content.publish"]);
    await classic("deletePage", { id: made.id }, remover);
    assert.equal((await sql`select id from pages where slug = 'builder-page'`).length, 0);
  });
});

/* ========================================================================== */

describe("28–30 · the doors every write goes through are unchanged", () => {
  test("28 · a missing or wrong CSRF token is refused, whatever the role", async () => {
    const hero = await sectionOf("home", "hero");
    const before = await stateOf();
    for (const csrf of [null, "not-the-token"]) {
      const data = form({ sectionId: hero.id, pageId: hero.page_id, expectedRevision: hero.revision, values: JSON.stringify(edited(hero, "No token")) }, owner, csrf);
      refused(await invoke(VE, "/admin/visual-editor", "saveVisualSectionDraft", [data], owner), `content save, csrf ${csrf}`, "This form expired. Reload the page and try again.");
      const published = form({ pageId: hero.page_id, expectedRevision: (await pageBySlug("home")).revision }, owner, csrf);
      refused(await invoke(VE, "/admin/visual-editor", "publishPageFromEditor", [published], owner), `publish, csrf ${csrf}`, "This form expired. Reload the page and try again.");
    }
    assert.equal(await stateOf(), before);
  });

  test("29 · an expired session is refused", async () => {
    const session = await signIn(sql, "admin");
    await sql`update sessions set expires_at = now() - interval '1 minute' where csrf_token = ${session.csrfToken}`;
    const hero = await sectionOf("home", "hero");
    const before = await stateOf();
    refused(await saveContent(hero, edited(hero, "Expired"), session), "an expired session", "Your session has expired. Sign in again.");
    assert.equal(await stateOf(), before);
  });

  test("30 · a section is written only through the page it belongs to", async () => {
    const hero = await sectionOf("home", "hero");
    const about = await pageBySlug("about");
    const before = await stateOf();
    const foreign = await ve("saveVisualSectionDraft", { sectionId: hero.id, pageId: about.id, expectedRevision: hero.revision, values: JSON.stringify(edited(hero, "Foreign")) }, owner);
    assert.equal(foreign?.ok, false);
    assert.equal(foreign?.reason, "wrong_page");
    const moved = await ve("setPageSectionVisibility", { pageId: about.id, expectedRevision: about.revision, sectionId: hero.id, visible: "false" }, owner);
    assert.equal(moved?.ok, false);
    assert.equal(await stateOf(), before);
  });
});

/* ========================================================================== */

describe("15, 36, 38 · revocation takes effect on the next request, and owner and admin keep their boundaries", () => {
  test("a grant removed through the Roles screen refuses the very next save, and restoring it lets the same session in again", async () => {
    const editor = await as([...READ, "content.edit", "content.publish", "components.publish"]);
    const hero = await sectionOf("home", "hero");
    allowed(await saveContent(hero, edited(hero, "Before the revocation"), editor), "a save before");
    const roleForm = (keys: string[]) => {
      const data = form({ roleId: editorRoleId }, owner);
      for (const key of keys) data.set(`perm:${key}`, "on");
      return data;
    };
    // The owner takes content.edit and content.publish away, through the real action.
    const kept = [...READ, "components.publish"];
    allowed(await invoke(USERS, "/admin/users", "saveRolePermissions", [{ ok: false }, roleForm(kept)], owner), "the owner narrows the role");
    const saved = await row(hero.id);
    const before = await stateOf();
    refused(await saveContent(saved, edited(saved, "After the revocation"), editor), "the next content save", DENIED.editContent);
    refused(await pageAct("publishPageFromEditor", "home", editor), "the next publish", DENIED.publish);
    assert.equal(await stateOf(), before);
    // A component publish removed after the draft was loaded: refused on the publish.
    const cta = await ownerCta("Revocation probe", "Loaded", "/loaded");
    const draft = allowed(await rc("saveReusableDraft", { id: cta.id, expectedRevision: cta.revision, values: JSON.stringify({ label: { en: "Loaded 2", ar: "" }, href: "/loaded" }) }, owner), "owner drafts");
    allowed(await invoke(USERS, "/admin/users", "saveRolePermissions", [{ ok: false }, roleForm(READ)], owner), "the owner removes components.publish");
    const pending = draft.component as ReuseComponentView;
    refused(await rc("publishReusable", { id: pending.id, expectedRevision: pending.revision }, editor), "the component publish", DENIED.publishComponents);
    // Given back: the same cookie, no new sign-in.
    allowed(await invoke(USERS, "/admin/users", "saveRolePermissions", [{ ok: false }, roleForm([...READ, "content.edit"])], owner), "the owner restores content.edit");
    allowed(await saveContent(saved, edited(saved, "After it came back"), editor), "the save after");
    allowed(await pageAct("discardPageFromEditor", "home", owner), "owner cleans up");
  });

  test("36 · the owner holds every key in the catalogue; the admin every one but roles.manage", async () => {
    const held = async (role: string) =>
      new Set((await sql<{ key: string }[]>`
        select p.key from roles r join role_permissions rp on rp.role_id = r.id join permissions p on p.id = rp.permission_id
         where r.key = ${role}`).map((entry) => entry.key));
    const ownerKeys = await held("owner");
    const adminKeys = await held("admin");
    for (const { key } of PERMISSIONS) {
      assert.ok(ownerKeys.has(key), `the owner lacks ${key}`);
      assert.equal(adminKeys.has(key), key !== "roles.manage", `the admin ${key === "roles.manage" ? "holds" : "lacks"} ${key}`);
    }
  });

  test("36 · the admin edits, styles advanced tokens and publishes; it cannot rewrite a role, and nobody can narrow the owner's", async () => {
    const section = await sectionOf("contact", "page-hero");
    allowed(await saveStyles(section, { v: 1, nodes: { root: { base: { width: "full" } } } }, admin), "admin advanced styling");
    allowed(await pageAct("publishPageFromEditor", "contact", admin), "admin publishes");
    const [viewerRole] = await sql<{ id: number }[]>`select id from roles where key = 'viewer'`;
    const rewrite = form({ roleId: viewerRole!.id }, admin);
    rewrite.set("perm:content.publish", "on");
    refused(await invoke(USERS, "/admin/users", "saveRolePermissions", [{ ok: false }, rewrite], admin), "an admin rewriting a role", "You do not have permission to do that.");
    const [ownerRole] = await sql<{ id: number }[]>`select id from roles where key = 'owner'`;
    const narrow = form({ roleId: ownerRole!.id }, owner);
    narrow.set("perm:content.view", "on");
    const answer = await invoke(USERS, "/admin/users", "saveRolePermissions", [{ ok: false }, narrow], owner);
    assert.equal(answer?.ok, false);
    assert.match(String(answer?.message), /owner role always has every permission/i);
  });
});
