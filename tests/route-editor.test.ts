/**
 * Batch 21: service-category pages in the Visual Editor, against a real
 * server and a real database.
 *
 * What these hold, in the brief's words: discovery from the database (a
 * category created later appears with no code), the real route in the canvas
 * in both editions, drafts that never touch live content, an atomic
 * publication that refuses on any conflict, discard that removes only drafts,
 * optimistic concurrency, history with compare and restore-to-draft,
 * permissions and CSRF on every action, no editor metadata on the public
 * page, no duplicated records, and the existing page editor and admin forms
 * still working.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { callAction } from "./helpers/action";
import { giveFresh } from "./helpers/fixtures";
import { get } from "./helpers/http";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { BUILD_HINT, isBuilt, startServer, type Server } from "./helpers/server";
import { signIn, type TestSession } from "./helpers/session";

import type { PermissionKey } from "@/lib/auth/permissions";
import { STYLE_DOCUMENT_VERSION } from "@/lib/cms/styles";
import { documentEditorKey, editorKeyOf, type RouteOwner } from "@/lib/routes/owners";
import { hasPackageHub } from "@/lib/routes/package-hub";
import type { RouteActionResult, RouteCompareView, RouteHistoryView, RouteSummaryView } from "@/lib/routes/views";
import type { VisualContentSaveResult, VisualSectionLoad } from "@/lib/visual-editor/content";

const PORT = 3507;
const ROUTE_ACTIONS = "app/(backoffice)/admin/visual-editor/route-actions.ts";
const VE_ACTIONS = "app/(backoffice)/admin/visual-editor/actions.ts";
const CATEGORY_ACTIONS = "app/(backoffice)/admin/(shell)/categories/actions.ts";
const BRIDGE = "0123456789abcdef0123456789abcdef";

let database = "";
let sql: Sql;
let server: Server;
let owner: TestSession;
let actor: TestSession;
let editorRoleId = 0;

type Category = { id: number; slug: string; title_en: string; title_ar: string; is_published: boolean };
let categories: Category[] = [];
/** A category with groups and services, chosen from the data rather than by name. */
let subject: Category;
let other: Category;

type Answer = { ok: boolean; reason?: string; message?: string; [key: string]: unknown };

/* -------------------------------------------------------------------------- */

const actionOf = async <T>(file: string, route: string, action: string, args: unknown[], session: TestSession) =>
  (await callAction<T>({ origin: server.origin, route, file, action, args, cookie: session.cookie })).value;

const routeAction = <T>(action: string, args: unknown[], session = owner) =>
  actionOf<T>(ROUTE_ACTIONS, "/admin/visual-editor", action, args, session);

const formOf = (fields: Record<string, string | number>, session: TestSession, csrf: string | null = session.csrfToken) => {
  const data = new FormData();
  if (csrf !== null) data.set("_csrf", csrf);
  for (const [key, value] of Object.entries(fields)) data.set(key, String(value));
  return data;
};

const keyOf = (owner: RouteOwner) => editorKeyOf(owner);
const pageOf = (category: Category) => documentEditorKey({ kind: "category", id: category.id });

async function load(target: RouteOwner, category: Category, session = owner) {
  const answer = await routeAction<VisualSectionLoad>("loadRouteRegion", [keyOf(target), pageOf(category)], session);
  assert.ok(answer, "the load answered with nothing");
  return answer;
}

async function region(target: RouteOwner, category = subject) {
  const answer = await load(target, category);
  assert.ok(answer.ok, `load ${target.type}:${target.id}: ${!answer.ok ? answer.message : ""}`);
  return answer.section;
}

const save = (
  action: "saveRouteRegionDraft" | "saveRouteRegionStyles" | "saveRouteRegionMotion",
  target: RouteOwner,
  revision: number,
  field: string,
  payload: unknown,
  session = owner,
  category = subject,
  csrf?: string | null,
) =>
  routeAction<VisualContentSaveResult & Answer>(
    action,
    [
      formOf(
        { sectionId: keyOf(target), pageId: pageOf(category), expectedRevision: revision, [field]: JSON.stringify(payload) },
        session,
        csrf === undefined ? session.csrfToken : csrf,
      ),
    ],
    session,
  );

async function saveValues(target: RouteOwner, change: (values: Record<string, unknown>) => Record<string, unknown>, session = owner) {
  const current = await region(target);
  return save("saveRouteRegionDraft", target, current.revision, "values", change(current.values), session);
}

const summary = async (category = subject, session = owner) => {
  const view = await routeAction<RouteSummaryView | null>("loadRouteSummary", [`category:${category.id}`], session);
  assert.ok(view, "no summary");
  return view;
};

const routeForm = async (action: string, extra: Record<string, string | number> = {}, session = owner, category = subject) => {
  const token = (await summary(category)).token;
  return routeAction<RouteActionResult>(
    action,
    [formOf({ routeKey: `category:${category.id}`, token, ...extra }, session)],
    session,
  );
};

const publish = (session = owner, category = subject) => routeForm("publishRouteFromEditor", {}, session, category);
const discard = (session = owner, category = subject) => routeForm("discardRouteFromEditor", {}, session, category);

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

const READ: PermissionKey[] = ["dashboard.view", "content.view", "visual_editor.view"];

