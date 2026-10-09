/**
 * Batch 25 · what every kind of page says to a search engine and a link
 * preview, in each language (docs/admin/seo-and-share-images.md B.4, B.14,
 * B.15 — brief §9–12, §14–18).
 *
 * The records are written into the table before the server starts, as a
 * deployment finds them — bound by this release, or by address as the previous
 * release writes them — and every page is read as a visitor receives it. The
 * last test makes its changes through the SEO screen's own actions instead, to
 * show that a change is live at the next request with nothing refreshed.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { callAction } from "./helpers/action";
import { giveFresh } from "./helpers/fixtures";
import { fetchHead, jsonLdOf, type Head } from "./helpers/head";
import { formContaining, get, submitForm } from "./helpers/http";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { BUILD_HINT, isBuilt, startServer, type Server } from "./helpers/server";
import { openSeoForm, withSeoChanges } from "./helpers/seo-form";
import { signIn, type TestSession } from "./helpers/session";

const PORT = 3513;
const SEO_ACTIONS = "app/(backoffice)/admin/(shell)/seo/actions.ts";

const SITE_EN = "Elite One Desk";
const SITE_AR = "إيليت ون ديسك";
const DEFAULT_TITLE_EN = "Elite One Desk — Travel, Business Setup and Government Services";
const DEFAULT_TITLE_AR = "إيليت ون ديسك — السفر وتأسيس الأعمال والخدمات الحكومية";
const DEFAULT_DESCRIPTION_EN =
  "One destination for travel, business setup, company formation, residency, licensing and government-related support in Saudi Arabia.";
const DEFAULT_DESCRIPTION_AR =
  "وجهة واحدة للسفر وتأسيس الأعمال وتسجيل الشركات والإقامة والتراخيص والدعم المرتبط بالجهات الحكومية في المملكة.";

let database = "";
let sql: Sql;
let server: Server;
let owner: TestSession;
/**
 * The origin the pages name, read back out of one: the build's
 * `NEXT_PUBLIC_SITE_URL` when the build was given one (production, and a local
 * build with `.env`), else the server's own address, which the test server
 * sets at runtime (CI builds without it).
 */
let site = "";

const ids: Record<string, number> = {};
const pictures: Record<string, number> = {};

const en = (path: string) => fetchHead(server.origin, path);
const ar = (path: string) => fetchHead(server.origin, path === "/" ? "/ar" : `/ar${path}`);
const enTitle = (text: string) => `${text} · ${SITE_EN}`;
const arTitle = (text: string) => `${text} · ${SITE_AR}`;

/** A row as this release writes one: bound to its record, keyed by its present address. */
async function record(type: string, key: string, id: number | null, values: Record<string, string | number | boolean>) {
  const row = { entity_type: type, entity_key: key, entity_id: id, ...values };
  await sql`insert into seo_metadata ${sql(row)}`;
}

