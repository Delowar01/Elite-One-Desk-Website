import type { RouteKind } from "@/lib/routes/owners";

/**
 * What the editor says about each kind of dynamic route (Batch 24).
 *
 * The route panel, route Layers and the shell each used to choose between two
 * sentences — a category's page or a service's — inline. Six kinds of page
 * would have been six inline branches in three places, free to drift apart;
 * this is the one table they all read, client-safe and plain.
 */
export type RouteKindText = {
  /** The noun in the editor's own sentences: "service page". */
  noun: string;
  /** Route Layers' heading: "Service". */
  heading: string;
  /** Route Layers, for a role without `content.structure`. */
  structureNote: string;
  /** The route panel: what publishing this page writes. */
  publishNote: string;
  /** The route panel, while visitors cannot open the page. */
  unpublishedNote: string;
};

export const ROUTE_KIND_TEXT: Record<RouteKind, RouteKindText> = {
  category: {
    noun: "category page",
    heading: "Service category",
    structureNote:
      "You can view this page’s structure, but your role does not allow reordering or hiding its groups, services or questions.",
    publishNote:
      "Publishing changes what visitors see on this category page and writes the category, its groups, services and questions in one step. The Service Categories, Services and FAQs screens keep working as before.",
    unpublishedNote:
      "This category is not published, so visitors cannot open this page yet. That is set on the Service Categories screen.",
  },
  service: {
    noun: "service page",
    heading: "Service",
    structureNote:
      "You can view this page’s structure, but your role does not allow reordering or hiding its questions.",
    publishNote:
      "Publishing changes what visitors see on this service's page and writes the service and its own questions in one step. The Services and FAQs screens keep working as before.",
    unpublishedNote:
      "This service — or its category — is not published, so visitors cannot open this page yet. That is set on the Services and Service Categories screens.",
  },
  package: {
    noun: "package page",
    heading: "Package",
    structureNote: "You can view this page’s structure. Nothing on a package's page is reordered or hidden here.",
    publishNote:
      "Publishing changes what visitors see on this package's page and writes the package in one step. The Packages screen keeps working as before.",
    unpublishedNote:
      "This package is not published, so visitors cannot open this page yet. That is set on its card on the Tour packages page, or on the Packages screen.",
  },
  destination: {
    noun: "destination page",
    heading: "Destination",
    structureNote: "You can view this page’s structure. Nothing on a destination's page is reordered or hidden here.",
    publishNote:
      "Publishing changes what visitors see on this destination's page and writes the destination in one step. Its packages' cards are edited on the Tour packages page. The Destinations screen keeps working as before.",
    unpublishedNote:
      "This destination is not published, so visitors cannot open this page yet. That is set on Packages › Destinations.",
  },
  packageIndex: {
    noun: "catalogue",
    heading: "Tour packages",
    structureNote:
      "You can view this page’s structure, but your role does not allow hiding packages or filing them under another destination.",
    publishNote:
      "Publishing changes what visitors see on the Tour packages page and writes the destinations and packages it changes in one step. The Packages and Destinations screens keep working as before.",
    unpublishedNote: "",
  },
  serviceIndex: {
    noun: "services overview",
    heading: "Services overview",
    structureNote: "You can view this page’s structure. Its rows are the service categories, edited on their own pages.",
    publishNote:
      "Publishing changes the services overview's own wording. Every row is a service category's, published from that category's page.",
    unpublishedNote: "",
  },
};
