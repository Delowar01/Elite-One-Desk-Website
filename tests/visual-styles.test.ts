/**
 * Layout and styles, against the running application.
 *
 * The governing rule of the batch, in one sentence: **a style is a validated,
 * structured token document attached to a stable node address, and it is never
 * arbitrary CSS.** Most of what follows asks that in different ways — what
 * survives a save, what a visitor sees, and what happens when text and layout
 * are edited at once.
 *
 * Everything goes through the real Server Actions over HTTP with the session
 * cookie, the CSRF token and the origin a browser sends, and is read back from
 * the database and from the real rendered pages.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { callAction, type ActionResponse } from "./helpers/action";
import { giveFresh } from "./helpers/fixtures";
import { formContaining, formsOn, get, submitForm } from "./helpers/http";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { startServer, isBuilt, BUILD_HINT, type Server } from "./helpers/server";
import { signIn, type TestSession } from "./helpers/session";

import { ITEM_ID_KEY } from "@/lib/cms/item-id";
import { STYLE_DOCUMENT_VERSION, type StyleDocument } from "@/lib/cms/styles";
import { STYLE_TOKEN_LABELS, styleTargetFor } from "@/lib/visual-editor/style-targets";
import type { VisualSectionLoad, VisualStyleSaveResult } from "@/lib/visual-editor/content";

const PORT = 3444;
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

/** A section, with both draft domains cleared so each test starts level. */
async function find(slug: string, blockType: string): Promise<SectionRow> {
  const [found] = await sql<{ id: number }[]>`
    select s.id from page_sections s join pages p on p.id = s.page_id
     where p.slug = ${slug} and s.block_type = ${blockType}
     order by s.position limit 1
  `;
  assert.ok(found, `no ${blockType} on /${slug}`);
  await sql`update page_sections set draft = null, draft_styles = null where id = ${found.id}`;
  return row(found.id);
}

function answered<T>(response: ActionResponse<T>): T {
  assert.ok(response.value, `the action returned nothing (status ${response.status})`);
  return response.value;
}

const doc = (nodes: Record<string, unknown>) => ({ v: STYLE_DOCUMENT_VERSION, nodes });

