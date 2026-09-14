/**
 * The Visual Editor's data foundation, decided without a database.
 *
 * Every rule in here is one the editor will be built on top of: what names a
 * node, what a stored style may contain, what a restore is allowed to touch,
 * and what a row's identity is. None of them need a server to check, and all of
 * them are cheaper to get wrong later than to pin down now.
 *
 * The last group is different in kind: it asserts a known defect rather than a
 * behaviour, so that fixing it has to be a decision somebody makes on purpose.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import {
  ROOT_PATH_TOKEN,
  addressEquals,
  composeAddress,
  decomposeAddress,
  formatAddress,
  formatNodePath,
  isNodePath,
  itemIdOf,
  normalizeNodePath,
  parseAddress,
  parseNodePath,
} from "@/lib/cms/address";
import { backfillItemIds, repeatableFields, withoutItemIds } from "@/lib/cms/backfill";
import { getBlock } from "@/lib/cms/blocks";
import {
  ITEM_ID_ALPHABET,
  ITEM_ID_KEY,
  ITEM_ID_PATTERN,
  ensureItemIds,
  hasStableItemIds,
  isItemId,
  newItemId,
} from "@/lib/cms/item-id";
import { planRestoreFrom, revalidateSnapshot } from "@/lib/cms/restore";
import {
  PAGE_SNAPSHOT_VERSION,
  snapshotFromSections,
  validatePageSnapshot,
  type PageSnapshot,
} from "@/lib/cms/snapshot";
import {
  DRAFT_STRUCTURE_VERSION,
  normalizeDraftStructureForPage,
  pendingRemovals,
  validateDraftStructure,
} from "@/lib/cms/structure";
import {
  STYLE_DOCUMENT_VERSION,
  STYLE_TOKEN_KEYS,
  resolveTokens,
  validateStyleDocument,
  validateTokens,
} from "@/lib/cms/styles";
import { validateBlockValues } from "@/lib/cms/validate";
import { items } from "@/lib/cms/values";

import { REPO_ROOT } from "./helpers/env";

const QUICK_LINKS = getBlock("quick-links")!;
const ID_A = "i_aaaaaaaaaa";
const ID_B = "i_bbbbbbbbbb";

const link = (label: string, extra: Record<string, unknown> = {}) => ({
  label: { en: label, ar: label },
  href: "/services",
  ...extra,
});

/* -------------------------------------------------------------------------- */

