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
import { giveFresh, giveLegacy } from "./helpers/fixtures";
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

describe("editor-owned content", () => {
  const LEGACY_FAQ = "What is the difference between General Services and visa services?";

  test("copy the seed wrote is updated; copy an editor changed is reported and left", async () => {
    const name = legacy("content_custom");
    const sql = open(name);

    await sql`
      update page_sections
         set published = jsonb_set(published, '{title,en}', '"Our services, one desk"')
       where block_type = 'service-grid'
    `;
    await sql`update faqs set answer_en = '<p>Edited by an admin.</p>' where question_en = ${LEGACY_FAQ}`;

    const result = restructure(name);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /Editor-owned content left untouched/);
    assert.match(result.output, /home\/service-grid\.title \(published\) — edited since it was seeded/);
    assert.match(result.output, /General Services vs visa services” FAQ — edited since it was seeded/);

    const [grid] = await sql<{ published: Record<string, unknown> }[]>`
      select published from page_sections where block_type = 'service-grid'
    `;
    const title = grid!.published.title as { en: string };
    assert.equal(title.en, "Our services, one desk", "the edit must survive the cutover");

    // The fields beside it were still seeded values, so they did move.
    assert.equal(grid!.published.limit, 5);
    const intro = grid!.published.intro as { en: string };
    assert.match(intro.en, /Each service group has its own specialists/);

    const [faq] = await sql<{ question_en: string; answer_en: string }[]>`
      select question_en, answer_en from faqs where answer_en = '<p>Edited by an admin.</p>'
    `;
    assert.equal(faq!.question_en, LEGACY_FAQ, "a half-rewritten FAQ would be worse than neither");
  });

  test("untouched copy is rewritten, and nothing is reported", async () => {
    const name = legacy("content_clean");
    const sql = open(name);

    const result = restructure(name);
    assert.equal(result.code, 0, result.output);
    assert.ok(!/Editor-owned content left untouched/.test(result.output), result.output);
    assert.match(result.output, /homepage copy updated for five service groups \(6 section fields, 1 FAQ\)/);

    const [faq] = await sql<{ question_en: string; question_ar: string; answer_en: string }[]>`
      select question_en, question_ar, answer_en from faqs
       where question_en like 'What is the difference%'
    `;
    assert.equal(
      faq!.question_en,
      "What is the difference between Iqama & Employee Services and visa services?",
    );
    assert.equal(faq!.question_ar, "ما الفرق بين خدمات الإقامة والموظفين وخدمات التأشيرات؟");
    assert.match(faq!.answer_en, /^<p>Iqama &amp; Employee Services covers residency/);
  });
});

describe("FAQs are not collateral", () => {
  test("a FAQ filed under Company Formation moves to Business Setup rather than cascading away", async () => {
    const name = legacy("faq_category");
    const sql = open(name);

    const [company] = await sql<{ id: number }[]>`
      select id from service_categories where slug = 'company-formation'
    `;
    await sql`
      insert into faqs (scope, category_id, question_en, question_ar, answer_en)
      values ('category', ${company!.id}, 'How long does registration take?', 'كم يستغرق التسجيل؟', '<p>It depends.</p>')
    `;

    const result = restructure(name);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /1 FAQ\)/, "the move should be reported");

    const [row] = await sql<{ slug: string | null; question_en: string }[]>`
      select c.slug, f.question_en
        from faqs f left join service_categories c on c.id = f.category_id
       where f.question_en = 'How long does registration take?'
    `;
    assert.ok(row, "the FAQ must still exist");
    assert.equal(row!.slug, "business-setup", "and be filed where its subcategory went");
  });

  test("a FAQ on a deleted duplicate service follows the service that replaces it", async () => {
    const name = legacy("faq_service");
    const sql = open(name);

    const [duplicate] = await sql<{ id: number }[]>`
      select id from services where slug = 'egypt-flight-booking'
    `;
    await sql`
      insert into faqs (scope, service_id, question_en, answer_en)
      values ('service', ${duplicate!.id}, 'Can you book the flights too?', '<p>Yes.</p>')
    `;

    const result = restructure(name);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /1 FAQ\(s\) moved to the surviving service/);

    const [row] = await sql<{ slug: string | null }[]>`
      select s.slug from faqs f left join services s on s.id = f.service_id
       where f.question_en = 'Can you book the flights too?'
    `;
    assert.ok(row, "the FAQ must still exist");
    assert.equal(row!.slug, "air-ticket-booking");
  });

  test("a FAQ on a service that becomes a destination stops the run instead of vanishing", async () => {
    const name = legacy("faq_stranded");
    const sql = open(name);

    const [duplicate] = await sql<{ id: number }[]>`
      select id from services where slug = 'cairo-city-tour'
    `;
    await sql`
      insert into faqs (scope, service_id, question_en, answer_en)
      values ('service', ${duplicate!.id}, 'Is the museum included?', '<p>Yes.</p>')
    `;
    const before = dumpData(name);

    const result = restructure(name);
    assert.equal(result.code, 1);
    assert.match(result.output, /becomes a package or a destination/);
    assert.match(result.output, /Is the museum included\?/);
    assert.match(result.output, /Move or delete them in the panel/);
    assert.equal(dumpData(name), before, "nothing was written");
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

});

