/**
 * Reusable components — the rules that need no server (Batch 17).
 *
 * The reference model is pure on purpose: one resolver draws a linked section
 * for the public page, a page preview, the editor's canvas, a component's own
 * preview, detaching and a restore point alike, and the instance edits —
 * link, override, reset, detach — are value transforms the editor's Undo can
 * take back. What only a running server can answer (the database checks,
 * publication, history, previews, permissions) is in
 * `tests/visual-reusable.test.ts`.
 *
 * Numbers in the test names are the Batch 17 brief's §71 items.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { getBlock } from "@/lib/cms/blocks";
import { composeSnapshot } from "@/lib/cms/composition";
import { REUSE_AUTHORITY } from "@/lib/cms/reuse/authority";
import {
  CTA_DEFINITION,
  EXCLUDED_BLOCK_REASONS,
  REUSABLE_BLOCK_TYPES,
  REUSABLE_KINDS,
  blockKindOf,
  isReusableKind,
  kindDef,
} from "@/lib/cms/reuse/kinds";
import { pickerEntries } from "@/lib/cms/reuse/picker";
import {
  BLOCK_SLOT,
  REUSE_KEY,
  detachSlot,
  directEditDecision,
  effectiveSlotValues,
  hasSeparateLinks,
  linkSlot,
  parseReuse,
  pinReuse,
  readReuse,
  resolveReuse,
  setOverride,
  slotContent,
  slotDef,
  slotsOf,
  stripReuse,
  unpinReuse,
  WHOLE_BLOCK_REFUSAL,
  withReuse,
  type ComponentSource,
} from "@/lib/cms/reuse/reference";
import { EMPTY_USAGE, impactSentence, summarise, usageHeadline, type UsageInstance } from "@/lib/cms/reuse/usage-view";
import type { ReuseCatalogEntry } from "@/lib/cms/reuse/view";
import { validatePageSnapshot, type PageSnapshot } from "@/lib/cms/snapshot";
import { validateBlockValues } from "@/lib/cms/validate";
import { emptyValues } from "@/lib/cms/values";
import { applyContent, diffContent, groupOf } from "@/lib/visual-editor/history";
import { diffSnapshots, hasReuse, REUSE_DISCLAIMER, reuseChanges } from "@/lib/visual-editor/compare";

const ROOT = path.resolve(__dirname, "..");
const source = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

type Values = Record<string, unknown>;

/** A published reusable CTA, as the resolver sees it. */
const cta = (id: number, en: string, ar: string, href: string, version = 1): ComponentSource => ({
  id,
  kind: "cta",
  values: { label: { en, ar }, href },
  version,
});

const lookup = (...sources: ComponentSource[]) => (id: number) => sources.find((entry) => entry.id === id);

/** A closing call to action with its own words. */
const finalCta = (): Values => ({
  ...emptyValues(getBlock("final-cta")!),
  title: { en: "Ready?", ar: "جاهز؟" },
  body: { en: "Talk to us.", ar: "تحدث إلينا." },
  primaryCtaLabel: { en: "Local label", ar: "تسمية محلية" },
  primaryCtaHref: "/local",
  showWhatsapp: true,
});

/* ========================================================================== */
/* Kinds and validation                                                       */
/* ========================================================================== */

describe("1–3 · a component is values of a registered kind, and nothing else", () => {
  test("1 · a reusable CTA is two fields, validated by the ordinary block validator", () => {
    const def = kindDef("cta")!;
    assert.equal(def.definition, CTA_DEFINITION);
    assert.deepEqual(
      def.definition.fields.map((field) => [field.name, field.type, Boolean(field.localised)]),
      [
        ["label", "text", true],
        ["href", "link", false],
      ],
    );
    const values = validateBlockValues(def.definition, {
      label: { en: "  Contact us  ", ar: "اتصل بنا" },
      href: "javascript:alert(1)",
      style: "color:red",
      className: "evil",
    });
    assert.deepEqual(values, { label: { en: "Contact us", ar: "اتصل بنا" }, href: "" });
    assert.equal(validateBlockValues(def.definition, { href: "/contact" }).href, "/contact");
  });

  test("2 · a reusable block is its block's own declaration: undeclared keys go, rich text is sanitised", () => {
    assert.deepEqual([...REUSABLE_BLOCK_TYPES], ["final-cta", "rich-text", "image-text"]);
    for (const type of REUSABLE_BLOCK_TYPES) {
      const def = kindDef(`block:${type}`)!;
      assert.equal(def.definition, getBlock(type));
      assert.equal(def.blockType, type);
      assert.equal(blockKindOf(type), `block:${type}`);
    }
    const rich = kindDef("block:rich-text")!.definition;
    const values = validateBlockValues(rich, {
      title: { en: "Hello", ar: "" },
      body: { en: "<p>Hi<script>alert(1)</script></p>", ar: "" },
      _reuse: { block: { c: 3 } },
      html: "<div>",
    });
    assert.equal("html" in values, false);
    assert.equal(REUSE_KEY in values, false, "a component's values never reference another component");
    assert.doesNotMatch(String((values.body as Values).en), /script/);
  });

  test("3 · markup is not a kind: the closed list, every excluded block named with its reason", () => {
    assert.equal(isReusableKind("cta"), true);
    for (const bad of ["html", "block:hero", "block:faq", "block:page-hero", "css", "", "block:egypt-feature"]) {
      assert.equal(isReusableKind(bad), false, bad);
    }
    assert.deepEqual(
      REUSABLE_KINDS.map((entry) => entry.kind),
      ["cta", "block:final-cta", "block:rich-text", "block:image-text"],
    );
    for (const type of ["hero", "quick-links", "one-desk", "service-grid", "featured-service", "process", "stats", "page-hero", "contact-details", "faq"]) {
      assert.ok(EXCLUDED_BLOCK_REASONS[type], `${type} has a reason`);
      assert.equal(blockKindOf(type), null);
    }
    // Every registered block is either reusable whole, or excluded with a reason.
    for (const type of ["hero", "final-cta", "rich-text", "image-text", "packages-grid", "why-us", "travel-feature"]) {
      assert.ok(blockKindOf(type) !== null || EXCLUDED_BLOCK_REASONS[type], type);
    }
  });
});

