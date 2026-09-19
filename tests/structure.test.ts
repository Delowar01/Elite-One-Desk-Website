/**
 * The layout document, and what copying a section does to identity.
 *
 * Both are decided without a database, and both are the kind of rule that is
 * cheaper to pin down here than to discover on a page: what a stored structure
 * can and cannot say, and what a duplicate is allowed to share with the section
 * it came from.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatNodePath, parseNodePath } from "@/lib/cms/address";
import { remapStyleItemIds, withFreshItemIds } from "@/lib/cms/duplicate";
import { ITEM_ID_KEY, isItemId } from "@/lib/cms/item-id";
import { validateStyleDocument, type StyleDocument } from "@/lib/cms/styles";
import {
  DRAFT_STRUCTURE_VERSION,
  entryFor,
  normalizeDraftStructureForPage,
  pendingRemovals,
  readDraftStructure,
  readVisibility,
  removedSections,
  validateDraftStructure,
  type PageStructure,
} from "@/lib/cms/structure";

const doc = (...entries: Array<number | [number, boolean]>) => ({
  v: DRAFT_STRUCTURE_VERSION,
  sections: entries.map((entry) =>
    Array.isArray(entry) ? { sectionId: entry[0], visible: entry[1] } : { sectionId: entry, visible: true },
  ),
});

/* -------------------------------------------------------------------------- */

describe("a layout document says only what it is allowed to say", () => {
  test("an empty list is valid, and is not the same answer as a malformed one", () => {
    assert.deepEqual(validateDraftStructure({ v: 1, sections: [] }), { v: 1, sections: [] });
    // The distinction the whole preview fallback rests on: an empty document is
    // "publishing this leaves no sections"; an unreadable column is "do not act
    // on this", and the caller shows the established page instead.
    assert.deepEqual(readDraftStructure({ v: 1, sections: [] }), { v: 1, sections: [] });
    assert.equal(readDraftStructure({ v: 1, sections: "nope" }), null);
    assert.equal(readDraftStructure(null), null);
    assert.equal(readDraftStructure(undefined), null);
  });

  test("a repeated id keeps its first appearance — a section is in one place", () => {
    assert.deepEqual(validateDraftStructure(doc(1, 2, 1)).sections.map((e) => e.sectionId), [1, 2]);
    assert.deepEqual(validateDraftStructure(doc([1, false], [1, true])).sections, [
      { sectionId: 1, visible: false },
    ]);
  });

  test("an id that is not an id takes its entry with it", () => {
    const parsed = validateDraftStructure({
      v: 1,
      sections: [
        { sectionId: 1 },
        { sectionId: 0 },
        { sectionId: -4 },
        { sectionId: 1.5 },
        { sectionId: "2" },
        { sectionId: null },
        { sectionId: 3e12 },
        {},
        "nope",
        null,
        { sectionId: 4, visible: false },
      ],
    });
    assert.deepEqual(parsed.sections, [
      { sectionId: 1, visible: true },
      { sectionId: 4, visible: false },
    ]);
  });

  test("a malformed `visible` reads as shown, never as removed", () => {
    // Dropping the entry would mean "delete this on publish", which is not
    // something a typo should be able to say.
    for (const visible of [undefined, null, "false", 0, 1, {}, []]) {
      const [entry] = validateDraftStructure({ v: 1, sections: [{ sectionId: 7, visible }] }).sections;
      assert.equal(entry?.visible, true, JSON.stringify(visible));
    }
    assert.equal(validateDraftStructure(doc([7, false])).sections[0]?.visible, false);
  });

  test("a version this build does not understand is not acted on", () => {
    assert.equal(readDraftStructure({ v: 2, sections: [{ sectionId: 1 }] }), null);
    assert.equal(readDraftStructure({ v: 0, sections: [] }), null);
    assert.equal(readDraftStructure({ sections: [] }), null);
    assert.deepEqual(validateDraftStructure({ v: 2, sections: [{ sectionId: 1 }] }).sections, []);
  });

  test("an id the page does not own is dropped, whatever the document claims", () => {
    const structure = normalizeDraftStructureForPage(doc(1, 99, 2), [1, 2, 3], {
      keepOmitted: false,
    });
    assert.deepEqual(structure.sections.map((e) => e.sectionId), [1, 2]);
  });

  test("omission is kept when the caller means it, and filled when it does not", () => {
    // The editors pass `keepOmitted: false`: an omission is a pending removal
    // and putting it back would make the operation a no-op.
    const deliberate = normalizeDraftStructureForPage(doc(1), [1, 2, 3], { keepOmitted: false });
    assert.deepEqual(deliberate.sections.map((e) => e.sectionId), [1]);
    assert.deepEqual(pendingRemovals(deliberate, [1, 2, 3]), [2, 3]);

    const forgiving = normalizeDraftStructureForPage(doc(1), [1, 2, 3]);
    assert.deepEqual(forgiving.sections.map((e) => e.sectionId), [1, 2, 3]);
  });

  test("a hidden established entry and a pending entry are both ordinary entries", () => {
    const structure = normalizeDraftStructureForPage(doc([1, false], 9), [1, 9], {
      keepOmitted: false,
    });
    assert.deepEqual(structure.sections, [
      { sectionId: 1, visible: false },
      { sectionId: 9, visible: true },
    ]);
  });
});

