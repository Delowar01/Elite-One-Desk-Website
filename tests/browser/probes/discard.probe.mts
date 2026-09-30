/**
 * Batch 10 acceptance: throwing a page's saved changes away.
 *
 * The promise: one button clears everything waiting — text, styles, entrances,
 * the layout and the sections the layout invented — and a visitor's page does
 * not move an inch.
 */

import { editorIdle, selectFromLayers } from "../canvas";
import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";
import { until } from "../wait";

const PORT = 3707;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("discard_probe");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);

  const [about] = await sql<{ id: number }[]>`select id from pages where slug = 'about'`;
  const rows = await sql<{ id: number }[]>`
    select id from page_sections where page_id = ${about!.id} order by position asc, id asc`;
  const hero = rows[0]!.id;
  const second = rows[1]!.id;

  const state = async () =>
    (await sql<{ n: number; drafts: number; styles: number; motion: number; pending: number }[]>`
       select count(*)::int as n,
              count(draft)::int as drafts,
              count(draft_styles)::int as styles,
              -- Batch 15: motion has two draft columns, and either is a motion draft.
              count(*) filter (where draft_animation is not null or draft_motion_config is not null)::int as motion,
              count(*) filter (where is_draft_only)::int as pending
         from page_sections where page_id = ${about!.id}`)[0]!;
  const structure = async () =>
    (await sql<{ draft_structure: unknown }[]>`select draft_structure from pages where id = ${about!.id}`)[0]!
      .draft_structure;
  const versions = async () =>
    (await sql<{ n: number }[]>`select count(*)::int as n from page_versions where page_id = ${about!.id}`)[0]!.n;

  const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);

  const editor = await context.newPage();
  editor.on("pageerror", (error) => console.log("   [pageerror]", error.message.slice(0, 140)));
  const asked: string[] = [];
  editor.on("dialog", (dialog) => {
    asked.push(dialog.message());
    void dialog.accept();
  });
  await editor.goto(`${server.origin}/admin/visual-editor?page=about&lang=en&device=desktop`, {
    waitUntil: "load",
  });
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });

  const selectSection = (id: number) => selectFromLayers(editor, `section:${id}`);
  const openPanel = async () => {
    if ((await editor.locator("aside[aria-label='Page changes and history']").count()) === 0) {
      await editor.getByRole("button", { name: /^Publish$/ }).click();
    }
    await editor.locator("aside[aria-label='Page changes and history']").waitFor({ timeout: 10_000 });
  };
  const visitor = async () => {
    const fresh = await browser.newContext();
    const page = await fresh.newPage();
    await page.goto(`${server!.origin}/about`, { waitUntil: "load" });
    const html = await page.content();
    await fresh.close();
    return [...html.matchAll(/data-section="([^"]+)"/g)].map((m) => m[1]);
  };

  const before = await visitor();
  const versionsBefore = await versions();
  const sectionsBefore = (await state()).n;

  /* --- one of everything ------------------------------------------------ */
  await selectSection(hero);
  await editor.getByRole("tab", { name: /Content/ }).click();
  const box = editor.locator('[data-field="title"] textarea, [data-field="title"] input').first();
  await box.waitFor({ timeout: 15_000 });
  await box.fill("Never going out");
  await editor.getByRole("tab", { name: /Motion/ }).click();
  await editor.locator('[data-motion-field="entrance"] select').selectOption({ label: "Scale in" });
  await editor.getByRole("tab", { name: /Style/ }).click();
  const token = editor.locator('[data-style-token="background"] select');
  await token.waitFor({ timeout: 15_000 });
  await token.selectOption("ink-700");
  // All three domains saved — the state the next checks read (Batch 19A: was a
  // fixed 3.5 s) — and the editor past the redraw the last save causes, which
  // arrives a moment after the row is committed: selecting the next section
  // before then would be answered by the old canvas and undone by the new one.
  await until(async () => {
    const now = await state();
    return now.drafts > 0 && now.styles > 0 && now.motion > 0;
  }, 20_000);
  await editorIdle(editor);

  await selectSection(second);
  await editor.getByRole("tab", { name: /Content/ }).click();
  const other = editor.locator('[data-field="title"] textarea, [data-field="title"] input').first();
  if ((await other.count()) > 0) {
    await other.waitFor({ timeout: 15_000 });
    await other.fill("Also never");
    await editor.getByText("Draft saved", { exact: true }).waitFor({ timeout: 20_000 });
    await editorIdle(editor);
  }

  // …plus a layout change and a section that exists only in it.
  await editor.getByRole("button", { name: "Add section" }).click();
  await editor.locator("[data-block-picker]").waitFor({ timeout: 10_000 });
  await editor.locator("[data-block-picker] button[data-block-type]").first().click();
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  await until(async () => (await state()).pending > 0 && (await structure()) !== null, 20_000);

  const dirty = await state();
  say("the page has content, style and motion drafts", dirty.drafts > 0 && dirty.styles > 0 && dirty.motion > 0,
    JSON.stringify(dirty));
  say("…a pending section", dirty.pending > 0, `${dirty.pending}`);
  say("…and a layout draft", (await structure()) !== null);

  /* --- discard ----------------------------------------------------------- */
  await openPanel();
  // The panel's own summary has caught up with the layout change — only the
  // re-read one lists the new section — so Discard names the page's current
  // revision (Batch 19A: the database having the row is not the panel knowing).
  const panel = editor.locator("aside[aria-label='Page changes and history']");
  await until(async () => (await panel.getByText(/\bnew section/).count()) > 0, 20_000);
  await editor.getByRole("button", { name: "Discard all saved changes" }).click();
  await editor.getByText(/Saved changes discarded/).waitFor({ timeout: 40_000 });
  say(
    "it asks first, and says the live page will not change",
    asked.some((message) => /live page does not change/.test(message)),
    JSON.stringify(asked.slice(-1)),
  );

  const clean = await state();
  say("every content draft is gone", clean.drafts === 0);
  say("every style draft is gone", clean.styles === 0);
  say("every motion draft is gone", clean.motion === 0);
  say("the pending section is gone", clean.pending === 0);
  say("…and its row with it", clean.n === sectionsBefore, `${sectionsBefore} → ${clean.n}`);
  say("the layout draft is gone", (await structure()) === null);
  say("no restore point was written", (await versions()) === versionsBefore);
  say("a visitor's page is exactly as it was", JSON.stringify(await visitor()) === JSON.stringify(before));

  /* --- the editor settles ------------------------------------------------ */
  await openPanel();
  await until(async () => (await editor.getByText("No saved changes. This page is the same as the live one.").count()) > 0, 15_000);
  say(
    "the panel says there is nothing waiting",
    (await editor.getByText("No saved changes. This page is the same as the live one.").count()) > 0,
  );
  say("…and offers neither button", 
    (await editor.getByRole("button", { name: "Publish saved changes" }).isDisabled()) &&
    (await editor.getByRole("button", { name: "Discard all saved changes" }).isDisabled()));
  say("the toolbar shows nothing unsaved", (await editor.getByText(/\d+ unsaved/).count()) === 0);

  await selectSection(hero);
  await editor.getByRole("tab", { name: /Content/ }).click();
  const restored = editor.locator('[data-field="title"] textarea, [data-field="title"] input').first();
  await restored.waitFor({ timeout: 15_000 });
  say(
    "the section shows the published words again",
    (await restored.inputValue()) !== "Never going out",
    await restored.inputValue(),
  );

  await context.close();
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
