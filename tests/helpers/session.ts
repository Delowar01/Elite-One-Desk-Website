/**
 * An admin session, written straight into the table the application reads.
 *
 * It is the real session model — the same `id.secret` cookie, the same
 * SHA-256 of the secret half, the same CSRF token — just provisioned without
 * driving the login form. Nothing here weakens the check under test: a request
 * carrying this cookie is authenticated exactly as a signed-in owner is, and a
 * request without it is refused exactly as an anonymous one is.
 */
import { createHash, randomBytes } from "node:crypto";

import type { Sql } from "./pg";

export const SESSION_COOKIE = "eod_session";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

export type TestSession = { cookie: string; csrfToken: string; userId: number };

export async function signIn(sql: Sql, roleKey = "owner"): Promise<TestSession> {
  const [user] = await sql<{ id: number }[]>`
    select u.id from users u join roles r on r.id = u.role_id
     where r.key = ${roleKey} and u.is_active
     order by u.id limit 1
  `;
  if (!user) throw new Error(`no active ${roleKey} account in this database`);

  const id = randomBytes(18).toString("base64url");
  const secret = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");

  await sql`
    insert into sessions (id, user_id, token_hash, csrf_token, expires_at, user_agent)
    values (
      ${id}, ${user.id}, ${sha256(secret)}, ${csrfToken},
      ${new Date(Date.now() + 3_600_000)}, 'integration-tests'
    )
  `;

  return { cookie: `${SESSION_COOKIE}=${id}.${secret}`, csrfToken, userId: user.id };
}
