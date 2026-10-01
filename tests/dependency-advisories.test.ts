/**
 * Batch 19B · the evidence behind each dependency-advisory decision, kept true.
 *
 * `npm audit` on the release candidate still lists three HIGH advisories after
 * the sharp upgrade (see `media-pipeline.test.ts` for that one). None is fixed
 * by a version bump in this release, and each decision rests on a fact about
 * this codebase rather than on the label — so the facts are checked here, and a
 * change that would make an advisory reachable fails `npm test` instead of
 * slipping past a reviewer:
 *
 * - drizzle-orm < 0.45.2 (GHSA-gpj5-g38j-94v9): identifiers are escaped wrongly,
 *   which matters only when a request can choose one — `sql.identifier()`,
 *   `.as()`, a CTE name, a dynamic column or alias. Every identifier here comes
 *   from the schema in code. NOT EXPLOITABLE IN THIS DEPLOYMENT.
 * - postcss <= 8.5.22, Next's own copy (GHSA-6g55-p6wh-862q, GHSA-r28c-9q8g-f849):
 *   reads files named by a stylesheet's sourceMappingURL — a stylesheet an
 *   attacker would have to supply. PostCSS only ever runs in `next build`, on
 *   the repository's own CSS; the application stores no CSS at all (styles are
 *   tokens). BUILD/DEV ONLY. Fixing it needs Next 16, a framework migration.
 * - brace-expansion (GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p): a CPU/stack DoS
 *   on a crafted brace pattern, reached through minimatch in ESLint and the
 *   TypeScript tooling, on the repository's own globs. BUILD/DEV ONLY.
 *
 * docs/release/visual-editor-v1-rc.md records each decision in full.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { REPO_ROOT } from "./helpers/env";

/** Every source file under `dir`, as [repo-relative path, text]. */
function sources(dir: string, extensions = [".ts", ".tsx", ".mts"]): [string, string][] {
  const out: [string, string][] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current)) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (extensions.some((extension) => entry.endsWith(extension)))
        out.push([path.relative(REPO_ROOT, full), readFileSync(full, "utf8")]);
    }
  };
  walk(path.join(REPO_ROOT, dir));
  return out;
}

describe("19B · dependency advisories the release candidate keeps unreachable", () => {
  test("drizzle-orm: no identifier, alias or CTE is ever built at runtime — every name comes from the schema in code", () => {
    const offenders = sources("src").flatMap(([file, text]) =>
      [/\bsql\.identifier\(/, /\bsql\.raw\(/, /\.\$with\(/, /\bsql`[^`]*`\s*\.as\(/, /\)\s*\.as\(\s*[a-zA-Z_$]/]
        .filter((pattern) => pattern.test(text))
        .map((pattern) => `${file} ${pattern}`),
    );
    assert.deepEqual(offenders, [], "an identifier API in application code — check it can never take request input");
  });

  test("drizzle-orm: the one raw identifier outside the application is a fixed column name in a maintenance script", () => {
    const raw = sources("scripts").flatMap(([file, text]) =>
      [...text.matchAll(/sql\.raw\(([^)]*)\)/g)].map((match) => `${file}: ${match[1]}`),
    );
    for (const use of raw) assert.match(use, /^scripts\/restructure\.ts: column$/, use);
    const restructure = readFileSync(path.join(REPO_ROOT, "scripts", "restructure.ts"), "utf8");
    const loops = [...restructure.matchAll(/for \(const column of (\[[^\]]*\]) as const\)/g)].map((match) => match[1]);
    assert.ok(loops.length > 0 && loops.every((list) => list === '["published", "draft"]'), JSON.stringify(loops));
  });

  test("postcss and brace-expansion run only in the build: nothing in the application imports them", () => {
    const imports = sources("src").filter(([, text]) =>
      /from ["'](postcss|brace-expansion|minimatch)["']|require\(["'](postcss|brace-expansion|minimatch)["']\)/.test(text),
    );
    assert.deepEqual(imports.map(([file]) => file), []);
  });

  test("postcss and brace-expansion are not in the production server: the standalone runtime ships neither", () => {
    const standalone = path.join(REPO_ROOT, ".next", "standalone", "node_modules");
    assert.ok(existsSync(standalone), "no production build — run `npm run build` first");
    assert.ok(!existsSync(path.join(standalone, "brace-expansion")), "brace-expansion is in the server runtime");
    // Next carries its own postcss into the standalone tree, but only its build
    // pipeline requires it: the webpack CSS blocks, loaders and minimiser.
    const nextDist = path.join(standalone, "next", "dist");
    const requirers = sources(path.relative(REPO_ROOT, nextDist), [".js", ".cjs"])
      .filter(([, text]) => /require\(["']postcss["']\)/.test(text))
      .map(([file]) => path.relative(nextDist, path.join(REPO_ROOT, file)));
    for (const file of requirers) assert.match(file, /^(build\/webpack\/|compiled\/(postcss-|cssnano))/, file);
  });
});
