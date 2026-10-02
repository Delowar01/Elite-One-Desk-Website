# Visual Editor V1 — release candidate

**Status: release candidate `visual-editor-v1-rc`, awaiting independent
review. Not deployed.** Batches 19B and 19C did not access the VPS or
production, did not run the CTA audit or the temporary-password check against
production, did not change `deploy/previous-release`, and did not start Batch
20. The production-deployment decision is not made here.

| | |
|---|---|
| Release candidate | **`visual-editor-v1-rc`** — an annotated tag on the exact commit the 19C gate certified, whose message records that gate. This file never names its own commit: a document cannot hold the hash of the commit that holds it, and a documentation commit made after the candidate would not be the candidate. Batch 20 deploys the SHA the reviewer approves, with `RELEASE_SHA` (below). |
| Date | 2026-10-02 |
| Baseline | `3d98b81` (Batch 19B's certified candidate, approved) and the 19C correction |
| Previous production release | `b807663` (`deploy/previous-release`, unchanged) |
| Acceptance matrix | [`visual-editor-v1-acceptance.md`](visual-editor-v1-acceptance.md) — 268 requirements: 261 PASS, 7 PASS WITH DOCUMENTED LIMITATION, 0 FAIL — and its 19C addendum |
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
- **Temporary passwords are enforced (19C).** An account an admin created, or
  whose password an admin set, signs in and is then held on
  `/admin/change-password` — no other admin page, Server Action, export or
  draft preview answers it — until it has chosen its own password, which signs
  every one of its sessions out. Accounts already carrying the flag in
  production are honoured as they are; `npm run db:check-password-flags`
  (read-only) says how many there are before the switch (`DEPLOYMENT.md`,
  "Temporary passwords").
- **Admin forms always show their answer (19C).** A save on any admin screen
  could leave its button on "Saving…" after the server had saved, until the
  next click or keystroke; the forms now see their answer onto the screen
  themselves (reviewer item 4 below).
- **Exact-SHA releases (19C).** `deploy.sh` deploys the commit named by
  `RELEASE_SHA` and nothing else (`DEPLOYMENT.md` §9, "Which commit is
  released").

## Required deployment order

`deploy/deploy.sh` enforces this order (`DEPLOYMENT.md` §9,
`docs/release/permission-upgrade.md`):

1. Clean production tree; fetch; fix the target **once** — `RELEASE_SHA`, a
   full sha on `origin/main`; build that commit in a throw-away worktree:
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
7. Verify the checkout and the runtime marker equal `RELEASE_SHA`; health
   checks.

## Before the switch — the production gates (for Batch 20)

Batches 19B and 19C performed **none** of these.

1. Take the SHA the reviewer approved — the target of the tag
   `visual-editor-v1-rc` — and release exactly that:
   `sudo RELEASE_SHA=<the approved sha> …/deploy/deploy.sh`. **Never "the
   latest `main`".** `deploy.sh` refuses anything but a full sha on
   `origin/main`, and its log must read `target  : <the approved sha>
   (RELEASE_SHA)`.
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
8. Run the temporary-password check (`npm run db:check-password-flags`,
   read-only; `-- --list` for an authorised operator) from the release's
   checkout against the same restored backup, and tell the people it lists
   that they will choose a new password at their next sign-in. Nothing clears
   the flag for them.
9. Only then perform the release switch.
10. Run the production smoke tests (below).
11. Run the CTA audit again after release if the runbook requires it, before
    editors work on the affected sections.
12. Verify permissions: every role's grants against the preflight matrix.
13. Verify the public site in English and Arabic.
14. Verify the Visual Editor: open, select, save a draft, preview, discard.
15. Keep the rollback runtime (`standalone.rollback-<sha>-<time>`) until the
    release has proved itself.

## After the switch — health checks

- `deploy.sh`: `systemctl is-active elite-one-desk.service`; the checkout and
  the runtime marker equal `RELEASE_SHA`; `http://127.0.0.1:3000/` with
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

## For the reviewer

**Resolved in 19C:**

1. **`mustChangePassword` is enforced** — at the session boundary, not in the
   browser: `getSession()` returns nothing for a flagged account, so every
   page guard, Server Action, loader, the export and the draft preview refuse
   it as they refuse a stranger, and the guards send it to
   `/admin/change-password`. There it may change its password (session, its
   token, the current password, the policy, a confirmation, not the same
   password; every session ends and it signs in again) or sign out. Sign-in on
   a temporary password goes there whatever `next` said. Creation and an
   admin's reset of somebody else keep setting the flag, and say so; a reset
   ends that account's sessions; a self-reset is not temporary and is logged
   as `user.password_self_reset`. Flagged rows already in production are
   honoured. Held by `tests/password-change.test.ts` and the
   `password-change` probe.
2. **Releases name their commit.** `deploy.sh` used to release whatever
   `origin/main` held when it fetched; it now deploys `RELEASE_SHA` — held by
   `tests/deploy-target.test.ts` — and the runbook above never relies on
   "the latest main".

**Still open:**

3. **Next.js 16** would clear the build-time `postcss` advisory; it is a
   framework migration and was not performed.
4. **An upstream React behaviour, mitigated where it was seen.** The React
   bundled with Next.js 15.5.25 (`19.2.0-canary-0bdb9206-20250818`) can drop a
   ping that arrives during a render — `pingSuspendedRoot` neither restarts
   the render nor records the ping there, and its source marks the case TODO —
   which leaves a transition suspended with nothing scheduled to finish it.
   The 19B gate caught it as a component screen that did not move after
   *Create draft* (defect 6): creating and deleting a component navigate with
   the browser, held by `tests/stress/create-navigation.stress.mts`. 19C's
   browser scenario caught it again on the admin forms: the server saved, and
   the button stayed on "Saving…" until the next keystroke or click — 23 of 72
   cold saves on the Users and FAQ screens, and 8 of 36 on the 19B candidate,
   so it was not new. The root, read while stalled, was in defect 6's state
   every time (one transition lane pending, suspended and entangled, no ping,
   no callback). Every admin form now goes through `useSettledActionState`
   (`src/components/admin/form.tsx`), which, once the server has answered,
   schedules the one update React needs to finish the render; held by
   `tests/stress/admin-form-settle.stress.mts` (with the update taken out:
   34/36 and 28/36, and 31/36 and 25/36 on the final form of the hook; with
   it: 36/36 and 36/36). The remedy is still a Next.js/React release
   that fixes it, taken in a maintenance batch through the full gate.
5. **Legal pages' heading levels.** Rich text starts at `h3` under the page's
   `h1` on Privacy, Terms and Disclaimer (both editions) — advisory, not a
   WCAG A/AA failure; a content or design decision.

## Gate record

### 19C — the candidate

The candidate is certified on its own exact commit, and every gate runs on
that commit: the pre-change gate on the approved `main` before any change;
`npm test` three times; the browser suite three times; the complete stress
suite; the permissions, reusable, Undo/Compare, layout-styles, advanced-motion,
motion-15b, layers-editing and hardening probes ten times each; admin-section,
revision-pairing and recovery twenty times each; create-navigation,
editor-cleanup and editor-performance; lint, typecheck and a cold build with
no database; schema compatibility, the permission-upgrade rehearsal, the
dependency-advisory and CTA-audit tests; a fresh clone (clean `npm ci`, the
pinned Chromium, lint, typecheck, cold build, `npm test`, browser, stress,
cleanup); GitHub CI's four jobs on that commit; and the Stress workflow
dispatched on that commit.

**Where the record is.** Not in this file. A commit cannot name itself, and a
record added by a later commit would make the documentation commit — not the
certified one — the tip of `main`, which is what 19B did (its gate record
below was committed after `3d98b81`). The 19C record travels with the
candidate instead: in the message of the annotated tag `visual-editor-v1-rc`,
which points at the exact commit, and in the 19C report.

### 19B — `3d98b81`, approved

The release candidate was `3d98b8173c3cadd73df90c75532ea46fa97091a7`, and
every gate below ran on it. The commit that followed it changed documentation
only: this record, and the editor's measured figures in the acceptance
matrix, quoted from this run.

**How it got here.** The first candidate, `b9cefc5`, passed GitHub CI
([36922104345](https://github.com/Delowar01/Elite-One-Desk-Website/actions/runs/36922104345))
and the dispatched Stress run
([36922126400](https://github.com/Delowar01/Elite-One-Desk-Website/actions/runs/36922126400)).
The fresh-clone gate then found defect 6 in its second browser run: creating a
component could leave the screen on the list. The gate was stopped, the defect
root-caused and fixed in `3d98b81` with its regressions (acceptance matrix,
defect 6), and the complete gate was run again on `3d98b81`.

**Fresh clone (§37).** `git clone` of `origin/main`, checked out at the RC SHA,
with nothing copied from a working checkout (no `.data`, `.env`, `node_modules`
or `.next`). The one deviation, as in 19A: the sandbox cannot run
`npx playwright install`, so Chromium came from
`PLAYWRIGHT_CHROMIUM_EXECUTABLE`; the GitHub workflows below install the
Chromium `package-lock.json` pins and ran the same probes with it. The
session's worker restarted once during step 4's build; the gate resumed from
its step markers and ran step 4 again in full.

| Gate | Result |
|---|---|
| The deploy's own install — `npm ci --include=dev --ignore-scripts`, `npm rebuild sharp`, `npm run build` | exit 0, 0, 0; `media-pipeline` and `dependency-advisories` on that install: 8 of 8 |
| Clean `npm ci`, test settings from `tests/browser/.env.example` | exit 0; `sharp` 0.35.5, libvips 8.18.7, libheif 1.23.5; no application `.env` |
| `npm run lint` · `npm run typecheck` · cold `npm run build` with no database | exit 0 · exit 0 · exit 0 |
| `npm test` ×3 (§38) | 1,590 tests, 338 suites, 0 failed, 0 skipped — each run (181 s, 163 s, 167 s) |
| `npm run test:browser` ×3 (§39) | 30/30 clean, 1,131 PASS, 0 FAIL — each run (1,264 s, 1,278 s, 1,283 s) |
| `npm run test:stress`, complete (§40) | 13/13 clean, 114 PASS, 0 FAIL (1,131 s) |
| The intermittent targets ×3 — `quick-links-selection`, `entrance-parallax`, `replay-selection`, `restore-selection`, and `create-navigation` (defect 6) | 15/15 clean, 123 PASS, 0 FAIL — three runs of each; with the complete run, `create-navigation` landed 360 of 360 creates and 120 of 120 deletes |
| `npm run test:cleanup` | listed three databases left by runs stopped earlier in the session (none from this gate's scripts) and the staged server trees; `--yes` removed them; the clone's worktree had no changes |
| `npm audit` | 8 vulnerable packages, 5 moderate and 3 high — the table above |
| Evidence | every check the acceptance matrix cites (268 rows) and every citation in its prose (53) found, passing, in each browser run's own output, with `npm test` run 1 and the complete stress run; `editor-performance` on the RC: opens in 3.1 s, 199 Layers rows with no long task, a selection in a median 0.33 s, heap 11.4 → 11.8 MB after forty selections, worst typing task 62 ms |

**GitHub (§41), on the same SHA:**

| Workflow | Run | Jobs | Result |
|---|---|---|---|
| CI (push to `main`) | [36935649184](https://github.com/Delowar01/Elite-One-Desk-Website/actions/runs/36935649184) | Static — install, lint, typecheck, cold build (110615152624) · Tests — tracked suite on PostgreSQL 16 (110615152246) · Security and compatibility — schema, permission upgrade, isolation, DDL (110615152581) · Browser QA — thirty probes (110615152504): 30/30 clean, 1,131 PASS, 0 FAIL | success, all four |
| Stress (dispatched by hand) | [36935656611](https://github.com/Delowar01/Elite-One-Desk-Website/actions/runs/36935656611) | Stress suite on isolated databases (110615182853): 13/13 clean, 114 PASS, 0 FAIL | success |

**No ignored QA (§42).** All thirty probes and thirteen stress scripts were
tracked and listed in their `expected.json` (19C adds one of each); the runner
fails a script whose PASS count differs from it. Nothing imports from `.data/`, no Chromium path is
committed, no workflow step continues on error, nothing is retried, and no
check was removed or weakened.
