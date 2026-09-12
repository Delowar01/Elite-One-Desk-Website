/**
 * The two database shapes every test starts from.
 *
 * `legacy` is the catalogue production is holding today: six categories,
 * eighty-six services, the Egypt subcategory, no destinations. It is not a
 * curated fixture file but the output of the seed as it stood at `LEGACY_REF`,
 * checked out into a worktree and run — so the tests measure the restructure
 * against the real thing rather than against a snapshot somebody trimmed.
 *
 * `fresh` is this branch's seed on an empty database: the restructured
 * catalogue as a new installation would get it.
 *
 * Both are built once per run, dumped, and restored per test. Building them is
 * the slow part (a migrate and a seed each); restoring is a second.
 */
import { existsSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { LEGACY_REF, REPO_ROOT, dbUrl, scriptEnv, uniqueName } from "./env";
import { dropDatabase, dumpDatabase, recreateDatabase, restoreDatabase } from "./pg";
import { migrate, runScript, seed } from "./run";

const WORK = path.join(REPO_ROOT, ".data", "test");
const LEGACY_TREE = path.join(WORK, "legacy-tree");
const LEGACY_SQL = path.join(WORK, "legacy.sql");
const FRESH_SQL = path.join(WORK, "fresh.sql");

const sh = (cmd: string, args: string[], cwd = REPO_ROOT) => {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
};

/** A checkout of the pre-restructure code, sharing this one's node_modules. */
function ensureLegacyTree(): string {
  if (existsSync(path.join(LEGACY_TREE, "package.json"))) return LEGACY_TREE;
  mkdirSync(WORK, { recursive: true });
  rmSync(LEGACY_TREE, { recursive: true, force: true });
  sh("git", ["worktree", "prune"]);
  const added = sh("git", ["worktree", "add", "--detach", LEGACY_TREE, LEGACY_REF]);
  if (added.status !== 0) {
    throw new Error(`could not check out ${LEGACY_REF}: ${added.stderr}`);
  }
  symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(LEGACY_TREE, "node_modules"));
  return LEGACY_TREE;
}

function buildLegacySql(): void {
  const tree = ensureLegacyTree();
  const scratch = uniqueName("build_legacy");
  recreateDatabase(scratch);
  try {
    for (const script of ["scripts/migrate.ts", "scripts/seed.ts"]) {
      const result = spawnSync("npx", ["tsx", script], {
        cwd: tree,
        encoding: "utf8",
        env: scriptEnv(dbUrl(scratch)),
        maxBuffer: 32 * 1024 * 1024,
      });
      if (result.status !== 0) {
        throw new Error(`${LEGACY_REF} ${script} failed: ${result.stderr || result.stdout}`);
      }
    }
    // The new migration lands on top, exactly as a Phase A deployment does:
    // the code ships, the column appears, the catalogue has not moved yet.
    const applied = migrate(scratch);
    if (applied.code !== 0) throw new Error(`migrating the legacy shape failed: ${applied.output}`);
    dumpDatabase(scratch, LEGACY_SQL);
  } finally {
    dropDatabase(scratch);
  }
}

function buildFreshSql(): void {
  const scratch = uniqueName("build_fresh");
  recreateDatabase(scratch);
  try {
    const migrated = migrate(scratch);
    if (migrated.code !== 0) throw new Error(`migrate failed: ${migrated.output}`);
    const seeded = seed(scratch);
    if (seeded.code !== 0) throw new Error(`seed failed: ${seeded.output}`);
    dumpDatabase(scratch, FRESH_SQL);
  } finally {
    dropDatabase(scratch);
  }
}

let legacyReady = false;
let freshReady = false;

export function legacySql(): string {
  if (!legacyReady) {
    if (!existsSync(LEGACY_SQL) || process.env.REBUILD_FIXTURES) buildLegacySql();
    legacyReady = true;
  }
  return LEGACY_SQL;
}

export function freshSql(): string {
  if (!freshReady) {
    if (!existsSync(FRESH_SQL) || process.env.REBUILD_FIXTURES) buildFreshSql();
    freshReady = true;
  }
  return FRESH_SQL;
}

/** A database holding the pre-restructure catalogue, with this branch's schema. */
export function giveLegacy(label = "legacy"): string {
  const name = uniqueName(label);
  restoreDatabase(name, legacySql());
  return name;
}

/** A database seeded from this branch on empty — the restructured catalogue. */
export function giveFresh(label = "fresh"): string {
  const name = uniqueName(label);
  restoreDatabase(name, freshSql());
  return name;
}

/** An empty database with the schema applied and nothing in it. */
export function giveEmpty(label = "empty"): string {
  const name = uniqueName(label);
  recreateDatabase(name);
  const migrated = migrate(name);
  if (migrated.code !== 0) throw new Error(`migrate failed: ${migrated.output}`);
  return name;
}

/** A database that has been through the cutover. */
export function giveRestructured(label = "cutover"): string {
  const name = giveLegacy(label);
  const result = runScript("scripts/restructure.ts", name);
  if (result.code !== 0) throw new Error(`restructure failed: ${result.output}`);
  return name;
}

export { LEGACY_SQL, FRESH_SQL, WORK };