/* ========================================================================== */
/* The reference                                                              */
/* ========================================================================== */

describe("4 · references are by stable id, never by name, position or selector", () => {
  test("slots come from the registry's CTA pairs, plus the whole block where allowed", () => {
    assert.deepEqual(slotsOf("hero").map((slot) => slot.slot), ["primaryCta", "secondaryCta"]);
    assert.deepEqual(slotsOf("image-text").map((slot) => slot.slot), ["cta", BLOCK_SLOT]);
    assert.deepEqual(slotsOf("final-cta").map((slot) => slot.slot), ["primaryCta", BLOCK_SLOT]);
    assert.deepEqual(slotsOf("rich-text").map((slot) => slot.slot), [BLOCK_SLOT]);
    assert.deepEqual(slotsOf("faq"), []);
    assert.deepEqual(slotDef("hero", "primaryCta")!.fields.map((field) => field.name), ["primaryCtaLabel", "primaryCtaHref"]);
    assert.equal(slotDef("hero", "primaryCta")!.label, "Primary call to action");
    assert.deepEqual(slotDef("hero", "primaryCta")!.overridable, [
      "primaryCtaHref",
      "primaryCtaLabel.ar",
      "primaryCtaLabel.en",
    ]);
  });

  test("a save's reference is read strictly — ids only, known slots, known override keys", () => {
    assert.deepEqual(parseReuse(undefined, "hero"), { ok: true, map: {} });
    assert.deepEqual(parseReuse({ primaryCta: { c: 12, o: ["primaryCtaLabel.en"] } }, "hero"), {
      ok: true,
      map: { primaryCta: { c: 12, o: ["primaryCtaLabel.en"] } },
    });
    for (const bad of [
      "12",
      [],
      { primaryCta: { c: "12" } },
      { primaryCta: { c: 0 } },
      { primaryCta: { c: -1 } },
      { primaryCta: { c: 2 ** 31 } },
      { primaryCta: { c: 1.5 } },
      { primaryCta: { name: "Primary Contact CTA" } },
      { primaryCta: { c: 12, v: 3 } },
      { primaryCta: { c: 12, o: ["title.en"] } },
      { primaryCta: { c: 12, o: ["primaryCtaLabel.en", "primaryCtaLabel.en"] } },
      { primaryCta: { c: 12, o: "primaryCtaLabel.en" } },
      { tertiaryCta: { c: 12 } },
      { block: { c: 12 } },
    ]) {
      assert.deepEqual(parseReuse(bad, "hero"), { ok: false }, JSON.stringify(bad));
    }
    // A whole-block link excludes the CTA slots it already supplies.
    assert.deepEqual(parseReuse({ block: { c: 1 }, primaryCta: { c: 2 } }, "final-cta"), { ok: false });
  });

  test("reading is tolerant: an unreadable entry is dropped, the rest kept, the order canonical", () => {
    const map = readReuse(
      { _reuse: { secondaryCta: { c: 4, o: ["secondaryCtaLabel.ar", "nonsense"] }, primaryCta: { c: "x" } } },
      "hero",
    );
    assert.deepEqual(map, { secondaryCta: { c: 4, o: ["secondaryCtaLabel.ar"] } });
    const written = withReuse({ a: 1 }, { primaryCta: { c: 9 }, cta: { c: 3, o: ["b", "a"] } } as never);
    assert.deepEqual(Object.keys(written[REUSE_KEY] as Values), ["cta", "primaryCta"]);
    assert.deepEqual(withReuse({ a: 1, _reuse: { x: 1 } }, {}), { a: 1 });
  });
});

/* ========================================================================== */
/* Linking, overriding, resetting, detaching                                  */
/* ========================================================================== */

