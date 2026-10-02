/**
 * Batch 19C: an account on a temporary password chooses its own before it can
 * do anything else — and the server decides that, not the browser.
 *
 * `users.must_change_password` was set on every new account and every
 * password an admin reset since `38f3495`, and nothing ever read it: whoever
 * set a temporary password kept knowing a working password for that account.
 * It is now enforced where the session is resolved. `getSession()` returns
 * nothing for such an account, so every page guard, every Server Action, the
 * editor's loaders, the export route and the draft preview refuse it exactly
 * as they refuse a stranger — and the guards send it to
 * `/admin/change-password`, the one admin page it may open. There it may do
 * two things: change its password, or sign out.
 *
 * Every test here drives the running build through the requests a browser
 * sends — the real sign-in action, the real cookie it sets, the real page
 * HTML and its token — and asserts what the database holds afterwards. The
 * numbered tests are the 22 the 19C brief lists; the rest close the cases
 * around them (sign-out, a flag set before this release, the read-only
 * pre-deployment check, the current-password throttle, what the change page
 * offers, and what a stranger can learn).
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { callAction } from "./helpers/action";
import { REPO_ROOT } from "./helpers/env";
import { giveFresh } from "./helpers/fixtures";
import { get } from "./helpers/http";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { runScript } from "./helpers/run";
import { BUILD_HINT, isBuilt, startServer, type Server } from "./helpers/server";
import { SESSION_COOKIE, signIn, type TestSession } from "./helpers/session";

import type { ActionState } from "@/lib/admin/actions";
import { hashPassword, verifyPassword } from "@/lib/auth/password";

const PORT = 3504;

const LOGIN = "app/(backoffice)/admin/login/actions.ts";
const CHANGE = "app/(backoffice)/admin/change-password/actions.ts";
const USERS = "app/(backoffice)/admin/(shell)/users/actions.ts";
const FAQS = "app/(backoffice)/admin/(shell)/faqs/actions.ts";
const COMPONENTS = "app/(backoffice)/admin/(shell)/components/actions.ts";
const VE = "app/(backoffice)/admin/visual-editor/actions.ts";

const CHANGE_PATH = "/admin/change-password";
/** `MUST_CHANGE_PASSWORD_MESSAGE` in `lib/auth/guard.ts` (a server-only module). */
const MUST_CHANGE = "Choose a new password before you do anything else. Nothing was changed.";

const TEMPORARY = "Temporary-Pass-2026";
const CHOSEN = "My-Own-Choice-2026";

let database = "";
let sql: Sql;
let server: Server;
let owner: TestSession;

/* -------------------------------------------------------------------------- */
/* The browser's requests                                                     */
/* -------------------------------------------------------------------------- */

const formOf = (fields: Record<string, string | number>) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
  return form;
};

/** The redirect a Server Action answered with, as Next tells the client router. */
const redirectOf = (headers: Headers) => headers.get("x-action-redirect")?.split(";")[0] ?? null;

/** The session cookie a response set, if it set a live one. */
function sessionCookieOf(headers: Headers): string | null {
  for (const raw of headers.getSetCookie()) {
    const pair = raw.split(";")[0]!;
    if (pair.startsWith(`${SESSION_COOKIE}=`) && pair.length > SESSION_COOKIE.length + 1) return pair;
  }
  return null;
}

/** Whether a response told the browser to drop the session cookie. */
const clearsSessionCookie = (headers: Headers) =>
  headers
    .getSetCookie()
    .some((raw) => raw.startsWith(`${SESSION_COOKIE}=;`) && /Expires=Thu, 01 Jan 1970|Max-Age=0/i.test(raw));

/** The real sign-in form, posted the way the browser posts it. */
async function login(email: string, password: string, next = "/admin") {
  const response = await callAction<ActionState>({
    origin: server.origin,
    route: "/admin/login",
    file: LOGIN,
    action: "signIn",
    args: [{ ok: false }, formOf({ email, password, next })],
  });
  return {
    status: response.status,
    refused: response.value,
    cookie: sessionCookieOf(response.headers),
    redirect: redirectOf(response.headers),
  };
}

/** The token the change page hands this session — read off the page, as the browser reads it. */
async function changePageToken(cookie: string): Promise<string> {
  const page = await get(server.origin, CHANGE_PATH, { cookie });
  assert.equal(page.status, 200, `the change page answered ${page.status} → ${page.location}`);
  const token = /name="_csrf" value="([^"]+)"/.exec(page.html)?.[1];
  assert.ok(token, "the change page carries the session's token");
  return token;
}

async function change(cookie: string | null, fields: Record<string, string | number>) {
  const response = await callAction<ActionState>({
    origin: server.origin,
    route: CHANGE_PATH,
    file: CHANGE,
    action: "changeOwnPassword",
    args: [{ ok: false }, formOf(fields)],
    cookie: cookie ?? undefined,
  });
  return { value: response.value, redirect: redirectOf(response.headers), headers: response.headers };
}

