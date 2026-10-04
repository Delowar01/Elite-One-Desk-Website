/**
 * Batch 22: a service's own page in the Visual Editor — the pure halves,
 * decided without a database.
 *
 * Batch 21 gave the editor a route adapter and one route (a category's page).
 * Batch 22 extends that adapter to `/[lang]/services/[category]/[service]`.
 * These hold what can be held without a connection: the page's identity (the
 * service's id, never its address), its regions, the registry's description of
 * them and what the capability models make of it, the record's own rules for
 * what a draft may store, what a draft makes the page say, what is shown, and
 * that nothing in the editor names a particular service or category.
 *
 * The database halves — drafts, publication, permissions, moves, deletion,
 * the rendered page — are `service-editor.test.ts`.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { CATALOG, slugify } from "../scripts/seed/catalog";

import { parseAddress } from "@/lib/cms/address";
import { BLOCKS, blocksForPage, getBlock, getEditorBlock } from "@/lib/cms/blocks";
import { ROUTE_BLOCK_OF, ROUTE_LIST_OF } from "@/lib/routes/blocks";
import { ownerBelongs, type CategoryData } from "@/lib/routes/category-model";
import {
  documentEditorKey,
  documentOfEditorKey,
  editorKeyOf,
  ownerKeyOf,
  parseOwnerKey,
  parseRouteKey,
  routeKeyOf,
  type RouteOwner,
} from "@/lib/routes/owners";
import {
  effectiveServiceData,
  isServiceRegion,
  questionsOf,
  readServiceSubmitted,
  serviceNextPatch,
  serviceOwnerBelongs,
  serviceOwnersOf,
  servicePathOf,
  serviceRegionVisible,
  serviceStoredValuesOf,
  SERVICE_REGIONS,
  type ServiceData,
} from "@/lib/routes/service-model";
import {
  conflictsOf,
  describeStored,
  pendingPatch,
  publishedValue,
  resourceOf,
  sameStored,
  SPECS,
  specOf,
  storedProblem,
  valuesOf,
  type StoredPatch,
} from "@/lib/routes/specs";
import { applyContent, describeContent, diffContent } from "@/lib/visual-editor/history";
import { motionForBlock, motionTargetFor } from "@/lib/visual-editor/motion-targets";
import { envelope, readCanvasMessage } from "@/lib/visual-editor/protocol";
import { styleTargetFor } from "@/lib/visual-editor/style-targets";
import { buildLayerTree, directEditAt, layerKindOf, textAt, applyTextAt } from "@/lib/visual-editor/tree";

const REPO = path.resolve(import.meta.dirname, "..");
const BRIDGE = "0123456789abcdef0123456789abcdef";

/* -------------------------------------------------------------------------- */
/* A service, as the adapter reads one                                        */
/* -------------------------------------------------------------------------- */

const at = new Date("2026-01-01T00:00:00Z");

const category = {
  id: 3,
  slug: "a-category-made-up-for-the-test",
  titleEn: "Made-up Category",
  titleAr: "",
  taglineEn: "",
  taglineAr: "",
  summaryEn: "",
  summaryAr: "",
  bodyEn: "",
  bodyAr: "",
  icon: "desk",
  imageId: null,
  ctaLabelEn: "",
  ctaLabelAr: "",
  ctaHref: "",
  sortOrder: 0,
  isPublished: true,
  createdAt: at,
  updatedAt: at,
} satisfies ServiceData["category"];

