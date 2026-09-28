"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
  archiveReusable,
  deleteReusable,
  discardReusableDraft,
  loadReusableComponent,
  publishReusable,
  renameReusable,
  restoreReusableVersion,
  saveReusableDraft,
} from "@/app/(backoffice)/admin/(shell)/components/actions";
import { BlockEditor } from "@/components/admin/block-editor";
import type { MediaOption } from "@/components/admin/media-picker";
import { Icon } from "@/components/ui/icon";
import { kindDef, kindNoun } from "@/lib/cms/reuse/kinds";
import { impactSentence, usageHeadline, type UsageInstance } from "@/lib/cms/reuse/usage-view";
import type { ReuseActionResult, ReuseComponentView } from "@/lib/cms/reuse/view";
import type { Locale } from "@/lib/i18n/config";
import { componentPreviewPath } from "@/lib/page-path";

/**
 * A reusable component's own editor (Batch 17) — the one place its content is
 * changed, used by the Reusable components screen and by the Visual Editor's
 * drawer alike, so the two cannot disagree about what saving or publishing
 * means.
 *
 * **Explicit, not autosaved.** A component edit reaches every page that links
 * to it, so nothing here is written on a keystroke: Save draft, Discard draft
 * and Publish are three deliberate buttons. Its edits are not part of any
 * page's Undo — a component has its own history instead, and restoring from it
 * stages the old content as the draft.
 *
 * **The warning comes before the change.** Publishing is confirmed with the
 * number of linked instances and published pages it will update, and the
 * pages by name, read from the server — never a count the browser kept.
 *
 * **A lost race is said, not merged.** Every write names the revision this
 * screen was built from; a stale one is refused and the version that won is
 * offered with "Reload latest".
 */

type Values = Record<string, unknown>;

type Event = "saved" | "discarded" | "published" | "restored" | "renamed" | "archived" | "deleted";

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, raw) =>
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? Object.fromEntries(Object.keys(raw as object).sort().map((key) => [key, (raw as Record<string, unknown>)[key]]))
      : raw,
  );

function When({ iso }: { iso: string | null }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!iso) return;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return;
    setText(date.toLocaleString(undefined, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }));
  }, [iso]);
  return iso ? <time dateTime={iso}>{text ?? iso.slice(0, 16).replace("T", " ")}</time> : null;
}

/** An instance's state, in words. */
function instanceState(entry: UsageInstance): string {
  if (entry.live && entry.draft) return "Live";
  if (entry.live) return "Live — the page’s draft removes or unlinks it";
  if (entry.draft) return "In the page’s draft only";
  if (entry.hidden) return "Hidden in the page’s draft";
  return "Referenced";
}