/* -------------------------------------------------------------------------- */

describe("what a page's editors read off a structure", () => {
  const page: PageStructure = {
    pageId: 4,
    slug: "about",
    title: "About",
    revision: 6,
    hasDraftStructure: true,
    structure: doc(1, [2, false]),
    sections: [
      { sectionId: 1, blockType: "hero", blockName: "Hero", summary: "One", isDraftOnly: false, publishedPosition: 0, publishedVisible: true },
      { sectionId: 2, blockType: "faq", blockName: "FAQ", summary: "Two", isDraftOnly: false, publishedPosition: 1, publishedVisible: true },
      { sectionId: 3, blockType: "stats", blockName: "Stats", summary: "Three", isDraftOnly: false, publishedPosition: 2, publishedVisible: true },
    ],
  };

  test("the sections the layout leaves out are the pending removals", () => {
    assert.deepEqual(removedSections(page).map((s) => s.sectionId), [3]);
  });

  test("nothing is removed when the layout holds everything", () => {
    assert.deepEqual(removedSections({ ...page, structure: doc(1, 2, 3) }), []);
  });

  test("an entry says what publishing intends for one section", () => {
    assert.deepEqual(entryFor(page, 2), { sectionId: 2, visible: false });
    assert.equal(entryFor(page, 3), null, "a removed section has no intent");
  });
});

/* -------------------------------------------------------------------------- */

