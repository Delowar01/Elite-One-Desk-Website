import type { CSSProperties } from "react";

import { formatNodePath, parseNodePath } from "./address";
import { resolveTokens, type Breakpoint, type StyleDocument, type StyleTokens } from "./styles";

/**
 * The one place a stored style token becomes CSS.
 *
 * Every value below is written here, in code. Nothing read from the database
 * ever reaches a style property: the stored string is a **key** into these
 * maps, and a key with no entry produces nothing. That is the difference
 * between "an editor chose the orange from our palette" and "an editor can put
 * any string into `color`" — and it is the reason this file is a pile of
 * literals rather than a clever transformation.
 *
 * The values themselves are the site's own tokens (`src/styles/globals.css`),
 * referenced as custom properties so a style override lands on the same colour,
 * radius and type ramp the hand-written components use. A second palette living
 * only in the visual editor would drift from the design the moment either
 * changed.
 *
 * Everything spatial is logical — `paddingInline`, `marginBlock`, `textAlign:
 * start`. There is no left and no right anywhere in this file, which is what
 * lets one stored document lay out correctly in English and in Arabic.
 */

/**
 * Spacing steps, 0…12. A ramp rather than a linear scale: the small end needs
 * fine control for type, the large end is section rhythm where 4px apart is a
 * distinction nobody can see.
 */
const SPACE: readonly string[] = [
  "0rem",
  "0.25rem",
  "0.5rem",
  "0.75rem",
  "1rem",
  "1.5rem",
  "2rem",
  "2.5rem",
  "3rem",
  "4rem",
  "5rem",
  "6rem",
  "8rem",
];

const space = (step: number | undefined): string | undefined =>
  step === undefined ? undefined : SPACE[step];

const TEXT_COLOR: Record<NonNullable<StyleTokens["textColor"]>, string> = {
  strong: "var(--text-strong)",
  body: "var(--text-body-color)",
  muted: "var(--text-muted)",
  peach: "var(--color-peach)",
  orange: "var(--color-orange)",
  warm: "var(--color-warm)",
  "on-accent": "var(--color-on-accent)",
};

/**
 * `none` is a choice, not an absence: an editor who picks it wants the ground
 * behind this element to show through, which is why it maps to `transparent`
 * rather than to nothing at all. Nothing at all is what an *unset* token means.
 */
const BACKGROUND: Record<NonNullable<StyleTokens["background"]>, string> = {
  none: "transparent",
  surface: "var(--surface)",
  "surface-raised": "var(--surface-raised)",
  "ink-900": "var(--color-ink-900)",
  "ink-800": "var(--color-ink-800)",
  "ink-700": "var(--color-ink-700)",
  "ink-600": "var(--color-ink-600)",
};

/**
 * The type ramp, with the line height and letter spacing that belong to each
 * step. The site's components get those through Tailwind's font-size
 * modifiers; a style override sets the size directly, so it has to carry the
 * rest of the step with it or a display-sized heading would keep body leading.
 */
const FONT_SIZE: Record<
  NonNullable<StyleTokens["fontSize"]>,
  { fontSize: string; lineHeight: string; letterSpacing?: string }
> = {
  eyebrow: {
    fontSize: "var(--text-eyebrow)",
    lineHeight: "var(--text-eyebrow--line-height)",
    letterSpacing: "var(--text-eyebrow--letter-spacing)",
  },
  small: { fontSize: "var(--text-small)", lineHeight: "var(--text-small--line-height)" },
  body: { fontSize: "var(--text-body)", lineHeight: "var(--text-body--line-height)" },
  lead: { fontSize: "var(--text-lead)", lineHeight: "var(--text-lead--line-height)" },
  h3: {
    fontSize: "var(--text-h3)",
    lineHeight: "var(--text-h3--line-height)",
    letterSpacing: "var(--text-h3--letter-spacing)",
  },
  h2: {
    fontSize: "var(--text-h2)",
    lineHeight: "var(--text-h2--line-height)",
    letterSpacing: "var(--text-h2--letter-spacing)",
  },
  h1: {
    fontSize: "var(--text-h1)",
    lineHeight: "var(--text-h1--line-height)",
    letterSpacing: "var(--text-h1--letter-spacing)",
  },
  display: {
    fontSize: "var(--text-display)",
    lineHeight: "var(--text-display--line-height)",
    letterSpacing: "var(--text-display--letter-spacing)",
  },
};

