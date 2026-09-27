import { createElement, type CSSProperties, type ReactNode } from "react";

import {
  editorNodeAttrs,
  type EditorAttrs,
  type EditorNodeKind,
  type EditorRender,
} from "@/lib/visual-editor/render";
import { formatNodePath, parseNodePath } from "./address";
import {
  animatesAnywhere,
  hoversAnywhere,
  isStaggerGroup,
  motionStyle,
  parallaxAnywhere,
  staggersAnywhere,
  WORD_LIMIT,
  wordsAnywhere,
  type MotionAttrs,
  type MotionStyle,
} from "./motion-css";
import type { MotionDocument } from "./motion-doc";
import { splitWords } from "./words";
import {
  FINAL_OPACITY,
  mediaNodeStyle,
  nodeStyle,
  renameRevealOpacity,
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

/**
 * What a node's advanced motion looks like in markup (Batch 15).
 *
 * Page rendering, like the responsive attributes, and so outside `data-eod-`:
 * a visitor's page carries them because a visitor's page moves.
 *
 *   · `data-m-reveal` — this element has an entrance of its own.
 *   · `data-m-group` — this element is a list whose rows arrive in turn; the
 *     list is observed and the rows are animated, the list itself stays still.
 *   · `data-m-member` — this element is one of those rows. Its entrance belongs
 *     to the list, so anything that would have animated it on its own — a
 *     `Reveal`'s legacy class, its own stored motion — stands down.
 *   · `data-m-t` / `data-m-m` — which motion variables a breakpoint overrides.
 *
 * Batch 15b adds three, on the same terms:
 *
 *   · `data-m-px` — this element drifts on scroll at some width; the parallax
 *     runtime registers it and writes its offset.
 *   · `data-m-hv` — this element moves on hover or keyboard focus at some width;
 *     the stylesheet does the rest, with no listener at all.
 *   · `data-m-words` — this element's text was split into words, so the words
 *     take its fade. Written by `node.text()` and only when the split really
 *     happened, which is what keeps the attribute and the markup in step.
 */
export type MotionNodeAttrs = MotionAttrs & {
  "data-m-reveal"?: "";
  "data-m-group"?: "";
  "data-m-member"?: "";
  "data-m-px"?: "";
  "data-m-hv"?: "";
  "data-m-words"?: "";
};

export type NodeAttrs = EditorAttrs & ResponsiveAttrs & MotionNodeAttrs & { style?: CSSProperties };

/** Base style and responsive variables are one style object on one element. */
const withVars = (
  base: CSSProperties | undefined,
  responsive: ResponsiveStyle | undefined,
): CSSProperties | undefined => {
  if (!responsive || !Object.keys(responsive.vars).length) return base;
  return { ...base, ...responsive.vars } as CSSProperties;
};

/** What a block needs to annotate, style and move its own nodes. */
export type NodeSource = {
  editor?: EditorRender;
  /** Already validated, already resolved to what this render should show. */
  styles?: StyleDocument;
  /**
   * Already validated, already resolved to what this render should show, and
   * already cut down to what the block's nodes can carry (`motionForBlock`).
   * `null` or absent for a section with no advanced motion, which renders
   * exactly what it rendered before Batch 15.
   */
  motion?: MotionDocument | null;
};

/* -------------------------------------------------------------------------- */
/* Motion roles                                                               */
/* -------------------------------------------------------------------------- */

type MotionRole = "reveal" | "group" | "member";

/**
 * Everything one node's motion puts on its element: its lifecycle role, if it
 * has one, its variables, and whether it drifts or moves on hover.
 *
 * The role and the two flags are independent. A heading can drift without an
 * entrance, a card can lift under the pointer while its list sends it in; only
 * the role decides who owns an element's *arrival*.
 */
type MotionPlan = {
  role: MotionRole | null;
  motion: MotionStyle | null;
  parallax: boolean;
  hover: boolean;
};

/** `field:links/item:i_…` → `field:links`; a top-level field has no parent node. */
const parentOf = (path: string): string | null => {
  const parsed = parseNodePath(path);
  if (!parsed || parsed.length < 2) return null;
  return formatNodePath(parsed.slice(0, -1));
};

/**
 * What one node does, decided from its stable address and nothing else.
 *
 * **A staggering list owns its rows.** A row whose parent list sends its rows
 * in turn is a member, whatever motion the row itself might hold: the list's
 * one lifecycle and the row's index in the DOM decide when it arrives, and a
 * second entrance on the same element would be two animations fighting over
 * its opacity. That check comes first for exactly that reason.
 *
 * The section's own wrapper is never a node here: its entrance has a legacy
 * spelling and is rendered by `SectionRenderer`, which is the one place that
 * knows the legacy preset.
 */
function motionPlanOf(document: MotionDocument | null | undefined, path: string | undefined): MotionPlan | null {
  if (!document || path === undefined) return null;
  const parsed = parseNodePath(path);
  if (!parsed || parsed.length === 0) return null;
  const normalized = formatNodePath(parsed);
  const own = document.nodes[normalized];

  const parent = parentOf(normalized);
  if (parent && isStaggerGroup(document.nodes[parent])) {
    // The list owns the row's arrival. Its hover is still the row's own — a
    // card that lifts under the pointer has nothing to do with when it came in
    // — so the row keeps its hover variables and nothing else.
    const hover = hoversAnywhere(own);
    return { role: "member", motion: hover ? motionStyle(own, ["hover"]) : null, parallax: false, hover };
  }

  const enters = animatesAnywhere(own);
  const parallax = parallaxAnywhere(own);
  const hover = hoversAnywhere(own);
  if (!enters && !parallax && !hover) return null;
  const role: MotionRole | null = !enters ? null : staggersAnywhere(own) ? "group" : "reveal";
  return { role, motion: motionStyle(own), parallax, hover };
}

/** Whether a node's text should arrive word by word, decided once for its attributes and its children. */
function wordsFor(source: NodeSource, path: string | undefined, text: string): boolean {
  // The Visual Editor's canvas renders every text whole: the element is a
  // direct-edit target, and typing into generated word spans would be typing
  // into markup nobody stores. Replay shows the words there instead.
  if (source.editor || !source.motion || path === undefined || !text.trim()) return false;
  const parsed = parseNodePath(path);
  if (!parsed?.length) return false;
  const normalized = formatNodePath(parsed);
  const parent = parentOf(normalized);
  if (parent && isStaggerGroup(source.motion.nodes[parent])) return false;
  if (!wordsAnywhere(source.motion.nodes[normalized])) return false;
  const words = splitWords(text).filter((part) => "word" in part).length;
  return words > 0 && words <= WORD_LIMIT;
}

/**
 * A text as words: the sentence once for assistive technology, and the words
 * once for the eye.
 *
 *   · `data-m-wa` holds the whole text, visually hidden and not selectable. It
 *     is what a screen reader reads — once, as a sentence.
 *   · `data-m-wv` holds the words, `aria-hidden`, each an *inline* span with
 *     the original whitespace between them as text. Inline rather than
 *     inline-block on purpose: an inline span leaves line breaking, Arabic
 *     shaping and the bidirectional order of a mixed sentence exactly as they
 *     are for the unsplit text. It is also what a visitor selects and copies.
 *
 * Both hold the stored string unchanged; nothing here is ever saved.
 */
function wordContent(text: string): ReactNode {
  const parts = splitWords(text);
  return [
    createElement("span", { key: "a", "data-m-wa": "" }, text),
    createElement(
      "span",
      { key: "v", "data-m-wv": "", "aria-hidden": "true" },
      parts.map((part, index) =>
        "word" in part ? createElement("span", { key: index, "data-m-w": "" }, part.word) : part.space,
      ),
    ),
  ];
}

/**
 * A style object with its opacity turned into a finished state.
 *
 * The Batch 14 rule, applied to every element that now animates its opacity: an
 * inline `opacity` outranks the stylesheet, so it would hold the element at its
 * finished strength *before* it had arrived and leave the fade nothing to do.
 * It travels as `--eod-node-opacity` instead, which the entrance lands on.
 */
const asFinishedOpacity = (style: CSSProperties | undefined): CSSProperties | undefined => {
  if (!style || style.opacity === undefined) return style;
  const { opacity, ...rest } = style;
  return { ...rest, [FINAL_OPACITY]: String(opacity) } as CSSProperties;
};

/** The same rule at the other two widths: the list the element publishes, renamed. */
const withFinishedMarks = <T extends ResponsiveAttrs>(attrs: T): T => {
  const next = { ...attrs };
  const tablet = renameRevealOpacity(attrs["data-rs-t"]);
  const mobile = renameRevealOpacity(attrs["data-rs-m"]);
  if (tablet !== undefined) next["data-rs-t"] = tablet;
  if (mobile !== undefined) next["data-rs-m"] = mobile;
  return next;
};

/**
 * One node's motion folded into attributes and style it already has.
 *
 * Exported for the section wrapper, which decides its own role and then needs
 * exactly this. The motion variables are merged *after* the style, so a style
 * token can never write a motion variable — it could not anyway, the names are
 * disjoint, but the order says which one owns the property.
 */
export function withMotion(
  attrs: NodeAttrs,
  style: CSSProperties | undefined,
  role: MotionRole | null,
  motion: MotionStyle | null,
  flags: { parallax?: boolean; hover?: boolean } = {},
): { attrs: NodeAttrs; style: CSSProperties | undefined } {
  let nextAttrs: NodeAttrs = { ...attrs };
  let nextStyle = style;
  if (role === "reveal" || role === "member") {
    // Only something that animates its own opacity needs it as a finished
    // state. A list that staggers its rows stays still itself, and so does an
    // element that only drifts or only answers a hover.
    nextStyle = asFinishedOpacity(nextStyle);
    nextAttrs = withFinishedMarks(nextAttrs);
  }
  if (role === "reveal") nextAttrs["data-m-reveal"] = "";
  if (role === "group") nextAttrs["data-m-group"] = "";
  if (role === "member") nextAttrs["data-m-member"] = "";
  if (flags.parallax) nextAttrs["data-m-px"] = "";
  if (flags.hover) nextAttrs["data-m-hv"] = "";
  if (motion) {
    nextAttrs = { ...nextAttrs, ...motion.attrs };
    if (Object.keys(motion.vars).length) {
      nextStyle = { ...nextStyle, ...motion.vars } as CSSProperties;
    }
  }
  return { attrs: nextAttrs, style: nextStyle };
}

/** A text node's attributes and its children, decided together. */
export type NodeText = { attrs: NodeAttrs; content: ReactNode };

export function blockNode(source: NodeSource) {
  const node = (path: string | undefined, kind: EditorNodeKind = "field"): NodeAttrs => {
    const responsive = responsiveStyle(source.styles, path);
    let attrs: NodeAttrs = {
      ...editorNodeAttrs(source.editor ?? null, { path, kind }),
      ...responsive?.attrs,
    };
    let style = withVars(nodeStyle(source.styles, path), responsive);

    const plan = kind === "section" ? null : motionPlanOf(source.motion, path);
    if (plan) ({ attrs, style } = withMotion(attrs, style, plan.role, plan.motion, plan));

    if (style) attrs.style = style;
    return attrs;
  };

  /**
   * A short text node: its attributes, and the text to put inside it (Batch 15b).
   *
   * The one way a block renders copy that may arrive word by word, so the
   * decision is made once for both halves: the element is marked
   * `data-m-words` exactly when its children really are words. With words off
   * at every width, in the Visual Editor's canvas, or for a text longer than
   * `WORD_LIMIT` words, this is `node(path)` and the plain string — the same
   * markup as before Batch 15b.
   */
  const text = (path: string | undefined, value: string, kind: EditorNodeKind = "field"): NodeText => {
    const attrs = node(path, kind);
    if (!wordsFor(source, path, value)) return { attrs, content: value };
    return { attrs: { ...attrs, "data-m-words": "" }, content: wordContent(value) };
  };

  return Object.assign(node, { text });
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

    let attrs: NodeAttrs = {
      ...editorNodeAttrs(source.editor ?? null, { path, kind: "field" }),
      ...responsive.box?.attrs,
    };
    let boxStyle = withVars(box, responsive.box);
    // A picture moves as one thing: the frame carries the entrance, the drift
    // and the hover, and the image inside it goes with it — except for Zoom,
    // which the stylesheet applies to the image inside the frame that clips it.
    const plan = motionPlanOf(source.motion, path);
    if (plan) ({ attrs, style: boxStyle } = withMotion(attrs, boxStyle, plan.role, plan.motion, plan));
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
