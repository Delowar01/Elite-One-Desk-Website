import type { RouteDocument, RouteOwner, RouteOwnerType } from "./owners";
import { ownerKeyOf, SINGLETON_ID } from "./owners";
import { patchedRow, quoted, rowStoredValues, type DestinationRow, type PackageRow } from "./package-model";
import { describeStored, type FieldSpec, type StoredPatch } from "./specs";

/**
 * The package catalogue, `/packages` (Batch 24).
 *
 * One page per site, so its document is `packageIndex:1`. What it draws is the
 * catalogue's own wording around two kinds of records:
 *
 *   · **a group per destination** — its heading is the destination's title,
 *     so the group is the destination (`destinationGroup:<destination id>`);
 *   · **a card per package** — the package's title, place, duration, summary
 *     and picture, and the structure a service card offers: which destination
 *     it is filed under, featured, shown or hidden (`packageCard:<package id>`).
 *
 * The rule for what goes where is the public page's, and lives here once
 * (`groupCatalogue`) so the page, the canvas and the preview cannot disagree:
 * a published destination holding a published package is a group; every other
 * published package is in "Build your own"; with no group at all the
 * catalogue falls back to its legacy region grouping.
 *
 * Pure: no connection. The database reads are `packages.ts`.
 */

/**
 * Every destination and every package — unpublished ones included: the editor
 * draws a hidden card dimmed, and a card may be filed under a destination that
 * is not published yet.
 */
export type CatalogueData = { destinations: DestinationRow[]; packages: PackageRow[] };

/** The catalogue's own regions, keyed by the singleton id. */
const OWN_REGIONS = [
  "packageIndexHero",
  "packageIndexCrumbs",
  "packageIndexCatalogue",
  "packageIndexCustom",
] as const satisfies readonly RouteOwnerType[];

const OWN_REGION_SET: ReadonlySet<RouteOwnerType> = new Set(OWN_REGIONS);

export const isCatalogueOwnRegion = (type: RouteOwnerType): boolean => OWN_REGION_SET.has(type);

export const documentOfCatalogue = (): RouteDocument => ({ kind: "packageIndex", id: SINGLETON_ID });

export const CATALOGUE_PATH = "/packages";

/* -------------------------------------------------------------------------- */
/* What goes where                                                            */
/* -------------------------------------------------------------------------- */

/** Featured first, then the Packages screen's order — what `getPackages` sorts by. */
export const packageOrder = (a: PackageRow, b: PackageRow): number =>
  Number(b.isFeatured) - Number(a.isFeatured) || a.sortOrder - b.sortOrder || a.id - b.id;

export const destinationOrder = (a: DestinationRow, b: DestinationRow): number => a.sortOrder - b.sortOrder || a.id - b.id;

export type CatalogueGroup = { destination: DestinationRow; packages: PackageRow[] };

export type CatalogueLayout = {
  /** The packages drawn, in order. */
  packages: PackageRow[];
  /** One group per published destination that holds a drawn package. */
  grouped: CatalogueGroup[];
  /** Drawn packages in no destination, or in one that is not published. */
  ungrouped: PackageRow[];
  /** Whether the catalogue groups by destination at all, rather than by the legacy region. */
  destinationMode: boolean;
};

/**
 * The catalogue's layout. `shown` decides which packages are drawn: the
 * published ones for a visitor and a preview, every one in the editor canvas
 * (a hidden card is drawn dimmed where it is filed). Only a published
 * destination ever makes a group — an unpublished destination is a place that
 * is not ready to show, never a reason to hide the packages filed under it.
 */
