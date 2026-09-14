import { asc } from "drizzle-orm";

import { VisualEditorShell, type EditablePage } from "@/components/admin/visual-editor/shell";
import { requirePermission } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
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

  return (
    <VisualEditorShell
      pages={editable}
      initial={{
        slug: chosen?.slug ?? "home",
        locale: localeOrDefault(query.lang),
        device: deviceOrDefault(query.device),
      }}
      canManage={session.permissions.has("content.manage")}
    />
  );
}
