import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";

import { AdminPageHeader } from "@/components/admin/page-header";
import { requirePermission } from "@/lib/auth/guard";
import { getBlock } from "@/lib/cms/blocks";
import { draftKindOf } from "@/lib/cms/drafts";
import { motionOf } from "@/lib/cms/motion";
import { emptyValues } from "@/lib/cms/values";
import { db } from "@/lib/db";
import { media, pageSections, pages } from "@/lib/db/schema";
import { SectionForm } from "./section-form";

export const dynamic = "force-dynamic";
export const metadata = { title: "Edit section" };

export default async function SectionEditor({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission("content.manage");
  const { id: rawId } = await params;
  const id = Number(rawId) || 0;

  const [row] = await db
    .select({ section: pageSections, page: pages })
    .from(pageSections)
    .innerJoin(pages, eq(pages.id, pageSections.pageId))
    .where(eq(pageSections.id, id))
    .limit(1);
  if (!row) notFound();

  const block = getBlock(row.section.blockType);
  if (!block) notFound();

  const library = await db
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
    .orderBy(asc(media.folder), asc(media.title));

  // Start from a complete shell so a block that gained a field since this
  // section was created still shows the new one.
  const values = {
    ...emptyValues(block),
    ...((row.section.draft ?? row.section.published) as Record<string, unknown>),
  };

  return (
    <>
      <AdminPageHeader
        title={block.name}
        description={block.description}
        crumbs={[
          { label: "Pages & sections", href: "/admin/pages" },
          { label: row.page.titleEn, href: `/admin/pages/${row.page.slug}` },
          { label: block.name },
        ]}
        actions={
          <Link href={`/admin/pages/${row.page.slug}`} className="admin-btn">
            Back to the page
          </Link>
        }
      />

      <div className="max-w-4xl">
        <SectionForm
          csrf={session.csrfToken}
          block={block}
          media={library}
          previewHref={`/admin/pages/${row.page.slug}/preview`}
          section={{
            id: row.section.id,
            /**
             * What this screen is editing, which is the draft when there is
             * one. Showing the published preset over the top of a motion draft
             * would present a stale choice as the current one, and saving the
             * form — which sends whatever the menu is showing — would then
             * quietly discard the draft by matching it back to live.
             */
            animation: motionOf(row.section.draftAnimation ?? row.section.animation),
            draftKind: draftKindOf(row.section),
            isDraftOnly: row.section.isDraftOnly,
            values,
            revision: row.section.revision,
          }}
        />
      </div>
    </>
  );
}
