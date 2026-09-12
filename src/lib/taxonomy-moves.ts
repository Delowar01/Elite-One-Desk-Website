/**
 * Where the retired addresses went.
 *
 * The 2026 restructure merged Company Formation into Business Setup, renamed
 * General Services to Iqama & Employee Services, and dissolved the Egypt
 * subcategory — twelve of whose services duplicated a generic Travel service
 * and six of which were really destination content belonging in the package
 * catalogue.
 *
 * These maps are consulted ONLY when a slug is absent from the database, by
 * the route that was going to call `notFound()` anyway. That is the whole
 * design:
 *
 *   · Before the cutover the old slugs still resolve, so nothing redirects and
 *     the live site is untouched by shipping this file.
 *   · After the cutover they miss, and the redirect fires.
 *   · Middleware is never involved, so the locale rewrite — which once turned
 *     a redirect into a loop — cannot participate.
 *
 * Two rules hold, and `tests/public-routes.test.ts` enforces them against the
 * running site: no target may also be a key, and every target must be an
 * address that actually answers 200 after the cutover.
 */

/**
 * A category that moved wholesale. Covers the category page and every service
 * beneath it: `/services/<old>/<anything>` → `/services/<new>/<anything>`,
 * because none of the moved services changed its own slug.
 *
 * 2 entries · 20 English addresses (2 categories + 18 services).
 */
export const CATEGORY_MOVES: Readonly<Record<string, string>> = {
  "company-formation": "business-setup",
  "general-services": "iqama-services",
};

/**
 * A single service that moved somewhere its category cannot imply — keyed
 * `<category>/<service>` because a service slug is only unique within its
 * category.
 *
 * 13 entries · 13 English addresses. Seven land on the generic Travel service
 * they always duplicated; six land in the package catalogue, where that
 * content belongs.
 *
 * `professional-tour-guide` is deliberately absent: it moved subcategory, not
 * category, and kept its address.
 */
export const SERVICE_MOVES: Readonly<Record<string, string>> = {
  // Duplicates of a generic Travel & Holiday service.
  "travel-tourism/egypt-flight-booking": "/services/travel-tourism/air-ticket-booking",
  "travel-tourism/cairo-hotel-packages": "/services/travel-tourism/hotel-reservation",
  "travel-tourism/airport-pickup-and-drop-off": "/services/travel-tourism/airport-transfer",
  "travel-tourism/group-tour-package": "/services/travel-tourism/group-tour-packages",
  "travel-tourism/family-tour-package": "/services/travel-tourism/family-tour-packages",
  "travel-tourism/customized-egypt-tour-package":
    "/services/travel-tourism/customized-travel-itinerary",
  "travel-tourism/honeymoon-package": "/services/travel-tourism/honeymoon-packages",

  // Destination content: three to the package that covers it, three to Egypt.
  "travel-tourism/giza-pyramid-tour": "/packages/cairo-and-giza-classic",
  "travel-tourism/nile-river-cruise": "/packages/nile-cruise-luxor-aswan",
  "travel-tourism/sharm-el-sheikh-tour": "/packages/red-sea-sharm-el-sheikh",
  "travel-tourism/cairo-city-tour": "/packages/egypt",
  "travel-tourism/egyptian-museum-visit": "/packages/egypt",
  "travel-tourism/hurghada-holiday-package": "/packages/egypt",
};

/** Where a retired category slug now lives, or null if it is simply unknown. */
export function categoryMove(slug: string): string | null {
  const moved = CATEGORY_MOVES[slug];
  return moved ? `/services/${moved}` : null;
}

/**
 * Where a retired service address now lives. An individual move wins over its
 * category's move, so a service that went to the package catalogue is not
 * dragged along to the renamed category.
 */
export function serviceMove(category: string, service: string): string | null {
  const exact = SERVICE_MOVES[`${category}/${service}`];
  if (exact) return exact;
  const movedCategory = CATEGORY_MOVES[category];
  return movedCategory ? `/services/${movedCategory}/${service}` : null;
}
