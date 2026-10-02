import "server-only";

import { redirect } from "next/navigation";
import { timingSafeEqual } from "node:crypto";

import {
  satisfies,
  type PermissionKey,
  type PermissionRequirement,
} from "./permissions";
import { getPasswordChangeSession, getSession, type AdminSession } from "./session";

export class AccessError extends Error {
  constructor(message = "You do not have permission to do that.") {
    super(message);
    this.name = "AccessError";
  }
}

/**
 * Where an account on a temporary password is sent, whatever it asked for
 * (19C) — the one admin page it may open until it has chosen its own.
 */
export const CHANGE_PASSWORD_PATH = "/admin/change-password";

/** What a refused write says to an account that must change its password first. */
export const MUST_CHANGE_PASSWORD_MESSAGE =
  "Choose a new password before you do anything else. Nothing was changed.";

/**
 * For pages: bounce anonymous callers to the login screen, keeping their
 * target. A caller who is signed in but must change their password goes to
 * the password-change page instead, and keeps no target: it is the only
 * place they are going until it is done.
 */
export async function requireSession(returnTo?: string): Promise<AdminSession> {
  const session = await getSession();
  if (!session) {
    if (await getPasswordChangeSession()) redirect(CHANGE_PASSWORD_PATH);
    redirect(returnTo ? `/admin/login?next=${encodeURIComponent(returnTo)}` : "/admin/login");
  }
  return session;
}

/**
 * The guard every admin page runs, for a requirement of any shape.
 *
 * One evaluator, shared with the sidebar filter, so a link cannot appear for
 * somebody the route behind it will turn away — and the reverse, which is the
 * failure that actually happened: `/admin/users` asked for `users.manage`
 * alone, so a role holding `roles.manage` could see nothing of the screen that
 * exists for it.
 */
export async function requirePermissions(
  requirement: PermissionRequirement,
  returnTo?: string,
): Promise<AdminSession> {
  const session = await requireSession(returnTo);
  if (!satisfies(session.permissions, requirement)) redirect("/admin?denied=1");
  return session;
}

export async function requirePermission(
  permission: PermissionKey,
  returnTo?: string,
): Promise<AdminSession> {
  return requirePermissions(permission, returnTo);
}

export function can(
  session: AdminSession | null,
  requirement: PermissionRequirement,
): boolean {
  return Boolean(session && satisfies(session.permissions, requirement));
}

function tokensMatch(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * The guard of the one write an account on a temporary password may make —
 * choosing its own (19C). `guardAction` refuses such an account, so this is
 * its counterpart: the session must be one that must change its password, and
 * the form must carry that session's token. It asks for no permission because
 * there is nothing to permit: the action changes the caller's own password and
 * reads no account id from the request.
 */
export async function guardPasswordChange(formData: FormData): Promise<AdminSession> {
  const session = await getPasswordChangeSession();
  if (!session) {
    if (await getSession()) throw new AccessError("There is no password change waiting for this account.");
    throw new AccessError("Your session has expired. Sign in again.");
  }
  const token = String(formData.get("_csrf") ?? "");
  if (!token || !tokensMatch(token, session.csrfToken)) {
    throw new AccessError("This form expired. Reload the page and try again.");
  }
  return session;
}

/**
 * Every admin mutation runs through here. Server Actions already reject
 * cross-origin POSTs, but a synchroniser token tied to the session row is the
 * check that does not depend on a header an intermediary might rewrite — and it
 * is the one an auditor can see in the form markup.
 *
 * The requirement is any shape `satisfies()` reads (Batch 18): one key, as
 * every resource screen still asks, or an all-of from `lib/auth/authority.ts`
 * for a page or component operation. The session, its token and the grants are
 * read exactly once, here — the grants from the database on this request, so a
 * permission removed a moment ago is already gone.
 */
export async function guardAction(
  requirement: PermissionRequirement,
  formData: FormData,
  denied?: string,
): Promise<AdminSession> {
  const session = await getSession();
  if (!session) {
    // Signed in on a temporary password: refused like anybody without a
    // session, before the token or a single field is read (19C).
    if (await getPasswordChangeSession()) throw new AccessError(MUST_CHANGE_PASSWORD_MESSAGE);
    throw new AccessError("Your session has expired. Sign in again.");
  }

  const token = String(formData.get("_csrf") ?? "");
  if (!token || !tokensMatch(token, session.csrfToken)) {
    throw new AccessError("This form expired. Reload the page and try again.");
  }
  assertAllowed(session, requirement, denied);
  return session;
}

/**
 * A further requirement that depends on what the request would change — an
 * advanced style token that moved, an entrance the classic form would alter,
 * a reusable-component reference a content save adds. Checked against the
 * session `guardAction` already verified, so there is no second session read
 * and no second CSRF check to drift from the first; and always **before**
 * anything is written, so a refusal leaves no revision, no row and no
 * activity entry behind.
 */
export function assertAllowed(
  session: AdminSession,
  requirement: PermissionRequirement,
  denied?: string,
): void {
  if (!satisfies(session.permissions, requirement)) throw new AccessError(denied);
}

/**
 * Owner accounts are the one thing an admin may not touch: whoever can rewrite
 * an owner's password owns the site. Checked against the target row, not the UI.
 */
export function assertMayManageUser(session: AdminSession, targetRoleKey: string): void {
  if (targetRoleKey === "owner" && session.user.roleKey !== "owner") {
    throw new AccessError("Only an owner can manage owner accounts.");
  }
}
