import { asc } from "drizzle-orm";

import { VisualEditorShell, type EditablePage } from "@/components/admin/visual-editor/shell";
import { requirePermission } from "@/lib/auth/guard";
import { blocksForPage, type BlockDef } from "@/lib/cms/blocks";
import { db } from "@/lib/db";
import { media, pages } from "@/lib/db/schema";
import { localeOrDefault, publicPathForPage } from "@/lib/page-path";
import { deviceOrDefault } from "@/lib/visual-editor/viewport";

export const metadata = { title: "Visual Editor" };
export const dynamic = "force-dynamic";

/**
 * The Visual Editor lives outside the ordinary admin shell on purpose.
 *
 * It still inherits `admin/layout.tsx`, so it is the same LTR, English,
 * never-indexed back office wearing the same styles — but it is not inside
 * `(shell)`, which means it does not carry the 256px sidebar and the signed-in
 * header. An editor needs that room: the finished editor is a left panel, a
 * canvas and an inspector, and the canvas has to be wide enough to show a
 * 1440px page.
 *
 * The cost of stepping outside `(shell)` is that its session check does not
 * apply, so this route performs its own. `content.view` for now — the same key
 * the Pages screen and the preview already use. Visual-editor-specific
 * permissions are a later batch's job, and inventing one here would mean
 * shipping a permission nothing yet enforces.
 */
export default async function VisualEditorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePermission("content.view", "/admin/visual-editor");
  const query = await searchParams;

  // Every page the section CMS renders, in the order the Pages screen uses.
  // Read from the table rather than listed here, so a page an admin creates is
  // editable the moment it exists.
  const rows = await db
    .select({
      id: pages.id,
      slug: pages.slug,
      titleEn: pages.titleEn,
      isPublished: pages.isPublished,
    })
    .from(pages)
    .orderBy(asc(pages.kind), asc(pages.sortOrder), asc(pages.id));

  /**
   * The media library, once, for every image control in the inspector.
   *
   * The same query the ordinary section editor runs, and the same picker on the
   * other end: the Visual Editor chooses from the library, it does not upload.
   * One image store means one validator, one place a picture can be deleted
   * from, and one honest answer to where a picture is used.
   */
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

  const editable: EditablePage[] = rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.titleEn,
    path: publicPathForPage(row.slug),
    isPublished: row.isPublished,
  }));

  // The address can say anything. The canvas URL is always built from a row we
  // found, never from the query string, so no value here can become an iframe
  // src of its own devising.
  const asked = typeof query.page === "string" ? query.page : "";
  const chosen = editable.find((row) => row.slug === asked) ?? editable[0];

  /**
   * What each page may have added to it, from the one registry the ordinary
   * admin form is generated from — deprecated types are already absent from it.
   * Computed per page rather than once, because a block's scope decides where
   * it is allowed, and the picker must not offer a home-only block on About.
   */
  const blocks: Record<string, BlockDef[]> = Object.fromEntries(
    rows.map((row) => [row.slug, blocksForPage(row.slug)]),
  );

  return (
    <VisualEditorShell
      pages={editable}
      initial={{
        slug: chosen?.slug ?? "home",
        locale: localeOrDefault(query.lang),
        device: deviceOrDefault(query.device),
      }}
      canManage={session.permissions.has("content.manage")}
      csrf={session.csrfToken}
      blocks={blocks}
      media={library}
    />
  );
}
