import "server-only";

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import type { Executor } from "@/lib/db/revision";
import { reusableComponentVersions, reusableComponents } from "@/lib/db/schema";

import { isReusableKind } from "./kinds";
import { componentValues, type ComponentRow } from "./store";
import { componentUsage, pageVersionReferences } from "./usage";

/**
 * Reusable components: create, edit, publish, restore, archive, delete (Batch 17).
 *
 * The component's own lifecycle, and deliberately nothing to do with any page.
 * No function here reads or writes a section, a page's revision or a page's
 * history: a component edit is a change to the component, and the pages that
 * link to it follow its published content without being rewritten. That is
 * what lets one publication update every linked page atomically — there is
 * one row to change — and what keeps page revisions and page history about
 * pages.
 *
 * Three rules, the same ones the page CMS keeps:
 *
 *   · **Nothing edits live content.** Edits land in `draft`; only
 *     `publishComponent` changes `published`, in one transaction that also
 *     records what it replaced.
 *   · **Every write names the revision it was built from.** A stale write is
 *     refused, never merged: two people editing one component is resolved by
 *     one of them reloading, not by software guessing at a combination
 *     neither wrote.
 *   · **Values are validated by the kind's declaration**, through the same
 *     `validateBlockValues` a section uses, on the way in and on the way out.
 */

export const KEEP_COMPONENT_VERSIONS = 30;
const MAX_NAME = 120;

export const COMPONENT_MESSAGES = {
  missing: "That reusable component no longer exists.",
  conflict:
    "This component changed since you opened it. Nothing was saved — reload the latest version " +
    "and make the change again.",
  invalidKind: "Choose a kind of reusable component.",
  invalidName: "Give the component a name (up to 120 characters).",
  invalidValues: "Those values could not be read. Reload and try again.",
  nothingToPublish: "There is no draft to publish.",
  nothingToDiscard: "There is no draft to discard.",
  missingVersion: "That version is no longer kept.",
  sameAsLive: "That version is what is published now, so there is nothing to restore.",
  archived: "Archived components cannot be edited. Restore it from the archive first.",
  inUse: (pages: number, instances: number) =>
    `It is still used on ${pages} ${pages === 1 ? "page" : "pages"} (${instances} ` +
    `${instances === 1 ? "instance" : "instances"}). Detach or replace those instances first, or ` +
    "archive the component instead.",
  referenced:
    "A page still refers to it — in a draft, a hidden section or a section waiting to be " +
    "removed. Publish or discard those pages first, or archive the component instead.",
  inHistory: (n: number) =>
    `${n} saved page ${n === 1 ? "version refers" : "versions refer"} to it, and restoring one ` +
    "would need it. Archive it instead.",
} as const;

export type ComponentFailure =
  | "missing"
  | "conflict"
  | "invalid"
  | "nothing"
  | "archived"
  | "in_use";

export type ComponentResult<T = object> =
  | ({ ok: true } & T)
  | { ok: false; reason: ComponentFailure; message: string };

const failure = (reason: ComponentFailure, message: string) => ({ ok: false as const, reason, message });

/** Thrown inside a transaction so the abort rolls everything back by construction. */
class Stop extends Error {
  constructor(
    readonly reason: ComponentFailure,
    readonly userMessage: string,
  ) {
    super(reason);
    this.name = "ComponentStop";
  }
}

