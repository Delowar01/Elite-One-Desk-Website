/**
 * Batch 25 · F5 — a share image is a placed picture (docs/admin/seo-and-share-images.md
 * B.5, B.6 — brief §2–4, §20).
 *
 * The media library refuses to delete a picture something still shows. Until
 * Batch 25 that never included search and sharing: a picture chosen as a
 * page's share image, or as the site's default one, could be deleted as
 * unused, and the page's link previews lost it without a word (the column is
 * `ON DELETE SET NULL`). Every delete here goes through the library's own
 * Server Action, so what is proved is the server's check — whatever a screen
 * did or did not offer (§20).
 */
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { callAction } from "./helpers/action";
import { REPO_ROOT } from "./helpers/env";
import { giveFresh } from "./helpers/fixtures";
import { get } from "./helpers/http";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { BUILD_HINT, isBuilt, startServer, type Server } from "./helpers/server";
import { openSeoForm, withSeoChanges, type SeoFields } from "./helpers/seo-form";
import { signIn, type TestSession } from "./helpers/session";

const PORT = 3514;
const MEDIA_ACTIONS = "app/(backoffice)/admin/(shell)/media/actions.ts";
const SEO_ACTIONS = "app/(backoffice)/admin/(shell)/seo/actions.ts";
const PACKAGE_ACTIONS = "app/(backoffice)/admin/(shell)/packages/actions.ts";
/** Where the test servers keep uploads (`helpers/env.ts`) — shared, so every name here is this run's own. */
const UPLOADS = path.join(REPO_ROOT, ".data", "test-uploads");
const RUN = randomBytes(3).toString("hex");

let database = "";
let sql: Sql;
let server: Server;
let owner: TestSession;
let viewer: TestSession;
const ids: Record<string, number> = {};

type Answer = { ok: boolean; message?: string; conflicts?: string[] };

function formOf(fields: Record<string, string | number>, session: TestSession, csrf: string = session.csrfToken) {
  const data = new FormData();
  data.set("_csrf", csrf);
  for (const [key, value] of Object.entries(fields)) data.set(key, String(value));
  return data;
}

async function act(file: string, route: string, action: string, fields: Record<string, string | number>, session = owner, csrf?: string) {
  const response = await callAction<Answer>({
    origin: server.origin,
    route,
    file,
    action,
    args: [{ ok: false }, formOf(fields, session, csrf)],
    cookie: session.cookie,
  });
  return response.value;
}

/** The library's delete, as its button posts it. */
async function deleteMedia(id: number | string, session = owner, csrf?: string): Promise<Answer> {
  const answer = await act(MEDIA_ACTIONS, "/admin/media", "deleteMedia", { id }, session, csrf);
  assert.ok(answer, "deleteMedia returned nothing");
  return answer;
}

const open = (target: string) => openSeoForm(sql, server.origin, owner.cookie, target);
async function seo(action: "saveSeo" | "clearSeo", fields: SeoFields): Promise<Answer> {
  const answer = await act(SEO_ACTIONS, "/admin/seo", action, fields as Record<string, string | number>);
  assert.ok(answer, `${action} returned nothing`);
  return answer;
}
/** Chooses a share image for a target on the SEO screen. */
async function choose(target: string, picture: number | "") {
  const answer = await seo("saveSeo", withSeoChanges(await open(target), { ogImageId: picture }));
  assert.equal(answer.ok, true, `${target}: ${answer.message}`);
}

type Picture = { id: number; filename: string; file: string };

/** A picture in the library, with a file on disk where the library keeps it. */
async function picture(name: string): Promise<Picture> {
  const filename = `seo-media-${RUN}-${name}.webp`;
  const [row] = await sql<{ id: number }[]>`
    insert into media (filename, mime_type, title, width, height, derivatives)
    values (${filename}, 'image/webp', ${name}, 1600, 840, '[]'::jsonb) returning id`;
  mkdirSync(UPLOADS, { recursive: true });
  const file = path.join(UPLOADS, filename);
  writeFileSync(file, "a picture's bytes");
  return { id: row!.id, filename, file };
}

