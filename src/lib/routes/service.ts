import "server-only";

import { and, asc, eq, ne, or, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import type { Executor } from "@/lib/db/revision";
import { faqs, serviceCategories, services } from "@/lib/db/schema";

import type { ServiceData } from "./service-model";

export * from "./service-model";

/**
 * The service adapter's database half (Batch 22): reading a service page's
 * rows, the list of services the editor can open, and finding a service by
 * its address. Everything that decides — regions, fields, drafts — is the pure
 * model in `service-model.ts`, re-exported here so callers have one import.
 */

const byOrder = <T extends { sortOrder: number; id: number }>(a: T, b: T) => a.sortOrder - b.sortOrder || a.id - b.id;

/**
 * A service and every row its page draws, in four queries.
 *
 * `lock` holds what a publication writes — the service row, then the
 * service's own questions, each by id — `FOR UPDATE`, in the order every
 * writer takes them: services before questions, and both before the route's
 * regions (`store.ts`). A category publication takes the same rows in the
 * same order (its services, then its questions), so the two can wait for each
 * other and never deadlock. The category and its questions are read, not
 * held: this page never writes them.
 */
export async function loadServiceData(
  on: Executor,
  serviceId: number,
  options: { lock?: boolean } = {},
): Promise<ServiceData | null> {
  if (!Number.isInteger(serviceId) || serviceId <= 0) return null;
  const lock = options.lock === true;

  const serviceQuery = on.select().from(services).where(eq(services.id, serviceId)).limit(1);
  const [service] = lock ? await serviceQuery.for("update") : await serviceQuery;
  if (!service) return null;

  const [category] = await on
    .select()
    .from(serviceCategories)
    .where(eq(serviceCategories.id, service.categoryId))
    .limit(1);
  if (!category) return null;

  // The service's own questions, exactly as the public page picks them.
  const ownQuery = on.select().from(faqs).where(eq(faqs.serviceId, serviceId)).orderBy(asc(faqs.id));
  const own = lock ? await ownQuery.for("update") : await ownQuery;

  // The category's questions shown beside them: published, and not the
  // service's own (a question carries one attachment, so this is belt and braces).
  const inherited = await on
    .select()
    .from(faqs)
    .where(
      and(
        eq(faqs.scope, "category"),
        eq(faqs.categoryId, category.id),
        eq(faqs.isPublished, true),
        or(isNull(faqs.serviceId), ne(faqs.serviceId, serviceId)),
      ),
    )
    .orderBy(asc(faqs.sortOrder), asc(faqs.id));

  return {
    service,
    category,
    faqs: [...own].sort(byOrder),
    inherited,
  };
}

export type ServiceDocumentRow = {
  id: number;
  slug: string;
  titleEn: string;
  isPublished: boolean;
  categoryId: number;
  categorySlug: string;
  categoryTitle: string;
  categoryPublished: boolean;
};

/**
 * Every service the editor can open, grouped by category in the categories'
 * own order and the services' own order within each — names and addresses from
 * the database, so a service created tomorrow is in the list tomorrow.
 */
export async function listServiceDocuments(): Promise<ServiceDocumentRow[]> {
  return db
    .select({
      id: services.id,
      slug: services.slug,
      titleEn: services.titleEn,
      isPublished: services.isPublished,
      categoryId: serviceCategories.id,
      categorySlug: serviceCategories.slug,
      categoryTitle: serviceCategories.titleEn,
      categoryPublished: serviceCategories.isPublished,
    })
    .from(services)
    .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
    .orderBy(
      asc(serviceCategories.sortOrder),
      asc(serviceCategories.id),
      asc(services.sortOrder),
      asc(services.id),
    );
}

/** The service an address names — published or not — or null. Preview and the canvas only. */
export async function serviceIdOf(categorySlug: string, serviceSlug: string): Promise<number | null> {
  const [row] = await db
    .select({ id: services.id })
    .from(services)
    .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
    .where(and(eq(serviceCategories.slug, categorySlug), eq(services.slug, serviceSlug)))
    .limit(1);
  return row?.id ?? null;
}