describe("a row keeps its identity when the list around it changes", () => {
  test("a generated id is one of ours, and unlike every other one", () => {
    const made = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      const id = newItemId();
      assert.match(id, ITEM_ID_PATTERN);
      assert.ok(isItemId(id));
      assert.ok(!made.has(id), `${id} came back twice`);
      made.add(id);
    }
    // The characters that get misread out loud or in a bug report are not used.
    for (const id of made) assert.ok(!/[0O1lI]/.test(id.slice(2)), id);
  });

  test("missing ids are filled in and existing ones are left alone", () => {
    const rows = [{ n: 1 }, { n: 2, [ITEM_ID_KEY]: ID_A }, { n: 3 }];
    const out = ensureItemIds(rows);

    assert.deepEqual(
      out.map((row) => row.n),
      [1, 2, 3],
      "order moved",
    );
    assert.equal(out[1]![ITEM_ID_KEY], ID_A, "an existing id was replaced");
    assert.ok(isItemId(out[0]![ITEM_ID_KEY]));
    assert.ok(isItemId(out[2]![ITEM_ID_KEY]));
    assert.ok(hasStableItemIds(out));
  });

  test("running it again changes nothing — which is what makes the backfill safe", () => {
    const once = ensureItemIds([{ n: 1 }, { n: 2 }, { n: 3 }]);
    assert.deepEqual(ensureItemIds(once), once);
  });

  test("a malformed or repeated id is reassigned rather than trusted", () => {
    const out = ensureItemIds([
      { n: 1, [ITEM_ID_KEY]: ID_A },
      { n: 2, [ITEM_ID_KEY]: ID_A },
      { n: 3, [ITEM_ID_KEY]: "not-an-id" },
      { n: 4, [ITEM_ID_KEY]: 7 },
    ]);
    assert.equal(out[0]![ITEM_ID_KEY], ID_A, "the first claim should win");
    assert.notEqual(out[1]![ITEM_ID_KEY], ID_A, "two rows answering to one address");
    for (const row of out) assert.ok(isItemId(row[ITEM_ID_KEY]));
    assert.ok(hasStableItemIds(out));
    assert.deepEqual(out.map((row) => row.n), [1, 2, 3, 4]);
  });

  test("the alphabet holds none of the pairs that get misread", () => {
    for (const character of "0O1lI") {
      assert.ok(!ITEM_ID_ALPHABET.includes(character), `${character} is in the alphabet`);
    }
    assert.match(ITEM_ID_ALPHABET, /^[0-9A-Za-z]+$/, "the alphabet must be safe inside a character class");
    assert.equal(new Set(ITEM_ID_ALPHABET).size, ITEM_ID_ALPHABET.length, "a repeated character skews the draw");
  });

  test("an id holding a character the generator cannot produce is not one of ours", () => {
    // The pattern is built from the alphabet, so this cannot drift from the
    // generator. Before it was, `i_8Gk3pZ1mQ2` — with a `1` in it — was accepted
    // as ours, which meant trusting an id that came from somewhere else.
    for (const forged of [
      "i_0aaaaaaaaa",
      "i_Oaaaaaaaaa",
      "i_1aaaaaaaaa",
      "i_laaaaaaaaa",
      "i_Iaaaaaaaaa",
      "i_aaaa-aaaaa",
      "i_aaaa.aaaaa",
      "i_aaaa aaaaa",
      "i_aaaaaaa",
      "i_aaaaaaaaaaaaaaaaa",
      "i_",
      "aaaaaaaaaa",
      "I_aaaaaaaaaa",
    ]) {
      assert.ok(!isItemId(forged), `${forged} was accepted`);
      assert.ok(!ITEM_ID_PATTERN.test(forged));
    }
  });

  test("a forged id is replaced, not merely refused, and the row keeps its values", () => {
    const rows = ensureItemIds([{ n: 1, [ITEM_ID_KEY]: "i_0OlI1aaaa" }, { n: 2, [ITEM_ID_KEY]: ID_A }]);
    assert.ok(isItemId(rows[0]![ITEM_ID_KEY]));
    assert.notEqual(rows[0]![ITEM_ID_KEY], "i_0OlI1aaaa");
    assert.equal(rows[0]!.n, 1);
    assert.equal(rows[1]![ITEM_ID_KEY], ID_A, "a valid id was disturbed");
  });

  test("ids this repository has already generated stay valid", () => {
    // Ten characters from the safe alphabet, which is what `newItemId` writes.
    for (const stored of [ID_A, ID_B, "i_kkkkkkkkkk", "i_8Gk3pZmQ2v", "i_zZ9wQ2mvkG"]) {
      assert.ok(isItemId(stored), `${stored} stopped being valid`);
    }
    assert.equal(ensureItemIds([{ [ITEM_ID_KEY]: ID_A }])[0]![ITEM_ID_KEY], ID_A);
  });

  test("hasStableItemIds is what decides whether there is anything to write", () => {
    assert.ok(hasStableItemIds([]));
    assert.ok(!hasStableItemIds([{}]));
    assert.ok(!hasStableItemIds([{ [ITEM_ID_KEY]: ID_A }, { [ITEM_ID_KEY]: ID_A }]));
    assert.ok(hasStableItemIds([{ [ITEM_ID_KEY]: ID_A }, { [ITEM_ID_KEY]: ID_B }]));
  });

  test("saving a section stamps its rows, and still drops everything undeclared", () => {
    const stored = validateBlockValues(QUICK_LINKS, {
      links: [link("Visas", { evil: "<script>alert(1)</script>", onclick: "x", style: "color:red" })],
    }) as { links: Record<string, unknown>[] };

    const row = stored.links[0]!;
    assert.ok(isItemId(row[ITEM_ID_KEY]), "the row was not given an id");
    assert.deepEqual(row.label, { en: "Visas", ar: "Visas" });
    for (const key of ["evil", "onclick", "style"]) {
      assert.ok(!(key in row), `${key} survived the validator`);
    }
    // `_id` is the one exception, and it is an exception of exactly one key.
    const declared = new Set(QUICK_LINKS.fields.find((f) => f.name === "links")!.itemFields!.map((f) => f.name));
    for (const key of Object.keys(row)) {
      assert.ok(key === ITEM_ID_KEY || declared.has(key), `unexpected key ${key}`);
    }
  });

  test("an id the panel sends back survives the round trip; a forged one does not", () => {
    const kept = validateBlockValues(QUICK_LINKS, {
      links: [link("A", { [ITEM_ID_KEY]: ID_A })],
    }) as { links: Record<string, unknown>[] };
    assert.equal(kept.links[0]![ITEM_ID_KEY], ID_A);

    const forged = validateBlockValues(QUICK_LINKS, {
      links: [link("A", { [ITEM_ID_KEY]: "i_../../etc/passwd" })],
    }) as { links: Record<string, unknown>[] };
    assert.ok(isItemId(forged.links[0]![ITEM_ID_KEY]));
    assert.notEqual(forged.links[0]![ITEM_ID_KEY], "i_../../etc/passwd");
  });

  test("reordering a list moves the ids with the rows, which is the whole point", () => {
    const saved = validateBlockValues(QUICK_LINKS, {
      links: [link("A"), link("B"), link("C")],
    }) as { links: Record<string, unknown>[] };
    const ids = saved.links.map((row) => row[ITEM_ID_KEY]);

    const moved = validateBlockValues(QUICK_LINKS, {
      links: [saved.links[2], saved.links[0], saved.links[1]],
    }) as { links: Record<string, unknown>[] };

    assert.deepEqual(moved.links.map((row) => row[ITEM_ID_KEY]), [ids[2], ids[0], ids[1]]);
  });
});

/* -------------------------------------------------------------------------- */

