/**
 * Batch 11 acceptance: the Globals drawer's social links, in a browser.
 *
 * The same registry and the same rules the Site settings screen has always
 * used — https only, one row per network, `twitter` and `x` the same thing —
 * reached through a second surface, with the footer proving each change and
 * the page on the canvas proving none of them was a page change.
 */

import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";

const PORT = 3711;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("globals_social_probe");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);

  const [about] = await sql<{ id: number }[]>`select id from pages where slug = 'about'`;
  const sections = await sql<{ id: number }[]>`
    select id from page_sections where page_id = ${about!.id} order by position, id`;
  await sql`update page_sections
               set draft = ${sql.json({ title: { en: "Still pending", ar: "" } })}::jsonb
             where id = ${sections[0]!.id}`;

  const pageState = async () => {
    const [page] = await sql<{ revision: number; draft_structure: unknown }[]>`
      select revision, draft_structure from pages where id = ${about!.id}`;
    const rows = await sql<{ id: number; revision: number; draft: unknown }[]>`
      select id, revision, draft from page_sections where page_id = ${about!.id} order by id`;
    const [count] = await sql<{ n: number }[]>`select count(*)::int as n from page_versions`;
    return JSON.stringify({ page, rows, versions: count!.n });
  };
  const baseline = await pageState();

  /** Poll the database until it says what we are waiting for, or give up. */
  const until = async (what: () => Promise<boolean>, ms = 15_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await what()) return true;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };

  const socialRows = () =>
    sql<{ id: number; platform: string; url: string; sort_order: number; is_published: boolean }[]>`
      select id, platform, url, sort_order, is_published
        from social_links order by sort_order, id`;

  const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);

  const editor = await context.newPage();
  editor.on("pageerror", (error) => console.log("   [pageerror]", error.message.slice(0, 140)));
  editor.on("dialog", (dialog) => void dialog.accept());
  await editor.goto(`${server.origin}/admin/visual-editor?page=about&lang=en&device=desktop`, {
    waitUntil: "load",
  });
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });

  const drawer = () => editor.locator("aside[aria-label='Global site settings']");
  const openGlobals = async () => {
    if ((await drawer().count()) === 0) {
      await editor.getByRole("button", { name: /^Globals$/ }).click();
    }
    await drawer().waitFor({ timeout: 15_000 });
    await drawer().getByRole("heading", { name: "Social links" }).waitFor({ timeout: 20_000 });
  };
  const visitorHtml = async () => {
    const visitor = await browser.newContext();
    const page = await visitor.newPage();
    await page.goto(`${server!.origin}/`, { waitUntil: "load" });
    const html = await page.content();
    await visitor.close();
    return html;
  };
  const socialArea = () =>
    drawer().locator("section").filter({ has: editor.getByRole("heading", { name: "Social links" }) });

  /* --- 1. add one ------------------------------------------------------- */
  await openGlobals();
  await socialArea().getByRole("button", { name: "Add a social link" }).click();
  await drawer().locator('select[name="platform"]').first().selectOption("linkedin");
  await drawer()
    .locator('input[name="url"]')
    .first()
    .fill("https://www.linkedin.com/company/elite-one-desk");
  await drawer().getByRole("button", { name: "Add link" }).first().click();
  await drawer().getByText(/Saved live\.|Added, live now\./).first().waitFor({ timeout: 30_000 });
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });

  let rows = await socialRows();
  const linkedin = rows.find((row) => row.platform === "linkedin");
  say("the link is stored", Boolean(linkedin));
  say("…and the footer shows it", (await visitorHtml()).includes("linkedin.com/company/elite-one-desk"));

  /* --- 2. the rules are the same rules ---------------------------------- */
  await openGlobals();
  await socialArea().getByRole("button", { name: "Add a social link" }).click();
  await drawer().locator('select[name="platform"]').first().selectOption("linkedin");
  await drawer().locator('input[name="url"]').first().fill("https://www.linkedin.com/company/again");
  await drawer().getByRole("button", { name: "Add link" }).first().click();
  await drawer().getByText(/already a link for LinkedIn/).waitFor({ timeout: 30_000 });
  say("a second row for one network is refused", true);

  await drawer().locator('select[name="platform"]').first().selectOption("instagram");
  await drawer().locator('input[name="url"]').first().fill("http://instagram.com/insecure");
  await drawer().getByRole("button", { name: "Add link" }).first().click();
  await drawer().getByText(/must be https|address is not valid/).waitFor({ timeout: 30_000 });
  say("an http address is refused", true);

  await drawer().locator('input[name="url"]').first().fill("https://www.instagram.com/eliteonedesk");
  await drawer().getByRole("button", { name: "Add link" }).first().click();
  /**
   * Wait for the row, not for the notice.
   *
   * The Social links group keeps its last notice on screen — step 1's "Added,
   * live now." — while another link is being added, so waiting for that text
   * could match the stale one at once and read the table before this add had
   * committed (Batch 15a sweep 2: 11/12, with the later order check proving
   * the row was stored). The row is the thing being asserted; the wait is
   * bounded, so an add that never lands still fails.
   */
  for (let i = 0; i < 150 && !(await socialRows()).some((row) => row.platform === "instagram"); i += 1) {
    await editor.waitForTimeout(200);
  }
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  rows = await socialRows();
  say("…and the https one is accepted", rows.some((row) => row.platform === "instagram"));

  /* --- 3. hide, move, delete -------------------------------------------- */
  const publishedOf = async (platform: string) =>
    (await socialRows()).find((row) => row.platform === platform)!.is_published;

  await openGlobals();
  await socialArea()
    .locator("li", { hasText: "Instagram" })
    .first()
    .getByRole("button", { name: "Hide", exact: true })
    .click();
  say("hiding takes it off the footer", await until(async () => (await publishedOf("instagram")) === false));
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  say("…and a visitor no longer sees it", !(await visitorHtml()).includes("instagram.com/eliteonedesk"));

  await openGlobals();
  await socialArea()
    .locator("li", { hasText: "Instagram" })
    .first()
    .getByRole("button", { name: "Show", exact: true })
    .click();
  say("showing it again is stored", await until(async () => (await publishedOf("instagram")) === true));
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  say("…and it is back in the footer", (await visitorHtml()).includes("instagram.com/eliteonedesk"));

  await openGlobals();
  rows = await socialRows();
  const last = rows[rows.length - 1]!;
  const labelOf = (platform: string) => (platform === "x" ? "X" : platform[0]!.toUpperCase() + platform.slice(1));
  await socialArea()
    .locator("li", { hasText: labelOf(last.platform) })
    .first()
    .getByRole("button", { name: `Move ${labelOf(last.platform)} up`, exact: true })
    .click();
  const moved = await until(async () => {
    const now = await socialRows();
    return now[now.length - 1]!.id !== last.id;
  });
  say(
    "moving a link up changes the footer order",
    moved,
    (await socialRows()).map((row) => row.platform).join(","),
  );
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });

  await openGlobals();
  await socialArea()
    .locator("li", { hasText: "Instagram" })
    .first()
    .getByRole("button", { name: "Delete Instagram", exact: true })
    .click();
  say(
    "deleting removes it",
    await until(async () => !(await socialRows()).some((row) => row.platform === "instagram")),
  );
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });

  /* --- 4. and the page never moved -------------------------------------- */
  say("no page draft, revision or version moved through any of it", (await pageState()) === baseline);
} finally {
  await browser.close();
  if (server) await server.stop();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
