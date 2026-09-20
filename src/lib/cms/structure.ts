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
 * A stored document this build can act on, or `null` when there is none.
 *
 * `validateDraftStructure` cannot answer this, and deliberately so: it rebuilds
 * whatever it is handed into a valid document, so corrupt input and a genuinely
 * empty draft both come back as `{ v: 1, sections: [] }`. Those two mean
 * opposite things. An empty list is an editor saying "publish this and the page
 * has no sections left"; corrupt JSON is a column nobody should be reading. If
 * preview collapsed them, a damaged row would silently blank a page an editor
 * was working on, and they would think they had deleted it.
 *
 * So: `null` for absent or unusable — the caller falls back to the established
 * order, which is the safe reading — and a document for anything this build
 * understands, empty list included. It never throws; a page must not fail to
 * render because a JSON column is malformed.
 */
export function readDraftStructure(input: unknown): DraftStructure | null {
  if (input === null || input === undefined) return null;
  const source = asRecord(input);
  const version = source.v;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) return null;
  if (version > DRAFT_STRUCTURE_VERSION) return null;
  if (!Array.isArray(source.sections)) return null;
  return validateDraftStructure(source);
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

/**
 * A submitted visibility, or `null` for anything that is not one.
 *
 * `raw === "true"` looks like a reasonable reading until you list what else it
 * accepts: a missing field, `"TRUE"`, `"1"`, `"yes"`, `""` and any typo all
 * fall through to the other branch and mean **hide**. That is a malformed
 * request quietly becoming a destructive layout intention — the one direction
 * an ambiguous value must never resolve in.
 *
 * So there are two accepted strings and everything else is an invalid request
 * the caller refuses. Nothing is normalised, nothing is guessed, and the
 * structure service only ever receives a boolean somebody actually sent.
 *
 * It lives here rather than in either adapter because both editors submit the
 * same field, and two readers of one field is how they come to disagree about
 * what an empty string means.
 */
export function readVisibility(raw: unknown): boolean | null {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

/* -------------------------------------------------------------------------- */
/* What the structural editors read                                           */
/* -------------------------------------------------------------------------- */

/**
 * One section of a page, as a structural editor needs to know it.
 *
 * These two shapes live here rather than beside the service that builds them
 * because both editors are client components: a panel that imported them from a
 * `server-only` module would be one careless value import away from pulling the
 * database into the browser bundle. The rules stay on the server; the vocabulary
 * is shared.
 */
export type PageStructureSection = {
  sectionId: number;
  blockType: string;
  blockName: string;
  /** A line of its own words, so a removed section is recognisable. */
  summary: string;
  isDraftOnly: boolean;
  /** What the live page currently does with it — never what the draft intends. */
  publishedPosition: number;
  publishedVisible: boolean;
};

/**
 * Everything a structural editor needs about one page, and nothing else.
 *
 * Deliberately narrow: no SEO, no settings, no content. A panel that reorders
 * sections should not be holding a page's metadata, and a reader that returned
 * it would eventually be the reason something unrelated leaked into the editor.
 */
export type PageStructure = {
  pageId: number;
  slug: string;
  title: string;
  revision: number;
  /** Whether the stored column holds a document this build can act on. */
  hasDraftStructure: boolean;
  /** The structure being edited — the draft, or the established page seeded. */
  structure: DraftStructure;
  sections: PageStructureSection[];
};

/** The sections a page owns that its structure leaves out — pending removals. */
export const removedSections = (page: PageStructure): PageStructureSection[] => {
  const listed = new Set(page.structure.sections.map((entry) => entry.sectionId));
  return page.sections.filter((section) => !listed.has(section.sectionId));
};

/** What the structure intends for one section, or `null` when it omits it. */
export const entryFor = (page: PageStructure, sectionId: number): DraftStructureEntry | null =>
  page.structure.sections.find((entry) => entry.sectionId === sectionId) ?? null;

/* -------------------------------------------------------------------------- */
/* What publication is allowed to act on                                      */
/* -------------------------------------------------------------------------- */

/**
 * The strict reading, for the one caller that turns this document into live
 * rows.
 *
 * Everything above is deliberately tolerant, because everything above is for
 * *rendering*: a damaged column must not blank a page an editor is working on,
 * so `validateDraftStructure` rebuilds whatever it is handed and
 * `readDraftStructure` falls back to the established order. Publication cannot
 * afford either kindness. It deletes rows, rewrites `position` and decides
 * `is_published`, and every tolerance above becomes a destructive guess at that
 * moment:
 *
 *   · a dropped malformed entry reads as "remove this section";
 *   · a de-duplicated repeat reads as "the second copy was never intended";
 *   · a `visible` that is not a boolean normalises to `true`, which publishes a
 *     section the editor may have hidden;
 *   · an id belonging to another page, silently filtered, quietly changes what
 *     the layout meant.
 *
 * So this refuses instead. A document that is not exactly what this build
 * wrote is not a layout anybody intended, and the honest answer is to publish
 * nothing and say the stored layout cannot be read.
 *
 * A genuinely empty list is **valid** and means "publish a page with no
 * sections". That is the one case tolerance and strictness must not collapse
 * together, because corrupt JSON also produces an empty list under the
 * validator — and the difference between them is a page and no page.
 */
export type PublishableStructure =
  | { ok: true; structure: DraftStructure }
  | { ok: false; reason: "corrupt" };

const CORRUPT: PublishableStructure = { ok: false, reason: "corrupt" };

export function readPublishableStructure(
  input: unknown,
  pageSectionIds: readonly number[],
): PublishableStructure {
  if (input === null || input === undefined) return CORRUPT;
  if (typeof input !== "object" || Array.isArray(input)) return CORRUPT;

  const source = input as Record<string, unknown>;
  const version = source.v;
  if (typeof version !== "number" || !Number.isInteger(version)) return CORRUPT;
  if (version < 1 || version > DRAFT_STRUCTURE_VERSION) return CORRUPT;
  if (!Array.isArray(source.sections)) return CORRUPT;

  const owned = new Set(pageSectionIds);
  const seen = new Set<number>();
  const sections: DraftStructureEntry[] = [];

  for (const entry of source.sections) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return CORRUPT;
    const row = entry as Record<string, unknown>;
    const sectionId = row.sectionId;
    if (!isSectionId(sectionId)) return CORRUPT;
    if (seen.has(sectionId)) return CORRUPT;
    // Not merely truthy, and not merely "not false": a layout entry whose
    // visibility is a string or a number is a document this build did not
    // write, and guessing at it decides whether a visitor sees a section.
    if (typeof row.visible !== "boolean") return CORRUPT;
    if (!owned.has(sectionId)) return CORRUPT;
    seen.add(sectionId);
    sections.push({ sectionId, visible: row.visible });
  }

  return { ok: true, structure: { v: DRAFT_STRUCTURE_VERSION, sections } };
}

/** The live composition of a page, in the same shape a layout draft has. */
export const liveStructure = (
  rows: readonly { id: number; isDraftOnly: boolean; isPublished: boolean }[],
): DraftStructure => ({
  v: DRAFT_STRUCTURE_VERSION,
  sections: rows
    .filter((row) => !row.isDraftOnly)
    .map((row) => ({ sectionId: row.id, visible: row.isPublished })),
});

/** Whether publishing this document would change the page's composition. */
export const structureDiffers = (a: DraftStructure, b: DraftStructure): boolean =>
  a.sections.length !== b.sections.length ||
  a.sections.some(
    (entry, index) =>
      entry.sectionId !== b.sections[index]!.sectionId || entry.visible !== b.sections[index]!.visible,
  );
