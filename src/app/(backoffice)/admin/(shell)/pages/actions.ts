"use server";

import { and, eq, sql } from "drizzle-orm";
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
import { hasDraft, draftKindOf } from "@/lib/cms/drafts";
import { motionOf, readMotion, type MotionPreset } from "@/lib/cms/motion";
import {
  addStructureSection,
  discardLayoutDraft,
  duplicateStructureSection,
  getPageStructure,
  removeStructureSection,
  reorderStructure,
  restoreStructureSection,
  setStructureVisibility,
  type StructureResult,
} from "@/lib/cms/structure-service";
import { readVisibility } from "@/lib/cms/structure";
import { validateStyleDocument } from "@/lib/cms/styles";
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
/**
 * What to say when the section a change went into is not on the live page.
 *
 * "The change is live now" would be false: the content is published and the
 * section is still hidden, so a visitor sees nothing. The sentence describes
 * the section's **current** live visibility and says nothing about what the
 * layout draft intends — that is a separate pending thing and conflating the
 * two is how an editor comes to believe they have published a layout.
 */
const LIVE = {
  hiddenPublish: "Content published. This section remains hidden on the live page.",
  hiddenDraft: "Draft published. This section remains hidden on the live page.",
} as const;

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
  /**
   * An entrance outside the five presets.
   *
   * Refused rather than replaced with the default, because the two are
   * different mistakes and only the editor can tell them apart: a stale screen
   * sending a preset that has since been retired deserves to be told, while
   * silently storing "fade up" for it would look like the save worked and
   * leave the section moving in a way nobody picked.
   */
  motion: "That entrance is not one of the available options. Reload the page and try again.",
  /**
   * A pending section cannot be made live one section at a time.
   *
   * Public composition is `is_published AND NOT is_draft_only`, so a section
   * the layout draft introduced is excluded from the live page by membership,
   * not by a flag this button could flip. Publishing its content would move the
   * columns and change nothing a visitor sees — and would say "live now" while
   * doing it, which is the part that actually costs something.
   */
  draftOnly:
    "This section is part of an unpublished layout. Save it as a draft; it will become live " +
    "when the page layout is published.",
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

/**
 * Whether a section has anything unpublished, in any domain.
 *
 * A style draft is a draft, and so is a motion draft. Testing `draft` alone was
 * right while content was the only thing that could be unpublished, and became
 * wrong the moment the Visual Editor could save a layout — a section whose only
 * pending change is a colour would have shown as published everywhere and been
 * unpublishable. The same is now true of an entrance.
 *
 * Read through `draftKindOf` rather than re-tested here: the Pages list, the
 * banner on this screen and this button all have to agree about whether a
 * section is pending, and they agree by asking the same function.
 */
/**
 * The refusal value for a preset that could not be read.
 *
 * A sentinel rather than `null` so the "the form did not send one" branch and
 * the "the form sent nonsense" branch cannot be written as the same test —
 * they mean opposite things and only one of them is an error.
 */
const NO_MOTION = "__unreadable__" as unknown as MotionPreset;

const hasAnyDraft = (row: {
  draft: unknown;
  draftStyles: unknown;
  draftAnimation: unknown;
}): boolean => hasDraft(draftKindOf(row));

/**
 * What publishing a section's saved drafts writes.
 *
 * One object, so content and style are promoted in the same guarded update
 * rather than in two writes with a window between them. Each domain is promoted
 * only if it has something pending: publishing a style-only draft must not
 * blank the published content, and — the one that would be a visible accident —
 * must not set `isPublished`. A hidden section stays hidden; its visibility is
 * a separate decision somebody made, not a side effect of tidying its layout.
 */