const inLibrary = async (picture: Picture) => (await sql`select 1 from media where id = ${picture.id}`).length === 1;

/** What the library card says: how many places the picture is used in. */
async function usesOnCard(picture: Picture): Promise<number> {
  const page = await get(server.origin, "/admin/media", { cookie: owner.cookie });
  const start = page.html.indexOf(`title="${picture.filename}"`);
  assert.ok(start >= 0, `${picture.filename} has no card`);
  const card = page.html.slice(start, page.html.indexOf("</li>", start));
  if (card.includes("Not placed anywhere yet")) return 0;
  const used = /Used in (?:<!-- -->)?(\d+)(?:<!-- -->)? place/.exec(card);
  assert.ok(used, `the card for ${picture.filename} says neither`);
  return Number(used[1]);
}

function assertRefused(answer: Answer, uses: string[]) {
  assert.equal(answer.ok, false, "the picture was deleted");
  const expected = `Still in use on ${uses.length} screen${uses.length === 1 ? "" : "s"}: ${uses.join(", ")}. Remove it there first.`;
  assert.equal(answer.message, expected);
}

/* -------------------------------------------------------------------------- */

before(async () => {
  assert.ok(isBuilt(), BUILD_HINT);
  database = giveFresh("seo_media");
  sql = connect(database);
  owner = await signIn(sql);
  await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    select 'seo-media-viewer@test.invalid', 'SEO media viewer', 'unused', id, true from roles where key = 'viewer'`;
  viewer = await signIn(sql, "viewer");
  for (const row of await sql<{ slug: string; id: number }[]>`select slug, id from service_categories`) ids[`category/${row.slug}`] = row.id;
  for (const row of await sql<{ slug: string; id: number }[]>`select slug, id from travel_packages`) ids[`package/${row.slug}`] = row.id;
  for (const row of await sql<{ slug: string; id: number }[]>`select slug, id from package_destinations`) ids[`destination/${row.slug}`] = row.id;
  server = await startServer(database, PORT);
});

after(async () => {
  await server?.stop();
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
});

/* -------------------------------------------------------------------------- */

describe("25 · F5: a share image in use cannot be deleted (B.5)", () => {
  test("a page's share image: refused, the page named, the library card counting it — the picture and its file untouched", async () => {
    const used = await picture("destination");
    assert.equal(await usesOnCard(used), 0);
    await choose(`destination:${ids["destination/egypt"]}`, used.id);

    assertRefused(await deleteMedia(used.id), ["Egypt — search and sharing image"]);
    assert.ok(await inLibrary(used));
    assert.ok(existsSync(used.file), "the file went although the row stayed");
    assert.equal(await usesOnCard(used), 1, "the card and the refusal disagree");
  });

  test("the site's default share image is placed while it is the default; once it is not, it goes — file and all", async () => {
    const fallback = await picture("site-default");
    await sql`update site_settings set value = jsonb_set(value, '{ogImageId}', to_jsonb(${fallback.id}::int)) where key = 'seo'`;
    assertRefused(await deleteMedia(fallback.id), ["Site default share image"]);
    assert.equal(await usesOnCard(fallback), 1);

    await sql`update site_settings set value = jsonb_set(value, '{ogImageId}', 'null') where key = 'seo'`;
    const deleted = await deleteMedia(fallback.id);
    assert.equal(deleted.ok, true, deleted.message);
    assert.ok(!(await inLibrary(fallback)));
    assert.ok(!existsSync(fallback.file), "the file outlived its row");
  });

  test("a picture two records share counts both, and stays protected until the last one lets it go", async () => {
    const shared = await picture("shared");
    const pkg = `package:${ids["package/cairo-and-giza-classic"]}`;
    const category = `category:${ids["category/business-setup"]}`;
    await choose(pkg, shared.id);
    await choose(category, shared.id);
    assertRefused(await deleteMedia(shared.id), ["Business Setup & Company Formation — search and sharing image", "Cairo & Giza Classic — search and sharing image"]);
    assert.equal(await usesOnCard(shared), 2);

    // One record removed whole…
    const opened = await open(pkg);
    assert.equal((await seo("clearSeo", { target: pkg, _base: opened._base! })).ok, true);
    assertRefused(await deleteMedia(shared.id), ["Business Setup & Company Formation — search and sharing image"]);
    // …the other keeps its record and lets go of the picture alone.
    await choose(category, "");
    assert.equal(await usesOnCard(shared), 0);
    assert.equal((await deleteMedia(shared.id)).ok, true);
    assert.ok(!(await inLibrary(shared)));
  });

  test("an unpublished page's record protects its picture: publishing the page makes the record live at once", async () => {
    const waiting = await picture("unpublished");
    const id = ids["package/nile-cruise-luxor-aswan"]!;
    await choose(`package:${id}`, waiting.id);
    await sql`update travel_packages set is_published = false where id = ${id}`;
    assertRefused(await deleteMedia(waiting.id), ["Nile Cruise — Luxor to Aswan — search and sharing image"]);
  });

  test("a row the previous release wrote by address, at a live record's address, is that record's — and protects its picture", async () => {
    const legacy = await picture("legacy");
    await sql`
      insert into seo_metadata (entity_type, entity_key, og_image_id) values ('category', 'iqama-services', ${legacy.id})`;
    assertRefused(await deleteMedia(legacy.id), ["Iqama & Employee Services — search and sharing image"]);
  });

  test("a page's own picture keeps the protection it always had", async () => {
    const [category] = await sql<{ image_id: number; title_en: string }[]>`select image_id, title_en from service_categories where slug = 'travel-tourism'`;
    const answer = await deleteMedia(category!.image_id);
    assert.equal(answer.ok, false);
    assert.match(answer.message ?? "", new RegExp(`^Still in use on \\d+ screens?: .*${category!.title_en.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });
});

