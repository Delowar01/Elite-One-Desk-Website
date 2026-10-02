import { getEditorBlock, type FieldDef, type ItemFieldDef } from "@/lib/cms/blocks";
import { formatNodePath, parseNodePath, type NodePath } from "@/lib/cms/address";
import {
  DIRECTIONAL,
  ENTRANCES,
  MOTION_FIELD_KEYS,
  PARALLAX,
  resolveBranch,
  TEXT_REVEALS,
  validateMotionDocument,
  type Entrance,
  type HoverEffect,
  type MotionBranch,
  type MotionDocument,
  type MotionTarget,
} from "@/lib/cms/motion-doc";
import {
  HOVER_LIFT_PX,
  HOVER_NUDGE_PX,
  HOVER_SCALE,
  HOVER_ZOOM,
  isStaggerGroup,
  PARALLAX_DISTANCE,
} from "@/lib/cms/motion-css";
import type { Breakpoint } from "@/lib/cms/styles";

/**
 * Which motion controls a node may offer — the motion twin of `style-targets`.
 *
 * The same rule: **a control that does nothing is worse than a missing
 * control**, and the same method: capabilities are derived from what the
 * registry says a node *is*, not listed per block. A block that gains a field
 * gains the right motion controls without anybody coming back here.
 *
 * Unlike a style token, a motion field is also enforced at render and at save:
 * `motionForBlock` drops anything a node's capability does not offer, so a
 * document can never hold — and a page can never run — an entrance on an
 * element that already animates itself. That one is a correctness rule rather
 * than a panel preference: two animations on one element's `opacity` fight.
 *
 * ## Batch 15b: scroll, hover and words
 *
 * The same resolver answers for the three new keys, from the same registry:
 *
 *   · **Parallax** — text, media, lists and slots. Not the section wrapper
 *     (moving a whole section would slide it over its neighbours), not a row
 *     (rows of one grid drifting apart would break the grid — give the list
 *     parallax instead), not a backdrop (it is pinned to the section's edges,
 *     and moving it would open a gap there) and not a card's picture (the card
 *     clips it, so it would open a gap inside the card).
 *   · **Hover** — a row takes Lift or Scale; a picture Scale or Zoom; a call
 *     to action Lift or Nudge. Nothing else: a section or a list is not
 *     something a visitor points at, and plain text is not something they
 *     follow. Where the markup already moves on hover nothing is offered that
 *     would double it: `.btn` lifts itself by a pixel, and a button given Lift
 *     hands that lift over to the editor's (`--m-hvb`) instead of adding to
 *     it; a card row owns its lift, zoom and nudge, so it and its picture are
 *     offered no hover at all; a backdrop is never under the pointer.
 *   · **Text reveal** — single-line copy only: a localised `text` field or row
 *     field. Never a paragraph, rich text, a number or a filter value, so a
 *     long body cannot become hundreds of animated spans.
 *
 * `motionForBlock` enforces values as well as keys: a stored Zoom on a heading
 * is removed exactly as a stored entrance on a keyframed hero is.
 */

export type MotionKind = "section" | "list" | "item" | "text" | "media" | "slot";

/** Why a node offers nothing, in words the panel can repeat. */
export type MotionRefusal = "own" | "inline" | "glyph" | "unaddressable" | "still";

export type MotionCapability =
  | {
      kind: MotionKind;
      fields: readonly (keyof MotionBranch)[];
      /** The hover movements this node may take, `none` aside. Empty when `hover` is not a field. */
      hovers: readonly Exclude<HoverEffect, "none">[];
    }
  | { kind: null; fields: readonly []; hovers: readonly []; reason: MotionRefusal };

/** An entrance, its direction and its timing — what every animated node has. */
const ENTRANCE_FIELDS = ["entrance", "direction", "duration", "delay", "easing"] as const;
/** A list adds the one thing only a list can do: send its rows in turn. */
const LIST_FIELDS = [...ENTRANCE_FIELDS, "stagger"] as const;

const refuse = (reason: MotionRefusal): MotionCapability => ({ kind: null, fields: [], hovers: [], reason });

const capability = (
  kind: MotionKind,
  fields: readonly (keyof MotionBranch)[],
  hovers: readonly Exclude<HoverEffect, "none">[] = [],
): MotionCapability => ({ kind, fields: hovers.length ? [...fields, "hover"] : fields, hovers });

