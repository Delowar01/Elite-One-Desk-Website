"use client";

import { useEffect } from "react";

import { decomposeAddress } from "@/lib/cms/address";
import type { Locale } from "@/lib/i18n/config";
import {
  bridgeOrigin,
  envelope,
  readEditorMessage,
  type CanvasMessage,
  type EditorNodeMeta,
  type EditorSectionMeta,
} from "@/lib/visual-editor/protocol";
import { isUsableRect, type Rect } from "@/lib/visual-editor/overlay";
import type { EditorNodeKind } from "@/lib/visual-editor/render";

/**
 * The canvas half of the Visual Editor.
 *
 * It renders nothing and it is rendered by nothing except an authorised editor
 * preview — `resolvePageForRender` decides, on the server, whether this
 * component appears in the tree at all. A normal visitor therefore does not
 * merely fail to connect: this file is never in their payload, no listener is
 * attached, and the public page's Core Web Vitals pay nothing for an editor
 * they will never open.
 *
 * What it does, and the shape of how:
 *
 *   **It reads the page rather than describing it.** Every selectable thing
 *   carries `data-eod-address`, put there by the real renderer. Finding what
 *   the pointer is over is one `closest()`; there is no map of the page held
 *   anywhere, so nothing can go stale when the page re-renders.
 *
 *   **Three listeners, not three hundred.** Pointer and click are delegated on
 *   the document. A page with two hundred selectable nodes attaches the same
 *   number of listeners as a page with two.
 *
 *   **It reports; it never changes.** Nothing here writes to the DOM, and the
 *   only thing it prevents is a click on a selectable node turning into a
 *   navigation the editor did not ask for.
 */

const SELECTABLE = "[data-eod-node]";
const SECTION = '[data-eod-kind="section"]';
const MAX_TEXT = 120;

const rectOf = (element: Element): Rect | null => {
  const box = element.getBoundingClientRect();
  const rect = { x: box.x, y: box.y, width: box.width, height: box.height };
  return isUsableRect(rect) ? rect : null;
};

const sameRect = (a: Rect | null, b: Rect | null): boolean => {
  if (!a || !b) return a === b;
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
};

/** A short, plain-text excerpt — never markup, and never written back. */
const excerpt = (element: Element): string | undefined => {
  const text = (element.textContent ?? "").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, MAX_TEXT) : undefined;
};

/**
 * The metadata for one annotated element.
 *
 * The section id and block type come from the owning section root rather than
 * from every node, so a field cannot claim to belong to a section it is not
 * inside — its owner is whichever section root actually contains it.
 */
function describe(element: Element): EditorNodeMeta | null {
  const address = element.getAttribute("data-eod-address");
  const kind = element.getAttribute("data-eod-kind") as EditorNodeKind | null;
  if (!address || !kind) return null;

  const parts = decomposeAddress(address);
  if (!parts) return null;

  const root = element.closest(SECTION);
  const blockType = root?.getAttribute("data-eod-block");
  if (!root || !blockType) return null;
  if (Number(root.getAttribute("data-eod-section")) !== parts.sectionId) return null;

  return {
    address,
    kind,
    sectionId: parts.sectionId,
    blockType,
    relativePath: parts.relative,
    text: excerpt(element),
  };
}

