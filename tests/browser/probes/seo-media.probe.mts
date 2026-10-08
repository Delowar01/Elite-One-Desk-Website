/**
 * Batch 25: search and sharing settings, and the pictures they use, in a real
 * Chromium (docs/admin/seo-and-share-images.md; brief §28).
 *
 *   S1   an owner signs in through the form and reaches the SEO screen
 *   S2   the Tour packages overview's settings are made on that screen
 *   S3   /packages says so in English
 *   S4   …and in Arabic, from the Arabic fields
 *   S5   a destination's settings are made
 *   S6   its page says so in both languages
 *   S7   its address changes on the Destinations form — the settings follow it
 *   S8   two pictures are uploaded, and one becomes its share image
 *   S9   the Media screen refuses to delete that picture, and says where it is used
 *   S10  the share image is replaced, then removed — each picture let go as it is
 *   S11  both pictures, used nowhere now, are deleted
 *   S12  a package's metadata and structured data are as they were
 *   S13  the Services overview's settings — its visible heading untouched
 *   S14  search results stay out of search engines
 *   S15  a Visual Editor draft reaches no public title, description or JSON-LD
 *   S16  a preview is private: noindex, never stored, no query in its canonical
 *
 * Every write goes through the screens, and every outcome is read back from
 * the public page as a browser receives it and from the database.
 */

import sharp from "sharp";

import { callAction } from "../../helpers/action";
import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";
import { until } from "../wait";

import { documentEditorKey, editorKeyOf, type RouteOwner } from "../../../src/lib/routes/owners";

import type { Page } from "playwright";

const PORT = 3739;
const EMAIL = "owner@test.invalid";
// The seed's test-only owner password (tests/helpers/env.ts) — never a real one.
const PASSWORD = "IntegrationOwner!2026";
const VE = { route: "/admin/visual-editor", file: "app/(backoffice)/admin/visual-editor/route-actions.ts" };

