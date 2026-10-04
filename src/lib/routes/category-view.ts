import "server-only";

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { serviceCategories } from "@/lib/db/schema";
import { getCatalog, getFaqs } from "@/lib/queries/catalog";

import type { CategoryData } from "./category";
import { readCategoryContext } from "./drafts";
import { maySeeDrafts, privateRender, publishedFrom, wantsPrivate, type RouteRender } from "./route-view";
import { publishedPresentations } from "./store";

export type { RegionPresentation } from "./route-view";

/**
 * How a request for a category page is answered (Batch 21) — the table is in
 * `route-view.ts`, which every route kind shares since Batch 22. This module
 * is the category's own half: where its published page comes from, and what
 * of its rows a visitor sees.
 */

export type CategoryRender = RouteRender<CategoryData>;

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
    presentation: publishedFrom(presentations),
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
  if (!wantsPrivate(searchParams) || !(await maySeeDrafts())) return publicRender(slug);
  const id = await categoryIdOf(slug);
  if (!id) return null;
  const context = await readCategoryContext(db, id);
  if (!context) return null;
  return privateRender(context, searchParams, publishedOnly);
}
