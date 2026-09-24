import {
  formatAddress,
  formatNodePath,
  parseAddress,
  parseNodePath,
  type NodePath,
} from "@/lib/cms/address";
import { getBlock, type FieldDef, type ItemFieldDef } from "@/lib/cms/blocks";
import { ITEM_ID_KEY } from "@/lib/cms/item-id";
import type { Locale } from "@/lib/i18n/config";

/**
 * What a node *is*, and what an editor may do to it directly.
 *
 * Every answer here comes from the block registry — the same declaration the
 * admin form, the validator and the renderer already read — resolved against a
 * parsed address. Nothing is inferred from the DOM, from a tag name or from a
 * class: the canvas decides what exists and is selectable, and the registry
 * decides what each of those things is. Two sources, each authoritative over
 * its own half, and neither guessing at the other's.
 *
 * The alternative — a second description of the page held in the editor — is
 * the thing this module exists instead of. It could disagree with the canvas,
 * and the day it did, the panel would be pointing confidently at a node that
 * is not on screen.
 */

/** A node's registry type, narrowed to what the editor treats differently. */
export type LayerKind =
  | "section"
  | "item"
  | "text"
  | "multiline"
  | "richtext"
  | "media"
  | "icon"
  | "link"
  | "list"
  | "field";

/**
 * The coarse grouping the Layers tree shows, so a row is recognisable at a
 * glance without the panel inventing a vocabulary of its own.
 */
export type LayerGroup = "section" | "item" | "media" | "link" | "field";

export const layerGroupOf = (kind: LayerKind): LayerGroup =>
  kind === "section" || kind === "item"
    ? kind
    : kind === "media" || kind === "icon"
      ? "media"
      : kind === "link"
        ? "link"
        : "field";

/** The registry declaration a relative path names, or null when there is none. */
function declarationAt(
  blockType: string,
  path: NodePath,
): FieldDef | ItemFieldDef | null {
  const block = getBlock(blockType);
  if (!block) return null;

  let fields: readonly (FieldDef | ItemFieldDef)[] = block.fields;
  let declared: FieldDef | ItemFieldDef | null = null;

  for (const segment of path) {
    if (segment.kind === "item") {
      // A row narrows the vocabulary to its list's own fields. A path that
      // reaches `item:` without a list before it is refused by the parser, so
      // there is nothing to check for here.
      const list = declared && "itemFields" in declared ? declared.itemFields : undefined;
      if (!list) return null;
      fields = list;
      declared = null;
      continue;
    }
    const found = fields.find((field) => field.name === segment.name);
    if (!found) return null;
    declared = found;
    fields = [];
  }
  return declared;
}

/**
 * What kind of node an address names.
 *
 * `field:links` is a list, `field:links/item:i_…` is a row, and
 * `field:links/item:i_…/field:label` is that row's label. The path grammar
 * already distinguishes the three; this adds what the registry knows about the
 * leaf.
 */
export function layerKindOf(blockType: string, relativePath: string): LayerKind {
  const path = parseNodePath(relativePath);
  if (!path) return "field";
  if (!path.length) return "section";
  if (path[path.length - 1]!.kind === "item") return "item";

  const declared = declarationAt(blockType, path);
  if (!declared) return "field";
  const type = declared.type ?? "text";
  switch (type) {
    case "text":
      return "text";
    case "textarea":
      return "multiline";
    case "richtext":
      return "richtext";
    case "media":
      return "media";
    case "icon":
      return "icon";
    case "link":
      return "link";
    case "items":
      return "list";
    default:
      return "field";
  }
}

/**
 * Whether a node may be typed into on the canvas, and how.
 *
 * Plain text only, and deliberately so. `richtext` is excluded because editing
 * it directly would mean a second rich-text implementation beside the
 * inspector's, with its own idea of what markup is allowed — and the sanitizer
 * is the one thing standing between an editor and stored HTML. A media id, a
 * link, a number and a boolean are not text at all: they have controls, and the
 * control is where they are edited.
 *
 * The inspector remains the complete editor for everything, including these.
 */
