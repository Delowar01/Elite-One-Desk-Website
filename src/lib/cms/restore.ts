/**
 * What putting a version back would do — worked out without doing any of it.
 *
 * Split out of `lib/versions.ts` on purpose. The decisions here are the whole
 * risk of a restore (which section is the same section, what becomes a new row,
 * what is left alone, where each one sits in the order), and none of them need
 * a database to make. Keeping them pure means they can be tested exhaustively,
 * cheaply, and without a server.
 *
 * The rule everything below serves: **a restore must not be live.** The plan
 * only ever produces draft content and a draft order. No published value, no
 * position and no visibility flag is in it.
 */
import { emptyMotionDocument, readMotionDocument, type MotionDocument } from "./motion-doc";
import { sameMotion } from "./motion-write";
import { validatePageSnapshot, type PageSnapshot } from "./snapshot";

/**
 * A section as it exists on the page today. All the planner needs of one:
 * which section it is, and — since Batch 15 — the advanced motion it is
 * publishing, because putting a version back has to be able to *remove* that.
 */
export type LiveSection = { id: number; blockType: string; motionConfig: unknown };

export type RestoreDraft = {
  sectionId: number;
  draft: Record<string, unknown>;
  draftStyles: Record<string, unknown>;
  draftAnimation: string;
  /** `null` when the version's advanced motion is what the section already publishes. */
  draftMotionConfig: MotionDocument | null;
};

export type RestoreRecreate = {
  blockType: string;
  draft: Record<string, unknown>;
  draftStyles: Record<string, unknown>;
  draftAnimation: string;
  draftMotionConfig: MotionDocument | null;
  visible: boolean;
};

/**
 * The motion document a restore writes into `draft_motion_config`.
 *
 * The version's document when it differs from what the section publishes now,
 * and the **empty** document when the version had none but the section has one
 * — an empty draft is a pending reset, so publishing the restore takes the
 * advanced motion away, exactly as the version looked. `null` when the two
 * already agree: there is nothing for the draft to change, and a page with no
 * advanced motion restores exactly as it did before Batch 15.
 *
 * `draft_animation` carries the version's own `animation` beside it, which is
 * that document's projection at the time — so the pair a restore writes is the
 * pair the version published.
 */
function restoredMotion(version: MotionDocument | undefined, live: unknown): MotionDocument | null {
  const current = readMotionDocument(live);
  if (sameMotion(version ?? null, current)) return null;
  return version ?? emptyMotionDocument();
}

/**
 * The restored order, before the recreated rows have ids.
 *
 * A snapshot's order is not "the surviving sections, then the new ones" — a
 * section deleted from the middle of the page belongs back in the middle. So
 * the plan records the sequence with placeholders, and `applyRestorePlan`
 * substitutes each real id once the insert has produced it.
 */
export type RestoreSlot =
  | { kind: "existing"; sectionId: number; visible: boolean }
  | { kind: "recreate"; index: number; visible: boolean };

export type RestorePlan = {
  pageId: number;
  /** Sections that still exist: their historical content, as a draft. */
  drafts: RestoreDraft[];
  /** Sections the snapshot has and the page does not: inserted hidden. */
  recreate: RestoreRecreate[];
  /** Live sections the snapshot never mentioned. Left exactly as they are. */
  untouched: number[];
  /** The order and visibility the page would have, once published. */
  order: RestoreSlot[];
};

/**
 * A snapshot handed to the planner is re-validated, never trusted.
 *
 * `validatePageSnapshot` is the whole of it — content through the block
 * registry, styles through the token vocabulary, unknown block types dropped —
 * and it is idempotent, so running it again on a snapshot that already came out
 * of it costs a rebuild and changes nothing. That is the point: `planRestore`
 * is exported and takes a `PageSnapshot`, so the guarantee cannot depend on
 * every caller having read it from `page_versions` first.
 */
export function revalidateSnapshot(snapshot: PageSnapshot): PageSnapshot {
  return validatePageSnapshot(snapshot);
}

/**
 * Matches a snapshot against the page as it stands now.
 *
 * By `sourceSectionId`, and only when the block type still agrees — an id can
 * be reused by a different section after a delete, and pouring a hero's values
 * into a FAQ is worse than recreating the hero. Each live row can be claimed
 * once: a snapshot that somehow names the same section twice gets one draft and
 * one fresh row, never two writes racing into one place.
 *
 * A snapshot entry that matches nothing becomes a new hidden row. A live
 * section the snapshot does not mention keeps its row and is simply left out of
 * the draft order, so removing it stays an explicit, separate publish rather
 * than something a restore did quietly.
 */
export function planRestoreFrom(
  pageId: number,
  input: PageSnapshot,
  live: readonly LiveSection[],
): RestorePlan {
  const snapshot = revalidateSnapshot(input);
  const byId = new Map(live.map((row) => [row.id, row]));
  const claimed = new Set<number>();

  const drafts: RestoreDraft[] = [];
  const recreate: RestoreRecreate[] = [];
  const order: RestoreSlot[] = [];

  for (const entry of snapshot.sections) {
    const match = byId.get(entry.sourceSectionId);
    if (match && match.blockType === entry.blockType && !claimed.has(match.id)) {
      claimed.add(match.id);
      drafts.push({
        sectionId: match.id,
        draft: entry.published,
        draftStyles: entry.styles,
        draftAnimation: entry.animation,
        draftMotionConfig: restoredMotion(entry.motion, match.motionConfig),
      });
      order.push({ kind: "existing", sectionId: match.id, visible: entry.visible });
      continue;
    }
    recreate.push({
      blockType: entry.blockType,
      draft: entry.published,
      draftStyles: entry.styles,
      draftAnimation: entry.animation,
      // A new row publishes nothing yet, so only a version that had a document
      // needs one.
      draftMotionConfig: restoredMotion(entry.motion, null),
      visible: entry.visible,
    });
    order.push({ kind: "recreate", index: recreate.length - 1, visible: entry.visible });
  }

  return {
    pageId,
    drafts,
    recreate,
    untouched: live.filter((row) => !claimed.has(row.id)).map((row) => row.id),
    order,
  };
}