describe("a duplicated section is a different thing, all the way down", () => {
  /**
   * The choice this makes, and the reason it is worth code: the copy's
   * repeatable rows get **fresh ids**, and the style document is remapped onto
   * them in the same pass. Keeping the original's ids would have been free —
   * style paths are section-relative, so nothing would collide today — but an
   * id is an identity, and two rows claiming one is a coincidence that holds
   * only until something compares them across sections.
   */
  const values = {
    title: { en: "Cards", ar: "" },
    cards: [
      { [ITEM_ID_KEY]: "i_aaaaaaaaaa", label: { en: "One", ar: "" } },
      { [ITEM_ID_KEY]: "i_bbbbbbbbbb", label: { en: "Two", ar: "" } },
    ],
  };
  const styles: StyleDocument = validateStyleDocument({
    v: 1,
    nodes: {
      "field:title": { base: { textColor: "orange" } },
      "field:cards/item:i_aaaaaaaaaa": { base: { radius: "lg" } },
      "field:cards/item:i_bbbbbbbbbb/field:label": { mobile: { hidden: true } },
    },
  });

  test("every row gets a new id, and the original is not touched", () => {
    const before = JSON.stringify(values);
    const { values: copy, ids } = withFreshItemIds(values);
    const rows = copy.cards as Record<string, unknown>[];

    assert.equal(rows.length, 2);
    for (const row of rows) assert.ok(isItemId(row[ITEM_ID_KEY]), String(row[ITEM_ID_KEY]));
    assert.notEqual(rows[0]![ITEM_ID_KEY], "i_aaaaaaaaaa");
    assert.notEqual(rows[1]![ITEM_ID_KEY], "i_bbbbbbbbbb");
    assert.notEqual(rows[0]![ITEM_ID_KEY], rows[1]![ITEM_ID_KEY]);
    assert.deepEqual(ids.get("i_aaaaaaaaaa"), rows[0]![ITEM_ID_KEY]);
    assert.deepEqual(ids.get("i_bbbbbbbbbb"), rows[1]![ITEM_ID_KEY]);

    assert.equal(JSON.stringify(values), before, "the original was rewritten");
    assert.equal((copy.title as { en: string }).en, "Cards", "the rest of the values moved");
  });

  test("a row with no id gets one rather than inheriting the gap", () => {
    const { values: copy, ids } = withFreshItemIds({ cards: [{ label: "One" }] });
    const [row] = copy.cards as Record<string, unknown>[];
    assert.ok(isItemId(row![ITEM_ID_KEY]));
    assert.equal(ids.size, 0, "there was nothing to map");
  });

  test("the copy's styles land on the copy's rows", () => {
    const { ids } = withFreshItemIds(values);
    const moved = remapStyleItemIds(styles, ids);
    const first = ids.get("i_aaaaaaaaaa")!;
    const second = ids.get("i_bbbbbbbbbb")!;

    assert.deepEqual(moved.nodes[`field:cards/item:${first}`], { base: { radius: "lg" } });
    assert.deepEqual(moved.nodes[`field:cards/item:${second}/field:label`], {
      mobile: { hidden: true },
    });
    // Nodes that name no row are carried across untouched.
    assert.deepEqual(moved.nodes["field:title"], { base: { textColor: "orange" } });
    // …and nothing still points at the original's rows.
    const keys = Object.keys(moved.nodes).join(" ");
    assert.ok(!keys.includes("i_aaaaaaaaaa") && !keys.includes("i_bbbbbbbbbb"), keys);
  });

  test("an override for a row the copy does not have is dropped, not left dangling", () => {
    const { ids } = withFreshItemIds({ cards: [{ [ITEM_ID_KEY]: "i_aaaaaaaaaa" }] });
    const orphan = validateStyleDocument({
      v: 1,
      nodes: { "field:cards/item:i_zzzzzzzzzz": { base: { opacity: 0.5 } } },
    });
    assert.deepEqual(remapStyleItemIds(orphan, ids).nodes, {});
  });

  test("with nothing repeatable, the document comes through as it was", () => {
    const { ids } = withFreshItemIds({ title: { en: "Plain", ar: "" } });
    assert.equal(ids.size, 0);
    assert.deepEqual(remapStyleItemIds(styles, ids), styles);
  });

  test("a remapped path is one the parser would have produced", () => {
    const { ids } = withFreshItemIds(values);
    for (const path of Object.keys(remapStyleItemIds(styles, ids).nodes)) {
      assert.equal(path, formatNodePath(parseNodePath(path)!), path);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("a visibility is one of two strings, or it is not a visibility", () => {
  /**
   * `raw === "true"` reads well until you list what else it accepts. A missing
   * field, `"TRUE"`, `"1"`, `"yes"`, `""` and every typo all fall through to
   * the other branch and mean **hide** — a malformed request quietly becoming a
   * destructive layout intention, in the one direction an ambiguous value must
   * never resolve.
   */
  test("the two that mean something", () => {
    assert.equal(readVisibility("true"), true);
    assert.equal(readVisibility("false"), false);
  });

  test("and nothing else does, least of all by meaning hide", () => {
    for (const raw of [
      undefined,
      null,
      "",
      " true",
      "true ",
      "TRUE",
      "True",
      "FALSE",
      "0",
      "1",
      "yes",
      "no",
      "on",
      "off",
      "garbage",
      0,
      1,
      true,
      false,
      {},
      [],
      ["true"],
    ]) {
      assert.equal(readVisibility(raw), null, JSON.stringify(raw) ?? String(raw));
    }
  });
});
