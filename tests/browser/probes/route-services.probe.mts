/**
 * Batch 22 acceptance: a service's own page in the Visual Editor, in a real
 * Chromium, on the real routes.
 *
 * Services are chosen from the data, never by name: the first published
 * service of each of the first three categories, so three different
 * categories are walked and no service is special. The first gets the full
 * walk the brief lists — reached through the admin's own navigation and the
 * page list, the real page in the canvas, Layers, the Inspector, a direct edit
 * taken back and put back, a list and its steps, a picture from the library,
 * English and Arabic, Desktop/Tablet/Mobile, a style per device, an entrance
 * and its Replay, Preview, a public page that never moves, Publish, the public
 * result, history, compare, Restore and Discard — then the same editor by
 * keyboard and screen reader. The second and third get the core of it, and the
 * second is moved to another category on the Services screen and back. Last,
 * a service made on the Services screen while the probe runs is found, edited,
 * published and deleted again, through the screens an admin uses.
 */

import { canvasRedrawn, canvasUrl, editorIdle, editorSettled, selectCanvasNode, selectFromLayers } from "../canvas";
import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { recordEvidence, serverEvidence } from "../evidence";
import { launchChromium } from "../harness";
import { until } from "../wait";

const PORT = 3735;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("route_services_probe");
const sql = connect(database);
let server;
/** Never printed: removed by value from every line of evidence. */
const secrets: string[] = [];
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
  secrets.push(value!);
  await recordEvidence(page, secrets);

  type Service = { id: number; slug: string; title_en: string; category_id: number; subcategory_id: number | null };
  // The first published service of each published category, in the site's own order.
  const firsts = await sql<Service[]>`
    select distinct on (c.sort_order, c.id) s.id, s.slug, s.title_en, s.category_id, s.subcategory_id
      from services s join service_categories c on c.id = s.category_id
     where s.is_published and c.is_published
     order by c.sort_order, c.id, s.sort_order, s.id`;
  if (firsts.length < 3) throw new Error("the fixture needs three categories with a published service each");
  const [main, second, third] = firsts.map((row) => ({ ...row })) as [Service, Service, Service];

  const pathOf = async (id: number) =>
    (await sql<{ path: string }[]>`
      select '/services/' || c.slug || '/' || s.slug as path from services s join service_categories c on c.id = s.category_id where s.id = ${id}`)[0]?.path ?? "";
  const serviceRow = async (id: number) =>
    (await sql<Record<string, unknown>[]>`select * from services where id = ${id}`)[0] ?? null;
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
  const h1Of = (html: string) => /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1]?.replace(/<[^>]+>/g, "").trim() ?? "";
  const titleTag = (html: string) => /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? "";
  const serviceLd = (html: string) => {
    for (const match of html.matchAll(/<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
      const parsed = JSON.parse(match[1]!) as unknown;
      for (const entry of Array.isArray(parsed) ? parsed : [parsed]) {
        if ((entry as { "@type"?: string })["@type"] === "Service") return entry as { name?: string; description?: string };
      }
    }
    return null;
  };
  const openService = async (id: number) => {
    await page.goto(`${server!.origin}/admin/visual-editor?route=service:${id}&lang=en&device=desktop`, { waitUntil: "load" });
    return editorSettled(page, 60_000);
  };
  const field = (name: string) => inspector.locator(`[data-field="${name}"]`);
  const contentTab = () => page.getByRole("tab", { name: /Content/ }).click();

  /** The regions every service page draws in the canvas, whatever it holds. */
  const ALWAYS = [
    "serviceHero", "serviceCrumbs", "serviceOverview", "serviceBenefits", "serviceAudience",
    "serviceRequirements", "serviceProcess", "serviceNotes", "serviceFaqs", "serviceRequest",
  ];

  /** Interactive elements a page offers, outside anything the editor draws dimmed because it is unpublished. */
  const INTERACTIVE = "a[href], button, input, select, textarea, summary, [tabindex]:not([tabindex='-1'])";
  const countInteractive = (selector: string) =>
    [...document.body.querySelectorAll(selector)].filter((element) => !element.closest("[data-eod-hidden]")).length;
  type AXNode = { ignored?: boolean; role?: { value?: string }; name?: { value?: string }; backendDOMNodeId?: number };
  const AX_INTERACTIVE = new Set([
    "button", "link", "textbox", "searchbox", "combobox", "listbox", "checkbox", "radio",
    "switch", "slider", "spinbutton", "tab", "menuitem", "option",
  ]);
  /** Interactive nodes in the editor's own chrome that the browser's accessibility tree gives no name. */
  const unnamed = async (): Promise<string[]> => {
    const cdp = await context.newCDPSession(page);
    try {
      await cdp.send("Accessibility.enable");
      const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as { nodes: AXNode[] };
      const bad = nodes.filter((node) => !node.ignored && AX_INTERACTIVE.has(String(node.role?.value)) && !String(node.name?.value ?? "").trim());
      const out: string[] = [];
      for (const node of bad.slice(0, 3)) {
        const html =
          node.backendDOMNodeId === undefined
            ? "?"
            : ((await cdp.send("DOM.getOuterHTML", { backendNodeId: node.backendDOMNodeId }).catch(() => ({ outerHTML: "?" }))) as { outerHTML: string }).outerHTML;
        out.push(`${node.role?.value} ${html.slice(0, 100)}`);
      }
      return bad.length > out.length ? [...out, `${bad.length} unnamed in all`] : out;
    } finally {
      await cdp.detach();
    }
  };

  /** The core every service gets: the real page, Layers, a title draft, Preview, Discard, a public page that never moved. */
  async function core(service: Service, label: string) {
    const path = await pathOf(service.id);
    const before = await visit(path);
    say(`${label}: loads in the Visual Editor`, await openService(service.id));
    const url = frame()?.url() ?? "";
    say(`${label}: the canvas is its real public route`, url.includes(`${path}?preview=1&editor=1`), url);
    const h1 = (await frame().locator("h1").first().textContent())?.trim() ?? "";
    const chrome = (await frame().locator("header").count()) > 0 && (await frame().locator("footer").count()) > 0;
    say(`${label}: the canvas shows the real page — its title, header and footer`, h1 === service.title_en && chrome, h1);
    await layers.locator(`[data-layer-row="serviceHero:${service.id}"]`).waitFor({ timeout: 15_000 });
    const rows = await Promise.all(ALWAYS.map((type) => layers.locator(`[data-layer-row="${type}:${service.id}"]`).count()));
    say(`${label}: Layers holds every region of the page`, rows.every((count) => count === 1), ALWAYS.filter((_, i) => rows[i] !== 1).join(","));

    const picked = await selectCanvasNode(page, `serviceHero:${service.id}/field:title`);
    say(`${label}: clicking the title on the canvas selects it in the Inspector`, picked.ok, picked.shows);
    const box = field("title").locator("input").first();
    await box.waitFor({ timeout: 15_000 });
    await box.fill(`${service.title_en} (draft)`);
    const saved = await until(async () => (await draftOf(`serviceHero:${service.id}`))?.draft_content?.titleEn?.value === `${service.title_en} (draft)`, 20_000);
    say(`${label}: the title edit is saved as a draft of that service`, saved);
    say(`${label}: …and the service row is untouched`, (await serviceRow(service.id))?.title_en === service.title_en);
    await editorIdle(page);
    const preview = await visit(`${path}?preview=1`, true);
    say(`${label}: Preview shows the draft`, preview.html.includes(`${service.title_en} (draft)`));
    const live = await visit(path);
    say(`${label}: the public page, its <title> and its structured data do not`, !live.html.includes("(draft)") && !titleTag(live.html).includes("(draft)") && serviceLd(live.html)?.name === service.title_en);

    const panel = await openPanel();
    // The canvas is redrawn once the editor has re-read the page, after the
    // drafts are already gone (CI 37850382078, route-categories).
    const drawn = canvasUrl(page);
    await panel.locator("[data-route-discard]").click();
    await until(async () => (await pendingDrafts()) === 0, 20_000);
    const redrawn = await canvasRedrawn(page, drawn);
    say(`${label}: Discard removes the draft`, (await draftOf(`serviceHero:${service.id}`))?.draft_content == null && redrawn);
    await closePanel();
    const after = await visit(path);
    say(`${label}: the public page never changed`, h1Of(after.html) === h1Of(before.html) && !after.html.includes("data-eod-"), h1Of(after.html));
  }

  /* ================================================================== */
  /* The first service: the full walk                                    */
  /* ================================================================== */
  const mainPath = await pathOf(main.id);
  const mainBefore = await visit(mainPath);

  // Reached the way an admin reaches it: the sidebar, then the page list.
  await page.goto(`${server.origin}/admin`, { waitUntil: "load" });
  await page.getByRole("link", { name: "Visual Editor" }).first().click();
  await page.waitForURL(/\/admin\/visual-editor/, { timeout: 30_000 });
  say("Navigation: the admin's Visual Editor link opens the editor", await editorSettled(page, 60_000));
  const groups = await page.locator('#ve-page optgroup[label^="Services · "]').count();
  const [{ n: categoriesWithServices }] = await sql<{ n: number }[]>`select count(distinct category_id)::int as n from services`;
  const [{ n: serviceCount }] = await sql<{ n: number }[]>`select count(*)::int as n from services`;
  const offered = await page.locator('#ve-page option[value^="service:"]').count();
  say("Navigation: the page list offers every service, in one group per category", groups === categoriesWithServices && offered === serviceCount, `${offered} services in ${groups} groups`);
  await page.locator("#ve-page").selectOption(`service:${main.id}`);
  const switched = await until(async () => canvasUrl(page).includes(`${mainPath}?preview=1&editor=1`), 30_000);
  await editorSettled(page, 60_000);
  say(
    "Navigation: choosing the service opens its real route, and the address names the service",
    switched && decodeURIComponent(page.url()).includes(`route=service:${main.id}`),
    canvasUrl(page),
  );
  const mainH1 = (await frame().locator("h1").first().textContent())?.trim() ?? "";
  say("Main: the canvas shows the real page — its title, header, footer and request form", mainH1 === main.title_en && (await frame().locator("header").count()) > 0 && (await frame().locator("footer").count()) > 0 && (await frame().locator("#request form").count()) === 1, mainH1);

  // Layers: every region, named by the registry, and the request form's parts inside it.
  await layers.locator(`[data-layer-row="serviceHero:${main.id}"]`).waitFor({ timeout: 15_000 });
  const mainRows = await Promise.all(ALWAYS.map((type) => layers.locator(`[data-layer-row="${type}:${main.id}"]`).count()));
  say("Main: Layers holds every region of the page", mainRows.every((count) => count === 1), ALWAYS.filter((_, i) => mainRows[i] !== 1).join(","));
  const related = await layers.locator(`[data-layer-row="serviceRelated:${main.id}"]`).count();
  say("Main: …and the related services, drawn from the category", related === 1);
  await selectFromLayers(page, `serviceRequest:${main.id}`);
  await contentTab();
  const requestFields = (await Promise.all(["heading", "intro"].map((name) => field(name).locator("input, textarea").count()))).every((count) => count > 0);
  say("Main: selecting a region from Layers shows its fields in the Inspector", requestFields);

  // An Inspector edit: the timeline, as a draft of the service.
  const heroPick = await selectCanvasNode(page, `serviceHero:${main.id}/field:title`);
  await contentTab();
  const timeline = field("timeline").locator("input").first();
  await timeline.waitFor({ timeout: 15_000 }).catch(async (error: unknown) => {
    // CI 37850382078 stopped here with nothing but the timeout to go on: what
    // the click selected and what the Inspector held instead go to the job log.
    const holds = (await inspector.innerText().catch(() => "")).replace(/\s+/g, " ").slice(0, 300);
    console.log(`diag the timeline never appeared: the click selected "${heroPick.shows}" (${heroPick.ok ? "as asked" : "not as asked"}); the Inspector holds: ${holds}`);
    throw error;
  });
  await timeline.fill("Usually five working days");
  const timed = await until(async () => (await draftOf(`serviceHero:${main.id}`))?.draft_content?.timelineEn?.value === "Usually five working days", 20_000);
  say("Main: an Inspector edit is saved as a draft of the service", timed);
  say("Main: …and the service row is untouched", (await serviceRow(main.id))?.timeline_en === "");
  await editorIdle(page);

  // A direct edit on the canvas, Undo, Redo, Undo.
  await selectCanvasNode(page, `serviceHero:${main.id}/field:title`);
  const title = frame().locator(`[data-eod-address="serviceHero:${main.id}/field:title"]`);
  await title.dblclick();
  await until(async () => (await title.getAttribute("contenteditable")) !== null, 10_000);
  await page.keyboard.press("End");
  await page.keyboard.type(" Now");
  await page.keyboard.press("Enter");
  const typed = await until(async () => (await draftOf(`serviceHero:${main.id}`))?.draft_content?.titleEn?.value === `${main.title_en} Now`, 20_000);
  say("Main: a direct edit on the canvas becomes the title draft", typed);
  await editorIdle(page);
  await page.locator('[data-history="undo"]').click();
  const undone = await until(async () => {
    const draft = (await draftOf(`serviceHero:${main.id}`))?.draft_content;
    return draft?.titleEn === undefined && draft?.timelineEn?.value === "Usually five working days";
  }, 20_000);
  say("Main: Undo takes the direct edit back and leaves the timeline draft alone", undone);
  await editorIdle(page);
  await page.locator('[data-history="redo"]').click();
  const redone = await until(async () => (await draftOf(`serviceHero:${main.id}`))?.draft_content?.titleEn?.value === `${main.title_en} Now`, 20_000);
  say("Main: Redo puts the direct edit back as the draft", redone);
  await editorIdle(page);
  await page.locator('[data-history="undo"]').click();
  await until(async () => (await draftOf(`serviceHero:${main.id}`))?.draft_content?.titleEn === undefined, 20_000);
  await editorIdle(page);

  // Escape abandons a direct edit: nothing is stored and the words come back.
  await editorSettled(page);
  await selectCanvasNode(page, `serviceHero:${main.id}/field:title`);
  const again = frame().locator(`[data-eod-address="serviceHero:${main.id}/field:title"]`);
  await again.dblclick();
  await until(async () => (await again.getAttribute("contenteditable")) !== null, 10_000);
  await page.keyboard.press("End");
  await page.keyboard.type(" Never");
  await page.keyboard.press("Escape");
  await until(async () => (await again.getAttribute("contenteditable")) === null, 10_000);
  await editorIdle(page);
  say(
    "Main: Escape cancels a direct edit, and nothing is stored",
    (await draftOf(`serviceHero:${main.id}`))?.draft_content?.titleEn === undefined && ((await again.textContent()) ?? "").trim() === main.title_en,
  );

  // A list, edited whole in the Inspector: a benefit added, taken back and put back.
  await selectFromLayers(page, `serviceBenefits:${main.id}`);
  await contentTab();
  await field("benefits").getByRole("button", { name: /^Add benefit/ }).click();
  await field("benefits").locator("li").last().locator("input").first().fill("A benefit from the probe");
  const listed = await until(async () => {
    const value = (await draftOf(`serviceBenefits:${main.id}`))?.draft_content?.benefits?.value as { en: string }[] | undefined;
    return Array.isArray(value) && value.some((row) => row.en === "A benefit from the probe");
  }, 20_000);
  say("Main: a benefit added in the Inspector is a draft of the service's list", listed);
  await editorIdle(page);
  const drawnBenefit = await until(async () => (await frame().locator(`[data-eod-address="serviceBenefits:${main.id}/field:benefits"]`).textContent())?.includes("A benefit from the probe") ?? false, 15_000);
  say("Main: …drawn in the canvas as the page draws its list", drawnBenefit);
  // Two actions, two steps back: the words typed, then the row added. The list
  // is stored without row ids, so each is undone as the whole list it was.
  const benefitsDraft = async () =>
    (await draftOf(`serviceBenefits:${main.id}`))?.draft_content?.benefits?.value as { en: string }[] | undefined;
  const undoLabel = (await page.locator('[data-history="undo"]').getAttribute("aria-label")) ?? "";
  say("Main: Undo names the list edit for what it was", /Change Benefits/.test(undoLabel), undoLabel);
  await page.locator('[data-history="undo"]').click();
  const typingUndone = await until(async () => {
    const rows = await benefitsDraft();
    return Array.isArray(rows) && rows.length === 1 && rows[0]!.en === "";
  }, 20_000);
  say("Main: Undo takes the typing back, leaving the added row empty", typingUndone);
  await editorIdle(page);
  await page.locator('[data-history="undo"]').click();
  const rowUndone = await until(async () => (await draftOf(`serviceBenefits:${main.id}`))?.draft_content == null, 20_000);
  say("Main: Undo again takes the row back, and the draft goes with it", rowUndone);
  await editorIdle(page);
  await page.locator('[data-history="redo"]').click();
  await until(async () => (await benefitsDraft())?.length === 1, 20_000);
  await editorIdle(page);
  await page.locator('[data-history="redo"]').click();
  const listRedone = await until(async () => (await benefitsDraft())?.[0]?.en === "A benefit from the probe", 20_000);
  say("Main: Redo puts the row and its words back", listRedone);
  await editorIdle(page);

  // A step, with its title and its detail.
  await selectFromLayers(page, `serviceProcess:${main.id}`);
  await contentTab();
  await field("steps").getByRole("button", { name: /^Add step/ }).click();
  const step = field("steps").locator("li").last();
  await step.locator("input").first().fill("Send us your documents");
  await step.locator("textarea").first().fill("Scanned copies are enough to start.");
  const stepped = await until(async () => {
    const value = (await draftOf(`serviceProcess:${main.id}`))?.draft_content?.processSteps?.value as { en: string; detailEn: string }[] | undefined;
    return Array.isArray(value) && value.some((row) => row.en === "Send us your documents" && row.detailEn === "Scanned copies are enough to start.");
  }, 20_000);
  say("Main: a step and its detail are a draft of the service's steps", stepped);
  await editorIdle(page);

  // A picture from the library, counted by the library while it is only a draft.
  const [picture] = await sql<{ id: number; filename: string; title: string }[]>`select id, filename, title from media order by id limit 1`;
  if (!picture) throw new Error("the fixture's library holds no picture");
  const usesOf = async () => {
    const tab = await context.newPage();
    await tab.goto(`${server!.origin}/admin/media`, { waitUntil: "load" });
    const text = await tab.locator(`p[title="${picture.filename}"]`).first().locator("xpath=..").innerText();
    await tab.close();
    return /Used in (\d+) place/.exec(text) ? Number(/Used in (\d+) place/.exec(text)![1]) : 0;
  };
  const usedBefore = await usesOf();
  await selectFromLayers(page, `serviceHero:${main.id}`);
  await contentTab();
  await field("image").getByRole("button", { name: "Choose picture" }).click();
  const chooser = page.getByRole("dialog", { name: "Choose Picture" });
  await chooser.waitFor({ timeout: 10_000 });
  await chooser.getByRole("button", { name: picture.title || picture.filename }).first().click();
  const chosen = await until(async () => (await draftOf(`serviceHero:${main.id}`))?.draft_content?.imageId?.value === picture.id, 20_000);
  say("Main: a picture chosen from the library is a draft of the service", chosen);
  await editorIdle(page);
  const drawnPicture = await until(async () => (await frame().locator(`[data-eod-address^="serviceHero:${main.id}"] img[src*="${picture.filename.replace(/\.[a-z]+$/, "")}"]`).count()) > 0, 15_000);
  say("Main: …drawn in the canvas's hero", drawnPicture);
  const usedAfter = await usesOf();
  say("Main: the media library counts the draft's picture as placed", usedAfter === usedBefore + 1, `${usedBefore} → ${usedAfter}`);

  // Arabic: the real /ar route, right to left, its own field — and switching wrote nothing.
  const writes = await revisions();
  await page.getByRole("button", { name: "العربية", exact: true }).click();
  await editorSettled(page, 60_000);
  const arabicUrl = frame().url();
  const rtl = await frame().evaluate(() => document.documentElement.dir);
  say("Main: Arabic opens the real /ar route, right to left", arabicUrl.includes(`/ar${mainPath}?`) && rtl === "rtl", arabicUrl);
  say("Main: switching language wrote nothing", (await revisions()) === writes);
  const arPick = await selectCanvasNode(page, `serviceHero:${main.id}/field:title`);
  say("Main: in Arabic, the title selects on the right-to-left canvas", arPick.ok, arPick.shows);
  await contentTab();
  const arBox = field("title").locator("input").first();
  await arBox.waitFor({ timeout: 15_000 });
  const arDir = await arBox.getAttribute("dir");
  await arBox.fill("عنوان من المسبار");
  const arSaved = await until(async () => (await draftOf(`serviceHero:${main.id}`))?.draft_content?.titleAr?.value === "عنوان من المسبار", 20_000);
  const enKept = (await draftOf(`serviceHero:${main.id}`))?.draft_content?.titleEn === undefined;
  say("Main: the Arabic title is its own right-to-left field, and English is left alone", arSaved && arDir === "rtl" && enKept);
  await editorIdle(page);
  await page.getByRole("button", { name: "English", exact: true }).click();
  await editorSettled(page, 60_000);

  // Devices keep the selection and write nothing; a style chosen on Mobile is Mobile's.
  await selectCanvasNode(page, `serviceHero:${main.id}/field:title`);
  const beforeDevices = await revisions();
  for (const [device, width] of [["Tablet", 834], ["Mobile", 390], ["Desktop", 1440]] as const) {
    await page.getByRole("button", { name: new RegExp(`^${device}`) }).click();
    const reported = await until(async () => (await page.getByText(`Canvas reports ${width}px`).count()) > 0, 20_000);
    const kept = (await inspector.locator("code").allTextContents()).some((text) => text.trim() === `serviceHero:${main.id}/field:title`);
    say(`Main: ${device} resizes the canvas and keeps the selection`, reported && kept);
  }
  say("Main: switching device wrote nothing", (await revisions()) === beforeDevices);

  await page.getByRole("button", { name: /^Mobile/ }).click();
  await until(async () => (await page.getByText("Canvas reports 390px").count()) > 0, 20_000);
  await editorSettled(page);
  const headingPick = await selectCanvasNode(page, `serviceOverview:${main.id}/field:heading`);
  await page.getByRole("tab", { name: /Style/ }).click();
  const color = inspector.locator('[data-style-token="textColor"] select');
  await color.waitFor({ timeout: 15_000 });
  await color.selectOption({ index: 1 });
  const mobileStyled = await until(async () => {
    const styles = (await draftOf(`serviceOverview:${main.id}`))?.draft_styles as { nodes?: Record<string, Record<string, unknown>> } | null;
    const node = styles?.nodes?.["field:heading"];
    return Boolean(node?.mobile) && !node?.base;
  }, 20_000);
  say("Main: a style chosen on Mobile is saved for Mobile only", headingPick.ok && mobileStyled, headingPick.shows);
  await editorIdle(page);
  await page.getByRole("button", { name: /^Desktop/ }).click();
  await until(async () => (await page.getByText("Canvas reports 1440px").count()) > 0, 20_000);
  await editorSettled(page);

  // A style on the hero, at its root, for every device.
  await selectFromLayers(page, `serviceHero:${main.id}`);
  await page.getByRole("tab", { name: /Style/ }).click();
  const background = inspector.locator('[data-style-token="background"] select');
  await background.waitFor({ timeout: 15_000 });
  await background.selectOption({ index: 1 });
  const styled = await until(async () => (await draftOf(`serviceHero:${main.id}`))?.draft_styles != null, 20_000);
  say("Main: a style edit is saved as a style draft", styled);
  await editorIdle(page);
  // A style is taken back and put back like any other edit.
  const heroStyles = async () =>
    Object.keys(((await draftOf(`serviceHero:${main.id}`))?.draft_styles as { nodes?: object } | null)?.nodes ?? {}).length;
  await page.locator('[data-history="undo"]').click();
  const styleUndone = await until(async () => (await heroStyles()) === 0, 20_000);
  say("Main: Undo takes the style back", styleUndone, JSON.stringify((await draftOf(`serviceHero:${main.id}`))?.draft_styles ?? null));
  await editorIdle(page);
  await page.locator('[data-history="redo"]').click();
  const styleRedone = await until(async () => (await heroStyles()) > 0, 20_000);
  say("Main: Redo puts the style back", styleRedone);
  await editorIdle(page);

  // An entrance on the benefits, and its Replay.
  await selectFromLayers(page, `serviceBenefits:${main.id}`);
  await page.getByRole("tab", { name: /Motion/ }).click();
  const entrance = inspector.locator('[data-motion-field="entrance"] select');
  await entrance.waitFor({ timeout: 15_000 });
  await entrance.selectOption({ label: "Fade up" });
  const moved = await until(async () => (await draftOf(`serviceBenefits:${main.id}`))?.draft_motion != null, 20_000);
  say("Main: a motion edit is saved as a motion draft", moved);
  await editorIdle(page);
  await selectFromLayers(page, `serviceBenefits:${main.id}`);
  await page.getByRole("tab", { name: /Motion/ }).click();
  const beforeReplay = await revisions();
  await page.locator('[data-replay-mode="all"]').click();
  const replayed = await until(async () => ((await page.locator("[data-replay-status]").getAttribute("data-replay-status")) ?? "") === "finished", 15_000);
  say("Main: Replay plays the entrance on the canvas", replayed, (await page.locator("[data-replay-status]").getAttribute("data-replay-status")) ?? "");
  say("Main: …and saves nothing", (await revisions()) === beforeReplay);

  // Preview shows every draft; the public page, its metadata and its structured data none.
  const previewHref = await page.getByRole("link", { name: /Preview/ }).getAttribute("href");
  say("Main: Preview opens the service's draft preview", previewHref === `${mainPath}?preview=1`, previewHref ?? "");
  const previewed = (await visit(`${mainPath}?preview=1`, true)).html;
  say(
    "Main: …which shows the timeline, the benefit, the step and the picture",
    ["Usually five working days", "A benefit from the probe", "Send us your documents"].every((words) => previewed.includes(words)) && previewed.includes(picture.filename.replace(/\.[a-z]+$/, "")),
  );
  say("Main: …and the Arabic preview shows the Arabic title", (await visit(`/ar${mainPath}?preview=1`, true)).html.includes("عنوان من المسبار"));
  const liveNow = await visit(mainPath);
  say(
    "Main: the public page shows none of it, and nothing of the editor",
    !["Usually five working days", "A benefit from the probe", "Send us your documents"].some((words) => liveNow.html.includes(words)) && !liveNow.html.includes("data-eod-"),
  );
  say("Main: …nor do its <title> or its structured data", titleTag(liveNow.html) === titleTag(mainBefore.html) && serviceLd(liveNow.html)?.name === main.title_en);
  const signedInPublic = await visit(mainPath, true);
  say("Main: signed in, the ordinary address is still the public page", !signedInPublic.html.includes("data-eod-") && !signedInPublic.html.includes("A benefit from the probe"));

  /* ------------------------------------------------------------------ */
  /* Accessibility: by keyboard, named, explained, nothing doubled       */
  /* ------------------------------------------------------------------ */
  await selectCanvasNode(page, `serviceHero:${main.id}/field:title`);
  const heroToggle = layers.locator(`[data-layer-toggle="serviceHero:${main.id}"]`);
  const overviewRow = layers.locator(`[data-layer-row="serviceOverview:${main.id}"]`);
  await layers.locator(`[data-layer-toggle="serviceOverview:${main.id}"]`).focus();
  await page.keyboard.press("Tab");
  const ring = await overviewRow.evaluate((element) => {
    const style = getComputedStyle(element);
    return document.activeElement === element && element.matches(":focus-visible") && style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
  });
  say("Main: a Layers row takes the keyboard focus, with a visible ring", ring && (await heroToggle.count()) === 1);
  await page.keyboard.press("Enter");
  const keyed = await until(async () => (await inspector.locator(`[data-route-source="serviceOverview:${main.id}"]`).count()) > 0, 15_000);
  say("Main: …and Enter selects that region", keyed);
  const trailPick = await selectCanvasNode(page, `serviceCrumbs:${main.id}/field:trail`);
  const explained = inspector.locator(`[role="note"][data-route-generated="serviceCrumbs:${main.id}/field:trail"]`);
  await explained.waitFor({ timeout: 15_000 }).catch(() => undefined);
  say("Main: the generated breadcrumbs explain themselves in a note", trailPick.ok && (await explained.count()) === 1 && /Generated/.test((await explained.textContent()) ?? ""), trailPick.shows);
  await selectFromLayers(page, `serviceBenefits:${main.id}`);
  await contentTab();
  await openPanel();
  const nameless = await unnamed();
  say("Main: every editor control has an accessible name — Layers, Inspector with a list, panel", nameless.length === 0, nameless.join(" | "));
  await closePanel();
  const editorControls = await frame().evaluate(countInteractive, INTERACTIVE);
  const publicTab = await (await browser.newContext()).newPage();
  await publicTab.goto(`${server.origin}${mainPath}`, { waitUntil: "load" });
  const publicControls = await publicTab.evaluate(countInteractive, INTERACTIVE);
  await publicTab.context().close();
  say("Main: the canvas holds the public page's controls and no others", editorControls === publicControls, `${editorControls} vs ${publicControls}`);

  /* ------------------------------------------------------------------ */
  /* Publish, the public result, history, compare, Restore, Discard      */
  /* ------------------------------------------------------------------ */
  {
    const routeKey = `service:${main.id}`;
    const panel = await openPanel();
    const listed = await until(
      async () =>
        (await Promise.all(
          ["serviceHero", "serviceBenefits", "serviceProcess", "serviceOverview"].map((type) => panel.locator(`[data-route-pending-owner="${type}:${main.id}"]`).count()),
        )).every((count) => count === 1),
      15_000,
    );
    say("Publish: the panel lists every region that is waiting", listed);
    const before = canvasUrl(page);
    await panel.locator("[data-route-publish]").click();
    const wrote = await until(async () => (await serviceRow(main.id))?.timeline_en === "Usually five working days", 20_000);
    say("Publish: Publish writes the drafts to the service's own row", wrote);
    const row = (await serviceRow(main.id))!;
    say(
      "Publish: …every field that was drafted, and nothing else",
      row.title_en === main.title_en &&
        row.title_ar === "عنوان من المسبار" &&
        row.image_id === picture.id &&
        JSON.stringify(row.benefits).includes("A benefit from the probe") &&
        JSON.stringify(row.process_steps).includes("Send us your documents") &&
        row.slug === main.slug &&
        row.category_id === main.category_id,
    );
    const kinds = (await sql<{ kind: string }[]>`select kind from route_versions where route_key = ${routeKey} order by id`).map((entry) => entry.kind);
    say("Publish: …records the page as it was, then the publication", kinds.join(",") === "baseline,publish", kinds.join(","));
    say("Publish: …and leaves no draft behind", (await pendingDrafts()) === 0);
    await canvasRedrawn(page, before);

    const published = (await visit(mainPath)).html;
    say(
      "Publish: the public page shows it at once — the timeline, the benefit, the step and the picture",
      ["Usually five working days", "A benefit from the probe", "Send us your documents"].every((words) => published.includes(words)) &&
        published.includes(picture.filename.replace(/\.[a-z]+$/, "")) &&
        !published.includes("data-eod-"),
    );
    say("Publish: …with its published entrance and its Mobile style", /data-m-reveal/.test(published) && /--rs-|data-rs-/.test(published));
    say("Publish: the Arabic page shows the Arabic title", h1Of((await visit(`/ar${mainPath}`)).html) === "عنوان من المسبار");

    const versions = panel.locator("[data-route-history] [data-route-version]");
    const listedVersions = await until(async () => (await versions.count()) === 2, 15_000);
    say("History: both versions are listed", listedVersions, `${await versions.count()}`);
    const [baseline] = await sql<{ id: number }[]>`select id from route_versions where route_key = ${routeKey} and kind = 'baseline'`;
    await panel.locator(`[data-route-version="${baseline!.id}"]`).getByRole("button", { name: "Compare with live" }).click();
    const compared = panel.locator(`[data-route-compare="${baseline!.id}"]`);
    await compared.waitFor({ timeout: 15_000 });
    const comparedText = (await compared.textContent()) ?? "";
    say("History: Compare with live names what changed", comparedText.includes("Usually five working days") && comparedText.includes("A benefit from the probe"), comparedText.slice(0, 160));
    const viewed = (await visit(`${mainPath}?compare=v${baseline!.id}`, true)).html;
    say("History: View shows that version, read only", !viewed.includes("Usually five working days") && viewed.includes("data-eod-still") && h1Of(viewed) === main.title_en);
    const anonymous = (await visit(`${mainPath}?compare=v${baseline!.id}`)).html;
    say("History: …and to a visitor the same address is the live page", anonymous.includes("Usually five working days") && !anonymous.includes("data-eod-"));

    await panel.locator(`[data-route-restore="${baseline!.id}"]`).click();
    const restored = await until(async () => (await draftOf(`serviceHero:${main.id}`))?.draft_content?.timelineEn?.value === "", 20_000);
    say("Restore: the old version comes back as a draft", restored);
    say("Restore: …and the live page does not change", (await serviceRow(main.id))?.timeline_en === "Usually five working days" && (await visit(mainPath)).html.includes("Usually five working days"));
    say("Restore: …and nothing is published", (await sql<{ n: number }[]>`select count(*)::int as n from route_versions where route_key = ${routeKey}`)[0]!.n === 2);
    const discardReady = await until(async () => await panel.locator("[data-route-discard]").isEnabled(), 15_000);
    if (discardReady) await panel.locator("[data-route-discard]").click();
    const dropped = await until(async () => (await pendingDrafts()) === 0, 20_000);
    say("Discard: the restored draft goes, and live stays as published", discardReady && dropped && (await serviceRow(main.id))?.timeline_en === "Usually five working days");
    await closePanel();
  }

  /* ================================================================== */
  /* Two more services, from two more categories                         */
  /* ================================================================== */
  await core(second, "Second category");
  await core(third, "Third category");

  /* ================================================================== */
  /* A move to another category, on the Services screen, and back        */
  /* ================================================================== */
  {
    const oldPath = await pathOf(second.id);
    await openService(second.id);
    await selectCanvasNode(page, `serviceHero:${second.id}/field:title`);
    await contentTab();
    const box = field("timeline").locator("input").first();
    await box.waitFor({ timeout: 15_000 });
    await box.fill("Drafted before the move");
    await until(async () => (await draftOf(`serviceHero:${second.id}`))?.draft_content?.timelineEn?.value === "Drafted before the move", 20_000);
    await editorIdle(page);

    const [target] = await sql<{ id: number; title_en: string }[]>`
      select c.id, c.title_en from service_categories c
       where c.id <> ${second.category_id} and c.is_published
         and not exists (select 1 from services s where s.category_id = c.id and s.slug = ${second.slug})
       order by c.sort_order, c.id limit 1`;
    const moveTo = async (categoryId: number, groupId: number | null) => {
      await page.goto(`${server!.origin}/admin/services/${second.id}`, { waitUntil: "load" });
      await page.locator("#categoryId").selectOption(String(categoryId));
      await page.locator("#subcategoryId").selectOption(groupId === null ? "" : String(groupId));
      await page.getByRole("button", { name: "Save changes" }).click();
      return until(async () => Number((await serviceRow(second.id))?.category_id) === categoryId, 20_000);
    };
    const moved = await moveTo(target!.id, null);
    const newPath = await pathOf(second.id);
    say("Move: the Services screen's Category moves the service", moved && newPath !== oldPath, `${oldPath} → ${newPath}`);
    await openService(second.id);
    say("Move: the same document opens at its new address", canvasUrl(page).includes(`${newPath}?preview=1&editor=1`), canvasUrl(page));
    say("Move: …with its draft, its regions and its identity unchanged", (await frame().content()).includes("Drafted before the move") && (await layers.locator(`[data-layer-row="serviceHero:${second.id}"]`).count()) === 1);
    const routeKeys = (await sql<{ route_key: string }[]>`select distinct route_key from route_nodes where owner_key ~ ${`^service[A-Z][A-Za-z]*:${second.id}$`}`).map((entry) => entry.route_key);
    say("Move: no second identity was made for it", routeKeys.join(",") === `service:${second.id}`, routeKeys.join(","));
    say("Move: the old address answers as a missing page did before, in both editions", (await statusOf(oldPath)) === 404 && (await statusOf(`/ar${oldPath}`)) === 404 && (await statusOf(newPath)) === 200);
    const panel = await openPanel();
    await panel.locator("[data-route-discard]").click();
    await until(async () => (await pendingDrafts()) === 0, 20_000);
    await closePanel();
    const back = await moveTo(second.category_id, second.subcategory_id);
    say("Move: moved back on the same screen, it answers at its first address again", back && (await pathOf(second.id)) === oldPath && (await statusOf(oldPath)) === 200);
  }

  /* ================================================================== */
  /* A service made while the probe runs, through the Services screen    */
  /* ================================================================== */
  {
    const slug = "made-during-the-probe";
    await page.goto(`${server.origin}/admin/services/new`, { waitUntil: "load" });
    await page.locator("#titleEn").fill("Made During The Probe");
    await page.locator("#introEn").fill("A service no code has heard of.");
    await page.locator("#categoryId").selectOption(String(third.category_id));
    await page.locator("#slug").fill(slug);
    const publish = page.locator('input[name="isPublished"]');
    if (!(await publish.isChecked())) await publish.check();
    await page.getByRole("button", { name: "Create service" }).click();
    const madeOk = await until(async () => (await sql`select 1 from services where slug = ${slug}`).length === 1, 20_000);
    const [{ id }] = await sql<{ id: number }[]>`select id from services where slug = ${slug}`;
    const made: Service = { id, slug, title_en: "Made During The Probe", category_id: third.category_id, subcategory_id: null };
    say("Created: the Services screen makes the service", madeOk);

    await page.goto(`${server.origin}/admin/visual-editor`, { waitUntil: "load" });
    await editorSettled(page, 60_000);
    const listedNew = await page.locator(`#ve-page option[value="service:${id}"]`).count();
    say("Created: the editor's page list offers it, with no code", listedNew === 1);
    await core(made, "Created");

    // Edited, then published, then gone again — through the screens an admin uses.
    const path = await pathOf(id);
    await selectCanvasNode(page, `serviceHero:${id}/field:title`);
    await contentTab();
    const timeline = field("timeline").locator("input").first();
    await timeline.waitFor({ timeout: 15_000 });
    await timeline.fill("Ready in a day");
    await until(async () => (await draftOf(`serviceHero:${id}`))?.draft_content?.timelineEn?.value === "Ready in a day", 20_000);
    await editorIdle(page);
    const panel = await openPanel();
    await panel.locator("[data-route-publish]").click();
    const live = await until(async () => (await serviceRow(id))?.timeline_en === "Ready in a day", 20_000);
    say("Created: it publishes like any other service", live && (await visit(path)).html.includes("Ready in a day"));
    await closePanel();

    await page.goto(`${server.origin}/admin/services/${id}`, { waitUntil: "load" });
    await page.getByRole("button", { name: "Delete service" }).click();
    const deleted = await until(async () => (await serviceRow(id)) === null, 20_000);
    say("Created: the Services screen deletes it again", deleted);
    say("Created: …its page is gone, and the editor no longer offers it", (await statusOf(path)) === 404 && (await (async () => {
      await page.goto(`${server!.origin}/admin/visual-editor`, { waitUntil: "load" });
      await editorSettled(page, 60_000);
      return page.locator(`#ve-page option[value="service:${id}"]`).count();
    })()) === 0);
  }

  // What the probe made is gone; what it changed on the first service is the probe's own publication.
  const leftovers = await sql<{ n: number }[]>`select count(*)::int as n from services where slug = 'made-during-the-probe'`;
  say("Clean-up: no draft is pending and the created service is gone", (await pendingDrafts()) === 0 && leftovers[0]!.n === 0);
  say("no page errors in the editor or the canvas", errors.length === 0, errors.join(" | "));
} catch (error) {
  // A probe that dies says, in the job log, what its server said (`../evidence`).
  serverEvidence(server, secrets);
  throw error;
} finally {
  await browser.close();
  await server?.stop();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
