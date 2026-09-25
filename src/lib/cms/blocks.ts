/**
 * The section catalogue.
 *
 * §15 of the brief asks for "a controlled section-based visual CMS", not a page
 * builder that can destroy the design. That is exactly what this registry is:
 * an editor picks a block from this fixed list, fills in its declared fields and
 * orders it. The markup is always ours — nothing typed in the panel is ever
 * parsed as HTML except the `richtext` fields, and those go through
 * `lib/cms/sanitize.ts` on the way in.
 *
 * One registry drives three things, so they can never drift apart:
 *   · the admin form (rendered generically from `fields`)
 *   · the Zod validation on save (built from `fields`)
 *   · the renderer's prop types (`lib/cms/values.ts` reads by field name)
 */

export type FieldType =
  | "text"
  | "textarea"
  | "richtext"
  | "media"
  | "link"
  | "select"
  | "boolean"
  | "number"
  | "items";

/**
 * A field inside a repeatable row.
 *
 * `media` and `icon` are controlled choosers rather than free text, and they
 * are declared here for the same reason the top-level field types are: the
 * admin form, the validator and the renderer all read this one declaration, so
 * a row field cannot be editable as one thing and stored as another. Neither
 * accepts markup — `media` stores a library id and `icon` stores a key from the
 * in-code `ICON_NAMES` allowlist.
 */
export type ItemFieldDef = {
  name: string;
  label: string;
  type?: "text" | "textarea" | "media" | "icon";
  localised?: boolean;
  help?: string;
  /** See `BoxKind`. */
  box?: BoxKind;
};

/**
 * What kind of box the renderer gives a field's element.
 *
 * The fourth thing this registry drives, and the narrowest: it exists so the
 * Visual Editor's Style panel can answer "does a layout control do anything
 * here?" without looking at the page. The panel has a block type and a node
 * path and nothing else — it cannot see the markup, and reading a computed
 * style back out of the canvas would make the controls depend on whatever the
 * iframe happened to have loaded.
 *
 *   · `"grid"` / `"flex"` — the element already lays its children out that way,
 *     so gap, alignment and (for a grid) column count mean something on it
 *     immediately, with no override first.
 *   · `"inline"` — the element is an inline box, so width, height and every
 *     layout control would be inert on it and none is offered.
 *   · absent — an ordinary block box: sizeable, and layout controls appear once
 *     an editor explicitly chooses a layout mode.
 *
 * Declared here rather than at the annotation because the panel reads the
 * registry and never the markup. `tests/layout-tokens.test.ts` reads the block
 * sources back and fails if a declaration and the element it describes disagree
 * — a claim of "grid" on a box that lays nothing out would be a column control
 * an editor could set and never see.
 */
export type BoxKind = "inline" | "flex" | "grid";

export type FieldDef = {
  name: string;
  label: string;
  type: FieldType;
  /** Stored as `{ en, ar }` and read through `pick()` at render time. */
  localised?: boolean;
  help?: string;
  placeholder?: string;
  options?: Array<{ value: string; label: string }>;
  itemFields?: ItemFieldDef[];
  /** See `BoxKind`. On an `items` field this describes the list's container. */
  box?: BoxKind;
  /** Repeatable lists only. Keeps a section from becoming a page of its own. */
  maxItems?: number;
  rows?: number;
};

export type BlockDef = {
  type: string;
  name: string;
  description: string;
  /** `home` blocks are offered on the homepage; `any` on every page. */
  scope: "home" | "any";
  fields: FieldDef[];
  /**
   * Still renders and still edits, but is no longer offered when adding a
   * block. Kept so that a section stored under an old type can be opened in
   * the editor after the type was renamed — a stored row outlives a rename.
   */
  deprecated?: boolean;
};

const localisedText = (name: string, label: string, extra: Partial<FieldDef> = {}): FieldDef => ({
  name,
  label,
  type: "text",
  localised: true,
  ...extra,
});

const localisedArea = (name: string, label: string, rows = 3): FieldDef => ({
  name,
  label,
  type: "textarea",
  localised: true,
  rows,
});

