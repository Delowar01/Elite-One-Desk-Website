/**
 * Batch 19C: `deploy/deploy.sh` releases the commit it was told to — and
 * nothing else, however the branch moves.
 *
 * It used to read its target from `origin/${BRANCH}` after the fetch, so the
 * commit a release deployed was whatever had been pushed last, not the commit
 * somebody had approved. `RELEASE_SHA` names the commit; these tests hold the
 * rules around it.
 *
 * The script is run for real — this repository's own file, start to finish —
 * against throwaway fixtures: a bare git "origin", a production checkout
 * cloned from it, an APP_ROOT with a live runtime marked with the commit it
 * was built from, and a backups folder. The five things that would reach
 * outside the test are replaced on PATH by stand-ins that only record what
 * they were asked: `systemctl` (a unit whose state is a file), `sudo` (runs
 * the command as the caller), `curl` (answers 200), `npm` (records the command
 * and the commit it ran at, and lays down a runtime for `run build`) and the
 * backup command (writes one empty dump). No service, network, database or
 * real path is touched, and nothing is deployed anywhere.
 *
 *   1  no RELEASE_SHA: the tip of origin/main, as before
 *   2  a full sha: exactly that commit, though main is ahead of it
 *   3  an abbreviation is refused, before anything is fetched
 *   4  a malformed value is refused, before anything is fetched
 *   5  a well-formed sha naming nothing is refused after the fetch
 *   6  a commit that is not on origin/main — on another branch, local only,
 *      or a tree rather than a commit — is refused
 *   7  the runtime is marked with exactly the release
 *   8  the production checkout is moved to exactly the release
 *   9  a push that lands mid-release does not change what it deploys
 *  10  no revision syntax reaches git — and the script resolves its target once
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, test } from "node:test";

import { REPO_ROOT } from "./helpers/env";

const DEPLOY = path.join(REPO_ROOT, "deploy", "deploy.sh");
const SOURCE = readFileSync(DEPLOY, "utf8");
const roots: string[] = [];

after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@test.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@test.invalid",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...GIT_ENV } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${result.stderr}`);
  return result.stdout.trim();
}

function script(file: string, body: string) {
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
}

type Fixture = {
  root: string;
  origin: string;
  dev: string;
  app: string;
  appRoot: string;
  bin: string;
  /** Commits on origin/main, oldest first: A is what production runs. */
  shas: { A: string; B: string; C: string };
  commit: (message: string, branch?: string) => string;
  canary: string;
};

/**
 * origin/main is A → B → C. Production was cloned when main was A, has never
 * fetched since, and runs a runtime marked A — so `refs/remotes/origin/main`
 * in the checkout still says A until the script itself fetches.
 */
function fixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "eod-deploy-"));
  roots.push(root);
  const origin = path.join(root, "origin.git");
  const dev = path.join(root, "dev");
  const appRoot = path.join(root, "www");
  const app = path.join(appRoot, "app");
  const bin = path.join(root, "bin");
  mkdirSync(bin);
  mkdirSync(path.join(root, "tmp"));
  mkdirSync(path.join(root, "backups"));

  git(root, "init", "--quiet", "--bare", "--initial-branch=main", origin);
  git(root, "clone", "--quiet", origin, dev);
  git(dev, "checkout", "--quiet", "-b", "main");
  writeFileSync(path.join(dev, ".gitignore"), ".env\n.next/\nnode_modules/\n");
  mkdirSync(path.join(dev, "public"));
  let counter = 0;
  const commit = (message: string, branch = "main") => {
    counter += 1;
    if (git(dev, "symbolic-ref", "--short", "HEAD") !== branch) git(dev, "checkout", "--quiet", branch);
    writeFileSync(path.join(dev, "public", "release.txt"), `${message} ${counter}\n`);
    git(dev, "add", "-A");
    git(dev, "commit", "--quiet", "-m", message);
    git(dev, "push", "--quiet", "origin", branch);
    return git(dev, "rev-parse", "HEAD");
  };
  const A = commit("A — what production runs");
  git(root, "clone", "--quiet", "--branch", "main", origin, app);
  const B = commit("B — the approved release");
  const C = commit("C — pushed after the approval");

  writeFileSync(path.join(app, ".env"), "DATABASE_URL=postgresql://fixture.invalid/never-read\n");
  mkdirSync(path.join(app, ".next", "standalone"), { recursive: true });
  writeFileSync(path.join(app, ".next", "standalone", "server.js"), "// the live runtime\n");
  writeFileSync(path.join(app, ".next", "standalone", ".eod-release-sha"), `${A}\n`);

  // The stand-ins. Each one only records, and none reaches outside `root`.
  script(
    path.join(bin, "systemctl"),
    `state="${root}/unit.state"
echo "systemctl $*" >> "${root}/calls.log"
case "$1" in
  cat) exit 0 ;;
  stop) echo inactive > "$state" ;;
  start) echo active > "$state" ;;
  is-active)
    current="$(cat "$state" 2>/dev/null || echo active)"
    [[ "$2" == "--quiet" ]] || echo "$current"
    [[ "$current" == active ]] ;;
  *) exit 0 ;;
esac`,
  );
  script(
    path.join(bin, "sudo"),
    `echo "sudo $*" >> "${root}/calls.log"
while [[ $# -gt 0 ]]; do
  case "$1" in -n|-H) shift ;; -u) shift 2 ;; *) break ;; esac
done
exec "$@"`,
  );
  script(path.join(bin, "curl"), `echo "curl $*" >> "${root}/calls.log"\nprintf 200`);
  script(
    path.join(bin, "npm"),
    `echo "$(pwd -P) $(git rev-parse HEAD) $*" >> "${root}/npm.log"
if [[ "$*" == "run build" ]]; then
  mkdir -p .next/standalone/.next .next/static
  echo "// built" > .next/standalone/server.js
  echo "chunk" > .next/static/chunk.js
  if [[ -n "\${EOD_TEST_ON_BUILD:-}" ]]; then bash -c "\${EOD_TEST_ON_BUILD}"; fi
fi
exit 0`,
  );
  script(
    path.join(root, "backup.sh"),
    `echo "backup" >> "${root}/calls.log"\necho dump | gzip > "${root}/backups/db-$(date +%s%N).sql.gz"`,
  );

  return { root, origin, dev, app, appRoot, bin, shas: { A, B, C }, commit, canary: path.join(root, "CANARY") };
}

type Run = { code: number; output: string; npm: string[]; built: string[] };

