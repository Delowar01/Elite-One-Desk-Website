import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { updatePageGuarded, updatePageGuardedIn } from "@/lib/db/revision";
import { pageSections, pages, reusableComponents } from "@/lib/db/schema";

import { blocksForPage, getBlock, type BlockDef } from "./blocks";
import { withFreshItemIds, remapMotionItemIds, remapStyleItemIds } from "./duplicate";
import { effectiveMotion } from "./motion";
import { isEmptyMotionDocument, legacyProjection } from "./motion-doc";
import { currentMotionDocument } from "./motion-write";
import { validateStyleDocument } from "./styles";
import { motionForBlock } from "@/lib/visual-editor/motion-targets";
import {
  DRAFT_STRUCTURE_VERSION,
  normalizeDraftStructureForPage,
  readDraftStructure,
  type DraftStructure,
  type DraftStructureEntry,
  type PageStructure,
  type PageStructureSection,
} from "./structure";

export type { PageStructure, PageStructureSection };
import { validateBlockValues } from "./validate";
import { emptyValues, text } from "./values";
import { BLOCK_SLOT, linkSlot, readReuse, referencedIds, withReuse } from "./reuse/reference";
import { componentValues, lockComponents, referenceProblemMessage } from "./reuse/store";

/**
 * Every structural change a page can have, in one place.
 *
 * Two screens edit a page's composition — the Pages list and the Visual
 * Editor's Layers panel — and before this module they did it with two sets of
 * rules. That is not a tidiness problem: the Visual Editor was about to write a
 * *draft* while the Pages list rewrote the live rows, so the same page could be
 * rearranged twice, two different ways, with neither write able to see the
 * other and `pages.revision` protecting neither. Both screens now call the
 * primitives below, so there is one definition of what reordering a page means
 * and one counter guarding it.
 *
 * **Nothing here publishes.** The only column these operations write on
 * `pages` is `draft_structure`, and the only rows they insert are pending ones.
 * A visitor's page is composed from `position` and `is_published`, which no
 * operation in this file moves — reordering, hiding and removing are all edits
 * to a document that says what publishing *would* do. Turning that document
 * into live rows is `cms/publish-service`'s, and deliberately not reachable
 * from here — one module writes the draft, another publishes it.
 *
 * **Structure is the page's timeline, content is the section's.** Every
 * operation names `pages.revision` and nothing else, so one person rewriting a
 * headline and another reordering the page do not collide: they are editing
 * different rows about different things. A stale structural write is refused
 * rather than merged, because the honest answer to "this layout is not the one
 * you were looking at" is to say so.
 */

export type StructureFailure = "conflict" | "missing" | "invalid" | "not_a_member" | "already_here";

/** What the caller should write to the activity log when an operation lands. */
export type StructureLog = {
  action: string;
  entityType: "page" | "section";
  entityId: number;
  summary: string;
};

export type StructureResult =
  | {
      ok: true;
      revision: number;
      sectionId?: number;
      log: StructureLog;
      /**
       * Further entries the operation deserves — one per link a new section
       * makes to a reusable component (Batch 17), whether it was added linked
       * or copied from a linked one (19B).
       */
      also?: {
        action: string;
        entityType: string;
        entityId: number;
        summary: string;
        metadata?: Record<string, unknown>;
      }[];
      message: string;
    }
  | { ok: false; reason: StructureFailure; message: string };

export const STRUCTURE_MESSAGES = {
  missingPage: "That page no longer exists. Reload the layout.",
  missingSection: "That section no longer exists. Reload the layout.",
  wrongPage: "That section belongs to a different page. Reload the layout.",
  notAMember: "That section is not in the layout you are editing. Reload the layout.",
  alreadyHere: "That section is already in the layout.",
  invalidOrder: "That order could not be read. Reload the layout and try again.",
  unreadable: "That request could not be read. Reload the layout and try again.",
  invalidBlock: "Choose a section type.",
  conflict:
    "The page layout changed since you opened it. Reload the latest layout before changing " +
    "the structure.",
} as const;

