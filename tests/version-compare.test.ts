/**
 * Version Compare (Batch 16) — the structured half, and the promises the
 * screen makes about itself.
 *
 * The comparison is a pure function of two page snapshots
 * (`lib/visual-editor/compare.ts`), so what it reports — added, removed,
 * moved, shown or hidden, and which content, style and motion values differ,
 * in words — is asked here directly. The two panes are the real site asked for
 * one state each; what a pane contains, who may see one, and that looking
 * writes nothing are asked of a running server in
 * `tests/visual-undo-compare.test.ts`.
 *
 * Numbers in the test names are the Batch 16 brief's §57 items.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { REPO_ROOT } from "./helpers/env";

import { BLOCKS } from "@/lib/cms/blocks";
import { composeSnapshot } from "@/lib/cms/composition";
import type { MotionDocument, MotionTarget } from "@/lib/cms/motion-doc";
import type { PageSnapshot, SnapshotSection } from "@/lib/cms/snapshot";
import type { StyleDocument } from "@/lib/cms/styles";
import { compareFramePath } from "@/lib/page-path";
import {
  changedText,
  diffSnapshots,
  DYNAMIC_DISCLAIMER,
  DYNAMIC_SOURCES,
  dynamicSourcesOf,
  excerpt,
  GLOBAL_DISCLAIMER,
  MEDIA_DISCLAIMER,
  styleValueLabel,
  type SectionDiff,
} from "@/lib/visual-editor/compare";
import { motionValueLabel } from "@/lib/visual-editor/motion-targets";
import { deviceWidth, EDITOR_DEVICES } from "@/lib/visual-editor/viewport";

const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), "utf8");
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const EMPTY_STYLES: StyleDocument = { v: 1, nodes: {} };

const text = (title: string, over: Partial<SnapshotSection> = {}, id = 1): SnapshotSection => ({
  sourceSectionId: id,
  blockType: "rich-text",
  visible: true,
  published: {
    eyebrow: { en: "", ar: "" },
    title: { en: title, ar: `ع ${title}` },
    body: { en: `<p>${title} body</p>`, ar: "<p>نص</p>" },
  },
  styles: EMPTY_STYLES,
  animation: "fade-up",
  ...over,
});

const ROW_A = "i_aaaaaaaaaa";
const ROW_B = "i_bbbbbbbbbb";
const ROW_C = "i_cccccccccc";

const links = (rows: { id: string; en: string; href?: string }[], id = 5): SnapshotSection => ({
  sourceSectionId: id,
  blockType: "quick-links",
  visible: true,
  published: {
    title: { en: "Start here", ar: "ابدأ هنا" },
    intro: { en: "", ar: "" },
    links: rows.map((row) => ({ _id: row.id, label: { en: row.en, ar: "" }, href: row.href ?? "/x", icon: "", image: 0 })),
  },
  styles: EMPTY_STYLES,
  animation: "fade-up",
});

const page = (...sections: SnapshotSection[]): PageSnapshot => ({ v: 1, sections });
const titled = (...ids: number[]) => page(...ids.map((id) => text(`Section ${id}`, {}, id)));

const only = (diff: ReturnType<typeof diffSnapshots>, sectionId: number): SectionDiff => {
  const found = diff.sections.filter((entry) => entry.sectionId === sectionId);
  assert.equal(found.length, 1, `section ${sectionId} appears ${found.length} times`);
  return found[0]!;
};

const motion = (section: MotionTarget = {}, nodes: Record<string, MotionTarget> = {}): MotionDocument => ({
  v: 1,
  section,
  nodes,
});

/* ========================================================================== */
/* Sections                                                                   */
/* ========================================================================== */

