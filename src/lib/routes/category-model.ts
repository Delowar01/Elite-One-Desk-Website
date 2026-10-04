import type { faqs, serviceCategories, serviceSubcategories, services } from "@/lib/db/schema";

import { ownerKeyOf, type RouteDocument, type RouteOwner } from "./owners";
import { hasPackageHub } from "./package-hub";
import {
  applyOrder,
  nextPatchWith,
  placeInOrder,
  readSubmittedWith,
  SPECS,
  type FieldSpec,
  type ListName,
  type ReadProblem,
  type StoredPatch,
} from "./specs";

/**
 * The category route's adapter (Batch 21): everything the Visual Editor needs
 * to know about `/[lang]/services/[category]` and nothing it does not.
 *
 * It answers four questions, from the database rows alone — never from a slug,
 * so a category created tomorrow is editable the moment it exists:
 *
 *   1. **Which regions does this route draw?** `ownersOf` — the hero, the
 *      breadcrumbs, the body, the services section, one group per subcategory,
 *      one card per service, the packages panel where the route draws it, the
 *      questions section and one row per category FAQ.
 *   2. **Where does each field live?** `SPECS` — every editable field of every
 *      region, by storage key: a column of the region's own row, a piece of
 *      the route's template copy, or the order of the region's children.
 *   3. **What may be stored?** `readSubmitted` — the rules the resource's own
 *      admin form applies, applied again: the same lengths, the required
 *      English title, `sanitizeRichText`, the icon allowlist, the link rule, a
 *      picture that exists, a group from the same category.
 *   4. **What does a draft make it say?** `effectiveData` / `valuesOf` — the
 *      live rows with every pending patch laid over them, which is what the
 *      editor canvas and preview draw and what the Inspector edits.
 *
 * What a field *is* — its storage key, its check, how it is compared and
 * patched — is shared with every route adapter and lives in `specs.ts`
 * (Batch 22); it is re-exported here so this module is still the one import a
 * category caller needs. Storage — the drafts, the presentation, publishing —
 * is `store.ts` and `publish.ts`; the database reads are `category.ts`. This
 * module is pure: it holds no connection and can be exercised without one.
 */

export {
  applyOrder,
  blockTypeOf,
  changedKeys,
  conflictsOf,
  domainPermissionOf,
  entryAgrees,
  mediaIdsIn,
  orderAgrees,
  pendingPatch,
  resourceOf,
  sameStored,
  SPECS,
  specOf,
  valuesOf,
} from "./specs";
export type { FieldConflict, FieldSpec, PatchEntry, ReadProblem, StoredPatch } from "./specs";

export type CategoryRow = typeof serviceCategories.$inferSelect;
export type GroupRow = typeof serviceSubcategories.$inferSelect;
export type ServiceRow = typeof services.$inferSelect;
export type FaqRow = typeof faqs.$inferSelect;

/**
 * Everything the category route draws, **unpublished rows included**: the
 * editor shows a hidden card dimmed rather than not at all, because the only
 * way to show it again is to be able to select it.
 */
export type CategoryData = {
  category: CategoryRow;
  groups: GroupRow[];
  services: ServiceRow[];
  faqs: FaqRow[];
};

/* -------------------------------------------------------------------------- */
/* Regions                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The regions a category route draws, in page order.
 *
 * Derived from the rows, so the list is the same for every category: the
 * only conditional region is the packages panel, offered exactly where the
 * route renders it (`hasPackageHub`, shared with the page).
 */
export function ownersOf(data: CategoryData): RouteOwner[] {
  const id = data.category.id;
  const out: RouteOwner[] = [
    { type: "category", id },
    { type: "categoryCrumbs", id },
    { type: "categoryBody", id },
    { type: "categoryServices", id },
    ...data.groups.map((group) => ({ type: "subcategory" as const, id: group.id })),
    ...data.services.map((service) => ({ type: "service" as const, id: service.id })),
  ];
  if (hasPackageHub(data.category)) out.push({ type: "categoryHub", id });
  out.push({ type: "categoryFaqs", id });
  out.push(...data.faqs.map((faq) => ({ type: "faq" as const, id: faq.id })));
  return out;
}

