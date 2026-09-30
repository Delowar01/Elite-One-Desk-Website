/**
 * Batch 17 stress: the four concurrency questions reusable components raise,
 * each asked many times against a running server, each answer checked against
 * an independent reading of the database.
 *
 *   S1  component conflict — N saves of one component at one revision: one wins
 *   S2  usage counts — random link / unlink / duplicate / remove / publish,
 *       the catalogue compared with a count made straight from the rows
 *   S3  link / detach — detaches racing global publications: every detach is
 *       either refused by name or keeps exactly the version it was told about
 *   S4  global publish — concurrent publications of one component: one wins,
 *       history stays a gapless sequence, no page revision ever moves, and the
 *       public page only ever shows a published version
 */
import { callAction } from "../helpers/action";
import { giveFresh } from "../helpers/fixtures";
import { connect, dropDatabase } from "../helpers/pg";
import { startServer } from "../helpers/server";
import { signIn } from "../helpers/session";

import { linkSlot, readReuse } from "../../src/lib/cms/reuse/reference";

const PORT = 3802;
const VE = { route: "/admin/visual-editor", file: "app/(backoffice)/admin/visual-editor/actions.ts" };
const RC = { route: "/admin/components", file: "app/(backoffice)/admin/(shell)/components/actions.ts" };
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

