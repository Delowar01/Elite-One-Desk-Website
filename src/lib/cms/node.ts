import type { CSSProperties } from "react";

import {
  editorNodeAttrs,
  type EditorAttrs,
  type EditorNodeKind,
  type EditorRender,
} from "@/lib/visual-editor/render";
import {
  mediaNodeStyle,
  nodeStyle,
  responsiveMediaStyle,
  responsiveStyle,
  type ResponsiveStyle,
} from "./style-css";
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
/**
 * What a node's responsive overrides look like in markup.
 *
 * Two attributes, whose *values* are lists of declaration names the stylesheet
 * has fixed rules for. Deliberately outside the `data-eod-` namespace: that one
 * means "editor plumbing" and is swept for on public pages, and these are part
 * of the page a visitor gets.
 */
export type ResponsiveAttrs = { "data-rs-t"?: string; "data-rs-m"?: string };

export type NodeAttrs = EditorAttrs & ResponsiveAttrs & { style?: CSSProperties };

/** Base style and responsive variables are one style object on one element. */
const withVars = (
  base: CSSProperties | undefined,
  responsive: ResponsiveStyle | undefined,
): CSSProperties | undefined => {
  if (!responsive || !Object.keys(responsive.vars).length) return base;
  return { ...base, ...responsive.vars } as CSSProperties;
};

/** What a block needs to annotate and style its own nodes. */
export type NodeSource = {
  editor?: EditorRender;
  /** Already validated, already resolved to what this render should show. */
  styles?: StyleDocument;
};

export function blockNode(source: NodeSource) {
  return (path: string | undefined, kind: EditorNodeKind = "field"): NodeAttrs => {
    const responsive = responsiveStyle(source.styles, path);
    const attrs: NodeAttrs = {
      ...editorNodeAttrs(source.editor ?? null, { path, kind }),
      ...responsive?.attrs,
    };
    const style = withVars(nodeStyle(source.styles, path), responsive);
    if (style) attrs.style = style;
    return attrs;
  };
}

/**
 * A media field's node: the frame's attributes, and the picture's style.
 *
 * One path, one address, one selectable node — and two elements, because that
 * is how a picture is built here. The frame carries the shape and the editor's
 * marks; the `<img>` inside it carries the crop, since `object-position` on a
 * non-replaced element is inert. Returning a pair rather than one spreadable
 * object is deliberate: a block has to decide where each half goes, and a
 * `{...spread}` that silently put the image's style on the frame is exactly the
 * bug this exists to close.
 */
/**
 * The picture's half: everything `<MediaImage>` needs, spread onto it in one
 * go so a block cannot pass the style and forget the breakpoints.
 */
export type MediaImagePart = ResponsiveAttrs & { style?: CSSProperties };

export type MediaNode = { box: NodeAttrs; image: MediaImagePart };

export function mediaNode(source: NodeSource) {
  return (path: string | undefined): MediaNode => {
    const { box, image } = mediaNodeStyle(source.styles, path);
    const responsive = responsiveMediaStyle(source.styles, path);

    const attrs: NodeAttrs = {
      ...editorNodeAttrs(source.editor ?? null, { path, kind: "field" }),
      ...responsive.box?.attrs,
    };
    const boxStyle = withVars(box, responsive.box);
    if (boxStyle) attrs.style = boxStyle;

    const picture: MediaImagePart = { ...responsive.image?.attrs };
    const imageStyle = withVars(image, responsive.image);
    if (imageStyle) picture.style = imageStyle;

    return { box: attrs, image: picture };
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
