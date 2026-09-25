import type { CSSProperties } from "react";

import {
  DEFAULT_DIRECTION,
  MOTION_INHERITS_FROM,
  resolveBranch,
  type Entrance,
  type MotionBranch,
  type MotionDirection,
  type MotionDocument,
  type MotionTarget,
  type Stagger,
} from "./motion-doc";
import { RESPONSIVE_BREAKPOINTS, type Breakpoint, type ResponsiveBreakpoint } from "./styles";

/**
 * The one place a stored motion value becomes CSS.
 *
 * Same shape as `style-css.ts`, for the same reason: every number, unit, curve
 * and keyword below is written here, in source. The document contributes a
 * **key** into these tables, and a key with no entry produces nothing.
 *
 * ## Why entrances are variables rather than classes
 *
 * Batch 9 gave each preset a class — `.reveal-left`, `.reveal-scale` — and those
 * classes stay exactly as they are for every section that has no advanced
 * document. They do not extend to responsive motion: one HTML document serves
 * every width, and a media query cannot swap a class. So an advanced entrance
 * is expressed as **values for a fixed set of custom properties**, and the
 * stylesheet states the hidden state once, generically, in terms of them:
 *
 *     [data-m-reveal]:not([data-shown="true"]) {
 *       opacity: calc(var(--m-hold) * var(--eod-node-opacity, 1));
 *       translate: calc(var(--m-x) * var(--m-sign)) var(--m-y);
 *       scale: var(--m-scale);
 *       filter: blur(var(--m-blur));
 *     }
 *
 * and the entrance once, as keyframes that run from those values to the
 * element's finished state (`eod-m-enter`, plus `eod-m-mask` for a wipe, whose
 * clip exists only while it runs).
 *
 * A tablet override is then one fixed rule per *variable* — the same promote
 * trick the responsive style layer uses — rather than one rule per entrance per
 * breakpoint.
 *
 * ## Transform ownership
 *
 * An advanced entrance never writes `transform`. It moves an element with the
 * **individual** `translate` and `scale` properties, which cascade separately
 * from `transform` and compose with it instead of replacing it. That is what
 * keeps it clear of everything on this site that already owns `transform` on
 * an annotated element — `.btn:hover`'s lift, the legacy `.reveal` rise, the
 * bespoke keyframes — so an editor's entrance on a call-to-action cannot erase
 * that button's hover, and the button's hover cannot erase the entrance.
 */

/* -------------------------------------------------------------------------- */
/* The tables                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * "Do not clip on this edge": the edge sits a whole viewport outside the box,
 * so nothing is cut — including a Batch 14 shadow or glow.
 *
 * Viewport-relative rather than box-relative on purpose. `-100%` of a small
 * element is a small distance, and a glow larger than the element would be
 * cropped by it. It is also never an *animated* edge: a mask only ever moves
 * the one edge it opens from, from `100%` to `0%`, so the size of this value
 * cannot change how fast a wipe appears to travel.
 */
const NO_CLIP = "-100vmax";

type Geometry = {
  /**
   * Hidden opacity **as a fraction of the finished opacity**: `0` for an
   * entrance that fades, `1` for one that does not. A multiplier rather than a
   * value because the finished opacity is the element's own Style opacity
   * (`--eod-node-opacity`) and has to be resolved on the element that moves —
   * a `var()` placed inside another custom property resolves on the element
   * that *declares* it, which for a staggered list would be the list rather
   * than the row.
   */
  op: string;
  /**
   * Opacity while the element is waiting to be reached, as the same fraction.
   * Equal to `op` for everything except a mask, which waits invisible and
   * enters opaque: its wipe does the hiding once it starts, and while it is
   * waiting it must not be clipped — Chromium's IntersectionObserver counts
   * an element's own `clip-path`, so an element clipped away entirely is never
   * "reached", and would wait for ever.
   */
  hold: string;
  /** The keyframes that wipe a mask open, or `none` — a name from this file. */
  anim: string;
  /** Logical inline offset: negative is "from the start edge". */
  x: string;
  y: string;
  scale: string;
  blur: string;
  clipT: string;
  clipE: string;
  clipB: string;
  clipS: string;
};