export type DirectEdit = { multiline: boolean; localised: boolean };

export function directEditAt(blockType: string, relativePath: string): DirectEdit | null {
  const path = parseNodePath(relativePath);
  if (!path?.length) return null;
  if (path[path.length - 1]!.kind === "item") return null;

  const declared = declarationAt(blockType, path);
  if (!declared) return null;
  const type = declared.type ?? "text";
  if (type !== "text" && type !== "textarea") return null;
  return { multiline: type === "textarea", localised: declared.localised === true };
}

/**
 * Writes a typed string into the section's values at a path.
 *
 * This is the whole of the direct-editing write path, and the shape of it is
 * the point: it takes the values the server loaded, a stable address and a
 * string, and returns new values. It never sees the DOM, never parses markup
 * and never touches the database. What the canvas contributes is the text a
 * person typed; where that text belongs is decided here, from the registry.
 *
 * Returns null when the path does not name something directly editable, so a
 * message naming a node that is not a plain-text field changes nothing rather
 * than inventing a field to hold it.
 */
export function applyTextAt(
  values: Record<string, unknown>,
  blockType: string,
  relativePath: string,
  locale: Locale,
  text: string,
): Record<string, unknown> | null {
  const spec = directEditAt(blockType, relativePath);
  if (!spec) return null;
  const path = parseNodePath(relativePath);
  if (!path?.length) return null;

  const leaf = path[path.length - 1]!;
  const container = path.slice(0, -1);

  /**
   * The row or the section's own values object that holds the leaf.
   *
   * Rebuilt on the way down rather than mutated: a buffer that is shared with
   * the inspector must not change underneath a render that is already using it.
   */
  const root = { ...values };
  let parent: Record<string, unknown> = root;

  for (let i = 0; i < container.length; i += 1) {
    const segment = container[i]!;
    if (segment.kind === "item") {
      // The row by its own `_id`, never by position — the identity has to
      // survive a reorder, which is the entire reason `_id` exists.
      const list = parent[container[i - 1]!.name];
      if (!Array.isArray(list)) return null;
      const index = list.findIndex(
        (row) =>
          typeof row === "object" && row !== null && (row as Record<string, unknown>)[ITEM_ID_KEY] === segment.name,
      );
      if (index === -1) return null;
      const copy = [...list];
      const row = { ...(copy[index] as Record<string, unknown>) };
      copy[index] = row;
      // The list lives on the object one step up, which is where the copy goes.
      parent[container[i - 1]!.name] = copy;
      parent = row;
      continue;
    }
    // A plain field on the way down is only meaningful as the list a following
    // `item:` selects from, and that branch reads it itself.
    if (container[i + 1]?.kind !== "item") return null;
  }

  const existing = parent[leaf.name];
  if (spec.localised) {
    const current =
      typeof existing === "object" && existing !== null
        ? (existing as { en?: unknown; ar?: unknown })
        : {};
    parent[leaf.name] = {
      en: locale === "en" ? text : String(current.en ?? ""),
      ar: locale === "ar" ? text : String(current.ar ?? ""),
    };
  } else {
    // Not localised: one value for both editions, which is what the registry
    // declared and what the inspector writes too.
    parent[leaf.name] = text;
  }
  return root;
}

/**
 * Reads back what `applyTextAt` would be writing over — what the canvas should
 * be showing for this node in this edition.
 *
 * Deliberately not `values.text()`: that falls back to English when Arabic is
 * empty, which is right for *rendering* and wrong for *editing*. An empty
 * Arabic field must present as empty, or the first keystroke would append to an
 * English sentence the editor never chose to translate.
 */
