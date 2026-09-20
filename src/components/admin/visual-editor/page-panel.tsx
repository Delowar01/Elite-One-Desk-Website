"use client";

import { PageHistory } from "@/components/admin/page-history";
import { Icon } from "@/components/ui/icon";
import {
  describePending,
  describeRemoval,
  type PageHistoryView,
  type PageSummaryView,
} from "@/lib/visual-editor/publish";

/**
 * The page's own drawer: what is waiting, publishing it, throwing it away, and
 * putting a published version back.
 *
 * A drawer rather than a fourth Inspector tab, and that is the whole reason it
 * is a separate component. The Inspector acts on the selected node; every one
 * of these acts on the page. A History tab beside Content, Style and Motion
 * would read as "this section's history", which it is not — there is no such
 * thing here, because a restore point is a page's composition.
 *
 * Everything it shows comes from the server's summary. The editor knows what is
 * in its own buffers, but the buffers are the one participant allowed to be out
 * of date, and a confirmation built from them would promise to publish whatever
 * this tab happens to know about rather than what the page actually has.
 */
export function PagePanel({
  open,
  onClose,
  title,
  summary,
  history,
  canManage,
  busy,
  blockedReason,
  message,
  error,
  onPublish,
  onDiscard,
  onRestore,
  onRefresh,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  summary: PageSummaryView | null;
  history: PageHistoryView | null;
  canManage: boolean;
  busy: boolean;
  /** Why publishing cannot start right now — local work, not server state. */
  blockedReason: string | null;
  message: string | null;
  error: string | null;
  onPublish: () => void;
  onDiscard: () => void;
  onRestore: (versionId: number) => void;
  onRefresh: () => void;
}) {
  if (!open) return null;

  const pending = summary ? describePending(summary) : [];
  const removal = summary ? describeRemoval(summary) : null;
  const canPublish = Boolean(canManage && summary?.publishable && !blockedReason && !busy);
  const canDiscard = Boolean(canManage && summary?.discardable && !blockedReason && !busy);

  return (
    <aside
      className="absolute inset-y-0 end-0 z-20 flex w-[23rem] flex-col border-s border-[var(--admin-line)] bg-[var(--admin-shell)] shadow-2xl"
      aria-label="Page changes and history"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--admin-line)] px-3.5 py-2.5">
        <h2 className="flex-1 truncate text-[0.82rem] font-semibold text-strong">{title}</h2>
        <button type="button" onClick={onRefresh} className="admin-btn admin-btn-sm" disabled={busy}>
          <Icon name="refresh" size={12} />
        </button>
        <button type="button" onClick={onClose} className="admin-btn admin-btn-sm" aria-label="Close">
          <Icon name="close" size={12} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        <section aria-label="Saved changes" className="flex flex-col gap-2.5">
          <h3 className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted">
            Saved changes
          </h3>

          {!summary ? (
            <p className="text-[0.76rem] text-muted">Reading this page&hellip;</p>
          ) : summary.layoutCorrupt ? (
            <p className="admin-card p-3 text-[0.75rem] leading-relaxed" style={{ color: "#ef8f8a" }}>
              The saved layout for this page could not be read, so it cannot be published. Discard
              the saved changes and arrange the page again.
            </p>
          ) : pending.length ? (
            <ul className="admin-card flex list-disc flex-col gap-1 p-3 ps-7 text-[0.76rem] leading-relaxed text-body">
              {pending.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          ) : (
            <p className="text-[0.76rem] leading-relaxed text-muted">
              No saved changes. This page is the same as the live one.
            </p>
          )}

          {removal ? (
            <p className="text-[0.73rem] leading-relaxed" style={{ color: "var(--color-peach)" }}>
              {removal}
            </p>
          ) : null}

          {blockedReason ? (
            <p className="text-[0.73rem] leading-relaxed text-muted" role="status">
              {blockedReason}
            </p>
          ) : null}

          {message ? (
            <p className="text-[0.76rem] leading-relaxed" style={{ color: "#5ad19a" }} role="status">
              {message}
            </p>
          ) : null}
          {error ? (
            <p className="text-[0.76rem] leading-relaxed" style={{ color: "#ef8f8a" }} role="alert">
              {error}
            </p>
          ) : null}

          {canManage ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onPublish}
                disabled={!canPublish}
                className="admin-btn admin-btn-sm admin-btn-primary"
              >
                <Icon name="check" size={12} />
                {busy ? "Working…" : "Publish saved changes"}
              </button>
              <button
                type="button"
                onClick={onDiscard}
                disabled={!canDiscard}
                className="admin-btn admin-btn-sm"
              >
                Discard all saved changes
              </button>
            </div>
          ) : null}

          <p className="text-[0.7rem] leading-relaxed text-muted">
            Publishing changes what visitors see. It does not change whether this page is part of
            the site &mdash; that is a page setting.
          </p>
        </section>

        <section aria-label="Version history" className="mt-5 flex flex-col gap-2.5">
          <h3 className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted">
            Version history
          </h3>
          <PageHistory
            history={history}
            canManage={canManage}
            busy={busy}
            blocked={
              blockedReason ??
              (summary && summary.discardable
                ? "Publish or discard the current saved changes before restoring a historical version."
                : null)
            }
            onRestore={onRestore}
          />
        </section>
      </div>
    </aside>
  );
}
