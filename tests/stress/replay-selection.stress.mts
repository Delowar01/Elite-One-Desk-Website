/**
 * Batch 19A stress: Replay and the selection, interrupted every way the brief
 * names, many times — the lifecycle motion-15b checks 36–50 prove once.
 *
 * Replay is one authority (`lib/visual-editor/replay.ts` on the editor's side,
 * `motion-replay.ts` on the canvas): a token per request, the page, language,
 * canvas document and selected node captured with it, and a result that no
 * longer matches any of them ignored. The canvas stops a Replay and restores
 * the node on a newer request, a selection change, a direct edit or its own
 * teardown. This script asks, repeatedly, whether that holds:
 *
 *   R1  repeated Replay — only the last request reports; it finishes; the
 *       node is at rest again
 *   R2a a canvas click mid-Replay stops it, restores the node, and no stale
 *       result arrives afterwards
 *   R2b the same from Layers
 *   R3  a direct edit mid-Replay: the words are put back before typing, and
 *       what is saved is plain text
 *   R4  a page switch mid-Replay: no stale status, no artefact on either page
 *   R5  a language switch mid-Replay: the same
 *   R6  a device switch mid-Replay: the canvas is resized, not replaced, so the
 *       Replay may run on — nothing is left behind, the selection is kept, and
 *       any status shown is about the selected node
 *   R7  a canvas reload mid-Replay: no stale status, no artefact
 *   R8  after a Replay the selection outline sits on its element
 *   R9  Inspector, canvas and Layers agree on the selection after every step
 *   R10 Replay itself wrote nothing: no revision moved, nothing logged
 *   R11 no page errors
 *
 *   STRESS_LOOPS=3
 */
import type { Page } from "playwright";

import { canvasFrame, canvasStill, clickCanvasNode, editorIdle, inspectorAddress, selectCanvasNode, waitForInspector } from "../browser/canvas";
import { launchChromium } from "../browser/harness";
import { quietFor, REPLAY_QUIET_MS } from "../browser/wait";
import { giveFresh } from "../helpers/fixtures";
import { connect, dropDatabase } from "../helpers/pg";
import { startServer } from "../helpers/server";
import { signIn } from "../helpers/session";

const PORT = 3808;
const LOOPS = Number(process.env.STRESS_LOOPS ?? 3);
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

/** The editor records every selection and every Replay result the canvas reports. */
const RECORDER = `
  if (window === window.top) {
    window.__eodSelections = [];
    window.__eodReplays = [];
    window.addEventListener("message", (event) => {
      const message = event.data && event.data.message;
      if (!message) return;
      if (message.type === "canvas.selection") window.__eodSelections.push(message.node ? message.node.address : null);
      if (message.type === "canvas.motionReplayResult") window.__eodReplays.push({ token: message.token, outcome: message.outcome, address: message.address });
    }, true);
  }
`;

