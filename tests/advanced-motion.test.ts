/**
 * Advanced motion (Batch 15a), decided without a database.
 *
 * The governing rules, each asked several ways below:
 *
 *   · **A stored motion is never a string the renderer has to trust.** The
 *     document is rebuilt from a closed vocabulary on every read and write,
 *     never throws, fails closed, and has one spelling.
 *   · **A section with no document renders exactly as before.** The five
 *     legacy presets keep their classes, and the advanced layer only ever
 *     matches attributes the renderer writes where a document asked for them.
 *   · **Motion is one domain with two columns on each side of publication.**
 *     Every writer — the Visual Editor, the classic form, publication, restore
 *     and duplication — produces both from one decision, so the legacy preset
 *     the previous release reads is always the document's own projection.
 *   · **Nothing is hidden that a visitor cannot get back.** Reduced motion,
 *     print and a page without JavaScript all show the finished state.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { REPO_ROOT } from "./helpers/env";

import { newItemId } from "@/lib/cms/item-id";
import { composePreview, composePublished, type CompositionRow } from "@/lib/cms/composition";
import { draftDomainsOf, draftKindOf } from "@/lib/cms/drafts";
import { remapMotionItemIds } from "@/lib/cms/duplicate";
import { MOTION_PRESETS, type MotionPreset } from "@/lib/cms/motion";
import {
  isStaggerGroup,
  MOTION_VARIABLES,
  branchVars,
  motionFieldState,
  motionStyle,
  STAGGER_CAP,
} from "@/lib/cms/motion-css";
import {
  DELAY_MAX,
  DELAY_STEP,
  DIRECTIONS,
  DURATIONS,
  EASINGS,
  effectiveSectionTarget,
  emptyMotionDocument,
  ENTRANCES,
  isReadableMotionDocument,
  legacyProjection,
  legacySectionPreset,
  MOTION_DOCUMENT_VERSION,
  readMotionDocument,
  resolveBranch,
  STAGGERS,
  validateMotionDocument,
  type MotionDocument,
  type MotionTarget,
} from "@/lib/cms/motion-doc";
import {
  classicMotionWrite,
  currentMotionDocument,
  hasAdvancedMotion,
  legacyFallback,
  motionDraftFromDocument,
  motionDraftFromPreset,
  motionPromotion,
  type MotionRow,
} from "@/lib/cms/motion-write";
import { blockNode } from "@/lib/cms/node";
import { planRestoreFrom } from "@/lib/cms/restore";
import {
  PAGE_SNAPSHOT_VERSION,
  readPageSnapshot,
  snapshotFromSections,
  validatePageSnapshot,
} from "@/lib/cms/snapshot";
import { STYLE_DOCUMENT_VERSION, type StyleDocument } from "@/lib/cms/styles";
import {
  motionForBlock,
  motionTargetFor,
  offeredMotionFields,
  ownedByParentList,
} from "@/lib/visual-editor/motion-targets";

const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), "utf8");
const css = read("src/styles/globals.css");
/** The advanced block alone: everything from the comment that opens it. */
const advancedCss = css.slice(css.lastIndexOf("/*", css.indexOf("Visual Editor — advanced motion (Batch 15a)")));

const LEGACY: readonly MotionPreset[] = MOTION_PRESETS.map((preset) => preset.value);
const doc = (section: MotionTarget = {}, nodes: Record<string, MotionTarget> = {}): MotionDocument => ({
  v: MOTION_DOCUMENT_VERSION,
  section,
  nodes,
});

const motionRow = (extra: Partial<MotionRow> = {}): MotionRow => ({
  animation: "fade-up",
  draftAnimation: null,
  motionConfig: null,
  draftMotionConfig: null,
  ...extra,
});

/* -------------------------------------------------------------------------- */

