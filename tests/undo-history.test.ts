/**
 * Undo and Redo in the Visual Editor (Batch 16) — the rules, asked directly.
 *
 * The history is a pure module (`lib/visual-editor/history.ts`) and the buffer
 * rule it relies on is another (`lib/visual-editor/buffer-state.ts`), so almost
 * every promise can be tested without a browser: what an action records, what
 * Undo and Redo put back, what groups and what never does, what clears Redo,
 * when a history refuses to replay, and how the layout is walked back with the
 * structure service's own operations. Where the promise is the *wiring* — which
 * events reset the history, which keys are the editor's and which are a text
 * field's — the shell and the canvas bridge are read as source, the same way
 * the earlier batches hold their invariants.
 *
 * The server half (an Undo saved through the ordinary save path, and a removed
 * section put back exactly where it was) is asked of a running server in
 * `tests/visual-undo-compare.test.ts`.
 *
 * Numbers in the test names are the Batch 16 brief's §56 items.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { REPO_ROOT } from "./helpers/env";

import type { MotionDocument, MotionTarget } from "@/lib/cms/motion-doc";
import type { DraftStructure } from "@/lib/cms/structure";
import type { StyleDocument } from "@/lib/cms/styles";
import { withDomainValue } from "@/lib/visual-editor/buffer-state";
import {
  applyContent,
  boundPages,
  closeGroup,
  CONTINUOUS_MOTION_FIELDS,
  CONTINUOUS_STYLE_TOKENS,
  describeContent,
  describeMotion,
  describeStructure,
  describeStyle,
  diffContent,
  emptyHistory,
  GROUP_IDLE_MS,
  groupOf,
  HISTORY_LIMIT,
  HISTORY_PAGES,
  HISTORY_RESET,
  isNoop,
  record,
  structureStep,
  takeRedo,
  takeUndo,
  UNDO_SCOPE_NOTE,
  type HistoryChange,
  type PageHistory,
} from "@/lib/visual-editor/history";
import {
  envelope,
  isTextTarget,
  PROTOCOL_VERSION,
  readCanvasMessage,
  SHORTCUT_COMMANDS,
  shortcutFor,
} from "@/lib/visual-editor/protocol";

const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), "utf8");
/** Source with its prose removed, so a comment is never read as code. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ").replace(/\{\/\*[\s\S]*?\*\/\}/g, " ");

const SHELL = code(read("src/components/admin/visual-editor/shell.tsx"));
const BRIDGE = code(read("src/components/site/editor-bridge.tsx"));
const CANVAS = code(read("src/components/admin/visual-editor/canvas.tsx"));
const HISTORY_SOURCE = read("src/lib/visual-editor/history.ts");

/**
 * Everything a declaration owns, up to the next one at its own indentation —
 * the same boundary `tests/direct-edit-readiness.test.ts` uses, for the same
 * reason: `useCallback((x: { … }) => …)` opens a type literal before the body.
 */
