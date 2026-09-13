/** Thin wrappers over the postgres command line and the app's own driver. */
import { spawnSync } from "node:child_process";

import postgres from "postgres";

import { PG_BASE, assertTestDatabase, dbUrl } from "./env";

const run = (cmd: string, args: string[], input?: string) => {
  const result = spawnSync(cmd, args, { encoding: "utf8", input, maxBuffer: 64 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
};

const maintenance = `${PG_BASE}/postgres`;

export function recreateDatabase(name: string): void {
  assertTestDatabase(name);
  run("psql", [maintenance, "-v", "ON_ERROR_STOP=1", "-c", `drop database if exists "${name}" with (force)`]);
  const created = run("psql", [maintenance, "-v", "ON_ERROR_STOP=1", "-c", `create database "${name}"`]);
  if (created.status !== 0) throw new Error(`could not create ${name}: ${created.stderr}`);
}

/**
 * Retried, and checked.
 *
 * `with (force)` terminates other sessions, but a subprocess the test spawned
 * may still be on its way out when teardown runs, and a drop that loses that
 * race used to fail silently and leave a database behind for the next run to
 * trip over.
 */
export function dropDatabase(name: string): void {
  assertTestDatabase(name);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const dropped = run("psql", [
      maintenance,
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `drop database if exists "${name}" with (force)`,
    ]);
    if (dropped.status === 0) return;
    spawnSync("sleep", ["0.3"]);
  }
  console.warn(`[tests] could not drop ${name}; drop it by hand`);
}

export function dumpDatabase(name: string, file: string): void {
  assertTestDatabase(name);
  const result = run("pg_dump", [dbUrl(name), "--no-owner", "--no-privileges", "-f", file]);
  if (result.status !== 0) throw new Error(`pg_dump ${name} failed: ${result.stderr}`);
}

/** A data-only dump, for proving a dry run wrote nothing. */
export function dumpData(name: string): string {
  assertTestDatabase(name);
  const result = run("pg_dump", [dbUrl(name), "--data-only", "--no-owner", "--no-privileges"]);
  if (result.status !== 0) throw new Error(`pg_dump ${name} failed: ${result.stderr}`);
  // pg_dump stamps each file with a random \restrict token, and sequences are
  // non-transactional in PostgreSQL — a rolled-back INSERT still consumes an
  // id. Neither is data, so neither is compared.
  return result.stdout
    .split("\n")
    .filter((line) => !/^\\(un)?restrict /.test(line) && !line.includes("pg_catalog.setval"))
    .join("\n");
}

export function restoreDatabase(name: string, file: string): void {
  recreateDatabase(name);
  const result = run("psql", [dbUrl(name), "-v", "ON_ERROR_STOP=1", "-q", "-f", file]);
  if (result.status !== 0) throw new Error(`restore into ${name} failed: ${result.stderr}`);
}

/** Opens a short-lived client. Callers must close it — every test does, in its teardown. */
export function connect(name: string) {
  assertTestDatabase(name);
  return postgres(dbUrl(name), { max: 2, prepare: false, onnotice: () => {} });
}

export type Sql = ReturnType<typeof connect>;

/**
 * postgres.js hands back a `Result`, an Array subclass. `deepStrictEqual`
 * compares prototypes, so a row list is flattened to plain objects before it is
 * compared against a literal.
 */
export const plain = <T extends object>(rows: readonly T[]): T[] => rows.map((row) => ({ ...row }));

export async function count(sql: Sql, table: string, where = "true"): Promise<number> {
  const rows = await sql.unsafe<{ n: number }[]>(
    `select count(*)::int as n from ${table} where ${where}`,
  );
  return rows[0]!.n;
}
