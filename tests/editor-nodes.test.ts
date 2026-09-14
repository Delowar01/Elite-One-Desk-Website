/**
 * How the editor names things on a page, and where it draws the box.
 *
 * Two pure concerns, both of which fail quietly if they go wrong. An address
 * that changes when a list is reordered loses a style override and nobody finds
 * out until the page looks wrong; an overlay transform that is subtly off draws
 * the outline next to the element rather than on it, which reads as a glitch
 * rather than as a bug.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseAddress } from "@/lib/cms/address";
import { ITEM_ID_KEY } from "@/lib/cms/item-id";
import { getBlock } from "@/lib/cms/blocks";
import { blockNameOf, describeAddress } from "@/lib/visual-editor/labels";
import {
  IDENTITY_VIEW,
  intersectsViewport,
  isUsableRect,
  toOverlayRect,
} from "@/lib/visual-editor/overlay";
import { editorNode, editorNodeAttrs, itemFieldPath, itemPath } from "@/lib/visual-editor/render";

const EDITOR = { sectionId: 42, blockType: "quick-links" };
const ID_A = "i_aaaaaaaaaa";
const ID_B = "i_bbbbbbbbbb";
const row = (id: string, label: string) => ({ [ITEM_ID_KEY]: id, label });

/* -------------------------------------------------------------------------- */

describe("editor attributes exist only for an authorised canvas", () => {
  test("no editor, no attributes — not empty ones, none at all", () => {
    for (const absent of [null, undefined]) {
      assert.deepEqual(editorNodeAttrs(absent, { kind: "section" }), {});
      assert.deepEqual(editorNodeAttrs(absent, { path: "field:title", kind: "field" }), {});
      assert.deepEqual(editorNode(absent)("field:title"), {});
    }
  });

  test("a section root carries its own id and block type; a field does not repeat them", () => {
    assert.deepEqual(editorNodeAttrs(EDITOR, { kind: "section" }), {
      "data-eod-node": "",
      "data-eod-address": "section:42",
      "data-eod-kind": "section",
      "data-eod-section": "42",
      "data-eod-block": "quick-links",
    });
    assert.deepEqual(editorNodeAttrs(EDITOR, { path: "field:title", kind: "field" }), {
      "data-eod-node": "",
      "data-eod-address": "section:42/field:title",
      "data-eod-kind": "field",
    });
  });

  test("every address it writes is one the parser accepts", () => {
    const node = editorNode(EDITOR);
    for (const attrs of [
      node(undefined, "section"),
      node("field:title"),
      node("slot:media", "slot"),
      node(itemPath("links", row(ID_A, "Plan a Trip")), "item"),
      node(itemFieldPath("links", row(ID_A, "Plan a Trip"), "label")),
    ]) {
      const address = attrs["data-eod-address"]!;
      assert.ok(parseAddress(address), address);
    }
  });

  test("a path the grammar refuses produces nothing rather than a broken address", () => {
    const node = editorNode(EDITOR);
    for (const bad of ["field:links[0]", "div > p", "field:a@ar", "section:9/field:a", "", "//x"]) {
      assert.deepEqual(node(bad), {}, bad);
    }
    // A section root is the root: a section with a path is a contradiction.
    assert.deepEqual(editorNodeAttrs(EDITOR, { path: "field:title", kind: "section" }), {});
  });
});

/* -------------------------------------------------------------------------- */

