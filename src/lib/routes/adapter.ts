import "server-only";

import { eq, inArray } from "drizzle-orm";

import type { Executor } from "@/lib/db/revision";
import { faqs, serviceCategories, serviceSubcategories, services } from "@/lib/db/schema";

import {
  adminHrefOf,
  effectiveData,
  loadCategoryData,
  membersOf,
  ownerBelongs,
  ownerLabel,
  ownersOf,
  storedValuesOf,
  type CategoryData,
} from "./category";
import { ownerKeyOf, parseOwnerKey, type RouteDocument, type RouteKind, type RouteOwner, type RouteOwnerType } from "./owners";
import {
  effectiveServiceData,
  loadServiceData,
  serviceAdminHrefOf,
  serviceMemberName,
  serviceMembersOf,
  serviceOwnerBelongs,
  serviceOwnerLabel,
  serviceOwnersOf,
  servicePathOf,
  serviceRegionVisible,
  serviceStoredValuesOf,
  type ServiceData,
} from "./service";
import {
  applyOrder,
  describeStored,
  publishedValue,
  SPECS,
  specOf,
  type FieldSpec,
  type ListName,
  type StoredPatch,
} from "./specs";
import type { NodeRow } from "./store";

/**
 * One interface for every kind of dynamic route (Batch 22).
 *
 * Batch 21 built the dynamic-route machinery — drafts in `route_nodes`, a
 * reviewed and atomic publication, versions, compare, restore — around the
 * one route it opened. Batch 22 opens a second, a service's own page, and
 * rather than copy that machinery it is now written once, against this
 * interface, and each route kind supplies an adapter:
 *
 *   · what it loads, and what it holds while publishing (`load`);
 *   · which regions it draws and whether a region belongs (`owners`,
 *     `belongs`) — the IDOR check every action makes;
 *   · where a region's values live and what a draft makes them
 *     (`storedValues`, `members`, `effective`);
 *   · what they are called and where they are managed (`label`, `adminHref`,
 *     `describe`, `title`, `path`);
 *   · what publishing writes (`apply`) and which stored regions have lost
 *     their record (`existing`).
 *
 * Everything else — the field vocabulary (`specs.ts`), the draft store
 * (`store.ts`), the publication's guards and its version rows (`publish.ts`) —
 * is the same code for both, so a service page is published under exactly the
 * rules a category page is.
 *
 * Methods, not function-valued properties: a category adapter is used where
 * any route's adapter is expected, and only method parameters may be read
 * that way. The context always pairs an adapter with its own route's data.
 */

export type RouteData = CategoryData | ServiceData;

export type RouteOption = { value: string; label: string };

export interface RouteAdapter<D extends RouteData = RouteData> {
  readonly kind: RouteKind;
  load(on: Executor, id: number, options?: { lock?: boolean }): Promise<D | null>;
  owners(data: D): RouteOwner[];
  belongs(owner: RouteOwner, data: D): boolean;
  storedValues(owner: RouteOwner, data: D, copy: Record<string, string> | null | undefined): Record<string, unknown>;
  members(owner: RouteOwner, list: ListName | undefined, data: D): number[];
  effective(data: D, patches: ReadonlyMap<string, StoredPatch>): D;
  /** The groups a card may be filed under — the category's own; none on a service page. */
  groupIds(data: D): ReadonlySet<number>;
  label(owner: RouteOwner, data: D): string;
  adminHref(owner: RouteOwner, data: D): string | null;
  visible(owner: RouteOwner, effective: D): boolean;
  options(owner: RouteOwner, data: D): Record<string, RouteOption[]>;
  describe(spec: FieldSpec | undefined, value: unknown, data: D): string;
  title(data: D): string;
  path(data: D): string;
  published(data: D): boolean;
  /** The record the activity log files a change under. */
  entity(data: D): { type: "category" | "service"; id: number };
  /** Writes the patched columns of the patched rows, and the new orders — nothing else. */
  apply(tx: Executor, context: RouteContext<D>): Promise<void>;
  /** Of these owners — regions stored against this route but no longer drawn on it — the ones whose record still exists. */
  existing(tx: Executor, owners: RouteOwner[]): Promise<Set<string>>;
}