export function textAt(
  values: Record<string, unknown>,
  blockType: string,
  relativePath: string,
  locale: Locale,
): string | null {
  const spec = directEditAt(blockType, relativePath);
  if (!spec) return null;
  const path = parseNodePath(relativePath);
  if (!path?.length) return null;

  const leaf = path[path.length - 1]!;
  const container = path.slice(0, -1);
  let parent: Record<string, unknown> = values;

  for (let i = 0; i < container.length; i += 1) {
    const segment = container[i]!;
    if (segment.kind === "item") {
      const list = parent[container[i - 1]!.name];
      if (!Array.isArray(list)) return null;
      const row = list.find(
        (entry) =>
          typeof entry === "object" && entry !== null && (entry as Record<string, unknown>)[ITEM_ID_KEY] === segment.name,
      );
      if (!row) return null;
      parent = row as Record<string, unknown>;
      continue;
    }
    if (container[i + 1]?.kind !== "item") return null;
  }

  const raw = parent[leaf.name];
  if (spec.localised) {
    if (typeof raw !== "object" || raw === null) return typeof raw === "string" ? raw : "";
    const pair = raw as { en?: unknown; ar?: unknown };
    return String((locale === "ar" ? pair.ar : pair.en) ?? "");
  }
  return typeof raw === "string" ? raw : "";
}

/* -------------------------------------------------------------------------- */
/* Ancestry                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Every address that contains this one, outermost first, ending with the node
 * itself.
 *
 * Built by parsing and re-formatting rather than by cutting the string at
 * slashes: an item id contains no slash today, but a rule that depends on that
 * is a rule that breaks quietly the day the alphabet changes. The parser is the
 * one definition of what a path is, and this uses it.
 */
export function ancestorAddresses(address: string): string[] {
  const parsed = parseAddress(address);
  if (!parsed) return [];
  const out: string[] = [formatAddress(parsed.sectionId, [])];
  for (let depth = 1; depth <= parsed.path.length; depth += 1) {
    out.push(formatAddress(parsed.sectionId, parsed.path.slice(0, depth)));
  }
  return out;
}

/** Whether `address` sits inside `ancestor`. A node does not contain itself. */
export function isDescendantAddress(ancestor: string, address: string): boolean {
  const outer = parseAddress(ancestor);
  const inner = parseAddress(address);
  if (!outer || !inner) return false;
  if (outer.sectionId !== inner.sectionId) return false;
  if (inner.path.length <= outer.path.length) return false;
  return outer.path.every(
    (segment, index) =>
      segment.kind === inner.path[index]!.kind && segment.name === inner.path[index]!.name,
  );
}

/** The address of the node that contains this one, or null at a section root. */
export function parentAddress(address: string): string | null {
  const parsed = parseAddress(address);
  if (!parsed || !parsed.path.length) return null;
  return formatAddress(parsed.sectionId, parsed.path.slice(0, -1));
}

/* -------------------------------------------------------------------------- */
/* The tree                                                                    */
/* -------------------------------------------------------------------------- */

export type LayerNode = {
  address: string;
  relativePath: string;
  kind: LayerKind;
  group: LayerGroup;
  /** What to call the row. A repeatable row is named by its own words. */
  label: string;
  /** Depth below the section root: a top-level field is 1. */
  depth: number;
  children: LayerNode[];
};

/**
 * The tree for one section, assembled from the nodes the canvas reported.
 *
 * Two rules, and both of them are about not inventing anything:
 *
 *   · **Only what the canvas rendered.** A field the page does not draw — a
 *     media slot with nothing in it, a CTA that is switched off — has no
 *     annotated element, so it gets no row. The tree is a view of what can
 *     actually be pointed at, not of what the registry allows.
 *   · **Nesting comes from the parsed address, not from the DOM.** A card's
 *     label is inside its row because its *path* says so. Reading the
 *     containment out of the markup would make the tree a description of how
 *     the page happens to be built today.
 *
 * A node whose parent the canvas did not report is attached to the nearest
 * ancestor that it did, and to the section root if there is none. So a block
 * that annotates a label without annotating the row around it still produces a
 * usable tree rather than a lost row.
 */
