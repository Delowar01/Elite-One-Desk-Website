# Granular permissions — upgrade, verification and rollback

Batch 18 split the legacy `content.manage` key into granular keys. This release
authorizes every page, style, motion, layout, publishing and reusable-component
action with the granular keys only, so **the database must be upgraded and
verified before this release takes any administrative traffic.** A new runtime
serving against a database that has not been upgraded would refuse legitimate
editors.

## Deployment order

`deploy/deploy.sh` enforces this order; nothing here has to be remembered. The
step numbers are the numbered sections in the body of the script
(`# --- 8. backup …`).

| # | Step | Where | Reversible? |
|---|------|-------|-------------|
| 1 | Back up the database and uploads | `deploy.sh` step 8 (`BACKUP_CMD`) | — |
| 2 | Additive schema migration | step 9, `npm run db:migrate` | additive only; see "Migrations" in `deploy.sh` |
| 3 | Permission catalogue and grant upgrade | step 9, `npm run db:seed` | additive; never regrants a removed key |
| 4 | **Verify the upgrade** | step 9, `npm run db:check-permissions` | read-only |
| 5 | Stage, stop, switch; the new release takes traffic | steps 10–12 | runtime rollback available |

If step 4 fails, `deploy.sh` stops **before the switch**: the previous release
keeps serving, and everything written so far is additive and harmless to it.

Doing it by hand (a rehearsal, or a recovery), from the release's checkout with
its `.env`:

```sh
npm run db:migrate
npm run db:seed
npm run db:check-permissions            # must print "The permission catalogue is complete…"
npm run db:check-permissions -- --strict  # straight after the FIRST upgrade only
```

## What the upgrade does

The seed introduces a key once — when it is absent from the `permissions`
table — and, in the same transaction, grants it by **derivation from what each
existing role already held**:

| New key | Granted to the existing roles that held |
|---------|------------------------------------------|
| `content.edit`, `content.style`, `content.advanced_style`, `content.motion`, `content.structure`, `content.publish` | `content.manage` |
| `components.edit`, `components.publish`, `components.lifecycle` | `content.manage` |
| `components.view` | `content.view` |

The owner role receives every introduced key. A role created by the run (a
fresh installation) receives its defaults. `content.manage` itself is kept on
every role that had it — the previous release still authorizes with it.

It is idempotent: a key already in the catalogue is never granted again, so a
grant removed after the upgrade stays removed through every later deploy, and a
role emptied by its owner stays empty.

## Verification — `npm run db:check-permissions`

Read-only (one `BEGIN READ ONLY` transaction). Fails when:

- any key in this build's catalogue is missing from `permissions` (the upgrade
  did not run), or
- the owner role does not hold every key.

It prints the role × key matrix for the granular keys and a NOTE for every role
that holds `content.manage` but lacks part of the split derived from it. That
cannot happen straight after the first upgrade, so `--strict` turns those notes
into failures for that one check; on later deploys it is usually an owner's
deliberate narrowing and is reported, not failed.

## Rehearsal

`tests/permissions-migration.test.ts` rehearses the upgrade on isolated
databases built by the previous release's own migrate and seed from its own
checkout (`deploy/previous-release`): customised grants, `content.manage`
removed from one role and given to another, the upgrade, exact derived grants,
a re-run that grants nothing, a granular key removed and kept removed through
another seed, a fresh installation, all four roles, the previous release's own
seed run against the upgraded database (a rollback), and a re-upgrade after it.
`scripts/check-permissions.ts` is exercised there too.

## Rollback is NOT permission-equivalent — an authorization review is required

The previous release knows only `content.manage`: whoever holds it may edit,
style, animate, restructure and publish every page. It cannot enforce the
granular split. Rolling back the runtime therefore changes who may do what:

- **A role narrowed through the granular keys but still holding
  `content.manage` regains everything.** An editor limited to `content.edit`
  can publish again under the previous release.
- **A role given only granular keys loses page editing entirely.**
- **Saving a role on the previous release's Roles screen drops its granular
  keys** (that screen replaces a role's grants with its own, older catalogue),
  and re-deploying this release does **not** give them back — they are no
  longer new to the catalogue. The owner re-grants them on the Roles screen.
- Reusable components are not editable under the previous release; linked
  sections render the fallback copy they keep in their own fields.

So a rollback needs an explicit review by the owner, before or immediately
after it:

1. Run `npm run db:check-permissions` and keep its matrix: that is the
   granular configuration being set aside.
2. For every role that holds `content.manage`, decide whether it should have
   full page editing and publishing while the previous release runs. If not,
   remove `content.manage` from it — understanding that saving the role on the
   previous release's screen also drops its granular keys.
3. After re-upgrading, compare against the matrix from step 1 and re-grant any
   granular key the previous release's screen dropped.

## Role types

`roles.key` is an enum of four system roles — **owner, admin, editor, viewer**.
Any combination of granular keys can be assigned to those four roles on the
Roles screen, but Batch 18 did not introduce additional named role types, and
this release does not either.
