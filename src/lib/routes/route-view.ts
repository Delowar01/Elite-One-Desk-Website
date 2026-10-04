import "server-only";

import { satisfies } from "@/lib/auth/permissions";
import { getSession } from "@/lib/auth/session";
import { readMotionDocument, type MotionDocument } from "@/lib/cms/motion-doc";
import { validateStyleDocument, type StyleDocument } from "@/lib/cms/styles";
import { isBridgeId } from "@/lib/visual-editor/protocol";

import type { RouteContext, RouteData } from "./adapter";
import { ownerKeyOf } from "./owners";
import { readRouteVersion } from "./publish";
import type { StoredPatch } from "./specs";
import { draftPresentationOf, publishedOf } from "./store";

/**
 * How a request for a dynamic route's page is answered (Batch 21; shared by
 * every route kind since Batch 22) — decided here, on the server, from the
 * session, and never from the parameters alone.
 *
 * | Request                                   | Answer                                    |
 * |-------------------------------------------|-------------------------------------------|
 * | anyone, no parameters                     | the published page                        |
 * | `?preview=1` without `content.view`       | the published page                        |
 * | `?preview=1` with `content.view`          | the drafts, as publishing would show them |
 * | `…&editor=1&bridge=<id>`, `content.view`  | the drafts, every region, editor marks    |
 * | `?compare=published|v<id>`, `content.view`| one published state, still, read only    |
 *
 * The published answer is the route's own (`publicRender`): its cached
 * loaders and one cached, tagged presentation query that selects published
 * columns only — the public page never reads a draft. Everything else reads
 * the route's own rows directly, unpublished ones included, in a fixed number
 * of queries.
 */

export type RegionPresentation = { styles: StyleDocument; motion: MotionDocument | null; copy: Record<string, string> };

export type RouteRender<D> = {
  mode: "public" | "preview" | "editor" | "compare";
  editor: { bridgeId: string } | null;
  /** Version Compare's still presentation: no motion, no runtime. */
  still: boolean;
  routeKey: string;
  /** The rows to draw. Unpublished rows are present only in editor mode. */
  data: D;
  /** Regions that would not be on the public page once published (editor mode draws them dimmed). */
  hidden: ReadonlySet<string>;
  /** Regions with unpublished changes (editor mode marks them). */
  drafted: ReadonlySet<string>;
  presentation: (ownerKey: string) => RegionPresentation;
};

const flag = (value: string | string[] | undefined): boolean => value === "1" || value === "true";
const COMPARE_TARGET = /^(?:published|v([1-9][0-9]{0,9}))$/;

export const EMPTY_PRESENTATION: RegionPresentation = { styles: validateStyleDocument(null), motion: null, copy: {} };

/** The published presentation the public page draws, from the cached presentation map. */
export const publishedFrom =
  (presentations: Record<string, { styles: unknown; motion: unknown; copy: unknown }>) =>
  (key: string): RegionPresentation => {
    const row = presentations[key];
    if (!row) return EMPTY_PRESENTATION;
    return {
      styles: validateStyleDocument(row.styles ?? null),
      motion: row.motion ? readMotionDocument(row.motion) : null,
      copy: publishedOf({ copy: row.copy } as never).copy,
    };
  };

/** Whether a request asks for anything beyond the published page. */
export const wantsPrivate = (searchParams: Record<string, string | string[] | undefined> | undefined): boolean =>
  searchParams?.compare !== undefined || flag(searchParams?.preview);

/**
 * The private answers — compare, preview, canvas — for a route whose
 * context has been read. `publishedOnly` is the route's own rule for what a
 * visitor would see of its rows (published cards in published groups, a
 * service's published questions).
 */
export async function privateRender<D extends RouteData>(
  context: RouteContext<D>,
  searchParams: Record<string, string | string[] | undefined> | undefined,
  publishedOnly: (data: D) => D,
): Promise<RouteRender<D> | null> {
  const routeKey = context.routeKey;

  if (searchParams?.compare !== undefined) {
    const raw = searchParams.compare;
    const match = typeof raw === "string" ? COMPARE_TARGET.exec(raw) : null;
    if (!match) return null;
    const published = (key: string) => publishedOf(context.nodes.get(key));
    if (!match[1]) {
      return {
        mode: "compare",
        editor: null,
        still: true,
        routeKey,
        data: publishedOnly(context.data),
        hidden: new Set(),
        drafted: new Set(),
        presentation: published,
      };
    }
    const snapshot = await readRouteVersion(routeKey, Number(match[1]));
    if (!snapshot) return null;
    // The version's values laid over today's rows, exactly as a draft would
    // be: a region the version did not know keeps what it has now.
    const overlay = new Map<string, StoredPatch>();
    for (const [key, owned] of Object.entries(snapshot.owners)) {
      overlay.set(
        key,
        Object.fromEntries(Object.entries(owned.fields).map(([field, value]) => [field, { value, base: value }])),
      );
    }
    return {
      mode: "compare",
      editor: null,
      still: true,
      routeKey,
      data: publishedOnly(context.adapter.effective(context.data, overlay)),
      hidden: new Set(),
      drafted: new Set(),
      presentation: (key) => {
        const owned = snapshot.owners[key];
        if (!owned) return published(key);
        const copy: Record<string, string> = {};
        for (const [field, value] of Object.entries(owned.fields)) {
          if (field.startsWith("copy:") && typeof value === "string" && value) copy[field.slice(5)] = value;
        }
        return { styles: validateStyleDocument(owned.styles), motion: owned.motion ?? null, copy };
      },
    };
  }

  const bridgeId = searchParams?.bridge;
  const editor = flag(searchParams?.editor) && isBridgeId(bridgeId) ? { bridgeId } : null;

  const hidden = new Set<string>();
  const drafted = new Set<string>();
  for (const owner of context.owners) {
    const key = ownerKeyOf(owner);
    const node = context.nodes.get(key);
    if (!context.adapter.visible(owner, context.effective)) hidden.add(key);
    if (context.patches.has(key) || node?.draftStyles != null || node?.draftMotion != null) drafted.add(key);
  }

  return {
    mode: editor ? "editor" : "preview",
    editor,
    still: false,
    routeKey,
    // The canvas draws every region, a hidden one dimmed, because the only way
    // to show it again is to select it. A plain preview shows what publishing
    // would put on the page.
    data: editor ? context.effective : publishedOnly(context.effective),
    hidden,
    drafted,
    presentation: (key) => {
      const shown = draftPresentationOf(context.nodes.get(key));
      const copy = { ...shown.copy };
      for (const [field, entry] of Object.entries(context.patches.get(key) ?? {})) {
        if (!field.startsWith("copy:")) continue;
        if (typeof entry.value === "string" && entry.value) copy[field.slice(5)] = entry.value;
        else delete copy[field.slice(5)];
      }
      return { ...shown, copy };
    },
  };
}

/**
 * Whether this request's session may see drafts at all. The flag alone grants
 * nothing: without the session's `content.view` a private request is an
 * ordinary visit, answered exactly as one.
 */
export async function maySeeDrafts(): Promise<boolean> {
  const session = await getSession();
  return Boolean(session && satisfies(session.permissions, "content.view"));
}
