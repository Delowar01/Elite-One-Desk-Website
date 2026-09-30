/**
 * Batch 19A evidence: a wheel sent while a smooth scroll is still gliding is
 * dropped by Chromium — on a plain page, with none of this site's code.
 *
 * The site sets `html { scroll-behavior: smooth }`, so a probe's plain
 * `window.scrollTo(…)` glides for roughly 400 ms. Motion-15b check 11 parked a
 * button that way, waited a fixed 400 ms, then sent a 160 px wheel: whenever
 * the glide was still travelling the wheel disappeared, the page rested on the
 * glide's own target, the button stayed 5 px under the reveal line, and the
 * recording held no entrance at all. That was the whole of the check's
 * intermittency; the application was never involved.
 *
 * This script keeps the demonstration reproducible:
 *
 *   S1  an instant scroll that has arrived, then a wheel: the wheel always
 *       lands — the order every probe now uses;
 *   S2  the same page with `scroll-behavior: auto`: the wheel always lands;
 *   INFO a smooth scroll still gliding, then a wheel: how often the wheel was
 *       lost. Reported, not asserted — it is the browser's behaviour, and a
 *       future Chromium that keeps the wheel would be no failure of ours.
 */
import { launchChromium } from "../browser/harness";

const LOOPS = Number(process.env.STRESS_LOOPS ?? 30);
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const TARGET = 538;
  const WHEEL = 160;

  /** One trial; resolves to where the page ended up. */
  const trial = async (behavior: "smooth" | "auto", park: "instant" | "glide", waitMs: number) => {
    await page.setContent(
      `<!doctype html><style>html{scroll-behavior:${behavior}}body{margin:0;height:4000px}</style><p>plain</p>`,
    );
    // A new document by setContent keeps the previous trial's scroll position:
    // every trial starts from the top, set instantly.
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await page.waitForFunction(() => window.scrollY === 0);
    if (park === "instant") {
      await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), TARGET);
      await page.waitForFunction((top) => Math.round(window.scrollY) === top, TARGET, { timeout: 5_000 });
    } else {
      await page.evaluate((top) => window.scrollTo(0, top), TARGET);
      await page.waitForTimeout(waitMs);
    }
    await page.mouse.move(700, 450);
    await page.mouse.wheel(0, WHEEL);
    // tsx names the function below; a page made by setContent has no `__name`.
    await page.evaluate(() => {
      const holder = window as unknown as { __name?: unknown };
      holder.__name = holder.__name || ((fn: unknown) => fn);
    });
    // Until the page stops moving: the wheel's own smooth animation, bounded.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          let last = -1;
          let same = 0;
          const started = performance.now();
          const tick = () => {
            same = window.scrollY === last ? same + 1 : 0;
            last = window.scrollY;
            if (same >= 10 || performance.now() - started > 3000) resolve();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );
    return Math.round(await page.evaluate(() => window.scrollY));
  };

  let instantLanded = 0;
  for (let i = 0; i < LOOPS; i += 1) if ((await trial("smooth", "instant", 0)) === TARGET + WHEEL) instantLanded += 1;
  say(`S1. an instant scroll that has arrived, then a wheel: the wheel lands (${instantLanded}/${LOOPS})`, instantLanded === LOOPS);

  let autoLanded = 0;
  for (let i = 0; i < LOOPS; i += 1) if ((await trial("auto", "glide", 250)) === TARGET + WHEEL) autoLanded += 1;
  say(`S2. scroll-behavior auto, a wheel 250 ms after the scroll: the wheel lands (${autoLanded}/${LOOPS})`, autoLanded === LOOPS);

  // The probe's old order: glide, a fixed wait around the glide's length, wheel.
  let lost = 0;
  const lostAt: number[] = [];
  for (let i = 0; i < LOOPS; i += 1) {
    const waitMs = 250 + (i % 8) * 25;
    const ended = await trial("smooth", "glide", waitMs);
    if (ended !== TARGET + WHEEL) {
      lost += 1;
      lostAt.push(waitMs);
    }
  }
  console.log(
    `INFO  a wheel sent while a smooth scroll glides (250–425 ms after it began) was lost ${lost}/${LOOPS} times` +
      (lostAt.length ? ` — at ${[...new Set(lostAt)].sort((a, b) => a - b).join(", ")} ms` : ""),
  );
  await context.close();
} finally {
  await browser.close();
}
