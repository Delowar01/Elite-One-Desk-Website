# Dependency advisories — Batch 23 classification

**Status: development record, not a release approval.** Production deployment
is not authorized by this document.

## Evidence

| What | Where |
|---|---|
| `npm audit --json` on the untouched Batch 23 base, `64922a6925bb50644b28c6f629ae7e3d73ab9961` (taken before any Batch 23 change, on a clean `npm ci`) | `docs/release/evidence/batch-23-npm-audit-base-64922a6.json` |
| `npm audit --json` after the one isolated dependency commit of Batch 23 | `docs/release/evidence/batch-23-npm-audit-after-dependency-update.json` |
| The facts each decision rests on, held by `npm test` | `tests/dependency-advisories.test.ts` |
| The 19B release-candidate decisions this document supersedes | `docs/release/visual-editor-v1-rc.md`, "Dependency and advisory decisions" |

Advisory identifiers, ranges, CVEs and dates were read from the npm bulk
advisory endpoint (through `npm audit`) and from each GitHub advisory page on
2026-10-04.

## Counts

| State | Vulnerable packages | Moderate | High | Critical |
|---|---|---|---|---|
| 19B RC (`visual-editor-v1-rc`, audited 2026-10-01) | 8 | 5 | 3 | 0 |
| Batch 23 base `64922a6` (same as the exact-SHA CI install) | **13** | 5 | **8** | 0 |
| After the Batch 23 dependency commit | **11** | 5 | **6** | 0 |

`npm audit` counts *packages*, not advisories. One advisory deep in a chain is
counted once for every package on the chain that cannot escape it, so the
counts above are 10 distinct advisories at the base and 6 after the update.

### Why the count went from 8 to 13

**New advisory data, nothing else.** `package.json` and `package-lock.json`
are byte-identical between the RC tag and `64922a6`: `git diff
visual-editor-v1-rc 64922a6 -- package.json package-lock.json` is empty.
Batch 20, 21, 21A and 22 did not touch either file. Every vulnerable version
in the table below was already installed at the RC.

- **+5 HIGH**: GHSA-vfj7-8cjw-p6xm (CVE-2026-93687) against `braces`
  ≤ 3.0.3, published 2026-09-18 and last updated 2026-10-02 — the day after the
  RC audit. `npm audit` counts it against the whole chain that pins it:
  `braces`, `micromatch`, `fast-glob`, `@next/eslint-plugin-next` and
  `eslint-config-next`.
- **No severity change** to any advisory the RC already listed. `drizzle-orm`
  (1 high), Next's nested `postcss` (2 high, 2 moderate, reported as one high
  package), `brace-expansion` (2 high, 1 moderate) and the moderate
  `next`/`drizzle-kit`/`esbuild`/`@esbuild-kit/*` entries are as the RC
  recorded them.
- **No dependency-resolution change**: no lockfile change, so none could
  occur; the CI installation uses `npm ci` against the same lockfile.

### Why the count went from 13 to 11

Batch 23's one dependency commit fixed two of the eight HIGH packages:
`drizzle-orm` (0.44.7 → 0.45.2) and both copies of `brace-expansion`
(1.1.18 → 1.1.21 and 5.0.9 → 5.0.12). The remaining six HIGH packages are the
`braces` chain (five, no patched release exists) and Next's nested `postcss`
(fixable only by Next 16).

## Complete advisory table (base `64922a6`)

Type: **runtime** = executed by the production server; **build** = executed by
`next build` only; **dev** = developer/lint/codegen tooling, never executed by
the production server or by the deploy. No advisory is GitHub-Actions-only.

