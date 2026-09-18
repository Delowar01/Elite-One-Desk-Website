"use client";

import { Icon } from "@/components/ui/icon";
import type { MediaOption } from "@/components/admin/media-picker";
import { getBlock } from "@/lib/cms/blocks";
import { DRAFT_LABEL, type DraftKind } from "@/lib/cms/drafts";
import type { Breakpoint, StyleDocument } from "@/lib/cms/styles";
import type { Locale } from "@/lib/i18n/config";
import type { VisualSectionData } from "@/lib/visual-editor/content";
import { describeAddress } from "@/lib/visual-editor/labels";
import type { EditorNodeMeta, EditorSectionMeta } from "@/lib/visual-editor/protocol";

import { ContentBody } from "./content-inspector";
import { StyleInspector } from "./style-inspector";

export type EditDomain = "content" | "style";
export type BufferStatus = "idle" | "saved" | "conflict" | "error";

/**
 * One section's edit buffers — two domains sharing one row.
 *
 * `data` is the last thing the *server* said this section is; `values` and
 * `styles` are what the person has changed since. Keeping them apart is what
 * lets the panel answer the questions it would otherwise guess at: whether
 * there is anything to save, what revision to name when saving, and what to put
 * back if the edit is abandoned.
 *
 * Content and layout are separate drafts in separate columns, but they share
 * one `revision`, because the row has one concurrency timeline. That is why
 * `data.revision` is updated by whichever domain saves — an editor who saves a
 * style and then saves text must not conflict with themselves — while the other
 * domain's unsaved work is left exactly where it was.
 *
 * `saving` names the domain currently writing. The other domain's save is
 * disabled while it does, so one browser cannot manufacture a race against
 * itself out of two requests that were both correct when they left.
 *
 * The canvas is not in this picture at all. It is a rendering of the drafts,
 * and nothing is ever read back out of it.
 */
export type SectionBuffer = {
  data: VisualSectionData;
  values: Record<string, unknown>;
  styles: StyleDocument;
  contentDirty: boolean;
  styleDirty: boolean;
  saving: EditDomain | null;
  status: BufferStatus;
  /** Which domain `status` and `message` are about. */
  statusDomain: EditDomain | null;
  message?: string;
  /** Present after a lost race: the version that won it, both domains. */
  latest?: VisualSectionData;
};

export const isDirty = (buffer: SectionBuffer | null | undefined): boolean =>
  Boolean(buffer && (buffer.contentDirty || buffer.styleDirty));

const draftKindOfData = (data: VisualSectionData): DraftKind =>
  data.hasDraft && data.hasStyleDraft
    ? "both"
    : data.hasDraft
      ? "content"
      : data.hasStyleDraft
        ? "style"
        : "none";

/**
 * The inspector: what is selected, and the controls that change it.
 *
 * Two tabs, because text and layout are edited with different controls and
 * saved to different columns. There is deliberately no Motion tab and no
 * Responsive tab — a tab that cannot be opened is a promise the software has
 * not kept, and both are somebody else's batch.
 */
