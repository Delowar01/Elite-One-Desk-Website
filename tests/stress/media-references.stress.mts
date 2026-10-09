/**
 * Batch 26 stress: pictures named outside a foreign key, written while the
 * media library deletes them (docs/release/release-hardening-batch-26.md §3).
 * `tests/media-references.test.ts` forces each ordering once, behind gates;
 * this asks the same question many times at once with no gate at all, against
 * a running server, and checks every answer against the database.
 *
 * Each round brings in fresh pictures and, at the same moment and in a
 * shuffled order:
 *
 *   · Visual Editor autosaves on image-text sections, one picture each;
 *   · Visual Editor autosaves on Quick Links sections naming three pictures
 *     each, in a random order — many pictures in one write;
 *   · the Pages screen's section form, saving a draft and saving and publishing;
 *   · reusable component drafts;
 *   · Visual Editor route drafts: the hero picture of every service category;
 *
 * while every picture of the round is deleted, and every picture the previous
 * round left named is deleted too — the moment those same writes replace it
 * (A replaced by B while A is being deleted). Then:
 *
 *   R1  every answer is definite: a save is stored or refused because its
 *       picture has gone, a delete is done or refused because the picture is
 *       in use — nothing else, no 5xx, no unexpected error
 *   R2  after every round nothing names a picture the library no longer has
 *   R3  a delete that answered done left the picture out of the library; one
 *       refused as in use left it in
 *   R4  a save that answered stored stored exactly the pictures it named
 *   R5  the public pages read in both editions throughout: every answer whole
 *   R6  the server wrote no deadlock and no failure
 *
 * An `INFO` line counts how often each side won, which is reported rather than
 * asserted: it is timing, and correctness here never depends on timing.
 * STRESS_LOOPS=8 (rounds).
 */
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { callAction } from "../helpers/action";
import { isNavigationDigest, payloadErrors, serverFailureLines } from "../helpers/diagnostics";
import { REPO_ROOT } from "../helpers/env";
import { giveFresh } from "../helpers/fixtures";
import { connect, dropDatabase } from "../helpers/pg";
import { startServer } from "../helpers/server";
import { signIn } from "../helpers/session";

import { getBlock } from "@/lib/cms/blocks";
import { componentMediaIds, sectionMediaIds } from "@/lib/cms/media-refs";
import { emptyValues } from "@/lib/cms/values";
import { documentEditorKey, editorKeyOf, parseOwnerKey, type RouteOwner } from "@/lib/routes/owners";
import { mediaIdsOfPatches, type StoredPatch } from "@/lib/routes/specs";

const PORT = 3823;
const LOOPS = Number(process.env.STRESS_LOOPS ?? 8);
const PICTURES = 10;
const VE = { route: "/admin/visual-editor", file: "app/(backoffice)/admin/visual-editor/actions.ts" };
const ROUTES = { route: "/admin/visual-editor", file: "app/(backoffice)/admin/visual-editor/route-actions.ts" };
const PAGES = { route: "/admin/pages", file: "app/(backoffice)/admin/(shell)/pages/actions.ts" };
const COMPONENTS = { route: "/admin/components", file: "app/(backoffice)/admin/(shell)/components/actions.ts" };
const MEDIA = { route: "/admin/media", file: "app/(backoffice)/admin/(shell)/media/actions.ts" };
const UPLOADS = path.join(REPO_ROOT, ".data", "test-uploads");
const RUN = randomBytes(3).toString("hex");
/** What `runAction` answers when an exception it did not expect escaped — a deadlock, a unique violation. */
const UNEXPECTED = "Something went wrong. The change was not saved.";
/** A write refused because a picture it named has gone — by the hold, or by the check before it. */
const GONE = /no longer in the media library/;
const IN_USE = /^Still in use on /;

const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

type Answer = { ok: boolean; reason?: string; message?: string; [key: string]: unknown };
type Values = Record<string, unknown>;