const fail = (reason: StructureFailure, message: string): StructureResult => ({
  ok: false,
  reason,
  message,
});

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

type SectionRow = typeof pageSections.$inferSelect;

/**
 * The structure to edit when the column holds nothing usable.
 *
 * Established sections only, in the order the live page uses, each carrying the
 * visibility it currently has. Draft-only rows are excluded on purpose: a
 * pending row exists *because* a document listed it, so one that no document
 * lists is an orphan, and seeding it back in would quietly adopt something
 * nobody asked for.
 */
const seedStructure = (rows: readonly SectionRow[]): DraftStructure => ({
  v: DRAFT_STRUCTURE_VERSION,
  sections: rows
    .filter((row) => !row.isDraftOnly)
    .map((row) => ({ sectionId: row.id, visible: row.isPublished })),
});

/**
 * The document being edited, and whether it came from the column.
 *
 * `readDraftStructure` answers `null` for absent *and* for unreadable, and the
 * two fall together here on purpose: neither is something to act on, and the
 * established page is the safe reading of both. `keepOmitted: false` is what
 * makes an omission mean something — the shape validator would otherwise put
 * every unlisted section back, which is exactly the "helpfully append" that
 * turns a pending removal into a no-op.
 */
function effectiveStructure(
  page: typeof pages.$inferSelect,
  rows: readonly SectionRow[],
): { structure: DraftStructure; hasDraftStructure: boolean } {
  const stored = readDraftStructure(page.draftStructure);
  if (!stored) return { structure: seedStructure(rows), hasDraftStructure: false };
  return {
    structure: normalizeDraftStructureForPage(
      stored,
      rows.map((row) => row.id),
      { keepOmitted: false },
    ),
    hasDraftStructure: true,
  };
}

const summarise = (row: SectionRow): string => {
  const values = (row.draft ?? row.published) as Record<string, unknown>;
  return (
    text(values, "title", "en") ||
    text(values, "headline", "en") ||
    text(values, "eyebrow", "en") ||
    ""
  );
};

async function loadPage(pageId: number) {
  if (!Number.isInteger(pageId) || pageId <= 0) return null;
  const [page] = await db.select().from(pages).where(eq(pages.id, pageId)).limit(1);
  if (!page) return null;
  const rows = await db
    .select()
    .from(pageSections)
    .where(eq(pageSections.pageId, pageId))
    .orderBy(asc(pageSections.position), asc(pageSections.id));
  return { page, rows };
}

/** One page's structural state, or `null` when there is no such page. */
export async function getPageStructure(pageId: number): Promise<PageStructure | null> {
  const loaded = await loadPage(pageId);
  if (!loaded) return null;
  const { page, rows } = loaded;
  const { structure, hasDraftStructure } = effectiveStructure(page, rows);

  return {
    pageId: page.id,
    slug: page.slug,
    title: page.titleEn,
    revision: page.revision,
    hasDraftStructure,
    structure,
    sections: rows.map((row) => ({
      sectionId: row.id,
      blockType: row.blockType,
      blockName: getBlock(row.blockType)?.name ?? row.blockType,
      summary: summarise(row),
      isDraftOnly: row.isDraftOnly,
      publishedPosition: row.position,
      publishedVisible: row.isPublished,
      reuse: Object.entries(readReuse(row.draft ?? row.published, row.blockType)).map(([slot, ref]) => ({
        slot,
        componentId: ref.c,
      })),
    })),
  };
}

/* -------------------------------------------------------------------------- */
/* Writing                                                                    */
/* -------------------------------------------------------------------------- */

type Context = { pageId: number; expectedRevision: number; userId: number };

const validRevision = (value: number) => Number.isInteger(value) && value >= 0;