/** The owner's Users screen, through the real action. */
async function createAccount(email: string, role: string, password = TEMPORARY) {
  const [row] = await sql<{ id: number }[]>`select id from roles where key = ${role}`;
  const response = await callAction<ActionState>({
    origin: server.origin,
    route: "/admin/users",
    file: USERS,
    action: "createUser",
    args: [{ ok: false }, formOf({ _csrf: owner.csrfToken, email, name: `Person ${email}`, password, roleId: row!.id })],
    cookie: owner.cookie,
  });
  assert.equal(response.value?.ok, true, `createUser: ${response.value?.message}`);
  return { message: response.value!.message ?? "", ...(await account(email)) };
}

async function account(email: string) {
  const [row] = await sql<
    { id: number; password_hash: string; must_change_password: boolean; is_active: boolean; updated_at: Date }[]
  >`select id, password_hash, must_change_password, is_active, updated_at from users where lower(email) = ${email}`;
  assert.ok(row, `no account ${email}`);
  return row;
}

const sessionsOf = async (userId: number) =>
  (await sql<{ n: number }[]>`select count(*)::int as n from sessions where user_id = ${userId}`)[0]!.n;

/** An account as it stands in the database, with its own password — no screen involved. */
async function plantAccount(email: string, role: string, password: string, flagged: boolean) {
  await sql`
    insert into users (email, name, password_hash, role_id, is_active, must_change_password)
    select ${email}, ${`Planted ${email}`}, ${await hashPassword(password)}, id, true, ${flagged}
      from roles where key = ${role}`;
  return account(email);
}

/** A flagged account, signed in with its temporary password: its cookie and its token. */
async function signedInOnTemporary(email: string, role = "owner") {
  await createAccount(email, role);
  const signed = await login(email, TEMPORARY);
  assert.ok(signed.cookie, `signing ${email} in set no session cookie`);
  return { cookie: signed.cookie, csrf: await changePageToken(signed.cookie), ...(await account(email)) };
}

/* -------------------------------------------------------------------------- */

before(async () => {
  if (!isBuilt()) throw new Error(BUILD_HINT);
  database = giveFresh("password_change");
  sql = connect(database);
  server = await startServer(database, PORT);
  owner = await signIn(sql);
});

after(async () => {
  await server?.stop();
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
});

describe("19C · a password somebody else set is temporary", () => {
  test("19C · 1. a new account is created on a temporary password", async () => {
    const created = await createAccount("new-1@test.invalid", "editor");
    assert.equal(created.must_change_password, true, "users.must_change_password on the new row");
    assert.match(created.message, /temporary password/);
    assert.match(created.message, /required to choose a new password at their next sign-in/);
    assert.ok(await verifyPassword(TEMPORARY, created.password_hash), "the temporary password is what was stored");
  });

  test("19C · 2. a password an admin resets for somebody else is temporary and ends their sessions; a self-reset is not, and is recorded as one", async () => {
    // Somebody who already chose their own password, signed in twice.
    const person = await plantAccount("reset-2@test.invalid", "editor", CHOSEN, false);
    assert.ok((await login("reset-2@test.invalid", CHOSEN)).cookie);
    assert.ok((await login("reset-2@test.invalid", CHOSEN)).cookie);
    assert.equal(await sessionsOf(person.id), 2);

    const reset = await callAction<ActionState>({
      origin: server.origin,
      route: "/admin/users",
      file: USERS,
      action: "resetUserPassword",
      args: [{ ok: false }, formOf({ _csrf: owner.csrfToken, id: person.id, password: TEMPORARY })],
      cookie: owner.cookie,
    });
    assert.equal(reset.value?.ok, true, reset.value?.message);
    assert.match(reset.value!.message!, /Temporary password set/);
    assert.match(reset.value!.message!, /required to choose a new password at their next sign-in/);
    const after = await account("reset-2@test.invalid");
    assert.equal(after.must_change_password, true, "the reset password is temporary");
    assert.ok(await verifyPassword(TEMPORARY, after.password_hash));
    assert.equal(await sessionsOf(person.id), 0, "every session of theirs ended");
    const [logged] = await sql<{ action: string; metadata: Record<string, unknown> }[]>`
      select action, metadata from activity_logs where entity_type = 'user' and entity_id = ${String(person.id)}
       order by id desc limit 1`;
    assert.equal(logged?.action, "user.password_reset");
    assert.deepEqual(logged?.metadata, { self: false, temporary: true });

    // An owner changing their own password from the same screen: theirs, chosen, not temporary.
    const self = await plantAccount("self-2@test.invalid", "owner", CHOSEN, false);
    const signed = await login("self-2@test.invalid", CHOSEN);
    const [own] = await sql<{ csrf_token: string }[]>`
      select csrf_token from sessions where id = ${signed.cookie!.split("=")[1]!.split(".")[0]!}`;
    const selfReset = await callAction<ActionState>({
      origin: server.origin,
      route: "/admin/users",
      file: USERS,
      action: "resetUserPassword",
      args: [{ ok: false }, formOf({ _csrf: own!.csrf_token, id: self.id, password: "Self-Chosen-Pass-26" })],
      cookie: signed.cookie!,
    });
    assert.equal(selfReset.value?.ok, true, selfReset.value?.message);
    const selfAfter = await account("self-2@test.invalid");
    assert.equal(selfAfter.must_change_password, false, "a password you set for yourself is yours");
    assert.equal(await sessionsOf(self.id), 0, "and every session of yours ends, this one included");
    const [selfLogged] = await sql<{ action: string; summary: string; metadata: Record<string, unknown> }[]>`
      select action, summary, metadata from activity_logs where entity_type = 'user' and entity_id = ${String(self.id)}
       order by id desc limit 1`;
    assert.equal(selfLogged?.action, "user.password_self_reset");
    assert.deepEqual(selfLogged?.metadata, { self: true, temporary: false });
    assert.match(selfLogged!.summary, /their own password/);
  });
});

