/**
 * `next build` must not be able to reach PostgreSQL.
 *
 * The release adding `travel_packages.destination_id` could not be built: the
 * new code queried the column during `generateStaticParams`, and the column did
 * not exist until the migration ran — which `deploy.sh` does only after a
 * successful build. A deadlock, and the first release to contain one.
 *
 * The fix was to stop the build needing the database at all, and `deploy.sh`
 * now hands the build an unreachable URL so the property is enforced rather
 * than merely observed. This is the test that keeps it true.
 *
 * It builds a copy of the working tree, not `.next`, for two reasons: the other
 * server tests need the real build left alone, and a warm `.next/cache` hides
 * the whole problem — the same pre-migration build passed with a warm cache and
 * failed without one. `deploy.sh` builds in a fresh worktree, so cold is the
 * only honest test.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { REPO_ROOT, scriptEnv } from "./helpers/env";

/** The same address `deploy/deploy.sh` uses. Port 1 refuses instantly. */
const UNREACHABLE = "postgresql://invalid:invalid@127.0.0.1:1/invalid";

/** Stands in for the production value in the sandbox's `.env`. Not a secret. */
const RUNTIME_MARKER_URL = "postgresql://runtime:runtime@127.0.0.1:5432/runtime_marker";

/**
 * Outside the repository, deliberately.
 *
 * Built inside it, Next walks up past the sandbox, decides the outer checkout is
 * the workspace root, and nests the standalone output under a path that mirrors
 * the sandbox's own location — no `server.js`, no `.env` and no `.next` where
 * they belong. The build still succeeds, so this is the kind of thing a test
 * that only reads the log would never notice.
 */
const SANDBOX = path.join(tmpdir(), `eod-build-isolation-${process.pid}`);

let output = "";
let status: number | null = null;

before(() => {
  // A copy of the working tree as it is on disk: tracked files with their
  // uncommitted edits, AND untracked files that are not gitignored.
  //
  // `--others --exclude-standard` is what adds the second half, and it matters:
  // with `git ls-files` alone a developer could add a whole new route that
  // queries the database during the build, run this test, and watch it pass
  // because the new file was not in the copy. `--exclude-standard` still honours
  // .gitignore, so node_modules, .next, .data and .env stay out.
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(SANDBOX, { recursive: true });

  const listed = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(listed.status, 0, listed.stderr);
  // `--cached` also lists tracked files deleted from the working tree; `cp`
  // would stop on the first one.
  const files = listed.stdout
    .split("\0")
    .filter(Boolean)
    .filter((file) => existsSync(path.join(REPO_ROOT, file)));
  assert.ok(files.length > 100, `only ${files.length} files listed — the copy looks wrong`);

  const copy = spawnSync("cp", ["--parents", "-t", SANDBOX, ...files], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(copy.status, 0, copy.stderr);

  // Dependencies are shared; nothing here writes to them.
  symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(SANDBOX, "node_modules"));

  // `.env` is gitignored, so the copy has none — and the build needs one to
  // prove what happens to it. A throwaway with a recognisable marker: no secret
  // is involved, and the marker is what the assertions below look for.
  writeFileSync(
    path.join(SANDBOX, ".env"),
    [
      `DATABASE_URL=${RUNTIME_MARKER_URL}`,
      "AUTH_SECRET=build-isolation-test-secret-not-used-anywhere-real-0123456789",
      "NEXT_PUBLIC_SITE_URL=http://127.0.0.1:3401",
      "UPLOAD_DIR=/tmp/build-isolation-uploads",
      "",
    ].join("\n"),
    "utf8",
  );

  const built = spawnSync("npx", ["next", "build"], {
    cwd: SANDBOX,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: scriptEnv(UNREACHABLE),
  });
  status = built.status;
  output = `${built.stdout ?? ""}\n${built.stderr ?? ""}`;
});