type Values = Record<string, unknown>;
const database = giveFresh("reusable_stress");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);
  const origin = server.origin;
  const form = (fields: Record<string, string | number>) => {
    const data = new FormData();
    data.set("_csrf", owner.csrfToken);
    for (const [key, value] of Object.entries(fields)) data.set(key, String(value));
    return data;
  };
  const rc = async <T extends object = { ok: boolean; reason?: string; message: string; component?: { id: number; revision: number; published: Values; kind: string } }>(
    action: string,
    fields: Record<string, string | number>,
  ) => (await callAction<T>({ ...RC, origin, action, args: [form(fields)], cookie: owner.cookie })).value!;
  const ve = async <T extends object = { ok: boolean; reason?: string; message?: string; section?: { revision: number; values: Values } }>(
    action: string,
    fields: Record<string, string | number>,
  ) => (await callAction<T>({ ...VE, origin, action, args: [form(fields)], cookie: owner.cookie })).value!;
  const componentRow = async (id: number) =>
    (await sql<{ revision: number; published_version: number; published: Values | null; draft: Values | null }[]>`
      select revision, published_version, published, draft from reusable_components where id = ${id}`)[0]!;
  const sectionRow = async (id: number) =>
    (await sql<{ id: number; page_id: number; revision: number; block_type: string; draft: Values | null; published: Values; is_draft_only: boolean }[]>`
      select id, page_id, revision, block_type, draft, published, is_draft_only from page_sections where id = ${id}`)[0]!;
  const pageRevision = async (slug: string) => (await sql<{ id: number; revision: number }[]>`select id, revision from pages where slug = ${slug}`)[0]!;
  const createCta = async (name: string, en: string) => {
    const made = await rc("createReusableComponent", { kind: "cta", name, values: JSON.stringify({ label: { en, ar: "" }, href: "/x" }), publish: "1" });
    if (!made.ok || !made.component) throw new Error(`could not create ${name}: ${made.message}`);
    return made.component;
  };
  const publishPage = async (slug: string) => {
    const page = await pageRevision(slug);
    return ve<{ ok: boolean; message: string }>("publishPageFromEditor", { pageId: page.id, expectedRevision: page.revision });
  };
  const discardPage = async (slug: string) => {
    const page = await pageRevision(slug);
    return ve<{ ok: boolean }>("discardPageFromEditor", { pageId: page.id, expectedRevision: page.revision });
  };

  /* ---------------------------------------------------------------------- */
  /* S1 — conflicts                                                         */
  /* ---------------------------------------------------------------------- */
  {
    const component = await createCta("S1 CTA", "start");
    let clean = 0;
    const rounds = 25;
    for (let round = 0; round < rounds; round += 1) {
      const before = await componentRow(component.id);
      const writers = 6;
      const results = await Promise.all(
        Array.from({ length: writers }, (_, i) =>
          rc("saveReusableDraft", {
            id: component.id,
            expectedRevision: before.revision,
            values: JSON.stringify({ label: { en: `round ${round} writer ${i}`, ar: "" }, href: "/x" }),
          }),
        ),
      );
      const winners = results.filter((result) => result.ok);
      const conflicts = results.filter((result) => !result.ok && result.reason === "conflict");
      const after = await componentRow(component.id);
      const label = (after.draft?.label as { en?: string } | undefined)?.en ?? "";
      const winnerIndex = results.findIndex((result) => result.ok);
      if (
        winners.length === 1 &&
        conflicts.length === writers - 1 &&
        after.revision === before.revision + 1 &&
        label === `round ${round} writer ${winnerIndex}`
      ) {
        clean += 1;
      }
    }
    say("S1. concurrent saves of one component: exactly one wins, the rest conflict, nothing merged", clean === rounds, `${clean}/${rounds} clean rounds`);
  }

  /* ---------------------------------------------------------------------- */
  /* S2 — usage counts against the rows                                     */
  /* ---------------------------------------------------------------------- */
  {
    const component = await createCta("S2 CTA", "usage");
    const slugs = ["home", "about"];
    const panels = await sql<{ id: number; slug: string }[]>`
      select s.id, p.slug from page_sections s join pages p on p.id = s.page_id
       where s.block_type = 'final-cta' and p.slug in ('home', 'about') and not s.is_draft_only order by s.id`;
    /** An independent count: rows whose visible, member content refers to it — straight SQL. */
    const recount = async () => {
      const rows = await sql<{ pages: number; instances: number }[]>`
        with members as (
          select s.id, s.page_id, p.is_published as page_published, s.is_published, s.is_draft_only, s.published, s.draft,
                 p.draft_structure,
                 case when p.draft_structure is null then (not s.is_draft_only)
                      else exists (select 1 from jsonb_array_elements(p.draft_structure->'sections') e where (e->>'sectionId')::int = s.id)
                 end as member,
                 case when p.draft_structure is null then s.is_published
                      else coalesce((select (e->>'visible')::boolean from jsonb_array_elements(p.draft_structure->'sections') e where (e->>'sectionId')::int = s.id limit 1), false)
                 end as shown
            from page_sections s join pages p on p.id = s.page_id
        )
        select count(distinct page_id)::int as pages, count(*)::int as instances from members
         where (page_published and not is_draft_only and is_published and published->'_reuse'->'primaryCta'->>'c' = ${String(component.id)})
            or (member and shown and coalesce(draft, published)->'_reuse'->'primaryCta'->>'c' = ${String(component.id)})`;
      return rows[0]!;
    };
    let agree = 0;
    const steps = 30;
    let seed = 7;
    const random = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let step = 0; step < steps; step += 1) {
      const choice = random();
      const panel = panels[Math.floor(random() * panels.length)]!;
      const row = await sectionRow(panel.id);
      const values = row.draft ?? row.published;
      if (choice < 0.35) {
        const linked = linkSlot("final-cta", values, "primaryCta", { id: component.id, kind: "cta", values: component.published });
        if (linked) await ve("saveVisualSectionDraft", { sectionId: row.id, pageId: row.page_id, expectedRevision: row.revision, values: JSON.stringify(linked) });
      } else if (choice < 0.55) {
        const unlinked = { ...values };
        delete unlinked._reuse;
        await ve("saveVisualSectionDraft", { sectionId: row.id, pageId: row.page_id, expectedRevision: row.revision, values: JSON.stringify(unlinked) });
      } else if (choice < 0.7) {
        const page = await pageRevision(panel.slug);
        await ve("duplicatePageSection", { pageId: page.id, expectedRevision: page.revision, sectionId: row.id });
      } else if (choice < 0.85) {
        await publishPage(panel.slug);
      } else {
        await discardPage(panel.slug);
      }
      const catalog = (await callAction<{ id: number; usage: { pages: number; instances: number } }[] | null>({
        ...RC, origin, action: "loadReusableCatalog", args: [], cookie: owner.cookie,
      })).value!;
      const shown = catalog.find((entry) => entry.id === component.id)!.usage;
      const counted = await recount();
      if (shown.pages === counted.pages && shown.instances === counted.instances) agree += 1;
      else console.log(`   step ${step}: catalogue ${JSON.stringify(shown)} vs rows ${JSON.stringify(counted)}`);
    }
    for (const slug of slugs) await discardPage(slug);
    say("S2. usage counts match an independent count after every random operation", agree === steps, `${agree}/${steps}`);
  }

  /* ---------------------------------------------------------------------- */
  /* S3 — detach racing global publications                                 */
  /* ---------------------------------------------------------------------- */
  {
    const component = await createCta("S3 CTA", "v1");
    const panel = (await sql<{ id: number }[]>`
      select s.id from page_sections s join pages p on p.id = s.page_id where p.slug = 'about' and s.block_type = 'final-cta' limit 1`)[0]!;
    let consistent = 0;
    const rounds = 20;
    for (let round = 0; round < rounds; round += 1) {
      const row = await sectionRow(panel.id);
      const linked = linkSlot("final-cta", row.draft ?? row.published, "primaryCta", { id: component.id, kind: "cta", values: (await componentRow(component.id)).published! })!;
      const saved = await ve("saveVisualSectionDraft", { sectionId: row.id, pageId: row.page_id, expectedRevision: row.revision, values: JSON.stringify(linked) });
      if (!saved.ok) continue;
      const fresh = await sectionRow(panel.id);
      const known = await componentRow(component.id);
      const next = `v${round + 2}`;
      await rc("saveReusableDraft", { id: component.id, expectedRevision: known.revision, values: JSON.stringify({ label: { en: next, ar: "" }, href: "/x" }) });
      const staged = await componentRow(component.id);
      const [detached, published] = await Promise.all([
        ve<{ ok: boolean; reason?: string; section?: { values: Values } }>("detachVisualInstance", {
          sectionId: fresh.id, pageId: fresh.page_id, expectedRevision: fresh.revision, slot: "primaryCta", expectedComponentVersion: known.published_version,
        }),
        rc("publishReusable", { id: component.id, expectedRevision: staged.revision }),
      ]);
      const after = await sectionRow(panel.id);
      const label = ((after.draft?.primaryCtaLabel ?? {}) as { en?: string }).en;
      const ok = detached.ok
        ? readReuse(after.draft, "final-cta").primaryCta === undefined && label === ((known.published!.label as { en: string }).en)
        : detached.reason === "component_conflict" && readReuse(after.draft, "final-cta").primaryCta?.c === component.id;
      if (ok && published.ok) consistent += 1;
      else console.log(`   round ${round}: detach ${JSON.stringify(detached).slice(0, 120)} publish ${published.ok} label ${label}`);
    }
    await discardPage("about");
    say("S3. a detach racing a publication keeps exactly the version it saw, or is refused by name", consistent === rounds, `${consistent}/${rounds}`);
  }

  /* ---------------------------------------------------------------------- */
  /* S4 — concurrent global publications                                    */
  /* ---------------------------------------------------------------------- */
  {
    const component = await createCta("S4 CTA", "release-1-end");
    const home = (await sql<{ id: number; page_id: number; revision: number; published: Values }[]>`
      select s.id, s.page_id, s.revision, s.published from page_sections s join pages p on p.id = s.page_id
       where p.slug = 'home' and s.block_type = 'final-cta' limit 1`)[0]!;
    const linked = linkSlot("final-cta", home.published, "primaryCta", { id: component.id, kind: "cta", values: component.published })!;
    await ve("saveVisualSectionDraft", { sectionId: home.id, pageId: home.page_id, expectedRevision: home.revision, values: JSON.stringify(linked) });
    await publishPage("home");
    const pagesBefore = JSON.stringify(await sql`select id, revision from pages order by id`);
    const sectionsBefore = JSON.stringify(await sql`select id, revision from page_sections order by id`);
    const published = new Set<string>(["release-1-end"]);
    let clean = 0;
    let publicOk = 0;
    const rounds = 15;
    for (let round = 0; round < rounds; round += 1) {
      const known = await componentRow(component.id);
      const text = `release-${round + 2}-end`;
      const saved = await rc("saveReusableDraft", { id: component.id, expectedRevision: known.revision, values: JSON.stringify({ label: { en: text, ar: "" }, href: "/x" }) });
      if (!saved.ok) continue;
      const staged = await componentRow(component.id);
      const [results, html] = await Promise.all([
        Promise.all(Array.from({ length: 4 }, () => rc("publishReusable", { id: component.id, expectedRevision: staged.revision }))),
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return (await fetch(`${origin}/`)).text();
        })(),
      ]);
      const winners = results.filter((result) => result.ok).length;
      const after = await componentRow(component.id);
      if (winners === 1 && after.published_version === known.published_version + 1 && after.draft === null) clean += 1;
      published.add(text);
      // Exactly one version's words on the page, and it is one that was published.
      const shown = [...published].filter((label) => html.includes(label));
      if (shown.length === 1) publicOk += 1;
    }
    const versions = await sql<{ version: number }[]>`select version from reusable_component_versions where component_id = ${component.id} order by version`;
    const gapless = versions.every((row, index) => row.version === index + 1);
    const finalRow = await componentRow(component.id);
    say("S4. concurrent publications of one draft: exactly one wins each round", clean === rounds, `${clean}/${rounds}`);
    say("…history is a gapless sequence ending one below the live version",
      gapless && versions.length === finalRow.published_version - 1, `${versions.length} rows, live v${finalRow.published_version}`);
    say("…the public page only ever showed a published version", publicOk === rounds, `${publicOk}/${rounds}`);
    say("…and no page or section revision moved", JSON.stringify(await sql`select id, revision from pages order by id`) === pagesBefore &&
      JSON.stringify(await sql`select id, revision from page_sections order by id`) === sectionsBefore);
  }
} finally {
  await server?.stop();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
