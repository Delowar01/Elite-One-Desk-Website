/**
 * The Visual Editor route, and what authenticating for it does and does not
 * unlock — measured against the running application.
 *
 * The rule the whole batch rests on: **editor mode is only ever reached through
 * an authorised preview.** A visitor who guesses the parameters must get the
 * published page, no drafts, and none of the editor's code. That cannot be
 * checked by reading `resolvePageForRender`; it has to be asked of the server.
 *
 * The other half is composition. Batch 2 gave a page a structural draft and
 * this batch makes authenticated preview honour it, so the same page is fetched
 * three ways — anonymously, as an ordinary preview, and as a canvas — and the
 * sections that come back are compared.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { giveFresh } from "./helpers/fixtures";
import { get } from "./helpers/http";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { startServer, isBuilt, BUILD_HINT, type Server } from "./helpers/server";
import { signIn } from "./helpers/session";

const PORT = 3441;
const BRIDGE = "0123456789abcdef0123456789abcdef";

let database = "";
let sql: Sql;
let server: Server;
let owner = "";

/** The order the renderer put the sections in — it stamps each one's type. */
const rendered = (html: string): string[] =>
  [...html.matchAll(/data-section="([a-z-]+)"/g)].map((match) => match[1]!);

/**
 * Whether the editor's canvas bridge is in the document's component tree.
 *
 * `bridgeId` is the prop name the client component is given, and it appears in
 * the streamed payload only when the server actually rendered that component.
 * It is the honest discriminator; the bridge *value* is not, because Next
 * echoes a request's own search params back into its routing payload — so a
 * visitor who types `&bridge=xyz` finds `xyz` in their own page whatever the
 * server decided, having put it there themselves.
 */
const hasBridge = (html: string): boolean => html.includes("bridgeId");

/** Every editor address the server wrote into the markup, in document order. */
const addresses = (html: string): string[] =>
  [...html.matchAll(/data-eod-address="([^"]+)"/g)].map((match) => match[1]!);

before(async () => {
  assert.ok(isBuilt(), BUILD_HINT);
  database = giveFresh("visual_editor");
  sql = connect(database);
  owner = (await signIn(sql)).cookie;
  server = await startServer(database, PORT);
});

after(async () => {
  await server?.stop();
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
});

/* -------------------------------------------------------------------------- */