describe("an address names a node, and can never be a selector", () => {
  test("the shapes a relative path may take", () => {
    for (const good of [
      ROOT_PATH_TOKEN,
      "field:headline",
      "slot:media",
      "field:links/item:i_8Gk3pZmQ2v",
      "field:links/item:i_8Gk3pZmQ2v/field:label",
      "field:links/item:i_8Gk3pZmQ2v/slot:icon",
    ]) {
      assert.ok(isNodePath(good), `${good} should parse`);
      assert.equal(normalizeNodePath(good), good, `${good} did not round trip`);
    }
    assert.deepEqual(parseNodePath(ROOT_PATH_TOKEN), []);
    assert.equal(formatNodePath([]), ROOT_PATH_TOKEN);
  });

  test("a persisted path never carries the section — that is the correction this batch is built on", () => {
    // `duplicateSection` inserts a new id and a restore may recreate a deleted
    // section under another one, so a stored key naming a section is a key that
    // points at the wrong row the first time anything is copied.
    assert.equal(parseNodePath("section:42/field:headline"), null);
    assert.equal(parseNodePath("section:42"), null);
    // Runtime addresses are the other vocabulary, and they do carry it.
    assert.deepEqual(parseAddress("section:42/field:headline"), {
      sectionId: 42,
      path: [{ kind: "field", name: "headline" }],
    });
  });

  test("locale is not part of a node's identity", () => {
    assert.equal(parseNodePath("field:headline@ar"), null);
    assert.equal(parseNodePath("field:headline@en"), null);
    assert.equal(parseAddress("section:42/field:headline@ar"), null);
  });

  test("nothing that looks like a selector, a traversal or an index parses", () => {
    for (const bad of [
      "",
      "   ",
      "/field:headline",
      "field:headline/",
      "field:headline//field:sub",
      "field:links[0]",
      "field:links.0",
      "div > p",
      ".card:nth-child(2)",
      "//*[@id='x']",
      "field:../secret",
      "style:color",
      "css:body{}",
      "headline",
      "field:",
      ":headline",
      "field:1headline",
      "field:head:line",
      "item:i_8Gk3pZmQ2v",
      "field:a/item:i_8Gk3pZmQ2v/item:i_8Gk3pZmQ2w",
      "field:a/item:nope",
      "slot:media/field:label",
      "field:a/field:b/field:c/field:d/field:e/field:f/field:g",
      42,
      null,
      undefined,
      {},
      ["field:headline"],
    ]) {
      assert.equal(parseNodePath(bad), null, `${JSON.stringify(bad)} should not parse`);
      assert.equal(normalizeNodePath(bad), null);
    }
  });

  test("a runtime address composes and decomposes without losing anything", () => {
    assert.equal(composeAddress(42, "field:links/item:i_8Gk3pZmQ2v/field:label"),
      "section:42/field:links/item:i_8Gk3pZmQ2v/field:label");
    assert.equal(composeAddress(42, ROOT_PATH_TOKEN), "section:42");
    assert.equal(formatAddress(7), "section:7");

    assert.deepEqual(decomposeAddress("section:42/field:headline"), {
      sectionId: 42,
      relative: "field:headline",
    });
    // A section-level address decomposes to the root token, not to nothing.
    assert.deepEqual(decomposeAddress("section:42"), { sectionId: 42, relative: ROOT_PATH_TOKEN });
  });

  test("an address without a usable section id is refused", () => {
    for (const bad of ["section:0/field:a", "section:-1", "section:01", "section:x", "42/field:a", "section:"]) {
      assert.equal(parseAddress(bad), null, `${bad} should not parse`);
    }
    assert.equal(composeAddress(0, "field:a"), null);
    assert.equal(composeAddress(-3, "field:a"), null);
    assert.equal(composeAddress(1.5, "field:a"), null);
    assert.equal(composeAddress(1, "div > p"), null);
  });

  test("two spellings of one address are one address; two addresses are not", () => {
    assert.ok(addressEquals("section:42/field:a", " section:42/field:a "));
    assert.ok(!addressEquals("section:42/field:a", "section:43/field:a"));
    assert.ok(!addressEquals("section:42/field:a", "section:42/field:b"));
    assert.ok(!addressEquals("nonsense", "nonsense"));
  });

  test("the row a path sits in is readable from the path", () => {
    assert.equal(itemIdOf(parseNodePath("field:links/item:i_8Gk3pZmQ2v/field:label")!), "i_8Gk3pZmQ2v");
    assert.equal(itemIdOf(parseNodePath("field:headline")!), null);
    assert.equal(itemIdOf([]), null);
  });
});

/* -------------------------------------------------------------------------- */

