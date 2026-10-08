import { asc, ne } from "drizzle-orm";

import { AdminPageHeader } from "@/components/admin/page-header";
import { requirePermission } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { media, seoMetadata } from "@/lib/db/schema";
import { getSettingsGroup } from "@/lib/settings";
import { SEO_FORMS, seoRowValues } from "@/lib/seo-form";
import { indexSeoRows, parseSeoRef, seoRowFor } from "@/lib/seo-model";
import { listSeoTargets } from "@/lib/seo-targets";
import { SeoClient, type SeoEntry, type SiteDefaults } from "./seo-client";

export const metadata = { title: "SEO" };
export const dynamic = "force-dynamic";

/**
 * Every page of the site with an address of its own, and the search and
 * sharing settings it uses (Batch 25 — docs/admin/seo-and-share-images.md
 * B.8). The list is the SEO targets (`lib/seo-targets.ts`): the homepage and
 * every CMS page, the Services and Tour packages overviews, and every
 * category, service, destination and package — read from their tables, so a
 * record created a moment ago is listed. Each row's record is the one the
 * public page uses, found by the same rule (`seoRowFor`), and each form is
 * drawn with the signed base its save is held to.
 */
export default async function SeoPage({
  searchParams,
}: {
  searchParams: Promise<{ target?: string | string[] }>;
}) {
  const session = await requirePermission("seo.manage", "/admin/seo");
  const { target: asked } = await searchParams;

  const [targets, rows, library, site] = await Promise.all([
    listSeoTargets(),
    db.select().from(seoMetadata),
    // A share image is a raster picture: no social network shows an SVG.
    db
      .select({
        id: media.id,
        filename: media.filename,
        title: media.title,
        altEn: media.altEn,
        width: media.width,
        height: media.height,
        folder: media.folder,
      })
      .from(media)
      .where(ne(media.mimeType, "image/svg+xml"))
      .orderBy(asc(media.folder), asc(media.title)),
    getSettingsGroup("seo"),
  ]);

  const index = indexSeoRows(rows);
  const entries: SeoEntry[] = [];
  for (const target of targets) {
    if (!target.storage || target.kind === "site") continue;
    const row = seoRowFor(index, target.storage);
    const values = seoRowValues(row);
    entries.push({
      ref: target.ref,
      group: target.group as SeoEntry["group"],
      label: target.label,
      context: target.context,
      path: target.path,
      published: target.published,
      adminHref: target.adminHref,
      own: target.own,
      record: row ? values : null,
      base: SEO_FORMS[target.kind].signBase(target.id, values),
    });
  }

  const siteDefaults: SiteDefaults = {
    defaultTitleEn: site.defaultTitleEn,
    defaultTitleAr: site.defaultTitleAr,
    titleTemplateEn: site.titleTemplateEn,
    titleTemplateAr: site.titleTemplateAr,
    defaultDescriptionEn: site.defaultDescriptionEn,
    defaultDescriptionAr: site.defaultDescriptionAr,
    ogImageId: typeof site.ogImageId === "number" ? site.ogImageId : null,
    twitterHandle: site.twitterHandle,
  };

  // Only a reference that names a listed target opens anything.
  const open = typeof asked === "string" && parseSeoRef(asked) && entries.some((entry) => entry.ref === asked) ? asked : null;

  return (
    <>
      <AdminPageHeader
        title="SEO"
        description="Every address on the site, with the title, description and share image it uses. Leave a field empty and the page keeps following its own content, in each language — which is usually the right answer."
      />
      <SeoClient csrf={session.csrfToken} entries={entries} media={library} site={siteDefaults} open={open} />
    </>
  );
}