/**
 * One route as the Visual Editor sees it at one moment: the live rows, the
 * stored regions, every pending patch, and the rows with those patches laid
 * over them. Built the same way for an Inspector load, a save, a summary and
 * (locked) a publication, so none of them can come to a different idea of
 * what the draft says.
 */
export type RouteContext<D extends RouteData = RouteData> = {
  adapter: RouteAdapter<D>;
  document: RouteDocument;
  routeKey: string;
  data: D;
  owners: RouteOwner[];
  nodes: Map<string, NodeRow>;
  /** Each owner's published stored values. */
  live: Map<string, Record<string, unknown>>;
  /** Each owner's pending patch — entries that still ask for something. */
  patches: Map<string, StoredPatch>;
  /** The rows as the draft would make them. */
  effective: D;
};

/* -------------------------------------------------------------------------- */
/* Shared writing                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Assigns new sort positions to a list, in the order given, reusing the
 * positions those rows already hold so every row outside the list keeps its
 * place. Rows that shared one position are spread out from the lowest.
 */
export function positionsFor(ids: number[], current: Map<number, number>): Map<number, number> {
  const held = ids.map((id) => current.get(id) ?? 0).sort((a, b) => a - b);
  const distinct = new Set(held).size === held.length;
  const out = new Map<number, number>();
  ids.forEach((id, index) => out.set(id, distinct ? held[index]! : (held[0] ?? 0) + index));
  return out;
}

/** Row writes collected per row, so two regions writing one row write it once. */
class Writes {
  private readonly rows = new Map<string, Record<string, unknown>>();
  add(row: string, key: string, value: unknown) {
    const set = this.rows.get(row) ?? {};
    set[key] = value;
    this.rows.set(row, set);
  }
  entries() {
    return this.rows.entries();
  }
}

/** The ids of every owner of one type among some owners. */
const idsOf = (owners: RouteOwner[], ...types: RouteOwnerType[]) =>
  owners.filter((owner) => types.includes(owner.type)).map((owner) => owner.id);

async function existingIn(
  tx: Executor,
  table: typeof services | typeof faqs | typeof serviceSubcategories | typeof serviceCategories,
  ids: number[],
): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const rows = await tx.select({ id: table.id }).from(table).where(inArray(table.id, ids));
  return new Set(rows.map((row) => row.id));
}

/* -------------------------------------------------------------------------- */
/* The category route (Batch 21)                                              */
/* -------------------------------------------------------------------------- */

