import "server-only";

import { and, asc, count, desc, eq, inArray, notInArray } from "drizzle-orm";

import { readMotionDocument, type MotionDocument } from "@/lib/cms/motion-doc";
import { validateStyleDocument, type StyleDocument } from "@/lib/cms/styles";
import { db } from "@/lib/db";
import type { Executor } from "@/lib/db/revision";
import { routeNodes, routeVersions } from "@/lib/db/schema";
import { motionForBlock } from "@/lib/visual-editor/motion-targets";

import { existingMedia } from "./category";
import { RECORD_OWNERS, type RouteData } from "./adapter";
import { describeValue, readRouteContext, type RouteContext } from "./drafts";
import { ownerKeyOf, parseOwnerKey, type RouteOwner } from "./owners";
import {
  applyOrder,
  blockTypeOf,
  conflictsOf,
  domainPermissionOf,
  mediaIdsOfPatches,
  publishedValue,
  sameStored,
  SPECS,
  storedProblem,
  type FieldSpec,
  type StoredPatch,
} from "./specs";
import { publishedOf, writeNodeGuarded, type NodeRow } from "./store";
import {
  KEEP_ROUTE_VERSIONS,
  type RouteChangeView,
  type RouteCompareView,
  type RouteHistoryView,
  type RouteSummaryView,
} from "./views";

/**
 * Publishing a dynamic route's drafts — and throwing them away, and bringing
 * an earlier publication back as a draft (Batch 21; every route kind since
 * Batch 22, through its adapter).
 *
 * The page CMS has `publish-service.ts`; this is its twin for dynamic routes,
 * and it holds the same three properties for the same reasons:
 *
 * **It is atomic.** One transaction locks the route's records and every
 * stored region, checks everything, writes everything and records the
 * version. A route is published entirely or not at all.
 *
 * **It is guarded twice.** The publisher names the drafts they reviewed (the
 * summary's token); drafts that moved since are refused rather than published
 * unseen. And every patched field names the live value its draft began from;
 * a field somebody changed in an admin form — or on another route — since is
 * a conflict, and **one conflict refuses the whole publication**: nothing is
 * written.
 *
 * **It writes only what was changed.** A publication updates the patched
 * columns of the patched rows and nothing else, so a form edit to any other
 * column survives it.
 */

/** The authority a caller holds, asked about one resource capability at a time. */
export type Allowed = (permission: "services.manage" | "faqs.manage") => boolean;

export type Actor = { id: number | null; name: string };

/* -------------------------------------------------------------------------- */
/* What is waiting                                                            */
/* -------------------------------------------------------------------------- */

const pendingStyle = (node: NodeRow | undefined) => node?.draftStyles != null;
const pendingMotion = (node: NodeRow | undefined) => node?.draftMotion != null;

/** The owners with anything unpublished, in page order. */
function pendingOwners(context: RouteContext): RouteOwner[] {
  return context.owners.filter((owner) => {
    const key = ownerKeyOf(owner);
    const node = context.nodes.get(key);
    return context.patches.has(key) || pendingStyle(node) || pendingMotion(node);
  });
}

/** The drafts a summary describes: `owner@revision`, sorted. */
export function tokenOf(context: RouteContext): string {
  return pendingOwners(context)
    .map((owner) => `${ownerKeyOf(owner)}@${context.nodes.get(ownerKeyOf(owner))?.revision ?? 0}`)
    .sort()
    .join(",");
}

const specFor = (owner: RouteOwner, key: string): FieldSpec | undefined =>
  SPECS[owner.type].find((spec) => spec.key === key);

