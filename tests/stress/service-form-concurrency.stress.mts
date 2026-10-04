/**
 * Batch 23 stress: the Services form against everything else that writes a
 * service, many times over, against a running server and PostgreSQL. Every
 * answer is checked against the database rather than against the answers.
 *
 *   F1  the form and a publication, different fields, both orders — a
 *       Visual Editor publication of the timeline and a stale form's save of
 *       the introduction: both land, every round (no lost update)
 *   F2  the same field, both orders — exactly one lands; the losing form
 *       writes nothing at all, the losing publication keeps its draft
 *   F3  stale forms at once — six forms opened at one moment: three change
 *       three different fields and all land; three change one field and
 *       exactly one lands
 *   F4  a category move against stale forms — a move racing three stale
 *       forms that change other fields (all land, the service never moved
 *       back) and one that changes the group (exactly one of the two
 *       placements lands)
 *   F5  rapid publication — three publications of the timeline back to
 *       back while three stale forms save three other fields in between:
 *       every value lands, the last publication's timeline is live
 *   F6  public reads throughout F1–F5 — the page in both editions, its RSC
 *       payload and its category page: no 5xx, no error row, no draft seen
 *   F7  nothing waits for ever — every racing write answered within 15 s
 *
 * Then: no record was created or lost, and the server wrote no failure
 * (21A's `serverFailureLines`). STRESS_LOOPS=15 (rounds per question).
 */
import { callAction } from "../helpers/action";
import { isNavigationDigest, payloadErrors, serverFailureLines } from "../helpers/diagnostics";
import { giveFresh } from "../helpers/fixtures";
import { connect, dropDatabase } from "../helpers/pg";
import { startServer } from "../helpers/server";
import { openServiceForm } from "../helpers/service-form";
import { signIn } from "../helpers/session";

import { documentEditorKey, editorKeyOf, type RouteOwner } from "../../src/lib/routes/owners";

const PORT = 3820;
const LOOPS = Number(process.env.STRESS_LOOPS ?? 15);
const VE = { route: "/admin/visual-editor", file: "app/(backoffice)/admin/visual-editor/route-actions.ts" };
const SERVICES = { route: "/admin/services", file: "app/(backoffice)/admin/(shell)/services/actions.ts" };
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

type Values = Record<string, unknown>;
type Answer = { ok: boolean; reason?: string; message?: string; conflicts?: string[] };
type Region = { revision: number; values: Values };
type Row = {
  title_en: string;
  title_ar: string;
  intro_en: string;
  timeline_en: string;
  notes_en: string;
  category_id: number;
  subcategory_id: number | null;
  slug: string;
  updated_at: Date;
};

