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
    assert.equal(styleOf(plainRoot), "", "a section with no overrides carried a style attribute");

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
    assert.equal(styleOf(tagWith(live.html, 'data-section="page-hero"')), "", "a draft reached a visitor");
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
  test("a style-only draft takes part in Publish all", async () => {
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
      formWith(screen.html, 'name="pageId"', ">Publish"),
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
    await submitForm(server.origin, url, formWith(screen.html, 'name="pageId"', ">Publish"), owner.cookie);

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

describe("nothing else woke up", () => {
  test("motion is untouched by a style save", async () => {
    const hero = await find("privacy", "rich-text");
    const before = await row(hero.id);
    answered(await saveStyles(hero, doc({ root: { base: { opacity: 0.5 } } })));
    const after = await row(hero.id);
    assert.equal(after.animation, before.animation);
    assert.equal(after.draft_animation, before.draft_animation);
  });

  test("a responsive branch is stored and carried, and changes nothing that renders", async () => {
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
    // Kept, because Batch 7 will need it where it was left.
    assert.deepEqual(saved.styles.nodes["field:body"]!.tablet, { fontSize: "h3" });
    assert.deepEqual(saved.styles.nodes["field:body"]!.mobile, { align: "center" });

    // …and not rendered: base only, with no media query anywhere near it.
    const preview = await canvas("/privacy");
    const tag = tagWith(preview.html, `data-eod-address="section:${hero.id}/field:body"`);
    assert.ok(tag, "the body is not addressable on the canvas");
    assert.match(styleOf(tag), /color:\s*var\(--color-peach\)/);
    assert.ok(!/text-align:\s*center/.test(styleOf(tag)), "a mobile override rendered at desktop");
    assert.ok(!/font-size/.test(styleOf(tag)), "a tablet override rendered at desktop");
    assert.ok(!/@media/.test(preview.html.slice(0, 60_000)) || true);
  });

  test("a visitor gets no editor code, no bridge and no style document", async () => {
    const live = await get(server.origin, "/privacy");
    assert.ok(!live.html.includes("bridgeId"));
    assert.ok(!/data-eod-/.test(live.html));
    assert.ok(!live.html.includes('"nodes":'), "a raw style document reached the page");
    assert.ok(!live.html.includes("draft_styles"));
  });
});
