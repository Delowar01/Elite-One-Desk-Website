"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { logActivity } from "@/lib/activity";
import { TAGS, revalidate } from "@/lib/cache";
import { AccessError, guardAction } from "@/lib/auth/guard";
import { getSession } from "@/lib/auth/session";
import {
  loadEditorGlobals as readEditorGlobals,
  type GlobalsState,
} from "@/lib/visual-editor/globals";
import { getBlock, type BlockDef } from "@/lib/cms/blocks";
import { effectiveMotion, readMotion } from "@/lib/cms/motion";
import {
  currentMotionDocument,
  legacyFallback,
  motionDraftFromDocument,
  motionDraftFromPreset,
} from "@/lib/cms/motion-write";
import { emptyMotionDocument, isReadableMotionDocument } from "@/lib/cms/motion-doc";
import { motionForBlock } from "@/lib/visual-editor/motion-targets";
import { validateStyleDocument } from "@/lib/cms/styles";
import { parseBlockPayload, validateBlockValues } from "@/lib/cms/validate";
import {
  BLOCK_SLOT,
  detachSlot,
  hasSeparateLinks,
  parseReuse,
  readReuse,
  slotDef,
  WHOLE_BLOCK_REFUSAL,
  withReuse,
  type ReuseMap,
} from "@/lib/cms/reuse/reference";
import { REUSE_AUTHORITY } from "@/lib/cms/reuse/authority";
import {
  checkReferencesForSave,
  componentValues,
  referenceProblemMessage,
} from "@/lib/cms/reuse/store";
import { emptyValues } from "@/lib/cms/values";
import {
  addStructureSection,
  discardLayoutDraft,
  duplicateStructureSection,
  getPageStructure,
  removeStructureSection,
  reorderStructure,
  restoreStructureSection,
  setStructureVisibility,
  type PageStructure,
  type RestorePlacement,
  type StructureResult,
} from "@/lib/cms/structure-service";
import { readVisibility } from "@/lib/cms/structure";
import {
  discardPageChanges,
  getPageDraftSummary,
  publishPageChanges,
  restoreBlockers,
  RESTORE_BLOCKED,
} from "@/lib/cms/publish-service";
import { KEEP_PAGE_VERSIONS, listPageVersions, restoreVersionToDraft } from "@/lib/versions";
import { db } from "@/lib/db";
import { updateSectionGuarded, updateSectionGuardedIn } from "@/lib/db/revision";
import { pageSections, pages, reusableComponents } from "@/lib/db/schema";
import type {
  PageActionResult,
  PageHistoryView,
  PageSummaryView,
} from "@/lib/visual-editor/publish";
import type {
  VisualContentSaveResult,
  VisualDetachResult,
  VisualMotionSaveResult,
  VisualSectionData,
  VisualSectionLoad,
  VisualStructureResult,
  VisualStyleSaveResult,
} from "@/lib/visual-editor/content";

/**
 * The Visual Editor's two content operations: read one section, save its draft.
 *
 * Three rules hold this module together, and each of them is a thing that goes
 * wrong in visual editors specifically.
 *
 * **The server decides what a section is.** The canvas is an iframe showing the
 * real page; it is a rendering, not a store. Nothing is ever read back out of
 * the DOM and written to the database. The panel asks this module what the
 * section contains, edits that, and sends it back — so an element the renderer
 * decorated, a script that rewrote a heading, or a stale frame from before a
 * save cannot become stored content.
 *
 * **There is no second validator.** Everything saved goes through
 * `validateBlockValues`, the same function the ordinary admin form uses, which
 * rebuilds every value field by field from the block registry. A visual editor
 * that grew its own more permissive path would be a way to put into the
 * database exactly what the registry exists to keep out.
 *
 * **Nothing here publishes.** Each save writes exactly one column — `draft`,
 * `draft_styles` or `draft_animation` — plus the revision, the author and the
 * timestamp, which the guard writes. `published`, `is_published`, `animation`,
 * `styles`, `position`, `is_draft_only` and `pages.draft_structure` are
 * somebody else's business, and a save in one domain must never move them, or
 * another domain's column, by accident.
 */

const MESSAGES = {
  denied: "You do not have permission to edit content.",
  missing: "That section no longer exists. Reload the canvas.",
  wrongPage: "That section belongs to a different page. Reload the canvas.",
  unknownBlock: "That section type is no longer available.",
  invalid: "Those values could not be read. Reload the canvas and try again.",
  invalidStyles: "Those styles could not be read. Reload the canvas and try again.",
  invalidMotion: "That entrance is not one of the available options. Reload the canvas and try again.",
  conflict:
    "This section changed while you were editing it. Reload the latest version before saving, " +
    "or your colleague's work would be overwritten.",
} as const;

/**
 * The editable document for one section.
 *
 * `values` is run through the registry validator on the way *out* as well as on
 * the way in. That is not belt and braces: it completes a section stored before
 * a field existed, and it gives every repeatable row its `_id` — so the panel
 * edits rows that already have stable identities rather than minting them at
 * save time, when it is too late for a selection to have pointed at one.
 */
