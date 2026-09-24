"use client";

import { useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "@/components/ui/icon";
import type { BlockDef } from "@/lib/cms/blocks";
import type { Locale } from "@/lib/i18n/config";
import { blockNameOf } from "@/lib/visual-editor/labels";
import type { EditorSectionMeta } from "@/lib/visual-editor/protocol";
import { ancestorAddresses, buildLayerTree, type LayerNode } from "@/lib/visual-editor/tree";
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
 * Every section opens into the nodes inside it — its fields, its repeatable
 * rows and the fields inside those — built from the addresses the canvas
 * reported and nested by parsing them. Nothing is invented: a field the page
 * did not draw has no annotated element, so it has no row, and the tree is
 * therefore a view of what can actually be pointed at rather than of what the
 * registry permits.
 *
 * Collapsed by default, because a page with two hundred nodes expanded is
 * accurate and unusable. The tree opens itself to whatever the canvas has
 * selected, which is the one thing an editor always wants to see.
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
  selectedAddress,
  locks,
  locale,
  valuesOf,
  dirtyIds,
  ready,
  canManage,
  busy,
  failure,
  onReloadLayout,
  blocks,
  ops,
  onSelect,
  onToggleLock,
  onEditText,
}: {
  sections: EditorSectionMeta[];
  structure: PageStructure | null;
  removed: PageStructureSection[];
  selectedSectionId: number | null;
  /** The exact node the canvas has selected, so the tree can open to it. */
  selectedAddress: string | null;
  /** Addresses the canvas pointer ignores. Still selectable from here. */
  locks: string[];
  locale: Locale;
  /** The section's loaded values, for naming a row nothing on screen shows. */
  valuesOf: (sectionId: number) => Record<string, unknown> | undefined;
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
  onToggleLock: (address: string) => void;
  onEditText: (address: string) => void;
}) {
  const [order, setOrder] = useState<EditorSectionMeta[]>(sections);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  /**
   * Which rows are open. Addresses, not indexes: a section that moves keeps
   * whatever the editor had open inside it.
   */
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const signature = sections.map((s) => `${s.sectionId}:${s.visible}`).join(",");

  /**
   * The tree opens to whatever the canvas selected, and the row scrolls into
   * view.
   *
   * Opening ancestors rather than replacing what is open: an editor who has
   * three sections expanded did not ask for two of them to close because they
   * clicked a heading in the third.
   */
  useEffect(() => {
    if (!selectedAddress) return;
    setOpen((current) => {
      const next = new Set(current);
      let changed = false;
      // The node itself is not opened — only what contains it.
      for (const ancestor of ancestorAddresses(selectedAddress).slice(0, -1)) {
        if (!next.has(ancestor)) {
          next.add(ancestor);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [selectedAddress]);

  const toggleOpen = (address: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      return next;
    });

  const lockSet = useMemo(() => new Set(locks), [locks]);

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
                  <div className="flex items-stretch gap-0.5">
                    <button
                      type="button"
                      onClick={() => toggleOpen(section.address)}
                      aria-expanded={open.has(section.address)}
                      aria-label={
                        open.has(section.address)
                          ? `Collapse ${blockNameOf(section.blockType)}`
                          : `Expand ${blockNameOf(section.blockType)}`
                      }
                      data-layer-toggle={section.address}
                      disabled={!section.nodes.length}
                      className="shrink-0 rounded-[var(--radius-xs)] px-1 text-muted transition-colors enabled:hover:text-strong disabled:opacity-30"
                    >
                      <Icon
                        name="chevronDown"
                        size={11}
                        className={open.has(section.address) ? undefined : "-rotate-90"}
                      />
                    </button>
                    <button
                    type="button"
                    onClick={() => onSelect(section.address)}
                    aria-current={active ? "true" : undefined}
                    data-layer-row={section.address}
                    className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-[var(--radius-xs)] border px-2.5 py-1.5 text-start transition-colors"
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
                      {lockSet.has(section.address) ? <Badge tone="muted">Locked</Badge> : null}
                    </span>
                    <span className="truncate text-[0.68rem] text-muted">{section.blockType}</span>
                  </button>
                    <LockButton
                      address={section.address}
                      locked={lockSet.has(section.address)}
                      label={blockNameOf(section.blockType)}
                      onToggle={onToggleLock}
                    />
                  </div>

                  {open.has(section.address) && section.nodes.length ? (
                    <ul
                      className="mt-0.5 flex flex-col gap-0.5 border-s border-[var(--admin-line)] ps-1.5 ms-3"
                      data-layer-children={section.address}
                    >
                      {buildLayerTree(section.blockType, section.nodes, {
                        values: valuesOf(section.sectionId),
                        locale,
                      }).map((node) => (
                        <LayerRow
                          key={node.address}
                          node={node}
                          open={open}
                          lockSet={lockSet}
                          selectedAddress={selectedAddress}
                          editable={editableOf(section)}
                          onToggleOpen={toggleOpen}
                          onSelect={onSelect}
                          onToggleLock={onToggleLock}
                          onEditText={onEditText}
                        />
                      ))}
                    </ul>
                  ) : null}

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
 * Which of a section's nodes the renderer marked as directly editable.
 *
 * Read off the canvas's own report rather than re-derived here: the renderer
 * decided it from the block registry at the moment it drew the page, and a
 * second opinion computed in the panel is a second thing to keep in step.
 */
const editableOf = (section: EditorSectionMeta): Set<string> =>
  new Set(section.nodes.filter((node) => node.edit).map((node) => node.address));

/** What each kind of node is called, in words, beside its icon. */
const GROUP: Record<LayerNode["group"], { icon: string; word: string }> = {
  section: { icon: "layers", word: "Section" },
  item: { icon: "route", word: "Item" },
  media: { icon: "fileText", word: "Image" },
  link: { icon: "arrowUpRight", word: "Link" },
  field: { icon: "quote", word: "Field" },
};

/**
 * One row of the tree, and its children.
 *
 * The status words are words. A locked row says "Locked" and an openable one
 * names what it would open, because a screen reader gets nothing from a tint
 * and neither does a greyscale screenshot.
 */
function LayerRow({
  node,
  open,
  lockSet,
  selectedAddress,
  editable,
  onToggleOpen,
  onSelect,
  onToggleLock,
  onEditText,
}: {
  node: LayerNode;
  open: Set<string>;
  lockSet: Set<string>;
  selectedAddress: string | null;
  editable: Set<string>;
  onToggleOpen: (address: string) => void;
  onSelect: (address: string) => void;
  onToggleLock: (address: string) => void;
  onEditText: (address: string) => void;
}) {
  const row = useRef<HTMLButtonElement>(null);
  const active = selectedAddress === node.address;
  const expanded = open.has(node.address);
  const group = GROUP[node.group];

  /**
   * The selected row is brought into view.
   *
   * `nearest` rather than `center`: the panel should move as little as it can
   * to show the row, because an editor clicking around the canvas watching the
   * tree follow them does not want the list jumping to the middle each time.
   */
  useEffect(() => {
    if (active) row.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <li data-layer-node={node.address} data-layer-kind={node.kind}>
      <div className="flex items-stretch gap-0.5">
        <button
          type="button"
          onClick={() => onToggleOpen(node.address)}
          aria-expanded={node.children.length ? expanded : undefined}
          aria-label={expanded ? `Collapse ${node.label}` : `Expand ${node.label}`}
          disabled={!node.children.length}
          data-layer-toggle={node.address}
          className="shrink-0 rounded-[var(--radius-xs)] px-1 text-muted transition-colors enabled:hover:text-strong disabled:opacity-0"
        >
          <Icon name="chevronDown" size={10} className={expanded ? undefined : "-rotate-90"} />
        </button>
        <button
          ref={row}
          type="button"
          onClick={() => onSelect(node.address)}
          onDoubleClick={() => editable.has(node.address) && onEditText(node.address)}
          aria-current={active ? "true" : undefined}
          data-layer-row={node.address}
          className="flex min-w-0 flex-1 items-center gap-1.5 rounded-[var(--radius-xs)] border px-1.5 py-1 text-start transition-colors"
          style={{
            borderColor: active ? "var(--color-orange)" : "transparent",
            background: active ? "color-mix(in oklab, var(--color-orange) 12%, transparent)" : "transparent",
          }}
        >
          <Icon name={group.icon} size={10} className="shrink-0 text-muted" />
          <span className="truncate text-[0.74rem] text-body">{node.label}</span>
          <span className="sr-only">{group.word}</span>
          {lockSet.has(node.address) ? <Badge tone="muted">Locked</Badge> : null}
        </button>
        {editable.has(node.address) ? (
          <button
            type="button"
            onClick={() => onEditText(node.address)}
            aria-label={`Edit ${node.label} text on the canvas`}
            title="Edit text on the canvas"
            data-layer-edit={node.address}
            className="shrink-0 rounded-[var(--radius-xs)] px-1 text-muted transition-colors hover:text-strong"
          >
            <Icon name="quote" size={10} />
          </button>
        ) : null}
        <LockButton
          address={node.address}
          locked={lockSet.has(node.address)}
          label={node.label}
          onToggle={onToggleLock}
        />
      </div>

      {expanded && node.children.length ? (
        <ul
          className="mt-0.5 flex flex-col gap-0.5 border-s border-[var(--admin-line)] ps-1.5 ms-2"
          data-layer-children={node.address}
        >
          {node.children.map((child) => (
            <LayerRow
              key={child.address}
              node={child}
              open={open}
              lockSet={lockSet}
              selectedAddress={selectedAddress}
              editable={editable}
              onToggleOpen={onToggleOpen}
              onSelect={onSelect}
              onToggleLock={onToggleLock}
              onEditText={onEditText}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Lock and unlock.
 *
 * Named in words on the control itself, because "what does this padlock mean
 * right now" is exactly the question an icon cannot answer. It is an editing
 * convenience and the title says so: it stops the canvas pointer reaching the
 * node, and it is not a permission — the server's checks are unchanged and the
 * node is still selectable from this panel.
 */
function LockButton({
  address,
  locked,
  label,
  onToggle,
}: {
  address: string;
  locked: boolean;
  label: string;
  onToggle: (address: string) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onToggle(address)}
      aria-pressed={locked}
      aria-label={locked ? `Unlock ${label}` : `Lock ${label} against canvas clicks`}
      title={locked ? "Unlock: the canvas can select this again" : "Lock: the canvas pointer will skip this"}
      data-layer-lock={address}
      className="shrink-0 rounded-[var(--radius-xs)] px-1 transition-colors"
      style={{ color: locked ? "var(--color-orange)" : "var(--color-muted)" }}
    >
      <Icon name="shield" size={10} />
    </button>
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
