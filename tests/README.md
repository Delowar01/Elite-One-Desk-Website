# Integration tests

```bash
npm run build          # the server tests run the real production build
npm test
```

They talk to a PostgreSQL server and to the built application over HTTP. There
is no mocking: the redirects are measured with `fetch`, the admin forms are
submitted the way a browser with JavaScript disabled submits them, and the cache
proof restructures a live database underneath a running server.

## What they need

| | |
|---|---|
| PostgreSQL | reachable, with a role that may `CREATE DATABASE` |
| `psql`, `pg_dump` | on `PATH` — the fixtures are built and compared with them |
| A production build | `npm run build`, for the four files that start a server |
| Git history | the pre-restructure catalogue is checked out from a commit |

Every database is created and dropped by the tests, named `eodt_*`. Nothing
reads `.env`: the connection comes from `TEST_PG_URL` alone, so a run can never
reach a development or production database by accident.

```bash
TEST_PG_URL=postgres://user:password@127.0.0.1:5432 npm test
```

Defaults to `postgres://postgres@127.0.0.1:5432`.

| Variable | |
|---|---|
| `TEST_PG_URL` | the server, without a database name |
| `LEGACY_REF` | the commit whose seed is the pre-restructure catalogue (`ea20a22`) — a fixed historical fixture |
| `COMPAT_REF` | override the release the compatibility probe checks out; defaults to `deploy/previous-release` |
| `REBUILD_FIXTURES` | rebuild the cached fixture dumps rather than reusing them |

## The two fixtures

`legacy` is the catalogue production holds before the cutover. It is not a
curated SQL file but the output of the seed **as it stood at `LEGACY_REF`**,
checked out into a git worktree and run, with this branch's migration applied on
top — exactly the state a Phase A deployment leaves behind. `fresh` is this
branch's seed on an empty database.

Both are built once into `.data/test/` and restored per test, so a test costs a
`psql` restore rather than a seed. `npm test` builds them first, in
`tests/prepare.ts`, because `node --test` runs one process per file and starts
them together; running a single file on its own builds them too, under a
directory lock.

## The files

| | |
|---|---|
| `seed-state.test.ts` | the seed is safe on a fresh, legacy and restructured database — and the seed and the restructure produce the same catalogue, field for field, copy included |
| `restructure.test.ts` | dry run writes nothing · the live run holds every invariant · `region` is never rewritten · a second run is a no-op · a late failure rolls everything back · four concurrent runs produce one cutover · enquiries and FAQs outlive the categories and services they were filed under · edited copy is reported rather than overwritten · a menu with any editor change — including nine that keep the row count at 24 — refuses the cutover |
| `public-routes.test.ts` | 66 retired addresses, EN and AR, one 308 hop each to a page that answers 200 · before the cutover the same build serves them as pages instead · the four states `/packages` can be in · the copy that counts service groups, in both states and both languages · a published package under an unpublished destination |
| `cache-refresh.test.ts` | the cutover alone changes nothing a visitor sees · a restart is not a refresh · pressing **Refresh caches** makes it live immediately |
| `build-isolation.test.ts` | `next build` succeeds cold with PostgreSQL unreachable, contacts no database, prerenders nothing database-backed, and no catalogue route enumerates paths at build time |
| `schema-compat.test.ts` | the release named in `deploy/previous-release` still reads the schema this one produces · that reference names a real, earlier commit · no migration drops, renames or narrows anything without an approval marker |
| `admin-destinations.test.ts` | adding Nepal is data entry · the shared `/packages/<slug>` namespace is guarded from both sides · deleting a destination keeps its packages |

## Ports

The server tests bind `3411`–`3414`, `3421` and `3431`. `build-isolation.test.ts`
starts no server: it copies the working tree — tracked files with their
uncommitted edits, plus untracked files that are not gitignored — to a directory
under the OS temp dir, symlinks `node_modules` and builds there. Outside the
repository on purpose: built inside it, Next decides the outer checkout is the
workspace root and nests the standalone output somewhere it cannot be checked.
Building elsewhere also leaves the real `.next` the other tests need alone, and
keeps the build genuinely cold — the only condition under which this regression
appears at all. Each server runs from
its own hard-linked copy of the build under `.data/test/servers/<port>`, because
`unstable_cache` persists to disk beside the build and two servers sharing a
directory would answer each other's questions.
