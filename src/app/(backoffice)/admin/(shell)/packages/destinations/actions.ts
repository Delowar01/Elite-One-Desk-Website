"use server";

import { and, eq, ne } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { logActivity } from "@/lib/activity";
import { fail, ok, runAction, type ActionState } from "@/lib/admin/actions";
import { guardAction } from "@/lib/auth/guard";
import { TAGS, revalidate } from "@/lib/cache";
import { db } from "@/lib/db";
import type { Executor } from "@/lib/db/revision";
import { packageDestinations, travelPackages } from "@/lib/db/schema";
import { DESTINATION_FORM, destinationRowValues, readDestinationForm } from "@/lib/packages/form-fields";
import { dropSeoRows, moveSeoRow } from "@/lib/seo-targets";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Destinations and packages share one public address space —
 * `/packages/egypt` and `/packages/nile-cruise-luxor-aswan` are the same route.
 * Sharing it is what keeps every existing package URL working, and the price is
 * that a slug used by one table must be refused by the other. Checked in both
 * directions, here and in the package actions, with a message that says which
 * record is in the way rather than silently shadowing a page.
 */
async function slugTaken(slug: string, exceptDestinationId?: number, on: Executor = db) {
  const [pkg] = await on
    .select({ title: travelPackages.titleEn })
    .from(travelPackages)
    .where(eq(travelPackages.slug, slug))
    .limit(1);
  if (pkg) return `The package “${pkg.title}” already uses that address.`;

  const [destination] = await on
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

/** Refused before anything is read: the form carries no base this server signed for this destination. */
const STALE_FORM =
  "This form is out of date, so nothing was saved. Reload the page to see the destination as it is now, then make your change again.";

export async function createDestination(_prev: ActionState, form: FormData): Promise<ActionState> {
  let newId = 0;
  const result = await runAction("destination-create", async () => {
    const session = await guardAction("packages.manage", form);
    const { slug, ...values } = readDestinationForm(form);

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

/**
 * Saves what the form changed — and only that (Batch 24, the Services form's
 * rule since Batch 23: docs/admin/services-form-concurrency.md §10).
 *
 * The form posts the signed base it was drawn with. Under the row's lock, each
 * unit it changed from that base is compared with the row as it is now: an
 * untouched unit is never written, so a newer name, summary or picture
 * published from the destination's page or its group on Tour packages stays;
 * a unit changed here *and* elsewhere is a conflict, and any conflict refuses
 * the whole save. The address is a unit like any other: a stale form never
 * moves it back, and one that changes it is checked against both tables.
 */
export async function updateDestination(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("destination-update", async () => {
    const session = await guardAction("packages.manage", form);
    const id = Number(form.get("id"));
    if (!Number.isInteger(id) || id <= 0) return fail("That destination no longer exists.");
    const base = DESTINATION_FORM.readBase(String(form.get("_base") ?? ""), id);
    if (!base) return fail(STALE_FORM);

    const submitted = readDestinationForm(form);
    const mine = DESTINATION_FORM.printsOf(submitted);
    const posted = DESTINATION_FORM.submittedUnits(form);
    // Decided before the row is even read: a form that changed nothing writes nothing.
    if (!DESTINATION_FORM.decide(base, mine, base, posted).changed.length) return ok("No changes to save.");

    type Outcome =
      | { kind: "missing" }
      | { kind: "invalid"; state: ActionState }
      | { kind: "conflict"; units: string[] }
      | { kind: "done"; writes: string[]; title: string };

    const outcome = await db.transaction(async (tx): Promise<Outcome> => {
      const [row] = await tx
        .select()
        .from(packageDestinations)
        .where(eq(packageDestinations.id, id))
        .limit(1)
        .for("update");
      if (!row) return { kind: "missing" };
      const liveValues = destinationRowValues(row);
      const decision = DESTINATION_FORM.decide(base, mine, DESTINATION_FORM.printsOf(liveValues), posted);
      if (decision.conflicts.length) return { kind: "conflict", units: decision.conflicts };

      const writes = decision.writes;
      const changes = DESTINATION_FORM.valuesOfUnits(submitted, writes);
      const merged = { ...liveValues, ...changes };
      if (writes.includes("titleEn") && !merged.titleEn) {
        return { kind: "invalid", state: fail("Give the destination a name.", { titleEn: "Required." }) };
      }
      if (writes.includes("slug")) {
        if (!SLUG.test(merged.slug)) {
          return {
            kind: "invalid",
            state: fail("The address must be lower-case words joined by hyphens.", { slug: "Invalid." }),
          };
        }
        const clash = await slugTaken(merged.slug, id, tx);
        if (clash) return { kind: "invalid", state: fail(clash, { slug: "Already taken." }) };
      }
      if (writes.length) {
        await tx
          .update(packageDestinations)
          .set({ ...changes, updatedAt: new Date() })
          .where(eq(packageDestinations.id, id));
      }
      // A new address: the destination's SEO record goes with it, in this
      // transaction, still bound to the same destination (Batch 25, B.7). The
      // old address answers 404, as it always has — no redirect is invented.
      if (writes.includes("slug") && merged.slug !== row.slug) {
        await moveSeoRow(tx, "destination", id, row.slug, merged.slug);
      }
      return { kind: "done", writes, title: merged.titleEn };
    });

    if (outcome.kind === "missing") return fail("That destination no longer exists.");
    if (outcome.kind === "invalid") return outcome.state;
    if (outcome.kind === "conflict") {
      const refusal = DESTINATION_FORM.conflictMessage(outcome.units);
      return { ...fail(refusal.message, refusal.errors), conflicts: outcome.units };
    }

    // What the form changed was already so — made the same way elsewhere. Nothing
    // is written or logged; the page is drawn again so the form shows the row.
    if (!outcome.writes.length) {
      revalidatePath(`/admin/packages/destinations/${id}`);
      return ok("Destination saved.");
    }

    await logActivity(session, {
      action: "destination.updated",
      entityType: "destination",
      entityId: id,
      summary: `Updated the destination “${outcome.title}”`,
      metadata: { fields: outcome.writes },
    });
    refresh();
    if (outcome.writes.includes("slug")) revalidate(TAGS.seo);
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
    // they happened to be filed under would not be. Its SEO record goes with it
    // (Batch 25, B.7) — the destination's row first, then its SEO row.
    await db.transaction(async (tx) => {
      const [found] = await tx
        .delete(packageDestinations)
        .where(eq(packageDestinations.id, id))
        .returning({ slug: packageDestinations.slug });
      if (found) await dropSeoRows(tx, "destination", [{ id, address: found.slug }]);
    });
    revalidate(TAGS.seo);

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