function deploy(f: Fixture, release?: string, extra: Record<string, string> = {}): Run {
  const env: Record<string, string> = {
    ...GIT_ENV,
    PATH: `${f.bin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: f.root,
    TMPDIR: path.join(f.root, "tmp"),
    LANG: "C.UTF-8",
    APP_ROOT: f.appRoot,
    APP_DIR: f.app,
    APP_USER: spawnSync("id", ["-un"], { encoding: "utf8" }).stdout.trim(),
    APP_GROUP: spawnSync("id", ["-gn"], { encoding: "utf8" }).stdout.trim(),
    SERVICE: "eod-fixture.service",
    BRANCH: "main",
    BACKUP_CMD: path.join(f.root, "backup.sh"),
    BACKUP_DIR: path.join(f.root, "backups"),
    PUBLIC_HOST: "fixture.invalid",
    APP_PORT: "1",
    HEALTH_RETRIES: "1",
    HEALTH_DELAY: "0",
    HTTP_TIMEOUT: "1",
    ...extra,
  };
  if (release !== undefined) env.RELEASE_SHA = release;
  const result = spawnSync("bash", [DEPLOY], {
    cwd: f.root,
    encoding: "utf8",
    // Only what is listed above: nothing from the developer's or the runner's own environment.
    env: env as unknown as NodeJS.ProcessEnv,
    timeout: 120_000,
  });
  const npmLog = path.join(f.root, "npm.log");
  const npm = existsSync(npmLog) ? readFileSync(npmLog, "utf8").trim().split("\n").filter(Boolean) : [];
  // "<dir> <commit> run build" — the commit every build ran at.
  const built = npm.filter((line) => line.endsWith(" run build")).map((line) => line.split(" ")[1]!);
  rmSync(npmLog, { force: true });
  return { code: result.status ?? -1, output: `${result.stdout}\n${result.stderr}`, npm, built };
}

const head = (f: Fixture) => git(f.app, "rev-parse", "HEAD");
const marker = (f: Fixture) => readFileSync(path.join(f.app, ".next", "standalone", ".eod-release-sha"), "utf8");
const trackedTip = (f: Fixture) => git(f.app, "rev-parse", "refs/remotes/origin/main");

/** Refused before anything happened: nothing fetched, built, backed up, stopped or moved. */
function untouched(f: Fixture, run: Run, label: string) {
  assert.notEqual(run.code, 0, `${label}: the script succeeded\n${run.output}`);
  assert.deepEqual(run.npm, [], `${label}: npm ran`);
  assert.equal(head(f), f.shas.A, `${label}: the checkout moved`);
  assert.equal(marker(f), `${f.shas.A}\n`, `${label}: the runtime changed`);
  const calls = existsSync(path.join(f.root, "calls.log")) ? readFileSync(path.join(f.root, "calls.log"), "utf8") : "";
  assert.doesNotMatch(calls, /backup|systemctl (stop|start)/, `${label}: something was backed up, stopped or started`);
}

describe("19C · RELEASE_SHA — the release is the approved commit", () => {
  test("19C · deploy 1. without RELEASE_SHA the tip of origin/main is released, exactly as before", () => {
    const f = fixture();
    const run = deploy(f);
    assert.equal(run.code, 0, run.output);
    assert.equal(head(f), f.shas.C);
    assert.equal(marker(f), `${f.shas.C}\n`);
    assert.deepEqual(run.built, [f.shas.C], "built at the tip");
    assert.match(run.output, /release : <RELEASE_SHA not set>/);
    assert.match(run.output, new RegExp(`target  : ${f.shas.C} \\(the tip of origin/main\\)`));
  });

  test("19C · deploy 2. a full sha releases exactly that commit, though origin/main is ahead of it", () => {
    const f = fixture();
    const run = deploy(f, f.shas.B);
    assert.equal(run.code, 0, run.output);
    assert.equal(trackedTip(f), f.shas.C, "the fetch did see main move on");
    assert.equal(head(f), f.shas.B);
    assert.deepEqual(run.built, [f.shas.B], "the build worktree was at the release");
    assert.match(run.output, new RegExp(`branch  : origin/main fetched, tip ${f.shas.C}`));
    assert.match(run.output, new RegExp(`checkout: ${f.shas.A}`));
    assert.match(run.output, new RegExp(`runtime : ${f.shas.A}`));
    assert.match(run.output, new RegExp(`release : ${f.shas.B}`));
    assert.match(run.output, new RegExp(`target  : ${f.shas.B} \\(RELEASE_SHA\\)`));
    assert.match(run.output, /origin\/main is ahead of the release/);
  });

  test("19C · deploy 3. an abbreviated sha is refused before anything is fetched", () => {
    const f = fixture();
    for (const short of [f.shas.B.slice(0, 7), f.shas.B.slice(0, 12), f.shas.B.slice(0, 39)]) {
      const run = deploy(f, short);
      untouched(f, run, short);
      assert.match(run.output, /RELEASE_SHA must be a full 40-character lowercase commit sha/);
      assert.equal(trackedTip(f), f.shas.A, `${short}: the script fetched`);
    }
  });

  test("19C · deploy 4. a malformed value is refused before anything is fetched", () => {
    const f = fixture();
    const B = f.shas.B;
    for (const bad of [B.toUpperCase(), `${B}0`, ` ${B}`, `${B} `, `${B}\n`, "g".repeat(40), "-".repeat(40), `${B.slice(0, 39)}G`]) {
      const run = deploy(f, bad);
      untouched(f, run, JSON.stringify(bad));
      assert.match(run.output, /RELEASE_SHA must be a full 40-character lowercase commit sha/, JSON.stringify(bad));
      assert.equal(trackedTip(f), f.shas.A, `${JSON.stringify(bad)}: the script fetched`);
    }
  });

  test("19C · deploy 5. a well-formed sha that names nothing is refused after the fetch", () => {
    const f = fixture();
    const run = deploy(f, "0123456789abcdef0123456789abcdef01234567");
    untouched(f, run, "nonexistent");
    assert.match(run.output, /is not in this repository after fetching origin\/main/);
    assert.equal(trackedTip(f), f.shas.C, "it was asked after the fetch");
  });

  test("19C · deploy 6. a commit that is not on origin/main is refused — another branch, a local-only commit, a tree", () => {
    const f = fixture();
    // Pushed to origin, but to a branch the release does not fetch.
    git(f.dev, "checkout", "--quiet", "-b", "feature");
    const feature = f.commit("on a feature branch", "feature");
    const elsewhere = deploy(f, feature);
    untouched(f, elsewhere, "feature branch");
    assert.match(elsewhere.output, /is not in this repository after fetching origin\/main/);

    // In the checkout's object store, but on no branch of origin at all.
    const tree = git(f.app, "rev-parse", "HEAD^{tree}");
    const local = git(f.app, "commit-tree", tree, "-p", f.shas.A, "-m", "made on the server");
    const stray = deploy(f, local);
    untouched(f, stray, "local-only commit");
    assert.match(stray.output, /is not on origin\/main \(it is not an ancestor of /);

    // An object that is not a commit at all.
    const treeOfB = git(f.app, "rev-parse", `${f.shas.B}^{tree}`);
    const notCommit = deploy(f, treeOfB);
    untouched(f, notCommit, "tree");
    assert.match(notCommit.output, /names a tree, not a commit/);
  });

  test("19C · deploy 7. the runtime is marked with exactly the release, and the one it replaced keeps its own mark", () => {
    const f = fixture();
    const run = deploy(f, f.shas.B);
    assert.equal(run.code, 0, run.output);
    assert.equal(marker(f), `${f.shas.B}\n`);
    const kept = spawnSync("bash", ["-c", `cat "${f.appRoot}"/standalone.rollback-*/.eod-release-sha`], { encoding: "utf8" });
    assert.equal(kept.stdout, `${f.shas.A}\n`, "the rollback runtime is still marked A");
    assert.match(run.output, new RegExp(`deployed sha  : ${f.shas.B} \\(RELEASE_SHA\\)`));
    assert.match(run.output, new RegExp(`runtime marker: ${f.shas.B}`));
    assert.match(run.output, new RegExp(`requested     : ${f.shas.B}`));
  });

  test("19C · deploy 8. the production checkout is moved to exactly the release — even with no local branch to start from", () => {
    const f = fixture();
    const run = deploy(f, f.shas.B);
    assert.equal(run.code, 0, run.output);
    assert.equal(head(f), f.shas.B);
    assert.equal(git(f.app, "rev-parse", "refs/heads/main"), f.shas.B, "the local branch is the release");
    assert.equal(git(f.app, "symbolic-ref", "HEAD"), "refs/heads/main");
    assert.equal(git(f.app, "status", "--porcelain"), "", "nothing left over in the tree");
    assert.match(run.output, new RegExp(`checkout      : ${f.shas.B}`));

    // A checkout on a detached HEAD with no local main: the old script's
    // `git checkout main` would have made main from origin/main — C — first.
    const g = fixture();
    git(g.app, "checkout", "--quiet", "--detach", g.shas.A);
    git(g.app, "branch", "--quiet", "-D", "main");
    const fresh = deploy(g, g.shas.B);
    assert.equal(fresh.code, 0, fresh.output);
    assert.equal(head(g), g.shas.B);
    assert.equal(git(g.app, "rev-parse", "refs/heads/main"), g.shas.B);
  });

  test("19C · deploy 9. a push that lands mid-release changes nothing about what it deploys", () => {
    // While the build runs, D is pushed to main and fetched into the checkout:
    // origin/main moves under the release. Any later step reading it would
    // pick D up.
    for (const release of ["B", undefined] as const) {
      const f = fixture();
      const onBuild = [
        `cd "${f.dev}"`,
        "git checkout --quiet main",
        "echo D >> public/release.txt",
        "git commit --quiet -am 'D — pushed during the release'",
        "git push --quiet origin main",
        `git -C "${f.app}" fetch --quiet origin main`,
        `git rev-parse HEAD > "${f.root}/D"`,
      ].join(" && ");
      const run = deploy(f, release ? f.shas[release] : undefined, { EOD_TEST_ON_BUILD: onBuild });
      const D = readFileSync(path.join(f.root, "D"), "utf8").trim();
      const expected = release ? f.shas.B : f.shas.C;
      assert.equal(run.code, 0, run.output);
      assert.equal(trackedTip(f), D, "origin/main did move during the release");
      assert.equal(head(f), expected, `${release ?? "no RELEASE_SHA"}: the checkout is ${head(f)}`);
      assert.equal(marker(f), `${expected}\n`);
      assert.deepEqual(run.built, [expected]);
      assert.doesNotMatch(run.output, new RegExp(`(deployed sha|checkout|runtime marker) *: ${D}`));
    }
  });

  test("19C · deploy 10. no revision syntax reaches git, and the target is resolved once and read-only", () => {
    const f = fixture();
    const B = f.shas.B;
    const hostile = [
      "HEAD",
      "main",
      "origin/main",
      `${B}^`,
      `${B}~1`,
      `${B}^{tree}`,
      `${B}@{0}`,
      ":/approved",
      "@{-1}",
      `--output=${f.canary}`,
      `-c core.pager=touch ${f.canary}`,
      `$(touch ${f.canary})`,
      `\`touch ${f.canary}\``,
      `${B}; touch ${f.canary}`,
      `${B} && touch ${f.canary}`,
      `${B}\nHEAD`,
    ];
    for (const value of hostile) {
      const run = deploy(f, value);
      untouched(f, run, JSON.stringify(value));
      assert.match(run.output, /RELEASE_SHA must be a full 40-character lowercase commit sha/, JSON.stringify(value));
      assert.equal(existsSync(f.canary), false, `${JSON.stringify(value)} ran a command`);
      assert.equal(trackedTip(f), f.shas.A, `${JSON.stringify(value)}: the script fetched`);
    }

    // The source says the same thing the runs did.
    const lines = SOURCE.split("\n");
    const code = lines.map((line) => line.replace(/^\s*#.*$/, ""));
    const at = (pattern: RegExp) => code.findIndex((line) => pattern.test(line));
    const formatCheck = at(/RELEASE_SHA}" =~ \^\[0-9a-f\]\{40\}\$/);
    assert.ok(formatCheck > 0, "the format check exists");
    assert.ok(formatCheck < at(/if \(\( EUID != 0 \)\); then/), "the format is checked before anything else runs");
    assert.ok(formatCheck < at(/git fetch --prune origin/), "…and before the fetch");

    const assignments = code.flatMap((line, index) => (/^\s*TARGET_SHA=(?!"")/.test(line) ? [index] : []));
    const frozen = at(/^readonly TARGET_SHA\b/);
    assert.equal(assignments.length, 2, "TARGET_SHA is set in exactly two places: the branch tip, or RELEASE_SHA");
    assert.ok(frozen > 0 && assignments.every((index) => index < frozen), "…both before it is made read-only");

    // origin/<branch> is read by name once, straight after the fetch; every
    // later git command that moves anything names TARGET_SHA — and the only
    // other one, the rollback's reset, names the commit production was on.
    const commands = code.filter((line) => !/^\s*(log|info|warn|die)\b|\|\| die\b/.test(line));
    const remote = commands.filter((line) => /\bgit\b/.test(line) && /origin\//.test(line));
    assert.deepEqual(
      remote.map((line) => line.trim()),
      ['BRANCH_TIP="$(as_app "${APP_DIR}" git rev-parse --verify --quiet "refs/remotes/origin/${BRANCH}^{commit}")" \\'],
    );
    assert.equal(commands.filter((line) => /git fetch\b/.test(line)).length, 1, "one fetch");
    const later = commands.slice(commands.findIndex((line) => /^readonly TARGET_SHA\b/.test(line)));
    const moves = later.filter((line) => /\bgit (worktree add|checkout|reset|switch|merge|pull)\b/.test(line)).map((line) => line.trim());
    assert.deepEqual(moves, [
      'as_app "${APP_DIR}" git worktree add --detach "${BUILD_DIR}" "${TARGET_SHA}"',
      'as_app "${APP_DIR}" git checkout --quiet --force -B "${BRANCH}" "${TARGET_SHA}"',
    ]);
    const resets = commands.filter((line) => /\bgit reset\b/.test(line)).map((line) => line.trim());
    assert.deepEqual(resets, ['if as_app "${APP_DIR}" git reset --hard "${CURRENT_SHA}"; then'], "the rollback's reset is the only one");
    assert.match(SOURCE, /' _ "\$\{RELEASE_MARKER\}" "\$\{TARGET_SHA\}"/, "the runtime marker is written from TARGET_SHA");
  });
});
