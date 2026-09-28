import { getBlock, type BlockDef } from "../blocks";

/**
 * What a reusable component can be (Batch 17).
 *
 * A reusable component is content of a **registered kind** — a closed list,
 * declared here, of shapes the site already knows how to validate and draw.
 * Never markup, never CSS, never a selector, never JSON the browser
 * interprets: a component's values are rebuilt field by field by the same
 * `validateBlockValues` a section save goes through, from the declaration
 * below, and they are drawn by the same block components a section is.
 *
 * Two families:
 *
 *   · **`cta`** — a call to action: button text in both editions and a link.
 *     It fills any call-to-action slot of any block (`primaryCtaLabel` /
 *     `primaryCtaHref`, `ctaLabel` / `ctaHref`, …), so one "Book a
 *     consultation" can sit in the home hero, a feature section and the
 *     closing panel of every page. There is no visual variant: whether a
 *     button is primary or ghost is decided by each block's markup, not by
 *     data, so a variant field would be a setting that did nothing.
 *   · **`block:<type>`** — a whole section's content, for the few block types
 *     where sharing the whole thing is safe (`REUSABLE_BLOCK_TYPES`). The
 *     section keeps its own place, style and motion; the component supplies
 *     its words, pictures and links.
 *
 * Adding a kind later is an entry here. The storage, the reference, the
 * validator and the renderer do not change.
 */

/**
 * The block types an editor may share as a whole: the closing call to action
 * ("the same final panel on every page"), a column of rich text (a notice, a
 * promise, a promo message) and image-and-text (a reusable banner or panel).
 *
 * What they have in common is what makes them safe: every value is plain
 * content — text, rich text, a picture, a link, a choice — with no repeatable
 * rows and no live data behind it.
 */
export const REUSABLE_BLOCK_TYPES = ["final-cta", "rich-text", "image-text"] as const;

/**
 * Every block type that is **not** offered as a whole reusable block, and why.
 *
 * Deliberately a list with reasons rather than an omission: the next person to
 * wonder "why can't I reuse the process section?" should find the answer in
 * the code rather than rediscover it. Their call-to-action slots, where they
 * have any, are still linkable to a reusable CTA.
 */
export const EXCLUDED_BLOCK_REASONS: Record<string, string> = {
  hero: "home-only: the homepage's own opening screen",
  "quick-links": "home-only, and its cards are repeatable rows",
  "one-desk": "home-only: the animated concept diagram",
  "service-grid": "draws live service categories; its values are a query, not content",
  "featured-service":
    "repeatable rows: row ids anchor each page's own styles and motion, which a shared list would orphan",
  "travel-feature": "repeatable rows (see featured-service)",
  "destination-feature": "repeatable rows (see featured-service)",
  "egypt-feature": "deprecated alias, and repeatable rows",
  "packages-grid": "draws live packages; its values are a query, not content",
  "video-showcase": "draws live videos; its values are a query, not content",
  process: "repeatable rows (see featured-service)",
  "why-us": "repeatable rows (see featured-service)",
  stats: "repeatable rows (see featured-service)",
  testimonials: "draws live testimonials; its values are a query, not content",
  faq: "draws live FAQs; its values are a query, not content",
  "page-hero": "page identity: a page's own hero names that page",
  "contact-details": "draws contact details from Site settings, which are already global",
};

/**
 * The call to action's own declaration: two fields, validated by the ordinary
 * block validator. A pseudo-block rather than a new validator, so there is
 * still exactly one function that decides what content may be stored.
 */
export const CTA_DEFINITION: BlockDef = {
  type: "cta",
  name: "Call to action",
  description: "Button text and a link, shared by every call to action linked to it.",
  scope: "any",
  fields: [
    { name: "label", label: "Button text", type: "text", localised: true, surface: "button" },
    {
      name: "href",
      label: "Link",
      type: "link",
      placeholder: "/contact",
      help: "A site path such as /services/business-setup, or a full https:// address.",
    },
  ],
};

export type KindDef = {
  /** `cta` or `block:<type>`. */
  kind: string;
  /** What an editor calls it: "Reusable CTA", "Reusable Closing call to action". */
  label: string;
  /** The declaration the kind's values are validated against and edited with. */
  definition: BlockDef;
  /** The block a whole-section kind renders as; `null` for a call to action. */
  blockType: string | null;
};

const blockKind = (type: string): KindDef | null => {
  const block = getBlock(type);
  if (!block || block.deprecated) return null;
  return { kind: `block:${type}`, label: `Reusable ${block.name}`, definition: block, blockType: type };
};

export const REUSABLE_KINDS: readonly KindDef[] = [
  { kind: "cta", label: "Reusable CTA", definition: CTA_DEFINITION, blockType: null },
  ...REUSABLE_BLOCK_TYPES.map(blockKind).filter((entry): entry is KindDef => entry !== null),
];

const KIND_MAP = new Map(REUSABLE_KINDS.map((entry) => [entry.kind, entry]));

/** The kind's definition, or `null` for anything this build does not register. */
export const kindDef = (kind: string): KindDef | null => KIND_MAP.get(kind) ?? null;

export const isReusableKind = (kind: unknown): kind is string =>
  typeof kind === "string" && KIND_MAP.has(kind);

/** The whole-section kind for a block type, or `null` when sharing the whole block is not offered. */
export const blockKindOf = (blockType: string): string | null =>
  KIND_MAP.has(`block:${blockType}`) ? `block:${blockType}` : null;

/** A short noun for a kind in sentences: "CTA", "Closing call to action". */
export const kindNoun = (kind: string): string => {
  const entry = kindDef(kind);
  if (!entry) return "component";
  return entry.blockType ? entry.definition.name : "CTA";
};