function bodyOf(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} is no longer in the source`);
  const lineStart = source.lastIndexOf("\n", start) + 1;
  const indent = source.slice(lineStart, start).length;
  const rest = source.slice(start + declaration.length);
  const next = rest.search(new RegExp(`\\n {${indent}}(?:const|function|useEffect\\(|return|\\})`));
  return declaration + (next === -1 ? rest : rest.slice(0, next));
}

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const SECTION = 41;
const OTHER_SECTION = 42;

const richText = (): Record<string, unknown> => ({
  eyebrow: { en: "About us", ar: "من نحن" },
  title: { en: "Who we are", ar: "من نكون" },
  body: { en: "<p>One desk for every service.</p>", ar: "<p>مكتب واحد لكل خدمة.</p>" },
});

const ROW_A = "i_aaaaaaaaaa";
const ROW_B = "i_bbbbbbbbbb";
const ROW_C = "i_cccccccccc";

const quickLinks = (): Record<string, unknown> => ({
  title: { en: "Start here", ar: "ابدأ هنا" },
  intro: { en: "", ar: "" },
  links: [
    { _id: ROW_A, label: { en: "Plan a Trip", ar: "خطط لرحلة" }, href: "/travel", icon: "plane", image: 0 },
    { _id: ROW_B, label: { en: "Investor Licence", ar: "رخصة مستثمر" }, href: "/services", icon: "briefcase", image: 0 },
    { _id: ROW_C, label: { en: "Iqama", ar: "إقامة" }, href: "/iqama", icon: "id", image: 0 },
  ],
});

const set = (values: Record<string, unknown>, field: string, locale: "en" | "ar", text: string) => {
  const next = structuredClone(values);
  next[field] = { ...(next[field] as Record<string, unknown>), [locale]: text };
  return next;
};

const content = (blockType: string, before: Record<string, unknown>, after: Record<string, unknown>, sectionId = SECTION) => {
  const changes = diffContent(blockType, before, after);
  return { domain: "content" as const, sectionId, blockType, changes };
};

const styleDoc = (nodes: StyleDocument["nodes"]): StyleDocument => ({ v: 1, nodes });
const motionDoc = (section: MotionTarget = {}, nodes: Record<string, MotionTarget> = {}): MotionDocument => ({
  v: 1,
  section,
  nodes,
});

const structure = (...entries: (number | [number, boolean])[]): DraftStructure => ({
  v: 1,
  sections: entries.map((entry) =>
    Array.isArray(entry) ? { sectionId: entry[0], visible: entry[1] } : { sectionId: entry, visible: true },
  ),
});

/** Records one change at a moment, labelled the way the shell labels it. */
const push = (history: PageHistory, change: HistoryChange, at: number, held = false) =>
  record(history, change, `action at ${at}`, at, { held });

/** Undo the newest action against values, as the shell does for content. */
function undoContent(history: PageHistory, values: Record<string, unknown>) {
  const taken = takeUndo(history);
  assert.ok(taken, "there was nothing to undo");
  const change = taken.entry.change;
  assert.equal(change.domain, "content");
  const next = applyContent(values, change.domain === "content" ? change.changes : [], "undo");
  assert.ok(next, "the change named a row that is not there");
  return { history: taken.history, values: next, entry: taken.entry };
}

function redoContent(history: PageHistory, values: Record<string, unknown>) {
  const taken = takeRedo(history);
  assert.ok(taken, "there was nothing to redo");
  const change = taken.entry.change;
  assert.equal(change.domain, "content");
  const next = applyContent(values, change.domain === "content" ? change.changes : [], "redo");
  assert.ok(next, "the change named a row that is not there");
  return { history: taken.history, values: next, entry: taken.entry };
}

/* ========================================================================== */
/* Content                                                                    */
/* ========================================================================== */

describe("content: what an edit records, and what Undo and Redo put back", () => {
  test("1 · content edit undo — the field returns to exactly what it held", () => {
    const was = richText();
    const now = set(was, "title", "en", "Who we really are");
    const change = content("rich-text", was, now);
    assert.deepEqual(change.changes, [
      { path: { field: "title", locale: "en" }, before: "Who we are", after: "Who we really are" },
    ]);
    const history = record(emptyHistory(), change, describeContent("rich-text", change.changes, now, "en"), 1_000);
    assert.equal(history.undo.length, 1);
    assert.equal(history.undo[0]!.label, "Change Title (English)");

    const undone = undoContent(history, now);
    assert.deepEqual(undone.values, was);
    assert.equal(undone.history.undo.length, 0);
    assert.equal(undone.history.redo.length, 1);
  });

  test("2 · content redo — the undone edit comes back, and Undo is offered again", () => {
    const was = richText();
    const now = set(was, "title", "en", "Who we really are");
    const history = record(emptyHistory(), content("rich-text", was, now), "Change Title (English)", 1_000);
    const undone = undoContent(history, now);
    const redone = redoContent(undone.history, undone.values);
    assert.deepEqual(redone.values, now);
    assert.equal(redone.history.undo.length, 1);
    assert.equal(redone.history.redo.length, 0);
    assert.equal(redone.entry.id, history.undo[0]!.id, "Redo re-applies the same action, not a copy of it");
  });

  test("only what changed is recorded — never the section's other values", () => {
    const was = { ...richText(), body: { en: `<p>${"long ".repeat(4_000)}</p>`, ar: "<p>طويل</p>" } };
    const now = set(was, "title", "en", "Changed");
    const change = content("rich-text", was, now);
    const stored = JSON.stringify(record(emptyHistory(), change, "x", 1));
    assert.ok(!stored.includes("long long"), "the untouched body travelled into the history");
    assert.ok(stored.length < 600, `an entry for one title is ${stored.length} characters`);
  });

  test("5 · English localized undo leaves the Arabic edition alone", () => {
    const was = richText();
    const english = set(was, "title", "en", "Who we really are");
    const both = set(english, "title", "ar", "من نحن حقاً");
    let history = record(emptyHistory(), content("rich-text", was, english), "en", 1_000);
    history = closeGroup(history);
    history = record(history, content("rich-text", english, both), "ar", 1_100);

    // Undo the English edit only: take the Arabic one off first, keep it.
    const first = takeUndo(history)!;
    const second = takeUndo(first.history)!;
    const change = second.entry.change as Extract<HistoryChange, { domain: "content" }>;
    assert.deepEqual(change.changes[0]!.path, { field: "title", locale: "en" });
    const values = applyContent(both, change.changes, "undo")!;
    assert.deepEqual(values.title, { en: "Who we are", ar: "من نحن حقاً" });
  });

  test("6 · Arabic localized undo restores the Arabic text and nothing else", () => {
    const was = richText();
    const now = set(was, "title", "ar", "من نحن حقاً");
    const change = content("rich-text", was, now);
    assert.deepEqual(change.changes[0]!.path, { field: "title", locale: "ar" });
    const label = describeContent("rich-text", change.changes, now, "ar");
    assert.equal(label, "Change Title (Arabic)");
    const undone = undoContent(record(emptyHistory(), change, label, 1), now);
    assert.deepEqual(undone.values.title, { en: "Who we are", ar: "من نكون" });
    assert.deepEqual(undone.values.eyebrow, was.eyebrow);
  });

  test("7 · a language switch between actions: each Undo returns to its own edition", () => {
    // Edit English, switch the canvas to Arabic, edit Arabic, switch back to
    // English, then undo twice. The first Undo is the Arabic edit even though
    // English is on screen; the second is the English one.
    const was = richText();
    const english = set(was, "title", "en", "Who we really are");
    const arabic = set(english, "title", "ar", "من نحن حقاً");
    let history = record(
      emptyHistory(),
      content("rich-text", was, english),
      describeContent("rich-text", diffContent("rich-text", was, english), english, "en"),
      1_000,
    );
    history = record(
      history,
      content("rich-text", english, arabic),
      // The label is the edition that changed, whatever the editor is showing.
      describeContent("rich-text", diffContent("rich-text", english, arabic), arabic, "en"),
      9_000,
    );
    assert.deepEqual(
      history.undo.map((entry) => entry.label),
      ["Change Title (English)", "Change Title (Arabic)"],
    );
    const one = undoContent(history, arabic);
    assert.deepEqual(one.values.title, { en: "Who we really are", ar: "من نكون" });
    const two = undoContent(one.history, one.values);
    assert.deepEqual(two.values, was);
    // And Redo walks forward in the same order.
    const back = redoContent(two.history, two.values);
    assert.deepEqual(back.values.title, { en: "Who we really are", ar: "من نكون" });
  });

  test("a repeatable row is found by its _id, wherever it has moved to since", () => {
    const was = quickLinks();
    const relabelled = structuredClone(was);
    (relabelled.links as Record<string, unknown>[])[1]!.label = { en: "Investor licence (MISA)", ar: "رخصة مستثمر" };
    const change = content("quick-links", was, relabelled);
    assert.deepEqual(change.changes, [
      {
        path: { field: "links", itemId: ROW_B, sub: "label", locale: "en" },
        before: "Investor Licence",
        after: "Investor licence (MISA)",
      },
    ]);
    // The rows are then reordered by a later action: B is now first.
    const reordered = structuredClone(relabelled);
    const rows = reordered.links as Record<string, unknown>[];
    reordered.links = [rows[1], rows[0], rows[2]];
    const values = applyContent(reordered, change.changes, "undo")!;
    const links = values.links as Record<string, unknown>[];
    assert.equal(links[0]!._id, ROW_B, "the order the later action made is kept");
    assert.deepEqual(links[0]!.label, { en: "Investor Licence", ar: "رخصة مستثمر" });
    assert.deepEqual(links[1]!.label, (was.links as Record<string, unknown>[])[0]!.label);
  });

  test("a row that is no longer there refuses the change instead of guessing a position", () => {
    const was = quickLinks();
    const relabelled = structuredClone(was);
    (relabelled.links as Record<string, unknown>[])[2]!.href = "/residency";
    const change = content("quick-links", was, relabelled);
    const without = structuredClone(relabelled);
    without.links = (without.links as Record<string, unknown>[]).slice(0, 2);
    assert.equal(applyContent(without, change.changes, "undo"), null);
  });

  test("adding, removing and reordering rows are one list-sized action each", () => {
    const was = quickLinks();
    const added = structuredClone(was);
    (added.links as unknown[]).push({ _id: "i_dddddddddd", label: { en: "New", ar: "" }, href: "", icon: "", image: 0 });
    const addChange = content("quick-links", was, added);
    assert.equal(addChange.changes.length, 1);
    assert.deepEqual(addChange.changes[0]!.path, { field: "links" });
    assert.equal(describeContent("quick-links", addChange.changes, added, "en"), "Add a row to Links");
    assert.equal(groupOf(addChange), null, "a row added never merges with anything");
    assert.deepEqual(applyContent(added, addChange.changes, "undo"), was);

    const removed = structuredClone(was);
    removed.links = (removed.links as unknown[]).slice(1);
    assert.equal(
      describeContent("quick-links", diffContent("quick-links", was, removed), removed, "en"),
      "Remove a row from Links",
    );
    const reordered = structuredClone(was);
    reordered.links = [...(reordered.links as unknown[])].reverse();
    const reorder = diffContent("quick-links", was, reordered);
    assert.equal(describeContent("quick-links", reorder, reordered, "en"), "Reorder Links");
    assert.deepEqual(applyContent(reordered, reorder, "undo"), was);
  });
});

/* ========================================================================== */
/* Direct editing                                                             */
/* ========================================================================== */

describe("direct editing is recorded on the same buffer and the same history", () => {
  /** One direct-edit session as the shell sees it: keystroke by keystroke, then commit. */
  function session(history: PageHistory, start: Record<string, unknown>, texts: string[], at: number) {
    let values = start;
    let h = history;
    for (const [index, text] of texts.entries()) {
      const next = set(values, "title", "en", text);
      // The shell records each keystroke `held`: however long the pauses, the
      // session is one action until it ends.
      h = push(h, content("rich-text", values, next), at + index * 10_000, true);
      values = next;
    }
    return { history: closeGroup(h), values };
  }

  test("3 · direct-edit undo — the whole session is one action, whatever the pauses", () => {
    const was = richText();
    const edited = session(emptyHistory(), was, ["W", "Wh", "Who we", "Who we help"], 1_000);
    assert.equal(edited.history.undo.length, 1, "a session with long pauses is still one action");
    assert.equal(edited.history.open, null, "committing closes it");
    const undone = undoContent(edited.history, edited.values);
    assert.deepEqual(undone.values, was);
  });

  test("4 · direct-edit redo — and the next session is an action of its own", () => {
    const was = richText();
    const first = session(emptyHistory(), was, ["Who we help"], 1_000);
    const second = session(first.history, first.values, ["Who we help today"], 1_050);
    assert.equal(second.history.undo.length, 2, "a new session right after a commit does not merge");
    const undone = undoContent(second.history, second.values);
    assert.deepEqual((undone.values.title as Record<string, string>).en, "Who we help");
    const redone = redoContent(undone.history, undone.values);
    assert.deepEqual((redone.values.title as Record<string, string>).en, "Who we help today");
  });

  test("Escape puts the text back, and an action that changed nothing is not kept", () => {
    const was = richText();
    let h = push(emptyHistory(), content("rich-text", was, set(was, "title", "en", "Typo")), 1, true);
    // Cancel restores the original text through the same path.
    h = push(h, content("rich-text", set(was, "title", "en", "Typo"), was), 2, true);
    assert.equal(h.undo.length, 0);
  });

  test("the shell records a direct edit in the session's edition, held, and closes it on commit", () => {
    const onCanvasEdit = bodyOf(SHELL, "const onCanvasEdit = useCallback(");
    assert.match(onCanvasEdit, /diffContent\(held\.data\.blockType, held\.values, written\)/);
    assert.match(onCanvasEdit, /describeContent\(held\.data\.blockType, changes, written, verdict\.locale\)/);
    assert.match(onCanvasEdit, /\{ held: true \}/);
    assert.match(onCanvasEdit, /if \(edit\.phase !== "input"\) closeHistoryGroup\(\);/);
    // The very same buffer the inspector edits — there is no second one.
    assert.match(onCanvasEdit, /writeBuffers\(\(prev\) =>/);
  });

  test("an Undo back to the saved state redraws the canvas, because no save will", () => {
    // A direct edit undone before its autosave leaves nothing to save — and
    // the canvas would otherwise keep showing the text typed onto it.
    const step = bodyOf(SHELL, "const stepHistory = useCallback(");
    // Through the one redraw every write uses since Batch 23, selection kept.
    assert.match(
      step,
      /const after = buffersRef\.current\[change\.sectionId\];\s*if \(after && !isDirty\(after\) && after\.data\.pageId === pageRef\.current\) redrawTo\(keptSelection\(\)\);/,
    );
  });

  test("there is no DOM undo: no execCommand, and Undo refuses while a node is still being typed", () => {
    for (const file of [
      "src/components/admin/visual-editor/shell.tsx",
      "src/components/site/editor-bridge.tsx",
      "src/components/admin/visual-editor/canvas.tsx",
      "src/lib/visual-editor/history.ts",
    ]) {
      assert.ok(!/execCommand/.test(read(file)), `${file} reaches for execCommand`);
    }
    const step = bodyOf(SHELL, "const stepHistory = useCallback(");
    assert.match(step, /if \(editSession\.current\) \{\s*setHistoryNotice\(/);
  });
});

/* ========================================================================== */
/* Style and motion                                                           */
/* ========================================================================== */

describe("style and motion: the document before and after, with its breakpoint", () => {
  test("8 · Style undo returns the section's style document exactly", () => {
    const was = styleDoc({ root: { base: { background: "surface" } } });
    const now = styleDoc({ root: { base: { background: "ink-800" } } });
    const change: HistoryChange = { domain: "style", sectionId: SECTION, blockType: "rich-text", before: was, after: now };
    const label = describeStyle("rich-text", was, now, richText(), "en");
    assert.equal(label, "Change Background · Desktop · Rich text");
    const taken = takeUndo(record(emptyHistory(), change, label, 1))!;
    assert.equal(taken.entry.change.domain, "style");
    assert.deepEqual((taken.entry.change as { before: StyleDocument }).before, was);
    const again = takeRedo(taken.history)!;
    assert.deepEqual((again.entry.change as { after: StyleDocument }).after, now);
  });

  test("9 · a responsive branch undoes at its own width, whatever width is on screen", () => {
    const was = styleDoc({ "field:title": { base: { fontSize: "h2" } } });
    const now = styleDoc({ "field:title": { base: { fontSize: "h2" }, mobile: { fontSize: "h3" } } });
    const label = describeStyle("rich-text", was, now, richText(), "en");
    assert.equal(label, "Change Size · Mobile · Title");
    const change: HistoryChange = { domain: "style", sectionId: SECTION, blockType: "rich-text", before: was, after: now };
    const taken = takeUndo(record(emptyHistory(), change, label, 1))!;
    const restored = (taken.entry.change as { before: StyleDocument }).before;
    assert.deepEqual(restored.nodes["field:title"], { base: { fontSize: "h2" } }, "Desktop is untouched");
    assert.equal(restored.nodes["field:title"]!.mobile, undefined);
  });

  test("a reset is named as one, and is one action", () => {
    const was = styleDoc({ root: { tablet: { gap: 6 } } });
    const now = styleDoc({});
    assert.equal(describeStyle("rich-text", was, now, richText(), "en"), "Reset Gap · Tablet · Rich text");
    assert.equal(
      groupOf({ domain: "style", sectionId: SECTION, blockType: "rich-text", before: was, after: now }),
      null,
      "a reset never merges into a drag",
    );
  });

  const motionCase = (label: string, was: MotionDocument, now: MotionDocument, expected: string) =>
    test(label, () => {
      const change: HistoryChange = { domain: "motion", sectionId: SECTION, blockType: "rich-text", before: was, after: now };
      assert.equal(describeMotion("rich-text", was, now, richText(), "en"), expected);
      const history = record(emptyHistory(), change, expected, 1);
      const taken = takeUndo(history)!;
      assert.deepEqual((taken.entry.change as { before: MotionDocument }).before, was);
      const redone = takeRedo(taken.history)!;
      assert.deepEqual((redone.entry.change as { after: MotionDocument }).after, now);
      assert.equal(redone.history.undo.length, 1);
    });

  motionCase(
    "10 · Motion undo: an entrance choice goes back to the one before",
    motionDoc({ base: { entrance: "fade-up" } }),
    motionDoc({ base: { entrance: "blur" } }),
    "Change Entrance · Desktop · Rich text",
  );
  motionCase(
    "11 · Parallax undo",
    motionDoc({}, { "field:title": { base: { parallax: "subtle" } } }),
    motionDoc({}, { "field:title": { base: { parallax: "strong" } } }),
    "Change Parallax · Desktop · Title",
  );
  motionCase(
    "12 · Hover undo",
    motionDoc({}, { "field:body": { base: {} } }),
    motionDoc({}, { "field:body": { base: { hover: "lift" } } }),
    "Change Hover · Desktop · Body",
  );
  motionCase(
    "13 · Text Reveal undo",
    motionDoc({}, { "field:title": { base: { entrance: "fade-up" } } }),
    motionDoc({}, { "field:title": { base: { entrance: "fade-up", textReveal: "words" } } }),
    "Change Text reveal · Desktop · Title",
  );
  motionCase(
    "14 · a responsive Motion branch undoes at Tablet and leaves Desktop alone",
    motionDoc({ base: { entrance: "fade-up" } }),
    motionDoc({ base: { entrance: "fade-up" }, tablet: { entrance: "none" } }),
    "Change Entrance · Tablet · Rich text",
  );
});

/* ========================================================================== */
/* Grouping                                                                   */
/* ========================================================================== */

describe("grouping: an action is what a person did, not every render", () => {
  const gap = (value: number | undefined): StyleDocument =>
    styleDoc(value === undefined ? {} : { root: { mobile: { gap: value } } });
  const drag = (from: number | undefined, to: number): HistoryChange => ({
    domain: "style",
    sectionId: SECTION,
    blockType: "rich-text",
    before: gap(from),
    after: gap(to),
  });

  test("15 · slider grouping: one drag is one action, from its first value to its last", () => {
    let h = emptyHistory();
    // A held pointer: the drag lasts as long as it lasts.
    h = push(h, drag(undefined, 1), 0, true);
    h = push(h, drag(1, 2), 4_000, true);
    h = push(h, drag(2, 5), 9_000, true);
    assert.equal(h.undo.length, 1);
    const change = h.undo[0]!.change as { before: StyleDocument; after: StyleDocument };
    assert.deepEqual(change.before, gap(undefined));
    assert.deepEqual(change.after, gap(5));
    // Letting go closes it; the next drag of the same slider is another action.
    h = closeGroup(h);
    h = push(h, drag(5, 6), 9_100, true);
    assert.equal(h.undo.length, 2);
  });

  test("15 · keyboard steps on a slider group while they keep coming, and split on a pause", () => {
    let h = emptyHistory();
    h = push(h, drag(undefined, 1), 0);
    h = push(h, drag(1, 2), GROUP_IDLE_MS - 1);
    assert.equal(h.undo.length, 1);
    h = push(h, drag(2, 3), GROUP_IDLE_MS * 3);
    assert.equal(h.undo.length, 2, "a pause longer than GROUP_IDLE_MS starts a new action");
  });

  test("15 · the continuous controls are the inspectors' own sliders, no more and no fewer", () => {
    const style = read("src/components/admin/visual-editor/style-inspector.tsx");
    const spacing = /const SPACING = new Set<keyof StyleTokens>\(\[([\s\S]*?)\]\)/.exec(style)?.[1] ?? "";
    const sliders = new Set([
      ...[...spacing.matchAll(/"(\w+)"/g)].map((match) => match[1]!),
      // The two single-token range inputs.
      ...(/token === "opacity"\) \{[\s\S]*?type="range"/.test(style) ? ["opacity"] : []),
      ...(/token === "objectX" \|\| token === "objectY"\) \{[\s\S]*?type="range"/.test(style) ? ["objectX", "objectY"] : []),
    ]);
    assert.deepEqual([...CONTINUOUS_STYLE_TOKENS].sort(), [...sliders].sort());
    assert.equal((style.match(/type="range"/g) ?? []).length, 3, "a new style slider needs a place in the grouping");

    const motion = read("src/components/admin/visual-editor/motion-inspector.tsx");
    assert.equal((motion.match(/type="range"/g) ?? []).length, 1);
    assert.match(motion, /field === "delay" \? \(\s*<>\s*<input[\s\S]*?type="range"/);
    assert.deepEqual([...CONTINUOUS_MOTION_FIELDS], ["delay"]);
  });

  test("a menu choice never groups, even when made twice in a row", () => {
    const pick = (a: string | undefined, b: string): HistoryChange => ({
      domain: "style",
      sectionId: SECTION,
      blockType: "rich-text",
      before: styleDoc(a ? { root: { base: { background: a as "surface" } } } : {}),
      after: styleDoc({ root: { base: { background: b as "surface" } } }),
    });
    let h = push(emptyHistory(), pick(undefined, "surface"), 0);
    h = push(h, pick("surface", "ink-800"), 10);
    assert.equal(h.undo.length, 2);
    assert.equal(groupOf(pick("surface", "ink-800")), null);
  });

  test("16 · typing grouping: one burst in one field is one action", () => {
    const was = richText();
    let values = was;
    let h = emptyHistory();
    for (const [index, text] of ["W", "Wh", "Who", "Who a", "Who are"].entries()) {
      const next = set(values, "title", "en", text);
      h = push(h, content("rich-text", values, next), index * 200);
      values = next;
    }
    assert.equal(h.undo.length, 1);
    const change = h.undo[0]!.change as Extract<HistoryChange, { domain: "content" }>;
    assert.deepEqual(change.changes, [{ path: { field: "title", locale: "en" }, before: "Who we are", after: "Who are" }]);
  });

  test("16 · a pause, leaving the field, another field or another edition each start a new action", () => {
    const was = richText();
    const a = set(was, "title", "en", "A");
    const b = set(a, "title", "en", "AB");
    let h = push(emptyHistory(), content("rich-text", was, a), 0);
    h = push(h, content("rich-text", a, b), GROUP_IDLE_MS + 1);
    assert.equal(h.undo.length, 2, "a pause");

    h = push(emptyHistory(), content("rich-text", was, a), 0);
    h = closeGroup(h); // focusout
    h = push(h, content("rich-text", a, b), 10);
    assert.equal(h.undo.length, 2, "leaving the field");

    h = push(emptyHistory(), content("rich-text", was, a), 0);
    h = push(h, content("rich-text", a, set(a, "eyebrow", "en", "E")), 10);
    assert.equal(h.undo.length, 2, "another field");

    h = push(emptyHistory(), content("rich-text", was, a), 0);
    h = push(h, content("rich-text", a, set(a, "title", "ar", "ع")), 10);
    assert.equal(h.undo.length, 2, "another edition of the same field");

    h = push(emptyHistory(), content("rich-text", was, a), 0);
    h = push(h, content("rich-text", a, b, OTHER_SECTION), 10);
    assert.equal(h.undo.length, 2, "the same field of another section");
  });

  test("typing a word and deleting it again leaves nothing to undo", () => {
    const was = richText();
    const typed = set(was, "title", "en", "Who we are!");
    let h = push(emptyHistory(), content("rich-text", was, typed), 0);
    h = push(h, content("rich-text", typed, was), 100);
    assert.deepEqual(h.undo, []);
  });

  test("a select, a toggle, a media pick and a multi-field change stand alone", () => {
    const was = { eyebrow: { en: "", ar: "" }, title: { en: "", ar: "" }, body: { en: "", ar: "" }, image: 0, imageSide: "start" };
    const side = { ...was, imageSide: "end" };
    assert.equal(groupOf(content("image-text", was, side)), null);
    assert.equal(groupOf(content("image-text", was, { ...was, image: 12 })), null);
    const cta = { showWhatsapp: false };
    assert.equal(groupOf(content("final-cta", cta, { showWhatsapp: true })), null);
    const two = set(set(richText(), "title", "en", "x"), "eyebrow", "en", "y");
    assert.equal(groupOf(content("rich-text", richText(), two)), null);
    assert.equal(isNoop(content("rich-text", richText(), richText())), true);
  });
});

/* ========================================================================== */
/* Redo and divergence                                                        */
/* ========================================================================== */

describe("Redo, and a new action after Undo", () => {
  const titled = (text: string) => set(richText(), "title", "en", text);
  const step = (h: PageHistory, from: string, to: string, at: number) =>
    closeGroup(push(h, content("rich-text", titled(from), titled(to)), at));

  test("17 · Redo is cleared by a divergent edit: A → B → C, undo, D gives A → B → D", () => {
    let h = emptyHistory();
    h = step(h, "0", "A", 0);
    h = step(h, "A", "B", 10_000);
    h = step(h, "B", "C", 20_000);
    const undone = takeUndo(h)!;
    assert.equal(undone.history.redo.length, 1);
    h = step(undone.history, "B", "D", 30_000);
    assert.equal(h.redo.length, 0, "C is gone");
    assert.equal(takeRedo(h), null);
    const afters = h.undo.map((entry) => (entry.change as Extract<HistoryChange, { domain: "content" }>).changes[0]!.after);
    assert.deepEqual(afters, ["A", "B", "D"]);
  });

  test("an action that changes nothing does not clear Redo", () => {
    let h = step(emptyHistory(), "0", "A", 0);
    h = takeUndo(h)!.history;
    h = push(h, content("rich-text", titled("0"), titled("0")), 5);
    assert.equal(h.redo.length, 1);
  });
});

/* ========================================================================== */
/* The buffer: clean at the server's state, dirty anywhere else               */
/* ========================================================================== */

describe("a value Undo or Redo writes goes through the ordinary buffer rule", () => {
  type Entry = Parameters<typeof withDomainValue>[0] & { status: string };
  const saved = richText();
  const buffer = (over: Partial<Entry> = {}): Entry => ({
    data: { values: saved, styles: styleDoc({}), motionDocument: motionDoc() },
    values: saved,
    styles: styleDoc({}),
    motion: motionDoc(),
    contentDirty: false,
    styleDirty: false,
    motionDirty: false,
    status: "idle",
    statusDomain: null,
    message: undefined,
    ...over,
  });

  test("18 · Undo back to the server's baseline is clean — nothing pointless is saved", () => {
    const typed = set(saved, "title", "en", "Typed");
    const dirty = withDomainValue(buffer(), "content", typed);
    assert.equal(dirty.contentDirty, true);
    // Undo writes the earlier value back — the one the server holds.
    const undone = withDomainValue(dirty, "content", structuredClone(saved));
    assert.equal(undone.contentDirty, false);
    // Key order is not meaning.
    const reordered = { body: saved.body, title: saved.title, eyebrow: saved.eyebrow };
    assert.equal(withDomainValue(dirty, "content", reordered).contentDirty, false);
  });

  test("19 · Redo away from the baseline is dirty again, so the autosave carries it", () => {
    const typed = set(saved, "title", "en", "Typed");
    const redone = withDomainValue(buffer(), "content", typed);
    assert.equal(redone.contentDirty, true);
    const styled = withDomainValue(buffer(), "style", styleDoc({ root: { base: { gap: 3 } } }));
    assert.equal(styled.styleDirty, true);
    assert.equal(withDomainValue(styled, "style", styleDoc({})).styleDirty, false);
    const moved = withDomainValue(buffer(), "motion", motionDoc({ base: { entrance: "blur" } }));
    assert.equal(moved.motionDirty, true);
    assert.equal(withDomainValue(moved, "motion", motionDoc()).motionDirty, false);
  });

  test("20 · Undo after autosave: the server now holds the edit, so the earlier value is a change to save", () => {
    const typed = set(saved, "title", "en", "Typed");
    // Autosave succeeded: the buffer's baseline is the typed state.
    const afterSave = buffer({ data: { values: typed, styles: styleDoc({}), motionDocument: motionDoc() }, values: typed });
    const undone = withDomainValue(afterSave, "content", saved);
    assert.equal(undone.contentDirty, true, "the autosave must carry the undo to the server");
  });

  test("21 · Redo after autosave: back to what the server holds is clean again", () => {
    const typed = set(saved, "title", "en", "Typed");
    const afterSave = buffer({ data: { values: typed, styles: styleDoc({}), motionDocument: motionDoc() }, values: saved, contentDirty: true });
    assert.equal(withDomainValue(afterSave, "content", typed).contentDirty, false);
  });

  test("a conflict is never cleared by Undo — only Reload latest may say otherwise", () => {
    const conflicted = buffer({ status: "conflict", statusDomain: "content", message: "changed elsewhere" });
    const next = withDomainValue(conflicted, "content", set(saved, "title", "en", "x"));
    assert.equal(next.status, "conflict");
    assert.equal(next.statusDomain, "content");
    assert.equal(next.message, "changed elsewhere");
  });

  test("22 · Save now at an undone state saves it and keeps Redo: saving never touches the history", () => {
    const save = bodyOf(SHELL, "const save = useCallback(");
    assert.match(save, /void drainSection\(activeId\)/);
    assert.ok(!/History|record\(|takeUndo|takeRedo/.test(save), "Save now reaches into the history");
    const runSave = bodyOf(SHELL, "const runSave = useCallback(");
    assert.ok(!/resetHistory|recordChange|writeHistory/.test(runSave), "the save primitive reaches into the history");
    // And the value Undo writes is saved by the ordinary autosave — the same
    // debounce, queue and guard as typing — never by a path of its own.
    const step = bodyOf(SHELL, "const stepHistory = useCallback(");
    assert.match(step, /setDomainValue\(change\.sectionId, "content", values\)/);
    assert.match(step, /scheduleAutosave\(change\.sectionId\)/);
    assert.ok(!/saveSection|saveStyles|saveMotion|runSave\(/.test(step), "Undo saves by a route of its own");
  });

  test("there are no inverse server actions: Undo has no endpoint", () => {
    const actions = read("src/app/(backoffice)/admin/visual-editor/actions.ts");
    assert.ok(!/export async function \w*(?:[Uu]ndo|[Rr]edo|[Ii]nverse|[Rr]ollback)\w*/.test(actions));
    assert.ok(!/^["']use server["']/m.test(HISTORY_SOURCE));
    assert.ok(!/from "@\/lib\/db|from "react"|from "@\/app/.test(HISTORY_SOURCE), "the history reaches beyond pure data");
  });
});

/* ========================================================================== */
/* Layout                                                                     */
/* ========================================================================== */

describe("layout: each action is walked back with one of the structure service's own operations", () => {
  const change = (
    op: "add" | "duplicate" | "reorder" | "visibility" | "remove" | "restore",
    was: DraftStructure,
    now: DraftStructure,
    sectionId: number | null = null,
  ) => ({ domain: "structure" as const, op, sectionId, before: was, after: now });

  test("23 · structure reorder Undo is a reorder back to the order before", () => {
    const move = change("reorder", structure(1, 2, 3), structure(2, 1, 3), 1);
    assert.deepEqual(structureStep(move, "undo", structure(2, 1, 3)), { action: "reorder", order: [1, 2, 3] });
  });

  test("24 · structure reorder Redo is the same reorder again", () => {
    const move = change("reorder", structure(1, 2, 3), structure(2, 1, 3), 1);
    assert.deepEqual(structureStep(move, "redo", structure(1, 2, 3)), { action: "reorder", order: [2, 1, 3] });
  });

  test("25 · hide Undo shows the section again", () => {
    const hide = change("visibility", structure(1, 2), structure(1, [2, false]), 2);
    assert.deepEqual(structureStep(hide, "undo", structure(1, [2, false])), {
      action: "visibility",
      sectionId: 2,
      visible: true,
    });
    assert.deepEqual(structureStep(hide, "redo", structure(1, 2)), { action: "visibility", sectionId: 2, visible: false });
  });

  test("26 · show Undo hides it again", () => {
    const show = change("visibility", structure([1, false], 2), structure(1, 2), 1);
    assert.deepEqual(structureStep(show, "undo", structure(1, 2)), { action: "visibility", sectionId: 1, visible: false });
  });

  test("27 · add Undo removes the new section — the very row, which Redo can put back", () => {
    const add = change("add", structure(1, 2), structure(1, 9, 2), 9);
    assert.deepEqual(structureStep(add, "undo", structure(1, 9, 2)), { action: "remove", sectionId: 9 });
    assert.deepEqual(structureStep(add, "redo", structure(1, 2)), {
      action: "restore",
      sectionId: 9,
      beforeSectionId: 2,
      visible: true,
    });
    const atEnd = change("add", structure(1, 2), structure(1, 2, 9), 9);
    assert.deepEqual(structureStep(atEnd, "redo", structure(1, 2)), {
      action: "restore",
      sectionId: 9,
      beforeSectionId: null,
      visible: true,
    });
  });

  test("28 · duplicate Undo removes the copy, and Redo puts the same copy back beside its original", () => {
    const duplicate = change("duplicate", structure(1, 2, 3), structure(1, 2, 12, 3), 12);
    assert.deepEqual(structureStep(duplicate, "undo", structure(1, 2, 12, 3)), { action: "remove", sectionId: 12 });
    assert.deepEqual(structureStep(duplicate, "redo", structure(1, 2, 3)), {
      action: "restore",
      sectionId: 12,
      beforeSectionId: 3,
      visible: true,
    });
  });

  test("29 · remove Undo restores the section exactly where it was, and as it was — hidden stays hidden", () => {
    const remove = change("remove", structure(1, [2, false], 3), structure(1, 3), 2);
    assert.deepEqual(structureStep(remove, "undo", structure(1, 3)), {
      action: "restore",
      sectionId: 2,
      beforeSectionId: 3,
      visible: false,
    });
    assert.deepEqual(structureStep(remove, "redo", structure(1, [2, false], 3)), { action: "remove", sectionId: 2 });
  });

  test("30 · restore Undo removes it again", () => {
    const restore = change("restore", structure(1, 3), structure(1, 2, 3), 2);
    assert.deepEqual(structureStep(restore, "undo", structure(1, 2, 3)), { action: "remove", sectionId: 2 });
    assert.deepEqual(structureStep(restore, "redo", structure(1, 3)), {
      action: "restore",
      sectionId: 2,
      beforeSectionId: 3,
      visible: true,
    });
  });

  test("a layout that is not the one the action left behind is never replayed over", () => {
    const move = change("reorder", structure(1, 2, 3), structure(2, 1, 3), 1);
    assert.equal(structureStep(move, "undo", structure(3, 2, 1)), null, "reordered elsewhere");
    assert.equal(structureStep(move, "undo", structure(2, 1, [3, false])), null, "hidden elsewhere");
    assert.equal(structureStep(move, "undo", structure(2, 1)), null, "removed elsewhere");
    assert.equal(structureStep(move, "redo", structure(2, 1, 3)), null, "already redone");
    // A difference that is not one operation is refused rather than approximated.
    assert.equal(structureStep(change("reorder", structure(1, 2), structure([2, false], 1)), "undo", structure([2, false], 1)), null);
    assert.equal(structureStep(change("add", structure(1), structure(1, 2, 3)), "undo", structure(1, 2, 3)), null);
  });

  test("layout actions are labelled by what they did to which block", () => {
    assert.equal(describeStructure("reorder", "rich-text"), "Move Rich text");
    assert.equal(describeStructure("reorder", null), "Reorder sections");
    assert.equal(describeStructure("visibility", "faq", false), "Hide FAQ");
    assert.equal(describeStructure("visibility", "faq", true), "Show FAQ");
    assert.equal(describeStructure("add", "stats"), "Add Statistics");
    assert.equal(describeStructure("duplicate", "stats"), "Duplicate Statistics");
    assert.equal(describeStructure("remove", "stats"), "Remove Statistics");
    assert.equal(describeStructure("restore", "stats"), "Restore Statistics");
  });

  test("a layout step goes through the same structural request, guarded on the page revision", () => {
    const runLayoutStep = bodyOf(SHELL, "const runLayoutStep = useCallback(");
    for (const operation of ["reorderPageStructure", "setPageSectionVisibility", "removePageSection", "restorePageSection"]) {
      assert.match(runLayoutStep, new RegExp(`runStructural\\(\\s*${operation},`));
    }
    // An Undo moves through the history; it never records itself as a new
    // action — every one of the four passes `null` where an edit passes what
    // to record.
    assert.equal((runLayoutStep.match(/runStructural\(/g) ?? []).length, 4);
    assert.equal((runLayoutStep.match(/\bnull,\s*\)/g) ?? []).length, 4);
    assert.match(runLayoutStep, /form\.set\("placement", "1"\)/);
    assert.match(runLayoutStep, /form\.set\("beforeSectionId", step\.beforeSectionId === null \? "end" : String\(step\.beforeSectionId\)\)/);
    const runStructural = bodyOf(SHELL, "const runStructural = useCallback(");
    assert.match(runStructural, /form\.set\("expectedRevision", String\(structure\.revision\)\)/);
    assert.match(runStructural, /form\.set\("_csrf", csrf\)/);
  });
});

/* ========================================================================== */
/* When a history is thrown away                                              */
/* ========================================================================== */

describe("a history that no longer describes the page is thrown away, and the editor is told", () => {
  test("the reset sentence is the brief's own", () => {
    assert.equal(HISTORY_RESET.section, "Undo history was reset because this section changed elsewhere.");
    assert.match(HISTORY_RESET.layout, /^Undo history was reset because /);
    assert.match(HISTORY_RESET.failed, /^Undo history was reset because /);
  });

  test("31 · a section conflict on save resets the page's history", () => {
    const drain = bodyOf(SHELL, "const drainSection = useCallback(");
    assert.match(drain, /if \(result === "conflict"\) resetHistory\(entry\.data\.pageId, HISTORY_RESET\.section\);/);
    // And Undo itself refuses a section that is in conflict.
    const step = bodyOf(SHELL, "const stepHistory = useCallback(");
    assert.match(step, /if \(!buffer \|\| buffer\.status === "conflict"\) \{\s*resetHistory\(pageId, HISTORY_RESET\.section\);/);
    // A layout conflict does the same for the layout.
    const runStructural = bodyOf(SHELL, "const runStructural = useCallback(");
    assert.match(runStructural, /if \(result\.reason === "conflict"\) resetHistory\(page\.id, HISTORY_RESET\.layout\);/);
    assert.match(step, /if \(!step\) \{\s*resetHistory\(pageId, HISTORY_RESET\.layout\);/);
  });

  test("32 · Reload latest resets it — for a section and for the layout", () => {
    const takeLatest = bodyOf(SHELL, "const takeLatest = useCallback(");
    assert.match(takeLatest, /resetHistory\(held\.data\.pageId, HISTORY_RESET\.section\)/);
    const reloadLayout = bodyOf(SHELL, "const reloadLayout = useCallback(");
    assert.match(reloadLayout, /resetHistory\(page\.id, HISTORY_RESET\.layout\)/);
  });

  test("33–35 · Publish, Discard and a historical Restore clear the history before anything is re-read", () => {
    const after = bodyOf(SHELL, "const afterPageAction = useCallback(");
    const reset = after.indexOf("resetHistory(pageId, historyNotice)");
    assert.ok(reset > 0, "a page action does not reset the history");
    assert.ok(reset < after.indexOf("writeBuffers("), "the history outlives the buffers it describes");
    const run = bodyOf(SHELL, "const runPageAction = useCallback(");
    assert.match(run, /await afterPageAction\(keepSelection, historyNotice\)/);
    // Only after success: a refused publish keeps the history.
    assert.ok(run.indexOf("if (!answer.ok)") < run.indexOf("await afterPageAction("));

    const publish = bodyOf(SHELL, "const publishPage = useCallback(");
    assert.match(publish, /publishPageFromEditor,[\s\S]*"Undo history was cleared: this page was published\./);
    const discard = bodyOf(SHELL, "const discardPage = useCallback(");
    assert.match(discard, /discardPageFromEditor,[\s\S]*"Undo history was cleared: the saved changes were discarded, and Redo cannot bring them back\."/);
    const restore = bodyOf(SHELL, "const restoreVersion = useCallback(");
    assert.match(restore, /restoreVersionFromEditor,[\s\S]*"Undo history was cleared: a version was restored into saved changes\./);
  });

  test("discarding the layout clears it too — the deleted rows are not something Undo can bring back", () => {
    const ops = bodyOf(SHELL, "const ops: StructuralOps = useMemo(");
    assert.match(ops, /runStructural\(discardPageLayout, \(\) => undefined, "clear", null\)\.then\(\(result\) => \{\s*if \(result\?\.ok && page\) \{\s*resetHistory\(page\.id,/);
  });

  test("a global change (menus, contact settings) leaves the history alone", () => {
    const global = bodyOf(SHELL, "const afterGlobalChange = useCallback(");
    assert.ok(!/resetHistory|recordChange/.test(global));
  });
});

/* ========================================================================== */
/* Pages, and the bound                                                       */
/* ========================================================================== */

describe("one history per page, bounded", () => {
  test("36 · page isolation: actions are recorded on the page they were taken on", () => {
    const histories = new Map<number, PageHistory>();
    const home = 1;
    const about = 2;
    histories.set(home, record(emptyHistory(), content("rich-text", richText(), set(richText(), "title", "en", "Home")), "home", 1));
    histories.set(about, record(emptyHistory(), content("rich-text", richText(), set(richText(), "title", "en", "About")), "about", 2));
    const undoneAbout = takeUndo(histories.get(about)!)!;
    histories.set(about, undoneAbout.history);
    assert.equal(histories.get(home)!.undo.length, 1, "Undo on About reached into Home");
    assert.equal(undoneAbout.entry.label, "about");

    // The shell keys every record, reset and step by page id.
    assert.match(SHELL, /const historiesRef = useRef<Map<number, PageHistory>>\(new Map\(\)\);/);
    const step = bodyOf(SHELL, "const stepHistory = useCallback(");
    assert.match(step, /const pageId = page\.id;/);
    assert.match(step, /closeGroup\(historyOf\(pageId\)\)/);
    const onValues = bodyOf(SHELL, "const onValues = useCallback(");
    assert.match(onValues, /recordChange\(\s*held\.data\.pageId,/);
  });

  test("36 · at most HISTORY_PAGES pages keep a history; the least recently used goes first", () => {
    assert.equal(HISTORY_PAGES, 10);
    const map = new Map<number, string>();
    const order: number[] = [];
    for (let id = 1; id <= 12; id += 1) {
      map.set(id, `page ${id}`);
      order.push(id);
    }
    const bounded = boundPages(map, order);
    assert.deepEqual(bounded.order, [3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    assert.equal(bounded.histories.has(1), false);
    assert.equal(bounded.histories.has(2), false);
    assert.equal(bounded.histories.get(12), "page 12");
    const small = boundPages(new Map([[1, "a"]]), [1]);
    assert.equal(small.histories.size, 1);
  });

  test("37 · max history bound: 100 actions per page, the oldest dropped first", () => {
    assert.equal(HISTORY_LIMIT, 100);
    let h = emptyHistory();
    for (let index = 0; index < 150; index += 1) {
      h = closeGroup(
        record(
          h,
          content("rich-text", set(richText(), "title", "en", `v${index}`), set(richText(), "title", "en", `v${index + 1}`)),
          `step ${index}`,
          index,
        ),
      );
    }
    assert.equal(h.undo.length, HISTORY_LIMIT);
    assert.equal(h.undo[0]!.label, "step 50");
    assert.equal(h.undo[HISTORY_LIMIT - 1]!.label, "step 149");
    const ids = h.undo.map((entry) => entry.id);
    assert.deepEqual(ids, [...ids].sort((a, b) => a - b), "entries keep their order");
    // Undo can walk all 100 back, and no further.
    let walked = 0;
    let at: PageHistory = h;
    for (;;) {
      const taken = takeUndo(at);
      if (!taken) break;
      at = taken.history;
      walked += 1;
    }
    assert.equal(walked, HISTORY_LIMIT);
    assert.equal(at.redo.length, HISTORY_LIMIT);
  });

  test("37 · memory for 100 actions on a large page stays small, because entries hold patches", (t) => {
    // A deliberately heavy section: a 20 KB body, a style document with 24
    // styled nodes at three widths, and a motion document with 24 targets.
    const body = `<p>${"Elite One Desk handles licences, visas and travel for investors. ".repeat(300)}</p>`;
    const big = { ...richText(), body: { en: body, ar: body } };
    const heavyStyle = (gap: number): StyleDocument =>
      styleDoc(
        Object.fromEntries(
          Array.from({ length: 24 }, (_, index) => [
            `field:links/item:i_${String(index).padStart(10, "a")}/field:label`,
            {
              base: { gap, padBlock: 3, padInline: 4, background: "surface", radius: "md", border: "line", shadow: "soft" },
              tablet: { gap: 2, padBlock: 2 },
              mobile: { gap: 1, padBlock: 1, hidden: true },
            },
          ]),
        ) as StyleDocument["nodes"],
      );
    const heavyMotion = (delay: number): MotionDocument =>
      motionDoc(
        { base: { entrance: "blur", duration: "slow", delay } },
        Object.fromEntries(
          Array.from({ length: 24 }, (_, index) => [
            `field:links/item:i_${String(index).padStart(10, "b")}/field:label`,
            { base: { entrance: "fade-up", hover: "lift", parallax: "subtle" }, mobile: { entrance: "none" } },
          ]),
        ),
      );

    let h = emptyHistory();
    let values: Record<string, unknown> = big;
    for (let index = 0; index < 100; index += 1) {
      let change: HistoryChange;
      if (index % 3 === 0) {
        const next = set(values, "title", "en", `Title ${index}`);
        change = content("rich-text", values, next);
        values = next;
      } else if (index % 3 === 1) {
        change = { domain: "style", sectionId: SECTION, blockType: "quick-links", before: heavyStyle(index), after: heavyStyle(index + 1) };
      } else {
        change = { domain: "motion", sectionId: SECTION, blockType: "quick-links", before: heavyMotion(index), after: heavyMotion(index + 1) };
      }
      h = closeGroup(record(h, change, `action ${index}`, index * 10_000));
    }
    assert.equal(h.undo.length, 100);
    const bytes = Buffer.byteLength(JSON.stringify(h), "utf8");
    const perAction = Math.round(bytes / 100);
    t.diagnostic(`100 actions on a heavy page: ${bytes} bytes serialised (${perAction} bytes per action)`);
    // The 40 KB of body text is never copied: a title edit stores two titles.
    assert.ok(!JSON.stringify(h).includes("Elite One Desk handles"), "an entry copied the untouched body");
    assert.ok(bytes < 2_000_000, `100 actions took ${bytes} bytes`);

    // And a typical session for comparison: 100 separate edits to headings
    // and short fields, the kind of work most pages see.
    let typical = emptyHistory();
    let plain = richText();
    for (let index = 0; index < 100; index += 1) {
      const field = index % 2 ? "title" : "eyebrow";
      const next = set(plain, field, index % 3 ? "en" : "ar", `${field} edit number ${index}`);
      typical = closeGroup(record(typical, content("rich-text", plain, next), `edit ${index}`, index * 10_000));
      plain = next;
    }
    const typicalBytes = Buffer.byteLength(JSON.stringify(typical), "utf8");
    t.diagnostic(`100 typical text edits: ${typicalBytes} bytes serialised (${Math.round(typicalBytes / 100)} bytes per action)`);
    assert.ok(typicalBytes < 100_000, `100 typical edits took ${typicalBytes} bytes`);

    // Entries are plain data — no functions, no DOM, nothing that is application state.
    const round = JSON.parse(JSON.stringify(h)) as PageHistory;
    assert.deepEqual(round, h);
    for (const entry of h.undo) assert.deepEqual(Object.keys(entry).sort(), ["change", "group", "id", "label"]);
  });
});

/* ========================================================================== */
/* The keyboard                                                               */
/* ========================================================================== */

describe("shortcuts: the editor's keys, except where a text field owns them", () => {
  const key = (over: Partial<Parameters<typeof shortcutFor>[0]>) =>
    shortcutFor({ key: "z", ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...over });

  test("38 · shortcuts: Ctrl/⌘+Z is Undo; Ctrl/⌘+Shift+Z and Ctrl+Y are Redo", () => {
    assert.equal(key({ ctrlKey: true }), "undo");
    assert.equal(key({ metaKey: true }), "undo");
    assert.equal(key({ ctrlKey: true, shiftKey: true, key: "Z" }), "redo");
    assert.equal(key({ metaKey: true, shiftKey: true, key: "Z" }), "redo");
    assert.equal(key({ ctrlKey: true, key: "y" }), "redo");
    assert.equal(key({ metaKey: true, key: "y" }), null, "⌘Y is not Redo on a Mac");
    assert.equal(key({ ctrlKey: true, shiftKey: true, key: "y" }), null);
    assert.equal(key({ ctrlKey: true, altKey: true }), null, "Alt anything is somebody else's shortcut");
    assert.equal(key({}), null, "a bare Z is typing");
    assert.equal(key({ ctrlKey: true, key: "x" }), null);
  });

  test("39 · focused form fields are not hijacked: inputs, text areas, selects and editable nodes keep the key", () => {
    class FakeElement {
      constructor(
        readonly tag: string,
        readonly attributes: Record<string, string> = {},
        readonly parent: FakeElement | null = null,
      ) {}
      get isContentEditable(): boolean {
        return "contenteditable" in this.attributes || Boolean(this.parent?.isContentEditable);
      }
      closest(selector: string): FakeElement | null {
        const wanted = selector.split(",").map((part) => part.trim());
        const matches = (element: FakeElement) =>
          wanted.some((one) => (one === "[contenteditable]" ? "contenteditable" in element.attributes : one === element.tag));
        if (matches(this)) return this;
        return this.parent ? this.parent.closest(selector) : null;
      }
    }
    const scope = globalThis as unknown as { HTMLElement?: unknown };
    const had = "HTMLElement" in scope;
    const previous = scope.HTMLElement;
    scope.HTMLElement = FakeElement;
    try {
      assert.equal(isTextTarget(new FakeElement("input") as unknown as EventTarget), true);
      assert.equal(isTextTarget(new FakeElement("textarea") as unknown as EventTarget), true);
      assert.equal(isTextTarget(new FakeElement("select") as unknown as EventTarget), true);
      const editable = new FakeElement("div", { contenteditable: "true" });
      assert.equal(isTextTarget(new FakeElement("span", {}, editable) as unknown as EventTarget), true);
      assert.equal(isTextTarget(new FakeElement("button") as unknown as EventTarget), false);
      assert.equal(isTextTarget(new FakeElement("div") as unknown as EventTarget), false);
      assert.equal(isTextTarget(null), false);
      assert.equal(isTextTarget({} as EventTarget), false, "a window or document is not a text field");
    } finally {
      if (had) scope.HTMLElement = previous;
      else delete scope.HTMLElement;
    }
  });

  test("39 · the editor's own listener steps aside for a text field before it prevents anything", () => {
    const effect = SHELL.slice(SHELL.indexOf("const onKey = (event: KeyboardEvent) => {"));
    const onKey = effect.slice(0, effect.indexOf("const onPointerDown"));
    assert.match(onKey, /const command = shortcutFor\(event\);\s*if \(!command \|\| isTextTarget\(event\.target\)\) return;\s*event\.preventDefault\(\);/);
    // Leaving a field and letting go of a slider are what close an action.
    assert.match(effect, /if \(isTextTarget\(event\.target\)\) closeHistoryGroup\(\);/);
    assert.match(effect, /event\.target instanceof HTMLInputElement && event\.target\.type === "range"/);
  });

  test("the canvas forwards the keys only when nothing on it is being typed into", () => {
    const listener = BRIDGE.slice(BRIDGE.indexOf("const onShortcutKey = (event: KeyboardEvent) => {"));
    const body = listener.slice(0, listener.indexOf("};") + 2);
    assert.match(body, /if \(editing\) return;\s*const command = shortcutFor\(event\);\s*if \(!command \|\| isTextTarget\(event\.target\)\) return;\s*event\.preventDefault\(\);\s*post\(\{ type: "canvas\.shortcut", command \}\);/);
    assert.match(BRIDGE, /document\.addEventListener\("keydown", onShortcutKey\);/);
    assert.match(BRIDGE, /document\.removeEventListener\("keydown", onShortcutKey\);/);
    assert.match(CANVAS, /case "canvas\.shortcut":\s*onShortcut\(message\.command\);/);
    assert.match(SHELL, /onShortcut=\{onShortcut\}/);
  });

  test("the forwarded key is one word from a closed list, since protocol version 6", () => {
    const bridgeId = "0123456789abcdef0123456789abcdef";
    // Introduced in 6 (Batch 16); 7 (Batch 21) left the shortcut unchanged.
    assert.equal(PROTOCOL_VERSION, 7);
    assert.deepEqual([...SHORTCUT_COMMANDS], ["undo", "redo"]);
    for (const command of SHORTCUT_COMMANDS) {
      assert.deepEqual(
        readCanvasMessage(envelope(bridgeId, { type: "canvas.shortcut", command, script: "alert(1)" }), { bridgeId }),
        { type: "canvas.shortcut", command },
      );
    }
    for (const command of ["delete", "publish", "", 1, null, undefined]) {
      assert.equal(readCanvasMessage(envelope(bridgeId, { type: "canvas.shortcut", command }), { bridgeId }), null);
    }
    const old = { ...envelope(bridgeId, { type: "canvas.shortcut", command: "undo" }), v: 5 };
    assert.equal(readCanvasMessage(old, { bridgeId }), null);
  });
});

/* ========================================================================== */
/* The toolbar                                                                */
/* ========================================================================== */

describe("the toolbar says what Undo would do, and what it is for", () => {
  test("named buttons with a disabled state, a title, the shortcut and the action's own label", () => {
    assert.match(SHELL, /aria-label=\{nextUndo \? `Undo: \$\{nextUndo\.label\}` : "Undo — nothing to undo"\}/);
    assert.match(SHELL, /aria-label=\{nextRedo \? `Redo: \$\{nextRedo\.label\}` : "Redo — nothing to redo"\}/);
    assert.match(SHELL, /disabled=\{!historyIdle \|\| !nextUndo\}/);
    assert.match(SHELL, /disabled=\{!historyIdle \|\| !nextRedo\}/);
    assert.match(SHELL, /aria-keyshortcuts="Control\+Z Meta\+Z"/);
    assert.match(SHELL, /aria-keyshortcuts="Control\+Shift\+Z Meta\+Shift\+Z Control\+Y"/);
    assert.match(SHELL, /\(Ctrl\+Z \/ ⌘Z\)/);
    assert.match(SHELL, /\(Ctrl\+Shift\+Z \/ ⇧⌘Z\)/);
    assert.match(SHELL, /role="group" aria-label="Undo and redo"/);
    assert.match(SHELL, /aria-describedby="ve-undo-scope"/);
    assert.match(SHELL, /role="status"\s*data-history-notice/);
  });

  test("Undo is told apart from Version History in the brief's words, in both places it is offered", () => {
    assert.equal(
      UNDO_SCOPE_NOTE,
      "Undo and Redo affect your current editing session. Version History lets you review or restore earlier published page states.",
    );
    assert.match(SHELL, /<span id="ve-undo-scope" className="sr-only">\s*\{UNDO_SCOPE_NOTE\}/);
    assert.match(code(read("src/components/admin/visual-editor/page-panel.tsx")), /\{UNDO_SCOPE_NOTE\}/);
  });
});

/* A test that mutates a global puts it back; this makes sure nothing leaked. */
let hadHtmlElement = false;
before(() => {
  hadHtmlElement = "HTMLElement" in globalThis;
});
after(() => {
  assert.equal("HTMLElement" in globalThis, hadHtmlElement);
});
