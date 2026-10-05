/**
 * Batch 24 stress: the concurrency questions the package routes raise in the
 * Visual Editor — a package's own page, a destination's page and the
 * catalogue at /packages — with the Packages and Destinations screens beside
 * them. Each question is asked many times against a running server, and each
 * answer is checked against the database rather than against the answers.
 *
 *   P1  draft conflicts — six saves of one region at one revision, on the
 *       package's page and on its catalogue card in turn: exactly one wins,
 *       the rest are refused as conflicts, and the package row never moves
 *   P2  publish races publish — five publications of one review of the
 *       catalogue, a package's page and a destination's page in turn: exactly
 *       one publishes and records one version, the rest are refused
 *   P3  reads during writes — the catalogue, the package's page and its
 *       destination's page in both editions, their RSC payloads, a preview, a
 *       canvas and the Visual Editor's own reads, all at once, while drafts
 *       are saved, discarded and published: every answer is whole (no 5xx, no
 *       error row), no public answer shows a draft, and the moment a
 *       publication answers, the next public read of all three pages shows
 *       it — the caches were dropped
 *   P4  a publication races the Packages form on a drafted field — the summary
 *       and a style against the form saving another summary, in both orders:
 *       exactly one lands — the publication whole, or the form — and the
 *       other is refused as a conflict with nothing written
 *   P5  the Packages form re-files a package while the catalogue publishes its
 *       card and the group it is moving to — the lock order (destinations
 *       before packages, both before the route's regions): both land in every
 *       round, in both orders, neither waits for ever, and nothing deadlocks
 *   P6  the package's page and its catalogue card publish the same column at
 *       once: exactly one lands, the other is refused as a conflict and keeps
 *       its draft, and neither waits on the other for ever
 *   P7  a destination's page and its catalogue group publish the
 *       destination's name at once: the same
 *   P8  a destination's new address races its page's publication: both land,
 *       on one identity, the page at its new address and the old one gone
 *   P9  discard races a new edit elsewhere on the catalogue — the new draft,
 *       never reviewed, always survives
 *   P10 destinations and packages created and deleted on their screens while
 *       the catalogue publishes: every action answers, none is left, and
 *       every publication lands
 *   P11 the rest of the site at the same moment — the catalogue, a package's
 *       page, a service category's page, a service's page and the services
 *       overview publishing at once, with their public pages read in both
 *       editions throughout: all five land with one version each, every
 *       answer is whole, and the next read of every page shows its own
 *       publication — the overview the category's new summary too
 *
 * Then: every history kept its newest thirty publications and its baseline,
 * no record was created or lost, and the server wrote no failure (21A's
 * `serverFailureLines`). STRESS_LOOPS=15 (rounds per question).
 */
import { callAction } from "../helpers/action";
import { isNavigationDigest, payloadErrors, serverFailureLines } from "../helpers/diagnostics";
import { giveFresh } from "../helpers/fixtures";
import { openDestinationForm, openPackageForm, withChanges } from "../helpers/package-form";
import { connect, dropDatabase } from "../helpers/pg";
import { startServer } from "../helpers/server";
import { signIn } from "../helpers/session";

import { STYLE_DOCUMENT_VERSION } from "../../src/lib/cms/styles";
import { documentEditorKey, editorKeyOf, type RouteDocument, type RouteOwner } from "../../src/lib/routes/owners";

const PORT = 3821;
const LOOPS = Number(process.env.STRESS_LOOPS ?? 15);
const VE = { route: "/admin/visual-editor", file: "app/(backoffice)/admin/visual-editor/route-actions.ts" };
const PACKAGE_ACTIONS = "app/(backoffice)/admin/(shell)/packages/actions.ts";
const DESTINATION_ACTIONS = "app/(backoffice)/admin/(shell)/packages/destinations/actions.ts";
const BRIDGE = "0123456789abcdef0123456789abcdef";
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

type Values = Record<string, unknown>;
type Answer = { ok: boolean; reason?: string; message?: string; conflicts?: string[] };
type Region = { revision: number; values: Values };

const CATALOGUE: RouteDocument = { kind: "packageIndex", id: 1 };
const asPackage = (id: number): RouteDocument => ({ kind: "package", id });
const asDestination = (id: number): RouteDocument => ({ kind: "destination", id });

