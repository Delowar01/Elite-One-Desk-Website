"use client";

import { useEffect } from "react";

import { decomposeAddress } from "@/lib/cms/address";
import { isDescendantAddress } from "@/lib/visual-editor/tree";
import type { Locale } from "@/lib/i18n/config";
import {
  bridgeOrigin,
  envelope,
  readEditorMessage,
  type CanvasMessage,
  type EditorNodeMeta,
  type EditorSectionMeta,
  type EditorTreeNode,
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

/**
 * Every annotated node inside one section root, in document order.
 *
 * Read off the page rather than described from anywhere else, which is the
 * same rule the rest of this file follows: if it is not annotated it cannot be
 * pointed at, so it is not in the tree either. A field the page did not draw —
 * an empty media slot, a CTA that is switched off — simply has no element, and
 * the panel is therefore a view of what is really there.
 */
function readNodes(root: Element): EditorTreeNode[] {
  const out: EditorTreeNode[] = [];
  root.querySelectorAll(SELECTABLE).forEach((element) => {
    const address = element.getAttribute("data-eod-address");
    const kind = element.getAttribute("data-eod-kind") as EditorNodeKind | null;
    if (!address || !kind || kind === "section") return;
    // A node inside a *nested* section root belongs to that one, not to this.
    if (element.closest(SECTION) !== root) return;
    const parts = decomposeAddress(address);
    if (!parts || parts.relative === "root") return;

    const node: EditorTreeNode = { address, kind, relativePath: parts.relative };
    const text = excerpt(element);
    if (text) node.text = text;
    const edit = element.getAttribute("data-eod-edit");
    if (edit === "text" || edit === "multiline") node.edit = edit;
    out.push(node);
  });
  return out;
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
      nodes: readNodes(root),
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
     * Addresses the pointer must ignore, and the node being typed into.
     *
     * Locking is an editing convenience, not a permission: it exists so that a
     * background image or a settled section stops swallowing clicks aimed at
     * something in front of it. It lives here, for the life of this document,
     * and goes nowhere near a save — the server neither knows nor cares, and
     * every write is checked exactly as it was before.
     *
     * Locking a node locks what is inside it. That is the rule, chosen because
     * it is the one an editor predicts: locking a section means "leave this
     * section alone", and having its heading stay clickable would make the
     * lock look broken. Layers is unaffected either way — a locked node is
     * still selectable there, which is what keeps it recoverable.
     */
    let locked: string[] = [];
    const isLocked = (address: string): boolean =>
      locked.some((entry) => entry === address || isDescendantAddress(entry, address));

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

    /**
     * Notices a tracked element being taken out of the document with no other
     * signal at all — no scroll, no resize, no pointer move. `childList` on the
     * subtree is the narrowest question that answers "did anything appear or
     * disappear", and the callback does no work beyond asking for a frame.
     *
     * Connected only while something is tracked. The callback would have done
     * nothing anyway with nothing selected, but the browser still has to
     * deliver every qualifying mutation to an attached observer, and a page
     * nobody is pointing at should not be paying for that.
     */
    const tree = new MutationObserver(() => schedule());
    let watchingTree = false;

    /** Every element the box observer is currently watching. */
    const observed = new Set<Element>();

    /**
     * Reconciles both observers with what is actually tracked.
     *
     * The invariant: the box observer watches exactly
     * `union(hover.element, selection.element)` — and it has to be computed as
     * a union rather than maintained by each owner, because `unobserve` is not
     * reference counted. Hovering a card and then clicking it makes both owners
     * point at one element; when the pointer leaves, an owner-by-owner cleanup
     * calls `unobserve` on an element the *selection* still needs, and the
     * outline silently stops noticing that element being hidden or shown. The
     * mirror image happens when the selection moves on while the pointer is
     * still resting on the old node.
     *
     * So neither owner touches an observer directly. They change what is
     * tracked and call this, which is the only code that observes anything.
     */
    const syncObservers = () => {
      const wanted = new Set<Element>();
      if (hover) wanted.add(hover.element);
      if (selection) wanted.add(selection.element);

      for (const element of observed) {
        if (wanted.has(element)) continue;
        boxes.unobserve(element);
        observed.delete(element);
      }
      for (const element of wanted) {
        if (observed.has(element)) continue;
        boxes.observe(element);
        observed.add(element);
      }

      if (wanted.size && !watchingTree) {
        tree.observe(document.body, { childList: true, subtree: true });
        watchingTree = true;
      } else if (!wanted.size && watchingTree) {
        tree.disconnect();
        watchingTree = false;
      }
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
      hover = null;
      syncObservers();
      post({ type: "canvas.hover", node: null, rect: null });
    };

    const setHover = (element: Element | null) => {
      if (element === hover?.element) return;
      if (!element) return clearHover();

      const next = track(element);
      const node = next ? describe(element) : null;
      if (!next || !node || !next.rect) {
        hover = null;
        syncObservers();
        return post({ type: "canvas.hover", node: null, rect: null });
      }
      hover = next;
      syncObservers();
      post({ type: "canvas.hover", node, rect: next.rect });
      stabilise();
    };

    const clearSelection = () => {
      selection = null;
      syncObservers();
      post({ type: "canvas.selection", node: null, rect: null });
    };

    const setSelection = (element: Element | null) => {
      if (!element) return clearSelection();

      const next = track(element);
      const node = next ? describe(element) : null;
      // Connected but unmeasurable is a selection, not a non-selection. An
      // element hidden at the width being previewed measures 0×0, and refusing
      // to select it would mean the only way to un-hide something was to stop
      // hiding it first. The overlay simply has nothing to draw until it does.
      if (!next || !node) return clearSelection();

      selection = next;
      syncObservers();
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

    /**
     * Which editable thing is under the pointer.
     *
     * The nearest annotated ancestor wins, which is what makes selection feel
     * precise: the card's title rather than the card, the card rather than the
     * section. That is the whole rule for markup where what you see is what you
     * hit.
     *
     * It is not the whole rule for a card built in layers. A Quick Links card
     * paints its picture in an absolutely positioned frame and then lays the
     * text over the top of it in a sibling that fills the card — so a click
     * anywhere on the picture lands on the text layer, which carries no address
     * of its own, and walking up from it finds the *item*. The picture was
     * therefore selectable from the Layers tree and unreachable by pointing at
     * it, which is the one gesture an editor actually uses.
     *
     * So when walking up lands on something that contains other editable
     * things, the elements genuinely occupying that point are consulted and the
     * most precise one that belongs to it is preferred. Two rules keep this
     * from becoming clever:
     *
     *   - a foreground hit always wins. Pointing at the title selects the
     *     title, because the walk up from it already ends at the title and the
     *     search stops the moment it reaches what was clicked.
     *   - only a descendant of what was found is eligible. Nothing behind or
     *     beside it can be selected by pointing somewhere it does not cover.
     *
     * Blocks whose markup does not stack — which is nearly all of them — never
     * reach the second half: the first `closest()` already returns something
     * with no editable descendants, and the extra work is one scoped query.
     */
    /**
     * The nearest ancestor the pointer is allowed to have, or nothing.
     *
     * A locked node does not become transparent — what is *behind* it was not
     * what the editor pointed at either. The pointer walks outwards instead,
     * so clicking a locked card selects the section that contains it, and
     * clicking a locked section selects nothing at all. Predictable in one
     * sentence, which is the whole requirement for a lock.
     */
    const unlockedAncestor = (element: Element | null): Element | null => {
      let current: Element | null = element;
      while (current) {
        const address = current.getAttribute("data-eod-address");
        if (address && !isLocked(address)) return current;
        current = current.parentElement?.closest(SELECTABLE) ?? null;
      }
      return null;
    };

    const closestNode = (target: EventTarget | null, point?: { x: number; y: number }): Element | null => {
      if (!(target instanceof Element)) return null;
      const found = refineNode(target, point);
      return found ? unlockedAncestor(found) : null;
    };

    const refineNode = (target: Element, point?: { x: number; y: number }): Element | null => {
      const direct = target.closest(SELECTABLE);
      if (!direct || !point) return direct;
      // Cheap gate: only a node with editable things inside it can be refined.
      if (!direct.querySelector(SELECTABLE)) return direct;

      for (const candidate of document.elementsFromPoint(point.x, point.y)) {
        // Front to back. Reaching what was clicked means nothing in front of it
        // was more precise, and anything after it is behind.
        if (candidate === direct) break;
        const inside: Element | null = candidate.closest(SELECTABLE);
        if (inside && inside !== direct && direct.contains(inside)) return inside;
      }
      return direct;
    };

    /* ---------------------------------------------------------------- */
    /* Direct text editing                                               */
    /* ---------------------------------------------------------------- */

    /**
     * The node being typed into, if any.
     *
     * The canvas holds no document and stores nothing. It makes one element
     * editable, reports the plain text as it changes, and puts the text back
     * if the edit is abandoned. Where that text belongs — which field, which
     * row, which edition — is decided by the editor from the block registry,
     * and the ordinary validator and autosave write it. So the page a visitor
     * gets is still rendered from stored values, never from what somebody
     * typed into a browser.
     */
    type Editing = { element: HTMLElement; address: string; before: string; multiline: boolean };
    let editing: Editing | null = null;

    const textOf = (element: HTMLElement): string =>
      // `innerText` rather than `textContent`: the element is being edited, so
      // the line breaks a person can see are the ones they typed.
      (element.innerText ?? "").replace(/\u00a0/g, " ");

    const stopEditing = (commit: boolean) => {
      if (!editing) return;
      const { element, address, before } = editing;
      const text = textOf(element);
      editing = null;

      element.removeAttribute("contenteditable");
      element.removeAttribute("data-eod-editing");
      element.removeAttribute("spellcheck");
      if (!commit) {
        // Escape puts the element back to exactly what it showed. The editor
        // is told too, so a buffer that took the interim keystrokes is wound
        // back to the same place.
        element.textContent = before;
      }
      element.blur();
      post({ type: "canvas.edit", address, phase: commit ? "commit" : "cancel", text: commit ? text : before });
    };

    const startEditing = (element: Element): boolean => {
      const address = element.getAttribute("data-eod-address");
      const mode = element.getAttribute("data-eod-edit");
      if (!address || (mode !== "text" && mode !== "multiline")) return false;
      if (!(element instanceof HTMLElement)) return false;
      if (isLocked(address)) return false;
      if (editing?.element === element) return true;
      stopEditing(true);

      editing = { element, address, before: textOf(element), multiline: mode === "multiline" };
      // `plaintext-only` is the point: the browser will not produce bold,
      // links or pasted markup, so there is no markup for anybody to store.
      element.setAttribute("contenteditable", "plaintext-only");
      element.setAttribute("data-eod-editing", "");
      element.setAttribute("spellcheck", "false");
      element.focus();
      post({ type: "canvas.edit", address, phase: "start", text: editing.before });
      return true;
    };

    const onEditInput = () => {
      if (!editing) return;
      post({ type: "canvas.edit", address: editing.address, phase: "input", text: textOf(editing.element) });
    };

    const onEditKey = (event: KeyboardEvent) => {
      if (!editing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        stopEditing(false);
        return;
      }
      if (event.key === "Enter" && !editing.multiline) {
        // A single-line field is a line: Enter finishes it rather than adding
        // a second one that the field cannot hold.
        event.preventDefault();
        event.stopPropagation();
        stopEditing(true);
        return;
      }
      // Tab is left to the browser on purpose. Trapping focus inside a canvas
      // element is how a keyboard user gets stuck in a page they cannot leave.
    };

    const onEditBlur = () => stopEditing(true);

    const onDoubleClick = (event: MouseEvent) => {
      const element = closestNode(event.target, { x: event.clientX, y: event.clientY });
      if (!element) return;
      if (!startEditing(element)) return;
      event.preventDefault();
      event.stopPropagation();
    };

    const onPointerMove = (event: PointerEvent) =>
      setHover(closestNode(event.target, { x: event.clientX, y: event.clientY }));
    const onPointerLeave = () => setHover(null);

    const onClick = (event: MouseEvent) => {
      // A modified click is the browser's, not ours: open-in-new-tab still
      // means open in a new tab, even in here.
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const element = closestNode(event.target, { x: event.clientX, y: event.clientY });
      if (!element) return;
      // A click inside the node being typed into is placing the caret, not
      // choosing something else.
      if (editing && (element === editing.element || editing.element.contains(event.target as Node))) return;
      if (editing) stopEditing(true);
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
          stopEditing(true);
          setHover(null);
          setSelection(null);
          return;
        case "editor.locks": {
          locked = message.addresses;
          // Something that has just been locked must not stay under the
          // pointer's outline, and must not go on being typed into.
          if (editing && isLocked(editing.address)) stopEditing(true);
          if (hover && isLocked(hover.address)) clearHover();
          return;
        }
        case "editor.edit": {
          if (!message.active) {
            if (editing?.address === message.address) stopEditing(true);
            return;
          }
          const element = document.querySelector(`[data-eod-address="${message.address}"]`);
          if (element) startEditing(element);
          return;
        }
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
    document.addEventListener("dblclick", onDoubleClick, { capture: true });
    document.addEventListener("input", onEditInput, true);
    document.addEventListener("keydown", onEditKey, true);
    document.addEventListener("focusout", onEditBlur, true);
    document.addEventListener("submit", onSubmit, { capture: true });

    announce();

    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", schedule, { capture: true });
      document.removeEventListener("pointermove", onPointerMove);
      document.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("click", onClick, { capture: true });
      document.removeEventListener("dblclick", onDoubleClick, { capture: true });
      document.removeEventListener("input", onEditInput, true);
      document.removeEventListener("keydown", onEditKey, true);
      document.removeEventListener("focusout", onEditBlur, true);
      document.removeEventListener("submit", onSubmit, { capture: true });
      for (const type of ["transitionrun", "transitionend", "animationstart", "animationend"]) {
        document.removeEventListener(type, onMotion, { capture: true });
      }
      tree.disconnect();
      boxes.disconnect();
      observed.clear();
      if (frame) window.cancelAnimationFrame(frame);
      if (resizeFrame) window.cancelAnimationFrame(resizeFrame);
    };
  }, [bridgeId, pageId, slug, locale]);

  return null;
}
