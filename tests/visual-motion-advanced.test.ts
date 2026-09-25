/**
 * Advanced motion (Batch 15a) against the running application.
 *
 * The same governing rule as Batch 9's motion, carried to the whole document:
 * **editing motion — a section's, an element's, at any width — must not change
 * what a visitor sees move until it is explicitly published.** And the Batch 15
 * rule beside it: **the legacy preset the previous release reads always
 * travels with the document it stands for**, through every save, publication,
 * discard, restore and duplicate.
 *
 * Everything here goes through the real Server Actions over HTTP with the
 * session cookie, the CSRF token and the origin a browser sends, and is read
 * back from the database and from the real rendered pages.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { callAction, type ActionResponse } from "./helpers/action";
import { giveFresh } from "./helpers/fixtures";
import { formsOn, get, submitForm } from "./helpers/http";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { startServer, isBuilt, BUILD_HINT, type Server } from "./helpers/server";
import { signIn, type TestSession } from "./helpers/session";

import { MOTION_DOCUMENT_VERSION, type MotionDocument, type MotionTarget } from "@/lib/cms/motion-doc";
import type { VisualMotionSaveResult, VisualSectionLoad } from "@/lib/visual-editor/content";
import {
  describePending,
  type PageActionResult,
  type PageHistoryView,
  type PageSummaryView,
} from "@/lib/visual-editor/publish";

const PORT = 3449;
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
  draft_styles: Record<string, unknown> | null;
  animation: string;
  draft_animation: string | null;
  motion_config: MotionDocument | null;
  draft_motion_config: MotionDocument | null;
  is_draft_only: boolean;
  position: number;
};

type PageRow = { id: number; slug: string; revision: number };

const COLUMNS = sqlColumns();
function sqlColumns() {
  return `id, page_id, revision, block_type, draft, published, draft_styles, animation, draft_animation,
          motion_config, draft_motion_config, is_draft_only, position`;
}

const row = async (id: number): Promise<SectionRow> => {
  const [found] = await sql.unsafe<SectionRow[]>(`select ${COLUMNS} from page_sections where id = $1`, [id]);
  assert.ok(found, `section ${id} is missing`);
  return found;
};

const pageBySlug = async (slug: string): Promise<PageRow> => {
  const [found] = await sql<PageRow[]>`select id, slug, revision from pages where slug = ${slug}`;
  assert.ok(found, `no page ${slug}`);
  return found;
};

const sectionOf = async (slug: string, blockType: string): Promise<SectionRow> => {
  const page = await pageBySlug(slug);
  const [found] = await sql<{ id: number }[]>`
    select id from page_sections where page_id = ${page.id} and block_type = ${blockType}
     order by position limit 1`;
  assert.ok(found, `no ${blockType} on /${slug}`);
  return row(found.id);
};

/**
 * A page exactly as the fixture shipped it: sections restored from a copy
 * taken before the first test, with their ids, no drafts, no history.
 */
