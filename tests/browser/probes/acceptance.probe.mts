/**
 * Manual browser acceptance for Batch 5 — not part of `npm test`.
 * Drives the real Visual Editor in Chromium against the real build.
 */

import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";
import { until } from "../wait";

const PORT = 3701;
const NEW_TEXT = "Edited from the canvas inspector.";

const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("acceptance");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  const viewer0 = await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    select 'viewer@test.invalid', 'Read Only', 'unused', id, true from roles where key = 'viewer'`;
  void viewer0;
  const viewer = await signIn(sql, "viewer");
  server = await startServer(database, PORT);

  const [hero] = await sql<{ id: number; published: Record<string, unknown> }[]>`
    select s.id, s.published from page_sections s join pages p on p.id = s.page_id
     where p.slug = 'home' and s.block_type = 'hero' limit 1`;

  const openEditor = async (cookie: string, query = "") => {
    const context = await browser.newContext({ viewport: { width: 1680, height: 1000 } });
    const [name, value] = cookie.split("=");
    await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
    const page = await context.newPage();
    page.on("pageerror", (error) => console.log("  [page error]", error.message));
    await page.goto(`${server!.origin}/admin/visual-editor${query}`, { waitUntil: "domcontentloaded" });
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 30_000 });
    return { context, page };
  };

  const canvas = (page: import("playwright").Page) => {
    const frame = page.frames().find((f) => f.url().includes("editor=1"));
    if (!frame) throw new Error("no canvas frame");
    return frame;
  };

  /* ---------------------------------------------------------------- */
  /* 1. Select, edit, save, and watch the canvas come back             */
  /* ---------------------------------------------------------------- */
  {
    const { context, page } = await openEditor(owner.cookie);
    const lead = canvas(page).locator(`[data-eod-address="section:${hero!.id}/field:lead"]`);
    await lead.waitFor({ timeout: 15_000 });
    const originalText = (await lead.innerText()).trim();
    await lead.click();

    await page.getByText("Supporting sentence").first().waitFor({ timeout: 10_000 });
    say("selecting a sentence opens its field in the inspector", true);

    const box = page.locator('[data-field="lead"] textarea').first();
    await box.waitFor({ timeout: 10_000 });
    say("the field carries the live value", (await box.inputValue()).trim() === originalText,
      `"${(await box.inputValue()).slice(0, 40)}…"`);

    const focused = await page.locator('[data-field="lead"][data-focused="true"]').count();
    say("the selected field is the one highlighted", focused === 1);

    const save = page.getByRole("button", { name: "Save now" });
    say("Save is inert until something changes", await save.isDisabled());

    await box.fill(NEW_TEXT);
    await page.getByText("Unsaved content").waitFor({ timeout: 5000 });
    say("typing marks the section unsaved", true);
    say("Layers shows the unsaved section", (await page.getByText("Unsaved", { exact: true }).count()) > 0);

    await save.click();
    await page.getByText("Draft saved").waitFor({ timeout: 20_000 });
    say("the save reports back", true);

    // The canvas reloads, and the selection is put back by address.
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 30_000 });
    const again = canvas(page).locator(`[data-eod-address="section:${hero!.id}/field:lead"]`);
    await again.waitFor({ timeout: 15_000 });
    await until(async () => (await again.innerText()).includes(NEW_TEXT), 15_000);
    say("the canvas shows the saved draft", (await again.innerText()).includes(NEW_TEXT));
    await until(async () => (await page.locator('[data-field="lead"][data-focused="true"]').count()) === 1, 15_000);
    say(
      "the selection came back to the same node",
      (await page.locator('[data-field="lead"][data-focused="true"]').count()) === 1,
    );

    const [row] = await sql<{ draft: Record<string, unknown>; published: Record<string, unknown>; revision: number }[]>`
      select draft, published, revision from page_sections where id = ${hero!.id}`;
    const draftLead = (row!.draft.lead as { en: string }).en;
    say("the draft holds it", draftLead === NEW_TEXT, draftLead);
    say("published is untouched", JSON.stringify(row!.published) === JSON.stringify(hero!.published));
    say("the revision advanced", row!.revision === 1, String(row!.revision));

    await context.close();
  }

  /* ---------------------------------------------------------------- */
  /* 2. Arabic edits one language, and says when it is falling back    */
  /* ---------------------------------------------------------------- */
  {
    const { context, page } = await openEditor(owner.cookie, "?page=home&lang=ar&device=desktop");
    const lead = canvas(page).locator(`[data-eod-address="section:${hero!.id}/field:lead"]`);
    await lead.waitFor({ timeout: 15_000 });
    await lead.click();
    const boxes = page.locator('[data-field="lead"] textarea');
    await boxes.first().waitFor({ timeout: 10_000 });
    say("one language at a time", (await boxes.count()) === 1, `${await boxes.count()} boxes`);
    say("the box is right-to-left", (await boxes.first().getAttribute("dir")) === "rtl");

    await boxes.first().fill("");
    await page.getByText(/Empty in Arabic/).waitFor({ timeout: 5000 });
    say("an empty Arabic value says the site will fall back", true);
    const english = await boxes.first().inputValue();
    say("and the English is not copied in", english === "");
    await context.close();
  }

  /* ---------------------------------------------------------------- */
  /* 3. A reader may look, not touch                                   */
  /* ---------------------------------------------------------------- */
  {
    const { context, page } = await openEditor(viewer.cookie);
    say("the toolbar says read only", (await page.getByText("Read only").count()) > 0);
    const lead = canvas(page).locator(`[data-eod-address="section:${hero!.id}/field:lead"]`);
    await lead.waitFor({ timeout: 15_000 });
    await lead.click();
    const box = page.locator('[data-field="lead"] textarea').first();
    await box.waitFor({ timeout: 10_000 });
    say("a reader sees the real content", (await box.inputValue()).includes(NEW_TEXT));
    say("but cannot type into it", await box.isDisabled());
    say("and is offered no Save", (await page.getByRole("button", { name: "Save now" }).count()) === 0);
    await context.close();
  }

  /* ---------------------------------------------------------------- */
  /* 4. A repeatable row is edited by identity                          */
  /* ---------------------------------------------------------------- */
  {
    const [links] = await sql<{ id: number; published: Record<string, unknown> }[]>`
      select s.id, s.published from page_sections s join pages p on p.id = s.page_id
       where p.slug = 'home' and s.block_type = 'quick-links' limit 1`;
    const rows = links!.published.links as Record<string, unknown>[];
    const second = String(rows[1]!._id);

    const { context, page } = await openEditor(owner.cookie);
    const card = canvas(page).locator(`[data-eod-address="section:${links!.id}/field:links/item:${second}"]`);
    await card.waitFor({ timeout: 15_000 });
    await card.click();
    await page.locator(`[data-item-id="${second}"]`).waitFor({ timeout: 10_000 });
    say("clicking a card points the panel at that row", true);
    say(
      "and says which one is selected",
      (await page.locator(`[data-item-id="${second}"]`).innerText()).includes("selected"),
    );
    await context.close();
  }
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
