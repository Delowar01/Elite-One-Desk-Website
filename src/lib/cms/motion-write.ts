import { effectiveMotion, motionOf, readMotion, type MotionPreset } from "./motion";
import {
  effectiveSectionTarget,
  emptyMotionDocument,
  isEmptyMotionDocument,
  isReadableMotionDocument,
  legacyProjection,
  legacySectionPreset,
  readMotionDocument,
  validateMotionDocument,
  type MotionDocument,
} from "./motion-doc";
import { motionForBlock } from "@/lib/visual-editor/motion-targets";

/**
 * How motion is written, whoever writes it — and how it is published.
 *
 * Motion is one domain with two columns on each side of publication — the
 * legacy preset every build understands (`animation` / `draft_animation`), and
 * the advanced document only this one does (`motion_config` /
 * `draft_motion_config`) — and there are four writers: the Visual Editor's
 * document, the Visual Editor's plain preset (the shape older callers still
 * send), the classic section form, and publication. Left to themselves they
 * would disagree: the classic form would set a preset that the document
 * silently outranked, or a publish would promote a document while the preset
 * beside it told an older build something else.
 *
 * So every one of them goes through here, and every write produces **both**
 * columns of its side from one decision. The invariant they keep:
 *
 *   · while a document draft exists, `draft_animation` is
 *     `legacyProjection(draft document, published preset)` — the nearest of
 *     the five presets, for the release in `deploy/previous-release`;
 *   · after a publication, `animation` is
 *     `legacyProjection(motion_config, …)` — so a rollback shows the entrance
 *     the document most resembles, never a preset the document contradicts.
 *
 * A section that has never had advanced motion stays exactly that: a preset
 * written to it goes to `draft_animation` alone, as in Batch 9, publishing it
 * writes `animation` alone, and no document is created on its behalf.
 */

/** The columns a motion write reads. */
export type MotionRow = {
  animation: string;
  draftAnimation: string | null;
  motionConfig: unknown;
  draftMotionConfig: unknown;
};

export type MotionDraft = {
  draftAnimation: MotionPreset;
  draftMotionConfig: MotionDocument | null;
};

/** Some subset of the four motion columns — exactly the ones a write changes. */
export type MotionColumns = {
  animation?: MotionPreset;
  draftAnimation?: MotionPreset | null;
  motionConfig?: MotionDocument | null;
  draftMotionConfig?: MotionDocument | null;
};

export type MotionWrite = { ok: true; values: MotionColumns } | { ok: false };

const present = (value: unknown): boolean => value !== null && value !== undefined;

/**
 * The legacy preset a section falls back to when its document names no Base
 * entrance — the "Legacy default" the panel offers, and exactly the preset the
 * renderer and a publication fall back to.
 *
 * One subtlety, and it is the reason this is a function. While a document
 * draft exists, `draft_animation` is normally that document's *projection*,
 * not a choice anybody made: treating it as the fallback would mean that
 * choosing Blur and then going back to the default landed on Fade, because
 * Fade is what Blur projects to. So with a document draft on file the fallback
 * is the published preset.
 *
 * Unless the column no longer *is* the projection. The previous release knows
 * nothing about documents, and after a rollback it can write `draft_animation`
 * beside one; what it wrote is then a choice, and it stands wherever the
 * document is silent. Without a document draft, a pending preset — from the
 * classic form, or from that release — is a real choice and is respected.
 */
export function legacyFallback(row: MotionRow): MotionPreset {
  const published = motionOf(row.animation);
  const pending = present(row.draftAnimation) ? readMotion(row.draftAnimation) : null;
  if (!present(row.draftMotionConfig)) return pending ?? published;
  if (pending === null) return published;
  const derived = legacyProjection(readMotionDocument(row.draftMotionConfig), published);
  return pending === derived ? published : pending;
}

/** The document an edit starts from: the draft when there is one, else the published one. */
export function currentMotionDocument(row: MotionRow): MotionDocument | null {
  return readMotionDocument(present(row.draftMotionConfig) ? row.draftMotionConfig : row.motionConfig);
}

