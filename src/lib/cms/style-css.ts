import type { CSSProperties } from "react";

import { formatNodePath, parseNodePath } from "./address";
import {
  RESPONSIVE_BREAKPOINTS,
  resolveTokens,
  type Breakpoint,
  type ResponsiveBreakpoint,
  type StyleDocument,
  type StyleNode,
  type StyleTokens,
} from "./styles";

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
 * Batch 14 — layout. Still literals, still logical, still no unit from the
 * database.
 *
 * The fractions are written out rather than computed, so `two-thirds` has one
 * spelling in one place and a rounding choice cannot drift between the base
 * style and a breakpoint override.
 */
const WIDTH: Record<NonNullable<StyleTokens["width"]>, string> = {
  auto: "auto",
  fit: "fit-content",
  quarter: "25%",
  third: "33.3333%",
  half: "50%",
  "two-thirds": "66.6667%",
  "three-quarters": "75%",
  full: "100%",
};

/**
 * `svh` rather than `vh` for everything measured against the screen.
 *
 * On a phone `100vh` is the viewport with the browser chrome *retracted*, so a
 * band sized that way is taller than the screen until the address bar hides
 * and the page jumps when it does. `svh` is the small viewport — the height
 * that is actually visible on arrival — which is what "a screen tall" means to
 * the person who asked for it.
 */
const HEIGHT: Record<NonNullable<StyleTokens["height"]>, string> = {
  auto: "auto",
  fit: "fit-content",
  full: "100%",
  screen: "100svh",
};

const MIN_HEIGHT: Record<NonNullable<StyleTokens["minHeight"]>, string> = {
  none: "0px",
  "third-screen": "33svh",
  "half-screen": "50svh",
  "two-thirds-screen": "67svh",
  screen: "100svh",
};

const LAYOUT: Record<NonNullable<StyleTokens["layout"]>, string> = {
  block: "block",
  flex: "flex",
  grid: "grid",
};

const DIRECTION: Record<NonNullable<StyleTokens["direction"]>, "row" | "column"> = {
  row: "row",
  column: "column",
};

const WRAP: Record<NonNullable<StyleTokens["wrap"]>, "nowrap" | "wrap"> = {
  nowrap: "nowrap",
  wrap: "wrap",
};

/**
 * `start` and `end`, never `flex-start` and never `left`.
 *
 * These are the Box Alignment keywords, which resolve against the writing
 * direction: in English `start` is the left of a row, in Arabic it is the
 * right, and the same stored value is correct in both. They are also the
 * spelling grid containers accept, so one map serves both layout modes.
 */
const JUSTIFY_CONTENT: Record<NonNullable<StyleTokens["justify"]>, string> = {
  start: "start",
  center: "center",
  end: "end",
  between: "space-between",
  around: "space-around",
  evenly: "space-evenly",
};

const ALIGN: Record<NonNullable<StyleTokens["alignItems"]>, string> = {
  stretch: "stretch",
  start: "start",
  center: "center",
  end: "end",
};

/**
 * `minmax(0, 1fr)` rather than `1fr`.
 *
 * A bare `1fr` track has an automatic minimum, so one long unbroken word — a
 * URL, an Arabic compound — makes its column wider than its share and pushes
 * the grid past its container. The zero minimum is what keeps four equal
 * columns equal whatever is inside them.
 */
const gridColumns = (count: number): string => `repeat(${count}, minmax(0, 1fr))`;

const OVERFLOW: Record<NonNullable<StyleTokens["overflow"]>, string> = {
  visible: "visible",
  hidden: "hidden",
  clip: "clip",
};

/**
 * Glow, as the site's own light. Defined in `globals.css` beside the shadows
 * and retinted for the warm-white islands, so a glow on a light card is not
 * the invisible smudge a dark-ground value would be there.
 *
 * `none` is the empty string rather than the CSS keyword: it contributes
 * nothing to the composed `box-shadow` list, and a list of nothing becomes
 * `none` in one place below.
 */