before(async () => {
  assert.ok(isBuilt(), BUILD_HINT);
  database = giveFresh("seo_metadata");
  sql = connect(database);
  owner = await signIn(sql);

  for (const row of await sql<{ slug: string; id: number }[]>`select slug, id from pages`) ids[`page/${row.slug}`] = row.id;
  for (const row of await sql<{ slug: string; id: number }[]>`select slug, id from service_categories`) ids[`category/${row.slug}`] = row.id;
  for (const row of await sql<{ slug: string; id: number }[]>`select slug, id from travel_packages`) ids[`package/${row.slug}`] = row.id;
  for (const row of await sql<{ slug: string; id: number }[]>`select slug, id from package_destinations`) ids[`destination/${row.slug}`] = row.id;
  for (const row of await sql<{ slug: string; id: number }[]>`select slug, id from services`) ids[`service/${row.slug}`] = row.id;

  // Pictures, as the library holds them. Only their records matter here: a
  // page names a picture by address, and nothing in this file fetches one.
  const picture = async (filename: string, mime: string, width: number, height: number, derivatives: number[], altEn = "", altAr = "") => {
    const [row] = await sql<{ id: number }[]>`
      insert into media (filename, mime_type, title, width, height, derivatives, alt_en, alt_ar)
      values (${filename}, ${mime}, ${filename}, ${width}, ${height}, ${sql.json(derivatives)}, ${altEn}, ${altAr}) returning id`;
    pictures[filename] = row!.id;
  };
  await picture("share-wide.webp", "image/webp", 2400, 1260, [400, 800, 1600], "A wide share picture", "صورة مشاركة عريضة");
  await picture("share-tiny.webp", "image/webp", 200, 100, []);
  await picture("share-vector.svg", "image/svg+xml", 0, 0, []);
  // The site's default share image names a picture deleted since (B.6).
  await sql`update site_settings set value = jsonb_set(value, '{ogImageId}', '999999') where key = 'seo'`;

  // Two pages created in the panel: one with no Arabic of its own, one unpublished.
  const page = async (slug: string, title: string, published: boolean) => {
    const [row] = await sql<{ id: number }[]>`
      insert into pages (slug, kind, title_en, title_ar, is_published) values (${slug}, 'custom', ${title}, '', ${published}) returning id`;
    ids[`page/${slug}`] = row!.id;
  };
  await page("seo-english-only", "English only", true);
  await page("seo-hidden", "SEO hidden page", false);

  await record("page", "about", ids["page/about"]!, {
    title_en: "About our desk",
    description_en: "Who we are and how we work.",
    og_title: "Meet Elite One Desk",
    og_image_id: pictures["share-wide.webp"]!,
  });
  await record("category", "business-setup", ids["category/business-setup"]!, {
    title_ar: "تأسيس الأعمال — عنوان البحث",
    og_title_ar: "شارك تأسيس الأعمال",
    canonical_url: "/services",
  });
  await record("service", "travel-tourism/air-ticket-booking", ids["service/air-ticket-booking"]!, {
    noindex: true,
    og_image_id: pictures["share-vector.svg"]!,
  });
  await record("package", "red-sea-sharm-el-sheikh", ids["package/red-sea-sharm-el-sheikh"]!, {
    title_en: "Sharm by the sea",
    og_image_id: pictures["share-tiny.webp"]!,
  });
  await record("destination", "egypt", ids["destination/egypt"]!, {
    description_en: "Egypt, from the pyramids to the Red Sea.",
    description_ar: "مصر، من الأهرامات إلى البحر الأحمر.",
    // Stored before Batch 25, when a foreign address was accepted.
    canonical_url: "https://other.example/egypt",
  });
  await record("page", "packages", null, { title_en: "Tours and itineraries" });
  await record("page", "seo-english-only", ids["page/seo-english-only"]!, { title_en: "English only, in its record" });
  await record("page", "seo-hidden", ids["page/seo-hidden"]!, { title_en: "Hidden page record", description_en: "Never shown." });
  // As the previous release writes a row: by address, bound to nothing.
  await record("category", "iqama-services", null, { title_en: "Iqama, by address" });

  server = await startServer(database, PORT);
  site = new URL((await en("/")).canonical ?? "").origin;
  assert.ok(site, "the homepage declares no canonical");
});

after(async () => {
  await server?.stop();
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
});

/**
 * The address a page is at, in one edition — as Next writes it: the English
 * homepage is the bare origin, with no trailing slash, in every tag.
 */
const at = (path: string, locale: "en" | "ar" = "en") =>
  locale === "ar" ? `${site}${path === "/" ? "/ar" : `/ar${path}`}` : path === "/" ? site : `${site}${path}`;

function assertAddresses(head: Head, path: string, locale: "en" | "ar") {
  assert.equal(head.canonical, at(path, locale), `${locale} ${path}: canonical`);
  assert.deepEqual(head.og["og:url"], [at(path, locale)], `${locale} ${path}: og:url`);
  assert.deepEqual(head.alternates, { en: at(path), ar: at(path, "ar"), "x-default": at(path) }, `${locale} ${path}: alternates`);
}

/* -------------------------------------------------------------------------- */

