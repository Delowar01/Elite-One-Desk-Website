import "server-only";

import { formBase, type FormUnit } from "@/lib/admin/form-base";
import { checkbox, field, numberField, optionalId } from "@/lib/admin/form-readers";
import { sanitizeRichText } from "@/lib/cms/sanitize";
import type { LocalisedItem } from "@/lib/db/schema";

/**
 * The Packages and Destinations forms' fields, read one way, and the base each
 * is saved against (Batch 24, after Batch 23's Services form —
 * docs/admin/services-form-concurrency.md, §10).
 *
 * Both forms used to write every column they held. That was harmless while
 * nothing else wrote a package or a destination; since Batch 24 the Visual
 * Editor publishes both — a package's own page, its card on Tour packages, a
 * destination's page and its group — so a form opened before a publication and
 * saved after it would have put the older values back. Now each edit page
 * signs what every field was when it was drawn, and the update writes only
 * what the form changed, refusing, whole, a change to a field that moved
 * elsewhere in the meantime. The mechanism is `lib/admin/form-base.ts`; what
 * is here is each form's own: its fields, its reader and its units.
 */

/** A package's highlights, as the list editor posts them: at most 16 rows of at most 300 characters. */
function highlights(form: FormData): LocalisedItem[] {
  try {
    const raw = JSON.parse(String(form.get("highlights") ?? "[]")) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .map((row) => {
        const record = (typeof row === "object" && row ? row : {}) as Record<string, unknown>;
        return {
          en: String(record.en ?? "").slice(0, 300).trim(),
          ar: String(record.ar ?? "").slice(0, 300).trim(),
        };
      })
      .filter((row) => row.en || row.ar)
      .slice(0, 16);
  } catch {
    return [];
  }
}

/**
 * LEGACY. `region` is no longer how packages are grouped — `destinationId` is —
 * but the column keeps the values it already holds, `egypt` among them, and
 * nothing here rewrites one. A saved record therefore comes back with the
 * region it went in with.
 */
const REGIONS = ["egypt", "international", "holiday", "corporate"] as const;
type Region = (typeof REGIONS)[number];
const isRegion = (value: string): value is Region => (REGIONS as readonly string[]).includes(value);

/* -------------------------------------------------------------------------- */
/* A package                                                                  */
/* -------------------------------------------------------------------------- */

/** Every field the Packages form posts, trimmed, capped and sanitized — the one reader, for a submission and a stored row alike. */
export function readPackageForm(form: FormData) {
  const region = field(form, "region", 32);
  return {
    region: isRegion(region) ? region : ("international" as Region),
    destinationId: optionalId(form, "destinationId"),
    titleEn: field(form, "titleEn", 190),
    titleAr: field(form, "titleAr", 190),
    destinationEn: field(form, "destinationEn", 120),
    destinationAr: field(form, "destinationAr", 120),
    durationEn: field(form, "durationEn", 80),
    durationAr: field(form, "durationAr", 80),
    summaryEn: field(form, "summaryEn", 2000),
    summaryAr: field(form, "summaryAr", 2000),
    bodyEn: sanitizeRichText(field(form, "bodyEn", 20000)),
    bodyAr: sanitizeRichText(field(form, "bodyAr", 20000)),
    highlights: highlights(form),
    imageId: optionalId(form, "imageId"),
    isFeatured: checkbox(form, "isFeatured"),
    isPublished: checkbox(form, "isPublished"),
    sortOrder: numberField(form, "sortOrder", 0),
  };
}

export type PackageFormValues = ReturnType<typeof readPackageForm>;

/**
 * One unit per column. English and Arabic are separate units, so an English
 * correction and an Arabic one made at the same time both survive; the
 * highlights are one unit, a positional list with nothing finer to merge on.
 * The address is not a unit: a package's address is fixed once it exists.
 */
export const PACKAGE_FORM_UNITS: readonly FormUnit<keyof PackageFormValues>[] = [
  { key: "destinationId", label: "Destination it is listed under", fields: ["destinationId"], canon: "value" },
  { key: "region", label: "Region (legacy)", fields: ["region"], canon: "value" },
  { key: "titleEn", label: "Title (English)", fields: ["titleEn"], canon: "line" },
  { key: "titleAr", label: "Title (Arabic)", fields: ["titleAr"], canon: "line" },
  { key: "destinationEn", label: "Destination (English)", fields: ["destinationEn"], canon: "line" },
  { key: "destinationAr", label: "Destination (Arabic)", fields: ["destinationAr"], canon: "line" },
  { key: "durationEn", label: "Duration (English)", fields: ["durationEn"], canon: "line" },
  { key: "durationAr", label: "Duration (Arabic)", fields: ["durationAr"], canon: "line" },
  { key: "summaryEn", label: "Summary (English)", fields: ["summaryEn"], canon: "text" },
  { key: "summaryAr", label: "Summary (Arabic)", fields: ["summaryAr"], canon: "text" },
  { key: "bodyEn", label: "Detail (English)", fields: ["bodyEn"], canon: "text" },
  { key: "bodyAr", label: "Detail (Arabic)", fields: ["bodyAr"], canon: "text" },
  { key: "highlights", label: "What the programme includes", fields: ["highlights"], canon: "value" },
  { key: "imageId", label: "Image", fields: ["imageId"], canon: "value" },
  { key: "isFeatured", label: "Featured", fields: ["isFeatured"], canon: "value", checkbox: true },
  { key: "isPublished", label: "Published", fields: ["isPublished"], canon: "value", checkbox: true },
  { key: "sortOrder", label: "Order", fields: ["sortOrder"], canon: "value" },
];

