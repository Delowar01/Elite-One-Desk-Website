/**
 * Batch 24 · the Packages and Destinations forms against everything else that
 * writes a package or a destination.
 *
 * Both forms used to write every column they held, so a form opened before
 * somebody else's change put the older values back when it was saved — and
 * Batch 24 is what made "somebody else" the Visual Editor: a package's own
 * page, its card on Tour packages, a destination's page and its group there.
 * Now each form posts the signed base its page drew it with, and the server
 * writes only what the form changed — refusing, whole and with nothing
 * written, a change to a field that also moved elsewhere
 * (docs/admin/services-form-concurrency.md §10).
 *
 * Everything here runs against the real server and a real PostgreSQL: the
 * forms are posted as a browser posts them (their fields and the `_base` the
 * page rendered), and "elsewhere" is the real Visual Editor publishing and a
 * second admin's real form. The races run real transactions, and the last one
 * holds the lock order: a form that re-files a package while the catalogue
 * publishes can never deadlock.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { callAction } from "./helpers/action";
import { giveFresh } from "./helpers/fixtures";
import { openDestinationForm, openPackageForm, withChanges, type FormFields } from "./helpers/package-form";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { probeValue } from "./helpers/probe";
import { BUILD_HINT, isBuilt, startServer, type Server } from "./helpers/server";
import { signIn, type TestSession } from "./helpers/session";

import { documentEditorKey, editorKeyOf, type RouteDocument, type RouteOwner } from "@/lib/routes/owners";
import type { RouteActionResult, RouteSummaryView } from "@/lib/routes/views";
import type { VisualSectionLoad } from "@/lib/visual-editor/content";

const PORT = 3511;
const ROUTE_ACTIONS = "app/(backoffice)/admin/visual-editor/route-actions.ts";
const PACKAGE_ACTIONS = "app/(backoffice)/admin/(shell)/packages/actions.ts";
const DESTINATION_ACTIONS = "app/(backoffice)/admin/(shell)/packages/destinations/actions.ts";
const CATALOGUE: RouteDocument = { kind: "packageIndex", id: 1 };

let database = "";
let sql: Sql;
let server: Server;
let owner: TestSession;
let viewer: TestSession;

type Pkg = { id: number; slug: string; destination_id: number | null };
let packages: Pkg[] = [];
let home = 0;
let spare = 0;
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

const openPackage = (id: number) => openPackageForm(sql, server.origin, owner.cookie, id);
const openDestination = (id: number) => openDestinationForm(sql, server.origin, owner.cookie, id);

const savePackage = (opened: FormFields, changes: Record<string, string | number | null> = {}, session = owner, csrf?: string | null) =>
  actionOf<Answer>(
    PACKAGE_ACTIONS,
    `/admin/packages/${opened.id}`,
    "updatePackage",
    [{ ok: false }, formOf(withChanges(opened, changes), session, csrf === undefined ? session.csrfToken : csrf)],
    session,
  );

const saveDestination = (opened: FormFields, changes: Record<string, string | number | null> = {}, session = owner) =>
  actionOf<Answer>(
    DESTINATION_ACTIONS,
    `/admin/packages/destinations/${opened.id}`,
    "updateDestination",
    [{ ok: false }, formOf(withChanges(opened, changes), session)],
    session,
  );

const packageRow = async (id: number) => (await sql<Record<string, unknown>[]>`select * from travel_packages where id = ${id}`)[0]!;
const destinationRow = async (id: number) => (await sql<Record<string, unknown>[]>`select * from package_destinations where id = ${id}`)[0]!;
const stampOf = async (id: number) => ((await packageRow(id)).updated_at as Date).getTime();
const loggedFor = async (action: string, id: number) =>
  sql<{ metadata: { fields?: string[] } | null }[]>`
    select metadata from activity_logs where action = ${action} and entity_id = ${String(id)} order by id`;

/* The Visual Editor: a package's page, a destination's page, the catalogue. */
const routeAction = <T>(action: string, args: unknown[]) => actionOf<T>(ROUTE_ACTIONS, "/admin/visual-editor", action, args, owner);
const routeKey = (doc: RouteDocument) => `${doc.kind}:${doc.id}`;

