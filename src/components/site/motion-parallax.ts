/**
 * The one parallax coordinator a page runs (Batch 15b).
 *
 * Parallax is the one Visual Editor movement that needs script: it follows the
 * scroll position, and nothing in CSS this site can rely on in every browser
 * does that. So it is done once, here, for every drifting element on the page:
 *
 *   · **one** passive `scroll` listener and **one** `resize` listener, attached
 *     while at least one element is registered and removed with the last one;
 *   · **one** animation frame at a time, requested by a scroll, a resize, an
 *     element coming into range or an element settling — and not requested
 *     again once a frame finds nothing left to do, so a page that is not
 *     scrolling runs no loop at all;
 *   · **one** `IntersectionObserver` that keeps the active set to what is near
 *     the viewport, so an element two screens away costs nothing per frame;
 *   · **one** registry, keyed by element.
 *
 * ## The frame, read then write
 *
 * A frame reads everything first — the viewport height once, the width's
 * drift distances once after a resize, then one rectangle per *active* element
 * — and only then writes, one `--m-py` per element whose offset actually moved
 * by a quarter of a pixel or more. No read ever follows a write inside a frame,
 * so the browser lays the page out once per frame at most, not once per
 * element. The rectangle includes the offset this module applied last time, so
 * that is subtracted back out before the element's position is judged; the
 * offset never feeds on itself.
 *
 * Why a rectangle per frame rather than a position measured once: an element
 * inside a sticky column, a section above that grows when its images arrive, an
 * accordion that opens — each moves an element without a resize, and a cached
 * position would drift out of true until the next one. Reading the rectangles
 * of the few active elements in one batch is what the browser was about to do
 * anyway.
 *
 * ## The offset
 *
 * Progress runs from -1, as an element's centre enters at the bottom of the
 * viewport, through 0 at the middle, to 1 as it leaves at the top. The offset
 * is `-progress × distance`, so an element travels a little less far than the
 * page does: it seems to sit slightly behind it. At the middle of the viewport
 * every element is exactly where the layout put it. `distance` is the element's
 * `--m-pd` at the current width — a value from `PARALLAX_DISTANCE`, promoted by
 * the stylesheet for tablet and mobile — so a Mobile of None reads 0 and the
 * element is left at rest.
 *
 * A newly registered element eases into its offset over `SETTLE_MS` instead of
 * appearing at it: the page was painted before this ran, and an element that
 * is already on screen must not jump by its distance at hydration.
 *
 * ## What it never does
 *
 * No React state, no per-element listener, no per-element frame, no library.
 * Nothing under reduced motion: the stylesheet already holds every drifting
 * element at rest, and this stops writing altogether and removes its scroll
 * listener — and starts again, from rest, if the preference is turned off
 * while the page is open. In the Visual Editor it is never loaded at all:
 * `MotionRuntime` is told by the server that live parallax is paused there.
 */

type Entry = {
  element: HTMLElement;
  /** Pixels at the current width; re-read after a resize. */
  distance: number;
  /** The offset last written, which the next rectangle already includes. */
  applied: number;
  /** Near enough to the viewport to be worth a rectangle this frame. */
  active: boolean;
  /** When it was registered, for the settle-in. */
  since: number;
};

/** How long a newly registered element takes to ease into its offset. */
export const SETTLE_MS = 400;
/** Elements this far beyond the viewport are kept up to date, so none arrives stale. */
const ACTIVE_MARGIN = "25% 0px 25% 0px";
/** Movement smaller than this is not written: nobody can see it, and every write costs a style recalc. */
const MIN_STEP = 0.25;

const entries = new Map<Element, Entry>();
let observer: IntersectionObserver | null = null;
let reducedQuery: MediaQueryList | null = null;
let listening = false;
let frame = 0;
let distancesStale = true;

/**
 * Counters the performance probe reads back; nothing in the page depends on
 * them. `rectReads` are the per-frame reads (one rectangle per active element);
 * `styleReads` happen only after a registration or a resize.
 */
const counters = { frames: 0, rectReads: 0, styleReads: 0, writes: 0, peakFrameReads: 0 };

const reduced = (): boolean => reducedQuery?.matches ?? false;

function schedule() {
  if (frame || !listening) return;
  frame = window.requestAnimationFrame(tick);
}

const onScroll = () => schedule();
const onResize = () => {
  distancesStale = true;
  schedule();
};

/** Ease-out: most of the settle happens early, and the last few pixels arrive gently. */
const settle = (t: number): number => 1 - (1 - t) ** 3;

