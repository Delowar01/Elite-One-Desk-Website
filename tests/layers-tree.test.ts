/**
 * The Layers tree and direct canvas editing, decided without a database.
 *
 * Both are built on one idea: the canvas says what exists and can be pointed
 * at, the block registry says what each of those things *is*, and a parsed
 * address is the only thing that joins them. Nothing here reads the DOM,
 * because nothing in the editor's model is allowed to.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ancestorAddresses,
  applyTextAt,
  buildLayerTree,
  directEditAt,
  isDescendantAddress,
  layerGroupOf,
  layerKindOf,
  parentAddress,
  textAt,
} from "@/lib/visual-editor/tree";

const ROW = "i_8Gk3pZmQ2v";
const OTHER = "i_4RtYuVbNm7";

/** A quick-links section as the canvas would have rendered it. */
const quickLinks = () => ({
  title: { en: "Where to next", ar: "إلى أين" },
  intro: { en: "Pick a service", ar: "" },
  links: [
    { _id: ROW, label: { en: "Travel & Tourism", ar: "السفر" }, href: "/travel", icon: "plane", image: 4 },
    { _id: OTHER, label: { en: "Visa Services", ar: "" }, href: "/visa", icon: "id", image: 7 },
  ],
});

const canvasNodes = [
  { address: "section:21/field:title", relativePath: "field:title" },
  { address: "section:21/field:links", relativePath: "field:links" },
  { address: `section:21/field:links/item:${ROW}`, relativePath: `field:links/item:${ROW}`, text: "Travel & Tourism" },
  {
    address: `section:21/field:links/item:${ROW}/field:label`,
    relativePath: `field:links/item:${ROW}/field:label`,
  },
  {
    address: `section:21/field:links/item:${ROW}/field:image`,
    relativePath: `field:links/item:${ROW}/field:image`,
  },
  { address: `section:21/field:links/item:${OTHER}`, relativePath: `field:links/item:${OTHER}` },
];

/* -------------------------------------------------------------------------- */

