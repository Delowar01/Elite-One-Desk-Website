/**
 * Batch 22: a service's own page in the Visual Editor, against a real server
 * and a real database.
 *
 * What these hold, in the brief's words: every service discovered from the
 * database (one created after the build included, with no code), the real
 * route in the canvas in both editions, drafts that never touch the live
 * service, an atomic publication that refuses on any conflict and writes only
 * what was changed, discard, optimistic concurrency, history with compare and
 * restore-to-draft, a move to another category and a rename through the
 * Services screen with the identity unchanged, a deleted service, permissions
 * and CSRF on every action, the media guard, no draft in the public page, its
 * metadata or its structured data, and the rest of the admin still working.
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
import type { RouteActionResult, RouteCompareView, RouteHistoryView, RouteSummaryView } from "@/lib/routes/views";
import type { VisualContentSaveResult, VisualSectionLoad } from "@/lib/visual-editor/content";

const PORT = 3508;
const ROUTE_ACTIONS = "app/(backoffice)/admin/visual-editor/route-actions.ts";
const SERVICE_ACTIONS = "app/(backoffice)/admin/(shell)/services/actions.ts";
const MEDIA_ACTIONS = "app/(backoffice)/admin/(shell)/media/actions.ts";
const COMPONENT_ACTIONS = "app/(backoffice)/admin/(shell)/components/actions.ts";
const BRIDGE = "0123456789abcdef0123456789abcdef";

let database = "";
let sql: Sql;
let server: Server;
let owner: TestSession;
let actor: TestSession;
let editorRoleId = 0;
/** What servers this suite has already stopped wrote, for the last check. */
const earlierLogs: string[] = [];

type Service = { id: number; slug: string; title_en: string; title_ar: string; category_id: number; category_slug: string };
/** Services from three different categories, chosen from the data rather than by name. */
let subject: Service;
let second: Service;
let third: Service;

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

const keyOf = (target: RouteOwner) => editorKeyOf(target);
const pageOf = (service: { id: number }) => documentEditorKey({ kind: "service", id: service.id });
const routeKey = (service: { id: number }) => `service:${service.id}`;
const at = (type: RouteOwner["type"], service: { id: number } = subject): RouteOwner => ({ type, id: service.id });

async function load(target: RouteOwner, service: { id: number } = subject, session = owner) {
  const answer = await routeAction<VisualSectionLoad>("loadRouteRegion", [keyOf(target), pageOf(service)], session);
  assert.ok(answer, "the load answered with nothing");
  return answer;
}

async function region(target: RouteOwner, service: { id: number } = subject) {
  const answer = await load(target, service);
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
  service: { id: number } = subject,
  csrf?: string | null,
) =>
  routeAction<VisualContentSaveResult & Answer>(
    action,
    [
      formOf(
        { sectionId: keyOf(target), pageId: pageOf(service), expectedRevision: revision, [field]: JSON.stringify(payload) },
        session,
        csrf === undefined ? session.csrfToken : csrf,
      ),
    ],
    session,
  );

async function saveValues(
  target: RouteOwner,
  change: (values: Record<string, unknown>) => Record<string, unknown>,
  session = owner,
  service: { id: number } = subject,
) {
  const current = await region(target, service);
  return save("saveRouteRegionDraft", target, current.revision, "values", change(current.values), session, service);
}

const summary = async (service: { id: number } = subject, session = owner) => {
  const view = await routeAction<RouteSummaryView | null>("loadRouteSummary", [routeKey(service)], session);
  assert.ok(view, "no summary");
  return view;
};

const routeForm = async (action: string, extra: Record<string, string | number> = {}, session = owner, service: { id: number } = subject) => {
  const token = (await summary(service)).token;
  return routeAction<RouteActionResult>(action, [formOf({ routeKey: routeKey(service), token, ...extra }, session)], session);
};

const publish = (session = owner, service: { id: number } = subject) => routeForm("publishRouteFromEditor", {}, session, service);
const discard = (session = owner, service: { id: number } = subject) => routeForm("discardRouteFromEditor", {}, session, service);

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

const serviceRow = async (id: number) => (await sql<Record<string, unknown>[]>`select * from services where id = ${id}`)[0];
const nodeRow = async (ownerKey: string) =>
  (await sql<Record<string, unknown>[]>`select * from route_nodes where owner_key = ${ownerKey}`)[0] ?? null;
const nodesOf = async (serviceId: number) =>
  (await sql<{ owner_key: string; route_key: string }[]>`
    select owner_key, route_key from route_nodes
     where owner_key ~ ${`^service[A-Z][A-Za-z]*:${serviceId}$`} order by owner_key`).map((row) => ({ ...row }));
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
const addressOf = async (id: number) => {
  const [row] = await sql<{ path: string }[]>`
    select '/services/' || c.slug || '/' || s.slug as path from services s join service_categories c on c.id = s.category_id where s.id = ${id}`;
  return row!.path;
};

async function resetRoutes() {
  await sql`delete from route_nodes`;
  await sql`delete from route_versions`;
}

const html = async (path: string, session?: TestSession) => (await get(server.origin, path, session ? { cookie: session.cookie } : {})).html;
const statusOf = async (path: string, session?: TestSession) => (await get(server.origin, path, session ? { cookie: session.cookie } : {})).status;
const publicPage = async (service: { id: number } = subject, lang = "") => html(`${lang}${await addressOf(service.id)}`);
const previewPage = async (service: { id: number } = subject, lang = "") => html(`${lang}${await addressOf(service.id)}?preview=1`, owner);
const editorPage = async (service: { id: number } = subject, lang = "") =>
  html(`${lang}${await addressOf(service.id)}?preview=1&editor=1&bridge=${BRIDGE}`, owner);
const addresses = (markup: string) => [...markup.matchAll(/data-eod-address="([^"]+)"/g)].map((m) => m[1]!);
/** The page's structured data, parsed. */
const jsonLd = (markup: string): Record<string, unknown>[] =>
  [...markup.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].flatMap((m) => {
    const parsed = JSON.parse(m[1]!) as unknown;
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [parsed as Record<string, unknown>];
  });
const ofType = (markup: string, type: string) => jsonLd(markup).find((entry) => entry["@type"] === type);
const titleOf = (markup: string) => /<title>([^<]*)<\/title>/.exec(markup)?.[1] ?? "";

/** The Services screen's own update, carrying every field the form holds — as the form does. */
async function servicesForm(id: number, over: Record<string, string | number> = {}, session = owner) {
  const row = (await serviceRow(id))!;
  const fields: Record<string, string | number> = {
    id,
    slug: String(row.slug),
    categoryId: Number(row.category_id),
    subcategoryId: row.subcategory_id === null ? "" : Number(row.subcategory_id),
    titleEn: String(row.title_en),
    titleAr: String(row.title_ar),
    introEn: String(row.intro_en),
    introAr: String(row.intro_ar),
    bodyEn: String(row.body_en),
    bodyAr: String(row.body_ar),
    benefits: JSON.stringify(row.benefits),
    audience: JSON.stringify(row.audience),
    requirements: JSON.stringify(row.requirements),
    processSteps: JSON.stringify(row.process_steps),
    timelineEn: String(row.timeline_en),
    timelineAr: String(row.timeline_ar),
    notesEn: String(row.notes_en),
    notesAr: String(row.notes_ar),
    formPreset: String(row.form_preset),
    imageId: row.image_id === null ? "" : Number(row.image_id),
    sortOrder: Number(row.sort_order),
    ...(row.is_published ? { isPublished: "on" } : {}),
    ...(row.is_featured ? { isFeatured: "on" } : {}),
    ...over,
  };
  if (over.subcategoryId === "") fields.subcategoryId = "";
  return actionOf<Answer>(SERVICE_ACTIONS, `/admin/services/${id}`, "updateService", [{ ok: false }, formOf(fields, session)], session);
}

/** A service made the way an admin makes one: through the Services screen. */
async function createViaScreen(categoryId: number, slug: string, title: string) {
  const fields = {
    slug,
    categoryId,
    subcategoryId: "",
    titleEn: title,
    titleAr: "خدمة جديدة",
    introEn: "Created after the build.",
    introAr: "",
    formPreset: "general",
    sortOrder: 99,
    isPublished: "on",
    benefits: "[]",
    audience: "[]",
    requirements: "[]",
    processSteps: "[]",
  };
  await callAction({
    origin: server.origin,
    route: "/admin/services/new",
    file: SERVICE_ACTIONS,
    action: "createService",
    args: [{ ok: false }, formOf(fields, owner)],
    cookie: owner.cookie,
  });
  const [row] = await sql<{ id: number }[]>`select id from services where slug = ${slug} and category_id = ${categoryId}`;
  assert.ok(row, "the Services screen created the service");
  return row.id;
}

