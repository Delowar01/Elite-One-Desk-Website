import { parseNodePath } from "@/lib/cms/address";

/**
 * What the Visual Editor's content panel knows about one section.
 *
 * Deliberately a small, explicit document rather than the database row. The
 * inspector needs the values, the block type and the revision it must name when
 * it saves; it has no business holding `published` beside `draft`, a position,
 * or a foreign key it could accidentally write back. Everything here is
 * produced server-side by `loadVisualSection` and treated by the client as the
 * last authoritative reading — never as the store.
 *
 * `revision` is the whole of the concurrency contract on the client: the panel
 * reads it, sends it back with the save, and replaces it with whatever the
 * server returns. It never invents one and never increments one itself.
 */
export type VisualSectionData = {
  sectionId: number;
  pageId: number;
  blockType: string;
  revision: number;
  hasDraft: boolean;
  isDraftOnly: boolean;
  /**
   * Draft values if there are any, otherwise the published ones — completed
   * against the block registry and passed through the same validator a save
   * uses, so what the panel shows is exactly what a save of it would store.
   */
  values: Record<string, unknown>;
};

/**
 * Why a section could not be read or written.
 *
 * `missing` and `wrong_page` are kept apart because they are different
 * accidents: the first is a section that has been deleted underneath the
 * editor, the second is an editor asking this page's canvas about a section
 * belonging to another page — which is a bug, not a race, and is refused rather
 * than quietly obeyed.
 */
export type VisualLoadFailure = "missing" | "wrong_page" | "unknown_block" | "denied";

export type VisualSectionLoad =
  | { ok: true; section: VisualSectionData }
  | { ok: false; reason: VisualLoadFailure; message: string };

/**
 * The answer to a draft save.
 *
 * A conflict carries the server's current reading of the section, because the
 * only useful thing to offer after losing a race is the version that won it.
 * The panel shows it behind "Reload latest" rather than merging silently — a
 * merge nobody asked for is how two people's edits become one person's.
 */
export type VisualContentSaveResult =
  | { ok: true; section: VisualSectionData }
  | { ok: false; reason: "conflict"; message: string; section: VisualSectionData }
  | { ok: false; reason: VisualLoadFailure | "invalid"; message: string };

/** Which registry field — and which repeatable row — a selected node sits in. */
export type FieldFocus = { field: string; itemId: string | null } | null;

/**
 * Reads a node's relative path back into the field it belongs to.
 *
 * `field:links/item:i_8Gk3pZmQ2v/field:label` is the label of one row of the
 * `links` list, so the panel should open `links` and point at that row. The
 * path is parsed with the address parser rather than split here, so there is
 * still exactly one definition of what a path is.
 */
export function focusOf(relativePath: string): FieldFocus {
  const path = parseNodePath(relativePath);
  if (!path?.length) return null;
  const first = path[0];
  if (!first || first.kind !== "field") return null;
  const item = path.find((segment) => segment.kind === "item");
  return { field: first.name, itemId: item?.name ?? null };
}
