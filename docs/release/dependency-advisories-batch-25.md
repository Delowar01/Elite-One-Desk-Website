# Dependency advisories — Batch 25 reclassification

**Status: development record, not a release approval.** Production deployment
is not authorized by this document.

Batch 25 changes no dependency: `git diff da96625 HEAD -- package.json
package-lock.json` is empty. Its brief (§25) compares `npm audit` at the final
SHA with the Batch 24 baseline — **11** vulnerable packages, 0 critical,
6 high, 5 moderate — reclassifies anything that changed, and stops the
release-readiness assessment if a new HIGH or CRITICAL is reachable by the
running application.

## Evidence

| What | Where |
|---|---|
| `npm audit --json` on 2026-10-08 (the lockfile of `da96625` and of every Batch 25 commit) | `docs/release/evidence/batch-25-npm-audit-2026-10-08.json` |
| The facts each decision rests on, held by `npm test` | `tests/dependency-advisories.test.ts` (the `25 ·` block is new) |
| The classification of every other advisory | `docs/release/dependency-advisories-batch-23.md` |

## Counts

| State | Vulnerable packages | Moderate | High | Critical |
|---|---|---|---|---|
| Batch 24 baseline | 11 | 5 | 6 | 0 |
| Batch 25, same lockfile, 2026-10-08 | **12** | 5 | **7** | 0 |

**New advisory data, nothing else.** The one new package is `source-map-js`;
every other entry is the Batch 23 set, unchanged in severity: the `braces`
chain (`braces`, `micromatch`, `fast-glob`, `@next/eslint-plugin-next`,
`eslint-config-next` — lint tooling, no patched release) and Next's nested
`postcss` (build only, fixable only by Next 16) as HIGH; `next`, `drizzle-kit`,
`esbuild`, `@esbuild-kit/core-utils` and `@esbuild-kit/esm-loader` as moderate.

## The new advisory

| Field | Value |
|---|---|
| Advisory | GHSA-68fv-2mgg-jv7q · npm 1241209 · CWE-1284 |
| Title | source-map-js allows event-loop denial of service through indexed source-map section offsets |
| Severity | high |
| Package, installed | `source-map-js` 1.2.1, one copy (`node_modules/source-map-js`) |
| Affected range, fix | ≥ 1.0.0 < 1.2.2; fixed in 1.2.2 |
| Direct / transitive | transitive: `next@15.5.25 › postcss@8.4.31 › source-map-js`, and `@tailwindcss/postcss › postcss@8.5.28` / `@tailwindcss/node › source-map-js` |
| Type | **build**: it parses a source map handed to it; in this codebase only PostCSS hands it one, and PostCSS runs in `next build` on the repository's own CSS |
| In the production server? | The standalone tree carries the file because Next's nested postcss — itself traced in but required only by the webpack CSS pipeline — requires it. Nothing in `src/` imports it, and nothing else in the server requires it (test-held) |
| Reachable here? | **No.** The denial of service needs an attacker-supplied indexed source map to be parsed; the running application parses no source map and stores no CSS |
| Decision | **Not a release blocker; no STOP.** Accepted and monitored, as the other build-only advisories. The patch (1.2.2) is a lockfile-only update inside the range postcss declares; taking it is left to a dependency decision of its own rather than folded into this batch, which the brief keeps free of dependency refreshes |
