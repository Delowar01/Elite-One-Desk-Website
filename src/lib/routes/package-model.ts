import type { packageDestinations, travelPackages } from "@/lib/db/schema";

import type { RouteDocument, RouteOwner, RouteOwnerType } from "./owners";
import { ownerKeyOf } from "./owners";
import { describeStored, listItemsOf, SPECS, type FieldSpec, type StoredPatch } from "./specs";

/**
 * A package's own page (Batch 24): what the Visual Editor needs to know about
 * `/[lang]/packages/[slug]` when the slug is a package's.
 *
 * The service page's twin (`service-model.ts`), answering the same questions
 * from the row alone — so a package created tomorrow is editable the moment it
 * exists, and no package is named in code:
 *
 *   1. **Which regions does this page draw?** `packageOwnersOf` — the hero,
 *      the breadcrumbs, the description, the highlights and the request
 *      form, every one keyed by the package's id.
 *   2. **Where does each field live?** `SPECS` — the package's own columns
 *      and the template copy of its headings and buttons.
 *   3. **What does a draft make it say?** `effectivePackageData` — the live
 *      row with every pending patch laid over it.
 *
 * Its identity is the package's row id, never its address: a rename or a move
 * to another destination changes nothing here, and the slug never changes
 * after the package is created (`docs/visual-editor/whole-site-coverage.md`,
 * A.3). Pure: no connection. The database reads are `packages.ts`.
 */

export type PackageRow = typeof travelPackages.$inferSelect;
export type DestinationRow = typeof packageDestinations.$inferSelect;

/** Everything a package's page draws: the package itself. Unpublished, too — the editor opens a hidden package. */
export type PackageData = { pkg: PackageRow };

/** The regions of a package's page, in page order, each keyed by the package's id. */
export const PACKAGE_REGIONS = [
  "packageHero",
  "packageCrumbs",
  "packageBody",
  "packageHighlights",
  "packageRequest",
] as const satisfies readonly RouteOwnerType[];

export type PackageRegion = (typeof PACKAGE_REGIONS)[number];

const PACKAGE_REGION_SET: ReadonlySet<RouteOwnerType> = new Set(PACKAGE_REGIONS);

export const isPackageRegion = (type: RouteOwnerType): type is PackageRegion => PACKAGE_REGION_SET.has(type);

/** The regions whose columns are the package row's own. */
const ROW_REGIONS: ReadonlySet<RouteOwnerType> = new Set(["packageHero", "packageBody", "packageHighlights"]);

/**
 * The regions a package's page draws. Every one is offered on every package —
 * an empty description or highlights list is drawn in the canvas as a
 * placeholder, so it can be selected and written.
 */
export const packageOwnersOf = (data: PackageData): RouteOwner[] =>
  PACKAGE_REGIONS.map((type) => ({ type, id: data.pkg.id }));

/** Whether an owner is drawn on this package's page. The IDOR check every action makes. */
export const packageOwnerBelongs = (owner: RouteOwner, data: PackageData): boolean =>
  isPackageRegion(owner.type) && owner.id === data.pkg.id;

export const documentOfPackage = (packageId: number): RouteDocument => ({ kind: "package", id: packageId });

/** The public path of a package's page, without a language prefix. */
export const packagePathOf = (pkg: Pick<PackageRow, "slug">): string => `/packages/${pkg.slug}`;

/* -------------------------------------------------------------------------- */
/* Live values, and the draft laid over them                                  */
/* -------------------------------------------------------------------------- */

/** A stored value in the one shape the editor compares: a list as `{ en, ar }` items, whatever its key order. */
const listValue = (spec: FieldSpec, value: unknown): unknown => (spec.check === "items" ? listItemsOf(value) : value);

/**
 * One owner's stored values, by storage key, as `row` has them — the column of
 * the row, or the region's template copy. Shared by every region that writes a
 * package row (a package's page here, its card on the catalogue).
 */
export function rowStoredValues(
  type: RouteOwnerType,
  row: Record<string, unknown> | null,
  copy: Record<string, string> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of SPECS[type]) {
    if (spec.key.startsWith("copy:")) {
      const value = copy?.[spec.key.slice(5)];
      out[spec.key] = typeof value === "string" ? value : "";
    } else if (spec.check !== "order") {
      out[spec.key] = row ? listValue(spec, row[spec.key] ?? null) : null;
    }
  }
  return out;
}

/** A row with one region's pending column patches laid over it. Template copy and orders are not columns. */
export function patchedRow<T extends object>(row: T, owner: RouteOwner, patches: ReadonlyMap<string, StoredPatch>): T {
  const patch = patches.get(ownerKeyOf(owner));
  if (!patch) return row;
  const next = { ...row } as Record<string, unknown>;
  for (const spec of SPECS[owner.type]) {
    if (spec.key.startsWith("copy:") || spec.check === "order") continue;
    const entry = patch[spec.key];
    if (entry) next[spec.key] = entry.value;
  }
  return next as unknown as T;
}

export function packageStoredValuesOf(
  owner: RouteOwner,
  data: PackageData,
  copy: Record<string, string> | null | undefined,
): Record<string, unknown> {
  const row = ROW_REGIONS.has(owner.type) ? (data.pkg as unknown as Record<string, unknown>) : null;
  return rowStoredValues(owner.type, row, copy);
}

/** The package row with every region's pending patch applied (their keys never overlap). */
export function effectivePackageData(data: PackageData, patches: ReadonlyMap<string, StoredPatch>): PackageData {
  let pkg = data.pkg;
  for (const type of ROW_REGIONS) pkg = patchedRow(pkg, { type, id: data.pkg.id }, patches);
  return { pkg };
}

/* -------------------------------------------------------------------------- */
/* Visibility and naming                                                      */
/* -------------------------------------------------------------------------- */

const hasText = (...values: (string | null | undefined)[]) => values.some((value) => Boolean(value?.trim()));

/**
 * Whether a region would be on the public page with its drafts published: the
 * description and the highlights only when either edition has something to
 * show — Arabic falls back to English.
 */
export function packageRegionVisible(owner: RouteOwner, effective: PackageData): boolean {
  const row = effective.pkg;
  switch (owner.type) {
    case "packageBody":
      return hasText(row.bodyEn, row.bodyAr);
    case "packageHighlights":
      return listItemsOf(row.highlights).some((item) => hasText(item.en, item.ar));
    default:
      return true;
  }
}

export const quoted = (value: string) => `“${value.length > 48 ? `${value.slice(0, 47).trimEnd()}…` : value}”`;

const REGION_WORDS: Record<PackageRegion, string> = {
  packageHero: "Hero",
  packageCrumbs: "Breadcrumbs",
  packageBody: "Description",
  packageHighlights: "Highlights",
  packageRequest: "Request form",
};

/** What an owner is, in words: "Hero of “Cairo & Giza Classic”", "Highlights". */
export function packageOwnerLabel(owner: RouteOwner, data: PackageData): string {
  if (owner.type === "packageHero") return `Hero of ${quoted(data.pkg.titleEn)}`;
  if (isPackageRegion(owner.type)) return REGION_WORDS[owner.type];
  return `Region ${ownerKeyOf(owner)}`;
}

/** The admin screen that manages what a region shows. */
export const packageAdminHrefOf = (owner: RouteOwner, data: PackageData): string | null =>
  owner.type === "packageCrumbs" ? null : `/admin/packages/${data.pkg.id}`;

/** A stored value in words; a package page names no group and no list member. */
export const describePackageValue = (spec: FieldSpec | undefined, value: unknown): string =>
  describeStored(spec, value, { group: () => null, member: () => null });
