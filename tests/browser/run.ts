/**
 * Runs the tracked browser probes — or the stress suite — and says, for every
 * run, whether it was clean.
 *
 *   npm run test:browser                                   every probe, once
 *   npm run test:browser -- --only hardening,motion-15b    just those
 *   npm run test:browser -- --only permissions --repeat 10
 *   npm run test:stress                                    every stress script, once
 *   npm run test:browser -- --list                         what exists, and what it expects
 *
 * A run is clean when the script exits 0, prints no `FAIL` line, and prints
 * exactly the number of `PASS` lines `expected.json` records for it. The count
 * is part of the contract on purpose: a probe that stops early, or loses an
 * assertion in an edit, prints fewer PASS lines and no FAIL at all, and that
 * must not read as green.
 *
 * Nothing is retried. A run that fails is reported as failed, with its log;
 * deciding that a failure was "only" the infrastructure is a judgement a person
 * makes with the log in front of them, not something this file does quietly.
 *
 * Preconditions, checked rather than assumed: a production build (`npm run
 * build`), a reachable PostgreSQL named by `TEST_PG_URL`, and the fixture dumps,
 * which this runner builds with `tests/prepare.ts` before the first probe.
 * Logs and a JSON summary are written under `.data/test/results/<suite>/`.
 */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { diagnosticCollector } from "../helpers/diagnostics";
import { PG_BASE, REPO_ROOT } from "../helpers/env";
import { BUILD_HINT, isBuilt } from "../helpers/server";

type Suite = { name: string; dir: string; suffix: string };
const SUITES: Record<string, Suite> = {
  browser: { name: "browser", dir: path.join(REPO_ROOT, "tests", "browser", "probes"), suffix: ".probe.mts" },
  stress: { name: "stress", dir: path.join(REPO_ROOT, "tests", "stress"), suffix: ".stress.mts" },
};

function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  return value && !value.startsWith("--") ? value : "";
}

const suite = SUITES[arg("suite") || "browser"];
if (!suite) {
  console.error(`unknown suite — choose one of: ${Object.keys(SUITES).join(", ")}`);
  process.exit(2);
}
const repeat = Math.max(1, Number(arg("repeat") || 1));
const only = (arg("only") || "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
const timeoutMs = Math.max(1, Number(arg("timeout-min") || 25)) * 60_000;
const expectedFile = path.join(suite.dir, "expected.json");
const expected: Record<string, number> = existsSync(expectedFile)
  ? (JSON.parse(readFileSync(expectedFile, "utf8")) as Record<string, number>)
  : {};

const available = readdirSync(suite.dir)
  .filter((file) => file.endsWith(suite.suffix))
  .map((file) => file.slice(0, -suite.suffix.length))
  .sort();

if (process.argv.includes("--list")) {
  for (const name of available) console.log(`${name.padEnd(24)} expects ${expected[name] ?? "?"} PASS`);
  process.exit(0);
}

const unknown = only.filter((name) => !available.includes(name));
if (unknown.length) {
  console.error(`no such ${suite.name} script: ${unknown.join(", ")}`);
  process.exit(2);
}
const chosen = only.length ? only : available;
const missing = chosen.filter((name) => expected[name] === undefined);
if (missing.length) {
  console.error(`${path.relative(REPO_ROOT, expectedFile)} records no PASS count for: ${missing.join(", ")}`);
  process.exit(2);
}

if (!isBuilt()) {
  console.error(BUILD_HINT);
  process.exit(2);
}

// The fixtures every probe restores its database from: built once, here, so
// the first probe does not pay for them inside its own timeout.
if (!process.argv.includes("--no-prepare")) {
  const prepared = spawnSync(process.execPath, ["--import", "tsx", path.join("tests", "prepare.ts")], {
    cwd: REPO_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (prepared.status !== 0) {
    console.error("preparing the fixtures failed — is PostgreSQL reachable at TEST_PG_URL?");
    process.exit(1);
  }
}

const out = path.join(REPO_ROOT, ".data", "test", "results", suite.name);
mkdirSync(out, { recursive: true });

type Run = {
  name: string;
  run: number;
  pass: number;
  fail: number;
  exit: number | null;
  timedOut: boolean;
  seconds: number;
  clean: boolean;
  failures: string[];
  /** A script's own `diag summary`, and for an unclean run its `diag` lines (Batch 21A). */
  diag: string[];
  diagSummary: string | null;
  log: string;
};

function runOnce(name: string, run: number): Promise<Run> {
  const file = path.join(suite.dir, `${name}${suite.suffix}`);
  const log = path.join(out, repeat > 1 ? `${name}.${run}.log` : `${name}.log`);
  const sink = createWriteStream(log);
  const started = Date.now();
  let pass = 0;
  let fail = 0;
  const failures: string[] = [];
  /** The last lines that were neither PASS nor FAIL — a stack trace, when a script dies. */
  const tail: string[] = [];
  const diag = diagnosticCollector();
  let pending = "";
  const read = (chunk: Buffer) => {
    sink.write(chunk);
    pending += chunk.toString("utf8");
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (line.startsWith("PASS")) pass += 1;
      else if (line.startsWith("FAIL")) {
        fail += 1;
        failures.push(line);
      } else if (diag.take(line)) {
        continue;
      } else if (line.trim()) {
        tail.push(line);
        if (tail.length > 12) tail.shift();
      }
    }
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", file], { cwd: REPO_ROOT, env: process.env });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.on("close", (code) => {
      clearTimeout(timer);
      read(Buffer.from("\n"));
      sink.end();
      const seconds = Math.round((Date.now() - started) / 1000);
      const clean = !timedOut && code === 0 && fail === 0 && pass === expected[name];
      // A script that died — an exception, a timeout — printed no FAIL line, and
      // said why only in its log, which a CI job keeps in an artifact. The end of
      // its output goes into the summary instead, so the job log shows the reason
      // (19C: the first candidate's Stress run lost a script without a word).
      const reasons = !clean && fail === 0 ? tail.map((line) => `| ${line}`) : failures;
      resolve({
        name,
        run,
        pass,
        fail,
        exit: code,
        timedOut,
        seconds,
        clean,
        failures: reasons,
        diag: diag.report(clean),
        diagSummary: diag.summary(),
        log: path.relative(REPO_ROOT, log),
      });
    });
  });
}