/** Whether an owner is drawn on this category's route. The IDOR check every action makes. */
export function ownerBelongs(owner: RouteOwner, data: CategoryData): boolean {
  switch (owner.type) {
    case "category":
    case "categoryCrumbs":
    case "categoryBody":
    case "categoryServices":
    case "categoryFaqs":
      return owner.id === data.category.id;
    case "categoryHub":
      return owner.id === data.category.id && hasPackageHub(data.category);
    case "subcategory":
      return data.groups.some((group) => group.id === owner.id);
    case "service":
      return data.services.some((service) => service.id === owner.id);
    case "faq":
      return data.faqs.some((faq) => faq.id === owner.id);
    default:
      // A service page's region (Batch 22) is never drawn on a category route.
      return false;
  }
}

export const routeKeyOfCategory = (categoryId: number) => `category:${categoryId}`;
export const documentOfCategory = (categoryId: number): RouteDocument => ({ kind: "category", id: categoryId });

/* -------------------------------------------------------------------------- */
/* Live values, and the draft laid over them                                  */
/* -------------------------------------------------------------------------- */

/** The row an owner's columns are read from, or null for a copy-only region. */
function rowOf(owner: RouteOwner, data: CategoryData): Record<string, unknown> | null {
  switch (owner.type) {
    case "category":
    case "categoryBody":
      return data.category as unknown as Record<string, unknown>;
    case "subcategory":
      return (data.groups.find((row) => row.id === owner.id) as unknown as Record<string, unknown>) ?? null;
    case "service":
      return (data.services.find((row) => row.id === owner.id) as unknown as Record<string, unknown>) ?? null;
    case "faq":
      return (data.faqs.find((row) => row.id === owner.id) as unknown as Record<string, unknown>) ?? null;
    default:
      return null;
  }
}

/** The members of one ordered list, in their stored order. */
export function membersOf(owner: RouteOwner, list: FieldSpec["list"], data: CategoryData): number[] {
  if (owner.type === "categoryServices" && list === "groups") return data.groups.map((group) => group.id);
  if (owner.type === "categoryServices" && list === "services") {
    return data.services.filter((service) => service.subcategoryId === null).map((service) => service.id);
  }
  if (owner.type === "subcategory" && list === "services") {
    return data.services.filter((service) => service.subcategoryId === owner.id).map((service) => service.id);
  }
  if (owner.type === "categoryFaqs" && list === "faqs") return data.faqs.map((faq) => faq.id);
  return [];
}

/**
 * One owner's stored values, by storage key, as `data` has them. With live
 * rows this is the published state; with `effectiveData` it is the draft.
 */
export function storedValuesOf(
  owner: RouteOwner,
  data: CategoryData,
  copy: Record<string, string> | null | undefined,
): Record<string, unknown> {
  const row = rowOf(owner, data);
  const out: Record<string, unknown> = {};
  for (const spec of SPECS[owner.type]) {
    if (spec.key.startsWith("copy:")) {
      const value = copy?.[spec.key.slice(5)];
      out[spec.key] = typeof value === "string" ? value : "";
    } else if (spec.check === "order") {
      out[spec.key] = membersOf(owner, spec.list, data);
    } else {
      out[spec.key] = row ? (row[spec.key] ?? null) : null;
    }
  }
  return out;
}

/**
 * The route's rows with every pending column patch applied, and the draft
 * orders applied after that — the state the editor canvas and preview draw.
 *
 * Column patches come first because they decide membership: a card moved to
 * another group by its own draft is ordered within the group it is moving to.
 */
