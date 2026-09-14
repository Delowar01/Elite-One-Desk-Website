"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";

import type { Locale } from "@/lib/i18n/config";
import { previewPagePath } from "@/lib/page-path";
import {
  bridgeOrigin,
  envelope,
  newBridgeId,
  readCanvasMessage,
} from "@/lib/visual-editor/protocol";
import { deviceWidth, type DeviceKey } from "@/lib/visual-editor/viewport";

export type CanvasStatus = "loading" | "connecting" | "ready" | "error";

export type CanvasState = {
  status: CanvasStatus;
  /** `window.innerWidth` as the canvas document itself reported it. */
  innerWidth: number | null;
  message: string | null;
};

const PING_EVERY_MS = 500;
const GIVE_UP_AFTER_MS = 20_000;

/**
 * The real website, in a frame, at a real device width.
 *
 * Two things this component is careful about.
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
 */
export function VisualCanvas({
  slug,
  locale,
  device,
  nonce,
  title,
  onState,
}: {
  slug: string;
  locale: Locale;
  device: DeviceKey;
  nonce: number;
  title: string;
  onState: (state: CanvasState) => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [bridgeId, setBridgeId] = useState<string | null>(null);
  /**
   * Every document the frame loads, counted.
   *
   * The frame can load more than once without the editor asking: a link inside
   * the website is an ordinary link and clicking it navigates the canvas. The
   * counter re-arms the handshake on each load, so a canvas that has wandered
   * off the selected page stops claiming to be Ready and says so instead.
   */
  const [loads, setLoads] = useState(0);
  const [stage, setStage] = useState({ width: 0, height: 0 });

  // Generated after mount, never during render: the shell is server-rendered
  // too, and a value drawn from the random generator on both sides would be two
  // different values and a hydration mismatch.
  useEffect(() => setBridgeId(newBridgeId()), []);

  // The shell owns the status; the canvas only reports what it observes. One
  // copy of that state, so the toolbar and the frame cannot disagree.
  const report = onState;

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

  // The handshake. Listener first, then pings until the canvas answers. Re-armed
  // on every document the frame loads.
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

      if (message.type === "canvas.ready") {
        settled = true;
        report({ status: "ready", innerWidth: message.innerWidth, message: null });
        return;
      }
      if (message.type === "canvas.error") {
        report({ status: "error", innerWidth: null, message: message.message });
        return;
      }
      // A pong before the announcement: the channel is alive, so keep waiting
      // rather than counting down to a failure that is not happening.
      if (!settled) report({ status: "connecting", innerWidth: null, message: null });
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
      report({
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
  }, [bridgeId, slug, loads, report]);

  const logical = deviceWidth(device);
  // Never scaled up: a 390px page blown up to fill a 1200px stage would be a
  // picture of a phone, not a phone.
  const scale = stage.width > 0 ? Math.min(1, stage.width / logical) : 1;
  const src = bridgeId
    ? previewPagePath(slug, locale, { nonce, editor: { bridgeId } })
    : undefined;

  return (
    <div ref={stageRef} className="relative h-full w-full overflow-hidden">
      {src ? (
        <div
          className="mx-auto overflow-hidden rounded-[var(--radius-sm)] border border-[var(--admin-line-strong)] bg-[var(--color-ink-900)] shadow-[0_24px_70px_-30px_rgb(0_0_0/0.9)] transition-[width] duration-200"
          style={{ width: `${Math.round(logical * scale)}px`, height: `${stage.height}px` }}
        >
          <iframe
            ref={frameRef}
            key={`${slug}-${locale}-${nonce}-${bridgeId}`}
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
              report({ status: "connecting", innerWidth: null, message: null });
            }}
          />
        </div>
      ) : (
        <div className="flex h-full items-center justify-center text-[0.82rem] text-muted">
          Preparing the canvas…
        </div>
      )}
    </div>
  );
}
