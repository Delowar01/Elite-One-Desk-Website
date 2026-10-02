/**
 * Driving the Visual Editor's canvas from a probe — clicking a node and
 * knowing what was selected — without racing the page.
 *
 * Three findings of Batch 19A are the reason this file exists, and each
 * helper below answers one of them:
 *
 * 1. **Playwright's `position` is not scaled for the canvas.** The canvas is
 *    an iframe drawn with `transform: scale(…)`, and Playwright adds a
 *    `position` offset to the element's on-screen corner in *page* pixels:
 *    asked for 300 px into a heading at scale 0.739, the pointer landed 406 px
 *    in. `clickCanvasNode` measures the point inside the canvas and converts
 *    it with the element's own on-screen box.
 *
 * 2. **Playwright re-scrolls between measuring and clicking.** When a target
 *    is still moving (an entrance, a glide), `locator.click()` retries, and
 *    each retry scrolls the element into view with `element.scrollIntoView`
 *    — which the site's `html { scroll-behavior: smooth }` turns into a
 *    glide — then computes the point and clicks while the page slides under
 *    it. Its hit check retargets both the target and the hit to the nearest
 *    link or button, so a click that lands on a Quick Links card's text layer
 *    instead of its title is accepted, and the editor (correctly) selects the
 *    picture behind that layer. `clickCanvasNode` scrolls instantly, waits
 *    until the canvas and the editor both hold still, clicks once, and reports
 *    where the pointer actually landed.
 *
 * 3. **The Inspector follows a click asynchronously.** The canvas posts the
 *    selection and the editor renders it a few milliseconds later. A probe
 *    that reads the Inspector once, straight after the click, can read the
 *    *previous* node — and the old step-out loop then pressed "Select what
 *    contains this" on the node the click had just selected, walking it out to
 *    its section (motion-15b check 34). `selectCanvasNode` waits, bounded, for
 *    the Inspector to answer, and steps out only from an answer it has seen.
 */
import type { Frame, Locator, Page } from "playwright";

/** The canvas document: the preview page loaded with `editor=1`. */
export async function canvasFrame(page: Page, timeoutMs = 30_000): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const found = page.frames().find((frame) => frame.url().includes("editor=1"));
    if (found) return found;
    if (Date.now() > deadline) throw new Error("the Visual Editor canvas frame never attached");
    await page.waitForTimeout(50);
  }
}

/**
 * Until the editor has settled after it loaded or reloaded the canvas: the
 * status reads Ready, the canvas document has finished loading, its scroll
 * position has held for five frames and nothing finite is animating in it.
 * Bounded; returns whether it settled rather than throwing, because a long
 * entrance still running is no reason to stop a probe — only to wait for it.
 */
export async function editorSettled(page: Page, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  const ready = page.getByText("Ready", { exact: true });
  let why = "the status never read Ready";
  for (;;) {
    const frame = page.frames().find((candidate) => candidate.url().includes("editor=1"));
    if (!(await ready.count())) why = "the status does not read Ready";
    else if (!frame) why = "the canvas frame is not attached";
    else {
      const verdict = await frame
        .evaluate(() => {
          // Anonymous, so tsx gives it no `__name` of its own, and defines the
          // shim the named functions below need (see `shim`).
          const holder = window as unknown as { __name?: unknown };
          holder.__name = holder.__name || ((fn: unknown) => fn);
        })
        .then(() =>
          frame.evaluate(
            () =>
              new Promise<string>((resolve) => {
                if (document.readyState !== "complete") return resolve("the canvas document is still loading");
                let frames = 0;
                let last = `${window.scrollX}:${window.scrollY}`;
                const tick = () => {
                  const now = `${window.scrollX}:${window.scrollY}`;
                  const busy = document
                    .getAnimations()
                    .filter((a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming().endTime as number)).length;
                  if (now !== last) return resolve("the canvas is scrolling");
                  if (busy) return resolve(`${busy} animation(s) running on the canvas`);
                  last = now;
                  frames += 1;
                  if (frames >= 5) resolve("");
                  else requestAnimationFrame(tick);
                };
                requestAnimationFrame(tick);
              }),
          ),
        )
        // A canvas replaced mid-read is simply read again; anything else is said.
        .catch((error: unknown) => `the canvas could not be read: ${String(error instanceof Error ? error.message : error).split("\n")[0]}`);
      if (verdict === "" && (await ready.count())) return true;
      why = verdict || "the status is no longer Ready";
    }
    if (Date.now() > deadline) {
      console.log(`   [settle] the editor did not settle within ${timeoutMs} ms: ${why}`);
      return false;
    }
    await page.waitForTimeout(50);
  }
}