describe("19C · signing in on a temporary password", () => {
  test("19C · 3. the temporary password authenticates", async () => {
    const created = await createAccount("temp-3@test.invalid", "editor");
    const signed = await login("temp-3@test.invalid", TEMPORARY);
    assert.equal(signed.refused, null, `refused: ${signed.refused?.message}`);
    assert.ok(signed.cookie, "a session cookie was set");
    assert.equal(await sessionsOf(created.id), 1, "and a session row exists for the account");
    const [attempt] = await sql<{ successful: boolean }[]>`
      select successful from login_attempts where identifier = 'temp-3@test.invalid' order by id desc limit 1`;
    assert.equal(attempt?.successful, true);
  });

  test("19C · 4. …and it is sent to the password-change page, whatever destination it asked for", async () => {
    await createAccount("temp-4@test.invalid", "owner");
    for (const next of ["/admin", "/admin/visual-editor", "/admin/users", "/admin/pages?x=1"]) {
      const signed = await login("temp-4@test.invalid", TEMPORARY, next);
      assert.equal(signed.redirect, CHANGE_PATH, `next=${next} went to ${signed.redirect}`);
    }
    // And the sign-in page itself sends a signed-in temporary session there.
    const signed = await login("temp-4@test.invalid", TEMPORARY, "/admin/visual-editor");
    const page = await get(server.origin, "/admin/login?next=/admin/visual-editor", { cookie: signed.cookie! });
    assert.equal(page.location, CHANGE_PATH);
  });

  test("19C · 5. /admin cannot be reached around it", async () => {
    const forced = await signedInOnTemporary("temp-5@test.invalid");
    const page = await get(server.origin, "/admin", { cookie: forced.cookie });
    assert.equal(page.status, 307);
    assert.equal(page.location, CHANGE_PATH);
    assert.doesNotMatch(page.html, /Signed in as/);
  });

  test("19C · 6. the Visual Editor and Version Compare cannot be reached around it", async () => {
    const forced = await signedInOnTemporary("temp-6@test.invalid");
    for (const path of ["/admin/visual-editor", "/admin/visual-editor?page=home&device=desktop", "/admin/compare?page=home"]) {
      const page = await get(server.origin, path, { cookie: forced.cookie });
      assert.equal(page.status, 307, `${path}: ${page.status}`);
      assert.equal(page.location, CHANGE_PATH, `${path} → ${page.location}`);
    }
  });

  test("19C · 7. no other admin route, the export or a draft preview can be reached around it", async () => {
    const forced = await signedInOnTemporary("temp-7@test.invalid");
    const routes = [
      "/admin/users",
      "/admin/pages",
      "/admin/pages/home",
      "/admin/components",
      "/admin/settings",
      "/admin/navigation",
      "/admin/media",
      "/admin/enquiries",
      "/admin/activity",
      "/admin/seo",
      "/admin/services",
      "/admin/faqs",
    ];
    for (const route of routes) {
      const page = await get(server.origin, route, { cookie: forced.cookie });
      assert.equal(page.location, CHANGE_PATH, `${route} answered ${page.status} → ${page.location}`);
    }
    const exported = await get(server.origin, "/api/admin/enquiries/export", { cookie: forced.cookie });
    assert.equal(exported.status, 404, "the enquiry export");

    // A draft only a session with content.view may see — this account's role holds it.
    const [about] = await sql<{ id: number }[]>`select id from pages where slug = 'about'`;
    const [first] = await sql<{ id: number }[]>`
      select id from page_sections where page_id = ${about!.id} and not is_draft_only order by position, id limit 1`;
    const marker = "A draft a temporary password must not see (19C)";
    await sql`update page_sections
                 set draft = jsonb_set(coalesce(draft, published), '{title,en}', to_jsonb(${marker}::text)),
                     revision = revision + 1
               where id = ${first!.id}`;
    const preview = await get(server.origin, "/about?preview=1", { cookie: forced.cookie });
    assert.ok(!preview.html.includes(marker), "the preview showed the draft");
    assert.ok(!/Preview — showing/.test(preview.html), "the page called itself a preview");
    assert.ok((await get(server.origin, "/about?preview=1", { cookie: owner.cookie })).html.includes(marker), "an ordinary owner sees it");
  });

  test("19C · 8. no Server Action can be called around it — not even with the session's own token", async () => {
    const forced = await signedInOnTemporary("temp-8@test.invalid");
    const call = (route: string, file: string, action: string, args: unknown[]) =>
      callAction<Record<string, unknown> | null>({ origin: server.origin, route, file, action, args, cookie: forced.cookie });

    const users = (await sql<{ n: number }[]>`select count(*)::int as n from users`)[0]!.n;
    const createdUser = await call("/admin/users", USERS, "createUser", [
      { ok: false },
      formOf({ _csrf: forced.csrf, email: "smuggled@test.invalid", name: "Smuggled", password: CHOSEN, roleId: 1 }),
    ]);
    assert.equal(createdUser.value?.ok, false);
    assert.equal(createdUser.value?.message, MUST_CHANGE);
    assert.equal((await sql<{ n: number }[]>`select count(*)::int as n from users`)[0]!.n, users, "no account was created");

    const faqs = (await sql<{ n: number }[]>`select count(*)::int as n from faqs`)[0]!.n;
    const faq = await call("/admin/faqs", FAQS, "saveFaq", [{ ok: false }, formOf({ _csrf: forced.csrf, questionEn: "Smuggled?", scope: "global" })]);
    assert.equal(faq.value?.ok, false);
    assert.equal(faq.value?.message, MUST_CHANGE);
    assert.equal((await sql<{ n: number }[]>`select count(*)::int as n from faqs`)[0]!.n, faqs, "no question was saved");

    const components = (await sql<{ n: number }[]>`select count(*)::int as n from reusable_components`)[0]!.n;
    const component = await call("/admin/components", COMPONENTS, "createReusableComponent", [
      formOf({ _csrf: forced.csrf, kind: "cta", name: "Smuggled CTA", publish: "0" }),
    ]);
    assert.equal(component.value?.ok, false);
    assert.equal(
      (await sql<{ n: number }[]>`select count(*)::int as n from reusable_components`)[0]!.n,
      components,
      "no component was created",
    );

    const [section] = await sql<{ id: number; page_id: number; revision: number; draft: unknown }[]>`
      select id, page_id, revision, draft from page_sections where not is_draft_only order by id limit 1`;
    const saved = await call("/admin/visual-editor", VE, "saveVisualSectionDraft", [
      formOf({ _csrf: forced.csrf, sectionId: section!.id, pageId: section!.page_id, expectedRevision: section!.revision, values: "{}" }),
    ]);
    assert.equal(saved.value?.ok, false);
    const [unchanged] = await sql<{ revision: number; draft: unknown }[]>`select revision, draft from page_sections where id = ${section!.id}`;
    assert.equal(unchanged!.revision, section!.revision, "the section was not written");
    assert.deepEqual(unchanged!.draft, section!.draft);

    // The editor's loaders read drafts; they answer it with nothing.
    assert.equal((await call("/admin/visual-editor", VE, "loadPageSummary", [section!.page_id])).value, null);
    assert.equal((await call("/admin/components", COMPONENTS, "loadReusableCatalog", [])).value, null);

    // The same account, once it has chosen its password and signed in with it,
    // makes the same request and it goes through: it was the flag that refused it.
    await change(forced.cookie, { _csrf: forced.csrf, currentPassword: TEMPORARY, password: CHOSEN, confirmPassword: CHOSEN });
    const again = await login("temp-8@test.invalid", CHOSEN);
    const [token] = await sql<{ csrf_token: string }[]>`
      select csrf_token from sessions where id = ${again.cookie!.split("=")[1]!.split(".")[0]!}`;
    const allowed = await callAction<Record<string, unknown>>({
      origin: server.origin,
      route: "/admin/faqs",
      file: FAQS,
      action: "saveFaq",
      args: [{ ok: false }, formOf({ _csrf: token!.csrf_token, questionEn: "Asked after the change?", scope: "global" })],
      cookie: again.cookie!,
    });
    assert.equal(allowed.value?.ok, true, String(allowed.value?.message));
  });
});