describe("the editor route is behind the ordinary admin wall", () => {
  test("signed out, it bounces to the login screen and keeps the destination", async () => {
    const page = await get(server.origin, "/admin/visual-editor");
    assert.equal(page.status, 307);
    assert.match(page.location ?? "", /^\/admin\/login\?next=/);
    assert.match(decodeURIComponent(page.location ?? ""), /\/admin\/visual-editor/);
  });

  test("with content.view it opens, listing the pages from the table", async () => {
    const page = await get(server.origin, "/admin/visual-editor", { cookie: owner });
    assert.equal(page.status, 200);
    assert.match(page.html, /Visual Editor/);

    // Every row in `pages`, not a list written into the editor.
    const slugs = await sql<{ slug: string; title: string }[]>`
      select slug, title_en as title from pages order by kind, sort_order, id
    `;
    for (const row of slugs) {
      assert.ok(page.html.includes(`value="${row.slug}"`), `${row.slug} is not offered`);
    }
  });

  test("it carries the empty panels and no way to save anything yet", async () => {
    const page = await get(server.origin, "/admin/visual-editor", { cookie: owner });
    assert.match(page.html, /Page structure/);
    assert.match(page.html, /Inspector/);
    assert.ok(!/>\s*(Save|Publish|Save changes)\s*</.test(page.html), "a save control appeared");
  });

  test("an unknown page in the address falls back instead of crashing", async () => {
    for (const query of [
      "?page=does-not-exist",
      "?page=../../etc/passwd",
      "?page=",
      "?lang=fr&device=watch",
      "?page=home&lang=&device=",
    ]) {
      const page = await get(server.origin, `/admin/visual-editor${query}`, { cookie: owner });
      assert.equal(page.status, 200, query);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("editor mode is a door inside preview, not beside it", () => {
  test("a visitor guessing the parameters gets the published page and no bridge", async () => {
    const page = await get(server.origin, `/?preview=1&editor=1&bridge=${BRIDGE}`);
    assert.equal(page.status, 200);
    assert.ok(!page.html.includes("Preview — showing"), "a visitor was shown drafts");
    assert.ok(!hasBridge(page.html), "a visitor was given the editor bridge");
    assert.ok(!/data-eod-/.test(page.html), "a visitor was given editor markup");

    // And it is the same document an ordinary request produces.
    const plain = await get(server.origin, "/");
    assert.deepEqual(rendered(page.html), rendered(plain.html));
  });

  test("an ordinary authenticated preview still looks exactly as it did", async () => {
    const page = await get(server.origin, "/?preview=1", { cookie: owner });
    assert.equal(page.status, 200);
    assert.match(page.html, /Preview — showing unpublished drafts/);
    assert.ok(!hasBridge(page.html), "a plain preview loaded the editor bridge");
    // Selection is the editor's, not preview's: an ordinary preview is the site.
    assert.ok(!/data-eod-/.test(page.html), "a plain preview was annotated");
  });

  test("an authorised canvas request drops the banner and carries the bridge", async () => {
    const page = await get(server.origin, `/?preview=1&editor=1&bridge=${BRIDGE}`, { cookie: owner });
    assert.equal(page.status, 200);
    assert.ok(!page.html.includes("Preview — showing"), "the banner belongs to the standalone preview");
    assert.ok(hasBridge(page.html), "the canvas did not get its bridge");
    assert.match(page.html, new RegExp(`bridgeId[^}]{0,20}${BRIDGE}`), "the canvas got the wrong bridge id");
    // The real site, not a copy of it.
    assert.match(page.html, /<header/);
    assert.match(page.html, /<footer/);
  });

  test("a malformed bridge id is not editor mode — it is an ordinary preview", async () => {
    for (const bridge of ["", "short", "a".repeat(200), "../../etc", "has space"]) {
      const page = await get(
        server.origin,
        `/?preview=1&editor=1&bridge=${encodeURIComponent(bridge)}`,
        { cookie: owner },
      );
      assert.equal(page.status, 200, bridge);
      assert.match(page.html, /Preview — showing unpublished drafts/, bridge);
      assert.ok(!hasBridge(page.html), bridge);
      assert.ok(!/data-eod-/.test(page.html), bridge);
    }
  });

  test("the same rules hold for a page that is not the homepage, in both editions", async () => {
    for (const path of ["/about", "/ar/about"]) {
      const visitor = await get(server.origin, `${path}?preview=1&editor=1&bridge=${BRIDGE}`);
      assert.ok(!hasBridge(visitor.html), path);
      assert.ok(!visitor.html.includes("Preview — showing"), path);

      const canvas = await get(server.origin, `${path}?preview=1&editor=1&bridge=${BRIDGE}`, {
        cookie: owner,
      });
      assert.equal(canvas.status, 200, path);
      assert.ok(hasBridge(canvas.html), path);
      assert.ok(!canvas.html.includes("Preview — showing"), path);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("the canvas honours a structural draft; the live site never does", () => {
  test("a reordered draft moves the preview and leaves the public page alone", async () => {
    const [page] = await sql<{ id: number }[]>`select id from pages where slug = 'home'`;
    const sections = await sql<{ id: number; block_type: string }[]>`
      select id, block_type from page_sections
       where page_id = ${page!.id} and is_published order by position, id
    `;
    assert.ok(sections.length >= 3, "the fixture homepage is too short to reorder");

    const live = await get(server.origin, "/");
    const liveOrder = rendered(live.html);

    // Reverse the order, and drop the second section — a pending deletion.
    const reversed = [...sections].reverse().filter((row) => row.id !== sections[1]!.id);
    await sql`
      update pages set draft_structure = ${JSON.stringify({
        v: 1,
        sections: reversed.map((row) => ({ sectionId: row.id, visible: true })),
      })}::text::jsonb
      where id = ${page!.id}
    `;

    try {
      const canvas = await get(server.origin, `/?preview=1&editor=1&bridge=${BRIDGE}`, {
        cookie: owner,
      });
      assert.deepEqual(
        rendered(canvas.html),
        reversed.map((row) => row.block_type),
        "the canvas did not follow the structural draft",
      );

      // The omitted section is a pending deletion, so it is not in the canvas …
      assert.ok(!rendered(canvas.html).includes(sections[1]!.block_type) ||
        reversed.some((row) => row.block_type === sections[1]!.block_type));

      // … and the ordinary preview follows the same composition, because it is
      // the same resolver. The canvas is a preview wearing editor clothes.
      const preview = await get(server.origin, "/?preview=1", { cookie: owner });
      assert.deepEqual(rendered(preview.html), rendered(canvas.html));

      // The public page has not moved at all.
      const after = await get(server.origin, "/");
      assert.deepEqual(rendered(after.html), liveOrder, "a draft structure reached the live site");
    } finally {
      await sql`update pages set draft_structure = null where id = ${page!.id}`;
    }
  });

  test("a hidden section and a draft-only one are both in the canvas, and neither is live", async () => {
    const [page] = await sql<{ id: number }[]>`select id from pages where slug = 'about'`;
    const rows = await sql<{ id: number }[]>`
      select id from page_sections where page_id = ${page!.id} order by position, id
    `;
    assert.ok(rows.length > 0);

    const [pending] = await sql<{ id: number }[]>`
      insert into page_sections (page_id, block_type, position, is_published, is_draft_only, published, draft)
      values (
        ${page!.id}, 'rich-text', 900, false, true, '{}'::jsonb,
        ${JSON.stringify({ title: { en: "PENDING SECTION", ar: "" }, body: { en: "<p>pending</p>", ar: "" } })}::text::jsonb
      )
      returning id
    `;
    await sql`update page_sections set is_published = false where id = ${rows[0]!.id}`;
    await sql`
      update pages set draft_structure = ${JSON.stringify({
        v: 1,
        sections: [
          { sectionId: pending!.id, visible: true },
          { sectionId: rows[0]!.id, visible: false },
        ],
      })}::text::jsonb
      where id = ${page!.id}
    `;

    try {
      const canvas = await get(server.origin, `/about?preview=1&editor=1&bridge=${BRIDGE}`, {
        cookie: owner,
      });
      assert.equal(canvas.status, 200);
      assert.match(canvas.html, /PENDING SECTION/, "a draft-only section is missing from the canvas");
      assert.equal(
        rendered(canvas.html).length,
        2,
        "the canvas should show exactly the two sections the draft names",
      );

      const live = await get(server.origin, "/about");
      assert.ok(!live.html.includes("PENDING SECTION"), "a pending section reached the live site");
    } finally {
      await sql`update pages set draft_structure = null where id = ${page!.id}`;
      await sql`delete from page_sections where id = ${pending!.id}`;
      await sql`update page_sections set is_published = true where id = ${rows[0]!.id}`;
    }
  });

  test("a corrupt structure shows the page as it stands rather than blanking it", async () => {
    const [page] = await sql<{ id: number }[]>`select id from pages where slug = 'home'`;
    const before = rendered((await get(server.origin, "/?preview=1", { cookie: owner })).html);

    for (const corrupt of ['"nonsense"', '{"sections":[{"sectionId":1}]}', '{"v":99,"sections":[]}', "[]"]) {
      await sql`update pages set draft_structure = ${corrupt}::text::jsonb where id = ${page!.id}`;
      const preview = await get(server.origin, "/?preview=1", { cookie: owner });
      assert.equal(preview.status, 200, corrupt);
      assert.deepEqual(rendered(preview.html), before, corrupt);
      const live = await get(server.origin, "/");
      assert.equal(live.status, 200, corrupt);
    }
    await sql`update pages set draft_structure = null where id = ${page!.id}`;
  });

  test("a structure naming another page's section cannot pull it in", async () => {
    const [home] = await sql<{ id: number }[]>`select id from pages where slug = 'home'`;
    const [foreign] = await sql<{ id: number; block_type: string }[]>`
      select s.id, s.block_type from page_sections s
        join pages p on p.id = s.page_id
       where p.slug = 'about' order by s.position limit 1
    `;
    const [mine] = await sql<{ id: number; block_type: string }[]>`
      select id, block_type from page_sections where page_id = ${home!.id} order by position limit 1
    `;

    await sql`
      update pages set draft_structure = ${JSON.stringify({
        v: 1,
        sections: [
          { sectionId: mine!.id, visible: true },
          { sectionId: foreign!.id, visible: true },
        ],
      })}::text::jsonb
      where id = ${home!.id}
    `;

    try {
      const canvas = await get(server.origin, `/?preview=1&editor=1&bridge=${BRIDGE}`, {
        cookie: owner,
      });
      assert.deepEqual(rendered(canvas.html), [mine!.block_type], "a foreign section reached the canvas");
    } finally {
      await sql`update pages set draft_structure = null where id = ${home!.id}`;
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("the canvas is annotated; nothing else is", () => {
  const canvas = (path = "/") =>
    get(server.origin, `${path}?preview=1&editor=1&bridge=${BRIDGE}`, { cookie: owner });

  test("every rendered section gets a root, and it is its database id", async () => {
    const page = await canvas();
    const roots = [...page.html.matchAll(/data-eod-kind="section"/g)];
    assert.ok(roots.length >= 5, `${roots.length} section roots`);

    const ids = await sql<{ id: number }[]>`
      select s.id from page_sections s join pages p on p.id = s.page_id
       where p.slug = 'home' and s.is_published order by s.position, s.id
    `;
    for (const row of ids) {
      assert.ok(page.html.includes(`data-eod-address="section:${row.id}"`), `section ${row.id}`);
      assert.ok(page.html.includes(`data-eod-section="${row.id}"`), `section ${row.id} id`);
    }
  });

  test("fields are addressed relative to their section", async () => {
    const found = addresses((await canvas()).html);
    assert.ok(
      found.some((address) => /^section:\d+\/field:headline$/.test(address)),
      "the hero headline is not addressable",
    );
    assert.ok(
      found.some((address) => /^section:\d+\/field:lead$/.test(address)),
      "the hero lead is not addressable",
    );
    for (const address of found) {
      assert.match(address, /^section:[1-9][0-9]*(\/.+)?$/, address);
      assert.ok(!address.includes("@"), `${address} carries a locale`);
      assert.ok(!/\[\d+\]/.test(address), `${address} carries an index`);
    }
  });

  test("a repeatable row is addressed by its `_id`, matching what the database holds", async () => {
    const [row] = await sql<{ published: Record<string, unknown> }[]>`
      select s.published from page_sections s join pages p on p.id = s.page_id
       where p.slug = 'home' and s.block_type = 'quick-links' limit 1
    `;
    const links = (row!.published.links ?? []) as Array<Record<string, unknown>>;
    assert.ok(links.length >= 2, "the fixture has no quick links to address");

    const html = (await canvas()).html;
    for (const link of links) {
      const id = String(link._id);
      assert.match(id, /^i_[0-9A-Za-z]+$/);
      assert.ok(html.includes(`/field:links/item:${id}"`), `row ${id} is not selectable`);
      assert.ok(html.includes(`/field:links/item:${id}/field:label"`), `row ${id}'s label is not selectable`);
    }
  });

  test("the address does not change with the language", async () => {
    const english = addresses((await canvas("/")).html);
    const arabic = addresses((await canvas("/ar")).html);
    assert.deepEqual(arabic, english, "the editions disagree about what the page is made of");
  });

  test("a section root carries what Layers needs and nothing more", async () => {
    const html = (await canvas()).html;
    assert.match(html, /data-eod-draft="(true|false)"/);
    assert.match(html, /data-eod-draft-only="(true|false)"/);
    assert.match(html, /data-eod-visible="(true|false)"/);
    // No markup, no classes, no selectors — identity is the address.
    assert.ok(!/data-eod-(html|selector|class|index)=/.test(html));
  });

  test("a draft-only section is marked as one, and a hidden one as hidden", async () => {
    const [page] = await sql<{ id: number }[]>`select id from pages where slug = 'about'`;
    const [pending] = await sql<{ id: number }[]>`
      insert into page_sections (page_id, block_type, position, is_published, is_draft_only, published, draft)
      values (
        ${page!.id}, 'rich-text', 900, false, true, '{}'::jsonb,
        ${JSON.stringify({ title: { en: "PENDING", ar: "" }, body: { en: "<p>x</p>", ar: "" } })}::text::jsonb
      )
      returning id
    `;
    const [first] = await sql<{ id: number }[]>`
      select id from page_sections where page_id = ${page!.id} and not is_draft_only order by position limit 1
    `;
    await sql`
      update pages set draft_structure = ${JSON.stringify({
        v: 1,
        sections: [
          { sectionId: first!.id, visible: false },
          { sectionId: pending!.id, visible: true },
        ],
      })}::text::jsonb where id = ${page!.id}
    `;

    try {
      const html = (await canvas("/about")).html;
      const root = (id: number) => {
        const at = html.indexOf(`data-eod-address="section:${id}"`);
        assert.notEqual(at, -1, `section ${id} did not render`);
        return html.slice(Math.max(0, at - 400), at + 200);
      };
      assert.match(root(pending!.id), /data-eod-draft-only="true"/);
      assert.match(root(first!.id), /data-eod-visible="false"/);
      assert.match(root(first!.id), /data-eod-draft-only="false"/);
      // Layers is built from this, so a section the draft omits is simply not
      // here to be listed.
      assert.equal([...html.matchAll(/data-eod-kind="section"/g)].length, 2);
    } finally {
      await sql`update pages set draft_structure = null where id = ${page!.id}`;
      await sql`delete from page_sections where id = ${pending!.id}`;
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("nothing a visitor sees has changed", () => {
  test("the ordinary pages answer as they always did, in both editions", async () => {
    for (const path of ["/", "/ar", "/about", "/ar/about", "/contact", "/privacy"]) {
      const page = await get(server.origin, path);
      assert.equal(page.status, 200, path);
      assert.ok(!hasBridge(page.html), `${path} carries editor code`);
      assert.ok(!page.html.includes("Preview — showing"), `${path} carries a preview banner`);
      assert.ok(!/data-eod-/.test(page.html), `${path} carries editor markup`);
    }
  });

  test("the existing preview screen is untouched", async () => {
    const page = await get(server.origin, "/admin/pages/about/preview", { cookie: owner });
    assert.equal(page.status, 200);
    assert.match(page.html, /Preview — About/);
    // Its own device list is unchanged: Desktop still means "as wide as this panel".
    assert.match(page.html, /Desktop/);
    assert.match(page.html, /834|Tablet/);
  });
});