export function buildLayerTree(
  blockType: string,
  nodes: readonly { address: string; relativePath: string; text?: string }[],
  options: { values?: Record<string, unknown>; locale?: Locale } = {},
): LayerNode[] {
  const roots: LayerNode[] = [];
  const byAddress = new Map<string, LayerNode>();

  const ordered = [...nodes]
    .map((node) => ({ node, path: parseNodePath(node.relativePath) }))
    .filter((entry): entry is { node: (typeof nodes)[number]; path: NodePath } => Boolean(entry.path?.length))
    // Shallowest first, so a parent is always in the map before its children.
    .sort((a, b) => a.path.length - b.path.length);

  for (const { node, path } of ordered) {
    const relative = formatNodePath(path);
    if (byAddress.has(node.address)) continue;

    const kind = layerKindOf(blockType, relative);
    const entry: LayerNode = {
      address: node.address,
      relativePath: relative,
      kind,
      group: layerGroupOf(kind),
      label: labelFor(blockType, relative, kind, node.text, options),
      depth: path.length,
      children: [],
    };
    byAddress.set(entry.address, entry);

    // Nearest reported ancestor, innermost first.
    const ancestors = ancestorAddresses(entry.address).slice(0, -1).reverse();
    const parent = ancestors.map((candidate) => byAddress.get(candidate)).find(Boolean);
    if (parent) parent.children.push(entry);
    else roots.push(entry);
  }

  return roots;
}

/**
 * A row's name.
 *
 * A repeatable row is named by the words on it, because "Item" is not something
 * an editor can act on — from what the canvas could see, or, when the row is
 * hidden and there is nothing on screen to read, from the section's own values
 * by the row's `_id`. Everything else is named by the registry.
 */
function labelFor(
  blockType: string,
  relativePath: string,
  kind: LayerKind,
  text: string | undefined,
  options: { values?: Record<string, unknown>; locale?: Locale },
): string {
  const declared = declarationAt(blockType, parseNodePath(relativePath) ?? []);
  if (kind !== "item") {
    if (declared?.label) return declared.label;
    const path = parseNodePath(relativePath);
    const last = path?.[path.length - 1];
    return last ? humanise(last.name) : "Node";
  }

  const fromCanvas = text?.trim();
  if (fromCanvas) return truncate(fromCanvas);
  const stored = options.values ? rowText(blockType, relativePath, options.values, options.locale ?? "en") : "";
  return stored ? truncate(stored) : "Item";
}

const humanise = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (character) => character.toUpperCase());

const truncate = (value: string, max = 40): string =>
  value.length > max ? `${value.slice(0, max - 1).trimEnd()}…` : value;

/** A row's primary text, read from the values by `_id`. */
function rowText(
  blockType: string,
  relativePath: string,
  values: Record<string, unknown>,
  locale: Locale,
): string {
  const path = parseNodePath(relativePath);
  if (!path?.length) return "";
  const last = path[path.length - 1]!;
  if (last.kind !== "item") return "";

  const listName = path[path.length - 2]?.name;
  if (!listName) return "";
  const list = values[listName];
  if (!Array.isArray(list)) return "";
  const row = list.find(
    (entry) =>
      typeof entry === "object" && entry !== null && (entry as Record<string, unknown>)[ITEM_ID_KEY] === last.name,
  ) as Record<string, unknown> | undefined;
  if (!row) return "";

  const declared = declarationAt(blockType, path.slice(0, -1));
  const primary = declared && "itemFields" in declared ? declared.itemFields?.[0]?.name : undefined;
  const raw = primary ? row[primary] : undefined;
  if (typeof raw === "string") return raw.trim();
  if (typeof raw === "object" && raw !== null) {
    const pair = raw as { en?: unknown; ar?: unknown };
    return String((locale === "ar" ? pair.ar : pair.en) ?? "").trim();
  }
  return "";
}