export const categoryAdapter: RouteAdapter<CategoryData> = {
  kind: "category",
  load: (on, id, options) => loadCategoryData(on, id, options),
  owners: (data) => ownersOf(data),
  belongs: (owner, data) => ownerBelongs(owner, data),
  storedValues: (owner, data, copy) => storedValuesOf(owner, data, copy),
  members: (owner, list, data) => membersOf(owner, list, data),
  effective: (data, patches) => effectiveData(data, patches),
  groupIds: (data) => new Set(data.groups.map((group) => group.id)),
  label: (owner, data) => ownerLabel(owner, data),
  adminHref: (owner, data) => adminHrefOf(owner, data),
  visible(owner, effective) {
    switch (owner.type) {
      case "subcategory":
        return effective.groups.find((row) => row.id === owner.id)?.isPublished !== false;
      case "service": {
        const row = effective.services.find((service) => service.id === owner.id);
        if (!row || !row.isPublished) return false;
        if (row.subcategoryId === null) return true;
        return effective.groups.find((group) => group.id === row.subcategoryId)?.isPublished === true;
      }
      case "faq":
        return effective.faqs.find((row) => row.id === owner.id)?.isPublished !== false;
      case "categoryBody":
        return Boolean(effective.category.bodyEn.trim() || effective.category.bodyAr.trim());
      case "categoryFaqs":
        return effective.faqs.some((row) => row.isPublished);
      default:
        return true;
    }
  },
  options(owner, data): Record<string, RouteOption[]> {
    if (owner.type !== "service") return {};
    return {
      group: [
        { value: "", label: "No group" },
        ...data.groups.map((group) => ({
          value: String(group.id),
          label: group.isPublished ? group.titleEn : `${group.titleEn} (hidden)`,
        })),
      ],
    };
  },
  describe: (spec, value, data) =>
    describeStored(spec, value, {
      group: (id) => data.groups.find((row) => row.id === id)?.titleEn ?? null,
      member: (list, id) =>
        list === "groups"
          ? (data.groups.find((row) => row.id === id)?.titleEn ?? null)
          : list === "faqs"
            ? (data.faqs.find((row) => row.id === id)?.questionEn ?? null)
            : (data.services.find((row) => row.id === id)?.titleEn ?? null),
    }),
  title: (data) => data.category.titleEn,
  path: (data) => `/services/${data.category.slug}`,
  published: (data) => data.category.isPublished,
  entity: (data) => ({ type: "category", id: data.category.id }),

  /** The patched columns of the patched rows, and the new orders — nothing else. */
  async apply(tx, context) {
    const now = new Date();
    const writes = new Writes();

    for (const [ownerKey, patch] of context.patches) {
      const owner = parseOwnerKey(ownerKey);
      if (!owner) continue;
      for (const [key, entry] of Object.entries(patch)) {
        if (key.startsWith("copy:") || key.startsWith("order:")) continue;
        const row =
          owner.type === "category" || owner.type === "categoryBody"
            ? "category"
            : owner.type === "subcategory"
              ? `group:${owner.id}`
              : owner.type === "service"
                ? `service:${owner.id}`
                : owner.type === "faq"
                  ? `faq:${owner.id}`
                  : null;
        if (row) writes.add(row, key, entry.value);
      }
    }

    /**
     * Orders, against the rows as the drafts leave them (`effective` already has
     * each list in its draft order). Positions are reassigned within each list
     * only, so a list nobody reordered is not touched.
     */
    const sortOf = new Map<string, number>();
    for (const row of context.data.groups) sortOf.set(`group:${row.id}`, row.sortOrder);
    for (const row of context.data.services) sortOf.set(`service:${row.id}`, row.sortOrder);
    for (const row of context.data.faqs) sortOf.set(`faq:${row.id}`, row.sortOrder);

    const reposition = (kind: "group" | "service" | "faq", ids: number[]) => {
      const current = new Map(ids.map((id) => [id, sortOf.get(`${kind}:${id}`) ?? 0]));
      for (const [id, position] of positionsFor(ids, current)) {
        if (position !== current.get(id)) writes.add(`${kind}:${id}`, "sortOrder", position);
      }
    };

    for (const [ownerKey, patch] of context.patches) {
      const owner = parseOwnerKey(ownerKey);
      if (!owner) continue;
      for (const spec of SPECS[owner.type]) {
        if (spec.check !== "order" || !patch[spec.key]) continue;
        const ids = applyOrder(patch[spec.key]!.value, membersOf(owner, spec.list, context.effective));
        reposition(spec.list === "groups" ? "group" : spec.list === "faqs" ? "faq" : "service", ids);
      }
    }

    for (const [row, set] of writes.entries()) {
      const values = { ...set, updatedAt: now };
      if (row === "category") {
        await tx.update(serviceCategories).set(values).where(eq(serviceCategories.id, context.data.category.id));
        continue;
      }
      const [kind, raw] = row.split(":");
      const id = Number(raw);
      if (kind === "group") await tx.update(serviceSubcategories).set(values).where(eq(serviceSubcategories.id, id));
      else if (kind === "service") await tx.update(services).set(values).where(eq(services.id, id));
      else if (kind === "faq") await tx.update(faqs).set(values).where(eq(faqs.id, id));
    }
  },

  async existing(tx, owners) {
    const out = new Set<string>();
    for (const id of await existingIn(tx, services, idsOf(owners, "service"))) out.add(`service:${id}`);
    for (const id of await existingIn(tx, faqs, idsOf(owners, "faq"))) out.add(`faq:${id}`);
    for (const id of await existingIn(tx, serviceSubcategories, idsOf(owners, "subcategory"))) out.add(`subcategory:${id}`);
    return out;
  },
};

