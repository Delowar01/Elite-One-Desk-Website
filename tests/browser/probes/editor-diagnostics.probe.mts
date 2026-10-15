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
 *   D2  both timelines and the server's line record the handshake
 *   D3  I — the editor is Ready but the status cannot be seen
 *   D4  A — the canvas document is never answered
 *   D5  B — the editor's own scripts never arrive, so no canvas is mounted
 *   D6  C — the canvas document answers 500
 *   D7  C — the canvas renders without the editor (no editor flag reaches it)
 *   D8  D — the canvas's scripts never run, so its bridge never starts
 *   D9  E — the bridge answers, its Ready is lost on the way
 *   D10 F — an image in the canvas never finishes, so its load never fires
 *   D11 G — the canvas document's stream is never ended
 *   D12 H — the pages table is locked while the editor opens
 *   D13 J — the page's renderer crashes
 *   D14 with diagnostics off — production's setting — nothing is recorded
 *       and nothing is printed
 */
import http from "node:http";

import type { BrowserContext, Page } from "playwright";

import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { runningServers, startServer, type Server } from "../../helpers/server";
import { signIn } from "../../helpers/session";
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
    const order = ["canvas.mint", "canvas.frame", "canvas.listen", "canvas.ready"].map(
      (phase) => editor.find((entry) => entry.phase === phase)?.at ?? Number.NaN,
    );
    const ordered = order.every((at, i) => Number.isFinite(at) && (i === 0 || at >= order[i - 1]!));
    const bridged = ["bridge.mount", "bridge.listen", "bridge.announce"].every((phase) => canvas.some((entry) => entry.phase === phase));
    const line = server.lines().some((entry) => /\[eod-diag\] canvas slug=about bridge=\S+ answer=canvas /.test(entry.text));
    say(
      "D2 both timelines and the server's line record the handshake",
      ordered && bridged && line,
      `editor ${editor.map((entry) => entry.phase).join(" → ")}; canvas ${canvas.map((entry) => entry.phase).join(" → ")}; server line ${line}`,
    );

    await page.addStyleTag({ content: 'p[aria-live="polite"] { visibility: hidden !important; }' });
    expect("D3 the editor is Ready but its status cannot be seen", await attempt(page, 2_500), "I");
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

  /* --- D10 · F -------------------------------------------------------------------- */
  {
    const context = await fresh();
    await context.route(
      (url) => /\.(?:webp|png|jpe?g|svg|avif)$/.test(url.pathname),
      async (route) => {
        if (!fromChild(route.request().frame())) return route.continue();
        // an image inside the canvas: held, never answered
      },
    );
    const page = await context.newPage();
    await open(page);
    expect("D10 an image in the canvas never finishes", await attempt(page), "F");
    await context.close();
  }

  /* --- D11 · G -------------------------------------------------------------------- */
  {
    // The whole editor through a proxy on its own port, which passes everything
    // on — except that a canvas document's response is never ended. The
    // browser sees what a Suspense boundary that never resolves looks like
    // from outside: headers, body, no end.
    proxy = http.createServer((request, response) => {
      const target = new URL(request.url ?? "/", server.origin);
      const document = isCanvas(target) && !request.headers.rsc && !target.searchParams.has("_rsc");
      const upstream = http.request(
        { host: "127.0.0.1", port: PORT, path: request.url, method: request.method, headers: { ...request.headers, host: `127.0.0.1:${PORT}` } },
        (answer) => {
          const headers = { ...answer.headers };
          if (document) delete headers["content-length"];
          response.writeHead(answer.statusCode ?? 502, headers);
          if (document) answer.on("data", (chunk) => response.write(chunk));
          else answer.pipe(response);
        },
      );
      upstream.on("error", () => response.destroy());
      request.pipe(upstream);
    });
    await new Promise<void>((resolve) => proxy!.listen(PROXY_PORT, "127.0.0.1", resolve));
    const proxied = `http://127.0.0.1:${PROXY_PORT}`;
    runningServers.set(proxied, { database, lines: server.lines });
    const context = await fresh();
    const page = await context.newPage();
    await open(page, proxied);
    expect("D11 the canvas document's stream is never ended", await attempt(page), "G");
    await context.close();
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
