/**
 * Motion as a draft domain, decided without a database.
 *
 * The governing rule of the batch, in one sentence: **editing a section's
 * entrance must not change what a visitor sees move until the motion draft is
 * published.** Most of what follows asks that in a different way — which
 * column a value goes into, which composition reads which column, and what a
 * value outside the vocabulary is allowed to become.
 *
 * The rest is the vocabulary itself. Five presets, one validator, and a
 * deliberate asymmetry between reading input and reading a column: input is
 * refused when it is not exactly one of the five, a stored value falls back to
 * the default. Getting that backwards in either direction is a real failure —
 * a forgiving input is how a typo becomes a stored animation, and a strict
 * column read is how a row written in 2024 blanks a page.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { REPO_ROOT } from "./helpers/env";

import { composePreview, composePublished, type CompositionRow } from "@/lib/cms/composition";
import {
  DRAFT_BADGE,
  DRAFT_LABEL,
  draftDomainsOf,
  draftKindOf,
  hasDraft,
  type DraftKind,
} from "@/lib/cms/drafts";
import {
  DEFAULT_MOTION,
  MOTION_CLASS,
  MOTION_LABEL,
  MOTION_PRESETS,
  motionOf,
  readMotion,
} from "@/lib/cms/motion";
import { revealClassOf } from "@/components/site/reveal";

const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), "utf8");

const PRESETS = MOTION_PRESETS.map((preset) => preset.value);

const row = (extra: Partial<CompositionRow> = {}): CompositionRow => ({
  id: 1,
  blockType: "page-hero",
  animation: "fade-up",
  draftAnimation: null,
  published: { title: { en: "Live", ar: "" } },
  draft: null,
  styles: null,
  draftStyles: null,
  isPublished: true,
  isDraftOnly: false,
  ...extra,
});

/* -------------------------------------------------------------------------- */

describe("there are five presets and one validator", () => {
  test("the vocabulary is exactly the five, in a fixed order", () => {
    assert.deepEqual(PRESETS, ["fade-up", "fade", "slide-in", "scale-in", "none"]);
  });

  test("each of the five is accepted, and returned unchanged", () => {
    for (const preset of PRESETS) assert.equal(readMotion(preset), preset);
  });

  test("anything outside the vocabulary is refused rather than guessed at", () => {
    for (const bad of [
      "fadeup",
      "fade-down",
      "Fade-Up",
      "FADE",
      "slide",
      "reveal",
      "",
      "fade-up,fade",
    ]) {
      assert.equal(readMotion(bad), null, `${JSON.stringify(bad)} was accepted`);
    }
  });

  test("whitespace is not trimmed — a padded preset is a bug in the sender", () => {
    for (const bad of ["fade-up ", " fade-up", "\tfade", "fade\n", " none "]) {
      assert.equal(readMotion(bad), null, `${JSON.stringify(bad)} was accepted`);
    }
  });

  test("a non-string is refused without being coerced", () => {
    for (const bad of [null, undefined, 0, 1, true, {}, [], ["fade-up"], new String("fade")]) {
      assert.equal(readMotion(bad), null, `${String(bad)} was accepted`);
    }
  });

  test("reading a column is forgiving, because a column is not input", () => {
    // `page_sections.animation` is NOT NULL DEFAULT 'fade-up' and predates the
    // vocabulary being enforced anywhere. A row holding something nobody would
    // accept today has to render as *something*, and the column's own default
    // is the only honest answer.
    assert.equal(motionOf("scale-in"), "scale-in");
    assert.equal(motionOf("none"), "none");
    assert.equal(motionOf(""), DEFAULT_MOTION);
    assert.equal(motionOf(null), DEFAULT_MOTION);
    assert.equal(motionOf(undefined), DEFAULT_MOTION);
    assert.equal(motionOf("whatever-this-is"), DEFAULT_MOTION);
  });

  test("every preset has a label and a class list, and no sixth entry exists", () => {
    assert.deepEqual(Object.keys(MOTION_LABEL).sort(), [...PRESETS].sort());
    assert.deepEqual(Object.keys(MOTION_CLASS).sort(), [...PRESETS].sort());
    for (const preset of PRESETS) assert.ok(MOTION_LABEL[preset].length > 0);
  });

  test("“none” is the only preset with no reveal class", () => {
    assert.equal(MOTION_CLASS.none, "");
    for (const preset of PRESETS.filter((p) => p !== "none")) {
      assert.match(MOTION_CLASS[preset], /\breveal\b/);
    }
  });

  test("a section's entrance and a block's reveal read the same table", () => {
    // Two tables would eventually disagree about what "slide in" looks like —
    // inside a section and around it.
    for (const preset of PRESETS) assert.equal(revealClassOf(preset), MOTION_CLASS[preset]);
    assert.ok(!/VARIANT_CLASS/.test(read("src/components/site/reveal.tsx")));
  });

  test("the preset list lives in one module", () => {
    // It used to be `ANIMATIONS` in the block registry, which is where block
    // *fields* are defined — and an entrance is not a field of any block.
    assert.ok(!/ANIMATIONS|ANIMATION_PRESETS/.test(read("src/lib/cms/blocks.ts")));
  });
});