export function summarize(context: RouteContext): RouteSummaryView {
  const owners = pendingOwners(context).map((owner) => {
    const key = ownerKeyOf(owner);
    const node = context.nodes.get(key);
    const patch = context.patches.get(key) ?? {};
    const live = context.live.get(key) ?? {};
    return {
      ownerKey: key,
      label: context.adapter.label(owner, context.effective),
      fields: Object.keys(patch).map((field) => specFor(owner, field)?.label ?? field),
      style: pendingStyle(node),
      motion: pendingMotion(node),
      conflicts: conflictsOf(owner, patch, live).map((conflict) => conflict.label),
    };
  });
  const contentChanges = owners.reduce((sum, owner) => sum + owner.fields.length, 0);
  const conflicts = owners.reduce((sum, owner) => sum + owner.conflicts.length, 0);
  const drafts = owners.length;
  return {
    routeKey: context.routeKey,
    kind: context.document.kind,
    title: context.adapter.title(context.data),
    path: context.adapter.path(context.data),
    isPublished: context.adapter.published(context.data),
    token: tokenOf(context),
    owners,
    contentChanges,
    styleDrafts: owners.filter((owner) => owner.style).length,
    motionDrafts: owners.filter((owner) => owner.motion).length,
    conflicts,
    publishable: drafts > 0 && conflicts === 0,
    discardable: drafts > 0,
  };
}

export async function routeSummary(routeKey: string): Promise<RouteSummaryView | null> {
  const context = await readRouteContext(db, routeKey);
  return context ? summarize(context) : null;
}

/* -------------------------------------------------------------------------- */
/* Snapshots                                                                  */
/* -------------------------------------------------------------------------- */

type OwnerSnapshot = {
  label: string;
  fields: Record<string, unknown>;
  styles: StyleDocument;
  motion: MotionDocument | null;
};

export type RouteSnapshot = { v: 1; title: string; owners: Record<string, OwnerSnapshot> };

/**
 * The published state of every region of a route, for a version row. A list
 * is recorded as it is published — without the rows that say nothing — so a
 * version and the live row it describes always agree.
 */
function snapshotOf(
  context: RouteContext,
  data: RouteData,
  presentation: (ownerKey: string) => { styles: StyleDocument; motion: MotionDocument | null; copy: Record<string, string> },
): RouteSnapshot {
  const out: Record<string, OwnerSnapshot> = {};
  for (const owner of context.owners) {
    const key = ownerKeyOf(owner);
    const shown = presentation(key);
    const stored = context.adapter.storedValues(owner, data, shown.copy);
    const fields: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(stored)) fields[field] = publishedValue(specFor(owner, field), value);
    out[key] = {
      label: context.adapter.label(owner, data),
      fields,
      styles: shown.styles,
      motion: shown.motion,
    };
  }
  return { v: 1, title: context.adapter.title(data), owners: out };
}

/** A version row's snapshot, read strictly: anything else is not one. */
function readSnapshot(raw: unknown): RouteSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Partial<RouteSnapshot>;
  if (value.v !== 1 || typeof value.owners !== "object" || value.owners === null) return null;
  return value as RouteSnapshot;
}

/** One stored field change, as a version row keeps it. */
type StoredChange = {
  owner: string;
  ownerLabel: string;
  key: string;
  label: string;
  before: unknown;
  after: unknown;
};

/** Every field, style and motion difference between two snapshots. */
function diffSnapshots(before: RouteSnapshot, after: RouteSnapshot): StoredChange[] {
  const out: StoredChange[] = [];
  const keys = [...new Set([...Object.keys(before.owners), ...Object.keys(after.owners)])];
  for (const ownerKey of keys) {
    const owner = parseOwnerKey(ownerKey);
    const was = before.owners[ownerKey];
    const now = after.owners[ownerKey];
    if (!owner || !was || !now) continue;
    for (const field of [...new Set([...Object.keys(was.fields), ...Object.keys(now.fields)])]) {
      if (sameStored(was.fields[field], now.fields[field])) continue;
      out.push({
        owner: ownerKey,
        ownerLabel: now.label,
        key: field,
        label: specFor(owner, field)?.label ?? field,
        before: was.fields[field] ?? null,
        after: now.fields[field] ?? null,
      });
    }
    if (!sameStored(was.styles, now.styles)) {
      out.push({ owner: ownerKey, ownerLabel: now.label, key: "styles", label: "Style", before: null, after: null });
    }
    if (!sameStored(was.motion, now.motion)) {
      out.push({ owner: ownerKey, ownerLabel: now.label, key: "motion", label: "Motion", before: null, after: null });
    }
  }
  return out;
}

