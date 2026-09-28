import "server-only";

import { inArray, sql, type AnyColumn, type SQL } from "drizzle-orm";

import type { Executor } from "@/lib/db/revision";
import { pageSections, reusableComponents } from "@/lib/db/schema";

import { validateBlockValues } from "../validate";
import { kindDef } from "./kinds";
import { readReuse, slotDef, type ComponentSource, type ReuseMap } from "./reference";

/**
 * Reading components for the code that draws and checks references — the
 * server half of `reference.ts` (Batch 17).
 *
 * Two jobs, both small, both used from several places: load the components a
 * set of sections refer to, in the scope a render asks for; and check, inside
 * a writer's own transaction, that the references it is about to store or
 * publish point at something real.
 */

type Values = Record<string, unknown>;
export type ComponentRow = typeof reusableComponents.$inferSelect;

/**
 * A component's stored values, rebuilt through its kind's validator on the way
 * out as well as on the way in — a row edited by hand, or written by a build
 * whose kind declared a field this one does not, still reaches a renderer only
 * as values this build would have accepted. `null` for no values, or a kind
 * this build does not know.
 */
export function componentValues(kind: string, stored: unknown): Values | null {
  const entry = kindDef(kind);
  if (!entry || stored === null || stored === undefined) return null;
  return validateBlockValues(entry.definition, stored);
}

/**
 * The components a render needs, in the scope it needs them.
 *
 * `draftOf` is the one component whose *draft* is drawn — a component's own
 * preview. Everything else, always, is published: the public site, a page's
 * preview and the editor's canvas all show linked content as it is live, so a
 * pending component edit never leaks into a page preview.
 */
