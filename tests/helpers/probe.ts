/**
 * Runs a piece of the application's own server code against a test database.
 *
 * Most of `src/lib` is marked `server-only`, and that marker package throws the
 * moment it is imported without React's `react-server` export condition — which
 * is exactly what it is for. So a test that wants to drive `lib/versions.ts` or
 * `lib/db/revision.ts` against a real database cannot simply import them; it has
 * to run them the way the server runs them. `tsx --conditions=react-server` is
 * that, and nothing in between is mocked: the real module, the real driver, a
 * real database.
 *
 * The snippet reports back by calling `emit(value)`, which prints one marked
 * line. Everything else a subprocess might say — a driver notice, a warning —
 * is ignored rather than parsed.
 *
 * Written as `.mts`: the repository is CommonJS by default, and a probe reads
 * far better with its awaits at the top level than wrapped in a `main()` that
 * exists only to satisfy the module format.
 */
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { REPO_ROOT, dbUrl, scriptEnv } from "./env";

const DIR = path.join(REPO_ROOT, ".data", "test", "probes");
const MARK = "__probe__ ";

/** Injected above every snippet, so a probe never has to repeat the plumbing. */
const PREAMBLE = `const emit = (value: unknown) => console.log(${JSON.stringify(MARK)} + JSON.stringify(value));\n`;

export type ProbeResult = { code: number; stdout: string; stderr: string; output: string };

export function probe(database: string, source: string): ProbeResult {
  mkdirSync(DIR, { recursive: true });
  const file = path.join(DIR, `p_${randomBytes(6).toString("hex")}.mts`);
  writeFileSync(file, PREAMBLE + source, "utf8");
  try {
    const result = spawnSync("npx", ["tsx", "--conditions=react-server", file], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: scriptEnv(dbUrl(database)),
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    return { code: result.status ?? -1, stdout, stderr, output: `${stdout}\n${stderr}` };
  } finally {
    rmSync(file, { force: true });
  }
}

/** Every value the snippet emitted, in order. Throws with the output if it failed. */
export function probeValues<T>(database: string, source: string): T[] {
  const result = probe(database, source);
  if (result.code !== 0) throw new Error(`probe failed (${result.code}):\n${result.output}`);
  return result.stdout
    .split("\n")
    .filter((line) => line.startsWith(MARK))
    .map((line) => JSON.parse(line.slice(MARK.length)) as T);
}

/** The single value a one-answer probe emitted. */
export function probeValue<T>(database: string, source: string): T {
  const values = probeValues<T>(database, source);
  if (values.length !== 1) throw new Error(`expected one emit, got ${values.length}`);
  return values[0]!;
}