const liveSnapshot = (context: RouteContext): RouteSnapshot =>
  snapshotOf(context, context.data, (key) => publishedOf(context.nodes.get(key)));

/* -------------------------------------------------------------------------- */
/* Publish                                                                    */
/* -------------------------------------------------------------------------- */

export type RouteOutcome =
  | { ok: true; message: string; changes: number; resources: string[] }
  | {
      ok: false;
      reason: "missing" | "stale" | "conflict" | "invalid" | "denied" | "nothing" | "blocked";
      message: string;
      details?: string[];
    };

const STALE =
  "This page's drafts changed since you reviewed them — somebody else saved in the meantime. " +
  "Nothing was published. Review the changes again.";

/** Thrown inside a transaction to roll it back with an answer. */
class Refusal extends Error {
  constructor(readonly outcome: Extract<RouteOutcome, { ok: false }>) {
    super(outcome.message);
  }
}

/** The patches of a route, with their owners. */
const ownedPatches = (context: RouteContext): [RouteOwner, StoredPatch][] =>
  [...context.patches]
    .map(([key, patch]) => [parseOwnerKey(key), patch] as const)
    .filter((entry): entry is [RouteOwner, StoredPatch] => entry[0] !== null);

export async function publishRoute(input: {
  routeKey: string;
  token: string;
  actor: Actor;
  allowed: Allowed;
}): Promise<RouteOutcome> {
  try {
    return await db.transaction(async (tx) => {
      const context = await readRouteContext(tx, input.routeKey, { lock: true });
      if (!context) throw new Refusal({ ok: false, reason: "missing", message: "That page no longer exists." });

      const pending = pendingOwners(context);
      if (!pending.length) {
        throw new Refusal({ ok: false, reason: "nothing", message: "There is nothing to publish on this page." });
      }
      if (tokenOf(context) !== input.token) throw new Refusal({ ok: false, reason: "stale", message: STALE });

      // Conflicts: every patched field against its live value. One is enough.
      const conflicts: string[] = [];
      for (const owner of pending) {
        const key = ownerKeyOf(owner);
        for (const conflict of conflictsOf(owner, context.patches.get(key) ?? {}, context.live.get(key) ?? {})) {
          conflicts.push(`${context.adapter.label(owner, context.data)} — ${conflict.label}`);
        }
      }
      if (conflicts.length) {
        throw new Refusal({
          ok: false,
          reason: "conflict",
          message:
            "Some fields were changed outside the Visual Editor since these drafts began. Nothing was published. " +
            "Resolve each one — keep your draft or use the live value — and publish again.",
          details: conflicts,
        });
      }

      // Authority over every resource the content drafts touch.
      for (const owner of pending) {
        if (!context.patches.has(ownerKeyOf(owner))) continue;
        const permission = domainPermissionOf(owner.type);
        if (!input.allowed(permission)) {
          throw new Refusal({
            ok: false,
            reason: "denied",
            message:
              permission === "faqs.manage"
                ? "Publishing these changes needs permission to manage FAQs. Nothing was published."
                : "Publishing these changes needs permission to manage services. Nothing was published.",
          });
        }
      }

      // Every value, checked again.
      const mediaIds = await existingMedia(tx, mediaIdsOfPatches(ownedPatches(context)));
      const groupIds = context.adapter.groupIds(context.data);
      for (const owner of pending) {
        const patch = context.patches.get(ownerKeyOf(owner)) ?? {};
        for (const [key, entry] of Object.entries(patch)) {
          const spec = specFor(owner, key);
          const problem = spec ? storedProblem(spec, entry.value, groupIds, mediaIds) : "Unknown field.";
          if (problem) {
            throw new Refusal({
              ok: false,
              reason: "invalid",
              message: `${context.adapter.label(owner, context.data)}: ${problem} Nothing was published.`,
            });
          }
        }
      }

      const before = liveSnapshot(context);
      await context.adapter.apply(tx, context);
      const presentation = await promotePresentation(tx, context, pending, input.actor.id);

      const after = snapshotOf(context, context.effective, (key) => presentation.get(key) ?? publishedOf(context.nodes.get(key)));
      const changes = diffSnapshots(before, after);
      const resources = [...new Set(changes.map((change) => change.ownerLabel))];

      // A route's first publication records where it started from.
      const [{ value: existing } = { value: 0 }] = await tx
        .select({ value: count() })
        .from(routeVersions)
        .where(eq(routeVersions.routeKey, input.routeKey));
      if (!existing) {
        await tx.insert(routeVersions).values({
          routeKey: input.routeKey,
          kind: "baseline",
          summary: "Before the first Visual Editor publication",
          snapshot: before,
          changes: [],
          createdBy: input.actor.id,
          actorName: input.actor.name.slice(0, 120),
        });
      }
      await tx.insert(routeVersions).values({
        routeKey: input.routeKey,
        kind: "publish",
        summary: `Published ${changes.length} change${changes.length === 1 ? "" : "s"} to ${resources.length} region${resources.length === 1 ? "" : "s"}`,
        snapshot: after,
        changes,
        createdBy: input.actor.id,
        actorName: input.actor.name.slice(0, 120),
      });
      await pruneVersions(tx, input.routeKey);
      await removeOrphans(tx, context);

      return {
        ok: true as const,
        message: `Published ${changes.length} change${changes.length === 1 ? "" : "s"}.`,
        changes: changes.length,
        resources,
      };
    });
  } catch (error) {
    if (error instanceof Refusal) return error.outcome;
    throw error;
  }
}

