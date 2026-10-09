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
 * was deleted, and that a second run changes nothing at all. Every state is
 * settled to what this release's own rule already shows for it.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, describe, test } from "node:test";

import { REPO_ROOT, dbUrl, scriptEnv } from "./helpers/env";
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
/** Where a dead row goes: kept, detached, keyed by its own id. */
const setAside = (label: string) => ({ entity_key: `~${rows[label]}`, entity_id: 0 });
const keyAndId = ({ entity_key, entity_id }: Row) => ({ entity_key, entity_id });

async function write(label: string, type: string, key: string, id: number | null) {
  const [row] = await sql<{ id: number }[]>`
    insert into seo_metadata (entity_type, entity_key, entity_id, title_en) values (${type}, ${key}, ${id}, ${label}) returning id`;
  rows[label] = row!.id;
}

/** The address a service has now. */
const serviceAddress = async (id: number) =>
  (
    await sql<{ address: string }[]>`
      select c.slug || '/' || s.slug as address from services s join service_categories c on c.id = s.category_id where s.id = ${id}`
  )[0]!.address;

before(async () => {
  database = giveFresh("seo_reconcile");
  sql = connect(database);
  for (const row of await sql<{ slug: string; id: number }[]>`select slug, id from pages`) ids[`page/${row.slug}`] = row.id;
  for (const row of await sql<{ slug: string; id: number }[]>`select slug, id from service_categories`) ids[`category/${row.slug}`] = row.id;
  for (const row of await sql<{ slug: string; id: number }[]>`select slug, id from travel_packages`) ids[`package/${row.slug}`] = row.id;
  for (const row of await sql<{ slug: string; id: number }[]>`select slug, id from package_destinations`) ids[`destination/${row.slug}`] = row.id;
  for (const row of await sql<{ slug: string; id: number }[]>`select slug, id from services`) ids[`service/${row.slug}`] = row.id;

  // A service whose address is longer than the key column: keyed by its id.
  const [category] = await sql<{ id: number }[]>`
    insert into service_categories (slug, title_en, is_published) values (${"c".repeat(120)}, 'Long category', true) returning id`;
  ids["category/long"] = category!.id;
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
  //    one — the previous release moved the record, then saved its SEO.
  await write("about's old row", "page", "about-before-rollback", ids["page/about"]!);
  await write("about's newer row", "page", "about", null);
  // 7. A dead row holding a record's address while the record's own row is elsewhere.
  await write("dead at business-setup", "category", "business-setup", 0);
  await write("business-setup's row", "category", "business-setup-old", ids["category/business-setup"]!);
  // 8. A long address: found by id, keyed `#id`, before and after.
  await write("long service", "service", `#${ids["service/long"]}`, ids["service/long"]!);
  // 9. A dead row at the address of a record with no row of its own.
  await write("dead at contact", "page", "contact", 0);
  // 10. A record whose address was too long, moved by the previous release to a
  //     short one and then saved there: its own row is left at `#id`, which is
  //     reserved for its own row, beside the newer row by address.
  const [relocated] = await sql<{ id: number }[]>`
    insert into services (category_id, slug, title_en, is_published)
    values (${ids["category/business-setup"]!}, 'relocated-service', 'Relocated service', true) returning id`;
  ids["service/relocated"] = relocated!.id;
  await write("relocated's row left at its long key", "service", `#${relocated!.id}`, relocated!.id);
  await write("relocated's newer row", "service", "business-setup/relocated-service", null);
  // 11. A record with a long address, deleted since: its row is dead, and the
  //     `#id` key goes with the record.
  await write("long row of a deleted service", "service", "#999998", 999_998);

  const result = migrate(database);
  assert.equal(result.code, 0, result.output);
  firstRun = result.output;
});

after(async () => {
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
});