/** Keys sorted all the way down, so two equal documents are one string. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, raw) =>
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? Object.fromEntries(Object.keys(raw as object).sort().map((key) => [key, (raw as Record<string, unknown>)[key]]))
      : raw,
  );
}

export const sameContent = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

const cleanName = (raw: unknown): string | null => {
  const name = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
  return name && name.length <= MAX_NAME ? name : null;
};

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

export type ComponentDetail = {
  id: number;
  kind: string;
  name: string;
  status: "active" | "archived";
  revision: number;
  publishedVersion: number;
  published: Record<string, unknown> | null;
  draft: Record<string, unknown> | null;
  hasDraft: boolean;
  publishedAt: Date | null;
  updatedAt: Date;
  createdAt: Date;
};

export function toDetail(row: ComponentRow): ComponentDetail {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    status: row.status === "archived" ? "archived" : "active",
    revision: row.revision,
    publishedVersion: row.publishedVersion,
    published: componentValues(row.kind, row.published),
    draft: componentValues(row.kind, row.draft),
    hasDraft: row.draft !== null,
    publishedAt: row.publishedAt,
    updatedAt: row.updatedAt,
    createdAt: row.createdAt,
  };
}

export async function getComponent(id: number, on: Executor = db): Promise<ComponentDetail | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const [row] = await on.select().from(reusableComponents).where(eq(reusableComponents.id, id)).limit(1);
  return row ? toDetail(row) : null;
}

export async function listComponents(on: Executor = db): Promise<ComponentDetail[]> {
  const rows = await on
    .select()
    .from(reusableComponents)
    .orderBy(asc(reusableComponents.status), asc(reusableComponents.name), asc(reusableComponents.id));
  return rows.map(toDetail);
}

export type ComponentVersionEntry = {
  id: number;
  version: number;
  label: string;
  actorName: string;
  createdAt: Date;
};

/** The history list: newest first, bodies left out — a list does not need them. */
export async function listComponentVersions(id: number, limit = KEEP_COMPONENT_VERSIONS): Promise<ComponentVersionEntry[]> {
  return db
    .select({
      id: reusableComponentVersions.id,
      version: reusableComponentVersions.version,
      label: reusableComponentVersions.label,
      actorName: reusableComponentVersions.actorName,
      createdAt: reusableComponentVersions.createdAt,
    })
    .from(reusableComponentVersions)
    .where(eq(reusableComponentVersions.componentId, id))
    .orderBy(desc(reusableComponentVersions.id))
    .limit(limit);
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

/** The revision-guarded write every mutation goes through. */
async function guarded(
  on: Executor,
  id: number,
  expected: number,
  values: Partial<typeof reusableComponents.$inferInsert>,
): Promise<{ ok: true; row: ComponentRow } | { ok: false; reason: "missing" | "conflict" }> {
  const updated = await on
    .update(reusableComponents)
    .set({ ...values, revision: sql`${reusableComponents.revision} + 1`, updatedAt: new Date() })
    .where(and(eq(reusableComponents.id, id), eq(reusableComponents.revision, expected)))
    .returning();
  if (updated.length) return { ok: true, row: updated[0]! };
  const [row] = await on
    .select({ id: reusableComponents.id })
    .from(reusableComponents)
    .where(eq(reusableComponents.id, id))
    .limit(1);
  return { ok: false, reason: row ? "conflict" : "missing" };
}

const guardFailure = (reason: "missing" | "conflict") =>
  failure(reason, reason === "missing" ? COMPONENT_MESSAGES.missing : COMPONENT_MESSAGES.conflict);

const validRevision = (value: number) => Number.isInteger(value) && value >= 0;

export type Actor = { userId: number | null; actorName: string };

/**
 * A new component.
 *
 * `publish: true` publishes its first version in the same statement — the
 * "Save as reusable" path, where the content is exactly what one section
 * already shows and nothing links to it yet, so publishing it changes nothing
 * any visitor sees. The screen asks for that explicitly; nothing publishes a
 * component by default.
 */
export async function createComponent(input: {
  kind: string;
  name: string;
  values: unknown;
  publish: boolean;
  actor: Actor;
}): Promise<ComponentResult<{ component: ComponentDetail }>> {
  if (!isReusableKind(input.kind)) return failure("invalid", COMPONENT_MESSAGES.invalidKind);
  const name = cleanName(input.name);
  if (!name) return failure("invalid", COMPONENT_MESSAGES.invalidName);
  const values = componentValues(input.kind, input.values ?? {});
  if (!values) return failure("invalid", COMPONENT_MESSAGES.invalidValues);
  const now = new Date();
  const [row] = await db
    .insert(reusableComponents)
    .values({
      kind: input.kind,
      name,
      published: input.publish ? values : null,
      draft: input.publish ? null : values,
      publishedVersion: input.publish ? 1 : 0,
      publishedAt: input.publish ? now : null,
      publishedBy: input.publish ? input.actor.userId : null,
      createdBy: input.actor.userId,
      updatedBy: input.actor.userId,
    })
    .returning();
  return { ok: true, component: toDetail(row!) };
}

/**
 * Saves the component's draft. Never publishes.
 *
 * A draft that says exactly what is published is stored as *no* draft: it is
 * not a pending change, and keeping it would put "Draft pending" on a
 * component nobody changed and arm Publish for nothing.
 */
export async function saveComponentDraft(input: {
  id: number;
  expectedRevision: number;
  values: unknown;
  actor: Actor;
}): Promise<ComponentResult<{ component: ComponentDetail }>> {
  if (!validRevision(input.expectedRevision)) return failure("conflict", COMPONENT_MESSAGES.conflict);
  const current = await getComponent(input.id);
  if (!current) return failure("missing", COMPONENT_MESSAGES.missing);
  if (current.status === "archived") return failure("archived", COMPONENT_MESSAGES.archived);
  const values = componentValues(current.kind, input.values);
  if (!values) return failure("invalid", COMPONENT_MESSAGES.invalidValues);
  const draft = current.published && sameContent(values, current.published) ? null : values;
  const result = await guarded(db, input.id, input.expectedRevision, { draft, updatedBy: input.actor.userId });
  if (!result.ok) return guardFailure(result.reason);
  return { ok: true, component: toDetail(result.row) };
}

/** Throws the draft away. Published content, pages and history are untouched. */
export async function discardComponentDraft(input: {
  id: number;
  expectedRevision: number;
  actor: Actor;
}): Promise<ComponentResult<{ component: ComponentDetail }>> {
  if (!validRevision(input.expectedRevision)) return failure("conflict", COMPONENT_MESSAGES.conflict);
  const current = await getComponent(input.id);
  if (!current) return failure("missing", COMPONENT_MESSAGES.missing);
  if (current.revision !== input.expectedRevision) return failure("conflict", COMPONENT_MESSAGES.conflict);
  if (!current.hasDraft) return failure("nothing", COMPONENT_MESSAGES.nothingToDiscard);
  const result = await guarded(db, input.id, input.expectedRevision, { draft: null, updatedBy: input.actor.userId });
  if (!result.ok) return guardFailure(result.reason);
  return { ok: true, component: toDetail(result.row) };
}

/**
 * Publishes the draft — every linked page shows it from this moment.
 *
 * One transaction: the row is locked, the revision checked, the draft
 * re-validated, the definition it replaces recorded as a version, the draft
 * promoted, the version number and revision advanced, and the history pruned.
 * No page row is read or written, so no page revision moves and no page
 * history entry appears: the pages did not change, the component did. The
 * caller drops the pages cache after the commit.
 */
export async function publishComponent(input: {
  id: number;
  expectedRevision: number;
  actor: Actor;
  label?: string;
}): Promise<ComponentResult<{ component: ComponentDetail; previousVersion: number }>> {
  if (!validRevision(input.expectedRevision)) return failure("conflict", COMPONENT_MESSAGES.conflict);
  try {
    const out = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(reusableComponents)
        .where(eq(reusableComponents.id, input.id))
        .limit(1)
        .for("update");
      if (!row) throw new Stop("missing", COMPONENT_MESSAGES.missing);
      if (row.revision !== input.expectedRevision) throw new Stop("conflict", COMPONENT_MESSAGES.conflict);
      if (row.status === "archived") throw new Stop("archived", COMPONENT_MESSAGES.archived);
      if (row.draft === null) throw new Stop("nothing", COMPONENT_MESSAGES.nothingToPublish);
      const values = componentValues(row.kind, row.draft);
      if (!values) throw new Stop("invalid", COMPONENT_MESSAGES.invalidValues);

      if (row.published !== null && row.publishedVersion > 0) {
        await tx.insert(reusableComponentVersions).values({
          componentId: row.id,
          version: row.publishedVersion,
          values: row.published,
          label: (input.label ?? "Before publishing").slice(0, 120),
          createdBy: input.actor.userId,
          actorName: input.actor.actorName.slice(0, 120),
        });
      }
      const result = await guarded(tx, row.id, row.revision, {
        published: values,
        draft: null,
        publishedVersion: row.publishedVersion + 1,
        publishedAt: new Date(),
        publishedBy: input.actor.userId,
        updatedBy: input.actor.userId,
      });
      if (!result.ok) throw new Stop(result.reason, result.reason === "missing" ? COMPONENT_MESSAGES.missing : COMPONENT_MESSAGES.conflict);
      await pruneVersionsIn(tx, row.id);
      return { component: toDetail(result.row), previousVersion: row.publishedVersion };
    });
    return { ok: true, ...out };
  } catch (error) {
    if (error instanceof Stop) return failure(error.reason, error.userMessage);
    throw error;
  }
}