export const PACKAGE_FORM = formBase<PackageFormValues>({ purpose: "package-form-base", units: PACKAGE_FORM_UNITS });

/** The columns of a stored package the form edits. */
export type PackageFormRow = Omit<PackageFormValues, "region"> & { region: string };

/**
 * A stored row as the form an untouched page would post for it — so a row is
 * read by exactly the reader a submission is, and an untouched field always
 * compares equal to what it was drawn from.
 */
export function packageFormOfRow(row: PackageFormRow): FormData {
  const form = new FormData();
  form.set("region", row.region ?? "");
  form.set("destinationId", row.destinationId ? String(row.destinationId) : "");
  for (const name of [
    "titleEn",
    "titleAr",
    "destinationEn",
    "destinationAr",
    "durationEn",
    "durationAr",
    "summaryEn",
    "summaryAr",
    "bodyEn",
    "bodyAr",
  ] as const) {
    form.set(name, row[name] ?? "");
  }
  form.set("highlights", JSON.stringify(row.highlights ?? []));
  form.set("imageId", row.imageId ? String(row.imageId) : "");
  if (row.isFeatured) form.set("isFeatured", "on");
  if (row.isPublished) form.set("isPublished", "on");
  form.set("sortOrder", String(row.sortOrder));
  return form;
}

export const packageRowValues = (row: PackageFormRow): PackageFormValues => readPackageForm(packageFormOfRow(row));

/* -------------------------------------------------------------------------- */
/* A destination                                                              */
/* -------------------------------------------------------------------------- */

/** Every field the Destinations form posts — the one reader, for a submission and a stored row alike. */
export function readDestinationForm(form: FormData) {
  return {
    slug: field(form, "slug", 120).toLowerCase(),
    titleEn: field(form, "titleEn", 190),
    titleAr: field(form, "titleAr", 190),
    summaryEn: field(form, "summaryEn", 2000),
    summaryAr: field(form, "summaryAr", 2000),
    imageId: optionalId(form, "imageId"),
    isPublished: checkbox(form, "isPublished"),
    sortOrder: numberField(form, "sortOrder", 0),
  };
}

export type DestinationFormValues = ReturnType<typeof readDestinationForm>;

/**
 * One unit per column. The address is a unit here: a destination's address
 * can change on this screen, and a stale form must not move it back.
 */
export const DESTINATION_FORM_UNITS: readonly FormUnit<keyof DestinationFormValues>[] = [
  { key: "slug", label: "Address", fields: ["slug"], canon: "line" },
  { key: "titleEn", label: "Name (English)", fields: ["titleEn"], canon: "line" },
  { key: "titleAr", label: "Name (Arabic)", fields: ["titleAr"], canon: "line" },
  { key: "summaryEn", label: "Summary (English)", fields: ["summaryEn"], canon: "text" },
  { key: "summaryAr", label: "Summary (Arabic)", fields: ["summaryAr"], canon: "text" },
  { key: "imageId", label: "Image", fields: ["imageId"], canon: "value" },
  { key: "isPublished", label: "Published", fields: ["isPublished"], canon: "value", checkbox: true },
  { key: "sortOrder", label: "Order", fields: ["sortOrder"], canon: "value" },
];

export const DESTINATION_FORM = formBase<DestinationFormValues>({
  purpose: "destination-form-base",
  units: DESTINATION_FORM_UNITS,
});

export type DestinationFormRow = DestinationFormValues;

export function destinationFormOfRow(row: DestinationFormRow): FormData {
  const form = new FormData();
  for (const name of ["slug", "titleEn", "titleAr", "summaryEn", "summaryAr"] as const) form.set(name, row[name] ?? "");
  form.set("imageId", row.imageId ? String(row.imageId) : "");
  if (row.isPublished) form.set("isPublished", "on");
  form.set("sortOrder", String(row.sortOrder));
  return form;
}

export const destinationRowValues = (row: DestinationFormRow): DestinationFormValues =>
  readDestinationForm(destinationFormOfRow(row));
