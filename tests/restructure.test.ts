/**
 * The cutover itself: atomic, exclusive, idempotent.
 *
 * Every test here starts from a real pre-restructure database — this branch's
 * schema over `LEGACY_REF`'s catalogue, which is the shape production is in the
 * moment before somebody types the command.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, describe, test } from "node:test";

import { REPO_ROOT, dbUrl, scriptEnv } from "./helpers/env";
import { giveLegacy } from "./helpers/fixtures";
import { connect, dropDatabase, dumpData, plain, type Sql } from "./helpers/pg";
import { restructure } from "./helpers/run";

/** Every database this file makes, so none of them outlives the run. */
const created: string[] = [];
const opened: Sql[] = [];

/** A pre-cutover database, registered for teardown. */
function legacy(label: string): string {
  const name = giveLegacy(label);
  created.push(name);
  return name;
}

function open(name: string): Sql {
  const sql = connect(name);
  opened.push(sql);
  return sql;
}

after(async () => {
  for (const sql of opened) await sql.end({ timeout: 5 });
  for (const name of created) dropDatabase(name);
});

const slugs = (sql: Sql, table: string) =>
  sql.unsafe<{ slug: string }[]>(`select slug from ${table} order by slug`).then((r) =>
    r.map((x) => x.slug),
  );

describe("dry run", () => {
  test("does the whole thing, proves the invariants, and writes nothing", async () => {
    const name = legacy("dry");
    const before = dumpData(name);

    const result = restructure(name, ["--dry-run"]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /DRY RUN/);
    assert.match(result.output, /all invariants hold/);
    assert.match(result.output, /Rolled back\. Nothing was written\./);

    // It really did the work before rolling back: the report shows the after
    // state, not a plan.
    assert.match(result.output, /services\s+74/);
    assert.match(result.output, /destination-feature 1/);

    assert.equal(dumpData(name), before, "a dry run must leave the data untouched");
  });
});

describe("the live run", () => {
  test("commits, and every structural claim holds afterwards", async () => {
    const name = legacy("live");
    const sql = open(name);

    const result = restructure(name);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Committed\./);

    assert.deepEqual(await slugs(sql, "service_categories"), [
      "business-setup",
      "government-relations",
      "iqama-services",
      "license-renewal",
      "travel-tourism",
    ]);
    assert.ok(!(await slugs(sql, "service_subcategories")).includes("egypt-tours"));

    const [{ n: services }] = await sql`select count(*)::int as n from services`;
    assert.equal(services, 74);

    // The Egypt subcategory's two keepers, in their new home.
    const promoted = await sql`
      select s.slug, sc.slug as subcategory
        from services s
        join service_subcategories sc on sc.id = s.subcategory_id
       where s.slug in ('honeymoon-packages', 'professional-tour-guide')
       order by s.slug
    `;
    assert.deepEqual(plain(promoted), [
      { slug: "honeymoon-packages", subcategory: "travel-holiday" },
      { slug: "professional-tour-guide", subcategory: "travel-holiday" },
    ]);

    // Egypt is a destination holding four packages; the custom itinerary is not
    // a destination's business and stays outside.
    const grouped = await sql`
      select p.slug, d.slug as destination
        from travel_packages p
        left join package_destinations d on d.id = p.destination_id
       order by p.slug
    `;
    assert.deepEqual(plain(grouped), [
      { slug: "cairo-and-giza-classic", destination: "egypt" },
      { slug: "custom-itinerary", destination: null },
      { slug: "egypt-family-programme", destination: "egypt" },
      { slug: "nile-cruise-luxor-aswan", destination: "egypt" },
      { slug: "red-sea-sharm-el-sheikh", destination: "egypt" },
    ]);
  });

  test("D3: not one region value is rewritten", async () => {
    const name = legacy("regions");
    const sql = open(name);

    const before = await sql`select slug, region from travel_packages order by slug`;
    assert.deepEqual(
      before.map((r) => r.region),
      ["egypt", "international", "egypt", "egypt", "egypt"],
    );

    assert.equal(restructure(name).code, 0);

    const after = await sql`select slug, region from travel_packages order by slug`;
    assert.deepEqual(
      plain(after),
      plain(before),
      "region is legacy, kept for compatibility, and never rewritten",
    );
  });

  test("a second run is a no-op, and so is a dry run over it", () => {
    const name = legacy("twice");
    assert.equal(restructure(name).code, 0);

    const second = restructure(name);
    assert.equal(second.code, 0, second.output);
    assert.match(second.output, /Already restructured — nothing to do\./);

    const dry = restructure(name, ["--dry-run"]);
    assert.equal(dry.code, 0, dry.output);
    assert.match(dry.output, /Already restructured — nothing to do\./);
  });

  test("an empty database is refused rather than half-built", async () => {
    const name = legacy("empty_check");
    const sql = open(name);
    await sql`truncate service_categories cascade`;

    const result = restructure(name);
    assert.equal(result.code, 1);
    assert.match(result.output, /no service catalogue at all/);
    assert.match(result.output, /DATABASE_URL/);
  });
});

