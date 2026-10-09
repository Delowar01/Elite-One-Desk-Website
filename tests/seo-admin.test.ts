/**
 * Batch 25 · the SEO screen, its two writes, and a record that follows its page
 * (docs/admin/seo-and-share-images.md Part B — brief §5–8, §13, §19, §21).
 *
 * Everything runs against the built server and a real PostgreSQL. The screen
 * is read as a browser receives it; a save or a removal is posted the way the
 * screen posts it — the fields, the reference and the signed base the screen
 * drew the form with (`helpers/seo-form.ts`) — through the real Server Action,
 * session cookie and CSRF check. "Elsewhere" is a second admin's form, the
 * Destinations and Services forms, and the record deletes.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { callAction } from "./helpers/action";
import { REPO_ROOT } from "./helpers/env";
import { giveFresh } from "./helpers/fixtures";
import { fetchHead } from "./helpers/head";
import { formContaining, get, submitForm } from "./helpers/http";
import { openDestinationForm, withChanges } from "./helpers/package-form";
import { connect, dropDatabase, plain, type Sql } from "./helpers/pg";
import { BUILD_HINT, isBuilt, startServer, type Server } from "./helpers/server";
import { openSeoForm, withSeoChanges, type SeoFields } from "./helpers/seo-form";
import { changedForm, openServiceForm } from "./helpers/service-form";
import { signIn, type TestSession } from "./helpers/session";

const PORT = 3512;

const SEO_ACTIONS = "app/(backoffice)/admin/(shell)/seo/actions.ts";
const DESTINATION_ACTIONS = "app/(backoffice)/admin/(shell)/packages/destinations/actions.ts";
const PACKAGE_ACTIONS = "app/(backoffice)/admin/(shell)/packages/actions.ts";
const SERVICE_ACTIONS = "app/(backoffice)/admin/(shell)/services/actions.ts";
const CATEGORY_ACTIONS = "app/(backoffice)/admin/(shell)/categories/actions.ts";
const PAGE_ACTIONS = "app/(backoffice)/admin/(shell)/pages/actions.ts";

const STALE_FORM = /^This form is out of date, so nothing was saved\./;
const NO_TARGET = "That page could not be identified.";
const MISSING = /^That page no longer exists, so nothing was saved\./;

let database = "";
let sql: Sql;
let server: Server;
let owner: TestSession;
let editor: TestSession;
let viewer: TestSession;

/** Ids the fixture gives these records — read, never assumed. */
const ids: Record<string, number> = {};
let svgId = 0;
let legacyRowId = 0;
/**
 * The site's own origin, read back out of a page rather than assumed: the
 * build's `NEXT_PUBLIC_SITE_URL` when the build was given one, else this
 * server's own address, which the test server sets at runtime (CI builds
 * without it).
 */
let site = "";

type Answer = { ok: boolean; message?: string; errors?: Record<string, string>; conflicts?: string[] };

/* -------------------------------------------------------------------------- */
/* Posting as the screen posts                                                */
/* -------------------------------------------------------------------------- */

/** A form as the panel posts it; `null` as the session sends no cookie and no token. */
function formOf(fields: Record<string, string | number>, session: TestSession | null, csrf?: string | null) {
  const data = new FormData();
  const token = csrf === undefined ? session?.csrfToken : csrf;
  if (token) data.set("_csrf", token);
  for (const [key, value] of Object.entries(fields)) data.set(key, String(value));
  return data;
}

async function act(
  file: string,
  route: string,
  action: string,
  fields: Record<string, string | number>,
  session: TestSession | null = owner,
  csrf?: string | null,
): Promise<Answer | null> {
  const response = await callAction<Answer>({
    origin: server.origin,
    route,
    file,
    action,
    args: [{ ok: false }, formOf(fields, session, csrf)],
    cookie: session?.cookie,
  });
  return response.value;
}

/** An SEO write; it always answers, so an answer is required. */
async function seoAction(
  action: "saveSeo" | "clearSeo",
  fields: Record<string, string | number>,
  session: TestSession | null = owner,
  csrf?: string | null,
): Promise<Answer> {
  const answer = await act(SEO_ACTIONS, "/admin/seo", action, fields, session, csrf);
  assert.ok(answer, `${action} returned nothing`);
  return answer;
}

const open = (target: string) => openSeoForm(sql, server.origin, owner.cookie, target);
const save = (opened: SeoFields, changes: Record<string, string | number | null> = {}, session: TestSession | null = owner) =>
  seoAction("saveSeo", withSeoChanges(opened, changes), session);
const remove = (opened: SeoFields, session: TestSession | null = owner) =>
  seoAction("clearSeo", { target: opened.target!, _base: opened._base! }, session);

const saved = (answer: Answer, label = "save") => assert.equal(answer.ok, true, `${label}: ${answer.message}`);

/* -------------------------------------------------------------------------- */
/* Reading what happened                                                      */
/* -------------------------------------------------------------------------- */

type StoredRow = { id: number; entity_type: string; entity_key: string; entity_id: number | null; title_en: string };

/** Every row a record has: bound to it, or unbound at its address. */
const rowsOf = async (type: string, id: number, address?: string) =>
  plain(
    await sql<StoredRow[]>`
      select id, entity_type, entity_key, entity_id, title_en from seo_metadata
       where entity_type = ${type}
         and (entity_id = ${id} ${address === undefined ? sql`` : sql`or (entity_id is null and entity_key = ${address})`})
       order by id`,
  );

const logged = async (action: string, ref: string) =>
  sql<{ summary: string; metadata: { fields?: string[]; address?: string } | null }[]>`
    select summary, metadata from activity_logs where action = ${action} and entity_id = ${ref} order by id`;

/** One target's row on the screen, as far as its own `</li>`. */
function rowOf(html: string, ref: string): string {
  const start = html.indexOf(`data-seo-target="${ref}"`);
  assert.ok(start >= 0, `${ref} is not listed`);
  const end = html.indexOf("</li>", start);
  return html.slice(start, end < 0 ? undefined : end);
}

/** A row's badge — `Custom`, `Unpublished`, `noindex` — not merely the word somewhere in its label. */
const hasBadge = (row: string, name: string) => new RegExp(`class="admin-badge"[^>]*>${name}</span>`).test(row);

/**
 * Settings → Maintenance → Refresh caches, as an admin presses it — for a row
 * this file writes straight into the table, which no save has announced.
 */
async function refreshCaches() {
  const route = "/admin/settings?tab=maintenance";
  const page = await get(server.origin, route, { cookie: owner.cookie });
  const result = await submitForm(server.origin, route, formContaining(page.html, "Refresh caches"), owner.cookie);
  assert.match(result.html, /Every cache was dropped/);
}

/**
 * Until `waiters` other sessions of this file's own database wait for a lock:
 * the requests just sent have reached it. The files run in parallel against
 * one server, each on its own database, so a wait anywhere else proves nothing.
 */
