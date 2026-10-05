# Browser QA — the tracked probes

Thirty-seven probes run in a real Chromium. Thirty-six drive the real application:
the public pages, ordinary Preview and the Visual Editor, in English and Arabic,
at Desktop, Tablet and Mobile widths. One, `stress-diagnostics`, proves the
stress suite's failure recorder against a stub server. Each prints one `PASS`
or `FAIL` line per check.
Until Batch 19A they lived in a gitignored folder on one machine; they are now
tracked here, with everything needed to run them from a fresh clone.

| Path | What it is |
|------|------------|
| `probes/*.probe.mts` | the thirty-seven probes, one file each |
| `probes/expected.json` | how many `PASS` lines each probe prints when it is clean |
| `run.ts` | the runner behind `npm run test:browser` and `npm run test:stress` |
| `harness.ts` | `launchChromium()` — the one way a probe starts a browser: the full Chromium in its new headless mode, never the separate headless shell |
| `canvas.ts` | clicking and selecting on the Visual Editor's canvas without racing it |
| `wait.ts` | `until`, `quietFor`, `animationsDone`, `watchNetwork` — the only waits the probes use |
| `.env.example` | the settings a run reads, with safe defaults |
| `../stress/` | the stress suite — see [`tests/stress/README.md`](../stress/README.md) |
| `../browser-suite.test.ts` | guards run by `npm test`: counts, ports, paths, waits |

## Requirements

- **Node.js** 20.9 or newer (CI uses 22) and npm.
- **PostgreSQL** 16: a server the tests may create and drop databases on, and
  the `psql` and `pg_dump` client tools on `PATH`. The tests only ever touch
  databases named `eodt_*`, which they create and drop themselves; they never
  read `.env`. Point `TEST_PG_URL` at a disposable server — **never production**.
- **git with full history**: the fixtures check out `LEGACY_REF` (`ea20a22`)
  and the commit in `deploy/previous-release` into worktrees.
