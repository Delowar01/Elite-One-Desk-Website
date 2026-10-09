/**
 * Batch 26 · the release decision on React #418 (tests/browser/README.md,
 * "Known issue — React #418"): loads the Visual Editor's canvas again and
 * again and records, for every canvas document, whether React recovered from
 * a hydration mismatch — where, with what component stack — and what followed:
 * whether the editor still selects, whether anything was written that nobody
 * asked for, whether a save was lost, whether a Server Action or the server
 * failed.
 *
 *   MATRIX_CLASS=normal|moderate|heavy  MATRIX_MODE=loads|redraws|visits  MATRIX_LOADS=40
 *   MATRIX_NETWORK=none|broadband|mobile|slow
 *   node --import tsx tests/browser/matrix/hydration.matrix.mts
 *
 * Two ways the editor puts a page in its canvas, and the matrix runs either —
 * or, as a third mode, a visitor's own page loads:
 *
 *   loads    open the editor on a route, over and over, across every kind of
 *            route (MATRIX_ROUTES narrows it: `route=category:travel-tourism,page=home`);
 *            then select the first thing Layers lists. Nothing is written.
 *   redraws  one editor edits one route (MATRIX_EDIT: services, packages or
 *            travel) and saves MATRIX_LOADS times; the editor redraws its
 *            canvas after every save, which is how an editor at work sees it.
 *   visits   a visitor, signed out, opens the public pages the editor's
 *            routes publish — the service categories, the overviews, Home —
 *            in both editions. Not the editor at all: whether the public site
 *            meets the same mismatch.
 *
 * And three conditions:
 *
 *   normal    nothing else running.
 *   moderate  the whole time: a second editor saving and redrawing another
 *             route (MATRIX_OTHER_EDIT), and three visitors reading public
 *             pages — a working day, not a load test.
 *   heavy     MATRIX_HOGS busy loops (default 4) with the server's process at
 *             the lowest CPU priority (MATRIX_SERVER_NICE, default 19): the
 *             server starved while the browser hydrates — the race Batch 25
 *             traced. Synthetic, to confirm the signature, not a condition the
 *             site runs in.
 *
 * And the browser's network, whatever the class (Chromium's own emulation, on
 * every page and canvas the matrix opens):
 *
 *   none       the loopback, as every probe runs.
 *   broadband  40 ms round trip, 20 Mbit/s down, 5 up — an office line to the
 *              server: the condition an editor at work is in.
 *   mobile     80 ms round trip, 5 Mbit/s down, 1.5 up — an ordinary mobile
 *              connection.
 *   slow       150 ms round trip, 1.6 Mbit/s down, 750 kbit/s up — a weak
 *              mobile connection: the page's tail arrives late, the same race
 *              from the other side.
 *
 * Every canvas document either editor loads is an attempt, counted from the
 * browser's own document requests. Not a probe: the runner does not run it and it
 * prints no PASS/FAIL — one `matrix canvas` line per error React recovered
 * from, one `matrix step` line per step, and a `matrix summary`. The decision
 * is read off those (docs/release/release-hardening-batch-26.md).
 * Needs what the probes need: a production build and `TEST_PG_URL`.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { setPriority } from "node:os";

import type { BrowserContext, Page } from "playwright";

import { editorIdle, editorSettled, inspectorAddress, selectFromLayers } from "../canvas";
import { onRecovered, type Recovered } from "../evidence";
import { launchChromium } from "../harness";
import { giveFresh } from "../../helpers/fixtures";
import { serverFailureLines } from "../../helpers/diagnostics";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer, type Server } from "../../helpers/server";
import { signIn } from "../../helpers/session";

const CLASS = (process.env.MATRIX_CLASS ?? "normal") as "normal" | "moderate" | "heavy";
const MODE = (process.env.MATRIX_MODE ?? "loads") as "loads" | "redraws" | "visits";
const NETWORK = (process.env.MATRIX_NETWORK ?? "none") as "none" | "broadband" | "mobile" | "slow";
/** Chromium's `Network.emulateNetworkConditions`: latency in ms, throughput in bytes per second. */
const NETWORKS = {
  broadband: { latency: 40, downloadThroughput: (20 * 1024 * 1024) / 8, uploadThroughput: (5 * 1024 * 1024) / 8 },
  mobile: { latency: 80, downloadThroughput: (5 * 1024 * 1024) / 8, uploadThroughput: (1.5 * 1024 * 1024) / 8 },
  slow: { latency: 150, downloadThroughput: (1.6 * 1024 * 1024) / 8, uploadThroughput: (750 * 1024) / 8 },
} as const;
const LOADS = Math.max(1, Number(process.env.MATRIX_LOADS ?? 40));
const HOGS = Math.max(0, Number(process.env.MATRIX_HOGS ?? (CLASS === "heavy" ? 4 : 0)));
const SERVER_NICE = process.env.MATRIX_SERVER_NICE ?? (CLASS === "heavy" ? "19" : "");
const PORT = Number(process.env.MATRIX_PORT ?? 3791);
if (!["normal", "moderate", "heavy"].includes(CLASS)) throw new Error(`MATRIX_CLASS must be normal, moderate or heavy, not ${CLASS}`);
if (!["loads", "redraws", "visits"].includes(MODE)) throw new Error(`MATRIX_MODE must be loads, redraws or visits, not ${MODE}`);
if (!["none", "broadband", "mobile", "slow"].includes(NETWORK)) throw new Error(`MATRIX_NETWORK must be none, broadband, mobile or slow, not ${NETWORK}`);