async function untilWaiting(waiters = 1) {
  for (let tries = 0; tries < 400; tries += 1) {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n from pg_stat_activity
       where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`;
    if (row!.n >= waiters) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("the request never reached the lock");
}

/**
 * Holds what `lock` takes, in a transaction of the test's own, until the
 * returned function is called — so a request that needs it waits for as long
 * as the test says, and no longer.
 */
async function hold(lock: (tx: Sql) => Promise<unknown>): Promise<() => Promise<void>> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let held!: () => void;
  const holding = new Promise<void>((resolve) => (held = resolve));
  const holder = sql.begin(async (tx) => {
    await lock(tx as unknown as Sql);
    held();
    await gate;
  });
  await holding;
  return async () => {
    release();
    await holder;
  };
}

const screen = async (target?: string, session: TestSession = owner) =>
  get(server.origin, target ? `/admin/seo?target=${encodeURIComponent(target)}` : "/admin/seo", { cookie: session.cookie });

const titleOf = async (path: string) => (await fetchHead(server.origin, path)).title;

/* -------------------------------------------------------------------------- */

before(async () => {
  assert.ok(isBuilt(), BUILD_HINT);
  database = giveFresh("seo_admin");
  sql = connect(database);
  owner = await signIn(sql);
  for (const role of ["editor", "viewer"]) {
    await sql`
      insert into users (email, name, password_hash, role_id, is_active)
      select ${`seo-${role}@test.invalid`}, ${`SEO ${role}`}, 'unused', id, true from roles where key = ${role}`;
  }
  editor = await signIn(sql, "editor");
  viewer = await signIn(sql, "viewer");

  for (const row of await sql<{ slug: string; id: number }[]>`select slug, id from pages`) ids[`page/${row.slug}`] = row.id;
  for (const row of await sql<{ slug: string; id: number }[]>`select slug, id from service_categories`) ids[`category/${row.slug}`] = row.id;
  for (const row of await sql<{ slug: string; id: number }[]>`select slug, id from travel_packages`) ids[`package/${row.slug}`] = row.id;
  for (const row of await sql<{ slug: string; id: number }[]>`select slug, id from package_destinations`) ids[`destination/${row.slug}`] = row.id;
  for (const row of await sql<{ slug: string; id: number }[]>`select slug, id from services`) ids[`service/${row.slug}`] = row.id;

  // A picture no social network shows, and so no share image.
  [{ id: svgId }] = await sql<{ id: number }[]>`
    insert into media (filename, mime_type, title, width, height)
    values ('seo-admin-logo.svg', 'image/svg+xml', 'SEO admin logo', 0, 0) returning id`;
  // A row as the previous release writes one: by address, bound to nothing.
  // Written before the server starts, so the public page reads it from the start.
  [{ id: legacyRowId }] = await sql<{ id: number }[]>`
    insert into seo_metadata (entity_type, entity_key, title_en)
    values ('category', 'iqama-services', 'Legacy Iqama title') returning id`;

  server = await startServer(database, PORT);
  site = new URL((await fetchHead(server.origin, "/")).canonical ?? "").origin;
  assert.ok(site, "the homepage declares no canonical");
});

after(async () => {
  await server?.stop();
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
});

/* -------------------------------------------------------------------------- */

describe("25 · every page with an address of its own is a target (§5, §7)", () => {
  test("the homepage, every CMS page, both overviews, and every category, service, destination and package — in that order", async () => {
    const page = await screen();
    assert.equal(page.status, 200);
    const listed = [...page.html.matchAll(/data-seo-target="([^"]+)"/g)].map((match) => match[1]);

    const refs = (kind: string, rows: readonly { id: number }[]) => rows.map((row) => `${kind}:${row.id}`);
    const expected = [
      ...refs("page", await sql<{ id: number }[]>`select id from pages order by (slug = 'home') desc, sort_order, id`),
      "serviceIndex:1",
      "packageIndex:1",
      ...refs("category", await sql<{ id: number }[]>`select id from service_categories order by sort_order, id`),
      ...refs(
        "service",
        await sql<{ id: number }[]>`
          select s.id from services s join service_categories c on c.id = s.category_id
           order by c.sort_order, c.id, s.sort_order, s.id`,
      ),
      ...refs("destination", await sql<{ id: number }[]>`select id from package_destinations order by sort_order, id`),
      ...refs("package", await sql<{ id: number }[]>`select id from travel_packages order by sort_order, id`),
    ];
    assert.deepEqual(listed, expected);
    assert.equal(listed.length, 6 + 2 + 5 + 74 + 1 + 5, "the fresh catalogue's 93 addresses");
    assert.deepEqual(
      [...page.html.matchAll(/data-seo-group="([^"]+)"/g)].map((match) => match[1]),
      ["page", "overview", "category", "service", "destination", "package"],
    );

    // The site-wide fallbacks are shown, and are not a target of this form.
    assert.match(page.html, /data-seo-site-defaults/);
    assert.match(page.html, /Elite One Desk — Travel, Business Setup and Government Services/);
    assert.ok(!listed.includes("site:1"));
    // No SEO editing for what is not a page (§15).
    assert.ok(!page.html.includes('data-seo-target="search'), "search results are never a target");
    assert.match(rowOf(page.html, `page:${ids["page/home"]}`), /dir="ltr">\/<\/span>/, "the homepage is listed at /");
  });

  test("a record created a moment ago is a target at once — marked Unpublished while no visitor can see it — and a deleted one is gone", async () => {
    const [made] = await sql<{ id: number }[]>`
      insert into package_destinations (slug, title_en, is_published)
      values ('seo-draft-destination', 'SEO draft destination', false) returning id`;
    const ref = `destination:${made!.id}`;
    const row = rowOf((await screen()).html, ref);
    assert.match(row, /SEO draft destination/);
    assert.match(row, /\/packages\/seo-draft-destination/);
    assert.ok(hasBadge(row, "Unpublished"), "no Unpublished badge");
    assert.ok(!hasBadge(rowOf((await screen()).html, "destination:1"), "Unpublished"), "a published destination is marked Unpublished");

    await sql`delete from package_destinations where id = ${made!.id}`;
    assert.ok(!(await screen()).html.includes(`data-seo-target="${ref}"`));
  });

  test("?target= opens the one target it names, and only a target the screen lists", async () => {
    for (const asked of ["destination:999999", "page:about", "search:1", "site:1", "destination:1 ", "<script>x</script>"]) {
      const page = await screen(asked);
      assert.equal(page.status, 200, asked);
      assert.ok(!page.html.includes('name="_base"'), `${JSON.stringify(asked)} opened a form`);
    }
    const page = await screen("destination:1");
    assert.match(page.html, /name="target" value="destination:1"/);
    assert.equal(page.html.match(/name="_base"/g)?.length, 1, "one form: the one asked for");
  });
});

describe("25 · saving through the screen (§5–7)", () => {
  test("the Services overview is saved by reference under its fixed key, logged by reference, and live on /services in both languages at once", async () => {
    saved(
      await save(await open("serviceIndex:1"), {
        titleEn: "Every service we offer",
        titleAr: "كل خدماتنا",
        descriptionEn: "Visas, company formation, Iqama services and more.",
      }),
    );
    const rows = await sql`
      select entity_type, entity_key, entity_id, title_en, title_ar, description_en, description_ar
        from seo_metadata where entity_key = 'services'`;
    assert.deepEqual(plain(rows), [
      {
        entity_type: "page",
        entity_key: "services",
        entity_id: null,
        title_en: "Every service we offer",
        title_ar: "كل خدماتنا",
        description_en: "Visas, company formation, Iqama services and more.",
        description_ar: "",
      },
    ]);
    const [entry] = await logged("seo.updated", "serviceIndex:1");
    assert.deepEqual(entry!.metadata, { fields: ["titleEn", "titleAr", "descriptionEn"], address: "/services" });
    assert.match(entry!.summary, /Services overview/);

    // No refresh, no restart: the save dropped the cached records (§18).
    assert.equal(await titleOf("/services"), "Every service we offer · Elite One Desk");
    assert.equal(await titleOf("/ar/services"), "كل خدماتنا · إيليت ون ديسك");
  });

  test("the Tour packages overview has a record of its own — never the Services overview's", async () => {
    saved(await save(await open("packageIndex:1"), { titleEn: "Tours and itineraries" }));
    const rows = await sql<{ entity_key: string; title_en: string }[]>`
      select entity_key, title_en from seo_metadata where entity_type = 'page' and entity_id is null order by entity_key`;
    assert.deepEqual(plain(rows), [
      { entity_key: "packages", title_en: "Tours and itineraries" },
      { entity_key: "services", title_en: "Every service we offer" },
    ]);
    assert.equal(await titleOf("/packages"), "Tours and itineraries · Elite One Desk");
    assert.equal(await titleOf("/services"), "Every service we offer · Elite One Desk");
  });

  test("a category, a service, a destination and a package are each bound to their own record by id, keyed by their present address", async () => {
    const [service] = await sql<{ id: number; address: string }[]>`
      select s.id, c.slug || '/' || s.slug as address from services s join service_categories c on c.id = s.category_id
       where c.slug = 'license-renewal' order by s.sort_order, s.id limit 1`;
    const cases: Array<[string, string, number, string]> = [
      [`category:${ids["category/business-setup"]}`, "category", ids["category/business-setup"]!, "business-setup"],
      [`service:${service!.id}`, "service", service!.id, service!.address],
      [`destination:${ids["destination/egypt"]}`, "destination", ids["destination/egypt"]!, "egypt"],
      [`package:${ids["package/red-sea-sharm-el-sheikh"]}`, "package", ids["package/red-sea-sharm-el-sheikh"]!, "red-sea-sharm-el-sheikh"],
    ];
    for (const [ref, type, id, key] of cases) {
      saved(await save(await open(ref), { titleEn: `Bound ${ref}` }), ref);
      const rows = await sql`select entity_key, entity_id from seo_metadata where entity_type = ${type} and title_en = ${`Bound ${ref}`}`;
      assert.deepEqual(plain(rows), [{ entity_key: key, entity_id: id }], ref);
      const [entry] = await logged("seo.updated", ref);
      assert.deepEqual(entry?.metadata?.fields, ["titleEn"], ref);
    }
  });

  test("a form saved as it was drawn writes nothing and logs nothing; Custom and noindex appear once there is a record that says so", async () => {
    const ref = `page:${ids["page/disclaimer"]}`;
    const answer = await save(await open(ref));
    assert.equal(answer.ok, true);
    assert.equal(answer.message, "No changes to save.");
    assert.deepEqual(await rowsOf("page", ids["page/disclaimer"]!, "disclaimer"), []);
    assert.equal((await logged("seo.updated", ref)).length, 0);
    assert.ok(!hasBadge(rowOf((await screen()).html, ref), "Custom"));

    saved(await save(await open(ref), { noindex: "on" }));
    const row = rowOf((await screen()).html, ref);
    assert.ok(hasBadge(row, "Custom"), "no Custom badge");
    assert.ok(hasBadge(row, "noindex"), "no noindex badge");
    // …and unticking it is a change like any other.
    saved(await save(await open(ref), { noindex: null }));
    assert.ok(!hasBadge(rowOf((await screen()).html, ref), "noindex"));
  });

  test("the share image: any raster picture in the library; an SVG, a missing picture or a malformed id is refused by name, and nothing is written", async () => {
    const id = ids["package/egypt-family-programme"]!;
    const ref = `package:${id}`;
    const refusals: Array<[string | number, RegExp]> = [
      [svgId, /An SVG cannot be a share image/],
      [999_999, /That picture is no longer in the media library/],
      ["1.5", /Choose the share image from the library/],
      ["-4", /Choose the share image from the library/],
      ["0", /Choose the share image from the library/],
      ["seven", /Choose the share image from the library/],
    ];
    for (const [value, reason] of refusals) {
      const answer = await save(await open(ref), { ogImageId: value, titleEn: "Family programme" });
      assert.equal(answer.ok, false, `accepted ${value}`);
      assert.match(answer.message ?? "", reason, String(value));
      assert.ok(answer.errors?.ogImageId, `${value}: the share image field is not marked`);
    }
    assert.deepEqual(await rowsOf("package", id, "egypt-family-programme"), [], "a refused save wrote nothing — not even its title");

    saved(await save(await open(ref), { ogImageId: 9 }));
    const [row] = await sql<{ og_image_id: number | null }[]>`select og_image_id from seo_metadata where entity_type = 'package' and entity_id = ${id}`;
    assert.equal(row!.og_image_id, 9);

    // The picker offers raster pictures only: the screen never names the SVG.
    const page = await screen(ref);
    assert.ok(page.html.includes("one-desk.webp"), "the library is offered");
    assert.ok(!page.html.includes("seo-admin-logo.svg"), "the SVG is offered as a share image");
  });

  test("the canonical: a page of this site, stored without its language; anything that leaves the site, carries state or is not a page is refused by name", async () => {
    const id = ids["page/privacy"]!;
    const ref = `page:${id}`;
    const refusals: Array<[string, RegExp]> = [
      ["https://evil.example/terms", /must be a page of this site/],
      ["//evil.example/terms", /single \//],
      ["/terms?preview=1", /Leave out the \? and # parts/],
      ["/terms#top", /Leave out the \? and # parts/],
      ["/admin/seo", /not a page that can be canonical/],
      ["/ar/api/enquiries", /not a page that can be canonical/],
      ["/search", /not a page that can be canonical/],
      ["/../admin", /without \. or \.\./],
      ["javascript:alert(1)", /must be a page of this site|Write a page of this site/],
      ["/terms page", /no spaces/],
      [`/${"t".repeat(300)}`, /Keep it under 255 characters/],
    ];
    for (const [value, reason] of refusals) {
      const answer = await save(await open(ref), { canonicalUrl: value });
      assert.equal(answer.ok, false, `accepted ${value}`);
      assert.match(answer.message ?? "", reason, value);
      assert.ok(answer.errors?.canonicalUrl, `${value}: the canonical field is not marked`);
    }
    assert.deepEqual(await rowsOf("page", id, "privacy"), [], "a refused canonical wrote nothing");

    // Typed with a language, or as a full address on this site: stored as the page.
    saved(await save(await open(ref), { canonicalUrl: "/ar/terms" }));
    const stored = async () =>
      (await sql<{ canonical_url: string }[]>`select canonical_url from seo_metadata where entity_type = 'page' and entity_id = ${id}`)[0]!
        .canonical_url;
    assert.equal(await stored(), "/terms");
    // The same page written another way is no change at all.
    const same = await save(await open(ref), { canonicalUrl: `${site}/en/terms` });
    assert.equal(same.message, "No changes to save.");
    assert.equal(await stored(), "/terms");
  });

  test("a canonical the previous release kept in a form this one never writes — `/about/` — is no edit while it is left alone: another field's save writes only that field, and is not refused when the canonical moved elsewhere (X1³)", async () => {
    const [{ id }] = await sql<{ id: number }[]>`
      insert into pages (slug, kind, title_en, is_published) values ('seo-legacy-canonical', 'custom', 'Legacy canonical', true) returning id`;
    const ref = `page:${id}`;
    await sql`
      insert into seo_metadata (entity_type, entity_key, entity_id, canonical_url) values ('page', 'seo-legacy-canonical', ${id}, '/about/')`;
    const stored = async () =>
      (await sql<{ canonical_url: string; title_en: string; description_en: string }[]>`
        select canonical_url, title_en, description_en from seo_metadata where entity_type = 'page' and entity_id = ${id}`)[0]!;
    const logs = (await logged("seo.updated", ref)).length;

    saved(await save(await open(ref), { titleEn: "Legacy, retitled" }));
    assert.deepEqual({ ...(await stored()) }, { canonical_url: "/about/", title_en: "Legacy, retitled", description_en: "" });
    assert.deepEqual((await logged("seo.updated", ref)).slice(logs).map((entry) => entry.metadata?.fields), [["titleEn"]]);

    const first = await open(ref);
    const second = await open(ref);
    saved(await save(first, { canonicalUrl: "/contact" }));
    saved(await save(second, { descriptionEn: "Saved by the one who left the canonical alone." }), "the save that never touched the canonical");
    assert.deepEqual({ ...(await stored()) }, {
      canonical_url: "/contact",
      title_en: "Legacy, retitled",
      description_en: "Saved by the one who left the canonical alone.",
    });
  });

  test("a row the previous release wrote by address is used as it was, shown on the screen, and bound in place the first time it is saved", async () => {
    const id = ids["category/iqama-services"]!;
    const ref = `category:${id}`;
    assert.equal(await titleOf("/services/iqama-services"), "Legacy Iqama title · Elite One Desk", "the rule the previous release followed");
    assert.ok(hasBadge(rowOf((await screen()).html, ref), "Custom"), "the row is not shown as the page's record");

    const opened = await open(ref);
    assert.equal(opened.titleEn, "Legacy Iqama title", "the form is drawn with that row");
    saved(await save(opened, { descriptionEn: "Iqama renewals, transfers and exit and re-entry visas." }));

    const rows = await sql`
      select id, entity_key, entity_id, title_en, description_en from seo_metadata
       where entity_type = 'category' and (entity_id = ${id} or entity_key = 'iqama-services')`;
    assert.deepEqual(plain(rows), [
      {
        id: legacyRowId,
        entity_key: "iqama-services",
        entity_id: id,
        title_en: "Legacy Iqama title",
        description_en: "Iqama renewals, transfers and exit and re-entry visas.",
      },
    ]);
    assert.equal(await titleOf("/services/iqama-services"), "Legacy Iqama title · Elite One Desk");
  });
});

/* -------------------------------------------------------------------------- */

describe("25 · a record follows its page (§6, §13)", () => {
  test("a service moved to another category through the Services form takes its record along; a dead row at the new address is moved aside, never inherited, never deleted", async () => {
    const id = ids["service/air-ticket-booking"]!;
    const business = ids["category/business-setup"]!;
    saved(await save(await open(`service:${id}`), { titleEn: "Air tickets, any airline" }));
    const [{ id: dead }] = await sql<{ id: number }[]>`
      insert into seo_metadata (entity_type, entity_key, title_en)
      values ('service', 'business-setup/air-ticket-booking', 'A dead row at the new address') returning id`;

    const opened = await openServiceForm(sql, server.origin, owner.cookie, id);
    const moved = await act(SERVICE_ACTIONS, `/admin/services/${id}`, "updateService", changedForm(opened, { categoryId: business, subcategoryId: "" }));
    assert.equal(moved?.ok, true, moved?.message);

    const rows = await sql`
      select id, entity_key, entity_id, title_en from seo_metadata
       where entity_type = 'service' and (entity_id = ${id} or id = ${dead}) order by id`;
    assert.deepEqual(plain(rows).map(({ id: _row, ...rest }) => rest), [
      { entity_key: "business-setup/air-ticket-booking", entity_id: id, title_en: "Air tickets, any airline" },
      { entity_key: `~${dead}`, entity_id: 0, title_en: "A dead row at the new address" },
    ]);
    const head = await fetchHead(server.origin, "/services/business-setup/air-ticket-booking");
    assert.equal(head.status, 200);
    assert.equal(head.title, "Air tickets, any airline · Elite One Desk");
  });

  test("a service with no record moved onto an address a dead row holds starts with nothing of that row's", async () => {
    const id = ids["service/hotel-reservation"]!;
    const [{ title }] = await sql<{ title: string }[]>`select title_en as title from services where id = ${id}`;
    const [{ id: dead }] = await sql<{ id: number }[]>`
      insert into seo_metadata (entity_type, entity_key, title_en)
      values ('service', 'business-setup/hotel-reservation', 'Not this service''s title') returning id`;
    const opened = await openServiceForm(sql, server.origin, owner.cookie, id);
    const moved = await act(
      SERVICE_ACTIONS,
      `/admin/services/${id}`,
      "updateService",
      changedForm(opened, { categoryId: ids["category/business-setup"]!, subcategoryId: "" }),
    );
    assert.equal(moved?.ok, true, moved?.message);
    const [row] = await sql<{ entity_key: string; entity_id: number | null }[]>`select entity_key, entity_id from seo_metadata where id = ${dead}`;
    assert.deepEqual({ ...row }, { entity_key: `~${dead}`, entity_id: 0 });
    assert.equal(await titleOf("/services/business-setup/hotel-reservation"), `${title} · Elite One Desk`);
    assert.ok(!hasBadge(rowOf((await screen()).html, `service:${id}`), "Custom"), "the dead row is shown as the service's record");
  });

  /** A destination, through the Destinations screen. */
  async function createDestination(slug: string, title: string) {
    await act(DESTINATION_ACTIONS, "/admin/packages/destinations/new", "createDestination", {
      slug,
      titleEn: title,
      titleAr: "",
      summaryEn: "",
      sortOrder: 9,
      isPublished: "on",
    });
    const [row] = await sql<{ id: number }[]>`select id from package_destinations where slug = ${slug}`;
    assert.ok(row, `the Destinations screen created ${slug}`);
    return row.id;
  }

  test("a record created at an address another record's row still holds parks that row at #id, where it keeps working for its own — and a key made by hand to look like that is set aside first", async () => {
    const jordan = await createDestination("jordan", "Jordan");
    // Jordan's record, keyed by an address it no longer has: the previous
    // release renamed Jordan and moved nothing.
    const [{ id: jordanRow }] = await sql<{ id: number }[]>`
      insert into seo_metadata (entity_type, entity_key, entity_id, title_en)
      values ('destination', 'petra', ${jordan}, 'Jordan, from Amman to Aqaba') returning id`;
    // …and a row made by hand through that release's form (A.9), holding the
    // very key Jordan's row is about to be parked at.
    const [{ id: planted }] = await sql<{ id: number }[]>`
      insert into seo_metadata (entity_type, entity_key, title_en)
      values ('destination', ${`#${jordan}`}, 'Made by hand') returning id`;
    const petra = await createDestination("petra", "Petra");

    const rows = await sql`
      select id, entity_key, entity_id from seo_metadata where id in ${sql([jordanRow, planted])} order by id`;
    assert.deepEqual(plain(rows), [
      { id: jordanRow, entity_key: `#${jordan}`, entity_id: jordan },
      { id: planted, entity_key: `~${planted}`, entity_id: 0 },
    ]);
    await refreshCaches();
    assert.equal(await titleOf("/packages/jordan"), "Jordan, from Amman to Aqaba · Elite One Desk", "a bound row is found by its record");
    assert.equal(await titleOf("/packages/petra"), "Petra · Elite One Desk", "the new record inherited another's row");
    assert.ok(!hasBadge(rowOf((await screen()).html, `destination:${petra}`), "Custom"));

    // Its next save puts it back at its record's present address.
    saved(await save(await open(`destination:${jordan}`), { descriptionEn: "Wadi Rum, Petra and the Dead Sea." }));
    const [back] = await sql<{ entity_key: string }[]>`select entity_key from seo_metadata where id = ${jordanRow}`;
    assert.equal(back!.entity_key, "jordan");
  });

  test("a first save of a record whose address another record's row still holds parks that row first — the save is not refused", async () => {
    const amman = await createDestination("amman", "Amman");
    const wadiRum = await createDestination("wadi-rum", "Wadi Rum");
    // In the deploy window the previous release renamed Amman away from
    // wadi-rum and created Wadi Rum there: Amman's row is left at wadi-rum,
    // where no create of this release ever saw it.
    const [{ id: ammanRow }] = await sql<{ id: number }[]>`
      insert into seo_metadata (entity_type, entity_key, entity_id, title_en)
      values ('destination', 'wadi-rum', ${amman}, 'Amman, the capital') returning id`;
    await refreshCaches();
    assert.equal(await titleOf("/packages/wadi-rum"), "Wadi Rum · Elite One Desk", "a row bound to another record is never used here");

    saved(await save(await open(`destination:${wadiRum}`), { titleEn: "Wadi Rum under the stars" }));
    const rows = await sql`
      select id, entity_key, entity_id, title_en from seo_metadata
       where entity_type = 'destination' and entity_id in ${sql([amman, wadiRum])} order by id`;
    assert.deepEqual(plain(rows).map(({ id: _row, ...rest }) => rest), [
      { entity_key: `#${amman}`, entity_id: amman, title_en: "Amman, the capital" },
      { entity_key: "wadi-rum", entity_id: wadiRum, title_en: "Wadi Rum under the stars" },
    ]);
    assert.equal(plain(rows)[0]!.id, ammanRow, "moved aside, not deleted");
    assert.equal(await titleOf("/packages/amman"), "Amman, the capital · Elite One Desk");
    assert.equal(await titleOf("/packages/wadi-rum"), "Wadi Rum under the stars · Elite One Desk");
  });

  test("a save and a rename, each taking an address the other's row holds, lock those rows in one order: one waits for the other, and neither is refused (W1³)", async () => {
    const first = await createDestination("seo-crossed-first", "First crossed");
    const second = await createDestination("seo-crossed-second", "Second crossed");
    // What the previous release left: each record's own row at an address it
    // no longer has — the first's where the second is about to go, the
    // second's at the first's address — and then the second's SEO saved by
    // address, a newer row at its present one.
    const [{ id: firstRow }] = await sql<{ id: number }[]>`
      insert into seo_metadata (entity_type, entity_key, entity_id, title_en)
      values ('destination', 'seo-crossed-renamed', ${first}, 'The first, left behind') returning id`;
    const [{ id: secondRow }] = await sql<{ id: number }[]>`
      insert into seo_metadata (entity_type, entity_key, entity_id, title_en)
      values ('destination', 'seo-crossed-first', ${second}, 'The second, left behind') returning id`;
    const [{ id: newer }] = await sql<{ id: number }[]>`
      insert into seo_metadata (entity_type, entity_key, title_en)
      values ('destination', 'seo-crossed-second', 'The second, saved by address') returning id`;
    // The rename sets the second's old row aside before it takes its new
    // address: held there, holding the rows it has locked, until the save has
    // reached them too — a gate the test opens, not a clock.
    const GATE = 25_000_301;
    const release = await hold((tx) => tx`select pg_advisory_xact_lock(${GATE})`);
    await sql.unsafe(`create function seo_test_hold() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(${GATE}); return new; end $$`);
    await sql.unsafe(`
      create trigger seo_test_hold before update on seo_metadata for each row
        when (old.id = ${secondRow} and new.entity_id = 0) execute function seo_test_hold()`);
    try {
      const destinationForm = await openDestinationForm(sql, server.origin, owner.cookie, second);
      const seoForm = await open(`destination:${first}`);
      let renaming: ReturnType<typeof act> | undefined;
      let saving: ReturnType<typeof save> | undefined;
      try {
        renaming = act(DESTINATION_ACTIONS, `/admin/packages/destinations/${second}`, "updateDestination", withChanges(destinationForm, { slug: "seo-crossed-renamed" }));
        await untilWaiting(1);
        saving = save(seoForm, { titleEn: "The first, saved while the second moved" });
        await untilWaiting(2);
      } finally {
        await release();
      }
      const [renamed, answer] = await Promise.all([renaming, saving]);
      assert.equal(renamed?.ok, true, `the rename: ${renamed?.message}`);
      saved(answer!, "the save");
    } finally {
      await sql`drop trigger if exists seo_test_hold on seo_metadata`;
      await sql`drop function if exists seo_test_hold()`;
    }
    const rows = await sql`select id, entity_key, entity_id, title_en from seo_metadata where id in ${sql([firstRow, secondRow, newer])} order by id`;
    assert.deepEqual(plain(rows), [
      { id: firstRow, entity_key: "seo-crossed-first", entity_id: first, title_en: "The first, saved while the second moved" },
      { id: secondRow, entity_key: `~${secondRow}`, entity_id: 0, title_en: "The second, left behind" },
      { id: newer, entity_key: "seo-crossed-renamed", entity_id: second, title_en: "The second, saved by address" },
    ]);
  });

  test("…and when the row at the address the save takes comes first in that order, the save locks it with its own, so the rename cannot hold one and wait for the other (W1³)", async () => {
    const first = await createDestination("seo-reversed-first", "First reversed");
    const second = await createDestination("seo-reversed-second", "Second reversed");
    // The same rows, written the other way round: the second's row, at the
    // first's address, comes before the first's own row.
    const [{ id: secondRow }] = await sql<{ id: number }[]>`
      insert into seo_metadata (entity_type, entity_key, entity_id, title_en)
      values ('destination', 'seo-reversed-first', ${second}, 'The second, left behind') returning id`;
    const [{ id: firstRow }] = await sql<{ id: number }[]>`
      insert into seo_metadata (entity_type, entity_key, entity_id, title_en)
      values ('destination', 'seo-reversed-renamed', ${first}, 'The first, left behind') returning id`;
    const [{ id: newer }] = await sql<{ id: number }[]>`
      insert into seo_metadata (entity_type, entity_key, title_en)
      values ('destination', 'seo-reversed-second', 'The second, saved by address') returning id`;
    assert.ok(secondRow < firstRow, "the row the save claims comes first");
    const destinationForm = await openDestinationForm(sql, server.origin, owner.cookie, second);
    const seoForm = await open(`destination:${first}`);
    // The first's own row is held, so the save stops there, holding whatever
    // it locked before it; then the rename locks the same rows in id order.
    const release = await hold((tx) => tx`select id from seo_metadata where id = ${firstRow} for update`);
    let saving: ReturnType<typeof save> | undefined;
    let renaming: ReturnType<typeof act> | undefined;
    try {
      saving = save(seoForm, { titleEn: "The first, saved while the second moved" });
      await untilWaiting(1);
      renaming = act(DESTINATION_ACTIONS, `/admin/packages/destinations/${second}`, "updateDestination", withChanges(destinationForm, { slug: "seo-reversed-renamed" }));
      await untilWaiting(2);
    } finally {
      await release();
    }
    const [answer, renamed] = await Promise.all([saving, renaming]);
    saved(answer!, "the save");
    assert.equal(renamed?.ok, true, `the rename: ${renamed?.message}`);
    const rows = await sql`select id, entity_key, entity_id, title_en from seo_metadata where id in ${sql([firstRow, secondRow, newer])} order by id`;
    assert.deepEqual(plain(rows), [
      { id: secondRow, entity_key: `~${secondRow}`, entity_id: 0, title_en: "The second, left behind" },
      { id: firstRow, entity_key: "seo-reversed-first", entity_id: first, title_en: "The first, saved while the second moved" },
      { id: newer, entity_key: "seo-reversed-renamed", entity_id: second, title_en: "The second, saved by address" },
    ]);
  });
});

