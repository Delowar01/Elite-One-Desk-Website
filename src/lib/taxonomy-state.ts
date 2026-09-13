/**
 * Which taxonomy a database is holding.
 *
 * There is one definition of this question because there were nearly two. The
 * seed has to ask it before it touches the catalogue, the cutover has to ask it
 * before it runs, and the pages that describe the catalogue in words — "five
 * service groups…" — have to ask it before they choose their copy. Three
 * answers drifting apart is how a site ends up announcing five groups above a
 * list of six.
 *
 * It asks whether the OLD slugs are still present rather than whether the new
 * ones are missing: "is `iqama-services` there?" answers yes in a half-finished
 * state, while "is `general-services` still there?" answers the question that
 * actually decides what is safe to say and to do.
 *
 * Deliberately not a count. Six categories is what legacy happens to have
 * today, not what legacy means, and an editor adding a category tomorrow must
 * not move the site back into its old wording.
 */
export type TaxonomyState = "fresh" | "legacy" | "restructured";

/** Any one of these means the 2026 cutover has not run. */
export const LEGACY_CATEGORY_SLUGS = ["general-services", "company-formation"] as const;
export const LEGACY_SUBCATEGORY_SLUGS = ["egypt-tours"] as const;

/**
 * The whole test, over slugs the caller already has. No query of its own, so a
 * page that has loaded the catalogue asks for free and a script can hand over
 * two `select slug` results.
 */
export function taxonomyStateOf(
  categorySlugs: readonly string[],
  subcategorySlugs: readonly string[] = [],
): TaxonomyState {
  if (categorySlugs.length === 0) return "fresh";
  const categories = new Set(categorySlugs);
  const subcategories = new Set(subcategorySlugs);
  if (LEGACY_CATEGORY_SLUGS.some((slug) => categories.has(slug))) return "legacy";
  if (LEGACY_SUBCATEGORY_SLUGS.some((slug) => subcategories.has(slug))) return "legacy";
  return "restructured";
}

/** True while the site should still describe itself the way it did before. */
export const isLegacyTaxonomy = (
  categorySlugs: readonly string[],
  subcategorySlugs: readonly string[] = [],
) => taxonomyStateOf(categorySlugs, subcategorySlugs) === "legacy";