describe("15–24 · an instance inherits, overrides sparsely, and detaches to what it shows", () => {
  const global = cta(12, "Contact us", "اتصل بنا", "/contact");

  test("15 · linking stores the id and a fallback copy; the section then draws the component", () => {
    const linked = linkSlot("final-cta", finalCta(), "primaryCta", {
      id: 12,
      kind: "cta",
      values: global.values!,
    })!;
    assert.deepEqual(readReuse(linked, "final-cta"), { primaryCta: { c: 12 } });
    assert.deepEqual(linked.primaryCtaLabel, { en: "Contact us", ar: "اتصل بنا" });
    assert.equal(linked.primaryCtaHref, "/contact");
    // Nothing else of the section changes.
    assert.deepEqual(linked.title, finalCta().title);
    const drawn = resolveReuse("final-cta", linked, lookup(global));
    assert.equal(REUSE_KEY in drawn.values, false);
    assert.equal(drawn.instances[0]!.state, "linked");
    // A kind that does not fit the slot is refused.
    assert.equal(linkSlot("final-cta", finalCta(), "primaryCta", { id: 3, kind: "block:rich-text", values: {} }), null);
  });

  test("17 · an override is sparse — one key of one field — and its value is the section's own field", () => {
    const linked = linkSlot("final-cta", finalCta(), "primaryCta", { id: 12, kind: "cta", values: global.values! })!;
    const overridden = setOverride("final-cta", linked, "primaryCta", "primaryCtaHref", true, "/contact")!;
    assert.deepEqual(readReuse(overridden, "final-cta").primaryCta!.o, ["primaryCtaHref"]);
    const typed = { ...overridden, primaryCtaHref: "/book" };
    const drawn = resolveReuse("final-cta", typed, lookup(global)).values;
    assert.equal(drawn.primaryCtaHref, "/book");
    assert.deepEqual(drawn.primaryCtaLabel, { en: "Contact us", ar: "اتصل بنا" });
  });

  test("18 · resetting an override inherits again, and refreshes the fallback to the component's text", () => {
    const linked = linkSlot("final-cta", finalCta(), "primaryCta", { id: 12, kind: "cta", values: global.values! })!;
    const overridden = { ...setOverride("final-cta", linked, "primaryCta", "primaryCtaHref", true, "/contact")!, primaryCtaHref: "/book" };
    const reset = setOverride("final-cta", overridden, "primaryCta", "primaryCtaHref", false, "/contact")!;
    assert.deepEqual(readReuse(reset, "final-cta").primaryCta, { c: 12 });
    assert.equal(reset.primaryCtaHref, "/contact");
    assert.equal(resolveReuse("final-cta", reset, lookup(cta(12, "Contact us", "اتصل بنا", "/new"))).values.primaryCtaHref, "/new");
  });

  test("19 · an English override leaves the Arabic edition inherited", () => {
    const linked = linkSlot("final-cta", finalCta(), "primaryCta", { id: 12, kind: "cta", values: global.values! })!;
    const en = { ...setOverride("final-cta", linked, "primaryCta", "primaryCtaLabel.en", true, "Contact us")!, primaryCtaLabel: { en: "Talk to Dana", ar: "اتصل بنا" } };
    const drawn = resolveReuse("final-cta", en, lookup(cta(12, "Get in touch", "تواصل معنا", "/contact"))).values;
    assert.deepEqual(drawn.primaryCtaLabel, { en: "Talk to Dana", ar: "تواصل معنا" });
  });

  test("20 · an Arabic override leaves the English edition inherited", () => {
    const linked = linkSlot("final-cta", finalCta(), "primaryCta", { id: 12, kind: "cta", values: global.values! })!;
    const ar = { ...setOverride("final-cta", linked, "primaryCta", "primaryCtaLabel.ar", true, "اتصل بنا")!, primaryCtaLabel: { en: "Contact us", ar: "كلمنا" } };
    const drawn = resolveReuse("final-cta", ar, lookup(cta(12, "Get in touch", "تواصل معنا", "/contact"))).values;
    assert.deepEqual(drawn.primaryCtaLabel, { en: "Get in touch", ar: "كلمنا" });
  });

  test("21–22 · a global change reaches every key not overridden, and no key that is", () => {
    const linked = linkSlot("final-cta", finalCta(), "primaryCta", { id: 12, kind: "cta", values: global.values! })!;
    const overridden = { ...setOverride("final-cta", linked, "primaryCta", "primaryCtaHref", true, "/contact")!, primaryCtaHref: "/book" };
    const v2 = cta(12, "Book a call", "احجز مكالمة", "/call", 2);
    const drawn = resolveReuse("final-cta", overridden, lookup(v2));
    assert.deepEqual(drawn.values.primaryCtaLabel, { en: "Book a call", ar: "احجز مكالمة" });
    assert.equal(drawn.values.primaryCtaHref, "/book");
    assert.equal(drawn.instances[0]!.version, 2);
  });

  test("23 · detaching keeps what the page shows — the component's content with the overrides on top", () => {
    const linked = linkSlot("final-cta", finalCta(), "primaryCta", { id: 12, kind: "cta", values: global.values! })!;
    const overridden = { ...setOverride("final-cta", linked, "primaryCta", "primaryCtaHref", true, "/contact")!, primaryCtaHref: "/book" };
    const v2 = cta(12, "Book a call", "احجز مكالمة", "/call", 2);
    const shown = resolveReuse("final-cta", overridden, lookup(v2)).values;
    const detached = detachSlot("final-cta", overridden, "primaryCta", v2.values)!;
    assert.deepEqual(readReuse(detached, "final-cta"), {});
    assert.deepEqual(detached.primaryCtaLabel, shown.primaryCtaLabel);
    assert.equal(detached.primaryCtaHref, shown.primaryCtaHref);
    assert.deepEqual(stripReuse(detached), { ...shown });
  });

  test("24 · a detached section ignores every later version", () => {
    const linked = linkSlot("final-cta", finalCta(), "primaryCta", { id: 12, kind: "cta", values: global.values! })!;
    const detached = detachSlot("final-cta", linked, "primaryCta", global.values)!;
    const later = resolveReuse("final-cta", detached, lookup(cta(12, "Changed", "تغير", "/changed", 3)));
    assert.deepEqual(later.values.primaryCtaLabel, { en: "Contact us", ar: "اتصل بنا" });
    assert.deepEqual(later.instances, []);
  });

  test("a whole block links every field, keeps the section's own style and motion addresses", () => {
    const panel = { ...emptyValues(getBlock("final-cta")!), title: { en: "Shared panel", ar: "لوحة" }, body: { en: "Body", ar: "" }, primaryCtaLabel: { en: "Go", ar: "" }, primaryCtaHref: "/go", showWhatsapp: false };
    const linked = linkSlot("final-cta", finalCta(), BLOCK_SLOT, { id: 7, kind: "block:final-cta", values: panel })!;
    assert.deepEqual(readReuse(linked, "final-cta"), { block: { c: 7 } });
    const drawn = resolveReuse("final-cta", linked, lookup({ id: 7, kind: "block:final-cta", values: panel, version: 1 })).values;
    assert.deepEqual(stripReuse(drawn), panel);
    // A whole-block link is never laid over a CTA linked on its own: that
    // would drop the CTA's link without anyone asking (Batch 17 review). The
    // CTA is detached first.
    const withCta = linkSlot("final-cta", finalCta(), "primaryCta", { id: 12, kind: "cta", values: global.values! })!;
    assert.equal(linkSlot("final-cta", withCta, BLOCK_SLOT, { id: 7, kind: "block:final-cta", values: panel }), null);
    assert.equal(hasSeparateLinks("final-cta", withCta), true);
    assert.equal(hasSeparateLinks("final-cta", finalCta()), false);
    assert.equal(hasSeparateLinks("final-cta", linked), false, "a whole-block link is not a separate one");
    const detachedCta = detachSlot("final-cta", withCta, "primaryCta", global.values)!;
    assert.deepEqual(readReuse(linkSlot("final-cta", detachedCta, BLOCK_SLOT, { id: 7, kind: "block:final-cta", values: panel }), "final-cta"), { block: { c: 7 } });
    assert.equal(linkSlot("final-cta", linked, "primaryCta", { id: 12, kind: "cta", values: global.values! }), null);
    // Only typed text is overridable; a switch, a picture and rich text are not.
    assert.deepEqual(slotDef("image-text", BLOCK_SLOT)!.overridable, [
      "ctaHref",
      "ctaLabel.ar",
      "ctaLabel.en",
      "eyebrow.ar",
      "eyebrow.en",
      "title.ar",
      "title.en",
    ]);
  });

  test("39 · a component that cannot be drawn fails safe: the kept copy, flagged for the editor", () => {
    const linked = linkSlot("final-cta", finalCta(), "primaryCta", { id: 12, kind: "cta", values: global.values! })!;
    const cases: [string, ComponentSource[]][] = [
      ["missing", []],
      ["kind", [{ id: 12, kind: "block:rich-text", values: {}, version: 1 }]],
      ["unpublished", [{ id: 12, kind: "cta", values: null, version: 0 }]],
    ];
    for (const [reason, sources] of cases) {
      const drawn = resolveReuse("final-cta", linked, lookup(...sources));
      assert.deepEqual(drawn.values.primaryCtaLabel, { en: "Contact us", ar: "اتصل بنا" }, reason);
      assert.equal(drawn.instances[0]!.state, "unavailable");
      assert.equal(drawn.instances[0]!.reason, reason);
      assert.equal(REUSE_KEY in drawn.values, false);
    }
    // A malformed reference never throws and never blanks the section.
    const junk = { ...finalCta(), _reuse: { primaryCta: "nonsense", block: 4 } };
    assert.deepEqual(resolveReuse("final-cta", junk, lookup()).values.primaryCtaLabel, finalCta().primaryCtaLabel);
  });

  test("save as reusable: a slot's own content, mapped onto the kind's fields", () => {
    assert.deepEqual(slotContent("final-cta", finalCta(), "primaryCta"), {
      label: { en: "Local label", ar: "تسمية محلية" },
      href: "/local",
    });
    assert.deepEqual(Object.keys(slotContent("final-cta", finalCta(), BLOCK_SLOT)!).sort(), getBlock("final-cta")!.fields.map((f) => f.name).sort());
    // Linking to the component made from it changes nothing visible.
    const made = validateBlockValues(CTA_DEFINITION, slotContent("final-cta", finalCta(), "primaryCta"));
    const linked = linkSlot("final-cta", finalCta(), "primaryCta", { id: 30, kind: "cta", values: made })!;
    assert.deepEqual(stripReuse(linked), finalCta());
  });
});

