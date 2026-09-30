/**
 * Batch 11 acceptance: the Globals drawer's settings half, in a browser.
 *
 * Contact, Brand and the feature switches, each proved where it actually shows
 * — the footer, the copyright line, the header — and each proved not to touch
 * the page on the canvas. The last section is the one that worried me most:
 * a global save while a section autosave is still in flight.
 */

import { canvasRedrawn, canvasUrl as canvasUrlOf, selectFromLayers } from "../canvas";
import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";

const PORT = 3710;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("globals_settings_probe");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);

  const [about] = await sql<{ id: number }[]>`select id from pages where slug = 'about'`;
  const sections = await sql<{ id: number }[]>`
    select id from page_sections where page_id = ${about!.id} order by position, id`;
  const hero = sections[0]!.id;

  const pageState = async () => {
    const [page] = await sql<{ revision: number; draft_structure: unknown }[]>`
      select revision, draft_structure from pages where id = ${about!.id}`;
    const rows = await sql<{ id: number; revision: number; draft: unknown }[]>`
      select id, revision, draft from page_sections where page_id = ${about!.id} order by id`;
    const [count] = await sql<{ n: number }[]>`select count(*)::int as n from page_versions`;
    return JSON.stringify({ page, rows, versions: count!.n });
  };

  const settingsOf = async (key: string) =>
    (await sql<{ value: Record<string, unknown> }[]>`
      select value from site_settings where key = ${key}`)[0]?.value ?? {};

  /** Poll the database until it says what we are waiting for, or give up. */
  const until = async (what: () => Promise<boolean>, ms = 20_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await what()) return true;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

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
    await drawer().getByText("Names and tagline").waitFor({ timeout: 20_000 });
  };
  const closeGlobals = async () => {
    if ((await drawer().count()) > 0) await drawer().getByRole("button", { name: "Close" }).click();
  };
  const visitorHtml = async (path = "/") => {
    const visitor = await browser.newContext();
    const page = await visitor.newPage();
    await page.goto(`${server!.origin}${path}`, { waitUntil: "load" });
    const html = await page.content();
    await visitor.close();
    return html;
  };
  const selectSection = (id: number) => selectFromLayers(editor, `section:${id}`);

  const baseline = await pageState();

  /**
   * "Saved live." has to outlive the refresh the save itself triggers.
   *
   * Which is also why every wait for it below is scoped to the form that was
   * just saved. Asked of the drawer, `.first()` matched an *earlier* form's
   * message — still showing, on purpose — and returned before this save had
   * been answered at all; the database was then read a moment too early, and
   * the probe reported a switch that had not been stored yet.
   *
   * Each of these forms is keyed on a value its own save changes, so the server
   * refresh remounts it with the stored values — which is what makes a
   * normalised number or address appear. The confirmation is asserted *after*
   * the globals have been re-read and the canvas has come back, never in the
   * gap before it.
   */
  const canvasUrl = () => canvasUrlOf(editor);
  /**
   * A global save is over when its refresh is (Batch 19A: was "Ready" and a
   * fixed 1.2 s). The form says "Saved live." as soon as the server answers;
   * the editor then re-reads the globals — remounting the form — and only
   * after that reloads the canvas. So it is over once the canvas is a new
   * document and has settled (`canvasRedrawn`, bounded, which says so when
   * the refresh never came).
   */
  const refreshed = (canvasBefore: string) => canvasRedrawn(editor, canvasBefore);
  const savedStillShowing = async (form: ReturnType<typeof drawer>, canvasBefore: string) =>
    (await refreshed(canvasBefore)) && (await form.getByText("Saved live.").count()) > 0;

  /* --- 1. Contact ------------------------------------------------------- */
  await openGlobals();
  const contact = drawer().locator("form", { hasText: "How people reach the business" });
  await contact.locator('input[name="phoneDisplay"]').fill("+966 50 111 2233");
  await contact.locator('input[name="phone"]').fill("+966501112233");
  await contact.locator('input[name="addressEn"]').fill("7 Probe Avenue");
  let canvasBefore = canvasUrl();
  await contact.getByRole("button", { name: "Save" }).click();
  await contact.getByText("Saved live.").first().waitFor({ timeout: 30_000 });
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });

  const stored = await settingsOf("contact");
  say("the contact details are stored", stored.phoneDisplay === "+966 50 111 2233");
  say(
    "Contact still says Saved live. after the refresh remounted it",
    await savedStillShowing(drawer().locator("form", { hasText: "How people reach the business" }), canvasBefore),
  );
  say(
    "…and the form shows the stored value",
    (await drawer()
      .locator("form", { hasText: "How people reach the business" })
      .locator('input[name="phoneDisplay"]')
      .inputValue()) === "+966 50 111 2233",
  );
  const home = await visitorHtml();
  say("…and the footer shows the new number", home.includes("+966 50 111 2233"));
  say("…and the new address", home.includes("7 Probe Avenue"));
  say("no page draft, revision or version moved", (await pageState()) === baseline);

  /* --- 2. Brand --------------------------------------------------------- */
  await openGlobals();
  const brand = drawer().locator("form", { hasText: "Names and tagline" });
  await brand.locator('input[name="legalNameEn"]').fill("Probe Holdings LLC");
  canvasBefore = canvasUrl();
  await brand.getByRole("button", { name: "Save" }).click();
  await brand.getByText("Saved live.").first().waitFor({ timeout: 30_000 });
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  say("the copyright line follows the legal name", (await visitorHtml()).includes("Probe Holdings LLC"));
  say(
    "Brand still says Saved live. after the refresh remounted it",
    await savedStillShowing(drawer().locator("form", { hasText: "Names and tagline" }), canvasBefore),
  );
  say("still no page state moved", (await pageState()) === baseline);

  /* --- 3. A feature switch --------------------------------------------- */
  const withSearch = await visitorHtml();
  const searchBefore = withSearch.includes('aria-label="Search"') || withSearch.includes("Search");
  await openGlobals();
  const features = drawer().locator("form", { hasText: "What the site shows" });
  await features.locator('input[name="searchEnabled"]').uncheck();
  canvasBefore = canvasUrl();
  await features.getByRole("button", { name: "Save" }).click();
  await features.getByText("Saved live.").first().waitFor({ timeout: 30_000 });
  await refreshed(canvasBefore);
  say(
    "the switch is stored off",
    await until(async () => (await settingsOf("features")).searchEnabled === false),
    String(searchBefore),
  );
  const withoutSearch = await visitorHtml();
  say(
    "…and the header's search control is gone",
    !withoutSearch.includes('aria-label="Search"') && !withoutSearch.includes('name="q"'),
  );

  // Put it back, so the fixture is as it was.
  await openGlobals();
  await drawer()
    .locator("form", { hasText: "What the site shows" })
    .locator('input[name="searchEnabled"]')
    .check();
  canvasBefore = canvasUrl();
  await drawer()
    .locator("form", { hasText: "What the site shows" })
    .getByRole("button", { name: "Save" })
    .click();
  await drawer()
    .locator("form", { hasText: "What the site shows" })
    .getByText("Saved live.")
    .first()
    .waitFor({ timeout: 30_000 });
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  say(
    "restoring the switch brings it back",
    await until(async () => (await settingsOf("features")).searchEnabled === true),
  );
  say(
    "Features still says Saved live. after the canvas reload",
    await savedStillShowing(drawer().locator("form", { hasText: "What the site shows" }), canvasBefore),
  );

  /* --- 3b. the server's own value comes back ---------------------------- */
  await openGlobals();
  const whatsapp = drawer().locator("form", { hasText: "The floating button and the chat links" });
  await whatsapp.locator('input[name="number"]').fill("+966 (50) 987-6543");
  await whatsapp.locator('input[name="enabled"]').check();
  canvasBefore = canvasUrl();
  await whatsapp.getByRole("button", { name: "Save" }).click();
  say(
    "WhatsApp still says Saved live. after the refresh",
    await savedStillShowing(
      drawer().locator("form", { hasText: "The floating button and the chat links" }),
      canvasBefore,
    ),
  );
  say(
    "…and the field shows the digits the server stored, not what was typed",
    (await drawer()
      .locator("form", { hasText: "The floating button and the chat links" })
      .locator('input[name="number"]')
      .inputValue()) === "966509876543",
    await drawer()
      .locator("form", { hasText: "The floating button and the chat links" })
      .locator('input[name="number"]')
      .inputValue(),
  );
  say("…and the floating button is on the site", (await visitorHtml()).includes("wa.me/966509876543"));

  /* --- 4. A refusal stays on screen ------------------------------------ */
  await openGlobals();
  const map = drawer().locator("form", { hasText: "How people reach the business" });
  await map.locator('input[name="mapEmbedUrl"]').fill("https://evil.example.com/embed");
  await map.getByRole("button", { name: "Save" }).click();
  await drawer().getByText(/map address was not accepted/).waitFor({ timeout: 30_000 });
  say("a map address from the wrong host is refused, and the message stays", true);
  say(
    "…the rejected value is still in the field",
    (await map.locator('input[name="mapEmbedUrl"]').inputValue()) === "https://evil.example.com/embed",
  );
  say(
    "…and the refusal did not turn into a success",
    (await map.getByText("Saved live.").count()) === 0,
  );
  await map.locator('input[name="mapEmbedUrl"]').fill("");
  canvasBefore = canvasUrl();
  await map.getByRole("button", { name: "Save" }).click();
  await map.getByText("Saved live.").first().waitFor({ timeout: 30_000 });
  await refreshed(canvasBefore);

  /* --- 5. a global save does not disturb a section edit ---------------- */
  await closeGlobals();
  await selectSection(hero);
  await editor.getByRole("tab", { name: /Content/ }).click();
  const box = editor.locator('[data-field="title"] textarea, [data-field="title"] input').first();
  await box.waitFor({ timeout: 15_000 });
  await box.fill("Typed while the site was being edited");

  // Straight into a global save, with the autosave still on its timer.
  await openGlobals();
  await drawer()
    .locator("form", { hasText: "Names and tagline" })
    .locator('input[name="taglineEn"]')
    .fill("A tagline saved mid-keystroke");
  canvasBefore = canvasUrl();
  await drawer()
    .locator("form", { hasText: "Names and tagline" })
    .getByRole("button", { name: "Save" })
    .click();
  await drawer()
    .locator("form", { hasText: "Names and tagline" })
    .getByText("Saved live.")
    .first()
    .waitFor({ timeout: 30_000 });
  await refreshed(canvasBefore);
  await until(async () => {
    const [row] = await sql<{ draft: { title?: { en?: string } } | null }[]>`select draft from page_sections where id = ${hero}`;
    return row!.draft?.title?.en === "Typed while the site was being edited";
  });

  const [section] = await sql<{ draft: { title?: { en?: string } } | null }[]>`
    select draft from page_sections where id = ${hero}`;
  say(
    "the section autosave still landed, with the typed words",
    section!.draft?.title?.en === "Typed while the site was being edited",
    JSON.stringify(section!.draft?.title ?? null),
  );
  say(
    "…and the tagline saved too",
    (await settingsOf("brand")).taglineEn === "A tagline saved mid-keystroke",
  );
  // The row being committed is not the editor knowing it: the toolbar counts
  // the section as unsaved until the autosave's answer has reached the browser
  // and been applied, a moment after the commit (Batch 19A). So the toolbar is
  // read once its pending badge has had the time to clear — bounded, and a
  // badge that stays is still this check failing, with the badge as the reason.
  const pending = async () => {
    const text = (await editor.locator("header").first().innerText()).replace(/\s+/g, " ");
    return /unsaved/.test(text) ? (text.match(/\S*\s?\S*unsaved\S*/)?.[0] ?? text) : "";
  };
  await until(async () => (await pending()) === "", 15_000);
  const badge = await pending();
  say("the toolbar reports nothing unsaved", badge === "", badge);

  /* --- 6. …and the draft is still a draft ------------------------------- */
  const [count] = await sql<{ n: number }[]>`select count(*)::int as n from page_versions`;
  say("no restore point was written by any of it", count!.n === 0, String(count!.n));
  const visitorAbout = await visitorHtml("/about");
  say(
    "a visitor does not see the pending words",
    !visitorAbout.includes("Typed while the site was being edited"),
  );
} finally {
  await browser.close();
  if (server) await server.stop();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
