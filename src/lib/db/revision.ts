import "server-only";

import { and, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { pageSections, pages } from "@/lib/db/schema";

/**
 * Optimistic concurrency for the editor's saves.
 *
 * A visual editor autosaves. Two people with the same page open will overlap,
 * and the question is what happens then — not whether it happens. A timestamp
 * cannot answer it: two writes inside the same clock tick are indistinguishable
 * by time, and `updated_at` is rewritten by anything that touches the row.
 * `revision` is a counter the writer must name:
 *
 *     read revision N  →  UPDATE … WHERE id = ? AND revision = N  →  N + 1
 *
 * Zero rows updated means somebody else got there first. That is a conflict,
 * reported as one — never a silent last-write-wins, which is how an editor
 * discovers at publish time that an hour of somebody else's work is gone.
 *
 * `updated_by` is attribution, not detection. It answers "who last touched
 * this", which is a different question and a worse guard: two saves by the same
 * person would look identical.
 *
 * Every content writer names a revision: the Visual Editor's inspector, the
 * ordinary section editor's form, publishing one section, discarding a draft,
 * and publishing a whole page — which guards each section inside one
 * transaction, so a page is published entirely or not at all. A writer that
 * did not participate would make the others' guarantees worthless, because the
 * counter only means anything if nothing moves the row without moving it.
 */

export type GuardedUpdate =
  | { ok: true; revision: number }
  | { ok: false; reason: "conflict" | "missing" };

/**
 * Anything that can run a statement: the pool, or a transaction.
 *
 * Publishing a whole page has to guard every section and roll all of them back
 * if one has moved underneath it, so the guard has to be usable inside a
 * transaction. Taking the executor as an argument is the whole of what that
 * needs — there is no second implementation of the check.
 */
export type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

async function guarded(
  on: Executor,
  table: typeof pageSections | typeof pages,
  id: number,
  expected: number,
  values: Record<string, unknown>,
): Promise<GuardedUpdate> {
  const updated = await on
    .update(table)
    .set({
      ...values,
      revision: sql`${table.revision} + 1`,
      updatedAt: new Date(),
    })
    .where(and(eq(table.id, id), eq(table.revision, expected)))
    .returning({ revision: table.revision });

  if (updated.length) return { ok: true, revision: updated[0]!.revision };

  // Nothing matched. Which of the two it was changes what the caller should
  // say, and "this no longer exists" is not "somebody else changed it".
  const [row] = await on.select({ id: table.id }).from(table).where(eq(table.id, id)).limit(1);
  return { ok: false, reason: row ? "conflict" : "missing" };
}

/** Update one section, only if it is still at the revision the caller read. */
export const updateSectionGuarded = (
  id: number,
  expectedRevision: number,
  values: Record<string, unknown>,
): Promise<GuardedUpdate> => guarded(db, pageSections, id, expectedRevision, values);

/** The same inside a transaction, for an all-or-nothing write across sections. */
export const updateSectionGuardedIn = (
  on: Executor,
  id: number,
  expectedRevision: number,
  values: Record<string, unknown>,
): Promise<GuardedUpdate> => guarded(on, pageSections, id, expectedRevision, values);

/** The same, for a page's own row — structure lives there. */
export const updatePageGuarded = (
  id: number,
  expectedRevision: number,
  values: Record<string, unknown>,
): Promise<GuardedUpdate> => guarded(db, pages, id, expectedRevision, values);

/**
 * …and inside a transaction, for a structural change that is more than one
 * statement.
 *
 * Adding a section writes a row *and* the document that says where it goes.
 * Either both land or neither does: a page left holding a section nobody
 * listed would be a block that exists, cannot be reached from the layout, and
 * has to be found by hand. The guard is what makes the pair atomic against
 * other editors as well as against a crash — it is checked last, inside the
 * same transaction, so a page that moved underneath the insert rolls the
 * insert back with it.
 */
export const updatePageGuardedIn = (
  on: Executor,
  id: number,
  expectedRevision: number,
  values: Record<string, unknown>,
): Promise<GuardedUpdate> => guarded(on, pages, id, expectedRevision, values);

/**
 * Delete one section, only if it is still at the revision the caller read.
 *
 * Publishing a layout that removes a section deletes the row, and a delete is
 * the one operation a stale guard cannot be forgiven for: an UPDATE that loses
 * a race leaves the newer value in place, while a DELETE that loses one takes
 * somebody's work with it and leaves nothing to compare against. So removal
 * names a revision exactly as promotion does, and a row that moved underneath
 * the publication rolls the whole transaction back rather than disappearing.
 *
 * There is no `revision` to return — the row is gone — so the answer is only
 * whether it went. `missing` and `conflict` are still kept apart: a row already
 * deleted by somebody else is not the same accident as one that was edited.
 */
export type GuardedDelete = { ok: true } | { ok: false; reason: "conflict" | "missing" };

export async function deleteSectionGuardedIn(
  on: Executor,
  id: number,
  expectedRevision: number,
): Promise<GuardedDelete> {
  const removed = await on
    .delete(pageSections)
    .where(and(eq(pageSections.id, id), eq(pageSections.revision, expectedRevision)))
    .returning({ id: pageSections.id });
  if (removed.length) return { ok: true };

  const [row] = await on
    .select({ id: pageSections.id })
    .from(pageSections)
    .where(eq(pageSections.id, id))
    .limit(1);
  return { ok: false, reason: row ? "conflict" : "missing" };
}

/**
 * Delete several sections of one page, each against the revision that was read.
 *
 * Used where the rows being removed carry nothing worth keeping — a page-level
 * discard throwing away the sections a layout draft invented. The page scope is
 * belt to the id's braces: an id from another page simply does not match, and
 * the count coming back short is what the caller checks.
 */
export async function deleteSectionsIn(
  on: Executor,
  pageId: number,
  ids: readonly number[],
): Promise<number> {
  if (!ids.length) return 0;
  const removed = await on
    .delete(pageSections)
    .where(and(eq(pageSections.pageId, pageId), inArray(pageSections.id, [...ids])))
    .returning({ id: pageSections.id });
  return removed.length;
}
