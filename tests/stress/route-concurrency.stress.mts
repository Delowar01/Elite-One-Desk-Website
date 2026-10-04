/**
 * Batch 21 stress: the concurrency questions a service-category page raises in
 * the Visual Editor, each asked many times against a running server and each
 * answer checked against the database rather than against the answers.
 *
 *   R1  draft conflicts — N saves of one region at one revision: exactly one
 *       wins, the rest are refused as conflicts, nothing is merged, and the
 *       live record never moves
 *   R2  publish races publish — N publications of one reviewed set of drafts:
 *       exactly one publishes and records one version, the rest are refused
 *   R3  publish races the Services list's show/hide — a publication of a
 *       card's visibility and introduction against the list's own toggle,
 *       sent in both orders: the toggle only ever moves visibility to the
 *       value the draft already holds, so it is never a conflict, and the
 *       publication lands whole every time. (The toggle reads, then writes,
 *       without a lock — as it always has — so which way it leaves the flag is
 *       its own business; the introduction, which only the publication writes,
 *       shows whether the publication landed whole.)
 *   R4  publish races the Services form — a card's introduction and a style,
 *       against the form saving a different introduction, in both orders:
 *       exactly one lands — the publication whole (words and style), or the
 *       form — and the other is refused as a conflict with nothing written.
 *       (Until Batch 23 the form always landed, writing every column it held.)
 *   R5  publish races new edits — a reviewed set published while the same
 *       regions are edited again: the page gets exactly what was reviewed or
 *       nothing, and an edit made after the review is never published unseen
 *   R6  discard races a new edit elsewhere on the page — the new draft, never
 *       reviewed, always survives
 *
 *   STRESS_LOOPS=15 (rounds per question)
 */
import { callAction } from "../helpers/action";
import { giveFresh } from "../helpers/fixtures";
import { connect, dropDatabase } from "../helpers/pg";
import { startServer } from "../helpers/server";
import { openServiceForm } from "../helpers/service-form";
import { signIn } from "../helpers/session";

import { STYLE_DOCUMENT_VERSION } from "../../src/lib/cms/styles";
import { documentEditorKey, editorKeyOf, type RouteOwner } from "../../src/lib/routes/owners";

const PORT = 3818;
const LOOPS = Number(process.env.STRESS_LOOPS ?? 15);
const VE = { route: "/admin/visual-editor", file: "app/(backoffice)/admin/visual-editor/route-actions.ts" };
const SERVICES = { route: "/admin/services", file: "app/(backoffice)/admin/(shell)/services/actions.ts" };
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

type Values = Record<string, unknown>;
type Answer = { ok: boolean; reason?: string; message?: string; conflicts?: string[] };
type Region = { revision: number; values: Values };