/**
 * The cutover replaces the menu wholesale, so it first has to prove the menu is
 * still the one the seed wrote. A row count cannot prove that: every case below
 * except the first leaves the count at twenty-four, and every one of them is
 * somebody's work.
 */
/**
 * Production holds TGA License Consultation under Travel & Tourism while its own
 * subcategory belongs to Government Relations — 39/14 where the catalogue says
 * 38/15. The first production dry run aborted on "Travel should hold 26
 * services", which was the assertion doing its job.
 */
describe("the TGA License Consultation classification", () => {
  const CATEGORY_OF = `
    select c.slug as category, coalesce(sc.slug, '-') as subcategory,
           s.slug, s.sort_order, s.is_featured, s.is_published,
           s.title_en, s.title_ar, s.intro_en, s.image_id
      from services s
      join service_categories c on c.id = s.category_id
      left join service_subcategories sc on sc.id = s.subcategory_id
     where s.slug = 'tga-license-consultation'
  `;

  const counts = async (sql: Sql) => {
    const rows = await sql<{ slug: string; n: number }[]>`
      select c.slug, count(*)::int as n
        from services s join service_categories c on c.id = s.category_id
       group by c.slug
    `;
    return Object.fromEntries(rows.map((row) => [row.slug, row.n]));
  };

  /** The whole catalogue, ordered — what "converges with a fresh seed" means. */
  const catalogue = (sql: Sql) => sql`
    select c.slug as category, coalesce(sc.slug, '-') as subcategory, s.slug,
           s.sort_order, s.is_featured
      from services s
      join service_categories c on c.id = s.category_id
      left join service_subcategories sc on sc.id = s.subcategory_id
     order by c.sort_order, s.sort_order, s.id
  `;

  test("A · the pristine seed already has it under Government, and nothing moves it", async () => {
    const name = legacy("tga_pristine");
    const sql = open(name);

    const [before] = await sql.unsafe(CATEGORY_OF);
    assert.equal(before!.category, "government-relations");
    assert.equal(before!.subcategory, "tga-services");
    assert.deepEqual(await counts(sql), {
      "travel-tourism": 38,
      "business-setup": 9,
      "company-formation": 5,
      "general-services": 13,
      "license-renewal": 6,
      "government-relations": 15,
    });

    const result = restructure(name);
    assert.equal(result.code, 0, result.output);
    assert.ok(
      !/TGA License Consultation moved/.test(result.output),
      "there was nothing to move, so it should not say it moved anything",
    );

    const freshName = giveFresh("tga_pristine_fresh");
    created.push(freshName);
    const fresh = open(freshName);
    assert.deepEqual(plain(await catalogue(sql)), plain(await catalogue(fresh)));
  });

  test("B · the production shape restructures to 26/15 and converges", async () => {
    const name = legacy("tga_prod");
    const sql = open(name);

    const [original] = await sql.unsafe(CATEGORY_OF);
    // Exactly the mutation the production evidence describes: the category
    // only, with the subcategory left where it is.
    await sql`
      update services
         set category_id = (select id from service_categories where slug = 'travel-tourism')
       where slug = 'tga-license-consultation'
    `;

    const [{ total }] = await sql<{ total: number }[]>`select count(*)::int as total from services`;
    assert.equal(total, 86);
    const before = await counts(sql);
    assert.equal(before["travel-tourism"], 39, "the production anomaly");
    assert.equal(before["government-relations"], 14, "the production anomaly");

    const result = restructure(name);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /TGA License Consultation moved from Travel to Government Relations/);

    const after = await counts(sql);
    assert.deepEqual(after, {
      "travel-tourism": 26,
      "business-setup": 14,
      "iqama-services": 13,
      "license-renewal": 6,
      "government-relations": 15,
    });
    const [{ total: finalTotal }] = await sql<{ total: number }[]>`
      select count(*)::int as total from services
    `;
    assert.equal(finalTotal, 74);

    const rows = await sql.unsafe(CATEGORY_OF);
    assert.equal(rows.length, 1, "the service must still exist exactly once");
    const moved = rows[0]!;
    assert.equal(moved.category, "government-relations");
    assert.equal(moved.subcategory, "tga-services");
    assert.equal(moved.slug, "tga-license-consultation");

    // Everything but its position is the row it always was.
    for (const field of ["title_en", "title_ar", "intro_en", "image_id", "is_featured", "is_published"]) {
      assert.deepEqual(moved[field], original![field], `${field} should be untouched`);
    }

    const freshName = giveFresh("tga_prod_fresh");
    created.push(freshName);
    const fresh = open(freshName);
    assert.deepEqual(plain(await catalogue(sql)), plain(await catalogue(fresh)));
  });

  test("B2 · the same, carrying the position it had in Travel", async () => {
    // Closer to production, where the row has been in Travel long enough to
    // hold a Travel-shaped sort_order. The number it arrives with must not
    // decide where it lands in its new category.
    const name = legacy("tga_prod_order");
    const sql = open(name);
    await sql`
      update services
         set category_id = (select id from service_categories where slug = 'travel-tourism'),
             sort_order = 38
       where slug = 'tga-license-consultation'
    `;

    const result = restructure(name);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /TGA License Consultation moved/);

    const freshName = giveFresh("tga_prod_order_fresh");
    created.push(freshName);
    const fresh = open(freshName);
    assert.deepEqual(plain(await catalogue(sql)), plain(await catalogue(fresh)));

    // And specifically: first inside the TGA block, where the catalogue lists it.
    const block = await sql<{ slug: string }[]>`
      select s.slug from services s
        join service_subcategories sc on sc.id = s.subcategory_id
       where sc.slug = 'tga-services' order by s.sort_order
    `;
    assert.equal(block[0]!.slug, "tga-license-consultation");
  });

  test("a dry run over the production shape rolls back byte-identically", async () => {
    const name = legacy("tga_dry");
    const sql = open(name);
    await sql`
      update services
         set category_id = (select id from service_categories where slug = 'travel-tourism'),
             sort_order = 38
       where slug = 'tga-license-consultation'
    `;
    const before = dumpData(name);

    const result = restructure(name, ["--dry-run"]);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /travel-tourism\s+39/, "the report should show the anomaly");
    assert.match(result.output, /government-relations\s+14/);
    assert.match(result.output, /TGA License Consultation moved/);
    assert.match(result.output, /all invariants hold/);
    assert.match(result.output, /Rolled back\. Nothing was written\./);

    assert.equal(dumpData(name), before);
  });

  test("any other classification stops the run instead of being overwritten", async () => {
    const name = legacy("tga_unknown");
    const sql = open(name);
    // A third category — neither the one the catalogue names nor the one the
    // production anomaly puts it in.
    await sql`
      update services
         set category_id = (select id from service_categories where slug = 'license-renewal')
       where slug = 'tga-license-consultation'
    `;
    const before = dumpData(name);

    const result = restructure(name);
    assert.equal(result.code, 1);
    assert.match(result.output, /tga-license-consultation is filed under license-renewal \/ tga-services/);
    assert.match(result.output, /will not guess/);
    assert.equal(dumpData(name), before, "the database must be byte-identical");
  });

  test("an unexpected subcategory stops it too", async () => {
    const name = legacy("tga_unknown_sub");
    const sql = open(name);
    await sql`
      update services
         set subcategory_id = (select id from service_subcategories where slug = 'premium-residency')
       where slug = 'tga-license-consultation'
    `;
    const before = dumpData(name);

    const result = restructure(name);
    assert.equal(result.code, 1);
    assert.match(result.output, /filed under government-relations \/ premium-residency/);
    assert.equal(dumpData(name), before);
  });

  test("a tga-services subcategory under the wrong category is refused, not repaired", async () => {
    const name = legacy("tga_sub_moved");
    const sql = open(name);
    await sql`
      update service_subcategories
         set category_id = (select id from service_categories where slug = 'travel-tourism')
       where slug = 'tga-services'
    `;
    const before = dumpData(name);

    const result = restructure(name);
    assert.equal(result.code, 1);
    assert.match(result.output, /tga-services subcategory does not belong to government-relations/);
    assert.equal(dumpData(name), before);
  });
});

