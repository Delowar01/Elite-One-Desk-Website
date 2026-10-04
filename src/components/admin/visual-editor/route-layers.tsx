"use client";

import { useEffect, useMemo, useState } from "react";

import { Icon } from "@/components/ui/icon";
import type { Locale } from "@/lib/i18n/config";
import { blockNameOf } from "@/lib/visual-editor/labels";
import type { EditorSectionMeta } from "@/lib/visual-editor/protocol";
import { ancestorAddresses, buildLayerTree } from "@/lib/visual-editor/tree";

import { Badge, editableOf, LayerRow, LockButton, NO_ADDRESSES, RowButton } from "./layers";

/**
 * Layers for a dynamic route (Batch 21): the page's regions, nested as the
 * page nests them — a group holds its cards, a questions section its
 * questions — each opening into its fields, exactly as a page section does.
 * A category's page and a service's own page (Batch 22) are drawn by this one
 * panel.
 *
 * Built from what the canvas rendered, like page Layers: the regions and their
 * nesting come over the bridge (`parent`), so the tree is a view of what can
 * be pointed at rather than of what the database permits. Names come from the
 * page itself — a card is called by its title, a question by its question —
 * so nobody has to recognise a service by its id.
 *
 * What it does not offer is a page's layout tools. A route's regions are the
 * template's: nothing is added, duplicated or removed here. What an
 * editor may change is what the records support — the order of the groups,
 * of the cards in a group and of the questions, and whether each is shown —
 * and each of those is a draft of the record, published with the rest.
 */

/** The regions that can be reordered and hidden, and what they are called. */
const MOVABLE = new Set(["route-subcategory", "route-service-card", "route-faq"]);
/** Regions with nothing to type at all: the site's own chrome. */
const GENERATED = new Set(["route-category-crumbs", "route-service-crumbs", "route-service-notices"]);

/** A region's name in the tree: its own words where it has some, its block's name otherwise. */
function regionLabel(section: EditorSectionMeta): string {
  const own = (path: string) => section.nodes.find((node) => node.relativePath === path)?.text;
  switch (section.blockType) {
    case "route-category-hero":
    case "route-service-hero":
      return "Hero";
    case "route-subcategory":
      return own("field:title") ?? "Group";
    case "route-service-card":
      return own("field:title") ?? "Service";
    case "route-faq":
      return own("field:question") ?? "Question";
    default:
      return blockNameOf(section.blockType);
  }
}

type Branch = { section: EditorSectionMeta; children: Branch[] };

function nest(sections: EditorSectionMeta[]): Branch[] {
  const byAddress = new Map<string, Branch>(sections.map((section) => [section.address, { section, children: [] }]));
  const roots: Branch[] = [];
  for (const section of sections) {
    const branch = byAddress.get(section.address)!;
    const parent = section.parent ? byAddress.get(section.parent) : undefined;
    if (parent) parent.children.push(branch);
    else roots.push(branch);
  }
  return roots;
}

