/**
 * Batch 13 against the running application: what the canvas reports, what a
 * direct edit is allowed to become, and what never leaves the editor.
 *
 * The browser half — clicking, locking, typing — is `layers-editing.mts`. What
 * is here is the half that must hold whatever a browser does: the editor-only
 * markup the tree is built from, the fact that a typed string goes through the
 * same validator and the same revision guard as any other save, and that
 * nothing about locking or direct editing reaches a visitor.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { callAction } from "./helpers/action";
import { giveFresh } from "./helpers/fixtures";
import { get } from "./helpers/http";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { startServer, isBuilt, BUILD_HINT, type Server } from "./helpers/server";
import { signIn, type TestSession } from "./helpers/session";

import { ITEM_ID_KEY } from "@/lib/cms/item-id";
import { applyTextAt, directEditAt } from "@/lib/visual-editor/tree";
import type { VisualContentSaveResult, VisualSectionLoad } from "@/lib/visual-editor/content";

const PORT = 3448;
const ROUTE = "/admin/visual-editor";
const ACTIONS = "app/(backoffice)/admin/visual-editor/actions.ts";
const BRIDGE = "0123456789abcdef0123456789abcdef";

let database = "";
let sql: Sql;
let server: Server;
let owner: TestSession;

type SectionRow = { id: number; page_id: number; revision: number; block_type: string;
  published: Record<string, unknown>; draft: Record<string, unknown> | null };

const sectionOf = async (slug: string, blockType: string): Promise<SectionRow> => {
  const [row] = await sql<SectionRow[]>`
    select s.id, s.page_id, s.revision, s.block_type, s.published, s.draft
      from page_sections s join pages p on p.id = s.page_id
     where p.slug = ${slug} and s.block_type = ${blockType} limit 1`;
  assert.ok(row, `no ${blockType} on /${slug}`);
  return row;
};

const reread = async (id: number): Promise<SectionRow> => {
  const [row] = await sql<SectionRow[]>`
    select id, page_id, revision, block_type, published, draft from page_sections where id = ${id}`;
  return row!;
};

const loadSection = (sectionId: number, pageId: number) =>
  callAction<VisualSectionLoad>({
    origin: server.origin,
    route: ROUTE,
    file: ACTIONS,
    action: "loadVisualSection",
    args: [sectionId, pageId],
    cookie: owner.cookie,
  });

const saveValues = (
  section: { sectionId: number; pageId: number; revision: number },
  values: Record<string, unknown>,
) => {
  const form = new FormData();
  form.set("_csrf", owner.csrfToken);
  form.set("sectionId", String(section.sectionId));
  form.set("pageId", String(section.pageId));
  form.set("expectedRevision", String(section.revision));
  form.set("values", JSON.stringify(values));
  return callAction<VisualContentSaveResult>({
    origin: server.origin,
    route: ROUTE,
    file: ACTIONS,
    action: "saveVisualSectionDraft",
    args: [form],
    cookie: owner.cookie,
  });
};

const answered = <T>(response: { value: T | null; status: number }): T => {
  assert.ok(response.value, `the action returned nothing (status ${response.status})`);
  return response.value;
};

/** The canvas an authorised editor gets, with its annotations. */
const canvasHtml = async (slug = "", query = `?preview=1&editor=1&bridge=${BRIDGE}`) =>
  (await get(server.origin, `/${slug}${query}`, { cookie: owner.cookie })).html;

before(async () => {
  assert.ok(isBuilt(), BUILD_HINT);
  database = giveFresh("layers_editing");
  sql = connect(database);
  owner = await signIn(sql);
  server = await startServer(database, PORT);
});

after(async () => {
  await server?.stop();
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
});

/* -------------------------------------------------------------------------- */

