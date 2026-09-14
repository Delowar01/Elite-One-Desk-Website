/**
 * A page's structure as it is being edited.
 *
 * The current structural mutations are immediate and live: `reorderSections`
 * rewrites `position`, `toggleSection` flips `isPublished`, `deleteSection`
 * removes the row. There is nowhere for "I have rearranged this page but not
 * published it" to live, which means a visual editor cannot honestly offer a
 * draft for structure while calling them.
 *
 * This document is that place. Array order is the draft order, `visible` is the
 * intended published visibility, and a section that exists on the page but is
 * absent from the list is a deletion waiting to be published.
 *
 * Dormant in this release. The public renderer does not read it and the Pages
 * admin keeps its current behaviour; Batch 8 builds draft-aware structural
 * editing on top of it.
 */

export const DRAFT_STRUCTURE_VERSION = 1;

export type DraftStructureEntry = { sectionId: number; visible: boolean };

export type DraftStructure = { v: number; sections: DraftStructureEntry[] };

export const EMPTY_DRAFT_STRUCTURE: DraftStructure = {
  v: DRAFT_STRUCTURE_VERSION,
  sections: [],
};

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const isSectionId = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value <= 2_147_483_647;

/**
 * Shape only — this cannot know which sections belong to which page. Rebuilt
 * entry by entry: unknown fields are dropped, a malformed id takes the entry
 * with it, and a repeated id keeps its first appearance, because a page where
 * one section is in two places has no defined order.
 *
 * A malformed `visible` normalises to `true` rather than dropping the entry:
 * dropping it would read as "delete this section on publish", which is not
 * something a typo should be able to say.
 */
export function validateDraftStructure(input: unknown): DraftStructure {
  const source = asRecord(input);
  const version = source.v;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return { v: DRAFT_STRUCTURE_VERSION, sections: [] };
  }
  if (version > DRAFT_STRUCTURE_VERSION) return { v: DRAFT_STRUCTURE_VERSION, sections: [] };

  const raw = Array.isArray(source.sections) ? source.sections : [];
  const seen = new Set<number>();
  const sections: DraftStructureEntry[] = [];

  for (const entry of raw) {
    const row = asRecord(entry);
    const sectionId = row.sectionId;
    if (!isSectionId(sectionId) || seen.has(sectionId)) continue;
    seen.add(sectionId);
    sections.push({ sectionId, visible: row.visible === false ? false : true });
  }

  return { v: DRAFT_STRUCTURE_VERSION, sections };
}

/**
 * The check the shape validator cannot make: every id has to be a section of
 * *this* page. Without it a submitted document could reorder — or, once Batch 8
 * publishes one, delete — a section belonging to somebody else's page.
 *
 * Ids the page does not own are dropped. Sections the page has that the
 * document omits are **appended**, keeping their current order: an omission has
 * to be a deliberate removal made against a document that knew about the
 * section, never the side effect of a stale screen.
 */
export function normalizeDraftStructureForPage(
  input: unknown,
  pageSectionIds: readonly number[],
  options: { keepOmitted?: boolean } = {},
): DraftStructure {
  const { keepOmitted = true } = options;
  const owned = new Set(pageSectionIds);
  const shape = validateDraftStructure(input);

  const sections = shape.sections.filter((entry) => owned.has(entry.sectionId));
  if (keepOmitted) {
    const listed = new Set(sections.map((entry) => entry.sectionId));
    for (const id of pageSectionIds) {
      if (!listed.has(id)) sections.push({ sectionId: id, visible: true });
    }
  }
  return { v: DRAFT_STRUCTURE_VERSION, sections };
}

/** The ids this document would remove from the page, were it published. */
export function pendingRemovals(
  structure: DraftStructure,
  pageSectionIds: readonly number[],
): number[] {
  const listed = new Set(structure.sections.map((entry) => entry.sectionId));
  return pageSectionIds.filter((id) => !listed.has(id));
}
