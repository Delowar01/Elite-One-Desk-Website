/**
 * Batch 19C: a temporary password, end to end, in a real browser.
 *
 * The scenario the 19C brief lists, step by step, through the screens a
 * person uses — the Users screen, the sign-in form, the password-change page —
 * with the database checked beside every step:
 *
 *   P1   an owner creates an account on a temporary password
 *   P2   that person signs in with it
 *   P3   the panel sends them to the password-change page, wherever they asked to go
 *   P4   the Visual Editor is out of reach
 *   P5   a password the policy refuses, or a confirmation that differs, is refused
 *   P6   their own password is accepted
 *   P7   the session they changed it from no longer works
 *   P8   the temporary password no longer signs in
 *   P9   the new one does, to where they asked to go
 *   P10  the panel is theirs again, by their role
 *
 * No production credentials: the owner is the fixture's, and the person is
 * made up here.
 */
import type { Browser, BrowserContext, Page } from "playwright";

import { giveFresh } from "../../helpers/fixtures";
import { connect, dropDatabase } from "../../helpers/pg";
import { startServer, type Server } from "../../helpers/server";
import { signIn } from "../../helpers/session";
import { launchChromium } from "../harness";

const PORT = 3731;
const EMAIL = "new.person@probe.invalid";
const TEMPORARY = "Temporary-Pass-2026";
const CHOSEN = "My-Own-Choice-2026";
const LANDING_MS = 20_000;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser: Browser = await launchChromium();
const database = giveFresh("password_change_probe");
const sql = connect(database);
let server: Server | undefined;
const contexts: BrowserContext[] = [];
const errors: string[] = [];

/** The account as the database holds it. */
const account = async () =>
  (await sql<{ id: number; must_change_password: boolean; password_hash: string }[]>`
    select id, must_change_password, password_hash from users where email = ${EMAIL}`)[0];
