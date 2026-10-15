"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Locale } from "@/lib/i18n/config";
import { previewPagePath, previewRoutePath } from "@/lib/page-path";
import { EDITOR_TIMELINE, frameSnapshot, openTimeline, type Timeline } from "@/lib/visual-editor/diagnostics";
import { describeAddress } from "@/lib/visual-editor/labels";
import { intersectsViewport, toOverlayRect, type Rect } from "@/lib/visual-editor/overlay";
import {
  bridgeOrigin,
  envelope,
  envelopeVerdict,
  newBridgeId,
  readCanvasMessage,
  type EditorNodeMeta,
  type EditorSectionMeta,
  type ReplayMode,
  type ReplayOutcome,
  type ShortcutCommand,
} from "@/lib/visual-editor/protocol";
import { deviceWidth, type DeviceKey } from "@/lib/visual-editor/viewport";

export type CanvasStatus = "loading" | "connecting" | "ready" | "error";

export type CanvasState = {
  status: CanvasStatus;
  /** `window.innerWidth` as the canvas document itself reported it. */
  innerWidth: number | null;
  message: string | null;
};

/**
 * What the editor wants selected — or, with a null address, unselected.
 *
 * The token is what makes asking twice for the same thing two requests: a
 * Layers row clicked again should still scroll its section back into view.
 */
export type SelectRequest = { address: string | null; scrollIntoView: boolean; token: number } | null;

/**
 * Asking the canvas to start or stop typing into a node.
 *
 * Carries a token for the same reason `SelectRequest` does: asking twice for
 * the same node is a real request, and without something that changes, the
 * effect that sends it would not run the second time.
 */
export type EditRequest =
  | { kind: "begin"; address: string; token: number; text: string }
  | { kind: "cancel"; token: number }
  | null;

/**
 * Asking the canvas to play, or stop playing, one node's motion (Batch 15b).
 * Nothing about it is saved: it travels to the canvas and back, and that is all.
 */
export type ReplayRequest =
  | { kind: "play"; address: string; token: number; mode: ReplayMode }
  | { kind: "cancel"; token: number }
  | null;

const PING_EVERY_MS = 500;
const GIVE_UP_AFTER_MS = 20_000;

/**
 * The real website, in a frame, at a real device width — and the overlays that
 * point at things inside it.
 *
 * Three things this component is careful about.
 *
 * **The frame's logical width is never negotiable.** `width` is the device's
 * own pixel width and the frame is *scaled* to fit the stage. Giving it a
 * `max-width` instead would be the easy version and the wrong one: the page
 * inside would lay itself out at whatever the admin workspace happened to be,
 * and an editor on a 1280px laptop choosing "Desktop 1440" would be looking at
 * a layout no visitor ever sees. A scaled 1440px document is still 1440px —
 * same media queries, same grid, same `window.innerWidth`, which the canvas
 * reports back so the claim can be checked rather than trusted.
 *
 * **Ready means the handshake happened.** `onLoad` only says a document
 * arrived; it says nothing about *which* document, and it fires just the same
 * for a login redirect or a 404. The canvas is Ready only once a `canvas.ready`
 * carrying this bridge id and this page's slug has come back through
 * `postMessage` from this frame's own window.
 *
 * **The overlays live out here.** Nothing is drawn inside the page: an outline
 * injected into the canvas would be layout the real site does not have, and an
 * editor would be positioning elements around a box that only exists while they
 * are looking. The rectangles come over the bridge in the canvas's own viewport
 * coordinates and are converted once, here, where the scale is known.
 */
