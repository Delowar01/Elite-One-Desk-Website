import "server-only";

import { emptyMotionDocument } from "@/lib/cms/motion-doc";
import type { Executor } from "@/lib/db/revision";
import type { RouteConflictView, VisualSectionData } from "@/lib/visual-editor/content";
import { motionForBlock } from "@/lib/visual-editor/motion-targets";

import {
  adapterOf,
  catalogueAdapter,
  categoryAdapter,
  destinationAdapter,
  packageAdapter,
  serviceAdapter,
  serviceIndexAdapter,
  type RouteAdapter,
  type RouteContext,
  type RouteData,
} from "./adapter";
import type { CatalogueData, DestinationData, PackageData } from "./packages";
import type { ServiceIndexData } from "./service-index-model";
import type { CategoryData } from "./category";
import {
  documentEditorKey,
  editorKeyOf,
  ownerKeyOf,
  parseOwnerKey,
  parseRouteKey,
  routeKeyOf,
  type RouteDocument,
  type RouteOwner,
} from "./owners";
import type { ServiceData } from "./service";
import {
  applyOrder,
  blockTypeOf,
  conflictsOf,
  domainPermissionOf,
  nextPatchWith,
  pendingPatch,
  readSubmittedWith,
  resourceOf,
  SPECS,
  valuesOf,
  type FieldSpec,
  type StoredPatch,
} from "./specs";
import { draftPresentationOf, patchOf, publishedOf, readNodes } from "./store";

export type { RouteContext } from "./adapter";

/**
 * One dynamic route as the Visual Editor sees it at one moment (Batch 21,
 * every route kind since Batch 22): the live rows, the stored regions, every
 * pending patch, and the rows with those patches laid over them.
 *
 * Built in a fixed number of queries — the route's own rows and one read of
 * its regions — whatever the number of cards or questions, and built the same
 * way for an Inspector load, a save, a summary and (locked) a publication, so
 * none of them can come to a different idea of what the draft says. Which
 * rows those are is the route's adapter's business (`adapter.ts`).
 */
async function buildContext<D extends RouteData>(
  adapter: RouteAdapter<D>,
  on: Executor,
  document: RouteDocument,
  options: { lock?: boolean },
): Promise<RouteContext<D> | null> {
  const data = await adapter.load(on, document.id, options);
  if (!data) return null;
  const owners = adapter.owners(data);
  const nodes = await readNodes(on, owners.map(ownerKeyOf), options);

  const live = new Map<string, Record<string, unknown>>();
  const patches = new Map<string, StoredPatch>();
  for (const owner of owners) {
    const key = ownerKeyOf(owner);
    const node = nodes.get(key);
    const values = adapter.storedValues(owner, data, publishedOf(node).copy);
    live.set(key, values);
    const patch = pendingPatch(owner, patchOf(node), values);
    if (Object.keys(patch).length) patches.set(key, patch);
  }
  return {
    adapter,
    document,
    routeKey: routeKeyOf(document),
    data,
    owners,
    nodes,
    live,
    patches,
    effective: adapter.effective(data, patches),
  };
}

/** Any route the key names, through its own adapter — or null. */
export async function readRouteContext(
  on: Executor,
  routeKey: string,
  options: { lock?: boolean } = {},
): Promise<RouteContext | null> {
  const document = parseRouteKey(routeKey);
  if (!document) return null;
  return buildContext(adapterOf(document.kind), on, document, options);
}

/** A category's route, typed as one (the category page's own renderer reads its rows). */
export const readCategoryContext = (on: Executor, categoryId: number, options: { lock?: boolean } = {}) =>
  buildContext<CategoryData>(categoryAdapter, on, { kind: "category", id: categoryId }, options);

/** A service's own page, typed as one (Batch 22). */
export const readServiceContext = (on: Executor, serviceId: number, options: { lock?: boolean } = {}) =>
  buildContext<ServiceData>(serviceAdapter, on, { kind: "service", id: serviceId }, options);

/** A package's own page, typed as one (Batch 24). */
export const readPackageContext = (on: Executor, packageId: number, options: { lock?: boolean } = {}) =>
  buildContext<PackageData>(packageAdapter, on, { kind: "package", id: packageId }, options);

/** A destination's own page, typed as one (Batch 24). */
export const readDestinationContext = (on: Executor, destinationId: number, options: { lock?: boolean } = {}) =>
  buildContext<DestinationData>(destinationAdapter, on, { kind: "destination", id: destinationId }, options);

/** The package catalogue, typed as one (Batch 24). */
export const readCatalogueContext = (on: Executor, options: { lock?: boolean } = {}) =>
  buildContext<CatalogueData>(catalogueAdapter, on, { kind: "packageIndex", id: 1 }, options);

/** The services overview, typed as one (Batch 24). */
export const readServiceIndexContext = (on: Executor, options: { lock?: boolean } = {}) =>
  buildContext<ServiceIndexData>(serviceIndexAdapter, on, { kind: "serviceIndex", id: 1 }, options);