function toData(row: typeof pageSections.$inferSelect, block: BlockDef): VisualSectionData {
  const stored = (row.draft ?? row.published) as Record<string, unknown>;
  const hasStyleDraft = row.draftStyles !== null;
  // One domain, two columns: a pending preset or a pending document.
  const hasMotionDraft = row.draftAnimation !== null || row.draftMotionConfig !== null;
  return {
    sectionId: row.id,
    pageId: row.pageId,
    blockType: row.blockType,
    revision: row.revision,
    hasDraft: Boolean(row.draft),
    hasStyleDraft,
    hasMotionDraft,
    isDraftOnly: row.isDraftOnly,
    /**
     * The reusable-component reference (Batch 17) rides alongside: the panel
     * edits it like any other content — linking, overriding and resetting are
     * content edits in this buffer — and the save checks it against the
     * database. Read tolerantly here; a save reads it strictly.
     */
    values: withReuse(
      validateBlockValues(block, { ...emptyValues(block), ...stored }),
      readReuse(stored, block.type),
    ),
    // The draft document whole when there is one, empty included — an empty
    // style draft is a pending reset, not an absent one.
    styles: validateStyleDocument(hasStyleDraft ? row.draftStyles : row.styles),
    /**
     * The same rule, one column over — and one refinement. The draft when it
     * can be read, the published entrance when it cannot, never the raw
     * string, and never `DEFAULT_MOTION` standing in for an unreadable draft:
     * the chooser would then be showing "Fade up" as the pending choice on a
     * section publishing something else, which is the one wrong answer that
     * looks like a right one.
     *
     * `hasMotionDraft` is still true for an unreadable draft, so the panel
     * says there is something pending. Reading never repairs and never writes.
     */
    motion: effectiveMotion(row.animation, row.draftAnimation),
    /**
     * The document the panel edits, cut down to what this block can carry so a
     * setting it shows is a setting a save keeps. An empty document when there
     * is none, so the panel always edits the same shape.
     */
    motionDocument: motionForBlock(currentMotionDocument(row) ?? emptyMotionDocument(), block.type),
    legacyEntrance: legacyFallback(row),
  };
}

/**
 * Ownership, checked against the row rather than against what was asked.
 *
 * The editor always names the page it believes it is editing, and a section
 * that belongs to another page is refused instead of loaded. Without this a
 * mistyped or replayed section id would let one page's canvas edit another
 * page's content — silently, since the canvas would keep showing the page it
 * was already showing.
 */
async function ownedSection(
  sectionId: number,
  expectedPageId: number,
): Promise<{ ok: true; row: typeof pageSections.$inferSelect; block: BlockDef } | { ok: false; reason: "missing" | "wrong_page" | "unknown_block"; message: string }> {
  if (!Number.isInteger(sectionId) || sectionId <= 0) {
    return { ok: false, reason: "missing", message: MESSAGES.missing };
  }
  const [row] = await db.select().from(pageSections).where(eq(pageSections.id, sectionId)).limit(1);
  if (!row) return { ok: false, reason: "missing", message: MESSAGES.missing };
  if (!Number.isInteger(expectedPageId) || row.pageId !== expectedPageId) {
    return { ok: false, reason: "wrong_page", message: MESSAGES.wrongPage };
  }
  const block = getBlock(row.blockType);
  if (!block) return { ok: false, reason: "unknown_block", message: MESSAGES.unknownBlock };
  return { ok: true, row, block };
}

/** The `_reuse` key of a submitted values payload, or `undefined` for none. */
function submittedReuse(raw: string): unknown {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)._reuse
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The activity a save's reference changes deserve (Batch 17): a link made or
 * removed, and an override switched on or off — discrete decisions, each one
 * entry. Never the text typed into an override: that is the section's own
 * draft, and a save of it is the `section.draft_saved` above.
 */
async function logReferenceChanges(
  session: Awaited<ReturnType<typeof guardAction>>,
  sectionId: number,
  blockType: string,
  blockName: string,
  before: ReuseMap,
  after: ReuseMap,
): Promise<void> {
  const slots = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const slot of slots) {
    const was = before[slot];
    const now = after[slot];
    const where = `${slotDef(blockType, slot)?.label ?? slot} of a ${blockName} section (#${sectionId})`;
    if (now && was?.c !== now.c) {
      await logActivity(session, {
        action: "reusable_component.instance_linked",
        entityType: "reusable_component",
        entityId: now.c,
        summary: `Linked the ${where} in a page draft`,
        metadata: { sectionId, slot },
      });
    }
    if (was && was.c !== now?.c) {
      await logActivity(session, {
        action: "reusable_component.instance_unlinked",
        entityType: "reusable_component",
        entityId: was.c,
        summary: `Unlinked the ${where} in a page draft`,
        metadata: { sectionId, slot },
      });
    }
    if (was && now && was.c === now.c) {
      const a = new Set(was.o ?? []);
      const b = new Set(now.o ?? []);
      const added = [...b].filter((key) => !a.has(key));
      const removed = [...a].filter((key) => !b.has(key));
      if (added.length || removed.length) {
        await logActivity(session, {
          action: "reusable_component.override_changed",
          entityType: "reusable_component",
          entityId: now.c,
          summary: `${added.length ? "Overrode" : "Reset"} ${added.length + removed.length} field(s) of the ${where}`,
          metadata: { sectionId, slot, added, removed },
        });
      }
    }
  }
}

/**
 * Reads one section for the inspector.
 *
 * `content.view` — the same key the canvas itself needs — because this returns
 * nothing a viewer could not already read off the preview they are looking at.
 * Writing is a separate permission, checked separately, in the action below.
 */
export async function loadVisualSection(
  sectionId: number,
  expectedPageId: number,
): Promise<VisualSectionLoad> {
  try {
    const session = await getSession();
    if (!session?.permissions.has("content.view")) {
      return { ok: false, reason: "denied", message: MESSAGES.denied };
    }

    const found = await ownedSection(sectionId, expectedPageId);
    if (!found.ok) return found;
    return { ok: true, section: toData(found.row, found.block) };
  } catch (error) {
    console.error("[visual-editor:load]", error);
    return { ok: false, reason: "missing", message: "The section could not be read. Reload the canvas." };
  }
}

