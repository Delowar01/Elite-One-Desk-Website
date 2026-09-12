import { eq, sql } from "drizzle-orm";

import { db } from "../../src/lib/db";
import { serviceCategories, serviceSubcategories } from "../../src/lib/db/schema";

/** `db`, or a transaction handle — the cutover asks inside its own transaction. */
type Executor = Pick<typeof db, "select">;

/**
 * Which taxonomy a database is holding, asked once before the seed touches the
 * catalogue.
 *
 * The seed inserts a category when it cannot find one by slug. That is correct
 * for an empty database and harmless for a restructured one, and actively wrong
 * for a database that has not been restructured yet: seeded from the new
 * catalogue, it would not find `iqama-services`, and would create it — empty,
 * beside the live `general-services`, and visible on the website. Its thirteen
 * services would all be found by their own slugs and skipped, so the ghost
 * would never even fill up.
 *
 * Hence this check, and hence its shape. It asks whether the OLD slugs are
 * still present, not whether the new ones are missing: "is `iqama-services`
 * there?" answers yes in a half-finished state, while "is `general-services`
 * still there?" answers the question that actually decides what is safe to do.
 */
export type TaxonomyState = "fresh" | "legacy" | "restructured";

/** Any one of these means the cutover has not run. */
const LEGACY_CATEGORY_SLUGS = ["general-services", "company-formation"];
const LEGACY_SUBCATEGORY_SLUGS = ["egypt-tours"];

export async function taxonomyState(on: Executor = db): Promise<TaxonomyState> {
  const [{ categories }] = await on
    .select({ categories: sql<number>`count(*)::int` })
    .from(serviceCategories);
  if (categories === 0) return "fresh";

  for (const slug of LEGACY_CATEGORY_SLUGS) {
    const [row] = await on
      .select({ id: serviceCategories.id })
      .from(serviceCategories)
      .where(eq(serviceCategories.slug, slug))
      .limit(1);
    if (row) return "legacy";
  }
  for (const slug of LEGACY_SUBCATEGORY_SLUGS) {
    const [row] = await on
      .select({ id: serviceSubcategories.id })
      .from(serviceSubcategories)
      .where(eq(serviceSubcategories.slug, slug))
      .limit(1);
    if (row) return "legacy";
  }
  return "restructured";
}

/** The line the seed prints when it declines to touch a legacy catalogue. */
export const LEGACY_NOTICE = [
  "· legacy taxonomy detected — general-services / company-formation / egypt-tours",
  "  present. Catalogue, destinations and navigation seeding skipped so that no",
  "  duplicate category is created beside the live one.",
  "  Run `npm run restructure -- --dry-run` when you are ready to cut over.",
].join("\n");
