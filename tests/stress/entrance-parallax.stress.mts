/**
 * Batch 19A stress: an entrance handing over to parallax, measured at every
 * frame, many times, at every width — motion-15b check 11 turned into a loop.
 *
 * The composition is the probe's: the About page's image-text call to action
 * enters with a slow fade-up and drifts with subtle parallax. Each run parks
 * the button just below the fold with an instant scroll, waits until the page
 * has arrived and held still, then wheels it past the reveal line and records
 * `translate` and the runtime's `--m-py` on every animation frame. Nothing is
 * redone: a park that does not land is E1's failure, not a reason to reload.
 *
 *   E1  every park lands below the reveal line, with the page still
 *   E2  deterministic initial state: waiting = entrance offset + drift
 *   E3  the entrance runs on every run — the check-11 intermittency
 *   E4  no snap as the entrance starts
 *   E5  no snap as it hands over to the drift (≤ 1 px between two frames)
 *   E6  at rest the element sits exactly on its drift (≤ 0.6 px), every frame
 *   E7  the drift never passes its own distance (subtle: 12 px)
 *   E8  no horizontal overflow at any width
 *   E9  one scroll listener for every drifting element
 *   E10 reduced motion: shown at once, no drift, no animation
 *
 *   STRESS_LOOPS=10 (per width)
 *
 * The page carries the probe's whole About composition, not only this button,
 * so the layout and the work around it are the probe's too.
 */
import type { Page } from "playwright";

import { callAction } from "../helpers/action";
import { giveFresh } from "../helpers/fixtures";
import { connect, dropDatabase } from "../helpers/pg";
import { startServer } from "../helpers/server";
import { signIn } from "../helpers/session";
import { launchChromium } from "../browser/harness";

