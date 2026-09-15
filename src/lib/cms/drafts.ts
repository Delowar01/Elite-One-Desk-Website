/**
 * What a section has waiting, and what to call it.
 *
 * A section used to have one kind of unpublished change, so `draft !== null`
 * answered the question. It now has two — text and layout — saved in different
 * places by different screens and published together. One shared reading of the
 * row keeps the Pages list, the section editor's banner, the draft count and
 * Publish all saying the same thing about the same row; four separate readings
 * would eventually disagree, and the way they disagree is a draft nobody can
 * find a button for.
 */

export type DraftKind = "none" | "content" | "style" | "both";

export function draftKindOf(row: { draft: unknown; draftStyles: unknown }): DraftKind {
  const content = row.draft !== null && row.draft !== undefined;
  // `null` means no draft; an empty document is a real draft that removes every
  // override when published, so emptiness is never the test.
  const style = row.draftStyles !== null && row.draftStyles !== undefined;
  if (content && style) return "both";
  if (content) return "content";
  if (style) return "style";
  return "none";
}

export const hasDraft = (kind: DraftKind): boolean => kind !== "none";

/** For a badge, where there is room for two words and no more. */
export const DRAFT_BADGE: Record<DraftKind, string> = {
  none: "",
  content: "Draft",
  style: "Style draft",
  both: "Draft",
};

/** For a sentence, where saying which one is worth the space. */
export const DRAFT_LABEL: Record<DraftKind, string> = {
  none: "",
  content: "Content draft",
  style: "Style draft",
  both: "Content and style draft",
};