export function effectiveData(data: CategoryData, patches: ReadonlyMap<string, StoredPatch>): CategoryData {
  const patchRow = <T extends object>(row: T, owner: RouteOwner): T => {
    const patch = patches.get(ownerKeyOf(owner));
    if (!patch) return row;
    const next = { ...row } as Record<string, unknown>;
    for (const spec of SPECS[owner.type]) {
      if (spec.key.startsWith("copy:") || spec.check === "order") continue;
      const entry = patch[spec.key];
      if (entry) next[spec.key] = entry.value;
    }
    return next as unknown as T;
  };

  let category = patchRow(data.category, { type: "category", id: data.category.id });
  category = patchRow(category, { type: "categoryBody", id: data.category.id });
  const groups = data.groups.map((group) => patchRow(group, { type: "subcategory", id: group.id }));
  const serviceRows = data.services.map((service) => patchRow(service, { type: "service", id: service.id }));
  const faqRows = data.faqs.map((faq) => patchRow(faq, { type: "faq", id: faq.id }));
  const patched: CategoryData = { category, groups, services: serviceRows, faqs: faqRows };

  // Orders, against the patched membership.
  const orderFor = (owner: RouteOwner, list: FieldSpec["list"]): number[] | null => {
    const wanted = patches.get(ownerKeyOf(owner))?.[`order:${list}`]?.value;
    return wanted === undefined ? null : applyOrder(wanted, membersOf(owner, list, patched));
  };
  const categoryId = data.category.id;
  const groupOrder = orderFor({ type: "categoryServices", id: categoryId }, "groups");
  const looseOrder = orderFor({ type: "categoryServices", id: categoryId }, "services");
  const cardOrders = new Map(groups.map((group) => [group.id, orderFor({ type: "subcategory", id: group.id }, "services")]));
  const faqOrder = orderFor({ type: "categoryFaqs", id: categoryId }, "faqs");

  return {
    category,
    groups: placeInOrder(groups, () => "all", (row) => groupOrder?.indexOf(row.id)),
    services: placeInOrder(
      serviceRows,
      (row) => String(row.subcategoryId ?? "none"),
      (row) => (row.subcategoryId === null ? looseOrder : (cardOrders.get(row.subcategoryId) ?? null))?.indexOf(row.id),
    ),
    faqs: placeInOrder(faqRows, () => "all", (row) => faqOrder?.indexOf(row.id)),
  };
}

/* -------------------------------------------------------------------------- */
/* The editor's values                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The Inspector's values read back into stored values with the admin forms'
 * rules (`specs.ts`), a group from this category being the one rule only the
 * route can answer.
 */
export function readSubmitted(
  owner: RouteOwner,
  submitted: Record<string, unknown>,
  data: CategoryData,
  mediaIds: ReadonlySet<number>,
): { ok: true; stored: Record<string, unknown> } | { ok: false; problem: ReadProblem } {
  return readSubmittedWith(owner, submitted, { mediaIds, groupIds: new Set(data.groups.map((group) => group.id)) });
}

/**
 * The patch a save leaves (`specs.ts`), with orders normalised against who is
 * in each list after the route's drafts — `effective`.
 */
export function nextPatch(
  owner: RouteOwner,
  previous: StoredPatch | null | undefined,
  live: Record<string, unknown>,
  stored: Record<string, unknown>,
  effective: CategoryData,
): StoredPatch {
  return nextPatchWith(owner, previous, live, stored, (list: ListName | undefined) => membersOf(owner, list, effective));
}

/* -------------------------------------------------------------------------- */
/* Naming                                                                     */
/* -------------------------------------------------------------------------- */

const quoted = (value: string) => `“${value.length > 48 ? `${value.slice(0, 47).trimEnd()}…` : value}”`;

/** What an owner is, in words: "Service “Hotel Reservation”". */
export function ownerLabel(owner: RouteOwner, data: CategoryData): string {
  switch (owner.type) {
    case "category":
      return `Hero of ${quoted(data.category.titleEn)}`;
    case "categoryCrumbs":
      return "Breadcrumbs";
    case "categoryBody":
      return "Category body";
    case "categoryServices":
      return "Services section";
    case "categoryHub":
      return "Tour packages panel";
    case "categoryFaqs":
      return "Questions section";
    case "subcategory": {
      const row = data.groups.find((group) => group.id === owner.id);
      return row ? `Group ${quoted(row.titleEn)}` : `Group #${owner.id}`;
    }
    case "service": {
      const row = data.services.find((service) => service.id === owner.id);
      return row ? `Service ${quoted(row.titleEn)}` : `Service #${owner.id}`;
    }
    case "faq": {
      const row = data.faqs.find((faq) => faq.id === owner.id);
      return row ? `Question ${quoted(row.questionEn)}` : `Question #${owner.id}`;
    }
    default:
      return `Region ${ownerKeyOf(owner)}`;
  }
}

/** The admin screen that owns the resource, for "where does this come from". */
export function adminHrefOf(owner: RouteOwner, data: CategoryData): string | null {
  switch (owner.type) {
    case "category":
    case "categoryBody":
    case "subcategory":
      // Groups are managed on their category's screen.
      return `/admin/categories/${data.category.id}`;
    case "service":
      return `/admin/services/${owner.id}`;
    case "faq":
      return "/admin/faqs";
    default:
      return null;
  }
}
