#!/usr/bin/env bash
#
# Elite One Desk — release script.
#
#   sudo /var/www/elite-one-desk/app/deploy/deploy.sh
#
# Run it as root (or through sudo). Every git, npm and build command is dropped
# to ${APP_USER} so nothing under the application ever becomes root-owned; only
# systemctl, the backup and the moves inside /app are done with privilege. It
# can also be run as ${APP_USER} directly, provided that account may run
# `sudo systemctl`.
#
# ---------------------------------------------------------------------------
# The shape of a release
#
# The old version of this script built inside /var/www/elite-one-desk/app —
# the same directory systemd runs from, and the same .next/standalone the live
# process is reading. `next build` rewrites that directory, so a release was
# editing the running application in place: a build that failed halfway left
# production in a state nobody had ever tested, and a build that succeeded
# still swapped chunks under a process that was serving requests.
#
# This version never builds in /app. It checks the target commit out into a
# throwaway git worktree, installs, lints, typechecks and builds there, and
# only touches production once a complete, verified runtime exists on disk.
# Everything before the switch is reversible by doing nothing at all.
#
#   1  refuse to run unless the production tree is completely clean
#   2  fetch; compare the checkout AND the running runtime against the target
#   3  build worktree at TARGET_SHA, with a copy of the production .env
#   4  npm ci --include=dev, rebuild sharp, lint, typecheck, build
#   5  stamp the built runtime with its release sha
#   6  back up the database and uploads
#   7  migrate and seed, from the verified build
#   8  stage the new runtime, stop the service, rename it into place
#   9  move the production tree to TARGET_SHA, start, health-check
#  10  on any failure after the switch: restore the previous runtime
#
# ---------------------------------------------------------------------------
# What is running, versus what git says is running
#
# Git HEAD is not evidence. A release that fails after step 9 has moved the
# checkout, a hand-run `next build`, a half-finished manual recovery — each
# leaves the checkout on one commit and the live .next/standalone on another,
# and nothing in git can tell you so.
#
# So every runtime this script builds is stamped with the commit it came from,
# in `.next/standalone/.eod-release-sha`, before it is staged. The stamp
# travels with the directory through both renames, which means the runtime
# that gets displaced keeps the stamp of the release it actually is, and the
# kept rollback copy is self-describing.
#
# At startup the script reads both. Checkout and runtime both at the target is
# the only case that exits without doing anything; a checkout at the target
# with a runtime that is older, or unmarked, is RELEASE DRIFT and is repaired
# by running the release in full.
#
# ---------------------------------------------------------------------------
# WHAT ROLLBACK DOES NOT DO — read this before writing a migration
#
# Rollback restores the previous .next/standalone runtime and resets the git
# tree. It does NOT, and will never, reverse a database migration: an
# automatic `down` on live customer data is far more dangerous than the
# failure it is trying to fix.
#
# Every migration must therefore be BACKWARD-COMPATIBLE with the release
# before it — add columns, do not rename or drop them in the same release;
# make new columns nullable or give them a default; remove a column only in a
# later release, once nothing reads it. If a migration cannot be written that
# way, the release is not a deploy, it is a maintenance window, and the
# database must be restored from the backup this script takes at step 5.
#
# ---------------------------------------------------------------------------
# Secrets
#
# .env is copied with `install`, never read, echoed, diffed or logged, and the
# copy is mode 600 owned by ${APP_USER}. Do not add `set -x` to this script.

# -E so the ERR trap fires inside functions too; without it a failure during
# the runtime switch would exit without restoring anything.
set -Eeuo pipefail

# ---------------------------------------------------------------------------
# Step 13 moves the production tree to a new commit — which rewrites this very
# file while bash is still reading it, and bash reads a script incrementally.
# Run from a private copy so the release cannot corrupt its own instructions.
# ---------------------------------------------------------------------------
# The copy is this script and nothing else — no configuration is written into
# it and no secret is ever placed in it.
if [[ -z "${EOD_DEPLOY_SELF:-}" ]]; then
  EOD_DEPLOY_SELF="$(mktemp "${TMPDIR:-/tmp}/eod-deploy.XXXXXXXX.sh")"
  cat -- "${BASH_SOURCE[0]}" >"${EOD_DEPLOY_SELF}"
  chmod 0700 "${EOD_DEPLOY_SELF}"
  export EOD_DEPLOY_SELF
  exec /usr/bin/env bash "${EOD_DEPLOY_SELF}" "$@"
fi
# EXIT covers a normal finish, a `die`, an errexit abort and every `exit` in
# this script; INT/TERM/HUP are trapped so that a Ctrl-C or a closed session
# reaches that EXIT rather than leaving the copy behind.
cleanup_self() { rm -f "${EOD_DEPLOY_SELF}"; }
trap cleanup_self EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

