import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";

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

/* -------------------------------------------------------------------------- */
/* Serialising a whole page                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A page and all of its sections, locked for the rest of the transaction.
 *
 * The revision guard below answers "did this row move since I read it". It
 * cannot answer "will this row move while I am deciding", and for a page-wide
 * operation that second question is the one that matters: publishing, discarding
 * and restoring all read the whole page, reason about it, and then write — and
 * an autosave landing between the reading and the writing is a save that either
 * gets destroyed or destroys.
 *
 * A lock on the `pages` row alone does not stop it. Section saves write
 * `page_sections` directly and never touch `pages`, so they sail past a page
 * lock entirely. The restore's clean-state check was exactly this bug: it read
 * three null draft columns under a page lock, concluded the page was clean, and
 * a concurrent autosave could fill one in before the restore wrote over it.
 *
 * So the rows themselves are locked, and this is the **one** place that does
 * it, in **one** order:
 *
 *     1. the page row
 *     2. every section row of that page, by ascending id
 *
 * Both parts matter. Page-first means two page-wide operations queue on the
 * page row before either touches a section, so they can never hold half of
 * each other's rows. Ascending id means two operations that somehow did reach
 * the sections first still take them in the same order. Nothing in this
 * codebase locks a section before its page; introducing that would be the way
 * to deadlock this.
 *
 * `ORDER BY id ... FOR UPDATE` locks in the sorted order rather than the plan's:
 * Postgres puts the LockRows node above the Sort, so the rows are sorted first
 * and locked as they come out.
 *
 * This is a database lock, deliberately. An in-process mutex would serialise
 * one Node process and nothing else, which is a guarantee that quietly stops
 * being true the first time the site runs on two.
 */
export type LockedPage = {
  page: typeof pages.$inferSelect;
  /** In composition order — position, then id — for the caller's benefit. */
  rows: (typeof pageSections.$inferSelect)[];
};

export async function lockPageForWrite(
  on: Executor,
  pageId: number,
): Promise<LockedPage | null> {
  if (!Number.isInteger(pageId) || pageId <= 0) return null;

  const [page] = await on.select().from(pages).where(eq(pages.id, pageId)).limit(1).for("update");
  if (!page) return null;

  await on
    .select({ id: pageSections.id })
    .from(pageSections)
    .where(eq(pageSections.pageId, pageId))
    .orderBy(asc(pageSections.id))
    .for("update");

  // Read again, unlocked and in composition order: the lock is already held, so
  // this cannot see anything the lock did not freeze.
  const rows = await on
    .select()
    .from(pageSections)
    .where(eq(pageSections.pageId, pageId))
    .orderBy(asc(pageSections.position), asc(pageSections.id));

  return { page, rows };
}

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

