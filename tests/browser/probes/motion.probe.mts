/**
 * Batch 9 acceptance: motion is a draft domain, in a real browser.
 *
 * The promise being tested is one sentence — choosing a section's entrance
 * must not change what a visitor sees move until the motion draft is published
 * — and the interesting failures are all about the other two domains: a motion
 * save that quietly takes somebody's unsaved paragraph with it, a conflict
 * that leaves one domain addressed to a revision that no longer exists, or a
 * layout recovery that throws away an entrance nobody had saved.
 */

import { editorSettled, selectFromLayers } from "../canvas";
import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";
import { until } from "../wait";

const PORT = 3716;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("motion_probe");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    select 'viewer@test.invalid', 'Read Only', 'unused', id, true from roles where key = 'viewer'
  `;
  const viewer = await signIn(sql, "viewer");
  server = await startServer(database, PORT);

  type Row = {
    id: number;
    revision: number;
    animation: string;
    draft_animation: string | null;
    draft_motion_config: unknown;
    draft: Record<string, unknown> | null;
    draft_styles: unknown;
  };
  const sectionRow = async (id: number): Promise<Row> =>
    (await sql<Row[]>`
       select id, revision, animation, draft_animation, draft_motion_config, draft, draft_styles
         from page_sections where id = ${id}`)[0]!;
  const pageRevision = async (id: number) =>
    (await sql<{ revision: number }[]>`select revision from pages where id = ${id}`)[0]!.revision;

  const [about] = await sql<{ id: number }[]>`select id from pages where slug = 'about'`;
  const rows = await sql<{ id: number; block_type: string }[]>`
    select id, block_type from page_sections where page_id = ${about!.id}
     order by position asc, id asc`;
  const hero = rows[0]!.id;
  await sql`update page_sections set animation = 'fade-up', draft_animation = null,
                                     draft = null, draft_styles = null,
                                     motion_config = null, draft_motion_config = null
             where page_id = ${about!.id}`;

  const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);

  const openEditor = async (page: import("playwright").Page) => {
    await page.goto(`${server!.origin}/admin/visual-editor?page=about&lang=en&device=desktop`, {
      waitUntil: "load",
    });
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  };

  const editor = await context.newPage();
  editor.on("pageerror", (error) => console.log("   [pageerror]", error.message.slice(0, 140)));
  editor.on("dialog", (dialog) => dialog.accept());
  await openEditor(editor);

  const frame = () => editor.frames().find((f) => f.url().includes("editor=1"))!;
  /**
   * Select the section through the Layers row, which is how an editor selects
   * a *section* rather than something inside one — clicking the canvas lands
   * on whatever node is under the pointer.
   */
  // The Inspector showing the section, then the tabs its buffer brings —
  // `selectFromLayers` (Batch 19A: the tabs alone are already there when
  // something else was selected).
  const selectSection = (page: import("playwright").Page, id: number) => selectFromLayers(page, `section:${id}`);
  const selectHero = () => selectSection(editor, hero);
  /**
   * Press "Save now", unless autosave has already saved it.
   *
   * Batch 10 made saving automatic, so by the time a probe reaches the button
   * the work it was going to send may already be on the server and the button
   * disabled. Both outcomes are the same intention — do not wait for the
   * debounce — and the assertions after it are about the row either way.
   */
  const saveNow = async () => {
    const button = editor.getByRole("button", { name: "Save now" });
    if (await button.isEnabled().catch(() => false)) await button.click();
  };
  /**
   * The section's entrance, in the Batch 15 panel: one select, its first
   * option the legacy default the section falls back to.
   */
  const entranceSelect = (page: import("playwright").Page = editor) =>
    page.locator('[data-motion-field="entrance"] select');
  const chooseEntrance = async (label: string) => {
    await entranceSelect().waitFor({ timeout: 15_000 });
    await entranceSelect().selectOption({ label });
  };
  const shownEntrance = async (page: import("playwright").Page = editor) =>
    (await entranceSelect(page).evaluate((node) => {
      const select = node as HTMLSelectElement;
      return select.options[select.selectedIndex]?.textContent ?? "";
    })).trim();
  const heroClass = () =>
    frame()
      .locator(`[data-eod-address="section:${hero}"]`)
      .evaluate((node) => (node as HTMLElement).className);

  /* --- 1. the tab exists, and says what it acts on ---------------------- */
  await selectHero();
  const motionTab = editor.getByRole("tab", { name: /Motion/ });
  say("the inspector has a Motion tab", (await motionTab.count()) === 1);
  await motionTab.click();

  // Batch 15a: the five presets are still offered by name, beside Blur and
  // Mask, after the one option that deletes the key — the legacy default.
  const presets = [
    "Legacy default — Fade up",
    "Fade up",
    "Fade only",
    "Slide in",
    "Scale in",
    "Blur reveal",
    "Mask reveal",
    "No entrance",
  ];
  await entranceSelect().waitFor({ timeout: 15_000 });
  const found = await entranceSelect().locator("option").allTextContents();
  say(
    "…offering the legacy default, the five presets and the two new entrances, in order",
    JSON.stringify(found.map((t) => t.trim())) === JSON.stringify(presets),
    JSON.stringify(found),
  );
  say(
    "…and saying it is the section's",
    (await editor.locator('[data-motion-target="section"]').count()) === 1 &&
      (await editor.getByText(/How this whole section arrives/).count()) > 0,
  );
  say(
    "…with the published preset already showing, as the default it falls back to",
    (await shownEntrance()) === "Legacy default — Fade up",
    await shownEntrance(),
  );

  /* --- 2. choosing is local until it is saved --------------------------- */
  const before = await sectionRow(hero);
  await chooseEntrance("Scale in");
  await editor.getByText("Unsaved motion").waitFor({ timeout: 10_000 });
  say("choosing a preset marks the panel unsaved", true);
  say("…and writes nothing", JSON.stringify(await sectionRow(hero)) === JSON.stringify(before));
  say("…and the toolbar counts it", (await editor.getByText(/^1 unsaved$/).count()) > 0);
  say(
    "…and the canvas has not moved",
    (await heroClass()) === "reveal",
    await heroClass(),
  );

  /* --- 3. Discard changes puts it back --------------------------------- */
  await editor.getByRole("button", { name: "Discard changes" }).click();
  await editor.waitForTimeout(400);
  say(
    "Discard changes returns the chosen preset to the stored one",
    (await shownEntrance()) === "Legacy default — Fade up",
    await shownEntrance(),
  );
  say("…and still nothing is written", (await sectionRow(hero)).draft_animation === null);

  /* --- 4. saving writes the draft column and only that ------------------ */
  const pageBefore = await pageRevision(about!.id);
  await chooseEntrance("Slide in");
  await saveNow();
  for (let i = 0; i < 100 && (await sectionRow(hero)).draft_animation === null; i += 1) {
    await editor.waitForTimeout(200);
  }
  const saved = await sectionRow(hero);
  say("Save motion stores the preset as a draft", saved.draft_animation === "slide-in");
  // jsonb comes back in its own key order, so compare by shape.
  const shape = (value: unknown): unknown =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, shape(v)]),
        )
      : value;
  say(
    "…beside the document it is the projection of",
    JSON.stringify(shape(saved.draft_motion_config)) ===
      JSON.stringify(shape({ v: 1, section: { base: { entrance: "slide-in" } }, nodes: {} })),
    JSON.stringify(saved.draft_motion_config),
  );
  say("…and leaves the published entrance alone", saved.animation === "fade-up");
  say("…and the page's own revision alone", (await pageRevision(about!.id)) === pageBefore);
  say("…and the section's revision moved once", saved.revision === before.revision + 1);

  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  await editor.waitForTimeout(900);
  say(
    "the canvas shows the draft entrance",
    (await heroClass()).includes("reveal-left"),
    await heroClass(),
  );

  const visitor = await browser.newContext();
  const publicPage = await visitor.newPage();
  await publicPage.goto(`${server.origin}/about`, { waitUntil: "load" });
  const liveClass = await publicPage
    .locator(`[data-section="${rows[0]!.block_type}"]`)
    .first()
    .evaluate((node) => (node as HTMLElement).className);
  say("…and a visitor does not", liveClass === "reveal", liveClass);
  await visitor.close();

  /* --- 5. the three domains are independent ----------------------------- */
  await selectHero();
  await editor.getByRole("tab", { name: /Content/ }).click();
  const box = editor.locator('[data-field="title"] textarea, [data-field="title"] input').first();
  await box.waitFor({ timeout: 15_000 });
  const typed = "Half a sentence nobody has saved";
  await box.fill(typed);
  await editor.getByText("Unsaved content").waitFor({ timeout: 10_000 });

  await editor.getByRole("tab", { name: /Motion/ }).click();
  await chooseEntrance("Fade only");
  await editor.getByText("Unsaved motion").waitFor({ timeout: 10_000 });
  await saveNow();
  for (let i = 0; i < 100 && (await sectionRow(hero)).draft_animation !== "fade"; i += 1) {
    await editor.waitForTimeout(200);
  }
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  await editor.waitForTimeout(900);

  /**
   * Both domains reach the server, each into its own column.
   *
   * Before Batch 10 this asserted that the content draft was still `null` —
   * that saving motion did not drag unsaved text along with it. Autosave
   * deliberately changes the first half of that: the text *is* saved, by its
   * own write, a second after it was typed. What has not changed, and is what
   * this was really about, is that each domain lands in its own column and
   * neither write carries the other's payload.
   */
  const afterMotion = await sectionRow(hero);
  say("the entrance reached its own column", afterMotion.draft_animation === "fade");
  say("…and the text reached its own, by its own save", 
    ((afterMotion.draft?.title as { en: string } | undefined)?.en ?? "") === typed,
    JSON.stringify(afterMotion.draft?.title));
  say("…and neither write touched the styles", afterMotion.draft_styles === null);

  if ((await editor.locator('[data-field="title"]').count()) === 0) {
    await selectHero();
    await editor.getByRole("tab", { name: /Content/ }).click();
  } else {
    await editor.getByRole("tab", { name: /Content/ }).click();
  }
  const kept = editor.locator('[data-field="title"] textarea, [data-field="title"] input').first();
  await kept.waitFor({ timeout: 15_000 });
  say("…and the paragraph is still on screen, unchanged", (await kept.inputValue()) === typed, await kept.inputValue());

  /* --- 6. a conflict replaces all three ---------------------------------- */
  // A colleague saves a style against the revision this panel is holding.
  const stale = (await sectionRow(hero)).revision;
  // Both motion columns, as a colleague on this release writes them.
  await sql`
    update page_sections
       set draft_styles = ${sql.json({ v: 1, nodes: { root: { base: { align: "center" } } } })},
           draft_animation = 'scale-in',
           draft_motion_config = ${sql.json({ v: 1, section: { base: { entrance: "scale-in" } }, nodes: {} })},
           revision = revision + 1
     where id = ${hero}
  `;
  say("a colleague saved first", (await sectionRow(hero)).revision === stale + 1);

  await editor.getByRole("tab", { name: /Motion/ }).click();
  await chooseEntrance("No entrance");
  await saveNow();
  await editor.getByText("Somebody else saved first").waitFor({ timeout: 20_000 });
  say("the stale motion save is refused", true);
  say("…and nothing was written", (await sectionRow(hero)).draft_animation === "scale-in");

  await editor.getByRole("button", { name: "Reload latest" }).click();
  // A whole new canvas: the same 60 s the load itself is allowed.
  await editorSettled(editor, 60_000);
  if ((await entranceSelect().count()) === 0) {
    await selectHero();
    await editor.getByRole("tab", { name: /Motion/ }).click();
  }
  say("Reload latest adopts the entrance that won", (await shownEntrance()) === "Scale in", await shownEntrance());
  say("…and clears every unsaved mark", (await editor.getByText(/^\d+ unsaved$/).count()) === 0);
  say(
    "…and the conflict notice is gone",
    (await editor.getByText("Somebody else saved first").count()) === 0,
  );

  /* --- 7. a layout conflict is recoverable, and costs no saved work ------- */
  /**
   * The conflict is created directly rather than by driving a second tab.
   *
   * Batch 10 made saving automatic, so the older version of this step — type,
   * race a colleague, keep the *unsaved* work — no longer describes anything
   * reachable: by the time a second tab has opened and reordered the page, the
   * entrance is already on the server. What still matters is what happens to a
   * section's saved drafts when the layout underneath it moves, and bumping the
   * page's own revision is the same staleness a colleague would cause, without
   * the timing.
   */
  await selectHero();
  await editor.getByRole("tab", { name: /Motion/ }).click();
  await chooseEntrance("Fade up");
  await editor.getByText("Motion saved", { exact: true }).waitFor({ timeout: 20_000 });
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  const savedEntrance = (await sectionRow(hero)).draft_animation;
  say("the entrance is saved before the layout moves", savedEntrance === "fade-up", String(savedEntrance));

  const layoutStale = await pageRevision(about!.id);
  await sql`update pages set revision = revision + 1 where id = ${about!.id}`;

  const target = (
    await editor
      .locator("aside[aria-label='Page structure'] ol > li[data-section-id]")
      .evaluateAll((list) => list.map((row) => Number((row as HTMLElement).dataset.sectionId)))
  )[1]!;
  await editor
    .locator(`aside[aria-label='Page structure'] li[data-section-id="${target}"]`)
    .getByRole("button", { name: /Hide when the layout is published/ })
    .click();
  await until(async () => (await editor.getByText(/layout changed since you opened it/i).count()) > 0, 15_000);

  say(
    "a structural write against a moved layout is refused",
    (await editor.getByText(/layout changed since you opened it/i).count()) > 0,
  );
  say("…and changed nothing", (await pageRevision(about!.id)) === layoutStale + 1);

  await editor.getByRole("button", { name: "Reload latest layout" }).click();
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  await until(async () => (await editor.getByText(/layout changed since you opened it/i).count()) === 0, 15_000);
  say(
    "…and the conflict notice is gone after taking the latest layout",
    (await editor.getByText(/layout changed since you opened it/i).count()) === 0,
  );

  if ((await entranceSelect().count()) === 0) {
    await selectHero();
    await editor.getByRole("tab", { name: /Motion/ }).click();
  }
  say(
    "the section's saved entrance is untouched by any of it",
    (await sectionRow(hero)).draft_animation === "fade-up",
  );
  say("…and the chooser still shows it", (await shownEntrance()) === "Fade up", await shownEntrance());

  await editor.close();

  /* --- 8. a reader may look, and not choose ------------------------------ */
  const readOnly = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [vn, vv] = viewer.cookie.split("=");
  await readOnly.addCookies([{ name: vn!, value: vv!, domain: "127.0.0.1", path: "/" }]);
  const reader = await readOnly.newPage();
  await openEditor(reader);
  await selectSection(reader, hero);
  await reader.getByRole("tab", { name: /Motion/ }).click();

  const chooser = entranceSelect(reader);
  await chooser.waitFor({ timeout: 15_000 });
  say("a reader can see the entrance", (await chooser.count()) === 1, await shownEntrance(reader));
  say("…and cannot choose one", (await chooser.isDisabled()) === true);
  say("…and is offered no Save", (await reader.getByRole("button", { name: "Save now" }).count()) === 0);
  // Batch 18: the reason is given per capability, in words — the Inspector's
  // "nothing here" note and the Motion tab's own sentence.
  say(
    "…and is told why",
    (await reader.getByText(/your role does not allow changing its content, styles or motion/i).count()) > 0 &&
      (await reader.getByText(/your role does not allow editing motion/i).count()) > 0,
  );
  await readOnly.close();

  await context.close();
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
