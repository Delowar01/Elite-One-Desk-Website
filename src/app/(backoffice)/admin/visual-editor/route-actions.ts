"use server";

import { revalidatePath } from "next/cache";

import { logActivity } from "@/lib/activity";
import { revisionField } from "@/lib/admin/actions";
import { AUTHORITY, DENIED, may } from "@/lib/auth/authority";
import { AccessError, assertAllowed, guardAction } from "@/lib/auth/guard";
import { getSession, type AdminSession } from "@/lib/auth/session";
import { TAGS, revalidate } from "@/lib/cache";
import { emptyMotionDocument, isReadableMotionDocument } from "@/lib/cms/motion-doc";
import { advancedStylesDiffer, validateStyleDocument } from "@/lib/cms/styles";
import { db } from "@/lib/db";
import {
  blockTypeOf,
  changedKeys,
  domainPermissionOf,
  existingMedia,
  mediaIdsIn,
  nextPatch,
  ownerLabel,
  readSubmitted,
  sameStored,
  SPECS,
  type StoredPatch,
} from "@/lib/routes/category";
import { ownerData, ownerIn, readRouteContext, type RouteContext } from "@/lib/routes/drafts";
import {
  documentOfEditorKey,
  ownerKeyOf,
  ownerOfEditorKey,
  routeKeyOf,
  type RouteOwner,
} from "@/lib/routes/owners";
import {
  compareRouteVersion,
  discardRoute,
  publishRoute,
  restoreRouteVersion,
  routeHistory,
  summarize,
  type Allowed,
  type RouteOutcome,
} from "@/lib/routes/publish";
import { draftPresentationOf, writeNodeGuarded } from "@/lib/routes/store";
import type {
  RouteActionResult,
  RouteCompareView,
  RouteHistoryView,
  RouteSummaryView,
} from "@/lib/routes/views";
import type {
  VisualContentSaveResult,
  VisualMotionSaveResult,
  VisualSectionLoad,
  VisualStyleSaveResult,
} from "@/lib/visual-editor/content";
import { motionForBlock } from "@/lib/visual-editor/motion-targets";

/**
 * The Visual Editor's actions for dynamic routes (Batch 21).
 *
 * They answer in exactly the shapes the section actions do — the same load,
 * the same content, style and motion results — so the editor's one autosave
 * queue, one Undo and one conflict card drive a service card the way they
 * drive a section. What differs is underneath: a route region's draft is a
 * row in `route_nodes`, and its content is the category, group, service or
 * question it is bound to.
 *
 * The rules every action here keeps, because a dynamic route is a new door:
 *
 *   · **The session decides, every time.** Each action reads the session and
 *     the CSRF token itself (`guardAction`) and then checks the capability the
 *     specific change needs — `content.edit` for words, `content.structure` for
 *     order and visibility, `content.style`, `content.motion`, `content.publish`
 *     — *and* the resource's own capability: `services.manage` for the
 *     category, its groups, cards and template wording, `faqs.manage` for its
 *     questions. Nothing the editor's buttons decided is trusted.
 *   · **The route names the region, the server checks it belongs.** A save
 *     names a region and the route it is on; a region not drawn on that route
 *     is refused, so one category's canvas can never write another's records.
 *   · **Nothing here writes live content.** Saves write drafts; only
 *     `publishRouteFromEditor` changes what a visitor gets, in one transaction.
 */

const MESSAGES = {
  missing: "That part of the page no longer exists. Reload the canvas.",
  invalid: "Those values could not be read. Reload the canvas and try again.",
  invalidStyles: "Those styles could not be read. Reload the canvas and try again.",
  invalidMotion: "That motion is not one of the available options. Reload the canvas and try again.",
  conflict:
    "This part of the page changed while you were editing it. Reload the latest version before saving, " +
    "or your colleague's work would be overwritten.",
  services: "Your role does not allow changing services and categories. Nothing was saved.",
  faqs: "Your role does not allow changing FAQs. Nothing was saved.",
} as const;

