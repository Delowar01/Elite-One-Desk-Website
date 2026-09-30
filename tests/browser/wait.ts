/**
 * Waiting, in the browser probes, for something that can be named.
 *
 * Two kinds of wait exist here and nothing else (Batch 19A):
 *
 *   · `until` — a condition, polled, with a bound. It returns as soon as the
 *     condition holds and reports whether it ever did, so the check that
 *     follows can say *what* did not happen rather than time out mutely.
 *
 *   · `quietFor` — an observation window, for claims that something does
 *     *not* happen: no autosave after Discard, no stale Replay result after a
 *     page switch. A negative cannot be polled for; it can only be watched for
 *     long enough. Every window is named after the timer it outlasts, so the
 *     length is an argument rather than a guess, and it says why it exists.
 *
 * A fixed sleep used to wait for something to *happen* is neither, and is what
 * the probes are being rid of: on a slow machine it is too short, and on a
 * fast one it hides nothing but time.
 */
import type { Locator, Page, Request } from "playwright";

/**
 * The editor's autosave debounce: `AUTOSAVE_DELAY_MS` in
 * `src/components/admin/visual-editor/shell.tsx`. `tests/browser-suite.test.ts`
 * reads that file and fails if the two ever differ.
 */
export const AUTOSAVE_DELAY_MS = 1100;

/** Long enough for an autosave that was going to fire to have fired and been answered. */
export const AUTOSAVE_QUIET_MS = AUTOSAVE_DELAY_MS + 1500;

/**
 * How long a probe watches for a stale Replay result after the page, the
 * language or the canvas changed under a Replay that had started. The canvas
 * that was playing it is gone by then — its messages are refused by source —
 * so this outlasts the remaining sweep or hover phases of `REPLAY_LIMITS`
 * (`src/components/site/motion-replay.ts`) rather than the whole entrance
 * budget.
 */
export const REPLAY_QUIET_MS = 2500;

/** Polls `check` until it holds or `timeoutMs` passes. Never throws for the timeout. */
export async function until(check: () => Promise<boolean>, timeoutMs = 10_000, everyMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check().catch(() => false)) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, everyMs));
  }
}

/**
 * An observation window: watches for `ms` so that something which must not
 * happen has had its chance to. `why` is required and is the reason the
 * window exists; it is not printed, it is for the reader of the probe.
 */
export async function quietFor(page: Page, ms: number, why: string): Promise<void> {
  void why;
  await page.waitForTimeout(ms);
}

/**
 * Until nothing finite is animating on `target`, inside it, or on anything
 * containing it — an entrance, a reveal's transition, a hover settling.
 * Bounded; returns whether it settled.
 */
export async function animationsDone(target: Locator, timeoutMs = 10_000): Promise<boolean> {
  return until(
    () =>
      target.evaluate((element) => {
        const chain: Element[] = [];
        for (let node: Element | null = element; node; node = node.parentElement) chain.push(node);
        return !document.getAnimations().some((animation) => {
          if (animation.playState !== "running") return false;
          const effect = animation.effect as KeyframeEffect | null;
          const node = effect?.target;
          if (!node || !Number.isFinite(effect!.getComputedTiming().endTime as number)) return false;
          return chain.includes(node) || element.contains(node);
        });
      }),
    timeoutMs,
  );
}

/**
 * Watches a page's requests from now on, so a probe can wait until nothing
 * is in flight — the section a selection loads, an autosave, a revalidation.
 * Create it once, when the page is opened: a request that began before the
 * watcher existed cannot be seen ending.
 */
export function watchNetwork(page: Page) {
  const inFlight = new Set<Request>();
  let lastChange = Date.now();
  page.on("request", (request) => {
    inFlight.add(request);
    lastChange = Date.now();
  });
  const ended = (request: Request) => {
    inFlight.delete(request);
    lastChange = Date.now();
  };
  page.on("requestfinished", ended);
  page.on("requestfailed", ended);
  return {
    /** Until no request has been in flight for `quietMs`. Bounded; returns whether it got there. */
    quiet: (quietMs = 500, timeoutMs = 15_000) =>
      until(async () => inFlight.size === 0 && Date.now() - lastChange >= quietMs, timeoutMs, 25),
  };
}
