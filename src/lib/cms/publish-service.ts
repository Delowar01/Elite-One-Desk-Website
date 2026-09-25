import "server-only";

import { and, asc, eq } from "drizzle-orm";

import { db } from "@/lib/db";
import {
  deleteSectionGuardedIn,
  lockPageForWrite,
  updatePageGuardedIn,
  updateSectionGuardedIn,
  type Executor,
} from "@/lib/db/revision";
import { pageSections, pages } from "@/lib/db/schema";
import { recordRestorePointIn } from "@/lib/versions";

import { getBlock } from "./blocks";
import { draftDomainsOf } from "./drafts";
import { motionPromotion, type MotionColumns } from "./motion-write";
import { validateStyleDocument } from "./styles";
import {
  liveStructure,
  readPublishableStructure,
  structureDiffers,
  type DraftStructure,
} from "./structure";

/**
 * Turning a page's saved drafts into the live page — and throwing them away.
 *
 * Every other module in `cms/` writes drafts. This one is the only thing that
 * turns them into what a visitor gets, and it is the only thing that deletes a
 * section, so the rules are concentrated here rather than spread across the two
 * screens that offer the button. Two surfaces, one primitive: the Pages list
 * and the Visual Editor call the same function, so they cannot come to disagree
 * about what "publish this page" means or about which of them is allowed to
 * publish a layout.
 *
 * Three properties hold everything together.
 *
 * **It is atomic.** One transaction covers the restore point, every promotion,
 * every position, every visibility flag, every deletion and the clearing of the
 * layout draft. A page is published entirely or not at all: a half-published
 * page is worse than an unpublished one, because nobody can tell by looking
 * which half went out.
 *
 * **It is guarded twice.** The page names the revision the review was built
 * from, and every section row is written against the revision this transaction
 * read. A layout that moved is refused rather than merged — merging two
 * layouts produces a third that neither editor asked for — and a section that
 * moved rolls the whole publication back.
 *
 * **It is strict about stored intent.** A layout draft that cannot be read, or
 * a motion draft outside the vocabulary on a section that is being kept, stops
 * the publication. Tolerant readings belong to rendering, where the cost of
 * being wrong is a page that looks odd; here the cost is a row deleted or a
 * value published that nobody chose.
 *
 * What it deliberately does not touch: `pages.is_published`. Whether a page is
 * part of the site is page settings, answered elsewhere, and publishing the
 * changes an editor made to a page is not a request to put that page on the
 * site.
 */

/* -------------------------------------------------------------------------- */
/* What is waiting                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The authoritative reading of what a page has pending.
 *
 * Computed from the database, never from whichever sections a browser happens
 * to have loaded. A review screen that counted its own buffers would promise to
 * publish what that tab knows about, and the tab is the one thing in this
 * system that is allowed to be out of date.
 */
export type PageDraftSummary = {
  pageId: number;
  slug: string;
  title: string;
  revision: number;
  contentDrafts: number;
  styleDrafts: number;
  motionDrafts: number;
  /** A layout draft is stored. */
  hasLayoutDraft: boolean;
  /** …and this build cannot read it, so publishing is blocked until it goes. */
  layoutCorrupt: boolean;
  /** …and publishing it would actually change the page's composition. */
  layoutChanged: boolean;
  /** Pending sections the layout includes: these become established. */
  added: number;
  /** Established sections the layout omits: these are deleted. */
  removed: number;
  /** Pending sections the layout omits: deleted too, but never published. */
  discardedNew: number;
  /** Sections whose live visibility publishing the layout would change. */
  visibilityChanges: number;
  /** Whether there is anything for a publication to do. */
  publishable: boolean;
  /** Whether there is anything for a discard to throw away. */
  discardable: boolean;
};

type SectionRow = typeof pageSections.$inferSelect;