const SECTION = capability("section", ENTRANCE_FIELDS);
const SLOT = capability("slot", [...ENTRANCE_FIELDS, "parallax"]);
const LIST = capability("list", [...LIST_FIELDS, "parallax"]);
/** A row: it may rise or grow under the pointer, and it moves with its list on scroll. */
const ITEM = capability("item", ENTRANCE_FIELDS, ["lift", "scale"]);
/** A row that is a card with its own hover: the card's lift is the only one. */
const CARD_ROW = capability("item", ENTRANCE_FIELDS);
/** A field the registry does not declare: the entrance 15a offered, and nothing new. */
const UNDECLARED = capability("text", ENTRANCE_FIELDS);

function textCapability(field: FieldDef | ItemFieldDef): MotionCapability {
  const fields: (keyof MotionBranch)[] = [...ENTRANCE_FIELDS, "parallax"];
  // Single-line copy, in both editions: the one kind of text short enough to
  // arrive a word at a time. A `text` field that is not localised is a value
  // — a figure, a filter, a slug — rather than a sentence.
  if ((field.type ?? "text") === "text" && field.localised === true) fields.push("textReveal");
  return capability("text", fields, field.surface === "button" ? ["lift", "nudge"] : []);
}

function mediaCapability(field: FieldDef | ItemFieldDef): MotionCapability {
  if (field.surface === "backdrop" || field.surface === "card") return capability("media", ENTRANCE_FIELDS);
  return capability("media", [...ENTRANCE_FIELDS, "parallax"], ["scale", "zoom"]);
}

function fieldCapability(field: FieldDef | ItemFieldDef | undefined): MotionCapability {
  if (!field) return UNDECLARED;
  if (field.motion === "own") return refuse("own");
  if (field.box === "inline") return refuse("inline");
  if (field.type === "icon") return refuse("glyph");
  if (field.type === "media") return mediaCapability(field);
  if (field.type === "items") return LIST;
  return textCapability(field);
}

/**
 * The capability of one node of one block, by its section-relative path.
 *
 * `undefined` and `root` are the section's own wrapper. A path the parser
 * refuses offers nothing rather than guessing at segments.
 */
export function motionTargetFor(blockType: string, path: string | undefined): MotionCapability {
  // A block that is the site's own chrome — a dynamic route's breadcrumbs —
  // never moves, at its root or anywhere inside it (Batch 21).
  if (getEditorBlock(blockType)?.still) return refuse("still");
  if (path === undefined || path === "root") return SECTION;
  const parsed: NodePath | null = parseNodePath(path);
  if (!parsed) return refuse("unaddressable");
  if (parsed.length === 0) return SECTION;

  const block = getEditorBlock(blockType);
  const [first, second, third] = parsed;

  if (first!.kind === "slot") return SLOT;
  if (first!.kind !== "field") return refuse("unaddressable");

  const field = block?.fields.find((entry) => entry.name === first!.name);
  if (parsed.length === 1) return fieldCapability(field);

  // `field:x/item:i_…` — one row of a repeatable list.
  if (second?.kind === "item" && parsed.length === 2) return field?.surface === "card" ? CARD_ROW : ITEM;

  // `field:x/item:i_…/field:y` — one field inside a row.
  if (second?.kind === "item" && third?.kind === "field" && parsed.length === 3) {
    return fieldCapability(field?.itemFields?.find((entry) => entry.name === third.name));
  }

  if (parsed.some((segment) => segment.kind === "slot")) return SLOT;
  return refuse("unaddressable");
}

/**
 * The entrances a node may choose from. All seven everywhere motion is offered
 * — a mask on a picture, a blur on a heading, a slide on a row are all real
 * movements — so this is here to be the one place that would say otherwise.
 */
export const entrancesFor = (capability: MotionCapability): readonly Entrance[] =>
  capability.kind === null ? [] : ENTRANCES;

/**
 * The hover choices a node offers, `none` first — the one a narrower width
 * uses to switch an inherited hover off. Empty where hover is not offered.
 */
export const hoversFor = (capability: MotionCapability): readonly HoverEffect[] =>
  capability.kind === null || !capability.hovers.length ? [] : ["none", ...capability.hovers];

/** Parallax intensities: all four wherever parallax is offered. */
export const parallaxFor = (capability: MotionCapability) =>
  capability.kind !== null && capability.fields.includes("parallax") ? PARALLAX : [];

/** Text reveal modes: both wherever text reveal is offered. */
export const textRevealsFor = (capability: MotionCapability) =>
  capability.kind !== null && capability.fields.includes("textReveal") ? TEXT_REVEALS : [];

/* -------------------------------------------------------------------------- */
/* What the panel draws right now                                            */
/* -------------------------------------------------------------------------- */

