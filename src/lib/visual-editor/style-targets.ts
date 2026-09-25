import { getBlock, type BoxKind, type FieldDef, type ItemFieldDef } from "@/lib/cms/blocks";
import { parseNodePath, type NodePath } from "@/lib/cms/address";
import type { StyleTokens } from "@/lib/cms/styles";

/**
 * Which style controls a given node is allowed to offer.
 *
 * The rule: **a control that does nothing is worse than a missing control.**
 * Font weight on an image, object position on a heading, a gap on a paragraph —
 * each of those would be a setting an editor changes, saves, and then cannot
 * see, which teaches them the panel is unreliable.
 *
 * Capabilities are derived rather than listed. Twenty blocks each with a
 * hand-written table of their own nodes would be four hundred entries to keep
 * in step with the registry; instead the node's kind and — for a field — the
 * registry's own declaration of what that field *is* decide the category. A
 * block that gains a field gains the right controls without anybody coming
 * back here.
 */

export type StyleGroup =
  | "typography"
  | "size"
  | "layout"
  | "spacing"
  | "surface"
  | "media"
  | "visibility";

export type StyleTarget = {
  /** Which family of element this is, for the panel's heading. */
  category: "section" | "container" | "text" | "item" | "media";
  tokens: readonly (keyof StyleTokens)[];
  /**
   * The layout this node's own design already uses, when the registry declares
   * one. `null` means "an ordinary box" — not "no layout", which is what an
   * explicit `layout: "block"` override means.
   *
   * It exists so the panel can offer alignment and gap on a list that is
   * already a grid without first making the editor re-declare that it is one,
   * and it comes from the registry rather than from the canvas: see
   * `effectiveLayout`.
   */
  layout: Exclude<BoxKind, "inline"> | null;
};

/**
 * The section's own wrapper: a block-level `<div>` holding the whole band.
 *
 * It gets a minimum height and the layout family — "make this band most of a
 * screen tall and centre what is in it" is the commonest layout request on a
 * page and there is nowhere else to make it — but no width and no height. A
 * band is full-bleed by design, the `.shell` inside it is what constrains the
 * content, and a fixed height on a section is the one place cropping would be
 * invisible until somebody wrote a longer paragraph.
 */
const SECTION_TOKENS = [
  "background",
  "padBlock",
  "padInline",
  "marginBlock",
  "marginInline",
  "minHeight",
  "layout",
  "direction",
  "wrap",
  "justify",
  "alignItems",
  "columns",
  "gap",
  "radius",
  "border",
  "shadow",
  "glow",
  "opacity",
  "overflow",
  "hidden",
] as const;

/**
 * A slot is a place a block reserved for a control, and every slot in this
 * codebase is a laid-out box — the one that exists today is a button whose
 * label and arrow sit in a flex row. `gap` therefore does something here, and
 * this is the only category where it does.
 */
const SLOT_TOKENS = [
  "align",
  "background",
  "padBlock",
  "padInline",
  "marginBlock",
  "marginInline",
  "layout",
  "direction",
  "wrap",
  "justify",
  "alignItems",
  "columns",
  "gap",
  "radius",
  "border",
  "shadow",
  "glow",
  "opacity",
  "overflow",
  "width",
  "maxWidth",
  "minHeight",
  "hidden",
] as const;

/**
 * A container: a repeatable list's own box, or a path this resolver does not
 * otherwise recognise.
 *
 * `gap` is back, and so is the rest of the layout family — with the condition
 * that made it absent now written down instead of guessed at. Until Batch 14 a
 * container had no way to say whether it laid its children out, so the safe
 * answer was to offer nothing; now the registry says (`box`), and whichever
 * answer it gives, `offeredTokens` is what decides whether the panel draws
 * these. They are in the list because the renderer honours them if they are
 * set; they are on screen only where they do something.
 */
const CONTAINER_TOKENS = [
  "align",
  "background",
  "padBlock",
  "padInline",
  "marginBlock",
  "marginInline",
  "layout",
  "direction",
  "wrap",
  "justify",
  "alignItems",
  "columns",
  "gap",
  "radius",
  "border",
  "shadow",
  "glow",
  "opacity",
  "overflow",
  "width",
  "maxWidth",
  "height",
  "minHeight",
  "hidden",
] as const;