describe("the document is a closed vocabulary, rebuilt on every read", () => {
  test("anything that is not a v1 document is the empty document", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "{}",
      42,
      [],
      [{ v: 1 }],
      {},
      { v: 0 },
      { v: -1 },
      { v: "1" },
      { v: 1.5 },
      { v: Number.NaN },
      { v: Number.POSITIVE_INFINITY },
      // A newer build may mean something different by the same keys.
      { v: MOTION_DOCUMENT_VERSION + 1, section: { base: { entrance: "blur" } } },
    ]) {
      assert.deepEqual(validateMotionDocument(bad), emptyMotionDocument(), JSON.stringify(bad));
    }
  });

  test("every entrance, direction, duration, easing and stagger in the vocabulary survives", () => {
    for (const entrance of ENTRANCES) {
      assert.deepEqual(validateMotionDocument(doc({ base: { entrance } })).section, { base: { entrance } });
    }
    for (const direction of DIRECTIONS) {
      assert.deepEqual(validateMotionDocument(doc({ base: { direction } })).section, { base: { direction } });
    }
    for (const duration of DURATIONS) {
      assert.deepEqual(validateMotionDocument(doc({ base: { duration } })).section, { base: { duration } });
    }
    for (const easing of EASINGS) {
      assert.deepEqual(validateMotionDocument(doc({ base: { easing } })).section, { base: { easing } });
    }
    for (const stagger of STAGGERS) {
      assert.deepEqual(validateMotionDocument(doc({ base: { stagger } })).section, { base: { stagger } });
    }
  });

  test("a value outside the vocabulary is dropped, never guessed at", () => {
    const hostile: Record<string, unknown[]> = {
      entrance: ["zoom", "Blur", "blur ", "", "fade-down", 5, null, { name: "blur" }, ["blur"]],
      // No physical side is storable: logical only.
      direction: ["left", "right", "Start", "top", "bottom", 1],
      duration: ["500ms", 500, -1, "slow ", "0.5s", "var(--duration-slow)", "calc(1s)"],
      easing: [
        "cubic-bezier(0, 0, 1, 1)",
        "linear",
        "ease",
        "steps(4)",
        "var(--ease-out-expo)",
        "expo-out;color:red",
      ],
      stagger: [45, "45ms", "fast", -1],
      delay: [
        -50,
        DELAY_MAX + DELAY_STEP,
        25,
        75,
        1.5,
        100.5,
        Number.NaN,
        Number.POSITIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        "100",
        "100ms",
        null,
        true,
      ],
    };
    for (const [field, values] of Object.entries(hostile)) {
      for (const value of values) {
        const out = validateMotionDocument(doc({ base: { [field]: value } as never }));
        assert.deepEqual(out.section, {}, `${field}=${JSON.stringify(value)} survived`);
      }
    }
  });

  test("delay is a whole number of milliseconds on a 50ms grid from 0 to 1500", () => {
    for (let delay = 0; delay <= DELAY_MAX; delay += DELAY_STEP) {
      assert.deepEqual(validateMotionDocument(doc({ base: { delay } })).section, { base: { delay } });
    }
    assert.equal(DELAY_MAX, 1500);
    assert.equal(DELAY_STEP, 50);
  });

  test("unknown keys, breakpoints and fields are dropped at every level", () => {
    const out = validateMotionDocument({
      v: 1,
      evil: "x",
      section: {
        base: { entrance: "blur", transform: "rotate(45deg)", filter: "blur(40px)", css: "color:red" },
        desktop: { entrance: "mask" },
        tablet: { entrance: "fade", style: "x" },
      },
      nodes: { "field:title": { base: { entrance: "mask", clipPath: "inset(0)" }, wide: { entrance: "fade" } } },
    });
    assert.deepEqual(out, {
      v: 1,
      section: { base: { entrance: "blur" }, tablet: { entrance: "fade" } },
      nodes: { "field:title": { base: { entrance: "mask" } } },
    });
  });

  test("a node key must be a section-relative path — never root, a runtime address or a selector", () => {
    const id = newItemId();
    const out = validateMotionDocument({
      v: 1,
      nodes: {
        root: { base: { entrance: "fade" } },
        "section:42/field:title": { base: { entrance: "fade" } },
        "div > p": { base: { entrance: "fade" } },
        ".hero h1": { base: { entrance: "fade" } },
        "field:": { base: { entrance: "fade" } },
        "field:title/": { base: { entrance: "fade" } },
        "item:i_23456789": { base: { entrance: "fade" } },
        "field:links/item:not-an-id": { base: { entrance: "fade" } },
        __proto__: { base: { entrance: "fade" } },
        constructor: { base: { entrance: "fade" } },
        " field:title ": { base: { entrance: "blur" } },
        [`field:links/item:${id}`]: { base: { entrance: "fade-up" } },
        "field:links": { base: { entrance: "fade", stagger: "tight" } },
      },
    });
    assert.deepEqual(Object.keys(out.nodes), [
      "field:links",
      `field:links/item:${id}`,
      // Normalised, not refused: the parser trims, and the stored key is the
      // canonical spelling.
      "field:title",
    ]);
    // A `__proto__` key cannot reach the prototype.
    assert.equal(({} as Record<string, unknown>).entrance, undefined);
    assert.equal(Object.getPrototypeOf(out.nodes), Object.prototype);
  });

  test("a hostile JSON document never throws and never pollutes anything", () => {
    const hostile = JSON.parse(
      '{"v":1,"__proto__":{"polluted":true},"section":{"__proto__":{"entrance":"blur"},"base":{"__proto__":{"x":1}}},' +
        '"nodes":{"field:title":{"__proto__":{"base":{}},"base":{"entrance":"fade"}}}}',
    );
    const out = validateMotionDocument(hostile);
    assert.deepEqual(out, { v: 1, section: {}, nodes: { "field:title": { base: { entrance: "fade" } } } });
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  test("validating twice changes nothing, and two spellings of one document are one string", () => {
    const messy = {
      nodes: {
        "field:title": { mobile: { delay: 300 }, base: { easing: "soft-out", entrance: "mask", direction: "up" } },
        "field:eyebrow": { tablet: { entrance: "none" } },
      },
      section: { tablet: { duration: "fast" }, base: { entrance: "blur", delay: 100 } },
      v: 1,
    };
    const reordered = {
      v: 1,
      section: { base: { delay: 100, entrance: "blur" }, tablet: { duration: "fast" } },
      nodes: {
        "field:eyebrow": { tablet: { entrance: "none" } },
        "field:title": { base: { direction: "up", entrance: "mask", easing: "soft-out" }, mobile: { delay: 300 } },
      },
    };
    const once = validateMotionDocument(messy);
    assert.deepEqual(validateMotionDocument(once), once);
    assert.equal(JSON.stringify(validateMotionDocument(messy)), JSON.stringify(validateMotionDocument(reordered)));
    assert.deepEqual(Object.keys(once.nodes), ["field:eyebrow", "field:title"]);
  });

  test("an empty branch is an inherited one and is not stored", () => {
    const out = validateMotionDocument(doc({ base: {}, tablet: { entrance: "zoom" as never } }));
    assert.deepEqual(out.section, {});
  });

  test("a stored column reads as null only when the column is null", () => {
    assert.equal(readMotionDocument(null), null);
    assert.equal(readMotionDocument(undefined), null);
    assert.deepEqual(readMotionDocument({ v: 99 }), emptyMotionDocument());
  });

  test("publishing asks a stricter question than reading", () => {
    assert.equal(isReadableMotionDocument(doc()), true);
    for (const bad of [null, "x", [], {}, { v: 0 }, { v: 2 }, { v: "1" }, { v: 1.5 }]) {
      assert.equal(isReadableMotionDocument(bad), false, JSON.stringify(bad));
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("Base → Tablet → Mobile, sparse, and mobile inherits through tablet", () => {
  const target: MotionTarget = {
    base: { entrance: "blur", duration: "slow", delay: 200 },
    tablet: { duration: "fast" },
    mobile: { entrance: "none" },
  };

  test("each width resolves its own keys over the ones above it", () => {
    assert.deepEqual(resolveBranch(target, "base"), { entrance: "blur", duration: "slow", delay: 200 });
    assert.deepEqual(resolveBranch(target, "tablet"), { entrance: "blur", duration: "fast", delay: 200 });
    assert.deepEqual(resolveBranch(target, "mobile"), { entrance: "none", duration: "fast", delay: 200 });
  });

  test("deleting a Mobile value means Tablet's, and deleting Tablet's means Base's", () => {
    const withoutMobile: MotionTarget = { base: target.base, tablet: target.tablet };
    assert.equal(resolveBranch(withoutMobile, "mobile").entrance, "blur");
    assert.equal(resolveBranch(withoutMobile, "mobile").duration, "fast");
    const withoutTablet: MotionTarget = { base: target.base };
    assert.equal(resolveBranch(withoutTablet, "mobile").duration, "slow");
  });

  test("the panel is told whether a value is stored here or inherited, and from where", () => {
    assert.deepEqual(motionFieldState(target, "mobile", "duration"), {
      value: undefined,
      inherited: "fast",
      from: "tablet",
    });
    assert.deepEqual(motionFieldState(target, "tablet", "delay"), { value: undefined, inherited: 200, from: "base" });
    assert.deepEqual(motionFieldState(target, "mobile", "entrance"), { value: "none", inherited: "blur", from: "base" });
    assert.deepEqual(motionFieldState(target, "base", "easing"), { value: undefined, inherited: undefined, from: null });
  });

  test("a narrower width writes only what it declares — an inherited value is never copied down", () => {
    const style = motionStyle(target)!;
    // Tablet declared only a duration.
    assert.equal(style.attrs["data-m-t"], "dur");
    assert.equal(style.vars["--m-t-dur"], "var(--duration-fast)");
    assert.equal(style.vars["--m-t-delay"], undefined);
    // Mobile declared an entrance, so its geometry is written whole.
    assert.deepEqual(style.attrs["data-m-m"]!.split(" ").sort(), [
      "anim",
      "blur",
      "clip-b",
      "clip-e",
      "clip-s",
      "clip-t",
      "hold",
      "op",
      "scale",
      "x",
      "y",
    ]);
    assert.equal(style.vars["--m-m-op"], "1", "an entrance of none at mobile is the finished state");
  });

  test("a width that only turns the direction redraws the whole inherited entrance", () => {
    const style = motionStyle({ base: { entrance: "mask", direction: "start" }, tablet: { direction: "up" } })!;
    assert.equal(style.vars["--m-t-clip-t"], "100%");
    assert.equal(style.vars["--m-t-clip-e"], "-100vmax", "the base wipe's edge was left behind at tablet");
    assert.equal(style.vars["--m-t-anim"], "eod-m-mask");
  });

  test("a target with only Base carries no breakpoint attributes at all", () => {
    const style = motionStyle({ base: { entrance: "fade-up" } })!;
    assert.deepEqual(style.attrs, {});
  });
});

/* -------------------------------------------------------------------------- */

describe("every entrance is a fixed set of values written in source", () => {
  const geometry = (entrance: (typeof ENTRANCES)[number], direction?: (typeof DIRECTIONS)[number]) =>
    branchVars({ entrance, ...(direction ? { direction } : {}) });

  test("the four legacy geometries are reproduced exactly", () => {
    assert.equal(geometry("fade-up").y, "18px");
    assert.equal(geometry("fade-up").op, "0");
    assert.deepEqual([geometry("fade").x, geometry("fade").y, geometry("fade").scale], ["0px", "0px", "1"]);
    assert.equal(geometry("scale-in").scale, "0.965");
    assert.equal(geometry("slide-in").x, "-24px", "slide in defaults to the start edge");
  });

  test("Blur is a restrained fade with a filter, and finishes unblurred", () => {
    const blur = geometry("blur");
    assert.equal(blur.blur, "8px");
    assert.equal(blur.y, "8px");
    assert.equal(blur.op, "0");
    assert.match(advancedCss, /to \{[^}]*filter: none;/);
  });

  test("Slide travels on the axis it names, logically", () => {
    assert.equal(geometry("slide-in", "start").x, "-24px");
    assert.equal(geometry("slide-in", "end").x, "24px");
    assert.equal(geometry("slide-in", "up").y, "24px", "up rises from below");
    assert.equal(geometry("slide-in", "down").y, "-24px");
  });

  test("Mask is opaque and opens from the edge it names", () => {
    for (const direction of DIRECTIONS) {
      const mask = geometry("mask", direction);
      assert.equal(mask.op, "1", "a wipe is not also a fade");
      // …and it waits invisible rather than clipped: an element clipped away
      // entirely is never reported as reached by Chromium's observer.
      assert.equal(mask.hold, "0");
      assert.equal(mask.anim, "eod-m-mask");
    }
    // Start: covered from the end edge inward, so the start edge shows first.
    assert.equal(geometry("mask", "start")["clip-e"], "100%");
    assert.equal(geometry("mask", "end")["clip-s"], "100%");
    assert.equal(geometry("mask", "up")["clip-t"], "100%");
    assert.equal(geometry("mask", "down")["clip-b"], "100%");
    // Every other edge is a whole viewport away, so nothing is cut.
    assert.equal(geometry("mask", "start")["clip-t"], "-100vmax");
  });

  test("None is already where it is going", () => {
    assert.equal(geometry("none").op, "1");
    assert.equal(geometry("none").hold, "1");
    assert.equal(geometry("none").anim, "none");
  });

  test("everything that fades waits at the opacity it starts from", () => {
    for (const entrance of ["fade-up", "fade", "slide-in", "scale-in", "blur"] as const) {
      assert.equal(geometry(entrance).hold, geometry(entrance).op, entrance);
      assert.equal(geometry(entrance).hold, "0", entrance);
    }
  });

  test("timing is a name in the design system, never a number from the document", () => {
    assert.equal(branchVars({ duration: "fast" }).dur, "var(--duration-fast)");
    assert.equal(branchVars({ duration: "standard" }).dur, "var(--duration-base)");
    assert.equal(branchVars({ duration: "slow" }).dur, "var(--duration-slow)");
    assert.equal(branchVars({ duration: "cinematic" }).dur, "var(--duration-cinematic)");
    assert.match(css, /--duration-cinematic: 1200ms;/);
    assert.equal(branchVars({ easing: "soft-out" }).ease, "var(--ease-out-soft)");
    assert.equal(branchVars({ easing: "expo-out" }).ease, "var(--ease-out-expo)");
    assert.equal(branchVars({ easing: "soft-in-out" }).ease, "var(--ease-in-out-soft)");
    assert.equal(branchVars({ delay: 350 }).delay, "350ms");
    assert.deepEqual(
      STAGGERS.map((stagger) => branchVars({ stagger }).stagger),
      ["0ms", "45ms", "80ms", "130ms"],
    );
  });

  test("everything a branch can emit is a variable the stylesheet promotes at both widths", () => {
    const emitted = new Set<string>();
    for (const entrance of ENTRANCES) {
      for (const direction of DIRECTIONS) {
        for (const name of Object.keys(branchVars({ entrance, direction, duration: "fast", delay: 50, easing: "soft-out", stagger: "tight" }))) {
          emitted.add(name);
        }
      }
    }
    assert.deepEqual([...emitted].sort(), [...MOTION_VARIABLES].sort());
    for (const name of MOTION_VARIABLES) {
      assert.match(advancedCss, new RegExp(`\\[data-m-t~="${name}"\\] \\{ --m-${name}: var\\(--m-t-${name}\\) !important; \\}`));
      assert.match(advancedCss, new RegExp(`\\[data-m-m~="${name}"\\] \\{ --m-${name}: var\\(--m-m-${name}\\) !important; \\}`));
    }
  });

  test("the promote rules sit at the application's own boundaries, mobile after tablet", () => {
    const tablet = advancedCss.indexOf("@media screen and (max-width: 1024px)");
    const mobile = advancedCss.indexOf("@media screen and (max-width: 640px)");
    assert.ok(tablet > 0 && mobile > tablet);
  });

  test("no value in a rendered style is anything but a table entry", () => {
    const allowed = /^(-?\d+(\.\d+)?(px|ms|%|vmax)?|none|eod-m-mask|var\(--[a-z-]+\))$/;
    for (const entrance of ENTRANCES) {
      for (const direction of DIRECTIONS) {
        const style = motionStyle({
          base: { entrance, direction, duration: "cinematic", easing: "soft-in-out", delay: 1500, stagger: "relaxed" },
          tablet: { entrance: "mask", direction: "end" },
          mobile: { entrance: "none" },
        })!;
        for (const [name, value] of Object.entries(style.vars)) {
          assert.match(name, /^--m-(t-|m-)?[a-z-]+$/);
          assert.match(value, allowed, `${name}: ${value}`);
        }
      }
    }
  });

  test("a list waits at most eight steps, and the stylesheet agrees", () => {
    assert.equal(STAGGER_CAP, 8);
    for (let n = 2; n <= STAGGER_CAP; n += 1) {
      assert.match(advancedCss, new RegExp(`\\[data-m-group\\] > :nth-child\\(${n}\\) \\{ --m-i: ${n - 1}; \\}`));
    }
    assert.match(advancedCss, new RegExp(`\\[data-m-group\\] > :nth-child\\(n \\+ ${STAGGER_CAP + 1}\\) \\{ --m-i: ${STAGGER_CAP}; \\}`));
  });
});

/* -------------------------------------------------------------------------- */

describe("the stylesheet: no script, reduced motion, print, RTL and transform ownership", () => {
  // The rule, not the header comment that names it.
  const scripting = advancedCss.slice(
    advancedCss.indexOf("@media (scripting: enabled) {"),
    advancedCss.indexOf("@media screen and (max-width: 1024px) {"),
  );
  const outside = advancedCss.replace(scripting, "");

  test("every hidden state is inside the scripting query", () => {
    assert.match(scripting, /\[data-m-reveal\]:not\(\[data-shown="true"\]\),\s*\[data-m-group\]:not\(\[data-shown="true"\]\) > \* \{/);
    // Outside it, nothing sets a hidden value: no waiting opacity, no clip, no
    // blur, no offset.
    const rules = outside.replace(/@keyframes[\s\S]*?\n\}\n/g, "");
    assert.ok(!/opacity: calc\(var\(--m-(hold|op)\)/.test(rules), "a hidden opacity outside the scripting query");
    assert.ok(!/clip-path: inset/.test(rules), "a clip outside the scripting query");
    assert.ok(!/filter: blur/.test(rules), "a blur outside the scripting query");
  });

  test("a waiting element is never clipped, so the observer can always reach it", () => {
    const waiting = scripting.slice(scripting.indexOf("[data-m-reveal]:not("), scripting.indexOf("}", scripting.indexOf("[data-m-reveal]:not(")));
    assert.match(waiting, /opacity: calc\(var\(--m-hold\) \* var\(--eod-node-opacity, 1\)\);/);
    assert.ok(!/clip-path/.test(waiting), "the waiting state clips");
    // The only clip anywhere in the advanced layer is inside the wipe itself.
    const code = advancedCss.replace(/\/\*[\s\S]*?\*\//g, "");
    const keyframes = code.slice(code.indexOf("@keyframes eod-m-mask"), code.indexOf("@media (scripting: enabled)"));
    assert.equal((code.match(/clip-path: inset/g) ?? []).length, (keyframes.match(/clip-path: inset/g) ?? []).length);
  });

  test("the finished state is declared unconditionally", () => {
    assert.match(outside, /\[data-m-reveal\],\s*\[data-m-group\] > \* \{\s*opacity: var\(--eod-node-opacity, 1\);\s*\}/);
  });

  for (const [name, query] of [
    ["reduced motion", "@media (prefers-reduced-motion: reduce)"],
    ["print", "@media print"],
  ] as const) {
    test(`${name} forces every advanced element to its finished state`, () => {
      const start = advancedCss.indexOf(query);
      assert.ok(start > 0, `no ${query} block`);
      const block = advancedCss.slice(start, advancedCss.indexOf("\n}\n", start));
      assert.match(block, /\[data-m-reveal\],\s*\[data-m-group\] > \* \{/);
      for (const declaration of [
        "opacity: var(--eod-node-opacity, 1) !important;",
        "translate: none !important;",
        "scale: none !important;",
        "filter: none !important;",
        "clip-path: none !important;",
        "animation: none !important;",
      ]) {
        assert.ok(block.includes(declaration), `${name} does not force ${declaration}`);
      }
      // Written after every other advanced rule, so nothing can outrank it.
      assert.ok(start > advancedCss.indexOf("@media screen and (max-width: 640px)"));
    });
  }

  test("start and end follow the reading direction, and nothing physical is stored", () => {
    assert.match(advancedCss, /\[dir="rtl"\] \[data-m-reveal\],\s*\[dir="rtl"\] \[data-m-group\] \{\s*--m-sign: -1;\s*--m-clip-r: var\(--m-clip-s\);\s*--m-clip-l: var\(--m-clip-e\);/);
    assert.match(advancedCss, /--m-sign: 1;\s*--m-clip-r: var\(--m-clip-e\);\s*--m-clip-l: var\(--m-clip-s\);/);
    assert.match(advancedCss, /translate: calc\(var\(--m-x\) \* var\(--m-sign\)\) var\(--m-y\);/);
    assert.match(advancedCss, /inset\(var\(--m-clip-t\) var\(--m-clip-r\) var\(--m-clip-b\) var\(--m-clip-l\)\)/);
  });

  test("an advanced entrance never writes transform or transition", () => {
    const code = advancedCss.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!/(^|[\s;{])transform\s*:/.test(code), "the advanced layer writes transform");
    assert.ok(!/(^|[\s;{])transition\s*:/.test(code), "the advanced layer writes transition");
  });

  test("the entrance holds its start through a delay and hands the element back afterwards", () => {
    const code = scripting.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.equal((code.match(/animation-fill-mode: backwards;/g) ?? []).length, 2);
    assert.ok(!/\bboth\b|\bforwards\b/.test(code), "a filled animation pins the element");
  });

  test("the entrance is written in longhands, so an idle second animation is not misread", () => {
    // In the shorthand, `none … backwards` reads `none` as the fill mode and
    // `backwards` as a keyframes name.
    const code = scripting.replace(/\/\*[\s\S]*?\*\//g, "");
    assert.ok(!/(^|[\s;{])animation\s*:/.test(code), "the shorthand is back");
    assert.equal((code.match(/animation-name: eod-m-enter, var\(--m-anim\);/g) ?? []).length, 2);
    assert.match(code, /animation-delay: calc\(var\(--m-delay\) \+ var\(--m-i\) \* var\(--m-stagger\)\);/);
  });

  test("a mask finishes with no clip at all, so a shadow or glow is never cropped", () => {
    const mask = advancedCss.slice(advancedCss.indexOf("@keyframes eod-m-mask"));
    const end = mask.slice(mask.indexOf("to {"), mask.indexOf("}", mask.indexOf("to {")));
    assert.match(end, /clip-path: none;/);
  });

  test("a fade lands on the element's own Style opacity, which no longer inherits", () => {
    assert.match(advancedCss, /opacity: calc\(var\(--m-op\) \* var\(--eod-node-opacity, 1\)\);/);
    assert.match(css, /@property --eod-node-opacity \{\s*syntax: "<number>";\s*inherits: false;\s*initial-value: 1;\s*\}/);
  });

  test("the legacy reveal rules are exactly the Batch 9 ones", () => {
    const legacy = css.slice(css.indexOf("@media (scripting: enabled) {\n    .reveal {"));
    assert.match(legacy, /\.reveal \{\s*opacity: 0;\s*transform: translate3d\(0, 18px, 0\);/);
    assert.match(legacy, /\.reveal-left \{ transform: translate3d\(-24px, 0, 0\); \}/);
    assert.match(legacy, /\[dir="rtl"\] \.reveal-left \{ transform: translate3d\(24px, 0, 0\); \}/);
    assert.match(legacy, /\.reveal-scale \{ transform: scale\(0\.965\); \}/);
    assert.match(legacy, /\.reveal-fade \{ transform: none; \}/);
  });
});

/* -------------------------------------------------------------------------- */

describe("a section with no document renders exactly as it did before", () => {
  test("each legacy preset, with no document, resolves back to itself", () => {
    for (const preset of LEGACY) {
      assert.equal(legacySectionPreset(effectiveSectionTarget(null, preset)), preset);
      assert.equal(legacySectionPreset(effectiveSectionTarget(emptyMotionDocument(), preset)), preset);
    }
  });

  test("a document that only restates a legacy preset still renders on the legacy classes", () => {
    for (const preset of LEGACY) {
      assert.equal(legacySectionPreset(effectiveSectionTarget(doc({ base: { entrance: preset } }), "fade")), preset);
    }
    assert.equal(
      legacySectionPreset({ base: { entrance: "slide-in", direction: "start" } }),
      "slide-in",
    );
    // A direction on an entrance that does not travel is inert.
    assert.equal(legacySectionPreset({ base: { entrance: "fade", direction: "end" } }), "fade");
  });

  test("anything a class cannot say takes the advanced layer", () => {
    for (const target of [
      { base: { entrance: "blur" } },
      { base: { entrance: "mask" } },
      { base: { entrance: "slide-in", direction: "end" } },
      { base: { entrance: "slide-in", direction: "up" } },
      { base: { entrance: "fade-up", duration: "fast" } },
      { base: { entrance: "fade-up", delay: 100 } },
      { base: { entrance: "fade-up" }, tablet: { entrance: "none" } },
      { base: { entrance: "fade-up" }, mobile: { duration: "fast" } },
    ] as MotionTarget[]) {
      assert.equal(legacySectionPreset(target), null, JSON.stringify(target));
    }
  });

  test("the renderer's legacy branch is the Batch 9 one, reached for every section without a document", () => {
    const renderer = read("src/components/site/section-renderer.tsx");
    assert.match(renderer, /const target = effectiveSectionTarget\(advancedMotion, motionOf\(section\.animation\)\);/);
    assert.match(
      renderer,
      /const motion = legacySectionPreset\(target\) \?\? \(animatesAnywhere\(target\) \? null : "none"\);/,
    );
    assert.match(renderer, /<SectionMotion key=\{section\.id\} motion=\{motion\} attrs=\{attrs\}>/);
    assert.match(renderer, /motion === "none" \? \(/);
  });

  test("no node gets a motion attribute without a document", () => {
    const node = blockNode({ editor: null, styles: undefined, motion: null });
    assert.deepEqual(node("field:title"), {});
    const styled = blockNode({
      editor: null,
      styles: { v: STYLE_DOCUMENT_VERSION, nodes: { "field:title": { base: { opacity: 0.5 } } } } as StyleDocument,
      motion: null,
    });
    assert.deepEqual(styled("field:title"), { style: { opacity: 0.5 } }, "an unanimated node's opacity was moved");
  });

  test("a page with no node motion gets no runtime", () => {
    const renderer = read("src/components/site/section-renderer.tsx");
    assert.match(renderer, /\{runtime \? <MotionRuntime signature=\{fingerprint\(nodeMotion\)\} \/> : null\}/);
    assert.match(renderer, /animatesAnywhere\(target\)\)\s*\n?\s*\? \[sections\[index\]!\.id, motion\.nodes\]/);
  });
});

/* -------------------------------------------------------------------------- */

describe("the legacy column always carries the document's own projection", () => {
  test("every entrance and direction projects onto one of the five", () => {
    const expected: Record<string, MotionPreset> = {
      "fade-up": "fade-up",
      fade: "fade",
      "scale-in": "scale-in",
      none: "none",
      "slide-in/start": "slide-in",
      "slide-in/end": "slide-in",
      "slide-in/up": "fade-up",
      "slide-in/down": "fade-up",
      "mask/start": "slide-in",
      "mask/end": "slide-in",
      "mask/up": "fade-up",
      "mask/down": "fade-up",
      blur: "fade",
    };
    for (const [key, preset] of Object.entries(expected)) {
      const [entrance, direction] = key.split("/") as [never, never];
      assert.equal(
        legacyProjection(doc({ base: { entrance, ...(direction ? { direction } : {}) } }), "scale-in"),
        preset,
        key,
      );
      assert.ok(LEGACY.includes(legacyProjection(doc({ base: { entrance } }), "none")));
    }
  });

  test("with no Base entrance the section keeps the legacy preset it falls back to", () => {
    assert.equal(legacyProjection(null, "slide-in"), "slide-in");
    assert.equal(legacyProjection(doc(), "scale-in"), "scale-in");
    assert.equal(legacyProjection(doc({ base: { duration: "fast" } }), "fade"), "fade");
  });

  test("only Base's section entrance is projected — widths, timing and elements have no legacy spelling", () => {
    const rich = doc(
      { base: { entrance: "blur", duration: "cinematic" }, tablet: { entrance: "mask" }, mobile: { entrance: "none" } },
      { "field:title": { base: { entrance: "mask" } } },
    );
    assert.equal(legacyProjection(rich, "fade-up"), "fade");
  });
});

/* -------------------------------------------------------------------------- */

describe("the capability model decides, once, what may move", () => {
  test("the section wrapper takes an entrance and its timing, never a stagger", () => {
    const section = motionTargetFor("why-us", "root");
    assert.equal(section.kind, "section");
    assert.deepEqual([...section.fields], ["entrance", "direction", "duration", "delay", "easing"]);
    assert.deepEqual(motionTargetFor("why-us", undefined), section);
  });

  test("a list may stagger its rows; a row, a text node and a picture may not", () => {
    const id = newItemId();
    assert.equal(motionTargetFor("why-us", "field:points").kind, "list");
    const offers = (block: string, path: string) =>
      (motionTargetFor(block, path).fields as readonly string[]).includes("stagger");
    assert.ok(offers("why-us", "field:points"));
    assert.equal(motionTargetFor("why-us", `field:points/item:${id}`).kind, "item");
    assert.equal(motionTargetFor("why-us", "field:title").kind, "text");
    assert.equal(motionTargetFor("image-text", "field:image").kind, "media");
    for (const path of [`field:points/item:${id}`, "field:title", "field:image"]) {
      assert.ok(!offers(path === "field:image" ? "image-text" : "why-us", path), path);
    }
  });

  test("an element with its own keyframes, an inline span and an icon are refused, with a reason", () => {
    for (const [block, path, reason] of [
      ["hero", "field:headline", "own"],
      ["hero", "field:eyebrow", "own"],
      ["hero", "field:lead", "own"],
      ["page-hero", "field:title", "own"],
      ["page-hero", "field:eyebrow", "own"],
      ["page-hero", "field:lead", "own"],
      ["hero", "field:words", "inline"],
      ["quick-links", `field:links/item:${newItemId()}/field:icon`, "glyph"],
      ["why-us", "div > p", "unaddressable"],
      ["why-us", "item:i_23456789", "unaddressable"],
    ] as const) {
      const capability = motionTargetFor(block, path);
      assert.equal(capability.kind, null, `${block} ${path}`);
      assert.equal(capability.kind === null && capability.reason, reason, `${block} ${path}`);
    }
  });

  test("the rule is enforced on the document, not only in the panel", () => {
    const id = newItemId();
    const kept = motionForBlock(
      doc(
        { base: { entrance: "blur", stagger: "tight" } },
        {
          "field:headline": { base: { entrance: "mask" } },
          "field:words": { base: { entrance: "fade" } },
          "field:backgroundImage": { base: { entrance: "fade", stagger: "tight" } },
        },
      ),
      "hero",
    );
    assert.deepEqual(kept, {
      v: 1,
      section: { base: { entrance: "blur" } },
      nodes: { "field:backgroundImage": { base: { entrance: "fade" } } },
    });
    const list = motionForBlock(
      doc({}, { "field:points": { base: { entrance: "fade-up", stagger: "normal" } }, [`field:points/item:${id}`]: { base: { entrance: "mask", stagger: "tight" } } }),
      "why-us",
    );
    assert.deepEqual(list.nodes["field:points"], { base: { entrance: "fade-up", stagger: "normal" } });
    assert.deepEqual(list.nodes[`field:points/item:${id}`], { base: { entrance: "mask" } });
    assert.deepEqual(motionForBlock(list, "why-us"), list, "cutting a document down twice changed it");
  });

  test("a setting is offered exactly when it can change what a visitor sees", () => {
    const list = motionTargetFor("why-us", "field:points");
    assert.deepEqual([...offeredMotionFields(list, undefined, "base")], ["entrance"]);
    assert.deepEqual(
      [...offeredMotionFields(list, { base: { entrance: "fade-up" } }, "base")],
      ["entrance", "duration", "delay", "easing", "stagger"],
    );
    assert.deepEqual(
      [...offeredMotionFields(list, { base: { entrance: "mask" } }, "base")],
      ["entrance", "direction", "duration", "delay", "easing", "stagger"],
    );
    assert.deepEqual(
      [...offeredMotionFields(list, { base: { entrance: "fade-up" }, mobile: { entrance: "none" } }, "mobile")],
      ["entrance"],
    );
    const section = motionTargetFor("why-us", "root");
    // The section always has an entrance — the legacy preset stands in.
    assert.deepEqual([...offeredMotionFields(section, undefined, "base", "slide-in")], [
      "entrance",
      "direction",
      "duration",
      "delay",
      "easing",
    ]);
    assert.deepEqual([...offeredMotionFields(section, undefined, "base", "none")], ["entrance"]);
  });

  test("the panel and the renderer agree about who owns a staggered row", () => {
    const id = newItemId();
    const staggered = doc({}, { "field:points": { base: { entrance: "fade-up", stagger: "none" } } });
    const still = doc({}, { "field:points": { base: { stagger: "tight" } } });
    assert.equal(isStaggerGroup(staggered.nodes["field:points"]), true, "stagger none is still a group");
    assert.equal(ownedByParentList(staggered, `field:points/item:${id}`), true);
    assert.equal(isStaggerGroup(still.nodes["field:points"]), false, "a stagger with nothing to send");
    assert.equal(ownedByParentList(still, `field:points/item:${id}`), false);
  });
});

/* -------------------------------------------------------------------------- */

describe("a node's motion is folded into the element it already is", () => {
  const id = newItemId();
  const styles = {
    v: STYLE_DOCUMENT_VERSION,
    nodes: {
      "field:title": { base: { opacity: 0.5 }, tablet: { opacity: 0.8 } },
      [`field:points/item:${id}`]: { base: { opacity: 0.6 } },
      "field:points": { base: { opacity: 0.9 } },
    },
  } as unknown as StyleDocument;

  test("an entrance marks the node and carries its variables, with no wrapper", () => {
    const node = blockNode({ editor: null, styles: undefined, motion: doc({}, { "field:title": { base: { entrance: "blur", delay: 300 } } }) });
    const attrs = node("field:title");
    assert.equal(attrs["data-m-reveal"], "");
    assert.equal((attrs.style as Record<string, string>)["--m-blur"], "8px");
    assert.equal((attrs.style as Record<string, string>)["--m-delay"], "300ms");
  });

  test("Style opacity becomes the finished state of anything that fades, at every width", () => {
    const node = blockNode({ editor: null, styles, motion: doc({}, { "field:title": { base: { entrance: "fade" } } }) });
    const attrs = node("field:title");
    const style = attrs.style as Record<string, string>;
    assert.equal(style.opacity, undefined, "an inline opacity would win over the hidden state");
    assert.equal(style["--eod-node-opacity"], "0.5");
    assert.match(attrs["data-rs-t"] ?? "", /\breveal-opacity\b/);
    assert.ok(!/(^| )opacity( |$)/.test(attrs["data-rs-t"] ?? ""));
  });

  test("a staggering list stays still and its rows take its entrance", () => {
    const motion = doc({}, {
      "field:points": { base: { entrance: "fade-up", stagger: "normal" } },
      [`field:points/item:${id}`]: { base: { entrance: "mask" } },
    });
    const node = blockNode({ editor: null, styles, motion });
    const list = node("field:points");
    assert.equal(list["data-m-group"], "");
    assert.equal(list["data-m-reveal"], undefined);
    assert.equal((list.style as Record<string, string>).opacity, 0.9 as unknown as string, "the list's own opacity is not a finished state");
    const row = node(`field:points/item:${id}`, "item");
    assert.equal(row["data-m-member"], "");
    assert.equal(row["data-m-reveal"], undefined, "a row kept its own entrance inside a staggering list");
    assert.equal((row.style as Record<string, string>)["--eod-node-opacity"], "0.6");
    assert.equal((row.style as Record<string, string>)["--m-clip-e"], undefined);
  });

  test("the section wrapper is never a node here — the renderer owns it", () => {
    const node = blockNode({ editor: null, styles: undefined, motion: doc({ base: { entrance: "blur" } }, { root: { base: { entrance: "fade" } } }) });
    assert.deepEqual(node(undefined, "section"), {});
  });

  test("no Style token writes a property an entrance animates", () => {
    // Transform ownership from the other side: Batch 14 styles never set
    // translate, scale, filter or clip-path, so an entrance cannot erase one
    // and one cannot pin an entrance.
    const source = read("src/lib/cms/style-css.ts");
    for (const property of ["translate", "scale", "filter", "clipPath", "clip-path", "animation", "transition"]) {
      assert.ok(!new RegExp(`\\bout\\.${property}\\b|["']${property}["']\\s*:`).test(source), property);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("one observer per page, and nothing per frame", () => {
  const site = path.join(REPO_ROOT, "src");
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry)) files.push(full);
    }
  };
  walk(site);
  const code = (file: string) => readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");

  test("every entrance is observed by one module; the only other observer is the Stats count-up", () => {
    // `counter.tsx` is the pre-existing count-up on a Stats figure — decorative
    // motion that no document drives, one per figure (at most four). It is
    // named here so that a second entrance observer cannot hide behind it.
    const constructing = files.filter((file) => /new IntersectionObserver\(/.test(code(file)));
    assert.deepEqual(
      constructing.map((file) => path.relative(REPO_ROOT, file)).sort(),
      ["src/components/site/counter.tsx", "src/components/site/motion-observer.ts"],
    );
  });

  test("the motion modules listen to no scroll and run no frame loop", () => {
    // The Visual Editor's bridge does listen to scroll — it keeps an outline on
    // its element — and only exists inside the editor's canvas.
    for (const file of [
      "src/components/site/motion-observer.ts",
      "src/components/site/motion-runtime.tsx",
      "src/components/site/reveal.tsx",
      "src/components/site/section-motion.tsx",
      "src/lib/cms/motion-css.ts",
      "src/lib/cms/motion-doc.ts",
      "src/lib/cms/node.ts",
    ]) {
      const text = code(path.join(REPO_ROOT, file));
      assert.ok(!/addEventListener\(\s*["']scroll["']/.test(text), `${file} listens to scroll`);
      assert.ok(!/requestAnimationFrame\(/.test(text), `${file} runs a frame loop`);
      assert.ok(!/getBoundingClientRect|offsetTop|offsetHeight/.test(text), `${file} measures layout`);
    }
  });

  test("the runtime registers lists and nodes, never a list's rows", () => {
    const runtime = read("src/components/site/motion-runtime.tsx");
    assert.match(runtime, /"\[data-m-reveal\]:not\(\[data-shown\]\), \[data-m-group\]:not\(\[data-shown\]\)"/);
    assert.ok(!/data-m-member/.test(code(path.join(REPO_ROOT, "src/components/site/motion-runtime.tsx"))));
  });

  test("Reveal and the section wrapper go through the shared observer", () => {
    for (const file of ["src/components/site/reveal.tsx", "src/components/site/section-motion.tsx"]) {
      assert.ok(!/new IntersectionObserver/.test(read(file)), file);
    }
    assert.match(read("src/components/site/reveal.tsx"), /return whenReached\(node, \(\) => setShown\(true\)\);/);
  });

  test("a thousand waiting elements are one observer, shown once each, and all released", async () => {
    type Entry = { target: object; isIntersecting: boolean };
    const created: FakeObserver[] = [];
    class FakeObserver {
      observed = new Set<object>();
      constructor(readonly callback: (entries: Entry[]) => void, readonly options: unknown) {
        created.push(this);
      }
      observe(target: object) {
        this.observed.add(target);
      }
      unobserve(target: object) {
        this.observed.delete(target);
      }
      disconnect() {
        this.observed.clear();
      }
    }
    const globals = globalThis as unknown as Record<string, unknown>;
    let reduced = false;
    globals.IntersectionObserver = FakeObserver;
    globals.window = { matchMedia: () => ({ matches: reduced }) };
    try {
      const { whenReached, revealObserverStats, REVEAL_OBSERVER_OPTIONS } = await import(
        "@/components/site/motion-observer"
      );
      const shown: number[] = [];
      const elements = Array.from({ length: 1000 }, (_, index) => ({ index }));
      const stops = elements.map((element) => whenReached(element as never, () => shown.push(element.index)));

      assert.equal(created.length, 1, "more than one observer");
      assert.deepEqual(created[0]!.options, REVEAL_OBSERVER_OPTIONS);
      assert.deepEqual(REVEAL_OBSERVER_OPTIONS, { rootMargin: "0px 0px -8% 0px", threshold: 0.08 });
      assert.deepEqual(revealObserverStats(), { observers: 1, waiting: 1000 });

      // Not yet reached: nothing happens.
      created[0]!.callback(elements.slice(0, 10).map((target) => ({ target, isIntersecting: false })));
      assert.equal(shown.length, 0);
      // Reached: shown once, and released.
      created[0]!.callback(elements.slice(0, 10).map((target) => ({ target, isIntersecting: true })));
      created[0]!.callback(elements.slice(0, 10).map((target) => ({ target, isIntersecting: true })));
      assert.deepEqual(shown, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
      assert.equal(created[0]!.observed.size, 990);

      // Unmounting releases the rest.
      stops.forEach((stop) => stop());
      assert.deepEqual(revealObserverStats(), { observers: 1, waiting: 0 });
      assert.equal(created[0]!.observed.size, 0);

      // Reduced motion never waits for a scroll.
      reduced = true;
      let immediate = false;
      whenReached({} as never, () => (immediate = true));
      assert.equal(immediate, true);
      assert.deepEqual(revealObserverStats(), { observers: 1, waiting: 0 });
      assert.equal(created.length, 1);
    } finally {
      delete globals.IntersectionObserver;
      delete globals.window;
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("every writer produces both motion columns from one decision", () => {
  test("the fallback is the published preset once a document draft exists", () => {
    assert.equal(legacyFallback(motionRow({ animation: "slide-in" })), "slide-in");
    assert.equal(legacyFallback(motionRow({ animation: "slide-in", draftAnimation: "scale-in" })), "scale-in");
    // A document draft's preset is its projection, not a choice.
    const blur = doc({ base: { entrance: "blur" } });
    assert.equal(
      legacyFallback(motionRow({ animation: "slide-in", draftAnimation: "fade", draftMotionConfig: blur })),
      "slide-in",
    );
    // …unless something that does not know documents has changed it since.
    assert.equal(
      legacyFallback(motionRow({ animation: "slide-in", draftAnimation: "scale-in", draftMotionConfig: doc() })),
      "scale-in",
    );
  });

  test("a document is written with its own projection beside it", () => {
    const row = motionRow({ animation: "fade-up" });
    const blur = motionDraftFromDocument(row, "why-us", doc({ base: { entrance: "blur" } }));
    assert.equal(blur.draftAnimation, "fade");
    assert.deepEqual(blur.draftMotionConfig, doc({ base: { entrance: "blur" } }));
    const nodesOnly = motionDraftFromDocument(row, "why-us", doc({}, { "field:title": { base: { entrance: "mask" } } }));
    assert.equal(nodesOnly.draftAnimation, "fade-up", "a document silent about the section keeps the live preset");
  });

  test("a submitted document is cut down to the block before it is stored", () => {
    const draft = motionDraftFromDocument(motionRow(), "hero", doc({}, { "field:headline": { base: { entrance: "mask" } } }));
    assert.deepEqual(draft.draftMotionConfig, doc());
  });

  test("the first document over a pending preset keeps that preset, in the document", () => {
    const row = motionRow({ animation: "fade-up", draftAnimation: "scale-in" });
    const draft = motionDraftFromDocument(row, "why-us", doc({}, { "field:title": { base: { entrance: "blur" } } }));
    assert.deepEqual(draft.draftMotionConfig!.section, { base: { entrance: "scale-in" } });
    assert.equal(draft.draftAnimation, "scale-in");
    // And it still renders on the legacy class it rendered on before.
    assert.equal(legacySectionPreset(effectiveSectionTarget(draft.draftMotionConfig, "fade-up")), "scale-in");
  });

  test("a preset with no document anywhere is the Batch 9 write, alone", () => {
    assert.deepEqual(motionDraftFromPreset(motionRow(), "why-us", "slide-in"), {
      draftAnimation: "slide-in",
      draftMotionConfig: null,
    });
  });

  test("a preset over a document becomes the section's Base entrance inside it", () => {
    const row = motionRow({ motionConfig: doc({ base: { entrance: "blur", duration: "fast" } }, { "field:title": { base: { entrance: "mask" } } }) });
    const draft = motionDraftFromPreset(row, "why-us", "scale-in");
    assert.deepEqual(draft.draftMotionConfig, doc({ base: { entrance: "scale-in", duration: "fast" } }, { "field:title": { base: { entrance: "mask" } } }));
    assert.equal(draft.draftAnimation, "scale-in");
  });

  test("the document an edit starts from is the draft, else the published one", () => {
    const live = doc({ base: { entrance: "blur" } });
    const pending = doc({ base: { entrance: "mask" } });
    assert.deepEqual(currentMotionDocument(motionRow({ motionConfig: live })), live);
    assert.deepEqual(currentMotionDocument(motionRow({ motionConfig: live, draftMotionConfig: pending })), pending);
    assert.equal(currentMotionDocument(motionRow()), null);
  });
});

/* -------------------------------------------------------------------------- */

describe("publishing promotes both columns, or refuses", () => {
  test("nothing pending promotes nothing", () => {
    assert.deepEqual(motionPromotion(motionRow({ motionConfig: doc({ base: { entrance: "blur" } }) }), "why-us"), {
      ok: true,
      values: {},
    });
  });

  test("a preset alone is the Batch 9 promotion", () => {
    assert.deepEqual(motionPromotion(motionRow({ draftAnimation: "scale-in" }), "why-us"), {
      ok: true,
      values: { animation: "scale-in", draftAnimation: null },
    });
  });

  test("a document is promoted with its projection, and both drafts are cleared", () => {
    const blur = doc({ base: { entrance: "blur" } }, { "field:title": { base: { entrance: "mask" } } });
    assert.deepEqual(
      motionPromotion(motionRow({ draftAnimation: "fade", draftMotionConfig: blur }), "why-us"),
      { ok: true, values: { animation: "fade", draftAnimation: null, motionConfig: blur, draftMotionConfig: null } },
    );
  });

  test("an empty document draft publishes as no advanced motion at all", () => {
    const promoted = motionPromotion(
      motionRow({ animation: "fade", motionConfig: doc({ base: { entrance: "blur" } }), draftAnimation: "fade-up", draftMotionConfig: doc() }),
      "why-us",
    );
    assert.deepEqual(promoted, {
      ok: true,
      values: { animation: "fade-up", draftAnimation: null, motionConfig: null, draftMotionConfig: null },
    });
  });

  test("an unreadable pending preset or document refuses the whole publication", () => {
    assert.deepEqual(motionPromotion(motionRow({ draftAnimation: "zoom" }), "why-us"), { ok: false });
    for (const bad of [{ v: 2, section: {} }, "x", [], { section: {} }]) {
      assert.deepEqual(
        motionPromotion(motionRow({ draftAnimation: "fade-up", draftMotionConfig: bad }), "why-us"),
        { ok: false },
        JSON.stringify(bad),
      );
    }
  });

  test("the published pair stays coherent whoever wrote the drafts", () => {
    // A preset written by a release that does not know documents, beside a
    // document written by this one: the document wins where it speaks.
    const promoted = motionPromotion(
      motionRow({ animation: "fade-up", draftAnimation: "scale-in", draftMotionConfig: doc({ base: { entrance: "mask", direction: "up" } }) }),
      "why-us",
    );
    assert.equal(promoted.ok && promoted.values.animation, "fade-up");
    // …and the preset wins where the document is silent.
    const silent = motionPromotion(
      motionRow({ animation: "fade-up", draftAnimation: "scale-in", draftMotionConfig: doc({}, { "field:title": { base: { entrance: "blur" } } }) }),
      "why-us",
    );
    assert.equal(silent.ok && silent.values.animation, "scale-in");
    // A pending preset under a published document with a Base entrance.
    const outranked = motionPromotion(
      motionRow({ animation: "fade", draftAnimation: "scale-in", motionConfig: doc({ base: { entrance: "blur" } }) }),
      "why-us",
    );
    assert.deepEqual(outranked, { ok: true, values: { animation: "fade", draftAnimation: null } });
  });

  test("what publishing writes is what the preview rendered", () => {
    const cases: MotionRow[] = [
      motionRow({ draftMotionConfig: doc({ base: { entrance: "blur", duration: "fast" } }), draftAnimation: "fade" }),
      motionRow({ animation: "slide-in", draftMotionConfig: doc({}, { "field:title": { base: { entrance: "mask" } } }), draftAnimation: "slide-in" }),
      motionRow({ animation: "scale-in", draftAnimation: "none" }),
      motionRow({ animation: "fade", motionConfig: doc({ tablet: { entrance: "none" } }), draftAnimation: "slide-in" }),
    ];
    for (const row of cases) {
      const preview = composePreview([compositionRow(row)], null)[0]!;
      const promoted = motionPromotion(row, "why-us");
      assert.ok(promoted.ok);
      const after: MotionRow = { ...row, draftAnimation: null, draftMotionConfig: null, ...promoted.values } as MotionRow;
      const live = composePublished([compositionRow(after)])[0]!;
      assert.deepEqual(
        effectiveSectionTarget(live.motion, live.animation),
        effectiveSectionTarget(preview.motion, preview.animation),
        JSON.stringify(row),
      );
      assert.deepEqual(live.motion?.nodes ?? {}, preview.motion?.nodes ?? {});
    }
  });
});

function compositionRow(row: MotionRow): CompositionRow {
  return {
    id: 1,
    blockType: "why-us",
    animation: row.animation,
    draftAnimation: row.draftAnimation,
    published: {},
    draft: null,
    styles: null,
    draftStyles: null,
    motionConfig: row.motionConfig as Record<string, unknown> | null,
    draftMotionConfig: row.draftMotionConfig as Record<string, unknown> | null,
    isPublished: true,
    isDraftOnly: false,
  };
}

/* -------------------------------------------------------------------------- */

describe("the classic form's one menu", () => {
  const blur = doc({ base: { entrance: "blur" } }, { "field:title": { base: { entrance: "mask" } } });

  test("a section with no document keeps every Batch 9 rule, inline where it always was", () => {
    assert.equal(classicMotionWrite(motionRow(), "why-us", "scale-in", false), null);
    assert.equal(classicMotionWrite(motionRow(), "why-us", "scale-in", true), null);
    const actions = read("src/app/(backoffice)/admin/(shell)/pages/actions.ts");
    assert.match(actions, /draftAnimation: chosen === motionOf\(section\.animation\) \? null : chosen/);
  });

  test("an untouched menu says nothing about a document", () => {
    // The form shows Blur's projection, Fade, and sends it back unchanged.
    const row = motionRow({ animation: "fade", motionConfig: blur });
    assert.deepEqual(classicMotionWrite(row, "why-us", "fade", false), { ok: true, values: {} });
  });

  test("…and publishing with it untouched publishes the pending motion as it stands", () => {
    const pending = doc({ base: { entrance: "mask" } });
    const row = motionRow({ animation: "fade", motionConfig: blur, draftAnimation: "slide-in", draftMotionConfig: pending });
    assert.deepEqual(classicMotionWrite(row, "why-us", "slide-in", true), motionPromotion(row, "why-us"));
  });

  test("a changed menu replaces only the section's own entrance", () => {
    const written = classicMotionWrite(motionRow({ animation: "fade", motionConfig: blur }), "why-us", "scale-in", false);
    assert.deepEqual(written, {
      ok: true,
      values: {
        draftAnimation: "scale-in",
        draftMotionConfig: doc({ base: { entrance: "scale-in" } }, { "field:title": { base: { entrance: "mask" } } }),
      },
    });
  });

  test("a menu changed back to what is published withdraws the draft — never an element's motion", () => {
    const live = doc({ base: { entrance: "slide-in" } });
    const row = motionRow({ animation: "slide-in", motionConfig: live, draftAnimation: "scale-in", draftMotionConfig: doc({ base: { entrance: "scale-in" } }) });
    assert.deepEqual(classicMotionWrite(row, "why-us", "slide-in", false), {
      ok: true,
      values: { draftAnimation: null, draftMotionConfig: null },
    });
    // With element motion pending, the same menu keeps it.
    const withNodes = motionRow({
      animation: "slide-in",
      motionConfig: live,
      draftAnimation: "scale-in",
      draftMotionConfig: doc({ base: { entrance: "scale-in" } }, { "field:title": { base: { entrance: "blur" } } }),
    });
    const kept = classicMotionWrite(withNodes, "why-us", "slide-in", false);
    assert.ok(kept?.ok);
    assert.deepEqual((kept.values.draftMotionConfig as MotionDocument).nodes, { "field:title": { base: { entrance: "blur" } } });
  });

  test("the screen says when it is showing the nearest preset", () => {
    assert.equal(hasAdvancedMotion(motionRow()), false);
    assert.equal(hasAdvancedMotion(motionRow({ motionConfig: doc({ base: { entrance: "fade-up" } }) })), false);
    assert.equal(hasAdvancedMotion(motionRow({ motionConfig: blur })), true);
    assert.equal(hasAdvancedMotion(motionRow({ motionConfig: doc({ base: { duration: "fast" } }) })), true);
    assert.match(read("src/app/(backoffice)/admin/(shell)/pages/section/[id]/section-form.tsx"), /data-advanced-motion="true"/);
  });
});

/* -------------------------------------------------------------------------- */

describe("a motion document alone is a draft everywhere a draft is counted", () => {
  const empty = { draft: null, draftStyles: null, draftAnimation: null };

  test("a document draft is a motion draft, even an empty one", () => {
    assert.deepEqual(draftDomainsOf({ ...empty, draftMotionConfig: doc({}, { "field:title": { base: { entrance: "blur" } } }) }), ["motion"]);
    assert.equal(draftKindOf({ ...empty, draftMotionConfig: doc() }), "motion");
    assert.equal(draftKindOf({ ...empty, draftMotionConfig: null }), "none");
  });

  test("the preview composes the document draft whole, the live page never does", () => {
    const pending = doc({}, { "field:title": { base: { entrance: "mask" } } });
    const row = compositionRow(motionRow({ motionConfig: doc({ base: { entrance: "blur" } }), draftMotionConfig: pending }));
    const preview = composePreview([row], null)[0]!;
    assert.deepEqual(preview.motion, pending);
    assert.equal(preview.hasMotionDraft, true);
    assert.equal(preview.isDraft, true);
    const live = composePublished([row])[0]!;
    assert.deepEqual(live.motion, doc({ base: { entrance: "blur" } }));
    assert.equal(live.hasMotionDraft, false);
  });

  test("the list counters test all four draft columns", () => {
    const sqlHelper = read("src/lib/cms/draft-sql.ts");
    for (const column of ["draft", "draftStyles", "draftAnimation", "draftMotionConfig"]) {
      assert.match(sqlHelper, new RegExp(`isNotNull\\(pageSections\\.${column}\\)`));
    }
    assert.match(read("src/app/(backoffice)/admin/(shell)/pages/page.tsx"), /filter \(where \$\{sectionHasDraft\}\)/);
    assert.match(read("src/app/(backoffice)/admin/(shell)/page.tsx"), /\.where\(sectionHasDraft\)/);
  });

  test("both discards clear the document draft beside the preset", () => {
    const service = read("src/lib/cms/publish-service.ts");
    const discard = service.slice(service.indexOf("export async function discardPageChanges"));
    assert.match(discard.slice(0, discard.indexOf("deleteSectionGuardedIn")), /draftAnimation: null,\s*draftMotionConfig: null,/);
    const actions = read("src/app/(backoffice)/admin/(shell)/pages/actions.ts");
    const section = actions.slice(actions.indexOf("export async function discardDraft"));
    assert.match(section.slice(0, section.indexOf("if (!result.ok)")), /draftAnimation: null,\s*draftMotionConfig: null,/);
  });

  test("a restore refuses a page with a document draft on it", () => {
    const versions = read("src/lib/versions.ts");
    assert.match(versions, /row\.draftAnimation !== null \|\|\s*row\.draftMotionConfig !== null/);
  });
});

/* -------------------------------------------------------------------------- */

describe("history keeps the published document, and restore puts it back as a draft", () => {
  const blur = doc({ base: { entrance: "blur" } }, { "field:title": { base: { entrance: "mask" } } });
  const snapshotRow = (motionConfig: unknown, extra: Record<string, unknown> = {}) => ({
    id: 5,
    blockType: "why-us",
    isPublished: true,
    published: {},
    styles: null,
    animation: "fade",
    motionConfig,
    ...extra,
  });

  test("a snapshot carries the document as a seventh key only when there is one", () => {
    const [withMotion] = snapshotFromSections([snapshotRow(blur)]).sections;
    assert.deepEqual(withMotion!.motion, blur);
    const [without] = snapshotFromSections([snapshotRow(null)]).sections;
    assert.ok(!("motion" in without!), "a page with no advanced motion snapshots differently than before");
    const [empty] = snapshotFromSections([snapshotRow(doc())]).sections;
    assert.ok(!("motion" in empty!), "an empty document is no motion");
  });

  test("the snapshot is still v1, so the previous release can read every restore point", () => {
    assert.equal(PAGE_SNAPSHOT_VERSION, 1);
  });

  test("a stored snapshot's document is rebuilt through the vocabulary and the block", () => {
    const snapshot = validatePageSnapshot({
      v: 1,
      sections: [
        {
          sourceSectionId: 5,
          blockType: "hero",
          visible: true,
          published: {},
          animation: "fade",
          motion: { v: 1, section: { base: { entrance: "blur", css: "x" } }, nodes: { "field:headline": { base: { entrance: "mask" } }, "div > p": {} } },
        },
      ],
    });
    assert.deepEqual(snapshot.sections[0]!.motion, doc({ base: { entrance: "blur" } }));
  });

  test("a version holding a document from a newer build is refused, not flattened", () => {
    const read = readPageSnapshot({
      v: 1,
      sections: [{ sourceSectionId: 5, blockType: "why-us", visible: true, published: {}, animation: "fade", motion: { v: 9 } }],
    });
    assert.deepEqual(read, { ok: false, reason: "unsupported" });
  });

  test("restore writes the version's document when it differs, an empty one to take it away, and nothing when they agree", () => {
    const version = (motion?: MotionDocument) =>
      validatePageSnapshot({
        v: 1,
        sections: [{ sourceSectionId: 5, blockType: "why-us", visible: true, published: {}, animation: "fade", ...(motion ? { motion } : {}) }],
      });
    const plan = (motion: MotionDocument | undefined, live: unknown) =>
      planRestoreFrom(1, version(motion), [{ id: 5, blockType: "why-us", motionConfig: live }]).drafts[0]!;

    assert.deepEqual(plan(blur, null).draftMotionConfig, blur);
    assert.deepEqual(plan(undefined, blur).draftMotionConfig, emptyMotionDocument());
    assert.equal(plan(blur, blur).draftMotionConfig, null);
    assert.equal(plan(undefined, null).draftMotionConfig, null);
    // The preset beside it is the one the version published.
    assert.equal(plan(blur, null).draftAnimation, "fade");
    // No live column is ever in a restore draft.
    for (const key of ["animation", "motionConfig", "published", "styles"]) {
      assert.ok(!(key in plan(blur, null)), key);
    }
  });

  test("a recreated section only carries a document if its version had one", () => {
    const snapshot = validatePageSnapshot({
      v: 1,
      sections: [
        { sourceSectionId: 7, blockType: "why-us", visible: true, published: {}, animation: "fade", motion: blur },
        { sourceSectionId: 8, blockType: "why-us", visible: true, published: {}, animation: "fade-up" },
      ],
    });
    const plan = planRestoreFrom(1, snapshot, []);
    assert.deepEqual(plan.recreate.map((entry) => entry.draftMotionConfig), [blur, null]);
  });
});

/* -------------------------------------------------------------------------- */

describe("a duplicate's motion points at the duplicate", () => {
  test("row paths move through the copy's id table; rows it does not have are dropped", () => {
    const [a, b, gone, fresh] = [newItemId(), newItemId(), newItemId(), newItemId()];
    const source = doc(
      { base: { entrance: "blur" } },
      {
        "field:points": { base: { entrance: "fade-up", stagger: "tight" } },
        [`field:points/item:${a}`]: { base: { entrance: "mask" } },
        [`field:points/item:${b}/field:label`]: { base: { entrance: "fade" } },
        [`field:points/item:${gone}`]: { base: { entrance: "fade" } },
      },
    );
    const moved = remapMotionItemIds(source, new Map([[a, fresh], [b, "i_" + "b".repeat(10)]]));
    assert.deepEqual(moved.section, source.section, "the section's own motion is copied as it is");
    assert.deepEqual(
      Object.keys(moved.nodes).sort(),
      ["field:points", `field:points/item:${"i_" + "b".repeat(10)}/field:label`, `field:points/item:${fresh}`].sort(),
    );
    assert.ok(!JSON.stringify(moved).includes(a), "a copied path still names the original's row");
    assert.ok(!JSON.stringify(moved).includes(gone));
  });

  test("an empty table drops every row path rather than keeping the original's", () => {
    const id = newItemId();
    const moved = remapMotionItemIds(doc({}, { [`field:points/item:${id}`]: { base: { entrance: "fade" } }, "field:title": { base: { entrance: "blur" } } }), new Map());
    assert.deepEqual(Object.keys(moved.nodes), ["field:title"]);
  });

  test("the duplicate stores what the original previews, with its own projection and no pending draft", () => {
    const service = read("src/lib/cms/structure-service.ts");
    const body = service.slice(service.indexOf("export async function duplicateStructureSection"));
    assert.match(body, /const sourceMotion = currentMotionDocument\(source\);/);
    assert.match(body, /motionForBlock\(remapMotionItemIds\(sourceMotion, ids\), source\.blockType\)/);
    assert.match(body, /animation: legacyProjection\(copiedMotion, effectiveMotion\(source\.animation, source\.draftAnimation\)\),/);
    assert.match(body, /motionConfig: copiedMotion && !isEmptyMotionDocument\(copiedMotion\) \? copiedMotion : null,/);
    assert.ok(!/draftMotionConfig:/.test(body.slice(0, body.indexOf(".returning("))), "a new section was given a pending motion draft");
  });
});
