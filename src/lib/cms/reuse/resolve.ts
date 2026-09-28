import "server-only";

import type { Executor } from "@/lib/db/revision";

import { pinReuse, referencedIds, resolveReuse, type InstanceView } from "./reference";
import { loadComponentSources } from "./store";

/**
 * Drawing references, for every surface that draws sections (Batch 17).
 *
 * One batch query for the components a page refers to, then the pure resolver
 * in `reference.ts` — so the public page, a page preview, the editor's canvas
 * and a component's own preview differ only in which values the query hands
 * back, never in how they are applied.
 */

type Drawable = { blockType: string; values: Record<string, unknown> };

/**
 * Sections with their linked content filled in.
 *
 * `views` adds, per section, what the editor needs to know about each
 * reference — for a preview or a canvas. The live page never asks for them,
 * so a visitor's page carries resolved content and nothing about where it
 * came from. `draftOf` draws one component's draft: that component's own
 * preview, and nothing else.
 */
export async function resolveSections<T extends Drawable>(
  on: Executor,
  sections: readonly T[],
  options: { views?: boolean; draftOf?: number } = {},
): Promise<(T & { reuse?: InstanceView[] })[]> {
  const ids = sections.flatMap((section) => referencedIds(section.values, section.blockType));
  if (!ids.length) return sections.map((section) => ({ ...section }));
  const sources = await loadComponentSources(on, ids, { draftOf: options.draftOf });
  return sections.map((section) => {
    const { values, instances } = resolveReuse(section.blockType, section.values, (id) => sources.get(id));
    return {
      ...section,
      values,
      ...(options.views && instances.length ? { reuse: instances } : {}),
    };
  });
}

/**
 * Published section values as a page snapshot keeps them — see `pinReuse`.
 * Read inside the publishing transaction, so the content recorded is the
 * content that was live when the restore point was taken.
 */
export async function pinPublishedValues<T extends { blockType: string; published: Record<string, unknown> | null }>(
  on: Executor,
  rows: readonly T[],
): Promise<T[]> {
  const ids = rows.flatMap((row) => referencedIds(row.published, row.blockType));
  if (!ids.length) return [...rows];
  const sources = await loadComponentSources(on, ids);
  return rows.map((row) =>
    row.published ? { ...row, published: pinReuse(row.blockType, row.published, (id) => sources.get(id)) } : row,
  );
}
