/**
 * Stable identity for a row inside a repeatable field.
 *
 * A repeatable list is a JSON array, so today a row is only ever addressable by
 * its position — and position is the one thing editing changes. Insert a card
 * above and every row below it becomes a different row as far as any stored
 * reference is concerned: a style override lands on the wrong card, a
 * selection jumps, an undo puts text back in the wrong place.
 *
 * `_id` is the fix, and it is the ONLY reserved key. `validateBlockValues`
 * still rebuilds every row field by field from the block registry and still
 * drops everything it does not recognise; this key is an explicit exception,
 * not a loosening of the rule.
 */

/** The one metadata key a repeatable row may carry beyond its declared fields. */
export const ITEM_ID_KEY = "_id";

/**
 * No `0/O`, `1/l/I`. These are read aloud in bug reports and typed into
 * search boxes, and the pairs that look alike cost more than the entropy they
 * add: 54^10 is still about 2^57.
 */
export const ITEM_ID_ALPHABET = "23456789abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ";

/** What `newItemId` produces today. The accepted range is wider; see below. */
const LENGTH = 10;

/**
 * `i_` then 8-16 characters **from that alphabet**, and the pattern is built
 * from the alphabet rather than written out beside it, so the two cannot drift.
 *
 * The character set is the part that matters and it is exact: a value holding
 * `0`, `O`, `1`, `l` or `I` is one this module would never have generated, so
 * treating it as ours would mean trusting an id that came from somewhere else.
 * `ensureItemIds` replaces it instead.
 *
 * The length is deliberately a range rather than exactly `LENGTH`. The alphabet
 * is a safety property; the length is a capacity one, and pinning it would mean
 * that raising it later silently reclassified every id already stored as
 * malformed — and a reassigned id takes every style override keyed to it with
 * it. The alphabet is checked in the tests to be free of the ambiguous pairs.
 */
export const ITEM_ID_PATTERN = new RegExp(`^i_[${ITEM_ID_ALPHABET}]{8,16}$`);

export const isItemId = (value: unknown): value is string =>
  typeof value === "string" && ITEM_ID_PATTERN.test(value);

/**
 * Opaque, cryptographically random, and never derived from the row's content —
 * two rows that happen to say the same thing are still two rows.
 *
 * Callable on either side. The panel mints one the moment an editor adds a row,
 * so the row has a stable identity immediately: it is the React key, it is what
 * a click on the canvas resolves to, and it is what a style override will later
 * be filed under. A row that had to wait for a round trip to become addressable
 * would be unaddressable for exactly as long as somebody was working on it.
 *
 * That is convenience, not trust. `ensureItemIds` re-checks every id that
 * arrives — same alphabet, same length range, unique within its list — and
 * replaces anything it would not have produced itself, so a client-supplied id
 * is accepted because it passes, never because the client supplied it.
 * `globalThis.crypto` is the source in both places; nothing falls back to
 * `Math.random`.
 */
export function newItemId(): string {
  const bytes = new Uint8Array(LENGTH);
  globalThis.crypto.getRandomValues(bytes);
  let out = "i_";
  for (const byte of bytes) out += ITEM_ID_ALPHABET[byte % ITEM_ID_ALPHABET.length];
  return out;
}

type Row = Record<string, unknown>;

/**
 * Gives every row a valid, unique id, changing nothing else.
 *
 * Three cases, and the third is the one that matters: a row with no id gets
 * one; a row with a valid id keeps it — which is what makes this safe to run
 * twice, and what makes a reorder a no-op; and a row whose id is malformed or
 * already used by an earlier row in the same list is reassigned, because two
 * rows answering to one address is worse than a row losing its history.
 *
 * Order is never touched. Values are never touched.
 */
export function ensureItemIds<T extends Row>(rows: readonly T[]): T[] {
  const seen = new Set<string>();
  return rows.map((row) => {
    const current = row[ITEM_ID_KEY];
    if (isItemId(current) && !seen.has(current)) {
      seen.add(current);
      return row;
    }
    let fresh = newItemId();
    while (seen.has(fresh)) fresh = newItemId();
    seen.add(fresh);
    return { ...row, [ITEM_ID_KEY]: fresh };
  });
}

/** True when every row already carries a distinct, well-formed id. */
export function hasStableItemIds(rows: readonly Row[]): boolean {
  const seen = new Set<string>();
  for (const row of rows) {
    const id = row[ITEM_ID_KEY];
    if (!isItemId(id) || seen.has(id)) return false;
    seen.add(id);
  }
  return true;
}
