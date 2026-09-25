/**
 * The layout half of the style vocabulary: what it accepts, what it renders,
 * and what it refuses to become.
 *
 * Batch 14 finishes the original styling requirement — width, height, flex,
 * grid, wrapping, overflow and a glow of its own — by *extending* the closed
 * document rather than opening it. That is the thing worth testing: not that a
 * grid renders a grid, but that nothing an editor can send turns into a length,
 * a unit, a property name or a selector, that a document written before this
 * batch still means exactly what it meant, and that a control is never offered
 * on a node where it would quietly do nothing.
 *
 * All of it is pure — a document in, a style object or a capability out — so it
 * runs in milliseconds beside everything else and needs no database.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { getBlock, BLOCKS } from "@/lib/cms/blocks";
import { ITEM_ID_ALPHABET } from "@/lib/cms/item-id";
import { remapStyleItemIds } from "@/lib/cms/duplicate";
import {
  RESPONSIVE_ATTR,
  RESPONSIVE_PREFIX,
  RESPONSIVE_PROPERTIES,
  responsiveStyle,
  nodeStyle,
  tokensToStyle,
} from "@/lib/cms/style-css";
import {
  ALIGN_ITEMS,
  DIRECTIONS,
  GLOWS,
  GRID_COLUMNS_MAX,
  GRID_COLUMNS_MIN,
  HEIGHTS,
  JUSTIFY,
  LAYOUTS,
  MIN_HEIGHTS,
  OVERFLOWS,
  STYLE_DOCUMENT_VERSION,
  STYLE_TOKEN_KEYS,
  validateStyleDocument,
  validateTokens,
  WIDTHS,
  WRAPS,
  type StyleDocument,
  type StyleTokens,
} from "@/lib/cms/styles";
import {
  effectiveLayout,
  offeredTokens,
  STYLE_GROUPS,
  STYLE_TOKEN_LABELS,
  styleCapabilities,
  styleTargetFor,
} from "@/lib/visual-editor/style-targets";
import { REPO_ROOT } from "./helpers/env";

const doc = (nodes: Record<string, unknown>): StyleDocument =>
  validateStyleDocument({ v: STYLE_DOCUMENT_VERSION, nodes });

const css = (tokens: StyleTokens) => tokensToStyle(tokens) ?? {};

/** Every new key this batch added, and nothing else. */
const NEW_TOKENS = [
  "width",
  "height",
  "minHeight",
  "layout",
  "direction",
  "wrap",
  "justify",
  "alignItems",
  "columns",
  "overflow",
  "glow",
] as const;

/** Every key that existed before it. */
const OLD_TOKENS = [
  "align",
  "fontSize",
  "fontWeight",
  "textColor",
  "background",
  "padBlock",
  "padInline",
  "marginBlock",
  "marginInline",
  "gap",
  "radius",
  "border",
  "shadow",
  "opacity",
  "maxWidth",
  "objectX",
  "objectY",
  "hidden",
] as const;

/* -------------------------------------------------------------------------- */

