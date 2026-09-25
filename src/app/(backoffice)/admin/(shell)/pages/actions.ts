"use server";

import { eq } from "drizzle-orm";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { after } from "next/server";

import { logActivity } from "@/lib/activity";
import {
  checkbox,
  fail,
  field,
  numberField,
  ok,
  runAction,
  type ActionState,
  type SectionSnapshot,
} from "@/lib/admin/actions";
import { guardAction } from "@/lib/auth/guard";
import { TAGS, revalidate } from "@/lib/cache";
import { getBlock } from "@/lib/cms/blocks";
import {
  discardPageChanges,
  getPageDraftSummary,
  publishPageChanges,
  restoreBlockers,
  RESTORE_BLOCKED,
} from "@/lib/cms/publish-service";
import { hasDraft, draftKindOf } from "@/lib/cms/drafts";
import { effectiveMotion, motionOf, readMotion, type MotionPreset } from "@/lib/cms/motion";
import { classicMotionWrite, hasAdvancedMotion, motionPromotion } from "@/lib/cms/motion-write";
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
import { lockPageForWrite, updateSectionGuarded, updateSectionGuardedIn } from "@/lib/db/revision";
import { pageSections, pages } from "@/lib/db/schema";
import { recordRestorePointIn, restoreVersionToDraft } from "@/lib/versions";

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
   * A *stored* motion draft that cannot be read.
   *
   * Different from the message above, which is about something a form just
   * submitted. This one is about a value already in the database, and the
   * difference decides what publishing may do about it: nothing. Substituting
   * the default would put an entrance on the live site that no editor ever
   * chose, under a message saying the change was theirs — so the refusal names
   * both ways out, because a draft nobody can publish has to be a draft
   * somebody can still get rid of.
   */
  motionDraft:
    "The saved motion draft is no longer valid. Choose a section entrance and save it again, " +
    "or discard the draft.",
  publishAllMotion:
    "A section on this page has a motion draft that is no longer valid. Nothing was published — " +
    "open that section, choose an entrance and save it again, or discard its draft.",
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
/**
 * What a section write invalidates, and deliberately what it does not.
 *
 * Two things were removed here, and the reason is the same for both: when a
 * Server Action revalidates anything, Next attaches a re-rendered tree for the
 * *current* route to the action's response, and when the router discards that
 * tree it discards the action's own returned state with it. `useActionState`
 * then never surfaces the result at all — measured over a sixty-second window,
 * it appears only when the next action is dispatched. The screen keeps the
 * revision it was built with, the confirmation never appears, and the next save
 * is refused as a conflict by a screen that had just saved successfully.
 * Twelve consecutive saves: two to seven lost with revalidation, none without
 * it, twice over.
 *
 *   - The editor's own route is no longer revalidated. It used to be, to keep
 *     this screen up to date; the screen now adopts what the action returns, so
 *     the re-render bought nothing and cost the answer.
 *   - A draft save no longer drops `TAGS.pages`. A draft changes nothing a
 *     visitor can see, so invalidating the public page cache was never right —
 *     it only widened the window above.
 *
 * What a publication changes for everyone else is still dropped, because that
 * part is not optional.
 */
const refreshAfterDraft = (slug: string) => {
  after(() => {
    revalidatePath(`/admin/pages/${slug}`);
    revalidatePath("/admin/pages");
  });
};

const refreshAfterPublish = (slug: string) => {
  after(() => {
    revalidate(TAGS.pages);
    revalidatePath(`/admin/pages/${slug}`);
    revalidatePath("/admin/pages");
  });
};

/**
 * The row as it stands after a write, for the screen that did the writing.
 *
 * `refreshSection` above asks Next to re-render the editor's route, and that
 * re-render is correct every time — the server has been observed producing it
 * twice per save with the right revision in it. What is not reliable is the
 * router applying it: measured on this screen, two of twelve consecutive saves
 * left the rendered page on the previous revision with the client component
 * never re-rendering at all. The next save then named a revision the row had
 * moved past and was refused as a conflict by a screen that had just saved
 * successfully.
 *
 * A re-render is still asked for, because everything else on the page should
 * follow. But what the *next action* depends on comes back in the answer, which
 * is the same channel as the message and is never dropped.
 */