describe("19C · choosing a new password", () => {
  test("19C · 9. it needs a signed-in session on a temporary password", async () => {
    const forced = await signedInOnTemporary("temp-9@test.invalid");
    const fields = { _csrf: forced.csrf, currentPassword: TEMPORARY, password: CHOSEN, confirmPassword: CHOSEN };

    const anonymous = await change(null, fields);
    assert.equal(anonymous.value?.ok, false);
    assert.match(anonymous.value!.message!, /session has expired/);

    // An ordinary session has no password change waiting, and gets none.
    const ordinary = await change(owner.cookie, { ...fields, _csrf: owner.csrfToken });
    assert.equal(ordinary.value?.ok, false);
    assert.match(ordinary.value!.message!, /no password change waiting/);

    const unchanged = await account("temp-9@test.invalid");
    assert.equal(unchanged.must_change_password, true);
    assert.equal(unchanged.password_hash, forced.password_hash);
    const [ownerRow] = await sql<{ password_hash: string }[]>`select password_hash from users where id = ${owner.userId}`;
    assert.ok(!(await verifyPassword(CHOSEN, ownerRow!.password_hash)), "the owner's password was not touched");
  });

  test("19C · 10. it needs the session's own token", async () => {
    const forced = await signedInOnTemporary("temp-10@test.invalid");
    const other = await signedInOnTemporary("temp-10b@test.invalid");
    const fields = { currentPassword: TEMPORARY, password: CHOSEN, confirmPassword: CHOSEN };
    for (const token of [undefined, "", "not-the-token", other.csrf]) {
      const refused = await change(forced.cookie, token === undefined ? fields : { ...fields, _csrf: token });
      assert.equal(refused.value?.ok, false, `token ${String(token)}`);
      assert.match(refused.value!.message!, /form expired/);
    }
    const unchanged = await account("temp-10@test.invalid");
    assert.equal(unchanged.must_change_password, true);
    assert.equal(unchanged.password_hash, forced.password_hash);
    // With its own token, the same request succeeds.
    const done = await change(forced.cookie, { ...fields, _csrf: forced.csrf });
    assert.equal(done.redirect, "/admin/login?changed=1");
  });

  test("19C · 11. a password the policy refuses is refused", async () => {
    const forced = await signedInOnTemporary("temp-11@test.invalid");
    for (const weak of ["Short-1a", "all-lower-case-2026", "ALL-UPPER-CASE-2026", "No-Digits-Here-At-All"]) {
      const refused = await change(forced.cookie, { _csrf: forced.csrf, currentPassword: TEMPORARY, password: weak, confirmPassword: weak });
      assert.equal(refused.value?.ok, false, weak);
      assert.equal(refused.value?.message, "That password is not strong enough.");
      assert.ok(refused.value?.errors?.password, `${weak} names the rule it breaks`);
    }
    const unchanged = await account("temp-11@test.invalid");
    assert.equal(unchanged.must_change_password, true);
    assert.equal(unchanged.password_hash, forced.password_hash);
    assert.equal(await sessionsOf(forced.id), 1, "a refusal ends nothing");
  });

  test("19C · 12. a confirmation that does not match is refused", async () => {
    const forced = await signedInOnTemporary("temp-12@test.invalid");
    for (const confirmPassword of ["", "My-Own-Choice-2027", `${CHOSEN} `]) {
      const refused = await change(forced.cookie, { _csrf: forced.csrf, currentPassword: TEMPORARY, password: CHOSEN, confirmPassword });
      assert.equal(refused.value?.ok, false);
      assert.equal(refused.value?.message, "The two new passwords do not match.");
    }
    const unchanged = await account("temp-12@test.invalid");
    assert.equal(unchanged.must_change_password, true);
    assert.equal(unchanged.password_hash, forced.password_hash);
  });

  test("19C · 13. the temporary password again is refused", async () => {
    const forced = await signedInOnTemporary("temp-13@test.invalid");
    const refused = await change(forced.cookie, { _csrf: forced.csrf, currentPassword: TEMPORARY, password: TEMPORARY, confirmPassword: TEMPORARY });
    assert.equal(refused.value?.ok, false);
    assert.equal(refused.value?.message, "Choose a password different from your temporary one.");
    const unchanged = await account("temp-13@test.invalid");
    assert.equal(unchanged.must_change_password, true);
    assert.equal(unchanged.password_hash, forced.password_hash);
  });

  test("19C · 14. success stores a new scrypt hash, clears the flag and moves updated_at — for the caller's own account only", async () => {
    const forced = await signedInOnTemporary("temp-14@test.invalid");
    const [ownerBefore] = await sql<{ password_hash: string }[]>`select password_hash from users where id = ${owner.userId}`;
    await sql`update users set updated_at = now() - interval '1 hour' where id = ${forced.id}`;
    const before = await account("temp-14@test.invalid");

    // An id naming somebody else is not read: there is no field for it.
    const done = await change(forced.cookie, {
      _csrf: forced.csrf,
      id: owner.userId,
      userId: owner.userId,
      currentPassword: TEMPORARY,
      password: CHOSEN,
      confirmPassword: CHOSEN,
    });
    assert.equal(done.value, null, `refused: ${done.value?.message}`);
    assert.equal(done.redirect, "/admin/login?changed=1");

    const changed = await account("temp-14@test.invalid");
    assert.equal(changed.must_change_password, false, "the flag is cleared");
    assert.notEqual(changed.password_hash, before.password_hash);
    assert.match(changed.password_hash, /^scrypt\$32768\$8\$1\$/, "hashed the way every password is");
    assert.ok(await verifyPassword(CHOSEN, changed.password_hash));
    assert.ok(changed.updated_at.getTime() > before.updated_at.getTime(), "updated_at moved");
    const [ownerAfter] = await sql<{ password_hash: string }[]>`select password_hash from users where id = ${owner.userId}`;
    assert.equal(ownerAfter!.password_hash, ownerBefore!.password_hash, "nobody else's password changed");
  });

  test("19C · 15. success ends every session of the account, this one included, and sends the browser to sign in", async () => {
    const forced = await signedInOnTemporary("temp-15@test.invalid");
    const second = await login("temp-15@test.invalid", TEMPORARY);
    assert.ok(second.cookie);
    assert.equal(await sessionsOf(forced.id), 2);

    const done = await change(forced.cookie, { _csrf: forced.csrf, currentPassword: TEMPORARY, password: CHOSEN, confirmPassword: CHOSEN });
    assert.equal(done.redirect, "/admin/login?changed=1");
    assert.ok(clearsSessionCookie(done.headers), "the response drops the session cookie");
    assert.equal(await sessionsOf(forced.id), 0, "no session of the account survives");

    for (const cookie of [forced.cookie, second.cookie!]) {
      for (const route of ["/admin", CHANGE_PATH]) {
        const page = await get(server.origin, route, { cookie });
        assert.match(page.location ?? "", /^\/admin\/login/, `${route} with an old cookie → ${page.location}`);
      }
    }
    const notice = await get(server.origin, "/admin/login?changed=1");
    assert.match(notice.html, /Password changed\./);
  });

  test("19C · 16. the temporary password no longer signs in", async () => {
    const forced = await signedInOnTemporary("temp-16@test.invalid");
    await change(forced.cookie, { _csrf: forced.csrf, currentPassword: TEMPORARY, password: CHOSEN, confirmPassword: CHOSEN });
    const old = await login("temp-16@test.invalid", TEMPORARY);
    assert.equal(old.cookie, null, "no session for the old password");
    assert.equal(old.refused?.ok, false);
    assert.equal(old.refused?.message, "That email address and password do not match an active account.");
    assert.equal(await sessionsOf(forced.id), 0);
  });

  test("19C · 17. the new password signs in, to the destination asked for, and the role applies again", async () => {
    const forced = await signedInOnTemporary("temp-17@test.invalid");
    await change(forced.cookie, { _csrf: forced.csrf, currentPassword: TEMPORARY, password: CHOSEN, confirmPassword: CHOSEN });
    const signed = await login("temp-17@test.invalid", CHOSEN, "/admin/visual-editor");
    assert.equal(signed.redirect, "/admin/visual-editor");
    for (const route of ["/admin", "/admin/visual-editor", "/admin/users"]) {
      const page = await get(server.origin, route, { cookie: signed.cookie! });
      assert.equal(page.status, 200, `${route}: ${page.status} → ${page.location}`);
    }
    const page = await get(server.origin, CHANGE_PATH, { cookie: signed.cookie! });
    assert.equal(page.location, "/admin", "nothing to change any more");
  });

  test("19C · 18. an ordinary account is not affected", async () => {
    await plantAccount("ordinary-18@test.invalid", "editor", CHOSEN, false);
    const signed = await login("ordinary-18@test.invalid", CHOSEN, "/admin/pages");
    assert.equal(signed.redirect, "/admin/pages");
    for (const route of ["/admin", "/admin/pages"]) {
      const page = await get(server.origin, route, { cookie: signed.cookie! });
      assert.equal(page.status, 200, `${route}: ${page.status} → ${page.location}`);
    }
    assert.equal((await get(server.origin, CHANGE_PATH, { cookie: signed.cookie! })).location, "/admin");
    assert.equal((await account("ordinary-18@test.invalid")).must_change_password, false);
  });

  test("19C · 19. an inactive account cannot sign in, on a temporary password or not — and its open session stops working", async () => {
    const forced = await signedInOnTemporary("inactive-19@test.invalid", "editor");
    await sql`update users set is_active = false where id = ${forced.id}`;
    const page = await get(server.origin, CHANGE_PATH, { cookie: forced.cookie });
    assert.equal(page.location, "/admin/login", "the open session of a deactivated account is nobody's");

    const refused = await login("inactive-19@test.invalid", TEMPORARY);
    assert.equal(refused.cookie, null);
    assert.equal(refused.refused?.message, "That email address and password do not match an active account.");
    const before = await sessionsOf(forced.id);

    await plantAccount("inactive-19b@test.invalid", "editor", CHOSEN, false);
    await sql`update users set is_active = false where email = 'inactive-19b@test.invalid'`;
    const plain = await login("inactive-19b@test.invalid", CHOSEN);
    assert.equal(plain.cookie, null);
    assert.equal(plain.refused?.message, "That email address and password do not match an active account.");
    assert.equal(await sessionsOf(forced.id), before, "no session was created");
  });

  test("19C · 20. sign-in throttling still applies — to a temporary password as to any other", async () => {
    const email = "throttle-20@test.invalid";
    await createAccount(email, "editor");
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      const wrong = await login(email, `Wrong-Password-${attempt}x`);
      assert.equal(wrong.cookie, null);
    }
    const blocked = await login(email, TEMPORARY);
    assert.equal(blocked.cookie, null, "the right password is refused once the limit is reached");
    assert.match(blocked.refused?.message ?? "", /Too many failed attempts/);
    assert.equal(await sessionsOf((await account(email)).id), 0);
  });

  test("19C · 21. the return address is still checked, and a temporary password ignores it altogether", async () => {
    const cases: [string, string][] = [
      ["/admin/pages", "/admin/pages"],
      ["//evil.example/admin", "/admin"],
      ["https://evil.example/admin", "/admin"],
      ["/about", "/admin"],
      ["javascript:alert(1)", "/admin"],
      ["", "/admin"],
    ];
    await plantAccount("next-21@test.invalid", "owner", CHOSEN, false);
    for (const [next, landing] of cases) {
      assert.equal((await login("next-21@test.invalid", CHOSEN, next)).redirect, landing, `next=${JSON.stringify(next)}`);
    }
    // The sign-in page writes only a panel address into the form.
    for (const next of ["//evil.example/admin", "https://evil.example/admin"]) {
      const page = await get(server.origin, `/admin/login?next=${encodeURIComponent(next)}`);
      assert.match(page.html, /name="next" value="\/admin"/, `the page kept ${next}`);
    }
    await createAccount("next-21b@test.invalid", "owner");
    for (const [next] of cases) {
      assert.equal((await login("next-21b@test.invalid", TEMPORARY, next)).redirect, CHANGE_PATH, `next=${JSON.stringify(next)}`);
    }
  });

  test("19C · 22. the activity log records the sign-in on a temporary password and the change — and never a password", async () => {
    const forced = await signedInOnTemporary("logged-22@test.invalid");
    await change(forced.cookie, { _csrf: forced.csrf, currentPassword: TEMPORARY, password: CHOSEN, confirmPassword: CHOSEN });
    const rows = await sql<{ action: string; user_id: number | null; entity_id: string; summary: string; metadata: unknown }[]>`
      select action, user_id, entity_id, summary, metadata from activity_logs
       where entity_type = 'user' and entity_id = ${String(forced.id)} order by id`;
    const actions = rows.map((row) => row.action);
    assert.deepEqual(actions, ["user.created", "login", "user.password_changed"], actions.join(", "));
    const [, signedIn, changed] = rows;
    assert.equal(signedIn!.summary, "Signed in with a temporary password");
    assert.equal(changed!.user_id, forced.id, "recorded as the account's own act");
    assert.match(changed!.summary, /temporary password/);
    assert.equal(changed!.metadata, null);
    const leaked = await sql<{ n: number }[]>`
      select count(*)::int as n from activity_logs
       where summary like ${`%${TEMPORARY}%`} or summary like ${`%${CHOSEN}%`}
          or coalesce(metadata::text, '') like ${`%${TEMPORARY}%`} or coalesce(metadata::text, '') like ${`%${CHOSEN}%`}`;
    assert.equal(leaked[0]!.n, 0, "no password in any activity entry");
  });
});