/**
 * Saves one section's content as a draft. Never publishes.
 *
 * FormData rather than plain arguments so the submission carries the CSRF token
 * the rest of the admin uses — `guardAction` is the one door every admin
 * mutation goes through, and a visual editor that let itself in through a side
 * entrance would be the weakest lock on the site.
 */
export async function saveVisualSectionDraft(form: FormData): Promise<VisualContentSaveResult> {
  try {
    const session = await guardAction("content.manage", form);

    const sectionId = Number(form.get("sectionId"));
    const pageId = Number(form.get("pageId"));
    const expected = Number(form.get("expectedRevision"));

    const found = await ownedSection(sectionId, pageId);
    if (!found.ok) return found;

    const raw = String(form.get("values") ?? "");
    const declared = parseBlockPayload(raw, found.block);
    if (!declared) return { ok: false, reason: "invalid", message: MESSAGES.invalid };
    if (!Number.isInteger(expected) || expected < 0) {
      return { ok: false, reason: "invalid", message: MESSAGES.invalid };
    }

    /**
     * The reusable-component reference (Batch 17), read strictly: a reference
     * this build cannot read refuses the save rather than being dropped,
     * because dropping it would unlink the section without anyone asking.
     * The validator above rebuilt the declared fields and dropped it, as it
     * drops every undeclared key; it is written back beside them.
     */
    const reuse = parseReuse(submittedReuse(raw), found.block.type);
    if (!reuse.ok) return { ok: false, reason: "invalid", message: MESSAGES.invalid };
    const values = withReuse(declared, reuse.map);
    const before = readReuse(found.row.draft ?? found.row.published, found.block.type);
    // A whole-section link laid over a call to action linked on its own would
    // drop that link without anyone asking — refused before anything is
    // written, so the revision does not move (see `hasSeparateLinks`).
    if (reuse.map[BLOCK_SLOT] && hasSeparateLinks(found.block.type, found.row.draft ?? found.row.published)) {
      return { ok: false, reason: "invalid", message: WHOLE_BLOCK_REFUSAL };
    }

    /**
     * The whole write. `draft` and nothing else — the guard adds `revision`,
     * `updated_at` and takes `updated_by` — so a content save cannot publish,
     * cannot show a hidden section, and cannot disturb motion or styles.
     * Content, style and motion are three draft domains sharing one row and
     * one concurrency timeline; each save writes only its own column.
     *
     * A section that links to reusable components writes inside a
     * transaction that first checks every component against the database —
     * it exists, it is the kind the slot takes, it has been published, and it
     * is not archived unless this section already linked it — holding them
     * `FOR SHARE` until the write commits, so none can be deleted in between.
     * The browser names ids; everything else is read here.
     */
    const written = Object.keys(reuse.map).length
      ? await db.transaction(async (tx) => {
          const problems = await checkReferencesForSave(tx, {
            blockType: found.block.type,
            map: reuse.map,
            stored: [found.row.published, found.row.draft],
          });
          if (problems.length) {
            return { kind: "refused" as const, message: referenceProblemMessage(problems[0]!) };
          }
          return {
            kind: "written" as const,
            result: await updateSectionGuardedIn(tx, sectionId, expected, {
              draft: values,
              updatedBy: session.user.id,
            }),
          };
        })
      : {
          kind: "written" as const,
          result: await updateSectionGuarded(sectionId, expected, {
            draft: values,
            updatedBy: session.user.id,
          }),
        };
    if (written.kind === "refused") return { ok: false, reason: "invalid", message: written.message };
    const result = written.result;

    if (!result.ok) {
      if (result.reason === "missing") {
        return { ok: false, reason: "missing", message: MESSAGES.missing };
      }
      // Lost the race. The useful thing to hand back is the version that won,
      // so the panel can offer it rather than guess at a merge.
      const fresh = await ownedSection(sectionId, pageId);
      if (!fresh.ok) return fresh;
      return {
        ok: false,
        reason: "conflict",
        message: MESSAGES.conflict,
        section: toData(fresh.row, fresh.block),
      };
    }

    await logActivity(session, {
      action: "section.draft_saved",
      entityType: "section",
      entityId: sectionId,
      summary: `Saved a draft of the ${found.block.name} section in the Visual Editor`,
    });
    await logReferenceChanges(session, sectionId, found.block.type, found.block.name, before, reuse.map);

    /**
     * The canvas reads drafts through `getPagePreview`, which is deliberately
     * uncached, so a reload shows this save without any invalidation at all.
     * What does need telling is the admin's own screens, which count drafts.
     * The `pages` cache tag is *not* dropped: a draft changes nothing a visitor
     * sees, and throwing away every published page's cache on every save would
     * be paying the whole site's rendering cost for an edit nobody can see yet.
     */
    const [page] = await db
      .select({ slug: pages.slug })
      .from(pages)
      .where(eq(pages.id, found.row.pageId))
      .limit(1);
    if (page) revalidatePath(`/admin/pages/${page.slug}`);
    revalidatePath("/admin/pages");

    return {
      ok: true,
      section: {
        ...toData(found.row, found.block),
        revision: result.revision,
        hasDraft: true,
        // What was stored, not what was sent: the panel adopts the sanitised
        // text so the box an editor is looking at agrees with the database.
        values,
      },
    };
  } catch (error) {
    if (error instanceof AccessError) return { ok: false, reason: "denied", message: error.message };
    console.error("[visual-editor:save]", error);
    return { ok: false, reason: "invalid", message: "Something went wrong. The change was not saved." };
  }
}