/** The canvas document's address — every reload gives it a new nonce and bridge id. */
export function canvasUrl(page: Page): string {
  return page.frames().find((frame) => frame.url().includes("editor=1"))?.url() ?? "";
}

/**
 * Until the canvas is a different document from `before` and has settled.
 *
 * The one observable end of everything that redraws it — a publication, a
 * discard, a global change, a layout step. The editor re-reads what it needs
 * from the server first and reloads the canvas last, so a notice or a summary
 * that has already changed does not mean the canvas has (Batch 19A). Take
 * `before` with `canvasUrl` just before the action. Bounded; says so when the
 * redraw never came.
 */
export async function canvasRedrawn(page: Page, before: string, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (["", before].includes(canvasUrl(page))) {
    if (Date.now() > deadline) {
      console.log(`   [redraw] the canvas was not reloaded within ${timeoutMs} ms`);
      return false;
    }
    await page.waitForTimeout(50);
  }
  return editorSettled(page, Math.max(5_000, deadline - Date.now()));
}

/**
 * Until the editor has nothing left to save and has redrawn after its last
 * save: the toolbar shows neither "N unsaved" nor "Saving N…", and then the
 * editor settles.
 *
 * A save's answer and the redraw it causes are applied in the same render —
 * the queue marks the buffer clean and reloads the canvas without waiting in
 * between — so once the badge has gone the redraw has begun, and
 * `editorSettled` waits it out. What a database poll cannot say: the row is
 * committed a moment before the browser has the answer (Batch 19A).
 */
export async function editorIdle(page: Page, timeoutMs = 30_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const toolbar = (await page.locator("header").first().innerText().catch(() => "")).replace(/\s+/g, " ");
    const badge = toolbar.match(/\d+ unsaved|Saving \d+…/)?.[0] ?? "";
    if (!badge) break;
    if (Date.now() > deadline) {
      console.log(`   [idle] the toolbar still said "${badge}" after ${timeoutMs} ms`);
      return false;
    }
    await page.waitForTimeout(50);
  }
  return editorSettled(page, Math.max(5_000, deadline - Date.now()));
}

/**
 * Selects `address` from Layers and waits, bounded, for the Inspector to show
 * it, then for the tabs its section's buffer brings. The Motion tab alone was
 * the old signal, and it is no signal at all when something was already
 * selected: the tab is there before the click and after it (Batch 19A).
 */
export async function selectFromLayers(page: Page, address: string, timeoutMs = 25_000): Promise<void> {
  const row = page.locator(`aside[aria-label='Page structure'] [data-layer-row="${address}"]`);
  await row.waitFor({ timeout: timeoutMs });
  await row.click();
  const shows = await waitForInspector(page, address, timeoutMs);
  if (shows !== address) throw new Error(`selecting ${address} from Layers ended on ${shows || "nothing"}`);
  await page.getByRole("tab", { name: /Motion/ }).waitFor({ timeout: timeoutMs });
}

/** The address the Inspector is showing, exactly — never a prefix of it. */
export async function inspectorAddress(page: Page): Promise<string> {
  const codes = await page.locator("aside[aria-label='Inspector'] code").allTextContents();
  // A page section's address, or a dynamic route region's (Batch 21): `service:12/field:intro`.
  return codes.map((text) => text.trim()).find((text) => /^[A-Za-z]+:[1-9][0-9]*(\/|$)/.test(text)) ?? "";
}

/** Waits, bounded, for the Inspector to show `address`. Returns what it shows at the end. */
export async function waitForInspector(page: Page, address: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const shown = await inspectorAddress(page);
    if (shown === address || Date.now() > deadline) return shown;
    await page.waitForTimeout(25);
  }
}

/** Waits, bounded, for the Inspector to show anything other than `previous`. */
export async function waitForInspectorChange(page: Page, previous: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const shown = await inspectorAddress(page);
    if (shown !== previous || Date.now() > deadline) return shown;
    await page.waitForTimeout(25);
  }
}

/**
 * tsx names the functions it compiles (`__name(fn, "fn")`), and a function
 * handed to `evaluate` carries those calls into a page that has no `__name`.
 * Defined here, before each use, so a probe that forgot its init script still
 * works. Harmless where it already exists.
 */
