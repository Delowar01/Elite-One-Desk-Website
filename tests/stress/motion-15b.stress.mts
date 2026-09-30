/**
 * Batch 15b §49 and §50: what parallax, hover and word reveal cost on a real
 * page, measured against the same page without them — and whether anything is
 * left behind by navigating between pages.
 *
 * Everything page code attaches is counted from before the first script runs:
 * scroll listeners, pointer listeners, frame callbacks, observers constructed,
 * elements observed. The parallax coordinator reports its own registry and its
 * per-frame reads and writes (`__eodParallax`).
 */
import type { Page } from "playwright";

import { callAction } from "../helpers/action";
import { giveFresh } from "../helpers/fixtures";
import { connect, dropDatabase } from "../helpers/pg";
import { startServer } from "../helpers/server";
import { signIn } from "../helpers/session";
import { launchChromium } from "../browser/harness";
import { quietFor } from "../browser/wait";
import { hoversFor, motionTargetFor } from "../../src/lib/visual-editor/motion-targets";

const PORT = 3804;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const INSTRUMENT = `
  window.__name = window.__name || ((fn) => fn);
  window.__m = { scrollAdd: 0, scrollRemove: 0, pointer: 0, raf: 0, ioNew: 0, ioObserve: 0, ioDisconnect: 0 };
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (type, ...rest) {
    if (type === "scroll" && (this === window || this === document)) window.__m.scrollAdd += 1;
    if (/^(pointer|mouse)(enter|over|move|leave|out)$/.test(type)) window.__m.pointer += 1;
    return add.call(this, type, ...rest);
  };
  EventTarget.prototype.removeEventListener = function (type, ...rest) {
    if (type === "scroll" && (this === window || this === document)) window.__m.scrollRemove += 1;
    return remove.call(this, type, ...rest);
  };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (callback) => { window.__m.raf += 1; return raf(callback); };
  const IO = window.IntersectionObserver;
  window.IntersectionObserver = class extends IO {
    constructor(...args) { super(...args); window.__m.ioNew += 1; }
    observe(target) { window.__m.ioObserve += 1; return super.observe(target); }
    disconnect() { window.__m.ioDisconnect += 1; return super.disconnect(); }
  };
`;

