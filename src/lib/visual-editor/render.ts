import { formatAddress, formatNodePath, parseNodePath, type NodePath } from "@/lib/cms/address";
import { isItemId } from "@/lib/cms/item-id";
import { directEditAt } from "./tree";

/**
 * How the real public renderer marks the things an editor can point at.
 *
 * The rule this module exists to keep: **the marks appear only for an
 * authorised Visual Editor canvas.** `editor` is `null` on every ordinary
 * request — a visitor's, and an ordinary `?preview=1` — and every function here
 * returns an empty object for it, so the attributes are not merely ignored on a
 * public page, they are never written. One `if` in one file, rather than a
 * condition in each of twenty blocks.
 *
 * The other rule: an address is built by the Batch 2 formatter, never by string
 * concatenation in a component. `section:42/field:links/item:i_…/field:label`
 * has a grammar, and twenty blocks each assembling it by hand is twenty chances
 * to produce something the parser will refuse.
 */

export type EditorNodeKind = "section" | "field" | "item" | "slot";

/**
 * What a block is told about editor mode. Deliberately three fields: the block
 * needs to name its own nodes and nothing else. Selection, the inspector, the
 * bridge id and the session are the editor's business, not a block's.
 */
export type EditorRender = {
  sectionId: number;
  blockType: string;
} | null;

/** The attributes themselves. One namespace, so a sweep for `data-eod-` finds all of them. */
export type EditorAttrs = {
  "data-eod-node"?: "";
  "data-eod-address"?: string;
  "data-eod-kind"?: EditorNodeKind;
  "data-eod-section"?: string;
  "data-eod-block"?: string;
  /**
   * This node's text may be typed into on the canvas, and whether it takes
   * more than one line.
   *
   * Decided here, from the block registry, rather than by the canvas looking at
   * the element: whether something is a plain-text field is a fact about the
   * block's declaration, and the canvas has no access to that. Absent means the
   * inspector is where it is edited, which is true of every field and is only
   * *only* true of the rest — a picture, a link, a number, a switch, and rich
   * text, which has a sanitizer and an editor of its own.
   */
  "data-eod-edit"?: "text" | "multiline";
};

const NONE: EditorAttrs = {};

/**
 * Attributes for one node, or nothing at all.
 *
 * `path` is section-relative (`field:headline`, `field:links/item:i_…`), the
 * same vocabulary Batch 2 persists styles under; the section id is added here.
 * A path the parser refuses produces no attributes rather than a broken
 * address: an unaddressable element is invisible to the editor, which is
 * recoverable, while a malformed address in the DOM is a message the bridge
 * would have to reject later, further from the cause.
 */
export function editorNodeAttrs(
  editor: EditorRender | undefined,
  spec: { path?: string | NodePath; kind: EditorNodeKind },
): EditorAttrs {
  if (!editor) return NONE;

  /**
   * An empty path is the section's own root, and *only* a section has one.
   *
   * This distinction is load-bearing. `itemPath` returns `undefined` for a row
   * with no usable `_id` — a row written before the backfill, or edited by
   * hand — and treating that as "root" would annotate the row with the
   * section's address and the item's kind: a node claiming to be a list row
   * while pointing at the whole section. Not selectable is the right answer
   * there; wrongly selectable is not.
   */
  if (spec.path === undefined && spec.kind !== "section") return NONE;

  const path: NodePath | null =
    spec.path === undefined || spec.path === "root"
      ? []
      : typeof spec.path === "string"
        ? parseNodePath(spec.path)
        : spec.path;
  if (!path) return NONE;
  if (spec.kind === "section" && path.length) return NONE;
  if (spec.kind !== "section" && path.length === 0) return NONE;

  const attrs: EditorAttrs = {
    "data-eod-node": "",
    "data-eod-address": formatAddress(editor.sectionId, path),
    "data-eod-kind": spec.kind,
  };
  // Only the root carries them: everything inside it finds its owner with one
  // `closest()`, and repeating the pair on every field would be bytes for
  // nothing on a page with a hundred nodes.
  if (spec.kind === "section") {
    attrs["data-eod-section"] = String(editor.sectionId);
    attrs["data-eod-block"] = editor.blockType;
  } else {
    const edit = directEditAt(editor.blockType, formatNodePath(path));
    if (edit) attrs["data-eod-edit"] = edit.multiline ? "multiline" : "text";
  }
  return attrs;
}

/**
 * A block's own little annotator, so the call sites read as markup rather than
 * as plumbing:
 *
 *     const node = editorNode(editor);
 *     <h1 {...node("field:headline")}>
 *     <li {...node(itemPath("links", row), "item")}>
 */
export function editorNode(editor: EditorRender | undefined) {
  return (path: string | NodePath | undefined, kind: EditorNodeKind = "field"): EditorAttrs =>
    editorNodeAttrs(editor, { path, kind });
}

/**
 * The path of one row in a repeatable list.
 *
 * `undefined` when the row has no usable `_id` — a document written before the
 * backfill, or one somebody edited by hand. That row is then simply not
 * selectable, which is the safe failure: the alternative is an index address,
 * and an index address is wrong the moment anyone reorders the list. The
 * identity has to be the row's, not its position's.
 */
export function itemPath(field: string, row: { _id?: string } | Record<string, unknown>): string | undefined {
  const id = (row as Record<string, unknown>)._id;
  return isItemId(id) ? `field:${field}/item:${id}` : undefined;
}

/** The path of a field inside a repeatable row, or nothing when the row has no id. */
export function itemFieldPath(
  field: string,
  row: Record<string, unknown>,
  name: string,
): string | undefined {
  const base = itemPath(field, row);
  return base ? `${base}/field:${name}` : undefined;
}