/**
 * The page and its sections.
 *
 * `lock` is the difference between describing a page and acting on one. A
 * summary is a snapshot for a screen and may be a moment out of date; a
 * publication, a discard and a restore decide what to write from what they
 * read, and have to hold every row they read until they are done. Locking goes
 * through `lockPageForWrite`, which is the single definition of the order those
 * locks are taken in — page first, then sections by id.
 */
async function readPage(on: Executor, pageId: number, lock = false) {
  if (lock) return lockPageForWrite(on, pageId);
  if (!Number.isInteger(pageId) || pageId <= 0) return null;
  const [page] = await on.select().from(pages).where(eq(pages.id, pageId)).limit(1);
  if (!page) return null;
  const rows = await on
    .select()
    .from(pageSections)
    .where(eq(pageSections.pageId, pageId))
    .orderBy(asc(pageSections.position), asc(pageSections.id));
  return { page, rows };
}

/**
 * The layout publication would apply, and whether it is usable.
 *
 * Three answers, and they are three because the two that look alike mean
 * opposite things. `null` is "no layout draft" — publish the section drafts and
 * leave the composition exactly as it is. A readable document is the editor's
 * intent. `corrupt` is a column this build did not write, and it stops the
 * publication rather than being treated as either of the others.
 */
type LayoutIntent =
  | { kind: "none" }
  | { kind: "draft"; structure: DraftStructure }
  | { kind: "corrupt" };

function layoutIntentOf(page: typeof pages.$inferSelect, rows: readonly SectionRow[]): LayoutIntent {
  if (page.draftStructure === null || page.draftStructure === undefined) return { kind: "none" };
  const read = readPublishableStructure(
    page.draftStructure,
    rows.map((row) => row.id),
  );
  return read.ok ? { kind: "draft", structure: read.structure } : { kind: "corrupt" };
}

/** The composition publication would produce, whether or not a draft exists. */
const finalStructure = (intent: LayoutIntent, rows: readonly SectionRow[]): DraftStructure =>
  intent.kind === "draft" ? intent.structure : liveStructure(rows);

export async function getPageDraftSummary(pageId: number): Promise<PageDraftSummary | null> {
  const loaded = await readPage(db, pageId);
  if (!loaded) return null;
  const { page, rows } = loaded;
  const intent = layoutIntentOf(page, rows);
  const hasLayoutDraft = page.draftStructure !== null && page.draftStructure !== undefined;

  let contentDrafts = 0;
  let styleDrafts = 0;
  let motionDrafts = 0;

  const final = finalStructure(intent, rows);
  const listed = new Map(final.sections.map((entry) => [entry.sectionId, entry.visible]));

  let added = 0;
  let removed = 0;
  let discardedNew = 0;
  let visibilityChanges = 0;

  for (const row of rows) {
    const entry = listed.get(row.id);
    if (entry === undefined) {
      if (row.isDraftOnly) discardedNew += 1;
      else removed += 1;
      // A row on its way out carries nothing worth counting: its drafts are
      // deleted with it rather than published.
      continue;
    }
    // Only the drafts that would actually become live.
    for (const domain of draftDomainsOf(row)) {
      if (domain === "content") contentDrafts += 1;
      if (domain === "style") styleDrafts += 1;
      if (domain === "motion") motionDrafts += 1;
    }
    if (row.isDraftOnly) added += 1;
    else if (row.isPublished !== entry) visibilityChanges += 1;
  }

  const layoutChanged =
    intent.kind === "draft" && structureDiffers(intent.structure, liveStructure(rows));

  const anyDraft = contentDrafts + styleDrafts + motionDrafts > 0;
  const anyStructural = added + removed + discardedNew > 0 || layoutChanged;

  return {
    pageId: page.id,
    slug: page.slug,
    title: page.titleEn,
    revision: page.revision,
    contentDrafts,
    styleDrafts,
    motionDrafts,
    hasLayoutDraft,
    layoutCorrupt: intent.kind === "corrupt",
    layoutChanged,
    added,
    removed,
    discardedNew,
    visibilityChanges,
    // A corrupt layout is never publishable: the one thing to do with it is
    // discard it, which is why the two answers are separate.
    publishable: intent.kind !== "corrupt" && (anyDraft || anyStructural),
    discardable: anyDraft || hasLayoutDraft || rows.some((row) => row.isDraftOnly),
  };
}

