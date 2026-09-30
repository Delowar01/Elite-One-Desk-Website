/**
 * The revision a section screen submits belongs to the values it is showing.
 *
 * Batch 12 release-blocker correction, Blocker B, in a real browser. The state
 * that must never exist is old words beside a new revision: the server compares
 * the number and nothing else, so such a save is accepted and silently
 * overwrites whoever wrote in between. Everything here is about the screen
 * refusing to build that pair — while never throwing away what is typed in it,
 * never merging, and never solving it with a timer.
 */
import type { Page } from "playwright";

import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";
import { AUTOSAVE_QUIET_MS, quietFor } from "../wait";

const PORT = 3726;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("revision_pairing");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);

  const rows = await sql<{ id: number; published: Record<string, unknown> }[]>`
    select s.id, s.published from page_sections s join pages p on p.id = s.page_id
     where p.slug = 'privacy' and s.block_type = 'page-hero' limit 1`;
  const hero = rows[0]!;
  const others = await sql<{ id: number }[]>`
    select s.id from page_sections s join pages p on p.id = s.page_id
     where p.slug = 'privacy' and s.id <> ${hero.id} order by s.position limit 1`;
  const neighbour = others[0]!.id;
  const url = (id: number) => `${server!.origin}/admin/pages/section/${id}`;

  type Row = { revision: number; draft: Record<string, unknown> | null; published: Record<string, unknown> };
  const state = async (id = hero.id): Promise<Row> =>
    (await sql<Row[]>`select revision, draft, published from page_sections where id = ${id}`)[0]!;
  const titleOf = (values: Record<string, unknown> | null): string | null =>
    values ? String((values.title as { en: string }).en) : null;

  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  page.on("dialog", (dialog) => dialog.accept());
  page.on("pageerror", (error) => console.log("   [pageerror]", error.message.slice(0, 140)));

  /** Load a section screen and wait until React has attached to its form. */
  const open = async (id = hero.id) => {
    await page.goto(url(id), { waitUntil: "load" });
    await page.getByRole("button", { name: "Save draft" }).waitFor({ timeout: 20_000 });
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
  const shown = (target: Page = page) =>
    target.$$eval('input[name="expectedRevision"]', (els) =>
      els.map((el) => Number((el as HTMLInputElement).value)),
    );
  const one = async (): Promise<number> => {
    const values = await shown();
    return values.length && values.every((v) => v === values[0]) ? values[0]! : -1;
  };
  /** Wait for the row to move past `previous`, without guessing a duration. */
  const landed = async (previous: number, id = hero.id) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const row = await state(id);
      if (row.revision !== previous) return row;
      await page.waitForTimeout(100);
    }
    return state(id);
  };
  /**
   * Wait until the screen's own revision is `want`, then read it.
   *
   * It waits for the state it is about to assert on rather than sampling after
   * a fixed number of tries, and it is bounded generously: this probe runs in a
   * queue of browsers, and a round trip that takes eight seconds under that load
   * is the machine being busy, not the screen being wrong. Giving up early and
   * returning the stale value reported a screen that had not caught up *yet* as
   * one that never would.
   */
  const settled = async (want: number) => {
    const deadline = Date.now() + 45_000;
    for (;;) {
      const value = await one();
      if (value === want || Date.now() > deadline) return value;
      await page.waitForTimeout(100);
    }
  };
  /** Wait until the field holds `want`, then read it — once, for both verdict
   *  and message. Reading it twice let the two disagree, which is how a screen
   *  catching up between them printed "X vs X" under a FAIL. */
  const fieldSettled = async (want: string | null) => {
    const deadline = Date.now() + 45_000;
    for (;;) {
      const value = await titleBox().inputValue();
      if (value === want || Date.now() > deadline) return value;
      await page.waitForTimeout(100);
    }
  };
  const external = async (words: string, id = hero.id) => {
    await sql`update page_sections
                 set draft = ${sql.json({ ...hero.published, title: { en: words, ar: "" } })}::jsonb,
                     revision = revision + 1
               where id = ${id}`;
  };

  /* --- 1. what is rendered is one server state ------------------------- */
  await open();
  const start = await state();
  const atLoad = await shown();
  say("the screen submits the revision of the words it is showing",
    atLoad.length > 0 && atLoad.every((v) => v === start.revision),
    `${JSON.stringify(atLoad)} vs row ${start.revision}`);
  // A clean section has the editor's hidden input and nothing else: Publish
  // and Discard belong to the draft banner, which is not there yet.
  say("…and that is the only control on a clean section", atLoad.length === 1);

  /* --- 2. its own write moves both together ---------------------------- */
  await titleBox().fill("First edit from this tab");
  await page.getByRole("button", { name: "Save draft" }).click();
  const afterFirst = await landed(start.revision);
  const shownAfterFirst = await settled(afterFirst.revision);
  say("a save of its own moves the revision it submits", shownAfterFirst === afterFirst.revision,
    `${shownAfterFirst} vs row ${afterFirst.revision}`);
  const keptInField = await titleBox().inputValue();
  say("…without rebuilding the fields around the caret",
    keptInField === "First edit from this tab", keptInField);
  // The draft banner has arrived, so Publish and Discard are on screen too —
  // and they name the same revision the editor does, because they read the
  // same held value.
  const banner = await shown();
  say("…and Publish and Discard name it too",
    banner.length === 3 && banner.every((v) => v === afterFirst.revision), JSON.stringify(banner));
  say("…and the words on screen are the words that were stored",
    titleOf(afterFirst.draft) === "First edit from this tab");

  // Which is the point of moving it: the next save is not a conflict.
  await titleBox().fill("Second edit from this tab");
  await page.getByRole("button", { name: "Save draft" }).click();
  const afterSecond = await landed(afterFirst.revision);
  await settled(afterSecond.revision);
  say("…so a second save from the same screen is accepted",
    titleOf(afterSecond.draft) === "Second edit from this tab");
  say("…and no conflict was reported",
    (await page.getByText("changed while you were editing").count()) === 0);

  /* --- 3. somebody else writes ----------------------------------------- */
  const mine = await one();
  await titleBox().fill("Typed here and not yet saved");
  await external("Written by somebody else");
  const theirs = await state();
  await quietFor(page, AUTOSAVE_QUIET_MS, "anything that was going to move this screen's revision — an autosave's answer included — has done so by now");

  const stillMine = await one();
  say("an external write does not move the revision this screen submits", stillMine === mine,
    `${stillMine} vs theirs ${theirs.revision}`);
  const stillTyped = await titleBox().inputValue();
  say("…and does not touch what is typed in the fields",
    stillTyped === "Typed here and not yet saved", stillTyped);

  /* --- 4. the save it makes anyway is refused, and theirs survives ------ */
  await page.getByRole("button", { name: "Save draft" }).click();
  await page.getByText("changed while you were editing", { exact: false }).first()
    .waitFor({ timeout: 20_000 });
  const afterRefusal = await state();
  say("the save is refused rather than overwriting them",
    titleOf(afterRefusal.draft) === "Written by somebody else" &&
      afterRefusal.revision === theirs.revision,
    `${titleOf(afterRefusal.draft)} at ${afterRefusal.revision}`);
  const afterRefusalShown = await one();
  say("…the screen still submits its own revision, not theirs",
    afterRefusalShown === mine, `${afterRefusalShown} vs ${mine}`);
  const survived = await titleBox().inputValue();
  say("…and the unsaved words are still in the field, to copy out",
    survived === "Typed here and not yet saved", survived);

  /* --- 5. a reload is what brings both forward ------------------------- */
  await open();
  const reloaded = await state();
  const reloadedShown = await one();
  const reloadedField = await titleBox().inputValue();
  say("a reload brings the words and the revision forward together",
    reloadedShown === reloaded.revision && reloadedField === "Written by somebody else",
    `${reloadedShown} vs ${reloaded.revision}, field ${reloadedField}`);

  await titleBox().fill("Edited on top of theirs");
  await page.getByRole("button", { name: "Save draft" }).click();
  const afterReload = await landed(reloaded.revision);
  say("…and the save then lands", titleOf(afterReload.draft) === "Edited on top of theirs");

  /* --- 6. a discard replaces both at once ------------------------------ */
  // The screen must be level with the row before the click, or Discard submits
  // a revision the save has already moved past and is refused — which would be
  // the probe testing its own impatience.
  await settled(afterReload.revision);
  await page.getByRole("button", { name: "Discard" }).click();
  const afterDiscard = await landed(afterReload.revision);
  const discardedField = await fieldSettled(titleOf(afterDiscard.published));
  const shownAfterDiscard = await settled(afterDiscard.revision);
  say("a discard puts the published words back",
    discardedField === titleOf(afterDiscard.published),
    `${discardedField} vs ${titleOf(afterDiscard.published)}`);
  say("…carrying the revision those words now have",
    shownAfterDiscard === afterDiscard.revision,
    `${shownAfterDiscard} vs ${afterDiscard.revision}`);

  /* --- 7. a different section is a different screen -------------------- */
  await open(neighbour);
  const other = await state(neighbour);
  const otherShown = await one();
  say("opening another section shows that section's own revision",
    otherShown === other.revision, `${otherShown} vs ${other.revision}`);
  const ids = await page.$$eval('input[name="id"]', (els) =>
    els.map((el) => Number((el as HTMLInputElement).value)),
  );
  say("…and submits that section's id", ids.every((id) => id === neighbour), JSON.stringify(ids));
} finally {
  await server?.stop();
  await sql.end({ timeout: 5 });
  await browser.close();
  dropDatabase(database);
}