/* -------------------------------------------------------------------------- */

describe("null is no motion draft, and “none” is a real one", () => {
  test("the live composition reads the published column, whatever is pending", () => {
    const composed = composePublished([row({ animation: "scale-in", draftAnimation: "none" })]);
    assert.equal(composed[0]!.animation, "scale-in");
    assert.equal(composed[0]!.hasMotionDraft, false);
    assert.equal(composed[0]!.isDraft, false);
  });

  test("preview reads the draft when there is one", () => {
    const composed = composePreview([row({ animation: "fade-up", draftAnimation: "slide-in" })], null);
    assert.equal(composed[0]!.animation, "slide-in");
    assert.equal(composed[0]!.hasMotionDraft, true);
    assert.equal(composed[0]!.isDraft, true);
  });

  test("and the published one when there is not", () => {
    const composed = composePreview([row({ animation: "fade", draftAnimation: null })], null);
    assert.equal(composed[0]!.animation, "fade");
    assert.equal(composed[0]!.hasMotionDraft, false);
    assert.equal(composed[0]!.isDraft, false);
  });

  test("a draft of “none” is pending, not absent", () => {
    // The whole reason the column is nullable rather than defaulted. If
    // emptiness were the test, turning an animation off would look exactly
    // like never having touched it and publishing would leave it running.
    const composed = composePreview([row({ animation: "fade-up", draftAnimation: "none" })], null);
    assert.equal(composed[0]!.animation, "none");
    assert.equal(composed[0]!.hasMotionDraft, true);
    assert.equal(composed[0]!.isDraft, true);
  });

  test("a draft matching what is published is still a draft", () => {
    const composed = composePreview([row({ animation: "fade", draftAnimation: "fade" })], null);
    assert.equal(composed[0]!.hasMotionDraft, true);
    assert.equal(composed[0]!.isDraft, true);
  });

  test("an unreadable stored draft renders as the default rather than as itself", () => {
    const composed = composePreview([row({ animation: "fade", draftAnimation: "nonsense" })], null);
    assert.equal(composed[0]!.animation, DEFAULT_MOTION);
    // Still pending: the column is not null, so there is something to publish
    // or discard, and hiding that would leave a draft nobody can reach.
    assert.equal(composed[0]!.hasMotionDraft, true);
  });

  test("isDraft is true for any one of the three domains alone", () => {
    const one = (extra: Partial<CompositionRow>) => composePreview([row(extra)], null)[0]!;
    assert.equal(one({ draft: { a: 1 } }).isDraft, true);
    assert.equal(one({ draftStyles: {} }).isDraft, true);
    assert.equal(one({ draftAnimation: "fade" }).isDraft, true);
    assert.equal(one({}).isDraft, false);
  });

  test("the three flags are independent of each other", () => {
    const only = composePreview([row({ draftAnimation: "scale-in" })], null)[0]!;
    assert.equal(only.hasMotionDraft, true);
    assert.equal(only.hasContentDraft, false);
    assert.equal(only.hasStyleDraft, false);
  });
});

/* -------------------------------------------------------------------------- */