const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("seo_media_probe");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);
  const origin = server.origin;
  const errors: string[] = [];

  // tsx names the functions it compiles (`__name(fn, "fn")`), and the reader
  // below hands one to `evaluate`: the same shim the hardening probe installs.
  const contextWith = async (viewport: { width: number; height: number }) => {
    const context = await browser.newContext({ viewport });
    await context.addInitScript({ content: "window.__name = window.__name || ((fn) => fn);" });
    return context;
  };
  const admin = await (await contextWith({ width: 1440, height: 1000 })).newPage();
  admin.on("pageerror", (error) => errors.push(`admin: ${error.message.slice(0, 160)}`));
  admin.on("dialog", (dialog) => void dialog.accept());
  const visitor = await (await contextWith({ width: 1280, height: 900 })).newPage();
  visitor.on("pageerror", (error) => errors.push(`visitor: ${error.message.slice(0, 160)}`));

  /** What a page declares about itself, read from the live document. */
  const headOf = async (page: Page, path: string) => {
    const response = await page.goto(`${origin}${path}`, { waitUntil: "load" });
    const head = await page.evaluate(() => {
      const meta = (selector: string) => document.querySelector<HTMLMetaElement>(selector)?.content ?? null;
      return {
        title: document.title,
        description: meta('meta[name="description"]'),
        robots: meta('meta[name="robots"]'),
        canonical: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.getAttribute("href") ?? null,
        ogTitle: meta('meta[property="og:title"]'),
        ogImage: meta('meta[property="og:image"]'),
        ogImageWidth: meta('meta[property="og:image:width"]'),
        twitterTitle: meta('meta[name="twitter:title"]'),
        lang: document.documentElement.lang,
        dir: document.documentElement.dir,
        jsonLd: [...document.querySelectorAll('script[type="application/ld+json"]')].flatMap((node) => {
          const parsed = JSON.parse(node.textContent ?? "null") as unknown;
          return (Array.isArray(parsed) ? parsed : [parsed]) as Array<Record<string, unknown>>;
        }),
        body: document.body.innerText,
      };
    });
    return { status: response?.status() ?? 0, headers: response?.headers() ?? {}, ...head };
  };

  /** The SEO screen, opened at one target, and its form's fields. */
  const seoForm = async (ref: string) => {
    await admin.goto(`${origin}/admin/seo?target=${encodeURIComponent(ref)}`, { waitUntil: "load" });
    const row = admin.locator(`[data-seo-target="${ref}"]`);
    await row.locator('input[name="titleEn"]').waitFor({ timeout: 30_000 });
    return row;
  };
  const saveSeo = async (row: ReturnType<Page["locator"]>) => {
    await row.getByRole("button", { name: "Save", exact: true }).click();
    const banner = row.getByRole("status").first();
    await until(async () => ((await banner.textContent().catch(() => "")) ?? "").trim().length > 0, 20_000);
    return ((await banner.textContent()) ?? "").trim();
  };
  const seoRow = async (type: string, id: number | null, key?: string) =>
    (
      await sql<{ entity_key: string; entity_id: number | null; title_en: string; title_ar: string; og_image_id: number | null }[]>`
        select entity_key, entity_id, title_en, title_ar, og_image_id from seo_metadata
         where entity_type = ${type} and ${id === null ? sql`entity_id is null and entity_key = ${key!}` : sql`entity_id = ${id}`}`
    )[0];

  /** A picture's card on the Media screen: its usage line, and its delete. */
  const card = (filename: string) => admin.locator("li.admin-card").filter({ has: admin.locator(`p[title="${filename}"]`) });
  const usageOf = async (filename: string) => {
    await admin.goto(`${origin}/admin/media`, { waitUntil: "load" });
    return ((await card(filename).locator("p", { hasText: /Used in|Not placed/ }).first().textContent()) ?? "").trim();
  };
  const pictureRow = async (title: string) =>
    (await sql<{ id: number; filename: string }[]>`select id, filename from media where title = ${title}`)[0];

  const site = new URL((await headOf(visitor, "/")).canonical ?? "").origin;
  const [{ id: egypt }] = await sql<{ id: number }[]>`select id from package_destinations where slug = 'egypt'`;
  const [cairo] = await sql<{ id: number; title_en: string; title_ar: string }[]>`
    select id, title_en, title_ar from travel_packages where slug = 'cairo-and-giza-classic'`;

  /* ------------------------------------------------------------------ */
  /* S1 — sign in                                                         */
  /* ------------------------------------------------------------------ */
  await admin.goto(`${origin}/admin/login?next=${encodeURIComponent("/admin/seo")}`, { waitUntil: "load" });
  await admin.getByLabel("Email address").fill(EMAIL);
  await admin.getByLabel("Password").fill(PASSWORD);
  await admin.getByRole("button", { name: "Sign in" }).click();
  const landed = await until(async () => new URL(admin.url()).pathname === "/admin/seo" && (await admin.locator("[data-seo-target]").count()) > 0, 30_000);
  const targets = await admin.locator("[data-seo-target]").count();
  const groups = await admin.locator("[data-seo-group]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-seo-group")));
  say(
    "S1. an owner signs in through the form and lands on the SEO screen: every address, grouped, with the site defaults shown",
    landed && targets === 93 && groups.join(",") === "page,overview,category,service,destination,package" && (await admin.locator("[data-seo-site-defaults]").count()) === 1,
    `${targets} targets: ${groups.join(",")}`,
  );

  /* ------------------------------------------------------------------ */
  /* S2–S4 — the Tour packages overview                                   */
  /* ------------------------------------------------------------------ */
  let row = await seoForm("packageIndex:1");
  await row.locator('input[name="titleEn"]').fill("Tour packages from Cairo to the Red Sea");
  await row.locator('input[name="titleAr"]').fill("برامج سياحية من القاهرة إلى البحر الأحمر");
  await row.locator('textarea[name="descriptionEn"]').fill("Ready itineraries across Egypt, every one of them adjustable.");
  await row.locator('textarea[name="descriptionAr"]').fill("برامج جاهزة في أنحاء مصر، وكلها قابلة للتعديل.");
  const packagesSaved = await saveSeo(row);
  const packagesRow = await seoRow("page", null, "packages");
  say(
    "S2. the Tour packages overview's settings are saved on the SEO screen, by reference, under its own key",
    packagesSaved === "SEO saved." && packagesRow?.title_en === "Tour packages from Cairo to the Red Sea" && packagesRow.entity_id === null,
    packagesSaved,
  );

  const packagesEn = await headOf(visitor, "/packages");
  say(
    "S3. /packages says so in English: title, description, canonical, share title",
    packagesEn.title === "Tour packages from Cairo to the Red Sea · Elite One Desk" &&
      packagesEn.description === "Ready itineraries across Egypt, every one of them adjustable." &&
      packagesEn.canonical === `${site}/packages` &&
      packagesEn.ogTitle === packagesEn.title,
    JSON.stringify({ title: packagesEn.title, canonical: packagesEn.canonical }),
  );
  const packagesAr = await headOf(visitor, "/ar/packages");
  say(
    "S4. …and in Arabic, from the Arabic fields, on an RTL page whose canonical is its own",
    packagesAr.title === "برامج سياحية من القاهرة إلى البحر الأحمر · إيليت ون ديسك" &&
      packagesAr.description === "برامج جاهزة في أنحاء مصر، وكلها قابلة للتعديل." &&
      packagesAr.canonical === `${site}/ar/packages` &&
      packagesAr.lang === "ar" &&
      packagesAr.dir === "rtl",
    JSON.stringify({ title: packagesAr.title, canonical: packagesAr.canonical, lang: packagesAr.lang }),
  );

  /* ------------------------------------------------------------------ */
  /* S5–S7 — a destination, and its new address                           */
  /* ------------------------------------------------------------------ */
  row = await seoForm(`destination:${egypt}`);
  await row.locator('input[name="titleEn"]').fill("Egypt, from Cairo to Aswan");
  await row.locator('textarea[name="descriptionEn"]').fill("Pyramids, the Nile and the Red Sea, in ready itineraries.");
  await row.locator('textarea[name="descriptionAr"]').fill("الأهرامات والنيل والبحر الأحمر في برامج جاهزة.");
  await row.locator('input[name="ogTitleAr"]').fill("مصر مع إيليت ون ديسك");
  const destinationSaved = await saveSeo(row);
  const destinationRow = await seoRow("destination", egypt);
  say(
    "S5. a destination's settings are saved, bound to the destination itself",
    destinationSaved === "SEO saved." && destinationRow?.entity_key === "egypt" && destinationRow.entity_id === egypt,
    destinationSaved,
  );

  const egyptEn = await headOf(visitor, "/packages/egypt");
  const egyptAr = await headOf(visitor, "/ar/packages/egypt");
  say(
    "S6. its page says so in English, and in Arabic keeps its own Arabic name with its Arabic description and share title",
    egyptEn.title === "Egypt, from Cairo to Aswan · Elite One Desk" &&
      egyptEn.description === "Pyramids, the Nile and the Red Sea, in ready itineraries." &&
      egyptAr.title === "مصر · إيليت ون ديسك" &&
      egyptAr.description === "الأهرامات والنيل والبحر الأحمر في برامج جاهزة." &&
      egyptAr.ogTitle === "مصر مع إيليت ون ديسك",
    JSON.stringify({ en: egyptEn.title, ar: egyptAr.title, ogAr: egyptAr.ogTitle }),
  );

  await admin.goto(`${origin}/admin/packages/destinations/${egypt}`, { waitUntil: "load" });
  await admin.locator("#slug").fill("egypt-tours");
  await admin.getByRole("button", { name: "Save changes" }).click();
  const renamed = await until(async () => ((await admin.getByRole("status").first().textContent().catch(() => "")) ?? "").includes("Destination saved."), 20_000);
  const moved = await sql<{ entity_key: string; entity_id: number | null }[]>`
    select entity_key, entity_id from seo_metadata where entity_type = 'destination'`;
  const atNew = await headOf(visitor, "/packages/egypt-tours");
  const atOld = await headOf(visitor, "/packages/egypt");
  await seoForm(`destination:${egypt}`);
  const listed = (await admin.locator(`[data-seo-target="destination:${egypt}"]`).textContent()) ?? "";
  say(
    "S7. the address changes on the Destinations form: the settings follow the destination — one record, at the new address — and the old address answers 404",
    renamed &&
      moved.length === 1 &&
      moved[0]!.entity_key === "egypt-tours" &&
      moved[0]!.entity_id === egypt &&
      atNew.status === 200 &&
      atNew.title === "Egypt, from Cairo to Aswan · Elite One Desk" &&
      atNew.canonical === `${site}/packages/egypt-tours` &&
      atOld.status === 404 &&
      listed.includes("/packages/egypt-tours") &&
      listed.includes("Custom"),
    JSON.stringify({ rows: moved, newStatus: atNew.status, oldStatus: atOld.status }),
  );

  /* ------------------------------------------------------------------ */
  /* S8–S11 — a share image, its guard, and letting it go                 */
  /* ------------------------------------------------------------------ */
  const upload = async (title: string, background: { r: number; g: number; b: number }) => {
    const buffer = await sharp({ create: { width: 2400, height: 1260, channels: 3, background } }).png().toBuffer();
    await admin.goto(`${origin}/admin/media`, { waitUntil: "load" });
    await admin.locator("#files").setInputFiles({ name: `${title.toLowerCase().replace(/\W+/g, "-")}.png`, mimeType: "image/png", buffer });
    await admin.locator("#title").fill(title);
    await admin.getByRole("button", { name: "Upload", exact: true }).click();
    await until(async () => Boolean(await pictureRow(title)), 30_000);
    return (await pictureRow(title))!;
  };
  const pictureA = await upload("Share picture A", { r: 200, g: 120, b: 40 });
  const pictureB = await upload("Share picture B", { r: 40, g: 120, b: 200 });
  const choose = async (title: string) => {
    row = await seoForm(`destination:${egypt}`);
    await row.getByRole("button", { name: /^(Choose|Change) share image$/ }).click();
    const dialog = admin.getByRole("dialog", { name: "Choose Share image" });
    await dialog.getByPlaceholder("Search the library").fill(title);
    await dialog.getByRole("button", { name: title }).click();
    return saveSeo(row);
  };
  const chosen = await choose("Share picture A");
  const sharedEn = await headOf(visitor, "/packages/egypt-tours");
  const sharedAr = await headOf(visitor, "/ar/packages/egypt-tours");
  const urlA = `${site}/media/${pictureA.filename.replace(/\.[^.]+$/, "")}@1600.webp`;
  say(
    "S8. two pictures are uploaded; one becomes the destination's share image — its 1600 rendition, at its real width, in both languages",
    chosen === "SEO saved." && sharedEn.ogImage === urlA && sharedEn.ogImageWidth === "1600" && sharedAr.ogImage === urlA,
    JSON.stringify({ chosen, image: sharedEn.ogImage, width: sharedEn.ogImageWidth }),
  );

  await admin.goto(`${origin}/admin/media`, { waitUntil: "load" });
  await card(pictureA.filename).getByRole("button", { name: "Delete" }).click();
  const alert = card(pictureA.filename).getByRole("alert");
  const told = await until(async () => ((await alert.textContent().catch(() => "")) ?? "").length > 0, 20_000);
  const reason = ((await alert.textContent().catch(() => "")) ?? "").trim();
  const stillThere = Boolean(await pictureRow("Share picture A"));
  say(
    "S9. the Media screen refuses to delete it, and says where it is used — the picture and its file stay",
    told && reason === "Still in use on 1 screen: Egypt — search and sharing image. Remove it there first." && stillThere && (await usageOf(pictureA.filename)) === "Used in 1 place",
    reason,
  );

  const replaced = await choose("Share picture B");
  const replacedHead = await headOf(visitor, "/packages/egypt-tours");
  const afterReplace = [await usageOf(pictureA.filename), await usageOf(pictureB.filename)];
  row = await seoForm(`destination:${egypt}`);
  await row.getByRole("button", { name: "Remove share image" }).click();
  const removed = await saveSeo(row);
  const afterRemove = await usageOf(pictureB.filename);
  const removedRow = await seoRow("destination", egypt);
  say(
    "S10. replaced by the second picture, the first is let go and the second taken; removed, the second is let go too — the rest of the settings stay",
    replaced === "SEO saved." &&
      replacedHead.ogImage?.includes(pictureB.filename.replace(/\.[^.]+$/, "")) === true &&
      afterReplace.join(" | ") === "Not placed anywhere yet | Used in 1 place" &&
      removed === "SEO saved." &&
      afterRemove === "Not placed anywhere yet" &&
      removedRow?.og_image_id === null &&
      removedRow.title_en === "Egypt, from Cairo to Aswan",
    JSON.stringify({ afterReplace, afterRemove }),
  );

  const deleteOnScreen = async (filename: string) => {
    await admin.goto(`${origin}/admin/media`, { waitUntil: "load" });
    await card(filename).getByRole("button", { name: "Delete" }).click();
    return until(async () => (await card(filename).count()) === 0, 20_000);
  };
  const goneA = await deleteOnScreen(pictureA.filename);
  const goneB = await deleteOnScreen(pictureB.filename);
  const fallback = await headOf(visitor, "/packages/egypt-tours");
  say(
    "S11. both pictures, used nowhere now, are deleted; the page's share image falls back to the site's own picture",
    goneA && goneB && !(await pictureRow("Share picture A")) && !(await pictureRow("Share picture B")) && fallback.ogImage === `${site}/brand/og-default.jpg`,
    JSON.stringify({ goneA, goneB, image: fallback.ogImage }),
  );

  /* ------------------------------------------------------------------ */
  /* S12 — a package, as it was                                           */
  /* ------------------------------------------------------------------ */
  const packageEn = await headOf(visitor, "/packages/cairo-and-giza-classic");
  const packageAr = await headOf(visitor, "/ar/packages/cairo-and-giza-classic");
  const tripOf = (head: typeof packageEn) => head.jsonLd.find((node) => node["@type"] === "TouristTrip");
  const lastCrumb = (head: typeof packageEn) =>
    (head.jsonLd.find((node) => node["@type"] === "BreadcrumbList") as { itemListElement?: Array<{ item: string }> } | undefined)?.itemListElement?.at(-1)?.item;
  say(
    "S12. a package with no settings of its own: its title, canonical, TouristTrip and breadcrumb in both languages, as before",
    packageEn.title === `${cairo!.title_en} · Elite One Desk` &&
      packageEn.canonical === `${site}/packages/cairo-and-giza-classic` &&
      tripOf(packageEn)?.name === cairo!.title_en &&
      lastCrumb(packageEn) === `${site}/packages/cairo-and-giza-classic` &&
      packageAr.title === `${cairo!.title_ar} · إيليت ون ديسك` &&
      tripOf(packageAr)?.name === cairo!.title_ar &&
      lastCrumb(packageAr) === `${site}/ar/packages/cairo-and-giza-classic`,
    JSON.stringify({ en: packageEn.title, trip: tripOf(packageEn)?.name, crumb: lastCrumb(packageAr) }),
  );

  /* ------------------------------------------------------------------ */
  /* S13 — the Services overview                                          */
  /* ------------------------------------------------------------------ */
  await headOf(visitor, "/services");
  const h1Before = await visitor.locator("h1").first().textContent();
  row = await seoForm("serviceIndex:1");
  await row.locator('input[name="titleEn"]').fill("Every service, at one desk");
  await row.locator('input[name="titleAr"]').fill("كل الخدمات في مكتب واحد");
  const servicesSaved = await saveSeo(row);
  const servicesEn = await headOf(visitor, "/services");
  const h1After = await visitor.locator("h1").first().textContent();
  const servicesAr = await headOf(visitor, "/ar/services");
  say(
    "S13. the Services overview's settings, in both languages — and the heading a visitor reads is the overview's own, unchanged",
    servicesSaved === "SEO saved." &&
      servicesEn.title === "Every service, at one desk · Elite One Desk" &&
      servicesAr.title === "كل الخدمات في مكتب واحد · إيليت ون ديسك" &&
      h1Before === h1After &&
      !String(h1After).includes("Every service, at one desk"),
    JSON.stringify({ title: servicesEn.title, h1: h1After }),
  );

  /* ------------------------------------------------------------------ */
  /* S14 — search                                                         */
  /* ------------------------------------------------------------------ */
  const search = await headOf(visitor, "/search");
  const searchAr = await headOf(visitor, "/ar/search");
  const sitemap = await (await fetch(`${origin}/sitemap.xml`)).text();
  say(
    "S14. search results stay noindex in both languages, are left out of the sitemap, and have no SEO target",
    search.robots === "noindex, follow" &&
      searchAr.robots === "noindex, follow" &&
      !/<loc>[^<]*\/search<\/loc>/.test(sitemap) &&
      (await (async () => {
        await admin.goto(`${origin}/admin/seo`, { waitUntil: "load" });
        return admin.locator('[data-seo-target^="search"]').count();
      })()) === 0,
    JSON.stringify({ en: search.robots, ar: searchAr.robots }),
  );

  /* ------------------------------------------------------------------ */
  /* S15–S16 — drafts and previews                                        */
  /* ------------------------------------------------------------------ */
  const DRAFT = "Draft title, not yet published";
  const form = (fields: Record<string, string | number>) => {
    const data = new FormData();
    data.set("_csrf", owner.csrfToken);
    for (const [key, value] of Object.entries(fields)) data.set(key, String(value));
    return data;
  };
  const call = async <T,>(action: string, args: unknown[]) => (await callAction<T>({ ...VE, origin, action, args, cookie: owner.cookie })).value;
  const hero: RouteOwner = { type: "packageHero", id: cairo!.id };
  const pageId = documentEditorKey({ kind: "package", id: cairo!.id });
  const loaded = await call<{ ok: boolean; section: { revision: number; values: Record<string, unknown> } }>("loadRouteRegion", [editorKeyOf(hero), pageId]);
  const values = loaded!.section.values;
  const drafted = await call<{ ok: boolean }>("saveRouteRegionDraft", [
    form({
      sectionId: editorKeyOf(hero),
      pageId,
      expectedRevision: loaded!.section.revision,
      values: JSON.stringify({ ...values, title: { ...(values.title as object), en: DRAFT } }),
    }),
  ]);
  const publicPage = await headOf(visitor, "/packages/cairo-and-giza-classic");
  const leaked = [publicPage.title, publicPage.description, publicPage.ogTitle, publicPage.twitterTitle, JSON.stringify(publicPage.jsonLd), publicPage.body].some((text) =>
    String(text).includes(DRAFT),
  );
  const ownPreview = await headOf(admin, "/packages/cairo-and-giza-classic?preview=1");
  say(
    "S15. a Visual Editor draft of the package's title reaches no public title, description, share tag, JSON-LD or page — and the editor's own preview keeps the published title in its metadata",
    drafted?.ok === true && !leaked && ownPreview.body.includes(DRAFT) && !ownPreview.title.includes(DRAFT) && ownPreview.title === `${cairo!.title_en} · Elite One Desk`,
    JSON.stringify({ drafted: drafted?.ok, previewTitle: ownPreview.title }),
  );

  const anonymousPreview = await headOf(visitor, "/packages/cairo-and-giza-classic?preview=1");
  say(
    "S16. a preview is private — noindex, never stored — its canonical has no query, and the parameter alone shows a visitor nothing of the draft",
    ownPreview.headers["x-robots-tag"] === "noindex, nofollow, noarchive" &&
      /private, no-store/.test(ownPreview.headers["cache-control"] ?? "") &&
      ownPreview.canonical === `${site}/packages/cairo-and-giza-classic` &&
      anonymousPreview.headers["x-robots-tag"] === "noindex, nofollow, noarchive" &&
      !anonymousPreview.body.includes(DRAFT) &&
      anonymousPreview.canonical === `${site}/packages/cairo-and-giza-classic`,
    JSON.stringify({ robots: ownPreview.headers["x-robots-tag"], cache: ownPreview.headers["cache-control"], canonical: ownPreview.canonical }),
  );

  say("no page errors in the admin's window or the visitor's", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  await server?.stop();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
