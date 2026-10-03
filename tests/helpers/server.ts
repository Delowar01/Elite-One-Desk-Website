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
import { existsSync, mkdirSync, rmSync } from "node:fs";
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
 *
 * **Staging writes nothing another server reads (19C).** `output: standalone`
 * ships neither the static chunks nor `public/`, and this used to copy both
 * *into* the shared `.next/standalone` before linking it. But `cpSync` onto an
 * existing file truncates that inode and rewrites it, and every server already
 * running serves those very inodes through its hard links: with three servers
 * restarting at once, 0.8% of concurrent reads of a chunk found it empty, a
 * browser was handed a chunk that loaded and installed nothing ("Loading chunk
 * … failed (missing …)"), and a stress script's next click waited out its
 * timeout. Now each tree links the build's own chunks and `public/` beside its
 * own copy of the server, and the shared trees are never written.
 */
export function stageServer(port: number, reuse: boolean): string {
  const root = path.join(SERVERS, String(port));
  if (reuse && existsSync(path.join(root, "server.js"))) return root;
  rmSync(root, { recursive: true, force: true });
  mkdirSync(SERVERS, { recursive: true });
  const link = (from: string, to: string) => {
    const copied = spawnSync("cp", ["-al", from, to], { encoding: "utf8" });
    if (copied.status !== 0) throw new Error(`could not stage a server tree: ${copied.stderr}`);
  };
  link(STANDALONE, root);
  // Whatever the shared tree holds in these places — copies an earlier version
  // of this helper made, a cache — is this tree's own links, dropped here; the
  // shared files themselves are not touched.
  for (const own of [path.join(root, ".next", "static"), path.join(root, "public"), path.join(root, ".next", "cache")]) {
    rmSync(own, { recursive: true, force: true });
  }
  link(path.join(REPO_ROOT, ".next", "static"), path.join(root, ".next", "static"));
  link(path.join(REPO_ROOT, "public"), path.join(root, "public"));
  return root;
}

/** One line of a server's output, with the moment it arrived (Batch 21A). */
export type ServerLine = { at: number; stream: "out" | "err"; text: string };

/** How a server process ended, and whether `stop` was what ended it. */
export type ServerExit = { at: number; code: number | null; signal: NodeJS.Signals | null; requested: boolean };

/** The most lines a server keeps for `lines()`; `log()` keeps everything, as before. */
export const SERVER_LINES_KEPT = 5_000;

export type Server = {
  origin: string;
  stop: () => Promise<void>;
  /** Everything the server has written to stdout/stderr, for a failure message. */
  log: () => string;
  /**
   * The same output line by line, each with the time it arrived, so a failure
   * in the browser can be printed beside what the server said in the seconds
   * around it (Batch 21A: a stress failure whose server output was lost).
   */
  lines: () => readonly ServerLine[];
  /** The process id, and how the process ended — null while it runs. */
  pid: number | undefined;
  exit: () => ServerExit | null;
};

/**
 * Splits a child's output into timestamped lines as it arrives. A partial line
 * waits for its end; `end` flushes whatever is left when the streams close.
 */
export function lineCollector(keep = SERVER_LINES_KEPT, now: () => number = Date.now) {
  const lines: ServerLine[] = [];
  const pending: Record<ServerLine["stream"], string> = { out: "", err: "" };
  const push = (stream: ServerLine["stream"], text: string) => {
    lines.push({ at: now(), stream, text });
    if (lines.length > keep) lines.splice(0, lines.length - keep);
  };
  return {
    lines: (): readonly ServerLine[] => lines,
    write(stream: ServerLine["stream"], chunk: Buffer | string) {
      const parts = (pending[stream] + chunk.toString()).split("\n");
      pending[stream] = parts.pop() ?? "";
      for (const part of parts) push(stream, part.replace(/\r$/, ""));
    },
    end() {
      for (const stream of ["out", "err"] as const) {
        if (pending[stream]) push(stream, pending[stream]);
        pending[stream] = "";
      }
    },
  };
}

/**
 * What a test keeps of a child process: its whole output (`log`), the same
 * output line by line with times (`lines`), and how it ended (`exit`) — with
 * whether the test asked it to, which `stopping` records just before the test
 * ends the process itself. A process that ends by any other route is a crash.
 */
export function watchProcess(child: ChildProcess) {
  let log = "";
  const collected = lineCollector();
  let stopping = false;
  let exited: ServerExit | null = null;
  child.stdout?.on("data", (chunk: Buffer) => {
    log += chunk;
    collected.write("out", chunk);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    log += chunk;
    collected.write("err", chunk);
  });
  child.once("exit", (code, signal) => {
    exited = { at: Date.now(), code, signal, requested: stopping };
  });
  child.once("close", () => collected.end());
  return {
    log: () => log,
    lines: collected.lines,
    exit: () => exited,
    stopping: () => {
      stopping = true;
    },
  };
}

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

  const watched = watchProcess(child);

  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`the server exited early:\n${watched.log()}`);
    try {
      const response = await fetch(`${origin}/`, { redirect: "manual" });
      if (response.status < 500) {
        await response.arrayBuffer();
        break;
      }
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline) throw new Error(`the server never became ready:\n${watched.log()}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  return {
    origin,
    log: watched.log,
    lines: watched.lines,
    pid: child.pid,
    exit: watched.exit,
    stop: () =>
      new Promise<void>((resolve) => {
        // A process a signal killed has no exit code, only a signal; waiting
        // for a `close` that has already happened would hang the script and
        // hide the very exit a stress run needs to report (Batch 21A).
        if (child.exitCode !== null || child.signalCode !== null) return resolve();
        watched.stopping();
        child.once("close", () => resolve());
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
      }),
  };
}

/** A free port, chosen per test file so two files can run at once. */
export const portFor = (offset: number) => 3400 + offset;