describe("25 · each page in each language: the record, then its own words, then the site's (§9, §10, §14)", () => {
  test("a CMS page: the record's English, and the page's own Arabic where the record has none", async () => {
    const english = await en("/about");
    assert.equal(english.status, 200);
    assert.equal(english.title, enTitle("About our desk"));
    assert.equal(english.description, "Who we are and how we work.");
    assert.deepEqual(english.og["og:title"], ["Meet Elite One Desk"]);
    assert.equal(english.twitter["twitter:title"], "Meet Elite One Desk");
    assert.deepEqual(english.og["og:description"], ["Who we are and how we work."]);

    const arabic = await ar("/about");
    assert.equal(arabic.status, 200);
    assert.equal(arabic.title, arTitle("من نحن"), "never the English record's title");
    assert.deepEqual(arabic.og["og:title"], [arTitle("من نحن")], "never the English share title over an Arabic page");
    assert.deepEqual(arabic.og["og:locale"], ["ar_SA"]);
    assert.deepEqual(arabic.og["og:locale:alternate"], ["en_US"]);
    assert.deepEqual(english.og["og:locale"], ["en_US"]);
    assert.deepEqual(english.og["og:locale:alternate"], ["ar_SA"]);
  });

  test("a category: its Arabic record and Arabic share title in Arabic; in English, its own title and words", async () => {
    const [own] = await sql<{ title_en: string; summary_en: string }[]>`select title_en, summary_en from service_categories where slug = 'business-setup'`;
    const english = await en("/services/business-setup");
    assert.equal(english.title, enTitle(own!.title_en));
    assert.ok(english.description?.startsWith(own!.summary_en.slice(0, 40)), english.description ?? "");
    assert.deepEqual(english.og["og:title"], [enTitle(own!.title_en)]);

    const arabic = await ar("/services/business-setup");
    assert.equal(arabic.title, arTitle("تأسيس الأعمال — عنوان البحث"));
    assert.deepEqual(arabic.og["og:title"], ["شارك تأسيس الأعمال"]);
    assert.equal(arabic.twitter["twitter:title"], "شارك تأسيس الأعمال");
  });

  test("the overviews: Tour packages from its record in English and its own Arabic words in Arabic; Services, with none, from its own words in both", async () => {
    assert.equal((await en("/packages")).title, enTitle("Tours and itineraries"));
    const packagesAr = await ar("/packages");
    assert.equal(packagesAr.title, arTitle("البرامج السياحية"));
    assert.ok(packagesAr.description && /[؀-ۿ]/.test(packagesAr.description), "the Arabic description is the overview's own Arabic");

    const services = await en("/services");
    assert.equal(services.title, enTitle("Services"));
    assert.match(services.description ?? "", /^Every Elite One Desk service:/);
    const servicesAr = await ar("/services");
    assert.equal(servicesAr.title, arTitle("الخدمات"));
    assert.match(servicesAr.description ?? "", /^جميع خدمات إيليت ون ديسك/);
  });

  test("a page with no Arabic at all: its English record stands in on the Arabic page, ahead of its raw English title", async () => {
    assert.equal((await en("/seo-english-only")).title, enTitle("English only, in its record"));
    assert.equal((await ar("/seo-english-only")).title, arTitle("English only, in its record"));
  });

  test("nothing of its own: the page's own title, then the site's default title and description — the homepage's are the defaults", async () => {
    const contact = await en("/contact");
    assert.equal(contact.title, enTitle("Contact"));
    assert.equal(contact.description, DEFAULT_DESCRIPTION_EN);
    const contactAr = await ar("/contact");
    assert.equal(contactAr.title, arTitle("تواصل معنا"));
    assert.equal(contactAr.description, DEFAULT_DESCRIPTION_AR);

    const home = await en("/");
    assert.equal(home.title, DEFAULT_TITLE_EN, "a title already holding the site name is not given it twice");
    assert.equal(home.description, DEFAULT_DESCRIPTION_EN);
    const homeAr = await ar("/");
    assert.equal(homeAr.title, DEFAULT_TITLE_AR);
    assert.equal(homeAr.description, DEFAULT_DESCRIPTION_AR);
  });

  test("a row the previous release wrote by address is used by both editions, as that release used it", async () => {
    assert.equal((await en("/services/iqama-services")).title, enTitle("Iqama, by address"));
    assert.equal((await ar("/services/iqama-services")).title, arTitle("خدمات الإقامة والموظفين"), "and the Arabic page keeps its own Arabic");
  });

  test("a destination: its record's description in each language", async () => {
    assert.equal((await en("/packages/egypt")).description, "Egypt, from the pyramids to the Red Sea.");
    assert.equal((await ar("/packages/egypt")).description, "مصر، من الأهرامات إلى البحر الأحمر.");
  });
});

