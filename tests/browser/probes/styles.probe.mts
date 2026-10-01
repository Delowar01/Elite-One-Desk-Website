/**
 * Batch 6 browser acceptance: layout and styles in the real Visual Editor,
 * against the production build. §79.
 */
import type { Page } from "playwright";

import { editorSettled, selectCanvasNode } from "../canvas";
import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";

const PORT = 3729;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("style_acceptance");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);

  /*
   * The privacy page's hero, because its heading is a leaf: the home hero's
   * <h1> wraps the rotating-words list, so a click in the middle of it selects
   * that list — correct nearest-node behaviour, and the wrong node to ask for
   * a font size.
   */
  const [hero] = await sql<{ id: number; published: Record<string, unknown> }[]>`
    select s.id, s.published from page_sections s join pages p on p.id = s.page_id
     where p.slug = 'privacy' and s.block_type = 'page-hero' limit 1`;
  const [links] = await sql<{ id: number; published: Record<string, unknown> }[]>`
    select s.id, s.published from page_sections s join pages p on p.id = s.page_id
     where p.slug = 'home' and s.block_type = 'quick-links' limit 1`;

  const state = async (id: number) =>
    (
      await sql<{ revision: number; styles: unknown; draft_styles: unknown; draft: Record<string, unknown> | null }[]>`
        select revision, styles, draft_styles, draft from page_sections where id = ${id}`
    )[0]!;

  const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("   [pageerror]", error.message.slice(0, 120)));

  const HOME = "?page=home&lang=en&device=desktop";
  const PRIVACY = "?page=privacy&lang=en&device=desktop";

  const open = async (query = "") => {
    await page.goto(`${server!.origin}/admin/visual-editor${query}`, { waitUntil: "load" });
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 30_000 });
  };
  const frame = () => page.frames().find((f) => f.url().includes("editor=1"))!;
  /**
   * Select an exact address. Pointing at a card whose picture fills it selects
   * the picture — which is what pointing at a photograph should do — so the
   * card itself is reached with the inspector's one step out.
   */
  /**
   * One click where the canvas is still, then a bounded wait for the
   * Inspector's exact address — not a prefix of it: an image's address begins
   * with its card's (Batch 19A: the old step-out loop read the Inspector
   * straight after the click and could walk the fresh selection out to its
   * section — see `tests/browser/canvas.ts`).
   */
  const select = async (address: string) => {
    const element = frame().locator(`[data-eod-address="${address}"]`);
    const result = await selectCanvasNode(page, address);
    if (!result.ok) throw new Error(`select(${address}) ended on ${result.shows || "nothing"}; the click landed on ${JSON.stringify(result.landing)}`);
    return element;
  };
  const styleTab = () => page.getByRole("tab", { name: /Style/ });
  const setToken = async (token: string, value: string) => {
    const control = page.locator(`[data-style-token="${token}"] select`);
    await control.waitFor({ timeout: 10_000 });
    await control.selectOption(value);
  };
  const setRange = async (token: string, value: number) => {
    const control = page.locator(`[data-style-token="${token}"] input[type="range"]`);
    await control.waitFor({ timeout: 10_000 });
    await control.fill(String(value));
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
  const inlineStyle = async (target: Page | ReturnType<typeof frame>, address: string) =>
    target.locator(`[data-eod-address="${address}"]`).getAttribute("style");

  /* --- Hero headline ------------------------------------------------ */
  await open(PRIVACY);
  await select(`section:${hero!.id}/field:title`);
  await styleTab().click();
  await page.getByText("Base", { exact: true }).waitFor({ timeout: 10_000 });
  say("the Style tab opens on the selected node", true);
  say(
    "…and says it applies at every width",
    (await page.getByText(/Applies at every width/).count()) > 0,
  );
  say(
    "…and the breakpoint scope is the device picker, not a tab of its own",
    (await page.getByRole("tab", { name: /Responsive/ }).count()) === 0,
  );
  // Motion IS a tab, from Batch 9 — it is a third draft domain with a column
  // of its own, not a scope on the styles this tab writes.
  say(
    "…while motion, which is a domain rather than a scope, has one",
    (await page.getByRole("tab", { name: /Motion/ }).count()) === 1,
  );

  const beforeStyle = await inlineStyle(frame(), `section:${hero!.id}/field:title`);
  await setToken("fontSize", "h3");
  await setToken("fontWeight", "800");
  await setToken("textColor", "peach");
  await setToken("align", "center");
  say("unsaved styles are reported", (await page.getByText("Unsaved styles").count()) > 0);
  say(
    "the canvas has not changed yet",
    (await inlineStyle(frame(), `section:${hero!.id}/field:title`)) === beforeStyle,
  );

  await saveStyles(hero!.id);
  const afterSave = await inlineStyle(frame(), `section:${hero!.id}/field:title`);
  say("the canvas reloaded with the style", /var\(--color-peach\)/.test(afterSave ?? ""), afterSave ?? "");
  say("…from the real renderer", /font-size:\s*var\(--text-h3\)/.test(afterSave ?? ""));
  say("…and text-align is logical", /text-align:\s*center/.test(afterSave ?? ""));
  say(
    "the selection came back to the same node",
    (await page.locator('[data-style-token="fontSize"]').count()) > 0,
  );
  say("the style buffer is clean", (await page.getByText("Styles saved").count()) > 0);

  const live = await fetch(`${server.origin}/privacy`).then((r) => r.text());
  say("the public page is unchanged", !/var\(--color-peach\);font-weight:800/.test(live));
  say("…and the draft is on file", (await state(hero!.id)).draft_styles !== null);

  /* --- Root layout --------------------------------------------------- */
  await select(`section:${hero!.id}`);
  await styleTab().click();
  await page.locator('[data-style-token="padBlock"]').waitFor({ timeout: 10_000 });
  say(
    "the section root offers container controls, not type",
    (await page.locator('[data-style-token="fontSize"]').count()) === 0,
  );
  await setRange("padBlock", 8);
  await setToken("background", "ink-700");
  await setToken("radius", "lg");
  await saveStyles(hero!.id);
  const rootStyle = await inlineStyle(frame(), `section:${hero!.id}`);
  say("the section root is really laid out", /background:\s*var\(--color-ink-700\)/.test(rootStyle ?? ""), rootStyle ?? "");
  say("…with logical padding", /padding-block:\s*3rem/.test(rootStyle ?? ""));

  /* --- Arabic -------------------------------------------------------- */
  await open("?page=privacy&lang=ar&device=desktop");
  const arabicRoot = await inlineStyle(frame(), `section:${hero!.id}`);
  say("the same document lays out in Arabic", /background:\s*var\(--color-ink-700\)/.test(arabicRoot ?? ""));
  say(
    "…with nothing physical in it",
    !/margin-left|margin-right|padding-left|padding-right/.test(arabicRoot ?? ""),
  );
  say("the canvas is right-to-left", (await frame().locator("html").getAttribute("dir")) === "rtl");
  say("the editor chrome is not", (await page.locator("html").getAttribute("dir")) !== "rtl");

  /* --- A repeatable card, by identity -------------------------------- */
  await open(HOME);
  const rows = (links!.published.links as Record<string, unknown>[]) ?? [];
  const cardId = String(rows[1]!._id);
  await select(`section:${links!.id}/field:links/item:${cardId}`);
  await styleTab().click();
  await page.locator('[data-style-token="radius"]').waitFor({ timeout: 10_000 });
  await setToken("radius", "xl");
  await setToken("border", "accent");
  await saveStyles(links!.id);
  say(
    "a card carries its own style",
    /border-radius:\s*var\(--radius-xl\)/.test(
      (await inlineStyle(frame(), `section:${links!.id}/field:links/item:${cardId}`)) ?? "",
    ),
  );

  // Move that row to the front of the array, behind the editor's back, and
  // reload: the style must follow the id rather than the position.
  await sql`update page_sections
               set draft = jsonb_set(coalesce(draft, published), '{links}',
                     jsonb_build_array(published->'links'->1, published->'links'->0)
                       || coalesce((published->'links') #- '{1}' #- '{0}', '[]'::jsonb)),
                   revision = revision + 1
             where id = ${links!.id}`;
  await open(HOME);
  const moved = await inlineStyle(frame(), `section:${links!.id}/field:links/item:${cardId}`);
  say("…and keeps it when the list is reordered", /border-radius:\s*var\(--radius-xl\)/.test(moved ?? ""), moved ?? "");

  /* --- Media focal point ---------------------------------------------- */
  const [withImage] = await sql<{ id: number }[]>`
    select s.id from page_sections s join pages p on p.id = s.page_id
     where p.slug = 'about' and s.block_type = 'image-text' limit 1`;
  await open("?page=about&lang=en&device=desktop");
  await select(`section:${withImage!.id}/field:image`);
  await styleTab().click();
  await page.locator('[data-style-token="objectX"]').waitFor({ timeout: 10_000 });
  say(
    "a picture is offered a focal point and no font",
    (await page.locator('[data-style-token="fontSize"]').count()) === 0,
  );
  await setRange("objectX", 15);
  await setRange("objectY", 85);
  await saveStyles(withImage!.id);
  // The crop belongs on the <img>: `object-position` on the frame around it is
  // inert, because the frame is not a replaced element.
  const media = await frame()
    .locator(`[data-eod-address="${withImage!.id ? `section:${withImage!.id}/field:image` : ""}"] img`)
    .first()
    .getAttribute("style");
  say("the focal point moves the picture in its crop", /object-position:\s*15% 85%/.test(media ?? ""), media ?? "");
  const mediaFrame = await inlineStyle(frame(), `section:${withImage!.id}/field:image`);
  say("…and not on the frame, where it would do nothing", !/object-position/.test(mediaFrame ?? ""), mediaFrame ?? "");

  /* --- 19B · choosing and replacing a picture --------------------------- */
  /**
   * A picture comes from the library and nowhere else: the Inspector offers
   * the library's chooser and no file input. Replacing it is a content change
   * to the same node, so the focal point — a style filed under that node's
   * address — stays on the new picture. And it is one rendering: the editor's
   * canvas, the ordinary preview and, once published, the public page draw
   * the same <img>.
   */
  const imageAddress = `section:${withImage!.id}/field:image`;
  const [replacement] = await sql<{ id: number; filename: string }[]>`
    select m.id, m.filename from media m
     where m.id <> (select (published->>'image')::int from page_sections where id = ${withImage!.id})
     order by m.id desc limit 1`;
  await page.getByRole("tab", { name: /Content/ }).click();
  const picker = page.locator('aside[aria-label="Inspector"] [data-field="image"]');
  await picker.waitFor({ timeout: 10_000 });
  say(
    "19B · the Inspector offers the library's chooser, named for its field, and no upload",
    (await picker.getByRole("button", { name: /^Change image$/i }).count()) === 1 &&
      (await page.locator('input[type="file"]').count()) === 0,
  );
  await picker.getByRole("button", { name: /^Change image$/i }).click();
  const library = page.getByRole("dialog", { name: /^Choose /i });
  await library.waitFor({ timeout: 10_000 });
  await library.locator(`button:has(img[src="/media/${replacement!.filename}"])`).click();
  const chosen = async () => Number((await state(withImage!.id)).draft?.image ?? 0);
  for (let i = 0; i < 100 && (await chosen()) !== replacement!.id; i += 1) await page.waitForTimeout(200);
  await editorSettled(page);
  say("19B · choosing from the library stores the picture's library id", (await chosen()) === replacement!.id,
    `${await chosen()} (wanted ${replacement!.id})`);

  const facts = (img: ReturnType<Page["locator"]>) =>
    img.first().evaluate((node) => {
      const el = node as HTMLImageElement;
      return {
        src: el.getAttribute("src"),
        srcset: el.getAttribute("srcset"),
        sizes: el.getAttribute("sizes"),
        width: el.getAttribute("width"),
        height: el.getAttribute("height"),
        alt: el.getAttribute("alt"),
        position: el.style.objectPosition,
      };
    });
  const onCanvas = await facts(frame().locator(`[data-eod-address="${imageAddress}"] img`));
  say(
    "19B · …the canvas shows the new picture, and the focal point stayed on the node",
    String(onCanvas.src).includes(replacement!.filename.replace(/\.webp$/, "")) && onCanvas.position === "15% 85%",
    JSON.stringify(onCanvas),
  );

  const viewer = await context.newPage();
  await viewer.goto(`${server!.origin}/about?preview=1`, { waitUntil: "load" });
  const inPreview = await facts(viewer.locator('[data-section="image-text"] img'));
  await page.goto(`${server!.origin}/admin/pages/section/${withImage!.id}`, { waitUntil: "load" });
  // The section screen asks before publishing; this probe answers yes.
  page.once("dialog", (dialog) => void dialog.accept());
  await page.getByRole("button", { name: "Publish draft" }).click();
  for (let i = 0; i < 80 && (await state(withImage!.id)).draft !== null; i += 1) await page.waitForTimeout(200);
  const publishedRow = await state(withImage!.id);
  await viewer.close();
  const visitor = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const visitorPage = await visitor.newPage();
  await visitorPage.goto(`${server!.origin}/about`, { waitUntil: "load" });
  const published = await facts(visitorPage.locator('[data-section="image-text"] img'));
  await visitor.close();
  say(
    "19B · the canvas, the preview and the published page draw the same picture",
    publishedRow.draft === null && publishedRow.draft_styles === null &&
      JSON.stringify(onCanvas) === JSON.stringify(inPreview) && JSON.stringify(inPreview) === JSON.stringify(published),
    `${JSON.stringify(inPreview)} | ${JSON.stringify(published)}`,
  );

  /* --- Content and style, unsaved together ---------------------------- */
  await open(PRIVACY);
  await select(`section:${hero!.id}/field:lead`);
  const startRevision = (await state(hero!.id)).revision;
  const box = page.locator('[data-field="lead"] textarea').first();
  await box.waitFor({ timeout: 10_000 });
  await box.fill("Unsaved while styling.");
  await page.getByText("Unsaved content").waitFor({ timeout: 5000 });

  await styleTab().click();
  await page.locator('[data-style-token="textColor"]').waitFor({ timeout: 10_000 });
  await setToken("textColor", "muted");
  await saveStyles(hero!.id);

  await page.getByRole("tab", { name: /Content/ }).click();
  const kept = await page.locator('[data-field="lead"] textarea').first().inputValue();
  say("content survives a style save, unchanged", kept === "Unsaved while styling.", kept);
  /**
   * Batch 10 made saving automatic, so the text is on the server by now rather
   * than still marked unsaved — which is the change, not a regression. What
   * this checks is what it always meant: the style save did not take the text
   * with it, and the text went into its own column by its own write.
   */
  const stored = await state(hero!.id);
  say(
    "…and it went into the content column, not the style one",
    ((stored.draft?.lead as { en: string } | undefined)?.en ?? "") === "Unsaved while styling." &&
      stored.draft_styles !== null,
    JSON.stringify({ lead: stored.draft?.lead, styles: stored.draft_styles !== null }),
  );

  /**
   * Each domain named the revision the one before it produced.
   *
   * Two dirty domains, two writes, and the counter moved exactly twice — which
   * is the whole of what "they share one revision timeline" has to mean. Three
   * would be a retry; one would be a lost save; and a conflict between them
   * would be this browser racing itself.
   */
  const afterBoth = await state(hero!.id);
  say(
    "…each naming the revision the one before it produced",
    afterBoth.revision === startRevision + 2,
    `revision ${startRevision} → ${afterBoth.revision}`,
  );
  say(
    "…and neither lost the other's work",
    ((afterBoth.draft as Record<string, unknown>).lead as { en: string }).en ===
      "Unsaved while styling." && afterBoth.draft_styles !== null,
  );
  say("…with no conflict between them", (await page.getByText("Somebody else saved first").count()) === 0);

  /* --- Reset ----------------------------------------------------------- */
  await open(PRIVACY);
  await select(`section:${hero!.id}/field:title`);
  await styleTab().click();
  await page.getByRole("button", { name: /Reset styles for this element/ }).click();
  say("a reset marks the styles unsaved", (await page.getByText("Unsaved styles").count()) > 0);
  await saveStyles(hero!.id);
  const afterReset = await inlineStyle(frame(), `section:${hero!.id}/field:title`);
  say("the preview returns to the design", !/var\(--color-peach\)/.test(afterReset ?? ""), afterReset ?? "");

  await context.close();

  /* --- put the fixture back -------------------------------------------- */
  await sql`update page_sections set draft = null, draft_styles = null,
                   styles = '{"v":1,"nodes":{}}'::jsonb
             where id in (${hero!.id}, ${links!.id}, ${withImage!.id})`;
  const restored = await state(hero!.id);
  say(
    "the fixture is back as it started",
    restored.draft === null && restored.draft_styles === null,
  );
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
