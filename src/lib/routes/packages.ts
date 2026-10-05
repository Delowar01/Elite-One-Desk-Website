import "server-only";

import { and, asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import type { Executor } from "@/lib/db/revision";
import { packageDestinations, travelPackages } from "@/lib/db/schema";

import type { CatalogueData } from "./catalogue-model";
import type { DestinationData } from "./destination-model";
import { SINGLETON_ID } from "./owners";
import type { PackageData } from "./package-model";
import { packageOrder } from "./catalogue-model";

export * from "./package-model";
export * from "./destination-model";
export * from "./catalogue-model";

/**
 * The database half of the package routes (Batch 24): a package's page, a
 * destination's page and the catalogue — what each reads, what each holds while
 * it publishes, the lists the editor opens them from, and finding one by its
 * address. Everything that decides is pure (`package-model.ts`,
 * `destination-model.ts`, `catalogue-model.ts`), re-exported here so a caller
 * has one import.
 *
 * Locks. A publication holds, `FOR UPDATE`, exactly the rows it writes, always
 * destinations before packages and both before the route's regions
 * (`store.ts`): a package's page its package, a destination's page its
 * destination, the catalogue every destination and then every package, each
 * set in id order. The Packages and Destinations screens lock the one row they
 * save. No writer holds a package while waiting for a destination, so none of
 * them can wait for another in a circle.
 */

const isRecordId = (id: number) => Number.isInteger(id) && id > 0;

/** A package's page: the package, in one query. */
export async function loadPackageData(
  on: Executor,
  packageId: number,
  options: { lock?: boolean } = {},
): Promise<PackageData | null> {
  if (!isRecordId(packageId)) return null;
  const query = on.select().from(travelPackages).where(eq(travelPackages.id, packageId)).limit(1);
  const [pkg] = options.lock ? await query.for("update") : await query;
  return pkg ? { pkg } : null;
}

/**
 * A destination's page: the destination, and the published packages filed
 * under it in the public page's order. Only the destination is held while
 * publishing — the cards are its packages', owned and written by the catalogue.
 */
export async function loadDestinationData(
  on: Executor,
  destinationId: number,
  options: { lock?: boolean } = {},
): Promise<DestinationData | null> {
  if (!isRecordId(destinationId)) return null;
  const query = on.select().from(packageDestinations).where(eq(packageDestinations.id, destinationId)).limit(1);
  const [destination] = options.lock ? await query.for("update") : await query;
  if (!destination) return null;
  const packages = await on
    .select()
    .from(travelPackages)
    .where(and(eq(travelPackages.destinationId, destinationId), eq(travelPackages.isPublished, true)));
  return { destination, packages: [...packages].sort(packageOrder) };
}

/** The catalogue: every destination and every package, held in that order while publishing. */
export async function loadCatalogueData(
  on: Executor,
  id: number,
  options: { lock?: boolean } = {},
): Promise<CatalogueData | null> {
  if (id !== SINGLETON_ID) return null;
  const destinationQuery = on.select().from(packageDestinations).orderBy(asc(packageDestinations.id));
  const destinations = options.lock ? await destinationQuery.for("update") : await destinationQuery;
  const packageQuery = on.select().from(travelPackages).orderBy(asc(travelPackages.id));
  const packages = options.lock ? await packageQuery.for("update") : await packageQuery;
  return { destinations, packages };
}

export type PackageDocumentRow = {
  id: number;
  slug: string;
  titleEn: string;
  isPublished: boolean;
  destinationTitle: string | null;
};

export type DestinationDocumentRow = { id: number; slug: string; titleEn: string; isPublished: boolean };

/**
 * Every destination the editor can open, in their own order — read from the
 * table on every load, so a destination created tomorrow is offered tomorrow.
 */
export async function listDestinationDocuments(): Promise<DestinationDocumentRow[]> {
  return db
    .select({
      id: packageDestinations.id,
      slug: packageDestinations.slug,
      titleEn: packageDestinations.titleEn,
      isPublished: packageDestinations.isPublished,
    })
    .from(packageDestinations)
    .orderBy(asc(packageDestinations.sortOrder), asc(packageDestinations.id));
}

/**
 * Every package the editor can open, each with the destination it is filed
 * under (the group it is listed in) — so a package created tomorrow, or moved
 * to another destination, is listed where it is now.
 */
export async function listPackageDocuments(): Promise<PackageDocumentRow[]> {
  return db
    .select({
      id: travelPackages.id,
      slug: travelPackages.slug,
      titleEn: travelPackages.titleEn,
      isPublished: travelPackages.isPublished,
      destinationTitle: packageDestinations.titleEn,
    })
    .from(travelPackages)
    .leftJoin(packageDestinations, eq(packageDestinations.id, travelPackages.destinationId))
    .orderBy(asc(travelPackages.sortOrder), asc(travelPackages.id));
}

/**
 * What `/packages/<slug>` names — a destination first, then a package, exactly
 * the order the public page resolves in — published or not. Preview and the
 * canvas only: a visitor's page resolves among published rows, from the cache.
 */
export async function packagesSlugTarget(
  slug: string,
): Promise<{ kind: "destination"; id: number } | { kind: "package"; id: number } | null> {
  const [destination] = await db
    .select({ id: packageDestinations.id })
    .from(packageDestinations)
    .where(eq(packageDestinations.slug, slug))
    .limit(1);
  if (destination) return { kind: "destination", id: destination.id };
  const [pkg] = await db.select({ id: travelPackages.id }).from(travelPackages).where(eq(travelPackages.slug, slug)).limit(1);
  return pkg ? { kind: "package", id: pkg.id } : null;
}