/**
 * Text keeps its own controls and gains only `width`.
 *
 * No layout family: a heading's children are words, and `display: flex` on a
 * paragraph is a control whose effect nobody could describe. No glow either —
 * a halo drawn round a paragraph's box is a rectangle of light behind a line of
 * text, which is the one way this token could hurt legibility. `align` is
 * text alignment and was always here.
 */
const TEXT_TOKENS = [
  "align",
  "fontSize",
  "fontWeight",
  "textColor",
  "marginBlock",
  "marginInline",
  "width",
  "maxWidth",
  "opacity",
  "hidden",
] as const;

/**
 * One row of a repeatable list — an `<li>` or a `<span>` with children of its
 * own.
 *
 * A row is a box, so it sizes, clips and can be laid out; what it is not is a
 * box this codebase already lays out, so none of the layout settings appear
 * until an editor chooses a Layout mode. That is the same rule the section
 * root follows, and it is `offeredTokens` that applies it.
 */
const ITEM_TOKENS = [
  "align",
  "background",
  "padBlock",
  "padInline",
  "marginBlock",
  "marginInline",
  "layout",
  "direction",
  "wrap",
  "justify",
  "alignItems",
  "columns",
  "gap",
  "radius",
  "border",
  "shadow",
  "glow",
  "opacity",
  "overflow",
  "width",
  "maxWidth",
  "height",
  "minHeight",
  "hidden",
] as const;

/**
 * A picture's frame is a box, so it sizes and it clips — `overflow` is the
 * control that decides whether a rounded corner cuts the photograph inside it.
 * No layout family: the frame holds exactly one `<img>`.
 */
const MEDIA_TOKENS = [
  "radius",
  "border",
  "shadow",
  "glow",
  "opacity",
  "overflow",
  "width",
  "maxWidth",
  "height",
  "minHeight",
  "objectX",
  "objectY",
  "hidden",
] as const;

const SECTION: StyleTarget = { category: "section", tokens: SECTION_TOKENS, layout: null };
const CONTAINER: StyleTarget = { category: "container", tokens: CONTAINER_TOKENS, layout: null };
/** Every slot in this codebase is an inline-flex control box. */
const SLOT: StyleTarget = { category: "container", tokens: SLOT_TOKENS, layout: "flex" };
const TEXT: StyleTarget = { category: "text", tokens: TEXT_TOKENS, layout: null };
const ITEM: StyleTarget = { category: "item", tokens: ITEM_TOKENS, layout: null };
const MEDIA: StyleTarget = { category: "media", tokens: MEDIA_TOKENS, layout: null };

/**
 * An inline element is not a box: width, height, minimum height, overflow and
 * every layout control are inert on it, so none of them is offered. What is
 * left is the text and surface vocabulary, which does work inline.
 *
 * The one node in the codebase this describes today is the hero's rotating
 * words — a `<span>` inside the `<h1>` — and the registry says so rather than
 * the panel guessing from the field's name.
 */
const INERT_ON_INLINE: ReadonlySet<keyof StyleTokens> = new Set([
  "width",
  "height",
  "minHeight",
  "overflow",
  "layout",
  "direction",
  "wrap",
  "justify",
  "alignItems",
  "columns",
  "gap",
]);

const inlineTarget = (target: StyleTarget): StyleTarget => ({
  ...target,
  tokens: target.tokens.filter((token) => !INERT_ON_INLINE.has(token)),
  layout: null,
});

/** A field the registry calls a picture is a picture wherever it appears. */
const fieldTarget = (field: FieldDef | ItemFieldDef | undefined): StyleTarget => {
  if (!field) return TEXT;
  const base =
    field.type === "media"
      ? MEDIA
      : // A repeatable list is the container its rows sit in, so spacing, gap
        // and — once the registry says it is one — the grid's own column count
        // are the useful controls. The rows themselves are separate nodes.
        field.type === "items"
        ? CONTAINER
        : TEXT;
  if (field.box === "inline") return inlineTarget(base);
  if (field.box === "flex" || field.box === "grid") return { ...base, layout: field.box };
  return base;
};

/**
 * The target for one node of one block.
 *
 * `path` is the section-relative path — the same vocabulary styles are stored
 * under — and it is parsed rather than split, so a malformed one falls back to
 * the section's own capabilities instead of guessing at segments.
 */