describe("sections are matched by the row they came from, never by position", () => {
  test("two identical states have nothing to report", () => {
    const diff = diffSnapshots(titled(1, 2, 3), titled(1, 2, 3));
    assert.deepEqual(diff.counts, {
      added: 0,
      removed: 0,
      moved: 0,
      visibility: 0,
      content: 0,
      style: 0,
      motion: 0,
      reuse: 0,
      unchanged: 3,
    });
    assert.ok(diff.sections.every((entry) => entry.status === "unchanged"));
  });

  test("51 · added section diff", () => {
    const diff = diffSnapshots(titled(1, 2), titled(1, 9, 2));
    const added = only(diff, 9);
    assert.equal(added.status, "added");
    assert.deepEqual(added.position, { before: null, after: 2 });
    assert.equal(diff.counts.added, 1);
    assert.equal(diff.counts.unchanged, 2);
    assert.equal(diff.counts.moved, 0, "a section added in between moves nothing");
  });

  test("52 · removed section diff, listed where it used to be", () => {
    const diff = diffSnapshots(titled(1, 2, 3), titled(1, 3));
    const removed = only(diff, 2);
    assert.equal(removed.status, "removed");
    assert.deepEqual(removed.position, { before: 2, after: null });
    assert.deepEqual(
      diff.sections.map((entry) => entry.sectionId),
      [1, 2, 3],
      "the removed section is shown between the ones it sat between",
    );
    assert.equal(diff.counts.removed, 1);
  });

  test("53 · moved section diff: one section moved is one move, not a shuffle", () => {
    const diff = diffSnapshots(titled(1, 2, 3, 4), titled(2, 3, 4, 1));
    assert.equal(diff.counts.moved, 1);
    const moved = only(diff, 1);
    assert.equal(moved.moved, true);
    assert.equal(moved.status, "changed");
    assert.deepEqual(moved.position, { before: 1, after: 4 });
    for (const id of [2, 3, 4]) assert.equal(only(diff, id).moved, false);
    // Two sections swapping is one move as well.
    assert.equal(diffSnapshots(titled(1, 2), titled(2, 1)).counts.moved, 1);
  });

  test("54 · visibility diff", () => {
    const before = titled(1, 2);
    const after = page(text("Section 1", {}, 1), text("Section 2", { visible: false }, 2));
    const diff = diffSnapshots(before, after);
    const hidden = only(diff, 2);
    assert.deepEqual(hidden.visible, { before: true, after: false });
    assert.equal(hidden.status, "changed");
    assert.equal(diff.counts.visibility, 1);
  });

  test("a section recreated with a new row is Added and Removed — never passed off as the same one", () => {
    const diff = diffSnapshots(titled(1, 2), page(text("Section 1", {}, 1), text("Section 2", {}, 7)));
    assert.equal(only(diff, 2).status, "removed");
    assert.equal(only(diff, 7).status, "added");
  });

  test("a block type that changed under one id is not an edit of one section", () => {
    const after = page(text("Section 1", {}, 1), { ...links([{ id: ROW_A, en: "A" }]), sourceSectionId: 2 });
    const diff = diffSnapshots(titled(1, 2), after);
    assert.equal(diff.counts.removed, 1);
    assert.equal(diff.counts.added, 1);
  });

  test("a repeated or missing id proves nothing: those sections compare as added and removed", () => {
    const damaged = page(text("A", {}, 1), text("B", {}, 1), text("C", {}, 0));
    const diff = diffSnapshots(damaged, damaged);
    assert.equal(diff.counts.unchanged, 0);
    assert.equal(diff.counts.added, 3);
    assert.equal(diff.counts.removed, 3);
  });

  test("a section is named by its block and its own title", () => {
    const diff = diffSnapshots(titled(1), titled(1));
    assert.equal(diff.sections[0]!.name, "Rich text — “Section 1”");
  });
});

/* ========================================================================== */
/* Content                                                                    */
/* ========================================================================== */

