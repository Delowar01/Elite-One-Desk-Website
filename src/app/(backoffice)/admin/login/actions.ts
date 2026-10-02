"use server";

import { eq, sql } from "drizzle-orm";
import { redirect } from "next/navigation";

import { logActivity } from "@/lib/activity";
import { CHANGE_PASSWORD_PATH } from "@/lib/auth/guard";
import { verifyPassword } from "@/lib/auth/password";
import { checkLoginRate, recordLoginAttempt } from "@/lib/auth/rate-limit";
import { clientIp, createSession, destroySession, hashIp, readSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { roles, users } from "@/lib/db/schema";
import { type ActionState, fail, runAction } from "@/lib/admin/actions";

/** Only site-relative paths inside the panel are accepted as a return target. */
function safeNext(value: string): string {
  if (!value.startsWith("/admin") || value.startsWith("//")) return "/admin";
  return value;
}

export async function signIn(_prev: ActionState, form: FormData): Promise<ActionState> {
  const email = String(form.get("email") ?? "").trim().toLowerCase().slice(0, 190);
  const password = String(form.get("password") ?? "");
  const next = safeNext(String(form.get("next") ?? "/admin"));
  // Decided by the account row, after the password has been verified — never
  // by anything in the request (19C).
  let temporary = false;

  const result = await runAction("sign-in", async () => {
    if (!email || !password) return fail("Enter your email address and password.");

    const ipHash = hashIp(await clientIp());
    const rate = await checkLoginRate(email, ipHash);
    if (rate.blocked) {
      return fail(
        `Too many failed attempts. Try again in about ${rate.retryAfterMinutes} minutes.`,
      );
    }

    const [found] = await db
      .select({ user: users, roleKey: roles.key })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);

    // The password is verified even when the account is missing, so a wrong
    // address and a wrong password take the same amount of time to answer.
    const hash =
      found?.user.passwordHash ??
      "scrypt$32768$8$1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
    const valid = await verifyPassword(password, hash);

    if (!found || !valid || !found.user.isActive) {
      await recordLoginAttempt(email, ipHash, false);
      return fail("That email address and password do not match an active account.");
    }

    await recordLoginAttempt(email, ipHash, true);
    await createSession(found.user.id);
    await db.update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, found.user.id));
    temporary = found.user.mustChangePassword;
    await logActivity(
      {
        sessionId: "",
        csrfToken: "",
        user: {
          id: found.user.id,
          name: found.user.name,
          email: found.user.email,
          roleKey: found.roleKey,
          roleName: found.roleKey,
        },
        permissions: new Set(),
        mustChangePassword: temporary,
      },
      {
        action: "login",
        entityType: "user",
        entityId: found.user.id,
        summary: temporary ? "Signed in with a temporary password" : "Signed in",
      },
    );
    return { ok: true };
  });

  if (!result.ok) return result;
  // An account on a temporary password goes to choose its own, wherever the
  // form said it was going: `next` is the browser's word, the flag is ours.
  redirect(temporary ? CHANGE_PASSWORD_PATH : next);
}

/**
 * Never refused, whatever state the account is in — including one that must
 * change its password, which is why the session is read with `readSession`:
 * `getSession` would not return it, and the sign-out would go unrecorded.
 */
export async function signOut(): Promise<void> {
  const session = await readSession();
  if (session) {
    await logActivity(session, { action: "logout", entityType: "user", entityId: session.user.id });
  }
  await destroySession();
  redirect("/admin/login");
}