const domainDenied = (permission: "services.manage" | "faqs.manage") =>
  permission === "faqs.manage" ? MESSAGES.faqs : MESSAGES.services;

/** The route context and the region an editor key names, or why not. */
async function resolve(
  sectionId: number,
  pageId: number,
): Promise<
  | { ok: true; context: RouteContext; owner: RouteOwner }
  | { ok: false; reason: "missing" | "wrong_page"; message: string }
> {
  const owner = ownerOfEditorKey(sectionId);
  const document = documentOfEditorKey(pageId);
  if (!owner || !document) return { ok: false, reason: "missing", message: MESSAGES.missing };
  const context = await readRouteContext(db, routeKeyOf(document));
  if (!context) return { ok: false, reason: "missing", message: MESSAGES.missing };
  const found = ownerIn(context, ownerKeyOf(owner));
  if (!found) return { ok: false, reason: "wrong_page", message: MESSAGES.missing };
  return { ok: true, context, owner: found };
}

/** The region as the server holds it now, for a conflict answer. */
async function freshData(sectionId: number, pageId: number) {
  const again = await resolve(sectionId, pageId);
  return again.ok ? ownerData(again.context, again.owner) : null;
}

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One region for the Inspector. `content.view`, as for a section: it returns
 * nothing a person who can open the preview could not read off it.
 */
export async function loadRouteRegion(sectionId: number, pageId: number): Promise<VisualSectionLoad> {
  try {
    const session = await getSession();
    if (!may(session?.permissions, "viewPages")) return { ok: false, reason: "denied", message: DENIED.viewPages };
    const found = await resolve(sectionId, pageId);
    if (!found.ok) return found;
    return { ok: true, section: ownerData(found.context, found.owner) };
  } catch (error) {
    console.error("[visual-editor:route-load]", error);
    return { ok: false, reason: "missing", message: "That part of the page could not be read. Reload the canvas." };
  }
}

/* -------------------------------------------------------------------------- */
/* Content                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The capability a content change needs: `content.edit` for anything typed or
 * chosen, `content.structure` for order, visibility and grouping, and the
 * resource's own capability for either. Checked in that order so the refusal
 * names the first thing missing, in the words the editor already uses.
 */
function assertContentAuthority(session: AdminSession, owner: RouteOwner, structural: boolean, typed: boolean) {
  if (typed) assertAllowed(session, AUTHORITY.editContent, DENIED.editContent);
  if (structural) assertAllowed(session, AUTHORITY.editStructure, DENIED.editStructure);
  const domain = domainPermissionOf(owner.type);
  assertAllowed(session, domain, domainDenied(domain));
}

/**
 * Saves one region's content as a draft. Never publishes.
 *
 * The submitted values are read with the resource's own rules
 * (`readSubmitted`) into stored values, and the draft becomes the difference
 * between those and what is live — each changed field with the live value it
 * started from. A value put back to what is live leaves the draft.
 */
