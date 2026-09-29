"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { logActivity } from "@/lib/activity";
import { AccessError, guardAction } from "@/lib/auth/guard";
import { getSession } from "@/lib/auth/session";
import { TAGS, revalidate } from "@/lib/cache";
import { getBlock } from "@/lib/cms/blocks";
import { COMPOUND, DENIED as CAPABILITY_DENIED } from "@/lib/auth/authority";
import { REUSE_AUTHORITY, REUSE_DENIED, reuseAllowed } from "@/lib/cms/reuse/authority";
import { kindDef, kindNoun } from "@/lib/cms/reuse/kinds";
import {
  BLOCK_SLOT,
  hasSeparateLinks,
  readReuse,
  slotContent,
  slotDef,
  WHOLE_BLOCK_REFUSAL,
} from "@/lib/cms/reuse/reference";
import {
  createComponent,
  deleteComponent,
  discardComponentDraft,
  getComponent,
  KEEP_COMPONENT_VERSIONS,
  listComponents,
  listComponentVersions,
  publishComponent,
  renameComponent,
  restoreComponentVersion,
  saveComponentDraft,
  setComponentArchived,
  type ComponentDetail,
  type ComponentResult,
} from "@/lib/cms/reuse/service";
import { componentUsage, EMPTY_USAGE, publishedSentence, usageByComponent } from "@/lib/cms/reuse/usage";
import type { ReuseActionResult, ReuseCatalogEntry, ReuseComponentView } from "@/lib/cms/reuse/view";
import { db } from "@/lib/db";
import { pageSections } from "@/lib/db/schema";

/**
 * Every write to a reusable component, and the two reads the screens need
 * (Batch 17).
 *
 * One module for both surfaces — the Reusable components screen and the Visual
 * Editor's global editor call the same actions — so the two cannot disagree
 * about what saving, publishing or deleting a component means.
 *
 * Each mutation goes through `guardAction` (session, CSRF, permission) with the
 * permission named by `REUSE_AUTHORITY`, names the component revision it was
 * built from, is decided by `lib/cms/reuse/service.ts`, and writes one activity
 * entry. The browser sends ids, a name and values; the kind of an existing
 * component, its usage and its history are always read here.
 */

const DENIED = "You do not have permission to change reusable components.";

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

function catalogEntry(detail: ComponentDetail, usage = EMPTY_USAGE): ReuseCatalogEntry {
  return {
    id: detail.id,
    kind: detail.kind,
    name: detail.name,
    status: detail.status,
    revision: detail.revision,
    publishedVersion: detail.publishedVersion,
    published: detail.published,
    hasDraft: detail.hasDraft,
    updatedAt: detail.updatedAt.toISOString(),
    // A copy per entry: a shared object would be sent once and referenced from
    // the other entries, which every client would then have to resolve.
    usage: { ...usage },
  };
}

async function viewOf(id: number): Promise<ReuseComponentView | null> {
  const detail = await getComponent(id);
  if (!detail) return null;
  const [usage, versions] = await Promise.all([componentUsage(db, id), listComponentVersions(id)]);
  return {
    ...catalogEntry(detail, usage.summary),
    draft: detail.draft,
    publishedAt: iso(detail.publishedAt),
    instances: usage.instances,
    versions: versions.map((entry) => ({
      id: entry.id,
      version: entry.version,
      label: entry.label,
      actorName: entry.actorName,
      createdAt: entry.createdAt.toISOString(),
    })),
    keepVersions: KEEP_COMPONENT_VERSIONS,
  };
}

/** Every component with its usage — the picker, the list screen and the Globals drawer. */
export async function loadReusableCatalog(): Promise<ReuseCatalogEntry[] | null> {
  try {
    const session = await getSession();
    if (!reuseAllowed(session?.permissions, "view")) return null;
    const [components, usage] = await Promise.all([listComponents(), usageByComponent(db)]);
    return components.map((detail) => catalogEntry(detail, usage.get(detail.id) ?? EMPTY_USAGE));
  } catch (error) {
    console.error("[reuse:catalog]", error);
    return null;
  }
}

