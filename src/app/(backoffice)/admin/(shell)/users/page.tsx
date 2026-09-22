import { asc, eq } from "drizzle-orm";

import { AdminPageHeader } from "@/components/admin/page-header";
import { requirePermissions } from "@/lib/auth/guard";
import { PERMISSIONS } from "@/lib/auth/permissions";
import { db } from "@/lib/db";
import { permissions as permissionsTable, rolePermissions, roles, users } from "@/lib/db/schema";
import { UsersClient, type RoleRow, type UserRow } from "./users-client";

export const metadata = { title: "Users & roles" };
export const dynamic = "force-dynamic";

/**
 * One screen, two separately-granted concerns.
 *
 * Managing accounts is `users.manage`; deciding what a role may do is
 * `roles.manage`, and an owner can grant either without the other. The route
 * used to ask for `users.manage` alone, so a role created to do nothing but
 * adjust permissions could not reach the only screen that adjusts them — the
 * permission existed and had no door.
 *
 * So the route asks for **either**, and each half is loaded and rendered only
 * for the permission that owns it: no account list for somebody who may only
 * edit roles, no permission grid for somebody who may only manage people.
 * Neither implies the other, and the actions behind both still name their own
 * key, so this decides what is *sent*, never what is *allowed*.
 */
export default async function UsersPage() {
  const session = await requirePermissions(
    { any: ["users.manage", "roles.manage"] },
    "/admin/users",
  );
  const canManageUsers = session.permissions.has("users.manage");
  const canManageRoles = session.permissions.has("roles.manage");

  const [userRows, roleRows, grants] = await Promise.all([
    canManageUsers
      ? db
          .select({
            id: users.id,
            email: users.email,
            name: users.name,
            roleId: users.roleId,
            roleKey: roles.key,
            roleName: roles.name,
            isActive: users.isActive,
            mustChangePassword: users.mustChangePassword,
            lastLoginAt: users.lastLoginAt,
          })
          .from(users)
          .innerJoin(roles, eq(roles.id, users.roleId))
          .orderBy(asc(roles.id), asc(users.name))
      : Promise.resolve([]),
    // Role names are needed by both halves — to assign one, and to describe one.
    db.select().from(roles).orderBy(asc(roles.id)),
    canManageRoles
      ? db
          .select({ roleId: rolePermissions.roleId, key: permissionsTable.key })
          .from(rolePermissions)
          .innerJoin(permissionsTable, eq(permissionsTable.id, rolePermissions.permissionId))
      : Promise.resolve([]),
  ]);

  const byRole = new Map<number, string[]>();
  for (const grant of grants) {
    byRole.set(grant.roleId, [...(byRole.get(grant.roleId) ?? []), grant.key]);
  }

  const roleList: RoleRow[] = roleRows.map((role) => ({
    id: role.id,
    key: role.key,
    name: role.name,
    description: role.description,
    permissions: byRole.get(role.id) ?? [],
  }));

  const people: UserRow[] = userRows.map((row) => ({
    ...row,
    lastLoginAt: row.lastLoginAt ? row.lastLoginAt.toISOString() : null,
  }));

  return (
    <>
      <AdminPageHeader
        title="Users & roles"
        description="Permissions are checked on the server for every change, so what a role cannot do, it cannot do — hiding a button is never the control."
      />
      <UsersClient
        csrf={session.csrfToken}
        users={people}
        roles={roleList}
        permissions={
          canManageRoles
            ? PERMISSIONS.map((p) => ({ key: p.key, label: p.label, group: p.group }))
            : []
        }
        currentUserId={session.user.id}
        isOwner={session.user.roleKey === "owner"}
        canManageUsers={canManageUsers}
        canManageRoles={canManageRoles}
      />
    </>
  );
}
