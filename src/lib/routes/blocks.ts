import type { BlockDef, FieldDef } from "@/lib/cms/blocks";
import { ICON_NAMES } from "@/lib/icons";

import type { RouteOwnerType } from "./owners";

/**
 * The block definitions of a dynamic route's regions: a category's page
 * (Batch 21), a service's own page (Batch 22), and a package's page, a
 * destination's page, the package catalogue and the services overview
 * (Batch 24).
 *
 * The same `BlockDef` vocabulary page sections use, on purpose: the Content
 * tab draws them with `BlockEditor`, the Style and Motion panels read their
 * capabilities from them, Layers names their nodes from them and direct
 * editing decides from them which text may be typed into. One description per
 * region, read by every part of the editor — none of which has to know it is
 * looking at a category rather than a page.
 *
 * They are **not** page blocks. `getBlock()` — what the page CMS adds, saves,
 * publishes and restores sections with — does not know them; only
 * `getEditorBlock()` does. A route block can therefore never become a page
 * section, and a page section can never be saved as one.
 *
 * Values here are the editor's view of a resource, not its storage: the
 * adapter (`lib/routes/category.ts`) maps `title` to `title_en` / `title_ar`,
 * `group` to `subcategory_id` and so on, and validates every one of them with
 * the rules the resource's own admin form applies. Two reserved keys ride
 * beside the declared fields, as `_id` and `_reuse` do on page sections:
 *
 *   · `_order` — the order of a region's children, as record ids per list
 *     (`{ services: [12, 15, 13] }`). It is edited from Layers, never typed.
 *   · nothing else. A key the adapter does not know is dropped on save.
 *
 * A field marked `generated` is drawn from somewhere other than the region's
 * values — a route-derived link, a count, a name from another screen. It is
 * selectable and styleable like any field, never typed into and never part of
 * a draft; the Inspector shows its explanation and links to the screen that
 * controls it.
 */

const text = (name: string, label: string, extra: Partial<FieldDef> = {}): FieldDef => ({
  name,
  label,
  type: "text",
  localised: true,
  ...extra,
});

const area = (name: string, label: string, rows = 3, extra: Partial<FieldDef> = {}): FieldDef => ({
  name,
  label,
  type: "textarea",
  localised: true,
  rows,
  ...extra,
});

const STANDARD = "Leave empty to use the standard wording.";

const ICON_OPTIONS = ICON_NAMES.map((name) => ({
  value: name,
  label: name.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/^./, (first) => first.toUpperCase()),
}));

/** The admin screens a generated node's explanation links to. */
const SOURCE = {
  whatsapp: { label: "Globals › WhatsApp", href: "/admin/settings" },
  services: { label: "Services", href: "/admin/services" },
  destinations: { label: "Packages › Destinations", href: "/admin/packages/destinations" },
  packages: { label: "Packages", href: "/admin/packages" },
  categories: { label: "Service Categories", href: "/admin/categories" },
  faqs: { label: "FAQs", href: "/admin/faqs" },
  disclaimers: { label: "Globals › Disclaimers", href: "/admin/settings" },
} as const;

/** A trail of breadcrumbs: generated, still, the same sentence for every route that has one. */
const crumbs = (type: string, description: string, explain: string): BlockDef => ({
  type,
  name: "Breadcrumbs",
  description,
  scope: "any",
  still: true,
  fields: [{ name: "trail", label: "Trail", type: "text", generated: { explain } }],
});