describe("the new vocabulary is closed, and closed in the same way as the old one", () => {
  test("the two halves account for every key, so nothing here is untested by omission", () => {
    assert.deepEqual(
      [...STYLE_TOKEN_KEYS].sort(),
      [...OLD_TOKENS, ...NEW_TOKENS].sort(),
      "a token exists that this file does not know about",
    );
  });

  test("every value the panel may offer survives validation, and nothing else does", () => {
    const vocabulary: Record<string, readonly unknown[]> = {
      width: WIDTHS,
      height: HEIGHTS,
      minHeight: MIN_HEIGHTS,
      layout: LAYOUTS,
      direction: DIRECTIONS,
      wrap: WRAPS,
      justify: JUSTIFY,
      alignItems: ALIGN_ITEMS,
      overflow: OVERFLOWS,
      glow: GLOWS,
    };
    for (const [token, values] of Object.entries(vocabulary)) {
      for (const value of values) {
        assert.deepEqual(validateTokens({ [token]: value }), { [token]: value }, `${token}=${value}`);
      }
    }
    for (let count = GRID_COLUMNS_MIN; count <= GRID_COLUMNS_MAX; count += 1) {
      assert.deepEqual(validateTokens({ columns: count }), { columns: count });
    }
  });

  test("a value from the wrong list, or from no list, is dropped rather than stored", () => {
    const wrong: Record<string, unknown>[] = [
      // Values that belong to another token — the enumerations are not shared.
      { width: "prose" },
      { height: "half" },
      { minHeight: "fit" },
      { layout: "inline-flex" },
      { direction: "row-reverse" },
      { direction: "column-reverse" },
      { wrap: "wrap-reverse" },
      { justify: "flex-start" },
      { justify: "left" },
      { alignItems: "baseline" },
      { overflow: "auto" },
      { overflow: "scroll" },
      { glow: "orange" },
      // Physical directions, which this vocabulary does not have at all.
      { justify: "right" },
      { alignItems: "left" },
      // CSS, by any route.
      { width: "50%" },
      { width: "calc(100% - 2rem)" },
      { height: "500px" },
      { minHeight: "80vh" },
      { columns: "repeat(3, 1fr)" },
      { overflow: "hidden !important" },
      { glow: "0 0 10px red" },
    ];
    for (const input of wrong) {
      assert.deepEqual(validateTokens(input), {}, JSON.stringify(input));
    }
  });

  test("a column count is a whole number inside its bounds and nothing else", () => {
    for (const bad of [
      0,
      -1,
      GRID_COLUMNS_MAX + 1,
      99,
      2.5,
      1.0000001,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      "3",
      null,
      true,
      [3],
      { columns: 3 },
    ]) {
      assert.deepEqual(validateTokens({ columns: bad }), {}, String(bad));
    }
    // …and the ends of the range are inside it.
    assert.deepEqual(validateTokens({ columns: GRID_COLUMNS_MIN }), { columns: GRID_COLUMNS_MIN });
    assert.deepEqual(validateTokens({ columns: GRID_COLUMNS_MAX }), { columns: GRID_COLUMNS_MAX });
  });

  test("nothing that is not a string from the list survives an enum token", () => {
    for (const token of ["width", "height", "minHeight", "layout", "direction", "wrap", "justify", "alignItems", "overflow", "glow"] as const) {
      for (const bad of [null, undefined, 0, 1, true, false, Number.NaN, [], ["flex"], { value: "flex" }, ""]) {
        assert.deepEqual(validateTokens({ [token]: bad }), {}, `${token}=${String(bad)}`);
      }
    }
  });

  test("a hostile branch contributes nothing but the keys it got right", () => {
    const hostile = validateTokens({
      layout: "grid",
      columns: 4,
      // Everything below is an attempt to name CSS rather than choose a value.
      display: "flex",
      gridTemplateColumns: "repeat(99, 1fr)",
      "grid-template-columns": "1fr 1fr",
      width: "100vw",
      style: "width:100vw",
      class: "w-full",
      "--rogue": "red",
      selector: ".card",
      overflowX: "scroll",
      "!important": true,
    });
    assert.deepEqual(hostile, { layout: "grid", columns: 4 });
  });

  test("validating twice is validating once", () => {
    const messy = {
      v: 1,
      nodes: {
        "field:points": {
          base: { layout: "grid", columns: 3, gap: 5, glow: "soft", width: "full" },
          tablet: { columns: 2, justify: "between", overflow: "hidden" },
          mobile: { columns: 1, direction: "column", height: "auto", minHeight: "half-screen" },
        },
        root: { base: { layout: "flex", alignItems: "center", minHeight: "screen" } },
      },
    };
    const once = validateStyleDocument(messy);
    const twice = validateStyleDocument(once);
    assert.deepEqual(twice, once);
    assert.equal(JSON.stringify(twice), JSON.stringify(once), "the canonical spelling moved");
    // …and a round trip through storage does not change it either.
    assert.equal(JSON.stringify(validateStyleDocument(JSON.parse(JSON.stringify(once)))), JSON.stringify(once));
  });

  test("the document version is still 1, because an old build has to keep reading it", () => {
    assert.equal(STYLE_DOCUMENT_VERSION, 1);
    assert.equal(doc({ root: { base: { layout: "grid" } } }).v, 1);
    // A higher version is refused whole, which is exactly why this batch did
    // not write one: the previous release would read every page as unstyled.
    assert.deepEqual(validateStyleDocument({ v: 2, nodes: { root: { base: { layout: "grid" } } } }), {
      v: 1,
      nodes: {},
    });
  });
});

/* -------------------------------------------------------------------------- */