/**
 * Whether a section's motion is more than one preset can say — for the classic
 * section form, which has one menu and should admit it.
 */
export function hasAdvancedMotion(row: MotionRow): boolean {
  const document = currentMotionDocument(row);
  if (!document || isEmptyMotionDocument(document)) return false;
  if (Object.keys(document.nodes).length) return true;
  return legacySectionPreset(effectiveSectionTarget(document, legacyFallback(row))) === null;
}

/**
 * A submitted document, written as both draft columns.
 *
 * One moment needs care — the first document written over a *pending preset*
 * (from the classic form, or from the previous release). Until then that preset
 * is the fallback, and the panel offered it by name; afterwards the fallback is
 * the published preset. A document with no Base entrance of its own would
 * therefore quietly change the section's entrance back to the published one.
 * So the pending choice is written into the document as the section's Base
 * entrance — exactly what the editor chose, in the one place that now decides.
 * A legacy preset in the document renders on the legacy classes
 * (`legacySectionPreset`), so nothing on the page moves.
 */
export function motionDraftFromDocument(row: MotionRow, blockType: string, submitted: unknown): MotionDraft {
  let document = motionForBlock(submitted, blockType);
  const published = motionOf(row.animation);
  const fallback = legacyFallback(row);
  if (fallback !== published && document.section.base?.entrance === undefined) {
    document = motionForBlock(
      { ...document, section: { ...document.section, base: { ...document.section.base, entrance: fallback } } },
      blockType,
    );
  }
  return {
    draftMotionConfig: document,
    draftAnimation: legacyProjection(document, published),
  };
}

/**
 * A submitted preset — the one thing the classic form and older callers can
 * say — written coherently.
 *
 * With no advanced document anywhere, this is the Batch 9 write exactly: the
 * preset goes to `draft_animation` and nothing else. With one, the preset *is*
 * the section's Base entrance, so it is written into the document as well —
 * otherwise the document's own entrance would outrank it on every page this
 * build renders, and the choice would appear to have done nothing.
 */
export function motionDraftFromPreset(row: MotionRow, blockType: string, preset: MotionPreset): MotionDraft {
  const current = currentMotionDocument(row);
  if (!current) return { draftAnimation: preset, draftMotionConfig: null };
  const next = validateMotionDocument(current);
  next.section = { ...next.section, base: { ...next.section.base, entrance: preset } };
  const document = motionForBlock(next, blockType);
  return { draftMotionConfig: document, draftAnimation: legacyProjection(document, motionOf(row.animation)) };
}

/** Whether two documents mean the same thing. */
export function sameMotion(a: MotionDocument | null, b: MotionDocument | null): boolean {
  const left = JSON.stringify(validateMotionDocument(a ?? emptyMotionDocument()));
  const right = JSON.stringify(validateMotionDocument(b ?? emptyMotionDocument()));
  return left === right;
}

/**
 * Whether two (document, preset) pairs put the same thing on screen *and* tell
 * an older build the same thing — the test for "this draft changes nothing".
 *
 * Documents are compared by what they do rather than how they are spelled: a
 * section target that only restates the legacy preset is the same section as
 * the preset on its own.
 */
function sameOutcome(
  a: { document: MotionDocument | null; preset: MotionPreset },
  b: { document: MotionDocument | null; preset: MotionPreset },
): boolean {
  if (a.preset !== b.preset) return false;
  const left = validateMotionDocument(a.document ?? emptyMotionDocument());
  const right = validateMotionDocument(b.document ?? emptyMotionDocument());
  if (JSON.stringify(left.nodes) !== JSON.stringify(right.nodes)) return false;
  const outcomeOf = (document: MotionDocument, preset: MotionPreset): string => {
    const target = effectiveSectionTarget(document, preset);
    const legacy = legacySectionPreset(target);
    return legacy !== null
      ? `legacy:${legacy}`
      : JSON.stringify(validateMotionDocument({ v: 1, section: target }).section);
  };
  return outcomeOf(left, a.preset) === outcomeOf(right, b.preset);
}

