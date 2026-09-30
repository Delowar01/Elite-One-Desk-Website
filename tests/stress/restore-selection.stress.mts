/**
 * Batch 19A stress: the selection after the canvas is redrawn — kept on its
 * node, or on the node's section when the edit removed the node — at normal
 * speed and on a CPU slowed four- and six-fold, many times, each from a freshly
 * loaded editor.
 *
 * After a save the editor reloads the canvas and asks for the selected node
 * back by address. The fallback to the section used to fire on a 400 ms timer:
 * a canvas slower than that had the section asked for behind the node, the
 * section's answer arrived last, and the Inspector jumped from what was being
 * edited to its whole section (found as a layout-styles failure in Batch 19A,
 * reproduced 5 times in 6 at six-fold throttling, 0 in 4 unthrottled). The
 * fallback now follows the canvas's own answer — nothing answers to the
 * address — and never a clock.
 *
 *   S1  a style save's redraw keeps the node selected, unthrottled
 *   S2  …with the CPU slowed four-fold
 *   S3  …and six-fold
 *   S4  after each save the canvas reported exactly one selection: the node
 *   S5  Layers marks the node the Inspector shows, after every redraw
 *   S6  removing the selected row lands on its section, unthrottled and six-fold
 *   S7  no page errors in the editor
 *
 *   STRESS_LOOPS=3 (per speed)
 */
import type { Page } from "playwright";

import { editorIdle, inspectorAddress, selectCanvasNode, waitForInspector } from "../browser/canvas";
import { launchChromium } from "../browser/harness";
import { quietFor } from "../browser/wait";
import { giveFresh } from "../helpers/fixtures";
import { connect, dropDatabase } from "../helpers/pg";
import { startServer } from "../helpers/server";
import { signIn } from "../helpers/session";

const PORT = 3809;
const LOOPS = Number(process.env.STRESS_LOOPS ?? 3);
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const RECORDER = `
  if (window === window.top) {
    window.__eodSelections = [];
    window.addEventListener("message", (event) => {
      const message = event.data && event.data.message;
      if (message && message.type === "canvas.selection") {
        window.__eodSelections.push(message.node ? message.node.address : null);
      }
    }, true);
  }
`;

