import "./env";

import { and, eq, isNull, sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import {
  faqs,
  navigationItems,
  pageSections,
  pages,
  permissions as permissionsTable,
  rolePermissions,
  roles,
  serviceCategories,
  serviceSubcategories,
  services,
  siteSettings,
  packageDestinations,
  travelPackages,
  users,
} from "../src/lib/db/schema";
import { backfillItemIds } from "../src/lib/cms/backfill";
import { hashPassword, passwordProblem } from "../src/lib/auth/password";
import { PERMISSIONS, ROLE_DEFAULTS, ROLE_LABELS } from "../src/lib/auth/permissions";
import { SETTINGS_DEFAULTS } from "../src/lib/settings-defaults";
import { CATALOG, slugify } from "./seed/catalog";
import { FAQS, HOME_SECTIONS, NAVIGATION, PAGE_SECTIONS } from "./seed/content";
import { SEED_IMAGES, importSeedImages } from "./seed/media";
import { LEGACY_NOTICE, taxonomyState, type TaxonomyState } from "./seed/state";

/**
 * First-run content.
 *
 * Idempotent throughout: running it twice adds nothing and overwrites nothing
 * an editor has changed. That matters because it is also the upgrade path —
 * a release that introduces a new permission or a new standing page adds it by
 * re-running the seed, without touching the site's own content.
 */

/**
 * Roles, permissions and the default grants between them — in one transaction.
 *
 * This is the upgrade path as much as the first run, and the two need opposite
 * things from it. A brand new installation wants every role filled in from
 * `ROLE_DEFAULTS`. An installation that has been running wants its grants left
 * exactly as its owner arranged them, including the ones they took away.
 *
 * Two facts are read **before** anything is written, because afterwards neither
 * can be recovered:
 *
 *   `permissionsBefore`  which keys this database already knew about. A key
 *                        that was not in the catalogue a moment ago cannot be a
 *                        grant anybody decided against, so it may be given to
 *                        the roles `ROLE_DEFAULTS` says want it. Once it is in
 *                        the catalogue, never again.
 *   `rolesBefore`        which roles already existed. This is the *only* sound
 *                        test for "did this run create the role", and getting
 *                        it wrong is how the previous version expanded access:
 *                        it asked whether the role currently holds no grants,
 *                        which is also true of a role an owner has deliberately
 *                        emptied. The next deploy handed the whole default set
 *                        back.
 *
 * One transaction, because the two halves only make sense together. The catalogue
 * insert used to commit on its own: if the process then died before the grants,
 * a second run would find the new key already present, conclude it was not
 * introduced, and leave it in the catalogue guarding something with nobody
 * holding it. Now either both land or neither does.
 *
 * The owner role is deliberately not special-cased here. Its protection is where
 * it has always been — the Roles screen refuses to narrow it — and inventing a
 * second owner-permission model in the seed would be a way for the two to
 * disagree.
 */
async function seedRolesAndPermissions() {
  await db.transaction(async (tx) => {
    const permissionsBefore = new Set(
      (await tx.select({ key: permissionsTable.key }).from(permissionsTable)).map((row) => row.key),
    );
    const rolesBefore = new Set(
      (await tx.select({ key: roles.key }).from(roles)).map((row) => row.key as string),
    );

    for (const permission of PERMISSIONS) {
      await tx
        .insert(permissionsTable)
        .values({ key: permission.key, label: permission.label, groupName: permission.group })
        .onConflictDoUpdate({
          target: permissionsTable.key,
          set: { label: permission.label, groupName: permission.group },
        });
    }

    const introduced = new Set(
      PERMISSIONS.map((p) => p.key).filter((key) => !permissionsBefore.has(key)),
    );
    const catalogue = await tx.select().from(permissionsTable);

    for (const [key, grants] of Object.entries(ROLE_DEFAULTS)) {
      const labels = ROLE_LABELS[key]!;
      await tx
        .insert(roles)
        .values({
          key: key as "owner" | "admin" | "editor" | "viewer",
          name: labels.name,
          description: labels.description,
          isSystem: true,
        })
        .onConflictDoNothing({ target: roles.key });

      const [role] = await tx.select().from(roles).where(eq(roles.key, key as "owner")).limit(1);
      if (!role) continue;

      /**
       * A role this run created is being initialised and gets its whole default
       * set. A role that was already here keeps every decision made about it and
       * receives only the keys this run introduced — and only those its defaults
       * name, so a permission added for admins does not arrive on the viewer.
       */
      const wanted = rolesBefore.has(key)
        ? grants.filter((grant) => introduced.has(grant))
        : grants;
      if (!wanted.length) continue;

      const values = catalogue
        .filter((permission) => (wanted as readonly string[]).includes(permission.key))
        .map((permission) => ({ roleId: role.id, permissionId: permission.id }));
      if (values.length) await tx.insert(rolePermissions).values(values).onConflictDoNothing();
    }
  });
  console.log("· roles and permissions");
}

async function seedOwner() {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
  if (n > 0) {
    console.log("· owner account already exists — skipped");
    return;
  }

  const email = process.env.SEED_OWNER_EMAIL?.trim();
  const password = process.env.SEED_OWNER_PASSWORD ?? "";
  const name = process.env.SEED_OWNER_NAME?.trim() || "Owner";

  if (!email || !password) {
    console.log(
      "· no owner created: set SEED_OWNER_EMAIL and SEED_OWNER_PASSWORD in .env, then run `npm run db:seed` again",
    );
    return;
  }
  const problem = passwordProblem(password);
  if (problem) throw new Error(`SEED_OWNER_PASSWORD is too weak. ${problem}`);

  const [ownerRole] = await db.select().from(roles).where(eq(roles.key, "owner")).limit(1);
  if (!ownerRole) throw new Error("Owner role missing — seed roles first.");

  await db.insert(users).values({
    email,
    name,
    passwordHash: await hashPassword(password),
    roleId: ownerRole.id,
    isActive: true,
  });
  console.log(`· owner account created for ${email}`);
}

async function seedSettings() {
  for (const [key, value] of Object.entries(SETTINGS_DEFAULTS)) {
    await db
      .insert(siteSettings)
      .values({ key, value: value as Record<string, unknown> })
      .onConflictDoNothing({ target: siteSettings.key });
  }
  console.log("· site settings");
}

async function seedNavigation() {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(navigationItems);
  if (n > 0) {
    console.log("· navigation already present — skipped");
    return;
  }
  let order = 0;
  for (const item of NAVIGATION) {
    const [row] = await db
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
      await db.insert(navigationItems).values({
        menu: item.menu,
        parentId: row!.id,
        labelEn: child.label.en,
        labelAr: child.label.ar,
        href: child.href,
        sortOrder: order++,
      });
    }
  }
  console.log(`· navigation (${NAVIGATION.length} entries)`);
}

