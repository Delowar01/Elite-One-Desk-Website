/**
 * Removes what a test run can leave behind when it is killed before its own
 * teardown runs: test databases and staged server trees.
 *
 *   npm run test:cleanup              list what would go
 *   npm run test:cleanup -- --yes     drop it
 *
 * Only ever databases named `eodt_*` on the server `TEST_PG_URL` names — the
 * same guard every test helper uses — and only `.data/test/servers`. Stop
 * every test run first: a database another run is using is dropped with it.
 * The cached fixture dumps (`.data/test/*.sql`) stay; `REBUILD_FIXTURES=1`
 * is what rebuilds those.
 */
import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

import { PG_BASE, PREFIX, REPO_ROOT } from "./helpers/env";
import { dropDatabase } from "./helpers/pg";

const listed = spawnSync(
  "psql",
  [`${PG_BASE}/postgres`, "-At", "-c", `select datname from pg_database where datname like '${PREFIX}%' order by 1`],
  { encoding: "utf8" },
);
if (listed.status !== 0) {
  console.error(`could not list databases at TEST_PG_URL: ${listed.stderr.trim()}`);
  process.exit(1);
}
const names = listed.stdout.split("\n").map((line) => line.trim()).filter((name) => name.startsWith(PREFIX));
const servers = path.join(REPO_ROOT, ".data", "test", "servers");

if (!process.argv.includes("--yes")) {
  console.log(`${names.length} test database(s): ${names.join(", ") || "none"}`);
  console.log(`staged server trees under ${path.relative(REPO_ROOT, servers)}`);
  console.log("nothing removed — run again with --yes to remove them");
  process.exit(0);
}
for (const name of names) dropDatabase(name);
rmSync(servers, { recursive: true, force: true });
console.log(`dropped ${names.length} test database(s) and the staged server trees`);