/** One component, whole. */
export async function loadReusableComponent(id: number): Promise<ReuseComponentView | null> {
  try {
    const session = await getSession();
    if (!reuseAllowed(session?.permissions, "view")) return null;
    if (!Number.isInteger(id) || id <= 0) return null;
    return await viewOf(id);
  } catch (error) {
    console.error("[reuse:load]", error);
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Mutations                                                                  */
/* -------------------------------------------------------------------------- */

const idOf = (form: FormData, name = "id"): number => {
  const value = Number(form.get(name));
  return Number.isInteger(value) && value > 0 ? value : 0;
};

const revisionOf = (form: FormData): number => {
  const value = Number(form.get("expectedRevision"));
  return Number.isInteger(value) && value >= 0 ? value : -1;
};

function valuesOf(form: FormData): unknown {
  try {
    return JSON.parse(String(form.get("values") ?? "")) as unknown;
  } catch {
    return undefined;
  }
}

const refreshScreens = (id?: number) => {
  revalidatePath("/admin/components");
  if (id) revalidatePath(`/admin/components/${id}`);
};

/** A service failure as the screen reads it — with the winning version after a lost race. */
async function failed(result: Extract<ComponentResult, { ok: false }>, id: number): Promise<ReuseActionResult> {
  return {
    ok: false,
    reason: result.reason,
    message: result.message,
    ...(result.reason === "conflict" ? { latest: await viewOf(id) } : {}),
  };
}

async function run(
  label: string,
  body: () => Promise<ReuseActionResult>,
): Promise<ReuseActionResult> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof AccessError) return { ok: false, reason: "denied", message: error.message || DENIED };
    console.error(`[reuse:${label}]`, error);
    return { ok: false, reason: "invalid", message: "Something went wrong. Nothing was changed." };
  }
}

/** A new component from the management screen: a kind, a name and its first content. */
export async function createReusableComponent(form: FormData): Promise<ReuseActionResult> {
  return run("create", async () => {
    // Publishing in the same step needs publishing too — asked for up front, so
    // a refusal creates nothing rather than half of what was asked (Batch 18).
    const publish = form.get("publish") === "1";
    const session = publish
      ? await guardAction(COMPOUND.createPublishedComponent, form, CAPABILITY_DENIED.createPublishedComponent)
      : await guardAction(REUSE_AUTHORITY.edit, form, REUSE_DENIED.edit);
    const kind = String(form.get("kind") ?? "");
    const definition = kindDef(kind);
    const result = await createComponent({
      kind,
      name: String(form.get("name") ?? ""),
      // A new component starts from whatever the screen sends, or empty.
      values: valuesOf(form) ?? {},
      publish,
      actor: { userId: session.user.id, actorName: session.user.name },
    });
    if (!result.ok) return { ok: false, reason: result.reason, message: result.message };
    await logActivity(session, {
      action: "reusable_component.created",
      entityType: "reusable_component",
      entityId: result.component.id,
      summary: `Created the ${definition?.label ?? "reusable component"} “${result.component.name}”${publish ? " and published it" : ""}`,
    });
    if (publish) revalidate(TAGS.pages);
    refreshScreens(result.component.id);
    return { ok: true, message: publish ? "Created and published." : "Created as a draft.", component: await viewOf(result.component.id) };
  });
}

/**
 * "Save as reusable CTA / component": a component made from what one section
 * already holds.
 *
 * The kind is decided by the slot — the server's registry, never the request —
 * and the content is read from the section as stored, not from the browser,
 * so the component starts as exactly what the page shows. With `publish`, its
 * first version is published in the same step: nothing links to it yet, so no
 * visitor sees any change, and the section can then be linked to it. The
 * screen asks for that explicitly.
 */
