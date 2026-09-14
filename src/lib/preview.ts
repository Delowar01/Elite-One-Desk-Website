import "server-only";

import { getSession } from "@/lib/auth/session";
import { getPage, getPagePreview, type RenderedPage } from "@/lib/queries/content";
import { isBridgeId } from "@/lib/visual-editor/protocol";

/**
 * Resolves a page for rendering, in draft form when an authorised editor asks
 * for it with `?preview=1`.
 *
 * The flag alone grants nothing: the session is checked on every request, so a
 * visitor who guesses the parameter gets the published page. Using the real
 * public route for preview — rather than a separate renderer — is what makes
 * the preview trustworthy: it is the site, with the same layout, fonts and
 * scripts, reading different values.
 *
 * `?editor=1&bridge=…` layers the Visual Editor canvas on top of that, and the
 * order of the checks is the point: editor mode is only ever reached *through*
 * an authorised preview. A visitor typing the parameters gets the published
 * page, no draft, and no bridge — the canvas script is a client component this
 * function's answer decides whether to render at all, so an unauthorised
 * request does not merely fail to connect, it never ships the code.
 *
 * The bridge id is correlation, not authority. It is validated for shape so a
 * junk value cannot travel into a `postMessage` payload, and it is checked
 * against nothing else, because it proves nothing else.
 */
export type PageForRender = {
  page: RenderedPage | null;
  isPreview: boolean;
  /** Present only for an authorised preview that asked to be a canvas. */
  editor: { bridgeId: string } | null;
};

const flag = (value: string | string[] | undefined): boolean => value === "1" || value === "true";

export async function resolvePageForRender(
  slug: string,
  searchParams?: Record<string, string | string[] | undefined>,
): Promise<PageForRender> {
  const wants = flag(searchParams?.preview);
  if (!wants) return { page: await getPage(slug), isPreview: false, editor: null };

  const session = await getSession();
  if (!session?.permissions.has("content.view")) {
    return { page: await getPage(slug), isPreview: false, editor: null };
  }

  const bridgeId = searchParams?.bridge;
  const editor =
    flag(searchParams?.editor) && isBridgeId(bridgeId) ? { bridgeId } : null;

  return { page: await getPagePreview(slug), isPreview: true, editor };
}
