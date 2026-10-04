import "server-only";

import { db } from "@/lib/db";
import { getCatalog, getFaqs } from "@/lib/queries/catalog";

import { readServiceContext } from "./drafts";
import { maySeeDrafts, privateRender, publishedFrom, wantsPrivate, type RouteRender } from "./route-view";
import { serviceIdOf, type ServiceData } from "./service";
import { publishedPresentations } from "./store";

/**
 * How a request for a service's own page is answered (Batch 22): the same
 * table as every dynamic route (`route-view.ts`), with the service's own
 * published page and its own rule for what a visitor sees.
 *
 * The published page is found exactly as it always was — the category by its
 * slug among the published categories, the service by its slug among that
 * category's published services, from the cached catalogue — so a hidden
 * service, a service of a hidden category and an address that names nothing
 * are all still "not found" for a visitor, and the page's own fallbacks (the
 * retired-address map, then 404) apply unchanged. Only the session's
 * `content.view` reaches the drafts, and then by the service's id.
 */

export type ServiceRender = RouteRender<ServiceData>;

/** What a visitor would see of a service's rows: its published questions. */
const publishedOnly = (data: ServiceData): ServiceData => ({
  ...data,
  faqs: data.faqs.filter((faq) => faq.isPublished),
});

/** The published page, from the caches every visitor shares. */
async function publicRender(categorySlug: string, serviceSlug: string): Promise<ServiceRender | null> {
  const [catalog, allFaqs, presentations] = await Promise.all([getCatalog(), getFaqs(), publishedPresentations()]);
  const category = catalog.categories.find((row) => row.slug === categorySlug);
  if (!category) return null;
  const service = (catalog.byCategory.get(category.id) ?? []).find((row) => row.slug === serviceSlug);
  if (!service) return null;
  const data: ServiceData = {
    service,
    category,
    faqs: allFaqs.filter((faq) => faq.serviceId === service.id),
    inherited: allFaqs.filter(
      (faq) => faq.scope === "category" && faq.categoryId === category.id && faq.serviceId !== service.id,
    ),
  };
  return {
    mode: "public",
    editor: null,
    still: false,
    routeKey: `service:${service.id}`,
    data,
    hidden: new Set(),
    drafted: new Set(),
    presentation: publishedFrom(presentations),
  };
}

export async function resolveServiceRender(
  categorySlug: string,
  serviceSlug: string,
  searchParams: Record<string, string | string[] | undefined> | undefined,
): Promise<ServiceRender | null> {
  if (!wantsPrivate(searchParams) || !(await maySeeDrafts())) return publicRender(categorySlug, serviceSlug);
  const id = await serviceIdOf(categorySlug, serviceSlug);
  if (!id) return null;
  const context = await readServiceContext(db, id);
  if (!context) return null;
  return privateRender(context, searchParams, publishedOnly);
}
