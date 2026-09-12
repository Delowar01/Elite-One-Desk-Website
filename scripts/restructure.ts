import "./env";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import {
  navigationItems,
  packageDestinations,
  pageSections,
  pages,
  serviceCategories,
  serviceSubcategories,
  services,
  travelPackages,
} from "../src/lib/db/schema";
import { NAVIGATION } from "./seed/content";
import { taxonomyState } from "./seed/state";

/**
 * The 2026 service restructure, as one transaction.
 *
 *   npm run restructure -- --dry-run   # does everything, then rolls back
 *   npm run restructure                # does everything, then commits
 *
 * Six categories become five: Company Formation merges into Business Setup,
 * General Services becomes Iqama & Employee Services, and the Egypt
 * subcategory dissolves — twelve of its fourteen services duplicated a generic
 * Travel service or belonged in the package catalogue, and the other two are
 * promoted. Egypt becomes a package destination, which is what it always was.
 *
 * Three properties, in the order they matter:
 *
 *  1. ATOMIC. Every statement runs in one transaction with every assertion
 *     inside it. A failure anywhere leaves production byte-identical.
 *  2. EXCLUSIVE. A transaction-scoped advisory lock stops two of these running
 *     at once, and SHARE ROW EXCLUSIVE on the seven tables it mutates stops an
 *     admin saving into the middle of it. Plain SELECT is unaffected, so the
 *     public site keeps serving and enquiries keep being written — the enquiry
 *     tables are not in the lock set.
 *  3. IDEMPOTENT. A second run detects the finished state and does nothing.
 *
 * It is never invoked by deploy.sh. The cutover is a decision somebody makes.
 */

const DRY_RUN = process.argv.includes("--dry-run");

/** Thrown to roll a dry run back once it has proved the whole thing works. */
const ROLLBACK = Symbol("dry-run rollback");

/** Arbitrary but fixed: any two runs must ask for the same lock. */
const ADVISORY_LOCK_KEY = 728_104_2026;

/**
 * A provisional position for the two promoted services: high enough to be last
 * inside Travel & Holiday whatever the live numbering is, and adjacent so the
 * two keep the order the catalogue lists them in. Step 8b renumbers it away.
 */
const PROMOTED_ORDER = 9_000;

const log = (line = "") => console.log(line);
const step = (line: string) => console.log(`· ${line}`);

/* -------------------------------------------------------------------------- */
/* What moves                                                                  */
/* -------------------------------------------------------------------------- */

/** Duplicates of a generic Travel service, or destination content. */
const DELETE_SERVICE_SLUGS = [
  "egypt-flight-booking",
  "cairo-hotel-packages",
  "cairo-city-tour",
  "giza-pyramid-tour",
  "egyptian-museum-visit",
  "nile-river-cruise",
  "sharm-el-sheikh-tour",
  "hurghada-holiday-package",
  "airport-pickup-and-drop-off",
  "group-tour-package",
  "family-tour-package",
  "customized-egypt-tour-package",
];

const CATEGORY_TITLES: Record<string, { en: string; ar: string }> = {
  "business-setup": { en: "Business Setup & Company Formation", ar: "تأسيس الأعمال والشركات" },
  "iqama-services": { en: "Iqama & Employee Services", ar: "خدمات الإقامة والموظفين" },
  "license-renewal": { en: "License Renewal & Compliance", ar: "تجديد التراخيص والامتثال" },
  "government-relations": { en: "Government & General Services", ar: "الخدمات الحكومية والعامة" },
};

const EGYPT = {
  slug: "egypt",
  titleEn: "Egypt",
  titleAr: "مصر",
  summaryEn:
    "Explore Egypt through curated travel packages covering Cairo, Giza, the Nile, Luxor, Aswan, Sharm El Sheikh and Hurghada. Choose a ready itinerary or contact us to tailor your trip.",
  summaryAr:
    "اكتشف مصر من خلال باقات سفر مختارة تشمل القاهرة والجيزة والنيل والأقصر وأسوان وشرم الشيخ والغردقة. اختر برنامجاً جاهزاً أو تواصل معنا لتخصيص رحلتك.",
  sortOrder: 0,
};