function saveStyles(
  section: { id: number; page_id: number; revision: number },
  styles: unknown,
  options: { cookie?: string | null; csrf?: string | null; pageId?: number } = {},
) {
  const form = new FormData();
  const csrf = options.csrf === undefined ? owner.csrfToken : options.csrf;
  if (csrf !== null) form.set("_csrf", csrf);
  form.set("sectionId", String(section.id));
  form.set("pageId", String(options.pageId ?? section.page_id));
  form.set("expectedRevision", String(section.revision));
  form.set("styles", JSON.stringify(styles));
  return callAction<VisualStyleSaveResult>({
    origin: server.origin,
    route: VE_ROUTE,
    file: VE_ACTIONS,
    action: "saveVisualSectionStyles",
    args: [form],
    cookie: options.cookie === undefined ? owner.cookie : (options.cookie ?? undefined),
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
  return callAction<{ ok: boolean; section?: { revision: number }; message?: string; reason?: string }>({
    origin: server.origin,
    route: VE_ROUTE,
    file: VE_ACTIONS,
    action: "saveVisualSectionDraft",
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

/** The one form on a page whose markup carries all of these. */
function formWith(html: string, ...needles: string[]): string {
  const form = formsOn(html).find((candidate) => needles.every((n) => candidate.includes(n)));
  if (!form) throw new Error(`no form contains ${needles.join(" + ")}`);
  return form;
}

/** The opening tag of the element carrying this attribute, with its style. */
function tagWith(html: string, attribute: string): string | null {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Bounded to one tag: the streamed flight payload at the end of the document
  // quotes these attributes back, and matching there would read a script.
  return new RegExp(`<[a-zA-Z][^<>]*${escaped}[^<>]*>`).exec(html)?.[0] ?? null;
}

const styleOf = (tag: string | null): string => /style="([^"]*)"/.exec(tag ?? "")?.[1] ?? "";

/**
 * A style with the reveal's own properties taken out.
 *
 * A section wrapper carries `--reveal-delay` from Batch 9 onwards, because the
 * wrapper *is* the section's entrance. That is the renderer's, not an
 * editor's, so a test asking "did an override reach this page" has to ask
 * about the rest.
 */
const overridesIn = (style: string): string =>
  style
    .split(";")
    .map((declaration) => declaration.trim())
    .filter((declaration) => declaration && !declaration.startsWith("--reveal-"))
    .join(";");
const classOf = (tag: string | null): string => /class="([^"]*)"/.exec(tag ?? "")?.[1] ?? "";

/** The text inside the element this opening tag begins. */
function textInside(html: string, tag: string): string {
  const at = html.indexOf(tag);
  if (at < 0) return "";
  const rest = html.slice(at + tag.length);
  const end = rest.indexOf("<");
  return end < 0 ? "" : rest.slice(0, end);
}

/**
 * The opening tag of the element that says exactly this.
 *
 * A public page carries no node addresses — that is what makes them
 * editor-only — so a test that has to check the *same element* a visitor gets
 * finds it the way a reader would: by what it says.
 */
function tagAround(html: string, text: string): string | null {
  const at = html.indexOf(`>${text}<`);
  if (at < 0) return null;
  const open = html.lastIndexOf("<", at);
  return open < 0 ? null : html.slice(open, at + 1);
}

/** The first tag of this name inside the element that opening tag begins. */
function tagInside(html: string, outer: string, name: string): string | null {
  const at = html.indexOf(outer);
  if (at < 0) return null;
  return new RegExp(`<${name}\\b[^<>]*>`).exec(html.slice(at + outer.length))?.[0] ?? null;
}

/** Publish a section's draft through the screen an admin actually uses. */
async function publishDraft(sectionId: number): Promise<void> {
  const url = `/admin/pages/section/${sectionId}`;
  const screen = await get(server.origin, url, { cookie: owner.cookie });
  const published = await submitForm(
    server.origin,
    url,
    formWith(screen.html, 'name="expectedRevision"', ">Publish draft<"),
    owner.cookie,
  );
  assert.ok(!/Reload the page/i.test(published.html), "publishing was refused");
}

/**
 * The canvas URL for a page.
 *
 * Node addresses are written only for an authorised Visual Editor canvas, so a
 * test that wants to find one element among many asks for the canvas. What it
 * then asserts about the style is true of the ordinary preview and of the live
 * page as well — the style does not come from editor mode, only the address
 * does, and the tests either side of these prove it.
 */
const BRIDGE = "0123456789abcdef0123456789abcdef";
const canvas = (path: string) =>
  get(server.origin, `${path}${path.includes("?") ? "&" : "?"}preview=1&editor=1&bridge=${BRIDGE}`, {
    cookie: owner.cookie,
  });

before(async () => {
  assert.ok(isBuilt(), BUILD_HINT);
  database = giveFresh("visual_styles");
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

describe("a saved style is a token document and nothing else", () => {
  test("the declared tokens survive and everything else is gone", async () => {
    const hero = await find("privacy", "page-hero");

    const saved = answered(
      await saveStyles(hero, {
        v: 1,
        nodes: {
          "field:title": {
            base: {
              align: "center",
              fontSize: "display",
              textColor: "orange",
              marginBlock: 4,
              // Everything below is refused, one way or another.
              css: "color: red",
              style: "color: red",
              class: "danger",
              className: "danger",
              selector: ".title",
              backgroundImage: "url(https://evil.example/x.png)",
              position: "absolute",
              left: "0px",
              right: "0px",
              transform: "scale(9)",
              filter: "blur(4px)",
              "--rogue": "red",
              textColor2: "orange",
              padBlock: 999,
              opacity: Number.POSITIVE_INFINITY,
              objectX: -20,
            },
          },
        },
      }),
    );

    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.ok(saved.ok);
    const base = (saved.styles.nodes["field:title"]!.base ?? {}) as Record<string, unknown>;
    assert.deepEqual(Object.keys(base).sort(), ["align", "fontSize", "marginBlock", "textColor"]);

    const stored = (await row(hero.id)).draft_styles as StyleDocument;
    const storedBase = stored.nodes["field:title"]!.base as Record<string, unknown>;
    assert.deepEqual(Object.keys(storedBase).sort(), ["align", "fontSize", "marginBlock", "textColor"]);
    // Nothing that could become CSS of somebody else's choosing is anywhere in
    // the column — not under a different key, not as a leftover string.
    const serialised = JSON.stringify(stored);
    for (const forbidden of ["css", "class", "selector", "url(", "var(", "transform", "absolute"]) {
      assert.ok(!serialised.includes(forbidden), `${forbidden} survived into the column`);
    }
  });

  test("a key that is not a relative node path is not a node", async () => {
    const hero = await find("privacy", "page-hero");
    const saved = answered(
      await saveStyles(hero, {
        v: 1,
        nodes: {
          "field:title": { base: { opacity: 0.5 } },
          "section:99/field:title": { base: { opacity: 0.5 } },
          "section:42": { base: { opacity: 0.5 } },
          "field:title@ar": { base: { opacity: 0.5 } },
          ".card h1": { base: { opacity: 0.5 } },
          "../../etc": { base: { opacity: 0.5 } },
          "field:links/item:not-an-id/field:label": { base: { opacity: 0.5 } },
        },
      }),
    );
    assert.ok(saved.ok);
    assert.deepEqual(Object.keys(saved.styles.nodes), ["field:title"]);

    const stored = JSON.stringify((await row(hero.id)).draft_styles);
    assert.ok(!stored.includes("section:"), "a runtime address was persisted");
    assert.ok(!stored.includes("@ar"), "a locale suffix was persisted");
  });

  test("a style save moves the style column and nothing else", async () => {
    const hero = await find("about", "page-hero");
    const before = await row(hero.id);

    const saved = answered(await saveStyles(hero, doc({ root: { base: { padBlock: 6 } } })));
    assert.ok(saved.ok);

    const after = await row(hero.id);
    assert.deepEqual(after.published, before.published, "content went live");
    assert.equal(after.draft, before.draft, "a content draft appeared");
    assert.deepEqual(after.styles, before.styles, "the published styles moved");
    assert.equal(after.animation, before.animation);
    assert.equal(after.draft_animation, before.draft_animation);
    assert.equal(after.is_published, before.is_published);
    assert.equal(after.is_draft_only, before.is_draft_only);
    assert.equal(after.position, before.position);
    assert.equal(after.page_id, before.page_id);
    assert.equal(after.block_type, before.block_type);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(after.updated_by, owner.userId);
    assert.equal(saved.revision, before.revision + 1);
  });

  test("a content save leaves both style columns alone", async () => {
    const hero = await find("about", "page-hero");
    const styled = answered(await saveStyles(hero, doc({ root: { base: { opacity: 0.5 } } })));
    assert.ok(styled.ok);
    const before = await row(hero.id);

    const content = answered(
      await saveContent(
        { ...hero, revision: styled.revision },
        { title: { en: "Text only", ar: "" } },
      ),
    );
    assert.equal(content.ok, true, JSON.stringify(content));

    const after = await row(hero.id);
    assert.deepEqual(after.draft_styles, before.draft_styles, "the style draft was disturbed");
    assert.deepEqual(after.styles, before.styles, "the published styles were disturbed");
  });

  test("the activity log says which domain was saved", async () => {
    const hero = await find("terms", "page-hero");
    answered(await saveStyles(hero, doc({ root: { base: { opacity: 0.5 } } })));
    const [entry] = await sql<{ action: string; user_id: number }[]>`
      select action, user_id from activity_logs
       where entity_type = 'section' and entity_id = ${String(hero.id)}
       order by id desc limit 1`;
    assert.equal(entry?.action, "section.style_draft_saved");
    assert.equal(entry?.user_id, owner.userId);
  });

  test("a refused save logs nothing", async () => {
    const hero = await find("terms", "page-hero");
    const before = await sql<{ n: number }[]>`
      select count(*)::int as n from activity_logs
       where entity_type = 'section' and entity_id = ${String(hero.id)}`;

    const refused = answered(
      await saveStyles({ ...hero, revision: hero.revision + 7 }, doc({ root: { base: { opacity: 0.5 } } })),
    );
    assert.ok(!refused.ok);

    const after = await sql<{ n: number }[]>`
      select count(*)::int as n from activity_logs
       where entity_type = 'section' and entity_id = ${String(hero.id)}`;
    assert.equal(after[0]!.n, before[0]!.n);
  });
});

/* -------------------------------------------------------------------------- */

describe("a style draft is previewed and a published style is public", () => {
  test("the draft reaches preview and stops there", async () => {
    const hero = await find("privacy", "page-hero");
    const plain = await get(server.origin, "/privacy");
    const plainRoot = tagWith(plain.html, 'data-section="page-hero"');
    assert.equal(
      overridesIn(styleOf(plainRoot)),
      "",
      "a section with no overrides carried a style attribute",
    );

    answered(
      await saveStyles(
        hero,
        doc({
          root: { base: { background: "ink-700", padBlock: 8, radius: "lg" } },
          "field:title": { base: { textColor: "orange", align: "center" } },
        }),
      ),
    );

    const preview = await get(server.origin, "/privacy?preview=1", { cookie: owner.cookie });
    const previewRoot = styleOf(tagWith(preview.html, 'data-section="page-hero"'));
    assert.match(previewRoot, /background:\s*var\(--color-ink-700\)/);
    assert.match(previewRoot, /padding-block:/);
    assert.match(previewRoot, /border-radius:\s*var\(--radius-lg\)/);
    assert.match(preview.html, /color:\s*var\(--color-orange\)/);

    const live = await get(server.origin, "/privacy");
    assert.equal(
      overridesIn(styleOf(tagWith(live.html, 'data-section="page-hero"'))),
      "",
      "a draft reached a visitor",
    );
    assert.ok(!live.html.includes("var(--color-orange);text-align:center"), "a draft reached a visitor");
  });

  test("publishing the draft makes it public, and clears the draft column", async () => {
    const hero = await find("privacy", "page-hero");
    const saved = answered(await saveStyles(hero, doc({ root: { base: { radius: "xl" } } })));
    assert.ok(saved.ok);

    const url = `/admin/pages/section/${hero.id}`;
    const screen = await get(server.origin, url, { cookie: owner.cookie });
    assert.match(screen.html, /Style draft/, "the section editor did not notice a style-only draft");
    const published = await submitForm(
      server.origin,
      url,
      formWith(screen.html, 'name="expectedRevision"', ">Publish draft<"),
      owner.cookie,
    );
    assert.ok(!/Reload the page/i.test(published.html), published.html.slice(0, 200));

    const after = await row(hero.id);
    assert.equal(after.draft_styles, null, "the style draft was not cleared");
    assert.deepEqual((after.styles as StyleDocument).nodes.root, { base: { radius: "xl" } });

    const live = await get(server.origin, "/privacy");
    assert.match(styleOf(tagWith(live.html, 'data-section="page-hero"')), /border-radius:\s*var\(--radius-xl\)/);
  });

  test("the ordinary preview screen shows a style draft, with no editor bridge", async () => {
    const hero = await find("terms", "page-hero");
    answered(await saveStyles(hero, doc({ root: { base: { opacity: 0.55 } } })));
    const preview = await get(server.origin, "/terms?preview=1", { cookie: owner.cookie });
    assert.match(styleOf(tagWith(preview.html, 'data-section="page-hero"')), /opacity:\s*0\.55/);
    assert.ok(!preview.html.includes("bridgeId"), "the ordinary preview loaded the canvas bridge");
    assert.ok(!/data-eod-/.test(preview.html), "the ordinary preview carried editor markup");
  });
});

/* -------------------------------------------------------------------------- */

describe("an empty style draft is a reset, not an absence", () => {
  test("clearing every override stores a document, and publishing it removes them", async () => {
    const hero = await find("disclaimer", "page-hero");

    // Something published to reset back from.
    const first = answered(await saveStyles(hero, doc({ "field:title": { base: { textColor: "orange" } } })));
    assert.ok(first.ok);
    const url = `/admin/pages/section/${hero.id}`;
    const screen = await get(server.origin, url, { cookie: owner.cookie });
    await submitForm(
      server.origin,
      url,
      formWith(screen.html, 'name="expectedRevision"', ">Publish draft<"),
      owner.cookie,
    );
    const live = await row(hero.id);
    assert.deepEqual((live.styles as StyleDocument).nodes["field:title"], {
      base: { textColor: "orange" },
    });

    // The reset: an empty document, saved as a draft.
    const reset = answered(await saveStyles({ ...hero, revision: live.revision }, doc({})));
    assert.ok(reset.ok);
    const drafted = await row(hero.id);
    assert.notEqual(drafted.draft_styles, null, "an empty reset was stored as no draft at all");
    assert.deepEqual(drafted.draft_styles, { v: STYLE_DOCUMENT_VERSION, nodes: {} });
    assert.deepEqual(
      (drafted.styles as StyleDocument).nodes["field:title"],
      { base: { textColor: "orange" } },
      "the published style was changed by a draft",
    );

    // Preview shows the design again; the public page still shows the override.
    const preview = await canvas("/disclaimer");
    const previewTitle = tagWith(preview.html, `data-eod-address="section:${hero.id}/field:title"`);
    assert.ok(previewTitle, "the title is not addressable on the canvas");
    assert.equal(styleOf(previewTitle), "", "the reset did not reach the preview");

    const publicPage = await get(server.origin, "/disclaimer");
    assert.match(
      publicPage.html,
      /style="color:var\(--color-orange\)"/,
      "the public page lost its style before anybody published the reset",
    );

    // Publishing the reset takes the override off the live page.
    const second = await get(server.origin, url, { cookie: owner.cookie });
    await submitForm(
      server.origin,
      url,
      formWith(second.html, 'name="expectedRevision"', ">Publish draft<"),
      owner.cookie,
    );
    const finished = await row(hero.id);
    assert.equal(finished.draft_styles, null);
    assert.deepEqual(finished.styles, { v: STYLE_DOCUMENT_VERSION, nodes: {} });

    const after = await get(server.origin, "/disclaimer");
    assert.ok(
      !/style="color:var\(--color-orange\)"/.test(after.html),
      "the override is still on the live page",
    );
  });

  test("discarding a style draft leaves the published styles alone", async () => {
    const hero = await find("terms", "page-hero");
    const a = answered(await saveStyles(hero, doc({ root: { base: { radius: "sm" } } })));
    assert.ok(a.ok);
    const url = `/admin/pages/section/${hero.id}`;
    const first = await get(server.origin, url, { cookie: owner.cookie });
    await submitForm(
      server.origin,
      url,
      formWith(first.html, 'name="expectedRevision"', ">Publish draft<"),
      owner.cookie,
    );
    const publishedRow = await row(hero.id);

    const b = answered(
      await saveStyles({ ...hero, revision: publishedRow.revision }, doc({ root: { base: { radius: "xl" } } })),
    );
    assert.ok(b.ok);

    const screen = await get(server.origin, url, { cookie: owner.cookie });
    const discarded = await submitForm(
      server.origin,
      url,
      formWith(screen.html, 'name="expectedRevision"', ">Discard<"),
      owner.cookie,
    );
    assert.ok(!/Reload the page/i.test(discarded.html));

    const after = await row(hero.id);
    assert.equal(after.draft_styles, null);
    assert.deepEqual((after.styles as StyleDocument).nodes.root, { base: { radius: "sm" } });
    assert.equal(after.revision, b.revision + 1);
  });
});

/* -------------------------------------------------------------------------- */

describe("content and style share one revision", () => {
  test("style then content: the second save names what the first produced", async () => {
    const hero = await find("contact", "page-hero");

    const styled = answered(await saveStyles(hero, doc({ root: { base: { padBlock: 5 } } })));
    assert.ok(styled.ok);
    assert.equal(styled.revision, hero.revision + 1);

    const content = answered(
      await saveContent({ ...hero, revision: styled.revision }, { title: { en: "After style", ar: "" } }),
    );
    assert.equal(content.ok, true, JSON.stringify(content));

    const after = await row(hero.id);
    assert.equal(after.revision, hero.revision + 2);
    assert.equal((after.draft!.title as { en: string }).en, "After style");
    assert.deepEqual((after.draft_styles as StyleDocument).nodes.root, { base: { padBlock: 5 } });
  });

  test("content then style: the same, the other way round", async () => {
    const hero = await find("contact", "page-hero");

    const content = answered(await saveContent(hero, { title: { en: "First", ar: "" } }));
    assert.equal(content.ok, true);
    const revision = content.section!.revision;

    const styled = answered(await saveStyles({ ...hero, revision }, doc({ root: { base: { gap: 3 } } })));
    assert.ok(styled.ok, JSON.stringify(styled));
    assert.equal(styled.revision, revision + 1);

    const after = await row(hero.id);
    assert.equal((after.draft!.title as { en: string }).en, "First");
    assert.deepEqual((after.draft_styles as StyleDocument).nodes.root, { base: { gap: 3 } });
  });

  test("a style save on a revision that has moved is refused, and offers the whole row", async () => {
    const hero = await find("contact", "page-hero");
    answered(await saveContent(hero, { title: { en: "Somebody else", ar: "" } }));

    const refused = answered(await saveStyles(hero, doc({ root: { base: { opacity: 0.4 } } })));
    assert.equal(refused.ok, false);
    assert.ok(!refused.ok);
    assert.equal(refused.reason, "conflict");
    // The latest row, both domains, so reloading cannot leave half of it stale.
    assert.equal((refused.section.values.title as { en: string }).en, "Somebody else");
    assert.equal(refused.section.revision, hero.revision + 1);
    assert.equal((await row(hero.id)).draft_styles, null, "the refused save wrote anyway");
  });

  test("and a normal content form that predates a style save is refused too", async () => {
    const hero = await find("about", "image-text");
    const url = `/admin/pages/section/${hero.id}`;
    const screen = await get(server.origin, url, { cookie: owner.cookie });
    const form = formContaining(screen.html, "Save draft");
    assert.match(form, new RegExp(`name="expectedRevision" value="${hero.revision}"`));

    const styled = answered(await saveStyles(hero, doc({ root: { base: { opacity: 0.6 } } })));
    assert.ok(styled.ok);

    const submitted = await submitForm(server.origin, url, form, owner.cookie);
    assert.match(submitted.html, /changed while you were editing/i);
    assert.deepEqual((await row(hero.id)).draft_styles, styled.styles, "the stale form overwrote the style");
  });
});

/* -------------------------------------------------------------------------- */

describe("the whole page publishes together", () => {
  test("a style-only draft takes part in the page's publication", async () => {
    const heroSection = await find("terms", "page-hero");
    const textSection = await find("terms", "rich-text");

    answered(await saveStyles(heroSection, doc({ root: { base: { radius: "md" } } })));
    const content = answered(
      await saveContent(textSection, { title: { en: "Published together", ar: "" } }),
    );
    assert.equal(content.ok, true);

    const url = "/admin/pages/terms";
    const screen = await get(server.origin, url, { cookie: owner.cookie });
    const result = await submitForm(
      server.origin,
      url,
      // Named exactly: ">Publish" also matches a block *description* in the
      // Add-section form, and submitting that one publishes nothing.
      formWith(screen.html, 'name="pageId"', "Publish saved changes"),
      owner.cookie,
    );
    assert.ok(result.status < 400);

    const hero = await row(heroSection.id);
    assert.equal(hero.draft_styles, null);
    assert.deepEqual((hero.styles as StyleDocument).nodes.root, { base: { radius: "md" } });

    const text = await row(textSection.id);
    assert.equal(text.draft, null);
    assert.equal((text.published.title as { en: string }).en, "Published together");
  });

  test("publishing a hidden section's styles does not make it visible", async () => {
    const section = await find("about", "stats");
    await sql`update page_sections set is_published = false where id = ${section.id}`;
    const hidden = await row(section.id);

    answered(await saveStyles({ ...section, revision: hidden.revision }, doc({ root: { base: { opacity: 0.8 } } })));

    const url = "/admin/pages/about";
    const screen = await get(server.origin, url, { cookie: owner.cookie });
    await submitForm(
      server.origin,
      url,
      formWith(screen.html, 'name="pageId"', "Publish saved changes"),
      owner.cookie,
    );

    const after = await row(section.id);
    assert.equal(after.draft_styles, null, "the style draft was not published");
    assert.deepEqual((after.styles as StyleDocument).nodes.root, { base: { opacity: 0.8 } });
    assert.equal(after.is_published, false, "a hidden section became visible");

    await sql`update page_sections set is_published = true where id = ${section.id}`;
  });

  test("Save and publish on the content form leaves a style draft pending", async () => {
    const hero = await find("privacy", "page-hero");
    const styled = answered(await saveStyles(hero, doc({ root: { base: { shadow: "lift" } } })));
    assert.ok(styled.ok);

    const form = new FormData();
    form.set("_csrf", owner.csrfToken);
    form.set("id", String(hero.id));
    form.set("expectedRevision", String(styled.revision));
    form.set("values", JSON.stringify({ title: { en: "Content live", ar: "" } }));
    const published = answered(
      await callAction<{ ok: boolean; message?: string }>({
        origin: server.origin,
        route: `/admin/pages/section/${hero.id}`,
        file: PAGE_ACTIONS,
        action: "saveSectionAndPublish",
        args: [{ ok: false }, form],
        cookie: owner.cookie,
      }),
    );
    assert.equal(published.ok, true, JSON.stringify(published));

    const after = await row(hero.id);
    assert.equal((after.published.title as { en: string }).en, "Content live");
    assert.equal(after.draft, null);
    // The style draft is somebody's unfinished work, not part of what this
    // form submitted. It is still waiting, and still says so.
    assert.deepEqual(after.draft_styles, styled.styles, "a style draft was published by a content form");
    const screen = await get(server.origin, `/admin/pages/section/${hero.id}`, { cookie: owner.cookie });
    assert.match(screen.html, /Style draft/);
  });

  test("Save draft on the content form does not erase a style draft either", async () => {
    const hero = await find("privacy", "page-hero");
    const styled = answered(await saveStyles(hero, doc({ root: { base: { border: "accent" } } })));
    assert.ok(styled.ok);

    const url = `/admin/pages/section/${hero.id}`;
    const screen = await get(server.origin, url, { cookie: owner.cookie });
    const saved = await submitForm(
      server.origin,
      url,
      formContaining(screen.html, "Save draft"),
      owner.cookie,
    );
    assert.ok(!/Reload the page/i.test(saved.html));

    const after = await row(hero.id);
    assert.deepEqual(after.draft_styles, styled.styles);
    assert.equal(after.revision, styled.revision + 1);
  });
});

/* -------------------------------------------------------------------------- */

describe("a style belongs to a node, not to a position", () => {
  test("a repeatable row keeps its style when the list is reordered", async () => {
    const links = await find("home", "quick-links");
    const loaded = answered(await loadSection(links.id, links.page_id));
    assert.ok(loaded.ok);
    const rows = loaded.section.values.links as Record<string, unknown>[];
    const second = String(rows[1]![ITEM_ID_KEY]);

    const styled = answered(
      await saveStyles(
        links,
        doc({ [`field:links/item:${second}`]: { base: { background: "surface-raised", radius: "lg" } } }),
      ),
    );
    assert.ok(styled.ok);

    // The same row, now first in the array.
    const reordered = [rows[1], rows[0], ...rows.slice(2)];
    const content = answered(
      await saveContent(
        { ...links, revision: styled.revision },
        { ...loaded.section.values, links: reordered },
      ),
    );
    assert.equal(content.ok, true, JSON.stringify(content));

    const preview = await canvas("/");
    const tag = tagWith(preview.html, `data-eod-address="section:${links.id}/field:links/item:${second}"`);
    assert.ok(tag, "the row is not addressable on the canvas");
    assert.match(styleOf(tag), /border-radius:\s*var\(--radius-lg\)/, "the style did not follow the row");

    // …and the row that moved into its old position did not inherit it.
    const firstId = String(rows[0]![ITEM_ID_KEY]);
    const other = tagWith(preview.html, `data-eod-address="section:${links.id}/field:links/item:${firstId}"`);
    assert.ok(other, "the neighbour is not addressable");
    assert.ok(!/border-radius/.test(styleOf(other)), "a neighbour picked up the style");

    // The same style is on the ordinary preview, which has no addresses at all:
    // a style is part of the page, not part of editor mode.
    const plain = await get(server.origin, "/?preview=1", { cookie: owner.cookie });
    assert.ok(!/data-eod-/.test(plain.html), "the ordinary preview carried editor markup");
    assert.match(plain.html, /border-radius:\s*var\(--radius-lg\)/, "the style needs editor mode");
  });

  test("a media node takes a focal point, and its picture is untouched", async () => {
    const links = await find("home", "quick-links");
    const loaded = answered(await loadSection(links.id, links.page_id));
    assert.ok(loaded.ok);
    const rows = loaded.section.values.links as Record<string, unknown>[];
    const id = String(rows[0]![ITEM_ID_KEY]);
    const before = await row(links.id);

    const styled = answered(
      await saveStyles(
        links,
        doc({
          [`field:links/item:${id}/field:image`]: {
            base: { objectX: 20, objectY: 80, radius: "md", opacity: 0.9 },
          },
        }),
      ),
    );
    assert.ok(styled.ok);
    assert.deepEqual(
      (styled.styles.nodes[`field:links/item:${id}/field:image`]!.base ?? {}) as Record<string, unknown>,
      { radius: "md", opacity: 0.9, objectX: 20, objectY: 80 },
    );

    const after = await row(links.id);
    assert.deepEqual(after.published, before.published, "styling a picture changed the content");
    assert.equal(after.draft, before.draft);
  });

  test("the same document lays out in Arabic, with no physical direction in it", async () => {
    const hero = await find("privacy", "page-hero");
    answered(
      await saveStyles(hero, doc({ root: { base: { padInline: 6, marginInline: 2 } }, "field:title": { base: { align: "start" } } })),
    );

    for (const path of ["/privacy?preview=1", "/ar/privacy?preview=1"]) {
      const page = await get(server.origin, path, { cookie: owner.cookie });
      const root = styleOf(tagWith(page.html, 'data-section="page-hero"'));
      assert.match(root, /padding-inline:/, path);
      assert.match(root, /margin-inline:/, path);
      assert.ok(!/padding-left|padding-right|margin-left|margin-right/.test(root), `physical spacing in ${path}`);
      assert.match(page.html, /text-align:\s*start/, path);
    }
  });
});

/* -------------------------------------------------------------------------- */

type NodeCheck = {
  /** The section-relative path an editor's selection produces. */
  path: string;
  tokens: Record<string, unknown>;
  /** What that element is, so a style cannot quietly land on a wrapper. */
  element: RegExp;
  /** Declarations the element's own style attribute must carry. */
  expect: readonly RegExp[];
};

/**
 * The whole cycle for one block: draft, preview, public, publish, public again.
 *
 * Every assertion is against the exact element the editor selected — found by
 * its address on the canvas and by its own words on the public page, because a
 * visitor's page carries no addresses. Storing the document is not the claim
 * being tested here; rendering it is.
 */
async function provesOnThePage(section: SectionRow, page: string, nodes: readonly NodeCheck[]) {
  const before = (await canvas(page)).html;
  const words = new Map<string, string>();
  for (const node of nodes) {
    const tag = tagWith(before, `data-eod-address="section:${section.id}/${node.path}"`);
    assert.ok(tag, `${node.path} is not addressable on ${page}`);
    assert.match(tag, node.element, `${node.path} is not the element this test means`);
    assert.equal(styleOf(tag), "", `${node.path} was already carrying a style`);
    const text = textInside(before, tag);
    assert.ok(text.trim(), `${node.path} renders no text to find it by`);
    words.set(node.path, text);
  }

  const clean = (await get(server.origin, page)).html;
  const untouched = new Map(nodes.map((node) => [node.path, tagAround(clean, words.get(node.path)!)]));
  for (const node of nodes) {
    assert.ok(untouched.get(node.path), `${node.path} is not on the public page`);
  }

  answered(
    await saveStyles(section, doc(Object.fromEntries(nodes.map((n) => [n.path, { base: n.tokens }])))),
  );

  // The editor sees the draft, on the element they pointed at.
  const drafted = (await canvas(page)).html;
  for (const node of nodes) {
    const tag = tagWith(drafted, `data-eod-address="section:${section.id}/${node.path}"`);
    assert.ok(tag, `${node.path} lost its address`);
    assert.match(tag, node.element, `${node.path} moved to another element`);
    for (const rule of node.expect) {
      assert.match(styleOf(tag), rule, `${node.path} in preview: ${styleOf(tag)}`);
    }
  }

  // …and nobody else does.
  const still = (await get(server.origin, page)).html;
  for (const node of nodes) {
    assert.equal(
      tagAround(still, words.get(node.path)!),
      untouched.get(node.path),
      `a style draft reached a visitor on ${page}`,
    );
  }

  await publishDraft(section.id);

  const live = (await get(server.origin, page)).html;
  for (const node of nodes) {
    const tag = tagAround(live, words.get(node.path)!);
    assert.ok(tag, `${node.path} vanished from the public page`);
    assert.match(tag, node.element, `${node.path} published onto another element`);
    for (const rule of node.expect) {
      assert.match(styleOf(tag), rule, `${node.path} published: ${styleOf(tag)}`);
    }
    assert.ok(!tag.includes("data-eod-"), "editor markup reached a visitor");
  }
}

describe("the heading eleven blocks share is styled like anything else", () => {
  /**
   * `SectionHeading` renders the opening eyebrow, title and lede of eleven
   * blocks. It was given the editor's marks and not the style document, so
   * those nodes could be selected, could be styled in the panel, and then did
   * nothing at all on the page. The four tests below are four different blocks,
   * because the defect was in the shared component rather than in any one of
   * them — and each one goes all the way to the public page.
   */
  test("Quick Access: the heading takes a colour and a weight", async () => {
    const links = await find("home", "quick-links");
    await provesOnThePage(links, "/", [
      {
        // The block calls its own field `title` and shows it as the eyebrow.
        path: "field:title",
        element: /^<p\b[^>]*\bclass="eyebrow/,
        tokens: { textColor: "orange", fontWeight: 800 },
        expect: [/color:\s*var\(--color-orange\)/, /font-weight:\s*800/],
      },
    ]);
  });

  test("Travel: a title and a lede, two nodes of one heading", async () => {
    const travel = await find("home", "travel-feature");
    await provesOnThePage(travel, "/", [
      {
        path: "field:title",
        element: /^<h2\b/,
        tokens: { align: "center", fontSize: "h3", maxWidth: "prose" },
        expect: [/text-align:\s*center/, /font-size:\s*var\(--text-h3\)/, /max-width:\s*65ch/],
      },
      {
        // A different field name for the same slot of the same component.
        path: "field:body",
        element: /^<p\b[^>]*\bclass="lede/,
        tokens: { textColor: "peach", marginBlock: 6 },
        expect: [/color:\s*var\(--color-peach\)/, /margin-block:\s*2rem/],
      },
    ]);
  });

  test("How it works: the eyebrow of a third block", async () => {
    const process = await find("home", "process");
    await provesOnThePage(process, "/", [
      {
        path: "field:eyebrow",
        element: /^<p\b[^>]*\bclass="eyebrow/,
        tokens: { textColor: "warm", align: "center" },
        expect: [/color:\s*var\(--color-warm\)/, /text-align:\s*center/],
      },
      {
        path: "field:title",
        element: /^<h2\b/,
        tokens: { fontSize: "h1" },
        expect: [/font-size:\s*var\(--text-h1\)/],
      },
    ]);
  });

  test("Common questions: and on a second page", async () => {
    const faq = await find("contact", "faq");
    await provesOnThePage(faq, "/contact", [
      {
        path: "field:title",
        element: /^<h2\b/,
        tokens: { textColor: "orange", opacity: 0.8 },
        expect: [/color:\s*var\(--color-orange\)/, /opacity:\s*0\.8/],
      },
    ]);
  });

  test("a heading with no override renders exactly the markup it always did", async () => {
    const why = await find("about", "why-us");
    const html = (await canvas("/about")).html;
    const tag = tagWith(html, `data-eod-address="section:${why.id}/field:title"`);
    assert.ok(tag, "the heading is not addressable");
    assert.equal(styleOf(tag), "", "an unstyled heading carried a style attribute");
    assert.ok(!tag.includes("style="), "an unstyled heading carried a style attribute");
  });
});

/* -------------------------------------------------------------------------- */

describe("a picture's crop lands on the picture, not on the frame", () => {
  /**
   * A media field is two elements here: a frame that clips and shapes, and an
   * `<img>` inside it that is the thing the browser actually crops.
   * `object-position` on the frame is inert — it is not a replaced element — so
   * the focal-point controls were offered, saved, and did nothing. One stored
   * path and one selectable node still, because the DOM's shape is not a fact
   * the database should learn.
   */
  test("Quick Links: the frame keeps the shape and the photograph takes the crop", async () => {
    const links = await find("home", "quick-links");
    const loaded = answered(await loadSection(links.id, links.page_id));
    assert.ok(loaded.ok);
    const rows = loaded.section.values.links as Record<string, unknown>[];
    const chosen = String(rows[0]![ITEM_ID_KEY]);
    const neighbour = String(rows[1]![ITEM_ID_KEY]);
    const before = await row(links.id);

    const path = `field:links/item:${chosen}/field:image`;
    answered(
      await saveStyles(links, doc({ [path]: { base: { objectX: 20, objectY: 80, radius: "md" } } })),
    );

    const html = (await canvas("/")).html;
    const frame = tagWith(html, `data-eod-address="section:${links.id}/${path}"`);
    assert.ok(frame, "the picture is not addressable");
    assert.equal(classOf(frame), "ql-shot", "the address moved off the frame");
    assert.match(styleOf(frame), /border-radius:\s*var\(--radius-md\)/, "the frame lost its shape");
    assert.ok(
      !/object-position/.test(styleOf(frame)),
      "the crop was written on the frame, where it does nothing",
    );

    const picture = tagInside(html, frame, "img");
    assert.ok(picture, "the frame holds no picture");
    assert.equal(classOf(picture), "ql-img", "the crop landed on something that is not the picture");
    // Inline, so it beats the crop `.ql-img` sets for itself in the stylesheet
    // — which is the only way an editor's focal point could win here.
    assert.match(styleOf(picture), /object-position:\s*20%\s*80%/);
    assert.ok(!/border-radius/.test(styleOf(picture)), "the frame's shape was copied onto the picture");
    // One node, one address: the picture is not separately selectable.
    assert.ok(!picture.includes("data-eod-"), "the picture took an address of its own");

    // The card beside it is untouched.
    const other = tagWith(
      html,
      `data-eod-address="section:${links.id}/field:links/item:${neighbour}/field:image"`,
    );
    assert.ok(other, "the neighbour is not addressable");
    assert.equal(styleOf(other), "", "a neighbour's frame was styled");
    const otherPicture = tagInside(html, other, "img");
    assert.ok(otherPicture, "the neighbour holds no picture");
    assert.ok(!/object-position/.test(styleOf(otherPicture)), "a neighbour was cropped");

    // …and nothing about the content moved: same picture, same row, same id.
    const after = await row(links.id);
    assert.deepEqual(after.published, before.published, "styling a picture changed the content");
    assert.equal(after.draft, before.draft, "styling a picture wrote a content draft");
    assert.equal(
      /src="([^"]*)"/.exec(picture)?.[1],
      /src="([^"]*)"/.exec(tagInside((await canvas("/")).html, frame, "img") ?? "")?.[1],
      "the picture itself changed",
    );
  });

  test("Quick Links: the crop follows its row when the list is reordered", async () => {
    const links = await find("home", "quick-links");
    const loaded = answered(await loadSection(links.id, links.page_id));
    assert.ok(loaded.ok);
    const rows = loaded.section.values.links as Record<string, unknown>[];
    const chosen = String(rows[0]![ITEM_ID_KEY]);
    const path = `field:links/item:${chosen}/field:image`;

    const styled = answered(
      await saveStyles(links, doc({ [path]: { base: { objectX: 15, objectY: 85 } } })),
    );
    assert.ok(styled.ok);

    // The same row, now at the end of the list.
    const reordered = [...rows.slice(1), rows[0]];
    const content = answered(
      await saveContent(
        { ...links, revision: styled.revision },
        { ...loaded.section.values, links: reordered },
      ),
    );
    assert.equal(content.ok, true, JSON.stringify(content));

    const html = (await canvas("/")).html;
    const frame = tagWith(html, `data-eod-address="section:${links.id}/${path}"`);
    assert.ok(frame, "the row lost its address in the move");
    assert.match(
      styleOf(tagInside(html, frame, "img")),
      /object-position:\s*15%\s*85%/,
      "the crop stayed behind at the old position",
    );

    // The card that moved into first place did not inherit it.
    const first = String(rows[1]![ITEM_ID_KEY]);
    const moved = tagWith(
      html,
      `data-eod-address="section:${links.id}/field:links/item:${first}/field:image"`,
    );
    assert.ok(moved, "the new first card is not addressable");
    assert.ok(
      !/object-position/.test(styleOf(tagInside(html, moved, "img"))),
      "a crop was inherited by position",
    );

    // The row still carries the id it was styled under.
    const reloaded = answered(await loadSection(links.id, links.page_id));
    assert.ok(reloaded.ok);
    const now = reloaded.section.values.links as Record<string, unknown>[];
    assert.equal(String(now[now.length - 1]![ITEM_ID_KEY]), chosen, "the row's id moved with its position");
  });

  test("a picture that is not in a list is cropped the same way", async () => {
    const section = await find("about", "image-text");
    const [picture] = await sql<{ id: number }[]>`select id from media order by id limit 1`;
    assert.ok(picture, "the fixture has no artwork to crop");

    const loaded = answered(await loadSection(section.id, section.page_id));
    assert.ok(loaded.ok);
    const content = answered(
      await saveContent(section, { ...loaded.section.values, image: picture.id }),
    );
    assert.equal(content.ok, true, JSON.stringify(content));

    const withImage = await row(section.id);
    answered(
      await saveStyles(
        withImage,
        doc({ "field:image": { base: { objectX: 10, objectY: 90, border: "accent" } } }),
      ),
    );

    const html = (await canvas("/about")).html;
    const frame = tagWith(html, `data-eod-address="section:${section.id}/field:image"`);
    assert.ok(frame, "the picture is not addressable");
    assert.match(styleOf(frame), /border:\s*1px solid var\(--color-orange\)/);
    assert.ok(!/object-position/.test(styleOf(frame)), "the crop was written on the frame");

    const img = tagInside(html, frame, "img");
    assert.ok(img, "the frame holds no picture");
    assert.match(styleOf(img), /object-position:\s*10%\s*90%/);
    assert.match(styleOf(img), /aspect-ratio:\s*4\s*\/\s*3/, "the block's own ratio was replaced");
    assert.ok(!img.includes("data-eod-"), "the picture took an address of its own");
  });

  test("every block that renders a library picture splits the two halves", async () => {
    // A grep, deliberately: the defect this closes was one call site being
    // rewired and the rest being left, and the next media block added is the
    // one that would be left.
    const { readdirSync, readFileSync } = await import("node:fs");
    const dir = new URL("../src/components/site/blocks/", import.meta.url);
    const offenders: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".tsx")) continue;
      const source = readFileSync(new URL(name, dir), "utf8");
      if (!source.includes("<MediaImage")) continue;
      // Every picture is placed by `mediaNode`, and its two halves are used:
      // the frame gets the attributes, the picture gets the style.
      if (!source.includes("mediaNode(")) offenders.push(`${name}: renders a picture without mediaNode`);
      for (const call of source.split("<MediaImage").slice(1)) {
        const tag = call.slice(0, call.indexOf("/>"));
        // Spread, not one named prop: the crop and the breakpoints it applies
        // at travel together, so a block cannot pass half of them.
        if (!/\{\.\.\.[a-zA-Z]+\.image\}/.test(tag)) offenders.push(`${name}: a picture takes no crop`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});

/* -------------------------------------------------------------------------- */

describe("an opacity is a revealed element's finished state", () => {
  test("it travels as the property the stylesheet reads, and the reveal still works", async () => {
    const travel = await find("home", "travel-feature");
    const loaded = answered(await loadSection(travel.id, travel.page_id));
    assert.ok(loaded.ok);
    const caps = loaded.section.values.capabilities as Record<string, unknown>[];
    const id = String(caps[0]![ITEM_ID_KEY]);
    const path = `field:capabilities/item:${id}`;

    answered(await saveStyles(travel, doc({ [path]: { base: { opacity: 0.45, radius: "lg" } } })));

    const html = (await canvas("/")).html;
    const tag = tagWith(html, `data-eod-address="section:${travel.id}/${path}"`);
    assert.ok(tag, "the row is not addressable");
    assert.match(classOf(tag), /\breveal\b/, "this row is not revealed, so the test proves nothing");
    const style = styleOf(tag);

    assert.match(style, /--eod-node-opacity:\s*0\.45/, "the finished opacity was not handed to the stylesheet");
    // An inline opacity outranks the class that holds the element at 0, so the
    // row would sit at 45% before it was ever revealed and the fade would have
    // nothing to travel.
    assert.ok(
      !/(^|;)\s*opacity:/.test(style),
      `the reveal's lifecycle was overridden by an inline opacity: ${style}`,
    );
    assert.match(tag, /data-shown="false"/, "the row started out already shown");
    assert.match(style, /--reveal-delay:/, "the reveal's own delay was lost");
    assert.match(style, /border-radius:\s*var\(--radius-lg\)/, "the rest of the node's style was dropped");
  });

  test("a section root that has an entrance is revealed, so its opacity is the finished state", async () => {
    // Batch 9 made the section wrapper the section's own entrance, so the rule
    // that already held for a revealed row now holds for the wrapper too: an
    // inline opacity would hold it at 60% before it revealed.
    const hero = await find("terms", "page-hero");
    await sql`update page_sections set animation = 'fade-up' where id = ${hero.id}`;
    answered(await saveStyles(hero, doc({ root: { base: { opacity: 0.6 } } })));

    const previewed = await get(server.origin, "/terms?preview=1", { cookie: owner.cookie });
    const tag = tagWith(previewed.html, 'data-section="page-hero"');
    assert.match(classOf(tag), /\breveal\b/, "the section wrapper is not revealed");
    assert.match(styleOf(tag), /--eod-node-opacity:\s*0\.6/);
    assert.ok(
      !/(^|;)\s*opacity:/.test(styleOf(tag)),
      `the reveal's lifecycle was overridden by an inline opacity: ${styleOf(tag)}`,
    );
    assert.match(tag!, /data-shown="false"/);
  });

  test("a section root with no entrance is not revealed, so its opacity is simply its opacity", async () => {
    const hero = await find("terms", "page-hero");
    await sql`update page_sections set animation = 'none' where id = ${hero.id}`;
    answered(await saveStyles(hero, doc({ root: { base: { opacity: 0.6 } } })));

    // Preview, which is never cached, so the entrance set above is the one
    // being read rather than whatever a previous test left in the page cache.
    const previewed = await get(server.origin, "/terms?preview=1", { cookie: owner.cookie });
    const tag = tagWith(previewed.html, 'data-section="page-hero"');
    assert.ok(!/\breveal\b/.test(classOf(tag)), "a section with no entrance became a reveal");
    assert.match(styleOf(tag), /opacity:\s*0\.6/);
    assert.ok(!/--eod-node-opacity/.test(styleOf(tag)), "a property nothing reads replaced the opacity");
    await sql`update page_sections set animation = 'fade-up' where id = ${hero.id}`;
  });
});

/* -------------------------------------------------------------------------- */

/**
 * A non-default value for every token in the vocabulary, and the declaration it
 * has to produce on the page. The table is written out rather than derived,
 * because deriving it from the same map the renderer uses would prove only that
 * the map equals itself.
 */
const EXECUTES: Record<string, { value: unknown; on: "box" | "image"; css: (tag: string) => RegExp }> = {
  align: { value: "center", on: "box", css: () => /text-align:\s*center/ },
  fontSize: { value: "h3", on: "box", css: () => /font-size:\s*var\(--text-h3\)/ },
  fontWeight: { value: 800, on: "box", css: () => /font-weight:\s*800/ },
  textColor: { value: "orange", on: "box", css: () => /color:\s*var\(--color-orange\)/ },
  background: { value: "ink-700", on: "box", css: () => /background:\s*var\(--color-ink-700\)/ },
  padBlock: { value: 6, on: "box", css: () => /padding-block:\s*2rem/ },
  padInline: { value: 5, on: "box", css: () => /padding-inline:\s*1\.5rem/ },
  marginBlock: { value: 4, on: "box", css: () => /margin-block:\s*1rem/ },
  marginInline: { value: 3, on: "box", css: () => /margin-inline:\s*0\.75rem/ },
  gap: { value: 7, on: "box", css: () => /gap:\s*2\.5rem/ },
  radius: { value: "lg", on: "box", css: () => /border-radius:\s*var\(--radius-lg\)/ },
  border: { value: "accent", on: "box", css: () => /border:\s*1px solid var\(--color-orange\)/ },
  shadow: { value: "lift", on: "box", css: () => /box-shadow:\s*var\(--shadow-lift\)/ },
  // Composed with the shadow above into the one `box-shadow` CSS has, so this
  // looks for its own layer inside the list rather than for the whole value.
  glow: { value: "accent", on: "box", css: () => /box-shadow:[^;"]*var\(--glow-accent\)/ },
  maxWidth: { value: "prose", on: "box", css: () => /max-width:\s*65ch/ },
  width: { value: "half", on: "box", css: () => /(^|;)width:\s*50%/ },
  height: { value: "screen", on: "box", css: () => /(^|;)height:\s*100svh/ },
  minHeight: { value: "half-screen", on: "box", css: () => /min-height:\s*50svh/ },
  layout: { value: "grid", on: "box", css: () => /display:\s*grid/ },
  direction: { value: "column", on: "box", css: () => /flex-direction:\s*column/ },
  wrap: { value: "wrap", on: "box", css: () => /flex-wrap:\s*wrap/ },
  justify: { value: "between", on: "box", css: () => /justify-content:\s*space-between/ },
  alignItems: { value: "center", on: "box", css: () => /align-items:\s*center/ },
  columns: {
    value: 3,
    on: "box",
    css: () => /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/,
  },
  overflow: { value: "hidden", on: "box", css: () => /(^|;)overflow:\s*hidden/ },
  objectX: { value: 20, on: "image", css: () => /object-position:\s*20%/ },
  objectY: { value: 80, on: "image", css: () => /object-position:[^;"]*80%/ },
  // Hiding is the element's own display, so it is read from the box like any
  // other surface token — and at base it is an ordinary inline declaration.
  hidden: { value: true, on: "box", css: () => /display:\s*none/ },
  // The one token whose rendering depends on the element it lands on.
  opacity: {
    value: 0.55,
    on: "box",
    css: (tag) => (/\breveal\b/.test(classOf(tag)) ? /--eod-node-opacity:\s*0\.55/ : /(^|;)opacity:\s*0\.55/),
  },
};

describe("every control the panel offers does something on the page", () => {
  /**
   * The rule the capability resolver exists for is that a control which does
   * nothing is worse than a missing one — and until this ran, nothing checked
   * the resolver's answer against the renderer. Each node below takes *every*
   * token its own target claims, at once, and every one of them has to appear.
   *
   * With one deliberate exception, added in Batch 14. `layout` and `hidden`
   * both write `display`, and hiding beats laying out on purpose — so applying
   * them together would make one of the two unobservable and this test would be
   * proving less than it looks. They are applied in two passes instead: the
   * whole vocabulary without `hidden`, then `hidden` on its own. Both are
   * asserted, neither is skipped, and the pass that leaves `hidden` out is the
   * one that can see a layout at all.
   */
  const VISIBLE_ONLY: ReadonlySet<string> = new Set(["hidden"]);
  const styleable = (target: { tokens: readonly string[] }) =>
    target.tokens.filter((token) => !VISIBLE_ONLY.has(token));

  /**
   * A second save against a section the first save already moved.
   *
   * The revision guard is doing its job: `saveStyles` sends the revision it was
   * handed, and after one accepted write that number is a revision behind. So
   * the row is re-read first, and the answer is checked rather than merely
   * received — a refused save returns a perfectly well-formed conflict, and a
   * test that accepted one would be asserting against the *previous* document.
   */
  const hide = async (section: SectionRow, path: string) => {
    const current = await row(section.id);
    const saved = answered(
      await saveStyles(current, doc({ [path]: { base: { hidden: true } } })),
    );
    assert.ok(saved.ok, `hiding ${path} was refused`);
  };
  const CASES: { name: string; slug: string; page: string; block: string; path: string; image?: boolean }[] = [
    { name: "a section root", slug: "privacy", page: "/privacy", block: "page-hero", path: "root" },
    { name: "a text field", slug: "privacy", page: "/privacy", block: "page-hero", path: "field:title" },
    { name: "a shared heading's field", slug: "contact", page: "/contact", block: "faq", path: "field:eyebrow" },
  ];

  for (const item of CASES) {
    test(item.name, async () => {
      const section = await find(item.slug, item.block);
      const target = styleTargetFor(item.block, item.path);
      const shown = styleable(target);
      const tokens = Object.fromEntries(shown.map((token) => [token, EXECUTES[token]!.value]));
      assert.ok(target.tokens.length >= 4, `${item.path} offers almost nothing`);

      answered(await saveStyles(section, doc({ [item.path]: { base: tokens } })));

      const address =
        item.path === "root" ? `section:${section.id}` : `section:${section.id}/${item.path}`;
      const html = (await canvas(item.page)).html;
      const tag = tagWith(html, `data-eod-address="${address}"`);
      assert.ok(tag, `${item.path} is not addressable`);
      const style = styleOf(tag);
      for (const token of shown) {
        assert.match(style, EXECUTES[token]!.css(tag), `${item.name}: ${token} did nothing (${style})`);
      }

      // …and hiding, on its own, because it is the one token whose whole job is
      // to beat the others that write the same declaration.
      await hide(section, item.path);
      const hiddenTag = tagWith((await canvas(item.page)).html, `data-eod-address="${address}"`);
      assert.ok(hiddenTag, `${item.path} disappeared from the canvas when hidden`);
      assert.match(styleOf(hiddenTag), /display:\s*none/, `${item.name}: hidden did nothing`);
    });
  }

  test("a repeatable row", async () => {
    const travel = await find("home", "travel-feature");
    const loaded = answered(await loadSection(travel.id, travel.page_id));
    assert.ok(loaded.ok);
    const caps = loaded.section.values.capabilities as Record<string, unknown>[];
    const path = `field:capabilities/item:${String(caps[0]![ITEM_ID_KEY])}`;
    const target = styleTargetFor("travel-feature", path);

    const shown = styleable(target);
    answered(
      await saveStyles(
        travel,
        doc({ [path]: { base: Object.fromEntries(shown.map((t) => [t, EXECUTES[t]!.value])) } }),
      ),
    );

    const html = (await canvas("/")).html;
    const tag = tagWith(html, `data-eod-address="section:${travel.id}/${path}"`);
    assert.ok(tag, "the row is not addressable");
    for (const token of shown) {
      assert.match(styleOf(tag), EXECUTES[token]!.css(tag), `a row's ${token} did nothing`);
    }

    await hide(travel, path);
    const hiddenRow = tagWith((await canvas("/")).html, `data-eod-address="section:${travel.id}/${path}"`);
    assert.ok(hiddenRow, "the hidden row left the canvas");
    assert.match(styleOf(hiddenRow), /display:\s*none/, "a row's hidden did nothing");
  });

  test("a media field, whose controls are split across two elements", async () => {
    const links = await find("home", "quick-links");
    const loaded = answered(await loadSection(links.id, links.page_id));
    assert.ok(loaded.ok);
    const rows = loaded.section.values.links as Record<string, unknown>[];
    const path = `field:links/item:${String(rows[0]![ITEM_ID_KEY])}/field:image`;
    const target = styleTargetFor("quick-links", path);

    const shown = styleable(target);
    answered(
      await saveStyles(
        links,
        doc({ [path]: { base: Object.fromEntries(shown.map((t) => [t, EXECUTES[t]!.value])) } }),
      ),
    );

    const html = (await canvas("/")).html;
    const frame = tagWith(html, `data-eod-address="section:${links.id}/${path}"`);
    assert.ok(frame, "the picture is not addressable");
    const img = tagInside(html, frame, "img");
    assert.ok(img, "the frame holds no picture");
    for (const token of shown) {
      const rule = EXECUTES[token]!;
      const tag = rule.on === "image" ? img : frame;
      assert.match(styleOf(tag), rule.css(tag), `a picture's ${token} did nothing on the ${rule.on}`);
    }

    await hide(links, path);
    const hiddenFrame = tagWith((await canvas("/")).html, `data-eod-address="section:${links.id}/${path}"`);
    assert.ok(hiddenFrame, "the hidden picture left the canvas");
    assert.match(styleOf(hiddenFrame), /display:\s*none/, "a picture's hidden did nothing");
  });

  test("and the vocabulary has no token this could not have checked", () => {
    // If a token is added without a line in the table above, these tests would
    // quietly stop covering it rather than fail.
    for (const token of Object.keys(STYLE_TOKEN_LABELS)) {
      assert.ok(EXECUTES[token], `${token} is offered by the panel and unchecked here`);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("who may style", () => {
  test("a reader may read a section's styles but not write them", async () => {
    const hero = await find("disclaimer", "rich-text");

    const read = answered(
      await callAction<VisualSectionLoad>({
        origin: server.origin,
        route: VE_ROUTE,
        file: VE_ACTIONS,
        action: "loadVisualSection",
        args: [hero.id, hero.page_id],
        cookie: viewer.cookie,
      }),
    );
    assert.equal(read.ok, true);

    const refused = answered(
      await saveStyles(hero, doc({ root: { base: { opacity: 0.5 } } }), {
        cookie: viewer.cookie,
        csrf: viewer.csrfToken,
      }),
    );
    assert.ok(!refused.ok);
    assert.equal(refused.reason, "denied");
    assert.equal((await row(hero.id)).draft_styles, null);
  });

  test("a save without the session's own token is refused", async () => {
    const hero = await find("disclaimer", "rich-text");
    for (const csrf of [null, "", "not-the-token"]) {
      const refused = answered(await saveStyles(hero, doc({ root: { base: { opacity: 0.5 } } }), { csrf }));
      assert.ok(!refused.ok, `csrf ${JSON.stringify(csrf)} was accepted`);
      assert.equal(refused.reason, "denied");
    }
    assert.equal((await row(hero.id)).draft_styles, null);
  });

  test("signed out, nothing is written", async () => {
    const hero = await find("disclaimer", "rich-text");
    const refused = answered(
      await saveStyles(hero, doc({ root: { base: { opacity: 0.5 } } }), { cookie: null }),
    );
    assert.ok(!refused.ok);
    assert.equal(refused.reason, "denied");
    assert.equal((await row(hero.id)).draft_styles, null);
  });

  test("a section belonging to another page is refused", async () => {
    const hero = await find("home", "hero");
    const [about] = await sql<{ id: number }[]>`select id from pages where slug = 'about'`;
    const refused = answered(
      await saveStyles(hero, doc({ root: { base: { opacity: 0.5 } } }), { pageId: about!.id }),
    );
    assert.ok(!refused.ok);
    assert.equal(refused.reason, "wrong_page");
    assert.equal((await row(hero.id)).draft_styles, null);
  });
});

/* -------------------------------------------------------------------------- */

/** Every `--rs-…` custom property on one element, by name. */
function varsOf(tag: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of styleOf(tag).split(";")) {
    const at = part.indexOf(":");
    if (at < 0) continue;
    const name = part.slice(0, at).trim();
    if (name.startsWith("--rs-")) out[name] = part.slice(at + 1).trim();
  }
  return out;
}

/** What a breakpoint's attribute lists on this element. */
const listed = (tag: string | null, attribute: string): string[] => {
  const value = new RegExp(`${attribute}="([^"]*)"`).exec(tag ?? "")?.[1];
  return value ? value.split(" ") : [];
};

describe("a narrower width is a value and a name on the element, and a rule in the stylesheet", () => {
  /**
   * The architecture, asserted at the only place it is observable without a
   * browser: the markup. Base stays the inline declaration it has always been;
   * a tablet or mobile override adds a custom property holding the same mapped
   * value and the name of the declaration it overrides. No media query, no
   * selector and no property name ever comes out of the document — the widths
   * live in `globals.css`, which the pure tests check against the constants.
   */
  test("a section root carries three different paddings as one base and two names", async () => {
    const hero = await find("privacy", "page-hero");
    answered(
      await saveStyles(
        hero,
        doc({
          root: { base: { padBlock: 6 }, tablet: { padBlock: 4 }, mobile: { padBlock: 2 } },
        }),
      ),
    );

    const tag = tagWith((await canvas("/privacy")).html, 'data-section="page-hero"');
    assert.ok(tag, "the section root is not on the page");
    assert.match(styleOf(tag), /padding-block:\s*2rem/, "base is no longer an inline declaration");
    assert.deepEqual(listed(tag, "data-rs-t"), ["padding-block"]);
    assert.deepEqual(listed(tag, "data-rs-m"), ["padding-block"]);
    assert.deepEqual(varsOf(tag), {
      "--rs-t-padding-block": "1rem",
      "--rs-m-padding-block": "0.5rem",
    });
    // One element, one wrapper: the responsive layer adds nothing to the tree.
    assert.equal(
      (await canvas("/privacy")).html.split('data-section="page-hero"').length - 1,
      1,
      "the section wrapper was duplicated",
    );
  });

  test("a type step is replaced whole at each width, tracking included", async () => {
    const hero = await find("about", "page-hero");
    answered(
      await saveStyles(
        hero,
        doc({
          "field:title": {
            base: { fontSize: "h1" },
            tablet: { fontSize: "h2" },
            mobile: { fontSize: "small" },
          },
        }),
      ),
    );

    const tag = tagWith(
      (await canvas("/about")).html,
      `data-eod-address="section:${hero.id}/field:title"`,
    );
    assert.ok(tag, "the title is not addressable");
    const vars = varsOf(tag);
    assert.match(styleOf(tag), /font-size:\s*var\(--text-h1\)/);

    for (const breakpoint of ["t", "m"] as const) {
      const names = listed(tag, `data-rs-${breakpoint}`);
      for (const property of ["font-size", "line-height", "letter-spacing"]) {
        assert.ok(names.includes(property), `${breakpoint}: ${property} was left behind`);
      }
    }
    assert.equal(vars["--rs-t-font-size"], "var(--text-h2)");
    // `small` has no tracking in the ramp, so the override says so explicitly
    // rather than letting the display heading's tracking survive underneath it.
    assert.equal(vars["--rs-m-letter-spacing"], "normal");
  });

  test("a node with no responsive branch renders exactly what Batch 6 rendered", async () => {
    const hero = await find("terms", "page-hero");
    answered(await saveStyles(hero, doc({ "field:title": { base: { textColor: "orange" } } })));
    const tag = tagWith(
      (await canvas("/terms")).html,
      `data-eod-address="section:${hero.id}/field:title"`,
    );
    assert.ok(tag);
    assert.match(styleOf(tag), /color:\s*var\(--color-orange\)/);
    assert.ok(!tag.includes("data-rs-"), "a base-only node was given responsive markup");
    assert.deepEqual(varsOf(tag), {});
  });

  test("an untouched page carries no responsive markup at all", async () => {
    const live = await get(server.origin, "/contact");
    assert.ok(!live.html.includes("data-rs-"), "responsive markup appeared without any override");
    assert.ok(!live.html.includes("--rs-"), "a responsive variable appeared without any override");
  });

  test("the rules the markup names are really in the stylesheet the page loads", async () => {
    const page = await get(server.origin, "/privacy");
    const href = /<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/.exec(page.html)?.[1]
      ?? /<link[^>]+href="([^"]+\.css)"/.exec(page.html)?.[1];
    assert.ok(href, "the page loads no stylesheet");
    const sheet = await get(server.origin, href);
    assert.equal(sheet.status, 200);
    // The build must not have dropped, renamed or re-layered them. The
    // minifier drops the quotes around an attribute value, so the assertions
    // allow for both spellings of the same selector.
    assert.match(sheet.html, /screen and \(max-width:\s*1024px\)/);
    assert.match(sheet.html, /screen and \(max-width:\s*640px\)/);
    assert.match(sheet.html, /\[data-rs-t~="?padding-block"?\]\{padding-block:var\(--rs-t-padding-block\)!important/);
    assert.match(sheet.html, /\[data-rs-m~="?display"?\]\{display:var\(--rs-m-display\)!important/);
    assert.match(sheet.html, /--eod-node-opacity:\s*var\(--rs-m-opacity\)/);
  });
});

/* -------------------------------------------------------------------------- */

describe("a responsive draft is a draft", () => {
  test("the editor and the preview see it, a visitor does not, and publishing changes that", async () => {
    const hero = await find("disclaimer", "page-hero");
    const clean = await get(server.origin, "/disclaimer");
    assert.ok(!clean.html.includes("data-rs-"), "the page started out responsive");

    answered(
      await saveStyles(hero, doc({ "field:title": { mobile: { fontSize: "h3", align: "center" } } })),
    );

    // The authorised canvas has it…
    const canvasTag = tagWith(
      (await canvas("/disclaimer")).html,
      `data-eod-address="section:${hero.id}/field:title"`,
    );
    assert.match(canvasTag ?? "", /data-rs-m="[^"]*font-size/);

    // …so does the ordinary preview screen, with no bridge and no addresses…
    const preview = await get(server.origin, "/disclaimer?preview=1", { cookie: owner.cookie });
    assert.ok(preview.html.includes("--rs-m-font-size"), "the preview screen lost the draft");
    assert.ok(!preview.html.includes("bridgeId"), "the ordinary preview loaded the canvas bridge");
    assert.ok(!/data-eod-/.test(preview.html), "the ordinary preview carried editor markup");

    // …and a visitor has none of it.
    const during = await get(server.origin, "/disclaimer");
    assert.ok(!during.html.includes("data-rs-"), "a responsive draft reached a visitor");
    assert.ok(!during.html.includes("--rs-m-"), "a responsive draft reached a visitor");

    await publishDraft(hero.id);

    const after = await get(server.origin, "/disclaimer");
    assert.ok(after.html.includes('data-rs-m="'), "publishing did not make the override public");
    assert.ok(after.html.includes("--rs-m-font-size"), "publishing did not make the value public");
    assert.ok(!/data-eod-/.test(after.html), "editor markup reached a visitor");

    const row = await sql<{ styles: StyleDocument; draft_styles: unknown }[]>`
      select styles, draft_styles from page_sections where id = ${hero.id}`;
    assert.equal(row[0]!.draft_styles, null);
    assert.deepEqual(row[0]!.styles.nodes["field:title"]!.mobile, { fontSize: "h3", align: "center" });
  });

  test("only the width that was overridden changes; the others keep the design", async () => {
    const section = await find("about", "rich-text");
    answered(await saveStyles(section, doc({ "field:body": { mobile: { textColor: "orange" } } })));
    const tag = tagWith(
      (await canvas("/about")).html,
      `data-eod-address="section:${section.id}/field:body"`,
    );
    assert.ok(tag);
    // Nothing at desktop and nothing at tablet: no inline colour, no tablet
    // attribute. A mobile-only override is a mobile-only override.
    assert.ok(!/(^|;)\s*color:/.test(styleOf(tag)), "a mobile override coloured every width");
    assert.deepEqual(listed(tag, "data-rs-t"), []);
    assert.deepEqual(listed(tag, "data-rs-m"), ["color"]);
  });
});

/* -------------------------------------------------------------------------- */

describe("hiding is a style, and it runs downwards", () => {
  test("a field hidden at mobile stays in the document and takes the display rule", async () => {
    const hero = await find("privacy", "page-hero");
    answered(await saveStyles(hero, doc({ "field:title": { mobile: { hidden: true } } })));

    const html = (await canvas("/privacy")).html;
    const tag = tagWith(html, `data-eod-address="section:${hero.id}/field:title"`);
    // Still rendered, still addressable, still selectable — it is hidden at one
    // width, not removed from the page. That is what makes it recoverable.
    assert.ok(tag, "a hidden node was dropped from the document");
    assert.deepEqual(listed(tag, "data-rs-m"), ["display"]);
    assert.equal(varsOf(tag)["--rs-m-display"], "none");
    assert.deepEqual(listed(tag, "data-rs-t"), [], "hiding at mobile hid it at tablet too");
    // `--rs-m-display` is the value the rule reads; `display` itself is not set.
    assert.ok(
      !/(^|;)\s*display:\s*none/.test(styleOf(tag)),
      "a mobile hide became an unconditional one",
    );
  });

  test("hidden at base is an ordinary declaration, at every width", async () => {
    const hero = await find("terms", "page-hero");
    answered(await saveStyles(hero, doc({ "field:lead": { base: { hidden: true } } })));
    const tag = tagWith(
      (await canvas("/terms")).html,
      `data-eod-address="section:${hero.id}/field:lead"`,
    );
    // The lead is still written into the page: hiding is how it looks, not
    // whether the renderer produced it.
    assert.ok(tag, "a hidden node was dropped from the document");
    assert.match(styleOf(tag), /(^|;)\s*display:\s*none/);
    assert.ok(!tag.includes("data-rs-"), "a base hide needed a breakpoint rule");
  });

  test("one row of a list hides without taking its neighbours with it", async () => {
    const links = await find("home", "quick-links");
    const loaded = answered(await loadSection(links.id, links.page_id));
    assert.ok(loaded.ok);
    const rows = loaded.section.values.links as Record<string, unknown>[];
    const hidden = String(rows[2]![ITEM_ID_KEY]);
    const neighbour = String(rows[3]![ITEM_ID_KEY]);

    const styled = answered(
      await saveStyles(links, doc({ [`field:links/item:${hidden}`]: { mobile: { hidden: true } } })),
    );
    assert.ok(styled.ok);

    const html = (await canvas("/")).html;
    const tag = tagWith(html, `data-eod-address="section:${links.id}/field:links/item:${hidden}"`);
    assert.ok(tag, "the hidden row left the page");
    assert.equal(varsOf(tag)["--rs-m-display"], "none");
    const other = tagWith(html, `data-eod-address="section:${links.id}/field:links/item:${neighbour}"`);
    assert.ok(other, "the neighbour left the page");
    assert.ok(!other.includes("data-rs-"), "a neighbour was hidden too");

    // The list is reordered underneath it: hiding follows the row's own id.
    const reordered = [rows[2], ...rows.filter((_, index) => index !== 2)];
    const content = answered(
      await saveContent(
        { ...links, revision: styled.revision },
        { ...loaded.section.values, links: reordered },
      ),
    );
    assert.equal(content.ok, true, JSON.stringify(content));

    const moved = (await canvas("/")).html;
    const stillHidden = tagWith(moved, `data-eod-address="section:${links.id}/field:links/item:${hidden}"`);
    assert.equal(varsOf(stillHidden)["--rs-m-display"], "none", "hiding stayed at the old position");
    const nowSecond = tagWith(moved, `data-eod-address="section:${links.id}/field:links/item:${neighbour}"`);
    assert.ok(!nowSecond?.includes("data-rs-"), "a row inherited hiding by moving into a position");
  });

  test("a section hidden at mobile is still a published section", async () => {
    const section = await find("about", "why-us");
    const before = await row(section.id);
    answered(await saveStyles(section, doc({ root: { mobile: { hidden: true } } })));
    await publishDraft(section.id);

    const after = await row(section.id);
    // Responsive visibility is a style token. It is not the section's
    // publication state and it is not the structural draft's visibility, and
    // touching either of those from here would make a layout decision into a
    // lifecycle one.
    assert.equal(after.is_published, before.is_published, "hiding at a width unpublished a section");
    assert.equal(after.is_draft_only, before.is_draft_only);
    assert.equal(after.position, before.position);
    assert.deepEqual(after.published, before.published);

    const screen = await get(server.origin, "/admin/pages/about", { cookie: owner.cookie });
    assert.ok(!/Reload the page/i.test(screen.html));
    const live = await get(server.origin, "/about");
    const tag = tagWith(live.html, 'data-section="why-us"');
    assert.ok(tag, "the section stopped being served");
    assert.equal(varsOf(tag)["--rs-m-display"], "none");
  });

  test("a hidden draft is invisible to a visitor until it is published", async () => {
    const section = await find("contact", "faq");
    answered(await saveStyles(section, doc({ root: { mobile: { hidden: true } } })));
    const during = await get(server.origin, "/contact");
    assert.ok(!during.html.includes("--rs-m-display"), "a hide reached a visitor as a draft");
    await publishDraft(section.id);
    const after = await get(server.origin, "/contact");
    assert.equal(varsOf(tagWith(after.html, 'data-section="faq"'))["--rs-m-display"], "none");
  });

  test("`hidden: false` does not survive the save, in any branch", async () => {
    const hero = await find("terms", "page-hero");
    const before = await row(hero.id);

    const saved = answered(
      await saveStyles(
        hero,
        doc({
          root: { base: { hidden: false, padBlock: 4 } },
          "field:title": {
            base: { hidden: false, textColor: "orange" },
            tablet: { hidden: false, fontSize: "h3" },
            mobile: { hidden: false, align: "center" },
          },
          "field:lead": { base: { hidden: false } },
        }),
      ),
    );
    assert.ok(saved.ok);

    // The document has exactly one spelling for "shown", and it is silence.
    assert.deepEqual(saved.styles.nodes.root, { base: { padBlock: 4 } });
    assert.deepEqual(saved.styles.nodes["field:title"], {
      base: { textColor: "orange" },
      tablet: { fontSize: "h3" },
      mobile: { align: "center" },
    });
    assert.equal(saved.styles.nodes["field:lead"], undefined, "a node was kept for a false");

    const stored = JSON.stringify((await row(hero.id)).draft_styles);
    assert.ok(!stored.includes("hidden"), `a hide was stored: ${stored}`);
    assert.ok(!stored.includes("false"), `a false was stored: ${stored}`);

    // …and nothing of it renders: no display declaration and no display marker.
    const html = (await canvas("/terms")).html;
    const rootTag = tagWith(html, 'data-section="page-hero"');
    assert.ok(!/(^|;)\s*display:\s*none/.test(styleOf(rootTag)), "a false hid the section");
    const titleTag = tagWith(html, `data-eod-address="section:${hero.id}/field:title"`);
    assert.ok(titleTag, "the title is not addressable");
    assert.deepEqual(listed(titleTag, "data-rs-t"), ["font-size", "line-height", "letter-spacing"]);
    assert.deepEqual(listed(titleTag, "data-rs-m"), ["text-align"]);
    assert.ok(!listed(titleTag, "data-rs-t").includes("display"), "a false became a tablet rule");
    assert.ok(!listed(titleTag, "data-rs-m").includes("display"), "a false became a mobile rule");

    // The save itself was an ordinary one.
    const after = await row(hero.id);
    assert.equal(after.revision, before.revision + 1);
    assert.equal(saved.revision, before.revision + 1);
    assert.deepEqual(after.published, before.published);
    assert.equal(after.draft, before.draft);
  });

  test("…and `hidden: true` still does, in the same three places", async () => {
    const hero = await find("terms", "page-hero");
    const saved = answered(
      await saveStyles(
        hero,
        doc({
          root: { base: { hidden: true } },
          "field:title": { tablet: { hidden: true } },
          "field:lead": { mobile: { hidden: true } },
        }),
      ),
    );
    assert.ok(saved.ok);
    assert.deepEqual(saved.styles.nodes.root, { base: { hidden: true } });
    assert.deepEqual(saved.styles.nodes["field:title"], { tablet: { hidden: true } });
    assert.deepEqual(saved.styles.nodes["field:lead"], { mobile: { hidden: true } });

    const html = (await canvas("/terms")).html;
    assert.match(styleOf(tagWith(html, 'data-section="page-hero"')), /(^|;)\s*display:\s*none/);
    assert.deepEqual(
      listed(tagWith(html, `data-eod-address="section:${hero.id}/field:title"`), "data-rs-t"),
      ["display"],
    );
    assert.deepEqual(
      listed(tagWith(html, `data-eod-address="section:${hero.id}/field:lead"`), "data-rs-m"),
      ["display"],
    );
  });

  test("clearing the override brings it back with nothing stored to say so", async () => {
    const section = await find("contact", "faq");
    const cleared = answered(await saveStyles(section, doc({})));
    assert.ok(cleared.ok);
    await publishDraft(section.id);
    const after = await get(server.origin, "/contact");
    const tag = tagWith(after.html, 'data-section="faq"');
    assert.ok(tag, "the section disappeared");
    assert.ok(!tag.includes("data-rs-"), "clearing a hide left markup behind");
    const stored = (await row(section.id)).styles as StyleDocument;
    assert.deepEqual(stored.nodes, {}, "`hidden: false` was stored to mean shown");
  });
});

/* -------------------------------------------------------------------------- */

describe("the pieces Batch 6 built keep their shape at the other two widths", () => {
  test("a picture's crop is the picture's at every width, and the frame keeps the shape", async () => {
    const section = await find("about", "image-text");
    const [picture] = await sql<{ id: number }[]>`select id from media order by id limit 1`;
    const loaded = answered(await loadSection(section.id, section.page_id));
    assert.ok(loaded.ok);
    answered(await saveContent(section, { ...loaded.section.values, image: picture!.id }));

    const withImage = await row(section.id);
    answered(
      await saveStyles(
        withImage,
        doc({
          "field:image": {
            base: { objectX: 50, objectY: 50, radius: "lg" },
            tablet: { objectY: 30 },
            mobile: { objectX: 20, objectY: 75, border: "accent" },
          },
        }),
      ),
    );

    const html = (await canvas("/about")).html;
    const frame = tagWith(html, `data-eod-address="section:${section.id}/field:image"`);
    assert.ok(frame, "the picture is not addressable");
    const img = tagInside(html, frame, "img");
    assert.ok(img, "the frame holds no picture");

    // The frame: shape at every width, and never a crop.
    assert.match(styleOf(frame), /border-radius:\s*var\(--radius-lg\)/);
    assert.deepEqual(listed(frame, "data-rs-m"), ["border"]);
    assert.deepEqual(listed(frame, "data-rs-t"), []);
    assert.ok(!/object-position/.test(styleOf(frame)), "a crop was parked on the frame");

    // The picture: the crop at every width, and never the frame's shape.
    assert.match(styleOf(img), /object-position:\s*50%\s*50%/);
    assert.deepEqual(listed(img, "data-rs-t"), ["object-position"]);
    assert.deepEqual(listed(img, "data-rs-m"), ["object-position"]);
    const vars = varsOf(img);
    // The tablet branch moved only the vertical axis, so the horizontal one it
    // inherited comes with it rather than snapping back to centre.
    assert.equal(vars["--rs-t-object-position"], "50% 30%");
    assert.equal(vars["--rs-m-object-position"], "20% 75%");
    assert.ok(!/border-radius/.test(styleOf(img)), "the frame's shape was copied onto the picture");
    assert.ok(!img.includes("data-eod-"), "the picture took an address of its own");
  });

  test("a revealed row's opacity is renamed at every width, so the fade survives", async () => {
    const travel = await find("home", "travel-feature");
    const loaded = answered(await loadSection(travel.id, travel.page_id));
    assert.ok(loaded.ok);
    const caps = loaded.section.values.capabilities as Record<string, unknown>[];
    const path = `field:capabilities/item:${String(caps[1]![ITEM_ID_KEY])}`;

    answered(
      await saveStyles(
        travel,
        doc({ [path]: { base: { opacity: 1 }, tablet: { opacity: 0.75 }, mobile: { opacity: 0.45 } } }),
      ),
    );

    const tag = tagWith((await canvas("/")).html, `data-eod-address="section:${travel.id}/${path}"`);
    assert.ok(tag, "the row is not addressable");
    assert.match(classOf(tag), /\breveal\b/, "this row is not revealed, so the test proves nothing");

    // Not `opacity` at any width: an inline or important `opacity` outranks the
    // class that holds a reveal at 0, and the row would sit at 45% before it
    // had been revealed at all.
    assert.deepEqual(listed(tag, "data-rs-t"), ["reveal-opacity"]);
    assert.deepEqual(listed(tag, "data-rs-m"), ["reveal-opacity"]);
    const style = styleOf(tag);
    assert.match(style, /--eod-node-opacity:\s*1/);
    assert.match(style, /--rs-t-opacity:\s*0\.75/);
    assert.match(style, /--rs-m-opacity:\s*0\.45/);
    assert.ok(!/(^|;)\s*opacity:/.test(style), `an inline opacity overrode the lifecycle: ${style}`);
    assert.match(style, /--reveal-delay:/, "the reveal's own delay was lost");
    assert.match(tag, /data-shown="false"/);
  });

  test("a shared heading takes its overrides at every width too", async () => {
    const travel = await find("home", "travel-feature");
    answered(
      await saveStyles(
        travel,
        doc({
          "field:title": { base: { textColor: "orange" }, mobile: { fontSize: "h3" } },
        }),
      ),
    );
    const tag = tagWith((await canvas("/")).html, `data-eod-address="section:${travel.id}/field:title"`);
    assert.ok(tag, "the shared heading is not addressable");
    assert.match(tag, /^<h2\b/);
    assert.match(styleOf(tag), /color:\s*var\(--color-orange\)/);
    assert.deepEqual(listed(tag, "data-rs-m"), ["font-size", "line-height", "letter-spacing"]);
  });
});

/* -------------------------------------------------------------------------- */

describe("one document, both directions", () => {
  test("the same responsive overrides lay out in Arabic with nothing physical in them", async () => {
    const hero = await find("privacy", "page-hero");
    answered(
      await saveStyles(
        hero,
        doc({
          root: { base: { padInline: 6 }, tablet: { padInline: 4 }, mobile: { padInline: 2 } },
          "field:title": { base: { align: "start" }, mobile: { align: "center" } },
        }),
      ),
    );

    for (const path of ["/privacy?preview=1", "/ar/privacy?preview=1"]) {
      const page = await get(server.origin, path, { cookie: owner.cookie });
      const root = tagWith(page.html, 'data-section="page-hero"');
      assert.match(styleOf(root), /padding-inline:/, path);
      assert.deepEqual(listed(root, "data-rs-t"), ["padding-inline"], path);
      assert.deepEqual(listed(root, "data-rs-m"), ["padding-inline"], path);
      assert.equal(varsOf(root)["--rs-m-padding-inline"], "0.5rem", path);
      assert.ok(
        !/padding-left|padding-right|margin-left|margin-right/.test(styleOf(root)),
        `physical spacing in ${path}`,
      );
      assert.match(page.html, /--rs-m-text-align:\s*center/, path);
      assert.ok(!/--rs-m-text-align:\s*(left|right)/.test(page.html), `a physical alignment in ${path}`);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("a responsive branch is validated exactly as hard as base", () => {
  test("hostile keys inside tablet and mobile do not survive", async () => {
    const hero = await find("privacy", "page-hero");
    const hostile = {
      css: "color: red",
      style: "color: red",
      class: "danger",
      className: "danger",
      selector: ".title",
      backgroundImage: "url(https://evil.example/x.png)",
      position: "absolute",
      left: "0px",
      right: "0px",
      transform: "scale(9)",
      filter: "blur(4px)",
      "--rogue": "red",
      padBlock: 999,
      opacity: Number.POSITIVE_INFINITY,
      objectX: -20,
      hidden: "yes",
    };

    const saved = answered(
      await saveStyles(
        hero,
        doc({
          "field:title": {
            base: { textColor: "orange" },
            tablet: { fontSize: "h3", ...hostile },
            mobile: { align: "center", ...hostile },
          },
        }),
      ),
    );
    assert.ok(saved.ok);
    assert.deepEqual(saved.styles.nodes["field:title"]!.tablet, { fontSize: "h3" });
    assert.deepEqual(saved.styles.nodes["field:title"]!.mobile, { align: "center" });

    const serialised = JSON.stringify((await row(hero.id)).draft_styles);
    for (const forbidden of ["css", "class", "selector", "url(", "transform", "absolute", "rogue"]) {
      assert.ok(!serialised.includes(forbidden), `${forbidden} survived into the column`);
    }

    // …and nothing of it reaches the page either.
    const html = (await canvas("/privacy")).html;
    const tag = tagWith(html, `data-eod-address="section:${hero.id}/field:title"`);
    assert.deepEqual(listed(tag, "data-rs-t"), ["font-size", "line-height", "letter-spacing"]);
    assert.deepEqual(listed(tag, "data-rs-m"), ["text-align"]);
  });

  test("there are three branches and no others — no custom breakpoints", async () => {
    const hero = await find("terms", "page-hero");
    const saved = answered(
      await saveStyles(
        hero,
        doc({
          "field:title": {
            base: { textColor: "orange" },
            tablet: { fontSize: "h3" },
            mobile: { align: "center" },
            desktop: { fontSize: "display" },
            phone: { fontSize: "small" },
            sm: { fontSize: "small" },
            md: { fontSize: "small" },
            xl: { fontSize: "small" },
            landscape: { fontSize: "small" },
            "@media (max-width: 300px)": { hidden: true },
            "1024": { hidden: true },
          },
        }),
      ),
    );
    assert.ok(saved.ok);
    assert.deepEqual(Object.keys(saved.styles.nodes["field:title"]!).sort(), [
      "base",
      "mobile",
      "tablet",
    ]);
    const stored = JSON.stringify((await row(hero.id)).draft_styles);
    for (const forbidden of ["desktop", "phone", "landscape", "@media", '"sm"', '"xl"']) {
      assert.ok(!stored.includes(forbidden), `${forbidden} survived as a breakpoint`);
    }
  });

  test("a reader may not write a responsive override, and an untokened save is refused", async () => {
    const hero = await find("about", "page-hero");
    const before = await row(hero.id);

    const asReader = await saveStyles(hero, doc({ root: { mobile: { hidden: true } } }), {
      cookie: viewer.cookie,
      csrf: viewer.csrfToken,
    });
    assert.ok(!asReader.value?.ok, "a reader hid a section");

    const noToken = await saveStyles(hero, doc({ root: { mobile: { hidden: true } } }), { csrf: null });
    assert.ok(!noToken.value?.ok, "a save without the session's token was accepted");

    const signedOut = await saveStyles(hero, doc({ root: { mobile: { hidden: true } } }), {
      cookie: null,
    });
    assert.ok(!signedOut.value?.ok, "a signed-out save was accepted");

    const wrongPage = await saveStyles(hero, doc({ root: { mobile: { hidden: true } } }), {
      pageId: hero.page_id + 1000,
    });
    assert.ok(!wrongPage.value?.ok, "a section was styled through another page");

    const after = await row(hero.id);
    assert.deepEqual(after.draft_styles, before.draft_styles);
    assert.equal(after.revision, before.revision);
  });
});

/* -------------------------------------------------------------------------- */

describe("responsive changes nothing about how a section is saved", () => {
  test("one revision, one save, all three branches together", async () => {
    const hero = await find("disclaimer", "page-hero");
    const before = await row(hero.id);

    const saved = answered(
      await saveStyles(
        hero,
        doc({
          root: { base: { padBlock: 6 } },
          "field:title": { tablet: { fontSize: "h3" } },
          "field:lead": { mobile: { hidden: true } },
        }),
      ),
    );
    assert.ok(saved.ok);
    // Three branches across three nodes, and the counter moved once.
    assert.equal(saved.revision, before.revision + 1);
    const after = await row(hero.id);
    assert.equal(after.revision, before.revision + 1);
    assert.deepEqual(after.published, before.published, "content went live");
    assert.equal(after.draft, before.draft, "a content draft appeared");
    assert.equal(after.animation, before.animation);
    assert.equal(after.draft_animation, before.draft_animation);

    // …and the normal admin needs to know nothing about breakpoints.
    const screen = await get(server.origin, `/admin/pages/section/${hero.id}`, {
      cookie: owner.cookie,
    });
    assert.match(screen.html, /Style draft/);
  });

  test("a stale responsive save conflicts exactly as a base one does", async () => {
    const hero = await find("disclaimer", "rich-text");
    const first = answered(await saveStyles(hero, doc({ root: { mobile: { hidden: true } } })));
    assert.ok(first.ok);

    // The same screen's revision, now one behind.
    const stale = answered(await saveStyles(hero, doc({ root: { tablet: { padBlock: 2 } } })));
    assert.equal(stale.ok, false);
    assert.ok(!stale.ok && stale.reason === "conflict", JSON.stringify(stale));
    assert.ok(!stale.ok && stale.section, "the conflict did not offer the version that won");
    // Nothing was merged: the row still holds the first save, whole.
    const after = await row(hero.id);
    assert.deepEqual((after.draft_styles as StyleDocument).nodes, {
      root: { mobile: { hidden: true } },
    });
  });

  test("no style document and no breakpoint machinery reaches a visitor", async () => {
    const live = await get(server.origin, "/disclaimer");
    assert.ok(!live.html.includes('"nodes":'), "a raw style document reached the page");
    assert.ok(!live.html.includes('"tablet":'), "a raw branch reached the page");
    assert.ok(!live.html.includes("draft_styles"));
    assert.ok(!live.html.includes("data-eod-"), "editor markup reached a visitor");
    assert.ok(!live.html.includes("styleTargetFor"), "panel code reached a visitor");
    assert.ok(!live.html.includes("Tablet override"), "panel copy reached a visitor");
  });
});

/* -------------------------------------------------------------------------- */

describe("nothing else woke up", () => {
  test("motion is untouched by a style save", async () => {
    const hero = await find("privacy", "rich-text");
    const before = await row(hero.id);
    answered(await saveStyles(hero, doc({ root: { base: { opacity: 0.5 } } })));
    const after = await row(hero.id);
    assert.equal(after.animation, before.animation);
    assert.equal(after.draft_animation, before.draft_animation);
  });

  test("a responsive branch renders as a value and a name, and never as a rule", async () => {
    const hero = await find("privacy", "rich-text");
    const saved = answered(
      await saveStyles(
        hero,
        doc({
          "field:body": {
            base: { textColor: "peach" },
            tablet: { fontSize: "h3" },
            mobile: { align: "center" },
          },
        }),
      ),
    );
    assert.ok(saved.ok);
    assert.deepEqual(saved.styles.nodes["field:body"]!.tablet, { fontSize: "h3" });
    assert.deepEqual(saved.styles.nodes["field:body"]!.mobile, { align: "center" });

    const preview = await canvas("/privacy");
    const tag = tagWith(preview.html, `data-eod-address="section:${hero.id}/field:body"`);
    assert.ok(tag, "the body is not addressable on the canvas");
    const style = styleOf(tag);

    // Base is still the declaration it always was.
    assert.match(style, /color:\s*var\(--color-peach\)/);
    // The other two widths are values parked under names this repository owns,
    // read by rules that live in the stylesheet. Nothing conditional, and no
    // second declaration of the same property, reaches the element.
    assert.match(tag, /data-rs-t="[^"]*font-size/);
    assert.match(tag, /data-rs-m="[^"]*text-align/);
    assert.match(style, /--rs-t-font-size:\s*var\(--text-h3\)/);
    assert.match(style, /--rs-m-text-align:\s*center/);
    assert.ok(!/(^|;)\s*font-size:/.test(style), "a tablet override became a desktop declaration");
    assert.ok(!/(^|;)\s*text-align:/.test(style), "a mobile override became a desktop declaration");
    // And the document itself never travels to the page, at any width.
    assert.ok(!/@media/.test(tag), "a media query was written into an element");
    assert.ok(!preview.html.includes('"tablet":'), "a raw style branch reached the page");
  });

  test("a visitor gets no editor code, no bridge and no style document", async () => {
    const live = await get(server.origin, "/privacy");
    assert.ok(!live.html.includes("bridgeId"));
    assert.ok(!/data-eod-/.test(live.html));
    assert.ok(!live.html.includes('"nodes":'), "a raw style document reached the page");
    assert.ok(!live.html.includes("draft_styles"));
  });
});

/* -------------------------------------------------------------------------- */

/**
 * Batch 14 — the layout controls, end to end on the real renderer.
 *
 * Everything the tokens themselves do is asserted in `layout-tokens.test.ts`,
 * which is pure. What can only be asserted here is that they survive the whole
 * path: a save through the real action, into the real draft column, out through
 * the real page renderer, onto the element the panel said it was styling, and
 * no further — not onto a visitor's page until somebody publishes it.
 */
describe("a layout override travels the whole path, and no further", () => {
  test("a real list container is addressable, and takes a layout the panel could offer", async () => {
    const section = await find("home", "why-us");
    const path = "field:points";
    // The registry calls this node a grid, so the panel offers columns, gap and
    // alignment on it with no override first. If the markup ever stopped being
    // the grid, this is where the claim and the page would part company.
    assert.equal(styleTargetFor("why-us", path).layout, "grid");

    answered(
      await saveStyles(
        section,
        doc({ [path]: { base: { columns: 3, gap: 8, justify: "between", alignItems: "center" } } }),
      ),
    );

    const tag = tagWith((await canvas("/")).html, `data-eod-address="section:${section.id}/${path}"`);
    assert.ok(tag, "the list container is not addressable");
    const style = styleOf(tag);
    assert.match(style, /grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/);
    assert.match(style, /gap:\s*3rem/);
    assert.match(style, /justify-content:\s*space-between/);
    assert.match(style, /align-items:\s*center/);
    // The element is the `<ul>` the block renders, not a wrapper invented for
    // the editor: it is the same tag a visitor gets.
    assert.match(tag, /^<ul/);
  });

  test("four columns, two on a tablet, one on a phone — three numbers, one element", async () => {
    const section = await find("home", "quick-links");
    const path = "field:links";
    answered(
      await saveStyles(
        section,
        doc({
          [path]: {
            base: { layout: "grid", columns: 4 },
            tablet: { columns: 2 },
            mobile: { columns: 1 },
          },
        }),
      ),
    );

    const tag = tagWith((await canvas("/")).html, `data-eod-address="section:${section.id}/${path}"`);
    assert.ok(tag, "the card grid is not addressable");
    assert.match(styleOf(tag), /grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/);
    const vars = varsOf(tag);
    assert.equal(vars["--rs-t-grid-template-columns"], "repeat(2, minmax(0, 1fr))");
    assert.equal(vars["--rs-m-grid-template-columns"], "repeat(1, minmax(0, 1fr))");
    for (const breakpoint of ["t", "m"] as const) {
      assert.deepEqual(listed(tag, `data-rs-${breakpoint}`), ["grid-template-columns"]);
    }
    // Only what each branch declares: the display that made it a grid is base's
    // and is not repeated, or a later change to base would stop reaching them.
    assert.ok(!listed(tag, "data-rs-t").includes("display"));
  });

  test("resetting the phone's column count makes it follow the tablet again", async () => {
    const section = await find("home", "quick-links");
    const path = "field:links";
    const current = await row(section.id);
    answered(
      await saveStyles(
        current,
        doc({ [path]: { base: { layout: "grid", columns: 4 }, tablet: { columns: 2 } } }),
      ),
    );

    const tag = tagWith((await canvas("/")).html, `data-eod-address="section:${section.id}/${path}"`);
    assert.ok(tag);
    const vars = varsOf(tag);
    assert.equal(vars["--rs-t-grid-template-columns"], "repeat(2, minmax(0, 1fr))");
    assert.ok(
      !("--rs-m-grid-template-columns" in vars),
      "the phone froze a copy of the tablet instead of inheriting it",
    );
    assert.deepEqual(listed(tag, "data-rs-m"), []);
  });

  test("a shadow and a glow arrive together, and clearing one leaves the other", async () => {
    const section = await find("about", "page-hero");
    answered(await saveStyles(section, doc({ root: { base: { shadow: "lift", glow: "accent" } } })));

    const both = tagWith((await canvas("/about")).html, `data-eod-address="section:${section.id}"`);
    assert.match(styleOf(both), /box-shadow:\s*var\(--shadow-lift\),\s*var\(--glow-accent\)/);

    // Clearing the shadow is deleting its key, and the glow is untouched.
    answered(await saveStyles(await row(section.id), doc({ root: { base: { glow: "accent" } } })));
    const glowOnly = tagWith((await canvas("/about")).html, `data-eod-address="section:${section.id}"`);
    assert.match(styleOf(glowOnly), /box-shadow:\s*var\(--glow-accent\)/);
    assert.ok(!styleOf(glowOnly).includes("--shadow-lift"), "the shadow survived being cleared");

    // …and the other way round.
    answered(await saveStyles(await row(section.id), doc({ root: { base: { shadow: "lift" } } })));
    const shadowOnly = tagWith((await canvas("/about")).html, `data-eod-address="section:${section.id}"`);
    assert.match(styleOf(shadowOnly), /box-shadow:\s*var\(--shadow-lift\)/);
    assert.ok(!styleOf(shadowOnly).includes("--glow-accent"), "the glow survived being cleared");
  });

  test("the stylesheet the page loads really carries the new rules", async () => {
    const page = await get(server.origin, "/privacy");
    const href = /<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/.exec(page.html)?.[1]
      ?? /<link[^>]+href="([^"]+\.css)"/.exec(page.html)?.[1];
    assert.ok(href, "the page loads no stylesheet");
    const sheet = await get(server.origin, href);
    assert.equal(sheet.status, 200);
    for (const property of [
      "width",
      "height",
      "min-height",
      "flex-direction",
      "flex-wrap",
      "justify-content",
      "align-items",
      "grid-template-columns",
      "overflow",
    ]) {
      assert.match(
        sheet.html,
        new RegExp(`\\[data-rs-t~="?${property}"?\\]\\{${property}:var\\(--rs-t-${property}\\)!important`),
        `no tablet rule for ${property}`,
      );
      assert.match(
        sheet.html,
        new RegExp(`\\[data-rs-m~="?${property}"?\\]\\{${property}:var\\(--rs-m-${property}\\)!important`),
        `no mobile rule for ${property}`,
      );
    }
    // And the glow values themselves are in the built stylesheet, or every
    // `var(--glow-…)` the renderer writes would resolve to nothing.
    for (const name of ["--glow-soft", "--glow-accent", "--glow-strong"]) {
      assert.ok(sheet.html.includes(`${name}:`), `${name} is missing from the built stylesheet`);
    }
  });

  test("a layout draft is a draft: canvas, preview, visitor, publish", async () => {
    const section = await find("terms", "page-hero");
    const clean = await get(server.origin, "/terms");
    assert.ok(!clean.html.includes("min-height:50svh"), "the page started out styled");

    answered(
      await saveStyles(
        section,
        doc({ root: { base: { layout: "flex", alignItems: "center", minHeight: "half-screen" } } }),
      ),
    );

    const canvasTag = tagWith((await canvas("/terms")).html, `data-eod-address="section:${section.id}"`);
    assert.match(styleOf(canvasTag), /min-height:\s*50svh/);
    assert.match(styleOf(canvasTag), /display:\s*flex/);

    const preview = await get(server.origin, "/terms?preview=1", { cookie: owner.cookie });
    assert.ok(preview.html.includes("min-height:50svh"), "the preview lost the draft");
    assert.ok(!/data-eod-/.test(preview.html), "the ordinary preview carried editor markup");

    const during = await get(server.origin, "/terms");
    assert.ok(!during.html.includes("min-height:50svh"), "a layout draft reached a visitor");

    await publishDraft(section.id);

    const after = await get(server.origin, "/terms");
    assert.ok(after.html.includes("min-height:50svh"), "publishing did not make the layout public");
    assert.ok(after.html.includes("align-items:center"), "publishing lost half the layout");
    assert.ok(!/data-eod-/.test(after.html), "editor markup reached a visitor");
  });

  test("a layout save shares the section's revision with content, in that order", async () => {
    const section = await find("contact", "page-hero");

    const content = answered(await saveContent(section, { title: { en: "Layout first", ar: "" } }));
    assert.equal(content.ok, true);
    const revision = content.section!.revision;

    const styled = answered(
      await saveStyles(
        { ...section, revision },
        doc({ root: { base: { layout: "grid", columns: 2, overflow: "hidden" } } }),
      ),
    );
    assert.ok(styled.ok, JSON.stringify(styled));
    assert.equal(styled.revision, revision + 1);

    const after = await row(section.id);
    assert.equal((after.draft!.title as { en: string }).en, "Layout first");
    assert.deepEqual((after.draft_styles as StyleDocument).nodes.root, {
      base: { layout: "grid", columns: 2, overflow: "hidden" },
    });

    // …and a layout save against the revision that has already moved is refused
    // rather than quietly overwriting the content save that moved it.
    const refused = answered(await saveStyles({ ...section, revision }, doc({ root: { base: { width: "half" } } })));
    assert.ok(!refused.ok);
    assert.equal(refused.reason, "conflict");
    assert.deepEqual(
      ((await row(section.id)).draft_styles as StyleDocument).nodes.root,
      { base: { layout: "grid", columns: 2, overflow: "hidden" } },
      "the refused save wrote anyway",
    );
  });

  test("a hostile layout document reaches the page as nothing at all", async () => {
    const section = await find("disclaimer", "page-hero");
    answered(
      await saveStyles(section, {
        v: STYLE_DOCUMENT_VERSION,
        nodes: {
          root: {
            base: {
              layout: "grid",
              columns: 99,
              width: "calc(100vw - 2rem)",
              height: "500px",
              overflow: "scroll",
              glow: "0 0 40px red",
              gridTemplateColumns: "repeat(99, 1fr)",
              style: "position:fixed;inset:0",
              "--rogue": "red",
            },
          },
        },
      }),
    );

    const stored = (await row(section.id)).draft_styles as StyleDocument;
    assert.deepEqual(stored.nodes.root, { base: { layout: "grid" } });

    const tag = tagWith((await canvas("/disclaimer")).html, `data-eod-address="section:${section.id}"`);
    const style = styleOf(tag);
    assert.match(style, /display:\s*grid/);
    for (const forbidden of ["calc(", "500px", "scroll", "repeat(99", "position:fixed", "rogue", "0 0 40px red"]) {
      assert.ok(!style.includes(forbidden), `${forbidden} reached the page`);
    }
  });
});
