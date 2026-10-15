/**
 * Why the Visual Editor did not say "Ready" (Batch 27 Correction 1).
 *
 * Twice on Next.js 16, in full runs of the suite only, a probe waited 60 s for
 * the editor's "Ready" and was told nothing but that the time had run out.
 * This file is what answers the question next time, in the job log, for every
 * wait on "Ready" in every probe and stress script — without any of them
 * changing:
 *
 *   · `watchBrowser` (called by `launchChromium`) records, for every context
 *     the browser opens, its requests and how each ended, console errors, page
 *     errors, frame attach/navigate/detach and page crashes. Bounded; it only
 *     listens.
 *   · A wait on `getByText("Ready", { exact: true })` that times out stops
 *     before it rethrows and runs `explainEditorHang`: the status line, every
 *     frame and its document state, both readiness timelines (the editor's and
 *     the canvas's, recorded by the app when the test server runs with
 *     EOD_EDITOR_DIAGNOSTICS=1 — lib/visual-editor/diagnostics.ts), what the
 *     network still has open, the server's `[eod-diag]` lines and failures,
 *     the probe database's activity and locks, and screenshots.
 *   · `classify` turns that into one of ten answers, A–J below, with the
 *     evidence that decided it. It prints `diag editor-ready …` lines, which
 *     the runner copies into the job log for a script that failed, writes the
 *     whole record under `.data/test/results/diag/`, and appends the verdict
 *     to the timeout's own message. The wait still fails exactly as before:
 *     nothing here waits longer, retries or turns a failure into a pass.
 *
 *   A  the server did not answer (no response to the document request)
 *   B  the editor rendered but its canvas frame never navigated
 *   C  the frame navigated but the preview failed (error status, wrong
 *      document, or a page rendered without the editor canvas)
 *   D  the preview loaded but its editor bridge never started
 *   E  the bridge started but "Ready" never reached the editor
 *   F  a resource the frame waits for never finished, so its load never fired
 *   G  a document's stream never ended (a Suspense boundary held it open)
 *   H  a database query stayed pending (a lock wait, a long query, an open
 *      transaction)
 *   I  the editor was Ready and the wait did not see it
 *   J  the browser, the page or the frame itself failed
 *
 * Each answer is shown by `editor-diagnostics.probe.mts`, which causes every
 * one of them on purpose and checks this file names it.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import postgres from "postgres";
import type { Browser, BrowserContext, Frame, Locator, Page, Request } from "playwright";

import { PG_BASE, REPO_ROOT } from "../helpers/env";
import { serverFailureLines } from "../helpers/diagnostics";
import { runningServers } from "../helpers/server";

export type Category = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "U";

export const CATEGORY: Record<Category, string> = {
  A: "the server did not answer",
  B: "the editor never put its canvas frame on a document",
  C: "the canvas navigated but the preview failed",
  D: "the preview loaded but its editor bridge never started",
  E: "the bridge started but Ready never reached the editor",
  F: "a resource the canvas waits for never finished loading",
  G: "a document stream never ended",
  H: "a database query stayed pending",
  I: "the editor was Ready and the wait did not see it",
  J: "the browser, page or frame failed",
  U: "not classified",
};

/* -------------------------------------------------------------------------- */
/* Watching                                                                   */
/* -------------------------------------------------------------------------- */

type Net = {
  url: string;
  method: string;
  type: string;
  navigation: boolean;
  /** Whether the request belongs to the main frame of its page. */
  main: boolean;
  /** The canvas document: a navigation carrying `editor=1`. */
  canvas: boolean;
  page: Page | null;
  started: number;
  status?: number;
  responded?: number;
  finished?: number;
  failed?: string;
};

type Watch = {
  pending: Map<Request, Net>;
  done: Net[];
  documents: Net[];
  console: { at: number; page: Page; type: string; text: string }[];
  pageErrors: { at: number; page: Page; text: string }[];
  frames: { at: number; page: Page; event: string; url: string }[];
  crashes: { at: number; page: Page }[];
};

