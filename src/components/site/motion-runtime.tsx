"use client";

import { useEffect } from "react";

import { revealObserverStats, whenReached } from "./motion-observer";

/**
 * Starts the entrances of the nodes a server component rendered.
 *
 * An editor can now give a heading, a picture or a list an entrance of its own,
 * and those elements are rendered by server components — they cannot run a
 * hook, and wrapping each one in a client component would add an element
 * around it and move the address the Visual Editor selects, stores styles under
 * and measures its outline from. So the markup carries `data-m-reveal` (or
 * `data-m-group` for a staggering list) and this, rendered once per page,
 * registers every such element with the page's one observer and flips
 * `data-shown` when it is reached.
 *
 * It only touches elements with no `data-shown` at all. An element that already
 * has one is owned by a React lifecycle — a `Reveal` row, a section wrapper —
 * and a second owner writing the same attribute would be two authorities for
 * one entrance.
 *
 * `signature` is the page's motion, in a form cheap to compare: when a refresh
 * renders different nodes, the effect runs again and picks them up.
 */
export function MotionRuntime({ signature }: { signature: string }) {
  useEffect(() => {
    const stops: (() => void)[] = [];
    const nodes = document.querySelectorAll<HTMLElement>(
      "[data-m-reveal]:not([data-shown]), [data-m-group]:not([data-shown])",
    );
    nodes.forEach((node) => {
      stops.push(whenReached(node, () => node.setAttribute("data-shown", "true")));
    });
    // Read by the performance probe; nothing in the page depends on it.
    (window as unknown as { __eodMotion?: () => ReturnType<typeof revealObserverStats> }).__eodMotion =
      revealObserverStats;
    return () => stops.forEach((stop) => stop());
  }, [signature]);

  return null;
}
