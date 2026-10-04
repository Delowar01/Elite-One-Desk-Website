"use server";

import { and, eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { logActivity } from "@/lib/activity";
import { fail, field, ok, runAction, type ActionState } from "@/lib/admin/actions";
import { guardAction } from "@/lib/auth/guard";
import { TAGS, revalidate } from "@/lib/cache";
import { db } from "@/lib/db";
import { serviceSubcategories, services } from "@/lib/db/schema";
import type { Executor } from "@/lib/db/revision";
import {
  decideServiceSave,
  printsOf,
  readServiceBase,
  readServiceForm,
  rowValues,
  SERVICE_FORM_UNITS,
  submittedUnits,
  unitLabel,
  valuesOfUnits,
} from "@/lib/services/form-fields";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const refresh = () => {
  revalidate(TAGS.catalog);
  revalidatePath("/admin/services");
};

/**
 * A service filed under a group must sit in that group's category. The form
 * only offers matching pairs; the server holds the same rule rather than
 * trusting that it did, because a mismatched pair lists the service under one
 * category and its group under another (19B).
 */
async function groupProblem(
  values: { categoryId: number; subcategoryId: number | null },
  on: Executor = db,
): Promise<ActionState | null> {
  if (!values.subcategoryId) return null;
  const [group] = await on
    .select({ id: serviceSubcategories.id })
    .from(serviceSubcategories)
    .where(
      and(eq(serviceSubcategories.id, values.subcategoryId), eq(serviceSubcategories.categoryId, values.categoryId)),
    )
    .limit(1);
  return group ? null : fail("Choose a group from this service's category.", { subcategoryId: "Not in this category." });
}

export async function createService(_prev: ActionState, form: FormData): Promise<ActionState> {
  let newId = 0;
  const result = await runAction("service-create", async () => {
    const session = await guardAction("services.manage", form);
    const slug = field(form, "slug", 120).toLowerCase();
    const values = readServiceForm(form);

    if (!values.titleEn) return fail("Give the service a title.", { titleEn: "Required." });
    if (!values.categoryId) return fail("Choose a category.", { categoryId: "Required." });
    const createProblem = await groupProblem(values);
    if (createProblem) return createProblem;
    if (!SLUG.test(slug)) {
      return fail("The address must be lower-case words joined by hyphens.", { slug: "Invalid." });
    }

    const [taken] = await db
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.categoryId, values.categoryId), eq(services.slug, slug)))
      .limit(1);
    if (taken) return fail("A service in that category already uses this address.", { slug: "Already taken." });

    const [row] = await db
      .insert(services)
      .values({ ...values, slug })
      .returning({ id: services.id });
    newId = row!.id;

    await logActivity(session, {
      action: "service.created",
      entityType: "service",
      entityId: newId,
      summary: `Created the service “${values.titleEn}”`,
    });
    refresh();
    return ok("Service created.", newId);
  });

  if (!result.ok) return result;
  redirect(`/admin/services/${newId}`);
}

/** Refused before anything is read: the form carries no base this server signed for this service. */
const STALE_FORM =
  "This form is out of date, so nothing was saved. Reload the page to see the service as it is now, then make your change again.";

/**
 * Saves what the form changed — and only that (Batch 23,
 * docs/admin/services-form-concurrency.md).
 *
 * The form posts the signed base it was drawn with. Under the row's lock, each
 * unit the form changed from that base is compared with the row as it is now:
 * untouched units are never written, so a newer value saved elsewhere stays;
 * a unit changed here *and* elsewhere is a conflict, and any conflict refuses
 * the whole save with nothing written. The activity entry and the cache drop
 * follow the commit, and only a write.
 */
