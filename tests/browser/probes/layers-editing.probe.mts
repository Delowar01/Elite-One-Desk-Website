/**
 * Batch 13 acceptance: the full Layers tree, element locking and direct
 * on-canvas text editing, in a real browser against the production build.
 */

import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { canvasRedrawn, canvasUrl, editorSettled } from "../canvas";
import { launchChromium } from "../harness";
import { AUTOSAVE_QUIET_MS, quietFor } from "../wait";

const PORT = 3714;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("layers_editing");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);

  const [home] = await sql<{ id: number }[]>`select id from pages where slug = 'home'`;
  const [hero] = await sql<{ id: number; published: Record<string, unknown> }[]>`
    select id, published from page_sections where page_id = ${home!.id} and block_type = 'hero' limit 1`;
  const [links] = await sql<{ id: number; published: Record<string, unknown> }[]>`
    select id, published from page_sections where page_id = ${home!.id} and block_type = 'quick-links' limit 1`;
  const rows = (links!.published.links as Record<string, unknown>[]) ?? [];
  const firstRow = String(rows[0]!._id);

  const headline = `section:${hero!.id}/field:headline`;
  const rowAddress = `section:${links!.id}/field:links/item:${firstRow}`;
  const labelAddress = `${rowAddress}/field:label`;
  const imageAddress = `${rowAddress}/field:image`;

  type Row = { revision: number; draft: Record<string, unknown> | null };
  const state = async (id: number): Promise<Row> =>
    (await sql<Row[]>`select revision, draft from page_sections where id = ${id}`)[0]!;
  const draftText = (row: Row, field: string, locale: "en" | "ar"): string =>
    String(((row.draft?.[field] as Record<string, string>) ?? {})[locale] ?? "");

  const until = async (what: () => Promise<boolean>, ms = 30_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await what()) return true;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };

  const context = await browser.newContext({ viewport: { width: 1720, height: 1020 }, reducedMotion: "reduce" });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("   [pageerror]", error.message.slice(0, 140)));

  const open = async (query: string) => {
    await page.goto(`${server!.origin}/admin/visual-editor${query}`, { waitUntil: "load" });
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
  };
  /**
   * The canvas frame, waited for rather than assumed.
   *
   * A save refreshes the canvas, and for a moment between the old document
   * going and the new one arriving there is no frame with an editor URL at
   * all. Reaching for one then returns `undefined` and the next property
   * access throws — which is the harness outrunning the browser, not the
   * application misbehaving.
   */
  const frameNow = async () => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const found = page.frames().find((f) => f.url().includes("editor=1"));
      if (found) return found;
      if (Date.now() > deadline) throw new Error("the canvas frame never arrived");
      await page.waitForTimeout(150);
    }
  };
  const canvasNodeReady = async (address: string) =>
    (await frameNow()).locator(`[data-eod-address="${address}"]`);
  const layerRow = (address: string) => page.locator(`[data-layer-row="${address}"]`);
  const inspectorAddress = async (): Promise<string> => {
    const codes = await page.locator("aside[aria-label='Inspector'] code").allTextContents();
    return codes.map((t) => t.trim()).find((t) => t.startsWith("section:")) ?? "";
  };

  /**
   * What the inspector settles on, read once.
   *
   * Selecting is a round trip — the editor posts `editor.select`, the canvas
   * answers `canvas.selection`, and only then does the panel change — so
   * sampling the moment after a click measures the network. This waits for the
   * address being asserted and returns a single value, which is used for both
   * the verdict and the message: reading it twice let the two disagree, and a
   * FAIL whose detail shows the expected value is a report of the probe's own
   * impatience rather than of anything the editor did.
   */
  const settled = async (want: string, ms = 20_000): Promise<string> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const current = await inspectorAddress();
      if (current === want || Date.now() > deadline) return current;
      await page.waitForTimeout(150);
    }
  };
  /** The same, for a case where the wanted answer is "anything but this". */
  const settledAwayFrom = async (avoid: string, ms = 20_000): Promise<string> => {
    const deadline = Date.now() + ms;
    for (;;) {
      const current = await inspectorAddress();
      if ((current && current !== avoid) || Date.now() > deadline) return current;
      await page.waitForTimeout(150);
    }
  };
  /**
   * A point inside a node that really belongs to it.
   *
   * The centre is not always one. The Hero's rotating words are rendered
   * *inside* the `<h1>`, so the middle of the headline is genuinely the words'
   * — and the editor is right to select them, by the same rule that makes
   * pointing at a Quick Links picture select the picture rather than the card.
   * Clicking the middle and calling the result a headline failure would be the
   * probe testing its own aim.
   *
   * So the point is found rather than assumed: candidate points across the
   * node's box, and the first one whose topmost annotated element is this node
   * wins. Returned as an offset within the box, which is what Playwright wants.
   */
  const pointOn = async (address: string): Promise<{ x: number; y: number } | null> =>
    (await frameNow()).evaluate(`(() => {
      const el = document.querySelector('[data-eod-address="${address}"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      const fractions = [0.5, 0.12, 0.88, 0.3, 0.7];
      for (const fy of fractions) {
        for (const fx of fractions) {
          const x = r.x + r.width * fx;
          const y = r.y + r.height * fy;
          const stack = document.elementsFromPoint(x, y);
          let found = null;
          for (const candidate of stack) {
            const node = candidate.closest('[data-eod-node]');
            if (node) { found = node; break; }
          }
          if (found === el) return { x: r.width * fx, y: r.height * fy };
        }
      }
      return null;
    })()`) as Promise<{ x: number; y: number } | null>;

  /** Click a canvas node where it is genuinely itself. */
  const clickCanvas = async (address: string) => {
    const element = await canvasNodeReady(address);
    await element.waitFor({ state: "visible", timeout: 25_000 });
    await element.scrollIntoViewIfNeeded().catch(() => undefined);
    const position = await pointOn(address);
    await element.click({ timeout: 10_000, ...(position ? { position } : {}) });
    await page.getByRole("tab", { name: /Motion/ }).waitFor({ timeout: 25_000 });
  };

  const dblCanvas = async (address: string) => {
    const element = await canvasNodeReady(address);
    await element.waitFor({ state: "visible", timeout: 25_000 });
    const position = await pointOn(address);
    await element.dblclick({ timeout: 10_000, ...(position ? { position } : {}) });
  };

  await open("?page=home&lang=en&device=desktop");

  /* --- 1-3. canvas selection, Layers follows, Layers selects --------- */
  await clickCanvas(headline);
  const shown1 = await settled(headline);
  say("1. the Hero headline is selected by pointing at it", shown1 === headline, shown1);

  const heroRow = layerRow(`section:${hero!.id}`);
  await heroRow.waitFor({ timeout: 20_000 });
  const headlineRow = layerRow(headline);
  say("2. Layers opened itself to Hero → Headline", (await headlineRow.count()) > 0);
  say("…and the row is marked as the current one",
    (await headlineRow.getAttribute("aria-current")) === "true");

  await clickCanvas(`section:${hero!.id}/field:eyebrow`);
  await headlineRow.click();
  const shown3 = await settled(headline);
  say("3. selecting that row selects the same canvas node", shown3 === headline, shown3);

  /* --- 4-6. direct editing in English --------------------------------- */
  const beforeEn = await state(hero!.id);
  const element = await canvasNodeReady(headline);
  await dblCanvas(headline);
  await page.waitForTimeout(300);
  say("4. a double-click makes the headline editable on the canvas",
    (await element.getAttribute("contenteditable")) === "plaintext-only");
  await element.selectText();
  await page.keyboard.type("Typed straight onto the page");
  await page.keyboard.press("Enter");

  const landedEn = await until(async () => draftText(await state(hero!.id), "headline", "en") === "Typed straight onto the page");
  say("6. autosave carried it through the ordinary queue", landedEn,
    draftText(await state(hero!.id), "headline", "en"));
  say("…and the revision moved exactly once", (await state(hero!.id)).revision === beforeEn.revision + 1,
    `${beforeEn.revision} → ${(await state(hero!.id)).revision}`);

  await page.getByRole("tab", { name: /Content/ }).click();
  const field = page.locator("#field-headline-en");
  await field.waitFor({ timeout: 15_000 });
  say("5. the Inspector is showing the same text", (await field.inputValue()) === "Typed straight onto the page",
    await field.inputValue());

  /* --- 7. a reload keeps the page and the value ----------------------- */
  await open("?page=home&lang=en&device=desktop");
  await clickCanvas(headline);
  const shown7 = await settled(headline);
  const text7 = await (await canvasNodeReady(headline)).innerText();
  say("7. after a reload the node is still selectable and still says it",
    shown7 === headline && text7.includes("Typed straight onto the page"),
    `${shown7} / ${text7.replace(/\s+/g, " ").slice(0, 60)}`);

  /* --- 8-10. Arabic ---------------------------------------------------- */
  await open("?page=home&lang=ar&device=desktop");
  const arabicNode = await canvasNodeReady(headline);
  await arabicNode.waitFor({ state: "visible", timeout: 25_000 });
  await dblCanvas(headline);
  await page.waitForTimeout(300);
  await arabicNode.selectText();
  await page.keyboard.type("مكتوب على الصفحة");
  await page.keyboard.press("Enter");
  const landedAr = await until(async () => draftText(await state(hero!.id), "headline", "ar") === "مكتوب على الصفحة");
  say("9. the Arabic canvas edits the Arabic value", landedAr,
    draftText(await state(hero!.id), "headline", "ar"));
  say("10. and the English value is exactly as it was",
    draftText(await state(hero!.id), "headline", "en") === "Typed straight onto the page",
    draftText(await state(hero!.id), "headline", "en"));
  say("8. the Arabic canvas laid out right to left",
    (await (await frameNow()).locator("html").getAttribute("dir")) === "rtl");

  /* --- 11-14. a repeatable row ---------------------------------------- */
  await open("?page=home&lang=en&device=desktop");
  await clickCanvas(labelAddress);
  const shown13 = await settled(labelAddress);
  say("13. pointing at the card's title selects the label", shown13 === labelAddress, shown13);
  await clickCanvas(imageAddress);
  const shown12 = await settled(imageAddress);
  say("12. pointing at the picture selects the image", shown12 === imageAddress, shown12);
  say("11. the row itself is reachable from Layers", (await layerRow(rowAddress).count()) > 0);
  say("14. Layers names the row by its own `_id`",
    (await page.locator(`[data-layer-node="${rowAddress}"]`).count()) === 1, rowAddress);

  const rowLabel = await layerRow(rowAddress).innerText();
  say("…and shows its words rather than an id", !rowLabel.includes("i_") && rowLabel.trim().length > 0,
    rowLabel.replace(/\s+/g, " ").trim());

  /* --- 15-18. locking --------------------------------------------------- */
  await page.locator(`[data-layer-lock="${imageAddress}"]`).click();
  await page.waitForTimeout(400);
  say("15. the node is locked", (await page.locator(`[data-layer-lock="${imageAddress}"]`).getAttribute("aria-pressed")) === "true");

  await clickCanvas(imageAddress);
  const afterLock = await settledAwayFrom(imageAddress);
  say("16. the canvas will not select it any more", afterLock !== imageAddress, afterLock);
  say("…and selects what contains it instead", afterLock === rowAddress || afterLock === `section:${links!.id}`,
    afterLock);

  await layerRow(imageAddress).click();
  const shown17 = await settled(imageAddress);
  say("17. Layers can still select it", shown17 === imageAddress, shown17);

  await page.locator(`[data-layer-lock="${imageAddress}"]`).click();
  await page.waitForTimeout(400);
  await clickCanvas(imageAddress);
  const shown18 = await settled(imageAddress);
  say("18. unlocked, the canvas selects it again", shown18 === imageAddress, shown18);

  /* --- 19B: a lock belongs to this view of this page, never to a record -- */
  /**
   * Locking is a convenience of one editor tab. It survives what keeps the
   * same page on screen — another canvas width, the other language, whose
   * canvas is a new document and has to be told again — and is cleared with
   * the page, whose section ids it names. It is never saved: a reload starts
   * with nothing locked, and locking writes no revision, row or activity entry.
   *
   * Each canvas check first selects the image from Layers (which a lock never
   * prevents), so "the canvas did not select it" is read as a move *away* from
   * it, not as a stale answer from before the click.
   */
  const lockOf = () => page.locator(`[data-layer-lock="${imageAddress}"]`);
  const locked = async () => (await lockOf().getAttribute("aria-pressed").catch(() => null)) === "true";
  const recorded = async () => ({
    section: await state(links!.id),
    page: (await sql<{ revision: number }[]>`select revision from pages where id = ${home!.id}`)[0]!.revision,
    activity: (await sql<{ n: number }[]>`select count(*)::int as n from activity_logs`)[0]!.n,
  });
  const canvasRefuses = async () => {
    await layerRow(imageAddress).click();
    await settled(imageAddress);
    await clickCanvas(imageAddress);
    return settledAwayFrom(imageAddress);
  };
  const canvasAccepts = async () => {
    await clickCanvas(headline);
    await settled(headline);
    await clickCanvas(imageAddress);
    return settled(imageAddress);
  };
  const before19B = await recorded();

  await lockOf().click();
  await until(locked, 5_000);
  await page.getByRole("group", { name: "Canvas width" }).getByRole("button", { name: /Tablet/ }).click();
  await editorSettled(page);
  say("19B · a lock is kept when the canvas changes width", await locked());

  const englishCanvas = canvasUrl(page);
  await page.getByRole("group", { name: "Canvas language" }).getByRole("button", { name: "العربية" }).click();
  await canvasRedrawn(page, englishCanvas);
  await editorSettled(page);
  say("19B · …and when it changes language", (await locked()) && canvasUrl(page).includes("/ar"), canvasUrl(page));
  const arabicPick = await canvasRefuses();
  say("19B · the new Arabic canvas is told about the lock again", arabicPick !== imageAddress, arabicPick);

  const arabicCanvas = canvasUrl(page);
  await page.getByRole("group", { name: "Canvas language" }).getByRole("button", { name: "English" }).click();
  await canvasRedrawn(page, arabicCanvas);
  await page.getByRole("group", { name: "Canvas width" }).getByRole("button", { name: /Desktop/ }).click();
  await editorSettled(page);

  await page.selectOption("#ve-page", "about");
  await editorSettled(page);
  await page.selectOption("#ve-page", "home");
  await editorSettled(page);
  const afterPage = await canvasAccepts();
  say("19B · a lock is cleared with the page", afterPage === imageAddress && !(await locked()), afterPage);

  await layerRow(imageAddress).click();
  await settled(imageAddress);
  await lockOf().click();
  await until(locked, 5_000);
  await open("?page=home&lang=en&device=desktop");
  const afterReload = await canvasAccepts();
  say("19B · a reload starts with nothing locked", afterReload === imageAddress, afterReload);
  const after19B = await recorded();
  say(
    "19B · locking and unlocking wrote nothing: no revision, no row, no activity entry",
    JSON.stringify(after19B) === JSON.stringify(before19B),
    `${JSON.stringify(before19B).slice(0, 80)} → ${JSON.stringify(after19B).slice(0, 80)}`,
  );

  /* --- 19-21. geometry at three widths --------------------------------- */
  for (const [label, device, width] of [
    ["19. Desktop", "desktop", 1440],
    ["20. Tablet", "tablet", 834],
    ["21. Mobile", "mobile", 390],
  ] as const) {
    await open(`?page=home&lang=en&device=${device}`);
    await clickCanvas(headline);
    const inner = await (await frameNow()).evaluate("window.innerWidth");
    const box = await (await canvasNodeReady(headline)).boundingBox();
    const outline = await page.locator("[data-selection-outline]").boundingBox().catch(() => null);
    say(`${label}: the canvas really is ${width} wide`, inner === width, String(inner));
    say(`${label}: the node measures something and stays inside it`,
      Boolean(box) && box!.width > 0 && box!.width <= width + 1, JSON.stringify(box));
    if (outline) {
      say(`${label}: the outline sits on the node`,
        Math.abs(outline.x - box!.x) < 3 && Math.abs(outline.y - box!.y) < 3,
        `${JSON.stringify(outline)} vs ${JSON.stringify(box)}`);
    }
  }

  /* --- 24. a section nobody has selected -------------------------------- */
  /**
   * The Batch 13 correction, from a completely fresh editor.
   *
   * The section is never selected first. Before the correction the canvas made
   * itself editable on the double-click, so a person could type into a section
   * the editor had never loaded — and what they typed began from whatever the
   * page had rendered.
   */
  const [cold] = await sql<{ id: number }[]>`
    select s.id from page_sections s join pages p on p.id = s.page_id
     where p.slug = 'home' and s.block_type = 'quick-links' limit 1`;
  const coldAddress = `section:${cold!.id}/field:title`;

  await open("?page=home&lang=en&device=desktop");
  const coldNode = await canvasNodeReady(coldAddress);
  await coldNode.waitFor({ state: "visible", timeout: 25_000 });
  const coldBefore = await state(cold!.id);

  await dblCanvas(coldAddress);
  say("24. a cold section does not become editable on the gesture alone",
    (await coldNode.getAttribute("contenteditable")) === null);

  let coldReady: string | null = null;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    coldReady = await coldNode.getAttribute("contenteditable");
    if (coldReady) break;
    await page.waitForTimeout(100);
  }
  say("…and becomes editable once the editor holds the row", coldReady === "plaintext-only",
    String(coldReady));
  // `textContent`, not `innerText`: this field is styled uppercase, and what
  // matters is the characters the editor put in, not the ones CSS shows.
  const seeded = ((await coldNode.textContent()) ?? "").trim();
  say("…seeded with the row's own value, not the rendered element",
    seeded === String(((cold ? (await sql<{ published: Record<string, unknown> }[]>`
      select published from page_sections where id = ${cold!.id}`)[0]!.published.title : {}) as { en?: string }).en ?? ""),
    seeded);

  await page.keyboard.press("End");
  await page.keyboard.type(" — cold edited");
  await page.keyboard.press("Enter");
  const coldLanded = await until(async () =>
    String(((await state(cold!.id)).draft?.title as { en?: string } | undefined)?.en ?? "").includes("cold edited"));
  say("…the edit reaches the database through the ordinary autosave", coldLanded,
    String(((await state(cold!.id)).draft?.title as { en?: string } | undefined)?.en ?? ""));
  say("…and the revision advanced exactly once",
    (await state(cold!.id)).revision === coldBefore.revision + 1,
    `${coldBefore.revision} → ${(await state(cold!.id)).revision}`);

  await open("?page=home&lang=en&device=desktop");
  say("…and it survives a reload",
    ((await (await canvasNodeReady(coldAddress)).textContent()) ?? "").includes("cold edited"));

  /* --- 25. the same from Layers, also cold ------------------------------ */
  /**
   * A section on *another* page, so its row really is cold.
   *
   * The hero would not do: earlier steps loaded it, and for a section already
   * held `ensureSectionBuffer` resolves at once and editing begins in the same
   * tick — which is correct, and would make "it did not begin immediately" a
   * false expectation rather than a real check. Changing page drops the old
   * page's buffers, so this one has never been read.
   */
  const [cold2] = await sql<{ id: number; slug: string }[]>`
    select s.id, p.slug from page_sections s join pages p on p.id = s.page_id
     where p.slug = 'about' and s.block_type = 'page-hero' limit 1`;
  const layersAddress = `section:${cold2!.id}/field:title`;
  await open("?page=about&lang=en&device=desktop");
  const before2 = await state(cold2!.id);
  await page.locator(`[data-layer-toggle="section:${cold2!.id}"]`).click();
  const editControl = page.locator(`[data-layer-edit="${layersAddress}"]`);
  await editControl.waitFor({ timeout: 15_000 });
  const layersNode = await canvasNodeReady(layersAddress);
  await editControl.click();

  let layersReady: string | null = null;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    layersReady = await layersNode.getAttribute("contenteditable");
    if (layersReady) break;
    await page.waitForTimeout(100);
  }
  /**
   * That editing began, and that it began from the row.
   *
   * Not "it had not begun yet when I looked": readiness here is a local load,
   * often faster than the next instruction, and beginning quickly is the
   * correct behaviour — so asserting the intermediate state measures the
   * harness's reaction time and fails about one run in five for no reason.
   *
   * What proves the order is the text. The canvas cannot produce the row's
   * stored value on its own — the page renders a decorated, localised,
   * fallback-filled version of it — so finding exactly that value in the
   * element is proof the editor had the row before anything became editable.
   * The "must not begin before the buffer is ready" rule itself is asserted
   * where it can be checked exactly, in `direct-edit-readiness.test.ts`.
   */
  const storedTitle = String(
    ((await sql<{ published: Record<string, unknown> }[]>`
      select published from page_sections where id = ${cold2!.id}`)[0]!.published.title as { en?: string }).en ?? "",
  );
  say("25. Layers Edit text begins only once the editor holds the row",
    layersReady === "plaintext-only" &&
      ((await layersNode.textContent()) ?? "").trim() === storedTitle,
    `${layersReady} / ${((await layersNode.textContent()) ?? "").trim()} vs ${storedTitle}`);
  await page.keyboard.press("End");
  await page.keyboard.type(" LAYERS");
  await page.keyboard.press("Enter");
  say("…and persists through autosave",
    await until(async () =>
      String(((await state(cold2!.id)).draft?.title as { en?: string } | undefined)?.en ?? "").includes("LAYERS")),
    String(((await state(cold2!.id)).draft?.title as { en?: string } | undefined)?.en ?? ""));
  say("…moving the revision exactly once",
    (await state(cold2!.id)).revision === before2.revision + 1,
    `${before2.revision} → ${(await state(cold2!.id)).revision}`);

  /* --- 26. Escape puts everything back ---------------------------------- */
  await open("?page=about&lang=en&device=desktop");
  const escBefore = await state(cold2!.id);
  const escNode = await canvasNodeReady(layersAddress);
  await dblCanvas(layersAddress);
  for (let attempt = 0; attempt < 150 && !(await escNode.getAttribute("contenteditable")); attempt += 1) {
    await page.waitForTimeout(100);
  }
  const escStart = ((await escNode.textContent()) ?? "").trim();
  await page.keyboard.press("End");
  await page.keyboard.type(" THROWN AWAY");
  await page.keyboard.press("Escape");
  await quietFor(page, AUTOSAVE_QUIET_MS, "an edit thrown away with Escape would have been autosaved by now");
  const escAfter = ((await escNode.textContent()) ?? "").trim();
  say("26. Escape puts the canvas back to what the session began with",
    escAfter === escStart, `${escAfter} vs ${escStart}`);
  say("…and writes nothing",
    (await state(cold2!.id)).revision === escBefore.revision &&
      !JSON.stringify((await state(cold2!.id)).draft ?? {}).includes("THROWN AWAY"),
    `${escBefore.revision} → ${(await state(cold2!.id)).revision}`);

  /* --- 22-23. isolation -------------------------------------------------- */
  const visitor = await browser.newContext();
  const publicPage = await visitor.newPage();
  await publicPage.goto(`${server.origin}/`, { waitUntil: "load" });
  const publicHtml = await publicPage.content();
  await visitor.close();
  say("22. a visitor's page carries no editor markup at all",
    !/data-eod-/.test(publicHtml) && !/contenteditable/.test(publicHtml) && !/data-layer-/.test(publicHtml));
  say("…and no lock or direct-edit metadata", !/data-eod-edit|data-eod-editing/.test(publicHtml));

  const preview = await context.newPage();
  await preview.goto(`${server.origin}/?preview=1`, { waitUntil: "load" });
  const previewHtml = await preview.content();
  await preview.close();
  say("23. an ordinary preview is not an editor either",
    !/data-eod-/.test(previewHtml) && !/contenteditable/.test(previewHtml));
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