describe("content is compared field by field, edition by edition, row by _id", () => {
  test("55 · content field diff, per edition, as text a person reads", () => {
    const before = page(text("Who we are", {}, 1));
    const after = page(
      text("Who we are", {
        published: {
          eyebrow: { en: "", ar: "" },
          title: { en: "Who we really are", ar: "ع Who we are" },
          body: { en: "<p>Who we are <strong>body</strong></p>", ar: "<p>نص جديد</p>" },
        },
      }, 1),
    );
    const section = only(diffSnapshots(before, after), 1);
    assert.deepEqual(section.content, [
      { label: "Title (English)", before: "Who we are", after: "Who we really are" },
      // Bolding a word changes no words: said in words, not shown as two
      // identical excerpts.
      { label: "Body (English) · formatting only", before: "Who we are body", after: "Who we are body" },
      { label: "Body (Arabic)", before: "نص", after: "نص جديد" },
    ]);
    assert.equal(section.status, "changed");
    // Markup never reaches the summary.
    assert.equal(excerpt("<p>One &amp; <em>two</em></p>"), "One & two");
    assert.equal(excerpt(""), "(empty)");
    assert.equal(excerpt(true), "On");
    assert.ok(excerpt("x".repeat(500)).length <= 90);
  });

  test("an edit deep inside a long text is excerpted around the first difference, on both sides alike", () => {
    const long = `<p>${"Elite One Desk brings licences, residency and travel together. ".repeat(6)}The end.</p>`;
    const edited = long.replace("The end.", "The very end.");
    const shown = changedText(long, edited);
    assert.equal(shown.formatting, false);
    assert.notEqual(shown.before, shown.after);
    assert.ok(shown.before.startsWith("…") && shown.after.startsWith("…"));
    assert.ok(shown.after.includes("The very end."), shown.after);
    assert.ok(shown.before.includes("The end."), shown.before);
    assert.ok(shown.before.length <= 91 && shown.after.length <= 91);
    // An early edit keeps the ordinary opening excerpt.
    assert.equal(changedText("<p>Hello world</p>", "<p>Hello there</p>").before, "Hello world");
  });

  test("a select is described by its option, a picture by its library entry, a switch by On/Off", () => {
    const base = {
      eyebrow: { en: "", ar: "" },
      title: { en: "T", ar: "" },
      body: { en: "", ar: "" },
      image: 0,
      imageSide: "start",
      ctaLabel: { en: "", ar: "" },
      ctaHref: "",
    };
    const section = (published: Record<string, unknown>): SnapshotSection => ({
      sourceSectionId: 3,
      blockType: "image-text",
      visible: true,
      published,
      styles: EMPTY_STYLES,
      animation: "fade-up",
    });
    const diff = diffSnapshots(page(section(base)), page(section({ ...base, image: 12, imageSide: "end" })));
    assert.deepEqual(only(diff, 3).content, [
      { label: "Image", before: "(none)", after: "library picture #12" },
      { label: "Image position", before: "Leading edge (left in English, right in Arabic)", after: "Trailing edge" },
    ]);
    const cta = (on: boolean): SnapshotSection => ({
      sourceSectionId: 4,
      blockType: "final-cta",
      visible: true,
      published: { showWhatsapp: on },
      styles: EMPTY_STYLES,
      animation: "fade-up",
    });
    const toggled = only(diffSnapshots(page(cta(false)), page(cta(true))), 4).content;
    assert.equal(toggled.length, 1);
    assert.equal(toggled[0]!.before, "Off");
    assert.equal(toggled[0]!.after, "On");
  });

  test("56 · repeatable _id diff: a row edited after the rows were reordered is the same row", () => {
    const before = page(links([{ id: ROW_A, en: "Plan a Trip" }, { id: ROW_B, en: "Investor Licence" }, { id: ROW_C, en: "Iqama" }]));
    const after = page(
      links([{ id: ROW_B, en: "Investor licence (MISA)" }, { id: ROW_A, en: "Plan a Trip" }, { id: ROW_C, en: "Iqama" }]),
    );
    const section = only(diffSnapshots(before, after), 5);
    assert.deepEqual(
      section.content.map((change) => change.label),
      ["Links → rows reordered", "Links → “Investor licence (MISA)” → Label (English)"],
    );
    const edit = section.content[1]!;
    assert.equal(edit.before, "Investor Licence");
    assert.equal(edit.after, "Investor licence (MISA)");
    // Nothing about Plan a Trip or Iqama: they did not change, wherever they sit.
    assert.ok(!section.content.some((change) => /Iqama|Plan a Trip/.test(change.label)));
  });

  test("56 · a row added and a row removed are named by their own words", () => {
    const before = page(links([{ id: ROW_A, en: "Plan a Trip" }, { id: ROW_B, en: "Investor Licence" }]));
    const after = page(links([{ id: ROW_A, en: "Plan a Trip" }, { id: ROW_C, en: "Iqama" }]));
    assert.deepEqual(only(diffSnapshots(before, after), 5).content, [
      { label: "Links → row removed", before: "“Investor Licence”", after: "(none)" },
      { label: "Links → row added", before: "(none)", after: "“Iqama”" },
    ]);
  });

  test("56 · two rows that trade words at the same positions are two rows, not a rewrite", () => {
    const before = page(links([{ id: ROW_A, en: "One" }, { id: ROW_B, en: "Two" }]));
    const after = page(links([{ id: ROW_B, en: "Two" }, { id: ROW_A, en: "One" }]));
    const changes = only(diffSnapshots(before, after), 5).content;
    assert.deepEqual(changes.map((change) => change.label), ["Links → rows reordered"]);
  });
});

