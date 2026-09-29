import "server-only";

import { redirect } from "next/navigation";
import { timingSafeEqual } from "node:crypto";

import {
  satisfies,
  type PermissionKey,
  type PermissionRequirement,
} from "./permissions";
import { getSession, type AdminSession } from "./session";

export class AccessError extends Error {
  constructor(message = "You do not have permission to do that.") {
    super(message);
    this.name = "AccessError";
  }
}

/** For pages: bounce anonymous callers to the login screen, keeping their target. */
export async function requireSession(returnTo?: string): Promise<AdminSession> {
  const session = await getSession();
  if (!session) {
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
  if (!session) throw new AccessError("Your session has expired. Sign in again.");

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
