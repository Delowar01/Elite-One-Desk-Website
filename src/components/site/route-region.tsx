import type { ElementType, ReactNode } from "react";

import { animatesAnywhere, motionStyle, parallaxAnywhere } from "@/lib/cms/motion-css";
import { effectiveSectionTarget, type MotionDocument, type MotionTarget } from "@/lib/cms/motion-doc";
import { blockNode, mediaNode, withMotion, type NodeAttrs } from "@/lib/cms/node";
import type { StyleDocument } from "@/lib/cms/styles";
import { ROUTE_BLOCK_OF } from "@/lib/routes/blocks";
import type { CategoryRender } from "@/lib/routes/category-view";
import { editorKeyOf, ownerKeyOf, type RouteOwner } from "@/lib/routes/owners";
import { motionForBlock } from "@/lib/visual-editor/motion-targets";
import type { EditorRender } from "@/lib/visual-editor/render";

/**
 * One region of a dynamic route, ready to draw (Batch 21).
 *
 * The dynamic-route twin of what `SectionRenderer` does for a page section:
 * the region's identity for the editor, its styles and its motion, from one
 * stable owner, so the element an editor selects and the element a style lands
 * on are the same one. The rules are the section renderer's rules:
 *
 *   · **Editor attributes only in an authorised editor canvas.** `editor` is
 *     null on every other request and then no `data-eod-*` is written at all.
 *   · **Styles and motion always.** Published presentation is part of the
 *     page a visitor gets.
 *   · **Still means still.** Version Compare draws no motion at all.
 */
export type Region = {
  key: string;
  editor: EditorRender;
  styles: StyleDocument;
  motion: MotionDocument | null;
  copy: Record<string, string>;
  node: ReturnType<typeof blockNode>;
  media: ReturnType<typeof mediaNode>;
  /** The root element's attributes: identity in the editor, root styles always, its entrance when it has one. */
  root: NodeAttrs;
  /** The root has an entrance of its own, so it renders through `Reveal`'s lifecycle. */
  enters: boolean;
};

export function regionOf(view: CategoryRender, owner: RouteOwner): Region {
  const key = ownerKeyOf(owner);
  const blockType = ROUTE_BLOCK_OF[owner.type];
  const shown = view.presentation(key);
  const motion = view.still || !shown.motion ? null : motionForBlock(shown.motion, blockType);
  const editor: EditorRender = view.editor ? { sectionId: editorKeyOf(owner), blockType } : null;
  const source = { editor, styles: shown.styles, motion };
  const node = blockNode(source);

  let root: NodeAttrs = {
    ...node(undefined, "section"),
    // Layers is built from what rendered, so the facts it needs ride on the
    // element — in the canvas only.
    ...(view.editor
      ? {
          "data-eod-draft": String(view.drafted.has(key)),
          "data-eod-draft-only": "false",
          "data-eod-visible": String(!view.hidden.has(key)),
          ...(view.hidden.has(key) ? { "data-eod-hidden": "" } : {}),
        }
      : {}),
    // Version Compare's still presentation holds the template's own reveals
    // at rest inside the mark, exactly as it does for a page section.
    ...(view.still ? { "data-eod-still": "" } : {}),
  } as NodeAttrs;

  // The region's own entrance. A region has no legacy preset — its template's
  // reveals are the template's — so only a document's section target moves it.
  const target: MotionTarget = motion ? effectiveSectionTarget(motion, "none") : {};
  const enters = animatesAnywhere(target);
  if (enters) {
    const { style, ...rest } = root;
    const moved = withMotion(rest, style, "reveal", motionStyle(target));
    root = { ...moved.attrs, ...(moved.style ? { style: moved.style } : {}) };
  }

  return { key, editor, styles: shown.styles, motion, copy: shown.copy, node, media: mediaNode(source), root, enters };
}

/**
 * Whether anything on the page moves on its own — a region's entrance, or a
 * node's entrance, words or drift. Only then is the shared `MotionRuntime`
 * shipped, which is also what gives a region root its lifecycle: a page with
 * no motion ships exactly the client code it shipped before Batch 21.
 */
export const needsRuntime = (regions: Region[]): boolean =>
  regions.some(
    (region) =>
      region.enters ||
      Object.values(region.motion?.nodes ?? {}).some((target) => animatesAnywhere(target) || parallaxAnywhere(target)),
  );

/** A short, stable fingerprint of the page's node motion, for `MotionRuntime`. */
export function motionSignature(regions: Region[]): string {
  const text = JSON.stringify(regions.map((region) => [region.key, region.motion?.nodes ?? null]));
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  return (hash >>> 0).toString(36);
}

/**
 * A region's root element: the element the template always drew, with the
 * region's attributes on it. An entrance on the root is carried by those
 * attributes (`data-m-reveal` and its variables) and run by the shared
 * `MotionRuntime`, exactly as a node's is — so no wrapper is added and the
 * layout is the template's whatever the region does.
 */
export function RegionRoot({
  region,
  as = "section",
  className,
  id,
  children,
}: {
  region: Region;
  as?: ElementType;
  className?: string;
  id?: string;
  children: ReactNode;
}) {
  const Tag = as;
  return (
    <Tag id={id} {...region.root} className={className}>
      {children}
    </Tag>
  );
}
