/**
 * Batch 27 Correction 1: the editor watch names every way "Ready" can fail.
 *
 * `editor-watch.ts` explains a wait on the Visual Editor's "Ready" that runs
 * out, and the explanation is only worth having if each of its answers is the
 * right one. So this probe breaks the editor on purpose, once per answer, and
 * checks the watch names what was broken — the negative control for the
 * diagnostic itself. Each fault is permanent, so a short wait is enough: what
 * is checked is the verdict, not how long anything took.
 *
 *   D1  a healthy editor is Ready, and nothing is recorded against it
 *   D2  both timelines and the server's line record the handshake — and the
 *       editor listened from its frame's creation, not from the frame's load
 *   D3  I — the editor is Ready but the status cannot be seen
 *   D4  A — the canvas document is never answered
 *   D5  B — the editor's own scripts never arrive, so no canvas is mounted
 *   D6  C — the canvas document answers 500
 *   D7  C — the canvas renders without the editor (no editor flag reaches it)
 *   D8  D — the canvas's scripts never run, so its bridge never starts
 *   D9  E — the bridge answers, its Ready is lost on the way
 *   D10 F — the canvas's scripts never finish, so its bridge cannot start and
 *       its load cannot fire
 *   D11 G — the canvas document stops half-way through its head and never
 *       ends
 *   D12 H — the pages table is locked while the editor opens
 *   D13 J — the page's renderer crashes
 *   D14 with diagnostics off — production's setting — nothing is recorded
 *       and nothing is printed
 *
 * And the fix the diagnostic led to (Correction 1: the handshake no longer
 * waits for the frame's load event), held the same way, by breaking it:
 *
 *   R1  an image in the canvas never finishes: the editor is Ready anyway,
 *       before the canvas has loaded — before the fix this was F, and the
 *       status read "Loading canvas…" for as long as the editor was open
 *   R2  …and when the picture does arrive, the canvas's load event changes
 *       nothing: still Ready, the selection kept
 *   R3  a canvas that never answers and never loads says so within the 20 s
 *       — "Unable to connect" — instead of loading for ever
 *   R4  a canvas document that arrives whole but whose stream is never ended
 *       — a Suspense boundary that never resolves, from outside — is Ready
 *       anyway: its bridge is in what did arrive
 *   R5  nothing reaches into the canvas before its first document arrives —
 *       not the handshake, not the timeline: with the canvas document held
 *       for 1.5 s, a script the browser runs at the start of every document
 *       still runs in the canvas itself. Touching the frame's window any
 *       earlier makes the canvas inherit its empty first document's window,
 *       and such a script then runs against that one
 */
import http from "node:http";

import type { BrowserContext, Page, Route } from "playwright";

import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { runningServers, startServer, type Server } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { inspectorAddress, selectFromLayers } from "../canvas";
import { explainEditorHang, recordedVerdicts, type Category, type Verdict } from "../editor-watch";
import { launchChromium } from "../harness";

const PORT = 3742;
const PROXY_PORT = 3743;
const QUIET_PORT = 3744;
/** Long enough for a healthy editor to have answered several times over. */
const FAULT_WAIT_MS = 7_000;

/** A crashed page can leave a protocol call or a close unanswered; nothing here waits on one for ever. */
const bounded = <T,>(promise: Promise<T>, ms: number) =>
  Promise.race([promise.catch(() => undefined), new Promise<undefined>((resolve) => setTimeout(resolve, ms))]);

const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const isCanvas = (url: URL) => url.searchParams.get("editor") === "1" && url.searchParams.has("bridge");
const fromChild = (frame: { parentFrame(): unknown }) => frame.parentFrame() !== null;

const browser = await launchChromium();
const database = giveFresh("editor_diagnostics_probe");
const sql = connect(database);
const servers: Server[] = [];
let proxy: http.Server | null = null;

