# Stress suite

Longer, repetitive runs that the probes make once: concurrency storms against
the server, many motion nodes on one page, a hundred Undo steps, the three
intermittent failures Batch 19A closed and the selection defect it found, the
editor's own speed and clean-up on a large page and the component screens'
navigation under load (19B), admin saves that must show their answer
untouched (19C), drafts, publications and discards of a service-category
page racing each other and the admin forms (21), and the same of a service's
own page, with its reads, a move, a rename and the category page beside it
(22), and the Services form against the editor and against itself, with the
public pages read throughout (23), and the package routes — a package's page,
a destination's page and the catalogue — against each other and the Packages
and Destinations screens (24), and SEO records against each other, the
pictures they name and the records they belong to (25), and pictures named
outside a foreign key written while the library deletes them, and a canvas
click begun while a Layers selection is still gliding (26), each looped
until a regression would show. Same runner, same rules and same requirements as the probes — see
[`tests/browser/README.md`](../browser/README.md).

```sh
npm run test:stress                                         # every script, once
npm run test:stress -- --only quick-links-selection --repeat 5
STRESS_LOOPS=20 npm run test:stress -- --only entrance-parallax
```

CI runs this suite by hand or on a schedule (`.github/workflows/stress.yml`),
not on every push: it takes a long time and proves nothing a single probe
would not, until something has changed that it is there to catch.

