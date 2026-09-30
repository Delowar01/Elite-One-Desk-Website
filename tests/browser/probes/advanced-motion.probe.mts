/**
 * Batch 15a acceptance: advanced motion in a real browser, English and Arabic.
 *
 * Three questions, each asked of the real editor and the real pages:
 *
 *   · Does the Motion tab edit the document the way the Style tab edits
 *     styles — section or element, Base / Tablet / Mobile, absence as the
 *     default, inheritance said in words, nothing that cannot act?
 *   · Does each entrance, timing and stagger do exactly what it says in the
 *     browser — hidden state, finished state, RTL, the three widths — and
 *     nothing at all for reduced motion, print or a page without JavaScript?
 *   · Does it compose with what was already there: Style opacity, a button's
 *     hover, a Batch 14 glow, one observer however many elements move?
 */
import type { BrowserContext, Page } from "playwright";

import { selectCanvasNode, waitForInspector } from "../canvas";
import { callAction } from "../../helpers/action";
import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";
import { AUTOSAVE_QUIET_MS, animationsDone, quietFor } from "../wait";

const PORT = 3704;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

/** Freezes every entrance where it starts: the observer never answers. */
const FROZEN = `
  window.IntersectionObserver = class {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  };
`;
/** Counts scroll listeners added by page code, on the window and the document. */
const COUNT_SCROLL = `
  window.__scrollListeners = 0;
  const add = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, ...rest) {
    if (type === "scroll" && (this === window || this === document)) window.__scrollListeners += 1;
    return add.call(this, type, ...rest);
  };
`;