describe("a stored style is a token, never CSS", () => {
  test("the vocabulary holds no escape hatch", () => {
    for (const forbidden of ["css", "class", "className", "style", "selector", "html", "js", "var", "content"]) {
      assert.ok(!STYLE_TOKEN_KEYS.includes(forbidden as never), `${forbidden} is in the vocabulary`);
    }
  });

  test("the vocabulary is logical, so a choice made in English cannot flip in Arabic", () => {
    for (const key of STYLE_TOKEN_KEYS) {
      assert.ok(!/left|right|ltr|rtl/i.test(key), `${key} is a physical direction`);
    }
  });

  test("motion is not in it — that belongs to a different batch and a different column", () => {
    for (const key of ["animation", "transition", "duration", "delay", "easing", "reveal"]) {
      assert.ok(!STYLE_TOKEN_KEYS.includes(key as never), `${key} is in the style vocabulary`);
    }
  });

  test("a token outside the enumeration or the range never survives", () => {
    assert.deepEqual(
      validateTokens({
        align: "center",
        fontSize: "h2",
        fontWeight: 600,
        padBlock: 4,
        opacity: 0.5,
        objectX: 30,
        hidden: true,
      }),
      { align: "center", fontSize: "h2", fontWeight: 600, padBlock: 4, opacity: 0.5, objectX: 30, hidden: true },
    );

    assert.deepEqual(
      validateTokens({
        align: "justify",
        fontSize: "24px",
        fontWeight: 650,
        textColor: "#ff0000",
        background: "url(https://example.invalid/x.png)",
        padBlock: 13,
        padInline: -1,
        gap: 1.5,
        gap2: 3,
        opacity: 0,
        objectX: 101,
        hidden: "yes",
        css: "body{display:none}",
      }),
      {},
    );
  });

  test("numbers are snapped and rounded rather than stored as typed", () => {
    assert.deepEqual(validateTokens({ opacity: 0.53 }), { opacity: 0.55 });
    assert.deepEqual(validateTokens({ objectY: 33.4 }), { objectY: 33 });
  });

  test("a document is rebuilt: unknown paths, unknown keys and empty levels all go", () => {
    const doc = validateStyleDocument({
      v: 1,
      nodes: {
        root: { base: { align: "center" }, tablet: { align: "nope" }, print: { align: "end" } },
        "field:headline": { mobile: { fontSize: "h3" } },
        "div > p": { base: { align: "end" } },
        "section:42/field:a": { base: { align: "end" } },
        "field:headline@ar": { base: { align: "end" } },
        "field:empty": { base: { css: "x" } },
      },
    });

    assert.deepEqual(doc, {
      v: STYLE_DOCUMENT_VERSION,
      nodes: {
        root: { base: { align: "center" } },
        "field:headline": { mobile: { fontSize: "h3" } },
      },
    });
  });

  test("a missing, malformed or future version reads as no styles at all", () => {
    const empty = { v: STYLE_DOCUMENT_VERSION, nodes: {} };
    for (const input of [null, undefined, "", 5, [], {}, { nodes: { root: { base: { align: "end" } } } },
      { v: 0, nodes: {} }, { v: 1.5, nodes: {} }, { v: STYLE_DOCUMENT_VERSION + 1, nodes: { root: { base: { align: "end" } } } }]) {
      assert.deepEqual(validateStyleDocument(input), empty, JSON.stringify(input));
    }
  });

  test("validating twice gives the same document, so it can sit on both paths", () => {
    const once = validateStyleDocument({ v: 1, nodes: { root: { base: { padBlock: 3 }, mobile: { padBlock: 1 } } } });
    assert.deepEqual(validateStyleDocument(once), once);
  });

  test("breakpoints inherit sparsely: an override is a key, not a copy", () => {
    const node = { base: { align: "center" as const, padBlock: 6 }, mobile: { padBlock: 2 } };
    assert.deepEqual(resolveTokens(node, "base"), { align: "center", padBlock: 6 });
    assert.deepEqual(resolveTokens(node, "tablet"), { align: "center", padBlock: 6 });
    assert.deepEqual(resolveTokens(node, "mobile"), { align: "center", padBlock: 2 });
    assert.deepEqual(resolveTokens(undefined, "mobile"), {});
  });
});

/* -------------------------------------------------------------------------- */

describe("a draft structure is an order, checked against the page that owns it", () => {
  test("entries are rebuilt, repeats keep their first place, and a typo is not a deletion", () => {
    assert.deepEqual(
      validateDraftStructure({
        v: 1,
        sections: [
          { sectionId: 3, visible: false, extra: "ignored" },
          { sectionId: 3, visible: true },
          { sectionId: 1 },
          { sectionId: 2, visible: "no" },
          { sectionId: 0 },
          { sectionId: -4 },
          { sectionId: "5" },
          null,
        ],
      }),
      {
        v: DRAFT_STRUCTURE_VERSION,
        sections: [
          { sectionId: 3, visible: false },
          { sectionId: 1, visible: true },
          { sectionId: 2, visible: true },
        ],
      },
    );
  });

  test("a missing or future version reads as no structure", () => {
    const empty = { v: DRAFT_STRUCTURE_VERSION, sections: [] };
    for (const input of [null, {}, { sections: [{ sectionId: 1 }] }, { v: DRAFT_STRUCTURE_VERSION + 1, sections: [{ sectionId: 1 }] }]) {
      assert.deepEqual(validateDraftStructure(input), empty);
    }
  });

  test("a section belonging to another page is dropped, and one the document forgot is appended", () => {
    const structure = normalizeDraftStructureForPage(
      { v: 1, sections: [{ sectionId: 9, visible: true }, { sectionId: 2, visible: false }] },
      [1, 2, 3],
    );
    assert.deepEqual(structure.sections, [
      { sectionId: 2, visible: false },
      { sectionId: 1, visible: true },
      { sectionId: 3, visible: true },
    ]);
  });

  test("an omission only means removal when the caller says it does", () => {
    const structure = normalizeDraftStructureForPage(
      { v: 1, sections: [{ sectionId: 2, visible: true }] },
      [1, 2, 3],
      { keepOmitted: false },
    );
    assert.deepEqual(structure.sections, [{ sectionId: 2, visible: true }]);
    assert.deepEqual(pendingRemovals(structure, [1, 2, 3]), [1, 3]);
  });
});

