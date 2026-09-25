/**
 * Advanced motion, as a closed vocabulary.
 *
 * The same rule that governs `StyleDocument`, applied to a second domain: **a
 * stored motion is never a string the renderer has to trust.** There is no CSS
 * text, no class name, no selector, no transform, no filter, no
 * `cubic-bezier(…)` and no duration string anywhere in this document — only
 * named keys whose values come from an enumeration or a bounded, snapped
 * number. A key the renderer does not know is inert; a value out of range never
 * reaches it.
 *
 * ## Why this is a second module rather than a wider `motion.ts`
 *
 * `motion.ts` is the *legacy preset* authority: one of five strings, stored in
 * `page_sections.animation` and `draft_animation`, understood by the release
 * recorded in `deploy/previous-release`. That contract cannot change, because a
 * rollback reads those two columns and nothing else. So the five presets keep
 * their module, their validator and their meaning, and everything Batch 15 adds
 * lives here, in two additive JSONB columns beside them.
 *
 * The relationship is one-directional and explicit: `legacyProjection` turns an
 * advanced document into the nearest of the five presets, and every write of a
 * document writes that projection into the legacy column beside it. A build
 * that has never heard of this module therefore still shows a sensible entrance
 * for every section — Blur Reveal degrades to a fade, Mask Reveal to the
 * movement it most resembles — rather than showing nothing or showing whatever
 * the column happened to hold.
 *
 * ## Addresses
 *
 * `nodes` is keyed by the same **section-relative** path a style override is
 * keyed by (`field:headline`, `field:links/item:i_…/field:label`), so one
 * identity serves Layers, direct editing, styles and motion. The section's own
 * wrapper is `section`, not `nodes.root`: it is the one target whose Base
 * entrance has a legacy spelling, and keeping it apart keeps that rule in one
 * place. A runtime `section:42/…` address is not a key this document can mean,
 * and neither is a selector.
 *
 * ## Scope
 *
 * Batch 15a: entrances (including Blur and Mask), direction, duration, delay,
 * easing and stagger — every key this build can render, and no other. A key
 * this build does not know is dropped on read, exactly as an unknown style
 * token is, so any later addition to this same v1 document is additive and
 * never misread; nothing is stored here that this build cannot render, because
 * a field with no renderer is the storage twin of a control that does nothing.
 */
import { normalizeNodePath } from "./address";
import { BREAKPOINTS, type Breakpoint } from "./styles";

export const MOTION_DOCUMENT_VERSION = 1;

/* -------------------------------------------------------------------------- */
/* The closed vocabulary, once                                                */
/* -------------------------------------------------------------------------- */

/**
 * Entrances. The first four and `none` are the legacy presets under their own
 * names, so a document can say what a section already says; `blur` and `mask`
 * are new.
 *
 * Deliberately the same spellings as `MOTION_PRESETS`: an advanced document
 * that only chooses `slide-in` means exactly what the legacy column means,
 * which is what makes the projection between them trivial and total.
 */
export const ENTRANCES = [
  "fade-up",
  "fade",
  "slide-in",
  "scale-in",
  "blur",
  "mask",
  "none",
] as const;
export type Entrance = (typeof ENTRANCES)[number];

/** Entrances that travel, and therefore take a direction. */
export const DIRECTIONAL: ReadonlySet<Entrance> = new Set(["slide-in", "mask"]);

/**
 * Which way a directional entrance goes — logical, never physical.
 *
 * Two axes, each read the natural way for its axis:
 *
 *   · **inline** — `start` and `end` name the edge the element arrives *from*
 *     (a slide) or the edge a wipe *begins at* (a mask). They follow the
 *     reading direction, so a stored `start` is the left in English and the
 *     right in Arabic, and nothing in the document names a side.
 *   · **block** — `up` and `down` name the direction of travel: a slide `up`
 *     rises from below, a mask `up` wipes from the bottom edge upward. The
 *     block axis does not mirror, so these need no RTL handling at all.
 *
 * `start` is the default for both entrances, because it is what the legacy
 * "Slide in from the leading edge" has always done.
 */
