"use client";

import { useEffect } from "react";

import { revealObserverStats, whenReached } from "./motion-observer";

/**
 * Starts the motion of the nodes a server component rendered.
 *
 * An editor can give a heading, a picture or a list an entrance of its own,
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
 * Batch 15b adds the page's drifting elements (`data-m-px`), handed to the one
 * parallax coordinator. That module is loaded only when the page has one, so a
 * page without parallax downloads, attaches and runs nothing for it.
 *
 * `parallax` is decided by the server and passed down, never worked out here:
 * the Visual Editor's canvas renders with it `"paused"`, because a canvas whose
 * elements slide under the pointer as it scrolls is one in which nothing stays
 * where the selection outline says it is. The editor shows parallax through
 * Replay instead. Ordinary Preview and the public page are `"live"`.
 *
 * `signature` is the page's motion, in a form cheap to compare: when a refresh
 * renders different nodes, the effect runs again and picks them up.
 */
export function MotionRuntime({
  signature,
  parallax = "live",
}: {
  signature: string;
  parallax?: "live" | "paused";
}) {
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

    let cancelled = false;
    if (parallax === "live") {
      const drifting = document.querySelectorAll<HTMLElement>("[data-m-px]");
      if (drifting.length) {
        void import("./motion-parallax").then(({ registerParallax, parallaxStats }) => {
          if (cancelled) return;
          drifting.forEach((element) => stops.push(registerParallax(element)));
          // Read by the performance probe; nothing in the page depends on it.
          (window as unknown as { __eodParallax?: typeof parallaxStats }).__eodParallax = parallaxStats;
        });
      }
    }

    return () => {
      cancelled = true;
      stops.forEach((stop) => stop());
    };
  }, [signature, parallax]);

  return null;
}
