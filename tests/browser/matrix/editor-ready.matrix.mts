/**
 * Batch 27 Correction 1 · the Visual Editor's "Ready", over and over.
 *
 * Twice on Next.js 16 a probe's editor never said "Ready" within 60 s, in full
 * runs of the suite only. This opens the editor again and again — every way an
 * editor reaches a canvas, on every kind of page, under four conditions — and
 * counts how many times "Ready" did not come, each one explained by the editor
 * watch (editor-watch.ts) the same way a probe's wait is.
 *
 *   READY_CONDITION=normal|load|public|editor  READY_OPENS=200  READY_SWITCHES=0
 *   node --import tsx tests/browser/matrix/editor-ready.matrix.mts
 *
 * Conditions:
 *
 *   normal  nothing else running.
 *   load    READY_HOGS busy loops (default 2) the whole time: moderate CPU
 *           contention, the server and the browser sharing what is left.
 *   public  three visitors reading the public pages the whole time — the
 *           server rendering for someone else while the canvas is asked for.
 *   editor  a second editor saving and redrawing another route the whole
 *           time, on the same server.
 *
 * Every open is one wait for "Ready" with the probes' own 60 s, timed from the
 * action that asked for the canvas, and it is one of these, in rotation — so
 * each condition covers each, on each page:
 *
 *   start     the first editor open after the server started (it is restarted
 *             for it, every READY_RESTART_EVERY opens and at the beginning)
 *   reopen    the same page navigated to the editor again
 *   direct    a new browser context, cold cache, straight to the editor
 *   admin     from the admin dashboard by the sidebar link — a client-side
 *             navigation into the editor, not a document load
 *   switch    another page or route chosen in the editor's own page picker
 *   save      a field edited and saved; the redraw that follows the save
 *   discard   saved changes discarded from the route's drawer; the redraw
 *   publish   saved changes published from the route's drawer; the redraw
 *
 * A redraw is waited for as a new canvas document — the frame's address
 * changes with every new bridge id — and then for "Ready"; a redraw that never
 * began is counted as a failure of its own, never as a Ready.
 *
 * on Home, About, Contact, /services, the travel-tourism, business-setup and
 * iqama-services categories and a service's own page, in English and in
 * Arabic, at Desktop and at Mobile. With READY_SWITCHES=n it then flips one
 * editor's canvas language n times each way (English → Arabic → English), each
 * flip a new canvas and a wait.
 *
 * Not a probe: the runner does not run it and it prints no PASS/FAIL — one
 * `matrix open` line per wait, one `matrix ready-hang` line per wait that ran
 * out, with the watch's verdict, and a `matrix summary`. Needs what the probes
 * need: a production build and `TEST_PG_URL`.
 */
import { spawn, type ChildProcess } from "node:child_process";

import type { BrowserContext, Page } from "playwright";

import { canvasUrl, editorIdle, selectFromLayers } from "../canvas";
import { recordedVerdicts } from "../editor-watch";
import { launchChromium } from "../harness";
import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer, type Server } from "../../helpers/server";
import { signIn } from "../../helpers/session";

const CONDITION = (process.env.READY_CONDITION ?? "normal") as "normal" | "load" | "public" | "editor";
const OPENS = Math.max(0, Number(process.env.READY_OPENS ?? 200));
const SWITCHES = Math.max(0, Number(process.env.READY_SWITCHES ?? 0));
const HOGS = Math.max(0, Number(process.env.READY_HOGS ?? (CONDITION === "load" ? 2 : 0)));
const RESTART_EVERY = Math.max(1, Number(process.env.READY_RESTART_EVERY ?? 50));
const PORT = Number(process.env.READY_PORT ?? 3745);
/** The probes' own wait. */
const READY_MS = 60_000;
if (!["normal", "load", "public", "editor"].includes(CONDITION)) {
  throw new Error(`READY_CONDITION must be normal, load, public or editor, not ${CONDITION}`);
}

type Mode = "start" | "reopen" | "direct" | "admin" | "switch" | "save" | "discard" | "publish";
const MODES: Mode[] = ["reopen", "direct", "admin", "switch", "save", "discard", "publish"];
type Open = {
  n: number;
  mode: Mode;
  target: string;
  lang: "en" | "ar";
  device: "desktop" | "mobile";
  ms: number | null;
  ready: boolean;
  verdict: string | null;
  skipped?: string;
};