after(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

describe("the build does not need a database", () => {
  test("a cold build succeeds with PostgreSQL unreachable", () => {
    assert.equal(status, 0, output.slice(-4000));
    assert.match(output, /Compiled successfully/);
  });

  test("it never tried to connect", () => {
    for (const symptom of [/ECONNREFUSED/, /Failed query/, /revalidating cache with key/, /Error occurred prerendering/]) {
      assert.ok(!symptom.test(output), `the build contacted the database:\n${output.slice(-3000)}`);
    }
  });

  test("nothing database-backed is prerendered", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(SANDBOX, ".next", "prerender-manifest.json"), "utf8"),
    ) as { routes?: Record<string, unknown> };
    const prerendered = Object.keys(manifest.routes ?? {}).sort();
    // `/robots.txt` reads only env; `/_not-found` reads nothing. `/sitemap.xml`
    // used to be here, and its absence is the point of this test.
    assert.deepEqual(prerendered, ["/_not-found", "/robots.txt"]);
  });

  test("the sitemap is a runtime route", () => {
    assert.match(output, /ƒ \/sitemap\.xml/, "the sitemap should be dynamic, not prerendered");
    assert.match(output, /○ \/robots\.txt/, "robots reads no database and stays static");
  });

  test("the runtime keeps the real .env — the build-only URL is not persisted", () => {
    // `next build` copies the .env beside the standalone server. It copies the
    // file from disk, not the environment the build ran under, so the runtime
    // gets the real value and never the unreachable one. Compared by hash and
    // by absence; nothing is printed.
    const source = path.join(SANDBOX, ".env");
    const shipped = path.join(SANDBOX, ".next", "standalone", ".env");
    assert.ok(existsSync(shipped), "the standalone runtime should carry a .env");

    const hash = (file: string) => createHash("sha256").update(readFileSync(file)).digest("hex");
    assert.equal(hash(shipped), hash(source), "the runtime .env should be the one on disk");

    const shippedText = readFileSync(shipped, "utf8");
    assert.ok(
      !shippedText.includes("127.0.0.1:1/invalid"),
      "the build-only database URL must not reach the runtime",
    );
    assert.ok(
      shippedText.includes(RUNTIME_MARKER_URL),
      "the runtime .env should still name the database the runtime is meant to use",
    );
  });

  test("the sandbox copy includes untracked files that are not ignored", () => {
    // The guard on the guard: if this copy silently dropped new files, the
    // whole suite would pass on a release that reintroduced the dependency.
    const probe = "zz-build-isolation-probe.txt";
    writeFileSync(path.join(REPO_ROOT, probe), "probe\n", "utf8");
    try {
      const listed = spawnSync(
        "git",
        ["ls-files", "--cached", "--others", "--exclude-standard"],
        { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
      );
      const files = listed.stdout.split("\n");
      assert.ok(files.includes(probe), "an untracked, non-ignored file must be copied");
      for (const ignored of ["node_modules/", ".next/", ".data/"]) {
        assert.ok(
          !files.some((file) => file.startsWith(ignored)),
          `${ignored} must stay out of the copy`,
        );
      }
      assert.ok(!files.includes(".env"), ".env is gitignored and must stay out of the copy");
    } finally {
      rmSync(path.join(REPO_ROOT, probe), { force: true });
    }
  });

  test("no catalogue route enumerates paths from the database", () => {
    const dbBacked = [
      "src/app/(public)/[lang]/[...slug]/page.tsx",
      "src/app/(public)/[lang]/packages/[slug]/page.tsx",
      "src/app/(public)/[lang]/services/[category]/page.tsx",
      "src/app/(public)/[lang]/services/[category]/[service]/page.tsx",
    ];
    for (const file of dbBacked) {
      const source = readFileSync(path.join(REPO_ROOT, file), "utf8");
      assert.ok(
        !/export\s+(async\s+)?function\s+generateStaticParams/.test(source),
        `${file} must not enumerate paths at build time`,
      );
    }
    // The locale-only one stays: it queries nothing.
    const layout = readFileSync(
      path.join(REPO_ROOT, "src/app/(public)/[lang]/layout.tsx"),
      "utf8",
    );
    assert.match(layout, /export function generateStaticParams/);
    assert.ok(!/queries\//.test(layout.split("generateStaticParams")[1]!.slice(0, 200)));
  });
});
