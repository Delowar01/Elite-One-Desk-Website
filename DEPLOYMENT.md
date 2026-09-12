# Deploying Elite One Desk to a Hostinger VPS

Ubuntu 22.04 or 24.04, Node.js LTS, PostgreSQL, nginx, Let's Encrypt, and either
systemd or PM2.

Everything below assumes this layout, which is what the shipped configuration
files expect:

```
/var/www/elite-one-desk/
├── app/          the repository — replaced on every release
└── uploads/      the media library — NEVER inside app/
/var/backups/elite-one-desk/
```

**The uploads directory sits outside `app/` on purpose.** A release replaces the
application directory; anything inside it goes with the old release. An uploaded
photograph exists nowhere else.

---

## 1. Prepare the server

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y curl git nginx postgresql postgresql-contrib ufw

# Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
node -v

# Firewall
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw --force enable
```

Create the account the application runs as. It owns nothing it does not need:

```bash
sudo adduser --system --group --home /var/www/elite-one-desk eliteonedesk
sudo mkdir -p /var/www/elite-one-desk/{app,uploads} /var/log/elite-one-desk
sudo chown -R eliteonedesk:eliteonedesk /var/www/elite-one-desk /var/log/elite-one-desk
```

## 2. PostgreSQL

```bash
sudo -u postgres psql <<'SQL'
CREATE ROLE elite_one_desk LOGIN PASSWORD 'put-a-long-random-password-here';
CREATE DATABASE elite_one_desk OWNER elite_one_desk;
SQL
```

The database listens on localhost only by default. Leave it that way — nothing
outside this machine needs to reach it.

## 3. First release

```bash
sudo -u eliteonedesk -H bash
cd /var/www/elite-one-desk
git clone https://github.com/Delowar01/Elite-One-Desk-Website.git app
cd app

npm ci --omit=dev --ignore-scripts
npm rebuild sharp            # --ignore-scripts skips its platform binary
```

The repository root is the Next.js project root, which is what the shipped
nginx and systemd files assume.

### Environment

```bash
cp .env.example .env
chmod 600 .env
nano .env
```

| Variable | |
|---|---|
| `DATABASE_URL` | `postgres://elite_one_desk:…@127.0.0.1:5432/elite_one_desk` |
| `NEXT_PUBLIC_SITE_URL` | `https://eliteonedesk.com` — no trailing slash |
| `AUTH_SECRET` | `openssl rand -base64 48` |
| `UPLOAD_DIR` | `/var/www/elite-one-desk/uploads` |
| `SEED_OWNER_EMAIL` / `SEED_OWNER_PASSWORD` / `SEED_OWNER_NAME` | The first owner account |

`.env` is git-ignored and must stay that way. The owner seed values are only read
when no user exists at all; clear them once the account is created.

### Build, migrate, seed

```bash
npm run build
npm run db:migrate
npm run db:seed

# `output: standalone` does not copy these; without them there are no
# stylesheets and no fonts.
cp -r .next/static .next/standalone/.next/static
cp -r public       .next/standalone/public
```

Check it before putting nginx in front of it:

```bash
PORT=3000 node .next/standalone/server.js &
curl -I http://127.0.0.1:3000/
kill %1
```

## 4. Process manager

Pick **one**.

### systemd (recommended)

```bash
exit   # back to your sudo user
sudo cp /var/www/elite-one-desk/app/deploy/elite-one-desk.service /etc/systemd/system/
sudo nano /etc/systemd/system/elite-one-desk.service   # check WorkingDirectory
sudo systemctl daemon-reload
sudo systemctl enable --now elite-one-desk
sudo systemctl status elite-one-desk
sudo journalctl -u elite-one-desk -f
```

### PM2

```bash
sudo npm install -g pm2
sudo -u eliteonedesk -H pm2 start /var/www/elite-one-desk/app/deploy/ecosystem.config.js
sudo -u eliteonedesk -H pm2 save
sudo pm2 startup systemd -u eliteonedesk --hp /var/www/elite-one-desk
```

