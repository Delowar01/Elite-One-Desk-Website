import { sanitizeHref, sanitizeRichText } from "@/lib/cms/sanitize";
import type { faqs, serviceCategories, serviceSubcategories, services } from "@/lib/db/schema";
import { isIconName } from "@/lib/icons";
import type { Locale } from "@/lib/i18n/config";

import { ORDER_KEY, ROUTE_BLOCK_OF } from "./blocks";
import { ownerKeyOf, type RouteDocument, type RouteOwner, type RouteOwnerType } from "./owners";
import { hasPackageHub } from "./package-hub";

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
 * Storage — the drafts, the presentation, publishing — is `store.ts` and
 * `publish.ts`; the database reads are `category.ts`. This module is pure: it
 * holds no connection and can be exercised without one.
 */

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

/** A field patch: the value an editor chose, and the live value it started from. */
export type PatchEntry = { value: unknown; base: unknown };
export type StoredPatch = Record<string, PatchEntry>;

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
  }
}

export const routeKeyOfCategory = (categoryId: number) => `category:${categoryId}`;
export const documentOfCategory = (categoryId: number): RouteDocument => ({ kind: "category", id: categoryId });

/* -------------------------------------------------------------------------- */
/* Fields                                                                     */
/* -------------------------------------------------------------------------- */

type Check = "text" | "rich" | "icon" | "media" | "link" | "flag" | "group" | "order";

/**
 * One stored value of one region.
 *
 * `key` is the storage key — the column's property name on the region's own
 * row, `copy:<name>` for template copy, `order:<list>` for the order of the
 * region's children — and is what a draft patch, a version snapshot and a
 * conflict are written in. `field` (and `locale`) is how the Inspector edits
 * it.
 */
export type FieldSpec = {
  key: string;
  field: string;
  locale?: Locale;
  check: Check;
  max?: number;
  /** The English title or question: never empty, as the admin forms require. */
  required?: boolean;
  /** Ordering, visibility and grouping are layout: `content.structure`, not `content.edit`. */
  structural?: boolean;
  label: string;
  /** For `order:` keys, which children the list orders. */
  list?: "groups" | "services" | "faqs";
};

const pair = (field: string, column: string, label: string, check: Check, max: number, required = false): FieldSpec[] => [
  { key: `${column}En`, field, locale: "en", check, max, required, label: `${label} (English)` },
  { key: `${column}Ar`, field, locale: "ar", check, max, label: `${label} (Arabic)` },
];

const copyPair = (field: string, label: string, max: number): FieldSpec[] => [
  { key: `copy:${field}En`, field, locale: "en", check: "text", max, label: `${label} (English)` },
  { key: `copy:${field}Ar`, field, locale: "ar", check: "text", max, label: `${label} (Arabic)` },
];

const order = (list: "groups" | "services" | "faqs", label: string): FieldSpec => ({
  key: `order:${list}`,
  field: ORDER_KEY,
  check: "order",
  structural: true,
  label,
  list,
});

/**
 * Every stored value of every region. The lengths are the admin forms' own
 * (`categories/actions.ts`, `services/actions.ts`, `faqs/actions.ts`), so a
 * value either surface accepts the other accepts too.
 */