/**
 * What promoting a section's drafts writes — and, as of the layout draft, what
 * it deliberately does not.
 *
 * Publishing used to set `is_published: true`, which made sense when the only
 * way a section became visible was somebody publishing its content. It is now
 * how a hidden section would quietly appear on the live site: an editor fixes a
 * typo on a section the page is not showing, presses Publish, and the section
 * goes live because the two decisions were the same write. They are not the
 * same decision. Content publication says "these words are ready"; membership
 * and visibility belong to the layout, and only publishing the layout may
 * change them.
 *
 * So a row's current visibility is left exactly as it is, in every path that
 * calls this.
 */
function promotion(row: typeof pageSections.$inferSelect): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  if (row.draft !== null) {
    values.published = row.draft;
    values.draft = null;
  }
  if (row.draftStyles !== null) {
    // Validated on the way out as well: the column may predate a vocabulary
    // change, and `styles` is read by the public renderer.
    values.styles = validateStyleDocument(row.draftStyles);
    values.draftStyles = null;
  }
  if (row.draftAnimation !== null) {
    // The same rule, and the same reason: `animation` is what the live wrapper
    // renders, so what goes into it is normalised rather than trusted. A
    // column written before the vocabulary existed becomes the default here
    // instead of reaching the renderer as a string it cannot use.
    values.animation = motionOf(row.draftAnimation);
    values.draftAnimation = null;
  }
  return values;
}

