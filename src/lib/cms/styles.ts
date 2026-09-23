/**
 * Visual overrides, as a closed vocabulary.
 *
 * The rule this module exists to enforce: **a stored style is never a string
 * the renderer has to trust.** There is no `css`, no `class`, no `style`, no
 * selector and no CSS variable name anywhere in the document — only named keys
 * whose values are drawn from an enumeration or a bounded number. A key the
 * renderer does not know is inert; a value out of range never reaches it. That
 * is what keeps "an admin styled a card" from becoming "an admin can write
 * arbitrary CSS into every page".
 *
 * Keys inside `nodes` are section-**relative** paths (`root`, `field:headline`,
 * `field:links/item:i_…/slot:media`). The row already identifies the section,
 * and a stored `section:42/...` would survive a duplicate, a restore or a copy
 * as a reference to a section that is no longer the one it is sitting in.
 *
 * Motion is deliberately absent. It is a different domain with a different
 * owner and a column of its own — `page_sections.animation`, drafted in
 * `draft_animation`, with its vocabulary in `lib/cms/motion`. A section has
 * one entrance, not a token per node, so putting it here would have meant a
 * style key that only ever meant anything on `root`.
 *
 * The enumerations below are exported because the panel offers them: one list
 * per token, read by the control that sets it and by the check that accepts it.
 * Two lists would eventually disagree, and the way they would disagree is a
 * control offering a value the validator silently drops.
 */
import { normalizeNodePath } from "./address";

export const STYLE_DOCUMENT_VERSION = 1;

/** Desktop is the base; the other two are sparse overrides on top of it. */
export const BREAKPOINTS = ["base", "tablet", "mobile"] as const;
export type Breakpoint = (typeof BREAKPOINTS)[number];

/** The two that are conditional. `base` is the absence of a condition. */
export const RESPONSIVE_BREAKPOINTS = ["tablet", "mobile"] as const;
export type ResponsiveBreakpoint = (typeof RESPONSIVE_BREAKPOINTS)[number];

/**
 * The widths the two override branches apply at, as `max-width` in pixels.
 *
 * Written once, here, and read by the renderer, the panel and the tests. The
 * stylesheet cannot import a TypeScript constant, so `globals.css` repeats the
 * two numbers literally — and a test reads the stylesheet back and fails if
 * either one drifts from this table. That is the whole of the relationship:
 * one owner, one checker, no third copy.
 *
 * These are **application** breakpoints, not the editor's canvas widths. The
 * canvas renders at 1440 / 834 / 390 (`visual-editor/viewport.ts`) because
 * those are the design widths; they sit inside these ranges rather than
 * defining them, so what an editor sees at "Tablet" is what a visitor at any
 * tablet width sees. Making 834 the breakpoint would mean a real 900px tablet
 * got the desktop layout and nobody could see that in the editor.
 *
 * 1024 and 640 are the site's own `lg` and `sm` boundaries, so a responsive
 * override changes at the same width the hand-written layout already does.
 */
export const RESPONSIVE_WIDTHS: Record<ResponsiveBreakpoint, number> = {
  tablet: 1024,
  mobile: 640,
};

/* -------------------------------------------------------------------------- */
/* The closed vocabulary, once                                                */
/* -------------------------------------------------------------------------- */

export const ALIGNMENTS = ["start", "center", "end"] as const;
export const FONT_SIZES = ["eyebrow", "small", "body", "lead", "h3", "h2", "h1", "display"] as const;
export const FONT_WEIGHTS = [400, 500, 600, 700, 800] as const;
export const TEXT_COLORS = ["strong", "body", "muted", "peach", "orange", "warm", "on-accent"] as const;
export const BACKGROUNDS = [
  "none",
  "surface",
  "surface-raised",
  "ink-900",
  "ink-800",
  "ink-700",
  "ink-600",
] as const;
export const RADII = ["none", "xs", "sm", "md", "lg", "xl", "full"] as const;
export const BORDERS = ["none", "line", "line-strong", "accent"] as const;
export const SHADOWS = ["none", "soft", "lift", "ring"] as const;
export const MAX_WIDTHS = ["none", "prose", "site", "wide"] as const;

/** Spacing is a step on this scale, never a length. Steps run 0…SPACING_STEPS. */
export const SPACING_STEPS = 12;

/** Opacity is bounded and snapped; the panel offers exactly these. */
export const OPACITY_MIN = 0.2;
export const OPACITY_MAX = 1;
export const OPACITY_SNAP = 0.05;

