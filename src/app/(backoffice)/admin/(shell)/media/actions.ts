"use server";

import { asc, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { logActivity } from "@/lib/activity";
import { fail, field, ok, runAction, type ActionState } from "@/lib/admin/actions";
import { guardAction } from "@/lib/auth/guard";
import { TAGS, revalidate } from "@/lib/cache";
import { db } from "@/lib/db";
import { media, seoMetadata } from "@/lib/db/schema";
import { deleteMediaFiles, processUpload } from "@/lib/media/process";
import { isMediaFolder } from "@/lib/media/folders";
import { mediaUsage, type MediaUse } from "@/lib/media/usage";

export async function uploadMedia(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("media-upload", async () => {
    const session = await guardAction("media.manage", form);
    const files = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    if (!files.length) return fail("Choose at least one image to upload.");
    if (files.length > 12) return fail("Upload up to twelve images at a time.");

    const requested = field(form, "folder", 64);
    const folder = isMediaFolder(requested) ? requested : "general";
    const results = await Promise.all(
      files.map(async (file) =>
        processUpload(await file.arrayBuffer(), {
          originalName: file.name,
          folder,
          title: files.length === 1 ? field(form, "title", 190) : "",
          altEn: files.length === 1 ? field(form, "altEn", 255) : "",
          altAr: files.length === 1 ? field(form, "altAr", 255) : "",
          uploadedBy: session.user.id,
        }),
      ),
    );

    const failed = results.filter((r) => !r.ok);
    const added = results.length - failed.length;

    if (added) {
      await logActivity(session, {
        action: "media.uploaded",
        entityType: "media",
        summary: `Uploaded ${added} image${added === 1 ? "" : "s"}`,
      });
      revalidate(TAGS.media);
      revalidatePath("/admin/media");
    }

    if (failed.length) {
      const first = failed[0];
      return fail(
        `${added} uploaded, ${failed.length} rejected. ${first && !first.ok ? first.error : ""}`.trim(),
      );
    }
    return ok(`Uploaded ${added} image${added === 1 ? "" : "s"}.`);
  });
}

export async function updateMedia(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("media-update", async () => {
    const session = await guardAction("media.manage", form);
    const id = Number(form.get("id"));
    const folder = field(form, "folder", 64);

    const [row] = await db
      .update(media)
      .set({
        title: field(form, "title", 190),
        altEn: field(form, "altEn", 255),
        altAr: field(form, "altAr", 255),
        folder: isMediaFolder(folder) ? folder : "general",
        updatedAt: new Date(),
      })
      .where(eq(media.id, id))
      .returning({ filename: media.filename });
    if (!row) return fail("That image no longer exists.");

    await logActivity(session, {
      action: "media.updated",
      entityType: "media",
      entityId: id,
      summary: `Updated details for ${row.filename}`,
    });
    revalidate(TAGS.media);
    revalidatePath("/admin/media");
    return ok("Image details saved.");
  });
}

export async function deleteMedia(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("media-delete", async () => {
    const session = await guardAction("media.manage", form);
    const id = Number(form.get("id"));
    if (!Number.isInteger(id) || id <= 0) return fail("That image no longer exists.");

    /**
     * The check and the delete are one transaction holding the picture
     * (Batch 25, F5): every place that names it is counted on this connection
     * after the row is locked, so a writer that locks the picture before naming
     * it — an SEO record, the site's default share image, a page's or record's
     * own picture through its foreign key — either finished first and is
     * counted, or waits and then finds the picture gone. Nothing is left
     * pointing at a deleted picture by a save that raced the delete.
     */
    type Outcome = { kind: "missing" } | { kind: "used"; uses: MediaUse[] } | { kind: "deleted"; row: typeof media.$inferSelect };
    let outcome: Outcome;
    try {
      outcome = await db.transaction(async (tx): Promise<Outcome> => {
        const [row] = await tx.select().from(media).where(eq(media.id, id)).limit(1).for("update");
        if (!row) return { kind: "missing" };
        /**
         * The SEO rows that name the picture (Batch 26). `ON DELETE SET NULL`
         * writes every one of them the recount does not count, in whatever
         * order its scan meets them — and an SEO writer holding two of them in
         * another order (an address moving, a category taking its services'
         * rows with it) would close a cycle with it. So the delete takes them
         * here, all at once and without waiting: a row being changed at this
         * moment refuses the delete instead. From here on it waits for no row
         * — no row can come to name a picture held `FOR UPDATE` — and before
         * here it held nothing, so it can never be part of a deadlock with an
         * application writer (only a deploy's schema migration can meet it in
         * the other order; `lib/media/hold.ts`). Taken before the recount, so
         * the rows it decides on stay as read.
         */
        await tx
          .select({ id: seoMetadata.id })
          .from(seoMetadata)
          .where(eq(seoMetadata.ogImageId, id))
          .orderBy(asc(seoMetadata.id))
          .for("no key update", { noWait: true });
        const uses = await mediaUsage(id, tx);
        if (uses.length) return { kind: "used", uses };
        await tx.delete(media).where(eq(media.id, id));
        return { kind: "deleted", row };
      });
    } catch (error) {
      if (!lockNotAvailable(error)) throw error;
      return fail("A search and sharing record that names this image is being saved right now. Nothing was deleted — try again in a moment.");
    }

    if (outcome.kind === "missing") return fail("That image no longer exists.");
    if (outcome.kind === "used") {
      const { uses } = outcome;
      return fail(
        `Still in use on ${uses.length} screen${uses.length === 1 ? "" : "s"}: ${uses
          .slice(0, 3)
          .map((u) => u.label)
          .join(", ")}${uses.length > 3 ? "…" : ""}. Remove it there first.`,
      );
    }

    // The files go once the row is gone for good — never inside a transaction
    // that could still roll back and keep a row whose file had been unlinked.
    const { row } = outcome;
    await deleteMediaFiles(row.filename, row.derivatives ?? []);

    await logActivity(session, {
      action: "media.deleted",
      entityType: "media",
      entityId: id,
      summary: `Deleted ${row.filename}`,
    });
    // An SEO record that named the picture without being used by any page has
    // just lost it (`ON DELETE SET NULL`): its cached copy goes too.
    revalidate(TAGS.media, TAGS.seo);
    revalidatePath("/admin/media");
    return ok("Image deleted.");
  });
}

/** Postgres's `lock_not_available` (55P03), however deep the driver wrapped it. */
function lockNotAvailable(error: unknown): boolean {
  for (let at: unknown = error, depth = 0; at && typeof at === "object" && depth < 5; at = (at as { cause?: unknown }).cause, depth += 1) {
    if ((at as { code?: unknown }).code === "55P03") return true;
  }
  return false;
}
