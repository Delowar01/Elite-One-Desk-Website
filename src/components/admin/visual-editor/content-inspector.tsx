"use client";

import { BlockEditor } from "@/components/admin/block-editor";
import type { MediaOption } from "@/components/admin/media-picker";
import { Icon } from "@/components/ui/icon";
import { getBlock } from "@/lib/cms/blocks";
import type { Locale } from "@/lib/i18n/config";
import { focusOf, type VisualSectionData } from "@/lib/visual-editor/content";
import { describeAddress } from "@/lib/visual-editor/labels";
import type { EditorNodeMeta, EditorSectionMeta } from "@/lib/visual-editor/protocol";

export type BufferStatus = "idle" | "saving" | "saved" | "conflict" | "error";

/**
 * One section's edit buffer.
 *
 * `data` is the last thing the *server* said this section is; `values` is what
 * the person has typed since. Keeping them apart is what lets the panel answer
 * three questions it would otherwise have to guess at: whether there is
 * anything to save, what revision to name when saving, and what to put back if
 * the edit is abandoned.
 *
 * The canvas is not in this picture at all. It is a rendering of the draft, and
 * nothing is ever read back out of it — see `admin/visual-editor/actions.ts`.
 */
export type SectionBuffer = {
  data: VisualSectionData;
  values: Record<string, unknown>;
  dirty: boolean;
  status: BufferStatus;
  message?: string;
  /** Present after a lost race: the version that won it. */
  latest?: VisualSectionData;
};

/**
 * The inspector: what is selected, and the controls that change it.
 *
 * Content only. Structure (add, delete, reorder, hide), visual styles and
 * motion are later batches, and there is deliberately not a disabled button
 * here for any of them — a control that does nothing is a promise the software
 * has not kept.
 */
