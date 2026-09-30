/**
 * Batch 15b acceptance: parallax, hover, word reveal and Replay in a real
 * browser, English and Arabic — the fifty items of §55, numbered as there.
 *
 *   1–10   parallax          11–15  composition     16–24  hover
 *   25–35  word reveal       36–50  Replay
 *
 * Everything is measured from the real pages: public, ordinary Preview and the
 * Visual Editor's canvas, driven through the real editor.
 */
import type { Page } from "playwright";

import { clickCanvasNode, holdsStill, selectCanvasNode, waitForInspector } from "../canvas";
import { callAction } from "../../helpers/action";
import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";
import { quietFor, REPLAY_QUIET_MS, watchNetwork } from "../wait";

const PORT = 3717;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
const WIDTHS = { desktop: { width: 1440, height: 900 }, tablet: { width: 900, height: 1000 }, mobile: { width: 390, height: 844 } };

const browser = await launchChromium();
const database = giveFresh("motion_15b_probe");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);
  const origin = server.origin;
  const cookie = (() => {
    const [name, value] = owner.cookie.split("=");
    return { name: name!, value: value!, domain: "127.0.0.1", path: "/" };
  })();

  const [about] = await sql<{ id: number }[]>`select id from pages where slug = 'about'`;
  const sectionRows = await sql<{ id: number; block_type: string; published: Record<string, unknown> }[]>`
    select id, block_type, published from page_sections where page_id = ${about!.id} order by position`;
  const byType = Object.fromEntries(sectionRows.map((r) => [r.block_type, r])) as Record<string, (typeof sectionRows)[number]>;
  const TEXT = byType["rich-text"]!.id;
  const IMAGE = byType["image-text"]!.id;
  const WHY = byType["why-us"]!.id;
  const CTA = byType["final-cta"]!.id;
  const points = (byType["why-us"]!.published.points as { _id: string }[]).map((p) => p._id);
  const [home] = await sql<{ id: number }[]>`select id from pages where slug = 'home'`;
  const [quick] = await sql<{ id: number; published: Record<string, unknown> }[]>`
    select id, published from page_sections where page_id = ${home!.id} and block_type = 'quick-links'`;

  type Doc = { v: number; section: Record<string, unknown>; nodes: Record<string, unknown> };
  const doc = (section: Record<string, unknown> = {}, nodes: Record<string, unknown> = {}): Doc => ({ v: 1, section, nodes });
  const setDraft = async (id: number, value: Doc) =>
    sql`update page_sections set draft_motion_config = ${sql.json(value as never)}, draft_animation = 'fade-up' where id = ${id}`;
  const until = async (check: () => Promise<boolean>, tries = 100, every = 200) => {
    for (let i = 0; i < tries; i += 1) {
      if (await check()) return true;
      await new Promise((resolve) => setTimeout(resolve, every));
    }
    return false;
  };
  const publishPage = async (slug: string) => {
    const [page] = await sql<{ id: number; revision: number }[]>`select id, revision from pages where slug = ${slug}`;
    const form = new FormData();
    form.set("_csrf", owner.csrfToken);
    form.set("pageId", String(page!.id));
    form.set("expectedRevision", String(page!.revision));
    const result = await callAction<{ ok: boolean }>({
      origin,
      route: "/admin/visual-editor",
      file: "app/(backoffice)/admin/visual-editor/actions.ts",
      action: "publishPageFromEditor",
      args: [form],
      cookie: owner.cookie,
    });
    return result.value?.ok === true;
  };

  /* --- the configuration every public check reads ------------------------ */
  const TITLE_EN = "Plan,  book — travel; done!";
  await sql`update page_sections set draft = jsonb_set(published, '{title}', ${sql.json({ en: TITLE_EN, ar: "خطط، احجز — سافر؛ انتهى!" } as never)})
             where id = ${TEXT}`;
  await setDraft(TEXT, doc({}, { "field:title": { base: { entrance: "fade-up", textReveal: "words", parallax: "subtle" } } }));
  await setDraft(
    WHY,
    doc({ base: { entrance: "blur", duration: "cinematic", delay: 1500 } }, {
      "field:title": { base: { textReveal: "words" }, mobile: { textReveal: "none" } },
      "field:points": { base: { parallax: "medium" } },
      [`field:points/item:${points[0]}`]: { base: { hover: "lift" } },
      [`field:points/item:${points[1]}`]: { base: { hover: "scale" } },
    }),
  );
  await setDraft(
    IMAGE,
    doc({}, {
      "field:image": { base: { entrance: "blur", parallax: "strong", hover: "zoom" }, mobile: { parallax: "none" } },
      "field:ctaLabel": { base: { entrance: "fade-up", duration: "slow", parallax: "subtle", hover: "nudge" } },
    }),
  );
  await setDraft(
    CTA,
    doc({}, {
      "field:title": { base: { entrance: "mask", direction: "up", parallax: "subtle" }, tablet: { parallax: "strong" }, mobile: { parallax: "medium" } },
      "field:primaryCtaLabel": { base: { hover: "lift", parallax: "subtle" } },
    }),
  );
  const STATS = byType["stats"]!.id;
  await setDraft(STATS, doc({}, { "field:items": { base: { entrance: "fade-up", stagger: "tight" } } }));
  // Batch 14 beside 15b: a glowing row that lifts, and a heading at half
  // strength whose words arrive.
  await sql`update page_sections set draft_styles = ${sql.json({
    v: 1,
    nodes: {
      [`field:points/item:${points[0]}`]: { base: { glow: "soft" } },
      "field:title": { base: { opacity: 0.5 } },
    },
  } as never)} where id = ${WHY}`;
  say("0. the fixture's About page is published with every 15b setting", await publishPage("about"));

  /** tsx names the functions it compiles; the page has no `__name`, so give it one. */
  const NAME_SHIM = "window.__name = window.__name || ((fn) => fn);";
  const contextFor = async (width: keyof typeof WIDTHS, extra: Parameters<typeof browser.newContext>[0] = {}) => {
    const context = await browser.newContext({ viewport: WIDTHS[width], ...extra });
    await context.addCookies([cookie]);
    await context.addInitScript({ content: NAME_SHIM });
    return context;
  };
  const errorsOf = (page: Page, list: string[]) => {
    page.on("pageerror", (error) => list.push(error.message.slice(0, 160)));
  };
  /** Every drifting element's offset, as the runtime wrote it and as it renders. */
  const offsets = (page: Page) =>
    page.locator("[data-m-px]").evaluateAll((nodes) =>
      nodes.map((node) => ({
        tag: node.tagName,
        written: Number.parseFloat((node as HTMLElement).style.getPropertyValue("--m-py")) || 0,
        pd: getComputedStyle(node).getPropertyValue("--m-pd").trim(),
        translate: getComputedStyle(node).translate,
      })),
    );
  /** Scrolls the page top to bottom in steps and records every drifting element's offset at each step. */
  const sweep = async (page: Page) => {
    const seen: { tag: string; written: number }[][] = [];
    const height = await page.evaluate(() => document.documentElement.scrollHeight);
    for (let y = 0; y < height; y += 250) {
      await page.evaluate((top) => window.scrollTo(0, top), y);
      await page.waitForTimeout(120);
      seen.push((await offsets(page)).map(({ tag, written }) => ({ tag, written })));
    }
    return seen;
  };

  /* ======================================================================= */
  /* 1–10 Parallax                                                            */
  /* ======================================================================= */

  const pub = await contextFor("desktop");
  const publicPage = await pub.newPage();
  const publicErrors: string[] = [];
  errorsOf(publicPage, publicErrors);
  await publicPage.goto(`${origin}/about`, { waitUntil: "load" });
  // The coordinator has registered every drifting element (Batch 19A: was a fixed 1.2 s).
  await publicPage.waitForFunction(() => typeof (window as unknown as { __eodParallax?: unknown }).__eodParallax === "function", undefined, {
    timeout: 20_000,
  });
  const series = await sweep(publicPage);
  const range = (index: number) => {
    const values = series.map((step) => step[index]?.written ?? 0);
    return { min: Math.min(...values), max: Math.max(...values) };
  };
  const drifters = (await offsets(publicPage)).map((entry) => `${entry.tag}:${entry.pd}`);
  const at = (pd: string) => drifters.findIndex((entry) => entry.endsWith(`:${pd}`));
  const subtle = range(at("12px"));
  const medium = range(at("24px"));
  const strong = range(at("36px"));
  say("1. public subtle parallax moves", subtle.max - subtle.min >= 6, `${JSON.stringify(subtle)} (${drifters.join(" ")})`);
  say("2. medium stays within its 24px", medium.max - medium.min >= 12 && medium.min >= -24.5 && medium.max <= 24.5, JSON.stringify(medium));
  say("3. strong stays within its 36px", strong.max - strong.min >= 18 && strong.min >= -36.5 && strong.max <= 36.5, JSON.stringify(strong));
  const everyBound = series.every((step) =>
    step.every((entry, index) => Math.abs(entry.written) <= Number.parseFloat(drifters[index]!.split(":")[1]!) + 0.5),
  );
  say("3a. no drifting element ever passes its own distance", everyBound);
  say("3b. the public page carries no editor attribute", !(await publicPage.content()).includes("data-eod-"));
  const stats = await publicPage.evaluate(() => (window as unknown as { __eodParallax?: () => unknown }).__eodParallax?.() ?? null);
  say("3c. one coordinator: one scroll listener for every drifting element", (stats as { listening: number } | null)?.listening === 1, JSON.stringify(stats));

  const overflow: string[] = [];
  for (const width of ["desktop", "tablet", "mobile"] as const) {
    const context = await contextFor(width);
    const page = await context.newPage();
    await page.goto(`${origin}/about`, { waitUntil: "load" });
    await sweep(page);
    const wide = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (wide > 0) overflow.push(`${width}: +${wide}px`);
    await context.close();
  }
  say("4. no horizontal overflow at any width while everything drifts", overflow.length === 0, overflow.join(", "));

  const reduced = await contextFor("desktop", { reducedMotion: "reduce" });
  const reducedPage = await reduced.newPage();
  await reducedPage.goto(`${origin}/about`, { waitUntil: "load" });
  await reducedPage.waitForFunction(() => typeof (window as unknown as { __eodMotion?: unknown }).__eodMotion === "function", undefined, {
    timeout: 20_000,
  });
  const reducedSeries = await sweep(reducedPage);
  const reducedStats = await reducedPage.evaluate(() => (window as unknown as { __eodParallax?: () => { listening: number; writes: number } }).__eodParallax?.() ?? null);
  const reducedTranslates = await reducedPage.locator("[data-m-px]").evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).translate));
  say(
    "5. reduced motion: zero parallax, no scroll listener, no writes",
    reducedSeries.every((step) => step.every((entry) => entry.written === 0)) &&
      reducedTranslates.every((value) => value === "none") &&
      (reducedStats === null || (reducedStats.listening === 0 && reducedStats.writes === 0)),
    JSON.stringify({ reducedStats, reducedTranslates }),
  );

  const pdAt = async (width: keyof typeof WIDTHS, selector: string) => {
    const context = await contextFor(width);
    const page = await context.newPage();
    await page.goto(`${origin}/about`, { waitUntil: "load" });
    const value = await page.locator(selector).first().evaluate((node) => getComputedStyle(node).getPropertyValue("--m-pd").trim());
    await context.close();
    return value;
  };
  const ctaTitle = `[data-section="final-cta"] h2`;
  const b = await pdAt("desktop", ctaTitle);
  const t = await pdAt("tablet", ctaTitle);
  const m = await pdAt("mobile", ctaTitle);
  say("6. Base / Tablet / Mobile each drift their own distance", b === "12px" && t === "36px" && m === "24px", `${b} ${t} ${m}`);
  {
    const context = await contextFor("desktop");
    const page = await context.newPage();
    await page.goto(`${origin}/about`, { waitUntil: "load" });
    const title = page.locator(ctaTitle).first();
    await title.scrollIntoViewIfNeeded();
    await holdsStill(page, title, 15_000);
    const wide = await title.evaluate((node) => Number.parseFloat((node as HTMLElement).style.getPropertyValue("--m-py")) || 0);
    await page.setViewportSize(WIDTHS.tablet);
    await page.waitForTimeout(400);
    await title.scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 60);
    await page.waitForTimeout(700);
    const narrow = await title.evaluate((node) => ({
      pd: getComputedStyle(node).getPropertyValue("--m-pd").trim(),
      py: Number.parseFloat((node as HTMLElement).style.getPropertyValue("--m-py")) || 0,
    }));
    const overflowAfter = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    say(
      "6a. resizing a live page to tablet switches the element's drift to Tablet's, with no overflow",
      narrow.pd === "36px" && Math.abs(narrow.py) <= 36 && overflowAfter <= 0,
      JSON.stringify({ wide, narrow, overflowAfter }),
    );
    await context.close();
  }

  const mobileNone = await contextFor("mobile");
  const mobilePage = await mobileNone.newPage();
  await mobilePage.goto(`${origin}/about`, { waitUntil: "load" });
  await sweep(mobilePage);
  const imageAtMobile = await mobilePage
    .locator(`[data-section="image-text"] [data-m-px]`)
    .first()
    .evaluate((node) => ({ pd: getComputedStyle(node).getPropertyValue("--m-pd").trim(), py: (node as HTMLElement).style.getPropertyValue("--m-py") }));
  say("7. Mobile none: the picture is at rest on a phone", imageAtMobile.pd === "0px" && imageAtMobile.py === "", JSON.stringify(imageAtMobile));
  await mobileNone.close();

  const previewContext = await contextFor("desktop");
  const previewPage = await previewContext.newPage();
  await previewPage.goto(`${origin}/about?preview=1`, { waitUntil: "load" });
  const previewSeries = await sweep(previewPage);
  const previewMoves = previewSeries.some((step) => step.some((entry) => entry.written !== 0));
  say("10. ordinary Preview shows live parallax, without the editor's bridge", previewMoves && !(await previewPage.content()).includes("data-eod-"));
  await previewContext.close();

  /* ======================================================================= */
  /* 11–15 Composition                                                        */
  /* ======================================================================= */

  const composed = await contextFor("desktop");
  const cp = await composed.newPage();
  const ctaSelector = `[data-section="image-text"] a.btn`;
  // Park the call to action just below the fold, start recording, bring it in.
  //
  // The page has to have stopped moving first: a picture or a font arriving
  // after the park shifts the layout, and the parked element is then either
  // pulled into view early (its entrance over before recording starts) or
  // pushed out of the wheel's reach — found in the Batch 16 stress run as a
  // recording with no entrance in it at all. So the park waits for fonts and
  // pictures, and is redone if the element was revealed anyway. That retries
  // the setup, never the measurement below.
  //
  // And the park itself has to have landed (Batch 19A). The site sets
  // `scroll-behavior: smooth`, so a plain `scrollTo` glides for about 400 ms,
  // and a wheel that arrives while the glide is still travelling is dropped by
  // Chromium — the glide lands on its own target and the wheel's 160 px never
  // happen. `tests/stress/smooth-scroll-wheel.stress.mts` shows it on a plain
  // page with none of our code. That was the whole of this check's
  // intermittency: every failure was a recording with no entrance in it, the
  // page resting exactly on the glide's target and the button 5 px under the
  // reveal line. So the park is an instant scroll, the wheel waits until the
  // page has arrived and held still, and it is checked to have moved the page.
  const parkHoldsStill = () =>
    cp.evaluate(
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
      ctaSelector,
    );
  let parked = false;
  let parkings = 0;
  let park: { target: number; still: boolean; scrollY: number; top: number } | null = null;
  for (; parkings < 3 && !parked; parkings += 1) {
    if (parkings > 0) await cp.reload({ waitUntil: "load" });
    else await cp.goto(`${origin}/about`, { waitUntil: "load" });
    // The button drifts, so the page is ready once the parallax coordinator
    // has registered it — the runtime says so on the window.
    await cp.waitForFunction(() => typeof (window as unknown as { __eodParallax?: unknown }).__eodParallax === "function", undefined, {
      timeout: 20_000,
    });
    // Bounded: a lazy picture below the fold never loads until it is reached.
    await cp.evaluate(async () => {
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
    const target = await cp.evaluate((selector) => {
      const element = document.querySelector(selector) as HTMLElement;
      const top = Math.round(element.getBoundingClientRect().top + window.scrollY - window.innerHeight + 20);
      window.scrollTo({ top, behavior: "instant" });
      return top;
    }, ctaSelector);
    park = { target, ...(await parkHoldsStill()) };
    parked =
      park.still &&
      Math.abs(park.scrollY - target) <= 1 &&
      (await cp.evaluate((selector) => !document.querySelector(selector)!.hasAttribute("data-shown"), ctaSelector));
  }
  await cp.evaluate((selector) => {
    const element = document.querySelector(selector) as HTMLElement;
    const frames: { t: number; y: number; animating: number; py: number }[] = [];
    (window as unknown as { __frames: typeof frames }).__frames = frames;
    const record = (time: number) => {
      const [, y = "0px"] = getComputedStyle(element).translate.split(" ");
      frames.push({
        t: time,
        y: Number.parseFloat(y),
        animating: element.getAnimations().length,
        py: Number.parseFloat(element.style.getPropertyValue("--m-py")) || 0,
      });
      if (frames.length < 240) requestAnimationFrame(record);
    };
    requestAnimationFrame(record);
  }, ctaSelector);
  const scrolledFrom = await cp.evaluate(() => Math.round(window.scrollY));
  await cp.mouse.move(720, 450);
  await cp.mouse.wheel(0, 160);
  // Until the recording is complete — 240 frames, four seconds at 60 Hz —
  // rather than a guess at how long it takes.
  await cp.waitForFunction(() => (window as unknown as { __frames: unknown[] }).__frames.length >= 240, undefined, { timeout: 20_000 });
  const scrolledTo = await cp.evaluate(() => Math.round(window.scrollY));
  const frames = await cp.evaluate(() => (window as unknown as { __frames: { t: number; y: number; animating: number; py: number }[] }).__frames);
  const end = frames.findIndex((frame, index) => index > 0 && frames[index - 1]!.animating > 0 && frame.animating === 0);
  const before = frames[end - 1];
  const after = frames[end];
  const landing = before && after ? Math.abs(after.y - before.y) : Number.NaN;
  say(
    "11. entrance → parallax: the entrance lands where the drift is, with no jump when it lets go",
    end > 0 && landing <= 1 && Math.abs(after!.py) > 1 && Math.abs(after!.y - after!.py) <= 0.6,
    JSON.stringify({ end, before, after, landing, parked, parkings, park, scrolled: [scrolledFrom, scrolledTo], frames: frames.length }),
  );

  const ctaBox = cp.locator(`[data-section="final-cta"] a.btn`).first();
  await ctaBox.scrollIntoViewIfNeeded();
  await holdsStill(cp, ctaBox, 15_000);
  const read = (locator: ReturnType<Page["locator"]>) =>
    locator.evaluate((node) => ({
      translate: getComputedStyle(node).translate,
      transform: getComputedStyle(node).transform,
      py: Number.parseFloat((node as HTMLElement).style.getPropertyValue("--m-py")) || 0,
    }));
  const parts = (value: string) => {
    const [x = "0px", y = "0px"] = value === "none" ? [] : value.split(" ");
    return { x: Number.parseFloat(x), y: Number.parseFloat(y) };
  };
  const restCta = await read(ctaBox);
  await ctaBox.hover();
  await holdsStill(cp, ctaBox);
  const liftCta = await read(ctaBox);
  say(
    "12. parallax + Lift on one element: the lift adds to the drift",
    Math.abs(parts(liftCta.translate).y - (liftCta.py - 4)) <= 0.6 && Math.abs(liftCta.py) > 0.5,
    JSON.stringify({ restCta, liftCta }),
  );
  say(
    "24. no doubled movement: a button given Lift hands its own one-pixel lift over",
    liftCta.transform === "none" || liftCta.transform === "matrix(1, 0, 0, 1, 0, 0)",
    liftCta.transform,
  );

  const nudgeBox = cp.locator(ctaSelector).first();
  await nudgeBox.scrollIntoViewIfNeeded();
  await holdsStill(cp, nudgeBox, 15_000);
  await nudgeBox.hover();
  await holdsStill(cp, nudgeBox);
  const nudged = await read(nudgeBox);
  say(
    "13. entrance + parallax + hover: nudge along the line, drift up and down, together",
    Math.abs(parts(nudged.translate).x - 4) <= 0.3 && Math.abs(parts(nudged.translate).y - nudged.py) <= 0.6 && Math.abs(nudged.py) > 0.5,
    JSON.stringify(nudged),
  );
  say(
    "24a. a button's own one-pixel lift stays under a Nudge — different axes, nothing doubled",
    /matrix\(1, 0, 0, 1, 0, -1\)/.test(nudged.transform),
    nudged.transform,
  );
  await cp.mouse.move(2, 2);
  await holdsStill(cp, nudgeBox);
  const released = await read(nudgeBox);
  say(
    "14. hover ends and the drift remains",
    Math.abs(parts(released.translate).x) <= 0.2 && Math.abs(parts(released.translate).y - released.py) <= 0.6 && Math.abs(released.py) > 0.5,
    JSON.stringify(released),
  );
  // Keyboard focus holds the hover state while the page scrolls under it.
  await nudgeBox.evaluate((node) => (node as HTMLElement).blur());
  let focused = false;
  for (let i = 0; i < 80 && !focused; i += 1) {
    await cp.keyboard.press("Tab");
    focused = await nudgeBox.evaluate((node) => document.activeElement === node);
  }
  await holdsStill(cp, nudgeBox);
  const heldBefore = await read(nudgeBox);
  await cp.mouse.wheel(0, 120);
  await holdsStill(cp, nudgeBox);
  const heldAfter = await read(nudgeBox);
  say(
    "15. the drift changes while the hover state holds",
    focused &&
      Math.abs(parts(heldBefore.translate).x - 4) <= 0.3 &&
      Math.abs(parts(heldAfter.translate).x - 4) <= 0.3 &&
      Math.abs(heldAfter.py - heldBefore.py) >= 0.5 &&
      Math.abs(parts(heldAfter.translate).y - heldAfter.py) <= 0.6,
    JSON.stringify({ focused, heldBefore, heldAfter }),
  );
  await composed.close();

  /* ======================================================================= */
  /* 16–24 Hover                                                              */
  /* ======================================================================= */

  const hoverContext = await contextFor("desktop");
  const hp = await hoverContext.newPage();
  await hp.goto(`${origin}/about`, { waitUntil: "load" });
  const rows = hp.locator(`[data-section="why-us"] li[data-m-hv]`);
  await rows.first().scrollIntoViewIfNeeded();
  // The section's cinematic entrance, 1.5 s delay included, run to its end (Batch 19A: was a fixed 3.5 s).
  await holdsStill(hp, rows.first(), 20_000);
  const liftRow = rows.nth(0);
  const scaleRow = rows.nth(1);
  const glowAtRest = await liftRow.evaluate((node) => getComputedStyle(node).boxShadow);
  await liftRow.hover();
  await holdsStill(hp, liftRow);
  const lifted = await liftRow.evaluate((node) => getComputedStyle(node).translate);
  const glowHovered = await liftRow.evaluate((node) => getComputedStyle(node).boxShadow);
  say("16. Lift under the pointer rises 4px", parts(lifted).y === -4, lifted);
  say("39a. a Batch 14 glow is exactly the same under the hover — hover never touches box-shadow", glowAtRest !== "none" && glowAtRest === glowHovered, `${glowAtRest} | ${glowHovered}`);
  const halfTitle = hp.locator(`[data-section="why-us"] h2`).first();
  await halfTitle.scrollIntoViewIfNeeded();
  await holdsStill(hp, halfTitle, 20_000);
  const half = await halfTitle.evaluate((node) => ({
    element: getComputedStyle(node).opacity,
    words: [...node.querySelectorAll("[data-m-w]")].map((word) => getComputedStyle(word).opacity),
  }));
  say(
    "39b. the words land on the element's own Style opacity: half strength, as the editor set it",
    half.element === "0.5" && half.words.length > 0 && half.words.every((o) => o === "1"),
    JSON.stringify(half),
  );
  await scaleRow.hover();
  await holdsStill(hp, scaleRow);
  const scaled = await scaleRow.evaluate((node) => getComputedStyle(node).scale);
  say("18. Scale under the pointer grows to 1.03", scaled === "1.03", scaled);
  await hp.mouse.move(2, 2);
  await holdsStill(hp, scaleRow);

  // Keyboard: a real call to action with Lift, reached with Tab.
  const liftCtaKey = hp.locator(`[data-section="final-cta"] a.btn`).first();
  let keyFocus = false;
  for (let i = 0; i < 120 && !keyFocus; i += 1) {
    await hp.keyboard.press("Tab");
    keyFocus = await liftCtaKey.evaluate((node) => document.activeElement === node);
  }
  await holdsStill(hp, liftCtaKey);
  const keyLift = await read(liftCtaKey);
  say(
    "17. Lift by keyboard: focus shown by Tab lifts the button exactly as the pointer does",
    keyFocus && Math.abs(parts(keyLift.translate).y - (keyLift.py - 4)) <= 0.6,
    JSON.stringify({ keyFocus, keyLift }),
  );
  // Rows hold nothing focusable in today's blocks, and nothing is made
  // focusable to show a hover off: the rule answers focus *inside* a row,
  // which a link in a row would give it.
  const tabIndexed = await hp.locator("[data-m-hv][tabindex]").count();
  await scaleRow.evaluate((node) => {
    const link = document.createElement("a");
    link.href = "#probe";
    link.textContent = "probe";
    link.id = "probe-link";
    node.appendChild(link);
  });
  let inRow = false;
  for (let i = 0; i < 120 && !inRow; i += 1) {
    await hp.keyboard.press("Tab");
    inRow = await hp.evaluate(() => document.activeElement?.id === "probe-link");
  }
  await holdsStill(hp, scaleRow);
  const keyScale = await scaleRow.evaluate((node) => getComputedStyle(node).scale);
  say("19. Scale by keyboard: focus inside the row scales it; no row was made focusable", inRow && keyScale === "1.03" && tabIndexed === 0, `${inRow} ${keyScale} ${tabIndexed}`);

  const frameBox = hp.locator(`[data-section="image-text"] [data-m-hv]`).first();
  await frameBox.scrollIntoViewIfNeeded();
  await holdsStill(hp, frameBox, 15_000);
  const frameRectBefore = await frameBox.boundingBox();
  await frameBox.hover();
  await holdsStill(hp, frameBox);
  const zoom = await frameBox.evaluate((node) => ({
    img: getComputedStyle(node.querySelector("img")!).scale,
    overflow: getComputedStyle(node).overflow,
    frame: getComputedStyle(node).scale,
  }));
  const frameRectAfter = await frameBox.boundingBox();
  say(
    "20. Zoom grows the picture inside its clipping frame; the frame keeps its size",
    zoom.img === "1.06" && zoom.overflow === "hidden" && zoom.frame === "1" &&
      Math.abs((frameRectAfter?.width ?? 0) - (frameRectBefore?.width ?? 0)) < 0.5,
    JSON.stringify(zoom),
  );
  await hoverContext.close();

  const reducedHover = await contextFor("desktop", { reducedMotion: "reduce" });
  const rh = await reducedHover.newPage();
  await rh.goto(`${origin}/about`, { waitUntil: "load" });
  const reducedFrame = rh.locator(`[data-section="image-text"] [data-m-hv]`).first();
  await reducedFrame.scrollIntoViewIfNeeded();
  await reducedFrame.hover();
  await holdsStill(rh, reducedFrame);
  const reducedZoom = await reducedFrame.evaluate((node) => getComputedStyle(node.querySelector("img")!).scale);
  const reducedRow = rh.locator(`[data-section="why-us"] li[data-m-hv]`).first();
  await reducedRow.hover();
  await holdsStill(rh, reducedRow);
  const reducedLift = await reducedRow.evaluate((node) => `${getComputedStyle(node).translate}|${getComputedStyle(node).scale}`);
  say("21. reduced motion: Zoom and Lift do not move", reducedZoom === "none" && reducedLift === "none|none", `${reducedZoom} ${reducedLift}`);

  // Words under reduced motion (32), from the same page.
  const reducedWords = await rh.locator(`[data-section="rich-text"] [data-m-w]`).evaluateAll((nodes) =>
    nodes.map((node) => `${getComputedStyle(node).opacity}/${node.getAnimations().length}`),
  );
  say("32. reduced motion: every word is there, nothing animates", reducedWords.length > 0 && reducedWords.every((w) => w === "1/0"), reducedWords.join(" "));
  await reducedHover.close();

  const nudgeX = async (path: string) => {
    const context = await contextFor("desktop");
    const page = await context.newPage();
    await page.goto(`${origin}${path}`, { waitUntil: "load" });
    const box = page.locator(ctaSelector).first();
    await box.scrollIntoViewIfNeeded();
    await holdsStill(page, box, 15_000);
    await box.hover();
    await holdsStill(page, box);
    const value = parts(await box.evaluate((node) => getComputedStyle(node).translate)).x;
    await context.close();
    return value;
  };
  const en = await nudgeX("/about");
  const ar = await nudgeX("/ar/about");
  say("22. Nudge in English moves toward the end of the line: right", en === 4, String(en));
  say("23. Nudge in Arabic moves toward the end of the line: left", ar === -4, String(ar));

  /* ======================================================================= */
  /* 25–35 Word reveal                                                        */
  /* ======================================================================= */

  const words = await contextFor("desktop");
  const wp = await words.newPage();
  await wp.goto(`${origin}/about`, { waitUntil: "load" });
  const heading = wp.locator(`[data-section="rich-text"] h2`).first();
  await heading.evaluate((node) => {
    const spans = [...node.querySelectorAll("[data-m-w]")];
    const samples: number[][] = [];
    (window as unknown as { __samples: number[][] }).__samples = samples;
    const tick = () => {
      samples.push(spans.map((span) => Number(getComputedStyle(span).opacity)));
      if (samples.length < 150) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await heading.scrollIntoViewIfNeeded();
  // Until the recorder has its 150 frames (Batch 19A: was a fixed 3 s).
  await wp.waitForFunction(() => (window as unknown as { __samples: unknown[] }).__samples.length >= 150, undefined, { timeout: 20_000 });
  const samples = await wp.evaluate(() => (window as unknown as { __samples: number[][] }).__samples);
  const inOrder = samples.some((sample) => sample.length > 2 && sample[0]! > sample.at(-1)! + 0.2);
  const settled = samples.at(-1)?.every((value) => value === 1);
  const visual = await heading.locator("[data-m-wv]").textContent();
  const accessible = await heading.locator("[data-m-wa]").textContent();
  say("25. English heading: the words arrive first to last, then all of them are there", inOrder && settled === true, `${samples.length} samples`);
  say("27. punctuation kept exactly", visual === TITLE_EN && (await heading.locator("[data-m-w]").allTextContents()).join("|") === "Plan,|book|—|travel;|done!", JSON.stringify(visual));
  say("28. whitespace kept exactly, the double space included", visual === TITLE_EN && accessible === TITLE_EN);
  const aria = await heading.ariaSnapshot();
  const once = (aria.match(/Plan, book — travel; done!/g) ?? []).length;
  say("29. assistive technology reads the sentence once, not the words", once === 1 && !/book"\s*\n.*"travel/.test(aria), aria.replace(/\n/g, " ⏎ "));
  const [stored] = await sql<{ draft: { title: { en: string } } }[]>`select draft from page_sections where id = ${TEXT}`;
  const [storedLive] = await sql<{ published: { title: { en: string } } }[]>`select published from page_sections where id = ${TEXT}`;
  say(
    "30. the stored sentence is the sentence — no spans, no markup",
    storedLive!.published.title.en === TITLE_EN && !/span|data-m/.test(JSON.stringify(storedLive)) && (stored?.draft === null || !/span/.test(JSON.stringify(stored))),
    JSON.stringify(storedLive!.published.title),
  );
  await words.close();

  const arabic = await contextFor("desktop");
  const ap = await arabic.newPage();
  await ap.goto(`${origin}/ar/about`, { waitUntil: "load" });
  const arHeading = ap.locator(`[data-section="rich-text"] h2`).first();
  await arHeading.scrollIntoViewIfNeeded();
  await holdsStill(ap, arHeading, 20_000);
  const arWords = await arHeading.locator("[data-m-w]").allTextContents();
  const arVisual = await arHeading.locator("[data-m-wv]").textContent();
  say(
    "26. Arabic heading: the words in reading order, the sentence whole, punctuation on its word",
    JSON.stringify(arWords) === JSON.stringify(["خطط،", "احجز", "—", "سافر؛", "انتهى!"]) && arVisual === "خطط، احجز — سافر؛ انتهى!" &&
      (await ap.evaluate(() => document.documentElement.dir)) === "rtl",
    JSON.stringify({ arWords, arVisual }),
  );
  await arabic.close();

  const phone = await contextFor("mobile");
  const pp = await phone.newPage();
  await pp.goto(`${origin}/about`, { waitUntil: "load" });
  const whyTitle = pp.locator(`[data-section="why-us"] h2`).first();
  const wordsAtLoad = await whyTitle.locator("[data-m-w]").evaluateAll((nodes) =>
    nodes.map((node) => `${getComputedStyle(node).opacity}`),
  );
  say("31. Mobile none: on a phone the words are simply there, nothing hidden", wordsAtLoad.length > 0 && wordsAtLoad.every((o) => o === "1"), wordsAtLoad.join(" "));
  await phone.close();

  const noScript = await contextFor("desktop", { javaScriptEnabled: false });
  const np = await noScript.newPage();
  await np.goto(`${origin}/about`, { waitUntil: "load" });
  const noScriptWords = await np.locator("[data-m-w]").evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).opacity));
  const noScriptOffsets = await np.locator("[data-m-px]").evaluateAll((nodes) => nodes.map((node) => getComputedStyle(node).translate));
  // Hidden means below the element's own Style opacity (Batch 14), which an
  // editor may set under 1 on purpose — the why-us heading here is 0.5 (39b),
  // and at 0.5 it is exactly as the editor asked, not hidden.
  const noScriptHidden = await np.locator("[data-m-reveal], [data-m-group] > *").evaluateAll((nodes) =>
    nodes.filter((node) => {
      const style = getComputedStyle(node);
      const own = Number.parseFloat(style.getPropertyValue("--eod-node-opacity")) || 1;
      return Number(style.opacity) < own - 0.001;
    }).length,
  );
  const noScriptBelowOne = await np.locator("[data-m-reveal], [data-m-group] > *").evaluateAll((nodes) =>
    nodes
      .filter((node) => getComputedStyle(node).opacity !== "1")
      .map((node) => `${node.tagName}:${getComputedStyle(node).opacity}/own ${getComputedStyle(node).getPropertyValue("--eod-node-opacity").trim()}`),
  );
  say(
    "33. no script: every word readable, nothing offset, nothing hidden",
    noScriptWords.length > 0 && noScriptWords.every((o) => o === "1") && noScriptOffsets.every((v) => v === "0px" || v === "none") && noScriptHidden === 0,
    JSON.stringify({ words: noScriptWords.length, noScriptOffsets, noScriptHidden, noScriptBelowOne }),
  );
  await noScript.close();

  /* ======================================================================= */
  /* §52 reduced-motion matrix, §53 print matrix                              */
  /* ======================================================================= */

  const matrix = async (page: Page) => {
    // Every movement asked for at once: hover every hovering element in turn
    // and read everything back.
    await sweep(page);
    const moving: string[] = [];
    for (const selector of [`[data-section="why-us"] li[data-m-hv]`, `[data-section="image-text"] [data-m-hv]`, `[data-section="final-cta"] a.btn`]) {
      const count = await page.locator(selector).count();
      for (let i = 0; i < count; i += 1) {
        const element = page.locator(selector).nth(i);
        await element.scrollIntoViewIfNeeded();
        await element.hover().catch(() => undefined);
        await page.waitForTimeout(250);
        const state = await element.evaluate((node) => {
          const style = getComputedStyle(node);
          const img = node.querySelector(":scope > img");
          return `${style.translate}|${style.scale}|${img ? getComputedStyle(img).scale : "none"}`;
        });
        if (state !== "none|none|none") moving.push(`${selector}#${i}:${state}`);
      }
    }
    const still = await page.evaluate(() => {
      const bad: string[] = [];
      for (const node of document.querySelectorAll("[data-m-reveal], [data-m-group] > *, [data-m-px], [data-m-hv]")) {
        const style = getComputedStyle(node);
        const opacity = Number(style.opacity);
        if (style.translate !== "none") bad.push(`translate ${node.tagName} ${style.translate}`);
        if (style.scale !== "none") bad.push(`scale ${node.tagName} ${style.scale}`);
        if (style.filter !== "none") bad.push(`filter ${node.tagName} ${style.filter}`);
        if (style.clipPath !== "none") bad.push(`clip ${node.tagName} ${style.clipPath}`);
        if (opacity < 0.5) bad.push(`opacity ${node.tagName} ${opacity}`);
      }
      for (const word of document.querySelectorAll("[data-m-w]")) {
        const style = getComputedStyle(word);
        if (style.opacity !== "1" || style.filter !== "none" || word.getAnimations().length) bad.push(`word ${style.opacity}`);
      }
      return bad;
    });
    return { moving, still };
  };
  {
    const context = await contextFor("desktop", { reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto(`${origin}/about`, { waitUntil: "load" });
    const result = await matrix(page);
    say(
      "52. reduced motion, every kind at once — Blur, Mask, Stagger, words, parallax, Lift, Scale, Zoom, Nudge — nothing moves and everything is there",
      result.moving.length === 0 && result.still.length === 0,
      JSON.stringify(result),
    );
    await context.close();
  }
  {
    const context = await contextFor("desktop");
    const page = await context.newPage();
    await page.goto(`${origin}/about`, { waitUntil: "load" });
    await page.waitForTimeout(600);
    await page.emulateMedia({ media: "print" });
    // Emulating print switches the media of a LIVE page, and a switch on a live
    // page starts CSS transitions: every legacy `.reveal` not yet scrolled to
    // fades in from 0 over its own Batch 9 transition. A real print never runs
    // them — Chromium prints the final print-media value (measured in Batch
    // 15b with `page.pdf()`: a 10s opacity transition prints fully opaque,
    // while emulation starts it at 0). So the transitions the
    // switch itself started are allowed to end, and the state read is the one a
    // printer gets. Nothing else is waited for.
    const switchTransitions = await page.evaluate(
      () => document.getAnimations().filter((animation) => animation.constructor.name === "CSSTransition").length,
    );
    await page.waitForFunction(
      () => document.getAnimations().every((animation) => animation.constructor.name !== "CSSTransition"),
      undefined,
      { timeout: 10_000 },
    );
    const printed = await page.evaluate(() => {
      const bad: string[] = [];
      for (const node of document.querySelectorAll("[data-m-reveal], [data-m-group] > *, [data-m-px], [data-m-hv]")) {
        const style = getComputedStyle(node);
        if (style.translate !== "none" || style.scale !== "none" || style.filter !== "none" || style.clipPath !== "none") {
          bad.push(`${node.tagName}: ${style.translate} ${style.scale} ${style.filter} ${style.clipPath}`);
        }
        if (Number(style.opacity) < 0.5) bad.push(`${node.tagName} opacity ${style.opacity}`);
      }
      const words = [...document.querySelectorAll("[data-m-w]")].filter((word) => getComputedStyle(word).opacity !== "1").length;
      const copies = [...document.querySelectorAll("[data-m-wa]")].filter((copy) => (copy as HTMLElement).getBoundingClientRect().width > 1).length;
      return { bad, words, copies };
    });
    say(
      "53. print: no parallax or hover offset, no hidden entrance, no mask, no blur, every word shown once",
      printed.bad.length === 0 && printed.words === 0 && printed.copies === 0,
      JSON.stringify({ ...printed, switchTransitions }),
    );
    await context.close();
  }

  /* ======================================================================= */
  /* Editor: 8, 9, 24(b), 34, 35, 36–50                                      */
  /* ======================================================================= */

  const editorContext = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  await editorContext.addCookies([cookie]);
  await editorContext.addInitScript({ content: NAME_SHIM });
  const page = await editorContext.newPage();
  const network = watchNetwork(page);
  const editorErrors: string[] = [];
  errorsOf(page, editorErrors);
  page.on("dialog", (dialog) => void dialog.accept());
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.headers()["next-action"]) posts.push(request.url());
  });

  const open = async (query: string) => {
    await page.goto(`${origin}/admin/visual-editor${query}`, { waitUntil: "load" });
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  };
  const frame = () => page.frames().find((f) => f.url().includes("editor=1"))!;
  const settledEditor = async () => {
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
    await page.waitForTimeout(900);
  };
  const motionTab = () => page.getByRole("tab", { name: /Motion/ });
  /**
   * Selects a node and returns whether the Inspector shows it (Batch 19A).
   *
   * A section from Layers, anything inside one on the canvas — one click
   * either way, then a bounded wait for the Inspector's answer. The old loop
   * read the Inspector once, straight after the click, and pressed "Select
   * what contains this" whenever the answer was not in yet: the Inspector
   * follows a click a few milliseconds later, so the button then walked the
   * node the click had just selected out to its section. That was check 34's
   * intermittency — the heading's fields came back as its section's
   * (entrance, duration, delay, easing) once all three of the old attempts had
   * lost that race. Now the click lands where the canvas is still, in page
   * pixels, and nothing steps out until the Inspector has said where it is.
   */
  const selectNode = async (address: string) => {
    await settledEditor();
    if (!address.includes("/")) {
      const row = page.locator(`aside[aria-label='Page structure'] [data-layer-row="${address}"]`);
      await row.waitFor({ timeout: 25_000 });
      await row.click();
      const shows = await waitForInspector(page, address);
      if (shows !== address) {
        console.log(`   [select] ${address} → the Inspector shows ${shows || "nothing"}`);
        return false;
      }
    } else {
      const result = await selectCanvasNode(page, address);
      if (!result.ok) {
        console.log(`   [select] ${address} → the Inspector shows ${result.shows || "nothing"}; the click landed on ${JSON.stringify(result.landing)}`);
        return false;
      }
    }
    await motionTab().click();
    return true;
  };
  const offeredFields = async () =>
    page.locator("[data-motion-field]").evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.motionField));
  const replayStatus = async () => (await page.locator("[data-replay-status]").getAttribute("data-replay-status")) ?? "";
  const statusText = async () => ((await page.locator("[data-replay-status]").textContent()) ?? "").trim();
  const revisionOf = async (id: number) => (await sql<{ revision: number }[]>`select revision from page_sections where id = ${id}`)[0]!.revision;
  const logCount = async () => Number((await sql<{ n: string }[]>`select count(*)::text as n from activity_logs`)[0]!.n);
  const pageRevision = async () => (await sql<{ revision: number }[]>`select revision from pages where id = ${about!.id}`)[0]!.revision;
  /** Records, inside the canvas, what a Replay does to one element. */
  const record = (address: string) =>
    frame().evaluate((wanted) => {
      const element = document.querySelector(`[data-eod-address="${wanted}"]`) as HTMLElement;
      const log: string[] = [];
      const samples: { y: number; words: number; hover: boolean; animating: number; shown: string | null }[] = [];
      // Old values, in order: a state that lasts no longer than one task is
      // only visible as the value the next change replaced.
      const observer = new MutationObserver((records) => {
        for (const entry of records) log.push(`${entry.attributeName}:${entry.oldValue}`);
      });
      observer.observe(element, {
        attributes: true,
        attributeOldValue: true,
        attributeFilter: ["data-shown", "data-m-words", "data-eod-replay-hover"],
      });
      let stop = false;
      const tick = () => {
        const [, y = "0px"] = getComputedStyle(element).translate.split(" ");
        samples.push({
          y: Number.parseFloat(y) || 0,
          words: element.querySelectorAll("[data-m-w]").length,
          hover: element.hasAttribute("data-eod-replay-hover"),
          animating: element.getAnimations({ subtree: true }).filter((a) => Number.isFinite(a.effect?.getComputedTiming().endTime as number)).length,
          shown: element.getAttribute("data-shown"),
        });
        if (!stop && samples.length < 900) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      (window as unknown as { __replay: unknown }).__replay = { log, samples, done: () => ((stop = true), observer.disconnect()) };
    }, address);
  const recorded = () =>
    frame().evaluate(() => {
      const replay = (window as unknown as { __replay: { log: string[]; samples: unknown[]; done: () => void } }).__replay;
      replay.done();
      return { log: replay.log, samples: replay.samples as { y: number; words: number; hover: boolean; animating: number; shown: string | null }[] };
    });
  const waitStatus = async (outcome: string, ms = 12_000) =>
    until(async () => (await replayStatus()) === outcome, Math.ceil(ms / 150), 150);

  await open("?page=about&lang=en&device=desktop");

  /* 9. paused parallax in the editor */
  // Instantly: the canvas scrolls smoothly otherwise, and the window below is
  // for a live coordinator to write — which it does within a frame of a
  // scroll — not for a glide to finish (Batch 19A).
  await frame().evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight / 2, behavior: "instant" }));
  await quietFor(page, 700, "a live parallax coordinator would have written an offset by now");
  const canvasOffsets = await frame().locator("[data-m-px]").evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).style.getPropertyValue("--m-py")));
  const canvasRuntime = await frame().evaluate(() => typeof (window as unknown as { __eodParallax?: unknown }).__eodParallax);
  await selectNode(`section:${IMAGE}/field:image`);
  const note = (await page.locator('[data-motion-note="parallax"]').textContent())?.trim();
  say(
    "9. the editor pauses live parallax and says so, in the brief's words",
    canvasOffsets.length > 0 && canvasOffsets.every((v) => v === "") && canvasRuntime === "undefined" &&
      note === "Parallax is paused while editing. Use Replay to preview it.",
    JSON.stringify({ canvasOffsets, canvasRuntime, note }),
  );

  /* 34. long text is never offered words */
  await selectNode(`section:${TEXT}/field:body`);
  const bodyFields = await offeredFields();
  await selectNode(`section:${WHY}/field:points/item:${points[0]}/field:text`);
  const rowTextFields = await offeredFields();
  await selectNode(`section:${TEXT}/field:title`);
  const titleFields = await offeredFields();
  say(
    "34. rich text and a long description offer no word reveal; a heading does",
    !bodyFields.includes("textReveal") && !rowTextFields.includes("textReveal") && titleFields.includes("textReveal"),
    JSON.stringify({ bodyFields, rowTextFields, titleFields }),
  );

  /* 24(b). a card that owns its hover offers none */
  await open("?page=home&lang=en&device=desktop");
  const quickRow = `section:${quick!.id}/field:links/item:${(quick!.published.links as { _id: string }[])[0]!._id}`;
  await selectNode(quickRow);
  const cardFields = await offeredFields();
  say("24b. a quick-access card, which lifts and zooms on its own, is offered no hover", !cardFields.includes("hover") && cardFields.includes("entrance"), JSON.stringify(cardFields));

  /* 8. reset inheritance, through the panel */
  await open("?page=about&lang=en&device=tablet");
  await selectNode(`section:${CTA}/field:title`);
  const resetButton = page.getByRole("button", { name: "Reset tablet motion" });
  await resetButton.click();
  const reset = await until(async () => {
    const [draft] = await sql<{ draft_motion_config: Doc | null }[]>`select draft_motion_config from page_sections where id = ${CTA}`;
    const title = draft?.draft_motion_config?.nodes?.["field:title"] as Record<string, unknown> | undefined;
    return !!title && !("tablet" in title) && "mobile" in title;
  });
  const tabletPreview = await contextFor("tablet");
  const tpp = await tabletPreview.newPage();
  await tpp.goto(`${origin}/about?preview=1`, { waitUntil: "load" });
  const tabletPd = await tpp.locator(ctaTitle).first().evaluate((n) => getComputedStyle(n).getPropertyValue("--m-pd").trim());
  await tabletPreview.close();
  say("8. resetting Tablet falls back to Base — nothing was copied down", reset && tabletPd === "12px", `${reset} ${tabletPd}`);

  await open("?page=about&lang=en&device=desktop");

  /* 36. the section's Replay */
  await selectNode(`section:${WHY}`);
  await settledEditor();
  // Selecting loads the section; only what happens after the click counts.
  await network.quiet();
  const logsBefore = await logCount();
  const whyRevision = await revisionOf(WHY);
  const pageRevisionBefore = await pageRevision();
  posts.length = 0;
  await record(`section:${WHY}`);
  await page.locator('[data-replay-mode="all"]').click();
  const sectionDone = await waitStatus("finished", 15_000);
  const sectionTrace = await recorded();
  say(
    "36. Replay on a section plays the section's own entrance, then it is shown again",
    sectionDone && sectionTrace.log.includes("data-shown:false") && sectionTrace.samples.at(-1)?.shown === "true" &&
      sectionTrace.samples.some((s) => s.animating > 0),
    JSON.stringify({ log: sectionTrace.log, status: await statusText() }),
  );
  say("41. Replay leaves nothing unsaved", (await page.getByText(/Unsaved (motion|content|style)/).count()) === 0);
  say("42. Replay sends nothing to the server — no autosave, no action", posts.length === 0, posts.join(", "));
  say("43. …and no revision moves", (await revisionOf(WHY)) === whyRevision && (await pageRevision()) === pageRevisionBefore);
  say("44. …and nothing is logged", (await logCount()) === logsBefore);

  /* 37. an element's Replay */
  await selectNode(`section:${IMAGE}/field:image`);
  await record(`section:${IMAGE}/field:image`);
  await page.locator('[data-replay-mode="entrance"]').click();
  const elementDone = await waitStatus("finished", 15_000);
  const elementTrace = await recorded();
  say(
    "37. Replay on an element plays that element's entrance",
    elementDone && elementTrace.log.includes("data-shown:false") && elementTrace.samples.some((s) => s.animating > 0),
    JSON.stringify(elementTrace.log),
  );

  /* 39 + 49. parallax sweep, then the outline is back on its element */
  await record(`section:${IMAGE}/field:image`);
  await page.locator('[data-replay-mode="parallax"]').click();
  const sweepDone = await waitStatus("finished", 15_000);
  const sweepTrace = await recorded();
  const ys = sweepTrace.samples.map((s) => s.y);
  const endY = await frame().locator(`[data-eod-address="section:${IMAGE}/field:image"]`).first().evaluate((n) => getComputedStyle(n).translate);
  say(
    "39. Replay sweeps the paused parallax through its distance and back to rest",
    sweepDone && Math.min(...ys) <= -30 && Math.max(...ys) >= 30 && Math.min(...ys) >= -36.5 && Math.max(...ys) <= 36.5 && (endY === "0px" || endY === "none"),
    JSON.stringify({ min: Math.min(...ys), max: Math.max(...ys), endY }),
  );
  await holdsStill(page, frame().locator(`[data-eod-address="section:${IMAGE}/field:image"]`).first());
  const outline = await page.locator('div[aria-hidden][style*="solid var(--color-orange)"]').first().boundingBox();
  const frameEl = await page.locator("iframe").first().boundingBox();
  const scale = await page.locator("iframe").first().evaluate((node) => {
    const match = /scale\(([\d.]+)\)/.exec((node as HTMLElement).style.transform);
    return match ? Number(match[1]) : 1;
  });
  const elementRect = await frame().locator(`[data-eod-address="section:${IMAGE}/field:image"]`).first().evaluate((n) => {
    const r = n.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const expected = frameEl
    ? { x: frameEl.x + elementRect.x * scale, y: frameEl.y + elementRect.y * scale, width: elementRect.width * scale, height: elementRect.height * scale }
    : null;
  const close = !!outline && !!expected &&
    Math.abs(outline.x - expected.x) <= 2 && Math.abs(outline.y - expected.y) <= 2 &&
    Math.abs(outline.width - expected.width) <= 2 && Math.abs(outline.height - expected.height) <= 2;
  say("49. after Replay the selection outline sits on its element again", close, JSON.stringify({ outline, expected }));

  /* 40. hover Replay on a row */
  const liftAddress = `section:${WHY}/field:points/item:${points[0]}`;
  await selectNode(liftAddress);
  await record(liftAddress);
  await page.locator('[data-replay-mode="all"]').click();
  const hoverDone = await waitStatus("finished", 15_000);
  const hoverTrace = await recorded();
  const hoverYs = hoverTrace.samples.filter((s) => s.hover).map((s) => s.y);
  const afterHover = await frame().locator(`[data-eod-address="${liftAddress}"]`).first().evaluate((n) => ({
    attr: n.hasAttribute("data-eod-replay-hover"),
    translate: getComputedStyle(n).translate,
  }));
  say(
    "40. Replay shows the hover with the very same variables, then lets it go",
    hoverDone && hoverYs.some((y) => Math.abs(y + 4) <= 0.2) && !afterHover.attr && (afterHover.translate === "0px" || afterHover.translate === "none" || afterHover.translate === "0px 0px"),
    JSON.stringify({ min: Math.min(...hoverYs), afterHover }),
  );

  /* 48. a new selection stops the Replay and restores its element */
  await record(liftAddress);
  await page.locator('[data-replay-mode="all"]').click();
  // Wait for the hover phase itself, then move the selection mid-hover.
  await until(
    async () => frame().locator(`[data-eod-address="${liftAddress}"][data-eod-replay-hover]`).count().then((n) => n > 0),
    100,
    50,
  );
  await selectNode(`section:${WHY}/field:points/item:${points[1]}`);
  const interrupted = await recorded();
  const leftBehind = await frame().locator(`[data-eod-address="${liftAddress}"]`).first().evaluate((n) => n.hasAttribute("data-eod-replay-hover"));
  const statusAfterSwitch = await replayStatus();
  say(
    "48. selecting something else stops the Replay, restores the old element, and says nothing about it",
    // Set (old value null), then removed (old value ""), and nothing left on the element.
    interrupted.log.includes("data-eod-replay-hover:null") && interrupted.log.includes("data-eod-replay-hover:") && !leftBehind && statusAfterSwitch === "",
    JSON.stringify({ log: interrupted.log, statusAfterSwitch }),
  );

  /* 38 + 50. words, then typing into the same heading */
  const titleAddress = `section:${TEXT}/field:title`;
  await selectNode(titleAddress);
  const unsplit = await frame().locator(`[data-eod-address="${titleAddress}"]`).first().evaluate((n) => ({
    words: n.querySelectorAll("[data-m-w]").length,
    text: n.textContent,
  }));
  await record(titleAddress);
  await page.locator('[data-replay-mode="entrance"]').click();
  const wordsDone = await waitStatus("finished", 15_000);
  const wordsTrace = await recorded();
  const restored = await frame().locator(`[data-eod-address="${titleAddress}"]`).first().evaluate((n) => ({
    words: n.querySelectorAll("[data-m-w]").length,
    marked: n.hasAttribute("data-m-words"),
    text: n.textContent,
    childNodes: n.childNodes.length,
  }));
  say(
    "35a. the canvas renders the heading whole, so it can be typed into",
    unsplit.words === 0 && unsplit.text === TITLE_EN,
    JSON.stringify(unsplit),
  );
  say(
    "38. Replay builds the words for a moment and puts the heading's own text back",
    wordsDone && wordsTrace.samples.some((s) => s.words === 5) && wordsTrace.log.includes("data-m-words:null") && wordsTrace.log.includes("data-m-words:") &&
      restored.words === 0 && !restored.marked && restored.text === TITLE_EN && restored.childNodes === 1,
    JSON.stringify({ log: wordsTrace.log, restored }),
  );
  const heading2 = frame().locator(`[data-eod-address="${titleAddress}"]`).first();
  await clickCanvasNode(page, heading2, "own", { double: true });
  await until(async () => (await heading2.getAttribute("contenteditable")) === "plaintext-only", 50, 100);
  await page.keyboard.press("End");
  await page.keyboard.type(" Now");
  await page.keyboard.press("Enter");
  const typed = await until(async () => {
    const [draft] = await sql<{ draft: { title: { en: string } } | null }[]>`select draft from page_sections where id = ${TEXT}`;
    return draft?.draft?.title?.en === `${TITLE_EN} Now`;
  }, 100);
  const [afterEdit] = await sql<{ draft: Record<string, unknown> }[]>`select draft from page_sections where id = ${TEXT}`;
  say(
    "50. direct editing works straight after Replay: typed, autosaved, plain text",
    typed && !/span|data-m|aria-hidden/.test(JSON.stringify(afterEdit!.draft)),
    JSON.stringify((afterEdit!.draft as { title: unknown }).title),
  );
  say("35. direct editing a word-reveal heading stores plain text", typed);

  /* 48c. Word Reveal edited while the content is dirty: one queue, both land */
  {
    await settledEditor();
    const target = `section:${IMAGE}/field:title`;
    await selectNode(target);
    const startRevision = await revisionOf(IMAGE);
    await page.getByRole("tab", { name: /Content/ }).click();
    const box = page.locator('[data-field="title"] textarea, [data-field="title"] input').first();
    await box.waitFor({ timeout: 10_000 });
    await box.fill("Words and content together");
    await motionTab().click();
    await page.locator('[data-motion-field="textReveal"] select').selectOption({ label: "Word by word" });
    const both = await until(async () => {
      const [row] = await sql<{ draft: { title?: { en: string } } | null; draft_motion_config: Doc | null; revision: number }[]>`
        select draft, draft_motion_config, revision from page_sections where id = ${IMAGE}`;
      const title = (row?.draft_motion_config?.nodes?.["field:title"] as { base?: { textReveal?: string } } | undefined)?.base;
      return row?.draft?.title?.en === "Words and content together" && title?.textReveal === "words";
    }, 120);
    const endRevision = await revisionOf(IMAGE);
    say(
      "48c. Word Reveal set while the content is still unsaved: both land, in one queue, content first",
      both && endRevision === startRevision + 2,
      `${both} ${startRevision} → ${endRevision}`,
    );
  }

  /* 45. a page change mid-Replay */
  await settledEditor();
  await selectNode(`section:${WHY}`);
  await page.locator('[data-replay-mode="all"]').click();
  await until(async () => (await replayStatus()) === "started", 40, 100);
  await page.selectOption("#ve-page", "home");
  await settledEditor();
  await quietFor(page, REPLAY_QUIET_MS, "a stale Replay result, if one were coming, arrives in here");
  const pageStatus = await page.locator("[data-replay-status]").count() ? await replayStatus() : "";
  const homeArtifacts = await frame().locator("[data-eod-replay-hover], [data-m-words]").count();
  say("45. switching page mid-Replay leaves no stale result and no artefact", pageStatus === "" && homeArtifacts === 0, `${pageStatus} ${homeArtifacts}`);

  /* 46. a language change mid-Replay */
  await page.selectOption("#ve-page", "about");
  await settledEditor();
  await selectNode(`section:${WHY}`);
  await page.locator('[data-replay-mode="all"]').click();
  await until(async () => (await replayStatus()) === "started", 40, 100);
  await page.getByRole("group", { name: "Canvas language" }).getByRole("button").nth(1).click();
  await settledEditor();
  await quietFor(page, REPLAY_QUIET_MS, "a stale Replay result, if one were coming, arrives in here");
  const localeStatus = await page.locator("[data-replay-status]").count() ? await replayStatus() : "";
  const localeArtifacts = await frame().locator("[data-eod-replay-hover], [data-m-words]").count();
  say(
    "46. switching language mid-Replay leaves no stale result and no artefact",
    localeStatus === "" && localeArtifacts === 0 && frame().url().includes("/ar/"),
    `${localeStatus} ${localeArtifacts} ${frame().url()}`,
  );
  await page.getByRole("group", { name: "Canvas language" }).getByRole("button").nth(0).click();
  await settledEditor();

  /* 47. a canvas reload mid-Replay */
  await selectNode(`section:${WHY}`);
  await page.locator('[data-replay-mode="all"]').click();
  await until(async () => (await replayStatus()) === "started", 40, 100);
  await page.getByRole("button", { name: /Reload/ }).first().click();
  await settledEditor();
  await quietFor(page, REPLAY_QUIET_MS, "a stale Replay result, if one were coming, arrives in here");
  const reloadStatus = await page.locator("[data-replay-status]").count() ? await replayStatus() : "";
  const reloadArtifacts = await frame().locator("[data-eod-replay-hover], [data-m-words]").count();
  say("47. reloading the canvas mid-Replay leaves no stale result and no artefact", reloadStatus === "" && reloadArtifacts === 0, `${reloadStatus} ${reloadArtifacts}`);

  say("99. no page errors on the public pages", publicErrors.length === 0, publicErrors.join(" | "));
  say("99a. no page errors in the editor", editorErrors.length === 0, editorErrors.join(" | "));
  await editorContext.close();
  await pub.close();
  await reduced.close();
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
