/**
 * Batch 23: typing in the Inspector across an autosave, in a real Chromium.
 *
 * Every save redraws the canvas, and the Inspector used to be drawn again with
 * it — the box being typed in was replaced and the keyboard focus fell to the
 * page. The next keystroke went nowhere. This walks the editors that share the
 * Inspector (a CMS page, a category page, a service page — and since Batch 24
 * a package's page, a card on Tour packages, a destination's page and the
 * services overview) and types
 * across real autosaves: a text box, a textarea with the caret in the middle,
 * a list row, Arabic, the three devices, several saves in a row, a save the
 * server is slow to answer and a direct edit on the canvas. Each case checks
 * the element that actually holds the focus (the same element, not one that
 * looks like it), the caret, and the text both on screen and in the database.
 *
 * Then the races: a selection changed while an older save is still on its way
 * stays where the person put it, focus moved to another box is not pulled
 * back, and a selected element that the save removed falls back to its
 * section instead of being held. And Layers (Batch 24): a row's control
 * pressed from the keyboard — a card hidden on Tour packages, a section moved
 * on a page — keeps the focus through the redraw it causes, or hands it to its
 * row when the control is disabled there. Nothing here publishes.
 */

import { canvasUrl, canvasRedrawn, editorIdle, editorSettled, inspectorAddress, selectCanvasNode, selectFromLayers, waitForInspector } from "../canvas";
import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";
import { quietFor, until } from "../wait";

import type { ElementHandle } from "playwright";

