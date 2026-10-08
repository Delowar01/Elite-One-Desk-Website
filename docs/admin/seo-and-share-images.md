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
