/**
 * Batch 21 acceptance: service-category pages in the Visual Editor, in a real
 * Chromium, on the real routes.
 *
 * Travel & Tourism gets the full walk the brief lists — load, the real page in
 * the canvas, Layers, the title selected from the canvas, a direct edit taken
 * back with Undo, a service card and its introduction, English and Arabic,
 * Desktop/Tablet/Mobile, a style, an entrance and its Replay, Preview, Discard
 * and a public page that never moved — then the same page by keyboard, with
 * every control named, the generated explained and nothing added inside the
 * canvas. Business Setup and Iqama get the core of it. Three more prove the
 * editor knows no category by name: two categories the seed ships that no
 * editor code mentions, and one created while the probe runs, which is also
 * published, compared, restored to a draft and discarded.
 */

import { editorIdle, editorSettled, selectCanvasNode, selectFromLayers } from "../canvas";
import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";
import { until } from "../wait";

const PORT = 3732;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("route_categories_probe");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);

  // A category the seed never had, created before the server starts so the
  // probe proves discovery rather than a cache: one group, one service.
  const [created] = await sql<{ id: number }[]>`
    insert into service_categories (slug, title_en, summary_en, tagline_en, icon, is_published, sort_order)
    values ('created-for-the-probe', 'Created For The Probe', 'A category no code has heard of.', 'Brand new', 'star', true, 50)
    returning id`;
  const [createdGroup] = await sql<{ id: number }[]>`
    insert into service_subcategories (category_id, slug, title_en, sort_order, is_published)
    values (${created!.id}, 'probe-group', 'Probe Group', 1, true) returning id`;
  await sql`
    insert into services (category_id, subcategory_id, slug, title_en, intro_en, sort_order, is_published)
    values (${created!.id}, ${createdGroup!.id}, 'probe-service', 'Probe Service', 'Made by the probe.', 1, true)`;

  server = await startServer(database, PORT);

  const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message.slice(0, 160)));
  page.on("dialog", (dialog) => void dialog.accept());

  type Category = { id: number; slug: string; title_en: string };
  const bySlug = async (slug: string) =>
    (await sql<Category[]>`select id, slug, title_en from service_categories where slug = ${slug}`)[0]!;
  const draftOf = async (ownerKey: string) =>
    (await sql<{ draft_content: Record<string, { value: unknown }> | null; draft_styles: unknown; draft_motion: unknown; revision: number }[]>`
      select draft_content, draft_styles, draft_motion, revision from route_nodes where owner_key = ${ownerKey}`)[0] ?? null;
  const revisions = async () =>
    (await sql<{ n: number }[]>`select coalesce(sum(revision), 0)::int as n from route_nodes`)[0]!.n;
  const titleOf = async (id: number) =>
    (await sql<{ title_en: string }[]>`select title_en from service_categories where id = ${id}`)[0]!.title_en;
  const visit = async (path: string, signedIn = false) => {
    const fresh = signedIn ? context : await browser.newContext();
    const tab = await fresh.newPage();
    await tab.goto(`${server!.origin}${path}`, { waitUntil: "load" });
    const html = await tab.content();
    await tab.close();
    if (!signedIn) await fresh.close();
    return html;
  };
  const frame = () => page.frames().find((candidate) => candidate.url().includes("editor=1"))!;
  const inspector = page.locator("aside[aria-label='Inspector']");
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
  const titleBox = () => inspector.locator('[data-field="title"] input').first();
  const h1Of = (html: string) => /<h1[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1] ?? "";
  const pendingDrafts = async () =>
    (await sql<{ n: number }[]>`
      select count(*)::int as n from route_nodes
       where draft_content is not null or draft_styles is not null or draft_motion is not null`)[0]!.n;

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
      const bad = nodes.filter(
        (node) => !node.ignored && AX_INTERACTIVE.has(String(node.role?.value)) && !String(node.name?.value ?? "").trim(),
      );
      const out: string[] = [];
      for (const node of bad.slice(0, 3)) {
        const html =
          node.backendDOMNodeId === undefined
            ? "?"
            : ((await cdp.send("DOM.getOuterHTML", { backendNodeId: node.backendDOMNodeId }).catch(() => ({ outerHTML: "?" }))) as {
                outerHTML: string;
              }).outerHTML;
        out.push(`${node.role?.value} ${html.slice(0, 100)}`);
      }
      return bad.length > out.length ? [...out, `${bad.length} unnamed in all`] : out;
    } finally {
      await cdp.detach();
    }
  };

  /** The core every category gets: load, the real page, Layers, select, draft, preview, discard. */
  async function core(category: Category, label: string) {
    const before = await visit(`/services/${category.slug}`);
    await page.goto(`${server!.origin}/admin/visual-editor?route=category:${category.id}&lang=en&device=desktop`, { waitUntil: "load" });
    say(`${label}: loads in the Visual Editor`, await editorSettled(page, 60_000));
    const url = frame()?.url() ?? "";
    say(`${label}: the canvas is its real public route`, url.includes(`/services/${category.slug}?preview=1&editor=1`), url);
    const h1 = (await frame().locator("h1").first().textContent())?.trim() ?? "";
    const chrome = (await frame().locator("header").count()) > 0 && (await frame().locator("footer").count()) > 0;
    say(`${label}: the canvas shows the real page — its title, header and footer`, h1 === category.title_en && chrome, h1);

    const layers = page.locator("[data-route-layers]");
    await layers.locator(`[data-layer-row="category:${category.id}"]`).waitFor({ timeout: 15_000 });
    await layers.locator(`[data-layer-toggle="categoryServices:${category.id}"]`).click();
    const groups = await layers.locator('[data-route-region="route-subcategory"]').count();
    say(`${label}: Layers holds the hero, the services and their groups`, groups > 0, `${groups} group(s)`);

    const picked = await selectCanvasNode(page, `category:${category.id}/field:title`);
    say(`${label}: clicking the title on the canvas selects it in the Inspector`, picked.ok, picked.shows);

    const box = titleBox();
    await box.waitFor({ timeout: 15_000 });
    await box.fill(`${category.title_en} (draft)`);
    const saved = await until(async () => {
      const row = await draftOf(`category:${category.id}`);
      return row?.draft_content?.titleEn?.value === `${category.title_en} (draft)`;
    }, 20_000);
    say(`${label}: the title edit is saved as a draft`, saved);
    say(`${label}: …and the live record is untouched`, (await titleOf(category.id)) === category.title_en);
    await editorIdle(page);

    const preview = await visit(`/services/${category.slug}?preview=1`, true);
    say(`${label}: Preview shows the draft`, preview.includes(`${category.title_en} (draft)`));

    const panel = await openPanel();
    await panel.locator("[data-route-discard]").click();
    await until(async () => (await draftOf(`category:${category.id}`))?.draft_content == null, 20_000);
    say(`${label}: Discard removes the draft`, (await draftOf(`category:${category.id}`))?.draft_content == null);
    await closePanel();
    await editorSettled(page);
    const after = await visit(`/services/${category.slug}`);
    say(`${label}: the public page never changed`, h1Of(after) === h1Of(before) && !after.includes("data-eod-"), h1Of(after));
  }

  /* ================================================================== */
  /* Travel & Tourism: the full walk                                     */
  /* ================================================================== */
  const travel = await bySlug("travel-tourism");
  await core(travel, "Travel");

  // Direct edit on the canvas, then Undo.
  await selectCanvasNode(page, `category:${travel.id}/field:title`);
  const title = frame().locator(`[data-eod-address="category:${travel.id}/field:title"]`);
  await title.dblclick();
  await until(async () => (await title.getAttribute("contenteditable")) !== null, 10_000);
  await page.keyboard.press("End");
  await page.keyboard.type(" Now");
  await page.keyboard.press("Enter");
  const typed = await until(async () => (await draftOf(`category:${travel.id}`))?.draft_content?.titleEn?.value === `${travel.title_en} Now`, 20_000);
  say("Travel: a direct edit on the canvas becomes the title draft", typed);
  await editorIdle(page);
  await page.locator('[data-history="undo"]').click();
  const undone = await until(async () => (await draftOf(`category:${travel.id}`))?.draft_content == null, 20_000);
  say("Travel: Undo takes the direct edit back, and the draft goes with it", undone);
  await editorIdle(page);
  await page.locator('[data-history="redo"]').click();
  const redone = await until(async () => (await draftOf(`category:${travel.id}`))?.draft_content?.titleEn?.value === `${travel.title_en} Now`, 20_000);
  say("Travel: Redo puts the direct edit back as the draft", redone);
  await editorIdle(page);
  await page.locator('[data-history="undo"]').click();
  await until(async () => (await draftOf(`category:${travel.id}`))?.draft_content == null, 20_000);
  await editorIdle(page);

  // Escape abandons a direct edit: nothing is stored and the words come back.
  // The canvas was redrawn by Undo and Redo, so the title is found afresh.
  await editorSettled(page);
  await selectCanvasNode(page, `category:${travel.id}/field:title`);
  const again = frame().locator(`[data-eod-address="category:${travel.id}/field:title"]`);
  await again.dblclick();
  await until(async () => (await again.getAttribute("contenteditable")) !== null, 10_000);
  await page.keyboard.press("End");
  await page.keyboard.type(" Never");
  await page.keyboard.press("Escape");
  await until(async () => (await again.getAttribute("contenteditable")) === null, 10_000);
  await editorIdle(page);
  const abandoned = (await draftOf(`category:${travel.id}`))?.draft_content == null && ((await again.textContent()) ?? "").trim() === travel.title_en;
  say("Travel: Escape cancels a direct edit, and nothing is stored", abandoned);

  // A service card, and its introduction.
  const [card] = await sql<{ id: number; intro_en: string }[]>`
    select s.id, s.intro_en from services s join service_subcategories g on g.id = s.subcategory_id
     where s.category_id = ${travel.id} and s.is_published and g.is_published order by g.sort_order, s.sort_order limit 1`;
  const cardPick = await selectCanvasNode(page, `service:${card!.id}`);
  say("Travel: a service card selects as its own service", cardPick.ok, cardPick.shows);
  await page.getByRole("tab", { name: /Content/ }).click();
  const intro = inspector.locator('[data-field="intro"] textarea').first();
  await intro.waitFor({ timeout: 15_000 });
  await intro.fill("A draft introduction from the probe.");
  const introSaved = await until(
    async () => (await draftOf(`service:${card!.id}`))?.draft_content?.introEn?.value === "A draft introduction from the probe.",
    20_000,
  );
  say("Travel: the introduction is saved as a draft of that service", introSaved);
  await editorIdle(page);

  // Languages write nothing.
  const writes = await revisions();
  await page.getByRole("button", { name: "العربية", exact: true }).click();
  await editorSettled(page, 60_000);
  const arabic = frame().url();
  const rtl = await frame().evaluate(() => document.documentElement.dir);
  say("Travel: Arabic opens the real /ar route, right to left", arabic.includes(`/ar/services/${travel.slug}?`) && rtl === "rtl", arabic);
  await page.getByRole("button", { name: "English", exact: true }).click();
  await editorSettled(page, 60_000);
  say("Travel: switching language wrote nothing", (await revisions()) === writes);

  // Devices keep the selection and write nothing.
  await selectCanvasNode(page, `service:${card!.id}/field:title`);
  for (const [device, width] of [["Tablet", 834], ["Mobile", 390], ["Desktop", 1440]] as const) {
    await page.getByRole("button", { name: new RegExp(`^${device}`) }).click();
    const reported = await until(async () => (await page.getByText(`Canvas reports ${width}px`).count()) > 0, 20_000);
    const kept = (await inspector.locator("code").allTextContents()).some((text) => text.trim() === `service:${card!.id}/field:title`);
    say(`Travel: ${device} resizes the canvas and keeps the selection`, reported && kept);
  }
  say("Travel: switching device wrote nothing", (await revisions()) === writes);

  // A style on the hero, at its root.
  await selectFromLayers(page, `category:${travel.id}`);
  await page.getByRole("tab", { name: /Style/ }).click();
  const background = inspector.locator('[data-style-token="background"] select');
  await background.waitFor({ timeout: 15_000 });
  await background.selectOption({ index: 1 });
  const styled = await until(async () => (await draftOf(`category:${travel.id}`))?.draft_styles != null, 20_000);
  say("Travel: a style edit is saved as a style draft", styled);
  await editorIdle(page);

  // An entrance on a card title, and its Replay.
  await selectCanvasNode(page, `service:${card!.id}/field:title`);
  await page.getByRole("tab", { name: /Motion/ }).click();
  const entrance = inspector.locator('[data-motion-field="entrance"] select');
  await entrance.waitFor({ timeout: 15_000 });
  await entrance.selectOption({ label: "Fade up" });
  const moved = await until(async () => (await draftOf(`service:${card!.id}`))?.draft_motion != null, 20_000);
  say("Travel: a motion edit is saved as a motion draft", moved);
  await editorIdle(page);
  await selectCanvasNode(page, `service:${card!.id}/field:title`);
  await page.getByRole("tab", { name: /Motion/ }).click();
  const writesBeforeReplay = await revisions();
  await page.locator('[data-replay-mode="all"]').click();
  const replayed = await until(
    async () => ((await page.locator("[data-replay-status]").getAttribute("data-replay-status")) ?? "") === "finished",
    15_000,
  );
  say("Travel: Replay plays the entrance on the canvas", replayed, (await page.locator("[data-replay-status]").getAttribute("data-replay-status")) ?? "");
  say("Travel: …and saves nothing", (await revisions()) === writesBeforeReplay);

  // Order and visibility, from Layers: a card trades places with the next card of its
  // group on the same side of the featured line, then is hidden — each a draft of the
  // record that holds it, each drawn on the canvas, each taken back by Undo.
  const rows = await sql<{ id: number; subcategory_id: number; is_featured: boolean }[]>`
    select s.id, s.subcategory_id, s.is_featured from services s join service_subcategories g on g.id = s.subcategory_id
     where s.category_id = ${travel.id} and s.is_published and g.is_published
     order by g.sort_order, g.id, s.is_featured desc, s.sort_order, s.id`;
  const index = rows.findIndex(
    (row, i) => i + 1 < rows.length && rows[i + 1]!.subcategory_id === row.subcategory_id && rows[i + 1]!.is_featured === row.is_featured,
  );
  if (index < 0) throw new Error("no group with two neighbouring cards on the same side of the featured line");
  const [first, second] = [rows[index]!.id, rows[index + 1]!.id];
  const group = rows[index]!.subcategory_id;
  const [{ slug: firstSlug }] = await sql<{ slug: string }[]>`select slug from services where id = ${first}`;
  const drawnBefore = (a: number, b: number) =>
    until(
      async () =>
        frame().evaluate(([x, y]) => {
          const order = [...document.querySelectorAll("[data-eod-address]")].map((element) => element.getAttribute("data-eod-address"));
          return order.indexOf(`service:${x}`) >= 0 && order.indexOf(`service:${x}`) < order.indexOf(`service:${y}`);
        }, [a, b] as const),
      20_000,
    );
  await selectCanvasNode(page, `service:${first}`);
  const ops = page.locator(`[data-route-ops="service:${first}"] button`);
  await ops.nth(1).click();
  const movedDown = await until(async () => {
    const order = (await draftOf(`subcategory:${group}`))?.draft_content?.["order:services"]?.value as number[] | undefined;
    return Array.isArray(order) && order.indexOf(second) >= 0 && order.indexOf(second) < order.indexOf(first);
  }, 20_000);
  say("Travel: Move down in Layers is an order draft of the card's group", movedDown);
  await editorIdle(page);
  say("Travel: …and the canvas draws the new order", await drawnBefore(second, first));
  await page.locator('[data-history="undo"]').click();
  const reordered = await until(async () => (await draftOf(`subcategory:${group}`))?.draft_content?.["order:services"] == null, 20_000);
  say("Travel: Undo puts the order back, and the draft goes with it", reordered && (await drawnBefore(first, second)));
  await editorIdle(page);

  await selectCanvasNode(page, `service:${first}`);
  await page.locator(`[data-route-ops="service:${first}"] button`).nth(2).click();
  const hidden = await until(async () => (await draftOf(`service:${first}`))?.draft_content?.isPublished?.value === false, 20_000);
  say("Travel: Hide in Layers is a visibility draft of that service", hidden);
  await editorIdle(page);
  const dimmed = await until(
    async () => (await frame().locator(`[data-eod-address="service:${first}"][data-eod-hidden]`).count()) === 1,
    20_000,
  );
  say(
    "Travel: …drawn dimmed on the canvas, and still on the public page",
    dimmed && (await visit(`/services/${travel.slug}`)).includes(`/services/${travel.slug}/${firstSlug}`),
  );
  await page.locator('[data-history="undo"]').click();
  const shownAgain = await until(async () => (await draftOf(`service:${first}`))?.draft_content?.isPublished == null, 20_000);
  say("Travel: Undo shows it again, and the draft goes with it", shownAgain);
  await editorIdle(page);

  // Preview, then Discard, and the public page never moved.
  const previewHref = await page.getByRole("link", { name: /Preview/ }).getAttribute("href");
  say("Travel: Preview opens the route's draft preview", previewHref === `/services/${travel.slug}?preview=1`, previewHref ?? "");
  const previewed = await visit(`/services/${travel.slug}?preview=1`, true);
  say("Travel: …which shows the draft introduction", previewed.includes("A draft introduction from the probe."));
  const live = await visit(`/services/${travel.slug}`);
  say("Travel: the public page shows none of it", !live.includes("A draft introduction from the probe.") && !live.includes("data-eod-"));
  const panel = await openPanel();
  await panel.locator("[data-route-discard]").click();
  await until(async () => (await pendingDrafts()) === 0, 20_000);
  const pending = await pendingDrafts();
  say("Travel: Discard clears every draft on the page", pending === 0, `${pending}`);
  await closePanel();

  /* ------------------------------------------------------------------ */
  /* Accessibility: by keyboard, named, explained, nothing doubled       */
  /* ------------------------------------------------------------------ */
  // A region is chosen from Layers with the keyboard alone: Tab onto its row,
  // where the focus ring shows, and Enter selects it.
  await selectCanvasNode(page, `service:${card!.id}/field:title`);
  const heroToggle = page.locator(`[data-route-layers] [data-layer-toggle="category:${travel.id}"]`);
  const heroRow = page.locator(`[data-route-layers] [data-layer-row="category:${travel.id}"]`);
  await heroToggle.focus();
  await page.keyboard.press("Tab");
  const ring = await heroRow.evaluate((element) => {
    const style = getComputedStyle(element);
    return document.activeElement === element && element.matches(":focus-visible") && style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
  });
  say("Travel: a Layers row takes the keyboard focus, with a visible ring", ring);
  await page.keyboard.press("Enter");
  const keyed = await until(async () => (await inspector.locator(`[data-route-source="category:${travel.id}"]`).count()) > 0, 15_000);
  say("Travel: …and Enter selects that region", keyed);

  // What is generated says so, as a note a screen reader announces, with no input to type into.
  const trailPick = await selectCanvasNode(page, `categoryCrumbs:${travel.id}/field:trail`);
  const explained = inspector.locator(`[role="note"][data-route-generated="categoryCrumbs:${travel.id}/field:trail"]`);
  await explained.waitFor({ timeout: 15_000 }).catch(() => undefined);
  say(
    "Travel: the generated breadcrumbs explain themselves in a note",
    trailPick.ok && (await explained.count()) === 1 && /Generated/.test((await explained.textContent()) ?? ""),
    trailPick.shows,
  );

  // Every control the route's Layers, Inspector and panel draw has a name.
  await selectCanvasNode(page, `service:${card!.id}/field:title`);
  await openPanel();
  const nameless = await unnamed();
  say("Travel: every editor control has an accessible name — Layers, Inspector, panel", nameless.length === 0, nameless.join(" | "));
  await closePanel();

  // The editor marks the page's elements; it adds no control of its own inside the canvas.
  const editorControls = await frame().evaluate(countInteractive, INTERACTIVE);
  const publicTab = await (await browser.newContext()).newPage();
  await publicTab.goto(`${server.origin}/services/${travel.slug}`, { waitUntil: "load" });
  const publicControls = await publicTab.evaluate(countInteractive, INTERACTIVE);
  await publicTab.context().close();
  say("Travel: the canvas holds the public page's controls and no others", editorControls === publicControls, `${editorControls} vs ${publicControls}`);

  // A signed-in owner on the ordinary address gets the ordinary page.
  const signedInPublic = await visit(`/services/${travel.slug}`, true);
  say("Travel: signed in, the ordinary address is still the public page", !signedInPublic.includes("data-eod-"));

  // Right to left, the editor still selects and explains.
  await page.getByRole("button", { name: "العربية", exact: true }).click();
  await editorSettled(page, 60_000);
  const arTitle = await selectCanvasNode(page, `category:${travel.id}/field:title`);
  const arDir = await frame().evaluate(() => document.documentElement.dir);
  say("Travel: in Arabic, the title selects on the right-to-left canvas", arTitle.ok && arDir === "rtl", arTitle.shows);
  await page.getByRole("button", { name: "English", exact: true }).click();
  await editorSettled(page, 60_000);
  say("Travel: the accessibility walk wrote nothing", (await pendingDrafts()) === 0);

  /* ================================================================== */
  /* Business Setup and Iqama: the core                                  */
  /* ================================================================== */
  await core(await bySlug("business-setup"), "Business");
  await core(await bySlug("iqama-services"), "Iqama");

  /* ================================================================== */
  /* No category is special                                              */
  /* ================================================================== */
  await core(await bySlug("license-renewal"), "Generic (license-renewal)");
  await core(await bySlug("government-relations"), "Generic (government-relations)");
  await page.goto(`${server.origin}/admin/visual-editor?route=category:${travel.id}`, { waitUntil: "load" });
  const offered = await page.locator(`#ve-page option[value="category:${created!.id}"]`).count();
  say("Generic: a category created after the build is offered in the page list", offered === 1);
  await core({ id: created!.id, slug: "created-for-the-probe", title_en: "Created For The Probe" }, "Generic (created)");

  /* ================================================================== */
  /* Publish, history, compare and Restore — on the probe's own category */
  /* ================================================================== */
  {
    const routeKey = `category:${created!.id}`;
    const original = "Created For The Probe";
    const published = "Created For The Probe, Published";
    await selectCanvasNode(page, `${routeKey}/field:title`);
    const box = titleBox();
    await box.waitFor({ timeout: 15_000 });
    await box.fill(published);
    await until(async () => (await draftOf(routeKey))?.draft_content?.titleEn?.value === published, 20_000);
    await editorIdle(page);

    const panel = await openPanel();
    const listed = await until(async () => (await panel.locator(`[data-route-pending-owner="${routeKey}"]`).count()) === 1, 15_000);
    say("Publish: the panel lists what is waiting", listed);
    await panel.locator("[data-route-publish]").click();
    const wrote = await until(async () => (await titleOf(created!.id)) === published, 20_000);
    say("Publish: Publish writes the draft to the category record", wrote);
    const kinds = (await sql<{ kind: string }[]>`select kind from route_versions where route_key = ${routeKey} order by id`).map((row) => row.kind);
    say("Publish: …and records the page as it was, then the publication", kinds.join(",") === "baseline,publish", kinds.join(","));
    say("Publish: …and leaves no draft behind", (await draftOf(routeKey))?.draft_content == null);
    const shown = h1Of(await visit("/services/created-for-the-probe"));
    say("Publish: the public page shows it", shown === published, shown);

    const versions = panel.locator("[data-route-history] [data-route-version]");
    const listedVersions = await until(async () => (await versions.count()) === 2, 15_000);
    say("History: both versions are listed", listedVersions, `${await versions.count()}`);
    const [baseline] = await sql<{ id: number }[]>`
      select id from route_versions where route_key = ${routeKey} and kind = 'baseline'`;
    await panel.locator(`[data-route-version="${baseline!.id}"]`).getByRole("button", { name: "Compare with live" }).click();
    const compared = panel.locator(`[data-route-compare="${baseline!.id}"]`);
    await compared.waitFor({ timeout: 15_000 });
    const comparedText = (await compared.textContent()) ?? "";
    say("History: Compare with live names the title that differs", comparedText.includes(original) && comparedText.includes(published));
    const viewed = h1Of(await visit(`/services/created-for-the-probe?compare=v${baseline!.id}`, true));
    say("History: View shows that version, read only", viewed === original, viewed);
    const anonymous = h1Of(await visit(`/services/created-for-the-probe?compare=v${baseline!.id}`));
    say("History: …and to a visitor the same address is the live page", anonymous === published, anonymous);

    await panel.locator(`[data-route-restore="${baseline!.id}"]`).click();
    const restored = await until(async () => (await draftOf(routeKey))?.draft_content?.titleEn?.value === original, 20_000);
    say("Restore: the old title comes back as a draft", restored);
    say("Restore: …and the live page does not change", (await titleOf(created!.id)) === published && h1Of(await visit("/services/created-for-the-probe")) === published);
    const discardReady = await until(async () => await panel.locator("[data-route-discard]").isEnabled(), 15_000);
    if (discardReady) await panel.locator("[data-route-discard]").click();
    const dropped = await until(async () => (await pendingDrafts()) === 0, 20_000);
    say("Restore: Discard drops the restored draft and live stays published", discardReady && dropped && (await titleOf(created!.id)) === published);
    await closePanel();
  }

  say("no page errors in the editor or the canvas", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  await server?.stop();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
