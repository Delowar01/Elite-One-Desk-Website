/**
 * Batch 21: the dynamic-route foundation, decided without a database.
 *
 * The Visual Editor learned to open a service-category route by giving each of
 * its regions an owner — the category, a group, a service, a question — with
 * the same address grammar, the same block vocabulary and the same buffer
 * keys a page section has. These are the pure halves of that: the identity
 * model, the protocol's new reading, the registry's two doors, the capability
 * models' answers for route regions, and the category adapter's own rules for
 * what a draft stores, what it shows and when it disagrees with live data.
 *
 * The database halves — drafts, publication, permissions, the rendered page —
 * are `route-editor.test.ts`.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { formatAddress, parseAddress, composeAddress, decomposeAddress } from "@/lib/cms/address";
import { BLOCKS, blocksForPage, getBlock, getEditorBlock } from "@/lib/cms/blocks";
import { previewRoutePath } from "@/lib/page-path";
import { ORDER_KEY, ROUTE_BLOCKS, ROUTE_BLOCK_OF, ROUTE_STRUCTURAL_FIELDS } from "@/lib/routes/blocks";
import {
  applyOrder,
  changedKeys,
  conflictsOf,
  effectiveData,
  nextPatch,
  orderAgrees,
  ownerBelongs,
  ownersOf,
  pendingPatch,
  readSubmitted,
  SPECS,
  storedValuesOf,
  valuesOf,
  type CategoryData,
  type StoredPatch,
} from "@/lib/routes/category-model";
import {
  documentEditorKey,
  documentOfEditorKey,
  editorKeyOf,
  isRouteEditorKey,
  ownerKeyOf,
  ownerOfEditorKey,
  parseOwnerKey,
  parseRouteKey,
  ROUTE_KEY_SPAN,
  ROUTE_OWNER_CODES,
  type RouteOwner,
} from "@/lib/routes/owners";
import { hasPackageHub } from "@/lib/routes/package-hub";
import { diffContent, applyContent } from "@/lib/visual-editor/history";
import { motionForBlock, motionTargetFor } from "@/lib/visual-editor/motion-targets";
import { PROTOCOL_VERSION, envelope, readCanvasMessage } from "@/lib/visual-editor/protocol";
import { styleTargetFor } from "@/lib/visual-editor/style-targets";
import { buildLayerTree, directEditAt, layerKindOf, textAt, applyTextAt } from "@/lib/visual-editor/tree";

const REPO = path.resolve(import.meta.dirname, "..");
const BRIDGE = "0123456789abcdef0123456789abcdef";
const wrap = (message: unknown) => envelope(BRIDGE, message);

/* -------------------------------------------------------------------------- */
/* A category, as the adapter reads one                                        */
/* -------------------------------------------------------------------------- */

const at = new Date("2026-01-01T00:00:00Z");