const database = giveFresh("service_form_concurrency_stress");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);
  const origin = server.origin;

  // Three published services of one category, and one filed under a group — chosen by the data.
  const [subject] = await sql<{ category_id: number }[]>`
    select s.category_id from services s join service_categories c on c.id = s.category_id
     where s.is_published and c.is_published
     group by s.category_id having count(*) >= 3 order by s.category_id limit 1`;
  const [first, second, third] = (
    await sql<{ id: number }[]>`select id from services where category_id = ${subject!.category_id} and is_published order by sort_order, id limit 3`
  ).map((row) => row.id) as [number, number, number];
  const [grouped] = await sql<{ id: number; category_id: number; subcategory_id: number; slug: string }[]>`
    select s.id, s.category_id, s.subcategory_id, s.slug from services s join service_categories c on c.id = s.category_id
     where s.is_published and c.is_published and s.subcategory_id is not null and s.id not in (${first}, ${second}, ${third})
     order by s.id limit 1`;
  const [elsewhere] = await sql<{ id: number }[]>`
    select c.id from service_categories c
     where c.id <> ${grouped!.category_id} and c.is_published
       and not exists (select 1 from services s where s.category_id = c.id and s.slug = ${grouped!.slug})
     order by c.sort_order, c.id limit 1`;
  if (!grouped || !elsewhere) throw new Error("the fixture lacks a grouped service or a category to move it to");

  const recordCounts = async () =>
    (
      await sql<{ categories: number; groups: number; services: number; faqs: number; sections: number }[]>`
        select (select count(*)::int from service_categories) as categories,
               (select count(*)::int from service_subcategories) as groups,
               (select count(*)::int from services) as services,
               (select count(*)::int from faqs) as faqs,
               (select count(*)::int from page_sections) as sections`
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
  let slowest = 0;
  const call = async <T extends object = Answer>(where: { route: string; file: string }, action: string, args: unknown[]) => {
    const started = Date.now();
    const answer = await callAction<T>({ ...where, origin, action, args, cookie: owner.cookie });
    slowest = Math.max(slowest, Date.now() - started);
    const failed = payloadErrors(answer.text).filter((row) => !isNavigationDigest(row.digest));
    if (answer.status >= 500 || failed.length) incidents.push(`${answer.status} ${action}: ${failed.map((row) => row.row).join(" | ") || answer.text.slice(0, 200)}`);
    return answer.value;
  };
  const read = async (path: string, options: { rsc?: boolean } = {}) => {
    const response = await fetch(`${origin}${path}`, { headers: options.rsc ? { RSC: "1" } : {}, redirect: "manual" });
    const body = await response.text();
    const failed = payloadErrors(body).filter((row) => !isNavigationDigest(row.digest));
    if (response.status >= 500 || failed.length) incidents.push(`${response.status} GET ${path}: ${failed.map((row) => row.row).join(" | ") || body.slice(0, 200)}`);
    return { status: response.status, body };
  };

  const pageOf = (id: number) => documentEditorKey({ kind: "service", id });
  const routeOf = (id: number) => `service:${id}`;
  const hero = (id: number): RouteOwner => ({ type: "serviceHero", id });
  const region = async (target: RouteOwner, pageId: number): Promise<Region> => {
    const answer = await call<{ ok: boolean; message?: string; section?: Region }>(VE, "loadRouteRegion", [editorKeyOf(target), pageId]);
    if (!answer?.ok || !answer.section) throw new Error(`could not load ${target.type}:${target.id}: ${answer?.message ?? "no answer"}`);
    return answer.section;
  };
  /** A hero draft saved as the editor saves it: with the values it was loaded with as its base. */
  const edit = async (id: number, change: (values: Values) => Values) => {
    const current = await region(hero(id), pageOf(id));
    const answer = await call(VE, "saveRouteRegionDraft", [
      form({
        sectionId: editorKeyOf(hero(id)),
        pageId: pageOf(id),
        expectedRevision: current.revision,
        values: JSON.stringify(change(current.values)),
        baseValues: JSON.stringify(current.values),
      }),
    ]);
    if (!answer?.ok) throw new Error(`could not draft ${id}: ${answer?.message ?? "no answer"}`);
  };
  const english = (field: string, text: string) => (values: Values) => ({ ...values, [field]: { ...(values[field] as object), en: text } });
  const token = async (id: number) => {
    const view = await call<{ token: string }>(VE, "loadRouteSummary", [routeOf(id)]);
    if (!view) throw new Error(`no summary for ${id}`);
    return view.token;
  };
  const publishWith = (id: number, reviewed: string) => call(VE, "publishRouteFromEditor", [form({ routeKey: routeOf(id), token: reviewed })]);
  const settle = async (id: number) => {
    const reviewed = await token(id);
    if (reviewed) await call(VE, "discardRouteFromEditor", [form({ routeKey: routeOf(id), token: reviewed })]);
  };
  const serviceRow = async (id: number) =>
    (await sql<Row[]>`select title_en, title_ar, intro_en, timeline_en, notes_en, category_id, subcategory_id, slug, updated_at from services where id = ${id}`)[0]!;
  const pathOf = async (id: number) =>
    (await sql<{ path: string }[]>`
      select '/services/' || c.slug || '/' || s.slug as path from services s join service_categories c on c.id = s.category_id where s.id = ${id}`)[0]!.path;
  const categoryPathOf = async (id: number) =>
    (await sql<{ path: string }[]>`select '/services/' || c.slug as path from services s join service_categories c on c.id = s.category_id where s.id = ${id}`)[0]!.path;
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /** The Services edit page opened now; the returned function saves it with `over` changed. */
  const opened = async (id: number) => {
    const fields = await openServiceForm(sql, origin, owner.cookie, id);
    return (over: Record<string, string | number>) => call(SERVICES, "updateService", [{ ok: false }, form({ ...fields, ...over })]);
  };

  /* ---------------------------------------------------------------------- */
  /* F6 — readers, all the way through F1–F5                                */
  /* ---------------------------------------------------------------------- */
  const DRAFT_MARK = "F unpublished draft";
  let reading = true;
  let reads = 0;
  let leaked = "";
  const watched = [first, second, third, grouped.id];
  const readers = Array.from({ length: 6 }, async (_, lane) => {
    for (let turn = 0; reading; turn += 1) {
      const id = watched[(lane + turn) % watched.length]!;
      try {
        const path = await pathOf(id);
        const kind = (lane + turn) % 4;
        const answer =
          kind === 0 ? await read(path) : kind === 1 ? await read(`/ar${path}`) : kind === 2 ? await read(path, { rsc: true }) : await read(await categoryPathOf(id));
        if (answer.body.includes(DRAFT_MARK) || answer.body.includes("data-eod-")) leaked ||= `${path} (${kind}) showed a draft or an editor mark`;
      } catch (error) {
        incidents.push(`reader ${lane}: ${error instanceof Error ? error.message : String(error)}`);
      }
      reads += 1;
    }
  });

  /* ---------------------------------------------------------------------- */
  /* F1 — different fields, both orders                                     */
  /* ---------------------------------------------------------------------- */
  {
    let clean = 0;
    let odd = "";
    for (let round = 0; round < LOOPS; round += 1) {
      await settle(first);
      const timeline = `F1 timeline ${round}`;
      const intro = `F1 intro ${round}`;
      // A draft that is never published rides along: it must never be seen in public.
      await edit(first, (values) => english("timeline", timeline)(english("ctaLabel", DRAFT_MARK)(values)));
      await edit(first, english("ctaLabel", ""));
      const reviewed = await token(first);
      const save = await opened(first);
      const hold = 5 + (round % 5) * 20;
      const [published, saved] = await Promise.all([
        wait(round % 2 ? hold : 0).then(() => publishWith(first, reviewed)),
        wait(round % 2 ? 0 : hold).then(() => save({ introEn: intro })),
      ]);
      const live = await serviceRow(first);
      if (published?.ok && saved?.ok && live.timeline_en === timeline && live.intro_en === intro) clean += 1;
      else if (!odd) odd = JSON.stringify({ round, published, saved, timeline: live.timeline_en, intro: live.intro_en });
    }
    say("F1. a stale form and a publication of different fields, in both orders: both land, every round", clean === LOOPS, `${clean}/${LOOPS}${odd ? ` — first other: ${odd}` : ""}`);
    await settle(first);
  }

  /* ---------------------------------------------------------------------- */
  /* F2 — the same field, both orders                                       */
  /* ---------------------------------------------------------------------- */
  {
    let exact = 0;
    let editorWon = 0;
    let formWon = 0;
    let odd = "";
    for (let round = 0; round < LOOPS; round += 1) {
      await settle(first);
      await edit(first, english("intro", `F2 editor ${round}`));
      const reviewed = await token(first);
      const save = await opened(first);
      const before = await serviceRow(first);
      const hold = 5 + (round % 5) * 20;
      const [published, saved] = await Promise.all([
        wait(round % 2 ? hold : 0).then(() => publishWith(first, reviewed)),
        wait(round % 2 ? 0 : hold).then(() => save({ introEn: `F2 form ${round}`, notesEn: `<p>F2 form notes ${round}</p>` })),
      ]);
      const live = await serviceRow(first);
      const draft = (await sql<{ draft_content: Record<string, { value: unknown }> | null }[]>`
        select draft_content from route_nodes where owner_key = ${`serviceHero:${first}`}`)[0]?.draft_content;
      const editorFirst =
        published?.ok === true &&
        saved?.ok === false &&
        (saved.conflicts ?? []).join() === "introEn" &&
        live.intro_en === `F2 editor ${round}` &&
        live.notes_en === before.notes_en;
      const formFirst =
        saved?.ok === true &&
        published?.ok === false &&
        published.reason === "conflict" &&
        live.intro_en === `F2 form ${round}` &&
        live.notes_en === `<p>F2 form notes ${round}</p>` &&
        draft?.introEn?.value === `F2 editor ${round}`;
      if (editorFirst || formFirst) exact += 1;
      else if (!odd) odd = JSON.stringify({ round, published, saved, intro: live.intro_en });
      if (editorFirst) editorWon += 1;
      if (formFirst) formWon += 1;
    }
    say(
      "F2. a stale form and a publication of the same field: exactly one lands, the loser writes nothing",
      exact === LOOPS,
      `${exact}/${LOOPS} — the publication won ${editorWon}, the form ${formWon}${odd ? ` — first other: ${odd}` : ""}`,
    );
    await settle(first);
  }

  /* ---------------------------------------------------------------------- */
  /* F3 — six stale forms at once                                           */
  /* ---------------------------------------------------------------------- */
  {
    let clean = 0;
    let odd = "";
    for (let round = 0; round < LOOPS; round += 1) {
      const saves = await Promise.all(Array.from({ length: 6 }, () => opened(second)));
      const answers = await Promise.all([
        saves[0]!({ introEn: `F3 intro ${round}` }),
        saves[1]!({ timelineEn: `F3 timeline ${round}` }),
        saves[2]!({ titleAr: `F3 عنوان ${round}` }),
        saves[3]!({ notesEn: `<p>F3 notes ${round} a</p>` }),
        saves[4]!({ notesEn: `<p>F3 notes ${round} b</p>` }),
        saves[5]!({ notesEn: `<p>F3 notes ${round} c</p>` }),
      ]);
      const live = await serviceRow(second);
      const distinct = answers.slice(0, 3).every((answer) => answer?.ok === true);
      const same = answers.slice(3);
      const winners = same.map((answer, i) => (answer?.ok ? i : -1)).filter((i) => i >= 0);
      const losersRefused = same.every((answer) => answer?.ok || (answer?.conflicts ?? []).join() === "notesEn");
      if (
        distinct &&
        winners.length === 1 &&
        losersRefused &&
        live.intro_en === `F3 intro ${round}` &&
        live.timeline_en === `F3 timeline ${round}` &&
        live.title_ar === `F3 عنوان ${round}` &&
        live.notes_en === `<p>F3 notes ${round} ${"abc"[winners[0]!]}</p>`
      ) {
        clean += 1;
      } else if (!odd) {
        odd = JSON.stringify({ round, answers: answers.map((answer) => answer?.ok ?? answer), live });
      }
    }
    say("F3. six stale forms at once: three different fields all land, three on one field land exactly once", clean === LOOPS, `${clean}/${LOOPS}${odd ? ` — first other: ${odd}` : ""}`);
  }

  /* ---------------------------------------------------------------------- */
  /* F4 — a category move against stale forms                               */
  /* ---------------------------------------------------------------------- */
  {
    let clean = 0;
    let moves = 0;
    let regroups = 0;
    let odd = "";
    const home = { categoryId: grouped.category_id, subcategoryId: grouped.subcategory_id };
    for (let round = 0; round < LOOPS; round += 1) {
      // Home, in its group, before the round's forms are opened.
      const back = await (await opened(grouped.id))({ categoryId: home.categoryId, subcategoryId: home.subcategoryId });
      if (!back?.ok) throw new Error(`could not put the service back: ${back?.message ?? "no answer"}`);
      const stale = await Promise.all(Array.from({ length: 4 }, () => opened(grouped.id)));
      const move = await opened(grouped.id);
      const answers = await Promise.all([
        wait((round % 3) * 15).then(() => move({ categoryId: elsewhere.id, subcategoryId: "" })),
        stale[0]!({ timelineEn: `F4 timeline ${round}` }),
        stale[1]!({ introEn: `F4 intro ${round}` }),
        stale[2]!({ titleAr: `F4 عنوان ${round}` }),
        wait(((round + 1) % 3) * 15).then(() => stale[3]!({ subcategoryId: "" })),
      ]);
      const [moved, timeline, intro, title, regroup] = answers;
      const live = await serviceRow(grouped.id);
      const others = timeline?.ok && intro?.ok && title?.ok && live.timeline_en === `F4 timeline ${round}` && live.intro_en === `F4 intro ${round}` && live.title_ar === `F4 عنوان ${round}`;
      const moveWon = moved?.ok === true && regroup?.ok === false && (regroup.conflicts ?? []).join() === "placement" && live.category_id === elsewhere.id && live.subcategory_id === null;
      const regroupWon = regroup?.ok === true && moved?.ok === false && (moved.conflicts ?? []).join() === "placement" && live.category_id === home.categoryId && live.subcategory_id === null;
      if (others && (moveWon || regroupWon)) clean += 1;
      else if (!odd) odd = JSON.stringify({ round, answers: answers.map((answer) => (answer?.ok ? "ok" : (answer?.conflicts ?? answer?.message))), category: live.category_id, group: live.subcategory_id });
      if (moveWon) moves += 1;
      if (regroupWon) regroups += 1;
    }
    const restored = await (await opened(grouped.id))({ categoryId: home.categoryId, subcategoryId: home.subcategoryId });
    const end = await serviceRow(grouped.id);
    say(
      "F4. a move racing stale forms: their other fields all land, the service is never moved back, and the move or the group change lands — exactly one",
      clean === LOOPS && restored?.ok === true && end.category_id === home.categoryId && end.subcategory_id === home.subcategoryId,
      `${clean}/${LOOPS} — the move won ${moves}, the group change ${regroups}${odd ? ` — first other: ${odd}` : ""}`,
    );
  }

  /* ---------------------------------------------------------------------- */
  /* F5 — rapid publication                                                 */
  /* ---------------------------------------------------------------------- */
  {
    let clean = 0;
    let odd = "";
    for (let round = 0; round < LOOPS; round += 1) {
      await settle(third);
      const saves = await Promise.all(Array.from({ length: 3 }, () => opened(third)));
      const burst = (async () => {
        const results: boolean[] = [];
        for (let step = 0; step < 3; step += 1) {
          await edit(third, english("timeline", `F5 timeline ${round}.${step}`));
          results.push((await publishWith(third, await token(third)))?.ok === true);
        }
        return results;
      })();
      const forms = Promise.all([
        saves[0]!({ introEn: `F5 intro ${round}` }),
        wait(40).then(() => saves[1]!({ notesEn: `<p>F5 notes ${round}</p>` })),
        wait(80).then(() => saves[2]!({ titleAr: `F5 عنوان ${round}` })),
      ]);
      const [published, saved] = await Promise.all([burst, forms]);
      const live = await serviceRow(third);
      if (
        published.every(Boolean) &&
        saved.every((answer) => answer?.ok === true) &&
        live.timeline_en === `F5 timeline ${round}.2` &&
        live.intro_en === `F5 intro ${round}` &&
        live.notes_en === `<p>F5 notes ${round}</p>` &&
        live.title_ar === `F5 عنوان ${round}`
      ) {
        clean += 1;
      } else if (!odd) {
        odd = JSON.stringify({ round, published, saved: saved.map((answer) => answer?.ok ?? answer), live });
      }
    }
    say("F5. three publications back to back while three stale forms save other fields: every value lands", clean === LOOPS, `${clean}/${LOOPS}${odd ? ` — first other: ${odd}` : ""}`);
    await settle(third);
  }

  reading = false;
  await Promise.all(readers);
  say(
    "F6. public reads throughout — both editions, the RSC payload, the category page: all whole, no draft or editor mark in public",
    !leaked && reads > LOOPS * 10,
    leaked || `${reads} reads`,
  );
  say("F7. nothing waited for ever: every racing write answered within 15 s", slowest < 15_000, `slowest answer ${slowest} ms`);

  // Nothing above may have created or lost a record, or touched the page CMS.
  const endCounts = await recordCounts();
  say("the storms created and lost no record, and wrote nothing into the page CMS", JSON.stringify(endCounts) === JSON.stringify(startCounts), JSON.stringify(endCounts));

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
