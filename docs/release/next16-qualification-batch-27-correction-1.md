# Next.js 16 qualification — Batch 27, Correction 1

**Status: qualification record, not a release approval.** Production deployment
is not authorized by this document. Correction 1 did not access the VPS or the
production database, ran no production migration, did not change
`deploy/previous-release` and created no tag. Its branch is not merged.

| | |
|---|---|
| Start | `fde2d87` (the Batch 27 tip), `main` at `edcb4f4` — both verified on `origin` before anything changed |
| Branch | `batch-27-next16-qualification` |
| Production baseline | `902a0e6` (`deploy/previous-release`, unchanged), database `0000`–`0005` |
| Migrations | none added |
| Dependencies | `next` and `eslint-config-next` 16.3.8 → 16.4.1: 12 lock entries, every one 16.3.8 → 16.4.1 (§1); nothing else |
| Outcome | Next.js **16.4.1**, the minimum release that clears the advisory this site is exposed to (§1). #418: **none** in 2,193 documents (§5). The editor's "Ready": an unbounded wait in the editor itself, found and fixed (§3); 800 of 800 matrix waits Ready since, 200 of them with the timeline off, and no Ready timeout in any run (§4). The gate's results are in the batch's report (§10) |

The independent gate rejected `fde2d87`. #418 was gone (0 in 2,173
documents), but the Visual Editor's "Ready" had twice not come, for a reason
not established, and the Next.js version had to be checked against the
security releases published since. This record answers both. The
`next16-qualification-batch-27.md` record stands for what it measured on
16.3.8; nothing about the current release status is taken from it.

§1 the security release, §2 how the editor reaches Ready and the timeline,
§3 what it was and the fix, §4 the reproduction matrix, §5 #418 on 16.4.1,
§6 Server Actions and transitions, §7 regression, §8 the build, the artifact
and `deploy.sh`, §9 `npm audit`, §10 the gate, §11 what is not settled.

## 1. The 14 October security release (brief Part 1)

Read on 15 October 2026 from the primary sources: the npm registry
(`npm view next time dist-tags`), the GitHub release `v16.4.1`, and the three
GitHub security advisories it links. They were read again at 21:27 UTC, with
the release `v16.4.2` and the advisories page. The Batch 27 record was not
used for any of it.

**It shipped.** `next@16.4.1` and `next@15.5.28` were published on
14 October 2026 (npm: 16.4.1 at 17:43:55 UTC, 15.5.28 at 17:36:08 UTC;
`eslint-config-next@16.4.1` at 17:31:42 UTC). There is **no 16.3.x release
after 16.3.8** (30 September).

| Advisory | Severity | What | Affected | Patched | Here |
|---|---|---|---|---|---|
| GHSA-p3m5-59mp-jv5r | **High** (CVSS 4.0, 8.2) | denial of service in the App Router through Server Actions: crafted requests use enough CPU to block the process; "no workaround exists besides upgrading" | ≥13.0.0 ≤15.5.27, ≥16.0.0 ≤16.4.0 | 15.5.28, 16.4.1 | **exposed**: App Router with Server Actions (20 `"use server"` files) |
| GHSA-673q-mjm6-r5xr | Critical (9.5) | remote code execution through `use cache` functions returning typed arrays (Cache Components) | ≥16.0.0 ≤16.4.0 | 16.4.1 | not exposed: no `use cache`, no `cacheComponents` |
| GHSA-2464-fhr4-w9xw / CVE-2026-96889 | Critical (9.5) | remote code execution through the Image Optimization API with SVG files, on glibc Linux | ≥10.0.0 ≤15.5.27, >16.0.0 ≤16.4.0 | 15.5.28, 16.4.1 | not exposed: `images.unoptimized: true`, and `sharp` is 0.35.5, the advisory's workaround floor |

**So 16.3.8 is no longer a supported security version.** It is inside every
affected range, and no 16.3.x carries the fix. The High one applies to this
site as built. **16.4.1 is the minimum release that clears it on the 16 line.**
`15.5.28` clears it on the 15 line, but it vendors react-dom
`19.2.0-canary-0bdb9206-20250818`, the copy without the replay fix that
removed #418, so it is not a candidate.

**The React fix is kept.** `next@16.4.1` vendors `react` / `react-dom`
`19.3.0-canary-278794d7-20261002`. Its `react-dom-client.production.js` is
byte-identical to 16.4.0's, and its `replaySuspendedUnitOfWork` still resets
the hydration cursor (`nextHydratableInstance = fiber.stateNode`). That is the
same check that separated 16.3.8 from 15.5.x in Batch 27 §1.2.

**16.4.2, published while this record was being written.** At 21:27 UTC on
15 October the registry read `latest` 16.4.2 (published 20:57:24 UTC, with
`eslint-config-next` 16.4.2), `backport` 15.5.28 and `canary` 16.5.0-canary.14.
Its release notes list eight `lts-active` backports:

- turbo-tasks snapshot consistency;
- the Pages Router's dev module graph;
- a code-frame fix;
- two Turbopack GC paths;
- realpath errors during module resolution;
- lazy dynamic-import chunk-list collisions;
- two documentation backports.

None is a security fix. The advisories page lists nothing after 14 October,
and nothing names 16.4.2 as a patched version. So **16.4.1 is still the minimum
release that clears the 14 October advisories, and it is still a supported
release**. 16.4.2 was not taken: Part 1 takes the minimum security release
and nothing unrelated, and every measurement here was made on 16.4.1. Its
`react-dom-client.production.js` is byte-identical to 16.4.1's (read from
its npm tarball), so taking it later would keep the replay fix. That is a
change for a batch of its own, qualified as this one was.

**What npm moved.** `next` and `eslint-config-next` `^16.3.8` → `^16.4.1` and
nothing else asked for. The lockfile moved 12 entries, every one 16.3.8 →
16.4.1: `next`, `eslint-config-next`, `@next/env`, `@next/eslint-plugin-next`
and the eight `@next/swc-*` binaries. None added, none removed.

**What 16.4 changes, and what was qualified for it** (16.4.0's notes, about
900 entries; 16.4.1 is the security fixes):