async function seedCatalog() {
  let categoryOrder = 0;
  let total = 0;

  for (const category of CATALOG) {
    const [existing] = await db
      .select({ id: serviceCategories.id })
      .from(serviceCategories)
      .where(eq(serviceCategories.slug, category.slug))
      .limit(1);

    const categoryId =
      existing?.id ??
      (
        await db
          .insert(serviceCategories)
          .values({
            slug: category.slug,
            titleEn: category.title,
            titleAr: category.titleAr,
            taglineEn: category.tagline,
            taglineAr: category.taglineAr,
            summaryEn: category.summary,
            summaryAr: category.summaryAr,
            icon: category.icon,
            ctaLabelEn: category.ctaLabel,
            ctaLabelAr: category.ctaLabelAr,
            sortOrder: categoryOrder,
          })
          .returning({ id: serviceCategories.id })
      )[0]!.id;
    categoryOrder += 1;

    let subOrder = 0;
    let serviceOrder = 0;

    for (const sub of category.subcategories) {
      const [existingSub] = await db
        .select({ id: serviceSubcategories.id })
        .from(serviceSubcategories)
        .where(eq(serviceSubcategories.slug, sub.slug))
        .limit(1);

      const subId =
        existingSub?.id ??
        (
          await db
            .insert(serviceSubcategories)
            .values({
              categoryId,
              slug: sub.slug,
              titleEn: sub.title,
              titleAr: sub.titleAr,
              summaryEn: sub.summary,
              sortOrder: subOrder,
            })
            .returning({ id: serviceSubcategories.id })
        )[0]!.id;
      subOrder += 1;

      for (const service of sub.services) {
        const slug = slugify(service.title);
        const [found] = await db
          .select({ id: services.id })
          .from(services)
          .where(eq(services.slug, slug))
          .limit(1);
        if (found) {
          serviceOrder += 1;
          continue;
        }
        await db.insert(services).values({
          categoryId,
          subcategoryId: subId,
          slug,
          titleEn: service.title,
          titleAr: service.titleAr,
          introEn: service.intro,
          formPreset: sub.preset,
          isFeatured: Boolean(service.featured),
          sortOrder: serviceOrder++,
        });
        total += 1;
      }
    }
  }
  console.log(`· catalogue (${CATALOG.length} categories, ${total} new services)`);
}

