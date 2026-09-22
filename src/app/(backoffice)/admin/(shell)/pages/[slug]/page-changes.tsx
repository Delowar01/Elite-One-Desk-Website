"use client";

import { useCallback, useState } from "react";

import { ConfirmSubmit, InlineAction } from "@/components/admin/form";
import { PageHistory, RESTORE_CONFIRM } from "@/components/admin/page-history";
import { Icon } from "@/components/ui/icon";
import type { ActionState } from "@/lib/admin/actions";
import {
  describePending,
  describeRemoval,
  type PageHistoryView,
  type PageSummaryView,
} from "@/lib/visual-editor/publish";

import { discardPageDrafts, publishPage, restorePageVersion } from "../actions";

/**
 * The page's saved changes, on the ordinary Pages screen.
 *
 * It exists because the layout half of a page's drafts used to be trapped: an
 * editor could reorder, hide, add and remove sections in the Visual Editor, and
 * then find nothing on this screen that could publish any of it — the button
 * here said "Publish all drafts" and published content and styles only. Two
 * surfaces edit a page, so both need to be able to finish the job.
 *
 * Everything below calls the same Server Actions the Visual Editor calls, which
 * call the same publication service. What differs is the chrome.
 *
 * The counts come from the server's own reading of the page, passed down by the
 * Server Component above. Nothing here recomputes them from what happens to be
 * rendered: a screen that counted its own rows would be counting whatever it
 * was told about when it loaded.
 */
export function PageChanges({
  csrf,
  pageId,
  summary,
  history,
  canManage,
}: {
  csrf: string;
  pageId: number;
  summary: PageSummaryView;
  history: PageHistoryView | null;
  /**
   * Whether this reader may act, as opposed to look.
   *
   * The card used to be rendered only for an editor, which meant a
   * `content.view` user could see a page's history in the Visual Editor and
   * not on the screen that is actually *about* pages — the same permission
   * answering two different ways depending on which door somebody came
   * through. It renders for everyone who can view; the controls are what this
   * flag removes.
   */
  canManage: boolean;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const [tone, setTone] = useState<"ok" | "error">("ok");
  const onResult = useCallback((state: ActionState) => {
    setTone(state.ok ? "ok" : "error");
    setNotice(state.message ?? null);
  }, []);

  const pending = describePending(summary);
  const removal = describeRemoval(summary);

  return (
    <div className="admin-card space-y-3 p-4">
      <div>
        <h2 className="text-[0.86rem] font-semibold text-strong">Saved changes</h2>
        <p className="mt-0.5 text-[0.74rem] leading-relaxed text-muted">
          Everything waiting on this page — text, styles, entrances and the layout. Publishing puts
          all of it live at once.
        </p>
      </div>

      {summary.layoutCorrupt ? (
        <p className="text-[0.76rem] leading-relaxed" style={{ color: "#ef8f8a" }}>
          The saved layout for this page could not be read, so it cannot be published. Discard the
          saved changes and arrange the page again.
        </p>
      ) : pending.length ? (
        <ul className="list-disc ps-5 text-[0.78rem] leading-relaxed text-body">
          {pending.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : (
        <p className="text-[0.78rem] leading-relaxed text-muted">
          Nothing is waiting. This page is the same as the live one.
        </p>
      )}

      {removal ? (
        <p className="text-[0.74rem] leading-relaxed" style={{ color: "var(--color-peach)" }}>
          {removal}
        </p>
      ) : null}

      {notice ? (
        <p
          role={tone === "ok" ? "status" : "alert"}
          className="text-[0.78rem] leading-relaxed"
          style={{ color: tone === "ok" ? "#5ad19a" : "#ef8f8a" }}
        >
          {notice}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {canManage && summary.publishable ? (
          <InlineAction
            action={publishPage}
            hidden={{ _csrf: csrf, pageId, expectedRevision: summary.revision }}
            onResult={onResult}
          >
            <ConfirmSubmit
              variant="primary"
              className="admin-btn-sm"
              message={
                removal
                  ? `Publish the saved changes on this page?\n\n${removal}`
                  : "Publish the saved changes on this page?"
              }
            >
              <Icon name="check" size={13} />
              Publish saved changes
            </ConfirmSubmit>
          </InlineAction>
        ) : null}
        {canManage && summary.discardable ? (
          <InlineAction
            action={discardPageDrafts}
            hidden={{ _csrf: csrf, pageId, expectedRevision: summary.revision }}
            onResult={onResult}
          >
            <ConfirmSubmit
              className="admin-btn-sm"
              message="Discard every saved change on this page? Sections added in the editor are deleted. The live page does not change."
            >
              Discard all saved changes
            </ConfirmSubmit>
          </InlineAction>
        ) : null}
      </div>

      <details className="border-t border-[var(--admin-line)] pt-3">
        <summary className="cursor-pointer text-[0.76rem] font-medium text-strong">
          Version history
        </summary>
        <div className="mt-2.5">
          {/*
            The list is the shared component; restoring from here is an ordinary
            admin form, so it works without JavaScript like everything else on
            this screen. The confirmation text is the shared one, because the
            promise it makes — the live site does not change — is the same
            promise wherever it is made.
          */}
          {/*
            `canManage={false}` on purpose: the shared component's own Restore
            button would need a click handler, and this screen restores through
            an ordinary admin form below so it works without JavaScript. The
            list, the labels, the actor and the times are the same for everyone
            who can view the page.
          */}
          <PageHistory
            history={history}
            canManage={false}
            busy={false}
            blocked={
              summary.discardable
                ? "Publish or discard the current saved changes before restoring a historical version."
                : null
            }
            onRestore={() => undefined}
          />
          {canManage && !summary.discardable && history?.versions.length ? (
            <div className="mt-2 flex flex-col gap-1.5">
              {history.versions.map((version) => (
                <InlineAction
                  key={version.id}
                  action={restorePageVersion}
                  hidden={{ _csrf: csrf, pageId, versionId: version.id }}
                  onResult={onResult}
                >
                  <ConfirmSubmit className="admin-btn-sm" message={RESTORE_CONFIRM}>
                    <Icon name="refresh" size={12} />
                    Restore #{version.id} to draft
                  </ConfirmSubmit>
                </InlineAction>
              ))}
            </div>
          ) : null}
        </div>
      </details>
    </div>
  );
}