/* -------------------------------------------------------------------------- */
/* Publishing                                                                 */
/* -------------------------------------------------------------------------- */

export type PublishFailure =
  | "missing"
  | "conflict"
  | "section_conflict"
  | "nothing"
  | "corrupt_structure"
  | "invalid_motion";

export type PublishCounts = {
  promoted: number;
  added: number;
  removed: number;
  reordered: boolean;
};

export type PublishResult =
  | {
      ok: true;
      revision: number;
      versionId: number;
      counts: PublishCounts;
      message: string;
      summary: string;
    }
  | { ok: false; reason: PublishFailure; message: string };

export const PUBLISH_MESSAGES = {
  missing: "That page no longer exists.",
  conflict:
    "This page changed while you were reviewing it. Nothing was published — reload the page " +
    "and try again.",
  sectionConflict:
    "A section on this page changed while you were publishing. Nothing was published — reload " +
    "the page and try again.",
  nothing: "There are no saved changes waiting on this page.",
  corruptStructure:
    "The saved layout for this page could not be read, so nothing was published. Discard the " +
    "saved changes and arrange the page again.",
  invalidMotion:
    "A section on this page has a motion draft that is no longer valid. Nothing was published — " +
    "open that section, choose an entrance and save it again, or discard its draft.",
} as const;

/** Thrown inside the transaction so the abort rolls everything back by construction. */
class PublishStopped extends Error {
  constructor(readonly reason: PublishFailure) {
    super(reason);
    this.name = "PublishStopped";
  }
}

const countPhrase = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

export type PublishContext = {
  pageId: number;
  expectedRevision: number;
  userId: number | null;
  actorName: string;
};

/**
 * Publishes everything a page has saved, in one transaction.
 *
 * The order of the steps inside is not arbitrary. Everything that can refuse
 * runs before anything is written, so a refusal costs no work and leaves no
 * trace; the restore point is taken after those checks and **before** the first
 * promotion, so it records the state the publication is about to replace; and
 * the layout draft is cleared last, under the same page guard the review was
 * built on.
 */
