"use server";

import { and, asc, eq, gt, lt, sql } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";

import { logActivity } from "@/lib/activity";
import {
  checkbox,
  fail,
  field,
  numberField,
  ok,
  runAction,
  type ActionState,
} from "@/lib/admin/actions";
import { guardAction } from "@/lib/auth/guard";
import { TAGS, revalidate } from "@/lib/cache";
import { getBlock } from "@/lib/cms/blocks";
import { emptyValues } from "@/lib/cms/values";
import { parseBlockPayload } from "@/lib/cms/validate";
import { db } from "@/lib/db";
import { updateSectionGuarded, updateSectionGuardedIn } from "@/lib/db/revision";
import { pageSections, pages } from "@/lib/db/schema";

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** Addresses the site owns; a custom page may not shadow one. */
const RESERVED = new Set([
  "admin", "api", "media", "services", "packages", "search", "home", "_next", "brand", "fonts",
]);

/**
 * What a lost race is called in front of an editor.
 *
 * Every content writer names the revision it read (`lib/db/revision.ts`), so a
 * write that finds a different one has been overtaken — by the Visual Editor,
 * by another browser tab, by a colleague. Saying so is the point of the guard:
 * writing anyway is last-write-wins, which is how an hour of somebody else's
 * work disappears without either of them noticing.
 */
const CONFLICT = {
  save: "This section changed while you were editing it. Reload the page before saving.",
  publish: "This section changed while you were looking at it. Reload the page before publishing.",
  discard: "This section changed while you were looking at it. Reload the page before discarding.",
  publishAll:
    "A section on this page changed while you were publishing. Nothing was published — reload the page and try again.",
  publishAllGone:
    "A section on this page was deleted while you were publishing. Nothing was published — reload the page.",
  gone: "That section no longer exists.",
  unreadable: "The form could not be read. Reload the page and try again.",
} as const;

/**
 * The revision the screen that submitted this form was built from.
 *
 * Every content action reads it here and nowhere else, so none of them can
 * drift into inferring it. `null` means the form did not carry one — an old
 * tab open across a deploy, or a hand-made request — and that is refused
 * rather than defaulted, because every default is a screen whose staleness
 * nobody checked.
 */