const ctaFields = (prefix = "", label = "Call to action"): FieldDef[] => [
  localisedText(`${prefix}CtaLabel`, `${label} — button text`),
  {
    name: `${prefix}CtaHref`,
    label: `${label} — link`,
    type: "link",
    placeholder: "/contact",
    help: "A site path such as /services/business-setup, or a full https:// address.",
  },
];

export const BLOCKS: BlockDef[] = [
  {
    type: "hero",
    name: "Hero",
    description: "The opening screen: rotating service words, headline and the two main calls to action.",
    scope: "home",
    fields: [
      localisedText("eyebrow", "Eyebrow"),
      {
        name: "words",
        label: "Rotating words",
        type: "items",
        // One animated inline span inside the headline, not a list box: sizing
        // and layout controls would all be inert on it.
        box: "inline",
        maxItems: 6,
        help: "Animated one after another above the headline. Three or four reads best.",
        itemFields: [{ name: "label", label: "Word", localised: true }],
      },
      localisedText("headline", "Headline"),
      localisedArea("lead", "Supporting sentence", 3),
      ...ctaFields("primary", "Primary"),
      ...ctaFields("secondary", "Secondary"),
      { name: "backgroundImage", label: "Background image", type: "media", help: "Optional. The animated composition shows through it." },
    ],
  },
  {
    type: "quick-links",
    name: "Quick service navigation",
    description: "The visual entry points under the hero — plan a trip, investor licence, Iqama and so on.",
    scope: "home",
    fields: [
      localisedText("title", "Title"),
      localisedArea("intro", "Intro", 2),
      {
        name: "links",
        label: "Links",
        type: "items",
        // The card grid under the hero.
        box: "grid",
        maxItems: 10,
        itemFields: [
          { name: "label", label: "Label", localised: true },
          { name: "href", label: "Link" },
          { name: "icon", label: "Icon", type: "icon" },
          {
            name: "image",
            label: "Image",
            type: "media",
            help: "Optional. With none, the card uses the picture belonging to the page it links to.",
          },
        ],
      },
    ],
  },
  {
    type: "one-desk",
    name: "One Desk concept",
    description: "The animated explanation that several service paths converge on one point of contact.",
    scope: "home",
    fields: [
      localisedText("eyebrow", "Eyebrow"),
      localisedText("title", "Title"),
      localisedArea("body", "Body", 4),
      {
        name: "paths",
        label: "Incoming paths",
        type: "items",
        // No `box`: the labels feed a diagram; no list container is rendered.
        maxItems: 6,
        help: "Each becomes a line converging on the desk. Four to six works best.",
        itemFields: [{ name: "label", label: "Label", localised: true }],
      },
      ...ctaFields("", "Call to action"),
    ],
  },
  {
    type: "service-grid",
    name: "Main services",
    description: "The service groups, drawn live from Service Categories.",
    scope: "home",
    fields: [
      localisedText("eyebrow", "Eyebrow"),
      localisedText("title", "Title"),
      localisedArea("intro", "Intro", 3),
      { name: "limit", label: "How many to show", type: "number", help: "0 shows every published category." },
      { name: "showCounts", label: "Show the number of services in each category", type: "boolean" },
    ],
  },
  {
    type: "featured-service",
    name: "Featured service (Investor Licence)",
    description: "A full-width feature for one strategically important service.",
    scope: "any",
    fields: [
      localisedText("eyebrow", "Eyebrow"),
      localisedText("title", "Title"),
      localisedArea("body", "Body", 4),
      {
        name: "points",
        label: "What is included",
        type: "items",
        // The two- or three-column list of selling points.
        box: "grid",
        maxItems: 8,
        itemFields: [{ name: "label", label: "Item", localised: true }],
      },
      ...ctaFields("", "Call to action"),
      { name: "image", label: "Image", type: "media" },
    ],
  },
  {
    type: "travel-feature",
    name: "Travel experience",
    description: "The Travel & Tourism feature area with its list of capabilities.",
    scope: "any",
    fields: [
      localisedText("eyebrow", "Eyebrow"),
      localisedText("title", "Title"),
      localisedArea("body", "Body", 3),
      {
        name: "capabilities",
        label: "Capabilities",
        type: "items",
        // A wrapping row of pills.
        box: "flex",
        maxItems: 12,
        itemFields: [{ name: "label", label: "Label", localised: true }],
      },
      ...ctaFields("", "Call to action"),
      { name: "image", label: "Image", type: "media" },
    ],
  },
  {
    type: "destination-feature",
    name: "Destination feature",
    description: "One destination, its highlights, and the way into the package catalogue.",
    scope: "any",
    fields: [
      localisedText("eyebrow", "Eyebrow"),
      localisedText("title", "Title"),
      localisedArea("body", "Body", 3),
      {
        name: "destinations",
        label: "Destinations",
        type: "items",
        // The two- or three-column list of destinations.
        box: "grid",
        maxItems: 12,
        itemFields: [
          { name: "label", label: "Name", localised: true },
          { name: "note", label: "Short note", localised: true },
        ],
      },
      ...ctaFields("primary", "Primary"),
      ...ctaFields("secondary", "Secondary"),
      { name: "image", label: "Image", type: "media" },
    ],
  },
  {
    // Compatibility alias for sections stored before the block was generalised
    // away from Egypt. Identical fields, so an existing row edits exactly as it
    // did; hidden from the picker so no new one can be created. The cleanup
    // release removes it once no section carries this type.
    type: "egypt-feature",
    name: "Destination feature (legacy)",
    description: "Superseded by Destination feature. Existing sections keep working.",
    scope: "any",
    deprecated: true,
    fields: [
      localisedText("eyebrow", "Eyebrow"),
      localisedText("title", "Title"),
      localisedArea("body", "Body", 3),
      {
        name: "destinations",
        label: "Destinations",
        type: "items",
        // Same renderer as `destination-feature`, same grid.
        box: "grid",
        maxItems: 12,
        itemFields: [
          { name: "label", label: "Name", localised: true },
          { name: "note", label: "Short note", localised: true },
        ],
      },
      ...ctaFields("primary", "Primary"),
      ...ctaFields("secondary", "Secondary"),
      { name: "image", label: "Image", type: "media" },
    ],
  },
  {
    type: "packages-grid",
    name: "Package grid",
    description: "Tour packages drawn live from the Packages screen.",
    scope: "any",
    fields: [
      localisedText("eyebrow", "Eyebrow"),
      localisedText("title", "Title"),
      localisedArea("intro", "Intro", 2),
      {
        // A destination slug, or empty for every package. Free text rather than
        // a fixed list, because the point of destinations is that an admin adds
        // one without anybody editing this file.
        name: "destination",
        label: "Destination slug (blank for all)",
        type: "text",
      },
      { name: "limit", label: "How many to show", type: "number" },
    ],
  },
  {
    type: "video-showcase",
    name: "Video showcase",
    description: "Poster-first YouTube gallery. Nothing loads from YouTube until a visitor presses play.",
    scope: "any",
    fields: [
      localisedText("eyebrow", "Eyebrow"),
      localisedText("title", "Title"),
      localisedArea("intro", "Intro", 2),
      { name: "category", label: "Only this category", type: "text", help: "Leave empty for all published videos." },
      { name: "limit", label: "How many to show", type: "number" },
    ],
  },
  {
    type: "process",
    name: "How it works",
    description: "The numbered path from choosing a service to completion.",
    scope: "any",
    fields: [
      localisedText("eyebrow", "Eyebrow"),
      localisedText("title", "Title"),
      {
        name: "steps",
        label: "Steps",
        type: "items",
        // No `box`: a numbered <ol> in ordinary block flow, with the rail
        // beside it positioned rather than laid out.
        maxItems: 8,
        itemFields: [
          { name: "label", label: "Step title", localised: true },
          { name: "text", label: "Step description", type: "textarea", localised: true },
        ],
      },
    ],
  },
  {
    type: "why-us",
    name: "Why Elite One Desk",
    description: "The trust section. Keep every line to something the business can stand behind.",
    scope: "any",
    fields: [
      localisedText("eyebrow", "Eyebrow"),
      localisedText("title", "Title"),
      localisedArea("intro", "Intro", 2),
      {
        name: "points",
        label: "Points",
        type: "items",
        // The two- or three-column list of reasons.
        box: "grid",
        maxItems: 8,
        itemFields: [
          { name: "label", label: "Title", localised: true },
          { name: "text", label: "Description", type: "textarea", localised: true },
        ],
      },
    ],
  },
  {
    type: "stats",
    name: "Statistics",
    description: "Counters. Stays hidden until real figures are entered — never publish a number you cannot evidence.",
    scope: "any",
    fields: [
      localisedText("title", "Title"),
      {
        name: "items",
        label: "Figures",
        type: "items",
        // The figures, up to four across.
        box: "grid",
        maxItems: 4,
        itemFields: [
          { name: "value", label: "Figure" },
          { name: "label", label: "Label", localised: true },
        ],
      },
    ],
  },
  {
    type: "testimonials",
    name: "Testimonials",
    description: "Published testimonials, featured ones first.",
    scope: "any",
    fields: [
      localisedText("eyebrow", "Eyebrow"),
      localisedText("title", "Title"),
      { name: "limit", label: "How many to show", type: "number" },
    ],
  },
  {
    type: "faq",
    name: "FAQ",
    description: "Questions from the FAQ screen. Choose global questions or one category's.",
    scope: "any",
    fields: [
      localisedText("eyebrow", "Eyebrow"),
      localisedText("title", "Title"),
      {
        name: "scope",
        label: "Which questions",
        type: "select",
        options: [
          { value: "global", label: "Global questions" },
          { value: "all", label: "Everything published" },
        ],
      },
      { name: "limit", label: "How many to show", type: "number" },
    ],
  },
  {
    type: "final-cta",
    name: "Closing call to action",
    description: "The large closing panel with the request and WhatsApp buttons.",
    scope: "any",
    fields: [
      localisedText("title", "Title"),
      localisedArea("body", "Body", 3),
      ...ctaFields("primary", "Primary"),
      { name: "showWhatsapp", label: "Show the WhatsApp button", type: "boolean" },
    ],
  },
  {
    type: "page-hero",
    name: "Page hero",
    description: "A compact hero for an inner page.",
    scope: "any",
    fields: [
      localisedText("eyebrow", "Eyebrow"),
      localisedText("title", "Title"),
      localisedArea("lead", "Lead paragraph", 3),
      { name: "backgroundImage", label: "Background image", type: "media" },
    ],
  },
  {
    type: "rich-text",
    name: "Rich text",
    description: "A column of formatted text — headings, paragraphs, lists and links.",
    scope: "any",
    fields: [
      localisedText("eyebrow", "Eyebrow"),
      localisedText("title", "Title"),
      { name: "body", label: "Body", type: "richtext", localised: true },
    ],
  },
  {
    type: "image-text",
    name: "Image and text",
    description: "A picture beside a column of text, with an optional button.",
    scope: "any",
    fields: [
      localisedText("eyebrow", "Eyebrow"),
      localisedText("title", "Title"),
      { name: "body", label: "Body", type: "richtext", localised: true },
      { name: "image", label: "Image", type: "media" },
      {
        name: "imageSide",
        label: "Image position",
        type: "select",
        options: [
          { value: "start", label: "Leading edge (left in English, right in Arabic)" },
          { value: "end", label: "Trailing edge" },
        ],
      },
      ...ctaFields("", "Call to action"),
    ],
  },
  {
    type: "contact-details",
    name: "Contact details",
    description: "Address, phone, email, hours and the map — all read from Contact settings.",
    scope: "any",
    fields: [
      localisedText("title", "Title"),
      localisedArea("intro", "Intro", 2),
      { name: "showMap", label: "Show the map", type: "boolean" },
      { name: "showForm", label: "Show the enquiry form", type: "boolean" },
    ],
  },
];

export const BLOCK_MAP = new Map(BLOCKS.map((b) => [b.type, b]));

export const getBlock = (type: string): BlockDef | undefined => BLOCK_MAP.get(type);

/** What the editor offers when adding a block — deprecated types are not on it. */
export const blocksForPage = (slug: string): BlockDef[] =>
  BLOCKS.filter((b) => !b.deprecated && (b.scope === "any" || slug === "home"));
