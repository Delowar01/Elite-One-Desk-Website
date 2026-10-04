/**
 * Batch 23 · the Services form against everything else that writes a service.
 *
 * `updateService` used to write every column the form held, so a form opened
 * before somebody else's change put the older values back when it was saved.
 * Now the form posts the signed base its page drew it with, and the server
 * writes only what the form changed — refusing, whole and with nothing
 * written, a change to a field that also moved elsewhere
 * (docs/admin/services-form-concurrency.md).
 *
 * Everything here runs against the real server and a real PostgreSQL: the
 * Services form is posted as a browser posts it (its fields and the `_base`
 * its page rendered), and "elsewhere" is the real Visual Editor publishing,
 * the real list toggle and a second admin's real form. The concurrency cases
 * race real transactions.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { callAction } from "./helpers/action";
import { giveFresh } from "./helpers/fixtures";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { probeValue } from "./helpers/probe";
import { BUILD_HINT, isBuilt, startServer, type Server } from "./helpers/server";
import { changedForm, openServiceForm, type ServiceFormFields } from "./helpers/service-form";
import { signIn, type TestSession } from "./helpers/session";

import { documentEditorKey, editorKeyOf, type RouteOwner } from "@/lib/routes/owners";
import type { RouteActionResult, RouteSummaryView } from "@/lib/routes/views";
import type { VisualSectionLoad } from "@/lib/visual-editor/content";

const PORT = 3509;
const ROUTE_ACTIONS = "app/(backoffice)/admin/visual-editor/route-actions.ts";
const SERVICE_ACTIONS = "app/(backoffice)/admin/(shell)/services/actions.ts";

let database = "";
let sql: Sql;
let server: Server;
let owner: TestSession;
let viewer: TestSession;

type Service = { id: number; slug: string; category_id: number; subcategory_id: number | null };
let services: Service[] = [];
/** A published service filed under a group, for the category move. */
let grouped: Service;
type Answer = { ok: boolean; reason?: string; message?: string; conflicts?: string[]; errors?: Record<string, string> };
type Values = Record<string, unknown>;

/* -------------------------------------------------------------------------- */

const actionOf = async <T>(file: string, route: string, action: string, args: unknown[], session: TestSession) =>
  (await callAction<T>({ origin: server.origin, route, file, action, args, cookie: session.cookie })).value;

const formOf = (fields: Record<string, string | number>, session: TestSession, csrf: string | null = session.csrfToken) => {
  const data = new FormData();
  if (csrf !== null) data.set("_csrf", csrf);
  for (const [key, value] of Object.entries(fields)) data.set(key, String(value));
  return data;
};

/** The edit page, opened now: its fields and its signed base. */
const open = (service: { id: number }, session = owner) => openServiceForm(sql, server.origin, session.cookie, service.id);

/** Posts an opened form with `changes` made to it. */
const save = (opened: ServiceFormFields, changes: Record<string, string | number | null> = {}, session = owner, csrf?: string | null) =>
  actionOf<Answer>(
    SERVICE_ACTIONS,
    `/admin/services/${opened.id}`,
    "updateService",
    [{ ok: false }, formOf(changedForm(opened, changes), session, csrf === undefined ? session.csrfToken : csrf)],
    session,
  );

const row = async (id: number) => (await sql<Record<string, unknown>[]>`select * from services where id = ${id}`)[0]!;
const updatedAt = async (id: number) => ((await row(id)).updated_at as Date).getTime();
const logged = async (id: number) =>
  sql<{ metadata: { fields?: string[] } | null }[]>`
    select metadata from activity_logs where action = 'service.updated' and entity_id = ${String(id)} order by id`;

/* The Visual Editor, publishing a service's own page. */
const routeAction = <T>(action: string, args: unknown[]) =>
  actionOf<T>(ROUTE_ACTIONS, "/admin/visual-editor", action, args, owner);
const pageOf = (service: { id: number }) => documentEditorKey({ kind: "service", id: service.id });
const routeKeyOf = (service: { id: number }) => `service:${service.id}`;