const browser = await launchChromium();
const database = giveFresh("restore_selection_stress");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);
  const origin = server.origin;

  const [why] = await sql<{ id: number; published: { points: { _id: string }[] } }[]>`
    select s.id, s.published from page_sections s join pages p on p.id = s.page_id
     where p.slug = 'home' and s.block_type = 'why-us' limit 1`;
  const SECTION = `section:${why!.id}`;
  const POINTS = `${SECTION}/field:points`;
  const firstPoint = why!.published.points[0]!._id;

  const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
  await context.addInitScript({ content: "window.__name = window.__name || ((fn) => fn);" });
  await context.addInitScript({ content: RECORDER });
  const page: Page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message.slice(0, 160)));
  const cdp = await context.newCDPSession(page);
  const cpu = (rate: number) => cdp.send("Emulation.setCPUThrottlingRate", { rate });

  const selections = () => page.evaluate(() => (window as unknown as { __eodSelections: (string | null)[] }).__eodSelections.slice());
  const layersMark = async (address: string) => {
    const rows = page.locator("aside[aria-label='Page structure'] [data-layer-row][aria-current='true']");
    const deadline = Date.now() + 10_000;
    for (;;) {
      const marked =
        (await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-layer-row") ?? ""))).sort(
          (a, b) => b.length - a.length,
        )[0] ?? null;
      if (marked === address || Date.now() > deadline) return marked;
      await page.waitForTimeout(25);
    }
  };
  /** A fresh editor on Home, with the section's draft put back as it was published. */
  const open = async () => {
    await sql`update page_sections set draft = null, draft_styles = null where id = ${why!.id}`;
    await page.goto(`${origin}/admin/visual-editor?page=home&lang=en&device=desktop`, { waitUntil: "load" });
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  };
  const select = async (address: string) => {
    const result = await selectCanvasNode(page, address);
    if (!result.ok) throw new Error(`could not select ${address}: the Inspector shows ${result.shows}`);
  };

  type Tally = { runs: number; bad: string[] };
  const tally = (): Tally => ({ runs: 0, bad: [] });
  const kept: Record<number, Tally> = { 1: tally(), 4: tally(), 6: tally() };
  const single = tally();
  const layers = tally();
  const fallback = tally();

  for (let loop = 1; loop <= LOOPS; loop += 1) {
    for (const rate of [1, 4, 6]) {
      await open();
      await select(POINTS);
      await page.getByRole("tab", { name: /Style/ }).click();
      const minHeight = page.locator('[data-style-token="minHeight"] select');
      await minHeight.waitFor({ timeout: 10_000 });
      await minHeight.selectOption(loop % 2 ? "half-screen" : "third-screen");
      const from = (await selections()).length;
      await cpu(rate);
      try {
        await page.getByRole("button", { name: "Save now" }).click();
        await editorIdle(page, 90_000);
        await quietFor(page, 3_000, "a section asked for behind the node would have replaced it by now");
      } finally {
        await cpu(1);
      }
      const shows = await inspectorAddress(page);
      const reported = (await selections()).slice(from);
      kept[rate]!.runs += 1;
      if (shows !== POINTS) kept[rate]!.bad.push(`#${loop} ${shows || "nothing"} ← ${JSON.stringify(reported)}`);
      single.runs += 1;
      if (reported.length !== 1 || reported[0] !== POINTS) single.bad.push(`#${loop} ${rate}× ${JSON.stringify(reported)}`);
      const marked = await layersMark(POINTS);
      layers.runs += 1;
      if (marked !== shows) layers.bad.push(`#${loop} ${rate}× layers=${marked} inspector=${shows}`);
    }

    for (const rate of [1, 6]) {
      await open();
      await select(`${POINTS}/item:${firstPoint}`);
      await page.getByRole("tab", { name: /Content/ }).click();
      const remove = page.locator(`aside[aria-label='Inspector'] li[data-item-id="${firstPoint}"] button[aria-label="Remove"]`);
      await remove.waitFor({ timeout: 10_000 });
      const from = (await selections()).length;
      await cpu(rate);
      let shows = "";
      try {
        await remove.click();
        await editorIdle(page, 90_000);
        shows = await waitForInspector(page, SECTION, 20_000);
      } finally {
        await cpu(1);
      }
      fallback.runs += 1;
      if (shows !== SECTION) fallback.bad.push(`#${loop} ${rate}× ${shows || "nothing"} ← ${JSON.stringify((await selections()).slice(from))}`);
      const marked = await layersMark(SECTION);
      layers.runs += 1;
      if (marked !== shows) layers.bad.push(`#${loop} removal ${rate}× layers=${marked} inspector=${shows}`);
    }
    console.log(`· loop ${loop} done`);
  }

  const line = (t: Tally) => `${t.runs - t.bad.length}/${t.runs}`;
  const why3 = (t: Tally) => t.bad.slice(0, 3).join(" | ");
  say(`S1. a style save's redraw keeps the node selected, unthrottled (${line(kept[1]!)})`, kept[1]!.bad.length === 0, why3(kept[1]!));
  say(`S2. …with the CPU slowed four-fold (${line(kept[4]!)})`, kept[4]!.bad.length === 0, why3(kept[4]!));
  say(`S3. …and six-fold (${line(kept[6]!)})`, kept[6]!.bad.length === 0, why3(kept[6]!));
  say(`S4. after each save the canvas reported exactly one selection, the node (${line(single)})`, single.bad.length === 0, why3(single));
  say(`S5. Layers marks the node the Inspector shows after every redraw (${line(layers)})`, layers.bad.length === 0, why3(layers));
  say(`S6. removing the selected row lands on its section, unthrottled and six-fold (${line(fallback)})`, fallback.bad.length === 0, why3(fallback));
  say("S7. no page errors in the editor", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