/* ========================================================================== */
/* Style and motion                                                           */
/* ========================================================================== */

describe("style and motion are compared by token and breakpoint, in the panels' own words", () => {
  const styled = (styles: StyleDocument) => page(text("S", { styles }, 1));

  test("57 · Style diff", () => {
    const diff = diffSnapshots(
      styled({ v: 1, nodes: { root: { base: { gap: 4, background: "surface" } } } }),
      styled({ v: 1, nodes: { root: { base: { gap: 6, background: "surface", opacity: 0.5 } } } }),
    );
    assert.deepEqual(only(diff, 1).style, [
      { label: "Rich text → Desktop → Gap", before: "step 4 of 12", after: "step 6 of 12" },
      { label: "Rich text → Desktop → Opacity", before: "Default", after: "50%" },
    ]);
    assert.equal(diff.counts.style, 1);
  });

  test("58 · responsive Style diff names the width, and a node by the field it is", () => {
    const diff = diffSnapshots(
      styled({ v: 1, nodes: { "field:title": { base: { fontSize: "h2" } } } }),
      styled({ v: 1, nodes: { "field:title": { base: { fontSize: "h2" }, mobile: { fontSize: "h3", hidden: true } } } }),
    );
    assert.deepEqual(only(diff, 1).style, [
      { label: "Title → Mobile → Size", before: "Default", after: styleValueLabel("fontSize", "h3") },
      { label: "Title → Mobile → Hidden", before: "Default", after: "Hidden" },
    ]);
    assert.equal(styleValueLabel("hidden", undefined), "Default");
    assert.equal(styleValueLabel("columns", 1), "1 column");
    assert.equal(styleValueLabel("objectX", 30), "30%");
  });

  const moving = (section: MotionTarget, nodes: Record<string, MotionTarget> = {}, animation = "fade-up") =>
    page(text("S", { motion: motion(section, nodes), animation }, 1));

  test("59 · Motion diff", () => {
    const diff = diffSnapshots(moving({ base: { entrance: "fade-up" } }), moving({ base: { entrance: "blur", duration: "fast" } }));
    assert.deepEqual(only(diff, 1).motion, [
      { label: "Rich text → Desktop → Duration", before: "Default", after: motionValueLabel("duration", "fast") },
      { label: "Rich text → Desktop → Entrance", before: "Fade up", after: "Blur reveal" },
    ]);
    assert.equal(diffSnapshots(moving({ base: { entrance: "fade-up" } }), moving({ base: { entrance: "blur" } })).counts.motion, 1);
  });

  test("60 · responsive Motion diff", () => {
    const diff = diffSnapshots(moving({ base: { entrance: "fade-up" } }), moving({ base: { entrance: "fade-up" }, tablet: { entrance: "none" } }));
    assert.deepEqual(only(diff, 1).motion, [
      { label: "Rich text → Tablet → Entrance", before: "Default", after: "No entrance" },
    ]);
  });

  test("61 · Parallax, Hover and Text Reveal diffs", () => {
    const diff = diffSnapshots(
      moving({}, { "field:title": { base: { entrance: "fade-up" } } }),
      moving({}, { "field:title": { base: { entrance: "fade-up", parallax: "strong", hover: "lift", textReveal: "words" } } }),
    );
    assert.deepEqual(only(diff, 1).motion, [
      { label: "Title → Desktop → Hover", before: "Default", after: motionValueLabel("hover", "lift") },
      { label: "Title → Desktop → Parallax", before: "Default", after: motionValueLabel("parallax", "strong") },
      { label: "Title → Desktop → Text reveal", before: "Default", after: "Word by word" },
    ]);
  });

  test("the section's entrance is compared as it renders, not as the legacy column projects it", () => {
    // Blur is stored in the document; the legacy column holds its projection,
    // Fade. Moving from a plain Fade section to that is a real change…
    const plainFade = page(text("S", { animation: "fade" }, 1));
    const blur = page(text("S", { animation: "fade", motion: motion({ base: { entrance: "blur" } }) }, 1));
    assert.deepEqual(only(diffSnapshots(plainFade, blur), 1).motion, [
      { label: "Rich text → Desktop → Entrance", before: "Fade only", after: "Blur reveal" },
    ]);
    // …and a column that changed only because the projection did is not one.
    const blurOnFadeUp = page(text("S", { animation: "fade-up", motion: motion({ base: { entrance: "blur" } }) }, 1));
    assert.deepEqual(only(diffSnapshots(blurOnFadeUp, blur), 1).motion, []);
    // With no document at all, the legacy preset is the entrance.
    assert.deepEqual(
      only(diffSnapshots(page(text("S", { animation: "fade-up" }, 1)), page(text("S", { animation: "scale-in" }, 1))), 1).motion,
      [{ label: "Rich text → Desktop → Entrance", before: "Fade up", after: "Scale in" }],
    );
  });
});