export const SPECS: Record<RouteOwnerType, FieldSpec[]> = {
  category: [
    { key: "icon", field: "icon", check: "icon", label: "Icon" },
    ...pair("tagline", "tagline", "Tagline", "text", 255),
    ...pair("title", "title", "Title", "text", 190, true),
    ...pair("summary", "summary", "Summary", "text", 2000),
    { key: "imageId", field: "image", check: "media", label: "Background image" },
    ...pair("ctaLabel", "ctaLabel", "Primary button text", "text", 64),
    { key: "ctaHref", field: "ctaHref", check: "link", max: 255, label: "Primary button link" },
  ],
  categoryCrumbs: [],
  categoryBody: [...pair("body", "body", "Body", "rich", 20000)],
  categoryServices: [
    ...copyPair("eyebrow", "Eyebrow", 120),
    ...copyPair("heading", "Heading", 190),
    order("groups", "Order of groups"),
    order("services", "Order of services without a group"),
  ],
  subcategory: [
    ...pair("title", "title", "Title", "text", 190, true),
    ...pair("summary", "summary", "Summary", "text", 1000),
    { key: "isPublished", field: "published", check: "flag", structural: true, label: "Shown on the website" },
    order("services", "Order of services"),
  ],
  service: [
    ...pair("title", "title", "Title", "text", 190, true),
    ...pair("intro", "intro", "Short introduction", "text", 2000),
    { key: "imageId", field: "image", check: "media", label: "Card picture" },
    { key: "subcategoryId", field: "group", check: "group", structural: true, label: "Group" },
    { key: "isFeatured", field: "featured", check: "flag", label: "Featured" },
    { key: "isPublished", field: "published", check: "flag", structural: true, label: "Shown on the website" },
  ],
  categoryHub: [
    ...copyPair("eyebrow", "Eyebrow", 120),
    ...copyPair("heading", "Heading", 190),
    ...copyPair("description", "Description", 600),
    ...copyPair("ctaLabel", "Button text", 64),
  ],
  categoryFaqs: [...copyPair("eyebrow", "Eyebrow", 120), ...copyPair("heading", "Heading", 190), order("faqs", "Order of questions")],
  faq: [
    ...pair("question", "question", "Question", "text", 255, true),
    ...pair("answer", "answer", "Answer", "rich", 8000),
    { key: "isPublished", field: "published", check: "flag", structural: true, label: "Shown on the website" },
  ],
};

export const specOf = (type: RouteOwnerType, key: string): FieldSpec | undefined =>
  SPECS[type].find((spec) => spec.key === key);

/**
 * The resource capability an owner's content needs, beside `content.edit`.
 * The questions are the FAQ screen's; everything else on the page is the
 * category's, including its template copy.
 */
export const domainPermissionOf = (type: RouteOwnerType): "services.manage" | "faqs.manage" =>
  type === "faq" ? "faqs.manage" : "services.manage";

/** Which table an owner's columns live in, or null for copy-only regions. */
export function resourceOf(
  owner: RouteOwner,
): { kind: "category" | "subcategory" | "service" | "faq" | "template"; id: number } {
  switch (owner.type) {
    case "category":
    case "categoryBody":
      return { kind: "category", id: owner.id };
    case "subcategory":
      return { kind: "subcategory", id: owner.id };
    case "service":
      return { kind: "service", id: owner.id };
    case "faq":
      return { kind: "faq", id: owner.id };
    default:
      return { kind: "template", id: owner.id };
  }
}

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

/** Two stored values that mean the same thing. */
export const sameStored = (a: unknown, b: unknown): boolean => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Whether a list's draft order still agrees with how the live rows are
 * ordered: the ids both know about must stand in the same relative order. A
 * card added or removed elsewhere is not a disagreement; two people ordering
 * the same cards differently is.
 */
export function orderAgrees(base: unknown, live: unknown): boolean {
  const from = Array.isArray(base) ? (base as number[]) : [];
  const now = Array.isArray(live) ? (live as number[]) : [];
  const shared = new Set(from.filter((id) => now.includes(id)));
  return sameStored(
    from.filter((id) => shared.has(id)),
    now.filter((id) => shared.has(id)),
  );
}

/** Whether one patch entry's starting point still matches the live value. */
export function entryAgrees(spec: FieldSpec | undefined, entry: PatchEntry, live: unknown): boolean {
  if (spec?.check === "order") return orderAgrees(entry.base, live);
  return sameStored(entry.base, live);
}

/**
 * A patch with every entry that no longer asks for anything removed: one
 * whose value is what is live already. It is not pending and it is not in
 * conflict — both sides want the same thing.
 */
export function pendingPatch(
  owner: RouteOwner,
  patch: StoredPatch | null | undefined,
  live: Record<string, unknown>,
): StoredPatch {
  const out: StoredPatch = {};
  if (!patch) return out;
  for (const spec of SPECS[owner.type]) {
    const entry = patch[spec.key];
    if (!entry || typeof entry !== "object" || !("value" in entry)) continue;
    if (sameStored(entry.value, live[spec.key])) continue;
    out[spec.key] = { value: entry.value, base: entry.base };
  }
  return out;
}

/**
 * A list in the order a draft asks for, completed against who is actually in
 * it: listed members first, in the draft's order, then anybody the draft does
 * not mention, in their stored order. An id that is no longer a member is
 * dropped. So a draft order never hides a card and never invents one.
 */