/**
 * Pending styles, motion and template copy become published; every draft
 * column of a published region is cleared and its revision moves. The rows
 * are held by the transaction, so the guarded write cannot miss.
 */
async function promotePresentation(
  tx: Executor,
  context: RouteContext,
  pending: RouteOwner[],
  actorId: number | null,
): Promise<Map<string, { styles: StyleDocument; motion: MotionDocument | null; copy: Record<string, string> }>> {
  const out = new Map<string, { styles: StyleDocument; motion: MotionDocument | null; copy: Record<string, string> }>();
  for (const owner of pending) {
    const key = ownerKeyOf(owner);
    const node = context.nodes.get(key);
    const published = publishedOf(node);
    const copy = { ...published.copy };
    for (const [field, entry] of Object.entries(context.patches.get(key) ?? {})) {
      if (!field.startsWith("copy:")) continue;
      const name = field.slice(5);
      if (typeof entry.value === "string" && entry.value) copy[name] = entry.value;
      else delete copy[name];
    }
    const styles = node?.draftStyles != null ? validateStyleDocument(node.draftStyles) : published.styles;
    const motion =
      node?.draftMotion != null
        ? motionForBlock(readMotionDocument(node.draftMotion) ?? undefined, blockTypeOf(owner))
        : published.motion;

    const written = await writeNodeGuarded(tx, {
      ownerKey: key,
      routeKey: context.routeKey,
      expected: node?.revision ?? 0,
      actorId,
      values: {
        styles: styles as unknown as Record<string, unknown>,
        motion: motion as unknown as Record<string, unknown> | null,
        copy: Object.keys(copy).length ? copy : null,
        draftContent: null,
        draftStyles: null,
        draftMotion: null,
      },
    });
    if (!written.ok) throw new Refusal({ ok: false, reason: "stale", message: STALE });
    out.set(key, { styles, motion, copy });
  }
  return out;
}

