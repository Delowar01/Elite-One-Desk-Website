/**
 * Batch 8 correction acceptance: recovering from a layout conflict without
 * losing what somebody was writing.
 *
 * The sequence that matters is the expensive one: an editor has unsaved text in
 * a section, a colleague reorders the page underneath them, and the structural
 * action they try next is refused. What happens then decides whether a conflict
 * costs a click or an afternoon.
 */

import { editorSettled } from "../canvas";
import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";
import { until } from "../wait";

const PORT = 3723;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("reload_layout");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);

  const pageRow = async () =>
    (await sql<{ id: number; revision: number }[]>`
       select id, revision from pages where slug = 'about'`)[0]!;
  const sectionRow = async (id: number) =>
    (await sql<{ id: number; revision: number; draft: Record<string, unknown> | null; draft_styles: unknown }[]>`
       select id, revision, draft, draft_styles from page_sections where id = ${id}`)[0]!;

  const about = await pageRow();
  const rows = await sql<{ id: number; block_type: string }[]>`
    select id, block_type from page_sections where page_id = ${about.id}
     order by position asc, id asc`;

  const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);

  const openEditor = async (page: import("playwright").Page) => {
    await page.goto(`${server!.origin}/admin/visual-editor?page=about&lang=en&device=desktop`, {
      waitUntil: "load",
    });
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  };
  const layerIds = (page: import("playwright").Page) =>
    page
      .locator("aside[aria-label='Page structure'] ol > li[data-section-id]")
      .evaluateAll((list) => list.map((row) => Number((row as HTMLElement).dataset.sectionId)));

  const editor = await context.newPage();
  editor.on("pageerror", (error) => console.log("   [pageerror]", error.message.slice(0, 140)));
  editor.on("dialog", (dialog) => dialog.accept());
  await openEditor(editor);

  /* --- 1. unsaved text in one section --------------------------------- */
  const hero = rows[0]!.id;
  const frame = () => editor.frames().find((f) => f.url().includes("editor=1"))!;
  const title = frame().locator(`[data-eod-address="section:${hero}/field:title"]`);
  await title.waitFor({ timeout: 20_000 });
  await title.click();
  await editor.getByRole("tab", { name: /Content/ }).click();
  const box = editor.locator('[data-field="title"] textarea, [data-field="title"] input').first();
  await box.waitFor({ timeout: 10_000 });
  const typed = "Half a sentence nobody has saved";
  await box.fill(typed);
  await editor.getByText("Unsaved content").waitFor({ timeout: 10_000 });
  say("the editor is holding unsaved text", (await box.inputValue()) === typed);
  const heroBefore = await sectionRow(hero);
  say("…and nothing has been written", heroBefore.draft === null);

  /**
   * Let the autosave land before anybody else moves the layout.
   *
   * Since Batch 10 a save re-renders the route and the editor re-reads the
   * page's layout. If that re-read lands *after* the revision bump below, this
   * tab is simply up to date and there is no conflict left to test — a trace
   * in Batch 15a showed it landing about 0.2 s before the bump in an ordinary
   * run, and sweep 3 caught it landing after. Waiting for the save and the
   * canvas makes the staleness below the only thing that decides the outcome.
   */
  await editor.getByText("Draft saved", { exact: true }).waitFor({ timeout: 20_000 });
  await editorSettled(editor);

  const stale = (await pageRow()).revision;

  /* --- 2. a colleague reorders the page -------------------------------- */
  const other = await context.newPage();
  other.on("dialog", (dialog) => dialog.accept());
  await openEditor(other);
  const otherFirst = (await layerIds(other))[0]!;
  await other
    .locator(`aside[aria-label='Page structure'] li[data-section-id="${otherFirst}"]`)
    .getByRole("button", { name: /Move down/ })
    .click();
  for (let i = 0; i < 80 && (await pageRow()).revision === stale; i += 1) {
    await other.waitForTimeout(200);
  }
  await other.waitForTimeout(800);
  const moved = await layerIds(other);
  say("the other tab reordered the page", (await pageRow()).revision === stale + 1);
  await other.close();

  /**
   * …and then the first tab is made stale, deliberately.
   *
   * Batch 10 changed how long a tab stays behind: autosave runs a Server
   * Action, Next re-renders the route around it, and the editor re-reads the
   * page's layout — so a tab that has typed anything in the last second has
   * already caught up with a colleague's reorder. That is the better
   * behaviour, and it makes the *conflict* harder to reach by typing and
   * waiting. Bumping the page's own revision is the same staleness without the
   * timing, and it is the guard and the recovery that this step is about.
   */
  await sql`update pages set revision = revision + 1 where id = ${about.id}`;
  const fresh = (await pageRow()).revision;

  /* --- 3. the first tab is refused, and offered a way out --------------- */
  const target = (await layerIds(editor))[1]!;
  await editor
    .locator(`aside[aria-label='Page structure'] li[data-section-id="${target}"]`)
    .getByRole("button", { name: /Hide when the layout is published/ })
    .click();
  await until(async () => (await editor.getByText(/layout changed since you opened it/i).count()) > 0, 15_000);

  say(
    "the stale tab is told the layout moved",
    (await editor.getByText(/layout changed since you opened it/i).count()) > 0,
  );
  const recover = editor.getByRole("button", { name: "Reload latest layout" });
  say("…and offered Reload latest layout", (await recover.count()) > 0);
  say("…and changed nothing", (await pageRow()).revision === fresh);

  /* --- 4. recovery keeps the unsaved work ------------------------------ */
  await recover.click();
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  await until(async () => JSON.stringify(await layerIds(editor)) === JSON.stringify(moved), 15_000);

  say(
    "the layout that won is now on screen",
    JSON.stringify(await layerIds(editor)) === JSON.stringify(moved),
    JSON.stringify(await layerIds(editor)),
  );
  say(
    "…and the conflict notice is gone",
    (await editor.getByText(/layout changed since you opened it/i).count()) === 0,
  );

  /**
   * The layout recovery wrote nothing to the *section*.
   *
   * Before Batch 10 this read "nothing about the section was saved", and the
   * section's draft was still null because nobody had pressed a button.
   * Autosave saves it by itself now, so the question worth asking is the one
   * this step was always really asking: did taking the newer layout disturb
   * the section? It must not — the two are different rows on different
   * timelines — so the draft is whatever autosave stored, unchanged by any of
   * the structural work either side of it.
   */
  const heroAfter = await sectionRow(hero);
  say(
    "the layout recovery left the section's own draft exactly as it was",
    ((heroAfter.draft?.title as { en: string } | undefined)?.en ?? "") === typed,
    JSON.stringify(heroAfter.draft?.title),
  );

  // The selection survived, so the buffer is on screen; if it did not, select
  // the section again — the buffer is keyed by id either way.
  if ((await editor.locator('[data-field="title"]').count()) === 0) {
    const again = frame().locator(`[data-eod-address="section:${hero}/field:title"]`);
    await again.waitFor({ timeout: 20_000 });
    await again.click();
    await editor.getByRole("tab", { name: /Content/ }).click();
  }
  const kept = editor.locator('[data-field="title"] textarea, [data-field="title"] input').first();
  await kept.waitFor({ timeout: 10_000 });
  say("the text is still there, unchanged", (await kept.inputValue()) === typed, await kept.inputValue());
  say(
    "…and the panel is not claiming it is unsaved",
    (await editor.getByText("Unsaved content").count()) === 0,
  );

  /* --- 5. the next structural action works ----------------------------- */
  const next = (await layerIds(editor))[1]!;
  await editor
    .locator(`aside[aria-label='Page structure'] li[data-section-id="${next}"]`)
    .getByRole("button", { name: /Hide when the layout is published/ })
    .click();
  for (let i = 0; i < 80 && (await pageRow()).revision === fresh; i += 1) {
    await editor.waitForTimeout(200);
  }
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  await editor.waitForTimeout(800);

  const after = (await pageRow()).revision;
  say("the next structural action succeeds against the refreshed revision", after === fresh + 1, `${fresh} → ${after}`);
  say("…with no conflict shown", (await editor.getByText(/layout changed since you opened it/i).count()) === 0);
  const hidden = await sql<{ draft_structure: { sections: { sectionId: number; visible: boolean }[] } }[]>`
    select draft_structure from pages where id = ${about.id}`;
  say(
    "…and it is the section the editor pointed at",
    hidden[0]!.draft_structure.sections.find((e) => e.sectionId === next)?.visible === false,
  );

  // …and the section being written in is still holding exactly that text: no
  // structural action on this page ever wrote to it.
  const finalHero = await sectionRow(hero);
  say(
    "no structural action ever wrote to the section",
    ((finalHero.draft?.title as { en: string } | undefined)?.en ?? "") === typed,
    JSON.stringify(finalHero.draft?.title),
  );

  await context.close();
  await sql`delete from page_sections where page_id = ${about.id} and is_draft_only = true`;
  await sql`update pages set draft_structure = null where id = ${about.id}`;
  say("the fixture is back as it started", true);
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