async function seedPage(
  slug: string,
  titleEn: string,
  titleAr: string,
  sections: Array<{ blockType: string; animation?: string; values: Record<string, unknown> }>,
) {
  const [existing] = await db.select({ id: pages.id }).from(pages).where(eq(pages.slug, slug)).limit(1);
  if (existing) return;

  const [page] = await db
    .insert(pages)
    .values({ slug, kind: "builtin", titleEn, titleAr, isPublished: true })
    .returning({ id: pages.id });

  await db.insert(pageSections).values(
    sections.map((section, index) => ({
      pageId: page!.id,
      blockType: section.blockType,
      position: index,
      isPublished: true,
      // Stamped here for the same reason the migration stamps the rows already
      // in the database: a new installation has to land in the state a migrated
      // one lands in, or its sections would be the only ones on any site whose
      // repeatable rows have no stable identity until somebody saves them.
      published: backfillItemIds(section.blockType, section.values) ?? section.values,
      animation: section.animation ?? "fade-up",
    })),
  );
}

async function seedPages() {
  await seedPage("home", "Home", "الرئيسية", HOME_SECTIONS);
  await seedPage("about", "About Us", "من نحن", PAGE_SECTIONS.about!);
  await seedPage("contact", "Contact", "تواصل معنا", PAGE_SECTIONS.contact!);
  await seedPage("privacy", "Privacy Policy", "سياسة الخصوصية", PAGE_SECTIONS.privacy!);
  await seedPage("terms", "Terms of Use", "شروط الاستخدام", PAGE_SECTIONS.terms!);
  await seedPage("disclaimer", "Disclaimer", "إخلاء المسؤولية", PAGE_SECTIONS.disclaimer!);
  console.log("· pages and sections");
}

async function seedFaqs() {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(faqs);
  if (n > 0) {
    console.log("· FAQs already present — skipped");
    return;
  }
  await db.insert(faqs).values(
    FAQS.map((faq, index) => ({
      scope: "global" as const,
      questionEn: faq.q.en,
      questionAr: faq.q.ar,
      answerEn: faq.a.en,
      answerAr: faq.a.ar,
      sortOrder: index,
    })),
  );
  console.log(`· ${FAQS.length} FAQs`);
}

