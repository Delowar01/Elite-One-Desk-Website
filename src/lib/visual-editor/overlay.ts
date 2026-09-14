/**
 * Turning a rectangle the canvas measured into one the editor can draw.
 *
 * There are three coordinate spaces in play and mixing them is the classic way
 * an overlay ends up near the right element instead of on it:
 *
 *   **Canvas viewport** — what `getBoundingClientRect()` returns inside the
 *   iframe: CSS pixels relative to the iframe's own visible area, scroll
 *   already taken off. This is what the protocol carries, and the only thing it
 *   carries.
 *
 *   **Overlay space** — the editor's own positioned box. The canvas is scaled
 *   to fit the stage, so a 1440px page shown at 0.76 puts an element measured
 *   at x=200 at x=152 on screen.
 *
 *   **Screen** — never used, never sent. Nothing here needs it, and it would
 *   change under the admin's own scrolling.
 *
 * The transform is scale, then offset, and the offset is passed in rather than
 * assumed. In this layout the overlay shares a box with the frame so it is
 * zero — but writing it as zero would be a magic number that quietly becomes
 * wrong the first time a ruler or a toolbar moves the frame inside the stage.
 */

export type Rect = { x: number; y: number; width: number; height: number };

/** How the canvas is presented: its scale, and where its box starts. */
export type CanvasView = { scale: number; offsetX: number; offsetY: number };

export const IDENTITY_VIEW: CanvasView = { scale: 1, offsetX: 0, offsetY: 0 };

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * A rectangle worth drawing.
 *
 * Zero-sized is not: an element that has not laid out yet, one inside a
 * collapsed container, or one an animation has momentarily scaled to nothing
 * all measure zero, and an overlay around nothing is a dot in the corner. The
 * caller keeps the last good rectangle instead.
 */
export function isUsableRect(value: unknown): value is Rect {
  if (typeof value !== "object" || value === null) return false;
  const rect = value as Record<string, unknown>;
  if (!finite(rect.x) || !finite(rect.y) || !finite(rect.width) || !finite(rect.height)) return false;
  return rect.width > 0 && rect.height > 0;
}

/** Canvas viewport → overlay space. */
export function toOverlayRect(rect: Rect, view: CanvasView): Rect {
  const scale = finite(view.scale) && view.scale > 0 ? view.scale : 1;
  return {
    x: view.offsetX + rect.x * scale,
    y: view.offsetY + rect.y * scale,
    width: rect.width * scale,
    height: rect.height * scale,
  };
}

/**
 * Whether any of it is on screen.
 *
 * A selected element the editor has scrolled past still has a rectangle — a
 * large negative one — and drawing it would paint an outline across the
 * toolbar. Clipping it to the visible box is the overlay's job; moving the
 * canvas is the editor's.
 */
export function intersectsViewport(rect: Rect, viewport: { width: number; height: number }): boolean {
  return (
    rect.x < viewport.width && rect.y < viewport.height && rect.x + rect.width > 0 && rect.y + rect.height > 0
  );
}