export async function saveRouteRegionDraft(form: FormData): Promise<VisualContentSaveResult> {
  try {
    const session = await guardAction(AUTHORITY.viewPages, form, DENIED.viewPages);
    const sectionId = Number(form.get("sectionId"));
    const pageId = Number(form.get("pageId"));
    const expected = revisionField(form);
    if (!Number.isInteger(expected) || expected < 0) return { ok: false, reason: "invalid", message: MESSAGES.invalid };

    const found = await resolve(sectionId, pageId);
    if (!found.ok) return found;
    const { context, owner } = found;

    let submitted: unknown;
    try {
      submitted = JSON.parse(String(form.get("values") ?? ""));
    } catch {
      return { ok: false, reason: "invalid", message: MESSAGES.invalid };
    }
    if (typeof submitted !== "object" || submitted === null || Array.isArray(submitted)) {
      return { ok: false, reason: "invalid", message: MESSAGES.invalid };
    }
    const values = submitted as Record<string, unknown>;

    const mediaIds = await existingMedia(db, mediaIdsIn(owner, values));
    const read = readSubmitted(owner, values, context.data, mediaIds);
    if (!read.ok) return { ok: false, reason: "invalid", message: read.problem.message };

    const key = ownerKeyOf(owner);
    const live = context.live.get(key) ?? {};
    const previous: StoredPatch = context.patches.get(key) ?? {};
    const patch = nextPatch(owner, previous, live, read.stored, context.effective);
    const changed = changedKeys(owner, previous, live, patch);

    // A save that changes nothing is answered, not written: no revision moves.
    if (!changed.length && sameStored(previous, patch)) {
      return { ok: true, section: ownerData(context, owner) };
    }
    assertContentAuthority(
      session,
      owner,
      changed.some((spec) => spec.structural),
      changed.some((spec) => !spec.structural) || !changed.length,
    );

    const written = await writeNodeGuarded(db, {
      ownerKey: key,
      routeKey: context.routeKey,
      expected,
      actorId: session.user.id,
      values: { draftContent: Object.keys(patch).length ? patch : null },
    });
    if (!written.ok) {
      const latest = await freshData(sectionId, pageId);
      return latest
        ? { ok: false, reason: "conflict", message: MESSAGES.conflict, section: latest }
        : { ok: false, reason: "missing", message: MESSAGES.missing };
    }

    await logActivity(session, {
      action: "route.draft_saved",
      entityType: "category",
      entityId: context.data.category.id,
      summary: `Saved a draft of ${ownerLabel(owner, context.data)} in the Visual Editor`.slice(0, 255),
      metadata: { owner: key, route: context.routeKey, fields: changed.map((spec) => spec.key) },
    });

    const after = await readRouteContext(db, context.routeKey);
    const section = after ? ownerData(after, owner) : null;
    if (!section) return { ok: false, reason: "missing", message: MESSAGES.missing };
    return { ok: true, section };
  } catch (error) {
    if (error instanceof AccessError) return { ok: false, reason: "denied", message: error.message };
    console.error("[visual-editor:route-save]", error);
    return { ok: false, reason: "invalid", message: "Something went wrong. The change was not saved." };
  }
}

/**
 * Settles one field changed outside the Visual Editor since its draft began.
 *
 * `mine` keeps the draft's value and takes the live value as its new starting
 * point — publishing will then replace the form's value, deliberately. `live`
 * drops the draft's value, so the form's stays. Either way it is the editor's
 * explicit choice, guarded on the region's revision like any other write.
 */
export async function resolveRouteConflict(form: FormData): Promise<VisualContentSaveResult> {
  try {
    const session = await guardAction(AUTHORITY.viewPages, form, DENIED.viewPages);
    const sectionId = Number(form.get("sectionId"));
    const pageId = Number(form.get("pageId"));
    const expected = revisionField(form);
    const field = String(form.get("field") ?? "");
    const choice = String(form.get("choice") ?? "");
    if (!Number.isInteger(expected) || expected < 0 || (choice !== "mine" && choice !== "live")) {
      return { ok: false, reason: "invalid", message: MESSAGES.invalid };
    }

    const found = await resolve(sectionId, pageId);
    if (!found.ok) return found;
    const { context, owner } = found;
    const spec = SPECS[owner.type].find((entry) => entry.key === field);
    const key = ownerKeyOf(owner);
    const patch = { ...(context.patches.get(key) ?? {}) };
    if (!spec || !patch[field]) return { ok: false, reason: "invalid", message: "That field has nothing to resolve." };
    assertContentAuthority(session, owner, spec.structural === true, spec.structural !== true);

    const live = context.live.get(key) ?? {};
    if (choice === "mine") patch[field] = { value: patch[field]!.value, base: live[field] };
    else delete patch[field];

    const written = await writeNodeGuarded(db, {
      ownerKey: key,
      routeKey: context.routeKey,
      expected,
      actorId: session.user.id,
      values: { draftContent: Object.keys(patch).length ? patch : null },
    });
    if (!written.ok) {
      const latest = await freshData(sectionId, pageId);
      return latest
        ? { ok: false, reason: "conflict", message: MESSAGES.conflict, section: latest }
        : { ok: false, reason: "missing", message: MESSAGES.missing };
    }

    await logActivity(session, {
      action: choice === "mine" ? "route.conflict_kept_draft" : "route.conflict_took_live",
      entityType: "category",
      entityId: context.data.category.id,
      summary: `${choice === "mine" ? "Kept the draft of" : "Took the live value of"} ${spec.label} — ${ownerLabel(owner, context.data)}`.slice(0, 255),
      metadata: { owner: key, field },
    });

    const after = await readRouteContext(db, context.routeKey);
    const section = after ? ownerData(after, owner) : null;
    return section ? { ok: true, section } : { ok: false, reason: "missing", message: MESSAGES.missing };
  } catch (error) {
    if (error instanceof AccessError) return { ok: false, reason: "denied", message: error.message };
    console.error("[visual-editor:route-resolve]", error);
    return { ok: false, reason: "invalid", message: "Something went wrong. Nothing was changed." };
  }
}