/**
 * What publishing a section's motion draft writes: both live columns from one
 * decision, or a refusal.
 *
 * Strict about stored intent, as the preset always was: a pending preset
 * outside the vocabulary, or a pending document this build cannot read, stops
 * the publication rather than publishing a guess. `{}` when nothing is pending.
 *
 *   · `motion_config` becomes the draft document, cut down to what the block
 *     can carry — or `null` when it is empty, so "no advanced motion" has one
 *     spelling whether it was never set or was reset;
 *   · `animation` becomes the projection of the document the page will now
 *     have, falling back to the pending preset, then the published one. That is
 *     exactly what the preview rendered, and it keeps the published pair
 *     coherent even when the two draft columns were written by different
 *     releases.
 */
export function motionPromotion(row: MotionRow, blockType: string): MotionWrite {
  const hasPreset = present(row.draftAnimation);
  const hasDocument = present(row.draftMotionConfig);
  if (!hasPreset && !hasDocument) return { ok: true, values: {} };

  const pending = hasPreset ? readMotion(row.draftAnimation) : null;
  if (hasPreset && pending === null) return { ok: false };
  if (hasDocument && !isReadableMotionDocument(row.draftMotionConfig)) return { ok: false };

  const preset = pending ?? motionOf(row.animation);
  const document = hasDocument
    ? motionForBlock(row.draftMotionConfig, blockType)
    : readMotionDocument(row.motionConfig);
  const values: MotionColumns = {
    animation: legacyProjection(document, preset),
    draftAnimation: null,
  };
  if (hasDocument) {
    values.motionConfig = document && !isEmptyMotionDocument(document) ? document : null;
    values.draftMotionConfig = null;
  }
  return { ok: true, values };
}

/**
 * The classic section form's motion menu, saved or published — for a section
 * that has an advanced document. `null` for one that has none: the Batch 9
 * rules then apply exactly as they always have, and `writeSectionValues` keeps
 * them inline where they have always been.
 *
 * With a document, two things are different, both because the form can only
 * say one preset:
 *
 *   · **An untouched menu says nothing.** The form always submits the menu,
 *     and it shows the section's preset — for a Blur section, its projection,
 *     Fade. Treating that as a choice would turn Blur into Fade whenever
 *     somebody fixed a typo. So a submitted preset equal to what the form
 *     showed leaves motion alone when saving, and publishes the pending motion
 *     draft as it stands when publishing — which is what Publish on this form
 *     has always done with a pending preset.
 *   · **A changed menu is the section's Base entrance**, written into the
 *     document (`motionDraftFromPreset`); and the Batch 9 withdrawal becomes
 *     "a draft that would change nothing is withdrawn", compared by outcome, so
 *     element motion saved in the Visual Editor is never thrown away by a menu.
 */
export function classicMotionWrite(
  row: MotionRow,
  blockType: string,
  chosen: MotionPreset,
  publish: boolean,
): MotionWrite | null {
  const hasDocument = present(row.motionConfig) || present(row.draftMotionConfig);
  if (!hasDocument) return null;

  const shown = effectiveMotion(row.animation, row.draftAnimation);
  const next: MotionRow = chosen === shown ? row : { ...row, ...motionDraftFromPreset(row, blockType, chosen) };

  if (publish) return motionPromotion(next, blockType);
  if (next === row) return { ok: true, values: {} };

  const draft = {
    draftAnimation: next.draftAnimation as MotionPreset,
    draftMotionConfig: next.draftMotionConfig as MotionDocument,
  };
  const unchanged = sameOutcome(
    { document: draft.draftMotionConfig, preset: draft.draftAnimation },
    { document: readMotionDocument(row.motionConfig), preset: motionOf(row.animation) },
  );
  return {
    ok: true,
    values: unchanged ? { draftAnimation: null, draftMotionConfig: null } : draft,
  };
}
