# SEO and share images (Batch 25)

Batch 24 recorded two findings it left for a later batch
(`docs/visual-editor/whole-site-coverage.md` A.9):

- **F5** — SEO share images (a page's override, `seo_metadata.og_image_id`,
  and the site default, `settings.seo.ogImageId`) are not counted by the
  media library's delete guard.
- **F6** — the SEO screen has no destination entries and no entries for the
  `/services` and `/packages` overviews, although the pages read overrides for
  them.

Batch 25 closes both. This document has three parts. **Part A** is the SEO
system as found at `da96625` (main after the Batch 24 merge), written before
any source file changed. **Part B** is the design of record. **Part C** is the
state at the end of the batch, route by route.

---

## Part A — SEO as found (`da96625`)

Traced from the renderer down — `generateMetadata` → `buildMetadata` →
loader → table — not from the admin screen.

### A.1 Storage

**`seo_metadata`** (`src/lib/db/schema.ts:895-915`, created by
`drizzle/0000_init.sql:163-178` and never altered since):

| Column | Type | Notes |
|---|---|---|
| `id` | serial | |
| `entity_type` | varchar(32) | comment says `page \| category \| service \| package \| video`; `video` is used nowhere, `destination` is read but not listed |
| `entity_key` | varchar(190) | comment says "slug or numeric id, as text"; every caller uses a slug |
| `title_en`, `title_ar` | varchar(190), default `''` | |
| `description_en`, `description_ar` | varchar(320), default `''` | |
| `canonical_url` | varchar(255), default `''` | one value for both editions |
| `og_title`, `og_description` | varchar(190) / (320), default `''` | one value for both editions |
| `og_image_id` | integer, FK `media.id` **ON DELETE SET NULL** | the only foreign key |
| `noindex` | boolean, default false | |
| `created_at`, `updated_at` | timestamptz | |

Unique index `seo_entity_idx` on `(entity_type, entity_key)`. No revision,
draft, status, `updated_by` or entity foreign key: nothing ties a row to the
record it describes except the text of its key.

**`site_settings`, key `seo`** (jsonb; shape and defaults in
`src/lib/settings-defaults.ts:63-74`): `defaultTitleEn/Ar`,
`titleTemplateEn/Ar` (`%s · Elite One Desk`), `defaultDescriptionEn/Ar`,
`ogImageId` (a bare media id inside jsonb — no foreign key) and
`twitterHandle`. It is read by `getSettings` (`src/lib/settings.ts:27-33`),
which is a per-request React `cache` with no cross-request cache. Its only
writer is the Server Action `saveSeoDefaults`
(`settings/actions.ts:181-199`, `seo.manage`), and **no screen calls it** —
not the Settings tabs (`settings/tabs.ts:8-16`), not the Visual Editor's
Globals drawer (`visual-editor/globals.ts` drops `settings.seo` on purpose).
It has had no caller since the first commit. The seed writes the defaults with
`onConflictDoNothing`, so `ogImageId` is `null` unless somebody wrote the
database by hand.

Other settings that reach SEO output: `brand.siteNameEn/Ar` (`og:site_name`,
and the title template is skipped when a title already contains it),
`brand.legalNameEn/Ar` (Organization and Service provider names),
`contact.*` (Organization contact data), `features.arabicEnabled` (hreflang
and sitemap languages), and the published `social_links` rows
(Organization `sameAs`).

### A.2 Renderer → resolver → storage, route by route

Every public page builds its metadata in one function, `buildMetadata`
(`src/lib/seo.ts:37-111`), and finds its override with
`getSeo(entityType, entityKey)` — a lookup in a map of the whole table
(`src/lib/queries/content.ts:178-190`).

| Address | Route file | Override looked up | Own values passed | Gate before metadata |
|---|---|---|---|---|
| `/` | `[lang]/page.tsx:16-20` | `page:home` | none (site defaults) | none |
| `/<slug>` | `[lang]/[...slug]/page.tsx:24-36` | `page:<slug>` | title (Arabic title when set) | **none** — `getPage` returns unpublished pages too |
| `/home` | `[...slug]` with `home` | `page:home` | the homepage's title | none; canonical `/home` |
| `/services` | `services/page.tsx:71-83` | `page:services` | fixed title, description from the taxonomy copy | none |
| `/services/<category>` | `services/[category]/page.tsx:35-53` | `category:<slug>` | title, summary ‖ tagline, `image_id` | published categories only |
| `/services/<category>/<service>` | `[service]/page.tsx:50-65` | `service:<category>/<service>` | title, intro, `image_id`, `article` | published service in a published category |
| `/packages` | `packages/page.tsx:42-57` | `page:packages` | fixed title and description | none |
| `/packages/<slug>` (destination) | `packages/[slug]/page.tsx:37-48` | `destination:<slug>` | title, summary, `image_id` | published destinations (checked first) |
| `/packages/<slug>` (package) | `packages/[slug]/page.tsx:50-61` | `package:<slug>` | title, summary, `image_id`, `article` | published packages |
| `/search` | `search/page.tsx:15-25` | none | fixed title, `noindex` | none |
| 404 / error | `not-found.tsx`, `error.tsx` | none | none | no metadata at all, so no `<title>`; Next adds its own `noindex` to a 404 |

The Arabic edition is the same route under `/ar`; every row above applies to
it. `generateMetadata` reads route parameters only, never the query string,
so a preview, the editor canvas and a version comparison all carry the
**published** page's metadata (A.4).

Three of these lookups can never be satisfied from the admin:
`destination:<slug>` (the SEO screen and `saveSeo` do not know the type),
`page:services` and `page:packages` (both slugs are reserved for the site,
`pages/actions.ts:57-59`, so no `pages` row — and therefore no SEO screen
entry — can exist for them).

### A.3 Precedence, and the two languages

`buildMetadata` takes each value from the first of: the override row, the
page's own value (`args`), the site default.

| Output | Chain |
|---|---|
| `<title>` | `pick(locale, override.titleEn, override.titleAr)` → `args.title` → `settings.seo.defaultTitle*`; then `titleTemplate*` unless the title already contains the site name |
| description | same chain, as plain text, cut at 300 characters (the columns allow 320) |
| `og:title`, `twitter:title` | `override.ogTitle` → the title |
| `og:description`, `twitter:description` | `override.ogDescription` → the description |
| share image | `override.ogImageId ?? args.imageId ?? settings.seo.ogImageId`, looked up in the media map; **a miss goes straight to `/brand/og-default.jpg`** rather than on to the next candidate |
| robots | `override.noindex \|\| args.noindex` |

`pick` (`src/lib/i18n/config.ts:38-41`) falls back from an empty Arabic value
to the English one. Applied to an override that is right for content and
wrong here: an English-only title override is shown on the **Arabic** page in
place of the page's own Arabic title, although the SEO screen says "leave a
field empty and the page keeps following its own content". `og_title` and
`og_description` have no Arabic column at all, so the Arabic edition always
shares the English one.

### A.4 Canonical, alternates, robots, preview

- **Canonical** — `override.canonicalUrl` if set (used as given when it starts
  with `http`, otherwise appended to the site URL), else the page's own
  address in its own edition. A site-relative override is **not** given the
  `/ar` prefix, so the Arabic page declares the English page canonical while
  its hreflang still advertises `/ar`. `saveSeo` checks only that the value
  starts with `/` or `https://`: `//host`, a query string and a fragment all
  pass. Without an override a canonical never carries a query string.
- **Alternates** — `en` and `x-default` (both the English address), plus `ar`
  when `features.arabicEnabled` is on. `og:locale:alternate` names the other
  language even when Arabic is switched off.
- **Robots meta** — `index, follow, max-image-preview:large`, or
  `noindex, follow` when the override or the route says so. Only `/search`
  says so in code.
- **`/en/…`** — answered with a 301 to the unprefixed address by the
  middleware; `/en` is the internal shape only.
- **Preview, editor canvas, Version Compare, component preview** — the
  metadata is the published page's (the comment at `[service]/page.tsx:44-49`
  says why: a draft title in a `<title>` is one more place it could be
  mistaken for the live one). The middleware adds
  `X-Robots-Tag: noindex, nofollow, noarchive` and
  `Cache-Control: private, no-store` to any request carrying `preview`,
  `compare` or `component`, authorised or not (`src/middleware.ts:117-124`).
  The parameters grant nothing by themselves: an anonymous `?preview=1` gets
  the published page with those headers.
- **Unpublished CMS page** — its metadata is built anyway (title, override,
  share image, canonical) while the body answers 404, because `getPage` does
  not filter on `is_published`. The 404 response therefore carries the
  unpublished page's title.
- **`/home`** — the catch-all serves the homepage at `/home` too, with its own
  canonical `/home`: a second indexable address for `/`.

### A.5 Open Graph and Twitter

`openGraph`: type, `siteName`, `locale` (`ar_SA`/`en_US`), `alternateLocale`,
`url` = the canonical, title, description and one image, always declared
`1200×630` with `alt` = the site name. `twitter`: `summary_large_image`,
`site` = `settings.seo.twitterHandle`, the same title, description and image.

