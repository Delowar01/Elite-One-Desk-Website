/**
 * Batch 22 stress: the concurrency questions a service's own page raises in
 * the Visual Editor, each asked many times against a running server, and each
 * answer checked against the database rather than against the answers.
 *
 *   S1  draft conflicts — N saves of one service region at one revision:
 *       exactly one wins, the rest are refused as conflicts, nothing is
 *       merged, and the service row never moves
 *   S2  publish races publish — N publications of one review of a service
 *       page: exactly one publishes and records one version, the rest are
 *       refused
 *   S3  reads during writes — the public page in both editions, its draft
 *       preview, the editor's canvas, the page's RSC payload, the category
 *       page and the Visual Editor's route reads, all at once, while drafts
 *       are saved, discarded and published: every answer is whole (no 5xx, no
 *       error row), the public page never shows a draft, and the moment a
 *       publication answers, the next public read of the page and of its
 *       category shows it — the caches were dropped
 *   S4  publish races the Services form on a drafted field — the hero's
 *       introduction and a style against the form saving another
 *       introduction, in both orders: the publication lands whole or is
 *       refused as a conflict with nothing written; the form always lands
 *   S5  publish races a move — the Services form moving the service to
 *       another category while its page is published: both land, the
 *       publication on the same row, every region still the service's
 *       (one route key, no second identity), the page at its new address
 *   S6  the category page and the service page publish the same column at
 *       once — the card's introduction and the hero's: exactly one lands,
 *       the other is refused as a conflict and keeps its draft, and neither
 *       waits on the other for ever (the two lock orders cannot cycle)
 *   S7  a rename races a publication of the title — the form renaming the
 *       service while its title draft is published: the form always lands;
 *       the publication lands whole or is refused as a conflict; the page's
 *       identity never changes
 *   S8  discard races a new edit elsewhere on the page — the new draft, never
 *       reviewed, always survives
 *   S9  components created and deleted while the page is published — every
 *       component action answers, none is left behind, and every publication
 *       lands
 *
 * Then: the history kept its newest thirty publications and its baseline, no
 * record was created or lost, and the server wrote no failure (21A's
 * `serverFailureLines`). STRESS_LOOPS=15 (rounds per question).
 */
import { callAction } from "../helpers/action";
import { isNavigationDigest, payloadErrors, serverFailureLines } from "../helpers/diagnostics";
import { giveFresh } from "../helpers/fixtures";
import { connect, dropDatabase } from "../helpers/pg";
import { startServer } from "../helpers/server";
import { signIn } from "../helpers/session";

import { STYLE_DOCUMENT_VERSION } from "../../src/lib/cms/styles";
import { documentEditorKey, editorKeyOf, type RouteOwner } from "../../src/lib/routes/owners";

const PORT = 3819;
const LOOPS = Number(process.env.STRESS_LOOPS ?? 15);
const VE = { route: "/admin/visual-editor", file: "app/(backoffice)/admin/visual-editor/route-actions.ts" };
const SERVICES = { route: "/admin/services", file: "app/(backoffice)/admin/(shell)/services/actions.ts" };
const COMPONENTS = { route: "/admin/components", file: "app/(backoffice)/admin/(shell)/components/actions.ts" };
const BRIDGE = "0123456789abcdef0123456789abcdef";
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

type Values = Record<string, unknown>;
type Answer = { ok: boolean; reason?: string; message?: string };
type Region = { revision: number; values: Values };

