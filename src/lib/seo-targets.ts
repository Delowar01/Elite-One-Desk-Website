import "server-only";

import { and, asc, eq, isNull, ne, or, sql } from "drizzle-orm";

import { toPlainText } from "@/lib/cms/sanitize";
import { db } from "@/lib/db";
import type { Executor } from "@/lib/db/revision";
import {
  media,
  packageDestinations,
  pages,
  seoMetadata,
  serviceCategories,
  serviceSubcategories,
  services,
  siteSettings,
  travelPackages,
} from "@/lib/db/schema";
import { PACKAGES_OVERVIEW_META, SERVICES_OVERVIEW_META } from "@/lib/seo-defaults";
import {
  indexSeoRows,
  overviewStorage,
  preferredSeoRow,
  recordStorage,
  seoRefOf,
  seoRowFor,
  storedKeyOf,
  type SeoEntityType,
  type SeoKind,
  type SeoRef,
  type SeoStorage,
} from "@/lib/seo-model";
import { isLegacyTaxonomy } from "@/lib/taxonomy-state";

/**
 * The SEO targets, read from the database (Batch 25 — the vocabulary and the
 * rule are in `lib/seo-model.ts`; docs/admin/seo-and-share-images.md Part B).
 *
 * Every target is read from its own table — never built from an address or a
 * key the browser sent — so a reference that names a record which does not
 * exist, or exists as something else, is simply not found.
 */

export type SeoGroup = "site" | "page" | "overview" | "category" | "service" | "destination" | "package";

/**
 * The page's own words in each language, as stored — what it uses where its
 * record says nothing (`textFor` in `lib/seo-model.ts`), and what the screen
 * names as the fallback.
 */
export type SeoOwnValues = {
  titleEn: string;
  titleAr: string;
  descriptionEn: string;
  descriptionAr: string;
  imageId: number | null;
};

export type SeoTarget = {
  /** `destination:3` */
  ref: string;
  kind: SeoKind;
  id: number;
  group: SeoGroup;
  label: string;
  /** Where it sits: a service's category, a package's destination. */
  context: string | null;
  /** The public address, without a language prefix. */
  path: string;
  /** Whether a visitor reaches the page at that address now. */
  published: boolean;
  /** Where its record lives; `null` for the site defaults, which live in Site Settings. */
  storage: SeoStorage | null;
  own: SeoOwnValues;
  /** The screen that edits the page or record itself. */
  adminHref: string | null;
};

const NONE: SeoOwnValues = { titleEn: "", titleAr: "", descriptionEn: "", descriptionAr: "", imageId: null };


/* -------------------------------------------------------------------------- */
/* Building targets from rows                                                  */
/* -------------------------------------------------------------------------- */

type PageRow = { id: number; slug: string; titleEn: string; titleAr: string; isPublished: boolean };
type CategoryRow = {
  id: number;
  slug: string;
  titleEn: string;
  titleAr: string;
  summaryEn: string;
  summaryAr: string;
  taglineEn: string;
  taglineAr: string;
  imageId: number | null;
  isPublished: boolean;
};
type ServiceRow = {
  id: number;
  slug: string;
  titleEn: string;
  titleAr: string;
  introEn: string;
  introAr: string;
  imageId: number | null;
  isPublished: boolean;
  categoryId: number;
  categorySlug: string;
  categoryTitle: string;
  categoryPublished: boolean;
};
type PackageRow = {
  id: number;
  slug: string;
  titleEn: string;
  titleAr: string;
  summaryEn: string;
  summaryAr: string;
  imageId: number | null;
  isPublished: boolean;
  destinationTitle: string | null;
};
type DestinationRow = Omit<PackageRow, "destinationTitle">;

function pageTarget(row: PageRow): SeoTarget {
  const home = row.slug === "home";
  // The homepage names no title of its own (the site default is its title); a
  // CMS page passes its title, the Arabic one where it has one.
  const own = home ? NONE : { ...NONE, titleEn: row.titleEn, titleAr: row.titleAr };
  return {
    ref: seoRefOf({ kind: "page", id: row.id }),
    kind: "page",
    id: row.id,
    group: "page",
    label: home ? "Homepage" : row.titleEn,
    context: null,
    path: home ? "/" : `/${row.slug}`,
    published: row.isPublished,
    storage: recordStorage("page", row.slug, row.id),
    own,
    adminHref: `/admin/pages/${row.slug}`,
  };
}

