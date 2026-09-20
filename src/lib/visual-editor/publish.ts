import type { PageDraftSummary } from "@/lib/cms/publish-service";

/**
 * How many restore points a page keeps.
 *
 * Here rather than beside the writer because the panel that draws the list
 * states the ceiling, and a client component cannot import a `server-only`
 * module to find out what it is. One constant, read by the pruner and by the
 * sentence that explains it.
 */
export const KEEP_PAGE_VERSIONS = 30;

/**
 * What the two publishing surfaces send to a browser.
 *
 * Client-safe by construction: plain data, no `server-only` import, no
 * database row. Both the Visual Editor's toolbar and the Pages screen draw
 * from these, so the two cannot come to describe the same page differently —
 * and neither of them computes the counts itself, because the only honest
 * source for "what is waiting on this page" is the database.
 */
export type PageSummaryView = PageDraftSummary;

/**
 * One restore point, as a list needs it.
 *
 * Deliberately without the snapshot. A history list is a list of labels and
 * timestamps; shipping a full composition per row to draw it would send a
 * page's entire published content to the browser several times over, for a
 * panel that mostly gets glanced at. The snapshot stays on the server until
 * somebody actually restores.
 */
export type PageVersionView = {
  id: number;
  label: string;
  actorName: string;
  /** ISO 8601, because a Date does not survive the Server Action boundary. */
  createdAt: string;
};

export type PageHistoryView = {
  pageId: number;
  versions: PageVersionView[];
  /** The ceiling, so the panel can say what it is rather than imply none. */
  keep: number;
};

/** What a page-level action answers with. */
export type PageActionResult =
  | { ok: true; revision: number; message: string }
  | { ok: false; reason: string; message: string };

/**
 * A sentence for what a page has waiting, from the authoritative summary.
 *
 * One phrasing, shared, so the review dialog and the toolbar cannot disagree
 * about what is about to happen. Counts are of the things that will actually
 * change: a draft on a section the layout removes is not listed, because
 * publishing will not promote it — the row is going.
 */
export function describePending(summary: PageSummaryView): string[] {
  const parts: string[] = [];
  const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;
  if (summary.contentDrafts) parts.push(plural(summary.contentDrafts, "content draft"));
  if (summary.styleDrafts) parts.push(plural(summary.styleDrafts, "style draft"));
  if (summary.motionDrafts) parts.push(plural(summary.motionDrafts, "motion draft"));
  if (summary.layoutChanged) parts.push("layout changed");
  if (summary.added) parts.push(`${summary.added} new section${summary.added === 1 ? "" : "s"}`);
  if (summary.removed) {
    parts.push(`${summary.removed} section${summary.removed === 1 ? "" : "s"} removed`);
  }
  if (summary.visibilityChanges) {
    parts.push(`${summary.visibilityChanges} visibility change${summary.visibilityChanges === 1 ? "" : "s"}`);
  }
  return parts;
}

/**
 * The warning a removal deserves, or nothing.
 *
 * Publishing a layout that omits a section deletes the row, which is the one
 * thing in this flow that cannot be undone by pressing the other button — so
 * it is said plainly, together with where the section went.
 */
export function describeRemoval(summary: PageSummaryView): string | null {
  if (!summary.removed) return null;
  const n = summary.removed;
  return (
    `Publishing this layout removes ${n} section${n === 1 ? "" : "s"} from the page. ` +
    `Their last published state is kept in version history.`
  );
}
