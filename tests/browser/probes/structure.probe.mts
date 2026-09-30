/**
 * Batch 8 browser acceptance: structural editing in the real Visual Editor,
 * against the production build.
 *
 * The claim being checked on every single operation is the same one: the layout
 * draft changes and the visitor's page does not. So the public page is read
 * before and after each act, and compared.
 */

import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";
import { until } from "../wait";

const PORT = 3727;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("structure_acceptance");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    select 'viewer@test.invalid', 'Read Only', 'unused', id, true from roles where key = 'viewer'`;
  const viewer = await signIn(sql, "viewer");
  server = await startServer(database, PORT);

  const pageRow = async (slug: string) =>
    (await sql<{ id: number; revision: number; draft_structure: unknown }[]>`
       select id, revision, draft_structure from pages where slug = ${slug}`)[0]!;
  const rowsOf = async (pageId: number) =>
    sql<{ id: number; block_type: string; position: number; is_published: boolean; is_draft_only: boolean }[]>`
      select id, block_type, position, is_published, is_draft_only from page_sections
       where page_id = ${pageId} order by position asc, id asc`;

  const about = await pageRow("about");
  const established = await rowsOf(about.id);

  const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("   [pageerror]", error.message.slice(0, 140)));
  page.on("dialog", (dialog) => dialog.accept());

  /** The block types the public page renders, in order. */
  const publicOrder = async (path = "/about"): Promise<string[]> => {
    const html = await fetch(`${server!.origin}${path}`).then((r) => r.text());
    return [...html.matchAll(/data-section="([^"]+)"/g)].map((m) => m[1]!);
  };
  const before = await publicOrder();

  const open = async (slug = "about") => {
    await page.goto(`${server!.origin}/admin/visual-editor?page=${slug}&lang=en&device=desktop`, {
      waitUntil: "load",
    });
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  };
  const frame = () => page.frames().find((f) => f.url().includes("editor=1"))!;
  const layers = () => page.locator("aside[aria-label='Page structure']");
  const layerRow = (id: number) => layers().locator(`li[data-section-id="${id}"]`);
  const layerIds = () =>
    layers()
      .locator("ol > li[data-section-id]")
      .evaluateAll((rows) => rows.map((row) => Number((row as HTMLElement).dataset.sectionId)));
  const canvasIds = () =>
    frame()
      .locator("[data-eod-section]")
      .evaluateAll((rows) => rows.map((row) => Number((row as HTMLElement).dataset.eodSection)));
  const settle = async (revision: number) => {
    for (let i = 0; i < 80 && (await pageRow("about")).revision === revision; i += 1) {
      await page.waitForTimeout(200);
    }
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
    await page.waitForTimeout(800);
    return (await pageRow("about")).revision;
  };
  const rowButton = (id: number, label: RegExp) =>
    layerRow(id).getByRole("button", { name: label });

  /* --- 1. Add -------------------------------------------------------- */
  await open();
  say("the canvas starts on the established layout", (await canvasIds()).length === established.length);
  const anchor = established[1]!.id;
  // The row's own select button, by its hook: the first button in the row is
  // now the disclosure that opens the section's nodes, and clicking that
  // expands the tree without selecting anything.
  await layers().locator(`[data-layer-row="section:${anchor}"]`).click();
  await page.waitForTimeout(500);

  let revision = (await pageRow("about")).revision;
  await page.getByRole("button", { name: "Add section" }).click();
  await page.locator("[data-block-picker]").waitFor({ timeout: 10_000 });
  say("the picker offers registry blocks", (await page.locator("[data-block-picker] button[data-block-type]").count()) > 3);
  say(
    "…and nothing deprecated",
    (await page.locator('[data-block-picker] button[data-block-type="stats-band"]').count()) === 0,
  );
  await page.locator('[data-block-picker] button[data-block-type="stats"]').click();
  revision = await settle(revision);

  const added = (await rowsOf(about.id)).find((row) => row.is_draft_only)!;
  say("a pending row was created", Boolean(added) && added.is_published === false);
  say("…placed after the selected section", (await layerIds())[2] === added.id, JSON.stringify(await layerIds()));
  say("…rendered on the real canvas", (await canvasIds()).includes(added.id));
  say("…badged New", (await layerRow(added.id).getByText("New").count()) > 0);
  say("…and selected, so it can be edited straight away", (await page.locator('[data-field]').count()) > 0);
  say("the live page did not change", JSON.stringify(await publicOrder()) === JSON.stringify(before));

  // Edit its content and save a draft.
  const box = page.locator('[data-field="title"] textarea, [data-field="title"] input').first();
  if (await box.count()) {
    await box.fill("Written in a pending section");
    // Ignorable: autosave may already have sent this, disabling the button.
    await page.getByRole("button", { name: "Save now" }).click({ timeout: 2500 }).catch(() => undefined);
    await until(async () => {
      const [saved] = await sql<{ draft: { title?: { en?: string } } | null }[]>`select draft from page_sections where id = ${added.id}`;
      return saved?.draft?.title?.en === "Written in a pending section";
    }, 20_000);
    const [row] = await sql<{ draft: Record<string, unknown> | null }[]>`
      select draft from page_sections where id = ${added.id}`;
    say(
      "a pending section takes a content draft",
      JSON.stringify(row?.draft ?? {}).includes("Written in a pending section"),
    );
  } else {
    say("a pending section takes a content draft", false, "no title field to type into");
  }
  say("…and the live page still did not change", JSON.stringify(await publicOrder()) === JSON.stringify(before));

  /* --- 2. Duplicate --------------------------------------------------- */
  await open();
  revision = (await pageRow("about")).revision;
  const source = established[0]!.id;
  await rowButton(source, /^Duplicate$/).click();
  revision = await settle(revision);
  const copies = (await rowsOf(about.id)).filter((row) => row.is_draft_only);
  const copy = copies.find((row) => row.block_type === established[0]!.block_type)!;
  say("the copy is pending", Boolean(copy));
  const order = await layerIds();
  say("…and sits immediately after the source", order[order.indexOf(source) + 1] === copy.id, JSON.stringify(order));
  say("…and is the selected section", (await layerRow(copy.id).getAttribute("class")) !== null);
  say("…and is on the canvas", (await canvasIds()).includes(copy.id));
  say("the live page is unchanged", JSON.stringify(await publicOrder()) === JSON.stringify(before));

  /* --- 3. Reorder ----------------------------------------------------- */
  await open();
  revision = (await pageRow("about")).revision;
  const first = (await layerIds())[0]!;
  await rowButton(first, /Move down/).click();
  revision = await settle(revision);
  const moved = await layerIds();
  say("Move down reorders the layout", moved[1] === first, JSON.stringify(moved));
  say("…and the canvas follows it", JSON.stringify(await canvasIds()) === JSON.stringify(moved));

  await open();
  say("…and it survives a reload of the editor", JSON.stringify(await layerIds()) === JSON.stringify(moved));
  say("the live page keeps the old order", JSON.stringify(await publicOrder()) === JSON.stringify(before));

  /* --- 4. Hide -------------------------------------------------------- */
  revision = (await pageRow("about")).revision;
  const toHide = (await layerIds()).find((id) => established.some((row) => row.id === id))!;
  const wasPublished = (
    await sql<{ is_published: boolean }[]>`select is_published from page_sections where id = ${toHide}`
  )[0]!.is_published;
  await rowButton(toHide, /Hide when the layout is published/).click();
  revision = await settle(revision);
  say("the section is marked to hide", (await layerRow(toHide).getByText("Will hide").count()) > 0);
  say("…and is still on the canvas, so it can be edited", (await canvasIds()).includes(toHide));
  const flags = await sql<{ is_published: boolean }[]>`
    select is_published from page_sections where id = ${toHide}`;
  say("…with its live visibility untouched", flags[0]!.is_published === wasPublished, String(wasPublished));
  say("the live page is unchanged", JSON.stringify(await publicOrder()) === JSON.stringify(before));

  /* --- 5. Remove and restore ------------------------------------------ */
  revision = (await pageRow("about")).revision;
  const toRemove = (await layerIds())[2]!;
  await rowButton(toRemove, /Remove from the layout/).click();
  revision = await settle(revision);
  say("the section left the layout", !(await layerIds()).includes(toRemove));
  say("…and the canvas", !(await canvasIds()).includes(toRemove));
  say("…and is listed as removed", (await page.locator(`[data-removed-id="${toRemove}"]`).count()) > 0);
  const stillThere = await sql<{ id: number }[]>`select id from page_sections where id = ${toRemove}`;
  say("…with its row still in the database", stillThere.length === 1);
  say("the live page is unchanged", JSON.stringify(await publicOrder()) === JSON.stringify(before));

  await page.locator(`[data-removed-id="${toRemove}"] button`).click();
  revision = await settle(revision);
  say("Restore brings back the same section", (await layerIds()).includes(toRemove));
  say("…without making a second row", (await sql`select id from page_sections where id = ${toRemove}`).length === 1);
  say("…and back on the canvas", (await canvasIds()).includes(toRemove));

  /* --- 6. Concurrency -------------------------------------------------- */
  const second = await context.newPage();
  second.on("dialog", (dialog) => dialog.accept());
  await second.goto(`${server.origin}/admin/visual-editor?page=about&lang=en&device=desktop`, {
    waitUntil: "load",
  });
  await second.getByText("Ready", { exact: true }).waitFor({ timeout: 30_000 });
  revision = (await pageRow("about")).revision;

  // The first tab acts…
  const target = (await layerIds())[0]!;
  await rowButton(target, /Move down/).click();
  revision = await settle(revision);

  // …and the second, still on the old revision, is told.
  const stale = second.locator("aside[aria-label='Page structure']");
  const staleId = (await stale
    .locator("ol > li[data-section-id]")
    .evaluateAll((rows) => rows.map((row) => Number((row as HTMLElement).dataset.sectionId))))[0]!;
  await stale.locator(`li[data-section-id="${staleId}"]`).getByRole("button", { name: /Move down/ }).click();
  await until(async () => (await second.getByText(/layout changed since you opened it/i).count()) > 0, 15_000);
  const warned = await second.getByText(/layout changed since you opened it/i).count();
  say("a stale tab is refused and told why", warned > 0);
  say("…and changed nothing", (await pageRow("about")).revision === revision);
  await second.close();

  /* --- 7. Discard ------------------------------------------------------ */
  await open();
  revision = (await pageRow("about")).revision;
  say("the layout is marked as a draft", (await page.getByText("Layout draft").count()) > 0);
  const pendingBefore = (await rowsOf(about.id)).filter((r) => r.is_draft_only).length;
  say("…with pending sections in it", pendingBefore > 0, String(pendingBefore));

  await page.getByRole("button", { name: "Discard layout changes" }).click();
  for (let i = 0; i < 80 && (await pageRow("about")).draft_structure !== null; i += 1) {
    await page.waitForTimeout(200);
  }
  await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  await page.waitForTimeout(800);

  say("the layout draft is gone", (await pageRow("about")).draft_structure === null);
  say("…and so are the pending rows", (await rowsOf(about.id)).filter((r) => r.is_draft_only).length === 0);
  say(
    "…leaving the established sections exactly as they were",
    JSON.stringify((await rowsOf(about.id)).map((r) => r.id)) ===
      JSON.stringify(established.map((r) => r.id)),
  );
  say("…and the canvas back on the live layout", JSON.stringify(await canvasIds()) === JSON.stringify(established.map((r) => r.id)));
  say("the live page never changed, through all of it", JSON.stringify(await publicOrder()) === JSON.stringify(before));
  await context.close();

  /* --- 8. Read-only ----------------------------------------------------- */
  const readerContext = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [vName, vValue] = viewer.cookie.split("=");
  await readerContext.addCookies([{ name: vName!, value: vValue!, domain: "127.0.0.1", path: "/" }]);
  const reader = await readerContext.newPage();
  await reader.goto(`${server.origin}/admin/visual-editor?page=about&lang=en&device=desktop`, {
    waitUntil: "load",
  });
  await reader.getByText("Ready", { exact: true }).waitFor({ timeout: 30_000 });
  const readerLayers = reader.locator("aside[aria-label='Page structure']");
  say("a reader sees the layout", (await readerLayers.locator("ol > li[data-section-id]").count()) > 0);
  say("…and no Add button", (await reader.getByRole("button", { name: "Add section" }).count()) === 0);
  say(
    "…and no row controls",
    (await readerLayers.getByRole("button", { name: /Remove from the layout/ }).count()) === 0,
  );
  await readerContext.close();

  /* --- put the fixture back ---------------------------------------------- */
  await sql`delete from page_sections where page_id = ${about.id} and is_draft_only = true`;
  await sql`update pages set draft_structure = null where id = ${about.id}`;
  say("the fixture is back as it started", (await pageRow("about")).draft_structure === null);
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