The image URL is the 1600-pixel derivative when one exists
(`derivatives[2]`), else the original. Derivatives live at
`/media/<stem>@1600.webp`, which `robots.txt` disallows (`/media/*@*`) — and
X's crawler honours robots.txt for card images. An SVG upload has no
derivatives, so it can become the share image as an `.svg`.

### A.6 Structured data

| Route | JSON-LD |
|---|---|
| `/` | Organization (`logo`/`image` are static files under `/brand`), WebSite with a SearchAction |
| `/services/<category>` | BreadcrumbList, FAQPage (when it has questions), ItemList |
| `/services/<category>/<service>` | BreadcrumbList, FAQPage, Service |
| `/packages/<package>` | BreadcrumbList, TouristTrip (`name`, `description`, `touristType`) |
| any CMS page with a FAQ block | FAQPage |
| destinations, `/services`, `/packages`, `/search` | none |

No JSON-LD node carries a media-library id. The WebSite node uses the raw
`NEXT_PUBLIC_SITE_URL` rather than the normalised `siteUrl` (so do the
category ItemList and the Service provider), the English site name on both
editions, and an unprefixed `/search` target that is emitted even when search
is switched off.

The `/services` and `/packages` hero wording is editable in the Visual Editor
(Batch 24, `route_nodes.copy`), but their `<title>` and description are fixed
in the route. That is deliberate rather than an oversight — visible copy and
search metadata are different things — but it means the only way to change
those two pages' metadata is an override nobody can make (A.2).

### A.7 Sitemap and robots

`/sitemap.xml` (`src/app/sitemap.ts`) is generated per request from the same
tagged loaders the pages use: `/`, `/services`, `/packages`, published CMS
pages except `home` and `search`, published categories, published services in
published categories, published destinations **that hold at least one
published package**, and published packages — each once per enabled language
with hreflang alternates (no `x-default`). It never reads `seo_metadata`: an
address marked noindex on the SEO screen stays listed, and a canonical
override is not reflected.

`/robots.txt` is static: allow `/`, disallow `/admin`, `/api/`, `/media/*@*`,
the sitemap and the host.

### A.8 Caching and invalidation

Pages render per request; the data loaders are cached and tagged.

- All `seo_metadata` rows: one `unstable_cache` entry (`seo-rows`, tag `seo`,
  an hour), dropped only by `saveSeo` and `clearSeo`. Both editions read the
  same rows, so one tag covers both.
- Site settings: never cached across requests; a settings save is live at the
  next request (the `settings` tag it drops has no consumer).
- Entity saves drop `catalog` or `packages`; a Visual Editor route publish
  drops `catalog`, `faqs`, `packages` and `routes`. None drops `seo` — correct
  while none of them writes an SEO row.
- `deleteMedia` drops `media` only. The cached SEO rows can keep a deleted
  image id for up to an hour, and because the image chain does not fall
  through (A.3) the page shows the static default instead of its own picture
  meanwhile.

### A.9 The SEO screen, and how it saves

`/admin/seo` (`seo/page.tsx`, `seo-client.tsx`, `seo/actions.ts`) requires
`seo.manage` (owner, admin and editor hold it). It lists every `pages` row,
every category, every service (joined to its category) and every package —
unpublished ones included and unmarked. There are no destination entries, no
overview entries and no site-defaults form.

`saveSeo`:

- `guardAction("seo.manage", form)` — session, CSRF token, permission.
- The type must be `page`, `category`, `service` or `package`; **the key is
  not checked against any record**, so a hand-made request can create a row
  for any key (`page:services` included) and the routes will honour it.
- Lengths are cut silently by `field()` — the key included: a service key
  (`<category slug>/<service slug>`, two `varchar(120)` slugs) longer than 190
  characters is saved under a truncated key the route never asks for, so that
  override is silently dead. The canonical check is the loose one in A.4; the
  share image id is not checked (a missing id fails on the foreign key as a
  generic error) and an SVG can be chosen. `saveSeoDefaults` checks its image
  id even less: any positive number, fractional or missing, is stored.
- One statement: `INSERT … ON CONFLICT (entity_type, entity_key) DO UPDATE`
  every field. **No base, revision or transaction — last write wins**, and a
  form left open puts back whatever it was drawn with.
- Activity `seo.updated` (no field list), then `revalidate(TAGS.seo)`.

`clearSeo` deletes the row by type and key. There is no SEO draft, preview or
history: a save is live as soon as the tag drops.

### A.10 Identity: renames, moves and deletions

Keys are addresses: `page:<slug>`, `category:<slug>`,
`service:<category slug>/<service slug>`, `package:<slug>`,
`destination:<slug>`, and `page:services` / `page:packages` for the two
overviews.

| Record | Can its address change? |
|---|---|
| CMS page | No — the slug is fixed at creation; only custom pages can be deleted |
| Category | Not in the admin (`readCategory` has no slug); `scripts/restructure.ts` renames one |
| Service | The slug is fixed, but the **Placement** unit moves it to another category, which changes its address and its key |
| Package | No — "the address is not editable here" |
| Destination | **Yes** — the slug is a unit of the Destinations form |

Nothing outside `seo/actions.ts` touches `seo_metadata`. A destination rename
or a service move leaves the row under the old key: the page at the new
address loses its override, and the row disappears from the screen (which
matches rows to records by key). A deletion leaves the row too, and a later
record that takes the same address silently inherits it — `noindex`
included.

### A.11 Every field that can reference media for SEO or social use

| Source | Used for | Where | Draft / history | On media delete | Guarded at `da96625` |
|---|---|---|---|---|---|
| `seo_metadata.og_image_id` | `og:image`, `twitter:image` — first choice | any route with a matching row | none: live on save | FK `SET NULL`: the override silently loses its picture | **No** |
| `site_settings.seo.ogImageId` | the default share image, after the override and the page's own picture | every route without either | none | nothing (jsonb): the id dangles, pages fall back to `/brand/og-default.jpg` | **No** |
| `service_categories.image_id` | category picture; share-image fallback on its page | `/services/<category>` | Visual Editor drafts (guarded); `route_versions` (history) | FK `SET NULL` | Yes |
| `services.image_id` | service picture; share-image fallback | `/services/<category>/<service>` | as above | FK `SET NULL` | Yes |
| `travel_packages.image_id` | package picture; share-image fallback | `/packages/<package>` | as above | FK `SET NULL` | Yes |
| `package_destinations.image_id` | destination picture; share-image fallback | `/packages/<destination>` | as above | FK `SET NULL` | Yes |
| `route_nodes.draft_content` (fields declared `check: "media"`) | a pending picture that becomes one of the four above on publish | those routes | the draft itself | publish refuses a missing picture | Yes (`routeDraftMedia`, while the record exists) |
| `route_versions.snapshot` | history; a restore source | none directly | history | restore skips a missing picture and reports it | No, by design |
| `/brand/og-default.jpg`, `/brand/logo-320.png` | last share-image fallback; Organization `image` and `logo` | every route / home | — | static files, not media rows | n/a |
| `/brand/favicon-*.png`, `/brand/favicon.ico` | icons declared by the public layout | every route | — | static files | n/a |

Nothing else reaches SEO or social output: a CMS page passes no image to
`buildMetadata`, so section pictures, reusable components, videos and
testimonials never become a share image, and no JSON-LD node names a media
id. There is no `opengraph-image`, `twitter-image`, `icon` or manifest file
convention anywhere in `src/app` or `public/`. Arabic and English share one
picture per target — there is one column.

### A.12 The media delete guard as found

There is one delete path, `deleteMedia` (`media/actions.ts:92-123`):
`guardAction("media.manage", form)` (session, CSRF, permission), then
`mediaUsage(id)` recomputed on the server (`src/lib/media/usage.ts`), a
refusal naming the first three uses, else `db.delete(media)`, the files
unlinked, and `revalidate(TAGS.media)`. The browser sends only the id; the
library card's count is display-only.

`mediaUsage` counts page sections (published and draft, top-level values),
category, service, package and destination pictures, video thumbnails,
testimonial portraits, reusable components (published and draft) and
Visual Editor route drafts. It does **not** count `seo_metadata.og_image_id`
or `settings.seo.ogImageId` (F5).

Also found, outside SEO:

- the check and the delete are separate statements with no transaction or
  lock, so a reference written between them is lost — nulled by the foreign
  key, or left dangling in jsonb;
- the library card's "Used in N places" is a different SQL count from the
  guard's list (per key and per published/draft rather than per row);
- a picture inside a repeatable row (Quick Links `links[].image`) is not seen,
  because the jsonb search is top-level only;
- any top-level number equal to an id counts as a use (a block's `limit` of 6
  makes picture 6 undeletable);
- page and reusable-component version restores copy a missing picture id back
  into the draft without a warning (the renderers then draw no picture); the
  route restore skips and reports it.

### A.13 Tests as found

