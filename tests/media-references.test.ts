/**
 * Batch 26 · §3–§5 — a picture named outside a foreign key is held by the
 * write that names it until that write commits, so the media library's delete
 * and a write can no longer pass each other (docs/release/release-hardening-batch-26.md).
 *
 * Every race here is forced, never hoped for. Two gates, armed by the test
 * and invisible otherwise:
 *
 *   · the COMMIT gate — a deferred constraint trigger on a table asks for a
 *     shared advisory lock at commit, which the test holds exclusively while
 *     the gate is armed. A write stopped there has done everything it does and
 *     holds every lock it took; a delete stopped there has deleted the picture
 *     in its own transaction;
 *   · the INSERT gate — the same, before an insert: a copy stopped there has
 *     read its source and taken nothing yet.
 *
 * "The write first": the write is stopped at its commit, the delete is sent and
 * must be seen waiting — on the write, for the picture — and only then is the
 * write let go. "The delete first": the delete is stopped at its commit with
 * the picture gone, the write is sent and must be seen waiting for it. A write
 * that did not hold its pictures would not make the delete wait, and the test
 * would say so; nothing here passes on timing.
 *
 * Every write and every delete goes through its own Server Action, as the
 * screens post them, against a production build (§20: nothing relies on what
 * the browser was shown). After each race, no stored value names a picture the
 * library no longer has.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { callAction } from "./helpers/action";
import { REPO_ROOT, dbUrl, scriptEnv } from "./helpers/env";
import { giveFresh } from "./helpers/fixtures";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { BUILD_HINT, isBuilt, startServer, type Server } from "./helpers/server";
import { signIn, type TestSession } from "./helpers/session";

import { getBlock } from "@/lib/cms/blocks";
import { componentMediaIds, sectionMediaIds } from "@/lib/cms/media-refs";
import { emptyValues } from "@/lib/cms/values";
import { documentEditorKey, editorKeyOf, parseOwnerKey, type RouteOwner } from "@/lib/routes/owners";
import { mediaIdsOfPatches, type StoredPatch } from "@/lib/routes/specs";

const PORT = 3526;
const VE = "app/(backoffice)/admin/visual-editor/actions.ts";
const ROUTES = "app/(backoffice)/admin/visual-editor/route-actions.ts";
const PAGES = "app/(backoffice)/admin/(shell)/pages/actions.ts";
const COMPONENTS = "app/(backoffice)/admin/(shell)/components/actions.ts";
const MEDIA = "app/(backoffice)/admin/(shell)/media/actions.ts";
const RUN = randomBytes(3).toString("hex");
/**
 * This file's own upload directory, for its server and for the seed it runs:
 * the seed race deletes a piece of shipped artwork, and the shared directory
 * (`helpers/env.ts`) is read by every other test file at the same time.
 */
const UPLOADS = path.join(REPO_ROOT, ".data", "test", `uploads-media-refs-${RUN}`);
const COMMIT_GATE = 26026;
const INSERT_GATE = 26027;

let database = "";
let sql: Sql;
let server: Server;
let owner: TestSession;

type Answer = { ok: boolean; reason?: string; message?: string; [key: string]: unknown };
type Values = Record<string, unknown>;
type Picture = { id: number; filename: string };

const GONE = /no longer in the media library/;
const IN_USE = /^Still in use on /;

/* -------------------------------------------------------------------------- */
/* The real actions, as the screens post them                                  */
/* -------------------------------------------------------------------------- */

function formOf(fields: Record<string, string | number>): FormData {
  const data = new FormData();
  data.set("_csrf", owner.csrfToken);
  for (const [key, value] of Object.entries(fields)) data.set(key, String(value));
  return data;
}

async function call(file: string, route: string, action: string, args: unknown[]): Promise<Answer> {
  const response = await callAction<Answer>({ origin: server.origin, route, file, action, args, cookie: owner.cookie });
  assert.ok(response.value, `${action} answered nothing (HTTP ${response.status}): ${response.text.slice(0, 300)}`);
  return response.value;
}

const editor = (action: string, fields: Record<string, string | number>) => call(VE, "/admin/visual-editor", action, [formOf(fields)]);
const routeEditor = (action: string, fields: Record<string, string | number>) =>
  call(ROUTES, "/admin/visual-editor", action, [formOf(fields)]);
const pagesScreen = (action: string, fields: Record<string, string | number>) =>
  call(PAGES, "/admin/pages", action, [{ ok: false }, formOf(fields)]);
const components = (action: string, fields: Record<string, string | number>) =>
  call(COMPONENTS, "/admin/components", action, [formOf(fields)]);
const deleteMedia = (picture: Picture) => call(MEDIA, "/admin/media", "deleteMedia", [{ ok: false }, formOf({ id: picture.id })]);

/* -------------------------------------------------------------------------- */
/* Pictures, pages, components                                                 */
/* -------------------------------------------------------------------------- */

/** A picture in the library, with a file where the library keeps it. */
async function picture(name: string): Promise<Picture> {
  const filename = `media-refs-${RUN}-${name}.webp`;
  const [row] = await sql<{ id: number }[]>`
    insert into media (filename, mime_type, title, width, height, derivatives)
    values (${filename}, 'image/webp', ${name}, 1600, 900, '[]'::jsonb) returning id`;
  mkdirSync(UPLOADS, { recursive: true });
  writeFileSync(path.join(UPLOADS, filename), "a picture's bytes");
  return { id: row!.id, filename };
}

const inLibrary = async (picture: Picture) => (await sql`select 1 from media where id = ${picture.id}`).length === 1;

const IMAGE_TEXT = getBlock("image-text")!;
const imageText = (image: number | null, title = "A picture and its words"): Values => ({
  ...emptyValues(IMAGE_TEXT),
  title: { en: title, ar: "" },
  image,
});

let pages = 0;
/** A published page of its own with one image-text section, nothing pending: every race starts clean. */
async function freshPage(image: number | null = null): Promise<{ pageId: number; sectionId: number }> {
  pages += 1;
  const slug = `media-refs-${RUN}-${pages}`;
  const [page] = await sql<{ id: number }[]>`
    insert into pages (slug, kind, title_en, is_published) values (${slug}, 'custom', ${slug}, true) returning id`;
  const [section] = await sql<{ id: number }[]>`
    insert into page_sections (page_id, block_type, position, is_published, published)
    values (${page!.id}, 'image-text', 0, true, ${sql.json(imageText(image) as never)}) returning id`;
  return { pageId: page!.id, sectionId: section!.id };
}

const section = async (id: number) =>
  (
    await sql<{ revision: number; published: Values; draft: Values | null; page_id: number }[]>`
      select revision, published, draft, page_id from page_sections where id = ${id}`
  )[0]!;
const pageRevision = async (id: number) => (await sql<{ revision: number }[]>`select revision from pages where id = ${id}`)[0]!.revision;

/** A published image-text component showing `image`. */
async function freshComponent(image: number | null): Promise<number> {
  const [row] = await sql<{ id: number }[]>`
    insert into reusable_components (kind, name, published, published_version, published_at)
    values ('block:image-text', ${`Media refs ${RUN} ${randomBytes(2).toString("hex")}`}, ${sql.json(imageText(image) as never)}, 1, now())
    returning id`;
  return row!.id;
}
const component = async (id: number) =>
  (
    await sql<{ revision: number; published: Values | null; draft: Values | null }[]>`
      select revision, published, draft from reusable_components where id = ${id}`
  )[0]!;

/* -------------------------------------------------------------------------- */
/* The gates                                                                   */
/* -------------------------------------------------------------------------- */

/** A change made elsewhere — by another person, another tab — which no gate stops. */
const elsewhere = (change: (tx: Sql) => Promise<unknown>) =>
  sql.begin(async (tx) => {
    await tx`set local b26.elsewhere = 'on'`;
    await change(tx as unknown as Sql);
  });

/** Arms a gate on `table`; the returned function lets it go (and is safe to call twice). */
async function arm(gate: "commit" | "insert", table: string): Promise<() => Promise<void>> {
  const keeper = await sql.reserve();
  const key = gate === "commit" ? COMMIT_GATE : INSERT_GATE;
  await keeper`select pg_advisory_lock(${key}::int, hashtext(${table}))`;
  let open = false;
  return async () => {
    if (open) return;
    open = true;
    await keeper`select pg_advisory_unlock(${key}::int, hashtext(${table}))`;
    keeper.release();
  };
}

/** Sessions of this file's own database waiting: at a gate, and on a row lock. */
async function waiting(): Promise<{ gates: number; rows: number }> {
  const rows = await sql<{ wait_event: string }[]>`
    select wait_event from pg_stat_activity
     where datname = current_database() and wait_event_type = 'Lock' and pid <> pg_backend_pid()`;
  return {
    gates: rows.filter((row) => row.wait_event === "advisory").length,
    rows: rows.filter((row) => row.wait_event !== "advisory").length,
  };
}

async function until(gates: number, rows: number, what: string, seconds = 15): Promise<void> {
  for (let tries = 0; tries < seconds * 40; tries += 1) {
    const now = await waiting();
    if (now.gates >= gates && now.rows >= rows) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`${what}: expected ${gates} at a gate and ${rows} on a row lock, saw ${JSON.stringify(await waiting())}`);
}

/**
 * The write first: stopped at its commit holding what it took; the delete sent
 * and seen waiting for it; then both let go.
 */
async function writeFirst(table: string, write: () => Promise<Answer>, picture: Picture) {
  const release = await arm("commit", table);
  try {
    const writing = write();
    await until(1, 0, "the write never reached its commit");
    const deleting = deleteMedia(picture);
    await until(1, 1, "the delete did not wait for the write — the write does not hold the picture");
    await release();
    return { written: await writing, deleted: await deleting };
  } finally {
    await release();
  }
}

/**
 * The delete first: stopped at its commit with the picture gone in its
 * transaction; the write sent and seen waiting for it; then both let go.
 */
