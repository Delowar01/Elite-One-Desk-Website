/**
 * Batch 16 stress: 110 real actions on the largest page, then Undo all the
 * way down and Redo all the way back — the 100-action bound, the depth of
 * Undo, the save path under a long burst, and the editor's own heap for a
 * full history, measured in the browser.
 */
import type { Frame } from "playwright";

import { giveFresh } from "../helpers/fixtures";
import { connect, dropDatabase } from "../helpers/pg";
import { startServer } from "../helpers/server";
import { signIn } from "../helpers/session";
import { launchChromium } from "../browser/harness";

const PORT = 3805;
const ACTIONS = 110;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("undo_stress");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);
  const origin = server.origin;
  const [home] = await sql<{ id: number }[]>`select id from pages where slug = 'home'`;
  const [hero] = await sql<{ id: number; published: Record<string, unknown> }[]>`
    select id, published from page_sections where page_id = ${home!.id} and block_type = 'hero'`;
  const HERO = hero!.id;
  const original = (hero!.published.eyebrow as { en: string }).en;
  const draftEyebrow = async () =>
    String((((await sql<{ draft: Record<string, unknown> | null }[]>`select draft from page_sections where id = ${HERO}`)[0]!.draft?.eyebrow as Record<string, string>) ?? {}).en ?? "");
  const until = async (what: () => Promise<boolean>, ms = 60_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await what()) return true;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
  await context.addInitScript({ content: "window.__name = window.__name || ((fn) => fn);" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message.slice(0, 160)));
  const cdp = await context.newCDPSession(page);
  const heap = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    await cdp.send("HeapProfiler.collectGarbage");
    return (await cdp.send("Runtime.getHeapUsage")).usedSize;
  };

  await page.goto(`${origin}/admin/visual-editor?page=home&lang=en&device=desktop`, { waitUntil: "load" });
  await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  const frame = (): Frame => page.frames().find((f) => f.url().includes("editor=1"))!;
  const eyebrow = frame().locator(`[data-eod-address="section:${HERO}/field:eyebrow"]`).first();
  await eyebrow.click({ force: true });
  await page.getByRole("tab", { name: /Content/ }).click();
  const box = page.locator("#field-eyebrow-en");
  await box.waitFor({ timeout: 20_000 });
  const undo = page.locator('[data-history="undo"]');
  const redo = page.locator('[data-history="redo"]');
  const blur = async () => {
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  };

  const baseline = await heap();
  const started = Date.now();
  for (let index = 0; index < ACTIONS; index += 1) {
    await box.fill(`Eyebrow ${index}`);
    // Leaving the field ends the action: each fill is one entry.
    await blur();
  }
  const typedIn = Date.now() - started;
  const full = await heap();
  say(`1. ${ACTIONS} actions recorded`, (await undo.getAttribute("aria-label")) === "Undo: Change Eyebrow (English)", `${typedIn}ms`);
  const savedLast = await until(async () => (await draftEyebrow()) === `Eyebrow ${ACTIONS - 1}`);
  say("2. the burst was saved by the ordinary autosave, ending on the last value", savedLast, await draftEyebrow());

  // Undo all the way down.
  let undone = 0;
  const undoStart = Date.now();
  while (await undo.isEnabled()) {
    await undo.click();
    undone += 1;
    if (undone > ACTIONS + 5) break;
  }
  const undoMs = Date.now() - undoStart;
  say("3. Undo goes back exactly 100 actions — the oldest ten were let go", undone === 100, `${undone} in ${undoMs}ms`);
  const expected = `Eyebrow ${ACTIONS - 101}`;
  say("4. …which is the value before the oldest kept action", (await box.inputValue()) === expected, await box.inputValue());
  const savedUndo = await until(async () => (await draftEyebrow()) === expected);
  say("5. …and the autosave carried it to the server", savedUndo, await draftEyebrow());

  // Redo all the way back.
  let redone = 0;
  while (await redo.isEnabled()) {
    await redo.click();
    redone += 1;
    if (redone > ACTIONS + 5) break;
  }
  say("6. Redo walks all 100 back", redone === 100 && (await box.inputValue()) === `Eyebrow ${ACTIONS - 1}`, `${redone} → ${await box.inputValue()}`);
  const savedRedo = await until(async () => (await draftEyebrow()) === `Eyebrow ${ACTIONS - 1}`);
  say("7. …and it is saved", savedRedo, await draftEyebrow());

  const growth = full - baseline;
  say("8. the editor's heap for a full history stays small", growth < 20 * 1024 * 1024,
    `baseline ${(baseline / 1048576).toFixed(1)} MB, after ${ACTIONS} actions ${(full / 1048576).toFixed(1)} MB, growth ${(growth / 1024).toFixed(0)} KB`);
  const [revision] = await sql<{ revision: number }[]>`select revision from page_sections where id = ${HERO}`;
  say("9. no conflict along the way — one section, one editor, every save accepted",
    !(await page.locator("[data-history-notice]").count()), `section revision ${revision!.revision}`);
  say("10. no page errors", errors.length === 0, errors.join(" | "));
  console.log(`   original eyebrow was “${original}”`);
  await context.close();
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