/** The owner an address names, if it is drawn on this route. */
export function ownerIn(context: RouteContext, ownerKey: unknown): RouteOwner | null {
  const owner = parseOwnerKey(ownerKey);
  if (!owner || !context.adapter.belongs(owner, context.data)) return null;
  return owner;
}

/**
 * One owner's stored values as its draft makes them: the patch over the live
 * value, and every order completed against who is in the list after the whole
 * route's drafts — so a card another draft moves into a group is ordered there.
 */
export function effectiveStored(context: RouteContext, owner: RouteOwner): Record<string, unknown> {
  const key = ownerKeyOf(owner);
  const live = context.live.get(key) ?? {};
  const patch = context.patches.get(key) ?? {};
  const out: Record<string, unknown> = {};
  for (const spec of SPECS[owner.type]) {
    const entry = patch[spec.key];
    if (spec.check === "order") {
      const members = context.adapter.members(owner, spec.list, context.effective);
      out[spec.key] = applyOrder(entry ? entry.value : members, members);
    } else {
      out[spec.key] = entry ? entry.value : live[spec.key];
    }
  }
  return out;
}

/**
 * The Inspector's values read back into stored values with the record's own
 * rules (`specs.ts`), the route supplying the one thing only it knows: which
 * groups a card may be filed under.
 */
export function readSubmittedIn(
  context: RouteContext,
  owner: RouteOwner,
  submitted: Record<string, unknown>,
  mediaIds: ReadonlySet<number>,
) {
  return readSubmittedWith(owner, submitted, { mediaIds, groupIds: context.adapter.groupIds(context.data) });
}

/** The patch a save leaves, its orders completed against who is in each list after the route's drafts. */
export function nextPatchIn(
  context: RouteContext,
  owner: RouteOwner,
  previous: StoredPatch | null | undefined,
  live: Record<string, unknown>,
  stored: Record<string, unknown>,
  startedFrom?: Record<string, unknown>,
): StoredPatch {
  return nextPatchWith(owner, previous, live, stored, (list) => context.adapter.members(owner, list, context.effective), startedFrom);
}

/* -------------------------------------------------------------------------- */
/* Words for values                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A stored value as a person reads it, for a conflict card, a summary or a
 * comparison: text as text, rich text without its markup, a list by its
 * entries, an id by its name — named from `data` (the live rows, or the
 * draft's).
 */
export const describeValue = (context: RouteContext, spec: FieldSpec | undefined, value: unknown, data: RouteData = context.data) =>
  context.adapter.describe(spec, value, data);

/* -------------------------------------------------------------------------- */
/* The Inspector's document                                                   */
/* -------------------------------------------------------------------------- */

/** Whether a region would be on the public page with its drafts published. */
export const visibleAfterPublish = (context: RouteContext, owner: RouteOwner): boolean =>
  context.adapter.visible(owner, context.effective);

/**
 * One region in the shape the editor's section buffer takes.
 *
 * `sectionId` is the owner's editor key and `pageId` the route document's, so
 * the editor keys the region exactly as it keys a section. `revision` is the
 * stored row's, or 0 when the region has never been written — the value a
 * first save must name. The legacy entrance is "none": a route region has no
 * preset of its own, and its template's own reveals are not the editor's to
 * replace.
 */
export function ownerData(context: RouteContext, owner: RouteOwner): VisualSectionData {
  const key = ownerKeyOf(owner);
  const node = context.nodes.get(key);
  const blockType = blockTypeOf(owner);
  const live = context.live.get(key) ?? {};
  const patch = context.patches.get(key) ?? {};
  const presentation = draftPresentationOf(node);
  const conflicts: RouteConflictView[] = conflictsOf(owner, patch, live).map((conflict) => {
    const spec = SPECS[owner.type].find((entry) => entry.key === conflict.key);
    return {
      key: conflict.key,
      label: conflict.label,
      live: describeValue(context, spec, conflict.live, context.data),
      draft: describeValue(context, spec, conflict.draft, context.effective),
    };
  });

  return {
    sectionId: editorKeyOf(owner),
    pageId: documentEditorKey(context.document),
    blockType,
    revision: node?.revision ?? 0,
    hasDraft: Object.keys(patch).length > 0,
    hasStyleDraft: node?.draftStyles != null,
    hasMotionDraft: node?.draftMotion != null,
    isDraftOnly: false,
    values: valuesOf(owner.type, effectiveStored(context, owner)),
    styles: presentation.styles,
    motion: "none",
    motionDocument: motionForBlock(presentation.motion ?? emptyMotionDocument(), blockType),
    legacyEntrance: "none",
    route: {
      ownerKey: key,
      routeKey: context.routeKey,
      label: context.adapter.label(owner, context.effective),
      resource: resourceOf(owner),
      domain: domainPermissionOf(owner.type),
      adminHref: context.adapter.adminHref(owner, context.data),
      conflicts,
      options: context.adapter.options(owner, context.effective),
      visible: visibleAfterPublish(context, owner),
    },
  };
}