/* ========================================================================== */
/* The pane's composition                                                     */
/* ========================================================================== */

describe("a version is composed the way the live page composes itself", () => {
  test("visible sections, in the snapshot's order, with the values it kept and no draft", () => {
    const snapshot = page(
      text("One", { styles: { v: 1, nodes: { root: { base: { gap: 3 } } } } }, 11),
      text("Hidden", { visible: false }, 12),
      text("Three", { animation: "scale-in", motion: motion({ base: { entrance: "blur" } }) }, 13),
    );
    const composed = composeSnapshot(snapshot);
    assert.deepEqual(composed.map((section) => section.id), [11, 13]);
    assert.deepEqual(composed[0]!.values, snapshot.sections[0]!.published);
    assert.deepEqual(composed[0]!.styles, snapshot.sections[0]!.styles);
    assert.equal(composed[1]!.animation, "scale-in");
    assert.deepEqual(composed[1]!.motion, motion({ base: { entrance: "blur" } }));
    for (const section of composed) {
      assert.equal(section.isDraft, false);
      assert.equal(section.hasContentDraft, false);
      assert.equal(section.hasStyleDraft, false);
      assert.equal(section.hasMotionDraft, false);
      assert.equal(section.isDraftOnly, false);
      assert.equal(section.visible, true);
    }
  });

  test("a damaged snapshot never gives two sections one key", () => {
    const composed = composeSnapshot(page(text("A", {}, 4), text("B", {}, 4), text("C", {}, 0)));
    const ids = composed.map((section) => section.id);
    assert.equal(new Set(ids).size, 3);
    assert.equal(ids[0], 4);
    assert.ok(ids[1]! < 0 && ids[2]! < 0);
  });
});

/* ========================================================================== */
/* What a version does not hold                                               */
/* ========================================================================== */

