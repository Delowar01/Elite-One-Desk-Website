/**
 * Batch 19B §21: the final audit of every write, and what it found.
 *
 * Every admin write was walked once more for the same seven things — session,
 * CSRF token, permission, ownership, a revision where one applies, a
 * validator, and an activity entry where the policy asks for one. Nothing let
 * a caller past the server's permission check. What the walk did find were
 * writes that were *right only because nobody had tried otherwise*:
 *
 *   · a request that named no revision was read as revision 0 — the revision
 *     every row starts at — by the Visual Editor's saves, its layout actions
 *     and the component writes, so on a row nobody had edited yet it went
 *     through without a concurrency check at all;
 *   · moving a section on the Pages screen read the layout before asking who
 *     was moving it, and answered "done" to anyone for a move at the edge;
 *   · three reorders wrote no activity entry, four updates logged "updated"
 *     for an id that names nothing, and six creates logged entity 0;
 *   · a copy of a linked section made a new link and recorded none;
 *   · an unused action marked enquiries read under the *view* permission;
 *   · three relationships were enforced only by what a form offered;
 *   · every throttle and audit hash read the first `X-Forwarded-For` hop,
 *     which the client writes; and an enquiry kept any key a client sent.
 *
 * Each of those tests fails on the code before 19B and passes after it, and
 * each refusal is paired with the same request succeeding once the missing
 * thing is supplied — so a refusal for some other reason cannot pass for this
 * one. The last describe is different: §24's isolation table asked for a
 * signed-in session without `content.view` to be shown the live page whatever
 * preview it asks for, the server already did so, and no test said it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { callAction, type ActionResponse } from "./helpers/action";
import { REPO_ROOT } from "./helpers/env";
import { giveFresh } from "./helpers/fixtures";
import { get } from "./helpers/http";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { BUILD_HINT, isBuilt, startServer, type Server } from "./helpers/server";
import { openServiceForm } from "./helpers/service-form";
import { signIn, type TestSession } from "./helpers/session";

import type { ActionState } from "@/lib/admin/actions";
import { clientIpFrom } from "@/lib/auth/client-ip";
import { linkSlot } from "@/lib/cms/reuse/reference";
import type { ReuseActionResult, ReuseComponentView } from "@/lib/cms/reuse/view";
import { enquirySchema } from "@/lib/validation/enquiry";

const PORT = 3503;

const VE = "app/(backoffice)/admin/visual-editor/actions.ts";
const COMPONENTS = "app/(backoffice)/admin/(shell)/components/actions.ts";
const PAGES = "app/(backoffice)/admin/(shell)/pages/actions.ts";
const CATEGORIES = "app/(backoffice)/admin/(shell)/categories/actions.ts";
const FAQS = "app/(backoffice)/admin/(shell)/faqs/actions.ts";
const TESTIMONIALS = "app/(backoffice)/admin/(shell)/testimonials/actions.ts";
const VIDEOS = "app/(backoffice)/admin/(shell)/videos/actions.ts";
const NAVIGATION = "app/(backoffice)/admin/(shell)/navigation/actions.ts";
const SETTINGS = "app/(backoffice)/admin/(shell)/settings/actions.ts";
const SEO = "app/(backoffice)/admin/(shell)/seo/actions.ts";
const SERVICES = "app/(backoffice)/admin/(shell)/services/actions.ts";
const ENQUIRIES = "app/(backoffice)/admin/(shell)/enquiries/actions.ts";
const LOGIN = "app/(backoffice)/admin/login/actions.ts";

let database = "";
let sql: Sql;
let server: Server;
let owner: TestSession;
let viewer: TestSession;

type Values = Record<string, unknown>;
type Result = { ok: boolean; reason?: string; message?: string } & Record<string, unknown>;

/* -------------------------------------------------------------------------- */
/* Calling the real actions, as the panel calls them                          */
/* -------------------------------------------------------------------------- */

/** A form as the panel posts it; `as: null` sends no token and no cookie. */
function formOf(fields: Record<string, string | number>, as: TestSession | null = owner, csrf?: string) {
  const data = new FormData();
  if (as) data.set("_csrf", csrf ?? as.csrfToken);
  for (const [key, value] of Object.entries(fields)) data.set(key, String(value));
  return data;
}

