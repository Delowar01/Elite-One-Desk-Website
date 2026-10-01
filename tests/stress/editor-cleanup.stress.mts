/**
 * Batch 19B stress (§33): the editor cleans up after itself.
 *
 * The editor shell is one long-lived document: page switches, canvas reloads,
 * Replays and the component drawer all come and go inside it, so anything one
 * of them leaves behind — an observer never disconnected, a listener on the
 * window never removed, a frame loop or an interval still running — piles up
 * for as long as the editor is open. The canvas is the opposite case, a new
 * document every reload, and so is the comparison screen, which is measured on
 * its own page.
 *
 * An init script counts, in the top document only, what is live: observers
 * constructed and not disconnected, window/document listeners added and not
 * removed (`once` and `signal` listeners are followed to their end), frames
 * requested and not yet run, intervals set and not cleared. Each operation is
 * done once to warm up, measured, done LOOPS more times and measured again.
 * Nothing it starts may still be counted when it is over.
 *
 *   K1  page switches leave nothing behind
 *   K2  canvas reloads leave nothing behind
 *   K3  Replay, a parallax sweep included, leaves nothing behind — and no replay running
 *   K4  the reusable component drawer, opened and closed, leaves nothing behind
 *   K5  Version Compare, switching widths and languages, leaves nothing behind
 *   K6  at rest, nothing waits on a frame
 *   K7  no page errors in either screen
 *
 *   STRESS_LOOPS=6
 */
import type { Page } from "playwright";

import { canvasRedrawn, canvasUrl, editorSettled, selectFromLayers } from "../browser/canvas";
import { launchChromium } from "../browser/harness";
import { quietFor, until } from "../browser/wait";
import { callAction } from "../helpers/action";
import { giveFresh } from "../helpers/fixtures";
import { connect, dropDatabase } from "../helpers/pg";
import { startServer } from "../helpers/server";
import { signIn } from "../helpers/session";

import { linkSlot } from "@/lib/cms/reuse/reference";

const PORT = 3811;
const LOOPS = Number(process.env.STRESS_LOOPS ?? 6);
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

/** What is live in the top document. Installed before any page script runs. */
const COUNTERS = `
  if (window === window.top && !window.__eodLive) {
    const live = {
      observers: { IntersectionObserver: 0, ResizeObserver: 0, MutationObserver: 0 },
      listeners: new Map(),
      frames: new Set(),
      intervals: new Set(),
    };
    window.__eodLive = live;
    for (const name of Object.keys(live.observers)) {
      const Base = window[name];
      if (!Base) continue;
      window[name] = class extends Base {
        constructor(...args) { super(...args); live.observers[name] += 1; this.__eodCounted = true; }
        disconnect() {
          if (this.__eodCounted) { this.__eodCounted = false; live.observers[name] -= 1; }
          return super.disconnect();
        }
      };
    }
    const keyOf = (target, type, capture) => (target === window ? "window " : "document ") + type + (capture ? " (capture)" : "");
    const captureOf = (options) => (typeof options === "boolean" ? options : Boolean(options && options.capture));
    const add = EventTarget.prototype.addEventListener;
    const remove = EventTarget.prototype.removeEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, options) {
      if ((this === window || this === document) && listener && !(options && typeof options === "object" && options.once)) {
        const key = keyOf(this, type, captureOf(options));
        if (!live.listeners.has(key)) live.listeners.set(key, new Set());
        const set = live.listeners.get(key);
        set.add(listener);
        const signal = options && typeof options === "object" ? options.signal : null;
        if (signal) signal.addEventListener("abort", () => set.delete(listener), { once: true });
      }
      return add.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function (type, listener, options) {
      if ((this === window || this === document) && listener) {
        const set = live.listeners.get(keyOf(this, type, captureOf(options)));
        if (set) set.delete(listener);
      }
      return remove.call(this, type, listener, options);
    };
    const raf = window.requestAnimationFrame.bind(window);
    const caf = window.cancelAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback) => {
      let id = 0;
      id = raf((time) => { live.frames.delete(id); callback(time); });
      live.frames.add(id);
      return id;
    };
    window.cancelAnimationFrame = (id) => { live.frames.delete(id); return caf(id); };
    const setI = window.setInterval.bind(window);
    const clearI = window.clearInterval.bind(window);
    window.setInterval = (...args) => { const id = setI(...args); live.intervals.add(id); return id; };
    window.clearInterval = (id) => { live.intervals.delete(id); return clearI(id); };
    window.__eodSnapshot = () => ({
      observers: Object.values(live.observers).reduce((n, v) => n + v, 0),
      byObserver: { ...live.observers },
      listeners: [...live.listeners.values()].reduce((n, set) => n + set.size, 0),
      byListener: Object.fromEntries([...live.listeners.entries()].filter(([, set]) => set.size).map(([key, set]) => [key, set.size])),
      frames: live.frames.size,
      intervals: live.intervals.size,
    });
  }
`;