function category(over: Partial<CategoryData["category"]> = {}): CategoryData["category"] {
  return {
    id: 3,
    slug: "a-category-made-up-for-the-test",
    titleEn: "Visas",
    titleAr: "",
    taglineEn: "Every visa",
    taglineAr: "",
    summaryEn: "We handle the paperwork.",
    summaryAr: "",
    bodyEn: "",
    bodyAr: "",
    icon: "passport",
    imageId: null,
    ctaLabelEn: "",
    ctaLabelAr: "",
    ctaHref: "",
    sortOrder: 0,
    isPublished: true,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

const group = (id: number, sortOrder: number, over: Partial<CategoryData["groups"][number]> = {}) => ({
  id,
  categoryId: 3,
  slug: `group-${id}`,
  titleEn: `Group ${id}`,
  titleAr: "",
  summaryEn: "",
  summaryAr: "",
  sortOrder,
  isPublished: true,
  createdAt: at,
  updatedAt: at,
  ...over,
});

const service = (id: number, subcategoryId: number | null, sortOrder: number, over: Record<string, unknown> = {}) =>
  ({
    id,
    categoryId: 3,
    subcategoryId,
    slug: `service-${id}`,
    titleEn: `Service ${id}`,
    titleAr: "",
    introEn: `Intro ${id}`,
    introAr: "",
    bodyEn: "",
    bodyAr: "",
    benefits: [],
    audience: [],
    requirements: [],
    processSteps: [],
    timelineEn: "",
    timelineAr: "",
    notesEn: "",
    notesAr: "",
    formPreset: "general",
    imageId: null,
    isFeatured: false,
    isPublished: true,
    sortOrder,
    createdAt: at,
    updatedAt: at,
    ...over,
  }) as CategoryData["services"][number];

const faq = (id: number, sortOrder: number) => ({
  id,
  scope: "category" as const,
  categoryId: 3,
  serviceId: null,
  questionEn: `Question ${id}?`,
  questionAr: "",
  answerEn: `<p>Answer ${id}</p>`,
  answerAr: "",
  sortOrder,
  isPublished: true,
  createdAt: at,
  updatedAt: at,
});

const DATA: CategoryData = {
  category: category(),
  groups: [group(10, 1), group(11, 2)],
  services: [service(20, 10, 1), service(21, 10, 2), service(22, 10, 3), service(23, 11, 1), service(24, null, 1)],
  faqs: [faq(30, 1), faq(31, 2)],
};

/* -------------------------------------------------------------------------- */

describe("owner identity: one owner, two spellings, no collisions", () => {
  test("every owner type has its own code, and the codes are the documented ones", () => {
    const codes = Object.values(ROUTE_OWNER_CODES);
    assert.equal(new Set(codes).size, codes.length);
    assert.deepEqual(ROUTE_OWNER_CODES, {
      category: 1,
      categoryCrumbs: 2,
      categoryBody: 3,
      categoryServices: 4,
      subcategory: 5,
      service: 6,
      categoryHub: 7,
      categoryFaqs: 8,
      faq: 9,
      // A service's own page (Batch 22), appended after the category's: the
      // codes are part of the editor-key encoding, so they only ever grow.
      serviceHero: 10,
      serviceCrumbs: 11,
      serviceOverview: 12,
      serviceBenefits: 13,
      serviceAudience: 14,
      serviceRequirements: 15,
      serviceProcess: 16,
      serviceNotes: 17,
      serviceFaqs: 18,
      serviceNotices: 19,
      serviceRequest: 20,
      serviceRelated: 21,
      // A package's page, a destination's page, the package catalogue and the
      // services overview (Batch 24), appended after Batch 22's.
      packageHero: 22,
      packageCrumbs: 23,
      packageBody: 24,
      packageHighlights: 25,
      packageRequest: 26,
      destinationHero: 27,
      destinationCrumbs: 28,
      destinationPackages: 29,
      packageIndexHero: 30,
      packageIndexCrumbs: 31,
      packageIndexCatalogue: 32,
      destinationGroup: 33,
      packageCard: 34,
      packageIndexCustom: 35,
      serviceIndexHero: 36,
      serviceIndexCrumbs: 37,
      serviceIndexCategories: 38,
    });
  });

  test("an owner's editor key is negative, lossless, and never a section id", () => {
    for (const type of Object.keys(ROUTE_OWNER_CODES) as RouteOwner["type"][]) {
      for (const id of [1, 12, 999_999_999]) {
        const key = editorKeyOf({ type, id });
        assert.ok(key < 0);
        assert.deepEqual(ownerOfEditorKey(key), { type, id });
        assert.equal(isRouteEditorKey(key), true);
      }
    }
    assert.equal(editorKeyOf({ type: "service", id: 12 }), -(6 * ROUTE_KEY_SPAN + 12));
    // A page section's id is not a route key, and neither is a stray number.
    for (const stray of [0, 1, 42, -1, -ROUTE_KEY_SPAN, -(99 * ROUTE_KEY_SPAN + 1), 1.5, Number.NaN, "service:1"]) {
      assert.equal(ownerOfEditorKey(stray), null, String(stray));
    }
  });

  test("owner keys parse strictly — type, colon, a positive id, nothing else", () => {
    assert.deepEqual(parseOwnerKey("service:12"), { type: "service", id: 12 });
    assert.deepEqual(parseOwnerKey("categoryHub:3"), { type: "categoryHub", id: 3 });
    for (const bad of ["service:0", "service:-1", "service:1.5", "Service:1", "service: 1", "bogus:1", "section:1", "service:12/field:title", ""]) {
      assert.equal(parseOwnerKey(bad), null, bad);
    }
    assert.equal(ownerKeyOf({ type: "faq", id: 7 }), "faq:7");
  });

  test("a route document is named by its category's id, and its key is the hero's", () => {
    assert.deepEqual(parseRouteKey("category:3"), { kind: "category", id: 3 });
    for (const bad of ["category:0", "category:travel-tourism", "page:3", "category:3/x"]) assert.equal(parseRouteKey(bad), null);
    const key = documentEditorKey({ kind: "category", id: 3 });
    assert.equal(key, editorKeyOf({ type: "category", id: 3 }));
    assert.deepEqual(documentOfEditorKey(key), { kind: "category", id: 3 });
    assert.equal(documentOfEditorKey(editorKeyOf({ type: "service", id: 3 })), null);
  });
});

describe("addresses: the same grammar, a route owner in front", () => {
  test("a route address parses to the owner's editor key and formats back exactly", () => {
    const parsed = parseAddress("service:12/field:intro");
    assert.ok(parsed);
    assert.equal(parsed.sectionId, editorKeyOf({ type: "service", id: 12 }));
    assert.equal(formatAddress(parsed.sectionId, parsed.path), "service:12/field:intro");
    assert.equal(formatAddress(editorKeyOf({ type: "category", id: 3 })), "category:3");
    assert.deepEqual(decomposeAddress("faq:7/field:question"), {
      sectionId: editorKeyOf({ type: "faq", id: 7 }),
      relative: "field:question",
    });
  });

  test("page addresses are unchanged, and nothing else gets in", () => {
    assert.deepEqual(parseAddress("section:42/field:headline"), {
      sectionId: 42,
      path: [{ kind: "field", name: "headline" }],
    });
    for (const bad of ["section:-5", "section:0", "service:0/field:title", "bogus:1/field:title", "service:12/field:title@ar", "service:12//field:x"]) {
      assert.equal(parseAddress(bad), null, bad);
    }
  });

  test("composing a persisted path stays section-only", () => {
    assert.equal(composeAddress(editorKeyOf({ type: "service", id: 12 }), "field:title"), null);
    assert.equal(composeAddress(5, "field:title"), "section:5/field:title");
  });
});

describe("protocol 7 reads route owners and nesting, and nothing more", () => {
  test("the version moved for it", () => {
    assert.equal(PROTOCOL_VERSION, 7);
  });

  test("a route document may announce itself; a stray negative id may not", () => {
    const pageId = documentEditorKey({ kind: "category", id: 3 });
    const ready = { type: "canvas.ready", pageId, slug: "category:3", locale: "ar", innerWidth: 1440 };
    assert.deepEqual(readCanvasMessage(wrap(ready), { bridgeId: BRIDGE, slug: "category:3" }), ready);
    // The editor asked for a different document: not this one.
    assert.equal(readCanvasMessage(wrap(ready), { bridgeId: BRIDGE, slug: "category:4" }), null);
    assert.equal(readCanvasMessage(wrap({ ...ready, pageId: -7 }), { bridgeId: BRIDGE }), null);
    assert.equal(
      readCanvasMessage(wrap({ ...ready, pageId: editorKeyOf({ type: "service", id: 3 }) }), { bridgeId: BRIDGE }),
      null,
    );
  });

  test("a region carries its parent; a parent that is not an owner root is dropped, not the region", () => {
    const card = editorKeyOf({ type: "service", id: 21 });
    const message = readCanvasMessage(
      wrap({
        type: "canvas.structure",
        sections: [
          {
            address: "service:21",
            sectionId: card,
            blockType: "route-service-card",
            position: 4,
            isDraft: false,
            isDraftOnly: false,
            visible: true,
            parent: "subcategory:10",
            nodes: [{ address: "service:21/field:title", kind: "field", relativePath: "field:title", text: "Visa" }],
          },
          {
            address: "service:22",
            sectionId: editorKeyOf({ type: "service", id: 22 }),
            blockType: "route-service-card",
            position: 5,
            isDraftOnly: false,
            isDraft: false,
            visible: false,
            parent: "subcategory:10/field:title",
            nodes: [],
          },
        ],
      }),
      { bridgeId: BRIDGE },
    );
    assert.ok(message && message.type === "canvas.structure");
    assert.equal(message.sections[0]!.parent, "subcategory:10");
    assert.equal(message.sections[0]!.nodes[0]!.address, "service:21/field:title");
    assert.equal(message.sections[1]!.parent, undefined);
    assert.equal(message.sections[1]!.visible, false);
  });

  test("a node naming a region its section id does not match is refused", () => {
    const selection = readCanvasMessage(
      wrap({
        type: "canvas.selection",
        node: {
          address: "service:21/field:title",
          kind: "field",
          sectionId: editorKeyOf({ type: "service", id: 22 }),
          blockType: "route-service-card",
          relativePath: "field:title",
        },
        rect: { x: 1, y: 1, width: 10, height: 10 },
      }),
      { bridgeId: BRIDGE },
    );
    assert.equal(selection, null);
  });
});

describe("the registry has two doors, and route blocks only fit one", () => {
  test("the page CMS cannot see a route block; the editor can", () => {
    for (const block of ROUTE_BLOCKS) {
      assert.equal(getBlock(block.type), undefined, block.type);
      assert.equal(getEditorBlock(block.type), block);
      assert.ok(!BLOCKS.includes(block));
      for (const slug of ["home", "about", "contact"]) {
        assert.ok(!blocksForPage(slug).some((offered) => offered.type === block.type));
      }
    }
    // Every page block is still reachable through both.
    for (const block of BLOCKS) assert.equal(getEditorBlock(block.type), getBlock(block.type));
  });

  test("every owner type is drawn as a registered route block", () => {
    for (const type of Object.keys(ROUTE_OWNER_CODES) as RouteOwner["type"][]) {
      assert.ok(getEditorBlock(ROUTE_BLOCK_OF[type]), type);
    }
  });

  test("generated fields are never typed into, and are named in Layers", () => {
    assert.equal(directEditAt("route-service-card", "field:link"), null);
    assert.equal(directEditAt("route-category-hero", "field:whatsapp"), null);
    assert.equal(directEditAt("route-category-crumbs", "field:trail"), null);
    assert.equal(directEditAt("route-category-hub", "field:destinations"), null);
    assert.deepEqual(directEditAt("route-category-hero", "field:title"), { multiline: false, localised: true });
    assert.deepEqual(directEditAt("route-service-card", "field:intro"), { multiline: true, localised: true });
    // Rich text has the Inspector's editor and its sanitizer, never the canvas's.
    assert.equal(directEditAt("route-category-body", "field:body"), null);
    assert.equal(directEditAt("route-faq", "field:answer"), null);
    assert.equal(layerKindOf("route-category-hero", "field:image"), "media");
    const tree = buildLayerTree("route-service-card", [
      { address: "service:21/field:title", relativePath: "field:title", text: "Visa" },
      { address: "service:21/field:link", relativePath: "field:link" },
    ], { locale: "en" });
    assert.deepEqual(tree.map((node) => node.label), ["Title", "Link"]);
  });

  test("direct text editing writes one edition and never the other", () => {
    const values = valuesOf("category", storedValuesOf({ type: "category", id: 3 }, DATA, null));
    const arabic = applyTextAt(values, "route-category-hero", "field:title", "ar", "تأشيرات");
    assert.ok(arabic);
    assert.deepEqual(arabic.title, { en: "Visas", ar: "تأشيرات" });
    // An empty Arabic field is edited from empty, not from the English fallback.
    assert.equal(textAt(values, "route-category-hero", "field:title", "ar"), "");
  });

  test("styles are offered by the same closed model", () => {
    assert.equal(styleTargetFor("route-category-hero", undefined).category, "section");
    assert.equal(styleTargetFor("route-category-hero", "field:image").category, "media");
    assert.equal(styleTargetFor("route-category-hub", "field:destinations").layout, "flex");
    assert.equal(styleTargetFor("route-service-card", "field:title").category, "text");
  });

  test("motion is offered where it is safe, and never on generated chrome", () => {
    assert.equal(motionTargetFor("route-category-crumbs", undefined).kind, null);
    assert.equal(motionTargetFor("route-category-crumbs", "field:trail").kind, null);
    assert.equal(motionTargetFor("route-service-card", undefined).kind, "section");
    assert.ok((motionTargetFor("route-category-hero", "field:title").fields as readonly string[]).includes("textReveal"));
    // A stored entrance on the breadcrumbs is cut away, whatever was sent.
    const cut = motionForBlock(
      { v: 1, section: { base: { entrance: "fade-up" } }, nodes: { "field:trail": { base: { entrance: "fade" } } } },
      "route-category-crumbs",
    );
    assert.deepEqual(cut.section, {});
    assert.deepEqual(cut.nodes, {});
  });
});

describe("no category is special to the editor", () => {
  /** Every file the Visual Editor's route support is made of. */
  const sources = (): string[] => {
    const roots = ["src/lib/routes", "src/components/admin/visual-editor", "src/app/(backoffice)/admin/visual-editor", "src/lib/visual-editor"];
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
      }
    };
    for (const root of roots) walk(path.join(REPO, root));
    return out;
  };

  test("the five production slugs appear nowhere in the editor's sources but the route's own rendering rule", () => {
    const slugs = ["travel-tourism", "business-setup", "iqama-services", "license-renewal", "government-relations"];
    const hits: string[] = [];
    for (const file of sources()) {
      const relative = path.relative(REPO, file);
      // The public route's pre-existing rule for where the packages panel goes,
      // moved verbatim out of the page so the page and the adapter share it.
      if (relative === "src/lib/routes/package-hub.ts") continue;
      const text = readFileSync(file, "utf8");
      for (const slug of slugs) if (text.includes(slug)) hits.push(`${relative}: ${slug}`);
    }
    assert.deepEqual(hits, []);
  });

  test("a category the code has never heard of gets every region but the packages panel", () => {
    const owners = ownersOf(DATA).map(ownerKeyOf);
    assert.deepEqual(owners, [
      "category:3",
      "categoryCrumbs:3",
      "categoryBody:3",
      "categoryServices:3",
      "subcategory:10",
      "subcategory:11",
      "service:20",
      "service:21",
      "service:22",
      "service:23",
      "service:24",
      "categoryFaqs:3",
      "faq:30",
      "faq:31",
    ]);
    assert.equal(hasPackageHub(DATA.category), false);
  });

  test("ownership is checked against the rows: another category's card does not belong", () => {
    assert.equal(ownerBelongs({ type: "service", id: 21 }, DATA), true);
    assert.equal(ownerBelongs({ type: "service", id: 99 }, DATA), false);
    assert.equal(ownerBelongs({ type: "category", id: 4 }, DATA), false);
    assert.equal(ownerBelongs({ type: "categoryHub", id: 3 }, DATA), false);
  });
});

