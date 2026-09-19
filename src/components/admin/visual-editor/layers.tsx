"use client";

import { useEffect, useState } from "react";

import { Icon } from "@/components/ui/icon";
import type { BlockDef } from "@/lib/cms/blocks";
import { blockNameOf } from "@/lib/visual-editor/labels";
import type { EditorSectionMeta } from "@/lib/visual-editor/protocol";
import type { PageStructure, PageStructureSection } from "@/lib/cms/structure";

/**
 * The page's sections, as the canvas actually rendered them — plus the ones it
 * could not, because the layout draft leaves them out.
 *
 * The active list still comes over the bridge rather than from a second
 * database query, and that is still the point: the canvas has already been
 * through the structural draft, the pending rows and the preview membership, so
 * anything else could only produce a list that disagrees with what is on
 * screen. What the server adds is the part the canvas cannot know — which
 * sections the layout is leaving out, and which revision of the layout this is.
 *
 * Section-level only. A tree with every heading and paragraph in it would be
 * accurate and unusable; the canvas is where you point at a sentence.
 *
 * Every control edits the **layout draft**. None of them changes what a visitor
 * is getting: hiding a section says what publishing the layout would do, and
 * removing one is an intention the Removed list can undo. The badges say so in
 * those words rather than "Hidden", which would be a claim about the live site
 * that is not true.
 */

export type StructuralOps = {
  onAdd: (blockType: string, afterSectionId: number | null) => void;
  onDuplicate: (sectionId: number) => void;
  onMove: (sectionId: number, direction: "up" | "down") => void;
  onReorder: (order: number[]) => void;
  onVisibility: (sectionId: number, visible: boolean) => void;
  onRemove: (sectionId: number) => void;
  onRestore: (sectionId: number) => void;
  onDiscard: () => void;
};