/** A shuffled copy — the order writes and deletes are sent in, and the order a write names its pictures in. */
const shuffled = <T,>(items: readonly T[]): T[] => {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};
const pick = <T,>(items: readonly T[]): T => items[Math.floor(Math.random() * items.length)]!;

const database = giveFresh("media_refs_stress");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);
  const origin = server.origin;

  const incidents: string[] = [];
  const form = (fields: Record<string, string | number>) => {
    const data = new FormData();
    data.set("_csrf", owner.csrfToken);
    for (const [key, value] of Object.entries(fields)) data.set(key, String(value));
    return data;
  };
  const call = async (where: { route: string; file: string }, action: string, args: unknown[]): Promise<Answer> => {
    const answer = await callAction<Answer>({ ...where, origin, action, args, cookie: owner.cookie });
    const failed = payloadErrors(answer.text).filter((row) => !isNavigationDigest(row.digest));
    if (answer.status >= 500 || failed.length) {
      incidents.push(`${answer.status} ${action}: ${failed.map((row) => row.row).join(" | ") || answer.text.slice(0, 200)}`);
    }
    // A delete that succeeds answers with a redirect and no value.
    const value = answer.value ?? { ok: answer.status < 400 };
    if (value.message === UNEXPECTED) incidents.push(`${action}: ${UNEXPECTED}`);
    return value;
  };

  /* ---------------------------------------------------------------- */
  /* The rows the writers write — each written once a round, so no    */
  /* answer is a lost revision race                                   */
  /* ---------------------------------------------------------------- */
  const IMAGE_TEXT = getBlock("image-text")!;
  const imageText = (image: number | null): Values => ({ ...emptyValues(IMAGE_TEXT), title: { en: `Stress ${RUN}`, ar: "" }, image });
  const [home] = await sql<{ published: Values }[]>`
    select s.published from page_sections s join pages p on p.id = s.page_id where p.slug = 'home' and s.block_type = 'quick-links'`;
  if (!home) throw new Error("the fixture has no Quick Links section on Home");
  const quickLinks = (images: number[]): Values => ({
    ...home.published,
    links: (home.published.links as Values[]).map((link, index) => ({ ...link, image: images[index] ?? null })),
  });

  let made = 0;
  const freshSection = async (blockType: "image-text" | "quick-links") => {
    made += 1;
    const slug = `media-refs-stress-${RUN}-${made}`;
    const [page] = await sql<{ id: number }[]>`
      insert into pages (slug, kind, title_en, is_published) values (${slug}, 'custom', ${slug}, true) returning id`;
    const published = blockType === "image-text" ? imageText(null) : quickLinks([]);
    const [section] = await sql<{ id: number }[]>`
      insert into page_sections (page_id, block_type, position, is_published, published)
      values (${page!.id}, ${blockType}, 0, true, ${sql.json(published as never)}) returning id`;
    return { pageId: page!.id, sectionId: section!.id, slug };
  };
  const freshComponent = async () => {
    const [row] = await sql<{ id: number }[]>`
      insert into reusable_components (kind, name, published, published_version, published_at)
      values ('block:image-text', ${`Stress ${RUN} ${randomBytes(3).toString("hex")}`}, ${sql.json(imageText(null) as never)}, 1, now())
      returning id`;
    return row!.id;
  };

  const veSections = await Promise.all([1, 2, 3, 4].map(() => freshSection("image-text")));
  const cardSections = await Promise.all([1, 2].map(() => freshSection("quick-links")));
  const formSections = await Promise.all([1, 2].map(() => freshSection("image-text")));
  const componentIds = await Promise.all([1, 2].map(() => freshComponent()));
  const categories = await sql<{ id: number; slug: string }[]>`select id, slug from service_categories order by id`;

  const sectionRow = async (id: number) =>
    (await sql<{ revision: number; draft: Values | null; published: Values; page_id: number; block_type: string }[]>`
      select revision, draft, published, page_id, block_type from page_sections where id = ${id}`)[0]!;
  const componentRow = async (id: number) =>
    (await sql<{ revision: number; draft: Values | null; published: Values | null }[]>`
      select revision, draft, published from reusable_components where id = ${id}`)[0]!;
  const loadRegion = async (category: number) => {
    const owner: RouteOwner = { type: "category", id: category };
    const answer = await call(ROUTES, "loadRouteRegion", [editorKeyOf(owner), documentEditorKey({ kind: "category", id: category })]);
    if (!answer.ok) throw new Error(`could not read the ${category} region: ${answer.message}`);
    return answer.section as { revision: number; values: Values };
  };

  /** Every stored value naming a picture the library does not have, by declared field. */
  const dangling = async (): Promise<string[]> => {
    const library = new Set((await sql<{ id: number }[]>`select id from media`).map((row) => row.id));
    const out: string[] = [];
    for (const row of await sql<{ id: number; block_type: string; published: Values; draft: Values | null }[]>`
      select id, block_type, published, draft from page_sections`) {
      for (const id of [...sectionMediaIds(row.block_type, row.published), ...sectionMediaIds(row.block_type, row.draft)]) {
        if (!library.has(id)) out.push(`section ${row.id} → picture ${id}`);
      }
    }
    for (const row of await sql<{ id: number; kind: string; published: Values | null; draft: Values | null }[]>`
      select id, kind, published, draft from reusable_components`) {
      for (const id of [...componentMediaIds(row.kind, row.published), ...componentMediaIds(row.kind, row.draft)]) {
        if (!library.has(id)) out.push(`component ${row.id} → picture ${id}`);
      }
    }
    for (const row of await sql<{ owner_key: string; draft_content: StoredPatch | null }[]>`
      select owner_key, draft_content from route_nodes where draft_content is not null`) {
      const owned = parseOwnerKey(row.owner_key);
      if (!owned) continue;
      for (const id of mediaIdsOfPatches([[owned, row.draft_content ?? {}]])) {
        if (!library.has(id)) out.push(`region ${row.owner_key} → picture ${id}`);
      }
    }
    for (const row of await sql<{ id: number; image_id: number | null }[]>`select id, image_id from service_categories`) {
      if (row.image_id && !library.has(row.image_id)) out.push(`category ${row.id} → picture ${row.image_id}`);
    }
    return out;
  };

  /* ---------------------------------------------------------------- */
  /* R5's readers                                                      */
  /* ---------------------------------------------------------------- */
  let reading = true;
  let reads = 0;
  const readIncidents: string[] = [];
  const readPaths = [
    "/",
    ...categories.map((category) => `/services/${category.slug}`),
    ...[...veSections, ...cardSections, ...formSections].map((section) => `/${section.slug}`),
  ];
  const reader = async () => {
    while (reading) {
      for (const where of shuffled(readPaths)) {
        if (!reading) break;
        for (const edition of ["", "/ar"]) {
          const response = await fetch(`${origin}${edition}${where === "/" && edition ? "" : where}`, { redirect: "manual" });
          const body = await response.text();
          reads += 1;
          if (response.status >= 500 || payloadErrors(body).some((row) => !isNavigationDigest(row.digest))) {
            readIncidents.push(`${response.status} GET ${edition}${where}`);
          }
        }
      }
    }
  };
  const readers = [reader(), reader()];

  /* ---------------------------------------------------------------- */
  /* The rounds                                                        */
  /* ---------------------------------------------------------------- */
  const tally = { stored: 0, refusedGone: 0, deleted: 0, refusedInUse: 0 };
  const odd: string[] = [];
  const dangled: string[] = [];
  const deleteMismatch: string[] = [];
  const storeMismatch: string[] = [];
  let carried: number[] = [];

  for (let round = 0; round < LOOPS; round += 1) {
    const pictures: number[] = [];
    for (let n = 0; n < PICTURES; n += 1) {
      const filename = `media-refs-stress-${RUN}-${round}-${n}.webp`;
      const [row] = await sql<{ id: number }[]>`
        insert into media (filename, mime_type, title, width, height, derivatives)
        values (${filename}, 'image/webp', ${filename}, 1600, 900, '[]'::jsonb) returning id`;
      mkdirSync(UPLOADS, { recursive: true });
      writeFileSync(path.join(UPLOADS, filename), "a picture's bytes");
      pictures.push(row!.id);
    }

    type Write = { label: string; ids: number[]; send: () => Promise<Answer>; check: () => Promise<number[] | null> };
    const writes: Write[] = [];

    for (const target of veSections) {
      const image = pick(pictures);
      const row = await sectionRow(target.sectionId);
      writes.push({
        label: `autosave ${target.sectionId}`,
        ids: [image],
        send: () =>
          call(VE, "saveVisualSectionDraft", [
            form({ sectionId: target.sectionId, pageId: row.page_id, expectedRevision: row.revision, values: JSON.stringify(imageText(image)) }),
          ]),
        check: async () => sectionMediaIds("image-text", (await sectionRow(target.sectionId)).draft),
      });
    }
    for (const target of cardSections) {
      const images = shuffled(pictures).slice(0, 3);
      const row = await sectionRow(target.sectionId);
      writes.push({
        label: `cards ${target.sectionId}`,
        ids: images,
        send: () =>
          call(VE, "saveVisualSectionDraft", [
            form({ sectionId: target.sectionId, pageId: row.page_id, expectedRevision: row.revision, values: JSON.stringify(quickLinks(images)) }),
          ]),
        check: async () => sectionMediaIds("quick-links", (await sectionRow(target.sectionId)).draft),
      });
    }
    formSections.forEach((target, index) => {
      const image = pick(pictures);
      const action = index === 0 ? "saveSectionDraft" : "saveSectionAndPublish";
      writes.push({
        label: `${action} ${target.sectionId}`,
        ids: [image],
        send: async () => {
          const row = await sectionRow(target.sectionId);
          return call(PAGES, action, [{ ok: false }, form({ id: target.sectionId, expectedRevision: row.revision, values: JSON.stringify(imageText(image)) })]);
        },
        check: async () => {
          const row = await sectionRow(target.sectionId);
          return sectionMediaIds("image-text", action === "saveSectionDraft" ? row.draft : row.published);
        },
      });
    });
    for (const id of componentIds) {
      const image = pick(pictures);
      const row = await componentRow(id);
      writes.push({
        label: `component ${id}`,
        ids: [image],
        send: () => call(COMPONENTS, "saveReusableDraft", [form({ id, expectedRevision: row.revision, values: JSON.stringify(imageText(image)) })]),
        check: async () => componentMediaIds("block:image-text", (await componentRow(id)).draft),
      });
    }
    for (const category of categories) {
      const image = pick(pictures);
      const region = await loadRegion(category.id);
      writes.push({
        label: `region category:${category.id}`,
        ids: [image],
        send: () =>
          call(ROUTES, "saveRouteRegionDraft", [
            form({
              sectionId: editorKeyOf({ type: "category", id: category.id }),
              pageId: documentEditorKey({ kind: "category", id: category.id }),
              expectedRevision: region.revision,
              values: JSON.stringify({ ...region.values, image }),
            }),
          ]),
        check: async () => {
          const values = (await loadRegion(category.id)).values;
          return typeof values.image === "number" ? [values.image] : [];
        },
      });
    }

    // Every picture of the round, and every one the last round left named — which these very writes replace.
    const doomed = [...pictures, ...carried];
    type Sent = { kind: "write"; write: Write } | { kind: "delete"; id: number };
    const order: Sent[] = shuffled<Sent>([
      ...writes.map((write) => ({ kind: "write" as const, write })),
      ...doomed.map((id) => ({ kind: "delete" as const, id })),
    ]);
    const answers = await Promise.all(
      order.map(async (sent) => {
        // A write does more before it reaches its pictures than a delete does
        // before it reaches its own, so the deletes are spread over a longer
        // span: neither side always arrives first.
        await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * (sent.kind === "write" ? 4 : 60))));
        return sent.kind === "write"
          ? { sent, answer: await sent.write.send() }
          : { sent, answer: await call(MEDIA, "deleteMedia", [{ ok: false }, form({ id: sent.id })]) };
      }),
    );

    const library = new Set((await sql<{ id: number }[]>`select id from media where id = any(${doomed})`).map((row) => row.id));
    for (const { sent, answer } of answers) {
      if (sent.kind === "delete") {
        if (answer.ok) {
          tally.deleted += 1;
          if (library.has(sent.id)) deleteMismatch.push(`round ${round}: picture ${sent.id} answered deleted, still in the library`);
        } else if (IN_USE.test(answer.message ?? "")) {
          tally.refusedInUse += 1;
          if (!library.has(sent.id)) deleteMismatch.push(`round ${round}: picture ${sent.id} answered in use, gone from the library`);
        } else {
          odd.push(`round ${round}: delete ${sent.id} answered ${JSON.stringify(answer).slice(0, 200)}`);
        }
        continue;
      }
      if (answer.ok) {
        tally.stored += 1;
        const stored = await sent.write.check();
        const expected = [...new Set(sent.write.ids)].sort((a, b) => a - b);
        if (JSON.stringify(stored) !== JSON.stringify(expected)) {
          storeMismatch.push(`round ${round}: ${sent.write.label} answered stored ${JSON.stringify(expected)}, holds ${JSON.stringify(stored)}`);
        }
      } else if (GONE.test(answer.message ?? "")) {
        tally.refusedGone += 1;
        // Refused because a picture it named had gone: one of its pictures really is gone.
        if (sent.write.ids.every((id) => library.has(id))) {
          odd.push(`round ${round}: ${sent.write.label} refused as gone, yet every picture it named is in the library`);
        }
      } else {
        odd.push(`round ${round}: ${sent.write.label} answered ${JSON.stringify(answer).slice(0, 200)}`);
      }
    }

    for (const line of await dangling()) dangled.push(`round ${round}: ${line}`);
    // What the next round deletes beside its own: this round's pictures that are still named.
    carried = pictures.filter((id) => library.has(id));
  }

  reading = false;
  await Promise.all(readers);

  console.log(
    `INFO  over ${LOOPS} rounds: ${tally.stored} writes stored, ${tally.refusedGone} refused because a picture had gone; ` +
      `${tally.deleted} deletes done, ${tally.refusedInUse} refused because the picture was in use`,
  );
  const total = tally.stored + tally.refusedGone + tally.deleted + tally.refusedInUse;
  say(
    "R1. every answer is definite: a write stored or refused by name because its picture had gone, a delete done or refused as in use — nothing else",
    odd.length === 0 && incidents.length === 0 && total > 0,
    `${total} answers${odd[0] ? ` — ${odd[0]}` : ""}${incidents[0] ? ` — ${incidents[0]}` : ""}`,
  );
  say("R2. after every round nothing names a picture the library no longer has", dangled.length === 0, dangled.slice(0, 3).join(" | "));
  say(
    "R3. a delete that answered done left the picture out of the library; one refused as in use left it in",
    deleteMismatch.length === 0,
    deleteMismatch.slice(0, 3).join(" | "),
  );
  say("R4. a write that answered stored holds exactly the pictures it named", storeMismatch.length === 0, storeMismatch.slice(0, 3).join(" | "));
  say(
    "R5. the public pages, read in both editions throughout: every answer whole",
    readIncidents.length === 0 && reads > 0,
    `${reads} reads${readIncidents[0] ? ` — ${readIncidents[0]}` : ""}`,
  );
  const failures = serverFailureLines(server.lines());
  const deadlocks = server.lines().filter((line: { text: string }) => /deadlock detected|40P01/i.test(line.text));
  say(
    "R6. the server wrote no deadlock and no failure",
    failures.length === 0 && deadlocks.length === 0,
    [...deadlocks, ...failures].slice(0, 3).map((line: { text: string }) => line.text.slice(0, 200)).join(" | "),
  );
} finally {
  await server?.stop();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