| Script | What it asks, many times | PASS |
|--------|--------------------------|------|
| `permissions` | refusal, mixed and revocation storms against the granular permissions (Batch 18); API only | 17 |
| `reusable` | component conflicts, usage counts, link/detach and global publish under concurrency (Batch 17); API only | 7 |
| `advanced-motion` | every motion node on Home at once: observers, scroll listeners, frame callbacks, DOM writes (15a) | 7 |
| `motion-15b` | what parallax, hover and word reveal cost, and that navigating leaves nothing behind (15b) | 13 |
| `undo` | 110 real actions, Undo all the way down, Redo all the way back (16) | 10 |
| `quick-links-selection` | picture, title and badge clicks on a Quick Links card, EN/AR × Desktop/Tablet/Mobile, fresh editor each time (19A) | 8 |
| `entrance-parallax` | motion-15b check 11 at every frame: park, bring in, hand over to the drift, at every width, plus reduced motion (19A) | 10 |
| `replay-selection` | Replay interrupted by a click, Layers, an edit, a page, language or device switch and a reload (19A) | 12 |
| `restore-selection` | after a save redraws the canvas, the selection stays on its node — unthrottled and on a CPU slowed 4× and 6× — or lands on its section when the node was removed (19A) | 7 |
| `smooth-scroll-wheel` | on a plain page: a wheel sent during a smooth scroll is dropped — why probes scroll instantly (19A) | 2 |
| `editor-performance` | a 16-section Home: open, every Layers branch, every section selected, forty selections back and forth, 300 typed characters, ten style and ten entrance changes — times, long tasks and the heap after a collection, held to bounds only a stall or a leak would cross (19B) | 9 |
| `editor-cleanup` | page switches, canvas reloads, Replay with a parallax sweep, the component drawer and the comparison's controls, each repeated: no observer, window/document listener, pending frame or interval outlives them (19B) | 8 |
| `create-navigation` | three servers at once, each from cold: create a component from the list and land on its page, delete one from its page and land back on the list — the load under which a client navigation was left uncommitted; uses ports 3812–3814 (19B). Since 21A it runs under the diagnostics below, and N5 counts what failed behind the screen: a 5xx, a failed Server Action, an error row in an RSC payload, a failed request, a console error, an error in a server's output, a server exit nobody asked for | 5 |
| `route-concurrency` | a service-category page in the Visual Editor: six saves of one region at one revision, five publications of one review, a publication against the Services list's show/hide and against the Services form in both orders (since 23 the form and the publication both change the introduction, so exactly one lands and the other writes nothing), a publication while its regions are edited again, a discard while another region is edited — each answer checked in the database: one winner, whole or nothing, nothing published unseen, no draft lost, history capped at thirty, no record created or lost; API only, port 3818 (21) | 8 |
| `service-concurrency` | a service's own page in the Visual Editor: six saves of one region at one revision, five publications of one review, eight readers of the public page in both editions, its preview, canvas, RSC payload, category page and the editor's reads while drafts are saved, discarded and published (no 5xx, no error row, no draft in public, and the very next read after a publication shows it), a publication against the Services form, against a move to another category and against a rename, in both orders (since 23: on the same field exactly one of the form and the publication lands; a move keeps the published timeline in both orders), the category page and the service page publishing the same column at once (one lands, the other keeps its draft, neither waits for ever), a discard while another region is edited, components created and deleted beside publications — each answer checked in the database, then the histories capped at thirty, no record created or lost, and nothing failed in the server's output; API only, port 3819 (22) | 13 |
| `service-form-concurrency` | the Services form against the Visual Editor and against itself: a stale form and a publication of different fields in both orders (both land) and of the same field (exactly one lands, the loser writes nothing), six stale forms at once (different fields all land, one field lands once), a category move racing stale forms (never moved back; the move or a group change, exactly one), three publications back to back while stale forms save other fields (every value lands — the editor's buffer drafts only what was typed in it), and six readers of the page in both editions, its RSC payload and its category page throughout (no 5xx, no error row, no draft in public); every write answered within 15 s, no record created or lost, nothing failed in the server's output; API only, port 3820 (23) | 9 |
| `package-concurrency` | the package routes in the Visual Editor beside the Packages and Destinations screens: six saves of one region at one revision on a package's page and on its catalogue card, five publications of one review of the catalogue, a package's page and a destination's page, eight readers of the catalogue, the package's and the destination's pages in both editions, their RSC payloads, a preview, a canvas and the editor's reads while drafts are saved, discarded and published (no 5xx, no error row, no draft in public, and the very next read after a publication shows it on all three pages), a publication against the Packages form on the same field in both orders (exactly one lands, the loser writes nothing), the Packages form re-filing a package while the catalogue publishes its card and the target group (both land in every round — the lock order; nothing deadlocks), the catalogue and a package's page publishing one column at once and the catalogue's group and a destination's page publishing its name at once (one lands, the other keeps its draft, neither waits for ever), a destination's new address racing its page's publication (both land, one identity, the old address gone), a discard while another region is edited, destinations and packages created and deleted on their screens while the catalogue publishes, and the catalogue, a package page, a category page, a service page and the services overview publishing at once with all their pages read (all five land; every page, the overview included, shows its own on the next read) — each answer checked in the database, then the histories capped at thirty, no record created or lost, and nothing failed in the server's output; API only, port 3821 (24) | 16 |
| `seo-media-concurrency` | the SEO screen against itself, the Media library and the record forms: six forms on one record (a page, both overviews, a category, a service, a destination, a package in turn) each changing its own field (all six land, one row) and all changing the same field (exactly one lands, five are refused by name), first saves on records with no row yet (one row, never two, never an error), share images chosen while their pictures are deleted — four pairs and one picture two records choose at once (one side of each wins, never both; nothing names a deleted picture), a destination's address changed and a service moved to another category while their SEO is saved (both land, on one row bound to the record at its new address — this is the run that found a save which waited for a move reading the moved service as deleted), and a destination deleted while its SEO is saved (its record goes with it whichever came first); the public pages read in both editions throughout, then the next read showing every stored record, no row bound to a record that is gone or keyed by an address its record does not have, and nothing failed in the server's output; API only, port 3822 (25) | 11 |
| `media-references` | pictures named outside a foreign key, written while the media library deletes them (26): each round brings in ten pictures and, in a shuffled order, Visual Editor autosaves on image-text sections and on Quick Links sections naming three pictures each in a random order, the Pages screen's section form (draft and save-and-publish), reusable component drafts and the hero picture of every service category's route draft — while every picture of the round is deleted, and every picture the last round left named is deleted the moment these writes replace it. Every answer definite (stored, or refused because a picture had gone; deleted, or refused as in use), nothing naming a picture the library no longer has after any round, a done delete gone from the library and a refused one still in it, every stored write holding exactly the pictures it named, the public pages read whole in both editions throughout, and no deadlock or failure in the server's output; an `INFO` line counts how often each side won. API only, port 3823 (26) | 6 |
| `admin-form-settle` | three servers at once, each restarted cold before every save: create an account on the Users screen and add a question on the FAQ screen, then touch nothing — every answer must reach the screen and release its button on its own, every row stored exactly once (19C); and create a package on the Packages screen and delete it from its own screen, actions that answer with a redirect — every one must land on the next screen on its own (Batch 26); uses ports 3815–3817 | 6 |
| `layers-glide-click` | on a service's page: select the request form from Layers, hold its glide, let it go and click the hero title at once; the same with nothing held; and the title clicked on a canvas at rest, scrolled far from it and not — the node must be selected every time, where the click helper used to find it carried off the canvas and stop (Batch 26, CI 37952610450) | 4 |

`STRESS_LOOPS` sets the loop count where a script has one; each documents its
own default at the top of the file. `smooth-scroll-wheel` also prints an
`INFO` line — how often Chromium dropped the wheel — which is reported, not
asserted: it is the browser's behaviour, and a Chromium that kept the wheel
would be no failure of ours.

## Diagnostics (21A)

Stress run 37064560289 failed `create-navigation` N4 with three page errors,
"An error occurred in the Server Components render…", cut at 160 characters,
with no digest, no step and none of the servers' output. `create-navigation`
now runs under `tests/helpers/diagnostics.ts`, so the next failure carries its
own evidence. Every incident is printed whole, on lines starting `diag` (never
`PASS` or `FAIL`, which the runner counts), and the run ends with one
`diag summary {…}` line:

- **in the browser:** page errors with name, message, stack and the Next.js
  digest (reported by the page itself — Playwright's page error drops it),
  unexpected console errors, failed requests (a request the browser cancelled
  is counted, not reported), 5xx answers, failed Server Actions and any RSC
  payload carrying an error row that is not a navigation;
- **on the server:** each server's output line by line with the time it
  arrived (`Server.lines()`), every line that says something failed, and how
  each server process ended (`Server.exit()`), so a crash is told from a
  restart;
- **for each incident:** the worker, round and step, the page's address, the
  time, the requests of the five seconds before it and what its server wrote
  in the five seconds around it.

The runner copies each run's `diag summary` into its own output, and for an
unclean run every incident line as well (up to 400), so a CI job log carries
the evidence even when its logs artifact cannot be fetched.

Nothing secret is printed: the session cookie and CSRF token are removed by
value, and cookies, tokens, passwords, credentials in URLs, `DATABASE_URL` and
`AUTH_SECRET` by shape. `tests/stress-diagnostics.test.ts` and the
`stress-diagnostics` browser probe test the recorder itself.

`STRESS_ACTIVITY=1` runs the same script with the application busy beside the
browser on every server (`tests/helpers/activity.ts`, three lanes a server, or
`STRESS_ACTIVITY=<n>`): RSC navigations and document loads of the Components
screens, the Visual Editor on a service category and its public page and
preview, the Visual Editor on a service's own page and that page in public
and in preview (22), the Visual Editor's route reads of both, route drafts of
both saved and discarded or published (which revalidates the caches), and
components created and deleted.
It pauses across every restart, so a refused connection is a failure, not a
restart.

```sh
npm run test:stress -- --only create-navigation --repeat 10                     # normal load
STRESS_ACTIVITY=1 npm run test:stress -- --only create-navigation --repeat 10   # with concurrent activity
```

## Not tracked

The one-off investigation scripts written while chasing a failure (timelines,
instrumented repros, A/B harnesses) are not tests and stay out of the
repository. What they established is recorded where it matters: in the probe
comments, in `tests/browser/canvas.ts` and in the scripts above, which assert
the corrected behaviour rather than reproduce the old one.