const GLOW: Record<NonNullable<StyleTokens["glow"]>, string> = {
  none: "",
  soft: "var(--glow-soft)",
  accent: "var(--glow-accent)",
  strong: "var(--glow-strong)",
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

  /**
   * Shadow and glow are two tokens and one CSS property.
   *
   * `box-shadow` takes a list, so the honest rendering of "lift, and a soft
   * glow" is both layers in a fixed order — the shadow first, because it is the
   * object's weight and belongs under the light coming off it. Writing them
   * with two `if`s would mean whichever ran second erased the other, and the
   * panel would show two set controls while the page obeyed one.
   *
   * `none` is a real choice on both and contributes no layer; a pair of them
   * composes to `none`, which is what clears an inherited shadow. Neither token
   * being present leaves the property alone entirely.
   */
  if (tokens.shadow !== undefined || tokens.glow !== undefined) {
    const layers: string[] = [];
    if (tokens.shadow && tokens.shadow !== "none") layers.push(SHADOW[tokens.shadow]);
    if (tokens.glow && tokens.glow !== "none") layers.push(GLOW[tokens.glow]);
    out.boxShadow = layers.length ? layers.join(", ") : "none";
  }

  if (tokens.opacity !== undefined) out.opacity = tokens.opacity;
  if (tokens.maxWidth) out.maxWidth = MAX_WIDTH[tokens.maxWidth];

  if (tokens.width) out.width = WIDTH[tokens.width];
  if (tokens.height) out.height = HEIGHT[tokens.height];
  if (tokens.minHeight) out.minHeight = MIN_HEIGHT[tokens.minHeight];

  /**
   * Layout is `display`, and it is written before hiding for a reason — see the
   * note on `hidden` below.
   */
  if (tokens.layout) out.display = LAYOUT[tokens.layout];
  if (tokens.direction) out.flexDirection = DIRECTION[tokens.direction];
  if (tokens.wrap) out.flexWrap = WRAP[tokens.wrap];
  if (tokens.justify) out.justifyContent = JUSTIFY_CONTENT[tokens.justify];
  if (tokens.alignItems) out.alignItems = ALIGN[tokens.alignItems];
  if (tokens.columns !== undefined) out.gridTemplateColumns = gridColumns(tokens.columns);
  if (tokens.overflow) out.overflow = OVERFLOW[tokens.overflow];

  // One property from two tokens, so setting only the horizontal focal point
  // leaves the vertical one centred rather than at the top.
  if (tokens.objectX !== undefined || tokens.objectY !== undefined) {
    out.objectPosition = `${tokens.objectX ?? 50}% ${tokens.objectY ?? 50}%`;
  }

  /**
   * Hidden is `display: none`, not a transparent or invisible element.
   *
   * `opacity: 0` and `visibility: hidden` both leave the box exactly where it
   * was, so a card "hidden on mobile" would still push everything below it down
   * the page by its own height — a hole rather than a removal. Only `true`
   * counts: the document never stores `hidden: false` to mean "shown", because
   * inherited-and-not-overridden is what means shown.
   *
   * **Last, so it wins over `layout`.** Both write `display`, and hiding has to
   * beat laying out: an element hidden at Base and given a flex layout at
   * Tablet must stay hidden, or a layout choice would be a way to un-hide
   * something at a narrower width, which the responsive contract does not have.
   * `branchDeclarations` carries the pair together for the same reason.
   */
  if (tokens.hidden === true) out.display = "none";

  return Object.keys(out).length ? out : undefined;
}

/**
 * A node's tokens, or none, by its relative path.
 *
 * The path is normalised through the Batch 2 parser rather than compared as a
 * string, so `field:headline` and a stored key that means the same thing
 * resolve to one node — and a key that is not a node path at all resolves to
 * nothing.
 */
