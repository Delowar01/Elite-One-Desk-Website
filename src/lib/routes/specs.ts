import { sanitizeHref, sanitizeRichText, toPlainText } from "@/lib/cms/sanitize";
import { isIconName } from "@/lib/icons";
import type { Locale } from "@/lib/i18n/config";

import { ORDER_KEY, ROUTE_BLOCK_OF } from "./blocks";
import type { RouteOwner, RouteOwnerType } from "./owners";

/**
 * What every route region stores, and the rules for reading, comparing and
 * patching it (Batch 21, shared by every route adapter since Batch 22).
 *
 * A route adapter knows one kind of route — which regions it draws, which rows
 * their columns live on, how its lists are ordered. What a *field* is does not
 * depend on the route: a title is a title, a picture is a library id, a list
 * of benefits is a list, on a category page or a service page. So the field
 * vocabulary lives here once, and both adapters — `category-model.ts` and
 * `service-model.ts` — read it. Pure: no connection, no request.
 */

/** A field patch: the value an editor chose, and the live value it started from. */
export type PatchEntry = { value: unknown; base: unknown };
export type StoredPatch = Record<string, PatchEntry>;

/**
 * How a value is read and checked.
 *
 * `items` and `steps` (Batch 22) are a service's lists: `[{ en, ar }]` and
 * `[{ en, ar, detailEn, detailAr }]`, stored exactly as the Services screen
 * stores them. They carry no item identity — the service record has none to
 * give — so a list is one value, edited whole in the Inspector.
 */
export type Check = "text" | "rich" | "icon" | "media" | "link" | "flag" | "group" | "order" | "items" | "steps";

export type ListName = "groups" | "services" | "faqs";

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
  /** Text: the most characters kept. A list: the most per item (steps: per title). */
  max?: number;
  /** A list: the most items kept, as the Services screen keeps them. */
  rows?: number;
  /** Steps: the most characters of each step's detail. */
  detailMax?: number;
  /** The English title or question: never empty, as the admin forms require. */
  required?: boolean;
  /** Ordering, visibility and grouping are layout: `content.structure`, not `content.edit`. */
  structural?: boolean;
  label: string;
  /** For `order:` keys, which children the list orders. */
  list?: ListName;
};

const pair = (field: string, column: string, label: string, check: Check, max: number, required = false): FieldSpec[] => [
  { key: `${column}En`, field, locale: "en", check, max, required, label: `${label} (English)` },
  { key: `${column}Ar`, field, locale: "ar", check, max, label: `${label} (Arabic)` },
];

const copyPair = (field: string, label: string, max: number): FieldSpec[] => [
  { key: `copy:${field}En`, field, locale: "en", check: "text", max, label: `${label} (English)` },
  { key: `copy:${field}Ar`, field, locale: "ar", check: "text", max, label: `${label} (Arabic)` },
];

const order = (list: ListName, label: string): FieldSpec => ({
  key: `order:${list}`,
  field: ORDER_KEY,
  check: "order",
  structural: true,
  label,
  list,
});

/**
 * A plain `{ en, ar }` list: 16 items of at most 400 characters by default —
 * the Services screen's limits; a package's highlights keep the Packages
 * screen's 300 (Batch 24).
 */
