# Visual Editor V1 — release candidate

**Status: release candidate, awaiting independent review. Not deployed.**
Batch 19B did not access the VPS or production, did not run the CTA audit
against production, did not change `deploy/previous-release`, and did not
start Batch 20. The production-deployment decision is not made here.

| | |
|---|---|
| Release-candidate SHA | *recorded in the documentation-only commit that follows the RC commit (this file's next revision)* |
| Date | 2026-10-01 |
| Baseline | `5b6a275` (Batch 19A) |
| Previous production release | `b807663` (`deploy/previous-release`, unchanged) |
| Acceptance matrix | [`visual-editor-v1-acceptance.md`](visual-editor-v1-acceptance.md) — 268 requirements: 261 PASS, 7 PASS WITH DOCUMENTED LIMITATION, 0 FAIL |
| Runtime | Node.js 22 (CI and production), Next.js 15.5.25, PostgreSQL 16 |

## What this release changes in production

- The Visual Editor V1 (Batches 5–19): canvas, Layers, locking, direct
  editing, content, media, basic and advanced style, responsive and RTL,
  structure, motion, Undo/Redo, page history, Version Compare, reusable
  components, site Globals, granular permissions.
- **Database migrations 0002–0005** (production has 0000–0001):

  | Migration | Adds |
  |---|---|
  | `0002_normal_blue_shield` | `page_versions`; `page_sections.styles` (default `{}`), `draft_styles`, `draft_animation`, `revision` (default 0), `updated_by`; `pages.draft_structure`, `revision` (default 0), `updated_by` |
  | `0003_lazy_skreet` | `page_sections.is_draft_only` (default false) |
  | `0004_spooky_shadow_king` | `page_sections.motion_config`, `draft_motion_config` |
  | `0005_mute_nebula` | `reusable_components`, `reusable_component_versions`, a partial index on `page_sections` |

  All additive: nothing is dropped, renamed, narrowed or rewritten; new
  columns are nullable or have a constant default. The previous release reads
  and writes the migrated schema (`tests/schema-compat.test.ts`). **A
  migration is not rolled back by a runtime rollback.**
- **Permission catalogue upgrade** by the seed: `content.manage` splits into
  the granular keys each role's holdings imply; customised roles stay
  customised; a removed grant is never re-granted.
- **One dependency change:** `sharp` `^0.34.2` → `^0.35.5` (two HIGH libvips /
  libheif advisories). `deploy.sh` installs with `npm ci --include=dev
  --ignore-scripts` and then `npm rebuild sharp`; that exact sequence was
  verified on the RC in a fresh clone (gate record below).
- **Client address.** Sign-in throttling, activity-log IP hashes and the
  enquiry limiter now use the address nginx vouches for — `X-Real-IP`
  (`$remote_addr`), else the last `X-Forwarded-For` hop — the same key
  nginx's own `limit_req` uses (`deploy/nginx.conf`). Nothing changes in the
  nginx configuration. A CDN placed in front of nginx later would need nginx's
  `real_ip` module for both.

## Required deployment order

`deploy/deploy.sh` enforces this order (`DEPLOYMENT.md` §9,
`docs/release/permission-upgrade.md`):

1. Clean production tree; fetch; build the release in a throw-away worktree:
   `npm ci --include=dev --ignore-scripts`, `npm rebuild sharp`, lint,
   typecheck, build, stamp the runtime with its commit.
2. **Back up the database and uploads.** If the backup fails, the release
   stops with production untouched.
3. `npm run db:migrate` (0002–0005, additive).
4. `npm run db:seed` (permission catalogue and grants).
5. `npm run db:check-permissions` — the preflight; it must report the
   catalogue complete. Use `-- --strict` straight after the first upgrade.
   A failure stops the release **before** the switch.
6. Stage the runtime, stop the service, switch by two renames, reset the
   checkout, start the service.
7. Verify the runtime marker equals the target commit; health checks.

## Before the switch — the production gates (for Batch 20)

Batch 19B performed **none** of these.

1. Confirm the exact approved RC SHA (above) and that `origin/main` serves it.
2. Verify the backup: the database dump and uploads exist, are complete, and
   restore into a scratch database.
3. Run the migrations (0002–0005).
4. Run the seed (permission upgrade).
5. Run the permission preflight (`npm run db:check-permissions`, strict on the
   first upgrade) and keep its matrix.
6. Run the **authorized** CTA audit (`npm run audit:cta -- --json …`) against
   the **restored pre-deploy backup**, and review the findings
   (`docs/release/cta-audit.md`).
7. Resolve or approve the CTA corrections where needed — a person decides; no
   value is invented.
8. Only then perform the release switch.
9. Run the production smoke tests (below).
10. Run the CTA audit again after release if the runbook requires it, before
    editors work on the affected sections.
11. Verify permissions: every role's grants against the preflight matrix.
12. Verify the public site in English and Arabic.
13. Verify the Visual Editor: open, select, save a draft, preview, discard.
14. Keep the rollback runtime (`standalone.rollback-<sha>-<time>`) until the
    release has proved itself.

## After the switch — health checks

- `deploy.sh`: `systemctl is-active elite-one-desk.service`; the runtime
  marker equals the target commit; `http://127.0.0.1:3000/` with
  `Host: eliteonedesk.com`; `https://eliteonedesk.com/`;
  `https://eliteonedesk.com/admin/login`.
- By hand: `/` and `/ar` render; a service page and a package page render; the
  sitemap answers; `/admin` signs in; the Visual Editor opens a page, a field
  saves a draft, the ordinary preview shows it, discard removes it;
  `npm run db:check-permissions` prints the catalogue complete.

## Rollback

**Roll back the runtime** (`deploy.sh` does it automatically after a failure at
or after the switch) when: the service does not stay active; the runtime
marker is wrong; any health check fails; the public site or sign-in is broken;
the Visual Editor cannot open or save; the permission preflight disagrees with
the expected matrix after the switch.

**Restore the database** from the pre-deploy backup only when data is wrong,
and only by a person: a runtime rollback never reverses a migration (all of
which the previous release tolerates) and never loads the backup.

> **Runtime rollback is not authorization-equivalent.** The previous release
> knows only `content.manage`. A role narrowed through the granular keys but
> still holding `content.manage` regains every page power; a role given only
> granular keys loses page editing; saving a role on the previous release's
> Roles screen drops its granular keys, and re-deploying does not restore
> them. A rollback therefore needs the owner's authorization review —
> `docs/release/permission-upgrade.md`, "Rollback is NOT
> permission-equivalent". Reusable components are not editable under the
> previous release; linked sections render the copy they keep.

## Accepted V1 limitations

Word Reveal is word-based, not line-based · no Hover Glow · legacy basic
motion presets keep their legacy CSS classes · live parallax is paused in the
editor canvas (Replay previews it) · four system role types, no arbitrary
named custom roles · the Stress workflow is manual/scheduled, not per push ·
browser QA runs in Chromium only. Details and the remaining design boundaries
are in the acceptance matrix.

## Dependency and advisory decisions

`npm audit` on the RC: 8 vulnerable packages, 5 moderate and 3 high.

| Advisory | Severity | Decision |
|---|---|---|
| `sharp`/libvips GHSA-f88m-g3jw-g9cj; libheif GHSA-rgj7-g3m4-5g8c | HIGH | **Fixed before RC:** `sharp` 0.35.5 |
| `drizzle-orm` GHSA-gpj5-g38j-94v9 | HIGH | **Not exploitable in this deployment** (no identifier/alias construction from input); held by a test; upgrade to 0.45.2 in a maintenance batch |
| Next's nested `postcss` 8.4.31 (two high, two moderate) | HIGH | **Build/dev only** (compiles repository CSS; not required at run time — held by a test). The fix is a **Next 16 migration, not performed** — needs its own decision |
| `brace-expansion` (two high, one moderate) | HIGH | **Build/dev only** (lint tooling; absent from the runtime — held by a test) |
| `next` (via postcss), `drizzle-kit`, `esbuild`, `@esbuild-kit/*` | moderate | **Dev only** |

## For the reviewer — items needing a decision

1. **`mustChangePassword` is not enforced.** New and reset accounts are
   flagged "temporary password" but are never made to change it, and users
   cannot change their own password. Present since the first commit; outside
   the Visual Editor. Enforcing it changes how existing production accounts
   sign in, so 19B did not change it. Options: enforce at sign-in with a
   self-service change screen (a later batch), or remove the flag and the
   "temporary" wording.
2. **Next.js 16** would clear the build-time `postcss` advisory; it is a
   framework migration and was not performed.
3. **Legal pages' heading levels.** Rich text starts at `h3` under the page's
   `h1` on Privacy, Terms and Disclaimer (both editions) — advisory, not a
   WCAG A/AA failure; a content or design decision.
4. **An upstream React behaviour, mitigated where it was seen.** The React
   bundled with Next.js 15.5.25 (`19.2.0-canary-0bdb9206-20250818`) can drop a
   ping that arrives during a render — `pingSuspendedRoot` neither restarts
   the render nor records the ping there, and its source marks the case TODO —
   which leaves a client navigation uncommitted. The release-candidate gate
   caught it on the component screens (defect 6 in the acceptance matrix):
   creating and deleting a component now navigate with the browser, and
   `tests/stress/create-navigation.stress.mts` holds both under load. It was
   not seen anywhere else in the gate's runs, but any client transition is
   exposed in principle; the remedy is a Next.js/React release that fixes it,
   taken in a maintenance batch through the full gate.

## Gate record

*Recorded in the documentation-only commit that follows the RC commit:* the
fresh-clone result, `npm test` ×3, `npm run test:browser` ×3, the stress
suite and the intermittent targets, the GitHub CI run and its jobs, and the
manually dispatched Stress run — each on the RC SHA.
