"use server";

import { and, eq, gt, lt, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { logActivity } from "@/lib/activity";
import {
  checkbox,
  fail,
  field,
  numberField,
  ok,
  optionalId,
  runAction,
  type ActionState,
} from "@/lib/admin/actions";
import { guardAction } from "@/lib/auth/guard";
import { TAGS, revalidate } from "@/lib/cache";
import { sanitizeHref, sanitizeRichText } from "@/lib/cms/sanitize";
import { db } from "@/lib/db";
import { serviceCategories, serviceSubcategories, services } from "@/lib/db/schema";
import { isIconName } from "@/lib/icons";
import { dropSeoRows, freeSeoAddress } from "@/lib/seo-targets";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const refresh = () => {
  revalidate(TAGS.catalog);
  revalidatePath("/admin/categories");
};

function readCategory(form: FormData) {
  const icon = field(form, "icon", 48);
  return {
    titleEn: field(form, "titleEn", 190),
    titleAr: field(form, "titleAr", 190),
    taglineEn: field(form, "taglineEn", 255),
    taglineAr: field(form, "taglineAr", 255),
    summaryEn: field(form, "summaryEn", 2000),
    summaryAr: field(form, "summaryAr", 2000),
    bodyEn: sanitizeRichText(field(form, "bodyEn", 20000)),
    bodyAr: sanitizeRichText(field(form, "bodyAr", 20000)),
    ctaLabelEn: field(form, "ctaLabelEn", 64),
    ctaLabelAr: field(form, "ctaLabelAr", 64),
    // The page CMS's link rule (Batch 21): a site path or an https address.
    ctaHref: sanitizeHref(field(form, "ctaHref", 255)),
    // The icon is a key into our own set — never markup from the panel.
    icon: isIconName(icon) ? icon : "desk",
    imageId: optionalId(form, "imageId"),
    sortOrder: numberField(form, "sortOrder", 0),
    isPublished: checkbox(form, "isPublished"),
  };
}

export async function createCategory(_prev: ActionState, form: FormData): Promise<ActionState> {
  let newId = 0;
  const result = await runAction("category-create", async () => {
    const session = await guardAction("services.manage", form);
    const slug = field(form, "slug", 120).toLowerCase();
    const values = readCategory(form);

    if (!values.titleEn) return fail("Give the category a title.", { titleEn: "Required." });
    if (field(form, "ctaHref", 255) && !values.ctaHref) {
      return fail("Use a site path such as /contact, or a full https:// address.", { ctaHref: "Not allowed." });
    }
    if (!SLUG.test(slug)) {
      return fail("The address must be lower-case words joined by hyphens.", { slug: "Invalid." });
    }
    const [taken] = await db
      .select({ id: serviceCategories.id })
      .from(serviceCategories)
      .where(eq(serviceCategories.slug, slug))
      .limit(1);
    if (taken) return fail("A category already uses that address.", { slug: "Already taken." });

    // A new address starts with nothing: whatever SEO row a deleted record left
    // there is moved aside, in the same transaction (Batch 25, B.7).
    newId = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(serviceCategories)
        .values({ ...values, slug })
        .returning({ id: serviceCategories.id });
      await freeSeoAddress(tx, "category", slug, row!.id);
      return row!.id;
    });

    await logActivity(session, {
      action: "category.created",
      entityType: "category",
      entityId: newId,
      summary: `Created the category “${values.titleEn}”`,
    });
    refresh();
    // The row the create moved aside may be in the cached SEO rows (B.12).
    revalidate(TAGS.seo);
    return ok("Category created.", newId);
  });

  if (!result.ok) return result;
  redirect(`/admin/categories/${newId}`);
}

export async function updateCategory(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("category-update", async () => {
    const session = await guardAction("services.manage", form);
    const id = Number(form.get("id"));
    const values = readCategory(form);
    if (!values.titleEn) return fail("Give the category a title.", { titleEn: "Required." });
    if (field(form, "ctaHref", 255) && !values.ctaHref) {
      return fail("Use a site path such as /contact, or a full https:// address.", { ctaHref: "Not allowed." });
    }

    const [row] = await db
      .update(serviceCategories)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(serviceCategories.id, id))
      .returning({ slug: serviceCategories.slug });
    if (!row) return fail("That category no longer exists.");

    await logActivity(session, {
      action: "category.updated",
      entityType: "category",
      entityId: id,
      summary: `Updated the category “${values.titleEn}”`,
    });
    refresh();
    revalidatePath(`/admin/categories/${id}`);
    return ok("Category saved.");
  });
}

export async function deleteCategory(_prev: ActionState, form: FormData): Promise<ActionState> {
  const result = await runAction("category-delete", async () => {
    const session = await guardAction("services.manage", form);
    const id = Number(form.get("id"));
    const [row] = await db.select().from(serviceCategories).where(eq(serviceCategories.id, id)).limit(1);
    if (!row) return fail("That category no longer exists.");

    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(serviceCategories)
      .where(eq(serviceCategories.id, id));
    if (!n) return fail("That category no longer exists.");

    // Cascades to its services — which is the surprise worth spelling out. Their
    // SEO records go with them, and the category's own (Batch 25, B.7). The
    // category is held first, then its services, then the SEO rows: the order a
    // category publication and every SEO write take them in. The services are
    // locked as they are listed — a service being moved out of the category
    // meanwhile is waited for and then left out (it is not deleted by the
    // cascade either), so only records that really go take their SEO rows with
    // them; one moved in later waits on the category and finds it gone.
    await db.transaction(async (tx) => {
      const [category] = await tx
        .select({ slug: serviceCategories.slug })
        .from(serviceCategories)
        .where(eq(serviceCategories.id, id))
        .for("update");
      if (!category) return;
      const removed = await tx
        .select({ id: services.id, slug: services.slug })
        .from(services)
        .where(eq(services.categoryId, id))
        .for("update");
      await tx.delete(serviceCategories).where(eq(serviceCategories.id, id));
      await dropSeoRows(tx, "category", [{ id, address: category.slug }]);
      await dropSeoRows(
        tx,
        "service",
        removed.map((service) => ({ id: service.id, address: `${category.slug}/${service.slug}` })),
      );
    });
    revalidate(TAGS.seo);
    await logActivity(session, {
      action: "category.deleted",
      entityType: "category",
      entityId: id,
      summary: `Deleted the category “${row.titleEn}” and its services`,
    });
    refresh();
    return ok("Category deleted.");
  });
  if (!result.ok) return result;
  redirect("/admin/categories");
}