export function ContentInspector({
  node,
  sections,
  locale,
  media,
  canManage,
  buffer,
  loading,
  loadError,
  onValues,
  onSave,
  onRevert,
  onTakeLatest,
  onClear,
}: {
  node: EditorNodeMeta | null;
  sections: EditorSectionMeta[];
  locale: Locale;
  media: MediaOption[];
  canManage: boolean;
  buffer: SectionBuffer | null;
  loading: boolean;
  loadError: string | null;
  onValues: (values: Record<string, unknown>) => void;
  onSave: () => void;
  onRevert: () => void;
  onTakeLatest: () => void;
  onClear: () => void;
}) {
  const section = node ? sections.find((row) => row.sectionId === node.sectionId) : undefined;
  const described = node ? describeAddress(node.blockType, node.relativePath, node.text) : null;
  const block = node ? getBlock(node.blockType) : null;
  const focus = node ? focusOf(node.relativePath) : null;

  return (
    <aside
      className="hidden w-[21rem] shrink-0 flex-col border-s border-[var(--admin-line)] bg-[var(--admin-shell)] xl:flex 2xl:w-[24rem]"
      aria-label="Inspector"
    >
      <h2 className="shrink-0 px-3.5 pb-2 pt-3.5 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted">
        Inspector
      </h2>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-6">
        {!node || !described ? (
          <p className="text-[0.76rem] leading-relaxed text-muted">
            Select something on the canvas or in Page structure.
          </p>
        ) : (
          <div className="flex flex-col gap-3.5">
            <div>
              <p className="text-[0.92rem] font-semibold leading-snug text-strong">{described.label}</p>
              <p className="mt-1 text-[0.7rem] leading-relaxed text-muted">
                {described.crumbs.join(" → ")}
              </p>
            </div>

            <p className="flex flex-wrap items-center gap-1.5 text-[0.72rem] text-muted">
              <span>
                {section?.isDraftOnly
                  ? "New — not published yet"
                  : buffer?.data.hasDraft || section?.isDraft
                    ? "Has unpublished edits"
                    : "Published"}
              </span>
              {section && !section.visible ? <span>· hidden</span> : null}
              <span>· {locale === "ar" ? "Arabic" : "English"}</span>
            </p>

            {loadError ? (
              <p className="admin-card p-3 text-[0.76rem] leading-relaxed" style={{ color: "#ef8f8a" }}>
                {loadError}
              </p>
            ) : null}

            {loading ? (
              <p className="text-[0.76rem] text-muted">Reading this section…</p>
            ) : null}

            {!canManage ? (
              <ReadOnlyNote />
            ) : null}

            {block && buffer ? (
              <>
                {buffer.status === "conflict" ? (
                  <Conflict message={buffer.message} onTakeLatest={onTakeLatest} />
                ) : null}

                {/*
                  A viewer sees the real content in the real controls, switched
                  off. A screen of empty boxes would be a different, and false,
                  answer to "what does this section say".
                */}
                <fieldset disabled={!canManage} className="min-w-0 border-0 p-0">
                  <BlockEditor
                    block={block}
                    value={buffer.values}
                    onChange={onValues}
                    media={media}
                    locale={locale}
                    focus={focus}
                  />
                </fieldset>

                <SaveBar
                  buffer={buffer}
                  canManage={canManage}
                  onSave={onSave}
                  onRevert={onRevert}
                />
              </>
            ) : null}

            {block === null ? (
              <p className="text-[0.76rem] leading-relaxed text-muted">
                This section’s type is no longer in the block registry, so it cannot be edited here.
              </p>
            ) : null}

            <details className="mt-1">
              <summary className="cursor-pointer text-[0.72rem] text-muted">Technical details</summary>
              <div className="mt-2 flex flex-col gap-2.5">
                <Row label="Kind">{node.kind}</Row>
                <Row label="Block">
                  {described.blockName} <span className="text-muted">({node.blockType})</span>
                </Row>
                <Row label="Section">
                  #{node.sectionId}
                  {buffer ? ` · revision ${buffer.data.revision}` : ""}
                </Row>
                <Row label="Address">
                  <code className="block break-all text-[0.68rem] text-muted">{node.address}</code>
                </Row>
              </div>
            </details>

            <button type="button" onClick={onClear} className="admin-btn admin-btn-sm self-start">
              Clear selection
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

function ReadOnlyNote() {
  return (
    <p className="admin-card p-3 text-[0.75rem] leading-relaxed text-muted">
      You can look at every page here, but not change anything. Editing content needs the
      <span className="text-strong"> Manage content </span> permission.
    </p>
  );
}

/**
 * What happens when two people edit one section.
 *
 * There is exactly one button, and it is not "save anyway". A save that
 * overwrote the other version would be the last-write-wins behaviour the
 * revision guard exists to prevent, and the person who lost would find out at
 * publish time, if ever. So the choice offered is the honest one: take the
 * version that is actually stored, and redo the edit on top of it.
 */
function Conflict({ message, onTakeLatest }: { message?: string; onTakeLatest: () => void }) {
  return (
    <div
      className="admin-card p-3"
      role="alert"
      style={{ borderColor: "color-mix(in oklab, #ef8f8a 50%, var(--admin-line))" }}
    >
      <p className="text-[0.78rem] font-semibold text-strong">Somebody else saved first</p>
      <p className="mt-1 text-[0.75rem] leading-relaxed text-muted">{message}</p>
      <button type="button" onClick={onTakeLatest} className="admin-btn admin-btn-sm mt-2.5">
        <Icon name="refresh" size={12} />
        Reload latest
      </button>
      <p className="mt-1.5 text-[0.7rem] text-muted">
        This replaces what is in the panel with the stored version. Copy anything you want to keep
        first.
      </p>
    </div>
  );
}

function SaveBar({
  buffer,
  canManage,
  onSave,
  onRevert,
}: {
  buffer: SectionBuffer;
  canManage: boolean;
  onSave: () => void;
  onRevert: () => void;
}) {
  if (!canManage) return null;
  const saving = buffer.status === "saving";

  return (
    <div className="sticky bottom-0 -mx-3.5 border-t border-[var(--admin-line)] bg-[var(--admin-shell)] px-3.5 pb-2 pt-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onSave}
          disabled={!buffer.dirty || saving}
          className="admin-btn admin-btn-sm admin-btn-primary"
        >
          {saving ? "Saving…" : "Save draft"}
        </button>
        {buffer.dirty && !saving ? (
          <button type="button" onClick={onRevert} className="admin-btn admin-btn-sm">
            Discard changes
          </button>
        ) : null}
        <span className="text-[0.72rem] text-muted" aria-live="polite">
          {saving
            ? ""
            : buffer.dirty
              ? "Unsaved changes"
              : buffer.status === "saved"
                ? "Draft saved"
                : buffer.data.hasDraft
                  ? "Draft on file"
                  : "No changes"}
        </span>
      </div>
      {buffer.status === "error" && buffer.message ? (
        <p className="mt-1.5 text-[0.72rem]" style={{ color: "#ef8f8a" }} role="alert">
          {buffer.message}
        </p>
      ) : null}
      <p className="mt-1.5 text-[0.7rem] leading-relaxed text-muted">
        Saving puts this in the page’s draft. Publish it from Pages &amp; sections when you are
        ready.
      </p>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[0.66rem] font-semibold uppercase tracking-[0.07em] text-muted">{label}</p>
      <p className="mt-0.5 text-[0.78rem] text-body">{children}</p>
    </div>
  );
}
