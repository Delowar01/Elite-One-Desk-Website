"use client";

import { useState } from "react";

import { Icon } from "@/components/ui/icon";
import type { Locale } from "@/lib/i18n/config";
import { localeHref } from "@/lib/i18n/config";
import { UNDO_SCOPE_NOTE } from "@/lib/visual-editor/history";
import type { RouteCompareView, RouteHistoryView, RouteSummaryView } from "@/lib/routes/views";

/**
 * A dynamic route's own drawer (Batch 21): what is waiting on the page, the
 * fields that block it, publishing it, throwing the drafts away, and its
 * publications — compared field by field and restored to a draft.
 *
 * The page drawer's twin, and drawn from the server's summary for the same
 * reason: the buffers are the one participant allowed to be out of date, so a
 * confirmation built from them would promise to publish whatever this tab
 * happens to know about rather than what the page actually holds. The summary
 * also carries the token Publish and Discard send back, so what is acted on is
 * exactly what was shown here.
 */
export function RoutePanel({
  open,
  onClose,
  locale,
  summary,
  history,
  canPublish: mayPublish,
  busy,
  blockedReason,
  message,
  error,
  errorDetails,
  onPublish,
  onDiscard,
  onRestore,
  onCompare,
  onRefresh,
}: {
  open: boolean;
  onClose: () => void;
  locale: Locale;
  summary: RouteSummaryView | null;
  history: RouteHistoryView | null;
  /** `content.publish` — the server also asks for the records' own capabilities. */
  canPublish: boolean;
  busy: boolean;
  blockedReason: string | null;
  message: string | null;
  error: string | null;
  errorDetails: string[];
  onPublish: () => void;
  onDiscard: () => void;
  onRestore: (versionId: number) => void;
  onCompare: (versionId: number, against: "previous" | "live") => Promise<RouteCompareView | null>;
  onRefresh: () => void;
}) {
  const [compare, setCompare] = useState<RouteCompareView | null>(null);
  const [comparing, setComparing] = useState<number | null>(null);
  if (!open) return null;

  const pending = summary?.owners ?? [];
  const publishable = Boolean(mayPublish && summary?.publishable && !blockedReason && !busy);
  const discardable = Boolean(mayPublish && summary?.discardable && !blockedReason && !busy);
  const restoreBlocked =
    blockedReason ??
    (summary?.discardable ? "Publish or discard the current changes before restoring a version." : null);

  const show = async (versionId: number, against: "previous" | "live") => {
    setComparing(versionId);
    const view = await onCompare(versionId, against);
    setComparing(null);
    setCompare(view);
  };

  return (
    <aside
      className="absolute inset-y-0 end-0 z-20 flex w-[24rem] flex-col border-s border-[var(--admin-line)] bg-[var(--admin-shell)] shadow-2xl"
      aria-label="Page changes and history"
      data-route-panel
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--admin-line)] px-3.5 py-2.5">
        <h2 className="flex-1 truncate text-[0.82rem] font-semibold text-strong">{summary?.title ?? "Service category"}</h2>
        <button
          type="button"
          onClick={onRefresh}
          className="admin-btn admin-btn-sm"
          disabled={busy}
          aria-label="Refresh changes and history"
          title="Refresh changes and history"
        >
          <Icon name="refresh" size={12} />
        </button>
        <button type="button" onClick={onClose} className="admin-btn admin-btn-sm" aria-label="Close">
          <Icon name="close" size={12} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        <section aria-label="Saved changes" className="flex flex-col gap-2.5">
          <h3 className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted">Saved changes</h3>

          {!summary ? (
            <p className="text-[0.76rem] text-muted">Reading this page&hellip;</p>
          ) : pending.length ? (
            <ul className="admin-card flex flex-col gap-2 p-3 text-[0.76rem] leading-relaxed text-body" data-route-pending>
              {pending.map((owner) => (
                <li key={owner.ownerKey} data-route-pending-owner={owner.ownerKey}>
                  <p className="font-medium text-strong">{owner.label}</p>
                  <p className="text-muted">
                    {[...owner.fields, owner.style ? "Style" : null, owner.motion ? "Motion" : null]
                      .filter(Boolean)
                      .join(", ")}
                  </p>
                  {owner.conflicts.length ? (
                    <p className="mt-0.5" style={{ color: "#ef8f8a" }} data-route-conflict>
                      Changed outside the Visual Editor: {owner.conflicts.join(", ")}. Select it to resolve.
                    </p>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[0.76rem] leading-relaxed text-muted">No saved changes. This page is the same as the live one.</p>
          )}

          {summary && summary.conflicts ? (
            <p className="text-[0.73rem] leading-relaxed" style={{ color: "var(--color-peach)" }} role="status">
              Publishing is blocked until every field changed outside the Visual Editor is resolved — keep your draft
              or use the live value, in the Inspector.
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
            <div role="alert">
              <p className="text-[0.76rem] leading-relaxed" style={{ color: "#ef8f8a" }}>
                {error}
              </p>
              {errorDetails.length ? (
                <ul className="mt-1 list-disc ps-5 text-[0.72rem] leading-relaxed" style={{ color: "#ef8f8a" }}>
                  {errorDetails.map((line) => (
                    <li key={line}>{line}</li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}

          {mayPublish ? (
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={onPublish}
                disabled={!publishable}
                className="admin-btn admin-btn-sm admin-btn-primary"
                data-route-publish
              >
                <Icon name="check" size={12} />
                {busy ? "Working…" : "Publish saved changes"}
              </button>
              <button type="button" onClick={onDiscard} disabled={!discardable} className="admin-btn admin-btn-sm" data-route-discard>
                Discard all saved changes
              </button>
            </div>
          ) : (
            <p className="text-[0.73rem] leading-relaxed text-muted" role="note" data-permission-note="content.publish">
              You can review what is waiting, but your role does not allow publishing, discarding or restoring this page.
            </p>
          )}

          <p className="text-[0.7rem] leading-relaxed text-muted">
            Publishing changes what visitors see on this category page and writes the category, its groups, services and
            questions in one step. The Service Categories, Services and FAQs screens keep working as before.
          </p>
          {summary ? (
            <a
              href={`${localeHref(locale, summary.path)}?compare=published`}
              target="_blank"
              rel="noopener"
              className="admin-btn admin-btn-sm w-fit"
            >
              <Icon name="arrowUpRight" size={12} />
              Open the live page as published
            </a>
          ) : null}
        </section>

        <section aria-label="Version history" className="mt-5 flex flex-col gap-2.5" data-route-history>
          <h3 className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted">Version history</h3>
          <p className="text-[0.72rem] leading-relaxed text-muted" data-undo-scope>
            {UNDO_SCOPE_NOTE}
          </p>
          {!history ? (
            <p className="text-[0.76rem] text-muted">Reading history&hellip;</p>
          ) : !history.versions.length ? (
            <p className="text-[0.76rem] leading-relaxed text-muted">
              No publications from the Visual Editor yet. The first one also records the page as it was before it.
            </p>
          ) : (
            <ol className="flex flex-col gap-2">
              {history.versions.map((version) => (
                <li key={version.id} className="admin-card p-2.5" data-route-version={version.id}>
                  <p className="text-[0.76rem] font-medium text-strong">
                    {version.kind === "baseline" ? "Before the first Visual Editor publication" : version.summary}
                  </p>
                  <p className="text-[0.68rem] text-muted">
                    {version.actorName} · {new Date(version.createdAt).toLocaleString()}
                  </p>
                  {version.resources.length ? (
                    <p className="mt-0.5 text-[0.68rem] text-muted">{version.resources.join(", ")}</p>
                  ) : null}
                  <div className="mt-1.5 flex flex-wrap gap-1">
                    {version.kind === "publish" ? (
                      <button
                        type="button"
                        className="admin-btn admin-btn-sm"
                        disabled={comparing !== null}
                        onClick={() => void show(version.id, "previous")}
                      >
                        What changed
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="admin-btn admin-btn-sm"
                      disabled={comparing !== null}
                      onClick={() => void show(version.id, "live")}
                    >
                      Compare with live
                    </button>
                    {summary ? (
                      <a
                        href={`${localeHref(locale, summary.path)}?compare=v${version.id}`}
                        target="_blank"
                        rel="noopener"
                        className="admin-btn admin-btn-sm"
                      >
                        <Icon name="arrowUpRight" size={11} />
                        View
                      </a>
                    ) : null}
                    {mayPublish ? (
                      <button
                        type="button"
                        className="admin-btn admin-btn-sm"
                        disabled={busy || Boolean(restoreBlocked)}
                        title={restoreBlocked ?? "Bring this version back as a draft. The live page does not change."}
                        onClick={() => {
                          if (window.confirm("Restore this version as a draft? The live page does not change until you publish.")) {
                            onRestore(version.id);
                          }
                        }}
                        data-route-restore={version.id}
                      >
                        Restore to draft
                      </button>
                    ) : null}
                  </div>
                </li>
              ))}
            </ol>
          )}
          {restoreBlocked && history?.versions.length ? (
            <p className="text-[0.7rem] leading-relaxed text-muted">{restoreBlocked}</p>
          ) : null}
          <p className="text-[0.7rem] text-muted">The newest {history?.keep ?? 30} publications are kept.</p>

          {compare ? (
            <div className="admin-card p-3" data-route-compare={compare.versionId}>
              <div className="mb-1.5 flex items-center justify-between gap-2">
                <p className="text-[0.74rem] font-semibold text-strong">
                  {compare.against === "live" ? "This version compared with the live page" : "What this publication changed"}
                </p>
                <button type="button" onClick={() => setCompare(null)} className="admin-btn admin-btn-sm" aria-label="Close comparison">
                  <Icon name="close" size={10} />
                </button>
              </div>
              {compare.changes.length ? (
                <table className="w-full text-[0.7rem]">
                  <thead>
                    <tr className="text-start text-muted">
                      <th className="pe-2 text-start font-medium">Where</th>
                      <th className="pe-2 text-start font-medium">{compare.against === "live" ? "Version" : "Before"}</th>
                      <th className="text-start font-medium">{compare.against === "live" ? "Live" : "After"}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {compare.changes.map((change, index) => (
                      <tr key={`${change.owner}-${change.field}-${index}`} className="align-top">
                        <td className="pe-2 pt-1 text-body">
                          {change.owner}
                          <span className="block text-muted">{change.field}</span>
                        </td>
                        <td className="pe-2 pt-1 text-muted">{change.before || "—"}</td>
                        <td className="pt-1 text-body">{change.after || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="text-[0.72rem] text-muted">No differences.</p>
              )}
            </div>
          ) : null}
        </section>
      </div>
    </aside>
  );
}