const PORT = 3736;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("inspector_focus_probe");
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
  const inspector = page.locator("aside[aria-label='Inspector']");

  // The records, chosen from the data: the About page's hero and its statistics,
  // and the first published service of the first category, with that category.
  const [hero] = await sql<{ id: number }[]>`
    select ps.id from page_sections ps join pages p on p.id = ps.page_id
     where p.slug = 'about' and ps.block_type = 'page-hero' order by ps.position limit 1`;
  // A list whose rows carry ids, for the row a save removes: the Home page's "why us" points.
  const [why] = await sql<{ id: number; first: string | null }[]>`
    select ps.id, ps.published -> 'points' -> 0 ->> '_id' as first from page_sections ps join pages p on p.id = ps.page_id
     where p.slug = 'home' and ps.block_type = 'why-us' order by ps.position limit 1`;
  const [richText] = await sql<{ id: number }[]>`
    select ps.id from page_sections ps join pages p on p.id = ps.page_id
     where p.slug = 'about' and ps.block_type = 'rich-text' order by ps.position limit 1`;
  const [service] = await sql<{ id: number; category_id: number }[]>`
    select s.id, s.category_id from services s join service_categories c on c.id = s.category_id
     where s.is_published and c.is_published order by c.sort_order, c.id, s.sort_order, s.id limit 1`;
  // Batch 24: a package filed under a published destination, and that destination.
  const [pkg] = await sql<{ id: number; destination_id: number }[]>`
    select p.id, p.destination_id from travel_packages p join package_destinations d on d.id = p.destination_id
     where p.is_published and d.is_published and length(p.summary_en) > 10 order by d.sort_order, p.sort_order, p.id limit 1`;
  if (!hero || !why?.first || !richText || !service || !pkg) throw new Error("the fixture lacks a section, a service or a package this probe needs");
  const categoryId = service.category_id;
  const destinationId = pkg.destination_id;

  // What is live before anything is typed: nothing here may publish.
  const liveBefore = JSON.stringify(
    await sql`
      select (select json_agg(published order by id) from page_sections where id in (${hero.id}, ${why.id}, ${richText.id})) as sections,
             (select row_to_json(s) from (select title_en, title_ar, intro_en, intro_ar, timeline_en, benefits from services where id = ${service.id}) s) as service,
             (select row_to_json(c) from (select title_en, title_ar, summary_en from service_categories where id = ${categoryId}) c) as category,
             (select row_to_json(p) from (select title_en, summary_en from travel_packages where id = ${pkg.id}) p) as package,
             (select row_to_json(d) from (select title_en, summary_ar from package_destinations where id = ${destinationId}) d) as destination`,
  );

  /* ------------------------------------------------------------------ */
  /* What a case types into, and where its text is stored                */
  /* ------------------------------------------------------------------ */
  type Device = "desktop" | "tablet" | "mobile";
  type Target = {
    label: string;
    /** `page=about` or `route=category:3`. */
    open: string;
    lang: "en" | "ar";
    device: Device;
    /** The region selected from Layers. */
    layer: string;
    /**
     * A node to click on the canvas instead, for a region Layers nests out of
     * sight — a package's card sits under its destination on Tour packages.
     */
    canvasNode?: string;
    /** The Inspector control: `[data-field="title"] input`, a list row's box. */
    control: string;
    /** Every save moves it. */
    saves: () => Promise<number>;
    /** The text this box saves to, as the database holds it. */
    stored: () => Promise<string | null>;
  };

  const sectionRevision = (id: number) => async () =>
    (await sql<{ r: number }[]>`select revision as r from page_sections where id = ${id}`)[0]!.r;
  const sectionDraft = (id: number, field: string, lang: string) => async () =>
    (await sql<{ v: string | null }[]>`select draft -> ${field} ->> ${lang} as v from page_sections where id = ${id}`)[0]?.v ?? null;
  const nodeRevision = (ownerKey: string) => async () =>
    (await sql<{ r: number }[]>`select revision as r from route_nodes where owner_key = ${ownerKey}`)[0]?.r ?? 0;
  const nodeDraft = (ownerKey: string, key: string) => async () =>
    (await sql<{ v: string | null }[]>`select draft_content -> ${key} ->> 'value' as v from route_nodes where owner_key = ${ownerKey}`)[0]?.v ?? null;
  const firstBenefit = (ownerKey: string) => async () =>
    (await sql<{ v: string | null }[]>`select draft_content -> 'benefits' -> 'value' -> 0 ->> 'en' as v from route_nodes where owner_key = ${ownerKey}`)[0]?.v ?? null;

  const DEVICE_WIDTH: Record<Device, number> = { desktop: 1440, tablet: 834, mobile: 390 };
  const open = async (target: Pick<Target, "open" | "lang" | "device">) => {
    await page.goto(`${server!.origin}/admin/visual-editor?${target.open}&lang=${target.lang}&device=${target.device}`, { waitUntil: "load" });
    const settled = await editorSettled(page, 60_000);
    const sized = await until(async () => (await page.getByText(`Canvas reports ${DEVICE_WIDTH[target.device]}px`).count()) > 0, 20_000);
    return settled && sized;
  };
  const choose = async (target: Target) => {
    if (target.canvasNode) {
      const picked = await selectCanvasNode(page, target.canvasNode);
      if (!picked.ok) throw new Error(`selecting ${target.canvasNode} on the canvas ended on ${picked.shows}`);
    } else await selectFromLayers(page, target.layer);
    await page.getByRole("tab", { name: /Content/ }).click();
    const box = inspector.locator(target.control).first();
    await box.waitFor({ timeout: 15_000 });
    return box;
  };

  /** What the focused element is: the same one, and where its caret is. */
  const state = (handle: ElementHandle<HTMLInputElement | HTMLTextAreaElement>) =>
    handle.evaluate((element) => ({
      connected: element.isConnected,
      focused: document.activeElement === element,
      start: element.selectionStart,
      end: element.selectionEnd,
      value: element.value,
    }));

  /** Until a save has landed after `before` and the canvas has been drawn again after it. */
  const savedAndRedrawn = async (saves: () => Promise<number>, before: number, url: string) => {
    const saved = await until(async () => (await saves()) > before, 20_000);
    const redrawn = await canvasRedrawn(page, url, 30_000);
    return saved && redrawn;
  };

  /**
   * Types `first`, waits out a real autosave and the redraw it causes, then
   * types `second` without touching the mouse — at the end of the text, or at
   * `caret` when given — and reports what happened to the focus, the caret and
   * the text.
   */
  async function acrossOneSave(target: Target, first: string, second: string, caret?: number) {
    const ready = await open(target);
    const box = await choose(target);
    const original = await box.inputValue();
    const at = caret ?? original.length;
    await box.click();
    const handle = (await box.elementHandle()) as ElementHandle<HTMLInputElement | HTMLTextAreaElement>;
    await handle.evaluate((element, position) => element.setSelectionRange(position, position), at);
    const before = await target.saves();
    const url = canvasUrl(page);
    await page.keyboard.type(first);
    const cycled = await savedAndRedrawn(target.saves, before, url);
    await page.keyboard.type(second);
    const after = await state(handle);
    const expected = `${original.slice(0, at)}${first}${second}${original.slice(at)}`;
    const caretAt = at + first.length + second.length;
    const stored = await until(async () => (await target.stored()) === expected, 20_000);
    await editorIdle(page);
    say(`${target.label}: the focus stays in the same box across an autosave`, ready && cycled && after.connected && after.focused, JSON.stringify({ cycled, ...after, value: undefined }));
    say(`${target.label}: the caret stays where the typing left it`, after.start === caretAt && after.end === caretAt, `${after.start}-${after.end}, expected ${caretAt}`);
    say(`${target.label}: the text is exact on screen and as saved — nothing lost, nothing doubled`, after.value === expected && stored, JSON.stringify({ shown: after.value.slice(-24), saved: (await target.stored())?.slice(-24) }));
  }

  /* ================================================================== */
  /* Typing across one autosave, in each editor, language and device     */
  /* ================================================================== */
  await acrossOneSave(
    {
      label: "CMS page · title · English · Desktop",
      open: "page=about",
      lang: "en",
      device: "desktop",
      layer: `section:${hero.id}`,
      control: '[data-field="title"] input',
      saves: sectionRevision(hero.id),
      stored: sectionDraft(hero.id, "title", "en"),
    },
    " alpha",
    " beta",
  );
  await acrossOneSave(
    {
      label: "CMS page · lead textarea · Arabic · Mobile",
      open: "page=about",
      lang: "ar",
      device: "mobile",
      layer: `section:${hero.id}`,
      control: '[data-field="lead"] textarea',
      saves: sectionRevision(hero.id),
      stored: sectionDraft(hero.id, "lead", "ar"),
    },
    "مرحبا",
    " بكم",
    0,
  );
  await acrossOneSave(
    {
      label: "Category page · title · Arabic · Desktop",
      open: `route=category:${categoryId}`,
      lang: "ar",
      device: "desktop",
      layer: `category:${categoryId}`,
      control: '[data-field="title"] input',
      saves: nodeRevision(`category:${categoryId}`),
      stored: nodeDraft(`category:${categoryId}`, "titleAr"),
    },
    " أ",
    "ب",
  );
  await acrossOneSave(
    {
      label: "Category page · summary textarea, caret in the middle · English · Tablet",
      open: `route=category:${categoryId}`,
      lang: "en",
      device: "tablet",
      layer: `category:${categoryId}`,
      control: '[data-field="summary"] textarea',
      saves: nodeRevision(`category:${categoryId}`),
      stored: nodeDraft(`category:${categoryId}`, "summaryEn"),
    },
    "[one]",
    "[two]",
    5,
  );
  await acrossOneSave(
    {
      label: "Service page · title · English · Desktop",
      open: `route=service:${service.id}`,
      lang: "en",
      device: "desktop",
      layer: `serviceHero:${service.id}`,
      control: '[data-field="title"] input',
      saves: nodeRevision(`serviceHero:${service.id}`),
      stored: nodeDraft(`serviceHero:${service.id}`, "titleEn"),
    },
    " Gamma",
    " Delta",
  );
  await acrossOneSave(
    {
      label: "Service page · introduction textarea · Arabic · Tablet",
      open: `route=service:${service.id}`,
      lang: "ar",
      device: "tablet",
      layer: `serviceHero:${service.id}`,
      control: '[data-field="intro"] textarea',
      saves: nodeRevision(`serviceHero:${service.id}`),
      stored: nodeDraft(`serviceHero:${service.id}`, "introAr"),
    },
    "نص",
    " عربي",
  );

  // Batch 24: the package routes, their catalogue and the services overview share the Inspector.
  await acrossOneSave(
    {
      label: "Package page · title · English · Desktop",
      open: `route=package:${pkg.id}`,
      lang: "en",
      device: "desktop",
      layer: `packageHero:${pkg.id}`,
      control: '[data-field="title"] input',
      saves: nodeRevision(`packageHero:${pkg.id}`),
      stored: nodeDraft(`packageHero:${pkg.id}`, "titleEn"),
    },
    " Epsilon",
    " Zeta",
  );
  await acrossOneSave(
    {
      label: "Tour packages · a card's summary textarea, caret in the middle · English · Tablet",
      open: "route=packageIndex:1",
      lang: "en",
      device: "tablet",
      layer: `packageCard:${pkg.id}`,
      canvasNode: `packageCard:${pkg.id}/field:title`,
      control: '[data-field="summary"] textarea',
      saves: nodeRevision(`packageCard:${pkg.id}`),
      stored: nodeDraft(`packageCard:${pkg.id}`, "summaryEn"),
    },
    "[one]",
    "[two]",
    5,
  );
  await acrossOneSave(
    {
      label: "Destination page · summary textarea · Arabic · Mobile",
      open: `route=destination:${destinationId}`,
      lang: "ar",
      device: "mobile",
      layer: `destinationHero:${destinationId}`,
      control: '[data-field="summary"] textarea',
      saves: nodeRevision(`destinationHero:${destinationId}`),
      stored: nodeDraft(`destinationHero:${destinationId}`, "summaryAr"),
    },
    "مرحبا",
    " بكم",
    0,
  );
  await acrossOneSave(
    {
      label: "Services overview · heading · English · Desktop",
      open: "route=serviceIndex:1",
      lang: "en",
      device: "desktop",
      layer: "serviceIndexHero:1",
      control: '[data-field="heading"] input',
      saves: nodeRevision("serviceIndexHero:1"),
      stored: nodeDraft("serviceIndexHero:1", "copy:headingEn"),
    },
    "Our",
    " services",
  );

  // A list row: the box exists once the row has been added and saved.
  {
    const target: Target = {
      label: "Service page · a list row · English · Mobile",
      open: `route=service:${service.id}`,
      lang: "en",
      device: "mobile",
      layer: `serviceBenefits:${service.id}`,
      control: '[data-field="benefits"] li input',
      saves: nodeRevision(`serviceBenefits:${service.id}`),
      stored: firstBenefit(`serviceBenefits:${service.id}`),
    };
    await open(target);
    await selectFromLayers(page, target.layer);
    await page.getByRole("tab", { name: /Content/ }).click();
    const rows = inspector.locator('[data-field="benefits"] li');
    if ((await rows.count()) === 0) {
      const before = await target.saves();
      await inspector.locator('[data-field="benefits"]').getByRole("button", { name: /^Add benefit/ }).click();
      await until(async () => (await target.saves()) > before, 20_000);
      await editorIdle(page);
    }
    await acrossOneSave(target, "Fast", " and exact");
  }

  /* ================================================================== */
  /* Several saves in a row, and a save the server is slow to answer      */
  /* ================================================================== */
  {
    const target: Target = {
      label: "Service page · timeline, typed across several autosaves",
      open: `route=service:${service.id}`,
      lang: "en",
      device: "desktop",
      layer: `serviceHero:${service.id}`,
      control: '[data-field="timeline"] input',
      saves: nodeRevision(`serviceHero:${service.id}`),
      stored: nodeDraft(`serviceHero:${service.id}`, "timelineEn"),
    };
    await open(target);
    const box = await choose(target);
    const original = await box.inputValue();
    await box.click();
    await page.keyboard.press("End");
    const handle = (await box.elementHandle()) as ElementHandle<HTMLInputElement>;
    const start = await target.saves();
    const pieces = ["one", " two", " three", " four"];
    let cycles = 0;
    for (const piece of pieces) {
      const before = await target.saves();
      const url = canvasUrl(page);
      await page.keyboard.type(piece);
      if (await savedAndRedrawn(target.saves, before, url)) cycles += 1;
    }
    const after = await state(handle);
    const expected = original + pieces.join("");
    const stored = await until(async () => (await target.stored()) === expected, 20_000);
    say(`${target.label}: every save drawn again and the focus never left the box`, cycles === pieces.length && after.focused && after.connected, `${cycles} saves; ${(await target.saves()) - start} revisions`);
    say(`${target.label}: the text is exact after ${pieces.length} saves — nothing lost, nothing doubled`, after.value === expected && stored && after.start === expected.length);
    await editorIdle(page);
  }

  {
    const target: Target = {
      label: "Category page · title, typed while the server is slow to answer a save",
      open: `route=category:${categoryId}`,
      lang: "en",
      device: "desktop",
      layer: `category:${categoryId}`,
      control: '[data-field="title"] input',
      saves: nodeRevision(`category:${categoryId}`),
      stored: nodeDraft(`category:${categoryId}`, "titleEn"),
    };
    await open(target);
    const box = await choose(target);
    const original = await box.inputValue();
    await box.click();
    await page.keyboard.press("End");
    const handle = (await box.elementHandle()) as ElementHandle<HTMLInputElement>;
    // Every Server Action held back for 2.5 s: the save is on its way while typing goes on.
    let held = 0;
    await page.route("**/admin/visual-editor**", async (route) => {
      const request = route.request();
      if (request.method() === "POST" && request.headers()["next-action"]) {
        held += 1;
        await new Promise((resolve) => setTimeout(resolve, 2_500));
      }
      await route.continue();
    });
    const before = await target.saves();
    await page.keyboard.type(" slow");
    const inFlight = await until(async () => held > 0, 10_000);
    await page.keyboard.type(" and steady");
    const during = await state(handle);
    await until(async () => (await target.saves()) > before, 30_000);
    const expected = `${original} slow and steady`;
    const stored = await until(async () => (await target.stored()) === expected, 40_000);
    // Waits for a held request to be let through rather than pulling the route from under it.
    await page.unrouteAll({ behavior: "wait" });
    await editorIdle(page, 40_000);
    const after = await state(handle);
    say(`${target.label}: keystrokes during the save land in the same box`, inFlight && during.focused && during.value === expected, JSON.stringify({ inFlight, focused: during.focused }));
    say(`${target.label}: …and after it the focus, the caret and the saved text are all exact`, after.focused && after.connected && after.start === expected.length && after.value === expected && stored);
  }

  /* ================================================================== */
  /* A direct edit on the canvas outlasts its own autosave                */
  /* ================================================================== */
  {
    await open({ open: `route=service:${service.id}`, lang: "en", device: "desktop" });
    const address = `serviceHero:${service.id}/field:title`;
    await selectCanvasNode(page, address);
    const frame = page.frames().find((candidate) => candidate.url().includes("editor=1"))!;
    const title = frame.locator(`[data-eod-address="${address}"]`);
    const original = ((await title.textContent()) ?? "").trim();
    await title.dblclick();
    const editing = await until(async () => (await title.getAttribute("contenteditable")) !== null, 10_000);
    await page.keyboard.press("End");
    const revision = nodeRevision(`serviceHero:${service.id}`);
    const before = await revision();
    const url = canvasUrl(page);
    await page.keyboard.type(" Typed");
    // Long enough for the autosave to have fired and been answered.
    const saved = await until(async () => (await revision()) > before, 20_000);
    await quietFor(page, 1_500, "a redraw caused by that save would have replaced the canvas by now");
    // Asked of the frame the edit began in: one replaced by a redraw has gone, and says so by throwing.
    const kept = canvasUrl(page) === url && (await title.getAttribute("contenteditable").catch(() => null)) !== null;
    await page.keyboard.type(" on");
    await page.keyboard.press("Enter");
    const expected = `${original} Typed on`;
    const stored = await until(async () => (await nodeDraft(`serviceHero:${service.id}`, "titleEn")()) === expected, 20_000);
    say("Direct edit on the canvas: its own autosave neither redraws the canvas nor ends the edit", editing && saved && kept, JSON.stringify({ editing, saved, kept }));
    say("Direct edit on the canvas: every keystroke lands, and the committed text is exact", stored, String(await nodeDraft(`serviceHero:${service.id}`, "titleEn")()));
    await editorIdle(page);
  }

  /* ================================================================== */
  /* Races: the person moves on while a save is still on its way          */
  /* ================================================================== */
  {
    // Typed in one section, then another chosen before the save is answered.
    await open({ open: "page=about", lang: "en", device: "desktop" });
    const target = {
      saves: sectionRevision(hero.id),
      stored: sectionDraft(hero.id, "eyebrow", "en"),
    };
    await selectFromLayers(page, `section:${hero.id}`);
    await page.getByRole("tab", { name: /Content/ }).click();
    const box = inspector.locator('[data-field="eyebrow"] input').first();
    await box.waitFor({ timeout: 15_000 });
    const original = await box.inputValue();
    await box.click();
    await page.keyboard.press("End");
    const before = await target.saves();
    const url = canvasUrl(page);
    await page.keyboard.type(" moved on");
    await page.locator(`aside[aria-label='Page structure'] [data-layer-row="section:${richText.id}"]`).click();
    const cycled = await savedAndRedrawn(target.saves, before, url);
    await editorSettled(page, 30_000);
    const shows = await waitForInspector(page, `section:${richText.id}`, 10_000);
    const stillThere = shows === `section:${richText.id}`;
    const notPulledBack = await page.evaluate(
      () => !(document.activeElement instanceof HTMLInputElement && document.activeElement.closest("[data-field='eyebrow']")),
    );
    const saved = (await target.stored()) === `${original} moved on`;
    say("Race · another section chosen while a save was on its way: the selection stays on the one chosen", cycled && stillThere, shows);
    say("Race · …the focus is not pulled back into the first section's box, and its text was saved", notPulledBack && saved);
  }

  {
    // Typed in one box, then another box of the same section clicked before the save.
    await open({ open: "page=about", lang: "en", device: "desktop" });
    const saves = sectionRevision(hero.id);
    await selectFromLayers(page, `section:${hero.id}`);
    await page.getByRole("tab", { name: /Content/ }).click();
    const title = inspector.locator('[data-field="title"] input').first();
    const lead = inspector.locator('[data-field="lead"] textarea').first();
    await title.waitFor({ timeout: 15_000 });
    const titleBefore = await title.inputValue();
    const leadBefore = await lead.inputValue();
    await title.click();
    await page.keyboard.press("End");
    const before = await saves();
    const url = canvasUrl(page);
    await page.keyboard.type(" first");
    await lead.click();
    await page.keyboard.press("Control+End");
    const leadHandle = (await lead.elementHandle()) as ElementHandle<HTMLTextAreaElement>;
    const cycled = await savedAndRedrawn(saves, before, url);
    await page.keyboard.type(" second");
    const after = await state(leadHandle);
    const stored = await until(
      async () =>
        (await sectionDraft(hero.id, "title", "en")()) === `${titleBefore} first` &&
        (await sectionDraft(hero.id, "lead", "en")()) === `${leadBefore} second`,
      20_000,
    );
    say("Race · focus moved to another box before the save: it stays there, not pulled back", cycled && after.connected && after.focused, JSON.stringify({ cycled, focused: after.focused }));
    say("Race · …and both boxes saved exactly what was typed in them", stored && after.value === `${leadBefore} second`);
    await editorIdle(page);
  }

  {
    // The selected element removed by the save itself: a "why us" point.
    await open({ open: "page=home", lang: "en", device: "desktop" });
    const rowId = why.first;
    const address = `section:${why.id}/field:points/item:${rowId}`;
    const picked = await selectCanvasNode(page, address);
    await page.getByRole("tab", { name: /Content/ }).click();
    const item = inspector.locator(`[data-field="points"] li[data-item-id="${rowId}"]`);
    await item.waitFor({ timeout: 15_000 });
    const saves = sectionRevision(why.id);
    const before = await saves();
    const url = canvasUrl(page);
    await item.locator('button[aria-label="Remove"]').click();
    const cycled = await savedAndRedrawn(saves, before, url);
    const fellBack = (await waitForInspector(page, `section:${why.id}`, 15_000)) === `section:${why.id}`;
    const gone = !JSON.stringify((await sql`select draft from page_sections where id = ${why.id}`)[0]?.draft ?? {}).includes(rowId);
    say("Removed · a selected row its own save removed: the selection falls back to its section", picked.ok && cycled && fellBack, await inspectorAddress(page));
    say("Removed · …the row is gone from the draft, and nothing still points at it", gone && (await inspector.locator(`li[data-item-id="${rowId}"]`).count()) === 0);
    await editorIdle(page);
  }

  /* ================================================================== */
  /* Layers: a control pressed from the keyboard keeps the focus (24)     */
  /* ================================================================== */
  // The tree has no rows from the redraw until the new document reports in, so
  // the focus used to fall to the page with them. It comes back to the same
  // control of the same row — or to the row, where the control is disabled.
  const focusedControl = () =>
    page.evaluate(() => {
      const element = document.activeElement as HTMLElement | null;
      return {
        tag: element?.tagName ?? "",
        op: element?.getAttribute("data-layer-op") ?? "",
        strip: element?.closest("[data-layer-ops]")?.getAttribute("data-layer-ops") ?? "",
        row: element?.getAttribute("data-layer-row") ?? "",
        label: element?.getAttribute("aria-label") ?? "",
      };
    });
  const layersControl = (address: string, op: string) =>
    page.locator(`aside[aria-label='Page structure'] [data-layer-ops="${address}"] [data-layer-op="${op}"]`);

  {
    // A card on Tour packages: hidden, then shown again — the second time from the focus the first redraw gave back.
    await open({ open: "route=packageIndex:1", lang: "en", device: "desktop" });
    const card = `packageCard:${pkg.id}`;
    // Layers nests a card under its destination: selecting it on the canvas opens the tree to it.
    const picked = await selectCanvasNode(page, `${card}/field:title`);
    const toggle = layersControl(card, "visibility");
    await toggle.waitFor({ timeout: 15_000 });
    const saves = nodeRevision(card);
    const steps: { cycled: boolean; back: boolean; label: string }[] = [];
    for (const first of [true, false]) {
      const before = await saves();
      const url = canvasUrl(page);
      if (first) await toggle.focus();
      await page.keyboard.press("Enter");
      const cycled = await savedAndRedrawn(saves, before, url);
      const back = await until(async () => {
        const now = await focusedControl();
        return now.strip === card && now.op === "visibility";
      }, 15_000);
      steps.push({ cycled, back, label: (await focusedControl()).label });
    }
    const [hidden, shown] = steps as [(typeof steps)[0], (typeof steps)[0]];
    say(
      "Layers · a card hidden from the keyboard on Tour packages: after the redraw the focus is back on its button, which now says Show",
      picked.ok && hidden.cycled && hidden.back && /^Show .+ when published$/.test(hidden.label),
      JSON.stringify(hidden),
    );
    say(
      "Layers · …and Enter on the focus it was given shows the card again, and the focus stays through that redraw too",
      shown.cycled && shown.back && /^Hide .+ when published$/.test(shown.label),
      JSON.stringify(shown),
    );
    await editorIdle(page);
  }

  {
    // A page's layout: the first section moved down, then back up to the top.
    await open({ open: "page=about", lang: "en", device: "desktop" });
    const [top] = await sql<{ id: number }[]>`
      select ps.id from page_sections ps join pages p on p.id = ps.page_id where p.slug = 'about' order by ps.position limit 1`;
    const section = `section:${top!.id}`;
    const layoutRevision = async () => (await sql<{ r: number }[]>`select revision as r from pages where slug = 'about'`)[0]!.r;
    const move = async (op: "down" | "up", focusFirst: boolean) => {
      const before = await layoutRevision();
      const url = canvasUrl(page);
      if (focusFirst) await layersControl(section, op).focus();
      await page.keyboard.press("Enter");
      return savedAndRedrawn(layoutRevision, before, url);
    };
    await layersControl(section, "down").waitFor({ timeout: 15_000 });
    const downCycled = await move("down", true);
    const downBack = await until(async () => {
      const now = await focusedControl();
      return now.strip === section && now.op === "down";
    }, 15_000);
    const afterDown = await focusedControl();
    // From there the keyboard alone: Shift+Tab reaches Move up, and the section goes back to the top —
    // where Move up is disabled, so the focus lands on the section's own row.
    await page.keyboard.press("Shift+Tab");
    const onUp = (await focusedControl()).op === "up";
    const upCycled = await move("up", false);
    const upBack = await until(async () => (await focusedControl()).row === section, 15_000);
    say(
      "Layers · a section moved down from the keyboard: the layout's buttons are disabled while it saves, and the focus still comes back to its Move down",
      downCycled && downBack,
      JSON.stringify({ downCycled, afterDown }),
    );
    say(
      "Layers · …moved back to the top from the keyboard, where Move up is disabled: the focus lands on the section's own row",
      onUp && upCycled && upBack,
      JSON.stringify({ onUp, upCycled, now: await focusedControl() }),
    );
    await editorIdle(page);
  }

  /* ================================================================== */
  /* Nothing was published                                               */
  /* ================================================================== */
  const liveAfter = JSON.stringify(
    await sql`
      select (select json_agg(published order by id) from page_sections where id in (${hero.id}, ${why.id}, ${richText.id})) as sections,
             (select row_to_json(s) from (select title_en, title_ar, intro_en, intro_ar, timeline_en, benefits from services where id = ${service.id}) s) as service,
             (select row_to_json(c) from (select title_en, title_ar, summary_en from service_categories where id = ${categoryId}) c) as category,
             (select row_to_json(p) from (select title_en, summary_en from travel_packages where id = ${pkg.id}) p) as package,
             (select row_to_json(d) from (select title_en, summary_ar from package_destinations where id = ${destinationId}) d) as destination`,
  );
  const [{ versions }] = await sql<{ versions: number }[]>`select count(*)::int as versions from route_versions`;
  say("no autosave published anything: the live page sections, category, service, package and destination are unchanged", liveAfter === liveBefore && versions === 0);
  say("no page errors in the editor or the canvas", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  await server?.stop();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