/** Every section the page actually rendered, in the order it rendered them. */
function readStructure(): EditorSectionMeta[] {
  const out: EditorSectionMeta[] = [];
  document.querySelectorAll(SECTION).forEach((root, position) => {
    const address = root.getAttribute("data-eod-address");
    const sectionId = Number(root.getAttribute("data-eod-section"));
    const blockType = root.getAttribute("data-eod-block");
    if (!address || !blockType || !Number.isInteger(sectionId) || sectionId <= 0) return;
    out.push({
      address,
      sectionId,
      blockType,
      position,
      isDraft: root.getAttribute("data-eod-draft") === "true",
      isDraftOnly: root.getAttribute("data-eod-draft-only") === "true",
      visible: root.getAttribute("data-eod-visible") !== "false",
    });
  });
  return out;
}

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

    /* ---------------------------------------------------------------- */
    /* State: the two elements we are tracking, and nothing else.        */
    /* ---------------------------------------------------------------- */

    let hovered: Element | null = null;
    let selected: Element | null = null;
    let selectedRect: Rect | null = null;
    let boundsFrame = 0;

    const announce = () => {
      post({
        type: "canvas.ready",
        pageId,
        slug,
        locale,
        // Measured, not assumed. This is what proves the frame really has the
        // logical width the editor's device switch claims it has.
        innerWidth: window.innerWidth,
      });
      post({ type: "canvas.structure", sections: readStructure() });
    };

    const sendHover = (element: Element | null) => {
      if (element === hovered) return;
      hovered = element;
      if (!element) return post({ type: "canvas.hover", node: null, rect: null });
      const node = describe(element);
      const rect = rectOf(element);
      post(node && rect ? { type: "canvas.hover", node, rect } : { type: "canvas.hover", node: null, rect: null });
    };

    const sendSelection = (element: Element | null) => {
      selected = element;
      selectedRect = element ? rectOf(element) : null;
      if (!element) return post({ type: "canvas.selection", node: null, rect: null });
      const node = describe(element);
      if (!node || !selectedRect) {
        selected = null;
        selectedRect = null;
        return post({ type: "canvas.selection", node: null, rect: null });
      }
      post({ type: "canvas.selection", node, rect: selectedRect });
    };

    /**
     * The selected element has probably moved. Coalesced to one frame, because
     * this is driven by scrolling and a message per scroll event would be a
     * message per pixel.
     */
    const syncBounds = () => {
      if (boundsFrame) return;
      boundsFrame = window.requestAnimationFrame(() => {
        boundsFrame = 0;
        if (!selected) return;
        // Gone from the document — an element that unmounted while selected.
        if (!selected.isConnected) {
          const address = selected.getAttribute("data-eod-address");
          selected = null;
          selectedRect = null;
          if (address) post({ type: "canvas.bounds", address, rect: null });
          return;
        }
        const rect = rectOf(selected);
        if (sameRect(rect, selectedRect)) return;
        selectedRect = rect;
        const address = selected.getAttribute("data-eod-address");
        if (!address) return;
        post(rect ? { type: "canvas.bounds", address, rect } : { type: "canvas.bounds", address, rect: null });
      });
    };

    /* ---------------------------------------------------------------- */
    /* Listeners                                                         */
    /* ---------------------------------------------------------------- */

    const closestNode = (target: EventTarget | null): Element | null => {
      if (!(target instanceof Element)) return null;
      // The nearest one wins, which is what makes selection feel precise: the
      // card's title rather than the card, the card rather than the section.
      return target.closest(SELECTABLE);
    };

    const onPointerMove = (event: PointerEvent) => sendHover(closestNode(event.target));
    const onPointerLeave = () => sendHover(null);

    const onClick = (event: MouseEvent) => {
      // A modified click is the browser's, not ours: open-in-new-tab still
      // means open in a new tab, even in here.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const element = closestNode(event.target);
      if (!element) return;
      // Inside the canvas a click on something editable means "select this".
      // Following the link as well would take the editor off the page they are
      // editing, mid-edit, because they aimed at a heading.
      event.preventDefault();
      event.stopPropagation();
      sendSelection(element);
    };

    // Nothing in the canvas should ever be submitted: the enquiry form is part
    // of a section an editor may well click around in.
    const onSubmit = (event: Event) => event.preventDefault();

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin) return;
      if (event.source !== window.parent) return;
      const message = readEditorMessage(event.data, { bridgeId });
      if (!message) return;

      switch (message.type) {
        case "editor.ping": {
          post({ type: "canvas.pong", at: Date.now() });
          // Re-announced on every ping, so a first announcement that landed
          // before the editor was listening is recovered instead of leaving the
          // canvas stuck on "Connecting…".
          announce();
          return;
        }
        case "editor.select": {
          const element = document.querySelector(`[data-eod-address="${message.address}"]`);
          if (!element) {
            // The address is well formed but nothing on this page answers to
            // it — a layer from a document that has since been replaced.
            sendSelection(null);
            return;
          }
          if (message.scrollIntoView) {
            element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
          }
          sendSelection(element);
          return;
        }
        case "editor.clearSelection":
          sendHover(null);
          sendSelection(null);
          return;
      }
    };

    /**
     * Re-announced when the frame is resized, because the editor's device
     * switch changes the frame's width without reloading the document. Without
     * this the editor would keep quoting the width from the first
     * announcement — a number that was true once and is now simply wrong, which
     * is worse than no number at all. The selected element has almost certainly
     * moved too, so its bounds go with it.
     */
    let resizeFrame = 0;
    const onResize = () => {
      if (resizeFrame) return;
      resizeFrame = window.requestAnimationFrame(() => {
        resizeFrame = 0;
        announce();
        syncBounds();
      });
    };

    window.addEventListener("message", onMessage);
    window.addEventListener("resize", onResize);
    // Capture, so a scroll inside any container counts, not only the document's.
    window.addEventListener("scroll", syncBounds, { capture: true, passive: true });
    document.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("pointerleave", onPointerLeave);
    document.addEventListener("click", onClick, { capture: true });
    document.addEventListener("submit", onSubmit, { capture: true });

    announce();

    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", syncBounds, { capture: true });
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("click", onClick, { capture: true });
      document.removeEventListener("submit", onSubmit, { capture: true });
      if (boundsFrame) window.cancelAnimationFrame(boundsFrame);
      if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
    };
  }, [bridgeId, pageId, slug, locale]);

  return null;
}