const shim = (target: Locator) =>
  // Anonymous on purpose: tsx adds `__name` only to functions that have a name.
  target.evaluate(() => {
    const holder = window as unknown as { __name?: unknown };
    holder.__name = holder.__name || ((fn: unknown) => fn);
  });

type Box = { x: number; y: number; width: number; height: number };
const sameBox = (a: Box | null, b: Box | null) =>
  Boolean(a && b) &&
  Math.abs(a!.x - b!.x) < 0.5 &&
  Math.abs(a!.y - b!.y) < 0.5 &&
  Math.abs(a!.width - b!.width) < 0.5 &&
  Math.abs(a!.height - b!.height) < 0.5;

/**
 * Waits until `target` holds still — on the canvas and on the editor's screen.
 *
 * Still means: nothing finite is animating on the element, inside it or on
 * anything that contains it (an entrance, a hover transition, a reveal); the
 * canvas has not scrolled for five frames; no entrance on or around it is
 * about to start; and the element's on-screen box —
 * which moves with the editor's own scrolling too — is the same before and
 * after that. Endless animations are ignored: they never settle, and nothing
 * the probes click carries one. Bounded; throws with what was still moving.
 */
export async function canvasStill(page: Page, target: Locator, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let why = "";
  await shim(target);
  for (;;) {
    const before = await target.boundingBox();
    const inside = await target.evaluate(
      (element) =>
        new Promise<{ still: boolean; why: string }>((resolve) => {
          const chain: Element[] = [];
          for (let node: Element | null = element; node; node = node.parentElement) chain.push(node);
          const moving = () =>
            document.getAnimations().filter((animation) => {
              if (animation.playState !== "running") return false;
              const effect = animation.effect as KeyframeEffect | null;
              const node = effect?.target;
              if (!node) return false;
              if (!Number.isFinite(effect!.getComputedTiming().endTime as number)) return false;
              return chain.includes(node) || element.contains(node);
            }).length;
          // An entrance that is about to start: the element, or what holds it,
          // is waiting for its reveal and is already well past the reveal line
          // (the shared observer's root ends 8% above the bottom and needs 8%
          // of the element inside it), so the observer will set it moving
          // within a frame or two. Well past: 20% of it inside, not 8%, so an
          // element sitting on the threshold — which the observer may never
          // reveal without a scroll — is not waited for.
          // Only what its own `data-shown` animates: an advanced entrance
          // (`data-m-reveal`), a staggering list (`data-m-group`) or a legacy
          // reveal (`.reveal`). A row of a staggering list (`data-m-member`) is
          // driven by its list and keeps `data-shown="false"` for good, and a
          // `Reveal` with no entrance never animates at all — neither is ever
          // waited for.
          const waitingFor = () =>
            chain.find((node) => {
              const pending =
                !node.hasAttribute("data-m-member") &&
                (node.hasAttribute("data-m-reveal") || node.hasAttribute("data-m-group") || node.classList.contains("reveal")) &&
                node.getAttribute("data-shown") !== "true";
              if (!pending) return false;
              const rect = node.getBoundingClientRect();
              if (rect.height <= 0) return false;
              const inside = Math.min(rect.bottom, window.innerHeight * 0.92) - Math.max(rect.top, 0);
              return inside / rect.height >= 0.2;
            });
          const describe = (node: Element) => {
            const rect = node.getBoundingClientRect();
            const address = node.getAttribute("data-eod-address");
            const marks = ["data-m-reveal", "data-m-group", "data-m-member"].filter((name) => node.hasAttribute(name)).join(",");
            return `<${node.tagName.toLowerCase()}${address ? ` ${address}` : ""}${marks ? ` ${marks}` : ""} data-shown=${node.getAttribute("data-shown")} top=${Math.round(rect.top)} height=${Math.round(rect.height)} of ${window.innerHeight}>`;
          };
          let frames = 0;
          let last = `${window.scrollX}:${window.scrollY}`;
          const tick = () => {
            const now = `${window.scrollX}:${window.scrollY}`;
            const busy = moving();
            const pending = busy || now !== last ? undefined : waitingFor();
            if (now !== last || busy || pending) {
              resolve({
                still: false,
                why: busy
                  ? `${busy} animation(s) running on or around it`
                  : now !== last
                    ? "the canvas is scrolling"
                    : `an entrance on or around it has not started: ${describe(pending!)}`,
              });
              return;
            }
            last = now;
            frames += 1;
            if (frames >= 5) resolve({ still: true, why: "" });
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );
    const after = await target.boundingBox();
    if (inside.still && sameBox(before, after)) return;
    why = inside.still ? "its box on the editor's screen moved" : inside.why;
    if (Date.now() > deadline) throw new Error(`the canvas did not hold still within ${timeoutMs} ms: ${why}`);
    await page.waitForTimeout(50);
  }
}

/**
 * The same wait for any page, not only the canvas: a public page's element
 * after it was scrolled to (its entrance run, its reveal done) or hovered (its
 * transition over). The name says what it is for there.
 */
export const holdsStill = canvasStill;

/** Where a click in the canvas landed: the element the pointer hit, and the node the editor resolves it to. */
export type Landing = { tag: string; inTarget: boolean; resolved: string | null; x: number; y: number };

/** No point on the node resolves to it: something covers it, or its own children cover it wholly. */
export class Unreachable extends Error {
  constructor() {
    super("no point on this node resolves to it — something covers it, or it is wholly covered by its children");
    this.name = "Unreachable";
  }
}

/**
 * Clicks a canvas node once, the way a person would, and reports where it landed.
 *
 * `at` picks the point: `"center"`, a fraction of the element's box
 * (`{ x: 0.5, y: 0.1 }`), or `"own"` — a point at which the editor's own
 * resolution rule (the nearest `[data-eod-node]`, refined front to back
 * through `elementsFromPoint`, exactly as the bridge does) names this very
 * node. `"own"` is for probes that only need the node selected; a probe that
 * tests the resolution itself must click a raw point instead, or it would be
 * checking the rule against itself.
 *
 * `double` double-clicks instead — the gesture that starts direct editing.
 */
export async function clickCanvasNode(
  page: Page,
  target: Locator,
  at: "center" | "own" | { x: number; y: number } = "center",
  options: { timeoutMs?: number; double?: boolean } = {},
): Promise<Landing> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  await target.waitFor({ state: "visible", timeout: timeoutMs });
  await shim(target);
  // Instantly, and only if it is not already wholly on the canvas: a glide
  // would be the very thing this helper exists to avoid.
  await target.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    if (rect.top < 0 || rect.left < 0 || rect.bottom > window.innerHeight || rect.right > window.innerWidth) {
      element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    }
  });
  await canvasStill(page, target, timeoutMs);

  const inFrame = await target.evaluate(
    (element, where) => {
      const SELECTABLE = "[data-eod-node]";
      const resolve = (x: number, y: number): Element | null => {
        const hit = document.elementFromPoint(x, y);
        const direct = hit?.closest(SELECTABLE) ?? null;
        if (!direct || !direct.querySelector(SELECTABLE)) return direct;
        for (const candidate of document.elementsFromPoint(x, y)) {
          if (candidate === direct) break;
          const inside: Element | null = candidate.closest(SELECTABLE);
          if (inside && inside !== direct && direct.contains(inside)) return inside;
        }
        return direct;
      };
      const rect = element.getBoundingClientRect();
      const box = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
      const onScreen = (x: number, y: number) => x >= 0 && y >= 0 && x < window.innerWidth && y < window.innerHeight;
      if (where === "own") {
        // Of the points that resolve to this node, the one farthest from any
        // node inside it: a child can move between measuring and clicking —
        // the hero's rotating word changes width every 2.4 s inside its
        // headline — and a point beside it would then select the child.
        const inner = [...element.querySelectorAll(SELECTABLE)].map((node) => node.getBoundingClientRect());
        const clearance = (x: number, y: number) =>
          inner.reduce((nearest, box) => {
            const dx = Math.max(box.left - x, 0, x - box.right);
            const dy = Math.max(box.top - y, 0, y - box.bottom);
            return Math.min(nearest, Math.hypot(dx, dy));
          }, Number.POSITIVE_INFINITY);
        const fractions = [0.5, 0.3, 0.7, 0.15, 0.85, 0.05, 0.95];
        let best: { x: number; y: number; room: number } | null = null;
        for (const fy of fractions) {
          for (const fx of fractions) {
            const x = rect.left + rect.width * fx;
            const y = rect.top + rect.height * fy;
            if (!onScreen(x, y) || resolve(x, y) !== element) continue;
            const room = clearance(x, y);
            if (!best || room > best.room) best = { x, y, room };
          }
        }
        return best ? { x: best.x, y: best.y, box } : { x: Number.NaN, y: Number.NaN, box };
      }
      const f = where === "center" ? { x: 0.5, y: 0.5 } : (where as { x: number; y: number });
      return { x: rect.left + rect.width * f.x, y: rect.top + rect.height * f.y, box };
    },
    at,
  );
  if (Number.isNaN(inFrame.x)) throw new Unreachable();

  // The frame point onto the editor's screen, through the element's own
  // on-screen box: that carries the canvas's scale and every scroll offset.
  const screen = await target.boundingBox();
  if (!screen) throw new Error("the node has no box on the editor's screen");
  const scaleX = inFrame.box.width ? screen.width / inFrame.box.width : 1;
  const scaleY = inFrame.box.height ? screen.height / inFrame.box.height : 1;
  const x = screen.x + (inFrame.x - inFrame.box.left) * scaleX;
  const y = screen.y + (inFrame.y - inFrame.box.top) * scaleY;

  await target.evaluate((element) => {
    const SELECTABLE = "[data-eod-node]";
    const holder = window as unknown as { __eodProbeLanding?: unknown };
    holder.__eodProbeLanding = null;
    window.addEventListener(
      "pointerdown",
      (event) => {
        const hit = event.target as Element;
        let resolved: Element | null = hit.closest(SELECTABLE);
        if (resolved && resolved.querySelector(SELECTABLE)) {
          for (const candidate of document.elementsFromPoint(event.clientX, event.clientY)) {
            if (candidate === resolved) break;
            const inside: Element | null = candidate.closest(SELECTABLE);
            if (inside && inside !== resolved && resolved.contains(inside)) {
              resolved = inside;
              break;
            }
          }
        }
        holder.__eodProbeLanding = {
          tag: hit.tagName.toLowerCase(),
          inTarget: element === hit || element.contains(hit),
          resolved: resolved?.getAttribute("data-eod-address") ?? null,
          x: Math.round(event.clientX),
          y: Math.round(event.clientY),
        };
      },
      { capture: true, once: true },
    );
  });
  if (options.double) await page.mouse.dblclick(x, y);
  else await page.mouse.click(x, y);
  const landing = await target.evaluate(
    () => (window as unknown as { __eodProbeLanding?: Landing | null }).__eodProbeLanding ?? null,
  );
  if (!landing) throw new Error("the click never reached the canvas");
  return landing;
}

