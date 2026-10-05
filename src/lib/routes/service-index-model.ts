import type { RouteDocument, RouteOwner, RouteOwnerType } from "./owners";
import { ownerKeyOf, SINGLETON_ID } from "./owners";
import { rowStoredValues } from "./package-model";

/**
 * The services overview, `/services` (Batch 24).
 *
 * One page per site — `serviceIndex:1` — and, apart from its own wording, a
 * page that owns nothing: every row is a service category's, drawn with its
 * groups and published services, and every word of a row is edited on that
 * category's own page. So the overview's regions are its hero (the eyebrow,
 * heading and introduction, which were source literals), its breadcrumbs, and
 * the list of categories, which is generated and says where each row is
 * edited (`docs/visual-editor/whole-site-coverage.md`, A.4).
 *
 * Pure: no connection, and no rows to read.
 */

/** Nothing to load: the overview's own wording lives on its regions. */
export type ServiceIndexData = { id: typeof SINGLETON_ID };

export const SERVICE_INDEX_REGIONS = [
  "serviceIndexHero",
  "serviceIndexCrumbs",
  "serviceIndexCategories",
] as const satisfies readonly RouteOwnerType[];

const SERVICE_INDEX_SET: ReadonlySet<RouteOwnerType> = new Set(SERVICE_INDEX_REGIONS);

export const documentOfServiceIndex = (): RouteDocument => ({ kind: "serviceIndex", id: SINGLETON_ID });

export const SERVICE_INDEX_PATH = "/services";

export const serviceIndexOwnersOf = (): RouteOwner[] => SERVICE_INDEX_REGIONS.map((type) => ({ type, id: SINGLETON_ID }));

export const serviceIndexOwnerBelongs = (owner: RouteOwner): boolean =>
  SERVICE_INDEX_SET.has(owner.type) && owner.id === SINGLETON_ID;

export const serviceIndexStoredValuesOf = (
  owner: RouteOwner,
  copy: Record<string, string> | null | undefined,
): Record<string, unknown> => rowStoredValues(owner.type, null, copy);

const REGION_WORDS: Partial<Record<RouteOwnerType, string>> = {
  serviceIndexHero: "Hero",
  serviceIndexCrumbs: "Breadcrumbs",
  serviceIndexCategories: "Service categories",
};

export const serviceIndexOwnerLabel = (owner: RouteOwner): string =>
  REGION_WORDS[owner.type] ?? `Region ${ownerKeyOf(owner)}`;

export const serviceIndexAdminHrefOf = (owner: RouteOwner): string | null =>
  owner.type === "serviceIndexCategories" ? "/admin/categories" : null;