export type StyleTokens = {
  align?: "start" | "center" | "end";
  fontSize?: "eyebrow" | "small" | "body" | "lead" | "h3" | "h2" | "h1" | "display";
  fontWeight?: 400 | 500 | 600 | 700 | 800;
  textColor?: "strong" | "body" | "muted" | "peach" | "orange" | "warm" | "on-accent";
  background?: "none" | "surface" | "surface-raised" | "ink-900" | "ink-800" | "ink-700" | "ink-600";
  padBlock?: number;
  padInline?: number;
  marginBlock?: number;
  marginInline?: number;
  gap?: number;
  radius?: "none" | "xs" | "sm" | "md" | "lg" | "xl" | "full";
  border?: "none" | "line" | "line-strong" | "accent";
  shadow?: "none" | "soft" | "lift" | "ring";
  opacity?: number;
  maxWidth?: "none" | "prose" | "site" | "wide";
  objectX?: number;
  objectY?: number;
  /** True or absent. There is no stored `false` — see `onlyTrue`. */
  hidden?: true;
};

export type StyleNode = Partial<Record<Breakpoint, StyleTokens>>;

export type StyleDocument = {
  v: number;
  nodes: Record<string, StyleNode>;
};

export const EMPTY_STYLE_DOCUMENT: StyleDocument = { v: STYLE_DOCUMENT_VERSION, nodes: {} };

/* -------------------------------------------------------------------------- */
/* The vocabulary                                                             */
/* -------------------------------------------------------------------------- */

type Check = (raw: unknown) => unknown;

const oneOf = (values: readonly (string | number)[]): Check => {
  const allowed = new Set<string | number>(values);
  return (raw) => (typeof raw === "string" || typeof raw === "number") && allowed.has(raw) ? raw : undefined;
};

/**
 * A spacing value is a step on a scale, not a length. Storing `24px` would let
 * one card sit off the grid the rest of the site is built on, and would put a
 * unit — a string — where a number belongs.
 */
const step = (max: number): Check => (raw) => {
  const value = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isInteger(value) || value < 0 || value > max) return undefined;
  return value;
};

/**
 * A value on a fixed grid, spelled the one way the grid spells it.
 *
 * `Math.round(raw / snap) * snap` lands on the right *number* and the wrong
 * *representation*: with a snap of 0.05, twelve steps up from zero is
 * `0.6000000000000001`, because neither 0.05 nor 0.6 is exact in binary
 * floating point and the multiply carries the error. That value is on the grid
 * by any sane reading, and it was being stored, exported and compared as
 * something else — two documents holding the same opacity would not be equal,
 * and a validated document was not equal to itself validated twice.
 *
 * Counting steps and dividing back gives the shortest decimal that round-trips,
 * which for every step of this grid is the one a person would write: 0.2, 0.25,
 * … 0.95, 1. It is still a number — nothing here turns a style token into a
 * string — and it is idempotent by construction, because the canonical value
 * lands on the same step it came from.
 *
 * `Number.EPSILON` is not involved: the fix is to stop generating the artefact,
 * not to tolerate it afterwards. A stored `0.6000000000000001` from before this
 * existed normalises to `0.6` the next time the document is validated, without
 * a migration.
 */
const ratio = (min: number, max: number, snap: number): Check => (raw) => {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  if (raw < min || raw > max) return undefined;
  const steps = Math.round(raw / snap);
  const places = Math.max(0, (String(snap).split(".")[1] ?? "").length);
  return Number((steps * snap).toFixed(places));
};

const percent = (): Check => (raw) => {
  const value = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(value) || value < 0 || value > 100) return undefined;
  return Math.round(value);
};

/**
 * Hiding is true or it is not stored at all.
 *
 * `hidden: false` is not how this document says "shown" — the absence of the
 * key is, at every branch. Keeping a stored `false` would give the same state
 * two spellings, and they would drift: one node saying nothing and another
 * saying `false` would look different in the panel, diff differently, and make
 * "does this branch override anything" a question with two answers. It would
 * also be the first half of a re-show model the responsive contract does not
 * have, since hiding runs downwards and there is no way to bring something
 * back at a narrower width.
 *
 * So anything that is not exactly `true` — `false`, `"false"`, `0`, `null` —
 * is dropped, and an editor who turns hiding off deletes the key.
 */
const onlyTrue = (): Check => (raw) => (raw === true ? true : undefined);

/**
 * Every spatial key is logical. There is no `marginLeft`, no `paddingRight`,
 * no `left` and no `right`, so a value chosen in English cannot land on the
 * wrong side in Arabic — the site's existing RTL behaviour depends on exactly
 * this and it is cheaper to refuse the physical vocabulary than to mirror it.
 */
