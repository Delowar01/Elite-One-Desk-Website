/**
 * The seed has to be safe to run against all three shapes a database can be
 * in. The dangerous one is `legacy`: seeded from the new catalogue it would not
 * find `iqama-services`, would create it empty beside the live
 * `general-services`, and would put a ghost category on the website. Its
 * thirteen services would all be found by their own slugs and skipped, so the
 * ghost would never even fill up.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { dropDatabase, connect, type Sql } from "./helpers/pg";
import { giveEmpty, giveFresh, giveLegacy, giveRestructured } from "./helpers/fixtures";
import { seed } from "./helpers/run";

const opened: Array<{ name: string; sql: Sql }> = [];

function open(name: string): Sql {
  const sql = connect(name);
  opened.push({ name, sql });
  return sql;
}

after(async () => {
  for (const { name, sql } of opened) {
    await sql.end({ timeout: 5 });
    dropDatabase(name);
  }
});

const categorySlugs = (sql: Sql) =>
  sql`select slug from service_categories order by slug`.then((r) => r.map((x) => x.slug as string));

const serviceKeys = (sql: Sql) =>
  sql`
    select c.slug || '|' || coalesce(sc.slug, '-') || '|' || s.slug as key
    from services s
    join service_categories c on c.id = s.category_id
    left join service_subcategories sc on sc.id = s.subcategory_id
    order by key
  `.then((r) => r.map((x) => x.key as string));

describe("seed state matrix", () => {
  test("an empty database reads as fresh and seeds the new catalogue", async () => {
    const name = giveEmpty("state_fresh");
    const sql = open(name);

    const result = seed(name);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /taxonomy state: fresh/);

    assert.deepEqual(await categorySlugs(sql), [
      "business-setup",
      "government-relations",
      "iqama-services",
      "license-renewal",
      "travel-tourism",
    ]);
    assert.equal((await serviceKeys(sql)).length, 74);
    const [{ n: destinations }] = await sql`select count(*)::int as n from package_destinations`;
    assert.equal(destinations, 1);
  });

  test("a pre-cutover database reads as legacy and its catalogue is left alone", async () => {
    const name = giveLegacy("state_legacy");
    const sql = open(name);

    const before = {
      categories: await categorySlugs(sql),
      services: await serviceKeys(sql),
    };
    assert.equal(before.categories.length, 6);
    assert.equal(before.services.length, 86);

    const result = seed(name);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /taxonomy state: legacy/);
    assert.match(result.output, /legacy taxonomy detected/);

    // The whole point: no ghost category, and not one service moved.
    assert.deepEqual(await categorySlugs(sql), before.categories);
    assert.deepEqual(await serviceKeys(sql), before.services);
    assert.ok(!(await categorySlugs(sql)).includes("iqama-services"));

    const [{ n: destinations }] = await sql`select count(*)::int as n from package_destinations`;
    assert.equal(destinations, 0, "the seed must not create destinations before the cutover");

    // Roles, the owner account and settings are taxonomy-independent, so they
    // do still run — that is what makes the seed usable on a live database.
    assert.match(result.output, /roles and permissions/);
    assert.match(result.output, /site settings/);
  });

  test("a database that has been through the cutover reads as restructured and re-seeds cleanly", async () => {
    const name = giveRestructured("state_done");
    const sql = open(name);

    const before = await serviceKeys(sql);
    const result = seed(name);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /taxonomy state: restructured/);
    assert.deepEqual(await serviceKeys(sql), before, "re-seeding must not duplicate anything");
    assert.equal((await categorySlugs(sql)).length, 5);
  });
});

describe("the seed and the restructure agree", () => {
  let freshName = "";
  let cutoverName = "";
  let fresh: Sql;
  let cutover: Sql;

  before(() => {
    freshName = giveFresh("converge_fresh");
    cutoverName = giveRestructured("converge_cut");
    fresh = open(freshName);
    cutover = open(cutoverName);
  });

  test("identical categories, in the same order, with the same titles", async () => {
    const shape = (sql: Sql) =>
      sql`select slug, title_en, title_ar, sort_order from service_categories order by sort_order, slug`;
    assert.deepEqual(await shape(fresh), await shape(cutover));
  });

  test("identical services, each under the same category and subcategory", async () => {
    assert.deepEqual(await serviceKeys(fresh), await serviceKeys(cutover));
    assert.equal((await serviceKeys(fresh)).length, 74);
  });

  test("identical order — the same services in the same positions, featured alike", async () => {
    const ordered = (sql: Sql) => sql`
      select c.slug as category,
             coalesce(sc.slug, '-') as subcategory,
             s.slug,
             s.sort_order,
             s.is_featured
        from services s
        join service_categories c on c.id = s.category_id
        left join service_subcategories sc on sc.id = s.subcategory_id
       order by c.sort_order, s.sort_order, s.id
    `;
    assert.deepEqual(await ordered(fresh), await ordered(cutover));
  });

  test("identical subcategories, in the same order", async () => {
    const subs = (sql: Sql) => sql`
      select c.slug as category, sc.slug, sc.title_en, sc.sort_order
        from service_subcategories sc
        join service_categories c on c.id = sc.category_id
       order by c.sort_order, sc.sort_order, sc.slug
    `;
    assert.deepEqual(await subs(fresh), await subs(cutover));
  });

  test("sort order has no holes — a deleted or merged row leaves none behind", async () => {
    const gaps = async (sql: Sql) => {
      const rows = await sql`
        select c.slug as category, array_agg(s.sort_order order by s.sort_order) as orders
          from services s join service_categories c on c.id = s.category_id
         group by c.slug
      `;
      return rows
        .filter((r) => {
          const orders = r.orders as number[];
          return orders.some((value, index) => value !== index);
        })
        .map((r) => r.category as string);
    };
    assert.deepEqual(await gaps(cutover), []);
    assert.deepEqual(await gaps(fresh), []);

    const categoryOrder = async (sql: Sql) =>
      (await sql`select sort_order from service_categories order by sort_order`).map(
        (r) => r.sort_order as number,
      );
    assert.deepEqual(await categoryOrder(cutover), [0, 1, 2, 3, 4]);
    assert.deepEqual(await categoryOrder(fresh), [0, 1, 2, 3, 4]);
  });

  test("identical navigation, labels and hrefs in both languages", async () => {
    const menu = (sql: Sql) => sql`
      select n.menu, coalesce(p.label_en, '') as parent, n.label_en, n.label_ar, n.href
      from navigation_items n
      left join navigation_items p on p.id = n.parent_id
      order by n.menu, parent, n.label_en, n.href
    `;
    assert.deepEqual(await menu(fresh), await menu(cutover));
  });

  test("identical section block types — the homepage feature is destination-feature in both", async () => {
    const blocks = (sql: Sql) =>
      sql`select block_type, count(*)::int as n from page_sections group by block_type order by block_type`;
    assert.deepEqual(await blocks(fresh), await blocks(cutover));
    const [{ n }] = await fresh`select count(*)::int as n from page_sections where block_type = 'destination-feature'`;
    assert.equal(n, 1);
    const [{ n: stale }] = await cutover`select count(*)::int as n from page_sections where block_type = 'egypt-feature'`;
    assert.equal(stale, 0);
  });

  test("identical links inside the sections — no block still points at a retired category", async () => {
    // Media ids differ between two independently built databases; addresses do
    // not, and addresses are what a visitor follows.
    const links = async (sql: Sql) => {
      const rows = await sql`select published::text as text from page_sections`;
      const found = new Set<string>();
      for (const row of rows) {
        for (const match of (row.text as string).matchAll(/"(\/[a-z0-9/#-]*)"/g)) found.add(match[1]!);
      }
      return [...found].sort();
    };
    const fromFresh = await links(fresh);
    assert.deepEqual(fromFresh, await links(cutover));
    for (const href of fromFresh) {
      assert.ok(
        !href.startsWith("/services/company-formation") &&
          !href.startsWith("/services/general-services"),
        `a section still links to the retired ${href}`,
      );
    }
  });

  test("identical destinations, and the same four packages inside Egypt", async () => {
    const destinations = (sql: Sql) =>
      sql`select slug, title_en, title_ar, summary_en, summary_ar from package_destinations order by slug`;
    assert.deepEqual(await destinations(fresh), await destinations(cutover));

    const grouped = (sql: Sql) => sql`
      select p.slug, d.slug as destination
      from travel_packages p
      left join package_destinations d on d.id = p.destination_id
      order by p.slug
    `;
    assert.deepEqual(await grouped(fresh), await grouped(cutover));
  });
});
