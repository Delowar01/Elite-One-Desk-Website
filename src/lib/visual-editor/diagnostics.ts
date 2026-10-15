/**
 * The Visual Editor's readiness timeline (Batch 27 Correction 1).
 *
 * **Off unless the server was started with `EOD_EDITOR_DIAGNOSTICS=1`.** The
 * switch is read on the server, per request (`diagnostics-server.ts`), and
 * reaches the two components that record as a `diagnostics` prop: the editor's
 * canvas (through the editor page and its shell) and the canvas's bridge, which
 * is only ever rendered into an authorised editor canvas. A visitor's page is
 * not touched in any mode — no attribute, no prop, nothing — and a production
 * server, which never sets the switch, records nothing anywhere. Nothing here
 * ever writes to the console or the network. The test servers set it
 * (tests/helpers/server.ts).
 *
 * What it records is *when* each step on the way to "Ready" happened, on both
 * sides of the frame: the editor into `window.__eodEditorTimeline`, the canvas
 * into its own `window.__eodCanvasTimeline`. A probe whose wait for "Ready"
 * runs out reads both, and can then say which step never came — the frame
 * never loaded, the bridge never mounted, its answer was refused — instead of
 * only that a word never appeared (tests/browser/editor-watch.ts).
 *
 * Times are wall-clock milliseconds (`Date.now()`), not `performance.now()`:
 * the two documents have different time origins, and the point is to line
 * their events up with each other and with the server's log.
 */

export const EDITOR_TIMELINE = "__eodEditorTimeline";
export const CANVAS_TIMELINE = "__eodCanvasTimeline";

export type TimelineEntry = { at: number; phase: string; detail?: Record<string, unknown> };
export type TimelineStore = { entries: TimelineEntry[]; dropped: number };
export type Timeline = {
  readonly enabled: boolean;
  mark(phase: string, detail?: Record<string, unknown>): void;
};

/** Enough for a long editing session's handshakes; older entries go first. */
const KEPT = 500;
const OFF: Timeline = { enabled: false, mark: () => undefined };

/**
 * The timeline stored under `key` in this window, or — unless `enabled`, the
 * server's switch as the component received it — a recorder that does nothing
 * at all. Opened by a component after it mounts, never during render.
 */
export function openTimeline(key: typeof EDITOR_TIMELINE | typeof CANVAS_TIMELINE, enabled: boolean): Timeline {
  if (!enabled || typeof window === "undefined") return OFF;
  const holder = window as unknown as Record<string, TimelineStore | undefined>;
  const store = (holder[key] ??= { entries: [], dropped: 0 });
  return {
    enabled: true,
    mark(phase, detail) {
      store.entries.push(detail === undefined ? { at: Date.now(), phase } : { at: Date.now(), phase, detail });
      if (store.entries.length > KEPT) {
        store.dropped += store.entries.length - KEPT;
        store.entries.splice(0, store.entries.length - KEPT);
      }
    },
  };
}

/**
 * What a frame's document looks like from its parent, for the timeline only.
 * Same-origin by construction — the canvas is the site itself — but every read
 * is guarded, because a frame that navigated somewhere else, or is between
 * documents, is exactly the case this is for.
 */
export function frameSnapshot(frame: HTMLIFrameElement | null): Record<string, unknown> {
  if (!frame) return { frame: "none" };
  try {
    const doc = frame.contentDocument;
    const href = frame.contentWindow?.location.href ?? null;
    if (!doc) return { href, document: "unreadable" };
    return {
      href,
      readyState: doc.readyState,
      addressed: doc.querySelectorAll("[data-eod-address]").length,
    };
  } catch {
    return { document: "cross-origin" };
  }
}