export async function updateService(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("service-update", async () => {
    const session = await guardAction("services.manage", form);
    const id = Number(form.get("id"));
    if (!Number.isInteger(id) || id <= 0) return fail("That service no longer exists.");
    const base = readServiceBase(String(form.get("_base") ?? ""), id);
    if (!base) return fail(STALE_FORM);

    const submitted = readServiceForm(form);
    const mine = printsOf(submitted);
    const posted = submittedUnits(form);
    // Decided before the row is even read: a form that changed nothing writes nothing.
    if (!decideServiceSave(base, mine, base, posted).changed.length) return ok("No changes to save.");

    type Outcome =
      | { kind: "missing" }
      | { kind: "invalid"; state: ActionState }
      | { kind: "conflict"; units: string[] }
      | { kind: "done"; writes: string[]; title: string };

    const outcome = await db.transaction(async (tx): Promise<Outcome> => {
      // The row first, held: the order every route publication takes it in.
      const [row] = await tx.select().from(services).where(eq(services.id, id)).limit(1).for("update");
      if (!row) return { kind: "missing" };
      const liveValues = rowValues(row);
      const decision = decideServiceSave(base, mine, printsOf(liveValues), posted);
      if (decision.conflicts.length) return { kind: "conflict", units: decision.conflicts };

      const writes = decision.writes;
      const changes = valuesOfUnits(submitted, writes);
      const merged = { ...liveValues, ...changes };
      if (writes.includes("titleEn") && !merged.titleEn) {
        return { kind: "invalid", state: fail("Give the service a title.", { titleEn: "Required." }) };
      }
      if (writes.includes("placement")) {
        if (!merged.categoryId) return { kind: "invalid", state: fail("Choose a category.", { categoryId: "Required." }) };
        const problem = await groupProblem(merged, tx);
        if (problem) return { kind: "invalid", state: problem };
        if (merged.categoryId !== row.categoryId) {
          const [taken] = await tx
            .select({ id: services.id })
            .from(services)
            .where(and(eq(services.categoryId, merged.categoryId), eq(services.slug, row.slug)))
            .limit(1);
          if (taken) {
            return {
              kind: "invalid",
              state: fail("A service in that category already uses this address.", { categoryId: "Address already taken there." }),
            };
          }
        }
      }
      if (writes.length) {
        await tx
          .update(services)
          .set({ ...changes, updatedAt: new Date() })
          .where(eq(services.id, id));
      }
      return { kind: "done", writes, title: merged.titleEn };
    });

    if (outcome.kind === "missing") return fail("That service no longer exists.");
    if (outcome.kind === "invalid") return outcome.state;
    if (outcome.kind === "conflict") {
      const labels = outcome.units.map(unitLabel);
      const named = labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : labels[0];
      const errors = Object.fromEntries(
        SERVICE_FORM_UNITS.filter((unit) => outcome.units.includes(unit.key)).flatMap((unit) =>
          unit.fields.map((name) => [name, "Changed elsewhere since this form was opened."]),
        ),
      );
      return {
        ...fail(
          `${named} ${labels.length > 1 ? "were" : "was"} changed elsewhere while this form was open, so nothing was saved. Reload the page to see the newer version, then make your change again.`,
          errors,
        ),
        conflicts: outcome.units,
      };
    }

    // What the form changed was already so — made the same way elsewhere. Nothing
    // is written or logged; the page is drawn again so the form shows the row.
    if (!outcome.writes.length) {
      revalidatePath(`/admin/services/${id}`);
      return ok("Service saved.");
    }

    await logActivity(session, {
      action: "service.updated",
      entityType: "service",
      entityId: id,
      summary: `Updated the service “${outcome.title}”`,
      metadata: { fields: outcome.writes },
    });
    refresh();
    revalidatePath(`/admin/services/${id}`);
    return ok("Service saved.");
  });
}

export async function toggleServicePublished(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("service-toggle", async () => {
    const session = await guardAction("services.manage", form);
    const id = Number(form.get("id"));
    const [row] = await db.select().from(services).where(eq(services.id, id)).limit(1);
    if (!row) return fail("That service no longer exists.");

    await db
      .update(services)
      .set({ isPublished: !row.isPublished, updatedAt: new Date() })
      .where(eq(services.id, id));

    await logActivity(session, {
      action: row.isPublished ? "service.unpublished" : "service.published",
      entityType: "service",
      entityId: id,
      summary: `${row.isPublished ? "Unpublished" : "Published"} “${row.titleEn}”`,
    });
    refresh();
    return ok(row.isPublished ? "Service hidden from the site." : "Service is live.");
  });
}

export async function deleteService(_prev: ActionState, form: FormData): Promise<ActionState> {
  const result = await runAction("service-delete", async () => {
    const session = await guardAction("services.manage", form);
    const id = Number(form.get("id"));
    const [row] = await db.select().from(services).where(eq(services.id, id)).limit(1);
    if (!row) return fail("That service no longer exists.");

    await db.delete(services).where(eq(services.id, id));
    await logActivity(session, {
      action: "service.deleted",
      entityType: "service",
      entityId: id,
      summary: `Deleted the service “${row.titleEn}”`,
    });
    refresh();
    return ok("Service deleted.");
  });
  if (!result.ok) return result;
  redirect("/admin/services");
}
