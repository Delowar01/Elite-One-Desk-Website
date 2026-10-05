import type { RouteDocument, RouteOwner, RouteOwnerType } from "./owners";
import { ownerKeyOf } from "./owners";
import { patchedRow, quoted, rowStoredValues, type DestinationRow, type PackageRow } from "./package-model";
import type { StoredPatch } from "./specs";

/**
 * A destination's own page (Batch 24): `/[lang]/packages/[slug]` when the slug
 * is a destination's.
 *
 * Three regions, keyed by the destination's id — the hero (its title, summary
 * and picture), the breadcrumbs, and its packages. The packages are drawn but
 * never owned here: each card belongs to the catalogue (`/packages`), where it
 * is edited, so two pages never own one region. A destination's slug can
 * change on the Destinations screen; its id cannot, so its drafts and history
 * follow it (`docs/visual-editor/whole-site-coverage.md`, B.3).
 *
 * Pure: no connection. The database reads are `packages.ts`.
 */

/**
 * The destination, and the published packages filed under it in the order the
 * public page shows them — featured first, then the Packages screen's order.
 * Unpublished destinations are included: the editor opens a hidden one.
 */
export type DestinationData = { destination: DestinationRow; packages: PackageRow[] };

export const DESTINATION_REGIONS = [
  "destinationHero",
  "destinationCrumbs",
  "destinationPackages",
] as const satisfies readonly RouteOwnerType[];

export type DestinationRegion = (typeof DESTINATION_REGIONS)[number];

const DESTINATION_REGION_SET: ReadonlySet<RouteOwnerType> = new Set(DESTINATION_REGIONS);

export const isDestinationRegion = (type: RouteOwnerType): type is DestinationRegion =>
  DESTINATION_REGION_SET.has(type);

export const destinationOwnersOf = (data: DestinationData): RouteOwner[] =>
  DESTINATION_REGIONS.map((type) => ({ type, id: data.destination.id }));

export const destinationOwnerBelongs = (owner: RouteOwner, data: DestinationData): boolean =>
  isDestinationRegion(owner.type) && owner.id === data.destination.id;

export const documentOfDestination = (destinationId: number): RouteDocument => ({ kind: "destination", id: destinationId });

export const destinationPathOf = (destination: Pick<DestinationRow, "slug">): string => `/packages/${destination.slug}`;

export function destinationStoredValuesOf(
  owner: RouteOwner,
  data: DestinationData,
  copy: Record<string, string> | null | undefined,
): Record<string, unknown> {
  const row = owner.type === "destinationHero" ? (data.destination as unknown as Record<string, unknown>) : null;
  return rowStoredValues(owner.type, row, copy);
}

export const effectiveDestinationData = (data: DestinationData, patches: ReadonlyMap<string, StoredPatch>): DestinationData => ({
  destination: patchedRow(data.destination, { type: "destinationHero", id: data.destination.id }, patches),
  packages: data.packages,
});

const REGION_WORDS: Record<DestinationRegion, string> = {
  destinationHero: "Hero",
  destinationCrumbs: "Breadcrumbs",
  destinationPackages: "Packages",
};

export function destinationOwnerLabel(owner: RouteOwner, data: DestinationData): string {
  if (owner.type === "destinationHero") return `Hero of ${quoted(data.destination.titleEn)}`;
  if (isDestinationRegion(owner.type)) return REGION_WORDS[owner.type];
  return `Region ${ownerKeyOf(owner)}`;
}

export function destinationAdminHrefOf(owner: RouteOwner, data: DestinationData): string | null {
  if (owner.type === "destinationHero") return `/admin/packages/destinations/${data.destination.id}`;
  if (owner.type === "destinationPackages") return "/admin/packages";
  return null;
}
