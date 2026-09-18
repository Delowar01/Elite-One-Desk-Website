"use client";

import { useEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from "react";

import type { NodeAttrs, ResponsiveAttrs } from "@/lib/cms/node";
import { REVEAL_OPACITY_PROPERTY, RESPONSIVE_ATTR } from "@/lib/cms/style-css";

type Props = {
  children: ReactNode;
  as?: ElementType;
  /** Milliseconds after the element enters the viewport. */
  delay?: number;
  variant?: "fade-up" | "fade" | "slide-in" | "scale-in" | "none";
  className?: string;
  /** Staggers direct children instead of moving the wrapper itself. */
  stagger?: number;
  /**
   * What one stable node contributes to the element this renders: its `data-*`
   * marks in editor mode, and its style overrides always.
   *
   * The Visual Editor marks a repeatable row by wrapping it, and a great many
   * rows on this site are wrapped by a `Reveal` already. Adding a second
   * element around each one purely to hold the attributes would change the
   * layout of eleven blocks; passing them through does not — and it keeps the
   * row's style on the same element the editor selects.
   *
   * The style is merged rather than spread, because this component sets a
   * custom property of its own on the same element and a spread would drop it.
   * Plain data either way: this is a client component and the prop crosses the
   * serialisation boundary.
   */
  nodeAttrs?: NodeAttrs;
};

const VARIANT_CLASS: Record<string, string> = {
  "fade-up": "reveal",
  fade: "reveal",
  "slide-in": "reveal reveal-left",
  "scale-in": "reveal reveal-scale",
  none: "",
};

/**
 * The custom property the stylesheet reads a revealed element's finished
 * opacity from. Written here and in `globals.css`, and nowhere else: it is a
 * name in source, never a value from the database.
 */
export const FINAL_OPACITY = "--eod-node-opacity";

/**
 * The node's own attributes, with any responsive opacity renamed.
 *
 * The same rule as the base opacity below, at the other two widths. A tablet
 * or mobile `opacity` is still a *finished* state, so the stylesheet has to put
 * it in `--eod-node-opacity` rather than in `opacity` — and the way it knows
 * which of the two rules to apply is the name in the list this element
 * publishes. Base is rewritten in the style object; the breakpoints are
 * rewritten here, in the attribute. One decision, made by the component that
 * knows it is a reveal, in the two places it has to land.
 *
 * With `variant="none"` there is no reveal class and nothing is renamed: the
 * element takes the ordinary `opacity` rule, at every width.
 */
const renameOpacity = (list: string | undefined): string | undefined =>
  list === undefined
    ? undefined
    : list
        .split(" ")
        .map((name) => (name === "opacity" ? REVEAL_OPACITY_PROPERTY : name))
        .join(" ");

export function revealMarks<T extends ResponsiveAttrs>(revealClass: string, marks: T): T {
  if (!revealClass) return marks;
  const next = { ...marks };
  let changed = false;
  for (const attribute of Object.values(RESPONSIVE_ATTR) as (keyof ResponsiveAttrs)[]) {
    const renamed = renameOpacity(marks[attribute]);
    if (renamed === marks[attribute]) continue;
    next[attribute] = renamed;
    changed = true;
  }
  return changed ? next : marks;
}

/**
 * One element's style: the reveal's own properties, then a node's overrides.
 *
 * Separated from the markup because what it decides is a rule rather than a
 * tag — and a rule with a failure mode nobody would see in a screenshot, since
 * getting it wrong leaves the page looking right until somebody scrolls.
 *
 * Opacity is the one token that cannot be applied inline here. An inline
 * `opacity` outranks a class, so `opacity: 0.5` on a `.reveal` would show the
 * element at half strength *before* it was revealed and leave the fade nothing
 * to travel: the lifecycle would be visibly broken by a style that was only
 * ever meant to describe the finished state. The stylesheet reads the finished
 * value from `FINAL_OPACITY` instead, so the hidden state stays 0 and the
 * revealed state lands on the editor's number rather than on 1 — in the
 * reduced-motion and print rules as well, where there is no animation but the
 * chosen value still has to hold.
 *
 * With `variant="none"` there is no reveal class and therefore no lifecycle to
 * protect, so the value is simply the element's opacity.
 *
 * Everything else the node carries is merged over the reveal's own properties,
 * which is what an override is — and `--reveal-delay` survives it, because a
 * delay is not one of the things a style token can name.
 */
export function revealStyle({
  delay,
  stagger,
  revealClass,
  node,
}: {
  delay: number;
  stagger?: number;
  revealClass: string;
  node?: CSSProperties;
}): CSSProperties {
  const { opacity, ...rest } = node ?? {};
  const style: CSSProperties & Record<string, string | number> = {
    ["--reveal-delay"]: `${delay}ms`,
  };
  if (stagger) style["--reveal-stagger"] = `${stagger}ms`;
  Object.assign(style, rest);
  if (opacity !== undefined) {
    if (revealClass) style[FINAL_OPACITY] = String(opacity);
    else style.opacity = opacity;
  }
  return style;
}

/**
 * Scroll reveal built on IntersectionObserver and two CSS classes rather than a
 * motion library: a few hundred bytes, running off the compositor, firing once.
 *
 * The hidden state lives inside `@media (scripting: enabled)` in globals.css,
 * so the element is simply visible wherever script cannot run — no JavaScript,
 * a print, a reader mode. Nothing here can leave content stranded at opacity 0.
 */
export function Reveal({
  children,
  as: Tag = "div",
  delay = 0,
  variant = "fade-up",
  className = "",
  stagger,
  nodeAttrs,
}: Props) {
  const ref = useRef<HTMLElement>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const node = ref.current;
    if (!node || variant === "none") return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShown(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true);
            observer.disconnect();
          }
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [variant]);

  const revealClass = VARIANT_CLASS[variant] ?? "reveal";
  const classes = [revealClass, className].filter(Boolean).join(" ");
  const { style: nodeStyle, ...rest } = nodeAttrs ?? {};
  const style = revealStyle({ delay, stagger, revealClass, node: nodeStyle });
  const marks = revealMarks(revealClass, rest);

  return (
    <Tag
      ref={ref as never}
      className={classes}
      data-shown={shown ? "true" : "false"}
      style={style}
      {...marks}
    >
      {children}
    </Tag>
  );
}

/**
 * Convenience wrapper for lists: each child gets its own observer-free delay,
 * so a grid animates in sequence from one parent observer.
 */
export function RevealGroup({
  children,
  step = 70,
  variant = "fade-up",
  className = "",
}: {
  children: ReactNode[];
  step?: number;
  variant?: Props["variant"];
  className?: string;
}) {
  return (
    <>
      {children.map((child, index) => (
        <Reveal key={index} delay={index * step} variant={variant} className={className}>
          {child}
        </Reveal>
      ))}
    </>
  );
}
