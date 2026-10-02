import "server-only";

import { toPlainText } from "@/lib/cms/sanitize";
import { emptyMotionDocument } from "@/lib/cms/motion-doc";
import type { Executor } from "@/lib/db/revision";
import type { RouteConflictView, VisualSectionData } from "@/lib/visual-editor/content";
import { motionForBlock } from "@/lib/visual-editor/motion-targets";

import {
  adminHrefOf,
  applyOrder,
  blockTypeOf,
  conflictsOf,
  effectiveData,
  loadCategoryData,
  membersOf,
  ownerBelongs,
  ownerLabel,
  ownersOf,
  pendingPatch,
  resourceOf,
  SPECS,
  storedValuesOf,
  valuesOf,
  type CategoryData,
  type FieldSpec,
  type StoredPatch,
} from "./category";
import {
  documentEditorKey,
  editorKeyOf,
  ownerKeyOf,
  parseOwnerKey,
  parseRouteKey,
  type RouteDocument,
  type RouteOwner,
} from "./owners";
import { draftPresentationOf, patchOf, publishedOf, readNodes, type NodeRow } from "./store";

/**
 * One category route as the Visual Editor sees it at one moment (Batch 21):
 * the live rows, the stored regions, every pending patch, and the rows with
 * those patches laid over them.
 *
 * Built in a fixed number of queries — the category's own four and one for
 * its regions — whatever the number of cards, and built the same way for an
 * Inspector load, a save, a summary and (locked) a publication, so none of
 * them can come to a different idea of what the draft says.
 */
export type RouteContext = {
  document: RouteDocument;
  routeKey: string;
  data: CategoryData;
  owners: RouteOwner[];
  nodes: Map<string, NodeRow>;
  /** Each owner's published stored values. */
  live: Map<string, Record<string, unknown>>;
  /** Each owner's pending patch — entries that still ask for something. */
  patches: Map<string, StoredPatch>;
  /** The rows as the draft would make them. */
  effective: CategoryData;
};

export async function readRouteContext(
  on: Executor,
  routeKey: string,
  options: { lock?: boolean } = {},
): Promise<RouteContext | null> {
  const document = parseRouteKey(routeKey);
  if (!document) return null;
  const data = await loadCategoryData(on, document.id, options);
  if (!data) return null;
  const owners = ownersOf(data);
  const nodes = await readNodes(on, owners.map(ownerKeyOf), options);

  const live = new Map<string, Record<string, unknown>>();
  const patches = new Map<string, StoredPatch>();
  for (const owner of owners) {
    const key = ownerKeyOf(owner);
    const node = nodes.get(key);
    const values = storedValuesOf(owner, data, publishedOf(node).copy);
    live.set(key, values);
    const patch = pendingPatch(owner, patchOf(node), values);
    if (Object.keys(patch).length) patches.set(key, patch);
  }
  return {
    document,
    routeKey,
    data,
    owners,
    nodes,
    live,
    patches,
    effective: effectiveData(data, patches),
  };
}

/** The owner an address names, if it is drawn on this route. */
export function ownerIn(context: RouteContext, ownerKey: unknown): RouteOwner | null {
  const owner = parseOwnerKey(ownerKey);
  if (!owner || !ownerBelongs(owner, context.data)) return null;
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
      const members = membersOf(owner, spec.list, context.effective);
      out[spec.key] = applyOrder(entry ? entry.value : members, members);
    } else {
      out[spec.key] = entry ? entry.value : live[spec.key];
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Words for values                                                           */
/* -------------------------------------------------------------------------- */

const EMPTY = "(empty)";

/**
 * A stored value as a person reads it, for a conflict card, a summary or a
 * comparison: text as text, rich text without its markup, an id by its name.
 */
export function describeValue(spec: FieldSpec | undefined, value: unknown, data: CategoryData): string {
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
      const group = data.groups.find((row) => row.id === value);
      return group ? group.titleEn : `Group #${String(value)}`;
    }
    case "order": {
      if (!Array.isArray(value)) return EMPTY;
      const names = (value as number[]).map((id) => {
        if (spec.list === "groups") return data.groups.find((row) => row.id === id)?.titleEn ?? `#${id}`;
        if (spec.list === "faqs") return data.faqs.find((row) => row.id === id)?.questionEn ?? `#${id}`;
        return data.services.find((row) => row.id === id)?.titleEn ?? `#${id}`;
      });
      return names.length ? names.join(" → ") : EMPTY;
    }
    default: {
      const text = String(value);
      return text.length > 140 ? `${text.slice(0, 139)}…` : text;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* The Inspector's document                                                   */
/* -------------------------------------------------------------------------- */

/** The choices a field offers that only the route can supply. */
function optionsOf(owner: RouteOwner, data: CategoryData): Record<string, { value: string; label: string }[]> {
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
}

/** Whether a region would be on the public page with its drafts published. */
export function visibleAfterPublish(owner: RouteOwner, effective: CategoryData): boolean {
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
}

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
      live: describeValue(spec, conflict.live, context.data),
      draft: describeValue(spec, conflict.draft, context.effective),
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
      label: ownerLabel(owner, context.effective),
      resource: resourceOf(owner),
      adminHref: adminHrefOf(owner, context.data),
      conflicts,
      options: optionsOf(owner, context.effective),
      visible: visibleAfterPublish(owner, context.effective),
    },
  };
}