export function nodeOf(
  document: StyleDocument | undefined,
  path: string | undefined,
): StyleNode | undefined {
  if (!document) return undefined;
  const parsed = parseNodePath(path === undefined ? "root" : path);
  if (!parsed) return undefined;
  return document.nodes[formatNodePath(parsed)];
}

export function nodeTokens(
  document: StyleDocument | undefined,
  path: string | undefined,
  breakpoint: Breakpoint = "base",
): StyleTokens {
  const node = nodeOf(document, path);
  return node ? resolveTokens(node, breakpoint) : {};
}

/** The style for one node of a section, by its relative path. */
export function nodeStyle(
  document: StyleDocument | undefined,
  path: string | undefined,
  breakpoint: Breakpoint = "base",
): CSSProperties | undefined {
  return tokensToStyle(nodeTokens(document, path, breakpoint));
}

/**
 * Tokens that describe the picture rather than the frame around it.
 *
 * A media field in this codebase is two elements: a box that carries the shape
 * — the radius, the border, the overflow clip — and an `<img>` inside it that
 * carries the crop. `object-position` on the box does nothing at all, because
 * the box is not a replaced element; it has to reach the image.
 *
 * That is a fact about how the markup is built, so it lives here beside the
 * mapping rather than in the panel. One field is still one stored path and one
 * selectable node — `field:image`, not `field:image/box` and
 * `field:image/img`. Splitting the *address* to solve a rendering detail would
 * put the DOM's shape into the database.
 */
const REPLACED: ReadonlySet<keyof StyleTokens> = new Set(["objectX", "objectY"]);

export type MediaStyle = { box?: CSSProperties; image?: CSSProperties };

/**
 * One media node's style, split between the frame and the picture.
 *
 * Both halves come from the same path and the same validated tokens; only the
 * element they land on differs.
 */
export function mediaNodeStyle(
  document: StyleDocument | undefined,
  path: string | undefined,
  breakpoint: Breakpoint = "base",
): MediaStyle {
  const tokens = nodeTokens(document, path, breakpoint);
  const box: StyleTokens = {};
  const image: StyleTokens = {};
  for (const [key, value] of Object.entries(tokens) as [keyof StyleTokens, unknown][]) {
    const target = REPLACED.has(key) ? image : box;
    (target as Record<string, unknown>)[key] = value;
  }
  return { box: tokensToStyle(box), image: tokensToStyle(image) };
}

/* -------------------------------------------------------------------------- */
/* Responsive                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * How a tablet or mobile override reaches a page.
 *
 * Base is an inline style, and an inline declaration beats every stylesheet
 * rule that is not `!important`. That single fact decides this architecture:
 * a responsive override has to be able to win against the base it overrides,
 * and the only two ways to do that are to stop writing base inline — changing
 * how every already-shipped Base style renders — or to let the responsive layer
 * be important. The second is smaller, and its blast radius is knowable.
 *
 * So the element carries three things, and the stylesheet does the rest:
 *
 *   1. its **base** style, inline, exactly as it was before this batch;
 *   2. one **custom property per overridden declaration**, per breakpoint —
 *      `--rs-t-font-size`, `--rs-m-color` — holding a value that came out of
 *      the same tables base does, so a token cannot mean one thing at one
 *      width and another at the next;
 *   3. a **list of which declarations it overrides**, per breakpoint, in
 *      `data-rs-t` / `data-rs-m`.
 *
 * `globals.css` then holds one fixed rule per declaration per breakpoint —
 * `@media (max-width: 1024px) { [data-rs-t~="font-size"] { font-size:
 * var(--rs-t-font-size) !important } }` — and nothing else. The media
 * conditions, the selectors and the property names are all written in source.
 * The document contributes a validated value and the name of a declaration it
 * is allowed to name, and nothing else: no selector, no property, no condition,
 * no variable name.
 *
 * **Inheritance is the cascade, not a resolver.** Base applies everywhere;
 * the tablet rules apply at 1024 and below; the mobile rules come *after* them
 * in the stylesheet and apply at 640 and below. So at 390px a tablet override
 * is still in force unless mobile overrides that same declaration — which is
 * exactly `base → tablet → mobile`, arrived at by the browser rather than by a
 * second implementation of `resolveTokens` running on the server.
 *
 * **An element with no responsive branch gets none of this.** No attribute, no
 * variable, no rule matches it, and its markup is byte-for-byte what Batch 6
 * produced.
 */