describe("three domains make seven ways to be pending, and all seven are named", () => {
  const kinds: [Partial<Record<"draft" | "draftStyles" | "draftAnimation", unknown>>, DraftKind][] = [
    [{}, "none"],
    [{ draft: {} }, "content"],
    [{ draftStyles: {} }, "style"],
    [{ draftAnimation: "none" }, "motion"],
    [{ draft: {}, draftStyles: {} }, "content+style"],
    [{ draft: {}, draftAnimation: "fade" }, "content+motion"],
    [{ draftStyles: {}, draftAnimation: "fade" }, "style+motion"],
    [{ draft: {}, draftStyles: {}, draftAnimation: "fade" }, "content+style+motion"],
  ];

  const full = (partial: Record<string, unknown>) => ({
    draft: null,
    draftStyles: null,
    draftAnimation: null,
    ...partial,
  });

  test("each combination has its own name, in a fixed domain order", () => {
    for (const [partial, expected] of kinds) {
      assert.equal(draftKindOf(full(partial)), expected);
    }
  });

  test("every name has a badge and a sentence", () => {
    for (const [, kind] of kinds) {
      assert.equal(typeof DRAFT_BADGE[kind], "string");
      assert.equal(typeof DRAFT_LABEL[kind], "string");
      if (kind !== "none") {
        assert.ok(DRAFT_BADGE[kind].length > 0, `${kind} has no badge`);
        assert.ok(DRAFT_LABEL[kind].length > 0, `${kind} has no label`);
      }
    }
  });

  test("a sentence names every domain it covers", () => {
    for (const [, kind] of kinds) {
      if (kind === "none") continue;
      for (const domain of kind.split("+")) {
        assert.match(DRAFT_LABEL[kind].toLowerCase(), new RegExp(domain));
      }
    }
  });

  test("an empty style document and the preset “none” are both drafts", () => {
    // Falsiness is never the test: `{}` removes every override when published
    // and `"none"` removes the entrance.
    assert.equal(draftKindOf(full({ draftStyles: {} })), "style");
    assert.equal(draftKindOf(full({ draftAnimation: "none" })), "motion");
    assert.deepEqual(draftDomainsOf(full({ draftAnimation: "none" })), ["motion"]);
  });

  test("hasDraft is true for all seven and false for none", () => {
    for (const [partial, kind] of kinds) {
      assert.equal(hasDraft(draftKindOf(full(partial))), kind !== "none");
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("the renderer puts the entrance on the section's own wrapper", () => {
  const renderer = read("src/components/site/section-renderer.tsx");
  const wrapper = read("src/components/site/section-motion.tsx");

  test("no element is added around the section", () => {
    // A wrapper here would move every `root` address, every stored root
    // override and every rectangle the editor bridge measures.
    assert.match(wrapper, /<div\s+ref=\{ref/);
    assert.ok(!/<div[^>]*>\s*<div/.test(wrapper), "the motion wrapper nests an element");
  });

  test("“none” renders the plain wrapper, with no class and no client component", () => {
    assert.match(renderer, /motion === "none" \? \(\s*<div key=\{section\.id\} \{\.\.\.attrs\}>/);
  });

  test("both branches carry the same attributes object", () => {
    // One definition of what a section wrapper holds. Two would drift, and the
    // way they drift is a section that loses its address when its entrance
    // changes.
    assert.equal((renderer.match(/\{\.\.\.attrs\}/g) ?? []).length, 1);
    assert.match(renderer, /attrs=\{attrs\}/);
    assert.match(renderer, /const attrs: SectionWrapperAttrs = \{/);
  });

  test("the finished opacity and the responsive branches go through the shared helpers", () => {
    // An inline `opacity` on a `.reveal` would show the section at half
    // strength before it revealed and leave the fade nothing to travel.
    assert.match(wrapper, /revealStyle\(\{ delay: 0, revealClass, node: nodeStyle \}\)/);
    assert.match(wrapper, /revealMarks\(revealClass, rest\)/);
  });

  test("reduced motion and print are the stylesheet's, so no preset can opt out", () => {
    const css = read("src/styles/globals.css");
    const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)"));
    assert.match(reduced.slice(0, 600), /\.reveal \{ opacity: var\(--eod-node-opacity, 1\) !important/);
    const print = css.slice(css.indexOf("@media print"));
    assert.match(print.slice(0, 900), /\.reveal \{ opacity: var\(--eod-node-opacity, 1\) !important/);
  });

  test("the hidden state is still script-only, so a section is never stranded", () => {
    const css = read("src/styles/globals.css");
    const scripting = css.indexOf("@media (scripting: enabled)");
    assert.ok(scripting > 0);
    // The only rule that sets a reveal to opacity 0 is inside it.
    const hidden = [...css.matchAll(/\.reveal \{[^}]*opacity: 0/g)].map((m) => m.index ?? -1);
    assert.equal(hidden.length, 1, "more than one rule hides a reveal");
    assert.ok(hidden[0]! > scripting, "a reveal is hidden outside @media (scripting: enabled)");
  });
});

/* -------------------------------------------------------------------------- */

describe("each domain writes its own column, and only one writes at a time", () => {
  const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), "utf8");

  test("the Visual Editor's motion save names one column", () => {
    const actions = read("src/app/(backoffice)/admin/visual-editor/actions.ts");
    const body = actions.slice(actions.indexOf("export async function saveVisualSectionMotion"));
    const write = body.slice(body.indexOf("updateSectionGuarded("), body.indexOf("if (!result.ok)"));
    assert.ok(write.length > 0, "the motion action no longer makes one guarded write");
    assert.match(write, /draftAnimation: motion/);
    // Not the published column, not another domain's, not visibility, not
    // position. The guard adds the revision, the author and the timestamp.
    for (const forbidden of [
      /\bpublished:/,
      /\bdraft:/,
      /\bdraftStyles:/,
      /\bstyles:/,
      /\bisPublished\b/,
      /\bisDraftOnly\b/,
      /\bposition\b/,
      /(?<!draft)Animation: motion/,
    ]) {
      assert.ok(!forbidden.test(write), `the motion save writes ${forbidden}`);
    }
  });

  test("it is guarded on the section's revision, never the page's", () => {
    const actions = read("src/app/(backoffice)/admin/visual-editor/actions.ts");
    const body = actions.slice(
      actions.indexOf("export async function saveVisualSectionMotion"),
      actions.indexOf("/* ----", actions.indexOf("export async function saveVisualSectionMotion")),
    );
    assert.match(body, /updateSectionGuarded\(sectionId, expected/);
    assert.ok(!/updatePageGuarded|draftStructure/.test(body), "a motion save touches the page");
  });

  test("the save bar refuses to start while any domain is writing", () => {
    // One row, one revision: two requests in flight against it would be a race
    // this browser manufactured out of two intentions that were each correct
    // when they left.
    const inspector = read("src/components/admin/visual-editor/inspector.tsx");
    assert.match(inspector, /const blocked = buffer\.saving !== null;/);
    assert.match(inspector, /disabled=\{!dirty \|\| blocked\}/);
  });

  test("all three domains are offered, and dirtiness is read in one place", () => {
    const inspector = read("src/components/admin/visual-editor/inspector.tsx");
    assert.match(inspector, /EDIT_DOMAINS = \["content", "style", "motion"\] as const/);
    assert.match(inspector, /content: buffer\.contentDirty,\s*\n\s*style: buffer\.styleDirty,\s*\n\s*motion: buffer\.motionDirty,/);
    const shell = read("src/components/admin/visual-editor/shell.tsx");
    assert.match(shell, /dirtyOf\(entry\)\[domain\]/);
  });

  test("taking the latest version replaces all three domains", () => {
    const shell = read("src/components/admin/visual-editor/shell.tsx");
    const body = shell.slice(shell.indexOf("const takeLatest"), shell.indexOf("const save ="));
    for (const field of [
      /values: entry\.latest\.values/,
      /styles: entry\.latest\.styles/,
      /motion: entry\.latest\.motion/,
      /contentDirty: false/,
      /styleDirty: false/,
      /motionDirty: false/,
    ]) {
      assert.match(body, field);
    }
  });

  test("recovering from a layout conflict touches no section buffer at all", () => {
    const shell = read("src/components/admin/visual-editor/shell.tsx");
    const body = shell.slice(shell.indexOf("const reloadLayout"), shell.indexOf("const ops:"));
    assert.ok(!/setBuffers/.test(body), "reloading the layout writes a section buffer");
  });
});
