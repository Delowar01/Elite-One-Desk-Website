/**
 * Editing content in the Visual Editor, against the running application.
 *
 * The governing rule of the batch is one sentence: **a content change is saved
 * to `page_sections.draft`, never to the published website.** Most of what
 * follows is that sentence asked in different ways — what moved, what did not,
 * and what happens when two people ask at once.
 *
 * Everything here goes through the real Server Actions over HTTP, with the
 * session cookie, the CSRF token and the origin a browser sends (see
 * `helpers/action.ts`). Nothing is mocked and there is no test-only endpoint:
 * what is proved is what an editor gets.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { callAction, type ActionResponse } from "./helpers/action";
import { giveFresh } from "./helpers/fixtures";
import { formContaining, formsOn, get, submitForm } from "./helpers/http";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { startServer, isBuilt, BUILD_HINT, type Server } from "./helpers/server";
import { signIn, type TestSession } from "./helpers/session";

import { ITEM_ID_KEY, isItemId } from "@/lib/cms/item-id";
import type {
  VisualContentSaveResult,
  VisualSectionLoad,
} from "@/lib/visual-editor/content";

const PORT = 3443;
const ACTIONS = "app/(backoffice)/admin/visual-editor/actions.ts";
const ROUTE = "/admin/visual-editor";
/** The ordinary Pages & sections actions, reached the same way. */
const PAGE_ACTIONS = "app/(backoffice)/admin/(shell)/pages/actions.ts";

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
  is_published: boolean;
  is_draft_only: boolean;
  animation: string;
  position: number;
  styles: Record<string, unknown>;
  updated_by: number | null;
};

const row = async (id: number): Promise<SectionRow> => {
  const [found] = await sql<SectionRow[]>`
    select id, page_id, revision, block_type, draft, published, is_published,
           is_draft_only, animation, position, styles, updated_by
      from page_sections where id = ${id}
  `;
  assert.ok(found, `section ${id} is missing`);
  return found;
};

/**
 * The first section of a page with this block type, with any draft cleared.
 *
 * Every test here writes drafts, and a draft is what the next `load` reads —
 * so without this each test would be starting from whatever the one before it
 * typed. Clearing it in SQL rather than through the panel keeps the setup out
 * of what is being measured.
 */
async function find(slug: string, blockType: string): Promise<SectionRow> {
  const [found] = await sql<{ id: number }[]>`
    select s.id from page_sections s join pages p on p.id = s.page_id
     where p.slug = ${slug} and s.block_type = ${blockType}
     order by s.position limit 1
  `;
  assert.ok(found, `no ${blockType} on /${slug}`);
  await sql`update page_sections set draft = null where id = ${found.id}`;
  return row(found.id);
}

/** `null` means signed out — spelled out, so it cannot be an accidental default. */
const load = (sectionId: number, pageId: number, cookie: string | null = owner.cookie) =>
  callAction<VisualSectionLoad>({
    origin: server.origin,
    route: ROUTE,
    file: ACTIONS,
    action: "loadVisualSection",
    args: [sectionId, pageId],
    cookie: cookie ?? undefined,
  });

/** Loads a section and hands back its values to edit, plus the revision to name. */
async function open(section: SectionRow) {
  return succeeded(await load(section.id, section.page_id)).section;
}

async function save(
  fields: Record<string, string>,
  options: { cookie?: string | null; csrf?: string | null } = {},
) {
  const form = new FormData();
  const csrf = options.csrf === undefined ? owner.csrfToken : options.csrf;
  if (csrf !== null) form.set("_csrf", csrf);
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return callAction<VisualContentSaveResult>({
    origin: server.origin,
    route: ROUTE,
    file: ACTIONS,
    action: "saveVisualSectionDraft",
    args: [form],
    cookie: options.cookie === undefined ? owner.cookie : (options.cookie ?? undefined),
  });
}

/** The ordinary "save a draft" round trip, for the sections one section id. */
const saveValues = (
  section: { sectionId: number; pageId: number; revision: number },
  values: Record<string, unknown>,
  options?: { cookie?: string | null; csrf?: string | null },
) =>
  save(
    {
      sectionId: String(section.sectionId),
      pageId: String(section.pageId),
      expectedRevision: String(section.revision),
      values: JSON.stringify(values),
    },
    options,
  );

/** The value the action returned. A silent action is a failure, not a null. */
function answered<T>(response: ActionResponse<T>): T {
  assert.ok(response.value, `the action returned nothing (status ${response.status})`);
  return response.value;
}