export function styleTargetFor(blockType: string, path: string | undefined): StyleTarget {
  const parsed: NodePath | null = parseNodePath(path === undefined ? "root" : path);
  if (!parsed || parsed.length === 0) return SECTION;

  const block = getBlock(blockType);
  const [first, second, third] = parsed;

  // A slot is a place the block reserved for a control, and a laid-out one.
  if (first!.kind === "slot") return SLOT;
  if (first!.kind !== "field") return CONTAINER;

  const field = block?.fields.find((entry) => entry.name === first!.name);

  // `field:x` — the field itself.
  if (parsed.length === 1) return fieldTarget(field);

  // `field:x/item:i_…` — one row of a repeatable list.
  if (second?.kind === "item" && parsed.length === 2) return ITEM;

  // `field:x/item:i_…/field:y` — one field inside a row.
  if (second?.kind === "item" && third?.kind === "field") {
    const sub = field?.itemFields?.find((entry) => entry.name === third.name);
    // An icon is a glyph, not a picture: shape and opacity make sense, focal
    // point does not.
    if (sub?.type === "icon") {
      return { category: "media", tokens: ["textColor", "opacity", "hidden"], layout: null };
    }
    return fieldTarget(sub);
  }

  // `field:x/item:i_…/slot:y` and anything else well formed: a container.
  if (parsed.some((segment) => segment.kind === "slot")) return SLOT;
  return CONTAINER;
}

/* -------------------------------------------------------------------------- */
/* What a node may control, and when                                          */
/* -------------------------------------------------------------------------- */

/**
 * The layout a node is actually in, as far as the panel is allowed to know.
 *
 * Two sources, in order: an explicit `layout` override — the one the editor
 * set, resolved through the breakpoint chain like any other token — and
 * failing that whatever the registry declared the node's own design to be.
 * A third source is deliberately absent: nothing here reads the canvas.
 * `getComputedStyle` through the iframe would make a control's presence depend
 * on which document happened to be loaded, on a race with its stylesheet, and
 * on nothing the panel could explain to the person using it.
 *
 * `"block"` is a real answer, not a missing one: an editor who flattens a grid
 * has said they do not want columns, and the column control goes away.
 */
export function effectiveLayout(
  target: StyleTarget,
  override: StyleTokens["layout"] | undefined,
): "block" | "flex" | "grid" | null {
  return override ?? target.layout;
}

/** Only meaningful on a flex container. */
const FLEX_ONLY: readonly (keyof StyleTokens)[] = ["direction", "wrap"];
/** Meaningful on either kind of layout box. */
const FLEX_OR_GRID: readonly (keyof StyleTokens)[] = ["justify", "alignItems", "gap"];
/** Only meaningful on a grid container. */
const GRID_ONLY: readonly (keyof StyleTokens)[] = ["columns"];

const CONDITIONAL: ReadonlySet<keyof StyleTokens> = new Set([
  ...FLEX_ONLY,
  ...FLEX_OR_GRID,
  ...GRID_ONLY,
]);

/**
 * The tokens this node should actually offer right now.
 *
 * The capability list says what the node *could* control; this says what is
 * worth showing given the layout it is in. One rule, and it is the whole of
 * §17: **a layout control appears exactly when the node's effective layout can
 * use it.** Direction and wrap on a flex box, columns on a grid, alignment and
 * gap on either, and none of the four on a node whose layout is the
 * component's own ordinary block flow — where an editor who wants them chooses
 * a Layout mode first, which is an override they can see and can reset.
 *
 * Everything not in that set is unconditional and stays exactly as it was.
 */
export function offeredTokens(
  target: StyleTarget,
  override: StyleTokens["layout"] | undefined,
): readonly (keyof StyleTokens)[] {
  const layout = effectiveLayout(target, override);
  const allowed =
    layout === "flex"
      ? new Set<keyof StyleTokens>([...FLEX_ONLY, ...FLEX_OR_GRID])
      : layout === "grid"
        ? new Set<keyof StyleTokens>([...GRID_ONLY, ...FLEX_OR_GRID])
        : new Set<keyof StyleTokens>();
  return target.tokens.filter((token) => !CONDITIONAL.has(token) || allowed.has(token));
}

/**
 * The capability questions §18 asks, answered from the one list that decides
 * them, so a React component never tests for a token name itself.
 */
export type StyleCapabilities = {
  width: boolean;
  height: boolean;
  layout: boolean;
  flex: boolean;
  grid: boolean;
  overflow: boolean;
  glow: boolean;
};

