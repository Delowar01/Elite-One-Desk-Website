import "server-only";

import { and, asc, eq, inArray } from "drizzle-orm";

import { db } from "@/lib/db";
import type { Executor } from "@/lib/db/revision";
import { faqs, media, serviceCategories, serviceSubcategories, services } from "@/lib/db/schema";

import type { CategoryData } from "./category-model";

export * from "./category-model";

/**
 * The category adapter's database half (Batch 21): reading a category route's
 * rows, the list of categories the editor can open, and which pictures exist.
 * Everything that decides — owners, fields, validation, drafts — is the pure
 * model in `category-model.ts`, re-exported here so callers have one import.
 */

const byOrder = <T extends { sortOrder: number; id: number }>(a: T, b: T) => a.sortOrder - b.sortOrder || a.id - b.id;

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A category and every row its page draws, in four queries whatever the
 * number of cards. `lock` holds them all `FOR UPDATE`, in a fixed order —
 * category, groups, services, questions, each by id — for a publication that
 * decides what to write from what it read.
 */
export async function loadCategoryData(
  on: Executor,
  categoryId: number,
  options: { lock?: boolean } = {},
): Promise<CategoryData | null> {
  if (!Number.isInteger(categoryId) || categoryId <= 0) return null;
  const lock = options.lock === true;

  const categoryQuery = on.select().from(serviceCategories).where(eq(serviceCategories.id, categoryId)).limit(1);
  const [category] = lock ? await categoryQuery.for("update") : await categoryQuery;
  if (!category) return null;

  const groupQuery = on
    .select()
    .from(serviceSubcategories)
    .where(eq(serviceSubcategories.categoryId, categoryId))
    .orderBy(asc(serviceSubcategories.id));
  const serviceQuery = on.select().from(services).where(eq(services.categoryId, categoryId)).orderBy(asc(services.id));
  const faqQuery = on
    .select()
    .from(faqs)
    .where(and(eq(faqs.scope, "category"), eq(faqs.categoryId, categoryId)))
    .orderBy(asc(faqs.id));

  const groups = lock ? await groupQuery.for("update") : await groupQuery;
  const serviceRows = lock ? await serviceQuery.for("update") : await serviceQuery;
  const faqRows = lock ? await faqQuery.for("update") : await faqQuery;

  return {
    category,
    groups: [...groups].sort(byOrder),
    services: [...serviceRows].sort(byOrder),
    faqs: [...faqRows].sort(byOrder),
  };
}

/** Every category the editor can open, by its own order — names from the database. */
export async function listCategoryDocuments(): Promise<
  { id: number; slug: string; titleEn: string; isPublished: boolean }[]
> {
  const rows = await db
    .select({
      id: serviceCategories.id,
      slug: serviceCategories.slug,
      titleEn: serviceCategories.titleEn,
      isPublished: serviceCategories.isPublished,
      sortOrder: serviceCategories.sortOrder,
    })
    .from(serviceCategories)
    .orderBy(asc(serviceCategories.sortOrder), asc(serviceCategories.id));
  return rows.map(({ id, slug, titleEn, isPublished }) => ({ id, slug, titleEn, isPublished }));
}


/** The library ids a submission names, for the existence check `readSubmitted` needs. */
export async function existingMedia(on: Executor, ids: number[]): Promise<Set<number>> {
  const wanted = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  if (!wanted.length) return new Set();
  const rows = await on.select({ id: media.id }).from(media).where(inArray(media.id, wanted));
  return new Set(rows.map((row) => row.id));
}

