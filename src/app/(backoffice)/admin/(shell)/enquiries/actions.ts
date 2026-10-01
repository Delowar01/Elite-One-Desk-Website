"use server";

import { and, eq } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { logActivity } from "@/lib/activity";
import { field, fail, ok, runAction, type ActionState } from "@/lib/admin/actions";
import { isEnquiryStatus, STATUS_LABEL } from "@/lib/admin/enquiry";
import { guardAction } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { enquiries, enquiryNotes, users } from "@/lib/db/schema";

export async function updateEnquiry(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("enquiry-update", async () => {
    const session = await guardAction("enquiries.manage", form);
    const id = Number(form.get("id"));
    if (!Number.isInteger(id) || id <= 0) return fail("That enquiry no longer exists.");

    const status = field(form, "status", 32);
    if (!isEnquiryStatus(status)) return fail("Choose a valid status.");

    /**
     * Someone on the team, as the form's list offers: an active account. The
     * person already assigned stays assignable even after their account is
     * switched off, so changing the status alone never fails over the
     * assignee (19B).
     */
    const assignedRaw = field(form, "assignedTo", 12);
    let assignedTo: number | null = null;
    if (assignedRaw) {
      const wanted = Number(assignedRaw);
      if (!Number.isInteger(wanted) || wanted <= 0) return fail("Choose someone from the team.");
      const [current] = await db
        .select({ assignedTo: enquiries.assignedTo })
        .from(enquiries)
        .where(eq(enquiries.id, id))
        .limit(1);
      if (!current) return fail("That enquiry no longer exists.");
      if (current.assignedTo !== wanted) {
        const [person] = await db
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.id, wanted), eq(users.isActive, true)))
          .limit(1);
        if (!person) return fail("Choose someone from the team.");
      }
      assignedTo = wanted;
    }

    const [updated] = await db
      .update(enquiries)
      .set({
        status,
        assignedTo,
        isRead: true,
        updatedAt: new Date(),
      })
      .where(eq(enquiries.id, id))
      .returning({ reference: enquiries.reference });

    if (!updated) return fail("That enquiry no longer exists.");

    await logActivity(session, {
      action: "enquiry.status_changed",
      entityType: "enquiry",
      entityId: id,
      summary: `Set ${updated.reference} to ${STATUS_LABEL[status]}`,
      metadata: { status, assignedTo },
    });

    revalidatePath("/admin/enquiries");
    revalidatePath(`/admin/enquiries/${id}`);
    return ok("Enquiry updated.");
  });
}

export async function addEnquiryNote(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("enquiry-note", async () => {
    const session = await guardAction("enquiries.manage", form);
    const id = Number(form.get("id"));
    const body = field(form, "body", 4000);
    if (!Number.isInteger(id) || id <= 0) return fail("That enquiry no longer exists.");
    if (!body) return fail("Write something before saving the note.");

    await db.insert(enquiryNotes).values({
      enquiryId: id,
      userId: session.user.id,
      authorName: session.user.name,
      body,
    });

    await logActivity(session, {
      action: "enquiry.note_added",
      entityType: "enquiry",
      entityId: id,
      summary: "Added an internal note",
    });

    revalidatePath(`/admin/enquiries/${id}`);
    return ok("Note added.");
  });
}