describe("a document written before Batch 14 means exactly what it meant", () => {
  /** One node carrying every token the vocabulary had before this batch. */
  const BEFORE = {
    v: 1,
    nodes: {
      root: {
        base: {
          align: "center",
          background: "ink-700",
          padBlock: 6,
          padInline: 5,
          marginBlock: 4,
          marginInline: 3,
          gap: 7,
          radius: "lg",
          border: "accent",
          shadow: "lift",
          opacity: 0.55,
          maxWidth: "prose",
          hidden: true,
        },
        tablet: { fontSize: "h3", fontWeight: 800, textColor: "orange" },
        mobile: { objectX: 20, objectY: 80 },
      },
    },
  } as const;

  test("it validates to itself, key for key and value for value", () => {
    const validated = validateStyleDocument(BEFORE);
    assert.deepEqual(validated, JSON.parse(JSON.stringify(BEFORE)));
  });

  test("not one of the old tokens renders differently than it did", () => {
    /**
     * The declarations Batch 6 and Batch 7 produced for each old token, written
     * out here rather than read from the renderer — comparing the renderer with
     * itself would prove nothing.
     */
    const EXPECTED: Record<string, Record<string, unknown>> = {
      align: { textAlign: "center" },
      fontSize: {
        fontSize: "var(--text-h3)",
        lineHeight: "var(--text-h3--line-height)",
        letterSpacing: "var(--text-h3--letter-spacing)",
      },
      fontWeight: { fontWeight: 800 },
      textColor: { color: "var(--color-orange)" },
      background: { background: "var(--color-ink-700)" },
      padBlock: { paddingBlock: "2rem" },
      padInline: { paddingInline: "1.5rem" },
      marginBlock: { marginBlock: "1rem" },
      marginInline: { marginInline: "0.75rem" },
      gap: { gap: "2.5rem" },
      radius: { borderRadius: "var(--radius-lg)" },
      border: { border: "1px solid var(--color-orange)" },
      shadow: { boxShadow: "var(--shadow-lift)" },
      opacity: { opacity: 0.55 },
      maxWidth: { maxWidth: "65ch" },
      objectX: { objectPosition: "20% 50%" },
      objectY: { objectPosition: "50% 80%" },
      hidden: { display: "none" },
    };
    const VALUES: Record<string, unknown> = {
      align: "center",
      fontSize: "h3",
      fontWeight: 800,
      textColor: "orange",
      background: "ink-700",
      padBlock: 6,
      padInline: 5,
      marginBlock: 4,
      marginInline: 3,
      gap: 7,
      radius: "lg",
      border: "accent",
      shadow: "lift",
      opacity: 0.55,
      maxWidth: "prose",
      objectX: 20,
      objectY: 80,
      hidden: true,
    };
    for (const token of OLD_TOKENS) {
      assert.deepEqual(css({ [token]: VALUES[token] } as StyleTokens), EXPECTED[token], token);
    }
  });

  test("an old document gains no new declaration merely by being read again", () => {
    const before = css(validateTokens(BEFORE.nodes.root.base));
    assert.ok(!("width" in before) && !("height" in before) && !("overflow" in before));
    // `shadow` alone still produces the shadow alone — the glow composition
    // does not turn a one-layer value into a list.
    assert.equal(before.boxShadow, "var(--shadow-lift)");
  });

  test("absence stays absence: an unset new token adds nothing at all", () => {
    assert.equal(tokensToStyle({}), undefined);
    for (const token of NEW_TOKENS) {
      assert.equal(tokensToStyle({ [token]: undefined } as StyleTokens), undefined, token);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("a token becomes CSS from a table, and the table is the only source", () => {
  test("width is a length the renderer chose, never one the document carried", () => {
    assert.deepEqual(css({ width: "auto" }), { width: "auto" });
    assert.deepEqual(css({ width: "fit" }), { width: "fit-content" });
    assert.deepEqual(css({ width: "quarter" }), { width: "25%" });
    assert.deepEqual(css({ width: "third" }), { width: "33.3333%" });
    assert.deepEqual(css({ width: "half" }), { width: "50%" });
    assert.deepEqual(css({ width: "two-thirds" }), { width: "66.6667%" });
    assert.deepEqual(css({ width: "three-quarters" }), { width: "75%" });
    assert.deepEqual(css({ width: "full" }), { width: "100%" });
    /**
     * Every value in the list renders, and what it renders is drawn from this
     * fixed set rather than from the document. `auto` is the one value whose
     * CSS spelling happens to equal its stored name — which is fine, because
     * the renderer still chose it from its own table; what matters is that no
     * value the document could hold ever becomes a length.
     */
    const LENGTHS = new Set(["auto", "fit-content", "25%", "33.3333%", "50%", "66.6667%", "75%", "100%"]);
    for (const value of WIDTHS) {
      const out = css({ width: value });
      assert.ok(out.width, value);
      assert.ok(LENGTHS.has(String(out.width)), `${value} rendered as ${out.width}`);
    }
  });

  test("width and maximum width are two different declarations", () => {
    assert.deepEqual(css({ width: "half", maxWidth: "prose" }), { width: "50%", maxWidth: "65ch" });
  });

  test("height and minimum height are separate, and the screen ones are small-viewport", () => {
    assert.deepEqual(css({ height: "auto" }), { height: "auto" });
    assert.deepEqual(css({ height: "fit" }), { height: "fit-content" });
    assert.deepEqual(css({ height: "full" }), { height: "100%" });
    assert.deepEqual(css({ height: "screen" }), { height: "100svh" });
    assert.deepEqual(css({ minHeight: "none" }), { minHeight: "0px" });
    assert.deepEqual(css({ minHeight: "third-screen" }), { minHeight: "33svh" });
    assert.deepEqual(css({ minHeight: "half-screen" }), { minHeight: "50svh" });
    assert.deepEqual(css({ minHeight: "two-thirds-screen" }), { minHeight: "67svh" });
    assert.deepEqual(css({ minHeight: "screen" }), { minHeight: "100svh" });
    /**
     * Never a bare `vh`. On a phone that unit measures the viewport with the
     * browser chrome retracted, so a band sized "one screen" is taller than the
     * screen until the address bar hides — and the page jumps when it does.
     */
    for (const value of MIN_HEIGHTS) {
      assert.doesNotMatch(String(css({ minHeight: value }).minHeight), /(^|[^s])vh$/, value);
    }
    for (const value of HEIGHTS) {
      assert.doesNotMatch(String(css({ height: value }).height), /(^|[^s])vh$/, value);
    }
  });

  test("a flex layout is a display and three declarations, each from its own list", () => {
    assert.deepEqual(css({ layout: "flex" }), { display: "flex" });
    assert.deepEqual(css({ layout: "block" }), { display: "block" });
    assert.deepEqual(css({ layout: "grid" }), { display: "grid" });
    assert.deepEqual(css({ direction: "row" }), { flexDirection: "row" });
    assert.deepEqual(css({ direction: "column" }), { flexDirection: "column" });
    assert.deepEqual(css({ wrap: "nowrap" }), { flexWrap: "nowrap" });
    assert.deepEqual(css({ wrap: "wrap" }), { flexWrap: "wrap" });
  });

  test("a grid is a count the renderer expands, never a template the document holds", () => {
    for (let count = GRID_COLUMNS_MIN; count <= GRID_COLUMNS_MAX; count += 1) {
      assert.deepEqual(css({ columns: count }), {
        gridTemplateColumns: `repeat(${count}, minmax(0, 1fr))`,
      });
    }
    // The zero minimum rather than a bare `1fr`: an unbreakable word in one
    // cell must not make its column wider than its share.
    assert.match(String(css({ columns: 4 }).gridTemplateColumns), /minmax\(0, 1fr\)/);
  });

  test("overflow is one declaration, and scrolling is not on the menu", () => {
    assert.deepEqual(css({ overflow: "visible" }), { overflow: "visible" });
    assert.deepEqual(css({ overflow: "hidden" }), { overflow: "hidden" });
    assert.deepEqual(css({ overflow: "clip" }), { overflow: "clip" });
    assert.ok(!(OVERFLOWS as readonly string[]).includes("auto"));
    assert.ok(!(OVERFLOWS as readonly string[]).includes("scroll"));
    // And no axis-by-axis variant, which would be two controls for a
    // requirement nothing in this design has.
    const produced = Object.keys(css({ overflow: "hidden" }));
    assert.deepEqual(produced, ["overflow"]);
  });
});

/* -------------------------------------------------------------------------- */

describe("shadow and glow are independent, and one CSS property", () => {
  test("either alone is that one alone", () => {
    assert.equal(css({ shadow: "lift" }).boxShadow, "var(--shadow-lift)");
    assert.equal(css({ glow: "accent" }).boxShadow, "var(--glow-accent)");
  });

  test("both together compose, shadow first, and neither is lost", () => {
    assert.equal(css({ shadow: "soft", glow: "strong" }).boxShadow, "var(--shadow-soft), var(--glow-strong)");
    // Deterministic: the order is the renderer's, not the key order of whatever
    // object happened to arrive.
    assert.equal(css({ glow: "strong", shadow: "soft" }).boxShadow, "var(--shadow-soft), var(--glow-strong)");
  });

  test("every pair in the two vocabularies composes to something a browser can read", () => {
    for (const shadow of ["none", "soft", "lift", "ring"] as const) {
      for (const glow of GLOWS) {
        const value = String(css({ shadow, glow }).boxShadow);
        const layers = value === "none" ? [] : value.split(", ");
        const expected = (shadow === "none" ? 0 : 1) + (glow === "none" ? 0 : 1);
        assert.equal(layers.length, expected, `${shadow} + ${glow} → ${value}`);
        assert.ok(!value.includes("none,") && !value.includes(", none"), `${value} lists a keyword`);
      }
    }
  });

  test("clearing one leaves the other, because the panel clears keys and not properties", () => {
    // What "clear the shadow, keep the glow" looks like as a document.
    assert.equal(css({ glow: "soft" }).boxShadow, "var(--glow-soft)");
    assert.equal(css({ shadow: "ring" }).boxShadow, "var(--shadow-ring)");
    // …and explicitly choosing "none" on both is a real answer, not an absence.
    assert.equal(css({ shadow: "none", glow: "none" }).boxShadow, "none");
    assert.ok(!("boxShadow" in css({ radius: "lg" })), "an untouched node gained a shadow");
  });

  test("the glow values are the site's own light, referenced rather than spelled out", () => {
    for (const glow of GLOWS) {
      if (glow === "none") continue;
      assert.match(String(css({ glow }).boxShadow), /^var\(--glow-[a-z]+\)$/, glow);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("hiding still beats laying out, at every width", () => {
  test("at base, a hidden node is display none whatever its layout says", () => {
    assert.equal(css({ layout: "grid", hidden: true }).display, "none");
    assert.equal(css({ hidden: true, layout: "flex" }).display, "none");
  });

  test("a layout chosen at a narrower width cannot bring a hidden element back", () => {
    const document = doc({ root: { base: { hidden: true }, tablet: { layout: "flex" } } });
    const responsive = responsiveStyle(document, "root")!;
    assert.equal(responsive.vars["--rs-t-display"], "none", "tablet un-hid a hidden element");
    assert.match(responsive.attrs["data-rs-t"]!, /display/);
  });

  test("…and hiding at a width does not lose the layout the branch inherited", () => {
    const document = doc({ root: { base: { layout: "grid" }, mobile: { hidden: true } } });
    assert.equal(nodeStyle(document, "root")!.display, "grid");
    assert.equal(responsiveStyle(document, "root")!.vars["--rs-m-display"], "none");
  });
});

/* -------------------------------------------------------------------------- */

describe("nothing spatial is physical, so one document lays out in both editions", () => {
  test("the vocabulary contains no left and no right", () => {
    const words = [...WIDTHS, ...HEIGHTS, ...MIN_HEIGHTS, ...LAYOUTS, ...DIRECTIONS, ...WRAPS, ...JUSTIFY, ...ALIGN_ITEMS, ...OVERFLOWS, ...GLOWS];
    for (const word of words) {
      assert.ok(!/left|right/i.test(word), `${word} names a physical side`);
    }
    for (const token of STYLE_TOKEN_KEYS) {
      assert.ok(!/left|right/i.test(token), `${token} names a physical side`);
    }
  });

  test("alignment renders as the logical keywords, which mirror with the writing direction", () => {
    assert.deepEqual(css({ justify: "start" }), { justifyContent: "start" });
    assert.deepEqual(css({ justify: "end" }), { justifyContent: "end" });
    assert.deepEqual(css({ justify: "center" }), { justifyContent: "center" });
    assert.deepEqual(css({ justify: "between" }), { justifyContent: "space-between" });
    assert.deepEqual(css({ justify: "around" }), { justifyContent: "space-around" });
    assert.deepEqual(css({ justify: "evenly" }), { justifyContent: "space-evenly" });
    assert.deepEqual(css({ alignItems: "stretch" }), { alignItems: "stretch" });
    assert.deepEqual(css({ alignItems: "start" }), { alignItems: "start" });
    assert.deepEqual(css({ alignItems: "end" }), { alignItems: "end" });
    assert.deepEqual(css({ alignItems: "center" }), { alignItems: "center" });
    // `flex-start` would be the flexbox-only spelling, and it is also the one
    // that reads as a physical direction to anybody skimming the document.
    for (const value of JUSTIFY) {
      assert.ok(!String(css({ justify: value }).justifyContent).startsWith("flex-"), value);
    }
  });

  test("no reverse direction exists to be wrong about", () => {
    assert.deepEqual([...DIRECTIONS], ["row", "column"]);
    assert.deepEqual([...WRAPS], ["nowrap", "wrap"]);
    for (const bad of ["row-reverse", "column-reverse", "wrap-reverse"]) {
      assert.deepEqual(validateTokens({ direction: bad }), {});
      assert.deepEqual(validateTokens({ wrap: bad }), {});
    }
  });

  test("the whole style object a layout node can produce is direction-neutral", () => {
    const style = css({
      layout: "flex",
      direction: "row",
      wrap: "wrap",
      justify: "start",
      alignItems: "start",
      gap: 4,
      width: "half",
      padInline: 4,
      marginInline: 3,
    });
    const serialised = JSON.stringify(style);
    for (const physical of ["left", "right", "Left", "Right"]) {
      assert.ok(!serialised.includes(physical), `${physical} in ${serialised}`);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("every new declaration reaches the other two widths", () => {
  test("each one travels as a value under our prefix and a name in our attribute", () => {
    const cases: [keyof StyleTokens, unknown, string, string][] = [
      ["width", "half", "width", "50%"],
      ["height", "screen", "height", "100svh"],
      ["minHeight", "half-screen", "min-height", "50svh"],
      ["layout", "grid", "display", "grid"],
      ["direction", "column", "flex-direction", "column"],
      ["wrap", "wrap", "flex-wrap", "wrap"],
      ["justify", "between", "justify-content", "space-between"],
      ["alignItems", "center", "align-items", "center"],
      ["columns", 3, "grid-template-columns", "repeat(3, minmax(0, 1fr))"],
      ["overflow", "hidden", "overflow", "hidden"],
      ["glow", "accent", "box-shadow", "var(--glow-accent)"],
    ];
    for (const [token, value, property, rendered] of cases) {
      const document = doc({ root: { tablet: { [token]: value } } });
      const out = responsiveStyle(document, "root")!;
      assert.equal(out.attrs[RESPONSIVE_ATTR.tablet], property, `${token} named ${out.attrs["data-rs-t"]}`);
      assert.equal(out.vars[`${RESPONSIVE_PREFIX.tablet}${property}`], rendered, token);
      assert.ok(
        (RESPONSIVE_PROPERTIES as readonly string[]).includes(property),
        `${property} has no responsive name`,
      );
    }
  });

  test("a glow at a breakpoint keeps the shadow it inherited rather than deleting it", () => {
    const document = doc({ root: { base: { shadow: "lift" }, mobile: { glow: "soft" } } });
    const out = responsiveStyle(document, "root")!;
    assert.equal(out.vars["--rs-m-box-shadow"], "var(--shadow-lift), var(--glow-soft)");
  });

  test("…and a shadow at a breakpoint keeps the glow", () => {
    const document = doc({ root: { base: { glow: "strong" }, tablet: { shadow: "soft" } } });
    assert.equal(
      responsiveStyle(document, "root")!.vars["--rs-t-box-shadow"],
      "var(--shadow-soft), var(--glow-strong)",
    );
  });

  test("a branch that changes nothing contributes nothing", () => {
    assert.equal(responsiveStyle(doc({ root: { base: { layout: "grid" } } }), "root"), undefined);
  });
});

/* -------------------------------------------------------------------------- */

describe("a grid narrows by breakpoint, and resetting one inherits again", () => {
  /** The canonical case from the brief: four across, two on a tablet, one on a phone. */
  const columnsAt = (document: StyleDocument) => {
    const base = nodeStyle(document, "field:points")?.gridTemplateColumns;
    const responsive = responsiveStyle(document, "field:points");
    return {
      base,
      tablet: responsive?.vars["--rs-t-grid-template-columns"],
      mobile: responsive?.vars["--rs-m-grid-template-columns"],
    };
  };

  test("4 / 2 / 1 is three stored numbers and three rendered templates", () => {
    const document = doc({
      "field:points": { base: { layout: "grid", columns: 4 }, tablet: { columns: 2 }, mobile: { columns: 1 } },
    });
    assert.deepEqual(columnsAt(document), {
      base: "repeat(4, minmax(0, 1fr))",
      tablet: "repeat(2, minmax(0, 1fr))",
      mobile: "repeat(1, minmax(0, 1fr))",
    });
  });

  test("resetting Mobile makes a phone follow Tablet — through the cascade, not a copy", () => {
    const document = doc({
      "field:points": { base: { layout: "grid", columns: 4 }, tablet: { columns: 2 } },
    });
    const at = columnsAt(document);
    assert.equal(at.base, "repeat(4, minmax(0, 1fr))");
    assert.equal(at.tablet, "repeat(2, minmax(0, 1fr))");
    assert.equal(at.mobile, undefined, "mobile froze a copy of tablet");
    // Nothing inherited is ever written down, which is what lets a later edit
    // to Tablet still reach a phone.
    assert.deepEqual(Object.keys(document.nodes["field:points"]!), ["base", "tablet"]);
  });

  test("resetting Tablet leaves Mobile's own value alone and lets it follow Base", () => {
    const document = doc({
      "field:points": { base: { layout: "grid", columns: 4 }, mobile: { columns: 1 } },
    });
    const at = columnsAt(document);
    assert.equal(at.tablet, undefined);
    assert.equal(at.mobile, "repeat(1, minmax(0, 1fr))");
    assert.equal(at.base, "repeat(4, minmax(0, 1fr))");
  });

  test("a branch may narrow the grid without repeating the layout that made it one", () => {
    const document = doc({ "field:points": { base: { layout: "grid", columns: 3 }, mobile: { columns: 1 } } });
    const out = responsiveStyle(document, "field:points")!;
    assert.equal(out.attrs["data-rs-m"], "grid-template-columns");
    assert.ok(!out.attrs["data-rs-m"]!.includes("display"), "a column change restated the display");
  });
});

/* -------------------------------------------------------------------------- */

describe("what a node may control, and when", () => {
  test("a real list container is a layout box because the registry says so", () => {
    for (const [block, field, layout] of [
      ["quick-links", "field:links", "grid"],
      ["why-us", "field:points", "grid"],
      ["stats", "field:items", "grid"],
      ["featured-service", "field:points", "grid"],
      ["destination-feature", "field:destinations", "grid"],
      ["egypt-feature", "field:destinations", "grid"],
      ["travel-feature", "field:capabilities", "flex"],
    ] as const) {
      assert.equal(styleTargetFor(block, field).layout, layout, `${block} ${field}`);
    }
    // A list the component does not lay out is not declared as one.
    assert.equal(styleTargetFor("process", "field:steps").layout, null);
    assert.equal(styleTargetFor("hero", "field:words").layout, null);
  });

  test("the layout in force is the override, then the declaration, then nothing", () => {
    const grid = styleTargetFor("why-us", "field:points");
    const plain = styleTargetFor("process", "field:steps");
    assert.equal(effectiveLayout(grid, undefined), "grid");
    assert.equal(effectiveLayout(grid, "flex"), "flex");
    assert.equal(effectiveLayout(grid, "block"), "block", "flattening a grid is a real answer");
    assert.equal(effectiveLayout(plain, undefined), null);
    assert.equal(effectiveLayout(plain, "grid"), "grid");
  });

  test("a flex box is offered direction and wrap; a grid is offered columns", () => {
    const target = styleTargetFor("why-us", "field:points");
    const asGrid = offeredTokens(target, undefined);
    assert.ok(asGrid.includes("columns"));
    assert.ok(asGrid.includes("justify") && asGrid.includes("alignItems") && asGrid.includes("gap"));
    assert.ok(!asGrid.includes("direction"), "a grid was offered a flex direction");
    assert.ok(!asGrid.includes("wrap"), "a grid was offered flex wrapping");

    const asFlex = offeredTokens(target, "flex");
    assert.ok(asFlex.includes("direction") && asFlex.includes("wrap"));
    assert.ok(asFlex.includes("justify") && asFlex.includes("alignItems") && asFlex.includes("gap"));
    assert.ok(!asFlex.includes("columns"), "a flex row was offered a column count");
  });

  test("a node in ordinary block flow is offered the mode and none of its settings", () => {
    const target = styleTargetFor("process", "field:steps");
    const offered = offeredTokens(target, undefined);
    assert.ok(offered.includes("layout"), "no way to choose a layout at all");
    for (const token of ["direction", "wrap", "justify", "alignItems", "columns", "gap"] as const) {
      assert.ok(!offered.includes(token), `${token} offered on a node with no layout`);
    }
    // …and choosing one brings its own settings with it.
    assert.ok(offeredTokens(target, "grid").includes("columns"));
  });

  test("an explicit Block flattens the controls as well as the box", () => {
    const target = styleTargetFor("quick-links", "field:links");
    assert.ok(offeredTokens(target, undefined).includes("columns"));
    assert.ok(!offeredTokens(target, "block").includes("columns"));
    assert.ok(!offeredTokens(target, "block").includes("gap"));
  });

  test("nothing conditional is ever removed from what the node could control", () => {
    // The capability list is what the renderer honours; the offering is what the
    // panel draws. Narrowing one must not narrow the other, or a stored value
    // would stop rendering the moment somebody changed the layout back.
    const target = styleTargetFor("why-us", "field:points");
    for (const token of ["direction", "wrap", "justify", "alignItems", "columns", "gap"] as const) {
      assert.ok(target.tokens.includes(token), `${token} is not in the capability list`);
    }
  });

  test("a heading is not a layout box and is not offered one", () => {
    const heading = styleTargetFor("page-hero", "field:title");
    for (const token of ["layout", "direction", "wrap", "justify", "alignItems", "columns", "gap", "overflow", "glow", "height", "minHeight"] as const) {
      assert.ok(!heading.tokens.includes(token), `${token} offered on a heading`);
    }
    assert.ok(heading.tokens.includes("width"), "a heading cannot be given a width");
    assert.ok(heading.tokens.includes("maxWidth"));
  });

  test("a picture's frame sizes and clips, and lays nothing out", () => {
    const media = styleTargetFor("page-hero", "field:backgroundImage");
    for (const token of ["width", "height", "minHeight", "overflow", "glow"] as const) {
      assert.ok(media.tokens.includes(token), `a frame cannot control ${token}`);
    }
    assert.ok(!media.tokens.includes("layout"), "a frame holding one picture was given a layout");
  });

  test("the node families answer the capability questions the way the audit says", () => {
    /**
     * §3's matrix, as something that runs. Each row is a family of node in this
     * codebase, named by a real block and a real path, with the capabilities it
     * is supposed to have. A change that quietly gave a heading a grid, or took
     * overflow away from a picture frame, fails here rather than in somebody's
     * panel.
     */
    const MATRIX: [string, string, string | undefined, Record<string, boolean>][] = [
      // section root — a block-level wrapper around the whole band
      ["section root", "page-hero", undefined,
        { width: false, height: true, layout: true, flex: true, grid: true, overflow: true, glow: true }],
      // slot — an inline-flex control the block reserved
      ["slot", "one-desk", "slot:cta",
        { width: true, height: true, layout: true, flex: true, grid: true, overflow: true, glow: true }],
      // list container — a real grid
      ["list container", "why-us", "field:points",
        { width: true, height: true, layout: true, flex: true, grid: true, overflow: true, glow: true }],
      /**
       * An inline span, so nothing spatial — but a glow still paints around an
       * inline box, so it stays. The rule is "does this do anything", not "is
       * this a block".
       */
      ["inline list", "hero", "field:words",
        { width: false, height: false, layout: false, flex: false, grid: false, overflow: false, glow: true }],
      // repeatable row
      ["row", "quick-links", "field:links/item:i_aaaaaaaaaa",
        { width: true, height: true, layout: true, flex: true, grid: true, overflow: true, glow: true }],
      // text field
      ["text", "page-hero", "field:title",
        { width: true, height: false, layout: false, flex: false, grid: false, overflow: false, glow: false }],
      // a field inside a row, which follows its declared type
      ["row text", "quick-links", "field:links/item:i_aaaaaaaaaa/field:label",
        { width: true, height: false, layout: false, flex: false, grid: false, overflow: false, glow: false }],
      // media frame
      ["media", "page-hero", "field:backgroundImage",
        { width: true, height: true, layout: false, flex: false, grid: false, overflow: true, glow: true }],
      // a row's picture
      ["row media", "quick-links", "field:links/item:i_aaaaaaaaaa/field:image",
        { width: true, height: true, layout: false, flex: false, grid: false, overflow: true, glow: true }],
      // an icon is a glyph, not a box
      ["icon", "quick-links", "field:links/item:i_aaaaaaaaaa/field:icon",
        { width: false, height: false, layout: false, flex: false, grid: false, overflow: false, glow: false }],
    ];
    for (const [name, block, path, expected] of MATRIX) {
      assert.deepEqual(styleCapabilities(styleTargetFor(block, path)), expected, name);
    }
  });

  test("the panel has a label and a group for every token, and no orphans", () => {
    const grouped = new Set(Object.values(STYLE_GROUPS).flat());
    for (const token of STYLE_TOKEN_KEYS) {
      assert.ok(STYLE_TOKEN_LABELS[token], `${token} has no label`);
      assert.ok(grouped.has(token), `${token} is in no group, so the panel would never draw it`);
    }
    for (const token of grouped) {
      assert.ok((STYLE_TOKEN_KEYS as readonly string[]).includes(token), `${token} is grouped and is not a token`);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("what the registry claims about a node is what the block renders", () => {
  const source = (file: string) => readFileSync(path.join(REPO_ROOT, file), "utf8");

  /**
   * The element a block annotates with a given path, as the source writes it.
   *
   * A declaration that says "grid" while the markup says otherwise would be a
   * capability nobody could see — the panel would offer a column count on a box
   * that never lays anything out. The claim and the markup are written in two
   * files, so something has to compare them.
   */
  const annotatedTag = (file: string, path: string): string | null => {
    const text = source(file);
    const at = text.indexOf(`node("${path}")`);
    if (at === -1) return null;
    const open = text.lastIndexOf("<", at);
    return open === -1 ? null : text.slice(open, at);
  };

  const CONTAINERS: { block: string; file: string; field: string }[] = [
    { block: "quick-links", file: "src/components/site/blocks/quick-links.tsx", field: "links" },
    { block: "why-us", file: "src/components/site/blocks/why-us.tsx", field: "points" },
    { block: "stats", file: "src/components/site/blocks/stats.tsx", field: "items" },
    { block: "featured-service", file: "src/components/site/blocks/featured-service.tsx", field: "points" },
    { block: "destination-feature", file: "src/components/site/blocks/destination-feature.tsx", field: "destinations" },
    { block: "travel-feature", file: "src/components/site/blocks/travel-feature.tsx", field: "capabilities" },
    { block: "process", file: "src/components/site/blocks/process.tsx", field: "steps" },
  ];

  test("every declared layout container is annotated, and its markup lays out that way", () => {
    for (const { block, file, field } of CONTAINERS) {
      const tag = annotatedTag(file, `field:${field}`);
      assert.ok(tag, `${block} does not annotate field:${field}`);
      const declared = getBlock(block)!.fields.find((entry) => entry.name === field)!.box;
      if (declared === "grid") assert.match(tag, /\bgrid\b/, `${block} field:${field} is declared a grid`);
      if (declared === "flex") assert.match(tag, /\bflex\b/, `${block} field:${field} is declared flex`);
      if (declared === undefined) {
        assert.ok(!/\b(grid|flex)\b/.test(tag), `${block} field:${field} lays out and is not declared`);
      }
    }
  });

  test("a repeatable list either has a container to point at, or is documented as having none", () => {
    /**
     * The two that render no list box of their own: the hero's rotating words
     * are one inline span inside the headline, and One Desk's paths are labels
     * feeding a diagram. Neither is a node an editor can lay out, and pretending
     * otherwise would be the invented identity §3 rules out.
     */
    const WITHOUT_CONTAINER = new Set(["hero:words", "one-desk:paths"]);
    const files = new Map(CONTAINERS.map((entry) => [`${entry.block}:${entry.field}`, entry.file]));
    for (const block of BLOCKS) {
      for (const field of block.fields) {
        if (field.type !== "items") continue;
        const key = `${block.type}:${field.name}`;
        if (WITHOUT_CONTAINER.has(key)) {
          assert.ok(field.box === "inline" || field.box === undefined, `${key} claims a layout it has no box for`);
          continue;
        }
        // `egypt-feature` is the same renderer as `destination-feature`.
        const file = files.get(key) ?? files.get(`destination-feature:${field.name}`);
        assert.ok(file, `${key} has no annotated container and is not documented as having none`);
        assert.ok(annotatedTag(file, `field:${field.name}`), `${key} is not annotated in ${file}`);
      }
    }
  });

  test("the stylesheet has a rule for every new declaration at both widths", () => {
    const stylesheet = source("src/styles/globals.css");
    for (const property of ["width", "height", "min-height", "flex-direction", "flex-wrap", "justify-content", "align-items", "grid-template-columns", "overflow"]) {
      for (const [breakpoint, attribute] of Object.entries(RESPONSIVE_ATTR)) {
        const rule = `[${attribute}~="${property}"] { ${property}: var(${RESPONSIVE_PREFIX[breakpoint as "tablet" | "mobile"]}${property}) !important; }`;
        assert.ok(stylesheet.includes(rule), `missing: ${rule}`);
      }
    }
  });

  test("the glow values are defined in the stylesheet, for both grounds", () => {
    const stylesheet = source("src/styles/globals.css");
    for (const name of ["--glow-soft", "--glow-accent", "--glow-strong"]) {
      assert.ok(stylesheet.includes(`${name}:`), `${name} is referenced and never defined`);
      // Twice: once on the dark ground, once retinted for the warm-white island.
      assert.ok(
        stylesheet.split(`${name}:`).length - 1 >= 2,
        `${name} has no value for the light surfaces`,
      );
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("an advanced style is edited, reset and copied like any other", () => {
  test("a duplicate carries the layout onto the copy's own rows", () => {
    const ids = new Map([["i_aaaaaaaaaa", "i_bbbbbbbbbb"]]);
    const document = doc({
      root: { base: { layout: "flex", minHeight: "half-screen" } },
      "field:links": { base: { layout: "grid", columns: 4 }, mobile: { columns: 1 } },
      "field:links/item:i_aaaaaaaaaa": { base: { width: "half", glow: "soft" } },
      "field:links/item:i_aaaaaaaaaa/field:image": { base: { overflow: "hidden", height: "fit" } },
    });
    const copy = remapStyleItemIds(document, ids);

    assert.deepEqual(copy.nodes["root"], document.nodes["root"]);
    assert.deepEqual(copy.nodes["field:links"], document.nodes["field:links"]);
    assert.deepEqual(copy.nodes["field:links/item:i_bbbbbbbbbb"], { base: { width: "half", glow: "soft" } });
    assert.deepEqual(copy.nodes["field:links/item:i_bbbbbbbbbb/field:image"], {
      base: { overflow: "hidden", height: "fit" },
    });
    // Nothing is left pointing at the row it was copied from.
    for (const key of Object.keys(copy.nodes)) {
      assert.ok(!key.includes("i_aaaaaaaaaa"), `${key} still names the original row`);
    }
  });

  test("a copy drops an override for a row it does not have", () => {
    const document = doc({ "field:links/item:i_cccccccccc": { base: { columns: 2 } } });
    const copy = remapStyleItemIds(document, new Map([["i_aaaaaaaaaa", "i_bbbbbbbbbb"]]));
    assert.deepEqual(copy.nodes, {});
  });
});

/* -------------------------------------------------------------------------- */

describe("many styled nodes stay deterministic and stay small", () => {
  test("a page's worth of layout overrides renders identically every time", () => {
    const nodes: Record<string, unknown> = {};
    for (let index = 0; index < 200; index += 1) {
      // Ids written in the real alphabet. A padded decimal would not do: `0`
      // and `1` are deliberately absent from it, so those rows would be
      // rejected and this would quietly measure a smaller document.
      const id = `i_aaaaaaa${ITEM_ID_ALPHABET[Math.floor(index / 56)]}${ITEM_ID_ALPHABET[index % 56]}${ITEM_ID_ALPHABET[index % 7]}`;
      nodes[`field:list/item:${id}`] = {
        base: { layout: "grid", columns: (index % GRID_COLUMNS_MAX) + 1, glow: "soft", width: "half" },
        tablet: { columns: 2, justify: "between" },
        mobile: { columns: 1, direction: "column", overflow: "hidden" },
      };
    }
    const document = doc(nodes);
    assert.equal(Object.keys(document.nodes).length, 200);

    const once = Object.keys(document.nodes).map((path) => [
      JSON.stringify(nodeStyle(document, path)),
      JSON.stringify(responsiveStyle(document, path)),
    ]);
    const twice = Object.keys(document.nodes).map((path) => [
      JSON.stringify(nodeStyle(document, path)),
      JSON.stringify(responsiveStyle(document, path)),
    ]);
    assert.deepEqual(twice, once);

    // Each node carries its own declarations and nothing else: no stylesheet is
    // generated per node, and no rule is duplicated per node — the rules live in
    // `globals.css` and the element contributes values.
    const sample = responsiveStyle(document, Object.keys(document.nodes)[0]!)!;
    assert.deepEqual(Object.keys(sample.attrs).sort(), ["data-rs-m", "data-rs-t"]);
    // The order is the renderer's own emission order, which is fixed in source
    // — the point of naming it here is that it cannot start depending on the
    // key order of whatever object arrived.
    assert.equal(sample.attrs["data-rs-t"], "justify-content grid-template-columns");
    assert.equal(sample.attrs["data-rs-m"], "flex-direction grid-template-columns overflow");
  });
});