const PACKAGES = [
  {
    slug: "cairo-and-giza-classic",
    region: "egypt" as const,
    titleEn: "Cairo & Giza Classic",
    titleAr: "القاهرة والجيزة الكلاسيكية",
    destinationEn: "Cairo, Egypt",
    destinationAr: "القاهرة، مصر",
    durationEn: "4 nights",
    durationAr: "4 ليالٍ",
    summaryEn:
      "The pyramids, the Sphinx and the museum collections, with a licensed guide and every transfer arranged.",
    highlights: [
      "Giza plateau and the Sphinx with a licensed guide",
      "Egyptian Museum, tickets arranged in advance",
      "Islamic and Coptic Cairo on foot",
      "Khan el-Khalili, late afternoon",
      "All airport and intercity transfers",
    ],
    featured: true,
  },
  {
    slug: "nile-cruise-luxor-aswan",
    region: "egypt" as const,
    titleEn: "Nile Cruise — Luxor to Aswan",
    titleAr: "رحلة نيلية — من الأقصر إلى أسوان",
    destinationEn: "Luxor & Aswan, Egypt",
    destinationAr: "الأقصر وأسوان، مصر",
    durationEn: "5 nights",
    durationAr: "5 ليالٍ",
    summaryEn: "A sailing between Luxor and Aswan with guided excursions at each stop and the flights to join it.",
    highlights: [
      "Karnak and Luxor temples",
      "Valley of the Kings",
      "Edfu and Kom Ombo",
      "Philae temple at Aswan",
      "Domestic flights and transfers included",
    ],
    featured: true,
  },
  {
    slug: "red-sea-sharm-el-sheikh",
    region: "egypt" as const,
    titleEn: "Red Sea — Sharm El Sheikh",
    titleAr: "البحر الأحمر — شرم الشيخ",
    destinationEn: "Sharm El Sheikh, Egypt",
    destinationAr: "شرم الشيخ، مصر",
    durationEn: "5 nights",
    durationAr: "5 ليالٍ",
    summaryEn: "Beach nights on the Red Sea with diving, snorkelling and a desert day arranged around them.",
    highlights: ["Resort stay with transfers", "Ras Mohammed snorkelling day", "Desert excursion", "Optional diving package"],
  },
  {
    slug: "egypt-family-programme",
    region: "egypt" as const,
    titleEn: "Egypt Family Programme",
    titleAr: "برنامج مصر العائلي",
    destinationEn: "Cairo & Hurghada, Egypt",
    destinationAr: "القاهرة والغردقة، مصر",
    durationEn: "7 nights",
    durationAr: "7 ليالٍ",
    summaryEn: "Cairo's landmarks at a family pace, then Red Sea beach nights — connecting rooms and shorter touring days.",
    highlights: ["Shorter guided days", "Connecting or family rooms", "Cairo then Hurghada", "All transfers and domestic flights"],
  },
  {
    slug: "custom-itinerary",
    region: "international" as const,
    titleEn: "Custom Itinerary",
    titleAr: "برنامج مخصص",
    destinationEn: "Anywhere",
    destinationAr: "أي وجهة",
    durationEn: "Your dates",
    durationAr: "حسب تواريخك",
    summaryEn:
      "Tell us the dates, the party and roughly what you want the trip to be. We come back with an itinerary and a written quote.",
    highlights: ["Built around your dates", "Flights, hotels and transfers together", "Visa support where it is needed", "One coordinator throughout"],
  },
];

/**
 * Destinations ship with the catalogue for a fresh database. On an existing one
 * the restructure transaction creates Egypt instead — a destination inserted
 * here before its packages were assigned would flip the public catalogue into
 * destination mode with nothing in it.
 */
const DESTINATIONS = [
  {
    slug: "egypt",
    titleEn: "Egypt",
    titleAr: "مصر",
    summaryEn:
      "Explore Egypt through curated travel packages covering Cairo, Giza, the Nile, Luxor, Aswan, Sharm El Sheikh and Hurghada. Choose a ready itinerary or contact us to tailor your trip.",
    summaryAr:
      "اكتشف مصر من خلال باقات سفر مختارة تشمل القاهرة والجيزة والنيل والأقصر وأسوان وشرم الشيخ والغردقة. اختر برنامجاً جاهزاً أو تواصل معنا لتخصيص رحلتك.",
    sortOrder: 0,
  },
];

/** Which destination each shipped package belongs to, by slug. */
const PACKAGE_DESTINATION: Record<string, string> = {
  "cairo-and-giza-classic": "egypt",
  "nile-cruise-luxor-aswan": "egypt",
  "red-sea-sharm-el-sheikh": "egypt",
  "egypt-family-programme": "egypt",
  // `custom-itinerary` is deliberately absent: "Anywhere" is not a destination.
};

async function seedDestinations() {
  for (const row of DESTINATIONS) {
    await db.insert(packageDestinations).values(row).onConflictDoNothing({
      target: packageDestinations.slug,
    });
  }
  console.log(`· ${DESTINATIONS.length} package destination(s)`);
}

