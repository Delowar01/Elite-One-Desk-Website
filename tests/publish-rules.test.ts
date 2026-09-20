/**
 * The rules publication is strict about, decided without a database.
 *
 * Everything else in `cms/` is tolerant on purpose: a damaged column must not
 * blank a page an editor is working on, so the readers rebuild what they are
 * handed and fall back to the established order. Publication cannot afford any
 * of that — it deletes rows, rewrites `position` and decides `is_published` —
 * so it has its own readers, and what they refuse is the subject here.
 *
 * The distinction that runs through all of it: **valid-empty and corrupt are
 * not the same answer.** An empty layout means "publish a page with no
 * sections" and an empty snapshot means "this page once had none". Both are
 * real historical intentions. Corrupt JSON produces an empty list under the
 * tolerant validators, and if publication could not tell the two apart it
 * would delete a page because a column could not be parsed.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { readPageSnapshot, PAGE_SNAPSHOT_VERSION } from "@/lib/cms/snapshot";
import {
  DRAFT_STRUCTURE_VERSION,
  liveStructure,
  readPublishableStructure,
  structureDiffers,
  validateDraftStructure,
} from "@/lib/cms/structure";
import { describePending, describeRemoval, type PageSummaryView } from "@/lib/visual-editor/publish";

const OWNED = [11, 12, 13];
const doc = (sections: unknown) => ({ v: DRAFT_STRUCTURE_VERSION, sections });
const entry = (sectionId: number, visible = true) => ({ sectionId, visible });

/* -------------------------------------------------------------------------- */

describe("a layout is publishable only if this build wrote it", () => {
  test("a document of this build's shape is accepted, order and visibility intact", () => {
    const read = readPublishableStructure(doc([entry(13, false), entry(11), entry(12, true)]), OWNED);
    assert.ok(read.ok);
    assert.deepEqual(read.structure.sections, [
      { sectionId: 13, visible: false },
      { sectionId: 11, visible: true },
      { sectionId: 12, visible: true },
    ]);
  });

  test("an empty list is valid, and means a page with no sections", () => {
    // The one case that must not be confused with corruption: publishing this
    // is a real, destructive, *intended* act.
    const read = readPublishableStructure(doc([]), OWNED);
    assert.ok(read.ok);
    assert.deepEqual(read.structure.sections, []);
  });

  test("absence is not a layout to publish", () => {
    for (const input of [null, undefined]) {
      assert.equal(readPublishableStructure(input, OWNED).ok, false);
    }
  });

  test("a document from a future build is refused rather than downgraded", () => {
    assert.equal(readPublishableStructure({ v: 2, sections: [] }, OWNED).ok, false);
    assert.equal(readPublishableStructure({ v: 0, sections: [] }, OWNED).ok, false);
    assert.equal(readPublishableStructure({ v: "1", sections: [] }, OWNED).ok, false);
  });

  test("a missing or wrongly-typed sections array is refused", () => {
    for (const bad of [{ v: 1 }, { v: 1, sections: {} }, { v: 1, sections: "" }, [], "x", 3]) {
      assert.equal(readPublishableStructure(bad, OWNED).ok, false, JSON.stringify(bad));
    }
  });

  test("a malformed id is refused, not dropped", () => {
    // Dropping it would read as "remove this section", which is not something
    // a damaged entry should be able to say.
    for (const bad of [0, -1, 1.5, "11", null, undefined, {}]) {
      assert.equal(
        readPublishableStructure(doc([entry(11), { sectionId: bad, visible: true }]), OWNED).ok,
        false,
        JSON.stringify(bad),
      );
    }
  });

  test("a repeated id is refused, not de-duplicated", () => {
    assert.equal(readPublishableStructure(doc([entry(11), entry(12), entry(11)]), OWNED).ok, false);
  });

  test("a visibility that is not a boolean is refused, not normalised", () => {
    // The tolerant validator turns anything that is not `false` into `true`,
    // which at publication time would show a section the editor had hidden.
    for (const bad of ["true", "false", 1, 0, null, undefined]) {
      assert.equal(
        readPublishableStructure(doc([{ sectionId: 11, visible: bad }]), OWNED).ok,
        false,
        JSON.stringify(bad),
      );
    }
    assert.ok(readPublishableStructure(doc([{ sectionId: 11, visible: false }]), OWNED).ok);
  });

  test("a section belonging to another page is refused, not filtered out", () => {
    // Filtering would quietly change what the layout meant — and what it meant
    // decides which rows survive.
    assert.equal(readPublishableStructure(doc([entry(11), entry(99)]), OWNED).ok, false);
  });

  test("an entry that is not an object at all is refused", () => {
    for (const bad of [null, 11, "11", []]) {
      assert.equal(readPublishableStructure(doc([bad]), OWNED).ok, false, JSON.stringify(bad));
    }
  });

  test("the tolerant validator and this one disagree exactly where they should", () => {
    // Same input, two answers: one rebuilds it so a page can render, the other
    // refuses so a page is not deleted on the strength of it.
    const damaged = doc([entry(11), { sectionId: "12", visible: "yes" }, entry(11)]);
    assert.deepEqual(validateDraftStructure(damaged).sections, [{ sectionId: 11, visible: true }]);
    assert.equal(readPublishableStructure(damaged, OWNED).ok, false);
  });
});