export async function createReusableFromSection(form: FormData): Promise<ReuseActionResult> {
  return run("create-from-section", async () => {
    /**
     * Every effect, checked before the first write (Batch 18). A draft reads
     * the section and writes a component draft. "Create, publish and link"
     * also publishes the component and then links this section to it — a page
     * content change — so it needs editing page content and publishing
     * components as well; asking for all of it here means a caller missing
     * any one part gets a refusal, never a component that was made and
     * published and then could not be linked.
     */
    const publish = form.get("publish") === "1";
    const session = publish
      ? await guardAction(COMPOUND.saveAsReusablePublished, form, CAPABILITY_DENIED.saveAsReusablePublished)
      : await guardAction(COMPOUND.saveAsReusableDraft, form, CAPABILITY_DENIED.saveAsReusableDraft);
    const sectionId = idOf(form, "sectionId");
    const pageId = idOf(form, "pageId");
    const slotName = String(form.get("slot") ?? "");
    const [row] = sectionId
      ? await db.select().from(pageSections).where(eq(pageSections.id, sectionId)).limit(1)
      : [];
    if (!row || row.pageId !== pageId) {
      return { ok: false, reason: "missing", message: "That section no longer exists. Reload the canvas." };
    }
    const slot = slotDef(row.blockType, slotName);
    if (!slot) return { ok: false, reason: "invalid", message: "That part of the section cannot be made reusable." };
    const stored = (row.draft ?? row.published) as Record<string, unknown>;
    if (readReuse(stored, row.blockType)[slotName] || readReuse(stored, row.blockType).block) {
      return { ok: false, reason: "invalid", message: "That is already linked to a reusable component." };
    }
    // Its linked call to action holds only a kept copy; the component would be
    // made from stale words (see `hasSeparateLinks`).
    if (slotName === BLOCK_SLOT && hasSeparateLinks(row.blockType, stored)) {
      return { ok: false, reason: "invalid", message: WHOLE_BLOCK_REFUSAL };
    }
    const result = await createComponent({
      kind: slot.kind,
      name: String(form.get("name") ?? ""),
      values: slotContent(row.blockType, stored, slotName) ?? {},
      publish,
      actor: { userId: session.user.id, actorName: session.user.name },
    });
    if (!result.ok) return { ok: false, reason: result.reason, message: result.message };
    await logActivity(session, {
      action: "reusable_component.created",
      entityType: "reusable_component",
      entityId: result.component.id,
      summary:
        `Saved the ${slot.label.toLowerCase()} of a ${getBlock(row.blockType)?.name ?? row.blockType} section ` +
        `as the reusable ${kindNoun(slot.kind)} “${result.component.name}”${publish ? " and published it" : ""}`,
      metadata: { sectionId, slot: slotName },
    });
    refreshScreens(result.component.id);
    return {
      ok: true,
      message: publish ? "Created and published. Nothing on the site changed." : "Created as a draft.",
      component: await viewOf(result.component.id),
    };
  });
}

export async function saveReusableDraft(form: FormData): Promise<ReuseActionResult> {
  return run("save", async () => {
    const session = await guardAction(REUSE_AUTHORITY.edit, form, REUSE_DENIED.edit);
    const id = idOf(form);
    const values = valuesOf(form);
    if (values === undefined) return { ok: false, reason: "invalid", message: "Those values could not be read." };
    const result = await saveComponentDraft({
      id,
      expectedRevision: revisionOf(form),
      values,
      actor: { userId: session.user.id, actorName: session.user.name },
    });
    if (!result.ok) return failed(result, id);
    await logActivity(session, {
      action: "reusable_component.draft_saved",
      entityType: "reusable_component",
      entityId: id,
      summary: result.component.hasDraft
        ? `Saved a draft of “${result.component.name}”`
        : `Saved “${result.component.name}” back to what is published — nothing pending`,
    });
    refreshScreens(id);
    return {
      ok: true,
      message: result.component.hasDraft
        ? "Draft saved. Linked pages still show the published version."
        : "Nothing pending — that is exactly what is published.",
      component: await viewOf(id),
    };
  });
}

export async function discardReusableDraft(form: FormData): Promise<ReuseActionResult> {
  return run("discard", async () => {
    const session = await guardAction(REUSE_AUTHORITY.edit, form, REUSE_DENIED.edit);
    const id = idOf(form);
    const result = await discardComponentDraft({
      id,
      expectedRevision: revisionOf(form),
      actor: { userId: session.user.id, actorName: session.user.name },
    });
    if (!result.ok) return failed(result, id);
    await logActivity(session, {
      action: "reusable_component.draft_discarded",
      entityType: "reusable_component",
      entityId: id,
      summary: `Discarded the draft of “${result.component.name}”`,
    });
    refreshScreens(id);
    return { ok: true, message: "Draft discarded. Nothing on the site changed.", component: await viewOf(id) };
  });
}

/**
 * Publishes a component: every linked page shows it from this moment.
 *
 * The one component write that changes what visitors see, so the one that
 * drops the pages cache — all of it, `TAGS.pages`. Which pages link to a
 * component is known, but the cached loaders are keyed by slug and tagged per
 * collection; dropping the collection is correct, costs one re-render of each
 * page on its next visit, and happens only when someone publishes a component.
 * No page row is written, so no page revision moves and no editor with a page
 * open is made stale by it.
 */