No test calls `saveSeo` or `buildMetadata` directly. `clearSeo` is covered
for its activity entry only (`mutation-audit.test.ts:358-370`). Rendered SEO
is asserted narrowly: the `/services` description in both editions, the
`<title>` of service and package pages around draft and publish, JSON-LD
(Service, TouristTrip, BreadcrumbList, ItemList, Organization `sameAs`), and
the `X-Robots-Tag` header on preview, canvas and compare responses. The
sitemap has five tests; nobody fetches `/robots.txt`. No test reads a
canonical, an hreflang alternate, an `og:` or a `twitter:` tag, an override's
`noindex`, or the media guard against an SEO picture. No browser probe opens
`/admin/seo`; no stress script touches SEO or media deletion.

### A.14 Findings

The last column is the plan as it stood at this audit. Three plans changed in
review — F6j, F6k and the robots half of F6l are recorded rather than fixed —
and C.3 gives every finding's final disposition.

| # | Finding | Batch 25 |
|---|---|---|
| F5a | `seo_metadata.og_image_id` is not counted by the delete guard or the library count | fix |
| F5b | `settings.seo.ogImageId` is not counted, and has no foreign key | fix |
| F5c | Media check and delete are not atomic | fix (one transaction and a row lock) |
| F5d | A missing share-image id goes straight to the static default; `deleteMedia` leaves the SEO cache holding it | fix |
| F6a | Destinations have no SEO entry and their type is refused | fix |
| F6b | `/services` and `/packages` have no SEO entry | fix |
| F6c | Keys are addresses: a destination rename or service move loses the override; a deletion leaves a row the next record at that address inherits | fix (stable identity) |
| F6d | `saveSeo` accepts any key, for a record that does not exist or a type it does not have | fix |
| F6e | SEO saves are whole-row, last write wins | fix (signed base) |
| F6f | English overrides replace the page's own Arabic title and description; `og_title`/`og_description` are English-only; a relative canonical is not localised | fix |
| F6g | A canonical override may be `//host`, or carry a query string or fragment | fix |
| F6h | An unpublished CMS page's metadata is built for its 404 | fix |
| F6i | `/home` is a second indexable address for `/` | fix (canonical) |
| F6j | The sitemap lists addresses marked noindex | fix |
| F6k | The site defaults — including the default share image — have no screen | fix |
| F6l | `og:image` is always declared 1200×630; the 1600 derivative is disallowed by robots.txt; an SVG can be chosen; `saveSeoDefaults` stores any number as an image id | fix |
| F6m | A service key longer than 190 characters is truncated on save and never found | fix (identity is the id) |
| F6n | `og:locale:alternate` names Arabic while Arabic is switched off | fix |
| X1 | Quick Links pictures inside repeatable rows are not counted by the guard | recorded — not SEO |
| X2 | Numeric block values (`limit`) are counted as picture uses | recorded — not SEO |
| X3 | Page and component version restores bring back a missing picture id silently | recorded — not SEO |
| X4 | JSON-LD: raw `NEXT_PUBLIC_SITE_URL` (WebSite, ItemList, Service provider), English WebSite name on `/ar`, unprefixed SearchAction emitted even with search off | recorded |
| X5 | 404 and error pages have no `<title>` | recorded — no SEO editing there by design (brief §15) |
| X6 | The sitemap has no `x-default` | recorded |
| X7 | `/services` and `/packages` metadata does not follow their Visual Editor hero copy | by design (brief §14): metadata comes from the SEO record, not the visible copy |
| X8 | The retired-address maps of the 2026 restructure (`src/lib/taxonomy-moves.ts`) are not applied to SEO rows | recorded; see B.3 |

### A.15 Schema verdict

The table can already hold every target the site has; what it cannot do is
**know which record a row belongs to**. For the two overviews and for CMS
pages that does not matter — their addresses are fixed — so `page:services`,
`page:packages` and `page:<slug>` remain correct keys. For categories,
services, packages and destinations the key is the address, and the address
is not the identity. The Visual Editor answered the same question in
Batch 21–24 by keying every region by the record's id ("its slug can change,
its id cannot", `src/lib/routes/owners.ts`), so that is the identity to
reuse. Part B adds it as a nullable column beside the key, rather than by
rewriting the key, because the previous release reads the key (A.10) and
must keep reading it after a rollback (DEPLOYMENT.md, *Migrations must be
backward-compatible*). Arabic share text needs two additive columns. No
existing row is removed or rewritten in meaning.

---

## Part B — design of record

Revised after review, after the stress run that found the lock defect in B.11
(C.3, N2) and after the adversarial review's corrections (C.3, C1–T4): this
part describes what the code does.

### B.1 SEO targets

A **target** is one thing that has, or can have, an SEO record of its own. It
is named by a reference `<kind>:<id>` — the Visual Editor's route key wherever
the editor has one, so the editor links to a target by the key it already
holds and no address is ever part of an identity.

| Kind | Reference | Public address | Stored as (`entity_type`, `entity_key`, `entity_id`) |
|---|---|---|---|
| site defaults | `site:1` | every page, as the last fallback | `site_settings` key `seo` (read-only here, C.4) |
| CMS page | `page:<pages.id>` | `/` for `home`, else `/<slug>` | `page`, the slug, the page's id |
| Services overview | `serviceIndex:1` | `/services` | `page`, `services`, none |
| Tour packages overview | `packageIndex:1` | `/packages` | `page`, `packages`, none |
| service category | `category:<id>` | `/services/<slug>` | `category`, the slug, the id |
| service | `service:<id>` | `/services/<category>/<slug>` | `service`, `<category>/<slug>`, the id |
| destination | `destination:<id>` | `/packages/<slug>` | `destination`, the slug, the id |
| travel package | `package:<id>` | `/packages/<slug>` | `package`, the slug, the id |

Not targets, deliberately (brief §15): `/search` (always `noindex`, said in
code), the 404 and error pages, `/media/…`, `/api/…`, `robots.txt` and
`sitemap.xml`. A reference to anything else is refused before it is read.

Two modules own it:

- `src/lib/seo-model.ts` — the vocabulary and the rules, with no
  `server-only` so `scripts/migrate.ts` can use them: parsing a reference
  (`parseSeoRef`: the kinds above, a positive id without leading zeros, `:1`
  for the singletons), where a target's record lives (`recordStorage`,
  `overviewStorage`), **which stored row a target uses** (`preferredSeoRow`,
  through `seoRowFor`, B.2),
  which text each language shows (`textFor`, `shareTextFor`, B.4), which
  canonical addresses are acceptable (B.15) and the deploy-time
  reconciliation (B.3).
- `src/lib/seo-targets.ts` — the database side: listing every target for the
  screen, loading one by reference from the table its kind names (B.9), the
  locks (B.11), and the writes that keep a record's row with it (B.7).

Every reader of a record — the public pages (`getSeoRecord`), the SEO screen,
the media guard (`seoMediaUsage`) and the Visual Editor's indicator — goes
through `seoRowFor`, and every writer that locks a target's rows
(`lockOwnSeoRows`) through the same `preferredSeoRow`, so none of them can
disagree about which row applies. Each reader indexes **every** row, not only
the ones that hold what it is looking for: the media guard once indexed only
rows naming a picture, and so could protect a picture on a row the page does
not use (C.3, T3).
The sitemap reads no SEO record (B.13).

### B.2 Identity

`seo_metadata` gains a nullable `entity_id` (B.3). A row is

- **bound** (`entity_id > 0`) — it belongs to that record of its type,
  wherever the record's address goes;
- **unbound** (`entity_id` null) — a row only the address names: the two
  overviews always, and a row the previous release wrote that this one has
  not bound yet. One whose key is in a reserved form (below) names nothing —
  no address is one — and is as dead as a detached row (W2³);
- **detached** (`entity_id = 0`) — a dead row: it named no record when it was
  last examined, or its record was deleted, or a newer row replaced it. It is
  kept, never used, and keyed `~<row id>` — a key no address and no record can
  reach — so no record that takes its old address ever inherits it, under this
  release or under the previous one after a rollback, which reads by address.

The rule, in `preferredSeoRow`: a target uses its **bound** row if it has one,
else the **unbound** row whose key is its present address — exactly the row
the previous release would have used. One exception: a bound row keyed at
**another** address beside an unbound row at the present one means the
previous release moved the record and then saved its SEO by address. The
newer, unbound row is what that release shows and what the next deploy keeps
(B.3, step 2), so it is what this release shows too — on the page, on the
screen, to the media guard — until a save binds it and sets the other aside
(B.9). A detached row is never used, and neither is a row bound to another
record — or to a record that no longer exists — whatever its key says. Types
never cross: a destination and a package share the `/packages/<slug>` space,
never each other's rows. The deploy settles every row to exactly what this
rule already shows (B.3): one rule at runtime and at deploy.

`entity_key` stays the record's **present** address on every row this release
writes, binds or moves (B.7), because the previous release reads nothing else
(B.16). Two key forms no address can take keep the unique key free where an
address cannot be used:

