import { type DraftStructure } from "./structure";

/**
 * Which sections a page shows, and in what order.
 *
 * Two compositions, and the difference between them is the whole of what
 * "preview" means:
 *
 *   **Published** — what a visitor gets. Established, visible sections in their
 *   stored `position` order, reading published values. Nothing draft, ever.
 *
 *   **Preview** — what an authorised editor gets. Drafts win over published
 *   values, hidden sections are included so the editor can see what they are
 *   about to turn on, and — new in this batch — a pending structural draft
 *   decides the order and the membership.
 *
 * Kept pure and kept here, away from the database and away from React, because
 * the rules are subtle enough to deserve testing on their own: a section
 * omitted from a structural draft is a pending deletion, one listed as hidden
 * is still shown to the editor, and an id that belongs to another page is not a
 * section of this one whatever the document claims.
 */

/** A `page_sections` row, reduced to what composition actually decides on. */
export type CompositionRow = {
  id: number;
  blockType: string;
  animation: string;
  published: Record<string, unknown> | null;
  draft: Record<string, unknown> | null;
  isPublished: boolean;
  isDraftOnly: boolean;
};

export type ComposedSection = {
  id: number;
  blockType: string;
  animation: string;
  values: Record<string, unknown>;
  isDraft: boolean;
  /**
   * Whether this row exists only because of a pending structural draft. Not
   * rendered differently — it is here so the editor's Layers panel can say
   * "new" about a section nobody has published, which `visible` cannot.
   */
  isDraftOnly: boolean;
  /**
   * The visibility this section would have once published. In preview it comes
   * from the structural draft when there is one, because that is the intent
   * being previewed, and from the row otherwise. Either way it is *intent*, not
   * whether the section is on screen — a hidden section is still drawn in
   * preview so the editor can reach it.
   */
  visible: boolean;
};

const published = (row: CompositionRow): ComposedSection => ({
  id: row.id,
  blockType: row.blockType,
  animation: row.animation,
  values: row.published ?? {},
  isDraft: false,
  isDraftOnly: false,
  visible: true,
});

const editing = (row: CompositionRow, visible = row.isPublished): ComposedSection => ({
  id: row.id,
  blockType: row.blockType,
  animation: row.animation,
  values: (row.draft ?? row.published) ?? {},
  isDraft: Boolean(row.draft),
  isDraftOnly: row.isDraftOnly,
  visible,
});

/**
 * The live page. Visible, established sections only.
 *
 * `isDraftOnly` is belt to `isPublished`'s braces: a pending row is created
 * hidden, so the visibility filter already excludes it, but a page's published
 * composition is defined by membership rather than by visibility and saying so
 * costs one comparison. Rows arrive in `position` order and stay in it.
 */
export const composePublished = (rows: readonly CompositionRow[]): ComposedSection[] =>
  rows.filter((row) => row.isPublished && !row.isDraftOnly).map(published);

/**
 * The editing view.
 *
 * With no structural draft (`structure` is `null`) this is the behaviour the
 * preview has always had: every section of the page, in `position` order,
 * hidden ones included, drafts winning. Unchanged on purpose — a page nobody
 * has restructured must preview exactly as it did before this batch.
 *
 * With one, the document decides:
 *
 *   · its array order is the canvas order;
 *   · an entry naming a section this page does not own is dropped, so a
 *     malformed or hostile document can never pull another page's content into
 *     this one;
 *   · an entry marked `visible: false` is still rendered, because the editor has
 *     to be able to see and work with a section they have hidden — hiding it
 *     from them as well would make it uneditable;
 *   · a `isDraftOnly` row is included when the document lists it, which is how a
 *     restored or newly added section appears in its intended place;
 *   · an established section the document omits is NOT rendered, because
 *     omission is a pending deletion and preview is meant to show what
 *     publishing would produce.
 *
 * A section listed twice is rendered once: `validateDraftStructure` has already
 * dropped the repeat, and this guards it again because rendering one row twice
 * would give two nodes the same id.
 */
export function composePreview(
  rows: readonly CompositionRow[],
  structure: DraftStructure | null,
): ComposedSection[] {
  if (!structure) return rows.map((row) => editing(row));

  const owned = new Map(rows.map((row) => [row.id, row]));
  const seen = new Set<number>();
  const out: ComposedSection[] = [];

  for (const entry of structure.sections) {
    const row = owned.get(entry.sectionId);
    if (!row || seen.has(row.id)) continue;
    seen.add(row.id);
    // The draft's own intent, not the row's current flag: the point of the
    // document is that it says what publishing it would do.
    out.push(editing(row, entry.visible));
  }
  return out;
}
