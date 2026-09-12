/** Runs one of the repository's own `tsx` scripts against a named database. */
import { spawnSync } from "node:child_process";

import { REPO_ROOT, dbUrl, scriptEnv, type EnvBlock } from "./env";

export type ScriptResult = { code: number; stdout: string; stderr: string; output: string };

export function runScript(
  script: string,
  database: string,
  args: string[] = [],
  extraEnv: EnvBlock = {},
): ScriptResult {
  const result = spawnSync("npx", ["tsx", script, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: scriptEnv(dbUrl(database), extraEnv),
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return { code: result.status ?? -1, stdout, stderr, output: `${stdout}\n${stderr}` };
}

export const migrate = (database: string) => runScript("scripts/migrate.ts", database);
export const seed = (database: string, extraEnv: EnvBlock = {}) =>
  runScript("scripts/seed.ts", database, [], extraEnv);
export const restructure = (
  database: string,
  args: string[] = [],
  extraEnv: EnvBlock = {},
) => runScript("scripts/restructure.ts", database, args, extraEnv);

export { REPO_ROOT };