/* -------------------------------------------------------------------------- */
/* Style and motion                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A region's style draft. The same closed vocabulary, the same validator and
 * the same advanced-token gate as a section's: the document is rebuilt key by
 * key, so nothing that is not a token on the scale is stored.
 */
export async function saveRouteRegionStyles(form: FormData): Promise<VisualStyleSaveResult> {
  try {
    const session = await guardAction(AUTHORITY.editStyle, form, DENIED.editStyle);
    const sectionId = Number(form.get("sectionId"));
    const pageId = Number(form.get("pageId"));
    const expected = revisionField(form);
    if (!Number.isInteger(expected) || expected < 0) return { ok: false, reason: "invalid", message: MESSAGES.invalid };

    const found = await resolve(sectionId, pageId);
    if (!found.ok) return found;
    const { context, owner } = found;

    let submitted: unknown;
    try {
      submitted = JSON.parse(String(form.get("styles") ?? ""));
    } catch {
      return { ok: false, reason: "invalid", message: MESSAGES.invalidStyles };
    }
    const styles = validateStyleDocument(submitted);
    const key = ownerKeyOf(owner);
    const baseline = draftPresentationOf(context.nodes.get(key)).styles;
    if (advancedStylesDiffer(baseline, styles)) {
      assertAllowed(session, AUTHORITY.editAdvancedStyle, DENIED.editAdvancedStyle);
    }

    const written = await writeNodeGuarded(db, {
      ownerKey: key,
      routeKey: context.routeKey,
      expected,
      actorId: session.user.id,
      values: { draftStyles: styles as unknown as Record<string, unknown> },
    });
    if (!written.ok) {
      const latest = await freshData(sectionId, pageId);
      return latest
        ? { ok: false, reason: "conflict", message: MESSAGES.conflict, section: latest }
        : { ok: false, reason: "missing", message: MESSAGES.missing };
    }

    await logActivity(session, {
      action: "route.style_draft_saved",
      entityType: "category",
      entityId: context.data.category.id,
      summary: `Saved a style draft for ${ownerLabel(owner, context.data)}`.slice(0, 255),
      metadata: { owner: key },
    });
    return { ok: true, revision: written.revision, styles };
  } catch (error) {
    if (error instanceof AccessError) return { ok: false, reason: "denied", message: error.message };
    console.error("[visual-editor:route-styles]", error);
    return { ok: false, reason: "invalid", message: "Something went wrong. The change was not saved." };
  }
}

/**
 * A region's motion draft: the MotionDocument, rebuilt against the closed
 * vocabulary and cut down to what the region's block can carry. A region has
 * no legacy preset, so the answer's preset fields are always "none".
 */
