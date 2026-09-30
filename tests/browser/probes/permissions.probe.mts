/**
 * Batch 18 acceptance: granular permissions in a real browser (§20).
 *
 * Each scenario signs in as a user whose role holds exactly the keys the
 * scenario names — the Editor role re-granted by SQL, because grants are read
 * on every request — opens the real screens, and asserts two things together:
 * what the interface offers and says, and what the database did. A control
 * that is merely hidden proves nothing, so every scenario that hides one also
 * sends the request that control would have sent, crafted, with the same
 * cookie, and checks that the server refused it and that nothing moved.
 */
import type { Browser, BrowserContext, Page } from "playwright";

import { clickCanvasNode, selectFromLayers } from "../canvas";
import { callAction } from "../../helpers/action";
import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn, type TestSession } from "../../helpers/session";
import { launchChromium } from "../harness";
import { AUTOSAVE_QUIET_MS, quietFor } from "../wait";

const PORT = 3719;
const VE = { route: "/admin/visual-editor", file: "app/(backoffice)/admin/visual-editor/actions.ts" };
const RC = { route: "/admin/components", file: "app/(backoffice)/admin/(shell)/components/actions.ts" };
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

/** The refusals the probe expects, word for word (`lib/auth/authority.ts`). */
const DENIED = {
  editContent: "Your role does not allow editing page content. Nothing was saved.",
  editStyle: "Your role does not allow styling. Nothing was saved.",
  editAdvancedStyle:
    "Your role does not allow advanced styling — width, height, layout, direction, wrapping, " +
    "alignment, columns, overflow and glow. Nothing was saved.",
  editMotion: "Your role does not allow editing motion. Nothing was saved.",
  editStructure: "Your role does not allow changing the page layout. Nothing was changed.",
  publish: "Your role does not allow publishing, discarding or restoring pages. Nothing was changed.",
  publishComponents: "Your role does not allow publishing reusable components. Nothing was published.",
  reuseInstance:
    "Linking, detaching or overriding a reusable component needs permission to edit page content " +
    "and to view reusable components. Nothing was saved.",
};

const READ = ["dashboard.view", "content.view", "visual_editor.view", "components.view"];