/** Drafts `change` into one region of the service's page. */
async function draft(service: { id: number }, type: RouteOwner["type"], change: (values: Values) => Values) {
  const target: RouteOwner = { type, id: service.id };
  const loaded = await routeAction<VisualSectionLoad>("loadRouteRegion", [editorKeyOf(target), pageOf(service)]);
  assert.ok(loaded?.ok, `load ${type}: ${loaded && !loaded.ok ? loaded.message : "no answer"}`);
  const saved = await routeAction<Answer>("saveRouteRegionDraft", [
    formOf(
      {
        sectionId: editorKeyOf(target),
        pageId: pageOf(service),
        expectedRevision: loaded.section.revision,
        values: JSON.stringify(change(loaded.section.values)),
      },
      owner,
    ),
  ]);
  assert.ok(saved?.ok, `draft ${type}: ${saved?.message}`);
}

const reviewToken = async (service: { id: number }) => {
  const view = await routeAction<RouteSummaryView | null>("loadRouteSummary", [routeKeyOf(service)]);
  assert.ok(view, "no summary");
  return view.token;
};
const publishWith = (service: { id: number }, token: string) =>
  routeAction<RouteActionResult>("publishRouteFromEditor", [formOf({ routeKey: routeKeyOf(service), token }, owner)]);
const publish = async (service: { id: number }) => publishWith(service, await reviewToken(service));
const discardAll = async (service: { id: number }) => {
  const token = await reviewToken(service);
  if (token) await routeAction<RouteActionResult>("discardRouteFromEditor", [formOf({ routeKey: routeKeyOf(service), token }, owner)]);
};

const english = (field: string, text: string) => (values: Values) => ({ ...values, [field]: { ...(values[field] as object), en: text } });
const listOf = (field: string, ...texts: string[]) => (values: Values) => ({ ...values, [field]: texts.map((en) => ({ text: { en, ar: "" } })) });
const pathOf = async (id: number) =>
  (await sql<{ path: string }[]>`
    select '/services/' || c.slug || '/' || s.slug as path from services s join service_categories c on c.id = s.category_id where s.id = ${id}`)[0]!
    .path;
const publicPage = async (id: number) => (await fetch(`${server.origin}${await pathOf(id)}`)).text();
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/* -------------------------------------------------------------------------- */

