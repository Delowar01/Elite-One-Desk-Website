import { eq } from "drizzle-orm";

import { CompareView, type CompareState } from "@/components/admin/compare-view";
import { may } from "@/lib/auth/authority";
import { requirePermissions } from "@/lib/auth/guard";
import { getPageDraftSummary, RESTORE_BLOCKED, restoreBlockers } from "@/lib/cms/publish-service";
import { validatePageSnapshot, type PageSnapshot } from "@/lib/cms/snapshot";
import { loadComponentSources } from "@/lib/cms/reuse/store";
import { db } from "@/lib/db";
import { pages } from "@/lib/db/schema";
import { localeOrDefault } from "@/lib/page-path";
import {
  capturePageSnapshot,
  KEEP_PAGE_VERSIONS,
  listPageVersions,
  readPageVersionStrict,
} from "@/lib/versions";
import { diffSnapshots, dynamicSourcesOf, hasReuse, reusedIds } from "@/lib/visual-editor/compare";
import { deviceOrDefault } from "@/lib/visual-editor/viewport";

export const metadata = { title: "Compare versions" };
export const dynamic = "force-dynamic";

/**
 * Version Compare (Batch 16): two states of one page, side by side, and what
 * differs between them — without restoring anything.
 *
 * Outside `(shell)`, like the Visual Editor, for the room: two website panes
 * and a list of changes need the whole width. It still inherits the admin
 * root layout, so it is the same never-indexed back office, and it performs
 * its own session check — `content.view`, the permission page history is
 * already read with on both screens that link here. No new permission.
 *
 * What it will compare, all checked here against the database rather than
 * trusted from the address:
 *
 *   · a version of **this** page — the version row's own `page_id` must be
 *     the page asked for, so no page's history can be read as another's;
 *   · against the **current published** page (the default), or against
 *     another version of the same page;
 *   · read **strictly**, so a snapshot this build cannot read is refused by
 *     name rather than shown as an empty page.
 *
 * It writes nothing. The two sides are read — the immutable version rows, and
 * the live rows for the published side — and compared in memory; the panes
 * are the real site asking for one state each (`lib/preview.ts`). No draft,
 * no revision, no restore point, no activity row. Restoring from here is the
 * ordinary restore action, with its ordinary rules.
 */
export default async function ComparePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requirePermissions({ all: ["content.view"] }, "/admin/compare");
  const query = await searchParams;
  const locale = localeOrDefault(query.lang);
  const device = deviceOrDefault(query.device);

  const idOf = (value: unknown): number | null => {
    const id = typeof value === "string" && /^[1-9][0-9]{0,9}$/.test(value) ? Number(value) : null;
    return id !== null && Number.isSafeInteger(id) ? id : null;
  };

  const refuse = (message: string) => <CompareView state={{ ok: false, message }} />;

  const pageId = idOf(query.page);
  if (pageId === null) return refuse("Choose a version from a page's history to compare it.");
  const [page] = await db
    .select({ id: pages.id, slug: pages.slug, titleEn: pages.titleEn })
    .from(pages)
    .where(eq(pages.id, pageId))
    .limit(1);
  if (!page) return refuse("That page no longer exists.");

  /** A version of this page, strictly read — or why not, in words. */
  const versionOf = async (value: unknown): Promise<{ id: number; snapshot: PageSnapshot } | string> => {
    const id = idOf(value);
    if (id === null) return "Choose a version from this page's history to compare it.";
    const read = await readPageVersionStrict(id);
    if (!read.ok) {
      return read.reason === "unsupported"
        ? "That version was saved by a different build and cannot be shown here."
        : "That version no longer exists.";
    }
    if (read.record.pageId !== page.id) return "That version belongs to a different page.";
    return { id: read.record.versionId, snapshot: read.record.snapshot };
  };

  const chosen = await versionOf(query.version);
  if (typeof chosen === "string") return refuse(chosen);

  const againstRaw = typeof query.against === "string" ? query.against : "published";
  const against = againstRaw === "published" ? "published" : await versionOf(againstRaw);
  if (typeof against === "string" && against !== "published") return refuse(against);
  if (typeof against === "object" && against.id === chosen.id) {
    return refuse("Choose a different version, or the current published page, to compare against.");
  }

  // The live page in the same shape as a version, read the same way — so the
  // comparison sees the published composition, never a draft, and a field the
  // sanitiser would normalise is normalised on both sides alike.
  const published = validatePageSnapshot(await capturePageSnapshot(page.id));

  // The older state on the left, the newer on the right: "added" always means
  // added since, whichever way round the two were asked for.
  const pair =
    against === "published"
      ? { left: chosen, right: null as null | { id: number; snapshot: PageSnapshot } }
      : against.id > chosen.id
        ? { left: chosen, right: against }
        : { left: against, right: chosen };

  const versions = await listPageVersions(page.id, KEEP_PAGE_VERSIONS);
  const describe = (id: number) => {
    const row = versions.find((version) => version.id === id);
    return {
      id,
      label: row?.label || "Before publishing",
      actorName: row?.actorName ?? "",
      createdAt: row ? row.createdAt.toISOString() : null,
    };
  };

  const rightSnapshot = pair.right ? pair.right.snapshot : published;
  const summary = await getPageDraftSummary(page.id);
  // Reusable components are reported by name (Batch 17) — read here, for the
  // components these two states link to and no others.
  const sources = await loadComponentSources(db, reusedIds(pair.left.snapshot, rightSnapshot));
  const names = new Map([...sources].map(([id, source]) => [id, source.name]));
  // Restoring is a page-wide act (Batch 18): `content.publish`, as in the page's own history.
  const canRestore = may(session.permissions, "publish");

  const state: CompareState = {
    ok: true,
    page: { id: page.id, slug: page.slug, title: page.titleEn },
    left: describe(pair.left.id),
    right: pair.right ? { kind: "version", ...describe(pair.right.id) } : { kind: "published" },
    chosenVersionId: chosen.id,
    versions: versions.map((row) => ({
      id: row.id,
      label: row.label || "Before publishing",
      actorName: row.actorName,
      createdAt: row.createdAt.toISOString(),
    })),
    diff: diffSnapshots(pair.left.snapshot, rightSnapshot, names),
    dynamic: dynamicSourcesOf(pair.left.snapshot, rightSnapshot),
    reuse: hasReuse(pair.left.snapshot, rightSnapshot),
    locale,
    device,
    restore: canRestore
      ? {
          csrf: session.csrfToken,
          blocked: !summary ? "That page no longer exists." : restoreBlockers(summary) ? RESTORE_BLOCKED : null,
        }
      : null,
  };
  return <CompareView state={state} />;
}