/** …and it succeeded. Narrowed, so a test can read the payload. */
function succeeded<T extends { ok: boolean }>(response: ActionResponse<T>): Extract<T, { ok: true }> {
  const value = answered(response);
  assert.ok(value.ok, `the action refused: ${JSON.stringify(value)}`);
  return value as Extract<T, { ok: true }>;
}

/**
 * …and it was refused, for this reason and no other.
 *
 * Narrowed by the reason as well as by the failure, so a test that asks for a
 * conflict gets back the thing only a conflict carries — the version that won.
 */
function refused<T extends { ok: boolean }, R extends string>(
  response: ActionResponse<T>,
  reason: R,
): Extract<T, { ok: false; reason: R }> {
  const value = answered(response);
  assert.ok(!value.ok, `the action was allowed: ${JSON.stringify(value)}`);
  assert.equal((value as unknown as { reason: string }).reason, reason);
  return value as Extract<T, { ok: false; reason: R }>;
}

/**
 * The one form on a page whose markup carries all of these.
 *
 * `formContaining` takes a single needle, and React splits interpolated text
 * with comment markers — "Publish 2 drafts" is really
 * `Publish <!-- -->2<!-- --> draft<!-- -->s` — so a button label is not a
 * reliable needle on its own.
 */
function formWith(html: string, ...needles: string[]): string {
  const form = formsOn(html).find((candidate) => needles.every((n) => candidate.includes(n)));
  if (!form) throw new Error(`no form contains ${needles.join(" + ")}`);
  return form;
}

const localised = (value: unknown) => value as { en: string; ar: string };
const rows = (value: unknown) => value as Record<string, unknown>[];

