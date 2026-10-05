import "server-only";

import { formBase, type FormUnit, type Prints, type SaveDecision } from "@/lib/admin/form-base";
import { checkbox, field, numberField, optionalId } from "@/lib/admin/form-readers";
import { sanitizeRichText } from "@/lib/cms/sanitize";
import type { LocalisedItem, LocalisedStep } from "@/lib/db/schema";
import { isPresetKey } from "@/lib/forms/presets";

/**
 * The Services form's fields, read one way, and the base it is saved against
 * (Batch 23, docs/admin/services-form-concurrency.md).
 *
 * The form used to write every column it held, so a form opened before
 * somebody else's change put the older values back when it was saved. Now the
 * page signs what each field was when it was drawn, the form posts that back,
 * and the server writes only what the form changed — refusing, whole, a change
 * to a field that moved elsewhere in the meantime. The mechanism is shared
 * with the Packages and Destinations forms since Batch 24
 * (`lib/admin/form-base.ts`); what is here is the Services form's own: its
 * fields, its reader and its units.
 */

/** Parses one of the hidden JSON lists the list editors submit. */
function itemList(form: FormData, name: string, max = 16): LocalisedItem[] {
  try {
    const raw = JSON.parse(String(form.get(name) ?? "[]")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((row) => {
        const record = (typeof row === "object" && row ? row : {}) as Record<string, unknown>;
        return {
          en: String(record.en ?? "").slice(0, 400).trim(),
          ar: String(record.ar ?? "").slice(0, 400).trim(),
        };
      })
      .filter((row) => row.en || row.ar)
      .slice(0, max);
  } catch {
    return [];
  }
}

function stepList(form: FormData, name: string, max = 10): LocalisedStep[] {
  try {
    const raw = JSON.parse(String(form.get(name) ?? "[]")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((row) => {
        const record = (typeof row === "object" && row ? row : {}) as Record<string, unknown>;
        return {
          en: String(record.en ?? "").slice(0, 200).trim(),
          ar: String(record.ar ?? "").slice(0, 200).trim(),
          detailEn: String(record.detailEn ?? "").slice(0, 800).trim(),
          detailAr: String(record.detailAr ?? "").slice(0, 800).trim(),
        };
      })
      .filter((row) => row.en || row.ar)
      .slice(0, max);
  } catch {
    return [];
  }
}

/** Every field the Services form posts, trimmed, capped and sanitized — the one reader, for a submission and for a stored row alike. */
export function readServiceForm(form: FormData) {
  const preset = field(form, "formPreset", 32);
  return {
    categoryId: Number(form.get("categoryId")),
    subcategoryId: optionalId(form, "subcategoryId"),
    titleEn: field(form, "titleEn", 190),
    titleAr: field(form, "titleAr", 190),
    introEn: field(form, "introEn", 2000),
    introAr: field(form, "introAr", 2000),
    bodyEn: sanitizeRichText(field(form, "bodyEn", 20000)),
    bodyAr: sanitizeRichText(field(form, "bodyAr", 20000)),
    benefits: itemList(form, "benefits"),
    audience: itemList(form, "audience"),
    requirements: itemList(form, "requirements"),
    processSteps: stepList(form, "processSteps"),
    timelineEn: field(form, "timelineEn", 190),
    timelineAr: field(form, "timelineAr", 190),
    notesEn: sanitizeRichText(field(form, "notesEn", 8000)),
    notesAr: sanitizeRichText(field(form, "notesAr", 8000)),
    formPreset: isPresetKey(preset) ? preset : "general",
    imageId: optionalId(form, "imageId"),
    isFeatured: checkbox(form, "isFeatured"),
    isPublished: checkbox(form, "isPublished"),
    sortOrder: numberField(form, "sortOrder", 0),
  };
}

export type ServiceFormValues = ReturnType<typeof readServiceForm>;
type FieldName = keyof ServiceFormValues;

/**
 * The units a save is decided in. One per column, except the category and the
 * group, which only make sense together (a group belongs to a category), and
 * each list, which is a positional array with nothing finer to merge on.
 */
export const SERVICE_FORM_UNITS: readonly FormUnit<FieldName>[] = [
  { key: "placement", label: "Category and group", fields: ["categoryId", "subcategoryId"], canon: "value" },
  { key: "titleEn", label: "Title (English)", fields: ["titleEn"], canon: "line" },
  { key: "titleAr", label: "Title (Arabic)", fields: ["titleAr"], canon: "line" },
  { key: "introEn", label: "Short introduction (English)", fields: ["introEn"], canon: "text" },
  { key: "introAr", label: "Short introduction (Arabic)", fields: ["introAr"], canon: "text" },
  { key: "bodyEn", label: "Detailed content (English)", fields: ["bodyEn"], canon: "text" },
  { key: "bodyAr", label: "Detailed content (Arabic)", fields: ["bodyAr"], canon: "text" },
  { key: "benefits", label: "Key benefits", fields: ["benefits"], canon: "value" },
  { key: "audience", label: "Who this service is for", fields: ["audience"], canon: "value" },
  { key: "requirements", label: "Documents and requirements", fields: ["requirements"], canon: "value" },
  { key: "processSteps", label: "How the process runs", fields: ["processSteps"], canon: "value" },
  { key: "timelineEn", label: "Indicative timeline (English)", fields: ["timelineEn"], canon: "line" },
  { key: "timelineAr", label: "Indicative timeline (Arabic)", fields: ["timelineAr"], canon: "line" },
  { key: "notesEn", label: "Important notes (English)", fields: ["notesEn"], canon: "text" },
  { key: "notesAr", label: "Important notes (Arabic)", fields: ["notesAr"], canon: "text" },
  { key: "formPreset", label: "Request form", fields: ["formPreset"], canon: "value" },
  { key: "imageId", label: "Image", fields: ["imageId"], canon: "value" },
  { key: "isFeatured", label: "Featured", fields: ["isFeatured"], canon: "value", checkbox: true },
  { key: "isPublished", label: "Published", fields: ["isPublished"], canon: "value", checkbox: true },
  { key: "sortOrder", label: "Order", fields: ["sortOrder"], canon: "value" },
];

/** The signing purpose is the one Batch 23 shipped, so a page drawn before an upgrade still saves after it. */
const BASE = formBase<ServiceFormValues>({ purpose: "service-form-base", units: SERVICE_FORM_UNITS });

export type { Prints };

export const printsOf = BASE.printsOf;

/** The columns of a stored service the form edits. */
export type ServiceFormRow = Omit<ServiceFormValues, "formPreset"> & { formPreset: string };

/**
 * A stored row as the form an untouched page would post for it — so a row is
 * read by exactly the reader a submission is, and an untouched field always
 * compares equal to what it was drawn from.
 */
export function formOfRow(row: ServiceFormRow): FormData {
  const form = new FormData();
  form.set("categoryId", String(row.categoryId));
  form.set("subcategoryId", row.subcategoryId ? String(row.subcategoryId) : "");
  for (const name of ["titleEn", "titleAr", "introEn", "introAr", "bodyEn", "bodyAr", "timelineEn", "timelineAr", "notesEn", "notesAr", "formPreset"] as const) {
    form.set(name, row[name] ?? "");
  }
  for (const name of ["benefits", "audience", "requirements", "processSteps"] as const) {
    form.set(name, JSON.stringify(row[name] ?? []));
  }
  form.set("imageId", row.imageId ? String(row.imageId) : "");
  if (row.isFeatured) form.set("isFeatured", "on");
  if (row.isPublished) form.set("isPublished", "on");
  form.set("sortOrder", String(row.sortOrder));
  return form;
}

export const rowValues = (row: ServiceFormRow): ServiceFormValues => readServiceForm(formOfRow(row));

/**
 * The units a submission speaks for. A browser posts every field of the form;
 * anything else is not taken as an instruction to blank a column — except a
 * checkbox, whose absence is how HTML says "off".
 */
export const submittedUnits = BASE.submittedUnits;

/* -------------------------------------------------------------------------- */
/* The signed base and the decision                                           */
/* -------------------------------------------------------------------------- */

/** The base the edit page renders beside the values it drew: fingerprints only, never values. */
export const signServiceBase = BASE.signBase;

/** The fingerprints a form was drawn with, if the token is ours, current and for this service — otherwise `null`. */
export const readServiceBase = BASE.readBase;

export type ServiceSaveDecision = SaveDecision;

/** Brief §5's rule, unit by unit (docs/admin/services-form-concurrency.md §4). */
export const decideServiceSave = BASE.decide;

export const unitLabel = BASE.unitLabel;

/** The columns a set of units writes, taken from the submission. */
export const valuesOfUnits = BASE.valuesOfUnits;
