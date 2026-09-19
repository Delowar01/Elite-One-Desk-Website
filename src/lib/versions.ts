import "server-only";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

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
 *
 * ## The structural contract, for the batches that will use it
 *
 * `page_sections.isDraftOnly` is what tells a pending row from an established
 * one, and nothing else does — a hidden established section and a pending new
 * one both sit at `isPublished = false`. Recorded here because the three
 * operations have to agree and only the first exists yet:
 *
 *   Restore (here)     inserts a recreated section `isDraftOnly: true`,
 *                      `isPublished: false`, published values empty, content in
 *                      `draft`, place in `pages.draft_structure`.
 *   Add (Batch 8)      the same shape for a block placed in the editor.
 *   Publish (Batch 10) clears `isDraftOnly` on the rows the structure includes,
 *                      along with their order, visibility and content.
 *   Discard (Batch 8)  may delete `isDraftOnly` rows, and must never delete an
 *                      established one merely because it is hidden.
 *
 * None of publish or discard is implemented here. This batch only guarantees
 * that the distinction they need is recorded rather than guessed at.
 */

/* -------------------------------------------------------------------------- */
/* Capture                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The page's published composition, in order. Drafts are deliberately not read.
 *
 * The filter is `isDraftOnly = false`, and it is deliberately **not**
 * `isPublished = true`. A section an editor has hidden is still part of the
 * published page — its hiddenness is a fact history has to keep, so that
 * restoring this version puts it back hidden rather than not at all. A
 * draft-only row is the opposite case: it has never been part of the published
 * page, so a snapshot of that page must not contain it, or discarding a
 * structural draft and then restoring would resurrect a block nobody ever
 * published.
 *
 * The two look identical at `isPublished = false`, which is exactly why the
 * distinction is a column rather than an inference.
 */
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
    .where(and(eq(pageSections.pageId, pageId), eq(pageSections.isDraftOnly, false)))
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

/**
 * A version, together with the page it was taken from.
 *
 * The `pageId` is the row's own `page_id`, and it is the authority on which
 * page this version belongs to. Reading the snapshot without it — as this
 * function used to — left the caller free to supply any page id it liked, so
 * Page A's history could be applied to Page B and nothing in the chain would
 * have noticed. The stored id travels with the snapshot precisely so that
 * cannot happen.
 */
export type PageVersionRecord = {
  versionId: number;
  pageId: number;
  snapshot: PageSnapshot;
};