const items = (column: string, label: string, max = 400): FieldSpec => ({
  key: column,
  field: column,
  check: "items",
  max,
  rows: 16,
  label,
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

  /*
   * A service's own page (Batch 22). The columns and their limits are the
   * Services screen's. The headings, the request button's wording and the
   * request form's two lines are template copy — words that belong to this
   * page's sales message and had no home before — each empty by default,
   * which means "the site's standard wording, in each language". A service's
   * slug, category, group, request-form preset, featured flag and visibility
   * are deliberately absent: they are identity and structure, managed on the
   * Services screen and on the category page's card.
   */
  serviceHero: [
    ...pair("title", "title", "Title", "text", 190, true),
    ...pair("intro", "intro", "Short introduction", "text", 2000),
    ...pair("timeline", "timeline", "Indicative timeline", "text", 190),
    { key: "imageId", field: "image", check: "media", label: "Picture" },
    ...copyPair("ctaLabel", "Request button text", 64),
  ],
  serviceCrumbs: [],
  serviceOverview: [...copyPair("heading", "Heading", 190), ...pair("body", "body", "Overview", "rich", 20000)],
  serviceBenefits: [...copyPair("heading", "Heading", 190), items("benefits", "Key benefits")],
  serviceAudience: [...copyPair("heading", "Heading", 190), items("audience", "Who this is for")],
  serviceRequirements: [...copyPair("heading", "Heading", 190), items("requirements", "Documents and requirements")],
  serviceProcess: [
    ...copyPair("heading", "Heading", 190),
    // The Services screen keeps ten steps: a title of 200 characters, a detail of 800.
    { key: "processSteps", field: "steps", check: "steps", max: 200, detailMax: 800, rows: 10, label: "Steps" },
  ],
  serviceNotes: [...copyPair("heading", "Heading", 190), ...pair("notes", "notes", "Important notes", "rich", 8000)],
  serviceFaqs: [...copyPair("heading", "Heading", 190), order("faqs", "Order of this service's questions")],
  serviceNotices: [],
  serviceRequest: [...copyPair("heading", "Heading", 190), ...copyPair("intro", "Introduction", 300)],
  serviceRelated: [...copyPair("heading", "Heading", 190)],

  /*
   * A package's own page (Batch 24). The columns and their limits are the
   * Packages screen's (`packages/actions.ts`). The package's slug, legacy
   * region, destination, featured flag, visibility and order are absent on
   * purpose: identity and structure, kept on the Packages screen and on the
   * catalogue's card. "Place" is the free-text label beside the map pin
   * (`destination_en` / `_ar`) — not the destination the package is filed
   * under, which is `destinationId`.
   */
  packageHero: [
    ...pair("title", "title", "Title", "text", 190, true),
    ...pair("place", "destination", "Place", "text", 120),
    ...pair("duration", "duration", "Duration", "text", 80),
    ...pair("summary", "summary", "Summary", "text", 2000),
    { key: "imageId", field: "image", check: "media", label: "Picture" },
    ...copyPair("ctaLabel", "Request button text", 64),
  ],
  packageCrumbs: [],
  packageBody: [...pair("body", "body", "Description", "rich", 20000)],
  packageHighlights: [...copyPair("heading", "Heading", 190), items("highlights", "Highlights", 300)],
  packageRequest: [...copyPair("heading", "Heading", 190), ...copyPair("intro", "Introduction", 300)],

  /* A destination's own page (Batch 24): the Destinations screen's columns and limits. */
  destinationHero: [
    ...copyPair("eyebrow", "Eyebrow", 120),
    ...pair("title", "title", "Title", "text", 190, true),
    ...pair("summary", "summary", "Summary", "text", 2000),
    { key: "imageId", field: "image", check: "media", label: "Picture" },
  ],
  destinationCrumbs: [],
  destinationPackages: [...copyPair("backLabel", "Link back text", 64)],

  /*
   * The catalogue, `/packages` (Batch 24). A group is its destination: its
   * title is the destination's own column. A card is its package's: the same
   * columns as the package's page, plus the structure a service card offers —
   * which destination it is filed under, featured, and shown or hidden.
   */
  packageIndexHero: [
    ...copyPair("eyebrow", "Eyebrow", 120),
    ...copyPair("heading", "Heading", 190),
    ...copyPair("intro", "Introduction", 600),
  ],
  packageIndexCrumbs: [],
  packageIndexCatalogue: [],
  destinationGroup: [...pair("title", "title", "Destination name", "text", 190, true), ...copyPair("linkLabel", "Link text", 64)],
  packageCard: [
    ...pair("title", "title", "Title", "text", 190, true),
    ...pair("place", "destination", "Place", "text", 120),
    ...pair("duration", "duration", "Duration", "text", 80),
    ...pair("summary", "summary", "Summary", "text", 2000),
    { key: "imageId", field: "image", check: "media", label: "Card picture" },
    { key: "destinationId", field: "group", check: "group", structural: true, label: "Destination" },
    { key: "isFeatured", field: "featured", check: "flag", label: "Featured" },
    { key: "isPublished", field: "published", check: "flag", structural: true, label: "Shown on the website" },
  ],
  packageIndexCustom: [...copyPair("heading", "Heading", 190), ...copyPair("intro", "Introduction", 600)],

  /* The services overview, `/services` (Batch 24): its own wording only; every row is a category's. */
  serviceIndexHero: [
    ...copyPair("eyebrow", "Eyebrow", 120),
    ...copyPair("heading", "Heading", 190),
    ...copyPair("intro", "Introduction", 600),
  ],
  serviceIndexCrumbs: [],
  serviceIndexCategories: [],
};

export const specOf = (type: RouteOwnerType, key: string): FieldSpec | undefined =>
  SPECS[type].find((spec) => spec.key === key);

export const blockTypeOf = (owner: RouteOwner): string => ROUTE_BLOCK_OF[owner.type];

/** The record an owner's columns live on; `template` for a region that holds only its route's own wording. */
export type RouteResource = {
  kind: "category" | "subcategory" | "service" | "faq" | "package" | "destination" | "template";
  id: number;
};

/** Which record an owner edits. A service's page regions all edit the service's own row (Batch 22). */
export function resourceOf(owner: RouteOwner): RouteResource {
  switch (owner.type) {
    case "category":
    case "categoryBody":
      return { kind: "category", id: owner.id };
    case "subcategory":
      return { kind: "subcategory", id: owner.id };
    case "service":
    case "serviceHero":
    case "serviceOverview":
    case "serviceBenefits":
    case "serviceAudience":
    case "serviceRequirements":
    case "serviceProcess":
    case "serviceNotes":
      return { kind: "service", id: owner.id };
    case "faq":
      return { kind: "faq", id: owner.id };
    case "packageHero":
    case "packageBody":
    case "packageHighlights":
    case "packageCard":
      return { kind: "package", id: owner.id };
    case "destinationHero":
    case "destinationGroup":
      return { kind: "destination", id: owner.id };
    default:
      return { kind: "template", id: owner.id };
  }
}

/** The capability that owns a region's record, beside the editor's own (`content.edit`, …). */
export type RouteDomain = "services.manage" | "faqs.manage" | "packages.manage";

/** Every region of a package's page, a destination's page and the catalogue (Batch 24). */
const PACKAGE_DOMAIN: ReadonlySet<RouteOwnerType> = new Set<RouteOwnerType>([
  "packageHero",
  "packageCrumbs",
  "packageBody",
  "packageHighlights",
  "packageRequest",
  "destinationHero",
  "destinationCrumbs",
  "destinationPackages",
  "packageIndexHero",
  "packageIndexCrumbs",
  "packageIndexCatalogue",
  "destinationGroup",
  "packageCard",
  "packageIndexCustom",
]);

/**
 * The resource capability an owner's content needs, beside `content.edit`.
 * The questions are the FAQ screen's; a package, a destination, the
 * catalogue and their wording are the Packages screens' (Batch 24);
 * everything else on a route — a category, its groups and cards, a service
 * and its page, the services overview, and their template copy — is the
 * services screens'.
 */
export const domainPermissionOf = (type: RouteOwnerType): RouteDomain =>
  type === "faq" ? "faqs.manage" : PACKAGE_DOMAIN.has(type) ? "packages.manage" : "services.manage";

/* -------------------------------------------------------------------------- */
/* Comparing                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A value written so that two equal values are written the same way.
 *
 * Object keys are sorted, because a value that went through `jsonb` comes back
 * with its keys in PostgreSQL's order, not the order they were written in: a
 * list item saved as `{ en, ar }` is read as `{ ar, en }`. Arrays keep their
 * order — an order *is* the value there.
 */
const canonical = (value: unknown): string =>
  JSON.stringify(value ?? null, (_key, raw) =>
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? Object.fromEntries(Object.keys(raw as Record<string, unknown>).sort().map((key) => [key, (raw as Record<string, unknown>)[key]]))
      : raw,
  );

/** Two stored values that mean the same thing. */
export const sameStored = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

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
 * Re-orders rows list by list, each list within the positions its own rows
 * already hold. A group's cards trade places with each other and never with
 * another group's, so everything that reads the whole array in order — the
 * structured data's item list — moves only as much as the draft asked.
 */
export function placeInOrder<T>(
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
/* Lists (Batch 22)                                                           */
/* -------------------------------------------------------------------------- */

export type ListItem = { en: string; ar: string };
export type ListStep = { en: string; ar: string; detailEn: string; detailAr: string };

const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** A stored list read tolerantly, in one fixed shape: nothing that is not a string survives. */
export function listItemsOf(value: unknown): ListItem[] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const source = (typeof row === "object" && row !== null ? row : {}) as Record<string, unknown>;
    return { en: text(source.en), ar: text(source.ar) };
  });
}

