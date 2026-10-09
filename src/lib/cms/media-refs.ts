import { getBlock, type BlockDef } from "./blocks";
import { pictureId } from "./media-id";
import { kindDef } from "./reuse/kinds";
import { linkedSlotOfField, readReuse } from "./reuse/reference";

/**
 * The pictures a block's values name (Batch 26).
 *
 * Read by declaration: every field the registry declares a picture — a
 * top-level `media` field, and the `media` field of each row of an `items`
 * list, which is where Quick Links keeps its cards' pictures. Never by
 * searching values, so a section's `limit` of 6 is never taken for picture 6,
 * and a block that gains a picture field is covered by declaring it. What a
 * write holds before it stores a block's values (`holdMedia`) is exactly this
 * list; the media delete counts at least these (`mediaUsage`).
 *
 * A value is read the way the validator stores it and the renderer draws it
 * (`media-id.ts`): a whole number from 1 to 2,147,483,647.
 */

type Values = Record<string, unknown>;

const isRecord = (value: unknown): value is Values =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const mediaValue = (raw: unknown): number | null => pictureId(raw);

/** Where a picture sits in a block's values, in an editor's words: "Background image", "Links — card 3, Image". */
export type MediaPlace = { id: number; field: string; row: number | null; label: string };

/** Every picture `values` names under `block`'s declaration, with where it sits. */
export function mediaPlaces(block: BlockDef | null | undefined, values: unknown): MediaPlace[] {
  if (!block || !isRecord(values)) return [];
  const out: MediaPlace[] = [];
  for (const field of block.fields) {
    if (field.type === "media") {
      const id = mediaValue(values[field.name]);
      if (id) out.push({ id, field: field.name, row: null, label: field.label });
      continue;
    }
    if (field.type !== "items") continue;
    const pictures = (field.itemFields ?? []).filter((item) => item.type === "media");
    const rows = values[field.name];
    if (!pictures.length || !Array.isArray(rows)) continue;
    rows.forEach((row, index) => {
      if (!isRecord(row)) return;
      for (const item of pictures) {
        const id = mediaValue(row[item.name]);
        if (id) out.push({ id, field: `${field.name}.${index}.${item.name}`, row: index, label: `${field.label} — card ${index + 1}, ${item.label}` });
      }
    });
  }
  return out;
}

/** The distinct picture ids, ascending. */
export const mediaIdsOf = (places: readonly MediaPlace[]): number[] =>
  [...new Set(places.map((place) => place.id))].sort((a, b) => a - b);

/** A section's pictures: its block type's declaration. */
export const sectionMediaIds = (blockType: string, values: unknown): number[] =>
  mediaIdsOf(mediaPlaces(getBlock(blockType), values));

/** A reusable component's pictures: its kind's declaration. */
export const componentMediaIds = (kind: string, values: unknown): number[] =>
  mediaIdsOf(mediaPlaces(kindDef(kind)?.definition, values));

/**
 * A section's pictures in the fields a linked reusable component supplies.
 * The section holds only a fallback copy there — the page draws the
 * component's picture — and a picture is never something a linked section can
 * override, so no editor can choose another one. A publication carries these
 * as they are and never refuses over them, as a restore leaves them out
 * without naming them (`versions.ts`).
 */
export function linkedMediaIds(blockType: string, values: unknown): number[] {
  const linked = readReuse(values, blockType);
  if (!Object.keys(linked).length) return [];
  return mediaIdsOf(
    mediaPlaces(getBlock(blockType), values).filter((place) =>
      linkedSlotOfField(blockType, linked, place.field.split(".")[0]!),
    ),
  );
}

/**
 * The same values with every picture in `gone` taken out — the field emptied,
 * as an editor clearing it would leave it — and the places it was taken from.
 * What a restore stores when a picture its version names has been deleted
 * since (decision B, docs/admin/seo-and-share-images.md B.6): the rest of the
 * version comes back, and the result says which pictures did not.
 */
export function withoutMedia(
  block: BlockDef | null | undefined,
  values: unknown,
  gone: ReadonlySet<number>,
): { values: unknown; removed: MediaPlace[] } {
  if (!block || !isRecord(values) || !gone.size) return { values, removed: [] };
  const removed = mediaPlaces(block, values).filter((place) => gone.has(place.id));
  if (!removed.length) return { values, removed };
  const out: Values = { ...values };
  for (const place of removed) {
    if (place.row === null) {
      out[place.field] = null;
      continue;
    }
    const [name, , item] = place.field.split(".") as [string, string, string];
    const rows = (Array.isArray(out[name]) ? [...(out[name] as unknown[])] : []) as unknown[];
    const row = rows[place.row];
    if (isRecord(row)) rows[place.row] = { ...row, [item]: null };
    out[name] = rows;
  }
  return { values: out, removed };
}

/** A picture a restore left out (decision B): where it was, in an editor's words, and which picture it was. */
export type LeftOut = { place: string; picture: number };

/** What a refused write was: the words its refusal uses. */
export type RefusedWrite = "save" | "publish" | "copy" | "detach";
const REFUSED: Record<RefusedWrite, { done: string; again: string }> = {
  save: { done: "saved", again: "save again" },
  publish: { done: "published", again: "publish again" },
  copy: { done: "copied", again: "copy it again" },
  detach: { done: "detached", again: "detach it again" },
};

/**
 * What an editor reads when a picture a write would bring in has been deleted
 * from the library — naming the field, when the values say where it was.
 */
export function picturesGoneMessage(places: readonly MediaPlace[], gone: readonly number[], write: RefusedWrite = "save"): string {
  const labels = [...new Set(places.filter((place) => gone.includes(place.id)).map((place) => `“${place.label}”`))];
  const where = labels.length ? `The picture in ${labels.join(", ")} is` : gone.length > 1 ? "Pictures this change uses are" : "A picture this change uses is";
  const { done, again } = REFUSED[write];
  return `${where} no longer in the media library. Nothing was ${done}. Choose another picture, then ${again}.`;
}