const TOKENS: Record<keyof StyleTokens, Check> = {
  align: oneOf(ALIGNMENTS),
  fontSize: oneOf(FONT_SIZES),
  fontWeight: oneOf(FONT_WEIGHTS),
  textColor: oneOf(TEXT_COLORS),
  background: oneOf(BACKGROUNDS),
  padBlock: step(SPACING_STEPS),
  padInline: step(SPACING_STEPS),
  marginBlock: step(SPACING_STEPS),
  marginInline: step(SPACING_STEPS),
  gap: step(SPACING_STEPS),
  radius: oneOf(RADII),
  border: oneOf(BORDERS),
  shadow: oneOf(SHADOWS),
  opacity: ratio(OPACITY_MIN, OPACITY_MAX, OPACITY_SNAP),
  maxWidth: oneOf(MAX_WIDTHS),
  objectX: percent(),
  objectY: percent(),
  hidden: onlyTrue(),
};

export const STYLE_TOKEN_KEYS = Object.keys(TOKENS) as (keyof StyleTokens)[];

/* -------------------------------------------------------------------------- */
/* Validation                                                                 */
/* -------------------------------------------------------------------------- */

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** One breakpoint's tokens, rebuilt key by key. Unknown keys never survive. */
export function validateTokens(input: unknown): StyleTokens {
  const source = asRecord(input);
  const out: Record<string, unknown> = {};
  for (const key of STYLE_TOKEN_KEYS) {
    if (!(key in source)) continue;
    const value = TOKENS[key](source[key]);
    if (value !== undefined) out[key] = value;
  }
  return out as StyleTokens;
}

/**
 * Rebuilds a whole document from what was submitted or read back.
 *
 * Never throws and never returns something a renderer has to check: a
 * malformed document, a document from a version this build does not
 * understand, or `null` all come back as the empty document. Running it twice
 * gives the same answer, which is what lets it sit on both the write path and
 * the read path.
 */
export function validateStyleDocument(input: unknown): StyleDocument {
  const source = asRecord(input);
  const version = source.v;
  // Explicit rather than lenient: a document written by a newer build may mean
  // something different by the same key, and guessing is worse than ignoring.
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return { v: STYLE_DOCUMENT_VERSION, nodes: {} };
  }
  if (version > STYLE_DOCUMENT_VERSION) return { v: STYLE_DOCUMENT_VERSION, nodes: {} };

  const nodes: Record<string, StyleNode> = {};
  for (const [rawPath, rawNode] of Object.entries(asRecord(source.nodes))) {
    const path = normalizeNodePath(rawPath);
    // A key that is not a relative node path — a selector, a `section:42/…`
    // address, a locale suffix — is not something this document can mean.
    if (!path) continue;

    const node: StyleNode = {};
    const nodeSource = asRecord(rawNode);
    for (const breakpoint of BREAKPOINTS) {
      if (!(breakpoint in nodeSource)) continue;
      const tokens = validateTokens(nodeSource[breakpoint]);
      // Sparse by construction: an empty breakpoint is an inherited one, and
      // storing `{}` would be a claim that it was overridden with nothing.
      if (Object.keys(tokens).length) node[breakpoint] = tokens;
    }
    if (Object.keys(node).length) nodes[path] = node;
  }

  return { v: STYLE_DOCUMENT_VERSION, nodes };
}

export const isEmptyStyleDocument = (doc: StyleDocument): boolean =>
  Object.keys(doc.nodes).length === 0;

/**
 * What a node actually looks like at one breakpoint: base, then tablet, then
 * mobile, each overriding only the keys it declares. Sparse all the way down,
 * so "reset this override" is a deleted key rather than a copied value.
 *
 * Mobile inherits **through** tablet, not around it: a mobile view of a node
 * whose tablet branch shrank the heading and whose base branch coloured it
 * gets the small heading and the colour. That is why the third line spreads
 * all three rather than base and mobile.
 *
 * The panel uses this to tell an editor what a value would be if they did not
 * override it. The renderer does not: on a page the same answer comes out of
 * the CSS cascade, because base is applied unconditionally and each branch is
 * applied inside its own media query. Resolving at render time as well would
 * be a second implementation of inheritance, and the two would disagree the
 * first time one of them was changed.
 */
export function resolveTokens(node: StyleNode | undefined, breakpoint: Breakpoint): StyleTokens {
  if (!node) return {};
  if (breakpoint === "base") return { ...node.base };
  if (breakpoint === "tablet") return { ...node.base, ...node.tablet };
  return { ...node.base, ...node.tablet, ...node.mobile };
}