describe("the screen says what a version does not hold", () => {
  test("63 · the dynamic-data disclaimer is the brief's own sentence", () => {
    assert.equal(
      DYNAMIC_DISCLAIMER,
      "Dynamic catalogue/global content reflects current data; the page version stores the block configuration, not a historical copy of that dataset.",
    );
  });

  test("64 · the global-component disclaimer is the brief's own sentence", () => {
    assert.equal(GLOBAL_DISCLAIMER, "Global site elements use their current settings and are not part of this page version.");
    assert.match(MEDIA_DISCLAIMER, /current media library/);
  });

  test("63–64 · the screen always says the global one, and the dynamic one when a compared state has such a block", () => {
    const view = code(read("src/components/admin/compare-view.tsx"));
    assert.match(view, /<p data-disclaimer="global">\{GLOBAL_DISCLAIMER\}<\/p>/);
    assert.match(view, /\{state\.dynamic\.length \? \(\s*<p data-disclaimer="dynamic">\s*\{DYNAMIC_DISCLAIMER\}/);
    const page = code(read("src/app/(backoffice)/admin/compare/page.tsx"));
    assert.match(page, /dynamic: dynamicSourcesOf\(pair\.left\.snapshot, rightSnapshot\)/);
  });

  test("63 · the list of dynamic blocks is exactly the blocks whose renderer reads live data", () => {
    const renderer = read("src/components/site/section-renderer.tsx");
    const imports = new Map(
      [...renderer.matchAll(/import \{ (\w+Block) \} from "\.\/blocks\/([\w-]+)";/g)].map((match) => [match[1]!, match[2]!]),
    );
    const table = /const RENDERERS: Record<string, BlockComponent> = \{([\s\S]*?)\n\};/.exec(renderer)?.[1] ?? "";
    const entries = [...table.matchAll(/^\s*"?([\w-]+)"?: (\w+Block),/gm)].map((match) => [match[1]!, match[2]!] as const);
    assert.ok(entries.length >= BLOCKS.length, "the renderer table could not be read");

    // What a block reads from the shared context, other than the language, the
    // dictionary (code, not data) and the media library (its own disclaimer).
    const LIVE = new Set(["catalog", "settings", "packages", "destinations", "videos", "testimonials", "faqs", "whatsappHref"]);
    const liveReads = (source: string): string[] => {
      const found = new Set<string>();
      for (const match of source.matchAll(/\bctx\.(\w+)/g)) if (LIVE.has(match[1]!)) found.add(match[1]!);
      for (const match of source.matchAll(/const \{([^}]*)\} = ctx;/g)) {
        for (const name of match[1]!.split(",").map((part) => part.split(":")[0]!.trim())) {
          if (LIVE.has(name)) found.add(name);
        }
      }
      return [...found].sort();
    };

    const dynamic = new Set<string>();
    for (const [type, component] of entries) {
      const file = imports.get(component);
      assert.ok(file, `${component} is not imported from ./blocks`);
      if (liveReads(read(`src/components/site/blocks/${file}.tsx`)).length) dynamic.add(type);
    }
    assert.deepEqual([...dynamic].sort(), Object.keys(DYNAMIC_SOURCES).sort());
  });

  test("the live sources of two states are listed once each", () => {
    const grid: SnapshotSection = { ...text("x", {}, 8), blockType: "service-grid", published: {} };
    const listed = dynamicSourcesOf(page(grid, text("a", {}, 1)), page(grid, { ...grid, sourceSectionId: 9 }));
    assert.deepEqual(listed, [{ blockType: "service-grid", name: "Main services", source: DYNAMIC_SOURCES["service-grid"] }]);
    assert.deepEqual(dynamicSourcesOf(titled(1, 2)), []);
  });
});

/* ========================================================================== */
/* Still: the finished, resting state                                         */
/* ========================================================================== */

describe("62 · both panes are drawn at rest: finished entrances, no motion, no runtime", () => {
  const renderer = code(read("src/components/site/section-renderer.tsx"));

  test("the renderer applies no motion document, ships no runtime and uses the plain wrapper", () => {
    assert.match(renderer, /section\.motion && !still \? motionForBlock\(section\.motion, section\.blockType\) : null/);
    assert.match(renderer, /const runtime = !still && nodeMotion\.some/);
    assert.match(renderer, /return still \|\| motion === "none" \? \(\s*<div key=\{section\.id\} \{\.\.\.attrs\}>/);
    assert.match(renderer, /\.\.\.\(still \? \{ "data-eod-still": "" as const, "data-eod-compare": String\(section\.id\) \} : \{\}\)/);
    assert.match(renderer, /return still \? <StillPresentation>\{rendered\}<\/StillPresentation> : rendered;/);
  });

  test("the script-driven decorations rest too: the count-up shows its figure, the hero words stop", () => {
    const counter = code(read("src/components/site/counter.tsx"));
    assert.match(counter, /const still = useStill\(\);/);
    assert.match(counter, /useState\(target === null \|\| still \? value :/);
    assert.match(counter, /if \(!node \|\| target === null \|\| still\) return;/);
    const calm = code(read("src/components/site/use-calm-motion.ts"));
    assert.match(calm, /return still \|\| \(mounted && Boolean\(reduce\)\);/);
    // The two components that animate from script on their own read it.
    for (const file of ["hero-words", "orbit-composition"]) {
      assert.match(read(`src/components/site/${file}.tsx`), /useCalmMotion\(\)/, file);
    }
    // And the context is off everywhere else.
    assert.match(read("src/components/site/still-presentation.tsx"), /const StillContext = createContext\(false\);/);
  });

  test("the stylesheet holds every rule of the site's reduced motion, scoped to the still mark", () => {
    const css = read("src/styles/globals.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const reducedStart = css.indexOf("@media (prefers-reduced-motion: reduce) {");
    const reduced = css.slice(reducedStart, css.indexOf("\n}\n", reducedStart));
    const stillStart = css.indexOf("[data-eod-still],");
    assert.ok(stillStart > 0, "no still block");
    const still = css.slice(stillStart, css.indexOf("@media print", stillStart));

    // The universal rule, every declaration.
    for (const declaration of [
      "animation-duration: 0.001ms !important;",
      "animation-iteration-count: 1 !important;",
      "transition-duration: 0.001ms !important;",
      "scroll-behavior: auto !important;",
    ]) {
      assert.ok(reduced.includes(declaration), `reduced motion no longer says ${declaration}`);
      assert.ok(still.includes(declaration), `still does not say ${declaration}`);
    }
    assert.match(still, /\[data-eod-still\],\s*\[data-eod-still\] \*,\s*\[data-eod-still\] \*::before,\s*\[data-eod-still\] \*::after \{/);
    assert.match(still, /\[data-eod-still\]\.reveal,\s*\[data-eod-still\] \.reveal \{ opacity: var\(--eod-node-opacity, 1\) !important; transform: none !important; \}/);

    // Every hover rule reduced motion neutralises, still neutralises too.
    const hoverRules = [...reduced.matchAll(/^\s*(\.[\w-]+:(?:hover|focus-visible)(?: \.[\w-]+)?),?$|^\s*(\.[\w-]+:(?:hover|focus-visible)(?: \.[\w-]+)?) \{ ([^}]+) \}/gm)];
    const selectors = hoverRules.map((match) => (match[1] ?? match[2])!).filter(Boolean);
    assert.ok(selectors.length >= 12, `only ${selectors.length} hover selectors found`);
    for (const selector of selectors) {
      assert.ok(still.includes(`[data-eod-still] ${selector}`), `still does not hold ${selector}`);
    }
  });

  test("the still block does not reach any public page: only the mark selects it", () => {
    const css = read("src/styles/globals.css").replace(/\/\*[\s\S]*?\*\//g, "");
    const stillStart = css.indexOf("[data-eod-still],");
    const still = css.slice(stillStart, css.indexOf("@media print", stillStart));
    for (const rule of still.split("}").map((part) => part.trim()).filter(Boolean)) {
      const selectors = rule.slice(0, rule.indexOf("{")).split(",").map((part) => part.trim());
      for (const selector of selectors) assert.ok(selector.startsWith("[data-eod-still]"), selector);
    }
  });

  test("the public routes pass still only for an authorised comparison, beside the editor flag", () => {
    for (const file of ["src/app/(public)/[lang]/[...slug]/page.tsx", "src/app/(public)/[lang]/page.tsx"]) {
      const route = code(read(file));
      assert.match(route, /still=\{Boolean\(compare\)\}/, file);
    }
  });
});

/* ========================================================================== */
/* The screen                                                                 */
/* ========================================================================== */

describe("the comparison screen: two real panes at one width and one language, read-only", () => {
  const view = code(read("src/components/admin/compare-view.tsx"));
  const screen = code(read("src/app/(backoffice)/admin/compare/page.tsx"));

  test("44–48 · both panes ask the real route for one state each, in the same language and at the same width", () => {
    assert.match(view, /src=\{compareFramePath\(page\.slug, locale, left\.id\)\}/);
    assert.match(view, /src=\{compareFramePath\(page\.slug, locale, right\.kind === "published" \? "published" : right\.id\)\}/);
    assert.equal((view.match(/device=\{device\}/g) ?? []).length, 2);
    assert.match(view, /const width = deviceWidth\(device\);/);
    assert.deepEqual(
      EDITOR_DEVICES.map((device) => [device.key, deviceWidth(device.key)]),
      [
        ["desktop", 1440],
        ["tablet", 834],
        ["mobile", 390],
      ],
    );
  });

  test("a pane's address carries one word or one id — never a snapshot", () => {
    assert.equal(compareFramePath("about", "en", "published"), "/about?compare=published");
    assert.equal(compareFramePath("about", "en", 12), "/about?compare=v12");
    assert.equal(compareFramePath("about", "ar", 12), "/ar/about?compare=v12");
    assert.equal(compareFramePath("home", "en", 3, 7), "/?compare=v3&r=7");
    const preview = code(read("src/lib/preview.ts"));
    assert.match(preview, /const COMPARE_TARGET = \/\^\(\?:published\|v\(\[1-9\]\[0-9\]\{0,9\}\)\)\$\/;/);
    assert.match(preview, /if \(!read\.ok \|\| read\.record\.pageId !== live\.id\) return nothing;/);
    assert.match(preview, /if \(!session\?\.permissions\.has\("content\.view"\)\) \{/);
  });

  test("40 · the version must belong to the page, and it is read strictly", () => {
    assert.match(screen, /const read = await readPageVersionStrict\(id\);/);
    assert.match(screen, /if \(read\.record\.pageId !== page\.id\) return "That version belongs to a different page\.";/);
    assert.match(screen, /requirePermissions\(\{ all: \["content\.view"\] \}, "\/admin\/compare"\)/);
  });

  test("43 · 65 · looking writes nothing: the screen and the pane only read", () => {
    for (const source of [screen, code(read("src/lib/preview.ts")), view]) {
      assert.ok(!/\.insert\(|\.update\(|\.delete\(|recordActivity|logActivity|writeRestorePoint|createPageVersion/.test(source));
    }
    assert.ok(!/^["']use server["']/m.test(read("src/app/(backoffice)/admin/compare/page.tsx")));
  });

  test("49 · the current side is the published composition, never a draft", () => {
    assert.match(screen, /const published = validatePageSnapshot\(await capturePageSnapshot\(page\.id\)\);/);
    const preview = code(read("src/lib/preview.ts"));
    assert.match(preview, /if \(!match\[1\]\) return \{ page: live, isPreview: false, editor: null, compare: \{ target: "published" \} \};/);
    assert.match(preview, /const live = await getPage\(slug\);/);
    assert.ok(!/getPagePreview/.test(preview.slice(preview.indexOf("async function resolveCompare"))));
  });

  test("66 · Restore from the comparison is the ordinary restore action, behind the same confirmation", () => {
    assert.match(view, /import \{ restoreVersionFromEditor \} from "@\/app\/\(backoffice\)\/admin\/visual-editor\/actions";/);
    assert.match(view, /if \(!window\.confirm\(RESTORE_CONFIRM\)\) return;/);
    assert.match(view, /const answer = await restoreVersionFromEditor\(form\);/);
    // Restoring is a page-wide act: `content.publish` since Batch 18, never the legacy key.
    assert.match(screen, /const canRestore = may\(session\.permissions, "publish"\);/);
    assert.doesNotMatch(screen, /content\.manage/);
  });

  test("labels: the current side is 'Current published', a version is the state before a publication", () => {
    assert.match(view, /right\.kind === "published" \? "Current published"/);
    assert.match(view, /— the published page just before that publication/);
    assert.match(screen, /row\?\.label \|\| "Before publishing"/);
  });

  test("accessibility: named panes and frames, labelled controls, changes in words and not colour alone", () => {
    assert.match(view, /aria-label=\{`\$\{side\} pane: \$\{heading\}`\}/);
    assert.match(view, /frameTitle=\{`Left pane: /);
    assert.match(view, /frameTitle=\{`Right pane: /);
    assert.match(view, /title=\{frameTitle\}/);
    assert.match(view, /aria-label="What changed"/);
    assert.match(view, /role="group" aria-label="Language of both panes"/);
    assert.match(view, /role="group" aria-label="Width of both panes"/);
    assert.match(view, /aria-pressed=\{device === option\.key\}/);
    assert.match(view, /<label htmlFor="compare-against"/);
    assert.match(view, /Sync scrolling/);
    // Status badges are words: Added, Removed, Moved, Shown/Hidden, counts.
    for (const word of ['"Added"', '"Removed"', "`Moved ", '"Shown"', '"Hidden"', "`Content ", "`Style ", "`Motion ", '"Unchanged"']) {
      assert.ok(view.includes(word), word);
    }
    assert.match(view, /<summary/);
  });

  test("the history lists offer the comparison next to Restore", () => {
    const history = code(read("src/components/admin/page-history.tsx"));
    assert.match(history, /href=\{`\/admin\/compare\?page=\$\{history\.pageId\}&version=\$\{version\.id\}`\}/);
    assert.match(history, /Compare with current/);
  });

  test("synchronised scrolling follows progress and cannot chase itself", () => {
    assert.match(view, /const progress = sourceMax > 0 \? source\.scrollY \/ sourceMax : 0;/);
    assert.match(view, /quietUntil\.current\[to\] = performance\.now\(\) \+ 150;/);
    assert.match(view, /if \(performance\.now\(\) < quietUntil\.current\[from\]\) return;/);
    assert.match(view, /if \(!syncRef\.current\) return;/);
  });
});
