/**
 * Batch 24: packages, destinations, the package catalogue and the services
 * overview in the Visual Editor, against a real server and a real database.
 *
 * What these hold, in the brief's words: every package and destination
 * discovered from the database (one created after the build included, with no
 * code); the real routes in the canvas in both editions; drafts that never
 * touch the live records, their public pages, their metadata, their structured
 * data or their RSC payloads; atomic publication that refuses on any conflict
 * and writes only what changed; two pages that share a record's columns and
 * never overwrite each other silently; the Packages and Destinations screens
 * against a publication; history, compare and restore-to-draft; a rename, a
 * destination's new address, a package re-filed, a package and a destination
 * deleted; permissions and CSRF on every action; the media guard; the category
 * page's ItemList; the footer line; and the rest of the site still working.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { callAction } from "./helpers/action";
import { giveFresh } from "./helpers/fixtures";
import { formContaining, get, submitForm } from "./helpers/http";
import { openDestinationForm, openPackageForm, withChanges, type FormFields } from "./helpers/package-form";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { BUILD_HINT, isBuilt, startServer, type Server } from "./helpers/server";
import { signIn, type TestSession } from "./helpers/session";

import type { PermissionKey } from "@/lib/auth/permissions";
import { STYLE_DOCUMENT_VERSION } from "@/lib/cms/styles";
import { documentEditorKey, editorKeyOf, type RouteDocument, type RouteOwner } from "@/lib/routes/owners";
import type { RouteActionResult, RouteCompareView, RouteHistoryView, RouteSummaryView } from "@/lib/routes/views";
import type { VisualContentSaveResult, VisualSectionLoad } from "@/lib/visual-editor/content";

const PORT = 3510;
const ROUTE_ACTIONS = "app/(backoffice)/admin/visual-editor/route-actions.ts";
const PACKAGE_ACTIONS = "app/(backoffice)/admin/(shell)/packages/actions.ts";
const DESTINATION_ACTIONS = "app/(backoffice)/admin/(shell)/packages/destinations/actions.ts";
const MEDIA_ACTIONS = "app/(backoffice)/admin/(shell)/media/actions.ts";
const SETTINGS_ACTIONS = "app/(backoffice)/admin/(shell)/settings/actions.ts";
const BRIDGE = "0123456789abcdef0123456789abcdef";
const REFRESH = "/admin/settings?tab=maintenance";

let database = "";
let sql: Sql;
let server: Server;
let owner: TestSession;
let actor: TestSession;
let editorRoleId = 0;
const earlierLogs: string[] = [];

type Pkg = { id: number; slug: string; title_en: string; title_ar: string; destination_id: number | null };
type Dest = { id: number; slug: string; title_en: string };
/** Chosen from the data, never by name. */
let subject: Pkg;
let second: Pkg;
let loose: Pkg;
let home: Dest;
/** A second destination, made for the test before the server starts, holding nothing yet. */
let spare: Dest;

type Answer = { ok: boolean; reason?: string; message?: string; conflicts?: string[]; [key: string]: unknown };

const CATALOGUE: RouteDocument = { kind: "packageIndex", id: 1 };
const OVERVIEW: RouteDocument = { kind: "serviceIndex", id: 1 };
const asPackage = (row: { id: number }): RouteDocument => ({ kind: "package", id: row.id });
const asDestination = (row: { id: number }): RouteDocument => ({ kind: "destination", id: row.id });

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

const pageOf = (doc: RouteDocument) => documentEditorKey(doc);
const routeKey = (doc: RouteDocument) => `${doc.kind}:${doc.id}`;

async function load(target: RouteOwner, doc: RouteDocument, session = owner) {
  const answer = await routeAction<VisualSectionLoad>("loadRouteRegion", [editorKeyOf(target), pageOf(doc)], session);
  assert.ok(answer, "the load answered with nothing");
  return answer;
}

async function region(target: RouteOwner, doc: RouteDocument) {
  const answer = await load(target, doc);
  assert.ok(answer.ok, `load ${target.type}:${target.id}: ${!answer.ok ? answer.message : ""}`);
  return answer.section;
}

const save = (
  action: "saveRouteRegionDraft" | "saveRouteRegionStyles" | "saveRouteRegionMotion",
  target: RouteOwner,
  doc: RouteDocument,
  revision: number,
  field: string,
  payload: unknown,
  session = owner,
  csrf?: string | null,
) =>
  routeAction<VisualContentSaveResult & Answer>(
    action,
    [
      formOf(
        { sectionId: editorKeyOf(target), pageId: pageOf(doc), expectedRevision: revision, [field]: JSON.stringify(payload) },
        session,
        csrf === undefined ? session.csrfToken : csrf,
      ),
    ],
    session,
  );

async function saveValues(
  target: RouteOwner,
  doc: RouteDocument,
  change: (values: Record<string, unknown>) => Record<string, unknown>,
  session = owner,
) {
  const current = await region(target, doc);
  return save("saveRouteRegionDraft", target, doc, current.revision, "values", change(current.values), session);
}

const summary = async (doc: RouteDocument, session = owner) => {
  const view = await routeAction<RouteSummaryView | null>("loadRouteSummary", [routeKey(doc)], session);
  assert.ok(view, `no summary for ${routeKey(doc)}`);
  return view;
};

const routeForm = async (action: string, doc: RouteDocument, extra: Record<string, string | number> = {}, session = owner) => {
  const token = (await summary(doc)).token;
  return routeAction<RouteActionResult>(action, [formOf({ routeKey: routeKey(doc), token, ...extra }, session)], session);
};

const publish = (doc: RouteDocument, session = owner) => routeForm("publishRouteFromEditor", doc, {}, session);
const discard = (doc: RouteDocument, session = owner) => routeForm("discardRouteFromEditor", doc, {}, session);
const failure = (answer: RouteActionResult | null | undefined) => (answer && !answer.ok ? answer : null);

async function resolve(target: RouteOwner, doc: RouteDocument, field: string, choice: "mine" | "live") {
  const now = await region(target, doc);
  return routeAction<VisualContentSaveResult>("resolveRouteConflict", [
    formOf({ sectionId: editorKeyOf(target), pageId: pageOf(doc), expectedRevision: now.revision, field, choice }, owner),
  ]);
}

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

const packageRow = async (id: number) => (await sql<Record<string, unknown>[]>`select * from travel_packages where id = ${id}`)[0];
const destinationRow = async (id: number) => (await sql<Record<string, unknown>[]>`select * from package_destinations where id = ${id}`)[0];
const nodeRow = async (ownerKey: string) =>
  (await sql<Record<string, unknown>[]>`select * from route_nodes where owner_key = ${ownerKey}`)[0] ?? null;
const packagePath = async (id: number) => `/packages/${(await packageRow(id))!.slug as string}`;
const destinationPath = async (id: number) => `/packages/${(await destinationRow(id))!.slug as string}`;

async function resetRoutes() {
  await sql`delete from route_nodes`;
  await sql`delete from route_versions`;
}

const html = async (path: string, session?: TestSession) => (await get(server.origin, path, session ? { cookie: session.cookie } : {})).html;
const statusOf = async (path: string, session?: TestSession) => (await get(server.origin, path, session ? { cookie: session.cookie } : {})).status;
const preview = (path: string) => html(`${path}${path.includes("?") ? "&" : "?"}preview=1`, owner);
const canvas = (path: string) => html(`${path}?preview=1&editor=1&bridge=${BRIDGE}`, owner);
const addresses = (markup: string) => [...markup.matchAll(/data-eod-address="([^"]+)"/g)].map((m) => m[1]!);
const jsonLd = (markup: string): Record<string, unknown>[] =>
  [...markup.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)].flatMap((m) => {
    const parsed = JSON.parse(m[1]!) as unknown;
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [parsed as Record<string, unknown>];
  });
const ofType = (markup: string, type: string) => jsonLd(markup).find((entry) => entry["@type"] === type);
const titleOf = (markup: string) => /<title>([^<]*)<\/title>/.exec(markup)?.[1] ?? "";
/** A record's text as React writes it into a page: `Cairo & Giza` is `Cairo &amp; Giza` there. */
const inHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");

/** The page's React Server Components payload, as the client router asks for it. */
async function rsc(path: string, session?: TestSession) {
  const response = await fetch(`${server.origin}${path}`, {
    headers: { RSC: "1", ...(session ? { cookie: session.cookie } : {}) },
    redirect: "manual",
  });
  return { status: response.status, type: response.headers.get("content-type") ?? "", body: await response.text() };
}

/** Presses Settings → Maintenance → Refresh caches, after a direct database change. */
async function refreshCaches() {
  const page = await get(server.origin, REFRESH, { cookie: owner.cookie });
  const form = formContaining(page.html, "Refresh caches");
  const result = await submitForm(server.origin, REFRESH, form, owner.cookie);
  assert.match(result.html, /Every cache was dropped/);
}

/** The Packages screen's update, posted as the form posts it: every field, its base, and `changes`. */
const packagesForm = async (id: number, changes: Record<string, string | number | null> = {}, opened?: FormFields) =>
  actionOf<Answer>(
    PACKAGE_ACTIONS,
    `/admin/packages/${id}`,
    "updatePackage",
    [{ ok: false }, formOf(withChanges(opened ?? (await openPackageForm(sql, server.origin, owner.cookie, id)), changes), owner)],
    owner,
  );

