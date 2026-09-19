/**
 * What a section has waiting, and what to call it.
 *
 * A section used to have one kind of unpublished change, so `draft !== null`
 * answered the question. It now has three — text, layout and motion — saved in
 * different places by different screens and published together. One shared
 * reading of the row keeps the Pages list, the section editor's banner, the
 * Visual Editor's inspector, the draft count and Publish all saying the same
 * thing about the same row; five separate readings would eventually disagree,
 * and the way they disagree is a draft nobody can find a button for.
 *
 * Three independent domains make seven ways for a section to be pending, and
 * all seven are named rather than collapsed. Collapsing them is the temptation
 * — "there is a draft" is true for all seven — but the sentence an editor reads
 * before publishing has to say what publishing will change, and "Draft" on a
 * section whose only pending edit is a slide-in is how somebody publishes an
 * animation while looking for a typo.
 */

export type DraftDomain = "content" | "style" | "motion";

export type DraftKind =
  | "none"
  | "content"
  | "style"
  | "motion"
  | "content+style"
  | "content+motion"
  | "style+motion"
  | "content+style+motion";

export type DraftRow = { draft: unknown; draftStyles: unknown; draftAnimation: unknown };

const pending = (value: unknown): boolean => value !== null && value !== undefined;

/**
 * Which domains are pending, in one fixed order.
 *
 * The order is the vocabulary: `content+style` is a key and `style+content` is
 * not, so it is decided here once rather than by whatever order a caller
 * happened to test in.
 *
 * `null` means no draft in every domain. An empty style document and the
 * preset `"none"` are both *real* drafts — the first removes every override
 * when published, the second removes the section's entrance — so emptiness and
 * falsiness are never the test.
 */
export function draftDomainsOf(row: DraftRow): DraftDomain[] {
  const domains: DraftDomain[] = [];
  if (pending(row.draft)) domains.push("content");
  if (pending(row.draftStyles)) domains.push("style");
  if (pending(row.draftAnimation)) domains.push("motion");
  return domains;
}

export function draftKindOf(row: DraftRow): DraftKind {
  const domains = draftDomainsOf(row);
  return domains.length ? (domains.join("+") as DraftKind) : "none";
}

export const hasDraft = (kind: DraftKind): boolean => kind !== "none";

/**
 * For a badge, where there is room for two words and no more.
 *
 * One domain is named; more than one is simply "Draft", because the badge has
 * nowhere to put the qualification and a badge that named only the first of
 * two would be worse than one that names neither. The label below says which.
 */
export const DRAFT_BADGE: Record<DraftKind, string> = {
  none: "",
  content: "Draft",
  style: "Style draft",
  motion: "Motion draft",
  "content+style": "Draft",
  "content+motion": "Draft",
  "style+motion": "Draft",
  "content+style+motion": "Draft",
};

/** For a sentence, where saying which one is worth the space. */
export const DRAFT_LABEL: Record<DraftKind, string> = {
  none: "",
  content: "Content draft",
  style: "Style draft",
  motion: "Motion draft",
  "content+style": "Content and style draft",
  "content+motion": "Content and motion draft",
  "style+motion": "Style and motion draft",
  "content+style+motion": "Content, style and motion draft",
};