/* ========================================================================== */
/* Undo and Redo                                                              */
/* ========================================================================== */

describe("25–29 · link, override, reset and detach are page actions Undo takes back exactly", () => {
  const global = cta(12, "Contact us", "اتصل بنا", "/contact");
  const roundTrip = (before: Values, after: Values) => {
    const changes = diffContent("final-cta", before, after);
    assert.ok(changes.length > 0);
    const undone = applyContent(after, changes, "undo")!;
    assert.deepEqual(undone, before, "Undo restores the previous state exactly");
    const redone = applyContent(undone, changes, "redo")!;
    assert.deepEqual(redone, after, "Redo puts the action back exactly");
    return changes;
  };

  test("25 · Undo of a link restores the local content and removes the reference", () => {
    const before = finalCta();
    const after = linkSlot("final-cta", before, "primaryCta", { id: 12, kind: "cta", values: global.values! })!;
    const changes = roundTrip(before, after);
    // One action, never grouped with typing.
    assert.equal(groupOf({ domain: "content", sectionId: 1, blockType: "final-cta", changes }), null);
  });

  test("26 · Undo of an override puts the previous override state back", () => {
    const before = linkSlot("final-cta", finalCta(), "primaryCta", { id: 12, kind: "cta", values: global.values! })!;
    const after = setOverride("final-cta", before, "primaryCta", "primaryCtaLabel.en", true, "Contact us")!;
    roundTrip(before, after);
  });

  test("27 · Undo of a reset restores the override and its text", () => {
    const linked = linkSlot("final-cta", finalCta(), "primaryCta", { id: 12, kind: "cta", values: global.values! })!;
    const before = { ...setOverride("final-cta", linked, "primaryCta", "primaryCtaLabel.en", true, "Contact us")!, primaryCtaLabel: { en: "Mine", ar: "اتصل بنا" } };
    const after = setOverride("final-cta", before, "primaryCta", "primaryCtaLabel.en", false, "Contact us")!;
    roundTrip(before, after);
  });

  test("28 · Undo of a detach restores the reference and the overrides", () => {
    const linked = linkSlot("final-cta", finalCta(), "primaryCta", { id: 12, kind: "cta", values: global.values! })!;
    const before = { ...setOverride("final-cta", linked, "primaryCta", "primaryCtaHref", true, "/contact")!, primaryCtaHref: "/book" };
    const after = detachSlot("final-cta", before, "primaryCta", cta(12, "Updated", "محدث", "/x", 2).values)!;
    roundTrip(before, after);
  });

  test("29 · typing into an override groups like any typed field — one Undo per word, not per key", () => {
    const linked = linkSlot("final-cta", finalCta(), "primaryCta", { id: 12, kind: "cta", values: global.values! })!;
    const overridden = setOverride("final-cta", linked, "primaryCta", "primaryCtaLabel.en", true, "Contact us")!;
    const typed = { ...overridden, primaryCtaLabel: { en: "Contact us now", ar: "اتصل بنا" } };
    const changes = diffContent("final-cta", overridden, typed);
    assert.equal(changes.length, 1);
    assert.notEqual(groupOf({ domain: "content", sectionId: 1, blockType: "final-cta", changes }), null);
  });
});

