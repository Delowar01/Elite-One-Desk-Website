/**
 * The SEO screen's form as a browser posts it (Batch 25).
 *
 * A save and a removal are held to the signed base the screen drew the form
 * with (docs/admin/seo-and-share-images.md B.9), so a test that saves through
 * the screen has to do what the screen does: open it at the target — which
 * draws that target's form, and signs its base — and post the fields with that
 * base. `openSeoForm` is that moment; whatever changes after it is
 * "elsewhere", exactly as for a person with the screen open.
 */
import type { Sql } from "./pg";

export type SeoFields = Record<string, string | number>;

/** The `_base` the SEO screen renders for one target, as a browser would read it. */
export async function seoFormBase(origin: string, cookie: string, target: string): Promise<string> {
  const response = await fetch(`${origin}/admin/seo?target=${encodeURIComponent(target)}`, {
    headers: { cookie },
    redirect: "manual",
  });
  const html = await response.text();
  const form = new RegExp(`data-seo-target="${target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[\\s\\S]*?name="_base" value="([^"]+)"`).exec(html);
  if (!form) throw new Error(`/admin/seo rendered no form for ${target} (HTTP ${response.status})`);
  return form[1]!;
}

/** The record a target's form is drawn with — the row the public page uses, or blanks. */
export async function seoFormFields(sql: Sql, target: string): Promise<SeoFields> {
  const [kind, rawId] = target.split(":") as [string, string];
  const id = Number(rawId);
  const rows = await sql<Record<string, unknown>[]>`
    select s.* from seo_metadata s
     where ${
       kind === "serviceIndex" || kind === "packageIndex"
         ? sql`s.entity_type = 'page' and s.entity_id is null and s.entity_key = ${kind === "serviceIndex" ? "services" : "packages"}`
         : sql`s.entity_type = ${kind} and s.entity_id = ${id}`
     }
     limit 1`;
  const row = rows[0];
  const text = (name: string) => (row ? String(row[name] ?? "") : "");
  return {
    titleEn: text("title_en"),
    titleAr: text("title_ar"),
    descriptionEn: text("description_en"),
    descriptionAr: text("description_ar"),
    ogTitle: text("og_title"),
    ogTitleAr: text("og_title_ar"),
    ogDescription: text("og_description"),
    ogDescriptionAr: text("og_description_ar"),
    canonicalUrl: text("canonical_url"),
    ogImageId: row && row.og_image_id !== null ? Number(row.og_image_id) : "",
    ...(row?.noindex ? { noindex: "on" } : {}),
  };
}

/**
 * The form the moment the screen is opened at a target: every field, the
 * reference and the base. Read for a target whose record the previous release
 * wrote by address only (not yet bound), the fields come from that row too.
 */
export async function openSeoForm(sql: Sql, origin: string, cookie: string, target: string): Promise<SeoFields> {
  const base = await seoFormBase(origin, cookie, target);
  let fields = await seoFormFields(sql, target);
  if (!Object.values(fields).some((value) => value !== "")) {
    // Not bound yet: the unbound row at the target's address, if there is one.
    fields = { ...fields, ...(await unboundFields(sql, target)) };
  }
  return { target, _base: base, ...fields };
}

async function unboundFields(sql: Sql, target: string): Promise<SeoFields> {
  const [kind, rawId] = target.split(":") as [string, string];
  const id = Number(rawId);
  const address = await addressOf(sql, kind, id);
  if (address === null) return {};
  const [row] = await sql<Record<string, unknown>[]>`
    select * from seo_metadata where entity_type = ${kind} and entity_id is null and entity_key = ${address} limit 1`;
  if (!row) return {};
  return {
    titleEn: String(row.title_en ?? ""),
    titleAr: String(row.title_ar ?? ""),
    descriptionEn: String(row.description_en ?? ""),
    descriptionAr: String(row.description_ar ?? ""),
    ogTitle: String(row.og_title ?? ""),
    ogTitleAr: String(row.og_title_ar ?? ""),
    ogDescription: String(row.og_description ?? ""),
    ogDescriptionAr: String(row.og_description_ar ?? ""),
    canonicalUrl: String(row.canonical_url ?? ""),
    ogImageId: row.og_image_id === null ? "" : Number(row.og_image_id),
    ...(row.noindex ? { noindex: "on" } : {}),
  };
}

/** A record's present address — the key its SEO row carries. */
export async function addressOf(sql: Sql, kind: string, id: number): Promise<string | null> {
  const rows =
    kind === "page"
      ? await sql<{ address: string }[]>`select slug as address from pages where id = ${id}`
      : kind === "category"
        ? await sql<{ address: string }[]>`select slug as address from service_categories where id = ${id}`
        : kind === "service"
          ? await sql<{ address: string }[]>`
              select c.slug || '/' || s.slug as address
                from services s join service_categories c on c.id = s.category_id where s.id = ${id}`
          : kind === "package"
            ? await sql<{ address: string }[]>`select slug as address from travel_packages where id = ${id}`
            : kind === "destination"
              ? await sql<{ address: string }[]>`select slug as address from package_destinations where id = ${id}`
              : [];
  return rows[0]?.address ?? null;
}

/**
 * An opened form with some fields changed, ready to post. A checkbox is
 * cleared by passing `null`, as unticking it leaves it out of the post.
 */
export function withSeoChanges(opened: SeoFields, changes: Record<string, string | number | null>): SeoFields {
  const out: SeoFields = { ...opened };
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) delete out[key];
    else out[key] = value;
  }
  return out;
}