- `#<record id>` — a service address longer than the column (two long slugs);
  the previous release could not find such a row anyway (A.9), and this one
  finds it by id. A bound row whose own address is momentarily held by another
  record's row is parked here too, until its record's address is free — and
  the deploy leaves here the rows of records whose addresses the previous
  release swapped, where every one of them shows a share image (B.3, step 5).
- `~<row id>` — every row taken out of use (`detachSeoRow`, and the deploy's
  set-asides).

Each form belongs to one row only: `#<id>` to that record's own row, `~<n>` to
row n. A row that is not bound and holds one anyway can only have been written
by hand, through the previous release's form (A.9). No reader of this release
uses it — the pages, the screen, the media guard and every writer's own lock
pass it by (`indexSeoRows`, `lockOwnSeoRows`) — and the deploy sets it aside
first (B.3, step 0), so the two agree on it (W2³). A write about to use a
reserved key — a record created at an address too long for the column
included (`freeSeoAddress`) — moves whatever else holds it to its own
`~<row id>` first (`claimSeoKey`, `detachSeoRow`), so parking a record's row or
setting one aside never meets a duplicate key, and a new record never starts
with such a row (C.3, D3, V2², W2³ and X3³).

### B.3 Migration `0007` and reconciliation

Additive only — DEPLOYMENT.md, *Migrations must be backward-compatible*:

```sql
ALTER TABLE "seo_metadata" ADD COLUMN "entity_id" integer;
ALTER TABLE "seo_metadata" ADD COLUMN "og_title_ar" varchar(190) DEFAULT '' NOT NULL;
ALTER TABLE "seo_metadata" ADD COLUMN "og_description_ar" varchar(320) DEFAULT '' NOT NULL;
CREATE UNIQUE INDEX "seo_entity_id_idx" ON "seo_metadata" USING btree ("entity_type","entity_id")
  WHERE "seo_metadata"."entity_id" > 0;
```

No row is deleted. The old unique index on `(entity_type, entity_key)` stays:
the previous release's upsert names it (`tests/schema-compat.test.ts` runs
that release's own upsert and delete against this schema).

**Reconciliation** is data, not shape, so — like the row-id backfill before
it — it runs in `scripts/migrate.ts` after the migrations, on every deploy:
`reconcileSeoRows` (`seo-model.ts`), set-based, in one transaction, for each
record type. The previous release reads and writes rows by address only and
serves during the deploy window and again after a rollback, so a deploy can
find rows in any state that release leaves behind. It settles each of them to
what this release's rule (B.2) already shows for it, so a deploy never changes
what this release shows.

The transaction is `REPEATABLE READ` and first takes `LOCK TABLE seo_metadata
IN EXCLUSIVE MODE`:

- **The lock.** A write that has not touched the table yet waits the few
  milliseconds the run takes — the previous release's saves and this
  release's alike. A write already under way is waited for instead, and then
  settled by the same run: that includes a save of this release that has
  locked its rows `FOR UPDATE` and has yet to write them, whose own later
  statements go ahead of the queued lock (PostgreSQL grants a lock at once to
  a transaction that already holds one the queued request conflicts with), so
  the two never wait on each other — a weaker lock let the run past that row
  lock, and the two then waited for each other (C.3, L1² and X6³). Reads, and
  so every public page, go on.
- **The snapshot.** Taken when the first statement after the lock runs, it
  holds for every statement after it: each reads the records as they were then.
  Without it, a record the previous release moved between two statements — its
  record writes never touch this table, so the lock does not hold them — could
  be re-keyed onto a key another row held, and stop the deploy (C.3, C2 and
  L2²). A record moved after the snapshot is settled where it was, and is the
  next run's to settle.
- **One update per row, where it shows a picture.** A second update of a row in
  one transaction makes PostgreSQL check its `og_image_id` against `media`
  again — a `FOR KEY SHARE` on the picture, taken after the run holds the SEO
  table. A media delete takes them the other way round: it holds the picture,
  then its `ON DELETE SET NULL` waits for the table — and the two would wait on
  each other (C.3, D1³). So the run never touches a picture: rows move once
  each, straight to where they belong, in as many passes as it takes; only rows
  that hold one another's addresses need a key on the way, and only a row with
  no picture — whose check has nothing to look up — is moved through one.

Then, type by type, in order:

0. a row that is not bound but holds a key in a reserved form (B.2) is **set
   aside** to its own `~<row id>` as soon as nothing holds that; rows that hold
   each other's are set aside under a key nobody can have written instead
   (`~<row id>~<nonce>`), where they stay — as out of use as their own, and
   left alone by every later run;
1. a row bound to a record that no longer exists is **set aside**: its record
   is gone (the previous release deleted it and left the row), and no reader
   of this release uses it (C.3, R3²);
2. a record's own row at an old address, beside an unbound row at its present
   one (the previous release moved it, then saved its SEO by address), is
   **set aside**: the newer row is the one in use (B.2);
3. an unbound row at a record's present address is **bound** to that record;
4. a detached row still at an address is **set aside** to its own `~<row id>`,
   so the address is free;
5. a bound row at an address its record no longer has is **moved** to the
   present one as soon as that is free — a pass at a time, so a chain of them
   unwinds. What is left holds one another's addresses: records the previous
   release swapped. Their rows with no picture step aside to their record's own
   `#<id>`, the rest move into the addresses that frees, and then they come back
   — so two records whose rows swapped addresses swap back. Where every row of
   such a ring shows a picture, each **waits** at its record's `#<id>`: bound,
   found by id and in use exactly as before, and moved to its address at the
   next run or its record's next save or move;
6. any other unbound row names no record: it is **set aside**. The overviews'
   two keys are left alone.

It logs `SEO records: N bound, N moved to their record's address, N set
aside.` — every statement that changed a row is counted (C.3, T4 and T5²) —
followed, when step 5 left a ring waiting, by `N left at their record's own
key for the next deploy: …`; or `SEO records: nothing to reconcile.`. A second
run writes nothing, except to finish such a ring (`tests/seo-reconcile.test.ts`
compares a data dump).

So a deploy changes nothing this release shows, and, against what the previous
release showed, only two things: a record's own row goes back to it, and a
dead row — one bound to a record deleted meanwhile, or one naming no record —
is no longer applied to whatever took its address (B.16). A row the previous
release wrote **by address** for a record it then deleted is not one of them:
it is unbound, and nothing tells it from a row written for whatever record
holds that address now, so it is that record's — at runtime, and bound to it
by the deploy (steps 2–3; C.3, D2³). Rows the previous release writes after the
run, while it still serves, are unbound until the next save or deploy binds
them — or sets them aside, if no record has their address — and are used by
address meanwhile (B.2).

The retired-address maps of the 2026 restructure (`taxonomy-moves.ts`) are
**not** used to rescue rows keyed by an address the restructure retired:
reconciliation follows what the live site applies today and nothing else
(A.14 X8).

### B.4 Resolution: what each page shows

`buildMetadata` keeps its order — the target's own record, then the page's
own content, then the site defaults — and takes each language on its own
(`textFor`, `shareTextFor` in `seo-model.ts`):

| Output | English | Arabic |
|---|---|---|
| `<title>` | record EN → own EN → default EN | record AR → own AR → *only where the page has no Arabic of its own:* record EN → own EN → default AR → default EN |
| description | the same chain over descriptions | the same chain over descriptions |
| template | the EN template, unless the title already holds the EN site name | the AR template, unless the title already holds the AR site name |
| `og:title`, `twitter:title` | record share title EN (`og_title`) → the title above | record share title AR (`og_title_ar`) → the title above; the English share title only where the title above is English |
| `og:description`, `twitter:description` | the same over share descriptions | the same over share descriptions |
| share image | the first of record image → page's own picture → site default image that **still exists and is not an SVG**; else `/brand/og-default.jpg` (1200×630) | the same picture (one column, one image) |
| canonical | the record's canonical if it is acceptable today (B.15), else the page's own address | the same page, drawn with the `/ar` prefix |
| robots | `noindex, follow` if the record or the route says so; else `index, follow, max-image-preview:large` | the same |
| alternates | `en` and `x-default` at the English address, `ar` while Arabic is on | the same |
| `og:locale` | `en_US`; `og:locale:alternate` `ar_SA` only while Arabic is on | `ar_SA`; `en_US` as the alternate |

An empty Arabic field means "follow this page's own Arabic", never "copy the
English record" — the promise the screen has always printed. Where a page has
no Arabic of its own at all (a custom page with no Arabic title, the homepage,
whose own title is the site default), the English record is preferred to raw
English content, and the screen's hint says so for that field.

The share image is the 1600-pixel rendition when the library made one and the
original is wider, else the original — as before Batch 25 — now declared with
its **real** width and height and its alt text in the page's language (the
site name when it has none). X is asked for a small card (`summary`) when the
picture is under 300×157. `robots.txt` still disallows the renditions
(`/media/*@*`), as it did before Batch 25; that is recorded, not changed
(C.4).

### B.5 F5: which share images are in use

A picture is **in use for SEO** when it is

