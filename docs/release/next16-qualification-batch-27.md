# Next.js 16 qualification — Batch 27

**Status: qualification record, not a release approval.** Production deployment
is not authorized by this document. Batch 27 did not access the VPS or the
production database, ran no production migration, did not change
`deploy/previous-release` and created no tag. Its branch is not merged.

| | |
|---|---|
| Base | `edcb4f4` — Batch 26 Correction 1, fast-forwarded onto `main` (`7c3a00d` → `edcb4f4`, no commit rewritten) |
| Branch | `batch-27-next16-qualification` |
| Production baseline | `902a0e6` (`deploy/previous-release`, unchanged), database `0000`–`0005` |
| Migrations | none added; the release still applies `0006`–`0007` over production — no `0008` |
| Dependencies | `next` and `eslint-config-next` 15.5.25 → 16.3.8, and what npm moved with them (§1.4); nothing else |

Batch 26 left React #418 `PRODUCTION BLOCKED`: the React that Next.js 15.5.25
vendors replays a host element that suspended during hydration without moving
the hydration cursor back, and a long streamed list then claims its own first
item and fails (§2). The fix is in React, and the only supported way to get a
different vendored React is a different Next.js. This batch picks that
release, makes the smallest change the upgrade requires, and measures #418 on
it under the classes Batch 26 measured it under — §1 the release, §2 the
baseline, §3 the change, §4 the matrix, §5 Server Actions and transitions,
§6 regression, §7 the build and deployment artifact, §8 dependencies and
`npm audit`, §9 the schema, §10 the gate, §11 what is not verified.

## 1. The release (brief §1)

### 1.1 Before

At `edcb4f4` (`package-lock.json`):

| Package | Version |
|---|---|
| `next` | 15.5.25 — vendors `react` / `react-dom` `19.2.0-canary-0bdb9206-20250818`, the copy that renders and hydrates every App Router page |
| `react`, `react-dom`, `@types/react`, `@types/react-dom` | 19.3.0 (installed; the App Router does not run this copy) |
| `eslint-config-next`, `@next/eslint-plugin-next` | 15.5.25 |
| `eslint-plugin-react-hooks` | 5.2.0 |
| `eslint` · `typescript` | 9.39.5 · 5.9.3 |
| `sharp` · `drizzle-orm` · `postgres` · `zod` · `motion` | 0.35.5 · 0.45.2 · 3.4.9 · 4.6.2 · 12.43.0 |
| `tailwindcss` / `@tailwindcss/postcss` · `drizzle-kit` · `tsx` · `playwright` | 4.3.3 · 0.31.10 · 4.23.13 · 1.63.0 |
| Node.js (CI, production) | 22; `engines.node` `>=20.9.0` |

### 1.2 Which releases carry the fix

Read from each published tarball (`npm pack next@<v>`), the vendored
`react-dom/cjs/react-dom-client.production.js`, and whether
`replaySuspendedUnitOfWork` resets the cursor for a host element
(`popToNextHostParent(fiber); … nextHydratableInstance = fiber.stateNode`):

| `next` | Vendored `react-dom` | Cursor reset in the replay |
|---|---|---|
| 15.5.25 (this repository at `edcb4f4`) | `19.2.0-canary-0bdb9206-20250818` | **no** |
| 15.5.27 (newest 15.x) | `19.2.0-canary-0bdb9206-20250818` | **no** |
| 16.0.11 | `19.3.0-canary-52684925-20251110` | no |
| 16.1.7 | `19.3.0-canary-f93b9fd4-20251217` | no |
| 16.2.12 | `19.3.0-canary-3f0b9e61-20260317` | yes |
| **16.3.8** | `19.3.0-canary-cbb046ab-20260731` | **yes** |
| 16.4.0 | `19.3.0-canary-278794d7-20261002` | yes |

Staying on 15.x cannot fix #418: its newest release vendors the same canary.

### 1.3 The choice: 16.3.8

- **It carries the fix** (§1.2), and it is what the build actually runs: the
  installed `next/dist/compiled/react-dom` is `19.3.0-canary-cbb046ab-20260731`
  with the reset in `replaySuspendedUnitOfWork`, case 5.