export async function publishPageChanges(context: PublishContext): Promise<PublishResult> {
  const { pageId, expectedRevision, userId, actorName } = context;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    return { ok: false, reason: "conflict", message: PUBLISH_MESSAGES.conflict };
  }

  let outcome: {
    revision: number;
    versionId: number;
    counts: PublishCounts;
    /** The page's own published state, read under the lock. */
    live: boolean;
  } | null = null;

  try {
    await db.transaction(async (tx) => {
      /**
       * The page *and every section row* are locked for the rest of the
       * transaction.
       *
       * Two publications of one page serialise on the page row rather than
       * both reading the same revision and both believing they won — and,
       * just as importantly, an autosave cannot land on a section between
       * this read and the promotion below. Without the section locks the row
       * this transaction is about to publish could be rewritten underneath
       * it; the revision guard would catch that and roll everything back,
       * which is correct but means an editor's publication fails for a reason
       * that need never have arisen.
       */
      const loaded = await readPage(tx, pageId, true);
      if (!loaded) throw new PublishStopped("missing");
      const { page, rows } = loaded;
      if (page.revision !== expectedRevision) throw new PublishStopped("conflict");

      const intent = layoutIntentOf(page, rows);
      if (intent.kind === "corrupt") throw new PublishStopped("corrupt_structure");

      const final = finalStructure(intent, rows);
      const listed = new Map(final.sections.map((entry) => [entry.sectionId, entry.visible]));
      const byId = new Map(rows.map((row) => [row.id, row]));

      /**
       * Every motion draft that would actually become live, decided and
       * validated before anything is written.
       *
       * Only the ones being kept: a section on its way out is deleted, and
       * refusing to publish a page because a row that is about to cease to
       * exist holds an unreadable value would be strictness for its own sake.
       *
       * Both motion columns come out of one decision (`motionPromotion`), the
       * same one a single-section publish makes: the advanced document and
       * the legacy preset the release in `deploy/previous-release` reads are
       * promoted together, in this transaction, or not at all.
       */
      const motionFor = new Map<number, MotionColumns>();
      for (const [sectionId] of listed) {
        const row = byId.get(sectionId);
        if (!row) continue;
        const promotion = motionPromotion(row, row.blockType);
        if (!promotion.ok) throw new PublishStopped("invalid_motion");
        if (Object.keys(promotion.values).length) motionFor.set(sectionId, promotion.values);
      }

      /* --- what each kept row becomes ---------------------------------- */
      type Write = { row: SectionRow; values: Record<string, unknown> };
      const writes: Write[] = [];
      let promoted = 0;
      let added = 0;
      let reordered = false;

      final.sections.forEach((entry, index) => {
        const row = byId.get(entry.sectionId);
        if (!row) return;
        const values: Record<string, unknown> = {};

        if (row.draft !== null) {
          values.published = row.draft;
          values.draft = null;
        }
        if (row.draftStyles !== null) {
          // Revalidated on the way out as well: the column may predate a
          // vocabulary change and `styles` is read by the public renderer.
          values.styles = validateStyleDocument(row.draftStyles);
          values.draftStyles = null;
        }
        const motion = motionFor.get(entry.sectionId);
        if (motion !== undefined) Object.assign(values, motion);
        if (row.draft !== null || row.draftStyles !== null || motion !== undefined) promoted += 1;

        // Contiguous from zero, in the order the draft listed them, so the
        // public page renders exactly what the preview showed.
        if (row.position !== index) {
          values.position = index;
          reordered = true;
        }
        // The one place layout visibility becomes live. Content, style and
        // motion publication still never touch it.
        if (row.isPublished !== entry.visible) values.isPublished = entry.visible;
        if (row.isDraftOnly) {
          values.isDraftOnly = false;
          added += 1;
        }

        // A row with nothing to change keeps its revision: an editor with that
        // section open should not be made stale by somebody publishing a
        // different part of the page.
        if (Object.keys(values).length) {
          values.updatedBy = userId;
          writes.push({ row, values });
        }
      });

      /* --- what goes ---------------------------------------------------- */
      const doomed = rows.filter((row) => !listed.has(row.id));
      const removed = doomed.filter((row) => !row.isDraftOnly).length;

      if (!writes.length && !doomed.length) throw new PublishStopped("nothing");

      /* --- the restore point, before a single promotion ----------------- */
      const { versionId } = await recordRestorePointIn(tx, {
        pageId,
        label: "Before publishing page changes",
        userId,
        actorName,
      });

      for (const write of writes) {
        const result = await updateSectionGuardedIn(tx, write.row.id, write.row.revision, write.values);
        if (!result.ok) throw new PublishStopped("section_conflict");
      }

      /**
       * Removal is a delete, not a hide.
       *
       * Hiding an omitted section would make Remove mean Hide: the row would
       * come back the next time the structure was seeded, every later snapshot
       * would keep recording it, and an editor who removed a section would find
       * it again. Its last published form is in the restore point taken above,
       * which is what makes deleting it recoverable.
       */
      for (const row of doomed) {
        const result = await deleteSectionGuardedIn(tx, row.id, row.revision);
        if (!result.ok) throw new PublishStopped("section_conflict");
      }

      const guard = await updatePageGuardedIn(tx, pageId, expectedRevision, {
        // Nothing is waiting any more, so nothing should look as though it is.
        draftStructure: null,
        updatedBy: userId,
      });
      if (!guard.ok) throw new PublishStopped("conflict");

      outcome = {
        revision: guard.revision,
        versionId,
        counts: { promoted, added, removed, reordered },
        // Read under the lock, and never written: whether the page is part of
        // the site is page settings, and publishing a page's changes is not a
        // request to change that. It is carried out only so the sentence at
        // the end can be true.
        live: page.isPublished,
      };
    });
  } catch (error) {
    if (error instanceof PublishStopped) {
      const message =
        error.reason === "missing"
          ? PUBLISH_MESSAGES.missing
          : error.reason === "nothing"
            ? PUBLISH_MESSAGES.nothing
            : error.reason === "corrupt_structure"
              ? PUBLISH_MESSAGES.corruptStructure
              : error.reason === "invalid_motion"
                ? PUBLISH_MESSAGES.invalidMotion
                : error.reason === "section_conflict"
                  ? PUBLISH_MESSAGES.sectionConflict
                  : PUBLISH_MESSAGES.conflict;
      return { ok: false, reason: error.reason, message };
    }
    throw error;
  }

  const done = outcome as
    | { revision: number; versionId: number; counts: PublishCounts; live: boolean }
    | null;
  if (!done) return { ok: false, reason: "nothing", message: PUBLISH_MESSAGES.nothing };

  const parts: string[] = [];
  if (done.counts.promoted) parts.push(countPhrase(done.counts.promoted, "section"));
  if (done.counts.added) parts.push(`${done.counts.added} new`);
  if (done.counts.removed) parts.push(`${done.counts.removed} removed`);
  if (done.counts.reordered) parts.push("reordered");
  const detail = parts.length ? ` (${parts.join(", ")})` : "";

  /**
   * What to say, and it depends on something this action deliberately does not
   * change.
   *
   * `pages.is_published` is page settings: it decides whether the page is part
   * of the site at all, and publishing the changes made *to* a page is not a
   * request to put that page on the site. So an unpublished page can be
   * published-to, and telling its editor "the page is live now" would be
   * false — they would go looking for it. Each sentence describes what
   * actually happened to the thing it names.
   */
  return {
    ok: true,
    revision: done.revision,
    versionId: done.versionId,
    counts: done.counts,
    message: done.live
      ? `Published. The saved changes are live now${detail}.`
      : `Published saved changes${detail}. This page is still unpublished, so visitors ` +
        `cannot see it yet — that is a page setting.`,
    summary: `Published saved changes${detail}`,
  };
}