const categoryRow = async (id: number) =>
  (await sql<Record<string, unknown>[]>`select * from service_categories where id = ${id}`)[0]!;
const serviceRows = async (categoryId: number) =>
  sql<{ id: number; subcategory_id: number | null; title_en: string; intro_en: string; sort_order: number; is_published: boolean; image_id: number | null }[]>`
    select id, subcategory_id, title_en, intro_en, sort_order, is_published, image_id from services
     where category_id = ${categoryId} order by sort_order, id`;
const nodeRow = async (ownerKey: string) =>
  (await sql<Record<string, unknown>[]>`select * from route_nodes where owner_key = ${ownerKey}`)[0] ?? null;
const counts = async () =>
  (
    await sql<Record<string, number>[]>`
      select (select count(*)::int from service_categories) as categories,
             (select count(*)::int from service_subcategories) as groups,
             (select count(*)::int from services) as services,
             (select count(*)::int from faqs) as faqs,
             (select count(*)::int from pages) as pages,
             (select count(*)::int from page_sections) as sections`
  )[0]!;

/** Back to a clean slate between cases: no drafts, no presentation, no versions. */
async function resetRoutes() {
  await sql`delete from route_nodes`;
  await sql`delete from route_versions`;
}

const html = async (path: string, session?: TestSession) => (await get(server.origin, path, session ? { cookie: session.cookie } : {})).html;
const publicPage = (category = subject, lang = "") => html(`${lang}/services/${category.slug}`);
const previewPage = (category = subject, lang = "") => html(`${lang}/services/${category.slug}?preview=1`, owner);
const editorPage = (category = subject, lang = "") =>
  html(`${lang}/services/${category.slug}?preview=1&editor=1&bridge=${BRIDGE}`, owner);
const addresses = (markup: string) => [...markup.matchAll(/data-eod-address="([^"]+)"/g)].map((m) => m[1]!);

/* -------------------------------------------------------------------------- */