async function main(): Promise<number> {
  console.log(`· ${suite.name}: ${chosen.length} script(s) × ${repeat} against ${PG_BASE.replace(/\/\/[^@/]*@/, "//***@")}`);
  const runs: Run[] = [];
  for (const name of chosen) {
    for (let run = 1; run <= repeat; run += 1) {
      const result = await runOnce(name, run);
      runs.push(result);
      const why = result.clean
        ? ""
        : result.timedOut
          ? "  TIMED OUT"
          : result.exit !== 0
            ? `  exit ${result.exit}`
            : result.fail
              ? ""
              : `  expected ${expected[name]} PASS`;
      console.log(
        `${result.clean ? "clean  " : "UNCLEAN"} ${name}${repeat > 1 ? ` #${run}` : ""}  PASS=${result.pass} FAIL=${result.fail}  ${result.seconds}s${why}`,
      );
      for (const line of result.failures.slice(0, 12)) console.log(`        ${line}`);
      // What the script recorded about itself (create-navigation, 21A): its summary
      // on every run, and on an unclean one each incident, here in the job log.
      for (const line of result.diag) console.log(`        ${line}`);
      if (!result.clean) console.log(`        log: ${result.log}`);
    }
  }

  const unclean = runs.filter((run) => !run.clean);
  const totals = {
    suite: suite.name,
    scripts: chosen.length,
    runs: runs.length,
    clean: runs.length - unclean.length,
    pass: runs.reduce((sum, run) => sum + run.pass, 0),
    fail: runs.reduce((sum, run) => sum + run.fail, 0),
  };
  writeFileSync(path.join(out, "summary.json"), JSON.stringify({ ...totals, runs }, null, 2));
  console.log(
    `\n${suite.name}: ${totals.clean}/${totals.runs} runs clean · ${totals.pass} PASS · ${totals.fail} FAIL` +
      (unclean.length ? ` · unclean: ${[...new Set(unclean.map((run) => run.name))].join(", ")}` : ""),
  );
  return unclean.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