function servicesOverviewTarget(legacy: boolean): SeoTarget {
  const description = SERVICES_OVERVIEW_META.description[legacy ? "legacy" : "restructured"];
  return {
    ref: "serviceIndex:1",
    kind: "serviceIndex",
    id: 1,
    group: "overview",
    label: "Services overview",
    context: null,
    path: "/services",
    published: true,
    storage: overviewStorage("serviceIndex"),
    own: {
      titleEn: SERVICES_OVERVIEW_META.title.en,
      titleAr: SERVICES_OVERVIEW_META.title.ar,
      descriptionEn: description.en,
      descriptionAr: description.ar,
      imageId: null,
    },
    adminHref: "/admin/visual-editor?route=serviceIndex:1",
  };
}

function packagesOverviewTarget(): SeoTarget {
  return {
    ref: "packageIndex:1",
    kind: "packageIndex",
    id: 1,
    group: "overview",
    label: "Tour packages overview",
    context: null,
    path: "/packages",
    published: true,
    storage: overviewStorage("packageIndex"),
    own: {
      titleEn: PACKAGES_OVERVIEW_META.title.en,
      titleAr: PACKAGES_OVERVIEW_META.title.ar,
      descriptionEn: PACKAGES_OVERVIEW_META.description.en,
      descriptionAr: PACKAGES_OVERVIEW_META.description.ar,
      imageId: null,
    },
    adminHref: "/admin/visual-editor?route=packageIndex:1",
  };
}

function categoryTarget(row: CategoryRow): SeoTarget {
  return {
    ref: seoRefOf({ kind: "category", id: row.id }),
    kind: "category",
    id: row.id,
    group: "category",
    label: row.titleEn,
    context: null,
    path: `/services/${row.slug}`,
    published: row.isPublished,
    storage: recordStorage("category", row.slug, row.id),
    own: {
      titleEn: row.titleEn,
      titleAr: row.titleAr,
      descriptionEn: row.summaryEn.trim() || row.taglineEn,
      descriptionAr: row.summaryAr.trim() || row.taglineAr,
      imageId: row.imageId,
    },
    adminHref: `/admin/categories/${row.id}`,
  };
}

function serviceTarget(row: ServiceRow): SeoTarget {
  const address = `${row.categorySlug}/${row.slug}`;
  return {
    ref: seoRefOf({ kind: "service", id: row.id }),
    kind: "service",
    id: row.id,
    group: "service",
    label: row.titleEn,
    context: row.categoryTitle,
    path: `/services/${address}`,
    // A visitor reaches it only while the service and its category are both published.
    published: row.isPublished && row.categoryPublished,
    storage: recordStorage("service", address, row.id),
    own: {
      titleEn: row.titleEn,
      titleAr: row.titleAr,
      descriptionEn: toPlainText(row.introEn, 300),
      descriptionAr: toPlainText(row.introAr, 300),
      imageId: row.imageId,
    },
    adminHref: `/admin/services/${row.id}`,
  };
}

function destinationTarget(row: DestinationRow): SeoTarget {
  return {
    ref: seoRefOf({ kind: "destination", id: row.id }),
    kind: "destination",
    id: row.id,
    group: "destination",
    label: row.titleEn,
    context: null,
    path: `/packages/${row.slug}`,
    published: row.isPublished,
    storage: recordStorage("destination", row.slug, row.id),
    own: {
      titleEn: row.titleEn,
      titleAr: row.titleAr,
      descriptionEn: toPlainText(row.summaryEn, 300),
      descriptionAr: toPlainText(row.summaryAr, 300),
      imageId: row.imageId,
    },
    adminHref: `/admin/packages/destinations/${row.id}`,
  };
}

