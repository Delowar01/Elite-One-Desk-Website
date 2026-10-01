"use server";

import { eq, gt, lt, sql } from "drizzle-orm";
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
import { db } from "@/lib/db";
import { videos } from "@/lib/db/schema";
import { youtubeId } from "@/lib/youtube";

const refresh = () => {
  revalidate(TAGS.videos);
  revalidatePath("/admin/videos");
};

export async function saveVideo(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("video-save", async () => {
    const session = await guardAction("videos.manage", form);
    const id = Number(form.get("id")) || 0;
    const source = field(form, "sourceUrl", 255);
    const parsed = youtubeId(source);

    if (!parsed) {
      return fail("That is not a YouTube address we recognise.", {
        sourceUrl: "Paste a youtube.com or youtu.be link, or the 11-character id.",
      });
    }
    const titleEn = field(form, "titleEn", 190);
    if (!titleEn) return fail("Give the video a title.", { titleEn: "Required." });

    const values = {
      youtubeId: parsed,
      sourceUrl: source,
      titleEn,
      titleAr: field(form, "titleAr", 190),
      descriptionEn: field(form, "descriptionEn", 1000),
      descriptionAr: field(form, "descriptionAr", 1000),
      category: field(form, "category", 64) || "general",
      thumbnailId: optionalId(form, "thumbnailId"),
      durationLabel: field(form, "durationLabel", 16),
      isFeatured: checkbox(form, "isFeatured"),
      isPublished: checkbox(form, "isPublished"),
      sortOrder: numberField(form, "sortOrder", 0),
    };

    // An id that names no video is refused, not reported — and logged — as
    // saved; a new one is logged under the id it was given (19B).
    let savedId = id;
    if (id) {
      const [updated] = await db
        .update(videos)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(videos.id, id))
        .returning({ id: videos.id });
      if (!updated) return fail("That video no longer exists.");
    } else {
      const [last] = await db
        .select({ n: sql<number>`coalesce(max(${videos.sortOrder}), -1)::int` })
        .from(videos);
      const [created] = await db
        .insert(videos)
        .values({ ...values, sortOrder: (last?.n ?? -1) + 1 })
        .returning({ id: videos.id });
      savedId = created!.id;
    }

    await logActivity(session, {
      action: id ? "video.updated" : "video.added",
      entityType: "video",
      entityId: savedId,
      summary: `${id ? "Updated" : "Added"} the video “${titleEn}”`,
    });
    refresh();
    return ok(id ? "Video saved." : "Video added.");
  });
}

export async function deleteVideo(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("video-delete", async () => {
    const session = await guardAction("videos.manage", form);
    const id = Number(form.get("id"));
    const [row] = await db.select().from(videos).where(eq(videos.id, id)).limit(1);
    if (!row) return fail("That video no longer exists.");

    // Only the record goes; an uploaded thumbnail stays in the library.
    await db.delete(videos).where(eq(videos.id, id));
    await logActivity(session, {
      action: "video.removed",
      entityType: "video",
      entityId: id,
      summary: `Removed the video “${row.titleEn}”`,
    });
    refresh();
    return ok("Video removed.");
  });
}

export async function toggleVideo(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("video-toggle", async () => {
    const session = await guardAction("videos.manage", form);
    const id = Number(form.get("id"));
    const what = field(form, "what", 16);
    const [row] = await db.select().from(videos).where(eq(videos.id, id)).limit(1);
    if (!row) return fail("That video no longer exists.");

    const next =
      what === "featured"
        ? { isFeatured: !row.isFeatured }
        : { isPublished: !row.isPublished };
    await db.update(videos).set({ ...next, updatedAt: new Date() }).where(eq(videos.id, id));

    await logActivity(session, {
      action: "video.updated",
      entityType: "video",
      entityId: id,
      summary: `Toggled ${what} on “${row.titleEn}”`,
    });
    refresh();
    return ok();
  });
}

export async function moveVideo(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("video-move", async () => {
    const session = await guardAction("videos.manage", form);
    const id = Number(form.get("id"));
    const up = field(form, "direction", 8) === "up";
    const [row] = await db.select().from(videos).where(eq(videos.id, id)).limit(1);
    if (!row) return fail("That video no longer exists.");

    const [neighbour] = await db
      .select()
      .from(videos)
      .where(up ? lt(videos.sortOrder, row.sortOrder) : gt(videos.sortOrder, row.sortOrder))
      .orderBy(up ? sql`sort_order desc` : sql`sort_order asc`)
      .limit(1);
    if (!neighbour) return ok();

    await db.transaction(async (tx) => {
      await tx.update(videos).set({ sortOrder: -1 }).where(eq(videos.id, row.id));
      await tx.update(videos).set({ sortOrder: row.sortOrder }).where(eq(videos.id, neighbour.id));
      await tx.update(videos).set({ sortOrder: neighbour.sortOrder }).where(eq(videos.id, row.id));
    });
    // A reorder is a change like any other, and the audit trail says so (19B).
    await logActivity(session, {
      action: "video.reordered",
      entityType: "video",
      entityId: row.id,
      summary: `Moved the video “${row.titleEn}” ${up ? "up" : "down"}`,
    });
    refresh();
    return ok();
  });
}