/**
 * Detaches one reusable-component instance (Batch 17). Never publishes, and
 * never touches the component.
 *
 * Resolved here, not in the browser: the covered fields take the content this
 * page shows — the component's *current* published content with this page's
 * overrides on top — read inside the transaction with the component held
 * `FOR SHARE`, and the reference is removed. The section keeps its style,
 * motion and place; its draft is what changes, so the page has something to
 * publish and the page's Undo can take it back.
 *
 * Two guards. The section's revision, as for any content save. And the
 * component's published version the canvas was drawn with: a component
 * published since then would be baked in as content nobody here has seen,
 * so that is refused by name and the canvas is reloaded instead. The section
 * must be saved first — detaching reads the stored section, not the browser's.
 */
export async function detachVisualInstance(form: FormData): Promise<VisualDetachResult> {
  try {
    const session = await guardAction(REUSE_AUTHORITY.instances, form);

    const sectionId = Number(form.get("sectionId"));
    const pageId = Number(form.get("pageId"));
    const expected = Number(form.get("expectedRevision"));
    const expectedVersion = Number(form.get("expectedComponentVersion"));
    const slot = String(form.get("slot") ?? "");

    const found = await ownedSection(sectionId, pageId);
    if (!found.ok) return found;
    if (!Number.isInteger(expected) || expected < 0 || !Number.isInteger(expectedVersion) || expectedVersion < 0) {
      return { ok: false, reason: "invalid", message: MESSAGES.invalid };
    }
    const stored = (found.row.draft ?? found.row.published) as Record<string, unknown>;
    const ref = readReuse(stored, found.block.type)[slot];
    if (!ref) {
      return { ok: false, reason: "invalid", message: "That part of the section is not linked any more. Reload the canvas." };
    }

    const outcome = await db.transaction(async (tx) => {
      const [component] = await tx
        .select({
          id: reusableComponents.id,
          kind: reusableComponents.kind,
          name: reusableComponents.name,
          published: reusableComponents.published,
          publishedVersion: reusableComponents.publishedVersion,
        })
        .from(reusableComponents)
        .where(eq(reusableComponents.id, ref.c))
        .limit(1)
        .for("share");
      if ((component?.publishedVersion ?? 0) !== expectedVersion) return { stale: true } as const;
      const fits = component && component.kind === slotDef(found.block.type, slot)?.kind;
      const detached = detachSlot(
        found.block.type,
        stored,
        slot,
        fits ? componentValues(component.kind, component.published) : null,
      );
      if (!detached) return { unreadable: true } as const;
      // The detached content goes through the block validator like any other
      // save; the references that remain on the section ride beside it.
      const values = withReuse(
        validateBlockValues(found.block, { ...emptyValues(found.block), ...detached }),
        readReuse(detached, found.block.type),
      );
      const result = await updateSectionGuardedIn(tx, sectionId, expected, {
        draft: values,
        updatedBy: session.user.id,
      });
      return { result, values, name: component?.name ?? null } as const;
    });

    if ("stale" in outcome) {
      return {
        ok: false,
        reason: "component_conflict",
        message:
          "The reusable component was published again since this page was loaded. Nothing was detached — " +
          "reload the canvas to see its current content, then detach again.",
      };
    }
    if ("unreadable" in outcome) return { ok: false, reason: "invalid", message: MESSAGES.invalid };
    if (!outcome.result.ok) {
      if (outcome.result.reason === "missing") return { ok: false, reason: "missing", message: MESSAGES.missing };
      const fresh = await ownedSection(sectionId, pageId);
      if (!fresh.ok) return fresh;
      return { ok: false, reason: "conflict", message: MESSAGES.conflict, section: toData(fresh.row, fresh.block) };
    }

    await logActivity(session, {
      action: "reusable_component.instance_detached",
      entityType: "reusable_component",
      entityId: ref.c,
      summary:
        `Detached the ${slotDef(found.block.type, slot)?.label.toLowerCase() ?? slot} of a ${found.block.name} ` +
        `section (#${sectionId}) from ${outcome.name ? `“${outcome.name}”` : "a reusable component"} in a page draft`,
      metadata: { sectionId, slot, version: expectedVersion },
    });
    revalidatePath("/admin/pages");

    return {
      ok: true,
      section: {
        ...toData(found.row, found.block),
        revision: outcome.result.revision,
        hasDraft: true,
        values: outcome.values,
      },
    };
  } catch (error) {
    if (error instanceof AccessError) return { ok: false, reason: "denied", message: error.message };
    console.error("[visual-editor:detach]", error);
    return { ok: false, reason: "invalid", message: "Something went wrong. Nothing was detached." };
  }
}

/**
 * Saves one section's visual overrides as a draft. Never publishes.
 *
 * The same shape as the content save and deliberately so: same door
 * (`guardAction`), same ownership check, same revision guard, same one-column
 * write. What differs is which column — `draft_styles` rather than `draft` —
 * and that difference is the whole of the separation between the two domains.
 * A style save must be able to land while somebody has unsaved text in the
 * panel, and vice versa, so neither may write the other's column even with
 * what it believes to be the current value.
 *
 * `null` versus empty is decided here too. The document is stored as
 * whatever `validateStyleDocument` makes of it, which for a fully reset
 * section is `{ v: 1, nodes: {} }` — a real draft meaning "publishing me
 * removes every override". Storing `null` for that would be storing "there is
 * nothing pending", and publishing would then leave the overrides in place.
 */