export function listStepsOf(value: unknown): ListStep[] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => {
    const source = (typeof row === "object" && row !== null ? row : {}) as Record<string, unknown>;
    return { en: text(source.en), ar: text(source.ar), detailEn: text(source.detailEn), detailAr: text(source.detailAr) };
  });
}

/**
 * A list as it is published: without the rows that say nothing.
 *
 * The Inspector keeps an empty row while it is being written — the "Add"
 * button makes one, and a save in the middle of filling it in must not take
 * it away — so a draft may hold one. What is written live is what the Services
 * screen would write: a row whose English and Arabic are both empty is
 * dropped (for a step, its title in both languages).
 */
export function publishedValue(spec: FieldSpec | undefined, value: unknown): unknown {
  if (spec?.check === "items") return listItemsOf(value).filter((row) => row.en.trim() || row.ar.trim());
  if (spec?.check === "steps") return listStepsOf(value).filter((row) => row.en.trim() || row.ar.trim());
  return value;
}

/* -------------------------------------------------------------------------- */
/* The editor's values                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Stored values as the Inspector edits them: `{ en, ar }` for a localised
 * field, the library id for a picture, the group as a choice, a list as rows
 * of `{ en, ar }` pairs, and the child orders under `_order`.
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
      case "items":
        out[spec.field] = listItemsOf(value).map((row) => ({ text: { en: row.en, ar: row.ar } }));
        break;
      case "steps":
        out[spec.field] = listStepsOf(value).map((row) => ({
          title: { en: row.en, ar: row.ar },
          detail: { en: row.detailEn, ar: row.detailAr },
        }));
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

/** What reading a submission needs from the route: which pictures exist, which groups are its own. */
export type ReadContext = { mediaIds: ReadonlySet<number>; groupIds: ReadonlySet<number> };