export const ROUTE_BLOCKS: BlockDef[] = [
  {
    type: "route-category-hero",
    name: "Category hero",
    description: "The category's own introduction: icon, tagline, title, summary, picture and calls to action.",
    scope: "any",
    fields: [
      { name: "icon", label: "Icon", type: "select", options: ICON_OPTIONS },
      text("tagline", "Tagline", { help: "The short line above the title." }),
      text("title", "Title", {
        help: "Changing the title never changes the page address.",
      }),
      area("summary", "Summary", 3),
      { name: "image", label: "Background image", type: "media", surface: "backdrop" },
      text("ctaLabel", "Primary button — text", {
        surface: "button",
        placeholder: "Request a Service",
        help: "Leave empty to use “Request a Service”.",
      }),
      {
        name: "ctaHref",
        label: "Primary button — link",
        type: "link",
        placeholder: "/contact",
        help: "A site path such as /contact, or a full https:// address. Empty goes to /contact.",
      },
      {
        name: "whatsapp",
        label: "WhatsApp button",
        type: "link",
        surface: "button",
        generated: {
          explain:
            "Shown when WhatsApp is switched on. The number and the switch are site settings, and the message names this category automatically.",
          source: SOURCE.whatsapp,
        },
      },
    ],
  },
  {
    type: "route-category-crumbs",
    name: "Breadcrumbs",
    description: "Where this page sits in the site, built from the category's title.",
    scope: "any",
    still: true,
    fields: [
      {
        name: "trail",
        label: "Trail",
        type: "text",
        generated: {
          explain:
            "Built from the site structure and the category's title. Change the title in the hero; the other steps are the site's own navigation.",
        },
      },
    ],
  },
  {
    type: "route-category-body",
    name: "Category body",
    description: "Longer text about the category, below the hero.",
    scope: "any",
    fields: [{ name: "body", label: "Body", type: "richtext", localised: true }],
  },
  {
    type: "route-category-services",
    name: "Services",
    description: "The category's services, in their groups.",
    scope: "any",
    fields: [
      text("eyebrow", "Eyebrow", { placeholder: "In this category", help: STANDARD }),
      text("heading", "Heading", { placeholder: "Services", help: STANDARD }),
    ],
  },
  {
    type: "route-subcategory",
    name: "Service group",
    description: "One group of services in this category.",
    scope: "any",
    fields: [
      text("title", "Title"),
      area("summary", "Summary", 2),
      {
        name: "published",
        label: "Show this group on the website",
        type: "boolean",
        help: "A hidden group's services are hidden with it.",
      },
    ],
  },
  {
    type: "route-service-card",
    name: "Service card",
    description: "One service, as its card on the category page.",
    scope: "any",
    fields: [
      text("title", "Title", { help: "Changing the title never changes the service's address." }),
      area("intro", "Short introduction", 3),
      { name: "image", label: "Card picture", type: "media" },
      // Options are this category's groups, supplied with the region.
      { name: "group", label: "Group", type: "select", options: [] },
      { name: "featured", label: "Featured", type: "boolean", help: "Featured services come first in their group." },
      { name: "published", label: "Show this service on the website", type: "boolean" },
      {
        name: "link",
        label: "Link",
        type: "link",
        surface: "card",
        generated: {
          explain:
            "The card opens the service's own page. Its address is the service's address, which titles never change.",
          source: SOURCE.services,
        },
      },
      {
        name: "badge",
        label: "Badge icon",
        type: "text",
        generated: {
          explain: "Chosen automatically from the kind of service, falling back to the category's icon.",
        },
      },
      {
        name: "action",
        label: "“Learn more”",
        type: "text",
        generated: { explain: "The site's standard wording, translated with the rest of the site." },
      },
    ],
  },
  {
    type: "route-category-hub",
    name: "Tour packages",
    description: "The panel that leads to the package catalogue, by destination.",
    scope: "any",
    fields: [
      text("eyebrow", "Eyebrow", { placeholder: "Tour Packages", help: STANDARD }),
      text("heading", "Heading", { placeholder: "Choose your destination", help: STANDARD }),
      area("description", "Description", 2, {
        placeholder: "Prepared programmes for every destination — take one as it stands, or ask us to change it.",
        help: STANDARD,
      }),
      text("ctaLabel", "Button — text", { surface: "button", placeholder: "View packages", help: STANDARD }),
      {
        name: "destinations",
        label: "Destinations",
        type: "text",
        box: "flex",
        generated: {
          explain:
            "One button per published destination with published packages, and how many it has. Destinations and packages are managed on their own screens.",
          source: SOURCE.destinations,
        },
      },
    ],
  },
  {
    type: "route-category-faqs",
    name: "Questions",
    description: "The category's frequently asked questions.",
    scope: "any",
    fields: [
      text("eyebrow", "Eyebrow", { placeholder: "Questions", help: STANDARD }),
      text("heading", "Heading", { placeholder: "Frequently asked questions", help: STANDARD }),
    ],
  },
  {
    type: "route-faq",
    name: "Question",
    description: "One frequently asked question.",
    scope: "any",
    fields: [
      text("question", "Question"),
      { name: "answer", label: "Answer", type: "richtext", localised: true },
      { name: "published", label: "Show this question on the website", type: "boolean" },
    ],
  },

  /* ------------------------------------------------------------------------ */
  /* A service's own page (Batch 22)                                          */
  /* ------------------------------------------------------------------------ */

  {
    type: "route-service-hero",
    name: "Service hero",
    description: "The service's own introduction: its category, title, short introduction, timeline, picture and calls to action.",
    scope: "any",
    fields: [
      {
        name: "category",
        label: "Category",
        type: "link",
        generated: {
          explain:
            "The category this service is filed under, linking to that category's page. Which category it is in is changed on the Services screen.",
          source: SOURCE.services,
        },
      },
      text("title", "Title", { help: "Changing the title never changes the page address." }),
      area("intro", "Short introduction", 3, {
        help: "Also this page's description for search engines and link previews.",
      }),
      text("timeline", "Indicative timeline", {
        help: "Free text, and optional. Leave it empty rather than publishing a duration you cannot stand behind.",
      }),
      { name: "image", label: "Picture", type: "media" },
      text("ctaLabel", "Request button — text", {
        surface: "button",
        placeholder: "Request this service",
        help: "Leave empty to use “Request this service”. The button opens this page's request form.",
      }),
      {
        name: "whatsapp",
        label: "WhatsApp button",
        type: "link",
        surface: "button",
        generated: {
          explain:
            "Shown when WhatsApp is switched on. The number and the switch are site settings, and the message names this service automatically.",
          source: SOURCE.whatsapp,
        },
      },
    ],
  },
  {
    type: "route-service-crumbs",
    name: "Breadcrumbs",
    description: "Where this page sits in the site, built from the category's and the service's titles.",
    scope: "any",
    still: true,
    fields: [
      {
        name: "trail",
        label: "Trail",
        type: "text",
        generated: {
          explain:
            "Built from the site structure, the category's title and this service's title. Change the title in the hero; the other steps are the site's own navigation.",
        },
      },
    ],
  },
  {
    type: "route-service-overview",
    name: "Overview",
    description: "The service's detailed description.",
    scope: "any",
    fields: [
      text("heading", "Heading", { placeholder: "Overview", help: STANDARD }),
      { name: "body", label: "Overview", type: "richtext", localised: true },
    ],
  },
  {
    type: "route-service-benefits",
    name: "Key benefits",
    description: "What the client gains, as a checked list.",
    scope: "any",
    fields: [
      text("heading", "Heading", { placeholder: "Key benefits", help: STANDARD }),
      {
        name: "benefits",
        label: "Benefits",
        type: "items",
        // Stored as a plain list: its rows have no id (see `FieldDef.positional`).
        positional: true,
        // The two-column checked list.
        box: "grid",
        maxItems: 16,
        help: "One line each. Shown as a checked list.",
        itemFields: [{ name: "text", label: "Benefit", localised: true }],
      },
    ],
  },
  {
    type: "route-service-audience",
    name: "Who this is for",
    description: "Who the service suits, as a row of labels.",
    scope: "any",
    fields: [
      text("heading", "Heading", { placeholder: "Who this is for", help: STANDARD }),
      {
        name: "audience",
        label: "Audience",
        type: "items",
        // Stored as a plain list: its rows have no id (see `FieldDef.positional`).
        positional: true,
        // A wrapping row of pills.
        box: "flex",
        maxItems: 16,
        itemFields: [{ name: "text", label: "Label", localised: true }],
      },
    ],
  },
  {
    type: "route-service-requirements",
    name: "Documents and requirements",
    description: "What the client has to provide.",
    scope: "any",
    fields: [
      text("heading", "Heading", { placeholder: "Documents and requirements", help: STANDARD }),
      {
        name: "requirements",
        label: "Requirements",
        type: "items",
        // Stored as a plain list: its rows have no id (see `FieldDef.positional`).
        positional: true,
        // A ruled list in ordinary block flow.
        maxItems: 16,
        help: "Never publish a requirement you are not sure of — these change, and the page is what a client will hold you to.",
        itemFields: [{ name: "text", label: "Requirement", localised: true }],
      },
    ],
  },
  {
    type: "route-service-process",
    name: "How the process runs",
    description: "The numbered steps from enquiry to completion.",
    scope: "any",
    fields: [
      text("heading", "Heading", { placeholder: "How the process runs", help: STANDARD }),
      {
        name: "steps",
        label: "Steps",
        type: "items",
        // Stored as a plain list: its rows have no id (see `FieldDef.positional`).
        positional: true,
        // A numbered <ol> in ordinary block flow, its rail positioned beside it.
        maxItems: 10,
        itemFields: [
          { name: "title", label: "Step", localised: true },
          { name: "detail", label: "Detail", type: "textarea", localised: true },
        ],
      },
    ],
  },
  {
    type: "route-service-notes",
    name: "Important notes",
    description: "Caveats and conditions, boxed.",
    scope: "any",
    fields: [
      text("heading", "Heading", { placeholder: "Important notes", help: STANDARD }),
      { name: "notes", label: "Notes", type: "richtext", localised: true },
    ],
  },
  {
    type: "route-service-faqs",
    name: "Questions",
    description: "This service's frequently asked questions, with its category's.",
    scope: "any",
    fields: [
      text("heading", "Heading", { placeholder: "Frequently asked questions", help: STANDARD }),
      {
        name: "inherited",
        label: "The category's questions",
        type: "text",
        generated: {
          explain:
            "Questions that belong to this service's category appear on every service page in it, between this service's own. They are edited on the category's page, so one change reaches every service it applies to. Questions are added on the FAQs screen.",
          source: SOURCE.faqs,
        },
      },
    ],
  },
  {
    type: "route-service-notices",
    name: "Notices",
    description: "The site's standing notices for service pages.",
    scope: "any",
    fields: [
      {
        name: "notes",
        label: "Notices",
        type: "text",
        generated: {
          explain:
            "The site's disclaimers, worded and switched on in the site settings. Visa services also show the visa notice.",
          source: SOURCE.disclaimers,
        },
      },
    ],
  },
  {
    type: "route-service-request",
    name: "Request form",
    description: "The request form beside the page, with its heading.",
    scope: "any",
    fields: [
      text("heading", "Heading", { placeholder: "Request a service", help: STANDARD }),
      area("intro", "Introduction", 2, {
        placeholder: "Tell us what you need and an advisor will come back to you.",
        help: STANDARD,
      }),
      {
        name: "form",
        label: "Form",
        type: "text",
        generated: {
          explain:
            "The site's request form, with this service already chosen. Which extra questions it asks for this service is set on the Services screen (Request form).",
          source: SOURCE.services,
        },
      },
    ],
  },
  {
    type: "route-service-related",
    name: "Related services",
    description: "Other services from the same category.",
    scope: "any",
    fields: [
      text("heading", "Heading", { placeholder: "Related services", help: STANDARD }),
      {
        name: "items",
        label: "Services",
        // A list's box: the four-across grid of links, laid out as a grid, so
        // its gap and columns are the controls that mean something on it.
        type: "items",
        box: "grid",
        generated: {
          explain:
            "The first four other published services of this category, in the category's own order. Their titles and order are managed on the category's page and the Services screen.",
          source: SOURCE.services,
        },
      },
    ],
  },

  /* ------------------------------------------------------------------------ */
  /* A package's own page (Batch 24)                                          */
  /* ------------------------------------------------------------------------ */

  {
    type: "route-package-hero",
    name: "Package hero",
    description: "The package's own introduction: its title, place, duration, summary, picture and calls to action.",
    scope: "any",
    fields: [
      {
        name: "eyebrow",
        label: "Catalogue link",
        type: "link",
        generated: {
          explain: "The site's own link back to the package catalogue, in its standard wording.",
          source: SOURCE.packages,
        },
      },
      text("title", "Title", { help: "Changing the title never changes the page address." }),
      text("place", "Place", {
        help: "The place shown beside the map pin, as free text. Which destination the package is filed under is chosen on its card on the Tour packages page.",
      }),
      text("duration", "Duration", { help: "Free text — “5 nights”, “flexible”. Never a computed price." }),
      area("summary", "Summary", 3, {
        help: "Also the package's card text, and this page's description for search engines and link previews.",
      }),
      { name: "image", label: "Picture", type: "media" },
      text("ctaLabel", "Request button — text", {
        surface: "button",
        placeholder: "Request this service",
        help: "Leave empty to use the standard wording. The button opens this page's request form.",
      }),
      {
        name: "whatsapp",
        label: "WhatsApp button",
        type: "link",
        surface: "button",
        generated: {
          explain:
            "Shown when WhatsApp is switched on. The number and the switch are site settings, and the message names this package automatically.",
          source: SOURCE.whatsapp,
        },
      },
    ],
  },
  crumbs(
    "route-package-crumbs",
    "Where this page sits in the site, built from the package's title.",
    "Built from the site structure and the package's title. Change the title in the hero; the other steps are the site's own navigation.",
  ),
  {
    type: "route-package-body",
    name: "Description",
    description: "The package's detailed description.",
    scope: "any",
    fields: [{ name: "body", label: "Description", type: "richtext", localised: true }],
  },
  {
    type: "route-package-highlights",
    name: "Highlights",
    description: "What the programme includes, as a checked list.",
    scope: "any",
    fields: [
      text("heading", "Heading", { placeholder: "What the programme includes", help: STANDARD }),
      {
        name: "highlights",
        label: "Highlights",
        type: "items",
        // Stored as a plain list: its rows have no id (see `FieldDef.positional`).
        positional: true,
        // The two-column checked list.
        box: "grid",
        maxItems: 16,
        help: "One line each. Shown as a checked list.",
        itemFields: [{ name: "text", label: "Highlight", localised: true }],
      },
    ],
  },
  {
    type: "route-package-request",
    name: "Request form",
    description: "The request form beside the page, with its heading.",
    scope: "any",
    fields: [
      text("heading", "Heading", { placeholder: "Request a service", help: STANDARD }),
      area("intro", "Introduction", 2, {
        placeholder: "Tell us what you need and an advisor will come back to you.",
        help: STANDARD,
      }),
      {
        name: "form",
        label: "Form",
        type: "text",
        generated: {
          explain: "The site's request form, set up for a travel enquiry. Its questions are the site's own.",
          source: SOURCE.packages,
        },
      },
    ],
  },

  /* ------------------------------------------------------------------------ */
  /* A destination's own page (Batch 24)                                      */
  /* ------------------------------------------------------------------------ */

  {
    type: "route-destination-hero",
    name: "Destination hero",
    description: "The destination's own introduction: its title, summary and picture.",
    scope: "any",
    fields: [
      text("eyebrow", "Eyebrow", { placeholder: "Tour Packages", help: STANDARD }),
      text("title", "Title", {
        help: "Changing the title never changes the page address. The address is set on Packages › Destinations.",
      }),
      area("summary", "Summary", 3, {
        help: "Also this page's description for search engines and link previews.",
      }),
      { name: "image", label: "Picture", type: "media" },
    ],
  },
  crumbs(
    "route-destination-crumbs",
    "Where this page sits in the site, built from the destination's title.",
    "Built from the site structure and the destination's title. Change the title in the hero; the other steps are the site's own navigation.",
  ),
  {
    type: "route-destination-packages",
    name: "Packages",
    description: "The packages filed under this destination.",
    scope: "any",
    fields: [
      {
        name: "cards",
        label: "Packages",
        type: "items",
        box: "grid",
        generated: {
          explain:
            "One card per published package filed under this destination, featured first. Each card's words and picture are its package's own: edit them on the Tour packages page or on the package's own page. Which destination a package is under is chosen on its card on the Tour packages page.",
          source: SOURCE.packages,
        },
      },
      text("backLabel", "Link back — text", { placeholder: "Destinations", help: STANDARD }),
    ],
  },

  /* ------------------------------------------------------------------------ */
  /* The package catalogue, /packages (Batch 24)                              */
  /* ------------------------------------------------------------------------ */

  {
    type: "route-package-index-hero",
    name: "Catalogue hero",
    description: "The package catalogue's introduction.",
    scope: "any",
    fields: [
      text("eyebrow", "Eyebrow", { placeholder: "Travel & tourism", help: STANDARD }),
      text("heading", "Heading", { placeholder: "Prepared itineraries, built to be changed", help: STANDARD }),
      area("intro", "Introduction", 3, {
        placeholder: "Start from a prepared programme or ask for one built around you — flights, hotels, transfers and a guide.",
        help: STANDARD,
      }),
    ],
  },
  crumbs(
    "route-package-index-crumbs",
    "Where this page sits in the site.",
    "The site's own navigation: Home, then this page.",
  ),
  {
    type: "route-package-index-catalogue",
    name: "Catalogue",
    description: "Every published package, grouped by destination.",
    scope: "any",
    fields: [
      {
        name: "regions",
        label: "Region headings",
        type: "text",
        generated: {
          explain:
            "While no destination holds a published package, the catalogue groups packages by their old region label, as it always has. Create destinations on Packages › Destinations and file the packages under them to group by destination instead.",
          source: SOURCE.destinations,
        },
      },
      {
        name: "empty",
        label: "Empty catalogue",
        type: "text",
        generated: { explain: "Shown, in the site's standard wording, while no package is published.", source: SOURCE.packages },
      },
    ],
  },
  {
    type: "route-destination-group",
    name: "Destination group",
    description: "One destination's packages on the catalogue.",
    scope: "any",
    fields: [
      text("title", "Destination name", { help: "The destination's own name — also the title of its page." }),
      text("linkLabel", "Link — text", { placeholder: "View packages", help: STANDARD }),
      {
        name: "link",
        label: "Link",
        type: "link",
        generated: {
          explain: "Goes to the destination's own page. Its address is set on Packages › Destinations.",
          source: SOURCE.destinations,
        },
      },
      {
        name: "cards",
        label: "Packages",
        type: "items",
        box: "grid",
        generated: {
          explain:
            "The destination's packages, featured first and then in the Packages screen's order. Select a card to edit it; a card's destination is chosen on the card.",
          source: SOURCE.packages,
        },
      },
    ],
  },
  {
    type: "route-package-card",
    name: "Package card",
    description: "One package, as its card on the catalogue.",
    scope: "any",
    fields: [
      text("title", "Title", { help: "Changing the title never changes the package's address." }),
      text("place", "Place", { help: "The place shown beside the map pin, as free text." }),
      text("duration", "Duration", { help: "Free text — “5 nights”, “flexible”." }),
      area("summary", "Summary", 3, { help: "Also the package page's introduction." }),
      { name: "image", label: "Card picture", type: "media" },
      // Options are the site's destinations, supplied with the region.
      { name: "group", label: "Destination", type: "select", options: [] },
      { name: "featured", label: "Featured", type: "boolean", help: "Featured packages come first." },
      {
        name: "published",
        label: "Show this package on the website",
        type: "boolean",
        help: "A hidden package's own page is hidden with it.",
      },
      {
        name: "link",
        label: "Link",
        type: "link",
        surface: "card",
        generated: {
          explain: "The card opens the package's own page. Its address is the package's, which titles never change.",
          source: SOURCE.packages,
        },
      },
      {
        name: "action",
        label: "“View details”",
        type: "text",
        generated: { explain: "The site's standard wording, translated with the rest of the site." },
      },
    ],
  },
  {
    type: "route-package-index-custom",
    name: "Build your own",
    description: "Packages filed under no destination, with an invitation to ask for a programme of one's own.",
    scope: "any",
    fields: [
      text("heading", "Heading", { placeholder: "Build your own", help: STANDARD }),
      area("intro", "Introduction", 2, {
        placeholder: "Not on the list? Tell us the dates and the party, and we will put a programme together.",
        help: STANDARD,
      }),
      {
        name: "cards",
        label: "Packages",
        type: "items",
        box: "grid",
        generated: {
          explain:
            "Published packages filed under no destination, or under one that is not published. Select a card to edit it, or file it under a destination.",
          source: SOURCE.packages,
        },
      },
    ],
  },

  /* ------------------------------------------------------------------------ */
  /* The services overview, /services (Batch 24)                              */
  /* ------------------------------------------------------------------------ */

  {
    type: "route-service-index-hero",
    name: "Services overview hero",
    description: "The services overview's introduction.",
    scope: "any",
    fields: [
      text("eyebrow", "Eyebrow", { placeholder: "What we do", help: STANDARD }),
      text("heading", "Heading", { placeholder: "Everything you need, handled from one desk", help: STANDARD }),
      area("intro", "Introduction", 3, {
        placeholder: "Five service groups covering travel, business setup and company formation, residency and employee services, licensing and government support.",
        help: "Leave empty to use the standard wording, which follows the service catalogue.",
      }),
    ],
  },
  crumbs(
    "route-service-index-crumbs",
    "Where this page sits in the site.",
    "The site's own navigation: Home, then this page.",
  ),
  {
    type: "route-service-index-categories",
    name: "Service categories",
    description: "Every published service category, with its services.",
    scope: "any",
    fields: [
      {
        name: "categories",
        label: "Categories",
        type: "items",
        generated: {
          explain:
            "One row per published service category, in the categories' own order: its icon, title, summary, picture and published services. Each is edited on that category's own page in the Visual Editor — choose it from the page list; categories and services are added on their screens.",
          source: SOURCE.categories,
        },
      },
    ],
  },
];