try {
  const owner = await signIn(sql);
  const server = await startServer(database, PORT);
  servers.push(server);
  const [name, value] = owner.cookie.split("=");

  const fresh = async (): Promise<BrowserContext> => {
    const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
    await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
    return context;
  };
  const editorAt = (origin: string) => `${origin}/admin/visual-editor?page=about&lang=en&device=desktop`;
  const open = async (page: Page, origin = server.origin, waitUntil: "domcontentloaded" | "commit" = "domcontentloaded") =>
    page.goto(editorAt(origin), { waitUntil, timeout: 20_000 }).catch(() => null);

  /** The wait every probe makes, and the verdict it produced — null when Ready came. */
  const attempt = async (page: Page, ms = FAULT_WAIT_MS): Promise<Verdict | null> => {
    const before = recordedVerdicts().length;
    try {
      await page.getByText("Ready", { exact: true }).waitFor({ timeout: ms });
      return null;
    } catch {
      return recordedVerdicts().length > before ? recordedVerdicts().at(-1)! : null;
    }
  };
  const expect = (check: string, verdict: Verdict | null, category: Category) =>
    say(
      `${check} · ${category}`,
      verdict?.category === category,
      verdict ? `${verdict.category}: ${verdict.reason.slice(0, 220)}` : "no verdict (it was Ready)",
    );

  /* --- D1–D3 · healthy, then unseen ---------------------------------------- */
  {
    const context = await fresh();
    const page = await context.newPage();
    await open(page);
    const verdict = await attempt(page, 30_000);
    say("D1 a healthy editor is Ready, and nothing is recorded against it", verdict === null);

    const editor = (await page.evaluate("window.__eodEditorTimeline ? window.__eodEditorTimeline.entries : []")) as {
      at: number;
      phase: string;
    }[];
    const canvasFrame = page.frames().find((frame) => frame.url().includes("editor=1"));
    const canvas = canvasFrame
      ? ((await canvasFrame.evaluate("window.__eodCanvasTimeline ? window.__eodCanvasTimeline.entries : []")) as { phase: string }[])
      : [];
    const at = (phase: string) => editor.find((entry) => entry.phase === phase)?.at ?? Number.NaN;
    const [mint, frame, listen, ready, load] = ["canvas.mint", "canvas.frame", "canvas.listen", "canvas.ready", "canvas.load"].map(at);
    const ordered = [mint, frame, listen, ready].every(Number.isFinite) && mint! <= frame! && mint! <= listen! && frame! <= ready! && listen! <= ready!;
    // Correction 1: the handshake is armed with the frame, so it listens before
    // the frame's load event — or before a load that has not happened yet.
    const early = Number.isFinite(listen) && (!Number.isFinite(load) || listen! <= load!);
    const bridged = ["bridge.mount", "bridge.listen", "bridge.announce"].every((phase) => canvas.some((entry) => entry.phase === phase));
    const line = server.lines().some((entry) => /\[eod-diag\] canvas slug=about bridge=\S+ answer=canvas /.test(entry.text));
    say(
      "D2 both timelines and the server's line record the handshake, and the editor listened before the frame's load",
      ordered && early && bridged && line,
      `editor ${editor.map((entry) => entry.phase).join(" → ")}; canvas ${canvas.map((entry) => entry.phase).join(" → ")}; listened ${Number.isFinite(load) ? `${load! - listen!} ms before the load` : "with no load yet"}; server line ${line}`,
    );

    await page.addStyleTag({ content: 'p[aria-live="polite"] { visibility: hidden !important; }' });
    expect("D3 the editor is Ready but its status cannot be seen", await attempt(page, 2_500), "I");
    await context.close();
  }

  /* --- R5 · nothing reaches into the canvas early ---------------------------------- */
  {
    const context = await fresh();
    await context.addInitScript({ content: "window.__eodInitRuns = (window.__eodInitRuns || []).concat(location.href);" });
    // The canvas document held for 1.5 s, so the frame keeps its empty first
    // document for longer than one ping interval: anything that reaches into
    // the frame too early does it while there is nothing else to reach.
    await context.route(
      (url) => isCanvas(url),
      async (route) => {
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await route.continue().catch(() => undefined);
      },
    );
    const page = await context.newPage();
    await open(page);
    const verdict = await attempt(page, 30_000);
    const canvasFrame = page.frames().find((frame) => frame.url().includes("editor=1"));
    const runs = canvasFrame ? ((await canvasFrame.evaluate("window.__eodInitRuns || []").catch((): string[] => [])) as string[]) : [];
    say(
      "R5 nothing reaches into the canvas before its document arrives: a script run at the start of every document runs in the canvas itself",
      verdict === null && runs.length === 1 && runs[0]!.includes("editor=1"),
      JSON.stringify(runs.map((href) => href.slice(0, 100))),
    );
    await context.close();
  }

  /* --- D4 · A ----------------------------------------------------------------- */
  {
    const context = await fresh();
    await context.route((url) => isCanvas(url), () => undefined); // never answered
    const page = await context.newPage();
    await open(page);
    expect("D4 the canvas document is never answered", await attempt(page), "A");
    await context.close();
  }

  /* --- D5 · B ----------------------------------------------------------------- */
  {
    const context = await fresh();
    await context.route(
      (url) => url.pathname.startsWith("/_next/static/chunks/"),
      async (route) => {
        if (fromChild(route.request().frame())) return route.continue();
        // the editor's own scripts: held, never answered
      },
    );
    const page = await context.newPage();
    await open(page);
    expect("D5 the editor's own scripts never arrive", await attempt(page), "B");
    await context.close();
  }

  /* --- D6 · C, an error status -------------------------------------------------- */
  {
    const context = await fresh();
    await context.route(
      (url) => isCanvas(url),
      (route) => route.fulfill({ status: 500, contentType: "text/html", body: "<!doctype html><p>held by the probe</p>" }),
    );
    const page = await context.newPage();
    await open(page);
    expect("D6 the canvas document answers 500", await attempt(page), "C");
    await context.close();
  }

  /* --- D7 · C, rendered without the editor ---------------------------------------- */
  {
    const context = await fresh();
    await context.route(
      (url) => isCanvas(url),
      (route) => {
        const url = new URL(route.request().url());
        url.searchParams.delete("editor");
        return route.continue({ url: url.toString() });
      },
    );
    const page = await context.newPage();
    await open(page);
    expect("D7 the canvas renders without the editor", await attempt(page), "C");
    await context.close();
  }

  /* --- D8 · D --------------------------------------------------------------------- */
  {
    const context = await fresh();
    await context.route(
      (url) => url.pathname.startsWith("/_next/static/chunks/"),
      (route) => (fromChild(route.request().frame()) ? route.abort() : route.continue()),
    );
    const page = await context.newPage();
    await open(page);
    expect("D8 the canvas's scripts never run", await attempt(page), "D");
    await context.close();
  }

  /* --- D9 · E --------------------------------------------------------------------- */
  {
    const context = await fresh();
    // In the editor's window only, ahead of its own listener: canvas.ready stops here.
    await context.addInitScript(`
      if (window.top === window) {
        window.addEventListener("message", (event) => {
          const data = event.data;
          if (data && data.message && data.message.type === "canvas.ready") event.stopImmediatePropagation();
        }, true);
      }
    `);
    const page = await context.newPage();
    await open(page);
    expect("D9 the bridge answers but its Ready is lost", await attempt(page), "E");
    await context.close();
  }

  /* --- D10 · F, and R3 ----------------------------------------------------------- */
  // An unfinished image no longer keeps the editor from Ready (R1), so F is the
  // canvas's own scripts held: its bridge cannot start and its load cannot fire,
  // and both are waiting on the same requests.
  {
    const context = await fresh();
    await context.route(
      (url) => url.pathname.startsWith("/_next/static/chunks/"),
      async (route) => {
        if (!fromChild(route.request().frame())) return route.continue();
        // the canvas's scripts: held, never answered
      },
    );
    const page = await context.newPage();
    const opened = Date.now();
    await open(page);
    expect("D10 the canvas's scripts never finish", await attempt(page), "F");
    const gaveUp = await page
      .getByText("Unable to connect", { exact: true })
      .waitFor({ timeout: 30_000 })
      .then(() => true, () => false);
    const status = await page.locator('p[aria-live="polite"]').allInnerTexts().catch((): string[] => []);
    say(
      "R3 a canvas that never answers and never loads gives up within its 20 s: \"Unable to connect\", not \"Loading canvas…\" for ever",
      gaveUp,
      `${JSON.stringify(status)} ${Math.round((Date.now() - opened) / 1000)} s after the editor was opened`,
    );
    await context.close();
  }

  /* --- R1, R2 · an unfinished image -------------------------------------------------- */
  {
    const context = await fresh();
    const held: Route[] = [];
    let releasing = false;
    await context.route(
      (url) => /\.(?:webp|png|jpe?g|svg|avif)$/.test(url.pathname),
      async (route) => {
        if (releasing || !fromChild(route.request().frame())) return route.continue();
        held.push(route); // an image inside the canvas: held until R2 lets it go
      },
    );
    const page = await context.newPage();
    await open(page);
    const verdict = await attempt(page, 30_000);
    const canvasFrame = () => page.frames().find((frame) => frame.url().includes("editor=1"));
    const stateOf = async () => (canvasFrame() ? await canvasFrame()!.evaluate("document.readyState").catch(() => "unreadable") : "no canvas");
    const before = await stateOf();
    say(
      "R1 an image in the canvas never finishes, and the editor is Ready anyway — before the canvas has loaded",
      verdict === null && held.length > 0 && before !== "complete",
      `${verdict ? `${verdict.category}: ${verdict.reason.slice(0, 160)}` : "Ready"}; ${held.length} image(s) held; canvas ${before}`,
    );

    const row = page.locator("aside[aria-label='Page structure'] [data-layer-row]").first();
    const address = (await row.getAttribute("data-layer-row", { timeout: 15_000 }).catch(() => null)) ?? "";
    const selected = address ? await selectFromLayers(page, address, 20_000).then(() => true, () => false) : false;
    releasing = true;
    for (const route of held.splice(0)) await route.continue().catch(() => undefined);
    const editorLoads = async () =>
      ((await page.evaluate("window.__eodEditorTimeline ? window.__eodEditorTimeline.entries : []")) as { phase: string; detail?: { alreadyReady?: boolean } }[])
        .filter((entry) => entry.phase === "canvas.load");
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !((await stateOf()) === "complete" && (await editorLoads()).length > 0)) await page.waitForTimeout(100);
    const loads = await editorLoads();
    const after = await stateOf();
    const kept = selected && (await inspectorAddress(page)) === address;
    const status = await page.locator('p[aria-live="polite"]').allInnerTexts().catch((): string[] => []);
    say(
      "R2 …and when the picture arrives, the canvas's load changes nothing: still Ready, the selection kept",
      after === "complete" && loads.length === 1 && loads[0]!.detail?.alreadyReady === true && kept && status.includes("Ready") && !status.includes("Connecting…"),
      `canvas ${after}; loads ${JSON.stringify(loads.map((entry) => entry.detail?.alreadyReady ?? false))}; selected ${address || "nothing"} ${selected ? (kept ? "and kept" : "and lost") : "(could not select)"}; status ${JSON.stringify(status)}`,
    );
    await context.close();
  }

  /* --- D11 · G, and R4 ------------------------------------------------------------ */
  {
    // The whole editor through a proxy on its own port, which passes everything
    // on except a canvas document's response, which is never ended: for D11
    // only the first 512 bytes of it are passed on, half a head with no body
    // and no bridge; for R4 every byte is, and only the end is withheld — what
    // a Suspense boundary that never resolves looks like from outside.
    let whole = false;
    proxy = http.createServer((request, response) => {
      const target = new URL(request.url ?? "/", server.origin);
      const document = isCanvas(target) && !request.headers.rsc && !target.searchParams.has("_rsc");
      const upstream = http.request(
        { host: "127.0.0.1", port: PORT, path: request.url, method: request.method, headers: { ...request.headers, host: `127.0.0.1:${PORT}` } },
        (answer) => {
          const headers = { ...answer.headers };
          if (document) delete headers["content-length"];
          response.writeHead(answer.statusCode ?? 502, headers);
          if (!document) return void answer.pipe(response);
          let budget = whole ? Number.POSITIVE_INFINITY : 512;
          answer.on("data", (chunk: Buffer) => {
            if (budget <= 0) return;
            const part = chunk.length > budget ? chunk.subarray(0, budget) : chunk;
            budget -= part.length;
            response.write(part);
          });
        },
      );
      upstream.on("error", () => response.destroy());
      request.pipe(upstream);
    });
    await new Promise<void>((resolve) => proxy!.listen(PROXY_PORT, "127.0.0.1", resolve));
    const proxied = `http://127.0.0.1:${PROXY_PORT}`;
    runningServers.set(proxied, { database, lines: server.lines });
    {
      const context = await fresh();
      const page = await context.newPage();
      await open(page, proxied);
      expect("D11 the canvas document stops half-way through its head", await attempt(page), "G");
      await context.close();
    }
    {
      whole = true;
      const context = await fresh();
      const page = await context.newPage();
      await open(page, proxied);
      const verdict = await attempt(page, 30_000);
      const canvasFrame = page.frames().find((frame) => frame.url().includes("editor=1"));
      const state = canvasFrame ? await canvasFrame.evaluate("document.readyState").catch(() => "unreadable") : "no canvas";
      say(
        "R4 a canvas document that arrives whole but is never ended is Ready anyway",
        verdict === null && state !== "complete",
        `${verdict ? `${verdict.category}: ${verdict.reason.slice(0, 160)}` : "Ready"}; canvas ${state}`,
      );
      await context.close();
    }
    runningServers.delete(proxied);
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy!.close(resolve));
    proxy = null;
  }

  /* --- D12 · H -------------------------------------------------------------------- */
  {
    const locker = connect(database);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const taken = new Promise<void>((resolve) => (locked = resolve));
    const transaction = locker
      .begin(async (tx) => {
        await tx`lock table pages in access exclusive mode`;
        locked();
        await held;
      })
      .catch(() => undefined);
    await taken;
    const context = await fresh();
    const page = await context.newPage();
    // The editor's own document reads that table too, so it never commits; the
    // navigation is left running and the wait is what is measured.
    void page.goto(editorAt(server.origin), { waitUntil: "commit", timeout: 60_000 }).catch(() => null);
    expect("D12 the pages table is locked while the editor opens", await attempt(page), "H");
    const step = (what: string) => console.log(`· ${new Date().toISOString().slice(11, 23)} D12 ${what}`);
    release();
    step("released");
    await transaction;
    step("transaction settled");
    await locker.end({ timeout: 5 });
    step("locker ended");
    await context.close();
    step("context closed");
  }

  /* --- D13 · J -------------------------------------------------------------------- */
  {
    const step = (what: string) => console.log(`· ${new Date().toISOString().slice(11, 23)} D13 ${what}`);
    const context = await fresh();
    step("context");
    const page = await context.newPage();
    await open(page);
    step("opened");
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 30_000 });
    step("ready");
    const crashed = new Promise<void>((resolve) => page.once("crash", () => resolve()));
    const session = await context.newCDPSession(page);
    await bounded(session.send("Page.crash"), 3_000);
    await bounded(crashed, 5_000);
    step("crashed");
    expect("D13 the page's renderer crashes", await explainEditorHang(page, { label: "editor-diagnostics-crash" }), "J");
    await bounded(context.close(), 5_000);
    step("closed");
  }

  /* --- D14 · diagnostics off --------------------------------------------------------- */
  {
    const step = (what: string) => console.log(`· ${new Date().toISOString().slice(11, 23)} D14 ${what}`);
    const quiet = await startServer(database, QUIET_PORT, { env: { EOD_EDITOR_DIAGNOSTICS: "0" } });
    servers.push(quiet);
    step("server");
    const context = await fresh();
    const page = await context.newPage();
    await open(page, quiet.origin);
    step("opened");
    const ready = (await attempt(page, 30_000)) === null;
    step(`ready ${ready}`);
    const outer = (await page.evaluate("typeof window.__eodEditorTimeline")) as string;
    const canvasFrame = page.frames().find((frame) => frame.url().includes("editor=1"));
    const inner = canvasFrame ? ((await canvasFrame.evaluate("typeof window.__eodCanvasTimeline")) as string) : "no canvas";
    const printed = quiet.lines().filter((entry) => entry.text.includes("[eod-diag]")).length;
    say(
      "D14 with diagnostics off nothing is recorded or printed",
      ready && outer === "undefined" && inner === "undefined" && printed === 0,
      `Ready ${ready}; editor timeline ${outer}; canvas timeline ${inner}; server lines ${printed}`,
    );
    await context.close();
  }
} finally {
  if (proxy) {
    proxy.closeAllConnections();
    proxy.close();
  }
  for (const server of servers) await server.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