const RADIUS: Record<NonNullable<StyleTokens["radius"]>, string> = {
  none: "0px",
  xs: "var(--radius-xs)",
  sm: "var(--radius-sm)",
  md: "var(--radius-md)",
  lg: "var(--radius-lg)",
  xl: "var(--radius-xl)",
  full: "9999px",
};

const BORDER: Record<NonNullable<StyleTokens["border"]>, string> = {
  none: "none",
  line: "1px solid var(--color-line)",
  "line-strong": "1px solid var(--color-line-strong)",
  accent: "1px solid var(--color-orange)",
};

const SHADOW: Record<NonNullable<StyleTokens["shadow"]>, string> = {
  none: "none",
  soft: "var(--shadow-soft)",
  lift: "var(--shadow-lift)",
  ring: "var(--shadow-ring)",
};

const MAX_WIDTH: Record<NonNullable<StyleTokens["maxWidth"]>, string> = {
  none: "none",
  prose: "65ch",
  site: "var(--container-site)",
  wide: "var(--container-wide)",
};

/**
 * Validated tokens to React's style object, or nothing.
 *
 * Nothing, rather than an empty object, is the point: a section with no
 * overrides must render exactly the markup it rendered before this batch
 * existed, and `style={{}}` is not that. Sparse in, sparse out.
 */
export function tokensToStyle(tokens: StyleTokens): CSSProperties | undefined {
  const out: CSSProperties = {};

  if (tokens.align) out.textAlign = tokens.align;
  if (tokens.fontSize) Object.assign(out, FONT_SIZE[tokens.fontSize]);
  if (tokens.fontWeight) out.fontWeight = tokens.fontWeight;
  if (tokens.textColor) out.color = TEXT_COLOR[tokens.textColor];
  if (tokens.background) out.background = BACKGROUND[tokens.background];

  const padBlock = space(tokens.padBlock);
  if (padBlock) out.paddingBlock = padBlock;
  const padInline = space(tokens.padInline);
  if (padInline) out.paddingInline = padInline;
  const marginBlock = space(tokens.marginBlock);
  if (marginBlock) out.marginBlock = marginBlock;
  const marginInline = space(tokens.marginInline);
  if (marginInline) out.marginInline = marginInline;
  const gap = space(tokens.gap);
  if (gap) out.gap = gap;

  if (tokens.radius) out.borderRadius = RADIUS[tokens.radius];
  if (tokens.border) out.border = BORDER[tokens.border];
  if (tokens.shadow) out.boxShadow = SHADOW[tokens.shadow];
  if (tokens.opacity !== undefined) out.opacity = tokens.opacity;
  if (tokens.maxWidth) out.maxWidth = MAX_WIDTH[tokens.maxWidth];

  // One property from two tokens, so setting only the horizontal focal point
  // leaves the vertical one centred rather than at the top.
  if (tokens.objectX !== undefined || tokens.objectY !== undefined) {
    out.objectPosition = `${tokens.objectX ?? 50}% ${tokens.objectY ?? 50}%`;
  }

  return Object.keys(out).length ? out : undefined;
}

/**
 * The style for one node of a section, by its relative path.
 *
 * The path is normalised through the Batch 2 parser rather than compared as a
 * string, so `field:headline` and a stored key that means the same thing
 * resolve to one node — and a key that is not a node path at all resolves to
 * nothing.
 */
export function nodeStyle(
  document: StyleDocument | undefined,
  path: string | undefined,
  breakpoint: Breakpoint = "base",
): CSSProperties | undefined {
  if (!document) return undefined;
  const parsed = parseNodePath(path === undefined ? "root" : path);
  if (!parsed) return undefined;
  const node = document.nodes[formatNodePath(parsed)];
  if (!node) return undefined;
  return tokensToStyle(resolveTokens(node, breakpoint));
}
