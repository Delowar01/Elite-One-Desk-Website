"use server";

import { and, eq, ne } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { logActivity } from "@/lib/activity";
import {
  checkbox, fail, field, numberField, ok, optionalId, runAction, type ActionState,
} from "@/lib/admin/actions";
import { guardAction } from "@/lib/auth/guard";
import { TAGS, revalidate } from "@/lib/cache";
import { db } from "@/lib/db";
import { packageDestinations, travelPackages } from "@/lib/db/schema";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Destinations and packages share one public address space —
 * `/packages/egypt` and `/packages/nile-cruise-luxor-aswan` are the same route.
 * Sharing it is what keeps every existing package URL working, and the price is
 * that a slug used by one table must be refused by the other. Checked in both
 * directions, here and in the package actions, with a message that says which
 * record is in the way rather than silently shadowing a page.
 */
async function slugTaken(slug: string, exceptDestinationId?: number) {
  const [pkg] = await db
    .select({ title: travelPackages.titleEn })
    .from(travelPackages)
    .where(eq(travelPackages.slug, slug))
    .limit(1);
  if (pkg) return `The package “${pkg.title}” already uses that address.`;

  const [destination] = await db
    .select({ title: packageDestinations.titleEn })
    .from(packageDestinations)
    .where(
      // An edit may keep the slug it already has.
      exceptDestinationId
        ? and(eq(packageDestinations.slug, slug), ne(packageDestinations.id, exceptDestinationId))
        : eq(packageDestinations.slug, slug),
    )
    .limit(1);
  if (destination) return `The destination “${destination.title}” already uses that address.`;
  return null;
}

const refresh = () => {
  // Destinations share the packages tag: one only matters in relation to the
  // other, and one tag means a revalidation cannot refresh half the picture.
  revalidate(TAGS.packages);
  revalidatePath("/admin/packages/destinations");
  revalidatePath("/admin/packages");
};

function readDestination(form: FormData) {
  return {
    titleEn: field(form, "titleEn", 190),
    titleAr: field(form, "titleAr", 190),
    summaryEn: field(form, "summaryEn", 2000),
    summaryAr: field(form, "summaryAr", 2000),
    imageId: optionalId(form, "imageId"),
    isPublished: checkbox(form, "isPublished"),
    sortOrder: numberField(form, "sortOrder", 0),
  };
}

export async function createDestination(_prev: ActionState, form: FormData): Promise<ActionState> {
  let newId = 0;
  const result = await runAction("destination-create", async () => {
    const session = await guardAction("packages.manage", form);
    const slug = field(form, "slug", 120).toLowerCase();
    const values = readDestination(form);

    if (!values.titleEn) return fail("Give the destination a name.", { titleEn: "Required." });
    if (!SLUG.test(slug)) {
      return fail("The address must be lower-case words joined by hyphens.", { slug: "Invalid." });
    }
    const clash = await slugTaken(slug);
    if (clash) return fail(clash, { slug: "Already taken." });

    const [row] = await db
      .insert(packageDestinations)
      .values({ ...values, slug })
      .returning({ id: packageDestinations.id });
    newId = row!.id;

    await logActivity(session, {
      action: "destination.created",
      entityType: "destination",
      entityId: newId,
      summary: `Created the destination “${values.titleEn}”`,
    });
    refresh();
    return ok("Destination created.", newId);
  });
  if (!result.ok) return result;
  redirect(`/admin/packages/destinations/${newId}`);
}

export async function updateDestination(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("destination-update", async () => {
    const session = await guardAction("packages.manage", form);
    const id = Number(form.get("id"));
    const slug = field(form, "slug", 120).toLowerCase();
    const values = readDestination(form);

    if (!values.titleEn) return fail("Give the destination a name.", { titleEn: "Required." });
    if (!SLUG.test(slug)) {
      return fail("The address must be lower-case words joined by hyphens.", { slug: "Invalid." });
    }
    const clash = await slugTaken(slug, id);
    if (clash) return fail(clash, { slug: "Already taken." });

    const [row] = await db
      .update(packageDestinations)
      .set({ ...values, slug, updatedAt: new Date() })
      .where(eq(packageDestinations.id, id))
      .returning({ id: packageDestinations.id });
    if (!row) return fail("That destination no longer exists.");

    await logActivity(session, {
      action: "destination.updated",
      entityType: "destination",
      entityId: id,
      summary: `Updated the destination “${values.titleEn}”`,
    });
    refresh();
    revalidatePath(`/admin/packages/destinations/${id}`);
    return ok("Destination saved.");
  });
}

export async function toggleDestination(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("destination-toggle", async () => {
    const session = await guardAction("packages.manage", form);
    const id = Number(form.get("id"));
    const [row] = await db
      .select()
      .from(packageDestinations)
      .where(eq(packageDestinations.id, id))
      .limit(1);
    if (!row) return fail("That destination no longer exists.");

    await db
      .update(packageDestinations)
      .set({ isPublished: !row.isPublished, updatedAt: new Date() })
      .where(eq(packageDestinations.id, id));

    await logActivity(session, {
      action: row.isPublished ? "destination.unpublished" : "destination.published",
      entityType: "destination",
      entityId: id,
      summary: `${row.isPublished ? "Unpublished" : "Published"} “${row.titleEn}”`,
    });
    refresh();
    return ok();
  });
}

export async function deleteDestination(_prev: ActionState, form: FormData): Promise<ActionState> {
  const result = await runAction("destination-delete", async () => {
    const session = await guardAction("packages.manage", form);
    const id = Number(form.get("id"));
    const [row] = await db
      .select()
      .from(packageDestinations)
      .where(eq(packageDestinations.id, id))
      .limit(1);
    if (!row) return fail("That destination no longer exists.");

    // The foreign key is ON DELETE SET NULL: the packages inside survive and
    // become ungrouped, which is recoverable. Deleting them with the folder
    // they happened to be filed under would not be.
    await db.delete(packageDestinations).where(eq(packageDestinations.id, id));

    await logActivity(session, {
      action: "destination.deleted",
      entityType: "destination",
      entityId: id,
      summary: `Deleted the destination “${row.titleEn}” — its packages are now unassigned`,
    });
    refresh();
    return ok("Destination deleted. Its packages are still here, without a destination.");
  });
  if (!result.ok) return result;
  redirect("/admin/packages/destinations");
}