## 5. nginx

```bash
sudo cp /var/www/elite-one-desk/app/deploy/nginx.conf /etc/nginx/sites-available/elite-one-desk
sudo nano /etc/nginx/sites-available/elite-one-desk     # set server_name and paths
sudo ln -s /etc/nginx/sites-available/elite-one-desk /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default
sudo nginx -t && sudo systemctl reload nginx
```

The configuration serves `/media/`, `/_next/static/`, `/fonts/` and `/brand/`
straight off disk and proxies everything else. It deliberately does **not** add a
`Content-Security-Policy` header: the application sets its own with a per-request
nonce, and an nginx header would override it with something weaker.

## 6. HTTPS

```bash
sudo apt install -y certbot python3-certbot-nginx
sudo certbot --nginx -d eliteonedesk.com -d www.eliteonedesk.com
sudo systemctl status certbot.timer     # renewal is automatic
```

## 7. File permissions

```bash
sudo chown -R eliteonedesk:eliteonedesk /var/www/elite-one-desk
sudo chmod 750 /var/www/elite-one-desk/uploads
sudo chmod 600 /var/www/elite-one-desk/app/.env

# nginx reads the upload directory directly, so it needs to traverse the path.
sudo usermod -aG eliteonedesk www-data
sudo systemctl restart nginx
```

## 8. Backups

```bash
sudo mkdir -p /var/backups/elite-one-desk
sudo install -m 0755 /var/www/elite-one-desk/app/deploy/backup.sh /usr/local/bin/elite-one-desk-backup
sudo crontab -e
```

```cron
15 2 * * *  /usr/local/bin/elite-one-desk-backup >> /var/log/elite-one-desk/backup.log 2>&1
```

The script dumps PostgreSQL, archives the uploads, verifies the dump is readable
and prunes anything older than 30 days.

**Copy the results off the machine.** A backup that lives on the server it is
protecting is not a backup. Hostinger's snapshots plus an `rclone`/`rsync` job to
object storage covers both failure modes.

Restoring:

```bash
gunzip -c /var/backups/elite-one-desk/db-YYYYMMDD-HHMMSS.sql.gz \
  | psql "postgres://elite_one_desk:…@127.0.0.1:5432/elite_one_desk"
tar -xzf /var/backups/elite-one-desk/uploads-YYYYMMDD-HHMMSS.tar.gz -C /var/www/elite-one-desk/
```

## 9. Updating

```bash
sudo /var/www/elite-one-desk/app/deploy/deploy.sh
```

Run it as root, or through `sudo`. Every git, npm and build command is dropped
to `eliteonedesk`, so nothing under the application becomes root-owned; only
`systemctl`, the backup, and the moves inside `app/` use privilege. Running it
as `eliteonedesk` also works, provided that account may run `sudo systemctl`.

**The release is never built inside the running application.** It is built in a
throwaway git worktree beside it, and production is only touched once a
complete, verified runtime exists on disk.

1. **The production working tree must be completely clean.** Modified, staged,
   deleted *or untracked* — any of them cancels the release, the status is
   printed, and nothing is fetched, built or changed. `git reset --hard` in
   step 13 can delete an untracked file that stands where the target commit
   needs to write, so "clean" here means spotless. The script never stashes,
   never runs `git clean`, and never deletes anything to get out of the way.
2. `git fetch origin main`, then compare **both** the checkout and the live
   runtime against the target — see *The release marker* below. Only when both
   are already at the target does it report "already deployed" and exit 0.
3. `git worktree add --detach` at the target commit, into
   `/var/www/elite-one-desk/build-<short-sha>-<timestamp>` (mode 0700).
4. The production `.env` is installed into that worktree, mode 0600, owned by
   `eliteonedesk`. It is never read, printed or logged.
5. `npm ci --include=dev --ignore-scripts` — **`--include=dev` is required**:
   `typescript`, `tailwindcss`, `@tailwindcss/postcss`, `eslint` and `tsx` are
   devDependencies, and `next build`, `npm run lint`, `npm run typecheck` and
   both `db:` scripts do not exist without them.