/* -------------------------------------------------------------------------- */

describe("a version snapshot is of what was published, and of nothing global", () => {
  const rows = [
    { id: 5, blockType: "hero", isPublished: true, published: { headline: { en: "A", ar: "أ" } }, styles: { v: 1, nodes: { root: { base: { align: "center" as const } } } }, animation: "fade-up" },
    { id: 6, blockType: "faq", isPublished: false, published: null, styles: null, animation: "" },
  ];

  test("rows become entries, in order, with the styles revalidated", () => {
    assert.deepEqual(snapshotFromSections(rows), {
      v: PAGE_SNAPSHOT_VERSION,
      sections: [
        {
          sourceSectionId: 5,
          blockType: "hero",
          visible: true,
          published: { headline: { en: "A", ar: "أ" } },
          styles: { v: 1, nodes: { root: { base: { align: "center" } } } },
          animation: "fade-up",
        },
        {
          sourceSectionId: 6,
          blockType: "faq",
          visible: false,
          published: {},
          styles: { v: 1, nodes: {} },
          animation: "fade-up",
        },
      ],
    });
  });

  test("an entry carries six things and no seventh", () => {
    // The boundary, asserted rather than described: no page title, no page
    // settings, no site settings, no navigation, no draft. None of those has a
    // draft form, so restoring one could not be previewed — it would be live on
    // click.
    for (const section of snapshotFromSections(rows).sections) {
      assert.deepEqual(Object.keys(section).sort(), [
        "animation",
        "blockType",
        "published",
        "sourceSectionId",
        "styles",
        "visible",
      ]);
    }
  });

  test("reading one back drops what cannot be rendered and keeps the order", () => {
    const snapshot = validatePageSnapshot({
      v: 1,
      sections: [
        { blockType: "hero", sourceSectionId: 5, published: { a: 1 } },
        { sourceSectionId: 6, published: { b: 2 } },
        { blockType: "faq", sourceSectionId: "x", visible: false, styles: { v: 1, nodes: { "div > p": { base: { align: "end" } } } } },
      ],
    });

    assert.deepEqual(snapshot.sections.map((s) => s.blockType), ["hero", "faq"]);
    assert.equal(snapshot.sections[1]!.sourceSectionId, 0, "a bad id should not become a match");
    assert.deepEqual(snapshot.sections[1]!.styles.nodes, {}, "a selector survived a stored document");
  });

  test("a snapshot from a version this build does not understand is empty, not guessed at", () => {
    assert.deepEqual(validatePageSnapshot({ v: PAGE_SNAPSHOT_VERSION + 1, sections: [{ blockType: "hero" }] }).sections, []);
    assert.deepEqual(validatePageSnapshot(null).sections, []);
  });
});

/* -------------------------------------------------------------------------- */