| # | Advisory | Vulnerable package | Installed | Direct / transitive | Full dependency path | Severity | Affected range | Fixed version | Fix available | Fix size | Type | Reachable here? | Elite One Desk exposure | Action |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | GHSA-gpj5-g38j-94v9 · CVE-2026-39356 · npm 1116251 · CWE-89 · CVSS 7.5 | drizzle-orm | 0.44.7 | **direct** (`dependencies`) | elite-one-desk › drizzle-orm | **high** | < 0.45.2 | 0.45.2 | yes | npm reports "major" (0.x minor); release notes and the full gate show no breaking change | **runtime** (bundled into the server) | **No.** Needs a request-chosen identifier (`sql.identifier()`, `.as()`, a CTE name, a dynamic column/alias). Every identifier comes from the schema in code (test-held). | None found; defence in depth | **Fixed in Batch 23 → 0.45.2** |
| 2 | GHSA-qhr7-859c-m2p7 · CVE-2026-102278 · npm 1240104 · CWE-674 · CVSS 7.5 | brace-expansion | 1.1.18 | transitive | eslint › minimatch@3.1.5 › brace-expansion (the same minimatch also under @eslint/config-array, @eslint/eslintrc, eslint-plugin-import, eslint-plugin-jsx-a11y, eslint-plugin-react) | **high** | < 1.1.20 | 1.1.20 | yes | patch | dev (lint) | No. Not imported by `src/`; absent from the standalone server (test-held) | None (lint-time CPU/stack on our own globs) | **Fixed → 1.1.21** |
| 3 | GHSA-qhr7-859c-m2p7 · npm 1240107 | brace-expansion | 5.0.9 | transitive | eslint-config-next › @typescript-eslint/parser › @typescript-eslint/typescript-estree › minimatch@10.2.6 › brace-expansion | **high** | ≥ 4.0.0 < 5.0.11 | 5.0.11 | yes | patch | dev (lint) | No (as #2) | None | **Fixed → 5.0.12** |
| 4 | GHSA-6j4f-fj2g-mc7p · CVE-2026-102276 · npm 1240108 · CWE-674 · CVSS 7.5 | brace-expansion | 1.1.18 | transitive | as #2 | **high** | < 1.1.19 | 1.1.19 | yes | patch | dev (lint) | No | None | **Fixed → 1.1.21** |
| 5 | GHSA-6j4f-fj2g-mc7p · npm 1240111 | brace-expansion | 5.0.9 | transitive | as #3 | **high** | ≥ 4.0.0 < 5.0.10 | 5.0.10 | yes | patch | dev (lint) | No | None | **Fixed → 5.0.12** |
| 6 | GHSA-q2hr-2g5m-vwhr · CVE-2026-102277 · npm 1240100 · CWE-400/407 · CVSS 5.3 | brace-expansion | 1.1.18 | transitive | as #2 | moderate | < 1.1.21 | 1.1.21 | yes | patch | dev (lint) | No | None | **Fixed → 1.1.21** |
| 7 | GHSA-q2hr-2g5m-vwhr · npm 1240103 | brace-expansion | 5.0.9 | transitive | as #3 | moderate | ≥ 4.0.0 < 5.0.12 | 5.0.12 | yes | patch | dev (lint) | No | None | **Fixed → 5.0.12** |
| 8 | GHSA-vfj7-8cjw-p6xm · CVE-2026-93687 · npm 1240992 · CWE-674 · CVSS 7.5 | braces (counted also against micromatch, fast-glob, @next/eslint-plugin-next, eslint-config-next) | braces 3.0.3 (micromatch 4.0.8, fast-glob 3.3.1, @next/eslint-plugin-next 15.5.25, eslint-config-next 15.5.25) | transitive (root: direct devDependency eslint-config-next) | eslint-config-next › @next/eslint-plugin-next › fast-glob@3.3.1 (exact pin) › micromatch@4.0.8 › braces@3.0.3 | **high** | ≤ 3.0.3 | **none published** (3.0.3 is the latest braces) | **no** — npm's only "fix" is eslint-config-next 14.2.35, a downgrade to the Next 14 line; even @next/eslint-plugin-next 16.3.8 still pins fast-glob 3.3.1 | — | dev (lint) | No. Not imported by `src/`; braces, micromatch and fast-glob are absent from the standalone server (test-held, new in Batch 23). Input is the repository's own lint globs | None | **Accept and monitor**; re-audit when braces or fast-glob publishes a fix |
| 9 | GHSA-6g55-p6wh-862q · CVE-2026-45623 · npm 1124252 · CWE-22/200 · CVSS 7.5 | postcss (Next's own copy; counted also against `next`) | 8.4.31 | transitive (root: direct dependency next) | next@15.5.25 › postcss@8.4.31 (exact pin) | **high** | ≤ 8.5.11 | 8.5.12 | only through next 16.3.8 | **major** (Next 16 migration) | **build** — copied into the standalone tree by file tracing, but only Next's webpack CSS pipeline requires it (test-held) | No. Needs an attacker-supplied stylesheet with a `sourceMappingURL`; PostCSS only runs in `next build` on repository CSS, and the application stores no CSS | None | **No change**; clears with a Next 16 migration (separate decision) |
| 10 | GHSA-r28c-9q8g-f849 · CVE-2026-73646 · npm 1139510 · CWE-22 · CVSS 7.5 | postcss (Next's copy) | 8.4.31 | transitive | as #9 | **high** | ≤ 8.5.17 | 8.5.18 | only through next 16.3.8 | major | build | No (as #9) | None | As #9 |
| 11 | GHSA-qx2v-qp2m-jg93 · CVE-2026-41305 · npm 1117015 · CWE-79 · CVSS 6.1 | postcss (Next's copy) | 8.4.31 | transitive | as #9 | moderate | < 8.5.10 | 8.5.10 | only through next 16.3.8 | major | build | No. Needs attacker CSS stringified into a page; our CSS is repository CSS compiled at build time | None | As #9 |
| 12 | GHSA-fxqj-rqcc-2cmp · CVE-2026-69153 · npm 1130709 · CWE-22/200 | postcss (Next's copy) | 8.4.31 | transitive | as #9 | moderate | ≤ 8.5.22 | 8.5.23 | only through next 16.3.8 | major | build | No (as #9) | None | As #9 |
| 13 | GHSA-67mh-4wv8-2f99 · no CVE · npm 1102341 · CWE-346 · CVSS 5.3 | esbuild (counted also against @esbuild-kit/core-utils, @esbuild-kit/esm-loader, drizzle-kit) | esbuild 0.18.20 (@esbuild-kit/core-utils 3.3.2, @esbuild-kit/esm-loader 2.6.5, drizzle-kit 0.31.10) | transitive (root: direct devDependency drizzle-kit) | drizzle-kit › @esbuild-kit/esm-loader › @esbuild-kit/core-utils › esbuild@0.18.20 (`~0.18.20`; both @esbuild-kit packages are deprecated, "merged into tsx") | moderate | ≤ 0.24.2 | 0.25.0 | no non-breaking path — npm's "fix" is drizzle-kit 0.18.1, a downgrade | — | dev (schema codegen, `npm run db:generate`) | No. The flaw is in esbuild's development `serve` mode, which nothing here starts. Migrations run through `tsx scripts/migrate.ts` (tsx carries esbuild 0.28.2); deploy.sh never runs drizzle-kit; esbuild is absent from the standalone server (test-held, new in Batch 23) | None | **Accept**; revisit when drizzle-kit drops @esbuild-kit |

The `next` entry itself (moderate, "via postcss", range 9.3.4-canary.0 –
16.3.0-preview.10) carries no advisory of its own: it is #9–#12 seen from the
package that pins them.

## Dependency updates made in Batch 23

One isolated commit, `package.json` + `package-lock.json` only:

| Package | From | To | Why it qualifies under the Batch 23 policy |
|---|---|---|---|
| drizzle-orm | 0.44.7 (`^0.44.2`) | 0.45.2 (`^0.45.2`) | Fixes #1, the only HIGH on a runtime package. The 0.45 line's release notes list no breaking change; no peer change, no schema or migration change, no code change was needed; the full gate passed (typecheck, lint, build, `npm test` 1,815/1,815, then every probe and stress script). |
| brace-expansion | 1.1.18 | 1.1.21 | Fixes #2, #4, #6. Inside `^1.1.7`, the range minimatch 3.1.5 already declares: a lockfile-only patch. |
| brace-expansion (under typescript-estree) | 5.0.9 | 5.0.12 | Fixes #3, #5, #7. Inside `^5.0.8`, the range minimatch 10.2.6 already declares: a lockfile-only patch. |

Not done, deliberately: `npm audit fix --force`; Next 16 (would clear
#9–#12); an `overrides` entry forcing postcss under Next (overriding a
framework's exact pin is a framework change in disguise); eslint-config-next
14 (a downgrade); drizzle-kit 0.18 (a downgrade); any other refresh.

## Runtime-exploitable assessment

After the update, **no advisory remains on a package the production server
executes.** `drizzle-orm` is fixed. Next's `postcss` ships inside the
standalone tree but only Next's build pipeline requires it, and it never sees
input that is not repository CSS. Everything else is developer tooling absent
from the server.

So no HIGH advisory is runtime-reachable without a safe fix, and the
"PRODUCTION DEPLOYMENT BLOCKED" condition of the Batch 23 policy is **not**
met by dependencies. This is a classification, not a deployment approval.

## GitHub Actions warning (CI runners only — not the application)

Every CI and Stress job currently logs:

> Node.js 20 is deprecated. The following actions target Node.js 20 but are
> being forced to run on Node.js 24: actions/checkout@v4,
> actions/setup-node@v4, actions/upload-artifact@v4.

It concerns the runtime of the three *actions themselves* on GitHub's
runners. The application is installed, built and tested on Node 22
(`NODE_VERSION: "22"` in both workflows, matching production). Both workflows
have `permissions: contents: read`.

**Recorded, not changed in Batch 23.** The successors (`checkout@v5`,
`setup-node@v5`, `upload-artifact@v5`) are the official ones, but they are
not drop-in: `setup-node@v5` lists two breaking changes in its release notes —
caching switched on automatically when `package.json` has a `packageManager`
field (ours has none today, so it would stay off) and a minimum runner
version. Swapping three actions is a CI change that needs its own
revalidation, not something to fold into a concurrency batch. The jobs pass
under the forced Node 24 today.