# ---------------------------------------------------------------------------
# Configuration. Every value can be overridden from the environment.
# ---------------------------------------------------------------------------
APP_ROOT="${APP_ROOT:-/var/www/elite-one-desk}"
APP_DIR="${APP_DIR:-${APP_ROOT}/app}"
APP_USER="${APP_USER:-eliteonedesk}"
APP_GROUP="${APP_GROUP:-${APP_USER}}"
SERVICE="${SERVICE:-elite-one-desk.service}"
BRANCH="${BRANCH:-main}"
BACKUP_CMD="${BACKUP_CMD:-/usr/local/bin/elite-one-desk-backup}"
# Only read, never written to by this script — it is where deploy/backup.sh
# puts its dumps, and this script looks there afterwards to name the dump it
# caused, so a rollback can point at a specific file.
BACKUP_DIR="${BACKUP_DIR:-/var/backups/elite-one-desk}"

PUBLIC_HOST="${PUBLIC_HOST:-eliteonedesk.com}"
APP_PORT="${APP_PORT:-3000}"

HEALTH_RETRIES="${HEALTH_RETRIES:-15}"   # Next needs a few seconds to listen
HEALTH_DELAY="${HEALTH_DELAY:-2}"
HTTP_TIMEOUT="${HTTP_TIMEOUT:-10}"

# The two public checks go out to DNS and back through nginx. On a host that
# cannot reach its own public name (hairpin NAT, split-horizon DNS) set this to
# 0: the checks still run and are still reported, they just stop being a reason
# to roll a good release back.
PUBLIC_HEALTHCHECK_REQUIRED="${PUBLIC_HEALTHCHECK_REQUIRED:-1}"

# Re-deploy a commit production is already on — for finishing a release that
# died partway through.
FORCE_REDEPLOY="${FORCE_REDEPLOY:-0}"

STAMP="$(date -u +%Y%m%d-%H%M%S)"
RUN_USER="$(id -un)"

STANDALONE_DIR="${APP_DIR}/.next/standalone"
STAGE_DIR="${APP_DIR}/.next/standalone.incoming"

# Written into every runtime this script builds, and carried with it by the
# rename. It is how the script knows what is actually RUNNING, rather than what
# git says should be running — the two drift whenever a release fails after the
# checkout moved, or somebody rebuilds by hand. It holds a commit sha and
# nothing else; there is no secret in it.
RELEASE_MARKER=".eod-release-sha"

