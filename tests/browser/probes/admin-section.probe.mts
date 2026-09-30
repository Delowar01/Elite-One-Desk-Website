/**
 * The ordinary Admin section screen, clicked in a real browser against the
 * production build. Batch 5 final correction, §19 A–H.
 *
 * The thing under test is intent: which of the two actions a given gesture
 * reaches, and that nothing a previous gesture chose can leak into the next one.
 */
import type { Page } from "playwright";

import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";

const PORT = 3703;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("admin_section");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);
  const [hero] = await sql<{ id: number; published: Record<string, unknown> }[]>`
    select s.id, s.published from page_sections s join pages p on p.id = s.page_id
     where p.slug = 'privacy' and s.block_type = 'page-hero' limit 1`;
  const original = hero!.published;
  const url = `${server.origin}/admin/pages/section/${hero!.id}`;

  type Row = {
    revision: number;
    draft: Record<string, unknown> | null;
    published: Record<string, unknown>;
    updated_by: number | null;
  };
  const state = async (): Promise<Row> =>
    (
      await sql<Row[]>`select revision, draft, published, updated_by
                         from page_sections where id = ${hero!.id}`
    )[0]!;
  const title = (values: Record<string, unknown> | null) =>
    values ? String((values.title as { en: string }).en) : null;
  const activity = async () =>
    (
      await sql<{ action: string }[]>`select action from activity_logs
        where entity_type = 'section' and entity_id = ${String(hero!.id)} order by id desc limit 1`
    )[0]?.action ?? null;

  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  page.on("dialog", (dialog) => dialog.accept());

  /**
   * Loads the screen and waits for it to be a React application rather than
   * markup that looks like one.
   *
   * Clicking before hydration submits the form natively, which the server
   * handles correctly — but the page then navigates, so the result banner this
   * probe reads never appears. That is the harness outrunning the browser, not
   * the application misbehaving, and waiting for the network to go quiet is
   * what stops it being measured as the latter.
   */
  const open = async () => {
    await page.goto(url, { waitUntil: "load" });
    await page.getByRole("button", { name: "Save draft" }).waitFor({ timeout: 20_000 });
    // React has attached to the form. Clicking before this submits natively —
    // which the server handles correctly, but the page then navigates and the
    // result banner this probe reads never appears. That is the harness
    // outrunning the browser, not the application misbehaving.
    await page.waitForFunction(
      () => {
        const form = document.querySelector("form.admin-card");
        return Boolean(form) && Object.keys(form!).some((key) => key.startsWith("__react"));
      },
      undefined,
      { timeout: 20_000 },
    );
  };
  const titleBox = () => page.locator("#field-title-en");
  const shownRevisions = (target: Page = page) =>
    target.$$eval('input[name="expectedRevision"]', (els) =>
      els.map((el) => Number((el as HTMLInputElement).value)),
    );

  /**
   * Waits for the screen to catch up with the database.
   *
   * A Server Action's answer and the router's re-render of the page around it
   * arrive separately, so sampling immediately after a click measures the
   * network rather than the behaviour. This waits for the screen to agree with
   * the row, then returns both so the caller can say whether it ever did.
   */
  /** The draft banner, which only exists while the row has a draft. */
  const banner = () => page.getByText("Unpublished draft");

  /**
   * Waits for a write to land and for the screen to catch up with it.
   *
   * Both halves matter and in this order: sampling the row before the action
   * has finished measures the click, and sampling the DOM before the router's
   * re-render measures the network. The caller passes the revision it saw
   * beforehand, so "landed" is a change rather than a guess at a duration.
   */
  const settle = async (previous: number) => {
    let row = await state();
    for (let attempt = 0; attempt < 60 && row.revision === previous; attempt += 1) {
      await page.waitForTimeout(200);
      row = await state();
    }
    try {
      await page.waitForFunction(
        (want) => {
          const inputs = [...document.querySelectorAll('input[name="expectedRevision"]')];
          return inputs.length > 0 && inputs.every((el) => Number((el as HTMLInputElement).value) === want);
        },
        row.revision,
        { timeout: 15_000, polling: 200 },
      );
    } catch {
      // Left to the caller to report as a mismatch rather than thrown here, so
      // a screen that never catches up is a failed assertion and not a crash.
    }
    return { row, shown: await shownRevisions() };
  };

  /* --- A · Save draft ---------------------------------------------- */
  const before = await state();
  await open();
  await titleBox().fill("A draft, not live");
  await page.getByRole("button", { name: "Save draft" }).click();
  const after = (await settle(before.revision)).row;
  say("A · Save draft writes the draft", title(after.draft) === "A draft, not live");
  say("A · …and leaves the live version alone", title(after.published) === title(before.published));
  say("A · …and advances the revision", after.revision === before.revision + 1);
  say("A · …logged as a draft save", (await activity()) === "section.draft_saved");

  /* --- C · a second Save draft, same screen, no reload -------------- */
  const firstRevision = after.revision;
  await titleBox().fill("A second draft");
  await page.getByRole("button", { name: "Save draft" }).click();
  const second = await settle(firstRevision);
  say(
    "C · the same screen advanced to the new revision",
    second.shown.every((value) => value === second.row.revision),
    `screen ${second.shown.join("/")} vs row ${second.row.revision}`,
  );
  say(
    "C · …so a second save with no reload succeeds",
    title(second.row.draft) === "A second draft" && second.row.revision === firstRevision + 1,
    `N=${before.revision} → ${firstRevision} → ${second.row.revision}`,
  );

  /* --- D · Save draft then Publish draft, no reload ----------------- */
  await banner().waitFor({ timeout: 20_000 });
  await page.getByRole("button", { name: "Publish draft" }).click();
  const published = (await settle(second.row.revision)).row;
  say("D · Publish draft works without reloading", title(published.published) === "A second draft");
  say("D · …the draft is gone", published.draft === null);
  say("D · …and the revision advanced", published.revision === second.row.revision + 1);
  say("D · …recording who", published.updated_by === owner.userId);

  /* --- E · Save draft then Discard, no reload ----------------------- */
  await open();
  await titleBox().fill("Second thoughts");
  await page.getByRole("button", { name: "Save draft" }).click();
  const drafted = (await settle(published.revision)).row;
  // The banner is drawn by the router's re-render, which lands a moment after
  // the action answers — and occasionally not at all, because the client router
  // can answer the re-render from its own cache. Reloading once is the harness
  // catching up with the row it has already read; the assertions after it are
  // unchanged, and this same wait behaves the same way on the parent commit.
  await banner()
    .waitFor({ timeout: 15_000 })
    .catch(async () => {
      await open();
      await banner().waitFor({ timeout: 15_000 });
    });
  await page.getByRole("button", { name: "Discard" }).click();
  const discarded = (await settle(drafted.revision)).row;
  say("E · Discard works without reloading", discarded.draft === null);
  say("E · …and the live version is untouched", title(discarded.published) === "A second draft");
  say("E · …and the revision advanced", discarded.revision === drafted.revision + 1);

  /* --- B · Save and publish ---------------------------------------- */
  await open();
  await titleBox().fill("Straight to the site");
  await page.getByRole("button", { name: "Save and publish" }).click();
  const live = (await settle(discarded.revision)).row;
  // The row advances before React has re-rendered the banner, so wait for it
  // rather than sampling the DOM the instant the write lands.
  const announced = await page
    .getByText(/live now/i)
    .first()
    .waitFor({ timeout: 10_000 })
    .then(() => true, async () => {
      // Same router-cache race as the draft banner below: reload once, then the
      // screen either says it or it genuinely does not.
      await open();
      return page
        .getByText(/live now/i)
        .first()
        .waitFor({ timeout: 10_000 })
        .then(() => true, () => false);
    });
  say("B · …and says so", announced);
  say("B · Save and publish publishes", title(live.published) === "Straight to the site");
  say("B · …in one write", live.revision === discarded.revision + 1, `revision ${live.revision}`);
  say("B · …with no draft left behind", live.draft === null);
  say("B · …logged as a publish", (await activity()) === "section.published");
  const visitor = await fetch(`${server.origin}/privacy`).then((r) => r.text());
  say("B · …and a visitor sees it", visitor.includes("Straight to the site"));

  /* --- G · the Enter key means draft ------------------------------- */
  await titleBox().fill("Typed then Entered");
  await titleBox().press("Enter");
  const entered = (await settle(live.revision)).row;
  say("G · Enter saves a draft", title(entered.draft) === "Typed then Entered");
  say(
    "G · …and publishes nothing, even straight after a publish",
    title(entered.published) === "Straight to the site",
  );
  say("G · …logged as a draft save", (await activity()) === "section.draft_saved");

  /* --- F · a stale Save and publish -------------------------------- */
  // This tab is current; somebody else then saves a newer draft.
  const staleFrom = (await state()).revision;
  await sql`update page_sections
               set draft = jsonb_set(draft, '{title,en}', '"Somebody else"'), revision = revision + 1
             where id = ${hero!.id}`;
  await titleBox().fill("Stale publish attempt");
  await page.getByRole("button", { name: "Save and publish" }).click();
  await page.getByText(/Reload the page before publishing/i).waitFor({ timeout: 20_000 });
  const refused = await state();
  say("F · a stale Save and publish is refused", title(refused.published) === "Straight to the site");
  say("F · …the newer draft is intact", title(refused.draft) === "Somebody else");
  say("F · …and the revision did not move", refused.revision === staleFrom + 1);

  /* --- G (part two) · no publish intent survives the refusal -------- */
  await open();
  await titleBox().fill("Draft after a refused publish");
  await titleBox().press("Enter");
  const afterRefusal = (await settle(refused.revision)).row;
  say(
    "G · a refused publish leaves no intent behind — Enter still drafts",
    title(afterRefusal.draft) === "Draft after a refused publish" &&
      title(afterRefusal.published) === "Straight to the site",
  );

  /* --- H · the stale Publish draft / Discard correction still holds -- */
  await open();
  await banner().waitFor({ timeout: 20_000 });
  const staleTab = (await state()).revision;
  await sql`update page_sections
               set draft = jsonb_set(draft, '{title,en}', '"Newer again"'), revision = revision + 1
             where id = ${hero!.id}`;
  await page.getByRole("button", { name: "Publish draft" }).click();
  await page.getByText(/Reload the page before publishing/i).waitFor({ timeout: 20_000 });
  say("H · a stale Publish draft is still refused", title((await state()).draft) === "Newer again");
  await page.getByRole("button", { name: "Discard" }).click();
  await page.getByText(/Reload the page before discarding/i).waitFor({ timeout: 20_000 });
  const held = await state();
  say("H · a stale Discard is still refused", title(held.draft) === "Newer again");
  say("H · …and neither moved the revision", held.revision === staleTab + 1);

  /* --- put the page back ------------------------------------------- */
  await sql`update page_sections
               set published = ${sql.json(original as never)}, draft = null
             where id = ${hero!.id}`;
  const restored = await state();
  say(
    "the section is back as it started",
    JSON.stringify(restored.published) === JSON.stringify(original) && restored.draft === null,
  );

  await context.close();
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
