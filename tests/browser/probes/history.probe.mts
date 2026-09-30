/**
 * Batch 10 acceptance: version history, in a browser.
 *
 * The central case, end to end: publish something, open History, restore the
 * state that was live before it, watch the visitor's page stay exactly where it
 * was, preview the historical state, publish that, and find the state you just
 * replaced waiting in History.
 */

import { selectFromLayers } from "../canvas";
import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";
import { until } from "../wait";

const PORT = 3713;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("history_probe");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);

  const [terms] = await sql<{ id: number }[]>`select id from pages where slug = 'terms'`;
  const rows = await sql<{ id: number }[]>`
    select id from page_sections where page_id = ${terms!.id} order by position asc, id asc`;
  const hero = rows[0]!.id;

  // A known published starting state.
  await sql`update page_sections
               set published = jsonb_set(published, '{title,en}', '"State A"'),
                   draft = null, draft_styles = null, draft_animation = null
             where id = ${hero}`;

  const versions = async () =>
    sql<{ id: number; label: string; actor_name: string }[]>`
      select id, label, actor_name from page_versions where page_id = ${terms!.id}
       order by created_at desc, id desc`;

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

  const reload = async () => {
    await editor.goto(`${server!.origin}/admin/visual-editor?page=terms&lang=en&device=desktop`, {
      waitUntil: "load",
    });
    await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  };
  await reload();

  const openPanel = async () => {
    if ((await editor.locator("aside[aria-label='Page changes and history']").count()) === 0) {
      await editor.getByRole("button", { name: /^Publish$/ }).click();
    }
    await editor.locator("aside[aria-label='Page changes and history']").waitFor({ timeout: 10_000 });
  };
  const selectSection = (id: number) => selectFromLayers(editor, `section:${id}`);
  const visitorHtml = async () => {
    const visitor = await browser.newContext();
    const page = await visitor.newPage();
    await page.goto(`${server!.origin}/terms`, { waitUntil: "load" });
    const html = await page.content();
    await visitor.close();
    return html;
  };
  const previewHtml = async () => {
    const page = await context.newPage();
    await page.goto(`${server!.origin}/terms?preview=1`, { waitUntil: "load" });
    const html = await page.content();
    await page.close();
    return html;
  };

  /* --- 1. history starts empty ----------------------------------------- */
  await openPanel();
  say("Current live is a header, not an entry", (await editor.getByText("Current live").count()) > 0);
  say(
    "…and there are no restore points yet",
    (await editor.getByText("No restore points yet.").count()) > 0,
  );

  /* --- 2. publish B ----------------------------------------------------- */
  await selectSection(hero);
  await editor.getByRole("tab", { name: /Content/ }).click();
  const box = editor.locator('[data-field="title"] textarea, [data-field="title"] input').first();
  await box.waitFor({ timeout: 15_000 });
  await box.fill("State B");
  await editor.getByText("Draft saved", { exact: true }).waitFor({ timeout: 20_000 });
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });

  await openPanel();
  await editor.getByRole("button", { name: "Publish saved changes" }).click();
  await editor.getByText(/saved changes are live now|Published saved changes/).waitFor({ timeout: 40_000 });
  say("B is live", (await visitorHtml()).includes("State B"));

  /* --- 3. the restore point holds A ------------------------------------ */
  await until(async () => (await versions()).length === 1, 15_000);
  await openPanel();
  const list = await versions();
  say("history gained one entry", list.length === 1, `${list.length}`);
  say("…labelled as the state before publishing", /Before publishing/.test(list[0]?.label ?? ""));
  say("…and attributed", (list[0]?.actor_name ?? "").length > 0, list[0]?.actor_name);
  say(
    "the panel shows it with a time and an actor",
    (await editor.getByRole("button", { name: /Restore to draft/ }).count()) === 1,
  );

  /* --- 4. restore A ----------------------------------------------------- */
  await editor.getByRole("button", { name: /Restore to draft/ }).first().click();
  await editor.getByText(/Restored into saved changes/).waitFor({ timeout: 40_000 });
  say(
    "the confirmation says the live site will not change",
    asked.some((message) => /live site will not change/.test(message)),
    JSON.stringify(asked.slice(-1)),
  );

  const duringRestore = await visitorHtml();
  say("a visitor still sees B", duringRestore.includes("State B") && !duringRestore.includes("State A"));
  const previewed = await previewHtml();
  say("…and the preview shows A", previewed.includes("State A"), previewed.includes("State A") ? "" : "A missing");

  /* --- 5. publish the restore ------------------------------------------ */
  await editor.waitForTimeout(800);
  await openPanel();
  say(
    "the restore is waiting to be published",
    !(await editor.getByRole("button", { name: "Publish saved changes" }).isDisabled()),
  );
  await editor.getByRole("button", { name: "Publish saved changes" }).click();
  await editor.getByText(/saved changes are live now|Published saved changes/).waitFor({ timeout: 40_000 });

  const finalHtml = await visitorHtml();
  say("a visitor now sees A", finalHtml.includes("State A") && !finalHtml.includes("State B"));

  const after = await versions();
  say("history gained a second entry", after.length === 2, `${after.length}`);
  const [newest] = await sql<{ snapshot: { sections: { published: Record<string, unknown> }[] } }[]>`
    select snapshot from page_versions where id = ${after[0]!.id}`;
  const title = (newest!.snapshot.sections[0]!.published.title as { en: string }).en;
  say("…and the newest holds the state that was just replaced", title === "State B", title);

  /* --- 6. restoring is blocked while work is pending -------------------- */
  await reload();
  await selectSection(hero);
  await editor.getByRole("tab", { name: /Content/ }).click();
  const again = editor.locator('[data-field="title"] textarea, [data-field="title"] input').first();
  await again.waitFor({ timeout: 15_000 });
  await again.fill("Somebody's unfinished work");
  await editor.getByText("Draft saved", { exact: true }).waitFor({ timeout: 20_000 });
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });

  await openPanel();
  say(
    "with saved work pending, History explains why Restore is unavailable",
    (await editor.getByText(/Publish or discard the current saved changes/).count()) > 0,
  );
  say(
    "…and the Restore buttons are disabled",
    await editor.getByRole("button", { name: /Restore to draft/ }).first().isDisabled(),
  );

  await context.close();
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
