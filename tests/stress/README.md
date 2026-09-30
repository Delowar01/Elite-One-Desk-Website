# Stress suite

Longer, repetitive runs that the probes make once: concurrency storms against
the server, many motion nodes on one page, a hundred Undo steps, the three
intermittent failures Batch 19A closed and the selection defect it found, each
looped until a regression would show. Same runner, same rules and same requirements as the probes — see
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

`STRESS_LOOPS` sets the loop count where a script has one; each documents its
own default at the top of the file. `smooth-scroll-wheel` also prints an
`INFO` line — how often Chromium dropped the wheel — which is reported, not
asserted: it is the browser's behaviour, and a Chromium that kept the wheel
would be no failure of ours.

## Not tracked

The one-off investigation scripts written while chasing a failure (timelines,
instrumented repros, A/B harnesses) are not tests and stay out of the
repository. What they established is recorded where it matters: in the probe
comments, in `tests/browser/canvas.ts` and in the scripts above, which assert
the corrected behaviour rather than reproduce the old one.
