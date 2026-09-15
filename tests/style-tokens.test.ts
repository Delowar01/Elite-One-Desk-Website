/**
 * The style system decided without a database.
 *
 * Three questions, all cheaper to pin down here than to discover on a page:
 * what a stored token becomes, which controls a node is allowed to offer, and
 * what an edit does to the document — particularly to the parts of it this
 * batch cannot show.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatNodePath, parseNodePath } from "@/lib/cms/address";
import { nodeStyle, tokensToStyle } from "@/lib/cms/style-css";
import {
  BACKGROUNDS,
  BORDERS,
  FONT_SIZES,
  MAX_WIDTHS,
  RADII,
  SHADOWS,
  SPACING_STEPS,
  STYLE_DOCUMENT_VERSION,
  TEXT_COLORS,
  validateStyleDocument,
  type StyleDocument,
} from "@/lib/cms/styles";
import { relativePath, withToken, withoutBase } from "@/lib/visual-editor/style-edit";
import { styleTargetFor } from "@/lib/visual-editor/style-targets";

const doc = (nodes: StyleDocument["nodes"]): StyleDocument => ({
  v: STYLE_DOCUMENT_VERSION,
  nodes,
});

/* -------------------------------------------------------------------------- */

describe("a token becomes CSS from a table, never from the database", () => {
  test("every value in the vocabulary has a mapping, and it is not the stored string", () => {
    for (const value of TEXT_COLORS) {
      const css = tokensToStyle({ textColor: value })!;
      assert.match(String(css.color), /^var\(--/, `${value} did not map to a token`);
      assert.notEqual(css.color, value);
    }
    for (const value of BACKGROUNDS) {
      const css = tokensToStyle({ background: value })!;
      assert.ok(css.background, `${value} produced nothing`);
      assert.notEqual(css.background, value);
    }
    for (const value of RADII) assert.ok(tokensToStyle({ radius: value })!.borderRadius);
    for (const value of BORDERS) assert.ok(tokensToStyle({ border: value })!.border);
    for (const value of SHADOWS) assert.ok(tokensToStyle({ shadow: value })!.boxShadow);
    for (const value of MAX_WIDTHS) assert.ok(tokensToStyle({ maxWidth: value })!.maxWidth);
    for (const value of FONT_SIZES) {
      const css = tokensToStyle({ fontSize: value })!;
      assert.match(String(css.fontSize), /^var\(--text-/);
      // The ramp carries its own leading: a display-sized heading with body
      // line height is the kind of wrong that looks like a bug in the design.
      assert.ok(css.lineHeight, `${value} lost its line height`);
    }
  });

  test("every spacing step on the scale produces a length, and nothing else does", () => {
    for (let step = 0; step <= SPACING_STEPS; step += 1) {
      const css = tokensToStyle({ padBlock: step, padInline: step, marginBlock: step, gap: step })!;
      if (step === 0) {
        assert.equal(css.paddingBlock, "0rem");
      } else {
        assert.match(String(css.paddingBlock), /rem$/);
      }
    }
    // Off the scale is not a style; the validator refuses it before this.
    assert.deepEqual(validateStyleDocument(doc({ root: { base: { padBlock: 99 } } })).nodes, {});
  });

  test("nothing spatial is physical — one document has to lay out in both directions", () => {
    const css = tokensToStyle({
      align: "start",
      padBlock: 4,
      padInline: 4,
      marginBlock: 4,
      marginInline: 4,
    })!;
    const keys = Object.keys(css);
    for (const physical of [
      "marginLeft",
      "marginRight",
      "paddingLeft",
      "paddingRight",
      "left",
      "right",
      "float",
    ]) {
      assert.ok(!keys.includes(physical), `${physical} reached the renderer`);
    }
    assert.equal(css.textAlign, "start");
    assert.ok(keys.includes("paddingInline") && keys.includes("marginInline"));
  });

  test("no override means no style object at all", () => {
    assert.equal(tokensToStyle({}), undefined);
    assert.equal(nodeStyle(doc({}), "field:title"), undefined);
    assert.equal(nodeStyle(undefined, "field:title"), undefined);
    // A node with overrides on a *different* path contributes nothing here.
    assert.equal(nodeStyle(doc({ root: { base: { opacity: 0.5 } } }), "field:title"), undefined);
  });

  test("two focal-point tokens make one property, and one of them still centres the other", () => {
    assert.equal(tokensToStyle({ objectX: 20, objectY: 80 })!.objectPosition, "20% 80%");
    assert.equal(tokensToStyle({ objectX: 20 })!.objectPosition, "20% 50%");
    assert.equal(tokensToStyle({ objectY: 80 })!.objectPosition, "50% 80%");
  });

  test("a path is resolved through the parser, so a selector is not a node", () => {
    const document = doc({ "field:title": { base: { opacity: 0.5 } } });
    assert.ok(nodeStyle(document, "field:title"));
    assert.equal(nodeStyle(document, ".field-title"), undefined);
    assert.equal(nodeStyle(document, "section:42/field:title"), undefined);
    assert.equal(nodeStyle(document, "field:title@ar"), undefined);
  });

  test("only the base branch is read; tablet and mobile are dormant", () => {
    const document = doc({
      "field:title": { base: { opacity: 0.5 }, tablet: { opacity: 1 }, mobile: { opacity: 1 } },
    });
    assert.equal(nodeStyle(document, "field:title")!.opacity, 0.5);
  });
});

/* -------------------------------------------------------------------------- */

describe("a node is only offered the controls that mean something on it", () => {
  test("the section root is a container, not a paragraph", () => {
    const target = styleTargetFor("page-hero", undefined);
    assert.equal(target.category, "section");
    assert.ok(target.tokens.includes("padBlock"));
    assert.ok(!target.tokens.includes("fontSize"), "type controls on a section wrapper");
    assert.ok(!target.tokens.includes("objectX"), "a focal point on a section wrapper");
  });

  test("a text field gets type, and no focal point", () => {
    const target = styleTargetFor("page-hero", "field:title");
    assert.equal(target.category, "text");
    assert.ok(target.tokens.includes("fontSize"));
    assert.ok(target.tokens.includes("textColor"));
    assert.ok(!target.tokens.includes("objectX"));
    assert.ok(!target.tokens.includes("gap"), "a gap on a heading");
  });

  test("a media field gets a focal point, and no font", () => {
    const target = styleTargetFor("page-hero", "field:backgroundImage");
    assert.equal(target.category, "media");
    assert.ok(target.tokens.includes("objectX") && target.tokens.includes("objectY"));
    assert.ok(!target.tokens.includes("fontSize"));
  });

  test("a repeatable list is a container and one of its rows is a card", () => {
    assert.equal(styleTargetFor("quick-links", "field:links").category, "container");
    const row = styleTargetFor("quick-links", "field:links/item:i_aaaaaaaaaa");
    assert.equal(row.category, "item");
    assert.ok(row.tokens.includes("background") && row.tokens.includes("radius"));
  });

  test("a field inside a row follows its declared type", () => {
    assert.equal(
      styleTargetFor("quick-links", "field:links/item:i_aaaaaaaaaa/field:label").category,
      "text",
    );
    assert.equal(
      styleTargetFor("quick-links", "field:links/item:i_aaaaaaaaaa/field:image").category,
      "media",
    );
  });

  test("`hidden` is never offered — it belongs to the responsive batch", () => {
    for (const path of [
      undefined,
      "field:title",
      "field:backgroundImage",
      "field:links",
      "field:links/item:i_aaaaaaaaaa",
    ]) {
      const target = styleTargetFor("quick-links", path);
      assert.ok(!target.tokens.includes("hidden"), `hidden offered on ${path ?? "root"}`);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("an edit leaves the document sparse, and leaves the invisible parts alone", () => {
  const withResponsive = doc({
    "field:title": {
      base: { textColor: "orange", fontSize: "h2" },
      tablet: { fontSize: "h3" },
      mobile: { align: "center" },
    },
  });

  test("setting a token adds it; setting it to default removes it", () => {
    const set = withToken(doc({}), "field:title", "textColor", "orange");
    assert.deepEqual(set.nodes["field:title"], { base: { textColor: "orange" } });

    const cleared = withToken(set, "field:title", "textColor", undefined);
    assert.deepEqual(cleared.nodes, {}, "an empty node was left behind");
  });

  test("a token is never stored as the value the design happens to use", () => {
    const cleared = withToken(withResponsive, "field:title", "fontSize", undefined);
    assert.deepEqual(cleared.nodes["field:title"]!.base, { textColor: "orange" });
    assert.ok(!("fontSize" in cleared.nodes["field:title"]!.base!));
  });

  test("editing base does not touch tablet or mobile", () => {
    const edited = withToken(withResponsive, "field:title", "textColor", "peach");
    assert.deepEqual(edited.nodes["field:title"]!.tablet, { fontSize: "h3" });
    assert.deepEqual(edited.nodes["field:title"]!.mobile, { align: "center" });
  });

  test("resetting this element removes base and keeps what cannot be seen yet", () => {
    const reset = withoutBase(withResponsive, "field:title");
    assert.equal(reset.nodes["field:title"]!.base, undefined);
    assert.deepEqual(reset.nodes["field:title"]!.tablet, { fontSize: "h3" });
    assert.deepEqual(reset.nodes["field:title"]!.mobile, { align: "center" });
  });

  test("a node with nothing left at all is removed", () => {
    const baseOnly = doc({ "field:title": { base: { opacity: 0.5 } } });
    assert.deepEqual(withoutBase(baseOnly, "field:title").nodes, {});
  });

  test("an edited document still survives the validator unchanged", () => {
    const edited = withToken(withResponsive, "field:title", "marginBlock", 3);
    assert.deepEqual(validateStyleDocument(edited), edited);
  });

  test("a relative path is normalised through the parser, and a runtime address is not one", () => {
    assert.equal(relativePath(undefined), "root");
    assert.equal(relativePath("root"), "root");
    assert.equal(relativePath("field:title"), "field:title");
    assert.equal(relativePath("section:42/field:title"), null);
    assert.equal(relativePath("field:title@ar"), null);
    assert.equal(relativePath(".card > h1"), null);
    // …and what it returns is what the parser would produce.
    assert.equal(
      relativePath("field:links/item:i_aaaaaaaaaa/field:label"),
      formatNodePath(parseNodePath("field:links/item:i_aaaaaaaaaa/field:label")!),
    );
  });
});