describe("25 · F5: a record no page uses protects nothing (B.5)", () => {
  test("a detached row, a row bound to a record deleted since, and a dead row at an address nothing has — each picture goes, and the column empties", async () => {
    const detached = await picture("detached");
    const orphaned = await picture("orphaned");
    const dead = await picture("dead");
    const rows = await sql<{ id: number }[]>`
      insert into seo_metadata (entity_type, entity_key, entity_id, og_image_id) values
        ('page', ${`~${RUN}`}, 0, ${detached.id}),
        ('destination', ${`gone-${RUN}`}, 999999, ${orphaned.id}),
        ('package', ${`no-such-package-${RUN}`}, null, ${dead.id})
      returning id`;
    for (const unused of [detached, orphaned, dead]) {
      assert.equal(await usesOnCard(unused), 0, unused.filename);
      const answer = await deleteMedia(unused.id);
      assert.equal(answer.ok, true, `${unused.filename}: ${answer.message}`);
      assert.ok(!(await inLibrary(unused)));
    }
    const left = await sql<{ og_image_id: number | null }[]>`select og_image_id from seo_metadata where id in ${sql(rows.map((row) => row.id))}`;
    assert.equal(left.length, 3, "a picture's delete took a record with it");
    assert.ok(left.every((row) => row.og_image_id === null));
  });

  test("a record's own row shadowed by a newer row at its present address protects nothing: the page shows the newer row, and so does the guard", async () => {
    // The previous release moved the category and then saved its SEO by address,
    // without a picture: the newer row is the one the page uses (B.2).
    const shadowed = await picture("shadowed");
    await sql`
      insert into seo_metadata (entity_type, entity_key, entity_id, og_image_id)
      values ('category', ${`license-renewal-before-${RUN}`}, ${ids["category/license-renewal"]!}, ${shadowed.id})`;
    await sql`
      insert into seo_metadata (entity_type, entity_key, title_en) values ('category', 'license-renewal', 'Saved by address, without a picture')`;
    assert.equal(await usesOnCard(shadowed), 0);
    const answer = await deleteMedia(shadowed.id);
    assert.equal(answer.ok, true, answer.message);
    assert.ok(!(await inLibrary(shadowed)));
  });

  test("a record deleted with its page releases its picture", async () => {
    const released = await picture("released");
    const id = ids["package/red-sea-sharm-el-sheikh"]!;
    await choose(`package:${id}`, released.id);
    assertRefused(await deleteMedia(released.id), ["Red Sea — Sharm El Sheikh — search and sharing image"]);
    await act(PACKAGE_ACTIONS, `/admin/packages/${id}`, "deletePackage", { id });
    assert.equal((await sql`select 1 from travel_packages where id = ${id}`).length, 0, "the package was deleted");
    assert.equal((await deleteMedia(released.id)).ok, true);
  });
});