describe("what a draft stores", () => {
  const hero: RouteOwner = { type: "category", id: 3 };
  const live = storedValuesOf(hero, DATA, null);
  const media = new Set([7]);

  test("the Inspector's values read back with the admin forms' rules", () => {
    const values = valuesOf("category", live);
    const read = readSubmitted(hero, { ...values, title: { en: "  New title  ", ar: "عنوان" } }, DATA, media);
    assert.ok(read.ok);
    assert.equal(read.stored.titleEn, "New title");
    assert.equal(read.stored.titleAr, "عنوان");
  });

  test("an empty English title, an unknown icon, an unsafe link, a missing picture are refused by name", () => {
    const values = valuesOf("category", live);
    const refused = (over: Record<string, unknown>) => {
      const read = readSubmitted(hero, { ...values, ...over }, DATA, media);
      assert.equal(read.ok, false);
      return read.ok ? "" : read.problem.message;
    };
    assert.match(refused({ title: { en: "", ar: "x" } }), /Title \(English\) cannot be empty/);
    assert.match(refused({ icon: "<svg>" }), /icon/);
    assert.match(refused({ ctaHref: "javascript:alert(1)" }), /site path/);
    assert.match(refused({ ctaHref: "//evil.example" }), /site path/);
    assert.match(refused({ image: 8 }), /media library/);
    const ok = readSubmitted(hero, { ...values, ctaHref: "https://wa.me/1", image: 7 }, DATA, media);
    assert.ok(ok.ok);
    assert.equal(ok.stored.ctaHref, "https://wa.me/1");
    assert.equal(ok.stored.imageId, 7);
  });

  test("rich text is sanitised exactly as the admin form sanitises it", () => {
    const body: RouteOwner = { type: "categoryBody", id: 3 };
    const read = readSubmitted(
      body,
      { body: { en: '<p onclick="x()">Hi<script>alert(1)</script></p>', ar: "" } },
      DATA,
      media,
    );
    assert.ok(read.ok);
    assert.doesNotMatch(String(read.stored.bodyEn), /script|onclick/);
    assert.match(String(read.stored.bodyEn), /Hi/);
  });

  test("a card may only move to a group of its own category", () => {
    const card: RouteOwner = { type: "service", id: 21 };
    const values = valuesOf("service", storedValuesOf(card, DATA, null));
    assert.equal(readSubmitted(card, { ...values, group: "99" }, DATA, media).ok, false);
    const moved = readSubmitted(card, { ...values, group: "11" }, DATA, media);
    assert.ok(moved.ok);
    assert.equal(moved.stored.subcategoryId, 11);
  });

  test("the patch holds changed fields only, keeps its starting point, and drops a value put back", () => {
    const first = nextPatch(hero, {}, live, { ...live, titleEn: "One" }, DATA);
    assert.deepEqual(first, { titleEn: { value: "One", base: "Visas" } });
    // Somebody saved the title in the admin form since; a second edit keeps the
    // original starting point, so publishing can still notice.
    const moved = { ...live, titleEn: "Changed in the form" };
    const second = nextPatch(hero, first, moved, { ...moved, titleEn: "Two" }, DATA);
    assert.deepEqual(second, { titleEn: { value: "Two", base: "Visas" } });
    assert.deepEqual(nextPatch(hero, first, live, live, DATA), {});
    assert.deepEqual(
      changedKeys(hero, first, live, second).map((spec) => spec.key),
      ["titleEn"],
    );
  });

  test("a field changed in a form since its draft began is a conflict; the same value on both sides is not", () => {
    const patch = { titleEn: { value: "Mine", base: "Visas" } };
    assert.deepEqual(conflictsOf(hero, patch, live), []);
    const formEdit = { ...live, titleEn: "Theirs" };
    assert.deepEqual(conflictsOf(hero, patch, formEdit).map((conflict) => conflict.key), ["titleEn"]);
    // Both chose "Mine": nothing is pending and nothing disagrees.
    assert.deepEqual(pendingPatch(hero, patch, { ...live, titleEn: "Mine" }), {});
  });

  test("Arabic is never seeded from English", () => {
    const values = valuesOf("category", live);
    assert.deepEqual(values.title, { en: "Visas", ar: "" });
    const read = readSubmitted(hero, values, DATA, media);
    assert.ok(read.ok);
    assert.equal(read.stored.titleAr, "");
  });
});