/** Which attribute names a breakpoint's overridden declarations. */
export const RESPONSIVE_ATTR: Record<ResponsiveBreakpoint, string> = {
  tablet: "data-rs-t",
  mobile: "data-rs-m",
};

/** The custom-property prefix a breakpoint's values are parked under. */
export const RESPONSIVE_PREFIX: Record<ResponsiveBreakpoint, string> = {
  tablet: "--rs-t-",
  mobile: "--rs-m-",
};

/**
 * Every declaration a validated token can produce, as CSS spells it.
 *
 * This is the list `globals.css` has a rule for, twice over. A test drives
 * every token through `tokensToStyle` and fails if anything it can emit is
 * missing here, and a second test fails if anything here is missing a rule —
 * so a token added later cannot render at desktop and quietly do nothing at
 * the other two widths.
 */
export const RESPONSIVE_PROPERTIES = [
  "text-align",
  "font-size",
  "line-height",
  "letter-spacing",
  "font-weight",
  "color",
  "background",
  "padding-block",
  "padding-inline",
  "margin-block",
  "margin-inline",
  "gap",
  "border-radius",
  "border",
  "box-shadow",
  "opacity",
  "max-width",
  "width",
  "height",
  "min-height",
  "flex-direction",
  "flex-wrap",
  "justify-content",
  "align-items",
  "grid-template-columns",
  "overflow",
  "object-position",
  "display",
] as const;

/**
 * `opacity`, renamed by `Reveal` before it reaches the markup.
 *
 * A revealed element's opacity is its *finished* state, so at every breakpoint
 * it has to travel as `--eod-node-opacity` rather than as the property itself —
 * the same rule Batch 6 established for base, applied to the other two
 * branches. The component renames the declaration in the list it publishes;
 * the stylesheet has a rule for each name, and only one of them can match.
 */
export const REVEAL_OPACITY_PROPERTY = "reveal-opacity";

/** React's camelCase property name, as CSS writes it. */
const kebab = (property: string): string =>
  property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

export type ResponsiveStyle = {
  /** Custom properties for the element, merged into its inline style. */
  vars: Record<string, string>;
  /** `{ "data-rs-t": "font-size color" }` — which rules are allowed to fire. */
  attrs: Record<string, string>;
};

/**
 * Tokens that share one CSS declaration, and therefore travel together.
 *
 * A responsive branch writes out only what it declares. That is right for a
 * token which owns its property outright, and wrong for one that does not: if
 * a branch sets half of a shared declaration, the renderer would compose the
 * new half with *nothing* and silently drop the inherited other half. So
 * naming either member of a pair pulls the whole pair into the branch, where
 * `resolveTokens` supplies the inherited value.
 *
 *   · `objectX` / `objectY` → `object-position`. Moving the vertical point
 *     alone must not recentre the horizontal one.
 *   · `shadow` / `glow` → `box-shadow`. Adding a glow at mobile must not
 *     delete the lift that base gave the card.
 *   · `layout` / `hidden` → `display`. Hiding has to keep beating laying out
 *     at every width, and a branch that sets only one of them still has to
 *     render both.
 */
const SHARED_DECLARATIONS: readonly (readonly (keyof StyleTokens)[])[] = [
  ["objectX", "objectY"],
  ["shadow", "glow"],
  ["layout", "hidden"],
];