const guardFailure = (reason: "conflict" | "missing"): StructureResult =>
  reason === "missing"
    ? fail("missing", STRUCTURE_MESSAGES.missingPage)
    : fail("conflict", STRUCTURE_MESSAGES.conflict);

const document = (sections: DraftStructureEntry[]): DraftStructure => ({
  v: DRAFT_STRUCTURE_VERSION,
  sections,
});

/** Loads the page, its rows and the structure being edited, or says why not. */
async function open(context: Context) {
  if (!validRevision(context.expectedRevision)) {
    return { ok: false as const, result: fail("invalid", STRUCTURE_MESSAGES.unreadable) };
  }
  const loaded = await loadPage(context.pageId);
  if (!loaded) return { ok: false as const, result: fail("missing", STRUCTURE_MESSAGES.missingPage) };
  const { structure } = effectiveStructure(loaded.page, loaded.rows);
  return { ok: true as const, page: loaded.page, rows: loaded.rows, structure };
}

/**
 * A whole new order, committed once.
 *
 * The submitted list has to be a **permutation** of what the structure already
 * holds — same ids, same count, no repeats, nothing foreign. Filtering it into
 * shape instead would make two different mistakes look like success: a section
 * belonging to another page would be quietly dropped rather than refused, and a
 * stale screen missing a section somebody else added would read as a deliberate
 * removal of it. Visibility is carried across from the existing entries, because
 * reordering is not an opinion about what is shown.
 */
export async function reorderStructure(
  context: Context,
  order: readonly number[],
): Promise<StructureResult> {
  const opened = await open(context);
  if (!opened.ok) return opened.result;

  const current = opened.structure.sections;
  const byId = new Map(current.map((entry) => [entry.sectionId, entry]));
  const seen = new Set<number>();

  if (order.length !== current.length) return fail("invalid", STRUCTURE_MESSAGES.invalidOrder);
  const next: DraftStructureEntry[] = [];
  for (const id of order) {
    const entry = byId.get(id);
    if (!entry || seen.has(id)) return fail("invalid", STRUCTURE_MESSAGES.invalidOrder);
    seen.add(id);
    next.push(entry);
  }

  const result = await updatePageGuarded(context.pageId, context.expectedRevision, {
    draftStructure: document(next),
    updatedBy: context.userId,
  });
  if (!result.ok) return guardFailure(result.reason);

  return {
    ok: true,
    revision: result.revision,
    message: "Layout order saved to the draft.",
    log: {
      action: "page.layout_reordered",
      entityType: "page",
      entityId: context.pageId,
      summary: `Reordered the layout draft for “${opened.page.slug}”`,
    },
  };
}

/**
 * What publishing would do with one section: show it, or leave it out.
 *
 * Writes `visible` on the entry and nothing else. `page_sections.is_published`
 * is what the live page reads and it is not touched here, which is the whole
 * distinction — this is an intention, and the site keeps doing what it is doing
 * until the layout is published.
 */
export async function setStructureVisibility(
  context: Context,
  sectionId: number,
  visible: boolean,
): Promise<StructureResult> {
  const opened = await open(context);
  if (!opened.ok) return opened.result;

  const entry = opened.structure.sections.find((row) => row.sectionId === sectionId);
  if (!entry) return fail("not_a_member", STRUCTURE_MESSAGES.notAMember);
  const row = opened.rows.find((candidate) => candidate.id === sectionId)!;

  const next = opened.structure.sections.map((candidate) =>
    candidate.sectionId === sectionId ? { ...candidate, visible } : candidate,
  );

  const result = await updatePageGuarded(context.pageId, context.expectedRevision, {
    draftStructure: document(next),
    updatedBy: context.userId,
  });
  if (!result.ok) return guardFailure(result.reason);

  return {
    ok: true,
    revision: result.revision,
    sectionId,
    message: visible
      ? "It will be shown when the layout is published."
      : "It will be hidden when the layout is published.",
    log: {
      action: visible ? "section.layout_shown" : "section.layout_hidden",
      entityType: "section",
      entityId: sectionId,
      summary: `${visible ? "Showed" : "Hid"} the ${row.blockType} section in the layout draft`,
    },
  };
}