export const DIRECTIONS = ["start", "end", "up", "down"] as const;
export type MotionDirection = (typeof DIRECTIONS)[number];
export const DEFAULT_DIRECTION: MotionDirection = "start";

/** Durations are names mapped to the design system's own variables. */
export const DURATIONS = ["fast", "standard", "slow", "cinematic"] as const;
export type MotionDuration = (typeof DURATIONS)[number];

/** Easings are names mapped to the design system's own curves. */
export const EASINGS = ["soft-out", "expo-out", "soft-in-out"] as const;
export type MotionEasing = (typeof EASINGS)[number];

/**
 * Delay is a bounded, snapped number of milliseconds.
 *
 * 1500ms is the ceiling on purpose: past about a second and a half a visitor
 * who has scrolled to a section reads its absence as a broken page rather than
 * as a choice. 50ms steps because nothing finer is perceptible on an entrance
 * and a free number would give the same delay several spellings.
 */
export const DELAY_MAX = 1500;
export const DELAY_STEP = 50;

/** Named per-child steps rather than free milliseconds, for the same reason. */
export const STAGGERS = ["none", "tight", "normal", "relaxed"] as const;
export type Stagger = (typeof STAGGERS)[number];

/** One breakpoint's motion for one target. Sparse: every key is optional. */
export type MotionBranch = {
  entrance?: Entrance;
  direction?: MotionDirection;
  duration?: MotionDuration;
  /** 0…1500, in steps of 50. */
  delay?: number;
  easing?: MotionEasing;
  stagger?: Stagger;
};

export type MotionTarget = Partial<Record<Breakpoint, MotionBranch>>;

export type MotionDocument = {
  v: number;
  /** The section wrapper — the element the editor calls `root`. */
  section: MotionTarget;
  /** Section-relative node paths. Never `root`, a runtime address or a selector. */
  nodes: Record<string, MotionTarget>;
};

export const emptyMotionDocument = (): MotionDocument => ({
  v: MOTION_DOCUMENT_VERSION,
  section: {},
  nodes: {},
});

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

type Check = (raw: unknown) => unknown;

const oneOf = (values: readonly string[]): Check => {
  const allowed = new Set<string>(values);
  return (raw) => (typeof raw === "string" && allowed.has(raw) ? raw : undefined);
};

/**
 * A bounded number on a fixed grid.
 *
 * Off-grid input is refused rather than rounded: `75` is not a delay anybody
 * chose from a control that offers fifties, and storing it would give the
 * document a value the panel can never show. `NaN`, `±Infinity`, a numeric
 * string, a fraction and anything out of range are all the same answer — the
 * key is not written.
 */
const snapped = (max: number, step: number): Check => (raw) => {
  if (typeof raw !== "number" || !Number.isInteger(raw)) return undefined;
  if (raw < 0 || raw > max || raw % step !== 0) return undefined;
  return raw;
};

const FIELDS: Record<keyof MotionBranch, Check> = {
  entrance: oneOf(ENTRANCES),
  direction: oneOf(DIRECTIONS),
  duration: oneOf(DURATIONS),
  delay: snapped(DELAY_MAX, DELAY_STEP),
  easing: oneOf(EASINGS),
  stagger: oneOf(STAGGERS),
};

export const MOTION_FIELD_KEYS = Object.keys(FIELDS) as (keyof MotionBranch)[];

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** One breakpoint's branch, rebuilt key by key. Unknown keys never survive. */
export function validateMotionBranch(input: unknown): MotionBranch {
  const source = asRecord(input);
  const out: Record<string, unknown> = {};
  for (const key of MOTION_FIELD_KEYS) {
    if (!(key in source)) continue;
    const value = FIELDS[key](source[key]);
    if (value !== undefined) out[key] = value;
  }
  return out as MotionBranch;
}

/** One target's three branches, sparse. An empty branch is an inherited one. */
function validateTarget(input: unknown): MotionTarget {
  const source = asRecord(input);
  const out: MotionTarget = {};
  for (const breakpoint of BREAKPOINTS) {
    if (!(breakpoint in source)) continue;
    const branch = validateMotionBranch(source[breakpoint]);
    if (Object.keys(branch).length) out[breakpoint] = branch;
  }
  return out;
}

