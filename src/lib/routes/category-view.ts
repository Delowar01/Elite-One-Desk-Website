import "server-only";

import { eq } from "drizzle-orm";

import { satisfies } from "@/lib/auth/permissions";
import { getSession } from "@/lib/auth/session";
import { readMotionDocument, type MotionDocument } from "@/lib/cms/motion-doc";
import { validateStyleDocument, type StyleDocument } from "@/lib/cms/styles";
import { db } from "@/lib/db";
import { serviceCategories } from "@/lib/db/schema";
import { getCatalog, getFaqs } from "@/lib/queries/catalog";
import { isBridgeId } from "@/lib/visual-editor/protocol";

import { effectiveData, ownersOf, type CategoryData, type StoredPatch } from "./category";
import { readRouteContext, visibleAfterPublish } from "./drafts";
import { ownerKeyOf } from "./owners";
import { readRouteVersion } from "./publish";
import { draftPresentationOf, publishedOf, publishedPresentations } from "./store";

/**
 * How a request for a category page is answered (Batch 21) — decided here, on
 * the server, from the session, and never from the parameters alone.
 *
 * | Request                                   | Answer                                    |
 * |-------------------------------------------|-------------------------------------------|
 * | anyone, no parameters                     | the published page                        |
 * | `?preview=1` without `content.view`       | the published page                        |
 * | `?preview=1` with `content.view`          | the drafts, as publishing would show them |
 * | `…&editor=1&bridge=<id>`, `content.view`  | the drafts, every region, editor marks    |
 * | `?compare=published|v<id>`, `content.view`| one published state, still, read only    |
 *
 * The published answer reads the cached catalogue and one cached, tagged
 * presentation query that selects published columns only — the public page
 * never reads a draft. Everything else reads the category's own rows directly,
 * unpublished ones included, in a fixed number of queries.
 */

export type RegionPresentation = { styles: StyleDocument; motion: MotionDocument | null; copy: Record<string, string> };

export type CategoryRender = {
  mode: "public" | "preview" | "editor" | "compare";
  editor: { bridgeId: string } | null;
  /** Version Compare's still presentation: no motion, no runtime. */
  still: boolean;
  routeKey: string;
  /** The rows to draw. Unpublished rows are present only in editor mode. */
  data: CategoryData;
  /** Regions that would not be on the public page once published (editor mode draws them dimmed). */
  hidden: ReadonlySet<string>;
  /** Regions with unpublished changes (editor mode marks them). */
  drafted: ReadonlySet<string>;
  presentation: (ownerKey: string) => RegionPresentation;
};

const flag = (value: string | string[] | undefined): boolean => value === "1" || value === "true";
const COMPARE_TARGET = /^(?:published|v([1-9][0-9]{0,9}))$/;

const EMPTY: RegionPresentation = { styles: validateStyleDocument(null), motion: null, copy: {} };

/** The rows a visitor would see: published ones, inside published groups. */
function publishedOnly(data: CategoryData): CategoryData {
  const groups = data.groups.filter((group) => group.isPublished);
  return {
    category: data.category,
    groups,
    services: data.services.filter((service) => service.isPublished),
    faqs: data.faqs.filter((faq) => faq.isPublished),
  };
}

/** The published page, from the caches every visitor shares. */
async function publicRender(slug: string): Promise<CategoryRender | null> {
  const [catalog, allFaqs, presentations] = await Promise.all([getCatalog(), getFaqs(), publishedPresentations()]);
  const category = catalog.categories.find((row) => row.slug === slug);
  if (!category) return null;
  const data: CategoryData = {
    category,
    groups: catalog.subcategories.filter((group) => group.categoryId === category.id),
    services: catalog.byCategory.get(category.id) ?? [],
    faqs: allFaqs.filter((faq) => faq.scope === "category" && faq.categoryId === category.id),
  };
  return {
    mode: "public",
    editor: null,
    still: false,
    routeKey: `category:${category.id}`,
    data,
    hidden: new Set(),
    drafted: new Set(),
    presentation: (key) => {
      const row = presentations[key];
      if (!row) return EMPTY;
      return {
        styles: validateStyleDocument(row.styles ?? null),
        motion: row.motion ? readMotionDocument(row.motion) : null,
        copy: publishedOf({ copy: row.copy } as never).copy,
      };
    },
  };
}

async function categoryIdOf(slug: string): Promise<number | null> {
  const [row] = await db
    .select({ id: serviceCategories.id })
    .from(serviceCategories)
    .where(eq(serviceCategories.slug, slug))
    .limit(1);
  return row?.id ?? null;
}

export async function resolveCategoryRender(
  slug: string,
  searchParams: Record<string, string | string[] | undefined> | undefined,
): Promise<CategoryRender | null> {
  const wantsCompare = searchParams?.compare !== undefined;
  const wantsPreview = flag(searchParams?.preview);
  if (!wantsCompare && !wantsPreview) return publicRender(slug);

  // The flag alone grants nothing: without the session's `content.view` this
  // is an ordinary visit, answered exactly as one.
  const session = await getSession();
  if (!session || !satisfies(session.permissions, "content.view")) return publicRender(slug);

  const id = await categoryIdOf(slug);
  if (!id) return null;
  const routeKey = `category:${id}`;
  const context = await readRouteContext(db, routeKey);
  if (!context) return null;

  if (wantsCompare) {
    const raw = searchParams?.compare;
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
      data: publishedOnly(effectiveData(context.data, overlay)),
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
  for (const owner of ownersOf(context.data)) {
    const key = ownerKeyOf(owner);
    const node = context.nodes.get(key);
    if (!visibleAfterPublish(owner, context.effective)) hidden.add(key);
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
