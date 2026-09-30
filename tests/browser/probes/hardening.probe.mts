/**
 * Batch 12 acceptance: the three deferred defects, closed.
 *
 * Quick Links selection is the only one that needs a browser at all — the
 * other two are proved in the automated suite — so this probe is deliberately
 * small and does not restate what the other twenty already cover.
 *
 * Batch 19A: the probe's own clicks go through `clickCanvasNode`
 * (`tests/browser/canvas.ts`), and every check waits, bounded, for the
 * Inspector's answer instead of reading it after a fixed 400 ms. The
 * intermittent "the title selects the picture" was never the editor: right
 * after the editor opened, the card was still arriving, Playwright retried its
 * click, re-scrolled the title into view with a smooth glide and clicked
 * mid-glide — the pointer landed on the card's text layer, 7 to 30 px from the
 * title, and the editor rightly selected the picture under that layer.
 * Playwright's own hit check could not tell, because it compares the nearest
 * enclosing link, and title and layer share one. The probe now also checks
 * where its pointer landed, so a miss of its own can never again read as the
 * editor choosing the wrong node.
 *
 * Section 7 (Batch 19A) is the one defect this batch found in the editor
 * itself: after a save the canvas is reloaded and the selection is asked back
 * by address, and the fallback to its section used to fire on a 400 ms timer —
 * a canvas slower than that had its node replaced by the section. It is
 * checked on a CPU slowed six-fold, which is what made it happen.
 */

import { canvasStill, clickCanvasNode, editorIdle, inspectorAddress, selectCanvasNode, waitForInspector } from "../canvas";
import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";
import { quietFor } from "../wait";

const PORT = 3712;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

/** The editor records, in order, every selection the canvas reports. */
const SELECTIONS = `
  if (window === window.top) {
    window.__eodSelections = [];
    window.addEventListener("message", (event) => {
      const message = event.data && event.data.message;
      if (message && message.type === "canvas.selection") {
        window.__eodSelections.push(message.node ? message.node.address : null);
      }
    }, true);
  }
`;

