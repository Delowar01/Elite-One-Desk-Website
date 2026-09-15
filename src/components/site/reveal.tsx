"use client";

import { useEffect, useRef, useState, type CSSProperties, type ElementType, type ReactNode } from "react";

import type { NodeAttrs } from "@/lib/cms/node";

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

  const classes = [VARIANT_CLASS[variant] ?? "reveal", className].filter(Boolean).join(" ");
  const { style: nodeStyle, ...marks } = nodeAttrs ?? {};
  const style: CSSProperties & Record<string, string | number> = {
    ["--reveal-delay"]: `${delay}ms`,
  };
  if (stagger) style[["--reveal-stagger"] as unknown as string] = `${stagger}ms`;
  // The override wins over the reveal's own properties, which is what an
  // override is — and the reveal delay survives because it is not one of them.
  Object.assign(style, nodeStyle);

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
