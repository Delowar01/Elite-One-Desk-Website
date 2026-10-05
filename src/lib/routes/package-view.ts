import "server-only";

import { db } from "@/lib/db";
import { getDestinations, getPackageCatalog, getPackages } from "@/lib/queries/catalog";

import { readCatalogueContext, readDestinationContext, readPackageContext, readServiceIndexContext } from "./drafts";
import { packagesSlugTarget, type CatalogueData, type DestinationData, type PackageData } from "./packages";
import { maySeeDrafts, privateRender, publishedFrom, wantsPrivate, type RouteRender } from "./route-view";
import type { ServiceIndexData } from "./service-index-model";
import { publishedPresentations } from "./store";

/**
 * How a request for a package's page, a destination's page, the package
 * catalogue or the services overview is answered (Batch 24) — the same table
 * as every dynamic route (`route-view.ts`): a visitor gets the published page
 * from the caches every visitor shares, and only a session with
 * `content.view` reaches the drafts, by the record's id.
 *
 * `/packages/<slug>` keeps its one rule in every mode: a destination first,
 * then a package. A visitor's lookup is among published rows, exactly as the
 * page always resolved it; a private one is among every row, so an editor can
 * open a hidden package or destination.
 */

export type PackageRender = RouteRender<PackageData>;
export type DestinationRender = RouteRender<DestinationData>;
export type CatalogueRender = RouteRender<CatalogueData>;
export type ServiceIndexRender = RouteRender<ServiceIndexData>;

type SearchParams = Record<string, string | string[] | undefined> | undefined;

/** The answer every public render shares: no editor, no draft, the published presentation. */
const publicView = <D>(routeKey: string, data: D, presentations: Awaited<ReturnType<typeof publishedPresentations>>): RouteRender<D> => ({
  mode: "public",
  editor: null,
  still: false,
  routeKey,
  data,
  hidden: new Set(),
  drafted: new Set(),
  presentation: publishedFrom(presentations),
});

/** What a visitor would see of the catalogue's rows: published destinations, published packages. */
const publishedCatalogue = (data: CatalogueData): CatalogueData => ({
  destinations: data.destinations.filter((row) => row.isPublished),
  packages: data.packages.filter((row) => row.isPublished),
});

export async function resolvePackagesSlugRender(
  slug: string,
  searchParams: SearchParams,
): Promise<{ kind: "destination"; view: DestinationRender } | { kind: "package"; view: PackageRender } | null> {
  if (!wantsPrivate(searchParams) || !(await maySeeDrafts())) {
    const [destinations, presentations] = await Promise.all([getDestinations(), publishedPresentations()]);
    const destination = destinations.find((row) => row.slug === slug);
    if (destination) {
      const { grouped } = await getPackageCatalog();
      const packages = grouped.find((group) => group.destination.id === destination.id)?.packages ?? [];
      return {
        kind: "destination",
        view: publicView(`destination:${destination.id}`, { destination, packages }, presentations),
      };
    }
    const pkg = (await getPackages()).find((row) => row.slug === slug);
    return pkg ? { kind: "package", view: publicView(`package:${pkg.id}`, { pkg }, presentations) } : null;
  }

  const target = await packagesSlugTarget(slug);
  if (!target) return null;
  if (target.kind === "destination") {
    const context = await readDestinationContext(db, target.id);
    const view = context ? await privateRender(context, searchParams, (data) => data) : null;
    return view ? { kind: "destination", view } : null;
  }
  const context = await readPackageContext(db, target.id);
  const view = context ? await privateRender(context, searchParams, (data) => data) : null;
  return view ? { kind: "package", view } : null;
}

export async function resolveCatalogueRender(searchParams: SearchParams): Promise<CatalogueRender | null> {
  if (!wantsPrivate(searchParams) || !(await maySeeDrafts())) {
    const [destinations, packages, presentations] = await Promise.all([getDestinations(), getPackages(), publishedPresentations()]);
    return publicView("packageIndex:1", { destinations, packages }, presentations);
  }
  const context = await readCatalogueContext(db);
  return context ? privateRender(context, searchParams, publishedCatalogue) : null;
}

export async function resolveServiceIndexRender(searchParams: SearchParams): Promise<ServiceIndexRender | null> {
  if (!wantsPrivate(searchParams) || !(await maySeeDrafts())) {
    return publicView("serviceIndex:1", { id: 1 as const }, await publishedPresentations());
  }
  const context = await readServiceIndexContext(db);
  return context ? privateRender(context, searchParams, (data) => data) : null;
}