describe("orders and visibility", () => {
  test("a draft order is completed against who is really in the list", () => {
    assert.deepEqual(applyOrder([22, 20], [20, 21, 22]), [22, 20, 21]);
    assert.deepEqual(applyOrder([99, 22, 22, 20], [20, 21, 22]), [22, 20, 21]);
    assert.deepEqual(applyOrder("nonsense", [20, 21]), [20, 21]);
  });

  test("orders disagree only when the same rows were ordered differently", () => {
    assert.equal(orderAgrees([20, 21, 22], [20, 21, 22, 25]), true);
    assert.equal(orderAgrees([20, 21, 22], [20, 22]), true);
    assert.equal(orderAgrees([20, 21, 22], [21, 20, 22]), false);
  });

  test("the draft's order and visibility are what the canvas draws, group by group", () => {
    const patches = new Map<string, StoredPatch>([
      ["subcategory:10", { "order:services": { value: [22, 20, 21], base: [20, 21, 22] } }],
      ["service:23", { isPublished: { value: false, base: true } }],
      ["service:24", { subcategoryId: { value: 11, base: null } }],
    ]);
    const shown = effectiveData(DATA, patches);
    assert.deepEqual(
      shown.services.filter((row) => row.subcategoryId === 10).map((row) => row.id),
      [22, 20, 21],
    );
    // The other group's card keeps its place; the moved card joins group 11.
    assert.deepEqual(
      shown.services.filter((row) => row.subcategoryId === 11).map((row) => row.id),
      [23, 24],
    );
    assert.equal(shown.services.find((row) => row.id === 23)!.isPublished, false);
    // Live rows are untouched by computing a draft.
    assert.equal(DATA.services.find((row) => row.id === 24)!.subcategoryId, null);
  });

  test("a move is one content change Undo can take back and Redo can put back", () => {
    const owner: RouteOwner = { type: "subcategory", id: 10 };
    const before = valuesOf("subcategory", storedValuesOf(owner, DATA, null));
    assert.deepEqual(before[ORDER_KEY], { services: [20, 21, 22] });
    const after = { ...before, [ORDER_KEY]: { services: [21, 20, 22] } };
    const changes = diffContent("route-subcategory", before, after);
    assert.equal(changes.length, 1);
    assert.deepEqual(applyContent(after, changes, "undo"), before);
    assert.deepEqual(applyContent(before, changes, "redo"), after);
  });

  test("order, visibility and grouping are layout; everything else is content", () => {
    const structural = Object.entries(SPECS)
      .flatMap(([type, specs]) => specs.map((spec) => ({ type, spec })))
      .filter(({ spec }) => spec.structural)
      .map(({ type, spec }) => `${type}.${spec.key}`);
    assert.deepEqual(structural.sort(), [
      "categoryFaqs.order:faqs",
      "categoryServices.order:groups",
      "categoryServices.order:services",
      "faq.isPublished",
      // A package's card on the catalogue: its destination and whether it is shown (Batch 24).
      "packageCard.destinationId",
      "packageCard.isPublished",
      "service.isPublished",
      "service.subcategoryId",
      // The order of a service's own questions, on its own page (Batch 22).
      "serviceFaqs.order:faqs",
      "subcategory.isPublished",
      "subcategory.order:services",
    ]);
    assert.deepEqual([...ROUTE_STRUCTURAL_FIELDS].sort(), ["group", "published"]);
  });
});

describe("previewing a route", () => {
  test("the canvas address is the route's own path in the edition asked for", () => {
    assert.equal(
      previewRoutePath("/services/visas", "en", { editor: { bridgeId: BRIDGE }, nonce: 3 }),
      `/services/visas?preview=1&editor=1&bridge=${BRIDGE}&r=3`,
    );
    assert.equal(previewRoutePath("/services/visas", "ar"), "/ar/services/visas?preview=1");
  });
});