export async function saveRouteRegionMotion(form: FormData): Promise<VisualMotionSaveResult> {
  try {
    const session = await guardAction(AUTHORITY.editMotion, form, DENIED.editMotion);
    const sectionId = Number(form.get("sectionId"));
    const pageId = Number(form.get("pageId"));
    const expected = revisionField(form);
    if (!Number.isInteger(expected) || expected < 0) return { ok: false, reason: "invalid", message: MESSAGES.invalid };

    const found = await resolve(sectionId, pageId);
    if (!found.ok) return found;
    const { context, owner } = found;

    let submitted: unknown;
    try {
      submitted = JSON.parse(String(form.get("motionDocument") ?? ""));
    } catch {
      return { ok: false, reason: "invalid", message: MESSAGES.invalidMotion };
    }
    if (!isReadableMotionDocument(submitted)) return { ok: false, reason: "invalid", message: MESSAGES.invalidMotion };
    const document = motionForBlock(submitted ?? emptyMotionDocument(), blockTypeOf(owner));

    const key = ownerKeyOf(owner);
    const written = await writeNodeGuarded(db, {
      ownerKey: key,
      routeKey: context.routeKey,
      expected,
      actorId: session.user.id,
      values: { draftMotion: document as unknown as Record<string, unknown> },
    });
    if (!written.ok) {
      const latest = await freshData(sectionId, pageId);
      return latest
        ? { ok: false, reason: "conflict", message: MESSAGES.conflict, section: latest }
        : { ok: false, reason: "missing", message: MESSAGES.missing };
    }

    await logActivity(session, {
      action: "route.motion_draft_saved",
      entityType: "category",
      entityId: context.data.category.id,
      summary: `Saved a motion draft for ${ownerLabel(owner, context.data)}`.slice(0, 255),
      metadata: { owner: key },
    });
    return { ok: true, revision: written.revision, motion: "none", motionDocument: document, legacyEntrance: "none" };
  } catch (error) {
    if (error instanceof AccessError) return { ok: false, reason: "denied", message: error.message };
    console.error("[visual-editor:route-motion]", error);
    return { ok: false, reason: "invalid", message: "Something went wrong. The change was not saved." };
  }
}

/* -------------------------------------------------------------------------- */
/* The route as a whole                                                       */
/* -------------------------------------------------------------------------- */

/** What is waiting on a route, from the database. `content.view`. */
export async function loadRouteSummary(routeKey: string): Promise<RouteSummaryView | null> {
  try {
    const session = await getSession();
    if (!may(session?.permissions, "viewPages")) return null;
    const context = await readRouteContext(db, routeKey);
    return context ? summarize(context) : null;
  } catch (error) {
    console.error("[visual-editor:route-summary]", error);
    return null;
  }
}

/** A route's publications. `content.view`, like a page's history. */
export async function loadRouteHistory(routeKey: string): Promise<RouteHistoryView | null> {
  try {
    const session = await getSession();
    if (!may(session?.permissions, "viewPages")) return null;
    const context = await readRouteContext(db, routeKey);
    return context ? await routeHistory(context.routeKey) : null;
  } catch (error) {
    console.error("[visual-editor:route-history]", error);
    return null;
  }
}

/** One version compared with what it replaced, or with the live page. Read only. */
export async function loadRouteCompare(
  routeKey: string,
  versionId: number,
  against: "previous" | "live",
): Promise<RouteCompareView | null> {
  try {
    const session = await getSession();
    if (!may(session?.permissions, "viewPages")) return null;
    if (!Number.isInteger(versionId) || versionId <= 0) return null;
    return await compareRouteVersion(routeKey, versionId, against === "live" ? "live" : "previous");
  } catch (error) {
    console.error("[visual-editor:route-compare]", error);
    return null;
  }
}

const allowedBy =
  (session: AdminSession): Allowed =>
  (permission) =>
    session.permissions.has(permission);

const answer = (outcome: RouteOutcome): RouteActionResult =>
  outcome.ok
    ? { ok: true, message: outcome.message }
    : {
        ok: false,
        reason:
          outcome.reason === "nothing"
            ? "invalid"
            : outcome.reason === "blocked"
              ? "blocked"
              : outcome.reason,
        message: outcome.message,
        ...(outcome.details ? { details: outcome.details } : {}),
      };

/** The category a route key names, for the activity log and the admin screens. */
const categoryIdOf = (routeKey: string): number | null => {
  const match = /^category:([1-9][0-9]{0,8})$/.exec(routeKey);
  return match ? Number(match[1]) : null;
};