const pairOf = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const clip = (value: unknown, max: number): string => (typeof value === "string" ? value : "").slice(0, max).trim();

/**
 * The Inspector's values read back into stored values, field by field, with
 * the admin forms' rules. Anything not declared is ignored; a value that
 * cannot be stored is a refusal naming the field, never a silent repair.
 *
 * `mediaIds` are the library ids the values name that exist — looked up by the
 * caller, in one query, so this function stays pure.
 */
export function readSubmittedWith(
  owner: RouteOwner,
  submitted: Record<string, unknown>,
  context: ReadContext,
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
        if (!context.mediaIds.has(id)) {
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
        if (id !== null && !context.groupIds.has(id)) {
          const message = spec.key === "destinationId" ? "Choose one of the destinations." : "Choose a group from this category.";
          return { ok: false, problem: { key: spec.key, message } };
        }
        out[spec.key] = id;
        break;
      }
      case "order":
        out[spec.key] = Array.isArray(raw) ? (raw as unknown[]).filter((id): id is number => Number.isInteger(id)) : [];
        break;
      case "items": {
        // Rows as the Services screen reads them: trimmed, clipped, at most
        // `rows` of them. An empty row is kept while it is being written; it is
        // dropped when the list is published (`publishedValue`).
        const rows = Array.isArray(raw) ? (raw as unknown[]) : [];
        out[spec.key] = rows.slice(0, spec.rows ?? 16).map((row) => {
          const words = pairOf(pairOf(row).text);
          return { en: clip(words.en, spec.max ?? 400), ar: clip(words.ar, spec.max ?? 400) };
        });
        break;
      }
      case "steps": {
        const rows = Array.isArray(raw) ? (raw as unknown[]) : [];
        out[spec.key] = rows.slice(0, spec.rows ?? 10).map((row) => {
          const title = pairOf(pairOf(row).title);
          const detail = pairOf(pairOf(row).detail);
          return {
            en: clip(title.en, spec.max ?? 200),
            ar: clip(title.ar, spec.max ?? 200),
            detailEn: clip(detail.en, spec.detailMax ?? 800),
            detailAr: clip(detail.ar, spec.detailMax ?? 800),
          };
        });
        break;
      }
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
 * Orders are normalised against who is in the list *after* this draft
 * (`membersOf`), so a stale list from an open editor can neither drop nor
 * invent a child.
 */
export function nextPatchWith(
  owner: RouteOwner,
  previous: StoredPatch | null | undefined,
  live: Record<string, unknown>,
  stored: Record<string, unknown>,
  membersOf: (list: ListName | undefined) => number[],
  /**
   * What the editor's buffer showed for each field when it began (Batch 23).
   * A field newly drafted from a buffer older than the record starts from the
   * value the editor saw, so its publication meets the newer one as a
   * conflict rather than writing over it. Orders keep starting from live:
   * their membership can move without anybody editing them.
   */
  startedFrom?: Record<string, unknown>,
): StoredPatch {
  const out: StoredPatch = {};
  for (const spec of SPECS[owner.type]) {
    let value = stored[spec.key];
    if (spec.check === "order") value = applyOrder(value, membersOf(spec.list));
    if (sameStored(value, live[spec.key])) continue;
    const kept = previous?.[spec.key];
    const start = spec.check !== "order" && startedFrom && spec.key in startedFrom ? startedFrom[spec.key] : live[spec.key];
    out[spec.key] = { value, base: kept && "base" in kept ? kept.base : start };
  }
  return out;
}

/**
 * A submission with every field the editor did not change put back to what
 * the server holds now (Batch 23).
 *
 * `base` is what the editor's buffer was last reconciled with, read the same
 * way as the submission. A field equal to it was not edited in this buffer,
 * so its value says nothing new: it becomes the draft's value if the field is
 * drafted, otherwise the record's. Without this, a buffer opened before the
 * Services screen changed the record sent the old value back, `nextPatchWith`
 * took it for an edit — it differed from live — and the next publication put
 * it back, silently. A field the editor did change is left exactly as sent.
 */
export function withUntouchedFromServer(
  owner: RouteOwner,
  stored: Record<string, unknown>,
  base: Record<string, unknown>,
  previous: StoredPatch | null | undefined,
  live: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...stored };
  for (const spec of SPECS[owner.type]) {
    if (!(spec.key in stored) || !(spec.key in base)) continue;
    if (!sameStored(stored[spec.key], base[spec.key])) continue;
    const kept = previous?.[spec.key];
    if (kept && "value" in kept) out[spec.key] = kept.value;
    else if (spec.key in live) out[spec.key] = live[spec.key];
  }
  return out;
}

