/**
 * Batch 15a §37: many motion nodes on one real page, measured.
 *
 * Every element the home page annotates that may carry motion is given an
 * entrance — the section wrappers, every heading and paragraph, every picture,
 * every list (with a stagger) and every row the list does not own — and the
 * page is loaded, scrolled top to bottom and read back. What is reported is
 * what §37 asks for: observers, scroll listeners, frame callbacks, and the DOM
 * writes the motion code makes. The same page with no motion is the baseline,
 * so anything the framework or the site's own chrome does is not counted as
 * motion's.
 */
import type { Page } from "playwright";

import { giveFresh } from "../helpers/fixtures";
import { connect, dropDatabase } from "../helpers/pg";
import { startServer } from "../helpers/server";
import { signIn } from "../helpers/session";
import { launchChromium } from "../browser/harness";
import { until } from "../browser/wait";

const PORT = 3803;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

/** Counts everything §37 asks about, from before the first script runs. */
const INSTRUMENT = `
  window.__m = { observers: 0, scroll: 0, raf: 0, shownWrites: 0, otherMotionWrites: 0 };
  const IO = window.IntersectionObserver;
  window.IntersectionObserver = class extends IO {
    constructor(...args) { super(...args); window.__m.observers += 1; }
  };
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, ...rest) {
    if (type === "scroll") window.__m.scroll += 1;
    return add.call(this, type, ...rest);
  };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => { window.__m.raf += 1; return raf(callback); };
  new MutationObserver((records) => {
    for (const record of records) {
      if (record.attributeName === "data-shown") window.__m.shownWrites += 1;
      else if (record.attributeName && /^data-m-/.test(record.attributeName)) window.__m.otherMotionWrites += 1;
    }
  }).observe(document, { attributes: true, subtree: true, attributeFilter: ["data-shown", "data-m-reveal", "data-m-group", "data-m-member", "data-m-t", "data-m-m", "style"] });
`;