before(async () => {
  assert.ok(isBuilt(), BUILD_HINT);
  database = giveFresh("visual_content");
  sql = connect(database);
  owner = await signIn(sql);
  // A reader, so "read-only" can be asked of the application rather than of the
  // permission table. Provisioned directly: the password is never used, because
  // `signIn` writes the session row the same way a successful login does.
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

describe("a save is a draft, and touches nothing else", () => {
  test("the draft moves, the published values and every other column stay", async () => {
    const before = await find("home", "hero");
    const section = await open(before);

    const headline = { ...localised(section.values.headline), en: "One Desk. Edited." };
    const saved = succeeded(await saveValues(section, { ...section.values, headline }));

    assert.equal(saved.section.revision, before.revision + 1);
    assert.equal(saved.section.hasDraft, true);

    const after = await row(before.id);
    assert.equal(localised(after.draft?.headline).en, "One Desk. Edited.");
    assert.deepEqual(after.published, before.published, "the live values moved");
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.updated_by, owner.userId);

    // Everything a content save must not be able to do.
    assert.equal(after.is_published, before.is_published);
    assert.equal(after.is_draft_only, before.is_draft_only);
    assert.equal(after.animation, before.animation);
    assert.equal(after.position, before.position);
    assert.equal(after.page_id, before.page_id);
    assert.deepEqual(after.styles, before.styles);
  });

  test("the live site does not move; the preview does", async () => {
    const section = await open(await find("home", "hero"));
    const lead = { ...localised(section.values.lead), en: "A sentence only a draft knows." };
    succeeded(await saveValues(section, { ...section.values, lead }));

    const live = await get(server.origin, "/");
    assert.ok(!live.html.includes("A sentence only a draft knows."), "a draft reached a visitor");

    const preview = await get(server.origin, "/?preview=1", { cookie: owner.cookie });
    assert.ok(preview.html.includes("A sentence only a draft knows."), "the preview did not update");
  });

  test("a second save names the revision the first produced", async () => {
    const first = await open(await find("home", "one-desk"));
    const one = succeeded(await saveValues(first, { ...first.values, eyebrow: { en: "One", ar: "" } }));

    const two = succeeded(
      await saveValues(
        { ...first, revision: one.section.revision },
        { ...first.values, eyebrow: { en: "Two", ar: "" } },
      ),
    );
    assert.equal(two.section.revision, first.revision + 2);
    assert.equal(localised((await row(first.sectionId)).draft?.eyebrow).en, "Two");
  });
});

/* -------------------------------------------------------------------------- */

describe("there is one validator, and the Visual Editor goes through it", () => {
  test("rich text keeps the whitelist and loses everything else", async () => {
    const section = await open(await find("privacy", "rich-text"));
    const saved = succeeded(
      await saveValues(section, {
        ...section.values,
        body: {
          en: '<p>Keep <strong>this</strong>.</p><script>alert(1)</script><iframe src="x"></iframe>',
          ar: "",
        },
      }),
    );

    const stored = localised(saved.section.values.body).en;
    assert.match(stored, /<p>Keep <strong>this<\/strong>\.<\/p>/);
    assert.ok(!/<script|<iframe/i.test(stored), "markup survived the whitelist");
    assert.equal(localised((await row(section.sectionId)).draft?.body).en, stored);
  });

  test("an unsafe link is stripped and an undeclared key never lands", async () => {
    const section = await open(await find("home", "hero"));
    succeeded(
      await saveValues(section, {
        ...section.values,
        primaryCtaHref: "javascript:alert(1)",
        somethingInvented: "should not be stored",
      }),
    );

    const draft = (await row(section.sectionId)).draft!;
    assert.equal(draft.primaryCtaHref, "");
    assert.ok(!("somethingInvented" in draft), "an undeclared key was stored");
  });

  test("a row keeps only its declared fields, and its id", async () => {
    const section = await open(await find("home", "quick-links"));
    const links = rows(section.values.links);
    const first = { ...links[0]!, sneaky: "no", icon: "notARealIcon" };
    succeeded(await saveValues(section, { ...section.values, links: [first, ...links.slice(1)] }));

    const stored = rows((await row(section.sectionId)).draft!.links)[0]!;
    assert.ok(!("sneaky" in stored), "an undeclared row key was stored");
    assert.equal(stored.icon, "", "an icon outside the set was stored");
    assert.equal(stored[ITEM_ID_KEY], links[0]![ITEM_ID_KEY]);
  });

  test("a media field is a library id or nothing", async () => {
    const section = await open(await find("home", "quick-links"));
    const links = rows(section.values.links);
    succeeded(
      await saveValues(section, {
        ...section.values,
        links: [
          { ...links[0]!, image: 2 },
          { ...links[1]!, image: "/media/somewhere-else.webp" },
        ],
      }),
    );

    const stored = rows((await row(section.sectionId)).draft!.links);
    assert.equal(stored[0]!.image, 2);
    assert.equal(stored[1]!.image, null, "a path was accepted where an id belongs");
  });

  test("an icon from the set survives", async () => {
    const section = await open(await find("home", "quick-links"));
    const links = rows(section.values.links);
    succeeded(
      await saveValues(section, { ...section.values, links: [{ ...links[0]!, icon: "sparkle" }] }),
    );
    assert.equal(rows((await row(section.sectionId)).draft!.links)[0]!.icon, "sparkle");
  });
});

/* -------------------------------------------------------------------------- */

describe("a language is edited on its own", () => {
  test("writing Arabic leaves the English alone", async () => {
    const section = await open(await find("home", "hero"));
    const english = localised(section.values.headline).en;

    succeeded(
      await saveValues(section, {
        ...section.values,
        headline: { en: english, ar: "مكتب واحد — مسودة" },
      }),
    );

    const stored = localised((await row(section.sectionId)).draft!.headline);
    assert.equal(stored.ar, "مكتب واحد — مسودة");
    assert.equal(stored.en, english);
  });

  test("an empty Arabic value stays empty — the English is never copied in", async () => {
    const section = await open(await find("home", "hero"));
    const english = "Only English here.";

    succeeded(
      await saveValues(section, { ...section.values, headline: { en: english, ar: "" } }),
    );

    const stored = localised((await row(section.sectionId)).draft!.headline);
    assert.equal(stored.ar, "", "the English text was copied into Arabic");
    assert.equal(stored.en, english);

    // And the site still reads as one language, because the fallback is at
    // render time rather than in the stored value.
    const arabic = await get(server.origin, "/ar?preview=1", { cookie: owner.cookie });
    assert.ok(arabic.html.includes(english), "the Arabic edition did not fall back");
  });
});

/* -------------------------------------------------------------------------- */

describe("a repeatable row keeps its identity", () => {
  test("reordering and editing changes neither the ids nor which row is which", async () => {
    const section = await open(await find("home", "quick-links"));
    const links = rows(section.values.links);
    assert.ok(links.length >= 3, "this test needs three links");
    const ids = links.map((link) => link[ITEM_ID_KEY]);

    const reordered = [links[2]!, links[0]!, links[1]!, ...links.slice(3)];
    reordered[0] = { ...reordered[0]!, label: { en: "Moved and renamed", ar: "" } };

    succeeded(await saveValues(section, { ...section.values, links: reordered }));

    const stored = rows((await row(section.sectionId)).draft!.links);
    assert.deepEqual(
      stored.map((link) => link[ITEM_ID_KEY]),
      [ids[2], ids[0], ids[1], ...ids.slice(3)],
    );
    assert.equal(localised(stored[0]!.label).en, "Moved and renamed");
  });

  test("a new row is given an id; a repeated one is replaced", async () => {
    const section = await open(await find("home", "quick-links"));
    const links = rows(section.values.links);
    const keep = links[0]!;

    succeeded(
      await saveValues(section, {
        ...section.values,
        links: [
          keep,
          { label: { en: "Brand new", ar: "" }, href: "/contact", icon: "", image: null },
          { ...links[1]!, [ITEM_ID_KEY]: keep[ITEM_ID_KEY] },
        ],
      }),
    );

    const stored = rows((await row(section.sectionId)).draft!.links);
    const storedIds = stored.map((link) => String(link[ITEM_ID_KEY]));

    assert.equal(storedIds[0], keep[ITEM_ID_KEY], "the untouched row lost its id");
    assert.ok(isItemId(storedIds[1]), "a new row got no id");
    assert.ok(isItemId(storedIds[2]), "a repeated id was not replaced");
    assert.equal(new Set(storedIds).size, 3, "two rows answer to one id");
  });
});

/* -------------------------------------------------------------------------- */

describe("two editors, one section", () => {
  test("a save on a revision that has moved is refused, and offers the version that won", async () => {
    const section = await open(await find("about", "page-hero"));

    const first = succeeded(
      await saveValues(section, { ...section.values, title: { en: "First", ar: "" } }),
    );

    const second = refused(
      await saveValues(section, { ...section.values, title: { en: "Second", ar: "" } }),
      "conflict",
    );
    assert.match(second.message, /changed while you were editing/i);

    // The conflict carries the stored version, which is the only thing worth
    // offering somebody who has just lost a race.
    assert.equal(second.section.revision, first.section.revision);
    assert.equal(localised(second.section.values.title).en, "First");

    const after = await row(section.sectionId);
    assert.equal(localised(after.draft!.title).en, "First", "the later save won anyway");
    assert.equal(after.revision, first.section.revision);
  });

  test("the ordinary section editor advances the revision, so the canvas conflicts", async () => {
    const section = await open(await find("contact", "page-hero"));

    // Somebody saves from Admin → Pages & sections while the canvas is open.
    const page = await get(server.origin, `/admin/pages/section/${section.sectionId}`, {
      cookie: owner.cookie,
    });
    const form = formContaining(page.html, "Save draft");
    const submitted = await submitForm(
      server.origin,
      `/admin/pages/section/${section.sectionId}`,
      form,
      owner.cookie,
    );
    assert.ok(submitted.status < 400);
    assert.equal((await row(section.sectionId)).revision, section.revision + 1);

    // The canvas, still holding the revision it read, is refused.
    refused(await saveValues(section, { ...section.values, title: { en: "Canvas", ar: "" } }), "conflict");
  });

  test("and the other way round: a stale admin form is refused too", async () => {
    const section = await open(await find("about", "image-text"));

    // The admin screen is opened first, so its form carries this revision.
    const url = `/admin/pages/section/${section.sectionId}`;
    const page = await get(server.origin, url, { cookie: owner.cookie });
    const form = formContaining(page.html, "Save draft");
    assert.match(form, new RegExp(`name="expectedRevision" value="${section.revision}"`));

    // The Visual Editor saves in between.
    succeeded(await saveValues(section, { ...section.values, title: { en: "Canvas first", ar: "" } }));

    const submitted = await submitForm(server.origin, url, form, owner.cookie);
    assert.match(submitted.html, /changed while you were editing/i);
    assert.equal(
      localised((await row(section.sectionId)).draft!.title).en,
      "Canvas first",
      "the stale form overwrote the newer draft",
    );
  });
});

/* -------------------------------------------------------------------------- */

/**
 * Submits the section editor's fields to one of its two actions.
 *
 * Which action is the whole of the intent — there is no field in the request
 * that says "publish". `saveSectionDraft` is what the form's own action is, and
 * so what the Enter key reaches; `saveSectionAndPublish` is reached only by
 * pressing the button that says so.
 */
function sectionWrite(
  action: "saveSectionDraft" | "saveSectionAndPublish",
  fields: Record<string, string>,
  options: { cookie?: string | null; csrf?: string | null } = {},
) {
  const form = new FormData();
  const csrf = options.csrf === undefined ? owner.csrfToken : options.csrf;
  if (csrf !== null) form.set("_csrf", csrf);
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return callAction<{ ok: boolean; message?: string }>({
    origin: server.origin,
    route: `/admin/pages/section/${fields.id}`,
    file: PAGE_ACTIONS,
    action,
    args: [{ ok: false }, form],
    cookie: options.cookie === undefined ? owner.cookie : (options.cookie ?? undefined),
  });
}

const sectionFields = (
  section: { sectionId: number; revision: number },
  values: Record<string, unknown>,
) => ({
  id: String(section.sectionId),
  expectedRevision: String(section.revision),
  values: JSON.stringify(values),
});

/** What the activity log last recorded about this section. */
async function lastActivity(sectionId: number) {
  const [entry] = await sql<{ action: string; user_id: number | null }[]>`
    select action, user_id from activity_logs
     where entity_type = 'section' and entity_id = ${String(sectionId)}
     order by id desc limit 1`;
  return entry ?? null;
}

describe("Save and publish publishes, in one guarded write", () => {
  test("the values go live, the draft is cleared, and it is logged as a publish", async () => {
    const section = await open(await find("privacy", "page-hero"));

    const result = await sectionWrite(
      "saveSectionAndPublish",
      sectionFields(section, { ...section.values, title: { en: "Live at once", ar: "" } }),
    );
    assert.equal(answered(result).ok, true, JSON.stringify(result.value));
    assert.match(answered(result).message ?? "", /live now/i);

    const after = await row(section.sectionId);
    assert.equal(localised(after.published.title).en, "Live at once");
    assert.equal(after.draft, null, "a draft was left behind");
    assert.equal(after.is_published, true);
    assert.equal(after.revision, section.revision + 1, "more than one write happened");
    assert.equal(after.updated_by, owner.userId);
    assert.equal((await lastActivity(section.sectionId))?.action, "section.published");
  });

  test("and a visitor sees it, with no publish step in between", async () => {
    const section = await open(await find("about", "page-hero"));
    const sentence = "Published straight from the section editor.";

    const result = await sectionWrite(
      "saveSectionAndPublish",
      sectionFields(section, { ...section.values, lead: { en: sentence, ar: "" } }),
    );
    assert.equal(answered(result).ok, true);

    const live = await get(server.origin, "/about");
    assert.ok(live.html.includes(sentence), "the live page did not change");
  });

  test("Save draft is still draft-only, and logged as one", async () => {
    const section = await open(await find("contact", "page-hero"));
    const before = await row(section.sectionId);

    const result = await sectionWrite(
      "saveSectionDraft",
      sectionFields(section, { ...section.values, title: { en: "Only a draft", ar: "" } }),
    );
    assert.equal(answered(result).ok, true);

    const after = await row(section.sectionId);
    assert.equal(localised(after.draft!.title).en, "Only a draft");
    assert.deepEqual(after.published, before.published, "Save draft touched the live version");
    assert.equal(after.revision, before.revision + 1);
    assert.equal((await lastActivity(section.sectionId))?.action, "section.draft_saved");

    const live = await get(server.origin, "/contact");
    assert.ok(!live.html.includes("Only a draft"), "a draft reached a visitor");
    const preview = await get(server.origin, "/contact?preview=1", { cookie: owner.cookie });
    assert.ok(preview.html.includes("Only a draft"), "the preview did not show the draft");
  });

  test("publishing from a screen that has been overtaken is refused", async () => {
    const section = await open(await find("disclaimer", "page-hero"));
    const publishedBefore = (await row(section.sectionId)).published;

    // The Visual Editor saves a newer draft while the section screen sits open.
    const newer = succeeded(
      await saveValues(section, { ...section.values, title: { en: "Canvas draft", ar: "" } }),
    );

    const refusal = answered(
      await sectionWrite(
        "saveSectionAndPublish",
        sectionFields(section, { ...section.values, title: { en: "Stale publish", ar: "" } }),
      ),
    );
    assert.equal(refusal.ok, false);
    assert.match(refusal.message ?? "", /Reload the page before publishing/i);

    const after = await row(section.sectionId);
    assert.deepEqual(after.published, publishedBefore, "something went live");
    assert.equal(localised(after.draft!.title).en, "Canvas draft", "the newer draft was disturbed");
    assert.equal(after.revision, newer.section.revision, "the refused publish moved the revision");
  });

  test("a publish naming no revision at all is refused", async () => {
    const section = await open(await find("terms", "page-hero"));
    const before = await row(section.sectionId);

    const refusal = answered(
      await sectionWrite("saveSectionAndPublish", {
        id: String(section.sectionId),
        values: JSON.stringify({ ...section.values, title: { en: "No revision", ar: "" } }),
      }),
    );
    assert.equal(refusal.ok, false);
    assert.match(refusal.message ?? "", /could not be read/i);

    const after = await row(section.sectionId);
    assert.deepEqual(after.published, before.published);
    assert.equal(after.revision, before.revision);
  });

  test("publishing goes through the same validator — it is a destination, not a bypass", async () => {
    const section = await open(await find("privacy", "rich-text"));

    const result = await sectionWrite(
      "saveSectionAndPublish",
      sectionFields(section, {
        ...section.values,
        title: { en: "Sanitised on the way live", ar: "" },
        body: { en: '<p>Kept.</p><script>alert(1)</script>', ar: "" },
        somethingInvented: "should not be stored",
      }),
    );
    assert.equal(answered(result).ok, true);

    const published = (await row(section.sectionId)).published;
    assert.match(localised(published.body).en, /<p>Kept\.<\/p>/);
    assert.ok(!/<script/i.test(localised(published.body).en), "markup went live");
    assert.ok(!("somethingInvented" in published), "an undeclared key went live");
  });

  test("a full payload publishes exactly as it would have been drafted", async () => {
    const section = await open(await find("home", "quick-links"));
    const links = rows(section.values.links);
    const ids = links.map((link) => link[ITEM_ID_KEY]);

    const payload = {
      ...section.values,
      title: { en: "Where to start", ar: "من أين تبدأ" },
      links: [
        { ...links[0]!, icon: "sparkle", image: 2, href: "javascript:alert(1)" },
        ...links.slice(1),
      ],
    };

    const result = await sectionWrite("saveSectionAndPublish", sectionFields(section, payload));
    assert.equal(answered(result).ok, true);

    const published = (await row(section.sectionId)).published;
    assert.equal(localised(published.title).ar, "من أين تبدأ", "the Arabic half was lost");
    const stored = rows(published.links);
    assert.deepEqual(
      stored.map((link) => link[ITEM_ID_KEY]),
      ids,
      "a row lost its identity on the way live",
    );
    assert.equal(stored[0]!.icon, "sparkle");
    assert.equal(stored[0]!.image, 2, "the media id did not survive");
    assert.equal(stored[0]!.href, "", "an unsafe link went live");
  });
});

/* -------------------------------------------------------------------------- */

/**
 * The admin section screen as it looked at one moment, with the two forms it
 * draws for a section that has a draft.
 *
 * Captured as markup and submitted later, which is the whole point: a screen is
 * rendered once and can sit open for an hour. Replaying its forms is what a
 * person clicking a button on a stale tab actually does.
 */
async function adminScreen(sectionId: number) {
  const url = `/admin/pages/section/${sectionId}`;
  const { html } = await get(server.origin, url, { cookie: owner.cookie });
  const publish = formWith(html, 'name="expectedRevision"', ">Publish draft<");
  const discard = formWith(html, 'name="expectedRevision"', ">Discard<");
  return {
    url,
    publish,
    discard,
    revision: Number(/name="expectedRevision" value="(\d+)"/.exec(publish)?.[1] ?? -1),
  };
}

/** A section with a draft, and the screen that was showing it. */
async function draftAndScreen(title: string) {
  const section = await open(await find("privacy", "page-hero"));
  const saved = succeeded(
    await saveValues(section, { ...section.values, title: { en: title, ar: "" } }),
  );
  const screen = await adminScreen(section.sectionId);
  assert.equal(screen.revision, saved.section.revision, "the screen named a different revision");
  return { section, saved, screen };
}

describe("a screen left open cannot publish or discard what it never saw", () => {
  test("a stale Publish draft is refused, and publishes nothing", async () => {
    const { section, saved, screen } = await draftAndScreen("Draft one");
    const publishedBefore = (await row(section.sectionId)).published;

    // The Visual Editor saves a newer draft. The old screen still says
    // "Unpublished draft" and its button still works — that is the problem.
    const newer = succeeded(
      await saveValues(
        { ...section, revision: saved.section.revision },
        { ...section.values, title: { en: "Draft two", ar: "" } },
      ),
    );
    assert.equal((await row(section.sectionId)).revision, saved.section.revision + 1);

    const submitted = await submitForm(server.origin, screen.url, screen.publish, owner.cookie);
    assert.match(submitted.html, /Reload the page before publishing/i);

    const after = await row(section.sectionId);
    assert.equal(localised(after.draft!.title).en, "Draft two", "the newer draft did not survive");
    assert.deepEqual(after.published, publishedBefore, "something was published");
    assert.equal(after.revision, newer.section.revision, "a refused publish moved the revision");
  });

  test("a stale Discard is refused, and deletes nothing", async () => {
    const { section, saved, screen } = await draftAndScreen("Draft one");

    const newer = succeeded(
      await saveValues(
        { ...section, revision: saved.section.revision },
        { ...section.values, title: { en: "Draft two", ar: "" } },
      ),
    );
    assert.equal((await row(section.sectionId)).revision, saved.section.revision + 1);

    const submitted = await submitForm(server.origin, screen.url, screen.discard, owner.cookie);
    assert.match(submitted.html, /Reload the page before discarding/i);

    const after = await row(section.sectionId);
    assert.ok(after.draft, "the newer draft was deleted by a stale screen");
    assert.equal(localised(after.draft.title).en, "Draft two", "the newer draft was changed");
    assert.equal(after.revision, newer.section.revision);
  });

  test("two tabs belonging to one person still conflict — updated_by is not the guard", async () => {
    const { section, screen } = await draftAndScreen("One draft, two tabs");
    const second = await adminScreen(section.sectionId);
    assert.equal(second.revision, screen.revision, "the two tabs disagree about the revision");

    // The first tab publishes.
    const first = await submitForm(server.origin, screen.url, screen.publish, owner.cookie);
    assert.ok(!/Reload the page/i.test(first.html), "a fresh publish was refused");
    const between = await row(section.sectionId);
    assert.equal(between.draft, null);
    assert.equal(between.updated_by, owner.userId);

    // The second tab looks identical and is the same signed-in person, so
    // nothing about *who* is asking could tell these two apart. Only the
    // counter can, and it does.
    const again = await submitForm(server.origin, second.url, second.publish, owner.cookie);
    assert.match(again.html, /Reload the page before publishing/i);

    const after = await row(section.sectionId);
    assert.equal(after.revision, between.revision, "the refused second publish moved the revision");
    assert.equal(after.updated_by, owner.userId, "the same person either way");
    assert.deepEqual(after.published, between.published);
  });

  test("a reloaded screen publishes normally", async () => {
    const { section, saved, screen } = await draftAndScreen("Ready to go");

    const result = await submitForm(server.origin, screen.url, screen.publish, owner.cookie);
    assert.ok(!/Reload the page/i.test(result.html), "a current screen was refused");

    const after = await row(section.sectionId);
    assert.equal(localised(after.published.title).en, "Ready to go");
    assert.equal(after.draft, null);
    assert.equal(after.revision, saved.section.revision + 1);
    assert.equal(after.updated_by, owner.userId);
  });

  test("and a reloaded screen discards normally", async () => {
    const before = await row((await find("privacy", "page-hero")).id);
    const { section, saved, screen } = await draftAndScreen("Never mind");

    const result = await submitForm(server.origin, screen.url, screen.discard, owner.cookie);
    assert.ok(!/Reload the page/i.test(result.html), "a current screen was refused");

    const after = await row(section.sectionId);
    assert.equal(after.draft, null);
    assert.equal(after.revision, saved.section.revision + 1);
    assert.deepEqual(after.published, before.published, "discarding changed the live version");
  });

  test("a form carrying no revision at all is refused rather than defaulted", async () => {
    const { section, screen } = await draftAndScreen("Still here");

    for (const form of [screen.publish, screen.discard]) {
      const older = form.replace(/<input type="hidden" name="expectedRevision"[^>]*\/>/, "");
      assert.ok(!older.includes("expectedRevision"), "the field was not removed");
      const submitted = await submitForm(server.origin, screen.url, older, owner.cookie);
      assert.match(submitted.html, /could not be read/i);
    }

    const after = await row(section.sectionId);
    assert.equal(localised(after.draft!.title).en, "Still here");
  });
});

/* -------------------------------------------------------------------------- */

describe("publishing a whole page is all or nothing", () => {
  /**
   * A section moving underneath a publish-all is hard to arrange from outside
   * the transaction, so the database arranges it: a trigger that bumps the
   * *other* sections' revisions the moment one of them is published. From the
   * action's point of view that is indistinguishable from a colleague saving
   * mid-publish — which is exactly the condition under test — and it happens
   * at a moment no test could otherwise reach.
   */
  test("one section changing mid-publish rolls the whole page back", async () => {
    const hero = await find("terms", "page-hero");
    const text = await find("terms", "rich-text");

    for (const section of [hero, text]) {
      const opened = await open(section);
      succeeded(
        await saveValues(opened, {
          ...opened.values,
          title: { en: `Draft for ${section.id}`, ar: "" },
          eyebrow: { en: `Draft for ${section.id}`, ar: "" },
        }),
      );
    }
    assert.ok((await row(hero.id)).draft);
    assert.ok((await row(text.id)).draft);

    await sql.unsafe(`
      create or replace function eodt_bump_siblings() returns trigger as $$
      begin
        update page_sections set revision = revision + 1
         where page_id = new.page_id and id <> new.id;
        return null;
      end $$ language plpgsql;
      create trigger eodt_bump after update on page_sections
        for each row when (old.draft is not null and new.draft is null)
        execute function eodt_bump_siblings();
    `);

    const url = "/admin/pages/terms";
    const page = await get(server.origin, url, { cookie: owner.cookie });
    const form = formWith(page.html, 'name="pageId"', ">Publish");
    const refused = await submitForm(server.origin, url, form, owner.cookie);
    assert.match(refused.html, /Nothing was published/i);

    // Neither section went out — not the one the transaction reached first.
    assert.ok((await row(hero.id)).draft, "a section was published on its own");
    assert.ok((await row(text.id)).draft, "a section was published on its own");

    await sql.unsafe(`drop trigger eodt_bump on page_sections; drop function eodt_bump_siblings();`);

    const again = await get(server.origin, url, { cookie: owner.cookie });
    const published = await submitForm(
      server.origin,
      url,
      formWith(again.html, 'name="pageId"', ">Publish"),
      owner.cookie,
    );
    assert.ok(published.status < 400);
    assert.equal((await row(hero.id)).draft, null);
    assert.equal((await row(text.id)).draft, null);
    assert.equal(localised((await row(hero.id)).published.title).en, `Draft for ${hero.id}`);
  });
});

/* -------------------------------------------------------------------------- */

describe("who may save", () => {
  test("a reader may look but not write", async () => {
    const section = await open(await find("disclaimer", "page-hero"));

    succeeded(await load(section.sectionId, section.pageId, viewer.cookie));

    refused(
      await saveValues(
        section,
        { ...section.values, title: { en: "Viewer was here", ar: "" } },
        { cookie: viewer.cookie, csrf: viewer.csrfToken },
      ),
      "denied",
    );
    assert.equal((await row(section.sectionId)).draft, null, "a reader wrote a draft");
  });

  test("a save without the session's own token is refused", async () => {
    const section = await open(await find("disclaimer", "rich-text"));

    for (const csrf of [null, "", "not-the-token"]) {
      refused(
        await saveValues(section, { ...section.values, title: { en: "Forged", ar: "" } }, { csrf }),
        "denied",
      );
    }
    assert.equal((await row(section.sectionId)).draft, null);
  });

  test("signed out, neither reading nor writing works", async () => {
    const section = await find("home", "hero");

    refused(await load(section.id, section.page_id, null), "denied");

    refused(
      await save(
        {
          sectionId: String(section.id),
          pageId: String(section.page_id),
          expectedRevision: String(section.revision),
          values: JSON.stringify({}),
        },
        { cookie: null, csrf: owner.csrfToken },
      ),
      "denied",
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("a canvas can only edit its own page", () => {
  test("a section belonging to another page is refused, not loaded", async () => {
    const home = await find("home", "hero");
    const [about] = await sql<{ id: number }[]>`select id from pages where slug = 'about'`;

    refused(await load(home.id, about!.id), "wrong_page");
  });

  test("and a save naming the wrong page writes nothing", async () => {
    const home = await find("home", "quick-links");
    const [about] = await sql<{ id: number }[]>`select id from pages where slug = 'about'`;
    const before = await row(home.id);

    refused(
      await save({
        sectionId: String(home.id),
        pageId: String(about!.id),
        expectedRevision: String(home.revision),
        values: JSON.stringify({ title: { en: "Wrong page", ar: "" } }),
      }),
      "wrong_page",
    );

    const after = await row(home.id);
    assert.deepEqual(after.draft, before.draft);
    assert.equal(after.revision, before.revision);
  });

  test("a section that no longer exists reads as missing", async () => {
    const [page] = await sql<{ id: number }[]>`select id from pages where slug = 'home'`;
    refused(await load(999_999, page!.id), "missing");
  });
});
