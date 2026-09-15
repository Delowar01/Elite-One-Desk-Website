import { validateStyleDocument, type StyleDocument } from "./styles";
import { type DraftStructure } from "./structure";

/**
 * Which sections a page shows, and in what order.
 *
 * Two compositions, and the difference between them is the whole of what
 * "preview" means:
 *
 *   **Published** — what a visitor gets. Established, visible sections in their
 *   stored `position` order, reading published values and published styles.
 *   Nothing draft, ever, in either domain.
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
  /** Published visual overrides. */
  styles: Record<string, unknown> | null;
  /**
   * Pending visual overrides, or `null` for none.
   *
   * `null` and an empty document are different answers and the difference is
   * load-bearing: `null` means "no style draft, show what is published", while
   * `{ v: 1, nodes: {} }` means "publishing this removes every override". A
   * draft that resets a section back to the design would be indistinguishable
   * from no draft at all if emptiness were the test.
   */
  draftStyles: Record<string, unknown> | null;
  isPublished: boolean;
  isDraftOnly: boolean;
};

export type ComposedSection = {
  id: number;
  blockType: string;
  animation: string;
  values: Record<string, unknown>;
  /**
   * The overrides this render should apply, already validated. Never the raw
   * column: a document is rebuilt key by key on the way out as well as on the
   * way in, so a row written by an older build — or by hand — cannot put
   * anything into a style property.
   */
  styles: StyleDocument;
  /** Either domain has something unpublished. */
  isDraft: boolean;
  /** …and which, because the two are published and discarded together but
   * edited in different places and worth naming separately. */
  hasContentDraft: boolean;
  hasStyleDraft: boolean;
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
  styles: validateStyleDocument(row.styles),
  isDraft: false,
  hasContentDraft: false,
  hasStyleDraft: false,
  isDraftOnly: false,
  visible: true,
});

const editing = (row: CompositionRow, visible = row.isPublished): ComposedSection => {
  const hasContentDraft = row.draft !== null;
  const hasStyleDraft = row.draftStyles !== null;
  return {
    id: row.id,
    blockType: row.blockType,
    animation: row.animation,
    values: (row.draft ?? row.published) ?? {},
    // The draft document wins whole, including when it is empty — that is what
    // a reset looks like before it is published.
    styles: validateStyleDocument(hasStyleDraft ? row.draftStyles : row.styles),
    isDraft: hasContentDraft || hasStyleDraft,
    hasContentDraft,
    hasStyleDraft,
    isDraftOnly: row.isDraftOnly,
    visible,
  };
};

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
