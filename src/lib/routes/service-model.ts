import type { RouteDocument, RouteOwner, RouteOwnerType } from "./owners";
import { ownerKeyOf } from "./owners";
import type { CategoryRow, FaqRow, ServiceRow } from "./category-model";
import {
  applyOrder,
  listItemsOf,
  listStepsOf,
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
 * The service route's adapter (Batch 22): what the Visual Editor needs to know
 * about `/[lang]/services/[category]/[service]`.
 *
 * The category adapter's twin, answering the same four questions from the
 * database rows alone — so a service created tomorrow, in any category, is
 * editable the moment it exists, and no service is named in code:
 *
 *   1. **Which regions does this page draw?** `serviceOwnersOf` — the hero,
 *      the breadcrumbs, the six content sections, the questions section and
 *      one row per question of the service's own, the notices, the request
 *      form and the related services. Every region of the page is keyed by
 *      the service's id; a question by its own.
 *   2. **Where does each field live?** `SPECS` (`specs.ts`) — the service's
 *      own columns, the template copy of each section's heading, and the
 *      order of the service's own questions.
 *   3. **What may be stored?** `readServiceSubmitted` — the Services and FAQs
 *      screens' rules, applied again.
 *   4. **What does a draft make it say?** `effectiveServiceData` — the live
 *      service and its questions with every pending patch laid over them.
 *
 * Its identity is the service's row id, never its address: renaming the
 * service or moving it to another category changes the page's path and
 * nothing else, so a draft and a version history stay with the service.
 *
 * Pure: no connection. The database reads are `service.ts`.
 */

/**
 * Everything a service's page draws, **its own unpublished questions
 * included** (the canvas draws a hidden question dimmed, so it can be shown
 * again).
 *
 * `inherited` are the published questions of the service's category — they
 * appear on the page between the service's own, and are edited on the
 * category's page, never here (`faq` owners of this route are the service's
 * own questions only). Two routes never own one record.
 */
export type ServiceData = {
  service: ServiceRow;
  category: CategoryRow;
  faqs: FaqRow[];
  inherited: FaqRow[];
};

/** The regions of a service's page, each keyed by the service's id. */
export const SERVICE_REGIONS = [
  "serviceHero",
  "serviceCrumbs",
  "serviceOverview",
  "serviceBenefits",
  "serviceAudience",
  "serviceRequirements",
  "serviceProcess",
  "serviceNotes",
  "serviceFaqs",
  "serviceNotices",
  "serviceRequest",
  "serviceRelated",
] as const satisfies readonly RouteOwnerType[];

export type ServiceRegion = (typeof SERVICE_REGIONS)[number];

const SERVICE_REGION_SET: ReadonlySet<RouteOwnerType> = new Set(SERVICE_REGIONS);

export const isServiceRegion = (type: RouteOwnerType): type is ServiceRegion => SERVICE_REGION_SET.has(type);

/** The regions whose columns are the service row's own. */
const ROW_REGIONS: ReadonlySet<RouteOwnerType> = new Set([
  "serviceHero",
  "serviceOverview",
  "serviceBenefits",
  "serviceAudience",
  "serviceRequirements",
  "serviceProcess",
  "serviceNotes",
]);

/**
 * The regions a service's page draws, in page order: the hero and the
 * breadcrumbs, the main column (the six sections, the questions with the
 * service's own questions after their section, the notices), the request form
 * beside it, and the related services below.
 *
 * Every region is offered on every service — an empty section is drawn in the
 * canvas as a placeholder, so it can be selected and written — which is what
 * makes a new service editable without anybody deciding its regions.
 */
export function serviceOwnersOf(data: ServiceData): RouteOwner[] {
  const id = data.service.id;
  const out: RouteOwner[] = [];
  for (const type of SERVICE_REGIONS) {
    if (type === "serviceNotices") out.push(...data.faqs.map((faq) => ({ type: "faq" as const, id: faq.id })));
    out.push({ type, id });
  }
  return out;
}

/** Whether an owner is drawn on this service's page. The IDOR check every action makes. */
export function serviceOwnerBelongs(owner: RouteOwner, data: ServiceData): boolean {
  if (isServiceRegion(owner.type)) return owner.id === data.service.id;
  if (owner.type === "faq") return data.faqs.some((faq) => faq.id === owner.id);
  return false;
}

export const routeKeyOfService = (serviceId: number) => `service:${serviceId}`;
export const documentOfService = (serviceId: number): RouteDocument => ({ kind: "service", id: serviceId });

/** The public path of a service's page, without a language prefix. */
export const servicePathOf = (data: Pick<ServiceData, "service" | "category">): string =>
  `/services/${data.category.slug}/${data.service.slug}`;

/* -------------------------------------------------------------------------- */
/* Live values, and the draft laid over them                                  */
/* -------------------------------------------------------------------------- */

function rowOf(owner: RouteOwner, data: ServiceData): Record<string, unknown> | null {
  if (ROW_REGIONS.has(owner.type)) return data.service as unknown as Record<string, unknown>;
  if (owner.type === "faq") return (data.faqs.find((row) => row.id === owner.id) as unknown as Record<string, unknown>) ?? null;
  return null;
}

/** The members of one ordered list: the service's own questions, in their stored order. */
export function serviceMembersOf(owner: RouteOwner, list: ListName | undefined, data: ServiceData): number[] {
  if (owner.type === "serviceFaqs" && list === "faqs") return data.faqs.map((faq) => faq.id);
  return [];
}

/**
 * A stored list in the one shape the editor compares: `{ en, ar }` items,
 * `{ en, ar, detailEn, detailAr }` steps — whatever key order the database
 * handed the row back in.
 */
const listValue = (spec: FieldSpec, value: unknown): unknown =>
  spec.check === "items" ? listItemsOf(value) : spec.check === "steps" ? listStepsOf(value) : value;

/**
 * One owner's stored values, by storage key, as `data` has them. With live
 * rows this is the published state; with `effectiveServiceData` the draft.
 */
export function serviceStoredValuesOf(
  owner: RouteOwner,
  data: ServiceData,
  copy: Record<string, string> | null | undefined,
): Record<string, unknown> {
  const row = rowOf(owner, data);
  const out: Record<string, unknown> = {};
  for (const spec of SPECS[owner.type]) {
    if (spec.key.startsWith("copy:")) {
      const value = copy?.[spec.key.slice(5)];
      out[spec.key] = typeof value === "string" ? value : "";
    } else if (spec.check === "order") {
      out[spec.key] = serviceMembersOf(owner, spec.list, data);
    } else {
      out[spec.key] = row ? listValue(spec, row[spec.key] ?? null) : null;
    }
  }
  return out;
}

/**
 * The page's rows with every pending patch applied: the service row with the
 * patches of every region that writes it (their keys never overlap), the
 * service's own questions with theirs, and then the draft order of those
 * questions — within the positions they already hold, so the category's
 * questions between them keep their places.
 */
export function effectiveServiceData(data: ServiceData, patches: ReadonlyMap<string, StoredPatch>): ServiceData {
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

  let service = data.service;
  for (const type of ROW_REGIONS) service = patchRow(service, { type, id: data.service.id });
  const faqs = data.faqs.map((faq) => patchRow(faq, { type: "faq", id: faq.id }));

  const wanted = patches.get(ownerKeyOf({ type: "serviceFaqs", id: data.service.id }))?.["order:faqs"]?.value;
  const order = wanted === undefined ? null : applyOrder(wanted, faqs.map((faq) => faq.id));
  return {
    service,
    category: data.category,
    faqs: placeInOrder(faqs, () => "all", (row) => order?.indexOf(row.id)),
    inherited: data.inherited,
  };
}

/**
 * Every question the page shows, in the order it shows them: the service's own
 * and its category's interleaved by their stored positions, as the public page
 * has always ordered them — with the service's own in the order its draft
 * asks for, in the slots its own questions hold. A draft that reorders the
 * service's questions therefore never moves one of the category's.
 */
export function questionsOf(data: ServiceData): FaqRow[] {
  const byPosition = <T extends { sortOrder: number; id: number }>(a: T, b: T) => a.sortOrder - b.sortOrder || a.id - b.id;
  const own = new Set(data.faqs.map((faq) => faq.id));
  const slots = [...data.faqs, ...data.inherited].sort(byPosition);
  let next = 0;
  return slots.map((row) => (own.has(row.id) ? data.faqs[next++]! : row));
}

/* -------------------------------------------------------------------------- */
/* The editor's values                                                        */
/* -------------------------------------------------------------------------- */

/** Nothing on a service's page chooses a group: its group is placed on the category page. */
const NO_GROUPS: ReadonlySet<number> = new Set();

/** The Inspector's values read back into stored values, with the Services and FAQs screens' rules. */
export function readServiceSubmitted(
  owner: RouteOwner,
  submitted: Record<string, unknown>,
  mediaIds: ReadonlySet<number>,
): { ok: true; stored: Record<string, unknown> } | { ok: false; problem: ReadProblem } {
  return readSubmittedWith(owner, submitted, { mediaIds, groupIds: NO_GROUPS });
}

/** The patch a save leaves, with the questions' order normalised against who is in the list after the drafts. */
export function serviceNextPatch(
  owner: RouteOwner,
  previous: StoredPatch | null | undefined,
  live: Record<string, unknown>,
  stored: Record<string, unknown>,
  effective: ServiceData,
): StoredPatch {
  return nextPatchWith(owner, previous, live, stored, (list) => serviceMembersOf(owner, list, effective));
}

/* -------------------------------------------------------------------------- */
/* Visibility                                                                 */
/* -------------------------------------------------------------------------- */

const hasText = (...values: (string | null | undefined)[]) => values.some((value) => Boolean(value?.trim()));

/**
 * Whether a region would be on the public page with its drafts published.
 *
 * A section is shown when either edition has something to show — Arabic falls
 * back to English, and an Arabic-only section shows on the Arabic page. The
 * questions section is shown when any question is: the service's own that are
 * published, or its category's.
 */
export function serviceRegionVisible(owner: RouteOwner, effective: ServiceData): boolean {
  const row = effective.service;
  switch (owner.type) {
    case "serviceOverview":
      return hasText(row.bodyEn, row.bodyAr);
    case "serviceBenefits":
      return listItemsOf(row.benefits).some((item) => hasText(item.en, item.ar));
    case "serviceAudience":
      return listItemsOf(row.audience).some((item) => hasText(item.en, item.ar));
    case "serviceRequirements":
      return listItemsOf(row.requirements).some((item) => hasText(item.en, item.ar));
    case "serviceProcess":
      return listStepsOf(row.processSteps).some((step) => hasText(step.en, step.ar));
    case "serviceNotes":
      return hasText(row.notesEn, row.notesAr);
    case "serviceFaqs":
      return effective.faqs.some((faq) => faq.isPublished) || effective.inherited.length > 0;
    case "faq":
      return effective.faqs.find((faq) => faq.id === owner.id)?.isPublished !== false;
    default:
      return true;
  }
}

/* -------------------------------------------------------------------------- */
/* Naming                                                                     */
/* -------------------------------------------------------------------------- */

const quoted = (value: string) => `“${value.length > 48 ? `${value.slice(0, 47).trimEnd()}…` : value}”`;

const REGION_WORDS: Record<ServiceRegion, string> = {
  serviceHero: "Hero",
  serviceCrumbs: "Breadcrumbs",
  serviceOverview: "Overview",
  serviceBenefits: "Key benefits",
  serviceAudience: "Who this is for",
  serviceRequirements: "Documents and requirements",
  serviceProcess: "How the process runs",
  serviceNotes: "Important notes",
  serviceFaqs: "Questions section",
  serviceNotices: "Notices",
  serviceRequest: "Request form",
  serviceRelated: "Related services",
};

/** What an owner is, in words: "Hero of “Visa Assistance”", "Question “…”". */
export function serviceOwnerLabel(owner: RouteOwner, data: ServiceData): string {
  if (owner.type === "serviceHero") return `Hero of ${quoted(data.service.titleEn)}`;
  if (isServiceRegion(owner.type)) return REGION_WORDS[owner.type];
  if (owner.type === "faq") {
    const row = data.faqs.find((faq) => faq.id === owner.id);
    return row ? `Question ${quoted(row.questionEn)}` : `Question #${owner.id}`;
  }
  return `Region ${ownerKeyOf(owner)}`;
}

/** The admin screen that manages what a region shows. */
export function serviceAdminHrefOf(owner: RouteOwner, data: ServiceData): string | null {
  if (ROW_REGIONS.has(owner.type) || owner.type === "serviceRequest") return `/admin/services/${data.service.id}`;
  switch (owner.type) {
    case "faq":
    case "serviceFaqs":
      return "/admin/faqs";
    case "serviceNotices":
      return "/admin/settings";
    case "serviceRelated":
      return "/admin/services";
    default:
      return null;
  }
}

/** The name of a member of an ordered list, for a summary or a comparison. */
export function serviceMemberName(data: ServiceData, list: ListName | undefined, id: number): string | null {
  if (list !== "faqs") return null;
  return data.faqs.find((faq) => faq.id === id)?.questionEn ?? null;
}
