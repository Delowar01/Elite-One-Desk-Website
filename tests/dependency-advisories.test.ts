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
 *
 * Batch 23 upgraded drizzle-orm to 0.45.2, the release that fixes
 * GHSA-gpj5-g38j-94v9, and moved both copies of brace-expansion to their
 * patched releases (1.1.21, 5.0.12) inside the ranges their parents already
 * declare. The rules above still hold — they are how the code stays safe on
 * the next advisory too — and the versions are now held as well, so a lockfile
 * that drifts back fails here. Two advisories have no safe fix: braces
 * (GHSA-vfj7-8cjw-p6xm, no patched release at all) and the esbuild under
 * drizzle-kit (GHSA-67mh-4wv8-2f99); what keeps each out of the running
 * application is checked too. docs/release/dependency-advisories-batch-23.md
 * classifies every advisory `npm audit` reports today.
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

describe("23 · the advisories Batch 23 fixed stay fixed", () => {
  const lock = JSON.parse(readFileSync(path.join(REPO_ROOT, "package-lock.json"), "utf8")) as {
    packages: Record<string, { version?: string }>;
  };
  const versionsOf = (name: string) =>
    Object.entries(lock.packages)
      .filter(([key]) => key === `node_modules/${name}` || key.endsWith(`/node_modules/${name}`))
      .map(([key, entry]) => [key, entry.version ?? ""] as const);
  const atLeast = (version: string, floor: string) => {
    const [a, b] = [version, floor].map((value) => value.split(".").map((part) => Number.parseInt(part, 10)));
    for (let index = 0; index < 3; index += 1) {
      if (a![index]! !== b![index]!) return a![index]! > b![index]!;
    }
    return true;
  };

  test("drizzle-orm is at a release that escapes identifiers (GHSA-gpj5-g38j-94v9 fixed in 0.45.2)", () => {
    const found = versionsOf("drizzle-orm");
    assert.deepEqual(found.map(([key]) => key), ["node_modules/drizzle-orm"], "one drizzle-orm, at the top");
    assert.ok(atLeast(found[0]![1], "0.45.2"), `drizzle-orm ${found[0]![1]}`);
  });

  test("every brace-expansion copy is at its patched release (1.1.21 on the 1.x line, 5.0.12 on the 5.x line)", () => {
    const found = versionsOf("brace-expansion");
    assert.ok(found.length > 0);
    for (const [key, version] of found) {
      const floor = version.startsWith("1.") ? "1.1.21" : version.startsWith("5.") ? "5.0.12" : "999.0.0";
      assert.ok(atLeast(version, floor), `${key}: ${version}`);
    }
  });
});

describe("23 · the advisories with no safe fix stay out of the running application", () => {
  test("braces (GHSA-vfj7-8cjw-p6xm, no patched release) is lint tooling: nothing imports it and the server does not ship it", () => {
    // eslint-config-next > @next/eslint-plugin-next > fast-glob (pinned 3.3.1)
    // > micromatch > braces. It parses the repository's own lint globs.
    const chain = ["braces", "micromatch", "fast-glob"];
    const imports = sources("src").filter(([, text]) =>
      chain.some((name) => text.includes(`from "${name}"`) || text.includes(`require("${name}")`)),
    );
    assert.deepEqual(imports.map(([file]) => file), []);
    const standalone = path.join(REPO_ROOT, ".next", "standalone", "node_modules");
    assert.ok(existsSync(standalone), "no production build — run `npm run build` first");
    for (const name of chain) assert.ok(!existsSync(path.join(standalone, name)), `${name} is in the server runtime`);
  });

  test("the old esbuild under drizzle-kit (GHSA-67mh-4wv8-2f99) never runs on a server: migrations run through tsx", () => {
    const manifest = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    assert.match(manifest.scripts["db:migrate"] ?? "", /^tsx scripts\/migrate\.ts$/);
    // drizzle-kit is reached only by `db:generate`, a developer command.
    const users = Object.entries(manifest.scripts).filter(([, command]) => command.includes("drizzle-kit"));
    assert.deepEqual(users.map(([name]) => name), ["db:generate"]);
    const deploy = readFileSync(path.join(REPO_ROOT, "deploy", "deploy.sh"), "utf8");
    assert.ok(!deploy.includes("drizzle-kit") && !deploy.includes("db:generate"), "deploy.sh runs drizzle-kit");
    const standalone = path.join(REPO_ROOT, ".next", "standalone", "node_modules");
    assert.ok(!existsSync(path.join(standalone, "esbuild")), "esbuild is in the server runtime");
  });
});

describe("25 · the advisory published since Batch 24 stays out of the running application", () => {
  test("source-map-js (GHSA-68fv-2mgg-jv7q) is reached only through Next's build-time postcss: nothing imports it, and in the server only that postcss requires it", () => {
    // A crafted indexed source map stalls the event loop while it is parsed.
    // Nothing here parses a source map anybody else wrote: the application does
    // not import the package, and the production server ships it only because
    // Next's own postcss — which only the build's CSS pipeline runs (checked
    // above) — requires it. docs/release/dependency-advisories-batch-25.md.
    const imports = sources("src").filter(([, text]) => /from ["']source-map-js["']|require\(["']source-map-js["']\)/.test(text));
    assert.deepEqual(imports.map(([file]) => file), []);
    const standalone = path.join(REPO_ROOT, ".next", "standalone", "node_modules");
    assert.ok(existsSync(standalone), "no production build — run `npm run build` first");
    const requirers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (statSync(full).isDirectory()) {
          if (path.relative(standalone, full) !== "source-map-js") walk(full);
        } else if (/\.(c?js|mjs)$/.test(entry) && /require\(["']source-map-js["']\)|from ["']source-map-js["']/.test(readFileSync(full, "utf8"))) {
          requirers.push(path.relative(standalone, full));
        }
      }
    };
    walk(standalone);
    assert.ok(requirers.length > 0, "nothing requires source-map-js — has the advisory gone? Then this test and the note go too");
    for (const file of requirers) assert.match(file, /^next\/node_modules\/postcss\/lib\//, file);
  });
});
