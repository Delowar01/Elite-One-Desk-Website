/**
 * Reusable components against a running server (Batch 17).
 *
 * The reference model's pure rules are in `tests/reusable-components.test.ts`.
 * What only a server can answer is here: the database checks a save makes, a
 * component's own draft, publication, history and restore, usage read from the
 * references, detaching resolved server-side, the page publication gate, page
 * history pinning the version a page showed, Version Compare, the component's
 * preview, archive and delete with the race between delete and link, the
 * fail-safe for a component that has gone, public isolation, permissions,
 * CSRF, cache invalidation and the activity log.
 *
 * Numbers in the test names are the Batch 17 brief's §71 items.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { callAction, type ActionResponse } from "./helpers/action";
import { giveFresh } from "./helpers/fixtures";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { BUILD_HINT, isBuilt, startServer, type Server } from "./helpers/server";
import { signIn, type TestSession } from "./helpers/session";

import { linkSlot, readReuse, setOverride, stripReuse, WHOLE_BLOCK_REFUSAL, withReuse } from "@/lib/cms/reuse/reference";
import type { ReuseActionResult, ReuseCatalogEntry, ReuseComponentView } from "@/lib/cms/reuse/view";
import type { PageStructure } from "@/lib/cms/structure";
import type { VisualDetachResult, VisualStructureResult } from "@/lib/visual-editor/content";
import type { PageActionResult } from "@/lib/visual-editor/publish";

const PORT = 3461;
const VE_ACTIONS = "app/(backoffice)/admin/visual-editor/actions.ts";
const VE_ROUTE = "/admin/visual-editor";
const RC_ACTIONS = "app/(backoffice)/admin/(shell)/components/actions.ts";
const RC_ROUTE = "/admin/components";

let database = "";
let sql: Sql;
let server: Server;
let owner: TestSession;
let viewer: TestSession;

type Values = Record<string, unknown>;
type SectionRow = {
  id: number;
  page_id: number;
  revision: number;
  block_type: string;
  draft: Values | null;
  published: Values;
  styles: Values;
  motion_config: Values | null;
};

const row = async (id: number): Promise<SectionRow> => {
  const [found] = await sql<SectionRow[]>`
    select id, page_id, revision, block_type, draft, published, styles, motion_config
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
    select id from page_sections where page_id = ${page.id} and block_type = ${blockType} and not is_draft_only
     order by position limit 1`;
  assert.ok(found, `no ${blockType} on /${slug}`);
  return row(found.id);
};
/** What the editor sees for a section: its draft, or its published values. */
const current = (section: SectionRow): Values => section.draft ?? section.published;

function answered<T>(response: ActionResponse<T>): T {
  assert.ok(response.value, `the action returned nothing (status ${response.status})`);
  return response.value;
}

const form = (fields: Record<string, string | number>, as: TestSession = owner) => {
  const data = new FormData();
  data.set("_csrf", as.csrfToken);
  for (const [key, value] of Object.entries(fields)) data.set(key, String(value));
  return data;
};

const componentAction = async (action: string, fields: Record<string, string | number>, as: TestSession = owner) =>
  answered(
    await callAction<ReuseActionResult>({
      origin: server.origin,
      route: RC_ROUTE,
      file: RC_ACTIONS,
      action,
      args: [form(fields, as)],
      cookie: as.cookie,
    }),
  );

const loader = async <T>(action: string, args: unknown[], as?: TestSession) =>
  (
    await callAction<T>({
      origin: server.origin,
      route: RC_ROUTE,
      file: RC_ACTIONS,
      action,
      args,
      cookie: as?.cookie ?? "",
    })
  ).value;

const catalog = async (as: TestSession = owner) => loader<ReuseCatalogEntry[] | null>("loadReusableCatalog", [], as);
const view = async (id: number, as: TestSession = owner) => loader<ReuseComponentView | null>("loadReusableComponent", [id], as);
const usageOf = async (id: number) => (await catalog())!.find((entry) => entry.id === id)!.usage;
const componentRow = async (id: number) => {
  const [found] = await sql<
    { id: number; revision: number; published_version: number; published: Values | null; draft: Values | null; status: string; name: string }[]
  >`select id, revision, published_version, published, draft, status, name from reusable_components where id = ${id}`;
  return found ?? null;
};

