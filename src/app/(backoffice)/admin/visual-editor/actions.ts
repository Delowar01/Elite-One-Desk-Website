"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { logActivity } from "@/lib/activity";
import { AccessError, guardAction } from "@/lib/auth/guard";
import { getSession } from "@/lib/auth/session";
import { getBlock, type BlockDef } from "@/lib/cms/blocks";
import { parseBlockPayload, validateBlockValues } from "@/lib/cms/validate";
import { emptyValues } from "@/lib/cms/values";
import { db } from "@/lib/db";
import { updateSectionGuarded } from "@/lib/db/revision";
import { pageSections, pages } from "@/lib/db/schema";
import type {
  VisualContentSaveResult,
  VisualSectionData,
  VisualSectionLoad,
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
 * **Nothing here publishes.** The one column a save writes is `draft`
 * (plus the revision, the author and the timestamp, which the guard writes).
 * `published`, `is_published`, `animation`, `styles` and `position` are somebody
 * else's business, and a content save must never move them by accident.
 */

const MESSAGES = {
  denied: "You do not have permission to edit content.",
  missing: "That section no longer exists. Reload the canvas.",
  wrongPage: "That section belongs to a different page. Reload the canvas.",
  unknownBlock: "That section type is no longer available.",
  invalid: "Those values could not be read. Reload the canvas and try again.",
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
  return {
    sectionId: row.id,
    pageId: row.pageId,
    blockType: row.blockType,
    revision: row.revision,
    hasDraft: Boolean(row.draft),
    isDraftOnly: row.isDraftOnly,
    values: validateBlockValues(block, { ...emptyValues(block), ...stored }),
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

    const values = parseBlockPayload(String(form.get("values") ?? ""), found.block);
    if (!values) return { ok: false, reason: "invalid", message: MESSAGES.invalid };
    if (!Number.isInteger(expected) || expected < 0) {
      return { ok: false, reason: "invalid", message: MESSAGES.invalid };
    }

    /**
     * The whole write. `draft` and nothing else — the guard adds `revision`,
     * `updated_at` and takes `updated_by` — so a content save cannot publish,
     * cannot show a hidden section, and cannot disturb motion or styles.
     */
    const result = await updateSectionGuarded(sectionId, expected, {
      draft: values,
      updatedBy: session.user.id,
    });

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
