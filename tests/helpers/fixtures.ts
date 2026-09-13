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
import { existsSync, mkdirSync, rmSync, statSync, symlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";

import { LEGACY_REF, REPO_ROOT, compatRef, dbUrl, scriptEnv, uniqueName } from "./env";
import { dropDatabase, dumpDatabase, recreateDatabase, restoreDatabase } from "./pg";
import { migrate, runScript, seed } from "./run";

const WORK = path.join(REPO_ROOT, ".data", "test");
const LEGACY_TREE = path.join(WORK, "legacy-tree");
const LEGACY_SQL = path.join(WORK, "legacy.sql");
const FRESH_SQL = path.join(WORK, "fresh.sql");
const COMPAT_TREE = path.join(WORK, "compat-tree");

const sh = (cmd: string, args: string[], cwd = REPO_ROOT) => {
  const result = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
};

/** A checkout of some earlier commit, sharing this one's node_modules. */
function ensureTree(ref: string, dir: string): string {
  if (existsSync(path.join(dir, "package.json"))) return dir;
  mkdirSync(WORK, { recursive: true });
  rmSync(dir, { recursive: true, force: true });
  sh("git", ["worktree", "prune"]);
  const added = sh("git", ["worktree", "add", "--detach", dir, ref]);
  if (added.status !== 0) throw new Error(`could not check out ${ref}: ${added.stderr}`);
  symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(dir, "node_modules"));
  return dir;
}

/** A checkout of the pre-restructure code. */
const ensureLegacyTree = () => ensureTree(LEGACY_REF, LEGACY_TREE);

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

/**
 * `npm test` runs one process per file, and they start together, so "build it
 * if it is missing" needs a lock across processes rather than a flag inside
 * one. `mkdir` is the lock: it either creates the directory or it does not.
 *
 * `tests/prepare.ts` builds both fixtures before the files run, so in practice
 * nothing waits here. This is what makes running a single file directly safe
 * too.
 */
function withLock(name: string, build: () => void): void {
  const lock = path.join(WORK, `${name}.lock`);
  mkdirSync(WORK, { recursive: true });
  const deadline = Date.now() + 10 * 60_000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      // Held by another process. A lock older than the deadline is stale.
      if (Date.now() > deadline) {
        rmSync(lock, { recursive: true, force: true });
        continue;
      }
      const held = statSync(lock, { throwIfNoEntry: false });
      if (!held) continue;
      spawnSync("sleep", ["0.25"]);
      if (!needsBuild(name)) return;
    }
  }
  try {
    build();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

const fileFor = (name: string) => (name === "legacy" ? LEGACY_SQL : FRESH_SQL);
const needsBuild = (name: string) => !existsSync(fileFor(name));

/**
 * Throws the cached dumps and the legacy checkout away so the next call
 * rebuilds them.
 *
 * Only `tests/prepare.ts` calls it, and deliberately: `npm test` runs one
 * process per file, so a "rebuild" that each of them acted on would have five
 * processes deleting the same worktree while the others were reading it.
 * Rebuilding is a thing the run does once, before the files start.
 */
export function discardFixtures(): void {
  rmSync(LEGACY_SQL, { force: true });
  rmSync(FRESH_SQL, { force: true });
  rmSync(LEGACY_TREE, { recursive: true, force: true });
  rmSync(COMPAT_TREE, { recursive: true, force: true });
}

function ensure(name: "legacy" | "fresh"): string {
  if (needsBuild(name)) {
    withLock(name, name === "legacy" ? buildLegacySql : buildFreshSql);
  }
  return fileFor(name);
}

export const legacySql = () => ensure("legacy");
export const freshSql = () => ensure("fresh");

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

/** The checkout of `LEGACY_REF`, for tests that need the pre-restructure code. */
export function legacyTree(): string {
  legacySql(); // builds the worktree if it is not there yet
  return ensureLegacyTree();
}

/**
 * A checkout of the release currently in production — the one a new migration
 * has to stay readable by. Deliberately a different worktree from `legacyTree`:
 * one is a fixed historical fixture, the other moves with every release.
 */
export function compatTree(): string {
  return ensureTree(compatRef(), COMPAT_TREE);
}

export { LEGACY_SQL, FRESH_SQL, WORK, LEGACY_TREE, COMPAT_TREE };
