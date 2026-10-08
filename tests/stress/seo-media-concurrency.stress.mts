/**
 * Batch 25 stress: the new race surface — SEO records, the pictures they name
 * and the records they belong to, written at once (docs/admin/seo-and-share-images.md
 * B.9, B.11). Each question is asked many times against a running server, and
 * each answer is checked against the database rather than against the answers.
 *
 *   M1  six SEO forms opened together on one record, each changing its own
 *       field: all six land, on one row. Rotated through a page, both
 *       overviews, a category, a service, a destination and a package
 *   M2  six forms on one record changing the same field: exactly one lands,
 *       the other five are refused by name and write nothing
 *   M3  first saves on a record with no row yet, all at once — different
 *       fields and then the same one: one row, never two, never an error
 *   M4  share images chosen while their pictures are deleted, several pairs
 *       and a picture two records choose at once: one side of each pair wins,
 *       never both; a saved choice keeps its picture; a deleted picture is
 *       named by nothing
 *   M5  a destination's address changed while its SEO is saved: both land,
 *       on one identity — one row, bound to the destination, at its new address
 *   M6  a service moved to another category while its SEO is saved: the same
 *   M7  a destination deleted while its SEO is saved: its record goes with it,
 *       whichever came first — the save landed and went, or was told the page
 *       no longer exists
 *
 * Throughout, the public pages of every record above are read in both
 * editions: every answer whole. After the storms every page shows its stored
 * record on the next read, no row is bound to a record that is gone or keyed
 * by an address its record does not have, and the server wrote no failure
 * (21A's `serverFailureLines`). STRESS_LOOPS=15 (rounds per question).
 */
import { callAction } from "../helpers/action";
import { isNavigationDigest, payloadErrors, serverFailureLines } from "../helpers/diagnostics";
import { giveFresh } from "../helpers/fixtures";
import { openDestinationForm, withChanges } from "../helpers/package-form";
import { connect, dropDatabase } from "../helpers/pg";
import { startServer } from "../helpers/server";
import { addressOf, openSeoForm, withSeoChanges, type SeoFields } from "../helpers/seo-form";
import { changedForm, openServiceForm } from "../helpers/service-form";
import { signIn } from "../helpers/session";

const PORT = 3822;
const LOOPS = Number(process.env.STRESS_LOOPS ?? 15);
const SEO = { route: "/admin/seo", file: "app/(backoffice)/admin/(shell)/seo/actions.ts" };
const MEDIA = { route: "/admin/media", file: "app/(backoffice)/admin/(shell)/media/actions.ts" };
const DESTINATION_FILE = "app/(backoffice)/admin/(shell)/packages/destinations/actions.ts";
const SERVICE_FILE = "app/(backoffice)/admin/(shell)/services/actions.ts";
/** What `runAction` answers when an exception it did not expect escaped — a deadlock, a unique violation. */
const UNEXPECTED = "Something went wrong. The change was not saved.";

const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

type Answer = { ok: boolean; message?: string; conflicts?: string[] };

