/**
 * What the canvas is allowed to show, decided without a database.
 *
 * Preview is the one place where the site renders something a visitor cannot
 * see, so the rules about *which* sections it renders are worth pinning down on
 * their own. The subtle ones: a section omitted from a structural draft is a
 * pending deletion rather than an oversight, one marked hidden is still shown to
 * the editor, a draft-only row appears exactly where the draft says, and an id
 * belonging to another page is not a section of this one however the document
 * asks.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { composePreview, composePublished, type CompositionRow } from "@/lib/cms/composition";
import {
  DRAFT_STRUCTURE_VERSION,
  readDraftStructure,
  validateDraftStructure,
} from "@/lib/cms/structure";

const row = (
  id: number,
  blockType: string,
  extra: Partial<CompositionRow> = {},
): CompositionRow => ({
  id,
  blockType,
  animation: "fade-up",
  published: { title: { en: blockType, ar: "" } },
  draft: null,
  styles: null,
  draftStyles: null,
  isPublished: true,
  isDraftOnly: false,
  ...extra,
});

/** A B C, in position order, as the database hands them over. */
const A = row(1, "hero");
const B = row(2, "process");
const C = row(3, "faq");
const LIVE = [A, B, C];

const structure = (...ids: Array<number | [number, boolean]>) =>
  validateDraftStructure({
    v: DRAFT_STRUCTURE_VERSION,
    sections: ids.map((entry) =>
      Array.isArray(entry)
        ? { sectionId: entry[0], visible: entry[1] }
        : { sectionId: entry, visible: true },
    ),
  });

const ids = (sections: { id: number }[]) => sections.map((section) => section.id);

/* -------------------------------------------------------------------------- */

describe("a structural draft is read, or safely ignored", () => {
  test("no column at all means no structural draft", () => {
    assert.equal(readDraftStructure(null), null);
    assert.equal(readDraftStructure(undefined), null);
  });

  test("an empty list is a document, not an absence — and they mean opposite things", () => {
    // `{ sections: [] }` is an editor saying "publishing this leaves the page
    // with nothing on it". Absence is "nobody has restructured this page".
    // Collapsing the two would blank a page whose JSON merely went missing.
    const empty = readDraftStructure({ v: 1, sections: [] });
    assert.deepEqual(empty, { v: DRAFT_STRUCTURE_VERSION, sections: [] });
    assert.notEqual(empty, null);
    assert.deepEqual(composePreview(LIVE, empty), []);
    assert.deepEqual(ids(composePreview(LIVE, null)), [1, 2, 3]);
  });

  test("anything this build cannot act on reads as no draft, and never throws", () => {
    for (const corrupt of [
      "{}",
      42,
      [],
      {},
      { sections: [{ sectionId: 1 }] },
      { v: 0, sections: [] },
      { v: 1.5, sections: [] },
      { v: "1", sections: [] },
      { v: DRAFT_STRUCTURE_VERSION + 1, sections: [{ sectionId: 1 }] },
      { v: 1, sections: "all of them" },
      { v: 1, sections: {} },
    ]) {
      assert.equal(readDraftStructure(corrupt), null, JSON.stringify(corrupt));
      // And the page still renders, as it stands, rather than disappearing.
      assert.deepEqual(ids(composePreview(LIVE, readDraftStructure(corrupt))), [1, 2, 3]);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("the published composition", () => {
  test("visible, established sections in position order", () => {
    const rows = [A, row(2, "process", { isPublished: false }), C];
    assert.deepEqual(ids(composePublished(rows)), [1, 3]);
  });

  test("a draft-only row is not part of the published page", () => {
    const rows = [A, row(9, "rich-text", { isDraftOnly: true, isPublished: true })];
    assert.deepEqual(ids(composePublished(rows)), [1], "a pending section reached the live site");
  });

  test("published values, never drafts", () => {
    const rows = [row(1, "hero", { draft: { title: { en: "DRAFT", ar: "" } } })];
    const [section] = composePublished(rows);
    assert.deepEqual(section!.values, { title: { en: "hero", ar: "" } });
    assert.equal(section!.isDraft, false);
  });

  test("a structural draft cannot reach it — there is nowhere to pass one", () => {
    assert.equal(composePublished.length, 1);
  });
});

/* -------------------------------------------------------------------------- */

describe("the preview composition", () => {
  test("with no structural draft it behaves exactly as it always has", () => {
    const rows = [A, row(2, "process", { isPublished: false }), C];
    const sections = composePreview(rows, null);
    assert.deepEqual(ids(sections), [1, 2, 3], "hidden sections belong in preview");
  });

  test("drafts win over published values, and say so", () => {
    const rows = [row(1, "hero", { draft: { title: { en: "DRAFT", ar: "" } } }), B];
    const [first, second] = composePreview(rows, null);
    assert.deepEqual(first!.values, { title: { en: "DRAFT", ar: "" } });
    assert.equal(first!.isDraft, true);
    assert.equal(second!.isDraft, false);
  });

  test("the draft order is the canvas order", () => {
    assert.deepEqual(ids(composePreview(LIVE, structure(3, 1, 2))), [3, 1, 2]);
  });

  test("a section the draft omits is a pending deletion and is not rendered", () => {
    assert.deepEqual(ids(composePreview(LIVE, structure(1, 3))), [1, 3]);
  });

  test("a section the draft hides is still shown, because the editor has to reach it", () => {
    const sections = composePreview(LIVE, structure(1, [2, false], 3));
    assert.deepEqual(ids(sections), [1, 2, 3], "a hidden section became uneditable");
  });

  test("a draft-only section appears where the draft names it", () => {
    const restored = row(9, "rich-text", { isDraftOnly: true, isPublished: false });
    const rows = [A, B, C, restored];
    // Restored rows are appended to the page but belong in the middle.
    assert.deepEqual(ids(composePreview(rows, structure(1, 9, 2, 3))), [1, 9, 2, 3]);
  });

  test("an id this page does not own is never rendered", () => {
    const foreign = 4242;
    const sections = composePreview(LIVE, structure(1, foreign, 3));
    assert.deepEqual(ids(sections), [1, 3]);
    assert.ok(!sections.some((section) => section.id === foreign));
  });

  test("a section named twice is rendered once", () => {
    assert.deepEqual(ids(composePreview(LIVE, structure(1, 1, 2))), [1, 2]);
  });

  test("a draft naming nothing this page owns renders nothing, and does not throw", () => {
    assert.deepEqual(composePreview(LIVE, structure(98, 99)), []);
  });
});