describe("25 · a key in a reserved form, made by hand, is nobody's (W2³, X3³)", () => {
  /** A category and a service whose address is longer than the key column: keyed `#<id>`. */
  async function longService(prefix: string) {
    const [{ id: category }] = await sql<{ id: number }[]>`
      insert into service_categories (slug, title_en, is_published) values (${`${prefix}-${"c".repeat(100)}`}, 'Long category', true) returning id`;
    return { category, slug: `${prefix}-${"s".repeat(100)}` };
  }

  test("a row by address at a long-address service's `#<id>`: the page, the screen and the editor pass it by, and the first save sets it aside", async () => {
    const { category, slug } = await longService("seo-long");
    const [{ id }] = await sql<{ id: number }[]>`
      insert into services (category_id, slug, title_en, is_published) values (${category}, ${slug}, 'A long-named service', true) returning id`;
    // Made by hand through the previous release's form (A.9): no address is `#<id>`.
    const [{ id: planted }] = await sql<{ id: number }[]>`
      insert into seo_metadata (entity_type, entity_key, title_en, noindex) values ('service', ${`#${id}`}, 'Made by hand', true) returning id`;
    await refreshCaches();
    const [{ address }] = await sql<{ address: string }[]>`
      select c.slug || '/' || s.slug as address from services s join service_categories c on c.id = s.category_id where s.id = ${id}`;
    const head = await fetchHead(server.origin, `/services/${address}`);
    assert.equal(head.title, "A long-named service · Elite One Desk", "the page used the row made by hand");
    assert.notEqual(head.robots?.startsWith("noindex"), true, "the page took the row's noindex");
    assert.ok(!hasBadge(rowOf((await screen()).html, `service:${id}`), "Custom"), "the screen shows the row as the service's record");

    saved(await save(await open(`service:${id}`), { titleEn: "Long, and saved" }));
    const rows = await sql`select id, entity_key, entity_id, title_en, noindex from seo_metadata where entity_type = 'service' and (id = ${planted} or entity_id = ${id}) order by id`;
    assert.deepEqual(plain(rows).map(({ id: row, ...rest }) => ({ planted: row === planted, ...rest })), [
      { planted: true, entity_key: `~${planted}`, entity_id: 0, title_en: "Made by hand", noindex: true },
      { planted: false, entity_key: `#${id}`, entity_id: id, title_en: "Long, and saved", noindex: false },
    ]);
  });

  test("a long-address service created where a row by address holds its `#<id>` starts with nothing of it", async () => {
    const { category, slug } = await longService("seo-born-long");
    // The id the next service will have, so the row can be put at its `#<id>` first.
    const [{ next }] = await sql<{ next: number }[]>`
      select setval(pg_get_serial_sequence('services', 'id'), (select max(id) from services) + 100) + 1 as next`;
    const [{ id: planted }] = await sql<{ id: number }[]>`
      insert into seo_metadata (entity_type, entity_key, title_en, noindex) values ('service', ${`#${next}`}, 'Waiting for the next service', true) returning id`;
    await refreshCaches();
    await titleOf("/");
    const made = await act(SERVICE_ACTIONS, "/admin/services/new", "createService", {
      slug,
      titleEn: "Born with a long address",
      categoryId: category,
      subcategoryId: "",
      formPreset: "general",
      isPublished: "on",
    });
    assert.notEqual(made?.ok, false, made?.message);
    const [{ id }] = await sql<{ id: number }[]>`select id from services where slug = ${slug}`;
    assert.equal(id, Number(next), "the service took the id the row was put at");
    const [row] = await sql<{ entity_key: string; entity_id: number }[]>`select entity_key, entity_id from seo_metadata where id = ${planted}`;
    assert.deepEqual({ ...row }, { entity_key: `~${planted}`, entity_id: 0 });
    assert.ok(!hasBadge(rowOf((await screen()).html, `service:${id}`), "Custom"));
  });

  test("a row set aside while a row made by hand holds its `~<id>`: that one goes to its own first — a create and a save are not refused (X3³)", async () => {
    // A create over a dead row at its address.
    const [{ id: dead }] = await sql<{ id: number }[]>`
      insert into seo_metadata (entity_type, entity_key, title_en) values ('destination', 'seo-tilde-born', 'A deleted record''s row') returning id`;
    const [{ id: holder }] = await sql<{ id: number }[]>`
      insert into seo_metadata (entity_type, entity_key, title_en) values ('destination', ${`~${dead}`}, 'Made by hand') returning id`;
    const made = await act(DESTINATION_ACTIONS, "/admin/packages/destinations/new", "createDestination", {
      slug: "seo-tilde-born",
      titleEn: "Born over a dead row",
      titleAr: "",
      summaryEn: "",
      sortOrder: 9,
      isPublished: "on",
    });
    assert.notEqual(made?.ok, false, made?.message);
    assert.equal((await sql`select 1 from package_destinations where slug = 'seo-tilde-born'`).length, 1, "the create was refused");
    const created = await sql`select id, entity_key, entity_id from seo_metadata where id in ${sql([dead, holder])} order by id`;
    assert.deepEqual(plain(created), [
      { id: dead, entity_key: `~${dead}`, entity_id: 0 },
      { id: holder, entity_key: `~${holder}`, entity_id: 0 },
    ]);

    // A save that sets aside the row its newer one shadowed.
    const id = ids["service/professional-tour-guide"]!;
    const [{ id: own }] = await sql<{ id: number }[]>`
      insert into seo_metadata (entity_type, entity_key, entity_id, title_en)
      values ('service', 'business-setup/professional-tour-guide', ${id}, 'Its own row, left at the old address') returning id`;
    const [{ id: newer }] = await sql<{ id: number }[]>`
      insert into seo_metadata (entity_type, entity_key, title_en) values ('service', 'travel-tourism/professional-tour-guide', 'Guides, saved by address') returning id`;
    const [{ id: trap }] = await sql<{ id: number }[]>`
      insert into seo_metadata (entity_type, entity_key, title_en) values ('service', ${`~${own}`}, 'Made by hand') returning id`;
    await refreshCaches();
    saved(await save(await open(`service:${id}`), { descriptionEn: "A guide who knows the way." }));
    const rows = await sql`select id, entity_key, entity_id from seo_metadata where id in ${sql([own, newer, trap])} order by id`;
    assert.deepEqual(plain(rows), [
      { id: own, entity_key: `~${own}`, entity_id: 0 },
      { id: newer, entity_key: "travel-tourism/professional-tour-guide", entity_id: id },
      { id: trap, entity_key: `~${trap}`, entity_id: 0 },
    ]);
  });
});

