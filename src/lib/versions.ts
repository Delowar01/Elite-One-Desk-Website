import "server-only";

import { asc, desc, eq } from "drizzle-orm";

import { getBlock } from "@/lib/cms/blocks";
import {
  snapshotFromSections,
  validatePageSnapshot,
  type PageSnapshot,
} from "@/lib/cms/snapshot";
import {
  validateDraftStructure,
  type DraftStructure,
  DRAFT_STRUCTURE_VERSION,
} from "@/lib/cms/structure";
import { planRestoreFrom, type RestorePlan } from "@/lib/cms/restore";
import { emptyValues } from "@/lib/cms/values";
import { db } from "@/lib/db";
import { pageSections, pageVersions, pages } from "@/lib/db/schema";

/**
 * Page versions: capture, and put back.
 *
 * Nothing in the admin calls any of this yet. Publishing is unchanged — it does
 * not write a version row — because starting to snapshot now would be a visible
 * behaviour change in a batch whose whole point is that nothing changes.
 * Batch 10 wires it up.
 *
 * The rule the restore side is built around: **a restore must not be live.**
 * It writes drafts, draft styles, draft motion and the page's draft structure,
 * and it never touches a published value, a position or a visibility flag. The
 * editor then previews it like any other pending change and publishes it
 * deliberately, or discards it.
 */

/* -------------------------------------------------------------------------- */
/* Capture                                                                     */
/* -------------------------------------------------------------------------- */

/** The page as it is published, in order. Drafts are deliberately not read. */
export async function capturePageSnapshot(pageId: number): Promise<PageSnapshot> {
  const rows = await db
    .select({
      id: pageSections.id,
      blockType: pageSections.blockType,
      isPublished: pageSections.isPublished,
      published: pageSections.published,
      styles: pageSections.styles,
      animation: pageSections.animation,
    })
    .from(pageSections)
    .where(eq(pageSections.pageId, pageId))
    .orderBy(asc(pageSections.position), asc(pageSections.id));

  return snapshotFromSections(rows);
}

export async function savePageVersion(input: {
  pageId: number;
  label?: string;
  userId?: number | null;
  actorName?: string;
}): Promise<number> {
  const snapshot = await capturePageSnapshot(input.pageId);
  const [row] = await db
    .insert(pageVersions)
    .values({
      pageId: input.pageId,
      label: (input.label ?? "").slice(0, 120),
      snapshot,
      createdBy: input.userId ?? null,
      actorName: (input.actorName ?? "System").slice(0, 120),
    })
    .returning({ id: pageVersions.id });
  return row!.id;
}

export async function listPageVersions(pageId: number, limit = 20) {
  return db
    .select({
      id: pageVersions.id,
      label: pageVersions.label,
      actorName: pageVersions.actorName,
      createdAt: pageVersions.createdAt,
    })
    .from(pageVersions)
    .where(eq(pageVersions.pageId, pageId))
    .orderBy(desc(pageVersions.createdAt), desc(pageVersions.id))
    .limit(limit);
}

export async function readPageVersion(versionId: number): Promise<PageSnapshot | null> {
  const [row] = await db
    .select({ snapshot: pageVersions.snapshot, pageId: pageVersions.pageId })
    .from(pageVersions)
    .where(eq(pageVersions.id, versionId))
    .limit(1);
  return row ? validatePageSnapshot(row.snapshot) : null;
}

/**
 * Keeps the history bounded. Called by whoever writes a version, so the ceiling
 * holds whether or not anybody opens the screen that lists them.
 */
export async function prunePageVersions(pageId: number, keep: number): Promise<number> {
  const rows = await db
    .select({ id: pageVersions.id })
    .from(pageVersions)
    .where(eq(pageVersions.pageId, pageId))
    .orderBy(desc(pageVersions.createdAt), desc(pageVersions.id));

  const doomed = rows.slice(Math.max(0, keep));
  for (const row of doomed) {
    await db.delete(pageVersions).where(eq(pageVersions.id, row.id));
  }
  return doomed.length;
}

