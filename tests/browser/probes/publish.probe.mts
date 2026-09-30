/**
 * Batch 10 acceptance: publishing a page from the editor.
 *
 * The promise: the button waits for autosave, tells the truth about what it is
 * about to do, and then the page a visitor gets is the page the editor was
 * previewing — with every draft badge cleared and the layout draft gone.
 */

import { canvasRedrawn, canvasUrl, selectFromLayers } from "../canvas";
import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";
import { until } from "../wait";

const PORT = 3720;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("publish_probe");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);

  const [about] = await sql<{ id: number }[]>`select id from pages where slug = 'about'`;
  const rows = await sql<{ id: number; block_type: string }[]>`
    select id, block_type from page_sections where page_id = ${about!.id} order by position asc, id asc`;
  const hero = rows[0]!.id;

  const pageRow = async () =>
    (await sql<{ revision: number; draft_structure: unknown }[]>`
       select revision, draft_structure from pages where id = ${about!.id}`)[0]!;
  const versions = async () =>
    (await sql<{ n: number }[]>`select count(*)::int as n from page_versions where page_id = ${about!.id}`)[0]!.n;
  const sectionRow = async (id: number) =>
    (await sql<{ draft: Record<string, unknown> | null; published: Record<string, unknown>; is_draft_only: boolean }[]>`
       select draft, published, is_draft_only from page_sections where id = ${id}`)[0]!;

  const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);

  const editor = await context.newPage();
  editor.on("pageerror", (error) => console.log("   [pageerror]", error.message.slice(0, 140)));
  const confirmed: string[] = [];
  editor.on("dialog", (dialog) => {
    confirmed.push(dialog.message());
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
  const publicSections = async () => {
    const visitor = await browser.newContext();
    const page = await visitor.newPage();
    await page.goto(`${server!.origin}/about`, { waitUntil: "load" });
    const html = await page.content();
    await visitor.close();
    return { html, order: [...html.matchAll(/data-section="([^"]+)"/g)].map((m) => m[1]) };
  };

  /* --- 1. nothing waiting ---------------------------------------------- */
  await openPanel();
  say(
    "with nothing saved the panel says so",
    (await editor.getByText("No saved changes. This page is the same as the live one.").count()) > 0,
  );
  say(
    "…and Publish is not offered",
    await editor.getByRole("button", { name: "Publish saved changes" }).isDisabled(),
  );

  /* --- 2. Publish waits for autosave ----------------------------------- */
  await selectSection(hero);
  await editor.getByRole("tab", { name: /Content/ }).click();
  const box = editor.locator('[data-field="title"] textarea, [data-field="title"] input').first();
  await box.waitFor({ timeout: 15_000 });
  await box.fill("Published from the editor");
  await openPanel();
  say(
    "with local work unsaved, Publish waits",
    (await editor.getByRole("button", { name: /Publish saved changes|Working/ }).isDisabled()) &&
      (await editor.getByText("Saving drafts…").count()) > 0,
  );

  await editor.getByText("Draft saved", { exact: true }).waitFor({ timeout: 20_000 });
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  say("…and stops waiting once the draft is on the server", (await sectionRow(hero)).draft !== null);

  /* --- 3. the review says what the server holds ------------------------ */
  const added = await editor
    .locator("aside[aria-label='Page structure']")
    .getByRole("button", { name: /Add section/ })
    .count();
  // A layout change as well, so the review has more than one line to report.
  const firstRow = editor.locator(
    `aside[aria-label='Page structure'] li[data-section-id="${rows[1]!.id}"]`,
  );
  await firstRow.getByRole("button", { name: /Hide when the layout is published/ }).click();
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  await editor.waitForTimeout(800);

  await openPanel();
  await editor.getByRole("button", { name: "Refresh" }).count();
  const lines = await editor
    .locator("aside[aria-label='Page changes and history'] ul li")
    .allTextContents();
  say(
    "the review lists the server's own counts",
    lines.some((line) => /content draft/.test(line)) && lines.some((line) => /layout changed/.test(line)),
    JSON.stringify(lines),
    );
  say("…and Publish is now offered", added >= 0 &&
    !(await editor.getByRole("button", { name: "Publish saved changes" }).isDisabled()));

  /* --- 4. publishing ---------------------------------------------------- */
  const before = await publicSections();
  const versionsBefore = await versions();
  const structureBefore = (await pageRow()).draft_structure;
  say("a layout draft is stored before publishing", structureBefore !== null);

  const canvasBefore = canvasUrl(editor);
  await editor.getByRole("button", { name: "Publish saved changes" }).click();
  await editor.getByText(/saved changes are live now|Published saved changes/).waitFor({ timeout: 40_000 });
  say("the editor reports the page as live", true);
  say(
    "…after asking, and saying what it would do",
    confirmed.some((message) => /Publish the saved changes/.test(message)),
    JSON.stringify(confirmed.slice(-1)),
  );

  const after = await publicSections();
  say("a visitor now sees the published words", after.html.includes("Published from the editor"));
  say(
    "…and the hidden section is gone from the live page",
    after.order.length === before.order.length - 1,
    `${before.order.length} → ${after.order.length}`,
  );
  say("the layout draft is cleared", (await pageRow()).draft_structure === null);
  say("the content draft is cleared", (await sectionRow(hero)).draft === null);
  say("exactly one restore point was written", (await versions()) === versionsBefore + 1);

  /* --- 5. the editor is consistent afterwards --------------------------- */
  // The editor re-reads the page first and redraws the canvas last, and Layers
  // is the canvas's own account of its sections — empty while the new one
  // loads. So Layers is read once the redraw is over and it lists the page
  // again, never in between, where "no row says Draft" would be true of no
  // rows at all (Batch 19A).
  await canvasRedrawn(editor, canvasBefore);
  await until(async () => (await editor.locator("aside[aria-label='Page structure'] [data-layer-row]").count()) > 0, 15_000);
  await until(
    async () =>
      (await editor.getByRole("button", { name: "Publish saved changes" }).isDisabled()) &&
      (await editor.getByText("No saved changes. This page is the same as the live one.").count()) > 0,
    15_000,
  );
  say(
    "the panel no longer offers a publication",
    await editor.getByRole("button", { name: "Publish saved changes" }).isDisabled(),
  );
  say(
    "…and says there is nothing waiting",
    (await editor.getByText("No saved changes. This page is the same as the live one.").count()) > 0,
  );
  say(
    "no section still claims a draft",
    (await editor.locator("aside[aria-label='Page structure']").getByText("Draft", { exact: true }).count()) === 0,
  );
  say("the toolbar shows nothing unsaved", (await editor.getByText(/\d+ unsaved/).count()) === 0);

  /* --- 6. the selection survives where the section did ------------------ */
  await selectSection(hero);
  await editor.getByRole("tab", { name: /Content/ }).click();
  const reopened = editor.locator('[data-field="title"] textarea, [data-field="title"] input').first();
  await reopened.waitFor({ timeout: 15_000 });
  say(
    "reopening the section shows the published words, not a stale draft",
    (await reopened.inputValue()) === "Published from the editor",
    await reopened.inputValue(),
  );
  say("…with no draft on file", (await editor.getByText("No changes").count()) > 0);

  await context.close();
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