export async function loadComponentSources(
  on: Executor,
  ids: readonly number[],
  options: { draftOf?: number } = {},
): Promise<Map<number, ComponentSource & { name: string; status: string }>> {
  const unique = [...new Set(ids.filter((id) => Number.isInteger(id) && id > 0))];
  const out = new Map<number, ComponentSource & { name: string; status: string }>();
  if (!unique.length) return out;
  const rows = await on
    .select({
      id: reusableComponents.id,
      kind: reusableComponents.kind,
      name: reusableComponents.name,
      status: reusableComponents.status,
      published: reusableComponents.published,
      draft: reusableComponents.draft,
      publishedVersion: reusableComponents.publishedVersion,
    })
    .from(reusableComponents)
    .where(inArray(reusableComponents.id, unique));
  for (const row of rows) {
    const previewing = options.draftOf === row.id && row.draft !== null;
    out.set(row.id, {
      id: row.id,
      kind: row.kind,
      name: row.name,
      status: row.status,
      values: componentValues(row.kind, previewing ? row.draft : row.published),
      version: row.publishedVersion,
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Checking references inside a writer's transaction                          */
/* -------------------------------------------------------------------------- */

export type ReferenceProblem = {
  componentId: number;
  slot: string;
  reason: "missing" | "kind" | "unpublished" | "archived";
  name: string | null;
};

/**
 * Takes the components a write depends on `FOR SHARE`, so a concurrent delete
 * cannot remove one between the check and the commit: the delete takes the row
 * `FOR UPDATE`, waits for this transaction, and then finds the reference this
 * one wrote and refuses. The other order is safe too — the delete commits
 * first and this finds no row.
 */
export async function lockComponents(on: Executor, ids: readonly number[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map<number, Pick<ComponentRow, "id" | "kind" | "name" | "status" | "publishedVersion">>();
  const rows = await on
    .select({
      id: reusableComponents.id,
      kind: reusableComponents.kind,
      name: reusableComponents.name,
      status: reusableComponents.status,
      publishedVersion: reusableComponents.publishedVersion,
    })
    .from(reusableComponents)
    .where(inArray(reusableComponents.id, unique))
    .orderBy(reusableComponents.id)
    .for("share");
  return new Map(rows.map((row) => [row.id, row]));
}

/** One existing reference, as the pair an archived component may stay in. */
const heldKey = (slot: string, componentId: number) => `${slot}:${componentId}`;

/**
 * What a section save may store — checked against the database, never against
 * what the browser claims.
 *
 * The browser names a component id and a slot; the kind, the status and
 * whether it was ever published are read here. A reference must point at a
 * component that exists, whose kind fits the slot, and which has been
 * published — a page must never be linked to content no visitor could be
 * shown.
 *
 * An archived component is accepted only in a slot that already refers to it
 * — in this section's published content or its draft, the same slot and the
 * same component. Archiving stops new links, and must not stop an editor from
 * saving a section that was linked before; but the same section is no
 * exception to "new": the component may not be linked into a second slot of
 * it, nor moved from one slot to another.
 */
export async function checkReferencesForSave(
  on: Executor,
  input: { blockType: string; map: ReuseMap; stored: readonly unknown[] },
): Promise<ReferenceProblem[]> {
  const slots = Object.entries(input.map);
  if (!slots.length) return [];
  const held = new Set<string>();
  for (const values of input.stored) {
    for (const [slot, entry] of Object.entries(readReuse(values, input.blockType))) held.add(heldKey(slot, entry.c));
  }
  const found = await lockComponents(
    on,
    slots.map(([, entry]) => entry.c),
  );
  const problems: ReferenceProblem[] = [];
  for (const [slot, entry] of slots) {
    const row = found.get(entry.c);
    const expected = slotDef(input.blockType, slot)?.kind ?? null;
    if (!row) problems.push({ componentId: entry.c, slot, reason: "missing", name: null });
    else if (row.kind !== expected) problems.push({ componentId: entry.c, slot, reason: "kind", name: row.name });
    else if (row.publishedVersion < 1) problems.push({ componentId: entry.c, slot, reason: "unpublished", name: row.name });
    else if (row.status === "archived" && !held.has(heldKey(slot, entry.c))) {
      problems.push({ componentId: entry.c, slot, reason: "archived", name: row.name });
    }
  }
  return problems;
}

/**
 * What a publication may put live — checked the same way, inside the
 * publishing transaction.
 *
 * Existing, fitting and published. Archived is fine here: a section linked
 * before the component was archived keeps rendering it, and publishing that
 * section's other changes must not be refused for it.
 */
export async function checkReferencesForPublish(
  on: Executor,
  items: readonly { blockType: string; values: unknown }[],
): Promise<ReferenceProblem[]> {
  const wanted: { blockType: string; slot: string; id: number }[] = [];
  for (const item of items) {
    for (const [slot, entry] of Object.entries(readReuse(item.values, item.blockType))) {
      wanted.push({ blockType: item.blockType, slot, id: entry.c });
    }
  }
  if (!wanted.length) return [];
  const found = await lockComponents(
    on,
    wanted.map((entry) => entry.id),
  );
  const problems: ReferenceProblem[] = [];
  for (const entry of wanted) {
    const row = found.get(entry.id);
    const expected = slotDef(entry.blockType, entry.slot)?.kind ?? null;
    if (!row) problems.push({ componentId: entry.id, slot: entry.slot, reason: "missing", name: null });
    else if (row.kind !== expected) problems.push({ componentId: entry.id, slot: entry.slot, reason: "kind", name: row.name });
    else if (row.publishedVersion < 1) {
      problems.push({ componentId: entry.id, slot: entry.slot, reason: "unpublished", name: row.name });
    }
  }
  return problems;
}

/** One sentence for the first problem — what an editor reads. */
export function referenceProblemMessage(problem: ReferenceProblem): string {
  const named = problem.name ? `“${problem.name}”` : `reusable component #${problem.componentId}`;
  switch (problem.reason) {
    case "missing":
      return `The reusable component this section is linked to no longer exists. Detach the section to keep its content.`;
    case "kind":
      return `${named} is not the right kind of reusable component for that part of the section.`;
    case "unpublished":
      return `${named} has not been published yet, so nothing can be linked to it. Publish the component first.`;
    case "archived":
      return `${named} is archived, so it cannot be linked to anything new.`;
  }
}

/* -------------------------------------------------------------------------- */
/* Usage, as SQL                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The section rows carrying any reference — written exactly as the partial
 * index `page_sections_reuse_idx` is, so the planner can use it.
 */
export const HAS_REFERENCE: SQL = sql`((${pageSections.published} ? '_reuse') OR (${pageSections.draft} ? '_reuse'))`;

/** A jsonb document that refers to component `id` in any slot. */
export const refersTo = (column: AnyColumn | SQL, id: number): SQL =>
  sql`coalesce(jsonb_path_exists(${column}, '$._reuse.* ? (@.c == $c)', jsonb_build_object('c', ${id}::int)), false)`;