const REST: Geometry = {
  op: "0",
  hold: "0",
  anim: "none",
  x: "0px",
  y: "0px",
  scale: "1",
  blur: "0px",
  clipT: NO_CLIP,
  clipE: NO_CLIP,
  clipB: NO_CLIP,
  clipS: NO_CLIP,
};

/**
 * The hidden state an entrance starts from, for one direction.
 *
 * The four legacy geometries are reproduced exactly — 18px rise, 24px slide,
 * 0.965 scale — so an advanced `slide-in` looks the way the legacy preset
 * always has, and the one thing that changed is which property moves it.
 *
 * A mask covers the box from the side *opposite* its starting edge, so the
 * starting edge is uncovered first: `start` hides everything from the end
 * edge inward and the wipe travels towards the end. The inline pair is swapped
 * under `[dir="rtl"]` in the stylesheet, which is what makes `start` the left
 * in English and the right in Arabic.
 */
function geometry(entrance: Entrance, direction: MotionDirection): Geometry {
  switch (entrance) {
    case "none":
      // Hidden and shown are the same state, so a lifecycle attached for a
      // narrower width's sake does nothing at this one.
      return { ...REST, op: "1", hold: "1" };
    case "fade-up":
      return { ...REST, y: "18px" };
    case "fade":
      return REST;
    case "scale-in":
      return { ...REST, scale: "0.965" };
    case "blur":
      // Restrained on purpose. A heavy blur on text reads as a rendering fault
      // rather than as an entrance, and it is expensive to composite.
      return { ...REST, blur: "8px", y: "8px" };
    case "slide-in":
      switch (direction) {
        case "start":
          return { ...REST, x: "-24px" };
        case "end":
          return { ...REST, x: "24px" };
        case "up":
          return { ...REST, y: "24px" };
        case "down":
          return { ...REST, y: "-24px" };
      }
      break;
    case "mask": {
      // A wipe is opaque: the clip is what hides it, so there is no fade on
      // top of it to muddy the edge.
      const wipe = { ...REST, op: "1", hold: "0", anim: "eod-m-mask" };
      switch (direction) {
        // Start: covered from the end edge inward, so the start edge shows first
        // and the wipe travels towards the end.
        case "start":
          return { ...wipe, clipE: "100%" };
        case "end":
          return { ...wipe, clipS: "100%" };
        // The visible strip is anchored at the edge the wipe begins at, so an
        // upward wipe starts with the *top* covered and uncovers the bottom first.
        case "up":
          return { ...wipe, clipT: "100%" };
        case "down":
          return { ...wipe, clipB: "100%" };
      }
      break;
    }
  }
  // Unreachable for a validated branch; a safe resting state if it ever is not.
  return REST;
}

/** Durations are the design system's own, plus Cinematic, defined in `globals.css`. */
const DURATION: Record<NonNullable<MotionBranch["duration"]>, string> = {
  fast: "var(--duration-fast)",
  standard: "var(--duration-base)",
  slow: "var(--duration-slow)",
  cinematic: "var(--duration-cinematic)",
};

const EASING: Record<NonNullable<MotionBranch["easing"]>, string> = {
  "soft-out": "var(--ease-out-soft)",
  "expo-out": "var(--ease-out-expo)",
  "soft-in-out": "var(--ease-in-out-soft)",
};

/** Per-child step. Named, so it cannot be an arbitrary number. */
const STAGGER: Record<Stagger, string> = {
  none: "0ms",
  tight: "45ms",
  normal: "80ms",
  relaxed: "130ms",
};

/**
 * The last child that gets a step of its own; everything after it arrives with
 * it. Stated here because it is part of the timing contract, and read back by
 * the stylesheet test so the `:nth-child` rules and this number cannot drift.
 *
 * Eight steps of the slowest stagger is 1040ms, so the last child of any list
 * begins at most `delay + 1040ms` after the list is reached — with the 1500ms
 * delay ceiling that is 2540ms, and nothing waits longer than that.
 */
export const STAGGER_CAP = 8;

