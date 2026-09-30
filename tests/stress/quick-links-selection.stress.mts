/**
 * Batch 19A stress: Quick Links canvas selection, every edition and width,
 * over and over, each time from a freshly loaded editor.
 *
 * The first card of Home's Quick Links is clicked three ways, each click made
 * once with `clickCanvasNode` (instant scroll, canvas and editor held still,
 * one click in page pixels, its landing read inside the canvas):
 *
 *   picture — the upper part of the card, the picture frame's own area;
 *   title   — the centre of the label;
 *   badge   — the card's unannotated icon badge: the nearest node under the
 *             pointer is the picture behind the text layer, which is the
 *             documented rule (Batch 12), so that is what it must select.
 *
 * After each click: the Inspector shows exactly the expected address, Layers
 * marks the same node, and the canvas reported exactly one selection for the
 * click — the node itself, with no step through the picture or a sibling.
 * The item's stored `_id` is what every address carries, before and after
 * every reload, and clicking writes nothing.
 *
 *   Q1  picture → image              Q5  one selection per click, no sibling
 *   Q2  the title click lands on it   Q6  Layers and Inspector agree
 *   Q3  title → label, never picture  Q7  `_id`s kept, nothing written
 *   Q4  badge → picture (documented)  Q8  EN/AR × Desktop/Tablet/Mobile × reloads
 *
 *   STRESS_LOOPS=4 (reloads per edition and width)
 */
import type { Page } from "playwright";

import { canvasStill, clickCanvasNode, inspectorAddress, waitForInspector } from "../browser/canvas";
import { launchChromium } from "../browser/harness";
import { giveFresh } from "../helpers/fixtures";
import { connect, dropDatabase } from "../helpers/pg";
import { startServer } from "../helpers/server";
import { signIn } from "../helpers/session";

