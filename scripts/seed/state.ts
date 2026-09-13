import { db } from "../../src/lib/db";
import { serviceCategories, serviceSubcategories } from "../../src/lib/db/schema";
import { taxonomyStateOf, type TaxonomyState } from "../../src/lib/taxonomy-state";

/** `db`, or a transaction handle — the cutover asks inside its own transaction. */
type Executor = Pick<typeof db, "select">;

/**
 * Asked once before the seed touches the catalogue, and once at the top of the
 * cutover.
 *
 * The seed inserts a category when it cannot find one by slug. That is correct
 * for an empty database and harmless for a restructured one, and actively wrong
 * for a database that has not been restructured yet: seeded from the new
 * catalogue, it would not find `iqama-services`, and would create it — empty,
 * beside the live `general-services`, and visible on the website. Its thirteen
 * services would all be found by their own slugs and skipped, so the ghost
 * would never even fill up.
 *
 * The test itself lives in `src/lib/taxonomy-state.ts`, because the public pages
 * that describe the catalogue in words need the same answer.
 */
export async function taxonomyState(on: Executor = db): Promise<TaxonomyState> {
  const [categories, subcategories] = await Promise.all([
    on.select({ slug: serviceCategories.slug }).from(serviceCategories),
    on.select({ slug: serviceSubcategories.slug }).from(serviceSubcategories),
  ]);
  return taxonomyStateOf(
    categories.map((row) => row.slug),
    subcategories.map((row) => row.slug),
  );
}

/** The line the seed prints when it declines to touch a legacy catalogue. */
export const LEGACY_NOTICE = [
  "· legacy taxonomy detected — general-services / company-formation / egypt-tours",
  "  present. Catalogue, destinations and navigation seeding skipped so that no",
  "  duplicate category is created beside the live one.",
  "  Run `npm run restructure -- --dry-run` when you are ready to cut over.",
].join("\n");

export type { TaxonomyState };