/** The newest `KEEP_ROUTE_VERSIONS` publications of a route, plus its baseline. */
async function pruneVersions(tx: Executor, routeKey: string): Promise<void> {
  const kept = await tx
    .select({ id: routeVersions.id })
    .from(routeVersions)
    .where(and(eq(routeVersions.routeKey, routeKey), eq(routeVersions.kind, "publish")))
    .orderBy(desc(routeVersions.createdAt), desc(routeVersions.id))
    .limit(KEEP_ROUTE_VERSIONS);
  if (kept.length < KEEP_ROUTE_VERSIONS) return;
  await tx
    .delete(routeVersions)
    .where(
      and(
        eq(routeVersions.routeKey, routeKey),
        eq(routeVersions.kind, "publish"),
        notInArray(
          routeVersions.id,
          kept.map((row) => row.id),
        ),
      ),
    );
}

/**
 * Stored regions this route edited whose record has since been deleted in an
 * admin form. They are never loaded and never published; this is where they
 * go. A region whose record still exists — a card moved to another category,
 * a question moved to another service — is somebody else's and is left alone.
 */
async function removeOrphans(tx: Executor, context: RouteContext): Promise<void> {
  const known = new Set(context.owners.map(ownerKeyOf));
  const rows = await tx
    .select({ ownerKey: routeNodes.ownerKey })
    .from(routeNodes)
    .where(eq(routeNodes.routeKey, context.routeKey));
  const candidates = rows.map((row) => row.ownerKey).filter((key) => !known.has(key));
  if (!candidates.length) return;

  const recordTypes = RECORD_OWNERS[context.document.kind];
  const owners = candidates.map(parseOwnerKey).filter((owner): owner is RouteOwner => owner !== null);
  const exists = await context.adapter.existing(
    tx,
    owners.filter((owner) => recordTypes.includes(owner.type)),
  );

  const orphans = candidates.filter((key) => {
    const owner = parseOwnerKey(key);
    return !owner || (recordTypes.includes(owner.type) && !exists.has(key));
  });
  if (orphans.length) await tx.delete(routeNodes).where(inArray(routeNodes.ownerKey, orphans));
}

/* -------------------------------------------------------------------------- */
/* Discard                                                                    */
/* -------------------------------------------------------------------------- */

/** Throws away exactly the drafts that were reviewed. Published values are untouched. */
export async function discardRoute(input: {
  routeKey: string;
  token: string;
  actor: Actor;
  allowed: Allowed;
}): Promise<RouteOutcome> {
  try {
    return await db.transaction(async (tx) => {
      const context = await readRouteContext(tx, input.routeKey, { lock: true });
      if (!context) throw new Refusal({ ok: false, reason: "missing", message: "That page no longer exists." });
      const pending = pendingOwners(context);
      if (!pending.length) {
        throw new Refusal({ ok: false, reason: "nothing", message: "There is nothing to discard on this page." });
      }
      if (tokenOf(context) !== input.token) {
        throw new Refusal({
          ok: false,
          reason: "stale",
          message: "This page's drafts changed since you reviewed them. Nothing was discarded. Review them again.",
        });
      }
      for (const owner of pending) {
        if (!context.patches.has(ownerKeyOf(owner))) continue;
        if (!input.allowed(domainPermissionOf(owner.type))) {
          throw new Refusal({
            ok: false,
            reason: "denied",
            message: "Discarding these changes needs permission to manage the records they change. Nothing was discarded.",
          });
        }
      }
      for (const owner of pending) {
        const key = ownerKeyOf(owner);
        const node = context.nodes.get(key);
        if (!node) continue;
        const written = await writeNodeGuarded(tx, {
          ownerKey: key,
          routeKey: context.routeKey,
          expected: node.revision,
          actorId: input.actor.id,
          values: { draftContent: null, draftStyles: null, draftMotion: null },
        });
        if (!written.ok) throw new Refusal({ ok: false, reason: "stale", message: STALE });
      }
      await removeOrphans(tx, context);
      return {
        ok: true as const,
        message: `Discarded the drafts of ${pending.length} region${pending.length === 1 ? "" : "s"}.`,
        changes: pending.length,
        resources: pending.map((owner) => context.adapter.label(owner, context.data)),
      };
    });
  } catch (error) {
    if (error instanceof Refusal) return error.outcome;
    throw error;
  }
}