/**
 * The fields worth showing, given what this node is doing at this width.
 *
 * One rule, stated once: **a setting appears exactly when it can change what a
 * visitor sees.** Direction only for an entrance that travels. Timing only for
 * a node that has an entrance at this width — a duration on something that
 * does not move is a control that does nothing. Stagger only on a list that
 * moves at this width, for the same reason.
 *
 * A value stored at a width where it cannot act stays stored and stays inert,
 * exactly as a Batch 14 flex setting does on a block box: it may act again at a
 * narrower width that changes the entrance, where it is shown as inherited.
 * The branch's count and its Reset include it, so it is never unreachable.
 *
 * The section wrapper always has an entrance (the legacy preset stands in when
 * the document names none), so `legacy` is passed for the section and ignored
 * for everything else.
 *
 * Batch 15b's three keys are always shown where the node offers them: parallax
 * and hover act whether or not the node has an entrance, and text reveal is
 * itself a way of arriving. Words also count as moving for the timing fields —
 * they arrive on the node's duration, curve and delay even when the node's
 * own entrance is None.
 */
export function offeredMotionFields(
  capability: MotionCapability,
  target: MotionTarget | undefined,
  breakpoint: Breakpoint,
  legacy?: Entrance,
): readonly (keyof MotionBranch)[] {
  if (capability.kind === null) return [];
  const resolved = resolveBranch(target, breakpoint);
  const entrance = resolved.entrance ?? (capability.kind === "section" ? legacy : undefined);
  const enters = entrance !== undefined && entrance !== "none";
  const words = capability.fields.includes("textReveal") && resolved.textReveal === "words";
  const moving = enters || words;
  return capability.fields.filter((field) => {
    if (field === "entrance") return true;
    if (field === "direction") return entrance !== undefined && DIRECTIONAL.has(entrance);
    if (field === "stagger") return capability.kind === "list" && enters;
    if (field === "parallax" || field === "hover" || field === "textReveal") return true;
    return moving;
  });
}

/** The parent a row is laid out by: `field:links/item:i_…` → `field:links`. */
export function parentPathOf(path: string): string | null {
  const parsed = parseNodePath(path);
  if (!parsed || parsed.length < 2) return null;
  return formatNodePath(parsed.slice(0, -1));
}

/**
 * Whether a list above this node is sending its rows in turn — in which case
 * the list owns the row's entrance, and the row's own motion is set aside.
 *
 * Checked against the whole target rather than one width, because ownership is
 * structural: a list that staggers at any width drives its rows at every width,
 * and a row cannot hand its entrance back and forth as the window is resized.
 */
export function ownedByParentList(document: MotionDocument | null | undefined, path: string): boolean {
  const parent = parentPathOf(path);
  if (!parent || !document) return false;
  return isStaggerGroup(document.nodes[parent]);
}

/* -------------------------------------------------------------------------- */
/* Enforcement                                                                */
/* -------------------------------------------------------------------------- */

/**
 * A document with everything the block's capabilities do not offer removed.
 *
 * Run on save, so the database never holds motion no node can show, and again
 * at render, so a document written some other way still cannot run a second
 * animation on an element that animates itself. Validated first, so the result
 * is always canonical and running it twice changes nothing.
 */
export function motionForBlock(input: unknown, blockType: string): MotionDocument {
  const document = validateMotionDocument(input);
  const keep = (target: MotionTarget, capability: MotionCapability): MotionTarget => {
    const allowed = new Set<keyof MotionBranch>(capability.fields);
    // `none` is always a legal hover where hover is offered at all: it is how a
    // narrower width switches an inherited one off.
    const hovers = new Set<string>(hoversFor(capability));
    const out: MotionTarget = {};
    for (const breakpoint of ["base", "tablet", "mobile"] as const) {
      const branch = target[breakpoint];
      if (!branch) continue;
      const next: MotionBranch = {};
      for (const key of MOTION_FIELD_KEYS) {
        const value = branch[key];
        if (value === undefined || !allowed.has(key)) continue;
        // A key the node offers can still carry a value it does not: Zoom on
        // a heading, Lift on a button that already lifts itself.
        if (key === "hover" && !hovers.has(value as string)) continue;
        (next as Record<string, unknown>)[key] = value;
      }
      if (Object.keys(next).length) out[breakpoint] = next;
    }
    return out;
  };

  // The section's own capability: a still block's root takes nothing (Batch 21).
  const root = motionTargetFor(blockType, undefined);
  const section = root.kind === null ? {} : keep(document.section, root);
  const nodes: Record<string, MotionTarget> = {};
  for (const [path, target] of Object.entries(document.nodes)) {
    const capability = motionTargetFor(blockType, path);
    if (capability.kind === null) continue;
    const kept = keep(target, capability);
    if (Object.keys(kept).length) nodes[path] = kept;
  }
  return { v: document.v, section, nodes };
}

