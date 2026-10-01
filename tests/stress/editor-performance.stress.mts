/**
 * Batch 19B stress (§32): the editor on a large page — measured, and held to
 * bounds wide enough that only something wrong can cross them.
 *
 * The page is Home, the site's largest, with four sections duplicated onto it
 * (one of each kind that carries a list), so the tree, the canvas and the
 * buffers are as big as an editor is likely to meet. Every step records its
 * wall-clock time and the long tasks (>50 ms, from the browser's own
 * `longtask` timeline) in the shell and on the canvas, and the JavaScript heap
 * is read after a forced garbage collection, so what is reported is what is
 * kept, not what is merely not yet collected. The numbers are printed with
 * every line; the bounds are there to catch a regression that makes the
 * editor stall or hold on to memory, not to grade a machine.
 *
 *   P1  the page opens, Ready, in under 45 s
 *   P2  every branch of Layers opens, and no single task blocks for 2 s or more
 *   P3  each section selected from Layers reaches the Inspector: median < 2.5 s, worst < 10 s
 *   P4  forty selections back and forth: median < 2.5 s, and the heap they leave behind < 25 MB
 *   P5  typing 300 characters: no task blocks for 2 s or more, and autosave stores them
 *   P6  ten style changes: no task blocks for 2 s or more, and the last one is stored
 *   P7  ten entrance changes: the same
 *   P8  everything above leaves less than 50 MB more heap than the open page held
 *   P9  no page errors
 *
 *   No new performance feature is asserted: this is the editor as it is.
 */
import type { Page } from "playwright";

import { editorSettled, selectFromLayers, waitForInspector } from "../browser/canvas";
import { launchChromium } from "../browser/harness";
import { quietFor, until } from "../browser/wait";
import { callAction } from "../helpers/action";
import { giveFresh } from "../helpers/fixtures";
import { connect, dropDatabase } from "../helpers/pg";
import { startServer } from "../helpers/server";
import { signIn } from "../helpers/session";

const PORT = 3810;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

