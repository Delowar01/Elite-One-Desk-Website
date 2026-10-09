import type { MetadataRoute } from "next";

import { siteUrl } from "@/lib/env";
import { LOCALES, localeHref } from "@/lib/i18n/config";
import { SITE_OWNED_SLUGS } from "@/lib/page-path";
import { getPackages, publishedDestinations, publishedSlugs } from "@/lib/queries/catalog";
import { getPublishedPages, getSeoRecord } from "@/lib/queries/content";
import { homeSeo } from "@/lib/seo";
import { overviewStorage, recordStorage, type SeoStorage } from "@/lib/seo-model";
import { getSettings } from "@/lib/settings";

/**
 * Generated per request, not at build.
 *
 * This is the only database-backed route Next would otherwise prerender, and
 * prerendering it meant `next build` had to reach the production database — the
 * dependency that deadlocked the release adding `package_destinations`. The
 * build is now denied the database outright (deploy.sh step 7), so a sitemap
 * built at build time could not be built at all.
 *
 * `force-dynamic` on this one metadata route and nowhere else. It is not a
 * performance change worth worrying about: the loaders below are the same
 * tagged `unstable_cache` functions the pages use, so a crawler's request costs
 * a cache read, and an admin pressing Refresh caches makes the sitemap correct
 * immediately instead of at the next hourly revalidation.
 */
export const dynamic = "force-dynamic";

type Entry = {
  path: string;
  lastModified: Date;
  priority: number;
  changeFrequency: MetadataRoute.Sitemap[number]["changeFrequency"];
  /** Where the page's SEO record lives — the same storage its own metadata reads. */
  seo: SeoStorage | undefined;
};

/**
 * Everything published, minus what asks not to be indexed.
 *
 * Which addresses are candidates is the publication rule, as before: a page,
 * record or destination that is not published is not listed. Batch 26 (F6j)
 * adds one more rule, for every kind of page alike: an address whose SEO
 * record says `noindex` is left out, in both languages. The record is found by
 * `getSeoRecord` with the storage the page's own `generateMetadata` passes, so
 * the sitemap and the page's robots tag read one row and cannot disagree; the
 * rows are cached under the `seo` tag, which every SEO save drops, so a
 * changed `noindex` reaches this list at the next request. No address is named
 * here: a site-owned slug (`SITE_OWNED_SLUGS`) is an address another route
 * answers, so a `pages` row holding one — the homepage's, listed as `/` — is
 * not listed under it.
 */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const [settings, pages, { categories, services }, packages, destinations, home] = await Promise.all([
    getSettings(),
    getPublishedPages(),
    publishedSlugs(),
    getPackages(),
    publishedDestinations(),
    homeSeo(),
  ]);

  const locales = settings.features.arabicEnabled ? LOCALES : ["en" as const];

  const entries: Entry[] = [
    { path: "/", lastModified: new Date(), priority: 1, changeFrequency: "weekly", seo: home },
    { path: "/services", lastModified: new Date(), priority: 0.9, changeFrequency: "weekly", seo: overviewStorage("serviceIndex") },
    { path: "/packages", lastModified: new Date(), priority: 0.7, changeFrequency: "weekly", seo: overviewStorage("packageIndex") },
  ];

  for (const page of pages) {
    if (SITE_OWNED_SLUGS.has(page.slug)) continue;
    entries.push({
      path: `/${page.slug}`,
      lastModified: page.updatedAt,
      priority: 0.6,
      changeFrequency: "monthly",
      seo: recordStorage("page", page.slug, page.id),
    });
  }
  for (const category of categories) {
    entries.push({
      path: `/services/${category.slug}`,
      lastModified: category.updatedAt,
      priority: 0.8,
      changeFrequency: "weekly",
      seo: recordStorage("category", category.slug, category.id),
    });
  }
  for (const service of services) {
    entries.push({
      path: `/services/${service.category}/${service.slug}`,
      lastModified: service.updatedAt,
      priority: 0.7,
      changeFrequency: "monthly",
      seo: recordStorage("service", `${service.category}/${service.slug}`, service.id),
    });
  }
  // Destinations sit between the catalogue and a package: they are a real
  // landing page, and only listed when they actually hold a published package.
  for (const destination of destinations) {
    entries.push({
      path: `/packages/${destination.slug}`,
      lastModified: destination.updatedAt,
      priority: 0.65,
      changeFrequency: "weekly",
      seo: recordStorage("destination", destination.slug, destination.id),
    });
  }
  for (const row of packages) {
    entries.push({
      path: `/packages/${row.slug}`,
      lastModified: row.updatedAt,
      priority: 0.6,
      changeFrequency: "monthly",
      seo: recordStorage("package", row.slug, row.id),
    });
  }

  const indexable: Entry[] = [];
  for (const entry of entries) {
    const record = entry.seo ? await getSeoRecord(entry.seo) : null;
    if (!record?.noindex) indexable.push(entry);
  }

  // Each address is listed once per language with the alternates attached, so
  // Google is told about the Arabic edition rather than left to find it.
  return indexable.flatMap((entry) =>
    locales.map((locale) => ({
      url: `${siteUrl}${localeHref(locale, entry.path)}`,
      lastModified: entry.lastModified,
      changeFrequency: entry.changeFrequency,
      priority: entry.priority,
      alternates: {
        languages: Object.fromEntries(
          locales.map((l) => [l, `${siteUrl}${localeHref(l, entry.path)}`]),
        ),
      },
    })),
  );
}
