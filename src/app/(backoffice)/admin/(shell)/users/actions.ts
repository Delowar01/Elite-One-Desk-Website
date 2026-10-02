"use server";

import { and, eq, ne, sql } from "drizzle-orm";
import { revalidatePath } from "next/cache";

import { logActivity } from "@/lib/activity";
import { checkbox, fail, field, ok, runAction, type ActionState } from "@/lib/admin/actions";
import { assertMayManageUser, guardAction } from "@/lib/auth/guard";
import { hashPassword, passwordProblem } from "@/lib/auth/password";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { destroyUserSessions, setRolePermissions } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { roles, users } from "@/lib/db/schema";

const refresh = () => revalidatePath("/admin/users");

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function roleOf(roleId: number) {
  const [row] = await db.select().from(roles).where(eq(roles.id, roleId)).limit(1);
  return row ?? null;
}

export async function createUser(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("user-create", async () => {
    const session = await guardAction("users.manage", form);
    const email = field(form, "email", 190).toLowerCase();
    const name = field(form, "name", 120);
    const password = String(form.get("password") ?? "");
    const roleId = Number(form.get("roleId"));

    if (!EMAIL.test(email)) return fail("That email address is not valid.", { email: "Check the address." });
    if (!name) return fail("Give the person a name.", { name: "Required." });

    const problem = passwordProblem(password);
    if (problem) return fail("That password is not strong enough.", { password: problem });

    const role = await roleOf(roleId);
    if (!role) return fail("Choose a role.", { roleId: "Required." });
    assertMayManageUser(session, role.key);

    const [existing] = await db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);
    if (existing) return fail("Someone already uses that email address.", { email: "Already in use." });

    const [row] = await db
      .insert(users)
      .values({
        email,
        name,
        passwordHash: await hashPassword(password),
        roleId,
        isActive: true,
        // A temporary password: whoever set it knows it, so the account
        // chooses its own at its first sign-in and can do nothing until then
        // (19C — `getSession` refuses the account while this is set).
        mustChangePassword: true,
      })
      .returning({ id: users.id });

    await logActivity(session, {
      action: "user.created",
      entityType: "user",
      entityId: row!.id,
      summary: `Created the ${role.name} account for ${email} with a temporary password`,
    });
    refresh();
    return ok(
      `Account created with a temporary password. Give it to ${name} — they will be required to choose a new password at their next sign-in.`,
    );
  });
}

export async function updateUser(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("user-update", async () => {
    const session = await guardAction("users.manage", form);
    const id = Number(form.get("id"));
    const name = field(form, "name", 120);
    const roleId = Number(form.get("roleId"));
    const isActive = checkbox(form, "isActive");

    const [target] = await db
      .select({ user: users, roleKey: roles.key })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(eq(users.id, id))
      .limit(1);
    if (!target) return fail("That account no longer exists.");

    assertMayManageUser(session, target.roleKey);
    const nextRole = await roleOf(roleId);
    if (!nextRole) return fail("Choose a role.", { roleId: "Required." });
    assertMayManageUser(session, nextRole.key);

    // Locking yourself out is the one mistake with no way back from inside.
    if (target.user.id === session.user.id && !isActive) {
      return fail("You cannot deactivate your own account.");
    }

    if (target.roleKey === "owner" && nextRole.key !== "owner") {
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(users)
        .innerJoin(roles, eq(roles.id, users.roleId))
        .where(and(eq(roles.key, "owner"), eq(users.isActive, true), ne(users.id, id)));
      if (!n) return fail("There has to be at least one active owner.");
    }

    await db
      .update(users)
      .set({ name, roleId, isActive, updatedAt: new Date() })
      .where(eq(users.id, id));

    // A role change or a deactivation takes effect on the next request, not
    // whenever their current session happens to expire.
    if (roleId !== target.user.roleId || !isActive) await destroyUserSessions(id);

    await logActivity(session, {
      action: roleId !== target.user.roleId ? "user.role_changed" : "user.updated",
      entityType: "user",
      entityId: id,
      summary: `Updated ${target.user.email} (${nextRole.name}${isActive ? "" : ", deactivated"})`,
    });
    refresh();
    return ok("Account updated.");
  });
}