const PORT = 3807;
const LOOPS = Number(process.env.STRESS_LOOPS ?? 4);
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const SELECTIONS = `
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
const database = giveFresh("quick_links_stress");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);
  const origin = server.origin;

  const [home] = await sql<{ id: number }[]>`select id from pages where slug = 'home'`;
  const rowOf = async () =>
    (
      await sql<{ id: number; revision: number; published: { links: { _id: string }[] }; draft: unknown }[]>`
        select id, revision, published, draft from page_sections where page_id = ${home!.id} and block_type = 'quick-links'`
    )[0]!;
  const stored = await rowOf();
  const firstId = stored.published.links[0]!._id;

  const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
  await context.addInitScript({ content: "window.__name = window.__name || ((fn) => fn);" });
  await context.addInitScript({ content: SELECTIONS });
  const page: Page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message.slice(0, 160)));

  const frame = () => page.frameLocator("iframe[title]");
  const card = () => frame().locator(".ql-card").first();
  const selections = () => page.evaluate(() => (window as unknown as { __eodSelections: (string | null)[] }).__eodSelections.length);
  const reportedSince = (from: number) =>
    page.evaluate((start) => (window as unknown as { __eodSelections: (string | null)[] }).__eodSelections.slice(start), from);
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

  type Tally = { runs: number; bad: string[] };
  const tally = (): Tally => ({ runs: 0, bad: [] });
  const q = { picture: tally(), landed: tally(), title: tally(), badge: tally(), single: tally(), layers: tally(), ids: tally() };
  const combos: string[] = [];

  /** One click, then everything that must follow from it. */
  const check = async (
    key: "picture" | "title" | "badge",
    label: string,
    click: () => Promise<{ inTarget: boolean }>,
    expected: string,
  ) => {
    const from = await selections();
    const landing = await click();
    if (key === "title") {
      q.landed.runs += 1;
      if (!landing.inTarget) q.landed.bad.push(`${label} ${JSON.stringify(landing)}`);
    }
    const shows = await waitForInspector(page, expected);
    q[key].runs += 1;
    if (shows !== expected) q[key].bad.push(`${label} → ${shows || "nothing"}`);
    const reported = await reportedSince(from);
    q.single.runs += 1;
    // A click on the node already selected reports it again; either way it is
    // exactly the one node, never a step through another.
    if (reported.length !== 1 || reported[0] !== expected) q.single.bad.push(`${label} ${JSON.stringify(reported)}`);
    const marked = await layersMark(expected);
    q.layers.runs += 1;
    if (marked !== (await inspectorAddress(page))) q.layers.bad.push(`${label} layers=${marked}`);
  };

  for (const lang of ["en", "ar"]) {
    for (const device of ["desktop", "tablet", "mobile"]) {
      for (let run = 1; run <= LOOPS; run += 1) {
        const label = `${lang}/${device} #${run}`;
        combos.push(label);
        await page.goto(`${origin}/admin/visual-editor?page=home&lang=${lang}&device=${device}`, { waitUntil: "load" });
        await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
        await card().waitFor({ timeout: 30_000 });
        await canvasStill(page, card());

        const item = await frame().locator("li[data-eod-node]").first().getAttribute("data-eod-address");
        const image = await frame().locator(".ql-shot").first().getAttribute("data-eod-address");
        const text = await frame().locator(".ql-title").first().getAttribute("data-eod-address");
        q.ids.runs += 1;
        if (!item?.endsWith(`item:${firstId}`) || image !== `${item}/field:image` || text !== `${item}/field:label`) {
          q.ids.bad.push(`${label} ${JSON.stringify({ item, image, text, firstId })}`);
        }
        const box = await card().boundingBox();
        const top = 14 / (box?.height ?? 160);

        await check("picture", `${label} picture`, () => clickCanvasNode(page, card(), { x: 0.5, y: top }), image ?? "");
        await check("title", `${label} title`, () => clickCanvasNode(page, frame().locator(".ql-title").first(), "center"), text ?? "");
        await check("badge", `${label} badge`, () => clickCanvasNode(page, frame().locator(".ql-badge").first(), "center"), image ?? "");
        // And back to the title once more, from the picture: the order the
        // intermittent failure was found in.
        await check("title", `${label} title again`, () => clickCanvasNode(page, frame().locator(".ql-title").first(), "center"), text ?? "");
      }
    }
  }

  const after = await rowOf();
  const unwritten =
    after.revision === stored.revision &&
    JSON.stringify(after.published) === JSON.stringify(stored.published) &&
    JSON.stringify(after.draft) === JSON.stringify(stored.draft);

  const line = (t: Tally) => `${t.runs - t.bad.length}/${t.runs}`;
  const why = (t: Tally) => t.bad.slice(0, 3).join(" | ");
  say(`Q1. a click on the picture selects the image (${line(q.picture)})`, q.picture.bad.length === 0, why(q.picture));
  say(`Q2. every title click landed on the title itself (${line(q.landed)})`, q.landed.bad.length === 0, why(q.landed));
  say(`Q3. a click on the title selects the label, never the picture (${line(q.title)})`, q.title.bad.length === 0, why(q.title));
  say(`Q4. a click on the card's badge selects the picture beneath it — the documented nearest node (${line(q.badge)})`, q.badge.bad.length === 0, why(q.badge));
  say(`Q5. each click reported exactly one selection, the node clicked — no jump to a sibling (${line(q.single)})`, q.single.bad.length === 0, why(q.single));
  say(`Q6. Layers marks the node the Inspector shows, after every click (${line(q.layers)})`, q.layers.bad.length === 0, why(q.layers));
  say(`Q7. every address carries the stored _id, and clicking wrote nothing (${line(q.ids)})`, q.ids.bad.length === 0 && unwritten, why(q.ids) || (unwritten ? "" : "the section changed"));
  say(
    `Q8. English and Arabic × Desktop, Tablet and Mobile, ${LOOPS} fresh loads each (${combos.length} loads), no page errors`,
    combos.length === 6 * LOOPS && errors.length === 0,
    errors.slice(0, 3).join(" | "),
  );
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
