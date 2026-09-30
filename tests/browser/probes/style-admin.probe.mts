/** Batch 6 §80: the normal Admin's view of a style-only draft, in a browser. */

import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";

const PORT = 3728;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("style_admin");
const sql = connect(database);
let server;
try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);

  const [hero] = await sql<{ id: number; published: Record<string, unknown> }[]>`
    select s.id, s.published from page_sections s join pages p on p.id = s.page_id
     where p.slug = 'privacy' and s.block_type = 'page-hero' limit 1`;
  const [text] = await sql<{ id: number }[]>`
    select s.id from page_sections s join pages p on p.id = s.page_id
     where p.slug = 'privacy' and s.block_type = 'rich-text' limit 1`;
  const original = hero!.published;

  const state = async (id: number) =>
    (
      await sql<{ revision: number; styles: Record<string, unknown>; draft_styles: unknown; draft: unknown; is_published: boolean }[]>`
        select revision, styles, draft_styles, draft, is_published from page_sections where id = ${id}`
    )[0]!;

  /** A style draft, written the way the Visual Editor writes one. */
  const styleDraft = async (id: number, nodes: Record<string, unknown>) => {
    await sql`update page_sections
                 set draft_styles = ${sql.json({ v: 1, nodes } as never)}, revision = revision + 1
               where id = ${id}`;
  };

  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  const [name, value] = owner.cookie.split("=");
  await context.addCookies([{ name: name!, value: value!, domain: "127.0.0.1", path: "/" }]);
  const page = await context.newPage();
  page.on("dialog", (dialog) => dialog.accept());

  const open = async (path: string) => {
    await page.goto(`${server!.origin}${path}`, { waitUntil: "load" });
    await page.waitForFunction(
      () => {
        const form = document.querySelector("form");
        return Boolean(form) && Object.keys(form!).some((key) => key.startsWith("__react"));
      },
      undefined,
      { timeout: 20_000 },
    );
  };
  const settle = async (id: number, previous: number) => {
    for (let i = 0; i < 60 && (await state(id)).revision === previous; i += 1) {
      await page.waitForTimeout(200);
    }
    await page.waitForTimeout(700);
    return state(id);
  };

  /* --- a style-only draft is a draft everywhere ---------------------- */
  await styleDraft(hero!.id, { root: { base: { background: "ink-700", radius: "lg" } } });

  await open("/admin/pages/privacy");
  say("Pages & sections shows a draft", (await page.getByText("Style draft").count()) > 0);
  /**
   * Batch 10 replaced "Publish N drafts" with one page-level action, because
   * the old one counted only what it could publish — content and styles — and
   * silently left the layout behind. The count it used to carry now lives in
   * the review beside it, read from the server rather than from the rows on
   * screen.
   *
   * Waited for rather than counted at once: the card is server-rendered, and
   * counting the instant the form hydrates measures the harness.
   */
  const publishAll = page.getByRole("button", { name: "Publish saved changes" });
  await publishAll.waitFor({ timeout: 15_000 }).catch(() => undefined);
  say("…and the page offers to publish it", (await publishAll.count()) > 0);
  say(
    "…naming it as a style draft",
    (await page.getByText("1 style draft").count()) > 0,
  );

  await open(`/admin/pages/section/${hero!.id}`);
  say("the section editor says there is one", (await page.getByText("Unpublished draft").count()) > 0);
  say("…and says which kind", (await page.getByText(/Style draft/).count()) > 0);
  say(
    "…and offers no style controls of its own",
    (await page.locator("[data-style-token]").count()) === 0,
  );

  /* --- publishing it ------------------------------------------------- */
  let before = (await state(hero!.id)).revision;
  await page.getByRole("button", { name: "Publish draft" }).click();
  let after = await settle(hero!.id, before);
  say("Publish draft publishes the styles", after.draft_styles === null);
  say("…and the public page has them", await fetch(`${server.origin}/privacy`)
    .then((r) => r.text())
    .then((html) => /background:var\(--color-ink-700\)/.test(html)));

  /* --- discarding one ------------------------------------------------ */
  await styleDraft(hero!.id, { root: { base: { background: "ink-900" } } });
  await open(`/admin/pages/section/${hero!.id}`);
  before = (await state(hero!.id)).revision;
  await page.getByRole("button", { name: "Discard" }).click();
  after = await settle(hero!.id, before);
  say("Discard removes the style draft", after.draft_styles === null);
  say(
    "…and leaves the published styles alone",
    JSON.stringify(after.styles).includes("ink-700"),
    JSON.stringify(after.styles),
  );

  /* --- publish all, with a style-only draft and a content one -------- */
  await styleDraft(hero!.id, { root: { base: { radius: "xl" } } });
  await sql`update page_sections
               set draft = jsonb_set(coalesce(draft, published), '{title,en}', '"Together"'),
                   revision = revision + 1
             where id = ${text!.id}`;
  await open("/admin/pages/privacy");
  before = (await state(hero!.id)).revision;
  await page.getByRole("button", { name: "Publish saved changes" }).click();
  after = await settle(hero!.id, before);
  say("publishing the page takes a style-only draft with it", after.draft_styles === null);
  say(
    "…and the content draft beside it",
    (await state(text!.id)).draft === null,
  );

  /* --- a hidden section stays hidden --------------------------------- */
  await sql`update page_sections set is_published = false where id = ${text!.id}`;
  await styleDraft(text!.id, { root: { base: { opacity: 0.5 } } });
  await open("/admin/pages/privacy");
  before = (await state(text!.id)).revision;
  await page.getByRole("button", { name: "Publish saved changes" }).click();
  after = await settle(text!.id, before);
  say("a hidden section's styles publish", after.draft_styles === null);
  // With no layout draft the composition is the live one, so visibility is
  // untouched — publishing a *layout* is the only thing that may change it.
  say("…and it is still hidden", after.is_published === false);

  await context.close();

  await sql`update page_sections
               set draft = null, draft_styles = null, styles = '{"v":1,"nodes":{}}'::jsonb,
                   published = ${sql.json(original as never)}, is_published = true
             where id = ${hero!.id}`;
  await sql`update page_sections set draft = null, draft_styles = null,
                   styles = '{"v":1,"nodes":{}}'::jsonb, is_published = true
             where id = ${text!.id}`;
  const restored = await state(hero!.id);
  say("the fixture is back", restored.draft_styles === null && restored.draft === null);
} finally {
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