const browser = await launchChromium();
const database = giveFresh("motion_15b_stress");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);
  const origin = server.origin;
  const [name, value] = owner.cookie.split("=");
  const cookie = { name: name!, value: value!, domain: "127.0.0.1", path: "/" };
  await sql`create table eodt_stress_backup as select * from page_sections`;

  const publish = async (slug: string) => {
    const [page] = await sql<{ id: number; revision: number }[]>`select id, revision from pages where slug = ${slug}`;
    const form = new FormData();
    form.set("_csrf", owner.csrfToken);
    form.set("pageId", String(page!.id));
    form.set("expectedRevision", String(page!.revision));
    const result = await callAction<{ ok: boolean }>({
      origin,
      route: "/admin/visual-editor",
      file: "app/(backoffice)/admin/visual-editor/actions.ts",
      action: "publishPageFromEditor",
      args: [form],
      cookie: owner.cookie,
    });
    if (!result.value?.ok) throw new Error(`publish ${slug} failed`);
  };

  /** Every annotated node of a page, with the capability its block gives it. */
  const nodesOf = async (slug: string) => {
    const context = await browser.newContext();
    await context.addCookies([cookie]);
    const page = await context.newPage();
    const path = slug === "home" ? "/" : `/${slug}`;
    await page.goto(`${origin}${path}?preview=1&editor=1&bridge=0123456789abcdef0123456789abcdef`, { waitUntil: "load" });
    const addresses = await page.evaluate(() =>
      [...document.querySelectorAll("[data-eod-address]")].map((node) => node.getAttribute("data-eod-address")!),
    );
    await context.close();
    const sections = await sql<{ id: number; block_type: string }[]>`
      select s.id, s.block_type from page_sections s join pages p on p.id = s.page_id where p.slug = ${slug}`;
    const blockOf = new Map(sections.map((section) => [section.id, section.block_type]));
    return addresses
      .map((address) => {
        const [head, ...rest] = address.split("/");
        const id = Number(head!.slice(8));
        return { id, relative: rest.join("/"), capability: motionTargetFor(blockOf.get(id)!, rest.join("/") || "root") };
      })
      .filter((node) => node.relative && node.capability.kind !== null);
  };

  /** One configuration of one page, published: words, hover and parallax wherever each is offered. */
  const configure = async (slug: string, keys: { words?: boolean; hover?: boolean; parallax?: boolean }) => {
    await sql`delete from page_sections where page_id = (select id from pages where slug = ${slug})`;
    await sql`insert into page_sections select * from eodt_stress_backup where page_id = (select id from pages where slug = ${slug})`;
    const documents = new Map<number, { v: number; section: object; nodes: Record<string, object> }>();
    for (const node of await nodesOf(slug)) {
      const fields = node.capability.fields as readonly string[];
      const branch: Record<string, string> = {};
      if (keys.words && fields.includes("textReveal")) branch.textReveal = "words";
      const hover = hoversFor(node.capability)[1];
      if (keys.hover && hover) branch.hover = hover;
      if (keys.parallax && fields.includes("parallax")) branch.parallax = "medium";
      if (!Object.keys(branch).length) continue;
      const document = documents.get(node.id) ?? { v: 1, section: {}, nodes: {} };
      document.nodes[node.relative] = { base: branch };
      documents.set(node.id, document);
    }
    for (const [id, document] of documents) {
      await sql`update page_sections set draft_motion_config = ${sql.json(document as never)}, draft_animation = 'fade-up' where id = ${id}`;
    }
    // The restored rows are already the published baseline; only a document
    // needs publishing.
    if (documents.size) await publish(slug);
  };

  type Counts = Record<string, number>;
  const measure = async (path: string) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addInitScript(INSTRUMENT);
    const page: Page = await context.newPage();
    await page.goto(`${origin}${path}`, { waitUntil: "load" });
    // Every script loaded and run before the first count (Batch 19A: was a fixed 1.5 s).
    await page.waitForLoadState("networkidle");
    const loaded = await page.evaluate(() => ({ ...(window as unknown as { __m: Counts }).__m }));
    const rafBefore = loaded.raf;
    for (let y = 0; y < 30; y += 1) {
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(60);
    }
    await quietFor(page, 1200, "counted over a fixed window, the same for every page compared: the scroll's tail");
    const scrolled = await page.evaluate(() => ({ ...(window as unknown as { __m: Counts }).__m }));
    // Idle: no scrolling at all for two seconds.
    await quietFor(page, 2000, "the idle window the idle counts are measured over");
    const idle = await page.evaluate(() => ({ ...(window as unknown as { __m: Counts }).__m }));
    const stats = await page.evaluate(() => (window as unknown as { __eodParallax?: () => Counts }).__eodParallax?.() ?? null);
    const dom = await page.evaluate(() => ({
      px: document.querySelectorAll("[data-m-px]").length,
      hv: document.querySelectorAll("[data-m-hv]").length,
      wordParents: document.querySelectorAll("[data-m-words]").length,
      words: document.querySelectorAll("[data-m-w]").length,
      reveal: document.querySelectorAll("[data-m-reveal]").length,
    }));
    await context.close();
    return { loaded, scrolled, idle, stats, dom, scrollRaf: scrolled.raf - rafBefore, idleRaf: idle.raf - scrolled.raf };
  };

  /* --- baseline: the About page with no motion document at all --------- */
  await configure("about", {});
  const base = await measure("/about");
  console.log("   baseline", JSON.stringify(base));

  /* --- parallax only --------------------------------------------------- */
  await configure("about", { parallax: true });
  const drift = await measure("/about");
  console.log("   parallax", JSON.stringify(drift));
  say("P1. parallax adds exactly one scroll listener, however many elements drift", drift.scrolled.scrollAdd - base.scrolled.scrollAdd === 1, `${drift.dom.px} drifting; scroll listeners ${base.scrolled.scrollAdd} → ${drift.scrolled.scrollAdd}`);
  say("P2. one coordinator: one active-set observer, each drifting element observed once", drift.scrolled.ioNew - base.scrolled.ioNew === 1 && drift.stats !== null && drift.stats.registered === drift.dom.px, `${JSON.stringify(drift.stats)}`);
  const perFrameReads = drift.stats ? drift.stats.rectReads / Math.max(1, drift.stats.frames) : 0;
  const perFrameWrites = drift.stats ? drift.stats.writes / Math.max(1, drift.stats.frames) : 0;
  say(
    "P3. per frame: at most one read per active element and one write per element that moved",
    !!drift.stats && drift.stats.peakFrameReads <= drift.stats.registered && perFrameReads <= drift.stats.peakFrameReads && perFrameWrites <= drift.stats.peakFrameReads,
    `rect reads/frame ${perFrameReads.toFixed(2)} (busiest frame ${drift.stats?.peakFrameReads}), writes/frame ${perFrameWrites.toFixed(2)}, style reads ${drift.stats?.styleReads} (registration and resize only), active ${drift.stats?.active} of ${drift.stats?.registered}`,
  );
  say("P4. idle means idle: no frames while nothing scrolls", drift.idleRaf - base.idleRaf <= 2 && drift.stats?.framePending === 0, `idle rAF ${base.idleRaf} → ${drift.idleRaf}`);
  say("P5. no parallax, no parallax work: the module is not even loaded", base.stats === null && base.scrolled.scrollAdd === drift.scrolled.scrollAdd - 1);

  /* --- words only ------------------------------------------------------ */
  await configure("about", { words: true });
  const words = await measure("/about");
  console.log("   words", JSON.stringify(words));
  say(
    "P6. word reveal: one observation per text, never per word",
    words.dom.wordParents > 0 && words.scrolled.ioObserve - base.scrolled.ioObserve === words.dom.wordParents,
    `${words.dom.wordParents} texts, ${words.dom.words} words, observations ${base.scrolled.ioObserve} → ${words.scrolled.ioObserve}`,
  );
  say("P7. words add no scroll listener and no frame loop", words.scrolled.scrollAdd === base.scrolled.scrollAdd && words.idleRaf - base.idleRaf <= 2, `${words.scrolled.scrollAdd} ${words.idleRaf}`);

  /* --- hover only ------------------------------------------------------ */
  await configure("about", { hover: true });
  const hover = await measure("/about");
  console.log("   hover", JSON.stringify(hover));
  say(
    "P8. hover is CSS: no listener, no observer, no frame",
    hover.dom.hv > 0 && hover.scrolled.pointer === base.scrolled.pointer && hover.scrolled.ioObserve === base.scrolled.ioObserve && hover.scrolled.scrollAdd === base.scrolled.scrollAdd,
    `${hover.dom.hv} hovering elements; pointer listeners ${base.scrolled.pointer} → ${hover.scrolled.pointer}`,
  );

  /* --- the editor's canvas: no live loop -------------------------------- */
  await configure("about", { parallax: true, words: true, hover: true });
  const canvasMeasure = async () => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await context.addCookies([cookie]);
    await context.addInitScript(INSTRUMENT);
    const page = await context.newPage();
    await page.goto(`${origin}/about?preview=1&editor=1&bridge=0123456789abcdef0123456789abcdef`, { waitUntil: "load" });
    await page.waitForLoadState("networkidle");
    const before = await page.evaluate(() => (window as unknown as { __m: Counts }).__m.raf);
    for (let y = 0; y < 20; y += 1) {
      await page.mouse.wheel(0, 300);
      await page.waitForTimeout(60);
    }
    await quietFor(page, 1000, "counted over a fixed window, the same for the heavy and the plain canvas");
    const after = await page.evaluate(() => ({ ...(window as unknown as { __m: Counts }).__m }));
    const runtime = await page.evaluate(() => typeof (window as unknown as { __eodParallax?: unknown }).__eodParallax);
    const written = await page.locator("[data-m-px]").evaluateAll((nodes) => nodes.filter((node) => (node as HTMLElement).style.getPropertyValue("--m-py")).length);
    await context.close();
    return { raf: after.raf - before, scroll: after.scrollAdd, module: runtime, written };
  };
  const editorHeavy = await canvasMeasure();
  await configure("about", {});
  const editorPlain = await canvasMeasure();
  console.log("   canvas", JSON.stringify({ editorHeavy, editorPlain }));
  say(
    "P9. the editor's canvas runs no live parallax loop: same frames and listeners with or without parallax",
    editorHeavy.module === "undefined" && editorHeavy.written === 0 && editorHeavy.scroll === editorPlain.scroll && editorHeavy.raf <= editorPlain.raf + 5,
    JSON.stringify({ editorHeavy, editorPlain }),
  );

  /* --- §50: navigate back and forth; nothing accumulates --------------- */
  await configure("about", { parallax: true, words: true, hover: true });
  await configure("home", { parallax: true, words: true, hover: true });
  const nav = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await nav.addInitScript(INSTRUMENT);
  const np = await nav.newPage();
  const errors: string[] = [];
  np.on("pageerror", (error) => errors.push(error.message));
  await np.goto(`${origin}/`, { waitUntil: "load" });
  await np.waitForLoadState("networkidle");
  const trail: string[] = [];
  let consistent = true;
  for (let round = 0; round < 10; round += 1) {
    for (const target of ["/about", "/"]) {
      await np.evaluate((href) => {
        const link = [...document.querySelectorAll("a")].find((a) => a.getAttribute("href") === href) as HTMLAnchorElement | undefined;
        if (!link) throw new Error(`no link to ${href}`);
        link.click();
      }, target);
      await np.waitForURL((url) => url.pathname === target, { timeout: 20_000 });
      // The client navigation's payload fetched and the new page's motion
      // registered — nothing on the network, then two frames.
      await np.waitForLoadState("networkidle");
      await np.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const state = await np.evaluate(() => {
        const m = (window as unknown as { __m: Counts }).__m;
        const stats = (window as unknown as { __eodParallax?: () => Counts }).__eodParallax?.() ?? null;
        return {
          px: document.querySelectorAll("[data-m-px]").length,
          registered: stats?.registered ?? 0,
          listening: stats?.listening ?? 0,
          netScroll: m.scrollAdd - m.scrollRemove,
          observers: m.ioNew - m.ioDisconnect,
        };
      });
      if (state.registered !== state.px) consistent = false;
      trail.push(`${target}:${state.px}/${state.registered}/${state.netScroll}/${state.observers}`);
    }
  }
  const first = trail[1]!.split(":")[1]!.split("/");
  const last = trail.at(-1)!.split(":")[1]!.split("/");
  console.log("   navigation trail (path:drifting/registered/net scroll listeners/live observers)", trail.join(" "));
  say("P10. every navigation registers exactly the page's drifting elements, and unregisters the last page's", consistent);
  say("P11. twenty navigations later there are no more scroll listeners than after the first two", Number(last[2]) <= Number(first[2]), `${first[2]} → ${last[2]}`);
  say("P12. …and no more live observers", Number(last[3]) <= Number(first[3]) + 1, `${first[3]} → ${last[3]}`);
  say("P13. …and no page errors", errors.length === 0, errors.join(" | "));
  await nav.close();
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