const database = giveFresh("seo_media_stress");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  const idOf = async (table: string, slug: string) =>
    (await sql.unsafe<{ id: number }[]>(`select id from ${table} where slug = $1`, [slug]))[0]!.id;
  const about = await idOf("pages", "about");
  const egypt = await idOf("package_destinations", "egypt");
  const business = await idOf("service_categories", "business-setup");
  const travel = await idOf("service_categories", "travel-tourism");
  const cairo = await idOf("travel_packages", "cairo-and-giza-classic");
  const [mover] = await sql<{ id: number }[]>`select id from services where category_id = ${travel} order by sort_order, id limit 1`;
  const [rotating] = await sql<{ id: number }[]>`
    select s.id from services s join service_categories c on c.id = s.category_id
     where c.slug = 'license-renewal' order by s.sort_order, s.id limit 1`;
  // M3's records: services no other question touches, two per round.
  const fresh = (
    await sql<{ id: number }[]>`
      select id from services where id not in (${mover!.id}, ${rotating!.id}) order by id desc limit ${2 * LOOPS}`
  ).map((row) => row.id);
  if (fresh.length < 2 * LOOPS) throw new Error(`M3 needs ${2 * LOOPS} services, the fixture has ${fresh.length}`);

  server = await startServer(database, PORT);
  const origin = server.origin;

  /* ---------------------------------------------------------------- */
  /* Calling the screens, and checking every answer                    */
  /* ---------------------------------------------------------------- */
  const incidents: string[] = [];
  const form = (fields: Record<string, string | number>) => {
    const data = new FormData();
    data.set("_csrf", owner.csrfToken);
    for (const [key, value] of Object.entries(fields)) data.set(key, String(value));
    return data;
  };
  const act = async (where: { route: string; file: string }, action: string, fields: Record<string, string | number>): Promise<Answer> => {
    const answer = await callAction<Answer>({ ...where, origin, action, args: [{ ok: false }, form(fields)], cookie: owner.cookie });
    const failed = payloadErrors(answer.text).filter((row) => !isNavigationDigest(row.digest));
    if (answer.status >= 500 || failed.length) incidents.push(`${answer.status} ${action}: ${failed.map((row) => row.row).join(" | ") || answer.text.slice(0, 200)}`);
    // A delete answers with a redirect (no value); everything else answers with a state.
    const value = answer.value ?? { ok: answer.status < 400 };
    if (value.message === UNEXPECTED) incidents.push(`${action}: ${UNEXPECTED}`);
    return value;
  };
  const open = (target: string) => openSeoForm(sql, origin, owner.cookie, target);
  const saveSeo = (opened: SeoFields, changes: Record<string, string | number | null>) =>
    act(SEO, "saveSeo", withSeoChanges(opened, changes) as Record<string, string | number>);

  /** The rows a record has — bound to it, or by address at its address — and the overviews' by key. */
  const rowsOf = async (target: string) => {
    const [kind, raw] = target.split(":") as [string, string];
    const id = Number(raw);
    if (kind === "serviceIndex" || kind === "packageIndex") {
      return sql<Record<string, unknown>[]>`
        select * from seo_metadata where entity_type = 'page' and entity_id is null and entity_key = ${kind === "serviceIndex" ? "services" : "packages"}`;
    }
    const address = await addressOf(sql, kind, id);
    return sql<Record<string, unknown>[]>`
      select * from seo_metadata where entity_type = ${kind}
         and (entity_id = ${id} ${address === null ? sql`` : sql`or (entity_id is null and entity_key = ${address})`})`;
  };

  /* ---------------------------------------------------------------- */
  /* M7's readers: the public pages, read in both editions throughout  */
  /* ---------------------------------------------------------------- */
  let reading = true;
  let reads = 0;
  const publicPaths = async () => {
    const [destination] = await sql<{ slug: string }[]>`select slug from package_destinations where id = ${egypt}`;
    const moved = await addressOf(sql, "service", mover!.id);
    const own = await addressOf(sql, "service", rotating!.id);
    return ["/about", "/services", "/packages", "/services/business-setup", `/services/${own}`, `/packages/${destination!.slug}`, `/services/${moved}`, "/packages/cairo-and-giza-classic"];
  };
  const reader = async () => {
    while (reading) {
      for (const path of await publicPaths()) {
        for (const edition of ["", "/ar"]) {
          const response = await fetch(`${origin}${edition}${path}`, { redirect: "manual" });
          const body = await response.text();
          reads += 1;
          // A page mid-rename may answer 404 at the address just read; anything 5xx is an incident.
          if (response.status >= 500 || payloadErrors(body).some((row) => !isNavigationDigest(row.digest))) {
            incidents.push(`${response.status} GET ${edition}${path}`);
          }
        }
      }
    }
  };
  const readers = [reader(), reader()];

  /* ---------------------------------------------------------------- */
  /* M1, M2 — one record, six forms                                    */
  /* ---------------------------------------------------------------- */
  const rotation = [`page:${about}`, "serviceIndex:1", "packageIndex:1", `category:${business}`, `service:${rotating!.id}`, `destination:${egypt}`, `package:${cairo}`];
  const FIELDS = ["titleEn", "titleAr", "descriptionEn", "descriptionAr", "ogTitle", "ogTitleAr"] as const;
  const COLUMNS: Record<(typeof FIELDS)[number], string> = {
    titleEn: "title_en",
    titleAr: "title_ar",
    descriptionEn: "description_en",
    descriptionAr: "description_ar",
    ogTitle: "og_title",
    ogTitleAr: "og_title_ar",
  };
  {
    let landed = 0;
    let odd = "";
    for (let round = 0; round < LOOPS; round += 1) {
      const target = rotation[round % rotation.length]!;
      const forms = await Promise.all(FIELDS.map(() => open(target)));
      const answers = await Promise.all(forms.map((opened, i) => saveSeo(opened, { [FIELDS[i]!]: `M1 ${round} ${FIELDS[i]}` })));
      const rows = await rowsOf(target);
      const whole = rows.length === 1 && FIELDS.every((field) => rows[0]![COLUMNS[field]] === `M1 ${round} ${field}`);
      if (answers.every((answer) => answer.ok) && whole) landed += 1;
      else if (!odd) odd = JSON.stringify({ round, target, answers: answers.map((answer) => answer.message), rows: rows.length });
    }
    say("M1. six forms on one record, each its own field, all at once: all six land, on one row", landed === LOOPS, `${landed}/${LOOPS}${odd ? ` — first other: ${odd}` : ""}`);
  }
  {
    let single = 0;
    let odd = "";
    for (let round = 0; round < LOOPS; round += 1) {
      const target = rotation[round % rotation.length]!;
      const forms = await Promise.all(FIELDS.map(() => open(target)));
      const answers = await Promise.all(forms.map((opened, i) => saveSeo(opened, { titleEn: `M2 ${round} form ${i}` })));
      const winners = answers.flatMap((answer, i) => (answer.ok ? [i] : []));
      const refusedByName = answers.filter((answer) => !answer.ok).every((answer) => answer.conflicts?.join() === "titleEn");
      const rows = await rowsOf(target);
      if (winners.length === 1 && refusedByName && rows.length === 1 && rows[0]!.title_en === `M2 ${round} form ${winners[0]}`) single += 1;
      else if (!odd) odd = JSON.stringify({ round, target, winners, rows: rows.length });
    }
    say("M2. six forms on one record, the same field: exactly one lands, five are refused by name and write nothing", single === LOOPS, `${single}/${LOOPS}${odd ? ` — first other: ${odd}` : ""}`);
  }

  /* ---------------------------------------------------------------- */
  /* M3 — first saves, all at once                                     */
  /* ---------------------------------------------------------------- */
  {
    let merged = 0;
    let single = 0;
    let odd = "";
    for (let round = 0; round < LOOPS; round += 1) {
      const apart = `service:${fresh[2 * round]}`;
      const forms = await Promise.all(FIELDS.map(() => open(apart)));
      const answers = await Promise.all(forms.map((opened, i) => saveSeo(opened, { [FIELDS[i]!]: `M3 ${round} ${FIELDS[i]}` })));
      const rows = await rowsOf(apart);
      if (answers.every((answer) => answer.ok) && rows.length === 1 && FIELDS.every((field) => rows[0]![COLUMNS[field]] === `M3 ${round} ${field}`)) merged += 1;
      else if (!odd) odd = JSON.stringify({ round, apart, answers: answers.map((answer) => answer.message), rows: rows.length });

      const together = `service:${fresh[2 * round + 1]}`;
      const same = await Promise.all(FIELDS.map(() => open(together)));
      const sameAnswers = await Promise.all(same.map((opened, i) => saveSeo(opened, { titleEn: `M3 ${round} first ${i}` })));
      const winners = sameAnswers.flatMap((answer, i) => (answer.ok ? [i] : []));
      const sameRows = await rowsOf(together);
      if (winners.length === 1 && sameRows.length === 1 && sameRows[0]!.title_en === `M3 ${round} first ${winners[0]}`) single += 1;
      else if (!odd) odd = JSON.stringify({ round, together, winners, rows: sameRows.length });
    }
    say(
      "M3. first saves on records with no row, all at once: different fields merge into one row; the same field has one winner and one row — never two, never an error",
      merged === LOOPS && single === LOOPS,
      `${merged}/${LOOPS} merged, ${single}/${LOOPS} single${odd ? ` — first other: ${odd}` : ""}`,
    );
  }

  /* ---------------------------------------------------------------- */
  /* M4 — share images chosen while their pictures are deleted          */
  /* ---------------------------------------------------------------- */
  {
    const pairs = [`category:${business}`, `package:${cairo}`, "packageIndex:1", `page:${about}`];
    const sharers = [`destination:${egypt}`, `service:${rotating!.id}`];
    let clean = 0;
    let odd = "";
    const outcomes = { saves: 0, deletes: 0, sharedKept: 0, sharedDeleted: 0 };
    for (let round = 0; round < LOOPS; round += 1) {
      const pictures = await sql<{ id: number }[]>`
        insert into media (filename, mime_type, title, width, height)
        select 'm4-' || ${round} || '-' || n || '.webp', 'image/webp', 'M4 ' || ${round} || ' ' || n, 1600, 840
          from generate_series(0, ${pairs.length}) n
        returning id`;
      const ids = pictures.map((row) => row.id);
      const shared = ids[pairs.length]!;
      const forms = await Promise.all([...pairs, ...sharers].map((target) => open(target)));
      const answers = await Promise.all([
        ...pairs.map((_, i) => act(MEDIA, "deleteMedia", { id: ids[i]! })),
        ...pairs.map((_, i) => saveSeo(forms[i]!, { ogImageId: ids[i]! })),
        act(MEDIA, "deleteMedia", { id: shared }),
        ...sharers.map((_, i) => saveSeo(forms[pairs.length + i]!, { ogImageId: shared })),
      ]);
      const exists = async (id: number) => (await sql`select 1 from media where id = ${id}`).length === 1;
      const chosen = async (target: string) => ((await rowsOf(target))[0]?.og_image_id ?? null) as number | null;
      const problems: string[] = [];
      for (let i = 0; i < pairs.length; i += 1) {
        const deleted = answers[i]!;
        const saved = answers[pairs.length + i]!;
        if (deleted.ok === saved.ok) problems.push(`${pairs[i]}: delete ${deleted.ok}, save ${saved.ok}`);
        if (saved.ok) {
          outcomes.saves += 1;
          if (!(await exists(ids[i]!)) || (await chosen(pairs[i]!)) !== ids[i]) problems.push(`${pairs[i]}: a saved choice lost its picture`);
        } else {
          outcomes.deletes += 1;
          if ((await exists(ids[i]!)) || !/no longer in the media library/.test(saved.message ?? "")) problems.push(`${pairs[i]}: ${saved.message}`);
        }
      }
      const sharedDelete = answers[2 * pairs.length]!;
      const sharedSaves = answers.slice(2 * pairs.length + 1);
      if (sharedDelete.ok) {
        outcomes.sharedDeleted += 1;
        if (sharedSaves.some((answer) => answer.ok) || (await exists(shared))) problems.push("the shared picture went and a choice of it stood");
      } else {
        outcomes.sharedKept += 1;
        if (!sharedSaves.some((answer) => answer.ok)) problems.push("the shared picture was refused and nothing chose it");
        for (let i = 0; i < sharers.length; i += 1) {
          if (sharedSaves[i]!.ok && (await chosen(sharers[i]!)) !== shared) problems.push(`${sharers[i]}: a saved choice of the shared picture is gone`);
        }
      }
      // Whatever was not chosen is let go for the next round: each record points at nothing deleted.
      const dangling = await sql`
        select 1 from seo_metadata s where s.og_image_id is not null and not exists (select 1 from media m where m.id = s.og_image_id)`;
      if (dangling.length) problems.push("a record names a deleted picture");
      if (!problems.length) clean += 1;
      else if (!odd) odd = `round ${round}: ${problems.join("; ")}`;
    }
    say(
      "M4. share images chosen while their pictures are deleted — four pairs and one picture two records choose, at once: one side of each wins, never both; nothing names a deleted picture",
      clean === LOOPS,
      `${clean}/${LOOPS} — ${JSON.stringify(outcomes)}${odd ? ` — first other: ${odd}` : ""}`,
    );
  }

  /* ---------------------------------------------------------------- */
  /* M5 — a destination's new address, while its SEO is saved           */
  /* ---------------------------------------------------------------- */
  {
    let together = 0;
    let odd = "";
    for (let round = 0; round < LOOPS; round += 1) {
      const slug = round % 2 === 0 ? "egypt-renamed" : "egypt";
      const [seoForm, destinationForm] = await Promise.all([open(`destination:${egypt}`), openDestinationForm(sql, origin, owner.cookie, egypt)]);
      const [saved, renamed] = await Promise.all([
        saveSeo(seoForm, { titleEn: `Egypt, round ${round}` }),
        act({ route: `/admin/packages/destinations/${egypt}`, file: DESTINATION_FILE }, "updateDestination", withChanges(destinationForm, { slug })),
      ]);
      const rows = await sql<{ entity_key: string; entity_id: number | null; title_en: string }[]>`
        select entity_key, entity_id, title_en from seo_metadata where entity_type = 'destination' and (entity_id = ${egypt} or entity_key in ('egypt', 'egypt-renamed'))`;
      if (saved.ok && renamed.ok && rows.length === 1 && rows[0]!.entity_key === slug && rows[0]!.entity_id === egypt && rows[0]!.title_en === `Egypt, round ${round}`) together += 1;
      else if (!odd) odd = JSON.stringify({ round, saved: saved.message, renamed: renamed.message, rows });
    }
    say("M5. a destination's address changed while its SEO is saved: both land, on one row bound to the destination at its new address", together === LOOPS, `${together}/${LOOPS}${odd ? ` — first other: ${odd}` : ""}`);
  }

  /* ---------------------------------------------------------------- */
  /* M6 — a service moved, while its SEO is saved                       */
  /* ---------------------------------------------------------------- */
  {
    let together = 0;
    let odd = "";
    for (let round = 0; round < LOOPS; round += 1) {
      const to = round % 2 === 0 ? business : travel;
      const [seoForm, serviceForm] = await Promise.all([open(`service:${mover!.id}`), openServiceForm(sql, origin, owner.cookie, mover!.id)]);
      const [saved, moved] = await Promise.all([
        saveSeo(seoForm, { titleEn: `Moving service, round ${round}` }),
        act({ route: `/admin/services/${mover!.id}`, file: SERVICE_FILE }, "updateService", changedForm(serviceForm, { categoryId: to, subcategoryId: "" })),
      ]);
      const address = await addressOf(sql, "service", mover!.id);
      const rows = await sql<{ entity_key: string; entity_id: number | null; title_en: string }[]>`
        select entity_key, entity_id, title_en from seo_metadata where entity_type = 'service' and (entity_id = ${mover!.id} or entity_key like ${`%/${address!.split("/")[1]}`})`;
      if (saved.ok && moved.ok && rows.length === 1 && rows[0]!.entity_key === address && rows[0]!.title_en === `Moving service, round ${round}`) together += 1;
      else if (!odd) odd = JSON.stringify({ round, saved: saved.message, moved: moved.message, address, rows });
    }
    say("M6. a service moved to another category while its SEO is saved: both land, on one row bound to the service at its new address", together === LOOPS, `${together}/${LOOPS}${odd ? ` — first other: ${odd}` : ""}`);
  }

  /* ---------------------------------------------------------------- */
  /* M7 — a destination deleted, while its SEO is saved                 */
  /* ---------------------------------------------------------------- */
  {
    let clean = 0;
    let odd = "";
    const outcomes = { savedFirst: 0, toldGone: 0 };
    for (let round = 0; round < LOOPS; round += 1) {
      const slug = `m7-destination-${round}`;
      const [made] = await sql<{ id: number }[]>`
        insert into package_destinations (slug, title_en, is_published) values (${slug}, ${`M7 ${round}`}, false) returning id`;
      const target = `destination:${made!.id}`;
      const first = await saveSeo(await open(target), { titleEn: `M7 ${round} record` });
      const opened = await open(target);
      const [saved] = await Promise.all([
        saveSeo(opened, { descriptionEn: `M7 ${round} racing the delete` }),
        act({ route: `/admin/packages/destinations/${made!.id}`, file: DESTINATION_FILE }, "deleteDestination", { id: made!.id }),
      ]);
      const left = await sql`select 1 from seo_metadata where entity_type = 'destination' and (entity_id = ${made!.id} or entity_key = ${slug})`;
      const gone = (await sql`select 1 from package_destinations where id = ${made!.id}`).length === 0;
      if (saved.ok) outcomes.savedFirst += 1;
      else if (/^That page no longer exists/.test(saved.message ?? "")) outcomes.toldGone += 1;
      if (first.ok && gone && left.length === 0 && (saved.ok || /^That page no longer exists/.test(saved.message ?? ""))) clean += 1;
      else if (!odd) odd = JSON.stringify({ round, saved: saved.message, gone, left: left.length });
    }
    say(
      "M7. a destination deleted while its SEO is saved: its record goes with it whichever came first — the save landed and went, or was told the page no longer exists",
      clean === LOOPS,
      `${clean}/${LOOPS} — ${JSON.stringify(outcomes)}${odd ? ` — first other: ${odd}` : ""}`,
    );
  }

  reading = false;
  await Promise.all(readers);
  say("the public pages, read in both editions throughout: every answer whole", incidents.length === 0 && reads > 0, `${reads} reads${incidents[0] ? ` — ${incidents[0]}` : ""}`);

  /* ---------------------------------------------------------------- */
  /* Afterwards                                                        */
  /* ---------------------------------------------------------------- */
  // Every page shows its stored record on the very next read — no cache drop was lost.
  const titleOf = async (path: string) => /<title>([^<]*)<\/title>/.exec(await (await fetch(`${origin}${path}`)).text())?.[1]?.replace(/&amp;/g, "&") ?? "";
  const shown: string[] = [];
  for (const [target, path] of [
    [`destination:${egypt}`, `/packages/${(await sql<{ slug: string }[]>`select slug from package_destinations where id = ${egypt}`)[0]!.slug}`],
    [`service:${mover!.id}`, `/services/${await addressOf(sql, "service", mover!.id)}`],
    ["packageIndex:1", "/packages"],
  ] as const) {
    const stored = String((await rowsOf(target))[0]?.title_en ?? "");
    const title = await titleOf(path);
    if (!stored || !title.startsWith(stored)) shown.push(`${path}: “${title}” for “${stored}”`);
  }
  say("on the next read every page shows its stored record", shown.length === 0, shown.join(" | "));

  const stray = await sql<{ id: number; entity_type: string; entity_key: string }[]>`
    select s.id, s.entity_type, s.entity_key from seo_metadata s
     where s.entity_id > 0 and not exists (
       select 1 from pages r where s.entity_type = 'page' and r.id = s.entity_id
       union all select 1 from service_categories r where s.entity_type = 'category' and r.id = s.entity_id
       union all select 1 from services r where s.entity_type = 'service' and r.id = s.entity_id
       union all select 1 from travel_packages r where s.entity_type = 'package' and r.id = s.entity_id
       union all select 1 from package_destinations r where s.entity_type = 'destination' and r.id = s.entity_id)`;
  const misplaced: string[] = [];
  for (const row of await sql<{ entity_type: string; entity_key: string; entity_id: number }[]>`
    select entity_type, entity_key, entity_id from seo_metadata where entity_id > 0`) {
    const address = await addressOf(sql, row.entity_type, row.entity_id);
    if (address !== null && row.entity_key !== address && row.entity_key !== `#${row.entity_id}`) misplaced.push(`${row.entity_type}:${row.entity_id} at ${row.entity_key}`);
  }
  say(
    "no row is bound to a record that is gone, and every bound row is keyed by its record's present address — what the previous release reads",
    stray.length === 0 && misplaced.length === 0,
    [...stray.map((row) => `${row.entity_type} ${row.entity_key}`), ...misplaced].slice(0, 5).join(" | "),
  );

  const failures = serverFailureLines(server.lines());
  say(
    "the server wrote no failure, and no answer was a 5xx, carried an error row or reported an unexpected error",
    failures.length === 0 && incidents.length === 0,
    [...failures.slice(0, 3).map((line) => line.text.slice(0, 200)), ...incidents.slice(0, 3)].join(" | "),
  );
} finally {
  await server?.stop();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
