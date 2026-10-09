import "server-only";

import { asc, inArray } from "drizzle-orm";

import type { db } from "@/lib/db";
import { media } from "@/lib/db/schema";

/**
 * Holding the pictures a write names until it commits (Batch 26).
 *
 * The media library deletes a picture inside one transaction that locks its
 * row `FOR UPDATE`, counts every place that names it on that connection, and
 * deletes only when there is none (`deleteMedia`, Batch 25 F5). A foreign key
 * already makes a record's own picture safe against that: the insert or update
 * that names it takes the picture `FOR KEY SHARE` by itself. A picture named
 * inside jsonb — a section's content and draft, a reusable component's, a
 * Visual Editor route draft, the site's default share image — has no foreign
 * key, and nothing took it: a write could name a picture in the moment between
 * the delete's count and its commit, and leave an id that names nothing.
 *
 * Every writer of such a value therefore does what the foreign key does, by
 * hand, in the transaction that stores it:
 *
 *   1. it takes the rows it writes, as it always has;
 *   2. it collects the distinct positive picture ids it is about to store —
 *      by declaration (`media-refs.ts`, the route specs), never by searching
 *      values — sorts them, and holds them here `FOR KEY SHARE`, in that
 *      order;
 *   3. it refuses, by name, an id that is not there (a restore leaves it out
 *      instead, decision B) — before anything is stored;
 *   4. it stores, and commits.
 *
 * `FOR KEY SHARE` is what an insert's foreign-key check takes. It conflicts
 * with the delete's `FOR UPDATE` and with nothing else: writers never wait for
 * one another here, and editing a picture's details (`FOR NO KEY UPDATE`) is
 * not held up. So whichever of a write and a delete reaches the picture second
 * waits for the other and then sees it: the delete counts the new reference
 * and refuses, or the write finds the row gone and refuses. Neither can finish
 * pretending the other never happened.
 *
 * Lock order (docs/release/release-hardening-batch-26.md §1.4): a writer takes
 * its pictures once it has locked the content rows it reads to decide what it
 * stores, so the ids it holds are the ids it writes. What it writes after that
 * — an inserted section, its page's revision, a restore point — is safe too,
 * because the media delete waits for nothing but its one picture: it takes
 * that first, holding nothing yet; then the SEO rows naming it — the only rows
 * its `ON DELETE SET NULL` can reach, since every other use was counted and
 * refused — all at once and `NOWAIT`, refusing if one is busy; then it only
 * reads until it deletes. A transaction that waits for nothing once it holds
 * a lock cannot close a cycle, so whatever order the writers keep among
 * themselves, none of them can deadlock with a delete — and the SEO save
 * still takes its picture before its SEO rows (B.11), so it waits for a
 * delete holding nothing the delete wants. (Table locks are the one thing
 * the delete can still meet: the deploy's SEO reconcile and the one-off
 * restructure cutover never wait for a picture, but a later deploy's schema
 * migration can meet a delete in the other order, and PostgreSQL then aborts
 * one of the two — release doc §1.4.)
 *
 * The delete recounts in several statements, each with a snapshot of its own;
 * that is sound because every writer of a picture id holds it, so none can
 * commit a reference to the picture the delete holds between them.
 *
 * Only a transaction may hold: a lock taken on the pool is let go when its own
 * statement ends, which would make this a check rather than a hold.
 */

/** A transaction — never the pool. */
export type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** The largest id a Postgres `serial` can hold. */
const MAX_ID = 2_147_483_647;

/** Picture ids as a write names them: positive integers, each once, ascending. */
export function mediaIdSet(ids: Iterable<unknown>): number[] {
  const out = new Set<number>();
  for (const raw of ids) {
    if (typeof raw === "number" && Number.isInteger(raw) && raw > 0 && raw <= MAX_ID) out.add(raw);
  }
  return [...out].sort((a, b) => a - b);
}

export type MediaHold = {
  /** Every id asked for that is in the library — held until the transaction ends. */
  present: ReadonlySet<number>;
  /** Every id asked for that is not, ascending. */
  missing: number[];
};

/** Holds `ids` `FOR KEY SHARE`, in ascending order, and says which are missing. */
export async function holdMedia(tx: Transaction, ids: Iterable<unknown>): Promise<MediaHold> {
  const wanted = mediaIdSet(ids);
  if (!wanted.length) return { present: new Set(), missing: [] };
  // `ORDER BY` below the lock: Postgres sorts, then locks the rows as they come out.
  const rows = await tx
    .select({ id: media.id })
    .from(media)
    .where(inArray(media.id, wanted))
    .orderBy(asc(media.id))
    .for("key share");
  const present = new Set(rows.map((row) => row.id));
  return { present, missing: wanted.filter((id) => !present.has(id)) };
}

/**
 * The ids a write would newly bring into a row that are missing.
 *
 * An id the row already holds is not new: the delete counts the row as it is
 * committed, so a picture it names cannot be deleted under a write that keeps
 * it — and one that is missing all the same was deleted before the delete
 * could see it (Quick Links' cards, Batch 25 X1) or brought back by an
 * unchecked restore (X3). Such an id is kept as it was, never introduced, and
 * never the reason an unrelated edit is refused.
 */
export function newlyMissing(hold: MediaHold, already: Iterable<number>): number[] {
  const kept = new Set(already);
  return hold.missing.filter((id) => !kept.has(id));
}


/** Thrown inside a write's transaction when a picture it would newly bring in has gone: rolls the write back. */
export class PicturesGone extends Error {
  constructor(readonly ids: number[]) {
    super(`pictures no longer in the library: ${ids.join(", ")}`);
    this.name = "PicturesGone";
  }
}

/**
 * The protocol in one call, for a write that has taken its rows: holds `ids`,
 * and throws `PicturesGone` — taking the transaction back — when one it would
 * newly bring in (not among `already`) is missing.
 */
export async function holdPictures(
  tx: Transaction,
  ids: Iterable<unknown>,
  already: Iterable<number> = [],
): Promise<MediaHold> {
  const held = await holdMedia(tx, ids);
  const gone = newlyMissing(held, already);
  if (gone.length) throw new PicturesGone(gone);
  return held;
}

/** For `.catch` on a write's transaction: `PicturesGone` becomes `{ gone }`; anything else goes on up. */
export function picturesGone(error: unknown): { gone: number[] } {
  if (error instanceof PicturesGone) return { gone: error.ids };
  throw error;
}
