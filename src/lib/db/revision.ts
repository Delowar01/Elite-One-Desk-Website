import "server-only";

import { and, eq, sql } from "drizzle-orm";

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
 * No conflict UI exists yet; this is the primitive it will be built on.
 */

export type GuardedUpdate =
  | { ok: true; revision: number }
  | { ok: false; reason: "conflict" | "missing" };

async function guarded(
  table: typeof pageSections | typeof pages,
  id: number,
  expected: number,
  values: Record<string, unknown>,
): Promise<GuardedUpdate> {
  const updated = await db
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
  const [row] = await db.select({ id: table.id }).from(table).where(eq(table.id, id)).limit(1);
  return { ok: false, reason: row ? "conflict" : "missing" };
}

/** Update one section, only if it is still at the revision the caller read. */
export const updateSectionGuarded = (
  id: number,
  expectedRevision: number,
  values: Record<string, unknown>,
): Promise<GuardedUpdate> => guarded(pageSections, id, expectedRevision, values);

/** The same, for a page's own row — structure lives there. */
export const updatePageGuarded = (
  id: number,
  expectedRevision: number,
  values: Record<string, unknown>,
): Promise<GuardedUpdate> => guarded(pages, id, expectedRevision, values);