describe("enquiries", () => {
  test("a customer record outlives the category it was filed under, and still reads", async () => {
    const name = legacy("enquiries");
    const sql = open(name);

    // Two enquiries against things the cutover removes: the Company Formation
    // category, and one of the twelve duplicate Egypt services.
    const [category] = await sql<{ id: number }[]>`
      select id from service_categories where slug = 'company-formation'
    `;
    const [service] = await sql<{ id: number }[]>`
      select id from services where slug = 'nile-river-cruise'
    `;
    await sql`
      insert into enquiries (reference, name, category_id, service_id, category_label, service_label, message)
      values
        ('EOD-TEST-0001', 'Company enquirer', ${category!.id}, null, 'Company Formation', '', 'How do I register?'),
        ('EOD-TEST-0002', 'Cruise enquirer', null, ${service!.id}, 'Travel & Tourism Services', 'Nile River Cruise', 'Dates for August?')
    `;

    assert.equal(restructure(name).code, 0);

    const rows = await sql<
      {
        reference: string;
        category_id: number | null;
        service_id: number | null;
        category_label: string;
        service_label: string;
        message: string;
      }[]
    >`
      select reference, category_id, service_id, category_label, service_label, message
        from enquiries where reference like 'EOD-TEST-%' order by reference
    `;
    assert.equal(rows.length, 2, "no enquiry may be deleted by a taxonomy change");

    // The foreign keys are ON DELETE SET NULL, and the labels were captured when
    // the customer submitted — so the record still says what it was about.
    assert.equal(rows[0]!.category_id, null);
    assert.equal(rows[0]!.category_label, "Company Formation");
    assert.equal(rows[0]!.message, "How do I register?");
    assert.equal(rows[1]!.service_id, null);
    assert.equal(rows[1]!.service_label, "Nile River Cruise");
    assert.equal(rows[1]!.message, "Dates for August?");
  });

  test("an enquiry against the renamed category keeps its link, because the row survives", async () => {
    const name = legacy("enquiries_renamed");
    const sql = open(name);

    const [category] = await sql<{ id: number }[]>`
      select id from service_categories where slug = 'general-services'
    `;
    await sql`
      insert into enquiries (reference, name, category_id, category_label, message)
      values ('EOD-TEST-0003', 'Iqama enquirer', ${category!.id}, 'General Services', 'Renewal?')
    `;

    assert.equal(restructure(name).code, 0);

    const [row] = await sql<{ category_id: number | null; slug: string | null }[]>`
      select e.category_id, c.slug
        from enquiries e left join service_categories c on c.id = e.category_id
       where e.reference = 'EOD-TEST-0003'
    `;
    assert.equal(row!.category_id, category!.id, "a rename is not a delete");
    assert.equal(row!.slug, "iqama-services");
  });
});

describe("atomicity", () => {
  test("a failure late in the run leaves the database byte-identical", async () => {
    const name = legacy("rollback_late");
    const sql = open(name);

    // Injected by moving the world, not by a test-only branch in the script.
    // Renaming one of the twelve services the cutover expects to delete keeps
    // the catalogue at 86 rows, so every precondition passes and the run gets
    // all the way to step 8 before the delete count assertion fails — after the
    // destination, the promotions, the merge, the renames, the navigation
    // rewrite and the block retype have all been written in the transaction.
    await sql`update services set slug = 'nile-river-cruises' where slug = 'nile-river-cruise'`;
    const before = dumpData(name);

    const result = restructure(name);
    assert.equal(result.code, 1);
    assert.match(result.output, /expected to delete 12 services, deleted 11/);
    assert.match(result.output, /Rolled back\. The database is exactly as it was\./);

    assert.equal(dumpData(name), before, "nothing from the failed run survived");
    const [{ n }] = await sql`select count(*)::int as n from package_destinations`;
    assert.equal(n, 0, "the destination created in step 2 was rolled back with the rest");
    assert.ok((await slugs(sql, "service_categories")).includes("company-formation"));
    assert.ok((await slugs(sql, "service_categories")).includes("general-services"));
  });

  test("a customised menu stops the run instead of being discarded", async () => {
    const name = legacy("rollback_nav");
    const sql = open(name);

    await sql`
      insert into navigation_items (menu, label_en, label_ar, href, sort_order)
      values ('header', 'Careers', 'وظائف', '/careers', 99)
    `;
    const before = dumpData(name);

    const result = restructure(name);
    assert.equal(result.code, 1);
    assert.match(result.output, /the menu looks customised, so it is not being replaced/);
    assert.equal(dumpData(name), before);
  });
});

describe("exclusivity", () => {
  test("four cutovers at once produce exactly one", async () => {
    const name = legacy("concurrent");
    const sql = open(name);

    const runs = await Promise.all(
      [0, 1, 2, 3].map(
        () =>
          new Promise<{ code: number; output: string }>((resolve) => {
            const child = spawn("npx", ["tsx", "scripts/restructure.ts"], {
              cwd: REPO_ROOT,
              env: scriptEnv(dbUrl(name)),
            });
            let output = "";
            child.stdout.on("data", (chunk) => (output += chunk));
            child.stderr.on("data", (chunk) => (output += chunk));
            child.on("close", (code) => resolve({ code: code ?? -1, output }));
          }),
      ),
    );

    const committed = runs.filter((r) => /Committed\./.test(r.output));
    const skipped = runs.filter((r) => /Already restructured/.test(r.output));
    assert.equal(committed.length, 1, `expected one commit, saw ${committed.length}`);
    assert.equal(skipped.length, 3, `expected three no-ops, saw ${skipped.length}`);
    for (const run of runs) assert.equal(run.code, 0, run.output);

    // The advisory lock made them queue; READ COMMITTED then let each waiter
    // see the committed result rather than the snapshot it started with.
    const [{ n: categories }] = await sql`select count(*)::int as n from service_categories`;
    const [{ n: services }] = await sql`select count(*)::int as n from services`;
    const [{ n: destinations }] = await sql`select count(*)::int as n from package_destinations`;
    const [{ n: nav }] = await sql`select count(*)::int as n from navigation_items`;
    assert.deepEqual({ categories, services, destinations, nav }, {
      categories: 5,
      services: 74,
      destinations: 1,
      nav: 25,
    });
  });
});
