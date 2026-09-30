/** Batch 4 behaviours, re-checked after the shell gained an editor. */

import { canvasStill, waitForInspector } from "../canvas";
import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";
import { quietFor } from "../wait";

const PORT = 3722;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("regression4");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);
  const [hero] = await sql<{ id: number }[]>`
    select s.id from page_sections s join pages p on p.id = s.page_id
     where p.slug = 'home' and s.block_type = 'hero' limit 1`;

  const context = await browser.newContext({ viewport: { width: 1680, height: 1000 } });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  await page.goto(`${server.origin}/admin/visual-editor`, { waitUntil: "domcontentloaded" });
  await page.getByText("Ready", { exact: true }).waitFor({ timeout: 30_000 });

  const frame = () => page.frames().find((f) => f.url().includes("editor=1"))!;
  const outlines = () => page.locator('[aria-hidden="true"][class*="pointer-events-none"]');

  /* 1. hover draws an outline, and leaving takes it away */
  const links = frame().locator(`[data-eod-address^="section:"]`).first();
  await links.waitFor({ timeout: 15_000 });
  const lead = frame().locator(`[data-eod-address="section:${hero!.id}/field:lead"]`);
  await lead.hover();
  await page.waitForTimeout(400);
  say("hovering the canvas draws an outline", (await outlines().count()) >= 1);

  /* 2. clicking selects, and the inspector names it */
  await lead.click();
  await page.getByText("Supporting sentence").first().waitFor({ timeout: 10_000 });
  say("clicking selects and the inspector names it", true);

  /* 3. the canvas really is the device width, and a switch keeps the selection */
  const widthAt = async () => frame().evaluate(() => window.innerWidth);
  say("desktop is 1440 logical pixels", (await widthAt()) === 1440, String(await widthAt()));
  await page.getByRole("button", { name: /Tablet/ }).click();
  await page.waitForTimeout(900);
  say("tablet is 834", (await widthAt()) === 834, String(await widthAt()));
  say(
    "and the selection survived the device switch",
    (await page.getByText("Supporting sentence").count()) > 0,
  );
  await page.getByRole("button", { name: /Desktop/ }).click();
  await page.waitForTimeout(700);

  /* 4. Layers selects the same way a click does */
  // By the row's hook: "Quick service navigation" now also appears in the
  // accessible names of that row's Expand and Lock buttons, which is correct —
  // a control has to say what it acts on — and makes the name ambiguous.
  const quickRow = page.locator("aside[aria-label='Page structure'] [data-layer-row]")
    .filter({ hasText: "Quick service navigation" })
    .first();
  const quickAddress = (await quickRow.getAttribute("data-layer-row")) ?? "";
  await quickRow.click();
  await waitForInspector(page, quickAddress);
  say(
    "a Layers row selects its section",
    (await page.locator("text=Quick service navigation").count()) > 0,
  );

  /* 5. the bridge is quiet when nothing is happening */
  // Nothing is happening once the Layers selection has finished bringing its
  // section into view: `editor.select` scrolls smoothly, and the bridge sends
  // the outline's new rectangle while the page travels — that is it keeping
  // up, not idle talk. The Inspector answers before the scroll ends, so the
  // window opens once the canvas holds still (Batch 19A: was a fixed 900 ms).
  await canvasStill(page, frame().locator(`[data-eod-address="${quickAddress}"]`).first());
  await page.evaluate(() => {
    (window as unknown as { __seen: number }).__seen = 0;
    window.addEventListener("message", (event) => {
      const data = event.data as { channel?: string } | null;
      if (data && typeof data === "object" && data.channel === "eod.visual-editor") {
        (window as unknown as { __seen: number }).__seen += 1;
      }
    });
  });
  await quietFor(page, 1500, "a canvas that talks when idle does so well inside this window");
  const seen = await page.evaluate(() => (window as unknown as { __seen: number }).__seen);
  say("an idle canvas says nothing", seen === 0, `${seen} messages`);

  /* 6. Reload mints a new bridge */
  const before = frame().url();
  await page.getByRole("button", { name: "Reload" }).click();
  await page.getByText("Ready", { exact: true }).waitFor({ timeout: 30_000 });
  const after = frame().url();
  const bridgeOf = (url: string) => new URL(url).searchParams.get("bridge");
  say("Reload mints a new bridge id", bridgeOf(before) !== bridgeOf(after), `${bridgeOf(before)} → ${bridgeOf(after)}`);

  await context.close();
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