/* -------------------------------------------------------------------------- */
/* History, Compare, Restore                                                  */
/* -------------------------------------------------------------------------- */

const readChanges = (raw: unknown): StoredChange[] =>
  Array.isArray(raw)
    ? (raw as StoredChange[]).filter((entry) => entry && typeof entry === "object" && typeof entry.owner === "string")
    : [];

export async function routeHistory(routeKey: string): Promise<RouteHistoryView> {
  const rows = await db
    .select({
      id: routeVersions.id,
      kind: routeVersions.kind,
      summary: routeVersions.summary,
      actorName: routeVersions.actorName,
      createdAt: routeVersions.createdAt,
      changes: routeVersions.changes,
    })
    .from(routeVersions)
    .where(eq(routeVersions.routeKey, routeKey))
    .orderBy(desc(routeVersions.createdAt), desc(routeVersions.id))
    .limit(KEEP_ROUTE_VERSIONS + 1);
  return {
    routeKey,
    keep: KEEP_ROUTE_VERSIONS,
    versions: rows.map((row) => {
      const changes = readChanges(row.changes);
      return {
        id: row.id,
        kind: row.kind === "baseline" ? "baseline" : "publish",
        summary: row.summary,
        actorName: row.actorName,
        createdAt: row.createdAt.toISOString(),
        changeCount: changes.length,
        resources: [...new Set(changes.map((change) => change.ownerLabel))],
      };
    }),
  };
}

const viewOf = (context: RouteContext, change: StoredChange): RouteChangeView => {
  const owner = parseOwnerKey(change.owner);
  const spec = owner ? specFor(owner, change.key) : undefined;
  const words = (value: unknown) =>
    change.key === "styles" || change.key === "motion" ? "" : describeValue(context, spec, value);
  return { owner: change.ownerLabel, field: change.label, before: words(change.before), after: words(change.after) };
};

/**
 * What a version changed (`previous`), or how it differs from the page as it
 * is live now (`live`). Read only: nothing is restored, nothing is written.
 */
export async function compareRouteVersion(
  routeKey: string,
  versionId: number,
  against: "previous" | "live",
): Promise<RouteCompareView | null> {
  const [row] = await db
    .select()
    .from(routeVersions)
    .where(and(eq(routeVersions.id, versionId), eq(routeVersions.routeKey, routeKey)))
    .limit(1);
  if (!row) return null;
  const context = await readRouteContext(db, routeKey);
  if (!context) return null;
  if (against === "previous") {
    return {
      versionId,
      against,
      title: row.summary,
      changes: readChanges(row.changes).map((change) => viewOf(context, change)),
    };
  }
  const snapshot = readSnapshot(row.snapshot);
  if (!snapshot) return null;
  return {
    versionId,
    against,
    title: row.summary,
    changes: diffSnapshots(snapshot, liveSnapshot(context)).map((change) => viewOf(context, change)),
  };
}

/**
 * Brings a version back **as a draft**. Never writes live.
 *
 * Refused while the route has drafts of its own — restoring over them would
 * silently replace somebody's pending work. Otherwise every value of the
 * version that differs from live becomes a patch based on the live value, its
 * styles and motion become drafts where they differ, and the editor reviews and
 * publishes the result like any other draft. A region the version knew that no
 * longer exists is skipped and said so; a value that can no longer be stored —
 * a picture since deleted — is skipped too.
 */