describe("25 · a newer row by address beside a record's own row at an old address (B.2)", () => {
  /**
   * The state the previous release leaves when it moves a service during the
   * deploy window — the service's own row stays at the old address — and then
   * saves the service's SEO, by address: a newer, unbound row at the present one.
   */
  async function movedThenSaved(slug: string, title: string) {
    const id = ids[`service/${slug}`]!;
    const [{ id: own }] = await sql<{ id: number }[]>`
      insert into seo_metadata (entity_type, entity_key, entity_id, title_en)
      values ('service', ${`business-setup/${slug}`}, ${id}, 'Its own row, left at the old address') returning id`;
    const [{ id: newer }] = await sql<{ id: number }[]>`
      insert into seo_metadata (entity_type, entity_key, title_en)
      values ('service', ${`travel-tourism/${slug}`}, ${title}) returning id`;
    await refreshCaches();
    return { id, own, newer, path: `/services/travel-tourism/${slug}` };
  }

  test("the newer row is the one used — by the page and by the screen, as the previous release used it — and saving it binds it and sets aside the row it shadowed", async () => {
    const { id, own, newer, path } = await movedThenSaved("honeymoon-packages", "Honeymoons, saved by address");
    assert.equal(await titleOf(path), "Honeymoons, saved by address · Elite One Desk", "the page uses the newer row");
    const drawn = /<input[^>]*name="titleEn"[^>]*>/.exec((await screen(`service:${id}`)).html)?.[0] ?? "";
    assert.match(drawn, /value="Honeymoons, saved by address"/, "the screen draws the form with the newer row");
    const opened = await open(`service:${id}`);

    saved(await save(opened, { descriptionEn: "Two weeks, planned for two." }));
    const rows = await sql`select id, entity_key, entity_id, title_en, description_en from seo_metadata where id in ${sql([own, newer])} order by id`;
    assert.deepEqual(plain(rows), [
      { id: own, entity_key: `~${own}`, entity_id: 0, title_en: "Its own row, left at the old address", description_en: "" },
      {
        id: newer,
        entity_key: "travel-tourism/honeymoon-packages",
        entity_id: id,
        title_en: "Honeymoons, saved by address",
        description_en: "Two weeks, planned for two.",
      },
    ]);
    assert.equal(await titleOf(path), "Honeymoons, saved by address · Elite One Desk");
  });

  test("removing the newer row does not bring the shadowed one back: it is set aside too, and the page follows its own content", async () => {
    const { id, own, newer, path } = await movedThenSaved("family-tour-packages", "Families, saved by address");
    const [{ title }] = await sql<{ title: string }[]>`select title_en as title from services where id = ${id}`;
    const removed = await remove(await open(`service:${id}`));
    assert.equal(removed.ok, true, removed.message);
    assert.equal((await sql`select 1 from seo_metadata where id = ${newer}`).length, 0, "the newer row was removed");
    const [left] = await sql<{ entity_key: string; entity_id: number }[]>`select entity_key, entity_id from seo_metadata where id = ${own}`;
    assert.deepEqual({ ...left }, { entity_key: `~${own}`, entity_id: 0 });
    assert.equal(await titleOf(path), `${title} · Elite One Desk`);
    assert.ok(!hasBadge(rowOf((await screen()).html, `service:${id}`), "Custom"), "the shadowed row came back as the record");
  });

  test("a record's own row parked at #id, shadowed the same way, gives the key up as it is set aside — #id is only ever its own row's", async () => {
    const id = ids["service/group-tour-packages"]!;
    const [{ id: own }] = await sql<{ id: number }[]>`
      insert into seo_metadata (entity_type, entity_key, entity_id, title_en)
      values ('service', ${`#${id}`}, ${id}, 'Its own row, parked') returning id`;
    const [{ id: newer }] = await sql<{ id: number }[]>`
      insert into seo_metadata (entity_type, entity_key, title_en)
      values ('service', 'travel-tourism/group-tour-packages', 'Groups, saved by address') returning id`;
    await refreshCaches();
    saved(await save(await open(`service:${id}`), { descriptionEn: "Groups of ten or more." }));
    const rows = await sql`select id, entity_key, entity_id from seo_metadata where id in ${sql([own, newer])} order by id`;
    assert.deepEqual(plain(rows), [
      { id: own, entity_key: `~${own}`, entity_id: 0 },
      { id: newer, entity_key: "travel-tourism/group-tour-packages", entity_id: id },
    ]);
  });
});