async function sectionSnapshot(
  id: number,
  options: { values?: boolean } = {},
): Promise<SectionSnapshot | undefined> {
  const [row] = await db.select().from(pageSections).where(eq(pageSections.id, id)).limit(1);
  if (!row) return undefined;
  const block = getBlock(row.blockType);
  const snapshot: SectionSnapshot = {
    revision: row.revision,
    draftKind: draftKindOf(row),
    animation: effectiveMotion(row.animation, row.draftAnimation),
    advancedMotion: hasAdvancedMotion(row),
    isDraftOnly: row.isDraftOnly,
  };
  // The key is absent rather than undefined: a save must say nothing about the
  // fields at all, and "present but empty" is a different sentence.
  if (options.values && block) {
    snapshot.values = {
      ...emptyValues(block),
      ...((row.draft ?? row.published) as Record<string, unknown>),
    };
  }
  return snapshot;
}

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
const hasAnyDraft = (row: {
  draft: unknown;
  draftStyles: unknown;
  draftAnimation: unknown;
  draftMotionConfig: unknown;
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
/**
 * What publishing writes, or a refusal.
 *
 * It can refuse because one of the three domains can be stored in a state that
 * must not be published, and the honest answer to that is to publish nothing
 * rather than to publish something else. Returning a result rather than
 * throwing keeps the decision where the caller can see it, and keeps the write
 * itself a single guarded update.
 */
type Promotion =
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; reason: "motion" };

function promotion(row: typeof pageSections.$inferSelect): Promotion {
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
  /**
   * Strictly, and this is the one place in the file that may not be forgiving.
   *
   * `motionOf` is right for reading the *live* column: a legacy value there is
   * already published, the page has to render, and the default is the honest
   * reading of a row whose own column defaults to it. A pending draft is the
   * opposite situation. It is unpublished editorial intent, and an unreadable
   * one is intent nobody can recover — so normalising it here would take a
   * value the editor never chose and make it the live site's, on a button press
   * that says "Publish". Refuse instead: the draft stays exactly where it is,
   * repairable by saving a preset and removable by discarding.
   *
   * Both motion columns come out of `motionPromotion`, the decision a page
   * publication makes too, so publishing one section and publishing the page
   * cannot promote a section's motion differently.
   */
  const motion = motionPromotion(row, row.blockType);
  if (!motion.ok) return { ok: false, reason: "motion" };
  Object.assign(values, motion.values);
  return { ok: true, values };
}

/** The two ways a section publication can lose a race, and nothing else. */
class SectionPublishRace extends Error {
  constructor(readonly reason: "conflict" | "missing") {
    super(reason);
    this.name = "SectionPublishRace";
  }
}

/**
 * One section published, with the page's restore point, in one transaction.
 *
 * History is *page* history, so every path that changes what a visitor sees
 * writes one — publishing a single section included. Doing it inside the same
 * transaction as the promotion is what keeps the two honest: a version row
 * committed before a promotion that then failed would be a restore point for
 * something that never happened, and a promotion that succeeded after a failed
 * insert would be a live state with no way back.
 *
 * **The page row is locked before the snapshot is taken**, and that is what
 * makes the history linear rather than merely present. Without it, two tabs
 * publishing two different sections of one page both snapshot the same live
 * state before either writes, and the history ends up holding that state twice
 * with no restore point for the one in between — so the page goes A → B → C
 * and history offers A and A. The lock is only for serialisation: it does not
 * move `pages.revision`, because publishing one section's words is not a
 * change to the page's structural timeline.
 *
 * The snapshot is taken *before* the guarded update, so it records the page as
 * it stood immediately before this publication — which is what an editor
 * reaching for Undo wants, and what the label says.
 */
async function publishSectionIn(input: {
  sectionId: number;
  pageId: number;
  expectedRevision: number;
  values: Record<string, unknown>;
  label: string;
  userId: number;
  actorName: string;
}): Promise<{ ok: true; revision: number } | { ok: false; reason: "conflict" | "missing" }> {
  try {
    return await db.transaction(async (tx) => {
      // Page first, section rows next — the order `lockPageForWrite` defines
      // and every page-wide operation uses.
      const locked = await lockPageForWrite(tx, input.pageId);
      if (!locked) throw new SectionPublishRace("missing");
      if (!locked.rows.some((row) => row.id === input.sectionId)) {
        throw new SectionPublishRace("missing");
      }

      await recordRestorePointIn(tx, {
        pageId: input.pageId,
        label: input.label,
        userId: input.userId,
        actorName: input.actorName,
      });
      const result = await updateSectionGuardedIn(tx, input.sectionId, input.expectedRevision, {
        ...input.values,
        updatedBy: input.userId,
      });
      // Thrown, so the abort rolls the restore point and the prune back with
      // it: a refused publish leaves no trace in history.
      if (!result.ok) throw new SectionPublishRace(result.reason);
      return { ok: true as const, revision: result.revision };
    });
  } catch (error) {
    /**
     * Only the race is an answer; everything else is a failure.
     *
     * This used to catch every rejection and report "this section changed
     * while you were editing it" if the row still existed — so a failed
     * history insert, a lost connection or any unexpected database error was
     * reported to an editor as a concurrency conflict, and they would reload
     * and try again against a problem that reloading cannot fix. The
     * transaction rolls back either way, so nothing is inconsistent; what
     * differs is whether the sentence is true. Anything unexpected goes up to
     * the action's own error handler.
     */
    if (error instanceof SectionPublishRace) return { ok: false as const, reason: error.reason };
    throw error;
  }
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
   * Does this request have an opinion about motion at all?
   *
   * Three states, not two, and conflating the first with the third is the bug
   * this shape exists to make unwriteable:
   *
   *   · **absent** — the field is not in the submission. That is a screen that
   *     predates the control, and a client that has expressed *no* motion
   *     intent. It is not a request to keep the current value, to normalise
   *     it, to repair it or to withdraw it. It is a content request.
   *   · **present and readable** — an editor chose a preset, and the rules
   *     below decide where it goes.
   *   · **present and unreadable** — a stale or tampered submission, refused,
   *     because the alternative is guessing at a value that decides what a
   *     visitor sees move.
   *
   * `effectiveMotion` used to fill the absent case in, and that was wrong in a
   * way that only showed up on a damaged row: deriving `slide-in` from a
   * section holding an unreadable draft and then *writing it back* discarded
   * that draft, on a request that never mentioned motion. Reading and writing
   * are different acts; `effectiveMotion` answers "what should this render
   * as", never "what should this save".
   */
  const submitted = form.get("animation");
  const chosen: MotionPreset | null = submitted === null ? null : readMotion(submitted);
  if (submitted !== null && chosen === null) return fail(CONFLICT.motion);

  // The revision the form was built from. Required, not inferred: falling
  // back to the row's current revision would make every save win, which is
  // exactly the behaviour the guard exists to remove.
  const expected = expectedRevisionOf(form);
  if (expected === null) return fail(CONFLICT.unreadable);

  /**
   * The motion half of the write — which is empty when nobody asked for one.
   *
   * Built as its own object precisely so that "no opinion" can be expressed as
   * *no keys*. A value cannot say that: every `MotionPreset` this function
   * could have derived would have been written, and a column written is a
   * column changed, whatever it was changed to.
   *
   * With a choice submitted, the Batch 9 rules are unchanged:
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
   * menu with no Undo. It is a *withdrawal*, though, and only an editor who
   * saw the menu can make it — which is why it lives in this branch.
   *
   * **Publishing writes `animation` and clears the draft**, in the same write
   * as the content — one guarded update, no window in which half of it is out.
   * Publishing content while omitting the field publishes content: the motion
   * draft stays pending, for an explicit publication later, and the strict
   * gate in `promotion()` still stands in front of it.
   */
  /**
   * A section with an advanced motion document (Batch 15) is written by
   * `classicMotionWrite`, because one menu cannot say everything the document
   * does: an untouched menu leaves it alone, and a changed one becomes the
   * section's Base entrance inside it. `null` for every other section, which
   * keeps exactly the Batch 9 rules below.
   */
  const advanced = chosen === null ? null : classicMotionWrite(section, block.type, chosen, publish);
  if (advanced && !advanced.ok) return fail(CONFLICT.motion);
  const motion: Record<string, unknown> =
    chosen === null
      ? {}
      : advanced
        ? advanced.values
        : publish
          ? { animation: chosen, draftAnimation: null }
          : { draftAnimation: chosen === motionOf(section.animation) ? null : chosen };

  const written = {
    // Publishing content writes content. `is_published` is the live layout's
    // answer to a different question and is not this button's to change.
    ...(publish ? { published: values, draft: null } : { draft: values }),
    ...motion,
  };
  // Publishing changes what a visitor sees, so it leaves a restore point;
  // saving a draft changes nothing anybody can see, so it does not.
  const result = publish
    ? await publishSectionIn({
        sectionId: id,
        pageId: section.pageId,
        expectedRevision: expected,
        values: written,
        label: `Before publishing the ${block.name} section`,
        userId: session.user.id,
        actorName: session.user.name,
      })
    : await updateSectionGuarded(id, expected, { ...written, updatedBy: session.user.id });
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
  if (page) (publish ? refreshAfterPublish : refreshAfterDraft)(page.slug);
  return {
    ...ok(
      publish
        ? section.isPublished
          ? "Published. The change is live now."
          : LIVE.hiddenPublish
        : "Draft saved. Use Preview to see it, then Publish when you are ready.",
    ),
    section: await sectionSnapshot(id),
  };
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

    // Decided before anything is written, so a refusal costs nothing: no
    // column moves, no revision moves, no draft is cleared, no restore point is
    // taken and no activity is logged as a publish that did not happen.
    const promoted = promotion(section);
    if (!promoted.ok) return fail(CONFLICT.motionDraft);

    const block = getBlock(section.blockType);
    const result = await publishSectionIn({
      sectionId: id,
      pageId: section.pageId,
      expectedRevision: expected,
      values: promoted.values,
      label: `Before publishing the ${block?.name ?? section.blockType} section`,
      userId: session.user.id,
      actorName: session.user.name,
    });
    if (!result.ok) return fail(result.reason === "missing" ? CONFLICT.gone : CONFLICT.publish);

    const page = await pageOf(id);
    await logActivity(session, {
      action: "section.published",
      entityType: "section",
      entityId: id,
      summary: `Published the ${section.blockType} section`,
    });
    if (page) refreshAfterPublish(page.slug);
    return {
      ...ok(section.isPublished ? "Published." : LIVE.hiddenDraft),
      section: await sectionSnapshot(id),
    };
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
      draftMotionConfig: null,
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
    // Discarding a draft changes nothing a visitor sees, so the public cache
    // stands; the admin screens that badge the draft do not.
    if (page) refreshAfterDraft(page.slug);
    // The fields have to go back to the published wording, which is the one
    // case where the screen's own values are no longer the right ones.
    return {
      ...ok("Draft discarded. The live version is unchanged."),
      section: await sectionSnapshot(id, { values: true }),
    };
  });
}

