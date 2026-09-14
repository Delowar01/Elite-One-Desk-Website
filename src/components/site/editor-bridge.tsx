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

    /**
     * What is being tracked, and where it was last seen.
     *
     * The rectangle is remembered alongside the element so a re-measurement can
     * be compared against it — that is what makes this quiet. Without it, every
     * scrolled pixel would be a message; with it, a message is sent only when
     * the box has actually moved.
     */
    type Tracked = { element: Element; address: string; rect: Rect | null };

    let hover: Tracked | null = null;
    let selection: Tracked | null = null;

    /**
     * Watches the boxes of whatever is tracked, and nothing else.
     *
     * This is what notices an element that has stopped — or started — being
     * measurable without anybody scrolling: hidden by a class, collapsed
     * inside a container, revealed when its parent opens. A `display: none`
     * reports zero and the outline goes; the box coming back reports a size
     * again and the outline returns. Position is somebody else's job — scroll,
     * resize and the settle loop cover that.
     */
    const boxes = new ResizeObserver(() => schedule());

    const watch = (element: Element | null, previous: Element | null) => {
      if (previous && previous !== element) boxes.unobserve(previous);
      if (element && element !== previous) boxes.observe(element);
    };

    const track = (element: Element): Tracked | null => {
      const address = element.getAttribute("data-eod-address");
      return address ? { element, address, rect: rectOf(element) } : null;
    };

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

    const clearHover = () => {
      if (!hover) return;
      watch(null, hover.element);
      hover = null;
      post({ type: "canvas.hover", node: null, rect: null });
    };

    const setHover = (element: Element | null) => {
      if (element === hover?.element) return;
      if (!element) return clearHover();

      const next = track(element);
      const node = next ? describe(element) : null;
      const previous = hover?.element ?? null;
      if (!next || !node || !next.rect) {
        watch(null, previous);
        hover = null;
        return post({ type: "canvas.hover", node: null, rect: null });
      }
      watch(element, previous);
      hover = next;
      post({ type: "canvas.hover", node, rect: next.rect });
      stabilise();
    };

    const clearSelection = () => {
      watch(null, selection?.element ?? null);
      selection = null;
      post({ type: "canvas.selection", node: null, rect: null });
    };

    const setSelection = (element: Element | null) => {
      if (!element) return clearSelection();

      const next = track(element);
      const node = next ? describe(element) : null;
      if (!next || !node || !next.rect) return clearSelection();

      watch(element, selection?.element ?? null);
      selection = next;
      post({ type: "canvas.selection", node, rect: next.rect });
      stabilise();
    };

    /**
     * Re-measures what is being tracked. Returns whether anything moved.
     *
     * The distinction this function exists to keep, and the reason it is not
     * one branch:
     *
     *   **Disconnected** — the element is no longer in the document. It is not
     *   selected any more, because it is not anything any more, and the editor
     *   is told so with a proper `canvas.selection null`. Sending only a null
     *   rectangle here was the defect: the outline vanished while the inspector
     *   went on describing a node that had ceased to exist, and the Layers row
     *   stayed lit.
     *
     *   **Connected but unmeasurable** — still in the document, momentarily
     *   measuring nothing: mid-transition, inside a collapsed container, a
     *   reveal that has not run. That is a drawing problem, not a selection
     *   one. The overlay goes away for those frames; the selection does not,
     *   and the outline comes back when the element does.
     */
    const measure = (): boolean => {
      let moved = false;

      if (hover) {
        if (!hover.element.isConnected) {
          clearHover();
          moved = true;
        } else {
          const rect = rectOf(hover.element);
          if (!sameRect(rect, hover.rect)) {
            moved = true;
            hover.rect = rect;
            const node = describe(hover.element);
            // The protocol says a hover is a node and a rectangle or neither,
            // so a hovered element that has stopped being measurable is simply
            // not hovered. There is nothing to draw and nothing to describe.
            if (node && rect) post({ type: "canvas.hover", node, rect });
            else clearHover();
          }
        }
      }

      if (selection) {
        if (!selection.element.isConnected) {
          clearSelection();
          return true;
        }
        const rect = rectOf(selection.element);
        if (!sameRect(rect, selection.rect)) {
          moved = true;
          selection.rect = rect;
          post(
            rect
              ? { type: "canvas.bounds", address: selection.address, rect }
              : { type: "canvas.bounds", address: selection.address, rect: null },
          );
        }
      }

      return moved;
    };

    /* ---------------------------------------------------------------- */
    /* Keeping up with things that move                                  */
    /* ---------------------------------------------------------------- */

    /** Consecutive frames without movement before the settle loop stops. */
    const STABLE_FRAMES = 3;
    /** However lively the page is, the loop is over by then. */
    const SETTLE_MS = 900;

    let frame = 0;
    let settleUntil = 0;
    let stableFrames = 0;

    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(tick);
    };

    function tick() {
      frame = 0;
      const moved = measure();
      if (!hover && !selection) return;
      if (Date.now() >= settleUntil) return;
      stableFrames = moved ? 0 : stableFrames + 1;
      if (stableFrames < STABLE_FRAMES) schedule();
    }

    /**
     * Watch for a few frames, because the thing just selected may still be
     * moving.
     *
     * A CSS transform or one of the site's own reveal transitions moves an
     * element without firing scroll or resize, so an outline drawn once at the
     * moment of the click ends up beside the element rather than on it. This
     * follows it until it has held still for three frames, and gives up after
     * `SETTLE_MS` whatever happens — there is no permanent animation loop here,
     * and nothing runs at all while nothing is tracked.
     */
    function stabilise() {
      settleUntil = Date.now() + SETTLE_MS;
      stableFrames = 0;
      schedule();
    }

    /**
     * The one observer, and it is deliberately almost nothing.
     *
     * A selected element can be removed without a scroll, a resize or a pointer
     * move — and then nothing would ever notice, because every other signal
     * here is driven by something the visitor did. `childList` on the subtree is
     * the narrowest question that answers "did anything appear or disappear",
     * the callback does no work beyond asking for a frame, and it only runs at
     * all while something is being tracked. It is not a page scanner and it
     * exists only inside an authorised canvas.
     */
    const observer = new MutationObserver(() => {
      if (hover || selection) schedule();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    /**
     * A transform moves an element without firing scroll, resize or a mutation,
     * and without changing its size — so none of the signals above see it. The
     * browser does announce the transition itself, though, and these events
     * bubble, so one listener covers the page.
     *
     * Cheaper than watching for movement: the handler re-arms the settle loop
     * and returns, and the loop stops three still frames later. When nothing is
     * tracked it does not even do that.
     */
    const onMotion = () => {
      if (hover || selection) stabilise();
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

    const onPointerMove = (event: PointerEvent) => setHover(closestNode(event.target));
    const onPointerLeave = () => setHover(null);

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
      setSelection(element);
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
            setSelection(null);
            return;
          }
          if (message.scrollIntoView) {
            element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
          }
          setSelection(element);
          // A smooth scroll is still travelling when this returns, so the
          // rectangle measured a moment ago is already out of date. The settle
          // loop follows it the rest of the way.
          stabilise();
          return;
        }
        case "editor.clearSelection":
          setHover(null);
          setSelection(null);
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
        // A width change re-lays out the page, and the reflow is not
        // instantaneous, so this follows the element rather than measuring it
        // once and hoping.
        stabilise();
      });
    };

    window.addEventListener("message", onMessage);
    window.addEventListener("resize", onResize);
    for (const type of ["transitionrun", "transitionend", "animationstart", "animationend"]) {
      document.addEventListener(type, onMotion, { capture: true, passive: true });
    }
    // Capture, so a scroll inside any container counts, not only the
    // document's. One frame per batch of events, not one message per pixel.
    window.addEventListener("scroll", schedule, { capture: true, passive: true });
    document.addEventListener("pointermove", onPointerMove, { passive: true });
    document.addEventListener("pointerleave", onPointerLeave);
    document.addEventListener("click", onClick, { capture: true });
    document.addEventListener("submit", onSubmit, { capture: true });

    announce();

    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", schedule, { capture: true });
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("click", onClick, { capture: true });
      document.removeEventListener("submit", onSubmit, { capture: true });
      for (const type of ["transitionrun", "transitionend", "animationstart", "animationend"]) {
        document.removeEventListener(type, onMotion, { capture: true });
      }
      observer.disconnect();
      boxes.disconnect();
      if (frame) window.cancelAnimationFrame(frame);
      if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
    };
  }, [bridgeId, pageId, slug, locale]);

  return null;
}