async function deleteViaScreen(id: number) {
  await callAction({
    origin: server.origin,
    route: `/admin/services/${id}`,
    file: SERVICE_ACTIONS,
    action: "deleteService",
    args: [{ ok: false }, formOf({ id }, owner)],
    cookie: owner.cookie,
  });
  assert.equal(await serviceRow(id), undefined, "the Services screen deleted the service");
}

const deleteMedia = (id: number) =>
  actionOf<Answer>(MEDIA_ACTIONS, "/admin/media", "deleteMedia", [{ ok: false }, formOf({ id }, owner)], owner);
/** What the media library's card for one picture says about its placements (0 for "Not placed anywhere yet"). */
const usesOf = (markup: string, title: string) => {
  const card = markup.slice(markup.indexOf(`>${title}</p>`));
  assert.ok(card.length && markup.includes(`>${title}</p>`), `the library shows ${title}`);
  const placed = /^[\s\S]*?(?:Used in (?:<!-- -->)?(\d+)(?:<!-- -->)? place|(Not placed anywhere yet))/.exec(card);
  assert.ok(placed, `the card for ${title} says where it is used`);
  return placed[2] ? 0 : Number(placed[1]);
};
const newMedia = async (name: string) =>
  (await sql<{ id: number }[]>`
    insert into media (filename, mime_type, title, width, height) values (${`${name}.webp`}, 'image/webp', ${name}, 800, 600) returning id`)[0]!.id;

/* -------------------------------------------------------------------------- */