type Snapshot = {
  observers: number;
  byObserver: Record<string, number>;
  listeners: number;
  byListener: Record<string, number>;
  frames: number;
  intervals: number;
};

const browser = await launchChromium();
const database = giveFresh("editor_cleanup_stress");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);
  const origin = server.origin;

  const [about] = await sql<{ id: number; revision: number }[]>`select id, revision from pages where slug = 'about'`;
  const rows = await sql<{ id: number; block_type: string; revision: number; published: Record<string, unknown> }[]>`
    select id, block_type, revision, published from page_sections where page_id = ${about!.id} and not is_draft_only order by position`;
  const byType = Object.fromEntries(rows.map((row) => [row.block_type, row])) as Record<string, (typeof rows)[number]>;
  const why = byType["why-us"]!;
  const cta = byType["final-cta"]!;

  // Something to replay: an entrance on the section and a drift on its points.
  await sql`update page_sections
               set draft_motion_config = ${sql.json({
                 v: 1,
                 section: { base: { entrance: "fade-up" } },
                 nodes: { "field:points": { base: { entrance: "fade-up", parallax: "medium" } } },
               } as never)},
                   draft_animation = 'fade-up'
             where id = ${why.id}`;

  // Something for the drawer to open: a published CTA, linked to the closing section.
  const form = (fields: Record<string, string | number>) => {
    const data = new FormData();
    data.set("_csrf", owner.csrfToken);
    for (const [key, value] of Object.entries(fields)) data.set(key, String(value));
    return data;
  };
  const act = async <T,>(file: string, route: string, action: string, fields: Record<string, string | number>) =>
    (await callAction<T>({ origin, route, file, action, args: [form(fields)], cookie: owner.cookie })).value;
  const created = await act<{ ok: boolean; component?: { id: number; kind: string; published: Record<string, unknown> } }>(
    "app/(backoffice)/admin/(shell)/components/actions.ts",
    "/admin/components",
    "createReusableComponent",
    { kind: "cta", name: "Cleanup CTA", values: JSON.stringify({ label: { en: "Talk to us", ar: "تحدث إلينا" }, href: "/contact" }), publish: "1" },
  );
  const component = created?.component;
  if (!component) throw new Error(`the component was not created: ${JSON.stringify(created)}`);
  const linked = linkSlot("final-cta", cta.published, "primaryCta", { id: component.id, kind: component.kind, values: component.published });
  const VE = "app/(backoffice)/admin/visual-editor/actions.ts";
  await act(VE, "/admin/visual-editor", "saveVisualSectionDraft", {
    sectionId: cta.id,
    pageId: about!.id,
    expectedRevision: cta.revision,
    values: JSON.stringify(linked),
  });
  // A published version of About, for the comparison to show.
  const [page0] = await sql<{ revision: number }[]>`select revision from pages where id = ${about!.id}`;
  await act(VE, "/admin/visual-editor", "publishPageFromEditor", { pageId: about!.id, expectedRevision: page0!.revision });
  const [version] = await sql<{ id: number }[]>`select id from page_versions where page_id = ${about!.id} order by id desc limit 1`;
  if (!version) throw new Error("no published version of About to compare");
  // The why-us motion was a draft; publishing took it live, so put it back as a draft for Replay.
  await sql`update page_sections
               set draft_motion_config = motion_config, draft_animation = 'fade-up'
             where id = ${why.id}`;

  const context = await browser.newContext({ viewport: { width: 1720, height: 1020 }, reducedMotion: "no-preference" });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
  await context.addInitScript({ content: "window.__name = window.__name || ((fn) => fn);" });
  await context.addInitScript({ content: COUNTERS });
  const errors: string[] = [];
  const watch = (page: Page) => page.on("pageerror", (error) => errors.push(error.message.slice(0, 160)));

  const snapshot = async (page: Page): Promise<Snapshot> => {
    await quietFor(page, 900, "whatever an operation started has had time to finish");
    return page.evaluate(() => (window as unknown as { __eodSnapshot: () => Snapshot }).__eodSnapshot());
  };
  /** What grew between two snapshots, by name; nothing at all is the answer wanted. */
  const growth = (a: Snapshot, b: Snapshot) => {
    const grew: string[] = [];
    for (const [key, n] of Object.entries(b.byObserver)) if (n > (a.byObserver[key] ?? 0)) grew.push(`${key} ${a.byObserver[key] ?? 0}→${n}`);
    for (const [key, n] of Object.entries(b.byListener)) if (n > (a.byListener[key] ?? 0)) grew.push(`${key} ${a.byListener[key] ?? 0}→${n}`);
    if (b.frames > a.frames) grew.push(`frames ${a.frames}→${b.frames}`);
    if (b.intervals > a.intervals) grew.push(`intervals ${a.intervals}→${b.intervals}`);
    return grew;
  };
  const measure = async (page: Page, label: string, operation: () => Promise<void>) => {
    await operation();
    const before = await snapshot(page);
    for (let i = 0; i < LOOPS; i += 1) await operation();
    const after = await snapshot(page);
    const grew = growth(before, after);
    say(`${label} — ${LOOPS} more times`, grew.length === 0,
      grew.length ? grew.join(", ") : `observers ${after.observers}, listeners ${after.listeners}, frames ${after.frames}, intervals ${after.intervals}`);
    return after;
  };

  /* ---------------------------------------------------------------------- */
  const editor = await context.newPage();
  watch(editor);
  await editor.goto(`${origin}/admin/visual-editor?page=about&lang=en&device=desktop`, { waitUntil: "load" });
  await editorSettled(editor, 60_000);

  await measure(editor, "K1. page switches leave nothing behind", async () => {
    await editor.selectOption("#ve-page", "home");
    await editorSettled(editor, 60_000);
    await editor.selectOption("#ve-page", "about");
    await editorSettled(editor, 60_000);
  });

  await measure(editor, "K2. canvas reloads leave nothing behind", async () => {
    const before = canvasUrl(editor);
    await editor.getByRole("button", { name: "Reload", exact: true }).click();
    await canvasRedrawn(editor, before);
    await editorSettled(editor, 60_000);
  });

  const replayStatus = async () => (await editor.locator("[data-replay-status]").getAttribute("data-replay-status")) ?? "";
  let replays = 0;
  let finished = 0;
  const after3 = await measure(editor, "K3. Replay, a parallax sweep included, leaves nothing behind", async () => {
    await selectFromLayers(editor, `section:${why.id}/field:points`).catch(async () => {
      await selectFromLayers(editor, `section:${why.id}`);
    });
    await editor.getByRole("tab", { name: /Motion/ }).click();
    const sweep = editor.locator('[data-replay-mode="parallax"]');
    const button = (await sweep.count()) ? sweep : editor.locator('[data-replay-mode="all"]');
    await until(async () => await button.isEnabled(), 15_000);
    await button.click();
    replays += 1;
    if (await until(async () => (await replayStatus()) === "finished", 20_000, 100)) finished += 1;
  });
  const replayArtefacts = await (async () => {
    const frame = editor.frames().find((candidate) => candidate.url().includes("editor=1"));
    return frame ? frame.locator("[data-eod-replay], [data-eod-replay-hover], [data-eod-replaying]").count() : -1;
  })();
  say("K3a. every Replay finished, and none is left running on the canvas",
    finished === replays && replayArtefacts === 0, `${finished}/${replays} finished; ${replayArtefacts} replay marks on the canvas`);

  await measure(editor, "K4. the reusable component drawer, opened and closed, leaves nothing behind", async () => {
    await selectFromLayers(editor, `section:${cta.id}`);
    await editor.getByRole("tab", { name: /Content/ }).click();
    await editor.locator("aside[aria-label='Inspector']").getByRole("button", { name: "Edit global component" }).first().click();
    const drawer = editor.locator("[data-reuse-drawer]");
    await drawer.waitFor({ timeout: 15_000 });
    await drawer.getByRole("button", { name: "Close" }).click();
    await drawer.waitFor({ state: "detached", timeout: 15_000 });
  });

  say("K6. at rest the editor waits on no frame", after3.frames <= 1, `${after3.frames} frame(s) pending`);
  await editor.close();

  /* ---------------------------------------------------------------------- */
  const compare = await context.newPage();
  watch(compare);
  await compare.goto(`${origin}/admin/compare?page=${about!.id}&version=${version.id}`, { waitUntil: "load" });
  await until(async () => compare.frames().filter((frame) => frame.url().includes("compare=")).length >= 2, 30_000, 200);
  const panesAt = async (part: string, count = 2) =>
    until(async () => compare.frames().filter((frame) => frame.url().includes(part)).length >= count, 30_000, 200);
  await measure(compare, "K5. Version Compare, switching widths and languages, leaves nothing behind", async () => {
    const widths = compare.getByRole("group", { name: "Width of both panes" });
    await widths.getByRole("button", { name: /Tablet/ }).click();
    await compare.waitForTimeout(700);
    await widths.getByRole("button", { name: /Desktop/ }).click();
    await compare.waitForTimeout(700);
    const languages = compare.getByRole("group", { name: "Language of both panes" });
    await languages.getByRole("button", { name: "العربية" }).click();
    await panesAt("/ar/about?compare=");
    await languages.getByRole("button", { name: "English" }).click();
    await until(async () => compare.frames().filter((frame) => frame.url().includes("/ar/about?compare=")).length === 0, 30_000, 200);
  });
  await compare.close();

  say("K7. no page errors in either screen", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
