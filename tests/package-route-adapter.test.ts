/**
 * Batch 24 · the package routes' pure parts: a package's page, a destination's
 * page, the catalogue `/packages` and the services overview `/services`.
 *
 * What these hold without a database: every region is a registered route block
 * the page CMS cannot see; identity is the record's id, through owner keys,
 * editor keys and route keys that round-trip and refuse what they do not name;
 * the Packages and Destinations screens' limits are the editor's; nothing that
 * is identity or ordering is a field; the catalogue's one grouping rule
 * (`groupCatalogue`) and what each region shows; the category page's ItemList
 * lists only the cards it draws (A.9 F4); the five live-data page blocks say
 * where their cards come from (F7); and nothing in the editor or the route
 * sources names a seeded package or destination.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { BLOCKS, blocksForPage, getBlock, getEditorBlock } from "@/lib/cms/blocks";
import { ROUTE_BLOCK_OF, ROUTE_LIST_OF, ROUTE_STRUCTURAL_FIELDS } from "@/lib/routes/blocks";
import {
  catalogueOptions,
  catalogueOwnerBelongs,
  catalogueOwnersOf,
  catalogueRegionVisible,
  catalogueStoredValuesOf,
  effectiveCatalogueData,
  groupCatalogue,
  type CatalogueData,
} from "@/lib/routes/catalogue-model";
import { listedServices, serviceLayout, type CategoryData } from "@/lib/routes/category-model";
import {
  destinationAdminHrefOf,
  destinationOwnerBelongs,
  destinationOwnersOf,
  destinationStoredValuesOf,
  DESTINATION_REGIONS,
  effectiveDestinationData,
  type DestinationData,
} from "@/lib/routes/destination-model";
import {
  documentEditorKey,
  documentOfEditorKey,
  editorKeyOf,
  ownerKeyOf,
  parseOwnerKey,
  parseRouteKey,
  routeKeyOf,
  type RouteOwner,
  type RouteOwnerType,
} from "@/lib/routes/owners";
import {
  effectivePackageData,
  packageAdminHrefOf,
  packageOwnerBelongs,
  packageOwnersOf,
  packageRegionVisible,
  packageStoredValuesOf,
  PACKAGE_REGIONS,
  type DestinationRow,
  type PackageData,
  type PackageRow,
} from "@/lib/routes/package-model";
import { SERVICE_INDEX_REGIONS, serviceIndexOwnerBelongs, serviceIndexOwnersOf } from "@/lib/routes/service-index-model";
import {
  domainPermissionOf,
  publishedValue,
  readSubmittedWith,
  resourceOf,
  SPECS,
  specOf,
  valuesOf,
  type StoredPatch,
} from "@/lib/routes/specs";
import { ROUTE_KIND_TEXT } from "@/lib/visual-editor/route-kinds";
import { directEditAt, layerKindOf } from "@/lib/visual-editor/tree";

const REPO = path.resolve(import.meta.dirname, "..");
const at = new Date("2026-01-01T00:00:00Z");

/* -------------------------------------------------------------------------- */
/* Records made up for the test — never the seed's                            */
/* -------------------------------------------------------------------------- */