async function seedPackages() {
  for (const row of PACKAGES) {
    await db
      .insert(travelPackages)
      .values({
        slug: row.slug,
        region: row.region,
        titleEn: row.titleEn,
        titleAr: row.titleAr,
        destinationEn: row.destinationEn,
        destinationAr: row.destinationAr,
        durationEn: row.durationEn,
        durationAr: row.durationAr,
        summaryEn: row.summaryEn,
        highlights: row.highlights.map((h) => ({ en: h, ar: "" })),
        isFeatured: Boolean(row.featured),
        sortOrder: PACKAGES.indexOf(row),
      })
      .onConflictDoNothing({ target: travelPackages.slug });
  }

  // Attach the shipped packages to their destination — only where the package
  // has none, so a later editorial decision is never overwritten.
  for (const [packageSlug, destinationSlug] of Object.entries(PACKAGE_DESTINATION)) {
    const [destination] = await db
      .select({ id: packageDestinations.id })
      .from(packageDestinations)
      .where(eq(packageDestinations.slug, destinationSlug))
      .limit(1);
    if (!destination) continue;
    await db
      .update(travelPackages)
      .set({ destinationId: destination.id })
      .where(and(eq(travelPackages.slug, packageSlug), isNull(travelPackages.destinationId)));
  }
  console.log(`· ${PACKAGES.length} travel packages`);
}

/**
 * Imports the shipped artwork and attaches it wherever a picture slot is still
 * empty. Only nulls are filled, so an owner who has replaced an image — or
 * deliberately cleared one — keeps their choice across re-runs.
 */
async function seedImagery() {
  const uploadDir = process.env.UPLOAD_DIR;
  if (!uploadDir) {
    console.log("· imagery skipped: UPLOAD_DIR is not set");
    return;
  }

  const ids = await importSeedImages(SEED_IMAGES, uploadDir);
  const byCategory: Record<string, string> = {
    "travel-tourism": "travel-tourism",
    "business-setup": "business-setup",
    "iqama-services": "general-services",
    "license-renewal": "license-renewal",
    "government-relations": "government-relations",
  };

  for (const [slug, image] of Object.entries(byCategory)) {
    const id = ids.get(image);
    if (!id) continue;
    await db
      .update(serviceCategories)
      .set({ imageId: id })
      .where(and(eq(serviceCategories.slug, slug), isNull(serviceCategories.imageId)));
  }

  // Section artwork, addressed by block type rather than by row id so it keeps
  // working after an editor reorders the page.
  const byBlock: Record<string, string> = {
    "featured-service": "investor-licence",
    "travel-feature": "travel-tourism",
    "destination-feature": "egypt",
    "image-text": "one-desk",
  };
  const sections = await db.select().from(pageSections);
  for (const section of sections) {
    const image = byBlock[section.blockType];
    const id = image ? ids.get(image) : undefined;
    if (!id) continue;
    const values = (section.published ?? {}) as Record<string, unknown>;
    if (values.image !== null && values.image !== undefined) continue;
    await db
      .update(pageSections)
      .set({ published: { ...values, image: id } })
      .where(eq(pageSections.id, section.id));
  }

  const packageArt: Record<string, string> = {
    "cairo-and-giza-classic": "egypt",
    "nile-cruise-luxor-aswan": "egypt",
    "red-sea-sharm-el-sheikh": "egypt",
    "egypt-family-programme": "egypt",
    "custom-itinerary": "travel-tourism",
  };
  for (const [slug, image] of Object.entries(packageArt)) {
    const id = ids.get(image);
    if (!id) continue;
    await db
      .update(travelPackages)
      .set({ imageId: id })
      .where(and(eq(travelPackages.slug, slug), isNull(travelPackages.imageId)));
  }

  console.log(`· imagery (${ids.size} images in the library)`);
}

async function main() {
  console.log("Seeding Elite One Desk…");

  // Asked once, before anything that depends on which taxonomy is in place.
  const state: TaxonomyState = await taxonomyState();
  console.log(`· taxonomy state: ${state}`);

  await seedRolesAndPermissions();
  await seedOwner();
  await seedSettings();

  if (state === "legacy") {
    // Everything above is taxonomy-independent and safe in any state.
    // Everything below would either create a duplicate of a live row or
    // silently perform half of a restructure, so it does not run at all. The
    // seed never restructures; that is a deliberate act with its own command.
    console.log(LEGACY_NOTICE);
  } else {
    await seedNavigation();
    await seedCatalog();
    await seedPages();
    await seedFaqs();
    await seedDestinations();
    await seedPackages();
  }

  await seedImagery();
  console.log("Done.");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
