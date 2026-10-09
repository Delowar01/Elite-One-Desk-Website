/**
 * What a picture id is in a block's values (Batch 26): a whole number from 1
 * to 2,147,483,647 — the range of the `media.id` serial — as a JSON number.
 *
 * One reading for everything that reads one: the validator that stores it
 * (`validate.ts`), the hold that locks it before a write (`media-refs.ts`) and
 * the renderer that draws it (`values.ts`) — and the media delete's count
 * (`jsonbPictureIds`, usage.ts), which counts every JSON number a reader takes
 * for one: any whose value, read as a double as every reader here reads it, is
 * whole. The media picker sends a number; anything else where a picture
 * belongs is no picture — `12.5`, `1e21`, and text, even a string of digits:
 * a Statistics figure "15" is not picture 15.
 *
 * Before, they disagreed: the validator kept `12.5`, a Quick Links card
 * turned it into the text "12.5" and drew picture 12, and neither the hold
 * nor the count saw a picture at all — so picture 12 could be deleted from
 * under the card it was showing on.
 */
export const MAX_PICTURE_ID = 2_147_483_647;

export function pictureId(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw > 0 && raw <= MAX_PICTURE_ID ? raw : null;
}

/** The digits `items` (values.ts) carries a row's picture as, read back as its id. */
export function pictureIdOfDigits(raw: string | undefined): number | null {
  return raw !== undefined && /^[0-9]{1,10}$/.test(raw) ? pictureId(Number(raw)) : null;
}
