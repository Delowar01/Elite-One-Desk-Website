/**
 * Batch 24 acceptance: the package catalogue, a package's own page, a
 * destination's page and the services overview in the Visual Editor, in a
 * real Chromium, on the real routes.
 *
 * Records are chosen from the data, never by name: the first destination that
 * holds two published packages, its first package, and a published package
 * filed under none. The catalogue gets the full walk — reached through the
 * admin's own navigation and the page list, the real page in the canvas,
 * Layers named by the records, a card selected on the canvas, a direct edit, a
 * card re-filed and hidden, Arabic, Desktop/Tablet/Mobile, a Mobile style, an
 * entrance and its Replay, Preview, a public page that never moves, Publish,
 * the public result, history, compare, Restore and Discard, then keyboard and
 * accessible names. A package's page, a destination's page and the services
 * overview get the core of it; a package made on the Packages screen while the
 * probe runs is found, edited, published and deleted again; and the Packages
 * screen, opened before a publication, keeps the editor's work.
 */

import { canvasRedrawn, canvasUrl, editorIdle, editorSettled, selectCanvasNode, selectFromLayers } from "../canvas";
import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";
import { until } from "../wait";

const PORT = 3738;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("route_packages_probe");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);

  const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message.slice(0, 160)));
  page.on("dialog", (dialog) => void dialog.accept());

  type Pkg = { id: number; slug: string; title_en: string; destination_id: number | null };
  type Dest = { id: number; slug: string; title_en: string };
  const [home] = await sql<Dest[]>`
    select d.id, d.slug, d.title_en from package_destinations d
     where d.is_published and (select count(*) from travel_packages p where p.destination_id = d.id and p.is_published) >= 2
     order by d.sort_order, d.id limit 1`;
  if (!home) throw new Error("the fixture needs a destination holding two published packages");
  const inHome = await sql<Pkg[]>`
    select id, slug, title_en, destination_id from travel_packages
     where destination_id = ${home.id} and is_published order by is_featured desc, sort_order, id`;
  const [main, second] = inHome.map((row) => ({ ...row })) as [Pkg, Pkg];
  const [loose] = await sql<Pkg[]>`
    select id, slug, title_en, destination_id from travel_packages where destination_id is null and is_published order by sort_order, id limit 1`;
  if (!loose) throw new Error("the fixture needs a published package filed under no destination");

  const packageRow = async (id: number) => (await sql<Record<string, unknown>[]>`select * from travel_packages where id = ${id}`)[0] ?? null;
  const destinationRow = async (id: number) => (await sql<Record<string, unknown>[]>`select * from package_destinations where id = ${id}`)[0] ?? null;
  const draftOf = async (ownerKey: string) =>
    (await sql<{ draft_content: Record<string, { value: unknown }> | null; draft_styles: unknown; draft_motion: unknown }[]>`
      select draft_content, draft_styles, draft_motion from route_nodes where owner_key = ${ownerKey}`)[0] ?? null;
  const revisions = async () => (await sql<{ n: number }[]>`select coalesce(sum(revision), 0)::int as n from route_nodes`)[0]!.n;
  const pendingDrafts = async () =>
    (await sql<{ n: number }[]>`
      select count(*)::int as n from route_nodes
       where draft_content is not null or draft_styles is not null or draft_motion is not null`)[0]!.n;
  const visit = async (path: string, signedIn = false) => {
    const fresh = signedIn ? context : await browser.newContext();
    const tab = await fresh.newPage();
    const response = await tab.goto(`${server!.origin}${path}`, { waitUntil: "load" });
    const html = await tab.content();
    await tab.close();
    if (!signedIn) await fresh.close();
    return { status: response?.status() ?? 0, html };
  };
  const statusOf = async (path: string) => {
    const response = await fetch(`${server!.origin}${path}`, { redirect: "manual" });
    await response.arrayBuffer();
    return response.status;
  };
  const frame = () => page.frames().find((candidate) => candidate.url().includes("editor=1"))!;
  const inspector = page.locator("aside[aria-label='Inspector']");
  const layers = page.locator("[data-route-layers]");
  const openPanel = async () => {
    const panel = page.locator("[data-route-panel]");
    if ((await panel.count()) === 0) await page.getByRole("button", { name: /^Publish$/ }).click();
    await panel.waitFor({ timeout: 10_000 });
    return panel;
  };
  const closePanel = async () => {
    const panel = page.locator("[data-route-panel]");
    if (await panel.count()) await panel.getByRole("button", { name: "Close", exact: true }).click();
  };
  const publishFromPanel = async () => {
    const panel = await openPanel();
    const ready = await until(async () => await panel.locator("[data-route-publish]").isEnabled(), 15_000);
    if (ready) await panel.locator("[data-route-publish]").click();
    const done = await until(async () => (await pendingDrafts()) === 0, 20_000);
    await closePanel();
    await editorSettled(page, 60_000);
    return ready && done;
  };
  const h1Of = (html: string) => /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1]?.replace(/<[^>]+>/g, "").trim() ?? "";
  const ldOf = (html: string, type: string) => {
    for (const match of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
      const parsed = JSON.parse(match[1]!) as unknown;
      for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
        if ((entry as { "@type"?: string })["@type"] === type) return entry as { name?: string };
      }
    }
    return null;
  };
  const openRoute = async (key: string, lang = "en") => {
    await page.goto(`${server!.origin}/admin/visual-editor?route=${key}&lang=${lang}&device=desktop`, { waitUntil: "load" });
    return editorSettled(page, 60_000);
  };
  const field = (name: string) => inspector.locator(`[data-field="${name}"]`);
  const contentTab = () => page.getByRole("tab", { name: /Content/ }).click();
  /** The region a card is drawn inside: the nearest marked region root around the card's own root. */
  const regionAround = (cardId: number) =>
    frame()
      .locator(`[data-eod-address="packageCard:${cardId}"]`)
      .first()
      .evaluate((element) => element.parentElement?.closest("[data-eod-section]")?.getAttribute("data-eod-address") ?? "");

  const packagePath = async (id: number) => `/packages/${(await packageRow(id))!.slug as string}`;
  const destinationPath = async (id: number) => `/packages/${(await destinationRow(id))!.slug as string}`;
  const publicBefore = await visit("/packages");

  /* ================================================================== */
  /* The catalogue: the full walk                                        */
  /* ================================================================== */

  // Reached the way an admin reaches it: the sidebar, then the page list.
  await page.goto(`${server.origin}/admin`, { waitUntil: "load" });
  await page.getByRole("link", { name: "Visual Editor" }).first().click();
  await page.waitForURL(/\/admin\/visual-editor/, { timeout: 30_000 });
  say("Navigation: the admin's Visual Editor link opens the editor", await editorSettled(page, 60_000));
  const [{ n: packageCount }] = await sql<{ n: number }[]>`select count(*)::int as n from travel_packages`;
  const [{ n: destinationCount }] = await sql<{ n: number }[]>`select count(*)::int as n from package_destinations`;
  const offeredPackages = await page.locator('#ve-page option[value^="package:"]').count();
  const offeredDestinations = await page.locator('#ve-page optgroup[label="Destinations"] option').count();
  const overviews = await page.locator('#ve-page optgroup[label="Overviews"] option').count();
  say(
    "Navigation: the page list offers both overviews, every destination and every package",
    offeredPackages === packageCount && offeredDestinations === destinationCount && overviews === 2,
    `${overviews} overviews, ${offeredDestinations} destinations, ${offeredPackages} packages`,
  );
  say(
    "Navigation: packages are grouped by the destination they are filed under",
    (await page.locator(`#ve-page optgroup[label="Packages · ${home.title_en}"] option[value="package:${main.id}"]`).count()) === 1 &&
      (await page.locator(`#ve-page optgroup[label="Packages · No destination"] option[value="package:${loose.id}"]`).count()) === 1,
  );
  await page.locator("#ve-page").selectOption("packageIndex:1");
  const switched = await until(async () => canvasUrl(page).includes("/packages?preview=1&editor=1"), 30_000);
  await editorSettled(page, 60_000);
  say("Navigation: choosing Tour packages opens /packages, and the address names it", switched && decodeURIComponent(page.url()).includes("route=packageIndex:1"), canvasUrl(page));
  const catalogueH1 = (await frame().locator("h1").first().textContent())?.trim() ?? "";
  say("Catalogue: the canvas shows the real page — its heading, header and footer", catalogueH1 === h1Of(publicBefore.html) && (await frame().locator("header").count()) > 0 && (await frame().locator("footer").count()) > 0, catalogueH1);

  // Layers: the catalogue's own regions; the groups and the cards inside it, named by their records.
  await layers.locator('[data-layer-row="packageIndexHero:1"]').waitFor({ timeout: 15_000 });
  const own = await Promise.all(["packageIndexHero:1", "packageIndexCrumbs:1", "packageIndexCatalogue:1"].map((key) => layers.locator(`[data-layer-row="${key}"]`).count()));
  say("Catalogue: Layers holds its hero, breadcrumbs and catalogue", own.every((count) => count === 1));
  const catalogueRow = layers.locator('[data-layer-row="packageIndexCatalogue:1"]');
  say("Catalogue: …the catalogue is marked Generated", /Generated/.test((await catalogueRow.textContent()) ?? ""));
  await layers.locator('[data-layer-toggle="packageIndexCatalogue:1"]').click();
  const groupRow = layers.locator(`[data-layer-row="destinationGroup:${home.id}"]`);
  await groupRow.waitFor({ timeout: 10_000 });
  say("Catalogue: a destination's group is named by the destination", ((await groupRow.textContent()) ?? "").includes(home.title_en), (await groupRow.textContent()) ?? "");
  await layers.locator(`[data-layer-toggle="destinationGroup:${home.id}"]`).click();
  const cardRow = layers.locator(`[data-layer-row="packageCard:${main.id}"]`);
  await cardRow.waitFor({ timeout: 10_000 });
  say("Catalogue: …and its cards by their packages' titles", ((await cardRow.textContent()) ?? "").includes(main.title_en), (await cardRow.textContent()) ?? "");
  say("Catalogue: 'Build your own' holds the package filed under no destination", (await layers.locator('[data-layer-row="packageIndexCustom:1"]').count()) === 1 && (await regionAround(loose.id)) === "packageIndexCustom:1");

  // A card selected on the canvas shows the card's fields — and the structure only the card offers.
  const picked = await selectCanvasNode(page, `packageCard:${main.id}/field:title`);
  await contentTab();
  await field("title").locator("input").first().waitFor({ timeout: 15_000 });
  const cardFields = (await Promise.all(["title", "place", "duration", "summary"].map((n) => field(n).locator("input, textarea").count()))).every((count) => count > 0);
  const destinations = await field("group").locator("option").allTextContents();
  say("Catalogue: clicking a card's title selects the card, with its words, picture and structure", picked.ok && cardFields && destinations.includes("No destination") && destinations.some((label) => label.includes(home.title_en)), picked.shows);

  // A direct edit of the card's title, on the canvas.
  const title = frame().locator(`[data-eod-address="packageCard:${main.id}/field:title"]`);
  await title.dblclick();
  await until(async () => (await title.getAttribute("contenteditable")) !== null, 10_000);
  await page.keyboard.press("End");
  await page.keyboard.type(" Revisited");
  await page.keyboard.press("Enter");
  const typed = await until(async () => (await draftOf(`packageCard:${main.id}`))?.draft_content?.titleEn?.value === `${main.title_en} Revisited`, 20_000);
  say("Catalogue: a direct edit on a card becomes the package's title draft", typed);
  say("Catalogue: …and the package row is untouched", (await packageRow(main.id))?.title_en === main.title_en);
  await editorIdle(page);

  // Re-filed: the second card to "No destination", and drawn there after the redraw.
  await selectCanvasNode(page, `packageCard:${second.id}/field:title`);
  await contentTab();
  const before = canvasUrl(page);
  await field("group").locator("select").selectOption("");
  const refiled = await until(async () => (await draftOf(`packageCard:${second.id}`))?.draft_content?.destinationId?.value === null, 20_000);
  await canvasRedrawn(page, before);
  await editorSettled(page, 60_000);
  say("Catalogue: a card filed under another destination is a draft of the package", refiled);
  say("Catalogue: …and the canvas draws it there at once", (await regionAround(second.id)) === "packageIndexCustom:1", await regionAround(second.id));
  say("Catalogue: …while the package's row stays filed where it was", (await packageRow(second.id))?.destination_id === home.id);

  // Hidden, from Layers: dimmed in the canvas, kept off the page when published.
  // Selecting the card opens Layers down to it; its row offers Hide.
  await selectCanvasNode(page, `packageCard:${loose.id}/field:title`);
  const hideButton = layers.locator(`[data-route-ops="packageCard:${loose.id}"] button[aria-label^="Hide"]`);
  await hideButton.waitFor({ timeout: 15_000 });
  await hideButton.click();
  const hidden = await until(async () => (await draftOf(`packageCard:${loose.id}`))?.draft_content?.isPublished?.value === false, 20_000);
  await editorSettled(page, 60_000);
  const dimmed = await until(async () => (await frame().locator(`[data-eod-address="packageCard:${loose.id}"][data-eod-hidden]`).count()) === 1, 15_000);
  say("Catalogue: Hide in Layers is a draft of the package's visibility", hidden);
  say("Catalogue: …and the canvas draws the card dimmed rather than dropping it", dimmed);

  // The hero's wording, in Arabic: its own field, right to left — and switching wrote nothing.
  const writes = await revisions();
  await page.getByRole("button", { name: "العربية", exact: true }).click();
  await editorSettled(page, 60_000);
  const rtl = await frame().evaluate(() => document.documentElement.dir);
  say("Catalogue: Arabic opens the real /ar/packages route, right to left", frame().url().includes("/ar/packages?") && rtl === "rtl", frame().url());
  say("Catalogue: switching language wrote nothing", (await revisions()) === writes);
  await selectCanvasNode(page, "packageIndexHero:1/field:eyebrow");
  await contentTab();
  const eyebrow = field("eyebrow").locator("input").first();
  await eyebrow.waitFor({ timeout: 15_000 });
  await eyebrow.fill("رحلاتنا");
  const arSaved = await until(async () => (await draftOf("packageIndexHero:1"))?.draft_content?.["copy:eyebrowAr"]?.value === "رحلاتنا", 20_000);
  say("Catalogue: the Arabic eyebrow is a draft of the catalogue's Arabic wording only", arSaved && (await eyebrow.getAttribute("dir")) === "rtl" && (await draftOf("packageIndexHero:1"))?.draft_content?.["copy:eyebrowEn"] === undefined);
  await editorIdle(page);
  await page.getByRole("button", { name: "English", exact: true }).click();
  await editorSettled(page, 60_000);

  // Devices keep the selection and write nothing; a Mobile style is Mobile's.
  await selectCanvasNode(page, "packageIndexHero:1/field:heading");
  const beforeDevices = await revisions();
  for (const [device, width] of [["Tablet", 834], ["Mobile", 390], ["Desktop", 1440]] as const) {
    await page.getByRole("button", { name: new RegExp(`^${device}`) }).click();
    const reported = await until(async () => (await page.getByText(`Canvas reports ${width}px`).count()) > 0, 20_000);
    const kept = (await inspector.locator("code").allTextContents()).some((text) => text.trim() === "packageIndexHero:1/field:heading");
    say(`Catalogue: ${device} resizes the canvas and keeps the selection`, reported && kept);
  }
  say("Catalogue: switching device wrote nothing", (await revisions()) === beforeDevices);
  await page.getByRole("button", { name: /^Mobile/ }).click();
  await until(async () => (await page.getByText("Canvas reports 390px").count()) > 0, 20_000);
  await editorSettled(page);
  await selectCanvasNode(page, "packageIndexHero:1/field:heading");
  await page.getByRole("tab", { name: /Style/ }).click();
  const color = inspector.locator('[data-style-token="textColor"] select');
  await color.waitFor({ timeout: 15_000 });
  await color.selectOption({ index: 1 });
  const mobileStyled = await until(async () => {
    const styles = (await draftOf("packageIndexHero:1"))?.draft_styles as { nodes?: Record<string, Record<string, unknown>> } | null;
    const node = styles?.nodes?.["field:heading"];
    return Boolean(node?.mobile) && !node?.base;
  }, 20_000);
  say("Catalogue: a style chosen on Mobile is saved for Mobile only", mobileStyled);
  await editorIdle(page);
  await page.getByRole("button", { name: /^Desktop/ }).click();
  await until(async () => (await page.getByText("Canvas reports 1440px").count()) > 0, 20_000);
  await editorSettled(page);

  // An entrance on a card, and its Replay.
  await selectCanvasNode(page, `packageCard:${main.id}/field:title`);
  await selectFromLayers(page, `packageCard:${main.id}`);
  await page.getByRole("tab", { name: /Motion/ }).click();
  const entrance = inspector.locator('[data-motion-field="entrance"] select');
  await entrance.waitFor({ timeout: 15_000 });
  await entrance.selectOption({ label: "Fade up" });
  const moved = await until(async () => (await draftOf(`packageCard:${main.id}`))?.draft_motion != null, 20_000);
  say("Catalogue: an entrance on a card is a motion draft of that card", moved);
  await editorIdle(page);
  await selectFromLayers(page, `packageCard:${main.id}`);
  await page.getByRole("tab", { name: /Motion/ }).click();
  const beforeReplay = await revisions();
  await page.locator('[data-replay-mode="all"]').click();
  const replayed = await until(async () => ((await page.locator("[data-replay-status]").getAttribute("data-replay-status")) ?? "") === "finished", 15_000);
  say("Catalogue: Replay plays the entrance, and saves nothing", replayed && (await revisions()) === beforeReplay);

  // Preview shows every draft; the public page none, and nothing of the editor.
  const previewHref = await page.getByRole("link", { name: /Preview/ }).getAttribute("href");
  say("Catalogue: Preview opens the catalogue's draft preview", previewHref === "/packages?preview=1", previewHref ?? "");
  const previewed = (await visit("/packages?preview=1", true)).html;
  say("Catalogue: …which shows the edited title, and the hidden card nowhere", previewed.includes(`${main.title_en} Revisited`.replace(/&/g, "&amp;")) && !previewed.includes(`data-eod-address="packageCard:${loose.id}"`));
  const liveNow = await visit("/packages");
  say("Catalogue: the public page shows none of it, and nothing of the editor", !liveNow.html.includes("Revisited") && !liveNow.html.includes("data-eod-") && /data-atmosphere="landing"/.test(liveNow.html));

  // Accessibility: a Layers row by keyboard; a generated region explains itself; every control named.
  await selectCanvasNode(page, "packageIndexHero:1/field:heading");
  await layers.locator('[data-layer-toggle="packageIndexCrumbs:1"]').focus();
  await page.keyboard.press("Tab");
  await page.keyboard.press("Enter");
  const keyed = await until(async () => (await inspector.locator('[data-route-source="packageIndexCrumbs:1"]').count()) > 0, 15_000);
  say("Catalogue: a Layers row is reached and selected by keyboard", keyed);
  await selectFromLayers(page, "packageIndexCatalogue:1");
  await contentTab();
  const explained = inspector.locator('[data-field-linked="regions"]');
  await explained.waitFor({ timeout: 15_000 }).catch(() => undefined);
  say("Catalogue: the generated catalogue region explains itself instead of offering a box", /old region label/.test((await explained.textContent()) ?? ""));

  // Publish, the public result, history, compare, Restore, Discard.
  {
    const panel = await openPanel();
    const listed = await until(
      async () =>
        (await Promise.all(
          [`packageCard:${main.id}`, `packageCard:${second.id}`, `packageCard:${loose.id}`, "packageIndexHero:1"].map((key) => panel.locator(`[data-route-pending-owner="${key}"]`).count()),
        )).every((count) => count === 1),
      15_000,
    );
    say("Publish: the panel lists every card and region that is waiting", listed);
    const redrawFrom = canvasUrl(page);
    await panel.locator("[data-route-publish]").click();
    const wrote = await until(async () => (await packageRow(main.id))?.title_en === `${main.title_en} Revisited`, 20_000);
    say("Publish: Publish writes the cards' drafts to the packages' own rows", wrote);
    const rows = { main: await packageRow(main.id), second: await packageRow(second.id), loose: await packageRow(loose.id) };
    say(
      "Publish: …re-filed, hidden and renamed, and nothing else",
      rows.second?.destination_id === null && rows.loose?.is_published === false && rows.main?.slug === main.slug && rows.main?.destination_id === home.id,
    );
    const kinds = (await sql<{ kind: string }[]>`select kind from route_versions where route_key = 'packageIndex:1' order by id`).map((entry) => entry.kind);
    say("Publish: …records the catalogue as it was, then the publication", kinds.join(",") === "baseline,publish", kinds.join(","));
    await canvasRedrawn(page, redrawFrom);
    const published = (await visit("/packages")).html;
    say("Publish: the public catalogue shows it at once, and the hidden package is gone from it", published.includes("Revisited") && !published.includes(`/packages/${loose.slug}"`) && !published.includes("data-eod-"));
    say("Publish: the hidden package's own page is hidden with it", (await statusOf(`/packages/${loose.slug}`)) === 404);
    say("Publish: the Arabic catalogue shows the Arabic eyebrow", (await visit("/ar/packages")).html.includes("رحلاتنا"));

    const versions = panel.locator("[data-route-history] [data-route-version]");
    say("History: both versions are listed", await until(async () => (await versions.count()) === 2, 15_000));
    const [baseline] = await sql<{ id: number }[]>`select id from route_versions where route_key = 'packageIndex:1' and kind = 'baseline'`;
    await panel.locator(`[data-route-version="${baseline!.id}"]`).getByRole("button", { name: "Compare with live" }).click();
    const compared = panel.locator(`[data-route-compare="${baseline!.id}"]`);
    await compared.waitFor({ timeout: 15_000 });
    say("History: Compare with live names what changed", ((await compared.textContent()) ?? "").includes("Revisited"));
    const viewed = (await visit(`/packages?compare=v${baseline!.id}`, true)).html;
    say("History: View shows that version, still and read only", !viewed.includes("Revisited") && viewed.includes("data-eod-still"));
    await panel.locator(`[data-route-restore="${baseline!.id}"]`).click();
    const restored = await until(async () => (await draftOf(`packageCard:${main.id}`))?.draft_content?.titleEn?.value === main.title_en, 20_000);
    say("Restore: the old version comes back as a draft, and live does not change", restored && (await packageRow(main.id))?.title_en === `${main.title_en} Revisited`);
    const discardReady = await until(async () => await panel.locator("[data-route-discard]").isEnabled(), 15_000);
    if (discardReady) await panel.locator("[data-route-discard]").click();
    say("Discard: the restored draft goes, and live stays as published", discardReady && (await until(async () => (await pendingDrafts()) === 0, 20_000)));
    await closePanel();
  }

  /* ================================================================== */
  /* A service card's title, typed on the canvas: the same card shape    */
  /* ================================================================== */
  {
    // Batch 24 found that a card's words could not be typed into on the canvas —
    // the card's link took the focus, and its focusout ended the edit at once.
    // The fix is the canvas's, so a category page's service card holds it too.
    const [card] = await sql<{ id: number; category_id: number; title_en: string }[]>`
      select s.id, s.category_id, s.title_en from services s join service_categories c on c.id = s.category_id
       where s.is_published and c.is_published order by c.sort_order, c.id, s.sort_order, s.id limit 1`;
    await openRoute(`category:${card!.category_id}`);
    await selectCanvasNode(page, `service:${card!.id}/field:title`);
    const serviceTitle = frame().locator(`[data-eod-address="service:${card!.id}/field:title"]`);
    await serviceTitle.dblclick();
    const editing = await until(async () => (await serviceTitle.getAttribute("contenteditable")) !== null, 10_000);
    await page.keyboard.press("End");
    await page.keyboard.type(" Typed");
    await page.keyboard.press("Enter");
    const typedCard = await until(async () => (await draftOf(`service:${card!.id}`))?.draft_content?.titleEn?.value === `${card!.title_en} Typed`, 20_000);
    say("Service card: a category page's card title is typed into on the canvas, too", editing && typedCard);
    await editorIdle(page);
    const panel = await openPanel();
    await until(async () => await panel.locator("[data-route-discard]").isEnabled(), 15_000);
    await panel.locator("[data-route-discard]").click();
    await until(async () => (await pendingDrafts()) === 0, 20_000);
    await closePanel();
  }

  /* ================================================================== */
  /* A package's own page                                                */
  /* ================================================================== */
  {
    const path = await packagePath(main.id);
    say("Package: loads in the Visual Editor", await openRoute(`package:${main.id}`));
    say("Package: the canvas is its real public route", canvasUrl(page).includes(`${path}?preview=1&editor=1`), canvasUrl(page));
    const regions = await Promise.all(["packageHero", "packageCrumbs", "packageBody", "packageHighlights", "packageRequest"].map((type) => layers.locator(`[data-layer-row="${type}:${main.id}"]`).count()));
    say("Package: Layers holds every region of the page", regions.every((count) => count === 1));
    await selectCanvasNode(page, `packageHero:${main.id}/field:title`);
    await contentTab();
    const place = field("place").locator("input").first();
    await place.waitFor({ timeout: 15_000 });
    await place.fill("Three cities and the coast");
    say("Package: an Inspector edit is a draft of the package", await until(async () => (await draftOf(`packageHero:${main.id}`))?.draft_content?.destinationEn?.value === "Three cities and the coast", 20_000));
    await editorIdle(page);
    await selectFromLayers(page, `packageHighlights:${main.id}`);
    await contentTab();
    await field("highlights").getByRole("button", { name: /^Add/ }).click();
    await field("highlights").locator("li").last().locator("input").first().fill("A guide every day");
    const listed = await until(async () => JSON.stringify((await draftOf(`packageHighlights:${main.id}`))?.draft_content?.highlights?.value ?? "").includes("A guide every day"), 20_000);
    say("Package: a highlight added in the Inspector is a draft of the package's list", listed);
    await editorIdle(page);
    const current = Number((await packageRow(main.id))?.image_id ?? 0);
    const [picture] = await sql<{ id: number; filename: string; title: string }[]>`
      select id, filename, title from media where id <> ${current} order by id limit 1`;
    if (!picture) throw new Error("the fixture's library holds no other picture");
    await selectFromLayers(page, `packageHero:${main.id}`);
    await contentTab();
    // "Choose" for a package with no picture yet, "Change" for one that has one.
    await field("image").getByRole("button", { name: /^(Choose|Change) picture$/ }).click();
    const chooser = page.getByRole("dialog", { name: "Choose Picture" });
    await chooser.waitFor({ timeout: 10_000 });
    await chooser.getByRole("button", { name: picture.title || picture.filename }).first().click();
    say("Package: a picture chosen from the library is a draft of the package", await until(async () => (await draftOf(`packageHero:${main.id}`))?.draft_content?.imageId?.value === picture.id, 20_000));
    await editorIdle(page);
    const crumbs = await selectCanvasNode(page, `packageCrumbs:${main.id}/field:trail`);
    const note = inspector.locator(`[role="note"][data-route-generated="packageCrumbs:${main.id}/field:trail"]`);
    await note.waitFor({ timeout: 15_000 }).catch(() => undefined);
    say("Package: the generated breadcrumbs explain themselves", crumbs.ok && (await note.count()) === 1);
    const preview = (await visit(`${path}?preview=1`, true)).html;
    say("Package: Preview shows the drafts; the public page does not", preview.includes("A guide every day") && !(await visit(path)).html.includes("A guide every day"));
    say("Package: Publish writes them to the package", await publishFromPanel());
    const live = (await visit(path)).html;
    const row = await packageRow(main.id);
    say("Package: the public page shows them, and its structured data names the package", live.includes("A guide every day") && live.includes("Three cities and the coast") && ldOf(live, "TouristTrip")?.name === row?.title_en);
    say("Package: …and the catalogue's card shows the new place at once", (await visit("/packages")).html.includes("Three cities and the coast"));
  }

  /* ================================================================== */
  /* A destination's page, and the services overview                     */
  /* ================================================================== */
  {
    const path = await destinationPath(home.id);
    say("Destination: loads in the Visual Editor on its real route", (await openRoute(`destination:${home.id}`)) && canvasUrl(page).includes(`${path}?preview=1&editor=1`));
    const regions = await Promise.all(["destinationHero", "destinationCrumbs", "destinationPackages"].map((type) => layers.locator(`[data-layer-row="${type}:${home.id}"]`).count()));
    say("Destination: Layers holds its hero, breadcrumbs and packages", regions.every((count) => count === 1));
    const cards = await selectCanvasNode(page, `destinationPackages:${home.id}/field:cards`);
    const explained = inspector.locator(`[role="note"][data-route-generated="destinationPackages:${home.id}/field:cards"]`);
    await explained.waitFor({ timeout: 15_000 }).catch(() => undefined);
    say("Destination: its cards are the catalogue's, and say so", cards.ok && (await explained.count()) === 1 && /Tour packages page/.test((await explained.textContent()) ?? ""));
    await selectCanvasNode(page, `destinationHero:${home.id}/field:title`);
    await contentTab();
    const summary = field("summary").locator("textarea").first();
    await summary.waitFor({ timeout: 15_000 });
    await summary.fill("Every programme here, from the first day to the last.");
    say("Destination: a summary edit is a draft of the destination", await until(async () => (await draftOf(`destinationHero:${home.id}`))?.draft_content?.summaryEn?.value === "Every programme here, from the first day to the last.", 20_000));
    await editorIdle(page);
    say("Destination: Publish writes it to the destination", await publishFromPanel());
    const destinationPage = (await visit(path)).html;
    say("Destination: the public page shows it, and keeps its landing atmosphere", destinationPage.includes("Every programme here, from the first day to the last.") && /data-atmosphere="landing"/.test(destinationPage));
    say("Destination: the destination row holds it", (await destinationRow(home.id))?.summary_en === "Every programme here, from the first day to the last.");
  }
  {
    say("Overview: the services overview loads on /services", (await openRoute("serviceIndex:1")) && canvasUrl(page).includes("/services?preview=1&editor=1"));
    const rows = await selectCanvasNode(page, "serviceIndexCategories:1/field:categories");
    const explained = inspector.locator('[role="note"][data-route-generated="serviceIndexCategories:1/field:categories"]');
    await explained.waitFor({ timeout: 15_000 }).catch(() => undefined);
    say("Overview: every row is a category's, and says where it is edited", rows.ok && (await explained.count()) === 1);
    await selectCanvasNode(page, "serviceIndexHero:1/field:heading");
    await contentTab();
    const heading = field("heading").locator("input").first();
    await heading.waitFor({ timeout: 15_000 });
    await heading.fill("Everything, from one desk");
    say("Overview: the heading is a draft of the overview's own wording", await until(async () => (await draftOf("serviceIndexHero:1"))?.draft_content?.["copy:headingEn"]?.value === "Everything, from one desk", 20_000));
    await editorIdle(page);
    say("Overview: Publish puts it on the public page", (await publishFromPanel()) && h1Of((await visit("/services")).html) === "Everything, from one desk");
    say("Overview: the Arabic page keeps the standard Arabic heading", h1Of((await visit("/ar/services")).html) === "كل ما تحتاجه — من مكتب واحد");
  }

  /* ================================================================== */
  /* The Packages screen, opened before a publication                    */
  /* ================================================================== */
  {
    await page.goto(`${server.origin}/admin/packages/${second.id}`, { waitUntil: "load" });
    const formTab = page;
    const editor = await context.newPage();
    // Publishing asks for confirmation; this second tab answers it as the first does.
    editor.on("dialog", (dialog) => void dialog.accept());
    editor.on("pageerror", (error) => errors.push(error.message.slice(0, 160)));
    await editor.goto(`${server.origin}/admin/visual-editor?route=package:${second.id}&lang=en&device=desktop`, { waitUntil: "load" });
    await editorSettled(editor, 60_000);
    const editorInspector = editor.locator("aside[aria-label='Inspector']");
    await selectCanvasNode(editor, `packageHero:${second.id}/field:title`);
    await editor.getByRole("tab", { name: /Content/ }).click();
    const duration = editorInspector.locator('[data-field="duration"] input').first();
    await duration.waitFor({ timeout: 15_000 });
    await duration.fill("Seven nights, from the editor");
    await until(async () => (await draftOf(`packageHero:${second.id}`))?.draft_content?.durationEn?.value === "Seven nights, from the editor", 20_000);
    await editorIdle(editor);
    const panel = editor.locator("[data-route-panel]");
    await editor.getByRole("button", { name: /^Publish$/ }).click();
    await panel.waitFor({ timeout: 10_000 });
    await until(async () => await panel.locator("[data-route-publish]").isEnabled(), 15_000);
    await panel.locator("[data-route-publish]").click();
    const published = await until(async () => (await packageRow(second.id))?.duration_en === "Seven nights, from the editor", 20_000);
    say("Packages screen: meanwhile the editor, in another tab, publishes the package's duration", published);
    await editor.close();

    // The form, still open from before, saves the summary only.
    await formTab.locator("#summaryEn").fill("Summary saved on the Packages screen");
    await formTab.getByRole("button", { name: "Save changes" }).click();
    const kept = await until(async () => (await packageRow(second.id))?.summary_en === "Summary saved on the Packages screen", 20_000);
    say("Packages screen: a form opened before a publication saves what it changed", kept);
    say("Packages screen: …and keeps the editor's published duration", (await packageRow(second.id))?.duration_en === "Seven nights, from the editor");
    // The same stale page now changes the duration too: refused, with the field named.
    await formTab.goto(`${server.origin}/admin/packages/${second.id}`, { waitUntil: "load" });
    await sql`update travel_packages set duration_en = 'Changed by somebody else' where id = ${second.id}`;
    await formTab.locator("#durationEn").fill("From a stale page");
    await formTab.getByRole("button", { name: "Save changes" }).click();
    const named = await until(async () => (await formTab.getByText(/Duration \(English\) was changed elsewhere/).count()) > 0, 20_000);
    say("Packages screen: an overlapping save is refused, naming the field, and writes nothing", named && (await packageRow(second.id))?.duration_en === "Changed by somebody else");
  }

  /* ================================================================== */
  /* A package made while the probe runs, through the Packages screen    */
  /* ================================================================== */
  {
    const slug = "made-during-the-package-probe";
    await page.goto(`${server.origin}/admin/packages/new`, { waitUntil: "load" });
    await page.locator("#titleEn").fill("Made During The Package Probe");
    await page.locator("#slug").fill(slug);
    await page.locator("#destinationId").selectOption(String(home.id));
    const published = page.locator('input[name="isPublished"]');
    if (!(await published.isChecked())) await published.check();
    await page.getByRole("button", { name: "Create package" }).click();
    const made = await until(async () => (await sql`select 1 from travel_packages where slug = ${slug}`).length === 1, 20_000);
    const [{ id }] = await sql<{ id: number }[]>`select id from travel_packages where slug = ${slug}`;
    say("Created: the Packages screen makes the package", made);
    await page.goto(`${server.origin}/admin/visual-editor`, { waitUntil: "load" });
    await editorSettled(page, 60_000);
    say("Created: the editor's page list offers it, under its destination, with no code", (await page.locator(`#ve-page optgroup[label="Packages · ${home.title_en}"] option[value="package:${id}"]`).count()) === 1);
    say("Created: …it opens on its real route", (await openRoute(`package:${id}`)) && canvasUrl(page).includes(`/packages/${slug}?preview=1&editor=1`));
    await selectCanvasNode(page, `packageHero:${id}/field:title`);
    await contentTab();
    const duration = field("duration").locator("input").first();
    await duration.waitFor({ timeout: 15_000 });
    await duration.fill("Ready in a week");
    await until(async () => (await draftOf(`packageHero:${id}`))?.draft_content?.durationEn?.value === "Ready in a week", 20_000);
    await editorIdle(page);
    say("Created: it publishes like any other package", (await publishFromPanel()) && (await visit(`/packages/${slug}`)).html.includes("Ready in a week"));
    say("Created: …and the catalogue gives it a card in its destination's group", (await openRoute("packageIndex:1")) && (await regionAround(id)) === `destinationGroup:${home.id}`);
    await page.goto(`${server.origin}/admin/packages/${id}`, { waitUntil: "load" });
    await page.getByRole("button", { name: "Delete package" }).click();
    const deleted = await until(async () => (await packageRow(id)) === null, 20_000);
    say("Created: the Packages screen deletes it, its page goes, and the editor no longer offers it", deleted && (await statusOf(`/packages/${slug}`)) === 404 && (await (async () => {
      await page.goto(`${server!.origin}/admin/visual-editor`, { waitUntil: "load" });
      await editorSettled(page, 60_000);
      return page.locator(`#ve-page option[value="package:${id}"]`).count();
    })()) === 0);
  }

  say("Clean-up: no draft is pending", (await pendingDrafts()) === 0);
  say("no page errors in the editor or the canvas", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  await server?.stop();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
