/**
 * Batch 14 browser acceptance: the advanced layout and styling controls in the
 * real Visual Editor, against the production build. §35.
 *
 * Everything here goes through the panel a person uses — select a node, change
 * a control, let autosave run, read the canvas back — rather than through the
 * action underneath it. The tracked suite proves the tokens; this proves the
 * controls reach them.
 */

import { editorSettled, inspectorAddress, selectCanvasNode } from "../canvas";
import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";

const PORT = 3715;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("layout_styles");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);

  const sectionOn = async (slug: string, block: string) => {
    const [found] = await sql<{ id: number; published: Record<string, unknown> }[]>`
      select s.id, s.published from page_sections s join pages p on p.id = s.page_id
       where p.slug = ${slug} and s.block_type = ${block} limit 1`;
    return found!;
  };
  const why = await sectionOn("home", "why-us");
  const links = await sectionOn("home", "quick-links");
  const hero = await sectionOn("privacy", "page-hero");

  const state = async (id: number) =>
    (
      await sql<{ revision: number; styles: unknown; draft_styles: unknown }[]>`
        select revision, styles, draft_styles from page_sections where id = ${id}`
    )[0]!;
  const nodesOf = async (id: number, path: string) => {
    const doc = (await state(id)).draft_styles as { nodes?: Record<string, unknown> } | null;
    return (doc?.nodes?.[path] ?? null) as Record<string, Record<string, unknown>> | null;
  };
  /** Postgres hands jsonb back with its own key order, so compare by shape. */
  const sorted = (value: unknown): unknown =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)]))
      : value;
  const same = (a: unknown, b: unknown) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));

  const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
  // What the canvas reported selected, and when — read back only to explain a
  // control that never appeared (Batch 19A).
  await context.addInitScript({
    content: `
      if (window === window.top) {
        window.__eodSelections = [];
        window.addEventListener("message", (event) => {
          const message = event.data && event.data.message;
          if (message && message.type === "canvas.selection") {
            window.__eodSelections.push(Math.round(performance.now()) + " " + (message.node ? message.node.address : "none"));
          }
        }, true);
      }
    `,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("   [pageerror]", error.message.slice(0, 120)));
  // Publish and Discard go through `window.confirm`, which Playwright dismisses
  // by default — so without this the click is prevented and nothing is
  // published, which reads exactly like a broken publication.
  page.on("dialog", (dialog) => void dialog.accept());

  const open = async (query: string) => {
    await page.goto(`${server!.origin}/admin/visual-editor${query}`, { waitUntil: "load" });
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 30_000 });
  };
  const frame = () => page.frames().find((f) => f.url().includes("editor=1"))!;
  /**
   * One click where the canvas is still, then a bounded wait for the
   * Inspector's answer (Batch 19A: the old step-out loop read the Inspector
   * straight after the click and could walk the fresh selection out to its
   * section — see `tests/browser/canvas.ts`). Says so when it did not get there.
   */
  const select = async (address: string) => {
    const element = frame().locator(`[data-eod-address="${address}"]`).first();
    const result = await selectCanvasNode(page, address);
    if (!result.ok) throw new Error(`select(${address}) ended on ${result.shows || "nothing"}; the click landed on ${JSON.stringify(result.landing)}`);
    return element;
  };
  const device = async (label: "Desktop" | "Tablet" | "Mobile") => {
    await page.getByRole("button", { name: new RegExp(`^${label}`) }).click();
    await page.waitForTimeout(700);
  };
  const styleTab = () => page.getByRole("tab", { name: /Style/ });
  const has = async (token: string) => (await page.locator(`[data-style-token="${token}"]`).count()) > 0;
  /**
   * Select a node and open its Style tab, confirmed by a control that node is
   * supposed to have.
   *
   * A canvas reload after a save rebuilds the document and restores the
   * selection, and the click that `select` makes can land while that is still
   * happening — the panel then shows a different node, and the next `setToken`
   * times out somewhere unrelated to what it was testing. Retrying the
   * *selection* is honest; it is not a retry of the assertion, because a token
   * the node genuinely does not offer still comes back absent after all three
   * attempts and the caller says so.
   */
  const openStyle = async (address: string, expect: string) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await select(address);
      await styleTab().click();
      if (await has(expect)) return true;
      await page.waitForTimeout(600);
    }
    return false;
  };
  /**
   * What the editor was showing, for a control that did not appear: the node
   * in the Inspector, the open tab, the status line, the Style rows on screen
   * and the canvas's last few selections (Batch 19A).
   */
  const editorState = async () =>
    JSON.stringify({
      inspector: await inspectorAddress(page),
      tab: (await page.getByRole("tab", { selected: true }).first().textContent().catch(() => null))?.trim() ?? null,
      status: ((await page.locator("header").first().innerText().catch(() => "")).match(/Ready|Loading[^\n]*|Connecting[^\n]*|Saving[^\n]*|\d+ unsaved/g) ?? []).join(" · "),
      rows: await page
        .locator("[data-style-token]")
        .evaluateAll((nodes) => nodes.map((node) => `${node.getAttribute("data-style-token")}:${node.getAttribute("data-style-state") ?? "?"}`)),
      selections: await page.evaluate(() => ((window as unknown as { __eodSelections?: string[] }).__eodSelections ?? []).slice(-6)),
    });
  /** A control of the Style tab, waited for — and, if it never comes, why. */
  const control = async (selector: string, what: string) => {
    const found = page.locator(selector);
    try {
      await found.waitFor({ timeout: 10_000 });
    } catch {
      throw new Error(`${what} never appeared within 10 s; the editor showed ${await editorState()}`);
    }
    return found;
  };
  const setToken = async (token: string, option: string) => {
    await (await control(`[data-style-token="${token}"] select`, `the ${token} control`)).selectOption(option);
  };
  const setRange = async (token: string, n: number) => {
    await (await control(`[data-style-token="${token}"] input[type="range"]`, `the ${token} slider`)).fill(String(n));
  };
  /** The per-property reset: the button the row shows only when it is set. */
  const clearToken = async (token: string) => {
    await (await control(`[data-style-token="${token}"] button`, `the ${token} reset button`)).click();
  };
  const tokenState = (token: string) =>
    page.locator(`[data-style-token="${token}"]`).first().getAttribute("data-style-state");
  const saveStyles = async (id: number) => {
    const before = (await state(id)).revision;
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
  const styleAt = async (address: string) =>
    (await frame().locator(`[data-eod-address="${address}"]`).first().getAttribute("style")) ?? "";
  const computedAt = (address: string, property: string) =>
    frame()
      .locator(`[data-eod-address="${address}"]`)
      .first()
      .evaluate((node, prop) => getComputedStyle(node as Element).getPropertyValue(prop as string), property);
  const publish = async (id: number) => {
    await page.goto(`${server!.origin}/admin/pages/section/${id}`, { waitUntil: "load" });
    await page.getByRole("button", { name: "Publish draft" }).click();
    for (let i = 0; i < 80 && (await state(id)).draft_styles !== null; i += 1) {
      await page.waitForTimeout(200);
    }
  };
  /**
   * The public page, once the publication has reached it.
   *
   * `refreshAfterPublish` drops the page cache inside Next's `after()`, which
   * runs once the action's response has been sent — so the row can be published
   * a moment before the cached page is. Fetching once and immediately would be
   * asserting a timing this design never promised; waiting for the value, with
   * a bound, asserts the thing that matters and still fails if it never lands.
   */
  const publicPage = async (path: string, wanted: string) => {
    let html = "";
    for (let i = 0; i < 40; i += 1) {
      html = await fetch(`${server!.origin}${path}`).then((r) => r.text());
      if (html.includes(wanted)) return html;
      await page.waitForTimeout(250);
    }
    return html;
  };

  const HOME = "?page=home&lang=en&device=desktop";
  const PRIVACY = "?page=privacy&lang=en&device=desktop";
  const POINTS = `section:${why.id}/field:points`;
  const CARDS = `section:${links.id}/field:links`;
  const ROOT = `section:${hero.id}`;

  /* --- Width and height, on a real container ---------------------------- */
  await open(HOME);
  const container = await select(POINTS);
  say("the list container is a real, selectable node", (await container.count()) > 0);
  say("…and it is the <ul> the block renders", (await container.evaluate((n) => n.tagName)) === "UL");
  await styleTab().click();
  await page.getByText("Base", { exact: true }).waitFor({ timeout: 10_000 });
  say("a box is offered a Width", await has("width"));
  say("…and a Height and a Minimum height", (await has("height")) && (await has("minHeight")));
  say("…and its own grid controls, because the design is already a grid", await has("columns"));
  say("…and the panel says where that came from", (await page.locator("[data-style-layout='grid']").count()) > 0);

  await setToken("width", "half");
  await saveStyles(why.id);
  say("Width reaches the canvas as a length the renderer chose", /width:\s*50%/.test(await styleAt(POINTS)), await styleAt(POINTS));
  say("…and is stored as the word, not the length", same((await nodesOf(why.id, "field:points"))?.base, { width: "half" }), JSON.stringify(await nodesOf(why.id, "field:points")));

  await open(HOME);
  say("…and the node comes back after a reload", await openStyle(POINTS, "width"));
  say("…and it is still there after a reload", /width:\s*50%/.test(await styleAt(POINTS)));
  say("…shown in the control as an override", (await tokenState("width")) === "override");

  await setToken("minHeight", "half-screen");
  await saveStyles(why.id);
  say("Minimum height is a viewport fraction, in small-viewport units", /min-height:\s*50svh/.test(await styleAt(POINTS)), await styleAt(POINTS));

  await clearToken("width");
  await saveStyles(why.id);
  say("clearing one property puts that property back to the design", !/width:\s*50%/.test(await styleAt(POINTS)), await styleAt(POINTS));
  say("…and leaves the others alone", /min-height:\s*50svh/.test(await styleAt(POINTS)));

  /* --- Responsive width ------------------------------------------------- */
  await device("Tablet");
  await styleTab().click();
  say("Tablet edits its own branch", (await page.getByText("Tablet override", { exact: true }).count()) > 0);
  await setToken("width", "full");
  await device("Mobile");
  await styleTab().click();
  await setToken("width", "two-thirds");
  await saveStyles(why.id);
  const branches = await nodesOf(why.id, "field:points");
  say("a width override per width is three keys of one node", same(branches, { base: { minHeight: "half-screen" }, tablet: { width: "full" }, mobile: { width: "two-thirds" } }), JSON.stringify(branches));
  const tabletVars = await styleAt(POINTS);
  say("…and each travels as a value under its own prefix", /--rs-t-width:\s*100%/.test(tabletVars) && /--rs-m-width:\s*66\.6667%/.test(tabletVars), tabletVars);

  await device("Desktop");
  say("the container is selectable again at Desktop", await openStyle(POINTS, "width"));
  await page.getByRole("button", { name: /Reset styles for this element/ }).click();
  await saveStyles(why.id);
  say("the whole-branch reset still clears one branch and keeps the rest", same(await nodesOf(why.id, "field:points"), { tablet: { width: "full" }, mobile: { width: "two-thirds" } }), JSON.stringify(await nodesOf(why.id, "field:points")));

  /* --- Flex ------------------------------------------------------------- */
  await open(PRIVACY);
  say("a section in ordinary block flow is offered a Layout mode", await openStyle(ROOT, "layout"));
  say("…and none of the settings that need one", !(await has("direction")) && !(await has("justify")) && !(await has("columns")));

  await setToken("layout", "flex");
  await page.locator('[data-style-token="direction"]').waitFor({ timeout: 10_000 });
  say("choosing Flex reveals Direction and Wrapping", (await has("direction")) && (await has("wrap")));
  say("…and Distribute, Align and Gap", (await has("justify")) && (await has("alignItems")) && (await has("gap")));
  say("…and not a column count, which a flex row has no use for", !(await has("columns")));

  await setToken("direction", "row");
  await setToken("wrap", "wrap");
  await setToken("justify", "start");
  await setToken("alignItems", "center");
  await setRange("gap", 6);
  await setToken("minHeight", "half-screen");
  await saveStyles(hero.id);
  const flexStyle = await styleAt(ROOT);
  say("Flex reaches the canvas as a display", /display:\s*flex/.test(flexStyle), flexStyle);
  say("…Direction Row", /flex-direction:\s*row/.test(flexStyle));
  say("…Wrapping", /flex-wrap:\s*wrap/.test(flexStyle));
  say("…Distribute Start, as the logical keyword", /justify-content:\s*start/.test(flexStyle));
  say("…Align Center", /align-items:\s*center/.test(flexStyle));
  say("…and the existing Gap token, unchanged", /gap:\s*2rem/.test(flexStyle));
  say("…with nothing physical anywhere in it", !/left|right/i.test(flexStyle), flexStyle);

  for (const [value, css] of [["center", "center"], ["end", "end"], ["between", "space-between"], ["around", "space-around"], ["evenly", "space-evenly"]] as const) {
    await setToken("justify", value);
    await saveStyles(hero.id);
    say(`…Distribute ${value}`, new RegExp(`justify-content:\\s*${css.replace("-", "\\-")}`).test(await styleAt(ROOT)), await styleAt(ROOT));
  }
  for (const value of ["start", "end", "stretch"] as const) {
    await setToken("alignItems", value);
    await saveStyles(hero.id);
    say(`…Align ${value}`, new RegExp(`align-items:\\s*${value}`).test(await styleAt(ROOT)));
  }
  await setToken("direction", "column");
  await saveStyles(hero.id);
  say("…Direction Column", /flex-direction:\s*column/.test(await styleAt(ROOT)));

  /* --- Accessibility ----------------------------------------------------- */
  /**
   * §29, on the controls this batch added. Everything here is a fact about the
   * markup rather than about how it looks: a label bound to a real control, a
   * current value a screen reader can read, the inherited state said in words,
   * and the layout mode communicated as text rather than as a colour.
   */
  const rows = await page.locator("[data-style-token]").evaluateAll((nodes) =>
    nodes.map((node) => {
      const element = node as HTMLElement;
      const label = element.querySelector("label");
      // The control the label actually names, not merely the first focusable
      // thing in the row — the row also holds a "clear" button above it, and
      // asserting against that would prove nothing about the control.
      const named = label?.htmlFor ? element.querySelector(`#${CSS.escape(label.htmlFor)}`) : null;
      const control = named as HTMLSelectElement | HTMLInputElement | null;
      const described = control?.getAttribute("aria-describedby");
      return {
        token: element.dataset.styleToken ?? "",
        labelled: Boolean(label?.textContent?.trim()) && Boolean(control),
        tag: control?.tagName ?? "",
        focusable: control ? control.tabIndex >= 0 && !control.hidden : false,
        state: element.dataset.styleState ?? "",
        noteResolves: !described || Boolean(element.querySelector(`#${CSS.escape(described)}`)),
        // A select reports the option in force; a range reports its number.
        exposes: control ? control.value !== "" && control.value !== null : false,
        clear: element.querySelector("button[type='button']")?.textContent?.trim() ?? "",
      };
    }),
  );
  say("every control on screen is named by a label bound to it", rows.length > 0 && rows.every((r) => r.labelled), JSON.stringify(rows.filter((r) => !r.labelled).map((r) => r.token)));
  say("…is a native control, so the keyboard already works", rows.every((r) => r.tag === "SELECT" || r.tag === "INPUT"), JSON.stringify(rows.map((r) => [r.token, r.tag])));
  say("…and is reachable by tabbing", rows.every((r) => r.focusable), JSON.stringify(rows.filter((r) => !r.focusable).map((r) => r.token)));
  say("…exposes the value it is currently showing", rows.every((r) => r.exposes), JSON.stringify(rows.filter((r) => !r.exposes).map((r) => r.token)));
  say("…says in text whether it is an override or inherited", rows.every((r) => r.state === "override" || r.state === "inherited"));
  say("…offers its own reset in words when it is set", rows.filter((r) => r.state === "override").every((r) => /clear|inherit/i.test(r.clear)), JSON.stringify(rows.filter((r) => r.state === "override").map((r) => [r.token, r.clear])));
  say("…and every helper note is an element its control really points at", rows.every((r) => r.noteResolves));
  const layoutCaption = (await page.locator("[data-style-layout]").first().innerText()).trim();
  say(
    "the layout mode is stated in words, not signalled by colour",
    /flex|grid|stacked|component/i.test(layoutCaption),
    layoutCaption,
  );
  say(
    "…and the Tab key walks the controls in order",
    await page.locator("[data-style-token='layout'] select").evaluate((node) => {
      const own = node as HTMLElement;
      own.focus();
      return document.activeElement === own;
    }),
  );

  /* --- RTL -------------------------------------------------------------- */
  say("the flex section's own controls are still on the selected node", await openStyle(ROOT, "direction"));
  await setToken("direction", "row");
  await setToken("justify", "start");
  await saveStyles(hero.id);
  const englishStart = await frame()
    .locator(`[data-eod-address="${ROOT}"]`)
    .first()
    .evaluate((node) => {
      const box = (node as Element).getBoundingClientRect();
      const child = (node as Element).firstElementChild!.getBoundingClientRect();
      return { left: Math.round(child.left - box.left), right: Math.round(box.right - child.right) };
    });
  say("in English, Start puts the content at the left of the inline direction", englishStart.left < englishStart.right, JSON.stringify(englishStart));

  await open("?page=privacy&lang=ar&device=desktop");
  say("the Arabic canvas is right-to-left", (await frame().locator("html").getAttribute("dir")) === "rtl");
  const arabicStyle = await styleAt(ROOT);
  say("…and it is the very same document", /justify-content:\s*start/.test(arabicStyle) && /flex-direction:\s*row/.test(arabicStyle), arabicStyle);
  const arabicStart = await frame()
    .locator(`[data-eod-address="${ROOT}"]`)
    .first()
    .evaluate((node) => {
      const box = (node as Element).getBoundingClientRect();
      const child = (node as Element).firstElementChild!.getBoundingClientRect();
      return { left: Math.round(child.left - box.left), right: Math.round(box.right - child.right) };
    });
  say("…so Start is the right-hand side in Arabic, with no second document", arabicStart.right < arabicStart.left, JSON.stringify(arabicStart));
  const stored = JSON.stringify(await nodesOf(hero.id, "root"));
  say("…and nothing physical was ever stored", !/left|right/i.test(stored), stored);

  /* --- Grid ------------------------------------------------------------- */
  await open(HOME);
  say("a declared grid offers a column count with no override first", await openStyle(CARDS, "columns"));
  await setToken("columns", "4");
  await saveStyles(links.id);
  say("Grid columns 4 on Desktop", /grid-template-columns:\s*repeat\(4, minmax\(0, 1fr\)\)/.test(await styleAt(CARDS)), await styleAt(CARDS));

  await device("Tablet");
  await styleTab().click();
  await setToken("columns", "2");
  await device("Mobile");
  await styleTab().click();
  await setToken("columns", "1");
  await saveStyles(links.id);
  const gridVars = await styleAt(CARDS);
  say("…2 on Tablet", /--rs-t-grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/.test(gridVars), gridVars);
  say("…1 on Mobile", /--rs-m-grid-template-columns:\s*repeat\(1, minmax\(0, 1fr\)\)/.test(gridVars));
  say("…and the phone really renders one column", (await computedAt(CARDS, "grid-template-columns")).split(" ").length === 1, await computedAt(CARDS, "grid-template-columns"));

  await styleTab().click();
  await clearToken("columns");
  await saveStyles(links.id);
  const afterMobileReset = await nodesOf(links.id, "field:links");
  say("resetting Mobile deletes that branch rather than copying Tablet's value", afterMobileReset?.mobile === undefined, JSON.stringify(afterMobileReset));
  say("…and a phone then follows Tablet, through the cascade", (await computedAt(CARDS, "grid-template-columns")).split(" ").length === 2, await computedAt(CARDS, "grid-template-columns"));

  await device("Tablet");
  await styleTab().click();
  await clearToken("columns");
  await saveStyles(links.id);
  const afterTabletReset = await nodesOf(links.id, "field:links");
  say("resetting Tablet leaves Base alone", same(afterTabletReset, { base: { columns: 4 } }), JSON.stringify(afterTabletReset));
  say("…and a tablet then shows the four Base asked for", (await computedAt(CARDS, "grid-template-columns")).split(" ").length === 4, await computedAt(CARDS, "grid-template-columns"));

  /* --- Overflow --------------------------------------------------------- */
  await device("Desktop");
  say("a box is offered Overflow", await openStyle(CARDS, "overflow"));
  say("…and says what Hidden will do", (await page.getByText(/crop anything that reaches past the edge/).count()) > 0);
  await setToken("overflow", "hidden");
  await saveStyles(links.id);
  say("Overflow Hidden reaches the canvas", /overflow:\s*hidden/.test(await styleAt(CARDS)), await styleAt(CARDS));
  await setToken("overflow", "visible");
  await saveStyles(links.id);
  say("…and Visible is a choice rather than an absence", /overflow:\s*visible/.test(await styleAt(CARDS)));
  await clearToken("overflow");
  await saveStyles(links.id);
  say("…and clearing it removes the declaration entirely", !/overflow:/.test(await styleAt(CARDS)), await styleAt(CARDS));

  /* --- Glow ------------------------------------------------------------- */
  await open(PRIVACY);
  say("a surface is offered a Glow beside its Shadow", (await openStyle(ROOT, "glow")) && (await has("shadow")));
  await setToken("glow", "soft");
  await saveStyles(hero.id);
  say("Glow soft is the site's own light", /box-shadow:\s*var\(--glow-soft\)/.test(await styleAt(ROOT)), await styleAt(ROOT));
  say("…and it really paints something", (await computedAt(ROOT, "box-shadow")) !== "none", await computedAt(ROOT, "box-shadow"));
  await setToken("glow", "strong");
  await saveStyles(hero.id);
  say("Glow strong is a different layer", /box-shadow:\s*var\(--glow-strong\)/.test(await styleAt(ROOT)));

  await setToken("shadow", "lift");
  await saveStyles(hero.id);
  say("Shadow and Glow compose rather than replace", /box-shadow:\s*var\(--shadow-lift\), var\(--glow-strong\)/.test(await styleAt(ROOT)), await styleAt(ROOT));
    // Two layers, counted by the offsets that separate them: the computed value
  // spells a colour as `oklab(...)` or `rgba(...)` depending on how it was
  // written, so counting colour functions would be counting the wrong thing.
  say("…and the browser reads both layers", ((await computedAt(ROOT, "box-shadow")).match(/px -?\d+px/g) ?? []).length >= 2, await computedAt(ROOT, "box-shadow"));

  await clearToken("glow");
  await saveStyles(hero.id);
  say("clearing the Glow leaves the Shadow", /box-shadow:\s*var\(--shadow-lift\)/.test(await styleAt(ROOT)) && !/glow/.test(await styleAt(ROOT)), await styleAt(ROOT));
  await setToken("glow", "accent");
  await saveStyles(hero.id);
  await clearToken("shadow");
  await saveStyles(hero.id);
  say("…and clearing the Shadow leaves the Glow", /box-shadow:\s*var\(--glow-accent\)/.test(await styleAt(ROOT)) && !/shadow-lift/.test(await styleAt(ROOT)), await styleAt(ROOT));

  /* --- What the panel refuses to offer ---------------------------------- */
  const headingReady = await openStyle(`section:${hero.id}/field:title`, "fontSize");
  say("a heading's own controls are on screen", headingReady);
  say("a heading is offered a Width and no layout at all", (await has("width")) && !(await has("layout")) && !(await has("columns")));
  say("…and no Overflow or Glow", !(await has("overflow")) && !(await has("glow")));

  /* --- Isolation -------------------------------------------------------- */
  const publicBefore = await fetch(`${server.origin}/privacy`).then((r) => r.text());
  say("a visitor's page is untouched while the layout is a draft", !publicBefore.includes("--glow-accent") && !publicBefore.includes("display:flex"), "");
  const previewed = await fetch(`${server.origin}/privacy?preview=1`, { headers: { cookie: owner.cookie } }).then((r) => r.text());
  say("…the ordinary preview shows it", previewed.includes("var(--glow-accent)"));
  say("…with no editor markup in it", !/data-eod-/.test(previewed));

  await publish(hero.id);
  const published = (await state(hero.id)) as { styles: { nodes?: Record<string, unknown> } | null; draft_styles: unknown };
  say(
    "publishing moves the layout out of the draft column",
    published.draft_styles === null && JSON.stringify(published.styles?.nodes ?? {}).includes("glow"),
    JSON.stringify(published.styles),
  );
  const publicAfter = await publicPage("/privacy", "var(--glow-accent)");
  say(
    "publishing makes the public page equal the preview",
    publicAfter.includes("var(--glow-accent)") && publicAfter.includes("justify-content:start"),
    /<div[^>]*data-section="page-hero"[^>]*>/.exec(publicAfter)?.[0]?.slice(0, 300) ?? "no page-hero on the public page",
  );
  say("…and a visitor still gets no editor artefacts", !/data-eod-/.test(publicAfter) && !publicAfter.includes("data-style-token"));

  await context.close();

  /* --- put the fixture back --------------------------------------------- */
  await sql`update page_sections set draft = null, draft_styles = null,
                   styles = '{"v":1,"nodes":{}}'::jsonb
             where id in (${why.id}, ${links.id}, ${hero.id})`;
  const restored = await state(hero.id);
  say("the fixture is back as it started", restored.draft_styles === null);
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
