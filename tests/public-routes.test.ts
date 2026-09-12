/**
 * The public site either side of the cutover, over HTTP, against the built
 * application.
 *
 * Two servers run at once — one on a pre-cutover database, one on a
 * restructured one — because the single most important property of this release
 * is that the *same build* is correct in both states. Shipping the code has to
 * be a non-event; only the cutover changes what a visitor sees.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { CATEGORY_MOVES, SERVICE_MOVES, categoryMove, serviceMove } from "../src/lib/taxonomy-moves";
import { giveLegacy, giveRestructured } from "./helpers/fixtures";
import { get } from "./helpers/http";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { startServer, type Server } from "./helpers/server";

const LEGACY_PORT = 3411;
const CUTOVER_PORT = 3412;
const EMPTY_PORT = 3413;

let legacyDb = "";
let cutoverDb = "";
let emptyDb = "";
let legacy: Server;
let cutover: Server;
/** A site where somebody has created a destination but not filled it yet. */
let emptyDestination: Server;
let legacySql: Sql;

/** Every English address the release retires. Built from the data, not typed out. */
let englishSources: string[] = [];

before(async () => {
  legacyDb = giveLegacy("routes_legacy");
  cutoverDb = giveRestructured("routes_cutover");
  emptyDb = giveRestructured("routes_empty");

  const emptySql = connect(emptyDb);
  await emptySql`update travel_packages set destination_id = null`;
  await emptySql.end({ timeout: 5 });

  legacySql = connect(legacyDb);
  [legacy, cutover, emptyDestination] = await Promise.all([
    startServer(legacyDb, LEGACY_PORT),
    startServer(cutoverDb, CUTOVER_PORT),
    startServer(emptyDb, EMPTY_PORT),
  ]);

  const moved = await legacySql<{ category: string; slug: string }[]>`
    select c.slug as category, s.slug
      from services s join service_categories c on c.id = s.category_id
     where c.slug in ${legacySql(Object.keys(CATEGORY_MOVES))}
     order by c.slug, s.slug
  `;
  englishSources = [
    ...Object.keys(CATEGORY_MOVES).map((slug) => `/services/${slug}`),
    ...moved.map((row) => `/services/${row.category}/${row.slug}`),
    ...Object.keys(SERVICE_MOVES).map((key) => `/services/${key}`),
  ];
});

after(async () => {
  await Promise.all([legacy?.stop(), cutover?.stop(), emptyDestination?.stop()]);
  await legacySql?.end({ timeout: 5 });
  for (const name of [legacyDb, cutoverDb, emptyDb]) if (name) dropDatabase(name);
});

