/**
 * The Services edit form as a browser posts it (Batch 23).
 *
 * `updateService` writes only what a form changed from the signed base its page
 * was drawn with, so a test that saves through the screen has to do what the
 * screen does: open the page — which signs the base — and post every field
 * together with that base. `openServiceForm` is that moment; whatever changes
 * after it is "elsewhere", exactly as for a person with the page open.
 *
 * The values are read from the row and the base from the page; nothing else may
 * write the service between the two reads.
 */
import type { Sql } from "./pg";

export type ServiceFormFields = Record<string, string | number>;

/** The `_base` the edit page renders for a service, as a browser would read it. */
export async function serviceFormBase(origin: string, cookie: string, id: number): Promise<string> {
  const response = await fetch(`${origin}/admin/services/${id}`, { headers: { cookie }, redirect: "manual" });
  const html = await response.text();
  const found = /name="_base" value="([^"]+)"/.exec(html);
  if (!found) throw new Error(`/admin/services/${id} rendered no base (HTTP ${response.status})`);
  return found[1]!;
}

/** Every field of the form, as an untouched page holds it. */
export async function serviceFormFields(sql: Sql, id: number): Promise<ServiceFormFields> {
  const [row] = await sql<Record<string, unknown>[]>`select * from services where id = ${id}`;
  if (!row) throw new Error(`no service ${id}`);
  return {
    id,
    slug: String(row.slug),
    categoryId: Number(row.category_id),
    subcategoryId: row.subcategory_id === null ? "" : Number(row.subcategory_id),
    titleEn: String(row.title_en),
    titleAr: String(row.title_ar),
    introEn: String(row.intro_en),
    introAr: String(row.intro_ar),
    bodyEn: String(row.body_en),
    bodyAr: String(row.body_ar),
    benefits: JSON.stringify(row.benefits),
    audience: JSON.stringify(row.audience),
    requirements: JSON.stringify(row.requirements),
    processSteps: JSON.stringify(row.process_steps),
    timelineEn: String(row.timeline_en),
    timelineAr: String(row.timeline_ar),
    notesEn: String(row.notes_en),
    notesAr: String(row.notes_ar),
    formPreset: String(row.form_preset),
    imageId: row.image_id === null ? "" : Number(row.image_id),
    sortOrder: Number(row.sort_order),
    ...(row.is_published ? { isPublished: "on" } : {}),
    ...(row.is_featured ? { isFeatured: "on" } : {}),
  };
}

/** The form as it stands the moment the page is opened: every field, and its base. */
export async function openServiceForm(sql: Sql, origin: string, cookie: string, id: number): Promise<ServiceFormFields> {
  const fields = await serviceFormFields(sql, id);
  return { ...fields, _base: await serviceFormBase(origin, cookie, id) };
}

/**
 * The opened form with some fields changed, ready to post. A checkbox is
 * cleared by passing `null`, as unticking it leaves it out of the post.
 */
export function changedForm(opened: ServiceFormFields, changes: Record<string, string | number | null>): ServiceFormFields {
  const out: ServiceFormFields = { ...opened };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}
