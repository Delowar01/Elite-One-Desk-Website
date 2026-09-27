import "server-only";

import { getSession } from "@/lib/auth/session";
import { composeSnapshot } from "@/lib/cms/composition";
import { getPage, getPagePreview, type RenderedPage } from "@/lib/queries/content";
import { readPageVersionStrict } from "@/lib/versions";
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
 *
 * `?compare=…` (Batch 16) is one pane of Version Compare: one state of the
 * page, read-only, drawn still. See `resolveCompare`.
 */
export type PageForRender = {
  page: RenderedPage | null;
  isPreview: boolean;
  /** Present only for an authorised preview that asked to be a canvas. */
  editor: { bridgeId: string } | null;
  /** Present only for an authorised comparison pane (Batch 16). */
  compare: { target: "published" | { versionId: number } } | null;
};

const flag = (value: string | string[] | undefined): boolean => value === "1" || value === "true";

/**
 * What a comparison pane may show: `published`, or `v` and a version id. One
 * word or one integer — never a snapshot, never JSON, never anything the
 * server did not store itself.
 */
const COMPARE_TARGET = /^(?:published|v([1-9][0-9]{0,9}))$/;

export async function resolvePageForRender(
  slug: string,
  searchParams?: Record<string, string | string[] | undefined>,
): Promise<PageForRender> {
  if (searchParams?.compare !== undefined) return resolveCompare(slug, searchParams.compare);

  const wants = flag(searchParams?.preview);
  if (!wants) return { page: await getPage(slug), isPreview: false, editor: null, compare: null };

  const session = await getSession();
  if (!session?.permissions.has("content.view")) {
    return { page: await getPage(slug), isPreview: false, editor: null, compare: null };
  }

  const bridgeId = searchParams?.bridge;
  const editor =
    flag(searchParams?.editor) && isBridgeId(bridgeId) ? { bridgeId } : null;

  return { page: await getPagePreview(slug), isPreview: true, editor, compare: null };
}

/**
 * One pane of Version Compare (Batch 16): a state of this page, drawn by the
 * real renderer inside the real site layout, read-only.
 *
 * The rules, in the order they are applied:
 *
 *   · **The session decides, not the parameter.** Without `content.view` — the
 *     permission page history is read with — this is an ordinary visit: the
 *     published page, nothing historical, nothing still.
 *   · **Only a value the server can name.** `published`, or a version id. A
 *     snapshot never travels in the address; anything else is not a page.
 *   · **The version must belong to this page** — the page the address names,
 *     checked against the version row's own `page_id`. A version of another
 *     page, asked for under this page's address, is not found here, so one
 *     page's history can never be shown as another's.
 *   · **Strictly read.** A snapshot this build cannot read is refused rather
 *     than rebuilt into an empty page.
 *   · **Published means published.** The current side is the live composition
 *     — never a draft.
 *
 * It reads and writes nothing else: no draft, no revision, no restore point,
 * no activity. Nothing is cached publicly either — the middleware marks every
 * comparison request private and not indexable.
 */
async function resolveCompare(slug: string, raw: string | string[] | undefined): Promise<PageForRender> {
  const session = await getSession();
  if (!session?.permissions.has("content.view")) {
    return { page: await getPage(slug), isPreview: false, editor: null, compare: null };
  }
  const nothing: PageForRender = { page: null, isPreview: false, editor: null, compare: null };
  if (typeof raw !== "string") return nothing;
  const match = COMPARE_TARGET.exec(raw);
  if (!match) return nothing;

  const live = await getPage(slug);
  if (!live) return nothing;
  if (!match[1]) return { page: live, isPreview: false, editor: null, compare: { target: "published" } };

  const versionId = Number(match[1]);
  const read = await readPageVersionStrict(versionId);
  if (!read.ok || read.record.pageId !== live.id) return nothing;
  return {
    page: { ...live, sections: composeSnapshot(read.record.snapshot) },
    isPreview: false,
    editor: null,
    compare: { target: { versionId } },
  };
}