export async function saveVisualSectionStyles(form: FormData): Promise<VisualStyleSaveResult> {
  try {
    const session = await guardAction("content.manage", form);

    const sectionId = Number(form.get("sectionId"));
    const pageId = Number(form.get("pageId"));
    const expected = Number(form.get("expectedRevision"));

    const found = await ownedSection(sectionId, pageId);
    if (!found.ok) return found;

    let submitted: unknown;
    try {
      submitted = JSON.parse(String(form.get("styles") ?? ""));
    } catch {
      return { ok: false, reason: "invalid", message: MESSAGES.invalidStyles };
    }
    if (!Number.isInteger(expected) || expected < 0) {
      return { ok: false, reason: "invalid", message: MESSAGES.invalid };
    }

    /**
     * Rebuilt key by key from the closed vocabulary. Everything the panel did
     * not have any business sending — a selector, a class, a CSS string, a
     * runtime `section:42/…` address, a spacing step off the scale — is simply
     * not in the result, because the result is constructed rather than
     * filtered.
     */
    const styles = validateStyleDocument(submitted);

    const result = await updateSectionGuarded(sectionId, expected, {
      draftStyles: styles,
      updatedBy: session.user.id,
    });

    if (!result.ok) {
      if (result.reason === "missing") {
        return { ok: false, reason: "missing", message: MESSAGES.missing };
      }
      const fresh = await ownedSection(sectionId, pageId);
      if (!fresh.ok) return fresh;
      return {
        ok: false,
        reason: "conflict",
        message: MESSAGES.conflict,
        section: toData(fresh.row, fresh.block),
      };
    }

    await logActivity(session, {
      action: "section.style_draft_saved",
      entityType: "section",
      entityId: sectionId,
      summary: `Saved a style draft for the ${found.block.name} section`,
    });

    const [page] = await db
      .select({ slug: pages.slug })
      .from(pages)
      .where(eq(pages.id, found.row.pageId))
      .limit(1);
    if (page) revalidatePath(`/admin/pages/${page.slug}`);
    revalidatePath("/admin/pages");

    // What was stored, not what was sent: the panel adopts the validated
    // document so the controls agree with the database.
    return { ok: true, revision: result.revision, styles };
  } catch (error) {
    if (error instanceof AccessError) return { ok: false, reason: "denied", message: error.message };
    console.error("[visual-editor:styles]", error);
    return { ok: false, reason: "invalid", message: "Something went wrong. The change was not saved." };
  }
}

/**
 * Saves one section's entrance as a draft. Never publishes.
 *
 * The third of three identical shapes, and the sameness is the point: same
 * door (`guardAction`, so the session's CSRF token and `content.manage` are
 * both checked), same ownership check against the row rather than against what
 * was asked, same revision guard, same one-column write, same conflict answer
 * carrying the version that won. A domain that let itself in a different way
 * would be the weakest lock on the site, and a domain that guarded itself
 * differently would be the one that loses somebody's work.
 *
 * What it writes is the motion *draft* — `draft_motion_config` and
 * `draft_animation`, together — and only that. `motion_config` and `animation`
 * are what the live page renders, and the whole of the motion promise — editing
 * motion does not change the live site until the motion draft is published — is
 * that this action cannot reach them.
 *
 * A preset is read by `readMotion`, the single validator, which accepts the
 * five exactly, and a document by `validateMotionDocument`, which rebuilds it
 * from the closed vocabulary. There is no fallback to a default: a preset
 * outside the vocabulary is a stale or tampered request, and storing a guess
 * for it would report success while leaving the section moving in a way nobody
 * chose.
 */
