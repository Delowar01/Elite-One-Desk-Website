import { asc } from "drizzle-orm";

import { VisualEditorShell, type EditablePage } from "@/components/admin/visual-editor/shell";
import { AUTHORITY, capabilitiesOf } from "@/lib/auth/authority";
import { requirePermissions } from "@/lib/auth/guard";
import { blocksForPage, type BlockDef } from "@/lib/cms/blocks";
import { db } from "@/lib/db";
import { media, pages } from "@/lib/db/schema";
import { localeOrDefault, publicPathForPage } from "@/lib/page-path";
import { listCategoryDocuments } from "@/lib/routes/category";
import { documentEditorKey, parseRouteKey, routeKeyOf, SINGLETON_ID, type RouteDocument } from "@/lib/routes/owners";
import { CATALOGUE_PATH, listDestinationDocuments, listPackageDocuments } from "@/lib/routes/packages";
import { listServiceDocuments } from "@/lib/routes/service";
import { SERVICE_INDEX_PATH } from "@/lib/routes/service-index-model";
import { globalsCapabilities } from "@/lib/visual-editor/globals";
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
 * apply, so this route performs its own — and it asks for **both** keys.
 *
 * `visual_editor.view` is the editor's own door, so a role can keep ordinary
 * Pages access while this screen is switched off for it. `content.view` is
 * still required beside it, because the canvas renders the page's *drafts*:
 * letting somebody in on the strength of an editor permission alone would show
 * unpublished content to an account that is not allowed to see it on any other
 * screen. The sidebar entry names the same pair, so the link and the route
 * cannot disagree.
 *
 * What may be *changed* stays resource-specific and is passed down as separate
 * capabilities: one per page domain from `lib/auth/authority.ts` (Batch 18 —
 * content, standard and advanced style, motion, layout, publishing and the
 * reusable-component four), `navigation.manage` for the menus and
 * `settings.manage` for the site's settings and social links. One
 * editor-wide "may edit" boolean would have granted all of them at once.
 */
export default async function VisualEditorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePermissions(AUTHORITY.openEditor, "/admin/visual-editor");
  const capabilities = globalsCapabilities(session);
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
    kind: "page",
  }));

  /**
   * The two overviews, `/services` and `/packages` (Batch 24): one each, so
   * their documents are fixed — but drawn at their real addresses like every
   * other document, never from the query string.
   */
  const overview = (document: RouteDocument, title: string, path: string) =>
    editable.push({
      id: documentEditorKey(document),
      slug: routeKeyOf(document),
      title,
      path,
      isPublished: true,
      kind: document.kind,
    });
  overview({ kind: "serviceIndex", id: SINGLETON_ID }, "Services overview", SERVICE_INDEX_PATH);
  overview({ kind: "packageIndex", id: SINGLETON_ID }, "Tour packages", CATALOGUE_PATH);

  /**
   * Every service category, as a document of its own (Batch 21). Read from the
   * table like the pages are, so a category created tomorrow is in this list
   * the moment it exists — named by its own title, opened by its id, and
   * drawn at its real public address. No category is named in code.
   */
  const categories = await listCategoryDocuments();
  for (const row of categories) {
    const document = { kind: "category" as const, id: row.id };
    editable.push({
      id: documentEditorKey(document),
      slug: routeKeyOf(document),
      title: row.titleEn,
      path: `/services/${row.slug}`,
      isPublished: row.isPublished,
      kind: "category",
    });
  }

  /**
   * Every service's own page, as a document of its own (Batch 22), grouped
   * under its category. Read from the table like the categories are, so a
   * service created tomorrow — in any category — is in this list the moment
   * it exists, opened by its id and drawn at its real public address. A
   * service moved to another category is listed under the new one, at the new
   * address, as the same document. No service is named in code.
   */
  const services = await listServiceDocuments();
  for (const row of services) {
    const document = { kind: "service" as const, id: row.id };
    editable.push({
      id: documentEditorKey(document),
      slug: routeKeyOf(document),
      title: row.titleEn,
      path: `/services/${row.categorySlug}/${row.slug}`,
      // A visitor reaches it only while the service and its category are both published.
      isPublished: row.isPublished && row.categoryPublished,
      kind: "service",
      group: row.categoryTitle,
    });
  }

  /**
   * Every destination's page and every package's page, as documents of their
   * own (Batch 24), each package listed under the destination it is filed
   * under. Read from the tables like the services are, so a package created
   * tomorrow — or a destination — is in this list the moment it exists, opened
   * by its id and drawn at its real public address. Nothing is named in code.
   */
  for (const row of await listDestinationDocuments()) {
    const document = { kind: "destination" as const, id: row.id };
    editable.push({
      id: documentEditorKey(document),
      slug: routeKeyOf(document),
      title: row.titleEn,
      path: `/packages/${row.slug}`,
      isPublished: row.isPublished,
      kind: "destination",
    });
  }
  for (const row of await listPackageDocuments()) {
    const document = { kind: "package" as const, id: row.id };
    editable.push({
      id: documentEditorKey(document),
      slug: routeKeyOf(document),
      title: row.titleEn,
      path: `/packages/${row.slug}`,
      isPublished: row.isPublished,
      kind: "package",
      group: row.destinationTitle ?? "No destination",
    });
  }

  // The address can say anything. The canvas URL is always built from a row we
  // found, never from the query string, so no value here can become an iframe
  // src of its own devising.
  const askedRoute = typeof query.route === "string" && parseRouteKey(query.route) ? query.route : "";
  const asked = askedRoute || (typeof query.page === "string" ? query.page : "");
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
      can={capabilitiesOf(session.permissions)}
      domains={{
        services: session.permissions.has("services.manage"),
        faqs: session.permissions.has("faqs.manage"),
        packages: session.permissions.has("packages.manage"),
      }}
      canManageNavigation={capabilities.canManageNavigation}
      canManageSettings={capabilities.canManageSettings}
      csrf={session.csrfToken}
      blocks={blocks}
      media={library}
    />
  );
}