export function LayersPanel({
  sections,
  structure,
  removed,
  selectedSectionId,
  dirtyIds,
  ready,
  canManage,
  busy,
  failure,
  onReloadLayout,
  blocks,
  ops,
  onSelect,
}: {
  sections: EditorSectionMeta[];
  structure: PageStructure | null;
  removed: PageStructureSection[];
  selectedSectionId: number | null;
  /** Sections with edits in the panel that have not been saved yet. */
  dirtyIds: Set<number>;
  ready: boolean;
  canManage: boolean;
  /** A structural request is in flight; the controls wait rather than queue. */
  busy: boolean;
  /** The last refusal, with its reason — a conflict is offered a way out. */
  failure: { reason: "conflict" | "invalid" | "denied"; message: string } | null;
  onReloadLayout: () => void;
  blocks: BlockDef[];
  ops: StructuralOps;
  onSelect: (address: string) => void;
}) {
  const [order, setOrder] = useState<EditorSectionMeta[]>(sections);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const signature = sections.map((s) => `${s.sectionId}:${s.visible}`).join(",");

  useEffect(() => {
    setOrder(sections);
  }, [signature, sections]);

  const dropOnto = (target: number) => {
    if (dragging === null || dragging === target) return;
    const next = [...order];
    const [moved] = next.splice(dragging, 1);
    next.splice(target, 0, moved!);
    setDragging(null);
    setOver(null);
    setOrder(next);
    ops.onReorder(next.map((row) => row.sectionId));
  };

  const pending = structure?.hasDraftStructure || removed.length > 0;

  return (
    <aside
      className="hidden w-60 shrink-0 flex-col border-e border-[var(--admin-line)] bg-[var(--admin-shell)] xl:flex"
      aria-label="Page structure"
    >
      <div className="flex shrink-0 items-center justify-between gap-2 px-3.5 pb-2 pt-3.5">
        <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted">
          Page structure
        </h2>
        {canManage ? (
          <button
            type="button"
            onClick={() => setAdding((open) => !open)}
            disabled={busy || !ready}
            aria-expanded={adding}
            className="admin-btn admin-btn-sm"
            title="Add a section to the layout draft"
          >
            Add section
          </button>
        ) : null}
      </div>

      {pending ? (
        <div className="mx-2 mb-2 shrink-0 rounded-[var(--radius-xs)] border border-[color-mix(in_oklab,#ffd166_40%,transparent)] bg-[color-mix(in_oklab,#ffd166_10%,transparent)] px-2.5 py-2">
          <p className="text-[0.68rem] font-semibold uppercase tracking-wide" style={{ color: "#ffd166" }}>
            Layout draft
          </p>
          <p className="mt-0.5 text-[0.68rem] leading-relaxed text-muted">
            Unpublished. The live page keeps its current layout.
          </p>
          {canManage ? (
            <button
              type="button"
              onClick={ops.onDiscard}
              disabled={busy}
              className="admin-btn admin-btn-sm mt-1.5 w-full justify-center"
            >
              Discard layout changes
            </button>
          ) : null}
        </div>
      ) : null}

      {failure ? (
        <div
          role="alert"
          className="mx-2 mb-2 shrink-0 rounded-[var(--radius-xs)] px-2.5 py-2"
          style={{ background: "#ef53501a" }}
        >
          <p className="text-[0.7rem] leading-relaxed" style={{ color: "#ffb4ad" }}>
            {failure.message}
          </p>
          {/*
            A conflict is the one refusal with a next step, and the panel says
            what it is rather than leaving an editor to work out that "reload"
            means the browser's button and their unsaved text with it.
          */}
          {failure.reason === "conflict" ? (
            <button
              type="button"
              onClick={onReloadLayout}
              disabled={busy}
              className="admin-btn admin-btn-sm mt-1.5 w-full justify-center"
            >
              Reload latest layout
            </button>
          ) : null}
        </div>
      ) : null}

      {adding && canManage ? (
        <BlockPicker
          blocks={blocks}
          after={selectedSectionId}
          disabled={busy}
          onPick={(blockType, after) => {
            setAdding(false);
            ops.onAdd(blockType, after);
          }}
          onClose={() => setAdding(false)}
        />
      ) : null}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!order.length ? (
          <p className="px-1.5 text-[0.76rem] leading-relaxed text-muted">
            {ready ? "This layout has no sections yet." : "Waiting for the canvas…"}
          </p>
        ) : (
          <ol className="flex flex-col gap-0.5">
            {order.map((section, index) => {
              const active = section.sectionId === selectedSectionId;
              return (
                <li
                  key={section.sectionId}
                  data-section-id={section.sectionId}
                  draggable={canManage && !busy}
                  onDragStart={(event) => {
                    setDragging(index);
                    event.dataTransfer.effectAllowed = "move";
                    event.dataTransfer.setData("text/plain", String(section.sectionId));
                  }}
                  onDragOver={(event) => {
                    if (dragging === null) return;
                    event.preventDefault();
                    event.dataTransfer.dropEffect = "move";
                    setOver(index);
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    dropOnto(index);
                  }}
                  onDragEnd={() => {
                    setDragging(null);
                    setOver(null);
                  }}
                  data-dragging={dragging === index || undefined}
                  data-over={over === index && dragging !== index ? true : undefined}
                  className="rounded-[var(--radius-xs)] transition-colors data-[dragging]:opacity-45 data-[over]:bg-[color-mix(in_oklab,var(--color-orange)_14%,transparent)]"
                >
                  <button
                    type="button"
                    onClick={() => onSelect(section.address)}
                    aria-current={active ? "true" : undefined}
                    className="flex w-full flex-col gap-0.5 rounded-[var(--radius-xs)] border px-2.5 py-1.5 text-start transition-colors"
                    style={{
                      borderColor: active ? "var(--color-orange)" : "transparent",
                      background: active ? "color-mix(in oklab, var(--color-orange) 12%, transparent)" : "transparent",
                    }}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[0.8rem] font-medium text-strong">
                        {blockNameOf(section.blockType)}
                      </span>
                      {/* Badges, not colours: the state has to survive a screenshot
                          in greyscale and a screen reader reading the row. */}
                      {dirtyIds.has(section.sectionId) ? <Badge tone="draft">Unsaved</Badge> : null}
                      {section.isDraftOnly ? <Badge tone="new">New</Badge> : null}
                      {section.isDraft && !section.isDraftOnly ? <Badge tone="draft">Draft</Badge> : null}
                      {!section.visible ? <Badge tone="muted">Will hide</Badge> : null}
                    </span>
                    <span className="truncate text-[0.68rem] text-muted">{section.blockType}</span>
                  </button>

                  {canManage ? (
                    <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
                      <RowButton
                        label="Move up"
                        icon="chevronDown"
                        rotate
                        disabled={busy || index === 0}
                        onClick={() => ops.onMove(section.sectionId, "up")}
                      />
                      <RowButton
                        label="Move down"
                        icon="chevronDown"
                        disabled={busy || index === order.length - 1}
                        onClick={() => ops.onMove(section.sectionId, "down")}
                      />
                      <RowButton
                        label="Duplicate"
                        icon="layers"
                        disabled={busy}
                        onClick={() => ops.onDuplicate(section.sectionId)}
                      />
                      <RowButton
                        label={
                          section.visible
                            ? "Hide when the layout is published"
                            : "Show when the layout is published"
                        }
                        icon={section.visible ? "eyeOff" : "eye"}
                        disabled={busy}
                        onClick={() => ops.onVisibility(section.sectionId, !section.visible)}
                      />
                      <RowButton
                        label="Remove from the layout"
                        icon="trash"
                        disabled={busy}
                        onClick={() => ops.onRemove(section.sectionId)}
                      />
                    </div>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}

        {removed.length ? (
          <div className="mt-3 border-t border-[var(--admin-line)] pt-2.5" data-removed-sections>
            <p className="mb-1.5 px-1.5 text-[0.66rem] font-semibold uppercase tracking-[0.07em] text-muted">
              Removed from the layout
            </p>
            <ul className="flex flex-col gap-1">
              {removed.map((section) => (
                <li
                  key={section.sectionId}
                  data-removed-id={section.sectionId}
                  className="flex items-center justify-between gap-1.5 px-1.5"
                >
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[0.76rem] text-body">{section.blockName}</span>
                      {section.isDraftOnly ? <Badge tone="new">New</Badge> : null}
                      {dirtyIds.has(section.sectionId) ? <Badge tone="draft">Unsaved</Badge> : null}
                    </span>
                    <span className="block truncate text-[0.66rem] text-muted">
                      {section.summary || section.blockType}
                    </span>
                  </span>
                  {canManage ? (
                    <button
                      type="button"
                      onClick={() => ops.onRestore(section.sectionId)}
                      disabled={busy}
                      className="admin-btn admin-btn-sm shrink-0"
                    >
                      Restore
                    </button>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

/**
 * The list of blocks that may be added, from the registry the admin form is
 * generated from. Deprecated types are already absent from it, so there is no
 * second list here to keep in step — and nothing typed by an editor reaches the
 * server but a block type the registry recognises.
 */
function BlockPicker({
  blocks,
  after,
  disabled,
  onPick,
  onClose,
}: {
  blocks: BlockDef[];
  after: number | null;
  disabled: boolean;
  onPick: (blockType: string, after: number | null) => void;
  onClose: () => void;
}) {
  return (
    <div
      className="mx-2 mb-2 shrink-0 rounded-[var(--radius-xs)] border border-[var(--admin-line)] bg-[var(--admin-bg)] p-2"
      data-block-picker
    >
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <p className="text-[0.68rem] font-semibold uppercase tracking-wide text-muted">
          {after ? "Add after the selected section" : "Add at the end"}
        </p>
        <button type="button" onClick={onClose} className="text-[0.68rem] text-muted hover:text-strong">
          Close
        </button>
      </div>
      <ul className="max-h-64 overflow-y-auto">
        {blocks.map((block) => (
          <li key={block.type}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(block.type, after)}
              data-block-type={block.type}
              className="w-full rounded-[var(--radius-xs)] px-2 py-1.5 text-start transition-colors hover:bg-[color-mix(in_oklab,var(--color-orange)_12%,transparent)]"
            >
              <span className="block truncate text-[0.76rem] text-strong">{block.name}</span>
              <span className="block truncate text-[0.66rem] text-muted">{block.description}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RowButton({
  label,
  icon,
  rotate,
  disabled,
  onClick,
}: {
  label: string;
  icon: string;
  rotate?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      title={label}
      className="admin-btn admin-btn-sm px-1.5"
    >
      <Icon name={icon} size={11} className={rotate ? "rotate-180" : undefined} />
    </button>
  );
}

function Badge({ tone, children }: { tone: "draft" | "new" | "muted"; children: React.ReactNode }) {
  const colour =
    tone === "new" ? "#5ad19a" : tone === "draft" ? "var(--color-peach)" : "var(--color-muted)";
  return (
    <span
      className="shrink-0 rounded-full border px-1.5 text-[0.6rem] font-semibold uppercase tracking-wide"
      style={{ borderColor: `color-mix(in oklab, ${colour} 45%, transparent)`, color: colour }}
    >
      {children}
    </span>
  );
}
