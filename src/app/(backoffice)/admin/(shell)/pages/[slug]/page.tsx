import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";

import { AdminPageHeader } from "@/components/admin/page-header";
import { Icon } from "@/components/ui/icon";
import { requirePermission } from "@/lib/auth/guard";
import { blocksForPage, getBlock } from "@/lib/cms/blocks";
import { text } from "@/lib/cms/values";
import { draftKindOf, hasDraft } from "@/lib/cms/drafts";
import { getPageStructure } from "@/lib/cms/structure-service";
import { removedSections } from "@/lib/cms/structure";
import { db } from "@/lib/db";
import { pageSections, pages } from "@/lib/db/schema";
import { DeletePageForm, PageSettingsForm, PublishAllButton } from "../page-forms";
import { SectionList, type SectionRow } from "./section-list";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const [row] = await db.select({ titleEn: pages.titleEn }).from(pages).where(eq(pages.slug, slug)).limit(1);
  return { title: row?.titleEn ?? "Page" };
}

export default async function PageEditor({ params }: { params: Promise<{ slug: string }> }) {
  const session = await requirePermission("content.view");
  const { slug } = await params;
  const canManage = session.permissions.has("content.manage");

  const [page] = await db.select().from(pages).where(eq(pages.slug, slug)).limit(1);
  if (!page) notFound();

  const rows = await db
    .select()
    .from(pageSections)
    .where(eq(pageSections.pageId, page.id))
    .orderBy(asc(pageSections.position), asc(pageSections.id));

  /**
   * The list is the layout draft, not the live page.
   *
   * Order, membership and intended visibility all come from
   * `getPageStructure` — the same reader the Visual Editor draws Layers from —
   * so the two screens describe one page. The rows are still read here for the
   * things structure does not know: whether a section has unpublished content,
   * and the words to summarise it by.
   */
  const layout = await getPageStructure(page.id);
  if (!layout) notFound();
  const byId = new Map(rows.map((row) => [row.id, row]));

  const toRow = (sectionId: number, layoutVisible: boolean | null): SectionRow | null => {
    const row = byId.get(sectionId);
    if (!row) return null;
    const block = getBlock(row.blockType);
    const values = (row.draft ?? row.published) as Record<string, unknown>;
    // A one-line summary so the list is scannable without opening each section.
    const summary =
      text(values, "title", "en") ||
      text(values, "headline", "en") ||
      text(values, "eyebrow", "en") ||
      "";
    return {
      id: row.id,
      blockType: row.blockType,
      blockName: block?.name ?? row.blockType,
      blockDescription: block?.description ?? "",
      summary,
      publishedVisible: row.isPublished,
      layoutVisible,
      isDraftOnly: row.isDraftOnly,
      draftKind: draftKindOf(row),
    };
  };

  const sections = layout.structure.sections
    .map((entry) => toRow(entry.sectionId, entry.visible))
    .filter((row): row is SectionRow => row !== null);
  const removed = removedSections(layout)
    .map((section) => toRow(section.sectionId, null))
    .filter((row): row is SectionRow => row !== null);

  // Only established sections can have their content published on its own, so
  // only they arm Publish all — see `publishAllDrafts`.
  const draftCount = sections.filter(
    (section) => !section.isDraftOnly && hasDraft(section.draftKind),
  ).length;
  const livePath = page.slug === "home" ? "/" : `/${page.slug}`;

  return (
    <>
      <AdminPageHeader
        title={page.titleEn}
        description={`The sections below are the page layout as it is being edited. ${page.isPublished ? "" : "This page is currently unpublished."}`}
        crumbs={[{ label: "Pages & sections", href: "/admin/pages" }, { label: page.titleEn }]}
        actions={
          <>
            {canManage ? (
              <PublishAllButton csrf={session.csrfToken} pageId={page.id} count={draftCount} />
            ) : null}
            <Link href={`/admin/pages/${page.slug}/preview`} className="admin-btn">
              <Icon name="search" size={13} />
              Preview
            </Link>
            <Link href={livePath} target="_blank" rel="noopener" className="admin-btn">
              <Icon name="arrowUpRight" size={13} />
              View live
            </Link>
          </>
        }
      />

      <div className="grid gap-5 xl:grid-cols-[1.5fr_1fr] xl:items-start">
        <SectionList
          csrf={session.csrfToken}
          pageId={page.id}
          pageRevision={layout.revision}
          hasLayoutDraft={layout.hasDraftStructure}
          sections={sections}
          removed={removed}
          blocks={blocksForPage(page.slug)}
          canManage={canManage}
        />

        {canManage ? (
          <div className="space-y-5">
            <PageSettingsForm csrf={session.csrfToken} page={page} />
            {page.kind === "custom" ? (
              <DeletePageForm csrf={session.csrfToken} id={page.id} title={page.titleEn} />
            ) : null}
          </div>
        ) : null}
      </div>
    </>
  );
}