| Change | Here |
|---|---|
| strict route matching on by default (#97397); adapter route collapses on (#98218) | every public and admin route is exercised by `npm test`, the probes and the client-navigation walk (§7) |
| Turbopack export-name mangling and shared runtime on for builds (#99362, #99504) | cold build, standalone start, every route, the artifact check (§8) |
| the prefetch loop on a predicted route the server rewrites is fixed (#98998, vercel/next.js#98345) | the loop Batch 27 turned optimistic routing off for. With the 16.4.1 default, `prefetch-bounded` passed twice (2/2). It stays off, which is how this release is qualified; next.config.ts now names the right issue |
| a client-aborted RSC stream is no longer reported as a render error (#96715) | the `The destination stream closed early` line of Batch 27 §4.4 / §11, measured again in §5 and §7 |
| `forbidden()` / `unauthorized()` stabilisation reverted (#99734) | not used here |
| `optimisticRouting` default `true` (16.3 and 16.4) | set `false` in next.config.ts, unchanged |
| SIGTERM exits 143 (16.x, unchanged from 16.3.8) | §8 |

## 2. How the editor reaches "Ready" (brief Part 2)

### 2.1 The state machine

Read from the code at `fde2d87`, every step between opening the editor and the
word "Ready":

| # | Where | What happens | What the status line says |
|---|---|---|---|
| 1 | `admin/visual-editor/page.tsx` | the server checks the session (`requirePermissions`), reads the pages, routes, library and SEO targets, and renders the shell | — (document arriving) |
| 2 | `shell.tsx` | the shell hydrates; `canvas` state starts `EMPTY_CANVAS` | "Loading canvas…" |
| 3 | `canvas.tsx`, the mint effect | after mount, and on every new `canvasKey` (page, language, device, reload, every redraw), a new bridge id is minted, `loads` and `announced` reset, status `loading` | "Loading canvas…" |
| 4 | `canvas.tsx`, render | with a bridge id, the iframe is rendered with `?preview=1&editor=1&bridge=<id>` and keyed on `canvasKey-bridgeId`, so every new canvas is a new frame | "Loading canvas…" |
| 5 | `preview.ts` / `route-view.ts` | the canvas request is a canvas only for a session holding `content.view` and a well-formed bridge id; otherwise it renders as a plain page with no bridge | — |
| 6 | `editor-bridge.tsx` | the canvas hydrates; the bridge mounts, starts listening and announces once (`canvas.ready` + `canvas.structure`) | — |
| 7 | `canvas.tsx`, `onLoad` | the frame's load event: `loads + 1`, selection cleared, status `connecting` | "Connecting…" |
| 8 | `canvas.tsx`, the handshake effect | **only once `loads > 0`**: listen; ping every 500 ms; give up after 20 s | "Connecting…" |
| 9 | `editor-bridge.tsx` | every ping answered with `canvas.pong` and a fresh announcement, so an announcement made before the editor listened (step 6) is recovered | — |
| 10 | `canvas.tsx`, `onMessage` | a `canvas.ready` from this frame's own window, for this bridge id and slug: settled, `announced + 1`, status `ready` | **"Ready"** |
| 11 | `canvas.tsx`, give-up | 20 s after step 8 with no answer: status `error`; pings continue, so a late answer still turns it Ready | "Unable to connect" |

The defect is in step 8. Until the frame's load event fired, nothing was
listening, nothing pinged and nothing counted down, and a load event waits for
everything in the page: every image, stylesheet, font and script. A canvas
whose bridge had already mounted and announced (step 6), but with one picture
still on its way, was a live canvas nobody was listening to. With no timer,
the status read "Loading canvas…" for as long as the editor stayed open.
Every other path out of step 7 is bounded by step 11. This one was the only
unbounded wait in the machine.

### 2.2 The timeline diagnostic

Off unless the server runs with `EOD_EDITOR_DIAGNOSTICS=1`
(`src/lib/visual-editor/diagnostics-server.ts`). The switch is read on the
server, per request, and reaches only two components, as a `diagnostics` prop:
the editor's canvas (page → shell → `VisualCanvas`) and the bridge, which is
only ever rendered into an authorised editor canvas. A visitor's page gets
nothing in either mode. Production never sets it, so nothing is recorded,
printed or sent there. The test servers set it (`tests/helpers/server.ts`).

| Side | Records | Into |
|---|---|---|
| editor | `canvas.mint`, `canvas.frame`, `canvas.listen`, `canvas.load` (flagged `alreadyReady` when it is the answered document's), `canvas.frameState` (each second until it answers: address, `readyState`, addressed nodes), `canvas.ready`, the first `canvas.pong` and `canvas.structure`, every refused message by reason (origin, source, channel, version, bridge, content), `canvas.giveUp` | `window.__eodEditorTimeline` (500 entries) |
| canvas | `bridge.mount`, `bridge.readyState`, `bridge.listen`, `bridge.announce`, `bridge.ping`, `bridge.refused` | `window.__eodCanvasTimeline` |
| server | `[eod-diag] editor page=… ms=…`; `[eod-diag] canvas slug|route=… bridge=… answer=canvas|preview-only|no-page|published-no-session|published-no-content-view ms=…` | stdout |

The recorders only observe. The handshake's own lines are unchanged:
separate listeners, registered after the handshake's and removed with it.
`envelopeVerdict` (protocol.ts) names a refusal and decides nothing. No line
names an error, a cookie, a token or a query string.

`tests/browser/editor-watch.ts` is the test half. `launchChromium` installs it
on every context of every probe and stress script, and it watches requests,
still-pending requests, frames, console, page errors and crashes. A
`waitFor` on `getByText("Ready", { exact: true })` that times out (an appearing
wait; a wait for Ready to go is left alone) collects both timelines, the
frames, the canvas document's state (address, `readyState`, addressed nodes,
fonts, unfinished images), pending requests, the server's diagnostic and
failure lines, and `pg_stat_activity` with lock waits. It saves a screenshot
and the record under `.data/test/results/diag/`, then names one cause, in an
order that puts a cause before its consequences:

| | Answer | Decided by |
|---|---|---|
| J | the browser failed | the page closed or its renderer crashed |
| I | it was Ready and the wait did not see it | the status line holds "Ready", or the editor's last canvas event is `canvas.ready` |
| H | the database is waiting | a lock wait, a query active ≥ 5 s, or a transaction idle ≥ 5 s |
| A | the server did not answer | the editor document, or the canvas document, requested with no response |
| B | no canvas frame | no frame, or a frame that never asked for a canvas |
| C | the canvas failed or is not a canvas | a failed request, a status ≥ 400, the frame at another address, or a complete document with no editor addresses |
| G | the document never ended | headers came, the end never did |
| F | a canvas resource is pending and the bridge has not started | the canvas not `complete`, with what is still open |
| D | the bridge never started | no `bridge.mount` / `bridge.listen` |
| E | Ready was lost on the way | the editor never listened, no ping reached the bridge, or the editor refused every answer |
| U | none of these | — |

The verdict goes on the timeout's own message (so the runner's tail and the CI
job log carry it) and on a `diag editor-ready <cat> <label>: <reason>` line.

## 3. What it was (brief Part 3)

### 3.1 The two occurrences, read again

| | `motion-15b`, CI run 38469728627 (`c53e09b`, Chromium 153) | `advanced-motion`, local gate (`aa86b17`, Chromium 141) |
|---|---|---|
| the step | check 24b: the editor reopened on Home by `page.goto(…, load)`, the page loaded, and "Ready" never came within 60 s | A43: a reader's first editor load in a new context; the page loaded, and "Ready" never came within 60 s |
| what failed first | nothing: 43 checks passed, and the server printed no failure line | nothing: 42 checks passed |
| what was recorded | `locator.waitFor: Timeout 60000ms exceeded` and no more — no status line, no frame, no request log | the same |
| PostgreSQL at that server's teardown | no line at all. The run's only "unexpected EOF … with an open transaction" (21:48:04) is the `structure` probe's teardown, 14 minutes later | no line. The window's only EOF line (00:36:47) is again `structure`'s; the others are npm test's media-references at 00:07 |

A canvas whose server render was stuck in the database would have left a
connection mid-query when its server was killed, and that line. Neither
occurrence did. Neither server was waiting on PostgreSQL, so H, and an A or G
caused by it, is ruled out for both.

### 3.2 What the state machine allows

From §2.1, a 60 s wait for "Ready" with the outer page loaded and nothing
failing can only end in one of these states:

| State | Bounded before Correction 1? | After |
|---|---|---|
| "Loading canvas…": the frame's load never fired (a canvas subresource that never finished, or a document that never ended) | **no**: no listener, no ping, no timer — for as long as the editor stays open | the bridge's announcement is heard; Ready (R1, R4). With the bridge's own scripts withheld: "Unable to connect" at 20 s (R3) |
| "Connecting…" → "Unable to connect": loaded, but the bridge never answered | yes: 20 s, then an error with Reload | the same |
| no canvas: the shell never mounted it | — | the same, now classified (B) |

### 3.3 The reproduction attempts (pre-fix, `48bdac2`, diagnostics on)

| Run | Result |
|---|---|
| full browser suite, local (16.4.1 at `5b48edb`'s application, before the diagnostic) | 40/40 clean, 1,549 PASS |
| full browser suite, local, `48bdac2` | 41/41 clean, 1,563 PASS; no `diag editor-ready` line |
| CI run 38760318794, `48bdac2` | 40/41: every probe clean except `editor-diagnostics` D8, the diagnostic's own check. On Chromium 153 a canvas with its chunks aborted emptied its own content, and the watch called it C instead of D (fixed in `080f6de`, §3.7). No natural Ready hang |
| Stress run 38760323899, `48bdac2` | 20/21: `layers-glide-click` failed at once — the diagnostic's own observer effect (§3.5) — and every other stress script was clean. No Ready hang |
| matrix smoke runs | 18 waits, every one Ready |

**Not reproduced on 16.4.1.** The historical trigger was not captured: neither
occurrence recorded its status line. So which canvas request stalled, if one
did, is not known, and a bridge that never answered after `load` can't be
excluded for them. That path, though, ends in "Unable to connect" at 20 s and
is now named by the watch.

### 3.4 The fix

`src/components/admin/visual-editor/canvas.tsx` (`080f6de`):

1. **Listen from the frame's creation.** The handshake effect's guard was
   `if (!bridgeId || loads === 0) return;` and is now `if (!bridgeId) return;`.
   The message listener and the 20 s give-up are armed as soon as the frame
   exists. The bridge announces itself when it mounts, so a canvas whose
   bridge is up is Ready as soon as it answers, whatever the page is still
   downloading. A canvas that never answers says "Unable to connect" within
   20 s, where it used to say "Loading canvas…" for good. The effect still
   re-arms on every document the frame loads, so the 20 s also count from
   each load, as before.
2. **Ping only after a load, as before.** A ping reaches into the frame's
   window to post to it. Until the frame's first document arrives, that
   window belongs to the frame's initial empty document, and touching it
   from the parent changes the canvas (§3.5). The pings exist to re-ask a
   document whose first announcement was missed. Before a load there is
   nothing to re-ask: the listener is already there for the bridge's own
   announcement.
3. **The document that answered is remembered,** and its own load event,
   which can now come after Ready, changes nothing. The selection stays and
   the status stays Ready. Any other document's load is handled exactly as
   before.
4. **A message from the editor's own window returns at once,** before the
   source check reads the frame's window. The check itself is unchanged.

What did not change: what Ready means (a `canvas.ready` from this frame's own
window, for this bridge id and slug), the message checks, the 500 ms and the
20 s, the bridge, the protocol and the server. The Layers tree does not need
the load event. `readStructure` reads only DOM attributes and text, and no
public route streams in parts (no `Suspense`, no `loading.tsx`), so the DOM a
bridge reports when it hydrates is the whole page.

### 3.5 What the diagnostic itself got wrong, and what that showed

CI run 38760323899 (Stress, `48bdac2`) failed at once in
`layers-glide-click`: its init script's hook was undefined in the canvas, and
the same happened here every time. `48bdac2`'s frame sampler read
`frame.contentDocument` the moment the frame was created. A bare page with a
same-origin child shows the rule (Chromium 141):

| What the parent did before the child's document arrived | Where the context's init script ran |
|---|---|
| nothing | the child document |
| `void frame.contentWindow` | `about:blank`, never in the child |
| `frame.contentWindow.postMessage(…)`, at once or after 100 ms | `about:blank`, never in the child |
| read `frame.contentDocument.readyState` | `about:blank`, never in the child |
| read `frame.contentWindow.location.href` | `about:blank`, never in the child |

Touching the frame's window early makes Chromium set up the initial empty
document's window. The same-origin canvas then inherits it, and anything the
browser runs at the start of a new document runs against the empty one
instead. A recorder must not change what it records, so the sampler now
starts at the first load, the give-up records only the frame's address
before one, and `frameSnapshot` documents the rule. It is also why the fix
does not ping from the frame's creation (point 2 above). R5 holds both: with
the canvas document held for 1.5 s, an init script must still run in the
canvas itself.

### 3.6 The regression tests, and the builds they catch

`editor-diagnostics` (19 checks) carries the fix's checks. Each one was run
against builds with the fix taken away, so it is known to test the fix. The
two mutants are `080f6de` with one line changed, built cold and run with
`080f6de`'s own probe:

| Check | Fault caused | `080f6de` | guard restored (`loads === 0`) | pings from the frame's creation | `48bdac2` |
|---|---|---|---|---|---|
| D2 | none: a healthy editor; the editor must listen before the frame's load | PASS | **FAIL** | PASS | **FAIL** |
| R1 | every image inside the canvas held | PASS: Ready, canvas `interactive` | **FAIL**: never Ready | PASS | **FAIL** |
| R2 | R1, then the images let go | PASS: the load recorded `alreadyReady`; still Ready, selection kept | **FAIL** | PASS | **FAIL** |
| R3 | the canvas's own scripts held: no bridge, no load | PASS: "Unable to connect" 20 s after opening | **FAIL**: "Loading canvas…" at 38 s | PASS | **FAIL** (38 s) |
| R4 | the canvas document passed on whole, its end withheld (a proxy) | PASS: Ready, canvas `loading` | **FAIL**: never Ready (G) | PASS | **FAIL** |
| R5 | the canvas document held 1.5 s; a context init script records where it runs | PASS: in the canvas | PASS | **FAIL**: `about:blank` | **FAIL**: `about:blank` |
| the other 13 | A–J, each caused once; diagnostics off | PASS | PASS | PASS | PASS |

Two of the diagnostic's own faults changed with the fix. Before it, an
unfinished image (F) and an unended document (G) were enough to keep the
editor from Ready. After it they are not, and they became R1 and R4. F and G
are now faults that withhold what the bridge itself needs: the canvas's
scripts (D10) and its body (D11, the document stopped after 512 bytes).

### 3.7 The watch, corrected by CI

On CI's Chromium 153, `editor-diagnostics` D8 (every canvas chunk aborted)
once left a canvas the server had answered as one (`answer=canvas`) with no
addresses in it. The editor's own samples show the content going after
`load`, and four chunk requests failed about half a second later — the
loader's retry. The watch called it C ("not a canvas"). It was D: the
canvas's client started from the chunks it already had, failed for want of
the rest, and React removed what it could not hydrate. The watch now reads
the server's answer for the frame's own bridge id (`canvasAnswer`), and calls
a complete canvas with no addresses C only when the server did not answer it
as a canvas.

### 3.8 Classification

**Product.** The defect is in the editor's state machine (`canvas.tsx`). It
waited on the frame's load event with no listener and no timer, so any canvas
resource that never finished became an editor that never said why. It is not:

- **the framework:** the same code waits the same way on any version;
- **a bridge race:** the bridge re-announces on every ping and announces at
  mount;
- **a probe race:** the waits are plain 60 s waits for a visible word, and I —
  Ready but not seen — is now detected;
- **the harness:** no probe intercepts a request in either step, and the
  launch keeps Playwright's defaults (throttling off).

Why it showed only on Next 16 and only in full runs is not established. The
loader has no timeout for a chunk request that never answers (16.4.1's
Turbopack runtime retries a failed chunk once after 200–600 ms; a pending one
waits for ever), but no stalled request was observed here.

## 4. The reproduction matrix (brief Part 4)

`tests/browser/matrix/editor-ready.matrix.mts`, on `080f6de`'s own cold
production build, one condition at a time with nothing else running
(4 CPUs, Chromium 141), 16:52–17:16 UTC on 15 October. Every wait is the
probes' own 60 s wait for "Ready", timed from the action that asked for the
canvas, and each goes through the editor watch. A redraw counts only once a
new canvas document is on screen; a redraw that never began would count as a
failure of its own. Opens rotate through eight ways of reaching a canvas:

- *start*: the first open after the server starts, restarted for it every
  50 opens and at the beginning;
- *reopen*: the same page navigated to again;
- *direct*: a new context, cold cache;
- *admin*: from the dashboard by the sidebar link, a client-side navigation;
- *switch*: another page or route chosen in the editor's own picker;
- *save*, *discard*, *publish*: a field saved, then discarded or published
  from the route's drawer, and the redraw that follows each.

They cover eight resources — Home, About, Contact, `/services`, the
travel-tourism, business-setup and iqama-services categories, and a
service's own page — in English and Arabic, at Desktop and Mobile.

| Condition | Waits | Ready | Not Ready | Skipped | Median / p90 / max to Ready | Also |
|---|---|---|---|---|---|---|
| normal: nothing else running | 200 | **200** | 0 | 0 | 908 / 1,508 / 1,601 ms | 4 server starts |
| moderate CPU load: two busy loops the whole time | 100 | **100** | 0 | 0 | 1,122 / 1,611 / 2,170 ms | |
| concurrent public traffic: three visitors reading public pages | 100 | **100** | 0 | 0 | 1,100 / 1,567 / 1,715 ms | 3,137 page reads beside them |
| a second editor saving another route, same server | 100 | **100** | 0 | 0 | 1,174 / 1,574 / 2,137 ms | 78 saves by the second editor |
| EN ↔ AR flips: 50 cycles, every other one on another resource chosen first | 100 | **100** | 0 | 0 | 444 / 590 / 1,126 ms | 25 resource switches |
| **Total** | **600** | **600** | **0** | **0** | | |

By mode, the opens (500) were:

| start | reopen | direct | admin | switch | save | discard | publish |
|---|---|---|---|---|---|---|---|
| 10 | 70 | 70 | 70 | 70 | 70 | 70 | 70 |

By language, 295 English and 205 Arabic opens. By device, 297 Desktop and
203 Mobile; the dashboard leg always lands on English Desktop. No wait timed
out, so the watch wrote no verdict: there is no `diag editor-ready` line in
any of the five logs. Every server stayed up.

**With the timeline off, as production runs it.** Every test server runs
with `EOD_EDITOR_DIAGNOSTICS=1`, so the 600 waits above ran with the
recorders on. The same matrix was run once more with the server's switch
off, through a scratch copy of the matrix that differs only in that
(`.data/probe`, not tracked). Same build, normal condition: **200 of 200 Ready**, none
not Ready and none skipped, median 820 ms, p90 1,516 ms, max 2,016 ms. The
opens covered the same eight ways, resources, languages and devices, and the
server stayed up.

**The full suites, repeatedly**, on `080f6de` on CI (Playwright's Chromium 153):

| Run | Browser QA | Stress | `npm test` |
|---|---|---|---|
| CI 38772613929, Stress 38772618741 | 41/41 probes clean, 1,568 PASS | 21/21 clean, 192 PASS | 2,151/2,151 |
| CI 38777237613, Stress 38777240772 | 41/41, 1,568 | 21/21, 192 | 2,151/2,151 |
| CI 38785486768, Stress 38785489170 | 41/41, 1,568 | 21/21, 192 | 2,151/2,151 |

Every wait on "Ready" in them went through the watch. None ran out: no job
log carries a `diag editor-ready` line, an `UNCLEAN` probe or a 60 s
timeout. The suites ran again in full on the final commit, locally and on
CI (§10).


## 5. React #418 on 16.4.1 (brief Part 5)

The Batch 27 instrument, unchanged: `tests/browser/matrix/hydration.matrix.mts`.
It counts every canvas or page document the browser loads, and every error
React recovers from in it, with React's own component stack. **A recovered
error counts.** The same 34 runs and classes as Batch 27 §4.3:

- **A** normal;
- **B** heavy (four busy loops, the server at the lowest priority);
- **C** moderate (a second editor saving and redrawing, three visitors);
- **D** signed-out visits (the `visits` rows);
- **E** slow network (150 ms, 1.6 Mbit/s);
- **F** normal and mobile networks.

They ran on `080f6de`'s own cold production build, one at a time with
nothing else on the machine, 17:17–18:54 UTC on 15 October. Next 16.4.1 was
reported by every run, `dirty=0` by every run.

**The instrument still sees on 16.4.1.** A scratch copy of `080f6de` with one
extra page, `/eod-mismatch`, renders text that differs between server and
browser. It was built and served like the candidate. On **10 of 10** visits
the capture reported #418, with React's stack `p ← li ← ul ← section`, and
the page then showed "drawn in the browser" — React re-rendered it on the
client — with 10 page errors. The same build's `/about` gave **0 of 10**. The
positive control on 15.5.25 is Batch 27's (7 in 120, §2 there); that build
has not changed.

| Run | Class | Mode | Network | Documents | #418 | Visits beside | Seconds |
|---|---|---|---|---|---|---|---|
| A1-normal-loads-none | normal | loads | none | 40 | 0 | 0 | 90 |
| A2-normal-loads-broadband | normal | loads | broadband | 40 | 0 | 0 | 91 |
| A3-normal-redraws-none | normal | redraws | none | 81 | 0 | 0 | 112 |
| A4-normal-redraws-broadband | normal | redraws | broadband | 61 | 0 | 0 | 84 |
| A5-normal-visits-none | normal | visits | none | 40 | 0 | 0 | 54 |
| A6-normal-visits-broadband | normal | visits | broadband | 40 | 0 | 0 | 60 |
| E1-slow-visits-01 | normal | visits | slow | 40 | 0 | 0 | 110 |
| E1-slow-visits-02 | normal | visits | slow | 40 | 0 | 0 | 109 |
| E1-slow-visits-03 | normal | visits | slow | 40 | 0 | 0 | 110 |
| E1-slow-visits-04 | normal | visits | slow | 40 | 0 | 0 | 109 |
| E1-slow-visits-05 | normal | visits | slow | 40 | 0 | 0 | 109 |
| E1-slow-visits-06 | normal | visits | slow | 40 | 0 | 0 | 110 |
| E1-slow-visits-07 | normal | visits | slow | 40 | 0 | 0 | 110 |
| E1-slow-visits-08 | normal | visits | slow | 40 | 0 | 0 | 110 |
| E1-slow-visits-09 | normal | visits | slow | 40 | 0 | 0 | 110 |
| E1-slow-visits-10 | normal | visits | slow | 40 | 0 | 0 | 110 |
| E2-slow-loads | normal | loads | slow | 30 | 0 | 0 | 82 |
| E3-slow-redraws | normal | redraws | slow | 61 | 0 | 0 | 94 |
| F1-mobile-visits-1 | normal | visits | mobile | 40 | 0 | 0 | 77 |
| F1-mobile-visits-2 | normal | visits | mobile | 40 | 0 | 0 | 77 |
| F2-mobile-loads | normal | loads | mobile | 40 | 0 | 0 | 96 |
| C1-moderate-loads-none-1 | moderate | loads | none | 111 | 0 | 1031 | 109 |
| C1-moderate-loads-none-2 | moderate | loads | none | 111 | 0 | 1058 | 107 |
| C2-moderate-loads-broadband | moderate | loads | broadband | 109 | 0 | 1038 | 106 |
| C3-moderate-redraws-none-1 | moderate | redraws | none | 160 | 0 | 1277 | 122 |
| C3-moderate-redraws-none-2 | moderate | redraws | none | 164 | 0 | 1305 | 122 |
| C4-moderate-visits-broadband | moderate | visits | broadband | 89 | 0 | 722 | 77 |
| C5-moderate-loads-slow | moderate | loads | slow | 111 | 0 | 1138 | 113 |
| C6-moderate-redraws-broadband | moderate | redraws | broadband | 162 | 0 | 1282 | 125 |
| C7-moderate-visits-slow | moderate | visits | slow | 113 | 0 | 1182 | 115 |
| B1-heavy-loads-none | heavy | loads | none | 30 | 0 | 0 | 622 |
| B2-heavy-visits-none-1 | heavy | visits | none | 40 | 0 | 0 | 725 |
| B2-heavy-visits-none-2 | heavy | visits | none | 40 | 0 | 0 | 682 |
| B3-heavy-visits-slow | heavy | visits | slow | 40 | 0 | 0 | 813 |

| Class | Runs | Documents | #418 |
|---|---|---|---|
| A normal | 6 | 302 | **0** |
| E slow (with D: signed-out visits) | 12 | 491 | **0** |
| F mobile | 3 | 120 | **0** |
| C moderate | 9 | 1,130 | **0** |
| B heavy | 4 | 150 | **0** |
| **Total** | **34** | **2,193** | **0** |

Beside them:

- 10,033 visits by the moderate class's readers;
- 539 saves across both editors, none lost (the last value typed was the
  value stored in every redraw run);
- nothing stored that nobody asked for, and no selection left unrecovered;
- no page error and no failed Server Action in any editor or visitor;
- no 5xx, the server up in every run and never restarted.

**No server failure line in any run.** On 16.3.8, `The destination stream
closed early` appeared in 8 of these 34 runs: E2, F2, C5, C7, B1, both B2
runs and B3 (Batch 27 §4.4). On 16.4.1 it appeared in none. That is 16.4.0's #96715,
which no longer reports a client-aborted RSC stream as a render error.
Measured directly in §7.

**#418 = 0** on the final build, in every class, with recoverable errors
counted. 16.4.1 vendors the same `react-dom-client` as 16.4.0 (§1), which
keeps the replay fix.


## 6. Server Actions and transitions (brief Part 6)

The tests Batch 27 §5 named for each behaviour, run again on `080f6de`'s own
build (16.4.1), with the ones that carry a redirect or a pending state
repeated. 18:57–19:38 UTC on 15 October, one at a time, nothing else running:

| Behaviour | Held by | On `080f6de` |
|---|---|---|
| Created and deleted, the redirect landing every time: a package, a category, a service | stress `admin-form-settle` F5–F10: 36 creates and 36 deletes of each a run, three servers, each restarted cold before every action, nothing touched while waiting | **3/3 runs clean**, 30 PASS: every one of the 648 redirects landed |
| A save that answers, not redirects, reaches the screen | `admin-form-settle` F1–F2: an account, a question, 72 a run | 216 of 216 |
| Nothing lost, nothing done twice | `admin-form-settle` F3 (every row stored exactly once); `create-navigation` N4 (nothing created twice) | held |
| Navigation after a mutation | stress `create-navigation` N1–N5: every create lands on its component's page by a document load, every delete returns to the list, three servers at once | **1/1 clean**, 5 PASS: 90 of 90 creates, 30 of 30 deletes |
| The scroll position across navigations | probe `navigation-scroll` | **3/3 clean**, 9 PASS |
| A service made, edited, published, moved between categories and deleted through the screens; the editor reopened at the new address with its draft | probe `route-services` | **2/2 clean**, 222 PASS |
| The editor's save, publish and discard; direct editing on the canvas; autosave; switching resources | probes `publish`, `discard`, `autosave`, `layers-editing`, `route-categories`, `route-packages` | **6/6 clean**, 298 PASS — publish 20, discard 16, autosave 20, layers-editing 48, route-categories 110, route-packages 84 |
| Racing writes, a pending state that settles, a publication under load | stress `route-concurrency`, `package-concurrency`, `service-concurrency`, `service-form-concurrency` (F7: every racing write answered within 15 s) | **4/4 clean**, 46 PASS — the slowest racing write answered in 804 ms against F7's 15 s; 10,392 reads during drafts, discards and publications all whole, no draft in public |

No "Saving…" stayed up and no redirect was dropped; no create was stored
twice and none went missing. Every script and probe prints page errors,
failed Server Actions and server failure lines as `diag` lines, and none
was printed. `create-navigation`'s own summary: 0 page errors, no digest, no
unasked server exit across 93 server starts. The same build also took the
editor through 70 saves, 70 discards and 70 publishes in the Ready matrix
(§4), each redraw Ready. It took 539 saves in the #418 matrix (§5), none lost.

### 6.1 The suspended transition, with the workaround taken away again

`useSettledActionState` (`components/admin/form.tsx`) nudges React when an
answer has arrived but is not on screen. Batch 27 §5.1 showed the stall it
exists for. On 15.5.25, 21 of 288 actions stalled: the row was stored and the
screen never moved (`rows 1`). On 16.3.8, 0 of 576 did. Here the same was done
to a scratch copy of `080f6de` with only `NUDGE_FOR_MS` set to `0`, built and
run the same way:

| Runs, nudge off | Answers that arrived and never reached the screen | Anything else |
|---|---|---|
| 2, the script as at `080f6de` | **0 of 576** | one create was never submitted, so nothing was stored (`rows 0`): the lost click of §6.2 |
| 2, the script with §6.2's fix | **0 of 576** | nothing: 2/2 runs clean, 20 PASS |

The stall the workaround exists for did not appear on 16.4.1. The workaround
stays, for Batch 27's reasons.

### 6.2 A click a smooth scroll took away — the test harness

The `rows 0` of the run with the nudge off was not that stall, because nothing
had been stored. The script was run again with a recorder, a scratch copy in
`.data/probe`. It logged the requests, the React root's lanes, and every
pointer, click and submit event with the page's scroll position. The same
thing then happened on the build as shipped. Fifteen full runs were made on
16.4.1, of the script itself (three of them on CI) or of its copy. In three
of them, one create in 108 was never submitted. The first showed only the
script's own signs: nothing stored, and the screen never left. The other two
were recorded, and both showed the same:

- no request was sent, and 8 s after the click the button did not say
  "Saving…";
- React's root had no lane pending and no work scheduled;
- the fields still held what had been typed, and the URL had not moved.

In the third, the recorder caught the press itself:

| ms | event | target | `scrollY` |
|---|---|---|---|
| 1,865 | `mousedown` | the "Create category" button | 543 |
| 1,970 | `mouseup` | the form | 501 |
| 1,971 | `click` | the form | 501 |
| 2,029 | `scrollend` | — | 490 |

The press reached the button. The release, 105 ms later, did not: the page
had scrolled 42 px between them. A `click` goes to the element that holds
both the press and the release, which here was the form. So nothing was
submitted, and Playwright reported the click done.

**Why the page moved.** `globals.css` sets `html { scroll-behavior: smooth }`,
and the create buttons sit below the fold.

1. Playwright's first attempts found the button moving, because the fills'
   own scrolling was still animating, so it retried.
2. Its retries take turns scrolling the element into view with
   `scrollIntoView({ block: "end" })`, `"center"` and `"start"`, and pass no
   `behavior`. Under that CSS the scroll is an animation, and the press is
   sent as it begins.
3. Playwright's hit-target check reads only the press. On an idle machine the
   release follows within a millisecond. With three servers and three
   browsers on four CPUs, it came 105 ms later.

**Made on purpose** (`.data/probe/lost-click.mts`, scratch). The script's own
steps — load, fill, click — with the release held 120 ms after the press:

| Context | Clicks lost | What was recorded |
|---|---|---|
| as the script opened it | **10 of 10** | press on the button at `scrollY` 543; release and click on the form at 490–493; nothing submitted |
| `reducedMotion: "reduce"` | **0 of 10** | press, release and click on the button; the form submitted |

`globals.css` answers prefers-reduced-motion with `scroll-behavior: auto`, so
every scroll is a jump that has finished before the press.

**Classification: the test harness, not the product.** The form submits
whatever click it is given. The click was taken from it by a scroll Playwright
asked for, which the page then animated. A person's click is not preceded by a
programmatic scroll.

**Fixed in the test.** `admin-form-settle` now opens its contexts with
`reducedMotion: "reduce"`, as `permissions` and `layers-editing` already
do. Nothing it measures depends on motion. With the fix, on the build as
shipped: **3 of 3 runs clean**, 30 PASS. That is 864 actions, and every one of
the 324 creates was submitted and landed. The only other script that fills and then clicks under
parallel load is `create-navigation`. Its form is one row at the top of the
list, with "Create draft" beside the field it fills, so nothing scrolls. It
is unchanged.

## 7. Regression (brief Part 7)

Every Batch 26 and Batch 27 behaviour is held by the same suites, run in full
on the final commit (§10): the tracked `npm test`, the browser probes and the
stress scripts. **No assertion was weakened, and no test is skipped.**

- **What changed in the tests, and nothing else did:**
  - every browser comes with the editor watch (`harness.ts`), and the watch
    only listens. A wait on "Ready" that runs out still runs out at its own
    60 s. The watch collects its evidence first, and `editorReady`
    (`canvas.ts`) adds the watch's verdict to its own message;
  - every test server runs with the timeline on (`tests/helpers/server.ts`).
    A test that needs it off says so, as `editor-diagnostics` D14 does. The
    shipped mode, off, was measured on its own (§4, §8);
  - `editor-diagnostics` (19 checks) and the reproduction matrix were added;
  - `tests/browser-suite.test.ts` counts the new probe, 40 → 41;
  - `admin-form-settle` opens its browser contexts with reduced motion, so
    that a smooth scroll cannot take a click away from it (§6.2).

  No existing check, wait or timeout was changed. The probes' expected passes
  went from 1,549 to 1,568. `npm test` is 2,151 tests, as at `fde2d87`.
- **Every probe and stress script now runs through the watch.** On all three
  CI runs at `080f6de`, 41/41 probes were clean (1,568 PASS) and 21/21 stress
  scripts were clean (192 PASS). No log printed a `diag editor-ready` line.
- **Client-side navigation through the middleware.** The Batch 27 scratch
  walk ran on `080f6de`, signed out, three rounds: Home → Services → a
  category → a service → Packages → a package → back → About → the Arabic
  About → Arabic Services → Arabic Home. Every step reached its page. The
  router made 119 RSC requests: 106 prefetches and 13 navigations, the rest
  served from prefetches. Every one answered 200 at the address the router
  chose; none was redirected, and there was no console error and no
  recovered error. On 16.3.8 (`c53e09b`) the same walk made 110.
- **The stream-closed line, measured directly.** The Batch 27 scratch pair:
  a script that reads five public pages whole (the control) and then
  abandons twenty after their first chunk, and the same done by a browser
  that leaves pages while they stream. Run on `080f6de`:
  - the script: twenty reads abandoned, and no failure line, as on 16.3.8;
  - the browser: 21 pages left mid-stream, **0 failure lines and 0 `The
    destination stream closed early`**. On 16.3.8 the same pages gave 144
    failure lines and 36 of those errors (Batch 27 §4.4);
  - the control, the same pages read whole: none on either release.

  The line Batch 27 recorded as new in the service's log is gone with
  16.4.1.
- **Lint.** 0 errors, 40 warnings: the same 40 as at `fde2d87`.

## 8. The build, the artifact and `deploy.sh` (brief Part 8)

**The build.** Cold, as `deploy.sh` builds: `.next` removed and the
database unreachable, on `080f6de`. Its output differs from 16.3.8's
(`fde2d87`'s gate) only in the version line, `▲ Next.js 16.4.1 (Turbopack)`.
It has the same route table and the same one warning, the `middleware` →
`proxy` deprecation. `npm ci`, lint, typecheck and the same cold build passed
in each of the three CI runs at `080f6de` (the Static job), and again on the
final commit (§10).

**The artifact, proved.** The Batch 27 scratch check (§7.2 there) does what
`deploy.sh` and the unit do:

1. step 7's commands in the build tree;
2. `cp -a` into `standalone.incoming` and `mv -T` onto
   `<app>/.next/standalone`;
3. the build tree **deleted**;
4. `node .next/standalone/server.js` started from the app directory as
   `nobody`, able to write only the uploads directory and the two cache
   directories.

It ran on `080f6de`'s build, with three checks added for Correction 1. The
diagnostics switch is off in the runtime: the editor page and the canvas carry
`diagnostics=false`, and there is no `[eod-diag]` line. As a control, the
same runtime was started with `EOD_EDITOR_DIAGNOSTICS=1`: the canvas carries
`true` and the server prints its line, while a visitor's page still carries
nothing. **51 checks, 51 ok, 0 bad**:

- the external alias `sharp-20c6a5da84e2135f → ../../node_modules/sharp`
  resolves after staging; `server.js` sits at the runtime root and the release
  marker survives;
- `▲ Next.js 16.4.1 … Ready`, started as `nobody` with the build tree gone;
- the public pages answer 200: Home, About, Services, a category, Packages, a
  destination, Search, and the Arabic Home, Services and About.
  `/en/about` → 301 `/about`, and an unknown page → 404;
- a CSP with a fresh nonce on every request, carried by every executable
  `<script>` (18 of 18). The 2 JSON-LD data blocks carry none, and CSP does not
  apply to data blocks;
- `X-Content-Type-Options`, `Referrer-Policy`, `X-DNS-Prefetch-Control`,
  `Permissions-Policy`, `Strict-Transport-Security`, and no `X-Powered-By`;
- `robots.txt`; `sitemap.xml` (186 addresses); `?preview` answers `noindex`
  and `no-store`;
- a static chunk and a font `immutable` for a year; a stylesheet; a brand
  file;
- `/media/<file>` served from `UPLOAD_DIR`, and a traversal refused. The
  traced sources, `/.env`, the release marker, `server.js` and
  `package.json` are not served;
- `/admin/login`; `/admin` unsigned → 307 to the login; signed in → 200. The
  Visual Editor page and a canvas document answer;
- an image uploaded through `uploadMedia`, decoded by `sharp` in the runtime,
  with its derivatives in `UPLOAD_DIR`;
- no failure line in the server's output.

**`deploy.sh`.** Nothing under `deploy/` changed in this correction
(`git diff fde2d87 080f6de -- deploy/` is empty), and `deploy/previous-release`
still names `902a0e6`. The standalone layout `deploy.sh` stages is the one
Batch 27 §7.1 read: `server.js`, `.next/`, `node_modules/`, `package.json`
and the traced `src/` at the root, `public/` and `.next/static` copied in by
step 7, and the same Turbopack alias for `sharp` under `.next/node_modules`,
by the same name. So the staging (`cp -a`), the switch and every rollback
(`mv -T`), and the release marker work as they did.

**One difference from 15.5.25 that the unit will show.** Next 16's server
handles SIGTERM, closes its connections and then **exits with status 143**
(`process.exit(143)` in `start-server.js`). 15.5.25 exited 0. Measured:
`node .next/standalone/server.js`, one request, SIGTERM, twice each: 16.4.1
exited 143 in 14 ms, the 15.5.25 build 0 in 20–25 ms. 16.3.8's
`start-server.js` has the same `process.exit(143)` (read from its npm
tarball), so this is not new in 16.4.1. It is new against production.

The unit (`deploy/elite-one-desk.service`) sets `KillSignal=SIGTERM` and no
`SuccessExitStatus`. systemd counts only status 0 and death by SIGHUP,
SIGINT, SIGTERM or SIGPIPE as a clean exit, so after every
`systemctl stop` the unit will read `failed` (`Result: exit-code`, status
143), not `inactive`. The stop itself completes: a stop job is done once
the unit is inactive or failed, so `systemctl stop` returns success either
way. `deploy.sh` judges the outcome by `systemctl is-active`, which is false
either way. The main path's stop, switch, start and health checks, and the
rollback's stop, work unchanged. A `systemctl start` starts a failed unit as
it does an inactive one.

This was read from systemd's rules and the script, not run: this sandbox
has no systemd. What changes is what an operator sees: a `failed` unit
after every deploy's stop, until its start, and after any manual stop.
`SuccessExitStatus=143` in the unit is the one line that makes it read
clean again. It also takes away the one way this could matter to the
script: a systemd that answered that stop with an error would stop
`deploy.sh` (`set -e`) at step 12 with the service down. The unit is
installed by hand on the server, so that is the owner's change, made with
the release. It is not made here.

**The production form of the `/en/…` redirect**, again on `080f6de` (a
scratch build with `NEXT_PUBLIC_SITE_URL=https://www.example.test` inlined):
`GET /en/about` → **301 `https://www.example.test/about`**, `GET /en` →
**301 `https://www.example.test/`**. Both were asked with nginx's forwarded
headers and on the port directly, and both are unchanged from 16.3.8.

## 9. `npm audit` (brief Part 9)

Read-only. `npm audit --json --package-lock-only` was run on each tree's own
`package.json` and `package-lock.json`, all three in the same minute
(15 October, about 16:55 UTC), so they were judged against the same advisory
data. `npm audit fix` was never run.

| Tree | Critical | High | Moderate | Low | Total |
|---|---|---|---|---|---|
| `edcb4f4`, Batch 26 baseline (15.5.25) | 0 | 7 | 5 | 0 | 12 |
| `fde2d87`, Batch 27 (16.3.8) | 0 | 6 | 4 | 0 | 10 |
| this correction (16.4.1) | 0 | 6 | 4 | 0 | 10 |

- **Against the baseline:** removed `next` (moderate: GHSA-4jqv-mc3x-m676,
  GHSA-mcj8-r9mp-w47p) and `postcss` (high: GHSA-6g55-p6wh-862q,
  GHSA-fxqj-rqcc-2cmp, GHSA-qx2v-qp2m-jg93, GHSA-r28c-9q8g-f849). Nothing
  added, no severity changed.
- **Against 16.3.8:** identical — nothing removed, added or changed.
- **The ten that remain are all build tooling, as at 16.3.8:**
  - the `eslint-config-next` / `@next/eslint-plugin-next` chain, through
    `fast-glob` → `micromatch` → `braces` (GHSA-vfj7-8cjw-p6xm), high;
  - `source-map-js` (GHSA-68fv-2mgg-jv7q), high;
  - the `drizzle-kit` chain, through `@esbuild-kit/*` → `esbuild`
    (GHSA-67mh-4wv8-2f99), moderate.

  None is new, and none is Critical.
- **The October update and the feed.** npm audit flags `next` in none of the
  three trees for the 14 October advisories. It still reports nothing against
  16.3.8, which the advisories themselves place inside every affected range
  (§1). The registry's audit data had not caught up when this was run, so
  `npm audit` is not evidence either way. The version decision rests on the
  advisories and the release.

## 10. The gate (brief Part 10)

Five commits on `batch-27-next16-qualification`, on top of `fde2d87`:

| Commit | What |
|---|---|
| `5b48edb` | Next.js 16.4.1: `next`, `eslint-config-next` and the 12 lock entries npm moved (§1); the optimistic-routing comment names the right upstream issue |
| `48bdac2` | the readiness timeline (gated, §2.2), the editor watch, `editor-diagnostics` (14 checks), the reproduction matrix |
| `080f6de` | the fix (§3.4), the timeline's own correction (§3.5), `editor-diagnostics` to 19 checks (§3.6), the watch's two corrections (§3.7) — the build every measurement in §4–§8 was made on |
| the test fix | `admin-form-settle` opens its contexts with reduced motion (§6.2) — one test file |
| this record's commit | this record, the browser README's notes on the editor and on clicks under load, and a pointer from the Batch 27 record to this one — documentation only |

From `080f6de` to the final commit the diff touches one test file and
Markdown, and nothing under `src/`, `public/` or the configuration. So the
application build the measurements of §4–§8 were made on is the build the
final commit makes.

The gate runs on the final commit, in order, each step from the one before,
nothing skipped, on this machine (4 CPUs, PostgreSQL 16, Chromium 141):

1. `npm ci --include=dev --ignore-scripts`, then `npm rebuild sharp`;
2. the test fixtures rebuilt (`REBUILD_FIXTURES=1`);
3. a cold production build, with `.next` removed and `DATABASE_URL`
   unreachable;
4. `npm run lint`;
5. `npm run typecheck`;
6. `npm test`;
7. every browser probe (`npm run test:browser`);
8. every stress script (`npm run test:stress`);
9. the security and compatibility set: the destructive-DDL search, and the
   `schema-compat`, `permissions-*`, `globals-permissions`,
   `build-isolation`, `public-routes`, `cta-audit`, `browser-suite`,
   `dependency-advisories` and `deploy-target` tests;
10. `npm audit`.

Then the commit is pushed and CI and Stress are dispatched on exactly it.
This record is part of the commit the gate measures, so the gate's results
and the two run IDs are not written here: they are in the batch's report.


## 11. What is not settled

- **What stalled the two historical occurrences is not known.** Neither
  recorded the editor's status line, so which canvas request never finished,
  if one did, cannot be read back (§3.3). The fix removes the one unbounded
  wait the state machine had. A canvas whose bridge never answers after its
  load was always bounded: it says "Unable to connect" after 20 s and is not
  "Ready". That path can't be excluded for the two old occurrences. It did not
  happen once after the fix: not in the matrix's 600 waits, the #418 matrix's
  2,193 documents, the retests of §6, or any full run of the suites (§4,
  §10). If an editor ever fails to become Ready again, the watch now prints
  which of A–J it was.
- **Why it showed only on Next 16, and only in full runs, is not
  established.** No stalled canvas request was observed on 16.4.1.
- **Next.js 16.4.2** (20:57 UTC, 15 October) is a maintenance release with no
  security content, and was not taken (§1). Its Turbopack fixes, including
  lazy dynamic-import chunk-list collisions, are for a later batch to weigh
  and qualify.
- **Optimistic routing stays off.** 16.4.0 fixed the prefetch loop that
  Batch 27 turned it off for (§1), and `prefetch-bounded` passed with
  16.4.1's default. Turning it on changes how every navigation is routed. It
  is a change of its own and was not qualified here.
- **The `npm audit` feed.** It did not yet carry the 14 October advisories
  when this was run (§9), so it cannot confirm them either way. The version
  decision rests on the advisories and the release.
- **Still as Batch 27 §11 recorded them, unchanged by 16.4.1:**
  - the heavier client and the extra prefetches (Batch 27 §6.1);
  - the browser targets (Chrome/Edge/Firefox 111+, Safari 16.4+);
  - `middleware` → `proxy`, deprecated and kept;
  - a bare `RSC: 1` request without router headers;
  - the `/favicon.ico` 404 in the panel;
  - the redirect form in production, read again on `080f6de` (§8).
- **No longer open:**
  - `The destination stream closed early` in the service's log: 16.4.1
    does not log a client leaving mid-stream (§5, §7);
  - the editor's "Ready" (Batch 27 §6.3), for the reason above;
  - the 14 October security update (Batch 27 §11): taken (§1).
- **Clicks under load.** The lost click of §6.2 needs three things:
  - a click straight after fills, on a page that glides;
  - a retry that scrolls;
  - a release held back by a loaded machine.

  Only `admin-form-settle` was seen to lose one, and it is fixed. The probes
  click one at a time with nothing else running. The browser README now says
  what a script that clicks under load should do.
- **Lint warnings.** 40, the same 40 as at `fde2d87`: 38 React Compiler
  readiness warnings and 2 from a Next rule. None is new, and none is an
  error.
- **Local browser.** The matrices, the retests and the local gate used the
  sandbox's Chromium 141. CI uses Playwright's own Chromium 153. The Chromium
  153 evidence is the three CI and three Stress runs of §4, and the final
  commit's (§10).
- **Not measured: production.** No request went to the live website or its
  server, and the production database was not read. `902a0e6` was not built
  or measured.