export const ROUTE_BLOCK_MAP = new Map(ROUTE_BLOCKS.map((block) => [block.type, block]));

/** Which block each owner type is drawn as. */
export const ROUTE_BLOCK_OF: Record<RouteOwnerType, string> = {
  category: "route-category-hero",
  categoryCrumbs: "route-category-crumbs",
  categoryBody: "route-category-body",
  categoryServices: "route-category-services",
  subcategory: "route-subcategory",
  service: "route-service-card",
  categoryHub: "route-category-hub",
  categoryFaqs: "route-category-faqs",
  faq: "route-faq",
  serviceHero: "route-service-hero",
  serviceCrumbs: "route-service-crumbs",
  serviceOverview: "route-service-overview",
  serviceBenefits: "route-service-benefits",
  serviceAudience: "route-service-audience",
  serviceRequirements: "route-service-requirements",
  serviceProcess: "route-service-process",
  serviceNotes: "route-service-notes",
  serviceFaqs: "route-service-faqs",
  serviceNotices: "route-service-notices",
  serviceRequest: "route-service-request",
  serviceRelated: "route-service-related",
  packageHero: "route-package-hero",
  packageCrumbs: "route-package-crumbs",
  packageBody: "route-package-body",
  packageHighlights: "route-package-highlights",
  packageRequest: "route-package-request",
  destinationHero: "route-destination-hero",
  destinationCrumbs: "route-destination-crumbs",
  destinationPackages: "route-destination-packages",
  packageIndexHero: "route-package-index-hero",
  packageIndexCrumbs: "route-package-index-crumbs",
  packageIndexCatalogue: "route-package-index-catalogue",
  destinationGroup: "route-destination-group",
  packageCard: "route-package-card",
  packageIndexCustom: "route-package-index-custom",
  serviceIndexHero: "route-service-index-hero",
  serviceIndexCrumbs: "route-service-index-crumbs",
  serviceIndexCategories: "route-service-index-categories",
};

export const isRouteBlockType = (type: string): boolean => ROUTE_BLOCK_MAP.has(type);

/** The fields of a block the Content tab draws as inputs — never a generated one. */
export const generatedFieldsOf = (block: BlockDef): FieldDef[] => block.fields.filter((field) => field.generated);

/** The reserved key a region's child order rides under. */
export const ORDER_KEY = "_order";

/**
 * Fields that decide whether and where something appears rather than what it
 * says: layout, so `content.structure` (Batch 18) as well as the record's own
 * capability. The adapter marks the same fields `structural`.
 */
export const ROUTE_STRUCTURAL_FIELDS: ReadonlySet<string> = new Set(["published", "group"]);

/**
 * The list a region is a member of, by its block: groups and ungrouped cards
 * are ordered by the services section, cards in a group by the group, and
 * questions by the questions section — a category's, or on a service's page
 * (Batch 22) the service's own. The names are the `_order` keys the
 * containers store.
 */
export const ROUTE_LIST_OF: Readonly<Record<string, "groups" | "services" | "faqs">> = {
  "route-subcategory": "groups",
  "route-service-card": "services",
  "route-faq": "faqs",
};