export function groupCatalogue(
  destinations: DestinationRow[],
  packages: PackageRow[],
  shown: (row: PackageRow) => boolean = (row) => row.isPublished,
): CatalogueLayout {
  const rows = packages.filter(shown).sort(packageOrder);
  const published = destinations.filter((row) => row.isPublished).sort(destinationOrder);
  const visible = new Set(published.map((row) => row.id));
  const byDestination = new Map<number, PackageRow[]>();
  for (const row of rows) {
    if (row.destinationId == null || !visible.has(row.destinationId)) continue;
    byDestination.set(row.destinationId, [...(byDestination.get(row.destinationId) ?? []), row]);
  }
  const grouped = published
    .map((destination) => ({ destination, packages: byDestination.get(destination.id) ?? [] }))
    .filter((group) => group.packages.length > 0);
  return {
    packages: rows,
    grouped,
    ungrouped: rows.filter((row) => row.destinationId == null || !visible.has(row.destinationId)),
    destinationMode: grouped.length > 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Regions                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The regions the catalogue may draw: its own four, a group for every
 * published destination and a card for every package. Which of them a given
 * render draws depends on the data (an empty group, the legacy grouping); the
 * set itself is what an editor may address, and is derived from the rows alone.
 */
export function catalogueOwnersOf(data: CatalogueData): RouteOwner[] {
  const id = SINGLETON_ID;
  return [
    { type: "packageIndexHero", id },
    { type: "packageIndexCrumbs", id },
    { type: "packageIndexCatalogue", id },
    ...data.destinations
      .filter((row) => row.isPublished)
      .sort(destinationOrder)
      .map((row) => ({ type: "destinationGroup" as const, id: row.id })),
    ...[...data.packages].sort(packageOrder).map((row) => ({ type: "packageCard" as const, id: row.id })),
    { type: "packageIndexCustom", id },
  ];
}

/** Whether an owner is drawn on the catalogue. The IDOR check every action makes. */
export function catalogueOwnerBelongs(owner: RouteOwner, data: CatalogueData): boolean {
  if (OWN_REGION_SET.has(owner.type)) return owner.id === SINGLETON_ID;
  if (owner.type === "destinationGroup") return data.destinations.some((row) => row.id === owner.id && row.isPublished);
  if (owner.type === "packageCard") return data.packages.some((row) => row.id === owner.id);
  return false;
}

/* -------------------------------------------------------------------------- */
/* Live values, and the draft laid over them                                  */
/* -------------------------------------------------------------------------- */

function rowOf(owner: RouteOwner, data: CatalogueData): Record<string, unknown> | null {
  if (owner.type === "destinationGroup") {
    return (data.destinations.find((row) => row.id === owner.id) as unknown as Record<string, unknown>) ?? null;
  }
  if (owner.type === "packageCard") {
    return (data.packages.find((row) => row.id === owner.id) as unknown as Record<string, unknown>) ?? null;
  }
  return null;
}

export const catalogueStoredValuesOf = (
  owner: RouteOwner,
  data: CatalogueData,
  copy: Record<string, string> | null | undefined,
): Record<string, unknown> => rowStoredValues(owner.type, rowOf(owner, data), copy);

/** Every destination and package with its own region's pending patch applied. */
export const effectiveCatalogueData = (data: CatalogueData, patches: ReadonlyMap<string, StoredPatch>): CatalogueData => ({
  destinations: data.destinations.map((row) => patchedRow(row, { type: "destinationGroup", id: row.id }, patches)),
  packages: data.packages.map((row) => patchedRow(row, { type: "packageCard", id: row.id }, patches)),
});

/**
 * Whether a region would be on the public page with its drafts published: a
 * card while its package is shown; a group while it holds a shown package and
 * the catalogue groups by destination; "Build your own" while it holds one.
 */
export function catalogueRegionVisible(owner: RouteOwner, effective: CatalogueData): boolean {
  const layout = groupCatalogue(effective.destinations, effective.packages);
  switch (owner.type) {
    case "packageCard":
      return effective.packages.find((row) => row.id === owner.id)?.isPublished === true;
    case "destinationGroup":
      return layout.grouped.some((group) => group.destination.id === owner.id);
    case "packageIndexCustom":
      return layout.destinationMode && layout.ungrouped.length > 0;
    default:
      return true;
  }
}

/* -------------------------------------------------------------------------- */
/* Choices and naming                                                         */
/* -------------------------------------------------------------------------- */

/** A choice the Inspector offers for a field (the adapter's `RouteOption`). */
type RouteOption = { value: string; label: string };

/** The destinations a card may be filed under: every one, an unpublished one said to be so. */
export function catalogueOptions(owner: RouteOwner, data: CatalogueData): Record<string, RouteOption[]> {
  if (owner.type !== "packageCard") return {};
  return {
    group: [
      { value: "", label: "No destination" },
      ...[...data.destinations].sort(destinationOrder).map((row) => ({
        value: String(row.id),
        label: row.isPublished ? row.titleEn : `${row.titleEn} (not published)`,
      })),
    ],
  };
}

const REGION_WORDS: Partial<Record<RouteOwnerType, string>> = {
  packageIndexHero: "Hero",
  packageIndexCrumbs: "Breadcrumbs",
  packageIndexCatalogue: "Catalogue",
  packageIndexCustom: "Build your own",
};

export function catalogueOwnerLabel(owner: RouteOwner, data: CatalogueData): string {
  if (owner.type === "destinationGroup") {
    const row = data.destinations.find((entry) => entry.id === owner.id);
    return row ? `Destination ${quoted(row.titleEn)}` : `Destination #${owner.id}`;
  }
  if (owner.type === "packageCard") {
    const row = data.packages.find((entry) => entry.id === owner.id);
    return row ? `Package card ${quoted(row.titleEn)}` : `Package #${owner.id}`;
  }
  return REGION_WORDS[owner.type] ?? `Region ${ownerKeyOf(owner)}`;
}

export function catalogueAdminHrefOf(owner: RouteOwner): string | null {
  switch (owner.type) {
    case "destinationGroup":
      return `/admin/packages/destinations/${owner.id}`;
    case "packageCard":
      return `/admin/packages/${owner.id}`;
    case "packageIndexCatalogue":
    case "packageIndexCustom":
      return "/admin/packages";
    default:
      return null;
  }
}

/** A stored value in words, naming a destination by its title. */
export const describeCatalogueValue = (spec: FieldSpec | undefined, value: unknown, data: CatalogueData): string =>
  describeStored(spec, value, {
    group: (id) => data.destinations.find((row) => row.id === id)?.titleEn ?? null,
    member: () => null,
  });