describe("a stored snapshot is not a way round the CMS's own rules", () => {
  /**
   * The reason this group exists. A snapshot is a JSON column; a restore writes
   * it into `draft`; the ordinary publish path can then promote that draft to
   * `published` without going near the block form parser again. So anything a
   * save is not allowed to store, a snapshot must not be allowed to carry
   * either — and the way to guarantee that is to rebuild the content through
   * the same `validateBlockValues` a save goes through, rather than to write a
   * second validator that would drift.
   */
  const read = (blockType: string, published: unknown) =>
    validatePageSnapshot({
      v: PAGE_SNAPSHOT_VERSION,
      sections: [{ sourceSectionId: 5, blockType, visible: true, published }],
    }).sections[0];

  test("a key the block does not declare does not survive being stored", () => {
    const section = read("rich-text", {
      title: { en: "Real", ar: "حقيقي" },
      evil: "whatever",
      __proto__: { polluted: true },
      onclick: "alert(1)",
      dangerouslySetInnerHTML: { __html: "<script>x</script>" },
    })!;

    assert.deepEqual(section.published.title, { en: "Real", ar: "حقيقي" });
    for (const key of ["evil", "onclick", "dangerouslySetInnerHTML", "polluted"]) {
      assert.ok(!(key in section.published), `${key} survived`);
    }
    assert.deepEqual(Object.keys(section.published).sort(), ["body", "eyebrow", "title"]);
  });

  test("rich text comes back through the existing sanitizer", () => {
    const section = read("rich-text", {
      body: {
        en: '<p>Fine</p><script>fetch("//evil.invalid")</script><img src=x onerror=alert(1)>' +
          '<a href="javascript:alert(1)">tap</a><a href="https://example.com">out</a>',
        ar: '<iframe src="https://evil.invalid"></iframe>',
      },
    })!;

    const body = section.published.body as { en: string; ar: string };
    assert.ok(body.en.includes("<p>Fine</p>"), "the legitimate markup should survive");
    for (const bad of ["<script", "onerror", "javascript:", "<img", "<iframe"]) {
      assert.ok(!body.en.includes(bad) && !body.ar.includes(bad), `${bad} survived`);
    }
    // The whitelist keeps the text of a tag it removes, and marks an off-site
    // link safe — exactly what it does on the save path.
    assert.ok(body.en.includes("tap"), "the anchor's text should be kept");
    assert.ok(body.en.includes('rel="noopener noreferrer"'));
  });

  test("an unsafe link does not survive in a link field", () => {
    for (const href of [
      "javascript:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "vbscript:msgbox(1)",
      "//evil.invalid/steal",
      " javascript:alert(1)",
    ]) {
      const section = read("final-cta", { primaryCtaHref: href })!;
      assert.equal(section.published.primaryCtaHref, "", `${href} survived`);
    }
    assert.equal(read("final-cta", { primaryCtaHref: "/contact" })!.published.primaryCtaHref, "/contact");
    assert.equal(
      read("final-cta", { primaryCtaHref: "https://example.com/x" })!.published.primaryCtaHref,
      "https://example.com/x",
    );
  });

  test("a row inside a snapshot is stamped and controlled like any other row", () => {
    const section = read("quick-links", {
      links: [
        { label: { en: "A", ar: "أ" }, href: "javascript:alert(1)", icon: "sparkle", image: 7 },
        { label: { en: "B", ar: "ب" }, href: "/b", icon: "not-an-icon", image: "junk", evil: "x", _id: "i_0OlI1zzzz" },
        { label: { en: "C", ar: "ج" }, href: "/c", _id: ID_A },
      ],
    })!;

    const rows = section.published.links as Record<string, unknown>[];
    assert.equal(rows.length, 3);
    assert.ok(hasStableItemIds(rows), "the rows did not come back with stable ids");
    assert.equal(rows[2]![ITEM_ID_KEY], ID_A, "a valid id was disturbed");
    assert.notEqual(rows[1]![ITEM_ID_KEY], "i_0OlI1zzzz", "a forged id was trusted");

    assert.equal(rows[0]!.href, "", "an unsafe row href survived");
    assert.equal(rows[0]!.icon, "sparkle");
    assert.equal(rows[0]!.image, 7);
    assert.equal(rows[1]!.icon, "", "an invented icon key survived");
    assert.equal(rows[1]!.image, null, "junk became a media id");
    assert.ok(!("evil" in rows[1]!), "an undeclared row key survived");
  });

  test("a block type the registry does not know is dropped, not restored blindly", () => {
    // There is no form that can edit it and no renderer that can draw it, so
    // keeping its arbitrary values would be carrying unvalidatable content for
    // nobody. `applyRestorePlan` already refuses to recreate such a section;
    // dropping it here means the planner never even matches it against a live
    // row, so that row is left exactly as it is.
    const snapshot = validatePageSnapshot({
      v: PAGE_SNAPSHOT_VERSION,
      sections: [
        { sourceSectionId: 5, blockType: "hero", published: { headline: { en: "kept", ar: "" } } },
        { sourceSectionId: 6, blockType: "no-such-block", published: { evil: "<script>x</script>" } },
      ],
    });

    assert.deepEqual(snapshot.sections.map((section) => section.blockType), ["hero"]);

    const plan = planRestoreFrom(1, snapshot, [
      { id: 5, blockType: "hero" },
      { id: 6, blockType: "no-such-block" },
    ]);
    assert.deepEqual(plan.drafts.map((d) => d.sectionId), [5]);
    assert.deepEqual(plan.untouched, [6], "the unknown section should be left alone");
    assert.equal(plan.recreate.length, 0);
  });

  test("a deprecated but still registered type restores normally", () => {
    // The compatibility model the rest of the CMS already uses: a retired type
    // stays in the registry so a stored row can still be opened and rendered.
    assert.ok(getBlock("egypt-feature"), "the deprecated type left the registry");
    const section = read("egypt-feature", { title: { en: "Egypt", ar: "مصر" } })!;
    assert.equal(section.blockType, "egypt-feature");
    assert.deepEqual(section.published.title, { en: "Egypt", ar: "مصر" });
  });

  test("the planner validates whatever it is handed, not only what it read back", () => {
    // `planRestore` is exported and takes a snapshot, so the guarantee cannot
    // depend on every caller having gone through `readPageVersionRecord`.
    const handmade = {
      v: PAGE_SNAPSHOT_VERSION,
      sections: [
        {
          sourceSectionId: 5,
          blockType: "rich-text",
          visible: true,
          published: { body: { en: "<script>x</script>", ar: "" }, evil: "y" },
          styles: { v: 1, nodes: { "div > p": { base: { align: "end" } } } },
          animation: "fade-up",
        },
      ],
    } as unknown as PageSnapshot;

    const plan = planRestoreFrom(1, handmade, [{ id: 5, blockType: "rich-text" }]);
    const draft = plan.drafts[0]!.draft;
    assert.ok(!(draft.body as { en: string }).en.includes("<script"), "unsanitised markup reached a draft");
    assert.ok(!("evil" in draft));
    assert.deepEqual(plan.drafts[0]!.draftStyles, { v: 1, nodes: {} });
  });

  test("validating a snapshot twice gives the same snapshot", () => {
    const once = validatePageSnapshot({
      v: PAGE_SNAPSHOT_VERSION,
      sections: [{ sourceSectionId: 5, blockType: "quick-links", published: { links: [link("A")] } }],
    });
    assert.deepEqual(revalidateSnapshot(once), once);
  });
});