function pkg(over: Partial<PackageRow> = {}): PackageRow {
  return {
    id: 501,
    slug: "a-package-made-up-for-the-test",
    region: "international",
    destinationId: null,
    titleEn: "Made-up Package",
    titleAr: "برنامج",
    destinationEn: "Somewhere",
    destinationAr: "",
    durationEn: "4 nights",
    durationAr: "",
    summaryEn: "A short summary.",
    summaryAr: "",
    bodyEn: "",
    bodyAr: "",
    highlights: [],
    imageId: null,
    isFeatured: false,
    isPublished: true,
    sortOrder: 0,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

function destination(over: Partial<DestinationRow> = {}): DestinationRow {
  return {
    id: 71,
    slug: "a-destination-made-up-for-the-test",
    titleEn: "Made-up Destination",
    titleAr: "وجهة",
    summaryEn: "",
    summaryAr: "",
    imageId: null,
    sortOrder: 0,
    isPublished: true,
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

const patches = (entries: Record<string, StoredPatch>): ReadonlyMap<string, StoredPatch> => new Map(Object.entries(entries));
const media = new Set([7]);

/* ========================================================================== */

describe("the registry: route blocks the page CMS cannot see", () => {
  const NEW_TYPES: RouteOwnerType[] = [
    ...PACKAGE_REGIONS,
    ...DESTINATION_REGIONS,
    "packageIndexHero",
    "packageIndexCrumbs",
    "packageIndexCatalogue",
    "destinationGroup",
    "packageCard",
    "packageIndexCustom",
    ...SERVICE_INDEX_REGIONS,
  ];

  test("every new region is drawn as a registered route block, editor-only", () => {
    assert.equal(NEW_TYPES.length, 17);
    for (const type of NEW_TYPES) {
      const blockType = ROUTE_BLOCK_OF[type];
      const block = getEditorBlock(blockType);
      assert.ok(block, type);
      assert.equal(getBlock(blockType), undefined, `${blockType} is not a page block`);
      assert.ok(!BLOCKS.includes(block));
      for (const slug of ["home", "about"]) assert.ok(!blocksForPage(slug).some((offered) => offered.type === blockType));
    }
    // A package's card is hidden or shown, never reordered here: its order is the Packages screen's.
    assert.equal(ROUTE_LIST_OF["route-package-card"], undefined);
  });

  test("owner codes are new and append-only: every owner key round-trips through its editor key", () => {
    const seen = new Set<number>();
    for (const type of Object.keys(ROUTE_BLOCK_OF) as RouteOwnerType[]) {
      const owner: RouteOwner = { type, id: 12345 };
      const key = editorKeyOf(owner);
      assert.ok(key < 0, type);
      assert.equal(seen.has(key), false, `${type} shares a code`);
      seen.add(key);
      assert.deepEqual(parseOwnerKey(ownerKeyOf(owner)), owner);
    }
  });

  test("route keys: the four kinds parse, the overviews are singletons, a slug is never a key", () => {
    assert.deepEqual(parseRouteKey("package:501"), { kind: "package", id: 501 });
    assert.deepEqual(parseRouteKey("destination:71"), { kind: "destination", id: 71 });
    assert.deepEqual(parseRouteKey("packageIndex:1"), { kind: "packageIndex", id: 1 });
    assert.deepEqual(parseRouteKey("serviceIndex:1"), { kind: "serviceIndex", id: 1 });
    for (const bad of ["packageIndex:2", "serviceIndex:7", "package:0", "package:egypt", "destination:-1", "package:1/x", "packages:1"]) {
      assert.equal(parseRouteKey(bad), null, bad);
    }
    for (const document of [
      { kind: "package", id: 501 },
      { kind: "destination", id: 71 },
      { kind: "packageIndex", id: 1 },
      { kind: "serviceIndex", id: 1 },
    ] as const) {
      assert.deepEqual(documentOfEditorKey(documentEditorKey(document)), document);
      assert.equal(routeKeyOf(document), `${document.kind}:${document.id}`);
    }
  });

  test("the editor says what each kind of page is, in one table", () => {
    for (const kind of ["category", "service", "package", "destination", "packageIndex", "serviceIndex"] as const) {
      const text = ROUTE_KIND_TEXT[kind];
      assert.ok(text.noun && text.heading && text.structureNote && text.publishNote, kind);
    }
  });
});

describe("what may be stored: the Packages and Destinations screens' rules", () => {
  test("their limits are the editor's", () => {
    assert.deepEqual(
      { max: specOf("packageHero", "titleEn")?.max, required: specOf("packageHero", "titleEn")?.required },
      { max: 190, required: true },
    );
    assert.equal(specOf("packageHero", "destinationEn")?.max, 120);
    assert.equal(specOf("packageHero", "durationEn")?.max, 80);
    assert.equal(specOf("packageHero", "summaryEn")?.max, 2000);
    assert.equal(specOf("packageBody", "bodyEn")?.max, 20000);
    assert.deepEqual(
      { max: specOf("packageHighlights", "highlights")?.max, rows: specOf("packageHighlights", "highlights")?.rows },
      { max: 300, rows: 16 },
    );
    assert.equal(specOf("packageCard", "titleEn")?.required, true);
    assert.equal(specOf("destinationHero", "titleEn")?.required, true);
    assert.equal(specOf("destinationHero", "summaryEn")?.max, 2000);
    assert.equal(specOf("destinationGroup", "titleEn")?.max, 190);
  });

  test("identity and order are never fields: no slug, legacy region, sort order or id anywhere", () => {
    const types = Object.keys(ROUTE_BLOCK_OF).filter((type) => !["category", "categoryCrumbs", "categoryBody", "categoryServices", "subcategory", "service", "categoryHub", "categoryFaqs", "faq"].includes(type) && !type.startsWith("service")) as RouteOwnerType[];
    const keys = types.flatMap((type) => SPECS[type].map((spec) => spec.key));
    for (const system of ["slug", "region", "sortOrder", "id"]) assert.equal(keys.includes(system), false, system);
    // The only structure the new pages offer is a package card's: its destination and whether it is shown.
    const structural = types.flatMap((type) => SPECS[type].filter((spec) => spec.structural).map((spec) => `${type}.${spec.key}`));
    assert.deepEqual(structural.sort(), ["packageCard.destinationId", "packageCard.isPublished"]);
    assert.ok(ROUTE_STRUCTURAL_FIELDS.has("group") && ROUTE_STRUCTURAL_FIELDS.has("published"));
  });

  test("which record each region writes, and the capability it takes", () => {
    for (const type of ["packageHero", "packageBody", "packageHighlights", "packageCard"] as const) {
      assert.deepEqual(resourceOf({ type, id: 501 }), { kind: "package", id: 501 }, type);
    }
    for (const type of ["destinationHero", "destinationGroup"] as const) {
      assert.deepEqual(resourceOf({ type, id: 71 }), { kind: "destination", id: 71 }, type);
    }
    for (const type of ["packageRequest", "packageIndexHero", "packageIndexCustom", "serviceIndexHero", "destinationPackages"] as const) {
      assert.equal(resourceOf({ type, id: 1 }).kind, "template", type);
    }
    for (const type of [...PACKAGE_REGIONS, ...DESTINATION_REGIONS, "packageIndexHero", "packageIndexCrumbs", "packageIndexCatalogue", "destinationGroup", "packageCard", "packageIndexCustom"] as const) {
      assert.equal(domainPermissionOf(type), "packages.manage", type);
    }
    for (const type of SERVICE_INDEX_REGIONS) assert.equal(domainPermissionOf(type), "services.manage", type);
    assert.equal(domainPermissionOf("faq"), "faqs.manage");
    assert.equal(domainPermissionOf("service"), "services.manage");
  });

  test("the Inspector's values read back with the screen's rules; Arabic is never seeded from English", () => {
    const owner: RouteOwner = { type: "packageHero", id: 501 };
    const live = packageStoredValuesOf(owner, { pkg: pkg() }, null);
    const values = valuesOf("packageHero", live);
    assert.deepEqual(values.title, { en: "Made-up Package", ar: "برنامج" });
    assert.deepEqual(values.place, { en: "Somewhere", ar: "" });
    const read = readSubmittedWith(
      owner,
      { ...values, title: { en: "  New title  ", ar: "عنوان" }, duration: { en: "x".repeat(200), ar: "" }, image: 7 },
      { mediaIds: media, groupIds: new Set() },
    );
    assert.ok(read.ok);
    assert.equal(read.stored.titleEn, "New title");
    assert.equal(String(read.stored.durationEn).length, 80);
    assert.equal(read.stored.destinationAr, "");
    assert.equal(read.stored.imageId, 7);
    const empty = readSubmittedWith(owner, { ...values, title: { en: "", ar: "عنوان" } }, { mediaIds: media, groupIds: new Set() });
    assert.equal(empty.ok, false);
    const missing = readSubmittedWith(owner, { ...values, image: 8 }, { mediaIds: media, groupIds: new Set() });
    assert.equal(missing.ok, false);
    assert.match(missing.ok ? "" : missing.problem.message, /media library/);
  });

  test("anything not declared is ignored, whatever is sent — a slug, a region, an order, a sort position", () => {
    const owner: RouteOwner = { type: "packageCard", id: 501 };
    const data: CatalogueData = { destinations: [destination()], packages: [pkg()] };
    const values = valuesOf("packageCard", catalogueStoredValuesOf(owner, data, null));
    const read = readSubmittedWith(
      owner,
      { ...values, slug: "hijack", region: "egypt", sortOrder: 99, id: 1, link: "https://evil.example" },
      { mediaIds: media, groupIds: new Set([71]) },
    );
    assert.ok(read.ok);
    assert.deepEqual(Object.keys(read.stored).sort(), SPECS.packageCard.map((spec) => spec.key).sort());
    assert.equal(JSON.stringify(read.stored).includes("hijack"), false);
    assert.equal(JSON.stringify(read.stored).includes("evil"), false);
  });

  test("a card may be filed under any destination that exists — and only one that exists", () => {
    const owner: RouteOwner = { type: "packageCard", id: 501 };
    const data: CatalogueData = { destinations: [destination(), destination({ id: 72, isPublished: false })], packages: [pkg()] };
    const values = valuesOf("packageCard", catalogueStoredValuesOf(owner, data, null));
    const filed = readSubmittedWith(owner, { ...values, group: "72" }, { mediaIds: media, groupIds: new Set([71, 72]) });
    assert.ok(filed.ok);
    assert.equal(filed.stored.destinationId, 72);
    const gone = readSubmittedWith(owner, { ...values, group: "99" }, { mediaIds: media, groupIds: new Set([71, 72]) });
    assert.equal(gone.ok, false);
    assert.match(gone.ok ? "" : gone.problem.message, /destinations/);
    const options = catalogueOptions(owner, data).group!;
    assert.deepEqual(options.map((option) => option.value), ["", "71", "72"]);
    assert.match(options[2]!.label, /not published/);
  });

  test("the highlights publish as the Packages screen stores them: no empty rows", () => {
    const spec = specOf("packageHighlights", "highlights");
    assert.deepEqual(publishedValue(spec, [{ en: "One", ar: "" }, { en: " ", ar: "" }, { en: "", ar: "اثنان" }]), [
      { en: "One", ar: "" },
      { en: "", ar: "اثنان" },
    ]);
  });
});

describe("identity: the record's id, never its address", () => {
  test("a package's page draws five regions, all its own; another package's is refused", () => {
    const data: PackageData = { pkg: pkg() };
    const owners = packageOwnersOf(data);
    assert.deepEqual(owners.map((owner) => owner.type), [...PACKAGE_REGIONS]);
    assert.ok(owners.every((owner) => owner.id === 501));
    assert.equal(packageOwnerBelongs({ type: "packageHero", id: 502 }, data), false);
    assert.equal(packageOwnerBelongs({ type: "packageCard", id: 501 }, data), false, "the card is the catalogue's");
    assert.equal(packageOwnerBelongs({ type: "destinationHero", id: 501 }, data), false);
  });

  test("a rename or a new address changes no key", () => {
    const before = packageOwnersOf({ pkg: pkg() }).map(ownerKeyOf);
    const after = packageOwnersOf({ pkg: pkg({ titleEn: "Renamed", slug: "another-address", destinationId: 71 }) }).map(ownerKeyOf);
    assert.deepEqual(after, before);
    const destinationBefore = destinationOwnersOf({ destination: destination(), packages: [] }).map(ownerKeyOf);
    const destinationAfter = destinationOwnersOf({ destination: destination({ slug: "moved-address", titleEn: "Renamed" }), packages: [] }).map(ownerKeyOf);
    assert.deepEqual(destinationAfter, destinationBefore);
  });

  test("a destination's page owns its hero, crumbs and listing; its packages' cards are the catalogue's", () => {
    const data: DestinationData = { destination: destination(), packages: [pkg({ destinationId: 71 })] };
    assert.deepEqual(destinationOwnersOf(data).map((owner) => owner.type), [...DESTINATION_REGIONS]);
    assert.equal(destinationOwnerBelongs({ type: "packageCard", id: 501 }, data), false);
    assert.equal(destinationOwnerBelongs({ type: "destinationGroup", id: 71 }, data), false, "the group is the catalogue's");
    assert.equal(destinationAdminHrefOf({ type: "destinationHero", id: 71 }, data), "/admin/packages/destinations/71");
  });

  test("the catalogue owns its own four regions, a group per published destination and a card per package", () => {
    const data: CatalogueData = {
      destinations: [destination(), destination({ id: 72, isPublished: false })],
      packages: [pkg(), pkg({ id: 502, isPublished: false, destinationId: 72 })],
    };
    const owners = catalogueOwnersOf(data).map(ownerKeyOf);
    for (const key of ["packageIndexHero:1", "packageIndexCrumbs:1", "packageIndexCatalogue:1", "packageIndexCustom:1", "destinationGroup:71", "packageCard:501", "packageCard:502"]) {
      assert.ok(owners.includes(key), key);
    }
    assert.equal(owners.includes("destinationGroup:72"), false, "an unpublished destination draws no group");
    assert.equal(catalogueOwnerBelongs({ type: "destinationGroup", id: 72 }, data), false);
    assert.equal(catalogueOwnerBelongs({ type: "packageCard", id: 999 }, data), false);
    assert.equal(catalogueOwnerBelongs({ type: "packageIndexHero", id: 2 }, data), false);
    assert.equal(catalogueOwnerBelongs({ type: "packageHero", id: 501 }, data), false, "the package's own page is its own");
  });

  test("the services overview owns its three regions and nothing else", () => {
    assert.deepEqual(serviceIndexOwnersOf().map(ownerKeyOf), ["serviceIndexHero:1", "serviceIndexCrumbs:1", "serviceIndexCategories:1"]);
    assert.equal(serviceIndexOwnerBelongs({ type: "serviceIndexHero", id: 2 }), false);
    assert.equal(serviceIndexOwnerBelongs({ type: "category", id: 1 }), false);
  });

  test("a package created after the build is a document like any other — nothing to register", () => {
    const tomorrow = pkg({ id: 9_999, slug: "made-tomorrow", titleEn: "Made tomorrow" });
    const owners = packageOwnersOf({ pkg: tomorrow });
    assert.equal(owners.length, PACKAGE_REGIONS.length);
    assert.ok(owners.every((owner) => packageOwnerBelongs(owner, { pkg: tomorrow })));
    assert.equal(parseRouteKey(`package:${tomorrow.id}`)?.id, 9_999);
  });
});

describe("the catalogue's one grouping rule", () => {
  const egypt = destination({ id: 71, sortOrder: 1 });
  const nepal = destination({ id: 72, sortOrder: 0, slug: "made-up-two", titleEn: "Two" });
  const hidden = destination({ id: 73, isPublished: false, slug: "made-up-three" });

  test("a published destination holding a published package is a group; every other published package is 'build your own'", () => {
    const layout = groupCatalogue(
      [egypt, nepal, hidden],
      [
        pkg({ id: 1, destinationId: 71 }),
        pkg({ id: 2, destinationId: 71, isFeatured: true, sortOrder: 5 }),
        pkg({ id: 3, destinationId: 73 }),
        pkg({ id: 4, destinationId: null }),
        pkg({ id: 5, destinationId: 72, isPublished: false }),
      ],
    );
    assert.deepEqual(layout.grouped.map((group) => [group.destination.id, group.packages.map((row) => row.id)]), [[71, [2, 1]]]);
    assert.deepEqual(layout.ungrouped.map((row) => row.id), [3, 4], "an unpublished destination never hides its packages");
    assert.equal(layout.destinationMode, true);
  });

  test("with no group at all the catalogue keeps its legacy grouping", () => {
    const layout = groupCatalogue([egypt], [pkg({ id: 1, destinationId: null }), pkg({ id: 2, destinationId: 71, isPublished: false })]);
    assert.equal(layout.destinationMode, false);
    assert.deepEqual(layout.packages.map((row) => row.id), [1]);
  });

  test("the canvas draws every package where it is filed; a hidden one is marked, not dropped", () => {
    const data: CatalogueData = { destinations: [egypt], packages: [pkg({ id: 1, destinationId: 71 }), pkg({ id: 2, destinationId: 71, isPublished: false })] };
    const drawn = groupCatalogue(data.destinations, data.packages, () => true);
    assert.deepEqual(drawn.grouped[0]!.packages.map((row) => row.id).sort(), [1, 2]);
    assert.equal(catalogueRegionVisible({ type: "packageCard", id: 2 }, data), false);
    assert.equal(catalogueRegionVisible({ type: "packageCard", id: 1 }, data), true);
    assert.equal(catalogueRegionVisible({ type: "destinationGroup", id: 71 }, data), true);
    assert.equal(catalogueRegionVisible({ type: "packageIndexCustom", id: 1 }, data), false, "nothing is ungrouped");
  });

  test("a group with only hidden packages is hidden once published; 'build your own' shows while it holds one", () => {
    const data: CatalogueData = {
      destinations: [egypt],
      packages: [pkg({ id: 1, destinationId: 71, isPublished: false }), pkg({ id: 2, destinationId: null }), pkg({ id: 3, destinationId: 72 })],
    };
    // No published package in a published destination: legacy mode, so neither the group nor "build your own".
    assert.equal(catalogueRegionVisible({ type: "destinationGroup", id: 71 }, data), false);
    assert.equal(catalogueRegionVisible({ type: "packageIndexCustom", id: 1 }, data), false);
    const grouped: CatalogueData = { ...data, packages: [...data.packages, pkg({ id: 4, destinationId: 71 })] };
    assert.equal(catalogueRegionVisible({ type: "packageIndexCustom", id: 1 }, grouped), true);
  });

  test("a draft that re-files or hides a card moves it in the effective data, and nowhere else", () => {
    const data: CatalogueData = { destinations: [egypt, nepal], packages: [pkg({ id: 1, destinationId: 71 }), pkg({ id: 2, destinationId: 71 })] };
    const effective = effectiveCatalogueData(
      data,
      patches({
        "packageCard:1": { destinationId: { value: 72, base: 71 } },
        "packageCard:2": { isPublished: { value: false, base: true }, titleEn: { value: "Draft title", base: "Made-up Package" } },
        "destinationGroup:72": { titleEn: { value: "Renamed group", base: "Two" } },
      }),
    );
    assert.equal(effective.packages.find((row) => row.id === 1)!.destinationId, 72);
    assert.equal(effective.packages.find((row) => row.id === 2)!.isPublished, false);
    assert.equal(effective.packages.find((row) => row.id === 2)!.titleEn, "Draft title");
    assert.equal(effective.destinations.find((row) => row.id === 72)!.titleEn, "Renamed group");
    assert.equal(data.packages[0]!.destinationId, 71, "the live rows are untouched");
    const layout = groupCatalogue(effective.destinations, effective.packages);
    assert.deepEqual(layout.grouped.map((group) => group.destination.id), [72]);
  });
});

describe("a package's and a destination's own pages", () => {
  test("drafts are laid over the row; template copy is not a column", () => {
    const data: PackageData = { pkg: pkg() };
    const effective = effectivePackageData(
      data,
      patches({
        "packageHero:501": { titleEn: { value: "Draft", base: "Made-up Package" } },
        "packageBody:501": { bodyEn: { value: "<p>Body</p>", base: "" } },
        "packageHighlights:501": { highlights: { value: [{ en: "One", ar: "" }], base: [] }, "copy:headingEn": { value: "Included", base: "" } },
        "packageRequest:501": { "copy:headingEn": { value: "Ask us", base: "" } },
      }),
    );
    assert.equal(effective.pkg.titleEn, "Draft");
    assert.equal(effective.pkg.bodyEn, "<p>Body</p>");
    assert.deepEqual(effective.pkg.highlights, [{ en: "One", ar: "" }]);
    assert.equal("copy:headingEn" in (effective.pkg as Record<string, unknown>), false);
    assert.equal(data.pkg.titleEn, "Made-up Package");
  });

  test("the description and the highlights are on the page only when either edition has something", () => {
    assert.equal(packageRegionVisible({ type: "packageBody", id: 501 }, { pkg: pkg() }), false);
    assert.equal(packageRegionVisible({ type: "packageBody", id: 501 }, { pkg: pkg({ bodyAr: "<p>نص</p>" }) }), true);
    assert.equal(packageRegionVisible({ type: "packageHighlights", id: 501 }, { pkg: pkg({ highlights: [{ en: " ", ar: "" }] }) }), false);
    assert.equal(packageRegionVisible({ type: "packageHighlights", id: 501 }, { pkg: pkg({ highlights: [{ en: "One", ar: "" }] }) }), true);
    assert.equal(packageRegionVisible({ type: "packageHero", id: 501 }, { pkg: pkg() }), true);
  });

  test("the request form's and the crumbs' admin links: the package's screen, and none", () => {
    const data: PackageData = { pkg: pkg() };
    assert.equal(packageAdminHrefOf({ type: "packageHero", id: 501 }, data), "/admin/packages/501");
    assert.equal(packageAdminHrefOf({ type: "packageCrumbs", id: 501 }, data), null);
  });

  test("a destination's hero draft is its row's; its listing is the published packages it was given", () => {
    const data: DestinationData = { destination: destination(), packages: [pkg({ destinationId: 71 })] };
    const effective = effectiveDestinationData(data, patches({ "destinationHero:71": { summaryEn: { value: "Draft summary", base: "" } } }));
    assert.equal(effective.destination.summaryEn, "Draft summary");
    assert.equal(effective.packages, data.packages);
    const stored = destinationStoredValuesOf({ type: "destinationHero", id: 71 }, data, { eyebrowEn: "Custom" });
    assert.equal(stored["copy:eyebrowEn"], "Custom");
    assert.equal(stored.titleEn, "Made-up Destination");
  });
});

describe("the editor's canvas vocabulary for the new regions", () => {
  test("text is typed into on the canvas; generated parts, lists and rich text are not", () => {
    for (const [block, pathName] of [
      ["route-package-hero", "field:title"],
      ["route-package-hero", "field:place"],
      ["route-package-hero", "field:ctaLabel"],
      ["route-package-card", "field:title"],
      ["route-destination-group", "field:title"],
      ["route-package-index-hero", "field:heading"],
      ["route-service-index-hero", "field:eyebrow"],
      ["route-destination-hero", "field:title"],
    ] as const) {
      assert.ok(directEditAt(block, pathName), `${block} ${pathName}`);
    }
    for (const [block, pathName] of [
      ["route-package-hero", "field:eyebrow"],
      ["route-package-hero", "field:whatsapp"],
      ["route-package-card", "field:action"],
      ["route-package-card", "field:link"],
      ["route-package-body", "field:body"],
      ["route-package-highlights", "field:highlights"],
      ["route-destination-packages", "field:cards"],
      ["route-package-index-catalogue", "field:regions"],
      ["route-service-index-categories", "field:categories"],
      ["route-package-crumbs", "field:trail"],
    ] as const) {
      assert.equal(directEditAt(block, pathName), null, `${block} ${pathName}`);
    }
    assert.equal(layerKindOf("route-package-highlights", "field:highlights"), "list");
    assert.equal(layerKindOf("route-package-hero", "field:image"), "media");
  });
});

describe("the category page's ItemList lists only what the page draws (A.9 F4)", () => {
  const category = { id: 3 } as CategoryData["category"];
  const group = (id: number, isPublished: boolean) => ({ id, categoryId: 3, isPublished }) as CategoryData["groups"][number];
  const service = (id: number, subcategoryId: number | null, over: Partial<CategoryData["services"][number]> = {}) =>
    ({ id, categoryId: 3, subcategoryId, isPublished: true, isFeatured: false, sortOrder: id, ...over }) as CategoryData["services"][number];

  test("a published service filed under a hidden group is drawn nowhere, so it is not listed", () => {
    // A visitor's data: the hidden group is not among the groups at all.
    const data = { category, groups: [group(10, true)], services: [service(1, 10), service(2, 11), service(3, null)], faqs: [] };
    const layout = serviceLayout(data);
    assert.deepEqual(layout.grouped.flatMap((entry) => entry.rows.map((row) => row.id)), [1]);
    assert.deepEqual(layout.ungrouped.map((row) => row.id), [3]);
    assert.deepEqual(listedServices(data, new Set()).map((row) => row.id), [1, 3]);
  });

  test("in the canvas the hidden ones are drawn dimmed and still not listed", () => {
    const data = {
      category,
      groups: [group(10, true), group(11, false)],
      services: [service(1, 10), service(2, 11), service(3, null, { isPublished: false })],
      faqs: [],
    };
    assert.deepEqual(listedServices(data, new Set(["service:2", "service:3"])).map((row) => row.id), [1]);
  });

  test("the list keeps the services' own order, featured or not", () => {
    const data = { category, groups: [group(10, true)], services: [service(1, 10), service(2, 10, { isFeatured: true })], faqs: [] };
    assert.deepEqual(serviceLayout(data).grouped[0]!.rows.map((row) => row.id), [2, 1]);
    assert.deepEqual(listedServices(data, new Set()).map((row) => row.id), [1, 2]);
  });
});

describe("page blocks drawn from other screens say so (A.9 F7)", () => {
  test("the five live-data blocks name their source screen; the others carry no such note", () => {
    const live = BLOCKS.filter((block) => block.live).map((block) => block.type).sort();
    assert.deepEqual(live, ["faq", "packages-grid", "service-grid", "testimonials", "video-showcase"]);
    for (const block of BLOCKS.filter((entry) => entry.live)) {
      assert.match(block.live!.source.href, /^\/admin\/[a-z/]+$/, block.type);
      assert.ok(block.live!.explain.length > 40, block.type);
    }
  });
});

describe("nothing in the editor or the route sources names a seeded package or destination", () => {
  /**
   * The slugs the seed creates — read from the seed itself, so a record added
   * to it later is covered without editing this test.
   */
  const seed = readFileSync(path.join(REPO, "scripts", "seed.ts"), "utf8");
  const between = (from: string, to: string) => seed.slice(seed.indexOf(from), seed.indexOf(to, seed.indexOf(from)));
  const slugsIn = (source: string) => [...new Set([...source.matchAll(/slug:\s*"([a-z0-9-]+)"/g)].map((match) => match[1]!))];
  const packageSlugs = slugsIn(between("const PACKAGES = [", "const DESTINATIONS = ["));
  const destinationSlugs = slugsIn(between("const DESTINATIONS = [", "/** Which destination"));

  const filesUnder = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? filesUnder(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
    });
  /** A slug used as an address or a value — quoted or between slashes — not a word in a sentence. */
  const names = (text: string, slug: string) => new RegExp(`["'\`/]${slug}["'\`/]`).test(text);

  test("the seed was read: five packages and one destination", () => {
    assert.ok(packageSlugs.length >= 5, packageSlugs.join(", "));
    assert.ok(destinationSlugs.length >= 1, destinationSlugs.join(", "));
  });

  test("the editor and the route code name no seeded package or destination", () => {
    const sources = [
      ...filesUnder(path.join(REPO, "src", "lib", "routes")),
      ...filesUnder(path.join(REPO, "src", "lib", "visual-editor")),
      ...filesUnder(path.join(REPO, "src", "components", "admin", "visual-editor")),
      ...filesUnder(path.join(REPO, "src", "app", "(backoffice)", "admin", "visual-editor")),
    ];
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      for (const slug of [...packageSlugs, ...destinationSlugs]) {
        assert.equal(names(text, slug), false, `${path.relative(REPO, file)} names ${slug}`);
      }
    }
  });

  test("the four public templates and the package forms name no seeded package", () => {
    // `egypt` is also a value of the legacy `region` column, which the
    // catalogue's legacy grouping and the form's reader still know by name —
    // a region, not a destination — so destinations are held to the editor's
    // sources above and packages to these as well.
    for (const file of [
      path.join(REPO, "src", "app", "(public)", "[lang]", "packages", "page.tsx"),
      path.join(REPO, "src", "app", "(public)", "[lang]", "packages", "[slug]", "page.tsx"),
      path.join(REPO, "src", "app", "(public)", "[lang]", "services", "page.tsx"),
      path.join(REPO, "src", "components", "site", "destination-view.tsx"),
      path.join(REPO, "src", "components", "site", "package-card.tsx"),
      path.join(REPO, "src", "lib", "packages", "form-fields.ts"),
    ]) {
      const text = readFileSync(file, "utf8");
      for (const slug of packageSlugs) assert.equal(names(text, slug), false, `${path.relative(REPO, file)} names ${slug}`);
    }
  });
});