async function pruneVersionsIn(on: Executor, componentId: number): Promise<void> {
  const rows = await on
    .select({ id: reusableComponentVersions.id })
    .from(reusableComponentVersions)
    .where(eq(reusableComponentVersions.componentId, componentId))
    .orderBy(desc(reusableComponentVersions.id));
  const doomed = rows.slice(KEEP_COMPONENT_VERSIONS).map((row) => row.id);
  if (doomed.length) await on.delete(reusableComponentVersions).where(inArray(reusableComponentVersions.id, doomed));
}

/**
 * Puts an earlier published version back — as the DRAFT.
 *
 * Never live on click: the restored content is reviewed, previewed on the
 * pages that use it and published like any other edit, with the same warning
 * about what it will change.
 */
export async function restoreComponentVersion(input: {
  id: number;
  versionId: number;
  expectedRevision: number;
  actor: Actor;
}): Promise<ComponentResult<{ component: ComponentDetail; version: number }>> {
  if (!validRevision(input.expectedRevision)) return failure("conflict", COMPONENT_MESSAGES.conflict);
  const current = await getComponent(input.id);
  if (!current) return failure("missing", COMPONENT_MESSAGES.missing);
  if (current.status === "archived") return failure("archived", COMPONENT_MESSAGES.archived);
  const [version] = await db
    .select()
    .from(reusableComponentVersions)
    .where(
      and(
        eq(reusableComponentVersions.id, input.versionId),
        // Scoped to this component: a version id from another component is not found.
        eq(reusableComponentVersions.componentId, input.id),
      ),
    )
    .limit(1);
  if (!version) return failure("missing", COMPONENT_MESSAGES.missingVersion);
  const values = componentValues(current.kind, version.values);
  if (!values) return failure("invalid", COMPONENT_MESSAGES.invalidValues);
  if (current.published && sameContent(values, current.published)) {
    return failure("nothing", COMPONENT_MESSAGES.sameAsLive);
  }
  const result = await guarded(db, input.id, input.expectedRevision, { draft: values, updatedBy: input.actor.userId });
  if (!result.ok) return guardFailure(result.reason);
  return { ok: true, component: toDetail(result.row), version: version.version };
}