6. `npm rebuild sharp` — `--ignore-scripts` skips the one install hook that is
   actually needed. `npm audit fix` is never run.
7. `npm run lint`, `npm run typecheck`, `npm run build` — all in the worktree.
8. Standalone assets: `.next/static` and `public` are copied next to the
   standalone server, and `.next/standalone/.next/cache` is created (the unit
   lists it in `ReadWritePaths`, and with `ProtectSystem=strict` a missing path
   there stops the service from starting). The runtime is then stamped with
   the commit it was built from, in `.next/standalone/.eod-release-sha`.
9. **A full backup runs before anything can change** —
   `/usr/local/bin/elite-one-desk-backup`. If it fails the release stops, with
   no migration run and production untouched. The dumps it produced are named
   in the output so a rollback has a specific file to point at.
10. `npm run db:migrate`, then `npm run db:seed`, from the verified worktree
    against the production `.env`.
11. The new runtime is staged at `app/.next/standalone.incoming`.
12. `systemctl stop elite-one-desk.service` — that service only.
13. The switch is two renames, not a copy into a live directory:
    `mv -T .next/standalone → /var/www/elite-one-desk/standalone.rollback-<old-sha>-<timestamp>`
    (mode 0700), then `mv -T .next/standalone.incoming → .next/standalone`.
14. `git checkout main && git reset --hard <target>` in `app/`. `.env`,
    `.next/` and `node_modules/` are gitignored, so tracked files move and
    nothing else does. Uploads live outside `app/` and are never touched.
15. `chown -R eliteonedesk:eliteonedesk` the new runtime, then
    `systemctl start elite-one-desk.service`.
16. The marker on the now-live runtime is re-read and must equal the target
    commit; anything else rolls straight back.
17. Health checks, with a short retry loop: `systemctl is-active`, then
    `http://127.0.0.1:3000/` with `Host: eliteonedesk.com` and
    `X-Forwarded-Proto: https`, then `https://eliteonedesk.com/` and
    `https://eliteonedesk.com/admin/login`.
18. It prints the previous SHA and its runtime marker, the deployed SHA and
    its marker, the service state, all three health results, the backup
    filenames, the rollback runtime and the build worktree.

### The release marker

Every runtime the script builds carries the commit it came from, in
`.next/standalone/.eod-release-sha` — a bare commit sha, no secret. It is
written before the runtime is staged, so it travels with the directory through
both renames: the runtime that gets displaced keeps the marker of the release
it actually is, and the kept rollback copy describes itself.

This exists because **git HEAD is not evidence of what is running**. A release
that failed after the checkout moved, a hand-run `next build`, a half-finished
manual recovery — each leaves `app/` on one commit and the live
`.next/standalone` on another, and git cannot tell you so.

At startup the script reads both and takes one of three paths:

| checkout | runtime marker | what happens |
|---|---|---|
| = target | = target | "already deployed" — exits 0, nothing is touched |
| = target | older, or missing | **release drift** — reported, then the release runs in full so the two agree |
| ≠ target | anything | ordinary deployment |

A runtime from before this marker existed reads as unmarked. That counts as
drift on the way in (one redeployment stamps it), and during a rollback it is
reported as `legacy/unmarked` rather than treated as a failure.

**A failure before step 11 leaves production byte-identical** — everything up to
that point happens in the worktree, and the old release keeps serving.

**A failure at or after step 11 rolls the runtime back automatically:** the
service is stopped, the failed runtime is moved aside to
`standalone.failed-<sha>-<timestamp>` (kept, not deleted, so it can be
examined), the previous runtime is renamed back into place, `app/` is reset to
the previous SHA, the service is started, and the restored release is
health-checked. The script always exits non-zero.