/* -------------------------------------------------------------------------- */
/* The page, published whole                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Publish everything this page has saved.
 *
 * This replaced "Publish all drafts", which published content and styles and
 * silently left the layout behind — so a page could be reordered, a section
 * added and another removed, the button pressed, and a visitor see none of it
 * under a message saying the page had been published. Two meanings of "all" is
 * one too many, so there is now one page-level action and it is the complete
 * one, in `cms/publish-service`, shared with the Visual Editor.
 *
 * The individual section actions above are untouched: publishing one section's
 * words is still a useful, smaller act, and it still does not publish layout.
 */
export async function publishPage(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("page-publish", async () => {
    const session = await guardAction("content.manage", form);
    const pageId = Number(form.get("pageId"));
    const expected = expectedRevisionOf(form);
    if (expected === null) return fail(CONFLICT.unreadable);

    const [page] = await db.select().from(pages).where(eq(pages.id, pageId)).limit(1);
    if (!page) return fail("That page no longer exists.");

    const result = await publishPageChanges({
      pageId,
      expectedRevision: expected,
      userId: session.user.id,
      actorName: session.user.name,
    });
    if (!result.ok) return fail(result.message);

    await logActivity(session, {
      action: "page.changes_published",
      entityType: "page",
      entityId: pageId,
      summary: `${result.summary} on “${page.titleEn}”`,
    });
    refreshPage(page.slug);
    return ok(result.message);
  });
}