/* ========================================================================== */
/* History, compare, snapshots                                                */
/* ========================================================================== */

describe("33–35 · a page version keeps the reference, pinned, and the content visitors saw", () => {
  const snapshotWith = (published: Values): PageSnapshot => ({
    v: 1,
    sections: [
      { sourceSectionId: 5, blockType: "final-cta", visible: true, published, styles: { v: 1, nodes: {} }, animation: "fade-up" },
    ],
  });

  test("33 · capture pins the version shown and writes the words visitors saw into the section", () => {
    const linked = linkSlot("final-cta", finalCta(), "primaryCta", { id: 12, kind: "cta", values: cta(12, "a", "b", "/a").values! })!;
    const pinned = pinReuse("final-cta", linked, lookup(cta(12, "Version three", "الإصدار ٣", "/v3", 3)));
    assert.deepEqual(readReuse(pinned, "final-cta", { pins: true }), { primaryCta: { c: 12, v: 3 } });
    assert.deepEqual(pinned.primaryCtaLabel, { en: "Version three", ar: "الإصدار ٣" });
    // Read back through the snapshot validator, pins survive; the block validator alone would drop them.
    const read = validatePageSnapshot(snapshotWith(pinned));
    assert.deepEqual(readReuse(read.sections[0]!.published, "final-cta", { pins: true }), { primaryCta: { c: 12, v: 3 } });
    // A restore brings back the link, not the pin.
    assert.deepEqual(readReuse(unpinReuse(pinned, "final-cta"), "final-cta", { pins: true }), { primaryCta: { c: 12 } });
    // The historical pane draws the kept words, and carries no reference.
    const composed = composeSnapshot(read);
    assert.deepEqual(composed[0]!.values.primaryCtaLabel, { en: "Version three", ar: "الإصدار ٣" });
    assert.equal(REUSE_KEY in composed[0]!.values, false);
  });

  test("34 · Version Compare reports links, versions, overrides and detaches by name", () => {
    const names = new Map([[12, "Primary Contact CTA"], [13, "Booking CTA"]]);
    const local = finalCta();
    const linked = withReuse(local, { primaryCta: { c: 12, v: 2 } });
    const later = withReuse(local, { primaryCta: { c: 12, v: 3, o: ["primaryCtaHref"] } });
    assert.deepEqual(reuseChanges("final-cta", local, linked, names), [
      { label: "Primary call to action → reusable component", before: "Local content", after: "Linked to “Primary Contact CTA”" },
    ]);
    assert.deepEqual(reuseChanges("final-cta", linked, later, names), [
      { label: "Primary call to action → “Primary Contact CTA” · global change", before: "Version 2", after: "Version 3" },
      { label: "Primary call to action → Link", before: "Inherited", after: "Override added on this page" },
    ]);
    assert.deepEqual(reuseChanges("final-cta", later, linked, names).at(-1), {
      label: "Primary call to action → Link",
      before: "Override on this page",
      after: "Override reset — inherited",
    });
    assert.deepEqual(reuseChanges("final-cta", linked, local, names), [
      { label: "Primary call to action → reusable component", before: "Linked to “Primary Contact CTA”", after: "Detached — local content" },
    ]);
    assert.equal(reuseChanges("final-cta", linked, withReuse(local, { primaryCta: { c: 13 } }), names)[0]!.after, "Linked to “Booking CTA”");
    // A component that has gone is named as gone — never by a bare id.
    assert.match(reuseChanges("final-cta", local, withReuse(local, { primaryCta: { c: 99 } }), names)[0]!.after, /no longer exists/);
    const diff = diffSnapshots(snapshotWith(linked), snapshotWith(later), names);
    assert.equal(diff.counts.reuse, 1);
    assert.equal(diff.sections[0]!.status, "changed");
    assert.equal(hasReuse(snapshotWith(local)), false);
    assert.equal(hasReuse(snapshotWith(linked)), true);
    assert.match(REUSE_DISCLAIMER, /not site globals/);
  });
});