/* -------------------------------------------------------------------------- */
/* Labels                                                                     */
/* -------------------------------------------------------------------------- */

export const MOTION_FIELD_LABELS: Record<keyof MotionBranch, string> = {
  entrance: "Entrance",
  direction: "Direction",
  duration: "Duration",
  delay: "Delay",
  easing: "Easing",
  stagger: "Stagger",
  parallax: "Parallax",
  hover: "Hover",
  textReveal: "Text reveal",
};

export const MOTION_VALUE_LABELS: Record<string, string> = {
  "fade-up": "Fade up",
  fade: "Fade only",
  "slide-in": "Slide in",
  "scale-in": "Scale in",
  blur: "Blur reveal",
  mask: "Mask reveal",
  none: "No entrance",
  start: "From the start edge",
  end: "From the end edge",
  up: "Upward",
  down: "Downward",
  // The length is in the name: "Standard" is not the default, and an editor
  // choosing between four words deserves to know what each one is.
  fast: "Fast · 0.18s",
  standard: "Standard · 0.38s",
  slow: "Slow · 0.76s",
  cinematic: "Cinematic · 1.2s",
  "soft-out": "Soft out",
  "expo-out": "Expo out",
  "soft-in-out": "Soft in and out",
  tight: "Tight",
  normal: "Normal",
  relaxed: "Relaxed",
};

/**
 * Values whose word depends on the field — `none` above all, which is "No
 * entrance" for an entrance and would be the wrong sentence under Hover.
 *
 * Distances, scales and steps are read from `motion-css.ts`, the one place they
 * are defined, so a label cannot quote a number the stylesheet does not use.
 */
const FIELD_VALUE_LABELS: Partial<Record<keyof MotionBranch, Record<string, string>>> = {
  parallax: {
    none: "No parallax",
    subtle: `Subtle · up to ${PARALLAX_DISTANCE.subtle}px`,
    medium: `Medium · up to ${PARALLAX_DISTANCE.medium}px`,
    strong: `Strong · up to ${PARALLAX_DISTANCE.strong}px`,
  },
  hover: {
    none: "No hover",
    lift: `Lift · rises ${HOVER_LIFT_PX}px`,
    scale: `Scale · grows to ${Math.round(HOVER_SCALE * 100)}%`,
    zoom: `Zoom · picture grows to ${Math.round(HOVER_ZOOM * 100)}%`,
    nudge: `Nudge · ${HOVER_NUDGE_PX}px toward the reading direction`,
  },
  textReveal: {
    none: "The whole text at once",
    words: "Word by word",
  },
};

/** The one way a stored value becomes words in the panel. */
export function motionValueLabel(field: keyof MotionBranch, value: unknown): string {
  if (value === undefined) return "";
  if (field === "delay" && typeof value === "number") return `${value}ms`;
  const key = String(value);
  return FIELD_VALUE_LABELS[field]?.[key] ?? MOTION_VALUE_LABELS[key] ?? key;
}

/**
 * What a field does when nothing is stored for it anywhere — the engine's own
 * default, which is the legacy entrance's timing (`.reveal`: 0.76s, Expo out,
 * no delay). Named, so "Default" is never a guess.
 */
export const MOTION_DEFAULT_LABELS: Record<Exclude<keyof MotionBranch, "entrance">, string> = {
  direction: "from the start edge",
  duration: "Slow · 0.76s",
  delay: "no delay",
  easing: "Expo out",
  stagger: "the list arrives as one",
  parallax: "no parallax",
  hover: "no hover movement",
  textReveal: "the whole text at once",
};

/** Said under the Parallax control in the editor — the rule, in the words the brief fixed. */
export const PARALLAX_PAUSED_NOTE = "Parallax is paused while editing. Use Replay to preview it.";

/** A refusal in words, for the one line the panel shows instead of controls. */
export const MOTION_REFUSAL_LABELS: Record<MotionRefusal, string> = {
  own: "This element already runs its own entrance, so it cannot be given another.",
  inline: "This is an inline piece of a sentence; move the sentence instead.",
  glyph: "Icons move with the element around them.",
  unaddressable: "This element cannot carry motion of its own.",
  still: "This is the site's navigation, generated for every page; it does not move.",
};
