/**
 * Batch 18 stress: granular permissions under concurrency, against a running
 * server, every answer checked against an independent reading of the database.
 *
 *   S1  refusal storm — bursts of concurrent requests a role may not make, in
 *       every domain, at fresh and stale revisions: every one is refused by
 *       permission (never by a revision conflict), and the whole database is
 *       byte-for-byte what it was.
 *   S2  mixed storm — concurrent allowed and refused requests from one role:
 *       each refused answer names the capability, no allowed answer is a
 *       permission refusal, and every domain the role does not hold is exactly
 *       as it was however the allowed work interleaved.
 *   S3  revocation storm — parallel save chains while the permission is taken
 *       away: nothing sent after the revocation lands, nothing completed
 *       before it is undone, and each section ends on its chain's last
 *       accepted save.
 *
 * Requirements are written out here by hand, from the brief, rather than read
 * from `lib/auth/authority.ts` — the point is to check that table, not to
 * agree with it.
 */
import { callAction } from "../helpers/action";
import { giveFresh } from "../helpers/fixtures";
import { connect, dropDatabase } from "../helpers/pg";
import { startServer } from "../helpers/server";
import { signIn, type TestSession } from "../helpers/session";

const PORT = 3801;
const VE = { route: "/admin/visual-editor", file: "app/(backoffice)/admin/visual-editor/actions.ts" };
const PAGES = { route: "/admin/pages", file: "app/(backoffice)/admin/(shell)/pages/actions.ts" };
const RC = { route: "/admin/components", file: "app/(backoffice)/admin/(shell)/components/actions.ts" };
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const DENIED = {
  editContent: "Your role does not allow editing page content. Nothing was saved.",
  editStyle: "Your role does not allow styling. Nothing was saved.",
  editAdvancedStyle:
    "Your role does not allow advanced styling — width, height, layout, direction, wrapping, " +
    "alignment, columns, overflow and glow. Nothing was saved.",
  editMotion: "Your role does not allow editing motion. Nothing was saved.",
  editStructure: "Your role does not allow changing the page layout. Nothing was changed.",
  publish: "Your role does not allow publishing, discarding or restoring pages. Nothing was changed.",
  editComponents: "Your role does not allow editing reusable components. Nothing was changed.",
  publishComponents: "Your role does not allow publishing reusable components. Nothing was published.",
  componentLifecycle: "Your role does not allow archiving or deleting reusable components. Nothing was changed.",
  reuseInstance:
    "Linking, detaching or overriding a reusable component needs permission to edit page content " +
    "and to view reusable components. Nothing was saved.",
  saveAndPublish: "Saving and publishing needs permission to edit page content and to publish. Nothing was saved.",
} as const;
const EVERY_DENIAL = new Set<string>(Object.values(DENIED));

const READ = ["dashboard.view", "content.view", "visual_editor.view", "components.view"];
const ADVANCED = ["width", "height", "minHeight", "layout", "direction", "wrap", "justify", "alignItems", "columns", "overflow", "glow"];

type Values = Record<string, unknown>;
type Answer = { ok: boolean; message?: string; reason?: string } & Values;