describe("navigation is only replaced if nobody has touched it", () => {
  /** Each case is one edit an editor could plausibly have made in the panel. */
  const CASES: Array<{ name: string; edit: string; keepsCount: boolean; shows: RegExp }> = [
    {
      name: "an English label renamed",
      edit: "update navigation_items set label_en = 'Welcome' where menu = 'header' and label_en = 'Home'",
      keepsCount: true,
      shows: /Welcome/,
    },
    {
      name: "an Arabic label rewritten",
      edit: "update navigation_items set label_ar = 'ترحيب' where menu = 'header' and label_en = 'Home'",
      keepsCount: true,
      shows: /ترحيب/,
    },
    {
      name: "an address changed",
      edit: "update navigation_items set href = '/home' where menu = 'header' and label_en = 'Home'",
      keepsCount: true,
      shows: /→ \/home/,
    },
    {
      name: "an item reordered",
      edit: "update navigation_items set sort_order = 99 where menu = 'header' and label_en = 'Contact'",
      keepsCount: true,
      shows: /#99/,
    },
    {
      name: "an item unpublished",
      edit: "update navigation_items set is_published = false where menu = 'header' and label_en = 'About Us'",
      keepsCount: true,
      shows: /unpublished/,
    },
    {
      name: "an item highlighted",
      edit: "update navigation_items set is_highlighted = true where menu = 'header' and label_en = 'Contact'",
      keepsCount: true,
      shows: /highlighted/,
    },
    {
      name: "a child promoted to the top level",
      edit: "update navigation_items set parent_id = null where menu = 'header' and label_en = 'License Renewal'",
      keepsCount: true,
      shows: /License Renewal/,
    },
    {
      name: "one item deleted and another put in its place",
      edit:
        "delete from navigation_items where menu = 'footer_legal' and label_en = 'Terms'; " +
        "insert into navigation_items (menu, label_en, label_ar, href, sort_order) " +
        "values ('footer_legal', 'Cookies', 'ملفات تعريف', '/cookies', 22)",
      keepsCount: true,
      shows: /Cookies/,
    },
    {
      name: "an extra item added",
      edit:
        "insert into navigation_items (menu, label_en, label_ar, href, sort_order) " +
        "values ('header', 'Careers', 'وظائف', '/careers', 99)",
      keepsCount: false,
      shows: /Careers/,
    },
  ];

  for (const item of CASES) {
    test(`refuses, and changes nothing, when ${item.name}`, async () => {
      const name = legacy("nav");
      const sql = open(name);
      await sql.unsafe(item.edit);

      const [{ n }] = await sql<{ n: number }[]>`
        select count(*)::int as n from navigation_items
      `;
      assert.equal(
        n,
        item.keepsCount ? 24 : 25,
        item.keepsCount ? "this edit must not change the row count, or it proves nothing" : "",
      );

      const before = dumpData(name);
      const result = restructure(name);

      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /Navigation has been customised since the original seed/);
      assert.match(result.output, /will\s+not replace editor-owned navigation/);
      assert.match(result.output, item.shows, "the report should name what differs");
      assert.equal(dumpData(name), before, "the database must be byte-identical");
    });
  }

  test("a dry run refuses just as firmly", async () => {
    const name = legacy("nav_dry");
    const sql = open(name);
    await sql`update navigation_items set label_en = 'Welcome' where menu = 'header' and label_en = 'Home'`;
    const before = dumpData(name);

    const result = restructure(name, ["--dry-run"]);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, /Navigation has been customised since the original seed/);
    assert.equal(dumpData(name), before);
  });

  test("an untouched menu is replaced, and matches a fresh install exactly", async () => {
    const cutoverName = legacy("nav_clean");
    const cutover = open(cutoverName);

    const result = restructure(cutoverName);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /navigation rewritten \(25 rows\)/);
    assert.ok(!/customised/.test(result.output), result.output);

    const freshName = giveFresh("nav_fresh");
    created.push(freshName);
    const fresh = open(freshName);

    const menu = (sql: Sql) => sql`
      select n.menu, coalesce(p.label_en, '') as parent, n.label_en, n.label_ar, n.href,
             n.sort_order, n.is_published, n.is_highlighted
        from navigation_items n
        left join navigation_items p on p.id = n.parent_id
       order by n.menu, parent, n.sort_order, n.label_en
    `;
    assert.deepEqual(plain(await menu(cutover)), plain(await menu(fresh)));
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