export async function restoreRouteVersion(input: {
  routeKey: string;
  versionId: number;
  actor: Actor;
  allowed: Allowed;
}): Promise<RouteOutcome> {
  try {
    return await db.transaction(async (tx) => {
      const context = await readRouteContext(tx, input.routeKey, { lock: true });
      if (!context) throw new Refusal({ ok: false, reason: "missing", message: "That page no longer exists." });
      if (pendingOwners(context).length) {
        throw new Refusal({
          ok: false,
          reason: "blocked",
          message: "This page has unpublished changes. Publish or discard them before restoring a version.",
        });
      }
      const [row] = await tx
        .select()
        .from(routeVersions)
        .where(and(eq(routeVersions.id, input.versionId), eq(routeVersions.routeKey, input.routeKey)))
        .limit(1);
      const snapshot = row ? readSnapshot(row.snapshot) : null;
      if (!snapshot) throw new Refusal({ ok: false, reason: "missing", message: "That version is not available." });

      const wantedMedia: number[] = [];
      for (const owned of Object.values(snapshot.owners)) {
        for (const value of Object.values(owned.fields)) if (typeof value === "number") wantedMedia.push(value);
      }
      const mediaIds = await existingMedia(tx, wantedMedia);
      const groupIds = context.adapter.groupIds(context.data);

      let restored = 0;
      const skipped: string[] = [];
      for (const [ownerKey, owned] of Object.entries(snapshot.owners)) {
        const owner = context.owners.find((candidate) => ownerKeyOf(candidate) === ownerKey);
        if (!owner) {
          skipped.push(owned.label);
          continue;
        }
        const live = context.live.get(ownerKey) ?? {};
        const node = context.nodes.get(ownerKey);
        const published = publishedOf(node);
        const patch: StoredPatch = {};
        for (const spec of SPECS[owner.type]) {
          if (!(spec.key in owned.fields)) continue;
          let value = owned.fields[spec.key];
          if (spec.check === "order") value = applyOrder(value, context.adapter.members(owner, spec.list, context.data));
          if (sameStored(value, live[spec.key])) continue;
          if (storedProblem(spec, value, groupIds, mediaIds)) {
            skipped.push(`${owned.label} — ${spec.label}`);
            continue;
          }
          patch[spec.key] = { value, base: live[spec.key] };
        }
        const styles = sameStored(owned.styles, published.styles) ? null : validateStyleDocument(owned.styles);
        const motion = sameStored(owned.motion, published.motion)
          ? null
          : motionForBlock(owned.motion ?? undefined, blockTypeOf(owner));
        if (!Object.keys(patch).length && !styles && !motion) continue;
        if (Object.keys(patch).length && !input.allowed(domainPermissionOf(owner.type))) {
          throw new Refusal({
            ok: false,
            reason: "denied",
            message: "Restoring this version needs permission to manage the records it changes. Nothing was restored.",
          });
        }
        const written = await writeNodeGuarded(tx, {
          ownerKey,
          routeKey: context.routeKey,
          expected: node?.revision ?? 0,
          actorId: input.actor.id,
          values: {
            draftContent: Object.keys(patch).length ? patch : null,
            draftStyles: styles as unknown as Record<string, unknown> | null,
            draftMotion: motion as unknown as Record<string, unknown> | null,
          },
        });
        if (!written.ok) throw new Refusal({ ok: false, reason: "stale", message: STALE });
        restored += 1;
      }

      return {
        ok: true as const,
        message: restored
          ? `The version is now a draft on ${restored} region${restored === 1 ? "" : "s"}. Review it, then publish.`
          : "That version is the same as the live page. Nothing to restore.",
        changes: restored,
        resources: skipped,
      };
    });
  } catch (error) {
    if (error instanceof Refusal) return error.outcome;
    throw error;
  }
}

/** The version a compare pane draws: its snapshot, read strictly, if it belongs to this route. */
export async function readRouteVersion(routeKey: string, versionId: number): Promise<RouteSnapshot | null> {
  if (!Number.isInteger(versionId) || versionId <= 0) return null;
  const [row] = await db
    .select({ snapshot: routeVersions.snapshot })
    .from(routeVersions)
    .where(and(eq(routeVersions.id, versionId), eq(routeVersions.routeKey, routeKey)))
    .orderBy(asc(routeVersions.id))
    .limit(1);
  return row ? readSnapshot(row.snapshot) : null;
}