1. the share image of the row some existing target **uses** under B.2 — its
   bound row, unless a newer unbound row at its present address shadows it;
   else the unbound row at its present address (the overviews' included) — or
2. the site default share image.

Applied to the categories the brief names (§3):

| Kind of reference | In use? | Why |
|---|---|---|
| Published (the target is live) | yes | it is what the page shows now |
| Pending draft | n/a | SEO has no drafts: a save is live as soon as it is made. Visual Editor drafts of a page's own picture are counted as before (`routeDraftMedia`) |
| Global fallback (`settings.seo.ogImageId`) | yes | every page without its own image shows it |
| Route-specific record | yes, while its target exists | B.2 |
| Unpublished record (its page or record is unpublished) | **yes** | publishing it makes the record live at once, and the record's own picture column is protected on the same terms |
| Historical / version-only | n/a | SEO has no history. Route history is B.6 |
| A detached row, a row bound to a deleted record, a dead row at an address nothing has, a record's own row shadowed by a newer row at its present address (B.2), a row by address at a reserved key | no | nothing can show it; deleting the picture empties the column (`ON DELETE SET NULL`) |

`seoMediaUsage()` (`seo-targets.ts`) returns every such use with a label
("Egypt — search and sharing image", "Site default share image") and a link
to the target on the SEO screen. `mediaUsage` — the **existing** guard, the
one the Media screen's delete calls — adds them, and the Media screen's
per-card count adds the same list, so the card and the refusal cannot
disagree. There is no separate SEO rule (brief §4).

The delete is atomic (F5c): `deleteMedia` locks the media row `FOR UPDATE`,
recounts every use **inside that transaction, on that connection**, deletes
only if there is none, and unlinks the files after the commit. The SEO rows
and the records' present addresses are read in **one statement**, so at one
moment: which row a record uses depends on both, and read in two, a move
committed in between could hide a use that every moment before and after it
had (C.3, W5³). An SEO save
that chooses a picture locks it `FOR KEY SHARE` before it writes (B.11), so
whichever of the two comes second sees the other: the delete is refused, or
the save is told the picture is gone. A record's own picture column is held
the same way by its foreign key. Both checks run inside the Server Actions;
nothing relies on what the browser was shown (brief §20).

The Media screen now **shows** the refusal under the picture's card ("Still in
use on 1 screen: Egypt — search and sharing image. Remove it there first.").
It was returned and never drawn, so a click on Delete for a picture in use did
nothing visible (C.3, N1).

### B.6 History: decision B

SEO records have no history, so no SEO share image can come back from a
restore. A page's own picture can — the four record pictures are share-image
fallbacks and the Visual Editor restores route versions. Those versions are
not protected (option A was rejected in Batch 22: a version table that pins
every picture it ever named makes nothing deletable). The rule is **B,
restore safely handles a missing asset**, as it already did: a route restore
skips a picture that is no longer in the library and names it in the result,
and a route publish refuses one. The SEO resolver now does the same at render
time: a share image that is missing (or an SVG) is skipped for the next
candidate rather than ending the chain (F5d) — so a site default that names a
picture deleted since falls through to the static picture.

### B.7 Renames, moves and deletions

Each writer that changes a record's address, or deletes a record, keeps its
SEO row in the same transaction, after the record's own row (`moveSeoRow`,
`dropSeoRows`):

| Writer | What happens to the SEO row |
|---|---|
| Destinations form changes the slug | the row the destination uses (B.2) moves to the new address, bound to its id: its own row — or, where that sits at another address beside a newer unbound row at the old one, the newer row, and its own is set aside to `~<row id>` (W3³, X4³); whatever held the new address is moved aside (`claimSeoKey`): to `#<id>` if it is bound to another live record, to `~<row id>` otherwise |
| Services form moves a service to another category | the same, with the new `<category>/<slug>` |
| Create a page, category, service, destination or package | whatever row holds the new address is moved aside (`freeSeoAddress`, through `claimSeoKey`), in the create's own transaction: to `#<id>` if it is bound to another live record — still that record's, still used for it — and to `~<row id>` otherwise (a row the previous release wrote for a record gone since, a row bound to a deleted record). The new record starts with nothing of either, under this release and under the previous one after a rollback, which reads by address (C.3, D1 and T8²) |
| Delete a destination, package, service or custom page | its bound row, and an unbound row at its address, are deleted with it — never a row by address at a reserved key, which is nobody's (B.2) |
| Delete a category (which deletes its services) | the category's rows and its services' rows are deleted with it. Its services are locked as they are listed: a service being moved out meanwhile is waited for and left out — the cascade does not take it either — so only records that really go take their rows (C.3, C1) |

Every one of them drops the `seo` cache tag after committing — the creates
included, or the cached rows would keep a row the create had moved aside live
on the new record's page for up to an hour (C.3, R6²). Nothing else is ever
deleted: a row in the way is moved aside, never removed. Old addresses
are not redirected — a renamed destination's old address answers 404 as it
always has (brief §13, "no invented redirects").

### B.8 The SEO screen

`/admin/seo` keeps its shape — a filter, one card per group, a row per target
opening an inline form — and gains the targets it lacked:

1. **Site defaults** — the default title, title template and description in
   both languages, the default share image and the X handle, **shown for
   reference** so each field's fallback can be read in full. There is no form
   (C.4, F6k); `saveSeoDefaults`, which no screen called, is removed.
2. **Pages** — the homepage first (at `/`), then every CMS page.
3. **Overviews** — Services (`/services`) and Tour packages (`/packages`), with
   a line saying their visible wording is the Visual Editor's.
4. **Service categories**, **Services** (each labelled with its category),
   **Destinations**, **Travel packages** (each with its destination).

Every row shows its address and badges for **Unpublished** (with a sentence:
the record applies once the page is published), **Custom** (it has a record)
and **noindex**. The form shows the English and Arabic addresses and a link to
the screen that edits the page itself; it puts English and Arabic side by side
for the title, the description, the share title and the share description,
each with its fallback in its hint; the canonical, the share image and the
noindex switch are shared. The share-image picker offers raster pictures only
and warns under 1200×630. `?target=<reference>` opens and scrolls to one
target — the link the media guard's uses and the Visual Editor carry — and
opens nothing for a reference the screen does not list.

The form and its result banner stay mounted across a save, and only the fields
are keyed by the base (the Services, Packages and Destinations pattern), so
"SEO saved." stays readable while the fields are drawn again from the stored
record.

### B.9 Saving: signed base, field by field

Each form is drawn with a **signed base** (`src/lib/admin/form-base.ts`, the
Batch 23/24 mechanism; `src/lib/seo-form.ts`) whose purpose names the target
kind (`seo-<kind>-form-base`) and whose id is the target's id, so a base
drawn for one target cannot be posted for another — not another record, not
the other overview, not a package with a destination's id. Every field is its
own unit. `saveSeo`:

1. `guardAction("seo.manage", form)` — session, CSRF token, permission;
2. refuses a post with no base as out of date before reading anything else: a
   form drawn by the previous release names its page by type and address and
   posts no base (C.3, T1); then parses the reference (refused: "That page
   could not be identified.") and reads the base for that kind and id
   (refused: "This form is out of date…");
3. refuses a share-image id that is not a whole positive number;
4. decides, before reading anything, whether the form changed anything at all
   ("No changes to save."), and validates the canonical if it changed (B.15);
5. in one transaction, in the order of B.11: takes the target's lock, **loads
   the target from its own table** by id (refused if it no longer exists:
   "That page no longer exists…"), locks and checks the picture it is about to
   name (exists, not an SVG), locks the target's own rows, and decides unit by
   unit — an untouched field is never written (the stored row is read through
   the posted form's own reader, so a canonical the previous release kept as
   `/about/` is untouched while it is left alone: X1³); a changed one is written while
   the stored value is still the base, counts as done when it already equals
   the submission, and is a conflict otherwise; any conflict refuses the whole
   save with the fields named;
6. updates the row it uses — binding it and setting its key to the present
   address, after setting aside the record's other row if it has two (its own
   row left at an old address, shadowed by a newer one, B.2) — or inserts one,
   after moving aside whatever held that address (`claimSeoKey`: a row bound
   to another live record to `#<its id>`, anything else to `~<row id>`). An insert that
   loses to a writer outside these locks (the previous release, in the deploy
   window) is a conflict, not an error;
7. logs `seo.updated` (entity `seo`, the **reference** as its id, the label and
   address in the summary, `{ fields, address }` as metadata — no values), and
   drops the `seo` tag.

**Remove override** (`clearSeo`) is held to the same base: it removes the row
only while every field is still what the form was drawn with, and names the
fields that moved otherwise; a row it shadowed is set aside with it, or it
would come back as the page's record; a record already gone answers "There was no
override to remove." and logs nothing; a removal logs `seo.cleared`. A form
drawn by the previous release posts no base and is refused as out of date
(step 2), like every Batch 23/24 form (B.16). A type, key or id the browser
sends beside the reference is never read: both are derived from the record.

### B.10 The Visual Editor

The editor does not edit SEO (one source of truth, brief §8). Its header has
an **SEO** link beside Preview, for a role holding `seo.manage` only, opening
`/admin/seo?target=<reference>` for the page, overview or route being edited,
in a new tab; a dot and the accessible name say when the target has a record
of its own. The editor's drafts never reach metadata.