/** Where a new id goes: after an anchor that is in the layout, or at the end. */
function insertAfter(
  sections: readonly DraftStructureEntry[],
  entry: DraftStructureEntry,
  afterSectionId: number | null,
): DraftStructureEntry[] | null {
  if (afterSectionId === null) return [...sections, entry];
  const at = sections.findIndex((row) => row.sectionId === afterSectionId);
  if (at < 0) return null;
  return [...sections.slice(0, at + 1), entry, ...sections.slice(at + 1)];
}

const nextPosition = (rows: readonly SectionRow[]): number =>
  rows.reduce((highest, row) => Math.max(highest, row.position), -1) + 1;

/**
 * Adds a section to the layout draft.
 *
 * The row is created `isDraftOnly` and unpublished, so the live composition —
 * which is `is_published AND NOT is_draft_only` — cannot see it whatever else
 * happens. Its `position` is appended past the current maximum rather than
 * inserted, because `position` is the *live* order and renumbering established
 * rows to make room for something nobody has published would change the live
 * page. Where it actually sits is the document's business.
 *
 * Row and document are written in one transaction with the page guard checked
 * inside it, so a page that moved underneath the insert takes the insert back
 * with it. There is no state in which a section exists and no layout mentions
 * it.
 */
export async function addStructureSection(
  context: Context,
  blockType: string,
  afterSectionId: number | null,
  options: { componentId?: number } = {},
): Promise<StructureResult> {
  const opened = await open(context);
  if (!opened.ok) return opened.result;

  const block = getBlock(blockType);
  const addable = blocksForPage(opened.page.slug).some((candidate) => candidate.type === blockType);
  if (!block || !addable) return fail("invalid", STRUCTURE_MESSAGES.invalidBlock);
  if (afterSectionId !== null && !opened.structure.sections.some((e) => e.sectionId === afterSectionId)) {
    return fail("not_a_member", STRUCTURE_MESSAGES.notAMember);
  }
  const componentId = options.componentId;
  if (componentId !== undefined && (!Number.isInteger(componentId) || componentId <= 0)) {
    return fail("invalid", STRUCTURE_MESSAGES.unreadable);
  }

  let values = emptyValues(block);
  let created = 0;
  let revision = 0;
  let conflict: "conflict" | "missing" | null = null;
  let refused: string | null = null;
  let linkedName: string | null = null;

  await db.transaction(async (tx) => {
    /**
     * A reusable block (Batch 17): the new section is an instance of the
     * component from the moment it exists — one structural action, so one
     * Undo takes it away. The component is read here, held `FOR SHARE`, and
     * must be a published, active component of this block's kind; its
     * published content becomes the section's fallback copy. Nothing about it
     * is taken from the request but its id.
     */
    if (componentId !== undefined) {
      const [component] = await tx
        .select({
          kind: reusableComponents.kind,
          name: reusableComponents.name,
          status: reusableComponents.status,
          published: reusableComponents.published,
          publishedVersion: reusableComponents.publishedVersion,
        })
        .from(reusableComponents)
        .where(eq(reusableComponents.id, componentId))
        .limit(1)
        .for("share");
      const reason = !component
        ? ("missing" as const)
        : component.kind !== `block:${blockType}`
          ? ("kind" as const)
          : component.publishedVersion < 1
            ? ("unpublished" as const)
            : component.status === "archived"
              ? ("archived" as const)
              : null;
      const published = component ? componentValues(component.kind, component.published) : null;
      const linked =
        !reason && published
          ? linkSlot(blockType, values, BLOCK_SLOT, { id: componentId, kind: component!.kind, values: published })
          : null;
      if (!linked) {
        refused = referenceProblemMessage({
          componentId,
          slot: BLOCK_SLOT,
          reason: reason ?? "kind",
          name: component?.name ?? null,
        });
        tx.rollback();
      }
      values = linked!;
      linkedName = component!.name;
    }

    const [row] = await tx
      .insert(pageSections)
      .values({
        pageId: context.pageId,
        blockType,
        position: nextPosition(opened.rows),
        isPublished: false,
        isDraftOnly: true,
        // Both columns, so the section is editable immediately and publishing
        // the layout later has something to promote rather than a null.
        published: values,
        draft: values,
      })
      .returning({ id: pageSections.id });
    created = row!.id;

    const next = insertAfter(
      opened.structure.sections,
      { sectionId: created, visible: true },
      afterSectionId,
    )!;

    const guard = await updatePageGuardedIn(tx, context.pageId, context.expectedRevision, {
      draftStructure: document(next),
      updatedBy: context.userId,
    });
    if (!guard.ok) {
      conflict = guard.reason;
      // Takes the row with it. A pending section no document lists would be a
      // block that exists and cannot be reached.
      tx.rollback();
    }
    revision = guard.ok ? guard.revision : 0;
  }).catch((error) => {
    // `tx.rollback()` throws by design; anything else is a real failure.
    if (!conflict && !refused) throw error;
  });

  if (refused) return fail("invalid", refused);
  if (conflict) return guardFailure(conflict);

  return {
    ok: true,
    revision,
    sectionId: created,
    message: linkedName
      ? `${block.name} linked to “${linkedName}” added to the layout draft. Preview the page before publishing the layout.`
      : `${block.name} added to the layout draft. Preview the page before publishing the layout.`,
    log: {
      action: "section.layout_added",
      entityType: "section",
      entityId: created,
      summary: linkedName
        ? `Added a ${block.name} section linked to “${linkedName}” to the layout draft for “${opened.page.slug}”`
        : `Added a ${block.name} section to the layout draft for “${opened.page.slug}”`,
    },
    ...(linkedName && componentId !== undefined
      ? {
          also: [
            {
              action: "reusable_component.instance_linked",
              // The entity is the component the new section links to.
              entityType: "reusable_component",
              entityId: componentId,
              summary: `Linked a new ${block.name} section on “${opened.page.slug}” in a layout draft`,
              metadata: { sectionId: created, slot: BLOCK_SLOT },
            },
          ],
        }
      : {}),
  };
}

