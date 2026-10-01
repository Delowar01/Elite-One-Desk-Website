/** Manual browser acceptance, part two: losing a race, and unsaved work. */

import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { selectFromLayers, waitForInspector } from "../canvas";
import { launchChromium } from "../harness";

const PORT = 3702;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("acceptance2");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);
  const [hero] = await sql<{ id: number }[]>`
    select s.id from page_sections s join pages p on p.id = s.page_id
     where p.slug = 'home' and s.block_type = 'hero' limit 1`;
  const [links] = await sql<{ id: number }[]>`
    select s.id from page_sections s join pages p on p.id = s.page_id
     where p.slug = 'home' and s.block_type = 'quick-links' limit 1`;

  const context = await browser.newContext({ viewport: { width: 1680, height: 1000 } });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  await page.goto(`${server.origin}/admin/visual-editor`, { waitUntil: "domcontentloaded" });
  await page.getByText("Ready", { exact: true }).waitFor({ timeout: 30_000 });

  const frame = () => page.frames().find((f) => f.url().includes("editor=1"))!;
  const lead = frame().locator(`[data-eod-address="section:${hero!.id}/field:lead"]`);
  await lead.waitFor({ timeout: 15_000 });
  await lead.click();

  const box = page.locator('[data-field="lead"] textarea').first();
  await box.waitFor({ timeout: 10_000 });
  await box.fill("Mine.");
  await page.getByText("Unsaved content").waitFor({ timeout: 5000 });

  say("typing is marked unsaved straight away", (await page.getByText("1 unsaved").count()) > 0);

  /* --- unsaved work is protected (19B) ---------------------------- */
  /**
   * While anything is unsaved or still being saved, leaving the editor asks
   * first: the browser's own prompt, armed only while there is something to
   * lose. A synthetic `beforeunload` reaches the same listener the browser
   * calls, and `dispatchEvent` answers false when the listener cancelled it.
   */
  const leaveIsGuarded = () =>
    page.evaluate(() => !window.dispatchEvent(new Event("beforeunload", { cancelable: true })));
  say("19B · leaving with unsaved work asks first", await leaveIsGuarded());

  // An edit belongs to its section's buffer, not to the selection: choosing a
  // node in another section and coming back finds the text where it was left.
  await selectFromLayers(page, `section:${links!.id}`);
  await lead.click();
  const returned = await waitForInspector(page, `section:${hero!.id}/field:lead`);
  say(
    "19B · an edit survives selecting another section and coming back",
    returned === `section:${hero!.id}/field:lead` &&
      (await page.locator('[data-field="lead"] textarea').first().inputValue()) === "Mine.",
    returned,
  );

  /* --- a buffer survives a page change ---------------------------- */
  /**
   * Batch 10 made saving automatic, so "1 unsaved" is now a state that lasts
   * about a second rather than until somebody presses a button. The thing this
   * step has always been about survives the change: an edit made on one page
   * is still that page's edit after going somewhere else and coming back.
   */
  await page.getByText("Draft saved", { exact: true }).waitFor({ timeout: 20_000 });
  await page.getByText("Ready", { exact: true }).waitFor({ timeout: 30_000 });
  say("19B · once everything is saved, leaving asks nothing", !(await leaveIsGuarded()));

  await page.selectOption("#ve-page", "about");
  await page.getByText("Ready", { exact: true }).waitFor({ timeout: 30_000 });
  await page.selectOption("#ve-page", "home");
  await page.getByText("Ready", { exact: true }).waitFor({ timeout: 30_000 });
  const back = frame().locator(`[data-eod-address="section:${hero!.id}/field:lead"]`);
  await back.waitFor({ timeout: 15_000 });
  await back.click();
  await page.locator('[data-field="lead"] textarea').first().waitFor({ timeout: 10_000 });
  say(
    "and the text is still there when you come back",
    (await page.locator('[data-field="lead"] textarea').first().inputValue()) === "Mine.",
  );

  /* --- somebody else saves first ---------------------------------- */
  await sql`update page_sections
               set draft = jsonb_set(coalesce(draft, published), '{lead,en}', '"Theirs."'),
                   revision = revision + 1
             where id = ${hero!.id}`;

  // Make the panel dirty again, so it has something to lose the race with.
  await page.locator('[data-field="lead"] textarea').first().fill("Mine, written later.");
  await page.getByText("Somebody else saved first").waitFor({ timeout: 25_000 });
  say("a lost race is reported, not silently won", true);
  say(
    "there is no “save anyway”",
    (await page.getByRole("button", { name: /save anyway/i }).count()) === 0,
  );

  const [afterRefusal] = await sql<{ lead: string }[]>`
    select draft->'lead'->>'en' as lead from page_sections where id = ${hero!.id}`;
  say("the other version is still the stored one", afterRefusal!.lead === "Theirs.", afterRefusal!.lead);

  /* --- taking the version that won -------------------------------- */
  await page.getByRole("button", { name: "Reload latest" }).click();
  await page.getByText("Ready", { exact: true }).waitFor({ timeout: 30_000 });
  const reloaded = frame().locator(`[data-eod-address="section:${hero!.id}/field:lead"]`);
  await reloaded.waitFor({ timeout: 15_000 });
  say("the canvas shows their version", (await reloaded.innerText()).includes("Theirs."));
  say("and nothing is left marked unsaved", (await page.getByText(/\d+ unsaved/).count()) === 0);

  await reloaded.click();
  await page.locator('[data-field="lead"] textarea').first().waitFor({ timeout: 10_000 });
  const adopted = await page.locator('[data-field="lead"] textarea').first().inputValue();
  say("the panel adopted it too", adopted === "Theirs.", adopted);

  /* --- saving on top of theirs now works -------------------------- */
  await page.locator('[data-field="lead"] textarea').first().fill("Ours, after reading theirs.");
  await page.getByText("Draft saved", { exact: true }).waitFor({ timeout: 25_000 });
  const [final] = await sql<{ lead: string; revision: number }[]>`
    select draft->'lead'->>'en' as lead, revision from page_sections where id = ${hero!.id}`;
  say("and the redone edit lands", final!.lead === "Ours, after reading theirs.", final!.lead);

  await context.close();
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
