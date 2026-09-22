import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq } from "drizzle-orm";

import { AdminPageHeader } from "@/components/admin/page-header";
import { Icon } from "@/components/ui/icon";
import { requirePermission } from "@/lib/auth/guard";
import { blocksForPage, getBlock } from "@/lib/cms/blocks";
import { text } from "@/lib/cms/values";
import { draftKindOf } from "@/lib/cms/drafts";
import { getPageDraftSummary } from "@/lib/cms/publish-service";
import { KEEP_PAGE_VERSIONS, listPageVersions } from "@/lib/versions";
import { getPageStructure } from "@/lib/cms/structure-service";
import { removedSections } from "@/lib/cms/structure";
import { db } from "@/lib/db";
import { pageSections, pages } from "@/lib/db/schema";
import { DeletePageForm, PageSettingsForm } from "../page-forms";
import { PageChanges } from "./page-changes";
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

  /**
   * What the *page* has waiting, read from the database rather than counted
   * off the rows above.
   *
   * The old count was of established sections with a content or style draft,
   * which is what the old button could publish — and it was therefore blind to
   * exactly the changes an editor was most likely to have made in the Visual
   * Editor. The summary knows about the layout too.
   */
  const summary = await getPageDraftSummary(page.id);
  const versions = await listPageVersions(page.id, KEEP_PAGE_VERSIONS);
  const history = {
    pageId: page.id,
    keep: KEEP_PAGE_VERSIONS,
    versions: versions.map((row) => ({
      id: row.id,
      label: row.label,
      actorName: row.actorName,
      createdAt: row.createdAt.toISOString(),
    })),
  };
  const livePath = page.slug === "home" ? "/" : `/${page.slug}`;

  return (
    <>
      <AdminPageHeader
        title={page.titleEn}
        description={`The sections below are the page layout as it is being edited. ${page.isPublished ? "" : "This page is currently unpublished."}`}
        crumbs={[{ label: "Pages & sections", href: "/admin/pages" }, { label: page.titleEn }]}
        actions={
          <>
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

        <div className="space-y-5">
          {/*
            Visible to anybody who can view the page: what is waiting, and what
            has been published before. The controls inside are `canManage`'s.
            Page Settings below stays an editor's screen.
          */}
          {summary ? (
            <PageChanges
              csrf={session.csrfToken}
              pageId={page.id}
              summary={summary}
              history={history}
              canManage={canManage}
            />
          ) : null}
          {canManage ? (
            <>
              <PageSettingsForm csrf={session.csrfToken} page={page} />
              {page.kind === "custom" ? (
                <DeletePageForm csrf={session.csrfToken} id={page.id} title={page.titleEn} />
              ) : null}
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}
