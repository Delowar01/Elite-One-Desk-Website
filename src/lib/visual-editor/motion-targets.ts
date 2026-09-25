import { getBlock, type FieldDef, type ItemFieldDef } from "@/lib/cms/blocks";
import { formatNodePath, parseNodePath, type NodePath } from "@/lib/cms/address";
import {
  DIRECTIONAL,
  ENTRANCES,
  MOTION_FIELD_KEYS,
  resolveBranch,
  validateMotionDocument,
  type Entrance,
  type MotionBranch,
  type MotionDocument,
  type MotionTarget,
} from "@/lib/cms/motion-doc";
import { isStaggerGroup } from "@/lib/cms/motion-css";
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
 */

export type MotionKind = "section" | "list" | "item" | "text" | "media" | "slot";

/** Why a node offers nothing, in words the panel can repeat. */
export type MotionRefusal = "own" | "inline" | "glyph" | "unaddressable";

export type MotionCapability =
  | { kind: MotionKind; fields: readonly (keyof MotionBranch)[] }
  | { kind: null; fields: readonly []; reason: MotionRefusal };

/** An entrance, its direction and its timing — what every animated node has. */
const ENTRANCE_FIELDS = ["entrance", "direction", "duration", "delay", "easing"] as const;
/** A list adds the one thing only a list can do: send its rows in turn. */
const LIST_FIELDS = [...ENTRANCE_FIELDS, "stagger"] as const;

const refuse = (reason: MotionRefusal): MotionCapability => ({ kind: null, fields: [], reason });

const SECTION: MotionCapability = { kind: "section", fields: ENTRANCE_FIELDS };
const SLOT: MotionCapability = { kind: "slot", fields: ENTRANCE_FIELDS };
const ITEM: MotionCapability = { kind: "item", fields: ENTRANCE_FIELDS };
const LIST: MotionCapability = { kind: "list", fields: LIST_FIELDS };
const TEXT: MotionCapability = { kind: "text", fields: ENTRANCE_FIELDS };
const MEDIA: MotionCapability = { kind: "media", fields: ENTRANCE_FIELDS };

function fieldCapability(field: FieldDef | ItemFieldDef | undefined): MotionCapability {
  if (!field) return TEXT;
  if (field.motion === "own") return refuse("own");
  if (field.box === "inline") return refuse("inline");
  if (field.type === "icon") return refuse("glyph");
  if (field.type === "media") return MEDIA;
  if (field.type === "items") return LIST;
  return TEXT;
}

/**
 * The capability of one node of one block, by its section-relative path.
 *
 * `undefined` and `root` are the section's own wrapper. A path the parser
 * refuses offers nothing rather than guessing at segments.
 */
export function motionTargetFor(blockType: string, path: string | undefined): MotionCapability {
  if (path === undefined || path === "root") return SECTION;
  const parsed: NodePath | null = parseNodePath(path);
  if (!parsed) return refuse("unaddressable");
  if (parsed.length === 0) return SECTION;

  const block = getBlock(blockType);
  const [first, second, third] = parsed;

  if (first!.kind === "slot") return SLOT;
  if (first!.kind !== "field") return refuse("unaddressable");

  const field = block?.fields.find((entry) => entry.name === first!.name);
  if (parsed.length === 1) return fieldCapability(field);

  // `field:x/item:i_…` — one row of a repeatable list.
  if (second?.kind === "item" && parsed.length === 2) return ITEM;

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
 */
export function offeredMotionFields(
  capability: MotionCapability,
  target: MotionTarget | undefined,
  breakpoint: Breakpoint,
  legacy?: Entrance,
): readonly (keyof MotionBranch)[] {
  if (capability.kind === null) return [];
  const entrance =
    resolveBranch(target, breakpoint).entrance ?? (capability.kind === "section" ? legacy : undefined);
  const moving = entrance !== undefined && entrance !== "none";
  return capability.fields.filter((field) => {
    if (field === "entrance") return true;
    if (field === "direction") return entrance !== undefined && DIRECTIONAL.has(entrance);
    if (field === "stagger") return capability.kind === "list" && moving;
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
  const keep = (target: MotionTarget, allowed: ReadonlySet<keyof MotionBranch>): MotionTarget => {
    const out: MotionTarget = {};
    for (const breakpoint of ["base", "tablet", "mobile"] as const) {
      const branch = target[breakpoint];
      if (!branch) continue;
      const next: MotionBranch = {};
      for (const key of MOTION_FIELD_KEYS) {
        if (branch[key] !== undefined && allowed.has(key)) {
          (next as Record<string, unknown>)[key] = branch[key];
        }
      }
      if (Object.keys(next).length) out[breakpoint] = next;
    }
    return out;
  };

  const section = keep(document.section, new Set(SECTION.fields));
  const nodes: Record<string, MotionTarget> = {};
  for (const [path, target] of Object.entries(document.nodes)) {
    const capability = motionTargetFor(blockType, path);
    if (capability.kind === null) continue;
    const kept = keep(target, new Set(capability.fields));
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
};

/** A refusal in words, for the one line the panel shows instead of controls. */
export const MOTION_REFUSAL_LABELS: Record<MotionRefusal, string> = {
  own: "This element already runs its own entrance, so it cannot be given another.",
  inline: "This is an inline piece of a sentence; move the sentence instead.",
  glyph: "Icons move with the element around them.",
  unaddressable: "This element cannot carry motion of its own.",
};