const sessionsOf = async (id: number) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sessions where user_id = ${id}`)[0]!.n;
const path = (page: Page) => new URL(page.url()).pathname;

async function freshPage(cookies: { name: string; value: string }[] = []) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  contexts.push(context);
  if (cookies.length) {
    await context.addCookies(cookies.map((cookie) => ({ ...cookie, domain: "127.0.0.1", path: "/" })));
  }
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message.slice(0, 160)));
  return { context, page };
}

/** The sign-in form, filled and sent as a person does it. */
async function signInWithForm(page: Page, origin: string, password: string, next: string) {
  await page.goto(`${origin}/admin/login?next=${encodeURIComponent(next)}`, { waitUntil: "load" });
  await page.getByLabel("Email address").fill(EMAIL);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

try {
  const owner = await signIn(sql);
  server = await startServer(database, PORT);
  const origin = server.origin;
  const [ownerCookieName, ownerCookieValue] = owner.cookie.split("=");

  // P1 — the owner's Users screen.
  const { page: admin } = await freshPage([{ name: ownerCookieName!, value: ownerCookieValue! }]);
  await admin.goto(`${origin}/admin/users`, { waitUntil: "load" });
  await admin.getByRole("button", { name: "Add person" }).click();
  await admin.locator("#new-name").fill("New Person");
  await admin.locator("#new-email").fill(EMAIL);
  await admin.locator("#new-roleId").selectOption({ label: await admin.locator("#new-roleId option", { hasText: /^Editor/ }).first().innerText() });
  const hint = await admin.getByText("The user will be required to choose a new password at their next sign-in.").count();
  await admin.locator("#new-password").fill(TEMPORARY);
  await admin.getByRole("button", { name: "Create account" }).click();
  const created = await admin
    .getByRole("status")
    .filter({ hasText: "Account created with a temporary password" })
    .waitFor({ timeout: LANDING_MS })
    .then(() => true, () => false);
  const row = await account();
  say(
    "P1. an owner creates an account on a temporary password — the form says so, and the database stores it as one",
    created && hint === 1 && Boolean(row?.must_change_password),
    `confirmation ${created}, hint ${hint}, must_change_password ${row?.must_change_password}`,
  );
  await admin.reload({ waitUntil: "load" });
  const badge = await admin.locator("li", { hasText: EMAIL }).locator("[data-temporary-password]").count();
  say("P1. …and the Users screen marks it as on a temporary password", badge === 1, `badge ${badge}`);

  // P2/P3 — the person signs in, asking for the Visual Editor.
  const { context: person, page } = await freshPage();
  await signInWithForm(page, origin, TEMPORARY, "/admin/visual-editor");
  const landed = await page.waitForURL(/\/admin\/change-password$/, { timeout: LANDING_MS }).then(() => true, () => false);
  const heldCookie = (await person.cookies()).find((cookie) => cookie.name === "eod_session");
  say(
    "P2. the temporary password signs in",
    Boolean(heldCookie) && row !== undefined && (await sessionsOf(row.id)) === 1,
    `cookie ${Boolean(heldCookie)}, sessions ${row ? await sessionsOf(row.id) : "?"}`,
  );
  say(
    "P3. …and lands on the password-change page, not the Visual Editor it asked for",
    landed && (await page.getByRole("heading", { name: "Choose a new password" }).count()) === 1,
    path(page),
  );

  await page.goto(`${origin}/admin`, { waitUntil: "load" });
  const dashboard = path(page);
  const sidebar = await page.getByRole("link", { name: "Visual Editor" }).count();
  say(
    "P3. /admin sends it back there, and the page offers nothing of the panel",
    dashboard === "/admin/change-password" && sidebar === 0,
    `${dashboard}, panel links ${sidebar}`,
  );

  // P4 — the Visual Editor.
  await page.goto(`${origin}/admin/visual-editor`, { waitUntil: "load" });
  const editor = path(page);
  const canvas = await page.locator("iframe").count();
  say("P4. the Visual Editor is out of reach", editor === "/admin/change-password" && canvas === 0, `${editor}, canvas frames ${canvas}`);

  // P5 — refusals, shown on the page and changing nothing.
  const form = page.getByRole("form", { name: "Choose a new password" });
  const attempt = async (current: string, next: string, confirm: string) => {
    await form.getByLabel("Current (temporary) password").fill(current);
    await form.getByLabel("New password", { exact: true }).fill(next);
    await form.getByLabel("Confirm the new password").fill(confirm);
    await form.getByRole("button", { name: "Change password" }).click();
  };
  await attempt(TEMPORARY, "short-1A", "short-1A");
  const weak = await page
    .getByRole("alert")
    .filter({ hasText: "That password is not strong enough." })
    .waitFor({ timeout: LANDING_MS })
    .then(() => true, () => false);
  const ruleShown = await page.getByText("Use at least 12 characters.").count();
  say(
    "P5. a password the policy refuses is refused, on the page, with the rule it breaks",
    weak && ruleShown === 1 && path(page) === "/admin/change-password" && Boolean((await account())?.must_change_password),
    `alert ${weak}, rule ${ruleShown}, ${path(page)}`,
  );
  await attempt(TEMPORARY, CHOSEN, "My-Own-Choice-2027");
  const mismatch = await page
    .getByRole("alert")
    .filter({ hasText: "The two new passwords do not match." })
    .waitFor({ timeout: LANDING_MS })
    .then(() => true, () => false);
  const unchanged = await account();
  say(
    "P5. a confirmation that differs is refused, and the account is as it was",
    mismatch && Boolean(unchanged?.must_change_password) && unchanged?.password_hash === row?.password_hash,
    `alert ${mismatch}`,
  );

  // P6 — their own password.
  await attempt(TEMPORARY, CHOSEN, CHOSEN);
  const signedOut = await page.waitForURL(/\/admin\/login\?changed=1$/, { timeout: LANDING_MS }).then(() => true, () => false);
  const notice = await page.locator("[data-password-changed]").count();
  const changed = await account();
  say(
    "P6. a password of their own is accepted: the flag is cleared and the browser is sent to sign in",
    signedOut && notice === 1 && changed?.must_change_password === false && changed.password_hash !== row?.password_hash,
    `${path(page)}, notice ${notice}, must_change_password ${changed?.must_change_password}`,
  );

  // P7 — the session it was changed from.
  const left = (await person.cookies()).find((cookie) => cookie.name === "eod_session");
  const sessions = row ? await sessionsOf(row.id) : -1;
  const { page: replay } = await freshPage(heldCookie ? [{ name: heldCookie.name, value: heldCookie.value }] : []);
  await replay.goto(`${origin}/admin`, { waitUntil: "load" });
  say(
    "P7. the session it was changed from no longer works — the browser dropped it, the database ended it, and replaying it reaches the sign-in form",
    !left && sessions === 0 && path(replay) === "/admin/login",
    `cookie left ${Boolean(left)}, sessions ${sessions}, replay → ${path(replay)}`,
  );

  // P8 — the temporary password.
  await signInWithForm(page, origin, TEMPORARY, "/admin/visual-editor");
  const refused = await page
    .getByRole("alert")
    .filter({ hasText: "That email address and password do not match an active account." })
    .waitFor({ timeout: LANDING_MS })
    .then(() => true, () => false);
  say(
    "P8. the temporary password no longer signs in",
    refused && path(page) === "/admin/login" && (row ? await sessionsOf(row.id) : -1) === 0,
    path(page),
  );

  // P9 — the new one.
  await signInWithForm(page, origin, CHOSEN, "/admin/visual-editor");
  const arrived = await page.waitForURL(/\/admin\/visual-editor$/, { timeout: LANDING_MS }).then(() => true, () => false);
  say("P9. the new password signs in, to the Visual Editor it asked for", arrived, path(page));

  // P10 — the panel, by role.
  await page.goto(`${origin}/admin`, { waitUntil: "load" });
  const home = path(page);
  const signedInAs = await page.getByText(`Signed in as ${EMAIL}`).count();
  const editorLink = await page.getByRole("link", { name: "Visual Editor" }).count();
  await page.goto(`${origin}/admin/change-password`, { waitUntil: "load" });
  const nothingToChange = path(page);
  say(
    "P10. the panel is theirs again — the dashboard, the sidebar their role allows, and no password change left to make",
    home === "/admin" && signedInAs === 1 && editorLink > 0 && nothingToChange === "/admin",
    `${home}, signed in as ${signedInAs}, editor links ${editorLink}, change page → ${nothingToChange}`,
  );

  const [logged] = await sql<{ n: number }[]>`
    select count(*)::int as n from activity_logs where action = 'user.password_changed' and user_id = ${row?.id ?? 0}`;
  say("P10. one activity entry records the change, and no page raised an error", logged!.n === 1 && errors.length === 0, errors.slice(0, 3).join(" | "));
} finally {
  for (const context of contexts) await context.close().catch(() => undefined);
  await server?.stop();
  await browser.close();
  await sql.end({ timeout: 5 });
  dropDatabase(database);
}