Nothing is moved until systemd confirms the unit is down. `systemctl stop`
returning 0 is not the same fact as the process being gone, so the rollback
asks `systemctl is-active` afterwards; if the service is still active, **no
runtime directory is touched at all** — the failed release stays installed and
serving, which is recoverable, rather than being half-swapped underneath a live
process, which is not. The checkout is still reset in that case, deliberately:
it leaves the checkout and the runtime disagreeing, which is the drift the
release marker exists to catch, so the next run repairs it instead of reporting
"already deployed" over a broken release.

Each of those steps is reported by what it actually did, not by what it was
asked to do:

```
service stop      : DONE
runtime rollback  : DONE
git rollback      : DONE
service start     : DONE
restored health   : 200
runtime marker    : OK (11bd502…)
DATABASE rollback : NOT DONE — see below
```

The banner above that line reads **FULL RUNTIME ROLLBACK COMPLETED** only when
every one of them succeeded. If any did not, it reads **ROLLBACK INCOMPLETE —
MANUAL RECOVERY REQUIRED**, and the exact paths and the exact commands to
finish the recovery by hand are printed underneath, along with the
`systemctl status` and `journalctl` lines to read first.

Neither the rollback runtime nor the build worktree is removed automatically.
Once a release has proved itself:

```bash
sudo rm -rf /var/www/elite-one-desk/standalone.rollback-<sha>-<timestamp>
sudo -u eliteonedesk git -C /var/www/elite-one-desk/app worktree remove \
  /var/www/elite-one-desk/build-<sha>-<timestamp>
```

### Database migrations are **not** rolled back

The automatic rollback restores the runtime and the git tree. It does **not**
reverse a migration, and it does not load the backup — restoring a database
over live data is a decision for a person, not for a deploy script. After a
rollback the schema is still the new one while the code is the old one.

**Every migration must therefore be backward-compatible with the release before
it.** Add columns rather than renaming or dropping them in the same release;
make a new column nullable or give it a default; remove a column only in a
later release, once nothing reads it.

A change that cannot be written that way — a destructive migration, a rename, a
type change that breaks the old code — is not a deploy. It is a maintenance
window: announce it, stop the service, take a backup, migrate, deploy, verify,
and be ready to restore from `/var/backups/elite-one-desk` rather than from the
rollback runtime.

## 10. After the first deployment

1. Sign in at `https://eliteonedesk.com/admin` with the owner account.
2. **Change the owner password** and clear `SEED_OWNER_*` from `.env`.
3. **Site settings → Contact** — address, phone, email, hours, map. Every field
   left empty renders as nothing; nothing is invented to fill a gap.
4. **Site settings → WhatsApp** — the number, then switch it on. The floating
   button and every WhatsApp link stay hidden until both are set.
5. **Site settings → Social links** — https addresses only.
6. **Site settings → Disclaimers** — read them with your legal adviser. They are
   what keep the site from reading as an official government channel.
7. **Pages → Privacy, Terms, Disclaimer** — the shipped text is a starting draft.
8. **Analytics** — add the GA4 or Tag Manager id if you have one. Nothing loads
   until you do, so this is also the decision about whether to load anything.
9. **Media library** — replace the generated artwork with photography when you
   have it. Nothing in code refers to those files by name.
10. **Users & roles** — create accounts for the team. Give the smallest role that
    does the job; it can always be raised.

## Troubleshooting

**502 from nginx** — the app is not running. `sudo journalctl -u elite-one-desk -n 50`.

**Images 404** — the `alias` in nginx must match `UPLOAD_DIR` exactly, trailing
slash included. Confirm `www-data` can traverse the path.

**Styles missing after a release** — `.next/static` and `public` were not copied
next to the standalone server. `deploy/deploy.sh` does this; if you built by
hand, do it by hand.

**`AUTH_SECRET must be at least 32 characters`** — it is unset or too short.
`openssl rand -base64 48`. Changing it signs everyone out, which is harmless.

**Migrations fail** — check `DATABASE_URL` and that the role owns the database.
`npm run db:migrate` is safe to re-run; it applies only what is pending.

**An editor cannot see a screen** — that is the permission model working. Users &
roles → the permission matrix.