async function draft(doc: RouteDocument, target: RouteOwner, change: (values: Values) => Values) {
  const loaded = await routeAction<VisualSectionLoad>("loadRouteRegion", [editorKeyOf(target), documentEditorKey(doc)]);
  assert.ok(loaded?.ok, `load ${target.type}: ${loaded && !loaded.ok ? loaded.message : "no answer"}`);
  const saved = await routeAction<Answer>("saveRouteRegionDraft", [
    formOf(
      { sectionId: editorKeyOf(target), pageId: documentEditorKey(doc), expectedRevision: loaded.section.revision, values: JSON.stringify(change(loaded.section.values)) },
      owner,
    ),
  ]);
  assert.ok(saved?.ok, `draft ${target.type}: ${saved?.message}`);
}

const reviewToken = async (doc: RouteDocument) => {
  const view = await routeAction<RouteSummaryView | null>("loadRouteSummary", [routeKey(doc)]);
  assert.ok(view, "no summary");
  return view.token;
};
const publish = async (doc: RouteDocument) =>
  routeAction<RouteActionResult>("publishRouteFromEditor", [formOf({ routeKey: routeKey(doc), token: await reviewToken(doc) }, owner)]);
const discardAll = async (doc: RouteDocument) => {
  const token = await reviewToken(doc);
  if (token) await routeAction<RouteActionResult>("discardRouteFromEditor", [formOf({ routeKey: routeKey(doc), token }, owner)]);
};

const english = (field: string, text: string) => (values: Values) => ({ ...values, [field]: { ...(values[field] as object), en: text } });
const asPackage = (id: number): RouteDocument => ({ kind: "package", id });
const asDestination = (id: number): RouteDocument => ({ kind: "destination", id });

/* -------------------------------------------------------------------------- */

