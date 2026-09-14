"use client";

import { useEffect } from "react";

import type { Locale } from "@/lib/i18n/config";
import {
  bridgeOrigin,
  envelope,
  readEditorMessage,
  type CanvasMessage,
} from "@/lib/visual-editor/protocol";

/**
 * The canvas half of the Visual Editor handshake.
 *
 * It renders nothing and it is rendered by nothing except an authorised editor
 * preview — `resolvePageForRender` decides, on the server, whether this
 * component appears in the tree at all. A normal visitor therefore does not
 * merely fail to connect: this file is never in their payload, no listener is
 * attached, and the public page's Core Web Vitals pay nothing for an editor
 * they will never open.
 *
 * Batch 3 is a page-level handshake and no more. There is no selection, no
 * hover, no mutation observer, no click interception and no DOM marking here —
 * those belong to the batch that owns selection, and adding them early would
 * mean the public page carrying editor machinery before anything can use it.
 */
export function EditorBridge({
  bridgeId,
  pageId,
  slug,
  locale,
}: {
  bridgeId: string;
  pageId: number;
  slug: string;
  locale: Locale;
}) {
  useEffect(() => {
    // Not in a frame: there is no editor to talk to, and posting to ourselves
    // would be answering a question nobody asked.
    if (window.parent === window) return;

    const origin = bridgeOrigin();
    const post = (message: CanvasMessage) =>
      window.parent.postMessage(envelope(bridgeId, message), origin);

    const announce = () =>
      post({
        type: "canvas.ready",
        pageId,
        slug,
        locale,
        // Measured, not assumed. This is what proves the frame really has the
        // logical width the editor's device switch claims it has.
        innerWidth: window.innerWidth,
      });

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return;
      if (event.source !== window.parent) return;
      const message = readEditorMessage(event.data, { bridgeId });
      if (!message) return;
      post({ type: "canvas.pong", at: Date.now() });
      // Re-announced on every ping, so a first announcement that landed before
      // the editor was listening is recovered instead of leaving the canvas
      // stuck on "Connecting…".
      announce();
    };

    /**
     * Re-announced when the frame is resized, because the editor's device
     * switch changes the frame's width without reloading the document. Without
     * this the editor would keep quoting the width from the first
     * announcement — a number that was true once and is now simply wrong, which
     * is worse than no number at all. Coalesced to one post per frame, so
     * dragging the admin window does not turn into a message storm.
     */
    let queued = 0;
    const onResize = () => {
      if (queued) return;
      queued = window.requestAnimationFrame(() => {
        queued = 0;
        announce();
      });
    };

    window.addEventListener("message", onMessage);
    window.addEventListener("resize", onResize);
    announce();
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("resize", onResize);
      if (queued) window.cancelAnimationFrame(queued);
    };
  }, [bridgeId, pageId, slug, locale]);

  return null;
}
