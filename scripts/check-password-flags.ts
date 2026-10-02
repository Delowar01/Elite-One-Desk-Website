import "./env";

import postgres from "postgres";

/**
 * Pre-deployment check for temporary passwords (19C) — read-only.
 *
 *   npm run db:check-password-flags             counts only
 *   npm run db:check-password-flags -- --list   and which accounts, by id and email
 *
 * Every release before this one stored `users.must_change_password` on a new
 * account and on a password an admin reset, and never read it. This release
 * enforces it: such an account can still sign in, and can then do nothing but
 * choose a new password. Rows that carry the flag today are honoured as they
 * stand — nothing clears them silently, this script included — so before the
 * release takes traffic an operator should know how many accounts that is and,
 * if they are entitled to, which ones, so nobody meets the change mid-task
 * without warning.
 *
 * Counts by default, so the output can go into a release record without
 * personal data. `--list` adds the id, email and role of each flagged account
 * that can still sign in — for an authorised operator who means to tell those
 * people. No password hash, session or any other column is read.
 *
 * Everything runs in one `BEGIN READ ONLY` transaction: nothing here can
 * write. It reports rather than gates (exit 0); 2 means DATABASE_URL is not
 * set and 1 that the database could not be read.
 */

type Account = { id: number; email: string; role: string; active: boolean; flagged: boolean };

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (see .env.example).");
    return 2;
  }
  const list = process.argv.includes("--list");
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    const accounts = await sql.begin("read only", async (tx) => {
      const [mode] = await tx<{ readonly: string }[]>`select current_setting('transaction_read_only') as readonly`;
      if (mode?.readonly !== "on") throw new Error("the check's transaction is not read-only — refusing to continue");
      return [
        ...(await tx<Account[]>`
          select u.id, u.email, r.key::text as role, u.is_active as active, u.must_change_password as flagged
            from users u
            join roles r on r.id = u.role_id
           order by u.id`),
      ];
    });

    const active = accounts.filter((account) => account.active);
    const flagged = active.filter((account) => account.flagged);
    const flaggedOwners = flagged.filter((account) => account.role === "owner");
    const inactive = accounts.filter((account) => !account.active);
    const inactiveFlagged = inactive.filter((account) => account.flagged);
    const activeOwners = active.filter((account) => account.role === "owner");

    console.log("Temporary-password preflight — read-only\n");
    console.log(`active accounts                      ${active.length}`);
    console.log(`  on a temporary password            ${flagged.length}`);
    console.log(`  of them owners                     ${flaggedOwners.length} of ${activeOwners.length}`);
    console.log(`inactive accounts                    ${inactive.length}`);
    console.log(`  on a temporary password            ${inactiveFlagged.length} (cannot sign in either way)`);
    console.log("");

    if (!flagged.length) {
      console.log("No account that can sign in is on a temporary password. Nobody will be stopped by this release.");
    } else {
      console.log(
        `${flagged.length} account${flagged.length === 1 ? "" : "s"} will be asked to choose a new password at the next sign-in, ` +
          "and can do nothing else in the panel until then. The flag is honoured as it stands — this check changes nothing.",
      );
      if (flaggedOwners.length && flaggedOwners.length === activeOwners.length) {
        console.log(
          "NOTE  every active owner is on a temporary password: the first owner to sign in after the release " +
            "chooses a new password before reaching anything else. Nobody is locked out — the change page is always open to them.",
        );
      }
      if (list) {
        console.log("\nflagged accounts that can sign in (for an authorised operator):");
        for (const account of flagged) {
          console.log(`  id ${String(account.id).padEnd(6)} ${account.email.padEnd(40)} ${account.role}`);
        }
      } else {
        console.log("Run with --list to see which accounts (id, email, role) — for an authorised operator only.");
      }
    }
    return 0;
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
