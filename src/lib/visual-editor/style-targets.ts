import { getBlock, type FieldDef, type ItemFieldDef } from "@/lib/cms/blocks";
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

export type StyleGroup = "typography" | "spacing" | "surface" | "size" | "media";

export type StyleTarget = {
  /** Which family of element this is, for the panel's heading. */
  category: "section" | "container" | "text" | "item" | "media";
  tokens: readonly (keyof StyleTokens)[];
};

const SECTION_TOKENS = [
  "background",
  "padBlock",
  "padInline",
  "marginBlock",
  "marginInline",
  "radius",
  "border",
  "shadow",
  "opacity",
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
  "gap",
  "radius",
  "border",
  "shadow",
  "opacity",
  "maxWidth",
] as const;

/**
 * A container that is not known to lay its children out — a repeatable list,
 * or a path this resolver does not otherwise recognise.
 *
 * No `gap`: `gap` does nothing except on a flex, grid or multi-column box, and
 * a control that quietly does nothing teaches an editor that the panel is
 * unreliable. It stays in the vocabulary and in the renderer, and comes back
 * to a category the moment a block annotates a node that really is a layout
 * box.
 */
const CONTAINER_TOKENS = [
  "align",
  "background",
  "padBlock",
  "padInline",
  "marginBlock",
  "marginInline",
  "radius",
  "border",
  "shadow",
  "opacity",
  "maxWidth",
] as const;

const TEXT_TOKENS = [
  "align",
  "fontSize",
  "fontWeight",
  "textColor",
  "marginBlock",
  "marginInline",
  "maxWidth",
  "opacity",
] as const;

/**
 * One row of a repeatable list. The same reasoning as a container, and the same
 * omission: every annotated row in this codebase is an `<li>` or a `<span>`
 * whose own children are laid out by something inside it, so a `gap` on the row
 * itself would change nothing an editor could see.
 */
const ITEM_TOKENS = [
  "align",
  "background",
  "padBlock",
  "padInline",
  "marginBlock",
  "marginInline",
  "radius",
  "border",
  "shadow",
  "opacity",
  "maxWidth",
] as const;

const MEDIA_TOKENS = [
  "radius",
  "border",
  "shadow",
  "opacity",
  "maxWidth",
  "objectX",
  "objectY",
] as const;

const SECTION: StyleTarget = { category: "section", tokens: SECTION_TOKENS };
const CONTAINER: StyleTarget = { category: "container", tokens: CONTAINER_TOKENS };
const SLOT: StyleTarget = { category: "container", tokens: SLOT_TOKENS };
const TEXT: StyleTarget = { category: "text", tokens: TEXT_TOKENS };
const ITEM: StyleTarget = { category: "item", tokens: ITEM_TOKENS };
const MEDIA: StyleTarget = { category: "media", tokens: MEDIA_TOKENS };

/** A field the registry calls a picture is a picture wherever it appears. */
const fieldTarget = (field: FieldDef | ItemFieldDef | undefined): StyleTarget => {
  if (!field) return TEXT;
  if (field.type === "media") return MEDIA;
  // A repeatable list is the container its rows sit in, so spacing and gap are
  // the useful controls — the rows themselves are separate nodes.
  if (field.type === "items") return CONTAINER;
  return TEXT;
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
    if (sub?.type === "icon") return { category: "media", tokens: ["textColor", "opacity"] };
    return fieldTarget(sub);
  }

  // `field:x/item:i_…/slot:y` and anything else well formed: a container.
  if (parsed.some((segment) => segment.kind === "slot")) return SLOT;
  return CONTAINER;
}

/** The panel's grouping, so one target renders as a few short sections. */
export const STYLE_GROUPS: Record<StyleGroup, readonly (keyof StyleTokens)[]> = {
  typography: ["align", "fontSize", "fontWeight", "textColor"],
  spacing: ["padBlock", "padInline", "marginBlock", "marginInline", "gap"],
  surface: ["background", "border", "radius", "shadow", "opacity"],
  size: ["maxWidth"],
  media: ["objectX", "objectY"],
};

export const STYLE_GROUP_LABELS: Record<StyleGroup, string> = {
  typography: "Typography",
  spacing: "Spacing",
  surface: "Surface",
  size: "Size",
  media: "Focal point",
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
  objectX: "Horizontal",
  objectY: "Vertical",
  hidden: "Hidden",
};
