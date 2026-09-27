"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * The "still" presentation of a page (Batch 16): everything shown in its
 * finished, resting state, for Version Compare.
 *
 * Two page states side by side are compared by looking, and anything moving
 * gets in the way of that — a heading still waiting for its entrance on one
 * side, a count-up at zero on the other, a word rotating in the hero. The
 * renderer already draws editor motion finished in this mode (it applies none)
 * and the stylesheet holds every reveal in its end state; this context is for
 * the handful of decorative components that animate from script, so they can
 * show their resting state the way they already do for a visitor who prefers
 * reduced motion.
 *
 * It is decided by the server — `SectionRenderer` renders this provider only
 * for an authorised comparison — and it is `false` everywhere else, so no
 * public page changes. It adds no element to the page.
 */
const StillContext = createContext(false);

export function StillPresentation({ children }: { children: ReactNode }) {
  return <StillContext.Provider value={true}>{children}</StillContext.Provider>;
}

/** Whether this subtree is a still presentation. False on every public page. */
export const useStill = (): boolean => useContext(StillContext);