describe("25 · F5: the check is the server's (§20, §21)", () => {
  test("without media.manage, without the session's token, or with an id that is not one, nothing is deleted", async () => {
    const unused = await picture("authority");
    assert.equal((await deleteMedia(unused.id, viewer)).ok, false, "a viewer deleted a picture");
    const forged = await deleteMedia(unused.id, owner, "not-the-token");
    assert.equal(forged.ok, false);
    assert.match(forged.message ?? "", /This form expired/);
    for (const id of ["", "abc", "-1", "1.5", "0", `${unused.id} or 1=1`]) {
      const answer = await deleteMedia(id);
      assert.equal(answer.ok, false, JSON.stringify(id));
      assert.equal(answer.message, "That image no longer exists.", JSON.stringify(id));
    }
    assert.ok(await inLibrary(unused));
    assert.ok(existsSync(unused.file));
  });

  /**
   * A transaction of the test's own, holding one row lock until it is told to
   * let go — to put the save and the delete in a chosen order rather than
   * hoping a race falls one way. `held` resolves once the lock is taken.
   */
  function holdLock(statement: (tx: Sql) => Promise<unknown>) {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let taken!: () => void;
    const held = new Promise<void>((resolve) => (taken = resolve));
    const done = sql.begin(async (tx) => {
      await statement(tx as unknown as Sql);
      taken();
      await gate;
    });
    return { held, release: async () => (release(), await done) };
  }

  /**
   * Until another session of this file's own database waits for a lock: the
   * request just sent has reached it. The files run in parallel against one
   * server, each on its own database, so a wait anywhere else proves nothing.
   */
  async function untilWaiting() {
    for (let tries = 0; tries < 400; tries += 1) {
      const [row] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_stat_activity
         where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`;
      if (row!.n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("the request never reached the lock");
  }

  const egyptRecord = async () =>
    (
      await sql<{ og_image_id: number | null }[]>`
        select og_image_id from seo_metadata where entity_type = 'destination' and entity_id = ${ids["destination/egypt"]!}`
    )[0]?.og_image_id ?? null;

  test("the save takes the picture first: the delete waits for it, then counts the new use and refuses", async () => {
    const target = `destination:${ids["destination/egypt"]}`;
    const contested = await picture("save-first");
    const opened = await open(target);
    // FOR SHARE stops the delete's FOR UPDATE and lets the save's FOR KEY SHARE through.
    const lock = holdLock((tx) => tx`select 1 from media where id = ${contested.id} for share`);
    await lock.held;
    const deleting = deleteMedia(contested.id);
    await untilWaiting();
    const saved = await seo("saveSeo", withSeoChanges(opened, { ogImageId: contested.id }));
    assert.equal(saved.ok, true, saved.message);
    await lock.release();
    assertRefused(await deleting, ["Egypt — search and sharing image"]);
    assert.ok(await inLibrary(contested));
    assert.equal(await egyptRecord(), contested.id, "the saved choice was emptied");
  });

  test("the delete takes the picture first: the save waits for it, then is told the picture is gone — nothing points at it", async () => {
    const target = `destination:${ids["destination/egypt"]}`;
    const contested = await picture("delete-first");
    const before = await egyptRecord();
    const opened = await open(target);
    // Holding the destination stops the save before it reaches the picture.
    const lock = holdLock((tx) => tx`select 1 from package_destinations where id = ${ids["destination/egypt"]!} for update`);
    await lock.held;
    const saving = seo("saveSeo", withSeoChanges(opened, { ogImageId: contested.id }));
    await untilWaiting();
    const deleted = await deleteMedia(contested.id);
    assert.equal(deleted.ok, true, deleted.message);
    await lock.release();
    const saved = await saving;
    assert.equal(saved.ok, false);
    assert.match(saved.message ?? "", /^That picture is no longer in the media library/);
    assert.ok(!(await inLibrary(contested)));
    assert.equal(await egyptRecord(), before, "the refused save changed the record");
  });

  test("left to race: one of the two wins, never both — and a record that saved keeps its picture", async () => {
    const target = `destination:${ids["destination/egypt"]}`;
    const outcomes = { saved: 0, deleted: 0 };
    for (let round = 0; round < 12; round += 1) {
      const contested = await picture(`race-${round}`);
      const opened = await open(target);
      const [deleted, saved] = await Promise.all([
        deleteMedia(contested.id),
        seo("saveSeo", withSeoChanges(opened, { ogImageId: contested.id })),
      ]);
      assert.notEqual(deleted.ok, saved.ok, `round ${round}: delete ${JSON.stringify(deleted)}, save ${JSON.stringify(saved)}`);
      if (saved.ok) {
        outcomes.saved += 1;
        assertRefused(deleted, ["Egypt — search and sharing image"]);
        assert.ok(await inLibrary(contested), `round ${round}: the saved picture was deleted`);
        assert.equal(await egyptRecord(), contested.id, `round ${round}: the saved choice was emptied`);
      } else {
        outcomes.deleted += 1;
        assert.match(saved.message ?? "", /That picture is no longer in the media library/, `round ${round}`);
        assert.ok(!(await inLibrary(contested)));
        assert.notEqual(await egyptRecord(), contested.id);
      }
    }
    // Which side wins is the scheduler's business; the two tests above force each order.
    console.log(`[seo-media] race: ${outcomes.saved} saves won, ${outcomes.deleted} deletes won`);
  });

  test("a move committed while the delete counts cannot hide a use: the rows and the records are read at one moment (W5³)", async () => {
    // A service whose record shows a picture, and a dead row the previous
    // release left at the address the service is about to take.
    const [service] = await sql<{ id: number }[]>`select id from services where slug = 'airport-transfer'`;
    const shown = await picture("moved-while-counted");
    await sql`
      insert into seo_metadata (entity_type, entity_key, entity_id, og_image_id)
      values ('service', 'travel-tourism/airport-transfer', ${service!.id}, ${shown.id})`;
    await sql`insert into seo_metadata (entity_type, entity_key) values ('service', 'business-setup/airport-transfer')`;
    // The Services form's move, held open — with the site's settings, which the
    // delete reads straight after the SEO rows, so it stops there.
    const move = holdLock(async (tx) => {
      await tx`lock table site_settings in access exclusive mode`;
      await tx`update services set category_id = ${ids["category/business-setup"]!}, subcategory_id = null where id = ${service!.id}`;
      await tx`
        update seo_metadata set entity_id = 0, entity_key = '~' || id
         where entity_type = 'service' and entity_key = 'business-setup/airport-transfer'`;
      await tx`
        update seo_metadata set entity_key = 'business-setup/airport-transfer'
         where entity_type = 'service' and entity_id = ${service!.id}`;
    });
    await move.held;
    const deleting = deleteMedia(shown.id);
    await untilWaiting();
    await move.release();
    // Before the move and after it the service shows the picture: so does every
    // moment the delete could have read.
    assertRefused(await deleting, ["Airport Transfer — search and sharing image"]);
    assert.ok(await inLibrary(shown));
    const [row] = await sql<{ og_image_id: number | null }[]>`
      select og_image_id from seo_metadata where entity_type = 'service' and entity_id = ${service!.id}`;
    assert.equal(row!.og_image_id, shown.id, "the service's record lost its picture");
  });
});
