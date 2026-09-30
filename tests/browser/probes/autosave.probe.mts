/**
 * Batch 10 acceptance: the editor saves by itself, and only ever drafts.
 *
 * The promise: an editor stops typing, and a second later their work is on the
 * server — without a visitor seeing any of it, without three domains racing
 * each other over one row, and without a conflict turning into a retry loop.
 */

import { editorIdle, selectFromLayers } from "../canvas";
import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";
import { AUTOSAVE_QUIET_MS, quietFor, until } from "../wait";

const PORT = 3705;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

/** How long a save that has started may take to land — a bound, not a sleep (Batch 19A). */
const SAVED_WITHIN = 20_000;

const browser = await launchChromium();
const database = giveFresh("autosave_probe");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);

  type Row = {
    id: number;
    revision: number;
    draft: Record<string, unknown> | null;
    draft_styles: unknown;
    draft_animation: string | null;
  };
  const row = async (id: number): Promise<Row> =>
    (await sql<Row[]>`
       select id, revision, draft, draft_styles, draft_animation
         from page_sections where id = ${id}`)[0]!;
  const versions = async (pageId: number) =>
    (await sql<{ n: number }[]>`select count(*)::int as n from page_versions where page_id = ${pageId}`)[0]!.n;

  const [about] = await sql<{ id: number }[]>`select id from pages where slug = 'about'`;
  const rows = await sql<{ id: number }[]>`
    select id from page_sections where page_id = ${about!.id} order by position asc, id asc`;
  const hero = rows[0]!.id;
  const second = rows[1]!.id;

  const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);

  const openEditor = async (page: import("playwright").Page, slug = "about") => {
    await page.goto(`${server!.origin}/admin/visual-editor?page=${slug}&lang=en&device=desktop`, {
      waitUntil: "load",
    });
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  };

  const editor = await context.newPage();
  editor.on("pageerror", (error) => console.log("   [pageerror]", error.message.slice(0, 140)));
  editor.on("dialog", (dialog) => dialog.accept());
  await openEditor(editor);

  const selectSection = (page: import("playwright").Page, id: number) => selectFromLayers(page, `section:${id}`);
  const titleBox = () =>
    editor.locator('[data-field="title"] textarea, [data-field="title"] input').first();

  const publicHtml = async (slug = "about") => {
    const visitor = await browser.newContext();
    const page = await visitor.newPage();
    await page.goto(`${server!.origin}/${slug}`, { waitUntil: "load" });
    const html = await page.content();
    await visitor.close();
    return html;
  };

  const before = await publicHtml();
  const versionsBefore = await versions(about!.id);

  /* --- 1. content ------------------------------------------------------ */
  await selectSection(editor, hero);
  await editor.getByRole("tab", { name: /Content/ }).click();
  await titleBox().waitFor({ timeout: 15_000 });
  const typed = "Autosaved without pressing anything";
  await titleBox().fill(typed);
  await editor.getByText("Unsaved content").waitFor({ timeout: 5_000 });
  say("typing marks the panel unsaved", true);
  say("…and nothing is written yet", (await row(hero)).draft === null);

  await editor.getByText("Draft saved", { exact: true }).waitFor({ timeout: 20_000 });
  const savedContent = await row(hero);
  say(
    "the content draft is on the server a moment later",
    ((savedContent.draft?.title as { en: string } | undefined)?.en ?? "") === typed,
    JSON.stringify(savedContent.draft?.title),
  );
  say("…and the panel says Draft saved", true);

  /* --- 2. style -------------------------------------------------------- */
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  await selectSection(editor, second);
  await editor.getByRole("tab", { name: /Style/ }).click();
  const setToken = async (token: string, value: string) => {
    const control = editor.locator(`[data-style-token="${token}"] select`);
    await control.waitFor({ timeout: 15_000 });
    await control.selectOption(value);
  };
  await setToken("background", "ink-700");
  await editor.getByText("Unsaved styles").waitFor({ timeout: 5_000 });
  await editor.getByText("Styles saved", { exact: true }).waitFor({ timeout: 20_000 });
  say("a style change autosaves too", (await row(second)).draft_styles !== null);

  /* --- 3. motion ------------------------------------------------------- */
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  await selectSection(editor, second);
  await editor.getByRole("tab", { name: /Motion/ }).click();
  // Batch 15a: the section's entrance is a select in the document panel.
  await editor.locator('[data-motion-field="entrance"] select').selectOption({ label: "Scale in" });
  await editor.getByText("Unsaved motion").waitFor({ timeout: 5_000 });
  await editor.getByText("Motion saved", { exact: true }).waitFor({ timeout: 20_000 });
  say("an entrance autosaves too", (await row(second)).draft_animation === "scale-in");

  /* --- 4. three domains at once, serialised ---------------------------- */
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  await selectSection(editor, hero);
  const startRevision = (await row(hero)).revision;

  await editor.getByRole("tab", { name: /Content/ }).click();
  await titleBox().waitFor({ timeout: 15_000 });
  await titleBox().fill("All three at once");
  await editor.getByRole("tab", { name: /Motion/ }).click();
  await editor.locator('[data-motion-field="entrance"] select').selectOption({ label: "Fade only" });
  await editor.getByRole("tab", { name: /Style/ }).click();
  await setToken("radius", "lg");

  // All three are dirty locally and none has been written yet; the queue then
  // has to empty them one at a time against its own advancing revision.
  say(
    "three domains are dirty at once",
    (await editor.locator("[role='tablist'] [aria-label='unsaved']").count()) === 3,
  );
  await until(async () => {
    const current = await row(hero);
    return (
      ((current.draft?.title as { en: string } | undefined)?.en ?? "") === "All three at once" &&
      current.draft_styles !== null &&
      current.draft_animation === "fade" &&
      current.revision >= startRevision + 3
    );
  }, SAVED_WITHIN);
  const all = await row(hero);
  say(
    "all three domains reach the server",
    ((all.draft?.title as { en: string } | undefined)?.en ?? "") === "All three at once" &&
      all.draft_styles !== null &&
      all.draft_animation === "fade",
    JSON.stringify({ styles: all.draft_styles !== null, motion: all.draft_animation }),
  );
  say(
    "…one save at a time, so the row advanced once per domain and no more",
    all.revision === startRevision + 3,
    `${startRevision} → ${all.revision}`,
  );
  say("…and no conflict was manufactured", (await editor.getByText("Somebody else saved first").count()) === 0);

  /* --- 5. an edit during a save is not lost ---------------------------- */
  // Past the last save's answer and the redraw it brings (Batch 19A): the rows
  // above were read at the commit, and section 4's requests must all be over
  // before the one below is told apart from them.
  await editorIdle(editor);
  await selectSection(editor, hero);
  await editor.getByRole("tab", { name: /Content/ }).click();
  await titleBox().waitFor({ timeout: 15_000 });
  // Let the debounce fire, then type again immediately: the second value has
  // to survive the first save's answer and be saved after it. "Fired" is the
  // save request itself leaving — the one carrying the first value, not any
  // server action that happens to be sent — rather than a guess at the
  // debounce (Batch 19A).
  const saving = editor.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      request.headers()["next-action"] !== undefined &&
      (request.postData() ?? "").includes("First value"),
    { timeout: SAVED_WITHIN },
  );
  await titleBox().fill("First value");
  await saving;
  await titleBox().fill("Final keystroke wins");
  await until(
    async () => (((await row(hero)).draft?.title as { en: string } | undefined)?.en ?? "") === "Final keystroke wins",
    SAVED_WITHIN,
  );
  const moved = await row(hero);
  say(
    "an edit made during a save is kept and saved after it",
    ((moved.draft?.title as { en: string } | undefined)?.en ?? "") === "Final keystroke wins",
    JSON.stringify(moved.draft?.title),
  );

  /* --- 6. public isolation --------------------------------------------- */
  const after = await publicHtml();
  const sections = (html: string) => [...html.matchAll(/data-section="([^"]+)"/g)].map((m) => m[1]);
  say("a visitor's page is unchanged by any of it", JSON.stringify(sections(after)) === JSON.stringify(sections(before)));
  say("…and none of the typed text is on it", !after.includes("Final keystroke wins"));
  say("no restore point was written by autosave", (await versions(about!.id)) === versionsBefore);

  /* --- 7. a conflict stops autosave rather than retrying ---------------- */
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  await selectSection(editor, second);
  await editor.getByRole("tab", { name: /Content/ }).click();
  const box = editor.locator('[data-field="title"] textarea, [data-field="title"] input').first();
  await box.waitFor({ timeout: 15_000 });
  // A colleague gets there first.
  await sql`update page_sections set revision = revision + 1 where id = ${second}`;
  const stale = (await row(second)).revision;
  await box.fill("Written against an old revision");
  await editor.getByText("Somebody else saved first").waitFor({ timeout: 20_000 });
  say("a stale autosave is reported as a conflict", true);

  const settled = (await row(second)).revision;
  await quietFor(editor, AUTOSAVE_QUIET_MS * 2, "a retry loop would have written again inside two autosave cycles");
  say(
    "…and it does not retry in a loop",
    (await row(second)).revision === settled && settled === stale,
    `${stale} → ${(await row(second)).revision}`,
  );
  say("…the local text is still on screen", (await box.inputValue()) === "Written against an old revision");

  await editor.getByRole("button", { name: "Reload latest" }).click();
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  await until(async () => (await editor.getByText("Somebody else saved first").count()) === 0);
  say(
    "…and Reload latest clears it",
    (await editor.getByText("Somebody else saved first").count()) === 0,
  );

  /* --- 8. a buffer on a page nobody is looking at still saves ----------- */
  await openEditor(editor, "terms");
  const [terms] = await sql<{ id: number }[]>`select id from pages where slug = 'terms'`;
  const termsRows = await sql<{ id: number }[]>`
    select id from page_sections where page_id = ${terms!.id} order by position asc, id asc`;
  const termsHero = termsRows[0]!.id;

  await selectSection(editor, termsHero);
  await editor.getByRole("tab", { name: /Content/ }).click();
  const termsBox = editor.locator('[data-field="title"] textarea, [data-field="title"] input').first();
  await termsBox.waitFor({ timeout: 15_000 });
  await termsBox.fill("Typed then navigated away");
  // Switch pages before the debounce fires.
  await editor.selectOption("#ve-page", "about");
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  await until(
    async () => (((await row(termsHero)).draft?.title as { en: string } | undefined)?.en ?? "") === "Typed then navigated away",
    SAVED_WITHIN,
  );

  const orphan = await row(termsHero);
  say(
    "an edit on the page just left is still saved",
    ((orphan.draft?.title as { en: string } | undefined)?.en ?? "") === "Typed then navigated away",
    JSON.stringify(orphan.draft?.title),
  );
  say("…and it went to its own page's section", orphan.id === termsHero);

  await context.close();
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
