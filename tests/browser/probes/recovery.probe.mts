/**
 * Batch 7 correction acceptance: getting back something hidden at Base.
 *
 * The sequence that matters is the one nobody can do twice by accident: hide a
 * child at Base, save, and then come back to the editor in a *new session*, so
 * the selection that made the hide is gone and the element cannot be clicked at
 * any width. Everything below is driven through the panel's own controls.
 */

import { editorSettled, selectCanvasNode } from "../canvas";
import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";

const PORT = 3721;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("recovery");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    select 'viewer@test.invalid', 'Read Only', 'unused', id, true from roles where key = 'viewer'`;
  const viewer = await signIn(sql, "viewer");
  server = await startServer(database, PORT);

  const section = async (slug: string, block: string) =>
    (
      await sql<{ id: number; published: Record<string, unknown> }[]>`
        select s.id, s.published from page_sections s join pages p on p.id = s.page_id
         where p.slug = ${slug} and s.block_type = ${block} order by s.position limit 1`
    )[0]!;

  const hero = await section("privacy", "page-hero");
  const links = await section("home", "quick-links");

  const state = async (id: number) =>
    (
      await sql<{ revision: number; draft_styles: unknown; styles: unknown }[]>`
        select revision, draft_styles, styles from page_sections where id = ${id}`
    )[0]!;

  const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("   [pageerror]", error.message.slice(0, 140)));
  page.on("dialog", (dialog) => dialog.accept());

  const open = async (query: string) => {
    await page.goto(`${server!.origin}/admin/visual-editor${query}`, { waitUntil: "load" });
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 30_000 });
  };
  const frame = () => page.frames().find((f) => f.url().includes("editor=1"))!;
  /**
   * Select an exact address.
   *
   * Clicking the element is how an editor does it, and for most nodes the two
   * are the same thing. They are not the same for a card whose picture fills
   * it: pointing at one selects the picture, which is what pointing at a
   * photograph should do, and the card itself is reached with the inspector's
   * one step out. This walks that path rather than asserting the old
   * behaviour — the card is still selectable, by the gesture the editor now
   * has for it.
   */
  const selected = async (): Promise<string> => {
    // The exact address, not a prefix of it: an image's address begins with
    // its card's, so `includes` would call the picture the card.
    const codes = await page.locator("aside[aria-label='Inspector'] code").allTextContents();
    return codes.map((text) => text.trim()).find((text) => text.startsWith("section:")) ?? "";
  };
  const select = async (address: string) => {
    const element = frame().locator(`[data-eod-address="${address}"]`);
    /**
     * Visible, not merely attached.
     *
     * A style save re-renders the canvas, and the node is in the document
     * before it has a box. Clicking then lands on whatever is under that
     * point — in practice the section root — and a step-out walk can only go
     * outwards, so it can never recover a child. That is how this
     * silently hid the section root instead of its title field in two runs out
     * of ten, and the damage surfaced three assertions later, in the reader
     * section, as a timeout waiting for a recovery list the application was
     * right not to draw: the list is for a section's children, never for a
     * section that is itself hidden.
     */
    await element.first().waitFor({ state: "visible", timeout: 20_000 });
    // One click where the canvas is still, and no stepping out before the
    // Inspector has answered (Batch 19A — see `tests/browser/canvas.ts`).
    const result = await selectCanvasNode(page, address);
    /**
     * And it says so when it did not get there.
     *
     * It used to fall out of the loop without a word, leaving the caller to
     * style whatever happened to be selected. Every assertion after that point
     * is then measuring the wrong node, and the first one to notice is a long
     * way from the mistake.
     */
    const current = await selected();
    if (current !== address) {
      throw new Error(`select(${address}) ended on ${current || "nothing"}; the click landed on ${JSON.stringify(result.landing)}`);
    }
  };
  const device = async (label: "Desktop" | "Tablet" | "Mobile") => {
    await page.getByRole("button", { name: new RegExp(`^${label}`) }).click();
    await page.waitForTimeout(700);
  };
  const styleTab = () => page.getByRole("tab", { name: /Style/ });
  const setToken = async (token: string, option: string) => {
    const control = page.locator(`[data-style-token="${token}"] select`);
    await control.waitFor({ timeout: 10_000 });
    await control.selectOption(option);
  };
  const saveStyles = async (id: number) => {
    const before = (await state(id)).revision;
    /**
     * Hurry the debounce along, or let autosave have already done it.
     *
     * Batch 10 made saving automatic, so between checking that "Save now" is
     * enabled and clicking it the work can have been sent — and Playwright
     * then retries a click on a button that has correctly disabled itself. A
     * short, ignorable click followed by waiting for the panel to go quiet
     * covers both orders without asserting anything about which happened.
     */
    const saveNow = page.getByRole("button", { name: "Save now" });
    await saveNow.click({ timeout: 2500 }).catch(() => undefined);
    for (let i = 0; i < 100 && (await saveNow.isEnabled().catch(() => false)); i += 1) {
      await page.waitForTimeout(200);
    }
    for (let i = 0; i < 80 && (await state(id)).revision === before; i += 1) {
      await page.waitForTimeout(200);
    }
    await editorSettled(page);
  };
  const display = (address: string) =>
    frame()
      .locator(`[data-eod-address="${address}"]`)
      .evaluate((n) => getComputedStyle(n as Element).display);
  /** The Layers row for a section, which is the only way in once it is hidden. */
  const layer = (blockType: string) =>
    page.locator("aside[aria-label='Page structure'] button").filter({ hasText: blockType }).first();
  const hiddenRows = () =>
    page.locator("[data-hidden-elements] li").evaluateAll((rows) =>
      rows.map((row) => ({
        path: (row as HTMLElement).dataset.hiddenPath ?? "",
        text: (row as HTMLElement).innerText.replace(/\s+/g, " ").trim(),
      })),
    );

  /* --- 1. a text field, hidden at Base, recovered in a new session ------- */
  await open("?page=privacy&lang=en&device=desktop");
  const lead = `section:${hero.id}/field:lead`;
  await select(lead);
  await styleTab().click();
  await page.locator('[data-style-token="hidden"]').waitFor({ timeout: 10_000 });
  await setToken("hidden", "hide");
  await saveStyles(hero.id);

  say("the field is hidden at Desktop", (await display(lead)) === "none");
  await device("Tablet");
  say("…at Tablet", (await display(lead)) === "none");
  await device("Mobile");
  say("…and at Mobile — there is no width that shows it", (await display(lead)) === "none");

  // A completely fresh editor: the selection that made the hide is gone, and
  // nothing on the canvas can be clicked to get it back.
  await page.goto(`${server.origin}/admin/pages`, { waitUntil: "load" });
  await open("?page=privacy&lang=en&device=desktop");
  say("a fresh session starts with nothing selected", (await page.getByText(/Select something on the canvas/).count()) > 0);
  const clickable = await frame()
    .locator(`[data-eod-address="${lead}"]`)
    .evaluate((n) => {
      const rect = (n as HTMLElement).getBoundingClientRect();
      return rect.width > 0 || rect.height > 0;
    });
  say("…and the hidden field cannot be pointed at", !clickable);

  await layer("page-hero").click();
  await page.waitForTimeout(600);
  await styleTab().click();
  await page.locator("[data-hidden-elements]").waitFor({ timeout: 10_000 });
  const rows = await hiddenRows();
  say("the section lists what it has hidden", rows.length === 1, JSON.stringify(rows));
  say("…by name, not by address", rows[0]?.text.startsWith("Lead") === true, rows[0]?.text ?? "");
  say("…and says it is hidden everywhere", /Hidden at all widths/.test(rows[0]?.text ?? ""));
  say("…pointing at the right node", rows[0]?.path === "field:lead", rows[0]?.path ?? "");

  const beforeRestore = JSON.stringify(await state(hero.id));
  say("the hide is on file as a style draft", /"hidden":true/.test(beforeRestore), beforeRestore.slice(0, 160));
  await page.locator("[data-hidden-elements] li button", { hasText: "Restore" }).first().click();
  await page.waitForTimeout(400);
  say("Restore marks the styles unsaved", (await page.getByText("Unsaved styles").count()) > 0);
  // Restore is an edit to the local buffer and nothing more: the row still
  // holds the hide, at the same revision, until Save styles.
  say(
    "…and changes nothing in the database yet",
    JSON.stringify(await state(hero.id)) === beforeRestore,
    JSON.stringify(await state(hero.id)).slice(0, 160),
  );
  say("…and the canvas has not moved", (await display(lead)) === "none");

  await saveStyles(hero.id);
  say("Save brings the field back on the real canvas", (await display(lead)) !== "none");
  say("…with nothing left in the list", (await page.locator("[data-hidden-elements]").count()) === 0);
  const stored = (await state(hero.id)).draft_styles as { nodes: Record<string, unknown> };
  say("…and nothing left in the document", JSON.stringify(stored.nodes) === "{}", JSON.stringify(stored.nodes));

  await select(lead);
  await styleTab().click();
  say(
    "…and the field can be selected on the canvas again",
    (await page.locator('[data-style-token="hidden"] select').inputValue()) === "__default__",
  );

  /* --- 2. a repeatable row, the same way -------------------------------- */
  await open("?page=home&lang=en&device=desktop");
  const rowsOf = (links.published.links as Record<string, unknown>[]) ?? [];
  const hiddenId = String(rowsOf[1]!._id);
  const neighbourId = String(rowsOf[2]!._id);
  const card = `section:${links.id}/field:links/item:${hiddenId}`;
  const neighbour = `section:${links.id}/field:links/item:${neighbourId}`;
  await select(card);
  await styleTab().click();
  await setToken("hidden", "hide");
  await saveStyles(links.id);
  say("the row is hidden at every width", (await display(card)) === "none");
  say("…and its neighbour is not", (await display(neighbour)) !== "none");

  await page.goto(`${server.origin}/admin/pages`, { waitUntil: "load" });
  await open("?page=home&lang=en&device=desktop");
  await layer("quick-links").click();
  await page.waitForTimeout(600);
  await styleTab().click();
  await page.locator("[data-hidden-elements]").waitFor({ timeout: 10_000 });
  const cardRows = await hiddenRows();
  say("the row is listed by the words on it", /Visa Assistance/.test(cardRows[0]?.text ?? ""), JSON.stringify(cardRows));
  say("…and targets its own id", cardRows[0]?.path === `field:links/item:${hiddenId}`, cardRows[0]?.path ?? "");
  say("…and nothing is shown as a raw id", !/i_[A-Za-z0-9]/.test(cardRows[0]?.text ?? ""), cardRows[0]?.text ?? "");

  // Move the row behind the editor's back: recovery follows the id, not the
  // position it happened to be in when it was hidden.
  await sql`update page_sections
               set draft = jsonb_set(coalesce(draft, published), '{links}',
                     jsonb_build_array(published->'links'->1, published->'links'->0)
                       || coalesce((published->'links') #- '{1}' #- '{0}', '[]'::jsonb)),
                   revision = revision + 1
             where id = ${links.id}`;
  await open("?page=home&lang=en&device=desktop");
  await layer("quick-links").click();
  await page.waitForTimeout(600);
  await styleTab().click();
  await page.locator("[data-hidden-elements]").waitFor({ timeout: 10_000 });
  const moved = await hiddenRows();
  say("after a reorder it is still the same row", moved[0]?.path === `field:links/item:${hiddenId}`, moved[0]?.path ?? "");
  say("…still named by its own words", /Visa Assistance/.test(moved[0]?.text ?? ""), moved[0]?.text ?? "");
  say("…and it is still the hidden one on the canvas", (await display(card)) === "none");
  say("…and the row now in its old place is not", (await display(neighbour)) !== "none");

  await page.locator("[data-hidden-elements] li button", { hasText: "Restore" }).first().click();
  await saveStyles(links.id);
  say("Restore brings that row back", (await display(card)) !== "none");
  say("…and left the neighbour alone", (await display(neighbour)) !== "none");

  /* --- 3. a hidden section root is still reachable through Layers -------- */
  await open("?page=privacy&lang=en&device=desktop");
  // Selected from Layers, because a click in the middle of a section lands on
  // whatever field is under the pointer — the row is how a section root is
  // reached, which is the whole reason a hidden one stays recoverable.
  await layer("page-hero").click();
  await page.waitForTimeout(600);
  await styleTab().click();
  await page.locator('[data-style-token="hidden"]').waitFor({ timeout: 10_000 });
  await setToken("hidden", "hide");
  await saveStyles(hero.id);
  const rootDisplay = await display(`section:${hero.id}`);
  say("the section root is hidden at every width", rootDisplay === "none", rootDisplay);

  await page.goto(`${server.origin}/admin/pages`, { waitUntil: "load" });
  await open("?page=privacy&lang=en&device=desktop");
  say("…and it is still a row in Layers", (await layer("page-hero").count()) > 0);
  await layer("page-hero").click();
  await page.waitForTimeout(600);
  await styleTab().click();
  say(
    "…which selects it even though it measures nothing",
    (await page.locator('[data-style-token="hidden"] select').inputValue()) === "hide",
  );
  say(
    "…and the recovery list is for its children, not for itself",
    (await page.locator("[data-hidden-elements]").count()) === 0,
  );
  await setToken("hidden", "__default__");
  await saveStyles(hero.id);
  say("…and clearing it brings the section back", (await display(`section:${hero.id}`)) !== "none");

  /* --- 4. a reader may look and not touch -------------------------------- */
  /**
   * From a fresh canvas, like every other selection in this file.
   *
   * This was the one place that picked a child while its own section was
   * already selected — section 3 leaves the root selected — and in six runs of
   * twenty the click landed on the root instead of the field. `select` can only
   * step outwards, so it could not come back from that, and the wrong node was
   * hidden; the reader then had no recovery list to show, correctly, because a
   * hidden section's list is for its children. Loading the editor drops the
   * selection, which is asserted at the top of this file.
   */
  await open("?page=privacy&lang=en&device=desktop");
  await select(`section:${hero.id}/field:title`);
  await styleTab().click();
  await page.locator('[data-style-token="hidden"]').waitFor({ timeout: 10_000 });
  await setToken("hidden", "hide");
  await saveStyles(hero.id);
  await context.close();

  const readerContext = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [vName, vValue] = viewer.cookie.split("=");
  await readerContext.addCookies([{ name: vName!, value: vValue!, domain: "127.0.0.1", path: "/" }]);
  const reader = await readerContext.newPage();
  await reader.goto(`${server.origin}/admin/visual-editor?page=privacy&lang=en&device=desktop`, {
    waitUntil: "load",
  });
  await reader.getByText("Ready", { exact: true }).waitFor({ timeout: 30_000 });
  await reader
    .locator("aside[aria-label='Page structure'] button")
    .filter({ hasText: "page-hero" })
    .first()
    .click();
  await reader.waitForTimeout(600);
  await reader.getByRole("tab", { name: /Style/ }).click();
  await reader.locator("[data-hidden-elements]").waitFor({ timeout: 10_000 });
  const readerRows = await reader.locator("[data-hidden-elements] li").count();
  say("a reader can see what is hidden", readerRows === 1, String(readerRows));
  say(
    "…and is offered no way to restore it",
    (await reader.locator("[data-hidden-elements] li button").count()) === 0,
  );
  await readerContext.close();

  /* --- put the fixture back ---------------------------------------------- */
  await sql`update page_sections set draft = null, draft_styles = null,
                   styles = '{"v":1,"nodes":{}}'::jsonb
             where id in (${hero.id}, ${links.id})`;
  say("the fixture is back as it started", (await state(hero.id)).draft_styles === null);
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