/* -------------------------------------------------------------------------- */
/* Discarding                                                                 */
/* -------------------------------------------------------------------------- */

export type DiscardResult =
  | { ok: true; revision: number; cleared: number; deleted: number; message: string }
  | { ok: false; reason: "missing" | "conflict" | "nothing"; message: string };

export const DISCARD_MESSAGES = {
  missing: PUBLISH_MESSAGES.missing,
  conflict:
    "This page changed while you were looking at it. Nothing was discarded — reload the page " +
    "and try again.",
  nothing: "There are no saved changes to discard on this page.",
} as const;

/**
 * Throws away everything a page has saved, and touches nothing a visitor sees.
 *
 * The counterpart to publishing, and the way out of a state publication refuses
 * to act on: a corrupt layout draft, a motion draft nobody can read, a restore
 * previewed and thought better of. It is deliberately not selective — one
 * button, one meaning — and it is atomic for the same reason publishing is: a
 * layout draft left pointing at rows that have been deleted is a page nobody
 * can open.
 */
export async function discardPageChanges(context: {
  pageId: number;
  expectedRevision: number;
  userId: number | null;
}): Promise<DiscardResult> {
  const { pageId, expectedRevision, userId } = context;
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    return { ok: false, reason: "conflict", message: DISCARD_MESSAGES.conflict };
  }

  let outcome: { revision: number; cleared: number; deleted: number } | null = null;

  try {
    await db.transaction(async (tx) => {
      const loaded = await readPage(tx, pageId, true);
      if (!loaded) throw new PublishStopped("missing");
      const { page, rows } = loaded;
      if (page.revision !== expectedRevision) throw new PublishStopped("conflict");

      const pending = rows.filter((row) => !row.isDraftOnly && draftDomainsOf(row).length);
      const doomed = rows.filter((row) => row.isDraftOnly);
      const hasLayout = page.draftStructure !== null && page.draftStructure !== undefined;
      if (!pending.length && !doomed.length && !hasLayout) throw new PublishStopped("nothing");

      for (const row of pending) {
        const result = await updateSectionGuardedIn(tx, row.id, row.revision, {
          draft: null,
          draftStyles: null,
          // Both motion columns: a document left behind would keep the page
          // publishable after the screen said it was clean.
          draftAnimation: null,
          draftMotionConfig: null,
          updatedBy: userId,
        });
        if (!result.ok) throw new PublishStopped("conflict");
      }

      /**
       * A pending row is deleted against the revision this transaction read,
       * exactly like an established one.
       *
       * It used to be a bulk delete, on the reasoning that a row nobody has
       * published carries nothing worth guarding. That is false: a section
       * added in the editor is editable the moment it exists, and by the time
       * somebody reviews a discard it may hold several autosaves of content,
       * styles and motion. Deleting it unguarded is deleting work that arrived
       * after the review — the one thing a "discard what I am looking at"
       * button must not do.
       */
      for (const row of doomed) {
        const result = await deleteSectionGuardedIn(tx, row.id, row.revision);
        if (!result.ok) throw new PublishStopped("conflict");
      }
      const deleted = doomed.length;

      const guard = await updatePageGuardedIn(tx, pageId, expectedRevision, {
        draftStructure: null,
        updatedBy: userId,
      });
      if (!guard.ok) throw new PublishStopped("conflict");

      outcome = { revision: guard.revision, cleared: pending.length, deleted };
    });
  } catch (error) {
    if (error instanceof PublishStopped) {
      const message =
        error.reason === "missing"
          ? DISCARD_MESSAGES.missing
          : error.reason === "nothing"
            ? DISCARD_MESSAGES.nothing
            : DISCARD_MESSAGES.conflict;
      return { ok: false, reason: error.reason as "missing" | "conflict" | "nothing", message };
    }
    throw error;
  }

  const done = outcome as { revision: number; cleared: number; deleted: number } | null;
  if (!done) return { ok: false, reason: "nothing", message: DISCARD_MESSAGES.nothing };

  return {
    ok: true,
    revision: done.revision,
    cleared: done.cleared,
    deleted: done.deleted,
    message: "Saved changes discarded. The live page is unchanged.",
  };
}