export async function publishReusable(form: FormData): Promise<ReuseActionResult> {
  return run("publish", async () => {
    const session = await guardAction(REUSE_AUTHORITY.publish, form, REUSE_DENIED.publish);
    const id = idOf(form);
    const result = await publishComponent({
      id,
      expectedRevision: revisionOf(form),
      actor: { userId: session.user.id, actorName: session.user.name },
    });
    if (!result.ok) return failed(result, id);
    revalidate(TAGS.pages);
    const usage = await componentUsage(db, id);
    await logActivity(session, {
      action: "reusable_component.published",
      entityType: "reusable_component",
      entityId: id,
      summary: `Published “${result.component.name}” (version ${result.component.publishedVersion})`,
      metadata: {
        version: result.component.publishedVersion,
        livePages: usage.summary.livePages,
        liveInstances: usage.summary.liveInstances,
      },
    });
    refreshScreens(id);
    return {
      ok: true,
      message: `Published version ${result.component.publishedVersion}. ${publishedSentence(usage.summary)}`,
      component: await viewOf(id),
    };
  });
}

/** An earlier version back as the DRAFT — reviewed, previewed and published like any other edit. */
export async function restoreReusableVersion(form: FormData): Promise<ReuseActionResult> {
  return run("restore", async () => {
    const session = await guardAction(REUSE_AUTHORITY.restore, form, REUSE_DENIED.restore);
    const id = idOf(form);
    const result = await restoreComponentVersion({
      id,
      versionId: idOf(form, "versionId"),
      expectedRevision: revisionOf(form),
      actor: { userId: session.user.id, actorName: session.user.name },
    });
    if (!result.ok) return failed(result, id);
    await logActivity(session, {
      action: "reusable_component.restored",
      entityType: "reusable_component",
      entityId: id,
      summary: `Restored version ${result.version} of “${result.component.name}” to its draft`,
      metadata: { version: result.version },
    });
    refreshScreens(id);
    return {
      ok: true,
      message: `Version ${result.version} is the draft now. Linked pages still show the published version until you publish.`,
      component: await viewOf(id),
    };
  });
}

export async function renameReusable(form: FormData): Promise<ReuseActionResult> {
  return run("rename", async () => {
    const session = await guardAction(REUSE_AUTHORITY.edit, form, REUSE_DENIED.edit);
    const id = idOf(form);
    const result = await renameComponent({
      id,
      expectedRevision: revisionOf(form),
      name: String(form.get("name") ?? ""),
      actor: { userId: session.user.id, actorName: session.user.name },
    });
    if (!result.ok) return failed(result, id);
    await logActivity(session, {
      action: "reusable_component.renamed",
      entityType: "reusable_component",
      entityId: id,
      summary: `Renamed a reusable component to “${result.component.name}”`,
    });
    refreshScreens(id);
    return { ok: true, message: "Renamed. The name is for the admin only; no page changed.", component: await viewOf(id) };
  });
}

export async function archiveReusable(form: FormData): Promise<ReuseActionResult> {
  return run("archive", async () => {
    const session = await guardAction(REUSE_AUTHORITY.lifecycle, form, REUSE_DENIED.lifecycle);
    const id = idOf(form);
    const archived = form.get("archived") === "1";
    const result = await setComponentArchived({
      id,
      expectedRevision: revisionOf(form),
      archived,
      actor: { userId: session.user.id, actorName: session.user.name },
    });
    if (!result.ok) return failed(result, id);
    await logActivity(session, {
      action: archived ? "reusable_component.archived" : "reusable_component.unarchived",
      entityType: "reusable_component",
      entityId: id,
      summary: `${archived ? "Archived" : "Restored from the archive"} “${result.component.name}”`,
    });
    refreshScreens(id);
    return {
      ok: true,
      message: archived
        ? "Archived. Pages that use it keep showing it; it can no longer be linked to anything new."
        : "Restored from the archive. It can be linked again.",
      component: await viewOf(id),
    };
  });
}

/** Only a component nothing refers to — re-checked inside the delete itself. */
export async function deleteReusable(form: FormData): Promise<ReuseActionResult> {
  return run("delete", async () => {
    const session = await guardAction(REUSE_AUTHORITY.lifecycle, form, REUSE_DENIED.lifecycle);
    const id = idOf(form);
    const result = await deleteComponent({ id, expectedRevision: revisionOf(form) });
    if (!result.ok) return failed(result, id);
    await logActivity(session, {
      action: "reusable_component.deleted",
      entityType: "reusable_component",
      entityId: id,
      summary: `Deleted the unused reusable ${kindNoun(result.kind)} “${result.name}”`,
    });
    refreshScreens();
    return { ok: true, message: "Deleted.", component: null };
  });
}