/**
 * Rebuilds a whole document from what was submitted or read back.
 *
 * Never throws and never returns something a renderer has to check. A malformed
 * document, a document from a version this build does not understand, or `null`
 * all come back as the empty document; running it twice gives the same answer,
 * which is what lets it sit on both the write path and the read path.
 */
export function validateMotionDocument(input: unknown): MotionDocument {
  const source = asRecord(input);
  const version = source.v;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return emptyMotionDocument();
  }
  // A newer build may mean something different by the same key, and guessing is
  // worse than ignoring.
  if (version > MOTION_DOCUMENT_VERSION) return emptyMotionDocument();

  const collected = new Map<string, MotionTarget>();
  for (const [rawPath, rawTarget] of Object.entries(asRecord(source.nodes))) {
    const path = normalizeNodePath(rawPath);
    // A key that is not a relative node path — a selector, a `section:42/…`
    // address, a locale suffix — is not something this document can mean. The
    // section's own wrapper lives under `section`, never under `nodes.root`.
    if (!path || path === "root") continue;
    const target = validateTarget(rawTarget);
    if (Object.keys(target).length) collected.set(path, target);
  }

  /**
   * Node paths in one fixed order, so a document has one spelling.
   *
   * PostgreSQL hands `jsonb` back with its own key order, and an editor's
   * insertion order is another; comparing either against the other would call
   * two identical documents different, and a section with nothing pending would
   * say it had a motion draft.
   */
  const nodes: Record<string, MotionTarget> = {};
  for (const path of [...collected.keys()].sort()) nodes[path] = collected.get(path)!;

  return { v: MOTION_DOCUMENT_VERSION, section: validateTarget(source.section), nodes };
}

/** A stored column, validated, or `null` when the column itself is `null`. */
export const readMotionDocument = (stored: unknown): MotionDocument | null =>
  stored === null || stored === undefined ? null : validateMotionDocument(stored);

/**
 * Whether a stored document is one this build may *publish*.
 *
 * Reading is forgiving — a column this build cannot understand renders as no
 * advanced motion, because a page has to render. Publishing is not: turning an
 * unreadable draft (a document from a newer build, or something that is not a
 * document at all) into the empty document would publish a value nobody chose
 * and throw away one somebody did. So publication asks this first, and refuses
 * rather than guessing — the same strictness `readMotion` gives a preset.
 */
export function isReadableMotionDocument(stored: unknown): boolean {
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return false;
  const version = (stored as Record<string, unknown>).v;
  return (
    typeof version === "number" &&
    Number.isInteger(version) &&
    version >= 1 &&
    version <= MOTION_DOCUMENT_VERSION
  );
}

export const isEmptyMotionDocument = (doc: MotionDocument): boolean =>
  Object.keys(doc.section).length === 0 && Object.keys(doc.nodes).length === 0;

/* -------------------------------------------------------------------------- */
/* Inheritance                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What a target actually does at one breakpoint: base, then tablet, then
 * mobile, each overriding only the keys it declares.
 *
 * Mobile inherits **through** tablet, exactly as a style branch does, so a
 * phone shows the tablet's shorter duration unless mobile says otherwise. The
 * document stays sparse: resetting a branch is a deleted key, never a copied
 * value.
 */
export function resolveBranch(target: MotionTarget | undefined, breakpoint: Breakpoint): MotionBranch {
  if (!target) return {};
  if (breakpoint === "base") return { ...target.base };
  if (breakpoint === "tablet") return { ...target.base, ...target.tablet };
  return { ...target.base, ...target.tablet, ...target.mobile };
}

/** Which branches a breakpoint inherits from, nearest last. */
export const MOTION_INHERITS_FROM: Record<Breakpoint, readonly Breakpoint[]> = {
  base: [],
  tablet: ["base"],
  mobile: ["base", "tablet"],
};