const PORT = 3806;
const LOOPS = Number(process.env.STRESS_LOOPS ?? 10);
const WIDTHS = { desktop: { width: 1440, height: 900 }, tablet: { width: 900, height: 1000 }, mobile: { width: 390, height: 844 } };
const SUBTLE = 12;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("entrance_parallax_stress");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);
  const origin = server.origin;

  /* --- the probe's About composition, published ------------------------- */
  const [about] = await sql<{ id: number }[]>`select id from pages where slug = 'about'`;
  const rows = await sql<{ id: number; block_type: string; published: Record<string, unknown> }[]>`
    select id, block_type, published from page_sections where page_id = ${about!.id} order by position`;
  const byType = Object.fromEntries(rows.map((r) => [r.block_type, r])) as Record<string, (typeof rows)[number]>;
  const points = (byType["why-us"]!.published.points as { _id: string }[]).map((p) => p._id);
  const doc = (section: Record<string, unknown> = {}, nodes: Record<string, unknown> = {}) => ({ v: 1, section, nodes });
  const setDraft = async (id: number, value: unknown) =>
    sql`update page_sections set draft_motion_config = ${sql.json(value as never)}, draft_animation = 'fade-up' where id = ${id}`;
  await setDraft(byType["rich-text"]!.id, doc({}, { "field:title": { base: { entrance: "fade-up", textReveal: "words", parallax: "subtle" } } }));
  await setDraft(
    byType["why-us"]!.id,
    doc({ base: { entrance: "blur", duration: "cinematic", delay: 1500 } }, {
      "field:title": { base: { textReveal: "words" }, mobile: { textReveal: "none" } },
      "field:points": { base: { parallax: "medium" } },
      [`field:points/item:${points[0]}`]: { base: { hover: "lift" } },
      [`field:points/item:${points[1]}`]: { base: { hover: "scale" } },
    }),
  );
  await setDraft(
    byType["image-text"]!.id,
    doc({}, {
      "field:image": { base: { entrance: "blur", parallax: "strong", hover: "zoom" }, mobile: { parallax: "none" } },
      "field:ctaLabel": { base: { entrance: "fade-up", duration: "slow", parallax: "subtle", hover: "nudge" } },
    }),
  );
  await setDraft(
    byType["final-cta"]!.id,
    doc({}, { "field:title": { base: { entrance: "mask", direction: "up", parallax: "subtle" }, tablet: { parallax: "strong" }, mobile: { parallax: "medium" } } }),
  );
  await setDraft(byType["stats"]!.id, doc({}, { "field:items": { base: { entrance: "fade-up", stagger: "tight" } } }));
  await sql`update page_sections set draft_styles = ${sql.json({
    v: 1,
    nodes: { [`field:points/item:${points[0]}`]: { base: { glow: "soft" } }, "field:title": { base: { opacity: 0.5 } } },
  } as never)} where id = ${byType["why-us"]!.id}`;
  await sql`update page_sections set draft = jsonb_set(published, '{title}', ${sql.json({ en: "Plan,  book — travel; done!", ar: "خطط، احجز — سافر؛ انتهى!" } as never)})
             where id = ${byType["rich-text"]!.id}`;
  const [page] = await sql<{ id: number; revision: number }[]>`select id, revision from pages where slug = 'about'`;
  const form = new FormData();
  form.set("_csrf", owner.csrfToken);
  form.set("pageId", String(page!.id));
  form.set("expectedRevision", String(page!.revision));
  const published = await callAction<{ ok: boolean }>({
    origin,
    route: "/admin/visual-editor",
    file: "app/(backoffice)/admin/visual-editor/actions.ts",
    action: "publishPageFromEditor",
    args: [form],
    cookie: owner.cookie,
  });
  if (published.value?.ok !== true) throw new Error("the About page could not be published");

  const CTA = `[data-section="image-text"] a.btn`;
  type Frame = { y: number; py: number; animating: number; shown: boolean };

  /** Loads /about and waits, bounded, until the runtime is watching and the page's own assets are in. */
  const ready = async (p: Page, runtime: "__eodParallax" | "__eodMotion") => {
    await p.goto(`${origin}/about`, { waitUntil: "load" });
    await p.waitForFunction((name) => typeof (window as unknown as Record<string, unknown>)[name] === "function", runtime, {
      timeout: 20_000,
    });
    await p.evaluate(async () => {
      await Promise.race([
        Promise.all([
          document.fonts.ready,
          ...[...document.images]
            .filter((image) => image.loading !== "lazy" && !image.complete)
            .map((image) => new Promise((resolve) => image.addEventListener("load", resolve, { once: true }))),
        ]),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    });
  };
  /** Three animation frames with the page and the button both still, or a timeout (5 s). */
  const holdsStill = (p: Page) =>
    p.evaluate(
      (selector) =>
        new Promise<{ still: boolean; scrollY: number; top: number }>((resolve) => {
          const element = document.querySelector(selector) as HTMLElement;
          const read = () => ({ scrollY: Math.round(window.scrollY), top: Math.round(element.getBoundingClientRect().top) });
          let last = read();
          let same = 0;
          const started = performance.now();
          const tick = () => {
            const now = read();
            same = now.scrollY === last.scrollY && now.top === last.top ? same + 1 : 0;
            last = now;
            if (same >= 3) resolve({ still: true, ...now });
            else if (performance.now() - started > 5000) resolve({ still: false, ...now });
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
      CTA,
    );

  const tally = {
    runs: 0,
    parkFailures: [] as string[],
    initial: [] as string[],
    missed: [] as string[],
    worstStart: 0,
    startBound: [] as string[],
    worstLanding: 0,
    worstRest: 0,
    worstDrift: 0,
    overflow: [] as string[],
    listeners: [] as string[],
  };

  for (const [width, viewport] of Object.entries(WIDTHS)) {
    for (let run = 1; run <= LOOPS; run += 1) {
      const context = await browser.newContext({ viewport });
      await context.addInitScript({ content: "window.__name = window.__name || ((fn) => fn);" });
      const p = await context.newPage();
      const label = `${width} #${run}`;
      tally.runs += 1;

      /* One park per run, never redone: the probe re-parks on a fresh load
         (a Batch 16 safeguard, reported there as `parkings`), and this loop
         is where that safeguard is shown to be unneeded — an instant scroll
         onto a page that has stopped moving lands every time. */
      await ready(p, "__eodParallax");
      const target = await p.evaluate((selector) => {
        const element = document.querySelector(selector) as HTMLElement;
        const top = Math.round(element.getBoundingClientRect().top + window.scrollY - window.innerHeight + 20);
        window.scrollTo({ top, behavior: "instant" });
        return top;
      }, CTA);
      const still = await holdsStill(p);
      const line = viewport.height * 0.92;
      const shown = await p.evaluate((selector) => document.querySelector(selector)!.hasAttribute("data-shown"), CTA);
      const parked = still.still && Math.abs(still.scrollY - target) <= 1 && still.top > line && !shown;
      const park = JSON.stringify({ target, ...still, line, shown });
      if (!parked) {
        tally.parkFailures.push(`${label} ${park}`);
        await context.close();
        continue;
      }

      /* E2: what waits is the entrance's own offset plus the drift */
      const waiting = await p.evaluate((selector) => {
        const element = document.querySelector(selector) as HTMLElement;
        const style = getComputedStyle(element);
        const [, y = "0px"] = style.translate === "none" ? [] : style.translate.split(" ");
        return {
          y: Number.parseFloat(y),
          py: Number.parseFloat(element.style.getPropertyValue("--m-py")) || 0,
          my: Number.parseFloat(style.getPropertyValue("--m-y")) || 0,
          opacity: Number(style.opacity),
        };
      }, CTA);
      if (!(Math.abs(waiting.y - (waiting.my + waiting.py)) <= 0.6 && waiting.my !== 0 && waiting.opacity < 0.05)) {
        tally.initial.push(`${label} ${JSON.stringify(waiting)}`);
      }

      /* record every frame, then bring it in */
      await p.evaluate((selector) => {
        const element = document.querySelector(selector) as HTMLElement;
        const frames: { y: number; py: number; animating: number; shown: boolean }[] = [];
        (window as unknown as { __frames: typeof frames }).__frames = frames;
        const record = () => {
          const style = getComputedStyle(element);
          const [, y = "0px"] = style.translate === "none" ? [] : style.translate.split(" ");
          frames.push({
            y: Number.parseFloat(y),
            py: Number.parseFloat(element.style.getPropertyValue("--m-py")) || 0,
            animating: element.getAnimations().length,
            shown: element.getAttribute("data-shown") === "true",
          });
          if (frames.length < 240) requestAnimationFrame(record);
        };
        requestAnimationFrame(record);
      }, CTA);
      const from = await p.evaluate(() => Math.round(window.scrollY));
      await p.mouse.move(viewport.width / 2, viewport.height / 2);
      await p.mouse.wheel(0, 160);
      await p.waitForFunction(() => (window as unknown as { __frames: unknown[] }).__frames.length >= 240, undefined, { timeout: 20_000 });
      const to = await p.evaluate(() => Math.round(window.scrollY));
      const frames = await p.evaluate(() => (window as unknown as { __frames: Frame[] }).__frames);

      const first = frames.findIndex((frame) => frame.animating > 0);
      const end = frames.findIndex((frame, index) => index > 0 && frames[index - 1]!.animating > 0 && frame.animating === 0);
      if (first < 1 || end < 1) {
        tally.missed.push(`${label} first=${first} end=${end} scrolled ${from}→${to}`);
      } else {
        const start = Math.abs(frames[first]!.y - frames[first - 1]!.y);
        tally.worstStart = Math.max(tally.worstStart, start);
        if (start > Math.abs(waiting.my) * 0.5) tally.startBound.push(`${label} ${start.toFixed(2)}px of ${waiting.my}px`);
        tally.worstLanding = Math.max(tally.worstLanding, Math.abs(frames[end]!.y - frames[end - 1]!.y));
        for (const frame of frames.slice(end)) tally.worstRest = Math.max(tally.worstRest, Math.abs(frame.y - frame.py));
      }
      for (const frame of frames) tally.worstDrift = Math.max(tally.worstDrift, Math.abs(frame.py));

      const wide = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      if (wide > 0) tally.overflow.push(`${label} +${wide}px`);
      const stats = await p.evaluate(() => (window as unknown as { __eodParallax?: () => { listening: number } }).__eodParallax?.() ?? null);
      if (stats?.listening !== 1) tally.listeners.push(`${label} ${JSON.stringify(stats)}`);
      await context.close();
    }
    console.log(`· ${width}: ${LOOPS} runs`);
  }

  /* --- reduced motion ----------------------------------------------------- */
  const reducedProblems: string[] = [];
  for (const [width, viewport] of Object.entries(WIDTHS)) {
    const context = await browser.newContext({ viewport, reducedMotion: "reduce" });
    await context.addInitScript({ content: "window.__name = window.__name || ((fn) => fn);" });
    const p = await context.newPage();
    await ready(p, "__eodMotion");
    await p.evaluate((selector) => {
      const element = document.querySelector(selector) as HTMLElement;
      window.scrollTo({ top: element.getBoundingClientRect().top + window.scrollY - window.innerHeight / 2, behavior: "instant" });
    }, CTA);
    await holdsStill(p);
    await p.mouse.wheel(0, 120);
    await holdsStill(p);
    const state = await p.evaluate((selector) => {
      const element = document.querySelector(selector) as HTMLElement;
      const style = getComputedStyle(element);
      return {
        translate: style.translate,
        opacity: style.opacity,
        py: element.style.getPropertyValue("--m-py"),
        animating: element.getAnimations().filter((a) => a.playState === "running").length,
      };
    }, CTA);
    if (state.translate !== "none" || state.opacity !== "1" || state.py !== "" || state.animating !== 0) {
      reducedProblems.push(`${width} ${JSON.stringify(state)}`);
    }
    await context.close();
  }

  const n = tally.runs;
  const parkedRuns = n - tally.parkFailures.length;
  say(`E1. every park landed below the reveal line with the page still (${parkedRuns}/${n})`, tally.parkFailures.length === 0, tally.parkFailures.slice(0, 3).join(" | "));
  say(`E2. deterministic initial state: waiting = entrance offset + drift (${parkedRuns - tally.initial.length}/${parkedRuns})`, tally.initial.length === 0, tally.initial.slice(0, 3).join(" | "));
  say(`E3. the entrance ran on every run — missed ${tally.missed.length}/${parkedRuns}`, tally.missed.length === 0 && parkedRuns > 0, tally.missed.slice(0, 3).join(" | "));
  say(`E4. no snap as the entrance starts (largest first step ${tally.worstStart.toFixed(2)} px)`, tally.startBound.length === 0, tally.startBound.slice(0, 3).join(" | "));
  say(`E5. no snap at the hand-over (largest jump ${tally.worstLanding.toFixed(2)} px, allowed 1)`, tally.worstLanding <= 1);
  say(`E6. at rest the element sits on its drift (largest gap ${tally.worstRest.toFixed(2)} px, allowed 0.6)`, tally.worstRest <= 0.6);
  say(`E7. the drift stays within subtle's ${SUBTLE} px (largest ${tally.worstDrift.toFixed(2)} px)`, tally.worstDrift <= SUBTLE + 0.5);
  say("E8. no horizontal overflow at any width", tally.overflow.length === 0, tally.overflow.slice(0, 3).join(" | "));
  say("E9. one scroll listener for every drifting element", tally.listeners.length === 0, tally.listeners.slice(0, 3).join(" | "));
  say("E10. reduced motion: shown at once, no drift, no animation, at every width", reducedProblems.length === 0, reducedProblems.join(" | "));
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