/** Where an English source address should land. */
function expectedTarget(source: string): string {
  const parts = source.replace(/^\/services\//, "").split("/");
  const target = parts.length === 1 ? categoryMove(parts[0]!) : serviceMove(parts[0]!, parts[1]!);
  assert.ok(target, `no move is defined for ${source}`);
  return target;
}

describe("the accounting", () => {
  test("15 rules cover 33 English addresses, 66 with Arabic", () => {
    assert.equal(Object.keys(CATEGORY_MOVES).length + Object.keys(SERVICE_MOVES).length, 15);
    assert.equal(englishSources.length, 33);
    assert.equal(new Set(englishSources).size, 33, "no address is listed twice");
  });

  test("no target is itself a retired address, so nothing redirects twice", () => {
    for (const source of englishSources) {
      const target = expectedTarget(source);
      assert.notEqual(
        target,
        source,
        `${source} would redirect to itself`,
      );
      const asKey = target.replace(/^\/services\//, "");
      assert.ok(!(asKey in CATEGORY_MOVES), `${target} is itself a retired category`);
      assert.ok(!(asKey in SERVICE_MOVES), `${target} is itself a retired service address`);
    }
  });

  test("professional-tour-guide keeps its address rather than moving", () => {
    assert.ok(!("travel-tourism/professional-tour-guide" in SERVICE_MOVES));
  });
});

describe("before the cutover — shipping this release changes nothing", () => {
  test("every retired address still answers 200, in both languages", async () => {
    for (const source of englishSources) {
      for (const path of [source, `/ar${source}`]) {
        const page = await get(legacy.origin, path);
        assert.equal(page.status, 200, `${path} should still be a page, got ${page.status}`);
      }
    }
  });

  test("the new addresses are simply absent", async () => {
    for (const path of ["/services/iqama-services", "/packages/egypt", "/ar/packages/egypt"]) {
      assert.equal((await get(legacy.origin, path)).status, 404);
    }
  });

  test("the packages page falls back to the region grouping it always used", async () => {
    const page = await get(legacy.origin, "/packages");
    assert.equal(page.status, 200);
    assert.ok(!page.html.includes('href="/packages/egypt"'), "no destination exists yet");
    assert.ok(page.html.includes('href="/packages/cairo-and-giza-classic"'), "packages still list");
  });
});

describe("after the cutover — 66 addresses, one hop each", () => {
  test("every English address is a 308 to the right place, and the target is a page", async () => {
    for (const source of englishSources) {
      const target = expectedTarget(source);
      const page = await get(cutover.origin, source);
      assert.equal(page.status, 308, `${source} should be a permanent redirect`);
      assert.equal(page.location, target, `${source} landed at ${page.location}`);

      const landed = await get(cutover.origin, target);
      assert.equal(landed.status, 200, `${target} should answer 200, got ${landed.status}`);
    }
  });

  test("every Arabic address is a 308 to the Arabic target", async () => {
    for (const source of englishSources) {
      const target = expectedTarget(source);
      const page = await get(cutover.origin, `/ar${source}`);
      assert.equal(page.status, 308, `/ar${source} should be a permanent redirect`);
      assert.equal(page.location, `/ar${target}`, `/ar${source} landed at ${page.location}`);

      const landed = await get(cutover.origin, `/ar${target}`);
      assert.equal(landed.status, 200, `/ar${target} should answer 200, got ${landed.status}`);
    }
  });

  test("a redirect target never redirects again, and no address loops", async () => {
    for (const source of englishSources) {
      for (const path of [source, `/ar${source}`]) {
        let current = path;
        const seen = new Set<string>([current]);
        let hops = 0;
        for (;;) {
          const page = await get(cutover.origin, current);
          if (page.status < 300 || page.status >= 400) {
            assert.equal(page.status, 200, `${path} ended at ${page.status}`);
            break;
          }
          hops += 1;
          assert.ok(hops <= 1, `${path} redirected more than once`);
          const next = page.location!;
          assert.ok(!seen.has(next), `${path} loops back to ${next}`);
          seen.add(next);
          current = next;
        }
        assert.equal(hops, 1, `${path} should redirect exactly once`);
      }
    }
  });

  test("an address that never existed is still a 404, not a redirect", async () => {
    for (const path of ["/services/does-not-exist", "/services/travel-tourism/nope", "/ar/services/nope"]) {
      assert.equal((await get(cutover.origin, path)).status, 404, path);
    }
  });
});

describe("after the cutover — what the site shows", () => {
  test("five categories, and the renamed one is reachable by its new address", async () => {
    const page = await get(cutover.origin, "/services");
    assert.equal(page.status, 200);
    assert.ok(page.html.includes('href="/services/iqama-services"'));
    assert.ok(!page.html.includes('href="/services/general-services"'));
    assert.ok(!page.html.includes('href="/services/company-formation"'));
  });

  test("the menu offers Tour Packages, and its subcategory anchors resolve", async () => {
    const home = await get(cutover.origin, "/");
    assert.ok(home.html.includes('href="/packages"'));
    const category = await get(cutover.origin, "/services/travel-tourism");
    assert.ok(category.html.includes('id="travel-holiday"'));
    assert.ok(category.html.includes('id="visa-services"'));
  });

  test("no internal link points at an address that only answers with a redirect", async () => {
    const sql = connect(cutoverDb);
    try {
      const hrefs = new Set<string>();
      const nav = await sql<{ href: string }[]>`select href from navigation_items`;
      for (const row of nav) hrefs.add(row.href);
      const sections = await sql<{ text: string }[]>`
        select published::text as text from page_sections
      `;
      for (const row of sections) {
        for (const match of row.text.matchAll(/"(\/[a-z0-9/#-]*)"/g)) hrefs.add(match[1]!);
      }

      const offenders: string[] = [];
      for (const href of hrefs) {
        if (!href.startsWith("/services/") && !href.startsWith("/packages/")) continue;
        const page = await get(cutover.origin, href.split("#")[0]!);
        if (page.status !== 200) offenders.push(`${href} → ${page.status} ${page.location ?? ""}`);
      }
      assert.deepEqual(offenders, []);
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

describe("the packages page, in each of the four states it can be in", () => {
  test("A · no destinations at all — the legacy region grouping", async () => {
    const page = await get(legacy.origin, "/packages");
    assert.equal(page.status, 200);
    assert.ok(page.html.includes('href="/packages/custom-itinerary"'));
  });

  test("B · a destination exists but holds nothing — the grouping does not flip", async () => {
    const page = await get(emptyDestination.origin, "/packages");
    assert.equal(page.status, 200);
    assert.ok(
      !page.html.includes('href="/packages/egypt"'),
      "an empty destination must not become a group on the catalogue",
    );
    assert.ok(page.html.includes('href="/packages/cairo-and-giza-classic"'), "packages still list");
    // The destination page itself still answers — it is published, just empty.
    assert.equal((await get(emptyDestination.origin, "/packages/egypt")).status, 200);
  });

  test("C · destinations holding packages — grouped by destination", async () => {
    const page = await get(cutover.origin, "/packages");
    assert.equal(page.status, 200);
    assert.ok(page.html.includes('href="/packages/egypt"'), "Egypt should be offered as a group");
    assert.equal((await get(cutover.origin, "/packages/egypt")).status, 200);
  });

  test("D · a package in no destination is still offered", async () => {
    const page = await get(cutover.origin, "/packages");
    assert.ok(page.html.includes('href="/packages/custom-itinerary"'));
    assert.equal((await get(cutover.origin, "/packages/custom-itinerary")).status, 200);
  });

  test("every package address that existed before the cutover still works", async () => {
    for (const slug of [
      "cairo-and-giza-classic",
      "nile-cruise-luxor-aswan",
      "red-sea-sharm-el-sheikh",
      "egypt-family-programme",
      "custom-itinerary",
    ]) {
      assert.equal((await get(cutover.origin, `/packages/${slug}`)).status, 200, slug);
      assert.equal((await get(cutover.origin, `/ar/packages/${slug}`)).status, 200, slug);
    }
  });
});

/**
 * A smoke check on the markup, not a rendered-viewport check: what it can prove
 * is that the new pages declare the viewport, stack their grids at small widths
 * and carry no fixed pixel width. Anything finer than that needs a browser.
 */
describe("the new pages are built to the same responsive rules as the old ones", () => {
  const PAGES = ["/packages", "/packages/egypt", "/services/iqama-services", "/services/travel-tourism"];

  test("each declares the viewport and sets its direction", async () => {
    for (const path of PAGES) {
      const page = await get(cutover.origin, path);
      assert.equal(page.status, 200, path);
      assert.match(page.html, /name="viewport" content="width=device-width/, path);
      assert.match(page.html, /<html lang="en" dir="ltr"/, path);
      const arabic = await get(cutover.origin, `/ar${path}`);
      assert.match(arabic.html, /<html lang="ar" dir="rtl"/, `/ar${path}`);
    }
  });

  test("the destination grid starts at one column and grows", async () => {
    const page = await get(cutover.origin, "/packages/egypt");
    assert.match(page.html, /grid gap-5 sm:grid-cols-2 lg:grid-cols-3/);
  });

  test("nothing on them is pinned to a pixel width", async () => {
    for (const path of PAGES) {
      const page = await get(cutover.origin, path);
      const fixed = [...page.html.matchAll(/style="[^"]*\bwidth:\s*\d{3,}px/g)].map((m) => m[0]);
      assert.deepEqual(fixed, [], `${path} should not pin a width`);
      assert.ok(!/min-width:\s*\d{3,}px/.test(page.html), `${path} should not set a min-width`);
    }
  });
});