/* -------------------------------------------------------------------------- */
/* Restore — planned, then applied, and never live                             */
/* -------------------------------------------------------------------------- */

export type {
  LiveSection,
  RestoreDraft,
  RestoreRecreate,
  RestorePlan,
  RestoreSlot,
} from "@/lib/cms/restore";

/**
 * Works out what a restore would do, without doing any of it.
 *
 * Reads the page's sections and hands them to `planRestoreFrom`, which is where
 * the matching rules live and where they are tested — this function is the one
 * database query the planner needs and nothing else.
 */
export async function planRestore(pageId: number, input: PageSnapshot): Promise<RestorePlan> {
  const live = await db
    .select({ id: pageSections.id, blockType: pageSections.blockType })
    .from(pageSections)
    .where(eq(pageSections.pageId, pageId))
    .orderBy(asc(pageSections.position), asc(pageSections.id));

  return planRestoreFrom(pageId, input, live);
}

/**
 * Writes the plan. Draft columns only.
 *
 * What this must never do, and what a test asserts it does not: change
 * `published`, `styles`, `animation`, `position` or `isPublished` on any
 * existing row. A recreated section is inserted hidden with empty published
 * values, so it is invisible to the site and visible in preview — which is
 * exactly the state a pending restore should be in.
 */
export async function applyRestorePlan(plan: RestorePlan): Promise<{ recreated: number[] }> {
  const recreated: number[] = [];

  await db.transaction(async (tx) => {
    for (const draft of plan.drafts) {
      await tx
        .update(pageSections)
        .set({
          draft: draft.draft,
          draftStyles: draft.draftStyles,
          draftAnimation: draft.draftAnimation,
          updatedAt: new Date(),
        })
        .where(eq(pageSections.id, draft.sectionId));
    }

    const [last] = await tx
      .select({ position: pageSections.position })
      .from(pageSections)
      .where(eq(pageSections.pageId, plan.pageId))
      .orderBy(desc(pageSections.position))
      .limit(1);
    let next = (last?.position ?? -1) + 1;

    // Appended at the end of the live page on purpose: `position` is the
    // *published* order and a restore does not change it. Where the section
    // belongs is recorded in the draft structure below.
    const idFor = new Map<number, number>();
    for (const [index, entry] of plan.recreate.entries()) {
      const block = getBlock(entry.blockType);
      if (!block) continue;
      const [row] = await tx
        .insert(pageSections)
        .values({
          pageId: plan.pageId,
          blockType: entry.blockType,
          position: next,
          isPublished: false,
          published: emptyValues(block),
          draft: entry.draft,
          draftStyles: entry.draftStyles,
          draftAnimation: entry.draftAnimation,
        })
        .returning({ id: pageSections.id });
      next += 1;
      if (row) {
        recreated.push(row.id);
        idFor.set(index, row.id);
      }
    }

    const sections: DraftStructure["sections"] = [];
    for (const slot of plan.order) {
      if (slot.kind === "existing") {
        sections.push({ sectionId: slot.sectionId, visible: slot.visible });
        continue;
      }
      const id = idFor.get(slot.index);
      if (id) sections.push({ sectionId: id, visible: slot.visible });
    }

    await tx
      .update(pages)
      .set({
        draftStructure: validateDraftStructure({ v: DRAFT_STRUCTURE_VERSION, sections }),
        updatedAt: new Date(),
      })
      .where(eq(pages.id, plan.pageId));
  });

  return { recreated };
}

/** Convenience for tests and future callers: read, plan, apply. */
export async function restoreVersionToDraft(versionId: number, pageId: number) {
  const snapshot = await readPageVersion(versionId);
  if (!snapshot) return null;
  const plan = await planRestore(pageId, snapshot);
  return { plan, result: await applyRestorePlan(plan) };
}