/* -------------------------------------------------------------------------- */

describe("what the live page already looks like, in the same shape", () => {
  const rows = [
    { id: 11, isDraftOnly: false, isPublished: true },
    { id: 12, isDraftOnly: false, isPublished: false },
    { id: 13, isDraftOnly: true, isPublished: false },
  ];

  test("established rows only, carrying their current visibility", () => {
    // A pending row has never been part of the published page, so it is not
    // part of the composition a layout draft is compared against.
    assert.deepEqual(liveStructure(rows).sections, [
      { sectionId: 11, visible: true },
      { sectionId: 12, visible: false },
    ]);
  });

  test("an identical layout is not a change", () => {
    assert.equal(structureDiffers(liveStructure(rows), liveStructure(rows)), false);
  });

  test("order, visibility and membership each count as a change", () => {
    const live = liveStructure(rows);
    assert.ok(structureDiffers(live, doc([entry(12, false), entry(11)]) as never));
    assert.ok(structureDiffers(live, doc([entry(11, false), entry(12, false)]) as never));
    assert.ok(structureDiffers(live, doc([entry(11)]) as never));
    assert.ok(structureDiffers(live, doc([entry(11), entry(12, false), entry(13)]) as never));
  });
});

/* -------------------------------------------------------------------------- */

describe("a snapshot is restorable only if this build wrote it", () => {
  const snap = (sections: unknown) => ({ v: PAGE_SNAPSHOT_VERSION, sections });
  const section = (blockType = "rich-text", visible = true) => ({
    sourceSectionId: 5,
    blockType,
    visible,
    published: {},
    styles: { v: 1, nodes: {} },
    animation: "fade-up",
  });

  test("a document of this build's shape is accepted", () => {
    const read = readPageSnapshot(snap([section(), section("page-hero", false)]));
    assert.ok(read.ok);
    assert.equal(read.snapshot.sections.length, 2);
    assert.equal(read.snapshot.sections[1]!.visible, false);
  });

  test("an empty snapshot is valid — a page that genuinely had no sections", () => {
    const read = readPageSnapshot(snap([]));
    assert.ok(read.ok);
    assert.deepEqual(read.snapshot.sections, []);
  });

  test("a future or malformed snapshot is refused rather than read as an empty page", () => {
    // This is the whole point of the strict reader. Rebuilt by the tolerant
    // one, every input below becomes "a page with no sections" — and restoring
    // that stages the removal of everything on the page.
    for (const bad of [
      { v: 2, sections: [] },
      { v: 0, sections: [] },
      { v: 1 },
      { v: 1, sections: {} },
      null,
      [],
      "x",
      7,
    ]) {
      assert.equal(readPageSnapshot(bad).ok, false, JSON.stringify(bad));
    }
  });

  test("a block type the registry has forgotten is refused, not dropped", () => {
    // Dropping it would restore the page *without* that section, silently.
    assert.equal(readPageSnapshot(snap([section("no-such-block")])).ok, false);
    assert.equal(readPageSnapshot(snap([section(""), section()])).ok, false);
  });

  test("a visibility that is not a boolean is refused", () => {
    assert.equal(readPageSnapshot(snap([{ ...section(), visible: "true" }])).ok, false);
  });

  test("a deprecated but still registered type restores normally", () => {
    assert.ok(readPageSnapshot(snap([section("egypt-feature")])).ok);
  });
});

/* -------------------------------------------------------------------------- */

describe("what a review says is waiting", () => {
  const base: PageSummaryView = {
    pageId: 1,
    slug: "about",
    title: "About",
    revision: 3,
    contentDrafts: 0,
    styleDrafts: 0,
    motionDrafts: 0,
    hasLayoutDraft: false,
    layoutCorrupt: false,
    layoutChanged: false,
    added: 0,
    removed: 0,
    discardedNew: 0,
    visibilityChanges: 0,
    publishable: false,
    discardable: false,
  };

  test("nothing pending says nothing", () => {
    assert.deepEqual(describePending(base), []);
    assert.equal(describeRemoval(base), null);
  });

  test("each domain is named, and counted", () => {
    assert.deepEqual(describePending({ ...base, contentDrafts: 2, styleDrafts: 1, motionDrafts: 1 }), [
      "2 content drafts",
      "1 style draft",
      "1 motion draft",
    ]);
  });

  test("structural change is named separately from the drafts", () => {
    assert.deepEqual(
      describePending({ ...base, layoutChanged: true, added: 1, removed: 2, visibilityChanges: 1 }),
      ["layout changed", "1 new section", "2 sections removed", "1 visibility change"],
    );
  });

  test("a removal is spelled out, with where the section went", () => {
    const warning = describeRemoval({ ...base, removed: 2 });
    assert.match(String(warning), /removes 2 sections/);
    assert.match(String(warning), /version history/i);
    assert.match(String(describeRemoval({ ...base, removed: 1 })), /removes 1 section from/);
  });
});