/**
 * Copies a section, content and styles, into the layout draft below the
 * original.
 *
 * What is copied is what the editor is looking at — the draft when there is
 * one, the published values otherwise — and both halves go through their own
 * validator on the way in, so a row stored before a field existed produces a
 * complete copy rather than propagating the gap. The copy's repeatable rows get
 * fresh identities and its style document is remapped onto them in the same
 * pass; see `cms/duplicate.ts` for why that is worth the extra code.
 *
 * The original is read and never written — not its ids, not its position, not
 * the positions of anything below it.
 */
export async function duplicateStructureSection(
  context: Context,
  sectionId: number,
): Promise<StructureResult> {
  const opened = await open(context);
  if (!opened.ok) return opened.result;

  const source = opened.rows.find((row) => row.id === sectionId);
  if (!source) return fail("missing", STRUCTURE_MESSAGES.missingSection);
  if (!opened.structure.sections.some((entry) => entry.sectionId === sectionId)) {
    return fail("not_a_member", STRUCTURE_MESSAGES.notAMember);
  }
  const block: BlockDef | undefined = getBlock(source.blockType);
  if (!block) return fail("invalid", STRUCTURE_MESSAGES.invalidBlock);

  const seen = (source.draft ?? source.published) as Record<string, unknown>;
  const { values: renamed, ids } = withFreshItemIds({ ...emptyValues(block), ...seen });
  /**
   * A copy of a linked section is another instance of the SAME component
   * (Batch 17): the reference and its overrides are carried across, so the
   * copy follows the component exactly as the original does, and "Used on"
   * counts one more. The validator drops the reference like any undeclared
   * key, so it is carried beside it rather than through it.
   */
  const links = readReuse(seen, block.type);
  const copiedValues = withReuse(validateBlockValues(block, renamed), links);
  const copiedStyles = remapStyleItemIds(
    validateStyleDocument(source.draftStyles !== null ? source.draftStyles : source.styles),
    ids,
  );
  /**
   * Motion, copied the way styles are: what the original previews with — its
   * motion draft when there is one — remapped onto the copy's fresh row ids and
   * cut down to what the block can carry. The preset beside it is the copy's
   * own projection of that document, so the pair it publishes is coherent.
   */
  const sourceMotion = currentMotionDocument(source);
  const copiedMotion = sourceMotion
    ? motionForBlock(remapMotionItemIds(sourceMotion, ids), source.blockType)
    : null;

  let created = 0;
  let revision = 0;
  let conflict: "conflict" | "missing" | null = null;
  let refused: string | null = null;

  await db.transaction(async (tx) => {
    /**
     * The components the copy will refer to, held `FOR SHARE` until this
     * commits (Batch 17) — so a component cannot be deleted between the
     * original being read and the copy being written. One that has already
     * gone refuses the copy rather than writing a reference to nothing, and so
     * does an archived one: the copy is a new instance, and an archived
     * component takes no new links.
     */
    const needed = referencedIds(copiedValues, block.type);
    if (needed.length) {
      const found = await lockComponents(tx, needed);
      const gone = needed.find((id) => !found.has(id));
      const archived = needed.find((id) => found.get(id)?.status === "archived");
      if (gone !== undefined) {
        refused = referenceProblemMessage({ componentId: gone, slot: "", reason: "missing", name: null });
        tx.rollback();
      } else if (archived !== undefined) {
        refused = referenceProblemMessage({
          componentId: archived,
          slot: "",
          reason: "archived",
          name: found.get(archived)?.name ?? null,
        });
        tx.rollback();
      }
    }
    const [row] = await tx
      .insert(pageSections)
      .values({
        pageId: context.pageId,
        blockType: source.blockType,
        position: nextPosition(opened.rows),
        isPublished: false,
        isDraftOnly: true,
        published: copiedValues,
        draft: copiedValues,
        styles: copiedStyles,
        draftStyles: copiedStyles,
        /**
         * The entrance the original *previews* with — read the same fail-closed
         * way the preview reads it, so a source whose motion draft cannot be
         * read gives the copy the original's live entrance rather than the
         * default — as this row's published
         * preset — which is how every other domain is copied here: the copy's
         * published and draft columns both hold what the original was showing,
         * so the copy previews the way the original does and has nothing
         * pending of its own to publish separately.
         *
         * So `draft_animation` is deliberately left null rather than copied. A
         * motion draft is a pending *change*, and a brand-new section has not
         * changed from anything. The advanced document follows the same rule:
         * `motion_config` holds it and `draft_motion_config` stays null.
         */
        animation: legacyProjection(copiedMotion, effectiveMotion(source.animation, source.draftAnimation)),
        motionConfig: copiedMotion && !isEmptyMotionDocument(copiedMotion) ? copiedMotion : null,
      })
      .returning({ id: pageSections.id });
    created = row!.id;

    const next = insertAfter(opened.structure.sections, { sectionId: created, visible: true }, sectionId)!;
    const guard = await updatePageGuardedIn(tx, context.pageId, context.expectedRevision, {
      draftStructure: document(next),
      updatedBy: context.userId,
    });
    if (!guard.ok) {
      conflict = guard.reason;
      tx.rollback();
    }
    revision = guard.ok ? guard.revision : 0;
  }).catch((error) => {
    if (!conflict && !refused) throw error;
  });

  if (refused) return fail("invalid", refused);
  if (conflict) return guardFailure(conflict);

  return {
    ok: true,
    revision,
    sectionId: created,
    message: `${block.name} copied into the layout draft.`,
    log: {
      action: "section.layout_duplicated",
      entityType: "section",
      entityId: created,
      summary: `Duplicated the ${source.blockType} section into the layout draft`,
    },
    // The copy is a new instance of every component the original links, and a
    // new link is recorded as one, as it is when a linked section is added
    // (19B).
    ...(Object.keys(links).length
      ? {
          also: Object.entries(links).map(([slot, ref]) => ({
            action: "reusable_component.instance_linked",
            entityType: "reusable_component",
            entityId: ref.c,
            summary: `Linked a copy of a ${block.name} section on “${opened.page.slug}” in a layout draft`,
            metadata: { sectionId: created, slot },
          })),
        }
      : {}),
  };
}