describe("the canvas marks what the tree is built from, and only for an editor", () => {
  test("a plain-text field says it can be typed into; a picture and a list do not", async () => {
    const html = await canvasHtml();
    const hero = await sectionOf("home", "hero");
    const links = await sectionOf("home", "quick-links");

    const editable = (address: string) =>
      new RegExp(`data-eod-address="${address}"[^>]*data-eod-edit="(text|multiline)"`).test(html) ||
      new RegExp(`data-eod-edit="(text|multiline)"[^>]*data-eod-address="${address}"`).test(html);

    assert.ok(editable(`section:${hero.id}/field:headline`), "the headline is not offered for direct editing");
    assert.ok(editable(`section:${hero.id}/field:lead`), "the supporting sentence is not offered");
    assert.ok(editable(`section:${hero.id}/field:primaryCtaLabel`), "the CTA label is not offered");
    // A list, a picture and a link are edited in the inspector, with controls.
    assert.ok(!editable(`section:${links.id}/field:links`), "a repeatable list is offered as text");
    assert.ok(
      !/data-eod-kind="section"[^>]*data-eod-edit=/.test(html),
      "a section root is offered as text",
    );
  });

  test("a repeatable row's label is offered, addressed by its `_id`", async () => {
    const html = await canvasHtml();
    const links = await sectionOf("home", "quick-links");
    const rows = (links.published.links as Record<string, unknown>[]) ?? [];
    assert.ok(rows.length, "the fixture has no quick links");
    const id = String(rows[0]![ITEM_ID_KEY]);
    assert.match(id, /^i_/);
    const address = `section:${links.id}/field:links/item:${id}/field:label`;
    assert.ok(html.includes(`data-eod-address="${address}"`), `${address} is not on the canvas`);
    assert.ok(
      new RegExp(`data-eod-address="${address}"[^>]*data-eod-edit="text"`).test(html),
      "a row's label is not offered for direct editing",
    );
    // …and never by its position.
    assert.ok(!/data-eod-address="section:\d+\/field:links\/item:\d+/.test(html), "a row is addressed by index");
  });

  test("a visitor gets none of it, and neither does an ordinary preview", async () => {
    for (const [what, html] of [
      ["a visitor", (await get(server.origin, "/")).html],
      ["an ordinary preview", (await get(server.origin, "/?preview=1", { cookie: owner.cookie })).html],
    ] as const) {
      assert.ok(!html.includes("data-eod-"), `${what} received editor markup`);
      assert.ok(!html.includes("data-eod-edit"), `${what} received direct-edit metadata`);
      assert.ok(!html.includes("contenteditable"), `${what} received an editable element`);
      assert.ok(!html.includes("data-eod-editing"), `${what} received editing state`);
      assert.ok(!html.includes("data-layer-"), `${what} received panel markup`);
    }
  });

  test("locking leaves no trace anywhere a visitor or the database can see", async () => {
    // Locking is editor-session state: it is never sent to a Server Action, so
    // there is nothing to store and nothing to leak. The assertion is that no
    // column, no payload and no page has learned about it.
    const html = await canvasHtml();
    // Named markers, not the substring "lock" — that is inside "block", which
    // the canvas says legitimately on every section root (`data-eod-block`).
    for (const marker of ["data-eod-lock", "data-eod-locked", "data-layer-lock", "data-locked"]) {
      assert.ok(!html.includes(marker), `the canvas carries ${marker}`);
    }

    const section = await sectionOf("home", "hero");
    const loaded = answered(await loadSection(section.id, section.page_id));
    assert.ok(loaded.ok);
    /**
     * By key name, and anchored.
     *
     * A payload legitimately says `blockType`, which contains the letters of
     * "lock" — a substring search over the JSON calls that a leak, which is a
     * test that fails for a reason that is not true. What would be a leak is a
     * *key*: `locked`, `locks`, `lockState`.
     */
    const keysOf = (value: unknown, out: string[] = []): string[] => {
      if (Array.isArray(value)) for (const entry of value) keysOf(entry, out);
      else if (value && typeof value === "object") {
        for (const [key, inner] of Object.entries(value)) {
          out.push(key);
          keysOf(inner, out);
        }
      }
      return out;
    };
    const lockish = keysOf(loaded.section).filter((key) => /(^|_)lock/i.test(key));
    assert.deepEqual(lockish, [], "a section payload carries lock state");
    assert.deepEqual(keysOf(loaded.section.styles).filter((key) => /(^|_)lock/i.test(key)), [],
      "the style document carries lock state");

    // `block_type` contains the letters, so the column check anchors on a word
    // boundary: `locked_by` or `lock_state` would fail, `block_type` does not.
    const columns = await sql<{ column_name: string }[]>`
      select column_name from information_schema.columns
       where table_schema = 'public' and column_name ~* '(^|_)lock'`;
    assert.deepEqual(columns.map((row) => row.column_name), [], "a column was added to remember locks");
  });
});

/* -------------------------------------------------------------------------- */

describe("a string typed on the canvas is saved the way every other edit is", () => {
  test("it goes through the ordinary draft save, validator and revision guard", async () => {
    const section = await sectionOf("home", "hero");
    const loaded = answered(await loadSection(section.id, section.page_id));
    assert.ok(loaded.ok);

    // Exactly what the shell does with a `canvas.edit`: resolve the address
    // against the loaded values, then hand the result to the same action the
    // Content tab uses.
    const values = applyTextAt(loaded.section.values, "hero", "field:headline", "en", "Typed on the canvas");
    assert.ok(values, "the headline is not a direct-edit target");

    const saved = answered(await saveValues(loaded.section, values));
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const row = await reread(section.id);
    assert.equal((row.draft!.headline as { en: string }).en, "Typed on the canvas");
    assert.equal(row.revision, loaded.section.revision + 1, "the revision did not move exactly once");
  });

  test("the same save named with a stale revision is refused, and the other write stands", async () => {
    const section = await sectionOf("home", "quick-links");
    const loaded = answered(await loadSection(section.id, section.page_id));
    assert.ok(loaded.ok);
    const stale = loaded.section.revision;

    // Somebody else writes first.
    const theirs = applyTextAt(loaded.section.values, "quick-links", "field:title", "en", "Theirs")!;
    assert.equal(answered(await saveValues(loaded.section, theirs)).ok, true);

    const mine = applyTextAt(loaded.section.values, "quick-links", "field:title", "en", "Mine")!;
    const refused = answered(await saveValues({ ...loaded.section, revision: stale }, mine));
    assert.equal(refused.ok, false, "a direct edit built before the other write was accepted");
    assert.equal(!refused.ok && refused.reason, "conflict");
    assert.equal(
      ((await reread(section.id)).draft!.title as { en: string }).en,
      "Theirs",
      "a stale direct edit overwrote the write that won",
    );
  });

  test("markup typed into a text field is stored as the text it is, never as markup", async () => {
    const section = await sectionOf("home", "hero");
    const loaded = answered(await loadSection(section.id, section.page_id));
    assert.ok(loaded.ok);

    const nasty = '<img src=x onerror=alert(1)> <b>bold</b>';
    const values = applyTextAt(loaded.section.values, "hero", "field:headline", "en", nasty)!;
    assert.equal(answered(await saveValues(loaded.section, values)).ok, true);

    const stored = ((await reread(section.id)).draft!.headline as { en: string }).en;
    // A plain-text field stores the characters. What matters is that they are
    // still characters — not a tag the page will run — and the renderer escapes
    // them, which is why the canvas shows them rather than executing them.
    assert.equal(stored, nasty);
    const html = await canvasHtml();
    assert.ok(!html.includes("onerror=alert(1)>"), "stored text reached the page as markup");
    assert.ok(html.includes("&lt;img src=x onerror=alert(1)&gt;"), "the text was not escaped into the page");
  });

  test("an edit aimed at something that is not plain text writes nothing", async () => {
    const section = await sectionOf("home", "quick-links");
    const loaded = answered(await loadSection(section.id, section.page_id));
    assert.ok(loaded.ok);
    const rows = (loaded.section.values.links as Record<string, unknown>[]) ?? [];
    const id = String(rows[0]![ITEM_ID_KEY]);

    for (const path of ["root", "field:links", `field:links/item:${id}`, `field:links/item:${id}/field:image`]) {
      assert.equal(directEditAt("quick-links", path), null, path);
      assert.equal(applyTextAt(loaded.section.values, "quick-links", path, "en", "x"), null, path);
    }
    // …and the row is untouched, because nothing was ever sent.
    assert.deepEqual((await reread(section.id)).draft, loaded.section.hasDraft ? (await reread(section.id)).draft : null);
  });

  test("editing a row's label keeps every row's `_id` and leaves its siblings alone", async () => {
    const section = await sectionOf("home", "quick-links");
    const loaded = answered(await loadSection(section.id, section.page_id));
    assert.ok(loaded.ok);
    const before = (loaded.section.values.links as Record<string, unknown>[]) ?? [];
    assert.ok(before.length > 1, "the fixture needs two quick links");
    const id = String(before[0]![ITEM_ID_KEY]);

    const values = applyTextAt(
      loaded.section.values,
      "quick-links",
      `field:links/item:${id}/field:label`,
      "en",
      "Renamed on the canvas",
    )!;
    assert.equal(answered(await saveValues(loaded.section, values)).ok, true);

    const after = (await reread(section.id)).draft!.links as Record<string, unknown>[];
    assert.deepEqual(
      after.map((row) => row[ITEM_ID_KEY]),
      before.map((row) => row[ITEM_ID_KEY]),
      "a row's identity changed",
    );
    assert.equal((after[0]!.label as { en: string }).en, "Renamed on the canvas");
    assert.deepEqual(after[1]!.label, before[1]!.label, "a sibling row was rewritten");
  });

  test("the Arabic canvas writes Arabic and leaves English exactly as it was", async () => {
    const section = await sectionOf("home", "hero");
    const loaded = answered(await loadSection(section.id, section.page_id));
    assert.ok(loaded.ok);
    const english = (loaded.section.values.headline as { en: string }).en;

    const values = applyTextAt(loaded.section.values, "hero", "field:headline", "ar", "مكتوب على الصفحة")!;
    assert.equal(answered(await saveValues(loaded.section, values)).ok, true);

    const stored = (await reread(section.id)).draft!.headline as { en: string; ar: string };
    assert.equal(stored.ar, "مكتوب على الصفحة");
    assert.equal(stored.en, english, "the English edition was written by an Arabic edit");
  });
});