/* -------------------------------------------------------------------------- */
/* The legacy bridge                                                          */
/* -------------------------------------------------------------------------- */

export type LegacyPreset = "fade-up" | "fade" | "slide-in" | "scale-in" | "none";

/**
 * Which of the five legacy presets an advanced Base entrance most resembles.
 *
 * This is the whole of the rollback story, and it is deliberately a lossy,
 * total, source-owned mapping. The release recorded in `deploy/previous-release`
 * reads `page_sections.animation` and understands five strings; every write of
 * a document therefore writes one of those five beside it, so an older build
 * serving the same rows shows a section arriving rather than a section sitting
 * still or a column it cannot read.
 *
 *   · a legacy entrance with no direction, or `slide-in` from the start edge,
 *     maps to itself;
 *   · a slide from the end edge still maps to `slide-in` — the old build can
 *     only slide from the start, and a slide from the wrong side is closer to
 *     the intent than no slide;
 *   · a vertical slide or a vertical mask maps to `fade-up`, the one legacy
 *     movement on the block axis;
 *   · a horizontal mask maps to `slide-in`, the one legacy movement on the
 *     inline axis;
 *   · `blur` maps to `fade`, because a blur entrance is a fade with a filter
 *     on it and the filter is the part an old build cannot do.
 *
 * Only the **Base** section branch is projected. Tablet and mobile overrides,
 * node motion, stagger and timing have no legacy representation and are simply
 * absent from the old build's world, which is the correct degradation: it
 * renders the design it was written for.
 */
export function legacyProjection(
  document: MotionDocument | null | undefined,
  fallback: LegacyPreset,
): LegacyPreset {
  const base = document?.section?.base;
  const entrance = base?.entrance;
  if (entrance === undefined) return fallback;
  const direction = base?.direction ?? DEFAULT_DIRECTION;
  const vertical = direction === "up" || direction === "down";
  switch (entrance) {
    case "fade-up":
    case "fade":
    case "scale-in":
    case "none":
      return entrance;
    case "slide-in":
      return vertical ? "fade-up" : "slide-in";
    case "mask":
      return vertical ? "fade-up" : "slide-in";
    case "blur":
      return "fade";
  }
}

/**
 * The section target a render should use: the document's own branches, with
 * the legacy preset standing in as Base's entrance wherever the document does
 * not name one.
 *
 * That default is what lets a section keep its existing entrance while an
 * editor changes only its duration — the geometry still comes from the preset
 * everybody has been looking at since Batch 9.
 */
export function effectiveSectionTarget(
  document: MotionDocument | null | undefined,
  legacy: LegacyPreset,
): MotionTarget {
  const section = document?.section ?? {};
  return { ...section, base: { entrance: legacy, ...section.base } };
}

/**
 * The legacy preset a section target *is*, when it is nothing more than one —
 * or `null` when it needs the advanced layer.
 *
 * "Enter with Fade up at every width, on the default timing" is exactly what
 * the legacy `.reveal` classes already draw, so a target that says only that
 * is rendered on those classes. Two things follow. A section with no document
 * at all resolves here to its own column and renders byte for byte as it did
 * before Batch 15. And a section never changes rendering path merely because
 * its entrance moved from the column into a document — the pending preset the
 * first document write carries over (`motionDraftFromDocument`) looks exactly
 * as it did. The four legacy movements keep their own CSS, as agreed.
 *
 * A direction on an entrance that does not travel is inert and ignored; Slide
 * in is the legacy preset only from the start edge, which is the one edge the
 * legacy class knows.
 */
export function legacySectionPreset(target: MotionTarget): LegacyPreset | null {
  if (Object.keys(target).some((breakpoint) => breakpoint !== "base")) return null;
  const base = target.base ?? {};
  if (Object.keys(base).some((key) => key !== "entrance" && key !== "direction")) return null;
  switch (base.entrance) {
    case "fade-up":
    case "fade":
    case "scale-in":
    case "none":
      return base.entrance;
    case "slide-in":
      return (base.direction ?? DEFAULT_DIRECTION) === "start" ? "slide-in" : null;
    default:
      return null;
  }
}
