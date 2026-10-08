import "server-only";

import { formBase, type FormUnit } from "@/lib/admin/form-base";
import { checkbox, field } from "@/lib/admin/form-readers";
import type { seoMetadata } from "@/lib/db/schema";
import { siteUrl } from "@/lib/env";
import { storedCanonical, type SeoKind } from "@/lib/seo-model";

/**
 * The SEO screen's form: its fields, read one way, and the base each target's
 * form is saved against (Batch 25 — the Batch 23/24 mechanism,
 * `lib/admin/form-base.ts`; docs/admin/seo-and-share-images.md B.9).
 *
 * The save used to write every field it held, one statement, last write wins:
 * a form left open put back whatever it was drawn with. Now the screen signs
 * what each field was when it drew the form, and a save writes only the fields
 * it changed — refusing, whole and with the fields named, a change to a field
 * that moved elsewhere in the meantime.
 */

/** The fields of an SEO record, named as their columns are. */
export type SeoFormValues = {
  titleEn: string;
  titleAr: string;
  descriptionEn: string;
  descriptionAr: string;
  ogTitle: string;
  ogTitleAr: string;
  ogDescription: string;
  ogDescriptionAr: string;
  canonicalUrl: string;
  ogImageId: number | null;
  noindex: boolean;
};

/** What a target with no record holds: nothing of its own. */
export const SEO_BLANK: SeoFormValues = {
  titleEn: "",
  titleAr: "",
  descriptionEn: "",
  descriptionAr: "",
  ogTitle: "",
  ogTitleAr: "",
  ogDescription: "",
  ogDescriptionAr: "",
  canonicalUrl: "",
  ogImageId: null,
  noindex: false,
};

/**
 * A share image as posted: a whole positive id, or none. Anything else — a
 * fraction, a word — is refused before it is read (`postedImageProblem`), so
 * this never has to guess.
 */
const postedImageId = (form: FormData): number | null => {
  const raw = field(form, "ogImageId", 12);
  return raw ? Number(raw) : null;
};

/** Why the posted share image cannot even be looked up, or `null`. */
export function postedImageProblem(form: FormData): string | null {
  const id = postedImageId(form);
  if (id === null) return null;
  return Number.isInteger(id) && id > 0 && id <= 2_147_483_647 ? null : "Choose the share image from the library.";
}

/** Every field the form posts, trimmed and capped — the one reader. */
export function readSeoForm(form: FormData): SeoFormValues {
  return {
    titleEn: field(form, "titleEn", 190),
    titleAr: field(form, "titleAr", 190),
    descriptionEn: field(form, "descriptionEn", 320),
    descriptionAr: field(form, "descriptionAr", 320),
    ogTitle: field(form, "ogTitle", 190),
    ogTitleAr: field(form, "ogTitleAr", 190),
    ogDescription: field(form, "ogDescription", 320),
    ogDescriptionAr: field(form, "ogDescriptionAr", 320),
    // Language-neutral, as it is stored (`storedCanonical`): typing `/ar/about`
    // for a page whose canonical is already `/about` changes nothing.
    // Read past the column's length, so an address too long to store is refused
    // by name rather than cut into a different one.
    canonicalUrl: storedCanonical(field(form, "canonicalUrl", 2000), siteUrl),
    ogImageId: postedImageId(form),
    noindex: checkbox(form, "noindex"),
  };
}

/** A stored record's values — or a blank record's, for a target that has none. */
export function seoRowValues(row: typeof seoMetadata.$inferSelect | null): SeoFormValues {
  if (!row) return SEO_BLANK;
  return {
    titleEn: row.titleEn,
    titleAr: row.titleAr,
    descriptionEn: row.descriptionEn,
    descriptionAr: row.descriptionAr,
    ogTitle: row.ogTitle,
    ogTitleAr: row.ogTitleAr,
    ogDescription: row.ogDescription,
    ogDescriptionAr: row.ogDescriptionAr,
    canonicalUrl: row.canonicalUrl,
    ogImageId: row.ogImageId,
    noindex: row.noindex,
  };
}

/** Every field its own unit: two people can edit different fields of one record. */
export const SEO_FORM_UNITS: readonly FormUnit<keyof SeoFormValues>[] = [
  { key: "titleEn", label: "Title (English)", fields: ["titleEn"], canon: "line" },
  { key: "titleAr", label: "Title (Arabic)", fields: ["titleAr"], canon: "line" },
  { key: "descriptionEn", label: "Meta description (English)", fields: ["descriptionEn"], canon: "text" },
  { key: "descriptionAr", label: "Meta description (Arabic)", fields: ["descriptionAr"], canon: "text" },
  { key: "ogTitle", label: "Share title (English)", fields: ["ogTitle"], canon: "line" },
  { key: "ogTitleAr", label: "Share title (Arabic)", fields: ["ogTitleAr"], canon: "line" },
  { key: "ogDescription", label: "Share description (English)", fields: ["ogDescription"], canon: "text" },
  { key: "ogDescriptionAr", label: "Share description (Arabic)", fields: ["ogDescriptionAr"], canon: "text" },
  { key: "canonicalUrl", label: "Canonical address", fields: ["canonicalUrl"], canon: "line" },
  { key: "ogImageId", label: "Share image", fields: ["ogImageId"], canon: "value" },
  { key: "noindex", label: "Keep out of search engines", fields: ["noindex"], canon: "value", checkbox: true },
];

const formFor = (kind: SeoKind) =>
  formBase<SeoFormValues>({ purpose: `seo-${kind}-form-base`, units: SEO_FORM_UNITS });

export type SeoFormSpec = ReturnType<typeof formFor>;

/**
 * One base per kind of target, each with its own signing key and checked
 * against the target's id: a base drawn for destination 5 cannot be posted for
 * package 5, nor the Services overview's (id 1) for the Tour packages
 * overview's.
 */
export const SEO_FORMS: Record<Exclude<SeoKind, "site">, SeoFormSpec> = {
  page: formFor("page"),
  serviceIndex: formFor("serviceIndex"),
  packageIndex: formFor("packageIndex"),
  category: formFor("category"),
  service: formFor("service"),
  package: formFor("package"),
  destination: formFor("destination"),
};