/* ========================================================================== */
/* Usage, warnings, picker                                                    */
/* ========================================================================== */

const instance = (over: Partial<UsageInstance>): UsageInstance => ({
  pageId: 1,
  slug: "home",
  title: "Home",
  pagePublished: true,
  sectionId: 1,
  blockType: "final-cta",
  blockName: "Closing call to action",
  slot: "primaryCta",
  slotLabel: "Primary call to action",
  live: true,
  draft: true,
  hidden: false,
  overrides: 0,
  ...over,
});

describe("11–14, 36 · usage is counted from references, and the warning speaks of visitors", () => {
  test("11–14 · pages and instances, live and draft, the same component twice on one page", () => {
    const summary = summarise(
      [
        instance({ pageId: 1, sectionId: 1 }),
        instance({ pageId: 1, sectionId: 2, slot: "primaryCta" }),
        instance({ pageId: 2, sectionId: 3 }),
        instance({ pageId: 3, sectionId: 4, live: false, draft: true }),
        instance({ pageId: 4, sectionId: 5, live: false, draft: false, hidden: true }),
      ],
      true,
    );
    assert.equal(summary.pages, 3);
    assert.equal(summary.instances, 4);
    assert.equal(summary.livePages, 2);
    assert.equal(summary.liveInstances, 3);
    assert.equal(summary.draftOnlyPages, 1);
    assert.equal(summary.hidden, 1);
    assert.equal(usageHeadline(summary), "Used on 3 pages · 4 instances");
    assert.equal(usageHeadline({ pages: 2, instances: 2 }), "Used on 2 pages");
    assert.equal(usageHeadline(EMPTY_USAGE), "Not used on any page yet");
  });

  test("36 · the dependency warning names the visitor impact", () => {
    const summary = summarise(
      [instance({ pageId: 1, sectionId: 1 }), instance({ pageId: 2, sectionId: 2 }), instance({ pageId: 3, sectionId: 3, live: false })],
      true,
    );
    assert.equal(impactSentence(summary), "This will update 2 linked instances across 2 published pages and 1 page draft.");
    assert.match(impactSentence(EMPTY_USAGE), /changes nothing visitors see/);
  });

  test("40 · the picker leaves out archived components and will not link an unpublished one", () => {
    const entry = (over: Partial<ReuseCatalogEntry>): ReuseCatalogEntry => ({
      id: 1,
      kind: "cta",
      name: "Primary Contact CTA",
      status: "active",
      revision: 1,
      publishedVersion: 1,
      published: { label: { en: "x", ar: "" }, href: "/x" },
      hasDraft: false,
      updatedAt: "2026-09-27T00:00:00.000Z",
      usage: EMPTY_USAGE,
      ...over,
    });
    const catalog = [
      entry({ id: 1 }),
      entry({ id: 2, name: "Archived CTA", status: "archived" }),
      entry({ id: 3, name: "Draft CTA", published: null, publishedVersion: 0 }),
      entry({ id: 4, name: "Closing panel", kind: "block:final-cta" }),
    ];
    const listed = pickerEntries(catalog, ["cta"]);
    assert.deepEqual(listed.map((row) => [row.entry.id, row.linkable]), [
      [1, true],
      [3, false],
    ]);
    assert.deepEqual(pickerEntries(catalog, ["cta"], "primary").map((row) => row.entry.id), [1]);
    assert.deepEqual(pickerEntries(catalog, ["cta", "block:final-cta"], "", "block:final-cta").map((row) => row.entry.id), [4]);
  });
});