- **It is the supported, patched line.** 16.x is Active LTS and 15.x
  Maintenance LTS, two years from 15.0's release on 21 October 2024
  ([support policy](https://nextjs.org/support-policy)). The September 2026
  security release (30 September) shipped **16.3.8** for Active LTS and 15.5.27
  for Maintenance LTS — one High, five Medium and one Low
  ([release](https://nextjs.org/blog/september-2026-security-release)); the
  22 September out-of-band release had shipped 16.3.6 / 15.5.26
  ([update](https://nextjs.org/blog/nextjs-security-update-september-22-2026)).
  15.5.25, today's version, has neither.
- **It is the most settled 16.x line** — eight patches — where 16.4.0
  (6 October 2026, [release](https://nextjs.org/blog/next-16-4)) is a
  week-old minor that pushes Cache Components towards being the default and
  changes how Turbopack compiles and caches. Taking it would add a second set
  of changes to qualify without adding anything #418 needs.
- **What it does not settle.** Next.js has announced an out-of-band security
  update for **14 October 2026** — two Critical and one High, in upstream
  dependencies ([announcement](https://nextjs.org/blog/upcoming-nextjs-security-update-october-2026)).
  It was not published when this batch ran. Whatever 16.3.x patch it brings
  must be taken and qualified again before a deployment; this record does not
  qualify it.

`16.2.12` also carries the fix, but is the older line and has no September
security fixes.

### 1.4 What npm moved with it

`npm install --ignore-scripts next@16.3.8 eslint-config-next@16.3.8`, nothing
else; `package.json` keeps the repository's caret ranges (`^16.3.8`). The lock
changed by 27 versions, 37 additions and 1 removal:

- **Production** (`next`'s own tree): `next`, `@next/env` and the nine
  `@next/swc-*` binaries 15.5.25 → 16.3.8; `@swc/helpers` 0.5.15 → 0.5.23;
  Next's nested `postcss` 8.4.31 → 8.5.23; `caniuse-lite` 1.0.30001810 →
  1.0.30001816; added `baseline-browser-mapping` 2.11.28 (Next 16 derives its
  browser targets from it).
- **Development only** (`eslint-config-next`'s tree): `@next/eslint-plugin-next`
  15.5.25 → 16.3.8; `eslint-plugin-react-hooks` 5.2.0 → 7.1.1; the
  `@typescript-eslint/*` family 8.70.0 → 8.71.2, deduplicated against the new
  `typescript-eslint` 8.71.2 that eslint-config-next 16 depends on; added the
  Babel parser chain and `hermes-parser` that react-hooks 7 needs, `browserslist`
  and its data, `zod-validation-error`, a nested `globals`; removed
  `@rushstack/eslint-patch`, which flat config no longer needs.

`react`, `react-dom` and their types were already 19.3.0 and did not move.
`sharp`, `drizzle-orm`, `postgres`, `zod`, `motion`, Tailwind, `drizzle-kit`,
`tsx`, `typescript`, `eslint` and `playwright` did not move. No `npm audit fix`
was run.

### 1.5 What Next.js 16 changes, and what applies here

From Next's own upgrade guide, shipped in the package
(`next/dist/docs/01-app/02-guides/upgrading/version-16.md`), checked against
this codebase:

| Change in Next 16 | Here |
|---|---|
| Node.js ≥ 20.9, TypeScript ≥ 5.1 | Node 22 in CI and production, `engines.node` already `>=20.9.0`; TypeScript 5.9.3 |
| Browsers: Chrome/Edge/Firefox 111+, Safari 16.4+ (15.x compiled for Chrome 64, Edge 79, Firefox 67, Opera 51, Safari 12) | **Applies to visitors** — no `browserslist` override here; see §11 |
| Turbopack is the default for `next build`; a custom `webpack` config fails the build | No `webpack` key — builds with Turbopack. The standalone output changed shape (§7) |
| Sync access to `params`, `searchParams`, `cookies()`, `headers()` removed | Already awaited everywhere — `tsc` passes against Next 16's types |
| `revalidateTag(tag)` needs a second argument | **Changed** — `src/lib/cache.ts`, §3 |
| `middleware` renamed `proxy`; `proxy` runs on Node.js only | Kept as `middleware` — deprecated, not removed; the build warns. Renaming would also change the runtime it runs on (§3) |
| `next lint` removed, `eslint` key in `next.config` removed, `next build` no longer lints | **Changed** — the key is gone; linting was already `eslint .` (`npm run lint`), run by CI and `deploy.sh` |
| `@next/eslint-plugin-next` defaults to flat config | **Changed** — `eslint.config.mjs`, §3 |
| `scroll-behavior: smooth` no longer overridden during navigation unless `<html data-scroll-behavior="smooth">` | **Changed** — `globals.css` sets it; both root layouts, §3 |
| `next/image` defaults (qualities, `localPatterns` search, cache TTL, local IP, redirects) | No `next/image` anywhere; `images.unoptimized` stays |
| Parallel routes need `default.js` | No parallel routes |
| `experimental.serverActions.bodySizeLimit` | Still accepted (the build lists `serverActions` under experiments) |
| AMP, runtime config, `devIndicators` options, `unstable_rootParams`, `dynamicIO` removed | None used |
| `next build` no longer prints sizes or First Load JS | Nothing reads them |
| An app without `global-error.tsx` gets a prerendered `/_global-error` | **Test changed** — `build-isolation`, §3 |
| RSC requests must carry `_rsc`, a digest of the router's headers (cache-poisoning hardening); a mismatch is a 307 | **Tests changed** — the router sends it; two tests built the request by hand, §3, §6 |
| A same-origin redirect from middleware is written as a path (`/about`), not a URL | **Test changed** — `seo-metadata`, §3, §6 |
| 16.3: `experimental.optimisticRouting` on by default | **Changed** — off; with this site's routes it prefetched an Arabic page's English twin without end, §3.3 |
| Not in the guide: on the Node server, app pages render through Node streams (`__NEXT_USE_NODE_STREAMS`) | A visitor leaving a page mid-stream is now logged as an error line; nothing else changes, §4.4 |

## 2. The #418 baseline, kept (brief §2)

Batch 26's figures stand as recorded and are not re-read here
(`release-hardening-batch-26.md` §5): on its release candidate with Next.js
15.5.25, **2 in 722** canvas documents in the moderate class (the second
editor's redraw of `/services`), **7 in 120** signed-out public visits on the
slow profile (4, 2 and 1 in three runs of 40), **3 in 60** under synthetic
load, and **0** in 302 documents on loopback or broadband with nothing else
running and 0 in 120 on the mobile profile. No save was lost, nothing was
written that nobody asked for, no Server Action failed. The `b807663` baseline
build in that record is a scratch reconstruction of history (1 in 80 on the
slow profile), not a measurement of production, and production (`902a0e6`)
was never measured.

**Positive control, on this machine, for this batch.** Before anything was
changed, `edcb4f4` — Next.js 15.5.25, the same vendored React — was built cold
in a scratch worktree and given the visits that reproduce it best: signed-out
public visits on the slow profile, three runs of 40, nothing else running.

| Build | Network | Visits | #418 | Where (React's component stack) |
|---|---|---|---|---|
| `edcb4f4` (15.5.25) | slow | 120 | **7** (2, 2, 3) | `/services/travel-tourism` ×3, `/services/government-relations` ×2 — `ul ← div ← p ← div ← div ← div ← section`, the Batch 25 signature; `/ar/services/license-renewal` — the footer's `ul ← div ← footer ← body ← html`; `/` — `ul ← div ← section ← div` |

The same 7 in 120 as Batch 26, with the same stacks. So the harness, this
machine and this browser reproduce the defect on the release that has it — the
condition for reading a zero on the candidate as a result rather than as a
blind instrument.

## 3. The change (brief §3)

Every change, and why it is the smallest one that works. Nothing in React or
Next.js was patched; nothing under `node_modules` was edited.

### 3.1 The application

| File | Change | Why |
|---|---|---|
| `package.json`, `package-lock.json` | `next`, `eslint-config-next` `^15.5.0` → `^16.3.8` | The release (§1). `eslint-config-next` is versioned with `next` and is what makes `npm run lint` read Next 16's rules |
| `next.config.ts` | the `eslint: { dirs: ["src", "scripts"] }` key removed | Next 16 removed the option — it is a type error in `NextConfig` — and `next build` no longer lints. Linting was already `npm run lint` (`eslint .`, every directory but the ignored ones), which CI's static job and `deploy.sh` step 4 both run |
| `src/lib/cache.ts` | `revalidateTag(tag)` → `revalidateTag(tag, { expire: 0 })` | Next 16 requires the second argument. Its reference says the one-argument form "behaves like `{ expire: 0 }`", and the code agrees: both take the same branch in `revalidate()` (the Server Action reports the revalidation to the router either way), and the file-system cache marks the tag expired *now* for both. `"max"`, the profile the guide suggests, is stale-while-revalidate: the first visitor after Publish would be served the page from before it. `updateTag` is the immediate form only inside a Server Action and throws elsewhere |
| `src/app/(public)/[lang]/layout.tsx`, `src/app/(backoffice)/admin/layout.tsx` | `data-scroll-behavior="smooth"` on `<html>` | `globals.css` sets `html { scroll-behavior: smooth }` for in-page anchors. Up to 15.x Next switched it to `auto` while it scrolled a new page into place; 16 does so only when this attribute says smooth scrolling is on. Without it every client-side navigation would glide to its scroll position. A static attribute, the same on server and client |
| `tsconfig.json` | `"jsx": "react-jsx"`; `.next/dev/types/**/*.ts` added to `include` | The two values `next build` 16 writes into the file itself (the automatic runtime is mandatory; dev types moved under `.next/dev`). Committed so a build does not rewrite a tracked file; `tsc --noEmit` passes either way |
| `eslint.config.mjs` | Next's own flat configs (`eslint-config-next/core-web-vitals`, `/typescript`) in place of `FlatCompat`; the repository's two rules kept; three new React Compiler rules at `warn` | eslint-config-next 16 ships flat configs, and the old `FlatCompat` translation crashes on them. Its `eslint-plugin-react-hooks` 7 brings Compiler-readiness rules that flag 38 places in tested code — state set from an effect (24), a ref read while rendering (11, all but one in the editor shell), a clock read outside the markup (3: a ref's initial value, a submit handler, a server component's query cutoff — none reaches rendered markup, so none is a hydration risk). Rewriting the editor's state handling is out of scope for a framework upgrade; the rules report and the work is left for its own batch. `rules-of-hooks` and `exhaustive-deps` are as before |
| `next.config.ts` | `experimental.optimisticRouting: false` (second commit) | Next 16.3 turned optimistic routing on by default, and with these routes it never stops prefetching the English twin of an Arabic page — §3.3. Off is how 16.2 routed |
| `src/middleware.ts` | **not changed** | `middleware` is deprecated in 16, not removed; the build warns. The rename to `proxy` would also move it from the edge runtime to Node.js, which the guide says to avoid if the edge runtime is wanted — a behaviour change this batch does not need |

`npm run lint`: 0 errors, 40 warnings — the 38 above and two from a rule new in
`@next/eslint-plugin-next` 16, `no-location-assign-relative-destination`, on
the two `window.location.assign` calls in the Components screens (a full page
load after a delete; left as they are). At `edcb4f4`: 0 problems.

### 3.2 The tests

No assertion was removed or loosened, and no test was skipped. Where Next 16
changed the shape of something a test reads, the test reads the new shape;
where it changed what the server answers, the test asks the way the browser
asks.

| File | Change | Why |
|---|---|---|
| `tests/build-isolation.test.ts` | the sandbox's `node_modules` is a tree of hard links (`cp -al`, a copy as fallback) instead of a symlink | Turbopack refuses to build a project whose `node_modules` is a symlink out of it ("Symlink [project]/node_modules is invalid, it points out of the filesystem root"); every assertion after it then failed on the missing build |
| same | prerendered routes `["/_global-error", "/_not-found", "/robots.txt"]` | Next 16 prerenders its own `/_global-error` for an app without `global-error.tsx` — it renders nothing of ours and reads no database. The assertion is still exact: any other prerendered route fails it |
| `tests/helpers/action.ts` | `builtActions()`: the manifest read once, every file named from `src/` | Turbopack names an action's file from the project root (`src/app/…/actions.ts`), webpack from `src/` (`app/…`). Callers name files the second way; the lookup fails loudly on an unknown name as before |
| `tests/mutation-audit.test.ts`, `tests/seo-admin.test.ts` | read the manifest through `builtActions()` | The same file naming; both assertions unchanged (exact lists of a file's exported actions) |
| `tests/helpers/rsc.ts` (new), `tests/package-editor.test.ts`, `tests/helpers/activity.ts` | RSC requests carry `Next-Url` and `_rsc` | Next 16 answers an RSC request only at the address carrying `_rsc`, a digest of the router's own headers, and answers anything else with a 307 before rendering (cache-poisoning hardening, `base-server.js`). The router always sends it; these two built the request by hand. A bare `RSC: 1` digests to empty, the empty `_rsc` does not survive the middleware's rewrite to `/en/…`, and the request is redirected for ever — so the helper sends `Next-Url` as the router does (`/en`, the internal address of Home) and sets `_rsc` with Next's own `setCacheBustingSearchParam`. The server answers with the whole page, the payload these requests got before. In `activity.ts` (the stress suite's concurrent lanes) this is what keeps two in three of its "server-component navigations" rendering at all: answered by the 307 they would have passed while exercising nothing |
| `tests/seo-metadata.test.ts` | the `/en/about` redirect's `Location` is read against the requested origin | Next 16's middleware adapter writes a same-origin redirect as a path (`getRelativeURL`); 15 wrote the whole URL. The asserted pathname is unchanged |
| `tests/dependency-advisories.test.ts` | the `source-map-js` test asserts that the server neither ships nor names the package | It used to require that something in the server still required it, and said, if nothing did, "has the advisory gone? Then this test and the note go too". The Next 16 server carries neither `source-map-js` nor Next's nested `postcss`; the advisory stays in `npm audit` for the build's own copies (§8). The new test reads every file in the standalone runtime — Turbopack bundles packages into chunks, so it looks for the name, not a `require` — and checks it read more than 500 |
| `tests/browser/probes/navigation-scroll.probe.mts` (new), `probes/expected.json`, `tests/browser-suite.test.ts` | a probe for the scroll attribute (N1–N3, port 3740); the suite's pinned probe count 38 → 39 | Regression coverage for `data-scroll-behavior` (§3.1): both layouts carry it, a link followed from the foot of a long page opens the next one at its top without gliding, and the stylesheet's smooth scrolling is back afterwards. Shown to fail with the attribute removed (§6.2) |
| `tests/browser/probes/prefetch-bounded.probe.mts` (new, second commit), `probes/expected.json`, `tests/browser-suite.test.ts` | a probe for the prefetch loop (B1–B2, port 3741); the pinned probe count 39 → 40 | Regression coverage for §3.3: on the four Arabic pages and their English twins, no address is asked for more than 8 times in the 6 s after the page loads. On `43216ec`'s build B1 failed at 580–780 requests to one address; with the flag off it passes at 2 |
| `tests/browser/probes/motion-15b.probe.mts` (third commit) | when the Visual Editor does not reach "Ready" within 60 s, the probe's error says what the editor's status line showed, which frame the canvas was, whether its document had loaded and how many nodes carry the editor's addresses | The one CI failure on `c53e09b` (§6.3) was this wait timing out, and a bare timeout cannot say which of three things failed; it did not happen again here, so the next one has to explain itself. The wait, its 60 s and every check are unchanged; with the canvas blocked on purpose the probe stops at the same check as on CI and prints the line (§6.3) |
| `tests/stress/admin-form-settle.stress.mts`, `tests/stress/expected.json` | F7–F10: a category and a service, created and deleted on their screens from cold, untouched, like F5–F6's package; 6 → 10 checks | The brief names category and service create/delete. No browser test drove the Categories screen's create and delete; the Services screen's were driven once per `route-services` run. F5–F6 are unchanged in what they assert |
| `tests/README.md`, `tests/browser/README.md`, `tests/stress/README.md` | the harness changes, the new probe and the new checks described; probe totals 1,544 / 38 → 1,549 / 40 | — |

### 3.3 What the first matrix run found: a prefetch that never ends

The matrix's first runs on the upgrade (`43216ec`) were clean of #418, but a
signed-out visit to `/ar/packages` took 20.4–20.6 s every time — on loopback,
on broadband and on the slow profile alike — where 15.5.25 took 1.6 s on the
slow one: 20 s is the cap the matrix puts on waiting for the network to go
quiet, and on that page it never did. Recorded request by request, the router
was prefetching `/packages` — the language switch's English twin — about a
hundred times a second for as long as the page stayed open: 1,645 requests in
15 s, each one started, mostly cancelled by the router itself, and started
again, each one a render on the server.

| Page (6–8 s after load, `43216ec`) | RSC requests | To the English twin |
|---|---|---|
| `/ar/about` | 599–893 | 580–883 × `/about` |
| `/ar/services` | 627–963 | 585–921 × `/services` |
| `/ar/packages` | 712–960 | 691–939 × `/packages` |
| `/ar/search` | 801–1,052 | 780–1,031 × `/search` |
| `/ar`, `/ar/services/travel-tourism`, `/ar/packages/egypt` | 19–23 | 1 |
| `/about`, `/services`, `/packages`, `/search` | 13–66 | — |
| the same pages on 15.5.25 | 6–33 | 1 |

It failed to show in one recording and showed in every other. The cause
is Next's own: 16.3.0 made `experimental.optimisticRouting` the default, and
its route trie livelocks for some route shapes — here `[lang]` beside the
`[...slug]` catch-all, with every English address rewritten onto `/en/…` —
the class of bug in [vercel/next.js#97135](https://github.com/vercel/next.js/issues/97135).
Two experiments on scratch copies settled the fix: the same commit with
`optimisticRouting: false` made 13–66 requests on every page, nothing
repeated; and the same commit on **16.4.0**, flag untouched, did not loop
either (11–44) — upstream has fixed it on the 16.4 line, not on 16.3.8.

`optimisticRouting: false` is one line, keeps the release chosen in §1, and
is how 16.2 routed, so it is the smallest correct change; moving to 16.4.0
for this alone would bring a new minor's changes with it. When the 16.3 line
is next patched (§11), or the site moves to 16.4, the flag can be revisited —
with `prefetch-bounded` (§3.2) to say whether it is still needed. The fix is
its own commit, `c53e09b`, so the record shows the defect and its correction
separately; everything below §4 was measured on it.

## 4. React #418, qualified (brief §4)

### 4.1 Method

The instrument is Batch 26's: `tests/browser/matrix/hydration.matrix.mts`,
unchanged, counting every canvas or page document the browser loads and every
error React recovers from in it, with React's own component stack (the
DevTools-hook stand-in in `evidence.ts` wraps the root's
`onRecoverableError`). **A recovered error counts.** For every run it also
records whether Layers still selects after every load, whether anything was
stored that nobody asked for, whether a save was lost, Server Action failures,
5xx answers, failure lines in the server's output and whether the server
stayed up.

Every run in §4.3 is on `c53e09b` (§10), its own cold production build, one
run at a time with nothing else on the machine (4 CPUs, Chromium 141
headless), against a fresh copy of the test catalogue.

**The instrument still sees on Next 16.** Two controls, both scratch, neither
committed:

- *Positive control, the defect itself* — §2: the same harness on `edcb4f4`
  (15.5.25) finds 7 in 120 slow-network visits.
- *Instrument control, a mismatch on purpose* — a scratch copy of the
  candidate with one extra page, `/eod-mismatch`: `section > ul > li > p`
  where the `<p>`'s text is "drawn on the server" on the server and "drawn in
  the browser" in the browser. Built and served exactly as the candidate.
  The capture must report a #418 there every time, and nothing on an ordinary
  page — otherwise a zero below would mean nothing.

The classes are the brief's: **A** normal (nothing else running), **B** heavy
(synthetic: four busy loops, the server at the lowest CPU priority),
**C** moderate (a second editor saving and redrawing another route, three
visitors reading public pages, the whole time — B26's moderate class), **D**
signed-out public visits (in every class: the `visits` rows), **E** the slow
network profile (150 ms, 1.6 Mbit/s — where 15.5.25 reproduces it most), **F**
normal and mobile networks (loopback, broadband 40 ms / 20 Mbit/s, mobile
80 ms / 5 Mbit/s). Routes: the editor's loads rotate through every kind of
route it opens (service categories, a service, a package, a destination, the
two overviews, Home, About); the visits rotate through every published
service category, `/services`, `/packages` and Home, one in four in the
Arabic edition — the services lists and the footer list where 15.5.25 fails.

### 4.2 The controls

| Control | Build | Visits | #418 reported | Notes |
|---|---|---|---|---|
| Positive — the defect (§2) | `edcb4f4`, Next 15.5.25 | 120, slow | **7** | Batch 26's figure, Batch 26's stacks |
| Positive — under the synthetic heavy load | `edcb4f4`, Next 15.5.25 | 12, loopback | **3** | the same 12 visits the candidate's heavy rows make (§4.4) |
| Instrument — a mismatch on purpose | scratch copy of `43216ec` + `/eod-mismatch` | 10 | **10 of 10** | React's stack `p ← li ← ul ← section`; the page then shows "drawn in the browser" — React re-rendered it on the client, as it does after a #418; 10 page errors carrying the same message |
| Instrument — an ordinary page | the same build, `/about` | 10 | **0 of 10** | — |
| Instrument — a mismatch on purpose, again | scratch copy of `c53e09b` + `/eod-mismatch` | 10 | **10 of 10** | the same stack, the same text, 10 page errors |
| Instrument — an ordinary page, again | the same build, `/about` | 10 | **0 of 10** | — |

So on Next 16.3.8 the capture still reports a hydration mismatch, with its
component stack, every time one happens, and reports nothing where none does.

### 4.3 The matrix on the candidate

34 runs on `c53e09b`, its own cold production build, 21:20–22:51 UTC on
13 October, one at a time, the working tree clean in every one (`dirty=0`
recorded per run), Next 16.3.8 reported by every run.

| Class | Mode | Network | Runs | Attempts | #418 | Selection after load | Unasked writes | Saves lost | Action failures | Page errors | 5xx | Server |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| A normal | editor loads | loopback | 1 | 40 | **0** | 40/40 | 0 | — | 0 | 0 | 0 | up, no restart |
| A normal | editor loads | broadband | 1 | 40 | **0** | 40/40 | 0 | — | 0 | 0 | 0 | up |
| A normal | editor redraws (40 saves) | loopback | 1 | 81 | **0** | — | 0 | 0 of 40 | 0 | 0 | 0 | up |
| A normal | editor redraws (30 saves) | broadband | 1 | 61 | **0** | — | 0 | 0 of 30 | 0 | 0 | 0 | up |
| A / D normal | public visits | loopback | 1 | 40 | **0** | — | 0 | — | — | 0 | 0 | up |
| A / D normal | public visits | broadband | 1 | 40 | **0** | — | 0 | — | — | 0 | 0 | up |
| E / D slow | public visits | slow | 10 | 400 | **0** | — | 0 | — | — | 0 | 0 | up |
| E slow | editor loads | slow | 1 | 30 | **0** | 30/30 | 0 | — | 0 | 0 | 0 | up |
| E slow | editor redraws (30 saves) | slow | 1 | 61 | **0** | — | 0 | 0 of 30 | 0 | 0 | 0 | up |
| F / D mobile | public visits | mobile | 2 | 80 | **0** | — | 0 | — | — | 0 | 0 | up |
| F mobile | editor loads | mobile | 1 | 40 | **0** | 40/40 | 0 | — | 0 | 0 | 0 | up |
| C moderate | editor loads + 2nd editor + 3 visitors | loopback | 2 | 212 | **0** | 80/80 | — | 0 of 65 | 0 | 0 | 0 | up |
| C moderate | same | broadband | 1 | 107 | **0** | 40/40 | — | 0 of 33 | 0 | 0 | 0 | up |
| C moderate | same | slow | 1 | 109 | **0** | 40/40 | — | 0 of 34 | 0 | 0 | 0 | up |
| C moderate | editor redraws + 2nd editor + 3 visitors | loopback (2nd run: other routes) | 2 | 322 | **0** | — | — | 0 of 159 | 0 | 0 | 0 | up |
| C moderate | same | broadband | 1 | 158 | **0** | — | — | 0 of 78 | 0 | 0 | 0 | up |
| C / D moderate | public visits + 2nd editor | broadband | 1 | 85 | **0** | — | — | 0 of 22 | 0 | 0 | 0 | up |
| C / D moderate | same | slow | 1 | 117 | **0** | — | — | 0 of 38 | 0 | 0 | 0 | up |
| B heavy (synthetic) | editor loads | loopback | 1 | 30 | **0** | 30/30 | 0 | — | 0 | 0 | 0 | up |
| B / D heavy (synthetic) | public visits | loopback | 2 | 80 | **0** | — | 0 | — | — | 0 | 0 | up |
| B / D heavy (synthetic) | public visits | slow | 1 | 40 | **0** | — | 0 | — | — | 0 | 0 | up |

Raw totals, every recovered error counted:

| | Candidate (`c53e09b`, 16.3.8) | Batch 26's record (15.5.25) — the baseline §2 keeps |
|---|---|---|
| A — normal, loopback and broadband | **0 in 302** | 0 in 302 |
| E — slow network | **0 in 491** (0 in 400 public visits, 0 in 91 editor documents) | **7 in 120** public visits, 0 in 91 editor documents |
| F — mobile network | **0 in 120** | 0 in 120 |
| C — moderate | **0 in 1,110** | **2 in 722** |
| B — heavy (synthetic) | **0 in 150** | **3 in 60** |
| D — signed-out public visit documents, all classes | **0 in 760** (480 of them on the slow profile) | 7 in 120 on the slow profile; 2 in 30 under the heavy load |
| **All** | **0 in 2,173** | **12 in 1,415** |

The normal, moderate and slow matrices the brief names are at zero, with
every recovered error counted. For scale: at 15.5.25's own rate on the slow
profile (7 in 120), a run of 400 slow visits without one has a probability
of about 4 × 10⁻¹¹; at its heavy-load rate (3 in 60), 150 without one, about
5 × 10⁻⁴; at its moderate rate (2 in 722), 1,110 without one, about 5%. The
matrix confirms; the reason it holds is §1.2 — the vendored React the
candidate runs resets the hydration cursor that 15.5.25's leaves inside the
replayed element.

### 4.4 What else the runs recorded

- **Selection, writes, saves.** Layers selected the first node after every
  one of the 340 editor loads; no run stored anything nobody asked for; the
  last value typed was the value stored in every redraw run (0 lost of 529
  saves, both editors). No Server Action failed and no page error was
  recorded, in either editor or any visitor; no answer was a 5xx; the server
  stayed up and was never restarted.
- **Under the synthetic heavy load** a public visit took 4–33 s to load and
  go quiet (1.1–1.5 s with nothing else running): four busy loops on four
  CPUs with the server at the lowest priority is the class's design. The
  same 12 visits on the 15.5.25 build under the same load took 3.9–23.7 s
  (median 10.2 s against the candidate's 17.5 s) and met **3** #418s; why
  the candidate is slower there is §6.1.
- **One new server log line: `⨯ Error: The destination stream closed
  early.`** In 8 of the 34 runs — every one of them on the slow or mobile
  profile, under the synthetic load, or the moderate class on the slow
  profile — the server logged it, with a digest and no stack of ours; it was
  the only failure line in any run (the summary keeps the first ten lines of
  each). It is a visitor leaving a page that is still arriving, which Next 16
  now logs:
  - *Measured.* The matrix's slow profile in Chromium, the same 21 pages each
    left 400 ms after it starts arriving: **0** lines on 15.5.25, **36** on
    16.3.8 and no other error; the same pages read to the end: 0 on both.
    Abandoning a request on loopback produced nothing on either — the whole
    page is in the socket's buffers before the client hangs up — which is why
    the loopback and broadband runs never show it.
  - *Why.* Next 16 renders app pages through Node streams on the Node server
    (`__NEXT_USE_NODE_STREAMS`, set `true` for every non-edge build in
    `next/dist/build/define-env.js`); 15.5.25 has no such path. When the
    connection closes first, React's Node renderer aborts with
    `Error("The destination stream closed early.")`, and Next's
    `isAbortError` recognises only the names `AbortError` and
    `ResponseAborted`, so the render error handler logs it like any other
    error. The page had already been abandoned; nothing reached a visitor,
    and the server kept serving.
  - *What it means.* In production every visitor who closes a tab or
    follows a link while a page is still streaming — commonest on slow
    connections — adds one such line, with a digest, to the service's log.
    A digest from that message is noise; any other digest is still a real
    error. Recorded in §11; nothing was changed for it.

## 5. Server Actions and transitions (brief §5)

What the brief names, and what holds it — each run in full on the final commit
(§10), and the ones that carry a redirect or a pending state run again,
repeatedly, on the candidate (§5.2):

| Behaviour | Held by |
|---|---|
| A package created lands on its own screen; one deleted lands on the list, gone | stress `admin-form-settle` F5–F6 (36 creates and 36 deletes a run, three servers each restarted cold before every action, nothing touched while waiting); probe `route-packages`; stress `package-concurrency` P10 |
| A service created and deleted | stress `admin-form-settle` **F9–F10, new in this batch**, the same way; probe `route-services` (made, edited, published and deleted through the screens) |
| A category created and deleted | stress `admin-form-settle` **F7–F8, new in this batch** — no browser test drove the Categories screen's create and delete before; npm test `seo-admin` (the actions themselves) |
| A service moved between categories | probe `route-services` (the Services screen's Category moves it, the editor reopens it at the new address with its draft); stress `service-concurrency` S5 (a move racing a publication), `service-form-concurrency` F4 (a move against stale forms) |
| Direct editing on the canvas | probes `layers-editing` (on-canvas text editing), `route-categories` (a direct edit taken back with Undo), `inspector-focus`, `autosave`; npm test `direct-edit-readiness`, `visual-content` |
| Visual Editor publication | probe `publish`; stress `route-concurrency` R2–R5, `package-concurrency` P2, `service-concurrency` S2 |
| The pending state settles — no permanent "Saving…" | stress `admin-form-settle` F1–F2 (accounts and questions, 72 saves a run); `service-form-concurrency` F7 (every racing write answered within 15 s) |
| Navigation after an action | stress `create-navigation` N1–N5 (a create lands on its component's page because the browser loads it; a delete returns to the list); the client-navigation walk (§6) |
| No redirect dropped, no save lost, no mutation duplicated | `admin-form-settle` F3 (every one stored exactly once), `create-navigation` N4 (nothing created twice), the matrix's lost-save and unasked-write columns (§4) |
| No new digest or page error | every probe and stress script prints page errors and failed Server Actions as `diag` lines; the runner and the matrix count them. The one new digest in the server's log is a client leaving a page mid-stream — measured and explained in §4.4 |

### 5.1 The suspended transition, with the workaround taken away

Since 19C every admin form goes through `useSettledActionState`
(`components/admin/form.tsx`), which nudges React when an answer has arrived
but not reached the screen: the React that Next 15.5 vendors could drop the
ping that wakes a suspended transition, leaving "Saving…" up for good with
the work already stored — one transition lane pending, suspended and
entangled, nothing scheduled. The brief asks for no unexplained suspended
lane, so the question is whether that defect is still there under Next 16.

Scratch copies only — the nudge is not removed from the branch: the one
constant that bounds it, `NUDGE_FOR_MS`, set to `0`, and the whole of
`admin-form-settle` run (three servers, each restarted cold before every
action, nothing touched while waiting; F1–F10, 288 actions a run):

| Build, nudge off | Runs | Answers that never reached the screen | Rows stored |
|---|---|---|---|
| `edcb4f4`, Next 15.5.25 | 1 | **21 of 288** — 3 account creations (F1 33/36), 12 question saves (F2 24/36), 4 package creates' redirects (F5 32/36), 2 category creates' redirects (F7 34/36) | every one, exactly once (F3) |
| `43216ec`, Next 16.3.8 | 2 | **0 of 576** | every one, exactly once |
| `c53e09b`, Next 16.3.8, optimistic routing off | 2 | **0 of 576** | every one, exactly once |

The stall the workaround exists for reproduces on 15.5.25 under exactly these
conditions and not once on 16.3.8, so the suspended lane is explained — the
19B defect in the old vendored React — and does not appear with the new one.
The workaround stays: it is tested, it costs nothing when an answer commits on
its own (it never nudges then), and removing it is a change of its own, not
part of a framework qualification.

### 5.2 Repeated, on the branch as committed

With the nudge in place, on `43216ec`: `admin-form-settle` 10/10 — 288
actions a run, every one settled from cold, untouched, F7–F10 included; the
`navigation-scroll` probe 3 runs of 3, clean; `route-services` 3 runs of 3,
clean (111 checks each); and CI's Browser QA (run 38461224029), 39 of 39
probes clean, 1,547 checks.

Again on `c53e09b`, because turning optimistic routing off changes how the
router handles every navigation, and an action's redirect is one:
`admin-form-settle` **3/3** (864 actions, each from cold, untouched), and
with the nudge taken away **0 of 576** stalled (the table above). The
suites in full on the final commit: §10.

## 6. Regression (brief §6)

Every Batch 26 behaviour is held by the same suites, run in full on the final
commit (§10): the tracked `npm test`, the browser probes and the stress
scripts. No assertion was weakened (§3.2): across the tracked tests the
`assert` calls went from 8,795 to 8,797 — the two places a test changed its
shape — and the probes' `say` checks from 1,346 to 1,350, the two new probes
(38 probes and 1,544 expected passes at `edcb4f4`, 40 and 1,549 now); no test
is skipped, at `edcb4f4` or now. Beyond the suites, three checks of what a
suite would not notice:

- **Client-side navigation through the middleware.** A scratch Playwright
  walk (signed out; Home → Services → a category → a service → Packages → a
  package → back → About → the Arabic About → Arabic Services → Arabic Home)
  recorded every RSC request the router made. On `c53e09b`, three rounds:
  every step reached its page, 110 RSC requests (103 prefetches, 7
  navigations — the rest were served from prefetches) all answered 200 at the
  address the router chose (`?_rsc=…`), none redirected, no console error, no
  recovered error. Next 16's `_rsc` check and the middleware's internal
  rewrite to `/en/…` agree for every request the router actually sends.
- **What a page looks like.** The same public pages and admin screens,
  screenshotted on the 15.5.25 baseline build and on the candidate, each on its
  own copy of the same catalogue, motion reduced (§6.1).
- **Lint.** 0 errors; the 40 warnings are the new rules (§3.1).

### 6.1 What a page looks like, and what a visit costs

**Pixels.** The 15.5.25 build of `edcb4f4` and the candidate, each serving
its own copy of the same catalogue, screenshotted full-page with motion
reduced at 1440 and 390 px: 14 public pages (Home, Services, a category, a
service, Packages, a destination, About, Contact, a search, Privacy, the
Arabic Home, Services and a destination, the sign-in screen) and 6 admin
screens (Dashboard, Services, Packages, Media, Pages, Settings) — 40 pairs.
**40 of 40 are identical** — the same size, no pixel apart by more than the
noise threshold. Two pairs differed on the first pass (Packages and Media at
1440 px), both by one lazily loaded illustration that had not decoded yet in
the 15.5.25 screenshot; shot again with every image awaited, both are
identical too.

**What a signed-out visit costs.** The matrix's visits took longer on the
candidate — on the slow profile a median 2.3 s to load and fall quiet against
1.7 s on 15.5.25, and under the synthetic heavy load 17.5 s against 10.2 s
(the same 12 visits on the 15.5.25 build, which met 3 #418s doing them). Six
pages, three times each, on the slow profile, measured apart (medians):

| | 15.5.25 | 16.3.8 |
|---|---|---|
| first byte | 32 ms | 28 ms |
| `DOMContentLoaded` | 777 ms | 784 ms |
| `load` | 2.71 s | 3.13 s |
| quiet (500 ms without a request) | 3.88 s | 4.78 s |
| requests until quiet, RSC among them | 40, 13 | 50, 27 |
| bytes until quiet | 522 KB | 599 KB |
| of which scripts | 187 KB (Home and About 226 KB) | 212 KB (Home and About 311 KB) |

The server renders as fast as before; what grew is the client. Next 16's
runtime is heavier (25–85 KB more script a page), and its segment cache
prefetches per segment, so a page's links cost about twice as many RSC
requests — each a small render on the server — after the page has loaded.
On the slow profile the `load` event comes 0.4 s later; what a visitor
sees first (first byte, `DOMContentLoaded`) does not move. Under CPU
starvation the extra prefetches are what make a visit slower. It is the
framework's own behaviour, not a regression in the site, and nothing was
changed for it; it is in §11 for the owner.

### 6.2 The changes are held: each one broken on purpose

Scratch copies of the upgrade commit (`43216ec`), each with one change taken
back, run against the tests that should notice — so a change that no test
would miss is not called covered:

| Change taken back | Tests run | Result |
|---|---|---|
| `data-scroll-behavior="smooth"` removed from both layouts | `navigation-scroll` | **N1 fails** (no attribute), **N2 fails**: from 4,114 px the next page glides — the top reached at its 43rd frame, 42 positions in between; N3 passes (the stylesheet is untouched) |
| `revalidateTag(tag, "max")` instead of `{ expire: 0 }` | `page-publish`, `route-editor`, `service-editor`, `package-editor`, `seo-admin`, `structure-actions` | **29 of 307 fail** — e.g. "the preview an editor approved is the page a visitor gets": *B is not live*, the visitor still served the page from before Publish. (`cache-refresh` alone passes: its button also calls `revalidatePath("/", "layout")`, which expires everything by itself) |
| `optimisticRouting` left at 16.3's default (the upgrade commit itself) | `prefetch-bounded` | **B1 fails**: 580–780 requests to one address in 6 s; B2 passes |

With each change in place, every one of them passes.

And the probe change of §6.3, the other way round — the canvas broken on
purpose in a scratch copy of the probe, just before it opens the editor on
Home, to see what the new message says:

| Broken on purpose | Probe | What it printed |
|---|---|---|
| the canvas document's request aborted | stops after 43 of 65 checks, as on CI | `the editor was not Ready within 60 s: it showed ["Unable to connect"]; canvas none among ["chrome-error://chromewebdata/"]` |
| the canvas's scripts aborted — the document loads, nothing runs | stops after 43 of 65 | `… it showed ["Unable to connect"]; canvas http://127.0.0.1:3717/?preview=1&editor=1&bridge=…&r=0: complete, 147 addressed nodes` |

### 6.3 One CI failure on `c53e09b`: `motion-15b` waited 60 s for "Ready"

CI run 38469728627 (`c53e09b`) passed every job but Browser QA, where 39 of
the 40 probes were clean and `motion-15b` stopped after 43 of its 65 checks:
the Visual Editor, opened on Home (check 24b, after checks 9 and 34 on
About), did not show "Ready" within 60 s — `locator.waitFor: Timeout
60000ms exceeded`. Nothing failed before it. The same probe was clean on CI
at `43216ec` (run 38461224029, 65 checks, 141 s), and the only difference
between the two commits is `optimisticRouting: false` and the new probe.

It did not happen again here:

| What | Where | Result |
|---|---|---|
| `motion-15b`, six times in a row, with a scratch diagnostic that would print the editor's state, the canvas frame and every request in flight at a timeout | `c53e09b`'s build | **6 of 6 clean**, 65 checks each, no timeout |
| The failing step alone — the editor on About, a heading selected on the canvas, then the editor on Home — timed to "Ready", 50 opens | same | **0 misses**; median 483 ms, slowest 1.0 s |
| The same, the browser's CPU slowed fourfold | same | **0 misses**; median 2.0 s, slowest 2.3 s |

What the step needs, read from the code: the canvas iframe loads, the
editor's handshake starts on its `load`, and the canvas's bridge answers the
editor's ping (every 500 ms; it re-announces on every ping, so an
announcement sent before the editor was listening is recovered). A 60-s miss
therefore needs the canvas document never to finish loading, its bridge
never to mount, or the editor to reject what the canvas says — and none of
those showed in the 100 timed opens or the six full runs. Nothing on the
server side can hold one render behind another: the application keeps no
in-process lock or shared in-flight promise.

What could not be compared: CI runs Playwright 1.63's own Chromium 153
(headless shell); this sandbox has only the preinstalled Chromium 141, and
installing another is outside what this environment allows. The run's log
artifact could not be fetched either — its storage host is outside this
sandbox's network policy — but it would not have said more: the runner
prints the end of the probe's output, which is the stack above, and the rest
of that file is the 43 PASS lines.

So the cause is **not established**. Two things follow from it:

- `motion-15b` now says what it saw. When "Ready" does not come in 60 s,
  the probe's error names what the editor's status line showed ("Loading
  canvas…", "Connecting…", "Unable to connect"), the canvas frame's address,
  whether its document had loaded, and how many nodes carry the editor's
  addresses — which the server writes only into an editor canvas, so a
  loaded canvas with its addresses and no "Ready" is a bridge that never
  answered. The three ways the step can fail, told apart in the one line the
  runner prints. No check, timeout or expectation changed; it was shown to
  print that line with the canvas blocked on purpose (§6.2).
- The final commit's full suite here and its CI — a second sample on CI's
  own browser — are the gate's (§10), and their results are in the batch's
  report.

## 7. The build and the deployment artifact (brief §7)

### 7.1 What Turbopack changed in `.next/standalone`

| | 15.5.25 (webpack) | 16.3.8 (Turbopack) |
|---|---|---|
| `server.js` at the root, `process.chdir(__dirname)`, `startServer` | yes | yes — unchanged in shape |
| `.next/` beside it: `BUILD_ID`, `required-server-files.json`, routes/prerender/build manifests, `server/` | yes; also `app-build-manifest.json`, `react-loadable-manifest.json` | yes; those two are gone (Turbopack has no use for them) |
| `.next/node_modules/` | — | **new**: `sharp-20c6a5da84e2135f → ../../node_modules/sharp`, a relative symlink — Turbopack's alias for an external package the server loads at run time |
| `node_modules/` | 20 packages (with `typescript`, `source-map*`, `caniuse-lite`, `nanoid`, `picocolors`, `buffer-from` — traced for `next.config.ts` and Next's `postcss`) | 12 packages — `@emnapi`, `@img`, `@next`, `@swc`, `client-only`, `detect-libc`, `next`, `react`, `react-dom`, `semver`, `sharp`, `styled-jsx`; the application's own dependencies are bundled into the server chunks |
| `src/` | — | **new**: 7 files, `src/lib/media/*.ts` — Turbopack traces the sources a dynamic `path.resolve(getUploadDir(), …)` in `store.ts` could reach. Nothing reads or serves them (§7.2) |
| `.next/static`, `public` | not copied — `deploy.sh` step 7 copies them | the same |

`deploy.sh` is unaffected by any of it, and was read for exactly this: step 7
copies `.next/static` and `public` into the standalone and creates
`.next/standalone/.next/cache`; staging is `cp -a` (which keeps a symlink a
symlink) into `standalone.incoming`, and the switch and every rollback move
the runtime as one tree with `mv -T`. A relative link inside the tree moves
with it. The systemd unit starts `node .next/standalone/server.js` from the app
directory, and `server.js` still changes into its own.

### 7.2 Proved, not only read

A scratch script (not committed) took the candidate's build through what
`deploy.sh` and the systemd unit do: step 7's commands in the build tree
(static and `public` into the standalone, `.next/cache`, the release marker),
`cp -a` into `standalone.incoming` and `mv -T` onto `<app>/.next/standalone`,
then **deleted the build tree** and started `node .next/standalone/server.js`
from the app directory as `nobody`, able to write only the uploads directory
and the two cache directories — the unit's `ProtectSystem=strict` and
`ReadWritePaths`, emulated. The same script against the 15.5.25 build of
`edcb4f4`, for comparison.

| Check | `c53e09b` (16.3.8) | `edcb4f4` (15.5.25) |
|---|---|---|
| Turbopack's `sharp` alias (`.next/node_modules/sharp-20c6a5da84e2135f → ../../node_modules/sharp`) resolves after staging and the switch | ok | — (none) |
| `server.js` at the runtime root; the release marker survives staging | ok | ok |
| starts, as `nobody`, with the build tree gone | `▲ Next.js 16.3.8 … Ready` | `▲ Next.js 15.5.25 … Ready` |
| `/`, `/about`, `/services`, a category, `/packages`, a destination, `/search`, `/ar`, `/ar/services`, `/ar/about` | 200 | 200 |
| `/en/about` → 301 `/about`; an unknown page 404 | ok | ok |
| CSP with a fresh nonce on every request; every executable `<script>` carries it | **17 of 17** (Turbopack's chunks) | 60 of 60 |
| `<script type="application/ld+json">` without a nonce | 2 — data blocks, never executed, so CSP does not apply | the same 2 |
| `X-Content-Type-Options`, `Referrer-Policy`, `X-DNS-Prefetch-Control`, `Permissions-Policy`, `Strict-Transport-Security`; no `X-Powered-By` | ok | ok |
| `robots.txt`; `sitemap.xml` (186 addresses) | ok | ok |
| `?preview` answers `noindex` and `no-store` | ok | ok |
| a static chunk and a font `immutable` for a year; a stylesheet; a brand file | ok | ok |
| `/media/<file>` from `UPLOAD_DIR`; a traversal refused | ok | ok |
| `src/lib/media/store.ts`, `/.next/standalone/src/…`, `/.env`, `/.eod-release-sha`, `/server.js`, `/package.json` | 404 — not served | 404 |
| `/admin/login`; `/admin` unsigned → 307 to login; signed in → 200 | ok | ok |
| the Visual Editor page; a canvas document (`?preview=1&editor=1&bridge=…`) carrying the editor's `data-eod-` marks | ok | ok |
| an image uploaded through `uploadMedia` decoded by `sharp` in the runtime and its derivatives written to `UPLOAD_DIR` | ok | ok |
| no failure line in the server's output | ok | ok |
| **Total** | **47 ok, 0 bad** | 46 ok, 0 bad (no alias to check) |

So the layout change is real but harmless: the runtime starts and serves
from its own tree after the build is gone, as an unprivileged user, and
`deploy.sh` needs no change.

**The `/en/…` redirect in production's form.** Next 16 writes a same-origin
middleware redirect as a path (§1.5). In production the middleware builds
that redirect against `NEXT_PUBLIC_SITE_URL`, an `https://` origin the server
itself never sees, so it should stay a full URL. A scratch build of
`43216ec` (the middleware is the same at `c53e09b`) with
`NEXT_PUBLIC_SITE_URL=https://www.example.test` inlined answered
`GET /en/about` with **301 `https://www.example.test/about`** and `GET /en`
with **301 `https://www.example.test/`**, both when asked with nginx's
forwarded headers and when asked on the port directly — the absolute
address production has always sent.

## 8. `npm audit` (brief §8)

`npm audit --json` at `edcb4f4` and on the candidate, same registry, same day:

| | Total | Critical | High | Moderate | Low |
|---|---|---|---|---|---|
| `edcb4f4` (Batch 26) | 12 | 0 | 7 | 5 | 0 |
| candidate | **10** | **0** | **6** | **4** | 0 |

**Removed (6 advisories, 2 packages):**

- `next` (moderate): GHSA-4jqv-mc3x-m676 and GHSA-mcj8-r9mp-w47p — cache
  poisoning of SSG/ISR pages in self-hosted applications, `>=15.0.0 <15.5.27`.
- Next's nested `postcss` 8.4.31 (high): GHSA-6g55-p6wh-862q and
  GHSA-r28c-9q8g-f849 (high), GHSA-qx2v-qp2m-jg93 and GHSA-fxqj-rqcc-2cmp
  (moderate) — Next 16.3.8 carries `postcss` 8.5.23, past all four. Batch 19B
  held these build-only and recorded that "fixing it needs Next 16".

**Added: none.** No new Critical, no new High.

**Unchanged (all build or development tooling):**

- `source-map-js` 1.2.1 (high, GHSA-68fv-2mgg-jv7q) — now reached only
  through the build's CSS tooling: `@tailwindcss/node`, Tailwind's `postcss`
  8.5.28 and Next's 8.5.23.
  Batch 25 held it out of the running application because only Next's nested
  `postcss` required it in the server; the Next 16 server ships neither the
  package nor anything naming it (`dependency-advisories.test.ts`). A patched
  1.2.2 exists inside the range its parents declare; taking it would be an
  `npm audit fix`, which this batch does not run.
- `braces` → `micromatch` → `fast-glob` → `@next/eslint-plugin-next` →
  `eslint-config-next` (high, GHSA-vfj7-8cjw-p6xm, no patched release) —
  lint tooling; the chain is the same at 16.3.8 (`fast-glob` 3.3.1). Nothing
  imports it and the server does not ship it (`dependency-advisories.test.ts`).
- `esbuild` under `@esbuild-kit/*` → `drizzle-kit` (moderate,
  GHSA-67mh-4wv8-2f99) — `db:generate` only; migrations run through `tsx`.

Chains changed only where §1.4 says: `next` and its nested `postcss` moved; the
`eslint-config-next` chain moved to 16.3.8 with the same `fast-glob`.

## 9. The schema (brief §9)

No migration was added, removed or edited: `drizzle/` is byte-identical to
`edcb4f4` — `0000`–`0007`, no `0008` — and the destructive-DDL search over it
finds nothing. Production stays at `902a0e6` with `0000`–`0005`
(`deploy/previous-release`, unchanged); the candidate's migrations over it are
`0006`–`0007`, as in Batch 26. Schema compatibility against `902a0e6` —
`tests/schema-compat.test.ts`, which runs `902a0e6`'s own schema on this
release's fresh install, on a database `902a0e6` built with its own migrate and
seed and this release then upgraded, and `902a0e6`'s own scripts again as a
rollback deploy runs them — passes on the candidate, as do
`permissions-migration` (the next deploy and a rollback deploy to `902a0e6`
move no key and no grant) and `cta-audit` (§10). The framework does not touch
the database: Next.js and React are not in the migration path, and
`db:migrate` / `db:seed` run through `tsx`, not through Next.

## 10. The gate (brief §10)

Four commits on `batch-27-next16-qualification`, on top of `edcb4f4`:

| Commit | What |
|---|---|
| `43216ec` | the upgrade and the tests that follow it (§3.1–§3.2) |
| `c53e09b` | optimistic routing off, and `prefetch-bounded` (§3.3) — the application the matrix (§4), the Server Action runs (§5), the artifact check (§7) and the comparisons in §6 measured |
| `ff3ba49` | `motion-15b` says what the editor showed when "Ready" does not come (§6.3) — one test file |
| this record's commit | this record and the browser README's #418 note — documentation only |

From `c53e09b` to the final commit the diff touches
`tests/browser/probes/motion-15b.probe.mts` and Markdown files and nothing
else — no application source, configuration, dependency or migration — so
the build those measurements were made on is the build the final commit
makes.

The gate runs on the final commit, in order, each step from the one before,
nothing skipped, on this machine (4 CPUs, PostgreSQL 16, Chromium 141):
`npm ci --include=dev --ignore-scripts` and `npm rebuild sharp`; the test
fixtures rebuilt (`REBUILD_FIXTURES=1`); a cold production build with
`.next` removed and `DATABASE_URL` unreachable; `npm run lint`;
`npm run typecheck`; `npm test`; every browser probe
(`npm run test:browser`); every stress script (`npm run test:stress`); the
security and compatibility set — the destructive-DDL search and
`schema-compat`, `permissions-migration`, `permissions-authority`,
`permissions-granular`, `globals-permissions`, `build-isolation`,
`public-routes`, `cta-audit`, `browser-suite`, `dependency-advisories`,
`deploy-target`; and `npm audit`. Then the commit is pushed and CI and
Stress are dispatched on exactly it. This record is part of the commit the
gate measures, so the gate's results and the two run IDs are not written
here: they are in the batch's report.

## 11. What is not settled, and what was not verified

- **The 14 October out-of-band security update** (two Critical, one High,
  upstream; §1.3) had not been published when this record was written, in
  the first hour of 14 October (UTC). The release that carries it must be
  taken — the smallest bump on the 16.3 line — and this qualification run
  again on it before any deployment. This record qualifies 16.3.8 and
  nothing later.
- **The `motion-15b` failure on CI (§6.3).** Once, on CI's Chromium 153,
  the Visual Editor did not reach "Ready" within 60 s after opening Home; it
  did not happen in six runs of the probe or 100 timed opens here, nor on CI
  at `43216ec`. Its cause is not established. The probe now names what the
  editor showed when the wait times out, so a recurrence says which part
  failed; the final commit's CI result is in the batch's report (§10).
- **A new line in the service's log.** On Next 16, a visitor who leaves a
  page while it is still arriving — or a prefetch the router cancels —
  makes the server log `⨯ Error: The destination stream closed early.` with
  a digest (§4.4): nothing failed, but the line looks like an error. Anyone
  reading or alerting on the production log after a Next 16 release should
  know that this digest's message is a disconnect, and that every other
  digest still means what it did. Five stress scripts (`media-references`,
  `package-concurrency`, `seo-media-concurrency`, `service-concurrency`,
  `service-form-concurrency`) fail on any server failure line over their
  run. None has met this line in any of their runs here or on CI; one that
  left a page mid-stream would. They were not changed for it.
- **What a visit costs (§6.1).** The same pages load as fast from the
  server, but the client is heavier (25–85 KB more script a page) and its
  links prefetch about twice as many RSC requests — each a small render on
  the server. On a slow connection `load` comes 0.4 s later; on a busy
  server the extra renders add up. Measured here, not on the VPS.
- **Older browsers.** Next 16 compiles for Chrome/Edge/Firefox 111+ and
  Safari 16.4+ (March 2023); 15.x compiled for Chrome 64, Edge 79, Firefox 67,
  Opera 51 and Safari 12. A visitor on an older browser — an iPhone that stopped
  at iOS 16.3, say — still gets every server-rendered page, but the page may
  not hydrate: menus, the enquiry form's validation and anything interactive
  may not work there. The repository sets no `browserslist`, so Next's default
  applies. Keeping the older targets would be a `browserslist` decision for the
  owner, and would not by itself make Next's own runtime run on them; this
  batch changes nothing here and does not measure the share of such visitors.
- **`middleware` → `proxy`.** Deprecated, still supported, and kept (§3.1);
  the build prints a warning. The rename moves it to the Node.js runtime and
  belongs in its own change.
- **Lint warnings.** 38 React Compiler readiness warnings in tested editor,
  admin and site code, and 2 from a new Next rule (§3.1) — reported, not
  failed. They are work for a batch of its own.
- **A bare RSC request on a public page.** An `RSC: 1` request that carries no
  router header digests to an empty `_rsc`, which the middleware's rewrite to
  `/en/…` does not keep, so such a request is redirected back and forth until
  the client gives up. Next's router never sends one — every navigation and
  prefetch carries router headers and a non-empty `_rsc` (§6) — so no visitor
  meets it; a hand-written client or a tool would. Recorded, not changed.
- **Redirect form in production.** A same-origin redirect from the middleware
  is now written as a path. In production the `/en/…` redirect is built
  against `NEXT_PUBLIC_SITE_URL` (`https://…`), an origin different from the
  `http://127.0.0.1:3000` the server sees, so it stays a full URL there — read
  from the code and from a scratch build with an `https://` origin inlined
  (§7.2), not from production.
- **A `/favicon.ico` 404 in the panel.** Opening the Visual Editor from the
  dashboard makes Chromium ask for `/favicon.ico` once on Next 16 — a console
  "Failed to load resource: 404" in every `route-services` run here (3 of 3),
  none on the 15.5.25 baseline. The declared icons are in the initial `<head>`
  of every page on both builds (`/brand/favicon-32.png`; the public site also
  `/brand/favicon.ico`), and the site has no `/favicon.ico` at its root, so the
  request falls through to the app's not-found page. Nothing else follows from
  it: the tab icon is the declared one, the runner counts a 404 resource as
  benign by design, and the public site's navigations do not show it (§6).
  Shipping a root `/favicon.ico` would silence it; that is a change to the
  site's files, left to the owner.
- **Local browser.** The probes, stress scripts and matrix here ran on the
  sandbox's preinstalled Chromium 141 (`PLAYWRIGHT_CHROMIUM_EXECUTABLE`); CI
  runs Playwright 1.63's own Chromium 153 (headless shell), which this
  sandbox cannot install. The matrix's figures are Chromium 141's.
- **Not measured: production.** No request went to the live website or its
  server, the production database was not read, and `902a0e6` was not built
  or measured — as in Batch 26. Whether live visitors meet #418 today is not
  known from this batch; that the candidate does not, under the conditions in
  §4, is.