const browser = await launchChromium();
const database = giveFresh("motion_stress");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);
  const origin = server.origin;
  const [name, value] = owner.cookie.split("=");
  const cookie = { name: name!, value: value!, domain: "127.0.0.1", path: "/" };

  /* --- every addressable node on the home page ---------------------------- */
  const canvas = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await canvas.addCookies([cookie]);
  const probe = await canvas.newPage();
  await probe.goto(`${origin}/?preview=1&editor=1&bridge=0123456789abcdef0123456789abcdef`, { waitUntil: "load" });
  const addresses = await probe.evaluate(() =>
    [...document.querySelectorAll("[data-eod-address]")].map((node) => node.getAttribute("data-eod-address")!),
  );
  await canvas.close();

  const ENTRANCES = [
    { entrance: "fade-up" },
    { entrance: "blur", duration: "fast" },
    { entrance: "mask", direction: "start" },
    { entrance: "slide-in", direction: "end", delay: 100 },
    { entrance: "scale-in", easing: "soft-out" },
    { entrance: "mask", direction: "up", duration: "standard" },
  ];
  const bySection = new Map<number, { section: Record<string, unknown>; nodes: Record<string, unknown> }>();
  let n = 0;
  for (const address of addresses) {
    const [head, ...rest] = address.split("/");
    const id = Number(head!.slice("section:".length));
    if (!bySection.has(id)) bySection.set(id, { section: { base: { entrance: "fade-up" } }, nodes: {} });
    if (!rest.length) continue;
    const path = rest.join("/");
    const isList = rest.length === 1 && addresses.some((other) => other.startsWith(`${address}/item:`));
    const branch = { ...ENTRANCES[n % ENTRANCES.length]!, ...(isList ? { entrance: "fade-up", stagger: "tight" } : {}) };
    bySection.get(id)!.nodes[path] = { base: branch, mobile: { duration: "fast" } };
    n += 1;
  }
  for (const [id, document] of bySection) {
    await sql`update page_sections set draft_motion_config = ${sql.json({ v: 1, ...document } as never)},
                                       draft_animation = 'fade-up'
               where id = ${id}`;
  }

  /* --- measure: with motion, then without --------------------------------- */
  const measure = async (withMotion: boolean) => {
    if (!withMotion) {
      await sql`update page_sections set draft_motion_config = null, draft_animation = null`;
    }
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([cookie]);
    await context.addInitScript(INSTRUMENT);
    const page: Page = await context.newPage();
    await page.goto(`${origin}/?preview=1`, { waitUntil: "load" });
    // Every script loaded and run before the first count (Batch 19A: was a fixed 1.5 s).
    await page.waitForLoadState("networkidle");
    const counts = await page.evaluate(() => ({
      reveal: document.querySelectorAll("[data-m-reveal]").length,
      group: document.querySelectorAll("[data-m-group]").length,
      member: document.querySelectorAll("[data-m-member]").length,
      legacy: document.querySelectorAll(".reveal").length,
    }));
    const before = await page.evaluate(() => ({ ...(window as unknown as { __m: Record<string, number> }).__m }));
    const stats0 = await page.evaluate(
      () => (window as unknown as { __eodMotion?: () => { observers: number; waiting: number } }).__eodMotion?.() ?? null,
    );
    const started = Date.now();
    for (let y = 0; y < 40; y += 1) {
      await page.mouse.wheel(0, 500);
      await page.waitForTimeout(120);
    }
    // Until every entrance the scroll reached has been released and has run to its end.
    await until(
      () =>
        page.evaluate(() => {
          const stats = (window as unknown as { __eodMotion?: () => { waiting: number } }).__eodMotion?.();
          const running = document
            .getAnimations()
            .filter((a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming().endTime as number)).length;
          return (stats?.waiting ?? 0) === 0 && running === 0;
        }),
      20_000,
    );
    const scrollMs = Date.now() - started;
    const after = await page.evaluate(() => ({ ...(window as unknown as { __m: Record<string, number> }).__m }));
    const stats1 = await page.evaluate(
      () => (window as unknown as { __eodMotion?: () => { observers: number; waiting: number } }).__eodMotion?.() ?? null,
    );
    const stuck = await page.locator("[data-m-reveal], [data-m-group] > *").evaluateAll((nodes) =>
      nodes.filter((node) => {
        const style = getComputedStyle(node);
        return !(style.opacity === "1" && style.translate === "none" && style.scale === "none" && style.filter === "none" && style.clipPath === "none");
      }).length,
    );
    await context.close();
    return { counts, before, after, stats0, stats1, stuck, scrollMs };
  };

  const heavy = await measure(true);
  const plain = await measure(false);
  console.log("   with motion   ", JSON.stringify(heavy));
  console.log("   without motion", JSON.stringify(plain));

  const motionNodes = heavy.counts.reveal + heavy.counts.group + heavy.counts.member;
  say("S1. the home page carries many motion nodes", motionNodes >= 60, `${motionNodes} (reveal ${heavy.counts.reveal}, lists ${heavy.counts.group}, rows ${heavy.counts.member})`);
  say(
    "S2. entrance observers: one, however many elements move",
    heavy.stats0?.observers === 1 && heavy.after.observers - plain.after.observers <= 0,
    `shared ${heavy.stats0?.observers}; page constructions with motion ${heavy.after.observers}, without ${plain.after.observers}`,
  );
  say("S3. every waiting element is released once reached", heavy.stats1?.waiting === 0, `${heavy.stats0?.waiting} waiting → ${heavy.stats1?.waiting}`);
  say("S4. none is left hidden, clipped, blurred or displaced", heavy.stuck === 0, `${heavy.stuck} stuck`);
  say(
    "S5. motion adds no scroll listener",
    heavy.after.scroll === plain.after.scroll,
    `with ${heavy.after.scroll}, without ${plain.after.scroll}`,
  );
  // Per second of the measured window, not in total (Batch 19A). The site's
  // own chrome runs frame loops of its own while the page scrolls — the stats
  // counters, the cursor companion — so both pages call for about one frame
  // callback per frame, and the totals move with how long each window lasted
  // and how fast the machine drew: locally the page with motion has always
  // come in lower (313 against 335), on a CI runner six higher (405 against
  // 399), against an allowance of five. A frame loop in motion would add a
  // callback on every frame — thirty a second even at 30 fps — so the rate,
  // with an allowance of ten a second, still catches one several times over.
  const rafRate = (m: typeof heavy) => (m.after.raf - m.before.raf) / (m.scrollMs / 1000);
  say(
    "S6. motion runs no frame loop: frame callbacks during the scroll do not grow with the nodes",
    rafRate(heavy) <= rafRate(plain) + 10,
    `with ${rafRate(heavy).toFixed(1)}/s (${heavy.after.raf - heavy.before.raf} in ${heavy.scrollMs} ms), without ${rafRate(plain).toFixed(1)}/s (${plain.after.raf - plain.before.raf} in ${plain.scrollMs} ms)`,
  );
  say(
    "S7. the only DOM write motion makes is one data-shown per observed element",
    heavy.after.otherMotionWrites === 0 && heavy.after.shownWrites - plain.after.shownWrites <= (heavy.stats0?.waiting ?? 0),
    `data-shown writes with ${heavy.after.shownWrites}, without ${plain.after.shownWrites}; other motion attribute writes ${heavy.after.otherMotionWrites}`,
  );
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