function tick(now: number) {
  frame = 0;
  if (!listening) return;
  counters.frames += 1;

  // ---- Reads -------------------------------------------------------------
  if (distancesStale) {
    distancesStale = false;
    for (const entry of entries.values()) {
      const raw = window.getComputedStyle(entry.element).getPropertyValue("--m-pd");
      const distance = Number.parseFloat(raw);
      entry.distance = Number.isFinite(distance) && distance > 0 ? distance : 0;
      counters.styleReads += 1;
    }
  }
  const viewport = window.innerHeight;
  const writes: [Entry, number][] = [];
  let settling = false;
  let frameReads = 0;

  for (const entry of entries.values()) {
    if (!entry.active) continue;
    if (entry.distance === 0) {
      // Parallax is off at this width: return to rest once, then leave it be.
      if (entry.applied !== 0) writes.push([entry, 0]);
      continue;
    }
    const rect = entry.element.getBoundingClientRect();
    counters.rectReads += 1;
    frameReads += 1;
    // Hidden at this width: nothing to place.
    if (rect.width === 0 && rect.height === 0) continue;
    const centre = rect.top + rect.height / 2 - entry.applied;
    const reach = (viewport + rect.height) / 2;
    const progress = Math.max(-1, Math.min(1, (centre - viewport / 2) / reach));
    let offset = -progress * entry.distance;
    const age = now - entry.since;
    if (age < SETTLE_MS) {
      offset *= settle(Math.max(0, age) / SETTLE_MS);
      settling = true;
    }
    writes.push([entry, Math.round(offset * 10) / 10]);
  }

  counters.peakFrameReads = Math.max(counters.peakFrameReads, frameReads);

  // ---- Writes ------------------------------------------------------------
  for (const [entry, offset] of writes) {
    if (Math.abs(offset - entry.applied) < MIN_STEP && !(offset === 0 && entry.applied !== 0)) continue;
    if (offset === 0) entry.element.style.removeProperty("--m-py");
    else entry.element.style.setProperty("--m-py", `${offset}px`);
    entry.applied = offset;
    counters.writes += 1;
  }

  // Only a settle-in keeps the loop alive on its own; everything else waits
  // for the next scroll, resize or element coming into range.
  if (settling) schedule();
}

/** Puts every registered element back at rest — for reduced motion, and on the way out. */
function rest() {
  for (const entry of entries.values()) {
    if (entry.applied !== 0) entry.element.style.removeProperty("--m-py");
    entry.applied = 0;
  }
}

function attachInput() {
  if (listening) return;
  listening = true;
  window.addEventListener("scroll", onScroll, { passive: true });
  window.addEventListener("resize", onResize, { passive: true });
}

function detachInput() {
  if (!listening) return;
  listening = false;
  window.removeEventListener("scroll", onScroll);
  window.removeEventListener("resize", onResize);
  if (frame) window.cancelAnimationFrame(frame);
  frame = 0;
}

/**
 * The visitor's motion preference, followed while the page is open.
 *
 * Turning reduced motion on stops every write and removes the scroll listener;
 * turning it off starts again, easing each element in from rest as if it had
 * just been registered.
 */
function onPreference() {
  if (reduced()) {
    detachInput();
    rest();
    return;
  }
  const now = window.performance.now();
  for (const entry of entries.values()) entry.since = now;
  distancesStale = true;
  attachInput();
  schedule();
}

function setUp() {
  if (observer) return;
  observer = new IntersectionObserver(
    (records) => {
      let entered = false;
      for (const record of records) {
        const entry = entries.get(record.target);
        if (!entry) continue;
        entry.active = record.isIntersecting;
        if (record.isIntersecting) entered = true;
      }
      if (entered) schedule();
    },
    { rootMargin: ACTIVE_MARGIN, threshold: 0 },
  );
  reducedQuery =
    typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null;
  reducedQuery?.addEventListener("change", onPreference);
  if (!reduced()) attachInput();
}

function tearDown() {
  detachInput();
  observer?.disconnect();
  observer = null;
  reducedQuery?.removeEventListener("change", onPreference);
  reducedQuery = null;
  distancesStale = true;
}

/**
 * Adds one element to the page's parallax, and returns the way to take it out
 * again. Registering the same element twice replaces the first registration.
 */
export function registerParallax(element: HTMLElement): () => void {
  setUp();
  entries.set(element, {
    element,
    distance: 0,
    applied: 0,
    active: false,
    since: window.performance.now(),
  });
  distancesStale = true;
  observer!.observe(element);
  schedule();

  return () => {
    const entry = entries.get(element);
    if (!entry) return;
    entries.delete(element);
    observer?.unobserve(element);
    if (entry.applied !== 0) element.style.removeProperty("--m-py");
    if (!entries.size) tearDown();
  };
}

/**
 * What the coordinator is doing, for the performance probe: how many elements
 * it holds and how many are active, whether its scroll listener is attached,
 * whether a frame is pending, and running totals of frames, reads and writes.
 */
export function parallaxStats() {
  let active = 0;
  for (const entry of entries.values()) if (entry.active) active += 1;
  return {
    registered: entries.size,
    active,
    listening: listening ? 1 : 0,
    framePending: frame ? 1 : 0,
    ...counters,
  };
}