/**
 * One branch's declarations: what this breakpoint changes, and nothing else.
 *
 * Driven by the keys the branch itself declares — an inherited value is not an
 * override and must not be written out, or a later edit to base would stop
 * reaching the breakpoints that had silently frozen a copy of it. Two kinds of
 * exception:
 *
 *   **Some declarations are owned by two tokens** — see `SHARED_DECLARATIONS`.
 *
 *   **A type step is one step, not three properties.** A branch that sets a
 *   size the ramp gives no tracking to has to clear the tracking it is
 *   overriding; without that, a display-sized heading's letter-spacing would
 *   survive onto body text at mobile.
 */
function branchDeclarations(
  node: StyleNode,
  breakpoint: ResponsiveBreakpoint,
): CSSProperties | undefined {
  const own = node[breakpoint];
  if (!own) return undefined;

  const keys = new Set(Object.keys(own) as (keyof StyleTokens)[]);
  for (const pair of SHARED_DECLARATIONS) {
    if (pair.some((key) => keys.has(key))) for (const key of pair) keys.add(key);
  }

  const resolved = resolveTokens(node, breakpoint);
  const tokens: Record<string, unknown> = {};
  for (const key of keys) {
    if (resolved[key] !== undefined) tokens[key] = resolved[key];
  }

  const css = tokensToStyle(tokens as StyleTokens);
  if (!css) return undefined;
  if (tokens.fontSize !== undefined && css.letterSpacing === undefined) {
    css.letterSpacing = "normal";
  }
  return css;
}

/** One node's tablet and mobile overrides, ready to put on an element. */
export function responsiveStyle(
  document: StyleDocument | undefined,
  path: string | undefined,
): ResponsiveStyle | undefined {
  const node = nodeOf(document, path);
  if (!node) return undefined;

  const vars: Record<string, string> = {};
  const attrs: Record<string, string> = {};

  for (const breakpoint of RESPONSIVE_BREAKPOINTS) {
    const css = branchDeclarations(node, breakpoint);
    if (!css) continue;
    const names: string[] = [];
    for (const [property, value] of Object.entries(css)) {
      if (value === undefined || value === null || value === "") continue;
      const name = kebab(property);
      names.push(name);
      vars[`${RESPONSIVE_PREFIX[breakpoint]}${name}`] = String(value);
    }
    if (names.length) attrs[RESPONSIVE_ATTR[breakpoint]] = names.join(" ");
  }

  return Object.keys(attrs).length ? { vars, attrs } : undefined;
}

/**
 * The same, split between a picture and the frame around it.
 *
 * Identical reasoning to `mediaNodeStyle`, one breakpoint further: the crop is
 * the `<img>`'s and the shape is the frame's, at every width.
 */
export type ResponsiveMediaStyle = { box?: ResponsiveStyle; image?: ResponsiveStyle };

const IMAGE_PROPERTIES: ReadonlySet<string> = new Set(["object-position"]);

export function responsiveMediaStyle(
  document: StyleDocument | undefined,
  path: string | undefined,
): ResponsiveMediaStyle {
  const all = responsiveStyle(document, path);
  if (!all) return {};

  const halves: Record<"box" | "image", ResponsiveStyle> = {
    box: { vars: {}, attrs: {} },
    image: { vars: {}, attrs: {} },
  };

  for (const breakpoint of RESPONSIVE_BREAKPOINTS) {
    const attribute = RESPONSIVE_ATTR[breakpoint];
    const listed = all.attrs[attribute];
    if (!listed) continue;
    const prefix = RESPONSIVE_PREFIX[breakpoint];
    for (const name of listed.split(" ")) {
      const half = IMAGE_PROPERTIES.has(name) ? halves.image : halves.box;
      half.attrs[attribute] = half.attrs[attribute] ? `${half.attrs[attribute]} ${name}` : name;
      const variable = `${prefix}${name}`;
      if (all.vars[variable] !== undefined) half.vars[variable] = all.vars[variable];
    }
  }

  return {
    box: Object.keys(halves.box.attrs).length ? halves.box : undefined,
    image: Object.keys(halves.image.attrs).length ? halves.image : undefined,
  };
}