export function ReuseEditor({
  componentId,
  csrf,
  canManage,
  media,
  locale,
  focus = "edit",
  onChanged,
}: {
  componentId: number;
  csrf: string;
  canManage: boolean;
  media: MediaOption[];
  /** The edition previews open in. */
  locale: Locale;
  focus?: "edit" | "usage";
  onChanged?: (view: ReuseComponentView | null, event: Event) => void;
}) {
  const [view, setView] = useState<ReuseComponentView | null>(null);
  const [loading, setLoading] = useState(true);
  const [values, setValues] = useState<Values>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [latest, setLatest] = useState<ReuseComponentView | null>(null);
  const [confirm, setConfirm] = useState<null | "publish" | "discard" | "delete" | { restore: number; version: number }>(null);
  const [name, setName] = useState("");

  const adopt = useCallback((next: ReuseComponentView | null) => {
    setView(next);
    setLatest(null);
    setConfirm(null);
    if (next) {
      setValues(next.draft ?? next.published ?? {});
      setName(next.name);
    }
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    const next = await loadReusableComponent(componentId);
    setLoading(false);
    adopt(next);
    if (!next) setMessage({ ok: false, text: "That reusable component could not be read. It may have been deleted." });
  }, [adopt, componentId]);

  useEffect(() => {
    setMessage(null);
    void reload();
  }, [reload]);

  useEffect(() => {
    if (focus === "usage" && view) document.getElementById(`reuse-usage-${componentId}`)?.scrollIntoView({ block: "nearest" });
  }, [componentId, focus, view]);

  const base = view ? (view.draft ?? view.published ?? {}) : {};
  const dirty = view ? canonical(values) !== canonical(base) : false;
  const definition = view ? kindDef(view.kind) : null;
  const noun = view ? kindNoun(view.kind) : "component";
  const archived = view?.status === "archived";

  const pages = useMemo(() => {
    const byPage = new Map<number, { slug: string; title: string; published: boolean; instances: UsageInstance[] }>();
    for (const entry of view?.instances ?? []) {
      const page = byPage.get(entry.pageId) ?? { slug: entry.slug, title: entry.title, published: entry.pagePublished, instances: [] };
      page.instances.push(entry);
      byPage.set(entry.pageId, page);
    }
    return [...byPage.values()];
  }, [view]);
  const livePages = pages.filter((page) => page.instances.some((entry) => entry.live));

  const run = async (
    label: string,
    action: (form: FormData) => Promise<ReuseActionResult>,
    fill: (form: FormData) => void,
    event: Event,
  ) => {
    if (!view) return;
    setBusy(label);
    setMessage(null);
    const form = new FormData();
    form.set("_csrf", csrf);
    form.set("id", String(view.id));
    form.set("expectedRevision", String(view.revision));
    fill(form);
    const result = await action(form);
    setBusy(null);
    if (!result.ok) {
      setMessage({ ok: false, text: result.message });
      if (result.reason === "conflict" && result.latest) setLatest(result.latest);
      setConfirm(null);
      return;
    }
    setMessage({ ok: true, text: result.message });
    adopt(result.component);
    onChanged?.(result.component, event);
  };

  if (loading && !view) return <p className="p-3 text-[0.78rem] text-muted">Reading the component…</p>;
  if (!view || !definition) {
    return (
      <p
        className="p-3 text-[0.78rem]"
        style={{ color: message?.ok ? "#5ad19a" : "#ef8f8a" }}
        role={message?.ok ? "status" : "alert"}
      >
        {message?.text ?? "That reusable component could not be read."}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-reuse-editor={view.id} data-reuse-revision={view.revision}>
      {/* What this is, and what it is used by ------------------------------ */}
      <div>
        <p className="flex items-center gap-1.5 text-[0.66rem] font-semibold uppercase tracking-[0.07em] text-muted">
          <Icon name="layers" size={11} />
          {definition.label}
        </p>
        <h2 className="mt-0.5 text-[1rem] font-semibold leading-snug text-strong" data-reuse-title>
          {view.name}
        </h2>
        <p className="mt-1 flex flex-wrap gap-x-2 text-[0.74rem] text-muted">
          <span data-reuse-status>
            {archived
              ? "Archived"
              : view.publishedVersion < 1
                ? "Not published yet"
                : `Published version ${view.publishedVersion}`}
          </span>
          {view.hasDraft ? <span data-reuse-draft>· Draft pending</span> : null}
          <span>· {usageHeadline(view.usage)}</span>
        </p>
      </div>

      <p className="admin-card p-2.5 text-[0.76rem] leading-relaxed text-body" role="note" data-reuse-warning>
        This is a reusable component. Changes can affect every linked instance. Edits are saved as a draft — linked
        pages keep showing the published version until you publish.
      </p>

      {latest ? (
        <div className="admin-card p-2.5 text-[0.76rem] leading-relaxed" role="alert" data-reuse-conflict>
          <p style={{ color: "#ef8f8a" }}>
            This component changed since you opened it. Nothing was saved — reload the latest version and make the
            change again.
          </p>
          <button type="button" className="admin-btn admin-btn-sm mt-2" onClick={() => adopt(latest)}>
            Reload latest
          </button>
        </div>
      ) : null}

      {message ? (
        <p
          role="status"
          className="text-[0.76rem] leading-relaxed"
          style={{ color: message.ok ? "#5ad19a" : "#ef8f8a" }}
          data-reuse-message
        >
          {message.text}
        </p>
      ) : null}

      {/* The content ------------------------------------------------------ */}
      <section aria-label="Component content" className="flex flex-col gap-2">
        {archived ? (
          <p className="text-[0.76rem] text-muted">
            Archived components cannot be edited. Pages that use it keep showing its published content.
          </p>
        ) : null}
        <fieldset disabled={!canManage || archived || busy !== null} className="min-w-0 border-0 p-0">
          <BlockEditor
            block={definition.definition}
            value={values}
            onChange={setValues}
            media={media}
            idPrefix={`reusable-${view.id}`}
          />
        </fieldset>
        {canManage && !archived ? (
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              className="admin-btn admin-btn-sm admin-btn-primary"
              disabled={!dirty || busy !== null || Boolean(latest)}
              onClick={() => void run("save", saveReusableDraft, (form) => form.set("values", JSON.stringify(values)), "saved")}
              data-reuse-save
            >
              {busy === "save" ? "Saving…" : "Save draft"}
            </button>
            {dirty ? (
              <button type="button" className="admin-btn admin-btn-sm" onClick={() => setValues(base)}>
                Undo unsaved edits
              </button>
            ) : null}
            <button
              type="button"
              className="admin-btn admin-btn-sm"
              disabled={!view.hasDraft || dirty || busy !== null || Boolean(latest)}
              onClick={() => setConfirm("discard")}
              data-reuse-discard
            >
              Discard draft
            </button>
            <button
              type="button"
              className="admin-btn admin-btn-sm"
              disabled={!view.hasDraft || dirty || busy !== null || Boolean(latest)}
              title={dirty ? "Save the draft first" : undefined}
              onClick={() => setConfirm("publish")}
              data-reuse-publish
            >
              Publish…
            </button>
          </div>
        ) : null}
        {dirty ? <p className="text-[0.72rem] text-muted">Unsaved edits — save the draft to preview or publish them.</p> : null}
      </section>

      {confirm === "discard" ? (
        <div className="admin-card p-2.5" role="alertdialog" aria-label="Discard the draft">
          <p className="text-[0.78rem] font-semibold text-strong">Discard the draft of “{view.name}”?</p>
          <p className="mt-1 text-[0.74rem] text-body">
            It goes back to the published version. No page, page draft or page history changes.
          </p>
          <div className="mt-2 flex gap-1.5">
            <button
              type="button"
              className="admin-btn admin-btn-sm admin-btn-danger"
              disabled={busy !== null}
              onClick={() => void run("discard", discardReusableDraft, () => undefined, "discarded")}
            >
              Discard draft
            </button>
            <button type="button" className="admin-btn admin-btn-sm" onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {confirm === "publish" ? (
        <div className="admin-card p-2.5" role="alertdialog" aria-label="Publish the component" data-reuse-publish-confirm>
          <p className="text-[0.82rem] font-semibold text-strong">Publish changes to “{view.name}”?</p>
          <p className="mt-1 text-[0.76rem] leading-relaxed text-body" data-reuse-impact>
            {impactSentence(view.usage)}
          </p>
          {livePages.length ? (
            <ul className="mt-1.5 list-disc ps-5 text-[0.74rem] text-body" aria-label="Published pages this updates">
              {livePages.map((page) => (
                <li key={page.slug}>
                  {page.title} <span className="text-muted">(/{page.slug === "home" ? "" : page.slug})</span> —{" "}
                  {page.instances.filter((entry) => entry.live).length} instance
                  {page.instances.filter((entry) => entry.live).length === 1 ? "" : "s"}
                </li>
              ))}
            </ul>
          ) : null}
          <p className="mt-1.5 text-[0.72rem] text-muted">
            The page drafts and page histories are not rewritten; every linked page shows the new version from now on.
          </p>
          <div className="mt-2 flex gap-1.5">
            <button
              type="button"
              className="admin-btn admin-btn-sm admin-btn-primary"
              disabled={busy !== null}
              onClick={() => void run("publish", publishReusable, () => undefined, "published")}
              data-reuse-publish-yes
            >
              {busy === "publish" ? "Publishing…" : `Publish ${noun}`}
            </button>
            <button type="button" className="admin-btn admin-btn-sm" onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {/* Usage ------------------------------------------------------------ */}
      <section aria-labelledby={`reuse-usage-${view.id}`} className="flex flex-col gap-1.5">
        <h3 id={`reuse-usage-${view.id}`} className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted">
          Used on
        </h3>
        {pages.length ? (
          <ul className="flex flex-col gap-1.5" data-reuse-usage-list>
            {pages.map((page) => (
              <li key={page.slug} className="admin-card p-2 text-[0.74rem]" data-reuse-usage-page={page.slug}>
                <p className="flex flex-wrap items-baseline gap-x-2">
                  <Link href={`/admin/visual-editor?page=${encodeURIComponent(page.slug)}`} className="font-medium text-strong underline">
                    {page.title}
                  </Link>
                  <span className="text-muted">/{page.slug === "home" ? "" : page.slug}</span>
                  <span className="text-muted">· {page.published ? "Published page" : "Unpublished page"}</span>
                </p>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {page.instances.map((entry) => (
                    <li key={`${entry.sectionId}:${entry.slot}`} className="text-muted">
                      {entry.blockName} · {entry.slotLabel} — {instanceState(entry)}
                      {entry.overrides ? ` · ${entry.overrides} override${entry.overrides === 1 ? "" : "s"}` : ""}
                    </li>
                  ))}
                </ul>
                <a
                  href={componentPreviewPath(page.slug, locale, view.id, view.revision)}
                  target="_blank"
                  rel="noopener"
                  className="mt-1 inline-flex items-center gap-1 underline"
                  data-reuse-preview={page.slug}
                >
                  <Icon name="arrowUpRight" size={11} />
                  {view.hasDraft ? "Preview the draft on this page" : "Preview on this page"}
                </a>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[0.74rem] text-muted">No page uses it yet.</p>
        )}
      </section>

      {/* History ---------------------------------------------------------- */}
      <section aria-labelledby={`reuse-history-${view.id}`} className="flex flex-col gap-1.5">
        <h3 id={`reuse-history-${view.id}`} className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted">
          History
        </h3>
        <p className="text-[0.74rem] text-body">
          {view.publishedVersion > 0 ? (
            <>
              Current live: version {view.publishedVersion}
              {view.publishedAt ? (
                <>
                  {" "}
                  · published <When iso={view.publishedAt} />
                </>
              ) : null}
            </>
          ) : (
            "Not published yet."
          )}
        </p>
        {view.versions.length ? (
          <ol className="flex flex-col gap-1" data-reuse-history>
            {view.versions.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-x-2 text-[0.74rem]" data-reuse-version={entry.version}>
                <span className="text-strong">Version {entry.version}</span>
                <span className="text-muted">
                  {entry.label} · {entry.actorName} · <When iso={entry.createdAt} />
                </span>
                {canManage && !archived ? (
                  <button
                    type="button"
                    className="admin-btn admin-btn-sm"
                    disabled={busy !== null || dirty}
                    onClick={() => setConfirm({ restore: entry.id, version: entry.version })}
                  >
                    Restore to draft
                  </button>
                ) : null}
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-[0.72rem] text-muted">
            Earlier versions appear here after the next publication. The last {view.keepVersions} are kept.
          </p>
        )}
      </section>

      {confirm && typeof confirm === "object" ? (
        <div className="admin-card p-2.5" role="alertdialog" aria-label="Restore a version to the draft">
          <p className="text-[0.8rem] font-semibold text-strong">Restore version {confirm.version} to the draft?</p>
          <p className="mt-1 text-[0.74rem] leading-relaxed text-body">
            It becomes the draft; linked pages keep showing version {view.publishedVersion} until you publish.{" "}
            {view.usage.liveInstances
              ? `Publishing this restored ${noun} will update ${view.usage.liveInstances} instance${view.usage.liveInstances === 1 ? "" : "s"} on ${view.usage.livePages} published page${view.usage.livePages === 1 ? "" : "s"}.`
              : "No published page shows it today."}
          </p>
          <div className="mt-2 flex gap-1.5">
            <button
              type="button"
              className="admin-btn admin-btn-sm admin-btn-primary"
              disabled={busy !== null}
              onClick={() =>
                void run("restore", restoreReusableVersion, (form) => form.set("versionId", String(confirm.restore)), "restored")
              }
            >
              Restore to draft
            </button>
            <button type="button" className="admin-btn admin-btn-sm" onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : null}

      {/* Name and lifecycle ----------------------------------------------- */}
      {canManage ? (
        <section aria-label="Name and lifecycle" className="flex flex-col gap-2 border-t border-[var(--admin-line)] pt-3">
          <form
            className="flex flex-wrap items-end gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() && name.trim() !== view.name) {
                void run("rename", renameReusable, (form) => form.set("name", name.trim()), "renamed");
              }
            }}
          >
            <label className="flex min-w-0 flex-1 flex-col text-[0.72rem] text-muted">
              Name (for the admin — never shown on the site)
              <input value={name} onChange={(event) => setName(event.target.value)} maxLength={120} className="admin-input mt-1" />
            </label>
            <button type="submit" className="admin-btn admin-btn-sm" disabled={busy !== null || !name.trim() || name.trim() === view.name}>
              Rename
            </button>
          </form>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              className="admin-btn admin-btn-sm"
              disabled={busy !== null}
              onClick={() => void run("archive", archiveReusable, (form) => form.set("archived", archived ? "0" : "1"), "archived")}
              data-reuse-archive
            >
              {archived ? "Restore from archive" : "Archive"}
            </button>
            {!view.usage.referenced && !view.usage.instances ? (
              <button
                type="button"
                className="admin-btn admin-btn-sm admin-btn-danger"
                disabled={busy !== null}
                onClick={() => setConfirm("delete")}
                data-reuse-delete
              >
                Delete permanently…
              </button>
            ) : (
              <p className="basis-full text-[0.72rem] leading-relaxed text-muted" data-reuse-delete-unavailable>
                Delete is unavailable while a page refers to it. View the usage above, detach or replace those
                instances, or archive it — archived components keep rendering where they are used and cannot be
                linked to anything new.
              </p>
            )}
          </div>
          {confirm === "delete" ? (
            <div className="admin-card p-2.5" role="alertdialog" aria-label="Delete the component">
              <p className="text-[0.8rem] font-semibold text-strong">Delete “{view.name}” permanently?</p>
              <p className="mt-1 text-[0.74rem] text-body">
                Nothing uses it. Its history is deleted with it. This cannot be undone.
              </p>
              <div className="mt-2 flex gap-1.5">
                <button
                  type="button"
                  className="admin-btn admin-btn-sm admin-btn-danger"
                  disabled={busy !== null}
                  onClick={() => void run("delete", deleteReusable, () => undefined, "deleted")}
                >
                  Delete
                </button>
                <button type="button" className="admin-btn admin-btn-sm" onClick={() => setConfirm(null)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
