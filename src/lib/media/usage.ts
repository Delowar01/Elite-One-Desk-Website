import "server-only";

import { eq, or, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import type { Executor } from "@/lib/db/revision";
import { routeDraftMedia } from "@/lib/routes/media-usage";
import { seoMediaUsage } from "@/lib/seo-targets";
import {
  packageDestinations,
  pageSections,
  pages,
  reusableComponents,
  serviceCategories,
  services,
  testimonials,
  travelPackages,
  videos,
} from "@/lib/db/schema";

export type MediaUse = { label: string; where: string; href: string };

/**
 * Where a picture is placed.
 *
 * Deleting a file that a page still points at leaves a broken image on the live
 * site, and the first you would hear of it is from a visitor. So the library
 * refuses, and shows the editor exactly which screens to clear first.
 *
 * Section values are jsonb, so they are searched by value rather than by a list
 * of known field names — a block type that gains an image field later is
 * covered without anyone coming back to this file.
 *
 * Read on the executor it is given (Batch 25), so the delete can recount inside
 * the transaction that holds the picture — every query on that one connection,
 * none through a cache.
 */
export async function mediaUsage(id: number, on: Executor = db): Promise<MediaUse[]> {
  const uses: MediaUse[] = [];

  const [
    sections,
    categories,
    serviceRows,
    packageRows,
    destinationRows,
    videoRows,
    testimonialRows,
    componentRows,
    routeDrafts,
    seoUses,
  ] = await Promise.all([
      on
        .select({
          id: pageSections.id,
          blockType: pageSections.blockType,
          pageTitle: pages.titleEn,
          pageSlug: pages.slug,
        })
        .from(pageSections)
        .innerJoin(pages, eq(pages.id, pageSections.pageId))
        .where(
          sql`
            exists (select 1 from jsonb_each(${pageSections.published}) e
                    where e.value = to_jsonb(${id}::int))
            or exists (select 1 from jsonb_each(coalesce(${pageSections.draft}, '{}'::jsonb)) e
                       where e.value = to_jsonb(${id}::int))
          `,
        ),
      on
        .select({ id: serviceCategories.id, title: serviceCategories.titleEn })
        .from(serviceCategories)
        .where(eq(serviceCategories.imageId, id)),
      on.select({ id: services.id, title: services.titleEn }).from(services).where(eq(services.imageId, id)),
      on
        .select({ id: travelPackages.id, title: travelPackages.titleEn })
        .from(travelPackages)
        .where(eq(travelPackages.imageId, id)),
      /**
       * A destination's picture (Batch 24): its page's hero. Missing here
       * until then, so a destination's only picture could be deleted as
       * "unused" and the page lose it without a word (`image_id` is
       * `ON DELETE SET NULL`).
       */
      on
        .select({ id: packageDestinations.id, title: packageDestinations.titleEn })
        .from(packageDestinations)
        .where(eq(packageDestinations.imageId, id)),
      on
        .select({ id: videos.id, title: videos.titleEn })
        .from(videos)
        .where(or(eq(videos.thumbnailId, id))),
      on
        .select({ id: testimonials.id, name: testimonials.name })
        .from(testimonials)
        .where(eq(testimonials.imageId, id)),
      /**
       * A reusable component (Batch 17) draws its own picture on every page
       * that links to it, so a picture in its published content — or in a
       * draft about to be published — is placed as surely as one in a section.
       */
      on
        .select({ id: reusableComponents.id, name: reusableComponents.name })
        .from(reusableComponents)
        .where(
          sql`
            exists (select 1 from jsonb_each(coalesce(${reusableComponents.published}, '{}'::jsonb)) e
                    where e.value = to_jsonb(${id}::int))
            or exists (select 1 from jsonb_each(coalesce(${reusableComponents.draft}, '{}'::jsonb)) e
                       where e.value = to_jsonb(${id}::int))
          `,
        ),
      /**
       * A dynamic route's draft (Batch 22): a picture a category's, a
       * service's, a package's or a destination's page — or a package's card
       * on the Tour packages page (Batch 24) — has chosen and not yet published. Deleting it would
       * leave the draft unpublishable, so it is placed as surely as a
       * section's draft — while its record exists to publish it.
       */
      routeDraftMedia(on),
      /**
       * A share image (Batch 25, F5): the picture of an SEO record some page
       * uses — published or not, since publishing it makes the record live at
       * once — and the site's default share image. The same rule the pages
       * read (`seoRowFor`), so a record no page uses protects nothing.
       */
      seoMediaUsage(on),
    ]);

  for (const row of sections) {
    uses.push({
      label: `${row.pageTitle} — ${row.blockType} section`,
      where: "Pages & sections",
      href: `/admin/pages/section/${row.id}`,
    });
  }
  for (const row of categories) {
    uses.push({ label: row.title, where: "Service categories", href: `/admin/categories/${row.id}` });
  }
  for (const row of serviceRows) {
    uses.push({ label: row.title, where: "Services", href: `/admin/services/${row.id}` });
  }
  for (const row of packageRows) {
    uses.push({ label: row.title, where: "Travel packages", href: `/admin/packages/${row.id}` });
  }
  for (const row of destinationRows) {
    uses.push({ label: row.title, where: "Destinations", href: `/admin/packages/destinations/${row.id}` });
  }
  for (const row of videoRows) {
    uses.push({ label: row.title, where: "Videos", href: `/admin/videos` });
  }
  for (const row of testimonialRows) {
    uses.push({ label: row.name, where: "Testimonials", href: `/admin/testimonials` });
  }
  for (const row of componentRows) {
    uses.push({ label: row.name, where: "Reusable components", href: `/admin/components/${row.id}` });
  }
  for (const draft of routeDrafts) {
    if (draft.mediaId !== id) continue;
    uses.push({ label: draft.label, where: "Visual Editor drafts", href: draft.href });
  }
  for (const use of seoUses) {
    if (use.mediaId !== id) continue;
    uses.push({ label: use.label, where: "SEO", href: use.href });
  }

  return uses;
}
