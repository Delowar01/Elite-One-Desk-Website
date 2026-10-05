"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { logActivity } from "@/lib/activity";
import { fail, field, ok, runAction, type ActionState } from "@/lib/admin/actions";
import { guardAction } from "@/lib/auth/guard";
import { TAGS, revalidate } from "@/lib/cache";
import { db } from "@/lib/db";
import type { Executor } from "@/lib/db/revision";
import { packageDestinations, travelPackages } from "@/lib/db/schema";
import { PACKAGE_FORM, packageRowValues, readPackageForm } from "@/lib/packages/form-fields";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * `/packages/[slug]` is one route shared by packages and destinations, which is
 * what keeps every existing package address working. The price is that the two
 * tables must not collide, checked from both sides.
 */
async function slugTaken(slug: string, exceptPackageId?: number, on: Executor = db) {
  const [destination] = await on
    .select({ title: packageDestinations.titleEn })
    .from(packageDestinations)
    .where(eq(packageDestinations.slug, slug))
    .limit(1);
  if (destination) return `The destination “${destination.title}” already uses that address.`;

  const [pkg] = await on
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

/** Refused before anything is read: the form carries no base this server signed for this package. */
const STALE_FORM =
  "This form is out of date, so nothing was saved. Reload the page to see the package as it is now, then make your change again.";

export async function createPackage(_prev: ActionState, form: FormData): Promise<ActionState> {
  let newId = 0;
  const result = await runAction("package-create", async () => {
    const session = await guardAction("packages.manage", form);
    const slug = field(form, "slug", 120).toLowerCase();
    const values = readPackageForm(form);

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

/**
 * Saves what the form changed — and only that (Batch 24, the Services form's
 * rule since Batch 23: docs/admin/services-form-concurrency.md §10).
 *
 * The form posts the signed base it was drawn with. Under the row's lock, each
 * unit the form changed from that base is compared with the row as it is now:
 * untouched units are never written, so a newer value — published from the
 * package's page or its card in the Visual Editor, or saved by somebody else
 * here — stays; a unit changed here *and* elsewhere is a conflict, and any
 * conflict refuses the whole save with nothing written. The activity entry
 * and the cache drop follow the commit, and only a write.
 *
 * Lock order is every writer's: a destination before a package. A form that
 * files the package under another destination holds that destination first —
 * the foreign key would otherwise take it after the package, the reverse of the
 * catalogue's publication, and the two could wait on each other.
 */
export async function updatePackage(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("package-update", async () => {
    const session = await guardAction("packages.manage", form);
    const id = Number(form.get("id"));
    if (!Number.isInteger(id) || id <= 0) return fail("That package no longer exists.");
    const base = PACKAGE_FORM.readBase(String(form.get("_base") ?? ""), id);
    if (!base) return fail(STALE_FORM);

    const submitted = readPackageForm(form);
    const mine = PACKAGE_FORM.printsOf(submitted);
    const posted = PACKAGE_FORM.submittedUnits(form);
    // Decided before the row is even read: a form that changed nothing writes nothing.
    const asked = PACKAGE_FORM.decide(base, mine, base, posted).changed;
    if (!asked.length) return ok("No changes to save.");

    type Outcome =
      | { kind: "missing" }
      | { kind: "invalid"; state: ActionState }
      | { kind: "conflict"; units: string[] }
      | { kind: "done"; writes: string[]; title: string };

    const outcome = await db.transaction(async (tx): Promise<Outcome> => {
      // The destination this form files the package under, first — the order
      // every writer takes them in — and only if it still exists.
      if (asked.includes("destinationId") && submitted.destinationId !== null) {
        const [destination] = await tx
          .select({ id: packageDestinations.id })
          .from(packageDestinations)
          .where(eq(packageDestinations.id, submitted.destinationId))
          .limit(1)
          .for("key share");
        if (!destination) {
          return {
            kind: "invalid",
            state: fail("Choose one of the destinations.", { destinationId: "That destination no longer exists." }),
          };
        }
      }
      const [row] = await tx.select().from(travelPackages).where(eq(travelPackages.id, id)).limit(1).for("update");
      if (!row) return { kind: "missing" };
      const liveValues = packageRowValues(row);
      const decision = PACKAGE_FORM.decide(base, mine, PACKAGE_FORM.printsOf(liveValues), posted);
      if (decision.conflicts.length) return { kind: "conflict", units: decision.conflicts };

      const writes = decision.writes;
      const changes = PACKAGE_FORM.valuesOfUnits(submitted, writes);
      const merged = { ...liveValues, ...changes };
      if (writes.includes("titleEn") && !merged.titleEn) {
        return { kind: "invalid", state: fail("Give the package a title.", { titleEn: "Required." }) };
      }
      // The address is not editable here, but the guard runs anyway: a
      // destination created since this page loaded could have taken it.
      const clash = await slugTaken(row.slug, id, tx);
      if (clash) return { kind: "invalid", state: fail(clash, { slug: "Already taken." }) };

      if (writes.length) {
        await tx
          .update(travelPackages)
          .set({ ...changes, updatedAt: new Date() })
          .where(eq(travelPackages.id, id));
      }
      return { kind: "done", writes, title: merged.titleEn };
    });

    if (outcome.kind === "missing") return fail("That package no longer exists.");
    if (outcome.kind === "invalid") return outcome.state;
    if (outcome.kind === "conflict") {
      const refusal = PACKAGE_FORM.conflictMessage(outcome.units);
      return { ...fail(refusal.message, refusal.errors), conflicts: outcome.units };
    }

    // What the form changed was already so — made the same way elsewhere. Nothing
    // is written or logged; the page is drawn again so the form shows the row.
    if (!outcome.writes.length) {
      revalidatePath(`/admin/packages/${id}`);
      return ok("Package saved.");
    }

    await logActivity(session, {
      action: "package.updated",
      entityType: "package",
      entityId: id,
      summary: `Updated the package “${outcome.title}”`,
      metadata: { fields: outcome.writes },
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
