import { formatNodePath, parseNodePath } from "./address";
import { ITEM_ID_KEY, isItemId, newItemId } from "./item-id";
import { validateStyleDocument, type StyleDocument } from "./styles";

/**
 * Making a copy of a section that is genuinely a different thing.
 *
 * A duplicate could keep the original's repeatable `_id`s. Style paths are
 * section-relative, so two rows in two sections carrying the same id never
 * resolve to each other, and the copy's styles would line up for free. That is
 * the cheap answer, and it is the one this module deliberately does not take.
 *
 * An id is an identity. Two rows in the database claiming the same one is a
 * coincidence that holds only as long as nothing ever compares them across
 * sections — a copy between pages, a log keyed by row, an analytics event, a
 * later batch that merges two structures. Each of those would be correct today
 * and wrong the moment the coincidence was relied on, and the failure would
 * look like one card's styling appearing on another card in another section.
 *
 * So the copy gets **fresh ids**, and the style document is remapped through
 * the same table in the same pass — which is the part that makes the choice
 * safe rather than merely tidy. An override on the third card of the original
 * lands on the third card of the copy because the map says so, not because the
 * two share a name. Nothing is regenerated in the original: it is read, never
 * written.
 */

type Row = Record<string, unknown>;

/** Old id → new id, for everything repeatable in one section's values. */
export type IdMap = ReadonlyMap<string, string>;

/**
 * A copy of `values` with every repeatable row's `_id` replaced.
 *
 * Only the reserved key is touched; every other field is carried across as it
 * was, and the caller runs the result through the registry validator anyway.
 * A row without a usable id is given one, because the copy is being written now
 * and there is no reason for it to inherit the original's gap.
 */
export function withFreshItemIds(values: Record<string, unknown>): {
  values: Record<string, unknown>;
  ids: IdMap;
} {
  const ids = new Map<string, string>();
  const out: Record<string, unknown> = { ...values };

  for (const [field, value] of Object.entries(values)) {
    if (!Array.isArray(value)) continue;
    let touched = false;
    const rows = value.map((entry) => {
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
      const row = entry as Row;
      const previous = row[ITEM_ID_KEY];
      const fresh = newItemId();
      if (isItemId(previous)) ids.set(previous, fresh);
      touched = true;
      return { ...row, [ITEM_ID_KEY]: fresh };
    });
    if (touched) out[field] = rows;
  }

  return { values: out, ids };
}

/**
 * The same document, pointing at the copy's rows instead of the original's.
 *
 * Paths are rebuilt through the Batch 2 parser rather than string-replaced: a
 * substitution on the raw key would match an id that happened to appear inside
 * a field name, and would leave a path the parser refuses if anything else were
 * malformed. A node naming a row the map does not know is dropped — it can only
 * be an override for a row the copy does not have.
 */
export function remapStyleItemIds(document: StyleDocument, ids: IdMap): StyleDocument {
  if (!ids.size) return validateStyleDocument(document);

  const nodes: StyleDocument["nodes"] = {};
  for (const [path, node] of Object.entries(document.nodes)) {
    const parsed = parseNodePath(path);
    if (!parsed) continue;

    let dropped = false;
    const moved = parsed.map((segment) => {
      if (segment.kind !== "item") return segment;
      const fresh = ids.get(segment.name);
      if (!fresh) {
        dropped = true;
        return segment;
      }
      return { ...segment, name: fresh };
    });
    if (dropped) continue;

    nodes[formatNodePath(moved)] = node;
  }

  return validateStyleDocument({ v: document.v, nodes });
}