/* -------------------------------------------------------------------------- */
/* Names                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Every variable a motion branch can set, as the stylesheet names it.
 *
 * A test drives every field through `branchVars` and fails if anything it can
 * emit is missing here, and a second test fails if anything here has no promote
 * rule at both breakpoints — so a value added later cannot animate at desktop
 * and quietly do nothing at the other two widths.
 */
export const MOTION_VARIABLES = [
  "op",
  "hold",
  "anim",
  "x",
  "y",
  "scale",
  "blur",
  "clip-t",
  "clip-e",
  "clip-b",
  "clip-s",
  "dur",
  "ease",
  "delay",
  "stagger",
] as const;
export type MotionVariable = (typeof MOTION_VARIABLES)[number];

/** Base values live under this prefix; the two branches under theirs. */
export const MOTION_PREFIX = "--m-";
export const MOTION_BRANCH_PREFIX: Record<ResponsiveBreakpoint, string> = {
  tablet: "--m-t-",
  mobile: "--m-m-",
};
/** Which attribute names a breakpoint's overridden motion variables. */
export const MOTION_ATTR: Record<ResponsiveBreakpoint, "data-m-t" | "data-m-m"> = {
  tablet: "data-m-t",
  mobile: "data-m-m",
};

/* -------------------------------------------------------------------------- */
/* Branch → variables                                                        */
/* -------------------------------------------------------------------------- */

/**
 * One resolved branch as the variables it sets, and nothing else.
 *
 * Sparse in, sparse out: a branch that chose only a duration sets only
 * `--m-dur`.
 *
 * `entrance` and `direction` expand **together and totally** into all eleven
 * geometric variables: a tablet that switches from Slide to Fade must not keep
 * Base's inline offset, and a tablet that only turns a mask from Start to Up
 * must redraw the mask it inherited rather than half of one. That is why the
 * geometry comes from one table lookup with every variable present, never
 * from a spread.
 */
export function branchVars(branch: MotionBranch): Partial<Record<MotionVariable, string>> {
  const out: Partial<Record<MotionVariable, string>> = {};

  if (branch.entrance !== undefined) {
    const g = geometry(branch.entrance, branch.direction ?? DEFAULT_DIRECTION);
    out.op = g.op;
    out.hold = g.hold;
    out.anim = g.anim;
    out.x = g.x;
    out.y = g.y;
    out.scale = g.scale;
    out.blur = g.blur;
    out["clip-t"] = g.clipT;
    out["clip-e"] = g.clipE;
    out["clip-b"] = g.clipB;
    out["clip-s"] = g.clipS;
  }

  if (branch.duration !== undefined) out.dur = DURATION[branch.duration];
  if (branch.easing !== undefined) out.ease = EASING[branch.easing];
  if (branch.delay !== undefined) out.delay = `${branch.delay}ms`;
  if (branch.stagger !== undefined) out.stagger = STAGGER[branch.stagger];

  return out;
}

export type MotionAttrs = { "data-m-t"?: string; "data-m-m"?: string };

export type MotionStyle = {
  /** Custom properties for the element, merged into its inline style. */
  vars: Record<string, string>;
  /** `{ "data-m-t": "dur op x …" }` — which promote rules may fire. */
  attrs: MotionAttrs;
};

/**
 * One target's motion, ready to put on an element: Base as variables, each
 * responsive branch as prefixed variables plus the list of names it overrides.
 *
 * **Driven by what each branch itself declares.** An inherited value is not an
 * override and must not be written out, or a later edit to Base would stop
 * reaching the breakpoints that had frozen a copy of it. The one pairing is
 * entrance with direction: a branch that names either is expanded with the
 * other resolved through inheritance, so the geometry it writes is whole.
 */