export async function saveVisualSectionMotion(form: FormData): Promise<VisualMotionSaveResult> {
  try {
    const session = await guardAction("content.manage", form);

    const sectionId = Number(form.get("sectionId"));
    const pageId = Number(form.get("pageId"));
    const expected = Number(form.get("expectedRevision"));

    const found = await ownedSection(sectionId, pageId);
    if (!found.ok) return found;

    if (!Number.isInteger(expected) || expected < 0) {
      return { ok: false, reason: "invalid", message: MESSAGES.invalid };
    }

    /**
     * Two shapes of request, one decision.
     *
     * The Visual Editor sends `motionDocument` — the whole advanced document,
     * JSON. Older callers send `motion`, a single preset. Either way the answer
     * is written through `motion-write`, which produces **both** draft columns:
     * the document, and its legacy projection for the release a rollback would
     * return to. Neither shape can write one column without the other.
     *
     * A document is rebuilt key by key against the closed vocabulary and cut
     * down to what this block's nodes can carry, so a selector, a CSS string, a
     * runtime address, an off-grid delay or an entrance on an element that
     * already animates itself is simply not in what is stored.
     *
     * Something that is not a document of a version this build knows is
     * refused outright rather than read as the empty document. Reading may
     * fail closed that way; a *write* may not, because an empty draft is a
     * real one — publishing it would remove every advanced motion the section
     * has, on the strength of a request nobody could have meant.
     */
    const rawDocument = form.get("motionDocument");
    let draft;
    if (rawDocument !== null) {
      let submitted: unknown;
      try {
        submitted = JSON.parse(String(rawDocument));
      } catch {
        return { ok: false, reason: "invalid", message: MESSAGES.invalidMotion };
      }
      if (!isReadableMotionDocument(submitted)) {
        return { ok: false, reason: "invalid", message: MESSAGES.invalidMotion };
      }
      draft = motionDraftFromDocument(found.row, found.block.type, submitted);
    } else {
      const preset = readMotion(form.get("motion"));
      if (!preset) return { ok: false, reason: "invalid", message: MESSAGES.invalidMotion };
      draft = motionDraftFromPreset(found.row, found.block.type, preset);
    }

    /**
     * Stored even when it matches what is published.
     *
     * Deliberately different from the ordinary admin form, which folds a
     * matching choice back to `null` because motion rides along with a content
     * save there and an editor who never touched the menu must not acquire a
     * draft. Here the editor changed motion specifically, so the draft is what
     * they asked for — and `"none"` beside a published `"none"` is still a
     * real, publishable "leave this section still".
     *
     * One guarded update for both columns: they share the section's revision
     * with content and style, and a motion save that could land half of itself
     * would be a motion domain that could disagree with itself.
     */
    const result = await updateSectionGuarded(sectionId, expected, {
      draftAnimation: draft.draftAnimation,
      ...(draft.draftMotionConfig ? { draftMotionConfig: draft.draftMotionConfig } : {}),
      updatedBy: session.user.id,
    });

    if (!result.ok) {
      if (result.reason === "missing") {
        return { ok: false, reason: "missing", message: MESSAGES.missing };
      }
      const fresh = await ownedSection(sectionId, pageId);
      if (!fresh.ok) return fresh;
      return {
        ok: false,
        reason: "conflict",
        message: MESSAGES.conflict,
        section: toData(fresh.row, fresh.block),
      };
    }

    await logActivity(session, {
      action: "section.motion_draft_saved",
      entityType: "section",
      entityId: sectionId,
      summary: `Saved a motion draft for the ${found.block.name} section`,
    });

    const [page] = await db
      .select({ slug: pages.slug })
      .from(pages)
      .where(eq(pages.id, found.row.pageId))
      .limit(1);
    if (page) revalidatePath(`/admin/pages/${page.slug}`);
    revalidatePath("/admin/pages");

    return {
      ok: true,
      revision: result.revision,
      motion: draft.draftAnimation,
      motionDocument: draft.draftMotionConfig,
      legacyEntrance: legacyFallback({
        ...found.row,
        draftAnimation: draft.draftAnimation,
        draftMotionConfig: draft.draftMotionConfig ?? found.row.draftMotionConfig,
      }),
    };
  } catch (error) {
    if (error instanceof AccessError) return { ok: false, reason: "denied", message: error.message };
    console.error("[visual-editor:motion]", error);
    return { ok: false, reason: "invalid", message: "Something went wrong. The change was not saved." };
  }
}

/* -------------------------------------------------------------------------- */
/* Structure                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The layout half of the editor: one thin adapter per operation.
 *
 * Every one of these is the same three steps — check the permission and the
 * token, read the page revision the *screen* was built from, hand both to
 * `cms/structure-service` — and the interesting part is what they deliberately
 * do not do. They do not decide what reordering means, they do not write a row,
 * and they do not infer a revision when the form did not carry one. The Pages
 * screen's own structural actions are the same three steps around the same
 * primitives, so the two surfaces cannot drift into disagreeing about what a
 * page's layout is, and one counter guards both.
 *
 * Nothing here publishes a layout. The service has no operation that could.
 */

const structureFailure = (result: StructureResult & { ok: false }): VisualStructureResult => ({
  ok: false,
  reason: result.reason === "conflict" ? "conflict" : "invalid",
  message: result.message,
});

/** The page revision the screen that submitted this carried. */
const expectedPageRevision = (form: FormData): number => {
  const value = Number(form.get("expectedRevision"));
  return Number.isInteger(value) && value >= 0 ? value : -1;
};

async function runStructure(
  form: FormData,
  operate: (context: { pageId: number; expectedRevision: number; userId: number }) => Promise<StructureResult>,
  label: string,
): Promise<VisualStructureResult> {
  try {
    const session = await guardAction("content.manage", form);
    const pageId = Number(form.get("pageId"));
    const expectedRevision = expectedPageRevision(form);

    const result = await operate({ pageId, expectedRevision, userId: session.user.id });
    if (!result.ok) return structureFailure(result);

    await logActivity(session, result.log);
    if (result.also) await logActivity(session, result.also);

    const [page] = await db.select({ slug: pages.slug }).from(pages).where(eq(pages.id, pageId)).limit(1);
    if (page) revalidatePath(`/admin/pages/${page.slug}`);
    revalidatePath("/admin/pages");

    const structure = await getPageStructure(pageId);
    return {
      ok: true,
      revision: result.revision,
      sectionId: result.sectionId ?? null,
      message: result.message,
      structure,
    };
  } catch (error) {
    if (error instanceof AccessError) return { ok: false, reason: "denied", message: error.message };
    console.error(`[visual-editor:${label}]`, error);
    return { ok: false, reason: "invalid", message: "Something went wrong. Nothing was changed." };
  }
}

/**
 * The page's layout, for the editor to draw Layers and the removed list from.
 *
 * `content.view`, like reading a section: this says what the preview beside it
 * is already showing plus which sections it is leaving out, and a reader who
 * can see the page can see that.
 */
export async function loadPageStructure(pageId: number): Promise<PageStructure | null> {
  try {
    const session = await getSession();
    if (!session?.permissions.has("content.view")) return null;
    return await getPageStructure(pageId);
  } catch (error) {
    console.error("[visual-editor:structure]", error);
    return null;
  }
}