/**
 * Selects a node on the canvas and waits for the Inspector to say so.
 *
 * A node that no point on the canvas resolves to — a list wholly covered by
 * its rows — is reached the way an editor reaches it: select something
 * inside it, then "Select what contains this", one step at a time, each step
 * taken only after the Inspector has shown the previous one.
 *
 * Returns what the Inspector finally shows and where the click landed, so a
 * caller can say *why* when it is not the node asked for.
 */
export async function selectCanvasNode(
  page: Page,
  address: string,
  timeoutMs = 10_000,
): Promise<{ ok: boolean; shows: string; landing: Landing | null }> {
  const frame = await canvasFrame(page);
  const target = frame.locator(`[data-eod-address="${address}"]`).first();
  await target.waitFor({ state: "attached", timeout: timeoutMs });
  await shim(target);
  const before = await inspectorAddress(page);
  let landing: Landing;
  let clicked = address;
  try {
    landing = await clickCanvasNode(page, target, "own", { timeoutMs });
  } catch (error) {
    // Only a node its own children cover is reached through them; anything
    // else — a canvas that never held still, a click that never arrived — is
    // the caller's failure to see, not a reason to click something else.
    if (!(error instanceof Unreachable)) throw error;
    // Wholly covered by its children: click the first child that can be clicked.
    const child = await target.evaluate((element) => {
      const SELECTABLE = "[data-eod-node]";
      const inside = [...element.querySelectorAll(SELECTABLE)].filter((node) => {
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      return inside[0]?.getAttribute("data-eod-address") ?? null;
    });
    if (!child) return { ok: false, shows: await inspectorAddress(page), landing: null };
    clicked = child;
    landing = await clickCanvasNode(page, frame.locator(`[data-eod-address="${child}"]`).first(), "own", { timeoutMs });
  }
  // The click's own answer first — never a read that could still be the previous node.
  let shows = landing.resolved === before ? await waitForInspector(page, landing.resolved ?? "", timeoutMs) : await waitForInspectorChange(page, before, timeoutMs);
  if (shows !== clicked) shows = await waitForInspector(page, clicked, timeoutMs);
  for (let step = 0; step < 8 && shows !== address && shows.startsWith(`${address}/`); step += 1) {
    await page.getByRole("button", { name: "Select what contains this" }).click();
    shows = await waitForInspectorChange(page, shows, timeoutMs);
  }
  return { ok: shows === address, shows, landing };
}