/**
 * Takes a section out of the layout draft.
 *
 * The row stays. Removing is an *intention* to remove, and until the layout is
 * published the live page still has the section, its content and styles are
 * still there, and putting it back is one click. That applies to a pending
 * section as much as an established one: deleting a draft-only row here would
 * throw away whatever had been written into it because somebody dragged it out
 * of the layout, and would make the operation the only irreversible one in the
 * set. Rows are cleaned up when the layout draft is discarded.
 */
export async function removeStructureSection(
  context: Context,
  sectionId: number,
): Promise<StructureResult> {
  const opened = await open(context);
  if (!opened.ok) return opened.result;

  const row = opened.rows.find((candidate) => candidate.id === sectionId);
  if (!row) return fail("missing", STRUCTURE_MESSAGES.missingSection);
  if (!opened.structure.sections.some((entry) => entry.sectionId === sectionId)) {
    return fail("not_a_member", STRUCTURE_MESSAGES.notAMember);
  }

  const next = opened.structure.sections.filter((entry) => entry.sectionId !== sectionId);
  const result = await updatePageGuarded(context.pageId, context.expectedRevision, {
    draftStructure: document(next),
    updatedBy: context.userId,
  });
  if (!result.ok) return guardFailure(result.reason);

  return {
    ok: true,
    revision: result.revision,
    sectionId,
    message: "Removed from the layout draft. It is still on the live page until the layout is published.",
    log: {
      action: "section.layout_removed",
      entityType: "section",
      entityId: sectionId,
      summary: `Removed the ${row.blockType} section from the layout draft`,
    },
  };
}