function answered<T>(response: ActionResponse<T>): T {
  assert.ok(response.value, `the action returned nothing (status ${response.status}): ${response.text.slice(0, 300)}`);
  return response.value;
}

/** A Visual Editor or component action: one FormData argument. */
const single = async <T = Result>(
  file: string,
  route: string,
  action: string,
  fields: Record<string, string | number>,
  as: TestSession | null = owner,
) =>
  answered(
    await callAction<T>({ origin: server.origin, route, file, action, args: [formOf(fields, as)], cookie: as?.cookie }),
  );

const editor = <T = Result>(action: string, fields: Record<string, string | number>, as: TestSession | null = owner) =>
  single<T>(VE, "/admin/visual-editor", action, fields, as);

const component = (action: string, fields: Record<string, string | number>) =>
  single<ReuseActionResult>(COMPONENTS, "/admin/components", action, fields);

/** A classic screen's action: `(previousState, form)`, posted to its own page. */
const screen = async (
  file: string,
  route: string,
  action: string,
  fields: Record<string, string | number>,
  as: TestSession | null = owner,
  csrf?: string,
) =>
  callAction<ActionState>({
    origin: server.origin,
    route,
    file,
    action,
    args: [{ ok: false }, formOf(fields, as, csrf)],
    cookie: as?.cookie,
  });

const entries = async (action: string, entityId?: number | string) => {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from activity_logs
     where action = ${action} ${entityId === undefined ? sql`` : sql`and entity_id = ${String(entityId)}`}`;
  return row!.n;
};

const pageBySlug = async (slug: string) => {
  const [row] = await sql<{ id: number; revision: number }[]>`select id, revision from pages where slug = ${slug}`;
  return row!;
};

/* -------------------------------------------------------------------------- */

before(async () => {
  assert.ok(isBuilt(), BUILD_HINT);
  database = giveFresh("mutation_audit");
  sql = connect(database);
  owner = await signIn(sql);
  await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    select 'audit-viewer@test.invalid', 'Audit Reader', 'unused', id, true from roles where key = 'viewer'`;
  viewer = await signIn(sql, "viewer");
  server = await startServer(database, PORT);
});

after(async () => {
  await server?.stop();
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
});

/* -------------------------------------------------------------------------- */

