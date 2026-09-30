/**
 * Batch 11 acceptance: the Globals drawer's navigation half, in a browser.
 *
 * The promise: a menu edited beside the canvas is live the moment it saves,
 * the canvas shows it, the ordinary Navigation screen shows the same rows —
 * and the page on the canvas is untouched: its drafts still pending, its
 * revisions where they were, its history empty.
 */

import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";

const PORT = 3709;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("globals_nav_probe");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);

  const [about] = await sql<{ id: number }[]>`select id from pages where slug = 'about'`;
  const sections = await sql<{ id: number }[]>`
    select id from page_sections where page_id = ${about!.id} order by position, id`;
  const hero = sections[0]!.id;

  /** Pending work of all four kinds, so a global save has something to damage. */
  await sql`update page_sections
               set draft = ${sql.json({ title: { en: "Pending words", ar: "" } })}::jsonb,
                   draft_styles = ${sql.json({ v: 1, breakpoints: {} })}::jsonb,
                   draft_animation = 'fade'
             where id = ${hero}`;
  await sql`update pages
               set draft_structure = ${sql.json({
                 v: 1,
                 sections: sections.map((row, index) => ({
                   id: row.id,
                   position: index,
                   isPublished: true,
                 })),
               })}::jsonb
             where id = ${about!.id}`;

  const pageState = async () => {
    const [page] = await sql<{ revision: number; draft_structure: unknown }[]>`
      select revision, draft_structure from pages where id = ${about!.id}`;
    const rows = await sql<
      { id: number; revision: number; draft: unknown; draft_styles: unknown; draft_animation: unknown }[]
    >`select id, revision, draft, draft_styles, draft_animation
        from page_sections where page_id = ${about!.id} order by id`;
    const [count] = await sql<{ n: number }[]>`select count(*)::int as n from page_versions`;
    return JSON.stringify({ page, rows, versions: count!.n });
  };
  const before = await pageState();

  const navRows = () =>
    sql<{
      id: number;
      menu: string;
      parent_id: number | null;
      label_en: string;
      sort_order: number;
      is_published: boolean;
    }[]>`
      select id, menu, parent_id, label_en, sort_order, is_published
        from navigation_items order by menu, sort_order, id`;

  /** Poll the database until it says what we are waiting for, or give up. */
  const until = async (what: () => Promise<boolean>, ms = 15_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await what()) return true;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 250));
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
    await drawer().getByRole("button", { name: "Header menu" }).waitFor({ timeout: 20_000 });
  };
  const visitorHtml = async (path = "/") => {
    const visitor = await browser.newContext();
    const page = await visitor.newPage();
    await page.goto(`${server!.origin}${path}`, { waitUntil: "load" });
    const html = await page.content();
    await visitor.close();
    return html;
  };
  const canvasHtml = async () => {
    const frame = editor.frameLocator("iframe[title]");
    await frame.locator("header").first().waitFor({ timeout: 30_000 });
    return (await editor.locator("iframe[title]").elementHandle())!
      .contentFrame()
      .then((f) => f!.content());
  };

  /* --- 1. the drawer is there, and says what it is --------------------- */
  await openGlobals();
  say(
    "the drawer warns that globals are live, once",
    (await drawer().getByText(/saved directly to the live site/).count()) === 1,
  );
  say(
    "…and says they are not part of page History",
    (await drawer().getByText(/not part of this page.s drafts or Version History/).count()) === 1,
  );

  /* --- 2. renaming a header link --------------------------------------- */
  const rowsBefore = await navRows();
  const target = rowsBefore.find((row) => row.menu === "header" && row.is_published)!;
  const item = drawer().locator("li", { hasText: target.label_en }).first();
  await item.getByRole("button", { name: "Edit" }).first().click();
  const label = drawer().locator('input[name="labelEn"]').first();
  await label.waitFor({ timeout: 10_000 });
  await label.fill("Renamed Live");
  say("the form says it is not saved yet", (await drawer().getByText("Not saved yet").count()) > 0);
  await drawer().getByRole("button", { name: "Save link" }).first().click();
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  await editor.waitForTimeout(600);

  const [renamed] = await sql<{ label_en: string }[]>`
    select label_en from navigation_items where id = ${target.id}`;
  say("the link is renamed in the database", renamed!.label_en === "Renamed Live");

  const canvas = await canvasHtml();
  say("the canvas reloaded and shows it", canvas.includes("Renamed Live"));
  say("a visitor sees it too", (await visitorHtml()).includes("Renamed Live"));

  /* --- 3. …and the page beside it is untouched ------------------------- */
  say("no page draft, revision or version moved", (await pageState()) === before);

  /* --- 4. reorder, hide, add, delete ------------------------------------ */
  await openGlobals();
  const roots = (await navRows()).filter((row) => row.menu === "header" && row.parent_id === null);
  const first = roots[0]!;
  const second = roots[1]!;
  await drawer()
    .locator("li", { hasText: second.label_en })
    .first()
    .getByRole("button", { name: `Move ${second.label_en} up`, exact: true })
    .click();
  const orderOf = async (id: number) =>
    (await sql<{ sort_order: number }[]>`select sort_order from navigation_items where id = ${id}`)[0]!
      .sort_order;
  const swapped = await until(async () => (await orderOf(second.id)) < (await orderOf(first.id)));
  say(
    "moving a link up swaps it with its neighbour",
    swapped,
    `${await orderOf(second.id)} vs ${await orderOf(first.id)}`,
  );
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });

  await openGlobals();
  const hideTarget = (await navRows()).find(
    (row) => row.menu === "header" && row.parent_id === null && row.is_published && row.id !== second.id,
  )!;
  const hideRow = drawer().locator("li", { hasText: hideTarget.label_en }).first();
  await hideRow.getByRole("button", { name: "Edit", exact: true }).click();
  const hideForm = hideRow.locator("form");
  await hideForm.locator('input[name="isPublished"]').waitFor({ timeout: 10_000 });
  await hideForm.locator('input[name="isPublished"]').uncheck();
  await hideForm.getByRole("button", { name: "Save link" }).click();
  const isHidden = await until(async () =>
    (await sql<{ is_published: boolean }[]>`
      select is_published from navigation_items where id = ${hideTarget.id}`)[0]!.is_published === false,
  );
  say("hiding a link takes it off the site", isHidden);
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  say(
    "…and a visitor no longer sees it",
    !(await visitorHtml()).includes(`>${hideTarget.label_en}<`),
  );

  await openGlobals();
  await drawer().getByRole("button", { name: "Add a link" }).click();
  const addForm = drawer().locator("form", { hasText: "New link" });
  await addForm.locator('input[name="labelEn"]').fill("Brand New");
  await addForm.locator('input[name="href"]').fill("/contact");
  await addForm.getByRole("button", { name: "Add link" }).click();
  const created = await until(async () =>
    (await sql<{ id: number }[]>`select id from navigation_items where label_en = 'Brand New'`).length === 1,
  );
  say("a new link is added at the end of its menu", created);
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });

  await openGlobals();
  await drawer()
    .locator("li", { hasText: "Brand New" })
    .first()
    .getByRole("button", { name: "Delete Brand New", exact: true })
    .click();
  const removed = await until(async () =>
    (await sql<{ id: number }[]>`select id from navigation_items where label_en = 'Brand New'`).length === 0,
  );
  say("…and deleting it removes it", removed);
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });

  /* --- 4b. the arrows belong to the sibling group ----------------------- */
  /**
   * A child sits below several rows in the flat list its menu is drawn as, so
   * an index taken from that list said it had somewhere to go. It has one
   * sibling group of one, and the server would have found nothing to swap with
   * while the drawer reported a save.
   */
  await openGlobals();
  const parent = (await navRows()).find(
    (row) => row.menu === "header" && row.parent_id === null,
  )!;
  await drawer().getByRole("button", { name: "Add a link" }).click();
  const childForm = drawer().locator("form", { hasText: "New link" });
  await childForm.locator('input[name="labelEn"]').fill("Sole child");
  await childForm.locator('input[name="href"]').fill("/about");
  await childForm.locator('select[name="parentId"]').selectOption(String(parent.id));
  await childForm.getByRole("button", { name: "Add link" }).click();
  const childMade = await until(async () =>
    (await sql<{ id: number }[]>`select id from navigation_items where label_en = 'Sole child'`)
      .length === 1,
  );
  say("a header child can be added from the drawer", childMade);
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });

  await openGlobals();
  const siblings = (await navRows()).filter((row) => row.parent_id === parent.id);
  const firstChild = siblings[0]!;
  const lastChild = siblings[siblings.length - 1]!;
  const rowFor = (label: string) => drawer().locator("li", { hasText: label }).first();
  say(
    "the first child cannot be moved up, though it is well down the flat list",
    await rowFor(firstChild.label_en)
      .getByRole("button", { name: `Move ${firstChild.label_en} up`, exact: true })
      .isDisabled(),
    `${siblings.length} sibling(s)`,
  );
  say(
    "…and the last child cannot be moved down",
    await rowFor(lastChild.label_en)
      .getByRole("button", { name: `Move ${lastChild.label_en} down`, exact: true })
      .isDisabled(),
  );
  if (siblings.length > 1) {
    say(
      "…while a middle or later child can still move up",
      !(await rowFor(lastChild.label_en)
        .getByRole("button", { name: `Move ${lastChild.label_en} up`, exact: true })
        .isDisabled()),
    );
  }
  const rootsNow = (await navRows()).filter(
    (row) => row.menu === "header" && row.parent_id === null,
  );
  const lastRoot = rootsNow[rootsNow.length - 1]!;
  say(
    "…while the last top-level link can still be moved up",
    !(await drawer()
      .locator("li", { hasText: lastRoot.label_en })
      .first()
      .getByRole("button", { name: `Move ${lastRoot.label_en} up`, exact: true })
      .isDisabled()),
  );

  await rowFor("Sole child")
    .getByRole("button", { name: "Delete Sole child", exact: true })
    .click();
  say(
    "…and it can be removed again",
    await until(async () =>
      (await sql<{ id: number }[]>`select id from navigation_items where label_en = 'Sole child'`)
        .length === 0,
    ),
  );
  await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });

  /* --- 5. page state, again, after all of that -------------------------- */
  say("still no page draft, revision or version moved", (await pageState()) === before);

  /* --- 6. the ordinary Navigation screen agrees ------------------------- */
  const admin = await context.newPage();
  await admin.goto(`${server.origin}/admin/navigation`, { waitUntil: "load" });
  const adminHtml = await admin.content();
  say("the normal Navigation screen shows the renamed link", adminHtml.includes("Renamed Live"));
  say("…and does not show the deleted one", !adminHtml.includes("Brand New"));
  await admin.close();
} finally {
  await browser.close();
  if (server) await server.stop();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