const database = giveFresh("package_concurrency_stress");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);

  // A published destination holding two or more published packages, and its first two —
  // chosen by the data rather than by name.
  const [found] = await sql<{ id: number }[]>`
    select d.id from package_destinations d
     where d.is_published and (select count(*) from travel_packages p where p.destination_id = d.id and p.is_published) >= 2
     order by d.sort_order, d.id limit 1`;
  const home = found!.id;
  const [first, second] = (
    await sql<{ id: number }[]>`select id from travel_packages where destination_id = ${home} and is_published order by sort_order, id limit 2`
  ).map((row) => row.id) as [number, number];
  // P5 re-files a third published package between two destinations, wherever it starts.
  const [third] = await sql<{ id: number; destination_id: number | null }[]>`
    select id, destination_id from travel_packages where is_published and id <> ${first} and id <> ${second} order by sort_order, id limit 1`;
  // A second destination, made before the server starts so no cache has seen the catalogue without it.
  const [made] = await sql<{ id: number; slug: string }[]>`
    insert into package_destinations (slug, title_en, title_ar, summary_en, sort_order, is_published)
    values ('a-spare-destination-for-the-stress', 'Spare For The Stress', 'وجهة احتياطية', 'Made for the stress.', 60, true)
    returning id, slug`;
  const spare = made!.id;

  server = await startServer(database, PORT);
  const origin = server.origin;

  const recordCounts = async () =>
    (
      await sql<{ destinations: number; packages: number; categories: number; services: number; sections: number; components: number }[]>`
        select (select count(*)::int from package_destinations) as destinations,
               (select count(*)::int from travel_packages) as packages,
               (select count(*)::int from service_categories) as categories,
               (select count(*)::int from services) as services,
               (select count(*)::int from page_sections) as sections,
               (select count(*)::int from reusable_components) as components`
    )[0]!;
  const startCounts = await recordCounts();

  const form = (fields: Record<string, string | number>) => {
    const data = new FormData();
    data.set("_csrf", owner.csrfToken);
    for (const [key, value] of Object.entries(fields)) data.set(key, String(value));
    return data;
  };
  /** Every answer is checked as a browser would meet it: a 5xx or an error row is an incident. */
  const incidents: string[] = [];
  const call = async <T extends object = Answer>(where: { route: string; file: string }, action: string, args: unknown[]) => {
    const answer = await callAction<T>({ ...where, origin, action, args, cookie: owner.cookie });
    const failed = payloadErrors(answer.text).filter((row) => !isNavigationDigest(row.digest));
    if (answer.status >= 500 || failed.length) incidents.push(`${answer.status} ${action}: ${failed.map((row) => row.row).join(" | ") || answer.text.slice(0, 200)}`);
    return answer.value;
  };
  const read = async (path: string, options: { signedIn?: boolean; rsc?: boolean } = {}) => {
    const response = await fetch(`${origin}${path}`, {
      headers: { ...(options.signedIn ? { cookie: owner.cookie } : {}), ...(options.rsc ? { RSC: "1" } : {}) },
      redirect: "manual",
    });
    const body = await response.text();
    const failed = payloadErrors(body).filter((row) => !isNavigationDigest(row.digest));
    if (response.status >= 500 || failed.length) incidents.push(`${response.status} GET ${path}: ${failed.map((row) => row.row).join(" | ") || body.slice(0, 200)}`);
    return { status: response.status, body };
  };

  const routeOf = (doc: RouteDocument) => `${doc.kind}:${doc.id}`;
  const hero = (id: number): RouteOwner => ({ type: "packageHero", id });
  const card = (id: number): RouteOwner => ({ type: "packageCard", id });
  const region = async (target: RouteOwner, doc: RouteDocument): Promise<Region> => {
    const answer = await call<{ ok: boolean; message?: string; section?: Region }>(VE, "loadRouteRegion", [editorKeyOf(target), documentEditorKey(doc)]);
    if (!answer?.ok || !answer.section) throw new Error(`could not load ${target.type}:${target.id}: ${answer?.message ?? "no answer"}`);
    return answer.section;
  };
  /** A region's draft saved as the editor saves it: with the values it was loaded with as its base (Batch 23). */
  const saveAt = (target: RouteOwner, doc: RouteDocument, revision: number, values: Values, base?: Values) =>
    call(VE, "saveRouteRegionDraft", [
      form({
        sectionId: editorKeyOf(target),
        pageId: documentEditorKey(doc),
        expectedRevision: revision,
        values: JSON.stringify(values),
        ...(base ? { baseValues: JSON.stringify(base) } : {}),
      }),
    ]);
  const edit = async (target: RouteOwner, doc: RouteDocument, change: (values: Values) => Values) => {
    const current = await region(target, doc);
    const answer = await saveAt(target, doc, current.revision, change(current.values), current.values);
    if (!answer?.ok) throw new Error(`could not save ${target.type}:${target.id}: ${answer?.message ?? "no answer"}`);
  };
  const english = (field: string, text: string) => (values: Values) => ({ ...values, [field]: { ...(values[field] as object), en: text } });
  const token = async (doc: RouteDocument) => {
    const view = await call<{ token: string }>(VE, "loadRouteSummary", [routeOf(doc)]);
    if (!view) throw new Error(`no summary for ${routeOf(doc)}`);
    return view.token;
  };
  const publishWith = (doc: RouteDocument, reviewed: string) => call(VE, "publishRouteFromEditor", [form({ routeKey: routeOf(doc), token: reviewed })]);
  const discardWith = (doc: RouteDocument, reviewed: string) => call(VE, "discardRouteFromEditor", [form({ routeKey: routeOf(doc), token: reviewed })]);
  const settle = async (...docs: RouteDocument[]) => {
    for (const doc of docs) {
      const reviewed = await token(doc);
      if (reviewed) await discardWith(doc, reviewed);
    }
  };

  type PackageRow = { title_en: string; summary_en: string; duration_en: string; destination_id: number | null; slug: string };
  const packageRow = async (id: number) =>
    (await sql<PackageRow[]>`select title_en, summary_en, duration_en, destination_id, slug from travel_packages where id = ${id}`)[0]!;
  const destinationRow = async (id: number) =>
    (await sql<{ title_en: string; summary_en: string; slug: string }[]>`select title_en, summary_en, slug from package_destinations where id = ${id}`)[0]!;
  type Node = {
    revision: number;
    route_key: string;
    copy: Record<string, string> | null;
    draft_content: Record<string, { value: unknown }> | null;
    draft_styles: unknown;
    styles: unknown;
  };
  const nodeRow = async (ownerKey: string) =>
    (await sql<Node[]>`select revision, route_key, copy, draft_content, draft_styles, styles from route_nodes where owner_key = ${ownerKey}`)[0] ?? null;
  const packagePath = async (id: number) => `/packages/${(await packageRow(id)).slug}`;
  const destinationPath = async (id: number) => `/packages/${(await destinationRow(id)).slug}`;
  // A route keeps its newest 30 publications, so a count stops moving once it is full:
  // what a round recorded is counted by id, from a mark taken before it.
  const mark = async () => (await sql<{ id: number }[]>`select coalesce(max(id), 0)::int as id from route_versions`)[0]!.id;
  const recordedSince = async (doc: RouteDocument, since: number) =>
    (await sql<{ n: number }[]>`select count(*)::int as n from route_versions where route_key = ${routeOf(doc)} and kind = 'publish' and id > ${since}`)[0]!.n;
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /**
   * The Packages and Destinations screens' own updates, as their forms post them
   * (Batch 24): the page opened now — every field and the base it signs — and
   * saved, when the returned function is called, with `over` changed.
   */
  const packagesForm = async (id: number, over: Record<string, string | number | null> = {}) => {
    const fields = withChanges(await openPackageForm(sql, origin, owner.cookie, id), over);
    return () => call({ route: `/admin/packages/${id}`, file: PACKAGE_ACTIONS }, "updatePackage", [{ ok: false }, form(fields)]);
  };
  const destinationsForm = async (id: number, over: Record<string, string | number | null> = {}) => {
    const fields = withChanges(await openDestinationForm(sql, origin, owner.cookie, id), over);
    return () => call({ route: `/admin/packages/destinations/${id}`, file: DESTINATION_ACTIONS }, "updateDestination", [{ ok: false }, form(fields)]);
  };

  /* ---------------------------------------------------------------------- */
  /* P1 — draft conflicts                                                   */
  /* ---------------------------------------------------------------------- */
  {
    const live = (await packageRow(first)).title_en;
    const writers = 6;
    let clean = 0;
    let odd = "";
    for (let round = 0; round < LOOPS; round += 1) {
      // The package's own page, then its card on the catalogue: one record, two pages.
      const onCard = round % 2 === 1;
      const target = onCard ? card(first) : hero(first);
      const doc = onCard ? CATALOGUE : asPackage(first);
      const before = await region(target, doc);
      const results = await Promise.all(
        Array.from({ length: writers }, (_, i) =>
          saveAt(target, doc, before.revision, english("title", `P1 round ${round} writer ${i}`)(before.values), before.values),
        ),
      );
      const winners = results.map((result, i) => (result?.ok ? i : -1)).filter((i) => i >= 0);
      const conflicts = results.filter((result) => result && !result.ok && result.reason === "conflict").length;
      const after = await nodeRow(`${target.type}:${first}`);
      if (
        winners.length === 1 &&
        conflicts === writers - 1 &&
        after?.revision === before.revision + 1 &&
        after?.draft_content?.titleEn?.value === `P1 round ${round} writer ${winners[0]}` &&
        (await packageRow(first)).title_en === live
      ) {
        clean += 1;
      } else if (!odd) {
        odd = `round ${round}: ${results.map((result) => (result?.ok ? "saved" : `${result?.reason ?? "?"}`)).join(" | ")}`;
      }
    }
    say(
      "P1. concurrent saves of one region, on the package's page and on its card: exactly one wins, the rest conflict, the package row never moves",
      clean === LOOPS,
      `${clean}/${LOOPS} clean rounds${odd ? ` — ${odd}` : ""}`,
    );
    await settle(asPackage(first), CATALOGUE);
  }

  /* ---------------------------------------------------------------------- */
  /* P2 — publish races publish                                             */
  /* ---------------------------------------------------------------------- */
  {
    const racers = 5;
    let clean = 0;
    let odd = "";
    for (let round = 0; round < LOOPS; round += 1) {
      const which = round % 3;
      const text = `P2 round ${round}`;
      const doc = which === 0 ? CATALOGUE : which === 1 ? asPackage(first) : asDestination(home);
      // What each page drafts, and where it lands: template copy on the route, or a record's column.
      const ownerKey = which === 0 ? "packageIndexHero:1" : which === 1 ? `packageHero:${first}` : `destinationHero:${home}`;
      if (which === 0) await edit({ type: "packageIndexHero", id: 1 }, doc, english("heading", text));
      else if (which === 1) await edit(hero(first), doc, english("duration", text));
      else await edit({ type: "destinationHero", id: home }, doc, english("summary", text));
      const reviewed = await token(doc);
      const before = await mark();
      const results = await Promise.all(Array.from({ length: racers }, () => publishWith(doc, reviewed)));
      const published = results.filter((result) => result?.ok).length;
      const refused = results.filter((result) => result && !result.ok && ["stale", "conflict", "invalid"].includes(result.reason ?? "")).length;
      const node = await nodeRow(ownerKey);
      const landed =
        which === 0 ? node?.copy?.headingEn === text : which === 1 ? (await packageRow(first)).duration_en === text : (await destinationRow(home)).summary_en === text;
      if (published === 1 && refused === racers - 1 && (await recordedSince(doc, before)) === 1 && landed && node?.draft_content == null) {
        clean += 1;
      } else if (!odd) {
        odd = `round ${round} (${routeOf(doc)}): ${results.map((result) => (result?.ok ? "published" : `${result?.reason ?? "?"}`)).join(" | ")}`;
      }
    }
    say(
      "P2. concurrent publications of one review — the catalogue, a package's page, a destination's page: one publishes, one version, the rest refused",
      clean === LOOPS,
      `${clean}/${LOOPS} clean rounds${odd ? ` — ${odd}` : ""}`,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* P3 — reads during writes, and the caches                               */
  /* ---------------------------------------------------------------------- */
  {
    const path = await packagePath(first);
    const destination = await destinationPath(home);
    let running = true;
    let reads = 0;
    let leaked = "";
    const draftMark = "P3 unpublished draft";
    const readOnce = async (lane: number, turn: number) => {
      const kind = (lane + turn) % 10;
      if (kind <= 5) {
        // The three public pages, each in both editions.
        const public_ = [path, `/ar${path}`, "/packages", "/ar/packages", destination, `/ar${destination}`][kind]!;
        const answer = await read(public_);
        if (answer.body.includes(draftMark) || answer.body.includes("data-eod-")) leaked ||= `${public_} showed a draft or an editor mark`;
      } else if (kind === 6) {
        const answer = await read(lane % 2 === 0 ? path : "/packages", { rsc: true });
        if (answer.body.includes(draftMark)) leaked ||= "a public RSC payload carried a draft";
      } else if (kind === 7) {
        await read(`${path}?preview=1`, { signedIn: true });
      } else if (kind === 8) {
        await read(`/packages?preview=1&editor=1&bridge=${BRIDGE}`, { signedIn: true });
      } else {
        await region(hero(first), asPackage(first));
        await token(asPackage(first));
      }
    };
    const readers = Array.from({ length: 8 }, async (_, lane) => {
      for (let turn = 0; running; turn += 1) {
        try {
          await readOnce(lane, turn);
        } catch (error) {
          incidents.push(`reader ${lane}: ${error instanceof Error ? error.message : String(error)}`);
        }
        reads += 1;
      }
    });
    let fresh = 0;
    let first_ = "";
    for (let round = 0; round < LOOPS; round += 1) {
      // A draft that is never published, then thrown away…
      await edit(hero(first), asPackage(first), english("title", `${draftMark} ${round}`));
      await discardWith(asPackage(first), await token(asPackage(first)));
      // …and one that is, read back the moment the publication answers: on the package's
      // page, on its card in the catalogue and on its destination's page.
      const title = `P3 published title ${round}`;
      await edit(hero(first), asPackage(first), english("title", title));
      const published = await publishWith(asPackage(first), await token(asPackage(first)));
      const [page, arabic, catalogue, listed] = await Promise.all([read(path), read(`/ar${path}`), read("/packages"), read(destination)]);
      // The Arabic page keeps the package's own Arabic title: it only has to answer.
      if (published?.ok && page.body.includes(title) && arabic.status === 200 && catalogue.body.includes(title) && listed.body.includes(title)) fresh += 1;
      else if (!first_) first_ = `round ${round}: published=${published?.ok ?? "?"} page=${page.body.includes(title)} catalogue=${catalogue.body.includes(title)} destination=${listed.body.includes(title)}`;
    }
    running = false;
    await Promise.all(readers);
    say(
      "P3. reads of the catalogue, the package's and the destination's pages, payloads, preview, canvas and the editor during drafts, discards and publications: all whole, no draft in public",
      !leaked && incidents.length === 0 && reads > LOOPS * 8,
      leaked || (incidents[0] ?? `${reads} reads`),
    );
    say(
      "P3. the moment a publication answers, the package's page, its catalogue card and its destination's page show it — the caches were dropped",
      fresh === LOOPS,
      `${fresh}/${LOOPS}${first_ ? ` — ${first_}` : ""}`,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* P4 — a publication races the Packages form on a drafted field           */
  /* ---------------------------------------------------------------------- */
  {
    let exact = 0;
    let landed = 0;
    let refused = 0;
    let odd = "";
    for (let round = 0; round < LOOPS; round += 1) {
      await settle(asPackage(second));
      const colour = round % 2 === 0 ? "peach" : "strong";
      await edit(hero(second), asPackage(second), english("summary", `P4 draft ${round}`));
      const styled = await region(hero(second), asPackage(second));
      const styleAnswer = await call(VE, "saveRouteRegionStyles", [
        form({
          sectionId: editorKeyOf(hero(second)),
          pageId: documentEditorKey(asPackage(second)),
          expectedRevision: styled.revision,
          styles: JSON.stringify({ v: STYLE_DOCUMENT_VERSION, nodes: { "field:title": { base: { textColor: colour } } } }),
        }),
      ]);
      if (!styleAnswer?.ok) throw new Error(`could not style: ${styleAnswer?.message ?? "no answer"}`);
      const stylesBefore = JSON.stringify((await nodeRow(`packageHero:${second}`))?.styles ?? null);
      const reviewed = await token(asPackage(second));
      const before = await mark();
      const formSummary = `P4 form ${round}`;
      const save = await packagesForm(second, { summaryEn: formSummary });
      const hold = 10 + (round % 5) * 30;
      const [published, saved] = await Promise.all([
        wait(round % 2 === 1 ? hold : 0).then(() => publishWith(asPackage(second), reviewed)),
        wait(round % 2 === 0 ? hold : 0).then(save),
      ]);
      const node = await nodeRow(`packageHero:${second}`);
      const recorded = (await recordedSince(asPackage(second), before)) === 1;
      const stylesAfter = JSON.stringify(node?.styles ?? null);
      const whole = published?.ok === true && recorded && stylesAfter.includes(`"${colour}"`) && node?.draft_styles == null && node?.draft_content == null;
      const nothing =
        published?.ok === false && published.reason === "conflict" && !recorded && stylesAfter === stylesBefore && node?.draft_styles != null && node?.draft_content != null;
      // Both changed the summary since the form was opened: exactly one lands.
      const summary = (await packageRow(second)).summary_en;
      const formWon = saved?.ok === true && nothing && summary === formSummary;
      const editorWon = whole && saved?.ok === false && (saved.conflicts ?? []).join() === "summaryEn" && summary === `P4 draft ${round}`;
      if (formWon || editorWon) exact += 1;
      else if (!odd) odd = JSON.stringify({ round, published, saved, recorded, summary });
      if (editorWon) landed += 1;
      if (formWon) refused += 1;
    }
    say(
      "P4. a publication racing the Packages form on the same field: exactly one lands — the publication whole, or the form — and the other writes nothing",
      exact === LOOPS,
      `${exact}/${LOOPS} exact — the publication won ${landed}, the form won ${refused}${odd ? ` — first other: ${odd}` : ""}`,
    );
    await settle(asPackage(second));
  }

  /* ---------------------------------------------------------------------- */
  /* P5 — the Packages form re-files a package while the catalogue publishes */
  /* ---------------------------------------------------------------------- */
  {
    const moved = third!.id;
    const start = third!.destination_id;
    let exact = 0;
    let formHeld = 0;
    let slowest = 0;
    let odd = "";
    for (let round = 0; round < LOOPS; round += 1) {
      await settle(CATALOGUE);
      const target = round % 2 === 0 ? spare : home;
      const title = `P5 card title ${round}`;
      // The card's words and the target group's link: the publication holds every destination,
      // then every package; the form holds the target destination, then the package.
      await edit(card(moved), CATALOGUE, english("title", title));
      await edit({ type: "destinationGroup", id: target }, CATALOGUE, english("linkLabel", `P5 link ${round}`));
      const refile = await packagesForm(moved, { destinationId: target });
      const reviewed = await token(CATALOGUE);
      const hold = 10 + (round % 4) * 25;
      const started = Date.now();
      const [published, saved] = await Promise.all([
        wait(round % 2 === 1 ? hold : 0).then(() => publishWith(CATALOGUE, reviewed)),
        wait(round % 2 === 0 ? hold : 0).then(refile),
      ]);
      const took = Date.now() - started;
      slowest = Math.max(slowest, took);
      const row = await packageRow(moved);
      const group = await nodeRow(`destinationGroup:${target}`);
      if (round % 2 === 0) formHeld += 1;
      if (
        published?.ok === true &&
        saved?.ok === true &&
        row.destination_id === target &&
        row.title_en === title &&
        group?.copy?.linkLabelEn === `P5 link ${round}` &&
        (await nodeRow(`packageCard:${moved}`))?.draft_content == null &&
        took < 15_000
      ) {
        exact += 1;
      } else if (!odd) {
        odd = JSON.stringify({ round, published, saved, destination: row.destination_id, target, title: row.title_en, took });
      }
    }
    // Back where it started, through the same form.
    await (await packagesForm(moved, { destinationId: start ?? "" }))();
    const deadlocked = server.lines().filter((line) => /deadlock|40P01/i.test(line.text));
    say(
      "P5. the Packages form re-filing a package while the catalogue publishes: both land in every round and order, nothing deadlocks, nobody waits for ever",
      exact === LOOPS && deadlocked.length === 0 && (await packageRow(moved)).destination_id === start,
      `${exact}/${LOOPS} — ${formHeld} rounds with the form held back, slowest ${slowest} ms${deadlocked.length ? ` — ${deadlocked[0]!.text.slice(0, 200)}` : ""}${odd ? ` — first other: ${odd}` : ""}`,
    );
    await settle(CATALOGUE);
  }

  /* ---------------------------------------------------------------------- */
  /* P6 — the package's page and its card publish one column at once        */
  /* ---------------------------------------------------------------------- */
  {
    let exact = 0;
    let fromCard = 0;
    let fromPage = 0;
    let odd = "";
    for (let round = 0; round < LOOPS; round += 1) {
      await settle(CATALOGUE, asPackage(first));
      const cardText = `P6 card ${round}`;
      const pageText = `P6 page ${round}`;
      await edit(card(first), CATALOGUE, english("summary", cardText));
      await edit(hero(first), asPackage(first), english("summary", pageText));
      const [cardToken, pageToken] = [await token(CATALOGUE), await token(asPackage(first))];
      const started = Date.now();
      const [fromCatalogue, own] = await Promise.all([
        wait(round % 2 === 1 ? 15 : 0).then(() => publishWith(CATALOGUE, cardToken)),
        wait(round % 2 === 0 ? 15 : 0).then(() => publishWith(asPackage(first), pageToken)),
      ]);
      const took = Date.now() - started;
      const live = (await packageRow(first)).summary_en;
      const cardDraft = (await nodeRow(`packageCard:${first}`))?.draft_content?.summaryEn?.value;
      const pageDraft = (await nodeRow(`packageHero:${first}`))?.draft_content?.summaryEn?.value;
      const cardWon =
        fromCatalogue?.ok === true && own?.ok === false && own.reason === "conflict" && live === cardText && cardDraft === undefined && pageDraft === pageText;
      const pageWon =
        own?.ok === true && fromCatalogue?.ok === false && fromCatalogue.reason === "conflict" && live === pageText && pageDraft === undefined && cardDraft === cardText;
      if ((cardWon || pageWon) && took < 15_000) exact += 1;
      else if (!odd) odd = JSON.stringify({ round, card: fromCatalogue, own, live, cardDraft, pageDraft, took });
      if (cardWon) fromCard += 1;
      if (pageWon) fromPage += 1;
    }
    say(
      "P6. the catalogue and the package's page publishing one column at once: exactly one lands, the other keeps its draft, neither waits for ever",
      exact === LOOPS,
      `${exact}/${LOOPS} exact — the card won ${fromCard}, the page ${fromPage}${odd ? ` — first other: ${odd}` : ""}`,
    );
    await settle(CATALOGUE, asPackage(first));
  }

  /* ---------------------------------------------------------------------- */
  /* P7 — the destination's page and its group publish its name at once     */
  /* ---------------------------------------------------------------------- */
  {
    let exact = 0;
    let fromGroup = 0;
    let fromPage = 0;
    let odd = "";
    for (let round = 0; round < LOOPS; round += 1) {
      await settle(CATALOGUE, asDestination(home));
      const groupText = `P7 group ${round}`;
      const pageText = `P7 page ${round}`;
      await edit({ type: "destinationGroup", id: home }, CATALOGUE, english("title", groupText));
      await edit({ type: "destinationHero", id: home }, asDestination(home), english("title", pageText));
      const [groupToken, pageToken] = [await token(CATALOGUE), await token(asDestination(home))];
      const started = Date.now();
      const [fromCatalogue, own] = await Promise.all([
        wait(round % 2 === 1 ? 15 : 0).then(() => publishWith(CATALOGUE, groupToken)),
        wait(round % 2 === 0 ? 15 : 0).then(() => publishWith(asDestination(home), pageToken)),
      ]);
      const took = Date.now() - started;
      const live = (await destinationRow(home)).title_en;
      const groupDraft = (await nodeRow(`destinationGroup:${home}`))?.draft_content?.titleEn?.value;
      const pageDraft = (await nodeRow(`destinationHero:${home}`))?.draft_content?.titleEn?.value;
      const groupWon =
        fromCatalogue?.ok === true && own?.ok === false && own.reason === "conflict" && live === groupText && groupDraft === undefined && pageDraft === pageText;
      const pageWon =
        own?.ok === true && fromCatalogue?.ok === false && fromCatalogue.reason === "conflict" && live === pageText && pageDraft === undefined && groupDraft === groupText;
      if ((groupWon || pageWon) && took < 15_000) exact += 1;
      else if (!odd) odd = JSON.stringify({ round, group: fromCatalogue, own, live, groupDraft, pageDraft, took });
      if (groupWon) fromGroup += 1;
      if (pageWon) fromPage += 1;
    }
    say(
      "P7. the catalogue's group and the destination's page publishing its name at once: exactly one lands, the other keeps its draft, neither waits for ever",
      exact === LOOPS,
      `${exact}/${LOOPS} exact — the group won ${fromGroup}, the page ${fromPage}${odd ? ` — first other: ${odd}` : ""}`,
    );
    await settle(CATALOGUE, asDestination(home));
  }

  /* ---------------------------------------------------------------------- */
  /* P8 — a destination's new address races its page's publication           */
  /* ---------------------------------------------------------------------- */
  {
    const original = (await destinationRow(spare)).slug;
    const elsewhere = `${original}-moved`;
    let exact = 0;
    let formHeld = 0;
    let odd = "";
    for (let round = 0; round < LOOPS; round += 1) {
      await settle(asDestination(spare));
      const [from, to] = round % 2 === 0 ? [original, elsewhere] : [elsewhere, original];
      const summary = `P8 summary ${round}`;
      await edit({ type: "destinationHero", id: spare }, asDestination(spare), english("summary", summary));
      const reviewed = await token(asDestination(spare));
      // The form as an admin opened it, before the publication: it changes only the address.
      const move = await destinationsForm(spare, { slug: to });
      const hold = 10 + (round % 4) * 25;
      const [published, saved] = await Promise.all([
        wait(round % 2 === 1 ? hold : 0).then(() => publishWith(asDestination(spare), reviewed)),
        wait(round % 2 === 0 ? hold : 0).then(move),
      ]);
      if (round % 2 === 0) formHeld += 1;
      const row = await destinationRow(spare);
      // The page's own regions: one route key, whatever its address (its catalogue group lives on the catalogue).
      const keys = (
        await sql<{ route_key: string }[]>`select distinct route_key from route_nodes where owner_key ~ ${`^destination(Hero|Crumbs|Packages):${spare}$`}`
      ).map((entry) => entry.route_key);
      const [page, old] = await Promise.all([read(`/packages/${to}`), read(`/packages/${from}`)]);
      if (
        published?.ok === true &&
        saved?.ok === true &&
        row.slug === to &&
        row.summary_en === summary &&
        (await nodeRow(`destinationHero:${spare}`))?.draft_content == null &&
        keys.join(",") === routeOf(asDestination(spare)) &&
        page.status === 200 &&
        page.body.includes(summary) &&
        old.status === 404
      ) {
        exact += 1;
      } else if (!odd) {
        odd = JSON.stringify({ round, published, saved, slug: row.slug, to, keys, status: page.status, old: old.status });
      }
    }
    // Back at its own address.
    if ((await destinationRow(spare)).slug !== original) await (await destinationsForm(spare, { slug: original }))();
    say(
      "P8. a destination's new address racing its page's publication: both land, on one identity, the page at its new address and the old one gone",
      exact === LOOPS && (await destinationRow(spare)).slug === original,
      `${exact}/${LOOPS} — ${formHeld} rounds with the form held back${odd ? ` — first other: ${odd}` : ""}`,
    );
    await settle(asDestination(spare));
  }

  /* ---------------------------------------------------------------------- */
  /* P9 — discard races a new edit elsewhere on the catalogue               */
  /* ---------------------------------------------------------------------- */
  {
    let kept = 0;
    for (let round = 0; round < LOOPS; round += 1) {
      await settle(CATALOGUE);
      await edit({ type: "packageIndexHero", id: 1 }, CATALOGUE, english("intro", `P9 reviewed ${round}`));
      const reviewed = await token(CATALOGUE);
      const other: RouteOwner = { type: "packageIndexCustom", id: 1 };
      const current = await region(other, CATALOGUE);
      const text = `P9 unreviewed ${round}`;
      const [discarded, saved] = await Promise.all([
        discardWith(CATALOGUE, reviewed),
        saveAt(other, CATALOGUE, current.revision, english("heading", text)(current.values), current.values),
      ]);
      const survivor = (await nodeRow("packageIndexCustom:1"))?.draft_content?.["copy:headingEn"]?.value;
      const reviewedDraft = (await nodeRow("packageIndexHero:1"))?.draft_content?.["copy:introEn"]?.value;
      const consistent = discarded?.ok ? reviewedDraft === undefined : reviewedDraft === `P9 reviewed ${round}`;
      if (saved?.ok && survivor === text && consistent) kept += 1;
    }
    say("P9. a discard racing a new edit elsewhere on the catalogue never takes the edit it was not shown", kept === LOOPS, `${kept}/${LOOPS} rounds`);
    await settle(CATALOGUE);
  }

  /* ---------------------------------------------------------------------- */
  /* P10 — destinations and packages created and deleted while it publishes  */
  /* ---------------------------------------------------------------------- */
  {
    let churned = 0;
    let publications = 0;
    let odd = "";
    for (let round = 0; round < LOOPS; round += 1) {
      const duration = `P10 duration ${round}`;
      await edit(card(second), CATALOGUE, english("duration", duration));
      const reviewed = await token(CATALOGUE);
      // A destination, a package filed under it, then both deleted again — the destination
      // first, so the package is left unfiled (ON DELETE SET NULL) before it goes too.
      const churn = Array.from({ length: 3 }, async (_, i) => {
        const slug = `p10-${round}-${i}-${Date.now().toString(36)}`;
        await call({ route: "/admin/packages/destinations/new", file: DESTINATION_ACTIONS }, "createDestination", [
          { ok: false },
          form({ slug: `${slug}-d`, titleEn: `P10 destination ${round}-${i}`, titleAr: "", summaryEn: "", sortOrder: 90, isPublished: "on" }),
        ]);
        const [destination] = await sql<{ id: number }[]>`select id from package_destinations where slug = ${`${slug}-d`}`;
        if (!destination) return `no destination ${slug}`;
        await call({ route: "/admin/packages/new", file: PACKAGE_ACTIONS }, "createPackage", [
          { ok: false },
          form({
            slug: `${slug}-p`,
            region: "international",
            destinationId: destination.id,
            titleEn: `P10 package ${round}-${i}`,
            titleAr: "",
            summaryEn: "Made while the catalogue published.",
            highlights: "[]",
            sortOrder: 90,
            isPublished: "on",
          }),
        ]);
        const [pkg] = await sql<{ id: number; destination_id: number | null }[]>`select id, destination_id from travel_packages where slug = ${`${slug}-p`}`;
        if (!pkg || pkg.destination_id !== destination.id) return `no package ${slug} under its destination`;
        await call({ route: `/admin/packages/destinations/${destination.id}`, file: DESTINATION_ACTIONS }, "deleteDestination", [{ ok: false }, form({ id: destination.id })]);
        const [unfiled] = await sql<{ destination_id: number | null }[]>`select destination_id from travel_packages where id = ${pkg.id}`;
        if (!unfiled || unfiled.destination_id !== null) return `package ${slug} was not left unfiled`;
        await call({ route: `/admin/packages/${pkg.id}`, file: PACKAGE_ACTIONS }, "deletePackage", [{ ok: false }, form({ id: pkg.id })]);
        const [{ n }] = await sql<{ n: number }[]>`
          select ((select count(*) from package_destinations where id = ${destination.id}) + (select count(*) from travel_packages where id = ${pkg.id}))::int as n`;
        return n === 0 ? "" : `${slug} was left behind`;
      });
      const [published, ...results] = await Promise.all([publishWith(CATALOGUE, reviewed), ...churn]);
      if (published?.ok && (await packageRow(second)).duration_en === duration) publications += 1;
      else if (!odd) odd = JSON.stringify({ round, published });
      churned += results.filter((result) => result === "").length;
      odd ||= results.find((result) => result !== "") ?? "";
    }
    const [{ n: left }] = await sql<{ n: number }[]>`
      select ((select count(*) from package_destinations where slug like 'p10-%') + (select count(*) from travel_packages where slug like 'p10-%'))::int as n`;
    say(
      "P10. destinations and packages created and deleted on their screens while the catalogue publishes: every action answers, none is left, every publication lands",
      churned === LOOPS * 3 && publications === LOOPS && left === 0,
      `${churned}/${LOOPS * 3} created and deleted, ${publications}/${LOOPS} publications, ${left} left${odd ? ` — first other: ${odd}` : ""}`,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* P11 — the rest of the site publishing at the same moment                */
  /* ---------------------------------------------------------------------- */
  {
    // A published category with a published service, chosen by the data.
    const [served] = await sql<{ category_id: number; service_id: number; path: string; category_path: string }[]>`
      select c.id as category_id, s.id as service_id,
             '/services/' || c.slug || '/' || s.slug as path, '/services/' || c.slug as category_path
        from services s join service_categories c on c.id = s.category_id
       where s.is_published and c.is_published
       order by c.sort_order, c.id, s.sort_order, s.id limit 1`;
    const category: RouteDocument = { kind: "category", id: served!.category_id };
    const service: RouteDocument = { kind: "service", id: served!.service_id };
    const overview: RouteDocument = { kind: "serviceIndex", id: 1 };
    const packagePage = await packagePath(second);
    const pages = ["/packages", packagePage, served!.category_path, "/services", served!.path];
    let together = 0;
    let shown = 0;
    let odd = "";
    let unshown = "";
    for (let round = 0; round < LOOPS; round += 1) {
      const words = {
        card: `P11 card ${round}`,
        duration: `P11 duration ${round}`,
        category: `P11 category ${round}`,
        timeline: `P11 timeline ${round}`,
        overview: `P11 overview ${round}`,
      };
      await settle(CATALOGUE, asPackage(second), category, service, overview);
      await edit(card(first), CATALOGUE, english("title", words.card));
      await edit(hero(second), asPackage(second), english("duration", words.duration));
      await edit({ type: "category", id: served!.category_id }, category, english("summary", words.category));
      await edit({ type: "serviceHero", id: served!.service_id }, service, english("timeline", words.timeline));
      await edit({ type: "serviceIndexHero", id: 1 }, overview, english("heading", words.overview));
      const docs = [CATALOGUE, asPackage(second), category, service, overview];
      const reviewed = await Promise.all(docs.map((doc) => token(doc)));
      const before = await mark();
      // Five publications on five routes at once, with every public page they touch read
      // throughout — in both editions — by four readers.
      let running = true;
      const readers = Array.from({ length: 4 }, async (_, lane) => {
        for (let turn = 0; running; turn += 1) {
          const page = pages[(lane + turn) % pages.length]!;
          await read(turn % 2 === 0 ? page : `/ar${page}`);
        }
      });
      const answers = await Promise.all(docs.map((doc, i) => publishWith(doc, reviewed[i]!)));
      running = false;
      await Promise.all(readers);
      const recorded = await Promise.all(docs.map((doc) => recordedSince(doc, before)));
      if (answers.every((answer) => answer?.ok) && recorded.every((n) => n === 1)) together += 1;
      else if (!odd) odd = JSON.stringify({ round, answers: answers.map((answer) => (answer?.ok ? "published" : answer?.reason)), recorded });
      // Each page shows its own publication on the very next read — and the overview shows the
      // category's new summary as well: a category's publication dropped the overview's cache.
      const [catalogue, own, categoryPage, overviewPage, servicePage] = await Promise.all(pages.map((page) => read(page)));
      const expected: [string, boolean][] = [
        ["catalogue", catalogue!.body.includes(words.card)],
        ["package", own!.body.includes(words.duration)],
        ["category", categoryPage!.body.includes(words.category)],
        ["overview heading", overviewPage!.body.includes(words.overview)],
        ["overview row", overviewPage!.body.includes(words.category)],
        ["service", servicePage!.body.includes(words.timeline)],
      ];
      if (expected.every(([, ok]) => ok)) shown += 1;
      else if (!unshown) unshown = `round ${round}: ${expected.filter(([, ok]) => !ok).map(([name]) => name).join(", ")} missing`;
    }
    say(
      "P11. the catalogue, a package's page, a category page, a service's page and the services overview publishing at once, read throughout: all five land, one version each",
      together === LOOPS && incidents.length === 0,
      `${together}/${LOOPS}${odd ? ` — first other: ${odd}` : ""}${incidents[0] ? ` — ${incidents[0]}` : ""}`,
    );
    say(
      "P11. on the next read every page shows its own publication, and the overview the category's new summary — no route's cache drop is lost behind another's",
      shown === LOOPS,
      `${shown}/${LOOPS}${unshown ? ` — ${unshown}` : ""}`,
    );
  }

  // However many publications later — every one is in the activity log — each history is
  // the newest thirty of them and the baseline.
  const histories = await sql<{ route_key: string; publish: number; baseline: number }[]>`
    select route_key, count(*) filter (where kind = 'publish')::int as publish, count(*) filter (where kind = 'baseline')::int as baseline
      from route_versions group by route_key order by route_key`;
  say(
    "every route's history kept at most its newest thirty publications and one baseline",
    histories.length > 0 && histories.every((entry) => entry.publish <= 30 && entry.baseline === 1) && histories.some((entry) => entry.publish === 30),
    histories.map((entry) => `${entry.route_key}: ${entry.publish}+${entry.baseline}`).join(", "),
  );

  // Nothing above may have created or lost a record, or touched the page CMS.
  const endCounts = await recordCounts();
  say("the storms created and lost no record, and wrote nothing into the page CMS", JSON.stringify(endCounts) === JSON.stringify(startCounts), JSON.stringify(endCounts));

  // What the server said while all of this ran (21A): nothing that failed.
  const failures = serverFailureLines(server.lines());
  say(
    "the server wrote no failure, and no answer was a 5xx or carried an error row",
    failures.length === 0 && incidents.length === 0,
    [...failures.slice(0, 3).map((line) => line.text.slice(0, 200)), ...incidents.slice(0, 3)].join(" | "),
  );
} finally {
  await server?.stop();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