### B.11 Locks and their order

| Transaction | Takes, in order |
|---|---|
| SEO save / remove | the target's advisory lock (`pg_advisory_xact_lock`, one per reference — it also covers a target with no row yet, and the overviews, which have no record row) → the record's own row `FOR KEY SHARE`, **locked by itself**; its category or destination read after it, in a statement of its own → the picture `FOR KEY SHARE` (a save choosing one) → the target's SEO rows and the row holding the address the save takes, `FOR UPDATE` in one statement, in the order of their ids |
| Destination slug change, service move | the record row `FOR UPDATE` (as before) → its SEO rows and the row holding its new address, `FOR UPDATE` in one statement, in the order of their ids |
| Record create | the new record's row (its insert) → the row holding its address `FOR UPDATE` (`freeSeoAddress`) |
| Record delete | the record row (by the delete; a category `FOR UPDATE` first, then its services `FOR UPDATE` as they are listed) → its SEO rows |
| Media delete | the media row `FOR UPDATE` → reads only (the SEO rows and the records' addresses in one statement, B.5) → the referring rows by the foreign key's `SET NULL` |
| Deploy reconciliation | `seo_metadata` `EXCLUSIVE` — a write that has not touched the table waits for it; one under way is waited for, its own later statements going ahead of the queued lock; reads go on → reads of the record tables at one `REPEATABLE READ` snapshot, no row locks, and no picture: no row is updated twice where it shows one (B.3) |

Record before SEO row everywhere, and the picture before the SEO row; two
writers that each take a row the other holds — records whose rows hold each
other's addresses — lock every SEO row they need in one statement, in id
order, so one waits for the other (C.3, W1³); and the deploy's run never locks
a picture. So no two of these can wait on each other in a cycle. A `FOR KEY SHARE` on a record lets
nothing that locks it `FOR UPDATE` — the edit forms, a delete — proceed until
the SEO save has committed, and the save waits for them likewise.

The record is locked **alone**. Locked through a join with its category, a
save that waited for a move re-checked the moved service against the category
it had read before waiting, found no match, and answered "That page no longer
exists" — found by the stress run (C.3, N2) and covered by a deterministic
test since.

### B.12 Cache invalidation

All SEO rows are one cache entry under the `seo` tag, read by both languages
and every route. A save, a removal, a destination's new address, a service's
move, a record delete and a media delete drop `seo` after committing; the next
request reads the new value in both editions, with no restart and nothing else
uncached. Site settings are not cached across requests, so a change to the
site defaults is live at the next request.

### B.13 Sitemap and robots

Unchanged. The sitemap's publication rules are what they were, and an SEO
save never changes whether anything is published. It still lists an address
whose record says `noindex` (A.14 F6j — recorded, C.4). `robots.txt` keeps its
rules, including the disallowed renditions (C.4).

### B.14 Public and preview isolation

Public metadata reads published rows only. Two holes close:

- an **unpublished CMS page** gets no metadata of its own — its 404 carries
  neither its title nor its record, and neither does its editor's preview;
- **`/home`** keeps serving the homepage, with the homepage's metadata and `/`
  as its canonical, not a second indexable address.

A preview, the editor's canvas, Version Compare and component previews keep
the published metadata and the private headers they had (`X-Robots-Tag:
noindex, nofollow, noarchive`, `Cache-Control: private, no-store`); no
canonical carries a query, and the query parameters grant a visitor nothing.
In a private preview the page's JSON-LD, which is part of the page's body,
describes the draft being previewed, like the rest of the body; the public
page's never does.

### B.15 Security

- **Permission** — `seo.manage` for the screen and both SEO actions, checked
  inside each Server Action with the session's CSRF token (`guardAction`); a
  role without it is sent away from the screen and refused by both actions.
  The Visual Editor shows its link only with `seo.manage`. `deleteMedia` keeps
  `media.manage`.
- **Target** — the reference is parsed strictly; the record is loaded from the
  table its kind names, by id, inside the transaction; a page reference must be
  a `pages` row; singletons must be `:1`. A key or type from the browser is
  never written: both are derived from the record.
- **Base** — signed per kind and target id with a key derived from
  `AUTH_SECRET` (never a session or preview token); one changed character
  refuses it.
- **Share image** — a whole positive id, in the library and not an SVG,
  checked under the lock.
- **Canonical** — a page **of this site**: a path, or a full address on the
  site's own origin. Never another site, `//host`, a query string, a fragment,
  whitespace, a control character, a backslash, a `.` or `..` segment or a
  user name; at most 255 characters; and never an address that is not a page
  (`/admin`, `/api`, `/_next`, `/media`, `/search`, `/home`, also behind a
  language prefix or an escape). Every test runs on what a page would emit —
  the path decoded once and stripped of one language prefix — and that must
  then be final: anything a second decoding or a second prefix would still
  change (`%253F`, `%2523`, `%2F%2F`, `/ar/ar/…`, `/en/ar/…`) is refused, and
  so is an empty segment anywhere (`/en//search` is `//search` once its prefix
  is gone, and Next redirects any address with `//` in it), so the value
  checked, the value stored and the value drawn are one string (C.3, S1 and
  V1²). A trailing slash is dropped (`/about/` is stored and drawn `/about`,
  the address Next redirects it to). Stored without its language prefix, drawn in each edition's
  language, and checked again when a page is drawn, so a value stored before
  this release that would be refused today is ignored rather than emitted.
- **Leakage** — no draft, preview token or query parameter reaches a title,
  description, canonical, Open Graph or Twitter tag, public JSON-LD or the
  sitemap; refusals carry no internals.

### B.16 Rollback and tabs left open

The previous release, against this schema: ignores `entity_id`, `og_title_ar`
and `og_description_ar`; finds every record by its key — which this release
keeps current — so every override still applies, including the destination
and overview ones only this release can create, except a record whose row a
deploy left waiting at its `#<id>` (B.3 step 5), which shows its own content
until the next deploy puts the row back (C.4); shows the English share text
on `/ar`, and an English-only override's title on an Arabic page, as before
this release. A canonical stored by this release is a path without a language
prefix, so the previous release emits the English address for it. Its writes
are by key: a row it creates is used by address and bound at the next save or
deploy. The corners, each needing a rollback and a specific edit during it:

- an Arabic share text written before the rollback stays as it was while the
  English one is edited (the older release does not know the Arabic column);
- a record the older release moves and whose SEO it then saves, where nothing
  held the new address: the save writes a new row, which is used at once — by
  this release too (B.2) — and the next save or deploy sets the older one
  aside (B.3 step 2);
- the same, where another record's own row still held the new address (that
  record moved away earlier and its row stayed): the save goes into that row,
  which stays the other record's (C.4);
- a record the older release renames, after which it creates another record
  at the old address: during the rollback the new record shows the old one's
  row (by key); the next deploy gives the row back to its own record;
- a record the older release deletes, after which it creates or moves another
  record onto the deleted one's address: during the rollback the newcomer
  shows the deleted record's row (by key), and an SEO save there edits that
  row. What the next deploy does depends on the row: one bound to the deleted
  record — this release had bound it — is set aside, as every reader of this
  release treats a deleted record's row (B.3 step 1), and the newcomer shows
  its own content; one the older release wrote itself, by address, is unbound,
  nothing tells it from a row written for the newcomer, and it is bound to the
  newcomer — setting aside the newcomer's own row if the newcomer was moved
  there — exactly as both releases already show it (B.3 steps 2–3; C.4, D2³).

Rows this release has taken out of use are keyed `~<row id>`, so the older
release finds none of them at any address: a record it creates where one used
to be starts with nothing, and its first SEO save there writes a new row,
which the next deploy binds.

Admin pages and editor tabs left open across the upgrade: Next salts each
Server Action's id with a key that is random per build directory unless
`NEXT_SERVER_ACTIONS_ENCRYPTION_KEY` is set, and `deploy.sh` builds each
release in a fresh directory and sets none. So an old page or tab posts ids
the new build does not know: every save, load and publish from it — the SEO
screen's, an edit form's, the Visual Editor's — is answered as an unknown
action before any of this release's code runs, and writes nothing; the editor
says "The save could not be sent. Try again." Only with a key set, so that
ids survive a build, would an old post reach an action, and then: an SEO or
edit form drawn before the upgrade posts no signed base and is refused with
"reload", before the target is read (B.9 step 2); a Visual Editor tab keeps
saving without its region base values, as it always could (DEPLOYMENT.md,
*Admin pages and editor tabs left open across a release*; C.3, T7²).

### B.17 Not changed

- The Visual Editor's editing, Layers, Undo/Redo, drafts and history.
- Which pages exist or are published, the sitemap and `robots.txt`.
- The `/services` and `/packages` visible hero copy: it is the editor's, and
  their metadata is the SEO record's (brief §14).
- X1–X8 (A.14), recorded as follow-ups.

### B.18 Verification