export function VisualCanvas({
  diagnostics = false,
  slug,
  publicPath,
  locale,
  device,
  canvasKey,
  title,
  selectRequest,
  editRequest,
  replayRequest,
  locks,
  onState,
  onStructure,
  onSelection,
  onEdit,
  onEditRequest,
  onReplayResult,
  onShortcut,
}: {
  /**
   * The readiness timeline's switch (Batch 27 Correction 1): the server's
   * EOD_EDITOR_DIAGNOSTICS, off unless a test or an investigation set it.
   */
  diagnostics?: boolean;
  slug: string;
  /**
   * A dynamic route's own public path (Batch 21) — `/services/<slug>`
   * — when the document is a route rather than a CMS page. The canvas then
   * loads that address; `slug` is still what the handshake must answer with.
   */
  publicPath?: string;
  locale: Locale;
  device: DeviceKey;
  /** Changes whenever a genuinely new document is wanted: page, language, reload. */
  canvasKey: number;
  title: string;
  selectRequest: SelectRequest;
  editRequest: EditRequest;
  /** Play or stop a Replay. Editor-side state, never saved. */
  replayRequest: ReplayRequest;
  /** Addresses the canvas pointer must ignore. Editor-side state, never saved. */
  locks: string[];
  onState: (state: CanvasState) => void;
  onStructure: (sections: EditorSectionMeta[]) => void;
  onSelection: (node: EditorNodeMeta | null) => void;
  onEdit: (edit: {
    address: string;
    token: number;
    phase: "input" | "commit" | "cancel";
    text: string;
  }) => void;
  /** A double-click asked to edit; the editor decides whether it may begin. */
  onEditRequest: (address: string) => void;
  /** What became of a Replay. The editor decides whether it still belongs here. */
  onReplayResult: (result: { address: string; token: number; outcome: ReplayOutcome }) => void;
  /**
   * Undo or Redo pressed while the canvas had the keyboard (Batch 16). The
   * canvas never sends it while a node is being typed into.
   */
  onShortcut: (command: ShortcutCommand) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [bridgeId, setBridgeId] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);
  /** How many times the document on screen has said it is listening. See the locks below. */
  const [announced, setAnnounced] = useState(0);
  const [stage, setStage] = useState({ width: 0, height: 0 });
  const [hover, setHover] = useState<{ node: EditorNodeMeta; rect: Rect } | null>(null);
  /**
   * The selected node, and where it is — which are two different facts.
   *
   * `rect` is nullable on purpose. A node that is still on the page but
   * momentarily measures nothing — mid-transition, inside something collapsed,
   * a reveal that has not run — has no box to draw and is still the selected
   * node. Dropping the whole selection for a bad measurement would empty the
   * inspector because an animation was halfway through; keeping the node and
   * losing only the rectangle means the outline returns by itself when the
   * element does. A node that has genuinely left the document arrives as
   * `canvas.selection null` instead, and that clears everything.
   */
  const [selection, setSelection] = useState<{ node: EditorNodeMeta; rect: Rect | null } | null>(null);

  /**
   * The readiness timeline (Batch 27 Correction 1, `diagnostics.ts`): each
   * step from minting a bridge to Ready, time-stamped, for a probe whose wait
   * runs out to read back. A recorder that does nothing unless `diagnostics`;
   * it only observes — nothing in this component decides anything by it.
   */
  const timeline = useRef<Timeline | null>(null);
  const mark = (phase: string, detail?: Record<string, unknown>) =>
    (timeline.current ??= openTimeline(EDITOR_TIMELINE, diagnostics)).mark(phase, detail);
  /** Whether the document now in the frame has answered — for the timeline's sampling only. */
  const answered = useRef(false);
  /**
   * The document whose bridge said Ready — so that its own `load` event, which
   * can come after it (see the handshake), is not taken for a new document.
   */
  const readyDocument = useRef<Document | null>(null);

  /**
   * A new document gets a new bridge id, every time.
   *
   * Not only for tidiness: the id is how the editor tells this canvas from the
   * one it is replacing. Reusing it would let a frame that is still unloading
   * answer a handshake meant for its successor, and the editor would call
   * itself Ready while showing the previous page. Generated after mount rather
   * than during render, because the shell is server-rendered too and a value
   * drawn from the random generator on both sides is two different values and a
   * hydration mismatch.
   */
  useEffect(() => {
    mark("canvas.mint", { canvasKey });
    answered.current = false;
    readyDocument.current = null;
    setBridgeId(newBridgeId());
    setLoads(0);
    setAnnounced(0);
    setHover(null);
    setSelection(null);
    onSelection(null);
    onStructure([]);
    onState({ status: "loading", innerWidth: null, message: null });
    // `canvasKey` is the whole dependency: the callbacks are stable and adding
    // them would remint the bridge on every render of the shell.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasKey]);

  // The stage's usable box, remeasured as the window and the panels change.
  useLayoutEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = () => setStage({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  // The handshake, and everything the canvas says afterwards. Listening and
  // counting down from the frame's creation; asking again on every document the
  // frame loads.
  //
  // Not from `load` alone (Batch 27 Correction 1). It used to wait for the
  // frame's load event before it listened or counted down, and a load event
  // waits for every image, font and script in the page. A canvas with one
  // picture that never finished had a bridge that announced itself to nobody,
  // and no timer to say so: the status read "Loading canvas…" for as long as
  // the editor stayed open. The bridge announces itself when it mounts and
  // needs none of that, and Ready is the handshake — so this listens from the
  // start, and its 20 seconds count from the frame's creation as well as from
  // each load. A canvas that never answers now says so.
  useEffect(() => {
    if (!bridgeId) return;
    const origin = bridgeOrigin();
    let settled = false;
    mark("canvas.listen", { loads, bridgeId });

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return;
      // Never the canvas — and asked first, so that nothing reaches into the
      // frame for it (see the pings below).
      if (event.source === window) return;
      // The message has to come from the frame we are actually showing. A
      // stale iframe from a previous page or reload has a different window,
      // and its bridge id no longer matches either.
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;

      const message = readCanvasMessage(event.data, { bridgeId, slug });
      if (!message) return;

      switch (message.type) {
        case "canvas.ready":
          settled = true;
          readyDocument.current = frameRef.current?.contentDocument ?? null;
          setAnnounced((n) => n + 1);
          onState({ status: "ready", innerWidth: message.innerWidth, message: null });
          return;
        case "canvas.structure":
          onStructure(message.sections);
          return;
        case "canvas.hover":
          setHover(message.node ? { node: message.node, rect: message.rect } : null);
          return;
        case "canvas.selection":
          setSelection(message.node ? { node: message.node, rect: message.rect } : null);
          onSelection(message.node);
          return;
        case "canvas.bounds":
          // Only ever the rectangle. Whether something is selected at all is
          // `canvas.selection`'s to say, and this message never answers it.
          setSelection((current) => {
            if (!current || current.node.address !== message.address) return current;
            return { node: current.node, rect: message.rect };
          });
          return;
        case "canvas.edit":
          onEdit({
            address: message.address,
            token: message.token,
            phase: message.phase,
            text: message.text,
          });
          return;
        case "canvas.editRequest":
          onEditRequest(message.address);
          return;
        case "canvas.motionReplayResult":
          onReplayResult({ address: message.address, token: message.token, outcome: message.outcome });
          return;
        case "canvas.shortcut":
          onShortcut(message.command);
          return;
        case "canvas.error":
          onState({ status: "error", innerWidth: null, message: message.message });
          return;
        case "canvas.pong":
          // A pong before the announcement: the channel is alive, so keep
          // waiting rather than counting down to a failure that is not
          // happening.
          if (!settled) onState({ status: "connecting", innerWidth: null, message: null });
          return;
      }
    };

    window.addEventListener("message", onMessage);

    /**
     * With diagnostics on, every message this window receives, read the way
     * `onMessage` reads it — so the timeline shows what the handshake
     * accepted and, by reason, what it refused. Beside it, never in its way:
     * registered after it, deciding nothing.
     */
    const refusals = new Map<string, number>();
    let firstPong = true;
    let firstStructure = true;
    const observe = (event: MessageEvent) => {
      const refuse = (reason: string, detail?: Record<string, unknown>) => {
        const seen = (refusals.get(reason) ?? 0) + 1;
        refusals.set(reason, seen);
        if (seen <= 3 || seen % 50 === 0) mark("canvas.refused", { reason, seen, ...detail });
      };
      if (event.origin !== origin) return refuse("origin", { origin: event.origin });
      if (event.source === window) return;
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return refuse("source");
      const message = readCanvasMessage(event.data, { bridgeId, slug });
      if (!message) {
        const verdict = envelopeVerdict(event.data, { bridgeId });
        const inner = (event.data as { message?: Record<string, unknown> } | null)?.message;
        return refuse(
          verdict.startsWith("type:") ? `content:${verdict.slice(5)}` : verdict,
          verdict === "type:canvas.ready" && inner ? { slug: inner.slug, innerWidth: inner.innerWidth } : undefined,
        );
      }
      if (message.type === "canvas.ready" && !answered.current) {
        answered.current = true;
        mark("canvas.ready", { innerWidth: message.innerWidth, ...frameSnapshot(frameRef.current) });
      } else if (message.type === "canvas.pong" && firstPong) {
        firstPong = false;
        mark("canvas.pong");
      } else if (message.type === "canvas.structure" && firstStructure) {
        firstStructure = false;
        mark("canvas.structure", { sections: message.sections.length });
      }
    };
    if (timeline.current?.enabled) window.addEventListener("message", observe);

    // Pinging asks a document that has loaded to announce itself again — for
    // an announcement that was missed. Never before the first load: until a
    // document arrives the frame holds its initial empty one, and reaching into
    // the frame's window then makes the browser set that window up for good —
    // the canvas inherits it, and whatever a browser runs at the start of a new
    // document (an extension, a test's instrumentation) runs against the empty
    // one instead. Nothing needs it then: the listener above is already there
    // for the bridge's own announcement.
    const ping =
      loads > 0
        ? window.setInterval(() => {
            if (settled) return;
            frameRef.current?.contentWindow?.postMessage(
              envelope(bridgeId, { type: "editor.ping" as const, at: Date.now() }),
              origin,
            );
          }, PING_EVERY_MS)
        : undefined;

    const giveUp = window.setTimeout(() => {
      if (settled) return;
      mark("canvas.giveUp", loads > 0 ? frameSnapshot(frameRef.current) : { loads, src: frameRef.current?.getAttribute("src") ?? null });
      onState({
        status: "error",
        innerWidth: null,
        message:
          "The canvas did not answer. It may have followed a link away from this page — " +
          "reload it, or check that you are still signed in.",
      });
    }, GIVE_UP_AFTER_MS);

    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("message", observe);
      if (ping !== undefined) window.clearInterval(ping);
      window.clearTimeout(giveUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridgeId, slug, loads]);

  /**
   * With diagnostics on, the frame — written down when it is created, by its
   * address alone, and once a document has loaded in it sampled once a second
   * until that document answers: which address it holds, how far it has
   * loaded, whether the server wrote it as a canvas. Never read before the
   * first load: reaching into the frame's initial empty document is the one
   * thing that would change what it observes (see the pings above). Nothing
   * here runs with diagnostics off.
   */
  useEffect(() => {
    if (!bridgeId || !(timeline.current ??= openTimeline(EDITOR_TIMELINE, diagnostics)).enabled) return;
    if (loads === 0) {
      mark("canvas.frame", { src: frameRef.current?.getAttribute("src") ?? null });
      return;
    }
    let last = "";
    const started = Date.now();
    const sample = () => {
      if (answered.current || Date.now() - started > 180_000) {
        window.clearInterval(timer);
        return;
      }
      const snapshot = frameSnapshot(frameRef.current);
      const key = JSON.stringify(snapshot);
      if (key === last) return;
      last = key;
      mark("canvas.frameState", snapshot);
    };
    const timer = window.setInterval(sample, 1_000);
    sample();
    return () => window.clearInterval(timer);
    // `diagnostics` is fixed for the life of the editor; `mark` reads a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridgeId, loads]);

  // Selecting from the Layers panel: one message out, and the answer comes back
  // through `canvas.selection` like any other selection — so a layer click and
  // a canvas click end in exactly the same place.
  useEffect(() => {
    if (!bridgeId || !selectRequest) return;
    const origin = bridgeOrigin();
    const message =
      selectRequest.address === null
        ? { type: "editor.clearSelection" as const }
        : {
            type: "editor.select" as const,
            address: selectRequest.address,
            scrollIntoView: selectRequest.scrollIntoView,
          };
    frameRef.current?.contentWindow?.postMessage(envelope(bridgeId, message), origin);
  }, [bridgeId, selectRequest]);

  /**
   * The locks, re-sent whenever they change *and* whenever a new document
   * says it is listening.
   *
   * A canvas that reloaded — a language switch, a device switch, a publish —
   * is a fresh document that has never heard of them, and without this it
   * would happily let the pointer select something the editor had locked a
   * moment earlier. They follow the document's announcement, not the frame's
   * `load`: the bridge starts listening when the page hydrates, which can be
   * after `load`, and a message posted before then is simply lost — a locked
   * node then selectable on the new canvas, as the 19B probe caught after a
   * language switch.
   */
  const lockKey = locks.join("|");
  useEffect(() => {
    if (!bridgeId || announced === 0) return;
    frameRef.current?.contentWindow?.postMessage(
      envelope(bridgeId, { type: "editor.locks" as const, addresses: lockKey ? lockKey.split("|") : [] }),
      bridgeOrigin(),
    );
  }, [bridgeId, announced, lockKey]);

  useEffect(() => {
    if (!bridgeId || !editRequest) return;
    const message =
      editRequest.kind === "begin"
        ? {
            type: "editor.editBegin" as const,
            address: editRequest.address,
            token: editRequest.token,
            text: editRequest.text,
          }
        : { type: "editor.editCancel" as const, token: editRequest.token };
    frameRef.current?.contentWindow?.postMessage(envelope(bridgeId, message), bridgeOrigin());
  }, [bridgeId, editRequest]);

  useEffect(() => {
    if (!bridgeId || !replayRequest) return;
    const message =
      replayRequest.kind === "play"
        ? {
            type: "editor.motionReplay" as const,
            address: replayRequest.address,
            token: replayRequest.token,
            mode: replayRequest.mode,
          }
        : { type: "editor.motionReplayCancel" as const, token: replayRequest.token };
    frameRef.current?.contentWindow?.postMessage(envelope(bridgeId, message), bridgeOrigin());
  }, [bridgeId, replayRequest]);

  const logical = deviceWidth(device);
  // Never scaled up: a 390px page blown up to fill a 1200px stage would be a
  // picture of a phone, not a phone.
  const scale = stage.width > 0 ? Math.min(1, stage.width / logical) : 1;
  const src = bridgeId
    ? publicPath
      ? previewRoutePath(publicPath, locale, { nonce: canvasKey, editor: { bridgeId } })
      : previewPagePath(slug, locale, { nonce: canvasKey, editor: { bridgeId } })
    : undefined;
  // The overlays share this box with the frame, so their offset within it is
  // zero — passed explicitly rather than assumed, because a ruler or a toolbar
  // between them would make it something else and a hidden zero would be wrong
  // silently.
  const view = { scale, offsetX: 0, offsetY: 0 };
  const viewport = { width: logical * scale, height: stage.height };

  return (
    <div ref={stageRef} className="relative h-full w-full overflow-hidden">
      {src ? (
        // `overflow-clip`, not `overflow-hidden` (Batch 19A). The frame's own
        // layout box is the unscaled page — 1440 px wide for Desktop — so this
        // box has overflow, and with `hidden` it is a scroll container that
        // only script can scroll. A `scrollIntoView` inside the canvas — the
        // bridge bringing a Layers selection into view — carried on into this
        // document and scrolled it: the page slid up inside its frame, its top
        // edge cut off and an empty band left at the bottom. `clip` clips
        // exactly the same and cannot be scrolled at all, so the page scrolls
        // inside the canvas and the frame stays where it is.
        <div
          className="relative mx-auto overflow-clip rounded-[var(--radius-sm)] border border-[var(--admin-line-strong)] bg-[var(--color-ink-900)] shadow-[0_24px_70px_-30px_rgb(0_0_0/0.9)] transition-[width] duration-200"
          style={{ width: `${Math.round(logical * scale)}px`, height: `${stage.height}px` }}
        >
          <iframe
            ref={frameRef}
            key={`${canvasKey}-${bridgeId}`}
            src={src}
            title={`${title} — ${locale === "ar" ? "Arabic" : "English"} canvas`}
            className="border-0 bg-[var(--color-ink-900)]"
            style={{
              width: `${logical}px`,
              height: stage.height > 0 ? `${Math.round(stage.height / scale)}px` : "100%",
              transform: `scale(${scale})`,
              transformOrigin: "top left",
            }}
            onLoad={() => {
              // A document arrived. Which one, only the handshake can say — so
              // this moves the status forward but never to Ready.
              //
              // Unless it is the document that has already answered: the
              // handshake no longer waits for `load`, so a canvas can be Ready
              // before its last picture is, and its load event is then news
              // about a document the editor already has — not a reason to drop
              // the selection or show "Connecting…" under an editor at work.
              if (readyDocument.current && frameRef.current?.contentDocument === readyDocument.current) {
                mark("canvas.load", { loads, alreadyReady: true, ...frameSnapshot(frameRef.current) });
                return;
              }
              mark("canvas.load", { loads: loads + 1, ...frameSnapshot(frameRef.current) });
              answered.current = false;
              readyDocument.current = null;
              setLoads((n) => n + 1);
              setHover(null);
              setSelection(null);
              onSelection(null);
              onState({ status: "connecting", innerWidth: null, message: null });
            }}
          />

          {hover && (!selection || selection.node.address !== hover.node.address) ? (
            <Outline rect={toOverlayRect(hover.rect, view)} viewport={viewport} tone="hover" />
          ) : null}
          {selection?.rect ? (
            <Outline
              rect={toOverlayRect(selection.rect, view)}
              viewport={viewport}
              tone="selected"
              label={describeAddress(selection.node.blockType, selection.node.relativePath, selection.node.text).label}
            />
          ) : null}
        </div>
      ) : (
        <div className="flex h-full items-center justify-center text-[0.82rem] text-muted">
          Preparing the canvas…
        </div>
      )}
    </div>
  );
}

/**
 * One outline. `pointer-events: none` throughout — the overlay must never be
 * the thing the pointer is over, or hovering a node would immediately stop
 * hovering it.
 */
function Outline({
  rect,
  viewport,
  tone,
  label,
}: {
  rect: Rect;
  viewport: { width: number; height: number };
  tone: "hover" | "selected";
  label?: string;
}) {
  if (!intersectsViewport(rect, viewport)) return null;
  const selected = tone === "selected";
  // The label sits below the box when the box is against the top of the stage,
  // so it is never clipped out of sight.
  const below = rect.y < 20;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute z-10"
      style={{
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
        outline: selected
          ? "2px solid var(--color-orange)"
          : "1px dashed color-mix(in oklab, var(--color-peach) 70%, transparent)",
        outlineOffset: selected ? "1px" : "0px",
        background: selected ? "color-mix(in oklab, var(--color-orange) 7%, transparent)" : "transparent",
        borderRadius: "2px",
      }}
    >
      {selected && label ? (
        <span
          className="absolute max-w-[18rem] truncate rounded-[3px] px-1.5 py-0.5 text-[0.66rem] font-semibold"
          style={{
            [below ? "top" : "bottom"]: "calc(100% + 3px)",
            insetInlineStart: 0,
            background: "var(--color-orange)",
            color: "var(--color-on-accent)",
          }}
        >
          {label}
        </span>
      ) : null}
    </div>
  );
}