- **Chromium for Playwright 1.63** (`playwright` is a pinned devDependency):
  `npx playwright install --with-deps chromium`. A machine that already has a
  compatible Chromium can set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` instead.
- **A production build.** The probes run `.next/standalone` exactly as
  production does. `npm run build` needs no database.

## From a fresh clone

```sh
git clone https://github.com/Delowar01/elite-one-desk-website.git
cd elite-one-desk-website
npm ci
npx playwright install --with-deps chromium
cp tests/browser/.env.example tests/browser/.env       # then edit TEST_PG_URL
set -a; . tests/browser/.env; set +a
npm run build
npm test                          # the tracked suite; builds the fixtures on its way
npm run test:browser              # the thirty-seven probes, once each
npm run test:stress               # the stress suite (long)
npm run test:cleanup -- --yes     # only after an interrupted run
```

What happens underneath:

1. **Fixtures.** `tests/prepare.ts` (run by `npm test` and by the runner
   before the first probe) builds the test fixtures once and caches them in
   `.data/test/`: a scratch database gets this checkout's migrations
   (`scripts/migrate.ts`) and seed (`scripts/seed.ts`) and is dumped to
   `fresh.sql`; the pre-restructure fixture is built the same way from
   `LEGACY_REF`. `REBUILD_FIXTURES=1` rebuilds them.
2. **A database per probe.** Each probe restores `fresh.sql` into a database
   of its own (`eodt_<probe>_<random>`) and drops it in its `finally`.
3. **A server per probe.** Each starts the production build on its own port
   (listed in the probe; `npm test` checks they are unique) from a hard-linked
   copy under `.data/test/servers/<port>`, so no two servers share a cache.
4. **Test users.** The seed creates the owner `owner@test.invalid` with a
   test-only password (`tests/helpers/env.ts`). A probe that needs another
   role inserts that user into its own database. Nobody logs in through the
   form: `tests/helpers/session.ts` writes a session row and hands the probe
   its cookie and CSRF token.
5. **Cleanup.** Every probe drops its database and stops its server, pass or
   fail. A run killed from outside (the runner's own timeout included) cannot,
   so `npm run test:cleanup` lists what is left and `-- --yes` removes it: only
   `eodt_*` databases on `TEST_PG_URL` and `.data/test/servers`.

## Running

```sh
npm run test:browser                                     # every probe, once
npm run test:browser -- --only hardening,motion-15b      # just those
npm run test:browser -- --only permissions --repeat 10   # one probe, ten times
npm run test:browser -- --list                           # what exists, and what it expects
npm run test:browser -- --timeout-min 40                 # per-run limit (default 25 min)
```

A run is **clean** when the script exits 0, prints no `FAIL` line and prints
exactly the number of `PASS` lines `probes/expected.json` records. The count
is part of the contract: a probe that stops early, or loses a check in an edit,
prints fewer `PASS` lines and no `FAIL` at all, and that must not read as green.

**Nothing is retried.** An unclean run is reported with its log path, and the
runner exits 1. Logs and `summary.json` go to `.data/test/results/<suite>/`.

## Expected results

Every probe clean, with the counts in `probes/expected.json` — 1,527 `PASS`
across the thirty-seven as of Batch 24 (1,425 across thirty-six at Batch 23,
1,377 across thirty-four at Batch 22,
1,266 across thirty-three at Batch 21A, 1,255 across thirty-two at Batch 21,
1,145 across thirty-one at Batch 19C,
1,131 across thirty at Batch 19B, 1,089
at Batch 19A, 1,078 at Batch 18;
`hardening` gained eleven checks in 19A: eight on where its own clicks land and
what the canvas reported, three on the selection after a redraw on a slowed
CPU).

Batch 19B kept the thirty and added 42 checks to eight of them, each labelled
`19B ·`: `acceptance` (+15: every editor control named at 1680, 1280 and 900,
the toolbar, Layers, the Inspector's tabs, Undo/Redo and Publish worked from
the keyboard, and the public pages' headings and alt text), `acceptance2` (+3:
unsaved work guarded on leaving and kept across a change of selection),
`layers-editing` (+6: a lock kept across width and language, cleared with the
page, never stored), `permissions` (+3: no permission key or token in a
visitor's page, the preview or the canvas), `responsive` (+3: an edit made on
the Arabic canvas at Tablet and Mobile), `styles` (+4: choosing and replacing a
picture from the library, and canvas/preview/public parity), `reusable` (+6:
the detach warning and the picker from the keyboard, the component screen's
four confirmations opening on Cancel, and creating and deleting a component
landing on the next page by a document load) and `undo-compare` (+2:
the comparison's controls from the keyboard).

Batch 19C added one probe and changed none: `password-change` (14 checks, port
3731) walks a temporary password through the screens a person uses — an owner
creates the account on the Users screen, the person signs in with it and is
held on the password-change page however they try to leave, a weak or
mismatched password is refused on the page, their own is accepted, the session
it was changed from no longer works, the temporary password no longer signs in,
the new one does, to where they asked to go, and the panel is theirs again by
their role. It also found that an admin form could leave its button on
"Saving…" after the server had saved — see `useSettledActionState` in
`src/components/admin/form.tsx` and the `admin-form-settle` stress script.

Batch 21 added one probe and changed none: `route-categories` (110 checks,
port 3732) opens service-category pages in the Visual Editor. Travel & Tourism
gets the full walk — the real route in the canvas, nested Layers, the title
selected from the canvas, a direct edit taken back with Undo and put back with
Redo, Escape abandoning a direct edit, a card's introduction, Arabic right to
left, Desktop/Tablet/Mobile, a style draft, an entrance and its Replay, a card
moved and hidden from Layers and both undone, Preview, Discard, and a public
page that never moved — then the same page by keyboard, every editor control
named, the generated breadcrumbs explained in a note and no control added
inside the canvas. Business Setup and Iqama get the core of it;
`license-renewal` and `government-relations`, which no editor code names, and
a category the probe creates before the server starts prove the editor knows
no category by slug. The created one is also published, compared, viewed as a
version, restored to a draft and discarded. Last, the Service Categories
screen shows and keeps a group's Arabic summary, which the editor can set.

## Writing a probe

- Start the browser with `launchChromium()` from `harness.ts`; give the probe a
  `PORT` no other script uses; add its count to `expected.json`.
- **Clicking the canvas:** `clickCanvasNode` / `selectCanvasNode` from
  `canvas.ts`, never `locator.click()` on a canvas node. Playwright's `position`
  is not scaled for the canvas's `transform: scale(…)`, and its retries
  re-scroll with `element.scrollIntoView`, which glides under the site's
  `scroll-behavior: smooth` — the click then lands beside a moving node, and
  its hit check (which compares the nearest link) cannot tell.
- **Selecting:** wait for the Inspector's answer (`waitForInspector`,
  `selectFromLayers`), not for the Motion tab, which is already on screen
  whenever anything was selected before.
- **Waiting:** poll a condition with a bound (`until`, `holdsStill`,
  `animationsDone`, `watchNetwork(page).quiet()`), or — for a claim that
  something does *not* happen — name an observation window with `quietFor`,
  derived from the timer it outlasts (`AUTOSAVE_QUIET_MS`, `REPLAY_QUIET_MS`).
  A fixed sleep of a second or more fails `npm test`.
- **Scrolling a public page for a measurement:** scroll instantly
  (`window.scrollTo({ top, behavior: "instant" })`) and wait until it has
  arrived. A wheel sent while a smooth scroll is still gliding is dropped by
  Chromium (`tests/stress/smooth-scroll-wheel.stress.mts`).

Batch 21A added one probe and changed none: `stress-diagnostics` (11 checks,
ports 3733–3734) proves `tests/helpers/diagnostics.ts`, the recorder the
stress suite's `create-navigation` now runs under, in a real Chromium. A stub
server serves pages that throw (one with a digest and a message longer than
the 160 characters the script used to keep), reject, complain on the console,
throw as they navigate away, call a "Server Action" that answers 500 with an
error row, fetch an RSC payload with an error row and one whose only error is a
notFound, lose a connection and cancel a request of their own; the real
application server is started and stopped; a child process writes a Next.js-style error and exits by itself.
Each must be recorded whole, with its digest where it has one, attributed to
its step, and printed without the session, the CSRF token or a database
password. The page errors this probe records are provoked by its own stub
pages; it visits no application page.

Batch 22 added one probe and changed none: `route-services` (111 checks, port
3735) opens a service's own page in the Visual Editor. Its services are chosen
from the data — the first published service of each of the first three
categories — so no service is named. The first gets the full walk: reached
from the admin's sidebar and the page list (every service, one group per
category), the real route in the canvas with its header, footer and request
form, every region in Layers, a region's fields in the Inspector, an Inspector
edit, a direct edit taken back and put back, Escape abandoning one, a benefit
added and its words and its row each taken back by Undo and put back by Redo, a
step with its detail, a picture chosen from the library (and counted by the
library while it is only a draft), Arabic right to left with its own field,
Desktop/Tablet/Mobile, a style saved for Mobile only, a style taken back and
put back, an entrance with its Replay, Preview, a public page whose `<title>` and structured data
never moved, the same page by keyboard with every control named and nothing
added inside the canvas, then Publish, the public result in both editions,
history, compare, a version viewed, Restore and Discard. The second and third
get the core of it, and the second is moved to another category on the
Services screen — same document, same draft, one identity, the old address
answering as a missing page always has — and moved back. Last, a service made
on the Services screen while the probe runs is offered, edited, published and
deleted again. The draft it leaves pending, and the service it makes, are gone
at the end.

Batch 23 added two probes and changed none. `inspector-focus` (35 checks, port
3736) types in the Inspector across real autosaves — each save redraws the
canvas — in the three editors that share it: a CMS page, a category page and a
service page; a text box, a textarea with the caret in the middle and a list
row; English and Arabic; Desktop, Tablet and Mobile; four saves in a row; a
save the server holds back for 2.5 s; and a direct edit on the canvas across
its own autosave. Each case reads `document.activeElement`, `selectionStart`
and `selectionEnd` on the very element that was typed in, and the text both on
screen and in the database. Then the races: another section chosen while a
save is on its way, focus moved to another box before it lands, and a selected
row the save itself removed, which falls back to its section. On the build
before the fix it recorded 7 `PASS` and 28 `FAIL` — the defect, in all three
editors — and on the fixed one 35 `PASS`. `services-form` (13 checks, port
3737) holds one service's edit page open in two tabs: what one tab saves, the
other's stale form does not put back; a field both changed is refused with a
message naming it and nothing of that save written; a reload saves normally;
the same against the Visual Editor publishing the service's page; and the
editor's own buffer, opened before a Services save, drafting only what is
typed in it, so its publication keeps the Services screen's newer value.

Batch 24 added one probe and extended two. `route-packages` (84 checks, port
3738) opens the package catalogue, a package's own page, a destination's page
and the services overview in the Visual Editor, choosing its records from the
data. The catalogue gets the full walk: reached from the sidebar and the page
list (both overviews, every destination, every package grouped under its
destination), the real `/packages` in the canvas, Layers nesting each
destination's group and its cards under the generated catalogue and naming
them by their records, a card selected on the canvas with its words, picture
and structure, a card's title typed on the canvas, a card re-filed to "Build
your own" and drawn there at once, a card hidden from Layers and drawn dimmed, shown again by Undo and hidden
again by Redo,
the Arabic eyebrow in its own field, Desktop/Tablet/Mobile, a Mobile-only
style, an entrance and its Replay, Preview, a public page that never moved,
the keyboard, then Publish, the public result (the hidden package's own page
gone with it), history, compare, a version viewed, Restore and Discard. A
category page's service card is typed into on the canvas too — the canvas fix
this batch made (a card's link took the focus, and its `focusout` ended every
edit of a card's words at once, since Batch 21). A package's page, a
destination's page and the services overview get the core: their regions,
their generated parts explaining themselves, an Inspector edit (taken back by
Undo and put back by Redo on the package's page), a list row, a
picture, Preview and Publish. The Packages screen, opened before the editor in
another tab publishes the package, keeps the editor's work and refuses an
overlapping save by name. Last, a package made on the Packages screen is
offered under its destination, edited, published, given its catalogue card and
deleted again. `inspector-focus` gained 16 checks (51): a package's title, a
catalogue card's summary with the caret in the middle, a destination's Arabic
summary on Mobile and the services overview's heading, each typed across a
real autosave; and Layers keeping the keyboard's place — a card hidden from the
keyboard on Tour packages and shown again from the focus the redraw gave back,
a page's section moved down and back to the top, where its disabled Move up
hands the focus to the section's own row. `globals-settings` gained 2 checks
(26): the footer's descriptive line typed in the Globals drawer is the public
footer's, in its own edition only — the Arabic footer keeps its standard
sentence.
