"use client";

/**
 * The one IntersectionObserver a page runs for its entrances.
 *
 * Batch 9 gave every revealed element an observer of its own, created in an
 * effect and disconnected on its first intersection. That is correct and it is
 * also one observer per card, per row and per section — twenty-odd on the
 * homepage — and it would have become one per staggered child, per animated
 * heading and per animated picture once motion could be set on any node.
 *
 * So there is exactly one, created lazily the first time anything asks, with
 * the same `rootMargin` and `threshold` every reveal has always used. An
 * element is registered with a callback, the callback runs once on its first
 * intersection, and the element is unobserved at that moment — the same
 * show-once semantics as before, with one observer however many elements are
 * waiting. Everything that reveals on scroll goes through here: `Reveal`,
 * `SectionMotion`, and the `MotionRuntime` that drives server-rendered nodes.
 *
 * Reduced motion never registers anything: the callback runs immediately,
 * because an entrance a visitor has asked not to see must not wait for a
 * scroll to show its content.
 */

type Callback = () => void;

/** The options every entrance on this site has always used. */
export const REVEAL_OBSERVER_OPTIONS: IntersectionObserverInit = {
  rootMargin: "0px 0px -8% 0px",
  threshold: 0.08,
};

let observer: IntersectionObserver | null = null;
const waiting = new Map<Element, Callback>();

function shared(): IntersectionObserver {
  if (observer) return observer;
  observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const show = waiting.get(entry.target);
      if (!show) continue;
      waiting.delete(entry.target);
      observer?.unobserve(entry.target);
      show();
    }
  }, REVEAL_OBSERVER_OPTIONS);
  return observer;
}

export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" &&
  typeof window.matchMedia === "function" &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Runs `show` once, the first time `element` is reached — or at once, for a
 * visitor who prefers reduced motion. Returns the way to stop waiting.
 */
export function whenReached(element: Element, show: Callback): () => void {
  if (prefersReducedMotion()) {
    show();
    return () => undefined;
  }
  waiting.set(element, show);
  shared().observe(element);
  return () => {
    if (!waiting.delete(element)) return;
    observer?.unobserve(element);
  };
}

/**
 * How many observers exist and how many elements are waiting on them — the
 * numbers the performance audit reads back from a real page.
 */
export function revealObserverStats(): { observers: number; waiting: number } {
  return { observers: observer ? 1 : 0, waiting: waiting.size };
}