describe("what a node is, according to the registry", () => {
  test("a path's kind comes from the block's own declaration", () => {
    assert.equal(layerKindOf("quick-links", "root"), "section");
    assert.equal(layerKindOf("quick-links", "field:title"), "text");
    assert.equal(layerKindOf("quick-links", "field:intro"), "multiline");
    assert.equal(layerKindOf("quick-links", "field:links"), "list");
    assert.equal(layerKindOf("quick-links", `field:links/item:${ROW}`), "item");
    assert.equal(layerKindOf("quick-links", `field:links/item:${ROW}/field:label`), "text");
    assert.equal(layerKindOf("quick-links", `field:links/item:${ROW}/field:image`), "media");
    assert.equal(layerKindOf("quick-links", `field:links/item:${ROW}/field:icon`), "icon");
    assert.equal(layerKindOf("hero", "field:primaryCtaHref"), "link");
    assert.equal(layerKindOf("hero", "field:lead"), "multiline");
  });

  test("a field the registry does not declare is a plain node, never a guess", () => {
    assert.equal(layerKindOf("quick-links", "field:invented"), "field");
    assert.equal(layerKindOf("not-a-block", "field:title"), "field");
    assert.equal(layerKindOf("quick-links", "field:links/item:i_nope/field:label"), "field");
  });

  test("the panel's five groups", () => {
    assert.equal(layerGroupOf("section"), "section");
    assert.equal(layerGroupOf("item"), "item");
    assert.equal(layerGroupOf("media"), "media");
    assert.equal(layerGroupOf("icon"), "media");
    assert.equal(layerGroupOf("link"), "link");
    for (const kind of ["text", "multiline", "richtext", "list", "field"] as const) {
      assert.equal(layerGroupOf(kind), "field");
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("the tree is the canvas's nodes, nested by their addresses", () => {
  test("hierarchy follows the parsed address, not the order it arrived in", () => {
    const tree = buildLayerTree("quick-links", canvasNodes, { values: quickLinks() });
    assert.deepEqual(
      tree.map((node) => node.relativePath),
      ["field:title", "field:links"],
    );

    const links = tree[1]!;
    assert.deepEqual(
      links.children.map((child) => child.relativePath),
      [`field:links/item:${ROW}`, `field:links/item:${OTHER}`],
    );
    const row = links.children[0]!;
    assert.deepEqual(
      row.children.map((child) => child.kind),
      ["text", "media"],
    );
    assert.equal(row.depth, 2);
    assert.equal(row.children[0]!.depth, 3);
  });

  test("a repeatable row is named by its own words, never by its position", () => {
    const tree = buildLayerTree("quick-links", canvasNodes, { values: quickLinks() });
    const rows = tree[1]!.children;
    // The first row's words came over the bridge; the second's did not, so it
    // is read out of the values by `_id`.
    assert.equal(rows[0]!.label, "Travel & Tourism");
    assert.equal(rows[1]!.label, "Visa Services");
    assert.ok(!rows.some((row) => /^Item \d/.test(row.label)), "a row is numbered rather than named");
  });

  test("…and in Arabic it is named by the Arabic words, with no English fallback", () => {
    const tree = buildLayerTree("quick-links", canvasNodes, {
      values: quickLinks(),
      locale: "ar",
    });
    const rows = tree[1]!.children;
    assert.equal(rows[0]!.label, "Travel & Tourism", "the canvas's own words win when it had some");
    // The second row has no Arabic label, and inventing the English one would
    // claim a translation that does not exist.
    assert.equal(rows[1]!.label, "Item");
  });

  test("a node whose parent the canvas did not report attaches to the nearest one it did", () => {
    const sparse = [
      { address: "section:21/field:links", relativePath: "field:links" },
      {
        address: `section:21/field:links/item:${ROW}/field:label`,
        relativePath: `field:links/item:${ROW}/field:label`,
      },
    ];
    const tree = buildLayerTree("quick-links", sparse, {});
    assert.equal(tree.length, 1);
    assert.equal(tree[0]!.children.length, 1);
    assert.equal(tree[0]!.children[0]!.relativePath, `field:links/item:${ROW}/field:label`);
  });

  test("nothing the canvas did not report appears, and a malformed path is dropped", () => {
    const tree = buildLayerTree("quick-links", [
      { address: "section:21/field:title", relativePath: "field:title" },
      { address: "section:21/field:bogus[0]", relativePath: "field:bogus[0]" },
      { address: "section:21", relativePath: "root" },
    ], {});
    assert.deepEqual(tree.map((node) => node.relativePath), ["field:title"]);
  });

  test("the registry supplies every other label", () => {
    const tree = buildLayerTree("quick-links", canvasNodes, { values: quickLinks() });
    assert.equal(tree[0]!.label, "Title");
    assert.equal(tree[1]!.label, "Links");
    assert.equal(tree[1]!.children[0]!.children[0]!.label, "Label");
    assert.equal(tree[1]!.children[0]!.children[1]!.label, "Image");
  });
});

/* -------------------------------------------------------------------------- */

describe("moving between a node and the one that contains it", () => {
  const deep = `section:21/field:links/item:${ROW}/field:label`;

  test("ancestors are the whole chain, outermost first", () => {
    assert.deepEqual(ancestorAddresses(deep), [
      "section:21",
      "section:21/field:links",
      `section:21/field:links/item:${ROW}`,
      deep,
    ]);
  });

  test("the parent is one step out, and a section root has none", () => {
    assert.equal(parentAddress(deep), `section:21/field:links/item:${ROW}`);
    assert.equal(parentAddress("section:21/field:title"), "section:21");
    assert.equal(parentAddress("section:21"), null);
  });

  test("containment is decided on parsed segments, not on string prefixes", () => {
    assert.equal(isDescendantAddress("section:21", deep), true);
    assert.equal(isDescendantAddress("section:21/field:links", deep), true);
    assert.equal(isDescendantAddress(deep, deep), false, "a node contains itself");
    assert.equal(isDescendantAddress("section:22/field:links", deep), false, "across sections");
    // `field:link` is a string prefix of `field:links` and contains nothing.
    assert.equal(isDescendantAddress("section:21/field:link", deep), false);
    assert.equal(isDescendantAddress("not an address", deep), false);
  });
});

/* -------------------------------------------------------------------------- */

describe("which nodes may be typed into on the canvas", () => {
  test("plain text and textareas, and nothing else", () => {
    assert.deepEqual(directEditAt("quick-links", "field:title"), { multiline: false, localised: true });
    assert.deepEqual(directEditAt("quick-links", "field:intro"), { multiline: true, localised: true });
    assert.deepEqual(directEditAt("hero", "field:primaryCtaLabel"), { multiline: false, localised: true });
    assert.deepEqual(directEditAt("quick-links", `field:links/item:${ROW}/field:label`), {
      multiline: false,
      localised: true,
    });
  });

  test("a row field the registry leaves untyped is text, because that is what it is", () => {
    /**
     * `href` inside a Quick Links row is declared `{ name: "href", label:
     * "Link" }` with no type, and an item field with no type is text — the
     * admin form renders it as a text input and the validator checks it as
     * one. So this says text, and it would be wrong to special-case the name:
     * a rule that reads meaning into the word "href" is a rule that gets the
     * next field wrong.
     *
     * What keeps it off the canvas is the other key-holder. Direct editing
     * needs *both* a plain-text declaration here and an annotated node from
     * the renderer, and the renderer only annotates text it actually draws.
     * An `href` is an attribute, so there is no node to double-click.
     */
    assert.deepEqual(directEditAt("quick-links", `field:links/item:${ROW}/field:href`), {
      multiline: false,
      localised: false,
    });
  });

  test("rich text is deliberately not one of them", () => {
    // Editing it here would be a second rich-text implementation beside the
    // inspector's, with its own idea of what markup is allowed.
    const rich = layerKindOf("rich-text", "field:body");
    assert.equal(rich === "richtext" || rich === "field", true);
    assert.equal(directEditAt("rich-text", "field:body"), null);
  });

  test("nor is a picture, a link, a list, a row or a section", () => {
    assert.equal(directEditAt("quick-links", "root"), null);
    assert.equal(directEditAt("quick-links", "field:links"), null);
    assert.equal(directEditAt("quick-links", `field:links/item:${ROW}`), null);
    assert.equal(directEditAt("quick-links", `field:links/item:${ROW}/field:image`), null);
    assert.equal(directEditAt("quick-links", `field:links/item:${ROW}/field:icon`), null);
    assert.equal(directEditAt("hero", "field:primaryCtaHref"), null);
    assert.equal(directEditAt("hero", "field:backgroundImage"), null);
  });
});

/* -------------------------------------------------------------------------- */

describe("a typed string goes into the field the address names", () => {
  test("the edition being edited, and only that one", () => {
    const values = quickLinks();
    const next = applyTextAt(values, "quick-links", "field:title", "en", "Where now")!;
    assert.deepEqual(next.title, { en: "Where now", ar: "إلى أين" });
    // …and the values the inspector is holding were not mutated underneath it.
    assert.deepEqual(values.title, { en: "Where to next", ar: "إلى أين" });

    const arabic = applyTextAt(values, "quick-links", "field:title", "ar", "إلى أين الآن")!;
    assert.deepEqual(arabic.title, { en: "Where to next", ar: "إلى أين الآن" });
  });

  test("English is never copied into Arabic, and an empty edition stays empty", () => {
    const values = quickLinks();
    assert.equal(textAt(values, "quick-links", "field:intro", "ar"), "");
    const next = applyTextAt(values, "quick-links", "field:intro", "ar", "اختر")!;
    assert.deepEqual(next.intro, { en: "Pick a service", ar: "اختر" });
  });

  test("a row is found by its `_id`, so a reorder cannot move the edit", () => {
    const values = quickLinks();
    const reordered = { ...values, links: [values.links[1], values.links[0]] };
    const path = `field:links/item:${ROW}/field:label`;

    const next = applyTextAt(reordered, "quick-links", path, "en", "Travel")!;
    const rows = next.links as Record<string, unknown>[];
    // Still the second row of the reordered list, and still the same `_id`.
    assert.equal(rows[1]!._id, ROW);
    assert.deepEqual(rows[1]!.label, { en: "Travel", ar: "السفر" });
    assert.equal(rows[0]!._id, OTHER);
    assert.deepEqual(rows[0]!.label, { en: "Visa Services", ar: "" }, "the sibling changed");
  });

  test("…and every other row keeps its identity and its values", () => {
    const values = quickLinks();
    const next = applyTextAt(values, "quick-links", `field:links/item:${ROW}/field:label`, "en", "Edited")!;
    const before = values.links;
    const after = next.links as Record<string, unknown>[];
    assert.deepEqual(after.map((row) => row._id), before.map((row) => row._id));
    assert.deepEqual(after[1], before[1], "an untouched row was rewritten");
    assert.equal(after[0]!.href, "/travel", "the edited row lost a sibling field");
    assert.equal(after[0]!.image, 4);
  });

  test("a path that names nothing editable writes nothing at all", () => {
    const values = quickLinks();
    for (const path of [
      "root",
      "field:links",
      `field:links/item:${ROW}`,
      `field:links/item:${ROW}/field:image`,
      `field:links/item:i_notARow/field:label`,
      "field:invented",
      "field:bogus[0]",
    ]) {
      assert.equal(applyTextAt(values, "quick-links", path, "en", "x"), null, path);
    }
  });

  test("reading back is what the editor is editing, not what the page renders", () => {
    const values = quickLinks();
    assert.equal(textAt(values, "quick-links", "field:title", "en"), "Where to next");
    assert.equal(textAt(values, "quick-links", `field:links/item:${ROW}/field:label`, "ar"), "السفر");
    assert.equal(textAt(values, "quick-links", `field:links/item:${OTHER}/field:label`, "ar"), "");
    assert.equal(textAt(values, "quick-links", "field:links", "en"), null);
  });
});