describe("25 · every row the deploy finds is settled to what this release shows (B.3)", () => {
  test("the run says what it did — every statement that changed a row is counted", () => {
    // bound: about's newer row, iqama-services', relocated's newer row.
    // moved: business-setup's own row, and the two packages' rows.
    // set aside: the deleted destination's and the deleted service's rows,
    // about's old row and relocated's long-key row (each shadowed by a newer
    // one), the dead rows at business-setup and at contact, no-such-package's.
    assert.match(firstRun, /SEO records: 3 bound, 3 moved to their record's address, 7 set aside\./);
  });

  test("a row by address, at a record's address, is bound to that record where it is", async () => {
    assert.deepEqual(await rowOf("unbound at a record"), {
      entity_type: "category",
      entity_key: "iqama-services",
      entity_id: ids["category/iqama-services"],
      title_en: "unbound at a record",
    });
  });

  test("a row by address at an address nothing has is set aside — keyed by its own id, so no record that takes the address later inherits it, under either release", async () => {
    assert.deepEqual(keyAndId(await rowOf("unbound at nothing")), setAside("unbound at nothing"));
  });

  test("the overviews stay rows by address", async () => {
    assert.equal((await rowOf("services overview")).entity_id, null);
    assert.equal((await rowOf("packages overview")).entity_id, null);
  });

  test("a row bound to a deleted record is dead, as every reader treats it: set aside, even where another record now has its address", async () => {
    assert.deepEqual(keyAndId(await rowOf("bound to a deleted record")), setAside("bound to a deleted record"));
    const [taken] = await sql`select 1 from seo_metadata where entity_type = 'destination' and entity_id = ${ids["destination/egypt"]!}`;
    assert.equal(taken, undefined, "the destination now at its address inherited it");
  });

  test("two rows that swapped addresses go back to their own records' addresses", async () => {
    assert.deepEqual(
      [await rowOf("cairo's row"), await rowOf("nile's row")].map(keyAndId),
      [
        { entity_key: "cairo-and-giza-classic", entity_id: ids["package/cairo-and-giza-classic"] },
        { entity_key: "nile-cruise-luxor-aswan", entity_id: ids["package/nile-cruise-luxor-aswan"] },
      ],
    );
  });

  test("a newer row by address wins over a bound row at an old address, which is set aside", async () => {
    assert.deepEqual(keyAndId(await rowOf("about's newer row")), { entity_key: "about", entity_id: ids["page/about"] });
    assert.deepEqual(keyAndId(await rowOf("about's old row")), setAside("about's old row"));
  });

  test("a record's own row moves to its address; the dead row that held it is set aside, not deleted", async () => {
    assert.deepEqual(keyAndId(await rowOf("business-setup's row")), {
      entity_key: "business-setup",
      entity_id: ids["category/business-setup"],
    });
    assert.deepEqual(keyAndId(await rowOf("dead at business-setup")), setAside("dead at business-setup"));
  });

  test("a dead row at the address of a record with no row of its own is set aside, never bound — no reader of this release ever used it", async () => {
    assert.deepEqual(keyAndId(await rowOf("dead at contact")), setAside("dead at contact"));
    const [taken] = await sql`select 1 from seo_metadata where entity_type = 'page' and entity_id = ${ids["page/contact"]!}`;
    assert.equal(taken, undefined, "the contact page inherited the dead row");
  });

  test("a `#<id>` key leaves with the row taken out of use: it is only ever its record's own row's", async () => {
    assert.deepEqual(keyAndId(await rowOf("relocated's row left at its long key")), setAside("relocated's row left at its long key"));
    assert.deepEqual(keyAndId(await rowOf("relocated's newer row")), {
      entity_key: "business-setup/relocated-service",
      entity_id: ids["service/relocated"],
    });
    assert.deepEqual(keyAndId(await rowOf("long row of a deleted service")), setAside("long row of a deleted service"));
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

/** The migrate script, run without waiting for it — as a deploy runs it beside the serving release. */
function migrateInBackground(): { done: Promise<{ code: number; output: string }>; finished: () => boolean } {
  let over = false;
  const done = new Promise<{ code: number; output: string }>((resolve) => {
    const child = spawn("npx", ["tsx", "scripts/migrate.ts"], { cwd: REPO_ROOT, env: scriptEnv(dbUrl(database)) });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    child.on("close", (code) => {
      over = true;
      resolve({ code: code ?? -1, output });
    });
  });
  return { done, finished: () => over };
}

/**
 * Until a session of this file's own database waits in a statement matching
 * `query` — or the run has finished. Answers which of `waits` it saw first.
 */
async function untilWaiting(run: { finished: () => boolean }, waits: Record<string, string>): Promise<string | null> {
  for (let tries = 0; tries < 2400 && !run.finished(); tries += 1) {
    for (const [name, query] of Object.entries(waits)) {
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
         where datname = current_database() and pid <> pg_backend_pid()
           and (wait_event_type = 'Lock' or wait_event = 'PgSleep') and query ilike ${query}`;
      if (row!.n > 0) return name;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return null;
}

describe("25 · the deploys after it (B.3)", () => {
  test("a save the previous release has not committed yet is waited for, then settled with the rest — never decided on half a table", async () => {
    // The previous release serves while the deploy migrates: an admin saves a
    // category's SEO by address, and the save is still open when reconcile starts.
    let commit!: () => void;
    const gate = new Promise<void>((resolve) => (commit = resolve));
    let written!: () => void;
    const inserted = new Promise<void>((resolve) => (written = resolve));
    const saving = sql.begin(async (tx) => {
      const [row] = await tx<{ id: number }[]>`
        insert into seo_metadata (entity_type, entity_key, title_en)
        values ('category', 'license-renewal', 'saved during the deploy') returning id`;
      rows["saved during the deploy"] = row!.id;
      written();
      await gate;
    });
    await inserted;

    const run = migrateInBackground();
    try {
      const seen = await untilWaiting(run, { "table lock": "lock table seo_metadata%" });
      assert.equal(seen, "table lock", "the deploy's reconcile never waited for the open save");
    } finally {
      commit();
      await saving;
    }
    const result = await run.done;
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /SEO records: 1 bound, 0 moved to their record's address, 0 set aside\./);
    assert.deepEqual(await rowOf("saved during the deploy"), {
      entity_type: "category",
      entity_key: "license-renewal",
      entity_id: ids["category/license-renewal"],
      title_en: "saved during the deploy",
    });
  });

  test("a save of this release that has locked its row and not yet written it is waited for too — the deploy does not deadlock against it", async () => {
    // Every SEO write of this release locks its rows `FOR UPDATE` first and
    // writes them after. A lock on the table that let the run past that row lock
    // would leave each waiting for the other.
    await write("locked before the deploy", "category", "government-relations", null);
    let write_!: () => void;
    const gate = new Promise<void>((resolve) => (write_ = resolve));
    let locked!: () => void;
    const held = new Promise<void>((resolve) => (locked = resolve));
    const saving = sql.begin(async (tx) => {
      await tx`select id from seo_metadata where id = ${rows["locked before the deploy"]!} for update`;
      locked();
      await gate;
      await tx`update seo_metadata set title_en = 'written while the deploy waited' where id = ${rows["locked before the deploy"]!}`;
    });
    await held;

    const run = migrateInBackground();
    let seen: string | null = null;
    try {
      seen = await untilWaiting(run, {
        "table lock": "lock table seo_metadata%",
        "the locked row": "%update seo_metadata%",
      });
    } finally {
      write_();
      await saving.catch(() => undefined);
    }
    assert.equal(seen, "table lock", "the run went past the table lock to the row the save had locked");
    const result = await run.done;
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /SEO records: 1 bound, 0 moved to their record's address, 0 set aside\./);
    assert.deepEqual(await rowOf("locked before the deploy"), {
      entity_type: "category",
      entity_key: "government-relations",
      entity_id: ids["category/government-relations"],
      title_en: "written while the deploy waited",
    });
  });

  test("a record the previous release moves while the run is under way is settled where the run first read it — the deploy does not stop on a duplicate key", async () => {
    // The run reads every record as it was when its first statement ran. A
    // service moved between two of its statements — here, while step 3 binds
    // its row — onto the address of a dead row would otherwise be re-keyed onto
    // that row's key.
    const id = ids["service/tga-license-renewal-assistance"]!;
    const from = await serviceAddress(id);
    await write("tga's row", "service", from, null);
    await write("a dead row where tga is going", "service", "business-setup/tga-license-renewal-assistance", null);
    await sql`
      create function seo_test_pause() returns trigger language plpgsql as $$
      begin perform pg_sleep(2); return new; end $$`;
    await sql.unsafe(`
      create trigger seo_test_pause before update on seo_metadata for each row
        when (old.id = ${rows["tga's row"]!} and old.entity_id is null and new.entity_id is not null)
        execute function seo_test_pause()`);
    try {
      const run = migrateInBackground();
      const seen = await untilWaiting(run, { "binding tga's row": "%update seo_metadata%" });
      assert.equal(seen, "binding tga's row", "the run never reached tga's row");
      await sql`update services set category_id = ${ids["category/business-setup"]!} where id = ${id}`;
      const result = await run.done;
      assert.equal(result.code, 0, result.output);
      assert.match(result.output, /SEO records: 1 bound, 0 moved to their record's address, 1 set aside\./);
      assert.deepEqual(keyAndId(await rowOf("tga's row")), { entity_key: from, entity_id: id });
      assert.deepEqual(keyAndId(await rowOf("a dead row where tga is going")), setAside("a dead row where tga is going"));
    } finally {
      await sql`drop trigger if exists seo_test_pause on seo_metadata`;
      await sql`drop function if exists seo_test_pause()`;
    }
    // The move is the next run's: the service's own row goes to where it went.
    const next = migrate(database);
    assert.equal(next.code, 0, next.output);
    assert.match(next.output, /SEO records: 0 bound, 1 moved to their record's address, 0 set aside\./);
    assert.deepEqual(keyAndId(await rowOf("tga's row")), { entity_key: await serviceAddress(id), entity_id: id });
  });

  test("a record the previous release moved onto a dead row's address gets its own row back; the dead row is set aside, and the run says so", async () => {
    await write("dead at iqama-and-residency", "category", "iqama-and-residency", 0);
    await sql`update service_categories set slug = 'iqama-and-residency' where id = ${ids["category/iqama-services"]!}`;
    const result = migrate(database);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /SEO records: 0 bound, 1 moved to their record's address, 1 set aside\./);
    assert.deepEqual(keyAndId(await rowOf("unbound at a record")), {
      entity_key: "iqama-and-residency",
      entity_id: ids["category/iqama-services"],
    });
    assert.deepEqual(keyAndId(await rowOf("dead at iqama-and-residency")), setAside("dead at iqama-and-residency"));
  });

  test("the record whose `#<id>` row was set aside moves again, and its row follows it — the deploy does not stop on a duplicate key", async () => {
    await sql`update services set category_id = ${ids["category/travel-tourism"]!} where id = ${ids["service/relocated"]!}`;
    const result = migrate(database);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /SEO records: 0 bound, 1 moved to their record's address, 0 set aside\./);
    assert.deepEqual(keyAndId(await rowOf("relocated's newer row")), {
      entity_key: "travel-tourism/relocated-service",
      entity_id: ids["service/relocated"],
    });
    assert.deepEqual(keyAndId(await rowOf("relocated's row left at its long key")), setAside("relocated's row left at its long key"));
  });

  test("a move to the record's own key is counted: a record moved to an address too long for the key column", async () => {
    const slug = "l".repeat(80);
    const [{ id }] = await sql<{ id: number }[]>`
      insert into services (category_id, slug, title_en, is_published)
      values (${ids["category/business-setup"]!}, ${slug}, 'Long-named service', true) returning id`;
    await write("long-named service's row", "service", `business-setup/${slug}`, id);
    // The previous release moves it into the long category: 201 characters.
    await sql`update services set category_id = ${ids["category/long"]!} where id = ${id}`;
    const result = migrate(database);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /SEO records: 0 bound, 1 moved to their record's address, 0 set aside\./);
    assert.deepEqual(keyAndId(await rowOf("long-named service's row")), { entity_key: `#${id}`, entity_id: id });
  });

  test("keys in the reserved forms written by hand through the previous release's form are set aside first — the deploy does not stop on them", async () => {
    // A hand-made request to the previous release's form can write any key
    // (A.9): here the `#<id>` of a record whose own row the run moves, and the
    // `~<n>` of a row the run must set aside.
    const hotel = ids["service/hotel-reservation"]!;
    await write("hotel's row at an old address", "service", "business-setup/hotel-reservation", hotel);
    await write("a key made to look like hotel's", "service", `#${hotel}`, null);
    await write("a row naming no service", "service", "no-such-category/no-such-service", null);
    await write("a key made to look like a set-aside row's", "service", `~${rows["a row naming no service"]}`, null);
    const result = migrate(database);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /SEO records: 0 bound, 1 moved to their record's address, 3 set aside\./);
    assert.deepEqual(keyAndId(await rowOf("hotel's row at an old address")), { entity_key: await serviceAddress(hotel), entity_id: hotel });
    for (const label of ["a key made to look like hotel's", "a row naming no service", "a key made to look like a set-aside row's"]) {
      assert.deepEqual(keyAndId(await rowOf(label)), setAside(label), label);
    }
  });

  test("a hand-made row at a long-address record's own `#<id>` is set aside first, never bound: the record keeps its own row, which moves there", async () => {
    // A service moved into the long category is keyed `#<id>` (B.2), its own
    // row left at its old address; a hand-made request wrote a row at that
    // `#<id>`. No reader of this release uses such a row (W2³), so binding it
    // would change the page — and setting the record's own row aside for it
    // would lose what the page shows now.
    const slug = "h".repeat(80);
    const [{ id }] = await sql<{ id: number }[]>`
      insert into services (category_id, slug, title_en, is_published)
      values (${ids["category/business-setup"]!}, ${slug}, 'A long-keyed neighbour', true) returning id`;
    await write("a long-keyed service's own row at its old address", "service", `business-setup/${slug}`, id);
    await sql`update services set category_id = ${ids["category/long"]!} where id = ${id}`;
    await write("a hand-made row at a long-keyed service's #<id>", "service", `#${id}`, null);
    const result = migrate(database);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /SEO records: 0 bound, 1 moved to their record's address, 1 set aside\./);
    assert.deepEqual(keyAndId(await rowOf("a long-keyed service's own row at its old address")), { entity_key: `#${id}`, entity_id: id });
    assert.deepEqual(keyAndId(await rowOf("a hand-made row at a long-keyed service's #<id>")), setAside("a hand-made row at a long-keyed service's #<id>"));
  });

  test("rows whose hand-made keys are each other's `~<id>` are set aside once, under a key of the run's own, and the next deploy leaves them there", async () => {
    // Two requests to the previous release's form, each naming the other
    // row's `~<id>`: neither row can have its own key while the other holds it.
    await write("a hand-made ring, first", "service", "a-hand-made-ring/first", null);
    await write("a hand-made ring, second", "service", "a-hand-made-ring/second", null);
    const first = rows["a hand-made ring, first"]!;
    const second = rows["a hand-made ring, second"]!;
    await sql`update seo_metadata set entity_key = ${`~${second}`} where id = ${first}`;
    await sql`update seo_metadata set entity_key = ${`~${first}`} where id = ${second}`;
    const ring = () => sql<(Row & { id: number })[]>`select * from seo_metadata where id in (${first}, ${second}) order by id`;
    const result = migrate(database);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /SEO records: 0 bound, 0 moved to their record's address, 2 set aside\./);
    const settled = await ring();
    for (const row of settled) {
      assert.equal(row.entity_id, 0, `row ${row.id} is set aside`);
      assert.match(row.entity_key, new RegExp(`^~${row.id}~[0-9a-f-]{36}$`), `row ${row.id} holds a key of the run's own`);
    }
    const again = migrate(database);
    assert.equal(again.code, 0, again.output);
    assert.match(again.output, /SEO records: nothing to reconcile\./, "the next deploy finds them where the first left them");
    assert.deepEqual((await ring()).map(keyAndId), settled.map(keyAndId));
  });

  test("a row set aside is out of the previous release's sight too: after a rollback, its save at that address starts a new row, and the next deploy binds that", async () => {
    // During a rollback the previous release creates the package that was
    // missing and saves its SEO — an upsert by address, as it writes one.
    const [{ id }] = await sql<{ id: number }[]>`insert into travel_packages (slug, title_en) values ('no-such-package', 'Now it exists') returning id`;
    const [row] = await sql<{ id: number }[]>`
      insert into seo_metadata (entity_type, entity_key, title_en) values ('package', 'no-such-package', 'saved during a rollback')
      on conflict (entity_type, entity_key) do update set title_en = excluded.title_en
      returning id`;
    rows["saved during a rollback"] = row!.id;
    assert.notEqual(row!.id, rows["unbound at nothing"], "the save went into the row set aside");
    assert.equal((await rowOf("unbound at nothing")).title_en, "unbound at nothing");
    const result = migrate(database);
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /SEO records: 1 bound, 0 moved to their record's address, 0 set aside\./);
    assert.deepEqual(keyAndId(await rowOf("saved during a rollback")), { entity_key: "no-such-package", entity_id: id });
  });

  /** A picture in the library, as an upload leaves it. */
  const picture = async (name: string) =>
    (
      await sql<{ id: number }[]>`
        insert into media (filename, mime_type, title, width, height, derivatives)
        values (${name}, 'image/webp', ${name}, 1200, 630, ${sql.json([])}) returning id`
    )[0]!.id;
  const showing = (label: string, mediaId: number | null) => sql`update seo_metadata set og_image_id = ${mediaId} where id = ${rows[label]!}`;
  /**
   * A media delete holding pictures, as one does from its `FOR UPDATE` to its
   * commit — the previous release's included, whose `ON DELETE SET NULL` then
   * waits for the run. Released by the returned function.
   */
  async function holdPictures(ids: number[]): Promise<() => Promise<void>> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let held!: () => void;
    const holding = new Promise<void>((resolve) => (held = resolve));
    const deleting = sql.begin(async (tx) => {
      await tx`select id from media where id in ${tx(ids)} for update`;
      held();
      await gate;
    });
    await holding;
    return async () => {
      release();
      await deleting;
    };
  }

  test("the run never waits for a picture: a delete holding the pictures of a row it moves and of one it sets aside does not hold it up — no row that shows a picture is updated twice (D1³)", async () => {
    // A second update of a row in one transaction makes PostgreSQL check its
    // picture again, which locks the picture after the SEO table — the
    // opposite of a delete, which holds the picture and then clears the rows.
    const [{ id }] = await sql<{ id: number }[]>`select id from travel_packages where slug = 'red-sea-sharm-el-sheikh'`;
    await write("red sea's row at an old address", "package", "red-sea-before-the-deploy", id);
    await showing("red sea's row at an old address", await picture("d1-moved.webp"));
    await write("a hand-made key that shows a picture", "package", `#${id}`, null);
    await showing("a hand-made key that shows a picture", await picture("d1-hand-made.webp"));
    const pictures = (
      await sql<{ og_image_id: number }[]>`
        select og_image_id from seo_metadata
         where id in (${rows["red sea's row at an old address"]!}, ${rows["a hand-made key that shows a picture"]!})`
    ).map((row) => row.og_image_id);

    const release = await holdPictures(pictures);
    const run = migrateInBackground();
    let seen: string | null = null;
    try {
      seen = await untilWaiting(run, { "a picture": "%update seo_metadata%" });
    } finally {
      await release();
    }
    assert.equal(seen, null, "the run waited for a picture a delete was holding");
    const result = await run.done;
    assert.equal(result.code, 0, result.output);
    assert.match(result.output, /SEO records: 0 bound, 1 moved to their record's address, 1 set aside\.\n/);
    assert.deepEqual(keyAndId(await rowOf("red sea's row at an old address")), { entity_key: "red-sea-sharm-el-sheikh", entity_id: id });
    assert.deepEqual(keyAndId(await rowOf("a hand-made key that shows a picture")), setAside("a hand-made key that shows a picture"));
  });

  test("rows that hold each other's addresses swap back in one run when one of them shows no picture, and wait at their records' own keys when every one does — the next run finishes them (D1³)", async () => {
    const packages: Record<string, number> = {};
    for (const slug of ["ring-a", "ring-b", "ring-c", "ring-d"]) {
      const [row] = await sql<{ id: number }[]>`insert into travel_packages (slug, title_en) values (${slug}, ${slug}) returning id`;
      packages[slug] = row!.id;
    }
    // Each pair's records swapped addresses under the previous release.
    await write("a's row at b", "package", "ring-b", packages["ring-a"]!);
    await write("b's row at a", "package", "ring-a", packages["ring-b"]!);
    await write("c's row at d", "package", "ring-d", packages["ring-c"]!);
    await write("d's row at c", "package", "ring-c", packages["ring-d"]!);
    const pictured = [await picture("ring-a.webp"), await picture("ring-b.webp"), await picture("ring-c.webp")];
    await showing("a's row at b", pictured[0]!);
    await showing("b's row at a", pictured[1]!);
    await showing("c's row at d", pictured[2]!);

    const release = await holdPictures(pictured);
    const run = migrateInBackground();
    let seen: string | null = null;
    try {
      seen = await untilWaiting(run, { "a picture": "%update seo_metadata%" });
    } finally {
      await release();
    }
    assert.equal(seen, null, "the run waited for a picture a delete was holding");
    const result = await run.done;
    assert.equal(result.code, 0, result.output);
    assert.match(
      result.output,
      /SEO records: 0 bound, 2 moved to their record's address, 0 set aside\. 2 left at their record's own key for the next deploy/,
    );
    // c and d: d has no picture, so it stepped aside to `#<id>` and came back.
    assert.deepEqual(keyAndId(await rowOf("c's row at d")), { entity_key: "ring-c", entity_id: packages["ring-c"] });
    assert.deepEqual(keyAndId(await rowOf("d's row at c")), { entity_key: "ring-d", entity_id: packages["ring-d"] });
    // a and b both show one: each waits at its record's own key, bound and in use.
    assert.deepEqual(keyAndId(await rowOf("a's row at b")), { entity_key: `#${packages["ring-a"]}`, entity_id: packages["ring-a"] });
    assert.deepEqual(keyAndId(await rowOf("b's row at a")), { entity_key: `#${packages["ring-b"]}`, entity_id: packages["ring-b"] });

    const next = migrate(database);
    assert.equal(next.code, 0, next.output);
    assert.match(next.output, /SEO records: 0 bound, 2 moved to their record's address, 0 set aside\.\n/);
    assert.deepEqual(keyAndId(await rowOf("a's row at b")), { entity_key: "ring-a", entity_id: packages["ring-a"] });
    assert.deepEqual(keyAndId(await rowOf("b's row at a")), { entity_key: "ring-b", entity_id: packages["ring-b"] });
  });

  test("still nothing deleted, and still nothing left to do", async () => {
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from seo_metadata`;
    assert.equal(n, Object.keys(rows).length);
    const again = migrate(database);
    assert.equal(again.code, 0, again.output);
    assert.match(again.output, /SEO records: nothing to reconcile\./);
  });
});
