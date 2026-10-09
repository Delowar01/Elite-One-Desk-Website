/**
 * Batch 26 · §14 — migration `0007` and the deploy's reconcile over a real
 * Batch 24 database.
 *
 * `seo-reconcile.test.ts` writes every row state by hand into a database this
 * release built. This file starts one step earlier: Batch 24 (`da96625`, the
 * base Batch 25 started from — migrations `0000`–`0006`) builds the database
 * with **its own** migrate and seed, from its own checkout, and SEO records are
 * written the way Batch 24's screen wrote them — by type and address, no
 * `entity_id`, some with a share image. Then this release's migrate runs, as a
 * deploy runs it: `0007`, the row-id backfill and the reconcile. Nothing may be
 * lost — not a row, not a word, not a share image — every record's row must be
 * bound to its record, a dead row set aside rather than deleted, and a second
 * run must change nothing at all.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { REPO_ROOT, dbUrl, scriptEnv, uniqueName } from "./helpers/env";
import { removeWorktree, worktreeAt } from "./helpers/fixtures";
import { connect, dropDatabase, dumpData, recreateDatabase, type Sql } from "./helpers/pg";
import { migrate } from "./helpers/run";

/** Batch 24 as merged — the schema Batch 25's `0007` upgrades. */
const BATCH_24 = "da9662545016aab417e5ae6c50e92b520fc59217";
const WORK = path.join(REPO_ROOT, ".data", "test");
const TREE = path.join(WORK, `batch-24-tree-${process.pid}`);
/** Batch 24's seed writes the shipped artwork; never into the directory other test files serve from. */
const UPLOADS = path.join(WORK, `batch-24-uploads-${process.pid}`);

let database = "";
let sql: Sql;

before(() => {
  worktreeAt(BATCH_24, TREE);
  mkdirSync(UPLOADS, { recursive: true });
  database = uniqueName("b24_upgrade");
  recreateDatabase(database);
  for (const script of ["scripts/migrate.ts", "scripts/seed.ts"]) {
    const result = spawnSync("npx", ["tsx", script], {
      cwd: TREE,
      encoding: "utf8",
      env: scriptEnv(dbUrl(database), { UPLOAD_DIR: UPLOADS }),
      maxBuffer: 32 * 1024 * 1024,
    });
    assert.equal(result.status, 0, `Batch 24's ${script} failed: ${result.stderr || result.stdout}`);
  }
  sql = connect(database);
});

after(async () => {
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
  removeWorktree(TREE);
  rmSync(UPLOADS, { recursive: true, force: true });
});

type Stored = { id: number; entity_type: string; entity_key: string; title_en: string; description_en: string; og_image_id: number | null; noindex: boolean };

