"use client";

import { Icon } from "@/components/ui/icon";
import type { PageHistoryView } from "@/lib/visual-editor/publish";

/**
 * A page's published restore points, in both places that show them.
 *
 * One component, because the Visual Editor and the Pages screen must not come
 * to describe history differently — and because the wording here is doing real
 * work. Two things it has to get right and neither is decoration:
 *
 * **Current live is not a row.** The page as it stands has no `page_versions`
 * entry; it is simply the page. Drawing it as a history item would invite
 * "restore" on it, which means nothing, and would make the newest stored row
 * look like the current state when it is the state *before* the last publish.
 * So it is a header, visibly outside the list.
 *
 * **Restore is to drafts.** Every label says so, and the confirmation says what
 * will and will not change. A history panel whose button said "Restore" would
 * be read as "put the site back", and an editor would press it expecting the
 * live page to move.
 */
export const RESTORE_CONFIRM =
  "This creates saved page drafts from the selected published version. The live site will not " +
  "change until you publish the restored changes.";

const when = (iso: string): string => {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString(undefined, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

export function PageHistory({
  history,
  canManage,
  busy,
  blocked,
  onRestore,
}: {
  history: PageHistoryView | null;
  canManage: boolean;
  busy: boolean;
  /**
   * Why restoring is unavailable right now, or null.
   *
   * Shown once at the top rather than on every row: the reason is about the
   * page, not about any particular version, and repeating it fourteen times
   * would bury the list it is explaining.
   */
  blocked: string | null;
  onRestore: (versionId: number) => void;
}) {
  if (!history) {
    return <p className="text-[0.76rem] text-muted">This page&rsquo;s history could not be read.</p>;
  }

  return (
    <div className="flex flex-col gap-2.5">
      <div className="admin-card p-3">
        <p className="text-[0.78rem] font-semibold text-strong">Current live</p>
        <p className="mt-0.5 text-[0.72rem] leading-relaxed text-muted">
          What visitors see now. Publishing saved changes adds a restore point for this state.
        </p>
      </div>

      {blocked ? (
        <p
          className="admin-card p-3 text-[0.73rem] leading-relaxed"
          style={{ color: "var(--color-peach)" }}
          role="status"
        >
          {blocked}
        </p>
      ) : null}

      {!history.versions.length ? (
        <p className="text-[0.76rem] leading-relaxed text-muted">
          No restore points yet. One is saved automatically each time this page&rsquo;s changes are
          published.
        </p>
      ) : (
        <ol className="flex flex-col gap-1.5">
          {history.versions.map((version) => (
            <li key={version.id} className="admin-card p-3">
              <p className="text-[0.78rem] font-medium leading-snug text-strong">
                {version.label || "Before publishing"}
              </p>
              <p className="mt-0.5 text-[0.7rem] text-muted">
                {when(version.createdAt)} · {version.actorName}
              </p>
              {canManage ? (
                <button
                  type="button"
                  disabled={busy || Boolean(blocked)}
                  onClick={() => {
                    if (!window.confirm(RESTORE_CONFIRM)) return;
                    onRestore(version.id);
                  }}
                  className="admin-btn admin-btn-sm mt-2"
                >
                  <Icon name="refresh" size={12} />
                  Restore to draft
                </button>
              ) : null}
            </li>
          ))}
        </ol>
      )}

      <p className="text-[0.7rem] leading-relaxed text-muted">
        The last {history.keep} published states are kept.
      </p>
    </div>
  );
}