/**
 * The fields whose value the editor began from is no longer what the server
 * would show it (Batch 23) — both read the same way, so a column merely stored
 * unnormalised does not count. Only these start a draft from the editor's
 * value (`nextPatchWith`'s `startedFrom`); every other field starts from live
 * exactly as before.
 */
export function staleStartingPoints(
  owner: RouteOwner,
  began: Record<string, unknown>,
  now: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const spec of SPECS[owner.type]) {
    if (spec.key in began && spec.key in now && !sameStored(began[spec.key], now[spec.key])) out[spec.key] = began[spec.key];
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
/* Checking a stored value again                                              */
/* -------------------------------------------------------------------------- */

const listShapeProblem = (spec: FieldSpec, value: unknown): string | null => {
  if (!Array.isArray(value) || value.length > (spec.rows ?? 16)) return `${spec.label} is not a valid list.`;
  const strings = spec.check === "steps" ? ["en", "ar", "detailEn", "detailAr"] : ["en", "ar"];
  for (const row of value) {
    if (typeof row !== "object" || row === null || Array.isArray(row)) return `${spec.label} is not a valid list.`;
    for (const name of strings) {
      const part = (row as Record<string, unknown>)[name];
      const limit = name.startsWith("detail") ? (spec.detailMax ?? 800) : (spec.max ?? 400);
      if (typeof part !== "string" || part.length > limit) return `${spec.label} is not a valid list.`;
    }
  }
  return null;
};

/**
 * Whether a value a draft holds may still be published.
 *
 * Every value was checked when it was saved; it is checked again here because
 * a draft can outlive the thing it refers to — a picture deleted from the
 * library, a group deleted from the category — and because a publication is
 * the last point at which a wrong value can be kept off the live page.
 */
export function storedProblem(
  spec: FieldSpec,
  value: unknown,
  groupIds: ReadonlySet<number>,
  mediaIds: ReadonlySet<number>,
): string | null {
  switch (spec.check) {
    case "text":
      if (typeof value !== "string" || value.length > (spec.max ?? 400)) return `${spec.label} is not valid text.`;
      if (spec.required && !value.trim()) return `${spec.label} cannot be empty.`;
      return null;
    case "rich":
      return typeof value === "string" && value.length <= (spec.max ?? 20000) && sanitizeRichText(value) === value
        ? null
        : `${spec.label} is not valid text.`;
    case "icon":
      return typeof value === "string" && isIconName(value) ? null : `${spec.label} is not one of the site's icons.`;
    case "link":
      return typeof value === "string" && (value === "" || sanitizeHref(value) === value)
        ? null
        : `${spec.label} is not an allowed link.`;
    case "media":
      return value === null || (typeof value === "number" && mediaIds.has(value))
        ? null
        : `${spec.label} is no longer in the media library.`;
    case "flag":
      return typeof value === "boolean" ? null : `${spec.label} is not valid.`;
    case "group":
      return value === null || (typeof value === "number" && groupIds.has(value))
        ? null
        : spec.key === "destinationId"
          ? `${spec.label} names a destination that no longer exists.`
          : `${spec.label} names a group that no longer exists.`;
    case "order":
      return Array.isArray(value) && value.every((id) => Number.isInteger(id)) ? null : `${spec.label} is not valid.`;
    case "items":
    case "steps":
      return listShapeProblem(spec, value);
  }
}

/** The picture ids every patch of a route names, for the one existence query a publication makes. */
export function mediaIdsOfPatches(patches: Iterable<[RouteOwner, StoredPatch]>): number[] {
  const ids: number[] = [];
  for (const [owner, patch] of patches) {
    for (const [key, entry] of Object.entries(patch)) {
      if (specOf(owner.type, key)?.check === "media" && typeof entry.value === "number") ids.push(entry.value);
    }
  }
  return ids;
}

/* -------------------------------------------------------------------------- */
/* Words for values                                                           */
/* -------------------------------------------------------------------------- */

const EMPTY = "(empty)";

/**
 * A stored value as a person reads it, for a conflict card, a summary or a
 * comparison: text as text, rich text without its markup, a list by its
 * entries. A group or an order names records only the route knows, so the
 * route supplies `nameOf` for those.
 */
export function describeStored(
  spec: FieldSpec | undefined,
  value: unknown,
  nameOf: { group: (id: number) => string | null; member: (list: ListName | undefined, id: number) => string | null },
): string {
  if (value === null || value === undefined || value === "") return EMPTY;
  switch (spec?.check) {
    case "rich": {
      const text = toPlainText(String(value), 140);
      return text || EMPTY;
    }
    case "flag":
      return value === true ? (spec.key === "isPublished" ? "Shown" : "Yes") : spec.key === "isPublished" ? "Hidden" : "No";
    case "media":
      return `Picture #${String(value)}`;
    case "group": {
      const name = typeof value === "number" ? nameOf.group(value) : null;
      return name ?? `Group #${String(value)}`;
    }
    case "order": {
      if (!Array.isArray(value)) return EMPTY;
      const names = (value as number[]).map((id) => nameOf.member(spec.list, id) ?? `#${id}`);
      return names.length ? names.join(" → ") : EMPTY;
    }
    case "items":
    case "steps": {
      const rows = (spec.check === "items" ? listItemsOf(value) : listStepsOf(value))
        .map((row) => row.en.trim() || row.ar.trim())
        .filter(Boolean);
      if (!rows.length) return EMPTY;
      const joined = rows.join(" · ");
      return joined.length > 140 ? `${joined.slice(0, 139)}…` : joined;
    }
    default: {
      const text = String(value);
      return text.length > 140 ? `${text.slice(0, 139)}…` : text;
    }
  }
}