const database = giveFresh("route_concurrency_stress");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);
  const origin = server.origin;

  // A category with a group of three or more cards, chosen by its data rather than its name.
  const [subject] = await sql<{ category_id: number; subcategory_id: number }[]>`
    select s.category_id, s.subcategory_id from services s join service_subcategories g on g.id = s.subcategory_id
     where s.is_published and g.is_published
     group by s.category_id, s.subcategory_id having count(*) >= 3 order by s.category_id limit 1`;
  const categoryId = subject!.category_id;
  const routeKey = `category:${categoryId}`;
  const pageId = documentEditorKey({ kind: "category", id: categoryId });
  const cards = (
    await sql<{ id: number }[]>`
      select id from services where subcategory_id = ${subject!.subcategory_id} and is_published order by sort_order, id limit 3`
  ).map((row) => row.id);
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
  const call = async <T extends object = Answer>(where: { route: string; file: string }, action: string, args: unknown[]) =>
    (await callAction<T>({ ...where, origin, action, args, cookie: owner.cookie })).value;
  const region = async (target: RouteOwner): Promise<Region> => {
    const answer = await call<{ ok: boolean; message?: string; section?: Region }>(VE, "loadRouteRegion", [editorKeyOf(target), pageId]);
    if (!answer?.ok || !answer.section) throw new Error(`could not load ${target.type}:${target.id}: ${answer?.message ?? "no answer"}`);
    return answer.section;
  };
  /** A region's draft saved as the editor saves it: with the values it was loaded with as its base (Batch 23). */
  const saveAt = (target: RouteOwner, revision: number, values: Values, base?: Values) =>
    call(VE, "saveRouteRegionDraft", [
      form({
        sectionId: editorKeyOf(target),
        pageId,
        expectedRevision: revision,
        values: JSON.stringify(values),
        ...(base ? { baseValues: JSON.stringify(base) } : {}),
      }),
    ]);
  const edit = async (target: RouteOwner, change: (values: Values) => Values) => {
    const current = await region(target);
    const answer = await saveAt(target, current.revision, change(current.values), current.values);
    if (!answer?.ok) throw new Error(`could not save ${target.type}:${target.id}: ${answer?.message ?? "no answer"}`);
  };
  const english = (field: string, text: string) => (values: Values) => ({
    ...values,
    [field]: { ...(values[field] as object), en: text },
  });
  const token = async () => {
    const view = await call<{ token: string }>(VE, "loadRouteSummary", [routeKey]);
    if (!view) throw new Error("no summary");
    return view.token;
  };
  const publishWith = (reviewed: string) => call(VE, "publishRouteFromEditor", [form({ routeKey, token: reviewed })]);
  const discardWith = (reviewed: string) => call(VE, "discardRouteFromEditor", [form({ routeKey, token: reviewed })]);
  const settle = async () => {
    const reviewed = await token();
    if (reviewed) await discardWith(reviewed);
  };

  const categoryRow = async () =>
    (await sql<{ title_en: string; tagline_en: string }[]>`select title_en, tagline_en from service_categories where id = ${categoryId}`)[0]!;
  const serviceRow = async (id: number) =>
    (await sql<{ intro_en: string; is_published: boolean }[]>`select intro_en, is_published from services where id = ${id}`)[0]!;
  const nodeRow = async (ownerKey: string) =>
    (await sql<{ revision: number; draft_content: Record<string, { value: unknown }> | null }[]>`
      select revision, draft_content from route_nodes where owner_key = ${ownerKey}`)[0] ?? null;
  // The route keeps its newest 30 publications, so a count stops moving once it is full:
  // what a round recorded is counted by id, from a mark taken before it.
  const mark = async () =>
    (await sql<{ id: number }[]>`select coalesce(max(id), 0)::int as id from route_versions`)[0]!.id;
  const recordedSince = async (since: number) =>
    (await sql<{ n: number }[]>`
      select count(*)::int as n from route_versions where route_key = ${routeKey} and kind = 'publish' and id > ${since}`)[0]!.n;

  /* ---------------------------------------------------------------------- */
  /* R1 — draft conflicts                                                   */
  /* ---------------------------------------------------------------------- */
  {
    const hero: RouteOwner = { type: "category", id: categoryId };
    const live = (await categoryRow()).title_en;
    const writers = 6;
    let clean = 0;
    for (let round = 0; round < LOOPS; round += 1) {
      const before = await region(hero);
      const results = await Promise.all(
        Array.from({ length: writers }, (_, i) => saveAt(hero, before.revision, english("title", `R1 round ${round} writer ${i}`)(before.values))),
      );
      const winners = results.map((result, i) => (result?.ok ? i : -1)).filter((i) => i >= 0);
      const conflicts = results.filter((result) => result && !result.ok && result.reason === "conflict").length;
      const after = await nodeRow(`category:${categoryId}`);
      const stored = after?.draft_content?.titleEn?.value;
      if (
        winners.length === 1 &&
        conflicts === writers - 1 &&
        after?.revision === before.revision + 1 &&
        stored === `R1 round ${round} writer ${winners[0]}` &&
        (await categoryRow()).title_en === live
      ) {
        clean += 1;
      }
    }
    say("R1. concurrent saves of one region: exactly one wins, the rest conflict, the live record never moves", clean === LOOPS, `${clean}/${LOOPS} clean rounds`);
    await settle();
  }

  /* ---------------------------------------------------------------------- */
  /* R2 — publish races publish                                             */
  /* ---------------------------------------------------------------------- */
  {
    const hero: RouteOwner = { type: "category", id: categoryId };
    const racers = 5;
    let clean = 0;
    let first = "";
    for (let round = 0; round < LOOPS; round += 1) {
      const tagline = `R2 tagline ${round}`;
      await edit(hero, english("tagline", tagline));
      const reviewed = await token();
      const before = await mark();
      const results = await Promise.all(Array.from({ length: racers }, () => publishWith(reviewed)));
      const published = results.filter((result) => result?.ok).length;
      // A loser finds either drafts other than the ones it was shown ("stale") or, once the
      // winner has cleared them, nothing left to publish ("invalid"). Both write nothing.
      const refused = results.filter((result) => result && !result.ok && ["stale", "conflict", "invalid"].includes(result.reason ?? "")).length;
      if (
        published === 1 &&
        refused === racers - 1 &&
        (await recordedSince(before)) === 1 &&
        (await categoryRow()).tagline_en === tagline &&
        (await nodeRow(`category:${categoryId}`))?.draft_content == null
      ) {
        clean += 1;
      } else if (!first) {
        first = `round ${round}: ${results.map((result) => (result?.ok ? "published" : `${result?.reason ?? "?"}: ${result?.message ?? ""}`)).join(" | ")}`;
      }
    }
    say("R2. concurrent publications of one review: one publishes, one version, the rest refused", clean === LOOPS, `${clean}/${LOOPS} clean rounds${first ? ` — ${first}` : ""}`);
  }

  /* ---------------------------------------------------------------------- */
  /* R3 — publish races the Services screen                                 */
  /* ---------------------------------------------------------------------- */
  {
    const card: RouteOwner = { type: "service", id: cards[0]! };
    let whole = 0;
    for (let round = 0; round < LOOPS; round += 1) {
      await settle();
      const start = await serviceRow(card.id);
      const intro = `R3 introduction ${round}`;
      // The draft hides the card (if shown) or shows it (if hidden), and rewrites its introduction.
      await edit(card, (values) => ({ ...english("intro", intro)(values), published: !start.is_published }));
      const reviewed = await token();
      const before = await mark();
      // Every other round the publication is sent a little later, so both orders are met.
      const later = round % 2 === 1 ? 25 + (round % 4) * 20 : 0;
      const [published, toggled] = await Promise.all([
        new Promise<void>((resolve) => setTimeout(resolve, later)).then(() => publishWith(reviewed)),
        call(SERVICES, "toggleServicePublished", [{ ok: false }, form({ id: card.id })]),
      ]);
      const end = await serviceRow(card.id);
      const recorded = (await recordedSince(before)) === 1;
      // The screen's toggle always lands; the publication lands whole or not at all.
      const landedWhole =
        published?.ok === true &&
        recorded &&
        end.intro_en === intro &&
        (await nodeRow(`service:${card.id}`))?.draft_content == null;
      if (toggled?.ok && landedWhole) whole += 1;
    }
    say("R3. a publication racing the Services list's show/hide lands whole", whole === LOOPS, `${whole}/${LOOPS} whole`);
    await settle();
  }

  /* ---------------------------------------------------------------------- */
  /* R4 — publish races the Services form on a patched field                 */
  /* ---------------------------------------------------------------------- */
  {
    const card: RouteOwner = { type: "service", id: cards[2]! };
    let exact = 0;
    let landed = 0;
    let refused = 0;
    let odd = "";
    for (let round = 0; round < LOOPS; round += 1) {
      await settle();
      const colour = round % 2 === 0 ? "peach" : "strong";
      await edit(card, english("intro", `R4 draft ${round}`));
      const styled = await region(card);
      const styleAnswer = await call(VE, "saveRouteRegionStyles", [
        form({
          sectionId: editorKeyOf(card),
          pageId,
          expectedRevision: styled.revision,
          styles: JSON.stringify({ v: STYLE_DOCUMENT_VERSION, nodes: { "field:title": { base: { textColor: colour } } } }),
        }),
      ]);
      if (!styleAnswer?.ok) throw new Error(`could not style: ${styleAnswer?.message ?? "no answer"}`);
      const stylesBefore = JSON.stringify((await sql<{ styles: unknown }[]>`select styles from route_nodes where owner_key = ${`service:${card.id}`}`)[0]?.styles ?? null);
      const reviewed = await token();
      const before = await mark();
      const formIntro = `R4 form ${round}`;
      // The Services form as an admin opens it now: every field, and the base its page signs.
      const opened = await openServiceForm(sql, origin, owner.cookie, card.id);
      // Each side is held back in turn, by a little more each time, so both orders are met.
      const hold = 10 + (round % 5) * 30;
      const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
      const [published, saved] = await Promise.all([
        wait(round % 2 === 1 ? hold : 0).then(() => publishWith(reviewed)),
        wait(round % 2 === 0 ? hold : 0).then(() => call(SERVICES, "updateService", [{ ok: false }, form({ ...opened, introEn: formIntro })])),
      ]);
      const node = (await sql<{ styles: unknown; draft_styles: unknown; draft_content: unknown }[]>`
        select styles, draft_styles, draft_content from route_nodes where owner_key = ${`service:${card.id}`}`)[0];
      const recorded = (await recordedSince(before)) === 1;
      const stylesAfter = JSON.stringify(node?.styles ?? null);
      const whole =
        published?.ok === true &&
        recorded &&
        stylesAfter.includes(`"${colour}"`) &&
        node?.draft_styles == null &&
        node?.draft_content == null;
      const nothing =
        published?.ok === false &&
        published.reason === "conflict" &&
        !recorded &&
        stylesAfter === stylesBefore &&
        node?.draft_styles != null &&
        node?.draft_content != null;
      // Both changed the introduction: exactly one lands (Batch 23). The form first, the
      // publication finds the column moved and writes nothing; the publication first, the
      // form finds it moved since it was opened and writes nothing.
      const intro = (await serviceRow(card.id)).intro_en;
      const formWon = saved?.ok === true && nothing && intro === formIntro;
      const editorWon = whole && saved?.ok === false && (saved.conflicts ?? []).join() === "introEn" && intro === `R4 draft ${round}`;
      if (formWon || editorWon) exact += 1;
      else if (!odd) {
        odd = JSON.stringify({
          round,
          published,
          saved: saved?.ok ?? saved,
          recorded,
          stylesBefore,
          stylesAfter,
          draftStyles: node?.draft_styles != null,
          draftContent: node?.draft_content ?? null,
          intro: (await serviceRow(card.id)).intro_en,
        });
      }
      if (whole) landed += 1;
      if (nothing) refused += 1;
    }
    say(
      "R4. a publication racing the Services form on the same field: exactly one lands — the publication whole, or the form — the other writes nothing",
      exact === LOOPS,
      `${exact}/${LOOPS} exact — ${landed} published whole, ${refused} refused as a conflict${odd ? ` — first other: ${odd}` : ""}`,
    );
    await settle();
  }

  /* ---------------------------------------------------------------------- */
  /* R5 — publish races new edits of the reviewed regions                    */
  /* ---------------------------------------------------------------------- */
  {
    let exact = 0;
    let landed = 0;
    for (let round = 0; round < LOOPS; round += 1) {
      await settle();
      const starts = await Promise.all(cards.map((id) => serviceRow(id)));
      const reviewedText = (id: number) => `R5 reviewed ${round} card ${id}`;
      const laterText = (id: number) => `R5 later ${round} card ${id}`;
      for (const id of cards) await edit({ type: "service", id }, english("intro", reviewedText(id)));
      const reviewed = await token();
      const regions = await Promise.all(cards.map((id) => region({ type: "service", id })));
      const [published] = await Promise.all([
        publishWith(reviewed),
        ...cards.map((id, index) => saveAt({ type: "service", id }, regions[index]!.revision, english("intro", laterText(id))(regions[index]!.values))),
      ]);
      const ends = await Promise.all(cards.map((id) => serviceRow(id)));
      const allReviewed = ends.every((row, index) => row.intro_en === reviewedText(cards[index]!));
      const noneMoved = ends.every((row, index) => row.intro_en === starts[index]!.intro_en);
      const laterNeverLive = ends.every((row, index) => row.intro_en !== laterText(cards[index]!));
      if (laterNeverLive && ((published?.ok === true && allReviewed) || (published?.ok === false && noneMoved))) exact += 1;
      if (published?.ok) landed += 1;
    }
    say(
      "R5. a review published while its regions are edited again: exactly what was reviewed, or nothing",
      exact === LOOPS,
      `${exact}/${LOOPS} exact — ${landed} published, ${LOOPS - landed} refused as stale`,
    );
    await settle();
  }

  /* ---------------------------------------------------------------------- */
  /* R6 — discard races a new edit elsewhere on the page                    */
  /* ---------------------------------------------------------------------- */
  {
    let kept = 0;
    for (let round = 0; round < LOOPS; round += 1) {
      await settle();
      await edit({ type: "service", id: cards[0]! }, english("intro", `R6 reviewed ${round}`));
      const reviewed = await token();
      const elsewhere: RouteOwner = { type: "service", id: cards[1]! };
      const current = await region(elsewhere);
      const text = `R6 unreviewed ${round}`;
      const [discarded, saved] = await Promise.all([
        discardWith(reviewed),
        saveAt(elsewhere, current.revision, english("intro", text)(current.values)),
      ]);
      const survivor = (await nodeRow(`service:${elsewhere.id}`))?.draft_content?.introEn?.value;
      const first = (await nodeRow(`service:${cards[0]!}`))?.draft_content?.introEn?.value;
      const consistent = discarded?.ok ? first === undefined : first === `R6 reviewed ${round}`;
      if (saved?.ok && survivor === text && consistent) kept += 1;
    }
    say("R6. a discard racing a new edit elsewhere never takes the edit it was not shown", kept === LOOPS, `${kept}/${LOOPS} rounds`);
    await settle();
  }

  // However many publications later — every one is in the activity log — the history is
  // the newest thirty of them and the baseline.
  const [kept] = await sql<{ publish: number; baseline: number; logged: number }[]>`
    select count(*) filter (where kind = 'publish')::int as publish, count(*) filter (where kind = 'baseline')::int as baseline,
           (select count(*)::int from activity_logs where action = 'route.published') as logged
      from route_versions where route_key = ${routeKey}`;
  say(
    "the history kept its newest thirty publications and its baseline",
    kept!.publish === Math.min(30, kept!.logged) && kept!.baseline === 1,
    JSON.stringify(kept),
  );

  // Nothing above may have created or lost a domain record, or touched the page CMS.
  const endCounts = await recordCounts();
  say(
    "the storms created and lost no record, and wrote nothing into the page CMS",
    JSON.stringify(endCounts) === JSON.stringify(startCounts),
    JSON.stringify(endCounts),
  );
} finally {
  await server?.stop();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