describe("a node's address is stable", () => {
  test("the section's address is its database id, and nothing else", () => {
    const first = editorNodeAttrs({ sectionId: 42, blockType: "hero" }, { kind: "section" });
    const renamed = editorNodeAttrs({ sectionId: 42, blockType: "page-hero" }, { kind: "section" });
    assert.equal(first["data-eod-address"], "section:42");
    assert.equal(renamed["data-eod-address"], "section:42");
  });

  test("a repeatable row is addressed by its `_id`, never by its position", () => {
    const rows = [row(ID_A, "Plan a Trip"), row(ID_B, "Visa Assistance")];
    const before = rows.map((r) => itemPath("links", r));
    assert.deepEqual(before, [`field:links/item:${ID_A}`, `field:links/item:${ID_B}`]);

    // Reordered, edited, one removed — the surviving row keeps its address.
    const after = [{ ...rows[1]!, label: "Visas" }, rows[0]!].map((r) => itemPath("links", r));
    assert.deepEqual(after, [`field:links/item:${ID_B}`, `field:links/item:${ID_A}`]);
    assert.ok(!before.some((path) => /item:\d/.test(path ?? "")), "an index leaked into an address");
  });

  test("a row with no usable id is simply not selectable — no index fallback", () => {
    for (const broken of [{}, { [ITEM_ID_KEY]: "" }, { [ITEM_ID_KEY]: 3 }, { [ITEM_ID_KEY]: "i_0OlI1zzzz" }, { [ITEM_ID_KEY]: "nope" }]) {
      assert.equal(itemPath("links", broken), undefined, JSON.stringify(broken));
      assert.equal(itemFieldPath("links", broken, "label"), undefined);
      // And the renderer writes nothing rather than something wrong.
      // The bug this guards: an absent path used to read as "the section root",
      // so a row with no id was annotated with the section's own address and
      // the kind `item` — a node claiming to be a list row while pointing at
      // the whole section.
      assert.deepEqual(editorNode(EDITOR)(itemPath("links", broken), "item"), {});
      assert.deepEqual(editorNode(EDITOR)(undefined, "field"), {});
      assert.deepEqual(editorNode(EDITOR)("root", "item"), {});
    }
  });

  test("the language is not part of the address", () => {
    // The same row, read in either edition, is the same node: `text()` resolves
    // the locale, and the id it is addressed by never saw one.
    const english = itemFieldPath("links", row(ID_A, "Plan a Trip"), "label");
    const arabic = itemFieldPath("links", row(ID_A, "خطط لرحلة"), "label");
    assert.equal(english, arabic);
    assert.ok(!english!.includes("@"));
  });
});

/* -------------------------------------------------------------------------- */

describe("an address reads back as something a person can use", () => {
  test("a section is named by the registry, not by its type string", () => {
    assert.equal(blockNameOf("quick-links"), "Quick service navigation");
    assert.deepEqual(describeAddress("hero", "root"), {
      crumbs: ["Hero"],
      label: "Hero",
      blockName: "Hero",
    });
  });

  test("a field takes the label the admin form uses for it", () => {
    // Same declaration, so a field renamed in the registry is renamed here.
    const lead = getBlock("hero")!.fields.find((f) => f.name === "lead")!;
    assert.deepEqual(describeAddress("hero", "field:lead").crumbs, ["Hero", lead.label]);
    assert.equal(describeAddress("hero", "field:primaryCtaLabel").label, "Primary — button text");
  });

  test("a repeatable row is named by what it says, and its field by the registry", () => {
    const described = describeAddress(
      "quick-links",
      `field:links/item:${ID_A}/field:label`,
      "Plan a Trip",
    );
    assert.deepEqual(described.crumbs, ["Quick service navigation", "Links", "Plan a Trip", "Label"]);
    assert.equal(described.label, "Label");
  });

  test("a row the canvas could not read falls back to a word, never to the id", () => {
    const described = describeAddress("quick-links", `field:links/item:${ID_A}`);
    assert.deepEqual(described.crumbs, ["Quick service navigation", "Links", "Item"]);
    assert.ok(!described.crumbs.join(" ").includes(ID_A));
  });

  test("an unknown block or field is humanised rather than shown raw", () => {
    assert.equal(describeAddress("no-such-block", "root").blockName, "No such block");
    assert.equal(describeAddress("hero", "field:somethingNew").label, "Something New");
  });

  test("a long row label is truncated, not allowed to fill the panel", () => {
    const long = "A".repeat(200);
    const described = describeAddress("quick-links", `field:links/item:${ID_A}`, long);
    assert.ok(described.crumbs[2]!.length < 50, String(described.crumbs[2]!.length));
  });
});

