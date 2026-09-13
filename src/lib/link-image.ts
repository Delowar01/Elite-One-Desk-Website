/**
 * The picture that belongs to whatever a site link points at.
 *
 * A quick-access card is meant to look like the page behind it, and the
 * catalogue already knows what that page looks like: a category, a service and
 * a destination each carry an image an admin chose. So the card asks the href
 * rather than being told an id — which means the section is already visual
 * before anybody opens the panel, and it follows the catalogue afterwards. Give
 * Travel & Tourism a new photograph and every card that leads there changes
 * with it.
 *
 * Resolution is by slug against rows the page has already loaded. Nothing here
 * holds a database id, so there is no list to keep in step with the data.
 */

type Entity = { slug: string; imageId: number | null };
type Service = Entity & { categoryId: number };
type Category = Entity & { id: number };

export type LinkCatalogue = {
  categories: readonly Category[];
  services: readonly Service[];
  destinations: readonly Entity[];
  packages: readonly Entity[];
};

/**
 * The address as the catalogue sees it: no language prefix, no query, no
 * fragment. `/ar/services/x?a=1#b` and `/services/x` are the same page, and
 * `#company-formation-registration` is a heading on a page rather than a page.
 */
function segments(href: string): string[] {
  if (!href || !href.startsWith("/")) return [];
  const path = href.split(/[?#]/)[0] ?? "";
  const parts = path.split("/").filter(Boolean);
  return parts[0] === "ar" || parts[0] === "en" ? parts.slice(1) : parts;
}

export function imageForHref(href: string, catalogue: LinkCatalogue): number | null {
  const parts = segments(href);
  if (parts.length < 2) return null;
  const [section, first, second] = parts;

  if (section === "services") {
    const category = catalogue.categories.find((row) => row.slug === first);
    if (!category) return null;
    if (!second) return category.imageId;
    // Service slugs are unique per category, not site-wide, so the lookup is
    // scoped — otherwise two categories with a similarly named service would
    // hand the card the wrong picture.
    const service = catalogue.services.find(
      (row) => row.slug === second && row.categoryId === category.id,
    );
    return service?.imageId ?? category.imageId;
  }

  if (section === "packages") {
    // `/packages/<slug>` is one namespace shared by destinations and packages,
    // and the public route resolves a destination first. Reading it the other
    // way round here would show a package's picture on a card that opens a
    // destination.
    const destination = catalogue.destinations.find((row) => row.slug === first);
    if (destination) return destination.imageId;
    return catalogue.packages.find((row) => row.slug === first)?.imageId ?? null;
  }

  return null;
}
