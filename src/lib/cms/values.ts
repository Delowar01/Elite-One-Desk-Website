import type { Locale } from "@/lib/i18n/config";
import { pick } from "@/lib/i18n/config";
import { ITEM_ID_KEY } from "./item-id";
import type { BlockDef, FieldDef } from "./blocks";

export type LocalisedValue = { en: string; ar: string };
export type BlockValues = Record<string, unknown>;

const isLocalised = (v: unknown): v is LocalisedValue =>
  typeof v === "object" && v !== null && ("en" in v || "ar" in v);

/** Reads a localised field, falling back to English when Arabic is empty. */
export function text(values: BlockValues, name: string, locale: Locale): string {
  const raw = values?.[name];
  if (isLocalised(raw)) return pick(locale, String(raw.en ?? ""), String(raw.ar ?? ""));
  return typeof raw === "string" ? raw : "";
}

export function str(values: BlockValues, name: string, fallback = ""): string {
  const raw = values?.[name];
  return typeof raw === "string" && raw.trim() ? raw : fallback;
}

export function num(values: BlockValues, name: string, fallback = 0): number {
  const raw = values?.[name];
  const parsed = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function bool(values: BlockValues, name: string, fallback = false): boolean {
  const raw = values?.[name];
  return typeof raw === "boolean" ? raw : fallback;
}

export function mediaId(values: BlockValues, name: string): number | null {
  const raw = values?.[name];
  const id = typeof raw === "number" ? raw : Number.parseInt(String(raw ?? ""), 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

export type BlockItem = Record<string, string>;

/**
 * Reads a repeatable list, resolving each item's localised sub-fields down to
 * plain strings for the current language. Rows whose first field is empty are
 * dropped, so a half-filled row in the panel never renders as a blank card.
 */
export function items(
  values: BlockValues,
  name: string,
  locale: Locale,
  fields: readonly { name: string; localised?: boolean; type?: string }[],
): BlockItem[] {
  const raw = values?.[name];
  if (!Array.isArray(raw)) return [];
  const primary = fields[0]?.name;
  return raw
    .map((row) => {
      if (typeof row !== "object" || row === null) return null;
      const record = row as Record<string, unknown>;
      const out: BlockItem = {};
      // The row's stable id, read back so a later batch can address it. No
      // renderer uses it, and nothing about it reaches the page.
      if (typeof record[ITEM_ID_KEY] === "string") out[ITEM_ID_KEY] = record[ITEM_ID_KEY];
      for (const field of fields) {
        const value = record[field.name];
        // A media field is stored as a number. A row is a flat string record —
        // that is what keeps every renderer's reads simple — so the id comes
        // back through `itemMediaId` rather than widening the row type for the
        // one field that is not text.
        if (field.type === "media") {
          out[field.name] = typeof value === "number" && value > 0 ? String(value) : "";
          continue;
        }
        out[field.name] = field.localised && isLocalised(value)
          ? pick(locale, String(value.en ?? ""), String(value.ar ?? ""))
          : typeof value === "string"
            ? value
            : "";
      }
      return out;
    })
    .filter((row): row is BlockItem => Boolean(row && (!primary || row[primary]?.trim())));
}

/** A repeatable row's `media` field, read back as a library id. */
export function itemMediaId(row: BlockItem, name: string): number | null {
  const id = Number.parseInt(row[name] ?? "", 10);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/** Empty shell for a new section, so the admin form always has every key. */
export function emptyValues(block: BlockDef): BlockValues {
  const out: BlockValues = {};
  for (const field of block.fields) out[field.name] = emptyField(field);
  return out;
}

function emptyField(field: FieldDef): unknown {
  switch (field.type) {
    case "items":
      return [];
    case "boolean":
      return false;
    case "number":
      return 0;
    case "media":
      return null;
    default:
      return field.localised ? { en: "", ar: "" } : "";
  }
}