function expectedRevisionOf(form: FormData): number | null {
  const value = numberField(form, "expectedRevision", -1);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** Thrown inside the publish-all transaction so the whole batch rolls back. */
class PublishRace extends Error {
  constructor(readonly reason: "conflict" | "missing") {
    super(reason);
    this.name = "PublishRace";
  }
}

const refreshPage = (slug: string) => {
  revalidate(TAGS.pages);
  revalidatePath(`/admin/pages/${slug}`);
  revalidatePath("/admin/pages");
};

/**
 * The same, plus the section editor's own address.
 *
 * The editor's screen keeps up with the row on its own: the revision in its
 * forms and the draft banner both follow a save without a reload — thirty-six
 * consecutive saves in Chromium, no self-conflicts. It did so before this line
 * existed, by side effect of revalidating the page's other admin screens.
 * Naming the route the action was actually submitted from makes that a property
 * of the code rather than of what happens to invalidate what.
 */
const refreshSection = (slug: string, id: number) => {
  revalidatePath(`/admin/pages/section/${id}`);
  refreshPage(slug);
};

export async function createPage(_prev: ActionState, form: FormData): Promise<ActionState> {
  let slug = "";
  const result = await runAction("page-create", async () => {
    const session = await guardAction("content.manage", form);
    const titleEn = field(form, "titleEn", 190);
    slug = field(form, "slug", 120).toLowerCase();

    if (!titleEn) return fail("Give the page a title.", { titleEn: "Required." });
    if (!SLUG.test(slug)) {
      return fail("The address must be lower-case words joined by hyphens.", {
        slug: "Use letters, numbers and hyphens only.",
      });
    }
    if (RESERVED.has(slug)) {
      return fail("That address is used by the site itself.", { slug: "Choose another address." });
    }

    const [existing] = await db.select({ id: pages.id }).from(pages).where(eq(pages.slug, slug)).limit(1);
    if (existing) return fail("A page already uses that address.", { slug: "Already taken." });

    const [row] = await db
      .insert(pages)
      .values({
        slug,
        kind: "custom",
        titleEn,
        titleAr: field(form, "titleAr", 190),
        isPublished: false,
      })
      .returning({ id: pages.id });

    // A blank page is not useful; every new page starts with a hero.
    await db.insert(pageSections).values({
      pageId: row!.id,
      blockType: "page-hero",
      position: 0,
      published: emptyValues(getBlock("page-hero")!),
    });

    await logActivity(session, {
      action: "page.created",
      entityType: "page",
      entityId: row!.id,
      summary: `Created the page “${titleEn}”`,
    });
    refreshPage(slug);
    return ok("Page created.", row!.id);
  });

  if (!result.ok) return result;
  redirect(`/admin/pages/${slug}`);
}

export async function updatePage(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("page-update", async () => {
    const session = await guardAction("content.manage", form);
    const id = Number(form.get("id"));
    const titleEn = field(form, "titleEn", 190);
    if (!titleEn) return fail("Give the page a title.", { titleEn: "Required." });

    const [row] = await db
      .update(pages)
      .set({
        titleEn,
        titleAr: field(form, "titleAr", 190),
        isPublished: checkbox(form, "isPublished"),
        updatedAt: new Date(),
      })
      .where(eq(pages.id, id))
      .returning({ slug: pages.slug });
    if (!row) return fail("That page no longer exists.");

    await logActivity(session, {
      action: "page.updated",
      entityType: "page",
      entityId: id,
      summary: `Updated the page “${titleEn}”`,
    });
    refreshPage(row.slug);
    return ok("Page saved.");
  });
}

export async function deletePage(_prev: ActionState, form: FormData): Promise<ActionState> {
  const result = await runAction("page-delete", async () => {
    const session = await guardAction("content.manage", form);
    const id = Number(form.get("id"));
    const [row] = await db.select().from(pages).where(eq(pages.id, id)).limit(1);
    if (!row) return fail("That page no longer exists.");
    // Home, About, Contact and the legal pages are part of the site's structure.
    if (row.kind === "builtin") return fail("Built-in pages cannot be deleted, only unpublished.");

    await db.delete(pages).where(eq(pages.id, id));
    await logActivity(session, {
      action: "page.deleted",
      entityType: "page",
      entityId: id,
      summary: `Deleted the page “${row.titleEn}”`,
    });
    refreshPage(row.slug);
    return ok("Page deleted.");
  });
  if (!result.ok) return result;
  redirect("/admin/pages");
}

/* -------------------------------------------------------------------------- */
/* Sections                                                                   */
/* -------------------------------------------------------------------------- */

async function pageOf(sectionId: number) {
  const [row] = await db
    .select({ slug: pages.slug, pageId: pages.id })
    .from(pageSections)
    .innerJoin(pages, eq(pages.id, pageSections.pageId))
    .where(eq(pageSections.id, sectionId))
    .limit(1);
  return row ?? null;
}

export async function addSection(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("section-add", async () => {
    const session = await guardAction("content.manage", form);
    const pageId = Number(form.get("pageId"));
    const blockType = field(form, "blockType", 48);
    const block = getBlock(blockType);
    if (!block) return fail("Choose a section type.");

    const [page] = await db.select().from(pages).where(eq(pages.id, pageId)).limit(1);
    if (!page) return fail("That page no longer exists.");

    const [last] = await db
      .select({ position: pageSections.position })
      .from(pageSections)
      .where(eq(pageSections.pageId, pageId))
      .orderBy(asc(sql`${pageSections.position} desc`))
      .limit(1);

    const [row] = await db
      .insert(pageSections)
      .values({
        pageId,
        blockType,
        position: (last?.position ?? -1) + 1,
        // New sections arrive hidden: an editor fills them in before the site
        // shows an empty panel to a visitor.
        isPublished: false,
        published: emptyValues(block),
      })
      .returning({ id: pageSections.id });

    await logActivity(session, {
      action: "section.added",
      entityType: "section",
      entityId: row!.id,
      summary: `Added a ${block.name} section to “${page.titleEn}”`,
    });
    refreshPage(page.slug);
    return ok(`${block.name} added. It stays hidden until you publish it.`, row!.id);
  });
}

/**
 * Writes what the section editor is holding — as a draft, or straight to the
 * site. One body, one guarded write, and the difference between them is the
 * `publish` argument rather than a field inside the request.
 *
 * That the caller decides is the whole point. The screen used to say which it
 * wanted with `<button name="publishNow" value="true">`, and the value never
 * arrived: React re-inserts a submitter as a temporary input to build the
 * FormData, associating it with the form through `form.id` — and on a form
 * carrying a control named `id`, `form.id` is that input element, not the
 * form's identifier. The temporary input was therefore parented to a form that
 * does not exist, the value disappeared, and a button labelled "Save and
 * publish" quietly saved a draft. Two exported actions cannot have that
 * problem: the intent is which one the browser called.
 *
 * Publishing here is one write, not a draft save followed by a publish. Two
 * writes would mean a window in which the values are a draft nobody asked for,
 * and a second guard to lose.
 */
async function writeSectionValues(form: FormData, publish: boolean): Promise<ActionState> {
  const session = await guardAction("content.manage", form);
  const id = Number(form.get("id"));

  const [section] = await db.select().from(pageSections).where(eq(pageSections.id, id)).limit(1);
  if (!section) return fail(CONFLICT.gone);
  const block = getBlock(section.blockType);
  if (!block) return fail("That section type is no longer available.");

  // The same registry validator either way. Publishing is a destination, not a
  // shortcut: nothing reaches `published` that would not have been allowed into
  // `draft`.
  const values = parseBlockPayload(String(form.get("values") ?? ""), block);
  if (!values) return fail(CONFLICT.unreadable);

  const animation = field(form, "animation", 32) || section.animation;

  // The revision the form was built from. Required, not inferred: falling
  // back to the row's current revision would make every save win, which is
  // exactly the behaviour the guard exists to remove.
  const expected = expectedRevisionOf(form);
  if (expected === null) return fail(CONFLICT.unreadable);

  const result = await updateSectionGuarded(id, expected, {
    ...(publish ? { published: values, draft: null, isPublished: true } : { draft: values }),
    animation,
    updatedBy: session.user.id,
  });
  if (!result.ok) {
    if (result.reason === "missing") return fail(CONFLICT.gone);
    return fail(publish ? CONFLICT.publish : CONFLICT.save);
  }

  const page = await pageOf(id);
  await logActivity(session, {
    action: publish ? "section.published" : "section.draft_saved",
    entityType: "section",
    entityId: id,
    summary: `${publish ? "Published" : "Saved a draft of"} the ${block.name} section`,
  });
  if (page) refreshSection(page.slug, id);
  return ok(
    publish
      ? "Published. The change is live now."
      : "Draft saved. Use Preview to see it, then Publish when you are ready.",
  );
}

/** What the form's own action does, and so what the Enter key does. */
export async function saveSectionDraft(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("section-draft", () => writeSectionValues(form, false));
}

/** Reached only by pressing the button that says so. */
export async function saveSectionAndPublish(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  return runAction("section-publish-now", () => writeSectionValues(form, true));
}

/**
 * Publishes the draft an editor was actually looking at — or nothing.
 *
 * The revision comes from the form, not from a read taken inside this action.
 * Reading it here would guard only the microseconds between the read and the
 * write, which is not the race that happens: the one that happens is a screen
 * left open while somebody else — the Visual Editor, another tab — saves a
 * newer draft. That screen still says "Unpublished draft" and its button still
 * works, and publishing on it would put words on the live site that nobody at
 * this keyboard has ever read.
 *
 * The draft still has to be read, because it is what gets published. But the
 * read answers "what would go out", never "is this screen still current".
 */
export async function publishSection(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("section-publish", async () => {
    const session = await guardAction("content.manage", form);
    const id = Number(form.get("id"));
    const expected = expectedRevisionOf(form);
    if (expected === null) return fail(CONFLICT.unreadable);

    const [section] = await db.select().from(pageSections).where(eq(pageSections.id, id)).limit(1);
    if (!section) return fail(CONFLICT.gone);
    // Staleness is reported before anything else, because it is the true story:
    // a screen that has been overtaken may also be looking at a draft that has
    // since been published or discarded, and "there is no draft" would send
    // somebody hunting for a problem that is really just an old tab. The guard
    // below still decides whether the write happens — this only decides which
    // sentence an editor reads.
    if (section.revision !== expected) return fail(CONFLICT.publish);
    if (!section.draft) return fail("There is no draft to publish.");

    const result = await updateSectionGuarded(id, expected, {
      published: section.draft,
      draft: null,
      isPublished: true,
      updatedBy: session.user.id,
    });
    if (!result.ok) return fail(result.reason === "missing" ? CONFLICT.gone : CONFLICT.publish);

    const page = await pageOf(id);
    await logActivity(session, {
      action: "section.published",
      entityType: "section",
      entityId: id,
      summary: `Published the ${section.blockType} section`,
    });
    if (page) refreshSection(page.slug, id);
    return ok("Published.");
  });
}

/**
 * Throws away the draft an editor was actually looking at — or nothing.
 *
 * The same rule as publishing, and the consequence of getting it wrong is
 * worse: a discard deletes. A screen opened before somebody else saved would,
 * guarded on its own fresh read, cheerfully delete a draft it had never shown
 * anybody. The revision the browser saw is what decides.
 */
export async function discardDraft(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("section-discard", async () => {
    const session = await guardAction("content.manage", form);
    const id = Number(form.get("id"));
    const expected = expectedRevisionOf(form);
    if (expected === null) return fail(CONFLICT.unreadable);

    const [section] = await db.select().from(pageSections).where(eq(pageSections.id, id)).limit(1);
    if (!section) return fail(CONFLICT.gone);
    if (section.revision !== expected) return fail(CONFLICT.discard);

    const result = await updateSectionGuarded(id, expected, {
      draft: null,
      updatedBy: session.user.id,
    });
    if (!result.ok) return fail(result.reason === "missing" ? CONFLICT.gone : CONFLICT.discard);

    const page = await pageOf(id);
    await logActivity(session, {
      action: "section.draft_discarded",
      entityType: "section",
      entityId: id,
      summary: "Discarded a section draft",
    });
    if (page) refreshSection(page.slug, id);
    return ok("Draft discarded. The live version is unchanged.");
  });
}

export async function publishAllDrafts(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("page-publish-all", async () => {
    const session = await guardAction("content.manage", form);
    const pageId = Number(form.get("pageId"));
    const [page] = await db.select().from(pages).where(eq(pages.id, pageId)).limit(1);
    if (!page) return fail("That page no longer exists.");

    const drafts = await db
      .select()
      .from(pageSections)
      .where(and(eq(pageSections.pageId, pageId), sql`${pageSections.draft} is not null`));
    if (!drafts.length) return fail("There are no drafts waiting on this page.");

    // All or nothing. Each section is published only against the revision this
    // read saw, and one section moving underneath us rolls the whole batch back
    // — a half-published page is worse than an unpublished one, because nobody
    // can tell by looking which half went out.
    try {
      await db.transaction(async (tx) => {
        for (const section of drafts) {
          const result = await updateSectionGuardedIn(tx, section.id, section.revision, {
            published: section.draft!,
            draft: null,
            isPublished: true,
            updatedBy: session.user.id,
          });
          if (!result.ok) throw new PublishRace(result.reason);
        }
      });
    } catch (error) {
      if (error instanceof PublishRace) {
        return fail(error.reason === "missing" ? CONFLICT.publishAllGone : CONFLICT.publishAll);
      }
      throw error;
    }

    await logActivity(session, {
      action: "page.published",
      entityType: "page",
      entityId: pageId,
      summary: `Published ${drafts.length} section${drafts.length === 1 ? "" : "s"} on “${page.titleEn}”`,
    });
    refreshPage(page.slug);
    return ok(`Published ${drafts.length} section${drafts.length === 1 ? "" : "s"}.`);
  });
}

export async function toggleSection(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("section-toggle", async () => {
    const session = await guardAction("content.manage", form);
    const id = Number(form.get("id"));
    const [section] = await db.select().from(pageSections).where(eq(pageSections.id, id)).limit(1);
    if (!section) return fail("That section no longer exists.");

    await db
      .update(pageSections)
      .set({ isPublished: !section.isPublished, updatedAt: new Date() })
      .where(eq(pageSections.id, id));

    const page = await pageOf(id);
    await logActivity(session, {
      action: section.isPublished ? "section.hidden" : "section.shown",
      entityType: "section",
      entityId: id,
      summary: `${section.isPublished ? "Hid" : "Showed"} the ${section.blockType} section`,
    });
    if (page) refreshPage(page.slug);
    return ok(section.isPublished ? "Section hidden from the site." : "Section is live.");
  });
}

export async function moveSection(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("section-move", async () => {
    await guardAction("content.manage", form);
    const id = Number(form.get("id"));
    const direction = field(form, "direction", 8) === "up" ? "up" : "down";

    const [section] = await db.select().from(pageSections).where(eq(pageSections.id, id)).limit(1);
    if (!section) return fail("That section no longer exists.");

    // Swap with the adjacent section rather than renumbering the whole page:
    // two writes, and concurrent edits elsewhere on the page are untouched.
    const [neighbour] = await db
      .select()
      .from(pageSections)
      .where(
        and(
          eq(pageSections.pageId, section.pageId),
          direction === "up"
            ? lt(pageSections.position, section.position)
            : gt(pageSections.position, section.position),
        ),
      )
      .orderBy(
        direction === "up"
          ? sql`${pageSections.position} desc`
          : asc(pageSections.position),
      )
      .limit(1);

    if (!neighbour) return ok();

    await db.transaction(async (tx) => {
      await tx.update(pageSections).set({ position: -1 }).where(eq(pageSections.id, section.id));
      await tx
        .update(pageSections)
        .set({ position: section.position })
        .where(eq(pageSections.id, neighbour.id));
      await tx
        .update(pageSections)
        .set({ position: neighbour.position })
        .where(eq(pageSections.id, section.id));
    });

    const page = await pageOf(id);
    if (page) refreshPage(page.slug);
    return ok();
  });
}

/**
 * Applies a whole new order at once — what a drag-and-drop rearrangement
 * produces. Positions are rewritten from the submitted sequence rather than
 * swapped pairwise, and ids that are not on this page are ignored, so a stale
 * screen can reorder what it can see without disturbing anything it cannot.
 */
export async function reorderSections(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("section-reorder", async () => {
    const session = await guardAction("content.manage", form);
    const pageId = Number(form.get("pageId"));

    let submitted: number[];
    try {
      const parsed = JSON.parse(String(form.get("order") ?? "[]")) as unknown;
      if (!Array.isArray(parsed)) throw new Error("not an array");
      submitted = parsed.map(Number).filter((n) => Number.isInteger(n) && n > 0);
    } catch {
      return fail("That order could not be read. Reload the page and try again.");
    }
    if (!submitted.length) return ok();

    const existing = await db
      .select({ id: pageSections.id })
      .from(pageSections)
      .where(eq(pageSections.pageId, pageId));
    const onThisPage = new Set(existing.map((row) => row.id));

    const ordered = submitted.filter((id) => onThisPage.has(id));
    // Anything the screen did not know about keeps its place at the end rather
    // than being silently dropped to position zero.
    const missing = existing.map((row) => row.id).filter((id) => !ordered.includes(id));
    const finalOrder = [...ordered, ...missing];

    await db.transaction(async (tx) => {
      // Two passes: positions are unique-ish per page and a single pass would
      // collide with the values it has not rewritten yet.
      for (const [index, id] of finalOrder.entries()) {
        await tx
          .update(pageSections)
          .set({ position: -(index + 1) })
          .where(and(eq(pageSections.id, id), eq(pageSections.pageId, pageId)));
      }
      for (const [index, id] of finalOrder.entries()) {
        await tx
          .update(pageSections)
          .set({ position: index })
          .where(and(eq(pageSections.id, id), eq(pageSections.pageId, pageId)));
      }
    });

    const [page] = await db.select({ slug: pages.slug }).from(pages).where(eq(pages.id, pageId)).limit(1);
    await logActivity(session, {
      action: "section.reordered",
      entityType: "page",
      entityId: pageId,
      summary: `Reordered the sections on “${page?.slug ?? pageId}”`,
    });
    if (page) refreshPage(page.slug);
    return ok("Order saved.");
  });
}

export async function duplicateSection(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("section-duplicate", async () => {
    const session = await guardAction("content.manage", form);
    const id = Number(form.get("id"));
    const [section] = await db.select().from(pageSections).where(eq(pageSections.id, id)).limit(1);
    if (!section) return fail("That section no longer exists.");

    // Everything after the original shifts down one, so the copy sits directly
    // beneath it rather than at the end of the page.
    await db
      .update(pageSections)
      .set({ position: sql`${pageSections.position} + 1` })
      .where(and(eq(pageSections.pageId, section.pageId), gt(pageSections.position, section.position)));

    const [copy] = await db
      .insert(pageSections)
      .values({
        pageId: section.pageId,
        blockType: section.blockType,
        position: section.position + 1,
        isPublished: false,
        published: section.draft ?? section.published,
        animation: section.animation,
      })
      .returning({ id: pageSections.id });

    const page = await pageOf(id);
    await logActivity(session, {
      action: "section.duplicated",
      entityType: "section",
      entityId: copy!.id,
      summary: `Duplicated the ${section.blockType} section`,
    });
    if (page) refreshPage(page.slug);
    return ok("Duplicated. The copy is hidden until you publish it.", copy!.id);
  });
}

export async function deleteSection(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("section-delete", async () => {
    const session = await guardAction("content.manage", form);
    const id = Number(form.get("id"));
    const page = await pageOf(id);
    const [section] = await db.select().from(pageSections).where(eq(pageSections.id, id)).limit(1);
    if (!section) return fail("That section no longer exists.");

    await db.delete(pageSections).where(eq(pageSections.id, id));
    await logActivity(session, {
      action: "section.deleted",
      entityType: "section",
      entityId: id,
      summary: `Deleted the ${section.blockType} section`,
    });
    if (page) refreshPage(page.slug);
    return ok("Section deleted.");
  });
}
