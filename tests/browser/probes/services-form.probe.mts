/**
 * Batch 23: the Services form left open while the service changes elsewhere,
 * in a real Chromium.
 *
 * Two tabs hold the same service's edit page, as two admins would. What one
 * saves, the other's stale form must not put back; a field both changed is
 * refused with a message naming it, and nothing of that save is written; a
 * reload shows the newer version and saves normally. The same against the
 * Visual Editor publishing the service's page, and against the Visual
 * Editor's own buffer: opened before a Services save, it drafts only what is
 * typed in it, so its publication does not put the older value back. Every
 * outcome is read back from the database, not from the screen alone.
 */

import { giveFresh } from "../../helpers/fixtures";
import { callAction } from "../../helpers/action";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { editorIdle, editorSettled, selectFromLayers } from "../canvas";
import { launchChromium } from "../harness";
import { until } from "../wait";

import { documentEditorKey, editorKeyOf, type RouteOwner } from "../../../src/lib/routes/owners";

import type { Page } from "playwright";

const PORT = 3737;
const VE = { route: "/admin/visual-editor", file: "app/(backoffice)/admin/visual-editor/route-actions.ts" };
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("services_form_probe");
const sql = connect(database);
let server;
try {
  const admins = [await signIn(sql), await signIn(sql)];
  server = await startServer(database, PORT);
  const origin = server.origin;

  const [service] = await sql<{ id: number; title_en: string; timeline_en: string; intro_en: string }[]>`
    select s.id, s.title_en, s.timeline_en, s.intro_en from services s join service_categories c on c.id = s.category_id
     where s.is_published and c.is_published order by c.sort_order, c.id, s.sort_order, s.id limit 1`;
  if (!service) throw new Error("the fixture has no published service");
  const row = async () =>
    (await sql<{ title_en: string; timeline_en: string; intro_en: string; updated_at: Date }[]>`
      select title_en, timeline_en, intro_en, updated_at from services where id = ${service.id}`)[0]!;

  const errors: string[] = [];
  const tab = async (index: number): Promise<Page> => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const [name, value] = admins[index]!.cookie.split("=");
    await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message.slice(0, 160)));
    page.on("dialog", (dialog) => void dialog.accept());
    await page.goto(`${origin}/admin/services/${service.id}`, { waitUntil: "load" });
    await page.locator("#titleEn").waitFor({ timeout: 30_000 });
    return page;
  };
  const banner = (page: Page) => page.getByRole("status").first();
  const saveOn = async (page: Page) => {
    await page.getByRole("button", { name: "Save changes" }).click();
    await until(async () => ((await banner(page).textContent().catch(() => "")) ?? "").trim().length > 0, 20_000);
    // Until the button is back from "Saving…".
    await until(async () => (await page.getByRole("button", { name: "Save changes" }).count()) === 1, 20_000);
    return ((await banner(page).textContent()) ?? "").trim();
  };
  const baseOf = (page: Page) => page.locator('input[name="_base"]').getAttribute("value");

  /* ------------------------------------------------------------------ */
  /* Two tabs, two fields                                                 */
  /* ------------------------------------------------------------------ */
  const a = await tab(0);
  const b = await tab(1);
  const aBase = await baseOf(a);

  await b.locator("#titleEn").fill("Changed in tab B");
  const bSaid = await saveOn(b);
  const afterB = await row();
  say("Tab B saves the English title", bSaid === "Service saved." && afterB.title_en === "Changed in tab B", bSaid);

  await a.locator("#timelineEn").fill("Timeline from tab A");
  const aSaid = await saveOn(a);
  const afterA = await row();
  say(
    "Tab A, opened before B's save, saves the timeline — and does not put B's title back",
    aSaid === "Service saved." && afterA.title_en === "Changed in tab B" && afterA.timeline_en === "Timeline from tab A",
    JSON.stringify({ aSaid, title: afterA.title_en, timeline: afterA.timeline_en }),
  );
  const refreshed = await until(async () => (await a.locator("#titleEn").inputValue()) === "Changed in tab B", 15_000);
  say(
    "…and tab A's form is drawn again from the stored row, with a new base: it now shows B's title",
    refreshed && (await baseOf(a)) !== aBase,
    await a.locator("#titleEn").inputValue(),
  );

  /* ------------------------------------------------------------------ */
  /* A field both changed                                                 */
  /* ------------------------------------------------------------------ */
  const stamped = (await row()).updated_at.getTime();
  await b.locator("#timelineEn").fill("Timeline from tab B");
  await b.locator("#introEn").fill("Intro from tab B, which merged cleanly");
  const refusal = await saveOn(b);
  const afterRefusal = await row();
  say(
    "Tab B, now stale, changes the timeline A saved: refused, naming the field",
    /Indicative timeline \(English\) was changed elsewhere/.test(refusal) && /nothing was saved/.test(refusal) && /Reload the page/.test(refusal),
    refusal,
  );
  say(
    "…nothing of that save is written: the timeline is A's, the introduction untouched, the row not stamped",
    afterRefusal.timeline_en === "Timeline from tab A" &&
      afterRefusal.intro_en === service.intro_en &&
      afterRefusal.updated_at.getTime() === stamped,
    JSON.stringify({ timeline: afterRefusal.timeline_en, intro: afterRefusal.intro_en }),
  );
  say("…and the message carries no internals", !/select|update|insert|sql|postgres|secret|stack/i.test(refusal));

  await b.reload({ waitUntil: "load" });
  await b.locator("#timelineEn").waitFor({ timeout: 30_000 });
  const shown = await b.locator("#timelineEn").inputValue();
  await b.locator("#timelineEn").fill("Timeline from tab B, after a reload");
  const retried = await saveOn(b);
  say(
    "Reloaded, tab B shows A's timeline and saves its own over it",
    shown === "Timeline from tab A" && retried === "Service saved." && (await row()).timeline_en === "Timeline from tab B, after a reload",
    JSON.stringify({ shown, retried }),
  );

  /* ------------------------------------------------------------------ */
  /* The Visual Editor publishes while the form is open                   */
  /* ------------------------------------------------------------------ */
  const call = async <T,>(action: string, args: unknown[]) =>
    (await callAction<T>({ ...VE, origin, action, args, cookie: admins[0]!.cookie })).value;
  const form = (fields: Record<string, string | number>) => {
    const data = new FormData();
    data.set("_csrf", admins[0]!.csrfToken);
    for (const [key, value] of Object.entries(fields)) data.set(key, String(value));
    return data;
  };
  const hero: RouteOwner = { type: "serviceHero", id: service.id };
  const pageId = documentEditorKey({ kind: "service", id: service.id });
  /** The editor drafts the hero's English introduction and publishes it. */
  const publishIntro = async (text: string) => {
    const loaded = await call<{ ok: boolean; section: { revision: number; values: Record<string, unknown> } }>("loadRouteRegion", [editorKeyOf(hero), pageId]);
    const values = loaded!.section.values;
    await call("saveRouteRegionDraft", [
      form({
        sectionId: editorKeyOf(hero),
        pageId,
        expectedRevision: loaded!.section.revision,
        values: JSON.stringify({ ...values, intro: { ...(values.intro as object), en: text } }),
      }),
    ]);
    const summary = await call<{ token: string }>("loadRouteSummary", [`service:${service.id}`]);
    return (await call<{ ok: boolean }>("publishRouteFromEditor", [form({ routeKey: `service:${service.id}`, token: summary!.token })]))?.ok === true;
  };
  const reopen = async (page: Page) => {
    await page.reload({ waitUntil: "load" });
    await page.locator("#timelineEn").waitFor({ timeout: 30_000 });
  };

  // Opened, then the editor publishes the introduction: the same field from the form is refused.
  await reopen(a);
  const first = await publishIntro("Intro published from the editor");
  await a.locator("#introEn").fill("Intro from tab A");
  const clash = await saveOn(a);
  say(
    "The editor publishes the introduction while tab A is open; A changing the introduction is refused, and the published one stays",
    first && /Short introduction \(English\) was changed elsewhere/.test(clash) && (await row()).intro_en === "Intro published from the editor",
    clash,
  );

  // Opened, then the editor publishes again: a different field from the form lands, the introduction stays.
  await reopen(a);
  const second = await publishIntro("Intro published again from the editor");
  await a.locator("#timelineEn").fill("Timeline after the publication");
  const overEditor = await saveOn(a);
  const afterEditor = await row();
  say(
    "…while a timeline save from a tab opened before the next publication keeps the newly published introduction",
    second && overEditor === "Service saved." && afterEditor.intro_en === "Intro published again from the editor" && afterEditor.timeline_en === "Timeline after the publication",
    JSON.stringify({ second, overEditor, intro: afterEditor.intro_en }),
  );

  /* ------------------------------------------------------------------ */
  /* The Visual Editor's own buffer, opened before a Services save        */
  /* ------------------------------------------------------------------ */
  // The editor with the hero selected — its fields loaded into the buffer — then
  // the Services screen saves the introduction, then the editor types the timeline.
  const editor = await tab(0);
  await editor.goto(`${origin}/admin/visual-editor?route=service:${service.id}&lang=en&device=desktop`, { waitUntil: "load" });
  await editorSettled(editor, 60_000);
  await selectFromLayers(editor, `serviceHero:${service.id}`);
  await editor.getByRole("tab", { name: /Content/ }).click();
  const inspector = editor.locator("aside[aria-label='Inspector']");
  const timelineBox = inspector.locator('[data-field="timeline"] input').first();
  await timelineBox.waitFor({ timeout: 15_000 });

  await reopen(a);
  await a.locator("#introEn").fill("Intro saved on the Services screen while the editor was open");
  const formSaved = await saveOn(a);

  const draftOf = async () =>
    (await sql<{ d: Record<string, { value: unknown; base: unknown }> | null }[]>`
      select draft_content as d from route_nodes where owner_key = ${`serviceHero:${service.id}`}`)[0]?.d ?? null;
  await timelineBox.fill("Timeline typed in the editor");
  const drafted = await until(async () => (await draftOf())?.timelineEn?.value === "Timeline typed in the editor", 20_000);
  await editorIdle(editor);
  const draft = await draftOf();
  const editorSummary = await call<{ token: string }>("loadRouteSummary", [`service:${service.id}`]);
  const fromEditor = await call<{ ok: boolean }>("publishRouteFromEditor", [form({ routeKey: `service:${service.id}`, token: editorSummary!.token })]);
  const afterBuffer = await row();
  say(
    "The editor's buffer, loaded before the Services save, drafts only what was typed in it: the introduction is not in the draft",
    formSaved === "Service saved." && drafted && draft !== null && !("introEn" in draft),
    JSON.stringify(Object.keys(draft ?? {})),
  );
  say(
    "…and its publication keeps the Services screen's introduction beside the editor's timeline",
    fromEditor?.ok === true &&
      afterBuffer.intro_en === "Intro saved on the Services screen while the editor was open" &&
      afterBuffer.timeline_en === "Timeline typed in the editor",
    JSON.stringify({ published: fromEditor?.ok, intro: afterBuffer.intro_en, timeline: afterBuffer.timeline_en }),
  );

  const live = await (await fetch(`${origin}${(await sql<{ path: string }[]>`
    select '/services/' || c.slug || '/' || s.slug as path from services s join service_categories c on c.id = s.category_id where s.id = ${service.id}`)[0]!.path}`)).text();
  say(
    "the public page shows what was saved last — B's title, the Services screen's introduction, the editor's timeline",
    live.includes("Changed in tab B") && live.includes("Intro saved on the Services screen while the editor was open") && live.includes("Timeline typed in the editor"),
  );
  say("no page errors on either tab", errors.length === 0, errors.join(" | "));
} finally {
  await browser.close();
  await server?.stop();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