const browser = await launchChromium();
const database = giveFresh(`hydration_matrix_${CLASS}_${MODE}`);
const sql = connect(database);
let server: Server | undefined;
const hogs: ChildProcess[] = [];
let stopBackground = false;
const background: Promise<unknown>[] = [];

/** Everything the editor stores — content, drafts, presentation — as one fingerprint. */
async function contentFingerprint(): Promise<string> {
  const rows = await sql<{ t: string }[]>`
    select coalesce(string_agg(t, '|' order by t), '') as t from (
      select 'section:' || id || ':' || revision || ':' || md5(coalesce(published::text, '') || coalesce(draft::text, '') ||
             coalesce(styles::text, '') || coalesce(draft_styles::text, '') || coalesce(motion_config::text, '') ||
             coalesce(draft_motion_config::text, '')) as t from page_sections
      union all
      select 'page:' || id || ':' || revision || ':' || md5(coalesce(draft_structure::text, '')) from pages
      union all
      select 'node:' || owner_key || ':' || revision || ':' || md5(coalesce(draft_content::text, '') || coalesce(draft_styles::text, '') ||
             coalesce(draft_motion::text, '') || coalesce(styles::text, '') || coalesce(motion::text, '') || coalesce(copy::text, '')) from route_nodes
    ) parts`;
  return createHash("sha256").update(rows[0]?.t ?? "").digest("hex").slice(0, 16);
}

/**
 * One editor in the browser, counting every canvas document it loads and every
 * error React recovers from in one — or, for the `visits` mode, a visitor
 * counting the pages it opens.
 */
type Editor = {
  name: string;
  page: Page;
  canvases: number;
  recovered: Array<Recovered & { canvas: number }>;
  pageErrors: string[];
  actionFailures: string[];
};

/** Where an editing loop types, and where its words are stored. */
type Edit = { route: string; layer: string; field: string; owner: string; key: string };
type Saved = { saves: number; last: string; stored: string | null; lost: boolean };