const destinationsForm = async (id: number, changes: Record<string, string | number | null> = {}, opened?: FormFields) =>
  actionOf<Answer>(
    DESTINATION_ACTIONS,
    `/admin/packages/destinations/${id}`,
    "updateDestination",
    [{ ok: false }, formOf(withChanges(opened ?? (await openDestinationForm(sql, server.origin, owner.cookie, id)), changes), owner)],
    owner,
  );

/** A package made the way an admin makes one: through the Packages screen. */
async function createPackageViaScreen(slug: string, title: string, destinationId: number | "" = "") {
  await callAction({
    origin: server.origin,
    route: "/admin/packages/new",
    file: PACKAGE_ACTIONS,
    action: "createPackage",
    args: [
      { ok: false },
      formOf(
        {
          slug,
          region: "international",
          destinationId,
          titleEn: title,
          titleAr: "برنامج جديد",
          summaryEn: "Created after the build.",
          highlights: "[]",
          sortOrder: 50,
          isPublished: "on",
        },
        owner,
      ),
    ],
    cookie: owner.cookie,
  });
  const [row] = await sql<{ id: number }[]>`select id from travel_packages where slug = ${slug}`;
  assert.ok(row, "the Packages screen created the package");
  return row.id;
}

async function deletePackageViaScreen(id: number) {
  await callAction({
    origin: server.origin,
    route: `/admin/packages/${id}`,
    file: PACKAGE_ACTIONS,
    action: "deletePackage",
    args: [{ ok: false }, formOf({ id }, owner)],
    cookie: owner.cookie,
  });
  assert.equal(await packageRow(id), undefined, "the Packages screen deleted the package");
}

async function createDestinationViaScreen(slug: string, title: string) {
  await callAction({
    origin: server.origin,
    route: "/admin/packages/destinations/new",
    file: DESTINATION_ACTIONS,
    action: "createDestination",
    args: [{ ok: false }, formOf({ slug, titleEn: title, titleAr: "وجهة", summaryEn: "", sortOrder: 9, isPublished: "on" }, owner)],
    cookie: owner.cookie,
  });
  const [row] = await sql<{ id: number }[]>`select id from package_destinations where slug = ${slug}`;
  assert.ok(row, "the Destinations screen created the destination");
  return row.id;
}

async function deleteDestinationViaScreen(id: number) {
  await callAction({
    origin: server.origin,
    route: `/admin/packages/destinations/${id}`,
    file: DESTINATION_ACTIONS,
    action: "deleteDestination",
    args: [{ ok: false }, formOf({ id }, owner)],
    cookie: owner.cookie,
  });
  assert.equal(await destinationRow(id), undefined, "the Destinations screen deleted the destination");
}

const deleteMedia = (id: number) =>
  actionOf<Answer>(MEDIA_ACTIONS, "/admin/media", "deleteMedia", [{ ok: false }, formOf({ id }, owner)], owner);
const newMedia = async (name: string) =>
  (await sql<{ id: number }[]>`
    insert into media (filename, mime_type, title, width, height) values (${`${name}.webp`}, 'image/webp', ${name}, 800, 600) returning id`)[0]!.id;

/* -------------------------------------------------------------------------- */

