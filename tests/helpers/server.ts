/**
 * Runs the built application the way production does — `.next/standalone`,
 * NODE_ENV=production — against a named test database.
 *
 * The cache tests need the real thing rather than `next dev`: the tagged data
 * cache only behaves like production in a production build, and a proof that
 * `revalidateTag` clears it has to be made against the cache that actually
 * serves visitors.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

import { REPO_ROOT, dbUrl, scriptEnv } from "./env";

const STANDALONE = path.join(REPO_ROOT, ".next", "standalone");
const SERVER_JS = path.join(STANDALONE, "server.js");
const SERVERS = path.join(REPO_ROOT, ".data", "test", "servers");

export const isBuilt = () => existsSync(SERVER_JS);

export const BUILD_HINT =
  "no production build found — run `npm run build` before the server tests";

/**
 * Each server gets its own copy of the built tree.
 *
 * Not fussiness: `unstable_cache` persists to `<distDir>/cache/fetch-cache` on
 * disk, and its keys are the loader's own — not the database's. Two servers
 * started from one directory therefore share one cache and answer each other's
 * questions, and a restart does not clear it either. (That last part is why the
 * cutover needs the refresh button rather than a `systemctl restart`.)
 *
 * Hard links, so a copy of the whole `node_modules` tree costs almost nothing;
 * every file here is read-only to the server.
 */
function stageServer(port: number, reuse: boolean): string {
  const root = path.join(SERVERS, String(port));
  if (reuse && existsSync(path.join(root, "server.js"))) return root;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(SERVERS, { recursive: true });
  // `output: standalone` copies neither the static chunks nor `public/`.
  cpSync(path.join(REPO_ROOT, ".next", "static"), path.join(STANDALONE, ".next", "static"), {
    recursive: true,
  });
  cpSync(path.join(REPO_ROOT, "public"), path.join(STANDALONE, "public"), { recursive: true });
  rmSync(path.join(STANDALONE, ".next", "cache"), { recursive: true, force: true });

  const copied = spawnSync("cp", ["-al", STANDALONE, root], { encoding: "utf8" });
  if (copied.status !== 0) throw new Error(`could not stage a server tree: ${copied.stderr}`);
  return root;
}

export type Server = {
  origin: string;
  stop: () => Promise<void>;
  /** Everything the server has written to stdout/stderr, for a failure message. */
  log: () => string;
};

export async function startServer(
  database: string,
  port: number,
  options: { reuse?: boolean } = {},
): Promise<Server> {
  if (!isBuilt()) throw new Error(BUILD_HINT);
  // `reuse` keeps the staged tree — and with it the on-disk cache — across a
  // restart, which is the point of the test that restarts.
  const root = stageServer(port, options.reuse ?? false);

  const origin = `http://127.0.0.1:${port}`;
  const child: ChildProcess = spawn("node", [path.join(root, "server.js")], {
    cwd: root,
    env: scriptEnv(dbUrl(database), {
      NODE_ENV: "production",
      PORT: String(port),
      HOSTNAME: "127.0.0.1",
      NEXT_PUBLIC_SITE_URL: origin,
    }),
  });

  let log = "";
  child.stdout?.on("data", (chunk) => (log += chunk));
  child.stderr?.on("data", (chunk) => (log += chunk));

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the server exited early:\n${log}`);
    try {
      const response = await fetch(`${origin}/`, { redirect: "manual" });
      if (response.status < 500) {
        await response.arrayBuffer();
        break;
      }
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`the server never became ready:\n${log}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return {
    origin,
    log: () => log,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("close", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      }),
  };
}

/** A free port, chosen per test file so two files can run at once. */
export const portFor = (offset: number) => 3400 + offset;
