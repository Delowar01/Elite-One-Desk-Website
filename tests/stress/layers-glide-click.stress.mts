/**
 * Batch 26 stress: a click on the canvas that begins while a Layers selection
 * is still gliding — the step route-services stopped at in CI 37952610450.
 *
 * Selecting a region from Layers brings it into view with a smooth scroll of
 * the canvas: on a service's page, the request form, y 0 → 463 in about 440
 * ms. `clickCanvasNode` used to decide whether its own node needed scrolling
 * once, before it waited for the canvas to hold still. A decision taken in
 * the glide's first frames found the hero title (178–261) still on the
 * canvas; the glide then carried it off, no point of it was left on screen,
 * and the helper reported it unreachable while the Inspector stayed on the
 * request form. Locally the decision fell 215–300 ms into the glide, past
 * the title, and the instant scroll saved it; on the faster CI runner it fell
 * earlier. It now waits the glide out first, and checks again after every
 * scroll.
 *
 * Here the glide is held at its start until the script lets it go, and the
 * click follows at once, so every round has the helper start inside a glide
 * that has only just begun — the CI case, on any machine. With the helper as
 * it was, 0 of 6 such rounds selected the title, each one exactly as CI
 * failed; with the helper as it is, 6 of 6.
 *
 *   G1  a click begun as a Layers glide sets off selects its node
 *   G2  …and straight after a Layers selection, with nothing held
 *   G3  on a canvas at rest, the node is selected from off the canvas and on it
 *   G4  no page errors in the editor
 *
 *   STRESS_LOOPS=3
 */
import type { Frame, Page } from "playwright";

import { canvasFrame, editorSettled, selectCanvasNode, selectFromLayers } from "../browser/canvas";
import { launchChromium } from "../browser/harness";
import { giveFresh } from "../helpers/fixtures";
import { connect, dropDatabase } from "../helpers/pg";
import { startServer } from "../helpers/server";
import { signIn } from "../helpers/session";

const PORT = 3824;
const LOOPS = Number(process.env.STRESS_LOOPS ?? 3);
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

/**
 * In the canvas only: a smooth `scrollIntoView` — the one the bridge makes for
 * a Layers selection — is held while `hold` is set and made when the script
 * releases it; and the deepest the canvas has scrolled is kept, so a round
 * can tell that a glide really happened.
 */
const GLIDE = `
  if (location.search.includes("editor=1")) {
    const scrollIntoView = Element.prototype.scrollIntoView;
    const glide = { hold: false, held: [], deepest: 0 };
    window.__eodGlide = glide;
    Element.prototype.scrollIntoView = function (options) {
      if (glide.hold && options && options.behavior === "smooth") {
        glide.held.push([this, options]);
        return;
      }
      return scrollIntoView.apply(this, arguments);
    };
    window.__eodReleaseGlide = () => {
      glide.hold = false;
      const held = glide.held.splice(0);
      for (const [element, options] of held) scrollIntoView.call(element, options);
      return held.length;
    };
    addEventListener("scroll", () => { glide.deepest = Math.max(glide.deepest, Math.round(scrollY)); }, { passive: true });
  }
`;

const browser = await launchChromium();
const database = giveFresh("layers_glide_click_stress");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);
  const origin = server.origin;

  // The service route-services walks first: the first published service of the first category.
  const [main] = await sql<{ id: number }[]>`
    select distinct on (c.sort_order, c.id) s.id
      from services s join service_categories c on c.id = s.category_id
     where s.is_published and c.is_published
     order by c.sort_order, c.id, s.sort_order, s.id`;
  if (!main) throw new Error("the fixture has no published service in a published category");
  const HERO = `serviceHero:${main.id}/field:title`;
  const REQUEST = `serviceRequest:${main.id}`;

  const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
  await context.addInitScript({ content: "window.__name = window.__name || ((fn) => fn);" });
  await context.addInitScript({ content: GLIDE });
  const page: Page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message.slice(0, 160)));

  /** A fresh editor on the service's page, settled. */
  const open = async (): Promise<Frame> => {
    await page.goto(`${origin}/admin/visual-editor?route=service:${main.id}&lang=en&device=desktop`, { waitUntil: "load" });
    if (!(await editorSettled(page, 60_000))) throw new Error("the editor never settled");
    return canvasFrame(page);
  };
  type Pick = Awaited<ReturnType<typeof selectCanvasNode>>;
  const missed = (pick: Pick) =>
    `${pick.shows || "nothing"} selected${pick.unreachable ? ` (${pick.unreachable})` : pick.landing ? ` (landed on ${pick.landing.resolved} at ${pick.landing.x},${pick.landing.y})` : ""}`;

  type Tally = { runs: number; bad: string[] };
  const tally = (): Tally => ({ runs: 0, bad: [] });
  const held = tally();
  const straight = tally();
  const atRest = tally();

  for (let loop = 1; loop <= LOOPS; loop += 1) {
    // G1: the glide held until the Inspector shows the request form, then let go and clicked through at once.
    {
      const frame = await open();
      await frame.evaluate("window.__eodGlide.hold = true");
      await selectFromLayers(page, REQUEST);
      const released = (await frame.evaluate("window.__eodReleaseGlide()")) as number;
      const pick = await selectCanvasNode(page, HERO);
      const deepest = (await frame.evaluate("window.__eodGlide.deepest")) as number;
      held.runs += 1;
      if (released !== 1) held.bad.push(`#${loop} the Layers selection asked for ${released} glides, not one`);
      else if (deepest === 0) held.bad.push(`#${loop} the canvas never moved: there was no glide to click through`);
      else if (!pick.ok) held.bad.push(`#${loop} ${missed(pick)}, the canvas having glided to ${deepest}`);
    }
    // G2: the same two steps as the probe takes them, nothing held.
    {
      await open();
      await selectFromLayers(page, REQUEST);
      const pick = await selectCanvasNode(page, HERO);
      straight.runs += 1;
      if (!pick.ok) straight.bad.push(`#${loop} ${missed(pick)}`);
    }
    // G3: a canvas at rest — the title scrolled far off it first, then where the page opens.
    for (const where of ["off the canvas", "on the canvas"]) {
      const frame = await open();
      if (where === "off the canvas") {
        await frame.evaluate(`window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" })`);
        await editorSettled(page, 30_000);
      }
      const pick = await selectCanvasNode(page, HERO);
      atRest.runs += 1;
      if (!pick.ok) atRest.bad.push(`#${loop} ${where}: ${missed(pick)}`);
    }
    console.log(`· loop ${loop} done`);
  }

  const line = (t: Tally) => `${t.runs - t.bad.length}/${t.runs}`;
  const first3 = (t: Tally) => t.bad.slice(0, 3).join(" | ");
  say(`G1. a click begun as a Layers glide sets off selects its node (${line(held)})`, held.bad.length === 0, first3(held));
  say(`G2. …and straight after a Layers selection, with nothing held (${line(straight)})`, straight.bad.length === 0, first3(straight));
  say(`G3. on a canvas at rest, the node is selected from off the canvas and on it (${line(atRest)})`, atRest.bad.length === 0, first3(atRest));
  say("G4. no page errors in the editor", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
