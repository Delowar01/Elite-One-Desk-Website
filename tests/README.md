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
| `LEGACY_REF` | the commit whose seed is the pre-restructure catalogue (`ea20a22`) |
| `REBUILD_FIXTURES` | rebuild the cached fixture dumps rather than reusing them |

## The two fixtures

`legacy` is the catalogue production holds before the cutover. It is not a
curated SQL file but the output of the seed **as it stood at `LEGACY_REF`**,
checked out into a git worktree and run, with this branch's migration applied on
top — exactly the state a Phase A deployment leaves behind. `fresh` is this
branch's seed on an empty database.

Both are built once per run into `.data/test/` and restored per test, so a test
costs a `psql` restore rather than a seed.

## The files

| | |
|---|---|
| `seed-state.test.ts` | the seed is safe on a fresh, legacy and restructured database — and the seed and the restructure produce the same catalogue, field for field |
| `restructure.test.ts` | dry run writes nothing · the live run holds every invariant · `region` is never rewritten · a second run is a no-op · a late failure rolls everything back · four concurrent runs produce one cutover · enquiries outlive the categories they were filed under |
| `public-routes.test.ts` | 66 retired addresses, EN and AR, one 308 hop each to a page that answers 200 · before the cutover the same build serves them as pages instead · the four states `/packages` can be in |
| `cache-refresh.test.ts` | the cutover alone changes nothing a visitor sees · a restart is not a refresh · pressing **Refresh caches** makes it live immediately |
| `admin-destinations.test.ts` | adding Nepal is data entry · the shared `/packages/<slug>` namespace is guarded from both sides · deleting a destination keeps its packages |

## Ports

The server tests bind `3411`–`3413`, `3421` and `3431`. Each server runs from
its own hard-linked copy of the build under `.data/test/servers/<port>`, because
`unstable_cache` persists to disk beside the build and two servers sharing a
directory would answer each other's questions.