/* -------------------------------------------------------------------------- */

describe("the overlay lands on the element", () => {
  const rect = { x: 200, y: 100, width: 400, height: 80 };

  test("at full size the rectangle is the rectangle", () => {
    assert.deepEqual(toOverlayRect(rect, IDENTITY_VIEW), rect);
  });

  test("a scaled canvas scales the rectangle with it", () => {
    assert.deepEqual(toOverlayRect(rect, { scale: 0.5, offsetX: 0, offsetY: 0 }), {
      x: 100,
      y: 50,
      width: 200,
      height: 40,
    });
  });

  test("a 1440 canvas in a narrower stage still lines up", () => {
    // The real case: 1440 logical pixels shown in a 1040px stage.
    const scale = 1040 / 1440;
    const view = { scale, offsetX: 0, offsetY: 0 };
    const headline = { x: 60, y: 320, width: 620, height: 96 };
    const drawn = toOverlayRect(headline, view);

    assert.ok(Math.abs(drawn.x - 60 * scale) < 1e-9);
    assert.ok(Math.abs(drawn.width - 620 * scale) < 1e-9);
    // The right edge of the element maps to the right edge of the outline.
    assert.ok(Math.abs(drawn.x + drawn.width - (headline.x + headline.width) * scale) < 1e-9);
    // And it stays inside the stage.
    assert.ok(drawn.x + drawn.width <= 1040);
  });

  test("the frame's offset inside the stage is added, not assumed away", () => {
    assert.deepEqual(toOverlayRect(rect, { scale: 0.5, offsetX: 24, offsetY: 12 }), {
      x: 124,
      y: 62,
      width: 200,
      height: 40,
    });
    // Offset is not scaled: it is already in the overlay's own space.
    assert.equal(toOverlayRect({ x: 0, y: 0, width: 1, height: 1 }, { scale: 0.25, offsetX: 40, offsetY: 8 }).x, 40);
  });

  test("a nonsense scale falls back to 1 rather than producing a nonsense box", () => {
    for (const scale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.deepEqual(toOverlayRect(rect, { scale, offsetX: 0, offsetY: 0 }), rect, String(scale));
    }
  });

  test("a rectangle worth drawing has finite numbers and some size", () => {
    assert.ok(isUsableRect(rect));
    for (const bad of [
      null,
      undefined,
      {},
      { x: 0, y: 0, width: 0, height: 10 },
      { x: 0, y: 0, width: 10, height: 0 },
      { x: Number.NaN, y: 0, width: 10, height: 10 },
      { x: 0, y: Number.POSITIVE_INFINITY, width: 10, height: 10 },
      { x: 0, y: 0, width: Number.NaN, height: 10 },
      { x: "0", y: 0, width: 10, height: 10 },
    ]) {
      assert.ok(!isUsableRect(bad), JSON.stringify(bad));
    }
  });

  test("an element scrolled out of the canvas is not drawn over the editor", () => {
    const viewport = { width: 1040, height: 800 };
    assert.ok(intersectsViewport({ x: 10, y: 10, width: 100, height: 40 }, viewport));
    assert.ok(intersectsViewport({ x: -20, y: -10, width: 100, height: 40 }, viewport), "partly visible counts");
    assert.ok(!intersectsViewport({ x: 10, y: -4000, width: 100, height: 40 }, viewport));
    assert.ok(!intersectsViewport({ x: 10, y: 900, width: 100, height: 40 }, viewport));
    assert.ok(!intersectsViewport({ x: 1100, y: 10, width: 100, height: 40 }, viewport));
  });
});
