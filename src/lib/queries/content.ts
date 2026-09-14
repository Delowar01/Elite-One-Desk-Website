import "server-only";

import { unstable_cache } from "next/cache";
import { cache } from "react";
import { and, asc, eq } from "drizzle-orm";

import { TAGS } from "@/lib/cache";
import { composePreview, composePublished, type CompositionRow } from "@/lib/cms/composition";
import { readDraftStructure } from "@/lib/cms/structure";
import { db } from "@/lib/db";
import { pageSections, pages, seoMetadata } from "@/lib/db/schema";

export type RenderedSection = {
  id: number;
  blockType: string;
  animation: string;
  values: Record<string, unknown>;
  /** True when this section is showing unpublished edits (preview only). */
  isDraft: boolean;
  /** True when the row exists only because of a pending structural draft. */
  isDraftOnly: boolean;
  /** The visibility this section would have once published. */
  visible: boolean;
};

export type RenderedPage = {
  id: number;
  slug: string;
  titleEn: string;
  titleAr: string;
  isPublished: boolean;
  sections: RenderedSection[];
};

/**
 * One query either way, composed differently.
 *
 * Both paths read the page's rows in `position` order and hand them to
 * `lib/cms/composition`, which is where the rules live and where they are
 * tested. The published path is unchanged by this batch: visible, established
 * sections, published values. The preview path now also reads
 * `pages.draft_structure`, so an editor sees the order and membership a
 * structural draft intends rather than the live `position` order underneath it.
 *
 * `readDraftStructure` returns null for a column that is absent *or* unusable,
 * and the null case falls back to the established order — so a damaged document
 * shows the page as it stands rather than blanking it, while a genuinely empty
 * one still means "publishing this leaves no sections".
 */
async function loadPage(slug: string, preview: boolean): Promise<RenderedPage | null> {
  const [page] = await db.select().from(pages).where(eq(pages.slug, slug)).limit(1);
  if (!page) return null;

  const rows = await db
    .select()
    .from(pageSections)
    .where(
      preview
        ? eq(pageSections.pageId, page.id)
        : and(
            eq(pageSections.pageId, page.id),
            eq(pageSections.isPublished, true),
            eq(pageSections.isDraftOnly, false),
          ),
    )
    .orderBy(asc(pageSections.position), asc(pageSections.id));

  const composable: CompositionRow[] = rows.map((row) => ({
    id: row.id,
    blockType: row.blockType,
    animation: row.animation,
    published: row.published,
    draft: row.draft,
    isPublished: row.isPublished,
    isDraftOnly: row.isDraftOnly,
  }));

  return {
    id: page.id,
    slug: page.slug,
    titleEn: page.titleEn,
    titleAr: page.titleAr,
    isPublished: page.isPublished,
    sections: preview
      ? composePreview(composable, readDraftStructure(page.draftStructure))
      : composePublished(composable),
  };
}

/** The live page. Cached and tagged; publishing drops the tag. */
export const getPage = unstable_cache(
  async (slug: string) => loadPage(slug, false),
  ["page"],
  { tags: [TAGS.pages], revalidate: 3600 },
);

/**
 * The editing view: drafts win over published values and hidden sections are
 * included so an editor can see what they are about to turn on. Never cached —
 * a preview that lags behind the editor is worse than no preview.
 */
export const getPagePreview = (slug: string) => loadPage(slug, true);

export const getPublishedPages = unstable_cache(
  async () =>
    db
      .select({
        slug: pages.slug,
        kind: pages.kind,
        titleEn: pages.titleEn,
        titleAr: pages.titleAr,
        updatedAt: pages.updatedAt,
      })
      .from(pages)
      .where(eq(pages.isPublished, true))
      .orderBy(asc(pages.sortOrder), asc(pages.id)),
  ["published-pages"],
  { tags: [TAGS.pages], revalidate: 3600 },
);

export type SeoRow = typeof seoMetadata.$inferSelect;

/**
 * SEO overrides for every entity, fetched once. Each page then looks its own
 * row up without a query, and a page with no row falls back to the defaults in
 * Site Settings. Rows rather than a Map for the same reason as the media
 * library: the cache serialises what it stores.
 */
const getSeoRows = unstable_cache(async () => db.select().from(seoMetadata), ["seo-rows"], {
  tags: [TAGS.seo],
  revalidate: 3600,
});

export const getSeoMap = cache(async (): Promise<Map<string, SeoRow>> => {
  const rows = await getSeoRows();
  return new Map(rows.map((r) => [`${r.entityType}:${r.entityKey}`, r]));
});

export async function getSeo(entityType: string, entityKey: string): Promise<SeoRow | null> {
  return (await getSeoMap()).get(`${entityType}:${entityKey}`) ?? null;
}