const KEPT = 400;

/**
 * This file's state lives on `globalThis`, for the reason `runningServers`
 * does (helpers/server.ts): tsx can load a test file twice, and a second copy
 * must find the first one's watches rather than start its own — or wrap
 * `waitFor` a second time.
 */
const shared = globalThis as unknown as {
  __eodEditorWatch?: { watches: WeakMap<BrowserContext, Watch>; patched: boolean; verdicts: Verdict[] };
};
const state = (shared.__eodEditorWatch ??= { watches: new WeakMap(), patched: false, verdicts: [] });
const watches = state.watches;
const keep = <T>(list: T[], item: T, limit = KEPT) => {
  list.push(item);
  if (list.length > limit) list.splice(0, list.length - limit);
};
const isCanvasUrl = (url: string) => /[?&]editor=1(?:&|$)/.test(url) && /[?&]bridge=/.test(url);

function watchContext(context: BrowserContext): Watch {
  const existing = watches.get(context);
  if (existing) return existing;
  const watch: Watch = { pending: new Map(), done: [], documents: [], console: [], pageErrors: [], frames: [], crashes: [] };
  watches.set(context, watch);

  context.on("request", (request) => {
    let frame: Frame | null = null;
    try {
      frame = request.frame();
    } catch {
      // A service worker's request belongs to no frame.
    }
    const net: Net = {
      url: request.url(),
      method: request.method(),
      type: request.resourceType(),
      navigation: request.isNavigationRequest(),
      main: Boolean(frame && frame.parentFrame() === null),
      canvas: request.isNavigationRequest() && isCanvasUrl(request.url()),
      page: frame ? frame.page() : null,
      started: Date.now(),
    };
    watch.pending.set(request, net);
    if (net.navigation) keep(watch.documents, net, 60);
  });
  context.on("response", (response) => {
    const net = watch.pending.get(response.request());
    if (!net) return;
    net.status = response.status();
    net.responded = Date.now();
  });
  const settle = (request: Request, failure?: string) => {
    const net = watch.pending.get(request);
    if (!net) return;
    watch.pending.delete(request);
    if (failure === undefined) net.finished = Date.now();
    else net.failed = failure;
    keep(watch.done, net);
  };
  context.on("requestfinished", (request) => settle(request));
  context.on("requestfailed", (request) => settle(request, request.failure()?.errorText ?? "failed"));

  const watchPage = (page: Page) => {
    patchReadyWait(page);
    page.on("console", (message) => {
      const type = message.type();
      if (type === "error" || type === "warning") keep(watch.console, { at: Date.now(), page, type, text: message.text().slice(0, 300) }, 100);
    });
    page.on("pageerror", (error) => keep(watch.pageErrors, { at: Date.now(), page, text: String(error.message).slice(0, 300) }, 50));
    page.on("frameattached", (frame) => keep(watch.frames, { at: Date.now(), page, event: "attached", url: frame.url() }, 100));
    page.on("framenavigated", (frame) => {
      if (frame.parentFrame()) keep(watch.frames, { at: Date.now(), page, event: "navigated", url: frame.url() }, 100);
    });
    page.on("framedetached", (frame) => keep(watch.frames, { at: Date.now(), page, event: "detached", url: frame.url() }, 100));
    page.on("crash", () => keep(watch.crashes, { at: Date.now(), page }, 20));
  };
  for (const page of context.pages()) watchPage(page);
  context.on("page", watchPage);
  return watch;
}

/**
 * Installs the watch on every context `browser` opens from now on. Called by
 * `launchChromium`, so every probe and stress script has it without asking.
 */
export function watchBrowser(browser: Browser): Browser {
  const open = browser.newContext.bind(browser);
  browser.newContext = async (...args: Parameters<Browser["newContext"]>) => {
    const context = await open(...args);
    watchContext(context);
    return context;
  };
  return browser;
}