describe("26 · migration 0007 over a Batch 24 database that holds SEO records (§14)", () => {
  test("every record keeps its row, its words and its share image, bound to its record; a dead row is set aside, never deleted; a second run changes nothing", async () => {
    const [{ applied }] = await sql<{ applied: number }[]>`select count(*)::int as applied from drizzle.__drizzle_migrations`;
    assert.equal(applied, 7, "Batch 24 is migrations 0000–0006");
    const columns = (await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns where table_name = 'seo_metadata'`).map((row) => row.column_name);
    assert.ok(!columns.includes("entity_id"), "the database is already at 0007");

    const one = async <T,>(query: Promise<T[]>) => (await query)[0]!;
    const artwork = await one(sql<{ id: number }[]>`select id from media order by id limit 1`);
    const other = await one(sql<{ id: number }[]>`select id from media order by id desc limit 1`);
    const category = await one(sql<{ id: number; slug: string }[]>`select id, slug from service_categories where is_published order by id limit 1`);
    const service = await one(sql<{ id: number; address: string }[]>`
      select s.id, c.slug || '/' || s.slug as address from services s join service_categories c on c.id = s.category_id
       where s.is_published and c.is_published order by s.id limit 1`);
    const tour = await one(sql<{ id: number; slug: string }[]>`select id, slug from travel_packages order by id limit 1`);
    const destination = await one(sql<{ id: number; slug: string }[]>`select id, slug from package_destinations order by id limit 1`);
    const about = await one(sql<{ id: number }[]>`select id from pages where slug = 'about'`);

    // As Batch 24's screen saved them: by type and address, with its columns only.
    const written: Array<{ label: string; type: string; key: string; image: number | null; record: number | null }> = [
      { label: "a page with a share image", type: "page", key: "about", image: artwork.id, record: about.id },
      { label: "a category with a share image", type: "category", key: category.slug, image: other.id, record: category.id },
      { label: "a service, by its category's address", type: "service", key: service.address, image: null, record: service.id },
      { label: "a package with a share image", type: "package", key: tour.slug, image: artwork.id, record: tour.id },
      { label: "a destination", type: "destination", key: destination.slug, image: null, record: destination.id },
      { label: "the services overview", type: "page", key: "services", image: other.id, record: null },
      { label: "an address no record has", type: "package", key: "no-such-package", image: artwork.id, record: null },
    ];
    for (const row of written) {
      await sql`
        insert into seo_metadata (entity_type, entity_key, title_en, description_en, og_image_id, noindex)
        values (${row.type}, ${row.key}, ${row.label}, ${`Words for ${row.label}`}, ${row.image}, ${row.type === "destination"})`;
    }
    const before = await sql<Stored[]>`
      select id, entity_type, entity_key, title_en, description_en, og_image_id, noindex from seo_metadata order by id`;
    assert.equal(before.length, written.length);

    const first = migrate(database);
    assert.equal(first.code, 0, first.output.slice(-2000));
    assert.match(first.output, /SEO records:/);

    const afterRows = await sql<(Stored & { entity_id: number | null; og_title_ar: string; og_description_ar: string })[]>`
      select id, entity_type, entity_key, entity_id, title_en, description_en, og_image_id, noindex, og_title_ar, og_description_ar
        from seo_metadata order by id`;
    assert.equal(afterRows.length, before.length, "a row was lost");
    for (const [index, row] of written.entries()) {
      const was = before[index]!;
      const now = afterRows.find((candidate) => candidate.id === was.id);
      assert.ok(now, `${row.label}: its row is gone`);
      // Its words and its picture, exactly as they were.
      assert.equal(now.title_en, was.title_en, row.label);
      assert.equal(now.description_en, was.description_en, row.label);
      assert.equal(now.og_image_id, was.og_image_id, `${row.label}: its share image changed`);
      assert.equal(now.noindex, was.noindex, row.label);
      assert.equal(now.og_title_ar, "", row.label);
      assert.equal(now.og_description_ar, "", row.label);
      if (row.record !== null) {
        // Bound to its record, at its address.
        assert.equal(now.entity_id, row.record, `${row.label}: not bound to its record`);
        assert.equal(now.entity_key, row.key, `${row.label}: moved off its address`);
      } else if (row.label === "the services overview") {
        assert.equal(now.entity_id, null, "an overview has no record to be bound to");
        assert.equal(now.entity_key, "services");
      } else {
        // Dead: kept, detached, keyed by its own id.
        assert.deepEqual({ key: now.entity_key, id: now.entity_id }, { key: `~${now.id}`, id: 0 }, `${row.label}: not set aside`);
      }
    }
    const [{ applied: now }] = await sql<{ applied: number }[]>`select count(*)::int as applied from drizzle.__drizzle_migrations`;
    assert.equal(now, 8, "0007 was not applied");

    // A second run, as the next deploy runs it: nothing to do, nothing written.
    const snapshot = dumpData(database);
    const second = migrate(database);
    assert.equal(second.code, 0, second.output.slice(-2000));
    assert.match(second.output, /SEO records: nothing to reconcile\./);
    assert.equal(dumpData(database), snapshot, "a second run changed something");
  });
});
