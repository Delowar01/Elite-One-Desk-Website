import type { CSSProperties } from "react";

import {
  editorNodeAttrs,
  type EditorAttrs,
  type EditorNodeKind,
  type EditorRender,
} from "@/lib/visual-editor/render";
import { nodeStyle } from "./style-css";
import type { StyleDocument } from "./styles";

/**
 * One helper, two answers, from one stable path.
 *
 * A block names a node once — `node("field:headline")` — and gets back both the
 * editor's selection attributes and the node's style overrides. Naming it twice,
 * once for each, is how the two eventually point at different elements: the
 * inspector would select the `<h1>` and the style would land on the wrapper.
 *
 * The two halves are produced independently, and that independence is the rule
 * this module exists to hold:
 *
 *   · **Editor attributes** appear only for an authorised canvas. `editor` is
 *     null on every ordinary request, and then no `data-eod-*` is written at
 *     all — not written and ignored, never written.
 *   · **Style** is always applied, to visitors included. Published overrides are
 *     part of the page, not part of the editor, so nothing about them may
 *     depend on `data-eod-*`, on editor mode, or on the bridge. A visitor gets
 *     the same `<h1 style=…>` an editor sees; they simply get no way to select
 *     it.
 */
export type NodeAttrs = EditorAttrs & { style?: CSSProperties };

/** What a block needs to annotate and style its own nodes. */
export type NodeSource = {
  editor?: EditorRender;
  /** Already validated, already resolved to what this render should show. */
  styles?: StyleDocument;
};

export function blockNode(source: NodeSource) {
  return (path: string | undefined, kind: EditorNodeKind = "field"): NodeAttrs => {
    const attrs: NodeAttrs = { ...editorNodeAttrs(source.editor ?? null, { path, kind }) };
    const style = nodeStyle(source.styles, path);
    if (style) attrs.style = style;
    return attrs;
  };
}

/**
 * Merges a node's overrides onto a style a component sets for itself.
 *
 * A handful of blocks paint a gradient or a mask inline. Spreading `node(...)`
 * onto those would replace that with the override, or the other way round
 * depending on attribute order — so they compose the two explicitly and the
 * override wins, which is what an override is.
 */
export const withNodeStyle = (own: CSSProperties, attrs: NodeAttrs): CSSProperties =>
  attrs.style ? { ...own, ...attrs.style } : own;