async function reset(slug: string): Promise<PageRow> {
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

const doc = (section: MotionTarget = {}, nodes: Record<string, MotionTarget> = {}): MotionDocument => ({
  v: MOTION_DOCUMENT_VERSION,
  section,
  nodes,
});

function saveDocument(
  section: { id: number; page_id: number; revision: number },
  document: unknown,
  options: { session?: TestSession; csrf?: string | null; revision?: number; raw?: string } = {},
) {
  const session = options.session ?? owner;
  const form = new FormData();
  const csrf = options.csrf === undefined ? session.csrfToken : options.csrf;
  if (csrf !== null) form.set("_csrf", csrf);
  form.set("sectionId", String(section.id));
  form.set("pageId", String(section.page_id));
  form.set("expectedRevision", String(options.revision ?? section.revision));
  form.set("motionDocument", options.raw ?? JSON.stringify(document));
  return callAction<VisualMotionSaveResult>({
    origin: server.origin,
    route: VE_ROUTE,
    file: VE_ACTIONS,
    action: "saveVisualSectionMotion",
    args: [form],
    cookie: session.cookie,
  });
}

function saveContent(section: { id: number; page_id: number; revision: number }, values: Record<string, unknown>) {
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

function saveStyles(section: { id: number; page_id: number; revision: number }, styles: unknown) {
  const form = new FormData();
  form.set("_csrf", owner.csrfToken);
  form.set("sectionId", String(section.id));
  form.set("pageId", String(section.page_id));
  form.set("expectedRevision", String(section.revision));
  form.set("styles", JSON.stringify(styles));
  return callAction<{ ok: boolean; revision?: number }>({
    origin: server.origin,
    route: VE_ROUTE,
    file: VE_ACTIONS,
    action: "saveVisualSectionStyles",
    args: [form],
    cookie: owner.cookie,
  });
}

const loadSection = (sectionId: number, pageId: number) =>
  callAction<VisualSectionLoad>({
    origin: server.origin,
    route: VE_ROUTE,
    file: VE_ACTIONS,
    action: "loadVisualSection",
    args: [sectionId, pageId],
    cookie: owner.cookie,
  });

function pageForm(page: { id: number; revision: number }, extra: Record<string, string> = {}) {
  const form = new FormData();
  form.set("_csrf", owner.csrfToken);
  form.set("pageId", String(page.id));
  form.set("expectedRevision", String(page.revision));
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return form;
}

const editorAction = <T>(action: string, form: FormData) =>
  callAction<T>({ origin: server.origin, route: VE_ROUTE, file: VE_ACTIONS, action, args: [form], cookie: owner.cookie });

const publish = async (slug: string) =>
  answered(await editorAction<PageActionResult>("publishPageFromEditor", pageForm(await pageBySlug(slug))));
const discardAll = async (slug: string) =>
  answered(await editorAction<PageActionResult>("discardPageFromEditor", pageForm(await pageBySlug(slug))));
const restore = async (slug: string, versionId: number) =>
  answered(
    await editorAction<PageActionResult>(
      "restoreVersionFromEditor",
      pageForm(await pageBySlug(slug), { versionId: String(versionId) }),
    ),
  );
const summaryOf = async (slug: string) =>
  answered(
    await callAction<PageSummaryView | null>({
      origin: server.origin,
      route: VE_ROUTE,
      file: VE_ACTIONS,
      action: "loadPageSummary",
      args: [(await pageBySlug(slug)).id],
      cookie: owner.cookie,
    }),
  )!;
const historyOf = async (slug: string) =>
  answered(
    await callAction<PageHistoryView | null>({
      origin: server.origin,
      route: VE_ROUTE,
      file: VE_ACTIONS,
      action: "loadPageHistory",
      args: [(await pageBySlug(slug)).id],
      cookie: owner.cookie,
    }),
  )!;

const livePath = (slug: string) => (slug === "home" ? "/" : `/${slug}`);
const live = async (slug: string) => (await get(server.origin, livePath(slug))).html;
const preview = async (slug: string) =>
  (await get(server.origin, `${livePath(slug)}?preview=1`, { cookie: owner.cookie })).html;

/** The HTML before the streamed flight payload, which quotes attributes back. */
const markup = (html: string): string => {
  const at = html.search(/<script[^>]*>\s*\(?self\.__next_f/);
  return at < 0 ? html : html.slice(0, at);
};

/** A section wrapper's opening tag, found by block type. */
const sectionTag = (html: string, blockType: string): string =>
  new RegExp(`<div[^<>]*data-section="${blockType}"[^<>]*>`).exec(html)?.[0] ?? "";

/** The opening tag of the element carrying one attribute value. */
const tagWith = (html: string, needle: string): string =>
  new RegExp(`<[a-z0-9]+[^<>]*${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^<>]*>`).exec(markup(html))?.[0] ?? "";

const logSummaries = async (action: string): Promise<string[]> =>
  (await sql<{ summary: string }[]>`select summary from activity_logs where action = ${action} order by id`).map(
    (entry) => entry.summary,
  );

before(async () => {
  assert.ok(isBuilt(), BUILD_HINT);
  database = giveFresh("visual_motion_advanced");
  sql = connect(database);
  owner = await signIn(sql);
  await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    select 'viewer@test.invalid', 'Read Only', 'unused', id, true from roles where key = 'viewer'
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

/* -------------------------------------------------------------------------- */

describe("a motion document is saved as two draft columns, and nothing live moves", () => {
  test("the document and its projection land in the draft columns, together", async () => {
    await reset("about");
    const before = await sectionOf("about", "rich-text");
    const submitted = doc(
      { base: { entrance: "blur", duration: "slow" }, mobile: { entrance: "none" } },
      { "field:body": { base: { entrance: "mask", direction: "start", delay: 150 } } },
    );
    const saved = answered(await saveDocument(before, submitted));
    assert.equal(saved.ok, true, JSON.stringify(saved));

    const after = await row(before.id);
    assert.deepEqual(after.draft_motion_config, submitted);
    assert.equal(after.draft_animation, "fade", "Blur's legacy projection is Fade");
    assert.equal(after.animation, before.animation, "the live preset moved");
    assert.equal(after.motion_config, null, "the live document moved");
    assert.equal(after.revision, before.revision + 1);
    assert.deepEqual(after.draft, before.draft);
    assert.deepEqual(after.draft_styles, before.draft_styles);
    assert.equal(saved.ok && saved.revision, after.revision);
    assert.deepEqual(saved.ok && saved.motionDocument, submitted);
    assert.equal(saved.ok && saved.motion, "fade");
    assert.equal(saved.ok && saved.legacyEntrance, "fade-up");
  });

  test("the activity log says what happened, in a sentence, without the document", async () => {
    const summaries = await logSummaries("section.motion_draft_saved");
    assert.ok(summaries.length > 0);
    for (const summary of summaries) {
      assert.ok(!/[{}[\]]|"v"|entrance|--m-/.test(summary), `a log summary carries motion data: ${summary}`);
    }
  });

  test("what is stored is rebuilt from the vocabulary, whatever was sent", async () => {
    await reset("about");
    const before = await sectionOf("about", "rich-text");
    const saved = answered(
      await saveDocument(before, {
        v: 1,
        evil: "x",
        section: { base: { entrance: "blur", transform: "rotate(9deg)", easing: "cubic-bezier(0,0,1,1)" } },
        nodes: {
          "field:body": { base: { entrance: "mask", direction: "left", duration: "500ms", delay: 75, filter: "blur(40px)" } },
          ".prose-eod > p": { base: { entrance: "fade" } },
          "section:1/field:title": { base: { entrance: "fade" } },
        },
      }),
    );
    assert.equal(saved.ok, true);
    const after = await row(before.id);
    assert.deepEqual(after.draft_motion_config, doc({ base: { entrance: "blur" } }, { "field:body": { base: { entrance: "mask" } } }));
    for (const hostile of ["rotate", "cubic-bezier", "left", "500ms", "blur(40px)", "prose-eod", "section:1"]) {
      assert.ok(!JSON.stringify(after.draft_motion_config).includes(hostile), hostile);
    }
  });

  test("an element that already runs its own entrance cannot be given another", async () => {
    await reset("privacy");
    const hero = await sectionOf("privacy", "page-hero");
    const saved = answered(
      await saveDocument(hero, doc({ base: { entrance: "blur" } }, { "field:title": { base: { entrance: "mask" } } })),
    );
    assert.equal(saved.ok, true);
    assert.deepEqual((await row(hero.id)).draft_motion_config, doc({ base: { entrance: "blur" } }));
  });

  test("a document that is not JSON, or not a document at all, writes nothing", async () => {
    await reset("about");
    const before = await sectionOf("about", "rich-text");
    const refused = answered(await saveDocument(before, null, { raw: "{not json" }));
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, "invalid");
    const after = await row(before.id);
    assert.equal(after.revision, before.revision);
    assert.equal(after.draft_motion_config, null);
    // A document from a newer build, or no document at all, is refused rather
    // than stored as the empty document: an empty draft is a real one, and
    // publishing it would take every advanced motion away.
    for (const notADocument of [{ v: 9, section: { base: { entrance: "blur" } } }, 5, "doc", [], {}, { section: {} }]) {
      const refusedToo = answered(await saveDocument(before, notADocument));
      assert.equal(refusedToo.ok, false, JSON.stringify(notADocument));
      assert.equal(!refusedToo.ok && refusedToo.reason, "invalid");
    }
    const untouched = await row(before.id);
    assert.equal(untouched.revision, before.revision);
    assert.equal(untouched.draft_motion_config, null);
  });

  test("a reader cannot save motion, and neither can a request without the token", async () => {
    await reset("about");
    const before = await sectionOf("about", "rich-text");
    const denied = answered(await saveDocument(before, doc({ base: { entrance: "blur" } }), { session: viewer }));
    assert.equal(denied.ok, false);
    const forged = await saveDocument(before, doc({ base: { entrance: "blur" } }), { csrf: null });
    assert.notEqual(forged.value?.ok, true);
    const after = await row(before.id);
    assert.equal(after.revision, before.revision);
    assert.equal(after.draft_motion_config, null);
  });

  test("a stale revision is refused with the version that won, and nothing is merged", async () => {
    await reset("about");
    const before = await sectionOf("about", "rich-text");
    answered(await saveDocument(before, doc({ base: { entrance: "blur" } })));
    const conflict = answered(await saveDocument(before, doc({ base: { entrance: "mask" } })));
    assert.equal(conflict.ok, false);
    assert.equal(!conflict.ok && conflict.reason, "conflict");
    assert.ok(!conflict.ok && "section" in conflict);
    const latest = !conflict.ok && "section" in conflict ? conflict.section : null;
    assert.deepEqual(latest?.motionDocument, doc({ base: { entrance: "blur" } }));
    assert.deepEqual((await row(before.id)).draft_motion_config, doc({ base: { entrance: "blur" } }));
  });

  test("the panel is loaded with the document, cut down to the block, and the fallback it names", async () => {
    await reset("about");
    const before = await sectionOf("about", "rich-text");
    answered(await saveDocument(before, doc({}, { "field:body": { base: { entrance: "fade" } } })));
    const loaded = answered(await loadSection(before.id, before.page_id));
    assert.equal(loaded.ok, true);
    const section = loaded.ok ? loaded.section : null;
    assert.deepEqual(section?.motionDocument, doc({}, { "field:body": { base: { entrance: "fade" } } }));
    assert.equal(section?.legacyEntrance, "fade-up");
    assert.equal(section?.hasMotionDraft, true);
  });
});

/* -------------------------------------------------------------------------- */

describe("one revision for three domains, saved in turn", () => {
  test("content, style and motion each name the revision the one before produced", async () => {
    await reset("about");
    let section = await sectionOf("about", "rich-text");
    const content = answered(await saveContent(section, { ...section.published }));
    assert.equal(content.ok, true);
    section = await row(section.id);
    const styles = answered(await saveStyles(section, { v: 1, nodes: { root: { base: { align: "center" } } } }));
    assert.equal(styles.ok, true);
    section = await row(section.id);
    const motion = answered(await saveDocument(section, doc({ base: { entrance: "blur" } })));
    assert.equal(motion.ok, true);

    const after = await row(section.id);
    assert.notEqual(after.draft, null);
    assert.notEqual(after.draft_styles, null);
    assert.deepEqual(after.draft_motion_config, doc({ base: { entrance: "blur" } }));
    assert.equal(after.draft_animation, "fade");
  });

  test("a motion save that names a revision another domain has moved past conflicts", async () => {
    await reset("about");
    const section = await sectionOf("about", "rich-text");
    answered(await saveContent(section, { ...section.published }));
    const stale = answered(await saveDocument(section, doc({ base: { entrance: "blur" } })));
    assert.equal(!stale.ok && stale.reason, "conflict");
    assert.equal((await row(section.id)).draft_motion_config, null);
  });

  test("an external writer moves the revision, and the motion save is refused", async () => {
    await reset("about");
    const section = await sectionOf("about", "rich-text");
    await sql`update page_sections set revision = revision + 1 where id = ${section.id}`;
    const stale = answered(await saveDocument(section, doc({ base: { entrance: "mask" } })));
    assert.equal(!stale.ok && stale.reason, "conflict");
    assert.equal((await row(section.id)).draft_motion_config, null);
  });
});

/* -------------------------------------------------------------------------- */

describe("the preview shows the draft, and the live page does not", () => {
  test("a draft renders in preview only, as attributes and variables on the elements it names", async () => {
    await reset("about");
    const section = await sectionOf("about", "rich-text");
    answered(
      await saveDocument(
        section,
        doc({ base: { entrance: "blur" }, tablet: { duration: "fast" } }, { "field:body": { base: { entrance: "mask", direction: "end" } } }),
      ),
    );

    const drafted = await preview("about");
    const wrapper = sectionTag(drafted, "rich-text");
    assert.match(wrapper, /data-m-reveal=""/);
    assert.match(wrapper, /--m-blur:8px/);
    assert.match(wrapper, /data-m-t="dur"/);
    assert.match(wrapper, /--m-t-dur:var\(--duration-fast\)/);
    assert.ok(!/class="reveal/.test(wrapper), "an advanced wrapper also wears the legacy class");
    const body = tagWith(drafted, 'class="prose-eod"');
    assert.match(body, /data-m-reveal=""/);
    assert.match(body, /--m-clip-s:100%/);

    const visitor = await live("about");
    assert.ok(!/data-m-/.test(visitor), "a visitor's page carries draft motion");
    assert.match(sectionTag(visitor, "rich-text"), /class="reveal"/);
  });

  test("every section without a document renders exactly as before, beside one that has one", async () => {
    await reset("about");
    const untouched = sectionTag(await preview("about"), "why-us");
    const section = await sectionOf("about", "rich-text");
    answered(await saveDocument(section, doc({ base: { entrance: "blur" } })));
    const beside = sectionTag(await preview("about"), "why-us");
    assert.equal(beside, untouched);
    assert.ok(!/data-m-/.test(beside));
  });

  test("a document that only restates the legacy preset renders on the legacy class", async () => {
    await reset("about");
    const plain = sectionTag(await preview("about"), "rich-text");
    const section = await sectionOf("about", "rich-text");
    answered(await saveDocument(section, doc({ base: { entrance: "fade-up" } })));
    // Identical but for the draft marker every section with a pending edit wears.
    assert.equal(sectionTag(await preview("about"), "rich-text").replace(' data-draft="true"', ""), plain);
  });
});

/* -------------------------------------------------------------------------- */

describe("the page's pending state counts a motion document alone", () => {
  test("element motion alone makes the page publishable, and the review says so", async () => {
    await reset("about");
    const section = await sectionOf("about", "rich-text");
    answered(await saveDocument(section, doc({}, { "field:body": { base: { entrance: "fade" } } })));
    // The legacy preset beside it did not change.
    assert.equal((await row(section.id)).draft_animation, "fade-up");
    await sql`update page_sections set draft_animation = null where id = ${section.id}`;

    const summary = await summaryOf("about");
    assert.equal(summary.motionDrafts, 1);
    assert.equal(summary.contentDrafts, 0);
    assert.equal(summary.styleDrafts, 0);
    assert.equal(summary.publishable, true);
    assert.equal(summary.discardable, true);
    assert.deepEqual(describePending(summary), ["1 motion draft"]);
  });

  test("the Pages list counts the section as a draft", async () => {
    await reset("terms");
    const section = await sectionOf("terms", "rich-text");
    const list = async () => (await get(server.origin, "/admin/pages", { cookie: owner.cookie })).html;
    // One table row, with React's text separators taken out.
    const rowOf = (html: string) =>
      (html.split("<tr").find((chunk) => chunk.includes('href="/admin/pages/terms"')) ?? "").replace(/<!-- -->/g, "");
    assert.ok(rowOf(await list()).includes("/terms"), "the Pages list has no row for /terms");
    assert.ok(!/\d+ drafts?</.test(rowOf(await list())));
    await sql`update page_sections set draft_motion_config = ${sql.json(doc({}, { "field:body": { base: { entrance: "blur" } } }) as never)}::jsonb
               where id = ${section.id}`;
    assert.match(rowOf(await list()), />1 draft</);
  });
});

/* -------------------------------------------------------------------------- */

describe("publishing is one act for both columns", () => {
  test("a page publication promotes the document and its projection together", async () => {
    await reset("about");
    const section = await sectionOf("about", "rich-text");
    const blur = doc({ base: { entrance: "blur" } }, { "field:body": { base: { entrance: "mask" } } });
    answered(await saveDocument(section, blur));
    const drafted = sectionTag(await preview("about"), "rich-text");

    const done = await publish("about");
    assert.equal(done.ok, true, JSON.stringify(done));
    const after = await row(section.id);
    assert.deepEqual(after.motion_config, blur);
    assert.equal(after.animation, "fade", "the previous release would show Fade");
    assert.equal(after.draft_motion_config, null);
    assert.equal(after.draft_animation, null);

    // What the preview showed is what a visitor now gets.
    const visitor = await live("about");
    assert.equal(sectionTag(visitor, "rich-text"), drafted.replace(' data-draft="true"', ""));
    assert.match(tagWith(visitor, 'class="prose-eod"'), /data-m-reveal=""/);
  });

  test("the restore point taken before it holds the page as it was", async () => {
    const history = await historyOf("about");
    assert.ok(history.versions.length >= 1);
    const [latest] = await sql<{ snapshot: { sections: { sourceSectionId: number; motion?: unknown }[] } }[]>`
      select snapshot from page_versions where id = ${history.versions[0]!.id}`;
    const section = await sectionOf("about", "rich-text");
    const entry = latest!.snapshot.sections.find((candidate) => candidate.sourceSectionId === section.id);
    assert.ok(entry);
    assert.ok(!("motion" in entry), "the version before the first advanced publication has no document");
  });

  test("an unreadable document stops the whole publication, and nothing is written", async () => {
    await reset("about");
    const page = await pageBySlug("about");
    const text = await sectionOf("about", "rich-text");
    const why = await sectionOf("about", "why-us");
    await sql`update page_sections set draft = ${sql.json({ ...text.published } as never)}::jsonb where id = ${text.id}`;
    await sql`update page_sections set draft_motion_config = ${sql.json({ v: 9, section: {} } as never)}::jsonb,
                                       draft_animation = 'fade-up'
               where id = ${why.id}`;
    const versions = (await historyOf("about")).versions.length;

    const refused = await publish("about");
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, "invalid_motion");
    assert.equal((await historyOf("about")).versions.length, versions, "a refused publication left a restore point");
    assert.notEqual((await row(text.id)).draft, null, "another section's draft was published anyway");
    assert.equal((await row(why.id)).motion_config, null);
    assert.equal((await pageBySlug("about")).revision, page.revision);
  });

  test("publishing an empty document removes the advanced motion and keeps the preset beside it", async () => {
    await reset("about");
    const section = await sectionOf("about", "rich-text");
    answered(await saveDocument(section, doc({ base: { entrance: "blur" } })));
    assert.equal((await publish("about")).ok, true);
    answered(await saveDocument(await row(section.id), doc()));
    assert.equal((await publish("about")).ok, true);
    const after = await row(section.id);
    assert.equal(after.motion_config, null, "no advanced motion has one spelling");
    assert.equal(after.animation, "fade", "the section keeps the preset it was publishing");
    assert.match(sectionTag(await live("about"), "rich-text"), /class="reveal reveal-fade"/);
  });
});

/* -------------------------------------------------------------------------- */

describe("discarding throws the document away with everything else", () => {
  test("a page discard clears both motion draft columns", async () => {
    await reset("about");
    const section = await sectionOf("about", "rich-text");
    answered(await saveDocument(section, doc({ base: { entrance: "mask" } })));
    const done = await discardAll("about");
    assert.equal(done.ok, true, JSON.stringify(done));
    const after = await row(section.id);
    assert.equal(after.draft_motion_config, null);
    assert.equal(after.draft_animation, null);
    const summary = await summaryOf("about");
    assert.equal(summary.motionDrafts, 0);
    assert.equal(summary.publishable, false);
  });

  test("the section editor's discard clears them too", async () => {
    await reset("terms");
    const section = await sectionOf("terms", "rich-text");
    answered(await saveDocument(section, doc({}, { "field:body": { base: { entrance: "blur" } } })));
    const current = await row(section.id);
    const screen = await get(server.origin, `/admin/pages/section/${section.id}`, { cookie: owner.cookie });
    const form = formsOn(screen.html).find(
      (candidate) => candidate.includes('name="expectedRevision"') && candidate.includes(">Discard<"),
    );
    assert.ok(form, "no discard form");
    await submitForm(server.origin, `/admin/pages/section/${section.id}`, form, owner.cookie);
    const after = await row(section.id);
    assert.ok(after.revision > current.revision, "the discard did not write");
    assert.equal(after.draft_motion_config, null);
    assert.equal(after.draft_animation, null);
  });
});

/* -------------------------------------------------------------------------- */

describe("history and restore put the document back as a draft", () => {
  test("publish A, publish B, restore A: preview shows A, the site shows B until A is published", async () => {
    await reset("about");
    const section = await sectionOf("about", "rich-text");
    const a = doc({ base: { entrance: "mask", direction: "up" } }, { "field:body": { base: { entrance: "blur" } } });

    answered(await saveDocument(section, a));
    assert.equal((await publish("about")).ok, true);
    const aTag = sectionTag(await live("about"), "rich-text");
    assert.match(aTag, /--m-clip-t:100%/);
    assert.equal((await row(section.id)).animation, "fade-up", "Mask up projects to Fade up");

    // B: back to a plain legacy entrance.
    answered(await saveDocument(await row(section.id), doc({ base: { entrance: "scale-in" } })));
    assert.equal((await publish("about")).ok, true);
    const b = await row(section.id);
    assert.deepEqual(b.motion_config, doc({ base: { entrance: "scale-in" } }));
    assert.equal(b.animation, "scale-in");
    const bTag = sectionTag(await live("about"), "rich-text");

    // The newest restore point is the page as it stood before B: A.
    const [versionA] = (await historyOf("about")).versions;
    const restored = await restore("about", versionA!.id);
    assert.equal(restored.ok, true, JSON.stringify(restored));

    const pending = await row(section.id);
    assert.deepEqual(pending.draft_motion_config, a);
    assert.equal(pending.draft_animation, "fade-up", "the preset A published travels with it");
    assert.deepEqual(pending.motion_config, doc({ base: { entrance: "scale-in" } }), "the restore went live");

    assert.match(sectionTag(await preview("about"), "rich-text"), /--m-clip-t:100%/);
    assert.equal(sectionTag(await live("about"), "rich-text"), bTag, "the live page changed on restore");

    assert.equal((await publish("about")).ok, true);
    const final = await row(section.id);
    assert.deepEqual(final.motion_config, a);
    assert.equal(final.animation, "fade-up");
    assert.equal(sectionTag(await live("about"), "rich-text"), aTag);
  });

  test("restoring a version from before any advanced motion takes the document away again", async () => {
    await reset("terms");
    const section = await sectionOf("terms", "rich-text");
    answered(await saveDocument(section, doc({ base: { entrance: "blur" } })));
    assert.equal((await publish("terms")).ok, true);
    const [before] = (await historyOf("terms")).versions;
    assert.equal((await restore("terms", before!.id)).ok, true);
    assert.deepEqual((await row(section.id)).draft_motion_config, doc(), "an empty draft is the pending removal");
    assert.equal((await publish("terms")).ok, true);
    const after = await row(section.id);
    assert.equal(after.motion_config, null);
    assert.equal(after.animation, "fade-up");
    assert.ok(!/data-m-/.test(await live("terms")));
  });

  test("a restore refuses a page with a motion document pending", async () => {
    await reset("terms");
    const section = await sectionOf("terms", "rich-text");
    answered(await saveDocument(section, doc({ base: { entrance: "blur" } })));
    assert.equal((await publish("terms")).ok, true);
    const [version] = (await historyOf("terms")).versions;
    answered(await saveDocument(await row(section.id), doc({}, { "field:body": { base: { entrance: "mask" } } })));
    await sql`update page_sections set draft_animation = null where id = ${section.id}`;
    const refused = await restore("terms", version!.id);
    assert.equal(refused.ok, false);
    assert.deepEqual((await row(section.id)).draft_motion_config, doc({}, { "field:body": { base: { entrance: "mask" } } }));
  });
});

/* -------------------------------------------------------------------------- */

describe("a duplicate carries its own motion, pointed at its own rows", () => {
  test("list and row paths are remapped to the copy's ids; a row the copy lacks is dropped", async () => {
    await reset("about");
    const page = await pageBySlug("about");
    const source = await sectionOf("about", "why-us");
    const points = (source.published.points as { _id: string }[]).map((point) => point._id);
    assert.ok(points.length >= 2, "the fixture's why-us has too few points");
    const gone = "i_" + "Z".repeat(10);
    const motion = doc(
      { base: { entrance: "blur" } },
      {
        "field:title": { base: { entrance: "mask" } },
        "field:points": { base: { entrance: "fade-up", stagger: "normal" } },
        [`field:points/item:${points[0]}/field:label`]: { base: { entrance: "blur" } },
        [`field:points/item:${gone}`]: { base: { entrance: "fade" } },
      },
    );
    answered(await saveDocument(source, motion));

    const form = pageForm(page, { sectionId: String(source.id) });
    const copied = answered(await editorAction<{ ok: boolean; sectionId?: number | null }>("duplicatePageSection", form));
    assert.equal(copied.ok, true, JSON.stringify(copied));
    const copy = await row(copied.sectionId!);
    const copyPoints = (copy.published.points as { _id: string }[]).map((point) => point._id);

    assert.equal(copy.draft_motion_config, null, "a new section has nothing pending of its own");
    assert.equal(copy.animation, "fade", "the copy's preset is its own projection");
    const stored = copy.motion_config!;
    assert.deepEqual(stored.section, motion.section);
    assert.deepEqual(Object.keys(stored.nodes).sort(), [
      "field:points",
      `field:points/item:${copyPoints[0]}/field:label`,
      "field:title",
    ].sort());
    for (const id of [...points, gone]) {
      assert.ok(!JSON.stringify(stored).includes(id), `the copy's motion still names ${id}`);
    }
    // The original is read, never written.
    assert.deepEqual((await row(source.id)).draft_motion_config, motion);
  });
});

/* -------------------------------------------------------------------------- */

describe("the classic section form and the document", () => {
  const screenOf = async (id: number) =>
    (await get(server.origin, `/admin/pages/section/${id}`, { cookie: owner.cookie })).html;

  async function saveDraftThroughForm(id: number, animation?: string) {
    const url = `/admin/pages/section/${id}`;
    const html = await screenOf(id);
    const form = formsOn(html).find((candidate) => candidate.includes('name="animation"'));
    assert.ok(form, "no section form");
    return submitForm(server.origin, url, form, owner.cookie, animation === undefined ? {} : { animation });
  }

  test("an untouched menu leaves an advanced section's motion exactly as it is", async () => {
    await reset("disclaimer");
    const section = await sectionOf("disclaimer", "rich-text");
    answered(await saveDocument(section, doc({ base: { entrance: "blur" } }, { "field:body": { base: { entrance: "mask" } } })));
    assert.equal((await publish("disclaimer")).ok, true);
    const published = await row(section.id);

    const html = await screenOf(section.id);
    assert.match(html, /data-advanced-motion="true"/);
    assert.match(/<select[^>]*name="animation"[\s\S]*?<\/select>/.exec(html)?.[0] ?? "", /value="fade"[^>]*selected/);

    await saveDraftThroughForm(section.id);
    const after = await row(section.id);
    assert.equal(after.draft_motion_config, null, "an untouched menu wrote a motion draft");
    assert.equal(after.draft_animation, null);
    assert.deepEqual(after.motion_config, published.motion_config);
  });

  test("a changed menu becomes the section's own entrance and keeps every element's", async () => {
    await reset("disclaimer");
    const section = await sectionOf("disclaimer", "rich-text");
    answered(await saveDocument(section, doc({ base: { entrance: "blur" } }, { "field:body": { base: { entrance: "mask" } } })));
    assert.equal((await publish("disclaimer")).ok, true);

    await saveDraftThroughForm(section.id, "scale-in");
    const after = await row(section.id);
    assert.deepEqual(after.draft_motion_config, doc({ base: { entrance: "scale-in" } }, { "field:body": { base: { entrance: "mask" } } }));
    assert.equal(after.draft_animation, "scale-in");
    // And it renders on the legacy class, with the element's mask intact.
    const wrapper = sectionTag(await preview("disclaimer"), "rich-text");
    assert.match(wrapper, /class="reveal reveal-scale"/);
  });

  test("a section with no document is written exactly as in Batch 9", async () => {
    await reset("disclaimer");
    const section = await sectionOf("disclaimer", "rich-text");
    assert.ok(!/data-advanced-motion/.test(await screenOf(section.id)));
    await saveDraftThroughForm(section.id, "slide-in");
    const after = await row(section.id);
    assert.equal(after.draft_animation, "slide-in");
    assert.equal(after.draft_motion_config, null, "a legacy section was given a document");
    assert.equal(after.motion_config, null);
  });
});

/* -------------------------------------------------------------------------- */

describe("the storage the previous release shares", () => {
  test("the two new columns are nullable jsonb with no default, beside the legacy pair", async () => {
    const columns = await sql<{ column_name: string; data_type: string; is_nullable: string; column_default: string | null }[]>`
      select column_name, data_type, is_nullable, column_default from information_schema.columns
       where table_name = 'page_sections'
         and column_name in ('animation', 'draft_animation', 'motion_config', 'draft_motion_config')
       order by column_name`;
    assert.deepEqual(
      columns.map((column) => ({ ...column })),
      [
        { column_name: "animation", data_type: "character varying", is_nullable: "NO", column_default: "'fade-up'::character varying" },
        { column_name: "draft_animation", data_type: "character varying", is_nullable: "YES", column_default: null },
        { column_name: "draft_motion_config", data_type: "jsonb", is_nullable: "YES", column_default: null },
        { column_name: "motion_config", data_type: "jsonb", is_nullable: "YES", column_default: null },
      ],
    );
  });

  test("no seeded section carries a document: every existing row is legacy-only", async () => {
    const [counts] = await sql<{ docs: number; drafts: number }[]>`
      select count(motion_config)::int as docs, count(draft_motion_config)::int as drafts
        from eodt_sections_backup`;
    assert.deepEqual({ ...counts }, { docs: 0, drafts: 0 });
  });

  test("whatever is published, the legacy column is always one of the five", async () => {
    const values = await sql<{ animation: string }[]>`select distinct animation from page_sections`;
    for (const { animation } of values) {
      assert.ok(["fade-up", "fade", "slide-in", "scale-in", "none"].includes(animation), animation);
    }
    const drafts = await sql<{ draft_animation: string }[]>`
      select distinct draft_animation from page_sections where draft_animation is not null`;
    for (const { draft_animation } of drafts) {
      assert.ok(["fade-up", "fade", "slide-in", "scale-in", "none"].includes(draft_animation), draft_animation);
    }
  });
});