try {
  const owner = await signIn(sql);
  const [name, value] = owner.cookie.split("=");

  const id = async (query: Promise<{ id: number }[]>) => (await query)[0]!.id;
  const travel = await id(sql`select id from service_categories where slug = 'travel-tourism'`);
  const business = await id(sql`select id from service_categories where slug = 'business-setup'`);
  const service = await id(sql`
    select s.id from services s join service_categories c on c.id = s.category_id
     where s.is_published and c.is_published order by s.id limit 1`);
  const tour = await id(sql`select id from travel_packages where is_published order by id limit 1`);
  const destination = await id(sql`select id from package_destinations where is_published order by id limit 1`);

  const EDITS: Record<string, Edit> = {
    services: { route: "route=serviceIndex:1", layer: "serviceIndexHero:1", field: "[data-field='heading'] input", owner: "serviceIndexHero:1", key: "copy:headingEn" },
    packages: { route: "route=packageIndex:1", layer: "packageIndexHero:1", field: "[data-field='heading'] input", owner: "packageIndexHero:1", key: "copy:headingEn" },
    travel: { route: `route=category:${travel}`, layer: `category:${travel}`, field: "[data-field='title'] input", owner: `category:${travel}`, key: "titleEn" },
  };
  const ownEdit = EDITS[process.env.MATRIX_EDIT ?? "services"];
  if (!ownEdit) throw new Error(`MATRIX_EDIT must be one of ${Object.keys(EDITS).join(", ")}`);
  const otherEdit = EDITS[process.env.MATRIX_OTHER_EDIT ?? (MODE === "redraws" && ownEdit === EDITS.services ? "packages" : "services")];
  if (!otherEdit) throw new Error(`MATRIX_OTHER_EDIT must be one of ${Object.keys(EDITS).join(", ")}`);

  // Every kind of route the editor opens; in the moderate class, not the second editor's own.
  const rotation = [
    `route=category:${travel}`,
    "page=home",
    `route=service:${service}`,
    `route=package:${tour}`,
    `route=destination:${destination}`,
    "route=packageIndex:1",
    `route=category:${business}`,
    "page=about",
    "route=serviceIndex:1",
  ].filter((route) => !(CLASS === "moderate" && route === otherEdit.route));
  const named = (process.env.MATRIX_ROUTES ?? "").split(",").map((entry) => entry.trim()).filter(Boolean);
  const routes: string[] = [];
  for (const entry of named) {
    const bySlug = /^route=category:([a-z][a-z0-9-]*)$/.exec(entry);
    routes.push(bySlug ? `route=category:${await id(sql`select id from service_categories where slug = ${bySlug[1]!}`)}` : entry);
  }
  if (!routes.length) routes.push(...rotation);

  server = await startServer(database, PORT);
  const origin = server.origin;
  const serverPid = server.pid;
  for (let i = 0; i < HOGS; i += 1) hogs.push(spawn("sh", ["-c", "while :; do :; done"], { stdio: "ignore" }));
  if (SERVER_NICE && serverPid) setPriority(serverPid, Number(SERVER_NICE));

  const editors: Editor[] = [];
  const contexts: BrowserContext[] = [];
  async function editor(label: string, signedIn = true): Promise<Editor> {
    const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
    contexts.push(context);
    if (signedIn) await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
    const page = await context.newPage();
    if (NETWORK !== "none") {
      // The page's session covers its canvas too: the canvas is same-origin, so in the same renderer.
      const cdp = await context.newCDPSession(page);
      await cdp.send("Network.enable");
      await cdp.send("Network.emulateNetworkConditions", { offline: false, ...NETWORKS[NETWORK] });
    }
    const out: Editor = { name: label, page, canvases: 0, recovered: [], pageErrors: [], actionFailures: [] };
    page.on("dialog", (dialog) => void dialog.accept());
    // A canvas document is a document request for the canvas — not a frame
    // navigation, which a same-document `history.replaceState` fires too. A
    // visitor's document is its own page's.
    page.on("request", (request) => {
      if (!request.isNavigationRequest()) return;
      const canvas = request.frame() !== page.mainFrame() && request.url().includes("editor=1");
      if (signedIn ? canvas : request.frame() === page.mainFrame()) out.canvases += 1;
    });
    await onRecovered(page, (recovered) => {
      out.recovered.push({ ...recovered, canvas: out.canvases });
      console.log(`matrix canvas ${label} #${out.canvases} ${recovered.path} — ${recovered.message} — ${recovered.stack}`);
    });
    page.on("pageerror", (error) => {
      // A #418 is counted through React's own report above, with its stack; anything else is a page error.
      if (!/Minified React error #418/.test(error.message)) out.pageErrors.push(error.message.slice(0, 160));
    });
    page.on("response", (response) => {
      if (response.status() < 400) return;
      const request = response.request();
      if (request.headers()["next-action"] || response.status() >= 500) {
        out.actionFailures.push(`${response.status()} ${request.method()} ${new URL(response.url()).pathname}`);
      }
    });
    editors.push(out);
    return out;
  }

  /** Saves `edit` again and again — each save redraws the canvas — and says what was typed last and what is stored. */
  async function editLoop(who: Editor, edit: Edit, until: (saves: number) => boolean): Promise<Saved> {
    await who.page.goto(`${origin}/admin/visual-editor?${edit.route}&lang=en&device=desktop`, { waitUntil: "load" });
    await editorSettled(who.page, 60_000);
    await selectFromLayers(who.page, edit.layer, 30_000);
    const input = who.page.locator(`aside[aria-label='Inspector'] ${edit.field}`).first();
    let saves = 0;
    let last = "";
    while (!until(saves)) {
      saves += 1;
      last = `Matrix ${who.name} ${saves}`;
      await input.fill(last);
      await editorIdle(who.page, 60_000);
      await who.page.waitForTimeout(300);
      if (who.name === "primary") {
        console.log(`matrix step primary save ${saves}/${LOADS} canvases=${who.canvases} recovered=${who.recovered.length}`);
      }
    }
    const [row] = await sql<{ v: string | null }[]>`
      select draft_content -> ${edit.key} ->> 'value' as v from route_nodes where owner_key = ${edit.owner}`;
    return { saves, last, stored: row?.v ?? null, lost: (row?.v ?? null) !== last };
  }

  /* --- the moderate class's background: a second editor, and visitors ------------------------------------- */
  const saved: { primary: Saved | null; other: Saved | null } = { primary: null, other: null };
  let visits = 0;
  const visitFailures: string[] = [];
  if (CLASS === "moderate") {
    const second = await editor("other");
    background.push(
      editLoop(second, otherEdit, () => stopBackground)
        .then((result) => (saved.other = result))
        .catch((error) => second.pageErrors.push(`the second editor stopped: ${String(error).slice(0, 200)}`)),
    );
    const publicPaths = ["/", "/services", "/services/travel-tourism", "/packages", "/about", "/ar", "/ar/services", "/contact"];
    for (let worker = 0; worker < 3; worker += 1) {
      background.push(
        (async () => {
          let n = worker;
          while (!stopBackground) {
            const path = publicPaths[n % publicPaths.length]!;
            n += 1;
            try {
              const response = await fetch(`${origin}${path}`);
              await response.arrayBuffer();
              visits += 1;
              if (response.status >= 500) visitFailures.push(`${response.status} ${path}`);
            } catch (error) {
              visitFailures.push(`${path}: ${String(error).slice(0, 80)}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
        })(),
      );
    }
  }

  /* --- the primary editor (or, visiting, the visitor) --------------------------------------------------- */
  const primary = await editor("primary", MODE !== "visits");
  const fingerprintAtStart = CLASS === "moderate" || MODE === "redraws" ? "" : await contentFingerprint();
  const unselected: string[] = [];
  const unexpectedWrites: string[] = [];
  let serverLinesSeen = server.lines().length;
  const serverErrors: string[] = [];

  if (MODE === "redraws") {
    saved.primary = await editLoop(primary, ownEdit, (saves) => saves >= LOADS);
  } else if (MODE === "visits") {
    // The pages the editor's routes publish: every service category (their
    // groups are the streamed lists Batch 25 traced), the overviews and Home.
    const categories = await sql<{ slug: string }[]>`select slug from service_categories where is_published order by id`;
    const visits = [...categories.map((row) => `/services/${row.slug}`), "/", "/services", "/packages"];
    for (let index = 0; index < LOADS; index += 1) {
      const where = `${index % 4 === 3 ? "/ar" : ""}${visits[index % visits.length]!}`.replace(/^\/ar\/$/, "/ar");
      const started = Date.now();
      await primary.page.goto(`${origin}${where}`, { waitUntil: "load" });
      await primary.page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
      await primary.page.waitForTimeout(300);
      const lines = server.lines();
      serverErrors.push(...serverFailureLines(lines.slice(serverLinesSeen)).map((line) => line.text.slice(0, 160)));
      serverLinesSeen = lines.length;
      console.log(
        `matrix step primary visit ${index + 1}/${LOADS} ${where} ${Date.now() - started}ms documents=${primary.canvases}` +
          ` recovered=${primary.recovered.length}`,
      );
    }
    if (CLASS !== "moderate" && (await contentFingerprint()) !== fingerprintAtStart) unexpectedWrites.push("a visit changed stored content");
  } else {
    for (let index = 0; index < LOADS; index += 1) {
      const route = routes[index % routes.length]!;
      const before = CLASS === "moderate" ? "" : await contentFingerprint();
      const started = Date.now();
      await primary.page.goto(`${origin}/admin/visual-editor?${route}&lang=${index % 4 === 3 ? "ar" : "en"}&device=desktop`, { waitUntil: "load" });
      await editorSettled(primary.page, 60_000);
      const loadMs = Date.now() - started;
      // Does the editor still do its job after whatever the load did? Select the first thing Layers lists.
      let selected = false;
      try {
        const first = await primary.page.locator("aside[aria-label='Page structure'] [data-layer-row]").first().getAttribute("data-layer-row", { timeout: 20_000 });
        if (first) {
          await selectFromLayers(primary.page, first, 20_000);
          selected = (await inspectorAddress(primary.page)) === first;
        }
      } catch (error) {
        primary.pageErrors.push(`selecting from Layers failed: ${String(error).slice(0, 120)}`);
      }
      if (!selected) unselected.push(`${index + 1}:${route}`);
      await primary.page.waitForTimeout(300);
      if (CLASS !== "moderate" && (await contentFingerprint()) !== before) unexpectedWrites.push(`${index + 1}:${route}`);
      const lines = server.lines();
      serverErrors.push(...serverFailureLines(lines.slice(serverLinesSeen)).map((line) => line.text.slice(0, 160)));
      serverLinesSeen = lines.length;
      console.log(
        `matrix step primary load ${index + 1}/${LOADS} ${route} ${loadMs}ms canvases=${primary.canvases}` +
          ` recovered=${primary.recovered.length} selected=${selected}`,
      );
    }
  }

  stopBackground = true;
  await Promise.all(background);
  serverErrors.push(...serverFailureLines(server.lines().slice(serverLinesSeen)).map((line) => line.text.slice(0, 160)));

  const exit = server.exit();
  const per = (who: Editor) => ({
    canvases: who.canvases,
    occurrences: who.recovered.length,
    canvasesWithOccurrence: new Set(who.recovered.map((r) => r.canvas)).size,
    paths: [...new Set(who.recovered.map((r) => r.path))],
    stacks: [...new Set(who.recovered.map((r) => r.stack))],
    pageErrors: who.pageErrors.slice(0, 10),
    actionFailures: who.actionFailures.slice(0, 10),
  });
  const summary = {
    class: CLASS,
    mode: MODE,
    network: NETWORK,
    hogs: HOGS,
    serverNice: SERVER_NICE || "0",
    attempts: editors.reduce((n, who) => n + who.canvases, 0),
    occurrences: editors.reduce((n, who) => n + who.recovered.length, 0),
    editors: Object.fromEntries(editors.map((who) => [who.name, per(who)])),
    unrecoveredSelection: unselected,
    unexpectedWrites,
    contentChanged: fingerprintAtStart ? (await contentFingerprint()) !== fingerprintAtStart : null,
    saves: saved,
    lost: Boolean(saved.primary?.lost || saved.other?.lost),
    visits,
    visitFailures: visitFailures.slice(0, 10),
    serverErrors: serverErrors.slice(0, 10),
    serverAlive: exit === null,
    serverRestarted: server.pid !== serverPid,
  };
  console.log(`matrix summary ${JSON.stringify(summary)}`);
  for (const context of contexts) await context.close().catch(() => undefined);
} finally {
  stopBackground = true;
  for (const hog of hogs) hog.kill("SIGKILL");
  await Promise.allSettled(background);
  await browser.close();
  await server?.stop();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