/** Admin metadata only: the public text is the component's values, never its name. */
export async function renameComponent(input: {
  id: number;
  expectedRevision: number;
  name: string;
  actor: Actor;
}): Promise<ComponentResult<{ component: ComponentDetail }>> {
  if (!validRevision(input.expectedRevision)) return failure("conflict", COMPONENT_MESSAGES.conflict);
  const name = cleanName(input.name);
  if (!name) return failure("invalid", COMPONENT_MESSAGES.invalidName);
  const result = await guarded(db, input.id, input.expectedRevision, { name, updatedBy: input.actor.userId });
  if (!result.ok) return guardFailure(result.reason);
  return { ok: true, component: toDetail(result.row) };
}

/**
 * Archives or restores from the archive.
 *
 * Archiving changes nothing any visitor sees — linked sections keep rendering
 * the published content — and nothing any page holds. It takes the component
 * out of the picker and refuses new links to it.
 */
export async function setComponentArchived(input: {
  id: number;
  expectedRevision: number;
  archived: boolean;
  actor: Actor;
}): Promise<ComponentResult<{ component: ComponentDetail }>> {
  if (!validRevision(input.expectedRevision)) return failure("conflict", COMPONENT_MESSAGES.conflict);
  const result = await guarded(db, input.id, input.expectedRevision, {
    status: input.archived ? "archived" : "active",
    archivedAt: input.archived ? new Date() : null,
    updatedBy: input.actor.userId,
  });
  if (!result.ok) return guardFailure(result.reason);
  return { ok: true, component: toDetail(result.row) };
}

/**
 * Deletes a component nothing refers to — and only that.
 *
 * The usage is re-read **inside** the transaction, after the row is locked
 * `FOR UPDATE`: every path that writes a reference takes the component `FOR
 * SHARE` first, so a link racing this delete either commits before the lock
 * (and is found here, and the delete refused) or waits for it (and then finds
 * no component, and is refused itself). A usage count read on the screen a
 * minute ago decides nothing.
 *
 * "Refers" is wider than "is used": a hidden section, a pending draft, a
 * section waiting to be removed and a retained page version all refer to it,
 * and all of them would need it again.
 */
export async function deleteComponent(input: {
  id: number;
  expectedRevision: number;
}): Promise<ComponentResult<{ kind: string; name: string }>> {
  if (!validRevision(input.expectedRevision)) return failure("conflict", COMPONENT_MESSAGES.conflict);
  try {
    const out = await db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(reusableComponents)
        .where(eq(reusableComponents.id, input.id))
        .limit(1)
        .for("update");
      if (!row) throw new Stop("missing", COMPONENT_MESSAGES.missing);
      if (row.revision !== input.expectedRevision) throw new Stop("conflict", COMPONENT_MESSAGES.conflict);
      const usage = await componentUsage(tx, row.id);
      if (usage.summary.instances) {
        throw new Stop("in_use", COMPONENT_MESSAGES.inUse(usage.summary.pages, usage.summary.instances));
      }
      if (usage.summary.referenced) throw new Stop("in_use", COMPONENT_MESSAGES.referenced);
      const versions = await pageVersionReferences(tx, row.id);
      if (versions) throw new Stop("in_use", COMPONENT_MESSAGES.inHistory(versions));
      await tx.delete(reusableComponents).where(eq(reusableComponents.id, row.id));
      return { kind: row.kind, name: row.name };
    });
    return { ok: true, ...out };
  } catch (error) {
    if (error instanceof Stop) return failure(error.reason, error.userMessage);
    throw error;
  }
}