describe("25 · a deleted record takes its record with it (B.7)", () => {
  test("a package — and a package created later at the same address starts with nothing", async () => {
    const id = ids["package/custom-itinerary"]!;
    saved(await save(await open(`package:${id}`), { titleEn: "A trip of your own" }));
    await act(PACKAGE_ACTIONS, `/admin/packages/${id}`, "deletePackage", { id });
    assert.equal((await sql`select 1 from travel_packages where id = ${id}`).length, 0, "the package was deleted");
    assert.deepEqual(await rowsOf("package", id, "custom-itinerary"), []);

    await act(PACKAGE_ACTIONS, "/admin/packages/new", "createPackage", {
      slug: "custom-itinerary",
      region: "international",
      destinationId: "",
      titleEn: "Custom itinerary, again",
      titleAr: "برنامج مخصص",
      summaryEn: "Created after the first one was deleted.",
      highlights: "[]",
      sortOrder: 50,
      isPublished: "on",
    });
    const [made] = await sql<{ id: number }[]>`select id from travel_packages where slug = 'custom-itinerary'`;
    assert.ok(made, "the Packages screen created the package");
    assert.ok(!hasBadge(rowOf((await screen()).html, `package:${made.id}`), "Custom"), "the new package inherited a record");
  });

  test("a category takes its services' records with it — bound ones, and one the previous release wrote at a service's address", async () => {
    const category = ids["category/government-relations"]!;
    const services = await sql<{ id: number; slug: string }[]>`select id, slug from services where category_id = ${category} order by id`;
    const [first, second] = services;
    saved(await save(await open(`category:${category}`), { titleEn: "Government relations" }));
    saved(await save(await open(`service:${first!.id}`), { titleEn: "First government service" }));
    await sql`
      insert into seo_metadata (entity_type, entity_key, title_en)
      values ('service', ${`government-relations/${second!.slug}`}, 'Written by the previous release')`;

    await act(CATEGORY_ACTIONS, `/admin/categories/${category}`, "deleteCategory", { id: category });
    assert.equal((await sql`select 1 from service_categories where id = ${category}`).length, 0, "the category was deleted");
    assert.deepEqual(await rowsOf("category", category, "government-relations"), []);
    const left = await sql`
      select 1 from seo_metadata where entity_type = 'service'
         and (entity_id in ${sql(services.map((row) => row.id))} or entity_key like 'government-relations/%')`;
    assert.equal(left.length, 0, "a service's record outlived its service");
  });

  test("a service moved out of a category while the category is deleted keeps its record — only the services that go take theirs", async () => {
    const [{ id: closing }] = await sql<{ id: number }[]>`
      insert into service_categories (slug, title_en, is_published) values ('seo-closing', 'Closing category', true) returning id`;
    const [{ id: leaving }] = await sql<{ id: number }[]>`
      insert into services (category_id, slug, title_en, is_published) values (${closing}, 'seo-leaving', 'Leaving service', true) returning id`;
    const [{ id: staying }] = await sql<{ id: number }[]>`
      insert into services (category_id, slug, title_en, is_published) values (${closing}, 'seo-staying', 'Staying service', true) returning id`;
    saved(await save(await open(`service:${leaving}`), { titleEn: "Moved out in time" }));
    saved(await save(await open(`service:${staying}`), { titleEn: "Goes with its category" }));

    // The move, as the Services form makes it — the service held, its category
    // changed, its row moved with it — still open when the delete arrives.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let taken!: () => void;
    const held = new Promise<void>((resolve) => (taken = resolve));
    const moving = sql.begin(async (tx) => {
      await tx`select 1 from services where id = ${leaving} for update`;
      await tx`update services set category_id = ${ids["category/business-setup"]!} where id = ${leaving}`;
      await tx`update seo_metadata set entity_key = 'business-setup/seo-leaving' where entity_type = 'service' and entity_id = ${leaving}`;
      taken();
      await gate;
    });
    await held;
    const deleting = act(CATEGORY_ACTIONS, `/admin/categories/${closing}`, "deleteCategory", { id: closing });
    await untilWaiting();
    release();
    await moving;
    await deleting;

    assert.equal((await sql`select 1 from service_categories where id = ${closing}`).length, 0, "the category was deleted");
    assert.equal((await sql`select 1 from services where id = ${staying}`).length, 0, "the service left in it went with it");
    assert.deepEqual(await rowsOf("service", staying), [], "…and so did that service's record");
    assert.deepEqual(
      (await rowsOf("service", leaving)).map(({ entity_key, entity_id, title_en }) => ({ entity_key, entity_id, title_en })),
      [{ entity_key: "business-setup/seo-leaving", entity_id: leaving, title_en: "Moved out in time" }],
      "the service that moved out lost its record",
    );
  });

  test("a service, and a page created in the panel", async () => {
    const service = ids["service/travel-insurance"]!;
    saved(await save(await open(`service:${service}`), { titleEn: "Insured travel" }));
    await act(SERVICE_ACTIONS, `/admin/services/${service}`, "deleteService", { id: service });
    assert.equal((await sql`select 1 from services where id = ${service}`).length, 0, "the service was deleted");
    assert.deepEqual(await rowsOf("service", service), []);

    const [page] = await sql<{ id: number }[]>`
      insert into pages (slug, kind, title_en, is_published) values ('seo-landing', 'custom', 'SEO landing', true) returning id`;
    saved(await save(await open(`page:${page!.id}`), { titleEn: "A landing page" }));
    await act(PAGE_ACTIONS, "/admin/pages/seo-landing", "deletePage", { id: page!.id });
    assert.equal((await sql`select 1 from pages where id = ${page!.id}`).length, 0, "the page was deleted");
    assert.deepEqual(await rowsOf("page", page!.id, "seo-landing"), []);
  });

  test("a form drawn before its record was deleted is told so, and writes nothing", async () => {
    await act(DESTINATION_ACTIONS, "/admin/packages/destinations/new", "createDestination", {
      slug: "short-lived",
      titleEn: "Short-lived",
      titleAr: "",
      summaryEn: "",
      sortOrder: 9,
      isPublished: "on",
    });
    const [made] = await sql<{ id: number }[]>`select id from package_destinations where slug = 'short-lived'`;
    const ref = `destination:${made!.id}`;
    saved(await save(await open(ref), { titleEn: "Soon gone" }));
    const opened = await open(ref);
    await act(DESTINATION_ACTIONS, `/admin/packages/destinations/${made!.id}`, "deleteDestination", { id: made!.id });
    assert.deepEqual(await rowsOf("destination", made!.id, "short-lived"), [], "its record went with it");

    const late = await save(opened, { titleEn: "Too late" });
    assert.equal(late.ok, false);
    assert.match(late.message ?? "", MISSING);
    const removal = await remove(opened);
    assert.equal(removal.ok, false);
    assert.match(removal.message ?? "", MISSING);
    assert.equal((await sql`select 1 from seo_metadata where title_en = 'Too late'`).length, 0);
  });
});