export async function moveCategory(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("category-move", async () => {
    const session = await guardAction("services.manage", form);
    const id = Number(form.get("id"));
    const up = field(form, "direction", 8) === "up";

    const [row] = await db.select().from(serviceCategories).where(eq(serviceCategories.id, id)).limit(1);
    if (!row) return fail("That category no longer exists.");

    const [neighbour] = await db
      .select()
      .from(serviceCategories)
      .where(
        up
          ? lt(serviceCategories.sortOrder, row.sortOrder)
          : gt(serviceCategories.sortOrder, row.sortOrder),
      )
      .orderBy(up ? sql`sort_order desc` : sql`sort_order asc`)
      .limit(1);
    if (!neighbour) return ok();

    await db.transaction(async (tx) => {
      await tx.update(serviceCategories).set({ sortOrder: -1 }).where(eq(serviceCategories.id, row.id));
      await tx
        .update(serviceCategories)
        .set({ sortOrder: row.sortOrder })
        .where(eq(serviceCategories.id, neighbour.id));
      await tx
        .update(serviceCategories)
        .set({ sortOrder: neighbour.sortOrder })
        .where(eq(serviceCategories.id, row.id));
    });
    // A reorder is a change like any other, and the audit trail says so (19B).
    await logActivity(session, {
      action: "category.reordered",
      entityType: "category",
      entityId: row.id,
      summary: `Moved the category “${row.titleEn}” ${up ? "up" : "down"}`,
    });
    refresh();
    return ok();
  });
}

/* -------------------------------------------------------------------------- */
/* Subcategories                                                              */
/* -------------------------------------------------------------------------- */

export async function saveSubcategory(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("subcategory-save", async () => {
    const session = await guardAction("services.manage", form);
    const id = Number(form.get("id")) || 0;
    const categoryId = Number(form.get("categoryId"));
    const slug = field(form, "slug", 120).toLowerCase();
    const titleEn = field(form, "titleEn", 190);

    if (!titleEn) return fail("Give the group a title.", { titleEn: "Required." });
    if (!SLUG.test(slug)) return fail("The address must be lower-case words joined by hyphens.", { slug: "Invalid." });

    const values = {
      slug,
      titleEn,
      titleAr: field(form, "titleAr", 190),
      summaryEn: field(form, "summaryEn", 1000),
      summaryAr: field(form, "summaryAr", 1000),
      sortOrder: numberField(form, "sortOrder", 0),
      isPublished: checkbox(form, "isPublished"),
    };

    /**
     * The category is where a new group goes, not something an edit can
     * change: the form carries it only as the screen's own context, and its
     * services keep their category, so moving the group alone would split them
     * across two. An update keeps the stored one, and an id that names no group
     * is refused rather than reported — and logged — as saved (19B).
     */
    let savedId = id;
    let savedCategory = categoryId;
    if (id) {
      const [updated] = await db
        .update(serviceSubcategories)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(serviceSubcategories.id, id))
        .returning({ id: serviceSubcategories.id, categoryId: serviceSubcategories.categoryId });
      if (!updated) return fail("That group no longer exists.");
      savedCategory = updated.categoryId;
    } else {
      const [exists] = await db
        .select({ id: serviceSubcategories.id })
        .from(serviceSubcategories)
        .where(and(eq(serviceSubcategories.categoryId, categoryId), eq(serviceSubcategories.slug, slug)))
        .limit(1);
      if (exists) return fail("A group in this category already uses that address.", { slug: "Already taken." });
      const [created] = await db
        .insert(serviceSubcategories)
        .values({ ...values, categoryId })
        .returning({ id: serviceSubcategories.id });
      savedId = created!.id;
    }

    await logActivity(session, {
      action: id ? "subcategory.updated" : "subcategory.created",
      entityType: "subcategory",
      entityId: savedId,
      summary: `${id ? "Updated" : "Created"} the group “${titleEn}”`,
    });
    refresh();
    revalidatePath(`/admin/categories/${savedCategory}`);
    return ok(id ? "Group saved." : "Group created.");
  });
}

export async function deleteSubcategory(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("subcategory-delete", async () => {
    const session = await guardAction("services.manage", form);
    const id = Number(form.get("id"));
    const [row] = await db.select().from(serviceSubcategories).where(eq(serviceSubcategories.id, id)).limit(1);
    if (!row) return fail("That group no longer exists.");

    // Services keep their category; only the grouping is removed.
    await db.delete(serviceSubcategories).where(eq(serviceSubcategories.id, id));
    await logActivity(session, {
      action: "subcategory.deleted",
      entityType: "subcategory",
      entityId: id,
      summary: `Deleted the group “${row.titleEn}”`,
    });
    refresh();
    revalidatePath(`/admin/categories/${row.categoryId}`);
    return ok("Group deleted. Its services stay in the category, ungrouped.");
  });
}