export function InspectorPanel({
  node,
  sections,
  locale,
  media,
  canManage,
  buffer,
  breakpoint,
  tab,
  onTab,
  loading,
  loadError,
  onValues,
  onStyles,
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
  /** Which branch the Style tab edits — the device being previewed decides. */
  breakpoint: Breakpoint;
  tab: EditDomain;
  onTab: (next: EditDomain) => void;
  loading: boolean;
  loadError: string | null;
  onValues: (values: Record<string, unknown>) => void;
  onStyles: (styles: StyleDocument) => void;
  onSave: (domain: EditDomain) => void;
  onRevert: (domain: EditDomain) => void;
  onTakeLatest: () => void;
  onClear: () => void;
}) {
  const section = node ? sections.find((row) => row.sectionId === node.sectionId) : undefined;
  const described = node ? describeAddress(node.blockType, node.relativePath, node.text) : null;
  const block = node ? getBlock(node.blockType) : null;
  const pending = buffer ? draftKindOfData(buffer.data) : "none";

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
                  : pending !== "none"
                    ? DRAFT_LABEL[pending]
                    : section?.isDraft
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

            {loading ? <p className="text-[0.76rem] text-muted">Reading this section…</p> : null}

            {!canManage ? <ReadOnlyNote /> : null}

            {buffer ? (
              <>
                <Tabs tab={tab} onTab={onTab} buffer={buffer} />

                {buffer.status === "conflict" ? (
                  <Conflict message={buffer.message} onTakeLatest={onTakeLatest} />
                ) : null}

                {tab === "content" ? (
                  block ? (
                    <ContentBody
                      node={node}
                      block={block}
                      buffer={buffer}
                      media={media}
                      locale={locale}
                      canManage={canManage}
                      onValues={onValues}
                    />
                  ) : (
                    <p className="text-[0.76rem] leading-relaxed text-muted">
                      This section’s type is no longer in the block registry, so it cannot be
                      edited here.
                    </p>
                  )
                ) : (
                  <StyleInspector
                    node={node}
                    styles={buffer.styles}
                    values={buffer.values}
                    locale={locale}
                    breakpoint={breakpoint}
                    canManage={canManage}
                    onChange={onStyles}
                  />
                )}

                <SaveBar
                  domain={tab}
                  buffer={buffer}
                  canManage={canManage}
                  onSave={onSave}
                  onRevert={onRevert}
                />
              </>
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

function Tabs({
  tab,
  onTab,
  buffer,
}: {
  tab: EditDomain;
  onTab: (next: EditDomain) => void;
  buffer: SectionBuffer;
}) {
  const dirty: Record<EditDomain, boolean> = {
    content: buffer.contentDirty,
    style: buffer.styleDirty,
  };
  return (
    <div className="flex gap-1" role="tablist" aria-label="What to edit">
      {(["content", "style"] as const).map((key) => (
        <button
          key={key}
          type="button"
          role="tab"
          aria-selected={tab === key}
          onClick={() => onTab(key)}
          className="admin-btn admin-btn-sm flex-1 justify-center"
          style={
            tab === key
              ? { borderColor: "var(--color-orange)", color: "var(--color-strong)" }
              : undefined
          }
        >
          {key === "content" ? "Content" : "Style"}
          {/* A dot rather than a word: the tab is narrow, and the label below
              says which domain is unsaved in full. */}
          {dirty[key] ? (
            <span
              aria-label="unsaved"
              className="inline-block size-1.5 rounded-full"
              style={{ background: "var(--color-orange)" }}
            />
          ) : null}
        </button>
      ))}
    </div>
  );
}

function ReadOnlyNote() {
  return (
    <p className="admin-card p-3 text-[0.75rem] leading-relaxed text-muted">
      You can look at every page here, but not change anything. Editing content and styles needs
      the
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
 * version that is actually stored — all of it, text and layout, because they
 * share a revision and taking half would leave the other half stale — and redo
 * the edit on top of it.
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
        This replaces both the content and the styles in the panel with the stored version, losing
        anything unsaved in either. Copy what you want to keep first.
      </p>
    </div>
  );
}

const SAVE_LABEL: Record<EditDomain, { idle: string; busy: string; saved: string }> = {
  content: { idle: "Save draft", busy: "Saving…", saved: "Draft saved" },
  style: { idle: "Save styles", busy: "Saving…", saved: "Styles saved" },
};

function SaveBar({
  domain,
  buffer,
  canManage,
  onSave,
  onRevert,
}: {
  domain: EditDomain;
  buffer: SectionBuffer;
  canManage: boolean;
  onSave: (domain: EditDomain) => void;
  onRevert: (domain: EditDomain) => void;
}) {
  if (!canManage) return null;
  const dirty = domain === "content" ? buffer.contentDirty : buffer.styleDirty;
  const busy = buffer.saving === domain;
  // The other domain writing is still a reason not to start: one row, one
  // revision, and two requests in flight against it is a race this browser
  // would have created on its own.
  const blocked = buffer.saving !== null;
  const label = SAVE_LABEL[domain];
  const onFile = domain === "content" ? buffer.data.hasDraft : buffer.data.hasStyleDraft;
  const showsStatus = buffer.statusDomain === domain;

  return (
    <div className="sticky bottom-0 -mx-3.5 border-t border-[var(--admin-line)] bg-[var(--admin-shell)] px-3.5 pb-2 pt-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => onSave(domain)}
          disabled={!dirty || blocked}
          className="admin-btn admin-btn-sm admin-btn-primary"
        >
          {busy ? label.busy : label.idle}
        </button>
        {dirty && !blocked ? (
          <button type="button" onClick={() => onRevert(domain)} className="admin-btn admin-btn-sm">
            Discard changes
          </button>
        ) : null}
        <span className="text-[0.72rem] text-muted" aria-live="polite">
          {busy
            ? ""
            : dirty
              ? `Unsaved ${domain === "content" ? "content" : "styles"}`
              : showsStatus && buffer.status === "saved"
                ? label.saved
                : onFile
                  ? "Draft on file"
                  : "No changes"}
        </span>
      </div>
      {showsStatus && buffer.status === "error" && buffer.message ? (
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