export function motionStyle(target: MotionTarget | undefined): MotionStyle | null {
  if (!target || !Object.keys(target).length) return null;

  const vars: Record<string, string> = {};
  const attrs: MotionAttrs = {};

  const base = resolveBranch(target, "base");
  for (const [name, value] of Object.entries(branchVars(base))) {
    vars[`${MOTION_PREFIX}${name}`] = value;
  }

  for (const breakpoint of RESPONSIVE_BREAKPOINTS) {
    const own = target[breakpoint];
    if (!own || !Object.keys(own).length) continue;
    const resolved = resolveBranch(target, breakpoint);
    const scoped: MotionBranch = {};
    for (const key of Object.keys(own) as (keyof MotionBranch)[]) {
      (scoped as Record<string, unknown>)[key] = resolved[key];
    }
    if (scoped.entrance !== undefined || scoped.direction !== undefined) {
      scoped.entrance = resolved.entrance;
      scoped.direction = resolved.direction;
    }
    const produced = branchVars(scoped);
    const names = Object.keys(produced);
    if (!names.length) continue;
    for (const [name, value] of Object.entries(produced)) {
      vars[`${MOTION_BRANCH_PREFIX[breakpoint]}${name}`] = value;
    }
    attrs[MOTION_ATTR[breakpoint]] = names.join(" ");
  }

  return Object.keys(vars).length || Object.keys(attrs).length ? { vars, attrs } : null;
}

/**
 * Whether a target moves at any width — the question that decides whether an
 * element gets a lifecycle at all.
 *
 * An element whose entrance is `none` everywhere gets no observer, no attribute
 * and no variable, exactly as a legacy `none` section gets a plain `<div>`.
 */
export function animatesAnywhere(target: MotionTarget | undefined): boolean {
  if (!target) return false;
  return (["base", "tablet", "mobile"] as const).some((breakpoint) => {
    const entrance = resolveBranch(target, breakpoint).entrance;
    return entrance !== undefined && entrance !== "none";
  });
}

/** Whether a target names a stagger at any width — `none` included. */
export const staggersAnywhere = (target: MotionTarget | undefined): boolean =>
  !!target && (["base", "tablet", "mobile"] as const).some((b) => target[b]?.stagger !== undefined);

/**
 * Whether a list sends its rows in turn: it names a stagger and it has an
 * entrance somewhere to send them with.
 *
 * The one definition of a stagger group, read by the renderer (which makes the
 * rows members) and by the panel (which says a row belongs to its list), so
 * the two cannot disagree about who owns a row. A stagger of `none` still makes
 * a group — the rows arrive together, and the list still owns them — which is
 * what lets a narrower width switch the cascade off without handing every row
 * its own entrance back.
 */
export const isStaggerGroup = (target: MotionTarget | undefined): boolean =>
  staggersAnywhere(target) && animatesAnywhere(target);

/** The style object form, for merging onto an element. */
export const motionVarStyle = (motion: MotionStyle | null): CSSProperties | undefined =>
  motion && Object.keys(motion.vars).length ? (motion.vars as CSSProperties) : undefined;

/* -------------------------------------------------------------------------- */
/* Reading a document                                                        */
/* -------------------------------------------------------------------------- */

/** One node's motion target, by its section-relative path. */
export const motionTargetOf = (
  document: MotionDocument | null | undefined,
  path: string | undefined,
): MotionTarget | undefined =>
  !document ? undefined : path === undefined || path === "root" ? document.section : document.nodes[path];

/**
 * What one control should say about itself — the motion twin of `tokenState`.
 *
 * `value` is what this breakpoint stores, `inherited` what the element would do
 * without it, and `from` which branch supplies that, or `null` for "whatever
 * the engine does by default".
 */
export type MotionFieldState = {
  value: MotionBranch[keyof MotionBranch] | undefined;
  inherited: MotionBranch[keyof MotionBranch] | undefined;
  from: Breakpoint | null;
};

export function motionFieldState(
  target: MotionTarget | undefined,
  breakpoint: Breakpoint,
  field: keyof MotionBranch,
): MotionFieldState {
  const value = target?.[breakpoint]?.[field];
  let inherited: MotionBranch[keyof MotionBranch] | undefined;
  let from: Breakpoint | null = null;
  for (const parent of MOTION_INHERITS_FROM[breakpoint]) {
    const candidate = target?.[parent]?.[field];
    if (candidate !== undefined) {
      inherited = candidate;
      from = parent;
    }
  }
  return { value, inherited, from };
}
