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
const HIDDEN_PORT = 3414;

let legacyDb = "";
let cutoverDb = "";
let emptyDb = "";
let hiddenDb = "";
let legacy: Server;
let cutover: Server;
/** A site where somebody has created a destination but not filled it yet. */
let emptyDestination: Server;
/** A site with a published package filed under an unpublished destination. */
let hiddenDestination: Server;
let legacySql: Sql;

/** Every English address the release retires. Built from the data, not typed out. */
let englishSources: string[] = [];

before(async () => {
  legacyDb = giveLegacy("routes_legacy");
  cutoverDb = giveRestructured("routes_cutover");
  emptyDb = giveRestructured("routes_empty");

  hiddenDb = giveRestructured("routes_hidden");

  const emptySql = connect(emptyDb);
  await emptySql`update travel_packages set destination_id = null`;
  await emptySql.end({ timeout: 5 });

  // Egypt stays published and keeps three packages; a second destination is
  // created unpublished, and one published package is filed under it.
  const hiddenSql = connect(hiddenDb);
  await hiddenSql`
    insert into package_destinations (slug, title_en, title_ar, is_published, sort_order)
    values ('nepal', 'Nepal', 'نيبال', false, 1)
  `;
  await hiddenSql`
    update travel_packages
       set destination_id = (select id from package_destinations where slug = 'nepal')
     where slug = 'red-sea-sharm-el-sheikh'
  `;
  await hiddenSql.end({ timeout: 5 });

  legacySql = connect(legacyDb);
  [legacy, cutover, emptyDestination, hiddenDestination] = await Promise.all([
    startServer(legacyDb, LEGACY_PORT),
    startServer(cutoverDb, CUTOVER_PORT),
    startServer(emptyDb, EMPTY_PORT),
    startServer(hiddenDb, HIDDEN_PORT),
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
  await Promise.all([
    legacy?.stop(),
    cutover?.stop(),
    emptyDestination?.stop(),
    hiddenDestination?.stop(),
  ]);
  await legacySql?.end({ timeout: 5 });
  for (const name of [legacyDb, cutoverDb, emptyDb, hiddenDb]) if (name) dropDatabase(name);
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

/**
 * The site says out loud how many service groups it has. These are the words
 * that went stale silently last time: the catalogue moved and the sentence
 * above it did not.
 */
describe("the copy follows the catalogue, not the release", () => {
  const SIX = {
    en: "Six categories covering travel, business, residency, licensing and government-related support.",
    ar: "ست فئات رئيسية تغطي السفر والأعمال والإقامة والتراخيص والدعم المرتبط بالجهات الحكومية.",
  };
  const FIVE = {
    en: "Five service groups covering travel, business setup and company formation, residency and employee services, licensing and government support.",
    ar: "خمس مجموعات خدمات تغطي السفر، وتأسيس الأعمال والشركات، وخدمات الإقامة والموظفين، والتراخيص، والخدمات الحكومية.",
  };
  const SEO_SIX = {
    en: "Every Elite One Desk service: travel and tourism, business setup, company formation, general services, licence renewal and government relations.",
    ar: "جميع خدمات إيليت ون ديسك: السفر والسياحة، تأسيس الأعمال، تسجيل الشركات، الخدمات العامة، تجديد الرخص والعلاقات الحكومية.",
  };
  const SEO_FIVE = {
    en: "Every Elite One Desk service: travel and tourism, business setup and company formation, Iqama and employee services, license renewal and compliance, and government and general services.",
    ar: "جميع خدمات إيليت ون ديسك: السفر والسياحة، تأسيس الأعمال والشركات، خدمات الإقامة والموظفين، تجديد التراخيص والامتثال، والخدمات الحكومية والعامة.",
  };

  const description = (html: string) =>
    /<meta name="description" content="([^"]*)"/.exec(html)?.[1] ?? "";

  const decode = (value: string) =>
    value
      .replace(/&quot;/g, '"')
      .replace(/&#x27;/g, "'")
      .replace(/&amp;/g, "&");

  test("before the cutover /services still reads exactly as it always has", async () => {
    const english = await get(legacy.origin, "/services");
    assert.ok(english.html.includes(SIX.en), "the legacy English intro must be untouched");
    assert.ok(!english.html.includes(FIVE.en));
    assert.equal(decode(description(english.html)), SEO_SIX.en);

    const arabic = await get(legacy.origin, "/ar/services");
    assert.ok(arabic.html.includes(SIX.ar), "the legacy Arabic intro must be untouched");
    assert.equal(decode(description(arabic.html)), SEO_SIX.ar);
  });

  test("after the cutover /services says five service groups, in both languages", async () => {
    const english = await get(cutover.origin, "/services");
    assert.ok(english.html.includes(FIVE.en), "the five-group intro should be live");
    assert.ok(!english.html.includes(SIX.en), "nothing should still say six categories");
    assert.ok(!/Six categories/.test(english.html));

    const arabic = await get(cutover.origin, "/ar/services");
    assert.ok(arabic.html.includes(FIVE.ar));
    assert.ok(!arabic.html.includes("ست فئات"));
  });

  test("after the cutover the /services description uses the final taxonomy wording", async () => {
    assert.equal(decode(description((await get(cutover.origin, "/services")).html)), SEO_FIVE.en);
    assert.equal(
      decode(description((await get(cutover.origin, "/ar/services")).html)),
      SEO_FIVE.ar,
    );
  });

  test("the homepage stops counting six of anything", async () => {
    for (const path of ["/", "/ar"]) {
      const page = await get(cutover.origin, path);
      assert.equal(page.status, 200, path);
      assert.ok(!/Six categories/.test(page.html), `${path} still says “Six categories”`);
      assert.ok(!page.html.includes("ست فئات"), `${path} still says “ست فئات”`);
    }

    const english = await get(cutover.origin, "/");
    assert.ok(english.html.includes("Five service groups, one point of contact"));
    assert.ok(english.html.includes("Each service group has its own specialists."));
    assert.ok(english.html.includes("Five service groups under one roof"));

    const arabic = await get(cutover.origin, "/ar");
    assert.ok(arabic.html.includes("خمس مجموعات خدمات، ونقطة تواصل واحدة"));
    assert.ok(arabic.html.includes("لكل مجموعة خدمات مختصوها"));
  });

  test("the homepage path list is exactly the five final service groups", async () => {
    const FINAL = [
      { en: "Travel &amp; Tourism", ar: "السفر والسياحة" },
      { en: "Business Setup &amp; Company Formation", ar: "تأسيس الأعمال والشركات" },
      { en: "Iqama &amp; Employee Services", ar: "خدمات الإقامة والموظفين" },
      { en: "License Renewal &amp; Compliance", ar: "تجديد التراخيص والامتثال" },
      { en: "Government &amp; General Services", ar: "الخدمات الحكومية والعامة" },
    ];
    const RETIRED = ["Iqama &amp; khidamat", "Licence renewal", "Government relations", "Company formation"];

    // Scoped to the list itself. "Licence renewal" is also an ordinary sentence
    // elsewhere on the page — about renewing an investor licence — and the
    // audit is about retired structural labels, not the words themselves.
    const pathList = (html: string) => {
      const match = /<ul class="relative z-10 flex flex-col gap-3">[\s\S]*?<\/ul>/.exec(html);
      assert.ok(match, "the one-desk path list should be on the page");
      return match[0];
    };

    const english = pathList((await get(cutover.origin, "/")).html);
    for (const group of FINAL) assert.ok(english.includes(group.en), group.en);
    for (const gone of RETIRED) assert.ok(!english.includes(gone), `${gone} is still listed`);
    assert.equal((english.match(/<li>/g) ?? []).length, 5, "exactly five groups");

    const arabic = pathList((await get(cutover.origin, "/ar")).html);
    for (const group of FINAL) assert.ok(arabic.includes(group.ar), group.ar);
    assert.ok(!arabic.includes("الإقامة والمعاملات"), "the old Iqama label is still listed");
    assert.equal((arabic.match(/<li>/g) ?? []).length, 5, "exactly five groups");
  });

  test("the quick links name the group the way the rest of the site does", async () => {
    const english = await get(cutover.origin, "/");
    assert.ok(english.html.includes("Iqama &amp; Employee Services"));
    assert.ok(!english.html.includes("Iqama &amp; Khidamat"), "the retired label is still offered");

    const arabic = await get(cutover.origin, "/ar");
    assert.ok(arabic.html.includes("خدمات الإقامة والموظفين"));
    assert.ok(!arabic.html.includes("الإقامة والمعاملات"));
  });

  test("no link in the default homepage content points at a retired category", async () => {
    for (const path of ["/", "/ar"]) {
      const page = await get(cutover.origin, path);
      for (const retired of ["/services/company-formation", "/services/general-services"]) {
        assert.ok(
          !page.html.includes(`href="${retired}"`) && !page.html.includes(`href="/ar${retired}"`),
          `${path} links to ${retired}`,
        );
      }
    }
  });

  test("the FAQ no longer names a category that does not exist", async () => {
    const english = await get(cutover.origin, "/");
    assert.ok(
      english.html.includes("What is the difference between Iqama &amp; Employee Services and visa services?"),
      "the rewritten question should be live",
    );
    assert.ok(!/difference between General Services/.test(english.html));

    const arabic = await get(cutover.origin, "/ar");
    assert.ok(arabic.html.includes("ما الفرق بين خدمات الإقامة والموظفين وخدمات التأشيرات؟"));
    assert.ok(!arabic.html.includes("ما الفرق بين الخدمات العامة"));
  });

  test("the Iqama subcategory heading is the approved Arabic", async () => {
    const arabic = await get(cutover.origin, "/ar/services/iqama-services");
    assert.equal(arabic.status, 200);
    assert.ok(arabic.html.includes("خدمات الإقامة والموظفين"));
    assert.ok(!arabic.html.includes("خدمات الإقامة والمعاملات"));
  });
});

/**
 * A destination an editor has unpublished is them saying "this place is not
 * ready to show" — not "hide these packages". The rule is that a published
 * package is always somewhere on the catalogue.
 */
describe("a published package under an unpublished destination", () => {
  test("falls into Build your own rather than disappearing", async () => {
    const page = await get(hiddenDestination.origin, "/packages");
    assert.equal(page.status, 200);

    assert.ok(page.html.includes('href="/packages/egypt"'), "Egypt is still a group");
    assert.ok(!page.html.includes('href="/packages/nepal"'), "the unpublished one is not offered");
    assert.ok(page.html.includes("Build your own"), "the ungrouped section should be rendered");
    assert.ok(
      page.html.includes('href="/packages/red-sea-sharm-el-sheikh"'),
      "the package must still be on the catalogue somewhere",
    );
    assert.ok(page.html.includes('href="/packages/custom-itinerary"'));
  });

  test("the same in Arabic", async () => {
    const page = await get(hiddenDestination.origin, "/ar/packages");
    assert.equal(page.status, 200);
    assert.ok(page.html.includes("صمّم رحلتك"), "the Arabic ungrouped heading");
    assert.ok(page.html.includes('href="/ar/packages/red-sea-sharm-el-sheikh"'));
    assert.ok(!page.html.includes('href="/ar/packages/nepal"'));
  });

  test("the unpublished destination has no page of its own, and the package still does", async () => {
    assert.equal((await get(hiddenDestination.origin, "/packages/nepal")).status, 404);
    assert.equal((await get(hiddenDestination.origin, "/ar/packages/nepal")).status, 404);
    assert.equal(
      (await get(hiddenDestination.origin, "/packages/red-sea-sharm-el-sheikh")).status,
      200,
    );
    assert.equal(
      (await get(hiddenDestination.origin, "/ar/packages/red-sea-sharm-el-sheikh")).status,
      200,
    );
  });

  test("Egypt keeps the three packages that are still filed under it", async () => {
    const egypt = await get(hiddenDestination.origin, "/packages/egypt");
    assert.equal(egypt.status, 200);
    for (const slug of ["cairo-and-giza-classic", "nile-cruise-luxor-aswan", "egypt-family-programme"]) {
      assert.ok(egypt.html.includes(`href="/packages/${slug}"`), slug);
    }
    assert.ok(!egypt.html.includes('href="/packages/red-sea-sharm-el-sheikh"'));
  });
});