const browser = await launchChromium();
const database = giveFresh("replay_selection_stress");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);
  const origin = server.origin;

  /* --- the probe's About composition, as drafts (the canvas shows drafts) --- */
  const [about] = await sql<{ id: number }[]>`select id from pages where slug = 'about'`;
  const rows = await sql<{ id: number; block_type: string; published: Record<string, unknown> }[]>`
    select id, block_type, published from page_sections where page_id = ${about!.id} and not is_draft_only order by position`;
  const byType = Object.fromEntries(rows.map((r) => [r.block_type, r])) as Record<string, (typeof rows)[number]>;
  const TEXT = byType["rich-text"]!.id;
  const IMAGE = byType["image-text"]!.id;
  const WHY = byType["why-us"]!.id;
  const points = (byType["why-us"]!.published.points as { _id: string }[]).map((p) => p._id);
  const doc = (section: Record<string, unknown> = {}, nodes: Record<string, unknown> = {}) => ({ v: 1, section, nodes });
  const setDraft = async (id: number, value: unknown) =>
    sql`update page_sections set draft_motion_config = ${sql.json(value as never)}, draft_animation = 'fade-up' where id = ${id}`;
  await sql`update page_sections set draft = jsonb_set(published, '{title}', ${sql.json({ en: "Plan, book, travel", ar: "خطط، احجز، سافر" } as never)}) where id = ${TEXT}`;
  await setDraft(TEXT, doc({}, { "field:title": { base: { entrance: "fade-up", textReveal: "words", parallax: "subtle" } } }));
  await setDraft(WHY, doc({ base: { entrance: "blur", duration: "cinematic", delay: 1500 } }, {
    [`field:points/item:${points[0]}`]: { base: { hover: "lift" } },
    [`field:points/item:${points[1]}`]: { base: { hover: "scale" } },
  }));
  await setDraft(IMAGE, doc({}, { "field:image": { base: { entrance: "blur", parallax: "strong", hover: "zoom" } } }));

  const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
  await context.addInitScript({ content: "window.__name = window.__name || ((fn) => fn);" });
  await context.addInitScript({ content: RECORDER });
  const page: Page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message.slice(0, 160)));
  page.on("dialog", (dialog) => void dialog.accept());

  const IMG = `section:${IMAGE}/field:image`;
  const TITLE = `section:${TEXT}/field:title`;
  const ROW0 = `section:${WHY}/field:points/item:${points[0]}`;
  const ROW1 = `section:${WHY}/field:points/item:${points[1]}`;

  const ready = () => page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  /** The canvas for `slug` and `lang`, loaded and answering. */
  const canvasOn = async (slug: string, lang: string) => {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const frame = page.frames().find((f) => f.url().includes("editor=1"));
      const path = frame ? new URL(frame.url()).pathname : "";
      const want = `${lang === "ar" ? "/ar" : ""}${slug === "home" ? "/" : `/${slug}`}`;
      if (frame && (path === want || path === `${want}/`)) break;
      if (Date.now() > deadline) throw new Error(`the canvas never showed ${want}`);
      await page.waitForTimeout(50);
    }
    await ready();
  };
  const open = async (query: string) => {
    await page.goto(`${origin}/admin/visual-editor${query}`, { waitUntil: "load" });
    await ready();
  };
  const status = async () =>
    (await page.locator("[data-replay-status]").count()) ? ((await page.locator("[data-replay-status]").getAttribute("data-replay-status")) ?? "") : "";
  const until = async (check: () => Promise<boolean>, ms: number) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await check()) return true;
      if (Date.now() > deadline) return false;
      await page.waitForTimeout(50);
    }
  };
  const motionTab = () => page.getByRole("tab", { name: /Motion/ });
  const select = async (address: string) => {
    if (!address.includes("/")) {
      const row = page.locator(`aside[aria-label='Page structure'] [data-layer-row="${address}"]`);
      await row.waitFor({ timeout: 25_000 });
      await row.click();
      if ((await waitForInspector(page, address)) !== address) throw new Error(`could not select ${address} from Layers`);
    } else {
      const result = await selectCanvasNode(page, address);
      if (!result.ok) throw new Error(`could not select ${address}: the Inspector shows ${result.shows}, the click landed on ${JSON.stringify(result.landing)}`);
    }
    await motionTab().click();
  };
  const play = async (mode: string) => {
    await page.locator(`[data-replay-mode="${mode}"]`).click();
    return until(async () => ["started", "finished"].includes(await status()), 5_000);
  };
  const replays = () => page.evaluate(() => (window as unknown as { __eodReplays: { token: number; outcome: string }[] }).__eodReplays.slice());
  /**
   * Anything a Replay leaves on the canvas: word spans, the hover mark, a
   * drift offset, and — for the node it was replaying, in the same document —
   * the node sent back to waiting. A freshly loaded document (a page,
   * language or reload step) is asked only about the first three: whether a
   * node below the fold has been revealed yet there is the page's own
   * loading, which no Replay touched.
   */
  const leftovers = async (address?: string) => {
    const frame = await canvasFrame(page);
    return frame.evaluate((wanted) => {
      const found: string[] = [];
      const count = (selector: string) => document.querySelectorAll(selector).length;
      if (count("[data-eod-replay-hover]")) found.push("replay-hover");
      if (count("[data-m-words]") || count("[data-m-w]")) found.push("word spans");
      const drifting = [...document.querySelectorAll<HTMLElement>("[data-m-px]")].filter((n) => n.style.getPropertyValue("--m-py") !== "");
      if (drifting.length) found.push(`${drifting.length} drift offset(s)`);
      if (wanted) {
        const node = document.querySelector(`[data-eod-address="${wanted}"]`);
        if (node && node.hasAttribute("data-shown") && node.getAttribute("data-shown") !== "true") found.push("sent back to waiting");
      }
      return found;
    }, address ?? null);
  };
  /**
   * Inspector, the canvas's last reported selection and Layers, compared —
   * waited for, bounded (10 s), because a step that ends in a redraw empties
   * Layers until the new canvas has reported its structure, and reading in
   * that moment compares against nothing. Three that never agree still fail.
   */
  const agree = async () => {
    const read = async () => {
      const shows = await inspectorAddress(page);
      const reported = await page.evaluate(() => (window as unknown as { __eodSelections: (string | null)[] }).__eodSelections.at(-1) ?? null);
      const marked =
        (await page
          .locator("aside[aria-label='Page structure'] [data-layer-row][aria-current='true']")
          .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-layer-row") ?? ""))).sort((a, b) => b.length - a.length)[0] ?? "";
      return { ok: shows !== "" && shows === reported && shows === marked, shows, reported, marked };
    };
    let last = await read();
    await until(async () => (last = await read()).ok, 10_000);
    return last;
  };

  type Tally = { runs: number; bad: string[] };
  const tally = (): Tally => ({ runs: 0, bad: [] });
  const r = { r1: tally(), r2a: tally(), r2b: tally(), r3: tally(), r4: tally(), r5: tally(), r6: tally(), r7: tally(), r8: tally(), r9: tally() };
  const agreeAfter = async (label: string) => {
    const a = await agree();
    r.r9.runs += 1;
    if (!a.ok) r.r9.bad.push(`${label} ${JSON.stringify(a)}`);
  };

  /** The two sections that are only ever replayed and selected here — never edited. */
  const untouchedState = async () =>
    JSON.stringify(
      await sql`select id, revision, draft, draft_motion_config, draft_styles from page_sections where id in (${WHY}, ${IMAGE}) order by id`,
    );

  await open("?page=about&lang=en&device=desktop");
  const stateBefore = await untouchedState();

  for (let loop = 1; loop <= LOOPS; loop += 1) {
    /* R1 + R8 — repeated Replay, then the outline */
    await select(IMG);
    const seen = (await replays()).length;
    await play("all");
    await page.locator('[data-replay-mode="all"]').click();
    await page.locator('[data-replay-mode="all"]').click();
    const finished = await until(async () => (await status()) === "finished", 15_000);
    await quietFor(page, 600, "a stale result from a superseded token, if one were coming, arrives in here");
    const results = (await replays()).slice(seen);
    const lastToken = Math.max(...results.map((x) => x.token));
    const left = await leftovers(IMG);
    r.r1.runs += 1;
    if (!finished || (await status()) !== "finished" || results.some((x) => x.token !== lastToken && x.outcome === "finished") || left.length) {
      r.r1.bad.push(`#${loop} ${JSON.stringify({ finished, status: await status(), results, left })}`);
    }
    // R8: the outline on its element, measured against the element itself.
    await canvasStill(page, (await canvasFrame(page)).locator(`[data-eod-address="${IMG}"]`).first());
    const outline = await page.locator('div[aria-hidden][style*="solid var(--color-orange)"]').first().boundingBox();
    const onScreen = await (await canvasFrame(page)).locator(`[data-eod-address="${IMG}"]`).first().boundingBox();
    r.r8.runs += 1;
    const close =
      !!outline && !!onScreen &&
      Math.abs(outline.x - onScreen.x) <= 2 && Math.abs(outline.y - onScreen.y) <= 2 &&
      Math.abs(outline.width - onScreen.width) <= 2 && Math.abs(outline.height - onScreen.height) <= 2;
    if (!close) r.r8.bad.push(`#${loop} ${JSON.stringify({ outline, onScreen })}`);
    await agreeAfter(`R1 #${loop}`);

    /* R2a — a canvas click mid-Replay */
    await select(ROW0);
    await play("all");
    const hovering = await until(
      async () => (await (await canvasFrame(page)).locator(`[data-eod-address="${ROW0}"][data-eod-replay-hover]`).count()) > 0,
      6_000,
    );
    const frame2 = await canvasFrame(page);
    await clickCanvasNode(page, frame2.locator(`[data-eod-address="${ROW1}"]`).first(), "own");
    const moved = (await waitForInspector(page, ROW1)) === ROW1;
    const statusNow = await status();
    await quietFor(page, REPLAY_QUIET_MS, "the rest of the hover phase: nothing may report now");
    r.r2a.runs += 1;
    const leftA = await leftovers();
    if (!hovering || !moved || statusNow !== "" || (await status()) !== "" || leftA.length) {
      r.r2a.bad.push(`#${loop} ${JSON.stringify({ hovering, moved, statusNow, later: await status(), leftA })}`);
    }
    await motionTab().click();
    await agreeAfter(`R2a #${loop}`);

    /* R2b — a Layers click mid-Replay */
    await select(IMG);
    await play("parallax");
    // Into the sweep: the picture is running Replay's own animation (a
    // script-made one — a CSS animation or transition is something else).
    const sweeping = await until(
      async () =>
        (await (await canvasFrame(page))
          .locator(`[data-eod-address="${IMG}"]`)
          .first()
          .evaluate((node) =>
            node
              .getAnimations()
              .some((a) => a.playState === "running" && !(a instanceof CSSAnimation) && !(a instanceof CSSTransition)),
          )) === true,
      3_000,
    );
    const row = page.locator(`aside[aria-label='Page structure'] [data-layer-row="section:${TEXT}"]`);
    await row.click();
    const movedB = (await waitForInspector(page, `section:${TEXT}`)) === `section:${TEXT}`;
    const statusB = await status();
    await quietFor(page, REPLAY_QUIET_MS, "the rest of the sweep: nothing may report now");
    const leftB = await leftovers(IMG);
    r.r2b.runs += 1;
    if (!sweeping || !movedB || statusB !== "" || (await status()) !== "" || leftB.length) {
      r.r2b.bad.push(`#${loop} ${JSON.stringify({ sweeping, movedB, statusB, later: await status(), leftB })}`);
    }
    await motionTab().click();
    await agreeAfter(`R2b #${loop}`);

    /* R3 — a direct edit mid-Replay */
    await select(TITLE);
    const [beforeEdit] = await sql<{ draft: { title: { en: string } } }[]>`select draft from page_sections where id = ${TEXT}`;
    await play("entrance");
    const split = await until(
      async () => (await (await canvasFrame(page)).locator(`[data-eod-address="${TITLE}"] [data-m-w]`).count()) > 0,
      5_000,
    );
    const heading = (await canvasFrame(page)).locator(`[data-eod-address="${TITLE}"]`).first();
    await clickCanvasNode(page, heading, "own", { double: true });
    const editing = await until(async () => (await heading.getAttribute("contenteditable")) === "plaintext-only", 8_000);
    const whole = await heading.evaluate((n) => ({ words: n.querySelectorAll("[data-m-w]").length, marked: n.hasAttribute("data-m-words") }));
    await page.keyboard.press("End");
    await page.keyboard.type(" R3");
    await page.keyboard.press("Enter");
    const wanted = `${beforeEdit!.draft.title.en} R3`;
    const saved = await until(async () => {
      const [row3] = await sql<{ draft: { title: { en: string } } }[]>`select draft from page_sections where id = ${TEXT}`;
      return row3!.draft.title.en === wanted;
    }, 15_000);
    // The row is committed a moment before the editor has the answer and has
    // redrawn the canvas; what follows reads the editor, so wait for that.
    await editorIdle(page);
    const [afterEdit] = await sql<{ draft: Record<string, unknown> }[]>`select draft from page_sections where id = ${TEXT}`;
    r.r3.runs += 1;
    if (!split || !editing || whole.words !== 0 || whole.marked || !saved || /span|data-m|aria-hidden/.test(JSON.stringify(afterEdit!.draft))) {
      r.r3.bad.push(`#${loop} ${JSON.stringify({ split, editing, whole, saved })}`);
    }
    await agreeAfter(`R3 #${loop}`);

    /* R4 — a page switch mid-Replay */
    await select(`section:${WHY}`);
    await play("all");
    await page.selectOption("#ve-page", "home");
    await canvasOn("home", "en");
    await quietFor(page, REPLAY_QUIET_MS, "longer than what was left of the Replay");
    const homeLeft = await leftovers();
    const homeStatus = await status();
    await page.selectOption("#ve-page", "about");
    await canvasOn("about", "en");
    await canvasStill(page, (await canvasFrame(page)).locator(`[data-eod-address="section:${WHY}"]`).first(), 15_000).catch(() => undefined);
    const aboutLeft = await leftovers();
    r.r4.runs += 1;
    if (homeLeft.length || homeStatus !== "" || aboutLeft.length) r.r4.bad.push(`#${loop} ${JSON.stringify({ homeLeft, homeStatus, aboutLeft })}`);

    /* R5 — a language switch mid-Replay */
    await select(`section:${WHY}`);
    await play("all");
    await page.getByRole("group", { name: "Canvas language" }).getByRole("button").nth(1).click();
    await canvasOn("about", "ar");
    await quietFor(page, REPLAY_QUIET_MS, "longer than what was left of the Replay");
    const arLeft = await leftovers();
    const arStatus = await status();
    await page.getByRole("group", { name: "Canvas language" }).getByRole("button").nth(0).click();
    await canvasOn("about", "en");
    r.r5.runs += 1;
    if (arLeft.length || arStatus !== "") r.r5.bad.push(`#${loop} ${JSON.stringify({ arLeft, arStatus })}`);

    /* R6 — a device switch mid-Replay */
    await select(IMG);
    await play("parallax");
    await page.getByRole("group", { name: "Canvas width" }).getByRole("button", { name: /^Tablet/ }).click();
    await quietFor(page, REPLAY_QUIET_MS, "past the sweep's own length (REPLAY_LIMITS.sweepMs, 1.8 s)");
    const tabletLeft = await leftovers(IMG);
    const tabletShows = await inspectorAddress(page);
    const tabletStatus = await status();
    const width = await (await canvasFrame(page)).evaluate(() => window.innerWidth);
    r.r6.runs += 1;
    if (tabletLeft.length || tabletShows !== IMG || !["", "finished", "cancelled"].includes(tabletStatus) || width !== 834) {
      r.r6.bad.push(`#${loop} ${JSON.stringify({ tabletLeft, tabletShows, tabletStatus, width })}`);
    }
    await agreeAfter(`R6 #${loop}`);
    await page.getByRole("group", { name: "Canvas width" }).getByRole("button", { name: /^Desktop/ }).click();
    await until(async () => (await (await canvasFrame(page)).evaluate(() => window.innerWidth)) === 1440, 10_000);

    /* R7 — a canvas reload mid-Replay */
    await select(`section:${WHY}`);
    await play("all");
    await page.getByRole("button", { name: /Reload/ }).first().click();
    await ready();
    await quietFor(page, REPLAY_QUIET_MS, "longer than what was left of the Replay");
    const reloadLeft = await leftovers();
    const reloadStatus = await status();
    r.r7.runs += 1;
    if (reloadLeft.length || reloadStatus !== "") r.r7.bad.push(`#${loop} ${JSON.stringify({ reloadLeft, reloadStatus })}`);
    console.log(`· loop ${loop} done`);
  }

  // R3 types on purpose, into the rich-text section; the why-us and
  // image-text sections are only ever replayed and selected, so every column
  // of theirs must be exactly as it was.
  const untouched = (await untouchedState()) === stateBefore;

  const line = (t: Tally) => `${t.runs - t.bad.length}/${t.runs}`;
  const why = (t: Tally) => t.bad.slice(0, 2).join(" | ");
  say(`R1. repeated Replay: only the last request reports, it finishes, the node is at rest (${line(r.r1)})`, r.r1.bad.length === 0, why(r.r1));
  say(`R2a. a canvas click mid-Replay stops it, restores the node, and nothing stale arrives (${line(r.r2a)})`, r.r2a.bad.length === 0, why(r.r2a));
  say(`R2b. a Layers selection mid-Replay does the same (${line(r.r2b)})`, r.r2b.bad.length === 0, why(r.r2b));
  say(`R3. a direct edit mid-Replay: the words go back before typing, and plain text is saved (${line(r.r3)})`, r.r3.bad.length === 0, why(r.r3));
  say(`R4. a page switch mid-Replay: no stale status, no artefact on either page (${line(r.r4)})`, r.r4.bad.length === 0, why(r.r4));
  say(`R5. a language switch mid-Replay: no stale status, no artefact (${line(r.r5)})`, r.r5.bad.length === 0, why(r.r5));
  say(`R6. a device switch mid-Replay: nothing left behind, the selection kept, the status about it (${line(r.r6)})`, r.r6.bad.length === 0, why(r.r6));
  say(`R7. a canvas reload mid-Replay: no stale status, no artefact (${line(r.r7)})`, r.r7.bad.length === 0, why(r.r7));
  say(`R8. after a Replay the selection outline sits on its element (${line(r.r8)})`, r.r8.bad.length === 0, why(r.r8));
  say(`R9. Inspector, canvas and Layers agree on the selection after every step (${line(r.r9)})`, r.r9.bad.length === 0, why(r.r9));
  say("R10. Replay wrote nothing: the sections only replayed and selected are exactly as they were", untouched);
  say("R11. no page errors in the editor", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
