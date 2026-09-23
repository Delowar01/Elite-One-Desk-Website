import "server-only";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { getBlock } from "@/lib/cms/blocks";
import {
  readPageSnapshot,
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
import { KEEP_PAGE_VERSIONS } from "@/lib/visual-editor/publish";
import { lockPageForWrite, type Executor } from "@/lib/db/revision";
import { pageSections, pageVersions, pages } from "@/lib/db/schema";

/**
 * Page versions: capture, and put back.
 *
 * A version row is a **pre-publish restore point**: the page's published
 * composition as it stood immediately *before* a successful live publication.
 * That is the shape Undo wants. The live page is already on screen and needs no
 * row of its own; what an editor reaches for after publishing something wrong
 * is the state they just left, and the newest history row is exactly that.
 * Labelling one of these "after publishing" would be the same row under a name
 * that sends people to the wrong entry.
 *
 * Every helper here takes an executor, because a restore point that is not
 * written in the same transaction as the publication it describes is worse than
 * none: a publication that rolls back would leave a history entry for something
 * that never happened, and one that succeeded after a failed insert would leave
 * a live state nobody can get back from.
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
 * one both sit at `isPublished = false`. All four operations exist now, and
 * they agree:
 *
 *   Restore (here)             inserts a recreated section `isDraftOnly: true`,
 *                              `isPublished: false`, published values empty,
 *                              content in `draft`, place in
 *                              `pages.draft_structure`.
 *   Add (structure-service)    the same shape for a block placed in an editor.
 *   Publish (publish-service)  clears `isDraftOnly` on the rows the structure
 *                              includes, along with their order, visibility
 *                              and content, and deletes the rows it omits.
 *   Discard (publish-service)  deletes `isDraftOnly` rows, and never deletes an
 *                              established one merely because it is hidden.
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
export async function capturePageSnapshotIn(on: Executor, pageId: number): Promise<PageSnapshot> {
  const rows = await on
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

/** The same, on the pool, for a caller that is not inside a transaction. */
export const capturePageSnapshot = (pageId: number): Promise<PageSnapshot> =>
  capturePageSnapshotIn(db, pageId);

/**
 * How many restore points a page keeps.
 *
 * Bounded because each row carries a full composition, so an unbounded history
 * is an unbounded database — and because nobody reaches past the last few. The
 * prune runs in the same transaction as the insert, so a publication that rolls
 * back changes neither the history nor the ceiling.
 *
 * Declared in `lib/visual-editor/publish` and re-exported here: the panel that
 * says "the last 30 published states are kept" is a client component and cannot
 * import this module to find the number out.
 */
export { KEEP_PAGE_VERSIONS } from "@/lib/visual-editor/publish";

export type VersionInput = {
  pageId: number;
  label?: string;
  userId?: number | null;
  actorName?: string;
};

export async function savePageVersionIn(on: Executor, input: VersionInput): Promise<number> {
  const snapshot = await capturePageSnapshotIn(on, input.pageId);
  const [row] = await on
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

export const savePageVersion = (input: VersionInput): Promise<number> =>
  savePageVersionIn(db, input);

/**
 * One restore point, written and pruned together.
 *
 * The pair every publication path calls, so "publishing writes history" has one
 * implementation and the retention cannot be observed at a different ceiling
 * depending on which button was pressed.
 */
export async function recordRestorePointIn(
  on: Executor,
  input: VersionInput,
): Promise<{ versionId: number; pruned: number }> {
  const versionId = await savePageVersionIn(on, input);
  const pruned = await prunePageVersionsIn(on, input.pageId, KEEP_PAGE_VERSIONS);
  return { versionId, pruned };
}

/**
 * The order restore points are in — by **id**, and not by when they say they
 * were taken.
 *
 * `created_at` is `defaultNow()`, and Postgres's `now()` is the *transaction*
 * timestamp: the moment the transaction executed its first statement, not the
 * moment this row was written. Every restore point is inserted while holding
 * the page row `FOR UPDATE` (see `recordRestorePointIn`), so publications
 * serialize — but a transaction can begin well before it reaches that lock.
 * Two publications of one page can therefore begin in one order and serialize
 * in the other, and then the later publication's row carries the earlier
 * timestamp.
 *
 * Demonstrated rather than reasoned about: with A's transaction begun first and
 * B's allowed to take the lock first, B inserted `id = 1` stamped 20:41:51.449
 * and A inserted `id = 2` stamped 20:41:51.439 — ten milliseconds *earlier*
 * than the row written before it. Ordering by time then called B the newest
 * restore point when A was, which is how a concurrent publication could offer
 * an intermediate state as the page's starting point.
 *
 * `id` is a `serial`, allocated by the INSERT itself, and every INSERT happens
 * under the page lock — so for one page it is exactly publication order. That
 * invariant is what makes this sound, and it is asserted in the tests: if a
 * history writer ever appears that does not hold the lock, the ordering has to
 * be reconsidered rather than the invariant quietly broken.
 *
 * `created_at` stays, and is still what the panel shows an editor. It is a
 * timestamp for reading, not for sorting.
 */
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
    .orderBy(desc(pageVersions.id))
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
 * The same row, read the way a **restore** has to read it.
 *
 * `validatePageSnapshot` rebuilds anything into a valid document, and for a
 * history *list* that is right. For a restore it is not: the document an
 * unreadable snapshot rebuilds into is a page with no sections, and restoring
 * that stages the removal of everything on the page. `readPageSnapshot`
 * refuses instead, and a genuinely empty historical page still restores,
 * because emptiness is not what it tests.
 */
export type StrictVersionRead =
  | { ok: true; record: PageVersionRecord }
  | { ok: false; reason: "missing" | "unsupported" };

export async function readPageVersionStrict(versionId: number): Promise<StrictVersionRead> {
  if (!Number.isInteger(versionId) || versionId <= 0) return { ok: false, reason: "missing" };
  const [row] = await db
    .select({ id: pageVersions.id, pageId: pageVersions.pageId, snapshot: pageVersions.snapshot })
    .from(pageVersions)
    .where(eq(pageVersions.id, versionId))
    .limit(1);
  if (!row) return { ok: false, reason: "missing" };
  const read = readPageSnapshot(row.snapshot);
  if (!read.ok) return { ok: false, reason: "unsupported" };
  return { ok: true, record: { versionId: row.id, pageId: row.pageId, snapshot: read.snapshot } };
}

/**
 * Keeps the history bounded. Called by whoever writes a version, so the ceiling
 * holds whether or not anybody opens the screen that lists them.
 */
export async function prunePageVersionsIn(
  on: Executor,
  pageId: number,
  keep: number,
): Promise<number> {
  const rows = await on
    .select({ id: pageVersions.id })
    .from(pageVersions)
    .where(eq(pageVersions.pageId, pageId))
    // The same order the history list uses, and it has to be: a ceiling that
    // counted from one end while the screen counted from the other would throw
    // away a restore point an editor could see, and keep one they could not.
    // See `listPageVersions` for why that order is the id.
    .orderBy(desc(pageVersions.id));

  const doomed = rows.slice(Math.max(0, keep));
  if (!doomed.length) return 0;
  await on.delete(pageVersions).where(inArray(pageVersions.id, doomed.map((row) => row.id)));
  return doomed.length;
}

export const prunePageVersions = (pageId: number, keep: number): Promise<number> =>
  prunePageVersionsIn(db, pageId, keep);

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

export async function applyRestorePlanIn(
  tx: Executor,
  plan: RestorePlan,
  actor: RestoreActor = {},
): Promise<RestoreApplied> {
  const recreated: number[] = [];
  const updated: number[] = [];
  const updatedBy = actor.userId ?? null;

  {
    {
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
    }
  }

  return { ok: true, recreated, updated };
}

/**
 * The same, in a transaction of its own.
 *
 * Kept for callers that restore a plan they built themselves. The version
 * restore below opens its own transaction instead, because the check it has to
 * make — that the page has no saved drafts — is only worth anything if nothing
 * can write one between the check and the restore.
 */
export async function applyRestorePlan(
  plan: RestorePlan,
  actor: RestoreActor = {},
): Promise<RestoreApplied> {
  try {
    return await db.transaction(async (tx) => applyRestorePlanIn(tx, plan, actor));
  } catch (error) {
    if (error instanceof UnownedSections) {
      return { ok: false, reason: "unowned_sections", sectionIds: error.sectionIds };
    }
    throw error;
  }
}

/**
 * Read, check the version really belongs to that page, plan, apply.
 *
 * `expectedPageId` is checked against the version row's own `page_id` and a
 * mismatch is refused by name. It is not there so the caller can choose the
 * target — the stored id decides that — it is there so a caller that thinks it
 * knows which page it is restoring finds out when it is wrong, rather than
 * pouring one page's history into another.
 *
 * Two things this batch added, and both are about what the restore is allowed
 * to land on top of.
 *
 * **The snapshot is read strictly.** A history row this build cannot parse is
 * refused rather than rebuilt into an empty page, because restoring an empty
 * page stages the removal of every section on it.
 *
 * **The page must have nothing saved.** A restore writes into every draft
 * column the page has, so applying one over existing saved work would replace
 * it — possibly a colleague's, on a page they have open and have not published
 * yet. Requiring a clean slate and saying so is the honest V1 answer; merging
 * two sets of pending intentions is not something software should guess at.
 *
 * Both the check and the restore happen inside one transaction with the page
 * row locked, so the answer cannot go stale between them: a colleague's save
 * either lands before the lock, and the restore is refused, or after it, and it
 * is refused by the revision the restore bumped.
 */
export type RestoreOutcome =
  | { ok: true; pageId: number; plan: RestorePlan; recreated: number[]; updated: number[] }
  | {
      ok: false;
      reason: "missing" | "wrong_page" | "unowned_sections" | "unsupported" | "not_clean";
    };

/** Thrown inside the restore transaction so the abort rolls it back. */
class RestoreStopped extends Error {
  constructor(readonly reason: "not_clean" | "unowned_sections") {
    super(reason);
    this.name = "RestoreStopped";
  }
}

export async function restoreVersionToDraft(
  versionId: number,
  expectedPageId: number,
  actor: RestoreActor = {},
): Promise<RestoreOutcome> {
  const read = await readPageVersionStrict(versionId);
  if (!read.ok) return { ok: false, reason: read.reason };
  const record = read.record;
  if (record.pageId !== expectedPageId) return { ok: false, reason: "wrong_page" };

  let outcome: { plan: RestorePlan; recreated: number[]; updated: number[] } | null = null;

  try {
    await db.transaction(async (tx) => {
      /**
       * The page **and every section row**, locked for the rest of the
       * transaction.
       *
       * This is what makes the clean-state check below mean anything. A lock
       * on the `pages` row alone does not stop a section autosave, because a
       * section save writes `page_sections` and never touches `pages` — so the
       * old version of this could read three null draft columns, conclude the
       * page was clean, and have a colleague's autosave land in one of them
       * before it wrote the historical values over the top.
       *
       * With the rows held, the two orderings are the only ones possible: the
       * save commits first and this sees the draft and refuses, or this commits
       * first and the save's expected revision is stale and it conflicts.
       */
      const locked = await lockPageForWrite(tx, record.pageId);
      if (!locked) throw new RestoreStopped("not_clean");
      const { page, rows } = locked;

      const dirty =
        page.draftStructure !== null ||
        rows.some(
          (row) =>
            row.isDraftOnly ||
            row.draft !== null ||
            row.draftStyles !== null ||
            row.draftAnimation !== null,
        );
      if (dirty) throw new RestoreStopped("not_clean");

      // Planned against the rows this transaction locked, so the plan cannot
      // name a section that has since gone or miss one that has since arrived.
      const plan = planRestoreFrom(
        record.pageId,
        record.snapshot,
        rows.map((row) => ({ id: row.id, blockType: row.blockType })),
      );
      const applied = await applyRestorePlanIn(tx, plan, actor);
      if (!applied.ok) throw new RestoreStopped("unowned_sections");

      /**
       * Every section the restore *re-interprets* becomes stale, not just the
       * ones it writes into.
       *
       * A restore that leaves a section out of the historical layout has
       * staged its removal — that section's meaning has changed completely —
       * but `applyRestorePlanIn` only bumps the rows it puts draft values in.
       * An editor who had one of the omitted sections open would keep a
       * revision the restore never moved, and their next save would pass the
       * guard and write into a section the page is about to delete.
       *
       * Recreated rows are deliberately excluded: they are new, and nobody has
       * them open. Rows the plan already bumped are excluded too — one
       * restore, one increment per row.
       */
      const touched = new Set(applied.updated);
      const stale = rows
        .filter((row) => !touched.has(row.id))
        .map((row) => row.id);
      if (stale.length) {
        await tx
          .update(pageSections)
          .set({
            revision: sql`${pageSections.revision} + 1`,
            updatedBy: actor.userId ?? null,
            updatedAt: new Date(),
          })
          .where(
            and(eq(pageSections.pageId, record.pageId), inArray(pageSections.id, stale)),
          );
      }

      outcome = { plan, recreated: applied.recreated, updated: applied.updated };
    });
  } catch (error) {
    if (error instanceof RestoreStopped) return { ok: false, reason: error.reason };
    if (error instanceof UnownedSections) return { ok: false, reason: "unowned_sections" };
    throw error;
  }

  const done = outcome as { plan: RestorePlan; recreated: number[]; updated: number[] } | null;
  if (!done) return { ok: false, reason: "not_clean" };
  return {
    ok: true,
    pageId: record.pageId,
    plan: done.plan,
    recreated: done.recreated,
    updated: done.updated,
  };
}