describe("25 · a record created where a dead row lies starts with nothing (B.7)", () => {
  test("a page, a category, a service, a destination and a package: the row at the new address is set aside — kept, never applied, now or after a rollback — and the public page is drawn without it at once", async () => {
    type Created = {
      type: string;
      key: string;
      /** The dead row's: by address (null), or bound to a record deleted since. */
      entityId: number | null;
      title: string;
      /** The new record's public page. */
      path: string;
      create: () => Promise<unknown>;
      id: () => Promise<number | undefined>;
      /** For a record created unpublished: publishing it, the way an admin does. */
      publish?: (id: number) => Promise<unknown>;
    };
    const created: Created[] = [
      {
        type: "page",
        key: "seo-reborn-page",
        entityId: null,
        title: "Reborn page",
        path: "/seo-reborn-page",
        create: () => act(PAGE_ACTIONS, "/admin/pages", "createPage", { titleEn: "Reborn page", slug: "seo-reborn-page" }),
        id: async () => (await sql<{ id: number }[]>`select id from pages where slug = 'seo-reborn-page'`)[0]?.id,
        // Created unpublished; publishing it drops only the pages' cache, never the SEO rows'.
        publish: (id) => act(PAGE_ACTIONS, "/admin/pages", "updatePage", { id, titleEn: "Reborn page", titleAr: "", isPublished: "on" }),
      },
      {
        type: "category",
        key: "seo-reborn-category",
        entityId: null,
        title: "Reborn category",
        path: "/services/seo-reborn-category",
        create: () =>
          act(CATEGORY_ACTIONS, "/admin/categories/new", "createCategory", {
            slug: "seo-reborn-category",
            titleEn: "Reborn category",
            sortOrder: 9,
            isPublished: "on",
          }),
        id: async () => (await sql<{ id: number }[]>`select id from service_categories where slug = 'seo-reborn-category'`)[0]?.id,
      },
      {
        // The other kind of dead row: one the deploy had bound to a record deleted since.
        type: "category",
        key: "seo-reborn-over-a-bound-row",
        entityId: 999_994,
        title: "Reborn over a bound row",
        path: "/services/seo-reborn-over-a-bound-row",
        create: () =>
          act(CATEGORY_ACTIONS, "/admin/categories/new", "createCategory", {
            slug: "seo-reborn-over-a-bound-row",
            titleEn: "Reborn over a bound row",
            sortOrder: 9,
            isPublished: "on",
          }),
        id: async () => (await sql<{ id: number }[]>`select id from service_categories where slug = 'seo-reborn-over-a-bound-row'`)[0]?.id,
      },
      {
        type: "service",
        key: "business-setup/seo-reborn-service",
        entityId: null,
        title: "Reborn service",
        path: "/services/business-setup/seo-reborn-service",
        create: () =>
          act(SERVICE_ACTIONS, "/admin/services/new", "createService", {
            slug: "seo-reborn-service",
            titleEn: "Reborn service",
            categoryId: ids["category/business-setup"]!,
            subcategoryId: "",
            formPreset: "general",
            isPublished: "on",
          }),
        id: async () => (await sql<{ id: number }[]>`select id from services where slug = 'seo-reborn-service'`)[0]?.id,
      },
      {
        type: "destination",
        key: "seo-reborn-destination",
        entityId: null,
        title: "Reborn destination",
        path: "/packages/seo-reborn-destination",
        create: () =>
          act(DESTINATION_ACTIONS, "/admin/packages/destinations/new", "createDestination", {
            slug: "seo-reborn-destination",
            titleEn: "Reborn destination",
            titleAr: "",
            summaryEn: "",
            sortOrder: 9,
            isPublished: "on",
          }),
        id: async () => (await sql<{ id: number }[]>`select id from package_destinations where slug = 'seo-reborn-destination'`)[0]?.id,
      },
      {
        type: "package",
        key: "seo-reborn-package",
        entityId: null,
        title: "Reborn package",
        path: "/packages/seo-reborn-package",
        create: () =>
          act(PACKAGE_ACTIONS, "/admin/packages/new", "createPackage", {
            slug: "seo-reborn-package",
            region: "international",
            destinationId: "",
            titleEn: "Reborn package",
            titleAr: "",
            summaryEn: "Created where a dead row lies.",
            highlights: "[]",
            sortOrder: 50,
            isPublished: "on",
          }),
        id: async () => (await sql<{ id: number }[]>`select id from travel_packages where slug = 'seo-reborn-package'`)[0]?.id,
      },
    ];
    const expected: unknown[] = [];
    const found: unknown[] = [];
    for (const record of created) {
      // Left by the previous release: a row it wrote by address for a record it
      // deleted since, or the row the deploy had bound to a record it then deleted.
      const [{ id: dead }] = await sql<{ id: number }[]>`
        insert into seo_metadata (entity_type, entity_key, entity_id, title_en, noindex)
        values (${record.type}, ${record.key}, ${record.entityId}, 'A deleted record''s title', true) returning id`;
      // On a live site the cached rows already hold it: it was there before
      // anything was created at its address (R6²: a create must drop them).
      await refreshCaches();
      await titleOf("/");
      await record.create();
      const id = await record.id();
      assert.ok(id, `the ${record.type} was created`);
      if (record.publish) await record.publish(id);
      const [row] = await sql<{ entity_key: string; entity_id: number | null }[]>`select entity_key, entity_id from seo_metadata where id = ${dead}`;
      expected.push({
        key: record.key,
        entity_key: `~${dead}`,
        entity_id: 0,
        inherited: false,
        title: `${record.title} · Elite One Desk`,
      });
      found.push({
        key: record.key,
        entity_key: row!.entity_key,
        entity_id: row!.entity_id,
        inherited: hasBadge(rowOf((await screen()).html, `${record.type}:${id}`), "Custom"),
        title: await titleOf(record.path),
      });
    }
    // All of them at once, so a failure names every create that let the row through.
    assert.deepEqual(found, expected);
  });
});

