/**
 * Keyboard focus in Layers across a canvas redraw (Batch 24).
 *
 * Layers is drawn from the canvas's own report of its document, and every
 * write that changes what the canvas shows redraws it: from the redraw until
 * the new document reports in, the tree has no rows (Batch 23). The rows are
 * not kept on screen in between, on purpose — they would describe a document
 * that is going away: a Draft or Hidden badge that may no longer be true, an
 * order that has just changed, an address a click would send to a canvas that
 * has not reported it yet. But a keyboard user who pressed one of a row's
 * controls — Move up, Hide, Lock — lost their place with the row, and the
 * focus fell to the page.
 *
 * What survives the redraw is *where the focus was*, as data: the row's
 * address and which of its controls. When the new tree draws that row, the
 * focus goes back to that control — or to the row itself when the control is
 * gone or disabled (a section moved to the top has no Move up) — and only if
 * nothing else has been focused in the meantime: a click into the Inspector or
 * the canvas while the canvas was redrawn is the person's own choice, and wins.
 */

export type LayersFocus = { address: string; control: string };

const PANEL = "[data-layers-panel]";

/** The controls a row carries, each marked with the row's address. */
const MARKED = ["row", "toggle", "lock", "edit"] as const;

/** Where the focus is in Layers, or null when it is anywhere else. */
export function layersFocusOf(active: Element | null): LayersFocus | null {
  if (!active?.closest(PANEL)) return null;
  for (const control of MARKED) {
    const address = active.getAttribute(`data-layer-${control}`);
    if (address) return { address, control };
  }
  // A row's structural buttons sit in a strip marked with the row's address.
  const op = active.getAttribute("data-layer-op");
  const address = op ? active.closest("[data-layer-ops]")?.getAttribute("data-layer-ops") : null;
  return op && address ? { address, control: `op:${op}` } : null;
}

/** Compared, not interpolated into a selector: an address carries `:` and `/`. */
const marked = (scope: ParentNode, attribute: string, value: string): HTMLElement | null =>
  [...scope.querySelectorAll<HTMLElement>(`[${attribute}]`)].find((element) => element.getAttribute(attribute) === value) ?? null;

const focusable = (element: HTMLElement | null): HTMLElement | null =>
  element && !(element instanceof HTMLButtonElement && element.disabled) ? element : null;

/** The control to focus on the tree drawn now; null when its row is not on it. */
export function layersFocusTarget(root: ParentNode, focus: LayersFocus): HTMLElement | null {
  const panel = root.querySelector(PANEL);
  if (!panel) return null;
  const row = () => focusable(marked(panel, "data-layer-row", focus.address));
  if (focus.control.startsWith("op:")) {
    const strip = marked(panel, "data-layer-ops", focus.address);
    return focusable(strip ? marked(strip, "data-layer-op", focus.control.slice(3)) : null) ?? row();
  }
  return focusable(marked(panel, `data-layer-${focus.control}`, focus.address)) ?? row();
}
