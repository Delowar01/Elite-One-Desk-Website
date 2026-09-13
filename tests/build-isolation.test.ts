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
import { mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { REPO_ROOT, scriptEnv } from "./helpers/env";

/** The same address `deploy/deploy.sh` uses. Port 1 refuses instantly. */
const UNREACHABLE = "postgresql://invalid:invalid@127.0.0.1:1/invalid";

const SANDBOX = path.join(REPO_ROOT, ".data", "test", "build-isolation");

let output = "";
let status: number | null = null;

before(() => {
  // A copy of the working tree as it is on disk — uncommitted changes included,
  // so this tests what is about to be committed rather than what already was.
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(SANDBOX, { recursive: true });

  const tracked = spawnSync("git", ["ls-files", "-z"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(tracked.status, 0, tracked.stderr);
  const files = tracked.stdout.split("\0").filter(Boolean);
  const copy = spawnSync("cp", ["--parents", "-t", SANDBOX, ...files], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.equal(copy.status, 0, copy.stderr);

  // Dependencies are shared; nothing here writes to them.
  symlinkSync(path.join(REPO_ROOT, "node_modules"), path.join(SANDBOX, "node_modules"));

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