function packageTarget(row: PackageRow): SeoTarget {
  return {
    ref: seoRefOf({ kind: "package", id: row.id }),
    kind: "package",
    id: row.id,
    group: "package",
    label: row.titleEn,
    context: row.destinationTitle,
    path: `/packages/${row.slug}`,
    published: row.isPublished,
    storage: recordStorage("package", row.slug, row.id),
    own: {
      titleEn: row.titleEn,
      titleAr: row.titleAr,
      descriptionEn: toPlainText(row.summaryEn, 300),
      descriptionAr: toPlainText(row.summaryAr, 300),
      imageId: row.imageId,
    },
    adminHref: `/admin/packages/${row.id}`,
  };
}

export const SITE_TARGET: SeoTarget = {
  ref: "site:1",
  kind: "site",
  id: 1,
  group: "site",
  label: "Site defaults",
  context: null,
  path: "/",
  published: true,
  storage: null,
  own: NONE,
  adminHref: null,
};

/* -------------------------------------------------------------------------- */
/* Queries                                                                     */
/* -------------------------------------------------------------------------- */

const pageColumns = {
  id: pages.id,
  slug: pages.slug,
  titleEn: pages.titleEn,
  titleAr: pages.titleAr,
  isPublished: pages.isPublished,
};
const categoryColumns = {
  id: serviceCategories.id,
  slug: serviceCategories.slug,
  titleEn: serviceCategories.titleEn,
  titleAr: serviceCategories.titleAr,
  summaryEn: serviceCategories.summaryEn,
  summaryAr: serviceCategories.summaryAr,
  taglineEn: serviceCategories.taglineEn,
  taglineAr: serviceCategories.taglineAr,
  imageId: serviceCategories.imageId,
  isPublished: serviceCategories.isPublished,
};
const serviceColumns = {
  id: services.id,
  slug: services.slug,
  titleEn: services.titleEn,
  titleAr: services.titleAr,
  introEn: services.introEn,
  introAr: services.introAr,
  imageId: services.imageId,
  isPublished: services.isPublished,
  categoryId: services.categoryId,
  categorySlug: serviceCategories.slug,
  categoryTitle: serviceCategories.titleEn,
  categoryPublished: serviceCategories.isPublished,
};
/** A service's own columns — locked by themselves (`loadSeoTarget`). */
const serviceOwnColumns = {
  id: services.id,
  slug: services.slug,
  titleEn: services.titleEn,
  titleAr: services.titleAr,
  introEn: services.introEn,
  introAr: services.introAr,
  imageId: services.imageId,
  isPublished: services.isPublished,
  categoryId: services.categoryId,
};
const destinationColumns = {
  id: packageDestinations.id,
  slug: packageDestinations.slug,
  titleEn: packageDestinations.titleEn,
  titleAr: packageDestinations.titleAr,
  summaryEn: packageDestinations.summaryEn,
  summaryAr: packageDestinations.summaryAr,
  imageId: packageDestinations.imageId,
  isPublished: packageDestinations.isPublished,
};
const packageColumns = {
  id: travelPackages.id,
  slug: travelPackages.slug,
  titleEn: travelPackages.titleEn,
  titleAr: travelPackages.titleAr,
  summaryEn: travelPackages.summaryEn,
  summaryAr: travelPackages.summaryAr,
  imageId: travelPackages.imageId,
  isPublished: travelPackages.isPublished,
  destinationTitle: packageDestinations.titleEn,
};
/** A package's own columns — locked by themselves (`loadSeoTarget`). */
const packageOwnColumns = {
  id: travelPackages.id,
  slug: travelPackages.slug,
  titleEn: travelPackages.titleEn,
  titleAr: travelPackages.titleAr,
  summaryEn: travelPackages.summaryEn,
  summaryAr: travelPackages.summaryAr,
  imageId: travelPackages.imageId,
  isPublished: travelPackages.isPublished,
  destinationId: travelPackages.destinationId,
};

/** Which sentence `/services` uses for itself: the same test the route makes. */
async function servicesLegacy(on: Executor): Promise<boolean> {
  const [categorySlugs, subcategorySlugs] = await Promise.all([
    on.select({ slug: serviceCategories.slug }).from(serviceCategories),
    on.select({ slug: serviceSubcategories.slug }).from(serviceSubcategories),
  ]);
  return isLegacyTaxonomy(
    categorySlugs.map((row) => row.slug),
    subcategorySlugs.map((row) => row.slug),
  );
}