const database = giveFresh("service_concurrency_stress");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);
  const origin = server.origin;

  // A category with three or more published services, chosen by its data rather than its name.
  const [subject] = await sql<{ category_id: number }[]>`
    select s.category_id from services s join service_categories c on c.id = s.category_id
     where s.is_published and c.is_published
     group by s.category_id having count(*) >= 3 order by s.category_id limit 1`;
  const categoryId = subject!.category_id;
  const [first, second, third] = (
    await sql<{ id: number }[]>`select id from services where category_id = ${categoryId} and is_published order by sort_order, id limit 3`
  ).map((row) => row.id) as [number, number, number];
  // Where S5 moves a service: another published category without its slug.
  const [elsewhere] = await sql<{ id: number }[]>`
    select c.id from service_categories c
     where c.id <> ${categoryId} and c.is_published
       and not exists (select 1 from services s where s.category_id = c.id and s.slug = (select slug from services where id = ${second}))
     order by c.sort_order, c.id limit 1`;

  const recordCounts = async () =>
    (
      await sql<{ categories: number; groups: number; services: number; faqs: number; sections: number; components: number }[]>`
        select (select count(*)::int from service_categories) as categories,
               (select count(*)::int from service_subcategories) as groups,
               (select count(*)::int from services) as services,
               (select count(*)::int from faqs) as faqs,
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

  const pageOf = (id: number) => documentEditorKey({ kind: "service", id });
  const routeOf = (id: number) => `service:${id}`;
  const hero = (id: number): RouteOwner => ({ type: "serviceHero", id });
  const region = async (target: RouteOwner, pageId: number): Promise<Region> => {
    const answer = await call<{ ok: boolean; message?: string; section?: Region }>(VE, "loadRouteRegion", [editorKeyOf(target), pageId]);
    if (!answer?.ok || !answer.section) throw new Error(`could not load ${target.type}:${target.id}: ${answer?.message ?? "no answer"}`);
    return answer.section;
  };
  const saveAt = (target: RouteOwner, pageId: number, revision: number, values: Values) =>
    call(VE, "saveRouteRegionDraft", [form({ sectionId: editorKeyOf(target), pageId, expectedRevision: revision, values: JSON.stringify(values) })]);
  const edit = async (target: RouteOwner, pageId: number, change: (values: Values) => Values) => {
    const current = await region(target, pageId);
    const answer = await saveAt(target, pageId, current.revision, change(current.values));
    if (!answer?.ok) throw new Error(`could not save ${target.type}:${target.id}: ${answer?.message ?? "no answer"}`);
  };
  const english = (field: string, text: string) => (values: Values) => ({ ...values, [field]: { ...(values[field] as object), en: text } });
  const token = async (routeKey: string) => {
    const view = await call<{ token: string }>(VE, "loadRouteSummary", [routeKey]);
    if (!view) throw new Error(`no summary for ${routeKey}`);
    return view.token;
  };
  const publishWith = (routeKey: string, reviewed: string) => call(VE, "publishRouteFromEditor", [form({ routeKey, token: reviewed })]);
  const discardWith = (routeKey: string, reviewed: string) => call(VE, "discardRouteFromEditor", [form({ routeKey, token: reviewed })]);
  const settle = async (...routeKeys: string[]) => {
    for (const routeKey of routeKeys) {
      const reviewed = await token(routeKey);
      if (reviewed) await discardWith(routeKey, reviewed);
    }
  };

  type Row = { title_en: string; intro_en: string; timeline_en: string; category_id: number; subcategory_id: number | null; slug: string };
  const serviceRow = async (id: number) =>
    (await sql<Row[]>`select title_en, intro_en, timeline_en, category_id, subcategory_id, slug from services where id = ${id}`)[0]!;
  const nodeRow = async (ownerKey: string) =>
    (await sql<{ revision: number; route_key: string; draft_content: Record<string, { value: unknown }> | null; draft_styles: unknown; styles: unknown }[]>`
      select revision, route_key, draft_content, draft_styles, styles from route_nodes where owner_key = ${ownerKey}`)[0] ?? null;
  const pathOf = async (id: number) =>
    (await sql<{ path: string }[]>`
      select '/services/' || c.slug || '/' || s.slug as path from services s join service_categories c on c.id = s.category_id where s.id = ${id}`)[0]!.path;
  const categoryPathOf = async (id: number) =>
    (await sql<{ path: string }[]>`select '/services/' || c.slug as path from services s join service_categories c on c.id = s.category_id where s.id = ${id}`)[0]!.path;
  // The route keeps its newest 30 publications, so a count stops moving once it is full:
  // what a round recorded is counted by id, from a mark taken before it.
  const mark = async () => (await sql<{ id: number }[]>`select coalesce(max(id), 0)::int as id from route_versions`)[0]!.id;
  const recordedSince = async (routeKey: string, since: number) =>
    (await sql<{ n: number }[]>`select count(*)::int as n from route_versions where route_key = ${routeKey} and kind = 'publish' and id > ${since}`)[0]!.n;
  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  /** The Services screen's own update, carrying every field the form holds — as the form does. */
  const servicesForm = async (id: number, over: Record<string, string | number> = {}) => {
    const [row] = await sql<Record<string, unknown>[]>`select * from services where id = ${id}`;
    const fields: Record<string, string | number> = {
      id,
      slug: String(row!.slug),
      categoryId: Number(row!.category_id),
      subcategoryId: row!.subcategory_id === null ? "" : Number(row!.subcategory_id),
      titleEn: String(row!.title_en),
      titleAr: String(row!.title_ar),
      introEn: String(row!.intro_en),
      introAr: String(row!.intro_ar),
      bodyEn: String(row!.body_en),
      bodyAr: String(row!.body_ar),
      benefits: JSON.stringify(row!.benefits),
      audience: JSON.stringify(row!.audience),
      requirements: JSON.stringify(row!.requirements),
      processSteps: JSON.stringify(row!.process_steps),
      timelineEn: String(row!.timeline_en),
      timelineAr: String(row!.timeline_ar),
      notesEn: String(row!.notes_en),
      notesAr: String(row!.notes_ar),
      formPreset: String(row!.form_preset),
      imageId: row!.image_id === null ? "" : Number(row!.image_id),
      sortOrder: Number(row!.sort_order),
      ...(row!.is_published ? { isPublished: "on" } : {}),
      ...(row!.is_featured ? { isFeatured: "on" } : {}),
      ...over,
    };
    return () => call(SERVICES, "updateService", [{ ok: false }, form(fields)]);
  };

  /* ---------------------------------------------------------------------- */
  /* S1 — draft conflicts                                                   */
  /* ---------------------------------------------------------------------- */
  {
    const target = hero(first);
    const live = (await serviceRow(first)).title_en;
    const writers = 6;
    let clean = 0;
    for (let round = 0; round < LOOPS; round += 1) {
      const before = await region(target, pageOf(first));
      const results = await Promise.all(
        Array.from({ length: writers }, (_, i) => saveAt(target, pageOf(first), before.revision, english("title", `S1 round ${round} writer ${i}`)(before.values))),
      );
      const winners = results.map((result, i) => (result?.ok ? i : -1)).filter((i) => i >= 0);
      const conflicts = results.filter((result) => result && !result.ok && result.reason === "conflict").length;
      const after = await nodeRow(`serviceHero:${first}`);
      if (
        winners.length === 1 &&
        conflicts === writers - 1 &&
        after?.revision === before.revision + 1 &&
        after?.draft_content?.titleEn?.value === `S1 round ${round} writer ${winners[0]}` &&
        (await serviceRow(first)).title_en === live
      ) {
        clean += 1;
      }
    }
    say("S1. concurrent saves of one service region: exactly one wins, the rest conflict, the service row never moves", clean === LOOPS, `${clean}/${LOOPS} clean rounds`);
    await settle(routeOf(first));
  }

  /* ---------------------------------------------------------------------- */
  /* S2 — publish races publish                                             */
  /* ---------------------------------------------------------------------- */
  {
    const racers = 5;
    let clean = 0;
    let odd = "";
    for (let round = 0; round < LOOPS; round += 1) {
      const timeline = `S2 timeline ${round}`;
      await edit(hero(first), pageOf(first), english("timeline", timeline));
      const reviewed = await token(routeOf(first));
      const before = await mark();
      const results = await Promise.all(Array.from({ length: racers }, () => publishWith(routeOf(first), reviewed)));
      const published = results.filter((result) => result?.ok).length;
      const refused = results.filter((result) => result && !result.ok && ["stale", "conflict", "invalid"].includes(result.reason ?? "")).length;
      if (
        published === 1 &&
        refused === racers - 1 &&
        (await recordedSince(routeOf(first), before)) === 1 &&
        (await serviceRow(first)).timeline_en === timeline &&
        (await nodeRow(`serviceHero:${first}`))?.draft_content == null
      ) {
        clean += 1;
      } else if (!odd) {
        odd = `round ${round}: ${results.map((result) => (result?.ok ? "published" : `${result?.reason ?? "?"}`)).join(" | ")}`;
      }
    }
    say("S2. concurrent publications of one review: one publishes, one version, the rest refused", clean === LOOPS, `${clean}/${LOOPS} clean rounds${odd ? ` — ${odd}` : ""}`);
  }

  /* ---------------------------------------------------------------------- */
  /* S3 — reads during writes, and the caches                               */
  /* ---------------------------------------------------------------------- */
  {
    const path = await pathOf(first);
    const categoryPath = await categoryPathOf(first);
    let running = true;
    let reads = 0;
    let leaked = "";
    const draftMark = "S3 unpublished draft";
    const readOnce = async (lane: number, turn: number) => {
      const kind = (lane + turn) % 7;
      if (kind === 0 || kind === 1) {
        const answer = await read(kind === 0 ? path : `/ar${path}`);
        if (answer.body.includes(draftMark) || answer.body.includes("data-eod-")) leaked ||= `public ${kind === 0 ? "EN" : "AR"} read showed a draft or an editor mark`;
      } else if (kind === 2) {
        await read(`${path}?preview=1`, { signedIn: true });
      } else if (kind === 3) {
        await read(`${path}?preview=1&editor=1&bridge=${BRIDGE}`, { signedIn: true });
      } else if (kind === 4) {
        const answer = await read(path, { rsc: true });
        if (answer.body.includes(draftMark)) leaked ||= "the public RSC payload carried a draft";
      } else if (kind === 5) {
        const answer = await read(categoryPath);
        if (answer.body.includes(draftMark)) leaked ||= "the category page showed a draft";
      } else {
        await region(hero(first), pageOf(first));
        await token(routeOf(first));
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
      await edit(hero(first), pageOf(first), english("intro", `${draftMark} ${round}`));
      await discardWith(routeOf(first), await token(routeOf(first)));
      // …and one that is, read back the moment the publication answers.
      const intro = `S3 published introduction ${round}`;
      await edit(hero(first), pageOf(first), english("intro", intro));
      const published = await publishWith(routeOf(first), await token(routeOf(first)));
      const [page, arabic, category] = await Promise.all([read(path), read(`/ar${path}`), read(categoryPath)]);
      // The Arabic page falls back to the English introduction while it has none of its own.
      if (published?.ok && page.body.includes(intro) && arabic.status === 200 && category.body.includes(intro)) fresh += 1;
      else if (!first_) first_ = `round ${round}: published=${published?.ok ?? "?"} page=${page.body.includes(intro)} category=${category.body.includes(intro)}`;
    }
    running = false;
    await Promise.all(readers);
    say(
      "S3. reads of the page, its preview, canvas, payload, category and editor during drafts, discards and publications: all whole, no draft in public",
      !leaked && incidents.length === 0 && reads > LOOPS * 8,
      leaked || (incidents[0] ?? `${reads} reads`),
    );
    say("S3. the moment a publication answers, the page and its category show it — the caches were dropped", fresh === LOOPS, `${fresh}/${LOOPS}${first_ ? ` — ${first_}` : ""}`);
  }

  /* ---------------------------------------------------------------------- */
  /* S4 — publish races the Services form on a drafted field                 */
  /* ---------------------------------------------------------------------- */
  {
    let exact = 0;
    let landed = 0;
    let refused = 0;
    let odd = "";
    for (let round = 0; round < LOOPS; round += 1) {
      await settle(routeOf(second));
      const colour = round % 2 === 0 ? "peach" : "strong";
      await edit(hero(second), pageOf(second), english("intro", `S4 draft ${round}`));
      const styled = await region(hero(second), pageOf(second));
      const styleAnswer = await call(VE, "saveRouteRegionStyles", [
        form({
          sectionId: editorKeyOf(hero(second)),
          pageId: pageOf(second),
          expectedRevision: styled.revision,
          styles: JSON.stringify({ v: STYLE_DOCUMENT_VERSION, nodes: { "field:title": { base: { textColor: colour } } } }),
        }),
      ]);
      if (!styleAnswer?.ok) throw new Error(`could not style: ${styleAnswer?.message ?? "no answer"}`);
      const stylesBefore = JSON.stringify((await nodeRow(`serviceHero:${second}`))?.styles ?? null);
      const reviewed = await token(routeOf(second));
      const before = await mark();
      const formIntro = `S4 form ${round}`;
      const save = await servicesForm(second, { introEn: formIntro });
      const hold = 10 + (round % 5) * 30;
      const [published, saved] = await Promise.all([
        wait(round % 2 === 1 ? hold : 0).then(() => publishWith(routeOf(second), reviewed)),
        wait(round % 2 === 0 ? hold : 0).then(save),
      ]);
      const node = await nodeRow(`serviceHero:${second}`);
      const recorded = (await recordedSince(routeOf(second), before)) === 1;
      const stylesAfter = JSON.stringify(node?.styles ?? null);
      const whole = published?.ok === true && recorded && stylesAfter.includes(`"${colour}"`) && node?.draft_styles == null && node?.draft_content == null;
      const nothing =
        published?.ok === false && published.reason === "conflict" && !recorded && stylesAfter === stylesBefore && node?.draft_styles != null && node?.draft_content != null;
      const formLanded = saved?.ok === true && (await serviceRow(second)).intro_en === formIntro;
      if (formLanded && (whole || nothing)) exact += 1;
      else if (!odd) odd = JSON.stringify({ round, published, saved: saved?.ok ?? saved, recorded, intro: (await serviceRow(second)).intro_en });
      if (whole) landed += 1;
      if (nothing) refused += 1;
    }
    say(
      "S4. a publication racing the Services form lands whole or is refused with nothing written; the form always lands",
      exact === LOOPS,
      `${exact}/${LOOPS} exact — ${landed} published whole, ${refused} refused as a conflict${odd ? ` — first other: ${odd}` : ""}`,
    );
    await settle(routeOf(second));
  }

  /* ---------------------------------------------------------------------- */
  /* S5 — publish races a move to another category                          */
  /* ---------------------------------------------------------------------- */
  {
    const home = await serviceRow(second);
    let exact = 0;
    let formLast = 0;
    let odd = "";
    for (let round = 0; round < LOOPS; round += 1) {
      await settle(routeOf(second));
      const to = round % 2 === 0 ? elsewhere!.id : home.category_id;
      const group = to === home.category_id ? (home.subcategory_id ?? "") : "";
      const timeline = `S5 timeline ${round}`;
      await edit(hero(second), pageOf(second), english("timeline", timeline));
      const reviewed = await token(routeOf(second));
      // The form as an admin opened it, before the publication: it saves every field it holds.
      const opened = (await serviceRow(second)).timeline_en;
      const move = await servicesForm(second, { categoryId: to, subcategoryId: group });
      const hold = 10 + (round % 4) * 25;
      const [published, moved] = await Promise.all([
        wait(round % 2 === 1 ? hold : 0).then(() => publishWith(routeOf(second), reviewed)),
        wait(round % 2 === 0 ? hold : 0).then(move),
      ]);
      const row = await serviceRow(second);
      const keys = (await sql<{ route_key: string }[]>`select distinct route_key from route_nodes where owner_key ~ ${`^service[A-Z][A-Za-z]*:${second}$`}`).map((entry) => entry.route_key);
      const page = await read(await pathOf(second));
      // A move changes no drafted column, so the publication is never refused for it. The
      // form saved last puts back the timeline it was opened with — as it always has; the
      // form saved first leaves the publication to land on top of it.
      if (row.timeline_en === opened) formLast += 1;
      if (
        published?.ok === true &&
        moved?.ok === true &&
        row.category_id === to &&
        (row.timeline_en === timeline || row.timeline_en === opened) &&
        (await nodeRow(`serviceHero:${second}`))?.draft_content == null &&
        keys.join(",") === routeOf(second) &&
        page.status === 200 &&
        (!row.timeline_en || page.body.includes(row.timeline_en))
      ) {
        exact += 1;
      } else if (!odd) {
        odd = JSON.stringify({ round, published, moved: moved?.ok ?? moved, category: row.category_id, to, keys, status: page.status, timeline: row.timeline_en });
      }
    }
    // Home again, in its own group.
    await (await servicesForm(second, { categoryId: home.category_id, subcategoryId: home.subcategory_id ?? "" }))();
    const back = await serviceRow(second);
    say(
      "S5. a publication racing a move: both land, on the same row and the same identity, the page at its new address",
      exact === LOOPS && back.category_id === home.category_id && back.subcategory_id === home.subcategory_id,
      `${exact}/${LOOPS} — the form saved last in ${formLast}${odd ? ` — first other: ${odd}` : ""}`,
    );
    await settle(routeOf(second));
  }

  /* ---------------------------------------------------------------------- */
  /* S6 — the category page and the service page publish one column at once */
  /* ---------------------------------------------------------------------- */
  {
    const categoryRoute = `category:${categoryId}`;
    const categoryPage = documentEditorKey({ kind: "category", id: categoryId });
    let exact = 0;
    let fromCard = 0;
    let fromPage = 0;
    let odd = "";
    for (let round = 0; round < LOOPS; round += 1) {
      await settle(categoryRoute, routeOf(third));
      const cardText = `S6 card ${round}`;
      const pageText = `S6 page ${round}`;
      await edit({ type: "service", id: third }, categoryPage, english("intro", cardText));
      await edit(hero(third), pageOf(third), english("intro", pageText));
      const [cardToken, pageToken] = [await token(categoryRoute), await token(routeOf(third))];
      const started = Date.now();
      const [card, own] = await Promise.all([
        wait(round % 2 === 1 ? 15 : 0).then(() => publishWith(categoryRoute, cardToken)),
        wait(round % 2 === 0 ? 15 : 0).then(() => publishWith(routeOf(third), pageToken)),
      ]);
      const took = Date.now() - started;
      const live = (await serviceRow(third)).intro_en;
      const cardDraft = (await nodeRow(`service:${third}`))?.draft_content?.introEn?.value;
      const pageDraft = (await nodeRow(`serviceHero:${third}`))?.draft_content?.introEn?.value;
      const cardWon = card?.ok === true && own?.ok === false && own.reason === "conflict" && live === cardText && cardDraft === undefined && pageDraft === pageText;
      const pageWon = own?.ok === true && card?.ok === false && card.reason === "conflict" && live === pageText && pageDraft === undefined && cardDraft === cardText;
      if ((cardWon || pageWon) && took < 15_000) exact += 1;
      else if (!odd) odd = JSON.stringify({ round, card, own, live, cardDraft, pageDraft, took });
      if (cardWon) fromCard += 1;
      if (pageWon) fromPage += 1;
    }
    say(
      "S6. the category page and the service page publishing one column at once: exactly one lands, the other keeps its draft, neither waits for ever",
      exact === LOOPS,
      `${exact}/${LOOPS} exact — the card won ${fromCard}, the page ${fromPage}${odd ? ` — first other: ${odd}` : ""}`,
    );
    await settle(categoryRoute, routeOf(third));
  }

  /* ---------------------------------------------------------------------- */
  /* S7 — a rename races a publication of the title                         */
  /* ---------------------------------------------------------------------- */
  {
    let exact = 0;
    let landed = 0;
    let odd = "";
    for (let round = 0; round < LOOPS; round += 1) {
      await settle(routeOf(first));
      const drafted = `S7 drafted title ${round}`;
      const renamed = `S7 renamed ${round}`;
      await edit(hero(first), pageOf(first), english("title", drafted));
      const reviewed = await token(routeOf(first));
      const before = await mark();
      const rename = await servicesForm(first, { titleEn: renamed });
      const hold = 10 + (round % 5) * 30;
      const [published, saved] = await Promise.all([
        wait(round % 2 === 1 ? hold : 0).then(() => publishWith(routeOf(first), reviewed)),
        wait(round % 2 === 0 ? hold : 0).then(rename),
      ]);
      const recorded = (await recordedSince(routeOf(first), before)) === 1;
      const node = await nodeRow(`serviceHero:${first}`);
      const row = await serviceRow(first);
      // The form always lands. Last, its title is live; first, the publication finds the
      // title moved since its draft began and refuses, keeping the draft.
      const whole = published?.ok === true && recorded && node?.draft_content == null;
      const nothing = published?.ok === false && published.reason === "conflict" && !recorded && node?.draft_content?.titleEn?.value === drafted;
      if (saved?.ok === true && row.title_en === renamed && node?.route_key === routeOf(first) && (whole || nothing)) exact += 1;
      else if (!odd) odd = JSON.stringify({ round, published, saved: saved?.ok ?? saved, title: row.title_en, recorded });
      if (whole) landed += 1;
    }
    say(
      "S7. a rename racing a publication of the title: the rename always lands, the publication lands whole or not at all, the identity never moves",
      exact === LOOPS,
      `${exact}/${LOOPS} exact — ${landed} published first${odd ? ` — first other: ${odd}` : ""}`,
    );
    await settle(routeOf(first));
  }

  /* ---------------------------------------------------------------------- */
  /* S8 — discard races a new edit elsewhere on the page                    */
  /* ---------------------------------------------------------------------- */
  {
    let kept = 0;
    for (let round = 0; round < LOOPS; round += 1) {
      await settle(routeOf(first));
      await edit(hero(first), pageOf(first), english("timeline", `S8 reviewed ${round}`));
      const reviewed = await token(routeOf(first));
      const other: RouteOwner = { type: "serviceOverview", id: first };
      const current = await region(other, pageOf(first));
      const text = `S8 unreviewed ${round}`;
      const [discarded, saved] = await Promise.all([
        discardWith(routeOf(first), reviewed),
        saveAt(other, pageOf(first), current.revision, english("heading", text)(current.values)),
      ]);
      const survivor = (await nodeRow(`serviceOverview:${first}`))?.draft_content?.["copy:headingEn"]?.value;
      const reviewedDraft = (await nodeRow(`serviceHero:${first}`))?.draft_content?.timelineEn?.value;
      const consistent = discarded?.ok ? reviewedDraft === undefined : reviewedDraft === `S8 reviewed ${round}`;
      if (saved?.ok && survivor === text && consistent) kept += 1;
    }
    say("S8. a discard racing a new edit elsewhere on the page never takes the edit it was not shown", kept === LOOPS, `${kept}/${LOOPS} rounds`);
    await settle(routeOf(first));
  }

  /* ---------------------------------------------------------------------- */
  /* S9 — components created and deleted while the page is published         */
  /* ---------------------------------------------------------------------- */
  {
    let components = 0;
    let publications = 0;
    for (let round = 0; round < LOOPS; round += 1) {
      const timeline = `S9 timeline ${round}`;
      await edit(hero(third), pageOf(third), english("timeline", timeline));
      const reviewed = await token(routeOf(third));
      const churn = Array.from({ length: 3 }, async (_, i) => {
        const created = await call<{ ok: boolean; component?: { id: number; revision: number } }>(COMPONENTS, "createReusableComponent", [
          form({ kind: "cta", name: `S9 component ${round}-${i}-${Date.now()}`, publish: "0" }),
        ]);
        if (!created?.ok || !created.component) return false;
        const removed = await call(COMPONENTS, "deleteReusable", [form({ id: created.component.id, expectedRevision: created.component.revision })]);
        return removed?.ok === true;
      });
      const [published, ...churned] = await Promise.all([publishWith(routeOf(third), reviewed), ...churn]);
      if (published?.ok && (await serviceRow(third)).timeline_en === timeline) publications += 1;
      components += churned.filter(Boolean).length;
    }
    const [{ n: left }] = await sql<{ n: number }[]>`select count(*)::int as n from reusable_components where name like 'S9 component %'`;
    say(
      "S9. components created and deleted while the page publishes: every action answers, none is left, every publication lands",
      components === LOOPS * 3 && publications === LOOPS && left === 0,
      `${components}/${LOOPS * 3} components, ${publications}/${LOOPS} publications, ${left} left`,
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

  // Nothing above may have created or lost a domain record, or touched the page CMS.
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