before(async () => {
  assert.ok(isBuilt(), BUILD_HINT);
  database = giveFresh("service_editor");
  sql = connect(database);
  owner = await signIn(sql);
  const [role] = await sql<{ id: number }[]>`select id from roles where key = 'editor'`;
  editorRoleId = role!.id;
  await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    select 'service-actor@test.invalid', 'Service Actor', 'unused', id, true from roles where key = 'editor'`;
  actor = await signIn(sql, "editor");

  // The first published service of three different categories, by their own order.
  const firsts = await sql<Service[]>`
    select distinct on (c.sort_order, c.id) s.id, s.slug, s.title_en, s.title_ar, s.category_id, c.slug as category_slug
      from services s join service_categories c on c.id = s.category_id
     where s.is_published and c.is_published
     order by c.sort_order, c.id, s.sort_order, s.id`;
  assert.ok(firsts.length >= 3, "the fixture has three categories with services");
  [subject, second, third] = firsts.map((row) => ({ ...row })) as [Service, Service, Service];

  // The seed has no service or category questions; give the subject two of its
  // own and its category one, between them.
  await sql`
    insert into faqs (scope, service_id, question_en, answer_en, sort_order, is_published)
    values ('service', ${subject.id}, 'Own question one?', '<p>Own answer one.</p>', 10, true),
           ('service', ${subject.id}, 'Own question two?', '<p>Own answer two.</p>', 30, true)`;
  await sql`
    insert into faqs (scope, category_id, question_en, answer_en, sort_order, is_published)
    values ('category', ${subject.category_id}, 'A category question?', '<p>For every service.</p>', 20, true)`;
  // The disclaimer switch on, so the notices region is drawn.
  await sql`
    update site_settings set value = jsonb_set(value, '{showOnServicePages}', 'true'::jsonb)
     where key = 'disclaimers'`;

  server = await startServer(database, PORT);
});

after(async () => {
  await server?.stop();
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
});

const ownFaqs = async (service: { id: number } = subject) =>
  sql<{ id: number; question_en: string; sort_order: number; is_published: boolean }[]>`
    select id, question_en, sort_order, is_published from faqs where service_id = ${service.id} order by sort_order, id`;

/* ========================================================================== */

describe("discovery: every service, from the database", () => {
  test("the editor lists every service under its category, as its own document", async () => {
    const page = await html("/admin/visual-editor", owner);
    const services = await sql<{ id: number; category: string }[]>`
      select s.id, c.title_en as category from services s join service_categories c on c.id = s.category_id`;
    assert.ok(services.length >= 70);
    for (const row of services) assert.ok(page.includes(`value="service:${row.id}"`), `service ${row.id} is offered`);
    for (const category of new Set(services.map((row) => row.category))) {
      assert.ok(page.includes(`label="Services · ${category.replace(/&/g, "&amp;")}"`), `${category} has a group`);
    }
    // The page CMS and the categories are still there.
    assert.match(page, /<optgroup label="Pages"/);
    assert.match(page, /<optgroup label="Service Categories"/);
  });

  test("?route=service:<id> opens that service; a key that names nothing is never a canvas", async () => {
    const initialOf = (markup: string) => /\\"initial\\":\{\\"slug\\":\\"([^\\]+)\\"/.exec(markup)?.[1];
    assert.equal(initialOf(await html(`/admin/visual-editor?route=service:${subject.id}`, owner)), `service:${subject.id}`);
    for (const bad of ["service:999999", "service:../admin", `service:${subject.slug}`, "javascript:x"]) {
      const opened = initialOf(await html(`/admin/visual-editor?route=${encodeURIComponent(bad)}`, owner));
      assert.ok(opened && opened !== bad, `${bad} opened ${opened}`);
    }
  });

  test("services in different categories open as documents of the same shape", async () => {
    const kinds = (markup: string) => [...new Set(addresses(markup).map((address) => address.split(":")[0]))].sort();
    const first = kinds(await editorPage(subject));
    assert.ok(first.includes("serviceHero") && first.includes("serviceRequest") && first.includes("serviceRelated"));
    for (const other of [second, third]) {
      const regions = kinds(await editorPage(other));
      // The same template everywhere; the subject alone has questions of its own.
      assert.deepEqual(regions.filter((kind) => kind !== "faq"), first.filter((kind) => kind !== "faq"), `service ${other.id}`);
    }
  });
});

describe("the real page in the canvas, and nothing of the editor anywhere else", () => {
  test("the public page carries no editor attribute, bridge or placeholder", async () => {
    const page = await publicPage();
    assert.equal(page.includes("data-eod-"), false);
    assert.equal(page.includes("bridgeId"), false);
    assert.equal(page.includes("route-placeholder"), false);
    assert.equal(page.includes("Select this section"), false);
  });

  test("the parameters alone grant nothing", async () => {
    const path = await addressOf(subject.id);
    const page = await html(`${path}?preview=1&editor=1&bridge=${BRIDGE}`);
    assert.equal(page.includes("data-eod-"), false);
    assert.equal(page.includes("bridgeId"), false);
    const compared = await html(`${path}?compare=published`);
    assert.equal(compared.includes("data-eod-"), false);
  });

  test("a preview, a canvas or a comparison is private and never indexed — whoever asks", async () => {
    const path = await addressOf(subject.id);
    const headers = async (target: string, cookie?: string) => {
      const response = await fetch(`${server.origin}${target}`, { headers: cookie ? { cookie } : {}, redirect: "manual" });
      await response.arrayBuffer();
      return { robots: response.headers.get("x-robots-tag"), cache: response.headers.get("cache-control") };
    };
    for (const cookie of [owner.cookie, undefined]) {
      for (const target of [`${path}?preview=1`, `${path}?preview=1&editor=1&bridge=${BRIDGE}`, `/ar${path}?compare=published`]) {
        const answered = await headers(target, cookie);
        assert.equal(answered.robots, "noindex, nofollow, noarchive", target);
        assert.equal(answered.cache, "private, no-store, max-age=0", target);
      }
    }
    assert.equal((await headers(path)).robots, null);
  });

  test("an authorised canvas marks every region by its record, and draws empty sections to write into", async () => {
    const page = await editorPage();
    const marked = addresses(page);
    for (const address of [
      `serviceHero:${subject.id}`,
      `serviceHero:${subject.id}/field:title`,
      `serviceHero:${subject.id}/field:intro`,
      `serviceHero:${subject.id}/field:category`,
      `serviceHero:${subject.id}/field:ctaLabel`,
      `serviceCrumbs:${subject.id}`,
      `serviceOverview:${subject.id}`,
      `serviceBenefits:${subject.id}`,
      `serviceAudience:${subject.id}`,
      `serviceRequirements:${subject.id}`,
      `serviceProcess:${subject.id}`,
      `serviceNotes:${subject.id}`,
      `serviceFaqs:${subject.id}`,
      `serviceFaqs:${subject.id}/field:inherited`,
      `serviceNotices:${subject.id}/field:notes`,
      `serviceRequest:${subject.id}/field:heading`,
      `serviceRequest:${subject.id}/field:form`,
      `serviceRelated:${subject.id}/field:items`,
    ]) {
      assert.ok(marked.includes(address), address);
    }
    const own = await ownFaqs();
    for (const row of own) assert.ok(marked.includes(`faq:${row.id}/field:question`), `own question ${row.id}`);
    // The category's question is shown, and is not this page's to edit.
    const [inherited] = await sql<{ id: number }[]>`select id from faqs where scope = 'category' and category_id = ${subject.category_id}`;
    assert.ok(page.includes("A category question?"));
    assert.equal(marked.includes(`faq:${inherited!.id}`), false);
    assert.ok(page.includes("route-placeholder"));
    assert.ok(page.includes("bridgeId"));
  });

  test("the Arabic canvas is the real /ar route, RTL, with the same addresses", async () => {
    const english = addresses(await editorPage());
    const arabic = await editorPage(subject, "/ar");
    assert.match(arabic, /<html[^>]*lang="ar"[^>]*dir="rtl"|<html[^>]*dir="rtl"[^>]*lang="ar"/);
    assert.deepEqual(addresses(arabic).sort(), english.sort());
  });

  test("a plain preview shows the preview banner and no editor marks or placeholders", async () => {
    const page = await previewPage();
    assert.equal(page.includes("data-eod-"), false);
    assert.equal(page.includes("route-placeholder"), false);
    assert.match(page, /Preview/);
  });
});

describe("drafts never touch the live service", () => {
  before(resetRoutes);

  test("a title draft is a patch with its starting point; the live row is untouched", async () => {
    const live = (await serviceRow(subject.id))!;
    const saved = await saveValues(at("serviceHero"), (values) => ({
      ...values,
      title: { ...(values.title as object), en: "Draft Service Title" },
    }));
    assert.ok(saved?.ok, saved?.message);
    assert.equal((await serviceRow(subject.id))!.title_en, live.title_en);
    const node = await nodeRow(`serviceHero:${subject.id}`);
    assert.deepEqual(node!.draft_content, { titleEn: { value: "Draft Service Title", base: live.title_en } });
    assert.equal(node!.route_key, routeKey(subject));
  });

  test("the public page, its title tag and its structured data keep the live title; preview and canvas show the draft", async () => {
    const live = await publicPage();
    assert.equal(live.includes("Draft Service Title"), false);
    assert.equal(titleOf(live).includes("Draft Service Title"), false);
    assert.equal((ofType(live, "Service") as { name: string }).name, subject.title_en);
    assert.ok((await previewPage()).includes("Draft Service Title"));
    assert.ok((await editorPage()).includes("Draft Service Title"));
    // The preview's structured data describes the draft it shows; its <title> stays the published one.
    const preview = await previewPage();
    assert.equal((ofType(preview, "Service") as { name: string }).name, "Draft Service Title");
    assert.equal(titleOf(preview).includes("Draft Service Title"), false);
  });

  test("Arabic is its own field: an Arabic edit leaves English alone and is not seeded from it", async () => {
    const hero = await region(at("serviceHero"));
    assert.equal((hero.values.title as { ar: string }).ar, subject.title_ar);
    assert.equal((hero.values.intro as { ar: string }).ar, "");
    const saved = await save("saveRouteRegionDraft", at("serviceHero"), hero.revision, "values", {
      ...hero.values,
      title: { en: "Draft Service Title", ar: "عنوان الخدمة التجريبي" },
      intro: { en: (hero.values.intro as { en: string }).en, ar: "مقدمة عربية" },
    });
    assert.ok(saved?.ok, saved?.message);
    const arabic = await previewPage(subject, "/ar");
    assert.ok(arabic.includes("عنوان الخدمة التجريبي"));
    assert.ok(arabic.includes("مقدمة عربية"));
    // The English preview has neither.
    assert.equal((await previewPage()).includes("مقدمة عربية"), false);
  });

  test("the sections are drafts of the same service row: body, lists, steps, timeline, notes and headings", async () => {
    const results = [
      await saveValues(at("serviceOverview"), (values) => ({
        ...values,
        heading: { en: "What we do for you", ar: "" },
        body: { en: '<p onclick="steal()">An overview.<script>alert(1)</script></p>', ar: "" },
      })),
      await saveValues(at("serviceBenefits"), (values) => ({
        ...values,
        benefits: [{ text: { en: "Fast turnaround", ar: "سريع" } }, { text: { en: "", ar: "" } }, { text: { en: "One point of contact", ar: "" } }],
      })),
      await saveValues(at("serviceRequirements"), (values) => ({ ...values, requirements: [{ text: { en: "Passport copy", ar: "" } }] })),
      await saveValues(at("serviceProcess"), (values) => ({
        ...values,
        steps: [
          { title: { en: "Tell us what you need", ar: "" }, detail: { en: "A short call.", ar: "" } },
          { title: { en: "We prepare the file", ar: "" }, detail: { en: "", ar: "" } },
        ],
      })),
      await saveValues(at("serviceNotes"), (values) => ({ ...values, notes: { en: "<p>Fees are set by the authority.</p>", ar: "" } })),
      await saveValues(at("serviceHero"), (values) => ({
        ...values,
        timeline: { en: "Typically 5–10 working days", ar: "" },
        ctaLabel: { en: "Start my request", ar: "" },
      })),
    ];
    for (const result of results) assert.ok(result?.ok, result?.message);

    const overview = (await nodeRow(`serviceOverview:${subject.id}`))!.draft_content as Record<string, { value: string }>;
    assert.doesNotMatch(overview.bodyEn!.value, /script|onclick/);
    assert.equal(overview["copy:headingEn"]!.value, "What we do for you");
    const live = (await serviceRow(subject.id))!;
    assert.deepEqual(live.benefits, []);
    assert.equal(live.body_en, "");
    assert.equal(live.timeline_en, "");

    const preview = await previewPage();
    for (const words of ["What we do for you", "An overview.", "Fast turnaround", "One point of contact", "Passport copy", "We prepare the file", "Fees are set by the authority.", "Typically 5–10 working days", "Start my request"]) {
      assert.ok(preview.includes(words), words);
    }
    const page = await publicPage();
    for (const words of ["What we do for you", "Fast turnaround", "Typically 5–10 working days", "Start my request"]) {
      assert.equal(page.includes(words), false, words);
    }
    // The Arabic page shows the Arabic benefit, and the standard Arabic heading where none was written.
    const arabic = await previewPage(subject, "/ar");
    assert.ok(arabic.includes("سريع"));
  });

  test("a picture is chosen from the library and removed again; an id that is not there is refused", async () => {
    const [picture] = await sql<{ id: number }[]>`select id from media order by id limit 1`;
    assert.ok(picture, "the fixture's library holds a picture");
    const hero = at("serviceHero");
    const imageDraft = async () =>
      ((await nodeRow(`serviceHero:${subject.id}`))?.draft_content as Record<string, { value: unknown }> | null)?.imageId;
    const missing = await saveValues(hero, (values) => ({ ...values, image: 987654 }));
    assert.equal(missing?.ok, false);
    assert.match(String(missing?.message), /media library/);
    const chosen = await saveValues(hero, (values) => ({ ...values, image: picture.id }));
    assert.ok(chosen?.ok, chosen?.message);
    assert.equal((await imageDraft())?.value, picture.id);
    assert.ok((await previewPage()).includes("/media/"), "the preview draws the chosen picture");
    const removed = await saveValues(hero, (values) => ({ ...values, image: null }));
    assert.ok(removed?.ok, removed?.message);
    assert.equal(await imageDraft(), undefined);
    assert.equal((await serviceRow(subject.id))!.image_id, null);
  });

  test("identity and generated content are never stored, whatever is sent", async () => {
    const hero = await region(at("serviceHero"));
    for (const name of ["category", "whatsapp", "slug", "categoryId", "published"]) assert.equal(name in hero.values, false, name);
    const saved = await save("saveRouteRegionDraft", at("serviceHero"), hero.revision, "values", {
      ...hero.values,
      slug: "hijacked",
      categoryId: 999,
      whatsapp: "https://evil.example",
      category: "https://evil.example",
    });
    assert.ok(saved?.ok);
    const draft = JSON.stringify((await nodeRow(`serviceHero:${subject.id}`))!.draft_content);
    assert.equal(draft.includes("evil"), false);
    assert.equal(draft.includes("hijacked"), false);
    assert.equal((await serviceRow(subject.id))!.slug, subject.slug);
  });

  test("a stale revision is a conflict, answered with the version that won", async () => {
    const hero = await region(at("serviceHero"));
    const first = await save("saveRouteRegionDraft", at("serviceHero"), hero.revision, "values", {
      ...hero.values,
      timeline: { en: "First writer.", ar: "" },
    });
    assert.ok(first?.ok);
    const second = await save("saveRouteRegionDraft", at("serviceHero"), hero.revision, "values", {
      ...hero.values,
      timeline: { en: "Second writer.", ar: "" },
    });
    assert.equal(second?.ok, false);
    assert.equal(second?.reason, "conflict");
    assert.match(JSON.stringify(second), /First writer\./);
  });

  test("another service's region, a category's region and a category's question cannot be written through this canvas", async () => {
    const foreign = await load(at("serviceHero", second), subject);
    assert.equal(foreign.ok, false);
    const card = await load({ type: "service", id: subject.id }, subject);
    assert.equal(card.ok, false, "the service's card belongs to its category's page");
    const [inherited] = await sql<{ id: number }[]>`select id from faqs where scope = 'category' and category_id = ${subject.category_id}`;
    assert.equal((await load({ type: "faq", id: inherited!.id }, subject)).ok, false);
    const saved = await routeAction<Answer>("saveRouteRegionDraft", [
      formOf({ sectionId: keyOf(at("serviceHero", second)), pageId: pageOf(subject), expectedRevision: 0, values: "{}" }, owner),
    ]);
    assert.equal(saved?.ok, false);
    assert.equal(await nodeRow(`serviceHero:${second.id}`), null);
  });

  test("styles and motion are drafts too, in the closed vocabulary; the breadcrumbs never move", async () => {
    const benefits = at("serviceBenefits");
    const current = await region(benefits);
    const styled = await save("saveRouteRegionStyles", benefits, current.revision, "styles", {
      v: STYLE_DOCUMENT_VERSION,
      nodes: { "field:heading": { base: { textColor: "peach" }, mobile: { textColor: "strong" } }, "field:x": { base: { css: "x" } } },
    });
    assert.ok(styled?.ok, styled?.message);
    const afterStyle = await region(benefits);
    const moved = await save("saveRouteRegionMotion", benefits, afterStyle.revision, "motionDocument", {
      v: 1,
      section: { base: { entrance: "fade-up" } },
      nodes: { "field:benefits": { base: { entrance: "fade", stagger: "normal" } } },
    });
    assert.ok(moved?.ok, moved?.message);
    const node = await nodeRow(`serviceBenefits:${subject.id}`);
    assert.ok(node!.draft_styles);
    assert.ok(node!.draft_motion);
    assert.equal(node!.styles, null);
    assert.equal(JSON.stringify(node!.draft_styles).includes("css"), false);
    const crumbs = await region(at("serviceCrumbs"));
    const still = await save("saveRouteRegionMotion", at("serviceCrumbs"), crumbs.revision, "motionDocument", {
      v: 1,
      section: { base: { entrance: "fade-up" } },
      nodes: {},
    });
    assert.ok(still?.ok);
    assert.deepEqual((still as unknown as { motionDocument: { section: object } }).motionDocument.section, {});
  });

  test("Preview draws the draft's styles and entrances; the public page draws neither", async () => {
    const count = (markup: string, needle: RegExp) => markup.match(needle)?.length ?? 0;
    const preview = await previewPage();
    const live = await publicPage();
    // The Mobile colour chosen above, and the benefits section's entrance.
    assert.ok(count(preview, /data-rs-m="/g) > count(live, /data-rs-m="/g), "the draft's Mobile style is in the preview");
    assert.ok(count(preview, /\sdata-m-reveal=""/g) > count(live, /\sdata-m-reveal=""/g), "the draft's entrance is in the preview");
    assert.equal(count(live, /data-rs-m="/g), 0);
  });

  test("drafts survive a restart: they are rows, read again by a fresh server", async () => {
    earlierLogs.push(server.log());
    await server.stop();
    server = await startServer(database, PORT);
    assert.ok((await previewPage()).includes("Draft Service Title"));
  });
});

describe("publish is atomic, guarded, audited and invalidates the caches", () => {
  test("publishing writes the patched columns, clears the drafts and records the version", async () => {
    const before = await counts();
    const reveals = (markup: string) => markup.match(/\sdata-m-reveal=""/g)?.length ?? 0;
    const revealsBefore = reveals(await publicPage());
    const view = await summary();
    assert.equal(view.kind, "service");
    assert.equal(view.path, await addressOf(subject.id));
    assert.ok(view.publishable, JSON.stringify(view));
    const answer = await publish();
    assert.ok(answer?.ok, answer?.ok ? "" : answer?.message);

    const row = (await serviceRow(subject.id))!;
    assert.equal(row.title_en, "Draft Service Title");
    assert.equal(row.title_ar, "عنوان الخدمة التجريبي");
    assert.equal(row.intro_ar, "مقدمة عربية");
    assert.equal(row.timeline_en, "First writer.");
    assert.match(String(row.body_en), /An overview\./);
    assert.doesNotMatch(String(row.body_en), /script|onclick/);
    // A list is published as the Services screen would store it: no empty rows.
    assert.deepEqual(row.benefits, [{ en: "Fast turnaround", ar: "سريع" }, { en: "One point of contact", ar: "" }]);
    assert.deepEqual(row.process_steps, [
      { en: "Tell us what you need", ar: "", detailEn: "A short call.", detailAr: "" },
      { en: "We prepare the file", ar: "", detailEn: "", detailAr: "" },
    ]);
    assert.equal((await nodeRow(`serviceHero:${subject.id}`))!.draft_content, null);
    assert.equal((await nodeRow(`serviceOverview:${subject.id}`))!.copy && ((await nodeRow(`serviceOverview:${subject.id}`))!.copy as Record<string, string>).headingEn, "What we do for you");

    const versions = await sql<{ kind: string }[]>`select kind from route_versions where route_key = ${routeKey(subject)} order by id`;
    assert.deepEqual(versions.map((version) => version.kind), ["baseline", "publish"]);
    const [logged] = await sql<{ entity_type: string; entity_id: string }[]>`
      select entity_type, entity_id from activity_logs where action = 'route.published' order by id desc limit 1`;
    assert.deepEqual({ ...logged }, { entity_type: "service", entity_id: String(subject.id) });
    // Nothing duplicated anywhere: the service is still one row.
    assert.deepEqual(await counts(), before);

    // The live page, its metadata and its structured data show it — on the very next request.
    const live = await publicPage();
    for (const words of ["Draft Service Title", "What we do for you", "Fast turnaround", "Typically", "Start my request"].slice(0, 3)) {
      assert.ok(live.includes(words), words);
    }
    assert.ok(titleOf(live).includes("Draft Service Title"), titleOf(live));
    assert.equal((ofType(live, "Service") as { name: string }).name, "Draft Service Title");
    assert.equal(live.includes("data-eod-"), false);
    assert.ok(live.includes("data-rs-m") || live.includes("--rs-"), "the published mobile style is on the page");
    assert.equal(reveals(live), revealsBefore + 1, "the section's published entrance is on the page");
    assert.ok((await publicPage(subject, "/ar")).includes("عنوان الخدمة التجريبي"));
  });

  test("the catalogue cache is dropped: the category page's card and the search show the new title at once", async () => {
    const [category] = await sql<{ slug: string }[]>`select slug from service_categories where id = ${subject.category_id}`;
    assert.ok((await html(`/services/${category!.slug}`)).includes("Draft Service Title"));
    assert.ok((await html(`/search?q=${encodeURIComponent("Draft Service Title")}`)).includes("Draft Service Title"));
  });

  test("a field changed on the Services screen since its draft began blocks the whole publication", async () => {
    const hero = await region(at("serviceHero"));
    assert.ok((await save("saveRouteRegionDraft", at("serviceHero"), hero.revision, "values", { ...hero.values, intro: { en: "Editor intro.", ar: "مقدمة عربية" } }))?.ok);
    assert.ok((await saveValues(at("serviceAudience"), (values) => ({ ...values, audience: [{ text: { en: "Should not land", ar: "" } }] })))?.ok);
    // The Services screen saves the same field, live, in the meantime.
    const form = await servicesForm(subject.id, { introEn: "Form intro." });
    assert.ok(form?.ok, form?.message);

    const blocked = await publish();
    assert.equal(blocked?.ok, false);
    assert.equal(blocked && !blocked.ok ? blocked.reason : "", "conflict");
    // Nothing was written — not even the audience, which had no conflict.
    const row = (await serviceRow(subject.id))!;
    assert.deepEqual(row.audience, []);
    assert.equal(row.intro_en, "Form intro.");

    const after = await region(at("serviceHero"));
    assert.deepEqual(after.route?.conflicts.map((conflict) => conflict.key), ["introEn"]);
    const kept = await routeAction<VisualContentSaveResult>("resolveRouteConflict", [
      formOf({ sectionId: keyOf(at("serviceHero")), pageId: pageOf(subject), expectedRevision: after.revision, field: "introEn", choice: "mine" }, owner),
    ]);
    assert.ok(kept?.ok);
    const done = await publish();
    assert.ok(done?.ok, done && !done.ok ? done.message : "");
    const published = (await serviceRow(subject.id))!;
    assert.equal(published.intro_en, "Editor intro.");
    assert.deepEqual(published.audience, [{ en: "Should not land", ar: "" }]);
  });

  test("a field changed elsewhere is kept when the draft publishes a different one", async () => {
    // Editor A drafts the timeline; meanwhile another admin saves the introduction on
    // the Services screen. A's publication writes the timeline and only the timeline.
    assert.ok((await saveValues(at("serviceHero"), (values) => ({ ...values, timeline: { en: "Only the timeline", ar: "" } })))?.ok);
    const form = await servicesForm(subject.id, { introEn: "Saved by another admin." });
    assert.ok(form?.ok, form?.message);
    const answer = await publish();
    assert.ok(answer?.ok, answer && !answer.ok ? answer.message : "");
    const row = (await serviceRow(subject.id))!;
    assert.equal(row.timeline_en, "Only the timeline");
    assert.equal(row.intro_en, "Saved by another admin.");
  });

  test("the category page's card and the service's page share columns and never overwrite each other silently", async () => {
    // A card draft on the category page, and a page draft here, of the same column.
    const pageOfCategory = documentEditorKey({ kind: "category", id: subject.category_id });
    const card = await routeAction<VisualSectionLoad>("loadRouteRegion", [keyOf({ type: "service", id: subject.id }), pageOfCategory]);
    assert.ok(card?.ok);
    const cardSave = await routeAction<Answer>("saveRouteRegionDraft", [
      formOf(
        {
          sectionId: keyOf({ type: "service", id: subject.id }),
          pageId: pageOfCategory,
          expectedRevision: card.section.revision,
          values: JSON.stringify({ ...card.section.values, intro: { en: "Card intro.", ar: "مقدمة عربية" } }),
        },
        owner,
      ),
    ]);
    assert.ok(cardSave?.ok, cardSave?.message);
    assert.ok((await saveValues(at("serviceHero"), (values) => ({ ...values, intro: { en: "Page intro.", ar: "مقدمة عربية" } })))?.ok);
    assert.ok((await publish())?.ok);
    assert.equal((await serviceRow(subject.id))!.intro_en, "Page intro.");
    // The card's draft began from the old value: its page says so, and refuses to publish over it.
    const categoryRoute = `category:${subject.category_id}`;
    const view = await routeAction<RouteSummaryView | null>("loadRouteSummary", [categoryRoute]);
    assert.ok(view && view.conflicts >= 1 && !view.publishable, JSON.stringify(view));
    const refused = await routeAction<RouteActionResult>("publishRouteFromEditor", [formOf({ routeKey: categoryRoute, token: view.token }, owner)]);
    assert.equal(refused && !refused.ok ? refused.reason : "", "conflict");
    assert.equal((await serviceRow(subject.id))!.intro_en, "Page intro.");
    const cleared = await routeAction<RouteActionResult>("discardRouteFromEditor", [formOf({ routeKey: categoryRoute, token: view.token }, owner)]);
    assert.ok(cleared?.ok);
  });

  test("taking the live value drops that field from the draft", async () => {
    assert.ok((await saveValues(at("serviceHero"), (values) => ({ ...values, timeline: { en: "Mine again", ar: "" } })))?.ok);
    await sql`update services set timeline_en = 'Theirs again' where id = ${subject.id}`;
    const now = await region(at("serviceHero"));
    const taken = await routeAction<VisualContentSaveResult>("resolveRouteConflict", [
      formOf({ sectionId: keyOf(at("serviceHero")), pageId: pageOf(subject), expectedRevision: now.revision, field: "timelineEn", choice: "live" }, owner),
    ]);
    assert.ok(taken?.ok);
    assert.equal((await nodeRow(`serviceHero:${subject.id}`))!.draft_content, null);
    assert.equal((await summary()).publishable, false);
  });

  test("drafts that changed after review are not published unseen", async () => {
    assert.ok((await saveValues(at("serviceHero"), (values) => ({ ...values, timeline: { en: "Reviewed", ar: "" } })))?.ok);
    const stale = (await summary()).token;
    assert.ok((await saveValues(at("serviceHero"), (values) => ({ ...values, timeline: { en: "Changed after review", ar: "" } })))?.ok);
    const refused = await routeAction<RouteActionResult>("publishRouteFromEditor", [formOf({ routeKey: routeKey(subject), token: stale }, owner)]);
    assert.equal(refused && !refused.ok ? refused.reason : "", "stale");
    assert.equal((await serviceRow(subject.id))!.timeline_en, "Theirs again");
  });

  test("discard removes the drafts and only the drafts", async () => {
    const before = await serviceRow(subject.id);
    const answer = await discard();
    assert.ok(answer?.ok);
    assert.equal((await nodeRow(`serviceHero:${subject.id}`))!.draft_content, null);
    assert.deepEqual(await serviceRow(subject.id), before);
    assert.equal((await previewPage()).includes("Changed after review"), false);
  });
});

describe("the service's own questions", () => {
  test("a question's draft, its visibility and the order of the service's questions publish together", async () => {
    const own = await ownFaqs();
    const [first, secondQuestion] = own;
    const edit = await saveValues({ type: "faq", id: first!.id }, (values) => ({ ...values, question: { en: "Edited own question?", ar: "" } }));
    assert.ok(edit?.ok, edit?.message);
    const hide = await saveValues({ type: "faq", id: secondQuestion!.id }, (values) => ({ ...values, published: false }));
    assert.ok(hide?.ok, hide?.message);
    const reorder = await saveValues(at("serviceFaqs"), (values) => ({ ...values, _order: { faqs: [secondQuestion!.id, first!.id] } }));
    assert.ok(reorder?.ok, reorder?.message);

    // The canvas draws the hidden one dimmed; the public page and its FAQ data do not have the draft at all.
    const canvas = await editorPage();
    assert.match(canvas, new RegExp(`data-eod-address="faq:${secondQuestion!.id}"[^>]*data-eod-hidden|data-eod-hidden[^>]*data-eod-address="faq:${secondQuestion!.id}"`));
    const canvasFaq = ofType(canvas, "FAQPage") as { mainEntity: { name: string }[] };
    assert.equal(canvasFaq.mainEntity.some((entry) => entry.name === "Own question two?"), false, "hidden content is not in the structured data");
    const live = await publicPage();
    assert.equal(live.includes("Edited own question?"), false);

    assert.ok((await publish())?.ok);
    const after = await ownFaqs();
    assert.equal(after.find((row) => row.id === first!.id)!.question_en, "Edited own question?");
    assert.equal(after.find((row) => row.id === secondQuestion!.id)!.is_published, false);
    const page = await publicPage();
    assert.ok(page.includes("Edited own question?"));
    assert.equal(page.includes("Own question two?"), false);
    const faqData = ofType(page, "FAQPage") as { mainEntity: { name: string }[] };
    assert.deepEqual(faqData.mainEntity.map((entry) => entry.name), ["A category question?", "Edited own question?"]);
    // The category's question kept its place.
    const [inherited] = await sql<{ sort_order: number }[]>`select sort_order from faqs where scope = 'category' and category_id = ${subject.category_id}`;
    assert.equal(inherited!.sort_order, 20);
    await sql`update faqs set is_published = true where id = ${secondQuestion!.id}`;
  });

  test("questions need faqs.manage; services.manage is not enough", async () => {
    const session = await as([...READ, "content.edit", "services.manage"]);
    const [question] = await ownFaqs();
    const target: RouteOwner = { type: "faq", id: question!.id };
    const current = await region(target);
    const refused = await save("saveRouteRegionDraft", target, current.revision, "values", { ...current.values, question: { en: "Nope?", ar: "" } }, session);
    assert.equal(refused?.ok, false);
    assert.match(String(refused?.message), /FAQ/);
  });
});

describe("history, compare and restore", () => {
  test("each publication is listed with its actor and compares field by field, in both languages", async () => {
    const history = await routeAction<RouteHistoryView | null>("loadRouteHistory", [routeKey(subject)]);
    assert.ok(history && history.versions.length >= 4);
    const baseline = history.versions.find((version) => version.kind === "baseline")!;
    const first = history.versions.filter((version) => version.kind === "publish").at(-1)!;
    assert.ok(first.actorName);
    const changed = await routeAction<RouteCompareView | null>("loadRouteCompare", [routeKey(subject), first.id, "previous"]);
    assert.ok(changed);
    const fields = changed.changes.map((change) => change.field);
    for (const field of ["Title (English)", "Title (Arabic)", "Key benefits", "Steps", "Style", "Motion"]) assert.ok(fields.includes(field), field);
    assert.ok(changed.changes.some((change) => change.after.includes("Fast turnaround")));
    const versusLive = await routeAction<RouteCompareView | null>("loadRouteCompare", [routeKey(subject), baseline.id, "live"]);
    assert.ok(versusLive?.changes.some((change) => change.field === "Title (English)"));
  });

  test("a version is viewed by the real page, still and read-only", async () => {
    const history = (await routeAction<RouteHistoryView | null>("loadRouteHistory", [routeKey(subject)]))!;
    const baseline = history.versions.find((version) => version.kind === "baseline")!;
    const path = await addressOf(subject.id);
    const view = await html(`${path}?compare=v${baseline.id}`, owner);
    assert.ok(view.includes(subject.title_en), "the baseline shows the title as it was");
    assert.ok(view.includes("data-eod-still"));
    // A version of another route is not this page's to show.
    const [foreign] = await sql<{ id: number }[]>`insert into route_versions (route_key, kind, snapshot) values ('service:999999', 'publish', '{"v":1,"title":"x","owners":{}}') returning id`;
    assert.equal(await statusOf(`${path}?compare=v${foreign!.id}`, owner), 404);
  });

  test("restoring builds a draft, never touches live, never publishes, and refuses while drafts are pending", async () => {
    const history = (await routeAction<RouteHistoryView | null>("loadRouteHistory", [routeKey(subject)]))!;
    const baseline = history.versions.find((version) => version.kind === "baseline")!;
    const live = await serviceRow(subject.id);
    const versionsBefore = history.versions.length;
    const restored = await routeForm("restoreRouteFromEditor", { versionId: baseline.id });
    assert.ok(restored?.ok, restored && !restored.ok ? restored.message : "");
    assert.deepEqual(await serviceRow(subject.id), live);
    assert.equal((await publicPage()).includes(subject.title_en), false, "the public page still shows the published title");
    const draft = (await nodeRow(`serviceHero:${subject.id}`))!.draft_content as Record<string, { value: unknown }>;
    assert.equal(draft.titleEn!.value, subject.title_en);
    const after = (await routeAction<RouteHistoryView | null>("loadRouteHistory", [routeKey(subject)]))!;
    assert.equal(after.versions.length, versionsBefore, "a restore is not a publication");
    const blocked = await routeForm("restoreRouteFromEditor", { versionId: baseline.id });
    assert.equal(blocked && !blocked.ok ? blocked.reason : "", "blocked");
    assert.ok((await discard())?.ok);
  });
});

describe("a move to another category, through the Services screen", () => {
  test("the page keeps its identity, its drafts and its history; the old address is gone, as before", async () => {
    await resetRoutes();
    const service = second;
    const oldPath = await addressOf(service.id);
    // 1–3. A draft of content and of presentation, and a publication for history.
    assert.ok((await saveValues(at("serviceHero", service), (values) => ({ ...values, title: { ...(values.title as object), en: "Before the move" } }), owner, service))?.ok);
    assert.ok((await publish(owner, service))?.ok);
    assert.ok((await saveValues(at("serviceHero", service), (values) => ({ ...values, timeline: { en: "Moving draft", ar: "" } }), owner, service))?.ok);
    const style = await region(at("serviceOverview", service), service);
    assert.ok((await save("saveRouteRegionStyles", at("serviceOverview", service), style.revision, "styles", { v: STYLE_DOCUMENT_VERSION, nodes: { "field:heading": { base: { textColor: "peach" } } } }, owner, service))?.ok);
    const nodesBefore = await nodesOf(service.id);
    const versionsBefore = await sql<{ id: number }[]>`select id from route_versions where route_key = ${routeKey(service)} order by id`;

    // 4. The Services screen's own Category select, to a category without this slug.
    const [target] = await sql<{ id: number; slug: string }[]>`
      select c.id, c.slug from service_categories c
       where c.id <> ${service.category_id}
         and not exists (select 1 from services s where s.category_id = c.id and s.slug = ${service.slug})
       order by c.sort_order limit 1`;
    const moved = await servicesForm(service.id, { categoryId: target!.id, subcategoryId: "" });
    assert.ok(moved?.ok, moved?.message);
    const newPath = await addressOf(service.id);
    assert.equal(newPath, `/services/${target!.slug}/${service.slug}`);

    // 5–6. The same document at its new address: the editor lists it there, its
    // canvas carries the same region keys, and its drafts and history are its own.
    const editor = await html(`/admin/visual-editor?route=service:${service.id}`, owner);
    assert.ok(editor.includes(`value="service:${service.id}"`));
    assert.ok(editor.includes(newPath));
    const canvas = await html(`${newPath}?preview=1&editor=1&bridge=${BRIDGE}`, owner);
    assert.ok(addresses(canvas).includes(`serviceHero:${service.id}/field:title`));
    assert.ok(canvas.includes("Moving draft"));
    const view = await summary(service);
    assert.equal(view.path, newPath);
    assert.ok(view.owners.some((entry) => entry.ownerKey === `serviceHero:${service.id}`));
    assert.ok(view.owners.some((entry) => entry.ownerKey === `serviceOverview:${service.id}` && entry.style));
    const history = (await routeAction<RouteHistoryView | null>("loadRouteHistory", [routeKey(service)]))!;
    assert.deepEqual(history.versions.map((version) => version.id).sort(), versionsBefore.map((row) => row.id).sort());

    // 7. No second identity was made for it.
    assert.deepEqual(await nodesOf(service.id), nodesBefore);
    assert.equal(nodesBefore.every((row) => row.route_key === routeKey(service)), true);

    // 8. The old address is what the site has always answered for a missing
    // slug: not found (the retired-address map does not name it), in both editions.
    assert.equal(await statusOf(oldPath), 404);
    assert.equal(await statusOf(`/ar${oldPath}`), 404);
    assert.equal(await statusOf(`${oldPath}?preview=1`, owner), 404);
    assert.equal(await statusOf(newPath), 200);

    // And it publishes from there, onto the same row.
    assert.ok((await publish(owner, service))?.ok);
    assert.equal((await serviceRow(service.id))!.timeline_en, "Moving draft");
    assert.ok((await html(newPath)).includes("Moving draft"));
  });
});

describe("renames and the address", () => {
  test("an English or an Arabic rename on the Services screen is the same document", async () => {
    const service = third;
    const nodes = await nodesOf(service.id);
    // A heading and a body: the page draws an overview only when it has a body.
    assert.ok(
      (await saveValues(at("serviceOverview", service), (values) => ({ ...values, heading: { en: "Kept across renames", ar: "" }, body: { en: "<p>Drafted before the rename.</p>", ar: "" } }), owner, service))?.ok,
    );
    const renamed = await servicesForm(service.id, { titleEn: "Renamed Service", titleAr: "خدمة معاد تسميتها" });
    assert.ok(renamed?.ok, renamed?.message);
    const view = await summary(service);
    assert.equal(view.title, "Renamed Service");
    assert.equal(view.routeKey, routeKey(service));
    assert.ok(view.owners.some((entry) => entry.ownerKey === `serviceOverview:${service.id}`), "the draft is still the service's");
    assert.ok((await previewPage(service)).includes("Kept across renames"));
    assert.ok((await previewPage(service, "/ar")).includes("خدمة معاد تسميتها"));
    assert.equal((await nodesOf(service.id)).length, nodes.length + 1);
    assert.ok((await discard(owner, service))?.ok);
  });

  test("the application has no slug change for a service: the Services screen keeps the address", async () => {
    const service = third;
    const before = await addressOf(service.id);
    const answer = await servicesForm(service.id, { slug: "a-changed-address" });
    assert.ok(answer?.ok, answer?.message);
    assert.equal((await serviceRow(service.id))!.slug, service.slug);
    assert.equal(await addressOf(service.id), before);
    assert.equal(await statusOf(before), 200);
  });
});

describe("a service created after the build", () => {
  test("is discovered, opens with every region, takes drafts in both languages, previews, publishes — with no code", async () => {
    const id = await createViaScreen(subject.category_id, "created-after-the-build", "Created After The Build");
    const path = await addressOf(id);
    const editor = await html("/admin/visual-editor", owner);
    assert.ok(editor.includes(`value="service:${id}"`));
    assert.ok(editor.includes("Created After The Build"));
    const canvas = await html(`${path}?preview=1&editor=1&bridge=${BRIDGE}`, owner);
    const kinds = new Set(addresses(canvas).map((address) => address.split(":")[0]));
    for (const kind of ["serviceHero", "serviceCrumbs", "serviceOverview", "serviceBenefits", "serviceProcess", "serviceRequest"]) assert.ok(kinds.has(kind), kind);
    const arabicCanvas = await html(`/ar${path}?preview=1&editor=1&bridge=${BRIDGE}`, owner);
    assert.match(arabicCanvas, /dir="rtl"/);

    const created = { id };
    assert.ok((await saveValues(at("serviceHero", created), (values) => ({ ...values, title: { en: "Created, then edited", ar: "أنشئت ثم حررت" } }), owner, created))?.ok);
    assert.ok((await saveValues(at("serviceBenefits", created), (values) => ({ ...values, benefits: [{ text: { en: "A new benefit", ar: "" } }] }), owner, created))?.ok);
    assert.ok((await html(`${path}?preview=1`, owner)).includes("A new benefit"));
    assert.ok((await html(`/ar${path}?preview=1`, owner)).includes("أنشئت ثم حررت"));
    assert.equal((await html(path)).includes("Created, then edited"), false);
    assert.ok((await publish(owner, created))?.ok);
    assert.ok((await html(path)).includes("Created, then edited"));
    assert.ok((await html(path)).includes("A new benefit"));

    // Cleaned up the way it was made.
    await deleteViaScreen(id);
    assert.equal(await statusOf(path), 404);
  });
});

describe("a deleted service", () => {
  test("its page closes everywhere, nothing of it is reassigned, and its history is kept", async () => {
    const id = await createViaScreen(subject.category_id, "deleted-with-drafts", "Deleted With Drafts");
    const gone = { id };
    const path = await addressOf(id);
    assert.ok((await saveValues(at("serviceHero", gone), (values) => ({ ...values, timeline: { en: "Published once", ar: "" } }), owner, gone))?.ok);
    assert.ok((await publish(owner, gone))?.ok);
    assert.ok((await saveValues(at("serviceHero", gone), (values) => ({ ...values, timeline: { en: "Left pending", ar: "" } }), owner, gone))?.ok);
    const tokenBefore = (await summary(gone)).token;

    await deleteViaScreen(id);

    // No crash and no editing: every read answers "no longer exists".
    const loaded = await load(at("serviceHero", gone), gone);
    assert.equal(loaded.ok, false);
    assert.equal(await routeAction("loadRouteSummary", [routeKey(gone)]), null);
    assert.equal(await routeAction("loadRouteHistory", [routeKey(gone)]), null);
    const published = await routeAction<RouteActionResult>("publishRouteFromEditor", [formOf({ routeKey: routeKey(gone), token: tokenBefore }, owner)]);
    assert.equal(published?.ok, false);
    const saved = await routeAction<Answer>("saveRouteRegionDraft", [
      formOf({ sectionId: keyOf(at("serviceHero", gone)), pageId: pageOf(gone), expectedRevision: 1, values: "{}" }, owner),
    ]);
    assert.equal(saved?.ok, false);
    // Not offered, not public, not previewable.
    assert.equal((await html("/admin/visual-editor", owner)).includes(`value="service:${id}"`), false);
    assert.equal(await statusOf(path), 404);
    assert.equal(await statusOf(`${path}?preview=1&editor=1&bridge=${BRIDGE}`, owner), 404);

    // Its history and its pending draft are kept, dormant — not destroyed and not reassigned.
    const [{ versions }] = await sql<{ versions: number }[]>`select count(*)::int as versions from route_versions where route_key = ${routeKey(gone)}`;
    assert.ok(versions >= 2);
    assert.ok(await nodeRow(`serviceHero:${id}`));
    // A service made afterwards is a new identity: a new id, and none of that state.
    const next = await createViaScreen(subject.category_id, "made-after-a-deletion", "Made After A Deletion");
    assert.ok(next > id);
    assert.equal((await nodesOf(next)).length, 0);
    const fresh = await summary({ id: next });
    assert.equal(fresh.owners.length, 0);
    assert.deepEqual((await routeAction<RouteHistoryView | null>("loadRouteHistory", [`service:${next}`]))!.versions, []);
    await deleteViaScreen(next);
  });
});

describe("the media library's guard counts what drafts have chosen", () => {
  test("published, drafted, a category page's draft, a replaced draft, a discarded draft and a deleted service", async () => {
    await resetRoutes();
    const [m1, m2, m3, m4, m5] = [await newMedia("b22-published"), await newMedia("b22-draft"), await newMedia("b22-category-draft"), await newMedia("b22-replacement"), await newMedia("b22-orphaned")];

    // Published service media: the live column counts it, as it always did.
    await sql`update services set image_id = ${m1} where id = ${subject.id}`;
    const published = await deleteMedia(m1);
    assert.equal(published?.ok, false);

    // A service page's draft.
    assert.ok((await saveValues(at("serviceHero", second), (values) => ({ ...values, image: m2 }), owner, second))?.ok);
    const drafted = await deleteMedia(m2);
    assert.equal(drafted?.ok, false);
    assert.match(String(drafted?.message), /service page draft/);
    assert.equal(usesOf(await html("/admin/media", owner), "b22-draft"), 1, "the library's card counts the draft");

    // A category page's draft (Batch 21's hero), the limitation Batch 21 left open.
    const heroOfCategory = { type: "category" as const, id: second.category_id };
    const pageOfCategory = documentEditorKey({ kind: "category", id: second.category_id });
    const hero = await routeAction<VisualSectionLoad>("loadRouteRegion", [keyOf(heroOfCategory), pageOfCategory]);
    assert.ok(hero?.ok);
    const categoryDraft = await routeAction<Answer>("saveRouteRegionDraft", [
      formOf({ sectionId: keyOf(heroOfCategory), pageId: pageOfCategory, expectedRevision: hero.section.revision, values: JSON.stringify({ ...hero.section.values, image: m3 }) }, owner),
    ]);
    assert.ok(categoryDraft?.ok, categoryDraft?.message);
    const categoryRefusal = await deleteMedia(m3);
    assert.equal(categoryRefusal?.ok, false);
    assert.match(String(categoryRefusal?.message), /category page draft/);

    // A draft that changes its mind: the picture it replaced is free again, the new one is not.
    assert.ok((await saveValues(at("serviceHero", second), (values) => ({ ...values, image: m4 }), owner, second))?.ok);
    assert.equal((await deleteMedia(m2))?.ok, true);
    assert.equal((await deleteMedia(m4))?.ok, false);

    // A discarded draft holds nothing.
    assert.ok((await discard(owner, second))?.ok);
    assert.equal((await deleteMedia(m4))?.ok, true);

    // A deleted service's dormant draft can never be published, so it holds nothing either.
    const id = await createViaScreen(second.category_id, "media-of-a-deleted-service", "Media Of A Deleted Service");
    assert.ok((await saveValues(at("serviceHero", { id }), (values) => ({ ...values, image: m5 }), owner, { id }))?.ok);
    assert.equal((await deleteMedia(m5))?.ok, false);
    await deleteViaScreen(id);
    assert.equal((await deleteMedia(m5))?.ok, true);

    // The category's draft and the published picture are left for the cases after this one.
    await sql`update services set image_id = null where id = ${subject.id}`;
    const categoryRoute = `category:${second.category_id}`;
    const view = await routeAction<RouteSummaryView | null>("loadRouteSummary", [categoryRoute]);
    assert.ok((await routeAction<RouteActionResult>("discardRouteFromEditor", [formOf({ routeKey: categoryRoute, token: view!.token }, owner)]))?.ok);
    assert.equal((await deleteMedia(m3))?.ok, true);
    assert.equal((await deleteMedia(m1))?.ok, true);
  });
});

describe("authority: every action asks again", () => {
  test("view only: the page can be read, and nothing can be saved, published, discarded or restored", async () => {
    await resetRoutes();
    const session = await as(READ);
    const target = at("serviceHero");
    const loaded = await load(target, subject, session);
    assert.ok(loaded.ok);
    const current = loaded.section;
    const words = await save("saveRouteRegionDraft", target, current.revision, "values", { ...current.values, timeline: { en: "No", ar: "" } }, session);
    assert.equal(words?.ok, false);
    const styled = await save("saveRouteRegionStyles", target, current.revision, "styles", { v: STYLE_DOCUMENT_VERSION, nodes: {} }, session);
    assert.equal(styled?.ok, false);
    assert.ok((await saveValues(target, (values) => ({ ...values, timeline: { en: "Pending", ar: "" } })))?.ok);
    assert.equal((await publish(session))?.ok, false);
    assert.equal((await discard(session))?.ok, false);
    const history = (await routeAction<RouteHistoryView | null>("loadRouteHistory", [routeKey(subject)], session))!;
    assert.ok(history, "history is readable with content.view");
    assert.ok((await discard())?.ok);
    // A version to restore: the owner publishes once.
    assert.ok((await saveValues(target, (values) => ({ ...values, timeline: { en: "Published for a restore", ar: "" } })))?.ok);
    assert.ok((await publish())?.ok);
    const [version] = await sql<{ id: number }[]>`select id from route_versions where route_key = ${routeKey(subject)} order by id limit 1`;
    assert.ok(version, "the subject has a version to restore");
    const restored = await routeAction<RouteActionResult>(
      "restoreRouteFromEditor",
      [formOf({ routeKey: routeKey(subject), token: (await summary()).token, versionId: version.id }, session)],
      session,
    );
    assert.equal(restored?.ok, false);
    assert.equal(await nodeRow(`serviceHero:${subject.id}`).then((row) => row?.draft_content ?? null), null, "nothing was restored");
  });

  test("an editor with content and services rights edits; without content.publish they cannot publish", async () => {
    const session = await as([...READ, "content.edit", "services.manage"]);
    assert.ok((await saveValues(at("serviceHero"), (values) => ({ ...values, timeline: { en: "By the editor", ar: "" } }), session))?.ok);
    const refused = await publish(session);
    assert.equal(refused?.ok, false);
    assert.equal((await serviceRow(subject.id))!.timeline_en === "By the editor", false);
    // Nor discard, nor restore: both need content.publish too.
    assert.equal((await discard(session))?.ok, false);
    const [version] = await sql<{ id: number }[]>`select id from route_versions where route_key = ${routeKey(subject)} order by id limit 1`;
    const restored = await routeAction<RouteActionResult>(
      "restoreRouteFromEditor",
      [formOf({ routeKey: routeKey(subject), token: (await summary()).token, versionId: version!.id }, session)],
      session,
    );
    assert.equal(restored?.ok, false);
    const owned = await as([...READ, "content.edit", "services.manage", "content.publish"]);
    assert.ok((await publish(owned))?.ok);
    assert.equal((await serviceRow(subject.id))!.timeline_en, "By the editor");
  });

  test("without services.manage, content is refused and publishing it is refused — styling is still allowed", async () => {
    const session = await as([...READ, "content.edit", "content.style", "content.publish"]);
    const target = at("serviceHero");
    const current = await region(target);
    const words = await save("saveRouteRegionDraft", target, current.revision, "values", { ...current.values, timeline: { en: "No", ar: "" } }, session);
    assert.equal(words?.ok, false);
    assert.match(String(words?.message), /services/);
    const styled = await save("saveRouteRegionStyles", target, current.revision, "styles", { v: STYLE_DOCUMENT_VERSION, nodes: {} }, session);
    assert.ok(styled?.ok, styled?.message);
    assert.ok((await saveValues(target, (values) => ({ ...values, timeline: { en: "Owner's words", ar: "" } })))?.ok);
    const refused = await publish(session);
    assert.equal(refused?.ok, false);
    assert.match(refused && !refused.ok ? refused.message : "", /services/);
    assert.ok((await discard())?.ok);
  });

  test("hiding a question needs content.structure", async () => {
    const [question] = await ownFaqs();
    const target: RouteOwner = { type: "faq", id: question!.id };
    const noLayout = await as([...READ, "content.edit", "faqs.manage"]);
    const current = await region(target);
    const hidden = await save("saveRouteRegionDraft", target, current.revision, "values", { ...current.values, published: false }, noLayout);
    assert.equal(hidden?.ok, false);
    const layout = await as([...READ, "content.structure", "faqs.manage"]);
    const allowed = await save("saveRouteRegionDraft", target, current.revision, "values", { ...current.values, published: false }, layout);
    assert.ok(allowed?.ok, allowed?.message);
    assert.ok((await discard())?.ok);
  });

  test("a form without the session's token is refused before anything is read", async () => {
    const target = at("serviceHero");
    const current = await region(target);
    const forged = await save("saveRouteRegionDraft", target, current.revision, "values", current.values, owner, subject, "not-the-token");
    assert.equal(forged?.ok, false);
    assert.match(String(forged?.message), /expired/);
    const missing = await save("saveRouteRegionDraft", target, current.revision, "values", current.values, owner, subject, null);
    assert.equal(missing?.ok, false);
    assert.equal(await nodeRow(`serviceHero:${subject.id}`).then((row) => row?.draft_content ?? null), null);
  });

  test("signed out, every read and write answers with nothing", async () => {
    const anonymous = { cookie: "", csrfToken: "x", userId: 0 };
    const answer = await routeAction<VisualSectionLoad>("loadRouteRegion", [keyOf(at("serviceHero")), pageOf(subject)], anonymous);
    assert.equal(answer?.ok, false);
    assert.equal(await routeAction("loadRouteSummary", [routeKey(subject)], anonymous), null);
    assert.equal(await routeAction("loadRouteHistory", [routeKey(subject)], anonymous), null);
    const published = await routeAction<RouteActionResult>("publishRouteFromEditor", [formOf({ routeKey: routeKey(subject), token: "" }, anonymous)], anonymous);
    assert.equal(published?.ok, false);
    assert.equal((await html("/admin/visual-editor")).includes("service:"), false);
  });
});

describe("reusable components stay out of a service page", () => {
  test("a service page region cannot be made into a reusable component", async () => {
    const before = await sql<{ n: number }[]>`select count(*)::int as n from reusable_components`;
    const answer = await actionOf<Answer>(
      COMPONENT_ACTIONS,
      "/admin/visual-editor",
      "createReusableFromSection",
      [formOf({ sectionId: keyOf(at("serviceOverview")), pageId: pageOf(subject), name: "Not allowed", publish: "0" }, owner)],
      owner,
    );
    assert.equal(answer?.ok, false);
    const afterCount = await sql<{ n: number }[]>`select count(*)::int as n from reusable_components`;
    assert.equal(afterCount[0]!.n, before[0]!.n);
  });
});

describe("the rest of the admin keeps working", () => {
  test("the Services screen still saves every field, live, as before", async () => {
    const answer = await servicesForm(third.id, {
      benefits: JSON.stringify([{ en: "From the form", ar: "" }]),
      processSteps: JSON.stringify([{ en: "Form step", ar: "", detailEn: "", detailAr: "" }]),
    });
    assert.ok(answer?.ok, answer?.message);
    const row = (await serviceRow(third.id))!;
    assert.deepEqual(row.benefits, [{ en: "From the form", ar: "" }]);
    assert.ok((await publicPage(third)).includes("From the form"));
  });

  test("the category page's editor still publishes its own drafts", async () => {
    const categoryRoute = `category:${third.category_id}`;
    const pageOfCategory = documentEditorKey({ kind: "category", id: third.category_id });
    const hero = await routeAction<VisualSectionLoad>("loadRouteRegion", [keyOf({ type: "category", id: third.category_id }), pageOfCategory]);
    assert.ok(hero?.ok);
    const saved = await routeAction<Answer>("saveRouteRegionDraft", [
      formOf(
        {
          sectionId: keyOf({ type: "category", id: third.category_id }),
          pageId: pageOfCategory,
          expectedRevision: hero.section.revision,
          values: JSON.stringify({ ...hero.section.values, tagline: { en: "Category still edits", ar: "" } }),
        },
        owner,
      ),
    ]);
    assert.ok(saved?.ok, saved?.message);
    const view = await routeAction<RouteSummaryView | null>("loadRouteSummary", [categoryRoute]);
    assert.equal(view?.kind, "category");
    const published = await routeAction<RouteActionResult>("publishRouteFromEditor", [formOf({ routeKey: categoryRoute, token: view!.token }, owner)]);
    assert.ok(published?.ok);
    const [category] = await sql<{ tagline_en: string }[]>`select tagline_en from service_categories where id = ${third.category_id}`;
    assert.equal(category!.tagline_en, "Category still edits");
  });
});

describe("the server said nothing wrong", () => {
  test("no render error, digest or unhandled failure was logged while all of this ran", () => {
    const said = [...earlierLogs, server.log()].join("\n");
    const wrong = said.split("\n").filter((line) => /⨯|digest:|Unhandled|TypeError|ReferenceError|RangeError/.test(line));
    assert.deepEqual(wrong, []);
  });
});