/**
 * Addresses stored inside section content, not in the catalogue. Only whole
 * hrefs are replaced, so a longer address that merely starts the same way is
 * left alone. The Company Formation category becomes a subcategory of Business
 * Setup, so its link becomes the anchor for that block on the category page.
 */
const SECTION_HREF_MOVES: Record<string, string> = {
  "/services/company-formation": "/services/business-setup#company-formation-registration",
  "/services/general-services": "/services/iqama-services",
};

const EGYPT_PACKAGE_SLUGS = [
  "cairo-and-giza-classic",
  "nile-cruise-luxor-aswan",
  "red-sea-sharm-el-sheikh",
  "egypt-family-programme",
];

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed — ${message}`);
}

async function inventory(tx: Tx) {
  const rows = await tx
    .select({
      category: serviceCategories.slug,
      categoryTitle: serviceCategories.titleEn,
      subcategory: serviceSubcategories.slug,
      service: services.slug,
    })
    .from(services)
    .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
    .leftJoin(serviceSubcategories, eq(serviceSubcategories.id, services.subcategoryId));

  const byCategory = new Map<string, number>();
  for (const row of rows) byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + 1);

  const [packageRows, navRows, sectionRows] = await Promise.all([
    tx
      .select({
        slug: travelPackages.slug,
        region: travelPackages.region,
        destinationId: travelPackages.destinationId,
      })
      .from(travelPackages),
    tx.select({ n: sql<number>`count(*)::int` }).from(navigationItems),
    tx.select({ blockType: pageSections.blockType }).from(pageSections),
  ]);

  return {
    services: rows.length,
    byCategory,
    packages: packageRows,
    // A multiset, sorted, so it can be compared before and after without caring
    // about row order — the machine check that `region` was left alone.
    regions: packageRows.map((p) => p.region).sort(),
    navigation: navRows[0]?.n ?? 0,
    egyptBlocks: sectionRows.filter((s) => s.blockType === "egypt-feature").length,
    destinationBlocks: sectionRows.filter((s) => s.blockType === "destination-feature").length,
  };
}

function printInventory(label: string, inv: Awaited<ReturnType<typeof inventory>>) {
  log(`  ${label}`);
  log(`    services            ${inv.services}`);
  for (const [slug, n] of [...inv.byCategory].sort()) log(`      ${slug.padEnd(24)}${n}`);
  log(`    navigation rows     ${inv.navigation}`);
  log(`    packages            ${inv.packages.length}`);
  log(`      with destination  ${inv.packages.filter((p) => p.destinationId != null).length}`);
  log(`    region values       ${inv.regions.join(", ")}`);
  log(`    egypt-feature       ${inv.egyptBlocks}`);
  log(`    destination-feature ${inv.destinationBlocks}`);
}

async function idOfCategory(tx: Tx, slug: string) {
  const [row] = await tx
    .select({ id: serviceCategories.id })
    .from(serviceCategories)
    .where(eq(serviceCategories.slug, slug))
    .limit(1);
  return row?.id ?? null;
}

async function idOfSubcategory(tx: Tx, slug: string) {
  const [row] = await tx
    .select({ id: serviceSubcategories.id })
    .from(serviceSubcategories)
    .where(eq(serviceSubcategories.slug, slug))
    .limit(1);
  return row?.id ?? null;
}

/* -------------------------------------------------------------------------- */
/* The cutover                                                                 */
/* -------------------------------------------------------------------------- */

async function cutover(tx: Tx) {
  // --- 0. exclusivity ------------------------------------------------------
  // Transaction-scoped: released by COMMIT or ROLLBACK, never leaked.
  await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`);

  // SHARE ROW EXCLUSIVE is the weakest mode that conflicts with ROW EXCLUSIVE
  // (every INSERT / UPDATE / DELETE) and with itself, while leaving ACCESS
  // SHARE — a plain SELECT — free. So: no admin write lands mid-cutover, no
  // second cutover runs beside this one, and the public site never blocks.
  await tx.execute(sql`
    lock table
      service_categories, service_subcategories, services,
      package_destinations, travel_packages,
      navigation_items, page_sections
    in share row exclusive mode
  `);
  step("locks acquired (advisory + 7 tables, share row exclusive)");

  // --- 1. preconditions ----------------------------------------------------
  const state = await taxonomyState(tx);
  if (state === "restructured") {
    log();
    log("  Already restructured — nothing to do.");
    throw ROLLBACK;
  }
  if (state === "fresh") {
    throw new Error(
      "this database holds no service catalogue at all. There is nothing to restructure — " +
        "check DATABASE_URL points at the database you meant, and seed it first if it is new.",
    );
  }

  const before = await inventory(tx);
  printInventory("before", before);
  log();

  assert(before.byCategory.size === 6, `expected 6 categories, found ${before.byCategory.size}`);
  assert(before.services === 86, `expected 86 services, found ${before.services}`);
  assert(before.packages.length === 5, `expected 5 packages, found ${before.packages.length}`);

  const travelId = await idOfCategory(tx, "travel-tourism");
  const businessId = await idOfCategory(tx, "business-setup");
  const companyId = await idOfCategory(tx, "company-formation");
  const generalId = await idOfCategory(tx, "general-services");
  const travelHolidayId = await idOfSubcategory(tx, "travel-holiday");
  const egyptToursId = await idOfSubcategory(tx, "egypt-tours");
  const companySubId = await idOfSubcategory(tx, "company-formation-registration");
  assert(travelId && businessId && companyId && generalId, "a legacy category is missing");
  assert(travelHolidayId && egyptToursId && companySubId, "a legacy subcategory is missing");

  // --- 2. the Egypt destination -------------------------------------------
  const [destination] = await tx
    .insert(packageDestinations)
    .values(EGYPT)
    .onConflictDoUpdate({
      target: packageDestinations.slug,
      set: { titleEn: EGYPT.titleEn, titleAr: EGYPT.titleAr, updatedAt: new Date() },
    })
    .returning({ id: packageDestinations.id });
  assert(destination, "the Egypt destination was not created");
  step(`destination “Egypt” (#${destination.id})`);

  // Matched on the four package slugs, never on region = 'egypt': a slug list
  // is auditable, and a region match would sweep in any future package that
  // happened to carry the legacy value.
  const assigned = await tx
    .update(travelPackages)
    .set({ destinationId: destination.id, updatedAt: new Date() })
    .where(inArray(travelPackages.slug, EGYPT_PACKAGE_SLUGS))
    .returning({ slug: travelPackages.slug });
  assert(assigned.length === 4, `expected to assign 4 packages, assigned ${assigned.length}`);
  step(`4 packages assigned to Egypt · custom-itinerary left unassigned by design`);

  // --- 3. promote the two Travel services out of the Egypt subcategory -----
  // The two provisional numbers put them last inside Travel & Holiday and in
  // the order the catalogue definition lists them. They do not survive: step 8b
  // renumbers every category contiguously and these become ordinary positions.
  const promotedHoneymoon = await tx
    .update(services)
    .set({
      subcategoryId: travelHolidayId,
      slug: "honeymoon-packages",
      sortOrder: PROMOTED_ORDER,
      updatedAt: new Date(),
    })
    .where(and(eq(services.slug, "honeymoon-package"), eq(services.categoryId, travelId)))
    .returning({ id: services.id });
  assert(promotedHoneymoon.length === 1, "honeymoon-package was not promoted");

  const promotedGuide = await tx
    .update(services)
    .set({ subcategoryId: travelHolidayId, sortOrder: PROMOTED_ORDER + 1, updatedAt: new Date() })
    .where(and(eq(services.slug, "professional-tour-guide"), eq(services.categoryId, travelId)))
    .returning({ id: services.id });
  assert(promotedGuide.length === 1, "professional-tour-guide was not promoted");
  step("2 services promoted into Travel & Holiday (tour guide keeps its address)");

  // The featured flag follows the survivor, not the duplicate being deleted.
  await tx
    .update(services)
    .set({ isFeatured: true, updatedAt: new Date() })
    .where(and(eq(services.slug, "customized-travel-itinerary"), eq(services.categoryId, travelId)));

  // --- 4. Company Formation merges into Business Setup ---------------------
  // Order matters: both foreign keys cascade, so the category may only be
  // deleted once nothing points at it.
  await tx
    .update(serviceSubcategories)
    .set({ categoryId: businessId, sortOrder: 1, updatedAt: new Date() })
    .where(eq(serviceSubcategories.id, companySubId));

  const moved = await tx
    .update(services)
    .set({ categoryId: businessId, updatedAt: new Date() })
    .where(eq(services.categoryId, companyId))
    .returning({ id: services.id });
  assert(moved.length === 5, `expected to move 5 services, moved ${moved.length}`);

  const [{ left }] = await tx
    .select({ left: sql<number>`count(*)::int` })
    .from(services)
    .where(eq(services.categoryId, companyId));
  assert(left === 0, `${left} services still reference company-formation`);

  await tx.delete(serviceCategories).where(eq(serviceCategories.id, companyId));
  step("Company Formation merged into Business Setup (5 services, 1 subcategory)");

  // --- 5. renames and titles ----------------------------------------------
  await tx
    .update(serviceCategories)
    .set({
      slug: "iqama-services",
      taglineEn: "Residency and employee paperwork",
      taglineAr: "أوراق الإقامة والموظفين",
      updatedAt: new Date(),
    })
    .where(eq(serviceCategories.id, generalId));

  await tx
    .update(serviceSubcategories)
    .set({ titleEn: "Iqama & Employee Services", updatedAt: new Date() })
    .where(eq(serviceSubcategories.slug, "khidamat-iqama"));

  for (const [slug, title] of Object.entries(CATEGORY_TITLES)) {
    await tx
      .update(serviceCategories)
      .set({ titleEn: title.en, titleAr: title.ar, updatedAt: new Date() })
      .where(eq(serviceCategories.slug, slug));
  }
  step("general-services → iqama-services · 4 categories retitled (EN + AR)");

  // --- 6. navigation -------------------------------------------------------
  // Replaced wholesale from the same constant the seed uses, so a restructured
  // database and a freshly seeded one end up with an identical menu. Refusing
  // to run when the menu has been customised is deliberate: silently discarding
  // somebody's link would be worse than stopping.
  const existingNav = await tx.select({ n: sql<number>`count(*)::int` }).from(navigationItems);
  assert(
    (existingNav[0]?.n ?? 0) === 24,
    `expected the 24 seeded navigation rows, found ${existingNav[0]?.n ?? 0} — the menu looks customised, so it is not being replaced`,
  );
  await tx.delete(navigationItems);

  let order = 0;
  for (const item of NAVIGATION) {
    const [row] = await tx
      .insert(navigationItems)
      .values({
        menu: item.menu,
        labelEn: item.label.en,
        labelAr: item.label.ar,
        href: item.href,
        sortOrder: order++,
      })
      .returning({ id: navigationItems.id });
    for (const child of item.children ?? []) {
      await tx.insert(navigationItems).values({
        menu: item.menu,
        parentId: row!.id,
        labelEn: child.label.en,
        labelAr: child.label.ar,
        href: child.href,
        sortOrder: order++,
      });
    }
  }
  step(`navigation rewritten (${order} rows)`);

  // --- 7. the homepage block type -----------------------------------------
  // Only the type. The values an editor wrote about Egypt are correct content
  // and are not touched.
  const retyped = await tx
    .update(pageSections)
    .set({ blockType: "destination-feature", updatedAt: new Date() })
    .where(eq(pageSections.blockType, "egypt-feature"))
    .returning({ id: pageSections.id });
  step(`${retyped.length} section(s) retyped to destination-feature`);

  // The homepage quick links are stored hrefs, and two of them name a category
  // that is about to stop existing. Left alone they would still work — the
  // route redirects — but the site would be linking to its own redirect from
  // its most prominent block, which is a thing to fix rather than to ship.
  // Matched with the surrounding quotes so only a whole href is replaced.
  for (const [from, to] of Object.entries(SECTION_HREF_MOVES)) {
    for (const column of ["published", "draft"] as const) {
      await tx.execute(sql`
        update page_sections
           set ${sql.raw(column)} = replace(${sql.raw(column)}::text, ${`"${from}"`}, ${`"${to}"`})::jsonb,
               updated_at = now()
         where ${sql.raw(column)}::text like ${`%"${from}"%`}
      `);
    }
  }
  step("stored links to the retired categories repointed");

  // --- 8. deletions, last --------------------------------------------------
  const deleted = await tx
    .delete(services)
    .where(and(eq(services.categoryId, travelId), inArray(services.slug, DELETE_SERVICE_SLUGS)))
    .returning({ slug: services.slug });
  assert(
    deleted.length === DELETE_SERVICE_SLUGS.length,
    `expected to delete ${DELETE_SERVICE_SLUGS.length} services, deleted ${deleted.length}`,
  );

  const [{ stranded }] = await tx
    .select({ stranded: sql<number>`count(*)::int` })
    .from(services)
    .where(eq(services.subcategoryId, egyptToursId));
  assert(stranded === 0, `${stranded} services still sit in egypt-tours`);

  await tx.delete(serviceSubcategories).where(eq(serviceSubcategories.id, egyptToursId));
  step(`${deleted.length} duplicate services and the egypt-tours subcategory deleted`);

  // --- 8b. close the holes -------------------------------------------------
  // Deleting a row leaves a gap in `sort_order`, and merging a category brings
  // in a second run of numbers that interleaves with the first. Neither changes
  // what a visitor sees, and both would make a restructured database differ
  // from a freshly seeded one for no reason anybody could point at later.
  //
  // Relative order is preserved exactly, so an editor's own arrangement
  // survives: the only thing that changes is which integers express it. The
  // subcategory comes first in the ordering because that is the shape the
  // catalogue is defined in — a merged category's services belong in their own
  // block, not interleaved with the ones they arrived beside.
  await tx.execute(sql`
    update services s
       set sort_order = o.position, updated_at = now()
      from (
        select s2.id,
               (row_number() over (
                  partition by s2.category_id
                  order by coalesce(sc.sort_order, 9999), s2.sort_order, s2.id
                ))::int - 1 as position
          from services s2
          left join service_subcategories sc on sc.id = s2.subcategory_id
      ) o
     where o.id = s.id and s.sort_order <> o.position
  `);

  await tx.execute(sql`
    update service_categories c
       set sort_order = o.position, updated_at = now()
      from (
        select id, (row_number() over (order by sort_order, id))::int - 1 as position
          from service_categories
      ) o
     where o.id = c.id and c.sort_order <> o.position
  `);
  step("sort order renumbered contiguously (relative order unchanged)");

  // --- 9. invariants -------------------------------------------------------
  const after = await inventory(tx);
  log();
  printInventory("after", after);
  log();

  assert(after.byCategory.size === 5, `expected 5 categories, found ${after.byCategory.size}`);
  assert(after.services === 74, `expected 74 services, found ${after.services}`);
  assert(after.byCategory.get("travel-tourism") === 26, "Travel should hold 26 services");
  assert(after.byCategory.get("business-setup") === 14, "Business Setup should hold 14 services");
  assert(after.byCategory.get("iqama-services") === 13, "Iqama should hold 13 services");
  assert(after.byCategory.get("license-renewal") === 6, "License Renewal should hold 6 services");
  assert(after.byCategory.get("government-relations") === 15, "Government should hold 15 services");

  assert((await idOfCategory(tx, "company-formation")) === null, "company-formation still exists");
  assert((await idOfCategory(tx, "general-services")) === null, "general-services still exists");
  assert((await idOfCategory(tx, "iqama-services")) !== null, "iqama-services is missing");
  assert((await idOfSubcategory(tx, "egypt-tours")) === null, "egypt-tours still exists");

  const [{ orphans }] = await tx
    .select({ orphans: sql<number>`count(*)::int` })
    .from(services)
    .leftJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
    .where(isNull(serviceCategories.id));
  assert(orphans === 0, `${orphans} services have no category`);

  const dupes = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(services)
    .groupBy(services.categoryId, services.slug)
    .having(sql`count(*) > 1`);
  assert(dupes.length === 0, `${dupes.length} duplicate slugs within a category`);

  assert(
    after.packages.filter((p) => p.destinationId != null).length === 4,
    "expected 4 packages in the Egypt destination",
  );
  assert(
    after.packages.find((p) => p.slug === "custom-itinerary")?.destinationId == null,
    "custom-itinerary should belong to no destination",
  );

  // D3: nothing rewrites region. Compared as a sorted multiset.
  assert(
    JSON.stringify(after.regions) === JSON.stringify(before.regions),
    `region values changed: ${before.regions.join(",")} → ${after.regions.join(",")}`,
  );

  const [{ stale }] = await tx
    .select({ stale: sql<number>`count(*)::int` })
    .from(pageSections)
    .where(
      sql`published::text like '%"/services/company-formation"%'
          or published::text like '%"/services/general-services"%'
          or coalesce(draft::text, '') like '%"/services/company-formation"%'
          or coalesce(draft::text, '') like '%"/services/general-services"%'`,
    );
  assert(stale === 0, `${stale} section(s) still link to a retired category`);

  assert(after.egyptBlocks === 0, "an egypt-feature section survived");
  assert(after.destinationBlocks === before.egyptBlocks, "the destination section was lost");

  const [homePage] = await tx.select({ id: pages.id }).from(pages).where(eq(pages.slug, "home")).limit(1);
  if (homePage) {
    const [{ sections }] = await tx
      .select({ sections: sql<number>`count(*)::int` })
      .from(pageSections)
      .where(eq(pageSections.pageId, homePage.id));
    assert(sections === 13, `the homepage should still have 13 sections, found ${sections}`);
  }

  const navHrefs = await tx.select({ href: navigationItems.href }).from(navigationItems);
  const categorySlugs = new Set((await tx.select({ slug: serviceCategories.slug }).from(serviceCategories)).map((c) => c.slug));
  for (const { href } of navHrefs) {
    const match = /^\/services\/([a-z0-9-]+)/.exec(href);
    if (match) assert(categorySlugs.has(match[1]!), `navigation points at a missing category: ${href}`);
  }

  step("all invariants hold");
}

/* -------------------------------------------------------------------------- */

async function main() {
  log(DRY_RUN ? "Restructure — DRY RUN (nothing will be committed)" : "Restructure — LIVE");
  log();

  try {
    await db.transaction(async (tx) => {
      await cutover(tx);
      if (DRY_RUN) throw ROLLBACK;
    });
  } catch (error) {
    if (error === ROLLBACK) {
      log();
      log(DRY_RUN ? "Rolled back. Nothing was written." : "Nothing to do. Rolled back.");
      process.exit(0);
    }
    log();
    console.error(error instanceof Error ? error.message : error);
    log();
    log("Rolled back. The database is exactly as it was.");
    process.exit(1);
  }

  log();
  log("Committed.");
  log();
  log("Next: refresh the running application's caches, or it will keep serving the");
  log("old catalogue for up to an hour. Sign in and open");
  log("    /admin/settings?tab=maintenance");
  log("then press “Refresh caches” — see DEPLOYMENT.md, section 9.1.");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