describe("19B · a write that names no revision is refused, even on a row still at revision 0", () => {
  test("a content, style or motion save without a revision is refused on a section nobody has edited", async () => {
    const [section] = await sql<{ id: number; page_id: number; revision: number; published: Values }[]>`
      select s.id, s.page_id, s.revision, s.published
        from page_sections s join pages p on p.id = s.page_id
       where s.revision = 0 and not s.is_draft_only and s.draft is null and s.draft_styles is null
         and s.draft_motion_config is null and s.draft_animation is null and p.slug = 'about'
       order by s.position limit 1`;
    assert.ok(section, "a section still at revision 0 to test against");
    const at = { sectionId: section.id, pageId: section.page_id };
    const attempts: Array<[string, Record<string, string | number>]> = [
      ["saveVisualSectionDraft", { ...at, values: JSON.stringify(section.published) }],
      ["saveVisualSectionStyles", { ...at, styles: JSON.stringify({ v: 1, nodes: {} }) }],
      ["saveVisualSectionMotion", { ...at, motion: "scale-in" }],
    ];

    for (const [action, fields] of attempts) {
      const refused = await editor(action, fields);
      assert.equal(refused.ok, false, `${action} without a revision: ${JSON.stringify(refused)}`);
    }
    const [unchanged] = await sql<{ revision: number; draft: unknown; draft_styles: unknown; draft_animation: unknown }[]>`
      select revision, draft, draft_styles, draft_animation from page_sections where id = ${section.id}`;
    assert.deepEqual(unchanged, { revision: 0, draft: null, draft_styles: null, draft_animation: null });

    // The same requests, naming the revision the screen was built from, are
    // accepted — so the refusals above were about the revision and nothing else.
    for (const [action, fields] of attempts) {
      const [now] = await sql<{ revision: number }[]>`select revision from page_sections where id = ${section.id}`;
      const saved = await editor(action, { ...fields, expectedRevision: now!.revision });
      assert.equal(saved.ok, true, `${action} with a revision: ${JSON.stringify(saved)}`);
    }
  });

  test("a layout operation without a page revision is refused on a page nobody has edited", async () => {
    const [page] = await sql<{ id: number; slug: string }[]>`
      select id, slug from pages where revision = 0 and draft_structure is null order by id limit 1`;
    assert.ok(page, "a page still at revision 0 to test against");
    const pending = async () =>
      (await sql<{ n: number }[]>`select count(*)::int as n from page_sections where page_id = ${page.id} and is_draft_only`)[0]!.n;

    const refused = await editor("addPageSection", { pageId: page.id, blockType: "rich-text" });
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal((await pageBySlug(page.slug)).revision, 0);
    assert.equal(await pending(), 0);

    const added = await editor("addPageSection", { pageId: page.id, blockType: "rich-text", expectedRevision: 0 });
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.equal(await pending(), 1);
  });

  test("a component write without a revision is refused on a component still at revision 0", async () => {
    const created = await component("createReusableComponent", {
      kind: "cta",
      name: "Audit draft",
      values: JSON.stringify({ label: { en: "Ask us", ar: "اسألنا" }, href: "/contact" }),
      publish: "0",
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    const id = (created as { component: ReuseComponentView }).component.id;
    const revisionOf = async () =>
      (await sql<{ revision: number }[]>`select revision from reusable_components where id = ${id}`)[0]!.revision;
    assert.equal(await revisionOf(), 0);

    const values = JSON.stringify({ label: { en: "Ask us today", ar: "اسألنا اليوم" }, href: "/contact" });
    const refused = await component("saveReusableDraft", { id, values });
    assert.equal(refused.ok, false, JSON.stringify(refused));
    assert.equal(await revisionOf(), 0);

    const saved = await component("saveReusableDraft", { id, values, expectedRevision: 0 });
    assert.equal(saved.ok, true, JSON.stringify(saved));
    assert.equal(await revisionOf(), 1);
  });
});

describe("19B · moving a section asks who is moving it before it reads the layout", () => {
  test("no session, a foreign token or a role without layout rights is refused — even at the edge, which used to answer done", async () => {
    const page = await pageBySlug("about");
    const [first] = await sql<{ id: number }[]>`
      select id from page_sections where page_id = ${page.id} and not is_draft_only order by position, id limit 1`;
    // Moving the first section up changes nothing: the edge. Before 19B this
    // answered `ok` without asking anything of the caller.
    const fields = { pageId: page.id, id: first!.id, direction: "up", expectedRevision: page.revision };
    const before = await entries("section.layout_reordered");

    const anonymous = await screen(PAGES, "/admin/pages/about", "moveSection", fields, null);
    assert.equal(answered(anonymous).ok, false, "no session");
    const forged = await screen(PAGES, "/admin/pages/about", "moveSection", fields, owner, "not-the-token");
    assert.equal(answered(forged).ok, false, "a token that is not the session's");
    const reader = answered(await screen(PAGES, "/admin/pages/about", "moveSection", fields, viewer));
    assert.equal(reader.ok, false, "a role without content.structure");
    assert.match(reader.message ?? "", /does not allow changing the page layout/);

    const allowed = answered(await screen(PAGES, "/admin/pages/about", "moveSection", fields));
    assert.equal(allowed.ok, true, JSON.stringify(allowed));
    assert.equal((await pageBySlug("about")).revision, page.revision, "the edge changes nothing");
    assert.equal(await entries("section.layout_reordered"), before);
  });
});

describe("19B · every change leaves one accurate activity entry, and a non-change none", () => {
  const video = (title: string, id = 0) => ({
    ...(id ? { id } : {}),
    sourceUrl: "https://www.youtube.com/watch?v=lFhAiGLjoMo",
    titleEn: title,
    isPublished: "on",
  });

  test("reordering a category, a menu link or a video is recorded; a move at the edge is not", async () => {
    const categories = await sql<{ id: number }[]>`select id from service_categories order by sort_order, id limit 2`;
    assert.equal(categories.length, 2);
    const second = categories[1]!.id;
    let before = await entries("category.reordered");
    assert.equal(answered(await screen(CATEGORIES, "/admin/categories", "moveCategory", { id: second, direction: "up" })).ok, true);
    assert.equal(await entries("category.reordered", second), 1);
    // Now first: up again is the edge.
    assert.equal(answered(await screen(CATEGORIES, "/admin/categories", "moveCategory", { id: second, direction: "up" })).ok, true);
    assert.equal(await entries("category.reordered"), before + 1);

    const [link] = await sql<{ id: number }[]>`
      select id from navigation_items
       where menu = 'header' and parent_id is null
       order by sort_order desc, id desc limit 1`;
    before = await entries("navigation.reordered");
    assert.equal(answered(await screen(NAVIGATION, "/admin/navigation", "moveNavItem", { id: link!.id, direction: "up" })).ok, true);
    assert.equal(await entries("navigation.reordered", link!.id), 1);
    const [top] = await sql<{ id: number }[]>`
      select id from navigation_items where menu = 'header' and parent_id is null order by sort_order, id limit 1`;
    await screen(NAVIGATION, "/admin/navigation", "moveNavItem", { id: top!.id, direction: "up" });
    assert.equal(await entries("navigation.reordered"), before + 1);

    for (const title of ["Audit video one", "Audit video two"]) {
      assert.equal(answered(await screen(VIDEOS, "/admin/videos", "saveVideo", video(title))).ok, true);
    }
    const [last] = await sql<{ id: number }[]>`select id from videos order by sort_order desc, id desc limit 1`;
    before = await entries("video.reordered");
    assert.equal(answered(await screen(VIDEOS, "/admin/videos", "moveVideo", { id: last!.id, direction: "down" })).ok, true);
    assert.equal(await entries("video.reordered"), before, "already last: the edge");
    assert.equal(answered(await screen(VIDEOS, "/admin/videos", "moveVideo", { id: last!.id, direction: "up" })).ok, true);
    assert.equal(await entries("video.reordered", last!.id), 1);
  });

  test("saving a question, testimonial, video or service group that no longer exists is refused, and logs nothing", async () => {
    const ghost = 987654;
    const [category] = await sql<{ id: number }[]>`select id from service_categories order by id limit 1`;
    const attempts: Array<[string, string, string, Record<string, string | number>, string, string]> = [
      [FAQS, "/admin/faqs", "saveFaq", { id: ghost, scope: "global", questionEn: "Ghost question?" }, "faq.updated", "faqs"],
      [TESTIMONIALS, "/admin/testimonials", "saveTestimonial", { id: ghost, name: "Ghost", quoteEn: "Boo." }, "testimonial.updated", "testimonials"],
      [VIDEOS, "/admin/videos", "saveVideo", video("Ghost video", ghost), "video.updated", "videos"],
      [
        CATEGORIES,
        `/admin/categories/${category!.id}`,
        "saveSubcategory",
        { id: ghost, categoryId: category!.id, slug: "ghost-group", titleEn: "Ghost group" },
        "subcategory.updated",
        "service_subcategories",
      ],
    ];
    for (const [file, route, action, fields, logged, table] of attempts) {
      const rows = async () => (await sql<{ n: number }[]>`select count(*)::int as n from ${sql(table)}`)[0]!.n;
      const count = await rows();
      const result = answered(await screen(file, route, action, fields));
      assert.equal(result.ok, false, `${action} for an id that names nothing: ${JSON.stringify(result)}`);
      assert.match(result.message ?? "", /no longer exists/);
      assert.equal(await entries(logged, ghost), 0, `${action} logged an update to nothing`);
      assert.equal(await rows(), count, `${action} wrote a row`);
    }
  });

  test("a new question, testimonial, video, group, menu link or social link is logged under the id it was given", async () => {
    const [category] = await sql<{ id: number }[]>`select id from service_categories order by id limit 1`;
    const creates: Array<[string, string, string, Record<string, string | number>, string, string]> = [
      [FAQS, "/admin/faqs", "saveFaq", { scope: "global", questionEn: "Audit question?" }, "faq.created", "faqs"],
      [TESTIMONIALS, "/admin/testimonials", "saveTestimonial", { name: "Audit", quoteEn: "Fine." }, "testimonial.created", "testimonials"],
      [VIDEOS, "/admin/videos", "saveVideo", video("Audit video three"), "video.added", "videos"],
      [
        CATEGORIES,
        `/admin/categories/${category!.id}`,
        "saveSubcategory",
        { categoryId: category!.id, slug: "audit-group", titleEn: "Audit group" },
        "subcategory.created",
        "service_subcategories",
      ],
      [NAVIGATION, "/admin/navigation", "saveNavItem", { menu: "header", labelEn: "Audit link", href: "/about" }, "navigation.created", "navigation_items"],
      [SETTINGS, "/admin/settings", "saveSocialLink", { platform: "website", url: "https://example.com/audit", isPublished: "on" }, "social.created", "social_links"],
    ];
    for (const [file, route, action, fields, logged, table] of creates) {
      const zero = await entries(logged, 0);
      const result = answered(await screen(file, route, action, fields));
      assert.equal(result.ok, true, `${action}: ${JSON.stringify(result)}`);
      const [newest] = await sql<{ id: number }[]>`select max(id)::int as id from ${sql(table)}`;
      assert.equal(await entries(logged, newest!.id), 1, `${action} is not logged under the new row's id`);
      assert.equal(await entries(logged, 0), zero, `${action} logged entity 0`);
    }
  });

  test("clearing an SEO override that is not there says so and leaves no entry; clearing one that is leaves one", async () => {
    const before = await entries("seo.cleared");
    const nothing = answered(await screen(SEO, "/admin/seo", "clearSeo", { entityType: "page", entityKey: "about" }));
    assert.equal(nothing.ok, true);
    assert.match(nothing.message ?? "", /no override/);
    assert.equal(await entries("seo.cleared"), before);

    await sql`insert into seo_metadata (entity_type, entity_key, title_en) values ('page', 'about', 'Audit title')`;
    const cleared = answered(await screen(SEO, "/admin/seo", "clearSeo", { entityType: "page", entityKey: "about" }));
    assert.equal(cleared.ok, true);
    assert.equal(await entries("seo.cleared"), before + 1);
    assert.equal((await sql`select 1 from seo_metadata where entity_type = 'page' and entity_key = 'about'`).length, 0);
  });

  test("a copy of a linked section records the new link — in the editor and on the Pages screen", async () => {
    const created = await component("createReusableComponent", {
      kind: "cta",
      name: "Audit linked",
      values: JSON.stringify({ label: { en: "Plan with us", ar: "خطط معنا" }, href: "/contact" }),
      publish: "1",
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    const cta = (created as { component: ReuseComponentView }).component;

    const page = await pageBySlug("about");
    const [section] = await sql<{ id: number; revision: number; block_type: string; published: Values; draft: Values | null }[]>`
      select id, revision, block_type, published, draft from page_sections
       where page_id = ${page.id} and block_type = 'final-cta' and not is_draft_only limit 1`;
    const values = linkSlot(section!.block_type, section!.draft ?? section!.published, "primaryCta", {
      id: cta.id,
      kind: cta.kind,
      values: cta.published!,
    });
    assert.ok(values);
    const linked = await editor("saveVisualSectionDraft", {
      sectionId: section!.id,
      pageId: page.id,
      expectedRevision: section!.revision,
      values: JSON.stringify(values),
    });
    assert.equal(linked.ok, true, JSON.stringify(linked));

    const copiesOf = async () =>
      sql<{ section: string }[]>`
        select metadata->>'sectionId' as section from activity_logs
         where action = 'reusable_component.instance_linked' and entity_id = ${String(cta.id)}
           and metadata->>'slot' = 'primaryCta'`;
    const linkedBefore = (await copiesOf()).length;

    const fromEditor = await editor("duplicatePageSection", {
      pageId: page.id,
      expectedRevision: (await pageBySlug("about")).revision,
      sectionId: section!.id,
    });
    assert.equal(fromEditor.ok, true, JSON.stringify(fromEditor));
    const editorCopy = Number((fromEditor as { sectionId?: number }).sectionId);
    assert.ok(editorCopy > 0);

    const fromScreen = answered(
      await screen(PAGES, "/admin/pages/about", "duplicateSection", {
        pageId: page.id,
        id: section!.id,
        expectedRevision: (await pageBySlug("about")).revision,
      }),
    );
    assert.equal(fromScreen.ok, true, JSON.stringify(fromScreen));
    const [screenCopy] = await sql<{ id: number }[]>`
      select max(id)::int as id from page_sections where page_id = ${page.id} and is_draft_only`;

    const recorded = (await copiesOf()).map((row) => Number(row.section));
    assert.equal(recorded.length, linkedBefore + 2);
    assert.ok(recorded.includes(editorCopy), "the editor's copy is not recorded as a link");
    assert.ok(recorded.includes(screenCopy!.id), "the Pages screen's copy is not recorded as a link");
  });

  test("the enquiry read-marker that wrote under the view permission is gone from the build", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(REPO_ROOT, ".next", "server", "server-reference-manifest.json"), "utf8"),
    ) as { node: Record<string, { filename: string; exportedName: string }> };
    const fromEnquiries = Object.values(manifest.node)
      .filter((entry) => entry.filename === ENQUIRIES)
      .map((entry) => entry.exportedName)
      .sort();
    assert.deepEqual(fromEnquiries, ["addEnquiryNote", "updateEnquiry"]);
  });
});

describe("19B · rules the server holds itself, not the form", () => {
  test("a service filed under another category's group is refused, on create and on update", async () => {
    const [a, b] = await sql<{ id: number }[]>`select id from service_categories order by id limit 2`;
    const groupOf = async (categoryId: number, slug: string) => {
      const [found] = await sql<{ id: number }[]>`
        select id from service_subcategories where category_id = ${categoryId} order by id limit 1`;
      if (found) return found.id;
      const [made] = await sql<{ id: number }[]>`
        insert into service_subcategories (category_id, slug, title_en) values (${categoryId}, ${slug}, 'Audit') returning id`;
      return made!.id;
    };
    const groupA = await groupOf(a!.id, "audit-a");
    const groupB = await groupOf(b!.id, "audit-b");

    const create = (subcategoryId: number, slug: string) =>
      screen(SERVICES, "/admin/services/new", "createService", {
        slug,
        titleEn: "Audit service",
        categoryId: a!.id,
        subcategoryId,
        formPreset: "general",
      });
    const mismatched = answered(await create(groupB, "audit-mismatch"));
    assert.equal(mismatched.ok, false, JSON.stringify(mismatched));
    assert.equal((await sql`select 1 from services where slug = 'audit-mismatch'`).length, 0);

    await create(groupA, "audit-match");
    const [made] = await sql<{ id: number }[]>`select id from services where slug = 'audit-match'`;
    assert.ok(made, "the matching pair is accepted");

    // The form as its page draws it, with its signed base (Batch 23), filed under `subcategoryId`.
    const update = async (subcategoryId: number) =>
      screen(SERVICES, `/admin/services/${made!.id}`, "updateService", {
        ...(await openServiceForm(sql, server.origin, owner.cookie, made!.id)),
        subcategoryId,
      });
    assert.equal(answered(await update(groupB)).ok, false);
    const [kept] = await sql<{ subcategory_id: number }[]>`select subcategory_id from services where id = ${made!.id}`;
    assert.equal(kept!.subcategory_id, groupA);
    assert.equal(answered(await update(groupA)).ok, true);
  });

  test("an edited service group stays in its category, whatever the form says", async () => {
    const [a, b] = await sql<{ id: number }[]>`select id from service_categories order by id limit 2`;
    const [group] = await sql<{ id: number; slug: string }[]>`
      insert into service_subcategories (category_id, slug, title_en) values (${a!.id}, 'audit-stays', 'Stays')
      returning id, slug`;
    const saved = answered(
      await screen(CATEGORIES, `/admin/categories/${a!.id}`, "saveSubcategory", {
        id: group!.id,
        categoryId: b!.id,
        slug: group!.slug,
        titleEn: "Stays put",
      }),
    );
    assert.equal(saved.ok, true, JSON.stringify(saved));
    const [row] = await sql<{ category_id: number; title_en: string }[]>`
      select category_id, title_en from service_subcategories where id = ${group!.id}`;
    assert.deepEqual(row, { category_id: a!.id, title_en: "Stays put" });
  });

  test("an enquiry is assigned to an active account, and keeps an assignee whose account has since been switched off", async () => {
    const [enquiry] = await sql<{ id: number }[]>`
      insert into enquiries (reference, name, email, status) values ('EOD-AUDIT-0001', 'Audit', 'audit@test.invalid', 'new')
      returning id`;
    const [role] = await sql<{ id: number }[]>`select id from roles where key = 'editor'`;
    const [active, retired] = await sql<{ id: number }[]>`
      insert into users (email, name, password_hash, role_id, is_active) values
        ('audit-active@test.invalid', 'Active', 'x', ${role!.id}, true),
        ('audit-retired@test.invalid', 'Retired', 'x', ${role!.id}, false)
      returning id`;
    const assign = (assignedTo: string | number, status = "contacted") =>
      screen(ENQUIRIES, `/admin/enquiries/${enquiry!.id}`, "updateEnquiry", { id: enquiry!.id, status, assignedTo });
    const assignee = async () =>
      (await sql<{ assigned_to: number | null }[]>`select assigned_to from enquiries where id = ${enquiry!.id}`)[0]!.assigned_to;

    assert.equal(answered(await assign(retired!.id)).ok, false, "a switched-off account");
    assert.equal(answered(await assign(987654)).ok, false, "an account that does not exist");
    assert.equal(answered(await assign("two")).ok, false, "not an id at all");
    assert.equal(await assignee(), null);

    assert.equal(answered(await assign(active!.id)).ok, true);
    assert.equal(await assignee(), active!.id);
    await sql`update users set is_active = false where id = ${active!.id}`;
    assert.equal(answered(await assign(active!.id, "in_progress")).ok, true, "a status change keeps the assignee it has");
    assert.equal(await assignee(), active!.id);
    assert.equal(answered(await assign("")).ok, true);
    assert.equal(await assignee(), null);
  });
});

describe("19B · the address a throttle counts is the proxy's, not the client's", () => {
  test("X-Real-IP wins; without it, the last X-Forwarded-For hop — the one the proxy added — and never the first", () => {
    const from = (headers: Record<string, string>) => clientIpFrom(new Headers(headers));
    assert.equal(from({ "x-real-ip": "203.0.113.9", "x-forwarded-for": "1.2.3.4, 203.0.113.9" }), "203.0.113.9");
    assert.equal(from({ "x-forwarded-for": "1.2.3.4, 198.51.100.2, 203.0.113.9" }), "203.0.113.9");
    assert.equal(from({ "x-forwarded-for": " 203.0.113.9 " }), "203.0.113.9");
    assert.equal(from({ "x-forwarded-for": "" }), "");
    assert.equal(from({}), "");
  });

  test("failed sign-ins from one address count as one address, however the client rewrites X-Forwarded-For", async () => {
    const since = new Date();
    for (const spoof of ["10.0.0.1", "10.0.0.2", "10.0.0.3"]) {
      const refused = answered(
        await callAction<ActionState>({
          origin: server.origin,
          route: "/admin/login",
          file: LOGIN,
          action: "signIn",
          args: [{ ok: false }, formOf({ email: "nobody-19b@test.invalid", password: "not-the-password" }, null)],
          headers: { "x-real-ip": "203.0.113.50", "x-forwarded-for": `${spoof}, 203.0.113.50` },
        }),
      );
      assert.equal(refused.ok, false);
    }
    const hashes = await sql<{ ip_hash: string }[]>`
      select distinct ip_hash from login_attempts where attempted_at >= ${since}`;
    assert.equal(hashes.length, 1, `one address, one hash: ${hashes.length}`);
    assert.notEqual(hashes[0]!.ip_hash, "");
  });

  test("an enquiry stream from one address is throttled however the client rewrites X-Forwarded-For", async () => {
    const post = (realIp: string, spoof: string) =>
      fetch(`${server.origin}/api/enquiries`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-real-ip": realIp,
          "x-forwarded-for": `${spoof}, ${realIp}`,
        },
        body: JSON.stringify({ name: "Audit Visitor", email: "visitor@test.invalid", message: "Hello", elapsed: 5000 }),
      });
    const statuses: number[] = [];
    for (let i = 1; i <= 7; i += 1) statuses.push((await post("203.0.113.70", `192.0.2.${i}`)).status);
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 200, 429]);
    assert.equal((await post("203.0.113.71", "192.0.2.1")).status, 200, "another address is not caught by it");
  });

  test("an enquiry keeps only the detail and campaign keys a form can send", async () => {
    const parsed = enquirySchema.parse({
      name: "Audit Visitor",
      email: "visitor@test.invalid",
      details: { destination: "Cairo", adults: "2", injected: "x".repeat(400) },
      utm: { utm_source: "newsletter", gclid: "abc", evil: "y" },
    });
    assert.deepEqual(parsed.details, { destination: "Cairo", adults: "2" });
    assert.deepEqual(parsed.utm, { utm_source: "newsletter", gclid: "abc" });

    const keys = Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [`k${i}`, "v"]));
    const response = await fetch(`${server.origin}/api/enquiries`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-real-ip": "203.0.113.80" },
      body: JSON.stringify({
        name: "Many Keys",
        email: "many@test.invalid",
        elapsed: 5000,
        details: { ...keys, destination: "Muscat" },
        utm: { ...keys, utm_campaign: "autumn" },
      }),
    });
    const body = (await response.json()) as { ok: boolean; reference: string };
    assert.equal(body.ok, true);
    const [stored] = await sql<{ details: Values; utm: Values }[]>`
      select details, utm from enquiries where reference = ${body.reference}`;
    assert.deepEqual(stored, { details: { destination: "Muscat" }, utm: { utm_campaign: "autumn" } });
  });
});

