/**
 * The granular-permission upgrade (Batch 18), on real databases.
 *
 * The upgrade is the seed's one-time introduction of a key, which deploy step 9
 * runs after the migrations. For the keys that split `content.manage` and
 * `content.view`, introduction into a role that already exists is by
 * **derivation** — exactly the roles that held the source key receive it —
 * rather than by the defaults a new role of that name would get, so every
 * owner decision made before the release carries through it.
 *
 * Two starting points, because both exist:
 *
 *   · the release in production (`deploy/previous-release`), migrated and
 *     seeded by **its own** scripts from its own checkout — the database a real
 *     deploy upgrades, without `visual_editor.view` or any Batch 17 table rows;
 *   · a Batch 17 database — this release's fixture with the new keys taken out
 *     again — which is what a development install at c5a34a5 upgrades from.
 *
 * Each is customised the way an owner would have customised it, upgraded with
 * this release's migrate and seed, and then checked key by key. The
 * expectations are written out here rather than read from `INTRODUCED_FROM`,
 * so the test is not the implementation agreeing with itself.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { REPO_ROOT, dbUrl, scriptEnv, uniqueName } from "./helpers/env";
import { compatTree, giveFresh } from "./helpers/fixtures";
import { connect, dropDatabase, dumpDatabase, recreateDatabase, restoreDatabase, type Sql } from "./helpers/pg";
import { migrate, seed } from "./helpers/run";

import { INTRODUCED_FROM, PERMISSIONS, ROLE_DEFAULTS } from "@/lib/auth/permissions";

/** Written out independently of the implementation's table. */
const FROM_MANAGE = [
  "content.edit",
  "content.style",
  "content.advanced_style",
  "content.motion",
  "content.structure",
  "content.publish",
  "components.edit",
  "components.publish",
  "components.lifecycle",
];
const FROM_VIEW = ["components.view"];
const NEW_KEYS = [...FROM_MANAGE, ...FROM_VIEW];

const created: string[] = [];
const WORK = path.join(REPO_ROOT, ".data", "test");
const PREVIOUS_DUMP = path.join(WORK, `b18-previous-release-${process.pid}.sql`);
/** The keys the production release's own catalogue had. */
let previousCatalogue: string[] = [];

after(() => {
  for (const name of created) dropDatabase(name);
  rmSync(PREVIOUS_DUMP, { force: true });
});

/** The production release, migrated and seeded by its own code, from its own checkout. */
before(() => {
  const tree = compatTree();
  const scratch = uniqueName("b18_previous");
  recreateDatabase(scratch);
  try {
    for (const script of ["scripts/migrate.ts", "scripts/seed.ts"]) {
      const result = spawnSync("npx", ["tsx", script], {
        cwd: tree,
        encoding: "utf8",
        env: scriptEnv(dbUrl(scratch)),
        maxBuffer: 32 * 1024 * 1024,
      });
      assert.equal(result.status, 0, `the previous release's ${script} failed: ${result.stderr || result.stdout}`);
    }
    mkdirSync(WORK, { recursive: true });
    dumpDatabase(scratch, PREVIOUS_DUMP);
  } finally {
    dropDatabase(scratch);
  }
});

function previousRelease(label: string): string {
  const name = uniqueName(label);
  restoreDatabase(name, PREVIOUS_DUMP);
  created.push(name);
  return name;
}

type Grants = Map<string, Set<string>>;

async function grantsOf(sql: Sql): Promise<Grants> {
  const rows = await sql<{ role: string; key: string }[]>`
    select r.key as role, p.key
      from roles r
      join role_permissions rp on rp.role_id = r.id
      join permissions p on p.id = rp.permission_id`;
  const byRole: Grants = new Map([["owner", new Set()], ["admin", new Set()], ["editor", new Set()], ["viewer", new Set()]]);
  for (const row of rows) byRole.get(row.role)!.add(row.key);
  return byRole;
}

const sorted = (set: Iterable<string>) => [...set].sort();

async function setGrant(sql: Sql, role: string, key: string, held: boolean) {
  if (held) {
    await sql`
      insert into role_permissions (role_id, permission_id)
      select r.id, p.id from roles r, permissions p where r.key = ${role} and p.key = ${key}
      on conflict do nothing`;
  } else {
    await sql`
      delete from role_permissions
       where role_id = (select id from roles where key = ${role})
         and permission_id = (select id from permissions where key = ${key})`;
  }
}

/** What derivation gives a role that held `before`. */
function derived(role: string, before: Set<string>): string[] {
  if (role === "owner") return NEW_KEYS;
  return [...(before.has("content.manage") ? FROM_MANAGE : []), ...(before.has("content.view") ? FROM_VIEW : [])];
}

/* ========================================================================== */

