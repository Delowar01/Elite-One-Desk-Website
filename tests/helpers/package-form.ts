/**
 * The Packages and Destinations edit forms as a browser posts them (Batch 24).
 *
 * Both updates write only what a form changed from the signed base its page
 * was drawn with (docs/admin/services-form-concurrency.md §10), so a test that
 * saves through a screen has to do what the screen does: open the page —
 * which signs the base — and post every field together with that base. The
 * `open…` functions are that moment; whatever changes after it is "elsewhere",
 * exactly as for a person with the page open.
 *
 * The values are read from the row and the base from the page; nothing else may
 * write the record between the two reads.
 */
import type { Sql } from "./pg";

export type FormFields = Record<string, string | number>;

/** The `_base` an edit page renders, as a browser would read it. */
export async function formBaseOf(origin: string, cookie: string, path: string): Promise<string> {
  const response = await fetch(`${origin}${path}`, { headers: { cookie }, redirect: "manual" });
  const html = await response.text();
  const found = /name="_base" value="([^"]+)"/.exec(html);
  if (!found) throw new Error(`${path} rendered no base (HTTP ${response.status})`);
  return found[1]!;
}

/** Every field of the Packages form, as an untouched page holds it. */
export async function packageFormFields(sql: Sql, id: number): Promise<FormFields> {
  const [row] = await sql<Record<string, unknown>[]>`select * from travel_packages where id = ${id}`;
  if (!row) throw new Error(`no package ${id}`);
  return {
    id,
    slug: String(row.slug),
    region: String(row.region),
    destinationId: row.destination_id === null ? "" : Number(row.destination_id),
    titleEn: String(row.title_en),
    titleAr: String(row.title_ar),
    destinationEn: String(row.destination_en),
    destinationAr: String(row.destination_ar),
    durationEn: String(row.duration_en),
    durationAr: String(row.duration_ar),
    summaryEn: String(row.summary_en),
    summaryAr: String(row.summary_ar),
    bodyEn: String(row.body_en),
    bodyAr: String(row.body_ar),
    highlights: JSON.stringify(row.highlights),
    imageId: row.image_id === null ? "" : Number(row.image_id),
    sortOrder: Number(row.sort_order),
    ...(row.is_published ? { isPublished: "on" } : {}),
    ...(row.is_featured ? { isFeatured: "on" } : {}),
  };
}

/** Every field of the Destinations form, as an untouched page holds it. */
export async function destinationFormFields(sql: Sql, id: number): Promise<FormFields> {
  const [row] = await sql<Record<string, unknown>[]>`select * from package_destinations where id = ${id}`;
  if (!row) throw new Error(`no destination ${id}`);
  return {
    id,
    slug: String(row.slug),
    titleEn: String(row.title_en),
    titleAr: String(row.title_ar),
    summaryEn: String(row.summary_en),
    summaryAr: String(row.summary_ar),
    imageId: row.image_id === null ? "" : Number(row.image_id),
    sortOrder: Number(row.sort_order),
    ...(row.is_published ? { isPublished: "on" } : {}),
  };
}

/** The Packages form the moment its page is opened: every field, and its base. */
export async function openPackageForm(sql: Sql, origin: string, cookie: string, id: number): Promise<FormFields> {
  const fields = await packageFormFields(sql, id);
  return { ...fields, _base: await formBaseOf(origin, cookie, `/admin/packages/${id}`) };
}

/** The Destinations form the moment its page is opened: every field, and its base. */
export async function openDestinationForm(sql: Sql, origin: string, cookie: string, id: number): Promise<FormFields> {
  const fields = await destinationFormFields(sql, id);
  return { ...fields, _base: await formBaseOf(origin, cookie, `/admin/packages/destinations/${id}`) };
}

/**
 * An opened form with some fields changed, ready to post. A checkbox is
 * cleared by passing `null`, as unticking it leaves it out of the post.
 */
export function withChanges(opened: FormFields, changes: Record<string, string | number | null>): FormFields {
  const out: FormFields = { ...opened };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}