export async function reorderPageStructure(form: FormData): Promise<VisualStructureResult> {
  let order: number[] = [];
  try {
    const parsed = JSON.parse(String(form.get("order") ?? "[]")) as unknown;
    // A list that cannot be read is not an empty list: `-1` is no page's
    // section, so it fails the permutation check rather than reordering nothing.
    order = Array.isArray(parsed) ? parsed.map(Number) : [-1];
  } catch {
    order = [-1];
  }
  return runStructure(form, (context) => reorderStructure(context, order), "reorder");
}

export async function setPageSectionVisibility(form: FormData): Promise<VisualStructureResult> {
  // Two accepted strings and nothing else. Reading anything unrecognised as
  // "hide" would let a malformed request take a section out of the published
  // layout — the one direction an ambiguous value must never resolve in.
  const visible = readVisibility(form.get("visible"));
  if (visible === null) {
    return { ok: false, reason: "invalid", message: "That request could not be read. Reload the layout." };
  }
  return runStructure(
    form,
    (context) => setStructureVisibility(context, Number(form.get("sectionId")), visible),
    "visibility",
  );
}

export async function addPageSection(form: FormData): Promise<VisualStructureResult> {
  const after = Number(form.get("afterSectionId"));
  // A reusable block (Batch 17) is the same operation with a component to
  // link: an id, and nothing else from the request — its kind, status and
  // content are read by the structure service.
  const component = form.get("componentId");
  const componentId = component === null || component === "" ? undefined : Number(component);
  return runStructure(
    form,
    (context) =>
      addStructureSection(
        context,
        String(form.get("blockType") ?? ""),
        Number.isInteger(after) && after > 0 ? after : null,
        componentId === undefined ? {} : { componentId },
      ),
    "add",
  );
}

export async function duplicatePageSection(form: FormData): Promise<VisualStructureResult> {
  return runStructure(
    form,
    (context) => duplicateStructureSection(context, Number(form.get("sectionId"))),
    "duplicate",
  );
}

export async function removePageSection(form: FormData): Promise<VisualStructureResult> {
  return runStructure(
    form,
    (context) => removeStructureSection(context, Number(form.get("sectionId"))),
    "remove",
  );
}

export async function restorePageSection(form: FormData): Promise<VisualStructureResult> {
  /**
   * An exact placement, when Undo or Redo asks for one (Batch 16): the member
   * to go in front of, by id (`end` for the end), and the visibility to come
   * back with. Both or neither — half a placement is not something to guess
   * the rest of — and each read strictly, so a malformed one is refused rather
   * than turned into "near its live position".
   */
  let placement: RestorePlacement | undefined;
  if (form.get("placement") !== null) {
    const rawBefore = String(form.get("beforeSectionId") ?? "");
    const before = rawBefore === "end" ? null : Number(rawBefore);
    const visible = readVisibility(form.get("visible"));
    if (visible === null || (before !== null && (!Number.isInteger(before) || before <= 0))) {
      return { ok: false, reason: "invalid", message: "That request could not be read. Reload the layout." };
    }
    placement = { beforeSectionId: before, visible };
  }
  return runStructure(
    form,
    (context) => restoreStructureSection(context, Number(form.get("sectionId")), placement),
    "restore",
  );
}

export async function discardPageLayout(form: FormData): Promise<VisualStructureResult> {
  return runStructure(form, (context) => discardLayoutDraft(context), "discard");
}

/* -------------------------------------------------------------------------- */
/* The page: summary, publication, discard, history                           */
/* -------------------------------------------------------------------------- */

/**
 * The page-level half of the editor, and the only part of it that is not a
 * draft.
 *
 * Everything above this line writes a draft column and nothing else. These four
 * are where a page's saved work becomes the live site, goes away, or comes back
 * from history — and all four are thin adapters over `cms/publish-service` and
 * `lib/versions`, which the Pages screen calls too. One primitive per act, two
 * surfaces, so the editor and the admin cannot come to mean different things by
 * "publish this page".
 *
 * The counts a review shows come from `getPageDraftSummary`, never from the
 * panel's own buffers: the browser is the one participant here that is allowed
 * to be out of date, and a confirmation built from it would promise to publish
 * whatever that tab happened to know about.
 */

export async function loadPageSummary(pageId: number): Promise<PageSummaryView | null> {
  try {
    const session = await getSession();
    if (!session?.permissions.has("content.view")) return null;
    return await getPageDraftSummary(pageId);
  } catch (error) {
    console.error("[visual-editor:summary]", error);
    return null;
  }
}

