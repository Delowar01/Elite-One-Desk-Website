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
| `schema-compat.test.ts` | the release named in `deploy/previous-release` still reads **and writes** the schema this one produces — it inserts a section naming only its own columns, saves a draft and publishes it, which is what catches a new NOT NULL column whose default does not cover an old INSERT · that reference names a real, earlier commit · no migration drops, renames or narrows anything without an approval marker |
| `admin-destinations.test.ts` | adding Nepal is data entry · the shared `/packages/<slug>` namespace is guarded from both sides · deleting a destination keeps its packages |
| `cms-fields.test.ts` | the controlled row fields — a real icon key survives, an invented one does not, a media id survives as a number, junk becomes null, a dangerous href is still stripped · the link→image resolver, including the language prefix, the fragment, the per-category service slug and the destination that wins over a package of the same name · the social registry: twelve platforms, `twitter` is X, casing and whitespace do not fork a platform |
| `data-foundation.test.ts` | the Visual Editor's data rules, decided without a database: a row keeps its `_id` through a reorder and a save, and every other undeclared key is still dropped · an id holding a character the generator cannot produce is replaced rather than trusted · a node path names a node and can never be a selector, a locale or a section · a stored style is a closed vocabulary with no CSS, no motion and no physical direction · a draft order is checked against the page that owns it · a snapshot carries the published section and nothing global, and its content is rebuilt through the block registry — undeclared keys dropped, rich text sanitized, unsafe links stripped, rows stamped, an unknown block type dropped rather than restored blindly · a restore produces drafts, recreates a deleted section in its old place and leaves everything else alone · the backfill adds `_id` and nothing else, at any depth and in both languages · the entrance-animation control is still dead, asserted on purpose |
| `data-migration.test.ts` | the same foundation against a real database: a pre-batch database comes out of `npm run db:migrate` stamped, with `updated_at`, `revision`, order and visibility untouched · a second migration writes nothing · drafts are stamped too and an existing id is kept · an unknown block type is left alone · a fresh installation lands in the same state · a stale `revision` is a reported conflict, not a silent overwrite · a restore writes drafts, publishes nothing and records the intended order · one page's version cannot be restored onto another, and a plan naming a foreign section writes nothing · a restore raises the section and page revisions, so the autosave from an editor who was already looking at the page conflicts instead of overwriting it · `updated_by` records who, a rejected write records nothing, and two writes by one actor are still told apart by the counter · a plan naming a section it does not own is refused whole — no draft, no structure, no revision, no recreated row · a hidden established section is in the page snapshot and stays hidden, while a section nobody has published is not in it at all |
| `preview-composition.test.ts` | which sections the canvas shows, decided without a database: an absent structural draft previews exactly as before · an empty one is a pending removal of everything and a corrupt one is not · a draft's array order is the canvas order · an omitted section is a pending deletion · a hidden one is still reachable · a draft-only one appears where the draft names it · a foreign id never renders · the published composition takes neither drafts nor structure |
| `editor-protocol.test.ts` | the closed postMessage vocabulary at version 2 — a valid message is read, and a wrong channel, wrong protocol version (v1 included), wrong bridge id, wrong page, unknown type or malformed field is silence · structure, hover, selection and bounds are rebuilt field by field, with the address parsed and the section id beside it required to agree · an absurd rectangle is refused · ping, select and clear are the whole editor vocabulary and `editor.setContent` and friends are not in it · bridge ids are opaque and checkable · the viewport contract is 1440/834/390 and falls back rather than throwing · the canvas address is built from a page, English at the root and Arabic under `/ar`, never `/en` |
| `editor-nodes.test.ts` | how the editor names things and where it draws the box: no editor means no attributes at all · a section root carries its id and block type and a field does not repeat them · every address written passes the parser, and a path it refuses — or a row with no usable `_id` — writes nothing rather than something wrong · a repeatable row keeps its address through a reorder and is never addressed by index · the language is not in the address · labels come from the block registry and a row is named by what it says · the overlay transform, including a 1440 canvas scaled into a narrower stage, an explicit frame offset and a nonsense scale · a zero-sized or off-screen rectangle is not drawn |
| `visual-editor.test.ts` | the editor route and what authenticating for it unlocks, against the running app: signed out it bounces to login · `content.view` opens it and the page list comes from the table · a junk page, language or device falls back · a visitor guessing `?preview=1&editor=1&bridge=…` gets the published page and no bridge · an ordinary preview still wears its banner and loads no bridge · an authorised canvas drops the banner and gets the bridge · a malformed bridge id is an ordinary preview · the canvas follows a structural draft while the live page does not move · a corrupt structure shows the page as it stands · a foreign section cannot be pulled in · every rendered section gets a root addressed by its database id, fields are addressed relative to it, repeatable rows carry the `_id` the database holds, and the addresses are identical in both editions · a draft-only section is marked as one and a hidden one as hidden · a visitor and an ordinary preview carry no `data-eod-` markup at all · the existing preview screen is untouched |
| `style-tokens.test.ts` | the style system without a database: every token in the vocabulary maps to a design token rather than to the stored string, and a spacing step off the scale is not a style · nothing spatial is physical, so one document lays out in both directions · no override means no `style` attribute at all · two focal-point tokens make one property · a selector, a runtime address and a locale suffix are not node paths · only the base branch renders · which controls a node is offered, derived from its kind and the registry's own field types, with `hidden` offered nowhere · an edit leaves the document sparse, a reset removes base and keeps the tablet and mobile branches nobody can see yet |
| `visual-styles.test.ts` | layout and styles against the running app: a save keeps the declared tokens and nothing else — no css, class, selector, url(), transform, out-of-range spacing or invented key survives · a key that is not a relative node path is not a node, and no `section:42/…` or `@ar` is ever persisted · a style save moves `draft_styles` and no other column, and a content save moves neither style column · the draft reaches preview and stops there; publishing it reaches a visitor · an empty style draft is a reset rather than an absence, previews as the plain design and, when published, takes the override off the live page · discard leaves the published styles alone · content and style share one revision, in both save orders, and a stale save in either domain conflicts and is offered the whole row back · a style-only draft takes part in Publish all, and publishing one on a hidden section does not make it visible · Save and publish on the content form leaves a style draft pending · a row keeps its style through a reorder, by `_id` · a focal point does not touch the picture · the same document lays out in Arabic · reader, CSRF, signed-out and wrong-page refusals · motion and the responsive branches stay dormant, and a visitor gets no bridge, no editor markup and no style document |
| `visual-content.test.ts` | editing content in the Visual Editor, through its real Server Actions over HTTP: a save writes `draft` and moves no other column, the live page does not change and the preview does · rich text keeps the whitelist, an unsafe link is stripped, an undeclared key and an invented icon never land, a media field is a library id or nothing · Arabic is written without touching the English and an empty Arabic value is never backfilled from it · a row keeps its `_id` through a reorder, a new row is given one and a repeated one is replaced · a save on a revision that has moved is refused and hands back the version that won · the ordinary section editor and the canvas conflict with each other in both directions · a section moving mid-publish rolls the whole page back and nothing goes out · a reader may read and not write, a forged or missing CSRF token is refused, signed out neither works · a section belonging to another page is refused rather than loaded |
| `layers-tree.test.ts` | the Layers tree and direct canvas editing decided without a database: a node's kind comes from the block registry · the tree nests by parsed address and holds only what the canvas reported · a repeatable row is named by its own words and addressed by its `_id`, in both editions, with no English fallback into Arabic · which fields may be typed into and which have controls instead · a typed string is written into the edition being edited, into the row its `_id` names whatever order the list is in, without touching a sibling or mutating the buffer |
| `layers-editing.test.ts` | the same against the running application: the canvas marks plain-text fields as directly editable and a picture, a list and a section root as not · a row's label is offered and addressed by `_id`, never by position · a direct edit goes through the ordinary draft save, validator and revision guard, and a stale one conflicts rather than overwriting the write that won · markup typed into a text field is stored and escaped as text · a visitor and an ordinary preview receive no editor markup, no `contenteditable` and no lock metadata, and no column, payload or page ever learns that anything was locked |
| `selection-claim.test.ts` | a selection is never claimed for a node that was not selected: the protocol has no acknowledgement that could read as success, a report always names its node, a mismatched address and section is refused, the canvas resolves a request by exact address only, a request it cannot honour clears the selection rather than leaving the last one standing, and an edit aimed at a field never lands on the section root |
| `invariants.test.ts` | two rules that live in the shape of the source and cannot be seen in its output on a machine that behaves: a restore point is inserted in one place only and always under the page lock, so `page_versions.id` is publication order · the section screen reads its server props once, into one value holding the words and the revision together, moves it only on its own answered write, and is keyed on the row so one section's state cannot outlive it |
| `social-admin.test.ts` | the Social Media panel, driven through its own forms: a new link appends · an ordinary edit does not reorder · show and hide · the arrows, including on rows that already share a `sort_order` · one row per network, with `twitter` and `x` counted as one · `Other / Website` may repeat · a legacy `twitter` row is X in the footer and in the panel · `sameAs` lists the accounts once each and leaves the plain addresses out · every mutation named in the activity log for what it was |