async function pageOf(sectionId: number) {
  const [row] = await db
    .select({ slug: pages.slug, pageId: pages.id })
    .from(pageSections)
    .innerJoin(pages, eq(pages.id, pageSections.pageId))
    .where(eq(pageSections.id, sectionId))
    .limit(1);
  return row ?? null;
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
  // Saving a draft on a pending section is ordinary work. Publishing it is not
  // available, and refusing is the honest answer: the write would succeed and
  // the visitor would see nothing, under a message saying the change was live.
  if (publish && section.isDraftOnly) return fail(CONFLICT.draftOnly);

  // The same registry validator either way. Publishing is a destination, not a
  // shortcut: nothing reaches `published` that would not have been allowed into
  // `draft`.
  const values = parseBlockPayload(String(form.get("values") ?? ""), block);
  if (!values) return fail(CONFLICT.unreadable);

  /**
   * The entrance preset, read through the one validator.
   *
   * A form that omits the field entirely leaves the section's motion alone —
   * that is a screen that predates the control, not an editor choosing
   * nothing. A form that sends something outside the five presets is refused,
   * because the alternative is guessing, and the value being guessed at is one
   * that decides what a visitor sees move.
   */
  const submitted = form.get("animation");
  const motion: MotionPreset =
    submitted === null ? motionOf(section.draftAnimation ?? section.animation) : (readMotion(submitted) ?? NO_MOTION);
  if (motion === NO_MOTION) return fail(CONFLICT.motion);

  // The revision the form was built from. Required, not inferred: falling
  // back to the row's current revision would make every save win, which is
  // exactly the behaviour the guard exists to remove.
  const expected = expectedRevisionOf(form);
  if (expected === null) return fail(CONFLICT.unreadable);

  /**
   * Where the preset goes — the one thing about this screen that motion
   * changed.
   *
   * **Saving a draft writes `draft_animation`.** It used to write `animation`,
   * the published column, on the same guarded update as the draft — so the
   * moment anything rendered the value, pressing "Save draft" would have
   * changed the live page. Nothing rendered it, which is the only reason the
   * leak was survivable; the renderer reads it now, so the leak is not.
   *
   * **`null` when the choice matches what is published.** A motion draft is a
   * pending *change*, and storing "fade-up" against a section already
   * publishing fade-up would put a Draft badge on a section nobody has
   * changed, arm Publish all, and give an editor a draft with nothing in it to
   * publish. Choosing the live value back is therefore how a motion draft is
   * withdrawn, which is the behaviour an editor expects from a five-option
   * menu with no Undo.
   *
   * **Publishing writes `animation` and clears the draft**, in the same write
   * as the content — one guarded update, no window in which half of it is out.
   */
  const live = motionOf(section.animation);
  const result = await updateSectionGuarded(id, expected, {
    // Publishing content writes content. `is_published` is the live layout's
    // answer to a different question and is not this button's to change.
    ...(publish
      ? { published: values, draft: null, animation: motion, draftAnimation: null }
      : { draft: values, draftAnimation: motion === live ? null : motion }),
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
      ? section.isPublished
        ? "Published. The change is live now."
        : LIVE.hiddenPublish
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
    if (section.isDraftOnly) return fail(CONFLICT.draftOnly);
    if (!hasAnyDraft(section)) return fail("There is no draft to publish.");

    const result = await updateSectionGuarded(id, expected, {
      ...promotion(section),
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
    return ok(section.isPublished ? "Published." : LIVE.hiddenDraft);
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

    // All three domains. "Discard draft" is one button and it means the whole
    // pending state of the section — leaving a motion draft behind would keep
    // the section badged as pending with nothing an editor could point at.
    const result = await updateSectionGuarded(id, expected, {
      draft: null,
      draftStyles: null,
      draftAnimation: null,
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

    /**
     * Established sections only.
     *
     * A pending section always has a draft — it is created with one — so
     * without this filter every Add would arm this button, and pressing it
     * would report a section as published that a visitor cannot reach. Content
     * and layout are published by different acts; this one is content's.
     */
    const drafts = await db
      .select()
      .from(pageSections)
      .where(
        and(
          eq(pageSections.pageId, pageId),
          eq(pageSections.isDraftOnly, false),
          sql`(${pageSections.draft} is not null or ${pageSections.draftStyles} is not null or ${pageSections.draftAnimation} is not null)`,
        ),
      );
    if (!drafts.length) return fail("There are no drafts waiting on this page.");

    // All or nothing. Each section is published only against the revision this
    // read saw, and one section moving underneath us rolls the whole batch back
    // — a half-published page is worse than an unpublished one, because nobody
    // can tell by looking which half went out.
    try {
      await db.transaction(async (tx) => {
        for (const section of drafts) {
          const result = await updateSectionGuardedIn(tx, section.id, section.revision, {
            ...promotion(section),
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

/**
 * The Pages screen's structural actions, on the same primitives as the canvas.
 *
 * Before this batch these six wrote straight to the live rows: reorder
 * renumbered `position`, hide flipped `is_published`, delete issued a DELETE.
 * They now edit the page's layout draft instead, through
 * `cms/structure-service` — the same functions the Visual Editor's Layers panel
 * calls, so the two screens cannot mean different things by "move this up", and
 * `pages.revision` guards both.
 *
 * The consequence worth stating plainly: **none of them changes the live page
 * any more.** A visitor keeps getting the composition they were getting until
 * the layout draft is published, which is a later batch's button and not
 * reachable from here.
 */
const structuralConflict = (result: StructureResult & { ok: false }) => fail(result.message);

/**
 * One structural request, and the whole of its ownership chain.
 *
 * `pageId` comes from the screen that rendered the form and from nowhere else.
 * An earlier version looked the page up from the section id instead, which
 * sounds defensive and proves the wrong thing: it establishes that the section
 * belongs to *some* page, not that it belongs to the page whose screen
 * submitted this. Two pages sitting on the same revision — which is ordinary,
 * since every page starts at one — would then let Home's screen restructure
 * About by naming one of its sections. The service opens the page this names
 * and searches only that page's rows, so a foreign id finds nothing and the
 * operation is refused.
 *
 * It is also the id the refresh below uses. Deriving it inside the operation
 * left this function holding `Number(null) === 0`, so the page that had just
 * changed was not the page whose caches were dropped.
 */
async function runStructural(
  form: FormData,
  operate: (context: { pageId: number; expectedRevision: number; userId: number }) => Promise<StructureResult>,
): Promise<ActionState> {
  const session = await guardAction("content.manage", form);
  const pageId = Number(form.get("pageId"));
  const expected = expectedRevisionOf(form);
  if (expected === null) return fail(CONFLICT.unreadable);
  if (!Number.isInteger(pageId) || pageId <= 0) return fail(CONFLICT.unreadable);

  const result = await operate({ pageId, expectedRevision: expected, userId: session.user.id });
  if (!result.ok) return structuralConflict(result);

  await logActivity(session, result.log);
  const [page] = await db.select({ slug: pages.slug }).from(pages).where(eq(pages.id, pageId)).limit(1);
  if (page) refreshPage(page.slug);
  return ok(result.message, result.sectionId);
}

export async function toggleSection(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("section-toggle", async () => {
    // Refused rather than read as "hide": an unreadable field must not be able
    // to take a section out of the published layout.
    const visible = readVisibility(form.get("visible"));
    if (visible === null) return fail(CONFLICT.unreadable);
    return runStructural(form, (context) =>
      setStructureVisibility(context, Number(form.get("id")), visible),
    );
  });
}

export async function moveSection(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("section-move", async () => {
    const pageId = Number(form.get("pageId"));
    const id = Number(form.get("id"));
    const up = field(form, "direction", 8) === "up";

    /**
     * Move is a reorder of one step, not a second implementation of ordering.
     *
     * The alternative — swapping two entries in place — would be a separate
     * piece of code that means the same thing as dragging, and the two would
     * eventually disagree about an edge somebody had only fixed in one of them.
     * The list is read, one element is moved, and the whole order goes through
     * the same permutation check a drop does.
     */
    const page = await getPageStructure(pageId);
    if (!page) return fail("That page no longer exists.");
    const order = page.structure.sections.map((entry) => entry.sectionId);
    const at = order.indexOf(id);
    if (at < 0) return fail("That section is not in the layout. Reload the page.");
    const to = up ? at - 1 : at + 1;
    if (to < 0 || to >= order.length) return ok();
    [order[at], order[to]] = [order[to]!, order[at]!];

    return runStructural(form, (context) => reorderStructure(context, order));
  });
}

/**
 * Applies a whole new order at once — what a drag-and-drop rearrangement
 * produces. The submitted list has to be a permutation of the layout the screen
 * was showing; anything else is a stale screen or a foreign id, and both are
 * refused rather than filtered into something that looks like success.
 */
export async function reorderSections(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("section-reorder", async () => {
    let order: number[];
    try {
      const parsed = JSON.parse(String(form.get("order") ?? "[]")) as unknown;
      if (!Array.isArray(parsed)) throw new Error("not an array");
      order = parsed.map(Number);
    } catch {
      return fail("That order could not be read. Reload the page and try again.");
    }
    return runStructural(form, (context) => reorderStructure(context, order));
  });
}

export async function addSection(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("section-add", async () =>
    runStructural(form, (context) =>
      addStructureSection(context, field(form, "blockType", 48), null),
    ),
  );
}

export async function duplicateSection(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("section-duplicate", async () => {
    return runStructural(form, (context) =>
      duplicateStructureSection(context, Number(form.get("id"))),
    );
  });
}

/**
 * Takes a section out of the layout draft. The row stays where it is.
 *
 * Deleting it here would be the one irreversible structural operation, and it
 * would delete work: an established section's content, or a pending section
 * somebody had spent an afternoon filling in. Removal is an intention, the live
 * page is unaffected until the layout is published, and the page's Removed
 * sections list is one click from putting it back.
 */
export async function deleteSection(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("section-delete", async () => {
    return runStructural(form, (context) =>
      removeStructureSection(context, Number(form.get("id"))),
    );
  });
}

export async function restoreSection(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("section-restore", async () => {
    return runStructural(form, (context) =>
      restoreStructureSection(context, Number(form.get("id"))),
    );
  });
}

export async function discardLayout(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("page-layout-discard", async () =>
    runStructural(form, (context) => discardLayoutDraft(context)),
  );
}
