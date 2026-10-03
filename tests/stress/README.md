# Stress suite

Longer, repetitive runs that the probes make once: concurrency storms against
the server, many motion nodes on one page, a hundred Undo steps, the three
intermittent failures Batch 19A closed and the selection defect it found, the
editor's own speed and clean-up on a large page and the component screens'
navigation under load (19B), admin saves that must show their answer
untouched (19C), and drafts, publications and discards of a service-category
page racing each other and the admin forms (21), each looped until a
regression would show. Same runner, same rules and same requirements as the probes — see
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
| `route-concurrency` | a service-category page in the Visual Editor: six saves of one region at one revision, five publications of one review, a publication against the Services list's show/hide and against the Services form in both orders, a publication while its regions are edited again, a discard while another region is edited — each answer checked in the database: one winner, whole or nothing, nothing published unseen, no draft lost, history capped at thirty, no record created or lost; API only, port 3818 (21) | 8 |
| `admin-form-settle` | three servers at once, each restarted cold before every save: create an account on the Users screen and add a question on the FAQ screen, then touch nothing — every answer must reach the screen and release its button on its own, every row stored exactly once; uses ports 3815–3817 (19C) | 4 |

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

Nothing secret is printed: the session cookie and CSRF token are removed by
value, and cookies, tokens, passwords, credentials in URLs, `DATABASE_URL` and
`AUTH_SECRET` by shape. `tests/stress-diagnostics.test.ts` and the
`stress-diagnostics` browser probe test the recorder itself.

`STRESS_ACTIVITY=1` runs the same script with the application busy beside the
browser on every server (`tests/helpers/activity.ts`, three lanes a server, or
`STRESS_ACTIVITY=<n>`): RSC navigations and document loads of the Components
screens, the Visual Editor on a service category and its public page and
preview, the Visual Editor's route reads, route drafts saved and discarded or
published (which revalidates the caches), and components created and deleted.
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