## Server Actions

`helpers/http.ts` submits the actions that live on a rendered `<form>`, the way
a browser with JavaScript disabled does — React writes the action reference into
the markup for exactly that path. An action a *client component* calls directly
has no form to replay, and the Visual Editor's inspector is a panel rather than
a page, so `helpers/action.ts` sends the other request a browser sends: the
action id read from the build's own `server-reference-manifest.json`, the body
produced by React's own `encodeReply`, and the `Next-Action` header, cookie and
origin alongside it. The answer comes back as a flight stream and is read by
row, in bytes rather than lines, because a long string is hoisted into a row of
its own. No test-only endpoint exists and nothing in between is mocked.

## Server-only modules

Most of `src/lib` is marked `server-only`, which throws the moment it is
imported without React's `react-server` export condition. A test that needs to
drive one of those modules against a real database therefore cannot import it:
`helpers/probe.ts` writes the snippet to `.data/test/probes/` and runs it with
`tsx --conditions=react-server`, the way the server runs it. The snippet reports
back by calling `emit(value)`; nothing in between is mocked.

## Ports

The server tests bind `3411`–`3414`, `3421`, `3431`, `3441`–`3448`, `3502` —
one port per file, never shared. `node --test` runs the files in parallel, so
two files on one port is not a style point: whichever starts second fails to
bind, or worse, answers the first one's questions. `build-isolation.test.ts`
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