| Where | What it proves |
|---|---|
| `tests/seo-model.test.ts` (26) | references; which row a target uses, the newer row by address included, and a row by address at a reserved key nobody's (W2³); each language on its own; canonical acceptance, storage and drawing — what a page would emit is what is checked (S1), empty segments refused and trailing slashes dropped (V1²) |
| `tests/seo-admin.test.ts` (45) | the 93 targets in order, the badges and `?target=`; saving every kind by reference, logged by reference; share-image and canonical validation; an untouched legacy canonical no edit, alone or beside another person's change (X1³); a legacy row bound in place; a service's move and a destination's new address carrying the record, dead rows moved aside and never inherited; a stale-keyed live row parked at `#id` by a create — past a key made by hand to look like it (V2²) — and put back, and parked by a first save (T4²); a save and a rename each taking an address the other's row holds, neither refused, in both id orders, each held by a gate the test opens (W1³, T2⁴, T3⁴); a hand-made row at a long-address service's `#<id>` passed by and set aside, by a save and by a create (W2³); a hand-made holder of a `~<id>` moved aside first, in a create and in a save (X3³); a newer row by address used by the page and the screen, a save and a removal setting aside the row it shadowed, `#id` given up on the way (D2, T6²); deletes taking records with them, a service moved out while its category is deleted keeping its record (C1); all five creates moving a dead row aside — an unbound one, with the cached rows already holding it, and a page published through its own form — the public page drawn without it at once (D1, R6², W4³); a form drawn before its record was deleted; permissions, CSRF, strict references, a browser-sent type or key ignored, bases replayed across records and kinds or altered, the previous release's form exactly as it posts (T1); two forms on one record (different fields, the same field, both orders, the same change, first inserts at once, a stale removal, a removal twice); a save that waited for a move (N2); the Visual Editor's link; the screen's exported actions |
| `tests/seo-metadata.test.ts` (24) | every route class in both languages; precedence; canonicals, alternates, robots, `/home`, `/en` redirect; share-image renditions, dimensions, card size, skipped SVG and missing default; TouristTrip and breadcrumb unchanged by a record; unpublished pages and previews; the sitemap and `robots.txt` — its sitemap at its own origin, and that origin the pages' whenever the build was given one (a build given none, CI's, leaves the pages naming the server's runtime address, which a prerendered file cannot know); no Arabic alternate or share locale while Arabic is off (F6n); a change live at the next request |
| `tests/seo-media.test.ts` (14) | the brief §4 lifecycle on the real delete: a record's share image, the site default, a shared picture, an unpublished page's record, a legacy row; records no page uses protect nothing, a row shadowed by a newer one included (T3); a deleted record releases its picture; authority; the delete/save race in each forced order and left free; a move committed while the delete counts hides no use (W5³) |
| `tests/seo-reconcile.test.ts` (26) | every row state the previous release can leave, through the real migrate script, settled to what this release shows, with the exact counts logged (T4, T5²); dead rows — a deleted record's, one naming no record, one at the address of a record with none — set aside, never bound (R1², R3²); `#<id>` keys given up, and the record's row following it on its next move (D3); an open save of the previous release waited for (C2), and an open save of this release that has locked its row waited for without a deadlock (L1²); a record moved mid-run settled at the run's snapshot (L2²); hand-made reserved keys set aside first (V2²) — a row by address at a long-keyed record's own `#<id>` among them, never bound, the record's own row moving there (T1⁴) — and rows made by hand to hold each other's `~<id>` set aside once, under the run's own key, and left there by the next run (R1⁴); a row set aside out of the previous release's sight, its next save starting a new row (R2²); a delete holding the pictures of rows the run moves and sets aside does not hold it up, and rows that swapped addresses swap back in one run — or, all showing pictures, wait at `#<id>` for the next (D1³); nothing deleted; a second run changes nothing |
| `tests/media-pipeline.test.ts` | an EXIF-rotated upload stored, sized and rendered at its upright size (M2) |
| `tests/schema-compat.test.ts` | the previous release's own SEO upsert and delete against this schema |
| `tests/mutation-audit.test.ts` | `clearSeo` by reference, held to the base |
| browser `seo-media` (17) | brief §28's sixteen steps in Chromium, and no page error |
| stress `seo-media-concurrency` (11) | M1–M7 under contention with public reads throughout; afterwards every page shows its record, no row is bound to a gone record or mis-keyed, and the server wrote no failure |

---

## Part C — the state at the end of Batch 25

### C.1 Route by route

| Route | Target | Record | Its own words (fallback) | Share image after the record's | Edited where |
|---|---|---|---|---|---|
| `/` (and `/home`, canonical `/`) | `page:<home id>` | bound to the page | none: the site defaults | site default | SEO screen, Pages |
| `/<slug>` (CMS page) | `page:<id>` | bound to the page | its title (EN, AR) | site default | SEO screen; the page itself on Pages / Visual Editor |
| `/services` | `serviceIndex:1` | `page/services`, by key | its fixed title and sentence, EN and AR (`seo-defaults.ts`) | site default | SEO screen; visible copy in the Visual Editor |
| `/packages` | `packageIndex:1` | `page/packages`, by key | its fixed title and sentence, EN and AR | site default | SEO screen; visible copy in the Visual Editor |
| `/services/<category>` | `category:<id>` | bound | title; summary, else tagline — per language | the category's picture | SEO screen; Categories / Visual Editor |
| `/services/<category>/<service>` | `service:<id>` | bound; follows a move | title; introduction (plain text) | the service's picture | SEO screen; Services / Visual Editor |
| `/packages/<destination>` | `destination:<id>` | bound; follows a new address | name; summary | the destination's picture | SEO screen; Destinations / Visual Editor |
| `/packages/<package>` | `package:<id>` | bound | title; summary; TouristTrip and breadcrumb unchanged | the package's picture | SEO screen; Packages / Visual Editor |
| `/search` | none | — | "Search" / "البحث"; always `noindex` | site default | — |
| 404, error pages, `/media`, `/api`, `robots.txt`, `sitemap.xml` | none | — | — | — | — |

Every row of the table: canonical at the page's own address in its language
unless an acceptable override names another page of the site; `en`, `ar` and
`x-default` alternates; the share image's real size; both editions live at the
next request after any save.

### C.2 Decisions

- **Identity** is the record's id (`entity_id`), beside the address key, which
  stays current for the previous release (B.2, B.3).
- **History**: decision B — a restore and the renderer skip a missing picture;
  versions do not pin pictures (B.6).
- **Unpublished records** protect their pictures (B.5).
- **One share image** for both languages; Arabic has its own share title and
  description (B.4).
- **Canonicals** name a page of this site only (B.15).
- **Overviews**: metadata from the SEO record, visible copy from the Visual
  Editor (brief §14).
- **Site defaults**: shown, not edited, in this batch (C.4).

### C.3 Findings — final disposition