describe("25 · canonical, alternates and robots (§15, §16)", () => {
  test("each page is its own canonical in its own language, and names both editions", async () => {
    for (const path of ["/", "/about", "/services", "/packages", "/services/travel-tourism", "/services/travel-tourism/hotel-reservation", "/packages/cairo-and-giza-classic"]) {
      assertAddresses(await en(path), path, "en");
      assertAddresses(await ar(path), path, "ar");
    }
  });

  test("an override names a page of this site, drawn in the language being rendered", async () => {
    assert.equal((await en("/services/business-setup")).canonical, at("/services"));
    assert.equal((await ar("/services/business-setup")).canonical, at("/services", "ar"));
  });

  test("a stored canonical that would be refused today is ignored, never emitted", async () => {
    const egypt = await en("/packages/egypt");
    assert.equal(egypt.canonical, at("/packages/egypt"));
    assert.ok(!egypt.html.includes("other.example"), "the foreign address reached the page");
  });

  test("no query string reaches a canonical or og:url — not a preview flag, not a tracking parameter", async () => {
    for (const query of ["?preview=1", "?utm_source=newsletter", "?compare=published"]) {
      const head = await en(`/about${query}`);
      assert.equal(head.status, 200, query);
      assertAddresses(head, "/about", "en");
    }
  });

  test("/home is the homepage under another address: the same title, description and canonical as /; /en/… is a 301 to the clean address", async () => {
    for (const [locale, path] of [["en", "/home"], ["ar", "/ar/home"]] as const) {
      const home = await fetchHead(server.origin, path);
      const root = await (locale === "en" ? en("/") : ar("/"));
      assert.equal(home.status, 200, path);
      assert.equal(home.title, root.title, path);
      assert.equal(home.description, root.description, path);
      assert.equal(home.canonical, at("/", locale), path);
      assert.deepEqual(home.alternates, root.alternates, path);
    }
    const redirected = await fetch(`${server.origin}/en/about`, { redirect: "manual" });
    assert.equal(redirected.status, 301);
    assert.equal(new URL(redirected.headers.get("location") ?? "").pathname, "/about");
  });

  test("noindex where a record or the route says so — a record's page and search results — and indexable everywhere else", async () => {
    assert.equal((await en("/services/travel-tourism/air-ticket-booking")).robots, "noindex, follow");
    assert.equal((await ar("/services/travel-tourism/air-ticket-booking")).robots, "noindex, follow");
    assert.equal((await en("/search")).robots, "noindex, follow");
    assert.equal((await ar("/search")).robots, "noindex, follow");
    for (const path of ["/", "/about", "/services", "/packages", "/packages/egypt", "/services/business-setup"]) {
      assert.equal((await en(path)).robots, "index, follow, max-image-preview:large", path);
    }
  });
});

describe("25 · the share image (B.4, B.6)", () => {
  test("the record's picture at its 1600 rendition, its real size and its alt text in each language — one picture for both editions", async () => {
    const english = await en("/about");
    const arabic = await ar("/about");
    const url = `${site}/media/share-wide@1600.webp`;
    for (const [head, alt] of [[english, "A wide share picture"], [arabic, "صورة مشاركة عريضة"]] as const) {
      assert.deepEqual(head.og["og:image"], [url]);
      assert.deepEqual(head.og["og:image:width"], ["1600"]);
      assert.deepEqual(head.og["og:image:height"], ["840"]);
      assert.deepEqual(head.og["og:image:alt"], [alt]);
      assert.equal(head.twitter["twitter:card"], "summary_large_image");
      assert.equal(head.twitter["twitter:image"], url);
    }
  });

  test("a picture too small for a large card is declared at its size, and X is asked for a small card", async () => {
    const head = await en("/packages/red-sea-sharm-el-sheikh");
    assert.deepEqual(head.og["og:image"], [`${site}/media/share-tiny.webp`]);
    assert.deepEqual(head.og["og:image:width"], ["200"]);
    assert.deepEqual(head.og["og:image:height"], ["100"]);
    assert.equal(head.twitter["twitter:card"], "summary");
  });

  test("an SVG is passed over, and so is a site default deleted since — the static picture, at its real size, is what is left", async () => {
    const head = await en("/services/travel-tourism/air-ticket-booking");
    assert.deepEqual(head.og["og:image"], [`${site}/brand/og-default.jpg`]);
    assert.deepEqual(head.og["og:image:width"], ["1200"]);
    assert.deepEqual(head.og["og:image:height"], ["630"]);
    assert.ok(!head.html.includes("share-vector.svg"), "the SVG was named");
  });

  test("with no picture in its record, the page's own; with none of its own, the site default — once it exists", async () => {
    const category = await en("/services/travel-tourism");
    assert.deepEqual(category.og["og:image"], [`${site}/media/travel-tourism.webp`]);
    assert.deepEqual(category.og["og:image:width"], ["1400"]);

    assert.deepEqual((await en("/contact")).og["og:image"], [`${site}/brand/og-default.jpg`]);
    // Site settings are read per request: no cache stands between this and the page.
    await sql`update site_settings set value = jsonb_set(value, '{ogImageId}', '9') where key = 'seo'`;
    try {
      assert.deepEqual((await en("/contact")).og["og:image"], [`${site}/media/one-desk.webp`]);
      assert.deepEqual((await ar("/contact")).og["og:image"], [`${site}/media/one-desk.webp`]);
    } finally {
      await sql`update site_settings set value = jsonb_set(value, '{ogImageId}', '999999') where key = 'seo'`;
    }
  });
});