/** Long tasks, as each document's own timeline reports them. */
const LONG_TASKS = `
  window.__eodLong = [];
  try {
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) window.__eodLong.push({ at: entry.startTime + performance.timeOrigin, ms: entry.duration });
    }).observe({ type: "longtask", buffered: true });
  } catch {}
`;

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)]! : 0;
};
const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const browser = await launchChromium();
const database = giveFresh("editor_performance_stress");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);
  const origin = server.origin;

  // A larger Home: four more sections, duplicated the way the editor does it.
  const VE = "app/(backoffice)/admin/visual-editor/actions.ts";
  const [home] = await sql<{ id: number }[]>`select id from pages where slug = 'home'`;
  const pick = await sql<{ id: number; block_type: string }[]>`
    select id, block_type from page_sections
     where page_id = ${home!.id} and not is_draft_only and block_type in ('quick-links', 'why-us', 'stats', 'faq')
     order by position`;
  for (const section of pick) {
    const [now] = await sql<{ revision: number }[]>`select revision from pages where id = ${home!.id}`;
    const data = new FormData();
    data.set("_csrf", owner.csrfToken);
    data.set("pageId", String(home!.id));
    data.set("expectedRevision", String(now!.revision));
    data.set("sectionId", String(section.id));
    const result = await callAction<{ ok: boolean; message?: string }>({
      origin, route: "/admin/visual-editor", file: VE, action: "duplicatePageSection", args: [data], cookie: owner.cookie,
    });
    if (!result.value?.ok) throw new Error(`duplicating ${section.block_type} failed: ${JSON.stringify(result.value)}`);
  }
  const sections = await sql<{ id: number; block_type: string }[]>`
    select id, block_type from page_sections where page_id = ${home!.id} order by position, id`;
  const [hero] = sections.filter((section) => section.block_type === "hero");

  const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
  await context.addInitScript({ content: "window.__name = window.__name || ((fn) => fn);" });
  await context.addInitScript({ content: LONG_TASKS });
  const page: Page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message.slice(0, 160)));
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");

  /** The heap the shell keeps, after a collection. */
  const heap = async () => {
    await cdp.send("HeapProfiler.collectGarbage");
    const { metrics } = (await cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] };
    return metrics.find((metric) => metric.name === "JSHeapUsedSize")?.value ?? 0;
  };
  /** Long tasks since `since`, in the shell and on whatever canvas is showing. */
  const longSince = async (since: number) => {
    const read = (target: Page | NonNullable<ReturnType<Page["frames"]>[number]>) =>
      target
        .evaluate((from) => ((window as unknown as { __eodLong?: { at: number; ms: number }[] }).__eodLong ?? []).filter((task) => task.at >= from), since)
        .catch(() => [] as { at: number; ms: number }[]);
    const canvas = page.frames().find((frame) => frame.url().includes("editor=1"));
    const tasks = [...(await read(page)), ...(canvas ? await read(canvas) : [])];
    return { count: tasks.length, worst: Math.round(Math.max(0, ...tasks.map((task) => task.ms))) };
  };
  const now = () => page.evaluate(() => performance.timeOrigin + performance.now());

  /* P1 ------------------------------------------------------------------- */
  const opening = Date.now();
  await page.goto(`${origin}/admin/visual-editor?page=home&lang=en&device=desktop`, { waitUntil: "load" });
  const settled = await editorSettled(page, 90_000);
  const openMs = Date.now() - opening;
  say(`P1. the page opens, Ready, in under 45 s (${sections.length} sections)`, settled && openMs < 45_000, `${openMs} ms`);
  await quietFor(page, 1500, "the open page settles before its heap is read");
  const heapOpen = await heap();

  /* P2 ------------------------------------------------------------------- */
  let mark = await now();
  const expandStart = Date.now();
  let opened = 0;
  for (let round = 0; round < 6; round += 1) {
    const closed = page.locator("aside[aria-label='Page structure'] button[data-layer-toggle][aria-expanded='false']:not([disabled])");
    const count = await closed.count();
    if (!count) break;
    for (let i = 0; i < count; i += 1) {
      const toggle = closed.first();
      if (!(await toggle.count())) break;
      await toggle.click();
      opened += 1;
    }
  }
  const expandMs = Date.now() - expandStart;
  const expandLong = await longSince(mark);
  const rows = await page.locator("aside[aria-label='Page structure'] [data-layer-row]").count();
  say("P2. every branch of Layers opens, and no single task blocks for 2 s or more",
    opened > 0 && expandLong.worst < 2000,
    `${opened} branches, ${rows} rows in ${expandMs} ms; ${expandLong.count} long tasks, worst ${expandLong.worst} ms`);

  /* P3 ------------------------------------------------------------------- */
  const selectTimes: number[] = [];
  mark = await now();
  for (const section of sections) {
    const started = Date.now();
    await selectFromLayers(page, `section:${section.id}`);
    selectTimes.push(Date.now() - started);
  }
  const selectLong = await longSince(mark);
  say("P3. each section selected from Layers reaches the Inspector: median under 2.5 s, worst under 10 s",
    median(selectTimes) < 2500 && Math.max(...selectTimes) < 10_000,
    `${selectTimes.length} sections: median ${median(selectTimes)} ms, worst ${Math.max(...selectTimes)} ms; ${selectLong.count} long tasks, worst ${selectLong.worst} ms`);

  /* P4 ------------------------------------------------------------------- */
  const heapBefore = await heap();
  const back = sections[0]!;
  const forth = sections[Math.floor(sections.length / 2)]!;
  const flipTimes: number[] = [];
  for (let i = 0; i < 40; i += 1) {
    const target = i % 2 ? back : forth;
    const started = Date.now();
    await page.locator(`aside[aria-label='Page structure'] [data-layer-row="section:${target.id}"]`).click();
    await waitForInspector(page, `section:${target.id}`, 15_000);
    flipTimes.push(Date.now() - started);
  }
  await quietFor(page, 1500, "the last selection settles before the heap is read");
  const heapAfter = await heap();
  say("P4. forty selections back and forth: median under 2.5 s, and under 25 MB of heap left behind",
    median(flipTimes) < 2500 && heapAfter - heapBefore < 25 * 1024 * 1024,
    `median ${median(flipTimes)} ms, worst ${Math.max(...flipTimes)} ms; heap ${mb(heapBefore)} → ${mb(heapAfter)}`);

  /* P5 ------------------------------------------------------------------- */
  await selectFromLayers(page, `section:${hero!.id}`);
  await page.getByRole("tab", { name: /Content/ }).click();
  const lead = page.locator('[data-field="lead"] textarea').first();
  await lead.waitFor({ timeout: 10_000 });
  const typed = " Measured typing.".repeat(18).slice(0, 300);
  const original = await lead.inputValue();
  await lead.focus();
  // The end of the text, not of the visual line: the box is narrow and wraps.
  await page.keyboard.press("Control+End");
  mark = await now();
  const typingStart = Date.now();
  await page.keyboard.type(typed);
  const typingMs = Date.now() - typingStart;
  const typingLong = await longSince(mark);
  const stored = await until(async () => {
    const [row] = await sql<{ lead: string | null }[]>`select draft->'lead'->>'en' as lead from page_sections where id = ${hero!.id}`;
    return row?.lead === `${original}${typed}`;
  }, 30_000, 250);
  say("P5. typing 300 characters: no task blocks for 2 s or more, and autosave stores every one",
    typingLong.worst < 2000 && stored,
    `${typingMs} ms to type; ${typingLong.count} long tasks, worst ${typingLong.worst} ms; stored ${stored}`);

  /* P6 ------------------------------------------------------------------- */
  // The lead itself: a size is a text node's control, not a section's.
  await selectFromLayers(page, `section:${hero!.id}/field:lead`);
  await page.getByRole("tab", { name: /Style/ }).click();
  const size = page.locator('[data-style-token="fontSize"] select').first();
  await size.waitFor({ timeout: 10_000 });
  const sizes = ["h2", "h3"];
  mark = await now();
  const styleStart = Date.now();
  for (let i = 0; i < 10; i += 1) await size.selectOption(sizes[i % 2]!);
  const styleMs = Date.now() - styleStart;
  const styleLong = await longSince(mark);
  const styleStored = await until(async () => {
    const [row] = await sql<{ styles: { nodes?: Record<string, { base?: { fontSize?: string } }> } | null }[]>`
      select draft_styles as styles from page_sections where id = ${hero!.id}`;
    return Object.values(row?.styles?.nodes ?? {}).some((node) => node.base?.fontSize === sizes[1]);
  }, 30_000, 250);
  say("P6. ten style changes: no task blocks for 2 s or more, and the last one is stored",
    styleLong.worst < 2000 && styleStored,
    `${styleMs} ms; ${styleLong.count} long tasks, worst ${styleLong.worst} ms; stored ${styleStored}`);

  /* P7 ------------------------------------------------------------------- */
  // The section's own entrance: the one select every section offers.
  await editorSettled(page);
  await selectFromLayers(page, `section:${hero!.id}`);
  await page.getByRole("tab", { name: /Motion/ }).click();
  const entrance = page.locator('[data-motion-field="entrance"] select').first();
  await entrance.waitFor({ timeout: 10_000 });
  const options = (await entrance.locator("option").evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value)))
    .filter((option) => option && option !== "none");
  const chosen = [options[0] ?? "fade-up", options[1] ?? options[0] ?? "fade-up"];
  mark = await now();
  const motionStart = Date.now();
  for (let i = 0; i < 10; i += 1) await entrance.selectOption(chosen[i % 2]!);
  const motionMs = Date.now() - motionStart;
  const motionLong = await longSince(mark);
  const motionStored = await until(async () => {
    const [row] = await sql<{ doc: unknown }[]>`select draft_motion_config as doc from page_sections where id = ${hero!.id}`;
    return JSON.stringify(row?.doc ?? null).includes(`"${chosen[1]}"`);
  }, 30_000, 250);
  say("P7. ten entrance changes: no task blocks for 2 s or more, and the last one is stored",
    motionLong.worst < 2000 && motionStored,
    `${motionMs} ms; ${motionLong.count} long tasks, worst ${motionLong.worst} ms; stored ${motionStored}`);

  /* P8 ------------------------------------------------------------------- */
  await editorSettled(page);
  await quietFor(page, 2000, "the saves settle before the heap is read");
  const heapEnd = await heap();
  say("P8. everything above leaves less than 50 MB more heap than the open page held",
    heapEnd - heapOpen < 50 * 1024 * 1024, `${mb(heapOpen)} → ${mb(heapEnd)}`);

  say("P9. no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
  await context.close();
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
