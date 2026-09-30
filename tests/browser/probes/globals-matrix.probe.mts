/**
 * Batch 11 acceptance: who sees what in the Visual Editor, in a browser.
 *
 * Five combinations, one screen. What each of them is shown has to match what
 * the server would let them do — a Globals button for somebody with no global
 * permission would be a promise the first save breaks, and a drawer sent to
 * them with the fields disabled would be site settings handed to an account
 * that may not have them.
 */

import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";

const PORT = 3708;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("globals_matrix_probe");
const sql = connect(database);
let server;
try {
  await signIn(sql); // the owner account exists; this session is not used
  server = await startServer(database, PORT);

  /**
   * `roles.key` is an enum of four, so a combination the defaults never hand
   * out is made by re-granting one spare role rather than by inventing one.
   */
  const [spare] = await sql<{ id: number }[]>`select id from roles where key = 'viewer'`;
  const spareId = spare!.id;
  await sql`delete from users where email = 'matrix@eod.invalid'`;
  await sql`insert into users (email, name, password_hash, role_id, is_active)
            values ('matrix@eod.invalid', 'Matrix', 'x', ${spareId}, true)`;
  const session = await signIn(sql, "viewer");

  const as = async (keys: string[]) => {
    await sql`delete from role_permissions where role_id = ${spareId}`;
    if (keys.length) {
      await sql`insert into role_permissions (role_id, permission_id)
                select ${spareId}, p.id from permissions p where p.key = any(${keys})`;
    }
  };

  const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [name, value] = session.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("   [pageerror]", error.message.slice(0, 140)));

  const openEditor = async () => {
    await page.goto(`${server!.origin}/admin/visual-editor?page=about&lang=en&device=desktop`, {
      waitUntil: "load",
    });
  };
  const ready = () => page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  const drawer = () => page.locator("aside[aria-label='Global site settings']");
  const hasGlobalsButton = () => page.getByRole("button", { name: /^Globals$/ }).count();

  const READER = ["dashboard.view", "content.view", "visual_editor.view"];
  /**
   * Page editing, as Batch 18 grants it: the split keys, not the legacy
   * `content.manage`, which is kept for a rollback and authorizes nothing now.
   */
  const PAGE_EDITING = ["content.edit", "content.style", "content.advanced_style", "content.motion", "content.structure", "content.publish"];

  /* --- 1. a reader ------------------------------------------------------ */
  await as(READER);
  await openEditor();
  await ready();
  say("a reader may open the editor", true);
  say("…and is told it is read only", (await page.getByText("Read only", { exact: true }).count()) === 1);
  say("…and is offered no Globals button", (await hasGlobalsButton()) === 0);

  /* --- 2. a content editor ---------------------------------------------- */
  await as([...READER, ...PAGE_EDITING]);
  await openEditor();
  await ready();
  say("a content editor gets the editor", true);
  say("…is not told it is read only", (await page.getByText("Read only", { exact: true }).count()) === 0);
  say("…and still no Globals button", (await hasGlobalsButton()) === 0);

  /* --- 3. a navigation manager ------------------------------------------ */
  await as([...READER, "navigation.manage"]);
  await openEditor();
  await ready();
  say("a navigation manager gets a Globals button", (await hasGlobalsButton()) === 1);
  await page.getByRole("button", { name: /^Globals$/ }).click();
  await drawer().waitFor({ timeout: 15_000 });
  await drawer().getByText("Navigation").first().waitFor({ timeout: 20_000 });
  say("…with the menus", (await drawer().getByRole("button", { name: "Header menu" }).count()) === 1);
  say("…and no Brand form", (await drawer().getByText("Names and tagline").count()) === 0);
  say("…and no Social links", (await drawer().getByText("Social links").count()) === 0);
  say(
    "…and no stored settings in the page at all",
    !(await page.content()).includes("defaultMessageEn"),
  );

  /* --- 4. a settings manager -------------------------------------------- */
  await as([...READER, "settings.manage"]);
  await openEditor();
  await ready();
  say("a settings manager gets a Globals button", (await hasGlobalsButton()) === 1);
  await page.getByRole("button", { name: /^Globals$/ }).click();
  await drawer().waitFor({ timeout: 15_000 });
  await drawer().getByText("Names and tagline").waitFor({ timeout: 20_000 });
  say("…with Brand", (await drawer().getByText("Names and tagline").count()) === 1);
  say("…and Contact", (await drawer().getByText("How people reach the business").count()) === 1);
  say("…and WhatsApp", (await drawer().getByText("The floating button and the chat links").count()) === 1);
  say("…and Disclaimers", (await drawer().getByText("The notices shown with services").count()) === 1);
  say("…and Features", (await drawer().getByText("What the site shows").count()) === 1);
  say("…and Social links", (await drawer().getByText("Social links").count()) > 0);
  say("…and no Header menu", (await drawer().getByRole("button", { name: "Header menu" }).count()) === 0);

  /* --- 5. an owner ------------------------------------------------------ */
  await as([
    ...READER,
    ...PAGE_EDITING,
    "navigation.manage",
    "settings.manage",
  ]);
  await openEditor();
  await ready();
  await page.getByRole("button", { name: /^Globals$/ }).click();
  await drawer().waitFor({ timeout: 15_000 });
  await drawer().getByRole("button", { name: "Header menu" }).waitFor({ timeout: 20_000 });
  say("holding both gets both halves", (await drawer().getByText("Names and tagline").count()) === 1);

  /* --- 6. the editor's own key ------------------------------------------ */
  await as(["dashboard.view", "content.view", ...PAGE_EDITING, "settings.manage"]);
  await openEditor();
  say(
    "without visual_editor.view the canvas is refused",
    !(await page.content()).includes("Page structure"),
  );
  const dashboard = await context.newPage();
  await dashboard.goto(`${server.origin}/admin`, { waitUntil: "load" });
  const sidebar = await dashboard.content();
  say("…and the sidebar does not offer it", !sidebar.includes("Visual Editor"));
  say("…while Pages & sections is still listed", sidebar.includes("Pages &amp; sections") || sidebar.includes("Pages & sections"));
  await dashboard.close();
} finally {
  await browser.close();
  if (server) await server.stop();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
