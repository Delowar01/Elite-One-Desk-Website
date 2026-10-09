import "server-only";

import { eq, or, sql, type SQL } from "drizzle-orm";

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
 * The picture ids a block's stored values can hold, as rows of `image_id`: a
 * top-level value, and a value in a row of a top-level list — where Quick
 * Links keeps its cards' pictures (Batch 26; until then the guard read the top
 * level only, so a card's picture could be deleted while the card showed it,
 * Batch 25 A.14 X1). Searched by value, so a block that gains a picture field
 * is covered without anyone coming back here; that also counts a `limit` of 6
 * as picture 6 (X2), which errs on the side of keeping a picture. It is a
 * superset of every value the hold and the renderer read as a picture
 * (`media-id.ts`) and it must stay one: a picture a writer holds, or a page
 * draws, that this cannot see would be deletable while it is shown. Those
 * readers take a JSON number after JavaScript has parsed it as a double, so
 * this counts every number whose value as a double is whole — `12`, `12.0`
 * and even `12.0000000000000001`, which a hand-made row could hold and every
 * reader takes for 12 — compared as `float8`, the same double. Text never
 * counts: a Statistics figure "15" is not picture 15. A document that is not
 * an object names nothing, rather than failing every delete in the library.
 *
 * Two `jsonb_path_query` calls rather than nested `jsonb_each` /
 * `jsonb_array_elements`: the planner estimates every set-returning function
 * at a hundred rows or more, and nesting three of them multiplied the
 * estimate until Postgres JIT-compiled the media library's count — about a
 * second on every render of the library and every delete, on a few hundred
 * sections. The cast sits inside a `case`, never beside a filter: a caller's
 * `image_id = $1` is pushed down into these selects, and Postgres orders the
 * conditions it ends up with by cost, not as written — a `case` is evaluated
 * in order, and the cast to `float8` sits in a `case` of its own, reached only
 * by text the outer test has already shown to be a decimal number from 0.1 up
 * to ten digits. Below 0.1 a number is never a whole double, so never a
 * picture — and far below it, a hand-written `1e-400` is beyond a double
 * altogether, where the cast would fail every delete in the library.
 */
const pictureId = (value: SQL): SQL => sql`case
  when jsonb_typeof(${value}) = 'number' and (${value} #>> '{}') ~ '^[0-9]{1,10}([.][0-9]+)?$' and (${value} #>> '{}') !~ '^0[.]0' then
    case when (${value} #>> '{}')::float8 = floor((${value} #>> '{}')::float8) then (${value} #>> '{}')::float8::bigint end
end`;
const objectOrEmpty = (doc: SQL | unknown): SQL => sql`case when jsonb_typeof(${doc}) = 'object' then ${doc} else '{}'::jsonb end`;
export const jsonbPictureIds = (doc: SQL | unknown): SQL => sql`(
  select image_id from (
    select ${pictureId(sql`v`)} as image_id
      from jsonb_path_query(${objectOrEmpty(doc)}, 'strict $.*') v
    union all
    select ${pictureId(sql`v`)}
      from jsonb_path_query(${objectOrEmpty(doc)}, 'strict $.* ? (@.type() == "array")[*] ? (@.type() == "object").*') v
  ) ids
   where image_id is not null
)`;

/** Whether a block's stored values name picture `id` anywhere `jsonbPictureIds` looks. */
const namesPicture = (doc: SQL | unknown, id: number): SQL =>
  sql`exists (select 1 from ${jsonbPictureIds(doc)} named where named.image_id = ${id})`;

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
        .where(or(namesPicture(pageSections.published, id), namesPicture(pageSections.draft, id))),
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
        .where(or(namesPicture(reusableComponents.published, id), namesPicture(reusableComponents.draft, id))),
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
