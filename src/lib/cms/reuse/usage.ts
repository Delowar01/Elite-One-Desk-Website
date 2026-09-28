import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";

import type { Executor } from "@/lib/db/revision";
import { pageSections, pageVersions, pages } from "@/lib/db/schema";

import { getBlock } from "../blocks";
import { readDraftStructure } from "../structure";
import { readReuse, slotDef } from "./reference";
import { HAS_REFERENCE, refersTo } from "./store";
import { summarise, type UsageInstance, type UsageSummary } from "./usage-view";

export {
  EMPTY_USAGE,
  impactSentence,
  publishedSentence,
  usageHeadline,
  type UsageInstance,
  type UsageSummary,
} from "./usage-view";

/**
 * "Used on X pages" — derived, never stored (Batch 17).
 *
 * There is no usage counter anywhere. A counter is a second copy of a fact the
 * sections already state, and a second copy is wrong the first time a path
 * forgets to update it — a discard, a restore, a deleted page, a duplicated
 * section. Usage is read from the references themselves: the section rows
 * carrying a `_reuse` key (the partial index `page_sections_reuse_idx` holds
 * exactly those, so this is a query over a handful of rows rather than a scan
 * of every page's content), classified against each page's own state.
 *
 * Three questions, answered separately because they are different questions:
 *
 *   · **live** — does a visitor see it now? The page is published, the
 *     section is part of the published page and visible, and its *published*
 *     content refers to the component. This is what publishing the component
 *     changes for visitors, and what the warning before publishing counts.
 *   · **draft** — does the page as it will be published show it? The section
 *     is a visible member of the page's pending layout (or of the live layout
 *     when nothing is pending) and its draft content — or its published
 *     content, when it has no draft — refers to the component.
 *   · **hidden** — the pending layout keeps it but hides it.
 *
 * The headline is the union: an instance counts once if a visitor sees it or
 * the pending page shows it. A reference in a row that belongs to neither — a
 * pending section no layout lists — is not an instance, but it is still a
 * reference, and `referenced` says so for the delete guard.
 */

type ReferencingRow = {
  id: number;
  pageId: number;
  blockType: string;
  isPublished: boolean;
  isDraftOnly: boolean;
  published: Record<string, unknown> | null;
  draft: Record<string, unknown> | null;
  slug: string;
  title: string;
  pagePublished: boolean;
  draftStructure: Record<string, unknown> | null;
};

async function referencingRows(on: Executor, componentId?: number): Promise<ReferencingRow[]> {
  const filter =
    componentId === undefined
      ? HAS_REFERENCE
      : and(
          HAS_REFERENCE,
          sql`(${refersTo(pageSections.published, componentId)} OR ${refersTo(pageSections.draft, componentId)})`,
        );
  return on
    .select({
      id: pageSections.id,
      pageId: pageSections.pageId,
      blockType: pageSections.blockType,
      isPublished: pageSections.isPublished,
      isDraftOnly: pageSections.isDraftOnly,
      published: pageSections.published,
      draft: pageSections.draft,
      slug: pages.slug,
      title: pages.titleEn,
      pagePublished: pages.isPublished,
      draftStructure: pages.draftStructure,
    })
    .from(pageSections)
    .innerJoin(pages, eq(pages.id, pageSections.pageId))
    .where(filter)
    .orderBy(asc(pages.sortOrder), asc(pages.id), asc(pageSections.position), asc(pageSections.id));
}

/** One row's instances of one component — one per slot that refers to it. */
function instancesOf(row: ReferencingRow, componentId: number): UsageInstance[] {
  const layout = readDraftStructure(row.draftStructure);
  const entry = layout ? layout.sections.find((candidate) => candidate.sectionId === row.id) : undefined;
  // With a pending layout, membership and visibility are the layout's; without
  // one, the page as it stands — established rows at their live visibility.
  const member = layout ? entry !== undefined : !row.isDraftOnly;
  const shown = layout ? entry?.visible === true : row.isPublished;

  const live = row.isDraftOnly ? {} : readReuse(row.published, row.blockType);
  const pending = readReuse(row.draft ?? row.published, row.blockType);
  const slots = [...new Set([...Object.keys(live), ...Object.keys(pending)])].filter(
    (slot) => live[slot]?.c === componentId || pending[slot]?.c === componentId,
  );

  return slots.map((slot) => {
    const inPending = member && pending[slot]?.c === componentId;
    return {
      pageId: row.pageId,
      slug: row.slug,
      title: row.title,
      pagePublished: row.pagePublished,
      sectionId: row.id,
      blockType: row.blockType,
      blockName: getBlock(row.blockType)?.name ?? row.blockType,
      slot,
      slotLabel: slotDef(row.blockType, slot)?.label ?? slot,
      live: row.pagePublished && !row.isDraftOnly && row.isPublished && live[slot]?.c === componentId,
      draft: inPending && shown,
      hidden: inPending && !shown,
      overrides: (pending[slot]?.c === componentId ? pending[slot]?.o : live[slot]?.o)?.length ?? 0,
    };
  });
}

/** Where one component is used, instance by instance, with the counts. */
export async function componentUsage(
  on: Executor,
  componentId: number,
): Promise<{ instances: UsageInstance[]; summary: UsageSummary }> {
  const rows = await referencingRows(on, componentId);
  const instances = rows.flatMap((row) => instancesOf(row, componentId));
  return { instances, summary: summarise(instances, rows.length > 0) };
}

/** Every component's counts at once, for a list — one query over the referencing rows. */
export async function usageByComponent(on: Executor): Promise<Map<number, UsageSummary>> {
  const rows = await referencingRows(on);
  const byComponent = new Map<number, { instances: UsageInstance[]; rows: Set<number> }>();
  for (const row of rows) {
    const ids = new Set<number>();
    for (const values of [row.published, row.draft]) {
      for (const entry of Object.values(readReuse(values, row.blockType))) ids.add(entry.c);
    }
    for (const id of ids) {
      const bucket = byComponent.get(id) ?? { instances: [], rows: new Set<number>() };
      bucket.instances.push(...instancesOf(row, id));
      bucket.rows.add(row.id);
      byComponent.set(id, bucket);
    }
  }
  return new Map([...byComponent].map(([id, bucket]) => [id, summarise(bucket.instances, bucket.rows.size > 0)]));
}

/** How many retained page versions refer to a component; the delete guard counts them as well as section rows. */
export async function pageVersionReferences(on: Executor, componentId: number): Promise<number> {
  const [row] = await on
    .select({ count: sql<number>`count(*)::int` })
    .from(pageVersions)
    .where(
      sql`jsonb_path_exists(${pageVersions.snapshot}, '$.sections[*].published._reuse.* ? (@.c == $c)', jsonb_build_object('c', ${componentId}::int))`,
    );
  return row?.count ?? 0;
}