/* -------------------------------------------------------------------------- */

describe("restoring a version writes drafts and only drafts", () => {
  const entry = (sourceSectionId: number, blockType: string, extra: Record<string, unknown> = {}) => ({
    sourceSectionId,
    blockType,
    visible: true,
    published: { headline: { en: blockType, ar: blockType } },
    styles: { v: 1, nodes: {} },
    animation: "fade-up",
    ...extra,
  });

  const snapshot = (sections: ReturnType<typeof entry>[]): PageSnapshot =>
    validatePageSnapshot({ v: PAGE_SNAPSHOT_VERSION, sections });

  /** What the registry makes of an entry's values — the shape a draft arrives in. */
  const validated = (blockType: string, values: Record<string, unknown>) =>
    validateBlockValues(getBlock(blockType)!, values);

  test("a section that is still there gets its history as a draft", () => {
    const plan = planRestoreFrom(1, snapshot([entry(5, "hero")]), [{ id: 5, blockType: "hero" }]);

    assert.equal(plan.recreate.length, 0);
    assert.deepEqual(plan.drafts, [
      {
        sectionId: 5,
        draft: validated("hero", { headline: { en: "hero", ar: "hero" } }),
        draftStyles: { v: 1, nodes: {} },
        draftAnimation: "fade-up",
      },
    ]);
    assert.deepEqual(plan.drafts[0]!.draft.headline, { en: "hero", ar: "hero" }, "the copy did not survive");
    // Nothing published, positioned or visible is anywhere in the plan.
    for (const key of ["published", "position", "isPublished", "styles", "animation"]) {
      assert.ok(!(key in plan.drafts[0]!), `${key} is in a restore draft`);
    }
  });

  test("an id reused by a different kind of section is not a match", () => {
    const plan = planRestoreFrom(1, snapshot([entry(5, "hero")]), [{ id: 5, blockType: "faq" }]);
    assert.equal(plan.drafts.length, 0);
    assert.deepEqual(plan.recreate.map((r) => r.blockType), ["hero"]);
    assert.deepEqual(plan.untouched, [5], "the live FAQ should be left exactly as it is");
  });

  test("a section deleted from the middle comes back in the middle", () => {
    const plan = planRestoreFrom(
      1,
      snapshot([entry(5, "hero"), entry(6, "process"), entry(7, "faq")]),
      [{ id: 5, blockType: "hero" }, { id: 7, blockType: "faq" }],
    );

    assert.deepEqual(plan.order, [
      { kind: "existing", sectionId: 5, visible: true },
      { kind: "recreate", index: 0, visible: true },
      { kind: "existing", sectionId: 7, visible: true },
    ]);
    assert.deepEqual(plan.recreate.map((r) => r.blockType), ["process"]);
  });

  test("a live section the snapshot never mentioned is left alone, not deleted", () => {
    const plan = planRestoreFrom(1, snapshot([entry(5, "hero")]), [
      { id: 5, blockType: "hero" },
      { id: 8, blockType: "stats" },
    ]);
    assert.deepEqual(plan.untouched, [8]);
    assert.ok(!plan.order.some((slot) => slot.kind === "existing" && slot.sectionId === 8));
  });

  test("one live row is claimed once, however many times the snapshot names it", () => {
    const plan = planRestoreFrom(1, snapshot([entry(5, "hero"), entry(5, "hero")]), [
      { id: 5, blockType: "hero" },
    ]);
    assert.equal(plan.drafts.length, 1);
    assert.equal(plan.recreate.length, 1, "the second should become its own row");
    assert.deepEqual(plan.untouched, []);
  });

  test("hidden stays hidden through the restore", () => {
    const plan = planRestoreFrom(1, snapshot([entry(5, "hero", { visible: false }), entry(9, "faq", { visible: false })]), [
      { id: 5, blockType: "hero" },
    ]);
    assert.deepEqual(plan.order.map((slot) => slot.visible), [false, false]);
    assert.equal(plan.recreate[0]!.visible, false);
  });

  test("styles inside a stored snapshot are re-validated on the way out", () => {
    const plan = planRestoreFrom(
      1,
      { v: PAGE_SNAPSHOT_VERSION, sections: [entry(5, "hero", { styles: { v: 1, nodes: { "div > p": { base: { align: "end" } }, root: { base: { align: "end" } } } } })] } as PageSnapshot,
      [{ id: 5, blockType: "hero" }],
    );
    assert.deepEqual(plan.drafts[0]!.draftStyles, { v: 1, nodes: { root: { base: { align: "end" } } } });
  });
});

/* -------------------------------------------------------------------------- */

