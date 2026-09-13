/**
 * Where the integration tests are allowed to write.
 *
 * Every database these tests touch is created and dropped by the tests
 * themselves, under names prefixed `eodt_`. Nothing here ever reads
 * `.env` — pointing a test run at the development database, let alone a
 * restored production one, has to be impossible by construction rather than by
 * remembering.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Server the test databases live on. No database name — the tests add that. */
export const PG_BASE = (process.env.TEST_PG_URL ?? "postgres://postgres@127.0.0.1:5432").replace(
  /\/+$/,
  "",
);

/**
 * The commit whose seed produces the pre-restructure catalogue — the historical
 * fixture the restructure and seed-state tests are written against.
 *
 * This is NOT the previous release. It is a fixed point in history that stays
 * where it is; see COMPAT_REF for the moving one.
 */
export const LEGACY_REF = process.env.LEGACY_REF ?? "ea20a22";

/**
 * The release currently running in production, read from
 * `deploy/previous-release`.
 *
 * A migration runs while that release is still serving, so it is that release —
 * not `LEGACY_REF` — whose table definitions have to survive the new schema.
 * Pinning the compatibility check to the historical fixture would miss anything
 * added after it: `destination_id` does not exist at `ea20a22`, so a migration
 * dropping it would pass a probe built from that schema while breaking the code
 * actually serving traffic.
 *
 * Read from a file rather than inferred, because git cannot tell which commit is
 * deployed — `HEAD~1` is the previous commit, and a release is usually several.
 */
export function compatRef(): string {
  if (process.env.COMPAT_REF) return process.env.COMPAT_REF;
  const file = path.join(REPO_ROOT, "deploy", "previous-release");
  const line = readFileSync(file, "utf8")
    .split("\n")
    .map((row) => row.trim())
    .find((row) => row && !row.startsWith("#"));
  if (!line) throw new Error(`${file} names no commit`);
  return line;
}

export const PREFIX = "eodt_";

export const dbUrl = (name: string) => `${PG_BASE}/${name}`;

export function assertTestDatabase(name: string): void {
  if (!name.startsWith(PREFIX)) {
    throw new Error(`refusing to touch "${name}" — test databases are named ${PREFIX}*`);
  }
}

/** A plain environment block — not `NodeJS.ProcessEnv`, whose NODE_ENV is required. */
export type EnvBlock = Record<string, string | undefined>;

/**
 * The environment a repo script needs. Deliberately built from scratch rather
 * than inherited: a stray DATABASE_URL in the shell must not be able to reach
 * the script under test.
 */
export function scriptEnv(databaseUrl: string, extra: EnvBlock = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: databaseUrl,
    AUTH_SECRET: "integration-test-secret-not-used-anywhere-real-0123456789",
    UPLOAD_DIR: path.join(REPO_ROOT, ".data", "test-uploads"),
    NEXT_PUBLIC_SITE_URL: "http://127.0.0.1:3100",
    SEED_OWNER_EMAIL: "owner@test.invalid",
    SEED_OWNER_PASSWORD: "IntegrationOwner!2026",
    SEED_OWNER_NAME: "Integration Owner",
  };
  for (const [key, value] of Object.entries(extra)) env[key] = value;
  return env;
}

export const uniqueName = (label: string) =>
  `${PREFIX}${label}_${randomBytes(4).toString("hex")}`;
