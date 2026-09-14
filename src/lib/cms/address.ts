/**
 * How the editor names a thing on a page.
 *
 * Two vocabularies, deliberately separate, because conflating them is how
 * stored data rots:
 *
 *   Runtime address      `section:42/field:links/item:i_8Gk3pZ1mQ2/field:label`
 *     What the editor and the canvas pass to each other. It names a section by
 *     its database id, which only makes sense while that row exists.
 *
 *   Relative node path   `field:links/item:i_8Gk3pZ1mQ2/field:label`
 *     What is persisted, inside the row that is already the section. It carries
 *     no section id at all — and it must not, because `duplicateSection`
 *     inserts a new id, a restore may recreate a deleted section under another
 *     id, and a copied section would otherwise arrive holding style keys
 *     addressed to the section it came from.
 *
 * Locale is not part of either. A node is one node; `headline` is the same node
 * in both editions, and the language is separate state carried beside the
 * address. `field:headline@ar` is rejected on purpose.
 *
 * Nothing here is a selector. No `nth-child`, no XPath, no CSS. A path is a
 * list of named, typed segments and it is validated as one.
 */

import { ITEM_ID_PATTERN } from "./item-id";

export type SegmentKind = "field" | "slot" | "item";

export type NodeSegment = { kind: SegmentKind; name: string };

/** An empty segment list is the section's own root node, written `root`. */
export type NodePath = readonly NodeSegment[];

export const ROOT_PATH_TOKEN = "root";

/** Deep enough for field → item → field. Anything longer is not a real node. */
const MAX_SEGMENTS = 6;

/**
 * Field and slot names come from the block registry, where they are written as
 * identifiers. Keeping the accepted set that narrow is most of the safety here:
 * a name cannot contain a slash, a colon, an at-sign, a bracket or a dot, so a
 * path can never be read as a selector.
 */
const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

const isName = (value: string) => NAME.test(value);
const isItemName = (value: string) => ITEM_ID_PATTERN.test(value);

/**
 * The shapes a path may take. `item:` only ever qualifies the `field:` before
 * it, and only a `field:` or `slot:` may follow it — so `item:x/item:y` and a
 * bare leading `item:` are both refused rather than stored and puzzled over
 * later.
 */
function segmentsValid(segments: NodeSegment[]): boolean {
  if (segments.length > MAX_SEGMENTS) return false;
  for (const [index, segment] of segments.entries()) {
    const previous = segments[index - 1];
    if (segment.kind === "item") {
      if (!previous || previous.kind !== "field") return false;
      if (!isItemName(segment.name)) return false;
      continue;
    }
    if (!isName(segment.name)) return false;
    if (previous?.kind === "slot") return false; // a slot is a leaf
  }
  return true;
}

/** `root`, or `kind:name` joined by `/`. Returns null for anything else. */
export function parseNodePath(input: unknown): NodePath | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw) return null;
  if (raw === ROOT_PATH_TOKEN) return [];
  if (raw.includes("//") || raw.startsWith("/") || raw.endsWith("/")) return null;

  const segments: NodeSegment[] = [];
  for (const part of raw.split("/")) {
    const colon = part.indexOf(":");
    if (colon < 1) return null;
    const kind = part.slice(0, colon);
    const name = part.slice(colon + 1);
    if (kind !== "field" && kind !== "slot" && kind !== "item") return null;
    if (!name || name.includes(":")) return null;
    segments.push({ kind, name });
  }
  return segmentsValid(segments) ? segments : null;
}

export function formatNodePath(path: NodePath): string {
  if (!path.length) return ROOT_PATH_TOKEN;
  return path.map((segment) => `${segment.kind}:${segment.name}`).join("/");
}

export const isNodePath = (input: unknown): boolean => parseNodePath(input) !== null;

/** Normalises a stored key, or null if it was never a path. */
export function normalizeNodePath(input: unknown): string | null {
  const parsed = parseNodePath(input);
  return parsed ? formatNodePath(parsed) : null;
}

/* -------------------------------------------------------------------------- */
/* Runtime addresses                                                          */
/* -------------------------------------------------------------------------- */

export type NodeAddress = { sectionId: number; path: NodePath };

const SECTION_PREFIX = "section:";

export function parseAddress(input: unknown): NodeAddress | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (!raw.startsWith(SECTION_PREFIX)) return null;

  const rest = raw.slice(SECTION_PREFIX.length);
  const slash = rest.indexOf("/");
  const idPart = slash === -1 ? rest : rest.slice(0, slash);
  if (!/^[1-9][0-9]{0,9}$/.test(idPart)) return null;
  const sectionId = Number(idPart);

  if (slash === -1) return { sectionId, path: [] };
  const path = parseNodePath(rest.slice(slash + 1));
  return path ? { sectionId, path } : null;
}

/** `section:42`, or `section:42/<relative path>`. Never `section:42/root`. */
export function formatAddress(sectionId: number, path: NodePath = []): string {
  return path.length ? `${SECTION_PREFIX}${sectionId}/${formatNodePath(path)}` : `${SECTION_PREFIX}${sectionId}`;
}

/** Runtime address from a section id and a persisted relative path. */
export function composeAddress(sectionId: number, relative: unknown): string | null {
  if (!Number.isInteger(sectionId) || sectionId <= 0) return null;
  const path = parseNodePath(relative);
  return path ? formatAddress(sectionId, path) : null;
}

/** The inverse: the section it names, and the path to persist inside that row. */
export function decomposeAddress(input: unknown): { sectionId: number; relative: string } | null {
  const parsed = parseAddress(input);
  return parsed ? { sectionId: parsed.sectionId, relative: formatNodePath(parsed.path) } : null;
}

export const addressEquals = (a: unknown, b: unknown): boolean => {
  const left = parseAddress(a);
  const right = parseAddress(b);
  if (!left || !right) return false;
  return left.sectionId === right.sectionId && formatNodePath(left.path) === formatNodePath(right.path);
};

/** The repeatable row a path sits in, if any — `field:links/item:i_…`. */
export function itemIdOf(path: NodePath): string | null {
  for (let i = path.length - 1; i >= 0; i -= 1) {
    if (path[i]!.kind === "item") return path[i]!.name;
  }
  return null;
}