/**
 * Every target, in the order the SEO screen lists them: the site defaults, the
 * homepage and the other pages, the two overviews, then the catalogue — read
 * from the tables on every call, so a record created a moment ago is a target.
 */
export async function listSeoTargets(on: Executor = db): Promise<SeoTarget[]> {
  const [pageRows, categoryRows, serviceRows, destinationRows, packageRows, legacy] = await Promise.all([
    on.select(pageColumns).from(pages).orderBy(asc(pages.sortOrder), asc(pages.id)),
    on.select(categoryColumns).from(serviceCategories).orderBy(asc(serviceCategories.sortOrder), asc(serviceCategories.id)),
    on
      .select(serviceColumns)
      .from(services)
      .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
      .orderBy(asc(serviceCategories.sortOrder), asc(serviceCategories.id), asc(services.sortOrder), asc(services.id)),
    on
      .select(destinationColumns)
      .from(packageDestinations)
      .orderBy(asc(packageDestinations.sortOrder), asc(packageDestinations.id)),
    on
      .select(packageColumns)
      .from(travelPackages)
      .leftJoin(packageDestinations, eq(packageDestinations.id, travelPackages.destinationId))
      .orderBy(asc(travelPackages.sortOrder), asc(travelPackages.id)),
    servicesLegacy(on),
  ]);
  const home = pageRows.filter((row) => row.slug === "home");
  const others = pageRows.filter((row) => row.slug !== "home");
  return [
    SITE_TARGET,
    ...[...home, ...others].map(pageTarget),
    servicesOverviewTarget(legacy),
    packagesOverviewTarget(),
    ...categoryRows.map(categoryTarget),
    ...serviceRows.map(serviceTarget),
    ...destinationRows.map(destinationTarget),
    ...packageRows.map(packageTarget),
  ];
}

/**
 * One target, read from the table its kind names, by id — or `null` when no
 * such record exists. With `lock`, the record row is held `FOR KEY SHARE` for
 * the rest of the transaction: an ordinary edit of it can proceed, but a change
 * of its address (a key column) or its deletion waits until the SEO write has
 * committed (B.11). A service's category is read, not locked: no admin writer
 * changes a category's address, and locking it after the service would invert
 * the order a category publication takes.
 */
