/**
 * Batch 15b against the running application: parallax, hover and word reveal
 * saved through the real Server Actions, read back from the database and from
 * the real rendered pages — public, ordinary Preview and the Visual Editor's
 * canvas — and carried through publication, discard, history, restore and
 * duplication with nothing new in the storage.
 *
 * The governing rule is Batch 15a's, carried to the new keys: **editing motion
 * must not change what a visitor sees move until it is explicitly published**,
 * and one Motion save owns the whole document.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { callAction, type ActionResponse } from "./helpers/action";
import { giveFresh } from "./helpers/fixtures";
import { get } from "./helpers/http";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { startServer, isBuilt, BUILD_HINT, type Server } from "./helpers/server";
import { signIn, type TestSession } from "./helpers/session";
import { readFileSync } from "node:fs";
import path from "node:path";

import { REPO_ROOT } from "./helpers/env";
import { getBlock } from "@/lib/cms/blocks";
import { MOTION_DOCUMENT_VERSION, type MotionDocument, type MotionTarget } from "@/lib/cms/motion-doc";
import { WORD_LIMIT } from "@/lib/cms/motion-css";
import { wordCount } from "@/lib/cms/words";
import type { VisualMotionSaveResult, VisualSectionLoad } from "@/lib/visual-editor/content";
import { hoversFor, motionTargetFor } from "@/lib/visual-editor/motion-targets";
import type { PageActionResult, PageHistoryView, PageSummaryView } from "@/lib/visual-editor/publish";

const PORT = 3450;
const VE_ACTIONS = "app/(backoffice)/admin/visual-editor/actions.ts";
const VE_ROUTE = "/admin/visual-editor";
const BRIDGE = "0123456789abcdef0123456789abcdef";

let database = "";
let sql: Sql;
let server: Server;
let owner: TestSession;

type SectionRow = {
  id: number;
  page_id: number;
  revision: number;
  block_type: string;
  draft: Record<string, unknown> | null;
  published: Record<string, unknown>;
  animation: string;
  draft_animation: string | null;
  motion_config: MotionDocument | null;
  draft_motion_config: MotionDocument | null;
};

const row = async (id: number): Promise<SectionRow> => {
  const [found] = await sql<SectionRow[]>`
    select id, page_id, revision, block_type, draft, published, animation, draft_animation, motion_config, draft_motion_config
      from page_sections where id = ${id}`;
  assert.ok(found, `section ${id} is missing`);
  return found;
};
const pageBySlug = async (slug: string) => {
  const [found] = await sql<{ id: number; slug: string; revision: number }[]>`
    select id, slug, revision from pages where slug = ${slug}`;
  assert.ok(found, `no page ${slug}`);
  return found;
};
const sectionOf = async (slug: string, blockType: string): Promise<SectionRow> => {
  const page = await pageBySlug(slug);
  const [found] = await sql<{ id: number }[]>`
    select id from page_sections where page_id = ${page.id} and block_type = ${blockType} order by position limit 1`;
  assert.ok(found, `no ${blockType} on /${slug}`);
  return row(found.id);
};
async function reset(slug: string) {
  const page = await pageBySlug(slug);
  await sql`delete from page_sections where page_id = ${page.id}`;
  await sql`insert into page_sections select * from eodt_sections_backup where page_id = ${page.id}`;
  await sql`update pages set draft_structure = null, revision = revision + 1 where id = ${page.id}`;
  await sql`delete from page_versions where page_id = ${page.id}`;
  return pageBySlug(slug);
}
function answered<T>(response: ActionResponse<T>): T {
  assert.ok(response.value, `the action returned nothing (status ${response.status})`);
  return response.value;
}
const doc = (section: MotionTarget = {}, nodes: Record<string, MotionTarget> = {}): MotionDocument => ({
  v: MOTION_DOCUMENT_VERSION,
  section,
  nodes,
});

function saveDocument(section: { id: number; page_id: number; revision: number }, document: unknown, revision?: number) {
  const form = new FormData();
  form.set("_csrf", owner.csrfToken);
  form.set("sectionId", String(section.id));
  form.set("pageId", String(section.page_id));
  form.set("expectedRevision", String(revision ?? section.revision));
  form.set("motionDocument", JSON.stringify(document));
  return callAction<VisualMotionSaveResult>({
    origin: server.origin,
    route: VE_ROUTE,
    file: VE_ACTIONS,
    action: "saveVisualSectionMotion",
    args: [form],
    cookie: owner.cookie,
  });
}
function saveContent(section: { id: number; page_id: number; revision: number }, values: Record<string, unknown>) {
  const form = new FormData();
  form.set("_csrf", owner.csrfToken);
  form.set("sectionId", String(section.id));
  form.set("pageId", String(section.page_id));
  form.set("expectedRevision", String(section.revision));
  form.set("values", JSON.stringify(values));
  return callAction<{ ok: boolean; reason?: string; section?: { revision: number; values: Record<string, unknown> } }>({
    origin: server.origin,
    route: VE_ROUTE,
    file: VE_ACTIONS,
    action: "saveVisualSectionDraft",
    args: [form],
    cookie: owner.cookie,
  });
}
function saveStyles(section: { id: number; page_id: number; revision: number }, styles: unknown) {
  const form = new FormData();
  form.set("_csrf", owner.csrfToken);
  form.set("sectionId", String(section.id));
  form.set("pageId", String(section.page_id));
  form.set("expectedRevision", String(section.revision));
  form.set("styles", JSON.stringify(styles));
  return callAction<{ ok: boolean; revision?: number }>({
    origin: server.origin,
    route: VE_ROUTE,
    file: VE_ACTIONS,
    action: "saveVisualSectionStyles",
    args: [form],
    cookie: owner.cookie,
  });
}
const pageForm = (page: { id: number; revision: number }, extra: Record<string, string> = {}) => {
  const form = new FormData();
  form.set("_csrf", owner.csrfToken);
  form.set("pageId", String(page.id));
  form.set("expectedRevision", String(page.revision));
  for (const [key, value] of Object.entries(extra)) form.set(key, value);
  return form;
};
const editorAction = <T>(action: string, form: FormData) =>
  callAction<T>({ origin: server.origin, route: VE_ROUTE, file: VE_ACTIONS, action, args: [form], cookie: owner.cookie });
const publish = async (slug: string) =>
  answered(await editorAction<PageActionResult>("publishPageFromEditor", pageForm(await pageBySlug(slug))));
const discardAll = async (slug: string) =>
  answered(await editorAction<PageActionResult>("discardPageFromEditor", pageForm(await pageBySlug(slug))));
const restore = async (slug: string, versionId: number) =>
  answered(await editorAction<PageActionResult>("restoreVersionFromEditor", pageForm(await pageBySlug(slug), { versionId: String(versionId) })));
const pageView = async <T>(action: string, slug: string) =>
  answered(
    await callAction<T | null>({
      origin: server.origin,
      route: VE_ROUTE,
      file: VE_ACTIONS,
      action,
      args: [(await pageBySlug(slug)).id],
      cookie: owner.cookie,
    }),
  )!;
const loadSection = (sectionId: number, pageId: number) =>
  callAction<VisualSectionLoad>({
    origin: server.origin,
    route: VE_ROUTE,
    file: VE_ACTIONS,
    action: "loadVisualSection",
    args: [sectionId, pageId],
    cookie: owner.cookie,
  });

const livePath = (slug: string) => (slug === "home" ? "/" : `/${slug}`);
const live = async (slug: string) => (await get(server.origin, livePath(slug))).html;
const preview = async (slug: string) => (await get(server.origin, `${livePath(slug)}?preview=1`, { cookie: owner.cookie })).html;
const canvas = async (slug: string) =>
  (await get(server.origin, `${livePath(slug)}?preview=1&editor=1&bridge=${BRIDGE}`, { cookie: owner.cookie })).html;
/** The HTML before the streamed flight payload, which quotes attributes back. */
const markup = (html: string) => {
  const at = html.search(/<script[^>]*>\s*\(?self\.__next_f/);
  return at < 0 ? html : html.slice(0, at);
};
const count = (html: string, needle: string) => markup(html).split(needle).length - 1;
/**
 * Every Suspense boundary as the visitor ends up with it.
 *
 * React writes a boundary that was not ready at the first flush as a
 * placeholder — `<!--$?--><template id="B:n"></template>` — and sends its
 * content later in a hidden `<div id="S:n">` that a script moves into place.
 * Whether one made the first flush is timing, and Next 15 puts such a boundary
 * inside the page itself: the streamed-metadata outlet at the end of the page
 * segment, which renders nothing. So the placeholder is replaced by what was
 * streamed for it, exactly as the browser does, and a boundary that was late
 * compares equal to one that was not.
 */
function settled(html: string): string {
  const streamed = (n: string): string => {
    const open = `<div hidden id="S:${n}">`;
    const at = html.indexOf(open);
    if (at < 0) return "";
    const from = at + open.length;
    const tags = /<div\b|<\/div>/g;
    tags.lastIndex = from;
    let depth = 1;
    for (let match = tags.exec(html); match; match = tags.exec(html)) {
      depth += match[0] === "</div>" ? -1 : 1;
      if (depth === 0) return html.slice(from, match.index);
    }
    return "";
  };
  return html.replace(
    /<!--\$\?--><template id="B:(\d+)"><\/template>[\s\S]*?<!--\/\$-->/g,
    (_boundary, n: string) => `<!--$-->${streamed(n)}<!--/$-->`,
  );
}

/**
 * What a visitor is shown, in a form two renders of one unchanged page compare
 * equal in: the page's title, and its `<main>` — every section — with the
 * per-request nonces removed and every streamed boundary settled.
 *
 * Not the whole document. Next 15 streams page metadata, and whether the
 * `<title>` and meta tags are written inside `<head>` or arrive later in the
 * body behind a `<template id="B:0">` placeholder depends on how quickly they
 * resolved on that particular request. Two renders of the same page can
 * therefore differ byte for byte outside `<main>` while showing exactly the same
 * thing — which is how the restore test below failed once in the Batch 16
 * baseline run with identical sections on both sides. The same outlet also
 * sits at the end of `<main>` as an empty boundary, pending on one request and
 * resolved on the next — which failed it once more in the Batch 16 final
 * runs — hence `settled`. Nothing a draft, a discard or a restore can change
 * lives outside `<main>` or the title.
 */
const stable = (html: string) => {
  const title = html.match(/<title>([^<]*)<\/title>/)?.[1] ?? "";
  const page = markup(settled(html)).replace(/ nonce="[^"]*"/g, "");
  const main = page.match(/<main id="main"[^>]*>[\s\S]*<\/main>/)?.[0];
  assert.ok(main, "the page has no <main> to compare");
  return `${title}\n${main}`;
};
/** Every annotated element's opening tag, by address. */
const annotated = (html: string): Map<string, string> => {
  const out = new Map<string, string>();
  for (const match of markup(html).matchAll(/<[a-z0-9]+\s[^<>]*data-eod-address="([^"]+)"[^<>]*>/g)) out.set(match[1]!, match[0]);
  return out;
};

before(async () => {
  assert.ok(isBuilt(), BUILD_HINT);
  database = giveFresh("visual_motion_15b");
  sql = connect(database);
  owner = await signIn(sql);
  await sql`create table eodt_sections_backup as select * from page_sections`;
  server = await startServer(database, PORT);
});

after(async () => {
  await server?.stop();
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
});

/* -------------------------------------------------------------------------- */

describe("the new keys are saved in the same document, and what no node can show is stripped on the way in", () => {
  test("a document with parallax, hover and words lands in the draft column, and nothing live moves", async () => {
    await reset("about");
    const why = await sectionOf("about", "why-us");
    const points = (why.published.points as { _id: string }[]).map((point) => point._id);
    const submitted = doc(
      {},
      {
        "field:title": { base: { entrance: "fade-up", textReveal: "words" }, mobile: { textReveal: "none" } },
        "field:points": { base: { parallax: "medium" }, mobile: { parallax: "none" } },
        [`field:points/item:${points[0]}`]: { base: { hover: "lift" } },
      },
    );
    const saved = answered(await saveDocument(why, submitted));
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const after = await row(why.id);
    assert.deepEqual(after.draft_motion_config, submitted);
    assert.equal(after.motion_config, null);
    const html = await live("about");
    for (const marker of ["data-m-px", "data-m-hv", "data-m-words", "data-m-w="]) {
      assert.ok(!markup(html).includes(marker), `the live page shows ${marker} before publication`);
    }
  });

  test("words on a picture, Zoom on a heading or a button, a hover on the section: all removed", async () => {
    await reset("about");
    const image = await sectionOf("about", "image-text");
    const saved = answered(
      await saveDocument(
        image,
        doc(
          { base: { entrance: "fade", parallax: "strong", hover: "scale", textReveal: "words" } },
          {
            "field:image": { base: { textReveal: "words", hover: "zoom" } },
            "field:title": { base: { hover: "zoom", textReveal: "words" } },
            "field:ctaLabel": { base: { hover: "zoom", textReveal: "words" } },
          },
        ),
      ),
    );
    assert.equal(saved.ok, true);
    assert.deepEqual(
      (await row(image.id)).draft_motion_config,
      doc(
        { base: { entrance: "fade" } },
        {
          "field:image": { base: { hover: "zoom" } },
          "field:title": { base: { textReveal: "words" } },
          "field:ctaLabel": { base: { textReveal: "words" } },
        },
      ),
    );
  });

  test("an element with its own keyframes takes no drift or words; a backdrop takes no drift or hover", async () => {
    await reset("privacy");
    const hero = await sectionOf("privacy", "page-hero");
    answered(
      await saveDocument(
        hero,
        doc({}, {
          "field:title": { base: { parallax: "subtle", textReveal: "words" } },
          "field:backgroundImage": { base: { parallax: "subtle", hover: "scale", entrance: "fade" } },
        }),
      ),
    );
    assert.deepEqual((await row(hero.id)).draft_motion_config, doc({}, { "field:backgroundImage": { base: { entrance: "fade" } } }));
  });

  test("hostile values never reach the database", async () => {
    await reset("about");
    const text = await sectionOf("about", "rich-text");
    answered(
      await saveDocument(text, {
        v: 1,
        section: {},
        nodes: {
          "field:title": { base: { parallax: "40px", hover: "translateY(-40px)", textReveal: "chars", glow: "strong" } },
          "[data-m-hv]": { base: { parallax: "strong" } },
        },
      }),
    );
    assert.deepEqual((await row(text.id)).draft_motion_config, doc());
  });
});

/* -------------------------------------------------------------------------- */

describe("every control the panel offers does something on the real page", () => {
  for (const slug of ["home", "about"]) {
    test(`/${slug}: each word, hover and parallax control marks its element`, async () => {
      await reset(slug);
      const page = await pageBySlug(slug);
      const sections = await sql<{ id: number; block_type: string }[]>`
        select id, block_type from page_sections where page_id = ${page.id}`;
      const blockOf = new Map(sections.map((section) => [section.id, section.block_type]));
      const before = annotated(await canvas(slug));
      const documents = new Map<number, MotionDocument>();
      let words = 0;
      let hovers = 0;
      let drifts = 0;
      const expectHover: string[] = [];
      const expectDrift: string[] = [];
      for (const address of before.keys()) {
        const [head, ...rest] = address.split("/");
        const id = Number(head!.slice("section:".length));
        if (!rest.length) continue;
        const relative = rest.join("/");
        const capability = motionTargetFor(blockOf.get(id)!, relative);
        if (capability.kind === null) continue;
        const branch: Record<string, string> = {};
        if (capability.fields.includes("textReveal")) branch.textReveal = "words";
        const hover = hoversFor(capability)[1];
        if (hover) branch.hover = hover;
        if (capability.fields.includes("parallax")) branch.parallax = "subtle";
        if (!Object.keys(branch).length) continue;
        const document = documents.get(id) ?? doc();
        document.nodes[relative] = { base: branch as MotionTarget["base"] };
        documents.set(id, document);
        if (branch.textReveal) words += 1;
        if (branch.hover) {
          hovers += 1;
          expectHover.push(address);
        }
        if (branch.parallax) {
          drifts += 1;
          expectDrift.push(address);
        }
      }
      assert.ok(words > 0 && hovers > 0 && drifts > 0, `${words} ${hovers} ${drifts}`);
      for (const [id, document] of documents) {
        await sql`update page_sections set draft_motion_config = ${sql.json(document as never)}, draft_animation = 'fade-up' where id = ${id}`;
      }

      // The editor's canvas: every hover and every drift on the very element the
      // address names. Words are not split there — that is the direct-edit rule.
      const after = annotated(await canvas(slug));
      for (const address of expectHover) assert.match(after.get(address) ?? "", /data-m-hv=""/, `hover on ${address}`);
      for (const address of expectDrift) assert.match(after.get(address) ?? "", /data-m-px=""/, `parallax on ${address}`);
      assert.equal(count(await canvas(slug), "data-m-words"), 0, "the canvas split text somebody may type into");

      // Preview: the words, one split per text that has any.
      const html = await preview(slug);
      assert.equal(count(html, 'data-m-px=""'), drifts);
      assert.equal(count(html, 'data-m-hv=""'), hovers);
      const splittable = [...before.entries()].filter(([address]) => {
        const [head, ...rest] = address.split("/");
        const branch = documents.get(Number(head!.slice(8)))?.nodes[rest.join("/")]?.base;
        return branch?.textReveal === "words";
      });
      assert.equal(count(html, 'data-m-words=""'), splittable.length, "a word control did nothing");
      // The sentence is read once: one accessible copy per split element.
      assert.equal(count(html, "data-m-wa"), splittable.length);
      assert.equal(count(html, 'data-m-wv="" aria-hidden="true"'), splittable.length);
    });
  }

  test("the registry's descriptions match the markup: buttons are .btn, backdrops ignore the pointer, pictures clip", async () => {
    for (const slug of ["home", "about"]) {
      await reset(slug);
      const page = await pageBySlug(slug);
      const sections = await sql<{ id: number; block_type: string }[]>`
        select id, block_type from page_sections where page_id = ${page.id}`;
      const blockOf = new Map(sections.map((section) => [section.id, section.block_type]));
      for (const [address, tag] of annotated(await canvas(slug))) {
        const [head, ...rest] = address.split("/");
        const block = getBlock(blockOf.get(Number(head!.slice(8)))!)!;
        if (rest.length !== 1 || !rest[0]!.startsWith("field:")) continue;
        const field = block.fields.find((entry) => entry.name === rest[0]!.slice(6));
        if (!field) continue;
        const classes = /class="([^"]*)"/.exec(tag)?.[1] ?? "";
        if (field.surface === "button") assert.match(classes, /\bbtn\b/, `${address} is declared a button`);
        if (field.surface === "backdrop") assert.match(classes, /\bpointer-events-none\b/, `${address} is declared a backdrop`);
        if (field.type === "media" && field.surface !== "backdrop") {
          assert.match(classes, /\boverflow-hidden\b/, `${address}: Zoom is offered, so the frame must clip`);
        }
        if (/\bbtn\b/.test(classes)) assert.equal(field.surface, "button", `${address} is a .btn but not declared one`);
      }
    }
  });

  test("the live parallax runtime is paused by the server in the canvas, and live everywhere else", async () => {
    await reset("about");
    const why = await sectionOf("about", "why-us");
    await sql`update page_sections set draft_motion_config = ${sql.json(doc({}, { "field:points": { base: { parallax: "subtle" } } }) as never)},
                                       draft_animation = 'fade-up' where id = ${why.id}`;
    assert.match(await canvas("about"), /\\"parallax\\":\\"paused\\"/);
    assert.match(await preview("about"), /\\"parallax\\":\\"live\\"/);
    assert.ok(!/\\"parallax\\":\\"paused\\"/.test(await preview("about")));
  });
});