/* -------------------------------------------------------------------------- */
/* The wait                                                                   */
/* -------------------------------------------------------------------------- */

const READY = "getByText('Ready', { exact: true })";

/**
 * Wraps `Locator.waitFor` once, for the whole process, so a wait on the
 * editor's "Ready" that times out is explained before it is rethrown. Any
 * other locator, any wait that succeeds, and a wait for "Ready" to *go* —
 * `hidden` or `detached`, which a probe uses to see a redraw begin and is
 * allowed to time out — goes through untouched.
 */
function patchReadyWait(page: Page): void {
  if (state.patched) return;
  state.patched = true;
  const proto = Object.getPrototypeOf(page.locator("html")) as { waitFor: Locator["waitFor"] };
  const original = proto.waitFor;
  proto.waitFor = async function (this: Locator, options?: Parameters<Locator["waitFor"]>[0]) {
    try {
      return await original.call(this, options);
    } catch (error) {
      const appearing = options?.state === undefined || options.state === "visible" || options.state === "attached";
      if (error instanceof Error && error.name === "TimeoutError" && appearing && String(this) === READY) {
        const verdict = await explainEditorHang(this.page(), { waitedMs: options?.timeout }).catch((reason: unknown) => ({
          category: "U" as Category,
          summary: `editor-ready diagnostic could not run: ${String(reason).slice(0, 200)}`,
        }));
        error.message = `${error.message}\n${verdict.summary}`;
      }
      throw error;
    }
  };
}

/* -------------------------------------------------------------------------- */
/* Collecting                                                                 */
/* -------------------------------------------------------------------------- */

type TimelineEntry = { at: number; phase: string; detail?: Record<string, unknown> };
type CanvasRead = {
  href: string;
  readyState: string;
  addressed: number;
  fonts: string | null;
  unfinishedImages: string[];
  timeline: TimelineEntry[] | null;
};
type PgRow = {
  pid: number;
  state: string | null;
  wait_event_type: string | null;
  wait_event: string | null;
  xact_s: number | null;
  query_s: number | null;
  query: string | null;
};

export type Evidence = {
  at: string;
  label: string;
  waitedMs: number | null;
  closed: boolean;
  crashed: boolean;
  /** Whether the editor recorded a timeline: the server ran with EOD_EDITOR_DIAGNOSTICS=1 and the shell mounted. */
  diagnostics: boolean;
  /** `status` is what is visible; `statusText` what the status line holds, seen or not. */
  outer: { url: string; status: string[]; statusText: string | null; document: Net | null };
  frames: { url: string; detached: boolean }[];
  canvasFrame: string | null;
  canvas: CanvasRead | null;
  canvasDocument: Net | null;
  pending: (Omit<Net, "page"> & { ageMs: number })[];
  editorTimeline: TimelineEntry[] | null;
  pageErrors: string[];
  consoleErrors: string[];
  frameEvents: string[];
  server: { known: boolean; diag: string[]; failures: string[]; tail: string[] };
  pg: { rows: PgRow[]; waitingLocks: number } | null;
  files: string[];
};

export type Verdict = { category: Category; label: string; reason: string; summary: string; evidence: Evidence };

const within = <T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> =>
  Promise.race([promise.catch(() => fallback), new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))]);

const strip = ({ page: _page, ...rest }: Net) => rest;
const clock = (at: number) => new Date(at).toISOString().slice(11, 23);
let counter = 0;

/** Plain JavaScript in the frame — a string, so no build step can wrap it in helpers the page lacks. */
const CANVAS_READ = `(() => ({
  href: location.href,
  readyState: document.readyState,
  addressed: document.querySelectorAll("[data-eod-address]").length,
  fonts: document.fonts ? document.fonts.status : null,
  unfinishedImages: Array.from(document.images).filter((image) => !image.complete).map((image) => image.currentSrc || image.src).slice(0, 5),
  timeline: window.__eodCanvasTimeline ? window.__eodCanvasTimeline.entries.slice(-40) : null,
}))()`;
const EDITOR_READ = `(() => {
  const status = document.querySelector('p[aria-live="polite"]');
  return {
    diagnostics: Boolean(window.__eodEditorTimeline),
    timeline: window.__eodEditorTimeline ? window.__eodEditorTimeline.entries.slice(-60) : null,
    statusText: status ? status.textContent.trim() : null,
  };
})()`;