/**
 * Throw away everything this page has saved, and leave the live page alone.
 *
 * The counterpart to publishing, and the only way out of a state publication
 * refuses to act on — a layout draft that cannot be read, a motion draft
 * nobody can parse, a historical restore an editor previewed and thought
 * better of.
 */
export async function discardPageDrafts(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("page-discard", async () => {
    const session = await guardAction("content.manage", form);
    const pageId = Number(form.get("pageId"));
    const expected = expectedRevisionOf(form);
    if (expected === null) return fail(CONFLICT.unreadable);

    const [page] = await db.select().from(pages).where(eq(pages.id, pageId)).limit(1);
    if (!page) return fail("That page no longer exists.");

    const result = await discardPageChanges({
      pageId,
      expectedRevision: expected,
      userId: session.user.id,
    });
    if (!result.ok) return fail(result.message);

    await logActivity(session, {
      action: "page.drafts_discarded",
      entityType: "page",
      entityId: pageId,
      summary: `Discarded the saved changes on “${page.titleEn}”`,
    });
    // Drafts are invisible to visitors, so the public cache is untouched — but
    // the admin's own screens count them.
    revalidatePath(`/admin/pages/${page.slug}`);
    revalidatePath("/admin/pages");
    return ok(result.message);
  });
}

/**
 * Put a published version back — as drafts, and never as the live page.
 *
 * The wording in the UI says so and this is what makes it true: the restore
 * writes `draft`, `draft_styles`, `draft_animation` and `draft_structure`, and
 * touches no published column. A visitor sees exactly what they saw before;
 * the editor previews the historical state and publishes it deliberately, or
 * discards it.
 */
