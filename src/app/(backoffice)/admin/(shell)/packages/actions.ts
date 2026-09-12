"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { logActivity } from "@/lib/activity";
import {
  checkbox, fail, field, numberField, ok, optionalId, runAction, type ActionState,
} from "@/lib/admin/actions";
import { guardAction } from "@/lib/auth/guard";
import { TAGS, revalidate } from "@/lib/cache";
import { sanitizeRichText } from "@/lib/cms/sanitize";
import { db } from "@/lib/db";
import { packageDestinations, travelPackages } from "@/lib/db/schema";
import type { LocalisedItem } from "@/lib/db/schema";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * LEGACY. `region` is no longer how packages are grouped — `destinationId` is —
 * but the column keeps the values it already holds, `egypt` among them, and
 * nothing here rewrites one. A saved record therefore comes back with the
 * region it went in with.
 */
const REGIONS = ["egypt", "international", "holiday", "corporate"] as const;
type Region = (typeof REGIONS)[number];
const isRegion = (value: string): value is Region => (REGIONS as readonly string[]).includes(value);

/**
 * `/packages/[slug]` is one route shared by packages and destinations, which is
 * what keeps every existing package address working. The price is that the two
 * tables must not collide, checked from both sides.
 */
async function slugTaken(slug: string, exceptPackageId?: number) {
  const [destination] = await db
    .select({ title: packageDestinations.titleEn })
    .from(packageDestinations)
    .where(eq(packageDestinations.slug, slug))
    .limit(1);
  if (destination) return `The destination “${destination.title}” already uses that address.`;

  const [pkg] = await db
    .select({ id: travelPackages.id, title: travelPackages.titleEn })
    .from(travelPackages)
    .where(eq(travelPackages.slug, slug))
    .limit(1);
  if (pkg && pkg.id !== exceptPackageId) {
    return `The package “${pkg.title}” already uses that address.`;
  }
  return null;
}

const refresh = () => {
  revalidate(TAGS.packages);
  revalidatePath("/admin/packages");
};

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

function readPackage(form: FormData) {
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

export async function createPackage(_prev: ActionState, form: FormData): Promise<ActionState> {
  let newId = 0;
  const result = await runAction("package-create", async () => {
    const session = await guardAction("packages.manage", form);
    const slug = field(form, "slug", 120).toLowerCase();
    const values = readPackage(form);

    if (!values.titleEn) return fail("Give the package a title.", { titleEn: "Required." });
    if (!SLUG.test(slug)) return fail("The address must be lower-case words joined by hyphens.", { slug: "Invalid." });

    const clash = await slugTaken(slug);
    if (clash) return fail(clash, { slug: "Already taken." });

    const [row] = await db
      .insert(travelPackages)
      .values({ ...values, slug })
      .returning({ id: travelPackages.id });
    newId = row!.id;

    await logActivity(session, {
      action: "package.created",
      entityType: "package",
      entityId: newId,
      summary: `Created the package “${values.titleEn}”`,
    });
    refresh();
    return ok("Package created.", newId);
  });
  if (!result.ok) return result;
  redirect(`/admin/packages/${newId}`);
}

export async function updatePackage(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("package-update", async () => {
    const session = await guardAction("packages.manage", form);
    const id = Number(form.get("id"));
    const values = readPackage(form);
    if (!values.titleEn) return fail("Give the package a title.", { titleEn: "Required." });

    // The address is not editable from the update form, but the guard runs
    // anyway: a destination created since this page loaded could have taken it.
    const [current] = await db
      .select({ slug: travelPackages.slug })
      .from(travelPackages)
      .where(eq(travelPackages.id, id))
      .limit(1);
    if (current) {
      const clash = await slugTaken(current.slug, id);
      if (clash) return fail(clash, { slug: "Already taken." });
    }

    const [row] = await db
      .update(travelPackages)
      .set({ ...values, updatedAt: new Date() })
      .where(eq(travelPackages.id, id))
      .returning({ slug: travelPackages.slug });
    if (!row) return fail("That package no longer exists.");

    await logActivity(session, {
      action: "package.updated",
      entityType: "package",
      entityId: id,
      summary: `Updated the package “${values.titleEn}”`,
    });
    refresh();
    revalidatePath(`/admin/packages/${id}`);
    return ok("Package saved.");
  });
}

export async function togglePackage(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("package-toggle", async () => {
    const session = await guardAction("packages.manage", form);
    const id = Number(form.get("id"));
    const [row] = await db.select().from(travelPackages).where(eq(travelPackages.id, id)).limit(1);
    if (!row) return fail("That package no longer exists.");
    await db
      .update(travelPackages)
      .set({ isPublished: !row.isPublished, updatedAt: new Date() })
      .where(eq(travelPackages.id, id));
    await logActivity(session, {
      action: row.isPublished ? "package.unpublished" : "package.published",
      entityType: "package",
      entityId: id,
      summary: `${row.isPublished ? "Unpublished" : "Published"} “${row.titleEn}”`,
    });
    refresh();
    return ok();
  });
}

export async function deletePackage(_prev: ActionState, form: FormData): Promise<ActionState> {
  const result = await runAction("package-delete", async () => {
    const session = await guardAction("packages.manage", form);
    const id = Number(form.get("id"));
    const [row] = await db.select().from(travelPackages).where(eq(travelPackages.id, id)).limit(1);
    if (!row) return fail("That package no longer exists.");
    await db.delete(travelPackages).where(eq(travelPackages.id, id));
    await logActivity(session, {
      action: "package.deleted",
      entityType: "package",
      entityId: id,
      summary: `Deleted the package “${row.titleEn}”`,
    });
    refresh();
    return ok("Package deleted.");
  });
  if (!result.ok) return result;
  redirect("/admin/packages");
}
