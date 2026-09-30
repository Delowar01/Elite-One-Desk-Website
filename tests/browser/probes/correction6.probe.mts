/**
 * Batch 6 correction acceptance: the three renderer gaps, in a real browser,
 * against the production build.
 *
 *   1. a shared `SectionHeading` node is styled from the panel,
 *   2. a media node's focal point reaches the `<img>` and visibly re-crops it,
 *   3. an opacity on a revealed row is its finished state, not its current one.
 *
 * Everything is driven through the Visual Editor's own UI and read back with
 * `getComputedStyle`, so what is measured is what a browser resolved rather
 * than what the HTML happened to say.
 */
import type { Page } from "playwright";

import { editorSettled, selectCanvasNode } from "../canvas";
import { callAction } from "../../helpers/action";
import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";
import { animationsDone, until } from "../wait";

const PORT = 3706;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("correction6");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);

  const section = async (slug: string, block: string) =>
    (
      await sql<{ id: number; published: Record<string, unknown> }[]>`
        select s.id, s.published from page_sections s join pages p on p.id = s.page_id
         where p.slug = ${slug} and s.block_type = ${block} order by s.position limit 1`
    )[0]!;

  const links = await section("home", "quick-links");
  const process = await section("home", "process");
  const travel = await section("home", "travel-feature");
  const imageText = await section("about", "image-text");

  const state = async (id: number) =>
    (
      await sql<{ revision: number; draft_styles: unknown; styles: unknown }[]>`
        select revision, draft_styles, styles from page_sections where id = ${id}`
    )[0]!;

  const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("   [pageerror]", error.message.slice(0, 120)));
  // Publishing asks first, and an unanswered confirm() is a "no".
  page.on("dialog", (dialog) => dialog.accept());

  const open = async (query: string) => {
    await page.goto(`${server!.origin}/admin/visual-editor${query}`, { waitUntil: "load" });
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 30_000 });
  };
  const frame = () => page.frames().find((f) => f.url().includes("editor=1"))!;
  /**
   * One click where the canvas is still, and the Inspector's word that it is
   * this node (Batch 19A — a plain `click()` retries through a smooth
   * re-scroll and can land beside a node that is still moving; see
   * `tests/browser/canvas.ts`).
   */
  const select = async (address: string) => {
    const element = frame().locator(`[data-eod-address="${address}"]`);
    await element.first().waitFor({ timeout: 20_000 });
    const result = await selectCanvasNode(page, address);
    if (!result.ok) throw new Error(`select(${address}) ended on ${result.shows || "nothing"}; the click landed on ${JSON.stringify(result.landing)}`);
    return element;
  };
  const styleTab = () => page.getByRole("tab", { name: /Style/ });
  const setToken = async (token: string, option: string) => {
    const control = page.locator(`[data-style-token="${token}"] select`);
    await control.waitFor({ timeout: 10_000 });
    await control.selectOption(option);
  };
  const setRange = async (token: string, n: number) => {
    const control = page.locator(`[data-style-token="${token}"] input[type="range"]`);
    await control.waitFor({ timeout: 10_000 });
    await control.fill(String(n));
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
    for (let i = 0; i < 60 && (await state(id)).revision === before; i += 1) {
      await page.waitForTimeout(200);
    }
    await editorSettled(page);
  };
  const publish = async (id: number) => {
    await page.goto(`${server!.origin}/admin/pages/section/${id}`, { waitUntil: "load" });
    await page.getByRole("button", { name: "Publish draft" }).click();
    for (let i = 0; i < 60 && (await state(id)).draft_styles !== null; i += 1) {
      await page.waitForTimeout(200);
    }
  };
  /** What the browser resolved for one property of one element. */
  const computed = (target: Page | ReturnType<typeof frame>, selector: string, property: string) =>
    target.locator(selector).first().evaluate(
      (node, prop) => getComputedStyle(node as Element).getPropertyValue(prop as string),
      property,
    );

  /* --- 1. the shared heading ------------------------------------------ */
  await open("?page=home&lang=en&device=desktop");
  const title = `section:${links.id}/field:title`;
  await select(title);
  await styleTab().click();
  await page.getByText("Base", { exact: true }).waitFor({ timeout: 10_000 });
  const heading = await frame().locator(`[data-eod-address="${title}"]`).evaluate((n) => n.tagName);
  say("Quick Access' heading is the element the panel selected", heading === "P", heading);

  await setToken("textColor", "orange");
  await setToken("fontWeight", "800");
  await saveStyles(links.id);

  const colour = await computed(frame(), `[data-eod-address="${title}"]`, "color");
  const weight = await computed(frame(), `[data-eod-address="${title}"]`, "font-weight");
  say("…and the browser resolved the editor's colour on it", /^rgb/.test(colour) && colour !== "rgb(0, 0, 0)", colour);
  say("…and the editor's weight", weight === "800", weight);

  const early = await context.newPage();
  await early.goto(`${server.origin}/`, { waitUntil: "load" });
  const beforePublish = await computed(early, "[data-section='quick-links'] .eyebrow", "font-weight");
  await early.close();
  say("a visitor does not get the draft", beforePublish !== "800", beforePublish);

  await publish(links.id);

  /* --- 2. a second block, on the same shared component ----------------- */
  await open("?page=home&lang=en&device=desktop");
  const eyebrow = `section:${process.id}/field:eyebrow`;
  await select(eyebrow);
  await styleTab().click();
  await setToken("textColor", "peach");
  await setToken("align", "center");
  await saveStyles(process.id);
  const second = await computed(frame(), `[data-eod-address="${eyebrow}"]`, "text-align");
  say("How it works' eyebrow is styled by the same component", second === "center", second);
  await publish(process.id);

  /* --- 3. a picture's focal point -------------------------------------- */
  /*
   * Quick Links' picture is styled through the same Server Action the panel
   * calls, not by clicking it: `.ql-body` is a full-height sibling painted over
   * `.ql-shot`, so every pointer in that card lands on the row. The node is
   * addressable, styleable and — as this proves — rendered; it simply cannot be
   * pointed at yet. That is a selection gap, and it is reported rather than
   * papered over here.
   */
  await open("?page=home&lang=en&device=desktop");
  const rows = (links.published.links as Record<string, unknown>[]) ?? [];
  const cardId = String(rows[0]!._id);
  const relative = `field:links/item:${cardId}/field:image`;
  const shot = `section:${links.id}/${relative}`;
  const card = frame().locator(`[data-eod-address="${shot}"]`);
  await card.scrollIntoViewIfNeeded();
  const before = await card.screenshot();
  const beforeCrop = await computed(frame(), `[data-eod-address="${shot}"] img`, "object-position");

  const form = new FormData();
  form.set("_csrf", owner.csrfToken);
  form.set("sectionId", String(links.id));
  form.set("pageId", String((await sql<{ page_id: number }[]>`select page_id from page_sections where id = ${links.id}`)[0]!.page_id));
  form.set("expectedRevision", String((await state(links.id)).revision));
  form.set("styles", JSON.stringify({ v: 1, nodes: { [relative]: { base: { objectX: 20, objectY: 80 } } } }));
  const saved = await callAction<{ ok: boolean }>({
    origin: server.origin,
    route: "/admin/visual-editor",
    file: "app/(backoffice)/admin/visual-editor/actions.ts",
    action: "saveVisualSectionStyles",
    args: [form],
    cookie: owner.cookie,
  });
  say("the panel's own action accepted the focal point", saved.value?.ok === true);
  await open("?page=home&lang=en&device=desktop");
  await frame().locator(`[data-eod-address="${shot}"]`).scrollIntoViewIfNeeded();

  const afterCrop = await computed(frame(), `[data-eod-address="${shot}"] img`, "object-position");
  say("the crop is resolved on the picture itself", /20%\s*80%/.test(afterCrop), afterCrop);
  say("…and it changed", afterCrop !== beforeCrop, `${beforeCrop} → ${afterCrop}`);
  const frameCrop = await frame()
    .locator(`[data-eod-address="${shot}"]`)
    .evaluate((n) => (n as HTMLElement).style.objectPosition);
  say("…and nothing was written on the frame, where it would be inert", frameCrop === "", frameCrop);
  const after = await frame().locator(`[data-eod-address="${shot}"]`).screenshot();
  say("…and the card looks different", !before.equals(after), `${before.length} vs ${after.length} bytes`);

  const neighbour = `section:${links.id}/field:links/item:${String(rows[1]!._id)}/field:image`;
  const neighbourCrop = await computed(frame(), `[data-eod-address="${neighbour}"] img`, "object-position");
  const neighbourInline = await frame()
    .locator(`[data-eod-address="${neighbour}"] img`)
    .first()
    .evaluate((n) => (n as HTMLElement).style.objectPosition);
  // Every card has its own crop from the stylesheet — what matters is that the
  // editor's did not reach this one.
  say("…and only that card", neighbourInline === "" && !/20%\s*80%/.test(neighbourCrop), `${neighbourCrop} / "${neighbourInline}"`);

  /* --- 4. a picture that is not in a list ------------------------------ */
  await open("?page=about&lang=en&device=desktop");
  const solo = `section:${imageText.id}/field:image`;
  await select(solo);
  await styleTab().click();
  await setRange("objectX", 10);
  await setRange("objectY", 90);
  await saveStyles(imageText.id);
  const soloCrop = await computed(frame(), `[data-eod-address="${solo}"] img`, "object-position");
  say("a single picture is cropped the same way", /10%\s*90%/.test(soloCrop), soloCrop);
  const soloFit = await computed(frame(), `[data-eod-address="${solo}"] img`, "object-fit");
  say("…and the fit that makes a crop mean anything survived", soloFit === "cover", soloFit);

  /* --- 5. an opacity on a revealed row --------------------------------- */
  await open("?page=home&lang=en&device=desktop");
  const caps = (travel.published.capabilities as Record<string, unknown>[]) ?? [];
  const capId = String(caps[0]!._id);
  const capability = `section:${travel.id}/field:capabilities/item:${capId}`;
  await select(capability);
  await styleTab().click();
  await setRange("opacity", 0.5);
  await saveStyles(travel.id);
  await publish(travel.id);

  const visitor = await context.newPage();
  await visitor.goto(`${server.origin}/`, { waitUntil: "load" });
  // The row is far below the fold, so it has not been revealed yet.
  const hidden = await visitor.evaluate((_id) => {
    const el = document.querySelectorAll('[data-section="travel-feature"] li.reveal')[0] as HTMLElement;
    return { opacity: getComputedStyle(el).opacity, shown: el.dataset.shown, onScreen: el.getBoundingClientRect().top < window.innerHeight };
  }, capId);
  say("the row starts hidden, as a reveal does", hidden.opacity === "0" && hidden.shown === "false", JSON.stringify(hidden));
  say("…and it really was off screen", !hidden.onScreen, JSON.stringify(hidden));

  await visitor.evaluate(() => {
    document.querySelector('[data-section="travel-feature"]')!.scrollIntoView({ block: "center" });
  });
  // Until the row has been reached and its reveal has run to the end (Batch 19A: was a fixed 2.5 s).
  // The whole section: its rows arrive in turn, and the neighbours are read too.
  const row = visitor.locator('[data-section="travel-feature"] li.reveal').first();
  await until(async () => (await row.getAttribute("data-shown")) === "true", 15_000);
  await animationsDone(visitor.locator('[data-section="travel-feature"]').first());
  const revealed = await visitor.evaluate(() => {
    const el = document.querySelectorAll('[data-section="travel-feature"] li.reveal')[0] as HTMLElement;
    return { opacity: getComputedStyle(el).opacity, shown: el.dataset.shown };
  });
  say("…and finishes at the opacity the editor chose", revealed.shown === "true" && revealed.opacity === "0.5", JSON.stringify(revealed));
  const sibling = await visitor.evaluate(() => {
    const el = document.querySelectorAll('[data-section="travel-feature"] li.reveal')[1] as HTMLElement;
    return getComputedStyle(el).opacity;
  });
  say("…and its neighbours came all the way back", sibling === "1", sibling);
  await visitor.close();

  /* --- 6. the public page, and Arabic ---------------------------------- */
  const reader = await context.newPage();
  await reader.goto(`${server.origin}/`, { waitUntil: "load" });
  const publicWeight = await computed(reader, "[data-section='quick-links'] .eyebrow", "font-weight");
  say("the published heading reaches a visitor", publicWeight === "800", publicWeight);
  const publicCrop = await computed(reader, "[data-section='quick-links'] .ql-img", "object-position");
  say("…and the picture is still the design's until that is published too", !/20%\s*80%/.test(publicCrop), publicCrop);

  await reader.goto(`${server.origin}/ar/`, { waitUntil: "load" });
  const arabicWeight = await computed(reader, "[data-section='quick-links'] .eyebrow", "font-weight");
  const arabicDir = await reader.locator("html").getAttribute("dir");
  say("the same document lays out in Arabic", arabicWeight === "800" && arabicDir === "rtl", `${arabicWeight} / ${arabicDir}`);
  const arabicInline = await reader
    .locator("[data-section='quick-links'] .eyebrow")
    .evaluate((n) => (n as HTMLElement).getAttribute("style") ?? "");
  say(
    "…with nothing physical in it",
    !/margin-left|margin-right|padding-left|padding-right/.test(arabicInline),
    arabicInline,
  );
  await reader.close();

  await context.close();

  /* --- put the fixture back --------------------------------------------- */
  await sql`update page_sections set draft = null, draft_styles = null,
                   styles = '{"v":1,"nodes":{}}'::jsonb
             where id in (${links.id}, ${process.id}, ${travel.id}, ${imageText.id})`;
  const restored = await state(links.id);
  say("the fixture is back as it started", restored.draft_styles === null);
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