export function styleCapabilities(target: StyleTarget): StyleCapabilities {
  const has = (token: keyof StyleTokens) => target.tokens.includes(token);
  const mayLayout = has("layout");
  return {
    width: has("width"),
    height: has("height") || has("minHeight"),
    layout: mayLayout,
    flex: mayLayout && FLEX_ONLY.every(has),
    grid: mayLayout && GRID_ONLY.every(has),
    overflow: has("overflow"),
    glow: has("glow"),
  };
}

/** The panel's grouping, so one target renders as a few short sections. */
export const STYLE_GROUPS: Record<StyleGroup, readonly (keyof StyleTokens)[]> = {
  typography: ["align", "fontSize", "fontWeight", "textColor"],
  size: ["width", "maxWidth", "height", "minHeight"],
  layout: ["layout", "direction", "wrap", "justify", "alignItems", "columns", "gap"],
  spacing: ["padBlock", "padInline", "marginBlock", "marginInline"],
  surface: ["background", "border", "radius", "shadow", "glow", "opacity", "overflow"],
  media: ["objectX", "objectY"],
  /**
   * Last, and on every node.
   *
   * Hiding is the one override that is about the element existing rather than
   * about how it looks, which is why it sits on its own at the bottom rather
   * than among the surface controls — and why it is offered wherever a node is,
   * from a section down to one word of a heading.
   */
  visibility: ["hidden"],
};

export const STYLE_GROUP_LABELS: Record<StyleGroup, string> = {
  typography: "Typography",
  size: "Size",
  layout: "Layout",
  spacing: "Spacing",
  surface: "Surface",
  media: "Focal point",
  visibility: "Visibility",
};

export const STYLE_TOKEN_LABELS: Record<keyof StyleTokens, string> = {
  align: "Alignment",
  fontSize: "Size",
  fontWeight: "Weight",
  textColor: "Text colour",
  background: "Background",
  padBlock: "Padding — top and bottom",
  padInline: "Padding — sides",
  marginBlock: "Margin — top and bottom",
  marginInline: "Margin — sides",
  gap: "Gap",
  radius: "Corner radius",
  border: "Border",
  shadow: "Shadow",
  opacity: "Opacity",
  maxWidth: "Maximum width",
  width: "Width",
  height: "Height",
  minHeight: "Minimum height",
  layout: "Layout mode",
  direction: "Direction",
  wrap: "Wrapping",
  justify: "Distribute",
  alignItems: "Align",
  columns: "Columns",
  overflow: "Overflow",
  glow: "Glow",
  objectX: "Horizontal",
  objectY: "Vertical",
  hidden: "Hidden",
};

/**
 * How a stored value is spelled for a person.
 *
 * The values themselves are kebab-case keys because that is what the validator
 * checks and what a document holds; `two-thirds` and `nowrap` are not words an
 * editor should have to read off a control. Only the values that need it are
 * listed — anything absent falls back to the key with a capital letter, which
 * is right for `auto`, `center`, `hidden` and most of the rest.
 */
export const STYLE_VALUE_LABELS: Partial<Record<string, string>> = {
  fit: "Fit content",
  quarter: "One quarter",
  third: "One third",
  half: "Half",
  "two-thirds": "Two thirds",
  "three-quarters": "Three quarters",
  full: "Full",
  screen: "Screen height",
  "third-screen": "A third of the screen",
  "half-screen": "Half the screen",
  "two-thirds-screen": "Two thirds of the screen",
  block: "Stacked",
  flex: "Flexible row or column",
  grid: "Grid",
  row: "Row",
  column: "Column",
  nowrap: "Single line",
  wrap: "Wrap onto more lines",
  between: "Space between",
  around: "Space around",
  evenly: "Space evenly",
  stretch: "Stretch",
  clip: "Clip",
  "line-strong": "Strong line",
  "surface-raised": "Raised surface",
  "on-accent": "On accent",
};

/**
 * A short warning under the controls that can crop or surprise. Nothing here
 * changes behaviour; it is the difference between a control an editor can use
 * and one they undo.
 */
export const STYLE_TOKEN_NOTES: Partial<Record<keyof StyleTokens, string>> = {
  height: "A fixed height can crop what does not fit. Minimum height grows instead.",
  minHeight: "A floor, never a ceiling — the element still grows past it.",
  layout: "Default keeps the component's own design. Changing it is an override you can reset.",
  justify: "Start and end follow the reading direction, so they mirror in Arabic.",
  overflow: "Hidden and Clip crop anything that reaches past the edge, including shadows and glows.",
  glow: "Sits alongside Shadow rather than replacing it — you can have both.",
};