async function deleteFirst(write: () => Promise<Answer>, picture: Picture) {
  const release = await arm("commit", "media");
  try {
    const deleting = deleteMedia(picture);
    await until(1, 0, "the delete never reached its commit");
    const writing = write();
    await until(1, 1, "the write did not wait for the delete — it does not hold the picture");
    await release();
    return { deleted: await deleting, written: await writing };
  } finally {
    await release();
  }
}

/**
 * Every stored value that names a picture the library does not have, by
 * declared field — page sections, reusable components, route drafts and the
 * site's default share image. Pictures a test removed from the library on
 * purpose before writing (`expected`) are not dangling.
 */
async function dangling(): Promise<string[]> {
  const library = new Set((await sql<{ id: number }[]>`select id from media`).map((row) => row.id));
  const out: string[] = [];
  for (const row of await sql<{ id: number; block_type: string; published: Values; draft: Values | null }[]>`
    select id, block_type, published, draft from page_sections`) {
    for (const id of [...sectionMediaIds(row.block_type, row.published), ...sectionMediaIds(row.block_type, row.draft)]) {
      if (!library.has(id)) out.push(`section ${row.id} → picture ${id}`);
    }
  }
  for (const row of await sql<{ id: number; kind: string; published: Values | null; draft: Values | null }[]>`
    select id, kind, published, draft from reusable_components`) {
    for (const id of [...componentMediaIds(row.kind, row.published), ...componentMediaIds(row.kind, row.draft)]) {
      if (!library.has(id)) out.push(`component ${row.id} → picture ${id}`);
    }
  }
  for (const row of await sql<{ owner_key: string; draft_content: StoredPatch | null }[]>`
    select owner_key, draft_content from route_nodes where draft_content is not null`) {
    const owner = parseOwnerKey(row.owner_key);
    if (!owner) continue;
    for (const id of mediaIdsOfPatches([[owner, row.draft_content ?? {}]])) {
      if (!library.has(id)) out.push(`region ${row.owner_key} → picture ${id}`);
    }
  }
  const [seo] = await sql<{ id: number | null }[]>`select (value ->> 'ogImageId')::int as id from site_settings where key = 'seo'`;
  if (seo?.id && !library.has(seo.id)) out.push(`site default share image → picture ${seo.id}`);
  return out;
}

const assertNothingDangles = async () => assert.deepEqual(await dangling(), [], "a stored value names a picture the library no longer has");

/* -------------------------------------------------------------------------- */

before(async () => {
  assert.ok(isBuilt(), BUILD_HINT);
  database = giveFresh("media_refs");
  sql = connect(database);
  owner = await signIn(sql);
  // The gates. Unarmed, each asks for a shared lock nobody holds and passes.
  await sql.unsafe(`
    create function b26_commit_gate() returns trigger language plpgsql as $$
    begin
      -- The test's own writes pass (\`elsewhere\`): only the writes under test stop.
      if current_setting('b26.elsewhere', true) = 'on' then return null; end if;
      perform pg_advisory_xact_lock_shared(${COMMIT_GATE}, hashtext(tg_table_name));
      return null;
    end $$;
    create function b26_insert_gate() returns trigger language plpgsql as $$
    begin
      perform pg_advisory_xact_lock_shared(${INSERT_GATE}, hashtext(tg_table_name));
      return new;
    end $$;
    create constraint trigger b26_commit_gate after insert or update or delete on page_sections
      deferrable initially deferred for each row execute function b26_commit_gate();
    create constraint trigger b26_commit_gate after insert or update or delete on reusable_components
      deferrable initially deferred for each row execute function b26_commit_gate();
    create constraint trigger b26_commit_gate after insert or update or delete on route_nodes
      deferrable initially deferred for each row execute function b26_commit_gate();
    create constraint trigger b26_commit_gate after delete on media
      deferrable initially deferred for each row execute function b26_commit_gate();
    create trigger b26_insert_gate before insert on page_sections for each row execute function b26_insert_gate();
    create trigger b26_insert_gate before insert on reusable_components for each row execute function b26_insert_gate();
  `);
  mkdirSync(UPLOADS, { recursive: true });
  server = await startServer(database, PORT, { env: { UPLOAD_DIR: UPLOADS } });
});

