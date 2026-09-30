import "./env";

import postgres from "postgres";

import { INTRODUCED_FROM, PERMISSIONS } from "../src/lib/auth/permissions";

/**
 * Release preflight for the granular permissions (Batch 18) — read-only.
 *
 *   npm run db:check-permissions              the release gate
 *   npm run db:check-permissions -- --strict  right after the FIRST upgrade
 *
 * Run after `db:migrate` and `db:seed` and before the new build takes any
 * administrative traffic; `deploy/deploy.sh` does exactly that between its
 * seed and its switch. This build authorizes every page, style, motion,
 * layout, publishing and reusable-component action with the granular keys, so
 * a database that has not been upgraded would refuse legitimate editors the
 * moment the new runtime started.
 *
 * Fails (exit 1) when:
 *   · a key this build's catalogue names is not in `permissions` — the
 *     upgrade did not run;
 *   · the owner role does not hold every key — the seed always gives it
 *     everything and the Roles screen cannot narrow it.
 *
 * Reports, and with `--strict` also fails on: a role that holds the legacy
 * `content.manage` but lacks part of the split derived from it. Straight after
 * the first upgrade that cannot happen — derivation grants the whole split to
 * every such role — so it means the upgrade misfired. Later it is usually an
 * owner's deliberate narrowing, which is why it is not a failure by default.
 *
 * Everything runs in one `BEGIN READ ONLY` transaction: nothing here can write.
 */

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (see .env.example).");
    return 2;
  }
  const strict = process.argv.includes("--strict");
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    const { keys, grants } = await sql.begin("read only", async (tx) => {
      const [mode] = await tx<{ readonly: string }[]>`select current_setting('transaction_read_only') as readonly`;
      if (mode?.readonly !== "on") throw new Error("the check's transaction is not read-only — refusing to continue");
      const keys = (await tx<{ key: string }[]>`select key from permissions`).map((row) => row.key);
      const grants = await tx<{ role: string; key: string }[]>`
        select r.key::text as role, p.key
          from roles r
          join role_permissions rp on rp.role_id = r.id
          join permissions p on p.id = rp.permission_id`;
      return { keys, grants: [...grants] };
    });

    const expected = PERMISSIONS.map((permission) => permission.key as string);
    const present = new Set(keys);
    const held = new Map<string, Set<string>>();
    for (const { role, key } of grants) {
      if (!held.has(role)) held.set(role, new Set());
      held.get(role)!.add(key);
    }

    const failures: string[] = [];
    const warnings: string[] = [];

    const absent = expected.filter((key) => !present.has(key));
    if (absent.length) failures.push(`missing from the permission catalogue: ${absent.join(", ")} — run the seed (the upgrade) first`);

    const owner = held.get("owner") ?? new Set<string>();
    const ownerLacks = expected.filter((key) => present.has(key) && !owner.has(key));
    if (!held.has("owner")) failures.push("there is no owner role");
    else if (ownerLacks.length) failures.push(`the owner role lacks: ${ownerLacks.join(", ")}`);

    const derived = Object.entries(INTRODUCED_FROM) as [string, string][];
    for (const [role, roleKeys] of [...held.entries()].sort()) {
      if (role === "owner") continue;
      const lacking = derived
        .filter(([key, source]) => roleKeys.has(source) && !roleKeys.has(key))
        .map(([key]) => key);
      if (lacking.length) {
        warnings.push(`${role} holds the source of, but not: ${lacking.join(", ")}`);
      }
    }

    console.log(`Permission preflight — read-only — ${expected.length} keys in this build's catalogue\n`);
    const roles = [...held.keys()].sort((a, b) => ["owner", "admin", "editor", "viewer"].indexOf(a) - ["owner", "admin", "editor", "viewer"].indexOf(b));
    const granular = expected.filter((key) => key in INTRODUCED_FROM || key === "content.manage" || key === "content.view" || key === "visual_editor.view");
    console.log(`${"key".padEnd(24)} ${roles.map((role) => role.padEnd(7)).join(" ")}`);
    for (const key of granular) {
      console.log(`${key.padEnd(24)} ${roles.map((role) => (held.get(role)?.has(key) ? "yes" : "-").padEnd(7)).join(" ")}`);
    }
    console.log("");
    for (const warning of warnings) console.log(`${strict ? "FAIL" : "NOTE"}  ${warning}`);
    for (const failure of failures) console.log(`FAIL  ${failure}`);
    const failed = failures.length > 0 || (strict && warnings.length > 0);
    console.log(failed ? "\nThe permission upgrade is NOT verified. Do not switch to this release." : "\nThe permission catalogue is complete and the owner holds every key.");
    return failed ? 1 : 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
