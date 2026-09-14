import { getBlock, type BlockDef } from "./blocks";
import { ITEM_ID_KEY, ensureItemIds, hasStableItemIds } from "./item-id";

/**
 * Giving the rows already in the database the stable ids new rows get on save.
 *
 * Every row saved from now on is stamped by `validateBlockValues`. The rows
 * written before this batch are not, and a visual editor cannot address what
 * has no address — so the existing sections need the same key, once, without
 * anybody having to remember to run something.
 *
 * The rules this is built to keep, all of which the tests assert:
 *
 *   · **Registry-driven.** Only fields the block declares as `items` are
 *     considered. An unknown block type is skipped entirely rather than
 *     guessed at.
 *   · **Additive.** The only key that ever appears is `_id`. No value is
 *     rewritten, no row is reordered, no localisation is touched, no media id,
 *     link or icon moves.
 *   · **Idempotent.** A row that already has a well-formed, unique id keeps
 *     it, so the second run finds nothing to do and writes nothing at all.
 *   · **Conservative.** Anything that is not a plain array of plain objects is
 *     left exactly as it is. This is a backfill, not a repair: a value that has
 *     somehow become a string is a separate problem and must not be rewritten
 *     into `{0: "h", 1: "i", _id: …}` by a helper meant to add metadata.
 */

/** The names of a block's repeatable fields. The registry is the only source. */
export const repeatableFields = (block: BlockDef): string[] =>
  block.fields.filter((field) => field.type === "items").map((field) => field.name);

const isRow = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isRowArray = (value: unknown): value is Record<string, unknown>[] =>
  Array.isArray(value) && value.every(isRow);

/**
 * The document a section should hold, or `null` when it already holds it.
 *
 * `null` rather than `{ changed: false }` so that "there is nothing to write"
 * is the shape of the answer rather than a flag a caller can forget to read.
 */
export function backfillItemIds(
  blockType: string,
  values: unknown,
): Record<string, unknown> | null {
  const block = getBlock(blockType);
  if (!block || !isRow(values)) return null;

  let out: Record<string, unknown> | null = null;
  for (const name of repeatableFields(block)) {
    const rows = values[name];
    if (!isRowArray(rows) || hasStableItemIds(rows)) continue;
    out ??= { ...values };
    out[name] = ensureItemIds(rows);
  }
  return out;
}

/**
 * Everything about a section except its row ids, for the equivalence test.
 *
 * Two documents that agree here render the same page: same fields, same order,
 * same values, same rows in the same sequence. It is what "the backfill changed
 * nothing" has to mean, and stripping `_id` is the whole difference between
 * before and after.
 */
export function withoutItemIds(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutItemIds);
  if (!isRow(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key === ITEM_ID_KEY) continue;
    out[key] = withoutItemIds(inner);
  }
  return out;
}