const browser = await launchChromium();
const database = giveFresh("hardening_probe");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);

  const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
  await context.addInitScript({ content: "window.__name = window.__name || ((fn) => fn);" });
  await context.addInitScript({ content: SELECTIONS });
  const editor = await context.newPage();
  editor.on("pageerror", (error) => console.log("   [pageerror]", error.message.slice(0, 140)));

  const frame = () => editor.frameLocator("iframe[title]");
  const card = () => frame().locator(".ql-card").first();
  const title = () => frame().locator(".ql-title").first();
  /** Opens the editor on Home and waits until the first card has stopped arriving. */
  const open = async (device = "desktop", lang = "en") => {
    await editor.goto(
      `${server!.origin}/admin/visual-editor?page=home&lang=${lang}&device=${device}`,
      { waitUntil: "load" },
    );
    await editor.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
    await card().waitFor({ timeout: 30_000 });
    await canvasStill(editor, card());
  };
  const selected = async () => {
    const text = await editor.locator("aside[aria-label='Inspector']").innerText().catch(() => "");
    return text;
  };
  /** Everything the inspector is showing, which includes the selected address. */
  const shows = async (address: string | null) => {
    if (!address) return false;
    // `textContent`, not `innerText`: the address lives in a Technical details
    // panel that is closed by default, and innerText leaves hidden text out.
    const text = await editor
      .locator("aside[aria-label='Inspector']")
      .textContent()
      .catch(() => "");
    return (text ?? "").includes(address);
  };
  const selections = async () =>
    editor.evaluate(() => (window as unknown as { __eodSelections: (string | null)[] }).__eodSelections.slice());
  /**
   * The node Layers marks as selected, waited for (bounded) to be `address`.
   * The deepest marked row: Layers also marks the section a selection is in,
   * as the current section, and that row is an ancestor of the node's own.
   */
  const layersMark = async (address: string) => {
    const rows = editor.locator("aside[aria-label='Page structure'] [data-layer-row][aria-current='true']");
    const deadline = Date.now() + 10_000;
    for (;;) {
      const marked = (await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-layer-row") ?? "")))
        .sort((a, b) => b.length - a.length)[0] ?? null;
      if (marked === address || Date.now() > deadline) return marked;
      await editor.waitForTimeout(25);
    }
  };
  /** A point on the card given in page pixels from its corner, as a fraction of its box. */
  const onCard = async (x: number | "middle", y: number) => {
    const box = await card().boundingBox();
    return { x: x === "middle" ? 0.5 : x / (box?.width ?? 200), y: y / (box?.height ?? 160) };
  };

  await open();

  /* --- 1. the card's three addresses exist ----------------------------- */
  const addresses = {
    item: await frame().locator("li[data-eod-node]").first().getAttribute("data-eod-address"),
    image: await frame().locator(".ql-shot").first().getAttribute("data-eod-address"),
    label: await title().getAttribute("data-eod-address"),
  };
  // Both rectangles in one read, in the page, at one moment. Two separate
  // boundingBox() calls could straddle a frame of the section's entrance —
  // the card still sliding up — and compare a layer from one frame with a
  // picture from the next (found in the Batch 16 sweep: 2px apart).
  const [bodyBox, shotFrame] = await card().evaluate((node) => {
    // No helper function in here: the page has no tsx `__name` shim.
    const body = node.querySelector(".ql-body")?.getBoundingClientRect();
    const shot = node.querySelector(".ql-shot")?.getBoundingClientRect();
    return [
      body ? { y: body.y, height: body.height } : null,
      shot ? { y: shot.y, height: shot.height } : null,
    ];
  });
  const covers =
    Boolean(bodyBox && shotFrame) &&
    bodyBox!.y <= shotFrame!.y + 1 &&
    bodyBox!.y + bodyBox!.height >= shotFrame!.y + shotFrame!.height - 1;

  say("the item carries an address", Boolean(addresses.item), addresses.item ?? "");
  say("the image field carries its own address", Boolean(addresses.image), addresses.image ?? "");
  say("the label carries its own address", Boolean(addresses.label), addresses.label ?? "");
  say(
    "…and the text layer really does cover the picture frame",
    covers,
    "the visible picture sits behind an unannotated layer — this is the defect",
  );

  /* --- 2. clicking the picture selects the picture --------------------- */
  const shotBox = await frame().locator(".ql-shot").first().boundingBox();
  say("the image frame has real bounds", Boolean(shotBox && shotBox.width > 20 && shotBox.height > 20),
    shotBox ? `${Math.round(shotBox.width)}×${Math.round(shotBox.height)}` : "none");

  // The upper picture area, well clear of the title at the bottom.
  await clickCanvasNode(editor, card(), await onCard("middle", 14));
  await editor.getByRole("tab", { name: /Motion/ }).waitFor({ timeout: 25_000 });
  await waitForInspector(editor, addresses.image ?? "");
  say("clicking the picture selects the image field", await shows(addresses.image), addresses.image ?? "");
  say("…and the inspector shows an image field", /image/i.test(await selected()));

  /* --- 3. clicking the title selects the label ------------------------- */
  const before = (await selections()).length;
  const landing = await clickCanvasNode(editor, title(), "center");
  say(
    "…the probe's own click landed on the title (read inside the canvas)",
    landing.inTarget,
    JSON.stringify(landing),
  );
  await waitForInspector(editor, addresses.label ?? "");
  say("clicking the title selects the label field", await shows(addresses.label), addresses.label ?? "");
  say(
    "…and not the picture behind it",
    !(await shows(addresses.image)),
    "a foreground hit must win",
  );
  const reported = (await selections()).slice(before);
  say(
    "…in one step: the only selection the canvas reported for that click is the label",
    reported.length === 1 && reported[0] === addresses.label,
    JSON.stringify(reported),
  );
  const marked = await layersMark(addresses.label ?? "");
  say("…and Layers marks the node the Inspector shows", marked !== null && marked === (await inspectorAddress(editor)), `${marked}`);

  /* --- 4. Layers still reaches both -------------------------------------- */
  await clickCanvasNode(editor, card(), await onCard(20, 12));
  await waitForInspector(editor, addresses.image ?? "");
  say("pointing near the corner of the picture still selects the image", await shows(addresses.image));

  // Selecting far down the page from Layers scrolls the page inside the
  // canvas — and never the editor's own box around it (Batch 19A: that box
  // was a scroll container, and the bridge's scrollIntoView slid the whole
  // page up inside it, cutting off its top).
  const iframe = editor.locator("iframe[title]");
  const frameBefore = await iframe.boundingBox();
  const lastSection = editor.locator("aside[aria-label='Page structure'] [data-layer-row^='section:']").last();
  const lastAddress = (await lastSection.getAttribute("data-layer-row")) ?? "";
  await lastSection.click();
  await waitForInspector(editor, lastAddress);
  await canvasStill(editor, frame().locator(`[data-eod-address="${lastAddress}"]`).first());
  const frameAfter = await iframe.boundingBox();
  const stage = await iframe.evaluate((node) => {
    const box = node.parentElement!;
    return { top: box.scrollTop, left: box.scrollLeft, overflow: getComputedStyle(box).overflow };
  });
  const canvasScrolled = await frame().locator("body").evaluate(() => Math.round(window.scrollY));
  say(
    "a Layers selection scrolls the page inside the canvas, never the editor's frame around it",
    canvasScrolled > 0 &&
      stage.top === 0 &&
      stage.left === 0 &&
      Boolean(frameBefore && frameAfter) &&
      Math.abs(frameAfter!.x - frameBefore!.x) < 0.5 &&
      Math.abs(frameAfter!.y - frameBefore!.y) < 0.5,
    JSON.stringify({ canvasScrolled, stage, frameBefore, frameAfter }),
  );

  /* --- 5. geometry across devices and editions -------------------------- */
  const inspectorCodes = async () =>
    (await editor.locator("aside[aria-label='Inspector'] code").allTextContents().catch(() => [] as string[]))
      .map((text) => text.trim())
      .filter((text) => text.startsWith("section:"))
      .join(", ") || "nothing";
  for (const device of ["desktop", "tablet", "mobile"]) {
    await open(device);
    await clickCanvasNode(editor, card(), await onCard("middle", 12));
    await editor.getByRole("tab", { name: /Motion/ }).waitFor({ timeout: 25_000 });
    const shot = await frame().locator(".ql-shot").first().boundingBox();
    const want = await frame().locator(".ql-shot").first().getAttribute("data-eod-address");
    await waitForInspector(editor, want ?? "");
    const shown = await shows(want);
    // Diagnostic only (Batch 16): what the inspector was showing instead.
    const showing = shown ? "" : ` · inspector shows ${await inspectorCodes()}`;
    say(
      `${device}: the picture is selectable, and its frame is the media frame`,
      shown && Boolean(shot && shot.width > 20 && shot.height > 20),
      (shot ? `${Math.round(shot.width)}×${Math.round(shot.height)}` : "no box") + showing,
    );
    const label = await title().getAttribute("data-eod-address");
    const hit = await clickCanvasNode(editor, title(), "center");
    await waitForInspector(editor, label ?? "");
    const labelShown = await shows(label);
    say(
      `${device}: the title selects its label, not the picture`,
      hit.inTarget && labelShown && !(await shows(want)),
      !hit.inTarget ? `the click landed on ${JSON.stringify(hit)}` : labelShown ? "" : `inspector shows ${await inspectorCodes()}`,
    );
  }

  await open("desktop", "ar");
  await clickCanvasNode(editor, card(), await onCard("middle", 12));
  await editor.getByRole("tab", { name: /Motion/ }).waitFor({ timeout: 25_000 });
  const arWant = await frame().locator(".ql-shot").first().getAttribute("data-eod-address");
  await waitForInspector(editor, arWant ?? "");
  say("Arabic: the picture is selectable too", await shows(arWant), arWant ?? "");
  const arLabel = await title().getAttribute("data-eod-address");
  const arHit = await clickCanvasNode(editor, title(), "center");
  await waitForInspector(editor, arLabel ?? "");
  say(
    "Arabic: the title selects its label, not the picture",
    arHit.inTarget && (await shows(arLabel)) && !(await shows(arWant)),
    arHit.inTarget ? "" : `the click landed on ${JSON.stringify(arHit)}`,
  );

  /* --- 6. the public page is untouched ---------------------------------- */
  const visitor = await browser.newContext();
  const page = await visitor.newPage();
  await page.goto(`${server.origin}/`, { waitUntil: "load" });
  const html = await page.content();
  say("a visitor's Quick Links carry no editor attributes", !html.includes("data-eod-"));
  const publicCard = page.locator(".ql-card").first();
  say("…and the card is still a link", (await publicCard.getAttribute("href")) !== null);
  say("…with its picture frame", (await page.locator(".ql-shot").first().count()) === 1);
  say("…and its visible label", ((await page.locator(".ql-title").first().innerText()) ?? "").length > 0);
  await visitor.close();

  /* --- 7. a redraw keeps the selection, on a slow canvas as well ------------ */
  // After a save the editor reloads the canvas and asks for the selected node
  // back by address. The canvas answers with the node, or — when the edit
  // removed it — with nothing, and only then does the selection fall back to
  // the section. Both are asked here with the CPU slowed six-fold, so the
  // canvas answers well after the old 400 ms fallback timer would have fired.
  const [why] = await sql<{ id: number; published: { points: { _id: string }[] } }[]>`
    select s.id, s.published from page_sections s join pages p on p.id = s.page_id
     where p.slug = 'home' and s.block_type = 'why-us' limit 1`;
  const WHY_SECTION = `section:${why!.id}`;
  const POINTS = `${WHY_SECTION}/field:points`;
  const firstPoint = why!.published.points[0]!._id;
  const cdp = await context.newCDPSession(editor);
  const cpu = (rate: number) => cdp.send("Emulation.setCPUThrottlingRate", { rate });
  await open();
  const points = await selectCanvasNode(editor, POINTS);
  if (!points.ok) throw new Error(`could not select ${POINTS}: the Inspector shows ${points.shows}`);
  await editor.getByRole("tab", { name: /Style/ }).click();
  const minHeight = editor.locator('[data-style-token="minHeight"] select');
  await minHeight.waitFor({ timeout: 10_000 });
  await minHeight.selectOption("half-screen");
  const beforeSave = (await selections()).length;
  await cpu(6);
  try {
    await editor.getByRole("button", { name: "Save now" }).click();
    await editorIdle(editor, 90_000);
    await quietFor(editor, 3_000, "a section asked for behind the node would have replaced it by now");
  } finally {
    await cpu(1);
  }
  const afterSave = await inspectorAddress(editor);
  say(
    "a save's redraw keeps the node selected on a canvas six times slower, not its section",
    afterSave === POINTS,
    `${afterSave || "nothing"}; the canvas reported ${JSON.stringify((await selections()).slice(beforeSave))}`,
  );
  const savedMark = await layersMark(POINTS);
  say("…and Layers marks that same node", savedMark === POINTS && savedMark === afterSave, `${savedMark}`);

  const row = await selectCanvasNode(editor, `${POINTS}/item:${firstPoint}`);
  if (!row.ok) throw new Error(`could not select the first point: the Inspector shows ${row.shows}`);
  await editor.getByRole("tab", { name: /Content/ }).click();
  const remove = editor.locator(`aside[aria-label='Inspector'] li[data-item-id="${firstPoint}"] button[aria-label="Remove"]`);
  await remove.waitFor({ timeout: 10_000 });
  const beforeRemove = (await selections()).length;
  await cpu(6);
  let fellBack = "";
  try {
    await remove.click();
    await editorIdle(editor, 90_000);
    fellBack = await waitForInspector(editor, WHY_SECTION, 20_000);
  } finally {
    await cpu(1);
  }
  say(
    "when the selected row itself is removed, the selection falls back to its section — on the canvas's answer",
    fellBack === WHY_SECTION,
    `${fellBack || "nothing"}; the canvas reported ${JSON.stringify((await selections()).slice(beforeRemove))}`,
  );
} finally {
  await browser.close();
  if (server) await server.stop();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