describe("25 · structured data is the page's own, never the record's (§12)", () => {
  test("a package's TouristTrip and breadcrumb name the package and its address in each language; its record changes only its metadata", async () => {
    const [own] = await sql<{ title_en: string; title_ar: string }[]>`select title_en, title_ar from travel_packages where slug = 'red-sea-sharm-el-sheikh'`;
    for (const locale of ["en", "ar"] as const) {
      const head = await (locale === "en" ? en : ar)("/packages/red-sea-sharm-el-sheikh");
      const nodes = jsonLdOf(head.html);
      const trip = nodes.find((node) => node["@type"] === "TouristTrip");
      assert.equal(trip?.name, locale === "en" ? own!.title_en : own!.title_ar, locale);
      const crumbs = nodes.find((node) => node["@type"] === "BreadcrumbList") as { itemListElement: Array<{ item: string }> } | undefined;
      assert.equal(crumbs?.itemListElement.at(-1)?.item, at("/packages/red-sea-sharm-el-sheikh", locale), locale);
      assert.ok(!JSON.stringify(nodes).includes("Sharm by the sea"), `${locale}: the record's title reached the structured data`);
    }
    assert.equal((await en("/packages/red-sea-sharm-el-sheikh")).title, enTitle("Sharm by the sea"));
  });
});