const browser = await launchChromium();
const database = giveFresh(`editor_ready_${CONDITION}`);
const sql = connect(database);
let server: Server | undefined;
const hogs: ChildProcess[] = [];
let stop = false;
const background: Promise<unknown>[] = [];
const contexts: BrowserContext[] = [];
/** The editor under test's own context — one at a time, so editors do not pile up in the browser. */
let current: BrowserContext | null = null;

try {
  const owner = await signIn(sql);
  const [name, value] = owner.cookie.split("=");
  const id = async (query: Promise<{ id: number }[]>) => (await query)[0]!.id;
  const category = (slug: string) => id(sql`select id from service_categories where slug = ${slug}`);
  const service = await id(sql`
    select s.id from services s join service_categories c on c.id = s.category_id
     where s.is_published and c.is_published order by s.id limit 1`);
  /** What the editor's address and its page picker call each target. */
  const targets = [
    { query: "page=home", pick: "home" },
    { query: "page=about", pick: "about" },
    { query: "page=contact", pick: "contact" },
    { query: "route=serviceIndex:1", pick: "serviceIndex:1" },
    { query: `route=category:${await category("travel-tourism")}`, pick: `category:${await category("travel-tourism")}` },
    { query: `route=category:${await category("business-setup")}`, pick: `category:${await category("business-setup")}` },
    { query: `route=category:${await category("iqama-services")}`, pick: `category:${await category("iqama-services")}` },
    { query: `route=service:${service}`, pick: `service:${service}` },
  ];

  const start = async () => {
    await server?.stop();
    server = await startServer(database, PORT);
  };
  await start();
  for (let i = 0; i < HOGS; i += 1) hogs.push(spawn("sh", ["-c", "while :; do :; done"], { stdio: "ignore" }));

  const context = async () => {
    const created = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
    contexts.push(created);
    await created.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
    return created;
  };
  const editorUrl = (query: string, lang: string, device: string) =>
    `${server!.origin}/admin/visual-editor?${query}&lang=${lang}&device=${device}`;
  /** A new page in a new context for the editor under test; the previous context goes. */
  const freshPage = async () => {
    await current?.close().catch(() => undefined);
    current = await context();
    const created = await current.newPage();
    created.on("dialog", (dialog) => void dialog.accept());
    return created;
  };
  /** Until the canvas on screen is no longer the document `before` names — the redraw has begun. */
  const redrawFrom = async (page: Page, before: string, timeoutMs = 30_000) => {
    const deadline = Date.now() + timeoutMs;
    while (canvasUrl(page) === before) {
      if (Date.now() > deadline) return false;
      await page.waitForTimeout(25);
    }
    return true;
  };
  const noRedraw = { ms: null, ready: false, verdict: "no redraw: the canvas was not replaced within 30 s" } as const;

  /** One wait for Ready, timed, and what the watch said when it did not come. */
  const wait = async (page: Page, since: number): Promise<Pick<Open, "ms" | "ready" | "verdict">> => {
    const before = recordedVerdicts().length;
    try {
      await page.getByText("Ready", { exact: true }).waitFor({ timeout: READY_MS });
      return { ms: Date.now() - since, ready: true, verdict: null };
    } catch {
      const verdict = recordedVerdicts().length > before ? recordedVerdicts().at(-1)! : null;
      return { ms: null, ready: false, verdict: verdict ? `${verdict.category}: ${verdict.reason}` : "no verdict" };
    }
  };

  /* --- the background ------------------------------------------------------- */
  let visits = 0;
  if (CONDITION === "public") {
    const paths = ["/", "/services", "/services/travel-tourism", "/packages", "/about", "/ar", "/ar/services", "/contact"];
    for (let worker = 0; worker < 3; worker += 1) {
      background.push(
        (async () => {
          for (let n = worker; !stop; n += 1) {
            try {
              const response = await fetch(`${server!.origin}${paths[n % paths.length]}`);
              await response.arrayBuffer();
              visits += 1;
            } catch {
              // a restart in progress; the next request finds the new server
            }
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
        })(),
      );
    }
  }
  let otherSaves = 0;
  if (CONDITION === "editor") {
    const other = await (await context()).newPage();
    other.on("dialog", (dialog) => void dialog.accept());
    background.push(
      (async () => {
        while (!stop) {
          try {
            await other.goto(editorUrl("route=packageIndex:1", "en", "desktop"), { waitUntil: "load" });
            await other.getByText("Ready", { exact: true }).waitFor({ timeout: READY_MS });
            await selectFromLayers(other, "packageIndexHero:1", 30_000);
            const input = other.locator("aside[aria-label='Inspector'] [data-field='heading'] input").first();
            for (let i = 0; i < 10 && !stop; i += 1) {
              await input.fill(`Second editor ${otherSaves + 1}`);
              await editorIdle(other, 60_000);
              otherSaves += 1;
            }
          } catch {
            // a restart in progress; start again
          }
        }
      })(),
    );
  }

  /* --- the opens ------------------------------------------------------------ */
  const opens: Open[] = [];
  let page: Page | null = null;
  let lastTarget = 0;
  const record = (open: Open) => {
    opens.push(open);
    console.log(
      `matrix open ${open.n}/${OPENS} ${CONDITION} ${open.mode} ${open.target} ${open.lang} ${open.device} ` +
        (open.skipped ? `skipped: ${open.skipped}` : open.ready ? `${open.ms}ms` : `NOT READY — ${open.verdict}`),
    );
    if (!open.ready && !open.skipped) console.log(`matrix ready-hang ${JSON.stringify(open)}`);
  };

  for (let n = 1; n <= OPENS; n += 1) {
    const restart = n === 1 || (n - 1) % RESTART_EVERY === 0;
    const mode: Mode = restart ? "start" : MODES[(n - 2) % MODES.length]!;
    const index = (n - 1) % targets.length;
    const target = targets[index]!;
    const lang = Math.floor((n - 1) / targets.length) % 2 === 0 ? "en" : "ar";
    const device = Math.floor((n - 1) / (targets.length * 2)) % 2 === 0 ? "desktop" : "mobile";
    const base = { n, mode, target: target.query, lang, device } as const;
    try {
      if (mode === "start") {
        await start();
        page = await freshPage();
        const since = Date.now();
        await page.goto(editorUrl(target.query, lang, device), { waitUntil: "load" });
        record({ ...base, ...(await wait(page, since)) });
      } else if (mode === "direct" || !page) {
        page = await freshPage();
        const since = Date.now();
        await page.goto(editorUrl(target.query, lang, device), { waitUntil: "load" });
        record({ ...base, mode: "direct", ...(await wait(page, since)) });
      } else if (mode === "reopen") {
        const since = Date.now();
        await page.goto(editorUrl(target.query, lang, device), { waitUntil: "load" });
        record({ ...base, ...(await wait(page, since)) });
      } else if (mode === "admin") {
        await page.goto(`${server!.origin}/admin`, { waitUntil: "load" });
        const link = page.locator('a[href="/admin/visual-editor"]').first();
        const since = Date.now();
        await link.click({ timeout: 20_000 });
        await page.waitForURL(/\/admin\/visual-editor/, { timeout: 30_000 });
        record({ ...base, target: "page=home (sidebar)", lang: "en", device: "desktop", ...(await wait(page, since)) });
      } else if (mode === "switch") {
        await page.goto(editorUrl(targets[lastTarget]!.query, lang, device), { waitUntil: "load" });
        await page.getByText("Ready", { exact: true }).waitFor({ timeout: READY_MS });
        const before = canvasUrl(page);
        const since = Date.now();
        await page.selectOption("#ve-page", target.pick);
        record({ ...base, ...((await redrawFrom(page, before)) ? await wait(page, since) : noRedraw) });
      } else {
        // save, discard, publish — on the services overview's hero, which every condition may write to
        await page.goto(editorUrl("route=serviceIndex:1", lang, device), { waitUntil: "load" });
        await page.getByText("Ready", { exact: true }).waitFor({ timeout: READY_MS });
        await selectFromLayers(page, "serviceIndexHero:1", 30_000);
        const input = page.locator("aside[aria-label='Inspector'] [data-field='heading'] input").first();
        let before = canvasUrl(page);
        let since = Date.now();
        await input.fill(`Matrix ${CONDITION} ${n}`);
        if (mode !== "save") {
          // The save's own redraw first; then the drawer, and the action's.
          await editorIdle(page, 60_000);
          const panel = page.locator("[data-route-panel]");
          if ((await panel.count()) === 0) await page.getByRole("button", { name: /^Publish$/ }).click();
          await panel.waitFor({ timeout: 10_000 });
          const button = panel.locator(mode === "discard" ? "[data-route-discard]" : "[data-route-publish]");
          if (!(await button.isEnabled({ timeout: 10_000 }).catch(() => false))) {
            record({ ...base, target: "route=serviceIndex:1", ms: null, ready: false, verdict: null, skipped: `${mode} not offered` });
            continue;
          }
          before = canvasUrl(page);
          since = Date.now();
          await button.click();
        }
        record({ ...base, target: "route=serviceIndex:1", ...((await redrawFrom(page, before)) ? await wait(page, since) : noRedraw) });
        await editorIdle(page, 60_000);
      }
    } catch (error) {
      record({ ...base, ms: null, ready: false, verdict: `step failed: ${String(error).split("\n")[0]!.slice(0, 200)}` });
    }
    lastTarget = index;
  }

  /* --- language flips ------------------------------------------------------- */
  const flips: Open[] = [];
  if (SWITCHES) {
    page = await freshPage();
    await page.goto(editorUrl("page=about", "en", "desktop"), { waitUntil: "load" });
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: READY_MS });
    const languages = page.getByRole("group", { name: "Canvas language" });
    for (let n = 1; n <= SWITCHES; n += 1) {
      for (const [lang, label] of [["ar", "العربية"], ["en", "English"]] as const) {
        const target = targets[n % targets.length]!;
        const where = n % 2 === 0 && lang === "ar" ? target.query : "previous";
        try {
          if (where !== "previous") {
            // every other cycle on another resource, chosen in the picker first
            const before = canvasUrl(page);
            await page.selectOption("#ve-page", target.pick);
            if (await redrawFrom(page, before)) await page.getByText("Ready", { exact: true }).waitFor({ timeout: READY_MS });
          }
          const before = canvasUrl(page);
          const since = Date.now();
          await languages.getByRole("button", { name: label }).click();
          const result = (await redrawFrom(page, before)) ? await wait(page, since) : noRedraw;
          const open: Open = { n, mode: "switch", target: where, lang, device: "desktop", ...result };
          flips.push(open);
          console.log(`matrix flip ${n}/${SWITCHES} ${lang} ${where} ${result.ready ? `${result.ms}ms` : `NOT READY — ${result.verdict}`}`);
          if (!result.ready) console.log(`matrix ready-hang ${JSON.stringify(open)}`);
        } catch (error) {
          const open: Open = { n, mode: "switch", target: where, lang, device: "desktop", ms: null, ready: false, verdict: `step failed: ${String(error).split("\n")[0]!.slice(0, 200)}` };
          flips.push(open);
          console.log(`matrix flip ${n}/${SWITCHES} ${lang} ${where} NOT READY — ${open.verdict}`);
          console.log(`matrix ready-hang ${JSON.stringify(open)}`);
        }
      }
    }
  }

  stop = true;
  await Promise.allSettled(background);
  const counted = opens.filter((open) => !open.skipped);
  const times = [...counted, ...flips].filter((open) => open.ready).map((open) => open.ms!).sort((a, b) => a - b);
  const pct = (p: number) => (times.length ? times[Math.min(times.length - 1, Math.floor((p / 100) * times.length))] : null);
  const by = (key: keyof Open) =>
    Object.fromEntries(
      [...new Set(counted.map((open) => String(open[key])))].map((k) => [k, counted.filter((open) => String(open[key]) === k).length]),
    );
  const summary = {
    condition: CONDITION,
    hogs: HOGS,
    opens: counted.length,
    skipped: opens.length - counted.length,
    ready: counted.filter((open) => open.ready).length,
    notReady: counted.filter((open) => !open.ready).map((open) => ({ n: open.n, mode: open.mode, target: open.target, lang: open.lang, verdict: open.verdict })),
    flips: flips.length,
    flipsReady: flips.filter((open) => open.ready).length,
    flipsNotReady: flips.filter((open) => !open.ready).map((open) => ({ n: open.n, lang: open.lang, verdict: open.verdict })),
    byMode: by("mode"),
    byTarget: by("target"),
    byLang: by("lang"),
    byDevice: by("device"),
    msToReady: { p50: pct(50), p90: pct(90), p99: pct(99), max: times.at(-1) ?? null },
    visits,
    otherSaves,
    serverAlive: server?.exit() === null,
  };
  console.log(`matrix summary ${JSON.stringify(summary)}`);
} finally {
  stop = true;
  for (const hog of hogs) hog.kill("SIGKILL");
  await Promise.allSettled(background);
  for (const context of contexts) await context.close().catch(() => undefined);
  await browser.close();
  await server?.stop();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
