/** Widths written beside every raster upload and offered through srcset. */
export const DERIVATIVE_WIDTHS = [400, 800, 1600] as const;

export type MediaRef = {
  id: number;
  filename: string;
  width: number;
  height: number;
  altEn: string;
  altAr: string;
  title: string;
  derivatives: number[];
};

/**
 * Uploaded files are served by /media/<filename>, a route handler that streams
 * from UPLOAD_DIR. Derivatives are written beside the original as
 * `<stem>@<width>.webp`, so a srcset is a pure string operation with no
 * per-request work and no image optimiser in the path.
 */
export function mediaSrc(ref: Pick<MediaRef, "filename">, width?: number): string {
  if (!width) return `/media/${ref.filename}`;
  const stem = ref.filename.replace(/\.[^.]+$/, "");
  return `/media/${stem}@${width}.webp`;
}

/** The width of the rendition a page names as its share image (`og:image`, `twitter:image`). */
export const SHARE_WIDTH = 1600;

/**
 * Where a share image's rendition is offered to the crawlers that draw link
 * previews (Batch 26).
 *
 * `robots.txt` keeps every rendition (`/media/*@*`) out of crawlers' reach, so
 * a card naming `/media/<stem>@1600.webp` was a card those crawlers were told
 * not to fetch, and X's honours that. This address serves the same file —
 * only the 1600 rendition, never an original, never anything but WebP — at a
 * path with no `@` in it, so the rule that keeps the other renditions out
 * never matches it. Only pages name it, and only as their share image.
 */
export function shareSrc(ref: Pick<MediaRef, "filename">): string {
  return `/media/share/${ref.filename.replace(/\.[^.]+$/, "")}.webp`;
}

/** The file `shareSrc` names: `/media/share/<stem>.webp` is `<stem>@1600.webp`, or nothing. */
export function shareFile(name: string): string | null {
  const match = /^([a-z0-9][a-z0-9._-]{0,170})\.webp$/i.exec(name);
  if (!match || match[1]!.includes("..")) return null;
  return `${match[1]}@${SHARE_WIDTH}.webp`;
}

export function mediaSrcSet(ref: MediaRef): string | undefined {
  if (!ref.derivatives?.length) return undefined;
  const entries = ref.derivatives
    .filter((w) => w < ref.width || ref.derivatives.length === 1)
    .map((w) => `${mediaSrc(ref, w)} ${w}w`);
  entries.push(`${mediaSrc(ref)} ${ref.width}w`);
  return entries.join(", ");
}