export async function restorePageVersion(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("page-restore", async () => {
    const session = await guardAction("content.manage", form);
    const pageId = Number(form.get("pageId"));
    const versionId = Number(form.get("versionId"));

    const [page] = await db.select().from(pages).where(eq(pages.id, pageId)).limit(1);
    if (!page) return fail("That page no longer exists.");

    // Checked here as well as inside the restore, so the common case gets the
    // sentence that tells an editor what to do rather than a generic refusal.
    const summary = await getPageDraftSummary(pageId);
    if (summary && restoreBlockers(summary)) return fail(RESTORE_BLOCKED);

    const result = await restoreVersionToDraft(versionId, pageId, { userId: session.user.id });
    if (!result.ok) {
      if (result.reason === "not_clean") return fail(RESTORE_BLOCKED);
      if (result.reason === "unsupported") {
        return fail(
          "That version was saved by a different build and cannot be restored here. The live " +
            "page is unchanged.",
        );
      }
      if (result.reason === "wrong_page") return fail("That version belongs to a different page.");
      if (result.reason === "missing") return fail("That version no longer exists.");
      return fail("The page changed while restoring. Nothing was restored — reload and try again.");
    }

    await logActivity(session, {
      action: "page.version_restored_to_draft",
      entityType: "page",
      entityId: pageId,
      summary: `Restored version #${versionId} of “${page.titleEn}” into saved changes`,
    });
    revalidatePath(`/admin/pages/${page.slug}`);
    revalidatePath("/admin/pages");
    return ok(
      "Restored into saved changes. Preview the page, then publish when you are ready — the " +
        "live site has not changed.",
    );
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
 * the layout draft is published, which is `publishPage`'s job and not
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