| # | Disposition |
|---|---|
| F5a | fixed — share images of records some page uses are counted, in the guard and on the library card (B.5) |
| F5b | fixed — the site default share image is counted (B.5) |
| F5c | fixed for every writer that names a picture through a foreign key (the SEO record and the four record pictures): one transaction, the picture locked, the uses recounted under the lock; the jsonb writers are a recorded follow-up (C.4) |
| F5d | fixed — a missing or SVG candidate is skipped for the next (B.6); a media delete drops the `seo` tag |
| F6a | fixed — destinations are targets |
| F6b | fixed — both overviews are targets |
| F6c | fixed — records are bound by id; renames and moves carry the row, deletes take it, dead rows are never inherited (B.2, B.7) |
| F6d | fixed — a reference must name an existing record of its kind (B.9) |
| F6e | fixed — signed base, field by field (B.9) |
| F6f | fixed — each language on its own, Arabic share text, localized canonicals (B.4) |
| F6g | fixed — canonicals name a page of this site only, checked on save and on render (B.15) |
| F6h | fixed — an unpublished page's 404 and preview carry nothing of its record (B.14) |
| F6i | fixed — `/home` carries `/`'s metadata and canonical (B.14) |
| F6j | **recorded, not changed** — the sitemap still lists an address marked noindex (C.4) |
| F6k | **recorded, not changed** — the site defaults are shown read-only; their form is a later batch (C.4) |
| F6l | fixed: real dimensions, the small-card rule, no SVG as a share image, the orphan `saveSeoDefaults` removed; **recorded**: `robots.txt` disallows the renditions a card names (C.4) |
| F6m | fixed — an overlong address is keyed `#<id>` and found by id (B.2) |
| F6n | fixed — `og:locale:alternate` only while Arabic is on (B.4) |
| N1 | found and fixed in this batch — the Media screen never drew a refused delete's reason (B.5) |
| N2 | found by the stress run and fixed — a save that waited for a service's move read the service as deleted (B.11) |
| C1 | found by the adversarial review and fixed — a service moved out of a category while the category was deleted lost its record: the delete now locks the services as it lists them (B.7, B.11) |
| C2 | found by the review and fixed — reconciliation could decide on a table the previous release changed between two statements: it now locks the table first (B.3) |
| S1 | found by the review and fixed — a doubly encoded canonical (`%253F`, `/ar/ar/…`) passed the check and was emitted decoded: what a page would emit is what is checked (B.15) |
| M2 | found by the review and fixed — an EXIF-rotated upload was stored, and declared as a share image, with its sideways size: the upright size is stored and used for the rendition cutoff. Pictures uploaded before Batch 25 keep the size they were stored with (C.4) |
| D1 | found by the review and fixed — a record created at a dead row's address left the row there for a rollback to apply: every create moves it aside (B.7) |
| D2 | found by the review and fixed — runtime and reconciliation chose differently between a stale bound row and a newer row by address: one rule, `preferredSeoRow` (B.2) |
| D3 | found by the review and fixed — a detached row could keep a `#<id>` key and make a later re-key a duplicate: the key is given up on detach (B.2) |
| T1 | found by the review and fixed — the previous release's form was told "That page could not be identified": a post with no base is refused as out of date first, and the test posts that form exactly (B.9) |
| T2 | found by the review and fixed — the forced-order tests waited for a lock in any database: the barrier is this test's own database |
| T3 | found by the review and fixed — the media guard indexed only rows naming a picture (B.1) |
| T4 | found by the review and fixed — reconciliation could rewrite rows and log "nothing to reconcile": every statement is counted (B.3) |
| M1, T5, T6, T7 | raised by the review and refuted by its verification. M1 is recorded as a limitation (C.4); T7's test was added anyway (B.18) |
| L1² | found by a second review, of the corrections above, and fixed — the deploy's `SHARE ROW EXCLUSIVE` table lock let the run past a row an SEO write of this release had locked and not yet written, and each then waited for the other: the lock is `EXCLUSIVE` (B.3, B.11) |
| L2², R5², T2² | fixed — a record the previous release moved between two of the run's statements could still stop the deploy on a duplicate key: the run reads every record at one `REPEATABLE READ` snapshot (B.3) |
| R1², R4², T1² | fixed — the deploy bound a dead row to a record with none of its own (one the seed or the previous release created at its address, one whose override had just been removed), though no reader of this release used it: that step is gone, and every row taken out of use is keyed `~<row id>`, out of both releases' sight (B.2, B.3) |
| R2² | fixed where the previous release's save lands on an address this release emptied — it starts a new row, which wins and is bound (B.16); a save that lands in another record's own row stays with that record: recorded (C.4) |
| R3² | fixed — a row bound to a record deleted since replaced a moved record's own row at the next deploy: it is set aside like every dead row (B.3 step 1) |
| R6² | fixed — the creates dropped no `seo` tag, so a row they moved aside stayed live on the new page from the cache (B.7) |
| V1², T3² | fixed — an empty segment behind a language prefix (`/en//search`) passed the canonical check and was drawn: any `//` is refused, and a trailing slash is dropped (B.15) |
| V2² | fixed — a reserved key written by hand through the previous release's form could stop the deploy or fail a create: such rows are set aside first (B.2, B.3 step 0); a chain of them can still fail one write until the next deploy (C.4) |
| T4², T5², T6² | fixed — tests that could not fail: a first save's own claim of a held address, a move that only parks, and the runtime set-aside of a `#<id>` key each have one now |
| T7², T8² | fixed — documentation: old tabs and per-build action ids (B.16, DEPLOYMENT.md, `services-form-concurrency.md` §11); what a create does with another live record's row (B.7) |
| D1³ | found by a third review, of the corrections above, and fixed — the deploy's run updated a row twice in one transaction, so PostgreSQL checked its share image again, locking the picture after the SEO table, the opposite order to a media delete: no row that shows a picture is updated twice, and rows that swapped addresses and all show pictures wait at `#<id>` for the next run (B.3, B.11) |
| W1³ | fixed — a save and a move each taking an address the other's row held could deadlock: the row holding the address a write takes is locked with the writer's own, in one statement in id order (B.11) |
| W2³, X5³ | fixed — a row by address at a reserved key was used at runtime and adopted by a save, while the deploy set it aside: it is nobody's everywhere, and a create at a long address clears its `#<id>` (B.2) |
| W5³ | fixed — the media guard read the SEO rows and the records' addresses in two statements, so a move between them could hide a use: one statement (B.5) |
| X1³ | fixed — a canonical the previous release kept as `/about/` read as an edit on every save: the stored value goes through the posted value's reader (B.9) |
| W4³, X2³, X3³ | fixed — tests that could not fail: three of the five creates against a primed cache, and a hand-made holder of a `~<id>` at a set-aside, each have one now (B.18) |
| D2³, W3³, X4³, X6³ | fixed — documentation: a row the previous release wrote by address for a record it deleted is bound to whatever holds the address (B.3, B.16, C.4, DEPLOYMENT.md); a move carries the row the record uses, and a shadowed row protects no picture (B.5, B.7); who waits for whom under the deploy's lock (B.3, B.11) |
| R1⁴ | found by a fourth review, of the final diff, and fixed — rows made by hand to hold each other's `~<id>` were set aside under the run's own key, then moved again and logged again by the next deploy: that key is final (B.3 step 0) |
| B1⁴ | fixed — documentation: a record whose row waits at its `#<id>` shows its own content during a rollback, which B.16 and DEPLOYMENT.md said no override would (B.16) |
| T1⁴ | fixed — a test that could not fail: step 0's `#<id>` arm, which keeps the deploy from binding a hand-made row at a long-keyed record's own key, has one now (B.18) |
| T2⁴, T3⁴ | fixed — tests: W1³'s save-side half is held by a test with the claimed row first in id order, and both W1³ tests hold the rename by a gate the test opens rather than a two-second sleep (B.18) |
| T4⁴ | fixed — documentation: B.18 described a move parking a row at `#<id>`, which only a ring now does (B.3 step 5) |
| X1–X8 | recorded, unchanged (A.14) |

### C.4 Known limitations, recorded

- **F6j** — the sitemap lists addresses whose record says `noindex`. Listing a
  page while asking engines not to index it is contradictory but harmless: the
  page's own `noindex` wins. Changing the sitemap was left out of this batch.
- **F6k** — the site defaults (default title, template, description, share
  image, X handle) have no form. They are read-only on the SEO screen; the
  default share image is protected while it is set.
- **Renditions behind `robots.txt`** — a share image's 1600 rendition lives at
  `/media/<stem>@1600.webp`, which `robots.txt` disallows for every crawler;
  link-preview crawlers that honour it (X's does) may show no picture. As
  before Batch 25; a crawler group of its own for the preview fetchers was
  considered and left for a later batch.
- **jsonb writers and the media delete** — page sections, reusable components
  and Visual Editor route drafts store picture ids in jsonb, take no lock on
  the picture, and so can still name a picture in the moment between the
  delete's recount and its commit. The delete is atomic against every writer
  that names a picture through a foreign key (C.3 F5c).
- **Arabic where the page has none** — an Arabic page with no Arabic title of
  its own (a custom page, the homepage) shows an English-only record's title
  rather than the Arabic site default (B.4); the screen's hint says so. CMS
  pages have no description of their own in either language, so on **every**
  Arabic CMS page an English-only record description is shown rather than the
  Arabic default description (C.3, M1) — the order B.4 gives, and what the
  previous release did too.
- **Rollback edits that land in a row this release does not give the page**
  (B.16) — during a rollback the previous release reads and writes rows by
  address only. An SEO save there, on a record it created or moved onto a
  deleted record's address, edits the deleted record's row in place. If this
  release had bound that row to the deleted record, the next deploy sets it
  aside, and the record shows its own content until its SEO is saved again
  (the edit is kept in the table, not shown) (R3²). If the older release wrote
  that row itself, by address, the next deploy binds it to the record — the
  deleted record's title, description and noindex included, as both releases
  showed them — setting aside the record's own row if it was moved there
  (D2³). A save on a record it moved onto an address another record's own row
  still holds edits that row, which stays with its own record (R2²).
- **Rows that swapped addresses, each with a share image** — the deploy leaves
  them at their records' own `#<id>` keys (B.3 step 5): this release finds them
  by id, so nothing it shows changes, and the next deploy, or the record's next
  save or move, puts them at their addresses. Until then the previous release,
  after a rollback, reads by address and shows those records their own content.
  Only records the previous release swapped, in the deploy window or a
  rollback, can form such a ring (D1³).
- **Reserved keys made by hand, in a chain** — a write that is about to use a
  reserved key moves one row that holds it by hand aside; if that row's own
  `~<row id>` is also held by hand, the write fails with a generic error and
  writes nothing. Only hand-made requests to the previous release's form, in
  the deploy window, can build such a chain, and the next deploy clears it
  (V2²).
- **Sizes stored before Batch 25** — a picture uploaded earlier with an EXIF
  rotation keeps the sideways width and height it was stored with (C.3, M2);
  uploading it again stores the upright size. No backfill was run.
- **Preview JSON-LD** describes the draft being previewed — private, never
  stored, never public (B.14).
- **Rollback corners** — B.16.
- **X1–X8** — A.14.