const browser: Browser = await launchChromium();
const database = giveFresh("permissions_probe");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  const [editorRole] = await sql<{ id: number }[]>`select id from roles where key = 'editor'`;
  await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    select 'actor@probe.invalid', 'Probe Actor', 'unused', id, true from roles where key = 'editor'`;
  await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    select 'viewer@probe.invalid', 'Probe Viewer', 'unused', id, true from roles where key = 'viewer'`;
  const actor = await signIn(sql, "editor");
  const viewer = await signIn(sql, "viewer");
  server = await startServer(database, PORT);
  const origin = server.origin;

  /** The Editor role — and so `actor` — holds exactly these keys from now on. */
  const as = async (keys: string[]) => {
    await sql`delete from role_permissions where role_id = ${editorRole!.id}`;
    if (keys.length) {
      await sql`
        insert into role_permissions (role_id, permission_id)
        select ${editorRole!.id}, id from permissions where key = any(${keys})`;
    }
  };

  type Values = Record<string, unknown>;
  type Row = {
    id: number;
    page_id: number;
    revision: number;
    draft: Values | null;
    published: Values;
    draft_styles: Values | null;
    draft_animation: string | null;
  };
  const row = async (id: number) =>
    (await sql<Row[]>`
      select id, page_id, revision, draft, published, draft_styles, draft_animation from page_sections where id = ${id}`)[0]!;
  const pageRow = async (slug: string) =>
    (await sql<{ id: number; revision: number; draft_structure: unknown }[]>`
      select id, revision, draft_structure from pages where slug = ${slug}`)[0]!;
  /** Every page, section and component, and the version and activity counts — one string. */
  const stateOf = async () => {
    const pages = await sql`select id, revision, draft_structure, is_published, title_en, title_ar, updated_at from pages order by id`;
    const sections = await sql`
      select id, revision, position, published, draft, styles, draft_styles, animation, draft_animation,
             motion_config, draft_motion_config, updated_at
        from page_sections order by id`;
    const components = await sql`select id, revision, status, name, published_version, published, draft from reusable_components order by id`;
    const counts = await sql`
      select (select count(*) from page_versions)::int as versions,
             (select count(*) from reusable_component_versions)::int as component_versions,
             (select count(*) from activity_logs)::int as activity`;
    return JSON.stringify({ pages, sections, components, counts });
  };
  const until = async (what: () => Promise<boolean>, ms = 30_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await what()) return true;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };
  const sorted = (value: unknown): unknown =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Values).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)]))
      : value;
  const same = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
  const titleOf = (values: Values | null | undefined) => String(((values?.title as Values) ?? {}).en ?? "");
  const baseOf = (styles: Values | null) =>
    ((styles as { nodes?: Record<string, Record<string, Values>> } | null)?.nodes?.root?.base ?? null) as Values | null;

  /* Crafted requests: the same action ids the editor calls, with the same cookie. */
  const form = (fields: Record<string, string | number>, session: TestSession) => {
    const data = new FormData();
    data.set("_csrf", session.csrfToken);
    for (const [key, value] of Object.entries(fields)) data.set(key, String(value));
    return data;
  };
  type Answer = { ok: boolean; message?: string; reason?: string } & Values;
  const ve = async (action: string, fields: Record<string, string | number>, session: TestSession) =>
    (await callAction<Answer>({ ...VE, origin, action, args: [form(fields, session)], cookie: session.cookie })).value;
  const rc = async (action: string, fields: Record<string, string | number>, session: TestSession) =>
    (await callAction<Answer>({ ...RC, origin, action, args: [form(fields, session)], cookie: session.cookie })).value;
  const sectionFields = (section: Row) => ({ sectionId: section.id, pageId: section.page_id, expectedRevision: section.revision });

  const [about] = await sql<{ id: number }[]>`select id from pages where slug = 'about'`;
  const aboutRows = await sql<{ id: number }[]>`
    select id from page_sections where page_id = ${about!.id} and not is_draft_only order by position asc, id asc`;
  const HERO = aboutRows[0]!.id;
  const SECOND = aboutRows[1]!.id;
  const TITLE = `section:${HERO}/field:title`;

  /* ---------------------------------------------------------------------- */
  /* Browser helpers                                                         */
  /* ---------------------------------------------------------------------- */

  const errors: string[] = [];
  const contextFor = async (session: TestSession): Promise<BrowserContext> => {
    const context = await browser.newContext({ viewport: { width: 1720, height: 1020 }, reducedMotion: "reduce" });
    const [name, value] = session.cookie.split("=");
    await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
    await context.addInitScript({ content: "window.__name = window.__name || ((fn) => fn);" });
    return context;
  };
  const newPage = async (context: BrowserContext) => {
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message.slice(0, 160)));
    page.on("dialog", (dialog) => void dialog.accept());
    return page;
  };
  const open = async (page: Page, slug = "about") => {
    await page.goto(`${origin}/admin/visual-editor?page=${slug}&lang=en&device=desktop`, { waitUntil: "load" });
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
    await page.waitForTimeout(400);
  };
  const frameNow = async (page: Page) => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const found = page.frames().find((f) => f.url().includes("editor=1"));
      if (found) return found;
      if (Date.now() > deadline) throw new Error("the canvas frame never arrived");
      await page.waitForTimeout(150);
    }
  };
  /** Select a section by its Layers row — the path with no canvas-hit intermittency. */
  const selectRow = (page: Page, id: number) => selectFromLayers(page, `section:${id}`);
  const tab = async (page: Page, name: "Content" | "Style" | "Motion") => {
    await page.getByRole("tab", { name: new RegExp(name) }).click();
    await page.waitForTimeout(250);
  };
  const inspector = (page: Page) => page.locator("aside[aria-label='Inspector']");
  const titleBox = (page: Page) =>
    inspector(page).locator('[data-field="title"] textarea, [data-field="title"] input').first();
  const note = (page: Page, key: string) => page.locator(`[data-permission-note="${key}"]`);
  const disabled = (page: Page, selector: string) =>
    page.locator(selector).first().evaluate((node) => (node as HTMLInputElement).matches(":disabled"));
  const setToken = async (page: Page, token: string, option: string) => {
    const control = page.locator(`[data-style-token="${token}"] select`).first();
    await control.waitFor({ timeout: 10_000 });
    await control.selectOption(option);
  };
  /**
   * Double-click the headline on the canvas, then report whether it became
   * writable: one double-click where the canvas is still, in page pixels, and
   * a bounded look — up to two seconds — for the headline to open for typing.
   * For a role that may not type, those two seconds are the window in which
   * it must not (Batch 19A: previously a forced double-click and a fixed
   * 900 ms — see `tests/browser/canvas.ts`).
   */
  const dblTitle = async (page: Page) => {
    const element = (await frameNow(page)).locator(`[data-eod-address="${TITLE}"]`).first();
    await element.waitFor({ state: "attached", timeout: 20_000 });
    await clickCanvasNode(page, element, "own", { double: true });
    const deadline = Date.now() + 2_000;
    let editable = await element.getAttribute("contenteditable");
    while (editable !== "plaintext-only" && Date.now() < deadline) {
      await page.waitForTimeout(50);
      editable = await element.getAttribute("contenteditable");
    }
    return editable;
  };
  const expandHero = async (page: Page) => {
    const toggle = page.locator(`[data-layer-toggle="section:${HERO}"]`).first();
    await toggle.waitFor({ timeout: 15_000 });
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await page.waitForTimeout(300);
  };
  const openPagePanel = async (page: Page) => {
    if ((await page.locator("aside[aria-label='Page changes and history']").count()) === 0) {
      await page.getByRole("button", { name: /^Publish$/ }).click();
    }
    await page.locator("aside[aria-label='Page changes and history']").waitFor({ timeout: 10_000 });
    await page.waitForTimeout(600);
  };

  const ownerStyles = async (id: number, styles: Values) => {
    const answer = await ve("saveVisualSectionStyles", { ...sectionFields(await row(id)), styles: JSON.stringify(styles) }, owner);
    if (!answer?.ok) throw new Error(`owner could not save styles: ${answer?.message}`);
  };
  const ownerContent = async (id: number, title: string) => {
    const current = await row(id);
    const values = { ...(current.draft ?? current.published) };
    values.title = { ...((values.title as Values) ?? {}), en: title };
    const answer = await ve("saveVisualSectionDraft", { ...sectionFields(current), values: JSON.stringify(values) }, owner);
    if (!answer?.ok) throw new Error(`owner could not save content: ${answer?.message}`);
  };

  const actorContext = await contextFor(actor);
  const page = await newPage(actorContext);

  /* ====================================================================== */
  /* P1 · the Viewer role, as seeded                                         */
  /* ====================================================================== */
  {
    const viewerContext = await contextFor(viewer);
    const vpage = await newPage(viewerContext);
    const before = await stateOf();
    await open(vpage);
    say("P1.1 the Viewer role opens the Visual Editor and is told it is read only",
      (await vpage.locator('[data-permission-badge="read-only"]').count()) === 1);
    await selectRow(vpage, HERO);
    await tab(vpage, "Content");
    say("P1.2 the Inspector says, in words, that nothing here can be changed",
      (await note(vpage, "read-only").count()) === 1 && (await note(vpage, "content.edit").count()) === 1);
    say("P1.3 the real content is shown in switched-off fields",
      (await titleBox(vpage).inputValue()).length > 0 && (await titleBox(vpage).isDisabled()), await titleBox(vpage).inputValue());
    await tab(vpage, "Style");
    const styleSelects = inspector(vpage).locator("[data-style-token] select");
    const styleStates = await styleSelects.evaluateAll((nodes) => nodes.map((node) => (node as HTMLSelectElement).matches(":disabled")));
    say("P1.4 every style control is switched off, with the reason, and no Reset",
      styleStates.length > 0 && styleStates.every(Boolean) && (await note(vpage, "content.style").count()) === 1 &&
        (await vpage.locator("[data-style-reset]").count()) === 0,
      `${styleStates.length} controls`);
    await tab(vpage, "Motion");
    const replay = vpage.locator('[data-replay-mode="all"]').first();
    const replayFree = await replay.evaluate((node) => !node.closest("fieldset[disabled]"));
    say("P1.5 motion is switched off with the reason — and Replay, which saves nothing, stays usable",
      (await note(vpage, "content.motion").count()) === 1 && (await disabled(vpage, '[data-motion-field="entrance"] select')) && replayFree);
    const layers = vpage.locator("aside[aria-label='Page structure']");
    await expandHero(vpage);
    say("P1.6 Layers offers no Add, Move, Hide, Remove or Edit-text, and says why",
      (await layers.getByRole("button", { name: "Add section" }).count()) === 0 &&
        (await layers.getByRole("button", { name: /Move down|Move up|Remove from the layout|Duplicate/ }).count()) === 0 &&
        (await vpage.locator("[data-layer-edit]").count()) === 0 &&
        (await note(vpage, "content.structure").count()) === 1);
    await openPagePanel(vpage);
    say("P1.7 the page panel shows what is waiting but offers no Publish or Discard, and says why",
      (await note(vpage, "content.publish").count()) === 1 &&
        (await vpage.getByRole("button", { name: "Publish saved changes" }).count()) === 0 &&
        (await vpage.getByRole("button", { name: "Discard all saved changes" }).count()) === 0);
    say("P1.8 no Globals drawer for a role that manages neither navigation nor settings",
      (await vpage.getByRole("button", { name: /Globals/ }).count()) === 0);
    const editable = await dblTitle(vpage);
    await vpage.keyboard.type("viewer typing");
    await quietFor(vpage, AUTOSAVE_QUIET_MS, "typing that had reached a buffer would have been autosaved by now");
    say("P1.9 double-clicking canvas text never makes it writable", editable === null, String(editable));
    say("P1.10 …and after all of it the database is exactly as it was", (await stateOf()) === before);
    await viewerContext.close();
  }

  /* ====================================================================== */
  /* P2 · content only                                                       */
  /* ====================================================================== */
  await as([...READ, "content.edit"]);
  {
    await open(page);
    say("P2.1 a content editor is not called read only", (await page.locator('[data-permission-badge="read-only"]').count()) === 0);
    await expandHero(page);
    const edit = page.locator(`[data-layer-edit="${TITLE}"]`);
    await edit.waitFor({ timeout: 15_000 });
    const node = (await frameNow(page)).locator(`[data-eod-address="${TITLE}"]`).first();
    await edit.click();
    const began = await until(async () => (await node.getAttribute("contenteditable")) === "plaintext-only", 15_000);
    await node.selectText();
    await page.keyboard.type("Edited directly by a content editor");
    await page.keyboard.press("Enter");
    const landed = await until(async () => titleOf((await row(HERO)).draft) === "Edited directly by a content editor");
    say("P2.2 direct editing on the canvas works and autosaves", began && landed, titleOf((await row(HERO)).draft));

    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
    await selectRow(page, HERO);
    await tab(page, "Content");
    await titleBox(page).fill("Typed by a content editor");
    const typed = await until(async () => titleOf((await row(HERO)).draft) === "Typed by a content editor");
    say("P2.3 typing in the Inspector autosaves", typed);
    await tab(page, "Style");
    const styleStates = await inspector(page).locator("[data-style-token] select")
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLSelectElement).matches(":disabled")));
    say("P2.4 styles are locked, with the reason", styleStates.length > 0 && styleStates.every(Boolean) && (await note(page, "content.style").count()) === 1);
    await tab(page, "Motion");
    say("P2.5 motion is locked, with the reason",
      (await disabled(page, '[data-motion-field="entrance"] select')) && (await note(page, "content.motion").count()) === 1);
    const before = await stateOf();
    const crafted = await ve("saveVisualSectionStyles", { ...sectionFields(await row(HERO)), styles: JSON.stringify({ v: 1, nodes: { root: { base: { radius: "lg" } } } }) }, actor);
    const craftedPublish = await ve("publishPageFromEditor", { pageId: about!.id, expectedRevision: (await pageRow("about")).revision }, actor);
    say("P2.6 crafted: a style save and a page publish from the same cookie are refused, in words",
      crafted?.ok === false && crafted.message === DENIED.editStyle && craftedPublish?.ok === false && craftedPublish.message === DENIED.publish,
      `${crafted?.message} | ${craftedPublish?.message}`);
    say("P2.7 …and moved nothing", (await stateOf()) === before);
  }

  /* ====================================================================== */
  /* P3 · standard styling only, over a node that already has advanced ones  */
  /* ====================================================================== */
  await ownerStyles(HERO, { v: 1, nodes: { root: { base: { minHeight: "half-screen" } } } });
  await as([...READ, "content.style"]);
  {
    await open(page);
    await selectRow(page, HERO);
    await tab(page, "Style");
    await page.locator('[data-style-token="radius"]').first().waitFor({ timeout: 15_000 });
    const locked = await page.locator("[data-style-locked]").evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.styleLocked));
    say("P3.1 the advanced tokens are shown but locked, and the panel says why",
      locked.includes("minHeight") && (await note(page, "content.advanced_style").count()) === 1 &&
        (await disabled(page, '[data-style-locked="minHeight"] select')),
      locked.join(","));
    await setToken(page, "radius", "lg");
    const styled = await until(async () => same(baseOf((await row(HERO)).draft_styles), { minHeight: "half-screen", radius: "lg" }));
    say("P3.2 a standard control saves — and the advanced token already there is kept exactly", styled,
      JSON.stringify(baseOf((await row(HERO)).draft_styles)));
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
    await selectRow(page, HERO);
    await tab(page, "Style");
    const reset = page.locator('[data-style-reset="standard"]');
    await reset.waitFor({ timeout: 10_000 });
    const resetLabel = (await reset.textContent())?.trim() ?? "";
    await reset.click();
    const afterReset = await until(async () => same(baseOf((await row(HERO)).draft_styles), { minHeight: "half-screen" }));
    say("P3.3 Reset takes away only the standard styles and says so", afterReset && /standard/.test(resetLabel),
      `${resetLabel} → ${JSON.stringify(baseOf((await row(HERO)).draft_styles))}`);
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
    await expandHero(page);
    say("P3.4 no direct editing is offered, and a double-click does not start one",
      (await page.locator("[data-layer-edit]").count()) === 0 && (await dblTitle(page)) === null);
    const before = await stateOf();
    const current = await row(HERO);
    const crafted = await ve("saveVisualSectionStyles", { ...sectionFields(current), styles: JSON.stringify({ v: 1, nodes: { root: { base: { minHeight: "screen" } } } }) }, actor);
    const craftedRemove = await ve("saveVisualSectionStyles", { ...sectionFields(current), styles: JSON.stringify({ v: 1, nodes: {} }) }, actor);
    say("P3.5 crafted: altering or removing the advanced token is refused, in words",
      crafted?.message === DENIED.editAdvancedStyle && craftedRemove?.message === DENIED.editAdvancedStyle,
      `${crafted?.message} | ${craftedRemove?.message}`);
    say("P3.6 …and moved nothing", (await stateOf()) === before);
  }

  /* ====================================================================== */
  /* P4 · advanced styling                                                   */
  /* ====================================================================== */
  await as([...READ, "content.style", "content.advanced_style"]);
  {
    await open(page);
    await selectRow(page, HERO);
    await tab(page, "Style");
    await page.locator('[data-style-token="minHeight"]').first().waitFor({ timeout: 15_000 });
    say("P4.1 an advanced stylist sees nothing locked", (await page.locator("[data-style-locked]").count()) === 0 &&
      (await note(page, "content.advanced_style").count()) === 0 && (await page.locator('[data-style-reset="all"]').count()) === 1);
    await setToken(page, "minHeight", "screen");
    const moved = await until(async () => baseOf((await row(HERO)).draft_styles)?.minHeight === "screen");
    say("P4.2 …and changes an advanced token", moved, JSON.stringify(baseOf((await row(HERO)).draft_styles)));
  }

  /* ====================================================================== */
  /* P5 · motion only                                                        */
  /* ====================================================================== */
  await as([...READ, "content.motion"]);
  {
    await open(page);
    await selectRow(page, SECOND);
    await tab(page, "Motion");
    say("P5.1 a motion editor gets live motion controls", !(await disabled(page, '[data-motion-field="entrance"] select')) &&
      (await note(page, "content.motion").count()) === 0);
    await page.locator('[data-motion-field="entrance"] select').first().selectOption({ label: "Scale in" });
    const saved = await until(async () => (await row(SECOND)).draft_animation === "scale-in");
    say("P5.2 …and an entrance change saves", saved, String((await row(SECOND)).draft_animation));
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
    await selectRow(page, SECOND);
    await tab(page, "Content");
    say("P5.3 content stays locked for them", (await note(page, "content.edit").count()) === 1);
  }

  /* ====================================================================== */
  /* P6 · layout only                                                        */
  /* ====================================================================== */
  await as([...READ, "content.structure"]);
  {
    await open(page);
    const layers = page.locator("aside[aria-label='Page structure']");
    const start = await pageRow("about");
    say("P6.1 a layout editor gets Add section and the row controls",
      (await layers.getByRole("button", { name: "Add section" }).count()) === 1 &&
        (await layers.locator(`li[data-section-id="${HERO}"]`).getByRole("button", { name: /Move down/ }).count()) === 1);
    await layers.locator(`li[data-section-id="${HERO}"]`).getByRole("button", { name: /Move down/ }).click();
    const moved = await until(async () => (await pageRow("about")).draft_structure !== null);
    say("P6.2 Move down writes the layout draft", moved && (await pageRow("about")).revision > start.revision);
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
    await openPagePanel(page);
    say("P6.3 …but the page panel does not offer to publish it, and says why",
      (await page.getByRole("button", { name: "Publish saved changes" }).count()) === 0 && (await note(page, "content.publish").count()) === 1);
    await page.getByRole("button", { name: /^Publish$/ }).click();
    await page.getByRole("button", { name: "Discard layout changes" }).click();
    const discarded = await until(async () => (await pageRow("about")).draft_structure === null);
    say("P6.4 discarding the layout draft is a layout act, and it is theirs", discarded);
  }

  /* ====================================================================== */
  /* P7 · publish only                                                       */
  /* ====================================================================== */
  await ownerContent(HERO, "Prepared by the owner for publication");
  await as([...READ, "content.publish"]);
  {
    const versionsBefore = (await sql<{ n: number }[]>`select count(*)::int as n from page_versions where page_id = ${about!.id}`)[0]!.n;
    await open(page);
    await selectRow(page, HERO);
    await tab(page, "Content");
    say("P7.1 a publisher cannot type", await titleBox(page).isDisabled());
    await openPagePanel(page);
    const publish = page.getByRole("button", { name: "Publish saved changes" });
    await until(async () => (await publish.count()) === 1 && (await publish.isEnabled()), 20_000);
    await publish.click();
    const live = await until(async () => {
      const current = await row(HERO);
      return current.draft === null && titleOf(current.published) === "Prepared by the owner for publication";
    });
    const versionsAfter = (await sql<{ n: number }[]>`select count(*)::int as n from page_versions where page_id = ${about!.id}`)[0]!.n;
    say("P7.2 …but publishes what was prepared, with a version written", live && versionsAfter === versionsBefore + 1,
      `${versionsBefore} → ${versionsAfter}`);
    const before = await stateOf();
    const crafted = await ve("saveVisualSectionDraft", { ...sectionFields(await row(HERO)), values: JSON.stringify({ ...(await row(HERO)).published, title: { en: "publisher typed", ar: "" } }) }, actor);
    say("P7.3 crafted: a publisher's content save is refused and moves nothing",
      crafted?.message === DENIED.editContent && (await stateOf()) === before, crafted?.message);
  }

  /* ====================================================================== */
  /* P8–P10 · reusable components, one capability at a time                  */
  /* ====================================================================== */
  await as([...READ, "components.edit"]);
  let CID = 0;
  {
    await page.goto(`${origin}/admin/components`, { waitUntil: "load" });
    await page.getByRole("button", { name: "New reusable component" }).click();
    const create = page.getByRole("form", { name: "New reusable component" });
    await create.getByLabel("Type").selectOption("cta");
    await create.getByLabel(/^Name/).fill("Probe permission CTA");
    await create.getByRole("button", { name: "Create draft" }).click();
    await page.waitForURL(/\/admin\/components\/\d+$/, { timeout: 30_000 });
    CID = (await sql<{ id: number }[]>`select id from reusable_components where name = 'Probe permission CTA'`)[0]?.id ?? 0;
    await page.locator(`#reusable-${CID}-label-en`).fill("Talk to the desk");
    await page.locator(`#reusable-${CID}-href`).fill("/contact");
    await page.locator("[data-reuse-save]").click();
    const draft = await until(async () => (await sql<{ href: string | null }[]>`select draft->>'href' as href from reusable_components where id = ${CID}`)[0]?.href === "/contact");
    const published = (await sql<{ v: number }[]>`select published_version as v from reusable_components where id = ${CID}`)[0]!.v;
    say("P8.1 a component editor creates and saves a draft", CID > 0 && draft && published === 0);
    say("P8.2 …is offered no Publish, Archive or Delete — each absence explained",
      (await page.locator("[data-reuse-publish]").count()) === 0 && (await note(page, "components.publish").count()) === 1 &&
        (await page.locator("[data-reuse-archive]").count()) === 0 && (await note(page, "components.lifecycle").count()) === 1);
    const before = await stateOf();
    const revision = (await sql<{ r: number }[]>`select revision as r from reusable_components where id = ${CID}`)[0]!.r;
    const crafted = await rc("publishReusable", { id: CID, expectedRevision: revision }, actor);
    say("P8.3 crafted: publishing it anyway is refused and moves nothing",
      crafted?.ok === false && (await stateOf()) === before, JSON.stringify(crafted));
  }
  await as([...READ, "components.publish"]);
  {
    await page.goto(`${origin}/admin/components`, { waitUntil: "load" });
    await page.locator("[data-components-table]").waitFor({ timeout: 20_000 });
    say("P9.1 a component publisher is offered no New component, and told why",
      (await page.getByRole("button", { name: "New reusable component" }).count()) === 0 && (await note(page, "components.edit").count()) === 1);
    await page.goto(`${origin}/admin/components/${CID}`, { waitUntil: "load" });
    await page.locator("[data-reuse-publish]").waitFor({ timeout: 20_000 });
    say("P9.2 …sees the fields switched off and no Save",
      (await page.locator("[data-reuse-save]").count()) === 0 && (await page.locator(`#reusable-${CID}-href`).isDisabled()));
    await page.locator("[data-reuse-publish]").click();
    await page.locator("[data-reuse-publish-yes]").click();
    const done = await until(async () => (await sql<{ v: number }[]>`select published_version as v from reusable_components where id = ${CID}`)[0]!.v === 1);
    say("P9.3 …and publishes it", done);
  }
  await as([...READ, "components.lifecycle"]);
  {
    await page.goto(`${origin}/admin/components/${CID}`, { waitUntil: "load" });
    await page.locator("[data-reuse-archive]").waitFor({ timeout: 20_000 });
    say("P10.1 lifecycle alone: Archive, and no Save or Publish",
      (await page.locator("[data-reuse-save]").count()) === 0 && (await page.locator("[data-reuse-publish]").count()) === 0);
    await page.locator("[data-reuse-archive]").click();
    const archived = await until(async () => (await sql<{ s: string }[]>`select status as s from reusable_components where id = ${CID}`)[0]!.s === "archived");
    await page.getByRole("button", { name: "Restore from archive" }).click();
    const back = await until(async () => (await sql<{ s: string }[]>`select status as s from reusable_components where id = ${CID}`)[0]!.s === "active");
    say("P10.2 …archives and restores it", archived && back);
  }

  /* ====================================================================== */
  /* P11 · Globals are their own permissions                                 */
  /* ====================================================================== */
  await as([...READ, "navigation.manage"]);
  {
    await open(page);
    const globals = page.getByRole("button", { name: /Globals/ });
    await selectRow(page, HERO);
    await tab(page, "Content");
    say("P11.1 navigation without page editing: Globals is offered, the page stays locked, and nobody calls it read only",
      (await globals.count()) === 1 && (await titleBox(page).isDisabled()) &&
        (await page.locator('[data-permission-badge="read-only"]').count()) === 0);
    await globals.click();
    await page.getByRole("heading", { name: /Header/i }).first().waitFor({ timeout: 20_000 }).catch(() => undefined);
    say("P11.2 …and the drawer opens", (await globals.getAttribute("aria-expanded")) === "true");
  }
  await as([...READ, "content.edit", "content.style", "content.motion", "content.structure", "content.publish"]);
  {
    await open(page);
    say("P11.3 every page capability, no navigation or settings: no Globals", (await page.getByRole("button", { name: /Globals/ }).count()) === 0);
  }

  /* ====================================================================== */
  /* P12 · a permission revoked while the editor is open                     */
  /* ====================================================================== */
  await as([...READ, "content.edit", "content.style"]);
  {
    await open(page);
    await selectRow(page, HERO);
    await tab(page, "Content");
    await titleBox(page).fill("Saved before the revocation");
    const first = await until(async () => titleOf((await row(HERO)).draft) === "Saved before the revocation");
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
    await as([...READ, "content.style"]);
    await selectRow(page, HERO);
    await tab(page, "Content");
    await titleBox(page).fill("Typed after the revocation");
    const denial = page.locator('[data-save-denied="content"]');
    const refused = await until(async () => (await denial.count()) === 1, 20_000);
    const denialText = (await denial.textContent().catch(() => "")) ?? "";
    say("P12.1 the next save is refused, and the refusal is explained beside the work",
      first && refused && denialText.includes(DENIED.editContent) && /unsaved changes are kept/.test(denialText), denialText);
    say("P12.2 the unsaved words are still on screen, and the database kept the saved ones",
      (await titleBox(page).inputValue()) === "Typed after the revocation" && titleOf((await row(HERO)).draft) === "Saved before the revocation");
    say("P12.3 the content controls lock for the rest of the session", await titleBox(page).isDisabled());
    await tab(page, "Style");
    await setToken(page, "radius", "sm");
    const styled = await until(async () => baseOf((await row(HERO)).draft_styles)?.radius === "sm");
    say("P12.4 other work still saves: a style change goes through", styled, JSON.stringify(baseOf((await row(HERO)).draft_styles)));
    say("P12.5 …and the refused words were not saved on its back", titleOf((await row(HERO)).draft) === "Saved before the revocation");
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
    await expandHero(page);
    say("P12.6 direct editing is no longer offered", (await page.locator("[data-layer-edit]").count()) === 0);
  }

  /* ====================================================================== */
  /* P13 · Undo and Redo are not a way round a revocation                    */
  /* ====================================================================== */
  await as([...READ, "content.edit", "content.style"]);
  {
    await open(page);
    await selectRow(page, SECOND);
    await tab(page, "Style");
    await setToken(page, "radius", "lg");
    const styled = await until(async () => baseOf((await row(SECOND)).draft_styles)?.radius === "lg");
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
    const before = await row(SECOND);
    await as([...READ, "content.edit"]);
    await page.locator('[data-history="undo"]').click();
    await selectRow(page, SECOND);
    await tab(page, "Style");
    const refused = await until(async () => (await page.locator('[data-save-denied="style"]').count()) === 1, 20_000);
    say("P13.1 Undo of a style step after styling was revoked: the server refuses the replay",
      styled && refused, (await page.locator('[data-save-denied="style"]').textContent().catch(() => "")) ?? "");
    say("P13.2 …and the stored styles are exactly what they were", same((await row(SECOND)).draft_styles, before.draft_styles));
    await page.locator('[data-history="redo"]').click();
    const notice = page.locator("[data-history-notice]");
    await until(async () => (await notice.count()) === 1, 10_000);
    const noticeText = (await notice.textContent().catch(() => "")) ?? "";
    say("P13.3 the next step is refused before anything runs, and the toolbar says why",
      /cannot take this step: your role does not allow styling/.test(noticeText), noticeText);
    say("P13.4 …and still nothing moved", same((await row(SECOND)).draft_styles, before.draft_styles) && (await row(SECOND)).revision === before.revision);
  }

  /* ====================================================================== */
  /* P14 · the classic screens enforce the same split                        */
  /* ====================================================================== */
  {
    const viewerContext = await contextFor(viewer);
    const vpage = await newPage(viewerContext);
    await vpage.goto(`${origin}/admin/pages/section/${HERO}`, { waitUntil: "load" });
    await vpage.locator('[data-field="title"]').first().waitFor({ timeout: 20_000 });
    say("P14.1 classic section form, Viewer: fields off, no Save, the entrance menu off, and the reason given",
      (await note(vpage, "content.edit").count()) === 1 && (await vpage.getByRole("button", { name: "Save draft" }).count()) === 0 &&
        (await disabled(vpage, "#animation")) &&
        (await vpage.locator('[data-field="title"] input, [data-field="title"] textarea').first().isDisabled()));
    await vpage.goto(`${origin}/admin/pages/about`, { waitUntil: "load" });
    await vpage.locator("main").first().waitFor({ timeout: 20_000 });
    say("P14.2 classic page screen, Viewer: no Add a section, and the reason given",
      (await note(vpage, "content.structure").count()) === 1 && (await vpage.getByRole("heading", { name: "Add a section" }).count()) === 0);
    await viewerContext.close();
  }
  await as([...READ, "content.edit"]);
  {
    const animationBefore = (await row(HERO)).draft_animation;
    await page.goto(`${origin}/admin/pages/section/${HERO}`, { waitUntil: "load" });
    const field = page.locator('[data-field="title"] input, [data-field="title"] textarea').first();
    await field.waitFor({ timeout: 20_000 });
    say("P14.3 classic section form, content only: Save draft, no Publish, the entrance menu off with the reason",
      (await page.getByRole("button", { name: "Save draft" }).count()) === 1 &&
        (await page.getByRole("button", { name: /Save and publish|Publish draft/ }).count()) === 0 &&
        (await disabled(page, "#animation")) && (await note(page, "content.motion").count()) === 1);
    await field.fill("Saved from the classic form");
    await page.getByRole("button", { name: "Save draft" }).click();
    const saved = await until(async () => titleOf((await row(HERO)).draft) === "Saved from the classic form");
    say("P14.4 …the words save and the entrance is untouched", saved && (await row(HERO)).draft_animation === animationBefore);
  }
  await as([...READ, "content.publish"]);
  {
    await page.goto(`${origin}/admin/pages/about`, { waitUntil: "load" });
    const offered = page.getByRole("button", { name: "Publish saved changes" });
    await offered.first().waitFor({ timeout: 20_000 }).catch(() => undefined);
    const names = await page.getByRole("button").allTextContents();
    say("P14.5 classic page screen, publisher: Publish saved changes is offered",
      (await offered.count()) === 1, `${await offered.count()} · ${names.map((n) => n.trim()).filter(Boolean).slice(0, 12).join(" | ")}`);
  }

  /* ====================================================================== */
  /* P15 · the components screen and its sidebar entry                       */
  /* ====================================================================== */
  await as(["dashboard.view", "content.view", "visual_editor.view"]);
  {
    await page.goto(`${origin}/admin`, { waitUntil: "load" });
    await page.locator("main").first().waitFor({ timeout: 20_000 });
    const link = await page.locator('a[href="/admin/components"]').count();
    // The guard redirects from inside a streamed render, so the browser is
    // sent on by the page rather than by a 307 — wait for where it lands.
    await page.goto(`${origin}/admin/components`, { waitUntil: "load" });
    await page.waitForURL(/\/admin\?denied=1/, { timeout: 20_000 }).catch(() => undefined);
    say("P15.1 without components.view: no sidebar entry, and the screen turns them away",
      link === 0 && /\/admin\?denied=1/.test(page.url()) && (await page.locator("[data-components-table]").count()) === 0, page.url());
  }
  await as(READ);
  {
    await page.goto(`${origin}/admin`, { waitUntil: "load" });
    await page.locator("main").first().waitFor({ timeout: 20_000 });
    const link = await page.locator('a[href="/admin/components"]').count();
    await page.goto(`${origin}/admin/components`, { waitUntil: "load" });
    await page.locator("[data-components-table]").waitFor({ timeout: 20_000 });
    say("P15.2 with it: the entry and the list, read only", link > 0 && (await note(page, "components.edit").count()) === 1);
  }

  /* ====================================================================== */
  /* P16–P18 · more of §15: a permission taken away mid-task                 */
  /* ====================================================================== */

  // P16 · Publish removed after the publish panel was opened.
  await ownerContent(HERO, "Waiting for a publisher who loses the right");
  await as([...READ, "content.publish"]);
  {
    await open(page);
    await openPagePanel(page);
    const publish = page.getByRole("button", { name: "Publish saved changes" });
    await until(async () => (await publish.count()) === 1 && (await publish.isEnabled()), 20_000);
    await as(READ);
    const before = await stateOf();
    await publish.click();
    const panel = page.locator("aside[aria-label='Page changes and history']");
    const shown = await until(async () => ((await panel.getByRole("alert").allTextContents()).join(" ")).includes(DENIED.publish), 20_000);
    say("P16.1 publish removed with the panel open: the click is refused and the panel says why", shown,
      (await panel.getByRole("alert").allTextContents()).join(" | "));
    say("P16.2 …nothing was published", (await stateOf()) === before && titleOf((await row(HERO)).draft) === "Waiting for a publisher who loses the right");
    await until(async () => (await note(page, "content.publish").count()) === 1, 10_000);
    say("P16.3 …and the panel stops offering it for the rest of the session",
      (await page.getByRole("button", { name: "Publish saved changes" }).count()) === 0 && (await note(page, "content.publish").count()) === 1);
  }

  // P17 · Component publish removed after the draft was loaded.
  {
    const current = (await sql<{ r: number }[]>`select revision as r from reusable_components where id = ${CID}`)[0]!.r;
    const drafted = await rc("saveReusableDraft", { id: CID, expectedRevision: current, values: JSON.stringify({ label: { en: "Loaded, then refused", ar: "" }, href: "/contact" }) }, owner);
    if (!drafted?.ok) throw new Error(`owner could not draft the component: ${drafted?.message}`);
    await as([...READ, "components.publish"]);
    await page.goto(`${origin}/admin/components/${CID}`, { waitUntil: "load" });
    await page.locator("[data-reuse-publish]").waitFor({ timeout: 20_000 });
    await as(READ);
    const before = await stateOf();
    await page.locator("[data-reuse-publish]").click();
    await page.locator("[data-reuse-publish-yes]").click();
    const message = page.locator("[data-reuse-message]");
    const shown = await until(async () => ((await message.textContent().catch(() => "")) ?? "").includes(DENIED.publishComponents), 20_000);
    say("P17.1 component publish removed after the draft was loaded: refused, in words", shown, (await message.textContent().catch(() => "")) ?? "");
    say("P17.2 …and the published version did not move", (await stateOf()) === before);
  }

  // P18 · Advanced styling removed while an advanced change is still unsaved.
  await as([...READ, "content.style", "content.advanced_style"]);
  {
    await open(page);
    await selectRow(page, HERO);
    await tab(page, "Style");
    await page.locator('[data-style-token="minHeight"]').first().waitFor({ timeout: 15_000 });
    const before = await row(HERO);
    const target = baseOf(before.draft_styles)?.minHeight === "two-thirds-screen" ? "third-screen" : "two-thirds-screen";
    // Revoked inside the autosave's debounce: the change is on screen and not yet sent.
    await setToken(page, "minHeight", target);
    await as([...READ, "content.style"]);
    const denial = page.locator('[data-save-denied="style"]');
    const refused = await until(async () => (await denial.count()) === 1, 20_000);
    const denialText = (await denial.textContent().catch(() => "")) ?? "";
    say("P18.1 advanced styling removed with the change unsaved: the save is refused, and says what is missing",
      refused && denialText.includes(DENIED.editAdvancedStyle), denialText);
    const after = await row(HERO);
    say("P18.2 …the stored styles did not move", same(after.draft_styles, before.draft_styles) && after.revision === before.revision,
      JSON.stringify(baseOf(after.draft_styles)));
    say("P18.3 …and the unsaved choice is still on screen, locked now",
      (await page.locator('[data-style-token="minHeight"] select').first().inputValue()) === target &&
        (await page.locator('[data-style-locked="minHeight"]').count()) === 1);
  }

  /* ====================================================================== */
  /* Crafted requests the interface never offers                             */
  /* ====================================================================== */
  {
    await as(["content.manage", "dashboard.view", "visual_editor.view"]);
    let before = await stateOf();
    const legacy = await ve("saveVisualSectionDraft", { ...sectionFields(await row(HERO)), values: JSON.stringify({ ...(await row(HERO)).published, title: { en: "legacy key", ar: "" } }) }, actor);
    say("C1 content.manage alone is not a fallback: a save is refused and nothing moves",
      legacy?.ok === false && (await stateOf()) === before, legacy?.message);

    await as([...READ, "content.motion"]);
    before = await stateOf();
    const motionStyles = await ve("saveVisualSectionStyles", { ...sectionFields(await row(SECOND)), styles: JSON.stringify({ v: 1, nodes: { root: { base: { radius: "md" } } } }) }, actor);
    const motionLayout = await ve("reorderPageStructure", { pageId: about!.id, expectedRevision: (await pageRow("about")).revision, order: JSON.stringify([SECOND, HERO]) }, actor);
    say("C2 a motion editor's crafted style save and reorder are refused, in words, and nothing moves",
      motionStyles?.message === DENIED.editStyle && motionLayout?.message === DENIED.editStructure && (await stateOf()) === before,
      `${motionStyles?.message} | ${motionLayout?.message}`);

    await as([...READ, "content.style"]);
    before = await stateOf();
    const detach = await ve("detachVisualInstance", { ...sectionFields(await row(SECOND)), slot: "primaryCta" }, actor);
    say("C3 a stylist's crafted detach is refused as a reuse change, and nothing moves",
      detach?.ok === false && detach.message === DENIED.reuseInstance && (await stateOf()) === before, detach?.message);

    await as([...READ, "components.edit"]);
    before = await stateOf();
    const revision = (await sql<{ r: number }[]>`select revision as r from reusable_components where id = ${CID}`)[0]!.r;
    const archive = await rc("archiveReusable", { id: CID, expectedRevision: revision, archived: "1" }, actor);
    say("C4 a component editor's crafted archive is refused, and nothing moves",
      archive?.ok === false && (await stateOf()) === before, JSON.stringify(archive));
  }

  say("no page errors in any browser session", errors.length === 0, errors.slice(0, 3).join(" | "));
  await actorContext.close();
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