/* -------------------------------------------------------------------------- */
/* A service's own page (Batch 22)                                            */
/* -------------------------------------------------------------------------- */

export const serviceAdapter: RouteAdapter<ServiceData> = {
  kind: "service",
  load: (on, id, options) => loadServiceData(on, id, options),
  owners: (data) => serviceOwnersOf(data),
  belongs: (owner, data) => serviceOwnerBelongs(owner, data),
  storedValues: (owner, data, copy) => serviceStoredValuesOf(owner, data, copy),
  members: (owner, list, data) => serviceMembersOf(owner, list, data),
  effective: (data, patches) => effectiveServiceData(data, patches),
  groupIds: () => new Set(),
  label: (owner, data) => serviceOwnerLabel(owner, data),
  adminHref: (owner, data) => serviceAdminHrefOf(owner, data),
  visible: (owner, effective) => serviceRegionVisible(owner, effective),
  options: () => ({}),
  describe: (spec, value, data) =>
    describeStored(spec, value, { group: () => null, member: (list, id) => serviceMemberName(data, list, id) }),
  title: (data) => data.service.titleEn,
  path: (data) => servicePathOf(data),
  // A visitor reaches the page only while both the service and its category are published.
  published: (data) => data.service.isPublished && data.category.isPublished,
  entity: (data) => ({ type: "service", id: data.service.id }),

  /**
   * The service row's patched columns — whichever regions patched them, in
   * one update — its own questions' patched columns, and the new order of
   * those questions. A list is written as the Services screen would write it:
   * without the rows that say nothing (`publishedValue`).
   */
  async apply(tx, context) {
    const now = new Date();
    const writes = new Writes();
    const serviceId = context.data.service.id;

    for (const [ownerKey, patch] of context.patches) {
      const owner = parseOwnerKey(ownerKey);
      if (!owner) continue;
      for (const [key, entry] of Object.entries(patch)) {
        if (key.startsWith("copy:") || key.startsWith("order:")) continue;
        const spec = specOf(owner.type, key);
        if (!spec) continue;
        if (owner.type === "faq") writes.add(`faq:${owner.id}`, key, entry.value);
        else if (owner.id === serviceId) writes.add("service", key, publishedValue(spec, entry.value));
      }
    }

    const order = context.patches.get(ownerKeyOf({ type: "serviceFaqs", id: serviceId }))?.["order:faqs"];
    if (order) {
      const ids = applyOrder(order.value, context.effective.faqs.map((faq) => faq.id));
      const current = new Map(context.data.faqs.map((faq) => [faq.id, faq.sortOrder]));
      for (const [id, position] of positionsFor(ids, current)) {
        if (position !== current.get(id)) writes.add(`faq:${id}`, "sortOrder", position);
      }
    }

    for (const [row, set] of writes.entries()) {
      const values = { ...set, updatedAt: now };
      if (row === "service") {
        await tx.update(services).set(values).where(eq(services.id, serviceId));
        continue;
      }
      const id = Number(row.split(":")[1]);
      await tx.update(faqs).set(values).where(eq(faqs.id, id));
    }
  },

  async existing(tx, owners) {
    const out = new Set<string>();
    for (const id of await existingIn(tx, faqs, idsOf(owners, "faq"))) out.add(`faq:${id}`);
    return out;
  },
};

const ADAPTERS: Record<RouteKind, RouteAdapter> = { category: categoryAdapter, service: serviceAdapter };

export const adapterOf = (kind: RouteKind): RouteAdapter => ADAPTERS[kind];

/** The owner types whose record a stored region names, by route kind — the ones that can be orphaned. */
export const RECORD_OWNERS: Record<RouteKind, readonly RouteOwnerType[]> = {
  category: ["service", "faq", "subcategory"],
  service: ["faq"],
};
