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
import {
  RESPONSIVE_ATTR,
  RESPONSIVE_PREFIX,
  RESPONSIVE_PROPERTIES,
  REVEAL_OPACITY_PROPERTY,
  mediaNodeStyle,
  nodeStyle,
  responsiveMediaStyle,
  responsiveStyle,
  tokensToStyle,
} from "@/lib/cms/style-css";
import { blockNode, mediaNode } from "@/lib/cms/node";
import {
  BACKGROUNDS,
  BORDERS,
  FONT_SIZES,
  MAX_WIDTHS,
  RADII,
  SHADOWS,
  RESPONSIVE_BREAKPOINTS,
  RESPONSIVE_WIDTHS,
  SPACING_STEPS,
  STYLE_DOCUMENT_VERSION,
  STYLE_TOKEN_KEYS,
  TEXT_COLORS,
  resolveTokens,
  validateStyleDocument,
  type StyleDocument,
  type StyleTokens,
} from "@/lib/cms/styles";
import { FINAL_OPACITY, revealMarks, revealStyle } from "@/components/site/reveal";
import {
  INHERITS_FROM,
  hiddenBasePaths,
  relativePath,
  tokenState,
  withToken,
  withoutBranch,
} from "@/lib/visual-editor/style-edit";
import { describeStoredPath } from "@/lib/visual-editor/labels";
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

  test("`hidden` is offered on every kind of node, because anything can be hidden", () => {
    for (const path of [
      undefined,
      "field:title",
      "field:backgroundImage",
      "field:links",
      "field:links/item:i_aaaaaaaaaa",
      "field:links/item:i_aaaaaaaaaa/field:label",
      "field:links/item:i_aaaaaaaaaa/field:icon",
      "slot:cta",
    ]) {
      const target = styleTargetFor("quick-links", path);
      assert.ok(target.tokens.includes("hidden"), `hidden not offered on ${path ?? "root"}`);
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
    const set = withToken(doc({}), "field:title", "base", "textColor", "orange");
    assert.deepEqual(set.nodes["field:title"], { base: { textColor: "orange" } });

    const cleared = withToken(set, "field:title", "base", "textColor", undefined);
    assert.deepEqual(cleared.nodes, {}, "an empty node was left behind");
  });

  test("a token is never stored as the value the design happens to use", () => {
    const cleared = withToken(withResponsive, "field:title", "base", "fontSize", undefined);
    assert.deepEqual(cleared.nodes["field:title"]!.base, { textColor: "orange" });
    assert.ok(!("fontSize" in cleared.nodes["field:title"]!.base!));
  });

  test("editing base does not touch tablet or mobile", () => {
    const edited = withToken(withResponsive, "field:title", "base", "textColor", "peach");
    assert.deepEqual(edited.nodes["field:title"]!.tablet, { fontSize: "h3" });
    assert.deepEqual(edited.nodes["field:title"]!.mobile, { align: "center" });
  });

  test("editing one breakpoint leaves the other two exactly as they were", () => {
    const tablet = withToken(withResponsive, "field:title", "tablet", "padBlock", 4);
    assert.deepEqual(tablet.nodes["field:title"]!.base, { textColor: "orange", fontSize: "h2" });
    assert.deepEqual(tablet.nodes["field:title"]!.tablet, { fontSize: "h3", padBlock: 4 });
    assert.deepEqual(tablet.nodes["field:title"]!.mobile, { align: "center" });

    const mobile = withToken(withResponsive, "field:title", "mobile", "fontSize", "small");
    assert.deepEqual(mobile.nodes["field:title"]!.base, { textColor: "orange", fontSize: "h2" });
    assert.deepEqual(mobile.nodes["field:title"]!.tablet, { fontSize: "h3" });
    assert.deepEqual(mobile.nodes["field:title"]!.mobile, { align: "center", fontSize: "small" });
  });

  test("clearing a breakpoint's token inherits again rather than copying a parent", () => {
    const set = withToken(withResponsive, "field:title", "mobile", "fontSize", "small");
    const cleared = withToken(set, "field:title", "mobile", "fontSize", undefined);
    assert.deepEqual(cleared.nodes["field:title"]!.mobile, { align: "center" });
    assert.ok(
      !("fontSize" in cleared.nodes["field:title"]!.mobile!),
      "the parent's value was written into the branch that cleared it",
    );
  });

  test("a branch emptied by clearing its last token is removed, not left as {}", () => {
    const onlyMobile = doc({ "field:title": { base: { opacity: 0.5 }, mobile: { hidden: true } } });
    const cleared = withToken(onlyMobile, "field:title", "mobile", "hidden", undefined);
    assert.deepEqual(cleared.nodes["field:title"], { base: { opacity: 0.5 } });
  });

  test("resetting one breakpoint keeps the other two", () => {
    const base = withoutBranch(withResponsive, "field:title", "base");
    assert.equal(base.nodes["field:title"]!.base, undefined);
    assert.deepEqual(base.nodes["field:title"]!.tablet, { fontSize: "h3" });
    assert.deepEqual(base.nodes["field:title"]!.mobile, { align: "center" });

    const tablet = withoutBranch(withResponsive, "field:title", "tablet");
    assert.equal(tablet.nodes["field:title"]!.tablet, undefined);
    assert.deepEqual(tablet.nodes["field:title"]!.base, { textColor: "orange", fontSize: "h2" });
    assert.deepEqual(tablet.nodes["field:title"]!.mobile, { align: "center" });

    const mobile = withoutBranch(withResponsive, "field:title", "mobile");
    assert.equal(mobile.nodes["field:title"]!.mobile, undefined);
    assert.deepEqual(mobile.nodes["field:title"]!.base, { textColor: "orange", fontSize: "h2" });
    assert.deepEqual(mobile.nodes["field:title"]!.tablet, { fontSize: "h3" });
  });

  test("a node with nothing left at all is removed", () => {
    const baseOnly = doc({ "field:title": { base: { opacity: 0.5 } } });
    assert.deepEqual(withoutBranch(baseOnly, "field:title", "base").nodes, {});
    const mobileOnly = doc({ "field:title": { mobile: { hidden: true } } });
    assert.deepEqual(withoutBranch(mobileOnly, "field:title", "mobile").nodes, {});
  });

  test("resetting a branch that is not there changes nothing at all", () => {
    const same = withoutBranch(withResponsive, "field:image", "tablet");
    assert.equal(same, withResponsive, "an absent branch produced a new document");
  });

  test("an edited document still survives the validator unchanged", () => {
    const edited = withToken(withResponsive, "field:title", "base", "marginBlock", 3);
    assert.deepEqual(validateStyleDocument(edited), edited);
    const responsive = withToken(edited, "field:title", "mobile", "hidden", true);
    assert.deepEqual(validateStyleDocument(responsive), responsive);
  });

  test("a control knows whether it is showing an override or an inheritance", () => {
    const node = withResponsive.nodes["field:title"]!;

    assert.deepEqual(tokenState(node, "base", "fontSize"), {
      value: "h2",
      inherited: undefined,
      from: null,
    });
    assert.deepEqual(tokenState(node, "tablet", "fontSize"), {
      value: "h3",
      inherited: "h2",
      from: "base",
    });
    // Mobile does not set a size, and what it would show comes from tablet —
    // the nearest branch that has one, not from base.
    assert.deepEqual(tokenState(node, "mobile", "fontSize"), {
      value: undefined,
      inherited: "h3",
      from: "tablet",
    });
    // A token nobody has set anywhere has no source at all: the component's own
    // design is not something the document can name.
    assert.deepEqual(tokenState(node, "mobile", "shadow"), {
      value: undefined,
      inherited: undefined,
      from: null,
    });
    assert.deepEqual(tokenState(undefined, "tablet", "fontSize"), {
      value: undefined,
      inherited: undefined,
      from: null,
    });
  });

  test("the inheritance chain is base, then tablet — mobile inherits through it", () => {
    assert.deepEqual(INHERITS_FROM.base, []);
    assert.deepEqual(INHERITS_FROM.tablet, ["base"]);
    assert.deepEqual(INHERITS_FROM.mobile, ["base", "tablet"]);
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

/* -------------------------------------------------------------------------- */

describe("a narrower width inherits what it does not override", () => {
  const at = (node: StyleDocument["nodes"][string]) => ({
    base: resolveTokens(node, "base"),
    tablet: resolveTokens(node, "tablet"),
    mobile: resolveTokens(node, "mobile"),
  });

  test("base only: every width shows it", () => {
    const r = at({ base: { fontSize: "h2", textColor: "strong" } });
    assert.deepEqual(r.base, { fontSize: "h2", textColor: "strong" });
    assert.deepEqual(r.tablet, { fontSize: "h2", textColor: "strong" });
    assert.deepEqual(r.mobile, { fontSize: "h2", textColor: "strong" });
  });

  test("tablet only: the two narrower widths show it and the widest does not", () => {
    const r = at({ tablet: { fontSize: "h3" } });
    assert.deepEqual(r.base, {});
    assert.deepEqual(r.tablet, { fontSize: "h3" });
    assert.deepEqual(r.mobile, { fontSize: "h3" });
  });

  test("mobile only: nothing above it changes", () => {
    const r = at({ mobile: { align: "center" } });
    assert.deepEqual(r.base, {});
    assert.deepEqual(r.tablet, {});
    assert.deepEqual(r.mobile, { align: "center" });
  });

  test("base and tablet", () => {
    const r = at({ base: { fontSize: "h2", textColor: "strong" }, tablet: { fontSize: "h3" } });
    assert.equal(r.base.fontSize, "h2");
    assert.equal(r.tablet.fontSize, "h3");
    assert.equal(r.mobile.fontSize, "h3", "mobile did not inherit through tablet");
    assert.equal(r.mobile.textColor, "strong", "mobile lost a base token tablet never touched");
  });

  test("base and mobile", () => {
    const r = at({ base: { fontSize: "h2" }, mobile: { fontSize: "small" } });
    assert.equal(r.tablet.fontSize, "h2", "a mobile override reached tablet");
    assert.equal(r.mobile.fontSize, "small");
  });

  test("tablet and mobile, with no base at all", () => {
    const r = at({ tablet: { padBlock: 4 }, mobile: { padBlock: 2 } });
    assert.deepEqual(r.base, {});
    assert.equal(r.tablet.padBlock, 4);
    assert.equal(r.mobile.padBlock, 2);
  });

  test("all three, token by token", () => {
    const node = {
      base: { fontSize: "h2", textColor: "strong" },
      tablet: { fontSize: "h3" },
      mobile: { textColor: "orange" },
    } as const;
    const r = at(node);
    // The worked example from the brief: sparse branches, three different
    // answers, and not one copied value anywhere in the document.
    assert.deepEqual(r.base, { fontSize: "h2", textColor: "strong" });
    assert.deepEqual(r.tablet, { fontSize: "h3", textColor: "strong" });
    assert.deepEqual(r.mobile, { fontSize: "h3", textColor: "orange" });
  });

  test("the document itself stays sparse — nothing inherited is ever stored", () => {
    const document = doc({
      "field:title": {
        base: { fontSize: "h2", textColor: "strong" },
        tablet: { fontSize: "h3" },
        mobile: { textColor: "orange" },
      },
    });
    assert.deepEqual(validateStyleDocument(document), document);
    assert.deepEqual(Object.keys(document.nodes["field:title"]!.tablet!), ["fontSize"]);
    assert.deepEqual(Object.keys(document.nodes["field:title"]!.mobile!), ["textColor"]);
  });
});

/* -------------------------------------------------------------------------- */

describe("a responsive override reaches the page as a value and a name, never as CSS", () => {
  const document = (nodes: StyleDocument["nodes"]) => doc(nodes);

  test("a branch contributes one variable and one listed declaration per property", () => {
    const out = responsiveStyle(
      document({ "field:title": { base: { textColor: "strong" }, tablet: { textColor: "orange" } } }),
      "field:title",
    );
    assert.deepEqual(out?.attrs, { "data-rs-t": "color" });
    assert.deepEqual(out?.vars, { "--rs-t-color": "var(--color-orange)" });
  });

  test("both branches at once, each under its own attribute", () => {
    const out = responsiveStyle(
      document({ "field:title": { tablet: { padBlock: 4 }, mobile: { padBlock: 2 } } }),
      "field:title",
    );
    assert.deepEqual(out?.attrs, { "data-rs-t": "padding-block", "data-rs-m": "padding-block" });
    assert.equal(out?.vars["--rs-t-padding-block"], "1rem");
    assert.equal(out?.vars["--rs-m-padding-block"], "0.5rem");
  });

  test("a type step is replaced whole, so an old tracking cannot survive under a new size", () => {
    const out = responsiveStyle(
      document({ "field:title": { base: { fontSize: "h1" }, mobile: { fontSize: "small" } } }),
      "field:title",
    );
    const listed = out!.attrs["data-rs-m"]!.split(" ");
    assert.ok(listed.includes("font-size"));
    assert.ok(listed.includes("line-height"));
    assert.ok(listed.includes("letter-spacing"), "the step's tracking was not overridden");
    // `small` has no tracking of its own, so the override is an explicit none
    // rather than whatever the wider width happened to set.
    assert.equal(out!.vars["--rs-m-letter-spacing"], "normal");
  });

  test("a step that has tracking carries its own", () => {
    const out = responsiveStyle(
      document({ "field:title": { mobile: { fontSize: "h3" } } }),
      "field:title",
    );
    assert.equal(out!.vars["--rs-m-letter-spacing"], "var(--text-h3--letter-spacing)");
  });

  test("one focal axis moved at a breakpoint carries the other one with it", () => {
    const out = responsiveStyle(
      document({ "field:image": { base: { objectX: 20, objectY: 40 }, mobile: { objectY: 90 } } }),
      "field:image",
    );
    // Not `50% 90%`: the horizontal point the wider width chose is inherited,
    // and a branch that only moved the vertical one must not recentre it.
    assert.equal(out!.vars["--rs-m-object-position"], "20% 90%");
  });

  test("with nothing to inherit the untouched axis is centred, exactly as base does it", () => {
    const out = responsiveStyle(
      document({ "field:image": { mobile: { objectY: 90 } } }),
      "field:image",
    );
    assert.equal(out!.vars["--rs-m-object-position"], "50% 90%");
  });

  test("hidden is a display, and only when it is true", () => {
    const hide = responsiveStyle(document({ root: { mobile: { hidden: true } } }), "root");
    assert.deepEqual(hide?.attrs, { "data-rs-m": "display" });
    assert.equal(hide?.vars["--rs-m-display"], "none");

    // `hidden: false` is not how the document says "shown" — inheriting is —
    // and the validator drops it, so the mapper never sees one. Cast, because
    // the type says the same thing the validator does.
    const shown = responsiveStyle(
      document({ root: { mobile: { hidden: false } as never } }),
      "root",
    );
    assert.equal(shown, undefined);
  });

  test("a base-only node produces nothing at all", () => {
    assert.equal(
      responsiveStyle(document({ "field:title": { base: { textColor: "orange" } } }), "field:title"),
      undefined,
    );
  });

  test("an empty document produces nothing, for any path", () => {
    for (const path of [undefined, "root", "field:title", "field:links/item:i_aaaaaaaaaa"]) {
      assert.equal(responsiveStyle(doc({}), path), undefined, path ?? "root");
    }
    assert.equal(responsiveStyle(undefined, "field:title"), undefined);
  });

  test("a key that is not a node path resolves to no node and therefore no output", () => {
    const hostile = { v: 1, nodes: { ".card h1": { mobile: { hidden: true } } } } as StyleDocument;
    assert.equal(responsiveStyle(hostile, ".card h1"), undefined);
  });

  test("every declaration a token can produce is one this file knows the name of", () => {
    const samples: StyleTokens = {
      align: "center",
      fontSize: "h2",
      fontWeight: 800,
      textColor: "orange",
      background: "ink-700",
      padBlock: 4,
      padInline: 4,
      marginBlock: 4,
      marginInline: 4,
      gap: 4,
      radius: "lg",
      border: "accent",
      shadow: "lift",
      opacity: 0.5,
      maxWidth: "prose",
      objectX: 20,
      objectY: 80,
      hidden: true,
    };
    // Nothing in the vocabulary is left out of the sample, so a token added
    // later fails here rather than rendering at one width and not the others.
    for (const token of STYLE_TOKEN_KEYS) {
      assert.ok(token in samples, `${token} is not covered by this test`);
    }
    const produced = Object.keys(tokensToStyle(samples) ?? {}).map((property) =>
      property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`),
    );
    for (const property of produced) {
      assert.ok(
        (RESPONSIVE_PROPERTIES as readonly string[]).includes(property),
        `${property} can be produced at base and has no responsive name`,
      );
    }
    for (const property of RESPONSIVE_PROPERTIES) {
      assert.ok(produced.includes(property), `${property} is named but no token produces it`);
    }
  });

  test("nothing but a validated value and a known name ever leaves the mapper", () => {
    const hostile = validateStyleDocument({
      v: 1,
      nodes: {
        "field:title": {
          tablet: {
            textColor: "orange",
            css: "color: red",
            selector: ".title",
            class: "danger",
            position: "absolute",
            left: "0px",
            transform: "scale(9)",
            backgroundImage: "url(https://evil.example/x.png)",
            "--rogue": "red",
            padBlock: 999,
            opacity: Number.POSITIVE_INFINITY,
          },
          "@media (max-width: 1px)": { hidden: true },
          desktop: { hidden: true },
          sm: { hidden: true },
        },
      },
    });
    const out = responsiveStyle(hostile, "field:title")!;
    assert.deepEqual(out.attrs, { "data-rs-t": "color" });
    assert.deepEqual(Object.keys(out.vars), ["--rs-t-color"]);
    const serialised = JSON.stringify(out);
    for (const forbidden of ["url(", "absolute", "scale(", "danger", "selector", "rogue", "@media"]) {
      assert.ok(!serialised.includes(forbidden), `${forbidden} reached the page`);
    }
    // Only the three known branches exist, so a made-up one cannot render.
    assert.deepEqual(Object.keys(hostile.nodes["field:title"]!), ["tablet"]);
  });

  test("the attribute and variable names are this file's, not the document's", () => {
    assert.deepEqual(RESPONSIVE_ATTR, { tablet: "data-rs-t", mobile: "data-rs-m" });
    assert.deepEqual(RESPONSIVE_PREFIX, { tablet: "--rs-t-", mobile: "--rs-m-" });
    // Outside the editor's own namespace on purpose: `data-eod-` means editor
    // plumbing and is swept for on public pages, and these are page rendering.
    for (const attribute of Object.values(RESPONSIVE_ATTR)) {
      assert.ok(!attribute.startsWith("data-eod-"), attribute);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("a crop stays on the picture at every width", () => {
  const document = doc({
    "field:image": {
      base: { radius: "lg", objectX: 50, objectY: 50 },
      tablet: { objectY: 30, border: "accent" },
      mobile: { objectX: 20, objectY: 75 },
    },
  });

  test("the frame takes the shape and the picture takes the crop, per breakpoint", () => {
    const { box, image } = responsiveMediaStyle(document, "field:image");
    assert.deepEqual(box?.attrs, { "data-rs-t": "border" });
    assert.equal(box?.vars["--rs-t-border"], "1px solid var(--color-orange)");
    assert.ok(!("--rs-t-object-position" in (box?.vars ?? {})), "a crop was parked on the frame");

    assert.deepEqual(image?.attrs, {
      "data-rs-t": "object-position",
      "data-rs-m": "object-position",
    });
    assert.equal(image?.vars["--rs-t-object-position"], "50% 30%");
    assert.equal(image?.vars["--rs-m-object-position"], "20% 75%");
  });

  test("a media node with no responsive branch splits into nothing", () => {
    const { box, image } = responsiveMediaStyle(
      doc({ "field:image": { base: { objectX: 20, objectY: 80 } } }),
      "field:image",
    );
    assert.equal(box, undefined);
    assert.equal(image, undefined);
  });

  test("the node helper hands a block the two halves already separated", () => {
    const picture = mediaNode({ styles: document })("field:image");
    assert.equal(picture.box["data-rs-t"], "border");
    assert.equal(picture.box["data-rs-m"], undefined);
    assert.equal(picture.image["data-rs-t"], "object-position");
    assert.equal(picture.image["data-rs-m"], "object-position");
    assert.match(String(picture.box.style?.borderRadius), /radius-lg/);
    assert.equal(picture.image.style?.objectPosition, "50% 50%");
  });
});

/* -------------------------------------------------------------------------- */

describe("a node with no responsive branch renders exactly what it rendered before", () => {
  const baseOnly = doc({
    "field:title": { base: { fontSize: "h2", textColor: "orange", marginBlock: 4 } },
  });

  test("no attribute, no variable, just the style attribute Batch 6 wrote", () => {
    const attrs = blockNode({ styles: baseOnly })("field:title");
    assert.equal(attrs["data-rs-t"], undefined);
    assert.equal(attrs["data-rs-m"], undefined);
    assert.deepEqual(attrs.style, nodeStyle(baseOnly, "field:title"));
    for (const key of Object.keys(attrs.style ?? {})) {
      assert.ok(!key.startsWith("--"), `${key} appeared on a node nobody made responsive`);
    }
  });

  test("and an unstyled node is still an empty object", () => {
    assert.deepEqual(blockNode({ styles: doc({}) })("field:title"), {});
    assert.deepEqual(blockNode({})("field:title"), {});
  });

  test("a responsive node keeps its base style and gains variables beside it", () => {
    const mixed = doc({
      "field:title": { base: { textColor: "orange" }, mobile: { textColor: "peach" } },
    });
    const attrs = blockNode({ styles: mixed })("field:title");
    assert.equal(attrs.style?.color, "var(--color-orange)", "the base style was replaced");
    assert.equal(
      (attrs.style as Record<string, string>)["--rs-m-color"],
      "var(--color-peach)",
    );
    assert.equal(attrs["data-rs-m"], "color");
  });
});

/* -------------------------------------------------------------------------- */

describe("a revealed element's opacity is its finished state at every width", () => {
  test("the declaration is renamed so the reveal rules read it, not `opacity`", () => {
    const marks = revealMarks("reveal", {
      "data-rs-t": "opacity border-radius",
      "data-rs-m": "opacity",
    });
    assert.equal(marks["data-rs-t"], `${REVEAL_OPACITY_PROPERTY} border-radius`);
    assert.equal(marks["data-rs-m"], REVEAL_OPACITY_PROPERTY);
  });

  test("with no reveal class there is no lifecycle to protect and nothing is renamed", () => {
    const marks = { "data-rs-m": "opacity" };
    assert.equal(revealMarks("", marks), marks);
  });

  test("a list with no opacity in it is handed back untouched", () => {
    const marks = { "data-rs-t": "padding-block color" };
    assert.equal(revealMarks("reveal", marks), marks);
  });
});

/* -------------------------------------------------------------------------- */

describe("the stylesheet and the constants say the same thing about widths", () => {
  const css = readFileSync(
    path.join(import.meta.dirname ?? __dirname, "..", "src", "styles", "globals.css"),
    "utf8",
  );

  test("the two breakpoints are 1024 and 640, and nothing else is one", () => {
    assert.deepEqual(RESPONSIVE_WIDTHS, { tablet: 1024, mobile: 640 });
    assert.deepEqual([...RESPONSIVE_BREAKPOINTS], ["tablet", "mobile"]);
  });

  test("every responsive rule sits behind exactly those widths, on screen only", () => {
    const queries = [...css.matchAll(/@media[^{]*\[data-rs-/g)];
    assert.equal(queries.length, 0, "a responsive rule is not inside its own media block");

    const blocks = [...css.matchAll(/@media ([^{]+)\{((?:[^{}]|\{[^{}]*\})*)\}/g)].filter((match) =>
      match[2]!.includes("[data-rs-"),
    );
    assert.equal(blocks.length, 2, `expected one block per breakpoint, found ${blocks.length}`);
    assert.match(blocks[0]![1]!, new RegExp(`screen and \\(max-width: ${RESPONSIVE_WIDTHS.tablet}px\\)`));
    assert.match(blocks[1]![1]!, new RegExp(`screen and \\(max-width: ${RESPONSIVE_WIDTHS.mobile}px\\)`));
    // Tablet first: at 390px both blocks match, and the cascade decides by
    // source order. Written the other way round, mobile would lose to tablet.
    assert.ok(
      css.indexOf(blocks[0]![0]!) < css.indexOf(blocks[1]![0]!),
      "mobile is written before tablet, so a tablet override would win at 390px",
    );
    // `screen`, so a printed page — which is narrow enough to match — is not
    // quietly given the mobile design or the mobile hiding.
    for (const block of blocks) assert.match(block[1]!, /^\s*screen and/);
  });

  test("every declaration that can be overridden has a rule at both breakpoints", () => {
    for (const breakpoint of RESPONSIVE_BREAKPOINTS) {
      const attribute = RESPONSIVE_ATTR[breakpoint];
      const prefix = RESPONSIVE_PREFIX[breakpoint];
      for (const property of RESPONSIVE_PROPERTIES) {
        const rule = new RegExp(
          `\\[${attribute}~="${property}"\\]\\s*\\{\\s*${property}:\\s*var\\(${prefix}${property}\\)\\s*!important;\\s*\\}`,
        );
        assert.match(css, rule, `${breakpoint} has no rule for ${property}`);
      }
      // …and the reveal's rename, which writes the property the reveal rules
      // read rather than the one it was named after.
      assert.match(
        css,
        new RegExp(
          `\\[${attribute}~="${REVEAL_OPACITY_PROPERTY}"\\]\\s*\\{\\s*${FINAL_OPACITY}:\\s*var\\(${prefix}opacity\\)\\s*!important;\\s*\\}`,
        ),
        `${breakpoint} has no reveal-opacity rule`,
      );
    }
  });

  test("the responsive layer names no selector of its own beyond those attributes", () => {
    const blocks = [...css.matchAll(/@media ([^{]+)\{((?:[^{}]|\{[^{}]*\})*)\}/g)].filter((match) =>
      match[2]!.includes("[data-rs-"),
    );
    for (const block of blocks) {
      const body = block[2]!.replace(/\/\*[\s\S]*?\*\//g, "");
      for (const selector of body.matchAll(/([^{}]+)\{/g)) {
        assert.match(
          selector[1]!.trim(),
          /^\[data-rs-[tm]~="[a-z-]+"\]$/,
          `a responsive rule matches something other than its own attribute: ${selector[1]}`,
        );
      }
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("hiding is true or it is not stored", () => {
  /**
   * The responsive contract has one spelling for "shown": the absence of the
   * key. A stored `false` would be a second one, and two spellings of one state
   * drift — a node saying nothing and a node saying `false` would look
   * different in the panel, diff differently, and make "does this branch
   * override anything" a question with two answers. It would also be the first
   * half of a re-show model that does not exist, because hiding runs downwards.
   */
  const through = (node: Record<string, unknown>) =>
    validateStyleDocument({ v: 1, nodes: { "field:title": node } }).nodes["field:title"];

  test("`false` is dropped from Base, and the rest of the branch survives", () => {
    assert.deepEqual(through({ base: { hidden: false, textColor: "orange" } }), {
      base: { textColor: "orange" },
    });
  });

  test("…from Tablet", () => {
    assert.deepEqual(through({ tablet: { hidden: false, fontSize: "h3" } }), {
      tablet: { fontSize: "h3" },
    });
  });

  test("…and from Mobile", () => {
    assert.deepEqual(through({ mobile: { hidden: false, align: "center" } }), {
      mobile: { align: "center" },
    });
  });

  test("a branch whose only token was `false` is removed, and so is an empty node", () => {
    assert.deepEqual(
      through({ base: { hidden: false }, mobile: { hidden: true } }),
      { mobile: { hidden: true } },
    );
    assert.deepEqual(validateStyleDocument({ v: 1, nodes: { root: { base: { hidden: false } } } }).nodes, {});
  });

  test("nothing that merely looks false-ish survives either", () => {
    for (const value of [false, "false", "true", 0, 1, null, "", [], {}, "yes"]) {
      assert.deepEqual(
        through({ base: { hidden: value, textColor: "orange" } }),
        { base: { textColor: "orange" } },
        `${JSON.stringify(value)} survived`,
      );
    }
  });

  test("`true` survives in all three branches", () => {
    assert.deepEqual(
      through({ base: { hidden: true }, tablet: { hidden: true }, mobile: { hidden: true } }),
      { base: { hidden: true }, tablet: { hidden: true }, mobile: { hidden: true } },
    );
  });

  test("and validating twice changes nothing", () => {
    const once = validateStyleDocument({
      v: 1,
      nodes: { "field:title": { base: { hidden: false, opacity: 0.5 }, mobile: { hidden: true } } },
    });
    assert.deepEqual(validateStyleDocument(once), once);
  });
});

/* -------------------------------------------------------------------------- */

describe("a Base hide leaves a way back", () => {
  const document = doc({
    root: { base: { hidden: true } },
    "field:title": { base: { hidden: true, textColor: "orange" } },
    "field:intro": { base: { textColor: "peach" } },
    "field:links/item:i_aaaaaaaaaa": { base: { hidden: true } },
    "field:links/item:i_bbbbbbbbbb": { mobile: { hidden: true } },
    "field:links/item:i_cccccccccc/field:label": { tablet: { hidden: true } },
  });

  test("the document lists what is hidden at every width, and nothing else", () => {
    // Only Base. A tablet or mobile hide undoes itself by switching device, so
    // listing those would be a list of things that are not lost.
    assert.deepEqual(hiddenBasePaths(document).sort(), [
      "field:links/item:i_aaaaaaaaaa",
      "field:title",
    ]);
  });

  test("the section root is not in it — Layers can always reach that", () => {
    assert.ok(!hiddenBasePaths(document).includes("root"));
  });

  test("a document with nothing hidden lists nothing", () => {
    assert.deepEqual(hiddenBasePaths(doc({})), []);
    assert.deepEqual(hiddenBasePaths(doc({ "field:title": { base: { opacity: 0.5 } } })), []);
  });

  test("Restore clears the token and leaves the rest of the node alone", () => {
    const restored = withToken(document, "field:title", "base", "hidden", undefined);
    assert.deepEqual(restored.nodes["field:title"], { base: { textColor: "orange" } });
    assert.deepEqual(hiddenBasePaths(restored), ["field:links/item:i_aaaaaaaaaa"]);
    // …and the node goes entirely when the hide was all it had.
    const row = withToken(restored, "field:links/item:i_aaaaaaaaaa", "base", "hidden", undefined);
    assert.equal(row.nodes["field:links/item:i_aaaaaaaaaa"], undefined);
    assert.deepEqual(hiddenBasePaths(row), []);
    // Nothing else moved: the neighbour's own mobile hide is untouched.
    assert.deepEqual(row.nodes["field:links/item:i_bbbbbbbbbb"], { mobile: { hidden: true } });
  });

  test("a hidden row is named by its own words, found by its id and not its position", () => {
    const values = {
      links: [
        { _id: "i_zzzzzzzzzz", label: { en: "Visa Assistance", ar: "" } },
        { _id: "i_aaaaaaaaaa", label: { en: "Plan a Trip", ar: "" } },
      ],
    };
    const described = describeStoredPath("quick-links", "field:links/item:i_aaaaaaaaaa", values, "en");
    assert.equal(described.label, "Plan a Trip");
    assert.deepEqual(described.crumbs, ["Quick service navigation", "Links", "Plan a Trip"]);

    // The same row, moved to the front: the name follows the id.
    const moved = { links: [values.links[1]!, values.links[0]!] };
    assert.equal(
      describeStoredPath("quick-links", "field:links/item:i_aaaaaaaaaa", moved, "en").label,
      "Plan a Trip",
    );
  });

  test("an ordinary field is named from the registry", () => {
    const described = describeStoredPath("quick-links", "field:title", {}, "en");
    assert.equal(described.label, "Title");
  });

  test("a row the values no longer hold is still named, never shown as an id", () => {
    const described = describeStoredPath("quick-links", "field:links/item:i_aaaaaaaaaa", {}, "en");
    assert.equal(described.label, "Item");
    assert.ok(!described.crumbs.join(" ").includes("i_aaaaaaaaaa"));
  });

  test("Arabic names it in Arabic", () => {
    const values = {
      links: [{ _id: "i_aaaaaaaaaa", label: { en: "Plan a Trip", ar: "خطّط لرحلة" } }],
    };
    assert.equal(
      describeStoredPath("quick-links", "field:links/item:i_aaaaaaaaaa", values, "ar").label,
      "خطّط لرحلة",
    );
  });
});