describe("the derivation table is the one this test expects", () => {
  test("content.manage splits into the nine page and component writes; content.view gives the component reads", () => {
    const expected = Object.fromEntries([
      ...FROM_MANAGE.map((key) => [key, "content.manage"]),
      ...FROM_VIEW.map((key) => [key, "content.view"]),
    ]);
    assert.deepEqual(INTRODUCED_FROM, expected);
    for (const key of NEW_KEYS) assert.ok(PERMISSIONS.some((entry) => entry.key === key), `${key} is not in the catalogue`);
    assert.ok(PERMISSIONS.some((entry) => entry.key === "content.manage"), "content.manage was deleted from the catalogue");
  });

  test("a fresh installation: every role gets its defaults, and the Editor holds the whole split and the legacy key", async () => {
    const fresh = giveFresh("b18_fresh_defaults");
    created.push(fresh);
    const sql = connect(fresh);
    try {
      const grants = await grantsOf(sql);
      for (const role of ["owner", "admin", "editor", "viewer"]) {
        assert.deepEqual(sorted(grants.get(role)!), sorted(ROLE_DEFAULTS[role]!), `${role} does not hold its defaults`);
      }
      for (const key of [...NEW_KEYS, "content.manage"]) assert.ok(grants.get("editor")!.has(key), `a fresh Editor lacks ${key}`);
      assert.deepEqual(sorted(grants.get("viewer")!), sorted(["dashboard.view", "enquiries.view", "content.view", "visual_editor.view", "components.view"]));
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

/* ========================================================================== */

describe("34–35 · upgrading the release in production", () => {
  test("34 · every role keeps what it had, gains exactly its split, and customised roles stay customised", async () => {
    const database = previousRelease("b18_upgrade");
    const sql = connect(database);
    try {
      previousCatalogue = (await sql<{ key: string }[]>`select key from permissions order by key`).map((row) => row.key);
      assert.ok(previousCatalogue.includes("content.manage"));
      for (const key of [...NEW_KEYS, "visual_editor.view"]) {
        assert.ok(!previousCatalogue.includes(key), `the previous release already had ${key} — this is not the database a deploy upgrades`);
      }

      // What an owner has done to the roles in production before this release.
      await setGrant(sql, "admin", "content.manage", false); // admins may not edit pages
      await setGrant(sql, "viewer", "content.manage", true); // viewers were trusted to edit
      await setGrant(sql, "editor", "media.manage", false); // an unrelated decision
      const before = await grantsOf(sql);

      const migrated = migrate(database);
      assert.equal(migrated.code, 0, migrated.output);
      const seeded = seed(database);
      assert.equal(seeded.code, 0, seeded.output);
      const after = await grantsOf(sql);

      for (const role of ["owner", "admin", "editor", "viewer"]) {
        const had = before.get(role)!;
        // visual_editor.view arrives through the defaults, as it always did.
        const expected = new Set([...had, "visual_editor.view", ...derived(role, had)]);
        assert.deepEqual(sorted(after.get(role)!), sorted(expected), `${role} was not upgraded exactly`);
        // Nothing from the previous release's catalogue moved in either direction.
        for (const key of previousCatalogue) {
          assert.equal(after.get(role)!.has(key), had.has(key), `${role}'s ${key} changed in the upgrade`);
        }
      }
      // The two customisations, spelled out.
      for (const key of FROM_MANAGE) {
        assert.ok(!after.get("admin")!.has(key), `an admin without content.manage gained ${key}`);
        assert.ok(after.get("viewer")!.has(key), `a viewer trusted with content.manage lost ${key}`);
      }
      assert.ok(!after.get("editor")!.has("media.manage"), "a removed grant came back");
      assert.ok(after.get("admin")!.has("components.view"), "reading components came from content.view");
      // content.manage kept wherever it was — a rollback still finds it.
      for (const role of ["owner", "editor", "viewer"]) assert.ok(after.get(role)!.has("content.manage"), `${role} lost content.manage`);
      // The catalogue gained keys and lost none.
      const catalogue = (await sql<{ key: string; group_name: string }[]>`select key, group_name from permissions`);
      for (const key of previousCatalogue) assert.ok(catalogue.some((row) => row.key === key), `${key} left the catalogue`);
      assert.equal(catalogue.find((row) => row.key === "content.manage")?.group_name, "Legacy");
      for (const key of FROM_VIEW.concat(["components.edit", "components.publish", "components.lifecycle"])) {
        assert.equal(catalogue.find((row) => row.key === key)?.group_name, "Reusable components");
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  });

  test("35 · running the upgrade again changes nothing, and a grant removed afterwards stays removed", async () => {
    const database = previousRelease("b18_rerun");
    const sql = connect(database);
    try {
      assert.equal(migrate(database).code, 0);
      assert.equal(seed(database).code, 0);
      const first = await grantsOf(sql);

      assert.equal(seed(database).code, 0);
      assert.equal(migrate(database).code, 0);
      assert.equal(seed(database).code, 0);
      const again = await grantsOf(sql);
      for (const role of ["owner", "admin", "editor", "viewer"]) {
        assert.deepEqual(sorted(again.get(role)!), sorted(first.get(role)!), `a second run changed ${role}`);
      }

      // An owner removes page publishing from the Editor and component reading
      // from the Viewer, and empties the Admin role entirely.
      await setGrant(sql, "editor", "content.publish", false);
      await setGrant(sql, "viewer", "components.view", false);
      await sql`delete from role_permissions where role_id = (select id from roles where key = 'admin')`;
      const decided = await grantsOf(sql);

      for (let run = 0; run < 2; run += 1) {
        assert.equal(migrate(database).code, 0);
        assert.equal(seed(database).code, 0);
      }
      const later = await grantsOf(sql);
      assert.ok(!later.get("editor")!.has("content.publish"), "the seed handed content.publish back");
      assert.ok(!later.get("viewer")!.has("components.view"), "the seed handed components.view back");
      assert.deepEqual(sorted(later.get("admin")!), [], "an emptied role was refilled");
      for (const role of ["owner", "admin", "editor", "viewer"]) {
        assert.deepEqual(sorted(later.get(role)!), sorted(decided.get(role)!), `${role} changed on a later deploy`);
      }
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

/* ========================================================================== */

describe("34 · upgrading a Batch 17 database", () => {
  test("the split is derived from what each role held, and visual_editor.view is not re-introduced", async () => {
    const database = giveFresh("b18_from_b17");
    created.push(database);
    const sql = connect(database);
    try {
      // This release's database with the new keys taken out again: Batch 17.
      await sql`delete from permissions where key = any(${NEW_KEYS})`;
      // A Batch 17 owner's decisions: the Editor may view but not edit pages;
      // the Viewer may edit them; the Admin may edit but — incoherently — not view.
      await setGrant(sql, "editor", "content.manage", false);
      await setGrant(sql, "viewer", "content.manage", true);
      await setGrant(sql, "admin", "content.view", false);
      const before = await grantsOf(sql);

      assert.equal(seed(database).code, 0);
      const after = await grantsOf(sql);
      for (const role of ["owner", "admin", "editor", "viewer"]) {
        const had = before.get(role)!;
        const expected = new Set([...had, ...derived(role, had)]);
        assert.deepEqual(sorted(after.get(role)!), sorted(expected), `${role} was not upgraded exactly`);
      }
      assert.ok(!after.get("editor")!.has("content.edit"), "an Editor without content.manage gained editing");
      assert.ok(after.get("editor")!.has("components.view"));
      assert.ok(after.get("viewer")!.has("content.publish"), "a Viewer with content.manage lost publishing");
      // The incoherent role keeps its decision: the write keys arrive, and stay
      // inert without content.view, which it never had and does not gain.
      assert.ok(after.get("admin")!.has("content.edit"));
      assert.ok(!after.get("admin")!.has("content.view"));
      assert.ok(!after.get("admin")!.has("components.view"));
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});

/* ========================================================================== */

describe("18 · rollback compatibility, as data", () => {
  test("after the upgrade the previous release still finds content.manage on every role that used it", async () => {
    const database = previousRelease("b18_rollback");
    const sql = connect(database);
    try {
      const before = await grantsOf(sql);
      assert.equal(migrate(database).code, 0);
      assert.equal(seed(database).code, 0);
      const after = await grantsOf(sql);
      // The previous release authorizes every page write with content.manage and
      // reads nothing else for it: each role that could edit before still can there.
      for (const role of ["owner", "admin", "editor", "viewer"]) {
        assert.equal(after.get(role)!.has("content.manage"), before.get(role)!.has("content.manage"), role);
        assert.equal(after.get(role)!.has("content.view"), before.get(role)!.has("content.view"), role);
      }
      // A role an owner later sets up with the granular keys alone has no
      // content.manage — so, after a rollback, the previous release refuses its
      // page writes. That is the documented consequence, not a failure.
      await sql`delete from role_permissions where role_id = (select id from roles where key = 'editor')`;
      for (const key of ["dashboard.view", "content.view", "visual_editor.view", "content.edit"]) await setGrant(sql, "editor", key, true);
      const granular = (await grantsOf(sql)).get("editor")!;
      assert.ok(!granular.has("content.manage"));
      assert.ok(granular.has("content.edit"));
    } finally {
      await sql.end({ timeout: 5 });
    }
  });
});