/**
 * Where a restored section goes, when the caller knows exactly (Batch 16).
 *
 * `beforeSectionId` names the member it is put in front of — by id, never by
 * index — and `null` means the end. `visible` is the visibility it comes back
 * with. The Visual Editor's Undo passes both, because taking back a removal
 * has to put the section back where the editor had it and the way they had it,
 * not where the live page happens to keep it; and redoing an Add puts the very
 * same pending row back where it was added. Without a placement the section
 * goes near its live position, exactly as before.
 */
export type RestorePlacement = { beforeSectionId: number | null; visible: boolean };

/**
 * Puts a removed section back, near where the live page has it — or exactly
 * where `placement` says.
 *
 * "Near" is computed rather than remembered: the page's own `position` order is
 * the only record of where an established section belongs, so the section goes
 * in front of the first surviving member that follows it there. A pending row's
 * position is past every established one, so it lands at the end — which is
 * where it was appended from, and is the honest answer without inventing a
 * column to remember an index in.
 *
 * A placement changes where, and nothing else: it is still this page's own
 * section, not already in the layout, written under the same page revision
 * guard. A placement anchored on a section that is not in the layout is refused
 * rather than read as "the end".
 */
export async function restoreStructureSection(
  context: Context,
  sectionId: number,
  placement?: RestorePlacement,
): Promise<StructureResult> {
  const opened = await open(context);
  if (!opened.ok) return opened.result;

  const row = opened.rows.find((candidate) => candidate.id === sectionId);
  if (!row) return fail("missing", STRUCTURE_MESSAGES.missingSection);
  if (opened.structure.sections.some((entry) => entry.sectionId === sectionId)) {
    return fail("already_here", STRUCTURE_MESSAGES.alreadyHere);
  }

  let anchor: number;
  let entry: DraftStructureEntry;
  if (placement) {
    anchor =
      placement.beforeSectionId === null
        ? -1
        : opened.structure.sections.findIndex((candidate) => candidate.sectionId === placement.beforeSectionId);
    if (placement.beforeSectionId !== null && anchor < 0) {
      return fail("not_a_member", STRUCTURE_MESSAGES.notAMember);
    }
    entry = { sectionId, visible: placement.visible };
  } else {
    const canonical = opened.rows.map((candidate) => candidate.id);
    const after = canonical.slice(canonical.indexOf(sectionId) + 1);
    anchor = opened.structure.sections.findIndex((candidate) => after.includes(candidate.sectionId));
    entry = {
      sectionId,
      // An established section comes back the way the live page has it; a pending
      // one has no published state to come back to, so it is meant to be shown.
      visible: row.isDraftOnly ? true : row.isPublished,
    };
  }
  const next =
    anchor < 0
      ? [...opened.structure.sections, entry]
      : [
          ...opened.structure.sections.slice(0, anchor),
          entry,
          ...opened.structure.sections.slice(anchor),
        ];

  const result = await updatePageGuarded(context.pageId, context.expectedRevision, {
    draftStructure: document(next),
    updatedBy: context.userId,
  });
  if (!result.ok) return guardFailure(result.reason);

  return {
    ok: true,
    revision: result.revision,
    sectionId,
    message: "Back in the layout draft.",
    log: {
      action: "section.layout_restored",
      entityType: "section",
      entityId: sectionId,
      summary: `Restored the ${row.blockType} section to the layout draft`,
    },
  };
}