before(async () => {
  assert.ok(isBuilt(), BUILD_HINT);
  database = giveFresh("package_editor");
  sql = connect(database);
  owner = await signIn(sql);
  const [role] = await sql<{ id: number }[]>`select id from roles where key = 'editor'`;
  editorRoleId = role!.id;
  await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    select 'package-actor@test.invalid', 'Package Actor', 'unused', id, true from roles where key = 'editor'`;
  actor = await signIn(sql, "editor");

  // A published destination that holds at least two published packages, and its first two.
  const [found] = await sql<Dest[]>`
    select d.id, d.slug, d.title_en from package_destinations d
     where d.is_published and (select count(*) from travel_packages p where p.destination_id = d.id and p.is_published) >= 2
     order by d.sort_order, d.id limit 1`;
  assert.ok(found, "the fixture has a destination with two published packages");
  home = { ...found };
  const inHome = await sql<Pkg[]>`
    select id, slug, title_en, title_ar, destination_id from travel_packages
     where destination_id = ${home.id} and is_published order by sort_order, id`;
  [subject, second] = inHome.map((row) => ({ ...row })) as [Pkg, Pkg];
  const [unfiled] = await sql<Pkg[]>`
    select id, slug, title_en, title_ar, destination_id from travel_packages
     where destination_id is null and is_published order by sort_order, id limit 1`;
  assert.ok(unfiled, "the fixture has a published package filed under no destination");
  loose = { ...unfiled };
  // Made before the server starts, so no cache has seen the catalogue without it.
  const [made] = await sql<Dest[]>`
    insert into package_destinations (slug, title_en, title_ar, summary_en, sort_order, is_published)
    values ('a-second-destination-for-the-test', 'Second Test Destination', 'وجهة ثانية', 'Made for the test.', 50, true)
    returning id, slug, title_en`;
  spare = { ...made! };

  server = await startServer(database, PORT);
});

after(async () => {
  await server?.stop();
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
});

/* ========================================================================== */

describe("discovery: every package and destination, from the database", () => {
  test("the editor lists both overviews, every destination and every package under its destination", async () => {
    const page = await html("/admin/visual-editor", owner);
    assert.ok(page.includes('value="packageIndex:1"'));
    assert.ok(page.includes('value="serviceIndex:1"'));
    assert.match(page, /<optgroup label="Overviews"/);
    const destinations = await sql<{ id: number }[]>`select id from package_destinations`;
    for (const row of destinations) assert.ok(page.includes(`value="destination:${row.id}"`), `destination ${row.id}`);
    assert.match(page, /<optgroup label="Destinations"/);
    const packages = await sql<{ id: number; destination: string | null }[]>`
      select p.id, d.title_en as destination from travel_packages p left join package_destinations d on d.id = p.destination_id`;
    for (const row of packages) assert.ok(page.includes(`value="package:${row.id}"`), `package ${row.id}`);
    for (const group of new Set(packages.map((row) => row.destination ?? "No destination"))) {
      assert.ok(page.includes(`label="Packages · ${group.replace(/&/g, "&amp;")}"`), `${group} has a group`);
    }
    // The page CMS and the service routes are still there.
    assert.match(page, /<optgroup label="Pages"/);
    assert.match(page, /<optgroup label="Service Categories"/);
  });

  test("?route= opens a package, a destination or an overview; a key that names nothing is never a canvas", async () => {
    const initialOf = (markup: string) => /\\"initial\\":\{\\"slug\\":\\"([^\\]+)\\"/.exec(markup)?.[1];
    for (const key of [`package:${subject.id}`, `destination:${home.id}`, "packageIndex:1", "serviceIndex:1"]) {
      assert.equal(initialOf(await html(`/admin/visual-editor?route=${key}`, owner)), key);
    }
    for (const bad of ["package:999999", "packageIndex:2", "serviceIndex:0", `destination:${home.slug}`, `package:${subject.slug}`]) {
      const opened = initialOf(await html(`/admin/visual-editor?route=${encodeURIComponent(bad)}`, owner));
      assert.ok(opened && opened !== bad, `${bad} opened ${opened}`);
    }
  });
});

describe("the real pages in the canvas, and nothing of the editor anywhere else", () => {
  const publicPaths = async () => [
    "/packages",
    "/ar/packages",
    await destinationPath(home.id),
    `/ar${await destinationPath(home.id)}`,
    await packagePath(subject.id),
    `/ar${await packagePath(subject.id)}`,
    "/services",
    "/ar/services",
  ];

  test("every public page carries no editor attribute, bridge or placeholder — and keeps its landing atmosphere", async () => {
    for (const path of await publicPaths()) {
      const page = await html(path);
      assert.equal(page.includes("data-eod-"), false, path);
      assert.equal(page.includes("bridgeId"), false, path);
      assert.equal(page.includes("route-placeholder"), false, path);
      assert.equal(page.includes("Select this section"), false, path);
    }
    for (const path of ["/packages", "/services", await destinationPath(home.id)]) {
      assert.match(await html(path), /data-atmosphere="landing"/, path);
    }
  });

  test("the parameters alone grant nothing", async () => {
    for (const path of await publicPaths()) {
      const page = await html(`${path}?preview=1&editor=1&bridge=${BRIDGE}`);
      assert.equal(page.includes("data-eod-"), false, path);
      assert.equal(page.includes("bridgeId"), false, path);
    }
    assert.equal((await html("/packages?compare=published")).includes("data-eod-"), false);
  });

  test("a preview, a canvas or a comparison is private and never indexed — whoever asks", async () => {
    const headers = async (target: string, cookie?: string) => {
      const response = await fetch(`${server.origin}${target}`, { headers: cookie ? { cookie } : {}, redirect: "manual" });
      await response.arrayBuffer();
      return { robots: response.headers.get("x-robots-tag"), cache: response.headers.get("cache-control") };
    };
    for (const path of ["/packages", await packagePath(subject.id), await destinationPath(home.id), "/services"]) {
      for (const cookie of [owner.cookie, undefined]) {
        for (const target of [`${path}?preview=1`, `${path}?preview=1&editor=1&bridge=${BRIDGE}`, `${path}?compare=published`]) {
          const answered = await headers(target, cookie);
          assert.equal(answered.robots, "noindex, nofollow, noarchive", target);
          assert.equal(answered.cache, "private, no-store, max-age=0", target);
        }
      }
      assert.equal((await headers(path)).robots, null, path);
    }
  });

  test("a package's canvas marks every region by the package's id, and draws empty sections to write into", async () => {
    const page = await canvas(await packagePath(subject.id));
    const marked = addresses(page);
    for (const address of [
      `packageHero:${subject.id}`,
      `packageHero:${subject.id}/field:title`,
      `packageHero:${subject.id}/field:place`,
      `packageHero:${subject.id}/field:eyebrow`,
      `packageHero:${subject.id}/field:ctaLabel`,
      `packageCrumbs:${subject.id}`,
      `packageBody:${subject.id}`,
      `packageHighlights:${subject.id}/field:heading`,
      `packageRequest:${subject.id}/field:heading`,
      `packageRequest:${subject.id}/field:form`,
    ]) {
      assert.ok(marked.includes(address), address);
    }
    assert.ok(page.includes("bridgeId"));
  });

  test("the catalogue's canvas marks its own regions, a group per destination and a card per package", async () => {
    const page = await canvas("/packages");
    const marked = addresses(page);
    for (const address of [
      "packageIndexHero:1/field:eyebrow",
      "packageIndexHero:1/field:heading",
      "packageIndexCrumbs:1",
      "packageIndexCatalogue:1",
      `destinationGroup:${home.id}/field:title`,
      `destinationGroup:${home.id}/field:linkLabel`,
      `packageCard:${subject.id}/field:title`,
      `packageCard:${subject.id}/field:link`,
      `packageCard:${loose.id}/field:title`,
      "packageIndexCustom:1/field:heading",
    ]) {
      assert.ok(marked.includes(address), address);
    }
    // A destination holding nothing is not a group on the catalogue.
    assert.equal(marked.some((address) => address.startsWith(`destinationGroup:${spare.id}`)), false);
  });

  test("a destination's canvas and the services overview's mark their own regions", async () => {
    const destination = addresses(await canvas(await destinationPath(home.id)));
    for (const address of [`destinationHero:${home.id}/field:title`, `destinationHero:${home.id}/field:eyebrow`, `destinationCrumbs:${home.id}`, `destinationPackages:${home.id}/field:cards`, `destinationPackages:${home.id}/field:backLabel`]) {
      assert.ok(destination.includes(address), address);
    }
    // The cards on a destination's page are the catalogue's: not addressed here.
    assert.equal(destination.some((address) => address.startsWith("packageCard:")), false);
    const overview = addresses(await canvas("/services"));
    for (const address of ["serviceIndexHero:1/field:heading", "serviceIndexCrumbs:1", "serviceIndexCategories:1/field:categories"]) {
      assert.ok(overview.includes(address), address);
    }
  });

  test("the Arabic canvases are the real /ar routes, RTL, with the same addresses", async () => {
    for (const path of ["/packages", await packagePath(subject.id), await destinationPath(home.id), "/services"]) {
      const english = addresses(await canvas(path));
      const arabic = await canvas(`/ar${path}`);
      assert.match(arabic, /<html[^>]*lang="ar"[^>]*dir="rtl"|<html[^>]*dir="rtl"[^>]*lang="ar"/, path);
      assert.deepEqual(addresses(arabic).sort(), english.sort(), path);
    }
  });
});

describe("drafts never touch the live records", () => {
  before(resetRoutes);

  test("a package title draft is a patch with its starting point; the row is untouched", async () => {
    const saved = await saveValues({ type: "packageHero", id: subject.id }, asPackage(subject), (values) => ({
      ...values,
      title: { ...(values.title as object), en: "Draft Package Title" },
    }));
    assert.ok(saved?.ok, saved?.message);
    assert.equal((await packageRow(subject.id))!.title_en, subject.title_en);
    const node = await nodeRow(`packageHero:${subject.id}`);
    assert.deepEqual(node!.draft_content, { titleEn: { value: "Draft Package Title", base: subject.title_en } });
    assert.equal(node!.route_key, `package:${subject.id}`);
  });

  test("the public page, its title tag, its structured data and its RSC payload keep the live title; preview shows the draft", async () => {
    const path = await packagePath(subject.id);
    const live = await html(path);
    assert.equal(live.includes("Draft Package Title"), false);
    assert.equal(titleOf(live).includes("Draft Package Title"), false);
    assert.equal((ofType(live, "TouristTrip") as { name: string }).name, subject.title_en);
    const payload = await rsc(path);
    assert.equal(payload.status, 200);
    assert.match(payload.type, /text\/x-component/);
    assert.equal(payload.body.includes("Draft Package Title"), false);
    assert.equal(payload.body.includes("data-eod-"), false);
    // A signed-in request without the preview flag is still the public page.
    assert.equal((await rsc(path, owner)).body.includes("Draft Package Title"), false);

    const previewed = await preview(path);
    assert.ok(previewed.includes("Draft Package Title"));
    assert.equal((ofType(previewed, "TouristTrip") as { name: string }).name, "Draft Package Title");
    assert.equal(titleOf(previewed).includes("Draft Package Title"), false, "the <title> stays the published one");
    assert.ok((await canvas(path)).includes("Draft Package Title"));
  });

  test("Arabic is its own field: an Arabic edit leaves English alone and is not seeded from it", async () => {
    const hero = await region({ type: "packageHero", id: subject.id }, asPackage(subject));
    assert.equal((hero.values.title as { ar: string }).ar, subject.title_ar);
    const saved = await save("saveRouteRegionDraft", { type: "packageHero", id: subject.id }, asPackage(subject), hero.revision, "values", {
      ...hero.values,
      title: { en: "Draft Package Title", ar: "عنوان البرنامج التجريبي" },
    });
    assert.ok(saved?.ok, saved?.message);
    const path = await packagePath(subject.id);
    assert.ok((await preview(`/ar${path}`)).includes("عنوان البرنامج التجريبي"));
    assert.equal((await preview(path)).includes("عنوان البرنامج التجريبي"), false);
  });

  test("the description, the highlights and the request wording are drafts of the same row and of the page's copy", async () => {
    const doc = asPackage(subject);
    const results = [
      await saveValues({ type: "packageBody", id: subject.id }, doc, (values) => ({
        ...values,
        body: { en: '<p onclick="steal()">A described trip.<script>alert(1)</script></p>', ar: "" },
      })),
      await saveValues({ type: "packageHighlights", id: subject.id }, doc, (values) => ({
        ...values,
        heading: { en: "Included in the price", ar: "" },
        highlights: [{ text: { en: "Hotel transfers", ar: "تنقلات" } }, { text: { en: "", ar: "" } }],
      })),
      await saveValues({ type: "packageRequest", id: subject.id }, doc, (values) => ({
        ...values,
        heading: { en: "Ask about this trip", ar: "" },
      })),
      await saveValues({ type: "packageHero", id: subject.id }, doc, (values) => ({ ...values, ctaLabel: { en: "Plan my trip", ar: "" } })),
    ];
    for (const result of results) assert.ok(result?.ok, result?.message);
    const body = (await nodeRow(`packageBody:${subject.id}`))!.draft_content as Record<string, { value: string }>;
    assert.doesNotMatch(body.bodyEn!.value, /script|onclick/);
    const live = (await packageRow(subject.id))!;
    assert.equal(live.body_en, (await sql`select body_en from travel_packages where id = ${subject.id}`)[0]!.body_en);
    const path = await packagePath(subject.id);
    const previewed = await preview(path);
    for (const words of ["A described trip.", "Included in the price", "Hotel transfers", "Ask about this trip", "Plan my trip"]) {
      assert.ok(previewed.includes(words), words);
    }
    const page = await html(path);
    for (const words of ["A described trip.", "Hotel transfers", "Ask about this trip", "Plan my trip"]) {
      assert.equal(page.includes(words), false, words);
    }
    // The Arabic page shows the Arabic highlight, and the standard Arabic heading where none was written.
    const arabic = await preview(`/ar${path}`);
    assert.ok(arabic.includes("تنقلات"));
    assert.equal(arabic.includes("Included in the price"), false);
  });

  test("identity and generated content are never stored, whatever is sent", async () => {
    const hero = await region({ type: "packageHero", id: subject.id }, asPackage(subject));
    for (const name of ["slug", "region", "sortOrder", "eyebrow", "whatsapp"]) assert.equal(name in hero.values, false, name);
    const saved = await save("saveRouteRegionDraft", { type: "packageHero", id: subject.id }, asPackage(subject), hero.revision, "values", {
      ...hero.values,
      slug: "hijacked",
      region: "corporate",
      sortOrder: 99,
      whatsapp: "https://evil.example",
    });
    assert.ok(saved?.ok);
    const draft = JSON.stringify((await nodeRow(`packageHero:${subject.id}`))!.draft_content);
    for (const word of ["evil", "hijacked", "corporate", "sortOrder"]) assert.equal(draft.includes(word), false, word);
    assert.equal((await packageRow(subject.id))!.slug, subject.slug);
  });

  test("a stale revision is a conflict, answered with the version that won", async () => {
    const target: RouteOwner = { type: "packageHero", id: subject.id };
    const hero = await region(target, asPackage(subject));
    const first = await save("saveRouteRegionDraft", target, asPackage(subject), hero.revision, "values", { ...hero.values, duration: { en: "First writer.", ar: "" } });
    assert.ok(first?.ok);
    const later = await save("saveRouteRegionDraft", target, asPackage(subject), hero.revision, "values", { ...hero.values, duration: { en: "Second writer.", ar: "" } });
    assert.equal(later?.ok, false);
    assert.equal(later?.reason, "conflict");
    assert.match(JSON.stringify(later), /First writer\./);
  });

  test("another package's, a destination's or the catalogue's region cannot be written through a package's canvas", async () => {
    assert.equal((await load({ type: "packageHero", id: second.id }, asPackage(subject))).ok, false);
    assert.equal((await load({ type: "packageCard", id: subject.id }, asPackage(subject))).ok, false, "the card is the catalogue's");
    assert.equal((await load({ type: "destinationHero", id: home.id }, asPackage(subject))).ok, false);
    assert.equal((await load({ type: "packageHero", id: subject.id }, CATALOGUE)).ok, false, "the page's hero is not the catalogue's");
    const saved = await routeAction<Answer>("saveRouteRegionDraft", [
      formOf({ sectionId: editorKeyOf({ type: "packageHero", id: second.id }), pageId: pageOf(asPackage(subject)), expectedRevision: 0, values: "{}" }, owner),
    ]);
    assert.equal(saved?.ok, false);
    assert.equal(await nodeRow(`packageHero:${second.id}`), null);
  });

  test("catalogue drafts: a card re-filed, renamed and hidden, a group renamed, the hero's wording — in the preview only", async () => {
    const results = [
      await saveValues({ type: "packageCard", id: second.id }, CATALOGUE, (values) => ({
        ...values,
        group: String(spare.id),
        title: { ...(values.title as object), en: "Re-filed card" },
      })),
      await saveValues({ type: "packageCard", id: loose.id }, CATALOGUE, (values) => ({ ...values, published: false })),
      await saveValues({ type: "destinationGroup", id: home.id }, CATALOGUE, (values) => ({
        ...values,
        title: { ...(values.title as object), en: "Renamed Destination" },
        linkLabel: { en: "Every trip here", ar: "" },
      })),
      await saveValues({ type: "packageIndexHero", id: 1 }, CATALOGUE, (values) => ({
        ...values,
        heading: { en: "Trips we have prepared", ar: "" },
        eyebrow: { en: "", ar: "رحلات" },
      })),
    ];
    for (const result of results) assert.ok(result?.ok, result?.message);
    // Nothing live moved.
    assert.equal((await packageRow(second.id))!.destination_id, home.id);
    assert.equal((await packageRow(loose.id))!.is_published, true);
    assert.equal((await destinationRow(home.id))!.title_en, home.title_en);

    const previewed = await preview("/packages");
    for (const words of ["Re-filed card", "Second Test Destination", "Renamed Destination", "Every trip here", "Trips we have prepared"]) {
      assert.ok(previewed.includes(words), words);
    }
    assert.equal(previewed.includes(inHtml(loose.title_en)), false, "a hidden card is not in the preview");
    // The canvas draws the hidden card, dimmed, where it is filed.
    const drawn = await canvas("/packages");
    assert.match(drawn, new RegExp(`data-eod-address="packageCard:${loose.id}"[^>]*data-eod-hidden|data-eod-hidden[^>]*data-eod-address="packageCard:${loose.id}"`));
    // The Arabic eyebrow is Arabic; the English one is the standard English one.
    assert.ok((await preview("/ar/packages")).includes("رحلات"));
    assert.ok((await preview("/packages")).includes("Travel &amp; tourism"));
    // The public catalogue is untouched.
    const page = await html("/packages");
    for (const words of ["Re-filed card", "Renamed Destination", "Trips we have prepared"]) assert.equal(page.includes(words), false, words);
    assert.ok(page.includes(inHtml(loose.title_en)));
  });

  test("the services overview's wording is a draft of its own copy", async () => {
    const saved = await saveValues({ type: "serviceIndexHero", id: 1 }, OVERVIEW, (values) => ({
      ...values,
      heading: { en: "Every service, one desk", ar: "" },
    }));
    assert.ok(saved?.ok, saved?.message);
    assert.ok((await preview("/services")).includes("Every service, one desk"));
    assert.equal((await html("/services")).includes("Every service, one desk"), false);
    // The categories are generated: nothing of a category is the overview's to write.
    const rows = await region({ type: "serviceIndexCategories", id: 1 }, OVERVIEW);
    assert.deepEqual(Object.keys(rows.values), []);
  });

  test("styles and motion are drafts too; the breadcrumbs never move", async () => {
    const target: RouteOwner = { type: "packageHighlights", id: subject.id };
    const current = await region(target, asPackage(subject));
    const styled = await save("saveRouteRegionStyles", target, asPackage(subject), current.revision, "styles", {
      v: STYLE_DOCUMENT_VERSION,
      nodes: { "field:heading": { base: { textColor: "peach" }, mobile: { textColor: "strong" } }, "field:x": { base: { css: "x" } } },
    });
    assert.ok(styled?.ok, styled?.message);
    const crumbs = await region({ type: "packageCrumbs", id: subject.id }, asPackage(subject));
    const still = await save("saveRouteRegionMotion", { type: "packageCrumbs", id: subject.id }, asPackage(subject), crumbs.revision, "motionDocument", {
      v: 1,
      section: { base: { entrance: "fade-up" } },
      nodes: {},
    });
    assert.ok(still?.ok);
    assert.deepEqual((still as unknown as { motionDocument: { section: object } }).motionDocument.section, {});
    const node = await nodeRow(`packageHighlights:${subject.id}`);
    assert.ok(node!.draft_styles);
    assert.equal(JSON.stringify(node!.draft_styles).includes("css"), false);
    const count = (markup: string) => markup.match(/data-rs-m="/g)?.length ?? 0;
    const path = await packagePath(subject.id);
    assert.ok(count(await preview(path)) > count(await html(path)));
  });

  test("drafts survive a restart: they are rows, read again by a fresh server", async () => {
    earlierLogs.push(server.log());
    await server.stop();
    server = await startServer(database, PORT);
    assert.ok((await preview(await packagePath(subject.id))).includes("Draft Package Title"));
    assert.ok((await preview("/packages")).includes("Re-filed card"));
  });
});

describe("publish is atomic, guarded, audited and invalidates the caches", () => {
  test("a package's page publishes its patched columns, clears its drafts and records the version", async () => {
    const view = await summary(asPackage(subject));
    assert.equal(view.kind, "package");
    assert.equal(view.path, await packagePath(subject.id));
    assert.ok(view.publishable, JSON.stringify(view));
    const answer = await publish(asPackage(subject));
    assert.ok(answer?.ok, failure(answer)?.message);

    const row = (await packageRow(subject.id))!;
    assert.equal(row.title_en, "Draft Package Title");
    assert.equal(row.title_ar, "عنوان البرنامج التجريبي");
    assert.equal(row.duration_en, "First writer.");
    assert.match(String(row.body_en), /A described trip\./);
    assert.doesNotMatch(String(row.body_en), /script|onclick/);
    // A list is published as the Packages screen stores it: no empty rows.
    assert.deepEqual(row.highlights, [{ en: "Hotel transfers", ar: "تنقلات" }]);
    assert.equal(row.slug, subject.slug);
    assert.equal(row.destination_id, home.id);
    assert.equal((await nodeRow(`packageHero:${subject.id}`))!.draft_content, null);

    const versions = await sql<{ kind: string }[]>`select kind from route_versions where route_key = ${`package:${subject.id}`} order by id`;
    assert.deepEqual(versions.map((version) => version.kind), ["baseline", "publish"]);
    const [logged] = await sql<{ entity_type: string; entity_id: string }[]>`
      select entity_type, entity_id from activity_logs where action = 'route.published' order by id desc limit 1`;
    assert.deepEqual({ ...logged }, { entity_type: "package", entity_id: String(subject.id) });

    // The live page, its metadata and its structured data show it on the very next request.
    const live = await html(await packagePath(subject.id));
    for (const words of ["Draft Package Title", "A described trip.", "Included in the price", "Hotel transfers", "Ask about this trip", "Plan my trip", "First writer."]) {
      assert.ok(live.includes(words), words);
    }
    assert.ok(titleOf(live).includes("Draft Package Title"), titleOf(live));
    assert.equal((ofType(live, "TouristTrip") as { name: string }).name, "Draft Package Title");
    assert.equal(live.includes("data-eod-"), false);
    assert.ok((await html(`/ar${await packagePath(subject.id)}`)).includes("عنوان البرنامج التجريبي"));
  });

  test("the package cache is dropped: the catalogue's card and the destination's page show the new title at once", async () => {
    assert.ok((await html("/packages")).includes("Draft Package Title"));
    assert.ok((await html(await destinationPath(home.id))).includes("Draft Package Title"));
  });

  test("the catalogue publishes a re-filed card, a hidden card and a renamed group — and the pages follow", async () => {
    const view = await summary(CATALOGUE);
    assert.equal(view.kind, "packageIndex");
    assert.equal(view.path, "/packages");
    const answer = await publish(CATALOGUE);
    assert.ok(answer?.ok, failure(answer)?.message);
    assert.equal((await packageRow(second.id))!.destination_id, spare.id);
    assert.equal((await packageRow(second.id))!.title_en, "Re-filed card");
    assert.equal((await packageRow(loose.id))!.is_published, false);
    assert.equal((await destinationRow(home.id))!.title_en, "Renamed Destination");
    const [logged] = await sql<{ entity_type: string; entity_id: string }[]>`
      select entity_type, entity_id from activity_logs where action = 'route.published' order by id desc limit 1`;
    assert.deepEqual({ ...logged }, { entity_type: "route", entity_id: "packageIndex:1" });

    const catalogue = await html("/packages");
    for (const words of ["Re-filed card", "Second Test Destination", "Renamed Destination", "Every trip here", "Trips we have prepared"]) {
      assert.ok(catalogue.includes(words), words);
    }
    assert.equal(catalogue.includes(inHtml(loose.title_en)), false);
    // A hidden package's own page is hidden with it; the re-filed one is listed on its new destination's page.
    assert.equal(await statusOf(await packagePath(loose.id)), 404);
    assert.ok((await html(await destinationPath(spare.id))).includes("Re-filed card"));
    assert.equal((await html(await destinationPath(home.id))).includes("Re-filed card"), false);
    // The category page's packages panel reads the same catalogue.
    assert.ok((await html("/ar/packages")).includes("رحلات"));
  });

  test("a destination's page publishes its own row, under the destination", async () => {
    const doc = asDestination(home);
    assert.ok((await saveValues({ type: "destinationHero", id: home.id }, doc, (values) => ({ ...values, summary: { en: "A summary from the editor.", ar: "" }, eyebrow: { en: "Destination", ar: "" } })))?.ok);
    const answer = await publish(doc);
    assert.ok(answer?.ok, failure(answer)?.message);
    assert.equal((await destinationRow(home.id))!.summary_en, "A summary from the editor.");
    const [logged] = await sql<{ entity_type: string; entity_id: string }[]>`
      select entity_type, entity_id from activity_logs where action = 'route.published' order by id desc limit 1`;
    assert.deepEqual({ ...logged }, { entity_type: "destination", entity_id: String(home.id) });
    const page = await html(await destinationPath(home.id));
    assert.ok(page.includes("A summary from the editor."));
    assert.ok(page.includes(">Destination<"));
  });

  test("the services overview publishes its wording only, under the route", async () => {
    const answer = await publish(OVERVIEW);
    assert.ok(answer?.ok, failure(answer)?.message);
    assert.ok((await html("/services")).includes("Every service, one desk"));
    assert.ok((await html("/ar/services")).includes("كل ما تحتاجه — من مكتب واحد"), "Arabic keeps its standard heading");
    const [logged] = await sql<{ entity_type: string; entity_id: string }[]>`
      select entity_type, entity_id from activity_logs where action = 'route.published' order by id desc limit 1`;
    assert.deepEqual({ ...logged }, { entity_type: "route", entity_id: "serviceIndex:1" });
  });

  test("a package's page and its catalogue card share columns and never overwrite each other silently", async () => {
    assert.ok((await saveValues({ type: "packageCard", id: subject.id }, CATALOGUE, (values) => ({ ...values, summary: { en: "Card summary.", ar: "" } })))?.ok);
    assert.ok((await saveValues({ type: "packageHero", id: subject.id }, asPackage(subject), (values) => ({ ...values, summary: { en: "Page summary.", ar: "" } })))?.ok);
    assert.ok((await publish(asPackage(subject)))?.ok);
    assert.equal((await packageRow(subject.id))!.summary_en, "Page summary.");
    // The card's draft began from the old value: the catalogue says so, and refuses to publish over it.
    const view = await summary(CATALOGUE);
    assert.ok(view.conflicts >= 1 && !view.publishable, JSON.stringify(view));
    const refused = await publish(CATALOGUE);
    assert.equal(failure(refused)?.reason, "conflict");
    assert.equal((await packageRow(subject.id))!.summary_en, "Page summary.");
    // Taking the live value drops the field from the card's draft.
    const taken = await resolve({ type: "packageCard", id: subject.id }, CATALOGUE, "summaryEn", "live");
    assert.ok(taken?.ok);
    assert.equal((await nodeRow(`packageCard:${subject.id}`))!.draft_content, null);
  });

  test("a destination's page and its catalogue group share its name the same way", async () => {
    assert.ok((await saveValues({ type: "destinationGroup", id: home.id }, CATALOGUE, (values) => ({ ...values, title: { ...(values.title as object), en: "Group name" } })))?.ok);
    assert.ok((await saveValues({ type: "destinationHero", id: home.id }, asDestination(home), (values) => ({ ...values, title: { ...(values.title as object), en: "Page name" } })))?.ok);
    assert.ok((await publish(asDestination(home)))?.ok);
    assert.equal(failure(await publish(CATALOGUE))?.reason, "conflict");
    // Keeping the draft re-bases it: publishing then replaces the page's name, deliberately.
    const kept = await resolve({ type: "destinationGroup", id: home.id }, CATALOGUE, "titleEn", "mine");
    assert.ok(kept?.ok);
    assert.ok((await publish(CATALOGUE))?.ok);
    assert.equal((await destinationRow(home.id))!.title_en, "Group name");
  });

  test("a field saved on the Packages screen since the draft began blocks the whole publication", async () => {
    const doc = asPackage(subject);
    assert.ok((await saveValues({ type: "packageHero", id: subject.id }, doc, (values) => ({ ...values, place: { en: "Editor place", ar: "" } })))?.ok);
    assert.ok((await saveValues({ type: "packageHighlights", id: subject.id }, doc, (values) => ({ ...values, highlights: [{ text: { en: "Should not land", ar: "" } }] })))?.ok);
    const form = await packagesForm(subject.id, { destinationEn: "Form place" });
    assert.ok(form?.ok, form?.message);
    const blocked = await publish(doc);
    assert.equal(failure(blocked)?.reason, "conflict");
    // Nothing was written — not even the highlights, which had no conflict.
    const row = (await packageRow(subject.id))!;
    assert.deepEqual(row.highlights, [{ en: "Hotel transfers", ar: "تنقلات" }]);
    assert.equal(row.destination_en, "Form place");
    const kept = await resolve({ type: "packageHero", id: subject.id }, doc, "destinationEn", "mine");
    assert.ok(kept?.ok);
    assert.ok((await publish(doc))?.ok);
    const published = (await packageRow(subject.id))!;
    assert.equal(published.destination_en, "Editor place");
    assert.deepEqual(published.highlights, [{ en: "Should not land", ar: "" }]);
  });

  test("drafts that changed after review are not published unseen; discard removes the drafts and only the drafts", async () => {
    const doc = asPackage(subject);
    assert.ok((await saveValues({ type: "packageHero", id: subject.id }, doc, (values) => ({ ...values, duration: { en: "Reviewed", ar: "" } })))?.ok);
    const stale = (await summary(doc)).token;
    assert.ok((await saveValues({ type: "packageHero", id: subject.id }, doc, (values) => ({ ...values, duration: { en: "Changed after review", ar: "" } })))?.ok);
    const refused = await routeAction<RouteActionResult>("publishRouteFromEditor", [formOf({ routeKey: routeKey(doc), token: stale }, owner)]);
    assert.equal(failure(refused)?.reason, "stale");
    const before = await packageRow(subject.id);
    assert.ok((await discard(doc))?.ok);
    assert.equal((await nodeRow(`packageHero:${subject.id}`))!.draft_content, null);
    assert.deepEqual(await packageRow(subject.id), before);
  });
});

describe("the Packages and Destinations screens beside a publication", () => {
  test("a form opened before a publication keeps what it did not change, and is refused on what it did", async () => {
    const doc = asPackage(subject);
    const opened = await openPackageForm(sql, server.origin, owner.cookie, subject.id);
    assert.ok((await saveValues({ type: "packageHero", id: subject.id }, doc, (values) => ({ ...values, duration: { en: "Published by the editor", ar: "" } })))?.ok);
    assert.ok((await publish(doc))?.ok);
    // Non-overlap: the form changes the summary only; the editor's duration stays.
    const kept = await packagesForm(subject.id, { summaryEn: "Summary from the form." }, opened);
    assert.ok(kept?.ok, kept?.message);
    const row = (await packageRow(subject.id))!;
    assert.equal(row.duration_en, "Published by the editor");
    assert.equal(row.summary_en, "Summary from the form.");
    // Overlap: the same stale form changes the duration the editor published.
    const refused = await packagesForm(subject.id, { durationEn: "Stale form duration" }, opened);
    assert.equal(refused?.ok, false);
    assert.deepEqual(refused?.conflicts, ["durationEn"]);
    assert.equal((await packageRow(subject.id))!.duration_en, "Published by the editor");
  });

  test("a stale Packages form never re-files a package or reverses a hide made on the catalogue", async () => {
    const opened = await openPackageForm(sql, server.origin, owner.cookie, second.id);
    assert.ok((await saveValues({ type: "packageCard", id: second.id }, CATALOGUE, (values) => ({ ...values, group: String(home.id), featured: true })))?.ok);
    assert.ok((await publish(CATALOGUE))?.ok);
    const saved = await packagesForm(second.id, { durationEn: "From a stale form" }, opened);
    assert.ok(saved?.ok, saved?.message);
    const row = (await packageRow(second.id))!;
    assert.equal(row.destination_id, home.id);
    assert.equal(row.is_featured, true);
    assert.equal(row.duration_en, "From a stale form");
  });

  test("a form without a base this server signed is refused before anything is read", async () => {
    const opened = await openPackageForm(sql, server.origin, owner.cookie, subject.id);
    const { _base: _unused, ...withoutBase } = opened;
    void _unused;
    const refused = await packagesForm(subject.id, { summaryEn: "No base" }, withoutBase);
    assert.equal(refused?.ok, false);
    assert.match(String(refused?.message), /out of date/);
    const forged = await packagesForm(subject.id, { summaryEn: "Forged base", _base: `${String(opened._base).split(".")[0]}.AAAA` }, opened);
    assert.equal(forged?.ok, false);
    const another = await packagesForm(subject.id, { summaryEn: "Another package's base", _base: String((await openPackageForm(sql, server.origin, owner.cookie, second.id))._base) }, opened);
    assert.equal(another?.ok, false);
    assert.equal((await packageRow(subject.id))!.summary_en, "Summary from the form.");
  });

  test("a stale Destinations form never moves the address back, and keeps the editor's newer name", async () => {
    const opened = await openDestinationForm(sql, server.origin, owner.cookie, spare.id);
    assert.ok((await saveValues({ type: "destinationHero", id: spare.id }, asDestination(spare), (values) => ({ ...values, title: { ...(values.title as object), en: "Spare, renamed in the editor" } })))?.ok);
    assert.ok((await publish(asDestination(spare)))?.ok);
    const saved = await destinationsForm(spare.id, { summaryEn: "From the Destinations screen." }, opened);
    assert.ok(saved?.ok, saved?.message);
    const row = (await destinationRow(spare.id))!;
    assert.equal(row.title_en, "Spare, renamed in the editor");
    assert.equal(row.summary_en, "From the Destinations screen.");
    assert.equal(row.slug, spare.slug);
    const refused = await destinationsForm(spare.id, { titleEn: "Stale name" }, opened);
    assert.equal(refused?.ok, false);
    assert.deepEqual(refused?.conflicts, ["titleEn"]);
  });
});

describe("history, compare and restore", () => {
  test("each publication is listed with its actor and compares field by field", async () => {
    const history = await routeAction<RouteHistoryView | null>("loadRouteHistory", [`package:${subject.id}`]);
    assert.ok(history && history.versions.length >= 3);
    const first = history.versions.filter((version) => version.kind === "publish").at(-1)!;
    assert.ok(first.actorName);
    const changed = await routeAction<RouteCompareView | null>("loadRouteCompare", [`package:${subject.id}`, first.id, "previous"]);
    assert.ok(changed);
    const fields = changed.changes.map((change) => change.field);
    for (const field of ["Title (English)", "Title (Arabic)", "Highlights"]) assert.ok(fields.includes(field), field);
    const catalogue = await routeAction<RouteHistoryView | null>("loadRouteHistory", ["packageIndex:1"]);
    assert.ok(catalogue && catalogue.versions.some((version) => version.kind === "publish"));
  });

  test("a version is viewed by the real page, still and read-only", async () => {
    const history = (await routeAction<RouteHistoryView | null>("loadRouteHistory", [`package:${subject.id}`]))!;
    const baseline = history.versions.find((version) => version.kind === "baseline")!;
    const view = await html(`${await packagePath(subject.id)}?compare=v${baseline.id}`, owner);
    assert.ok(view.includes(inHtml(subject.title_en)), "the baseline shows the title as it was");
    assert.ok(view.includes("data-eod-still"));
    const [foreign] = await sql<{ id: number }[]>`insert into route_versions (route_key, kind, snapshot) values ('package:999999', 'publish', '{"v":1,"title":"x","owners":{}}') returning id`;
    assert.equal(await statusOf(`${await packagePath(subject.id)}?compare=v${foreign!.id}`, owner), 404);
  });

  test("restoring builds a draft, never touches live, never publishes, and refuses while drafts are pending", async () => {
    const doc = asPackage(subject);
    const history = (await routeAction<RouteHistoryView | null>("loadRouteHistory", [routeKey(doc)]))!;
    const baseline = history.versions.find((version) => version.kind === "baseline")!;
    const live = await packageRow(subject.id);
    const restored = await routeForm("restoreRouteFromEditor", doc, { versionId: baseline.id });
    assert.ok(restored?.ok, failure(restored)?.message);
    assert.deepEqual(await packageRow(subject.id), live);
    assert.equal((await html(await packagePath(subject.id))).includes(inHtml(subject.title_en)), false, "the public page still shows the published title");
    const draft = (await nodeRow(`packageHero:${subject.id}`))!.draft_content as Record<string, { value: unknown }>;
    assert.equal(draft.titleEn!.value, subject.title_en);
    const after = (await routeAction<RouteHistoryView | null>("loadRouteHistory", [routeKey(doc)]))!;
    assert.equal(after.versions.length, history.versions.length, "a restore is not a publication");
    const blocked = await routeForm("restoreRouteFromEditor", doc, { versionId: baseline.id });
    assert.equal(failure(blocked)?.reason, "blocked");
    assert.ok((await discard(doc))?.ok);
  });
});

describe("identity: renames, a destination's new address, a package re-filed", () => {
  test("a rename on the Packages screen is the same document, with its drafts", async () => {
    const doc = asPackage(second);
    assert.ok((await saveValues({ type: "packageRequest", id: second.id }, doc, (values) => ({ ...values, heading: { en: "Kept across renames", ar: "" } })))?.ok);
    const renamed = await packagesForm(second.id, { titleEn: "Renamed Package", titleAr: "برنامج معاد تسميته" });
    assert.ok(renamed?.ok, renamed?.message);
    const view = await summary(doc);
    assert.equal(view.title, "Renamed Package");
    assert.equal(view.routeKey, `package:${second.id}`);
    assert.ok(view.owners.some((entry) => entry.ownerKey === `packageRequest:${second.id}`));
    assert.ok((await preview(await packagePath(second.id))).includes("Kept across renames"));
    assert.ok((await preview(`/ar${await packagePath(second.id)}`)).includes("برنامج معاد تسميته"));
    assert.ok((await discard(doc))?.ok);
  });

  test("a destination's new address keeps its identity, drafts and history; the old address is gone", async () => {
    const doc = asDestination(spare);
    const oldPath = await destinationPath(spare.id);
    assert.ok((await saveValues({ type: "destinationHero", id: spare.id }, doc, (values) => ({ ...values, summary: { en: "Moving with its address", ar: "" } })))?.ok);
    const historyBefore = (await routeAction<RouteHistoryView | null>("loadRouteHistory", [routeKey(doc)]))!.versions.map((version) => version.id);
    const moved = await destinationsForm(spare.id, { slug: "a-moved-destination-for-the-test" });
    assert.ok(moved?.ok, moved?.message);
    const newPath = await destinationPath(spare.id);
    assert.equal(newPath, "/packages/a-moved-destination-for-the-test");
    const view = await summary(doc);
    assert.equal(view.path, newPath);
    assert.equal(view.routeKey, `destination:${spare.id}`);
    assert.ok((await canvas(newPath)).includes("Moving with its address"));
    assert.ok((await html(`/admin/visual-editor?route=destination:${spare.id}`, owner)).includes(newPath));
    assert.deepEqual((await routeAction<RouteHistoryView | null>("loadRouteHistory", [routeKey(doc)]))!.versions.map((version) => version.id), historyBefore);
    assert.equal(await statusOf(oldPath), 404);
    assert.equal(await statusOf(`/ar${oldPath}`), 404);
    assert.equal(await statusOf(newPath), 200);
    assert.ok((await publish(doc))?.ok);
    assert.ok((await html(newPath)).includes("Moving with its address"));
  });

  test("an address another record holds is refused by name, on either screen", async () => {
    const refused = await destinationsForm(spare.id, { slug: subject.slug });
    assert.equal(refused?.ok, false);
    assert.match(String(refused?.message), /already uses that address/);
    assert.equal((await destinationRow(spare.id))!.slug, "a-moved-destination-for-the-test");
  });
});

describe("a package created after the build", () => {
  test("is discovered, opens with every region, takes drafts in both languages, previews, publishes — with no code", async () => {
    const id = await createPackageViaScreen("a-package-created-after-the-build", "Created After The Build");
    const made = { id };
    const path = await packagePath(id);
    const editor = await html("/admin/visual-editor", owner);
    assert.ok(editor.includes(`value="package:${id}"`));
    assert.ok(editor.includes("Created After The Build"));
    const kinds = new Set(addresses(await canvas(path)).map((address) => address.split(":")[0]));
    for (const kind of ["packageHero", "packageCrumbs", "packageBody", "packageHighlights", "packageRequest"]) assert.ok(kinds.has(kind), kind);
    assert.ok(addresses(await canvas("/packages")).includes(`packageCard:${id}/field:title`), "the catalogue has its card");
    assert.ok((await saveValues({ type: "packageHero", id }, asPackage(made), (values) => ({ ...values, title: { en: "Created, then edited", ar: "أنشئ ثم حرر" } })))?.ok);
    assert.ok((await preview(`/ar${path}`)).includes("أنشئ ثم حرر"));
    assert.equal((await html(path)).includes("Created, then edited"), false);
    assert.ok((await publish(asPackage(made)))?.ok);
    assert.ok((await html(path)).includes("Created, then edited"));
    assert.ok((await html("/packages")).includes("Created, then edited"));
    await deletePackageViaScreen(id);
    assert.equal(await statusOf(path), 404);
  });
});

describe("deletion", () => {
  test("a deleted package's page closes everywhere; its catalogue card's draft goes with the next catalogue publication", async () => {
    const id = await createPackageViaScreen("a-package-deleted-with-drafts", "Deleted With Drafts", home.id);
    const gone = asPackage({ id });
    const path = await packagePath(id);
    assert.ok((await saveValues({ type: "packageHero", id }, gone, (values) => ({ ...values, duration: { en: "Published once", ar: "" } })))?.ok);
    assert.ok((await publish(gone))?.ok);
    assert.ok((await saveValues({ type: "packageHero", id }, gone, (values) => ({ ...values, duration: { en: "Left pending", ar: "" } })))?.ok);
    assert.ok((await saveValues({ type: "packageCard", id }, CATALOGUE, (values) => ({ ...values, summary: { en: "A card draft left behind", ar: "" } })))?.ok);
    const tokenBefore = (await summary(gone)).token;

    await deletePackageViaScreen(id);

    assert.equal((await load({ type: "packageHero", id }, gone)).ok, false);
    assert.equal(await routeAction("loadRouteSummary", [routeKey(gone)]), null);
    assert.equal(await routeAction("loadRouteHistory", [routeKey(gone)]), null);
    assert.equal((await routeAction<RouteActionResult>("publishRouteFromEditor", [formOf({ routeKey: routeKey(gone), token: tokenBefore }, owner)]))?.ok, false);
    assert.equal((await html("/admin/visual-editor", owner)).includes(`value="package:${id}"`), false);
    assert.equal(await statusOf(path), 404);
    assert.equal(await statusOf(`${path}?preview=1&editor=1&bridge=${BRIDGE}`, owner), 404);
    // Its history and its own pending draft are kept, dormant; the catalogue no longer draws its card.
    const [{ versions }] = await sql<{ versions: number }[]>`select count(*)::int as versions from route_versions where route_key = ${routeKey(gone)}`;
    assert.ok(versions >= 2);
    assert.ok(await nodeRow(`packageHero:${id}`));
    assert.equal((await summary(CATALOGUE)).owners.some((entry) => entry.ownerKey === `packageCard:${id}`), false);
    assert.ok(await nodeRow(`packageCard:${id}`), "the card's row waits for the catalogue's next publication");
    assert.ok((await saveValues({ type: "packageIndexHero", id: 1 }, CATALOGUE, (values) => ({ ...values, intro: { en: "Published after a deletion.", ar: "" } })))?.ok);
    assert.ok((await publish(CATALOGUE))?.ok);
    assert.equal(await nodeRow(`packageCard:${id}`), null, "removed by the catalogue's publication");
    // A package made afterwards is a new identity.
    const next = await createPackageViaScreen("a-package-made-after-a-deletion", "Made After A Deletion");
    assert.ok(next > id);
    assert.equal((await summary(asPackage({ id: next }))).owners.length, 0);
    await deletePackageViaScreen(next);
  });

  test("a deleted destination's page closes, its packages stay, and its catalogue group's draft goes with the next discard", async () => {
    const id = await createDestinationViaScreen("a-destination-deleted-with-drafts", "Deleted Destination");
    const doc = asDestination({ id });
    const path = await destinationPath(id);
    assert.ok((await saveValues({ type: "destinationHero", id }, doc, (values) => ({ ...values, summary: { en: "Pending", ar: "" } })))?.ok);
    assert.ok((await saveValues({ type: "destinationGroup", id }, CATALOGUE, (values) => ({ ...values, linkLabel: { en: "Never shown", ar: "" } })))?.ok);
    await deleteDestinationViaScreen(id);
    assert.equal(await routeAction("loadRouteSummary", [routeKey(doc)]), null);
    assert.equal(await statusOf(path), 404);
    assert.equal(await statusOf(`${path}?preview=1`, owner), 404);
    assert.ok(await nodeRow(`destinationGroup:${id}`));
    // A draft whose record is gone is ignored, and is no draft to discard on its own; the
    // catalogue's next publication or discard of anything removes it (dynamic-routes.md §7).
    assert.match(failure(await discard(CATALOGUE))?.message ?? "", /nothing to discard/);
    assert.ok((await saveValues({ type: "packageIndexHero", id: 1 }, CATALOGUE, (values) => ({ ...values, intro: { en: "To be discarded.", ar: "" } })))?.ok);
    assert.ok((await discard(CATALOGUE))?.ok);
    assert.equal(await nodeRow(`destinationGroup:${id}`), null, "removed by the catalogue's discard");
    assert.ok(await packageRow(subject.id), "no package went with it");
  });
});

describe("the media library's guard counts what drafts have chosen, and a destination's picture", () => {
  test("a package page's draft, a catalogue card's draft, a destination's draft and a destination's published picture", async () => {
    await resetRoutes();
    const [m1, m2, m3, m4] = [await newMedia("b24-package-draft"), await newMedia("b24-card-draft"), await newMedia("b24-destination-draft"), await newMedia("b24-destination-live")];
    assert.ok((await saveValues({ type: "packageHero", id: subject.id }, asPackage(subject), (values) => ({ ...values, image: m1 })))?.ok);
    const pageRefusal = await deleteMedia(m1);
    assert.equal(pageRefusal?.ok, false);
    assert.match(String(pageRefusal?.message), /package page draft/);
    assert.ok((await saveValues({ type: "packageCard", id: second.id }, CATALOGUE, (values) => ({ ...values, image: m2 })))?.ok);
    const cardRefusal = await deleteMedia(m2);
    assert.equal(cardRefusal?.ok, false);
    assert.match(String(cardRefusal?.message), /Tour packages page draft/);
    assert.ok((await saveValues({ type: "destinationHero", id: home.id }, asDestination(home), (values) => ({ ...values, image: m3 })))?.ok);
    assert.equal((await deleteMedia(m3))?.ok, false);
    // A destination's own, published picture (A.9 F3): placed, so not deletable.
    const placed = await destinationsForm(spare.id, { imageId: m4 });
    assert.ok(placed?.ok, placed?.message);
    const liveRefusal = await deleteMedia(m4);
    assert.equal(liveRefusal?.ok, false);
    assert.match(String(liveRefusal?.message), /Spare, renamed in the editor/);
    // Discarded drafts hold nothing; a picture taken off the destination is free again.
    assert.ok((await discard(asPackage(subject)))?.ok);
    assert.ok((await discard(CATALOGUE))?.ok);
    assert.ok((await discard(asDestination(home)))?.ok);
    assert.ok((await destinationsForm(spare.id, { imageId: "" }))?.ok);
    for (const id of [m1, m2, m3, m4]) assert.equal((await deleteMedia(id))?.ok, true, `picture ${id}`);
  });
});

describe("authority: every action asks again", () => {
  test("without packages.manage, a package's, a destination's and the catalogue's content is refused — and its publication", async () => {
    await resetRoutes();
    const session = await as([...READ, "content.edit", "content.style", "content.publish", "services.manage"]);
    for (const [target, doc, field] of [
      [{ type: "packageHero", id: subject.id }, asPackage(subject), "duration"],
      [{ type: "destinationHero", id: home.id }, asDestination(home), "summary"],
      [{ type: "packageIndexHero", id: 1 }, CATALOGUE, "heading"],
      [{ type: "packageCard", id: subject.id }, CATALOGUE, "summary"],
    ] as [RouteOwner, RouteDocument, string][]) {
      const loaded = await load(target, doc, session);
      assert.ok(loaded.ok, `${target.type} can be read`);
      const changed = { ...loaded.section.values, [field]: { en: "Not this role's to write", ar: "" } };
      const words = await save("saveRouteRegionDraft", target, doc, loaded.section.revision, "values", changed, session);
      assert.equal(words?.ok, false, target.type);
      assert.match(String(words?.message), /packages/, target.type);
      const styled = await save("saveRouteRegionStyles", target, doc, loaded.section.revision, "styles", { v: STYLE_DOCUMENT_VERSION, nodes: {} }, session);
      assert.ok(styled?.ok, `${target.type} can still be styled: ${styled?.message}`);
    }
    // The services overview is services.manage's.
    assert.ok((await saveValues({ type: "serviceIndexHero", id: 1 }, OVERVIEW, (values) => ({ ...values, intro: { en: "By the services editor", ar: "" } }), session))?.ok);
    assert.ok((await saveValues({ type: "packageHero", id: subject.id }, asPackage(subject), (values) => ({ ...values, duration: { en: "Owner's words", ar: "" } })))?.ok);
    const refused = await publish(asPackage(subject), session);
    assert.equal(refused?.ok, false);
    assert.match(failure(refused)?.message ?? "", /packages/);
    assert.ok((await discard(asPackage(subject)))?.ok);
    assert.ok((await discard(OVERVIEW))?.ok);
  });

  test("filing or hiding a card needs content.structure; its words and its featured flag do not", async () => {
    const target: RouteOwner = { type: "packageCard", id: second.id };
    const words = await as([...READ, "content.edit", "packages.manage"]);
    const current = await region(target, CATALOGUE);
    // Featured is the card's own content, as a service card's has been since Batch 21.
    assert.ok(
      (await save("saveRouteRegionDraft", target, CATALOGUE, current.revision, "values", {
        ...current.values,
        title: { ...(current.values.title as object), en: "Words only" },
        featured: !current.values.featured,
      }, words))?.ok,
    );
    const moved = await region(target, CATALOGUE);
    for (const change of [{ published: false }, { group: String(spare.id) }]) {
      const refused = await save("saveRouteRegionDraft", target, CATALOGUE, moved.revision, "values", { ...moved.values, ...change }, words);
      assert.equal(refused?.ok, false, JSON.stringify(change));
    }
    const layout = await as([...READ, "content.structure", "packages.manage"]);
    const hidden = await save("saveRouteRegionDraft", target, CATALOGUE, moved.revision, "values", { ...moved.values, published: false }, layout);
    assert.ok(hidden?.ok, hidden?.message);
    assert.ok((await discard(CATALOGUE))?.ok);
  });

  test("view only: readable, and nothing can be saved, published, discarded or restored", async () => {
    const session = await as(READ);
    const target: RouteOwner = { type: "packageHero", id: subject.id };
    const loaded = await load(target, asPackage(subject), session);
    assert.ok(loaded.ok);
    const changed = { ...loaded.section.values, duration: { en: "Not a viewer's to write", ar: "" } };
    assert.equal((await save("saveRouteRegionDraft", target, asPackage(subject), loaded.section.revision, "values", changed, session))?.ok, false);
    assert.ok((await saveValues(target, asPackage(subject), (values) => ({ ...values, duration: { en: "Pending", ar: "" } })))?.ok);
    assert.equal((await publish(asPackage(subject), session))?.ok, false);
    assert.equal((await discard(asPackage(subject), session))?.ok, false);
    assert.ok(await routeAction<RouteHistoryView | null>("loadRouteHistory", [`package:${subject.id}`], session));
    assert.ok((await discard(asPackage(subject)))?.ok);
  });

  test("a form without the session's token is refused before anything is read; signed out, nothing answers", async () => {
    const target: RouteOwner = { type: "packageIndexHero", id: 1 };
    const current = await region(target, CATALOGUE);
    const forged = await save("saveRouteRegionDraft", target, CATALOGUE, current.revision, "values", current.values, owner, "not-the-token");
    assert.equal(forged?.ok, false);
    const missing = await save("saveRouteRegionDraft", target, CATALOGUE, current.revision, "values", current.values, owner, null);
    assert.equal(missing?.ok, false);
    const anonymous = { cookie: "", csrfToken: "x", userId: 0 };
    assert.equal((await load(target, CATALOGUE, anonymous)).ok, false);
    assert.equal(await routeAction("loadRouteSummary", ["packageIndex:1"], anonymous), null);
    assert.equal(await routeAction("loadRouteSummary", [`package:${subject.id}`], anonymous), null);
    assert.equal(await routeAction("loadRouteHistory", ["serviceIndex:1"], anonymous), null);
    const published = await routeAction<RouteActionResult>("publishRouteFromEditor", [formOf({ routeKey: "packageIndex:1", token: "" }, anonymous)], anonymous);
    assert.equal(published?.ok, false);
    assert.equal((await html("/admin/visual-editor")).includes("package:"), false);
  });
});

describe("structured data describes the page a visitor gets", () => {
  test("a category page's ItemList leaves out a published service filed under a hidden group (A.9 F4)", async () => {
    // A published group holding a published service, in a category that lists something else too.
    const [group] = await sql<{ id: number; category_slug: string }[]>`
      select g.id, c.slug as category_slug from service_subcategories g join service_categories c on c.id = g.category_id
       where g.is_published and c.is_published
         and exists (select 1 from services s where s.subcategory_id = g.id and s.is_published)
         and exists (
           select 1 from services s2
            where s2.category_id = c.id and s2.is_published
              and (s2.subcategory_id is null
                   or s2.subcategory_id in (select id from service_subcategories where is_published and id <> g.id)))
       order by c.sort_order, g.sort_order limit 1`;
    assert.ok(group, "the fixture has a published group holding a published service beside others");
    const filed = await sql<{ title_en: string }[]>`select title_en from services where subcategory_id = ${group.id} and is_published`;
    const itemNames = async () =>
      ((ofType(await html(`/services/${group.category_slug}`), "ItemList") as { itemListElement: { name: string }[] }).itemListElement ?? []).map((item) => item.name);
    const before = await itemNames();
    for (const row of filed) assert.ok(before.includes(row.title_en), row.title_en);
    await sql`update service_subcategories set is_published = false where id = ${group.id}`;
    await refreshCaches();
    const after = await itemNames();
    for (const row of filed) assert.equal(after.includes(row.title_en), false, `${row.title_en} is drawn nowhere, so it is not listed`);
    assert.ok(after.length > 0, "the rest of the category is still listed");
    await sql`update service_subcategories set is_published = true where id = ${group.id}`;
    await refreshCaches();
    assert.deepEqual((await itemNames()).sort(), before.sort());
  });

  test("a package page's breadcrumb and TouristTrip, and no draft in either", async () => {
    assert.ok((await saveValues({ type: "packageHero", id: subject.id }, asPackage(subject), (values) => ({ ...values, title: { ...(values.title as object), en: "Never public" } })))?.ok);
    const page = await html(await packagePath(subject.id));
    const trip = ofType(page, "TouristTrip") as { name: string };
    assert.equal(trip.name, (await packageRow(subject.id))!.title_en);
    assert.ok(ofType(page, "BreadcrumbList"));
    assert.equal(JSON.stringify(jsonLd(page)).includes("Never public"), false);
    assert.ok((await discard(asPackage(subject)))?.ok);
  });
});

describe("the footer's descriptive line is the brand's, per edition", () => {
  const brand = async (footerLineEn: string, footerLineAr: string) => {
    const [row] = await sql<{ value: Record<string, string> }[]>`select value from site_settings where key = 'brand'`;
    const current = { siteNameEn: "", siteNameAr: "", taglineEn: "", taglineAr: "", legalNameEn: "", legalNameAr: "", ...(row?.value ?? {}) };
    return actionOf<Answer>(
      SETTINGS_ACTIONS,
      "/admin/settings",
      "saveBrand",
      [{ ok: false }, formOf({ ...current, footerLineEn, footerLineAr }, owner)],
      owner,
    );
  };

  test("empty is the standard sentence in each edition; a line of its own replaces only its edition's", async () => {
    const standardEn = "One desk for travel, business setup and government-related support in Saudi Arabia.";
    const standardAr = "مكتب واحد للسفر وتأسيس الأعمال والدعم المرتبط بالجهات الحكومية في المملكة العربية السعودية.";
    assert.ok((await html("/packages")).includes(standardEn));
    assert.ok((await brand("A footer line of our own.", ""))?.ok);
    assert.ok((await html("/packages")).includes("A footer line of our own."));
    const arabic = await html("/ar/packages");
    assert.ok(arabic.includes(standardAr), "an empty Arabic line is the standard Arabic one, never the English custom one");
    assert.equal(arabic.includes("A footer line of our own."), false);
    assert.ok((await brand("", "سطر خاص بنا."))?.ok);
    assert.ok((await html("/ar/packages")).includes("سطر خاص بنا."));
    assert.ok((await html("/packages")).includes(standardEn));
    assert.ok((await brand("", ""))?.ok);
  });
});

describe("the server said nothing wrong", () => {
  test("no render error, digest or unhandled failure was logged while all of this ran", () => {
    const said = [...earlierLogs, server.log()].join("\n");
    const wrong = said.split("\n").filter((line) => /⨯|digest:|Unhandled|TypeError|ReferenceError|RangeError/.test(line));
    assert.deepEqual(wrong, []);
  });
});
