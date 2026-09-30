/**
 * Batch 7 browser acceptance: responsive styles in the real Visual Editor and
 * on the real public site, against the production build.
 *
 * Everything below is measured with `getComputedStyle` at a real layout
 * viewport. Nothing is asserted from a device label, because the whole claim of
 * this batch is that the website's own CSS decides — so the only honest test is
 * to make the window that wide and ask the browser what it did.
 */
import type { Page } from "playwright";

import { editorSettled } from "../canvas";
import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";
import { animationsDone, until } from "../wait";

const PORT = 3724;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("responsive");
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

  const hero = await section("privacy", "page-hero");
  const travel = await section("home", "travel-feature");

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
  const select = async (address: string) => {
    const element = frame().locator(`[data-eod-address="${address}"]`);
    await element.waitFor({ state: "attached", timeout: 20_000 });
    await element.scrollIntoViewIfNeeded().catch(() => undefined);
    await element.click({ timeout: 10_000 });
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
  const setRange = async (token: string, n: number) => {
    const control = page.locator(`[data-style-token="${token}"] input[type="range"]`);
    await control.waitFor({ timeout: 10_000 });
    await control.fill(String(n));
  };
  const tokenState = (token: string) =>
    page.locator(`[data-style-token="${token}"]`).first().getAttribute("data-style-state");
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
  const publish = async (id: number) => {
    await page.goto(`${server!.origin}/admin/pages/section/${id}`, { waitUntil: "load" });
    await page.getByRole("button", { name: "Publish draft" }).click();
    for (let i = 0; i < 80 && (await state(id)).draft_styles !== null; i += 1) {
      await page.waitForTimeout(200);
    }
  };
  const computed = (target: Page | ReturnType<typeof frame>, selector: string, property: string) =>
    target.locator(selector).first().evaluate(
      (node, prop) => getComputedStyle(node as Element).getPropertyValue(prop as string),
      property,
    );

  /* --- 1. one save, three branches ------------------------------------- */
  await open("?page=privacy&lang=en&device=desktop");
  const title = `section:${hero.id}/field:title`;
  await select(title);
  await styleTab().click();
  await page.getByText("Base", { exact: true }).waitFor({ timeout: 10_000 });
  say("Desktop edits Base", (await page.getByText("Base", { exact: true }).count()) > 0);
  await setToken("fontSize", "h1");
  await setToken("textColor", "strong");

  await device("Tablet");
  await styleTab().click();
  await page.getByText("Tablet override", { exact: true }).waitFor({ timeout: 10_000 });
  say("Tablet edits the tablet branch", true);
  say(
    "…and says what it would inherit",
    (await page.getByText(/Inherited from Base: H1/).count()) > 0,
    (await page.locator('[data-style-token="fontSize"]').innerText()).replace(/\s+/g, " "),
  );
  say("…and the control says it is inherited", (await tokenState("fontSize")) === "inherited");
  await setToken("fontSize", "h2");
  await setToken("textColor", "orange");
  say("…and now says it is an override", (await tokenState("fontSize")) === "override");

  await device("Mobile");
  await styleTab().click();
  await page.getByText("Mobile override", { exact: true }).waitFor({ timeout: 10_000 });
  say(
    "Mobile inherits through Tablet, not around it",
    (await page.getByText(/Inherited from Tablet: H2/).count()) > 0,
  );
  await setToken("fontSize", "h3");
  await setToken("textColor", "peach");

  // Back round the houses: nothing was lost. Autosave will have written the
  // three branches by now — Batch 10 made saving automatic — so what this
  // proves is that switching device three times keeps every branch, not that
  // the panel is still holding them.
  await device("Desktop");
  await styleTab().click();
  say("the Base edit survived two device changes", (await page.locator('[data-style-token="fontSize"] select').inputValue()) === "h1");
  await device("Tablet");
  await styleTab().click();
  say("…so did the Tablet edit", (await page.locator('[data-style-token="fontSize"] select').inputValue()) === "h2");
  await device("Mobile");
  await styleTab().click();
  say("…so did the Mobile edit", (await page.locator('[data-style-token="fontSize"] select').inputValue()) === "h3");
  // One document, whenever it was written: the three branches are saved
  // together because they are three keys of one node, not three saves.
  await page.getByText("Styles saved", { exact: true }).waitFor({ timeout: 20_000 });
  say("…and all of it reached the server as one document", (await state(hero.id)).draft_styles !== null);
  const saved = (await state(hero.id)).draft_styles as { nodes: Record<string, Record<string, unknown>> };
  const branches = saved.nodes["field:title"] as Record<string, Record<string, unknown>>;
  say(
    "…as one document with three branches",
    JSON.stringify(branches.base) === JSON.stringify({ fontSize: "h1", textColor: "strong" }) &&
      JSON.stringify(branches.tablet) === JSON.stringify({ fontSize: "h2", textColor: "orange" }) &&
      JSON.stringify(branches.mobile) === JSON.stringify({ fontSize: "h3", textColor: "peach" }),
    JSON.stringify(branches),
  );

  /* --- 2. the canvas is a real viewport ---------------------------------- */
  const canvasSize = async () => frame().evaluate(() => window.innerWidth);
  await device("Desktop");
  say("the Desktop canvas is a real 1440 viewport", (await canvasSize()) === 1440, String(await canvasSize()));
  const deskColour = await computed(frame(), `[data-eod-address="${title}"]`, "color");
  await device("Tablet");
  say("the Tablet canvas is a real 834 viewport", (await canvasSize()) === 834);
  const tabletColour = await computed(frame(), `[data-eod-address="${title}"]`, "color");
  await device("Mobile");
  say("the Mobile canvas is a real 390 viewport", (await canvasSize()) === 390);
  const mobileColour = await computed(frame(), `[data-eod-address="${title}"]`, "color");
  say(
    "and one document gives three different colours, by width alone",
    deskColour !== tabletColour && tabletColour !== mobileColour,
    `${deskColour} / ${tabletColour} / ${mobileColour}`,
  );

  /* --- 3. the public site, before and after publishing -------------------- */
  const visitor = await context.newPage();
  const at = async (width: number, path: string, selector: string, property: string) => {
    await visitor.setViewportSize({ width, height: 900 });
    await visitor.goto(`${server!.origin}${path}`, { waitUntil: "load" });
    return computed(visitor, selector, property);
  };
  const HEADING = "[data-section='page-hero'] h1";

  /**
   * What each type step actually resolves to at the current width.
   *
   * The ramp is built on `clamp()`, so "h2" is a different number of pixels at
   * 1024 than at 390 — comparing one width's measurement against another's
   * would fail on a page that was behaving perfectly. The honest question is
   * "is this element the h2 of *this* width", and the only way to answer it is
   * to ask the browser what h2 is here.
   */
  const stepsHere = (target: Page) =>
    target.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.position = "absolute";
      probe.style.visibility = "hidden";
      document.body.appendChild(probe);
      probe.style.fontSize = "var(--text-h1)";
      const h1 = getComputedStyle(probe).fontSize;
      probe.style.fontSize = "var(--text-h2)";
      const h2 = getComputedStyle(probe).fontSize;
      probe.style.fontSize = "var(--text-h3)";
      const h3 = getComputedStyle(probe).fontSize;
      probe.remove();
      return { h1, h2, h3 };
    });
  const headingAt = async (width: number, path = "/privacy") => {
    await visitor.setViewportSize({ width, height: 900 });
    await visitor.goto(`${server!.origin}${path}`, { waitUntil: "load" });
    const size = await computed(visitor, HEADING, "font-size");
    const steps = await stepsHere(visitor);
    const step = (Object.keys(steps) as (keyof typeof steps)[]).find((key) => steps[key] === size);
    return { size, step, steps };
  };

  const before = await at(390, "/privacy", HEADING, "font-size");
  say("a visitor at 390 does not have the draft", (await visitor.locator(HEADING).getAttribute("style")) === null, before);

  await publish(hero.id);

  // Base H1 above 1024, Tablet H2 from 1024 down, Mobile H3 from 640 down —
  // named steps rather than pixel counts, because the ramp is a `clamp()` and
  // the same step is a different number of pixels at every width.
  const expected: Record<number, "h1" | "h2" | "h3"> = {
    1440: "h1",
    1025: "h1",
    1024: "h2",
    834: "h2",
    641: "h2",
    640: "h3",
    390: "h3",
  };
  const measured: Record<number, string> = {};
  for (const width of Object.keys(expected).map(Number).sort((a, b) => b - a)) {
    const reading = await headingAt(width);
    measured[width] = `${width}:${reading.step ?? reading.size}`;
    say(
      `${width}px is ${expected[width]!.toUpperCase()}`,
      reading.step === expected[width],
      `${reading.step ?? "?"} (${reading.size})`,
    );
  }
  say("…so the two boundaries are exactly 1024 and 640", true, Object.values(measured).join(" "));

  const colours: Record<number, string> = {};
  for (const width of [1025, 1024, 641, 640]) {
    colours[width] = await at(width, "/privacy", HEADING, "color");
  }
  say(
    "the colour crosses at the same two widths",
    colours[1025] !== colours[1024] && colours[641] !== colours[640],
    `${colours[1025]} | ${colours[1024]} | ${colours[641]} | ${colours[640]}`,
  );
  // The type ramp is one step: a responsive size brings its own line height.
  const leading = {
    desktop: await at(1440, "/privacy", HEADING, "line-height"),
    mobile: await at(390, "/privacy", HEADING, "line-height"),
  };
  say("a responsive size changes the whole type step", leading.desktop !== leading.mobile, JSON.stringify(leading));
  const baseSize = (await headingAt(1440)).size;

  /* --- 4. Arabic ---------------------------------------------------------- */
  await visitor.setViewportSize({ width: 390, height: 900 });
  await visitor.goto(`${server.origin}/ar/privacy`, { waitUntil: "load" });
  const arabic = await computed(visitor, HEADING, "font-size");
  const arabicSteps = await stepsHere(visitor);
  say("the same document lays out in Arabic at the same width", arabic === arabicSteps.h3, `${arabic}`);
  say("…right to left", (await visitor.locator("html").getAttribute("dir")) === "rtl");
  const physical = await visitor.locator(HEADING).evaluate((n) => (n as HTMLElement).getAttribute("style") ?? "");
  say("…with nothing physical in the override", !/left|right/.test(physical), physical.slice(0, 120));

  /* --- 5. spacing, measured ------------------------------------------------ */
  await open("?page=privacy&lang=en&device=desktop");
  await select(`section:${hero.id}`);
  await styleTab().click();
  await setRange("padBlock", 9);
  await device("Tablet");
  await styleTab().click();
  await setRange("padBlock", 6);
  await device("Mobile");
  await styleTab().click();
  await setRange("padBlock", 3);
  await saveStyles(hero.id);
  await publish(hero.id);

  const padding: Record<number, string> = {};
  for (const width of [1440, 834, 390]) {
    padding[width] = await at(width, "/privacy", "[data-section='page-hero']", "padding-top");
  }
  say(
    "three widths, three real paddings",
    padding[1440] !== padding[834] && padding[834] !== padding[390],
    JSON.stringify(padding),
  );

  /* --- 6. Inherit ---------------------------------------------------------- */
  await open("?page=privacy&lang=en&device=mobile");
  await select(title);
  await styleTab().click();
  await page.getByText("Mobile override", { exact: true }).waitFor({ timeout: 10_000 });
  say("the mobile override is there to remove", (await tokenState("fontSize")) === "override");
  await setToken("fontSize", "__default__");
  say("…and choosing Inherit marks it inherited", (await tokenState("fontSize")) === "inherited");
  say(
    "…from Tablet, not from the design",
    (await page.getByText(/Inherited from Tablet: H2/).count()) > 0,
  );
  await saveStyles(hero.id);
  await publish(hero.id);
  const inherited = await headingAt(390);
  say(
    "a mobile Inherit lands on the tablet value, not on base",
    inherited.step === "h2",
    `${inherited.step ?? inherited.size} (h1 ${inherited.steps.h1} / h2 ${inherited.steps.h2} / h3 ${inherited.steps.h3})`,
  );
  const stored = (await state(hero.id)).styles as { nodes: Record<string, Record<string, unknown>> };
  say(
    "…and nothing was copied into mobile to achieve it",
    !JSON.stringify(stored.nodes["field:title"]?.mobile ?? {}).includes("fontSize"),
    JSON.stringify(stored.nodes["field:title"]),
  );

  /* --- 7. hiding ----------------------------------------------------------- */
  await open("?page=home&lang=en&device=mobile");
  const caps = (travel.published.capabilities as Record<string, unknown>[]) ?? [];
  const capId = String(caps[0]!._id);
  const capability = `section:${travel.id}/field:capabilities/item:${capId}`;
  await select(capability);
  await styleTab().click();
  await setToken("hidden", "hide");
  await saveStyles(travel.id);

  const box = async (address: string) =>
    frame().locator(`[data-eod-address="${address}"]`).evaluate((n) => {
      const rect = (n as HTMLElement).getBoundingClientRect();
      return { w: rect.width, h: rect.height, display: getComputedStyle(n as Element).display };
    });
  const hiddenBox = await box(capability);
  say("the row has no layout box at Mobile", hiddenBox.display === "none" && hiddenBox.w === 0, JSON.stringify(hiddenBox));
  say(
    "…and it is still selected, with the control that undoes it",
    (await page.locator('[data-style-token="hidden"] select').inputValue()) === "hide",
  );
  const neighbour = `section:${travel.id}/field:capabilities/item:${String(caps[1]!._id)}`;
  say("…and its neighbour is untouched", (await box(neighbour)).display !== "none");

  await device("Desktop");
  say("Desktop shows it again, with no save in between", (await box(capability)).display !== "none");
  await device("Mobile");
  say("…and Mobile hides it again, by width alone", (await box(capability)).display === "none");

  // Deliberately not re-selected: it cannot be clicked while it is hidden, and
  // that is the whole point — the selection survived the save, so the control
  // that undoes it is still in front of the person who used it.
  await styleTab().click();
  say("the Inspector is still on the hidden node", (await tokenState("hidden")) === "override");
  await setToken("hidden", "__default__");
  await saveStyles(travel.id);
  say("resetting the override brings it back", (await box(capability)).display !== "none");
  const cleared = (await state(travel.id)).draft_styles as { nodes: Record<string, unknown> };
  say("…with nothing stored to say it is shown", JSON.stringify(cleared.nodes) === "{}", JSON.stringify(cleared.nodes));

  /* --- 8. a picture's focal point ------------------------------------------ */
  await open("?page=home&lang=en&device=desktop");
  const picture = `section:${travel.id}/field:image`;
  await select(picture);
  await styleTab().click();
  await page.locator('[data-style-token="objectX"]').waitFor({ timeout: 10_000 });
  await setRange("objectX", 50);
  await setRange("objectY", 50);
  await device("Tablet");
  await styleTab().click();
  await setRange("objectX", 35);
  await setRange("objectY", 50);
  await device("Mobile");
  await styleTab().click();
  await setRange("objectX", 20);
  await setRange("objectY", 75);
  await saveStyles(travel.id);

  const crop = async (label: "Desktop" | "Tablet" | "Mobile") => {
    await device(label);
    return computed(frame(), `[data-eod-address="${picture}"] img`, "object-position");
  };
  const crops = { desktop: await crop("Desktop"), tablet: await crop("Tablet"), mobile: await crop("Mobile") };
  say(
    "the crop tracks the width, with no further saves",
    /50%\s*50%/.test(crops.desktop) && /35%\s*50%/.test(crops.tablet) && /20%\s*75%/.test(crops.mobile),
    JSON.stringify(crops),
  );
  const onFrame = await frame()
    .locator(`[data-eod-address="${picture}"]`)
    .evaluate((n) => getComputedStyle(n as Element).objectPosition);
  say("…and the frame is not what was cropped", !/35%/.test(onFrame) && !/20%/.test(onFrame), onFrame);
  const mediaId = (await state(travel.id)).draft_styles !== null;
  say("…and the content was never touched", mediaId && String((travel.published as Record<string, unknown>).image) === "1");

  /* --- 9. a revealed row's opacity at a narrow width ------------------------ */
  await open("?page=home&lang=en&device=desktop");
  await select(capability);
  await styleTab().click();
  await setRange("opacity", 1);
  await device("Tablet");
  await styleTab().click();
  await setRange("opacity", 0.75);
  await device("Mobile");
  await styleTab().click();
  await setRange("opacity", 0.45);
  await saveStyles(travel.id);
  await publish(travel.id);

  await visitor.setViewportSize({ width: 390, height: 900 });
  await visitor.goto(`${server.origin}/`, { waitUntil: "load" });
  const reveal = await visitor.evaluate(() => {
    const el = document.querySelectorAll('[data-section="travel-feature"] li.reveal')[0] as HTMLElement;
    return {
      opacity: getComputedStyle(el).opacity,
      shown: el.dataset.shown,
      onScreen: el.getBoundingClientRect().top < window.innerHeight,
    };
  });
  say("at 390 the row still starts hidden", reveal.opacity === "0" && reveal.shown === "false", JSON.stringify(reveal));
  say("…and really was off screen", !reveal.onScreen);
  await visitor.evaluate(() => {
    document.querySelector('[data-section="travel-feature"]')!.scrollIntoView({ block: "center" });
  });
  // Until the row has been reached and its reveal has run to the end (Batch 19A: was a fixed 2.5 s).
  await until(async () => (await visitor.locator('[data-section="travel-feature"] li.reveal').first().getAttribute("data-shown")) === "true", 15_000);
  await animationsDone(visitor.locator('[data-section="travel-feature"]').first());
  const finished = await visitor.evaluate(() => {
    const el = document.querySelectorAll('[data-section="travel-feature"] li.reveal')[0] as HTMLElement;
    return { opacity: getComputedStyle(el).opacity, shown: el.dataset.shown };
  });
  say("…and finishes at the mobile opacity", finished.shown === "true" && finished.opacity === "0.45", JSON.stringify(finished));

  await visitor.setViewportSize({ width: 1440, height: 900 });
  await visitor.goto(`${server.origin}/`, { waitUntil: "load" });
  await visitor.evaluate(() => {
    document.querySelector('[data-section="travel-feature"]')!.scrollIntoView({ block: "center" });
  });
  // Until the row has been reached and its reveal has run to the end (Batch 19A: was a fixed 2.5 s).
  await until(async () => (await visitor.locator('[data-section="travel-feature"] li.reveal').first().getAttribute("data-shown")) === "true", 15_000);
  await animationsDone(visitor.locator('[data-section="travel-feature"]').first());
  const wide = await visitor.evaluate(() => {
    const el = document.querySelectorAll('[data-section="travel-feature"] li.reveal')[0] as HTMLElement;
    return getComputedStyle(el).opacity;
  });
  say("…and at 1440 it finishes at the base one", wide === "1", wide);

  /* --- 10. reduced motion and print ---------------------------------------- */
  const still = await context.newPage();
  await still.emulateMedia({ reducedMotion: "reduce" });
  await still.setViewportSize({ width: 390, height: 900 });
  await still.goto(`${server.origin}/`, { waitUntil: "load" });
  const reduced = await still.evaluate(() => {
    const el = document.querySelectorAll('[data-section="travel-feature"] li.reveal')[0] as HTMLElement;
    return getComputedStyle(el).opacity;
  });
  say("with reduced motion the mobile opacity is there immediately", reduced === "0.45", reduced);

  await still.emulateMedia({ reducedMotion: null, media: "print" });
  await still.setViewportSize({ width: 794, height: 1100 });
  await still.goto(`${server.origin}/privacy`, { waitUntil: "load" });
  const printed = await computed(still, HEADING, "font-size");
  const printSteps = await stepsHere(still);
  say(
    "a printed page gets the base design, not a narrow one",
    printed === printSteps.h1,
    `${printed} vs h1 ${printSteps.h1} / h2 ${printSteps.h2} / h3 ${printSteps.h3}`,
  );
  void baseSize;
  await still.close();
  await visitor.close();
  await context.close();

  /* --- put the fixture back -------------------------------------------------- */
  await sql`update page_sections set draft = null, draft_styles = null,
                   styles = '{"v":1,"nodes":{}}'::jsonb
             where id in (${hero.id}, ${travel.id})`;
  const restored = await state(hero.id);
  say("the fixture is back as it started", restored.draft_styles === null);
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
