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
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/** Server the test databases live on. No database name — the tests add that. */
export const PG_BASE = (process.env.TEST_PG_URL ?? "postgres://postgres@127.0.0.1:5432").replace(
  /\/+$/,
  "",
);

/** The commit whose seed produces the pre-restructure catalogue — production's shape. */
export const LEGACY_REF = process.env.LEGACY_REF ?? "ea20a22";

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