async function databaseActivity(database: string): Promise<Evidence["pg"]> {
  const sql = postgres(`${PG_BASE}/${database}`, { max: 1, connect_timeout: 3, idle_timeout: 1, prepare: false, onnotice: () => undefined });
  try {
    const rows = await sql<PgRow[]>`
      select pid, state, wait_event_type, wait_event,
             extract(epoch from now() - xact_start)::int as xact_s,
             extract(epoch from now() - query_start)::int as query_s,
             left(regexp_replace(query, '\\s+', ' ', 'g'), 160) as query
        from pg_stat_activity
       where datname = current_database() and pid <> pg_backend_pid()`;
    const [{ waiting }] = await sql<{ waiting: number }[]>`
      select count(*)::int as waiting
        from pg_locks l join pg_stat_activity a using (pid)
       where not l.granted and a.datname = current_database()`;
    return { rows: [...rows], waitingLocks: waiting };
  } finally {
    await sql.end({ timeout: 2 }).catch(() => undefined);
  }
}

/** Everything that can be read about an editor that is not Ready, and the verdict. */
export async function explainEditorHang(page: Page, options: { waitedMs?: number; label?: string } = {}): Promise<Verdict> {
  const now = Date.now();
  const label =
    options.label ??
    `${path.basename(process.argv[1] ?? "probe").replace(/\.(probe|stress|matrix)\.mts$/, "")}-${++counter}`;
  const watch = watches.get(page.context()) ?? null;
  const closed = page.isClosed();
  const crashed = Boolean(watch?.crashes.some((crash) => crash.page === page));

  const status = closed ? [] : await within(page.locator('p[aria-live="polite"]').allInnerTexts(), 3_000, []);
  type EditorRead = { diagnostics: boolean; timeline: TimelineEntry[] | null; statusText: string | null };
  const nothing: EditorRead = { diagnostics: false, timeline: null, statusText: null };
  const editor = closed ? nothing : await within(page.evaluate(EDITOR_READ) as Promise<EditorRead>, 3_000, nothing);

  const children = closed ? [] : page.frames().filter((frame) => frame !== page.mainFrame());
  const canvasFrame = children.find((frame) => isCanvasUrl(frame.url())) ?? children[0] ?? null;
  const canvas = canvasFrame && !canvasFrame.isDetached()
    ? await within(canvasFrame.evaluate(CANVAS_READ) as Promise<CanvasRead>, 3_000, null)
    : null;

  const mine = (net: Net) => net.page === page;
  const documents = (watch?.documents ?? []).filter(mine);
  const outerDocument = [...documents].reverse().find((net) => net.main) ?? null;
  const canvasDocument = [...documents].reverse().find((net) => net.canvas) ?? null;
  const pending = [...(watch?.pending.values() ?? [])]
    .filter(mine)
    .map((net) => ({ ...strip(net), ageMs: now - net.started }))
    .sort((a, b) => b.ageMs - a.ageMs)
    .slice(0, 25);

  // The server behind the page — by the address it shows, or, when its first
  // document never arrived and it still shows about:blank, by the address it
  // asked for.
  let origin = "";
  for (const candidate of [closed ? "" : page.url(), outerDocument?.url ?? ""]) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol.startsWith("http")) {
        origin = parsed.origin;
        break;
      }
    } catch {
      // about:blank, or nothing — try the next.
    }
  }
  const server = runningServers.get(origin);
  const lines = server ? server.lines() : [];
  const pg = server ? await within(databaseActivity(server.database), 6_000, null) : null;

  const files: string[] = [];
  const dir = path.join(REPO_ROOT, ".data", "test", "results", "diag");
  if (!closed) {
    mkdirSync(dir, { recursive: true });
    const outerShot = path.join(dir, `${label}-editor.png`);
    if (await within(page.screenshot({ path: outerShot, timeout: 5_000 }).then(() => true), 6_000, false)) files.push(outerShot);
    const frameShot = path.join(dir, `${label}-canvas.png`);
    const element = page.locator("iframe").first();
    if (await within(element.screenshot({ path: frameShot, timeout: 5_000 }).then(() => true), 6_000, false)) files.push(frameShot);
  }

  const evidence: Evidence = {
    at: new Date(now).toISOString(),
    label,
    waitedMs: options.waitedMs ?? null,
    closed,
    crashed,
    diagnostics: editor.diagnostics,
    outer: {
      url: closed ? "(closed)" : page.url(),
      status,
      statusText: editor.statusText,
      document: outerDocument ? (strip(outerDocument) as Net) : null,
    },
    frames: children.map((frame) => ({ url: frame.url().slice(0, 200), detached: frame.isDetached() })),
    canvasFrame: canvasFrame ? canvasFrame.url().slice(0, 200) : null,
    canvas,
    canvasDocument: canvasDocument ? (strip(canvasDocument) as Net) : null,
    pending,
    editorTimeline: editor.timeline,
    pageErrors: (watch?.pageErrors ?? []).filter((entry) => entry.page === page).slice(-10).map((entry) => `${clock(entry.at)} ${entry.text}`),
    consoleErrors: (watch?.console ?? [])
      .filter((entry) => entry.page === page && entry.type === "error")
      .slice(-10)
      .map((entry) => `${clock(entry.at)} ${entry.text}`),
    frameEvents: (watch?.frames ?? []).filter((entry) => entry.page === page).slice(-12).map((entry) => `${clock(entry.at)} ${entry.event} ${entry.url.slice(0, 160)}`),
    server: {
      known: Boolean(server),
      diag: lines.filter((line) => line.text.includes("[eod-diag]")).slice(-12).map((line) => line.text.slice(0, 240)),
      failures: serverFailureLines(lines).slice(-8).map((line) => `${clock(line.at)} ${line.text.slice(0, 240)}`),
      tail: lines.slice(-6).map((line) => `${clock(line.at)} ${line.text.slice(0, 200)}`),
    },
    pg,
    files,
  };

  const { category, reason } = classify(evidence, now);
  const summary = `editor-ready ${category} (${CATEGORY[category]}): ${reason}`;
  const record: Verdict = { category, label, reason, summary, evidence };

  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${label}.json`);
  writeFileSync(file, JSON.stringify(record, null, 2));
  files.push(file);

  console.log(`diag editor-ready ${category} ${label}: ${reason}`);
  console.log(`diag editor-ready-evidence ${label} ${compact(evidence)}`);
  state.verdicts.push(record);
  return record;
}

/** Every verdict this process has reached, oldest first — for the probe that tests this file. */
export const recordedVerdicts = (): readonly Verdict[] => state.verdicts;

/** One line of the evidence that matters most, short enough for a job log. */
function compact(evidence: Evidence): string {
  const tail = (entries: TimelineEntry[] | null, n: number) =>
    entries ? entries.slice(-n).map((entry) => `${clock(entry.at)} ${entry.phase}${entry.detail ? ` ${JSON.stringify(entry.detail).slice(0, 140)}` : ""}`) : null;
  return JSON.stringify({
    status: evidence.outer.status,
    outer: evidence.outer.url.slice(0, 160),
    diagnostics: evidence.diagnostics,
    frames: evidence.frames,
    canvas: evidence.canvas ? { ...evidence.canvas, timeline: undefined } : null,
    canvasDocument: evidence.canvasDocument,
    pending: evidence.pending.slice(0, 8).map((net) => `${net.type} ${net.url.slice(0, 120)} ${net.status ?? "-"} ${net.ageMs}ms`),
    editor: tail(evidence.editorTimeline, 10),
    bridge: tail(evidence.canvas?.timeline ?? null, 8),
    errors: [...evidence.pageErrors, ...evidence.consoleErrors].slice(-4),
    server: evidence.server.diag.slice(-4),
    serverFailures: evidence.server.failures.slice(-3),
    pg: evidence.pg ? { waitingLocks: evidence.pg.waitingLocks, busy: evidence.pg.rows.filter((row) => row.state !== "idle").slice(0, 4) } : null,
    files: evidence.files.map((file) => path.relative(REPO_ROOT, file)),
  });
}

/* -------------------------------------------------------------------------- */
/* Classifying                                                                */
/* -------------------------------------------------------------------------- */

const has = (entries: TimelineEntry[] | null, phase: string) => Boolean(entries?.some((entry) => entry.phase === phase));

/**
 * The answer, from the evidence alone, in an order that puts the cause before
 * its consequences: a crashed page explains a missing canvas, a database lock
 * explains a server that did not answer, a stalled image explains a frame whose
 * load never fired, and so on down. Exported for the tests of this rule itself.
 */
export function classify(evidence: Evidence, now: number): { category: Category; reason: string } {
  const editor = evidence.editorTimeline;
  const bridge = evidence.canvas?.timeline ?? null;
  const doc = evidence.canvasDocument;
  const age = (at?: number) => (at ? `${Math.round((now - at) / 100) / 10}s ago` : "never");

  // J — the browser side itself failed.
  if (evidence.closed) return { category: "J", reason: "the page was closed while the wait was running" };
  if (evidence.crashed) return { category: "J", reason: "the page's renderer crashed" };

  // I — it was Ready and the wait did not see it.
  if (evidence.outer.status.includes("Ready") || evidence.outer.statusText === "Ready") {
    return {
      category: "I",
      reason: `the status line holds "${evidence.outer.statusText}" (visible: ${JSON.stringify(evidence.outer.status)}) — the editor is Ready and the wait did not see it`,
    };
  }
  const latest = [...(editor ?? [])].reverse().find((entry) => ["canvas.mint", "canvas.load", "canvas.ready", "canvas.giveUp"].includes(entry.phase));
  if (latest?.phase === "canvas.ready") {
    return { category: "I", reason: `the editor recorded Ready at ${clock(latest.at)} and no new canvas since` };
  }

  // H — the database is where it is stuck. First, because a lock explains a
  // document that was never answered, wherever that document is.
  const busy = evidence.pg?.rows.filter(
    (row) =>
      row.wait_event_type === "Lock" ||
      (row.state === "active" && (row.query_s ?? 0) >= 5) ||
      (row.state?.startsWith("idle in transaction") && (row.xact_s ?? 0) >= 5),
  ) ?? [];
  if ((evidence.pg?.waitingLocks ?? 0) > 0 || busy.length) {
    const first = busy[0];
    return {
      category: "H",
      reason: `${evidence.pg?.waitingLocks ?? 0} lock wait(s); ${first ? `pid ${first.pid} ${first.state} ${first.wait_event_type ?? ""}/${first.wait_event ?? ""} for ${first.query_s ?? first.xact_s}s: ${first.query}` : ""}`.trim(),
    };
  }

  // The editor page's own document.
  const outer = evidence.outer.document;
  if (outer && outer.status === undefined && !outer.failed) {
    return { category: "A", reason: `the editor document got no response (${age(outer.started)} requested)` };
  }
  if (outer && outer.status !== undefined && outer.status >= 400) {
    return { category: "C", reason: `the editor document answered ${outer.status}` };
  }

  // B — no canvas frame on a document.
  if (!evidence.frames.length) {
    return {
      category: "B",
      reason: has(editor, "canvas.mint")
        ? `the editor minted a bridge but no canvas frame exists; the status says ${JSON.stringify(evidence.outer.status)}`
        : `the editor never mounted its canvas (no timeline, no frame): the shell did not hydrate or did not run its effects; the status says ${JSON.stringify(evidence.outer.status)}`,
    };
  }
  if (!doc) {
    return { category: "B", reason: `a frame exists (${evidence.canvasFrame}) but no request for a canvas document was ever made` };
  }

  // A — the canvas request was never answered.
  if (doc.status === undefined && !doc.failed) {
    return { category: "A", reason: `the canvas document was requested ${age(doc.started)} and has no response` };
  }

  // C — it was answered, but not with an editor canvas.
  if (doc.failed) return { category: "C", reason: `the canvas document request failed: ${doc.failed}` };
  if (doc.status !== undefined && doc.status >= 400) return { category: "C", reason: `the canvas document answered ${doc.status}` };
  if (evidence.canvasFrame && !isCanvasUrl(evidence.canvasFrame)) {
    return { category: "C", reason: `the frame holds ${evidence.canvasFrame}, not the canvas` };
  }

  // G — headers came, the end never did.
  if (doc.status !== undefined && doc.finished === undefined) {
    return {
      category: "G",
      reason: `the canvas document answered ${doc.status} ${age(doc.responded)} and its stream is still open (${evidence.canvas?.readyState ?? "unreadable"})`,
    };
  }

  const canvas = evidence.canvas;
  if (canvas && canvas.readyState === "complete" && canvas.addressed === 0) {
    return { category: "C", reason: "the canvas loaded as a page without editor addresses: rendered without the editor canvas (no session, no permission, or not a preview)" };
  }

  // F — the document is in, a resource it waits for is not.
  if (canvas && canvas.readyState !== "complete") {
    const waiting = evidence.pending.filter((net) => !net.main && !net.navigation);
    const images = canvas.unfinishedImages.length ? `; unfinished images ${JSON.stringify(canvas.unfinishedImages)}` : "";
    const fonts = canvas.fonts === "loading" ? "; fonts still loading" : "";
    return {
      category: "F",
      reason: `the canvas document is ${canvas.readyState}, so its load event cannot fire; still open: ${waiting.length ? waiting.slice(0, 3).map((net) => `${net.type} ${net.url.slice(0, 100)} (${net.ageMs} ms)`).join(", ") : "(nothing the network reports)"}${images}${fonts}`,
    };
  }

  // D — a canvas document, no bridge.
  if (canvas && evidence.diagnostics && !has(bridge, "bridge.mount")) {
    return { category: "D", reason: `the canvas document is complete with ${canvas.addressed} addressed nodes, but its bridge never mounted (no hydration of the canvas)` };
  }
  if (canvas && evidence.diagnostics && !has(bridge, "bridge.listen")) {
    return { category: "D", reason: "the bridge mounted but never started listening" };
  }

  // E — the bridge is there; Ready did not arrive.
  if (evidence.diagnostics && canvas) {
    if (!has(editor, "canvas.load")) {
      return { category: "E", reason: `the canvas is complete and its bridge is listening, but the editor never saw the frame's load event, so it never started the handshake (status ${JSON.stringify(evidence.outer.status)})` };
    }
    if (!has(bridge, "bridge.ping")) {
      return { category: "E", reason: "the editor is pinging but no ping reached the bridge" };
    }
    const refused = (editor ?? []).filter((entry) => entry.phase === "canvas.refused").slice(-3).map((entry) => JSON.stringify(entry.detail));
    return { category: "E", reason: `the bridge answered but the editor accepted no Ready${refused.length ? `; refused: ${refused.join(" ")}` : ""}` };
  }

  if (!evidence.diagnostics) {
    return { category: "U", reason: "the app was not running with EOD_EDITOR_DIAGNOSTICS=1, so neither side recorded its timeline" };
  }
  return { category: "U", reason: "nothing in the evidence decides it; see the record" };
}