/* -------------------------------------------------------------------------- */

describe("public, Preview and editor isolation", () => {
  test("a visitor gets motion attributes and no editor plumbing; Preview likewise; only the canvas is annotated", async () => {
    await reset("about");
    const why = await sectionOf("about", "why-us");
    const points = (why.published.points as { _id: string }[]).map((point) => point._id);
    answered(
      await saveDocument(
        why,
        doc({}, {
          "field:title": { base: { textReveal: "words" } },
          "field:points": { base: { parallax: "subtle" } },
          [`field:points/item:${points[0]}`]: { base: { hover: "scale" } },
        }),
      ),
    );
    assert.equal((await publish("about")).ok, true);
    for (const [name, html] of [
      ["public", await live("about")],
      ["preview", await preview("about")],
    ] as const) {
      const page = markup(html);
      assert.ok(!page.includes("data-eod-"), `${name} carries editor attributes`);
      for (const marker of ['data-m-px=""', 'data-m-hv=""', 'data-m-words=""']) assert.ok(page.includes(marker), `${name} lacks ${marker}`);
      assert.ok(!/motionReplay|editor-bridge|motion-replay/.test(html), `${name} ships the editor's Replay`);
    }
    const annotatedCanvas = markup(await canvas("about"));
    assert.ok(annotatedCanvas.includes("data-eod-address"));
    assert.ok(!annotatedCanvas.includes("data-m-w="), "the canvas split text");
    // The stored sentence is exactly what was there: the split is presentation.
    const stored = (await row(why.id)).published.title;
    const original = (await sql<{ published: Record<string, unknown> }[]>`select published from eodt_sections_backup where id = ${why.id}`)[0]!.published.title;
    assert.deepEqual(stored, original);
  });

  test("a word-split heading keeps its text, whitespace and punctuation for a crawler and a screen reader", async () => {
    await reset("about");
    const text = await sectionOf("about", "rich-text");
    const title = "We make complex journeys — simple, calm (and fast).";
    const content = answered(await saveContent(text, { ...text.published, title: { en: title, ar: "نجعل الرحلات المعقدة بسيطة، وهادئة." } }));
    assert.equal(content.ok, true);
    answered(await saveDocument(await row(text.id), doc({}, { "field:title": { base: { textReveal: "words" } } })));
    const english = markup(await preview("about"));
    assert.ok(english.includes(`<span data-m-wa="">${title.replace(/&/g, "&amp;")}</span>`), "the accessible copy is not the sentence");
    // A dash standing alone is a word of its own: nine.
    assert.equal(wordCount(title), 9);
    assert.ok(wordCount(title) <= WORD_LIMIT);
    const arabic = markup((await get(server.origin, "/ar/about?preview=1", { cookie: owner.cookie })).html);
    assert.ok(arabic.includes('<span data-m-wa="">نجعل الرحلات المعقدة بسيطة، وهادئة.</span>'));
    assert.ok(arabic.includes('<span data-m-w="">بسيطة،</span> <span data-m-w="">وهادئة.</span>'), "Arabic words were reordered or cut");
    // The stored value is the sentence, never markup.
    const stored = (await row(text.id)).draft!.title as { en: string; ar: string };
    assert.equal(stored.en, title);
    assert.ok(!/<span|data-m/.test(JSON.stringify((await row(text.id)).draft)));
  });

  test("the Visual Editor's actions include nothing that could replay, and Replay has no endpoint", () => {
    const actions = readFileSync(path.join(REPO_ROOT, "src", VE_ACTIONS), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    assert.ok(!/replay/i.test(actions), "a Server Action mentions Replay");
    for (const name of [...actions.matchAll(/export async function (\w+)/g)].map((match) => match[1]!)) {
      assert.ok(!/replay|motionPreview|play/i.test(name), name);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("one draft, one publication, one history — nothing new in the storage", () => {
  test("an element-only 15b edit makes the page publishable, counts as motion, and discards completely", async () => {
    await reset("about");
    const image = await sectionOf("about", "image-text");
    const liveBefore = stable(await live("about"));
    answered(await saveDocument(image, doc({}, { "field:image": { base: { hover: "zoom" } } })));
    const summary = await pageView<PageSummaryView>("loadPageSummary", "about");
    assert.equal(summary.motionDrafts, 1, JSON.stringify(summary));
    assert.equal(summary.contentDrafts, 0);
    assert.equal(summary.styleDrafts, 0);
    assert.equal(summary.publishable, true);
    assert.equal((await discardAll("about")).ok, true);
    const cleared = await pageView<PageSummaryView>("loadPageSummary", "about");
    assert.equal(cleared.motionDrafts, 0);
    assert.equal(cleared.publishable, false);
    const after = await row(image.id);
    assert.equal(after.draft_motion_config, null);
    assert.equal(after.draft_animation, null);
    assert.equal(stable(await live("about")), liveBefore, "discard changed the live page");
  });

  test("publication promotes the document in the same act as everything else, and leaves no draft", async () => {
    await reset("about");
    const why = await sectionOf("about", "why-us");
    const document = doc({}, { "field:title": { base: { textReveal: "words", parallax: "strong" } } });
    answered(await saveDocument(why, document));
    const revision = (await row(why.id)).revision;
    assert.equal((await publish("about")).ok, true);
    const after = await row(why.id);
    assert.deepEqual(after.motion_config, document);
    assert.equal(after.draft_motion_config, null);
    assert.equal(after.draft_animation, null);
    // No write after the publication: one bump for the promotion, as for any draft.
    const again = await row(why.id);
    assert.equal(again.revision, after.revision);
    assert.ok(after.revision >= revision);
    assert.ok(markup(await live("about")).includes('data-m-words=""'));
  });

  test("publish A, publish B, restore A: Preview shows A, the site shows B, publishing shows A", async () => {
    await reset("about");
    const why = await sectionOf("about", "why-us");
    const points = (why.published.points as { _id: string }[]).map((point) => point._id);
    const a = doc({}, {
      "field:title": { base: { textReveal: "words" } },
      "field:points": { base: { parallax: "medium" } },
      [`field:points/item:${points[1]}`]: { base: { hover: "lift" } },
    });
    answered(await saveDocument(why, a));
    assert.equal((await publish("about")).ok, true);
    const aHtml = markup(await live("about"));
    for (const marker of ['data-m-words=""', 'data-m-px=""', 'data-m-hv=""']) assert.ok(aHtml.includes(marker), marker);

    const b = doc({}, { "field:title": { base: { entrance: "fade" } } });
    answered(await saveDocument(await row(why.id), b));
    assert.equal((await publish("about")).ok, true);
    const bHtml = stable(await live("about"));
    for (const marker of ['data-m-words=""', 'data-m-px=""', 'data-m-hv=""']) assert.ok(!bHtml.includes(marker), `B still shows ${marker}`);

    const [versionA] = (await pageView<PageHistoryView>("loadPageHistory", "about")).versions;
    assert.equal((await restore("about", versionA!.id)).ok, true);
    assert.deepEqual((await row(why.id)).draft_motion_config, a);
    const previewA = markup(await preview("about"));
    for (const marker of ['data-m-words=""', 'data-m-px=""', 'data-m-hv=""']) assert.ok(previewA.includes(marker), `Preview lacks ${marker}`);
    assert.equal(stable(await live("about")), bHtml, "the restore went live");

    assert.equal((await publish("about")).ok, true);
    assert.deepEqual((await row(why.id)).motion_config, a);
    const final = markup(await live("about"));
    for (const marker of ['data-m-words=""', 'data-m-px=""', 'data-m-hv=""']) assert.ok(final.includes(marker), `public lacks ${marker}`);
  });

  test("a duplicate carries a row's hover to its own row and names none of the source's", async () => {
    await reset("about");
    const page = await pageBySlug("about");
    const source = await sectionOf("about", "why-us");
    const points = (source.published.points as { _id: string }[]).map((point) => point._id);
    answered(
      await saveDocument(
        source,
        doc({}, {
          "field:title": { base: { textReveal: "words" } },
          "field:points": { base: { parallax: "subtle" } },
          [`field:points/item:${points[0]}`]: { base: { hover: "lift" }, mobile: { hover: "none" } },
          [`field:points/item:${points[1]}/field:label`]: { base: { textReveal: "words", parallax: "subtle" } },
        }),
      ),
    );
    const copied = answered(
      await editorAction<{ ok: boolean; sectionId?: number | null }>("duplicatePageSection", pageForm(page, { sectionId: String(source.id) })),
    );
    assert.equal(copied.ok, true);
    const copy = await row(copied.sectionId!);
    const copyPoints = (copy.published.points as { _id: string }[]).map((point) => point._id);
    const stored = copy.motion_config!;
    assert.deepEqual(stored.nodes[`field:points/item:${copyPoints[0]}`], { base: { hover: "lift" }, mobile: { hover: "none" } });
    assert.deepEqual(stored.nodes[`field:points/item:${copyPoints[1]}/field:label`], { base: { textReveal: "words", parallax: "subtle" } });
    for (const id of points) assert.ok(!JSON.stringify(stored).includes(id), `the copy still names ${id}`);
  });
});

/* -------------------------------------------------------------------------- */

describe("one revision, one queue: 15b adds no second sequence", () => {
  test("Word Reveal after a content save names the revision the content produced", async () => {
    await reset("about");
    let text = await sectionOf("about", "rich-text");
    assert.equal(answered(await saveContent(text, { ...text.published })).ok, true);
    const stale = answered(await saveDocument(text, doc({}, { "field:title": { base: { textReveal: "words" } } })));
    assert.equal(!stale.ok && stale.reason, "conflict", "a motion save overwrote a revision it had not seen");
    text = await row(text.id);
    assert.equal(answered(await saveDocument(text, doc({}, { "field:title": { base: { textReveal: "words" } } }))).ok, true);
  });

  test("a hover after a style save, and a second parallax save from the same revision", async () => {
    await reset("about");
    let why = await sectionOf("about", "why-us");
    const points = (why.published.points as { _id: string }[]).map((point) => point._id);
    assert.equal(answered(await saveStyles(why, { v: 1, nodes: { root: { base: { align: "center" } } } })).ok, true);
    why = await row(why.id);
    assert.equal(answered(await saveDocument(why, doc({}, { [`field:points/item:${points[0]}`]: { base: { hover: "scale" } } }))).ok, true);
    // Two saves in flight from one revision: the second one loses, as ever.
    const from = await row(why.id);
    assert.equal(answered(await saveDocument(from, doc({}, { "field:points": { base: { parallax: "subtle" } } }))).ok, true);
    const second = answered(await saveDocument(from, doc({}, { "field:points": { base: { parallax: "strong" } } })));
    assert.equal(!second.ok && second.reason, "conflict");
    assert.deepEqual((await row(why.id)).draft_motion_config, doc({}, { "field:points": { base: { parallax: "subtle" } } }));
  });

  test("an external writer wins, and Reload latest hands back its document, new keys included", async () => {
    await reset("about");
    const why = await sectionOf("about", "why-us");
    const theirs = doc({}, { "field:title": { base: { textReveal: "words" } } });
    await sql`update page_sections set draft_motion_config = ${sql.json(theirs as never)}, draft_animation = 'fade-up',
                                       revision = revision + 1 where id = ${why.id}`;
    const refused = answered(await saveDocument(why, doc({}, { "field:points": { base: { parallax: "strong" } } })));
    assert.equal(!refused.ok && refused.reason, "conflict");
    const latest = answered(await loadSection(why.id, why.page_id));
    assert.equal(latest.ok, true);
    assert.deepEqual(latest.ok && latest.section.motionDocument, theirs);
  });
});

/* -------------------------------------------------------------------------- */

describe("a call to action survives an edit of its section (found in Batch 15b)", () => {
  for (const [slug, blockType] of [
    ["home", "featured-service"],
    ["about", "image-text"],
  ] as const) {
    test(`${blockType}: saving the section's content keeps its button`, async () => {
      await reset(slug);
      const section = await sectionOf(slug, blockType);
      assert.ok(section.published.ctaLabel, "the fixture has no call to action here");
      const saved = answered(await saveContent(section, { ...section.published, title: { en: "Edited", ar: "معدل" } }));
      assert.equal(saved.ok, true);
      const draft = (await row(section.id)).draft!;
      assert.deepEqual(draft.ctaLabel, section.published.ctaLabel, "the button text was dropped on save");
      assert.equal(draft.ctaHref, section.published.ctaHref, "the button link was dropped on save");
      assert.ok(!("CtaLabel" in draft) && !("CtaHref" in draft));
    });
  }
});
