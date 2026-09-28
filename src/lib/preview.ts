import "server-only";

import { and, eq, or } from "drizzle-orm";

import { getSession } from "@/lib/auth/session";
import { composeSnapshot } from "@/lib/cms/composition";
import { reuseAllowed } from "@/lib/cms/reuse/authority";
import { HAS_REFERENCE, refersTo } from "@/lib/cms/reuse/store";
import { db } from "@/lib/db";
import { pageSections, reusableComponents } from "@/lib/db/schema";
import { getPage, getPageComponentPreview, getPagePreview, type RenderedPage } from "@/lib/queries/content";
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
  /** Present only for a reusable component's own preview (Batch 17). */
  componentPreview?: { componentId: number; name: string } | null;
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
  if (searchParams?.component !== undefined) {
    return resolveComponentPreview(slug, searchParams.component, searchParams.rev);
  }

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

/** A positive id, or a revision — digits only, never anything else. */
const COMPONENT_ID = /^[1-9][0-9]{0,9}$/;
const REVISION = /^(?:0|[1-9][0-9]{0,9})$/;

/**
 * A reusable component's own preview on one page (Batch 17): what publishing
 * the component's draft would do to this page, before it does it.
 *
 * The page is drawn as its preview draws it, with one difference — this
 * component's *draft* stands in for its published content, and every other
 * component stays as published. The rules, in order:
 *
 *   · **The session decides.** Without `content.view` this is an ordinary
 *     visit: the live page, nothing pending.
 *   · **Two integers.** The component id and the draft revision being
 *     previewed. Anything else in either is not a page.
 *   · **The revision must be current.** A preview link built from a draft
 *     that has since been saved again, published or discarded is refused,
 *     rather than quietly showing something other than what its link named.
 *   · **The page must use the component** — in its live content or its
 *     pending content — checked against the section rows. A component cannot
 *     be previewed on a page it has nothing to do with.
 *
 * It writes nothing, and the middleware marks every such response private,
 * uncacheable and not indexable.
 */
async function resolveComponentPreview(
  slug: string,
  rawId: string | string[] | undefined,
  rawRevision: string | string[] | undefined,
): Promise<PageForRender> {
  const session = await getSession();
  if (!reuseAllowed(session?.permissions, "view")) {
    return { page: await getPage(slug), isPreview: false, editor: null, compare: null };
  }
  const nothing: PageForRender = { page: null, isPreview: false, editor: null, compare: null };
  if (typeof rawId !== "string" || typeof rawRevision !== "string") return nothing;
  if (!COMPONENT_ID.test(rawId) || !REVISION.test(rawRevision)) return nothing;
  const componentId = Number(rawId);

  const [component] = await db
    .select({ name: reusableComponents.name, revision: reusableComponents.revision })
    .from(reusableComponents)
    .where(eq(reusableComponents.id, componentId))
    .limit(1);
  if (!component || component.revision !== Number(rawRevision)) return nothing;

  const page = await getPageComponentPreview(slug, componentId);
  if (!page) return nothing;
  const [uses] = await db
    .select({ id: pageSections.id })
    .from(pageSections)
    .where(
      and(
        eq(pageSections.pageId, page.id),
        HAS_REFERENCE,
        or(refersTo(pageSections.published, componentId), refersTo(pageSections.draft, componentId)),
      ),
    )
    .limit(1);
  if (!uses) return nothing;

  return {
    page,
    isPreview: true,
    editor: null,
    compare: null,
    componentPreview: { componentId, name: component.name },
  };
}