/* ========================================================================== */
/* Direct editing, Layers, the editor's wiring                                */
/* ========================================================================== */

describe("43–45 · the canvas never types into a component, and Layers says what is linked", () => {
  const linked = withReuse(finalCta(), { primaryCta: { c: 12, o: ["primaryCtaLabel.ar"] } });

  test("43 · linked text with no override in this edition is refused, with the slot and the key", () => {
    assert.deepEqual(directEditDecision("final-cta", linked, "field:primaryCtaLabel", "en"), {
      ok: false,
      slot: "primaryCta",
      key: "primaryCtaLabel.en",
    });
    // Fields no component supplies edit as they always have.
    assert.deepEqual(directEditDecision("final-cta", linked, "field:title", "en"), { ok: true });
    const whole = withReuse(finalCta(), { block: { c: 7 } });
    assert.deepEqual(directEditDecision("final-cta", whole, "field:title", "ar"), { ok: false, slot: "block", key: "title.ar" });
  });

  test("44 · an overridden edition is the page's own, and edits like any other field", () => {
    assert.deepEqual(directEditDecision("final-cta", linked, "field:primaryCtaLabel", "ar"), { ok: true });
  });

  test("the shell asks that decision before any edit session begins, and says why when it refuses", () => {
    const shell = source("src/components/admin/visual-editor/shell.tsx");
    const gate = shell.indexOf("directEditDecision(buffer.data.blockType");
    const begin = shell.indexOf('setEditRequest({ kind: "begin"');
    assert.ok(gate > 0 && begin > gate, "the decision comes before the session begins");
    assert.match(shell.slice(gate, begin), /setReuseNotice\(/);
    const panel = source("src/components/admin/visual-editor/reuse-panel.tsx");
    assert.match(panel, /This text comes from reusable component “\{name\}”\. Edit the global component, or create an override/);
  });

  test("45 · Layers badges a linked section and its linked fields, on the rows that already exist", () => {
    const layers = source("src/components/admin/visual-editor/layers.tsx");
    assert.match(layers, /data-layer-reusable=\{section\.sectionId\}/);
    assert.match(layers, /data-layer-reusable-field=\{node\.address\}/);
    assert.match(layers, /<Badge tone="reuse">Reusable<\/Badge>/);
  });

  test("global edits are never page Undo; link, override, reset and detach are, by name", () => {
    const shell = source("src/components/admin/visual-editor/shell.tsx");
    assert.match(shell, /`Detach \$\{label\} from “/);
    const panel = source("src/components/admin/visual-editor/reuse-panel.tsx");
    assert.match(panel, /`Link \$\{slot\.label\.toLowerCase\(\)\} to “\$\{entry\.name\}”`/);
    assert.match(panel, /`Override \$\{what\} on this page`/);
    assert.match(panel, /`Reset override of \$\{what\}`/);
    const editor = source("src/components/admin/reuse/reuse-editor.tsx");
    assert.doesNotMatch(editor, /recordChange|writeHistory|diffContent/);
  });
});

describe("28–29 · making something reusable publishes nothing by default, and never bakes in a stale CTA", () => {
  const panel = source("src/components/admin/visual-editor/reuse-panel.tsx");
  const saveAs = panel.slice(panel.indexOf("function SaveAsForm("));

  test("Save as reusable starts on “Create a draft only”; publishing is a deliberate second choice", () => {
    assert.match(saveAs, /const \[publish, setPublish\] = useState\(false\);/);
    const draft = saveAs.indexOf("Create a draft only");
    const publish = saveAs.indexOf("Create, publish and link");
    assert.ok(draft > 0 && publish > draft, "the draft option is the first, and the one selected");
    assert.match(saveAs, /checked=\{!publish\}[\s\S]*?data-reuse-save-mode="draft"/);
    assert.match(saveAs, /checked=\{publish\}[\s\S]*?data-reuse-save-mode="publish"/);
    // The button names what it will do, so publishing is never accepted unread.
    assert.match(saveAs, /\{publish \? "Create, publish and link" : `Create \$\{noun\} draft`\}/);
  });

  test("the whole section is refused while a CTA in it is linked on its own — in the panel and on both server paths", () => {
    assert.equal(WHOLE_BLOCK_REFUSAL, "Detach the reusable CTA links in this section before making the whole section reusable.");
    assert.match(panel, /blocked=\{slot\.slot === BLOCK_SLOT && hasSeparateLinks\(blockType, values\) \? WHOLE_BLOCK_REFUSAL : null\}/);
    const create = source("src/app/(backoffice)/admin/(shell)/components/actions.ts");
    assert.match(create, /if \(slotName === BLOCK_SLOT && hasSeparateLinks\(row\.blockType, stored\)\) \{\s*return \{ ok: false, reason: "invalid", message: WHOLE_BLOCK_REFUSAL \};/);
    const save = source("src/app/(backoffice)/admin/visual-editor/actions.ts");
    assert.match(save, /if \(reuse\.map\[BLOCK_SLOT\] && hasSeparateLinks\(found\.block\.type, found\.row\.draft \?\? found\.row\.published\)\) \{\s*return \{ ok: false, reason: "invalid", message: WHOLE_BLOCK_REFUSAL \};/);
  });
});

describe("59 · the usage read after a layout action never costs the layout its state", () => {
  test("the editor writes its address only when the address changes", () => {
    const shell = source("src/components/admin/visual-editor/shell.tsx");
    const write = shell.indexOf('window.history.replaceState(null, "", `?${params}`)');
    assert.ok(write > 0, "the editor no longer writes its address");
    const effect = shell.slice(shell.lastIndexOf("useEffect(() => {", write), write);
    // Next.js turns every replaceState into a router action that preempts the
    // server action in flight — the catalogue read a layout action has just
    // started — and forces a refresh that can lose the layout's own reload. A
    // save hands the effect a new page object with the same slug, so an
    // unconditional write would do that after every layout action.
    assert.match(effect, /if \(window\.location\.search === `\?\$\{params\}`\) return;/);
  });
});

/* ========================================================================== */
/* Authority and the edges of the system                                      */
/* ========================================================================== */

describe("41–42, 50, 52–58 · authority, isolation and invalidation, as the code states them", () => {
  test("the temporary authority is content.view to read and content.manage to change — never settings.manage", () => {
    assert.deepEqual(REUSE_AUTHORITY, {
      view: "content.view",
      instances: "content.manage",
      edit: "content.manage",
      publish: "content.manage",
      restore: "content.manage",
      lifecycle: "content.manage",
    });
    const actions = source("src/app/(backoffice)/admin/(shell)/components/actions.ts");
    assert.doesNotMatch(actions, /settings\.manage/);
    // Every mutation goes through guardAction with a named operation.
    const exported = [...actions.matchAll(/export async function (\w+)\(form: FormData\)/g)].map((m) => m[1]);
    assert.ok(exported.length >= 9, exported.join(","));
    assert.equal((actions.match(/guardAction\(REUSE_AUTHORITY\.\w+, form\)/g) ?? []).length, exported.length);
  });

  test("55 · publishing a component drops the pages cache; a draft save does not", () => {
    const actions = source("src/app/(backoffice)/admin/(shell)/components/actions.ts");
    const publish = actions.slice(actions.indexOf("export async function publishReusable"), actions.indexOf("export async function restoreReusableVersion"));
    assert.match(publish, /revalidate\(TAGS\.pages\)/);
    const save = actions.slice(actions.indexOf("export async function saveReusableDraft"), actions.indexOf("export async function discardReusableDraft"));
    assert.doesNotMatch(save, /revalidate\(TAGS/);
  });

  test("50 · a renderer never receives a reference, and editor marks exist only in editor mode", () => {
    const content = source("src/lib/queries/content.ts");
    assert.match(content, /resolveSections\(db, composed, \{ views: preview, draftOf: options\.draftOf \}\)/);
    const render = source("src/lib/visual-editor/render.ts");
    assert.match(render, /"data-eod-reuse"\?: string/);
    const renderer = source("src/components/site/section-renderer.tsx");
    assert.match(renderer, /const reuse = editorMode && section\.reuse\?\.length \? reuseMarksOf/);
  });

  test("56 · the component service never writes a page, a section or a page version", () => {
    const service = source("src/lib/cms/reuse/service.ts");
    assert.doesNotMatch(service, /pageSections|pageVersions|\bpages\b.*from "@\/lib\/db\/schema"/);
    assert.doesNotMatch(service, /updatePageGuarded|updateSectionGuarded|recordRestorePointIn/);
  });

  test("the reference key is the one reserved name besides _id, and it is kept out of every public value", () => {
    assert.equal(REUSE_KEY, "_reuse");
    const resolved = resolveReuse("final-cta", withReuse(finalCta(), { primaryCta: { c: 12 } }), lookup(cta(12, "a", "b", "/c")));
    assert.equal(JSON.stringify(resolved.values).includes("_reuse"), false);
    assert.deepEqual(effectiveSlotValues(slotDef("final-cta", "primaryCta")!, finalCta(), null), {
      primaryCtaLabel: finalCta().primaryCtaLabel,
      primaryCtaHref: "/local",
    });
  });
});
