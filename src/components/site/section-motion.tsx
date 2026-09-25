"use client";

import type { ReactNode } from "react";

import type { MotionPreset } from "@/lib/cms/motion";
import type { NodeAttrs } from "@/lib/cms/node";

import { revealClassOf, revealMarks, revealStyle, useRevealed } from "./reveal";

/**
 * Everything a section's wrapper carries, whoever renders it.
 *
 * Identity for the stylesheet (`data-section`), the preview's draft mark, the
 * node's own address and style overrides, and — in editor mode only — what
 * Layers needs to describe the section without asking the database a second
 * time. Passed as one object rather than spread through props so that the
 * plain wrapper and the moving one are provably carrying the same thing.
 */
export type SectionWrapperAttrs = NodeAttrs & {
  "data-section": string;
  "data-draft"?: true;
  "data-eod-draft"?: string;
  "data-eod-draft-only"?: string;
  "data-eod-visible"?: string;
};

/**
 * A section's entrance, on the section's own wrapper.
 *
 * The important word is *own*. This does not wrap the section in anything: it
 * renders the same single `<div>` `SectionRenderer` would have rendered, with
 * the same attributes, plus the reveal class and the `data-shown` flag the
 * stylesheet watches. Adding an element around the wrapper instead would have
 * been far simpler and would have broken three things at once — the `root`
 * address the Visual Editor selects and stores styles under, the rectangle the
 * bridge measures for the selection outline, and any root override whose box
 * the new parent would now be deciding.
 *
 * Four consequences follow from reusing the reveal primitive rather than
 * writing a second one, and each is a rule the stylesheet already enforces:
 *
 *   · **Reduced motion** — `.reveal` is forced to its finished state by the
 *     `prefers-reduced-motion` block, and the hook skips the observer and
 *     shows the section immediately.
 *   · **Print** — the same forcing, so a section nobody scrolled past is still
 *     on the paper.
 *   · **No script** — the hidden state lives inside `@media (scripting:
 *     enabled)`, so a page without JavaScript is simply the finished page.
 *   · **A root opacity override** is a *finished* state, so it travels as
 *     `--eod-node-opacity` rather than as `opacity`, at every width. That is
 *     what `revealStyle` and `revealMarks` do, and it is why they are shared
 *     with `Reveal` rather than reimplemented: an inline `opacity` on a
 *     `.reveal` would show the section at half strength before it revealed and
 *     leave the fade nothing to travel.
 *
 * Nested motion is untouched. The blocks inside still run their own `Reveal`s
 * with their own observers; this only adds one more around the outside, and
 * opacity and transform compose.
 */
export function SectionMotion({
  motion,
  attrs,
  children,
}: {
  motion: MotionPreset;
  attrs: SectionWrapperAttrs;
  children: ReactNode;
}) {
  /**
   * An advanced entrance (Batch 15) arrives already rendered: the renderer has
   * put the motion variables and the finished opacity into `attrs`, and marked
   * the wrapper `data-m-reveal`. All this component adds is the lifecycle — the
   * same one, from the same shared observer — and it adds no legacy class,
   * because the legacy rise is on `transform` and the advanced entrance must be
   * the only thing moving this element.
   */
  const advanced = attrs["data-m-reveal"] !== undefined;
  const { ref, shown } = useRevealed(advanced || motion !== "none");
  const revealClass = advanced ? "" : revealClassOf(motion);
  const { style: nodeStyle, ...rest } = attrs;

  // Defensive rather than expected: the renderer does not send "none" here,
  // because a section with no entrance has no reason to become a client
  // component. If it ever did, this is the markup it must produce — the plain
  // wrapper, unchanged.
  if (!revealClass && !advanced) {
    return (
      <div {...attrs}>
        {children}
      </div>
    );
  }

  return (
    <div
      ref={ref as React.RefObject<HTMLDivElement>}
      className={revealClass || undefined}
      data-shown={shown ? "true" : "false"}
      style={advanced ? nodeStyle : revealStyle({ delay: 0, revealClass, node: nodeStyle })}
      {...(advanced ? rest : revealMarks(revealClass, rest))}
    >
      {children}
    </div>
  );
}
