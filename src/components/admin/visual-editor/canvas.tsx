"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Locale } from "@/lib/i18n/config";
import { previewPagePath } from "@/lib/page-path";
import { describeAddress } from "@/lib/visual-editor/labels";
import { intersectsViewport, toOverlayRect, type Rect } from "@/lib/visual-editor/overlay";
import {
  bridgeOrigin,
  envelope,
  newBridgeId,
  readCanvasMessage,
  type EditorNodeMeta,
  type EditorSectionMeta,
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
export type EditRequest = { address: string; active: boolean; token: number } | null;

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
  slug,
  locale,
  device,
  canvasKey,
  title,
  selectRequest,
  editRequest,
  locks,
  onState,
  onStructure,
  onSelection,
  onEdit,
}: {
  slug: string;
  locale: Locale;
  device: DeviceKey;
  /** Changes whenever a genuinely new document is wanted: page, language, reload. */
  canvasKey: number;
  title: string;
  selectRequest: SelectRequest;
  editRequest: EditRequest;
  /** Addresses the canvas pointer must ignore. Editor-side state, never saved. */
  locks: string[];
  onState: (state: CanvasState) => void;
  onStructure: (sections: EditorSectionMeta[]) => void;
  onSelection: (node: EditorNodeMeta | null) => void;
  onEdit: (edit: { address: string; phase: "start" | "input" | "commit" | "cancel"; text: string }) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [bridgeId, setBridgeId] = useState<string | null>(null);
  const [loads, setLoads] = useState(0);
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
    setBridgeId(newBridgeId());
    setLoads(0);
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

  // The handshake, and everything the canvas says afterwards. Re-armed on every
  // document the frame loads.
  useEffect(() => {
    if (!bridgeId || loads === 0) return;
    const origin = bridgeOrigin();
    let settled = false;

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return;
      // The message has to come from the frame we are actually showing. A
      // stale iframe from a previous page or reload has a different window,
      // and its bridge id no longer matches either.
      if (!frameRef.current || event.source !== frameRef.current.contentWindow) return;

      const message = readCanvasMessage(event.data, { bridgeId, slug });
      if (!message) return;

      switch (message.type) {
        case "canvas.ready":
          settled = true;
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
          onEdit({ address: message.address, phase: message.phase, text: message.text });
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

    const ping = window.setInterval(() => {
      if (settled) return;
      frameRef.current?.contentWindow?.postMessage(
        envelope(bridgeId, { type: "editor.ping" as const, at: Date.now() }),
        origin,
      );
    }, PING_EVERY_MS);

    const giveUp = window.setTimeout(() => {
      if (settled) return;
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
      window.clearInterval(ping);
      window.clearTimeout(giveUp);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bridgeId, slug, loads]);

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
   * arrives.
   *
   * `loads` is in the dependencies on purpose: a canvas that reloaded — a
   * language switch, a device switch, a publish — is a fresh document that has
   * never heard of them, and without this it would happily let the pointer
   * select something the editor had locked a moment earlier.
   */
  const lockKey = locks.join("|");
  useEffect(() => {
    if (!bridgeId || loads === 0) return;
    frameRef.current?.contentWindow?.postMessage(
      envelope(bridgeId, { type: "editor.locks" as const, addresses: lockKey ? lockKey.split("|") : [] }),
      bridgeOrigin(),
    );
  }, [bridgeId, loads, lockKey]);

  useEffect(() => {
    if (!bridgeId || !editRequest) return;
    frameRef.current?.contentWindow?.postMessage(
      envelope(bridgeId, {
        type: "editor.edit" as const,
        address: editRequest.address,
        active: editRequest.active,
      }),
      bridgeOrigin(),
    );
  }, [bridgeId, editRequest]);

  const logical = deviceWidth(device);
  // Never scaled up: a 390px page blown up to fill a 1200px stage would be a
  // picture of a phone, not a phone.
  const scale = stage.width > 0 ? Math.min(1, stage.width / logical) : 1;
  const src = bridgeId ? previewPagePath(slug, locale, { nonce: canvasKey, editor: { bridgeId } }) : undefined;
  // The overlays share this box with the frame, so their offset within it is
  // zero — passed explicitly rather than assumed, because a ruler or a toolbar
  // between them would make it something else and a hidden zero would be wrong
  // silently.
  const view = { scale, offsetX: 0, offsetY: 0 };
  const viewport = { width: logical * scale, height: stage.height };

  return (
    <div ref={stageRef} className="relative h-full w-full overflow-hidden">
      {src ? (
        <div
          className="relative mx-auto overflow-hidden rounded-[var(--radius-sm)] border border-[var(--admin-line-strong)] bg-[var(--color-ink-900)] shadow-[0_24px_70px_-30px_rgb(0_0_0/0.9)] transition-[width] duration-200"
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