/** `content.view`, because a reader who can see the page can see its history. */
export async function loadPageHistory(pageId: number): Promise<PageHistoryView | null> {
  try {
    const session = await getSession();
    if (!session?.permissions.has("content.view")) return null;
    if (!Number.isInteger(pageId) || pageId <= 0) return null;
    const versions = await listPageVersions(pageId, KEEP_PAGE_VERSIONS);
    return {
      pageId,
      keep: KEEP_PAGE_VERSIONS,
      versions: versions.map((row) => ({
        id: row.id,
        label: row.label,
        actorName: row.actorName,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  } catch (error) {
    console.error("[visual-editor:history]", error);
    return null;
  }
}

const pageFailure = (reason: string, message: string): PageActionResult => ({
  ok: false,
  reason,
  message,
});

async function pageSlug(pageId: number): Promise<string | null> {
  const [page] = await db.select({ slug: pages.slug }).from(pages).where(eq(pages.id, pageId)).limit(1);
  return page?.slug ?? null;
}

export async function publishPageFromEditor(form: FormData): Promise<PageActionResult> {
  try {
    const session = await guardAction("content.manage", form);
    const pageId = Number(form.get("pageId"));
    const expectedRevision = expectedPageRevision(form);

    const result = await publishPageChanges({
      pageId,
      expectedRevision,
      userId: session.user.id,
      actorName: session.user.name,
    });
    if (!result.ok) return pageFailure(result.reason, result.message);

    await logActivity(session, {
      action: "page.changes_published",
      entityType: "page",
      entityId: pageId,
      summary: result.summary,
    });

    /**
     * A publication changes what a visitor gets, so — unlike every draft save
     * in this module — it drops the public cache.
     *
     * By **tag**, not by path. `getPage` is an `unstable_cache` entry keyed on
     * the slug and tagged `TAGS.pages`; revalidating the route alone leaves
     * that entry in place, so the page would keep serving the composition it
     * had before. This is the same `revalidate(TAGS.pages)` the Pages screen's
     * own publish paths use, and using anything else here is how the two
     * surfaces would come to publish to different caches.
     */
    revalidate(TAGS.pages);
    const slug = await pageSlug(pageId);
    if (slug) revalidatePath(`/admin/pages/${slug}`);
    revalidatePath("/admin/pages");
    return { ok: true, revision: result.revision, message: result.message };
  } catch (error) {
    if (error instanceof AccessError) return pageFailure("denied", error.message);
    console.error("[visual-editor:publish]", error);
    return pageFailure("invalid", "Something went wrong. Nothing was published.");
  }
}

export async function discardPageFromEditor(form: FormData): Promise<PageActionResult> {
  try {
    const session = await guardAction("content.manage", form);
    const pageId = Number(form.get("pageId"));
    const expectedRevision = expectedPageRevision(form);

    const result = await discardPageChanges({ pageId, expectedRevision, userId: session.user.id });
    if (!result.ok) return pageFailure(result.reason, result.message);

    await logActivity(session, {
      action: "page.drafts_discarded",
      entityType: "page",
      entityId: pageId,
      summary: "Discarded the saved changes on this page",
    });

    const slug = await pageSlug(pageId);
    if (slug) revalidatePath(`/admin/pages/${slug}`);
    revalidatePath("/admin/pages");
    return { ok: true, revision: result.revision, message: result.message };
  } catch (error) {
    if (error instanceof AccessError) return pageFailure("denied", error.message);
    console.error("[visual-editor:discard]", error);
    return pageFailure("invalid", "Something went wrong. Nothing was discarded.");
  }
}

export async function restoreVersionFromEditor(form: FormData): Promise<PageActionResult> {
  try {
    const session = await guardAction("content.manage", form);
    const pageId = Number(form.get("pageId"));
    const versionId = Number(form.get("versionId"));

    const summary = await getPageDraftSummary(pageId);
    if (!summary) return pageFailure("missing", "That page no longer exists.");
    if (restoreBlockers(summary)) return pageFailure("not_clean", RESTORE_BLOCKED);

    const result = await restoreVersionToDraft(versionId, pageId, { userId: session.user.id });
    if (!result.ok) {
      const message =
        result.reason === "not_clean"
          ? RESTORE_BLOCKED
          : result.reason === "unsupported"
            ? "That version was saved by a different build and cannot be restored here. The live page is unchanged."
            : result.reason === "wrong_page"
              ? "That version belongs to a different page."
              : result.reason === "missing"
                ? "That version no longer exists."
                : "The page changed while restoring. Nothing was restored — reload and try again.";
      return pageFailure(result.reason, message);
    }

    await logActivity(session, {
      action: "page.version_restored_to_draft",
      entityType: "page",
      entityId: pageId,
      summary: `Restored version #${versionId} into saved changes`,
    });

    // Drafts only: nothing a visitor sees moved, so the public cache stands.
    const slug = await pageSlug(pageId);
    if (slug) revalidatePath(`/admin/pages/${slug}`);
    revalidatePath("/admin/pages");

    const [page] = await db.select({ revision: pages.revision }).from(pages).where(eq(pages.id, pageId)).limit(1);
    return {
      ok: true,
      revision: page?.revision ?? 0,
      message:
        "Restored into saved changes. Preview the page, then publish when you are ready — the live site has not changed.",
    };
  } catch (error) {
    if (error instanceof AccessError) return pageFailure("denied", error.message);
    console.error("[visual-editor:restore]", error);
    return pageFailure("invalid", "Something went wrong. Nothing was restored.");
  }
}

/* -------------------------------------------------------------------------- */
/* Global site chrome                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Re-read the global state the Globals panel is allowed to hold.
 *
 * A read, and the only one this module adds for globals: every *write* is the
 * ordinary Navigation or Site settings action, called directly, so the two
 * admin surfaces share one validator, one permission check, one audit
 * vocabulary and one set of cache tags. Adding a second set here is how they
 * would come to disagree.
 *
 * `loadEditorGlobals` is scoped to what the session may manage, so a caller
 * without `settings.manage` gets `settings: null` — not a disabled copy of it.
 * Returning an empty shape rather than throwing keeps a refusal from looking
 * like a broken panel, and the panel says which halves it has.
 */
export async function loadEditorGlobals(): Promise<GlobalsState> {
  try {
    const session = await getSession();
    // The editor's own door: anybody reaching this without it has no business
    // holding site chrome either.
    if (!session?.permissions.has("visual_editor.view")) return { navigation: null, settings: null };
    if (!session.permissions.has("content.view")) return { navigation: null, settings: null };
    return await readEditorGlobals(session);
  } catch (error) {
    console.error("[visual-editor:globals]", error);
    return { navigation: null, settings: null };
  }
}