/* -------------------------------------------------------------------------- */

describe("25 · who may save, and what a form may name (§21)", () => {
  test("without seo.manage the screen sends the role away and both writes refuse, writing nothing; an editor holds it", async () => {
    // Sent away the way every panel screen sends a role away: the screen
    // streams, so the redirect to the dashboard arrives in the page rather
    // than as a status — and none of the screen's contents arrive with it.
    const away = await screen(undefined, viewer);
    const sentTo = away.status === 307 ? away.location : /id="__next-page-redirect"[^>]*url=([^"]+)"/.exec(away.html)?.[1];
    assert.equal(sentTo, "/admin?denied=1", `HTTP ${away.status}`);
    assert.ok(!away.html.includes("data-seo-target"), "the screen's list reached a role without seo.manage");

    const ref = `page:${ids["page/contact"]}`;
    const opened = await open(ref);
    const refused = await save(opened, { titleEn: "Written by a viewer" }, viewer);
    assert.equal(refused.ok, false);
    assert.deepEqual(await rowsOf("page", ids["page/contact"]!, "contact"), []);

    saved(await save(opened, { titleEn: "Contact Elite One Desk" }, editor), "editor");
    const [row] = await rowsOf("page", ids["page/contact"]!, "contact");
    assert.equal(row?.title_en, "Contact Elite One Desk");

    const notRemoved = await remove(await open(ref), viewer);
    assert.equal(notRemoved.ok, false);
    assert.equal((await rowsOf("page", ids["page/contact"]!, "contact")).length, 1, "a viewer removed the record");
  });

  test("the session's CSRF token, or nothing is written; no session, nothing at all", async () => {
    const ref = `page:${ids["page/contact"]}`;
    const changed = withSeoChanges(await open(ref), { titleEn: "Forged" });
    const forged = await seoAction("saveSeo", changed, owner, "not-the-token");
    assert.equal(forged.ok, false);
    assert.match(forged.message ?? "", /This form expired/);
    const tokenless = await seoAction("saveSeo", changed, owner, null);
    assert.equal(tokenless.ok, false);
    const anonymous = await seoAction("saveSeo", changed, null);
    assert.equal(anonymous.ok, false);
    assert.match(anonymous.message ?? "", /session has expired/);
    assert.equal((await sql`select 1 from seo_metadata where title_en = 'Forged'`).length, 0);
  });

  test("the reference names the target, parsed strictly — never an address, a type or a key the browser sends", async () => {
    const ref = `page:${ids["page/terms"]}`;
    const opened = await open(ref);
    for (const target of ["", "site:1", "page:terms", "terms", "search:1", "page:0", `${ref}x`, `${ref} `, "category:1/service:2", `PAGE:${ids["page/terms"]}`]) {
      const answer = await seoAction("saveSeo", { ...withSeoChanges(opened, { titleEn: "Not saved" }), target });
      assert.equal(answer.ok, false, JSON.stringify(target));
      assert.equal(answer.message, NO_TARGET, JSON.stringify(target));
    }
    assert.equal((await sql`select 1 from seo_metadata where title_en = 'Not saved'`).length, 0);

    // A type, a key or an id posted beside the reference is not read.
    saved(
      await seoAction("saveSeo", {
        ...withSeoChanges(opened, { titleEn: "Terms, as the reference says" }),
        entityType: "service",
        entityKey: "travel-tourism/visa-services",
        entityId: 77,
        entity_type: "destination",
        entity_key: "egypt",
      }),
    );
    const rows = await sql`select entity_type, entity_key, entity_id from seo_metadata where title_en = 'Terms, as the reference says'`;
    assert.deepEqual(plain(rows), [{ entity_type: "page", entity_key: "terms", entity_id: ids["page/terms"] }]);
  });

  test("a base is good for the one target it was drawn for: another record, another kind with the same id, or a single changed character is out of date", async () => {
    const terms = await open(`page:${ids["page/terms"]}`);
    const services = await open("serviceIndex:1");
    const egypt = await open(`destination:${ids["destination/egypt"]}`);
    const tamper = (base: string) => {
      const [payload, signature] = base.split(".") as [string, string];
      return `${payload[0] === "e" ? "f" : "e"}${payload.slice(1)}.${signature}`;
    };
    const posts: Array<[string, SeoFields]> = [
      ["another page", { ...terms, target: `page:${ids["page/privacy"]}` }],
      ["the other overview, same id", { ...services, target: "packageIndex:1" }],
      ["a package with the destination's id", { ...egypt, target: `package:${ids["destination/egypt"]}` }],
      ["a changed character", { ...terms, _base: tamper(terms._base as string) }],
      ["no base", { ...terms, _base: "" }],
    ];
    for (const [label, form] of posts) {
      for (const action of ["saveSeo", "clearSeo"] as const) {
        const answer = await seoAction(action, withSeoChanges(form, { titleEn: "Replayed" }));
        assert.equal(answer.ok, false, `${action}: ${label}`);
        assert.match(answer.message ?? "", STALE_FORM, `${action}: ${label}`);
      }
    }
    assert.equal((await sql`select 1 from seo_metadata where title_en = 'Replayed'`).length, 0);
  });

  test("a form drawn by the previous release — a type and an address, no reference, no base — is out of date, for a save and a removal alike, and writes nothing", async () => {
    // Exactly what the previous release's screen posts (da96625 seo-client.tsx).
    const stored = async () => plain(await sql`select * from seo_metadata order by id`);
    const before = await stored();
    const saving = await seoAction("saveSeo", {
      entityType: "page",
      entityKey: "terms",
      ogImageId: "",
      titleEn: "Saved from a tab left open",
      titleAr: "",
      descriptionEn: "",
      descriptionAr: "",
      ogTitle: "",
      ogDescription: "",
      canonicalUrl: "",
    });
    assert.equal(saving.ok, false);
    assert.match(saving.message ?? "", STALE_FORM);
    const removing = await seoAction("clearSeo", { entityType: "page", entityKey: "terms" });
    assert.equal(removing.ok, false);
    assert.match(removing.message ?? "", STALE_FORM);
    assert.deepEqual(await stored(), before);
  });
});

/* -------------------------------------------------------------------------- */

describe("25 · two people, one record (§19)", () => {
  const terms = () => `page:${ids["page/terms"]}`;
  const row = async () =>
    (await sql<Record<string, unknown>[]>`select * from seo_metadata where entity_type = 'page' and entity_id = ${ids["page/terms"]!}`)[0];

  test("different fields: both saves land, each logged with its own field", async () => {
    const first = await open(terms());
    const second = await open(terms());
    const logs = (await logged("seo.updated", terms())).length;
    saved(await save(first, { descriptionEn: "The rules of the site." }));
    saved(await save(second, { ogTitle: "Read before you book" }));
    const now = await row();
    assert.equal(now!.description_en, "The rules of the site.");
    assert.equal(now!.og_title, "Read before you book");
    const entries = (await logged("seo.updated", terms())).slice(logs);
    assert.deepEqual(entries.map((entry) => entry.metadata?.fields), [["descriptionEn"], ["ogTitle"]]);
  });

  test("the same field: the later save is refused whole, the field named — nothing of it is written", async () => {
    const first = await open(terms());
    const second = await open(terms());
    saved(await save(first, { titleEn: "Terms (first)" }));
    const refused = await save(second, { titleEn: "Terms (second)", descriptionAr: "قواعد الموقع" });
    assert.equal(refused.ok, false);
    assert.match(refused.message ?? "", /^Title \(English\) was changed elsewhere while this form was open, so nothing was saved\./);
    assert.deepEqual(refused.conflicts, ["titleEn"]);
    const now = await row();
    assert.equal(now!.title_en, "Terms (first)");
    assert.equal(now!.description_ar, "", "the half that did not conflict was not written either");
  });

  test("the reverse order gives the mirror result", async () => {
    const first = await open(terms());
    const second = await open(terms());
    saved(await save(second, { titleEn: "Terms (second, saved first)" }));
    const refused = await save(first, { titleEn: "Terms (first, saved second)" });
    assert.equal(refused.ok, false);
    assert.deepEqual(refused.conflicts, ["titleEn"]);
    assert.equal((await row())!.title_en, "Terms (second, saved first)");
  });

  test("the same change made twice is no conflict, and is logged once", async () => {
    const first = await open(terms());
    const second = await open(terms());
    const logs = (await logged("seo.updated", terms())).length;
    saved(await save(first, { ogDescription: "What you agree to when you book." }));
    const again = await save(second, { ogDescription: "What you agree to when you book." });
    assert.equal(again.ok, true);
    assert.equal(again.message, "SEO saved.");
    assert.equal((await logged("seo.updated", terms())).length, logs + 1);
  });

  test("two first saves of a target with no record, at once: one record — both changes when they differ, one winner when they collide — never two rows, never an error", async () => {
    const nile = ids["package/nile-cruise-luxor-aswan"]!;
    const [a, b] = await Promise.all([
      open(`package:${nile}`).then((form) => save(form, { titleEn: "Nile cruise" })),
      open(`package:${nile}`).then((form) => save(form, { descriptionEn: "Luxor to Aswan in four nights." })),
    ]);
    saved(a!, "first");
    saved(b!, "second");
    const rows = await sql`select title_en, description_en from seo_metadata where entity_type = 'package' and entity_id = ${nile}`;
    assert.deepEqual(plain(rows), [{ title_en: "Nile cruise", description_en: "Luxor to Aswan in four nights." }]);

    const cairo = ids["package/cairo-and-giza-classic"]!;
    const [x, y] = await Promise.all([open(`package:${cairo}`), open(`package:${cairo}`)]);
    const results = await Promise.all([save(x, { titleEn: "Cairo A" }), save(y, { titleEn: "Cairo B" })]);
    assert.equal(results.filter((answer) => answer.ok).length, 1, JSON.stringify(results));
    const loser = results.find((answer) => !answer.ok)!;
    assert.deepEqual(loser.conflicts, ["titleEn"]);
    const winner = results[0]!.ok ? "Cairo A" : "Cairo B";
    const stored = await sql`select title_en from seo_metadata where entity_type = 'package' and (entity_id = ${cairo} or entity_key = 'cairo-and-giza-classic')`;
    assert.deepEqual(plain(stored), [{ title_en: winner }]);
  });

  test("a save that waits while its service is moved to another category lands where the service went — the move is not read as a deletion", async () => {
    // Found by the Batch 25 stress (M6): the service was locked through a join
    // with its category, and a save that had waited for a move re-checked the
    // moved row against the old category and answered "no longer exists".
    const id = ids["service/cruise-booking"]!;
    const opened = await open(`service:${id}`);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let taken!: () => void;
    const held = new Promise<void>((resolve) => (taken = resolve));
    // The move, as the Services form makes it: the service's row held, then its category changed.
    const moving = sql.begin(async (tx) => {
      await tx`select 1 from services where id = ${id} for update`;
      taken();
      await gate;
      await tx`update services set category_id = ${ids["category/business-setup"]!}, subcategory_id = null where id = ${id}`;
    });
    await held;
    const saving = save(opened, { titleEn: "Cruises, booked for you" });
    await untilWaiting();
    release();
    await moving;
    saved(await saving, "the save that waited");
    const rows = await sql`select entity_key, entity_id, title_en from seo_metadata where entity_type = 'service' and entity_id = ${id}`;
    assert.deepEqual(plain(rows), [{ entity_key: "business-setup/cruise-booking", entity_id: id, title_en: "Cruises, booked for you" }]);
  });

  test("a removal drawn before somebody else's edit is refused; removing a removed record says so and logs nothing", async () => {
    const stale = await open(terms());
    saved(await save(await open(terms()), { descriptionAr: "قواعد استخدام الموقع" }));
    const refused = await remove(stale);
    assert.equal(refused.ok, false);
    assert.match(refused.message ?? "", /^Meta description \(Arabic\) was changed elsewhere while this form was open, so the override was not removed\./);
    assert.deepEqual(refused.conflicts, ["descriptionAr"]);
    assert.ok(await row(), "the record is still there");

    const fresh = await open(terms());
    const removed = await remove(fresh);
    assert.equal(removed.ok, true);
    assert.match(removed.message ?? "", /^Override removed\./);
    assert.equal(await row(), undefined);
    assert.equal((await logged("seo.cleared", terms())).length, 1);
    assert.equal(await titleOf("/terms"), "Terms of Use · Elite One Desk", "the page follows its own title again");

    const twice = await remove(fresh);
    assert.equal(twice.ok, true);
    assert.equal(twice.message, "There was no override to remove.");
    assert.equal((await logged("seo.cleared", terms())).length, 1, "a removal that removed nothing is not logged");
  });
});

/* -------------------------------------------------------------------------- */

describe("25 · a destination's new address (§13)", () => {
  test("its record moves with it, still its own; the old address answers 404; a form opened before the rename saves to the record where it now is", async () => {
    const egypt = ids["destination/egypt"]!;
    const ref = `destination:${egypt}`;
    saved(await save(await open(ref), { titleEn: "Egypt with Elite One Desk", descriptionEn: "Cairo, the Nile and the Red Sea." }));
    const seoForm = await open(ref);

    const destinationForm = await openDestinationForm(sql, server.origin, owner.cookie, egypt);
    const renamed = await act(DESTINATION_ACTIONS, `/admin/packages/destinations/${egypt}`, "updateDestination", withChanges(destinationForm, { slug: "egypt-tours" }));
    assert.equal(renamed?.ok, true, renamed?.message);

    const rows = await sql`select entity_key, entity_id, title_en from seo_metadata where entity_type = 'destination' and (entity_id = ${egypt} or entity_key in ('egypt', 'egypt-tours'))`;
    assert.deepEqual(plain(rows), [{ entity_key: "egypt-tours", entity_id: egypt, title_en: "Egypt with Elite One Desk" }]);

    const head = await fetchHead(server.origin, "/packages/egypt-tours");
    assert.equal(head.status, 200);
    assert.equal(head.title, "Egypt with Elite One Desk", "a title holding the brand name is not given it twice");
    assert.equal(head.canonical, `${site}/packages/egypt-tours`);
    assert.equal((await fetchHead(server.origin, "/packages/egypt")).status, 404, "no redirect is invented");

    saved(await save(seoForm, { descriptionAr: "القاهرة والنيل والبحر الأحمر." }), "the form drawn before the rename");
    const after = await sql`select entity_key, entity_id, description_ar from seo_metadata where entity_type = 'destination' and entity_id = ${egypt}`;
    assert.deepEqual(plain(after), [{ entity_key: "egypt-tours", entity_id: egypt, description_ar: "القاهرة والنيل والبحر الأحمر." }]);
    const entries = await logged("seo.updated", ref);
    assert.equal(entries.at(-1)!.metadata?.address, "/packages/egypt-tours", "logged at the address it has now");
    assert.equal((await sql`select 1 from seo_metadata where entity_type = 'destination' and entity_key = 'egypt'`).length, 0);
  });
});

/* -------------------------------------------------------------------------- */

describe("25 · the Visual Editor opens the SEO screen; it does not edit SEO (§8)", () => {
  const linkOf = (html: string) => /<a[^>]*data-ve-seo="([^"]+)"[^>]*>/.exec(html);

  test("each document links to its own target — a page, an overview, a route — and says whether it has settings of its own", async () => {
    const about = ids["page/about"]!;
    const page = await get(server.origin, "/admin/visual-editor?page=about", { cookie: owner.cookie });
    assert.equal(page.status, 200);
    let link = linkOf(page.html);
    assert.equal(link?.[1], `page:${about}`);
    assert.match(link![0], new RegExp(`href="/admin/seo\\?target=page%3A${about}"`));
    assert.match(link![0], /target="_blank"/);
    assert.match(link![0], /aria-label="SEO — following the page(?:'|&#x27;)s own content"/);

    saved(await save(await open(`page:${about}`), { titleEn: "About Elite One Desk" }));
    link = linkOf((await get(server.origin, "/admin/visual-editor?page=about", { cookie: owner.cookie })).html);
    assert.match(link![0], /aria-label="SEO — this page has its own settings"/);

    const overview = linkOf((await get(server.origin, "/admin/visual-editor?route=packageIndex:1", { cookie: owner.cookie })).html);
    assert.equal(overview?.[1], "packageIndex:1");
    assert.match(overview![0], /this page has its own settings/, "the Tour packages overview was saved above");
    const service = ids["service/airport-transfer"]!;
    const route = linkOf((await get(server.origin, `/admin/visual-editor?route=service:${service}`, { cookie: owner.cookie })).html);
    assert.equal(route?.[1], `service:${service}`);
  });

  test("a role without seo.manage is not shown the way to a screen that would refuse it", async () => {
    const page = await get(server.origin, "/admin/visual-editor?page=about", { cookie: viewer.cookie });
    assert.equal(page.status, 200);
    assert.ok(!page.html.includes("data-ve-seo"));
  });
});

describe("25 · the SEO screen's writes, by name", () => {
  test("saveSeo and clearSeo — and the site-defaults action that nothing could reach is gone", () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, ".next", "server", "server-reference-manifest.json"), "utf8")) as {
      node: Record<string, { filename: string; exportedName: string }>;
    };
    const entries = Object.values(manifest.node);
    assert.deepEqual(entries.filter((entry) => entry.filename === SEO_ACTIONS).map((entry) => entry.exportedName).sort(), ["clearSeo", "saveSeo"]);
    assert.ok(!entries.some((entry) => entry.exportedName === "saveSeoDefaults"));
    const settings = readFileSync(path.join(REPO_ROOT, "src", "app", "(backoffice)", "admin", "(shell)", "settings", "actions.ts"), "utf8");
    assert.ok(!settings.includes("saveSeoDefaults"), "the orphan is still in the settings actions");
  });
});
