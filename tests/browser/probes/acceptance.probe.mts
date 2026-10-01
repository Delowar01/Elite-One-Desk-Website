/**
 * Manual browser acceptance for Batch 5 — not part of `npm test`.
 * Drives the real Visual Editor in Chromium against the real build.
 */

import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import type { Locator } from "playwright";

import { canvasRedrawn, canvasUrl, editorSettled, selectFromLayers, waitForInspector } from "../canvas";
import { launchChromium } from "../harness";
import { until } from "../wait";

const PORT = 3701;
const NEW_TEXT = "Edited from the canvas inspector.";

const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("acceptance");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  const viewer0 = await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    select 'viewer@test.invalid', 'Read Only', 'unused', id, true from roles where key = 'viewer'`;
  void viewer0;
  const viewer = await signIn(sql, "viewer");
  server = await startServer(database, PORT);

  const [hero] = await sql<{ id: number; published: Record<string, unknown> }[]>`
    select s.id, s.published from page_sections s join pages p on p.id = s.page_id
     where p.slug = 'home' and s.block_type = 'hero' limit 1`;

  const openEditor = async (cookie: string, query = "") => {
    const context = await browser.newContext({ viewport: { width: 1680, height: 1000 } });
    const [name, value] = cookie.split("=");
    await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
    const page = await context.newPage();
    page.on("pageerror", (error) => console.log("  [page error]", error.message));
    await page.goto(`${server!.origin}/admin/visual-editor${query}`, { waitUntil: "domcontentloaded" });
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 30_000 });
    return { context, page };
  };

  const canvas = (page: import("playwright").Page) => {
    const frame = page.frames().find((f) => f.url().includes("editor=1"));
    if (!frame) throw new Error("no canvas frame");
    return frame;
  };

  /* ---------------------------------------------------------------- */
  /* 1. Select, edit, save, and watch the canvas come back             */
  /* ---------------------------------------------------------------- */
  {
    const { context, page } = await openEditor(owner.cookie);
    const lead = canvas(page).locator(`[data-eod-address="section:${hero!.id}/field:lead"]`);
    await lead.waitFor({ timeout: 15_000 });
    const originalText = (await lead.innerText()).trim();
    await lead.click();

    await page.getByText("Supporting sentence").first().waitFor({ timeout: 10_000 });
    say("selecting a sentence opens its field in the inspector", true);

    const box = page.locator('[data-field="lead"] textarea').first();
    await box.waitFor({ timeout: 10_000 });
    say("the field carries the live value", (await box.inputValue()).trim() === originalText,
      `"${(await box.inputValue()).slice(0, 40)}…"`);

    const focused = await page.locator('[data-field="lead"][data-focused="true"]').count();
    say("the selected field is the one highlighted", focused === 1);

    const save = page.getByRole("button", { name: "Save now" });
    say("Save is inert until something changes", await save.isDisabled());

    await box.fill(NEW_TEXT);
    await page.getByText("Unsaved content").waitFor({ timeout: 5000 });
    say("typing marks the section unsaved", true);
    say("Layers shows the unsaved section", (await page.getByText("Unsaved", { exact: true }).count()) > 0);

    await save.click();
    await page.getByText("Draft saved").waitFor({ timeout: 20_000 });
    say("the save reports back", true);

    // The canvas reloads, and the selection is put back by address.
    await page.getByText("Ready", { exact: true }).waitFor({ timeout: 30_000 });
    const again = canvas(page).locator(`[data-eod-address="section:${hero!.id}/field:lead"]`);
    await again.waitFor({ timeout: 15_000 });
    await until(async () => (await again.innerText()).includes(NEW_TEXT), 15_000);
    say("the canvas shows the saved draft", (await again.innerText()).includes(NEW_TEXT));
    await until(async () => (await page.locator('[data-field="lead"][data-focused="true"]').count()) === 1, 15_000);
    say(
      "the selection came back to the same node",
      (await page.locator('[data-field="lead"][data-focused="true"]').count()) === 1,
    );

    const [row] = await sql<{ draft: Record<string, unknown>; published: Record<string, unknown>; revision: number }[]>`
      select draft, published, revision from page_sections where id = ${hero!.id}`;
    const draftLead = (row!.draft.lead as { en: string }).en;
    say("the draft holds it", draftLead === NEW_TEXT, draftLead);
    say("published is untouched", JSON.stringify(row!.published) === JSON.stringify(hero!.published));
    say("the revision advanced", row!.revision === 1, String(row!.revision));

    await context.close();
  }

  /* ---------------------------------------------------------------- */
  /* 2. Arabic edits one language, and says when it is falling back    */
  /* ---------------------------------------------------------------- */
  {
    const { context, page } = await openEditor(owner.cookie, "?page=home&lang=ar&device=desktop");
    const lead = canvas(page).locator(`[data-eod-address="section:${hero!.id}/field:lead"]`);
    await lead.waitFor({ timeout: 15_000 });
    await lead.click();
    const boxes = page.locator('[data-field="lead"] textarea');
    await boxes.first().waitFor({ timeout: 10_000 });
    say("one language at a time", (await boxes.count()) === 1, `${await boxes.count()} boxes`);
    say("the box is right-to-left", (await boxes.first().getAttribute("dir")) === "rtl");

    await boxes.first().fill("");
    await page.getByText(/Empty in Arabic/).waitFor({ timeout: 5000 });
    say("an empty Arabic value says the site will fall back", true);
    const english = await boxes.first().inputValue();
    say("and the English is not copied in", english === "");
    await context.close();
  }

  /* ---------------------------------------------------------------- */
  /* 3. A reader may look, not touch                                   */
  /* ---------------------------------------------------------------- */
  {
    const { context, page } = await openEditor(viewer.cookie);
    say("the toolbar says read only", (await page.getByText("Read only").count()) > 0);
    const lead = canvas(page).locator(`[data-eod-address="section:${hero!.id}/field:lead"]`);
    await lead.waitFor({ timeout: 15_000 });
    await lead.click();
    const box = page.locator('[data-field="lead"] textarea').first();
    await box.waitFor({ timeout: 10_000 });
    say("a reader sees the real content", (await box.inputValue()).includes(NEW_TEXT));
    say("but cannot type into it", await box.isDisabled());
    say("and is offered no Save", (await page.getByRole("button", { name: "Save now" }).count()) === 0);
    await context.close();
  }

  /* ---------------------------------------------------------------- */
  /* 4. A repeatable row is edited by identity                          */
  /* ---------------------------------------------------------------- */
  {
    const [links] = await sql<{ id: number; published: Record<string, unknown> }[]>`
      select s.id, s.published from page_sections s join pages p on p.id = s.page_id
       where p.slug = 'home' and s.block_type = 'quick-links' limit 1`;
    const rows = links!.published.links as Record<string, unknown>[];
    const second = String(rows[1]!._id);

    const { context, page } = await openEditor(owner.cookie);
    const card = canvas(page).locator(`[data-eod-address="section:${links!.id}/field:links/item:${second}"]`);
    await card.waitFor({ timeout: 15_000 });
    await card.click();
    await page.locator(`[data-item-id="${second}"]`).waitFor({ timeout: 10_000 });
    say("clicking a card points the panel at that row", true);
    say(
      "and says which one is selected",
      (await page.locator(`[data-item-id="${second}"]`).innerText()).includes("selected"),
    );
    await context.close();
  }

  /* ---------------------------------------------------------------- */
  /* 5. 19B: the editor by keyboard, and every control named          */
  /* ---------------------------------------------------------------- */
  {
    /**
     * Everything an editor needs can be reached and worked from the keyboard —
     * each control below is focused and pressed, never clicked — and every
     * control the shell draws has a name an assistive technology can read, at
     * three widths. State is said in words as well as in colour: the selected
     * row is `aria-current`, a lock is pressed, a tab is selected, a disabled
     * Undo says there is nothing to undo, and "unpublished changes" is the
     * Publish button's description, not only its orange dot.
     */
    const [links] = await sql<{ id: number }[]>`
      select s.id from page_sections s join pages p on p.id = s.page_id
       where p.slug = 'home' and s.block_type = 'quick-links' limit 1`;
    const { context, page } = await openEditor(owner.cookie, "?page=home&lang=en&device=desktop");
    page.on("dialog", (dialog) => void dialog.accept());
    await editorSettled(page);
    const press = async (target: Locator, key: "Enter" | "Space") => {
      await target.focus();
      await target.press(key);
    };

    type AXNode = { ignored?: boolean; role?: { value?: string }; name?: { value?: string }; backendDOMNodeId?: number };
    const INTERACTIVE = new Set([
      "button", "link", "textbox", "searchbox", "combobox", "listbox", "checkbox", "radio",
      "switch", "slider", "spinbutton", "tab", "menuitem", "option",
    ]);
    /** Interactive nodes the browser's own accessibility tree gives no name. */
    const unnamed = async (where: string): Promise<string[]> => {
      const cdp = await context.newCDPSession(page);
      try {
        await cdp.send("Accessibility.enable");
        const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as { nodes: AXNode[] };
        const bad = nodes.filter(
          (node) => !node.ignored && INTERACTIVE.has(String(node.role?.value)) && !String(node.name?.value ?? "").trim(),
        );
        const out: string[] = [];
        for (const node of bad.slice(0, 3)) {
          const html =
            node.backendDOMNodeId === undefined
              ? "?"
              : ((await cdp.send("DOM.getOuterHTML", { backendNodeId: node.backendDOMNodeId }).catch(() => ({ outerHTML: "?" }))) as {
                  outerHTML: string;
                }).outerHTML;
          out.push(`${where}: ${node.role?.value} ${html.slice(0, 100)}`);
        }
        return bad.length > out.length ? [...out, `${where}: ${bad.length} unnamed in all`] : out;
      } finally {
        await cdp.detach();
      }
    };
    const toolbarPublish = () => page.getByRole("button", { name: /^Publish$/ });
    const scan = async (width: number) => {
      await page.setViewportSize({ width, height: 1000 });
      await editorSettled(page);
      const found: string[] = [];
      // Below 1280 the editor is the toolbar and the canvas — Layers and the
      // Inspector are wide-screen panels (`xl:flex`) — so that is what is read.
      if (width < 1280) {
        found.push(...(await unnamed("the toolbar")));
        await toolbarPublish().click();
        await page.locator("aside[aria-label='Page changes and history']").waitFor({ timeout: 10_000 });
        found.push(...(await unnamed("the page panel")));
        await toolbarPublish().click();
        return found;
      }
      await selectFromLayers(page, `section:${hero!.id}`);
      for (const tab of ["Content", "Style", "Motion"]) {
        await page.getByRole("tab", { name: new RegExp(tab) }).click();
        await page.waitForTimeout(200);
        found.push(...(await unnamed(tab)));
      }
      await selectFromLayers(page, `section:${links!.id}`);
      await page.getByRole("tab", { name: /Content/ }).click();
      await page.waitForTimeout(200);
      found.push(...(await unnamed("a list")));
      const chooser = page.locator("aside[aria-label='Inspector'] button[aria-haspopup='dialog']").first();
      await chooser.click();
      await page.getByRole("dialog").first().waitFor({ timeout: 10_000 });
      found.push(...(await unnamed("the library")));
      await page.keyboard.press("Escape");
      await toolbarPublish().click();
      await page.locator("aside[aria-label='Page changes and history']").waitFor({ timeout: 10_000 });
      found.push(...(await unnamed("the page panel")));
      await toolbarPublish().click();
      return found;
    };

    const undo = page.locator('[data-history="undo"]');
    const redo = page.locator('[data-history="redo"]');
    say(
      "19B · a fresh editor's Undo is disabled and says why, in words",
      (await undo.isDisabled()) && (await undo.getAttribute("aria-label")) === "Undo — nothing to undo",
      String(await undo.getAttribute("aria-label")),
    );

    for (const width of [1680, 1280, 900]) {
      const found = await scan(width);
      say(
        width < 1280
          ? `19B · no unnamed control at ${width}, where the editor is its toolbar and canvas: the toolbar, the page panel`
          : `19B · no unnamed control at ${width}: Content, Style, Motion, a list, the picture library, the page panel`,
        found.length === 0,
        found.join(" | "),
      );
    }
    await page.setViewportSize({ width: 1680, height: 1000 });
    await editorSettled(page);

    const languages = page.getByRole("group", { name: "Canvas language" });
    const arabicButton = languages.getByRole("button", { name: "العربية" });
    const englishButton = languages.getByRole("button", { name: "English" });
    const isArabic = () => /\/ar(\/|\?|$)/.test(new URL(canvasUrl(page)).pathname + "?");
    let previous = canvasUrl(page);
    await press(arabicButton, "Enter");
    await canvasRedrawn(page, previous);
    await editorSettled(page);
    const wentArabic = isArabic() && (await arabicButton.getAttribute("aria-pressed")) === "true";
    previous = canvasUrl(page);
    await press(englishButton, "Enter");
    await canvasRedrawn(page, previous);
    await editorSettled(page);
    say(
      "19B · the canvas language changes from the keyboard, both ways",
      wentArabic && !isArabic() && (await englishButton.getAttribute("aria-pressed")) === "true",
      canvasUrl(page),
    );

    const widths = page.getByRole("group", { name: "Canvas width" });
    await press(widths.getByRole("button", { name: /Tablet/ }), "Space");
    await editorSettled(page);
    const tabletWidth = await canvas(page).evaluate(() => window.innerWidth);
    await press(widths.getByRole("button", { name: /Desktop/ }), "Enter");
    await editorSettled(page);
    const desktopWidth = await canvas(page).evaluate(() => window.innerWidth);
    say("19B · the canvas width changes from the keyboard", tabletWidth === 834 && desktopWidth === 1440,
      `${tabletWidth} → ${desktopWidth}`);

    const linksRow = page.locator(`aside[aria-label='Page structure'] [data-layer-row="section:${links!.id}"]`);
    await press(linksRow, "Enter");
    const chosen = await waitForInspector(page, `section:${links!.id}`);
    say("19B · Layers selects a section from the keyboard, and marks it current",
      chosen === `section:${links!.id}` && (await linksRow.getAttribute("aria-current")) === "true", chosen);

    const closed = await page
      .locator("aside[aria-label='Page structure'] button[data-layer-toggle][aria-expanded='false']:not([disabled])")
      .first()
      .elementHandle();
    const rowsBefore = await page.locator("aside[aria-label='Page structure'] [data-layer-row]").count();
    await closed!.focus();
    await page.keyboard.press("Enter");
    await until(async () => (await closed!.getAttribute("aria-expanded")) === "true", 5_000);
    const rowsAfter = await page.locator("aside[aria-label='Page structure'] [data-layer-row]").count();
    say("19B · …opens a branch of the tree from the keyboard", (await closed!.getAttribute("aria-expanded")) === "true" &&
      rowsAfter > rowsBefore, `${rowsBefore} → ${rowsAfter} rows`);

    const lock = page.locator("aside[aria-label='Page structure'] [data-layer-lock]").first();
    const unlockedLabel = (await lock.getAttribute("aria-label")) ?? "";
    await press(lock, "Space");
    await until(async () => (await lock.getAttribute("aria-pressed")) === "true", 5_000);
    const lockedLabel = (await lock.getAttribute("aria-label")) ?? "";
    await press(lock, "Space");
    await until(async () => (await lock.getAttribute("aria-pressed")) === "false", 5_000);
    say(
      "19B · …and locks and unlocks a node from the keyboard, saying which it is",
      /against canvas clicks$/.test(unlockedLabel) && /^Unlock /.test(lockedLabel) &&
        (await lock.getAttribute("aria-pressed")) === "false",
      `${unlockedLabel} / ${lockedLabel}`,
    );

    await press(page.locator(`aside[aria-label='Page structure'] [data-layer-row="section:${hero!.id}"]`), "Enter");
    await waitForInspector(page, `section:${hero!.id}`);
    const styleTab = page.getByRole("tab", { name: /Style/ });
    await press(styleTab, "Enter");
    await page.locator("[data-style-token]").first().waitFor({ timeout: 10_000 });
    const styleSelected = (await styleTab.getAttribute("aria-selected")) === "true";
    const contentTab = page.getByRole("tab", { name: /Content/ });
    await press(contentTab, "Enter");
    await page.locator('[data-field="lead"]').first().waitFor({ timeout: 10_000 });
    say("19B · the Inspector's tabs answer the keyboard, and say which is selected",
      styleSelected && (await contentTab.getAttribute("aria-selected")) === "true");

    const leadOf = async () =>
      (await sql<{ lead: string }[]>`select draft->'lead'->>'en' as lead from page_sections where id = ${hero!.id}`)[0]!.lead;
    const startLead = await leadOf();
    const leadBox = page.locator('[data-field="lead"] textarea').first();
    await leadBox.focus();
    await page.keyboard.press("End");
    await page.keyboard.type(" (by keyboard)");
    await until(async () => (await leadOf()) === `${startLead} (by keyboard)`, 30_000);
    await until(async () => /^Undo: /.test((await undo.getAttribute("aria-label")) ?? ""), 15_000);
    await editorSettled(page);
    await press(undo, "Enter");
    await until(async () => (await leadOf()) === startLead, 30_000);
    const undone = (await leadOf()) === startLead;
    await until(async () => /^Redo: /.test((await redo.getAttribute("aria-label")) ?? ""), 15_000);
    await editorSettled(page);
    await press(redo, "Enter");
    await until(async () => (await leadOf()) === `${startLead} (by keyboard)`, 30_000);
    say("19B · Undo and Redo, pressed from the keyboard, take the edit back and bring it back",
      undone && (await leadOf()) === `${startLead} (by keyboard)`, await leadOf());

    await editorSettled(page);
    const describedBy = await toolbarPublish().getAttribute("aria-describedby");
    const pendingWords = describedBy ? ((await page.locator(`#${describedBy}`).textContent()) ?? "").trim() : "";
    await press(toolbarPublish(), "Enter");
    const panelOpen = (await toolbarPublish().getAttribute("aria-expanded")) === "true";
    const publishSaved = page.getByRole("button", { name: "Publish saved changes" });
    await publishSaved.waitFor({ timeout: 10_000 });
    await until(async () => await publishSaved.isEnabled(), 15_000);
    await press(publishSaved, "Enter");
    await until(async () => (await sql<{ n: number }[]>`
      select count(*)::int as n from page_sections where id = ${hero!.id} and draft is null`)[0]!.n === 1, 30_000);
    const [live] = await sql<{ lead: string }[]>`select published->'lead'->>'en' as lead from page_sections where id = ${hero!.id}`;
    await until(async () => (await toolbarPublish().getAttribute("aria-describedby")) === null, 15_000);
    say(
      "19B · Publish opens and publishes from the keyboard; unpublished changes are said in words, and the words go with them",
      pendingWords === "This page has unpublished changes." && panelOpen && live!.lead === `${startLead} (by keyboard)` &&
        (await toolbarPublish().getAttribute("aria-describedby")) === null,
      `${pendingWords} | ${live!.lead}`,
    );
    await context.close();
  }

  /* ---------------------------------------------------------------- */
  /* 6. 19B: the public pages, as a screen reader meets them          */
  /* ---------------------------------------------------------------- */
  {
    /**
     * One h1 on every page, in both editions. Headings that never skip a level,
     * with one documented exception: the legal pages' rich text starts at h3
     * under the page title, because the rich-text vocabulary is h3/h4 (Batch 4)
     * — recorded in the release documents, and held here so a new skip anywhere
     * else is caught. Every picture carries an `alt`: words for the content
     * pictures, empty for an illustration beside its own words.
     */
    const visitor = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const reader = await visitor.newPage();
    const slugs = (await sql<{ slug: string }[]>`select slug from pages where is_published order by id`).map((row) => row.slug);
    const paths = slugs.flatMap((slug) => (slug === "home" ? ["/", "/ar"] : [`/${slug}`, `/ar/${slug}`]));
    const LEGAL = new Set(["privacy", "terms", "disclaimer"]);
    const notOne: string[] = [];
    const skipped: string[] = [];
    const missingAlt: string[] = [];
    const undescribed: string[] = [];
    for (const path of paths) {
      await reader.goto(`${server.origin}${path}`, { waitUntil: "load" });
      const facts = await reader.evaluate(() => {
        const allLevels = [...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((h) => Number(h.tagName[1]));
        const images = [...document.querySelectorAll("img")];
        const content = [
          ...document.querySelectorAll(
            '[data-section="travel-feature"] img, [data-section="destination-feature"] img, [data-section="image-text"] img, [data-section="featured-service"] img',
          ),
        ];
        return {
          h1: allLevels.filter((level) => level === 1).length,
          levels: allLevels,
          noAlt: images.filter((img) => !img.hasAttribute("alt")).map((img) => img.getAttribute("src") ?? ""),
          contentEmpty: content.filter((img) => !(img.getAttribute("alt") ?? "").trim()).map((img) => img.getAttribute("src") ?? ""),
        };
      });
      if (facts.h1 !== 1) notOne.push(`${path}: ${facts.h1}`);
      const slug = path.replace(/^\/(ar\/?)?/, "") || "home";
      for (let i = 1; i < facts.levels.length; i += 1) {
        const from = facts.levels[i - 1]!;
        const to = facts.levels[i]!;
        if (to > from + 1 && !(LEGAL.has(slug) && from === 1 && to === 3)) skipped.push(`${path}: h${from}→h${to}`);
      }
      missingAlt.push(...facts.noAlt.map((src) => `${path}: ${src}`));
      undescribed.push(...facts.contentEmpty.map((src) => `${path}: ${src}`));
    }
    await visitor.close();
    say(`19B · every public page has exactly one h1, in both editions (${paths.length} pages)`, notOne.length === 0, notOne.join(" | "));
    say("19B · no heading skips a level, except the legal pages' rich text under its title (documented)",
      skipped.length === 0, skipped.slice(0, 4).join(" | "));
    say("19B · every picture has an alt, and every content picture is described, in both editions",
      missingAlt.length === 0 && undescribed.length === 0, [...missingAlt, ...undescribed].slice(0, 4).join(" | "));
  }
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
