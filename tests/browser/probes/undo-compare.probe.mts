/**
 * Batch 16 acceptance: Undo / Redo and Version Compare in a real browser —
 * the scenarios of §58, driven through the real Visual Editor and the real
 * comparison screen, with every outcome read back from the database or from
 * the rendered page.
 *
 *   U1–U30   Undo / Redo           C0–C24   Version Compare
 */
import path from "node:path";

import type { Frame } from "playwright";

import { selectCanvasNode } from "../canvas";
import { callAction } from "../../helpers/action";
import { REPO_ROOT } from "../../helpers/env";
import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";
import { AUTOSAVE_QUIET_MS, quietFor } from "../wait";

const PORT = 3730;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
const RESET_SECTION = "Undo history was reset because this section changed elsewhere.";

const browser = await launchChromium();
const database = giveFresh("undo_compare_probe");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    select 'viewer@probe.invalid', 'Read Only', 'unused', id, true from roles where key = 'viewer'`;
  const viewer = await signIn(sql, "viewer");
  server = await startServer(database, PORT);
  const origin = server.origin;

  const [about] = await sql<{ id: number }[]>`select id from pages where slug = 'about'`;
  const [home] = await sql<{ id: number }[]>`select id from pages where slug = 'home'`;
  const ABOUT = about!.id;
  const rows = await sql<{ id: number; block_type: string; published: Record<string, unknown> }[]>`
    select id, block_type, published from page_sections where page_id = ${ABOUT} order by position`;
  const byType = Object.fromEntries(rows.map((r) => [r.block_type, r])) as Record<string, (typeof rows)[number]>;
  const TEXT = byType["rich-text"]!.id;
  const IMAGE = byType["image-text"]!.id;
  const originalOrder = rows.map((r) => r.id);
  const titleOf = (id: number) => (byType[rows.find((r) => r.id === id)!.block_type]!.published.title as { en: string; ar: string });
  const TEXT_TITLE = titleOf(TEXT);
  const IMAGE_TITLE = titleOf(IMAGE);

  type Row = {
    revision: number;
    draft: Record<string, unknown> | null;
    draft_styles: { nodes?: Record<string, Record<string, Record<string, unknown>>> } | null;
    draft_motion_config: { section?: Record<string, Record<string, unknown>> } | null;
  };
  const state = async (id: number) =>
    (await sql<Row[]>`select revision, draft, draft_styles, draft_motion_config from page_sections where id = ${id}`)[0]!;
  const draftText = async (id: number, field: string, locale: "en" | "ar") =>
    String((((await state(id)).draft?.[field] as Record<string, string>) ?? {})[locale] ?? "");
  const draftOrder = async () => {
    const [row] = await sql<{ draft_structure: { sections: { sectionId: number; visible: boolean }[] } | null }[]>`
      select draft_structure from pages where id = ${ABOUT}`;
    return row!.draft_structure?.sections ?? null;
  };
  const until = async (what: () => Promise<boolean>, ms = 30_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await what()) return true;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };
  const fingerprint = async () =>
    JSON.stringify(
      await sql`
        select
          (select coalesce(json_agg(p order by p.id)::text, '') from pages p) as pages,
          (select coalesce(json_agg(s order by s.id)::text, '') from page_sections s) as sections,
          (select coalesce(json_agg(v order by v.id)::text, '') from page_versions v) as versions,
          (select count(*)::text from activity_logs) as activity`,
    );

  const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
  await context.addInitScript({ content: "window.__name = window.__name || ((fn) => fn);" });
  const page = await context.newPage();
  const editorErrors: string[] = [];
  page.on("pageerror", (error) => editorErrors.push(error.message.slice(0, 160)));
  page.on("dialog", (dialog) => void dialog.accept());

  const open = async (query = "?page=about&lang=en&device=desktop") => {
    await page.goto(`${origin}/admin/visual-editor${query}`, { waitUntil: "load" });
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  };
  const frameNow = async (): Promise<Frame> => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const found = page.frames().find((f) => f.url().includes("editor=1"));
      if (found) return found;
      if (Date.now() > deadline) throw new Error("the canvas frame never arrived");
      await page.waitForTimeout(150);
    }
  };
  const ready = async () => {
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
    await page.waitForTimeout(400);
  };
  /**
   * One click where the canvas is still, then a bounded wait for the
   * Inspector's answer — no retries, and no stepping out before the Inspector
   * has said where it is (Batch 19A — see `tests/browser/canvas.ts`).
   */
  const select = async (address: string) => {
    const result = await selectCanvasNode(page, address);
    if (result.ok) return true;
    const shot = path.join(REPO_ROOT, ".data", "test", "results", "screenshots", `undo-compare-select-${Date.now()}.png`);
    await page.screenshot({ path: shot }).catch(() => undefined);
    console.log(
      `   [select failed] ${address} → inspector shows "${result.shows}", the click landed on ${JSON.stringify(result.landing)}, frame ${(await frameNow()).url()}, shot ${shot}`,
    );
    return false;
  };
  const undoButton = () => page.locator('[data-history="undo"]');
  const redoButton = () => page.locator('[data-history="redo"]');
  const undoLabel = async () => (await undoButton().getAttribute("aria-label")) ?? "";
  const redoLabel = async () => (await redoButton().getAttribute("aria-label")) ?? "";
  const notice = async () => ((await page.locator("[data-history-notice]").count()) ? (await page.locator("[data-history-notice]").innerText()).trim() : "");
  /** Focus away from every text field, so a shortcut is the editor's. */
  const blur = async () => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.locator("header").first().click({ position: { x: 3, y: 3 } });
  };
  const contentTab = async () => {
    await page.getByRole("tab", { name: /Content/ }).click();
    await page.waitForTimeout(200);
  };
  const layers = () => page.locator("aside[aria-label='Page structure']");
  const layerIds = () =>
    layers()
      .locator("ol > li[data-section-id]")
      .evaluateAll((items) => items.map((item) => Number((item as HTMLElement).dataset.sectionId)));
  const rowButton = (id: number, label: RegExp) => layers().locator(`li[data-section-id="${id}"]`).getByRole("button", { name: label });
  const pageRevision = async () => (await sql<{ revision: number }[]>`select revision from pages where id = ${ABOUT}`)[0]!.revision;
  const settleLayout = async (revision: number) => {
    await until(async () => (await pageRevision()) !== revision, 20_000);
    await ready();
  };
  /**
   * A layout step that changes the order is over when Layers shows it, not
   * when the database has it: the revision moves at the server's commit, a
   * moment before the browser has the answer and has redrawn the list, and
   * reading it in between reads the previous one (seen once in Batch 18's
   * ×10, at U22). So wait — bounded — for the list to move as well. The
   * assertions after it are unchanged, and a list that never moves still
   * fails them.
   */
  const settleLayers = async (revision: number, before: number[]) => {
    await settleLayout(revision);
    // And not empty (Batch 19A): the redraw that follows the answer clears the
    // list until the new canvas reports its structure, and an empty list
    // "differs" from every order — read in that moment, U22b saw [].
    await until(async () => {
      const now = await layerIds();
      return now.length > 0 && JSON.stringify(now) !== JSON.stringify(before);
    }, 20_000);
  };
  /**
   * A page action is over when the panel stops saying "Working…". The notice
   * appears as soon as the server has answered, before the editor has re-read
   * the page and reloaded the canvas — clicking into the canvas in between
   * lands in the document that is about to go.
   */
  const pageActionDone = async () => {
    await until(async () => (await page.getByRole("button", { name: "Working…" }).count()) === 0, 30_000);
    await ready();
  };
  const device = async (label: "Desktop" | "Tablet" | "Mobile") => {
    await page.getByRole("group", { name: "Canvas width" }).getByRole("button", { name: new RegExp(`^${label}`) }).click();
    await page.waitForTimeout(700);
  };
  const language = async (label: "English" | "العربية") => {
    await page.getByRole("button", { name: label, exact: true }).click();
    await ready();
  };

  /* ====================================================================== */
  /* Undo / Redo                                                            */
  /* ====================================================================== */

  await open();
  say("U1. before anything is done, Undo and Redo are disabled and say so",
    (await undoButton().isDisabled()) && (await redoButton().isDisabled()) &&
      (await undoLabel()) === "Undo — nothing to undo" && (await redoLabel()) === "Redo — nothing to redo",
    `${await undoLabel()} / ${await redoLabel()}`);
  say("U1a. the buttons carry their shortcuts and the session note",
    (await undoButton().getAttribute("aria-keyshortcuts")) === "Control+Z Meta+Z" &&
      /Ctrl\+Z/.test((await undoButton().getAttribute("title")) ?? "") &&
      /current editing session/.test((await page.locator("#ve-undo-scope").textContent()) ?? ""));

  // Content, in the inspector.
  await select(`section:${TEXT}/field:title`);
  await contentTab();
  const titleBox = page.locator("#field-title-en");
  await titleBox.waitFor({ timeout: 15_000 });
  await titleBox.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" plus");
  const typed = `${TEXT_TITLE.en} plus`;
  say("U2. typing is one action, named for the field and the edition",
    (await undoLabel()) === "Undo: Change Title (English)" && (await undoButton().isEnabled()), await undoLabel());
  say("U3. the edit is autosaved through the ordinary queue",
    await until(async () => (await draftText(TEXT, "title", "en")) === typed), await draftText(TEXT, "title", "en"));

  await blur();
  const revisionBeforeUndo = (await state(TEXT)).revision;
  await undoButton().click();
  say("U4. Undo from the toolbar puts the field back", (await titleBox.inputValue()) === TEXT_TITLE.en, await titleBox.inputValue());
  say("U5. …and the autosave carries the undo to the server, a revision later",
    await until(async () => (await draftText(TEXT, "title", "en")) === TEXT_TITLE.en) &&
      (await state(TEXT)).revision === revisionBeforeUndo + 1,
    `${await draftText(TEXT, "title", "en")} r${(await state(TEXT)).revision}`);
  say("U6. Redo names what it would bring back", (await redoLabel()) === "Redo: Change Title (English)", await redoLabel());

  await blur();
  await page.keyboard.press("Control+Shift+Z");
  say("U7. Ctrl+Shift+Z redoes, and the redo is autosaved",
    (await titleBox.inputValue()) === typed && (await until(async () => (await draftText(TEXT, "title", "en")) === typed)),
    await titleBox.inputValue());
  await blur();
  await page.keyboard.press("Control+Z");
  say("U8. Ctrl+Z undoes again", await until(async () => (await draftText(TEXT, "title", "en")) === TEXT_TITLE.en));

  // Save now at an undone state keeps Redo.
  await blur();
  await page.keyboard.press("Control+Shift+Z");
  await until(async () => (await draftText(TEXT, "title", "en")) === typed);
  await ready();
  await blur();
  await undoButton().click();
  await page.getByRole("button", { name: "Save now" }).click({ timeout: 2500 }).catch(() => undefined);
  const savedNow = await until(async () => (await draftText(TEXT, "title", "en")) === TEXT_TITLE.en, 6000);
  say("U9. Save now at the undone state saves it, and Redo is still offered",
    savedNow && (await redoButton().isEnabled()) && (await redoLabel()) === "Redo: Change Title (English)", await redoLabel());

  // A divergent edit clears Redo.
  await ready();
  await select(`section:${TEXT}/field:eyebrow`);
  await contentTab();
  const eyebrowBox = page.locator("#field-eyebrow-en");
  await eyebrowBox.fill("Divergent eyebrow");
  say("U10. a new edit after Undo clears Redo", (await redoButton().isDisabled()) && (await redoLabel()) === "Redo — nothing to redo", await redoLabel());
  await until(async () => (await draftText(TEXT, "eyebrow", "en")) === "Divergent eyebrow");

  // Focused form fields keep their own Ctrl+Z.
  await ready();
  await select(`section:${TEXT}/field:title`);
  await contentTab();
  await page.locator("#field-title-en").click();
  await page.keyboard.type("xyz");
  await page.keyboard.press("Control+Z");
  await quietFor(page, AUTOSAVE_QUIET_MS, "an Undo taken by the editor instead of the field would have been saved by now");
  say("U11. Ctrl+Z inside a text field is the field's own — the editor's history did not step",
    (await draftText(TEXT, "eyebrow", "en")) === "Divergent eyebrow" && (await page.locator("#field-eyebrow-en").count() === 0 || (await page.locator("#field-eyebrow-en").inputValue()) === "Divergent eyebrow"),
    await draftText(TEXT, "eyebrow", "en"));
  // Put the title back for what follows.
  await page.locator("#field-title-en").fill(TEXT_TITLE.en);
  await until(async () => (await draftText(TEXT, "title", "en")) === TEXT_TITLE.en);
  await blur();

  // Direct editing on the canvas, undone with a key pressed on the canvas.
  await ready();
  const direct = `section:${IMAGE}/field:title`;
  // Selected first, as an editor would: the double-click then asks to edit
  // the node the inspector is already showing.
  await select(direct);
  await ready();
  const node = (await frameNow()).locator(`[data-eod-address="${direct}"]`).first();
  await node.scrollIntoViewIfNeeded();
  await node.dblclick({ timeout: 10_000 });
  const editable = await until(async () => (await node.getAttribute("contenteditable")) === "plaintext-only", 10_000);
  say("U12a. a double-click opens the node for typing on the canvas", editable);
  await node.selectText();
  await page.keyboard.type("Typed on the canvas");
  // While typing, Ctrl+Z belongs to the text, not to the editor.
  await page.keyboard.press("Control+Z");
  await page.waitForTimeout(400);
  say("U12. while a node is being typed into, Ctrl+Z is the text's own — the editor did not undo the eyebrow",
    (await draftText(TEXT, "eyebrow", "en")) === "Divergent eyebrow");
  await node.selectText();
  await page.keyboard.type("Typed on the canvas");
  await page.keyboard.press("Enter");
  // The commit reaches the editor by message, and the autosave follows it; the
  // label is read once the edit has landed on the server, so the Undo below
  // has a saved edit to take back rather than an unsaved one.
  const landed = await until(async () => (await draftText(IMAGE, "title", "en")) === "Typed on the canvas");
  say("U13. a committed direct edit is one action on the same history",
    landed && (await undoLabel()) === "Undo: Change Title (English)",
    `${await undoLabel()} / ${await draftText(IMAGE, "title", "en")}`);
  await ready();
  // Focus is in the canvas document: a key pressed there is forwarded.
  const canvasBody = (await frameNow()).locator("body");
  await canvasBody.evaluate((body) => (body as HTMLElement).focus());
  await (await frameNow()).locator("body").press("Control+Z");
  say("U14. Ctrl+Z pressed on the canvas undoes the direct edit, and it is autosaved",
    await until(async () => (await draftText(IMAGE, "title", "en")) === IMAGE_TITLE.en),
    await draftText(IMAGE, "title", "en"));
  await ready();
  await redoButton().click();
  say("U15. Redo brings the direct edit back",
    await until(async () => (await draftText(IMAGE, "title", "en")) === "Typed on the canvas"));
  await ready();
  const canvasText = ((await (await frameNow()).locator(`[data-eod-address="${direct}"]`).first().innerText()) ?? "").trim();
  say("U15a. …and the canvas shows it", canvasText === "Typed on the canvas", canvasText);

  // A direct edit undone before its autosave: nothing is saved, and the canvas
  // is redrawn from the server rather than left showing the typed text.
  await select(direct);
  await ready();
  const again = (await frameNow()).locator(`[data-eod-address="${direct}"]`).first();
  await again.scrollIntoViewIfNeeded();
  await again.dblclick({ timeout: 10_000 });
  await until(async () => (await again.getAttribute("contenteditable")) === "plaintext-only", 10_000);
  await again.selectText();
  await page.keyboard.type("Never saved");
  await page.keyboard.press("Enter");
  await (await frameNow()).locator("body").press("Control+Z");
  await quietFor(page, AUTOSAVE_QUIET_MS, "a direct edit that was going to be autosaved would have been by now");
  await ready();
  const redrawn = ((await (await frameNow()).locator(`[data-eod-address="${direct}"]`).first().innerText()) ?? "").trim();
  say("U15b. a direct edit undone before its autosave saves nothing, and the canvas shows the saved text",
    redrawn === "Typed on the canvas" && (await draftText(IMAGE, "title", "en")) === "Typed on the canvas",
    `${redrawn} / ${await draftText(IMAGE, "title", "en")}`);

  // Style at Mobile, and a slider drag as one action.
  await ready();
  await layers().locator(`[data-layer-row="section:${TEXT}"]`).click();
  await page.waitForTimeout(500);
  await page.getByRole("tab", { name: /Style/ }).click();
  await device("Mobile");
  const background = page.locator('[data-style-token="background"] select');
  await background.waitFor({ timeout: 10_000 });
  await background.selectOption("ink-800");
  say("U16. a Style change is named with its width", /Background · Mobile/.test(await undoLabel()), await undoLabel());
  await until(async () => (await state(TEXT)).draft_styles?.nodes?.root?.mobile?.background === "ink-800");
  // The save reloads the canvas and the selection comes back: wait for the
  // panel to be the section's again before reaching for its slider.
  await ready();
  if (!(await page.locator('[data-style-token="padBlock"]').count())) {
    await layers().locator(`[data-layer-row="section:${TEXT}"]`).click();
    await page.waitForTimeout(400);
    await page.getByRole("tab", { name: /Style/ }).click();
  }
  const range = page.locator('[data-style-token="padBlock"] input[type="range"]');
  await range.waitFor({ timeout: 15_000 }).catch(() => undefined);
  let sliderGrouped = false;
  if (await range.count()) {
    const box = (await range.boundingBox())!;
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.down();
    for (let step = 1; step <= 8; step += 1) {
      await page.mouse.move(box.x + (box.width * step) / 10, box.y + box.height / 2);
      await page.waitForTimeout(250);
    }
    await page.mouse.up();
    const dragged = (await range.inputValue());
    await blur();
    await undoButton().click();
    sliderGrouped = (await range.inputValue()) !== dragged && /Background · Mobile/.test(await undoLabel());
    say("U17. one drag of a slider, through many values, is one action", sliderGrouped, `${dragged} → ${await range.inputValue()} / ${await undoLabel()}`);
  } else {
    say("U17. one drag of a slider, through many values, is one action", false, "no padBlock slider on this node");
  }
  await device("Desktop");
  await blur();
  await undoButton().click();
  say("U18. the Mobile change undoes while Desktop is on screen, and Desktop is untouched",
    await until(async () => {
      const styles = (await state(TEXT)).draft_styles;
      return !styles?.nodes?.root?.mobile?.background && !styles?.nodes?.root?.base?.background;
    }),
    JSON.stringify((await state(TEXT)).draft_styles));

  // Motion.
  await ready();
  await layers().locator(`[data-layer-row="section:${TEXT}"]`).click();
  await page.waitForTimeout(400);
  await page.getByRole("tab", { name: /Motion/ }).click();
  const entrance = page.locator('[data-motion-field="entrance"] select');
  await entrance.waitFor({ timeout: 10_000 });
  await entrance.selectOption({ label: "Blur reveal" });
  say("U19. a Motion change is one action", /Entrance · Desktop/.test(await undoLabel()), await undoLabel());
  await until(async () => (await state(TEXT)).draft_motion_config?.section?.base?.entrance === "blur");
  await blur();
  await undoButton().click();
  say("U20. …and Undo takes the entrance back",
    await until(async () => (await state(TEXT)).draft_motion_config?.section?.base?.entrance !== "blur"),
    JSON.stringify((await state(TEXT)).draft_motion_config));

  // Layout: reorder, add, remove, hide.
  await ready();
  let revision = await pageRevision();
  const beforeMove = await layerIds();
  const first = beforeMove[0]!;
  await rowButton(first, /Move down/).click();
  await settleLayers(revision, beforeMove);
  const movedOrder = await layerIds();
  say("U21a. Move down is one action", /^Undo: Move /.test(await undoLabel()) && movedOrder[1] === first, await undoLabel());
  revision = await pageRevision();
  await blur();
  await undoButton().click();
  await settleLayers(revision, movedOrder);
  const undoneOrder = await layerIds();
  say("U21. Undo reorders back, through the guarded structural request",
    JSON.stringify(undoneOrder) === JSON.stringify(originalOrder) &&
      JSON.stringify((await draftOrder())?.map((e) => e.sectionId) ?? originalOrder) === JSON.stringify(originalOrder),
    JSON.stringify(undoneOrder));
  revision = await pageRevision();
  await blur();
  await page.keyboard.press("Control+Shift+Z");
  await settleLayers(revision, undoneOrder);
  say("U21b. Redo moves it again", JSON.stringify(await layerIds()) === JSON.stringify(movedOrder), JSON.stringify(await layerIds()));
  revision = await pageRevision();
  await blur();
  await page.keyboard.press("Control+Z");
  await settleLayers(revision, movedOrder);

  // Add, then undo it: the new row goes to Removed; Redo brings the same row back.
  revision = await pageRevision();
  const beforeAdd = await layerIds();
  await layers().locator(`[data-layer-row="section:${originalOrder[1]}"]`).click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Add section" }).click();
  await page.locator("[data-block-picker]").waitFor({ timeout: 10_000 });
  await page.locator('[data-block-picker] button[data-block-type="stats"]').click();
  await settleLayers(revision, beforeAdd);
  const withAdded = await layerIds();
  const addedId = withAdded.find((id) => !originalOrder.includes(id))!;
  say("U22a. Add is one action", /^Undo: Add Statistics$/.test(await undoLabel()) && Boolean(addedId), await undoLabel());
  revision = await pageRevision();
  await blur();
  await undoButton().click();
  await settleLayers(revision, withAdded);
  say("U22. Undo takes the added section out of the layout",
    !(await layerIds()).includes(addedId) && (await page.locator(`[data-removed-id="${addedId}"]`).count()) > 0,
    JSON.stringify(await layerIds()));
  revision = await pageRevision();
  const beforeRedoAdd = await layerIds();
  await blur();
  await redoButton().click();
  await settleLayers(revision, beforeRedoAdd);
  say("U22b. Redo restores the very same row in the very same place", JSON.stringify(await layerIds()) === JSON.stringify(withAdded),
    JSON.stringify(await layerIds()));
  revision = await pageRevision();
  await blur();
  await undoButton().click();
  await settleLayers(revision, withAdded);

  // Remove, then undo it.
  revision = await pageRevision();
  const victim = originalOrder[2]!;
  const beforeRemove = await layerIds();
  await rowButton(victim, /Remove from the layout/).click();
  await settleLayers(revision, beforeRemove);
  revision = await pageRevision();
  const afterRemove = await layerIds();
  await blur();
  await undoButton().click();
  await settleLayers(revision, afterRemove);
  say("U23. Undo of a removal puts the section back exactly where it was",
    JSON.stringify(await layerIds()) === JSON.stringify(originalOrder), JSON.stringify(await layerIds()));

  // Hide, then undo it.
  revision = await pageRevision();
  await rowButton(victim, /Hide when the layout is published/).click();
  await settleLayout(revision);
  const hidden = (await draftOrder())?.find((entry) => entry.sectionId === victim)?.visible === false;
  revision = await pageRevision();
  await blur();
  await undoButton().click();
  await settleLayout(revision);
  say("U23a. Undo of a hide shows the section again",
    hidden && (await draftOrder())?.find((entry) => entry.sectionId === victim)?.visible === true);

  // English and Arabic, with a language switch between the actions.
  await ready();
  await language("العربية");
  await select(`section:${TEXT}/field:title`);
  await contentTab();
  const arabicBox = page.locator("#field-title-ar");
  await arabicBox.waitFor({ timeout: 15_000 });
  await arabicBox.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" عربي");
  await until(async () => (await draftText(TEXT, "title", "ar")) === `${TEXT_TITLE.ar} عربي`);
  const arabicCanvas = (await (await frameNow()).locator("html").getAttribute("dir")) === "rtl";
  await blur();
  await language("English");
  say("U24a. back in English, Undo still names the Arabic edit", (await undoLabel()) === "Undo: Change Title (Arabic)", await undoLabel());
  await blur();
  await undoButton().click();
  say("U24. Undo returns the Arabic text while English is on screen, and English is untouched",
    arabicCanvas &&
      (await until(async () => (await draftText(TEXT, "title", "ar")) === TEXT_TITLE.ar)) &&
      (await draftText(TEXT, "title", "en")) === TEXT_TITLE.en,
    `${await draftText(TEXT, "title", "ar")} / ${await draftText(TEXT, "title", "en")}`);

  // Page isolation.
  await ready();
  const aboutLabel = await undoLabel();
  await page.selectOption("#ve-page", "home");
  await ready();
  const homeLabel = await undoLabel();
  await page.selectOption("#ve-page", "about");
  await ready();
  say("U25. each page has its own history, kept across a page switch",
    homeLabel === "Undo — nothing to undo" && (await undoLabel()) === aboutLabel && aboutLabel !== "Undo — nothing to undo",
    `${aboutLabel} / home: ${homeLabel} / back: ${await undoLabel()}`);

  // A conflict throws the history away and says why.
  await select(`section:${TEXT}/field:title`);
  await contentTab();
  await sql`update page_sections set revision = revision + 1 where id = ${TEXT}`;
  await page.locator("#field-title-en").fill("Written against an old revision");
  const conflicted = await until(async () => (await notice()) === RESET_SECTION, 15_000);
  say("U26. a section conflict resets the history, with the brief's sentence",
    conflicted && (await undoButton().isDisabled()), await notice());
  const reloadLatest = page.getByRole("button", { name: "Reload latest" });
  if (await reloadLatest.count()) await reloadLatest.click();
  await ready();

  // Publish, Discard and Restore each clear it.
  await select(`section:${TEXT}/field:title`);
  await contentTab();
  await page.locator("#field-title-en").fill("Heading for publication");
  await until(async () => (await draftText(TEXT, "title", "en")) === "Heading for publication");
  await blur();
  const hadHistory = await undoButton().isEnabled();
  await page.getByRole("button", { name: /^Publish/ }).first().click();
  await page.getByRole("button", { name: "Publish saved changes" }).click();
  const publishedCleared = await until(async () => /this page was published/.test(await notice()), 20_000);
  say("U27. Publish clears the history and says why", hadHistory && publishedCleared && (await undoButton().isDisabled()), await notice());

  await pageActionDone();
  await select(`section:${TEXT}/field:eyebrow`);
  await contentTab();
  await page.locator("#field-eyebrow-en").fill("To be discarded");
  await until(async () => (await draftText(TEXT, "eyebrow", "en")) === "To be discarded");
  await blur();
  await page.getByRole("button", { name: "Discard all saved changes" }).click();
  const discardCleared = await until(async () => /discarded, and Redo cannot bring them back/.test(await notice()), 20_000);
  say("U28. Discard clears the history and says why", discardCleared && (await undoButton().isDisabled()), await notice());
  await pageActionDone();

  // A restore needs a page with no saved changes, so the history it clears is
  // an edit undone before the autosave ran: nothing saved, one action to Redo.
  await ready();
  await select(`section:${TEXT}/field:eyebrow`);
  await contentTab();
  await page.locator("#field-eyebrow-en").fill("Before a restore");
  await blur();
  await undoButton().click();
  await until(async () => await redoButton().isEnabled(), 20_000);
  // "Nothing saved" is a claim about time: it holds only once the autosave
  // the edit would have scheduled has had its chance (Batch 19A — the Redo
  // button and the unchanged row are both true the moment Undo is pressed).
  await quietFor(page, AUTOSAVE_QUIET_MS, "an undone edit that was going to be autosaved would have been by now");
  const cleanWithRedo =
    (await redoButton().isEnabled()) && (await draftText(TEXT, "eyebrow", "en")) !== "Before a restore";
  await page.getByRole("button", { name: "Restore to draft" }).first().click();
  const restoreCleared = await until(async () => /a version was restored into saved changes/.test(await notice()), 20_000);
  await pageActionDone();
  say("U29. a historical Restore clears the history — Redo included — and says why",
    cleanWithRedo && restoreCleared && (await undoButton().isDisabled()) && (await redoButton().isDisabled()),
    `${cleanWithRedo} ${await notice()}`);
  say("U29a. the page panel says what Undo is and what Version History is",
    /current editing session/.test((await page.locator("[data-undo-scope]").textContent()) ?? ""));
  // Leave About clean: publish the restored drafts.
  await page.getByRole("button", { name: "Publish saved changes" }).click();
  await until(async () => /published/.test(await notice()), 20_000);
  await pageActionDone();
  say("U30. no page errors in the editor", editorErrors.length === 0, editorErrors.join(" | "));

  /* ====================================================================== */
  /* Version Compare                                                        */
  /* ====================================================================== */

  // A version whose rich-text title differs from what is published now.
  const publishedTitle = (
    (await sql<{ published: { title: { en: string; ar: string } } }[]>`select published from page_sections where id = ${TEXT}`)[0]!
      .published.title
  );
  const versions = await sql<{ id: number; snapshot: { sections: { sourceSectionId: number; blockType: string; visible: boolean; published: Record<string, unknown> }[] } }[]>`
    select id, snapshot from page_versions where page_id = ${ABOUT} order by id desc`;
  const titleIn = (snapshot: (typeof versions)[number]["snapshot"]) =>
    (snapshot.sections.find((section) => section.sourceSectionId === TEXT)?.published.title as { en: string; ar: string } | undefined);
  const chosen = versions.find((version) => titleIn(version.snapshot)?.en !== publishedTitle.en)!;
  say("C0. a version that differs from the published page exists", Boolean(chosen), JSON.stringify(versions.map((v) => [v.id, titleIn(v.snapshot)?.en])));
  const versionTitle = titleIn(chosen.snapshot)!;

  const link = page.locator(`[data-compare-version="${chosen.id}"]`);
  if (!(await link.count())) await page.getByRole("button", { name: /^Publish/ }).first().click().catch(() => undefined);
  await link.waitFor({ timeout: 10_000 }).catch(() => undefined);
  say("C1. Version History offers the comparison beside Restore",
    (await link.count()) > 0 && (await link.getAttribute("href")) === `/admin/compare?page=${ABOUT}&version=${chosen.id}`,
    (await link.getAttribute("href").catch(() => "")) ?? "");

  const before = await fingerprint();
  const versionsBefore = (await sql<{ n: number }[]>`select count(*)::int as n from page_versions`)[0]!.n;
  const compare = await context.newPage();
  const compareErrors: string[] = [];
  compare.on("pageerror", (error) => compareErrors.push(error.message.slice(0, 160)));
  compare.on("dialog", (dialog) => void dialog.accept());
  await compare.goto(`${origin}/admin/compare?page=${ABOUT}&version=${chosen.id}`, { waitUntil: "load" });
  const panes = async (): Promise<[Frame, Frame]> => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const found = compare.frames().filter((f) => f.url().includes("compare="));
      if (found.length === 2) {
        const left = found.find((f) => /compare=v\d+/.test(f.url()) && f.url().includes(`v${chosen.id}`));
        const right = found.find((f) => f !== left);
        if (left && right) {
          try {
            await left.waitForLoadState("load");
            await right.waitForLoadState("load");
            await left.locator("[data-eod-still]").first().waitFor({ state: "attached", timeout: 15_000 });
            await right.locator("[data-eod-still]").first().waitFor({ state: "attached", timeout: 15_000 });
            return [left, right];
          } catch {
            // A pane that was replaced mid-wait: look again.
          }
        }
      }
      if (Date.now() > deadline) throw new Error("the two panes never arrived");
      await compare.waitForTimeout(200);
    }
  };
  let [left, right] = await panes();
  const heading = async (frame: Frame) =>
    ((await frame.locator(`[data-eod-compare="${TEXT}"] h2`).first().textContent()) ?? "").trim();
  say("C2. the historical pane and the published pane visibly differ",
    (await heading(left)) === versionTitle.en && (await heading(right)) === publishedTitle.en,
    `${await heading(left)} | ${await heading(right)}`);
  const list = (await compare.locator("[data-compare-list]").innerText()).replace(/\s+/g, " ");
  say("C3. the summary names the difference the panes show",
    list.includes("Title (English)") && list.includes(`Before: ${versionTitle.en}`) && list.includes(`After: ${publishedTitle.en}`),
    list.slice(0, 300));
  say("C4. the right pane is the current published page, labelled so",
    (await compare.getByRole("region", { name: /Right pane: Current published/ }).count()) === 1 &&
      right.url().includes("compare=published"));

  const inspect = (frame: Frame) =>
    frame.evaluate(() => ({
      width: window.innerWidth,
      dir: document.documentElement.getAttribute("dir"),
      lang: document.documentElement.getAttribute("lang"),
      still: document.querySelectorAll("[data-eod-still]").length,
      editor: document.querySelectorAll("[data-eod-address], [contenteditable], [data-eod-draft]").length,
      motion: document.querySelectorAll("[data-m-reveal], [data-m-px], [data-m-hv], [data-m-words]").length,
      hidden: [...document.querySelectorAll(".reveal")].filter((el) => Number(getComputedStyle(el).opacity) < 0.99).length,
    }));
  const visibleCount = chosen.snapshot.sections.filter((section) => section.visible).length;
  const l = await inspect(left);
  const r = await inspect(right);
  say("C5. no editing controls in either pane, and no editor on the screen",
    l.editor === 0 && r.editor === 0 && (await compare.locator("aside[aria-label='Inspector'], aside[aria-label='Page structure']").count()) === 0,
    `${l.editor} ${r.editor}`);
  say("C6. both panes are drawn at rest: every section still, no motion, nothing waiting to reveal",
    l.still === visibleCount && r.still >= 1 && l.motion === 0 && r.motion === 0 && l.hidden === 0 && r.hidden === 0,
    JSON.stringify({ l, r }));
  say("C7. Desktop: both panes are 1440px wide", l.width === 1440 && r.width === 1440, `${l.width} ${r.width}`);

  const widthsAt = async (label: "Tablet" | "Mobile" | "Desktop") => {
    await compare.getByRole("group", { name: "Width of both panes" }).getByRole("button", { name: new RegExp(label) }).click();
    await compare.waitForTimeout(900);
    [left, right] = await panes();
    return [await left.evaluate(() => window.innerWidth), await right.evaluate(() => window.innerWidth)];
  };
  const tablet = await widthsAt("Tablet");
  say("C8. Tablet: both panes are 834px wide", tablet[0] === 834 && tablet[1] === 834, JSON.stringify(tablet));
  const mobile = await widthsAt("Mobile");
  say("C9. Mobile: both panes are 390px wide", mobile[0] === 390 && mobile[1] === 390, JSON.stringify(mobile));
  const mobileRest = await inspect(left);
  say("C9a. …and still at rest at that width", mobileRest.hidden === 0 && mobileRest.motion === 0, JSON.stringify(mobileRest));
  await widthsAt("Desktop");

  // Arabic.
  await compare.getByRole("group", { name: "Language of both panes" }).getByRole("button", { name: "العربية" }).click();
  await compare.waitForTimeout(600);
  const deadlineAr = Date.now() + 20_000;
  while (Date.now() < deadlineAr && compare.frames().filter((f) => f.url().includes("/ar/about?compare=")).length < 2) {
    await compare.waitForTimeout(200);
  }
  [left, right] = await panes();
  const la = await inspect(left);
  const ra = await inspect(right);
  say("C10. Arabic: both panes are the Arabic edition, right to left",
    la.dir === "rtl" && ra.dir === "rtl" && la.lang === "ar" && ra.lang === "ar" && left.url().includes("/ar/about"),
    JSON.stringify({ la, ra, url: left.url() }));
  say("C11. …with the version's own Arabic text on the left",
    (await heading(left)) === versionTitle.ar, `${await heading(left)} vs ${versionTitle.ar}`);
  await compare.getByRole("group", { name: "Language of both panes" }).getByRole("button", { name: "English" }).click();
  await compare.waitForTimeout(600);
  [left, right] = await panes();

  // Synchronised scrolling.
  const progress = (frame: Frame) =>
    frame.evaluate(() => {
      const max = document.documentElement.scrollHeight - window.innerHeight;
      return max > 0 ? window.scrollY / max : 0;
    });
  await left.evaluate(() => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo({ top: Math.round(max * 0.5), behavior: "instant" });
  });
  await compare.waitForTimeout(700);
  const followed = await progress(right);
  say("C12. scrolling one pane scrolls the other to the same place", Math.abs(followed - 0.5) < 0.06, followed.toFixed(3));
  await compare.getByLabel("Sync scrolling").uncheck();
  await left.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await compare.waitForTimeout(700);
  const stayed = await progress(right);
  say("C13. with sync off, the other pane stays where it is", Math.abs(stayed - followed) < 0.02, stayed.toFixed(3));
  await compare.getByLabel("Sync scrolling").check();
  // Scrolling the right pane moves the left, and the two do not chase each other.
  await right.evaluate(() => {
    const max = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo({ top: Math.round(max * 0.25), behavior: "instant" });
  });
  await compare.waitForTimeout(900);
  const back = [await progress(left), await progress(right)];
  say("C14. it works in both directions without a loop", Math.abs(back[0]! - 0.25) < 0.06 && Math.abs(back[1]! - 0.25) < 0.02,
    back.map((n) => n.toFixed(3)).join(" "));

  // "Show in the panes".
  await compare.locator(`[data-compare-section="section:${TEXT}"]`).getByRole("button", { name: "Show in the panes" }).click();
  await compare.waitForTimeout(600);
  const tops = await Promise.all(
    [left, right].map((frame) =>
      frame.evaluate((id) => document.querySelector(`[data-eod-compare="${id}"]`)!.getBoundingClientRect().top, TEXT),
    ),
  );
  // To the top of both, below the site's sticky header — the same place in each.
  say("C15. Show in the panes brings the section to the top of both",
    Math.abs(tops[0]! - tops[1]!) < 2 && tops.every((top) => top >= 0 && top < 160), JSON.stringify(tops));

  // Accessibility.
  say("C16. named panes, titled frames, labelled controls",
    (await compare.getByRole("region", { name: /^Left pane: / }).count()) === 1 &&
      (await compare.locator("iframe[title^='Left pane: ']").count()) === 1 &&
      (await compare.locator("iframe[title^='Right pane: ']").count()) === 1 &&
      (await compare.getByRole("complementary", { name: "What changed" }).count()) === 1 &&
      (await compare.getByLabel(/Compare version #\d+ with/).count()) === 1);
  const badges = await compare.locator(`[data-compare-section="section:${TEXT}"] summary`).innerText();
  say("C17. a change is said in words, not colour alone", /content \d+/i.test(badges), badges.replace(/\s+/g, " "));

  // Global and dynamic content.
  const notes = await compare.locator("[data-disclaimer]").allInnerTexts();
  say("C18. the screen says global elements are current and dynamic blocks read current data",
    notes.some((text) => text.startsWith("Global site elements use their current settings")) &&
      notes.some((text) => text.startsWith("Dynamic catalogue/global content reflects current data")),
    notes.join(" | ").slice(0, 200));

  say("C19. looking wrote nothing: no draft, revision, version or activity",
    (await fingerprint()) === before && (await sql<{ n: number }[]>`select count(*)::int as n from page_versions`)[0]!.n === versionsBefore);

  // Restore through the ordinary action.
  await compare.getByRole("button", { name: new RegExp(`Restore version #${chosen.id} to draft`) }).click();
  const restored = await until(async () => (await draftText(TEXT, "title", "en")) === versionTitle.en, 15_000);
  const statusLine = await compare.locator("[role='status']").first().innerText().catch(() => "");
  say("C20. Restore from the comparison stages the version as drafts through the existing flow",
    restored && /Review it in the Visual Editor/.test(statusLine) &&
      (await sql<{ n: number }[]>`select count(*)::int as n from page_versions`)[0]!.n === versionsBefore &&
      ((await sql<{ published: { title: { en: string } } }[]>`select published from page_sections where id = ${TEXT}`)[0]!.published.title.en ===
        publishedTitle.en),
    statusLine);
  say("C21. no page errors on the comparison screen", compareErrors.length === 0, compareErrors.join(" | "));

  // The resting state of a page whose hero animates on its own.
  const heroSection = (await sql<{ id: number; revision: number; page_id: number; published: Record<string, unknown> }[]>`
    select id, revision, page_id, published from page_sections where page_id = ${home!.id} and block_type = 'hero'`)[0]!;
  const form = new FormData();
  form.set("_csrf", owner.csrfToken);
  form.set("sectionId", String(heroSection.id));
  form.set("pageId", String(heroSection.page_id));
  form.set("expectedRevision", String(heroSection.revision));
  form.set("values", JSON.stringify({ ...heroSection.published, headline: { ...(heroSection.published.headline as object), en: "A headline for the record" } }));
  await callAction({ origin, route: "/admin/visual-editor", file: "app/(backoffice)/admin/visual-editor/actions.ts", action: "saveVisualSectionDraft", args: [form], cookie: owner.cookie });
  const [homePage] = await sql<{ revision: number }[]>`select revision from pages where id = ${home!.id}`;
  const publishForm = new FormData();
  publishForm.set("_csrf", owner.csrfToken);
  publishForm.set("pageId", String(home!.id));
  publishForm.set("expectedRevision", String(homePage!.revision));
  await callAction({ origin, route: "/admin/visual-editor", file: "app/(backoffice)/admin/visual-editor/actions.ts", action: "publishPageFromEditor", args: [publishForm], cookie: owner.cookie });
  const [homeVersion] = await sql<{ id: number }[]>`select id from page_versions where page_id = ${home!.id} order by id desc limit 1`;
  await compare.goto(`${origin}/admin/compare?page=${home!.id}&version=${homeVersion!.id}`, { waitUntil: "load" });
  const homePanes = async () => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const found = compare.frames().filter((f) => f.url().includes("compare="));
      if (found.length === 2) {
        try {
          for (const frame of found) await frame.locator("[data-eod-still]").first().waitFor({ state: "attached", timeout: 15_000 });
          return found;
        } catch {
          // replaced mid-wait
        }
      }
      if (Date.now() > deadline) throw new Error("home panes never arrived");
      await compare.waitForTimeout(200);
    }
  };
  const homeFrames = await homePanes();
  const words = async () =>
    Promise.all(homeFrames.map((frame) => frame.evaluate(() => (document.querySelector("h1")?.textContent ?? "").replace(/\s+/g, " ").trim())));
  const firstWords = await words();
  await quietFor(compare, 4500, "a live hero changes its word every 2.4 s (HeroWords' interval) — twice inside this window; a still pane shows one word throughout");
  const later = await words();
  const homeRest = await Promise.all(homeFrames.map((frame) => inspect(frame)));
  say("C22. the home page's own animation rests too: the hero words do not rotate, nothing waits to reveal",
    JSON.stringify(firstWords) === JSON.stringify(later) && homeRest.every((entry) => entry.hidden === 0 && entry.motion === 0),
    JSON.stringify({ firstWords, later, homeRest }));

  // A read-only reader compares but is offered no Restore.
  const readerContext = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const [readerName, readerValue] = viewer.cookie.split("=");
  await readerContext.addCookies([{ name: readerName!, value: readerValue!, domain: "127.0.0.1", path: "/" }]);
  const reader = await readerContext.newPage();
  await reader.goto(`${origin}/admin/compare?page=${ABOUT}&version=${chosen.id}`, { waitUntil: "load" });
  await reader.getByText("What changed", { exact: true }).first().waitFor({ timeout: 20_000 });
  say("C23. a read-only reader may compare, and is offered no Restore",
    (await reader.getByRole("button", { name: /Restore version/ }).count()) === 0);
  await readerContext.close();

  // A visitor gets the live page.
  const visitorContext = await browser.newContext();
  const visitor = await visitorContext.newPage();
  const response = await visitor.goto(`${origin}/about?compare=v${chosen.id}`, { waitUntil: "load" });
  const visitorStill = await visitor.locator("[data-eod-still]").count();
  say("C24. a visitor asking for a pane gets the live page, never indexed or stored",
    visitorStill === 0 && response?.headers()["x-robots-tag"] === "noindex, nofollow, noarchive" &&
      response?.headers()["cache-control"] === "private, no-store, max-age=0",
    `${visitorStill} ${response?.headers()["x-robots-tag"]} ${response?.headers()["cache-control"]}`);
  await visitorContext.close();

  await context.close();
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