before(async () => {
  assert.ok(isBuilt(), BUILD_HINT);
  database = giveFresh("service_form_concurrency");
  sql = connect(database);
  owner = await signIn(sql);
  // A signed-in account that may look at the admin but not manage services.
  await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    select 'service-viewer@test.invalid', 'Service Viewer', 'unused', id, true from roles where key = 'viewer'`;
  viewer = await signIn(sql, "viewer");
  services = (
    await sql<Service[]>`
      select s.id, s.slug, s.category_id, s.subcategory_id from services s join service_categories c on c.id = s.category_id
       where s.is_published and c.is_published order by c.sort_order, c.id, s.sort_order, s.id limit 15`
  ).map((entry) => ({ ...entry }));
  assert.ok(services.length >= 15, "the fixture has fifteen published services");
  const [withGroup] = await sql<Service[]>`
    select s.id, s.slug, s.category_id, s.subcategory_id from services s join service_categories c on c.id = s.category_id
     where s.is_published and c.is_published and s.subcategory_id is not null
       and s.id <> all(${services.map((entry) => entry.id)}) order by s.id limit 1`;
  assert.ok(withGroup, "the fixture has a published service filed under a group");
  grouped = { ...withGroup };
  server = await startServer(database, PORT);
});

after(async () => {
  await server?.stop();
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
});

/* -------------------------------------------------------------------------- */

describe("the rule, unit by unit (the module itself, under react-server)", () => {
  test("fingerprints ignore what a browser does to an untouched value; the decision is brief §5's table; the base is checked", () => {
    const out = probeValue<{
      crlf: boolean;
      inputBreaks: boolean;
      realEdit: boolean;
      decided: Record<string, { changed: string[]; conflicts: string[]; writes: string[] }>;
      roundTrip: boolean;
      otherService: boolean;
      tampered: boolean;
      garbage: boolean;
      units: string[];
    }>(
      database,
      `
import { decideServiceSave, printsOf, readServiceBase, rowValues, signServiceBase, SERVICE_FORM_UNITS } from "@/lib/services/form-fields";

const row = {
  categoryId: 1, subcategoryId: null, titleEn: "Title", titleAr: "عنوان\\nثان", introEn: "One\\nTwo", introAr: "",
  bodyEn: "<p>Body</p>", bodyAr: "", benefits: [{ en: "A", ar: "" }], audience: [], requirements: [], processSteps: [],
  timelineEn: "", timelineAr: "", notesEn: "", notesAr: "", formPreset: "general", imageId: null,
  isFeatured: false, isPublished: true, sortOrder: 3,
};
const stored = printsOf(rowValues(row));
// What a browser posts for that row, untouched: CRLF in the textarea, the input's line break stripped.
const posted = printsOf(rowValues({ ...row, introEn: "One\\r\\nTwo", titleAr: "عنوانثان" }));
const edited = printsOf(rowValues({ ...row, introEn: "One\\nThree" }));

const all = new Set(SERVICE_FORM_UNITS.map((unit) => unit.key));
const base = { ...stored };
const mineX = { ...stored, introEn: "x-mine" };
const decided = {
  untouched: decideServiceSave(base, base, { ...stored, introEn: "x-live" }, all),
  writeOver: decideServiceSave(base, mineX, base, all),
  sameAlready: decideServiceSave(base, mineX, { ...stored, introEn: "x-mine" }, all),
  conflict: decideServiceSave(base, { ...mineX, timelineEn: "t-mine" }, { ...stored, introEn: "x-live" }, all),
  absent: decideServiceSave(base, mineX, base, new Set([...all].filter((key) => key !== "introEn"))),
};

const token = signServiceBase(7, rowValues(row));
const [payload, signature] = token.split(".");
emit({
  crlf: posted.introEn === stored.introEn,
  inputBreaks: posted.titleAr === stored.titleAr,
  realEdit: edited.introEn !== stored.introEn,
  decided,
  roundTrip: JSON.stringify(readServiceBase(token, 7)) === JSON.stringify(stored),
  otherService: readServiceBase(token, 8) === null,
  tampered: readServiceBase(payload + "." + (signature!.startsWith("A") ? "B" : "A") + signature!.slice(1), 7) === null,
  garbage: readServiceBase("not-a-token", 7) === null && readServiceBase("", 7) === null,
  units: SERVICE_FORM_UNITS.map((unit) => unit.key),
});
process.exit(0);
`,
    );
    assert.ok(out.crlf, "a textarea's CRLF is not an edit");
    assert.ok(out.inputBreaks, "a single-line input's stripped line break is not an edit");
    assert.ok(out.realEdit, "a real edit is one");
    assert.deepEqual(out.decided.untouched, { changed: [], conflicts: [], writes: [] }, "untouched: never written, whatever live holds");
    assert.deepEqual(out.decided.writeOver, { changed: ["introEn"], conflicts: [], writes: ["introEn"] });
    assert.deepEqual(out.decided.sameAlready, { changed: ["introEn"], conflicts: [], writes: [] }, "already so: nothing to write");
    assert.deepEqual(out.decided.conflict, { changed: ["introEn", "timelineEn"], conflicts: ["introEn"], writes: [] }, "any conflict writes nothing");
    assert.deepEqual(out.decided.absent, { changed: [], conflicts: [], writes: [] }, "a field the post does not carry is not a change");
    assert.ok(out.roundTrip && out.otherService && out.tampered && out.garbage, JSON.stringify(out));
    assert.deepEqual(out.units, [
      "placement", "titleEn", "titleAr", "introEn", "introAr", "bodyEn", "bodyAr", "benefits", "audience", "requirements",
      "processSteps", "timelineEn", "timelineAr", "notesEn", "notesAr", "formPreset", "imageId", "isFeatured", "isPublished", "sortOrder",
    ]);
  });
});

describe("the base the page signs", () => {
  test("the edit page renders a base, and an untouched form saves nothing: no write, no log", async () => {
    const service = services[0]!;
    const before = await updatedAt(service.id);
    const opened = await open(service);
    assert.match(String(opened._base), /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const answer = await save(opened);
    assert.equal(answer?.ok, true, answer?.message);
    assert.equal(answer?.message, "No changes to save.");
    assert.equal(await updatedAt(service.id), before);
    assert.equal((await logged(service.id)).length, 0);
  });

  test("no base, another service's base, a tampered base or a garbled one: refused before anything is read, nothing written", async () => {
    const service = services[0]!;
    const opened = await open(service);
    const other = await open(services[1]!);
    const before = JSON.stringify(await row(service.id));
    const [payload, signature] = String(opened._base).split(".");
    const variants: Record<string, string | null> = {
      none: null,
      otherService: String(other._base),
      tampered: `${payload}.${signature!.startsWith("A") ? "B" : "A"}${signature!.slice(1)}`,
      garbled: "garbled",
    };
    for (const [name, base] of Object.entries(variants)) {
      const answer = await save(opened, { _base: base, titleEn: `Should not land (${name})` });
      assert.equal(answer?.ok, false, name);
      assert.match(answer?.message ?? "", /out of date/, name);
      assert.doesNotMatch(answer?.message ?? "", /select|update|insert|postgres|sql|secret/i, `${name}: no internals in the message`);
    }
    assert.equal(JSON.stringify(await row(service.id)), before);
    assert.equal((await logged(service.id)).length, 0);
  });

  test("authentication, authorization and CSRF come first: a stranger, a viewer and a post without the token are refused", async () => {
    const service = services[0]!;
    const opened = await open(service);
    const before = JSON.stringify(await row(service.id));
    const stranger = await callAction<Answer>({
      origin: server.origin,
      route: `/admin/services/${service.id}`,
      file: SERVICE_ACTIONS,
      action: "updateService",
      args: [{ ok: false }, formOf(changedForm(opened, { titleEn: "Stranger" }), owner, owner.csrfToken)],
    });
    assert.notEqual(stranger.value?.ok, true);
    assert.equal((await save(opened, { titleEn: "Viewer" }, viewer))?.ok, false);
    assert.equal((await save(opened, { titleEn: "No token" }, owner, null))?.ok, false);
    assert.equal(JSON.stringify(await row(service.id)), before);
  });
});

describe("brief §5: the Services form against the Visual Editor and the other screens", () => {
  test("A · non-overlapping: the editor publishes X, the stale form changes Y — X keeps the editor's, Y is the form's", async () => {
    const service = services[1]!;
    const opened = await open(service);
    await draft(service, "serviceHero", english("intro", "A · intro from the editor"));
    assert.ok((await publish(service))?.ok);
    const answer = await save(opened, { timelineEn: "A · timeline from the form" });
    assert.equal(answer?.ok, true, answer?.message);
    const after = await row(service.id);
    assert.equal(after.intro_en, "A · intro from the editor");
    assert.equal(after.timeline_en, "A · timeline from the form");
    const page = await publicPage(service.id);
    assert.ok(page.includes("A · intro from the editor") && page.includes("A · timeline from the form"), "the page shows both at once");
  });

  test("B · overlapping: the editor publishes X, the stale form changes X (and Y) — refused, X stays the editor's, nothing else is written", async () => {
    const service = services[2]!;
    const opened = await open(service);
    await draft(service, "serviceHero", english("intro", "B · intro from the editor"));
    assert.ok((await publish(service))?.ok);
    const stamped = await updatedAt(service.id);
    const logs = (await logged(service.id)).length;
    const answer = await save(opened, { introEn: "B · intro from the form", timelineEn: "B · timeline from the form" });
    assert.equal(answer?.ok, false);
    assert.deepEqual(answer?.conflicts, ["introEn"]);
    assert.match(answer?.message ?? "", /Short introduction \(English\) was changed elsewhere/);
    assert.match(answer?.message ?? "", /nothing was saved/);
    const after = await row(service.id);
    assert.equal(after.intro_en, "B · intro from the editor");
    assert.notEqual(after.timeline_en, "B · timeline from the form", "the timeline, which merged cleanly, was not written either");
    assert.equal(await updatedAt(service.id), stamped, "no partial write: the row was not touched");
    assert.equal((await logged(service.id)).length, logs, "a refused save logs nothing");
    assert.ok(!(await publicPage(service.id)).includes("B · intro from the form"));
  });

  test("C · reverse order: the form lands first; a draft begun before it conflicts only on the field the form changed", async () => {
    const service = services[3]!;
    await draft(service, "serviceHero", english("intro", "C · drafted intro"));
    const saved = await save(await open(service), { introEn: "C · form intro" });
    assert.equal(saved?.ok, true, saved?.message);
    const refused = await publish(service);
    assert.equal(refused?.ok, false);
    assert.equal(refused && !refused.ok ? refused.reason : "", "conflict");
    assert.equal((await row(service.id)).intro_en, "C · form intro", "the editor wrote nothing over the form");
    await discardAll(service);

    // A draft of another field publishes over a form save of this one: both stay.
    await draft(service, "serviceHero", english("timeline", "C · drafted timeline"));
    assert.equal((await save(await open(service), { introEn: "C · second form intro" }))?.ok, true);
    assert.ok((await publish(service))?.ok);
    const after = await row(service.id);
    assert.equal(after.intro_en, "C · second form intro");
    assert.equal(after.timeline_en, "C · drafted timeline");
  });

  test("D · category move: a stale form saving another field never moves the service back; one that changed the group conflicts", async () => {
    const service = grouped;
    const [target] = await sql<{ id: number }[]>`
      select c.id from service_categories c
       where c.id <> ${service.category_id}
         and not exists (select 1 from services s where s.category_id = c.id and s.slug = ${service.slug})
       order by c.sort_order, c.id limit 1`;
    const stale = await open(service);
    const moved = await save(await open(service), { categoryId: target!.id, subcategoryId: "" });
    assert.equal(moved?.ok, true, moved?.message);
    assert.equal(Number((await row(service.id)).category_id), target!.id);

    const other = await save(stale, { timelineEn: "D · timeline from the stale form" });
    assert.equal(other?.ok, true, other?.message);
    let after = await row(service.id);
    assert.equal(Number(after.category_id), target!.id, "not moved back");
    assert.equal(after.timeline_en, "D · timeline from the stale form");

    // The stale form's own placement change — out of its group — meets the move: one unit, a conflict.
    const regroup = await save(stale, { subcategoryId: "" });
    assert.equal(regroup?.ok, false);
    assert.deepEqual(regroup?.conflicts, ["placement"]);
    assert.match(regroup?.message ?? "", /Category and group was changed elsewhere/);
    after = await row(service.id);
    assert.equal(Number(after.category_id), target!.id);
    assert.equal(after.subcategory_id, null);

    // Home again, from a fresh form.
    const back = await save(await open(service), { categoryId: service.category_id, subcategoryId: service.subcategory_id ?? "" });
    assert.equal(back?.ok, true, back?.message);
  });

  test("D · a move into a category that already uses the address is refused with nothing written", async () => {
    const service = services[4]!;
    const [clash] = await sql<{ category_id: number; slug: string }[]>`
      select category_id, slug from services where category_id <> ${service.category_id} order by id limit 1`;
    await sql`update services set slug = ${clash!.slug} where id = ${service.id}`;
    try {
      const before = JSON.stringify(await row(service.id));
      const answer = await save(await open(service), { categoryId: clash!.category_id, subcategoryId: "" });
      assert.equal(answer?.ok, false);
      assert.match(answer?.message ?? "", /already uses this address/);
      assert.equal(JSON.stringify(await row(service.id)), before);
    } finally {
      await sql`update services set slug = ${service.slug} where id = ${service.id}`;
    }
  });

  test("E · media: the picture changed in the editor survives a stale form that changed something else", async () => {
    const service = services[5]!;
    const [picture] = await sql<{ id: number }[]>`
      insert into media (filename, mime_type, title, width, height) values ('b23-picture.webp', 'image/webp', 'B23 picture', 800, 600) returning id`;
    const opened = await open(service);
    await draft(service, "serviceHero", (values) => ({ ...values, image: picture!.id }));
    assert.ok((await publish(service))?.ok);
    assert.equal(Number((await row(service.id)).image_id), picture!.id);
    const answer = await save(opened, { introEn: "E · intro from the stale form" });
    assert.equal(answer?.ok, true, answer?.message);
    const after = await row(service.id);
    assert.equal(Number(after.image_id), picture!.id, "the newer picture stays");
    assert.equal(after.intro_en, "E · intro from the stale form");

    // The stale form choosing a picture of its own meets the editor's: a conflict.
    const [another] = await sql<{ id: number }[]>`
      insert into media (filename, mime_type, title, width, height) values ('b23-another.webp', 'image/webp', 'B23 another', 800, 600) returning id`;
    const clash = await save(opened, { imageId: another!.id });
    assert.equal(clash?.ok, false);
    assert.deepEqual(clash?.conflicts, ["imageId"]);
    assert.equal(Number((await row(service.id)).image_id), picture!.id);
  });

  test("F · publication state: unpublished from the list, a stale ordinary edit does not publish it again", async () => {
    const service = services[6]!;
    const opened = await open(service);
    assert.equal((await row(service.id)).is_published, true);
    const toggled = await actionOf<Answer>(
      SERVICE_ACTIONS,
      "/admin/services",
      "toggleServicePublished",
      [{ ok: false }, formOf({ id: service.id }, owner)],
      owner,
    );
    assert.equal(toggled?.ok, true);
    const answer = await save(opened, { timelineEn: "F · timeline from the stale form", isFeatured: "on" });
    assert.equal(answer?.ok, true, answer?.message);
    const after = await row(service.id);
    assert.equal(after.is_published, false, "still unpublished");
    assert.equal(after.is_featured, true, "the form's own visibility change landed");
    assert.equal(after.timeline_en, "F · timeline from the stale form");
    // Ticking the same box the other way from the stale base is the same change: nothing to write.
    assert.equal((await save(opened, { isPublished: null, timelineEn: "F · timeline from the stale form", isFeatured: "on" }))?.ok, true);
    assert.equal((await row(service.id)).is_published, false);
    await sql`update services set is_published = true where id = ${service.id}`;
  });

  test("G · lists: a newer list survives a stale form editing another; two edits of one list conflict whole", async () => {
    const service = services[7]!;
    const opened = await open(service);
    await draft(service, "serviceBenefits", listOf("benefits", "G · benefit from the editor"));
    assert.ok((await publish(service))?.ok);
    const answer = await save(opened, { audience: JSON.stringify([{ en: "G · audience from the form", ar: "" }]) });
    assert.equal(answer?.ok, true, answer?.message);
    let after = await row(service.id);
    assert.deepEqual(after.benefits, [{ en: "G · benefit from the editor", ar: "" }]);
    assert.deepEqual(after.audience, [{ en: "G · audience from the form", ar: "" }]);

    const clash = await save(opened, { benefits: JSON.stringify([{ en: "G · benefit from the form", ar: "" }]) });
    assert.equal(clash?.ok, false);
    assert.deepEqual(clash?.conflicts, ["benefits"]);
    assert.match(clash?.message ?? "", /Key benefits was changed elsewhere/);
    after = await row(service.id);
    assert.deepEqual(after.benefits, [{ en: "G · benefit from the editor", ar: "" }]);
  });

  test("two admins: each form's own field lands, and the field both changed is refused for the second", async () => {
    const service = services[8]!;
    const first = await open(service);
    const second = await open(service);
    assert.equal((await save(first, { titleAr: "عنوان من المسؤول الأول", introEn: "Two admins · first" }))?.ok, true);
    assert.equal((await save(second, { titleEn: "Two admins · English title" }))?.ok, true);
    const refused = await save(second, { introEn: "Two admins · second" });
    assert.equal(refused?.ok, false);
    assert.deepEqual(refused?.conflicts, ["introEn"]);
    const after = await row(service.id);
    assert.equal(after.title_ar, "عنوان من المسؤول الأول");
    assert.equal(after.title_en, "Two admins · English title");
    assert.equal(after.intro_en, "Two admins · first");
  });
});

describe("one transaction, held on the row", () => {
  test("stale forms changing different fields at the same instant all land", async () => {
    const service = services[9]!;
    for (let round = 0; round < 5; round += 1) {
      const forms = await Promise.all([open(service), open(service), open(service)]);
      const answers = await Promise.all([
        save(forms[0]!, { introEn: `Parallel intro ${round}` }),
        save(forms[1]!, { timelineEn: `Parallel timeline ${round}` }),
        save(forms[2]!, { notesEn: `<p>Parallel notes ${round}</p>` }),
      ]);
      assert.deepEqual(answers.map((answer) => answer?.ok), [true, true, true], JSON.stringify(answers));
      const after = await row(service.id);
      assert.equal(after.intro_en, `Parallel intro ${round}`);
      assert.equal(after.timeline_en, `Parallel timeline ${round}`);
      assert.equal(after.notes_en, `<p>Parallel notes ${round}</p>`);
    }
  });

  test("forms changing the same field from the same base at the same instant: exactly one lands", async () => {
    const service = services[9]!;
    for (let round = 0; round < 5; round += 1) {
      const forms = await Promise.all(Array.from({ length: 4 }, () => open(service)));
      const answers = await Promise.all(forms.map((form, i) => save(form, { titleEn: `Race ${round} writer ${i}` })));
      const winners = answers.map((answer, i) => (answer?.ok ? i : -1)).filter((i) => i >= 0);
      assert.equal(winners.length, 1, JSON.stringify(answers));
      assert.ok(answers.every((answer) => answer?.ok || (answer?.conflicts ?? []).join() === "titleEn"));
      assert.equal((await row(service.id)).title_en, `Race ${round} writer ${winners[0]}`);
    }
  });

  test("a form save and a publication of different fields at the same instant both land, in either order", async () => {
    const service = services[10]!;
    for (let round = 0; round < 6; round += 1) {
      await draft(service, "serviceHero", english("timeline", `Order ${round} · editor timeline`));
      const token = await reviewToken(service);
      const opened = await open(service);
      const [published, saved] = await Promise.all([
        wait(round % 2 ? 20 : 0).then(() => publishWith(service, token)),
        wait(round % 2 ? 0 : 20).then(() => save(opened, { introEn: `Order ${round} · form intro` })),
      ]);
      assert.equal(published?.ok, true, JSON.stringify(published));
      assert.equal(saved?.ok, true, saved?.message);
      const after = await row(service.id);
      assert.equal(after.timeline_en, `Order ${round} · editor timeline`);
      assert.equal(after.intro_en, `Order ${round} · form intro`);
    }
  });

  test("…of the same field: exactly one wins; the loser writes nothing (the editor keeps its draft)", async () => {
    const service = services[11]!;
    let editorWon = 0;
    let formWon = 0;
    for (let round = 0; round < 6; round += 1) {
      await draft(service, "serviceHero", english("intro", `Same ${round} · editor`));
      const token = await reviewToken(service);
      const opened = await open(service);
      const [published, saved] = await Promise.all([
        wait(round % 2 ? 20 : 0).then(() => publishWith(service, token)),
        wait(round % 2 ? 0 : 20).then(() => save(opened, { introEn: `Same ${round} · form`, timelineEn: `Same ${round} · form timeline` })),
      ]);
      const live = await row(service.id);
      if (published?.ok) {
        editorWon += 1;
        assert.equal(saved?.ok, false);
        assert.deepEqual(saved?.conflicts, ["introEn"]);
        assert.equal(live.intro_en, `Same ${round} · editor`);
        assert.notEqual(live.timeline_en, `Same ${round} · form timeline`, "the refused form wrote nothing");
      } else {
        formWon += 1;
        assert.equal(saved?.ok, true, saved?.message);
        assert.equal(published && !published.ok ? published.reason : "", "conflict");
        assert.equal(live.intro_en, `Same ${round} · form`);
        await discardAll(service);
      }
    }
    assert.equal(editorWon + formWon, 6);
  });
});

describe("the editor's half: a Visual Editor buffer opened before a Services save", () => {
  /** The hero region as the editor loads it into its buffer. */
  const loadHero = async (service: { id: number }) => {
    const target: RouteOwner = { type: "serviceHero", id: service.id };
    const loaded = await routeAction<VisualSectionLoad>("loadRouteRegion", [editorKeyOf(target), pageOf(service)]);
    assert.ok(loaded?.ok);
    return loaded.section;
  };
  /** Saved from that buffer the way the editor saves: the values, and the values it began from. */
  const saveFromBuffer = (service: { id: number }, buffer: { revision: number; values: Values }, values: Values) =>
    routeAction<Answer & { section?: { route?: { conflicts: { key: string }[] } } }>("saveRouteRegionDraft", [
      formOf(
        {
          sectionId: editorKeyOf({ type: "serviceHero", id: service.id }),
          pageId: pageOf(service),
          expectedRevision: buffer.revision,
          values: JSON.stringify(values),
          baseValues: JSON.stringify(buffer.values),
        },
        owner,
      ),
    ]);

  test("a field the editor did not touch is never put back from its buffer: the Services save stays", async () => {
    const service = services[12]!;
    const buffer = await loadHero(service);
    assert.equal((await save(await open(service), { introEn: "Buffer · intro from the form" }))?.ok, true);
    const saved = await saveFromBuffer(service, buffer, english("timeline", "Buffer · timeline from the editor")(buffer.values));
    assert.equal(saved?.ok, true, saved?.message);
    assert.ok((await publish(service))?.ok);
    const after = await row(service.id);
    assert.equal(after.intro_en, "Buffer · intro from the form", "the form's introduction was not put back");
    assert.equal(after.timeline_en, "Buffer · timeline from the editor");
  });

  test("a field the editor did change in that buffer is a conflict at publication, not an overwrite", async () => {
    const service = services[13]!;
    const buffer = await loadHero(service);
    assert.equal((await save(await open(service), { introEn: "Buffer · newer intro from the form" }))?.ok, true);
    const saved = await saveFromBuffer(service, buffer, english("intro", "Buffer · intro typed in the stale editor")(buffer.values));
    assert.equal(saved?.ok, true, saved?.message);
    const refused = await publish(service);
    assert.equal(refused?.ok, false);
    assert.equal(refused && !refused.ok ? refused.reason : "", "conflict");
    assert.equal((await row(service.id)).intro_en, "Buffer · newer intro from the form");
    const loaded = await routeAction<VisualSectionLoad>("loadRouteRegion", [editorKeyOf({ type: "serviceHero", id: service.id }), pageOf(service)]);
    assert.ok(loaded?.ok && loaded.section.route?.conflicts.some((conflict) => conflict.key === "introEn"), "the Inspector is told which field");
    await discardAll(service);
  });

  test("a fresh buffer is unchanged by this: a column stored unnormalised makes no false conflict", async () => {
    const service = services[14]!;
    await sql`update services set intro_en = ${"  Spaced intro, stored untrimmed  "} where id = ${service.id}`;
    const buffer = await loadHero(service);
    const saved = await saveFromBuffer(service, buffer, english("intro", "Clean intro from the editor")(buffer.values));
    assert.equal(saved?.ok, true, saved?.message);
    const published = await publish(service);
    assert.equal(published?.ok, true, JSON.stringify(published));
    assert.equal((await row(service.id)).intro_en, "Clean intro from the editor");
  });
});

describe("what a save leaves behind", () => {
  test("a written save logs one service.updated naming exactly the fields written, and the public page shows it at once", async () => {
    const service = services[0]!;
    const before = (await logged(service.id)).length;
    const answer = await save(await open(service), { titleEn: "Logged title", sortOrder: 41 });
    assert.equal(answer?.ok, true, answer?.message);
    const entries = await logged(service.id);
    assert.equal(entries.length, before + 1);
    assert.deepEqual(entries.at(-1)!.metadata?.fields, ["titleEn", "sortOrder"]);
    assert.ok((await publicPage(service.id)).includes("Logged title"), "the catalogue cache was dropped after the commit");
  });

  test("an untouched textarea posted with CRLF line endings, and an input that lost a stored line break, are not edits", async () => {
    const service = services[1]!;
    await sql`update services set intro_en = ${"Line one\nLine two"}, title_ar = ${"سطر\nثان"} where id = ${service.id}`;
    const opened = await open(service);
    const stamped = await updatedAt(service.id);
    const answer = await save(opened, { introEn: "Line one\r\nLine two", titleAr: "سطرثان" });
    assert.equal(answer?.message, "No changes to save.");
    assert.equal(await updatedAt(service.id), stamped);
  });
});