/* -------------------------------------------------------------------------- */
/* Restoring                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Whether a page is in a state a historical restore may be applied to.
 *
 * A restore writes into every draft column the page has, so applying one over
 * existing saved work would silently replace it — possibly somebody else's, on
 * a page they have open. V1's answer is to require a clean slate and say so,
 * rather than to merge, prompt per section, or quietly win.
 */
export const restoreBlockers = (summary: PageDraftSummary): boolean =>
  summary.contentDrafts > 0 ||
  summary.styleDrafts > 0 ||
  summary.motionDrafts > 0 ||
  summary.hasLayoutDraft ||
  summary.added > 0 ||
  summary.discardedNew > 0;

export const RESTORE_BLOCKED =
  "Publish or discard the current saved changes before restoring a historical version.";

/** Every section id a page owns — the ownership check a restore is scoped by. */
export async function pageSectionIds(pageId: number): Promise<number[]> {
  const rows = await db
    .select({ id: pageSections.id })
    .from(pageSections)
    .where(and(eq(pageSections.pageId, pageId)))
    .orderBy(asc(pageSections.position), asc(pageSections.id));
  return rows.map((row) => row.id);
}

/** A block type the registry still knows, for a snapshot about to be restored. */
export const restorableBlock = (blockType: string): boolean => Boolean(getBlock(blockType));