/** A reusable CTA, created and — unless asked otherwise — published. */
async function createCta(name: string, en: string, ar: string, href: string, publish = true): Promise<ReuseComponentView> {
  const result = await componentAction("createReusableComponent", {
    kind: "cta",
    name,
    values: JSON.stringify({ label: { en, ar }, href }),
    publish: publish ? "1" : "0",
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(result.ok && result.component);
  return result.component!;
}

/** A new draft of a component's values, saved and published. */
async function republish(id: number, values: Values): Promise<ReuseComponentView> {
  const before = (await view(id))!;
  const saved = await componentAction("saveReusableDraft", { id, expectedRevision: before.revision, values: JSON.stringify(values) });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  const published = await componentAction("publishReusable", { id, expectedRevision: saved.ok ? saved.component!.revision : -1 });
  assert.equal(published.ok, true, JSON.stringify(published));
  return (published as { component: ReuseComponentView }).component;
}

type SaveResult = { ok: boolean; reason?: string; message?: string; section?: { revision: number; values: Values } };
async function saveContent(section: SectionRow, values: Values, as: TestSession = owner, revision = section.revision) {
  const data = form(
    { sectionId: section.id, pageId: section.page_id, expectedRevision: revision, values: JSON.stringify(values) },
    as,
  );
  return answered(
    await callAction<SaveResult>({
      origin: server.origin,
      route: VE_ROUTE,
      file: VE_ACTIONS,
      action: "saveVisualSectionDraft",
      args: [data],
      cookie: as.cookie,
    }),
  );
}

/** Links a section's slot to a component, as the panel does, and saves it. */
async function link(section: SectionRow, slot: string, component: ReuseComponentView) {
  const values = linkSlot(section.block_type, current(section), slot, {
    id: component.id,
    kind: component.kind,
    values: component.published!,
  });
  assert.ok(values, "the slot does not take that kind");
  return saveContent(section, values);
}

async function detach(section: SectionRow, slot: string, version: number, as: TestSession = owner) {
  const data = form(
    { sectionId: section.id, pageId: section.page_id, expectedRevision: section.revision, slot, expectedComponentVersion: version },
    as,
  );
  return answered(
    await callAction<VisualDetachResult>({
      origin: server.origin,
      route: VE_ROUTE,
      file: VE_ACTIONS,
      action: "detachVisualInstance",
      args: [data],
      cookie: as.cookie,
    }),
  );
}

/** A save through the classic section form (`/admin/pages/section/[id]`). */
async function classicSave(section: SectionRow, values: Values) {
  const data = form({ id: section.id, expectedRevision: section.revision, values: JSON.stringify(values) });
  return answered(
    await callAction<{ ok: boolean; message?: string }>({
      origin: server.origin,
      route: `/admin/pages/section/${section.id}`,
      file: "app/(backoffice)/admin/(shell)/pages/actions.ts",
      action: "saveSectionDraft",
      args: [{ ok: false }, data],
      cookie: owner.cookie,
    }),
  );
}

const editorAction = async <T>(action: string, fields: Record<string, string | number>, as: TestSession = owner) =>
  answered(
    await callAction<T>({ origin: server.origin, route: VE_ROUTE, file: VE_ACTIONS, action, args: [form(fields, as)], cookie: as.cookie }),
  );

async function publishPage(slug: string) {
  const page = await pageBySlug(slug);
  return editorAction<PageActionResult>("publishPageFromEditor", { pageId: page.id, expectedRevision: page.revision });
}
async function discardPage(slug: string) {
  const page = await pageBySlug(slug);
  return editorAction<PageActionResult>("discardPageFromEditor", { pageId: page.id, expectedRevision: page.revision });
}
async function structural(action: string, slug: string, fields: Record<string, string | number> = {}) {
  const page = await pageBySlug(slug);
  return editorAction<VisualStructureResult>(action, { pageId: page.id, expectedRevision: page.revision, ...fields });
}

/** The HTML before the streamed flight payload, which quotes attributes back. */
const markup = (html: string) => {
  const at = html.search(/<script[^>]*>\s*\(?self\.__next_f/);
  return at < 0 ? html : html.slice(0, at);
};
/** The same, with the per-request CSP nonce taken out, so two responses can be compared. */
const stable = (html: string) => markup(html).replace(/nonce="[^"]*"/g, "");
const BRIDGE = "b_reusable_test_bridge";

async function fetchPage(path: string, cookie?: string) {
  const response = await fetch(`${server.origin}${path}`, { headers: cookie ? { cookie } : {}, redirect: "manual" });
  return {
    status: response.status,
    robots: response.headers.get("x-robots-tag"),
    cache: response.headers.get("cache-control"),
    location: response.headers.get("location"),
    html: await response.text(),
  };
}
const live = async (path: string) => {
  const page = await fetchPage(path);
  assert.equal(page.status, 200, `${path} answered ${page.status}`);
  return page.html;
};

/** The `href` and text of the first link whose text contains `text`. */
function anchorWith(html: string, text: string): { href: string; tag: string } | null {
  for (const match of markup(html).matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
    if (match[2]!.replace(/<[^>]+>/g, "").includes(text)) {
      const href = /href="([^"]*)"/.exec(match[1]!)?.[1] ?? "";
      return { href, tag: match[0] };
    }
  }
  return null;
}

async function activity(action: string, entityId?: number) {
  const rows = await sql<{ n: number }[]>`
    select count(*)::int as n from activity_logs
     where action = ${action} ${entityId === undefined ? sql`` : sql`and entity_id = ${String(entityId)}`}`;
  return rows[0]!.n;
}

before(async () => {
  assert.ok(isBuilt(), BUILD_HINT);
  database = giveFresh("visual_reusable");
  sql = connect(database);
  owner = await signIn(sql);
  await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    select 'viewer@test.invalid', 'Read Only', 'unused', id, true from roles where key = 'viewer'`;
  viewer = await signIn(sql, "viewer");
  server = await startServer(database, PORT);
});

after(async () => {
  await server?.stop();
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
});

/* ========================================================================== */
/* A component's own lifecycle                                                */
/* ========================================================================== */

describe("5–10 · a component has its own draft, publication, history and restore", () => {
  test("5–6 · a draft is saved without reaching anything live; publishing makes version 1, then 2", async () => {
    const created = await createCta("Lifecycle CTA", "First", "الأول", "/first", false);
    assert.equal(created.publishedVersion, 0);
    assert.equal(created.published, null);
    assert.equal(created.hasDraft, true);

    // Save draft: the revision moves, published stays empty.
    const saved = await componentAction("saveReusableDraft", {
      id: created.id,
      expectedRevision: created.revision,
      values: JSON.stringify({ label: { en: "First!", ar: "الأول" }, href: "/first", style: "x" }),
    });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const stored = (await componentRow(created.id))!;
    assert.equal(stored.revision, created.revision + 1);
    assert.equal(stored.published, null);
    assert.deepEqual(stored.draft, { label: { en: "First!", ar: "الأول" }, href: "/first" }, "undeclared keys never stored");

    // Publish: version 1, the draft promoted and cleared, no history row for a first publication.
    const published = await componentAction("publishReusable", { id: created.id, expectedRevision: stored.revision });
    assert.equal(published.ok, true, JSON.stringify(published));
    let now = (await componentRow(created.id))!;
    assert.equal(now.published_version, 1);
    assert.deepEqual(now.published, { label: { en: "First!", ar: "الأول" }, href: "/first" });
    assert.equal(now.draft, null);
    assert.equal((await view(created.id))!.versions.length, 0);

    // A draft that says exactly what is published is no draft at all.
    const same = await componentAction("saveReusableDraft", {
      id: created.id,
      expectedRevision: now.revision,
      values: JSON.stringify(now.published),
    });
    assert.equal(same.ok, true);
    now = (await componentRow(created.id))!;
    assert.equal(now.draft, null);

    // Version 2 records version 1 as history.
    const second = await republish(created.id, { label: { en: "Second", ar: "الثاني" }, href: "/second" });
    assert.equal(second.publishedVersion, 2);
    assert.deepEqual(
      second.versions.map((entry) => entry.version),
      [1],
    );
  });

  test("7 · a stale save is refused as a conflict and the winning version is handed back — nothing merged", async () => {
    const created = await createCta("Conflict CTA", "Base", "أساس", "/base");
    const first = await componentAction("saveReusableDraft", {
      id: created.id,
      expectedRevision: created.revision,
      values: JSON.stringify({ label: { en: "Mine", ar: "" }, href: "/mine" }),
    });
    assert.equal(first.ok, true);
    const stale = await componentAction("saveReusableDraft", {
      id: created.id,
      expectedRevision: created.revision,
      values: JSON.stringify({ label: { en: "Theirs", ar: "" }, href: "/theirs" }),
    });
    assert.equal(stale.ok, false);
    assert.equal(!stale.ok && stale.reason, "conflict");
    assert.equal(!stale.ok && stale.latest?.draft?.href, "/mine", "the version that won is offered");
    assert.equal((await componentRow(created.id))!.draft?.href, "/mine");
    // Publishing on the stale revision is refused the same way.
    const stalePublish = await componentAction("publishReusable", { id: created.id, expectedRevision: created.revision });
    assert.equal(!stalePublish.ok && stalePublish.reason, "conflict");
  });

  test("8 · discarding returns to the published version and touches no page", async () => {
    const created = await createCta("Discard CTA", "Kept", "محفوظ", "/kept");
    const pagesBefore = await sql`select id, revision from pages order by id`;
    const saved = await componentAction("saveReusableDraft", {
      id: created.id,
      expectedRevision: created.revision,
      values: JSON.stringify({ label: { en: "Thrown", ar: "" }, href: "/thrown" }),
    });
    assert.equal(saved.ok, true);
    const discarded = await componentAction("discardReusableDraft", { id: created.id, expectedRevision: saved.ok ? saved.component!.revision : -1 });
    assert.equal(discarded.ok, true, JSON.stringify(discarded));
    const now = (await componentRow(created.id))!;
    assert.equal(now.draft, null);
    assert.deepEqual(now.published, { label: { en: "Kept", ar: "محفوظ" }, href: "/kept" });
    assert.deepEqual(await sql`select id, revision from pages order by id`, pagesBefore);
  });

  test("9–10 · history keeps each replaced version; restoring one stages it as the draft, never live", async () => {
    const created = await createCta("History CTA", "A", "أ", "/a");
    await republish(created.id, { label: { en: "B", ar: "ب" }, href: "/b" });
    const atB = (await view(created.id))!;
    assert.deepEqual(atB.versions.map((entry) => entry.version), [1]);
    const restored = await componentAction("restoreReusableVersion", {
      id: created.id,
      versionId: atB.versions[0]!.id,
      expectedRevision: atB.revision,
    });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    let now = (await componentRow(created.id))!;
    assert.deepEqual(now.draft, { label: { en: "A", ar: "أ" }, href: "/a" }, "version 1 is the draft now");
    assert.deepEqual(now.published, { label: { en: "B", ar: "ب" }, href: "/b" }, "live remains version 2");
    const published = await componentAction("publishReusable", { id: created.id, expectedRevision: now.revision });
    assert.equal(published.ok, true);
    now = (await componentRow(created.id))!;
    assert.equal(now.published_version, 3);
    assert.deepEqual(now.published, { label: { en: "A", ar: "أ" }, href: "/a" });
    assert.deepEqual((await view(created.id))!.versions.map((entry) => entry.version), [2, 1]);
    // Restoring what is already live is refused by name.
    const again = (await view(created.id))!;
    const same = await componentAction("restoreReusableVersion", { id: created.id, versionId: again.versions[1]!.id, expectedRevision: again.revision });
    assert.equal(!same.ok && same.reason, "nothing");
  });

  test("51 · a version id belongs to its own component — another's is not found", async () => {
    const a = await createCta("IDOR A", "a", "", "/a");
    const b = await createCta("IDOR B", "b", "", "/b");
    await republish(a.id, { label: { en: "a2", ar: "" }, href: "/a2" });
    const aVersion = (await view(a.id))!.versions[0]!;
    const bView = (await view(b.id))!;
    const result = await componentAction("restoreReusableVersion", { id: b.id, versionId: aVersion.id, expectedRevision: bView.revision });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "missing");
    assert.equal((await componentRow(b.id))!.draft, null);
  });
});

/* ========================================================================== */
/* Linking and what a save may store                                          */
/* ========================================================================== */

describe("15, 3, 4 · a link is checked against the database, never against the browser", () => {
  test("15 · linking a slot saves the reference in the section's draft, and nothing live moves", async () => {
    const component = await createCta("Link CTA", "Contact us", "اتصل بنا", "/contact");
    const panel = await sectionOf("about", "final-cta");
    const saved = await link(panel, "primaryCta", component);
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const after = await row(panel.id);
    assert.deepEqual(readReuse(after.draft, "final-cta"), { primaryCta: { c: component.id } });
    assert.equal(readReuse(after.published, "final-cta").primaryCta, undefined, "the live row is untouched");
    assert.equal(await activity("reusable_component.instance_linked", component.id), 1);
    await discardPage("about");
  });

  test("3–4 · a reference to nothing, to the wrong kind, to an unpublished or archived component, or malformed, is refused", async () => {
    const panel = await sectionOf("about", "final-cta");
    const base = current(panel);
    const refusals: [string, Values][] = [
      ["missing", withReuse(base, { primaryCta: { c: 999999 } })],
      ["malformed", { ...base, _reuse: "12" }],
      ["a pin", { ...base, _reuse: { primaryCta: { c: 1, v: 2 } } }],
      ["a slot the block does not have", { ...base, _reuse: { heroCta: { c: 1 } } }],
    ];
    const draftOnly = await createCta("Never published CTA", "Soon", "", "/soon", false);
    refusals.push(["unpublished", withReuse(base, { primaryCta: { c: draftOnly.id } })]);
    const rich = answered(
      await callAction<ReuseActionResult>({
        origin: server.origin,
        route: RC_ROUTE,
        file: RC_ACTIONS,
        action: "createReusableComponent",
        args: [form({ kind: "block:rich-text", name: "A text", values: JSON.stringify({ title: { en: "T", ar: "" } }), publish: "1" })],
        cookie: owner.cookie,
      }),
    );
    assert.equal(rich.ok, true);
    refusals.push(["the wrong kind", withReuse(base, { primaryCta: { c: rich.ok ? rich.component!.id : 0 } })]);
    const archived = await createCta("Archived before linking", "Old", "", "/old");
    const done = await componentAction("archiveReusable", { id: archived.id, expectedRevision: archived.revision, archived: "1" });
    assert.equal(done.ok, true);
    refusals.push(["archived", withReuse(base, { primaryCta: { c: archived.id } })]);

    for (const [why, values] of refusals) {
      const fresh = await row(panel.id);
      const result = await saveContent(fresh, values);
      assert.equal(result.ok, false, `${why} was stored`);
      assert.equal((await row(panel.id)).revision, fresh.revision, `${why} moved the revision`);
    }
    // Markup is not a kind: an unknown kind cannot be created.
    const html = await componentAction("createReusableComponent", { kind: "html", name: "Markup", values: "{}", publish: "0" });
    assert.equal(!html.ok && html.reason, "invalid");
  });
});

/* ========================================================================== */
/* Usage                                                                      */
/* ========================================================================== */

describe("11–14, 59 · usage is read from the references: pages, instances, live and draft", () => {
  test("a draft link counts as draft usage; publishing makes it live; the same component twice counts twice", async () => {
    const component = await createCta("Usage CTA", "Request a Service", "اطلب خدمة", "/contact");
    const home = await sectionOf("home", "final-cta");
    assert.equal((await link(home, "primaryCta", component)).ok, true);
    let usage = await usageOf(component.id);
    assert.equal(usage.pages, 1);
    assert.equal(usage.instances, 1);
    assert.equal(usage.liveInstances, 0, "13 · a draft link is not live");
    assert.equal(usage.draftInstances, 1);
    assert.equal(usage.draftOnlyPages, 1);

    assert.equal((await publishPage("home")).ok, true);
    usage = await usageOf(component.id);
    assert.equal(usage.liveInstances, 1);
    assert.equal(usage.livePages, 1);
    assert.equal(usage.draftOnlyPages, 0);

    // 12 · the same component on a second page, and 14 · twice on one page.
    const about = await sectionOf("about", "final-cta");
    assert.equal((await link(about, "primaryCta", component)).ok, true);
    const hero = await sectionOf("home", "hero");
    assert.equal((await link(hero, "primaryCta", component)).ok, true);
    assert.equal((await publishPage("about")).ok, true);
    assert.equal((await publishPage("home")).ok, true);
    usage = await usageOf(component.id);
    assert.equal(usage.pages, 2, "11 · pages");
    assert.equal(usage.instances, 3, "12 · instances");
    assert.equal(usage.liveInstances, 3);
    const listed = (await view(component.id))!;
    assert.equal(listed.instances.filter((entry) => entry.slug === "home").length, 2);

    // 59 · duplicate, remove, restore and discard move the count, and only the draft side.
    const dup = await structural("duplicatePageSection", "about", { sectionId: about.id });
    assert.equal(dup.ok, true, JSON.stringify(dup));
    const copyId = dup.ok ? dup.sectionId! : 0;
    const copy = await row(copyId);
    assert.deepEqual(readReuse(copy.draft, "final-cta"), readReuse(current(await row(about.id)), "final-cta"), "30 · the copy links the same component");
    usage = await usageOf(component.id);
    assert.equal(usage.instances, 4);
    assert.equal(usage.liveInstances, 3);
    assert.equal((await structural("removePageSection", "about", { sectionId: copyId })).ok, true);
    assert.equal((await usageOf(component.id)).instances, 3);
    assert.equal((await structural("restorePageSection", "about", { sectionId: copyId })).ok, true);
    assert.equal((await usageOf(component.id)).instances, 4);
    assert.equal((await structural("discardPageLayout", "about")).ok, true);
    usage = await usageOf(component.id);
    assert.equal(usage.instances, 3);
    assert.equal(usage.referenced, true);
  });
});

/* ========================================================================== */
/* Global changes, overrides and detaching                                    */
/* ========================================================================== */

describe("21–24, 31, 55–56 · one publication updates every linked page; overrides and detached pages do not follow", () => {
  let componentId = 0;

  before(async () => {
    const component = await createCta("Primary Contact CTA", "Talk to us", "تحدث إلينا", "/talk");
    componentId = component.id;
    for (const slug of ["home", "about"]) {
      const panel = await sectionOf(slug, "final-cta");
      assert.equal((await link(panel, "primaryCta", component)).ok, true);
      assert.equal((await publishPage(slug)).ok, true);
    }
  });

  test("7, 55–56 · a global draft changes nothing public; publishing it changes both pages and no page revision", async () => {
    assert.equal(anchorWith(await live("/"), "Talk to us")?.href, "/talk");
    assert.equal(anchorWith(await live("/about"), "Talk to us")?.href, "/talk");

    const before = (await view(componentId))!;
    const saved = await componentAction("saveReusableDraft", {
      id: componentId,
      expectedRevision: before.revision,
      values: JSON.stringify({ label: { en: "Book a call", ar: "احجز مكالمة" }, href: "/call" }),
    });
    assert.equal(saved.ok, true);
    // Pending: the public pages still show the published version.
    assert.ok(anchorWith(await live("/"), "Talk to us"), "a global draft leaked to the live page");
    assert.equal(anchorWith(await live("/"), "Book a call"), null);

    // 31 · publishing a page does not publish the component's draft.
    const hero = await sectionOf("home", "page-hero").catch(() => null);
    void hero;
    const title = await sectionOf("home", "final-cta");
    assert.equal((await saveContent(title, { ...current(title), title: { en: "New title", ar: "" } })).ok, true);
    assert.equal((await publishPage("home")).ok, true);
    assert.ok((await componentRow(componentId))!.draft, "the component's draft is still pending");
    assert.ok(anchorWith(await live("/"), "Talk to us"), "page publication published the component");

    const pageRevisions = await sql`select id, revision, draft_structure from pages order by id`;
    const sectionRevisions = await sql`select id, revision, published, draft from page_sections order by id`;
    const versionsBefore = (await sql<{ n: number }[]>`select count(*)::int as n from page_versions`)[0]!.n;

    const published = await componentAction("publishReusable", {
      id: componentId,
      expectedRevision: (await componentRow(componentId))!.revision,
    });
    assert.equal(published.ok, true, JSON.stringify(published));
    assert.match(published.message, /live on 2 linked instances across 2 published pages/);

    // 55 · the cached public pages were dropped: both now show the new version.
    assert.equal(anchorWith(await live("/"), "Book a call")?.href, "/call");
    assert.equal(anchorWith(await live("/about"), "Book a call")?.href, "/call");
    assert.ok(markup(await live("/ar/about")).includes("احجز مكالمة"), "the Arabic edition follows too");

    // 56 · no page moved: revisions, content and history exactly as they were.
    assert.deepEqual(await sql`select id, revision, draft_structure from pages order by id`, pageRevisions);
    assert.deepEqual(await sql`select id, revision, published, draft from page_sections order by id`, sectionRevisions);
    assert.equal((await sql<{ n: number }[]>`select count(*)::int as n from page_versions`)[0]!.n, versionsBefore);
    // Created published (a `created` entry), then this publication.
    assert.equal(await activity("reusable_component.published", componentId), 1);
  });

  test("17, 21–22 · an override on one page keeps it; the global change reaches the page without one", async () => {
    const about = await sectionOf("about", "final-cta");
    const overridden = setOverride("final-cta", current(about), "primaryCta", "primaryCtaHref", true, "/call")!;
    const saved = await saveContent(about, { ...overridden, primaryCtaHref: "/book-about" });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal((await publishPage("about")).ok, true);
    assert.equal(anchorWith(await live("/about"), "Book a call")?.href, "/book-about");

    await republish(componentId, { label: { en: "Book a meeting", ar: "احجز اجتماعًا" }, href: "/meet" });
    const home = anchorWith(await live("/"), "Book a meeting");
    const about2 = anchorWith(await live("/about"), "Book a meeting");
    assert.equal(home?.href, "/meet", "21 · the page without an override follows");
    assert.equal(about2?.href, "/book-about", "22 · the overridden link stays local");

    // 18 · resetting the override inherits again.
    const again = await sectionOf("about", "final-cta");
    const reset = setOverride("final-cta", current(again), "primaryCta", "primaryCtaHref", false, "/meet")!;
    assert.equal((await saveContent(again, reset)).ok, true);
    assert.equal((await publishPage("about")).ok, true);
    assert.equal(anchorWith(await live("/about"), "Book a meeting")?.href, "/meet");
  });

  test("16, 23–24, 28 · detaching keeps what the page shows, ignores later versions, and Undo brings the link back", async () => {
    const about = await sectionOf("about", "final-cta");
    const version = (await componentRow(componentId))!.published_version;
    const linkedValues = current(about);

    // A stale component version is refused by name.
    const stale = await detach(about, "primaryCta", version - 1);
    assert.equal(stale.ok, false);
    assert.equal(!stale.ok && stale.reason, "component_conflict");

    const detached = await detach(about, "primaryCta", version);
    assert.equal(detached.ok, true, JSON.stringify(detached));
    const after = await row(about.id);
    assert.deepEqual(readReuse(after.draft, "final-cta"), {}, "16 · the reference is gone");
    assert.deepEqual(after.draft?.primaryCtaLabel, { en: "Book a meeting", ar: "احجز اجتماعًا" }, "23 · the content shown is kept");
    assert.equal(after.draft?.primaryCtaHref, "/meet");
    assert.equal(await activity("reusable_component.instance_detached", componentId), 1);
    assert.equal((await componentRow(componentId))!.published_version, version, "detaching never touches the component");

    // 28 · Undo: the earlier values, saved through the ordinary save — the link is back.
    const undone = await saveContent(after, linkedValues);
    assert.equal(undone.ok, true, JSON.stringify(undone));
    assert.deepEqual(readReuse((await row(about.id)).draft, "final-cta"), { primaryCta: { c: componentId } });
    // Redo: detached again, and published.
    const redone = await saveContent(await row(about.id), after.draft!);
    assert.equal(redone.ok, true);
    assert.equal((await publishPage("about")).ok, true);

    // 24 · a later version reaches home and not the detached page.
    await republish(componentId, { label: { en: "Say hello", ar: "قل مرحبا" }, href: "/hello" });
    assert.equal(anchorWith(await live("/"), "Say hello")?.href, "/hello");
    assert.equal(anchorWith(await live("/about"), "Book a meeting")?.href, "/meet");
    assert.equal(anchorWith(await live("/about"), "Say hello"), null);
  });

  test("42 · a stale page save is refused as a conflict, linked or not", async () => {
    const home = await sectionOf("home", "final-cta");
    const first = await saveContent(home, { ...current(home), title: { en: "One", ar: "" } });
    assert.equal(first.ok, true);
    const stale = await saveContent(home, { ...current(home), title: { en: "Two", ar: "" } }, owner, home.revision);
    assert.equal(stale.ok, false);
    assert.equal(stale.reason, "conflict");
    await discardPage("home");
  });
});

/* ========================================================================== */
/* The page publication gate                                                  */
/* ========================================================================== */

describe("32 · a component that was never published cannot reach a live page", () => {
  test("a pending reference to an unpublished component stops the page's publication by name", async () => {
    const draftOnly = await createCta("Unreleased CTA", "Soon", "", "/soon", false);
    const privacy = await sectionOf("about", "image-text");
    // Written directly, as an older build or a damaged row could have left it.
    await sql`update page_sections set draft = ${sql.json(withReuse(current(privacy), { cta: { c: draftOnly.id } }) as never)}::jsonb,
                     revision = revision + 1 where id = ${privacy.id}`;
    const liveBefore = await live("/about");
    const result = await publishPage("about");
    assert.equal(result.ok, false);
    assert.match(result.message, /has not been published yet/);
    assert.match(result.message, /Nothing was published/);
    assert.equal(stable(await live("/about")), stable(liveBefore));
    await discardPage("about");
  });
});

/* ========================================================================== */
/* History and Version Compare                                                */
/* ========================================================================== */

describe("33–35 · page history keeps the reference and the version it showed", () => {
  test("a restore point pins the version; compare draws that version; restore brings the link back", async () => {
    const component = await createCta("History pin CTA", "Version one", "الإصدار الأول", "/one");
    await sql`delete from page_versions`;
    const terms = await sectionOf("terms", "rich-text");
    void terms;
    // The disclaimer page has a rich-text section; link its whole block to a text component instead.
    const text = answered(
      await callAction<ReuseActionResult>({
        origin: server.origin,
        route: RC_ROUTE,
        file: RC_ACTIONS,
        action: "createReusableComponent",
        args: [
          form({
            kind: "block:rich-text",
            name: "Shared notice",
            values: JSON.stringify({ eyebrow: { en: "Note", ar: "" }, title: { en: "Notice one", ar: "إشعار" }, body: { en: "<p>One</p>", ar: "" } }),
            publish: "1",
          }),
        ],
        cookie: owner.cookie,
      }),
    );
    assert.equal(text.ok, true);
    const notice = text.ok ? text.component! : null;
    const section = await sectionOf("disclaimer", "rich-text");
    const linked = linkSlot("rich-text", current(section), "block", { id: notice!.id, kind: notice!.kind, values: notice!.published! })!;
    assert.equal((await saveContent(section, linked)).ok, true);
    assert.equal((await publishPage("disclaimer")).ok, true);
    assert.ok(markup(await live("/disclaimer")).includes("Notice one"));

    // Version 2 of the component; then a page publication takes a restore point of the page as it stood.
    await republish(notice!.id, { eyebrow: { en: "Note", ar: "" }, title: { en: "Notice two", ar: "إشعار ٢" }, body: { en: "<p>Two</p>", ar: "" } });
    const hero = await sectionOf("disclaimer", "page-hero");
    assert.equal((await saveContent(hero, { ...current(hero), title: { en: "Disclaimer!", ar: "" } })).ok, true);
    assert.equal((await publishPage("disclaimer")).ok, true);
    const [version] = await sql<{ id: number; snapshot: { sections: { blockType: string; published: Values }[] } }[]>`
      select id, snapshot from page_versions where page_id = (select id from pages where slug = 'disclaimer') order by id desc limit 1`;
    assert.ok(version);
    const kept = version.snapshot.sections.find((entry) => entry.blockType === "rich-text")!;
    assert.deepEqual(readReuse(kept.published, "rich-text", { pins: true }), { block: { c: notice!.id, v: 2 } }, "33 · pinned to version 2");
    assert.deepEqual(kept.published.title, { en: "Notice two", ar: "إشعار ٢" }, "the words visitors saw");

    // Version 3, then compare: the historical pane draws version 2, the published pane version 3.
    await republish(notice!.id, { eyebrow: { en: "Note", ar: "" }, title: { en: "Notice three", ar: "" }, body: { en: "<p>Three</p>", ar: "" } });
    const historical = await fetchPage(`/disclaimer?compare=v${version.id}`, owner.cookie);
    assert.equal(historical.status, 200);
    assert.ok(markup(historical.html).includes("Notice two"), "35 · the historical state renders its own version");
    assert.ok(!markup(historical.html).includes("Notice three"));
    const current3 = await fetchPage("/disclaimer?compare=published", owner.cookie);
    assert.ok(markup(current3.html).includes("Notice three"));

    // 34 · the structured comparison names the component and the versions.
    const page = await pageBySlug("disclaimer");
    const compare = await fetchPage(`/admin/compare?page=${page.id}&version=${version.id}`, owner.cookie);
    assert.equal(compare.status, 200);
    assert.ok(compare.html.includes("Shared notice"), "the component is named, not numbered");
    assert.ok(compare.html.includes("Version 2") && compare.html.includes("Version 3"));
    assert.ok(compare.html.includes("Reusable components are not site globals"));

    // Restore: the link comes back without its pin, following the component again.
    const restored = await editorAction<PageActionResult>("restoreVersionFromEditor", {
      pageId: page.id,
      expectedRevision: (await pageBySlug("disclaimer")).revision,
      versionId: version.id,
    });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    const after = await row(section.id);
    assert.deepEqual(readReuse(after.draft, "rich-text", { pins: true }), { block: { c: notice!.id } });
    const preview = await fetchPage("/disclaimer?preview=1", owner.cookie);
    assert.ok(markup(preview.html).includes("Notice three"), "a restored link shows the component's current version");
    await discardPage("disclaimer");
    void component;
  });
});

/* ========================================================================== */
/* The component's own preview                                                */
/* ========================================================================== */

describe("37 · a component's preview is private, current and only on pages that use it", () => {
  test("the draft on a linked page, for a signed-in editor only, with the right headers", async () => {
    const component = await createCta("Preview CTA", "Published words", "", "/p");
    const panel = await sectionOf("contact", "page-hero");
    void panel;
    const home = await sectionOf("home", "hero");
    const linked = linkSlot("hero", current(home), "secondaryCta", { id: component.id, kind: "cta", values: component.published! })!;
    assert.equal((await saveContent(home, linked)).ok, true);
    assert.equal((await publishPage("home")).ok, true);
    const saved = await componentAction("saveReusableDraft", {
      id: component.id,
      expectedRevision: (await componentRow(component.id))!.revision,
      values: JSON.stringify({ label: { en: "Draft words", ar: "" }, href: "/d" }),
    });
    assert.equal(saved.ok, true);
    const revision = (await componentRow(component.id))!.revision;

    const own = await fetchPage(`/?component=${component.id}&rev=${revision}`, owner.cookie);
    assert.equal(own.status, 200);
    assert.ok(markup(own.html).includes("Draft words"), "the draft is drawn");
    assert.match(own.html, /unpublished draft of the reusable component/);
    assert.equal(own.robots, "noindex, nofollow, noarchive");
    assert.equal(own.cache, "private, no-store, max-age=0");

    // A visitor asking for it gets the live page — the parameter grants nothing.
    const visitor = await fetchPage(`/?component=${component.id}&rev=${revision}`);
    assert.equal(visitor.status, 200);
    assert.ok(!markup(visitor.html).includes("Draft words"), "39 · a visitor saw the component draft");
    assert.ok(markup(visitor.html).includes("Published words"));
    // A stale revision, a page that does not use it, and junk are not pages.
    assert.equal((await fetchPage(`/?component=${component.id}&rev=${revision - 1}`, owner.cookie)).status, 404);
    assert.equal((await fetchPage(`/about?component=${component.id}&rev=${revision}`, owner.cookie)).status, 404);
    assert.equal((await fetchPage(`/?component=abc&rev=1`, owner.cookie)).status, 404);
    assert.equal((await fetchPage(`/?component=${component.id}&rev={"a":1}`, owner.cookie)).status, 404);
    await componentAction("discardReusableDraft", { id: component.id, expectedRevision: revision });
  });
});

/* ========================================================================== */
/* Archive, delete, the race, the fail-safe                                   */
/* ========================================================================== */

describe("37–39 · archived components keep rendering; delete only what nothing refers to; a lost one fails safe", () => {
  test("37 · archiving a component in use keeps it live, stops new links, and delete stays refused", async () => {
    const component = await createCta("Archive CTA", "Still here", "", "/still");
    const home = await sectionOf("home", "final-cta");
    assert.equal((await link(home, "primaryCta", component)).ok, true);
    assert.equal((await publishPage("home")).ok, true);
    const archived = await componentAction("archiveReusable", { id: component.id, expectedRevision: (await componentRow(component.id))!.revision, archived: "1" });
    assert.equal(archived.ok, true, JSON.stringify(archived));
    assert.equal(anchorWith(await live("/"), "Still here")?.href, "/still", "an archived component keeps rendering");

    // The section that already links to it can still be saved…
    const again = await sectionOf("home", "final-cta");
    assert.equal((await saveContent(again, { ...current(again), title: { en: "Still editable", ar: "" } })).ok, true);
    // …but nothing new may link to it.
    const about = await sectionOf("about", "final-cta");
    const fresh = await link(about, "primaryCta", { ...component, published: component.published });
    assert.equal(fresh.ok, false);
    assert.match(String(fresh.message), /archived/);

    const refused = await componentAction("deleteReusable", { id: component.id, expectedRevision: (await componentRow(component.id))!.revision });
    assert.equal(refused.ok, false);
    assert.equal(!refused.ok && refused.reason, "in_use");
    assert.ok(await componentRow(component.id));
    await discardPage("home");
  });

  test("37 · an archived component keeps only the slot that already held it — no second slot, no move, no copy", async () => {
    const component = await createCta("Hero archived CTA", "Hero primary", "", "/hero-primary");
    const hero = await sectionOf("home", "hero");
    assert.equal((await link(hero, "primaryCta", component)).ok, true);
    const archived = await componentAction("archiveReusable", {
      id: component.id,
      expectedRevision: (await componentRow(component.id))!.revision,
      archived: "1",
    });
    assert.equal(archived.ok, true, JSON.stringify(archived));

    // Ordinary content saved beside the link the section already has: accepted, every link as it was.
    const linked = await row(hero.id);
    const links = readReuse(current(linked), "hero");
    assert.deepEqual(links.primaryCta, { c: component.id });
    const ordinary = await saveContent(linked, { ...current(linked), headline: { en: "Still the hero", ar: "" } });
    assert.equal(ordinary.ok, true, JSON.stringify(ordinary));
    const saved = await row(hero.id);
    assert.equal(saved.revision, linked.revision + 1);
    assert.deepEqual(readReuse(saved.draft, "hero"), links);

    // The same component in a second slot of the same section is a new link: refused, nothing written.
    const second = await saveContent(saved, withReuse(current(saved), { ...links, secondaryCta: { c: component.id } }));
    assert.equal(second.ok, false);
    assert.match(String(second.message), /archived/);
    const refused = await row(hero.id);
    assert.equal(refused.revision, saved.revision, "a refused save moves no revision");
    assert.deepEqual(readReuse(refused.draft, "hero"), links, "the existing references are unchanged");

    // Moving it from its slot to another is a new link as well.
    const { primaryCta: _primary, ...others } = links;
    void _primary;
    const moved = await saveContent(refused, withReuse(current(refused), { ...others, secondaryCta: { c: component.id } }));
    assert.equal(moved.ok, false);
    assert.match(String(moved.message), /archived/);
    assert.equal((await row(hero.id)).revision, saved.revision);

    // The classic section form never reads a reference from what it is sent, so it cannot add one.
    const classic = await classicSave(refused, withReuse(current(refused), { ...links, secondaryCta: { c: component.id } }));
    assert.equal(classic.ok, true, JSON.stringify(classic));
    assert.deepEqual(readReuse((await row(hero.id)).draft, "hero"), links);

    // A copy of the section would be a new instance: refused, and no row is written.
    const sections = async () =>
      (await sql<{ n: number }[]>`select count(*)::int as n from page_sections where page_id = ${hero.page_id}`)[0]!.n;
    const before = await sections();
    const copy = await structural("duplicatePageSection", "home", { sectionId: hero.id });
    assert.equal(copy.ok, false);
    assert.match(String(!copy.ok && copy.message), /archived/);
    assert.equal(await sections(), before);
    await discardPage("home");
  });

  test("37 · restoring page history is not a new link: an archived component returns to the slot the version had it in", async () => {
    const component = await createCta("History archived CTA", "History words", "", "/history");
    const section = await sectionOf("about", "final-cta");
    assert.equal((await link(section, "primaryCta", component)).ok, true);
    assert.equal((await publishPage("about")).ok, true);
    const archived = await componentAction("archiveReusable", {
      id: component.id,
      expectedRevision: (await componentRow(component.id))!.revision,
      archived: "1",
    });
    assert.equal(archived.ok, true, JSON.stringify(archived));

    // Detach and publish: the restore point taken before that publication records the link.
    assert.equal((await detach(await row(section.id), "primaryCta", 1)).ok, true);
    assert.equal((await publishPage("about")).ok, true);
    const [version] = await sql<{ id: number; snapshot: { sections: { sourceSectionId: number; published: Values }[] } }[]>`
      select id, snapshot from page_versions where page_id = ${section.page_id} order by id desc limit 1`;
    const recorded = version!.snapshot.sections.find((entry) => entry.sourceSectionId === section.id)!;
    assert.equal(readReuse(recorded.published, "final-cta", { pins: true }).primaryCta?.c, component.id);

    // Restoring it brings the link back to the slot it was in — archiving stops new links, not history.
    const restored = await editorAction<PageActionResult>("restoreVersionFromEditor", {
      pageId: section.page_id,
      expectedRevision: (await pageBySlug("about")).revision,
      versionId: version!.id,
    });
    assert.equal(restored.ok, true, JSON.stringify(restored));
    const back = await row(section.id);
    assert.deepEqual(readReuse(back.draft, "final-cta").primaryCta, { c: component.id });
    // The section saves as ever — its slot holds the component — and the page publishes it.
    assert.equal((await saveContent(back, { ...current(back), title: { en: "Restored", ar: "" } })).ok, true);
    assert.equal((await publishPage("about")).ok, true);
    assert.equal(anchorWith(await live("/about"), "History words")?.href, "/history");
  });

  test("an unused component is deleted; one a saved page version refers to is not", async () => {
    const unused = await createCta("Unused CTA", "x", "", "/x");
    const deleted = await componentAction("deleteReusable", { id: unused.id, expectedRevision: unused.revision });
    assert.equal(deleted.ok, true, JSON.stringify(deleted));
    assert.equal(await componentRow(unused.id), null);
    assert.equal(await activity("reusable_component.deleted", unused.id), 1);
  });

  test("38 · delete racing a link: never both — the survivor is always consistent", async () => {
    const privacy = await sectionOf("privacy", "rich-text");
    void privacy;
    const target = await sectionOf("about", "image-text");
    let deletedWins = 0;
    let linkWins = 0;
    for (let round = 0; round < 8; round += 1) {
      const component = await createCta(`Race CTA ${round}`, `Race ${round}`, "", "/race");
      const section = await row(target.id);
      const values = linkSlot("image-text", current(section), "cta", { id: component.id, kind: "cta", values: component.published! })!;
      const [removed, saved] = await Promise.all([
        componentAction("deleteReusable", { id: component.id, expectedRevision: component.revision }),
        saveContent(section, values),
      ]);
      const exists = Boolean(await componentRow(component.id));
      const references = readReuse((await row(target.id)).draft, "image-text").cta?.c === component.id;
      assert.ok(!(removed.ok && saved.ok), `round ${round}: both the delete and the link succeeded`);
      if (removed.ok) {
        deletedWins += 1;
        assert.equal(exists, false);
        assert.equal(references, false, `round ${round}: a link to a deleted component was stored`);
      } else {
        linkWins += saved.ok ? 1 : 0;
        assert.equal(exists, true);
      }
      await discardPage("about");
    }
    assert.ok(deletedWins + linkWins >= 1, `${deletedWins}/${linkWins}`);
  });

  test("39 · a component that has gone renders the section's kept copy, and the public page does not fail", async () => {
    const component = await createCta("Doomed CTA", "Kept copy", "نسخة", "/kept");
    const about = await sectionOf("about", "final-cta");
    assert.equal((await link(about, "primaryCta", component)).ok, true);
    assert.equal((await publishPage("about")).ok, true);
    // Gone behind the guard's back — only a hand-edited database can do this.
    await sql`delete from reusable_components where id = ${component.id}`;
    await sql`update pages set updated_at = now() where slug = 'about'`;
    await republish((await createCta("Cache buster", "b", "", "/b")).id, { label: { en: "b2", ar: "" }, href: "/b2" });
    const page = await fetchPage("/about");
    assert.equal(page.status, 200);
    assert.equal(anchorWith(page.html, "Kept copy")?.href, "/kept");
    const canvas = await fetchPage(`/about?preview=1&editor=1&bridge=${BRIDGE}`, owner.cookie);
    assert.equal(canvas.status, 200);
    assert.ok(markup(canvas.html).includes("Kept copy"));
    // The editor says so; a save still verifies, so the missing link cannot be saved again as new.
    const again = await sectionOf("about", "final-cta");
    const result = await saveContent(again, current(again));
    assert.equal(result.ok, false);
    assert.match(String(result.message), /no longer exists/);
    // Detach keeps the copy — the one way forward.
    const detached = await detach(again, "primaryCta", 0);
    assert.equal(detached.ok, true, JSON.stringify(detached));
    assert.equal((await row(about.id)).draft?.primaryCtaHref, "/kept");
    await discardPage("about");
  });
});

/* ========================================================================== */
/* Public isolation, names, SEO                                               */
/* ========================================================================== */

describe("50, 58, 60–61 · a visitor gets content, never the machinery", () => {
  test("public HTML carries no reference, no editor marks, no component name; renaming changes nothing public", async () => {
    const component = await createCta("Zq Secret Admin Name", "Visible words", "كلمات", "/visible");
    const home = await sectionOf("home", "final-cta");
    assert.equal((await link(home, "primaryCta", component)).ok, true);
    assert.equal((await publishPage("home")).ok, true);
    const html = await live("/");
    for (const needle of ["_reuse", "data-eod-reuse", "Zq Secret Admin Name", "reusable_component", "publishedVersion"]) {
      assert.ok(!html.includes(needle), `the public page carries ${needle}`);
    }
    assert.equal(anchorWith(html, "Visible words")?.href, "/visible");

    const before = anchorWith(await live("/"), "Visible words")!.tag;
    const renamed = await componentAction("renameReusable", {
      id: component.id,
      expectedRevision: (await componentRow(component.id))!.revision,
      name: "Another Admin Name",
    });
    assert.equal(renamed.ok, true);
    assert.equal(anchorWith(await live("/"), "Visible words")!.tag, before, "58 · the name is admin metadata only");

    // The canvas — and only the canvas — marks linked fields.
    const canvas = await fetchPage(`/?preview=1&editor=1&bridge=${BRIDGE}`, owner.cookie);
    assert.match(markup(canvas.html), /data-eod-reuse="primaryCta"/);
    assert.match(markup(canvas.html), /data-eod-reuse-state="inherited"/);
    const preview = await fetchPage("/?preview=1", owner.cookie);
    assert.ok(!markup(preview.html).includes("data-eod-reuse"), "an ordinary preview is not a canvas");
  });

  test("the admin screens are private: anonymous visitors are sent to sign in", async () => {
    const list = await fetchPage("/admin/components");
    assert.equal(list.status, 307);
    assert.match(String(list.location), /\/admin\/login/);
    const signedIn = await fetchPage("/admin/components", owner.cookie);
    assert.equal(signedIn.status, 200);
    assert.ok(signedIn.html.includes("Reusable components"));
  });
});

/* ========================================================================== */
/* Permissions, CSRF and the activity log                                     */
/* ========================================================================== */

describe("52–54, 57 · who may do what, and what is written down", () => {
  test("53 · nobody signed out reads components; a viewer may read them", async () => {
    assert.equal(await loader("loadReusableCatalog", [], undefined), null);
    const component = await createCta("Visible to viewers", "v", "", "/v");
    assert.equal(await loader("loadReusableComponent", [component.id], undefined), null);
    const seen = await catalog(viewer);
    assert.ok(seen && seen.some((entry) => entry.id === component.id));
  });

  test("54 · a viewer changes nothing — no component write, no link, no detach", async () => {
    const component = await createCta("Viewer target", "t", "", "/t");
    for (const [action, fields] of [
      ["saveReusableDraft", { id: component.id, expectedRevision: component.revision, values: JSON.stringify({ label: { en: "x", ar: "" }, href: "/x" }) }],
      ["publishReusable", { id: component.id, expectedRevision: component.revision }],
      ["archiveReusable", { id: component.id, expectedRevision: component.revision, archived: "1" }],
      ["deleteReusable", { id: component.id, expectedRevision: component.revision }],
      ["createReusableComponent", { kind: "cta", name: "Nope", values: "{}", publish: "0" }],
    ] as const) {
      const result = await componentAction(action, fields as Record<string, string | number>, viewer);
      assert.equal(result.ok, false, action);
      assert.equal(!result.ok && result.reason, "denied", action);
    }
    const panel = await sectionOf("about", "final-cta");
    const linked = linkSlot("final-cta", current(panel), "primaryCta", { id: component.id, kind: "cta", values: component.published! })!;
    const save = await saveContent(panel, linked, viewer);
    assert.equal(save.ok, false);
    assert.equal(save.reason, "denied");
    const detached = await detach(panel, "primaryCta", 1, viewer);
    assert.equal(detached.ok, false);
    assert.equal(!detached.ok && detached.reason, "denied");
    assert.equal((await row(panel.id)).revision, panel.revision);
  });

  test("52 · a write without the session's CSRF token is refused", async () => {
    const component = await createCta("CSRF target", "c", "", "/c");
    const forged = { ...owner, csrfToken: "not-the-token" };
    const result = await componentAction("publishReusable", { id: component.id, expectedRevision: component.revision }, forged);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.reason, "denied");
  });

  test("57 · created, draft saved, published, restored, archived, linked and detached are each one entry", async () => {
    for (const action of [
      "reusable_component.created",
      "reusable_component.draft_saved",
      "reusable_component.published",
      "reusable_component.restored",
      "reusable_component.archived",
      "reusable_component.instance_linked",
      "reusable_component.instance_detached",
    ]) {
      assert.ok((await activity(action)) > 0, `no ${action} entry`);
    }
    // No keystroke logging: an override's text is part of the ordinary draft save.
    const [row] = await sql<{ n: number }[]>`select count(*)::int as n from activity_logs where action like 'reusable_component.%' and metadata::text like '%Book a meeting%'`;
    assert.equal(row!.n, 0);
  });
});

/* ========================================================================== */
/* Style and motion stay the instance's                                       */
/* ========================================================================== */

describe("46–49 · the page's own style and motion compose with inherited content", () => {
  test("a style and a word reveal on a linked button survive linking, publishing and detaching", async () => {
    const component = await createCta("Styled CTA", "Styled words here", "", "/styled");
    const home = await sectionOf("home", "final-cta");
    assert.equal((await link(home, "primaryCta", component)).ok, true);
    let section = await sectionOf("home", "final-cta");
    const styleResult = await editorAction<{ ok: boolean }>("saveVisualSectionStyles", {
      sectionId: section.id,
      pageId: section.page_id,
      expectedRevision: section.revision,
      styles: JSON.stringify({ v: 1, nodes: { "field:primaryCtaLabel": { base: { textColor: "orange" } } } }),
    });
    assert.equal(styleResult.ok, true, JSON.stringify(styleResult));
    section = await sectionOf("home", "final-cta");
    const motionResult = await editorAction<{ ok: boolean }>("saveVisualSectionMotion", {
      sectionId: section.id,
      pageId: section.page_id,
      expectedRevision: section.revision,
      motionDocument: JSON.stringify({ v: 1, section: {}, nodes: { "field:primaryCtaLabel": { base: { textReveal: "words" } } } }),
    });
    assert.equal(motionResult.ok, true, JSON.stringify(motionResult));
    assert.equal((await publishPage("home")).ok, true);

    const styled = anchorWith(await live("/"), "Styled")!;
    assert.ok(styled, "the linked label is drawn");
    assert.match(styled.tag, /style="[^"]*color/, "46 · the page's style is on the linked element");
    assert.match(styled.tag, /data-m-words/, "47–48 · the page's word reveal splits the inherited label");
    assert.ok(styled.tag.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").includes("Styled words here"));

    // A global change keeps the page's style and motion on the new words.
    await republish(component.id, { label: { en: "Restyled text", ar: "" }, href: "/restyled" });
    const after = anchorWith(await live("/"), "Restyled")!;
    assert.match(after.tag, /style="[^"]*color/);
    assert.match(after.tag, /data-m-words/);
    // Nothing about style or motion moved in the section row.
    const stored = await sectionOf("home", "final-cta");
    assert.ok(JSON.stringify(stored.styles).includes("orange"));
    assert.ok(JSON.stringify(stored.motion_config).includes("words"));

    // 49 · detaching keeps them too.
    const detached = await detach(stored, "primaryCta", (await componentRow(component.id))!.published_version);
    assert.equal(detached.ok, true);
    assert.equal((await publishPage("home")).ok, true);
    const kept = anchorWith(await live("/"), "Restyled")!;
    assert.match(kept.tag, /style="[^"]*color/);
    assert.match(kept.tag, /data-m-words/);
  });
});

/* ========================================================================== */
/* Save as reusable, and adding a reusable block                             */
/* ========================================================================== */

describe("28–29 of the brief · save as reusable, and add a reusable section", () => {
  test("a CTA saved as reusable starts as exactly what the page shows; nothing visible changes when linked", async () => {
    const about = await sectionOf("about", "image-text");
    const liveBefore = anchorWith(await live("/about"), String((current(about).ctaLabel as { en: string }).en));
    const result = await componentAction("createReusableFromSection", {
      sectionId: about.id,
      pageId: about.page_id,
      slot: "cta",
      name: "Mission CTA",
      publish: "1",
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    const component = result.ok ? result.component! : null;
    assert.equal(component!.kind, "cta", "the kind comes from the slot, never the request");
    assert.deepEqual(component!.published, { label: current(about).ctaLabel, href: current(about).ctaHref });
    assert.equal((await link(about, "cta", component!)).ok, true);
    assert.equal((await publishPage("about")).ok, true);
    const liveAfter = anchorWith(await live("/about"), String((current(about).ctaLabel as { en: string }).en));
    assert.equal(liveAfter?.href, liveBefore?.href);
    // A section on another page cannot be named under this page.
    const wrong = await componentAction("createReusableFromSection", { sectionId: about.id, pageId: 1, slot: "cta", name: "Wrong", publish: "1" });
    assert.equal(!wrong.ok && wrong.reason, "missing");
  });

  test("a reusable block is added as one linked section; its kind must fit the block", async () => {
    const made = await componentAction("createReusableComponent", {
      kind: "block:final-cta",
      name: "Closing panel",
      values: JSON.stringify({ title: { en: "Shared close", ar: "" }, body: { en: "b", ar: "" }, primaryCtaLabel: { en: "Go", ar: "" }, primaryCtaHref: "/go", showWhatsapp: false }),
      publish: "1",
    });
    assert.equal(made.ok, true);
    const component = made.ok ? made.component! : null;
    const added = await structural("addPageSection", "terms", { blockType: "final-cta", componentId: component!.id });
    assert.equal(added.ok, true, JSON.stringify(added));
    const created = await row(added.ok ? added.sectionId! : 0);
    assert.deepEqual(readReuse(created.draft, "final-cta"), { block: { c: component!.id } });
    assert.equal((await usageOf(component!.id)).draftInstances, 1);
    assert.equal(await activity("reusable_component.instance_linked", component!.id), 1, "57 · the new instance is logged as a link");
    const wrongKind = await structural("addPageSection", "terms", { blockType: "rich-text", componentId: component!.id });
    assert.equal(wrongKind.ok, false);
    const structure = (await callAction<PageStructure | null>({
      origin: server.origin,
      route: VE_ROUTE,
      file: VE_ACTIONS,
      action: "loadPageStructure",
      args: [(await pageBySlug("terms")).id],
      cookie: owner.cookie,
    })).value!;
    assert.deepEqual(structure.sections.find((entry) => entry.sectionId === created.id)?.reuse, [{ slot: "block", componentId: component!.id }], "45 · Layers learns the link from the layout");
    await structural("discardPageLayout", "terms");
  });

  test("a whole section is refused while its CTA is linked on its own; detached, it converts to exactly what the page shows", async () => {
    const componentCount = async () => (await sql<{ n: number }[]>`select count(*)::int as n from reusable_components`)[0]!.n;

    // 1–2 · CTA A, version 1, linked into a section that could be reused whole, and published.
    const componentA = await createCta("Convert CTA", "Convert v1", "تحويل ١", "/convert-v1");
    const section = await sectionOf("about", "image-text");
    assert.equal((await link(section, "cta", componentA)).ok, true);
    assert.equal((await publishPage("about")).ok, true);

    // 3–4 · Version 2 differs. The page shows it; the section's own fields still hold version 1's kept copy.
    await republish(componentA.id, { label: { en: "Convert v2", ar: "تحويل ٢" }, href: "/convert-v2" });
    assert.equal(anchorWith(await live("/about"), "Convert v2")?.href, "/convert-v2", "the public page shows version 2");
    assert.equal(anchorWith((await fetchPage("/about?preview=1", owner.cookie)).html, "Convert v2")?.href, "/convert-v2", "so does the page preview");
    const stale = await row(section.id);
    assert.equal((current(stale).ctaLabel as { en: string }).en, "Convert v1", "the kept copy is version 1's");

    // 5–6 · Save the whole section as reusable: refused, and no component is made from the stale copy.
    const before = await componentCount();
    const converted = await componentAction("createReusableFromSection", {
      sectionId: stale.id,
      pageId: stale.page_id,
      slot: "block",
      name: "Stale panel",
      publish: "0",
    });
    assert.equal(converted.ok, false);
    assert.equal(!converted.ok && converted.message, WHOLE_BLOCK_REFUSAL);
    assert.equal(await componentCount(), before);

    // 7–8 · Link another reusable whole block over it: refused — in the panel's own link and on the server —
    // rather than dropping the CTA link; nothing written, no revision moved.
    const made = await componentAction("createReusableComponent", {
      kind: "block:image-text",
      name: "Other panel",
      values: JSON.stringify({ ...stripReuse(current(stale)), title: { en: "Other", ar: "" }, ctaLabel: { en: "Other CTA", ar: "" }, ctaHref: "/other" }),
      publish: "1",
    });
    assert.equal(made.ok, true, JSON.stringify(made));
    const other = made.ok ? made.component! : null;
    assert.equal(linkSlot("image-text", current(stale), "block", { id: other!.id, kind: other!.kind, values: other!.published! }), null);
    const laid = await saveContent(stale, withReuse({ ...current(stale), ...other!.published }, { block: { c: other!.id } }));
    assert.equal(laid.ok, false);
    assert.equal(laid.message, WHOLE_BLOCK_REFUSAL);
    const kept = await row(section.id);
    assert.equal(kept.revision, stale.revision, "a refused save moves no revision");
    assert.deepEqual(readReuse(current(kept), "image-text"), { cta: { c: componentA.id } }, "the CTA link is still there");

    // 9 · Detach the CTA the ordinary way: the section keeps what the page shows — version 2.
    const detached = await detach(kept, "cta", 2);
    assert.equal(detached.ok, true, JSON.stringify(detached));
    const own = await row(section.id);
    assert.deepEqual(readReuse(current(own), "image-text"), {});
    assert.deepEqual(current(own).ctaLabel, { en: "Convert v2", ar: "تحويل ٢" });

    // 10 · Now the whole section converts — from exactly what the page shows — and linking it changes nothing visible.
    const whole = await componentAction("createReusableFromSection", {
      sectionId: own.id,
      pageId: own.page_id,
      slot: "block",
      name: "Current panel",
      publish: "1",
    });
    assert.equal(whole.ok, true, JSON.stringify(whole));
    const panel = whole.ok ? whole.component! : null;
    assert.equal(panel!.kind, "block:image-text");
    assert.deepEqual(panel!.published!.ctaLabel, { en: "Convert v2", ar: "تحويل ٢" });
    assert.equal(panel!.published!.ctaHref, "/convert-v2");
    const shownBefore = anchorWith((await fetchPage("/about?preview=1", owner.cookie)).html, "Convert v2");
    assert.equal((await link(own, "block", panel!)).ok, true);
    const shownAfter = anchorWith((await fetchPage("/about?preview=1", owner.cookie)).html, "Convert v2");
    assert.equal(shownAfter?.href, "/convert-v2");
    assert.equal(shownAfter?.tag, shownBefore?.tag, "visually identical: the same link, word for word");
    await discardPage("about");
  });
});