describe("19C · around the rule", () => {
  test("19C · sign-out is never refused, and is recorded", async () => {
    const forced = await signedInOnTemporary("signout@test.invalid");
    const response = await callAction<null>({
      origin: server.origin,
      route: CHANGE_PATH,
      file: LOGIN,
      action: "signOut",
      args: [],
      cookie: forced.cookie,
    });
    assert.equal(redirectOf(response.headers), "/admin/login");
    assert.ok(clearsSessionCookie(response.headers));
    assert.equal(await sessionsOf(forced.id), 0);
    const [logged] = await sql<{ action: string }[]>`
      select action from activity_logs where user_id = ${forced.id} order by id desc limit 1`;
    assert.equal(logged?.action, "logout");
    assert.equal((await account("signout@test.invalid")).must_change_password, true, "signing out changes nothing else");
  });

  test("19C · a flag set before this release is honoured on the very next request, mid-session — and nothing but the change clears it", async () => {
    const existing = await plantAccount("existing@test.invalid", "owner", CHOSEN, false);
    const signed = await login("existing@test.invalid", CHOSEN);
    assert.equal((await get(server.origin, "/admin", { cookie: signed.cookie! })).status, 200);

    // As a row in production carries it today: set, never read.
    await sql`update users set must_change_password = true where id = ${existing.id}`;
    const page = await get(server.origin, "/admin", { cookie: signed.cookie! });
    assert.equal(page.location, CHANGE_PATH, "the session already open is held to it");
    const [token] = await sql<{ csrf_token: string }[]>`
      select csrf_token from sessions where id = ${signed.cookie!.split("=")[1]!.split(".")[0]!}`;
    const refused = await callAction<ActionState>({
      origin: server.origin,
      route: "/admin/faqs",
      file: FAQS,
      action: "saveFaq",
      args: [{ ok: false }, formOf({ _csrf: token!.csrf_token, questionEn: "Mid-session?", scope: "global" })],
      cookie: signed.cookie!,
    });
    assert.equal(refused.value?.message, MUST_CHANGE);

    // Reading pages, signing in again and signing out leave it set.
    await get(server.origin, CHANGE_PATH, { cookie: signed.cookie! });
    await login("existing@test.invalid", CHOSEN);
    assert.equal((await account("existing@test.invalid")).must_change_password, true);
  });

  test("19C · a wrong current password is refused, and counted by the sign-in throttle", async () => {
    const forced = await signedInOnTemporary("current@test.invalid");
    const refused = await change(forced.cookie, { _csrf: forced.csrf, currentPassword: "Not-The-Temporary-1", password: CHOSEN, confirmPassword: CHOSEN });
    assert.equal(refused.value?.ok, false);
    assert.equal(refused.value?.message, "That is not your current password.");
    const [attempt] = await sql<{ successful: boolean }[]>`
      select successful from login_attempts where identifier = 'current@test.invalid' order by id desc limit 1`;
    assert.equal(attempt?.successful, false, "recorded as a failed attempt for the account");
    const unchanged = await account("current@test.invalid");
    assert.equal(unchanged.must_change_password, true);
    assert.equal(unchanged.password_hash, forced.password_hash);

    for (let attempt = 2; attempt <= 6; attempt += 1) {
      await change(forced.cookie, { _csrf: forced.csrf, currentPassword: `Not-The-Temporary-${attempt}`, password: CHOSEN, confirmPassword: CHOSEN });
    }
    const blocked = await change(forced.cookie, { _csrf: forced.csrf, currentPassword: TEMPORARY, password: CHOSEN, confirmPassword: CHOSEN });
    assert.match(blocked.value?.message ?? "", /Too many failed attempts/, "a borrowed cookie cannot guess its way in");
    assert.equal((await account("current@test.invalid")).must_change_password, true);
  });

  test("19C · the change page offers the change and sign-out — nothing of the panel, and only to the account it is for", async () => {
    const forced = await signedInOnTemporary("page@test.invalid");
    const page = await get(server.origin, CHANGE_PATH, { cookie: forced.cookie });
    assert.equal(page.status, 200);
    assert.match(page.html, /Choose a new password/);
    assert.match(page.html, /name="currentPassword"/);
    assert.match(page.html, /name="confirmPassword"/);
    assert.match(page.html, />Sign out</);
    const panelLinks = [...page.html.matchAll(/href="(\/admin[^"]*)"/g)].map((match) => match[1]);
    assert.deepEqual(panelLinks, [], `the page links into the panel: ${panelLinks.join(", ")}`);
    assert.doesNotMatch(page.html, /Visual Editor|Users &amp; roles|data-sidebar/);

    assert.equal((await get(server.origin, CHANGE_PATH)).location, "/admin/login", "a stranger is sent to sign in");
    assert.equal((await get(server.origin, CHANGE_PATH, { cookie: owner.cookie })).location, "/admin", "an ordinary session has nothing to do there");
  });

  test("19C · nothing about the flag reaches anybody who has not proved the password", async () => {
    await createAccount("oracle-temp@test.invalid", "editor");
    await plantAccount("oracle-plain@test.invalid", "editor", CHOSEN, false);
    const flagged = await login("oracle-temp@test.invalid", "Wrong-Password-99x");
    const plain = await login("oracle-plain@test.invalid", "Wrong-Password-99x");
    const nobody = await login("nobody-at-all@test.invalid", "Wrong-Password-99x");
    assert.deepEqual(flagged.refused, plain.refused, "the same answer for a temporary and an ordinary account");
    assert.deepEqual(plain.refused, nobody.refused, "…and for no account at all");
    assert.equal(flagged.redirect, null);

    const anonymous = await get(server.origin, "/admin/login");
    assert.doesNotMatch(anonymous.html, /temporary|must_change|mustChange/i);
  });

  test("19C · the pre-deployment check reports the flagged accounts, lists them only on request, and writes nothing", async () => {
    const counts = await sql<{ active: number; flagged: number; inactive: number; inactive_flagged: number }[]>`
      select count(*) filter (where is_active)::int as active,
             count(*) filter (where is_active and must_change_password)::int as flagged,
             count(*) filter (where not is_active)::int as inactive,
             count(*) filter (where not is_active and must_change_password)::int as inactive_flagged
        from users`;
    const fingerprint = async () =>
      (await sql<{ digest: string }[]>`
        select md5(string_agg(id || ':' || email || ':' || must_change_password || ':' || is_active || ':' || password_hash || ':' || updated_at, ',' order by id)) as digest
          from users`)[0]!.digest;
    const before = await fingerprint();

    const summary = runScript("scripts/check-password-flags.ts", database);
    assert.equal(summary.code, 0, summary.output);
    assert.match(summary.stdout, /read-only/);
    assert.match(summary.stdout, new RegExp(`active accounts\\s+${counts[0]!.active}\\n`));
    assert.match(summary.stdout, new RegExp(`on a temporary password\\s+${counts[0]!.flagged}\\n`));
    assert.match(summary.stdout, new RegExp(`inactive accounts\\s+${counts[0]!.inactive}\\n`));
    assert.ok(counts[0]!.flagged > 0, "the fixture has flagged accounts to report");
    assert.doesNotMatch(summary.stdout, /@test\.invalid/, "no email without --list");

    const listed = runScript("scripts/check-password-flags.ts", database, ["--list"]);
    assert.equal(listed.code, 0, listed.output);
    const flaggedEmails = await sql<{ id: number; email: string }[]>`
      select id, email from users where is_active and must_change_password order by id`;
    for (const { id, email } of flaggedEmails) {
      assert.match(listed.stdout, new RegExp(`id ${id}\\s+${email.replace(/[.]/g, "\\.")}`), `${email} listed`);
    }
    assert.doesNotMatch(listed.stdout, /scrypt\$/, "no password hash is printed");
    assert.equal(await fingerprint(), before, "the check changed nothing");

    const source = readFileSync(path.join(REPO_ROOT, "scripts", "check-password-flags.ts"), "utf8");
    assert.match(source, /sql\.begin\("read only"/);
    assert.match(source, /transaction_read_only/);
    assert.doesNotMatch(source, /\b(update|insert|delete)\s+(into\s+)?(users|sessions)\b/i);
  });
});