export function applyOrder(wanted: unknown, members: number[]): number[] {
  const listed = Array.isArray(wanted) ? (wanted as unknown[]).filter((id): id is number => typeof id === "number") : [];
  const set = new Set(members);
  const seen = new Set<number>();
  const out: number[] = [];
  for (const id of listed) {
    if (set.has(id) && !seen.has(id)) {
      out.push(id);
      seen.add(id);
    }
  }
  for (const id of members) if (!seen.has(id)) out.push(id);
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

/**
 * Re-orders rows list by list, each list within the positions its own rows
 * already hold. A group's cards trade places with each other and never with
 * another group's, so everything that reads the whole array in order — the
 * structured data's item list — moves only as much as the draft asked.
 */
function placeInOrder<T>(
  rows: T[],
  bucketOf: (row: T) => string,
  rankOf: (row: T) => number | undefined,
): T[] {
  const out = [...rows];
  const buckets = new Map<string, { row: T; index: number; rank: number | undefined }[]>();
  rows.forEach((row, index) => {
    const key = bucketOf(row);
    const bucket = buckets.get(key) ?? [];
    bucket.push({ row, index, rank: rankOf(row) });
    buckets.set(key, bucket);
  });
  for (const bucket of buckets.values()) {
    if (!bucket.some((entry) => entry.rank !== undefined && entry.rank >= 0)) continue;
    const positions = bucket.map((entry) => entry.index);
    const ordered = [...bucket].sort(
      (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER) || a.index - b.index,
    );
    positions.forEach((position, i) => {
      out[position] = ordered[i]!.row;
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* The editor's values                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Stored values as the Inspector edits them: `{ en, ar }` for a localised
 * field, the library id for a picture, the group as a choice, and the child
 * orders under `_order`.
 */
export function valuesOf(type: RouteOwnerType, stored: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const orders: Record<string, number[]> = {};
  for (const spec of SPECS[type]) {
    const value = stored[spec.key];
    if (spec.check === "order") {
      orders[spec.list!] = Array.isArray(value) ? (value as number[]) : [];
      continue;
    }
    if (spec.locale) {
      const held = (out[spec.field] as Record<string, string> | undefined) ?? { en: "", ar: "" };
      out[spec.field] = { ...held, [spec.locale]: typeof value === "string" ? value : "" };
      continue;
    }
    switch (spec.check) {
      case "media":
        out[spec.field] = typeof value === "number" && value > 0 ? value : null;
        break;
      case "flag":
        out[spec.field] = value === true;
        break;
      case "group":
        out[spec.field] = typeof value === "number" && value > 0 ? String(value) : "";
        break;
      default:
        out[spec.field] = typeof value === "string" ? value : "";
    }
  }
  if (Object.keys(orders).length) out[ORDER_KEY] = orders;
  return out;
}

/** Why a submitted value cannot be stored, in a sentence for the Inspector. */
export type ReadProblem = { key: string; message: string };

/**
 * The Inspector's values read back into stored values, field by field, with
 * the admin forms' rules. Anything not declared is ignored; a value that
 * cannot be stored is a refusal naming the field, never a silent repair.
 *
 * `mediaIds` are the library ids the values name that exist — looked up by the
 * caller, in one query, so this function stays pure.
 */
export function readSubmitted(
  owner: RouteOwner,
  submitted: Record<string, unknown>,
  data: CategoryData,
  mediaIds: ReadonlySet<number>,
): { ok: true; stored: Record<string, unknown> } | { ok: false; problem: ReadProblem } {
  const out: Record<string, unknown> = {};
  const orders = (submitted[ORDER_KEY] ?? {}) as Record<string, unknown>;

  for (const spec of SPECS[owner.type]) {
    const raw = spec.check === "order" ? orders?.[spec.list!] : submitted[spec.field];
    const source = spec.locale
      ? typeof raw === "object" && raw !== null
        ? (raw as Record<string, unknown>)[spec.locale]
        : ""
      : raw;
    const text = typeof source === "string" ? source : "";

    switch (spec.check) {
      case "text": {
        const value = text.slice(0, spec.max ?? 400).trim();
        if (spec.required && !value) {
          return { ok: false, problem: { key: spec.key, message: `${spec.label} cannot be empty.` } };
        }
        out[spec.key] = value;
        break;
      }
      case "rich":
        out[spec.key] = sanitizeRichText(text.slice(0, spec.max ?? 20000));
        break;
      case "icon":
        if (!isIconName(text)) return { ok: false, problem: { key: spec.key, message: "That icon is not one of the site's icons." } };
        out[spec.key] = text;
        break;
      case "link": {
        const trimmed = text.slice(0, spec.max ?? 255).trim();
        const safe = sanitizeHref(trimmed);
        if (trimmed && !safe) {
          return {
            ok: false,
            problem: { key: spec.key, message: "Use a site path such as /contact, or a full https:// address." },
          };
        }
        out[spec.key] = safe;
        break;
      }
      case "media": {
        const id = typeof source === "number" ? source : Number.parseInt(String(source ?? ""), 10);
        if (!Number.isInteger(id) || id <= 0) {
          out[spec.key] = null;
          break;
        }
        if (!mediaIds.has(id)) {
          return { ok: false, problem: { key: spec.key, message: "That picture is no longer in the media library." } };
        }
        out[spec.key] = id;
        break;
      }
      case "flag":
        out[spec.key] = source === true;
        break;
      case "group": {
        const id = text ? Number(text) : null;
        if (id !== null && !data.groups.some((group) => group.id === id)) {
          return { ok: false, problem: { key: spec.key, message: "Choose a group from this category." } };
        }
        out[spec.key] = id;
        break;
      }
      case "order":
        out[spec.key] = Array.isArray(raw) ? (raw as unknown[]).filter((id): id is number => Number.isInteger(id)) : [];
        break;
    }
  }
  return { ok: true, stored: out };
}

/** The picture ids a submission names. */
export function mediaIdsIn(owner: RouteOwner, submitted: Record<string, unknown>): number[] {
  return SPECS[owner.type]
    .filter((spec) => spec.check === "media")
    .map((spec) => submitted[spec.field])
    .map((raw) => (typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10)))
    .filter((id) => Number.isInteger(id) && id > 0);
}

/**
 * The patch a save leaves: every value that differs from live, each with the
 * live value it started from. A value already in the patch keeps its original
 * starting point — that is what lets publishing notice a form edit made since
 * — and a value put back to what is live leaves the patch altogether.
 *
 * Orders are normalised against who is in the list *after* this draft, so a
 * stale list from an open editor can neither drop nor invent a child.
 */
export function nextPatch(
  owner: RouteOwner,
  previous: StoredPatch | null | undefined,
  live: Record<string, unknown>,
  stored: Record<string, unknown>,
  effective: CategoryData,
): StoredPatch {
  const out: StoredPatch = {};
  for (const spec of SPECS[owner.type]) {
    let value = stored[spec.key];
    if (spec.check === "order") value = applyOrder(value, membersOf(owner, spec.list, effective));
    if (sameStored(value, live[spec.key])) continue;
    const kept = previous?.[spec.key];
    out[spec.key] = { value, base: kept && "base" in kept ? kept.base : live[spec.key] };
  }
  return out;
}

/** The keys a save actually changes, measured against what the draft said before it. */
export function changedKeys(
  owner: RouteOwner,
  previous: StoredPatch,
  live: Record<string, unknown>,
  next: StoredPatch,
): FieldSpec[] {
  return SPECS[owner.type].filter((spec) => {
    const before = previous[spec.key] ? previous[spec.key]!.value : live[spec.key];
    const after = next[spec.key] ? next[spec.key]!.value : live[spec.key];
    return !sameStored(before, after);
  });
}

/** Fields whose draft began from a value that is no longer live. */
export type FieldConflict = { key: string; label: string; base: unknown; live: unknown; draft: unknown };

export function conflictsOf(owner: RouteOwner, patch: StoredPatch, live: Record<string, unknown>): FieldConflict[] {
  const out: FieldConflict[] = [];
  for (const spec of SPECS[owner.type]) {
    const entry = patch[spec.key];
    if (!entry) continue;
    if (entryAgrees(spec, entry, live[spec.key])) continue;
    out.push({ key: spec.key, label: spec.label, base: entry.base, live: live[spec.key], draft: entry.value });
  }
  return out;
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

export const blockTypeOf = (owner: RouteOwner): string => ROUTE_BLOCK_OF[owner.type];