export function RouteLayersPanel({
  kind = "category",
  title,
  sections,
  selectedSectionId,
  selectedAddress,
  locks,
  locale,
  valuesOf,
  dirtyIds,
  ready,
  canStructure,
  canEditText,
  onSelect,
  onToggleLock,
  onEditText,
  onMove,
  onVisibility,
  busy,
}: {
  /** Which kind of page this is, for the panel's own heading (Batch 22). */
  kind?: "category" | "service";
  title: string;
  sections: EditorSectionMeta[];
  selectedSectionId: number | null;
  selectedAddress: string | null;
  locks: string[];
  locale: Locale;
  valuesOf: (sectionId: number) => Record<string, unknown> | undefined;
  dirtyIds: Set<number>;
  ready: boolean;
  /** `content.structure` and the resource capability: order and visibility. */
  canStructure: boolean;
  canEditText: boolean;
  onSelect: (address: string) => void;
  onToggleLock: (address: string) => void;
  onEditText: (address: string) => void;
  onMove: (section: EditorSectionMeta, direction: "up" | "down") => void;
  onVisibility: (section: EditorSectionMeta, visible: boolean) => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  const tree = useMemo(() => nest(sections), [sections]);
  const lockSet = useMemo(() => new Set(locks), [locks]);

  // The tree opens to whatever the canvas selected — the region's ancestors
  // among the regions, and the node's ancestors inside it.
  useEffect(() => {
    if (!selectedAddress) return;
    setOpen((current) => {
      const next = new Set(current);
      let changed = false;
      const add = (address: string) => {
        if (!next.has(address)) {
          next.add(address);
          changed = true;
        }
      };
      const owner = sections.find((section) => selectedAddress.startsWith(section.address) && (selectedAddress === section.address || selectedAddress.startsWith(`${section.address}/`)));
      for (let parent = owner?.parent; parent; parent = sections.find((section) => section.address === parent)?.parent) {
        add(parent);
      }
      for (const ancestor of ancestorAddresses(selectedAddress).slice(0, -1)) add(ancestor);
      return changed ? next : current;
    });
  }, [selectedAddress, sections]);

  const toggle = (address: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(address)) next.delete(address);
      else next.add(address);
      return next;
    });

  const renderBranch = (branch: Branch, siblings: Branch[]) => {
    const { section } = branch;
    const label = regionLabel(section);
    const active = section.sectionId === selectedSectionId;
    const expanded = open.has(section.address);
    const movable = MOVABLE.has(section.blockType);
    const nodes = buildLayerTree(section.blockType, section.nodes, { values: valuesOf(section.sectionId), locale });
    const sameKind = siblings.filter((entry) => entry.section.blockType === section.blockType);
    const at = sameKind.indexOf(branch);
    return (
      <li key={section.address} data-section-id={section.sectionId} data-route-region={section.blockType}>
        <div className="flex items-stretch gap-0.5">
          <button
            type="button"
            onClick={() => toggle(section.address)}
            aria-expanded={expanded}
            aria-label={expanded ? `Collapse ${label}` : `Expand ${label}`}
            data-layer-toggle={section.address}
            disabled={!nodes.length && !branch.children.length}
            className="shrink-0 rounded-[var(--radius-xs)] px-1 text-muted transition-colors enabled:hover:text-strong disabled:opacity-30"
          >
            <Icon name="chevronDown" size={11} className={expanded ? undefined : "-rotate-90"} />
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
              <span className="truncate text-[0.8rem] font-medium text-strong">{label}</span>
              {dirtyIds.has(section.sectionId) ? <Badge tone="draft">Unsaved</Badge> : null}
              {section.isDraft ? <Badge tone="draft">Draft</Badge> : null}
              {!section.visible ? <Badge tone="muted">Hidden</Badge> : null}
              {GENERATED.has(section.blockType) ? <Badge tone="muted">Generated</Badge> : null}
              {lockSet.has(section.address) ? <Badge tone="muted">Locked</Badge> : null}
            </span>
            <span className="truncate text-[0.68rem] text-muted">{blockNameOf(section.blockType)}</span>
          </button>
          <LockButton address={section.address} locked={lockSet.has(section.address)} label={label} onToggle={onToggleLock} />
        </div>

        {movable && canStructure ? (
          <div className="flex items-center gap-0.5 px-1.5 pb-1.5" data-route-ops={section.address}>
            <RowButton
              label={`Move ${label} up`}
              icon="chevronDown"
              rotate
              disabled={busy || at <= 0}
              onClick={() => onMove(section, "up")}
            />
            <RowButton
              label={`Move ${label} down`}
              icon="chevronDown"
              disabled={busy || at < 0 || at >= sameKind.length - 1}
              onClick={() => onMove(section, "down")}
            />
            <RowButton
              label={section.visible ? `Hide ${label} when published` : `Show ${label} when published`}
              icon={section.visible ? "eyeOff" : "eye"}
              disabled={busy}
              onClick={() => onVisibility(section, !section.visible)}
            />
          </div>
        ) : null}

        {expanded && (nodes.length || branch.children.length) ? (
          <ul
            className="mt-0.5 flex flex-col gap-0.5 border-s border-[var(--admin-line)] ps-1.5 ms-3"
            data-layer-children={section.address}
          >
            {nodes.map((node) => (
              <LayerRow
                key={node.address}
                node={node}
                open={open}
                lockSet={lockSet}
                selectedAddress={selectedAddress}
                editable={canEditText ? editableOf(section) : NO_ADDRESSES}
                linked={NO_ADDRESSES}
                onToggleOpen={toggle}
                onSelect={onSelect}
                onToggleLock={onToggleLock}
                onEditText={onEditText}
              />
            ))}
            {branch.children.map((child) => renderBranch(child, branch.children))}
          </ul>
        ) : null}
      </li>
    );
  };

  return (
    <aside
      className="hidden w-60 shrink-0 flex-col border-e border-[var(--admin-line)] bg-[var(--admin-shell)] xl:flex"
      aria-label="Page structure"
      data-route-layers
    >
      <div className="shrink-0 px-3.5 pb-2 pt-3.5">
        <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted">
          {kind === "service" ? "Service" : "Service category"}
        </h2>
        <p className="mt-0.5 truncate text-[0.78rem] text-strong">{title}</p>
      </div>
      {canStructure ? null : (
        <p className="mx-3.5 mb-2 shrink-0 text-[0.68rem] leading-relaxed text-muted" role="note" data-permission-note="content.structure">
          {kind === "service"
            ? "You can view this page’s structure, but your role does not allow reordering or hiding its questions."
            : "You can view this page’s structure, but your role does not allow reordering or hiding its groups, services or questions."}
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!tree.length ? (
          <p className="px-1.5 text-[0.76rem] leading-relaxed text-muted">
            {ready ? "Nothing on this page can be selected." : "Waiting for the canvas…"}
          </p>
        ) : (
          <ol className="flex flex-col gap-0.5">{tree.map((branch) => renderBranch(branch, tree))}</ol>
        )}
      </div>
    </aside>
  );
}
