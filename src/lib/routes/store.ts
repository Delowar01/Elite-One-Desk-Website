import "server-only";

import { and, asc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { unstable_cache } from "next/cache";

import { TAGS } from "@/lib/cache";
import { readMotionDocument, type MotionDocument } from "@/lib/cms/motion-doc";
import { validateStyleDocument, type StyleDocument } from "@/lib/cms/styles";
import { db } from "@/lib/db";
import type { Executor } from "@/lib/db/revision";
import { routeNodes } from "@/lib/db/schema";

import type { StoredPatch } from "./category";

/**
 * `route_nodes`, read and written (Batch 21).
 *
 * The one rule of this module: **a write names the revision it was built on.**
 * Every draft save goes through `writeNodeGuarded`, which moves the row only if
 * it is still at that revision — the dynamic-route twin of
 * `updateSectionGuarded` — and a row that does not exist yet is revision 0, so
 * two editors creating the same region's first draft cannot both succeed.
 *
 * The public route reads only `publishedPresentation`: the published columns,
 * cached and tagged. No draft column is ever selected on a visitor's request.
 */

export type NodeRow = typeof routeNodes.$inferSelect;

/** What one owner's presentation is, published and pending, read tolerantly for display. */
export type Presentation = {
  styles: StyleDocument;
  motion: MotionDocument | null;
  copy: Record<string, string>;
};

const asCopy = (value: unknown): Record<string, string> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === "string") out[key] = raw;
  }
  return out;
};

/** The published presentation of one row, or nothing. */
export const publishedOf = (row: NodeRow | undefined | null): Presentation => ({
  styles: validateStyleDocument(row?.styles ?? null),
  motion: row?.motion ? readMotionDocument(row.motion) : null,
  copy: asCopy(row?.copy),
});

/** What the editor shows: the drafts where there are any, the published presentation otherwise. */
export const draftPresentationOf = (row: NodeRow | undefined | null): Presentation => {
  const published = publishedOf(row);
  return {
    styles: row?.draftStyles != null ? validateStyleDocument(row.draftStyles) : published.styles,
    motion: row?.draftMotion != null ? readMotionDocument(row.draftMotion) : published.motion,
    copy: published.copy,
  };
};

/** The draft patch of a row, read tolerantly: anything unreadable is nothing pending. */
export function patchOf(row: NodeRow | undefined | null): StoredPatch {
  const raw = row?.draftContent;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: StoredPatch = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (entry && typeof entry === "object" && "value" in entry && "base" in entry) {
      out[key] = { value: (entry as { value: unknown }).value, base: (entry as { base: unknown }).base };
    }
  }
  return out;
}

/** Whether a row holds anything unpublished. */
export const hasDraft = (row: NodeRow | undefined | null): boolean =>
  Boolean(row && (row.draftContent !== null || row.draftStyles !== null || row.draftMotion !== null));

/**
 * The rows for a set of owners, by owner key. `lock` holds them `FOR UPDATE`
 * in owner-key order — the one order every writer takes them in — for a
 * publication, a discard or a restore that decides what to write from what it
 * read.
 */
export async function readNodes(
  on: Executor,
  ownerKeys: readonly string[],
  options: { lock?: boolean } = {},
): Promise<Map<string, NodeRow>> {
  const keys = [...new Set(ownerKeys)].sort();
  if (!keys.length) return new Map();
  const query = on.select().from(routeNodes).where(inArray(routeNodes.ownerKey, keys)).orderBy(asc(routeNodes.ownerKey));
  const rows = options.lock ? await query.for("update") : await query;
  return new Map(rows.map((row) => [row.ownerKey, row]));
}

export type NodeWrite =
  | { ok: true; revision: number; row: NodeRow }
  | { ok: false; reason: "conflict" };

/**
 * Writes one owner's row, only if it is still at `expected`.
 *
 * `expected` 0 means "there is no row yet": the row is inserted, and a row
 * that appeared in the meantime makes the insert a no-op and the answer a
 * conflict. Anything else updates `WHERE revision = expected`. Either way the
 * revision moves by exactly one, the author and the time are stamped, and the
 * route the region was edited on is recorded.
 */
export async function writeNodeGuarded(
  on: Executor,
  input: {
    ownerKey: string;
    routeKey: string;
    expected: number;
    actorId: number | null;
    values: Partial<Pick<NodeRow, "draftContent" | "draftStyles" | "draftMotion" | "styles" | "motion" | "copy">>;
  },
): Promise<NodeWrite> {
  const { ownerKey, routeKey, expected, actorId, values } = input;
  if (expected === 0) {
    const inserted = await on
      .insert(routeNodes)
      .values({
        ownerKey,
        routeKey,
        ...values,
        revision: 1,
        createdBy: actorId,
        updatedBy: actorId,
      })
      .onConflictDoNothing({ target: routeNodes.ownerKey })
      .returning();
    return inserted.length ? { ok: true, revision: 1, row: inserted[0]! } : { ok: false, reason: "conflict" };
  }

  const updated = await on
    .update(routeNodes)
    .set({
      ...values,
      routeKey,
      revision: sql`${routeNodes.revision} + 1`,
      updatedBy: actorId,
      updatedAt: new Date(),
    })
    .where(and(eq(routeNodes.ownerKey, ownerKey), eq(routeNodes.revision, expected)))
    .returning();
  return updated.length ? { ok: true, revision: updated[0]!.revision, row: updated[0]! } : { ok: false, reason: "conflict" };
}

/**
 * Every published presentation on the site, for the public route.
 *
 * One query, one cache entry, tagged `routes` and dropped by every route
 * publication: a few hundred small rows at most, shared by every category
 * page, so the warm public path costs no round trip at all. Only the
 * published columns are selected — never a draft.
 */
export const publishedPresentations = unstable_cache(
  async (): Promise<Record<string, { styles: unknown; motion: unknown; copy: unknown }>> => {
    const rows = await db
      .select({
        ownerKey: routeNodes.ownerKey,
        styles: routeNodes.styles,
        motion: routeNodes.motion,
        copy: routeNodes.copy,
      })
      .from(routeNodes)
      .where(or(isNotNull(routeNodes.styles), isNotNull(routeNodes.motion), isNotNull(routeNodes.copy)));
    return Object.fromEntries(rows.map(({ ownerKey, ...rest }) => [ownerKey, rest]));
  },
  ["route-presentations"],
  { tags: [TAGS.routes], revalidate: 3600 },
);