function serviceRow(over: Partial<ServiceData["service"]> = {}): ServiceData["service"] {
  return {
    id: 40,
    categoryId: 3,
    subcategoryId: 10,
    slug: "a-service-made-up-for-the-test",
    titleEn: "Made-up Service",
    titleAr: "خدمة",
    introEn: "What it is.",
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
    sortOrder: 1,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

const faq = (id: number, sortOrder: number, over: Partial<ServiceData["faqs"][number]> = {}): ServiceData["faqs"][number] => ({
  id,
  scope: "service",
  categoryId: null,
  serviceId: 40,
  questionEn: `Question ${id}?`,
  questionAr: "",
  answerEn: `<p>Answer ${id}</p>`,
  answerAr: "",
  sortOrder,
  isPublished: true,
  createdAt: at,
  updatedAt: at,
  ...over,
});

const DATA: ServiceData = {
  service: serviceRow(),
  category,
  faqs: [faq(50, 2), faq(51, 4)],
  // The category's questions, shown between the service's own by position.
  inherited: [faq(60, 1, { scope: "category", categoryId: 3, serviceId: null }), faq(61, 3, { scope: "category", categoryId: 3, serviceId: null })],
};

const hero: RouteOwner = { type: "serviceHero", id: 40 };
const media = new Set([7]);

/* ========================================================================== */

describe("identity: the page is the service, never its address", () => {
  test("a service route is named by the service's id, and its key is its hero's", () => {
    assert.deepEqual(parseRouteKey("service:40"), { kind: "service", id: 40 });
    assert.equal(routeKeyOf({ kind: "service", id: 40 }), "service:40");
    const key = documentEditorKey({ kind: "service", id: 40 });
    assert.equal(key, editorKeyOf(hero));
    assert.deepEqual(documentOfEditorKey(key), { kind: "service", id: 40 });
    // The category document is unchanged.
    assert.deepEqual(documentOfEditorKey(documentEditorKey({ kind: "category", id: 3 })), { kind: "category", id: 3 });
  });

  test("a slug, a path or a malformed key never names a route", () => {
    for (const bad of ["service:0", "service:visa-assistance", "service:40/x", "services:40", "service:-1", "page:3", ""]) {
      assert.equal(parseRouteKey(bad), null, bad);
    }
  });

  test("the route `service:40` and the card `service:40` are different vocabularies", () => {
    // The owner key names the service's card on its category's page…
    assert.deepEqual(parseOwnerKey("service:40"), { type: "service", id: 40 });
    // …and that card's editor key is not a document: the canvas cannot announce it as one.
    assert.equal(documentOfEditorKey(editorKeyOf({ type: "service", id: 40 })), null);
    // Only the hero's key is the page's.
    for (const type of SERVICE_REGIONS.filter((region) => region !== "serviceHero")) {
      assert.equal(documentOfEditorKey(editorKeyOf({ type, id: 40 })), null, type);
    }
  });

  test("every region of the page carries the service's id, so a rename or a move changes none of them", () => {
    const moved: ServiceData = {
      ...DATA,
      service: serviceRow({ slug: "renamed-address", titleEn: "Renamed", titleAr: "اسم جديد", categoryId: 9 }),
      category: { ...category, id: 9, slug: "another-category" },
    };
    assert.deepEqual(serviceOwnersOf(moved).map(ownerKeyOf), serviceOwnersOf(DATA).map(ownerKeyOf));
    // The address follows the rows; the identity does not.
    assert.equal(servicePathOf(DATA), "/services/a-category-made-up-for-the-test/a-service-made-up-for-the-test");
    assert.equal(servicePathOf(moved), "/services/another-category/renamed-address");
  });

  test("the canvas may announce a service page, and only as the document the editor asked for", () => {
    const pageId = documentEditorKey({ kind: "service", id: 40 });
    const ready = { type: "canvas.ready", pageId, slug: "service:40", locale: "en", innerWidth: 1440 };
    assert.deepEqual(readCanvasMessage(envelope(BRIDGE, ready), { bridgeId: BRIDGE, slug: "service:40" }), ready);
    assert.equal(readCanvasMessage(envelope(BRIDGE, ready), { bridgeId: BRIDGE, slug: "service:41" }), null);
    // A card's key, or a section region's, is not a document.
    assert.equal(
      readCanvasMessage(envelope(BRIDGE, { ...ready, pageId: editorKeyOf({ type: "serviceOverview", id: 40 }) }), { bridgeId: BRIDGE }),
      null,
    );
  });

  test("a service page's addresses parse to its regions' editor keys", () => {
    const parsed = parseAddress("serviceBenefits:40/field:benefits");
    assert.ok(parsed);
    assert.equal(parsed.sectionId, editorKeyOf({ type: "serviceBenefits", id: 40 }));
    assert.equal(parseAddress("serviceHero:0/field:title"), null);
  });
});

describe("regions: derived from the rows, the same for every service", () => {
  test("the page's regions, in page order, with the service's own questions after their section", () => {
    assert.deepEqual(serviceOwnersOf(DATA).map(ownerKeyOf), [
      "serviceHero:40",
      "serviceCrumbs:40",
      "serviceOverview:40",
      "serviceBenefits:40",
      "serviceAudience:40",
      "serviceRequirements:40",
      "serviceProcess:40",
      "serviceNotes:40",
      "serviceFaqs:40",
      "faq:50",
      "faq:51",
      "serviceNotices:40",
      "serviceRequest:40",
      "serviceRelated:40",
    ]);
  });

  test("a service with nothing but a title still has every region: an empty section is a placeholder to write into", () => {
    const bare: ServiceData = { ...DATA, faqs: [], inherited: [] };
    assert.equal(serviceOwnersOf(bare).length, SERVICE_REGIONS.length);
  });

  test("ownership is checked against the rows: another service's region, the category's questions and a category region do not belong", () => {
    assert.equal(serviceOwnerBelongs(hero, DATA), true);
    assert.equal(serviceOwnerBelongs({ type: "faq", id: 51 }, DATA), true);
    assert.equal(serviceOwnerBelongs({ type: "serviceHero", id: 41 }, DATA), false);
    // A category's question is shown here and edited on the category's page.
    assert.equal(serviceOwnerBelongs({ type: "faq", id: 60 }, DATA), false);
    assert.equal(serviceOwnerBelongs({ type: "category", id: 3 }, DATA), false);
    assert.equal(serviceOwnerBelongs({ type: "service", id: 40 }, DATA), false);
  });

  test("…and a category route never claims a service page's region", () => {
    const categoryData: CategoryData = { category, groups: [], services: [serviceRow()], faqs: [] };
    for (const type of SERVICE_REGIONS) assert.equal(ownerBelongs({ type, id: 40 }, categoryData), false, type);
  });

  test("each region edits the service's own row, or only the page's wording", () => {
    for (const type of ["serviceHero", "serviceOverview", "serviceBenefits", "serviceAudience", "serviceRequirements", "serviceProcess", "serviceNotes"] as const) {
      assert.deepEqual(resourceOf({ type, id: 40 }), { kind: "service", id: 40 }, type);
    }
    for (const type of ["serviceCrumbs", "serviceFaqs", "serviceNotices", "serviceRequest", "serviceRelated"] as const) {
      assert.deepEqual(resourceOf({ type, id: 40 }), { kind: "template", id: 40 }, type);
    }
    assert.deepEqual(resourceOf({ type: "faq", id: 50 }), { kind: "faq", id: 50 });
  });
});

describe("the registry: route blocks the page CMS cannot see", () => {
  test("every service region is drawn as a registered route block, editor-only", () => {
    for (const type of SERVICE_REGIONS) {
      const blockType = ROUTE_BLOCK_OF[type];
      const block = getEditorBlock(blockType);
      assert.ok(block, type);
      assert.equal(getBlock(blockType), undefined, `${blockType} is not a page block`);
      assert.ok(!BLOCKS.includes(block));
      for (const slug of ["home", "about"]) assert.ok(!blocksForPage(slug).some((offered) => offered.type === blockType));
    }
    // A service's own questions are reordered within their section.
    assert.equal(ROUTE_LIST_OF["route-faq"], "faqs");
  });

  test("identity and structure are not fields: no slug, category, group, preset, feature, visibility or position", () => {
    const keys = SERVICE_REGIONS.flatMap((type) => SPECS[type].map((spec) => spec.key));
    for (const system of ["slug", "categoryId", "subcategoryId", "formPreset", "isFeatured", "isPublished", "sortOrder", "id"]) {
      assert.equal(keys.includes(system), false, system);
    }
    // The only layout a service page offers is the order of its own questions.
    const structural = SERVICE_REGIONS.flatMap((type) => SPECS[type].filter((spec) => spec.structural).map((spec) => `${type}.${spec.key}`));
    assert.deepEqual(structural, ["serviceFaqs.order:faqs"]);
  });

  test("the Services screen's limits are the editor's", () => {
    assert.equal(specOf("serviceHero", "titleEn")?.max, 190);
    assert.equal(specOf("serviceHero", "titleEn")?.required, true);
    assert.equal(specOf("serviceHero", "introEn")?.max, 2000);
    assert.equal(specOf("serviceHero", "timelineEn")?.max, 190);
    assert.equal(specOf("serviceOverview", "bodyEn")?.max, 20000);
    assert.equal(specOf("serviceNotes", "notesEn")?.max, 8000);
    assert.deepEqual(
      { max: specOf("serviceBenefits", "benefits")?.max, rows: specOf("serviceBenefits", "benefits")?.rows },
      { max: 400, rows: 16 },
    );
    const steps = specOf("serviceProcess", "processSteps")!;
    assert.deepEqual({ max: steps.max, detail: steps.detailMax, rows: steps.rows }, { max: 200, detail: 800, rows: 10 });
  });

  test("text is typed into on the canvas; lists, rich text and generated parts are not", () => {
    assert.deepEqual(directEditAt("route-service-hero", "field:title"), { multiline: false, localised: true });
    assert.deepEqual(directEditAt("route-service-hero", "field:intro"), { multiline: true, localised: true });
    assert.deepEqual(directEditAt("route-service-hero", "field:timeline"), { multiline: false, localised: true });
    assert.deepEqual(directEditAt("route-service-hero", "field:ctaLabel"), { multiline: false, localised: true });
    assert.deepEqual(directEditAt("route-service-benefits", "field:heading"), { multiline: false, localised: true });
    assert.deepEqual(directEditAt("route-service-request", "field:intro"), { multiline: true, localised: true });
    for (const [block, path] of [
      ["route-service-benefits", "field:benefits"],
      ["route-service-process", "field:steps"],
      ["route-service-overview", "field:body"],
      ["route-service-notes", "field:notes"],
      ["route-service-hero", "field:category"],
      ["route-service-hero", "field:whatsapp"],
      ["route-service-crumbs", "field:trail"],
      ["route-service-faqs", "field:inherited"],
      ["route-service-notices", "field:notes"],
      ["route-service-request", "field:form"],
      ["route-service-related", "field:items"],
    ] as const) {
      assert.equal(directEditAt(block, path), null, `${block} ${path}`);
    }
    assert.equal(layerKindOf("route-service-benefits", "field:benefits"), "list");
    assert.equal(layerKindOf("route-service-hero", "field:image"), "media");
  });

  test("styles: the closed model, with each list's own layout", () => {
    assert.equal(styleTargetFor("route-service-hero", undefined).category, "section");
    assert.equal(styleTargetFor("route-service-hero", "field:image").category, "media");
    assert.equal(styleTargetFor("route-service-hero", "field:title").category, "text");
    assert.equal(styleTargetFor("route-service-benefits", "field:benefits").layout, "grid");
    assert.equal(styleTargetFor("route-service-audience", "field:audience").layout, "flex");
    assert.equal(styleTargetFor("route-service-requirements", "field:requirements").layout, null);
    assert.equal(styleTargetFor("route-service-related", "field:items").layout, "grid");
    assert.equal(styleTargetFor("route-service-benefits", "field:benefits").category, "container");
  });

  test("motion: entrances and Replay where safe; the breadcrumbs never move; a list may send its rows in turn", () => {
    assert.equal(motionTargetFor("route-service-crumbs", undefined).kind, null);
    assert.equal(motionTargetFor("route-service-crumbs", "field:trail").kind, null);
    assert.equal(motionTargetFor("route-service-hero", undefined).kind, "section");
    assert.ok((motionTargetFor("route-service-hero", "field:title").fields as readonly string[]).includes("textReveal"));
    const list = motionTargetFor("route-service-benefits", "field:benefits");
    assert.equal(list.kind, "list");
    assert.ok((list.fields as readonly string[]).includes("stagger"));
    // The request button already lifts itself: a second lift is not offered.
    const button = motionTargetFor("route-service-hero", "field:ctaLabel");
    assert.deepEqual([...button.hovers].sort(), ["lift", "nudge"].sort());
    const cut = motionForBlock(
      { v: 1, section: { base: { entrance: "fade-up" } }, nodes: { "field:trail": { base: { entrance: "fade" } } } },
      "route-service-crumbs",
    );
    assert.deepEqual(cut.section, {});
    assert.deepEqual(cut.nodes, {});
  });

  test("Layers names a service page's parts from the registry", () => {
    const tree = buildLayerTree(
      "route-service-hero",
      [
        { address: "serviceHero:40/field:title", relativePath: "field:title", text: "Made-up Service" },
        { address: "serviceHero:40/field:category", relativePath: "field:category" },
        { address: "serviceHero:40/field:timeline", relativePath: "field:timeline" },
      ],
      { locale: "en" },
    );
    assert.deepEqual(tree.map((node) => node.label), ["Title", "Category", "Indicative timeline"]);
  });
});

describe("what a draft stores: the record's own rules", () => {
  const live = serviceStoredValuesOf(hero, DATA, null);

  test("the Inspector's values read back with the Services screen's rules; Arabic is never seeded from English", () => {
    const values = valuesOf("serviceHero", live);
    assert.deepEqual(values.title, { en: "Made-up Service", ar: "خدمة" });
    assert.deepEqual(values.intro, { en: "What it is.", ar: "" });
    const read = readServiceSubmitted(hero, { ...values, title: { en: "  New title  ", ar: "عنوان" }, timeline: { en: "5–10 days", ar: "" } }, media);
    assert.ok(read.ok);
    assert.equal(read.stored.titleEn, "New title");
    assert.equal(read.stored.titleAr, "عنوان");
    assert.equal(read.stored.timelineEn, "5–10 days");
    assert.equal(read.stored.introAr, "");
  });

  test("an empty English title and a missing picture are refused by name; text is clipped to the column", () => {
    const values = valuesOf("serviceHero", live);
    const empty = readServiceSubmitted(hero, { ...values, title: { en: "", ar: "عنوان" } }, media);
    assert.equal(empty.ok, false);
    assert.match(empty.ok ? "" : empty.problem.message, /Title \(English\) cannot be empty/);
    const missing = readServiceSubmitted(hero, { ...values, image: 8 }, media);
    assert.equal(missing.ok, false);
    assert.match(missing.ok ? "" : missing.problem.message, /media library/);
    const long = readServiceSubmitted(hero, { ...values, title: { en: "x".repeat(400), ar: "" } }, media);
    assert.ok(long.ok);
    assert.equal(String(long.stored.titleEn).length, 190);
    const picked = readServiceSubmitted(hero, { ...values, image: 7 }, media);
    assert.ok(picked.ok);
    assert.equal(picked.stored.imageId, 7);
  });

  test("anything that is not a declared field is ignored, whatever is sent", () => {
    const values = valuesOf("serviceHero", live);
    const read = readServiceSubmitted(hero, { ...values, slug: "hijack", categoryId: 99, isPublished: false, whatsapp: "https://evil.example", category: "x" }, media);
    assert.ok(read.ok);
    assert.deepEqual(Object.keys(read.stored).sort(), SPECS.serviceHero.map((spec) => spec.key).sort());
    assert.equal(JSON.stringify(read.stored).includes("evil"), false);
    assert.equal(JSON.stringify(read.stored).includes("hijack"), false);
  });

  test("rich text is sanitised exactly as the Services screen sanitises it", () => {
    const owner: RouteOwner = { type: "serviceOverview", id: 40 };
    const read = readServiceSubmitted(owner, { body: { en: '<p onclick="x()">Hi<script>alert(1)</script></p>', ar: "" } }, media);
    assert.ok(read.ok);
    assert.doesNotMatch(String(read.stored.bodyEn), /script|onclick/);
    assert.match(String(read.stored.bodyEn), /Hi/);
  });

  test("a list is read row by row, clipped and capped as the Services screen does, keeping a row being written", () => {
    const owner: RouteOwner = { type: "serviceBenefits", id: 40 };
    const rows = Array.from({ length: 20 }, (_, index) => ({ text: { en: `Benefit ${index} ${"y".repeat(500)}`, ar: "" } }));
    const read = readServiceSubmitted(owner, { benefits: [{ text: { en: "", ar: "" } }, ...rows] }, media);
    assert.ok(read.ok);
    const stored = read.stored.benefits as { en: string; ar: string }[];
    assert.equal(stored.length, 16);
    assert.deepEqual(stored[0], { en: "", ar: "" });
    assert.ok(stored.every((row) => row.en.length <= 400));
    // What is published is what the Services screen would keep: no empty rows.
    const published = publishedValue(specOf("serviceBenefits", "benefits"), stored) as unknown[];
    assert.equal(published.length, 15);
  });

  test("steps keep a title and a detail per language, ten of them at most", () => {
    const owner: RouteOwner = { type: "serviceProcess", id: 40 };
    const rows = Array.from({ length: 12 }, (_, index) => ({
      title: { en: `Step ${index}`, ar: `خطوة ${index}` },
      detail: { en: "d".repeat(900), ar: "" },
    }));
    const read = readServiceSubmitted(owner, { steps: rows }, media);
    assert.ok(read.ok);
    const stored = read.stored.processSteps as { en: string; ar: string; detailEn: string; detailAr: string }[];
    assert.equal(stored.length, 10);
    assert.deepEqual(Object.keys(stored[0]!), ["en", "ar", "detailEn", "detailAr"]);
    assert.equal(stored[0]!.detailEn.length, 800);
    // And back into the Inspector's rows.
    const values = valuesOf("serviceProcess", { "copy:headingEn": "", "copy:headingAr": "", processSteps: stored });
    assert.deepEqual((values.steps as unknown[])[0], { title: { en: "Step 0", ar: "خطوة 0" }, detail: { en: "d".repeat(800), ar: "" } });
  });

  test("a list's rows have no identity: the editor keys them by position and mints no id the server would drop", () => {
    // What the server answers with: plain rows, whatever id the browser sent.
    const owner: RouteOwner = { type: "serviceBenefits", id: 40 };
    const read = readServiceSubmitted(owner, { benefits: [{ _id: "abcdefgh", text: { en: "Fast", ar: "" } }] }, media);
    assert.ok(read.ok);
    assert.deepEqual(read.stored.benefits, [{ en: "Fast", ar: "" }]);
    const echoed = valuesOf("serviceBenefits", { "copy:headingEn": "", "copy:headingAr": "", benefits: read.stored.benefits });
    assert.deepEqual(echoed.benefits, [{ text: { en: "Fast", ar: "" } }]);
    // So every editable list of a service page is declared positional: an edit
    // filed under a minted id could not be undone once the save dropped the id.
    for (const [type, name] of [
      ["route-service-benefits", "benefits"],
      ["route-service-audience", "audience"],
      ["route-service-requirements", "requirements"],
      ["route-service-process", "steps"],
    ] as const) {
      const field = getEditorBlock(type)?.fields.find((candidate) => candidate.name === name);
      assert.equal(field?.type, "items", `${type}.${name}`);
      assert.equal(field?.positional, true, `${type}.${name} is positional`);
    }
    // …and no list of the page CMS is: its rows are stored with their ids.
    for (const block of BLOCKS) {
      for (const field of block.fields) assert.equal(field.positional, undefined, `${block.type}.${field.name}`);
    }
  });

  test("an edit to a positional list is undone whole, so it still applies after the save dropped the rows' ids", () => {
    const added = diffContent("route-service-benefits", { benefits: [] }, { benefits: [{ text: { en: "", ar: "" } }] });
    const typed = diffContent("route-service-benefits", { benefits: [{ text: { en: "", ar: "" } }] }, { benefits: [{ text: { en: "Fast", ar: "" } }] });
    for (const changes of [added, typed]) {
      assert.deepEqual(changes.map((change) => change.path), [{ field: "benefits" }]);
    }
    // The server's answer — the same rows — is what Undo is applied to.
    const saved = { benefits: [{ text: { en: "Fast", ar: "" } }] };
    assert.deepEqual(applyContent(saved, typed, "undo"), { benefits: [{ text: { en: "", ar: "" } }] });
    assert.deepEqual(applyContent({ benefits: [{ text: { en: "", ar: "" } }] }, added, "undo"), { benefits: [] });
    assert.deepEqual(applyContent(saved, typed, "redo"), saved);
    // What a minted id did: the edit was filed under the row's id, which the save
    // then dropped — so Undo found no row and the editor reset its history.
    const filed = diffContent(
      "route-service-benefits",
      { benefits: [{ _id: "abcdefgh", text: { en: "", ar: "" } }] },
      { benefits: [{ _id: "abcdefgh", text: { en: "Fast", ar: "" } }] },
    );
    assert.equal(filed[0]!.path.itemId, "abcdefgh");
    assert.equal(applyContent(saved, filed, "undo"), null);
    // Named for what was done: words typed into a row are a change, not a reorder.
    const two = [{ text: { en: "One", ar: "" } }, { text: { en: "Two", ar: "" } }];
    const swapped = [two[1]!, two[0]!];
    const edited = [two[0]!, { text: { en: "Two, edited", ar: "" } }];
    const label = (after: unknown[]) =>
      describeContent("route-service-benefits", diffContent("route-service-benefits", { benefits: two }, { benefits: after }), { benefits: after }, "en");
    assert.equal(label(edited), "Change Benefits");
    assert.equal(label(swapped), "Reorder Benefits");
    assert.equal(label([...two, { text: { en: "", ar: "" } }]), "Add a row to Benefits");
    assert.equal(label([two[0]!]), "Remove a row from Benefits");
  });

  test("a list's key order is not a difference: a row read back from jsonb is the same row", () => {
    const written = [{ en: "One", ar: "واحد" }];
    const readBack = [{ ar: "واحد", en: "One" }];
    assert.equal(sameStored(written, readBack), true);
    const owner: RouteOwner = { type: "serviceBenefits", id: 40 };
    const live = serviceStoredValuesOf(owner, { ...DATA, service: serviceRow({ benefits: readBack as never }) }, null);
    // Live is read into the one shape, so a patch equal to it is no patch.
    assert.deepEqual(pendingPatch(owner, { benefits: { value: written, base: [] } }, live), {});
  });

  test("a stored value is checked again before publishing: a broken list is refused, a valid one is not", () => {
    const spec = specOf("serviceBenefits", "benefits")!;
    assert.equal(storedProblem(spec, [{ en: "A", ar: "" }], new Set(), media), null);
    assert.match(String(storedProblem(spec, [{ en: 4 }], new Set(), media)), /not a valid list/);
    assert.match(String(storedProblem(spec, "nope", new Set(), media)), /not a valid list/);
    assert.match(String(storedProblem(spec, Array.from({ length: 17 }, () => ({ en: "", ar: "" })), new Set(), media)), /not a valid list/);
  });

  test("the patch holds the changed fields with their starting point; a form edit since is a conflict", () => {
    const first = serviceNextPatch(hero, {}, live, { ...live, titleEn: "One" }, DATA);
    assert.deepEqual(first, { titleEn: { value: "One", base: "Made-up Service" } });
    const formEdit = { ...live, titleEn: "Changed on the Services screen" };
    assert.deepEqual(conflictsOf(hero, first, formEdit).map((conflict) => conflict.key), ["titleEn"]);
    assert.deepEqual(conflictsOf(hero, first, live), []);
  });

  test("a list reads as its entries in a summary or a comparison", () => {
    const spec = specOf("serviceBenefits", "benefits");
    const words = describeStored(spec, [{ en: "Fast", ar: "" }, { en: "", ar: "" }, { en: "", ar: "آمن" }], { group: () => null, member: () => null });
    assert.equal(words, "Fast · آمن");
  });

  test("an edit to a list is one step Undo can take back and Redo can put back", () => {
    const owner: RouteOwner = { type: "serviceBenefits", id: 40 };
    const before = valuesOf(owner.type, serviceStoredValuesOf(owner, DATA, null));
    const after = { ...before, benefits: [{ text: { en: "Fast", ar: "" } }] };
    const changes = diffContent("route-service-benefits", before, after);
    assert.equal(changes.length, 1);
    assert.deepEqual(applyContent(after, changes, "undo"), before);
    assert.deepEqual(applyContent(before, changes, "redo"), after);
  });

  test("direct editing writes one edition and never the other", () => {
    const values = valuesOf("serviceHero", live);
    const arabic = applyTextAt(values, "route-service-hero", "field:intro", "ar", "ما هي");
    assert.ok(arabic);
    assert.deepEqual(arabic.intro, { en: "What it is.", ar: "ما هي" });
    assert.equal(textAt(values, "route-service-hero", "field:intro", "ar"), "");
  });
});

describe("what a draft makes the page say", () => {
  test("several regions patch the one service row, each its own columns", () => {
    const patches = new Map<string, StoredPatch>([
      ["serviceHero:40", { titleEn: { value: "Draft title", base: "Made-up Service" } }],
      ["serviceOverview:40", { bodyEn: { value: "<p>Body</p>", base: "" } }],
      ["serviceBenefits:40", { benefits: { value: [{ en: "Fast", ar: "" }], base: [] } }],
    ]);
    const shown = effectiveServiceData(DATA, patches);
    assert.equal(shown.service.titleEn, "Draft title");
    assert.equal(shown.service.bodyEn, "<p>Body</p>");
    assert.deepEqual(shown.service.benefits, [{ en: "Fast", ar: "" }]);
    // Computing a draft never touches the live rows.
    assert.equal(DATA.service.titleEn, "Made-up Service");
  });

  test("reordering the service's questions moves only them; the category's keep their places", () => {
    assert.deepEqual(questionsOf(DATA).map((row) => row.id), [60, 50, 61, 51]);
    const patches = new Map<string, StoredPatch>([["serviceFaqs:40", { "order:faqs": { value: [51, 50], base: [50, 51] } }]]);
    const shown = effectiveServiceData(DATA, patches);
    assert.deepEqual(shown.faqs.map((row) => row.id), [51, 50]);
    assert.deepEqual(questionsOf(shown).map((row) => row.id), [60, 51, 61, 50]);
  });

  test("a section is shown when either edition has something; empty rows count as nothing", () => {
    const empty = { ...DATA, faqs: [], inherited: [] };
    for (const type of ["serviceOverview", "serviceBenefits", "serviceAudience", "serviceRequirements", "serviceProcess", "serviceNotes", "serviceFaqs"] as const) {
      assert.equal(serviceRegionVisible({ type, id: 40 }, empty), false, type);
    }
    const arabicOnly = { ...DATA, service: serviceRow({ bodyAr: "<p>نص</p>", benefits: [{ en: "", ar: "" }, { en: "", ar: "سريع" }] }) };
    assert.equal(serviceRegionVisible({ type: "serviceOverview", id: 40 }, arabicOnly), true);
    assert.equal(serviceRegionVisible({ type: "serviceBenefits", id: 40 }, arabicOnly), true);
    assert.equal(serviceRegionVisible({ type: "serviceBenefits", id: 40 }, { ...DATA, service: serviceRow({ benefits: [{ en: " ", ar: "" }] }) }), false);
    // The questions section is shown while any question is — the category's included.
    assert.equal(serviceRegionVisible({ type: "serviceFaqs", id: 40 }, { ...DATA, faqs: [] }), true);
    const hidden = effectiveServiceData(DATA, new Map([["faq:50", { isPublished: { value: false, base: true } }]]));
    assert.equal(serviceRegionVisible({ type: "faq", id: 50 }, hidden), false);
    assert.equal(serviceRegionVisible(hero, DATA), true);
  });
});

describe("no service and no category is special to the editor", () => {
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

  test("no seeded service or group slug appears anywhere in the editor's or the routes' sources", () => {
    const slugs = CATALOG.flatMap((category) =>
      category.subcategories.flatMap((group) => [group.slug, ...group.services.map((service) => slugify(service.title))]),
    );
    assert.ok(slugs.length > 70);
    const hits: string[] = [];
    for (const file of sources()) {
      const text = readFileSync(file, "utf8");
      for (const slug of slugs) {
        if (new RegExp(`["'\`/]${slug}["'\`/]`).test(text)) hits.push(`${path.relative(REPO, file)}: ${slug}`);
      }
    }
    assert.deepEqual(hits, []);
  });

  test("the service adapter decides nothing by a service's name, slug or category", () => {
    const model = readFileSync(path.join(REPO, "src/lib/routes/service-model.ts"), "utf8");
    assert.doesNotMatch(model, /\.slug\s*===|slug\s*==|titleEn\s*===|categoryId\s*===\s*\d/);
    // The region list is a constant of the template, not of any service.
    assert.equal(SERVICE_REGIONS.every((type) => isServiceRegion(type)), true);
  });
});
