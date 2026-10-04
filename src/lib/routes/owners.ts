/**
 * Who owns a node on a dynamic route (Batch 21).
 *
 * A page section is owned by its `page_sections` row. A dynamic route has no
 * such rows — its regions are drawn from the catalogue — so each region is
 * owned by the resource it edits: the hero by its category, a card by its
 * service, a question by its FAQ. This module is the one vocabulary for that
 * identity, shared by the renderer that writes addresses, the canvas bridge
 * that reads them, the editor that keys its buffers by them and the server
 * that resolves them to rows.
 *
 * Two spellings of one identity:
 *
 *   Owner key      `service:12`
 *     What is stored (`route_nodes.owner_key`) and what the canvas and the
 *     server exchange, inside an address: `service:12/field:intro`.
 *
 *   Editor key     `-6000000012`
 *     What the editor's buffers, Undo history and Layers rows are keyed by. A
 *     page section's editor key is its id; a route owner's is the negative
 *     number `-(code × 10⁹ + id)`. The encoding is lossless in both directions,
 *     the two ranges cannot collide, and a negative key can never reach a
 *     section action — those refuse every id that is not a positive integer.
 *
 * The codes are part of that encoding and are therefore append-only: renumbering
 * one would silently re-point every key held in an open editor.
 */

export const ROUTE_OWNER_CODES = {
  category: 1,
  categoryCrumbs: 2,
  categoryBody: 3,
  categoryServices: 4,
  subcategory: 5,
  service: 6,
  categoryHub: 7,
  categoryFaqs: 8,
  faq: 9,
  /**
   * A service's own page (Batch 22), one region per part of it, each keyed by
   * the service's id — so a region names the service, never its address, and
   * follows it through a rename or a move to another category. `service` above
   * is the service's *card* on its category page: a different element with
   * different fields, so it keeps its own type and its own styles.
   */
  serviceHero: 10,
  serviceCrumbs: 11,
  serviceOverview: 12,
  serviceBenefits: 13,
  serviceAudience: 14,
  serviceRequirements: 15,
  serviceProcess: 16,
  serviceNotes: 17,
  serviceFaqs: 18,
  serviceNotices: 19,
  serviceRequest: 20,
  serviceRelated: 21,
} as const;

export type RouteOwnerType = keyof typeof ROUTE_OWNER_CODES;

export type RouteOwner = { type: RouteOwnerType; id: number };

/** The span one owner type occupies in the editor-key space. */
export const ROUTE_KEY_SPAN = 1_000_000_000;

const TYPE_OF_CODE = new Map<number, RouteOwnerType>(
  (Object.entries(ROUTE_OWNER_CODES) as [RouteOwnerType, number][]).map(([type, code]) => [code, type]),
);

export const isRouteOwnerType = (value: unknown): value is RouteOwnerType =>
  typeof value === "string" && Object.prototype.hasOwnProperty.call(ROUTE_OWNER_CODES, value);

/** A database id an owner key can carry: a positive integer below the span. */
export const isOwnerRecordId = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0 && value < ROUTE_KEY_SPAN;

const OWNER_KEY = /^([A-Za-z]{1,32}):([1-9][0-9]{0,8})$/;

/** `service:12`. */
export const ownerKeyOf = (owner: RouteOwner): string => `${owner.type}:${owner.id}`;

/** The owner a key names, or null for anything that is not exactly one. */
export function parseOwnerKey(input: unknown): RouteOwner | null {
  if (typeof input !== "string") return null;
  const match = OWNER_KEY.exec(input);
  if (!match) return null;
  const type = match[1]!;
  const id = Number(match[2]);
  if (!isRouteOwnerType(type) || !isOwnerRecordId(id)) return null;
  return { type, id };
}

/** The owner's editor key: `-(code × 10⁹ + id)`. */
export const editorKeyOf = (owner: RouteOwner): number =>
  -(ROUTE_OWNER_CODES[owner.type] * ROUTE_KEY_SPAN + owner.id);

/** The owner an editor key encodes, or null for a section id or a stray number. */
export function ownerOfEditorKey(key: unknown): RouteOwner | null {
  if (typeof key !== "number" || !Number.isSafeInteger(key) || key >= 0) return null;
  const positive = -key;
  const code = Math.floor(positive / ROUTE_KEY_SPAN);
  const id = positive % ROUTE_KEY_SPAN;
  const type = TYPE_OF_CODE.get(code);
  if (!type || !isOwnerRecordId(id)) return null;
  return { type, id };
}

export const isRouteEditorKey = (key: unknown): key is number => ownerOfEditorKey(key) !== null;

/** The owner key behind an editor key, or null. */
export const ownerKeyOfEditorKey = (key: unknown): string | null => {
  const owner = ownerOfEditorKey(key);
  return owner ? ownerKeyOf(owner) : null;
};

/* -------------------------------------------------------------------------- */
/* Route documents                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A dynamic route the editor can open, named by its row id — never by its
 * slug, so a document cannot change identity under an open editor.
 *
 *   · `category` — a service category's page (Batch 21), `category:<id>`.
 *   · `service` — one service's own page (Batch 22), `service:<id>`. The id is
 *     the service's: renaming it, or moving it to another category, changes
 *     its address and never its document — so its drafts and its history stay
 *     with it.
 *
 * A route key and an owner key are different vocabularies, stored in
 * different columns (`route_nodes.route_key`, `route_versions.route_key`
 * against `route_nodes.owner_key`) and read by different parsers: the route
 * `service:12` is a page, the owner `service:12` is a card on its category's
 * page, and neither parser accepts the other's meaning.
 */
export type RouteKind = "category" | "service";

export type RouteDocument = { kind: RouteKind; id: number };

export const ROUTE_KINDS: readonly RouteKind[] = ["category", "service"];

const ROUTE_KEY = /^(category|service):([1-9][0-9]{0,8})$/;

export const routeKeyOf = (document: RouteDocument): string => `${document.kind}:${document.id}`;

export function parseRouteKey(input: unknown): RouteDocument | null {
  if (typeof input !== "string") return null;
  const match = ROUTE_KEY.exec(input);
  if (!match) return null;
  const id = Number(match[2]);
  return isOwnerRecordId(id) ? { kind: match[1] as RouteKind, id } : null;
}

/**
 * Which owner a route document *is*: the region its key is shared with. A
 * category route is its category's hero; a service route is its service's
 * hero. Append-only, like the codes.
 */
const ROOT_OWNER: Record<RouteKind, RouteOwnerType> = { category: "category", service: "serviceHero" };
const KIND_OF_ROOT = new Map<RouteOwnerType, RouteKind>(
  (Object.entries(ROOT_OWNER) as [RouteKind, RouteOwnerType][]).map(([kind, type]) => [type, kind]),
);

/**
 * A route document's editor key: its root owner's. The category route *is*
 * its category, so the document and the hero share one identity — and the
 * editor's per-document state (the Undo history) is keyed where the per-owner
 * state (buffers) cannot collide with it, since the two live in different maps.
 * A service route is its service's hero in the same way (Batch 22).
 */
export const documentEditorKey = (document: RouteDocument): number =>
  editorKeyOf({ type: ROOT_OWNER[document.kind], id: document.id });

/** The route document an editor key names, or null. */
export function documentOfEditorKey(key: unknown): RouteDocument | null {
  const owner = ownerOfEditorKey(key);
  const kind = owner ? KIND_OF_ROOT.get(owner.type) : undefined;
  return owner && kind ? { kind, id: owner.id } : null;
}