/**
 * Throws the layout draft away.
 *
 * Clears the document and deletes the page's pending rows in one transaction,
 * so the page goes back to exactly what it was serving. Established rows are
 * untouched — including their content and style drafts, which are a different
 * kind of unpublished work and are not this button's to discard. Every pending
 * row goes, not only the ones an Add button made: restoring an old version
 * creates them too, and a cleanup that knew about one source would leave the
 * other behind.
 */
export async function discardLayoutDraft(context: Context): Promise<StructureResult> {
  const opened = await open(context);
  if (!opened.ok) return opened.result;

  let conflict: "conflict" | "missing" | null = null;
  let revision = 0;
  let removed = 0;

  await db.transaction(async (tx) => {
    const gone = await tx
      .delete(pageSections)
      .where(and(eq(pageSections.pageId, context.pageId), eq(pageSections.isDraftOnly, true)))
      .returning({ id: pageSections.id });
    removed = gone.length;

    const guard = await updatePageGuardedIn(tx, context.pageId, context.expectedRevision, {
      draftStructure: null,
      updatedBy: context.userId,
    });
    if (!guard.ok) {
      conflict = guard.reason;
      tx.rollback();
    }
    revision = guard.ok ? guard.revision : 0;
  }).catch((error) => {
    if (!conflict) throw error;
  });

  if (conflict) return guardFailure(conflict);

  return {
    ok: true,
    revision,
    message:
      removed > 0
        ? `Layout changes discarded, including ${removed} new section${removed === 1 ? "" : "s"}.`
        : "Layout changes discarded.",
    log: {
      action: "page.layout_draft_discarded",
      entityType: "page",
      entityId: context.pageId,
      summary: `Discarded the layout draft for “${opened.page.slug}”`,
    },
  };
}

/** Whether any of a page's rows is pending — used to gate Discard's warning. */
export async function hasPendingRows(pageId: number): Promise<boolean> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pageSections)
    .where(and(eq(pageSections.pageId, pageId), eq(pageSections.isDraftOnly, true)));
  return (row?.count ?? 0) > 0;
}