before(async () => {
  assert.ok(isBuilt(), BUILD_HINT);
  database = giveFresh("package_form_concurrency");
  sql = connect(database);
  owner = await signIn(sql);
  await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    select 'package-viewer@test.invalid', 'Package Viewer', 'unused', id, true from roles where key = 'viewer'`;
  viewer = await signIn(sql, "viewer");
  packages = (await sql<Pkg[]>`select id, slug, destination_id from travel_packages where is_published order by sort_order, id`).map((row) => ({ ...row }));
  assert.ok(packages.length >= 4, "the fixture has four published packages");
  const [filed] = await sql<{ id: number }[]>`
    select d.id from package_destinations d where d.is_published
       and exists (select 1 from travel_packages p where p.destination_id = d.id and p.is_published)
     order by d.sort_order, d.id limit 1`;
  assert.ok(filed, "the fixture has a destination holding a package");
  home = filed.id;
  const [made] = await sql<{ id: number }[]>`
    insert into package_destinations (slug, title_en, sort_order, is_published)
    values ('a-spare-destination-for-the-forms', 'Spare For The Forms', 40, true) returning id`;
  spare = made!.id;
  server = await startServer(database, PORT);
});

after(async () => {
  await server?.stop();
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
});

/* -------------------------------------------------------------------------- */

describe("the rule, unit by unit (the modules themselves, under react-server)", () => {
  test("fingerprints ignore what a browser does to an untouched value; each form's base is its own", () => {
    const out = probeValue<{
      crlf: boolean;
      realEdit: boolean;
      roundTrip: boolean;
      otherPackage: boolean;
      notADestinationBase: boolean;
      notAServiceBase: boolean;
      notAPackageBase: boolean;
      packageUnits: string[];
      destinationUnits: string[];
      decided: { changed: string[]; conflicts: string[]; writes: string[] };
    }>(
      database,
      `
import { DESTINATION_FORM, destinationRowValues, PACKAGE_FORM, packageRowValues } from "@/lib/packages/form-fields";
import { readServiceBase, rowValues, signServiceBase } from "@/lib/services/form-fields";

const pkg = {
  region: "international", destinationId: 3, titleEn: "Title", titleAr: "", destinationEn: "Place", destinationAr: "",
  durationEn: "", durationAr: "", summaryEn: "One\\nTwo", summaryAr: "", bodyEn: "<p>Body</p>", bodyAr: "",
  highlights: [{ en: "A", ar: "" }], imageId: null, isFeatured: false, isPublished: true, sortOrder: 2,
};
const stored = PACKAGE_FORM.printsOf(packageRowValues(pkg));
const posted = PACKAGE_FORM.printsOf(packageRowValues({ ...pkg, summaryEn: "One\\r\\nTwo" }));
const edited = PACKAGE_FORM.printsOf(packageRowValues({ ...pkg, summaryEn: "One\\nThree" }));
const token = PACKAGE_FORM.signBase(7, packageRowValues(pkg));
const destination = { slug: "somewhere", titleEn: "Somewhere", titleAr: "", summaryEn: "", summaryAr: "", imageId: null, isPublished: true, sortOrder: 0 };
const destinationToken = DESTINATION_FORM.signBase(7, destinationRowValues(destination));
const serviceToken = signServiceBase(7, rowValues({
  categoryId: 1, subcategoryId: null, titleEn: "T", titleAr: "", introEn: "", introAr: "", bodyEn: "", bodyAr: "",
  benefits: [], audience: [], requirements: [], processSteps: [], timelineEn: "", timelineAr: "", notesEn: "", notesAr: "",
  formPreset: "general", imageId: null, isFeatured: false, isPublished: true, sortOrder: 0,
}));
const all = new Set(PACKAGE_FORM.units.map((unit) => unit.key));
emit({
  crlf: posted.summaryEn === stored.summaryEn,
  realEdit: edited.summaryEn !== stored.summaryEn,
  roundTrip: JSON.stringify(PACKAGE_FORM.readBase(token, 7)) === JSON.stringify(stored),
  otherPackage: PACKAGE_FORM.readBase(token, 8) === null,
  notADestinationBase: DESTINATION_FORM.readBase(token, 7) === null,
  notAServiceBase: readServiceBase(token, 7) === null,
  notAPackageBase: PACKAGE_FORM.readBase(destinationToken, 7) === null && PACKAGE_FORM.readBase(serviceToken, 7) === null,
  packageUnits: PACKAGE_FORM.units.map((unit) => unit.key),
  destinationUnits: DESTINATION_FORM.units.map((unit) => unit.key),
  decided: PACKAGE_FORM.decide(stored, { ...stored, summaryEn: "mine", durationEn: "mine" }, { ...stored, summaryEn: "live" }, all),
});
process.exit(0);
`,
    );
    assert.ok(out.crlf, "a textarea's CRLF is not an edit");
    assert.ok(out.realEdit);
    assert.ok(out.roundTrip && out.otherPackage, "a base is for one package");
    assert.ok(out.notADestinationBase && out.notAServiceBase && out.notAPackageBase, "a base is for one form");
    assert.deepEqual(out.packageUnits, [
      "destinationId", "region", "titleEn", "titleAr", "destinationEn", "destinationAr", "durationEn", "durationAr",
      "summaryEn", "summaryAr", "bodyEn", "bodyAr", "highlights", "imageId", "isFeatured", "isPublished", "sortOrder",
    ]);
    assert.equal(out.packageUnits.includes("slug"), false, "a package's address is fixed: not a unit");
    assert.deepEqual(out.destinationUnits, ["slug", "titleEn", "titleAr", "summaryEn", "summaryAr", "imageId", "isPublished", "sortOrder"]);
    assert.deepEqual(out.decided, { changed: ["durationEn", "summaryEn"], conflicts: ["summaryEn"], writes: [] }, "any conflict writes nothing");
  });
});

describe("the base the page signs", () => {
  test("both edit pages render a base, and an untouched form saves nothing: no write, no log", async () => {
    const id = packages[0]!.id;
    const before = await stampOf(id);
    const opened = await openPackage(id);
    assert.match(String(opened._base), /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    const answer = await savePackage(opened);
    assert.equal(answer?.ok, true, answer?.message);
    assert.equal(answer?.message, "No changes to save.");
    assert.equal(await stampOf(id), before);
    assert.equal((await loggedFor("package.updated", id)).length, 0);
    const destination = await openDestination(home);
    assert.equal((await saveDestination(destination))?.message, "No changes to save.");
    assert.equal((await loggedFor("destination.updated", home)).length, 0);
  });

  test("no base, another package's base, a tampered base or a garbled one: refused before anything is read", async () => {
    const id = packages[0]!.id;
    const opened = await openPackage(id);
    const other = await openPackage(packages[1]!.id);
    const before = JSON.stringify(await packageRow(id));
    const [payload, signature] = String(opened._base).split(".");
    for (const [name, base] of Object.entries({
      none: null,
      otherPackage: String(other._base),
      destinationBase: String((await openDestination(home))._base),
      tampered: `${payload}.${signature!.startsWith("A") ? "B" : "A"}${signature!.slice(1)}`,
      garbled: "garbled",
    })) {
      const answer = await savePackage(opened, { _base: base, titleEn: `Should not land (${name})` });
      assert.equal(answer?.ok, false, name);
      assert.match(answer?.message ?? "", /out of date/, name);
      assert.doesNotMatch(answer?.message ?? "", /select|update|insert|postgres|sql|secret/i, `${name}: no internals in the message`);
    }
    assert.equal(JSON.stringify(await packageRow(id)), before);
  });

  test("a viewer and a post without the session's token are refused", async () => {
    const id = packages[0]!.id;
    const opened = await openPackage(id);
    const before = JSON.stringify(await packageRow(id));
    assert.equal((await savePackage(opened, { titleEn: "Viewer" }, viewer))?.ok, false);
    assert.equal((await savePackage(opened, { titleEn: "No token" }, owner, null))?.ok, false);
    assert.equal(JSON.stringify(await packageRow(id)), before);
  });
});

describe("the Packages form against the Visual Editor", () => {
  test("non-overlapping: the editor publishes the title, the stale form changes the summary — both stand", async () => {
    const id = packages[1]!.id;
    const opened = await openPackage(id);
    await draft(asPackage(id), { type: "packageHero", id }, english("title", "Title from the editor"));
    assert.ok((await publish(asPackage(id)))?.ok);
    const answer = await savePackage(opened, { summaryEn: "Summary from the form" });
    assert.equal(answer?.ok, true, answer?.message);
    const row = await packageRow(id);
    assert.equal(row.title_en, "Title from the editor");
    assert.equal(row.summary_en, "Summary from the form");
    const [logged] = (await loggedFor("package.updated", id)).slice(-1);
    assert.deepEqual(logged!.metadata?.fields, ["summaryEn"], "the log names what was written, and only that");
  });

  test("overlapping: the editor publishes the summary, the stale form changes it (and more) — refused whole, nothing written", async () => {
    const id = packages[2]!.id;
    const opened = await openPackage(id);
    await draft(asPackage(id), { type: "packageHero", id }, english("summary", "Summary from the editor"));
    assert.ok((await publish(asPackage(id)))?.ok);
    const stamped = await stampOf(id);
    const logs = (await loggedFor("package.updated", id)).length;
    const answer = await savePackage(opened, { summaryEn: "Summary from the form", durationEn: "Duration from the form" });
    assert.equal(answer?.ok, false);
    assert.deepEqual(answer?.conflicts, ["summaryEn"]);
    assert.match(answer?.message ?? "", /Summary \(English\) was changed elsewhere/);
    assert.match(answer?.message ?? "", /nothing was saved/);
    assert.equal((await packageRow(id)).summary_en, "Summary from the editor");
    assert.notEqual((await packageRow(id)).duration_en, "Duration from the form");
    assert.equal(await stampOf(id), stamped);
    assert.equal((await loggedFor("package.updated", id)).length, logs);
  });

  test("reverse order: the form lands first; a draft begun before it conflicts only on the field the form changed", async () => {
    const id = packages[3]!.id;
    const highlightsBefore = (await packageRow(id)).highlights;
    await draft(asPackage(id), { type: "packageHero", id }, english("summary", "Drafted summary"));
    await draft(asPackage(id), { type: "packageHighlights", id }, (values) => ({ ...values, highlights: [{ text: { en: "Drafted highlight", ar: "" } }] }));
    const saved = await savePackage(await openPackage(id), { summaryEn: "Form summary" });
    assert.equal(saved?.ok, true, saved?.message);
    const refused = await publish(asPackage(id));
    assert.equal(refused && !refused.ok ? refused.reason : "", "conflict");
    assert.equal((await packageRow(id)).summary_en, "Form summary", "the editor wrote nothing over the form");
    assert.deepEqual((await packageRow(id)).highlights, highlightsBefore, "nor anything else of its draft: a publication is whole");
    await discardAll(asPackage(id));
  });

  test("English and Arabic are separate: an Arabic form edit and an English publication both survive", async () => {
    const id = packages[1]!.id;
    const opened = await openPackage(id);
    await draft(asPackage(id), { type: "packageHero", id }, english("duration", "Five nights"));
    assert.ok((await publish(asPackage(id)))?.ok);
    assert.ok((await savePackage(opened, { durationAr: "خمس ليال" }))?.ok);
    const row = await packageRow(id);
    assert.equal(row.duration_en, "Five nights");
    assert.equal(row.duration_ar, "خمس ليال");
  });

  test("the highlights are one list: a stale form keeps the newer list, and an edit of the same list conflicts", async () => {
    const id = packages[2]!.id;
    const opened = await openPackage(id);
    await draft(asPackage(id), { type: "packageHighlights", id }, (values) => ({ ...values, highlights: [{ text: { en: "Published highlight", ar: "" } }] }));
    assert.ok((await publish(asPackage(id)))?.ok);
    assert.ok((await savePackage(opened, { durationEn: "Kept apart" }))?.ok);
    assert.deepEqual((await packageRow(id)).highlights, [{ en: "Published highlight", ar: "" }]);
    const refused = await savePackage(opened, { highlights: JSON.stringify([{ en: "Stale list", ar: "" }]) });
    assert.deepEqual(refused?.conflicts, ["highlights"]);
  });

  test("a stale form never puts back a picture, a destination, a featured flag or a visibility changed on the catalogue", async () => {
    const id = packages[0]!.id;
    const opened = await openPackage(id);
    const [picture] = await sql<{ id: number }[]>`select id from media order by id limit 1`;
    assert.ok(picture, "the fixture's library holds a picture");
    await draft(CATALOGUE, { type: "packageCard", id }, (values) => ({
      ...values,
      image: picture.id,
      group: String(spare),
      featured: !values.featured,
      published: false,
    }));
    assert.ok((await publish(CATALOGUE))?.ok);
    const moved = await packageRow(id);
    assert.equal(moved.destination_id, spare);
    assert.equal(moved.is_published, false);
    const answer = await savePackage(opened, { titleAr: "عنوان من النموذج" });
    assert.ok(answer?.ok, answer?.message);
    const row = await packageRow(id);
    assert.equal(row.image_id, picture.id);
    assert.equal(row.destination_id, spare);
    assert.equal(row.is_featured, moved.is_featured);
    assert.equal(row.is_published, false);
    assert.equal(row.title_ar, "عنوان من النموذج");
    // A stale form that re-files it too, the other way, meets the move.
    const refused = await savePackage(opened, { destinationId: "" });
    assert.deepEqual(refused?.conflicts, ["destinationId"]);
    // Put back, on the catalogue, for the cases after this one.
    await draft(CATALOGUE, { type: "packageCard", id }, (values) => ({ ...values, group: String(home), published: true }));
    assert.ok((await publish(CATALOGUE))?.ok);
  });

  test("a destination that no longer exists is refused by name, and nothing is written", async () => {
    const id = packages[1]!.id;
    const before = JSON.stringify(await packageRow(id));
    const answer = await savePackage(await openPackage(id), { destinationId: 987654 });
    assert.equal(answer?.ok, false);
    assert.match(answer?.message ?? "", /Choose one of the destinations/);
    assert.equal(JSON.stringify(await packageRow(id)), before);
  });
});

describe("the Destinations form against the Visual Editor", () => {
  test("a stale form keeps the editor's newer name and never moves the address back", async () => {
    const opened = await openDestination(spare);
    await draft(asDestination(spare), { type: "destinationHero", id: spare }, english("title", "Spare, named in the editor"));
    assert.ok((await publish(asDestination(spare)))?.ok);
    const moved = await saveDestination(await openDestination(spare), { slug: "a-spare-destination-moved" });
    assert.ok(moved?.ok, moved?.message);
    const answer = await saveDestination(opened, { summaryEn: "Summary from a stale form" });
    assert.ok(answer?.ok, answer?.message);
    const row = await destinationRow(spare);
    assert.equal(row.title_en, "Spare, named in the editor");
    assert.equal(row.slug, "a-spare-destination-moved");
    assert.equal(row.summary_en, "Summary from a stale form");
    const refused = await saveDestination(opened, { slug: "back-to-somewhere-else" });
    assert.deepEqual(refused?.conflicts, ["slug"]);
    assert.equal((await destinationRow(spare)).slug, "a-spare-destination-moved");
  });

  test("a group renamed on the catalogue is the destination's name, so a stale form editing the name conflicts", async () => {
    const opened = await openDestination(home);
    await draft(CATALOGUE, { type: "destinationGroup", id: home }, english("title", "Renamed on the catalogue"));
    assert.ok((await publish(CATALOGUE))?.ok);
    const refused = await saveDestination(opened, { titleEn: "Renamed on the form" });
    assert.deepEqual(refused?.conflicts, ["titleEn"]);
    assert.equal((await destinationRow(home)).title_en, "Renamed on the catalogue");
  });

  test("an address taken by a package, or a malformed one, is refused and nothing is written", async () => {
    const before = JSON.stringify(await destinationRow(spare));
    const taken = await saveDestination(await openDestination(spare), { slug: packages[0]!.slug });
    assert.equal(taken?.ok, false);
    assert.match(taken?.message ?? "", /already uses that address/);
    const malformed = await saveDestination(await openDestination(spare), { slug: "Not An Address" });
    assert.equal(malformed?.ok, false);
    assert.equal(JSON.stringify(await destinationRow(spare)), before);
  });
});

describe("races: real transactions at once", () => {
  test("two forms opened together, saving different fields at once, both land", async () => {
    const id = packages[1]!.id;
    const [a, b] = [await openPackage(id), await openPackage(id)];
    const [first, secondAnswer] = await Promise.all([
      savePackage(a, { durationEn: "Race duration" }),
      savePackage(b, { summaryEn: "Race summary" }),
    ]);
    assert.ok(first?.ok && secondAnswer?.ok, `${first?.message} / ${secondAnswer?.message}`);
    const row = await packageRow(id);
    assert.equal(row.duration_en, "Race duration");
    assert.equal(row.summary_en, "Race summary");
  });

  test("two forms saving the same field at once: exactly one wins, the other is refused", async () => {
    const id = packages[2]!.id;
    const [a, b] = [await openPackage(id), await openPackage(id)];
    const answers = await Promise.all([savePackage(a, { durationEn: "One" }), savePackage(b, { durationEn: "Two" })]);
    assert.equal(answers.filter((answer) => answer?.ok).length, 1, JSON.stringify(answers));
    assert.deepEqual(answers.find((answer) => !answer?.ok)?.conflicts, ["durationEn"]);
    assert.ok(["One", "Two"].includes(String((await packageRow(id)).duration_en)));
  });

  test("lock order: a form re-filing a package while the catalogue publishes never deadlocks", async () => {
    const id = packages[3]!.id;
    for (let round = 0; round < 8; round += 1) {
      const target = round % 2 === 0 ? spare : home;
      await draft(CATALOGUE, { type: "packageCard", id }, english("title", `Card title, round ${round}`));
      await draft(CATALOGUE, { type: "destinationGroup", id: target }, (values) => ({ ...values, linkLabel: { en: `Link, round ${round}`, ar: "" } }));
      const opened = await openPackage(id);
      const token = await reviewToken(CATALOGUE);
      const [form, published] = await Promise.all([
        savePackage(opened, { destinationId: target }),
        routeAction<RouteActionResult>("publishRouteFromEditor", [formOf({ routeKey: routeKey(CATALOGUE), token }, owner)]),
      ]);
      assert.ok(form?.ok, `round ${round}: the form — ${form?.message}`);
      assert.ok(published?.ok, `round ${round}: the publication — ${published && !published.ok ? published.message : ""}`);
      const row = await packageRow(id);
      assert.equal(row.destination_id, target, `round ${round}`);
      assert.equal(row.title_en, `Card title, round ${round}`, `round ${round}`);
    }
  });

  test("the server logged no deadlock, no render error and no unhandled failure", () => {
    const wrong = server.log().split("\n").filter((line) => /deadlock|40P01|⨯|digest:|Unhandled|TypeError|ReferenceError/.test(line));
    assert.deepEqual(wrong, []);
  });
});
