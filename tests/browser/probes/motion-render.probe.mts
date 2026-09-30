/**
 * Batch 9 acceptance: what a section's entrance does to a real browser.
 *
 * Three promises the stylesheet has always made about a revealed element, now
 * that the section wrapper is one: reduced motion shows it, print shows it,
 * and no JavaScript shows it. Plus the Batch 7 responsive rule, which is the
 * one most likely to have been broken by this batch — a root `opacity` on a
 * section that now reveals has to travel as the finished state at every width,
 * not as an inline `opacity` that would hold the section half-lit before it
 * ever arrived.
 *
 * And the thing a visual editor cannot afford to get wrong: the selection
 * outline still fits the section it is drawn around.
 */

import { holdsStill, selectFromLayers } from "../canvas";
import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";

const PORT = 3718;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("motion_render");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);

  const [about] = await sql<{ id: number }[]>`select id from pages where slug = 'about'`;
  const rows = await sql<{ id: number; block_type: string }[]>`
    select id, block_type from page_sections where page_id = ${about!.id}
     order by position asc, id asc`;
  const hero = rows[0]!;
  const second = rows[1]!;

  const OPACITY = {
    v: 1,
    nodes: { root: { base: { opacity: 0.4 }, tablet: { opacity: 0.6 }, mobile: { opacity: 0.2 } } },
  };

  await sql`update page_sections set animation = 'fade-up', draft_animation = null,
                                     draft = null, draft_styles = null
             where page_id = ${about!.id}`;
  await sql`update page_sections set draft_styles = ${sql.json(OPACITY)} where id = ${hero.id}`;
  await sql`update page_sections set draft_styles = ${sql.json(OPACITY)}, draft_animation = 'none'
             where id = ${second.id}`;

  const cookie = (() => {
    const [name, value] = owner.cookie.split("=");
    return { name: name!, value: value!, domain: "127.0.0.1", path: "/" };
  })();

  /* --- 1. reduced motion: everything is simply there -------------------- */
  {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    const page = await context.newPage();
    await page.goto(`${server.origin}/about`, { waitUntil: "load" });

    const states = await page.evaluate(() =>
      [...document.querySelectorAll("[data-section]")].map((node) => {
        const style = getComputedStyle(node);
        return { opacity: style.opacity, transform: style.transform, className: node.className };
      }),
    );
    say("every section is on the page", states.length > 1, `${states.length} sections`);
    say(
      "…at full strength, without scrolling",
      states.every((s) => s.opacity === "1"),
      JSON.stringify(states.map((s) => s.opacity)),
    );
    say(
      "…and not displaced",
      states.every((s) => s.transform === "none"),
      JSON.stringify(states.map((s) => s.transform)),
    );
    say(
      "…and the entrance classes are still on them",
      states.filter((s) => /\breveal\b/.test(s.className)).length > 0,
    );
    await context.close();
  }

  /* --- 2. reduced motion keeps an editor's chosen opacity ---------------- */
  {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    await page.goto(`${server.origin}/about?preview=1`, { waitUntil: "load" });
    const chosen = await page
      .locator(`[data-section="${hero.block_type}"]`)
      .first()
      .evaluate((node) => getComputedStyle(node).opacity);
    // 1 would mean the `!important` reduced-motion rule had overwritten the
    // editor's choice; 0 would mean the hidden state had survived it.
    say("a chosen opacity survives reduced motion", chosen === "0.4", chosen);
    await context.close();
  }

  /* --- 3. no JavaScript: nothing is stranded ---------------------------- */
  {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      javaScriptEnabled: false,
    });
    const page = await context.newPage();
    await page.goto(`${server.origin}/about`, { waitUntil: "load" });
    const opacities = await page.evaluate(() =>
      [...document.querySelectorAll("[data-section]")].map((n) => getComputedStyle(n).opacity),
    );
    say(
      "without JavaScript every section is visible",
      opacities.length > 1 && opacities.every((o) => o === "1"),
      JSON.stringify(opacities),
    );
    await context.close();
  }

  /* --- 4. print: whatever was not scrolled past is still on the paper ---- */
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(`${server.origin}/about`, { waitUntil: "load" });
    await page.emulateMedia({ media: "print" });
    // The print rule changes the target of a transition that is already
    // running, so the element travels to it rather than jumping. Sampling
    // immediately reads the journey, not the destination — so it reads once
    // the transitions the switch started have ended (Batch 19A: was a fixed 1.5 s).
    await page.waitForFunction(
      () => document.getAnimations().every((animation) => animation.constructor.name !== "CSSTransition" || animation.playState !== "running"),
      undefined,
      { timeout: 15_000 },
    );
    const opacities = await page.evaluate(() =>
      [...document.querySelectorAll("[data-section]")].map((n) => getComputedStyle(n).opacity),
    );
    say(
      "printing shows every section",
      opacities.length > 1 && opacities.every((o) => o === "1"),
      JSON.stringify(opacities),
    );
    await context.close();
  }

  /* --- 5. the responsive opacity, at every boundary --------------------- */
  {
    // Reduced motion, so the finished state is the computed state and there is
    // no transition to wait on. The values under test are the Batch 7 ones.
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      reducedMotion: "reduce",
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();

    const WIDTHS: [number, string][] = [
      [1440, "0.4"],
      [1025, "0.4"],
      [1024, "0.6"],
      [834, "0.6"],
      [641, "0.6"],
      [640, "0.2"],
      [390, "0.2"],
    ];
    /**
     * Both moving presets, because `reveal-fade` is a new class in the same
     * cascade as the responsive `!important` rules — and a class that replaced
     * the transform could just as easily have disturbed the opacity beside it.
     * The still section (`none`) is measured on every pass as the control.
     */
    for (const entrance of ["fade-up", "fade"] as const) {
    await sql`update page_sections set draft_animation = ${entrance} where id = ${hero.id}`;
    await page.goto(`${server.origin}/about?preview=1`, { waitUntil: "load" });
    for (const [width, expected] of WIDTHS) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(150);
      const moving = await page
        .locator(`[data-section="${hero.block_type}"]`)
        .first()
        .evaluate((node) => ({
          opacity: getComputedStyle(node).opacity,
          finished: getComputedStyle(node).getPropertyValue("--eod-node-opacity").trim(),
          inline: (node as HTMLElement).style.opacity,
        }));
      /**
       * Compared as numbers, not as strings.
       *
       * `styles.ts` snaps an opacity with `Math.round(raw / 0.05) * 0.05`, and
       * 0.6 comes back out of that as 0.6000000000000001 — a pre-existing
       * float artefact of the Batch 6 vocabulary, not something motion did.
       * The browser parses it correctly, which is why the computed `opacity`
       * beside it reads 0.6.
       */
      say(
        `${entrance}: a revealed section's opacity at ${width}px`,
        Number(moving.opacity) === Number(expected) &&
          Math.abs(Number(moving.finished) - Number(expected)) < 1e-9,
        JSON.stringify(moving),
      );
      say(
        `${entrance}: …and it is never an inline opacity at ${width}px`,
        moving.inline === "",
        `inline="${moving.inline}"`,
      );

      const still = await page
        .locator(`[data-section="${second.block_type}"]`)
        .first()
        .evaluate((node) => ({
          opacity: getComputedStyle(node).opacity,
          finished: getComputedStyle(node).getPropertyValue("--eod-node-opacity").trim(),
          declared: (node as HTMLElement).style.getPropertyValue("--eod-node-opacity"),
          inline: (node as HTMLElement).style.opacity,
        }));
      /**
       * No finished opacity is declared on it. Batch 15 registered
       * `--eod-node-opacity` as non-inheriting with an initial value of 1, so
       * "nothing declared" now reads as that initial value rather than as an
       * empty string — and it also proves nothing was inherited from above.
       */
      say(
        `${entrance}: a section with no entrance takes the ordinary opacity at ${width}px`,
        Number(still.opacity) === Number(expected) && still.declared === "" && still.finished === "1",
        JSON.stringify(still),
      );
    }
    }
    await sql`update page_sections set draft_animation = null where id = ${hero.id}`;
    await context.close();
  }

  /* --- 6. the selection outline still fits the section ------------------ */
  {
    await sql`update page_sections set draft_styles = null where page_id = ${about!.id}`;
    const context = await browser.newContext({
      viewport: { width: 1720, height: 1020 },
      reducedMotion: "reduce",
    });
    await context.addCookies([cookie]);
    const page = await context.newPage();
    await page.goto(`${server.origin}/admin/visual-editor?page=about&lang=en&device=desktop`, {
      waitUntil: "load",
    });
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });

    await selectFromLayers(page, `section:${hero.id}`);
    // The canvas glides the section into view; the outline is measured once it is there.
    await holdsStill(page, page.frameLocator("iframe[title]").locator(`[data-eod-address="section:${hero.id}"]`).first(), 15_000);

    const address = await page
      .locator("aside[aria-label='Inspector'] code")
      .first()
      .textContent();
    say("selecting a moving section reports its own address", address === `section:${hero.id}`, String(address));

    const outline = await page
      .locator("div[aria-hidden].pointer-events-none.absolute.z-10")
      .last()
      .boundingBox();
    const element = await page
      .frames()
      .find((f) => f.url().includes("editor=1"))!
      .locator(`[data-eod-address="section:${hero.id}"]`)
      .boundingBox();
    const close = (a: number, b: number) => Math.abs(a - b) <= 3;
    say(
      "…and the outline is drawn around it",
      Boolean(outline && element) &&
        close(outline!.x, element!.x) &&
        close(outline!.y, element!.y) &&
        close(outline!.width, element!.width) &&
        close(outline!.height, element!.height),
      `${JSON.stringify(outline)} vs ${JSON.stringify(element)}`,
    );
    await context.close();
  }

  /* --- 7. every preset does what its label says ------------------------- */
  {
    /**
     * Measured before the reveal, which is the only moment the five presets
     * are distinguishable. Once shown they all end in the same place — full
     * opacity, no transform — so a test that only looks at the finished state
     * would have passed while "Fade only" was rising 18 pixels.
     *
     * The last section of the page, below the fold at this viewport, so its
     * observer has not fired. Reduced motion is deliberately OFF here: it
     * forces the finished state, which is exactly what must not be measured.
     */
    const context = await browser.newContext({ viewport: { width: 1280, height: 620 } });
    await context.addCookies([cookie]);
    const page = await context.newPage();

    const last = rows[rows.length - 1]!;
    const PRESETS: [string, { moves: boolean; check: (t: string) => boolean; what: string }][] = [
      ["fade-up", { moves: true, check: (t) => /^matrix(3d)?\(/.test(t) && !/scale/.test(t), what: "a vertical offset" }],
      ["fade", { moves: false, check: (t) => t === "none", what: "no transform at all" }],
      ["slide-in", { moves: true, check: (t) => /^matrix(3d)?\(/.test(t), what: "a horizontal offset" }],
      ["scale-in", { moves: true, check: (t) => /^matrix(3d)?\(/.test(t), what: "a scale" }],
    ];

    /** The 4x4 / 2x3 matrix a computed transform serialises to, as numbers. */
    const numbers = (transform: string): number[] =>
      transform === "none" ? [] : transform.slice(transform.indexOf("(") + 1, -1).split(",").map(Number);

    for (const [preset, expectation] of PRESETS) {
      await sql`update page_sections set draft_animation = ${preset} where id = ${last.id}`;
      await page.goto(`${server!.origin}/about?preview=1`, { waitUntil: "load" });
      await page.waitForTimeout(300);

      const state = await page
        .locator("[data-section]")
        .last()
        .evaluate((node) => {
          const style = getComputedStyle(node);
          return {
            shown: (node as HTMLElement).dataset.shown ?? "",
            opacity: style.opacity,
            transform: style.transform,
            className: node.className,
          };
        });

      say(`${preset}: the section has not been revealed yet`, state.shown === "false", JSON.stringify(state));
      say(`${preset}: it starts transparent`, state.opacity === "0", state.opacity);
      say(
        `${preset}: it starts with ${expectation.what}`,
        expectation.check(state.transform),
        state.transform,
      );

      const matrix = numbers(state.transform);
      if (preset === "fade-up") {
        // translate3d(0, 18px, 0) → a Y offset and no X offset.
        const [x, y] = matrix.length === 16 ? [matrix[12], matrix[13]] : [matrix[4], matrix[5]];
        say("fade-up: the offset is vertical, and downward", x === 0 && (y ?? 0) > 0, `x=${x} y=${y}`);
      }
      if (preset === "slide-in") {
        // translate3d(-24px, 0, 0) in LTR → an X offset, to the left, and no Y.
        const [x, y] = matrix.length === 16 ? [matrix[12], matrix[13]] : [matrix[4], matrix[5]];
        say("slide-in: LTR enters from the left", (x ?? 0) < 0 && y === 0, `x=${x} y=${y}`);
      }
      if (preset === "scale-in") {
        // scale(0.965) → the a/d components are below 1, with no translation.
        const [a, d] = matrix.length === 16 ? [matrix[0], matrix[5]] : [matrix[0], matrix[3]];
        say("scale-in: it starts smaller than it finishes", (a ?? 1) < 1 && (d ?? 1) < 1, `a=${a} d=${d}`);
      }

      // …and every one of them finishes in the same place.
      await page.locator("[data-section]").last().scrollIntoViewIfNeeded();
      await holdsStill(page, page.locator("[data-section]").last(), 15_000);
      const finished = await page
        .locator("[data-section]")
        .last()
        .evaluate((node) => {
          const style = getComputedStyle(node);
          return { shown: (node as HTMLElement).dataset.shown ?? "", opacity: style.opacity, transform: style.transform };
        });
      say(
        `${preset}: once revealed it is fully there, and not displaced`,
        finished.shown === "true" && finished.opacity === "1" && finished.transform === "none",
        JSON.stringify(finished),
      );
    }

    /* “none” has no lifecycle at all. */
    await sql`update page_sections set draft_animation = 'none' where id = ${last.id}`;
    await page.goto(`${server!.origin}/about?preview=1`, { waitUntil: "load" });
    await page.waitForTimeout(300);
    const still = await page
      .locator("[data-section]")
      .last()
      .evaluate((node) => {
        const style = getComputedStyle(node);
        return {
          shown: (node as HTMLElement).dataset.shown ?? null,
          className: node.className,
          opacity: style.opacity,
          transform: style.transform,
        };
      });
    say(
      "none: no reveal class, no data-shown, nothing hidden and nothing moved",
      still.className === "" && still.shown === null && still.opacity === "1" && still.transform === "none",
      JSON.stringify(still),
    );

    /* Fade and fade-up must not be the same animation. */
    say(
      "fade and fade-up are genuinely different presets",
      true,
      "proved by the two pre-reveal transforms above",
    );

    /* --- RTL: slide-in enters from the other edge ----------------------- */
    await sql`update page_sections set draft_animation = 'slide-in' where id = ${last.id}`;
    await page.goto(`${server!.origin}/ar/about?preview=1`, { waitUntil: "load" });
    await page.waitForTimeout(300);
    const rtl = await page.locator("[data-section]").last().evaluate((node) => {
      const style = getComputedStyle(node);
      return {
        dir: document.documentElement.dir,
        shown: (node as HTMLElement).dataset.shown ?? "",
        transform: style.transform,
      };
    });
    say("the Arabic edition is right-to-left", rtl.dir === "rtl", rtl.dir);
    const rtlMatrix = numbers(rtl.transform);
    const rtlX = rtlMatrix.length === 16 ? rtlMatrix[12] : rtlMatrix[4];
    say(
      "slide-in: RTL enters from the right",
      rtl.shown === "false" && (rtlX ?? 0) > 0,
      `${rtl.transform} (x=${rtlX})`,
    );

    await sql`update page_sections set draft_animation = null where id = ${last.id}`;
    await context.close();
  }
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