export async function readPageVersionRecord(versionId: number): Promise<PageVersionRecord | null> {
  const [row] = await db
    .select({ id: pageVersions.id, pageId: pageVersions.pageId, snapshot: pageVersions.snapshot })
    .from(pageVersions)
    .where(eq(pageVersions.id, versionId))
    .limit(1);
  if (!row) return null;
  return { versionId: row.id, pageId: row.pageId, snapshot: validatePageSnapshot(row.snapshot) };
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

/** Who is doing this, for attribution. Never for conflict detection. */
export type RestoreActor = { userId?: number | null };

/**
 * Writes the plan. Draft columns only.
 *
 * What this must never do, and what a test asserts it does not: change
 * `published`, `styles`, `animation`, `position` or `isPublished` on any
 * existing row. A recreated section is inserted hidden with empty published
 * values, so it is invisible to the site and visible in preview — which is
 * exactly the state a pending restore should be in.
 *
 * `draftAnimation` is why `animation` is in that list. A restored version
 * carries the entrance it was published with, and putting it back has to be
 * previewable like everything else in the restore — so it goes into the draft
 * column and is rendered by `composePreview`, leaving the live page moving the
 * way it moved until somebody publishes.
 *
 * Two things it must always do, both added after review:
 *
 * **Refuse a plan that names a section it does not own, before writing
 * anything.** `planRestoreFrom` only ever puts sections of one page in a plan,
 * but this is the service that does the writing, and it should not be the case
 * that a plan built wrongly — by a bug, by a future caller, by a request that
 * supplied its own section ids — can reach into another page. Scoping each
 * UPDATE by `page_id` was not enough on its own: the foreign id would simply
 * fail to update and then be written into *this* page's `draft_structure`
 * anyway, because the structure is built from `plan.order`. So every existing
 * section the plan mentions — in `drafts` and in `order` alike — is checked
 * against `page_id` first, inside the transaction, and one stranger abandons
 * the whole plan. Nothing is written: no draft, no recreated row, no revision.
 * Fail closed, because a half-applied restore is harder to reason about than
 * one that did not happen, and the caller can re-plan against current state.
 * The per-statement `page_id` scoping stays as well; the two are cheap and
 * they fail independently.
 *
 * **Bump `revision`.** A restore replaces the draft an editor may have open.
 * Without the bump, `revision` still reads as whatever that editor loaded, and
 * their next autosave would pass the guarded update and quietly overwrite the
 * restore — the exact failure `revision` was introduced to prevent. Raising it
 * makes every open editor stale, which is the honest outcome: the page changed
 * underneath them and they should be told. The restore itself does not pass an
 * expected revision, because it is a deliberate act on the current state rather
 * than a save racing other saves.
 *
 * `updatedBy` is attribution and only attribution — who last touched the row.
 * It answers a different question from `revision` and is never the guard: two
 * saves by one person are indistinguishable by actor and are not by counter.
 */
export type RestoreApplied =
  | { ok: true; recreated: number[]; updated: number[] }
  | { ok: false; reason: "unowned_sections"; sectionIds: number[] };

/** Thrown inside the transaction so the abort rolls back by construction. */
class UnownedSections extends Error {
  constructor(readonly sectionIds: number[]) {
    super(`the plan names ${sectionIds.length} section(s) that are not on its page`);
    this.name = "UnownedSections";
  }
}

export async function applyRestorePlan(
  plan: RestorePlan,
  actor: RestoreActor = {},
): Promise<RestoreApplied> {
  const recreated: number[] = [];
  const updated: number[] = [];
  const updatedBy = actor.userId ?? null;

  try {
    await db.transaction(async (tx) => {
      // Every existing section the plan mentions, from both places it can be
      // mentioned. `order` matters as much as `drafts`: it is what becomes the
      // page's draft structure.
      const referenced = [
        ...new Set([
          ...plan.drafts.map((draft) => draft.sectionId),
          ...plan.order.flatMap((slot) => (slot.kind === "existing" ? [slot.sectionId] : [])),
        ]),
      ];
      if (referenced.length) {
        const owned = await tx
          .select({ id: pageSections.id })
          .from(pageSections)
          .where(and(eq(pageSections.pageId, plan.pageId), inArray(pageSections.id, referenced)));
        const ours = new Set(owned.map((row) => row.id));
        // A section on another page, and a section that has been deleted since
        // the plan was made, are the same answer: this plan is not applicable.
        const strangers = referenced.filter((id) => !ours.has(id));
        if (strangers.length) throw new UnownedSections(strangers);
      }

      for (const draft of plan.drafts) {
        const rows = await tx
          .update(pageSections)
          .set({
            draft: draft.draft,
            draftStyles: draft.draftStyles,
            draftAnimation: draft.draftAnimation,
            revision: sql`${pageSections.revision} + 1`,
            updatedBy,
            updatedAt: new Date(),
          })
          .where(and(eq(pageSections.id, draft.sectionId), eq(pageSections.pageId, plan.pageId)))
          .returning({ id: pageSections.id });
        if (rows.length) updated.push(rows[0]!.id);
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
            // It exists only because this restore is pending. It is not part of
            // the published page and a snapshot taken now must not contain it —
            // publishing the structural draft is what would change that.
            isDraftOnly: true,
            updatedBy,
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
          revision: sql`${pages.revision} + 1`,
          updatedBy,
          updatedAt: new Date(),
        })
        .where(eq(pages.id, plan.pageId));
    });
  } catch (error) {
    if (error instanceof UnownedSections) {
      return { ok: false, reason: "unowned_sections", sectionIds: error.sectionIds };
    }
    throw error;
  }

  return { ok: true, recreated, updated };
}

/**
 * Read, check the version really belongs to that page, plan, apply.
 *
 * `expectedPageId` is checked against the version row's own `page_id` and a
 * mismatch is refused by name. It is not there so the caller can choose the
 * target — the stored id decides that — it is there so a caller that thinks it
 * knows which page it is restoring finds out when it is wrong, rather than
 * pouring one page's history into another.
 */
export type RestoreOutcome =
  | { ok: true; pageId: number; plan: RestorePlan; recreated: number[]; updated: number[] }
  | { ok: false; reason: "missing" | "wrong_page" | "unowned_sections" };

export async function restoreVersionToDraft(
  versionId: number,
  expectedPageId: number,
  actor: RestoreActor = {},
): Promise<RestoreOutcome> {
  const record = await readPageVersionRecord(versionId);
  if (!record) return { ok: false, reason: "missing" };
  if (record.pageId !== expectedPageId) return { ok: false, reason: "wrong_page" };

  const plan = await planRestore(record.pageId, record.snapshot);
  const result = await applyRestorePlan(plan, actor);
  // A section deleted between planning and applying lands here, which is the
  // right answer: re-plan against what the page is now.
  if (!result.ok) return { ok: false, reason: result.reason };
  return {
    ok: true,
    pageId: record.pageId,
    plan,
    recreated: result.recreated,
    updated: result.updated,
  };
}
