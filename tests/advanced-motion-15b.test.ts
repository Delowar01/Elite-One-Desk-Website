/**
 * Batch 15b: parallax, hover, word reveal and Replay — every invariant that can
 * be asked of the source without a browser.
 *
 * The same governing rules as Batch 15a, carried to three more keys and one
 * more message:
 *
 *   · **Nothing stored is CSS.** Parallax, hover and text reveal are closed
 *     enumerations in the same v1 document, rebuilt on every read and write;
 *     every distance, scale and step is written in source.
 *   · **One authority per property.** An element's `translate` and `scale` are
 *     composed by one rule from contributions that each have one owner — the
 *     entrance, the parallax runtime, the hover — so none can overwrite
 *     another.
 *   · **A control that does nothing is not offered**, and what the panel hides
 *     the server strips: the capability resolver decides, from the registry,
 *     and `motionForBlock` enforces it on save and at render.
 *   · **Replay changes nothing that is stored** and cannot be steered by a
 *     stale canvas.
 *
 * The running application — saves, publication, history, isolation of the
 * public page — is `visual-motion-15b.test.ts`.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement, Fragment } from "react";

import { REPO_ROOT } from "./helpers/env";

import { BLOCKS, getBlock, type FieldDef, type ItemFieldDef } from "@/lib/cms/blocks";
import { remapMotionItemIds } from "@/lib/cms/duplicate";
import { newItemId } from "@/lib/cms/item-id";
import {
  animatesAnywhere,
  branchVars,
  HOVER_LIFT_PX,
  HOVER_NUDGE_PX,
  HOVER_SCALE,
  HOVER_ZOOM,
  hoversAnywhere,
  MOTION_VARIABLES,
  motionStyle,
  PARALLAX_DISTANCE,
  parallaxAnywhere,
  WORD_BLUR_PX,
  WORD_CAP,
  WORD_LIMIT,
  WORD_STEP_MS,
  wordsAnywhere,
} from "@/lib/cms/motion-css";
import {
  HOVERS,
  MOTION_DOCUMENT_VERSION,
  PARALLAX,
  resolveBranch,
  TEXT_REVEALS,
  validateMotionBranch,
  validateMotionDocument,
  type MotionDocument,
  type MotionTarget,
} from "@/lib/cms/motion-doc";
import { legacyProjection, legacySectionPreset } from "@/lib/cms/motion-doc";
import { motionPromotion } from "@/lib/cms/motion-write";
import { blockNode } from "@/lib/cms/node";
import { snapshotFromSections, validatePageSnapshot, PAGE_SNAPSHOT_VERSION } from "@/lib/cms/snapshot";
import { validateBlockValues } from "@/lib/cms/validate";
import { joinWords, splitWords, wordCount } from "@/lib/cms/words";
import {
  hoversFor,
  motionForBlock,
  motionTargetFor,
  motionValueLabel,
  offeredMotionFields,
  PARALLAX_PAUSED_NOTE,
} from "@/lib/visual-editor/motion-targets";
import {
  envelope,
  PROTOCOL_VERSION,
  readCanvasMessage,
  readEditorMessage,
  REPLAY_MODES,
  REPLAY_OUTCOMES,
} from "@/lib/visual-editor/protocol";
import { acceptReplayResult, REPLAY_STATUS, type ReplaySession } from "@/lib/visual-editor/replay";
import type { MotionCapability } from "@/lib/visual-editor/motion-targets";

const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), "utf8");
/** A capability's fields as plain names — a refusal's are an empty tuple. */
const fieldsOf = (capability: MotionCapability): readonly string[] => capability.fields;
/** Source with its comments removed, so a rule is matched and never its explanation. */
const code = (file: string) => read(file).replace(/\/\*[\s\S]*?\*\/|(^|[^:])\/\/.*$/gm, "$1");
const css = read("src/styles/globals.css");
const cssCode = css.replace(/\/\*[\s\S]*?\*\//g, "");
/** Batch 15b's own block of the stylesheet, from its header to the reduced-motion rules. */
const css15b = cssCode.slice(
  cssCode.indexOf("@property --m-py"),
  cssCode.indexOf("@media (prefers-reduced-motion: reduce) {\n  [data-m-reveal]"),
);

const doc = (section: MotionTarget = {}, nodes: Record<string, MotionTarget> = {}): MotionDocument => ({
  v: MOTION_DOCUMENT_VERSION,
  section,
  nodes,
});

/** Every registry field, with its block, for the sweeps below. */
type Declared = { block: string; path: string; field: FieldDef | ItemFieldDef };
const declared: Declared[] = [];
for (const block of BLOCKS) {
  for (const field of block.fields) {
    declared.push({ block: block.type, path: `field:${field.name}`, field });
    for (const inner of field.itemFields ?? []) {
      declared.push({ block: block.type, path: `field:${field.name}/item:${newItemId()}/field:${inner.name}`, field: inner });
    }
  }
}

/* ========================================================================== */

describe("the three new keys are a closed vocabulary in the same v1 document", () => {
  test("every value of every new key survives validation, and the document is still version 1", () => {
    assert.equal(MOTION_DOCUMENT_VERSION, 1);
    assert.deepEqual([...PARALLAX], ["none", "subtle", "medium", "strong"]);
    assert.deepEqual([...HOVERS], ["none", "lift", "scale", "zoom", "nudge"]);
    assert.deepEqual([...TEXT_REVEALS], ["none", "words"]);
    for (const parallax of PARALLAX) assert.deepEqual(validateMotionBranch({ parallax }), { parallax });
    for (const hover of HOVERS) assert.deepEqual(validateMotionBranch({ hover }), { hover });
    for (const textReveal of TEXT_REVEALS) assert.deepEqual(validateMotionBranch({ textReveal }), { textReveal });
  });

  test("anything outside the vocabulary is dropped, never guessed at", () => {
    const hostile: unknown[] = [
      "extreme",
      "Subtle",
      " subtle",
      "glow",
      "rotate",
      "letters",
      "lines",
      "chars",
      12,
      -36,
      1e308,
      Number.POSITIVE_INFINITY,
      Number.NaN,
      "24px",
      "translateY(40px)",
      "calc(100vh)",
      "var(--m-py)",
      "url(javascript:alert(1))",
      "</style><script>alert(1)</script>",
      "[data-m-hv]:hover",
      ".btn",
      { value: "subtle" },
      ["subtle"],
      null,
      true,
    ];
    for (const value of hostile) {
      assert.deepEqual(validateMotionBranch({ parallax: value, hover: value, textReveal: value }), {}, String(value));
    }
  });

  test("an arbitrary distance, axis, scale or duration key is not a key", () => {
    assert.deepEqual(
      validateMotionBranch({
        parallax: "subtle",
        parallaxDistance: 400,
        distance: "400px",
        axis: "left",
        hoverScale: 3,
        hoverShadow: "0 0 40px red",
        glow: "strong",
        wordStep: 1,
        speed: 9,
      }),
      { parallax: "subtle" },
    );
  });

  test("an inherited key is not a submitted one", () => {
    const polluted = Object.create({ parallax: "strong", hover: "zoom" }) as Record<string, unknown>;
    polluted.textReveal = "words";
    assert.deepEqual(validateMotionBranch(polluted), { textReveal: "words" });
    const documentFromPrototype = Object.create({ v: 1, section: { base: { entrance: "fade" } } });
    assert.deepEqual(validateMotionDocument(documentFromPrototype), doc(), "a prototype's v made it a document");
    // JSON.parse makes `__proto__` an own key, which is simply not a key we know.
    const parsed = JSON.parse('{"v":1,"section":{},"nodes":{"field:title":{"base":{"__proto__":{"hover":"zoom"},"parallax":"subtle","constructor":"x"}}}}');
    assert.deepEqual(validateMotionDocument(parsed), doc({}, { "field:title": { base: { parallax: "subtle" } } }));
    assert.equal(({} as Record<string, unknown>).hover, undefined, "the prototype was polluted");
  });

  test("a malformed or hostile node path is not an address", () => {
    const branch = { base: { parallax: "medium", hover: "lift", textReveal: "words" } };
    const out = validateMotionDocument({
      v: 1,
      section: {},
      nodes: {
        "field:title": branch,
        "div > p": branch,
        "[data-m-hv]": branch,
        "section:4/field:title": branch,
        root: branch,
        "field:title;color:red": branch,
        "": branch,
      },
    });
    assert.deepEqual(Object.keys(out.nodes), ["field:title"]);
  });

  test("a newer document, null, an array or a string is the empty document — without throwing", () => {
    for (const input of [{ v: 2, section: { base: { parallax: "strong" } } }, null, undefined, [], "doc", 7, { v: "1" }]) {
      assert.deepEqual(validateMotionDocument(input), doc(), JSON.stringify(input) ?? String(input));
    }
  });

  test("validation is idempotent and canonical with the new keys in any order", () => {
    const a = validateMotionDocument({
      v: 1,
      section: { base: { entrance: "fade" } },
      nodes: {
        "field:title": { mobile: { textReveal: "none" }, base: { textReveal: "words", parallax: "subtle" } },
        "field:image": { base: { hover: "zoom" } },
      },
    });
    const b = validateMotionDocument({
      nodes: {
        "field:image": { base: { hover: "zoom" } },
        "field:title": { base: { parallax: "subtle", textReveal: "words" }, mobile: { textReveal: "none" } },
      },
      section: { base: { entrance: "fade" } },
      v: 1,
    });
    assert.deepEqual(validateMotionDocument(a), a);
    assert.equal(JSON.stringify(Object.keys(a.nodes)), JSON.stringify(Object.keys(b.nodes)));
    assert.deepEqual(a, b);
  });

  test("the legacy projection ignores the new keys: an older build still sees the section's entrance", () => {
    const withAll = doc({ base: { entrance: "blur" } }, { "field:title": { base: { parallax: "strong", textReveal: "words" } } });
    assert.equal(legacyProjection(withAll, "fade-up"), "fade");
    assert.equal(legacySectionPreset({ base: { entrance: "fade-up" } }), "fade-up");
  });
});

/* ========================================================================== */

describe("parallax, hover and words inherit Base → Tablet → Mobile, sparsely", () => {
  const target: MotionTarget = {
    base: { parallax: "strong", hover: "lift", textReveal: "words" },
    tablet: { parallax: "subtle" },
    mobile: { parallax: "none", hover: "none", textReveal: "none" },
  };

  test("each width resolves its own keys over the ones above it", () => {
    assert.deepEqual(resolveBranch(target, "base"), { parallax: "strong", hover: "lift", textReveal: "words" });
    assert.deepEqual(resolveBranch(target, "tablet"), { parallax: "subtle", hover: "lift", textReveal: "words" });
    assert.deepEqual(resolveBranch(target, "mobile"), { parallax: "none", hover: "none", textReveal: "none" });
  });

  test("resetting Mobile means Tablet's, and resetting Tablet means Base's", () => {
    const withoutMobile: MotionTarget = { base: target.base, tablet: target.tablet };
    assert.equal(resolveBranch(withoutMobile, "mobile").parallax, "subtle");
    const withoutTablet: MotionTarget = { base: target.base };
    assert.equal(resolveBranch(withoutTablet, "mobile").parallax, "strong");
    assert.equal(resolveBranch(withoutTablet, "tablet").textReveal, "words");
  });

  test("a narrower width writes only what it declares — an inherited value is never copied down", () => {
    const style = motionStyle({ base: { parallax: "medium", hover: "scale" }, mobile: { parallax: "none" } })!;
    assert.equal(style.vars["--m-pd"], `${PARALLAX_DISTANCE.medium}px`);
    assert.equal(style.vars["--m-hvs"], String(HOVER_SCALE));
    assert.equal(style.attrs["data-m-t"], undefined, "tablet declared nothing and wrote something");
    assert.equal(style.attrs["data-m-m"], "pd");
    assert.equal(style.vars["--m-m-pd"], "0px");
    assert.equal(style.vars["--m-m-hvs"], undefined, "mobile copied an inherited hover");
  });

  test("a width that changes the hover rewrites all four hover variables, so nothing of the old one is left", () => {
    const style = motionStyle({ base: { hover: "lift" }, tablet: { hover: "scale" } })!;
    assert.deepEqual(style.attrs["data-m-t"]!.split(" ").sort(), ["hvb", "hvs", "hvx", "hvy", "hvz"]);
    assert.equal(style.vars["--m-t-hvy"], "0px", "Scale kept Lift's rise underneath it");
    assert.equal(style.vars["--m-t-hvs"], String(HOVER_SCALE));
  });

  test("Mobile none presents the text whole", () => {
    const style = motionStyle({ base: { textReveal: "words" }, mobile: { textReveal: "none" } })!;
    assert.equal(style.vars["--m-wr"], "1");
    assert.equal(style.vars["--m-m-wr"], "0");
    assert.equal(style.attrs["data-m-m"], "wr");
  });

  test("every new variable has its promote rule at both widths, like every 15a one", () => {
    for (const name of ["pd", "hvx", "hvy", "hvs", "hvz", "hvb", "wr"]) {
      assert.ok((MOTION_VARIABLES as readonly string[]).includes(name), name);
      assert.ok(cssCode.includes(`[data-m-t~="${name}"] { --m-${name}: var(--m-t-${name}) !important; }`), `tablet ${name}`);
      assert.ok(cssCode.includes(`[data-m-m~="${name}"] { --m-${name}: var(--m-m-${name}) !important; }`), `mobile ${name}`);
    }
  });

  test("the questions the renderer asks are asked at every width", () => {
    assert.equal(parallaxAnywhere({ mobile: { parallax: "subtle" } }), true);
    assert.equal(parallaxAnywhere({ base: { parallax: "none" } }), false);
    assert.equal(hoversAnywhere({ tablet: { hover: "nudge" } }), true);
    assert.equal(hoversAnywhere({ base: { hover: "none" } }), false);
    assert.equal(wordsAnywhere({ mobile: { textReveal: "words" } }), true);
    assert.equal(wordsAnywhere({ base: { textReveal: "none" } }), false);
    // Words are a way of arriving: they need the element's lifecycle.
    assert.equal(animatesAnywhere({ base: { textReveal: "words" } }), true);
    assert.equal(animatesAnywhere({ base: { parallax: "strong", hover: "lift" } }), false);
  });
});

/* ========================================================================== */

describe("one capability resolver decides what may drift, answer a hover, or arrive word by word", () => {
  test("the section wrapper takes no parallax, no hover and no words", () => {
    const section = motionTargetFor("why-us", "root");
    for (const field of ["parallax", "hover", "textReveal"] as const) assert.ok(!fieldsOf(section).includes(field), field);
    assert.deepEqual(hoversFor(section), []);
  });

  test("a list drifts as one; its rows lift or grow; a card row owns its hover", () => {
    const list = motionTargetFor("why-us", "field:points");
    assert.ok(fieldsOf(list).includes("parallax"));
    assert.ok(!fieldsOf(list).includes("hover"));
    const row = motionTargetFor("why-us", `field:points/item:${newItemId()}`);
    assert.ok(!fieldsOf(row).includes("parallax"), "rows of one grid would drift apart");
    assert.deepEqual(hoversFor(row), ["none", "lift", "scale"]);
    const card = motionTargetFor("quick-links", `field:links/item:${newItemId()}`);
    assert.ok(!fieldsOf(card).includes("hover"), "a .ql-card already lifts, zooms and nudges");
    const cardPicture = motionTargetFor("quick-links", `field:links/item:${newItemId()}/field:image`);
    assert.ok(!fieldsOf(cardPicture).includes("hover") && !fieldsOf(cardPicture).includes("parallax"));
  });

  test("a picture scales or zooms and drifts; a backdrop does neither", () => {
    const picture = motionTargetFor("image-text", "field:image");
    assert.deepEqual(hoversFor(picture), ["none", "scale", "zoom"]);
    assert.ok(fieldsOf(picture).includes("parallax"));
    for (const [block, path] of [
      ["hero", "field:backgroundImage"],
      ["page-hero", "field:backgroundImage"],
    ] as const) {
      const backdrop = motionTargetFor(block, path);
      assert.ok(!fieldsOf(backdrop).includes("hover") && !fieldsOf(backdrop).includes("parallax"), block);
      assert.ok(fieldsOf(backdrop).includes("entrance"), "the 15a entrance a backdrop had is kept");
    }
  });

  test("a call to action lifts or nudges; its lift replaces the button's own rather than doubling it", () => {
    for (const [block, path] of [
      ["hero", "field:primaryCtaLabel"],
      ["hero", "field:secondaryCtaLabel"],
      ["final-cta", "field:primaryCtaLabel"],
      ["image-text", "field:ctaLabel"],
      ["destination-feature", "field:secondaryCtaLabel"],
    ] as const) {
      assert.deepEqual(hoversFor(motionTargetFor(block, path)), ["none", "lift", "nudge"], `${block} ${path}`);
    }
    // `.btn:hover` rises by one pixel times `--m-hvb`; the editor's Lift sets it
    // to 0, every other choice leaves it at 1.
    assert.match(cssCode, /\.btn:hover \{ transform: translateY\(calc\(-1px \* var\(--m-hvb, 1\)\)\); \}/);
    assert.match(cssCode, /@property --m-hvb \{\s*syntax: "<number>";\s*inherits: false;\s*initial-value: 1;\s*\}/);
    assert.equal(branchVars({ hover: "lift" }).hvb, "0");
    for (const hover of ["none", "scale", "zoom", "nudge"] as const) assert.equal(branchVars({ hover }).hvb, "1", hover);
    // Plain text is not something a visitor follows.
    assert.deepEqual(hoversFor(motionTargetFor("why-us", "field:title")), []);
  });

  test("words only on single-line copy in both editions — never a paragraph, rich text, a figure or a filter", () => {
    for (const entry of declared) {
      const capability = motionTargetFor(entry.block, entry.path);
      if (capability.kind === null) continue;
      const type = entry.field.type ?? "text";
      const short = type === "text" && entry.field.localised === true;
      assert.equal(fieldsOf(capability).includes("textReveal"), short, `${entry.block} ${entry.path} (${type})`);
    }
    assert.ok(!fieldsOf(motionTargetFor("rich-text", "field:body")).includes("textReveal"));
    assert.ok(!fieldsOf(motionTargetFor("final-cta", "field:body")).includes("textReveal"));
    assert.ok(!fieldsOf(motionTargetFor("why-us", `field:points/item:${newItemId()}/field:text`)).includes("textReveal"));
    assert.ok(!fieldsOf(motionTargetFor("stats", `field:items/item:${newItemId()}/field:value`)).includes("textReveal"));
    assert.ok(!fieldsOf(motionTargetFor("packages-grid", "field:destination")).includes("textReveal"));
  });

  test("an element with its own keyframes, an inline span and an icon still offer nothing at all", () => {
    for (const [block, path, reason] of [
      ["hero", "field:headline", "own"],
      ["page-hero", "field:title", "own"],
      ["hero", "field:words", "inline"],
      ["quick-links", `field:links/item:${newItemId()}/field:icon`, "glyph"],
    ] as const) {
      const capability = motionTargetFor(block, path);
      assert.equal(capability.kind, null, `${block} ${path}`);
      assert.equal(capability.kind === null && capability.reason, reason);
    }
  });

  test("the panel shows the new controls wherever the node has them, entrance or not", () => {
    const title = motionTargetFor("why-us", "field:title");
    assert.deepEqual([...offeredMotionFields(title, undefined, "base")], ["entrance", "parallax", "textReveal"]);
    // Words arrive on the node's own timing, so timing is offered with them.
    assert.deepEqual(
      [...offeredMotionFields(title, { base: { textReveal: "words" } }, "base")],
      ["entrance", "duration", "delay", "easing", "parallax", "textReveal"],
    );
    const cta = motionTargetFor("final-cta", "field:primaryCtaLabel");
    assert.deepEqual([...offeredMotionFields(cta, undefined, "base")], ["entrance", "parallax", "textReveal", "hover"]);
  });

  test("the server strips what the panel would never offer — keys and values alike", () => {
    const id = newItemId();
    const cut = motionForBlock(
      doc(
        { base: { entrance: "fade", parallax: "strong", hover: "lift", textReveal: "words" } },
        {
          "field:image": { base: { textReveal: "words", hover: "zoom", parallax: "subtle" } },
          "field:title": { base: { hover: "zoom", textReveal: "words" } },
          "field:ctaLabel": { base: { hover: "zoom" }, tablet: { hover: "scale" }, mobile: { hover: "nudge" } },
          "field:body": { base: { textReveal: "words", parallax: "medium" } },
        },
      ),
      "image-text",
    );
    assert.deepEqual(cut.section, { base: { entrance: "fade" } }, "the section kept a drift, a hover or words");
    assert.deepEqual(cut.nodes["field:image"], { base: { hover: "zoom", parallax: "subtle" } }, "words on a picture");
    assert.deepEqual(cut.nodes["field:title"], { base: { textReveal: "words" } }, "Zoom on a heading");
    assert.deepEqual(cut.nodes["field:ctaLabel"], { mobile: { hover: "nudge" } }, "a zoom or a scale on a button");
    assert.deepEqual(cut.nodes["field:body"], { base: { parallax: "medium" } }, "words on rich text");

    const rows = motionForBlock(
      doc({}, {
        [`field:points/item:${id}`]: { base: { hover: "zoom", parallax: "strong" }, tablet: { hover: "scale" } },
      }),
      "why-us",
    );
    assert.deepEqual(rows.nodes[`field:points/item:${id}`], { tablet: { hover: "scale" } });

    const backdrop = motionForBlock(doc({}, { "field:backgroundImage": { base: { hover: "scale", parallax: "subtle", entrance: "fade" } } }), "hero");
    assert.deepEqual(backdrop.nodes["field:backgroundImage"], { base: { entrance: "fade" } });

    const own = motionForBlock(doc({}, { "field:headline": { base: { parallax: "subtle", textReveal: "words" } } }), "hero");
    assert.deepEqual(own.nodes, {}, "an element with its own keyframes kept a drift or words");
    assert.deepEqual(motionForBlock(cut, "image-text"), cut, "cutting twice changed it");
  });

  test("the registry declares every call to action a button, and only those", () => {
    for (const block of BLOCKS) {
      for (const field of block.fields) {
        const cta = /^(ctaLabel|[a-z]+CtaLabel)$/.test(field.name);
        assert.equal(field.surface === "button", cta, `${block.type} ${field.name}`);
      }
    }
    assert.equal(getBlock("hero")!.fields.find((f) => f.name === "backgroundImage")!.surface, "backdrop");
    assert.equal(getBlock("page-hero")!.fields.find((f) => f.name === "backgroundImage")!.surface, "backdrop");
    const links = getBlock("quick-links")!.fields.find((f) => f.name === "links")!;
    assert.equal(links.surface, "card");
    assert.equal(links.itemFields!.find((f) => f.name === "image")!.surface, "card");
  });

  test("every value a renderer reads, and every node it annotates, is a field its block declares", () => {
    // The validator rebuilds a section's values from these declarations and
    // drops anything undeclared, so a renderer reading a name the registry
    // does not declare loses that value on the next save. That is how the
    // unprefixed calls to action (`ctaLabel`, declared as `CtaLabel`) vanished
    // from four blocks whenever one of them was edited — fixed in Batch 15b.
    for (const block of BLOCKS) {
      const file = block.type === "egypt-feature" ? "destination-feature" : block.type;
      const source = read(`src/components/site/blocks/${file}.tsx`);
      const names = new Set(block.fields.map((field) => field.name));
      const used = [
        ...[...source.matchAll(/\b(?:text|str|items|mediaId|bool|num)\(values, "([A-Za-z]+)"/g)].map((m) => m[1]!),
        ...[...source.matchAll(/"field:([A-Za-z]+)"/g)].map((m) => m[1]!),
        ...[...source.matchAll(/\bitem(?:Field)?Path\("([A-Za-z]+)"/g)].map((m) => m[1]!),
        ...[...source.matchAll(/fields=\{\{([^}]*)\}\}/g)].flatMap((m) =>
          [...m[1]!.matchAll(/:\s*"([A-Za-z]+)"/g)].map((x) => x[1]!),
        ),
      ];
      assert.ok(used.length > 0, `${block.type}: nothing found in ${file}.tsx`);
      for (const name of used) assert.ok(names.has(name), `${block.type} reads or annotates "${name}", which it does not declare`);
      for (const match of source.matchAll(/itemFieldPath\("([A-Za-z]+)", [a-z]+, "([A-Za-z]+)"\)/g)) {
        const list = block.fields.find((field) => field.name === match[1]);
        assert.ok(list?.itemFields?.some((field) => field.name === match[2]), `${block.type} ${match[1]}.${match[2]}`);
      }
    }
  });

  test("a call to action's text and link survive a save of its section, in every block", () => {
    for (const block of BLOCKS) {
      for (const field of block.fields.filter((entry) => entry.surface === "button")) {
        const href = field.name.replace(/Label$/, "Href");
        const kept = validateBlockValues(block, { [field.name]: { en: "Book now", ar: "احجز الآن" }, [href]: "/contact" });
        assert.deepEqual(kept[field.name], { en: "Book now", ar: "احجز الآن" }, `${block.type} ${field.name}`);
        assert.equal(kept[href], "/contact", `${block.type} ${href}`);
      }
    }
    for (const type of ["featured-service", "image-text", "travel-feature", "one-desk"]) {
      const names = getBlock(type)!.fields.map((field) => field.name);
      assert.ok(names.includes("ctaLabel") && names.includes("ctaHref"), type);
      assert.ok(!names.includes("CtaLabel") && !names.includes("CtaHref"), type);
    }
  });

  test("a button's own lift, a card's own hover, a backdrop's pointer-events are what the registry says", () => {
    // The markup facts the declarations describe, read back from the sources so
    // a declaration cannot outlive the element it describes. The rendered pages
    // are checked the same way in visual-motion-15b.test.ts.
    assert.match(css, /\.btn:hover \{ transform: translateY\(calc\(-1px \* var\(--m-hvb, 1\)\)\); \}/);
    const quick = read("src/components/site/blocks/quick-links.tsx");
    assert.match(quick, /\{\.\.\.node\(itemPath\("links", link\), "item"\)\}\s*>\s*<Link[\s\S]*?className="ql-card"/);
    assert.match(css, /\.ql-card:hover,\s*\.ql-card:focus-visible \{\s*transform: translateY\(-2px\);/);
    assert.match(css, /\.ql-card:hover \.ql-img,\s*\.ql-card:focus-visible \.ql-img \{ transform: scale\(1\.05\); \}/);
    for (const file of ["hero", "page-hero"]) {
      assert.match(
        read(`src/components/site/blocks/${file}.tsx`),
        /<div className="pointer-events-none absolute inset-0 -z-20" \{\.\.\.backgroundNode\.box\}>/,
        file,
      );
    }
  });

  test("labels say what each value does, with the source's own numbers", () => {
    assert.equal(motionValueLabel("hover", "nudge"), `Nudge · ${HOVER_NUDGE_PX}px toward the reading direction`);
    assert.equal(motionValueLabel("parallax", "none"), "No parallax");
    assert.equal(motionValueLabel("parallax", "strong"), `Strong · up to ${PARALLAX_DISTANCE.strong}px`);
    assert.equal(motionValueLabel("hover", "none"), "No hover");
    assert.equal(motionValueLabel("hover", "lift"), `Lift · rises ${HOVER_LIFT_PX}px`);
    assert.equal(motionValueLabel("textReveal", "words"), "Word by word");
    assert.equal(motionValueLabel("entrance", "none"), "No entrance", "the 15a labels moved");
    assert.equal(PARALLAX_PAUSED_NOTE, "Parallax is paused while editing. Use Replay to preview it.");
  });
});

/* ========================================================================== */

describe("composition: one authority for translate and scale", () => {
  test("distances, scales and steps are source constants, restrained, and the only numbers emitted", () => {
    assert.deepEqual(PARALLAX_DISTANCE, { none: 0, subtle: 12, medium: 24, strong: 36 });
    assert.equal(HOVER_LIFT_PX, 4);
    assert.equal(HOVER_NUDGE_PX, 4);
    assert.equal(HOVER_SCALE, 1.03);
    assert.equal(HOVER_ZOOM, 1.06);
    for (const parallax of PARALLAX) assert.deepEqual(branchVars({ parallax }), { pd: `${PARALLAX_DISTANCE[parallax]}px` });
    assert.deepEqual(branchVars({ hover: "lift" }), { hvx: "0px", hvy: "-4px", hvs: "1", hvz: "1", hvb: "0" });
    assert.deepEqual(branchVars({ hover: "scale" }), { hvx: "0px", hvy: "0px", hvs: "1.03", hvz: "1", hvb: "1" });
    assert.deepEqual(branchVars({ hover: "zoom" }), { hvx: "0px", hvy: "0px", hvs: "1", hvz: "1.06", hvb: "1" });
    assert.deepEqual(branchVars({ hover: "nudge" }), { hvx: "4px", hvy: "0px", hvs: "1", hvz: "1", hvb: "1" });
    assert.deepEqual(branchVars({ hover: "none" }), { hvx: "0px", hvy: "0px", hvs: "1", hvz: "1", hvb: "1" });
    assert.deepEqual(branchVars({ textReveal: "words" }), { wr: "1" });
    assert.deepEqual(branchVars({ textReveal: "none" }), { wr: "0" });
  });

  test("the four contributions are registered, non-inheriting properties", () => {
    for (const [name, syntax, initial] of [
      ["--m-py", "<length>", "0px"],
      ["--m-hx", "<length>", "0px"],
      ["--m-hy", "<length>", "0px"],
      ["--m-hs", "<number>", "1"],
    ]) {
      assert.match(
        cssCode,
        new RegExp(`@property ${name} \\{\\s*syntax: "${syntax}";\\s*inherits: false;\\s*initial-value: ${initial};\\s*\\}`),
        name,
      );
    }
  });

  test("the resting composition is one rule: nudge × sign, parallax + lift, hover scale", () => {
    assert.match(
      css15b,
      /\[data-m-px\],\s*\[data-m-hv\] \{\s*translate: calc\(var\(--m-hx\) \* var\(--m-sign\)\) calc\(var\(--m-py\) \+ var\(--m-hy\)\);\s*scale: var\(--m-hs\);\s*\}/,
    );
    // Nothing else in the layer writes translate or scale on these elements
    // outside the entrance keyframes, the waiting state and the picture's zoom.
    const translates = cssCode.match(/translate:\s*calc[^;]*;/g) ?? [];
    assert.ok(translates.every((line) => /--m-(x|hx|py|hy|y)/.test(line)), translates.join("\n"));
  });

  test("the entrance runs from its own offset plus the composition, to the composition — so nothing snaps", () => {
    const enter = cssCode.slice(cssCode.indexOf("@keyframes eod-m-enter"), cssCode.indexOf("@keyframes eod-m-mask"));
    assert.match(enter, /from \{[\s\S]*translate: calc\(\(var\(--m-x\) \+ var\(--m-hx, 0px\)\) \* var\(--m-sign\)\) calc\(var\(--m-y\) \+ var\(--m-py, 0px\) \+ var\(--m-hy, 0px\)\);/);
    assert.match(enter, /from \{[\s\S]*scale: calc\(var\(--m-scale\) \* var\(--m-hs, 1\)\);/);
    assert.match(enter, /to \{[\s\S]*translate: calc\(var\(--m-hx, 0px\) \* var\(--m-sign\)\) calc\(var\(--m-py, 0px\) \+ var\(--m-hy, 0px\)\);/);
    assert.match(enter, /to \{[\s\S]*scale: var\(--m-hs, 1\);/);
  });

  test("a nudge mirrors in Arabic: the sign is the writing direction's", () => {
    assert.match(css15b, /\[dir="rtl"\] \[data-m-px\],\s*\[dir="rtl"\] \[data-m-hv\] \{\s*--m-sign: -1;\s*\}/);
    assert.match(css15b, /\[data-m-px\],\s*\[data-m-hv\] \{[^}]*--m-sign: 1;/);
  });

  test("hover is pointer or keyboard focus, never a tabindex; and it never touches box-shadow", () => {
    assert.match(css15b, /@media \(hover: hover\) \{\s*\[data-m-hv\]:hover \{/);
    assert.match(css15b, /\[data-m-hv\]:is\(:focus-visible, :has\(:focus-visible\)\) \{\s*--m-hx: var\(--m-hvx\);\s*--m-hy: var\(--m-hvy\);\s*--m-hs: var\(--m-hvs\);\s*\}/);
    assert.match(css15b, /\[data-m-hv\]:is\(:focus-visible, :has\(:focus-visible\)\) > img \{\s*scale: var\(--m-hvz\);\s*\}/);
    assert.ok(!/box-shadow/.test(css15b), "the 15b layer writes box-shadow");
    for (const file of ["src/lib/cms/node.ts", "src/lib/cms/motion-css.ts", "src/components/site/motion-replay.ts"]) {
      assert.ok(!/tabindex|tabIndex/.test(code(file)), `${file} makes something focusable`);
    }
  });

  test("the existing button and reveal transitions consume the hover — they are not overridden", () => {
    const btn = cssCode.slice(cssCode.indexOf("  .btn {"), cssCode.indexOf("[dir=\"rtl\"] .btn {"));
    assert.match(btn, /box-shadow var\(--duration-base\) var\(--ease-out-soft\),\s*var\(--m-hover-transition\);/);
    const reveal = cssCode.slice(cssCode.indexOf("    .reveal {\n      opacity: 0;"));
    assert.match(reveal, /transform var\(--duration-slow\) var\(--ease-out-expo\),\s*var\(--m-hover-transition\);/);
    // The reveal's delay stays the reveal's: a hover never waits for a row's
    // place in the cascade.
    assert.match(reveal, /transition-delay: var\(--reveal-delay, 0ms\), var\(--reveal-delay, 0ms\), 0ms, 0ms, 0ms;/);
    // Always defined, so neither list is ever invalidated by a missing variable.
    assert.match(cssCode, /:root \{\s*--m-hover-transition:\s*--m-hx var\(--duration-base\) var\(--ease-out-expo\),\s*--m-hy var\(--duration-base\) var\(--ease-out-expo\),\s*--m-hs var\(--duration-base\) var\(--ease-out-expo\);\s*\}/);
  });

  test("no Style token can write a property the composition owns", () => {
    const styleCss = code("src/lib/cms/style-css.ts");
    for (const property of ["translate", "scale", "transform", "--m-py", "--m-hx", "--m-hy", "--m-hs"]) {
      assert.ok(!new RegExp(`\\bout\\.${property}\\b|["']${property}["']\\s*:`).test(styleCss), property);
    }
  });
});

/* ========================================================================== */

describe("word reveal: the stored sentence, split for the eye and read once", () => {
  test("tokenization keeps every character, in order, in every script", () => {
    const cases = [
      "We make complex journeys simple",
      "نجعل الرحلات المعقدة بسيطة",
      "Hello, world! (Really?) — yes…",
      "مرحبا، كيف حالك؟",
      "Two  spaces,\ttab\nand   more",
      "  leading and trailing  ",
      "Visit Riyadh الرياض and Cairo القاهرة",
      "2024: 1,500+ clients in 12 countries",
      "Elite One Desk مكتب واحد 2026",
      "no break here",
      "single",
      "",
    ];
    for (const text of cases) {
      assert.equal(joinWords(splitWords(text)), text, JSON.stringify(text));
    }
  });

  test("a word is a run of non-whitespace — punctuation stays with its word, whitespace is kept exactly", () => {
    assert.deepEqual(splitWords("مرحبا، كيف حالك؟"), [
      { word: "مرحبا،" },
      { space: " " },
      { word: "كيف" },
      { space: " " },
      { word: "حالك؟" },
    ]);
    assert.deepEqual(splitWords("Two  spaces"), [{ word: "Two" }, { space: "  " }, { word: "spaces" }]);
    assert.deepEqual(splitWords("no break"), [{ word: "no" }, { space: " " }, { word: "break" }]);
    assert.equal(wordCount("Visit Riyadh الرياض and Cairo القاهرة"), 6);
    assert.equal(wordCount("2024: 1,500+ clients"), 3);
    assert.equal(wordCount("   "), 0);
  });

  test("Arabic words are never reordered: logical order in, logical order out", () => {
    const text = "خدمات Elite One Desk للأعمال";
    const words = splitWords(text).filter((part) => "word" in part).map((part) => (part as { word: string }).word);
    assert.deepEqual(words, ["خدمات", "Elite", "One", "Desk", "للأعمال"]);
    assert.ok(!/reverse\(/.test(code("src/lib/cms/words.ts")) && !/reverse\(/.test(code("src/components/site/motion-replay.ts")));
  });

  const words = doc({}, { "field:title": { base: { entrance: "fade-up", textReveal: "words" } } });
  const render = (node: ReturnType<typeof blockNode>, text: string) => {
    const { attrs, content } = node.text("field:title", text);
    const { style, ...rest } = attrs;
    return renderToStaticMarkup(createElement("h2", { ...rest, style }, content as never));
  };

  test("the published page gets the words and the sentence once, with the parent marked", () => {
    const node = blockNode({ editor: null, styles: undefined, motion: words });
    const html = render(node, "We make complex journeys simple");
    assert.match(html, /^<h2 data-m-reveal="" data-m-words="" style="[^"]*--m-wr:1[^"]*">/);
    assert.match(html, /<span data-m-wa="">We make complex journeys simple<\/span>/);
    assert.match(
      html,
      /<span data-m-wv="" aria-hidden="true"><span data-m-w="">We<\/span> <span data-m-w="">make<\/span> <span data-m-w="">complex<\/span> <span data-m-w="">journeys<\/span> <span data-m-w="">simple<\/span><\/span>/,
    );
    // Read once: exactly one copy is not hidden from assistive technology.
    assert.equal((html.match(/aria-hidden="true"/g) ?? []).length, 1);
    assert.equal((html.match(/data-m-wa/g) ?? []).length, 1);
  });

  test("the Visual Editor's canvas renders the text whole, so direct editing types into text", () => {
    const node = blockNode({ editor: { sectionId: 9, blockType: "why-us" }, styles: undefined, motion: words });
    const html = render(node, "We make complex journeys simple");
    assert.ok(!/data-m-w|data-m-words|aria-hidden/.test(html), html);
    assert.match(html, />We make complex journeys simple<\/h2>$/);
    assert.match(html, /data-eod-edit="text"/);
  });

  test("with words off, too long, or empty, the markup is exactly what it was before", () => {
    const plain = blockNode({ editor: null, styles: undefined, motion: doc({}, { "field:title": { base: { entrance: "fade-up" } } }) });
    assert.ok(!/data-m-w/.test(render(plain, "We make complex journeys simple")));
    const node = blockNode({ editor: null, styles: undefined, motion: words });
    const long = Array.from({ length: WORD_LIMIT + 1 }, (_, i) => `w${i}`).join(" ");
    const longHtml = render(node, long);
    assert.ok(!/data-m-w/.test(longHtml), "a long value was split");
    assert.ok(longHtml.includes(long));
    const exact = Array.from({ length: WORD_LIMIT }, (_, i) => `w${i}`).join(" ");
    assert.equal((render(node, exact).match(/data-m-w=""/g) ?? []).length, WORD_LIMIT);
    assert.ok(!/data-m-w/.test(render(node, "   ")));
    const none = blockNode({ editor: null, styles: undefined, motion: null });
    assert.deepEqual(none.text("field:title", "Hello"), { attrs: {}, content: "Hello" });
  });

  test("the words take the element's fade only when the element really was split", () => {
    assert.match(css15b, /\[data-m-words\] \{\s*--m-wo: var\(--m-wr\);\s*\}/);
    assert.match(cssCode, /\[data-m-reveal\],\s*\[data-m-group\] \{[\s\S]*?--m-wr: 0;\s*--m-wo: 0;/);
  });

  test("one step per word and a cap, in the stylesheet and in source alike", () => {
    assert.equal(WORD_CAP, 12);
    assert.equal(WORD_STEP_MS, 60);
    assert.equal(WORD_BLUR_PX, 4);
    for (let n = 2; n < WORD_CAP; n += 1) {
      assert.ok(css15b.includes(`[data-m-wv] > [data-m-w]:nth-child(${n}) { --m-wi: ${n - 1}; }`), `word ${n}`);
    }
    assert.ok(css15b.includes(`[data-m-wv] > [data-m-w]:nth-child(n + ${WORD_CAP}) { --m-wi: ${WORD_CAP - 1}; }`));
    assert.ok(css15b.includes(`animation-delay: calc(var(--m-delay) + var(--m-wi) * ${WORD_STEP_MS}ms);`));
    assert.ok(css15b.includes(`filter: blur(calc(var(--m-wr) * ${WORD_BLUR_PX}px));`));
  });

  test("words are inline spans, so line breaks, shaping and bidi order are the unsplit sentence's", () => {
    assert.ok(!/\[data-m-w\][^{]*\{[^}]*display:/.test(css15b), "a word span was given a display");
    assert.ok(!/\[data-m-w\][^{]*\{[^}]*(translate|scale):/.test(css15b), "a word travels");
  });

  test("the accessible copy is hidden from the eye and from selection, not from assistive technology", () => {
    const rule = css15b.slice(css15b.indexOf("[data-m-wa] {"), css15b.indexOf("}", css15b.indexOf("[data-m-wa] {")));
    for (const declaration of ["position: absolute;", "overflow: hidden;", "clip-path: inset(50%);", "user-select: none;"]) {
      assert.ok(rule.includes(declaration), declaration);
    }
    assert.ok(!/display: none|visibility: hidden|aria-hidden/.test(rule));
  });
});

/* ========================================================================== */

describe("reduced motion, print and no script", () => {
  const block = (query: string) => {
    const start = cssCode.lastIndexOf(query);
    return cssCode.slice(start, cssCode.indexOf("\n}\n", start));
  };

  for (const [name, query] of [
    ["reduced motion", "@media (prefers-reduced-motion: reduce) {\n  [data-m-reveal]"],
    ["print", "@media print {\n  [data-m-reveal]"],
  ] as const) {
    test(`${name}: no drift, no hover movement, no words arriving`, () => {
      const rules = block(query);
      assert.match(rules, /\[data-m-px\],\s*\[data-m-hv\] \{\s*translate: none !important;\s*scale: none !important;\s*\}/);
      assert.match(rules, /\[data-m-hv\] > img \{\s*scale: none !important;\s*\}/);
      assert.match(rules, /\[data-m-w\] \{\s*opacity: 1 !important;\s*filter: none !important;\s*animation: none !important;\s*\}/);
      // Blur, Mask and Stagger are 15a's and stay forced finished.
      assert.match(rules, /\[data-m-reveal\],\s*\[data-m-group\] > \* \{[^}]*clip-path: none !important;[^}]*animation: none !important;/);
    });
  }

  test("a hidden word is hidden only where script runs", () => {
    const outsideScripting = css15b.replace(/@media \(scripting: enabled\) \{[\s\S]*?\n\}\n/g, "");
    assert.ok(!/\[data-m-w\][^{]*\{[^}]*opacity: calc/.test(outsideScripting), "a word waits hidden without script");
    assert.match(css15b, /@media \(scripting: enabled\) \{\s*\[data-m-words\]:not\(\[data-shown="true"\]\) \[data-m-w\] \{\s*opacity: calc\(1 - var\(--m-wr\)\);/);
  });

  test("the parallax runtime never runs under reduced motion, and a page needs none of it to be read", () => {
    const runtime = code("src/components/site/motion-parallax.ts");
    assert.match(runtime, /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/);
    assert.match(runtime, /function onPreference\(\) \{\s*if \(reduced\(\)\) \{\s*detachInput\(\);\s*rest\(\);/);
    // Resting is zero: nothing is offset until the runtime writes, and nothing
    // in the stylesheet hides an element for the sake of parallax.
    assert.match(css15b, /\[data-m-px\],\s*\[data-m-hv\] \{\s*--m-pd: 0px;/);
    assert.ok(!/\[data-m-px\][^{]*\{[^}]*opacity/.test(css15b));
  });
});

/* ========================================================================== */

describe("the parallax coordinator: one listener, one frame, reads then writes", () => {
  type Listener = (event?: unknown) => void;
  type Fake = {
    listeners: Map<string, Set<Listener>>;
    frames: Map<number, (now: number) => void>;
    nextFrame: number;
    now: number;
    scrollY: number;
    reduced: boolean;
    mediaListeners: Set<Listener>;
    observers: FakeObserver[];
    rectReads: number;
  };
  class FakeObserver {
    targets = new Set<Element>();
    disconnected = false;
    constructor(readonly callback: (records: { target: Element; isIntersecting: boolean }[]) => void) {
      fake.observers.push(this);
    }
    observe(target: Element) {
      this.targets.add(target);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
    disconnect() {
      this.disconnected = true;
      this.targets.clear();
    }
  }
  const fake: Fake = {
    listeners: new Map(),
    frames: new Map(),
    nextFrame: 1,
    now: 0,
    scrollY: 0,
    reduced: false,
    mediaListeners: new Set(),
    observers: [],
    rectReads: 0,
  };
  const VIEWPORT = 800;

  type FakeElement = {
    top: number;
    height: number;
    distance: number;
    props: Map<string, string>;
    style: { setProperty(n: string, v: string): void; removeProperty(n: string): void; getPropertyValue(n: string): string };
    getBoundingClientRect(): { top: number; height: number; width: number };
  };
  const element = (top: number, distance = 24, height = 100): FakeElement => {
    const props = new Map<string, string>();
    const self: FakeElement = {
      top,
      height,
      distance,
      props,
      style: {
        setProperty: (n, v) => void props.set(n, v),
        removeProperty: (n) => void props.delete(n),
        getPropertyValue: (n) => props.get(n) ?? "",
      },
      getBoundingClientRect() {
        fake.rectReads += 1;
        const applied = Number.parseFloat(props.get("--m-py") ?? "0") || 0;
        return { top: self.top - fake.scrollY + applied, height: self.height, width: 300 };
      },
    };
    return self;
  };

  const window = {
    get innerHeight() {
      return VIEWPORT;
    },
    performance: { now: () => fake.now },
    addEventListener(type: string, listener: Listener) {
      if (!fake.listeners.has(type)) fake.listeners.set(type, new Set());
      fake.listeners.get(type)!.add(listener);
    },
    removeEventListener(type: string, listener: Listener) {
      fake.listeners.get(type)?.delete(listener);
    },
    requestAnimationFrame(callback: (now: number) => void) {
      const id = fake.nextFrame++;
      fake.frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id: number) {
      fake.frames.delete(id);
    },
    getComputedStyle(target: FakeElement) {
      return { getPropertyValue: (name: string) => (name === "--m-pd" ? `${target.distance}px` : "") };
    },
    matchMedia() {
      return {
        get matches() {
          return fake.reduced;
        },
        addEventListener: (_: string, listener: Listener) => fake.mediaListeners.add(listener),
        removeEventListener: (_: string, listener: Listener) => fake.mediaListeners.delete(listener),
      };
    },
  };
  const count = (type: string) => fake.listeners.get(type)?.size ?? 0;
  /** Runs every frame that is pending now, once — as the browser would before its next paint. */
  const runFrames = (advance = 16) => {
    fake.now += advance;
    const pending = [...fake.frames.entries()];
    fake.frames.clear();
    for (const [, callback] of pending) callback(fake.now);
    return pending.length;
  };
  const enter = (targets: FakeElement[], isIntersecting = true) =>
    fake.observers.at(-1)!.callback(targets.map((target) => ({ target: target as unknown as Element, isIntersecting })));
  const offset = (target: FakeElement) => Number.parseFloat(target.props.get("--m-py") ?? "0") || 0;

  let parallax: typeof import("@/components/site/motion-parallax");
  const load = async () => {
    (globalThis as Record<string, unknown>).window = window;
    (globalThis as Record<string, unknown>).IntersectionObserver = FakeObserver;
    parallax = await import("@/components/site/motion-parallax");
  };

  test("a hundred elements are one scroll listener, one resize listener, one observer and one pending frame", async () => {
    await load();
    const elements = Array.from({ length: 100 }, (_, i) => element(i * 300));
    const stops = elements.map((target) => parallax.registerParallax(target as unknown as HTMLElement));
    assert.equal(count("scroll"), 1);
    assert.equal(count("resize"), 1);
    assert.equal(fake.observers.length, 1);
    assert.equal(fake.frames.size, 1, "one frame for a hundred registrations");
    const stats = parallax.parallaxStats();
    assert.equal(stats.registered, 100);
    assert.equal(stats.listening, 1);

    // Nothing is active until the observer says so: a frame reads distances
    // once and no rectangle at all.
    fake.rectReads = 0;
    runFrames();
    assert.equal(fake.rectReads, 0);
    assert.equal(parallax.parallaxStats().writes, 0);

    // Five come into range: exactly five rectangles are read per frame, and at
    // most five offsets written.
    enter(elements.slice(0, 5));
    fake.rectReads = 0;
    const before = parallax.parallaxStats().writes;
    runFrames();
    assert.equal(fake.rectReads, 5);
    assert.ok(parallax.parallaxStats().writes - before <= 5);
    assert.equal(parallax.parallaxStats().active, 5);

    for (const stop of stops) stop();
    assert.equal(count("scroll"), 0, "the last element out took the scroll listener with it");
    assert.equal(count("resize"), 0);
    assert.equal(fake.observers[0]!.disconnected, true);
    assert.equal(fake.frames.size, 0, "a frame was left pending");
    assert.equal(parallax.parallaxStats().registered, 0);
    assert.equal(fake.mediaListeners.size, 0, "the preference listener outlived the registry");
  });

  test("any number of scroll events before a frame is one frame; no scroll, no frame", async () => {
    const target = element(900);
    const stop = parallax.registerParallax(target as unknown as HTMLElement);
    enter([target]);
    // Let the settle-in finish: past SETTLE_MS the loop must stop on its own.
    for (let i = 0; i < 40 && fake.frames.size; i += 1) runFrames(20);
    assert.equal(fake.frames.size, 0, "the loop kept running with nothing to do");
    for (let i = 0; i < 25; i += 1) for (const listener of fake.listeners.get("scroll") ?? []) listener();
    assert.equal(fake.frames.size, 1);
    stop();
  });

  test("the offset is bounded by the element's distance, zero at the middle, and never feeds on itself", async () => {
    const target = element(0, 36);
    const stop = parallax.registerParallax(target as unknown as HTMLElement);
    enter([target]);
    fake.now += 1000; // past the settle-in
    const at = (scroll: number) => {
      fake.scrollY = scroll;
      for (const listener of fake.listeners.get("scroll") ?? []) listener();
      runFrames();
      return offset(target);
    };
    // Centre of the element at the centre of the viewport: at rest.
    assert.equal(at(-(VIEWPORT / 2) + 50), 0);
    // Far below and far above: clamped to the distance, in opposite directions.
    assert.equal(at(-5000), -36);
    assert.equal(at(5000), 36);
    for (const scroll of [-900, -600, -300, 0, 300, 600, 900]) {
      const value = at(scroll);
      assert.ok(Math.abs(value) <= 36, `${scroll}: ${value}`);
      // Asked again at the same scroll, the answer is the same: the offset it
      // applied last time is subtracted before the element is judged.
      assert.equal(at(scroll), value, `the offset fed on itself at ${scroll}`);
    }
    stop();
    fake.scrollY = 0;
  });

  test("a newly registered element eases in rather than jumping to its offset", async () => {
    const target = element(-400, 36);
    fake.scrollY = 0;
    const stop = parallax.registerParallax(target as unknown as HTMLElement);
    enter([target]);
    const seen: number[] = [];
    for (let i = 0; i < 30 && fake.frames.size; i += 1) {
      runFrames(20);
      seen.push(offset(target));
    }
    assert.ok(Math.abs(seen[0]!) < Math.abs(seen.at(-1)!), `it did not ease in: ${seen.join(", ")}`);
    for (let i = 1; i < seen.length; i += 1) assert.ok(Math.abs(seen[i]!) >= Math.abs(seen[i - 1]!) - 0.11);
    stop();
  });

  test("a width where parallax is off puts the element back at rest and leaves it there", async () => {
    const target = element(900, 24);
    const stop = parallax.registerParallax(target as unknown as HTMLElement);
    enter([target]);
    fake.now += 1000;
    runFrames();
    for (const listener of fake.listeners.get("scroll") ?? []) listener();
    runFrames();
    assert.notEqual(offset(target), 0);
    target.distance = 0; // the stylesheet's Mobile none
    for (const listener of fake.listeners.get("resize") ?? []) listener();
    runFrames();
    assert.equal(target.props.has("--m-py"), false, "the offset stayed after parallax was switched off");
    const writes = parallax.parallaxStats().writes;
    for (const listener of fake.listeners.get("scroll") ?? []) listener();
    runFrames();
    assert.equal(parallax.parallaxStats().writes, writes, "an element at rest was written again");
    stop();
  });

  test("reduced motion: no scroll listener, no writes — and it starts again if the preference is turned off", async () => {
    fake.reduced = true;
    const target = element(900, 24);
    const stop = parallax.registerParallax(target as unknown as HTMLElement);
    assert.equal(count("scroll"), 0, "a scroll listener under reduced motion");
    enter([target]);
    runFrames();
    assert.equal(target.props.has("--m-py"), false);
    fake.reduced = false;
    for (const listener of fake.mediaListeners) listener();
    assert.equal(count("scroll"), 1);
    fake.now += 1000;
    for (let i = 0; i < 40 && fake.frames.size; i += 1) runFrames(20);
    assert.ok(target.props.has("--m-py"), "it did not start again");
    fake.reduced = true;
    for (const listener of fake.mediaListeners) listener();
    assert.equal(count("scroll"), 0);
    assert.equal(target.props.has("--m-py"), false, "reduced motion left an offset behind");
    stop();
    fake.reduced = false;
  });

  test("the module is loaded only for a page with parallax, and never in the editor's canvas", () => {
    const runtime = code("src/components/site/motion-runtime.tsx");
    assert.match(runtime, /if \(parallax === "live"\) \{\s*const drifting = document\.querySelectorAll<HTMLElement>\("\[data-m-px\]"\);\s*if \(drifting\.length\) \{\s*void import\("\.\/motion-parallax"\)/);
    const renderer = code("src/components/site/section-renderer.tsx");
    assert.match(renderer, /parallax=\{editorMode \? "paused" : "live"\}/);
    for (const file of ["src/components/site/motion-runtime.tsx", "src/components/site/motion-parallax.ts"]) {
      assert.ok(!/location|searchParams|\beditor=1\b|data-eod/.test(code(file)), `${file} works editor mode out for itself`);
    }
    // No React state per frame, no library.
    const coordinator = code("src/components/site/motion-parallax.ts");
    assert.ok(!/useState|setState|from "motion|from "framer/.test(coordinator));
    assert.equal((coordinator.match(/addEventListener\("scroll"/g) ?? []).length, 1);
  });
});

/* ========================================================================== */

describe("Replay speaks version 5 of the protocol, in closed and bounded messages", () => {
  const BRIDGE = "0123456789abcdef0123456789abcdef";
  const wrap = (message: unknown) => envelope(BRIDGE, message);

  test("the version moved, and a canvas from before it is not understood at all", () => {
    // Batch 15b moved it to 5; Batch 16 moved it again, to 6, for the Undo and
    // Redo shortcut a canvas forwards. Replay itself is unchanged.
    assert.equal(PROTOCOL_VERSION, 6);
    const old = { ...wrap({ type: "editor.motionReplay", address: "section:4", token: 1, mode: "all" }), v: 4 };
    assert.equal(readEditorMessage(old, { bridgeId: BRIDGE }), null);
  });

  test("a well-formed request is an address, a token and a mode — nothing else survives", () => {
    for (const mode of REPLAY_MODES) {
      assert.deepEqual(
        readEditorMessage(
          wrap({ type: "editor.motionReplay", address: "section:4/field:title", token: 3, mode, script: "alert(1)" }),
          { bridgeId: BRIDGE },
        ),
        { type: "editor.motionReplay", address: "section:4/field:title", token: 3, mode },
      );
    }
    // A section root is a legitimate target.
    assert.deepEqual(readEditorMessage(wrap({ type: "editor.motionReplay", address: "section:4", token: 0, mode: "entrance" }), { bridgeId: BRIDGE }), {
      type: "editor.motionReplay",
      address: "section:4",
      token: 0,
      mode: "entrance",
    });
    assert.deepEqual(readEditorMessage(wrap({ type: "editor.motionReplayCancel", token: 3, extra: 1 }), { bridgeId: BRIDGE }), {
      type: "editor.motionReplayCancel",
      token: 3,
    });
  });

  test("a selector, markup, a style string, a generic command or a bad token is refused", () => {
    for (const over of [
      { address: "[data-m-hv]" },
      { address: "section:4/field:title, body" },
      { address: "<img src=x onerror=alert(1)>" },
      { address: "section:4/field:title;color:red" },
      { address: 4 },
      { address: "" },
      { token: -1 },
      { token: 1.5 },
      { token: "1" },
      { token: null },
      { mode: "loop" },
      { mode: "ALL" },
      { mode: "entrance; drop" },
      { mode: null },
    ]) {
      const message = { type: "editor.motionReplay", address: "section:4/field:title", token: 1, mode: "all", ...over };
      assert.equal(readEditorMessage(wrap(message), { bridgeId: BRIDGE }), null, JSON.stringify(over));
    }
    for (const type of ["editor.motion", "editor.replay", "editor.run", "editor.eval", "editor.setStyle", "editor.play"]) {
      assert.equal(readEditorMessage(wrap({ type, address: "section:4", token: 1, mode: "all" }), { bridgeId: BRIDGE }), null, type);
    }
  });

  test("a result is an address, a token and an outcome from a closed list", () => {
    for (const outcome of REPLAY_OUTCOMES) {
      assert.deepEqual(
        readCanvasMessage(wrap({ type: "canvas.motionReplayResult", address: "section:4/field:title", token: 2, outcome, note: "x" }), {
          bridgeId: BRIDGE,
        }),
        { type: "canvas.motionReplayResult", address: "section:4/field:title", token: 2, outcome },
      );
      assert.ok(REPLAY_STATUS[outcome].length > 0);
    }
    for (const over of [{ outcome: "exploded" }, { outcome: 1 }, { token: -2 }, { address: "div" }]) {
      const message = { type: "canvas.motionReplayResult", address: "section:4", token: 1, outcome: "finished", ...over };
      assert.equal(readCanvasMessage(wrap(message), { bridgeId: BRIDGE }), null, JSON.stringify(over));
    }
  });

  test("the origin, the window and the bridge are checked exactly as for every other message", () => {
    assert.equal(
      readEditorMessage({ ...wrap({ type: "editor.motionReplay", address: "section:4", token: 1, mode: "all" }), bridgeId: "f".repeat(32) }, { bridgeId: BRIDGE }),
      null,
    );
    const bridge = code("src/components/site/editor-bridge.tsx");
    assert.match(bridge, /const onMessage = \(event: MessageEvent\) => \{\s*if \(event\.origin !== origin\) return;\s*if \(event\.source !== window\.parent\) return;/);
    const canvas = code("src/components/admin/visual-editor/canvas.tsx");
    assert.match(canvas, /if \(!frameRef\.current \|\| event\.source !== frameRef\.current\.contentWindow\) return;/);
  });
});

/* ========================================================================== */

describe("a stale Replay result changes nothing", () => {
  const session: ReplaySession = { token: 7, address: "section:4/field:title", mode: "all", pageId: 2, locale: "en", canvasKey: 3 };
  const context = { pageId: 2, locale: "en" as const, canvasKey: 3, selected: "section:4/field:title" };
  const result = { address: "section:4/field:title", token: 7, outcome: "finished" as const };

  test("a result for the Replay that is playing, in the context it was asked in, is taken", () => {
    assert.deepEqual(acceptReplayResult(session, context, result), { ok: true, outcome: "finished", ends: true });
    assert.deepEqual(acceptReplayResult(session, context, { ...result, outcome: "started" }), { ok: true, outcome: "started", ends: false });
  });

  test("another page, another language, a reloaded canvas, another selection or a newer request: nothing", () => {
    assert.deepEqual(acceptReplayResult(null, context, result), { ok: false, reason: "no-session" });
    assert.deepEqual(acceptReplayResult(session, context, { ...result, token: 6 }), { ok: false, reason: "token" });
    assert.deepEqual(acceptReplayResult(session, context, { ...result, address: "section:4" }), { ok: false, reason: "address" });
    assert.deepEqual(acceptReplayResult(session, { ...context, pageId: 9 }, result), { ok: false, reason: "page" });
    assert.deepEqual(acceptReplayResult(session, { ...context, locale: "ar" }, result), { ok: false, reason: "locale" });
    assert.deepEqual(acceptReplayResult(session, { ...context, canvasKey: 4 }, result), { ok: false, reason: "canvas" });
    assert.deepEqual(acceptReplayResult(session, { ...context, selected: "section:4" }, result), { ok: false, reason: "selection" });
    assert.deepEqual(acceptReplayResult(session, { ...context, selected: null }, result), { ok: false, reason: "selection" });
  });

  test("the editor ends a Replay on a page, language, canvas or selection change, and the canvas on its own side", () => {
    const shell = code("src/components/admin/visual-editor/shell.tsx");
    assert.match(shell, /useEffect\(\(\) => \{\s*replayToken\.current \+= 1;\s*const session = replaySession\.current;\s*replaySession\.current = null;\s*setReplayStatus\(null\);\s*if \(session\) setReplayRequest\(\{ kind: "cancel", token: session\.token \}\);\s*\}, \[page, locale, canvasKey\]\);/);
    assert.match(shell, /if \(session && session\.address !== selectedAddress\) \{\s*replaySession\.current = null;\s*setReplayRequest\(\{ kind: "cancel", token: session\.token \}\);/);
    const bridge = code("src/components/site/editor-bridge.tsx");
    // Superseded, selection moved, cleared, direct edit, document left.
    assert.match(bridge, /const beginReplay = \(address: string, token: number, mode: ReplayMode\) => \{\s*stopReplay\(\);/);
    assert.match(bridge, /case "editor\.select": \{\s*if \(replaying && replaying\.address !== message\.address\) stopReplay\(\);/);
    assert.match(bridge, /case "editor\.clearSelection":\s*stopReplay\(\);/);
    assert.match(bridge, /if \(isLocked\(address\)\) return;\s*stopReplay\(\);\s*stopEditing\(true\);/);
    assert.match(bridge, /return \(\) => \{\s*stopReplay\(\);/);
    assert.match(bridge, /case "editor\.motionReplayCancel":\s*if \(replaying && replaying\.token === message\.token\) stopReplay\(\);/);
  });
});

/* ========================================================================== */

describe("Replay saves nothing", () => {
  const shell = code("src/components/admin/visual-editor/shell.tsx");
  const between = (from: string, to: string) => shell.slice(shell.indexOf(from), shell.indexOf(to, shell.indexOf(from)));

  test("the editor's half posts one message and touches no buffer, autosave, action or history", () => {
    const request = between("const requestReplay = useCallback(", "const onReplayResult = useCallback(");
    const result = between("const onReplayResult = useCallback(", "const requestDirectEdit = useCallback(");
    for (const part of [request, result]) {
      assert.ok(part.length > 100, "the Replay handlers were not found");
      for (const forbidden of [
        "writeBuffers",
        "scheduleAutosave",
        "drainSection",
        "runSave",
        "saveVisual",
        "publishPage",
        "discardPage",
        "restoreVersion",
        "setBuffers",
        "fetch(",
        "FormData",
        "Dirty",
      ]) {
        assert.ok(!part.includes(forbidden), `Replay reaches ${forbidden}`);
      }
    }
  });

  test("the canvas's half imports nothing that can write, and sends nothing but its result", () => {
    const replay = code("src/components/site/motion-replay.ts");
    const imports = [...replay.matchAll(/from "([^"]+)"/g)].map((match) => match[1]);
    assert.deepEqual(imports.sort(), ["@/lib/cms/words", "@/lib/visual-editor/protocol"]);
    assert.ok(!/postMessage|fetch\(|localStorage|sessionStorage|document\.cookie/.test(replay));
    const bridge = code("src/components/site/editor-bridge.tsx");
    const replaySection = bridge.slice(bridge.indexOf("type Replaying ="), bridge.indexOf("type Editing ="));
    assert.deepEqual([...replaySection.matchAll(/post\(\{ type: "([a-z.A-Z]+)"/g)].map((match) => match[1]), ["canvas.motionReplayResult"]);
  });

  test("the only editor-only attribute Replay writes is its own, and it is never rendered into a page", () => {
    const replay = code("src/components/site/motion-replay.ts");
    assert.deepEqual([...new Set(replay.match(/data-eod-[a-z-]+/g) ?? [])], ["data-eod-replay-hover"]);
    for (const file of ["src/lib/cms/node.ts", "src/lib/cms/motion-css.ts", "src/lib/visual-editor/render.ts"]) {
      assert.ok(!code(file).includes("data-eod-replay"), file);
    }
  });

  test("Replay restores what it changed: the original text nodes, the shown state, the hover and the sweep", () => {
    const replay = code("src/components/site/motion-replay.ts");
    assert.match(replay, /for \(const \[node, words\] of swapped\) if \(words\.isConnected\) words\.replaceWith\(node\);/);
    assert.match(replay, /undo\.push\(\(\) => element\.setAttribute\("data-shown", "true"\)\);/);
    assert.match(replay, /const release = \(\) => element\.removeAttribute\("data-eod-replay-hover"\);\s*undo\.push\(release\);/);
    assert.match(replay, /sweep\?\.cancel\(\);/);
    // Bounded: every phase has a ceiling.
    assert.match(replay, /entranceMs: 4800,\s*sweepMs: 1800,\s*hoverHoldMs: 900,\s*hoverSettleMs: 450,/);
  });

  test("the words Replay builds are the same words the public page renders", () => {
    const replay = code("src/components/site/motion-replay.ts");
    assert.match(replay, /import \{ splitWords \} from "@\/lib\/cms\/words";/);
    assert.match(code("src/lib/cms/node.ts"), /import \{ splitWords \} from "\.\/words";/);
  });
});

/* ========================================================================== */

describe("public isolation: the editor's machinery never reaches a visitor", () => {
  test("Replay lives in a module only the editor bridge imports", () => {
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry) && /from "[^"]*\/motion-replay"/.test(readFileSync(full, "utf8"))) {
          importers.push(path.relative(REPO_ROOT, full));
        }
      }
    };
    walk(path.join(REPO_ROOT, "src"));
    assert.deepEqual(importers, ["src/components/site/editor-bridge.tsx"]);
  });

  test("the bridge is rendered only for an authorised editor canvas", () => {
    for (const file of ["src/app/(public)/[lang]/page.tsx", "src/app/(public)/[lang]/[...slug]/page.tsx"]) {
      assert.match(read(file), /\{editor \? \(\s*<EditorBridge/, file);
    }
  });

  test("motion markup is page rendering, never editor plumbing", () => {
    const node = blockNode({
      editor: null,
      styles: undefined,
      motion: doc({}, { "field:title": { base: { parallax: "subtle", hover: "none", textReveal: "words" } } }),
    });
    const { attrs } = node.text("field:title", "Hello there");
    assert.ok(Object.keys(attrs).every((key) => !key.startsWith("data-eod")), Object.keys(attrs).join(","));
    assert.equal(attrs["data-m-px"], "");
    assert.equal(attrs["data-m-words"], "");
    assert.ok(!("data-m-hv" in attrs), "a hover of None everywhere marked the element");
  });
});

/* ========================================================================== */

describe("duplicate, publish, history and restore carry the new keys like any other", () => {
  const id = newItemId();
  const withAll = doc(
    { base: { entrance: "fade" } },
    {
      "field:title": { base: { textReveal: "words", parallax: "subtle" }, mobile: { textReveal: "none" } },
      "field:points": { base: { parallax: "medium" } },
      [`field:points/item:${id}`]: { base: { hover: "lift" }, tablet: { hover: "scale" } },
    },
  );

  test("duplicating remaps a row's hover to the copy's row and points nowhere at the original", () => {
    const fresh = newItemId();
    const moved = remapMotionItemIds(withAll, new Map([[id, fresh]]));
    assert.deepEqual(moved.nodes[`field:points/item:${fresh}`], { base: { hover: "lift" }, tablet: { hover: "scale" } });
    assert.ok(!JSON.stringify(moved).includes(id), "the copy still points at the source row");
    assert.deepEqual(moved.nodes["field:title"], withAll.nodes["field:title"]);
    const orphaned = remapMotionItemIds(withAll, new Map());
    assert.ok(!Object.keys(orphaned.nodes).some((key) => key.includes("item:")), "an unmapped row kept its hover");
  });

  test("publishing promotes the whole document in one decision — no second column, no second write", () => {
    const promoted = motionPromotion(
      { animation: "fade-up", draftAnimation: "fade", motionConfig: null, draftMotionConfig: withAll },
      "why-us",
    );
    assert.equal(promoted.ok, true);
    assert.deepEqual(promoted.ok && promoted.values.motionConfig, withAll);
    assert.deepEqual(Object.keys(promoted.ok ? promoted.values : {}).sort(), ["animation", "draftAnimation", "draftMotionConfig", "motionConfig"]);
  });

  test("a snapshot carries the new keys with no version change, and reads them back through the vocabulary", () => {
    assert.equal(PAGE_SNAPSHOT_VERSION, 1);
    const [section] = snapshotFromSections([
      { id: 5, blockType: "why-us", isPublished: true, published: {}, styles: null, animation: "fade", motionConfig: withAll },
    ]).sections;
    assert.deepEqual(section!.motion, withAll);
    const back = validatePageSnapshot({ v: 1, sections: [{ ...section, motion: { ...withAll, nodes: { ...withAll.nodes, "field:title": { base: { textReveal: "letters" } } } } }] });
    assert.ok(!("field:title" in back.sections[0]!.motion!.nodes), "an unknown text reveal survived a snapshot read");
  });

  test("the rendered page and a node's motion are the same document: nothing here is a second store", () => {
    const decl = [
      "src/lib/db/schema.ts",
      "src/lib/cms/snapshot.ts",
      "src/lib/cms/publish-service.ts",
    ].map((file) => code(file)).join("\n");
    for (const forbidden of ["parallax_config", "hover_config", "text_reveal", "draft_parallax", "draft_hover"]) {
      assert.ok(!decl.includes(forbidden), forbidden);
    }
  });
});

/* ========================================================================== */

describe("the Motion panel: Replay and the paused-parallax rule, said out loud", () => {
  const inspector = code("src/components/admin/visual-editor/motion-inspector.tsx");

  test("Replay is offered, and waits while a change is still being saved", () => {
    assert.match(inspector, /onClick=\{\(\) => replay\.onReplay\("all"\)\}\s*disabled=\{!replay\.ready \|\| pending \|\| !modes\.length\}/);
    const panel = code("src/components/admin/visual-editor/inspector.tsx");
    assert.match(panel, /pending=\{buffer\.motionDirty \|\| buffer\.saving === "motion"\}/);
  });

  test("the paused-parallax sentence is the one the brief fixed", () => {
    assert.match(inspector, /if \(parallaxAnywhere\(target\)\) notes\.parallax = PARALLAX_PAUSED_NOTE;/);
  });

  test("the options every control offers come from the one capability resolver", () => {
    assert.match(inspector, /case "hover":\s*return hoversFor\(capability\);/);
    assert.match(inspector, /case "parallax":\s*return parallaxFor\(capability\);/);
    assert.match(inspector, /case "textReveal":\s*return textRevealsFor\(capability\);/);
  });
});

/* ========================================================================== */

describe("nothing new is Framer, and the decorative Framer components are untouched", () => {
  test("the new motion modules import no motion library", () => {
    for (const file of [
      "src/components/site/motion-parallax.ts",
      "src/components/site/motion-replay.ts",
      "src/components/site/motion-runtime.tsx",
      "src/lib/cms/words.ts",
      "src/lib/cms/node.ts",
    ]) {
      assert.ok(!/from "motion|from "framer-motion/.test(read(file)), file);
    }
  });

  test("the seven decorative components are still the only Framer users", () => {
    const users: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry) && /from "motion(\/react)?"/.test(readFileSync(full, "utf8"))) {
          users.push(path.basename(full));
        }
      }
    };
    walk(path.join(REPO_ROOT, "src"));
    assert.deepEqual(users.sort(), [
      "faq-accordion.tsx",
      "hero-words.tsx",
      "orbit-composition.tsx",
      "site-nav.tsx",
      "testimonial-carousel.tsx",
      "use-calm-motion.ts",
      "video-gallery.tsx",
    ]);
  });

  test("no rendered markup changes for a node with no 15b key", () => {
    const node = blockNode({ editor: null, styles: undefined, motion: doc({}, { "field:title": { base: { entrance: "fade" } } }) });
    const html = renderToStaticMarkup(createElement(Fragment, null, createElement("h2", node("field:title"), "Hi")));
    assert.ok(!/data-m-(px|hv|words|w)\b/.test(html), html);
  });
});