before(async () => {
  assert.ok(isBuilt(), BUILD_HINT);
  database = giveFresh("route_editor");
  sql = connect(database);
  owner = await signIn(sql);
  const [role] = await sql<{ id: number }[]>`select id from roles where key = 'editor'`;
  editorRoleId = role!.id;
  await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    select 'route-actor@test.invalid', 'Route Actor', 'unused', id, true from roles where key = 'editor'`;
  actor = await signIn(sql, "editor");

  categories = await sql<Category[]>`select id, slug, title_en, title_ar, is_published from service_categories order by sort_order, id`;
  // A category that has groups with more than one card, chosen by its data.
  const [rich] = await sql<{ category_id: number }[]>`
    select s.category_id from services s join service_subcategories g on g.id = s.subcategory_id
     where s.is_published and g.is_published
     group by s.category_id, s.subcategory_id having count(*) >= 2 order by s.category_id limit 1`;
  subject = categories.find((row) => row.id === rich!.category_id)!;
  other = categories.find((row) => row.id !== subject.id)!;

  // The seed has no category questions; give the subject two.
  await sql`
    insert into faqs (scope, category_id, question_en, answer_en, sort_order, is_published)
    values ('category', ${subject.id}, 'How long does it take?', '<p>About a week.</p>', 1, true),
           ('category', ${subject.id}, 'What do I need?', '<p>Your passport.</p>', 2, true)`;

  server = await startServer(database, PORT);
});

after(async () => {
  await server?.stop();
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
});

/* ========================================================================== */

describe("discovery: every category, from the database", () => {
  test("the editor lists Pages and Service Categories, named by their rows", async () => {
    const page = await html("/admin/visual-editor", owner);
    assert.match(page, /<optgroup label="Pages"/);
    assert.match(page, /<optgroup label="Service Categories"/);
    for (const category of categories) {
      assert.ok(page.includes(`value="category:${category.id}"`), `category ${category.slug} is offered`);
    }
  });

  test("a category created later is offered with no code", async () => {
    const [created] = await sql<{ id: number }[]>`
      insert into service_categories (slug, title_en, summary_en, is_published, sort_order)
      values ('created-after-release', 'Created After Release', 'New.', true, 99) returning id`;
    const page = await html("/admin/visual-editor", owner);
    assert.ok(page.includes(`value="category:${created!.id}"`));
    assert.match(page, /Created After Release/);
    // And it opens: its canvas route is its own public address, with editor marks.
    const canvas = await html(`/services/created-after-release?preview=1&editor=1&bridge=${BRIDGE}`, owner);
    assert.ok(addresses(canvas).includes(`category:${created!.id}`));
    await sql`delete from service_categories where id = ${created!.id}`;
  });

  test("?route=category:<id> opens that category, and a route that names nothing opens a page", async () => {
    const initialOf = (markup: string) => /\\"initial\\":\{\\"slug\\":\\"([^\\]+)\\"/.exec(markup)?.[1];
    assert.equal(initialOf(await html(`/admin/visual-editor?route=category:${subject.id}`, owner)), `category:${subject.id}`);
    assert.equal(initialOf(await html(`/admin/visual-editor?route=category:${subject.id}&lang=ar`, owner)), `category:${subject.id}`);
    // A key that is not a category, or not a key at all, is never an iframe source.
    for (const bad of ["category:999999", "category:../admin", "javascript:x"]) {
      const opened = initialOf(await html(`/admin/visual-editor?route=${encodeURIComponent(bad)}`, owner));
      assert.ok(opened && !opened.startsWith("category:"), `${bad} opened ${opened}`);
    }
  });
});

describe("the real page in the canvas, and nothing of the editor anywhere else", () => {
  test("the public page carries no editor attribute, bridge, draft or region identity", async () => {
    const page = await publicPage();
    assert.equal(page.includes("data-eod-"), false);
    assert.equal(page.includes("bridgeId"), false);
    assert.equal(page.includes("route_nodes"), false);
  });

  test("the parameters alone grant nothing", async () => {
    const page = await html(`/services/${subject.slug}?preview=1&editor=1&bridge=${BRIDGE}`);
    assert.equal(page.includes("data-eod-"), false);
    assert.equal(page.includes("bridgeId"), false);
    // A comparison asked for by a visitor is the live page, not a still version of it.
    const compared = await html(`/services/${subject.slug}?compare=published`);
    assert.equal(compared.includes("data-eod-"), false);
  });

  test("a preview, a canvas or a comparison is private and never indexed — whoever asks", async () => {
    const headers = async (path: string, cookie?: string) => {
      const response = await fetch(`${server.origin}${path}`, { headers: cookie ? { cookie } : {}, redirect: "manual" });
      await response.arrayBuffer();
      return { robots: response.headers.get("x-robots-tag"), cache: response.headers.get("cache-control") };
    };
    for (const cookie of [owner.cookie, undefined]) {
      for (const path of [
        `/services/${subject.slug}?preview=1`,
        `/services/${subject.slug}?preview=1&editor=1&bridge=${BRIDGE}`,
        `/ar/services/${subject.slug}?compare=published`,
      ]) {
        const answered = await headers(path, cookie);
        assert.equal(answered.robots, "noindex, nofollow, noarchive", path);
        assert.equal(answered.cache, "private, no-store, max-age=0", path);
      }
    }
    // An ordinary visit keeps its ordinary headers.
    assert.equal((await headers(`/services/${subject.slug}`)).robots, null);
  });

  test("an authorised canvas marks every region by its record", async () => {
    const page = await editorPage();
    const marked = addresses(page);
    assert.ok(marked.includes(`category:${subject.id}`));
    assert.ok(marked.includes(`category:${subject.id}/field:title`));
    assert.ok(marked.includes(`categoryCrumbs:${subject.id}`));
    assert.ok(marked.includes(`categoryServices:${subject.id}/field:heading`));
    const services = await serviceRows(subject.id);
    const shown = services.find((row) => row.is_published)!;
    assert.ok(marked.includes(`service:${shown.id}/field:title`));
    assert.ok(marked.some((address) => address.startsWith("subcategory:")));
    assert.ok(marked.some((address) => address.startsWith("faq:")));
    assert.ok(page.includes("bridgeId"));
  });

  test("the Arabic canvas is the real /ar route, RTL, with the same addresses", async () => {
    const english = addresses(await editorPage());
    const arabic = await editorPage(subject, "/ar");
    assert.match(arabic, /<html[^>]*lang="ar"[^>]*dir="rtl"|<html[^>]*dir="rtl"[^>]*lang="ar"/);
    assert.deepEqual(addresses(arabic).sort(), english.sort());
  });

  test("a plain preview shows the preview banner and no editor marks", async () => {
    const page = await previewPage();
    assert.equal(page.includes("data-eod-"), false);
    assert.match(page, /Preview/);
  });
});

describe("drafts never touch live content", () => {
  before(resetRoutes);

  test("a title draft is stored as a patch with its starting point, and the live row is untouched", async () => {
    const before = await categoryRow(subject.id);
    const saved = await saveValues({ type: "category", id: subject.id }, (values) => ({
      ...values,
      title: { ...(values.title as object), en: "Draft Title For Test" },
    }));
    assert.ok(saved?.ok, saved?.message);
    const after = await categoryRow(subject.id);
    assert.equal(after.title_en, before.title_en);
    const node = await nodeRow(`category:${subject.id}`);
    assert.deepEqual(node!.draft_content, { titleEn: { value: "Draft Title For Test", base: before.title_en } });
    assert.equal(node!.route_key, `category:${subject.id}`);
  });

  test("the public page keeps the live title; the preview and the canvas show the draft", async () => {
    assert.equal((await publicPage()).includes("Draft Title For Test"), false);
    assert.ok((await previewPage()).includes("Draft Title For Test"));
    assert.ok((await editorPage()).includes("Draft Title For Test"));
  });

  test("Arabic stays its own field: an Arabic edit leaves English alone and is not seeded from it", async () => {
    const hero = await region({ type: "category", id: subject.id });
    assert.equal((hero.values.title as { ar: string }).ar, subject.title_ar);
    const saved = await save("saveRouteRegionDraft", { type: "category", id: subject.id }, hero.revision, "values", {
      ...hero.values,
      title: { en: "Draft Title For Test", ar: "عنوان تجريبي" },
    });
    assert.ok(saved?.ok);
    const node = await nodeRow(`category:${subject.id}`);
    assert.equal((node!.draft_content as Record<string, { value: string }>).titleAr.value, "عنوان تجريبي");
    assert.ok((await previewPage(subject, "/ar")).includes("عنوان تجريبي"));
  });

  test("a service card's introduction, a group's title and a question are drafts of their own records", async () => {
    const services = await serviceRows(subject.id);
    const card = services.find((row) => row.is_published && row.subcategory_id !== null)!;
    const intro = await saveValues({ type: "service", id: card.id }, (values) => ({
      ...values,
      intro: { ...(values.intro as object), en: "A draft introduction." },
    }));
    assert.ok(intro?.ok, intro?.message);
    const group = await saveValues({ type: "subcategory", id: card.subcategory_id! }, (values) => ({
      ...values,
      title: { ...(values.title as object), en: "Draft Group" },
    }));
    assert.ok(group?.ok, group?.message);
    const [question] = await sql<{ id: number }[]>`select id from faqs where category_id = ${subject.id} order by sort_order limit 1`;
    const faq = await saveValues({ type: "faq", id: question!.id }, (values) => ({
      ...values,
      question: { ...(values.question as object), en: "A draft question?" },
    }));
    assert.ok(faq?.ok, faq?.message);
    const rows = await serviceRows(subject.id);
    assert.equal(rows.find((row) => row.id === card.id)!.intro_en, card.intro_en);
    const preview = await previewPage();
    assert.ok(preview.includes("A draft introduction."));
    assert.ok(preview.includes("Draft Group"));
    assert.ok(preview.includes("A draft question?"));
    const live = await publicPage();
    assert.equal(live.includes("A draft introduction."), false);
    assert.equal(live.includes("A draft question?"), false);
  });

  test("a picture is chosen from the library, and removed again; an id that is not there is refused", async () => {
    const services = await serviceRows(subject.id);
    const card = services[0]!;
    const [picture] = await sql<{ id: number }[]>`
      select id from media where id is distinct from ${card.image_id} order by id limit 1`;
    assert.ok(picture, "the fixture's library holds a picture");
    const target: RouteOwner = { type: "service", id: card.id };
    const imageDraft = async () =>
      ((await nodeRow(`service:${card.id}`))?.draft_content as Record<string, { value: unknown }> | null)?.imageId;
    const missing = await saveValues(target, (values) => ({ ...values, image: 987654 }));
    assert.equal(missing?.ok, false);
    assert.match(String(missing?.message), /media library/);
    const chosen = await saveValues(target, (values) => ({ ...values, image: picture.id }));
    assert.ok(chosen?.ok, chosen?.message);
    assert.equal((await imageDraft())?.value, picture.id);
    // Remove: back to no picture — a draft of null, or no draft at all when live has none.
    const removed = await saveValues(target, (values) => ({ ...values, image: null }));
    assert.ok(removed?.ok, removed?.message);
    if (card.image_id === null) assert.equal(await imageDraft(), undefined);
    else assert.equal((await imageDraft())?.value, null);
    // The live row never moved.
    assert.equal((await serviceRows(subject.id)).find((row) => row.id === card.id)!.image_id, card.image_id);
  });

  test("generated content is not stored, whatever is sent", async () => {
    const hero = await region({ type: "category", id: subject.id });
    assert.equal("whatsapp" in hero.values, false);
    const saved = await save("saveRouteRegionDraft", { type: "category", id: subject.id }, hero.revision, "values", {
      ...hero.values,
      whatsapp: "https://evil.example",
      trail: "x",
    });
    assert.ok(saved?.ok);
    const node = await nodeRow(`category:${subject.id}`);
    assert.equal(JSON.stringify(node!.draft_content).includes("evil"), false);
  });

  test("a stale revision is a conflict, answered with the version that won", async () => {
    const hero = await region({ type: "category", id: subject.id });
    const first = await save("saveRouteRegionDraft", { type: "category", id: subject.id }, hero.revision, "values", {
      ...hero.values,
      summary: { ...(hero.values.summary as object), en: "First writer." },
    });
    assert.ok(first?.ok);
    const second = await save("saveRouteRegionDraft", { type: "category", id: subject.id }, hero.revision, "values", {
      ...hero.values,
      summary: { ...(hero.values.summary as object), en: "Second writer." },
    });
    assert.equal(second?.ok, false);
    assert.equal(second?.reason, "conflict");
    assert.match(JSON.stringify(second), /First writer\./);
  });

  test("a region of another category cannot be written through this one's canvas", async () => {
    const services = await serviceRows(other.id);
    const foreign = services[0]!;
    const answer = await load({ type: "service", id: foreign.id }, subject);
    assert.equal(answer.ok, false);
    const saved = await routeAction<Answer>("saveRouteRegionDraft", [
      formOf(
        { sectionId: keyOf({ type: "service", id: foreign.id }), pageId: pageOf(subject), expectedRevision: 0, values: "{}" },
        owner,
      ),
    ]);
    assert.equal(saved?.ok, false);
  });

  test("styles and motion are drafts too, in the closed vocabulary", async () => {
    const services = await serviceRows(subject.id);
    const card = { type: "service" as const, id: services[0]!.id };
    const current = await region(card);
    const styled = await save("saveRouteRegionStyles", card, current.revision, "styles", {
      v: STYLE_DOCUMENT_VERSION,
      nodes: { "field:title": { base: { textColor: "peach" }, mobile: { textColor: "strong" } }, "field:x": { base: { css: "x" } } },
    });
    assert.ok(styled?.ok, styled?.message);
    const after = await region(card);
    const moved = await save("saveRouteRegionMotion", card, after.revision, "motionDocument", {
      v: 1,
      section: { base: { entrance: "fade-up" } },
      nodes: {},
    });
    assert.ok(moved?.ok, moved?.message);
    const node = await nodeRow(`service:${card.id}`);
    assert.ok(node!.draft_styles);
    assert.ok(node!.draft_motion);
    assert.equal(node!.styles, null);
    assert.equal(JSON.stringify(node!.draft_styles).includes("css"), false);
    // The breadcrumbs never move: their motion is cut to nothing.
    const crumbs = await region({ type: "categoryCrumbs", id: subject.id });
    const still = await save("saveRouteRegionMotion", { type: "categoryCrumbs", id: subject.id }, crumbs.revision, "motionDocument", {
      v: 1,
      section: { base: { entrance: "fade-up" } },
      nodes: {},
    });
    assert.ok(still?.ok);
    assert.deepEqual((still as unknown as { motionDocument: { section: object } }).motionDocument.section, {});
  });

  test("drafts survive a restart: they are rows, read again by a fresh server", async () => {
    await server.stop();
    server = await startServer(database, PORT);
    assert.ok((await previewPage()).includes("Draft Title For Test"));
  });
});

describe("publish is atomic, guarded and audited", () => {
  test("publishing writes the patched columns, clears the drafts and records the version", async () => {
    const before = await counts();
    // Elements in the markup that carry an entrance — the attribute, not the page's serialized payload.
    const reveals = (html: string) => html.match(/\sdata-m-reveal=""/g)?.length ?? 0;
    const revealsBefore = reveals(await publicPage());
    const view = await summary();
    assert.ok(view.publishable, JSON.stringify(view));
    assert.ok(view.owners.length >= 3);
    const answer = await publish();
    assert.ok(answer?.ok, answer?.ok ? "" : answer?.message);
    const row = await categoryRow(subject.id);
    assert.equal(row.title_en, "Draft Title For Test");
    assert.equal(row.title_ar, "عنوان تجريبي");
    assert.equal(row.summary_en, "First writer.");
    const node = await nodeRow(`category:${subject.id}`);
    assert.equal(node!.draft_content, null);
    const versions = await sql<{ kind: string }[]>`select kind from route_versions where route_key = ${`category:${subject.id}`} order by id`;
    assert.deepEqual(versions.map((version) => version.kind), ["baseline", "publish"]);
    const [logged] = await sql<{ n: number }[]>`select count(*)::int as n from activity_logs where action = 'route.published'`;
    assert.ok(logged!.n >= 1);
    // The live page now shows it, and nothing was duplicated anywhere.
    assert.ok((await publicPage()).includes("Draft Title For Test"));
    assert.deepEqual(await counts(), before);
    // Published styles reach visitors; the editor's attributes still do not.
    const live = await publicPage();
    assert.equal(live.includes("data-eod-"), false);
    assert.ok(live.includes("data-rs-m") || live.includes("--rs-"), "the published mobile style is on the page");
    // …and so does the published entrance: one more element reveals than before.
    assert.equal(reveals(live), revealsBefore + 1, "the card's published entrance is on the page");
  });

  test("a field changed in the admin form since its draft began blocks the whole publication", async () => {
    const hero = await region({ type: "category", id: subject.id });
    const services = await serviceRows(subject.id);
    const card = services[0]!;
    assert.ok((await saveValues({ type: "service", id: card.id }, (values) => ({ ...values, intro: { ...(values.intro as object), en: "Should not land." } })))?.ok);
    assert.ok(
      (
        await save("saveRouteRegionDraft", { type: "category", id: subject.id }, hero.revision, "values", {
          ...hero.values,
          tagline: { ...(hero.values.tagline as object), en: "Editor tagline" },
        })
      )?.ok,
    );
    // The Service Categories form saves the same field, live, in the meantime.
    const form = formOf(
      {
        id: subject.id,
        titleEn: "Draft Title For Test",
        titleAr: "عنوان تجريبي",
        taglineEn: "Form tagline",
        summaryEn: "First writer.",
        icon: "plane",
        sortOrder: 0,
        isPublished: "on",
      },
      owner,
    );
    const formAnswer = await actionOf<Answer>(CATEGORY_ACTIONS, `/admin/categories/${subject.id}`, "updateCategory", [{ ok: false }, form], owner);
    assert.ok(formAnswer?.ok, formAnswer?.message);

    const blocked = await publish();
    assert.equal(blocked?.ok, false);
    assert.equal(blocked && !blocked.ok ? blocked.reason : "", "conflict");
    // Nothing of the publication was written — not even the card, which had no conflict.
    assert.equal((await serviceRows(subject.id)).find((row) => row.id === card.id)!.intro_en, card.intro_en);
    assert.equal((await categoryRow(subject.id)).tagline_en, "Form tagline");

    // The editor sees the conflict, and settles it explicitly.
    const after = await region({ type: "category", id: subject.id });
    assert.deepEqual(after.route?.conflicts.map((conflict) => conflict.key), ["taglineEn"]);
    const kept = await routeAction<VisualContentSaveResult>("resolveRouteConflict", [
      formOf({ sectionId: keyOf({ type: "category", id: subject.id }), pageId: pageOf(subject), expectedRevision: after.revision, field: "taglineEn", choice: "mine" }, owner),
    ]);
    assert.ok(kept?.ok);
    const done = await publish();
    assert.ok(done?.ok, done && !done.ok ? done.message : "");
    assert.equal((await categoryRow(subject.id)).tagline_en, "Editor tagline");
    assert.equal((await serviceRows(subject.id)).find((row) => row.id === card.id)!.intro_en, "Should not land.");
  });

  test("taking the live value drops that field from the draft", async () => {
    const hero = await region({ type: "category", id: subject.id });
    assert.ok(
      (await save("saveRouteRegionDraft", { type: "category", id: subject.id }, hero.revision, "values", { ...hero.values, tagline: { en: "Mine again", ar: "" } }))?.ok,
    );
    await sql`update service_categories set tagline_en = 'Theirs again' where id = ${subject.id}`;
    const now = await region({ type: "category", id: subject.id });
    const taken = await routeAction<VisualContentSaveResult>("resolveRouteConflict", [
      formOf({ sectionId: keyOf({ type: "category", id: subject.id }), pageId: pageOf(subject), expectedRevision: now.revision, field: "taglineEn", choice: "live" }, owner),
    ]);
    assert.ok(taken?.ok);
    assert.equal((await nodeRow(`category:${subject.id}`))!.draft_content, null);
    assert.equal((await summary()).publishable, false);
  });

  test("drafts that changed after review are not published unseen", async () => {
    const hero = await region({ type: "category", id: subject.id });
    assert.ok((await save("saveRouteRegionDraft", { type: "category", id: subject.id }, hero.revision, "values", { ...hero.values, tagline: { en: "Reviewed", ar: "" } }))?.ok);
    const stale = (await summary()).token;
    const again = await region({ type: "category", id: subject.id });
    assert.ok((await save("saveRouteRegionDraft", { type: "category", id: subject.id }, again.revision, "values", { ...again.values, tagline: { en: "Changed after review", ar: "" } }))?.ok);
    const refused = await routeAction<RouteActionResult>("publishRouteFromEditor", [formOf({ routeKey: `category:${subject.id}`, token: stale }, owner)]);
    assert.equal(refused?.ok, false);
    assert.equal(refused && !refused.ok ? refused.reason : "", "stale");
    assert.equal((await categoryRow(subject.id)).tagline_en, "Theirs again");
  });

  test("discard removes the drafts and only the drafts", async () => {
    const before = await categoryRow(subject.id);
    const answer = await discard();
    assert.ok(answer?.ok);
    const node = await nodeRow(`category:${subject.id}`);
    assert.equal(node!.draft_content, null);
    assert.deepEqual(await categoryRow(subject.id), before);
    assert.equal((await previewPage()).includes("Changed after review"), false);
  });
});

describe("order and visibility are drafts of the records", () => {
  test("reordering a group's services and hiding one publish together", async () => {
    const services = await serviceRows(subject.id);
    const groupId = services.find((row) => row.subcategory_id !== null)!.subcategory_id!;
    const members = services.filter((row) => row.subcategory_id === groupId);
    const reversed = [...members].reverse().map((row) => row.id);
    const reorder = await saveValues({ type: "subcategory", id: groupId }, (values) => ({
      ...values,
      _order: { services: reversed },
    }));
    assert.ok(reorder?.ok, reorder?.message);
    const hidden = members[0]!;
    const hide = await saveValues({ type: "service", id: hidden.id }, (values) => ({ ...values, published: false }));
    assert.ok(hide?.ok, hide?.message);
    assert.ok((await publish())?.ok);
    const after = await serviceRows(subject.id);
    const order = after.filter((row) => row.subcategory_id === groupId).map((row) => row.id);
    assert.deepEqual(order, reversed);
    assert.equal(after.find((row) => row.id === hidden.id)!.is_published, false);
    const live = await publicPage();
    assert.equal(live.includes(`/services/${subject.slug}/`) , true);
    // Put the card back for the cases after this one.
    await sql`update services set is_published = true where id = ${hidden.id}`;
  });
});

describe("history, compare and restore", () => {
  test("each publication is listed with its actor, and compares field by field", async () => {
    const history = await routeAction<RouteHistoryView | null>("loadRouteHistory", [`category:${subject.id}`]);
    assert.ok(history && history.versions.length >= 3);
    const baseline = history.versions.find((version) => version.kind === "baseline")!;
    const latest = history.versions.find((version) => version.kind === "publish")!;
    assert.ok(latest.actorName);
    const changed = await routeAction<RouteCompareView | null>("loadRouteCompare", [`category:${subject.id}`, latest.id, "previous"]);
    assert.ok(changed && changed.changes.length > 0);
    const versusLive = await routeAction<RouteCompareView | null>("loadRouteCompare", [`category:${subject.id}`, baseline.id, "live"]);
    assert.ok(versusLive?.changes.some((change) => change.field === "Title (English)"));
  });

  test("restoring builds a draft, never touches live, and refuses while drafts are pending", async () => {
    const history = (await routeAction<RouteHistoryView | null>("loadRouteHistory", [`category:${subject.id}`]))!;
    const baseline = history.versions.find((version) => version.kind === "baseline")!;
    const live = await categoryRow(subject.id);
    const restored = await routeForm("restoreRouteFromEditor", { versionId: baseline.id });
    assert.ok(restored?.ok, restored && !restored.ok ? restored.message : "");
    assert.deepEqual(await categoryRow(subject.id), live);
    const draft = (await nodeRow(`category:${subject.id}`))!.draft_content as Record<string, { value: unknown }>;
    assert.equal(draft.titleEn!.value, subject.title_en);
    const blocked = await routeForm("restoreRouteFromEditor", { versionId: baseline.id });
    assert.equal(blocked?.ok, false);
    assert.equal(blocked && !blocked.ok ? blocked.reason : "", "blocked");
    assert.ok((await discard())?.ok);
  });
});

describe("authority: every action asks again", () => {
  test("without services.manage, content is refused — and styling is still allowed", async () => {
    const session = await as([...READ, "content.edit", "content.style"]);
    const target: RouteOwner = { type: "category", id: subject.id };
    const current = await region(target);
    const words = await save("saveRouteRegionDraft", target, current.revision, "values", { ...current.values, tagline: { en: "No", ar: "" } }, session);
    assert.equal(words?.ok, false);
    assert.match(String(words?.message), /services/);
    const styled = await save("saveRouteRegionStyles", target, current.revision, "styles", { v: STYLE_DOCUMENT_VERSION, nodes: {} }, session);
    assert.ok(styled?.ok, styled?.message);
  });

  test("FAQs need faqs.manage; services.manage is not enough", async () => {
    const session = await as([...READ, "content.edit", "services.manage"]);
    const [question] = await sql<{ id: number }[]>`select id from faqs where category_id = ${subject.id} limit 1`;
    const target: RouteOwner = { type: "faq", id: question!.id };
    const current = await region(target);
    const refused = await save("saveRouteRegionDraft", target, current.revision, "values", { ...current.values, question: { en: "Nope?", ar: "" } }, session);
    assert.equal(refused?.ok, false);
    assert.match(String(refused?.message), /FAQ/);
  });

  test("words need content.edit; order and visibility need content.structure", async () => {
    const services = await serviceRows(subject.id);
    const target: RouteOwner = { type: "service", id: services[1]!.id };
    const noWords = await as([...READ, "content.structure", "services.manage"]);
    let current = await region(target);
    const typed = await save("saveRouteRegionDraft", target, current.revision, "values", { ...current.values, title: { en: "Typed", ar: "" } }, noWords);
    assert.equal(typed?.ok, false);
    const hidden = await save("saveRouteRegionDraft", target, current.revision, "values", { ...current.values, published: false }, noWords);
    assert.ok(hidden?.ok, hidden?.message);
    const noLayout = await as([...READ, "content.edit", "services.manage"]);
    current = await region(target);
    const shown = await save("saveRouteRegionDraft", target, current.revision, "values", { ...current.values, published: true }, noLayout);
    assert.equal(shown?.ok, false);
    assert.ok((await discard())?.ok);
  });

  test("publishing needs content.publish, and the records' own capability for content", async () => {
    const services = await serviceRows(subject.id);
    assert.ok((await saveValues({ type: "service", id: services[0]!.id }, (values) => ({ ...values, intro: { en: "Pending.", ar: "" } })))?.ok);
    const noPublish = await as([...READ, "content.edit", "services.manage"]);
    const refused = await publish(noPublish);
    assert.equal(refused?.ok, false);
    const noDomain = await as([...READ, "content.publish"]);
    const alsoRefused = await publish(noDomain);
    assert.equal(alsoRefused?.ok, false);
    assert.match(alsoRefused && !alsoRefused.ok ? alsoRefused.message : "", /services/);
    assert.ok((await discard())?.ok);
  });

  test("a form without the session's token is refused before anything is read", async () => {
    const target: RouteOwner = { type: "category", id: subject.id };
    const current = await region(target);
    const forged = await save("saveRouteRegionDraft", target, current.revision, "values", current.values, owner, subject, "not-the-token");
    assert.equal(forged?.ok, false);
    assert.match(String(forged?.message), /expired/);
    const missing = await save("saveRouteRegionDraft", target, current.revision, "values", current.values, owner, subject, null);
    assert.equal(missing?.ok, false);
    assert.equal(await nodeRow(`category:${subject.id}`).then((row) => row?.draft_content ?? null), null);
  });

  test("signed out, every read and write answers with nothing", async () => {
    const anonymous = { cookie: "", csrfToken: "x", userId: 0 };
    const answer = await routeAction<VisualSectionLoad>("loadRouteRegion", [keyOf({ type: "category", id: subject.id }), pageOf(subject)], anonymous);
    assert.equal(answer?.ok, false);
    assert.equal(await routeAction("loadRouteSummary", [`category:${subject.id}`], anonymous), null);
  });
});

describe("the Tour Packages panel: template copy, stored once, per language", () => {
  test("its words are drafts of the route until published, and its destinations stay the packages' own", async () => {
    await resetRoutes();
    const hubCategory = categories.find((row) => hasPackageHub(row));
    assert.ok(hubCategory, "the seed has the category the route gives the panel to");
    const hub: RouteOwner = { type: "categoryHub", id: hubCategory.id };
    const packages = async () =>
      (await sql<{ destinations: number; packages: number }[]>`
        select (select count(*)::int from package_destinations) as destinations,
               (select count(*)::int from travel_packages) as packages`)[0]!;
    const before = await packages();

    const current = await region(hub, hubCategory);
    // The destinations are drawn from the packages, never stored as the panel's values.
    assert.equal("destinations" in current.values, false);
    const saved = await save(
      "saveRouteRegionDraft",
      hub,
      current.revision,
      "values",
      { ...current.values, heading: { en: "Pick a destination, test", ar: "" } },
      owner,
      hubCategory,
    );
    assert.ok(saved?.ok, saved?.message);

    // Live keeps the standard words; the preview shows the draft — and the Arabic
    // edition, whose heading was left empty, keeps the standard Arabic, not the English.
    assert.ok((await publicPage(hubCategory)).includes("Choose your destination"));
    assert.ok((await previewPage(hubCategory)).includes("Pick a destination, test"));
    const arabic = await previewPage(hubCategory, "/ar");
    assert.ok(arabic.includes("اختر وجهتك"));
    assert.equal(arabic.includes("Pick a destination, test"), false);

    const published = await publish(owner, hubCategory);
    assert.ok(published?.ok, published && !published.ok ? published.message : "");
    const live = await publicPage(hubCategory);
    assert.ok(live.includes("Pick a destination, test"));
    assert.equal(live.includes("Choose your destination"), false);
    assert.ok((await publicPage(hubCategory, "/ar")).includes("اختر وجهتك"));
    const [node] = await sql<{ copy: Record<string, string> | null; draft_content: unknown }[]>`
      select copy, draft_content from route_nodes where owner_key = ${`categoryHub:${hubCategory.id}`}`;
    assert.equal(node!.copy?.headingEn, "Pick a destination, test");
    assert.equal(node!.draft_content, null);
    assert.deepEqual(await packages(), before);
  });

  test("a category the route gives no panel has no panel to edit", async () => {
    const plain = categories.find((row) => !hasPackageHub(row))!;
    const answer = await load({ type: "categoryHub", id: plain.id }, plain);
    assert.equal(answer.ok, false);
    assert.equal(addresses(await editorPage(plain)).some((address) => address.startsWith("categoryHub:")), false);
  });
});

describe("the rest of the admin keeps working", () => {
  test("the page editor still saves a page section draft", async () => {
    const [section] = await sql<{ id: number; page_id: number; revision: number }[]>`
      select s.id, s.page_id, s.revision from page_sections s join pages p on p.id = s.page_id
       where p.slug = 'about' and s.block_type = 'page-hero' limit 1`;
    assert.ok(section);
    const load = await actionOf<VisualSectionLoad>(VE_ACTIONS, "/admin/visual-editor", "loadVisualSection", [section.id, section.page_id], owner);
    assert.ok(load?.ok);
    const values = { ...load.section.values, title: { en: "About, still editable", ar: "" } };
    const saved = await actionOf<Answer>(
      VE_ACTIONS,
      "/admin/visual-editor",
      "saveVisualSectionDraft",
      [formOf({ sectionId: section.id, pageId: section.page_id, expectedRevision: section.revision, values: JSON.stringify(values) }, owner)],
      owner,
    );
    assert.ok(saved?.ok, saved?.message);
  });

  test("the Service Categories form takes a call-to-action link, and refuses an unsafe one", async () => {
    const base = {
      id: other.id,
      titleEn: other.title_en,
      titleAr: other.title_ar,
      icon: "plane",
      sortOrder: 0,
      isPublished: "on",
    };
    const ok = await actionOf<Answer>(CATEGORY_ACTIONS, `/admin/categories/${other.id}`, "updateCategory", [{ ok: false }, formOf({ ...base, ctaHref: "/packages" }, owner)], owner);
    assert.ok(ok?.ok, ok?.message);
    assert.equal((await categoryRow(other.id)).cta_href, "/packages");
    const live = await publicPage(other);
    assert.match(live, /href="\/packages"[^>]*class="btn btn-primary"|class="btn btn-primary"[^>]*href="\/packages"/);
    // A site path is a link within the edition it is shown in.
    const arabic = await publicPage(other, "/ar");
    assert.match(arabic, /href="\/ar\/packages"[^>]*class="btn btn-primary"|class="btn btn-primary"[^>]*href="\/ar\/packages"/);
    const bad = await actionOf<Answer>(CATEGORY_ACTIONS, `/admin/categories/${other.id}`, "updateCategory", [{ ok: false }, formOf({ ...base, ctaHref: "javascript:alert(1)" }, owner)], owner);
    assert.equal(bad?.ok, false);
    assert.equal((await categoryRow(other.id)).cta_href, "/packages");
  });
});