const browser = await launchChromium();
const database = giveFresh("advanced_motion_probe");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    select 'viewer@test.invalid', 'Read Only', 'unused', id, true from roles where key = 'viewer'
  `;
  const viewer = await signIn(sql, "viewer");
  server = await startServer(database, PORT);
  const origin = server.origin;

  const [about] = await sql<{ id: number }[]>`select id from pages where slug = 'about'`;
  const [home] = await sql<{ id: number }[]>`select id from pages where slug = 'home'`;
  const ids = Object.fromEntries(
    (
      await sql<{ id: number; block_type: string }[]>`
        select id, block_type from page_sections where page_id = ${about!.id} order by position`
    ).map((row) => [row.block_type, row.id]),
  ) as Record<string, number>;
  const [homeHero] = await sql<{ id: number }[]>`
    select id from page_sections where page_id = ${home!.id} and block_type = 'hero'`;
  const TEXT = ids["rich-text"]!;
  const WHY = ids["why-us"]!;
  const CTA = ids["final-cta"]!;
  const IMAGE = ids["image-text"]!;

  type Doc = { v: number; section: Record<string, unknown>; nodes: Record<string, unknown> };
  const doc = (section: Record<string, unknown> = {}, nodes: Record<string, unknown> = {}): Doc => ({
    v: 1,
    section,
    nodes,
  });
  const motionOf = async (id: number) =>
    (
      await sql<{ draft_motion_config: Doc | null; draft_animation: string | null; motion_config: Doc | null; animation: string }[]>`
        select draft_motion_config, draft_animation, motion_config, animation from page_sections where id = ${id}`
    )[0]!;
  /** jsonb comes back in its own key order, so compare by shape. */
  const sorted = (value: unknown): unknown =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, sorted(v)]),
        )
      : value;
  const same = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
  const until = async (check: () => Promise<boolean>, tries = 100) => {
    for (let i = 0; i < tries; i += 1) {
      if (await check()) return true;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    return false;
  };
  const reset = async () => {
    await sql`update page_sections set draft = null, draft_styles = null, draft_animation = null,
                                       draft_motion_config = null, motion_config = null, animation = 'fade-up'
               where page_id in (${about!.id}, ${home!.id})`;
    await sql`update pages set draft_structure = null where id in (${about!.id}, ${home!.id})`;
  };
  const setDraft = async (id: number, value: Doc, preset = "fade-up") => {
    await sql`update page_sections set draft_motion_config = ${sql.json(value as never)}, draft_animation = ${preset}
               where id = ${id}`;
  };
  const setStyles = async (id: number, nodes: Record<string, unknown>) => {
    await sql`update page_sections set draft_styles = ${sql.json({ v: 1, nodes } as never)} where id = ${id}`;
  };
  await reset();

  const cookieOf = (session: { cookie: string }) => {
    const [name, value] = session.cookie.split("=");
    return { name: name!, value: value!, domain: "127.0.0.1", path: "/" };
  };

  /* ======================================================================= */
  /* A. The Motion tab                                                        */
  /* ======================================================================= */

  const editorContext = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  await editorContext.addCookies([cookieOf(owner)]);
  const page = await editorContext.newPage();
  page.on("pageerror", (error) => console.log("   [pageerror]", error.message.slice(0, 140)));
  page.on("dialog", (dialog) => void dialog.accept());

  const open = async (query: string) => {
    await page.goto(`${origin}/admin/visual-editor${query}`, { waitUntil: "load" });
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  };
  const frame = () => page.frames().find((f) => f.url().includes("editor=1"))!;
  const settled = async () => {
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
    await page.waitForTimeout(900);
  };
  const motionTab = () => page.getByRole("tab", { name: /Motion/ });
  const inspectorAddress = async () =>
    (await page.locator("aside[aria-label='Inspector'] code").allTextContents())
      .map((t) => t.trim())
      .find((t) => t.startsWith("section:")) ?? "";
  /**
   * From Layers, then a bounded wait for the Inspector to show the section —
   * the Motion tab alone is no proof, because it is already there for
   * whatever was selected before (Batch 19A).
   */
  const selectSection = async (id: number) => {
    await settled();
    const row = page.locator(`aside[aria-label='Page structure'] [data-layer-row="section:${id}"]`);
    await row.waitFor({ timeout: 25_000 });
    await row.click();
    const shows = await waitForInspector(page, `section:${id}`);
    if (shows !== `section:${id}`) console.log(`   [select] section:${id} → the Inspector shows ${shows || "nothing"}`);
    await motionTab().waitFor({ timeout: 25_000 });
    await motionTab().click();
  };
  /**
   * One click where the canvas is still, at a point whose innermost addressed
   * element *is* the element — so a headline is not selected through the
   * rotating word inside it, which is a sibling field with an address of its
   * own — then a bounded wait for the Inspector (Batch 19A: the old loop read
   * the Inspector straight after the click and could step the fresh
   * selection out to its section; see `tests/browser/canvas.ts`).
   */
  const selectNode = async (address: string) => {
    await settled();
    const result = await selectCanvasNode(page, address);
    if (!result.ok) {
      console.log(`   [select] ${address} → the Inspector shows ${result.shows || "nothing"}; the click landed on ${JSON.stringify(result.landing)}`);
      return false;
    }
    await motionTab().click();
    return true;
  };
  const control = (field: string) => page.locator(`[data-motion-field="${field}"] select`);
  const choose = async (field: string, label: string) => {
    await control(field).waitFor({ timeout: 10_000 });
    await control(field).selectOption({ label });
  };
  const shown = async (field: string) =>
    (
      await control(field).evaluate((node) => {
        const select = node as HTMLSelectElement;
        return select.options[select.selectedIndex]?.textContent ?? "";
      })
    ).trim();
  const offered = async () =>
    page.locator("[data-motion-field]").evaluateAll((nodes) => nodes.map((n) => (n as HTMLElement).dataset.motionField));
  const device = async (label: "Desktop" | "Tablet" | "Mobile") => {
    await page.getByRole("button", { name: new RegExp(`^${label}`) }).click();
    await page.waitForTimeout(700);
  };
  await open("?page=about&lang=en&device=desktop");
  await selectSection(TEXT);

  say("A1. selecting a section edits the section's motion", (await page.locator('[data-motion-target="section"]').count()) === 1);
  const entrances = (await control("entrance").locator("option").allTextContents()).map((t) => t.trim());
  say(
    "A2. seven entrances, after the legacy default the section falls back to",
    JSON.stringify(entrances) ===
      JSON.stringify(["Legacy default — Fade up", "Fade up", "Fade only", "Slide in", "Scale in", "Blur reveal", "Mask reveal", "No entrance"]),
    JSON.stringify(entrances),
  );
  say("A3. …and the fallback is what it shows while nothing is set", (await shown("entrance")) === "Legacy default — Fade up");
  say(
    "A4. timing is offered, because the fallback moves; direction is not, because it does not travel",
    JSON.stringify(await offered()) === JSON.stringify(["entrance", "duration", "delay", "easing"]),
    JSON.stringify(await offered()),
  );

  await choose("entrance", "Blur reveal");
  await page.getByText("Unsaved motion").waitFor({ timeout: 10_000 });
  say("A5. a change is local until it is saved", (await motionOf(TEXT)).draft_motion_config === null);
  const blurSaved = await until(async () => same((await motionOf(TEXT)).draft_motion_config, doc({ base: { entrance: "blur" } })));
  say("A6. …and autosaves as the document", blurSaved, JSON.stringify((await motionOf(TEXT)).draft_motion_config));
  say("A7. …with its legacy projection beside it", (await motionOf(TEXT)).draft_animation === "fade");
  say("A8. …and nothing live moved", (await motionOf(TEXT)).animation === "fade-up" && (await motionOf(TEXT)).motion_config === null);
  await settled();
  const canvasWrapper = async () => (await frame().locator(`[data-eod-address="section:${TEXT}"]`).first().getAttribute("style")) ?? "";
  say("A9. the canvas shows the draft on the section's own element", /--m-blur:\s*8px/.test(await canvasWrapper()), await canvasWrapper());

  await selectSection(TEXT);
  await choose("entrance", "Mask reveal");
  await control("direction").waitFor({ timeout: 10_000 });
  const directions = (await control("direction").locator("option").allTextContents()).map((t) => t.trim());
  say(
    "A10. a travelling entrance offers a logical direction, never a side",
    JSON.stringify(directions) ===
      JSON.stringify(["Default — from the start edge", "From the start edge", "From the end edge", "Upward", "Downward"]),
    JSON.stringify(directions),
  );
  await choose("direction", "From the end edge");
  const durations = (await control("duration").locator("option").allTextContents()).map((t) => t.trim());
  say(
    "A11. durations say their length, and the default says which it is",
    JSON.stringify(durations) ===
      JSON.stringify(["Default — Slow · 0.76s", "Fast · 0.18s", "Standard · 0.38s", "Slow · 0.76s", "Cinematic · 1.2s"]),
    JSON.stringify(durations),
  );
  await choose("duration", "Cinematic · 1.2s");
  await choose("easing", "Soft out");
  const slider = page.locator('[data-motion-field="delay"] input[type="range"]');
  await slider.focus();
  for (let i = 0; i < 3; i += 1) await page.keyboard.press("ArrowRight");
  say("A12. delay is a stepped slider the keyboard drives", (await slider.inputValue()) === "150", await slider.inputValue());
  say(
    "A13. …and it says its value in words",
    (await slider.getAttribute("aria-valuetext")) === "150 milliseconds",
    String(await slider.getAttribute("aria-valuetext")),
  );
  const maskSaved = await until(async () =>
    same(
      (await motionOf(TEXT)).draft_motion_config,
      doc({ base: { entrance: "mask", direction: "end", duration: "cinematic", easing: "soft-out", delay: 150 } }),
    ),
  );
  say("A14. every setting is one key of one branch", maskSaved, JSON.stringify((await motionOf(TEXT)).draft_motion_config));
  say("A15. …and Mask from the end projects to Slide in", (await motionOf(TEXT)).draft_animation === "slide-in");

  // The save reloads the canvas and restores the selection; read the panel
  // once it has.
  await selectSection(TEXT);
  await control("entrance").waitFor({ timeout: 15_000 });
  const controls = await page.locator("[data-motion-field] select, [data-motion-field] input").count();

  const unlabeled = await page.locator("[data-motion-field] select, [data-motion-field] input").evaluateAll((nodes) =>
    nodes
      .filter((node) => !document.querySelector(`label[for="${(node as HTMLElement).id}"]`))
      .map((node) => (node as HTMLElement).id),
  );
  say(
    "A16. every motion control is named by a label bound to it",
    controls === 5 && unlabeled.length === 0,
    JSON.stringify({ controls, unlabeled }),
  );
  const states = await page.locator("[data-motion-field]").evaluateAll((nodes) =>
    nodes.map((n) => `${(n as HTMLElement).dataset.motionField}:${(n as HTMLElement).dataset.motionState}`),
  );
  say(
    "A17. …and says in words which are set here",
    JSON.stringify(states) ===
      JSON.stringify(["entrance:override", "direction:override", "duration:override", "delay:override", "easing:override"]),
    JSON.stringify(states),
  );
  say(
    "A18. the panel says what reduced motion and print do, and that start follows the reading direction",
    (await page.getByText(/reduced motion see every element already in place/).count()) > 0 &&
      (await page.getByText(/the left in English, the right in Arabic/).count()) > 0,
  );

  /* --- Tablet and Mobile ------------------------------------------------ */
  await settled();
  await device("Tablet");
  await selectSection(TEXT);
  say("A19. Tablet edits its own branch", (await page.getByText("Tablet override", { exact: true }).count()) > 0);
  say("A20. …where every field starts inherited", (await shown("entrance")) === "Inherit");
  say(
    "A21. …and says what it inherits, and from where",
    (await page.getByText("Inherited from Base: Mask reveal").count()) > 0,
  );
  await choose("duration", "Fast · 0.18s");
  const tabletSaved = await until(async () =>
    same((await motionOf(TEXT)).draft_motion_config?.section, {
      base: { entrance: "mask", direction: "end", duration: "cinematic", easing: "soft-out", delay: 150 },
      tablet: { duration: "fast" },
    }),
  );
  say("A22. a tablet value is stored in the tablet branch alone", tabletSaved, JSON.stringify((await motionOf(TEXT)).draft_motion_config?.section));
  await settled();
  await device("Mobile");
  await selectSection(TEXT);
  say(
    "A23. Mobile inherits through Tablet",
    (await page.getByText("Inherited from Tablet: Fast · 0.18s").count()) > 0,
  );
  await choose("entrance", "No entrance");
  await until(async () => ((await motionOf(TEXT)).draft_motion_config?.section as { mobile?: unknown })?.mobile !== undefined);
  say(
    "A24. Mobile None is stored as Mobile's own entrance",
    same(((await motionOf(TEXT)).draft_motion_config?.section as { mobile?: unknown }).mobile, { entrance: "none" }),
  );
  await settled();
  await selectSection(TEXT);
  say(
    "A25. …and a width that does not move offers no timing",
    JSON.stringify(await offered()) === JSON.stringify(["entrance"]),
    JSON.stringify(await offered()),
  );
  await page.getByRole("button", { name: "Reset mobile motion" }).click();
  const mobileGone = await until(async () => ((await motionOf(TEXT)).draft_motion_config?.section as { mobile?: unknown })?.mobile === undefined);
  say("A26. resetting Mobile deletes the branch, so it inherits Tablet again", mobileGone);
  await settled();
  await device("Tablet");
  await selectSection(TEXT);
  await page.getByRole("button", { name: "Reset tablet motion" }).click();
  const tabletGone = await until(async () => ((await motionOf(TEXT)).draft_motion_config?.section as { tablet?: unknown })?.tablet === undefined);
  say("A27. resetting Tablet leaves Base exactly as it was", tabletGone && same(((await motionOf(TEXT)).draft_motion_config?.section as { base?: unknown }).base, { entrance: "mask", direction: "end", duration: "cinematic", easing: "soft-out", delay: 150 }));
  await settled();
  await device("Desktop");

  /* --- An element ------------------------------------------------------- */
  const BODY = `section:${TEXT}/field:body`;
  const bodySelected = await selectNode(BODY);
  say("A28. an element inside the section can be selected", bodySelected, await inspectorAddress());
  say("A29. …and edits that element's own motion", (await page.locator('[data-motion-target="element"]').count()) === 1);
  say("A30. …whose default is no entrance at all", (await shown("entrance")) === "Default — no entrance");
  // Batch 15b: parallax acts whether or not the element has an entrance, so it
  // is offered from the start; the entrance's own settings still wait for it.
  say(
    "A31. …and nothing else of the entrance is offered until it moves",
    JSON.stringify(await offered()) === JSON.stringify(["entrance", "parallax"]),
    JSON.stringify(await offered()),
  );
  await choose("entrance", "Fade up");
  const bodySaved = await until(async () =>
    same(((await motionOf(TEXT)).draft_motion_config?.nodes as Record<string, unknown>)?.["field:body"], { base: { entrance: "fade-up" } }),
  );
  say("A32. an element's motion is keyed by its stable path", bodySaved, JSON.stringify((await motionOf(TEXT)).draft_motion_config?.nodes));
  await settled();
  const bodyAttr = await frame().locator(`[data-eod-address="${BODY}"]`).first().getAttribute("data-m-reveal");
  say("A33. …and marks that element, with no wrapper added around it", bodyAttr === "");

  /* --- A list and its rows ----------------------------------------------- */
  const POINTS = `section:${WHY}/field:points`;
  const listSelected = await selectNode(POINTS);
  say("A34. a list is a motion target of its own", listSelected, await inspectorAddress());
  await choose("entrance", "Fade up");
  await control("stagger").waitFor({ timeout: 10_000 });
  say("A35. a moving list offers a stagger", (await offered()).includes("stagger"));
  await choose("stagger", "Normal");
  const listSaved = await until(async () =>
    same(((await motionOf(WHY)).draft_motion_config?.nodes as Record<string, unknown>)?.["field:points"], {
      base: { entrance: "fade-up", stagger: "normal" },
    }),
  );
  say("A36. …stored on the list", listSaved);
  await settled();
  const rowAddress = await frame()
    .locator(`[data-eod-address^="section:${WHY}/field:points/item:"]`)
    .first()
    .getAttribute("data-eod-address");
  const rowPath = (rowAddress ?? "").split("/").slice(0, 3).join("/");
  await selectNode(rowPath);
  say(
    "A37. a row of a staggering list says the list owns its entrance",
    (await page.locator('[data-motion-owned="list"]').count()) === 1,
    await inspectorAddress(),
  );

  /* --- Refusals ---------------------------------------------------------- */
  await open("?page=home&lang=en&device=desktop");
  await selectNode(`section:${homeHero!.id}/field:headline`);
  say(
    "A38. an element with its own keyframes is refused, with the reason",
    (await page.locator('[data-motion-refusal="own"]').count()) === 1,
  );

  /* --- Discard and reload ------------------------------------------------ */
  await open("?page=about&lang=en&device=desktop");
  await selectSection(TEXT);
  say("A39. a reload shows the saved document", (await shown("entrance")) === "Mask reveal", await shown("entrance"));
  await choose("entrance", "Scale in");
  await page.getByText("Unsaved motion").waitFor({ timeout: 10_000 });
  await page.getByRole("button", { name: "Discard changes" }).click();
  await until(async () => (await shown("entrance")) === "Mask reveal");
  say("A40. Discard changes puts the saved document back", (await shown("entrance")) === "Mask reveal");
  await quietFor(page, AUTOSAVE_QUIET_MS, "a discarded change would have been autosaved by now");
  say("A41. …and nothing was written", ((await motionOf(TEXT)).draft_motion_config?.section as { base?: { entrance?: string } }).base?.entrance === "mask");

  /* --- Arabic ------------------------------------------------------------ */
  await open("?page=about&lang=ar&device=desktop");
  await selectSection(TEXT);
  say(
    "A42. in Arabic the panel says the start edge is the right",
    (await page.getByText(/in Arabic, the right/).count()) > 0,
  );

  /* --- A reader ---------------------------------------------------------- */
  const readerContext = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  await readerContext.addCookies([cookieOf(viewer)]);
  const reader = await readerContext.newPage();
  await reader.goto(`${origin}/admin/visual-editor?page=about&lang=en&device=desktop`, { waitUntil: "load" });
  await reader.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  const readerRow = reader.locator(`aside[aria-label='Page structure'] [data-layer-row="section:${TEXT}"]`);
  await readerRow.waitFor({ timeout: 25_000 });
  await readerRow.click();
  await reader.getByRole("tab", { name: /Motion/ }).click();
  const readerSelect = reader.locator('[data-motion-field="entrance"] select');
  await readerSelect.waitFor({ timeout: 15_000 });
  say("A43. a reader sees the motion and cannot change it", await readerSelect.isDisabled());
  await readerContext.close();
  await editorContext.close();

  /* ======================================================================= */
  /* B. What each entrance does in the browser                                */
  /* ======================================================================= */

  await reset();
  const RENDER = doc(
    { base: { entrance: "blur" } },
    {
      "field:title": { base: { entrance: "mask", direction: "start" } },
      "field:body": { base: { entrance: "slide-in", direction: "start", duration: "cinematic", delay: 150, easing: "soft-out" } },
    },
  );
  await setDraft(TEXT, RENDER, "fade");
  await setDraft(IMAGE, doc({}, {
    "field:eyebrow": { base: { entrance: "mask", direction: "up" } },
    "field:title": { base: { entrance: "mask", direction: "down" } },
    "field:body": { base: { entrance: "slide-in", direction: "up" } },
    "field:image": { base: { entrance: "scale-in", duration: "fast" } },
  }));
  await setDraft(WHY, doc({}, { "field:points": { base: { entrance: "fade-up", stagger: "normal", delay: 100 } } }));

  const previewContext = async (options: Parameters<typeof browser.newContext>[0] = {}, script = ""): Promise<{ context: BrowserContext; page: Page }> => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
    await context.addCookies([cookieOf(owner)]);
    if (script) await context.addInitScript(script);
    return { context, page: await context.newPage() };
  };
  const computed = (target: Page, selector: string, props: string[]) =>
    target.locator(selector).first().evaluate(
      (node, names) => Object.fromEntries((names as string[]).map((name) => [name, getComputedStyle(node).getPropertyValue(name).trim()])),
      props,
    );
  /**
   * An `inset()` as its four edges — top, right, bottom, left — whether the
   * browser wrote one to four values, and whether it wrote a plain length or
   * the calc() a paused interpolation serialises as.
   */
  const insets = (clip: string): string[] => {
    const inner = /^inset\((.*)\)$/.exec(clip.trim())?.[1] ?? "";
    const parts: string[] = [];
    let depth = 0;
    let current = "";
    for (const ch of inner) {
      if (ch === "(") depth += 1;
      if (ch === ")") depth -= 1;
      if (ch === " " && depth === 0) {
        if (current) parts.push(current);
        current = "";
      } else current += ch;
    }
    if (current) parts.push(current);
    if (!parts.length) return [];
    const [top, right = top, bottom = top, left = right] = parts;
    return [top!, right!, bottom!, left!];
  };
  /** A whole edge covered: `100%`, or `calc(100% + (0 * …))` at time 0. */
  const covered = (edge: string | undefined) => !!edge && /^(calc\()?100%/.test(edge);
  /** An edge a whole viewport outside the box: nothing cut there. */
  const uncut = (edge: string | undefined) => !!edge && /^(calc\()?-\d/.test(edge);
  /**
   * The first frame of an element's entrance: shown, then every animation on
   * it held at time 0. What a visitor sees the instant a wipe begins.
   */
  const firstFrame = (target: Page, selector: string) =>
    target.locator(selector).first().evaluate((node) => {
      node.setAttribute("data-shown", "true");
      for (const animation of node.getAnimations()) {
        animation.pause();
        animation.currentTime = 0;
      }
      const style = getComputedStyle(node);
      return { clip: style.clipPath, opacity: style.opacity };
    });

  for (const [lang, prefix] of [["EN", ""], ["AR", "/ar"]] as const) {
    const { context, page: view } = await previewContext({}, FROZEN);
    await view.goto(`${origin}${prefix}/about?preview=1`, { waitUntil: "load" });
    say(`B1 ${lang}. the page is in its reading direction`, (await view.evaluate(() => document.documentElement.dir)) === (lang === "AR" ? "rtl" : "ltr"));

    const wrapper = `[data-section="rich-text"]`;
    const blur = await computed(view, wrapper, ["filter", "opacity", "translate"]);
    say(`B2 ${lang}. Blur starts blurred, transparent and slightly low`, blur.filter === "blur(8px)" && blur.opacity === "0" && blur.translate === "0px 8px", JSON.stringify(blur));

    // Waiting, a mask is invisible and unclipped — so the observer can reach it.
    const waiting = await computed(view, `${wrapper} h2`, ["clip-path", "opacity"]);
    say(
      `B3 ${lang}. a mask waits invisible, never clipped`,
      waiting["clip-path"] === "none" && waiting.opacity === "0",
      JSON.stringify(waiting),
    );
    const title = await firstFrame(view, `${wrapper} h2`);
    const [top, right, bottom, left] = insets(title.clip);
    const startCovered = lang === "AR" ? covered(left) && uncut(right) : covered(right) && uncut(left);
    say(
      `B3b ${lang}. Mask from the start begins covered from the ${lang === "AR" ? "left" : "right"}, the end edge, and opaque`,
      startCovered && uncut(top) && uncut(bottom) && title.opacity === "1",
      JSON.stringify(title),
    );

    const body = await computed(view, `${wrapper} .prose-eod`, ["translate"]);
    say(
      `B4 ${lang}. Slide from the start edge comes from ${lang === "AR" ? "the right" : "the left"}`,
      body.translate === (lang === "AR" ? "24px" : "-24px"),
      JSON.stringify(body),
    );

    const image = `[data-section="image-text"]`;
    const up = await firstFrame(view, `${image} .eyebrow`);
    const down = await firstFrame(view, `${image} h2`);
    const [upTop, upRight, upBottom, upLeft] = insets(up.clip);
    const [downTop, downRight, downBottom, downLeft] = insets(down.clip);
    say(
      `B5 ${lang}. Mask upward starts with the top covered, and only the top`,
      covered(upTop) && uncut(upRight) && uncut(upBottom) && uncut(upLeft),
      JSON.stringify(up),
    );
    say(
      `B6 ${lang}. Mask downward starts with the bottom covered, and only the bottom`,
      covered(downBottom) && uncut(downTop) && uncut(downRight) && uncut(downLeft),
      JSON.stringify(down),
    );
    const rise = await computed(view, `${image} .prose-eod`, ["translate"]);
    say(`B7 ${lang}. Slide upward rises from below, the same in both directions`, rise.translate === "0px 24px", JSON.stringify(rise));

    /* timing, read from the running animation */
    await view.locator(`${wrapper} .prose-eod`).first().evaluate((node) => node.setAttribute("data-shown", "true"));
    const timing = await computed(view, `${wrapper} .prose-eod`, ["animation-name", "animation-duration", "animation-delay", "animation-timing-function", "animation-fill-mode"]);
    // Longhands: one name per animation, and one value every name shares.
    say(
      `B8 ${lang}. Cinematic, 150ms and Soft out are exactly the design system's`,
      timing["animation-name"] === "eod-m-enter, none" &&
        timing["animation-duration"] === "1.2s" &&
        timing["animation-delay"] === "0.15s" &&
        timing["animation-timing-function"] === "cubic-bezier(0.22, 0.61, 0.24, 1)" &&
        timing["animation-fill-mode"] === "backwards",
      JSON.stringify(timing),
    );
    // The picture's frame, which comes first in the markup.
    const frameBox = view.locator(`${image} .overflow-hidden[data-m-reveal]`).first();
    await frameBox.evaluate((node) => node.setAttribute("data-shown", "true"));
    const fast = await frameBox.evaluate((node) => getComputedStyle(node).animationDuration);
    say(`B9 ${lang}. Fast is 0.18s`, fast === "0.18s", fast);
    await view.locator(wrapper).first().evaluate((node) => node.setAttribute("data-shown", "true"));
    const standard = await computed(view, wrapper, ["animation-duration", "animation-timing-function"]);
    say(
      `B10 ${lang}. an untimed entrance runs on the legacy timing, Slow and Expo out`,
      standard["animation-duration"] === "0.76s" &&
        standard["animation-timing-function"] === "cubic-bezier(0.16, 1, 0.3, 1)",
      JSON.stringify(standard),
    );
    await view.locator(`${wrapper} h2`).first().evaluate((node) => node.setAttribute("data-shown", "true"));
    const mask = await computed(view, `${wrapper} h2`, ["animation-name"]);
    say(`B11 ${lang}. a mask runs its wipe beside the entrance`, mask["animation-name"] === "eod-m-enter, eod-m-mask", JSON.stringify(mask));

    /* stagger */
    const list = `[data-section="why-us"] ul`;
    say(`B12 ${lang}. a staggering list is one group`, (await view.locator(`${list}[data-m-group]`).count()) === 1);
    const members = await view.locator(`${list} > li`).evaluateAll((nodes) =>
      nodes.map((n) => [(n as HTMLElement).hasAttribute("data-m-member"), (n as HTMLElement).className.includes("reveal")]),
    );
    say(
      `B13 ${lang}. …whose rows are members, with no legacy reveal of their own`,
      members.length > 1 && members.every(([member, legacy]) => member && !legacy),
      JSON.stringify(members),
    );
    const hiddenRows = await view.locator(`${list} > li`).evaluateAll((nodes) => nodes.map((n) => getComputedStyle(n).opacity));
    say(`B14 ${lang}. …hidden until the list is reached`, hiddenRows.every((o) => o === "0"), JSON.stringify(hiddenRows));
    await view.locator(list).first().evaluate((node) => node.setAttribute("data-shown", "true"));
    const delays = await view.locator(`${list} > li`).evaluateAll((nodes) =>
      nodes.map((n) => getComputedStyle(n).animationDelay.split(",")[0]!.trim()),
    );
    const expected = delays.map((_, i) => `${(100 + 80 * Math.min(i, 8)) / 1000}s`);
    say(`B15 ${lang}. …then arrive in turn, 80ms apart after the list's own delay`, JSON.stringify(delays) === JSON.stringify(expected), JSON.stringify(delays));
    await context.close();
  }

  /* --- the finished state, after a real scroll --------------------------- */
  {
    const { context, page: view } = await previewContext({}, COUNT_SCROLL);
    await view.goto(`${origin}/about?preview=1`, { waitUntil: "load" });
    await view.waitForFunction(() => typeof (window as unknown as { __eodMotion?: unknown }).__eodMotion === "function", null, { timeout: 20_000 });
    const stats = await view.evaluate(() => (window as unknown as { __eodMotion?: () => { observers: number; waiting: number } }).__eodMotion?.());
    say("B16. one observer serves every waiting element", stats?.observers === 1 && (stats?.waiting ?? 0) > 0, JSON.stringify(stats));
    for (let y = 0; y < 12; y += 1) {
      await view.mouse.wheel(0, 700);
      await view.waitForTimeout(250);
    }
    // Until every entrance the scroll reached has been released and has run
    // to its end — the state B17 and B18 read (Batch 19A: was a fixed 2.6 s).
    await until(
      () =>
        view.evaluate(() => {
          const stats = (window as unknown as { __eodMotion?: () => { waiting: number } }).__eodMotion?.();
          const running = document
            .getAnimations()
            .filter((a) => a.playState === "running" && Number.isFinite(a.effect?.getComputedTiming().endTime as number)).length;
          return stats?.waiting === 0 && running === 0;
        }),
      75, // × 200 ms: fifteen seconds
    );
    const after = await view.evaluate(() => (window as unknown as { __eodMotion?: () => { observers: number; waiting: number } }).__eodMotion?.());
    say("B17. …and releases each one once it has arrived", after?.observers === 1 && after?.waiting === 0, JSON.stringify(after));
    const finished = await view.locator("[data-m-reveal], [data-m-group] > *").evaluateAll((nodes) =>
      nodes.map((n) => {
        const style = getComputedStyle(n);
        return [style.opacity, style.translate, style.scale, style.filter, style.clipPath].join("|");
      }),
    );
    say(
      "B18. every element finishes whole: opaque, in place, unblurred, unclipped",
      finished.length > 5 && finished.every((state) => state === "1|none|none|none|none"),
      JSON.stringify([...new Set(finished)]),
    );
    const listeners = await view.evaluate(() => (window as unknown as { __scrollListeners: number }).__scrollListeners);
    await context.close();
    // The same page with no motion at all: whatever the framework attaches
    // for itself is the baseline, and motion must add nothing to it.
    const saved = await motionOf(TEXT);
    await sql`update page_sections set draft_motion_config = null, draft_animation = null where page_id = ${about!.id}`;
    const plain = await previewContext({}, COUNT_SCROLL);
    await plain.page.goto(`${origin}/about?preview=1`, { waitUntil: "load" });
    // Every script loaded and run: nothing left on the network, the page
    // hydrated — its effects are what attach listeners, and on a slow machine
    // they can still be running when the network goes quiet (Batch 19A) — and
    // the count holding for twenty frames. Bounded.
    await plain.page.waitForLoadState("networkidle");
    await plain.page.waitForFunction(
      () => {
        const header = document.querySelector("header");
        return !!header && Object.keys(header).some((key) => key.startsWith("__react"));
      },
      undefined,
      { timeout: 15_000 },
    );
    await plain.page.evaluate(() => {
      const holder = window as unknown as { __name?: unknown };
      holder.__name = holder.__name || ((fn: unknown) => fn);
    });
    await plain.page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          const count = () => (window as unknown as { __scrollListeners: number }).__scrollListeners;
          let last = count();
          let same = 0;
          const started = performance.now();
          const tick = () => {
            const now = count();
            same = now === last ? same + 1 : 0;
            last = now;
            if (same >= 20 || performance.now() - started > 5000) resolve();
            else requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }),
    );
    const baseline = await plain.page.evaluate(() => (window as unknown as { __scrollListeners: number }).__scrollListeners);
    await plain.context.close();
    say(
      "B19. motion attaches no scroll listener of its own",
      listeners === baseline,
      `with motion ${listeners}, without ${baseline}`,
    );
    await setDraft(TEXT, saved.draft_motion_config as Doc, "fade");
    await setDraft(IMAGE, doc({}, {
      "field:eyebrow": { base: { entrance: "mask", direction: "up" } },
      "field:title": { base: { entrance: "mask", direction: "down" } },
      "field:body": { base: { entrance: "slide-in", direction: "up" } },
      "field:image": { base: { entrance: "scale-in", duration: "fast" } },
    }));
    await setDraft(WHY, doc({}, { "field:points": { base: { entrance: "fade-up", stagger: "normal", delay: 100 } } }));
  }

  /* --- the three widths --------------------------------------------------- */
  await setDraft(TEXT, doc(
    { base: { entrance: "blur", duration: "slow" }, tablet: { duration: "fast" }, mobile: { entrance: "none" } },
  ), "fade");
  for (const [label, width, expectation] of [
    ["Desktop", 1440, { filter: ["blur(8px)"], duration: "0.76s" }],
    ["Tablet", 834, { filter: ["blur(8px)"], duration: "0.18s" }],
    // An entrance of None waits at the identity: no blur, whether the browser
    // spells it `none` or `blur(0px)`.
    ["Mobile", 390, { filter: ["none", "blur(0px)"], duration: "0.18s" }],
  ] as const) {
    const { context, page: view } = await previewContext({ viewport: { width, height: 900 } }, FROZEN);
    await view.goto(`${origin}/about?preview=1`, { waitUntil: "load" });
    const hidden = await computed(view, `[data-section="rich-text"]`, ["filter", "opacity"]);
    await view.locator(`[data-section="rich-text"]`).first().evaluate((node) => node.setAttribute("data-shown", "true"));
    const running = await computed(view, `[data-section="rich-text"]`, ["animation-duration"]);
    say(
      `B20 ${label}. ${label === "Mobile" ? "Mobile None is simply there, inheriting Tablet's timing" : label === "Tablet" ? "Tablet's own duration, Base's entrance" : "Base as written"}`,
      (expectation.filter as readonly string[]).includes(hidden.filter!) &&
        (label === "Mobile" ? hidden.opacity === "1" : hidden.opacity === "0") &&
        running["animation-duration"] === expectation.duration,
      JSON.stringify({ hidden, running }),
    );
    await context.close();
  }

  /* --- reduced motion, print, no script ---------------------------------- */
  await setDraft(TEXT, RENDER, "fade");
  const whole = (states: string[]) => states.length > 3 && states.every((state) => state === "1|none|none|none|none");
  const everyAdvanced = (view: Page) =>
    view.locator("[data-m-reveal], [data-m-group] > *").evaluateAll((nodes) =>
      nodes.map((n) => {
        const style = getComputedStyle(n);
        return [style.opacity, style.translate, style.scale, style.filter, style.clipPath].join("|");
      }),
    );
  {
    const { context, page: view } = await previewContext({ reducedMotion: "reduce" });
    await view.goto(`${origin}/about?preview=1`, { waitUntil: "load" });
    const states = await everyAdvanced(view);
    say("B21. reduced motion: every advanced element is already in place, without a scroll", whole(states), JSON.stringify([...new Set(states)]));
    await context.close();
  }
  {
    const { context, page: view } = await previewContext({}, FROZEN);
    await view.goto(`${origin}/about?preview=1`, { waitUntil: "load" });
    await view.emulateMedia({ media: "print" });
    const states = await everyAdvanced(view);
    say("B22. print: nothing hidden, clipped, blurred or displaced", whole(states), JSON.stringify([...new Set(states)]));
    await context.close();
  }
  {
    const { context, page: view } = await previewContext({ javaScriptEnabled: false });
    await view.goto(`${origin}/about?preview=1`, { waitUntil: "load" });
    const states = await everyAdvanced(view);
    say("B23. no JavaScript: everything is shown at once", whole(states), JSON.stringify([...new Set(states)]));
    await context.close();
  }

  /* ======================================================================= */
  /* C. Composition with what was already there                               */
  /* ======================================================================= */

  await reset();
  // Style opacity on an element that fades: it is where the fade lands.
  await setStyles(TEXT, { "field:body": { base: { opacity: 0.5 } }, root: { base: { opacity: 0.6 } } });
  await setDraft(TEXT, doc({}, { "field:body": { base: { entrance: "fade" } } }));
  // A button with an entrance, and a glowing box with a mask.
  await setDraft(CTA, doc({}, { "field:primaryCtaLabel": { base: { entrance: "fade-up" } } }));
  await setStyles(IMAGE, { "field:image": { base: { glow: "strong" } } });
  await setDraft(IMAGE, doc({}, { "field:image": { base: { entrance: "mask", direction: "start" } } }));
  {
    const { context, page: view } = await previewContext({}, FROZEN);
    await view.goto(`${origin}/about?preview=1`, { waitUntil: "load" });
    const body = `[data-section="rich-text"] .prose-eod`;
    const hidden = await computed(view, body, ["opacity"]);
    await view.locator(body).first().evaluate((node) => node.setAttribute("data-shown", "true"));
    await animationsDone(view.locator(body).first());
    const landed = await computed(view, body, ["opacity"]);
    say("C1. a fade starts at nothing and lands on the Style opacity", hidden.opacity === "0" && landed.opacity === "0.5", JSON.stringify({ hidden, landed }));

    // The section itself is a legacy reveal at 0.6; the reveal inside it must
    // not inherit that number as its own finished opacity.
    await view.locator(`[data-section="rich-text"]`).first().evaluate((node) => node.setAttribute("data-shown", "true"));
    await view.locator(`[data-section="rich-text"] .reveal`).first().evaluate((node) => node.setAttribute("data-shown", "true"));
    await animationsDone(view.locator(`[data-section="rich-text"] .reveal`).first());
    const nested = await view.locator(`[data-section="rich-text"] .reveal`).first().evaluate((node) => getComputedStyle(node).opacity);
    const section = await view.locator(`[data-section="rich-text"]`).first().evaluate((node) => getComputedStyle(node).opacity);
    say("C2. a translucent section does not make the reveals inside it translucent again", section === "0.6" && nested === "1", JSON.stringify({ section, nested }));

    const button = view.locator(`[data-section="final-cta"] .btn-primary`).first();
    await button.evaluate((node) => node.setAttribute("data-shown", "true"));
    await animationsDone(button);
    await button.scrollIntoViewIfNeeded();
    await button.hover();
    await animationsDone(button);
    const hover = await button.evaluate((node) => {
      const style = getComputedStyle(node);
      return { transform: style.transform, translate: style.translate, transition: style.transitionProperty };
    });
    say(
      "C3. an entrance on a button leaves its hover lift working",
      hover.transform !== "none" && hover.translate === "none" && /transform/.test(hover.transition),
      JSON.stringify(hover),
    );

    const frameBox = view.locator(`[data-section="image-text"] [data-m-reveal]`).first();
    await frameBox.evaluate((node) => node.setAttribute("data-shown", "true"));
    await animationsDone(frameBox);
    const glow = await frameBox.evaluate((node) => ({ clip: getComputedStyle(node).clipPath, shadow: getComputedStyle(node).boxShadow }));
    say("C4. a mask ends unclipped, so a Batch 14 glow is whole", glow.clip === "none" && glow.shadow !== "none", JSON.stringify(glow));
    await context.close();
  }

  /* ======================================================================= */
  /* D. Draft, publish, restore, discard                                      */
  /* ======================================================================= */

  await reset();
  const pageRevision = async () => (await sql<{ revision: number }[]>`select revision from pages where id = ${about!.id}`)[0]!.revision;
  const action = <T,>(name: string, form: FormData) =>
    callAction<T>({ origin, route: "/admin/visual-editor", file: "app/(backoffice)/admin/visual-editor/actions.ts", action: name, args: [form], cookie: owner.cookie });
  const pageForm = async (extra: Record<string, string> = {}) => {
    const form = new FormData();
    form.set("_csrf", owner.csrfToken);
    form.set("pageId", String(about!.id));
    form.set("expectedRevision", String(await pageRevision()));
    for (const [key, value] of Object.entries(extra)) form.set(key, value);
    return form;
  };
  const publicHtml = async (wanted: string | null) => {
    let html = "";
    for (let i = 0; i < 40; i += 1) {
      html = await fetch(`${origin}/about`).then((r) => r.text());
      if (wanted === null || html.includes(wanted)) return html;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return html;
  };
  const previewHtml = () => fetch(`${origin}/about?preview=1`, { headers: { cookie: owner.cookie } }).then((r) => r.text());

  const A = doc({ base: { entrance: "blur" } }, { "field:body": { base: { entrance: "mask", direction: "end" } } });
  await setDraft(TEXT, A, "fade");
  say("D1. the draft is in the preview", /--m-blur:8px/.test(await previewHtml()));
  say("D2. …and a visitor's page does not have it", !/data-m-/.test(await publicHtml(null)));

  const published = await action<{ ok: boolean }>("publishPageFromEditor", await pageForm());
  say("D3. publishing promotes it", published.value?.ok === true && same((await motionOf(TEXT)).motion_config, A));
  say("D4. …with the preset the previous release reads", (await motionOf(TEXT)).animation === "fade");
  say("D5. …and a visitor now gets it", /--m-blur:8px/.test(await publicHtml("--m-blur:8px")));

  await setDraft(TEXT, doc(), "fade");
  await action("publishPageFromEditor", await pageForm());
  say("D6. publishing a reset removes it", (await motionOf(TEXT)).motion_config === null && !/data-m-/.test(await publicHtml(null)));

  const history = await callAction<{ versions: { id: number }[] }>({
    origin,
    route: "/admin/visual-editor",
    file: "app/(backoffice)/admin/visual-editor/actions.ts",
    action: "loadPageHistory",
    args: [about!.id],
    cookie: owner.cookie,
  });
  const restored = await action<{ ok: boolean }>("restoreVersionFromEditor", await pageForm({ versionId: String(history.value!.versions[0]!.id) }));
  say("D7. restoring the version that had it puts it back as a draft", restored.value?.ok === true && same((await motionOf(TEXT)).draft_motion_config, A));
  say("D8. …the preview shows it", /--m-blur:8px/.test(await previewHtml()));
  say("D9. …and the live page still does not", !/data-m-/.test(await publicHtml(null)));

  const discarded = await action<{ ok: boolean }>("discardPageFromEditor", await pageForm());
  say("D10. discarding throws the restored document away", discarded.value?.ok === true && (await motionOf(TEXT)).draft_motion_config === null);
  say("D11. …and the page has nothing waiting", (await sql<{ n: number }[]>`
    select count(*)::int as n from page_sections
     where page_id = ${about!.id} and (draft_motion_config is not null or draft_animation is not null)`)[0]!.n === 0);
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
