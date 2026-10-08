/**
 * Batch 25 · the deploy step that binds SEO rows to their records
 * (docs/admin/seo-and-share-images.md B.3 — `reconcileSeoRows`, run by
 * `scripts/migrate.ts` after the migrations, on every deploy).
 *
 * The previous release reads and writes rows by address only, and it serves
 * during the deploy window and again after a rollback, so a deploy can find
 * rows in any state that release leaves behind. Each state is written here
 * straight into the table, the real migrate script runs, and the rows are read
 * back: which record each one belongs to, at which address — and that nothing
 * was deleted, and that a second run changes nothing at all.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { giveFresh } from "./helpers/fixtures";
import { connect, dropDatabase, dumpData, type Sql } from "./helpers/pg";
import { migrate } from "./helpers/run";

let database = "";
let sql: Sql;
const ids: Record<string, number> = {};
/** Row ids by the label each scenario gave its row. */
const rows: Record<string, number> = {};
let firstRun = "";

type Row = { entity_type: string; entity_key: string; entity_id: number | null; title_en: string };
const rowOf = async (label: string) =>
  ({ ...(await sql<Row[]>`select entity_type, entity_key, entity_id, title_en from seo_metadata where id = ${rows[label]!}`)[0] }) as Row;

async function write(label: string, type: string, key: string, id: number | null) {
  const [row] = await sql<{ id: number }[]>`
    insert into seo_metadata (entity_type, entity_key, entity_id, title_en) values (${type}, ${key}, ${id}, ${label}) returning id`;
  rows[label] = row!.id;
}

before(async () => {
  database = giveFresh("seo_reconcile");
  sql = connect(database);
  for (const row of await sql<{ slug: string; id: number }[]>`select slug, id from pages`) ids[`page/${row.slug}`] = row.id;
  for (const row of await sql<{ slug: string; id: number }[]>`select slug, id from service_categories`) ids[`category/${row.slug}`] = row.id;
  for (const row of await sql<{ slug: string; id: number }[]>`select slug, id from travel_packages`) ids[`package/${row.slug}`] = row.id;
  for (const row of await sql<{ slug: string; id: number }[]>`select slug, id from package_destinations`) ids[`destination/${row.slug}`] = row.id;

  // A service whose address is longer than the key column: keyed by its id.
  const [category] = await sql<{ id: number }[]>`
    insert into service_categories (slug, title_en, is_published) values (${"c".repeat(120)}, 'Long category', true) returning id`;
  const [service] = await sql<{ id: number }[]>`
    insert into services (category_id, slug, title_en, is_published) values (${category!.id}, ${"s".repeat(120)}, 'Long service', true) returning id`;
  ids["service/long"] = service!.id;

  // 1. The previous release's own row: by address, at a record's address.
  await write("unbound at a record", "category", "iqama-services", null);
  // 2. …and one at an address no record has.
  await write("unbound at nothing", "package", "no-such-package", null);
  // 3. The overviews: always by address, never bound.
  await write("services overview", "page", "services", null);
  await write("packages overview", "page", "packages", null);
  // 4. Bound to a record deleted since, at an address a record has now.
  await write("bound to a deleted record", "destination", "egypt", 999_999);
  // 5. Two records whose rows swapped addresses — each still bound to its own.
  await write("cairo's row", "package", "nile-cruise-luxor-aswan", ids["package/cairo-and-giza-classic"]!);
  await write("nile's row", "package", "cairo-and-giza-classic", ids["package/nile-cruise-luxor-aswan"]!);
  // 6. A bound row at an old address, and a newer unbound row at the present
  //    one — the previous release renamed the record, then saved its SEO.
  await write("about's old row", "page", "about-before-rollback", ids["page/about"]!);
  await write("about's newer row", "page", "about", null);
  // 7. A dead row holding a record's address while the record's own row is elsewhere.
  await write("dead at business-setup", "category", "business-setup", 0);
  await write("business-setup's row", "category", "business-setup-old", ids["category/business-setup"]!);
  // 8. A long address: found by id, keyed `#id`, before and after.
  await write("long service", "service", `#${ids["service/long"]}`, ids["service/long"]!);

  const result = migrate(database);
  assert.equal(result.code, 0, result.output);
  firstRun = result.output;
});

after(async () => {
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
});

describe("25 · every row the deploy finds is settled (B.3)", () => {
  test("the run says what it did", () => {
    assert.match(firstRun, /SEO records: \d+ bound, \d+ moved to their record's address, \d+ detached, \d+ released from a deleted record\./);
  });

  test("a row by address, at a record's address, is bound to that record where it is", async () => {
    assert.deepEqual(await rowOf("unbound at a record"), {
      entity_type: "category",
      entity_key: "iqama-services",
      entity_id: ids["category/iqama-services"],
      title_en: "unbound at a record",
    });
  });

  test("a row by address at an address nothing has is detached — kept, never used, never inherited by a record that takes the address later", async () => {
    const row = await rowOf("unbound at nothing");
    assert.equal(row.entity_id, 0);
    assert.equal(row.entity_key, "no-such-package");
  });

  test("the overviews stay rows by address", async () => {
    assert.equal((await rowOf("services overview")).entity_id, null);
    assert.equal((await rowOf("packages overview")).entity_id, null);
  });

  test("a row bound to a deleted record is released, and goes to the record at its address — as the previous release applied it", async () => {
    const row = await rowOf("bound to a deleted record");
    assert.equal(row.entity_id, ids["destination/egypt"]);
    assert.equal(row.entity_key, "egypt");
  });

  test("two rows that swapped addresses go back to their own records' addresses", async () => {
    assert.deepEqual(
      [await rowOf("cairo's row"), await rowOf("nile's row")].map(({ entity_key, entity_id }) => ({ entity_key, entity_id })),
      [
        { entity_key: "cairo-and-giza-classic", entity_id: ids["package/cairo-and-giza-classic"] },
        { entity_key: "nile-cruise-luxor-aswan", entity_id: ids["package/nile-cruise-luxor-aswan"] },
      ],
    );
  });

  test("a newer row by address wins over a bound row at an old address, which is detached", async () => {
    const newer = await rowOf("about's newer row");
    assert.equal(newer.entity_id, ids["page/about"]);
    assert.equal(newer.entity_key, "about");
    const old = await rowOf("about's old row");
    assert.equal(old.entity_id, 0);
    assert.equal(old.entity_key, "about-before-rollback");
  });

  test("a record's own row moves to its address; the dead row that held it is moved aside, not deleted", async () => {
    const own = await rowOf("business-setup's row");
    assert.equal(own.entity_key, "business-setup");
    assert.equal(own.entity_id, ids["category/business-setup"]);
    const dead = await rowOf("dead at business-setup");
    assert.equal(dead.entity_key, `~${rows["dead at business-setup"]}`);
    assert.equal(dead.entity_id, 0);
  });

  test("an address too long for the key column is keyed by its record's id", async () => {
    assert.deepEqual(await rowOf("long service"), {
      entity_type: "service",
      entity_key: `#${ids["service/long"]}`,
      entity_id: ids["service/long"],
      title_en: "long service",
    });
  });

  test("nothing was deleted", async () => {
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from seo_metadata`;
    assert.equal(n, Object.keys(rows).length);
  });

  test("a second run finds nothing to do and changes nothing", () => {
    const before = dumpData(database);
    const again = migrate(database);
    assert.equal(again.code, 0, again.output);
    assert.match(again.output, /SEO records: nothing to reconcile\./);
    assert.equal(dumpData(database), before);
  });
});
