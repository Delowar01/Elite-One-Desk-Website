import { DEFAULT_LOCALE, localeHref, type Locale } from "@/lib/i18n/config";

/**
 * Where a CMS page lives on the public site.
 *
 * One function, because three screens need the same answer and a second
 * opinion about it is how a preview ends up pointing at a page that is not the
 * one being edited: the section preview, the Visual Editor canvas and the
 * "open in a tab" link all build their address from here.
 *
 * The homepage is the site root rather than `/home` — the slug is a database
 * key, not an address. English stays at the clean root paths and Arabic sits
 * under `/ar`, which is the middleware's rule, not this module's; `localeHref`
 * owns it. There is deliberately no `/en/...` form.
 */
export const publicPathForPage = (slug: string): string => (slug === "home" ? "/" : `/${slug}`);

export const localisedPagePath = (slug: string, locale: Locale): string =>
  localeHref(locale, publicPathForPage(slug));

/**
 * The same address with the preview flags on it.
 *
 * `preview=1` alone is the ordinary authenticated draft preview — the real
 * site, reading drafts, wearing its preview banner. `editor` and `bridge` turn
 * that preview into a Visual Editor canvas, and only for a request that has
 * already passed the session check; see `lib/preview.ts`.
 *
 * `r` is a cache-buster the editor bumps to force a fresh document rather than
 * reloading the whole admin page.
 */
export function previewPagePath(
  slug: string,
  locale: Locale,
  options: { nonce?: number | string; editor?: { bridgeId: string } } = {},
): string {
  const params = new URLSearchParams({ preview: "1" });
  if (options.editor) {
    params.set("editor", "1");
    params.set("bridge", options.editor.bridgeId);
  }
  if (options.nonce !== undefined) params.set("r", String(options.nonce));
  return `${localisedPagePath(slug, locale)}?${params}`;
}

/**
 * One pane of Version Compare (Batch 16): the page's own address, asking for
 * one state of it — `published`, or a version by id. Nothing else travels: no
 * snapshot, no JSON, nothing the server did not store itself. The server
 * checks the session, that the version belongs to this page, and that it can
 * read it; see `lib/preview.ts`.
 */
export function compareFramePath(
  slug: string,
  locale: Locale,
  target: "published" | number,
  nonce?: number | string,
): string {
  const params = new URLSearchParams({ compare: target === "published" ? "published" : `v${target}` });
  if (nonce !== undefined) params.set("r", String(nonce));
  return `${localisedPagePath(slug, locale)}?${params}`;
}

/** The locale a stored value names, or English. Used to read URL state back. */
export const localeOrDefault = (value: unknown): Locale =>
  value === "ar" || value === "en" ? value : DEFAULT_LOCALE;

/**
 * A reusable component's own preview on one page (Batch 17): the page's
 * preview with that component's draft drawn in place of its published
 * content. Two integers — the component and the draft revision being looked
 * at — and nothing else: never the draft itself, never JSON. The server
 * checks the session, that the revision is still the component's, and that
 * the page really uses the component, on every request.
 */
export function componentPreviewPath(slug: string, locale: Locale, componentId: number, revision: number): string {
  const params = new URLSearchParams({ component: String(componentId), rev: String(revision) });
  return `${localisedPagePath(slug, locale)}?${params}`;
}
