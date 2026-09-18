/**
 * The style system decided without a database.
 *
 * Three questions, all cheaper to pin down here than to discover on a page:
 * what a stored token becomes, which controls a node is allowed to offer, and
 * what an edit does to the document — particularly to the parts of it this
 * batch cannot show.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { formatNodePath, parseNodePath } from "@/lib/cms/address";
import { mediaNodeStyle, nodeStyle, tokensToStyle } from "@/lib/cms/style-css";
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
import { FINAL_OPACITY, revealStyle } from "@/components/site/reveal";
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

  test("a gap is only offered where a gap can do something", () => {
    // Every annotated row and list in this codebase is a box whose children are
    // laid out by something inside it, so a gap on the row itself is inert. A
    // control that quietly does nothing is worse than a missing one.
    for (const path of [
      undefined,
      "field:title",
      "field:links",
      "field:links/item:i_aaaaaaaaaa",
      "field:links/item:i_aaaaaaaaaa/field:label",
      "field:backgroundImage",
    ]) {
      assert.ok(!styleTargetFor("quick-links", path).tokens.includes("gap"), `gap offered on ${path ?? "root"}`);
    }
    // A slot is a control the block laid out on purpose — the one that exists
    // is a button with a label and an arrow in a flex row.
    assert.ok(styleTargetFor("one-desk", "slot:cta").tokens.includes("gap"));
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

describe("a picture's crop goes on the picture, not on the frame around it", () => {
  const document = doc({
    "field:image": {
      base: { radius: "lg", border: "line", shadow: "soft", opacity: 0.8, objectX: 20, objectY: 80 },
    },
  });

  test("the frame keeps the shape and the picture keeps the crop", () => {
    const { box, image } = mediaNodeStyle(document, "field:image");
    assert.ok(box, "the frame lost its shape");
    assert.ok(image, "the picture lost its crop");
    assert.equal(image.objectPosition, "20% 80%");
    // `object-position` on a `div` or a `span` does nothing at all, so it must
    // not be there: a token that renders somewhere inert is a control that
    // silently fails.
    assert.equal(box.objectPosition, undefined, "the crop was left on the frame");
    assert.equal(box.borderRadius, "var(--radius-lg)");
    assert.equal(box.opacity, 0.8);
    assert.equal(image.borderRadius, undefined, "the shape was duplicated onto the picture");
  });

  test("a node with no focal point gives the picture nothing", () => {
    const { box, image } = mediaNodeStyle(doc({ "field:image": { base: { radius: "sm" } } }), "field:image");
    assert.ok(box);
    assert.equal(image, undefined, "an empty style object was put on the picture");
  });

  test("one field is still one path — the split is in the renderer, not the document", () => {
    assert.deepEqual(Object.keys(document.nodes), ["field:image"]);
    const { image } = mediaNodeStyle(document, "field:image/box");
    assert.equal(image, undefined);
  });

  test("a repeatable row's picture resolves the same way", () => {
    const path = "field:links/item:i_aaaaaaaaaa/field:image";
    const { box, image } = mediaNodeStyle(doc({ [path]: { base: { objectX: 10, radius: "md" } } }), path);
    assert.equal(image!.objectPosition, "10% 50%");
    assert.equal(box!.borderRadius, "var(--radius-md)");
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

/* -------------------------------------------------------------------------- */

describe("a revealed element's opacity is its finished state, not its current one", () => {
  const style = (revealClass: string, node?: Record<string, unknown>) =>
    revealStyle({ delay: 70, revealClass, node: node as never }) as Record<string, unknown>;

  test("on a reveal the value becomes the property the stylesheet reads", () => {
    const out = style("reveal", { opacity: 0.45, borderRadius: "var(--radius-lg)" });
    assert.equal(out[FINAL_OPACITY], "0.45");
    // The element must not be dimmed before it has been revealed: an inline
    // opacity outranks the class that holds it at 0 until then.
    assert.ok(!("opacity" in out), "the finished opacity was applied inline");
    assert.equal(out.borderRadius, "var(--radius-lg)", "the rest of the node's style was dropped");
    assert.equal(out["--reveal-delay"], "70ms", "the reveal's own delay was overwritten");
  });

  test("the other reveal variants are the same element with another transform", () => {
    for (const cls of ["reveal", "reveal reveal-left", "reveal reveal-scale"]) {
      const out = style(cls, { opacity: 0.2 });
      assert.equal(out[FINAL_OPACITY], "0.2", cls);
      assert.ok(!("opacity" in out), cls);
    }
  });

  test("with no reveal at all there is no lifecycle to protect, so it is the opacity", () => {
    const out = style("", { opacity: 0.45 });
    assert.equal(out.opacity, 0.45);
    assert.ok(!(FINAL_OPACITY in out), "a property nothing reads was written instead of the opacity");
  });

  test("a node with no opacity leaves both alone", () => {
    const out = style("reveal", { textAlign: "center" });
    assert.ok(!("opacity" in out) && !(FINAL_OPACITY in out));
    assert.equal(out.textAlign, "center");
  });

  test("zero is a chosen opacity, not an absent one", () => {
    assert.equal(style("reveal", { opacity: 0 })[FINAL_OPACITY], "0");
    assert.equal(style("", { opacity: 0 }).opacity, 0);
  });

  test("a stagger is carried, and an override still wins over what the reveal set", () => {
    const staggered = revealStyle({
      delay: 0,
      stagger: 60,
      revealClass: "reveal",
      node: { marginBlock: "2rem" },
    }) as Record<string, unknown>;
    assert.equal(staggered["--reveal-stagger"], "60ms");
    assert.equal(staggered.marginBlock, "2rem");
  });
});

describe("the stylesheet reads that property in every state a reveal can be in", () => {
  const css = readFileSync(
    path.join(import.meta.dirname ?? __dirname, "..", "src", "styles", "globals.css"),
    "utf8",
  );
  // Every `.reveal` rule that names an opacity at all, in source order.
  const rules = css
    .split("}")
    .filter((rule) => /(^|[\s,])\.reveal\b[^{]*\{[^{]*opacity\s*:/.test(rule))
    .map((rule) => rule.slice(rule.indexOf("{")));

  test("the hidden state is the only one that is not the editor's number", () => {
    assert.ok(rules.length >= 5, `only ${rules.length} reveal opacity rules were found`);
    const hidden = rules.filter((rule) => /opacity:\s*0\s*;/.test(rule));
    const finished = rules.filter((rule) => rule.includes(`var(${FINAL_OPACITY}, 1)`));
    // Exactly one rule hides a reveal — the scripted one — and every other
    // rule that touches its opacity lands on whatever the editor chose.
    assert.equal(hidden.length, 1, "more than one rule hides a reveal");
    assert.equal(
      finished.length,
      rules.length - 1,
      `a reveal rule sets an opacity the editor cannot reach:\n${rules
        .filter((rule) => !hidden.includes(rule) && !finished.includes(rule))
        .join("\n")}`,
    );
  });

  test("reduced motion and print both land on the chosen value", () => {
    for (const section of ["prefers-reduced-motion", "@media print"]) {
      const at = css.indexOf(section);
      assert.ok(at > 0, `${section} is missing`);
      const block = css.slice(at, css.indexOf("\n}", at));
      assert.match(
        block,
        new RegExp(`\\.reveal\\s*\\{[^}]*opacity:\\s*var\\(${FINAL_OPACITY}, 1\\)`),
        `${section} forces a revealed element back to full strength`,
      );
    }
  });
});