/**
 * Publishes the drafts that were reviewed — `content.publish`, plus the
 * resource capability of every record they change, checked inside the
 * transaction once it knows which those are.
 */
export async function publishRouteFromEditor(form: FormData): Promise<RouteActionResult> {
  try {
    const session = await guardAction(AUTHORITY.publish, form, DENIED.publish);
    const routeKey = String(form.get("routeKey") ?? "");
    const token = String(form.get("token") ?? "");
    const outcome = await publishRoute({
      routeKey,
      token,
      actor: { id: session.user.id, name: session.user.name },
      allowed: allowedBy(session),
    });
    if (!outcome.ok) return answer(outcome);

    await logActivity(session, {
      action: "route.published",
      entityType: "category",
      entityId: categoryIdOf(routeKey) ?? routeKey,
      summary: `${outcome.message} ${outcome.resources.join(", ")}`.slice(0, 255),
      metadata: { route: routeKey, changes: outcome.changes, resources: outcome.resources },
    });
    /**
     * A publication changes what visitors get: the catalogue and FAQ loaders
     * and the route presentation are dropped by tag — the same tags the admin
     * forms drop — and the admin screens that list these records are told.
     */
    revalidate(TAGS.catalog, TAGS.faqs, TAGS.routes);
    revalidatePath("/admin/categories");
    revalidatePath("/admin/services");
    revalidatePath("/admin/faqs");
    return answer(outcome);
  } catch (error) {
    if (error instanceof AccessError) return { ok: false, reason: "denied", message: error.message };
    console.error("[visual-editor:route-publish]", error);
    return { ok: false, reason: "invalid", message: "Something went wrong. Nothing was published." };
  }
}

/** Throws away the reviewed drafts. Published content is untouched. */
export async function discardRouteFromEditor(form: FormData): Promise<RouteActionResult> {
  try {
    const session = await guardAction(AUTHORITY.publish, form, DENIED.publish);
    const routeKey = String(form.get("routeKey") ?? "");
    const token = String(form.get("token") ?? "");
    const outcome = await discardRoute({
      routeKey,
      token,
      actor: { id: session.user.id, name: session.user.name },
      allowed: allowedBy(session),
    });
    if (!outcome.ok) return answer(outcome);
    await logActivity(session, {
      action: "route.drafts_discarded",
      entityType: "category",
      entityId: categoryIdOf(routeKey) ?? routeKey,
      summary: outcome.message.slice(0, 255),
      metadata: { route: routeKey, regions: outcome.resources },
    });
    return answer(outcome);
  } catch (error) {
    if (error instanceof AccessError) return { ok: false, reason: "denied", message: error.message };
    console.error("[visual-editor:route-discard]", error);
    return { ok: false, reason: "invalid", message: "Something went wrong. Nothing was discarded." };
  }
}

/** Brings a version back as a draft. Never live. */
export async function restoreRouteFromEditor(form: FormData): Promise<RouteActionResult> {
  try {
    const session = await guardAction(AUTHORITY.publish, form, DENIED.publish);
    const routeKey = String(form.get("routeKey") ?? "");
    const versionId = Number(form.get("versionId"));
    if (!Number.isInteger(versionId) || versionId <= 0) {
      return { ok: false, reason: "invalid", message: "That version could not be read." };
    }
    const outcome = await restoreRouteVersion({
      routeKey,
      versionId,
      actor: { id: session.user.id, name: session.user.name },
      allowed: allowedBy(session),
    });
    if (!outcome.ok) return answer(outcome);
    await logActivity(session, {
      action: "route.version_restored_to_draft",
      entityType: "category",
      entityId: categoryIdOf(routeKey) ?? routeKey,
      summary: `Restored version #${versionId} as a draft`,
      metadata: { route: routeKey, versionId, skipped: outcome.resources },
    });
    return answer(outcome);
  } catch (error) {
    if (error instanceof AccessError) return { ok: false, reason: "denied", message: error.message };
    console.error("[visual-editor:route-restore]", error);
    return { ok: false, reason: "invalid", message: "Something went wrong. Nothing was restored." };
  }
}