after(async () => {
  await server?.stop();
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
  rmSync(UPLOADS, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */

describe("26 · the delete counts every picture a write can name (X1)", () => {
  test("a Quick Links card's picture is counted — on the card, by the delete and on the library card", async () => {
    const card = await picture("quick-link-card");
    const [quick] = await sql<{ id: number; page_id: number; revision: number; published: Values }[]>`
      select s.id, s.page_id, s.revision, s.published from page_sections s join pages p on p.id = s.page_id
       where p.slug = 'home' and s.block_type = 'quick-links'`;
    const links = (quick!.published.links as Values[]).map((row, index) => (index === 1 ? { ...row, image: card.id } : row));
    const saved = await editor("saveVisualSectionDraft", {
      sectionId: quick!.id,
      pageId: quick!.page_id,
      expectedRevision: quick!.revision,
      values: JSON.stringify({ ...quick!.published, links }),
    });
    assert.equal(saved.ok, true, saved.message);
    const refused = await deleteMedia(card);
    assert.equal(refused.ok, false);
    assert.match(refused.message ?? "", /^Still in use on 1 screen: .+ — quick-links section\./);
    assert.ok(await inLibrary(card));
    const page = await fetch(`${server.origin}/admin/media`, { headers: { cookie: owner.cookie } });
    const html = await page.text();
    const start = html.indexOf(`title="${card.filename}"`);
    assert.ok(start >= 0, "the picture has no card");
    assert.match(html.slice(start, html.indexOf("</li>", start)), /Used in (?:<!-- -->)?1(?:<!-- -->)? place/);
  });

  test("one reading of a picture id: a crafted decimal in a card is stored as no picture, never as another; a hand-written 12.0 is counted as picture 12, and text never is", async () => {
    const card = await picture("quick-link-shapes");
    const [quick] = await sql<{ id: number; page_id: number; revision: number; published: Values; draft: Values | null }[]>`
      select s.id, s.page_id, s.revision, s.published, s.draft from page_sections s join pages p on p.id = s.page_id
       where p.slug = 'home' and s.block_type = 'quick-links'`;
    const base = (quick!.draft ?? quick!.published) as Values;
    // As a hand-made request would send it: picture 12.5 would have been drawn as picture 12.
    const links = (base.links as Values[]).map((row, index) =>
      index === 0 ? { ...row, image: card.id + 0.5 } : index === 2 ? { ...row, image: 1e21 } : row,
    );
    const saved = await editor("saveVisualSectionDraft", {
      sectionId: quick!.id,
      pageId: quick!.page_id,
      expectedRevision: quick!.revision,
      values: JSON.stringify({ ...base, links }),
    });
    assert.equal(saved.ok, true, saved.message);
    const stored = (await section(quick!.id)).draft!.links as Values[];
    assert.equal(stored[0]!.image, null, "a decimal was stored");
    assert.equal(stored[2]!.image, null, "an exponent was stored");

    // Numbers no writer stores, written by hand, one at a time: the delete
    // counts each as every reader takes it — JavaScript parses
    // 12.0000000000000001 as 12, and so draws picture 12.
    const { pageId } = await freshPage();
    const counted: Array<[string, string]> = [
      ["image-text", `{"image": ${card.id}.0}`],
      ["image-text", `{"image": ${card.id}.0000000000000001}`],
      ["quick-links", `{"links": [{"label": {"en": "A", "ar": ""}, "image": ${card.id}.0}]}`],
    ];
    for (const [blockType, shape] of counted) {
      // Through text, so the document is stored exactly as written (12.0 stays 12.0).
      const [row] = await sql<{ id: number }[]>`
        insert into page_sections (page_id, block_type, position, is_published, published)
        values (${pageId}, ${blockType}, 1, true, (${shape}::text)::jsonb) returning id`;
      try {
        const refused = await deleteMedia(card);
        assert.equal(refused.ok, false, `${shape}: the delete did not see it`);
        assert.match(refused.message ?? "", IN_USE, shape);
      } finally {
        await sql`delete from page_sections where id = ${row!.id}`;
      }
    }
    // Text is never a picture: a Statistics figure "N" is not picture N, nor is
    // a hand-written "N", and a document that is not an object names nothing —
    // none of them stops a delete. Nor does a number beyond a double, which
    // must never reach the count's cast: it would fail every delete.
    const notCounted: Array<[string, (id: number) => string]> = [
      ["stats", (id) => `{"items": [{"value": "${id}", "label": {"en": "Years", "ar": ""}}]}`],
      ["image-text", (id) => `{"image": "${id}"}`],
      ["image-text", (id) => `"${id}"`],
      ["image-text", () => `{"image": 1e-400, "limit": 1e-400}`],
    ];
    for (const [index, [blockType, shape]] of notCounted.entries()) {
      const other = await picture(`quick-link-shapes-${index}`);
      const [row] = await sql<{ id: number }[]>`
        insert into page_sections (page_id, block_type, position, is_published, published)
        values (${pageId}, ${blockType}, 1, true, (${shape(other.id)}::text)::jsonb) returning id`;
      try {
        const deleted = await deleteMedia(other);
        assert.equal(deleted.ok, true, `${shape(other.id)}: ${deleted.message}`);
      } finally {
        await sql`delete from page_sections where id = ${row!.id}`;
      }
    }
    // The card is undone, so the next tests find the home page as they expect it.
    await sql`update page_sections set draft = ${quick!.draft === null ? null : sql.json(quick!.draft as never)}, revision = revision + 1 where id = ${quick!.id}`;
  });

  test("a number that is not a picture is never held: a section's `limit` of an id that names nothing saves", async () => {
    const [grid] = await sql<{ id: number; page_id: number; revision: number; published: Values; block_type: string }[]>`
      select s.id, s.page_id, s.revision, s.published, s.block_type from page_sections s
       where s.block_type = 'service-grid' order by s.id limit 1`;
    assert.ok(grid, "a service grid to save");
    const [{ next }] = await sql<{ next: number }[]>`select coalesce(max(id), 0) + 50 as next from media`;
    const saved = await editor("saveVisualSectionDraft", {
      sectionId: grid.id,
      pageId: grid.page_id,
      expectedRevision: grid.revision,
      values: JSON.stringify({ ...grid.published, limit: Math.min(999, next!) }),
    });
    assert.equal(saved.ok, true, `${saved.message}`);
    // Put back: the count reads that `limit` as a picture (X2), and a picture
    // made later in this file would one day be given that id.
    await sql`update page_sections set draft = null, revision = revision + 1 where id = ${grid.id}`;
  });
});

describe("26 · Visual Editor content save — the autosave", () => {
  const save = async (sectionId: number, values: Values) => {
    const row = await section(sectionId);
    return () =>
      editor("saveVisualSectionDraft", { sectionId, pageId: row.page_id, expectedRevision: row.revision, values: JSON.stringify(values) });
  };

  test("the save first: the delete waits for it, then counts the new picture and refuses", async () => {
    const { sectionId } = await freshPage();
    const chosen = await picture("ve-save-first");
    const { written, deleted } = await writeFirst("page_sections", await save(sectionId, imageText(chosen.id)), chosen);
    assert.equal(written.ok, true, written.message);
    assert.equal(deleted.ok, false);
    assert.match(deleted.message ?? "", IN_USE);
    assert.ok(await inLibrary(chosen));
    assert.equal((await section(sectionId)).draft?.image, chosen.id);
    await assertNothingDangles();
  });

  test("the delete first: the save waits for it, finds the picture gone and refuses by name — nothing stored", async () => {
    const { sectionId } = await freshPage();
    const chosen = await picture("ve-delete-first");
    const before = await section(sectionId);
    const { deleted, written } = await deleteFirst(await save(sectionId, imageText(chosen.id)), chosen);
    assert.equal(deleted.ok, true, deleted.message);
    assert.equal(written.ok, false);
    assert.match(written.message ?? "", /The picture in “Image” is no longer in the media library\. Nothing was saved\./);
    assert.ok(!(await inLibrary(chosen)));
    const after = await section(sectionId);
    assert.equal(after.revision, before.revision, "the refused save moved the revision");
    assert.equal(after.draft, null);
    await assertNothingDangles();
  });

  test("many pictures in one save — Quick Links cards: held in order, the delete of one waits; one gone refuses the save by its card", async () => {
    const [quick] = await sql<{ id: number }[]>`
      select s.id from page_sections s join pages p on p.id = s.page_id where p.slug = 'home' and s.block_type = 'quick-links'`;
    const pictures = [await picture("cards-c"), await picture("cards-a"), await picture("cards-b")];
    const withCards = async (images: number[]) => {
      const row = await section(quick!.id);
      const base = (row.draft ?? row.published) as Values;
      const links = (base.links as Values[]).map((link, index) => ({ ...link, image: images[index] ?? null }));
      return { ...base, links };
    };
    // The middle picture is the one the delete wants: the save holds all three.
    const first = await writeFirst("page_sections", await save(quick!.id, await withCards(pictures.map((p) => p.id))), pictures[2]!);
    assert.equal(first.written.ok, true, first.written.message);
    assert.match(first.deleted.message ?? "", IN_USE);
    // Now the delete first, on a card's picture this save brings in.
    const fresh = [await picture("cards-d"), await picture("cards-e"), await picture("cards-f")];
    const second = await deleteFirst(await save(quick!.id, await withCards(fresh.map((p) => p.id))), fresh[1]!);
    assert.equal(second.deleted.ok, true);
    assert.equal(second.written.ok, false);
    assert.match(second.written.message ?? "", /The picture in “Links — card 2, Image” is no longer in the media library/);
    await assertNothingDangles();
  });

  test("a picture replaced while it is being deleted: the old one is counted until the save commits, the new one is held", async () => {
    const old = await picture("replaced-old");
    const fresh = await picture("replaced-new");
    const { sectionId } = await freshPage(old.id);
    const release = await arm("commit", "page_sections");
    try {
      const writing = (await save(sectionId, imageText(fresh.id)))();
      await until(1, 0, "the save never reached its commit");
      // The old picture is still what the committed section shows: refused at once.
      const oldDeleted = await deleteMedia(old);
      assert.equal(oldDeleted.ok, false);
      assert.match(oldDeleted.message ?? "", IN_USE);
      // The new one is held by the save: the delete waits for it.
      const newDeleting = deleteMedia(fresh);
      await until(1, 1, "the delete of the new picture did not wait");
      await release();
      assert.equal((await writing).ok, true);
      assert.match((await newDeleting).message ?? "", IN_USE);
    } finally {
      await release();
    }
    // The draft is the new picture; the old one is still published, so still in use.
    assert.equal((await deleteMedia(old)).ok, false);
    await assertNothingDangles();
  });

  test("two saves naming the same pictures in opposite orders, and two deletes: nothing deadlocks, every answer is definite", async () => {
    const a = await picture("opposite-a");
    const b = await picture("opposite-b");
    const one = await freshPage();
    const two = await freshPage();
    const [quick] = await sql<{ id: number }[]>`
      select s.id from page_sections s join pages p on p.id = s.page_id where p.slug = 'home' and s.block_type = 'quick-links'`;
    const row = await section(quick!.id);
    const base = (row.draft ?? row.published) as Values;
    // One section names b then a (cards one and two); the other a alone, then a picture field — the order differs.
    const cards = { ...base, links: (base.links as Values[]).map((link, index) => ({ ...link, image: index === 0 ? b.id : index === 1 ? a.id : null })) };

    // The saves first, both stopped at their commits holding a and b.
    let release = await arm("commit", "page_sections");
    try {
      const savingCards = (await save(quick!.id, cards))();
      const savingOne = (await save(one.sectionId, imageText(a.id)))();
      await until(2, 0, "the two saves never reached their commits");
      const deletingA = deleteMedia(a);
      const deletingB = deleteMedia(b);
      await until(2, 2, "the deletes did not wait for the saves");
      await release();
      const answers = await Promise.all([savingCards, savingOne, deletingA, deletingB]);
      assert.deepEqual(answers.map((answer) => answer.ok), [true, true, false, false], JSON.stringify(answers));
    } finally {
      await release();
    }

    // The deletes first, both stopped at their commits with their pictures gone.
    const c = await picture("opposite-c");
    const d = await picture("opposite-d");
    release = await arm("commit", "media");
    try {
      const deletingC = deleteMedia(c);
      const deletingD = deleteMedia(d);
      await until(2, 0, "the two deletes never reached their commits");
      const savingTwo = (await save(two.sectionId, imageText(d.id)))();
      const rowNow = await section(quick!.id);
      const baseNow = (rowNow.draft ?? rowNow.published) as Values;
      const cardsDC = { ...baseNow, links: (baseNow.links as Values[]).map((link, index) => ({ ...link, image: index === 0 ? d.id : index === 1 ? c.id : null })) };
      const savingCards = (await save(quick!.id, cardsDC))();
      await until(2, 2, "the saves did not wait for the deletes");
      await release();
      const answers = await Promise.all([deletingC, deletingD, savingTwo, savingCards]);
      assert.deepEqual(answers.map((answer) => answer.ok), [true, true, false, false], JSON.stringify(answers));
      for (const refused of answers.slice(2)) assert.match(refused.message ?? "", GONE);
    } finally {
      await release();
    }
    await assertNothingDangles();
  });
});

describe("26 · the Pages screen's section form", () => {
  const formSave = (action: "saveSectionDraft" | "saveSectionAndPublish", sectionId: number, values: Values) => async () => {
    const row = await section(sectionId);
    return pagesScreen(action, { id: sectionId, expectedRevision: row.revision, values: JSON.stringify(values) });
  };

  for (const action of ["saveSectionDraft", "saveSectionAndPublish"] as const) {
    test(`${action} first: the delete waits for it and refuses`, async () => {
      const { sectionId } = await freshPage();
      const chosen = await picture(`${action}-first`);
      const { written, deleted } = await writeFirst("page_sections", formSave(action, sectionId, imageText(chosen.id)), chosen);
      assert.equal(written.ok, true, written.message);
      assert.match(deleted.message ?? "", IN_USE);
      const stored = await section(sectionId);
      assert.equal((action === "saveSectionDraft" ? stored.draft : stored.published)?.image, chosen.id);
      await assertNothingDangles();
    });

    test(`the delete first, then ${action}: refused by name, nothing stored, no restore point`, async () => {
      const { pageId, sectionId } = await freshPage();
      const chosen = await picture(`${action}-delete-first`);
      const versions = async () => (await sql<{ n: number }[]>`select count(*)::int as n from page_versions where page_id = ${pageId}`)[0]!.n;
      const before = await versions();
      const { deleted, written } = await deleteFirst(formSave(action, sectionId, imageText(chosen.id)), chosen);
      assert.equal(deleted.ok, true);
      assert.equal(written.ok, false);
      assert.match(written.message ?? "", /The picture in “Image” is no longer in the media library/);
      const stored = await section(sectionId);
      assert.equal(stored.draft, null);
      assert.equal(stored.published.image, null);
      assert.equal(await versions(), before, "a refused publication left a restore point");
      await assertNothingDangles();
    });
  }

  test("publishing a saved draft: the draft's picture is counted all along — the delete is refused in either order, nothing dangles", async () => {
    const chosen = await picture("publish-draft");
    const { sectionId } = await freshPage();
    const draftRow = await section(sectionId);
    assert.equal((await pagesScreen("saveSectionDraft", { id: sectionId, expectedRevision: draftRow.revision, values: JSON.stringify(imageText(chosen.id)) })).ok, true);
    const publish = async () => pagesScreen("publishSection", { id: sectionId, expectedRevision: (await section(sectionId)).revision });
    const { written, deleted } = await writeFirst("page_sections", publish, chosen);
    assert.equal(written.ok, true, written.message);
    assert.match(deleted.message ?? "", IN_USE);
    assert.equal((await section(sectionId)).published.image, chosen.id);
    // The other order: the delete reads the published picture and refuses before it deletes anything.
    assert.match((await deleteMedia(chosen)).message ?? "", IN_USE);
    await assertNothingDangles();
  });
});

describe("26 · publishing a whole page, and discarding", () => {
  test("Publish page: every picture going live is held — the delete waits and refuses", async () => {
    const chosen = await picture("page-publish");
    const { pageId, sectionId } = await freshPage();
    const row = await section(sectionId);
    assert.equal(
      (await editor("saveVisualSectionDraft", { sectionId, pageId, expectedRevision: row.revision, values: JSON.stringify(imageText(chosen.id)) })).ok,
      true,
    );
    const publish = async () => editor("publishPageFromEditor", { pageId, expectedRevision: await pageRevision(pageId) });
    const { written, deleted } = await writeFirst("page_sections", publish, chosen);
    assert.equal(written.ok, true, written.message);
    assert.match(deleted.message ?? "", IN_USE);
    assert.equal((await section(sectionId)).published.image, chosen.id);
    await assertNothingDangles();
  });

  test("discarding a draft while its picture is being deleted: the delete is refused until the discard commits, then succeeds", async () => {
    const chosen = await picture("discard");
    const { pageId, sectionId } = await freshPage();
    const row = await section(sectionId);
    assert.equal(
      (await editor("saveVisualSectionDraft", { sectionId, pageId, expectedRevision: row.revision, values: JSON.stringify(imageText(chosen.id)) })).ok,
      true,
    );
    const release = await arm("commit", "page_sections");
    try {
      const discarding = pagesScreen("discardDraft", { id: sectionId, expectedRevision: (await section(sectionId)).revision });
      await until(1, 0, "the discard never reached its commit");
      // Until the discard commits, the draft that names the picture is what the delete reads.
      assert.match((await deleteMedia(chosen)).message ?? "", IN_USE);
      await release();
      assert.equal((await discarding).ok, true);
    } finally {
      await release();
    }
    assert.equal((await deleteMedia(chosen)).ok, true, "nothing names the picture now");
    await assertNothingDangles();
  });
});

describe("26 · copies: duplicating a section, saving one as reusable, adding a reusable block, detaching", () => {
  test("duplicate first: the copy holds the picture — the delete waits for it and refuses, though the original has let it go", async () => {
    const chosen = await picture("duplicate-first");
    const { pageId, sectionId } = await freshPage(chosen.id);
    const release = await arm("commit", "page_sections");
    try {
      // The copy has read the original, written itself and holds the picture: stopped at its commit.
      const copying = editor("duplicatePageSection", { pageId, sectionId, expectedRevision: await pageRevision(pageId) });
      await until(1, 0, "the copy never reached its commit");
      // The original lets the picture go: from here only the copy names it.
      await elsewhere((tx) => tx`update page_sections set published = ${tx.json(imageText(null) as never)}, revision = revision + 1 where id = ${sectionId}`);
      const deleting = deleteMedia(chosen);
      await until(1, 1, "the delete did not wait for the copy — the copy does not hold the picture");
      await release();
      assert.equal((await copying).ok, true);
      assert.match((await deleting).message ?? "", IN_USE);
    } finally {
      await release();
    }
    assert.ok(await inLibrary(chosen));
    await assertNothingDangles();
  });

  test("the original drops its picture and the picture is deleted while the copy is being made: the copy refuses it by name", async () => {
    const chosen = await picture("duplicate-stale");
    const { pageId, sectionId } = await freshPage(chosen.id);
    const release = await arm("insert", "page_sections");
    try {
      // The copy has read the original — picture and all — and stops before it writes.
      const copying = editor("duplicatePageSection", { pageId, sectionId, expectedRevision: await pageRevision(pageId) });
      await until(1, 0, "the copy never reached its insert");
      // Elsewhere, meanwhile: the original lets the picture go, and the library deletes it.
      await elsewhere((tx) => tx`update page_sections set published = ${tx.json(imageText(null) as never)}, revision = revision + 1 where id = ${sectionId}`);
      assert.equal((await deleteMedia(chosen)).ok, true);
      await release();
      const copied = await copying;
      assert.equal(copied.ok, false);
      assert.match(copied.message ?? "", /The picture in “Image” is no longer in the media library\. Nothing was copied\./);
    } finally {
      await release();
    }
    const rows = await sql<{ n: number }[]>`select count(*)::int as n from page_sections where page_id = ${pageId}`;
    assert.equal(rows[0]!.n, 1, "the refused copy left a section behind");
    await assertNothingDangles();
  });

  test("save as reusable: made from a section whose picture is deleted meanwhile, the component refuses it by name", async () => {
    const chosen = await picture("save-as-reusable-stale");
    const { pageId, sectionId } = await freshPage(chosen.id);
    const release = await arm("insert", "reusable_components");
    try {
      const making = components("createReusableFromSection", { sectionId, pageId, slot: "block", name: `Stale ${RUN}`, publish: "0" });
      await until(1, 0, "the component never reached its insert");
      await elsewhere((tx) => tx`update page_sections set published = ${tx.json(imageText(null) as never)}, revision = revision + 1 where id = ${sectionId}`);
      assert.equal((await deleteMedia(chosen)).ok, true);
      await release();
      const made = await making;
      assert.equal(made.ok, false);
      assert.match(made.message ?? "", /The picture in “Image” is no longer in the media library/);
    } finally {
      await release();
    }
    await assertNothingDangles();
  });

  test("save as reusable first: the new component holds the picture — the delete waits for it and refuses, though the section has let it go", async () => {
    const chosen = await picture("save-as-reusable-first");
    const { pageId, sectionId } = await freshPage(chosen.id);
    const release = await arm("commit", "reusable_components");
    try {
      const making = components("createReusableFromSection", { sectionId, pageId, slot: "block", name: `First ${RUN}`, publish: "0" });
      await until(1, 0, "the component never reached its commit");
      await elsewhere((tx) => tx`update page_sections set published = ${tx.json(imageText(null) as never)}, revision = revision + 1 where id = ${sectionId}`);
      const deleting = deleteMedia(chosen);
      await until(1, 1, "the delete did not wait for the component — it does not hold the picture");
      await release();
      assert.equal((await making).ok, true);
      assert.match((await deleting).message ?? "", IN_USE);
    } finally {
      await release();
    }
    assert.ok(await inLibrary(chosen));
    await assertNothingDangles();
  });

  test("adding a reusable block: the component's picture becomes the section's — held; the component holds it too, so the delete is refused either way", async () => {
    const chosen = await picture("add-reusable");
    const componentId = await freshComponent(chosen.id);
    const { pageId } = await freshPage();
    const add = async () => editor("addPageSection", { pageId, blockType: "image-text", componentId, expectedRevision: await pageRevision(pageId) });
    const { written, deleted } = await writeFirst("page_sections", add, chosen);
    assert.equal(written.ok, true, written.message);
    assert.match(deleted.message ?? "", IN_USE);
    await assertNothingDangles();
  });

  test("detaching: the component's picture becomes the section's own — held; the delete waits and refuses", async () => {
    const chosen = await picture("detach");
    const componentId = await freshComponent(chosen.id);
    const { pageId } = await freshPage();
    assert.equal((await editor("addPageSection", { pageId, blockType: "image-text", componentId, expectedRevision: await pageRevision(pageId) })).ok, true);
    const [linked] = await sql<{ id: number; revision: number }[]>`
      select id, revision from page_sections where page_id = ${pageId} and is_draft_only order by id desc limit 1`;
    const detach = async () =>
      editor("detachVisualInstance", {
        sectionId: linked!.id,
        pageId,
        expectedRevision: (await section(linked!.id)).revision,
        expectedComponentVersion: 1,
        slot: "block",
      });
    const { written, deleted } = await writeFirst("page_sections", detach, chosen);
    assert.equal(written.ok, true, written.message);
    assert.match(deleted.message ?? "", IN_USE);
    assert.equal((await section(linked!.id)).draft?.image, chosen.id);
    await assertNothingDangles();
  });
});

describe("26 · restoring a page version whose picture has gone (decision B)", () => {
  /** A page whose history holds `picture` and whose present does not. */
  async function pastWith(chosen: Picture) {
    const { pageId, sectionId } = await freshPage();
    const saveAndPublish = async (image: number | null) => {
      const row = await section(sectionId);
      const saved = await editor("saveVisualSectionDraft", { sectionId, pageId, expectedRevision: row.revision, values: JSON.stringify(imageText(image, `Image ${image}`)) });
      assert.equal(saved.ok, true, saved.message);
      const published = await editor("publishPageFromEditor", { pageId, expectedRevision: await pageRevision(pageId) });
      assert.equal(published.ok, true, published.message);
    };
    await saveAndPublish(chosen.id);
    await saveAndPublish(null); // its restore point is the page showing the picture
    const [version] = await sql<{ id: number }[]>`
      select id from page_versions where page_id = ${pageId} order by id desc limit 1`;
    return { pageId, sectionId, versionId: version!.id };
  }

  test("the restore first: the version's picture is held — the delete waits, then counts the restored draft and refuses", async () => {
    const chosen = await picture("restore-first");
    const { pageId, sectionId, versionId } = await pastWith(chosen);
    const restore = () => editor("restoreVersionFromEditor", { pageId, versionId });
    const { written, deleted } = await writeFirst("page_sections", restore, chosen);
    assert.equal(written.ok, true, written.message);
    assert.doesNotMatch(written.message ?? "", /left out/);
    assert.match(deleted.message ?? "", IN_USE);
    assert.equal((await section(sectionId)).draft?.image, chosen.id);
    await assertNothingDangles();
  });

  test("the delete first: the restore waits, finds the picture gone, leaves it out and says so — the rest comes back", async () => {
    const chosen = await picture("restore-delete-first");
    const { pageId, sectionId, versionId } = await pastWith(chosen);
    const restore = () => editor("restoreVersionFromEditor", { pageId, versionId });
    const { deleted, written } = await deleteFirst(restore, chosen);
    assert.equal(deleted.ok, true, deleted.message);
    assert.equal(written.ok, true, written.message);
    assert.match(written.message ?? "", /One picture this version used is no longer in the media library and was left out: Image and text \(section 1\): Image\./);
    const draft = (await section(sectionId)).draft!;
    assert.equal(draft.image, null);
    assert.deepEqual(draft.title, { en: `Image ${chosen.id}`, ar: "" }, "the rest of the version came back");
    await assertNothingDangles();
  });

  test("a version whose picture was deleted long before: restored without it, and named — on the Pages screen too", async () => {
    const chosen = await picture("restore-long-gone");
    const { pageId, versionId } = await pastWith(chosen);
    assert.equal((await deleteMedia(chosen)).ok, true);
    const restored = await pagesScreen("restorePageVersion", { pageId, versionId });
    assert.equal(restored.ok, true, restored.message);
    assert.match(restored.message ?? "", /was left out: Image and text \(section 1\): Image/);
    await assertNothingDangles();
  });

  test("two sections of one type that both lose their picture are two places, each named by its place on the page", async () => {
    const first = await picture("restore-two-a");
    const second = await picture("restore-two-b");
    const { pageId, sectionId } = await freshPage(first.id);
    const [other] = await sql<{ id: number }[]>`
      insert into page_sections (page_id, block_type, position, is_published, published)
      values (${pageId}, 'image-text', 1, true, ${sql.json(imageText(second.id) as never)}) returning id`;
    // Both pictures off the page; the publication's restore point shows them both.
    for (const id of [sectionId, other!.id]) {
      const saved = await editor("saveVisualSectionDraft", {
        sectionId: id,
        pageId,
        expectedRevision: (await section(id)).revision,
        values: JSON.stringify(imageText(null, "Words only")),
      });
      assert.equal(saved.ok, true, saved.message);
    }
    const published = await editor("publishPageFromEditor", { pageId, expectedRevision: await pageRevision(pageId) });
    assert.equal(published.ok, true, published.message);
    const [version] = await sql<{ id: number }[]>`select id from page_versions where page_id = ${pageId} order by id desc limit 1`;
    assert.equal((await deleteMedia(first)).ok, true);
    assert.equal((await deleteMedia(second)).ok, true);

    const restored = await editor("restoreVersionFromEditor", { pageId, versionId: version!.id });
    assert.equal(restored.ok, true, restored.message);
    assert.match(
      restored.message ?? "",
      /Pictures this version used are no longer in the media library and were left out in 2 places: Image and text \(section 1\): Image; Image and text \(section 2\): Image\. Choose others before publishing\./,
    );
    assert.equal((await section(sectionId)).draft?.image, null);
    assert.equal((await section(other!.id)).draft?.image, null);
    await assertNothingDangles();
  });

  test("one picture in two places is one picture: named at both places, counted once", async () => {
    const shared = await picture("restore-two-shared");
    const { pageId, sectionId } = await freshPage(shared.id);
    const [other] = await sql<{ id: number }[]>`
      insert into page_sections (page_id, block_type, position, is_published, published)
      values (${pageId}, 'image-text', 1, true, ${sql.json(imageText(shared.id) as never)}) returning id`;
    for (const id of [sectionId, other!.id]) {
      const saved = await editor("saveVisualSectionDraft", {
        sectionId: id,
        pageId,
        expectedRevision: (await section(id)).revision,
        values: JSON.stringify(imageText(null, "Words only")),
      });
      assert.equal(saved.ok, true, saved.message);
    }
    assert.equal((await editor("publishPageFromEditor", { pageId, expectedRevision: await pageRevision(pageId) })).ok, true);
    const [version] = await sql<{ id: number }[]>`select id from page_versions where page_id = ${pageId} order by id desc limit 1`;
    assert.equal((await deleteMedia(shared)).ok, true);

    const restored = await editor("restoreVersionFromEditor", { pageId, versionId: version!.id });
    assert.equal(restored.ok, true, restored.message);
    assert.match(
      restored.message ?? "",
      /One picture this version used is no longer in the media library and was left out in 2 places: Image and text \(section 1\): Image; Image and text \(section 2\): Image\. Choose another before publishing\./,
    );
    await assertNothingDangles();
  });

  test("a linked section's own copy of its component's picture is emptied with the rest, but not named: the page shows the component's picture there, and nobody can choose one", async () => {
    const fallback = await picture("restore-linked-fallback");
    const shown = await picture("restore-linked-shown");
    const next = await picture("restore-linked-next");
    const componentId = await freshComponent(shown.id);
    const { pageId, sectionId } = await freshPage();
    const [linked] = await sql<{ id: number }[]>`
      insert into page_sections (page_id, block_type, position, is_published, published)
      values (${pageId}, 'image-text', 1, true, ${sql.json({ ...imageText(fallback.id), _reuse: { block: { c: componentId } } } as never)}) returning id`;
    // A publication of the other section: its restore point pins the linked one to what it showed — `shown`.
    const saved = await editor("saveVisualSectionDraft", {
      sectionId,
      pageId,
      expectedRevision: (await section(sectionId)).revision,
      values: JSON.stringify(imageText(null, "Other words")),
    });
    assert.equal(saved.ok, true, saved.message);
    assert.equal((await editor("publishPageFromEditor", { pageId, expectedRevision: await pageRevision(pageId) })).ok, true);
    const [version] = await sql<{ id: number }[]>`select id from page_versions where page_id = ${pageId} order by id desc limit 1`;
    // The component moves on to another picture, and the one it showed leaves the library.
    assert.equal(
      (await components("saveReusableDraft", { id: componentId, expectedRevision: (await component(componentId)).revision, values: JSON.stringify(imageText(next.id)) })).ok,
      true,
    );
    assert.equal((await components("publishReusable", { id: componentId, expectedRevision: (await component(componentId)).revision })).ok, true);
    assert.equal((await deleteMedia(shown)).ok, true);

    const restored = await editor("restoreVersionFromEditor", { pageId, versionId: version!.id });
    assert.equal(restored.ok, true, restored.message);
    assert.doesNotMatch(restored.message ?? "", /left out/, "an editor told to choose a picture no linked section can hold");
    const draft = (await section(linked!.id)).draft!;
    assert.equal(draft.image, null, "the dead copy came back");
    assert.deepEqual(draft._reuse, { block: { c: componentId } }, "it follows its component again");
    await assertNothingDangles();
  });
});

describe("26 · reusable components", () => {
  test("create: the new component holds its picture — the delete waits and refuses; the delete first, the creation is refused by name", async () => {
    const first = await picture("component-create-first");
    const make = (image: number, name: string) => () =>
      components("createReusableComponent", { kind: "block:image-text", name, values: JSON.stringify(imageText(image)), publish: "0" });
    const one = await writeFirst("reusable_components", make(first.id, `Create ${RUN} 1`), first);
    assert.equal(one.written.ok, true, one.written.message);
    assert.match(one.deleted.message ?? "", IN_USE);

    const second = await picture("component-create-second");
    const two = await deleteFirst(make(second.id, `Create ${RUN} 2`), second);
    assert.equal(two.deleted.ok, true);
    assert.equal(two.written.ok, false);
    assert.match(two.written.message ?? "", /The picture in “Image” is no longer in the media library/);
    const [{ n }] = await sql<{ n: number }[]>`select count(*)::int as n from reusable_components where name = ${`Create ${RUN} 2`}`;
    assert.equal(n, 0, "the refused component was created");
    await assertNothingDangles();
  });

  test("draft save: held; the delete first, the save is refused and the draft is untouched", async () => {
    const id = await freshComponent(null);
    const save = (image: number) => async () =>
      components("saveReusableDraft", { id, expectedRevision: (await component(id)).revision, values: JSON.stringify(imageText(image)) });
    const first = await picture("component-draft-first");
    const one = await writeFirst("reusable_components", save(first.id), first);
    assert.equal(one.written.ok, true, one.written.message);
    assert.match(one.deleted.message ?? "", IN_USE);

    const second = await picture("component-draft-second");
    const before = await component(id);
    const two = await deleteFirst(save(second.id), second);
    assert.equal(two.written.ok, false);
    assert.match(two.written.message ?? "", GONE);
    assert.deepEqual(await component(id), before);
    await assertNothingDangles();
  });

  test("publish: the draft's picture is held going live — the delete waits and refuses", async () => {
    const chosen = await picture("component-publish");
    const id = await freshComponent(null);
    assert.equal(
      (await components("saveReusableDraft", { id, expectedRevision: (await component(id)).revision, values: JSON.stringify(imageText(chosen.id)) })).ok,
      true,
    );
    const publish = async () => components("publishReusable", { id, expectedRevision: (await component(id)).revision });
    const { written, deleted } = await writeFirst("reusable_components", publish, chosen);
    assert.equal(written.ok, true, written.message);
    assert.match(deleted.message ?? "", IN_USE);
    assert.equal((await component(id)).published?.image, chosen.id);
    await assertNothingDangles();
  });

  test("restore a version whose picture is deleted meanwhile: left out and named — the rest comes back", async () => {
    const chosen = await picture("component-restore");
    const id = await freshComponent(chosen.id);
    // Version 1 shows the picture; publish version 2 without it.
    assert.equal(
      (await components("saveReusableDraft", { id, expectedRevision: (await component(id)).revision, values: JSON.stringify(imageText(null, "Second")) })).ok,
      true,
    );
    assert.equal((await components("publishReusable", { id, expectedRevision: (await component(id)).revision })).ok, true);
    const [version] = await sql<{ id: number }[]>`select id from reusable_component_versions where component_id = ${id} order by id desc limit 1`;
    const restore = async () => components("restoreReusableVersion", { id, versionId: version!.id, expectedRevision: (await component(id)).revision });
    const { deleted, written } = await deleteFirst(restore, chosen);
    assert.equal(deleted.ok, true, deleted.message);
    assert.equal(written.ok, true, written.message);
    assert.match(written.message ?? "", /was left out: Image\./);
    assert.equal((await component(id)).draft?.image, null);
    await assertNothingDangles();
  });

  test("a version that differs from what is live only by a picture deleted since: nothing to restore, and no draft left pending — live content read as every screen reads it", async () => {
    const chosen = await picture("component-restore-same");
    const id = await freshComponent(chosen.id);
    // The same words published again without the picture; the version keeps the picture.
    assert.equal(
      (await components("saveReusableDraft", { id, expectedRevision: (await component(id)).revision, values: JSON.stringify(imageText(null)) })).ok,
      true,
    );
    assert.equal((await components("publishReusable", { id, expectedRevision: (await component(id)).revision })).ok, true);
    // The live row as an older build may have left it: a key no field declares, which no screen reads.
    await elsewhere((tx) => tx`update reusable_components set published = published || '{"legacy": "an older build kept this"}'::jsonb where id = ${id}`);
    const [version] = await sql<{ id: number }[]>`select id from reusable_component_versions where component_id = ${id} order by id desc limit 1`;
    assert.equal((await deleteMedia(chosen)).ok, true, "history does not hold a picture");
    const before = await component(id);
    const restored = await components("restoreReusableVersion", { id, versionId: version!.id, expectedRevision: before.revision });
    assert.equal(restored.ok, false);
    assert.match(restored.message ?? "", /^Without the pictures that are no longer in the media library, that version is what is published now/);
    assert.deepEqual(await component(id), before, "a draft nobody changed, Publish armed for nothing");
    await assertNothingDangles();
  });
});

describe("26 · Visual Editor route drafts, publication and history", () => {
  let travel: RouteOwner;
  let document: number;
  before(async () => {
    const [row] = await sql<{ id: number }[]>`select id from service_categories where slug = 'travel-tourism'`;
    travel = { type: "category", id: row!.id };
    document = documentEditorKey({ kind: "category", id: row!.id });
  });

  const region = async () => {
    const answer = await call(ROUTES, "/admin/visual-editor", "loadRouteRegion", [editorKeyOf(travel), document]);
    assert.ok(answer.ok, `load: ${answer.message}`);
    return answer.section as { revision: number; values: Values };
  };
  const saveRegion = (change: (values: Values) => Values) => async () => {
    const current = await region();
    return routeEditor("saveRouteRegionDraft", {
      sectionId: editorKeyOf(travel),
      pageId: document,
      expectedRevision: current.revision,
      values: JSON.stringify(change(current.values)),
    });
  };
  const saveImage = (image: number) => saveRegion((values) => ({ ...values, image }));
  /** The picture and the English tagline together, so a version differs in more than its picture. */
  const saveImageAndTagline = (image: number, tagline: string) =>
    saveRegion((values) => ({ ...values, image, tagline: { ...(values.tagline as Values | undefined), en: tagline } }));
  const summaryToken = async () => {
    const view = await call(ROUTES, "/admin/visual-editor", "loadRouteSummary", [`category:${travel.id}`]);
    return String((view as unknown as { token: string }).token);
  };
  const routeForm = (action: string, extra: Record<string, string | number> = {}) => async () =>
    routeEditor(action, { routeKey: `category:${travel.id}`, token: await summaryToken(), ...extra });
  const discardRoute = async () => {
    const answer = await routeForm("discardRouteFromEditor")();
    assert.ok(answer.ok || answer.reason === "nothing", answer.message);
  };

  test("a region's draft: held — the delete waits and refuses; the delete first, the save is refused by name", async () => {
    const first = await picture("route-save-first");
    const one = await writeFirst("route_nodes", saveImage(first.id), first);
    assert.equal(one.written.ok, true, one.written.message);
    assert.match(one.deleted.message ?? "", IN_USE);
    await discardRoute();

    const second = await picture("route-save-second");
    const two = await deleteFirst(saveImage(second.id), second);
    assert.equal(two.deleted.ok, true);
    assert.equal(two.written.ok, false);
    assert.match(two.written.message ?? "", GONE);
    await assertNothingDangles();
  });

  test("publishing a region's picture: held from the draft to the record — the delete waits and refuses; the record shows it", async () => {
    // The delete's wait here is the record's foreign key as much as the hold:
    // every route picture lands in an `image_id` column, whose update takes the
    // picture `FOR KEY SHARE` by itself. So this shows the publication is safe,
    // not that the hold is what makes it so; the hold's own work is refusing a
    // gone picture by name rather than as a foreign-key error (the test below).
    const chosen = await picture("route-publish");
    assert.equal((await saveImage(chosen.id)()).ok, true);
    const { written, deleted } = await writeFirst("route_nodes", routeForm("publishRouteFromEditor"), chosen);
    assert.equal(written.ok, true, written.message);
    assert.match(deleted.message ?? "", IN_USE);
    const [record] = await sql<{ image_id: number | null }[]>`select image_id from service_categories where id = ${travel.id}`;
    assert.equal(record!.image_id, chosen.id);
    await assertNothingDangles();
  });

  test("restoring a route version whose picture is deleted meanwhile: skipped and named, the rest restored", async () => {
    const chosen = await picture("route-restore");
    const original = `Restore ${RUN} — the version`;
    assert.equal((await saveImageAndTagline(chosen.id, original)()).ok, true);
    assert.equal((await routeForm("publishRouteFromEditor")()).ok, true);
    const [version] = await sql<{ id: number }[]>`
      select id from route_versions where route_key = ${`category:${travel.id}`} order by id desc limit 1`;
    // Move on: another picture and another tagline are published, so the first picture is no longer used.
    const next = await picture("route-restore-next");
    assert.equal((await saveImageAndTagline(next.id, `Restore ${RUN} — live`)()).ok, true);
    assert.equal((await routeForm("publishRouteFromEditor")()).ok, true);
    const { deleted, written } = await deleteFirst(routeForm("restoreRouteFromEditor", { versionId: version!.id }), chosen);
    assert.equal(deleted.ok, true, deleted.message);
    assert.equal(written.ok, true, written.message);
    assert.match(written.message ?? "", /^The version is now a draft on 1 region\. Review it, then publish\./);
    assert.match(written.message ?? "", /Left out, because it can no longer be restored: .+ — Background image\.$/);
    // The rest of the version is the draft; the picture stays the live one, never the deleted id.
    const draft = await region();
    assert.equal((draft.values.tagline as Values).en, original);
    assert.equal(draft.values.image, next.id);
    await discardRoute();
    await assertNothingDangles();
  });

  test("a region whose draft names a picture deleted since: an edit of its words still saves — the picture is carried — and publishing it is refused by name", async () => {
    const lost = await picture("route-carried");
    assert.equal((await saveImage(lost.id)()).ok, true);
    // Gone out of sight of the delete's count — as the previous release's delete, which reads no route draft, leaves it.
    await elsewhere((tx) => tx`delete from media where id = ${lost.id}`);
    const saved = await saveImageAndTagline(lost.id, `Carried ${RUN}`)();
    assert.equal(saved.ok, true, saved.message);
    assert.equal(((await region()).values.tagline as Values).en, `Carried ${RUN}`);
    const published = await routeForm("publishRouteFromEditor")();
    assert.equal(published.ok, false);
    assert.match(published.message ?? "", /Background image is no longer in the media library\. Nothing was published\./);
    await discardRoute();
    await assertNothingDangles();
  });
});

describe("26 · a publication refuses a picture it would newly put live that has left the library (decision B)", () => {
  /**
   * A picture id the library no longer has, stored where a delete before Batch
   * 26 could leave one (a Quick Links card, X1) or an unchecked restore could
   * bring one back (X3). Put there by hand: nothing since Batch 26 writes one.
   */
  const vanished = async (name: string) => {
    const lost = await picture(name);
    await elsewhere((tx) => tx`delete from media where id = ${lost.id}`);
    return lost.id;
  };
  const NOT_PUBLISHED = /^The picture in “Image” .*is no longer in the media library\. Nothing was published/;

  test("a section: Publish and Save and publish are refused by the field, nothing goes live — and one already live is kept as it is", async () => {
    const missing = await vanished("publish-section-gone");
    const { sectionId } = await freshPage();
    await elsewhere((tx) => tx`update page_sections set draft = ${tx.json(imageText(missing, "Restored words") as never)} where id = ${sectionId}`);
    const before = await section(sectionId);

    const published = await pagesScreen("publishSection", { id: sectionId, expectedRevision: before.revision });
    assert.equal(published.ok, false);
    assert.match(published.message ?? "", NOT_PUBLISHED);
    const saved = await pagesScreen("saveSectionAndPublish", {
      id: sectionId,
      expectedRevision: before.revision,
      values: JSON.stringify(imageText(missing, "Restored words")),
    });
    assert.equal(saved.ok, false);
    assert.match(saved.message ?? "", NOT_PUBLISHED);
    const after = await section(sectionId);
    assert.deepEqual(after.published, before.published, "something went live");
    assert.equal(after.revision, before.revision);
    assert.equal((await sql`select 1 from page_versions where page_id = ${after.page_id}`).length, 0, "a refused publication left a restore point");

    // Live already: publishing other words keeps it exactly as it was.
    await elsewhere((tx) => tx`update page_sections set published = ${tx.json(imageText(missing) as never)} where id = ${sectionId}`);
    const kept = await pagesScreen("publishSection", { id: sectionId, expectedRevision: (await section(sectionId)).revision });
    assert.equal(kept.ok, true, kept.message);
    assert.equal(((await section(sectionId)).published.title as Values).en, "Restored words");
    // Nothing else may see it dangling afterwards.
    await elsewhere((tx) => tx`update page_sections set published = ${tx.json(imageText(null) as never)}, draft = null where id = ${sectionId}`);
    await assertNothingDangles();
  });

  test("a page: Publish page is refused by the section and field, and nothing on the page goes live", async () => {
    const missing = await vanished("publish-page-gone");
    const chosen = await picture("publish-page-other");
    const one = await freshPage();
    const [second] = await sql<{ id: number }[]>`
      insert into page_sections (page_id, block_type, position, is_published, published)
      values (${one.pageId}, 'image-text', 1, true, ${sql.json(imageText(null) as never)}) returning id`;
    await elsewhere(async (tx) => {
      await tx`update page_sections set draft = ${tx.json(imageText(missing) as never)} where id = ${one.sectionId}`;
      await tx`update page_sections set draft = ${tx.json(imageText(chosen.id) as never)} where id = ${second!.id}`;
    });
    const answer = await editor("publishPageFromEditor", { pageId: one.pageId, expectedRevision: await pageRevision(one.pageId) });
    assert.equal(answer.ok, false);
    assert.match(answer.message ?? "", /^The picture in “Image” \(Image and text, section 1\) is no longer in the media library\. Nothing was published/);
    assert.equal((await section(one.sectionId)).published.image, null);
    assert.equal((await section(second!.id)).published.image, null, "the other section went live");
    await elsewhere((tx) => tx`update page_sections set draft = null where page_id = ${one.pageId}`);
    await assertNothingDangles();
  });

  test("a page: a picture one section shows already is no licence for another to start showing it — judged section by section", async () => {
    const missing = await vanished("publish-page-carried");
    const one = await freshPage();
    // The first section shows it live already (an old delete left it); the second would newly show it.
    await elsewhere((tx) => tx`update page_sections set published = ${tx.json(imageText(missing, "Shown already") as never)} where id = ${one.sectionId}`);
    const [second] = await sql<{ id: number }[]>`
      insert into page_sections (page_id, block_type, position, is_published, published)
      values (${one.pageId}, 'image-text', 1, true, ${sql.json(imageText(null) as never)}) returning id`;
    await elsewhere((tx) => tx`update page_sections set draft = ${tx.json(imageText(missing, "Newly") as never)} where id = ${second!.id}`);
    const answer = await editor("publishPageFromEditor", { pageId: one.pageId, expectedRevision: await pageRevision(one.pageId) });
    assert.equal(answer.ok, false, "the second section went live naming a picture the library no longer has");
    // Named by its place on the page: the first section shows the picture too, and is not the one at fault.
    assert.match(answer.message ?? "", /^The picture in “Image” \(Image and text, section 2\) is no longer in the media library\. Nothing was published/);
    assert.equal((await section(second!.id)).published.image, null);
    // Nor when the first section goes out in the same publication, keeping the picture it shows.
    await elsewhere((tx) => tx`update page_sections set draft = ${tx.json(imageText(missing, "Shown, reworded") as never)} where id = ${one.sectionId}`);
    const together = await editor("publishPageFromEditor", { pageId: one.pageId, expectedRevision: await pageRevision(one.pageId) });
    assert.equal(together.ok, false, "the second section went live on the first one's licence");
    assert.match(together.message ?? "", /^The picture in “Image” \(Image and text, section 2\) is no longer in the media library\. Nothing was published/);
    assert.equal(((await section(one.sectionId)).published.title as Values).en, "Shown already", "the refused publication changed the first section");
    // The section that shows it already may still publish other words, keeping it as it is.
    await elsewhere(async (tx) => {
      await tx`update page_sections set draft = null where id = ${second!.id}`;
      await tx`update page_sections set draft = ${tx.json(imageText(missing, "Other words") as never)} where id = ${one.sectionId}`;
    });
    const kept = await editor("publishPageFromEditor", { pageId: one.pageId, expectedRevision: await pageRevision(one.pageId) });
    assert.equal(kept.ok, true, kept.message);
    await elsewhere((tx) => tx`update page_sections set published = ${tx.json(imageText(null) as never)}, draft = null where page_id = ${one.pageId}`);
    await assertNothingDangles();
  });

  test("a page: a hidden section that the publication shows is judged as new — a picture it held while hidden that has gone refuses the publication; while it stays hidden, nothing is judged", async () => {
    const missing = await vanished("publish-page-shown");
    const one = await freshPage();
    const [hidden] = await sql<{ id: number }[]>`
      insert into page_sections (page_id, block_type, position, is_published, published)
      values (${one.pageId}, 'image-text', 1, false, ${sql.json(imageText(missing, "Hidden") as never)}) returning id`;
    const structure = (visible: boolean) => ({ v: 1, sections: [{ sectionId: one.sectionId, visible: true }, { sectionId: hidden!.id, visible }] });
    // Shown by this publication: refused, by its place.
    await elsewhere((tx) => tx`update pages set draft_structure = ${tx.json(structure(true) as never)} where id = ${one.pageId}`);
    const shown = await editor("publishPageFromEditor", { pageId: one.pageId, expectedRevision: await pageRevision(one.pageId) });
    assert.equal(shown.ok, false, "a hidden section went live naming a picture the library no longer has");
    assert.match(shown.message ?? "", /^The picture in “Image” \(Image and text, section 2\) is no longer in the media library\. Nothing was published/);
    const row = await sql<{ is_published: boolean }[]>`select is_published from page_sections where id = ${hidden!.id}`;
    assert.equal(row[0]!.is_published, false, "the refused publication showed it");
    // Kept hidden while its words are published: nothing goes live, nothing is judged.
    await elsewhere(async (tx) => {
      await tx`update pages set draft_structure = ${tx.json(structure(false) as never)} where id = ${one.pageId}`;
      await tx`update page_sections set draft = ${tx.json(imageText(missing, "Still hidden") as never)} where id = ${hidden!.id}`;
    });
    const kept = await editor("publishPageFromEditor", { pageId: one.pageId, expectedRevision: await pageRevision(one.pageId) });
    assert.equal(kept.ok, true, kept.message);
    await elsewhere(async (tx) => {
      await tx`delete from page_sections where id = ${hidden!.id}`;
      await tx`update pages set draft_structure = null where id = ${one.pageId}`;
    });
    await assertNothingDangles();
  });

  test("a field a linked component supplies is never the reason a publication is refused: the page draws the component's picture there, and no editor can choose another for the section's copy — Publish page, Publish, Save and publish", async () => {
    const missing = await vanished("publish-linked-gone");
    const shown = await picture("publish-linked-shown");
    const componentId = await freshComponent(shown.id);
    // A section's draft linked to the component, its fallback copy naming a picture gone since (X3).
    const linked = { ...imageText(missing, "Linked words"), _reuse: { block: { c: componentId } } };
    const fresh = async () => {
      const one = await freshPage();
      await elsewhere((tx) => tx`update page_sections set draft = ${tx.json(linked as never)} where id = ${one.sectionId}`);
      return one;
    };
    const page = await fresh();
    const viaPage = await editor("publishPageFromEditor", { pageId: page.pageId, expectedRevision: await pageRevision(page.pageId) });
    const single = await fresh();
    const viaSection = await pagesScreen("publishSection", { id: single.sectionId, expectedRevision: (await section(single.sectionId)).revision });
    const form = await fresh();
    const viaForm = await pagesScreen("saveSectionAndPublish", {
      id: form.sectionId,
      expectedRevision: (await section(form.sectionId)).revision,
      values: JSON.stringify(imageText(null, "Linked words")),
    });
    for (const [label, answer, sectionId] of [
      ["Publish page", viaPage, page.sectionId],
      ["Publish", viaSection, single.sectionId],
      ["Save and publish", viaForm, form.sectionId],
    ] as const) {
      assert.equal(answer.ok, true, `${label}: ${answer.message}`);
      const live = (await section(sectionId)).published;
      assert.deepEqual(live._reuse, { block: { c: componentId } }, `${label}: the link did not go live`);
      assert.equal(live.image, missing, `${label}: the fallback copy was not carried as it was`);
    }
    // The page draws the component's picture, which the library still has — and nothing else may see the copy dangling afterwards.
    await elsewhere((tx) => tx`
      update page_sections set published = ${tx.json(imageText(null) as never)}, draft = null
       where id in ${tx([page.sectionId, single.sectionId, form.sectionId])}`);
    await assertNothingDangles();
  });

  test("carried, never the reason an edit is refused: a section or component whose own draft names a picture deleted since still saves an edit of its words — the autosave, the Pages screen's draft, a component's draft — and publishing it is refused", async () => {
    const missing = await vanished("carried-section");
    const { pageId, sectionId } = await freshPage();
    await elsewhere((tx) => tx`update page_sections set draft = ${tx.json(imageText(missing, "Before") as never)} where id = ${sectionId}`);
    const autosaved = await editor("saveVisualSectionDraft", {
      sectionId,
      pageId,
      expectedRevision: (await section(sectionId)).revision,
      values: JSON.stringify(imageText(missing, "Autosaved")),
    });
    assert.equal(autosaved.ok, true, autosaved.message);
    assert.equal((await section(sectionId)).draft?.image, missing, "the carried id was dropped");
    const drafted = await pagesScreen("saveSectionDraft", {
      id: sectionId,
      expectedRevision: (await section(sectionId)).revision,
      values: JSON.stringify(imageText(missing, "Drafted")),
    });
    assert.equal(drafted.ok, true, drafted.message);
    assert.equal(((await section(sectionId)).draft?.title as Values).en, "Drafted");

    const componentId = await freshComponent(null);
    await elsewhere((tx) => tx`update reusable_components set draft = ${tx.json(imageText(missing, "Before") as never)} where id = ${componentId}`);
    const componentSaved = await components("saveReusableDraft", {
      id: componentId,
      expectedRevision: (await component(componentId)).revision,
      values: JSON.stringify(imageText(missing, "Component words")),
    });
    assert.equal(componentSaved.ok, true, componentSaved.message);
    assert.equal((await component(componentId)).draft?.image, missing);

    // Carried in a draft; never put live by it.
    const published = await pagesScreen("publishSection", { id: sectionId, expectedRevision: (await section(sectionId)).revision });
    assert.equal(published.ok, false);
    assert.match(published.message ?? "", NOT_PUBLISHED);
    const componentPublished = await components("publishReusable", { id: componentId, expectedRevision: (await component(componentId)).revision });
    assert.equal(componentPublished.ok, false);
    assert.match(componentPublished.message ?? "", NOT_PUBLISHED);

    // Live already: Save and publish and a component's Publish keep it as it is.
    await elsewhere(async (tx) => {
      await tx`update page_sections set published = ${tx.json(imageText(missing, "Live") as never)}, draft = null where id = ${sectionId}`;
      await tx`update reusable_components set published = ${tx.json(imageText(missing, "Live") as never)} where id = ${componentId}`;
    });
    const republished = await pagesScreen("saveSectionAndPublish", {
      id: sectionId,
      expectedRevision: (await section(sectionId)).revision,
      values: JSON.stringify(imageText(missing, "Live, new words")),
    });
    assert.equal(republished.ok, true, republished.message);
    assert.equal(((await section(sectionId)).published.title as Values).en, "Live, new words");
    await components("saveReusableDraft", {
      id: componentId,
      expectedRevision: (await component(componentId)).revision,
      values: JSON.stringify(imageText(missing, "Live, new words")),
    });
    const componentRepublished = await components("publishReusable", { id: componentId, expectedRevision: (await component(componentId)).revision });
    assert.equal(componentRepublished.ok, true, componentRepublished.message);
    assert.equal((await component(componentId)).published?.image, missing, "the live picture was dropped");
    await elsewhere(async (tx) => {
      await tx`update page_sections set published = ${tx.json(imageText(null) as never)}, draft = null where id = ${sectionId}`;
      await tx`update reusable_components set published = ${tx.json(imageText(null) as never)}, draft = null where id = ${componentId}`;
    });
    await assertNothingDangles();
  });

  test("a reusable component: Publish is refused by the field; its live content stays", async () => {
    const missing = await vanished("publish-component-gone");
    const id = await freshComponent(null);
    await elsewhere((tx) => tx`update reusable_components set draft = ${tx.json(imageText(missing) as never)} where id = ${id}`);
    const before = await component(id);
    const answer = await components("publishReusable", { id, expectedRevision: before.revision });
    assert.equal(answer.ok, false);
    assert.match(answer.message ?? "", NOT_PUBLISHED);
    assert.deepEqual((await component(id)).published, before.published);
    await elsewhere((tx) => tx`update reusable_components set draft = null where id = ${id}`);
    await assertNothingDangles();
  });
});

describe("26 · the deploy's scripts: the seed's shipped artwork, the row-id backfill", () => {
  /** `npm run db:seed` as deploy.sh runs it (step 10) — against this file's database and upload directory. */
  const runSeed = () => {
    const child = spawn("npx", ["tsx", "scripts/seed.ts"], { cwd: REPO_ROOT, env: scriptEnv(dbUrl(database), { UPLOAD_DIR: UPLOADS }) });
    let output = "";
    child.stdout.on("data", (chunk) => (output += chunk));
    child.stderr.on("data", (chunk) => (output += chunk));
    return new Promise<{ code: number | null; output: string }>((resolve) => child.once("close", (code) => resolve({ code, output })));
  };
  const artwork = async () => {
    const [row] = await sql<{ id: number; filename: string }[]>`select id, filename from media where filename = 'one-desk.webp'`;
    assert.ok(row, "the fixture has the shipped image-text artwork");
    return row;
  };

  test("the seed first: it holds the artwork it attaches to an empty picture — the delete waits for it, then counts the section and refuses", async () => {
    const one = await artwork();
    const { sectionId } = await freshPage(null);
    const release = await arm("commit", "page_sections");
    try {
      const seeding = runSeed();
      await until(1, 0, "the seed never reached the commit of an artwork it attaches", 120);
      const deleting = deleteMedia(one);
      await until(1, 1, "the delete did not wait for the seed — the seed does not hold the artwork");
      await release();
      const seeded = await seeding;
      assert.equal(seeded.code, 0, seeded.output.slice(-2000));
      const deleted = await deleting;
      assert.equal(deleted.ok, false);
      assert.match(deleted.message ?? "", IN_USE);
    } finally {
      await release();
    }
    assert.equal((await section(sectionId)).published.image, one.id);
    await assertNothingDangles();
  });

  test("the delete first: the seed waits for it, finds the artwork gone and leaves the picture empty — no id that names nothing", async () => {
    const one = await artwork();
    // Nothing else shows this artwork, so the library may delete it.
    await elsewhere(async (tx) => {
      await tx`update page_sections set published = jsonb_set(published, '{image}', 'null'::jsonb)
                where published ->> 'image' = ${String(one.id)}`;
      await tx`update page_sections set draft = jsonb_set(draft, '{image}', 'null'::jsonb)
                where draft ->> 'image' = ${String(one.id)}`;
    });
    const { sectionId } = await freshPage(null);
    const release = await arm("commit", "media");
    try {
      const deleting = deleteMedia(one);
      await until(1, 0, "the delete never reached its commit");
      const seeding = runSeed();
      await until(1, 1, "the seed did not wait for the delete — it does not hold the artwork", 120);
      await release();
      const deleted = await deleting;
      assert.equal(deleted.ok, true, deleted.message);
      const seeded = await seeding;
      assert.equal(seeded.code, 0, seeded.output.slice(-2000));
    } finally {
      await release();
    }
    assert.equal(await inLibrary(one), false);
    assert.equal((await section(sectionId)).published.image, null, "the seed wrote the id of a deleted picture");
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from page_sections where block_type = 'image-text' and published ->> 'image' = ${String(one.id)}`;
    assert.equal(n, 0, "a section names the deleted artwork");
    await assertNothingDangles();
  });

  test("the row-id backfill stamps what a section holds when it writes, never the copy it read ahead — a save in between is kept, and a picture it removed stays removed", async () => {
    // A Quick Links section as the previous release stores one: cards without ids, so the backfill must stamp it.
    const card = await picture("backfill-card");
    const [home] = await sql<{ published: Values }[]>`
      select s.published from page_sections s join pages p on p.id = s.page_id where p.slug = 'home' and s.block_type = 'quick-links'`;
    const unstamped = (label: string, image: number | null) => ({
      ...home!.published,
      links: (home!.published.links as Values[]).map(({ _id: _ignored, ...link }, index) =>
        index === 0 ? { ...link, label: { en: label, ar: "" }, image } : link),
    });
    const { pageId } = await freshPage();
    const [quick] = await sql<{ id: number }[]>`
      insert into page_sections (page_id, block_type, position, is_published, published)
      values (${pageId}, 'quick-links', 1, true, ${sql.json(unstamped("Before the save", card.id) as never)}) returning id`;

    // An editor of the release still serving saves it — removing the card's picture — and has not committed yet.
    const editor = await sql.reserve();
    try {
      await editor`begin`;
      await editor`update page_sections set published = ${editor.json(unstamped("The editor's save", null) as never)} where id = ${quick!.id}`;
      const migrating = new Promise<{ code: number | null; output: string }>((resolve) => {
        const child = spawn("npx", ["tsx", "scripts/migrate.ts"], { cwd: REPO_ROOT, env: scriptEnv(dbUrl(database)) });
        let output = "";
        child.stdout.on("data", (chunk) => (output += chunk));
        child.stderr.on("data", (chunk) => (output += chunk));
        child.once("close", (code) => resolve({ code, output }));
      });
      await until(0, 1, "the backfill never reached the section the editor is saving", 120);
      await editor`commit`;
      const migrated = await migrating;
      assert.equal(migrated.code, 0, migrated.output.slice(-2000));
    } finally {
      await editor`rollback`.catch(() => undefined);
      editor.release();
    }
    const links = (await section(quick!.id)).published.links as Values[];
    assert.deepEqual((links[0]!.label as Values).en, "The editor's save", "the backfill wrote its older copy over the save");
    assert.equal(links[0]!.image, null, "the picture the save removed came back");
    assert.ok(links.every((link) => typeof link._id === "string" && link._id.length > 0), "the section was not stamped");
    // The picture the save let go is free to go.
    assert.equal((await deleteMedia(card)).ok, true);
    await assertNothingDangles();
  });
});

describe("26 · the delete waits for no SEO row (the cycle `SET NULL` could close)", () => {
  test("two SEO rows nothing shows name the picture and a writer holds one: the delete refuses at once instead of waiting; with the writer gone it deletes, and both rows lose the picture", async () => {
    const chosen = await picture("seo-held");
    // Set aside, as the deploy's reconcile leaves a row whose record has gone: they protect nothing.
    const rows = await sql<{ id: number }[]>`
      insert into seo_metadata (entity_type, entity_key, entity_id, title_en, og_image_id)
      values ('package', ${`~media-refs-${RUN}-a`}, 0, 'Set aside', ${chosen.id}),
             ('package', ${`~media-refs-${RUN}-b`}, 0, 'Set aside', ${chosen.id})
      returning id`;
    const ids = rows.map((row) => row.id);
    // A writer — an address moving, a category going with its services — holds the second.
    const writer = await sql.reserve();
    let timer: NodeJS.Timeout | undefined;
    try {
      await writer`begin`;
      await writer`select id from seo_metadata where id = ${ids[1]!} for update`;
      const deleting = deleteMedia(chosen);
      const first = await Promise.race([
        deleting,
        new Promise<"still waiting">((resolve) => (timer = setTimeout(() => resolve("still waiting"), 10_000))),
      ]);
      if (first === "still waiting") {
        await writer`rollback`;
        await deleting;
        assert.fail("the delete waited for an SEO row a writer held — with a second writer holding the other row, a cycle");
      }
      assert.equal(first.ok, false);
      assert.match(first.message ?? "", /is being saved right now\. Nothing was deleted/);
      assert.ok(await inLibrary(chosen), "refused, yet the picture went");
    } finally {
      clearTimeout(timer);
      await writer`rollback`.catch(() => undefined);
      writer.release();
    }
    assert.equal((await deleteMedia(chosen)).ok, true, "nothing shows the picture");
    const after = await sql<{ og_image_id: number | null }[]>`select og_image_id from seo_metadata where id in ${sql(ids)} order by id`;
    assert.deepEqual(after.map((row) => row.og_image_id), [null, null]);
    await sql`delete from seo_metadata where id in ${sql(ids)}`;
  });
});

describe("26 · no deadlock anywhere", () => {
  test("the server wrote no deadlock and no unexpected failure through every race above", () => {
    const log = server.log();
    assert.doesNotMatch(log, /deadlock detected|40P01/i, "a deadlock was detected");
    assert.doesNotMatch(log, /\[visual-editor:(save|detach|route-save|route-resolve|restore)\]|\[reuse:/, "an action failed unexpectedly");
  });
});
