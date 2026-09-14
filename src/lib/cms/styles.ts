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
 * owner — see `page_sections.animation`, and Batch 9.
 *
 * Nothing reads this document yet. It is validated, stored and dormant.
 */
import { normalizeNodePath } from "./address";

export const STYLE_DOCUMENT_VERSION = 1;

/** Desktop is the base; the other two are sparse overrides on top of it. */
export const BREAKPOINTS = ["base", "tablet", "mobile"] as const;
export type Breakpoint = (typeof BREAKPOINTS)[number];

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
  hidden?: boolean;
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

const ratio = (min: number, max: number, snap: number): Check => (raw) => {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return undefined;
  if (raw < min || raw > max) return undefined;
  return Math.round(raw / snap) * snap;
};

const percent = (): Check => (raw) => {
  const value = typeof raw === "number" ? raw : Number.NaN;
  if (!Number.isFinite(value) || value < 0 || value > 100) return undefined;
  return Math.round(value);
};

const flag = (): Check => (raw) => (typeof raw === "boolean" ? raw : undefined);

/**
 * Every spatial key is logical. There is no `marginLeft`, no `paddingRight`,
 * no `left` and no `right`, so a value chosen in English cannot land on the
 * wrong side in Arabic — the site's existing RTL behaviour depends on exactly
 * this and it is cheaper to refuse the physical vocabulary than to mirror it.
 */
const TOKENS: Record<keyof StyleTokens, Check> = {
  align: oneOf(["start", "center", "end"]),
  fontSize: oneOf(["eyebrow", "small", "body", "lead", "h3", "h2", "h1", "display"]),
  fontWeight: oneOf([400, 500, 600, 700, 800]),
  textColor: oneOf(["strong", "body", "muted", "peach", "orange", "warm", "on-accent"]),
  background: oneOf(["none", "surface", "surface-raised", "ink-900", "ink-800", "ink-700", "ink-600"]),
  padBlock: step(12),
  padInline: step(12),
  marginBlock: step(12),
  marginInline: step(12),
  gap: step(12),
  radius: oneOf(["none", "xs", "sm", "md", "lg", "xl", "full"]),
  border: oneOf(["none", "line", "line-strong", "accent"]),
  shadow: oneOf(["none", "soft", "lift", "ring"]),
  opacity: ratio(0.2, 1, 0.05),
  maxWidth: oneOf(["none", "prose", "site", "wide"]),
  objectX: percent(),
  objectY: percent(),
  hidden: flag(),
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
 * Exported for the batches that will render it; nothing calls it yet.
 */
export function resolveTokens(node: StyleNode | undefined, breakpoint: Breakpoint): StyleTokens {
  if (!node) return {};
  if (breakpoint === "base") return { ...node.base };
  if (breakpoint === "tablet") return { ...node.base, ...node.tablet };
  return { ...node.base, ...node.tablet, ...node.mobile };
}