ROLLBACK_ARMED=0
ROLLBACK_RUNTIME=""
FAILED_RUNTIME=""
BUILD_DIR=""
CURRENT_SHA=""
TARGET_SHA=""
CURRENT_RUNTIME_SHA=""
BACKUP_FILES=""

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log()  { printf '==> %s\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '!!  %s\n' "$*" >&2; }
die()  { printf '!!  %s\n' "$*" >&2; exit 1; }

# Run a command as the application user, in a given directory. printf %q
# quotes each argument so paths with spaces survive the trip through sudo.
as_app() {
  local wd="$1"; shift
  if [[ "${RUN_USER}" == "${APP_USER}" ]]; then
    ( cd "${wd}" && "$@" )
  else
    sudo -u "${APP_USER}" -H bash -c "cd $(printf '%q' "${wd}") && $(printf '%q ' "$@")"
  fi
}

# Run a command with privilege. Used only for systemctl, the backup, and the
# handful of moves and chowns inside /app.
as_root() {
  if [[ "${RUN_USER}" == "root" ]]; then
    "$@"
  else
    sudo "$@"
  fi
}

own_app() { as_root chown -R "${APP_USER}:${APP_GROUP}" "$1"; }

# `next build` copies .env verbatim into .next/standalone/.env — so the build
# worktree, the staged runtime and every kept rollback copy contain DATABASE_URL
# and AUTH_SECRET. The live one is protected by /app; these are not, so each new
# directory this script creates outside /app is closed to everyone but its owner.
seal_dir() {
  local dir="$1"
  [[ -d "${dir}" ]] || return 0
  as_root chmod 0700 "${dir}"
}
seal_env() {
  local dir="$1" f
  for f in "${dir}/.env" "${dir}/.next/standalone/.env"; do
    if [[ -f "${f}" ]]; then
      as_root chmod 0600 "${f}"
    fi
  done
}

# Prints the release sha a runtime directory is marked with, or nothing at all
# for a legacy runtime that predates the marker. Read with privilege because a
# kept rollback runtime is mode 0700.
runtime_marker() {
  local out
  # cat alone: a missing file simply yields nothing, which is exactly what an
  # unmarked runtime should read as.
  out="$(as_root cat "$1/${RELEASE_MARKER}" 2>/dev/null || true)"
  printf '%s' "${out//[[:space:]]/}"
}

# Prints the HTTP status, or 000 when curl could not complete the request.
http_code() {
  curl -sS -o /dev/null -w '%{http_code}' --max-time "${HTTP_TIMEOUT}" "$@" 2>/dev/null \
    || printf '000'
}

# Retries until the address answers 2xx. Prints the last status seen.
wait_for_http() {
  local code="000" i
  for (( i = 0; i < HEALTH_RETRIES; i++ )); do
    code="$(http_code "$@")"
    if [[ "${code}" =~ ^2[0-9][0-9]$ ]]; then
      printf '%s' "${code}"
      return 0
    fi
    sleep "${HEALTH_DELAY}"
  done
  printf '%s' "${code}"
  return 1
}

check_local()  { wait_for_http -H "Host: ${PUBLIC_HOST}" -H 'X-Forwarded-Proto: https' "http://127.0.0.1:${APP_PORT}/"; }
check_public() { wait_for_http "https://${PUBLIC_HOST}/"; }
check_admin()  { wait_for_http "https://${PUBLIC_HOST}/admin/login"; }

service_state() { systemctl is-active "${SERVICE}" 2>/dev/null || true; }

# Put the previous runtime back where systemd expects to find it. The failed
# one is moved aside rather than deleted, so it can be looked at afterwards.
# Every rename here uses `mv -T`. Without it, `mv src dst` where dst already
# exists moves src *inside* dst — which during a rollback would bury the
# previous runtime one level down instead of restoring it.
# Returns 0 ONLY if the previous runtime is genuinely back at STANDALONE_DIR.
# Every caller reports what this returns rather than assuming it worked.
restore_runtime() {
  if [[ -z "${ROLLBACK_RUNTIME}" || ! -d "${ROLLBACK_RUNTIME}" ]]; then
    warn "no previous runtime at ${ROLLBACK_RUNTIME:-<none>} — nothing to restore"
    return 1
  fi
  if [[ -e "${STANDALONE_DIR}" ]]; then
    if as_root mv -T "${STANDALONE_DIR}" "${FAILED_RUNTIME}"; then
      seal_dir "${FAILED_RUNTIME}" || true
    else
      warn "could not move the failed runtime out of ${STANDALONE_DIR}"
    fi
  fi
  if [[ -e "${STANDALONE_DIR}" ]]; then
    warn "${STANDALONE_DIR} is still occupied — refusing to restore on top of it"
    return 1
  fi
  if ! as_root mv -T "${ROLLBACK_RUNTIME}" "${STANDALONE_DIR}"; then
    warn "could not move ${ROLLBACK_RUNTIME} back to ${STANDALONE_DIR}"
    return 1
  fi
  own_app "${STANDALONE_DIR}" || warn "restored the runtime but could not chown it"
  [[ -d "${STANDALONE_DIR}" ]] || return 1
  return 0
}

rollback() {
  local reason="$1"
  # Disarm both safety nets first: bash runs an ERR trap whether or not
  # errexit is on, and a rollback that re-entered itself would be worse than
  # the failure it is cleaning up after.
  trap - ERR
  ROLLBACK_ARMED=0
  set +e
  warn "ROLLBACK — ${reason}"

  # Each step reports what it actually did. Nothing below prints DONE unless
  # the command that would have done it returned success.
  local stop_status="FAILED" runtime_status="FAILED" git_status="FAILED"
  local start_status="SKIPPED" health_status="SKIPPED" marker_status="not checked"
  local marker code complete=1 service_down=0

  # Stop first, then ask systemd what the unit is ACTUALLY doing. The command
  # returning 0 is not the same fact as the process being gone, and the
  # difference matters: renaming .next/standalone out from under a server that
  # is still reading it turns a bad release into an outage.
  if as_root systemctl stop "${SERVICE}"; then
    stop_status="DONE"
  else
    stop_status="FAILED"
    warn "systemctl stop ${SERVICE} returned an error"
  fi
  if systemctl is-active --quiet "${SERVICE}"; then
    service_down=0
    stop_status="FAILED — ${SERVICE} is still active"
  else
    service_down=1
    if [[ "${stop_status}" == "FAILED" ]]; then
      stop_status="FAILED (command), but the unit is inactive"
    fi
  fi

  # Only touch the runtime directories once systemd has confirmed the unit is
  # down. If it is not, nothing is moved — a failed release left in place is
  # recoverable; a half-swapped directory under a live process is not.
  if (( service_down == 1 )); then
    if restore_runtime; then
      runtime_status="DONE"
    fi
  else
    runtime_status="NOT ATTEMPTED — ${SERVICE} would not stop"
    warn "${SERVICE} is still active. Refusing to move runtime directories"
    warn "underneath a running process. Nothing has been switched back."
  fi

  # The checkout is reset either way, and deliberately so. If the runtime could
  # not be restored, the live code is the failed release while the checkout
  # says ${CURRENT_SHA} — which is exactly the drift the release marker exists
  # to catch, so the next run repairs it instead of reporting "already
  # deployed" over a broken release.
  if [[ -n "${CURRENT_SHA}" ]]; then
    info "resetting ${APP_DIR} to ${CURRENT_SHA}"
    if as_app "${APP_DIR}" git reset --hard "${CURRENT_SHA}"; then
      git_status="DONE"
    else
      warn "could not reset ${APP_DIR} to ${CURRENT_SHA}"
    fi
  fi

  # Verify what is actually sitting in the runtime directory now. A runtime
  # from before the marker existed is not a failure — it is just unmarked.
  if [[ "${runtime_status}" == "DONE" ]]; then
    marker="$(runtime_marker "${STANDALONE_DIR}")"
    if [[ -z "${marker}" ]]; then
      marker_status="legacy/unmarked"
    elif [[ "${marker}" == "${CURRENT_SHA}" ]]; then
      marker_status="OK (${marker})"
    else
      marker_status="MISMATCH (${marker}, expected ${CURRENT_SHA})"
    fi
  fi

  if (( service_down == 0 )); then
    # It was never stopped, so there is nothing to start — and whatever answers
    # now is the release that just failed, not a restored one.
    start_status="NOT ATTEMPTED — the unit was never stopped"
    code="$(check_local)"
    health_status="${code} — from the FAILED release, which is still live"
  elif [[ -d "${STANDALONE_DIR}" ]]; then
    # Only start a service that has a runtime to start. Starting systemd on an
    # empty directory produces a crash loop and tells nobody anything.
    if as_root systemctl start "${SERVICE}"; then
      start_status="DONE"
      sleep "${HEALTH_DELAY}"
      code="$(check_local)"
      if [[ "${code}" =~ ^2[0-9][0-9]$ ]]; then
        health_status="${code}"
      else
        health_status="FAILED (HTTP ${code})"
      fi
    else
      start_status="FAILED"
      warn "could not start ${SERVICE}"
    fi
  else
    warn "${STANDALONE_DIR} does not exist — not starting ${SERVICE} on a missing runtime"
  fi

  # FULL only if every step of the rollback actually did what it was asked —
  # the stop included, because everything after it depends on the unit being
  # genuinely down.
  [[ "${stop_status}" == "DONE" ]] || complete=0
  [[ "${runtime_status}" == "DONE" ]] || complete=0
  [[ "${git_status}" == "DONE" ]] || complete=0
  [[ "${start_status}" == "DONE" ]] || complete=0
  [[ "${health_status}" =~ ^2[0-9][0-9]$ ]] || complete=0
  if [[ "${marker_status}" == MISMATCH* ]]; then complete=0; fi

  printf '\n'
  if (( complete == 1 )); then
    warn "FULL RUNTIME ROLLBACK COMPLETED — production is back on ${CURRENT_SHA}"
  else
    warn "ROLLBACK INCOMPLETE — MANUAL RECOVERY REQUIRED"
  fi
  info "service stop      : ${stop_status}"
  info "runtime rollback  : ${runtime_status}"
  info "git rollback      : ${git_status}"
  info "service start     : ${start_status}"
  info "restored health   : ${health_status}"
  info "runtime marker    : ${marker_status}"
  info "DATABASE rollback : NOT DONE — see below"
  info "failed runtime    : ${FAILED_RUNTIME:-none kept}"
  info "build worktree    : ${BUILD_DIR:-none}"
  printf '\n'

  if [[ "${runtime_status}" == "NOT ATTEMPTED"* ]]; then
    warn "NOTHING WAS SWITCHED BACK. ${SERVICE} would not stop, and moving a"
    warn "runtime underneath a live process is how a bad release becomes an"
    warn "outage. THE FAILED RELEASE IS STILL INSTALLED AND STILL SERVING."
    warn "  failed release   : ${STANDALONE_DIR} (marked ${TARGET_SHA})"
    warn "  previous runtime : ${ROLLBACK_RUNTIME:-<none was recorded>}"
    warn "Stop the unit first, confirm it is down, then switch it back:"
    warn "    systemctl status ${SERVICE} --no-pager"
    warn "    journalctl -u ${SERVICE} -n 100 --no-pager"
    warn "    sudo systemctl stop ${SERVICE}"
    warn "    systemctl is-active ${SERVICE}      # must NOT say active"
    warn "    sudo mv -T ${STANDALONE_DIR} ${FAILED_RUNTIME}"
    warn "    sudo mv -T ${ROLLBACK_RUNTIME:-<previous runtime>} ${STANDALONE_DIR}"
    warn "    sudo chown -R ${APP_USER}:${APP_GROUP} ${STANDALONE_DIR}"
    warn "    sudo systemctl start ${SERVICE}"
    printf '\n' >&2
  elif [[ "${runtime_status}" != "DONE" ]]; then
    warn "THE PREVIOUS RUNTIME IS NOT BACK IN PLACE. Put it back by hand:"
    warn "  previous runtime : ${ROLLBACK_RUNTIME:-<none was recorded>}"
    warn "  must end up at   : ${STANDALONE_DIR}"
    warn "  failed runtime   : ${FAILED_RUNTIME:-<not moved aside>}"
    warn "    sudo systemctl stop ${SERVICE}"
    warn "    sudo mv -T ${STANDALONE_DIR} ${FAILED_RUNTIME}      # only if it is still there"
    warn "    sudo mv -T ${ROLLBACK_RUNTIME:-<previous runtime>} ${STANDALONE_DIR}"
    warn "    sudo chown -R ${APP_USER}:${APP_GROUP} ${STANDALONE_DIR}"
    warn "    sudo systemctl start ${SERVICE}"
    printf '\n' >&2
  fi
  if [[ "${git_status}" != "DONE" ]]; then
    warn "THE CHECKOUT WAS NOT RESET. ${APP_DIR} is NOT known to be on ${CURRENT_SHA}:"
    warn "    sudo -u ${APP_USER} git -C ${APP_DIR} status"
    warn "    sudo -u ${APP_USER} git -C ${APP_DIR} reset --hard ${CURRENT_SHA}"
    printf '\n' >&2
  fi
  if [[ "${start_status}" != "DONE" ]] || ! [[ "${health_status}" =~ ^2[0-9][0-9]$ ]]; then
    warn "THE SERVICE IS NOT KNOWN TO BE SERVING. Look at it before anything else:"
    warn "    systemctl status ${SERVICE} --no-pager"
    warn "    journalctl -u ${SERVICE} -n 100 --no-pager"
    printf '\n' >&2
  fi

  warn "THE DATABASE WAS NOT ROLLED BACK, AND NOTHING WAS RESTORED FROM BACKUP."
  warn "Every migration and every seed row from the failed release is still"
  warn "applied. This script took a dump before touching anything, but it has"
  warn "NOT been loaded and will not be loaded automatically — restoring a"
  warn "database over live data is a decision for a person, not a script."
  if [[ -n "${BACKUP_FILES}" ]]; then
    warn "If the restored release cannot live with the new schema, the dump"
    warn "taken by this run is in ${BACKUP_DIR}:"
    while IFS= read -r line; do warn "  ${line}"; done <<<"${BACKUP_FILES}"
  else
    warn "No dump from this run was identified; look in ${BACKUP_DIR}."
  fi
  exit 1
}

on_err() {
  local code=$?
  trap - ERR
  if (( ROLLBACK_ARMED == 1 )); then
    rollback "unexpected failure (exit ${code})"
  fi
  exit "${code}"
}
trap on_err ERR

# ---------------------------------------------------------------------------
# Preflight
# ---------------------------------------------------------------------------
# Everything this script assumes about the machine, asserted once, before any
# fetch, build or change — and in an order where nothing runs as ${APP_USER}
# until that account and the paths it will be pointed at are known to exist.
# Nothing here installs anything: a missing tool is a reason to stop and tell
# somebody, not to start changing the server.
log "Preflight"

# 1 — privilege. systemctl, the backup and the moves inside /app need root.
#     It has to be proven NOW and without a prompt: a password prompt that
#     appears half-way through can land after the build, after the backup, or
#     between the service stop and the runtime switch, and a release that sits
#     waiting for a human at that point is worse than one that never started.
if (( EUID != 0 )); then
  command -v sudo >/dev/null 2>&1 \
    || die "running as ${RUN_USER} and sudo is not installed — run this as root."
  sudo -n true 2>/dev/null || die \
    "running as ${RUN_USER} and passwordless sudo is not available. Run this as root, or give ${RUN_USER} NOPASSWD sudo. This script will not stop for a password mid-release."
fi

# 2 — every external command this script calls, directly or through as_root
#     and as_app. Shell builtins are not listed; neither is /usr/bin/env, which
#     the self-copy at the top of the file invokes by absolute path long before
#     this check could run. node and npm are checked at step 6 instead, because
#     they have to be on ${APP_USER}'s PATH rather than on this one.
REQUIRED_TOOLS=(
  bash cat chmod chown cp curl date find git id install mkdir mktemp mv rm
  sleep sort systemctl
)
(( EUID == 0 )) || REQUIRED_TOOLS+=(sudo)
for tool in "${REQUIRED_TOOLS[@]}"; do
  command -v "${tool}" >/dev/null 2>&1 || die "${tool} is not installed."
done

# 3 — the application account, before anything is run as it.
id -u "${APP_USER}" >/dev/null 2>&1 || die "user ${APP_USER} does not exist."

# 4 — the paths, before anything is run inside them.
[[ -d "${APP_ROOT}" ]] || die "${APP_ROOT} does not exist."
[[ -d "${APP_DIR}" ]] || die "${APP_DIR} does not exist."
[[ -f "${APP_DIR}/.env" ]] || die "${APP_DIR}/.env is missing — refusing to build without it."

# 5 — a real git checkout, not just a directory with a .git in it. First use
#     of as_app, and only now that ${APP_USER} and ${APP_DIR} are both known good.
as_app "${APP_DIR}" git rev-parse --is-inside-work-tree >/dev/null 2>&1 \
  || die "${APP_DIR} is not a usable git checkout."
as_app "${APP_DIR}" git rev-parse --verify --quiet HEAD >/dev/null \
  || die "${APP_DIR} has no HEAD commit."

# 6 — node is what the unit runs, npm is what builds. Both must be on the
#     APPLICATION user's PATH, which is not necessarily this shell's.
as_app "${APP_DIR}" bash -c 'command -v node >/dev/null && command -v npm >/dev/null' \
  || die "node and npm must both be on ${APP_USER}'s PATH."

# 7 — the unit this script is going to stop and start.
systemctl cat "${SERVICE}" >/dev/null 2>&1 \
  || die "systemd knows nothing about ${SERVICE}."

# 8 — the backup that has to succeed before any migration runs.
[[ -x "${BACKUP_CMD}" ]] || die "backup command ${BACKUP_CMD} is missing or not executable."
[[ -d "${BACKUP_DIR}" ]] || warn "${BACKUP_DIR} does not exist yet — the backup should create it."

info "running as ${RUN_USER}, building as ${APP_USER}"
info "service ${SERVICE}, branch ${BRANCH}, backups in ${BACKUP_DIR}"

# --- 1. the production tree must be completely clean -------------------------
# ANY working-tree change cancels the release: modified, staged, deleted or
# untracked. Untracked files are not a nicety here — `git reset --hard` at step
# 13 will delete an untracked file or directory that stands where the target
# commit needs to write a tracked path, so an untracked file genuinely can be
# destroyed by this script. A production deployment therefore requires a
# spotless tree.
#
# Nothing is ever resolved automatically: no reset, no checkout, no stash, no
# `git clean`, nothing deleted. The status is printed and a human decides.
#
# (.env, .next/ and node_modules/ are gitignored, so a normal production
# checkout is clean and this check is silent.)
log "Checking the production working tree"
DIRTY="$(as_app "${APP_DIR}" git status --porcelain)"
if [[ -n "${DIRTY}" ]]; then
  warn "${APP_DIR} is not clean:"
  printf '%s\n' "${DIRTY}" >&2
  warn ""
  warn "  ' M' modified   'D ' deleted   'A ' staged   '??' untracked"
  warn ""
  warn "DEPLOYMENT CANCELLED. Nothing has been fetched, built, backed up or"
  warn "changed. Commit, revert or move these aside by hand — this script will"
  warn "not stash, clean or delete anything for you — then run it again."
  exit 1
fi
info "clean"

# --- 2/3. what is running, and what we are moving to ------------------------
log "Fetching origin/${BRANCH}"
as_app "${APP_DIR}" git fetch --prune origin "${BRANCH}"

CURRENT_SHA="$(as_app "${APP_DIR}" git rev-parse HEAD)"
TARGET_SHA="$(as_app "${APP_DIR}" git rev-parse "origin/${BRANCH}")"
SHORT_SHA="${TARGET_SHA:0:7}"

# What is actually RUNNING, which is not the same question as what git says.
# A release that failed after the checkout moved, or a hand-run `next build`,
# leaves HEAD at one commit and the live runtime at another, and git alone
# cannot tell the difference.
CURRENT_RUNTIME_SHA="$(runtime_marker "${STANDALONE_DIR}")"
RUNTIME_DESC="${CURRENT_RUNTIME_SHA:-unmarked (legacy runtime, or none installed)}"
info "checkout: ${CURRENT_SHA}"
info "runtime : ${RUNTIME_DESC}"
info "target  : ${TARGET_SHA}"

if [[ "${CURRENT_SHA}" == "${TARGET_SHA}" && "${CURRENT_RUNTIME_SHA}" == "${TARGET_SHA}" ]]; then
  # A — checkout and runtime both already at the target.
  if [[ "${FORCE_REDEPLOY}" != "1" ]]; then
    log "Already deployed: checkout and runtime are both ${TARGET_SHA} — nothing to do."
    exit 0
  fi
  info "FORCE_REDEPLOY=1 — rebuilding the commit already deployed"
elif [[ "${CURRENT_SHA}" == "${TARGET_SHA}" ]]; then
  # B — RELEASE DRIFT. git is where it should be; the running code is not.
  # Exiting 0 here would report a healthy deployment while production serves
  # something else, so the release runs in full and makes the two agree.
  warn "RELEASE DRIFT — the checkout is at ${TARGET_SHA} but the live runtime is"
  warn "${RUNTIME_DESC}. Git HEAD is not proof of what is running."
  warn "Redeploying ${TARGET_SHA} so the checkout and the runtime agree."
fi
# C — anything else is an ordinary deployment.

# --- 4. isolated build worktree ---------------------------------------------
BUILD_DIR="${APP_ROOT}/build-${SHORT_SHA}-${STAMP}"
log "Creating the build worktree ${BUILD_DIR}"
# Created with privilege and handed to the app user, because APP_ROOT itself
# may not be writable by it. git accepts an existing empty directory.
as_app "${APP_DIR}" git worktree prune   # forget build dirs already deleted
as_root mkdir -p "${BUILD_DIR}"
own_app "${BUILD_DIR}"
seal_dir "${BUILD_DIR}"
as_app "${APP_DIR}" git worktree add --detach "${BUILD_DIR}" "${TARGET_SHA}"

# --- 5. the production .env, and only the production .env --------------------
# seal_env is called after the build too: Next copies .env into the standalone
# output, and that copy inherits whatever mode the source had.
log "Copying the production environment into the build"
as_root install -o "${APP_USER}" -g "${APP_GROUP}" -m 600 "${APP_DIR}/.env" "${BUILD_DIR}/.env"
info "${BUILD_DIR}/.env (600 ${APP_USER}:${APP_GROUP}) — contents never printed"

# --- 6. install and verify, entirely outside production ----------------------
# --include=dev is deliberate: typescript, tailwindcss, @tailwindcss/postcss,
# eslint and tsx live in devDependencies, and `next build`, `npm run lint`,
# `npm run typecheck` and both db: scripts do not exist without them.
# --ignore-scripts keeps third-party install hooks out of a production build;
# sharp is the one package that genuinely needs its own, so it is rebuilt by
# name immediately afterwards. `npm audit fix` is never run here — a release is
# not the place to discover a new dependency tree.
log "Installing dependencies"
as_app "${BUILD_DIR}" npm ci --include=dev --ignore-scripts
as_app "${BUILD_DIR}" npm rebuild sharp

log "Linting"
as_app "${BUILD_DIR}" npm run lint

log "Typechecking"
as_app "${BUILD_DIR}" npm run typecheck

log "Building"
as_app "${BUILD_DIR}" npm run build
info "build verified — production has not been touched yet"

# --- 7. finish the standalone runtime inside the build -----------------------
# `output: standalone` copies neither .next/static nor public; without them the
# server has no stylesheets, no fonts and no artwork.
log "Assembling the standalone runtime"
as_app "${BUILD_DIR}" bash -c '
  set -euo pipefail
  rm -rf .next/standalone/.next/static .next/standalone/public
  cp -r .next/static .next/standalone/.next/static
  cp -r public .next/standalone/public
  # systemd lists this path in ReadWritePaths; with ProtectSystem=strict the
  # unit fails to start if it does not exist.
  mkdir -p .next/standalone/.next/cache
  chmod u+rwX .next/standalone/.next/cache
  # Stamp the runtime with the commit it was built from, BEFORE it is staged,
  # so the marker travels with the directory through both renames and the
  # runtime that is displaced keeps the marker of the release it is.
  printf "%s\\n" "$2" > ".next/standalone/$1"
  chmod 0644 ".next/standalone/$1"
' _ "${RELEASE_MARKER}" "${TARGET_SHA}"
[[ -f "${BUILD_DIR}/.next/standalone/server.js" ]] \
  || die "the build produced no .next/standalone/server.js — aborting before any change."
BUILT_MARKER="$(as_app "${BUILD_DIR}" cat ".next/standalone/${RELEASE_MARKER}" 2>/dev/null || true)"
[[ "${BUILT_MARKER//[[:space:]]/}" == "${TARGET_SHA}" ]] \
  || die "the build is not marked ${TARGET_SHA} — aborting before any change."
info "runtime marked ${TARGET_SHA}"
seal_env "${BUILD_DIR}"

# --- 8. backup, before anything is allowed to change -------------------------
# The backup script names its files after its own timestamp, so rather than
# guess it, note the time and afterwards ask which dumps appeared. That gives
# the rollback message a real filename to point at instead of "check the
# backups directory".
log "Backing up the database and uploads"
BACKUP_MARK="$(( $(date +%s) - 1 ))"
if ! as_root "${BACKUP_CMD}"; then
  die "Backup failed. Production is untouched and no migration has run."
fi
BACKUP_FILES="$(as_root find "${BACKUP_DIR}" -maxdepth 1 -type f -name '*.gz' \
  -newermt "@${BACKUP_MARK}" -printf '%f (%s bytes)\n' 2>/dev/null | sort || true)"
if [[ -n "${BACKUP_FILES}" ]]; then
  info "this run's backup, in ${BACKUP_DIR}:"
  while IFS= read -r line; do info "  ${line}"; done <<<"${BACKUP_FILES}"
else
  warn "the backup reported success but no new .gz appeared in ${BACKUP_DIR}"
fi

# --- 9. database ------------------------------------------------------------
# Run from the verified worktree, against the production .env copied at step 5,
# so the schema that is applied is the schema the new build was compiled
# against.
#
# MIGRATIONS MUST BE BACKWARD-COMPATIBLE. They are applied here, while the
# PREVIOUS release is still serving traffic, and the runtime rollback at the
# end of this script does not undo them. A migration that the old release
# cannot tolerate turns a routine rollback into a restore from backup.
log "Applying migrations"
as_app "${BUILD_DIR}" npm run db:migrate

log "Syncing seed content (idempotent — nothing existing is overwritten)"
as_app "${BUILD_DIR}" npm run db:seed

# --- 10/11/12. stage, stop, switch ------------------------------------------
ROLLBACK_RUNTIME="${APP_ROOT}/standalone.rollback-${CURRENT_SHA:0:7}-${STAMP}"
FAILED_RUNTIME="${APP_ROOT}/standalone.failed-${SHORT_SHA}-${STAMP}"

log "Staging the new runtime"
as_root rm -rf "${STAGE_DIR}"
as_root cp -a "${BUILD_DIR}/.next/standalone" "${STAGE_DIR}"
own_app "${STAGE_DIR}"
# .env rides along inside the standalone output; make sure the copy that is
# about to become the live runtime is readable by its owner only.
if [[ -f "${STAGE_DIR}/.env" ]]; then
  as_root chmod 0600 "${STAGE_DIR}/.env"
fi
info "staged at ${STAGE_DIR}"

log "Stopping ${SERVICE}"
as_root systemctl stop "${SERVICE}"

log "Switching the runtime"
# Two renames, no gradual copying into a directory a process might still be
# reading. The previous runtime is preserved outside /app, complete.
ROLLBACK_ARMED=1
if [[ -d "${STANDALONE_DIR}" ]]; then
  as_root mv -T "${STANDALONE_DIR}" "${ROLLBACK_RUNTIME}"
  seal_dir "${ROLLBACK_RUNTIME}"
  info "previous runtime kept at ${ROLLBACK_RUNTIME} (mode 700 — it contains a copy of .env)"
else
  warn "there was no ${STANDALONE_DIR} to keep — nothing to roll back to"
  ROLLBACK_RUNTIME=""
fi
as_root mv -T "${STAGE_DIR}" "${STANDALONE_DIR}"

# The runtime that is now live must be the one that was just verified. If the
# marker says anything else, something moved the wrong directory and the only
# safe answer is to put the previous release back.
DEPLOYED_MARKER="$(runtime_marker "${STANDALONE_DIR}")"
if [[ "${DEPLOYED_MARKER}" != "${TARGET_SHA}" ]]; then
  rollback "the switched runtime is marked '${DEPLOYED_MARKER:-<missing>}', expected ${TARGET_SHA}"
fi
info "live runtime marked ${DEPLOYED_MARKER}"

# --- 13. move the production tree to the deployed commit ---------------------
# .env, .next/ and node_modules/ are all gitignored, so a hard reset moves
# tracked files only: it cannot touch the environment file, the runtime we just
# installed, or the uploads directory (which lives outside /app entirely).
# There is no `git clean` here, deliberately.
log "Updating ${APP_DIR} to ${TARGET_SHA}"
as_app "${APP_DIR}" git checkout --quiet "${BRANCH}"
as_app "${APP_DIR}" git reset --hard --quiet "${TARGET_SHA}"
[[ -f "${APP_DIR}/.env" ]] || rollback ".env disappeared from ${APP_DIR}"

# --- 14. ownership ----------------------------------------------------------
log "Setting ownership"
own_app "${STANDALONE_DIR}"
# Also listed in the unit's ReadWritePaths, and equally fatal if absent.
as_root mkdir -p "${APP_DIR}/.next/cache"
own_app "${APP_DIR}/.next/cache"

# --- 15. start --------------------------------------------------------------
log "Starting ${SERVICE}"
as_root systemctl start "${SERVICE}"
sleep "${HEALTH_DELAY}"

# --- 16/17. health checks, and rollback if they do not pass ------------------
log "Health checks"
if ! systemctl is-active --quiet "${SERVICE}"; then
  rollback "${SERVICE} is not active after start ($(service_state))"
fi
info "service       : $(service_state)"

LOCAL_CODE="$(check_local)" || rollback "local health check failed (HTTP ${LOCAL_CODE:-000}) on http://127.0.0.1:${APP_PORT}/"
info "local         : ${LOCAL_CODE}  http://127.0.0.1:${APP_PORT}/ (Host: ${PUBLIC_HOST})"

PUBLIC_CODE="$(check_public)" || PUBLIC_OK=0
PUBLIC_OK="${PUBLIC_OK:-1}"
info "public        : ${PUBLIC_CODE}  https://${PUBLIC_HOST}/"

ADMIN_CODE="$(check_admin)" || ADMIN_OK=0
ADMIN_OK="${ADMIN_OK:-1}"
info "admin         : ${ADMIN_CODE}  https://${PUBLIC_HOST}/admin/login"

if [[ "${PUBLIC_HEALTHCHECK_REQUIRED}" == "1" ]]; then
  if (( PUBLIC_OK == 0 )); then
    rollback "public health check failed (HTTP ${PUBLIC_CODE}) on https://${PUBLIC_HOST}/"
  fi
  if (( ADMIN_OK == 0 )); then
    rollback "admin health check failed (HTTP ${ADMIN_CODE}) on https://${PUBLIC_HOST}/admin/login"
  fi
elif (( PUBLIC_OK == 0 || ADMIN_OK == 0 )); then
  warn "a public health check failed but PUBLIC_HEALTHCHECK_REQUIRED=0 — keeping this release"
fi

ROLLBACK_ARMED=0

# --- 18. what happened ------------------------------------------------------
printf '\n'
log "Deployed"
info "previous sha  : ${CURRENT_SHA}"
info "previous rt   : ${RUNTIME_DESC}"
info "deployed sha  : ${TARGET_SHA}"
info "runtime marker: ${DEPLOYED_MARKER}"
info "service       : $(service_state)"
info "local         : ${LOCAL_CODE}"
info "public        : ${PUBLIC_CODE}  https://${PUBLIC_HOST}/"
info "admin         : ${ADMIN_CODE}  https://${PUBLIC_HOST}/admin/login"
info "rollback      : ${ROLLBACK_RUNTIME:-none}"
info "build worktree: ${BUILD_DIR}"
if [[ -n "${BACKUP_FILES}" ]]; then
  info "backup        : ${BACKUP_DIR}"
  while IFS= read -r line; do info "  ${line}"; done <<<"${BACKUP_FILES}"
fi
printf '\n'
info "Neither the rollback runtime nor the build worktree is removed automatically."
info "Once the release has proved itself, clean them up by hand:"
info "  rm -rf ${ROLLBACK_RUNTIME:-<rollback dir>}"
info "  sudo -u ${APP_USER} git -C ${APP_DIR} worktree remove ${BUILD_DIR}"
info "To go back by hand: stop ${SERVICE}, swap that rollback directory into"
info "${STANDALONE_DIR}, reset ${APP_DIR} to ${CURRENT_SHA}, start the service."
info "The database is NOT part of either path — see the note at the top of this file."