describe("19B · a session that may not see drafts is shown the live page, whatever it asks for", () => {
  test("an ordinary preview or the editor's canvas, asked for without content.view, is the published page", async () => {
    const page = await pageBySlug("about");
    const [first] = await sql<{ id: number }[]>`
      select id from page_sections where page_id = ${page.id} and not is_draft_only order by position, id limit 1`;
    const marker = "A draft only content.view may see (19B)";
    await sql`update page_sections
                 set draft = jsonb_set(coalesce(draft, published), '{title,en}', to_jsonb(${marker}::text)),
                     revision = revision + 1
               where id = ${first!.id}`;

    // Every permission there is, except the one that shows drafts.
    const [role] = await sql<{ id: number }[]>`select id from roles where key = 'editor'`;
    await sql`delete from role_permissions where role_id = ${role!.id}`;
    await sql`
      insert into role_permissions (role_id, permission_id)
      select ${role!.id}, id from permissions where key <> 'content.view'`;
    await sql`update users set is_active = false where role_id = ${role!.id}`;
    await sql`
      insert into users (email, name, password_hash, role_id, is_active)
      values ('audit-no-view@test.invalid', 'Sees no drafts', 'x', ${role!.id}, true)`;
    const blind = await signIn(sql, "editor");

    const BRIDGE = "0123456789abcdef0123456789abcdef";
    for (const path of ["/about?preview=1", `/about?preview=1&editor=1&bridge=${BRIDGE}`, `/ar/about?preview=1`]) {
      const html = (await get(server.origin, path, { cookie: blind.cookie })).html;
      assert.ok(!html.includes(marker), `${path} showed a draft to a session without content.view`);
      assert.ok(!/Preview — showing/.test(html), `${path} called itself a preview`);
      assert.ok(!/data-eod-address/.test(html), `${path} was drawn for an editor`);
    }
    // The owner, who may, is shown it — so the page above was the published one, not an empty one.
    assert.ok((await get(server.origin, "/about?preview=1", { cookie: owner.cookie })).html.includes(marker));
  });
});