const database = giveFresh("permissions_stress");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  const [editorRole] = await sql<{ id: number }[]>`select id from roles where key = 'editor'`;
  await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    select 'stress-actor@probe.invalid', 'Stress Actor', 'unused', id, true from roles where key = 'editor'`;
  const actor = await signIn(sql, "editor");
  server = await startServer(database, PORT);
  const origin = server.origin;

  const as = async (keys: string[]) => {
    await sql`delete from role_permissions where role_id = ${editorRole!.id}`;
    if (keys.length) {
      await sql`
        insert into role_permissions (role_id, permission_id)
        select ${editorRole!.id}, id from permissions where key = any(${keys})`;
    }
  };
  const form = (fields: Record<string, string | number>, session: TestSession) => {
    const data = new FormData();
    data.set("_csrf", session.csrfToken);
    for (const [key, value] of Object.entries(fields)) data.set(key, String(value));
    return data;
  };
  const call = async (where: { route: string; file: string }, action: string, args: unknown[], session: TestSession) =>
    (await callAction<Answer>({ ...where, origin, action, args, cookie: session.cookie })).value ?? { ok: false, message: "(no answer)" };
  const ve = (action: string, fields: Record<string, string | number>, session = actor) => call(VE, action, [form(fields, session)], session);
  const rc = (action: string, fields: Record<string, string | number>, session = actor) => call(RC, action, [form(fields, session)], session);
  const classic = (action: string, fields: Record<string, string | number>, session = actor) =>
    call(PAGES, action, [{ ok: false }, form(fields, session)], session);

  type Section = {
    id: number;
    page_id: number;
    revision: number;
    draft: Values | null;
    published: Values;
    styles: Values;
    draft_styles: Values | null;
  };
  const section = async (id: number) =>
    (await sql<Section[]>`
      select id, page_id, revision, draft, published, styles, draft_styles from page_sections where id = ${id}`)[0]!;
  const pageOf = async (slug: string) =>
    (await sql<{ id: number; revision: number }[]>`select id, revision from pages where slug = ${slug}`)[0]!;

  const stateOf = async () => {
    const pages = await sql`select id, revision, draft_structure, is_published, title_en, title_ar, updated_at from pages order by id`;
    const sections = await sql`
      select id, page_id, revision, position, is_published, is_draft_only, published, draft, styles, draft_styles,
             animation, draft_animation, motion_config, draft_motion_config, updated_at
        from page_sections order by id`;
    const components = await sql`select id, revision, status, name, published_version, published, draft from reusable_components order by id`;
    const counts = await sql`
      select (select count(*) from page_versions)::int as versions,
             (select count(*) from reusable_component_versions)::int as component_versions,
             (select count(*) from reusable_components)::int as components`;
    return JSON.stringify({ pages, sections, components, counts });
  };

  /* Per-domain fingerprints, for S2: each is one domain and nothing else. */
  const sorted = (value: unknown): unknown =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Values).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)]))
      : value;
  const advancedOf = (doc: unknown) => {
    const nodes = ((doc as { nodes?: Record<string, Record<string, Values>> } | null)?.nodes ?? {}) as Record<string, Record<string, Values>>;
    const kept: Values = {};
    for (const [path, branches] of Object.entries(nodes)) {
      for (const [breakpoint, tokens] of Object.entries(branches ?? {})) {
        for (const token of ADVANCED) {
          if (tokens?.[token] !== undefined) kept[`${path}|${breakpoint}|${token}`] = tokens[token];
        }
      }
    }
    return kept;
  };
  const fingerprints = async (ids: number[], componentIds: number[]) => {
    const rows = await sql<Values[]>`
      select id, draft, published, styles, draft_styles, animation, draft_animation, motion_config, draft_motion_config,
             position, is_published, is_draft_only
        from page_sections where id = any(${ids}) order by id`;
    const pages = await sql`select id, draft_structure, is_published, title_en, title_ar from pages order by id`;
    // The components that existed when the round began: a draft created during
    // it is allowed work, and must not read as a change to the ones before it.
    const components = await sql`
      select id, status, name, published_version, published, draft from reusable_components where id = any(${componentIds}) order by id`;
    const componentCount = (await sql<{ n: number }[]>`select count(*)::int as n from reusable_components`)[0]!.n;
    const versions = (await sql<{ n: number }[]>`select count(*)::int as n from page_versions`)[0]!.n;
    const componentVersions = (await sql<{ n: number }[]>`
      select count(*)::int as n from reusable_component_versions where component_id = any(${componentIds})`)[0]!.n;
    const pick = (keys: string[]) => JSON.stringify(sorted(rows.map((row) => Object.fromEntries(keys.map((key) => [key, row[key]])))));
    return {
      content: pick(["id", "draft"]),
      motion: pick(["id", "animation", "draft_animation", "motion_config", "draft_motion_config"]),
      advanced: JSON.stringify(sorted(rows.map((row) => ({ id: row.id, draft: advancedOf(row.draft_styles), live: advancedOf(row.styles) })))),
      styles: pick(["id", "styles", "draft_styles"]),
      structure: JSON.stringify(sorted({ positions: pick(["id", "position", "is_draft_only"]), drafts: pages.map((page) => [page.id, page.draft_structure]) })),
      published: JSON.stringify(sorted({ live: pick(["id", "published", "styles", "animation", "motion_config", "is_published"]), pages: pages.map((p) => [p.id, p.is_published, p.title_en, p.title_ar]), versions })),
      componentDrafts: JSON.stringify(sorted(components.map((c) => [c.id, c.name, c.draft]))),
      componentLive: JSON.stringify(sorted({ live: components.map((c) => [c.id, c.published_version, c.published]), componentVersions })),
      componentStatus: JSON.stringify(sorted(components.map((c) => [c.id, c.status]))),
      componentCount: String(componentCount),
    };
  };

  const [about] = await sql<{ id: number }[]>`select id from pages where slug = 'about'`;
  const aboutIds = (await sql<{ id: number }[]>`
    select id from page_sections where page_id = ${about!.id} and not is_draft_only order by position, id`).map((r) => r.id);
  const [home] = await sql<{ id: number }[]>`select id from pages where slug = 'home'`;
  const homeIds = (await sql<{ id: number }[]>`
    select id from page_sections where page_id = ${home!.id} and not is_draft_only order by position, id`).map((r) => r.id);
  const pool = [...aboutIds, ...homeIds];

  const TEXT_FIELDS = ["title", "headline", "eyebrow", "body"];
  const withText = (values: Values, text: string): Values => {
    const key = TEXT_FIELDS.find((name) => {
      const field = values[name];
      return Boolean(field && typeof field === "object" && "en" in (field as Values));
    });
    if (!key) return values;
    return { ...values, [key]: { ...(values[key] as Values), en: text } };
  };
  /** Sections with a localised text field — the ones a chained save can be read back from. */
  const textPool: number[] = [];
  for (const id of pool) {
    const values = (await section(id)).published;
    if (TEXT_FIELDS.some((name) => typeof (values[name] as Values | undefined)?.en === "string")) textPool.push(id);
  }
  const pick = <T,>(list: readonly T[]) => list[Math.floor(Math.random() * list.length)]!;
  const shuffle = <T,>(list: T[]) => {
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [list[i], list[j]] = [list[j]!, list[i]!];
    }
    return list;
  };

  /* A published CTA to publish, archive and detach against. */
  const made = await rc("createReusableComponent", { kind: "cta", name: "Stress CTA", values: JSON.stringify({ label: { en: "Stress", ar: "" }, href: "/contact" }), publish: "1" }, owner);
  if (!made.ok) throw new Error(`owner could not create a component: ${made.message}`);
  const CID = (made.component as { id: number }).id;
  const componentRevision = async () => (await sql<{ r: number }[]>`select revision as r from reusable_components where id = ${CID}`)[0]!.r;

  /**
   * Every operation, with the keys it needs written out by hand and the
   * sentence a refusal must say. `stale` sends a revision that is already
   * behind — a refusal must still be a refusal, never a conflict.
   */
  type Op = { name: string; refusal: (held: Set<string>) => string | null; run: (stale: boolean) => Promise<Answer> };
  const has = (held: Set<string>, ...keys: string[]) => keys.every((key) => held.has(key));
  const revisionOf = (value: number, stale: boolean) => (stale ? Math.max(0, value - 1) : value);
  let counter = 0;
  const ops: Op[] = [
    {
      name: "content save",
      refusal: (held) => (has(held, "content.view", "content.edit") ? null : DENIED.editContent),
      run: async (stale) => {
        const target = await section(pick(pool));
        const values = withText(target.draft ?? target.published, `stress ${(counter += 1)}`);
        return ve("saveVisualSectionDraft", { sectionId: target.id, pageId: target.page_id, expectedRevision: revisionOf(target.revision, stale), values: JSON.stringify(values) });
      },
    },
    {
      name: "standard style save",
      refusal: (held) => (has(held, "content.view", "content.style") ? null : DENIED.editStyle),
      run: async (stale) => {
        const target = await section(pick(pool));
        // The baseline document with one standard token changed, so no advanced token moves.
        const baseline = (target.draft_styles ?? target.styles ?? { v: 1, nodes: {} }) as { v: number; nodes: Record<string, Record<string, Values>> };
        const nodes = { ...(baseline.nodes ?? {}) };
        const root = { ...(nodes.root ?? {}) };
        root.base = { ...(root.base ?? {}), padBlock: 1 + ((counter += 1) % 6) };
        nodes.root = root;
        return ve("saveVisualSectionStyles", { sectionId: target.id, pageId: target.page_id, expectedRevision: revisionOf(target.revision, stale), styles: JSON.stringify({ v: 1, nodes }) });
      },
    },
    {
      name: "advanced style save",
      refusal: (held) =>
        !has(held, "content.view", "content.style") ? DENIED.editStyle : !held.has("content.advanced_style") ? DENIED.editAdvancedStyle : null,
      run: async (stale) => {
        const target = await section(pick(pool));
        const baseline = (target.draft_styles ?? target.styles ?? { v: 1, nodes: {} }) as { v: number; nodes: Record<string, Record<string, Values>> };
        const nodes = { ...(baseline.nodes ?? {}) };
        const root = { ...(nodes.root ?? {}) };
        const current = (root.base ?? {}) as Values;
        root.base = { ...current, glow: current.glow === "soft" ? "strong" : "soft" };
        nodes.root = root;
        return ve("saveVisualSectionStyles", { sectionId: target.id, pageId: target.page_id, expectedRevision: revisionOf(target.revision, stale), styles: JSON.stringify({ v: 1, nodes }) });
      },
    },
    {
      name: "motion save",
      refusal: (held) => (has(held, "content.view", "content.motion") ? null : DENIED.editMotion),
      run: async (stale) => {
        const target = await section(pick(pool));
        const entrance = pick(["fade", "fade-up", "scale-in"]);
        return ve("saveVisualSectionMotion", { sectionId: target.id, pageId: target.page_id, expectedRevision: revisionOf(target.revision, stale), motionDocument: JSON.stringify({ v: 1, section: { base: { entrance } }, nodes: {} }) });
      },
    },
    {
      name: "layout reorder",
      refusal: (held) => (has(held, "content.view", "content.structure") ? null : DENIED.editStructure),
      run: async (stale) => {
        const page = await pageOf("about");
        return ve("reorderPageStructure", { pageId: page.id, expectedRevision: revisionOf(page.revision, stale), order: JSON.stringify(shuffle([...aboutIds])) });
      },
    },
    {
      name: "layout visibility",
      refusal: (held) => (has(held, "content.view", "content.structure") ? null : DENIED.editStructure),
      run: async (stale) => {
        const page = await pageOf("about");
        return ve("setPageSectionVisibility", { pageId: page.id, expectedRevision: revisionOf(page.revision, stale), sectionId: pick(aboutIds), visible: pick(["true", "false"]) });
      },
    },
    {
      name: "layout discard",
      refusal: (held) => (has(held, "content.view", "content.structure") ? null : DENIED.editStructure),
      run: async (stale) => {
        const page = await pageOf("about");
        return ve("discardPageLayout", { pageId: page.id, expectedRevision: revisionOf(page.revision, stale) });
      },
    },
    {
      name: "page publish",
      refusal: (held) => (has(held, "content.view", "content.publish") ? null : DENIED.publish),
      run: async (stale) => {
        const page = await pageOf(pick(["about", "home"]));
        return ve("publishPageFromEditor", { pageId: page.id, expectedRevision: revisionOf(page.revision, stale) });
      },
    },
    {
      name: "page discard",
      refusal: (held) => (has(held, "content.view", "content.publish") ? null : DENIED.publish),
      run: async (stale) => {
        const page = await pageOf(pick(["about", "home"]));
        return ve("discardPageFromEditor", { pageId: page.id, expectedRevision: revisionOf(page.revision, stale) });
      },
    },
    {
      name: "classic section publish",
      refusal: (held) => (has(held, "content.view", "content.publish") ? null : DENIED.publish),
      run: async (stale) => {
        const target = await section(pick(pool));
        return classic("publishSection", { id: target.id, expectedRevision: revisionOf(target.revision, stale) });
      },
    },
    {
      name: "classic save and publish",
      refusal: (held) => (has(held, "content.view", "content.edit", "content.publish") ? null : DENIED.saveAndPublish),
      run: async (stale) => {
        const target = await section(pick(pool));
        const values = withText(target.draft ?? target.published, `classic ${(counter += 1)}`);
        return classic("saveSectionAndPublish", { id: target.id, expectedRevision: revisionOf(target.revision, stale), values: JSON.stringify(values) });
      },
    },
    {
      name: "component draft",
      refusal: (held) => (has(held, "components.view", "components.edit") ? null : DENIED.editComponents),
      run: async () =>
        rc("createReusableComponent", { kind: "cta", name: `Stress draft ${(counter += 1)}`, values: JSON.stringify({ label: { en: "x", ar: "" }, href: "/x" }) }),
    },
    {
      name: "component publish",
      refusal: (held) => (has(held, "components.view", "components.publish") ? null : DENIED.publishComponents),
      run: async (stale) => rc("publishReusable", { id: CID, expectedRevision: revisionOf(await componentRevision(), stale) }),
    },
    {
      name: "component archive",
      refusal: (held) => (has(held, "components.view", "components.lifecycle") ? null : DENIED.componentLifecycle),
      run: async (stale) => rc("archiveReusable", { id: CID, expectedRevision: revisionOf(await componentRevision(), stale), archived: pick(["0", "1"]) }),
    },
    {
      name: "instance detach",
      refusal: (held) => (has(held, "content.view", "content.edit", "components.view") ? null : DENIED.reuseInstance),
      run: async (stale) => {
        const target = await section(pick(pool));
        return ve("detachVisualInstance", { sectionId: target.id, pageId: target.page_id, expectedRevision: revisionOf(target.revision, stale), expectedComponentVersion: 1, slot: "primaryCta" });
      },
    },
  ];

  /* ---------------------------------------------------------------------- */
  /* S1 — refusal storm                                                     */
  /* ---------------------------------------------------------------------- */
  {
    const roles: string[][] = [
      READ,
      [...READ, "content.edit"],
      [...READ, "content.style"],
      [...READ, "content.motion"],
      [...READ, "content.structure"],
      [...READ, "content.publish"],
      [...READ, "components.edit"],
      [...READ, "content.manage"],
      ["content.manage", "visual_editor.view", "dashboard.view"],
      [...READ, "content.advanced_style"],
    ];
    let requests = 0;
    let wrong: string[] = [];
    let moved = 0;
    const rounds = 3;
    for (let round = 0; round < rounds; round += 1) {
      for (const keys of roles) {
        await as(keys);
        const held = new Set(keys);
        const refusedOps = ops.filter((op) => op.refusal(held) !== null);
        const before = await stateOf();
        const burst = shuffle([...refusedOps, ...refusedOps, ...refusedOps]);
        const answers = await Promise.all(burst.map((op, index) => op.run(index % 2 === 1).then((answer) => ({ op, answer }))));
        requests += answers.length;
        for (const { op, answer } of answers) {
          const expected = op.refusal(held);
          if (answer.ok !== false || answer.message !== expected) {
            wrong.push(`${keys.filter((k) => !READ.includes(k)).join("+") || "read"} · ${op.name}: ${JSON.stringify(answer).slice(0, 160)}`);
          }
        }
        if ((await stateOf()) !== before) moved += 1;
      }
    }
    say(`S1 refusal storm: ${requests} concurrent refused requests across ${roles.length} roles × ${rounds} rounds, each refused by permission in words`,
      wrong.length === 0, wrong.slice(0, 4).join(" || "));
    say("S1 …and not one burst left any trace in the database", moved === 0, `${moved} bursts moved something`);
    wrong = [];
  }

  /* ---------------------------------------------------------------------- */
  /* S2 — mixed storm                                                       */
  /* ---------------------------------------------------------------------- */
  {
    type Domain = keyof Awaited<ReturnType<typeof fingerprints>>;
    const scenarios: { name: string; keys: string[]; frozen: Domain[] }[] = [
      { name: "content + standard style", keys: [...READ, "content.edit", "content.style"],
        frozen: ["motion", "advanced", "structure", "published", "componentDrafts", "componentLive", "componentStatus", "componentCount"] },
      { name: "styles (advanced) + motion", keys: [...READ, "content.style", "content.advanced_style", "content.motion"],
        frozen: ["content", "structure", "published", "componentDrafts", "componentLive", "componentStatus", "componentCount"] },
      { name: "layout + component drafts", keys: [...READ, "content.structure", "components.edit"],
        frozen: ["content", "motion", "styles", "published", "componentLive", "componentStatus"] },
      { name: "motion + component lifecycle", keys: [...READ, "content.motion", "components.lifecycle"],
        frozen: ["content", "styles", "structure", "published", "componentDrafts", "componentLive", "componentCount"] },
    ];
    for (const scenario of scenarios) {
      await as(scenario.keys);
      const held = new Set(scenario.keys);
      let wrongRefusal: string[] = [];
      let refusedAllowed: string[] = [];
      let frozenMoved: string[] = [];
      let allowedOk = 0;
      let refusedCount = 0;
      const otherwise = new Map<string, number>();
      const rounds = 6;
      for (let round = 0; round < rounds; round += 1) {
        const ids = (await sql<{ id: number }[]>`select id from page_sections order by id`).map((r) => r.id);
        const componentIds = (await sql<{ id: number }[]>`select id from reusable_components order by id`).map((r) => r.id);
        const before = await fingerprints(ids, componentIds);
        const burst = shuffle([...ops, ...ops]);
        const answers = await Promise.all(burst.map((op, index) => op.run(index % 5 === 4).then((answer) => ({ op, answer }))));
        for (const { op, answer } of answers) {
          const expected = op.refusal(held);
          if (expected) {
            refusedCount += 1;
            if (answer.ok !== false || answer.message !== expected) wrongRefusal.push(`${op.name}: ${JSON.stringify(answer).slice(0, 140)}`);
          } else {
            if (answer.ok) allowedOk += 1;
            else if (answer.message && EVERY_DENIAL.has(answer.message)) refusedAllowed.push(`${op.name}: ${answer.message}`);
            else otherwise.set(String(answer.reason ?? "no reason"), (otherwise.get(String(answer.reason ?? "no reason")) ?? 0) + 1);
          }
        }
        const after = await fingerprints(ids, componentIds);
        for (const domain of scenario.frozen) if (before[domain] !== after[domain]) frozenMoved.push(`${domain} (round ${round + 1})`);
      }
      say(`S2 ${scenario.name}: ${refusedCount} refused requests each named their capability`, wrongRefusal.length === 0, wrongRefusal.slice(0, 3).join(" || "));
      const reasons = [...otherwise].map(([reason, n]) => `${n} ${reason}`).join(", ") || "none";
      say(`S2 ${scenario.name}: no allowed request was refused by permission (${allowedOk} succeeded; the others answered: ${reasons})`,
        refusedAllowed.length === 0 && allowedOk > 0 && !otherwise.has("denied"), refusedAllowed.slice(0, 3).join(" || "));
      say(`S2 ${scenario.name}: every domain the role does not hold is exactly as it was`, frozenMoved.length === 0, frozenMoved.join(", "));
      wrongRefusal = [];
      refusedAllowed = [];
      frozenMoved = [];
    }
  }

  /* ---------------------------------------------------------------------- */
  /* S3 — revocation storm                                                  */
  /* ---------------------------------------------------------------------- */
  {
    const rounds = 6;
    let lateAccepted: string[] = [];
    let earlyLost: string[] = [];
    let endWrong: string[] = [];
    let sent = 0;
    let refusedAfter = 0;
    for (let round = 0; round < rounds; round += 1) {
      await as([...READ, "content.edit"]);
      const targets = shuffle([...textPool]).slice(0, 4);
      let revokeStart = Number.POSITIVE_INFINITY;
      let revokeDone = Number.POSITIVE_INFINITY;
      type Step = { text: string; sentAt: number; doneAt: number; answer: Answer };
      const chains = targets.map(async (id) => {
        const steps: Step[] = [];
        let revision = (await section(id)).revision;
        for (let n = 0; n < 40; n += 1) {
          const current = await section(id);
          const text = `r${round}-s${id}-n${n}`;
          const sentAt = performance.now();
          const answer = await ve("saveVisualSectionDraft", {
            sectionId: id,
            pageId: current.page_id,
            expectedRevision: revision,
            values: JSON.stringify(withText(current.draft ?? current.published, text)),
          });
          steps.push({ text, sentAt, doneAt: performance.now(), answer });
          if (answer.ok) revision = (answer.section as { revision: number } | undefined)?.revision ?? revision + 1;
          else if (performance.now() > revokeDone + 400) break;
        }
        return { id, steps };
      });
      await new Promise((resolve) => setTimeout(resolve, 250 + Math.random() * 700));
      revokeStart = performance.now();
      await as([...READ]);
      revokeDone = performance.now();
      const results = await Promise.all(chains);
      for (const { id, steps } of results) {
        sent += steps.length;
        for (const step of steps) {
          if (step.sentAt > revokeDone) {
            if (step.answer.ok) lateAccepted.push(`${step.text}`);
            else if (step.answer.message === DENIED.editContent) refusedAfter += 1;
            else lateAccepted.push(`${step.text}: ${step.answer.message}`);
          }
          if (step.doneAt < revokeStart && !step.answer.ok) earlyLost.push(`${step.text}: ${step.answer.message}`);
        }
        const lastAccepted = [...steps].reverse().find((step) => step.answer.ok);
        const stored = await section(id);
        const values = stored.draft ?? stored.published;
        const shown = TEXT_FIELDS.map((name) => (values[name] as Values | undefined)?.en).find((text) => typeof text === "string");
        if (lastAccepted && shown !== lastAccepted.text) endWrong.push(`section ${id}: stored “${shown}”, last accepted “${lastAccepted.text}”`);
      }
    }
    say(`S3 revocation storm: ${sent} chained saves over ${rounds} rounds — nothing sent after the revocation was accepted (${refusedAfter} refused in words)`,
      lateAccepted.length === 0 && refusedAfter > 0, lateAccepted.slice(0, 3).join(" || "));
    say("S3 …nothing completed before the revocation was refused or undone", earlyLost.length === 0, earlyLost.slice(0, 3).join(" || "));
    say("S3 …and every section ends on its chain's last accepted save", endWrong.length === 0, endWrong.slice(0, 3).join(" || "));
    lateAccepted = [];
    earlyLost = [];
    endWrong = [];
  }
} finally {
  await server?.stop();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
