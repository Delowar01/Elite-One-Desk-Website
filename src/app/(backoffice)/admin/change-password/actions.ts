"use server";

import { and, eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { logActivity } from "@/lib/activity";
import { type ActionState, fail, runAction } from "@/lib/admin/actions";
import { guardPasswordChange } from "@/lib/auth/guard";
import { hashPassword, passwordProblem, verifyPassword } from "@/lib/auth/password";
import { checkLoginRate, recordLoginAttempt } from "@/lib/auth/rate-limit";
import { clientIp, hashIp, SESSION_COOKIE } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { sessions, users } from "@/lib/db/schema";

/**
 * An account on a temporary password chooses its own (19C) — the one write
 * such an account may make, and the only thing it changes is that account.
 *
 *   · **Whose password.** The session's own account. No id is read from the
 *     form, so there is nobody else's password this can reach.
 *   · **Who may ask.** A session whose account must change its password, with
 *     the token tied to that session (`guardPasswordChange`). Anonymous
 *     callers and ordinary sessions are refused.
 *   · **The current password, too.** The temporary one, verified like a
 *     sign-in and counted by the same throttle when it is wrong (OWASP ASVS
 *     2.1.6) — so a borrowed cookie is not enough to take the account over.
 *   · **The policy is the one every password already meets**
 *     (`passwordProblem`), typed twice, and not the temporary one again.
 *   · **Then every session ends.** The new hash, the cleared flag and the
 *     deletion of every session for the account are one transaction, guarded
 *     on the hash the checks were made against: a reset an owner made in the
 *     meantime wins and this is refused, rather than overwritten. The cookie is
 *     cleared and the browser goes to the sign-in form — the new password is
 *     proved by signing in with it, and only then does the role apply again.
 */
export async function changeOwnPassword(_prev: ActionState, form: FormData): Promise<ActionState> {
  const result = await runAction("password-change", async () => {
    const session = await guardPasswordChange(form);
    const current = String(form.get("currentPassword") ?? "");
    const password = String(form.get("password") ?? "");
    const confirm = String(form.get("confirmPassword") ?? "");

    const identifier = session.user.email.toLowerCase();
    const ipHash = hashIp(await clientIp());
    const rate = await checkLoginRate(identifier, ipHash);
    if (rate.blocked) {
      return fail(`Too many failed attempts. Try again in about ${rate.retryAfterMinutes} minutes.`);
    }

    const [account] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, session.user.id))
      .limit(1);
    if (!account) return fail("Your session has expired. Sign in again.");

    if (!current || !(await verifyPassword(current, account.passwordHash))) {
      await recordLoginAttempt(identifier, ipHash, false);
      return fail("That is not your current password.", {
        currentPassword: "Enter the temporary password you signed in with.",
      });
    }

    const problem = passwordProblem(password);
    if (problem) return fail("That password is not strong enough.", { password: problem });
    if (password !== confirm) {
      return fail("The two new passwords do not match.", { confirmPassword: "Type the same new password again." });
    }
    if (await verifyPassword(password, account.passwordHash)) {
      return fail("Choose a password different from your temporary one.", {
        password: "This is the temporary password. Choose your own.",
      });
    }

    const passwordHash = await hashPassword(password);
    const changed = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(users)
        .set({ passwordHash, mustChangePassword: false, updatedAt: new Date() })
        .where(
          and(
            eq(users.id, session.user.id),
            eq(users.mustChangePassword, true),
            eq(users.passwordHash, account.passwordHash),
          ),
        )
        .returning({ id: users.id });
      if (!row) return false;
      await tx.delete(sessions).where(eq(sessions.userId, session.user.id));
      return true;
    });
    if (!changed) {
      return fail(
        "Your account was changed while you were choosing a password, so nothing was saved. Sign in again with the password you were given most recently.",
      );
    }

    await logActivity(session, {
      action: "user.password_changed",
      entityType: "user",
      entityId: session.user.id,
      summary: "Replaced a temporary password with their own; every session was signed out",
    });
    return { ok: true };
  });

  if (!result.ok) return result;
  // The session row is already gone with the others; the cookie follows it, so
  // nothing in this browser still names a session.
  (await cookies()).delete(SESSION_COOKIE);
  redirect("/admin/login?changed=1");
}