describe("the backfill adds an id and changes nothing else", () => {
  test("which fields it looks at comes from the registry, never from a list here", () => {
    assert.deepEqual(repeatableFields(QUICK_LINKS), ["links"]);
    assert.deepEqual(repeatableFields(getBlock("page-hero")!), []);
  });

  test("rows are stamped in place, and the document is otherwise identical", () => {
    const before = { title: { en: "T", ar: "ت" }, links: [link("A"), link("B", { [ITEM_ID_KEY]: ID_A })] };
    const after = backfillItemIds("quick-links", before)!;

    assert.ok(after, "nothing was written");
    assert.deepEqual(withoutItemIds(after), withoutItemIds(before), "a value moved");
    assert.equal((after.links as Record<string, unknown>[])[1]![ITEM_ID_KEY], ID_A);
    assert.ok(hasStableItemIds(after.links as Record<string, unknown>[]));
    assert.deepEqual(
      (after.links as Record<string, unknown>[]).map((row) => (row.label as { en: string }).en),
      ["A", "B"],
      "rows were reordered",
    );
    assert.notEqual(after, before, "the input object was mutated");
  });

  test("a section that already has its ids is not written at all", () => {
    const values = { links: [link("A", { [ITEM_ID_KEY]: ID_A }), link("B", { [ITEM_ID_KEY]: ID_B })] };
    assert.equal(backfillItemIds("quick-links", values), null);
    // And the first pass is enough: its own output needs no second one.
    assert.equal(backfillItemIds("quick-links", backfillItemIds("quick-links", { links: [link("A")] })!), null);
  });

  test("it is a backfill, not a repair — anything it does not recognise is left alone", () => {
    assert.equal(backfillItemIds("no-such-block", { links: [link("A")] }), null);
    assert.equal(backfillItemIds("quick-links", null), null);
    assert.equal(backfillItemIds("quick-links", "links"), null);
    assert.equal(backfillItemIds("quick-links", { links: "not an array" }), null);
    assert.equal(backfillItemIds("quick-links", { links: ["a string row"] }), null);
    assert.equal(backfillItemIds("quick-links", { links: [] }), null);
  });

  test("the renderer reads the same content before and after — in both languages", () => {
    // Semantic equivalence at the door the renderer actually uses. `items()` is
    // what every block calls to read a repeatable list, and it is given the
    // stamped document and the unstamped one. If the backfill could change what
    // a page says, this is where it would show.
    const before = { links: [link("A"), link("B", { icon: "sparkle" })] };
    const after = backfillItemIds("quick-links", before)!;
    const fields = QUICK_LINKS.fields.find((f) => f.name === "links")!.itemFields!;

    for (const locale of ["en", "ar"] as const) {
      const was = items(before, "links", locale, fields);
      const now = items(after, "links", locale, fields);
      assert.deepEqual(withoutItemIds(now), was, `${locale} content moved`);
      // The difference is one key per row, and it is that key. `items()` does
      // carry the id through on purpose — the editor has to be able to point at
      // a row it can see — so this is not an accident to be tightened away.
      for (const [index, row] of now.entries()) {
        assert.deepEqual(
          Object.keys(row).filter((key) => !(key in was[index]!)),
          [ITEM_ID_KEY],
        );
        assert.ok(isItemId(row[ITEM_ID_KEY]));
      }
    }
  });

  test("`_id` is the only difference the backfill can make, at any depth", () => {
    const before = { links: [link("A", { nested: { deep: [{ x: 1 }] } })] };
    const after = backfillItemIds("quick-links", before)!;
    assert.deepEqual(withoutItemIds(after), withoutItemIds(before));
    assert.notDeepEqual(after, before);
  });
});

/* -------------------------------------------------------------------------- */

describe("the entrance-animation control is still dead, and deliberately so", () => {
  const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), "utf8");

  test("the renderer never mentions it, so no block can receive it", () => {
    // This asserts a DEFECT, not a behaviour. `page_sections.animation` is
    // stored, edited in the Pages panel and read into `RenderedSection`, and
    // then dropped: every block hard-codes its own `<Reveal variant>`.
    //
    // It is left alone on purpose. `saveSectionDraft` writes `animation`
    // outside the draft document — on the same guarded write that stores the
    // draft, see below — so wiring the value through today would make saving a
    // *draft* change the live page, which is the one thing a draft must not do.
    // Motion is Batch 9's, together with a draft column for it.
    //
    // If this test fails because the renderer now uses the value, that is not a
    // test to update: it is the draft leak, and it needs the draft column first.
    const renderer = read("src/components/site/section-renderer.tsx");
    assert.ok(!/\banimation\b/i.test(renderer), "the renderer now reads animation");
  });

  test("no block component takes it either", () => {
    assert.ok(!/\banimation\b/i.test(read("src/components/site/blocks/context.ts")));
  });

  test("it is still carried as far as the renderer's door", () => {
    assert.match(read("src/lib/queries/content.ts"), /animation: string;/);
  });

  test("a draft save still writes it live — the reason the defect stays", () => {
    const actions = read("src/app/(backoffice)/admin/(shell)/pages/actions.ts");
    // The one write `saveSectionDraft` makes, read out of the source: the
    // draft goes in it, and so does `animation`, which is a published column.
    const body = actions.slice(actions.indexOf("export async function saveSectionDraft"));
    const write = body.slice(body.indexOf("updateSectionGuarded("), body.indexOf("if (!result.ok)"));
    assert.ok(write.length > 0, "saveSectionDraft no longer makes one guarded write");
    assert.match(write, /draft: values/);
    assert.match(write, /\banimation\b/);
  });
});