describe("25 · public and preview stay apart (§11)", () => {
  test("an unpublished page answers 404 and carries nothing of its record — not even to its editor's preview", async () => {
    const anonymous = await en("/seo-hidden");
    assert.equal(anonymous.status, 404);
    assert.ok(!anonymous.html.includes("Hidden page record") && !anonymous.html.includes("Never shown."), "the record rode along with the 404");
    assert.ok(!anonymous.html.includes("SEO hidden page"), "the page's own title rode along with the 404");

    const preview = await fetchHead(server.origin, "/seo-hidden?preview=1", owner.cookie);
    assert.equal(preview.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
    assert.match(preview.headers.get("cache-control") ?? "", /private, no-store/);
    assert.ok(!preview.html.includes("Hidden page record") && !preview.html.includes("Never shown."), "a preview's metadata carried the record");
  });

  test("a preview is private, with the published metadata and no query in any address", async () => {
    const preview = await fetchHead(server.origin, "/about?preview=1", owner.cookie);
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
    assert.match(preview.headers.get("cache-control") ?? "", /private, no-store/);
    assert.equal(preview.title, enTitle("About our desk"));
    assertAddresses(preview, "/about", "en");
    const metadata = [preview.canonical, ...Object.values(preview.alternates), ...Object.values(preview.og).flat(), ...Object.values(preview.twitter)];
    assert.ok(!metadata.some((value) => value?.includes("preview")), "a preview parameter reached the metadata");
  });
});

describe("25 · sitemap and robots.txt (§15, §17)", () => {
  test("the sitemap lists what is published, in both languages — SEO records change nothing in it", async () => {
    const xml = (await get(server.origin, "/sitemap.xml")).html;
    const listed = new Set([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => new URL(match[1]!).pathname));
    for (const path of [
      "/",
      "/about",
      "/services",
      "/packages",
      "/seo-english-only",
      "/services/business-setup",
      "/services/iqama-services",
      // Marked noindex on the SEO screen and still listed (A.14 F6j — recorded, not changed here).
      "/services/travel-tourism/air-ticket-booking",
      "/packages/egypt",
      "/packages/red-sea-sharm-el-sheikh",
    ]) {
      assert.ok(listed.has(path), `${path} is missing`);
      assert.ok(listed.has(path === "/" ? "/ar" : `/ar${path}`), `/ar${path} is missing`);
    }
    for (const path of ["/home", "/search", "/seo-hidden", "/ar/home", "/ar/search", "/ar/seo-hidden"]) {
      assert.ok(!listed.has(path), `${path} is listed`);
    }
    assert.ok(![...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].some((match) => match[1]!.includes("?")), "an address with a query is listed");
  });

  test("robots.txt: everything but the admin, the API and the resized media files; the sitemap at the site's own address", async () => {
    const robots = (await get(server.origin, "/robots.txt")).html;
    assert.match(robots, /^User-Agent: \*$/m);
    assert.match(robots, /^Allow: \/$/m);
    for (const rule of ["/admin", "/api/", "/media/*@*"]) assert.ok(robots.includes(`Disallow: ${rule}\n`), rule);
    assert.equal(robots.match(/^User-Agent:/gm)?.length, 1, "one group for every crawler");
    // robots.txt is prerendered at build time (build-isolation.test.ts), so its
    // origin is the one the build was given, and its sitemap is named at it.
    const host = /^Host: (.+)$/m.exec(robots)?.[1] ?? "";
    assert.match(host, /^https?:\/\/[^/\s]+$/, "robots.txt names the site's origin");
    assert.ok(robots.includes(`Sitemap: ${host}/sitemap.xml\n`), robots);
    // A build given the address puts that same one on every page, as production
    // does (one .env feeds both). Only a build given none — CI's — leaves the pages
    // naming the server's runtime address, which a static file cannot know.
    if (site !== server.origin) assert.equal(host, site, "robots.txt and the pages name different origins");
  });
});

describe("25 · the other edition is named only while it exists (B.18, F6n)", () => {
  /** Settings → Features, as stored, then Settings → Maintenance → Refresh caches, as an admin presses it. */
  async function setArabic(on: boolean) {
    await sql`update site_settings set value = jsonb_set(value, '{arabicEnabled}', to_jsonb(${on}::boolean)) where key = 'features'`;
    const route = "/admin/settings?tab=maintenance";
    const page = await get(server.origin, route, { cookie: owner.cookie });
    const result = await submitForm(server.origin, route, formContaining(page.html, "Refresh caches"), owner.cookie);
    assert.match(result.html, /Every cache was dropped/);
  }

  test("with Arabic switched off an English page names no Arabic alternate and no Arabic share locale; switched back on, both return", async () => {
    await setArabic(false);
    try {
      const off = await en("/about");
      assert.deepEqual(off.alternates, { en: at("/about"), "x-default": at("/about") });
      assert.equal(off.og["og:locale:alternate"], undefined);
      assert.deepEqual(off.og["og:locale"], ["en_US"]);
    } finally {
      await setArabic(true);
    }
    const on = await en("/about");
    assert.deepEqual(on.alternates, { en: at("/about"), ar: at("/about", "ar"), "x-default": at("/about") });
    assert.deepEqual(on.og["og:locale:alternate"], ["ar_SA"]);
  });
});

describe("25 · a change is live at the next request (§18)", () => {
  type Answer = { ok: boolean; message?: string };
  const seo = async (action: "saveSeo" | "clearSeo", fields: Record<string, string | number>) => {
    const data = new FormData();
    data.set("_csrf", owner.csrfToken);
    for (const [key, value] of Object.entries(fields)) data.set(key, String(value));
    const response = await callAction<Answer>({ origin: server.origin, route: "/admin/seo", file: SEO_ACTIONS, action, args: [{ ok: false }, data], cookie: owner.cookie });
    assert.ok(response.value?.ok, `${action}: ${response.value?.message ?? response.text.slice(0, 300)}`);
  };

  test("a save and a removal on the SEO screen reach both editions at once, with nothing refreshed", async () => {
    const target = `page:${ids["page/contact"]}`;
    assert.equal((await en("/contact")).title, enTitle("Contact"));
    await seo("saveSeo", withSeoChanges(await openSeoForm(sql, server.origin, owner.cookie, target), { titleEn: "Talk to us", titleAr: "تحدث إلينا" }));
    assert.equal((await en("/contact")).title, enTitle("Talk to us"));
    assert.equal((await ar("/contact")).title, arTitle("تحدث إلينا"));

    const opened = await openSeoForm(sql, server.origin, owner.cookie, target);
    await seo("clearSeo", { target, _base: opened._base! });
    assert.equal((await en("/contact")).title, enTitle("Contact"));
    assert.equal((await ar("/contact")).title, arTitle("تواصل معنا"));
  });
});