export async function resetUserPassword(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("user-password", async () => {
    const session = await guardAction("users.manage", form);
    const id = Number(form.get("id"));
    const password = String(form.get("password") ?? "");

    const [target] = await db
      .select({ user: users, roleKey: roles.key })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(eq(users.id, id))
      .limit(1);
    if (!target) return fail("That account no longer exists.");
    assertMayManageUser(session, target.roleKey);

    const problem = passwordProblem(password);
    if (problem) return fail("That password is not strong enough.", { password: problem });

    // Somebody else's password, set by an admin, is temporary: the admin knows
    // it, so its owner must choose their own at the next sign-in (19C). Your
    // own is yours already — you chose it — so it is not.
    const self = target.user.id === session.user.id;
    await db
      .update(users)
      .set({
        passwordHash: await hashPassword(password),
        mustChangePassword: !self,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id));

    // Every existing session for that account is ended, including any an
    // attacker might be holding — and, for your own, this one.
    await destroyUserSessions(id);

    // Recorded as what it is. Changing your own password from this screen is
    // not the same act as setting a temporary one for somebody else, and the
    // log says which, so neither can be read as the other.
    await logActivity(
      session,
      self
        ? {
            action: "user.password_self_reset",
            entityType: "user",
            entityId: id,
            summary: "Changed their own password from Users & roles; every session was signed out",
            metadata: { self: true, temporary: false },
          }
        : {
            action: "user.password_reset",
            entityType: "user",
            entityId: id,
            summary: `Set a temporary password for ${target.user.email}; every session was signed out`,
            metadata: { self: false, temporary: true },
          },
    );
    refresh();
    return ok(
      self
        ? "Password changed. Sign in again with the new one."
        : "Temporary password set and every session for that account signed out. They will be required to choose a new password at their next sign-in.",
    );
  });
}

export async function deleteUser(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("user-delete", async () => {
    const session = await guardAction("users.manage", form);
    const id = Number(form.get("id"));
    if (id === session.user.id) return fail("You cannot delete your own account.");

    const [target] = await db
      .select({ user: users, roleKey: roles.key })
      .from(users)
      .innerJoin(roles, eq(roles.id, users.roleId))
      .where(eq(users.id, id))
      .limit(1);
    if (!target) return fail("That account no longer exists.");
    assertMayManageUser(session, target.roleKey);

    if (target.roleKey === "owner") {
      const [{ n }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(users)
        .innerJoin(roles, eq(roles.id, users.roleId))
        .where(and(eq(roles.key, "owner"), ne(users.id, id)));
      if (!n) return fail("The last owner account cannot be deleted.");
    }

    await db.delete(users).where(eq(users.id, id));
    await logActivity(session, {
      action: "user.deleted",
      entityType: "user",
      entityId: id,
      summary: `Deleted the account for ${target.user.email}`,
    });
    refresh();
    return ok("Account deleted. Their activity-log entries are kept.");
  });
}

export async function saveRolePermissions(_prev: ActionState, form: FormData): Promise<ActionState> {
  return runAction("role-permissions", async () => {
    const session = await guardAction("roles.manage", form);
    const roleId = Number(form.get("roleId"));
    const role = await roleOf(roleId);
    if (!role) return fail("That role no longer exists.");

    // The owner role is the recovery path; narrowing it could lock everyone out
    // of the settings that would put it back.
    if (role.key === "owner") return fail("The owner role always has every permission.");

    const keys = PERMISSIONS.map((p) => p.key).filter((key) => form.get(`perm:${key}`) === "on");
    await setRolePermissions(roleId, keys);

    await logActivity(session, {
      action: "role.permissions_changed",
      entityType: "role",
      entityId: roleId,
      summary: `Set ${keys.length} permission${keys.length === 1 ? "" : "s"} on the ${role.name} role`,
      metadata: { keys },
    });
    refresh();
    return ok(`${role.name} now has ${keys.length} permission${keys.length === 1 ? "" : "s"}.`);
  });
}
