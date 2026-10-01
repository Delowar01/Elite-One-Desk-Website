/**
 * Batch 17 acceptance: reusable components in a real browser — §72 items 1–40,
 * driven through the Reusable components screen, the Visual Editor's
 * instance panel and component drawer, the canvas and the public site, with
 * every outcome read back from the database or the rendered page.
 */
import type { Frame, Page } from "playwright";

import { clickCanvasNode, selectCanvasNode } from "../canvas";
import { callAction } from "../../helpers/action";
import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";

const PORT = 3725;
const VE = { route: "/admin/visual-editor", file: "app/(backoffice)/admin/visual-editor/actions.ts" };
const RC = { route: "/admin/components", file: "app/(backoffice)/admin/(shell)/components/actions.ts" };
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("reusable_probe");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    select 'viewer@probe.invalid', 'Read Only', 'unused', id, true from roles where key = 'viewer'`;
  const viewer = await signIn(sql, "viewer");
  server = await startServer(database, PORT);
  const origin = server.origin;

  const idOf = async (slug: string) => (await sql<{ id: number }[]>`select id from pages where slug = ${slug}`)[0]!.id;
  const HOME = await idOf("home");
  const ABOUT = await idOf("about");
  const sectionId = async (pageId: number, blockType: string) =>
    (await sql<{ id: number }[]>`select id from page_sections where page_id = ${pageId} and block_type = ${blockType} order by position limit 1`)[0]!.id;
  const HOME_CTA = await sectionId(HOME, "final-cta");
  const ABOUT_CTA = await sectionId(ABOUT, "final-cta");
  type Row = { revision: number; draft: Record<string, unknown> | null; published: Record<string, unknown> };
  const state = async (id: number) =>
    (await sql<Row[]>`select revision, draft, published from page_sections where id = ${id}`)[0]!;
  const reuseOf = (values: Record<string, unknown> | null | undefined) =>
    (values?._reuse ?? null) as Record<string, { c: number; o?: string[] }> | null;
  const component = async (name: string) =>
    (await sql<{ id: number; revision: number; published_version: number; published: Record<string, unknown> | null; draft: Record<string, unknown> | null }[]>`
      select id, revision, published_version, published, draft from reusable_components where name = ${name}`)[0] ?? null;
  const until = async (what: () => Promise<boolean>, ms = 30_000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await what()) return true;
      if (Date.now() > deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  };
  const publishPage = async (pageId: number) => {
    const [row] = await sql<{ revision: number }[]>`select revision from pages where id = ${pageId}`;
    const form = new FormData();
    form.set("_csrf", owner.csrfToken);
    form.set("pageId", String(pageId));
    form.set("expectedRevision", String(row!.revision));
    const result = await callAction<{ ok: boolean; message: string }>({ ...VE, origin, action: "publishPageFromEditor", args: [form], cookie: owner.cookie });
    return result.value;
  };
  /** The live page's link whose text contains `text`: its href, or null. */
  const liveLink = async (path: string, text: string, cookie?: string) => {
    const response = await fetch(`${origin}${path}`, { headers: cookie ? { cookie } : {} });
    const html = await response.text();
    const body = html.slice(0, Math.max(0, html.search(/<script[^>]*>\s*\(?self\.__next_f/)) || html.length);
    for (const match of body.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)) {
      if (match[2]!.replace(/<[^>]+>/g, "").includes(text)) return /href="([^"]*)"/.exec(match[1]!)?.[1] ?? "";
    }
    return null;
  };
  const publicHtml = async (path: string, cookie?: string) => (await fetch(`${origin}${path}`, { headers: cookie ? { cookie } : {} })).text();

  const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [cookieName, cookieValue] = owner.cookie.split("=");
  await context.addCookies([{ name: cookieName!, value: cookieValue!, domain: "127.0.0.1", path: "/" }]);
  await context.addInitScript({ content: "window.__name = window.__name || ((fn) => fn);" });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message.slice(0, 160)));
  page.on("dialog", (dialog) => void dialog.accept());

  /* ---------------------------------------------------------------------- */
  /* Editor helpers                                                          */
  /* ---------------------------------------------------------------------- */

  const ready = async (on: Page = page) => {
    await on.getByText("Ready", { exact: true }).waitFor({ timeout: 60_000 });
    await on.waitForTimeout(400);
  };
  const open = async (query: string, on: Page = page) => {
    await on.goto(`${origin}/admin/visual-editor${query}`, { waitUntil: "load" });
    await ready(on);
  };
  const frameNow = async (on: Page = page): Promise<Frame> => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const found = on.frames().find((f) => f.url().includes("editor=1"));
      if (found) return found;
      if (Date.now() > deadline) throw new Error("the canvas frame never arrived");
      await on.waitForTimeout(150);
    }
  };
  /**
   * One click where the canvas is still, then a bounded wait for the
   * Inspector — no retries (Batch 19A — see `tests/browser/canvas.ts`).
   */
  const select = async (address: string, on: Page = page) => {
    const result = await selectCanvasNode(on, address);
    if (result.ok) return true;
    console.log(`   [select failed] ${address} → ${result.shows}; the click landed on ${JSON.stringify(result.landing)}`);
    return false;
  };
  const contentTab = async () => {
    await page.getByRole("tab", { name: /Content/ }).click();
    await page.waitForTimeout(200);
  };
  const slotPanel = (slot = "primaryCta") => page.locator(`aside[aria-label='Inspector'] [data-reuse-slot="${slot}"]`).first();
  const canvasCta = async (id: number) => {
    const frame = await frameNow();
    const element = frame.locator(`[data-eod-address="section:${id}/field:primaryCtaLabel"]`).first();
    await element.waitFor({ state: "attached", timeout: 20_000 });
    return { text: ((await element.textContent()) ?? "").trim(), href: (await element.getAttribute("href")) ?? "" };
  };
  const saved = async (id: number, check: (row: Row) => boolean, ms = 30_000) => until(async () => check(await state(id)), ms);
  const drawer = () => page.locator("[data-reuse-drawer]");
  /** Opens the per-key override controls, whatever state the panel started in. */
  const expandOverrides = async () => {
    const toggle = slotPanel().getByRole("button", { name: "Override this instance" });
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  };
  const undo = () => page.locator('[data-history="undo"]');

  /* ====================================================================== */
  /* CTA 1–10                                                               */
  /* ====================================================================== */

  // 1. Create a draft on the Reusable components screen.
  await page.goto(`${origin}/admin/components`, { waitUntil: "load" });
  await page.getByRole("button", { name: "New reusable component" }).click();
  const create = page.getByRole("form", { name: "New reusable component" });
  await create.getByLabel("Type").selectOption("cta");
  await create.getByLabel(/^Name/).fill("Primary Contact CTA");
  // Marks this document: a page the browser loads starts without it (19B).
  await page.evaluate(() => ((window as unknown as { __eodList?: boolean }).__eodList = true));
  await create.getByRole("button", { name: "Create draft" }).click();
  await page.waitForURL(/\/admin\/components\/\d+$/, { timeout: 30_000 });
  const created = await component("Primary Contact CTA");
  const CID = created?.id ?? 0;
  /**
   * The new component is opened by the browser, not by a client transition
   * that could be left uncommitted (see `components-client.tsx` and
   * `tests/stress/create-navigation.stress.mts`).
   */
  say("19B · Create draft opens the new component by loading its page — no client transition left to hang",
    page.url().endsWith(`/admin/components/${CID}`) &&
      !(await page.evaluate(() => Boolean((window as unknown as { __eodList?: boolean }).__eodList))),
    page.url());
  await page.locator(`#reusable-${CID}-label-en`).fill("Contact our desk");
  await page.locator(`#reusable-${CID}-label-ar`).fill("تواصل مع مكتبنا");
  await page.locator(`#reusable-${CID}-href`).fill("/contact");
  await page.locator("[data-reuse-save]").click();
  const draftSaved = await until(async () => (await component("Primary Contact CTA"))?.draft?.href === "/contact");
  const afterDraft = await component("Primary Contact CTA");
  say("1. a reusable CTA is created as a draft — nothing published", Boolean(created) && draftSaved && afterDraft!.published_version === 0 && afterDraft!.published === null,
    JSON.stringify(afterDraft?.draft));

  /**
   * 19B · the component screen's four confirmations are alertdialogs that
   * open with the focus on Cancel — the choice that changes nothing — so a
   * keyboard reaches it before the destructive button and a screen reader is
   * brought into the warning. Discard and Delete are opened and cancelled
   * with Enter here, while the component is still an unused draft; Publish
   * and Restore are checked where the steps below open them anyway. A miss is
   * closed by its Cancel button, so it is reported rather than left open.
   */
  const cancelHasFocus = () =>
    page.evaluate(() => {
      const active = document.activeElement;
      return (active?.textContent ?? "").trim() === "Cancel" && Boolean(active?.closest("[role='alertdialog']"));
    });
  const focusMissed: string[] = [];
  for (const [opener, name] of [
    ["[data-reuse-discard]", "Discard the draft"],
    ["[data-reuse-delete]", "Delete the component"],
  ] as const) {
    await page.locator(opener).click();
    const dialog = page.getByRole("alertdialog", { name });
    await dialog.waitFor({ timeout: 10_000 });
    if (await cancelHasFocus()) await page.keyboard.press("Enter");
    else {
      focusMissed.push(name);
      await dialog.getByRole("button", { name: "Cancel" }).click();
    }
    await dialog.waitFor({ state: "detached", timeout: 10_000 });
  }
  const cancelledNothing = (await component("Primary Contact CTA"))?.draft?.href === "/contact";

  // 2. Publish it — confirmed, with the impact said first.
  await page.locator("[data-reuse-publish]").click();
  await page.getByRole("alertdialog", { name: "Publish the component" }).waitFor({ timeout: 10_000 });
  if (!(await cancelHasFocus())) focusMissed.push("Publish the component");
  const firstImpact = (await page.locator("[data-reuse-impact]").textContent()) ?? "";
  await page.locator("[data-reuse-publish-yes]").click();
  const published1 = await until(async () => (await component("Primary Contact CTA"))?.published_version === 1);
  say("2. publishing it makes version 1, after a confirmation that says nothing live changes", published1 && /changes nothing visitors see/.test(firstImpact), firstImpact);

  // 3. Link the Home closing CTA to it, from the instance panel.
  await open("?page=home&lang=en&device=desktop");
  await select(`section:${HOME_CTA}/field:primaryCtaLabel`);
  await contentTab();
  await slotPanel().getByRole("button", { name: "Link to reusable CTA…" }).click();
  await page.locator(`[data-reuse-choice="${CID}"]`).click();
  const linkedHome = await saved(HOME_CTA, (row) => reuseOf(row.draft)?.primaryCta?.c === CID);
  say("3. the Home CTA is linked — the reference is in the section's draft", linkedHome, JSON.stringify(reuseOf((await state(HOME_CTA)).draft)));
  const undoLabelLink = (await undo().getAttribute("aria-label")) ?? "";
  say("…and Undo names the link", /Link primary call to action to “Primary Contact CTA”/.test(undoLabelLink), undoLabelLink);

  // 4. The same component on a second page.
  await open("?page=about&lang=en&device=desktop");
  await select(`section:${ABOUT_CTA}/field:primaryCtaLabel`);
  await contentTab();
  await slotPanel().getByRole("button", { name: "Link to reusable CTA…" }).click();
  await page.locator(`[data-reuse-choice="${CID}"]`).click();
  const linkedAbout = await saved(ABOUT_CTA, (row) => reuseOf(row.draft)?.primaryCta?.c === CID);
  say("4. the About CTA is linked to the same component", linkedAbout);

  // 5. Used on 2 pages — the panel reads the usage back.
  await until(async () => /Used on 2 pages/.test((await slotPanel().locator("[data-reuse-usage]").textContent().catch(() => "")) ?? ""), 20_000);
  const usageText = (await slotPanel().locator("[data-reuse-usage]").textContent()) ?? "";
  say("5. the instance panel says “Used on 2 pages”", /Used on 2 pages/.test(usageText), usageText);
  say("…and the Layers row for the section carries the Reusable badge",
    (await page.locator(`[data-layer-reusable="${ABOUT_CTA}"]`).count()) > 0);
  // R1 (review correction). A CTA linked on its own rules out the whole section, and the panel says so.
  const wholeSlot = page.locator(`aside[aria-label='Inspector'] [data-reuse-slot="block"]`).first();
  const blockedNote = ((await wholeSlot.locator("[data-reuse-blocked]").textContent().catch(() => "")) ?? "").trim();
  say("R1. a section whose CTA is linked on its own offers no whole-section reuse, and says why",
    blockedNote === "Detach the reusable CTA links in this section before making the whole section reusable." &&
      (await wholeSlot.getByRole("button").count()) === 0,
    blockedNote);

  await publishPage(HOME);
  await publishPage(ABOUT);
  const homeLive = await liveLink("/", "Contact our desk");
  const aboutLive = await liveLink("/about", "Contact our desk");
  say("…both pages published show the component's content", homeLive === "/contact" && aboutLive === "/contact", `${homeLive} ${aboutLive}`);

  // 6. Change the global label as a draft, from the drawer.
  await open("?page=about&lang=en&device=desktop");
  await select(`section:${ABOUT_CTA}/field:primaryCtaLabel`);
  await contentTab();
  await slotPanel().getByRole("button", { name: "Edit global component" }).click();
  await drawer().waitFor({ timeout: 15_000 });
  const warning = (await drawer().locator("[data-reuse-warning]").textContent()) ?? "";
  await drawer().locator(`#reusable-${CID}-label-en`).fill("Speak to an advisor");
  await drawer().locator("[data-reuse-save]").click();
  const draftPending = await until(async () => ((await component("Primary Contact CTA"))?.draft?.label as { en?: string } | undefined)?.en === "Speak to an advisor");
  say("6. the global label is changed as a draft, behind the reusable-component warning",
    draftPending && /Changes can affect every linked instance/.test(warning), warning.slice(0, 80));

  // 7. Public unchanged.
  say("7. the public pages still show the published label",
    (await liveLink("/", "Contact our desk")) === "/contact" && (await liveLink("/", "Speak to an advisor")) === null);

  // 8. Global preview shows the pending draft on a linked page.
  const previewHref = (await drawer().locator('[data-reuse-preview="home"]').getAttribute("href")) ?? "";
  const previewPage = await context.newPage();
  await previewPage.goto(`${origin}${previewHref}`, { waitUntil: "load" });
  const previewHtml = await previewPage.content();
  say("8. the component's preview draws the pending draft on Home, with its banner",
    previewHtml.includes("Speak to an advisor") && /unpublished draft of the reusable component/.test(previewHtml), previewHref);
  await previewPage.close();

  // 9. Publish — the confirmation names the visitor impact (23).
  await drawer().locator("[data-reuse-publish]").click();
  const impact = (await drawer().locator("[data-reuse-impact]").textContent()) ?? "";
  const pagesListed = await drawer().locator("[data-reuse-publish-confirm] li").allTextContents();
  say("23. the confirmation names the instances and pages it will update",
    impact === "This will update 2 linked instances across 2 published pages." && pagesListed.length === 2, `${impact} | ${pagesListed.join(" / ")}`);
  await drawer().locator("[data-reuse-publish-yes]").click();
  const published2 = await until(async () => (await component("Primary Contact CTA"))?.published_version === 2);
  say("9. publishing makes version 2", published2);
  /**
   * The row is committed before the action has finished: `revalidateTag` in a
   * Server Action only queues the tag, and Next drops the page cache when the
   * action completes. Reading the public pages the moment the database shows
   * version 2 can therefore land between the two and see the cached page (seen
   * once in Batch 18's ×10). The editor's "Published version 2" is written
   * when the action has returned — that is the publication being over, and
   * the point from which "at once" is promised.
   */
  await until(async () => /Published version 2/.test((await drawer().locator("[data-reuse-message]").textContent().catch(() => "")) ?? ""), 20_000);

  // 10. Both pages update — with no page publication.
  say("10. both pages show the new label at once",
    (await liveLink("/", "Speak to an advisor")) === "/contact" && (await liveLink("/about", "Speak to an advisor")) === "/contact");
  await drawer().getByRole("button", { name: "Close" }).click();

  /* ====================================================================== */
  /* Override 11–16                                                         */
  /* ====================================================================== */

  await open("?page=about&lang=en&device=desktop");
  await select(`section:${ABOUT_CTA}/field:primaryCtaLabel`);
  await contentTab();
  await expandOverrides();
  await slotPanel().locator('[data-reuse-key="primaryCtaHref"]').getByRole("button", { name: "Override on this page" }).click();
  const hrefBox = page.locator(`#reuse-${ABOUT_CTA}-primaryCtaHref`);
  await hrefBox.waitFor({ timeout: 10_000 });
  await hrefBox.fill("/book-about");
  const overridden = await saved(ABOUT_CTA, (row) => row.draft?.primaryCtaHref === "/book-about" && (reuseOf(row.draft)?.primaryCta?.o ?? []).includes("primaryCtaHref"));
  say("11. About overrides the link on this page only — sparse, one key", overridden, JSON.stringify(reuseOf((await state(ABOUT_CTA)).draft)));
  await publishPage(ABOUT);

  // 12. The global link changes.
  const view = async () =>
    (await callAction<{ revision: number }>({ ...RC, origin, action: "loadReusableComponent", args: [CID], cookie: owner.cookie })).value!;
  const componentWrite = async (action: string, fields: Record<string, string>) => {
    const form = new FormData();
    form.set("_csrf", owner.csrfToken);
    form.set("id", String(CID));
    form.set("expectedRevision", String((await view()).revision));
    for (const [key, value] of Object.entries(fields)) form.set(key, value);
    return (await callAction<{ ok: boolean; message: string }>({ ...RC, origin, action, args: [form], cookie: owner.cookie })).value!;
  };
  const globalValues = (en: string, ar: string, href: string) => JSON.stringify({ label: { en, ar }, href });
  await componentWrite("saveReusableDraft", { values: globalValues("Speak to an advisor", "تحدث إلى مستشار", "/advisors") });
  const pub3 = await componentWrite("publishReusable", {});
  say("12. the global link changes (version 3)", pub3.ok, pub3.message);

  // 13–14.
  say("13. Home inherits the new link", (await liveLink("/", "Speak to an advisor")) === "/advisors");
  say("14. About keeps its own link", (await liveLink("/about", "Speak to an advisor")) === "/book-about");

  // 15–16. Reset the override.
  await open("?page=about&lang=en&device=desktop");
  await select(`section:${ABOUT_CTA}/field:primaryCtaLabel`);
  await contentTab();
  await slotPanel().locator('[data-reuse-key="primaryCtaHref"]').getByRole("button", { name: "Reset override" }).click();
  // Saved means a draft exists and it no longer overrides the link — an absent
  // draft also "has no override", and would be read as saved before the autosave.
  const reset = await saved(
    ABOUT_CTA,
    (row) => row.draft !== null && reuseOf(row.draft)?.primaryCta !== undefined && !(reuseOf(row.draft)?.primaryCta?.o ?? []).includes("primaryCtaHref"),
  );
  say("15. resetting the override takes the key back to inherited", reset);
  const resetLabel = (await undo().getAttribute("aria-label")) ?? "";
  say("…and Undo names the reset", /Reset override of Link/.test(resetLabel), resetLabel);
  await publishPage(ABOUT);
  say("16. About inherits the global link again", (await liveLink("/about", "Speak to an advisor")) === "/advisors");

  /* ====================================================================== */
  /* Detach 17–22                                                           */
  /* ====================================================================== */

  await open("?page=about&lang=en&device=desktop");
  await select(`section:${ABOUT_CTA}/field:primaryCtaLabel`);
  await contentTab();
  const beforeDetach = await canvasCta(ABOUT_CTA);
  await slotPanel().getByRole("button", { name: "Detach from global" }).click();
  const confirmText = (await slotPanel().locator("[data-reuse-detach-confirm]").textContent()) ?? "";
  await slotPanel().locator("[data-reuse-detach-confirm]").getByRole("button", { name: "Detach", exact: true }).click();
  const detached = await saved(ABOUT_CTA, (row) => row.draft !== null && reuseOf(row.draft) === null);
  say("17. About is detached — the reference is gone from its draft", detached,
    confirmText.includes("It will keep its current content but will no longer receive future global updates.") ? "" : `confirm: ${confirmText}`);
  await ready();
  const afterDetach = await canvasCta(ABOUT_CTA);
  say("18. the canvas looks exactly the same after detaching",
    afterDetach.text === beforeDetach.text && afterDetach.href === beforeDetach.href, `${JSON.stringify(beforeDetach)} → ${JSON.stringify(afterDetach)}`);
  await publishPage(ABOUT);
  await componentWrite("saveReusableDraft", { values: globalValues("Ask us anything", "اسألنا", "/advisors") });
  await componentWrite("publishReusable", {});
  say("19. the component changes after the detach", (await liveLink("/", "Ask us anything")) === "/advisors");
  say("20. About no longer follows it", (await liveLink("/about", "Speak to an advisor")) === "/advisors" && (await liveLink("/about", "Ask us anything")) === null);

  // 21–22. Undo the detach, in the same editor session.
  await open("?page=about&lang=en&device=desktop");
  await select(`section:${ABOUT_CTA}/field:primaryCtaLabel`);
  await contentTab();
  // The history of the earlier session is gone with the reload: link again here, detach, then undo.
  const aboutRow = await state(ABOUT_CTA);
  const linkAgain = await (async () => {
    // About is detached now; link it back through the panel so there is something to detach and undo.
    await slotPanel().getByRole("button", { name: "Link to reusable CTA…" }).click();
    await page.locator(`[data-reuse-choice="${CID}"]`).click();
    return saved(ABOUT_CTA, (row) => reuseOf(row.draft)?.primaryCta?.c === CID);
  })();
  void aboutRow;
  await ready();
  await select(`section:${ABOUT_CTA}/field:primaryCtaLabel`);
  await contentTab();
  await slotPanel().getByRole("button", { name: "Detach from global" }).click();
  await slotPanel().locator("[data-reuse-detach-confirm]").getByRole("button", { name: "Detach", exact: true }).click();
  const detachedAgain = await saved(ABOUT_CTA, (row) => row.draft !== null && reuseOf(row.draft) === null);
  // The server writes a detach before its answer reaches the editor, and the
  // editor enters the action in the page's history when the answer arrives —
  // so the label is read once the editor has had the answer, not the moment
  // the row changes. The assertion below is unchanged.
  await until(async () => /^Undo: Detach /.test((await undo().getAttribute("aria-label")) ?? ""), 15_000);
  const detachUndoLabel = (await undo().getAttribute("aria-label")) ?? "";
  await ready();
  await undo().click();
  const restoredRef = await saved(ABOUT_CTA, (row) => reuseOf(row.draft)?.primaryCta?.c === CID);
  say("21. Undo takes the detach back", linkAgain && detachedAgain && /Undo: Detach primary call to action from “Primary Contact CTA”/.test(detachUndoLabel), detachUndoLabel);
  say("22. the reference is restored and saved", restoredRef, JSON.stringify(reuseOf((await state(ABOUT_CTA)).draft)));
  await publishPage(ABOUT);

  /* 19B · the detach warning and the picker, from the keyboard alone -------- */
  /**
   * Linking and detaching need no pointer. The detach warning is an
   * alertdialog that takes the focus onto Cancel — the choice that changes
   * nothing — so Enter there changes nothing, and Detach is one Shift+Tab
   * away. The picker opens on Enter with its search box focused, and a
   * component is chosen with Tab and Enter. About ends linked and published,
   * exactly as step 22 left it, for the steps that follow.
   */
  await open("?page=about&lang=en&device=desktop");
  await select(`section:${ABOUT_CTA}/field:primaryCtaLabel`);
  await contentTab();
  const focusedText = () => page.evaluate(() => (document.activeElement?.textContent ?? "").trim());
  const detachButton = slotPanel().getByRole("button", { name: "Detach from global" });
  const detachWarning = slotPanel().getByRole("alertdialog", { name: "Detach this instance" });
  await detachButton.focus();
  await page.keyboard.press("Enter");
  await detachWarning.waitFor({ timeout: 10_000 });
  const firstFocus = await focusedText();
  const firstFocusInside = await page.evaluate(() => Boolean(document.activeElement?.closest("[role='alertdialog']")));
  // Enter on Cancel closes the warning. Without the focus there, it is closed
  // by its button, so the line below reports the miss instead of timing out.
  if (firstFocus === "Cancel" && firstFocusInside) await page.keyboard.press("Enter");
  else await detachWarning.getByRole("button", { name: "Cancel" }).click();
  await detachWarning.waitFor({ state: "detached", timeout: 10_000 });
  const untouched = await state(ABOUT_CTA);
  say(
    "19B · the detach warning takes the focus onto Cancel, and Enter there changes nothing",
    firstFocus === "Cancel" && firstFocusInside && untouched.draft === null &&
      reuseOf(untouched.published)?.primaryCta?.c === CID,
    firstFocus,
  );

  await detachButton.focus();
  await page.keyboard.press("Enter");
  await detachWarning.waitFor({ timeout: 10_000 });
  await page.keyboard.press("Shift+Tab");
  const secondFocus = await focusedText();
  await page.keyboard.press("Enter");
  const detachedByKeys = await saved(ABOUT_CTA, (row) => row.draft !== null && reuseOf(row.draft) === null);
  say("19B · …and Detach, one Shift+Tab away, detaches on Enter", secondFocus === "Detach" && detachedByKeys, secondFocus);

  await ready();
  await select(`section:${ABOUT_CTA}/field:primaryCtaLabel`);
  await contentTab();
  const linkButton = slotPanel().getByRole("button", { name: "Link to reusable CTA…" });
  await linkButton.focus();
  await page.keyboard.press("Enter");
  const search = slotPanel().locator("[data-reuse-picker] input[type='search']");
  await search.waitFor({ timeout: 10_000 });
  const searchFocused = await search.evaluate((input) => input === document.activeElement);
  await page.keyboard.type("Primary Contact");
  let onChoice = false;
  for (let i = 0; i < 4 && !onChoice; i += 1) {
    await page.keyboard.press("Tab");
    onChoice = await page.evaluate((id) => document.activeElement?.getAttribute("data-reuse-choice") === String(id), CID);
  }
  if (onChoice) await page.keyboard.press("Enter");
  const linkedByKeys = await saved(ABOUT_CTA, (row) => reuseOf(row.draft)?.primaryCta?.c === CID);
  say("19B · the picker opens on Enter with its search focused; Tab and Enter choose the component",
    searchFocused && onChoice && linkedByKeys, `search focused ${searchFocused}, choice reached ${onChoice}`);
  await ready();
  await publishPage(ABOUT);

  /* ====================================================================== */
  /* EN / AR 24–27                                                          */
  /* ====================================================================== */

  await componentWrite("saveReusableDraft", { values: globalValues("Global English", "عربي عام", "/advisors") });
  await componentWrite("publishReusable", {});
  say("24. the global English label reaches the English page", (await liveLink("/", "Global English")) === "/advisors");
  const arHome = await publicHtml("/ar");
  say("25. the global Arabic label reaches the Arabic page", arHome.includes("عربي عام"));

  // 26. English-only override on Home.
  await open("?page=home&lang=en&device=desktop");
  await select(`section:${HOME_CTA}/field:primaryCtaLabel`);
  await contentTab();
  await expandOverrides();
  await slotPanel().locator('[data-reuse-key="primaryCtaLabel.en"]').getByRole("button", { name: "Override on this page" }).click();
  const enBox = page.locator(`#reuse-${HOME_CTA}-primaryCtaLabel-en`);
  await enBox.waitFor({ timeout: 10_000 });
  await enBox.fill("English on Home only");
  await saved(HOME_CTA, (row) => (row.draft?.primaryCtaLabel as { en?: string } | undefined)?.en === "English on Home only");
  await publishPage(HOME);
  say("26. an English-only override changes English and leaves Arabic inherited",
    (await liveLink("/", "English on Home only")) === "/advisors" && (await publicHtml("/ar")).includes("عربي عام"));

  // 27. Arabic-only override, in the Arabic canvas.
  await open("?page=home&lang=ar&device=desktop");
  await select(`section:${HOME_CTA}/field:primaryCtaLabel`);
  await contentTab();
  await expandOverrides();
  await slotPanel().locator('[data-reuse-key="primaryCtaLabel.ar"]').getByRole("button", { name: "Override on this page" }).click();
  const arBox = page.locator(`#reuse-${HOME_CTA}-primaryCtaLabel-ar`);
  await arBox.waitFor({ timeout: 10_000 });
  await arBox.fill("عربي للرئيسية فقط");
  await saved(HOME_CTA, (row) => (row.draft?.primaryCtaLabel as { ar?: string } | undefined)?.ar === "عربي للرئيسية فقط");
  await publishPage(HOME);
  const arAfter = await publicHtml("/ar");
  say("27. an Arabic-only override changes Arabic; English keeps its own override",
    arAfter.includes("عربي للرئيسية فقط") && (await liveLink("/", "English on Home only")) === "/advisors");

  /* ====================================================================== */
  /* Direct editing 36–37                                                    */
  /* ====================================================================== */

  // 37. The Arabic edition is overridden: typing on the canvas edits it, locally.
  // A fresh editor: the page was just published from outside this one, which
  // moved the section's revision under it — typing into the old session would
  // be a conflict, correctly.
  await open("?page=home&lang=ar&device=desktop");
  // One double-click where the canvas is still, in page pixels (Batch 19A:
  // a forced double-click could land beside a moving label, so it was tried
  // three times — see `tests/browser/canvas.ts`).
  const arNode = (await frameNow()).locator(`[data-eod-address="section:${HOME_CTA}/field:primaryCtaLabel"]`).first();
  await arNode.waitFor({ state: "attached", timeout: 20_000 });
  await clickCanvasNode(page, arNode, "own", { double: true });
  // The edit begins once the editor has the section's row, and on an editor
  // opened a moment ago that load queues behind the page's own first reads —
  // so the bound is generous (30 s); it is a bound, not a wait.
  const editable = await until(async () => (await arNode.getAttribute("contenteditable").catch(() => null)) === "plaintext-only", 30_000);
  if (editable) {
    await arNode.selectText().catch(() => undefined);
    await page.keyboard.type("كتابة محلية");
    await page.keyboard.press("Enter");
  }
  const localTyped = await saved(HOME_CTA, (row) => (row.draft?.primaryCtaLabel as { ar?: string } | undefined)?.ar === "كتابة محلية");
  const globalUntouched = ((await component("Primary Contact CTA"))!.published!.label as { ar: string }).ar === "عربي عام";
  say("37. in override mode, typing on the canvas edits this page's override only", editable && localTyped && globalUntouched);

  // 36. Linked text with no override: a double-click opens the Inspector's explanation, not an edit.
  await open("?page=about&lang=en&device=desktop");
  const enNode = (await frameNow()).locator(`[data-eod-address="section:${ABOUT_CTA}/field:primaryCtaLabel"]`).first();
  await enNode.waitFor({ state: "attached", timeout: 20_000 });
  const revisionBefore = (await state(ABOUT_CTA)).revision;
  await clickCanvasNode(page, enNode, "own", { double: true });
  const noticeShown = await until(async () => (await page.locator("[data-reuse-notice]").count()) > 0, 30_000);
  const noticeText = noticeShown ? ((await page.locator("[data-reuse-notice]").first().textContent()) ?? "") : "";
  await page.waitForTimeout(800);
  say("36. linked text is not typed into: the Inspector says where it comes from",
    noticeShown && (await enNode.getAttribute("contenteditable")) !== "plaintext-only" &&
      /This text comes from reusable component “Primary Contact CTA”/.test(noticeText) &&
      (await state(ABOUT_CTA)).revision === revisionBefore,
    noticeText.slice(0, 90));

  /* ====================================================================== */
  /* History 28–33                                                          */
  /* ====================================================================== */

  await componentWrite("saveReusableDraft", { values: globalValues("Alpha", "ألفا", "/alpha") });
  await componentWrite("publishReusable", {});
  say("28. version “Alpha” is published", (await liveLink("/about", "Alpha")) === "/alpha");
  await componentWrite("saveReusableDraft", { values: globalValues("Bravo", "برافو", "/bravo") });
  await componentWrite("publishReusable", {});
  say("29. version “Bravo” is published", (await liveLink("/about", "Bravo")) === "/bravo");

  await page.goto(`${origin}/admin/components/${CID}`, { waitUntil: "load" });
  const alphaVersion = (await component("Primary Contact CTA"))!.published_version - 1;
  await page.locator(`[data-reuse-version="${alphaVersion}"]`).getByRole("button", { name: "Restore to draft" }).click();
  const restoreDialog = page.getByRole("alertdialog", { name: "Restore a version to the draft" });
  await restoreDialog.waitFor({ timeout: 10_000 });
  if (!(await cancelHasFocus())) focusMissed.push("Restore a version to the draft");
  const restoreWarning = (await restoreDialog.textContent()) ?? "";
  await restoreDialog.getByRole("button", { name: "Restore to draft" }).click();
  const alphaDraft = await until(async () => ((await component("Primary Contact CTA"))?.draft?.label as { en?: string } | undefined)?.en === "Alpha");
  say("30. restoring “Alpha” stages it as the draft, with the usage warning",
    alphaDraft && /Publishing this restored CTA will update 2 instances on 2 published pages/.test(restoreWarning), restoreWarning.slice(0, 140));
  say("19B · the component screen's four confirmations — discard, delete, publish, restore — open with the focus on Cancel, and cancelling changes nothing",
    focusMissed.length === 0 && cancelledNothing, focusMissed.length ? `not on Cancel: ${focusMissed.join(", ")}` : "all four on Cancel");
  say("31. the live pages still show “Bravo”", (await liveLink("/about", "Bravo")) === "/bravo");
  await page.locator("[data-reuse-publish]").click();
  await page.locator("[data-reuse-publish-yes]").click();
  await until(async () => (await component("Primary Contact CTA"))?.draft === null);
  say("32. the restored version is published", (await component("Primary Contact CTA"))?.draft === null);
  // As at step 10: the publication is over when the action has returned (its
  // cache drop is applied then), not when the row is committed.
  await until(async () => /Published version/.test((await page.locator("[data-reuse-message]").textContent().catch(() => "")) ?? ""), 20_000);
  say("33. every linked page shows “Alpha” again", (await liveLink("/about", "Alpha")) === "/alpha");

  /* ====================================================================== */
  /* Compare 34–35                                                          */
  /* ====================================================================== */

  // A page publication takes a restore point of About as it stood — pinned to the version it showed.
  await sql`update page_sections set draft = jsonb_set(published, '{title}', '{"en":"Compare me","ar":""}'::jsonb), revision = revision + 1 where id = ${ABOUT_CTA}`;
  await publishPage(ABOUT);
  const [versionRow] = await sql<{ id: number }[]>`select id from page_versions where page_id = ${ABOUT} order by id desc limit 1`;
  await componentWrite("saveReusableDraft", { values: globalValues("Charlie", "تشارلي", "/charlie") });
  await componentWrite("publishReusable", {});
  const comparePage = await context.newPage();
  await comparePage.goto(`${origin}/admin/compare?page=${ABOUT}&version=${versionRow!.id}`, { waitUntil: "load" });
  // Until the historical pane has loaded its document (Batch 19A: was a fixed 1.5 s).
  await until(async () => {
    const pane = comparePage.frames().find((f) => f.url().includes(`compare=v${versionRow!.id}`));
    return pane ? (await pane.evaluate(() => document.readyState === "complete" && document.body.innerText.trim().length > 0)) : false;
  }, 20_000);
  const leftFrame = comparePage.frames().find((f) => f.url().includes(`compare=v${versionRow!.id}`));
  const leftText = leftFrame ? await leftFrame.evaluate(() => document.body.innerText) : "";
  say("34. the historical pane draws the component as that version showed it", leftText.includes("Alpha") && !leftText.includes("Charlie"),
    leftFrame ? "" : "no historical pane");
  const summary = await comparePage.locator("body").innerText();
  say("35. the comparison names the reusable component and what changed about it",
    summary.includes("Primary Contact CTA") && /global change/.test(summary) && summary.includes("Reusable components are not site globals"));
  await comparePage.close();

  /* ====================================================================== */
  /* Global edits beside page Undo (§53), and a global conflict (§52)       */
  /* ====================================================================== */

  await open("?page=home&lang=en&device=desktop");
  await select(`section:${HOME_CTA}/field:title`);
  await contentTab();
  const titleBox = page.locator("#field-title-en");
  await titleBox.waitFor({ timeout: 15_000 });
  await titleBox.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" (undoable)");
  await until(async () => String(((await state(HOME_CTA)).draft?.title as { en?: string } | undefined)?.en ?? "").endsWith("(undoable)"));
  const undoBefore = (await undo().getAttribute("aria-label")) ?? "";
  await select(`section:${HOME_CTA}/field:primaryCtaLabel`);
  await contentTab();
  await slotPanel().getByRole("button", { name: "Edit global component" }).click();
  await drawer().waitFor({ timeout: 15_000 });
  await drawer().locator(`#reusable-${CID}-label-en`).fill("Published from the drawer");
  await drawer().locator("[data-reuse-save]").click();
  await until(async () => ((await component("Primary Contact CTA"))?.draft?.label as { en?: string } | undefined)?.en === "Published from the drawer");
  await drawer().locator("[data-reuse-publish]").click();
  await drawer().locator("[data-reuse-publish-yes]").click();
  await until(async () => (await component("Primary Contact CTA"))?.draft === null);
  await ready();
  const undoAfter = (await undo().getAttribute("aria-label")) ?? "";
  say("53. publishing a component leaves this page's Undo exactly as it was",
    undoBefore === undoAfter && /Change Title \(English\)/.test(undoAfter), `${undoBefore} → ${undoAfter}`);

  // 52. A colleague saves the component while the drawer is open: Save is refused, and Reload latest offers theirs.
  await drawer().locator(`#reusable-${CID}-label-en`).fill("My words");
  await componentWrite("saveReusableDraft", { values: globalValues("Their words", "", "/theirs") });
  await drawer().locator("[data-reuse-save]").click();
  const conflictShown = await until(async () => (await drawer().locator("[data-reuse-conflict]").count()) > 0, 15_000);
  const stillTheirs = ((await component("Primary Contact CTA"))?.draft?.label as { en?: string } | undefined)?.en === "Their words";
  if (conflictShown) await drawer().locator("[data-reuse-conflict]").getByRole("button", { name: "Reload latest" }).click();
  const reloaded = (await drawer().locator(`#reusable-${CID}-label-en`).inputValue().catch(() => "")) === "Their words";
  say("52. a stale component save is refused, nothing merged, and Reload latest shows the winner",
    conflictShown && stillTheirs && reloaded);
  await componentWrite("discardReusableDraft", {});
  await drawer().getByRole("button", { name: "Close" }).click();

  // R2 (review correction). Save as reusable publishes nothing unless publishing is chosen.
  const ABOUT_IMAGE = await sectionId(ABOUT, "image-text");
  await open("?page=about&lang=en&device=desktop");
  await select(`section:${ABOUT_IMAGE}/field:ctaLabel`);
  await contentTab();
  await slotPanel("cta").getByRole("button", { name: "Save as reusable CTA…" }).click();
  const saveForm = slotPanel("cta").locator("[data-reuse-save-as]");
  const draftChecked = await saveForm.locator('[data-reuse-save-mode="draft"]').isChecked();
  const publishChecked = await saveForm.locator('[data-reuse-save-mode="publish"]').isChecked();
  const submitText = ((await saveForm.locator("[data-reuse-save-submit]").textContent()) ?? "").trim();
  await saveForm.locator("input.admin-input").fill("Draft-only CTA");
  await saveForm.locator("[data-reuse-save-submit]").click();
  const createdDraft = await until(async () => Boolean(await component("Draft-only CTA")), 20_000);
  const draftOnly = await component("Draft-only CTA");
  const imageRow = await state(ABOUT_IMAGE);
  say("R2. Save as reusable defaults to a draft: nothing published, nothing linked",
    draftChecked && !publishChecked && submitText === "Create CTA draft" && createdDraft &&
      draftOnly?.published_version === 0 && draftOnly?.published === null &&
      reuseOf(imageRow.draft ?? imageRow.published)?.cta === undefined,
    JSON.stringify({ draftChecked, publishChecked, submitText, version: draftOnly?.published_version }));

  /* ====================================================================== */
  /* Isolation 38–40                                                        */
  /* ====================================================================== */

  const pub = await publicHtml("/");
  say("38. the public page carries no reference, no editor marks and no component name",
    !pub.includes("_reuse") && !pub.includes("data-eod-reuse") && !pub.includes("Primary Contact CTA"));
  const rev = (await component("Primary Contact CTA"))!.revision;
  const visitorPreview = await publicHtml(`/?component=${CID}&rev=${rev}`);
  await componentWrite("saveReusableDraft", { values: globalValues("Secret draft", "", "/secret") });
  const rev2 = (await component("Primary Contact CTA"))!.revision;
  const visitor2 = await publicHtml(`/?component=${CID}&rev=${rev2}`);
  say("39. a visitor cannot open the component's preview", !visitor2.includes("Secret draft") && !visitorPreview.includes("unpublished draft"));

  const viewerContext = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
  const [vn, vv] = viewer.cookie.split("=");
  await viewerContext.addCookies([{ name: vn!, value: vv!, domain: "127.0.0.1", path: "/" }]);
  await viewerContext.addInitScript({ content: "window.__name = window.__name || ((fn) => fn);" });
  const viewerPage = await viewerContext.newPage();
  await open("?page=about&lang=en&device=desktop", viewerPage);
  await select(`section:${ABOUT_CTA}/field:primaryCtaLabel`, viewerPage);
  await viewerPage.getByRole("tab", { name: /Content/ }).click();
  const viewerPanel = viewerPage.locator(`aside[aria-label='Inspector'] [data-reuse-slot="primaryCta"]`).first();
  const viewerButtons = await viewerPanel.getByRole("button").allTextContents();
  const form = new FormData();
  form.set("_csrf", viewer.csrfToken);
  form.set("id", String(CID));
  form.set("expectedRevision", String(rev2));
  const denied = (await callAction<{ ok: boolean; reason?: string }>({ ...RC, origin, action: "publishReusable", args: [form], cookie: viewer.cookie })).value!;
  say("40. a viewer sees the link but cannot change it — no override, detach or publish",
    viewerButtons.every((label) => !/Override|Detach/.test(label)) && denied.ok === false && denied.reason === "denied", viewerButtons.join(" | "));
  await viewerContext.close();

  /* ====================================================================== */
  /* Widths and editions                                                    */
  /* ====================================================================== */

  for (const [label, lang] of [["Tablet", "en"], ["Mobile", "en"], ["Mobile", "ar"]] as const) {
    await open(`?page=home&lang=${lang}&device=${label.toLowerCase()}`);
    const cta = await canvasCta(HOME_CTA);
    const frame = await frameNow();
    const width = await frame.evaluate(() => window.innerWidth);
    const mark = await frame.locator(`[data-eod-address="section:${HOME_CTA}/field:primaryCtaLabel"]`).first().getAttribute("data-eod-reuse");
    say(`widths · ${label} (${lang}): the linked CTA draws and is marked on the canvas`, Boolean(cta.text) && mark === "primaryCta", `${width}px “${cta.text}”`);
  }

  /* 19B · deleting a component from its own page returns to the list ------ */
  {
    const form = new FormData();
    form.set("_csrf", owner.csrfToken);
    form.set("kind", "cta");
    form.set("name", "Scratch CTA");
    form.set("publish", "0");
    const made = (await callAction<{ ok: boolean; component?: { id: number } }>({ ...RC, origin, action: "createReusableComponent", args: [form], cookie: owner.cookie })).value!;
    const scratch = made.component?.id ?? 0;
    await page.goto(`${origin}/admin/components/${scratch}`, { waitUntil: "load" });
    await page.evaluate(() => ((window as unknown as { __eodDetail?: boolean }).__eodDetail = true));
    await page.locator("[data-reuse-delete]").click();
    await page.getByRole("alertdialog", { name: "Delete the component" }).getByRole("button", { name: "Delete" }).click();
    await page.waitForURL(/\/admin\/components$/, { timeout: 30_000 });
    const loaded = !(await page.evaluate(() => Boolean((window as unknown as { __eodDetail?: boolean }).__eodDetail)));
    const removed = (await sql`select 1 from reusable_components where id = ${scratch}`).length === 0;
    say("19B · deleting a component from its page returns to the list by loading it, and the list no longer shows it",
      made.ok && loaded && removed && (await page.getByText("Scratch CTA", { exact: true }).count()) === 0,
      `loaded ${loaded}, removed ${removed}`);
  }

  say("no page errors in the editor", errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
