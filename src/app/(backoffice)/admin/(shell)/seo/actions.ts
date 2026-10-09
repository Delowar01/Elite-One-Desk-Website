"use server";

import { eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { logActivity } from "@/lib/activity";
import { fail, ok, runAction, type ActionState } from "@/lib/admin/actions";
import { guardAction } from "@/lib/auth/guard";
import { TAGS, revalidate } from "@/lib/cache";
import { db } from "@/lib/db";
import { seoMetadata } from "@/lib/db/schema";
import { siteUrl } from "@/lib/env";
import { SEO_FORMS, postedImageProblem, readSeoForm, seoRowValues } from "@/lib/seo-form";
import { canonicalProblem, parseSeoRef, seoRefOf, type SeoRef } from "@/lib/seo-model";
import { claimSeoKey, detachSeoRow, loadSeoTarget, lockOwnSeoRows, lockSeoTarget, lockShareImage } from "@/lib/seo-targets";

/**
 * The SEO screen's two writes (Batch 25 — docs/admin/seo-and-share-images.md
 * B.9). Each one:
 *
 *   · asks for `seo.manage` and the CSRF token (`guardAction`);
 *   · names its target by reference (`destination:3`), never by type and
 *     address, and loads it from the table its kind names — a reference to a
 *     record that does not exist, or exists as something else, is refused;
 *   · is held to the signed base its form was drawn with, field by field, so a
 *     form left open can never put older values back;
 *   · runs in one transaction, holding the target (an advisory lock that also
 *     covers a target with no row yet), its record row, the picture it is about
 *     to name and then its SEO row — in that order (B.11).
 */

const STALE_FORM =
  "This form is out of date, so nothing was saved. Reload the page to see the search and sharing settings as they are now, then make your change again.";
const NO_TARGET = "That page could not be identified.";
const MISSING = "That page no longer exists, so nothing was saved. Reload the page to see the list as it is now.";
const PICTURE_GONE = "That picture is no longer in the media library. Choose another one.";

/**
 * A form drawn by the previous release names its page by type and address and
 * posts no base: it is out of date before anything else is read — the answer
 * every Batch 23–25 form gives such a post (DEPLOYMENT.md, tabs left open).
 */
const drawnBefore = (form: FormData): boolean => !String(form.get("_base") ?? "");

/** A target named by the form, or `null`. The site defaults are not saved here. */
function targetOf(form: FormData): SeoRef | null {
  const ref = parseSeoRef(String(form.get("target") ?? ""));
  return ref && ref.kind !== "site" ? ref : null;
}

/**
 * A foreign key the picture lock could not have prevented — the previous
 * release deleting a picture in the deploy window, which takes no lock — read
 * as what it means rather than as "something went wrong".
 */
const isMissingPicture = (error: unknown): boolean => {
  const codeOf = (value: unknown) =>
    value && typeof value === "object" && "code" in value ? (value as { code?: unknown }).code : undefined;
  const cause = error && typeof error === "object" && "cause" in error ? (error as { cause?: unknown }).cause : undefined;
  return codeOf(error) === "23503" || codeOf(cause) === "23503";
};

export async function saveSeo(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("seo-save", async () => {
    const session = await guardAction("seo.manage", form);
    if (drawnBefore(form)) return fail(STALE_FORM);
    const ref = targetOf(form);
    if (!ref) return fail(NO_TARGET);
    const spec = SEO_FORMS[ref.kind as keyof typeof SEO_FORMS];
    const base = spec.readBase(String(form.get("_base") ?? ""), ref.id);
    if (!base) return fail(STALE_FORM);

    const imageProblem = postedImageProblem(form);
    if (imageProblem) return fail(imageProblem, { ogImageId: imageProblem });
    const submitted = readSeoForm(form);
    const mine = spec.printsOf(submitted);
    const posted = spec.submittedUnits(form);
    // Decided before anything is read: a form that changed nothing writes nothing.
    const asked = spec.decide(base, mine, base, posted).changed;
    if (!asked.length) return ok("No changes to save.");
    if (asked.includes("canonicalUrl")) {
      const problem = canonicalProblem(submitted.canonicalUrl, siteUrl);
      if (problem) return fail(problem, { canonicalUrl: problem });
    }

    type Outcome =
      | { kind: "missing" }
      | { kind: "invalid"; state: ActionState }
      | { kind: "conflict"; units: string[] }
      | { kind: "done"; writes: string[]; label: string; address: string };

    let outcome: Outcome;
    try {
      outcome = await db.transaction(async (tx): Promise<Outcome> => {
        await lockSeoTarget(tx, ref);
        const target = await loadSeoTarget(tx, ref, { lock: true });
        if (!target?.storage) return { kind: "missing" };
        // The picture before the SEO row: the order a media deletion takes them in.
        if (asked.includes("ogImageId") && submitted.ogImageId !== null) {
          const problem = await lockShareImage(tx, submitted.ogImageId);
          if (problem) return { kind: "invalid", state: fail(problem, { ogImageId: problem }) };
        }
        // The present key is what the save ends at: whatever holds it is locked with
        // the target's own rows, in one order (`lockOwnSeoRows`, W1³).
        const { own, rows } = await lockOwnSeoRows(tx, target.storage, target.storage.entityKey);
        const decision = spec.decide(base, mine, spec.printsOf(seoRowValues(own)), posted);
        if (decision.conflicts.length) return { kind: "conflict", units: decision.conflicts };
        const done = { kind: "done" as const, writes: decision.writes, label: target.label, address: target.path };
        if (!decision.writes.length) return done;

        const changes = spec.valuesOfUnits(submitted, decision.writes);
        // The key is always the present address and the id the record's: a row
        // the previous release wrote by address is bound the first time it is saved.
        const identity = { entityKey: target.storage.entityKey, entityId: target.storage.entityId };
        if (own) {
          // The record's other row — its own row left at an old address, shadowed
          // by the newer one being saved (`preferredSeoRow`) — is set aside, kept.
          for (const row of rows) if (row.id !== own.id) await detachSeoRow(tx, target.storage.entityType, row.id);
          if (own.entityKey !== identity.entityKey) {
            await claimSeoKey(tx, target.storage.entityType, identity.entityKey, own.id);
          }
          await tx
            .update(seoMetadata)
            .set({ ...changes, ...identity, updatedAt: new Date() })
            .where(eq(seoMetadata.id, own.id));
        } else {
          await claimSeoKey(tx, target.storage.entityType, identity.entityKey, null);
          const inserted = await tx
            .insert(seoMetadata)
            .values({ entityType: target.storage.entityType, ...identity, ...changes })
            .onConflictDoNothing()
            .returning({ id: seoMetadata.id });
          // Only a writer outside these locks can get here first — the previous
          // release, in the deploy window. Its row is somebody else's change.
          if (!inserted.length) return { kind: "conflict", units: decision.writes };
        }
        return done;
      });
    } catch (error) {
      if (isMissingPicture(error)) return fail(PICTURE_GONE, { ogImageId: PICTURE_GONE });
      throw error;
    }

    if (outcome.kind === "missing") return fail(MISSING);
    if (outcome.kind === "invalid") return outcome.state;
    if (outcome.kind === "conflict") {
      const refusal = spec.conflictMessage(outcome.units);
      return { ...fail(refusal.message, refusal.errors), conflicts: outcome.units };
    }
    // What the form changed was already so — made the same way elsewhere.
    // Nothing is written or logged; the screen is drawn again with the record.
    if (!outcome.writes.length) {
      revalidatePath("/admin/seo");
      return ok("SEO saved.");
    }

    await logActivity(session, {
      action: "seo.updated",
      entityType: "seo",
      entityId: seoRefOf(ref),
      summary: `Updated search and sharing for “${outcome.label}” (${outcome.address})`,
      metadata: { fields: outcome.writes, address: outcome.address },
    });
    revalidate(TAGS.seo);
    revalidatePath("/admin/seo");
    return ok("SEO saved.");
  });
}

export async function clearSeo(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("seo-clear", async () => {
    const session = await guardAction("seo.manage", form);
    if (drawnBefore(form)) return fail(STALE_FORM);
    const ref = targetOf(form);
    if (!ref) return fail(NO_TARGET);
    const spec = SEO_FORMS[ref.kind as keyof typeof SEO_FORMS];
    const base = spec.readBase(String(form.get("_base") ?? ""), ref.id);
    if (!base) return fail(STALE_FORM);

    type Outcome =
      | { kind: "missing" }
      | { kind: "absent" }
      | { kind: "conflict"; units: string[] }
      | { kind: "done"; label: string; address: string };

    const outcome = await db.transaction(async (tx): Promise<Outcome> => {
      await lockSeoTarget(tx, ref);
      const target = await loadSeoTarget(tx, ref, { lock: true });
      if (!target?.storage) return { kind: "missing" };
      const { own, rows } = await lockOwnSeoRows(tx, target.storage);
      // Removed already — by somebody else, or by this form a moment ago: what
      // was asked for holds, and nothing is written.
      if (!own) return { kind: "absent" };
      // A removal discards every field, so every field must still be what the
      // form was drawn with: removing somebody else's newer edit unseen is the
      // lost update this refuses.
      const live = spec.printsOf(seoRowValues(own));
      const moved = spec.units.map((unit) => unit.key).filter((key) => live[key] !== base[key]);
      if (moved.length) return { kind: "conflict", units: moved };
      await tx.delete(seoMetadata).where(eq(seoMetadata.id, own.id));
      // A row it shadowed would otherwise come back as the page's record.
      for (const row of rows) if (row.id !== own.id) await detachSeoRow(tx, target.storage.entityType, row.id);
      return { kind: "done", label: target.label, address: target.path };
    });

    if (outcome.kind === "missing") return fail(MISSING);
    // Nothing was there: say so, and leave no entry for a removal that did not
    // happen (19B).
    if (outcome.kind === "absent") return ok("There was no override to remove.");
    if (outcome.kind === "conflict") {
      const labels = outcome.units.map((key) => spec.unitLabel(key));
      const named = labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : labels[0];
      return {
        ...fail(
          `${named} ${labels.length > 1 ? "were" : "was"} changed elsewhere while this form was open, so the override was not removed. Reload the page to see the newer version first.`,
        ),
        conflicts: outcome.units,
      };
    }

    await logActivity(session, {
      action: "seo.cleared",
      entityType: "seo",
      entityId: seoRefOf(ref),
      summary: `Removed the search and sharing override for “${outcome.label}” (${outcome.address})`,
      metadata: { address: outcome.address },
    });
    revalidate(TAGS.seo);
    revalidatePath("/admin/seo");
    return ok("Override removed. The page follows its own title and description again.");
  });
}