export async function loadSeoTarget(
  on: Executor,
  ref: SeoRef,
  options: { lock?: boolean } = {},
): Promise<SeoTarget | null> {
  const lock = options.lock === true;
  switch (ref.kind) {
    case "site":
      return SITE_TARGET;
    case "serviceIndex":
      return servicesOverviewTarget(await servicesLegacy(on));
    case "packageIndex":
      return packagesOverviewTarget();
    case "page": {
      const query = on.select(pageColumns).from(pages).where(eq(pages.id, ref.id)).limit(1);
      const [row] = lock ? await query.for("key share") : await query;
      return row ? pageTarget(row) : null;
    }
    case "category": {
      const query = on.select(categoryColumns).from(serviceCategories).where(eq(serviceCategories.id, ref.id)).limit(1);
      const [row] = lock ? await query.for("key share") : await query;
      return row ? categoryTarget(row) : null;
    }
    case "service": {
      // The service's own row is locked by itself and its category read after
      // it, in a statement of its own. A lock taken through a join waits for a
      // move to another category and then re-checks the moved row against the
      // category it read before waiting — which no longer matches — and the
      // service reads as gone (found by the Batch 25 stress, M6).
      const query = on.select(serviceOwnColumns).from(services).where(eq(services.id, ref.id)).limit(1);
      const [own] = lock ? await query.for("key share") : await query;
      if (!own) return null;
      const [category] = await on
        .select({ slug: serviceCategories.slug, titleEn: serviceCategories.titleEn, isPublished: serviceCategories.isPublished })
        .from(serviceCategories)
        .where(eq(serviceCategories.id, own.categoryId))
        .limit(1);
      return category
        ? serviceTarget({ ...own, categorySlug: category.slug, categoryTitle: category.titleEn, categoryPublished: category.isPublished })
        : null;
    }
    case "destination": {
      const query = on
        .select(destinationColumns)
        .from(packageDestinations)
        .where(eq(packageDestinations.id, ref.id))
        .limit(1);
      const [row] = lock ? await query.for("key share") : await query;
      return row ? destinationTarget(row) : null;
    }
    case "package": {
      // Locked alone, its destination read after it — as for a service above:
      // a package re-filed while this waited is read where it went.
      const query = on.select(packageOwnColumns).from(travelPackages).where(eq(travelPackages.id, ref.id)).limit(1);
      const [own] = lock ? await query.for("key share") : await query;
      if (!own) return null;
      const [destination] =
        own.destinationId === null
          ? []
          : await on
              .select({ titleEn: packageDestinations.titleEn })
              .from(packageDestinations)
              .where(eq(packageDestinations.id, own.destinationId))
              .limit(1);
      return packageTarget({ ...own, destinationTitle: destination?.titleEn ?? null });
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Writing: one target at a time, in one order                                 */
/* -------------------------------------------------------------------------- */

/** An arbitrary namespace for the SEO target locks, so no other advisory lock can share them. */
const SEO_LOCK_SPACE = 25025;

/**
 * Serialises every write to one target's record — a save, a removal, the site
 * defaults — for the rest of the transaction. The record's own row lock cannot
 * do it: two `FOR KEY SHARE` locks do not conflict, a target with no SEO row
 * yet has no row to lock, and the overviews and the site defaults have no
 * record row at all. Taken before anything else is locked (B.11).
 */
export async function lockSeoTarget(tx: Executor, ref: SeoRef): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(${SEO_LOCK_SPACE}, hashtext(${`seo:${seoRefOf(ref)}`}))`);
}

/**
 * The picture a write is about to name as a share image, held `FOR KEY SHARE`
 * until the write commits — so a media deletion either sees the new reference
 * and refuses, or has already happened and this answers that the picture is
 * gone. Taken before any SEO row is locked: a deletion holds the picture first
 * and the SEO rows (through `ON DELETE SET NULL`) second, and the two orders
 * must agree. Returns why the picture cannot be used, or `null`.
 */
export async function lockShareImage(tx: Executor, id: number): Promise<string | null> {
  const [row] = await tx
    .select({ id: media.id, mimeType: media.mimeType })
    .from(media)
    .where(eq(media.id, id))
    .limit(1)
    .for("key share");
  if (!row) return "That picture is no longer in the media library. Choose another one.";
  if (!isRasterMime(row.mimeType)) {
    return "An SVG cannot be a share image — social networks do not show it. Choose a photograph or a graphic.";
  }
  return null;
}

export const isRasterMime = (mime: string): boolean => mime.startsWith("image/") && mime !== "image/svg+xml";

export type SeoRow = typeof seoMetadata.$inferSelect;

/**
 * A target's own rows, locked: its bound row and the unbound row at its present
 * address (normally at most one of them exists). `own` is the one the rule
 * uses (`preferredSeoRow` — the same rule every reader follows): the bound row,
 * else the unbound one, unless the bound row sits at another address beside a
 * newer unbound row at this one.
 */
export async function lockOwnSeoRows(
  tx: Executor,
  storage: SeoStorage,
): Promise<{ own: SeoRow | null; rows: SeoRow[] }> {
  const where =
    storage.entityId === null
      ? and(
          eq(seoMetadata.entityType, storage.entityType),
          isNull(seoMetadata.entityId),
          eq(seoMetadata.entityKey, storage.entityKey),
        )
      : and(
          eq(seoMetadata.entityType, storage.entityType),
          or(
            eq(seoMetadata.entityId, storage.entityId),
            and(isNull(seoMetadata.entityId), eq(seoMetadata.entityKey, storage.entityKey)),
          ),
        );
  const rows = await tx.select().from(seoMetadata).where(where).orderBy(asc(seoMetadata.id)).for("update");
  const bound = storage.entityId === null ? null : rows.find((row) => row.entityId === storage.entityId) ?? null;
  const unbound = rows.find((row) => row.entityId === null && row.entityKey === storage.entityKey) ?? null;
  return { own: preferredSeoRow(bound, unbound, storage), rows };
}

/**
 * A key in one of the reserved forms is about to be written — `#<id>` for a
 * record's own row, `~<n>` for row n set aside — so whatever else holds it is
 * moved to its own `~<row id>` first. Only a hand-made request to the previous
 * release's form can have put a row there (A.9); without this, it would turn
 * the write into a duplicate key.
 */
async function clearReservedKey(tx: Executor, type: SeoEntityType, key: string, forRowId: number): Promise<void> {
  await tx
    .update(seoMetadata)
    .set({ entityId: 0, entityKey: sql`'~' || ${seoMetadata.id}` })
    .where(and(eq(seoMetadata.entityType, type), eq(seoMetadata.entityKey, key), ne(seoMetadata.id, forRowId)));
}

/**
 * Takes a row out of use — kept, never used again (B.2): detached, and keyed
 * `~<row id>`, a key no address and no record can reach. So no record that
 * takes its old address inherits it, under this release or under the previous
 * one after a rollback, which reads rows by address.
 */
export async function detachSeoRow(tx: Executor, type: SeoEntityType, rowId: number): Promise<void> {
  await clearReservedKey(tx, type, `~${rowId}`, rowId);
  await tx
    .update(seoMetadata)
    .set({ entityId: 0, entityKey: sql`'~' || ${seoMetadata.id}` })
    .where(eq(seoMetadata.id, rowId));
}

/**
 * A record has just been created at an address (D1): whatever row sits there
 * is moved aside (`claimSeoKey`) — a row the previous release wrote for a
 * record gone since is set aside to `~<row id>`, and another live record's row
 * keyed by an address that record no longer has is parked at `#<its id>` — so
 * the new record starts with nothing of either, under this release and under
 * the previous one after a rollback (which reads by address). In the create
 * transaction, after the record's own insert; the caller drops the `seo` tag
 * once it has committed.
 */
export async function freeSeoAddress(tx: Executor, type: SeoEntityType, address: string, id: number): Promise<void> {
  const key = storedKeyOf(address, id);
  // `#<new id>` is the record's own; nothing else can hold it.
  if (key.startsWith("#")) return;
  await claimSeoKey(tx, type, key, null);
}

/** Whether a record of a type still exists — the test between a stale key and a dead row. */
async function recordExists(tx: Executor, type: SeoEntityType, id: number): Promise<boolean> {
  const table = {
    page: pages,
    category: serviceCategories,
    service: services,
    package: travelPackages,
    destination: packageDestinations,
  }[type];
  const [row] = await tx.select({ id: table.id }).from(table).where(eq(table.id, id)).limit(1);
  return Boolean(row);
}

/**
 * Frees `key` for the row `ownRowId` (or for a row about to be inserted). A row
 * already holding it is one of two things:
 *
 *   · bound to another record that still exists — its key is stale (the
 *     previous release moved that record without moving its row). It keeps its
 *     data and its record, and is keyed `#<its record's id>`, which nothing
 *     else can hold; the next deploy's reconcile puts it at its record's
 *     present address.
 *   · anything else — detached, unbound beside a bound row, or bound to a
 *     record that is gone. It is dead: kept, never used, moved aside to
 *     `~<row id>` and detached.
 *
 * Nothing is deleted.
 */
export async function claimSeoKey(
  tx: Executor,
  type: SeoEntityType,
  key: string,
  ownRowId: number | null,
): Promise<void> {
  const [holder] = await tx
    .select({ id: seoMetadata.id, entityId: seoMetadata.entityId })
    .from(seoMetadata)
    .where(and(eq(seoMetadata.entityType, type), eq(seoMetadata.entityKey, key)))
    .limit(1)
    .for("update");
  if (!holder || holder.id === ownRowId) return;
  if (holder.entityId !== null && holder.entityId > 0 && (await recordExists(tx, type, holder.entityId))) {
    await clearReservedKey(tx, type, `#${holder.entityId}`, holder.id);
    await tx.update(seoMetadata).set({ entityKey: `#${holder.entityId}` }).where(eq(seoMetadata.id, holder.id));
    return;
  }
  await detachSeoRow(tx, type, holder.id);
}

/**
 * A record's address changed (a destination's slug, a service's category):
 * its SEO row goes with it, in the transaction that changed the address and
 * after the record's row is locked (B.7). The row moved is the one the rule
 * uses — bound, else unbound at the old address — and it is bound as it moves.
 * Its other row — its own row left at an older address, shadowed by a newer
 * row at its present one — is set aside (`detachSeoRow`). Anything else at
 * the new address is cleared first (`claimSeoKey`), so a dead row there can
 * never be inherited. Returns whether a row moved.
 */
export async function moveSeoRow(
  tx: Executor,
  type: SeoEntityType,
  id: number,
  fromAddress: string,
  toAddress: string,
): Promise<boolean> {
  const from = recordStorage(type, fromAddress, id);
  const toKey = storedKeyOf(toAddress, id);
  const { own, rows } = await lockOwnSeoRows(tx, from);
  for (const row of rows) {
    if (own && row.id !== own.id) await detachSeoRow(tx, type, row.id);
  }
  if (own?.entityKey === toKey && own.entityId === id) return false;
  await claimSeoKey(tx, type, toKey, own?.id ?? null);
  if (!own) return false;
  await tx.update(seoMetadata).set({ entityKey: toKey, entityId: id }).where(eq(seoMetadata.id, own.id));
  return true;
}

/**
 * Records deleted: their SEO rows go with them, in the same transaction and
 * after the records' own rows (B.7, B.11) — the bound rows, and an unbound row
 * at a deleted record's address. The share images they named are released.
 * Returns how many rows went.
 */
export async function dropSeoRows(
  tx: Executor,
  type: SeoEntityType,
  records: ReadonlyArray<{ id: number; address: string }>,
): Promise<number> {
  if (!records.length) return 0;
  const removed = await tx
    .delete(seoMetadata)
    .where(
      and(
        eq(seoMetadata.entityType, type),
        or(
          ...records.map((record) =>
            or(
              eq(seoMetadata.entityId, record.id),
              and(isNull(seoMetadata.entityId), eq(seoMetadata.entityKey, storedKeyOf(record.address, record.id))),
            ),
          ),
        ),
      ),
    )
    .returning({ id: seoMetadata.id });
  return removed.length;
}

/* -------------------------------------------------------------------------- */
/* F5: the share images in use                                                 */
/* -------------------------------------------------------------------------- */

export type SeoMediaUse = { mediaId: number; label: string; href: string };

const isMediaId = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

/**
 * Every picture SEO uses (B.5): the share image of each record a target uses
 * under the rule — whether the page is published or not, since publishing it
 * makes the record live at once — and the site's default share image. A
 * detached row, or one whose record is gone, uses nothing.
 *
 * Read on the executor it is given, so the media library's delete can recount
 * inside the transaction that holds the picture.
 */
export async function seoMediaUsage(on: Executor = db): Promise<SeoMediaUse[]> {
  // Every row, not only those naming a picture: which row a target uses is
  // decided among all of them (a row without a picture can be the one it uses),
  // exactly as the page decides it — only then is its picture looked at.
  const [rows, settingsRows] = await Promise.all([
    on
      .select({
        entityType: seoMetadata.entityType,
        entityKey: seoMetadata.entityKey,
        entityId: seoMetadata.entityId,
        ogImageId: seoMetadata.ogImageId,
      })
      .from(seoMetadata),
    on.select({ value: siteSettings.value }).from(siteSettings).where(eq(siteSettings.key, "seo")).limit(1),
  ]);

  const uses: SeoMediaUse[] = [];
  if (rows.some((row) => row.ogImageId !== null)) {
    const index = indexSeoRows(rows);
    for (const target of await listSeoTargets(on)) {
      if (!target.storage) continue;
      const row = seoRowFor(index, target.storage);
      if (row && isMediaId(row.ogImageId)) {
        uses.push({
          mediaId: row.ogImageId,
          label: `${target.label} — search and sharing image`,
          href: `/admin/seo?target=${target.ref}`,
        });
      }
    }
  }
  const siteImage = settingsRows[0]?.value?.ogImageId;
  if (isMediaId(siteImage)) {
    uses.push({ mediaId: siteImage, label: "Site default share image", href: "/admin/seo?target=site:1" });
  }
  return uses;
}
