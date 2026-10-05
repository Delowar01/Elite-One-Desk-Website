# Visual Editor — whole-site coverage (Batch 24)

Batches 16–22 put the CMS pages, the service-category pages and the service
pages inside the Visual Editor. Batch 24's brief is the operator's own
sentence — *control the complete customer-facing website through the Visual
Editor* — and it asks for proof rather than inference: every public template
inventoried, classified, and either opened in the editor or explained there.

This document has three parts. **Part A** is the site as found at `2e611c6`
(main after the Batch 23 merge), written before any source file changed.
**Part B** is the design of record for what Batch 24 adds. **Part C** is the
route-by-route coverage table at the end of the batch.

**Definition of covered** (brief §2). A page is covered only if every
meaningful business-controlled region on it is one of:

1. selectable and editable in the Visual Editor;
2. editable through a global control the Visual Editor surfaces (the Globals
   drawer); or
3. selectable in the Visual Editor and **explained** there as generated or
   read-only, with where it comes from.

A separate admin form somewhere else does not count.

---

## Part A — the public site as found (`2e611c6`)

### A.1 Every public route

Read from the application tree (`src/app`), not from navigation or the
sitemap. English is served at the root (`/about`); the middleware rewrites it
onto `/en` internally and answers `/en/…` with a 301 to the root. Arabic is
`/ar/…`, and exists for every template below while
`settings.features.arabicEnabled` is on (the layout 404s `/ar` otherwise).

| File | Address | What answers |
|---|---|---|
| `(public)/[lang]/layout.tsx` | every public page | Header, footer, floating WhatsApp, analytics, skip link |
| `(public)/[lang]/page.tsx` | `/` | CMS page `home` |
| `(public)/[lang]/[...slug]/page.tsx` | `/<slug>` (one segment) | Any other CMS page: `about`, `contact`, `privacy`, `terms`, `disclaimer`, and every page an admin creates |
| `(public)/[lang]/services/page.tsx` | `/services` | The services overview |
| `(public)/[lang]/services/[category]/page.tsx` | `/services/<category>` | A service category (Batch 21) |
| `(public)/[lang]/services/[category]/[service]/page.tsx` | `/services/<category>/<service>` | A service (Batch 22) |
| `(public)/[lang]/packages/page.tsx` | `/packages` | The tour-packages catalogue |
| `(public)/[lang]/packages/[slug]/page.tsx` | `/packages/<slug>` | **A destination or a package** — one segment shared by two tables, destination first |
| `(public)/[lang]/search/page.tsx` | `/search?q=` | Site search |
| `(public)/[lang]/not-found.tsx` | any unknown address | 404 |
| `(public)/[lang]/error.tsx` | any render failure | Error boundary |
| `app/sitemap.ts`, `app/robots.ts` | `/sitemap.xml`, `/robots.txt` | Generated |
| `app/media/[...path]/route.ts` | `/media/…` | Library files |
| `app/api/enquiries/route.ts` | `POST /api/enquiries` | The enquiry form's endpoint (not a page) |

There is no other catch-all. `[...slug]` refuses any multi-segment address,
so a path that matches none of the routes above is a 404.

The fixture database every test and probe starts from holds 6 CMS pages,
5 categories, 74 services, **5 packages** (`cairo-and-giza-classic`,
`nile-cruise-luxor-aswan`, `red-sea-sharm-el-sheikh`, `egypt-family-programme`
in the destination `egypt`, and `custom-itinerary` in none) and **1
destination** (`egypt`).

### A.2 Coverage before Batch 24

Classes, from the brief: **A** fully editable in the Visual Editor; **B**
partially editable; **C** not editable but showing owner-controlled content;
**D** generated or system-only, editing intentionally unnecessary; **E**
read-only utility.

| Template | Class | Why |
|---|---|---|
| `/` (CMS `home`) | **B** | Every section is editable. Four of its thirteen blocks — the service grid, the video showcase, testimonials, the FAQ — draw cards from records managed on other screens; a click on one selects the section, whose Inspector edits only the heading and says nothing about where the cards come from. |
| `/about`, `/contact`, `/privacy`, `/terms`, `/disclaimer`, any admin-created page | **A** | Sections only. The legal pages are ordinary CMS pages (`page-hero` + `rich-text`). The FAQ block on `/contact` has the same unexplained cards as on the homepage (**B** there). |
| `/services` | **C** | Not in the editor at all. Its heading is a source literal; its introduction and meta description are source literals chosen by taxonomy state; the category rows are drawn from category, group and service records. |
| `/services/<category>` | **A** | Batch 21. One defect: its `ItemList` structured data lists services in a hidden group, which the page does not show (A.9 F4). |
| `/services/<category>/<service>` | **A** | Batch 22. |
| `/packages` | **C** | Not in the editor. Eyebrow, heading and introduction are source literals; destination group titles and package cards come from records; "View packages", "Build your own" and its introduction are dictionary words. |
| `/packages/<package>` | **C** | Not in the editor. Every visible field is the package row's, edited only on the Packages screen; the highlights heading is a source literal. |
| `/packages/<destination>` | **C** | Not in the editor. Title, summary and picture are the destination row's; the package cards are the packages'. |
| `/search` | **E** | A query form and generated results; its words are the site's interface dictionary, shared with the header's search. |
| Header, footer, floating WhatsApp | **A** (through the Globals drawer) | Menus, brand, contact, WhatsApp, disclaimers, feature switches and social links are all in the Visual Editor's Globals drawer (saved live, by design). Footer interface words ("Contact", "Follow us", "All rights reserved") are dictionary UI; the footer's descriptive line is a dictionary sentence (A.8). |
| 404, error boundary | **D** | System pages. The 404 cannot read the request's language; the error boundary must render when nothing else can. |
| `/sitemap.xml`, `/robots.txt`, `/media/…`, `/api/enquiries` | **D** | Generated or not pages. |

### A.3 Packages and destinations as found

#### Storage

`package_destinations` — the destination a package is filed under:

| Column | Type | On the site |
|---|---|---|
| `id` | serial PK | identity |
| `slug` | varchar(120), unique | `/packages/<slug>`; **changeable** on the Destinations screen |
| `title_en` / `title_ar` | varchar(190), English required | destination page `<h1>` and `<title>`, its group heading on `/packages`, the category hub's list |
| `summary_en` / `summary_ar` | text (form limit 2,000) | destination page lede, meta description |
| `image_id` | → `media` `ON DELETE SET NULL` | destination page picture, `og:image` |
| `sort_order` | int | order of destinations |
| `is_published` | bool | page exists, group shown |

`travel_packages` — one package:

| Column | Type | On the site |
|---|---|---|
| `id` | serial PK | identity |
| `slug` | varchar(120), unique | `/packages/<slug>`; set at creation — `updatePackage` never writes it |
| `region` | enum, **legacy** | grouping only while no destination holds a package |
| `destination_id` | → `package_destinations` `ON DELETE SET NULL`, nullable | which destination group it is in |
| `title_en` / `title_ar` | varchar(190), English required | card title, page `<h1>`, `<title>`, JSON-LD `name` |
| `destination_en` / `destination_ar` | varchar(120) | the place label (map pin) on the card and the page, JSON-LD `touristType` — free text, not the destination row |
| `duration_en` / `duration_ar` | varchar(80) | the clock label on the card and the page; deliberately free text |
| `summary_en` / `summary_ar` | text (form limit 2,000) | card summary, page lede, meta description, JSON-LD `description` |
| `body_en` / `body_ar` | text, sanitised rich text (form limit 20,000) | page body |
| `highlights` | jsonb `[{ en, ar }]` (form: ≤ 16 rows of ≤ 300) | "What the programme includes" |
| `image_id` | → `media` `ON DELETE SET NULL` | card and page picture, `og:image` |
| `is_featured` | bool | featured first in every listing |
| `is_published` | bool | page exists, card shown |
| `sort_order` | int | order |

**There is no itinerary, inclusion, exclusion, price, gallery or notes
field.** The brief lists those as examples; the schema has none of them, so
none is invented here.

#### Public rendering

* **`/packages`** (`packages/page.tsx`) reads `getPackageCatalog()`: published
  packages (featured first, then `sort_order`, `id`) and published
  destinations. *Destination mode* — a published destination holding a
  published package — groups the cards under each destination's title with a
  "View packages" link to `/packages/<destination>`, then a "Build your own"
  group (dictionary heading and introduction) for packages in no destination
  or in an unpublished one. Without destination mode it falls back to the
  legacy `region` grouping with source-literal region labels.
* **`/packages/<slug>`** (`packages/[slug]/page.tsx`) asks for a **published
  destination** with the slug first, then a **published package**; anything
  else is a 404. A destination renders `DestinationView`: eyebrow "Tour
  packages" (dictionary), title, summary, picture, breadcrumbs, its packages'
  cards, a "Destinations" link back. A package renders its hero (the
  "Packages" eyebrow link, title, place, duration, summary, "Request a
  service" button to `#request`, WhatsApp), breadcrumbs, body, highlights
  under a source-literal heading, and the enquiry form (dictionary heading and
  line, preset `travel`).
* **Structured data**: a package page emits `BreadcrumbList` and
  `TouristTrip` (`name`, `description` from the summary, `touristType` from
  the place label). The destination page and `/packages` emit none.
* **Elsewhere**: the `packages-grid` page block (cards for every package or
  one destination's), the category page's Tour Packages panel (destination
  names), search (packages, not destinations), and the sitemap (`/packages`,
  destinations holding a package, every published package).

#### Caching

`getPackages` and `getDestinations` are `unstable_cache` under the
`packages` tag, revalidated hourly; the Packages and Destinations screens drop
the tag on every write. Pages render per request (the CSP nonce), so a
dropped tag shows on the next request.

#### Admin screens and how they save

`/admin/packages`, `/admin/packages/[id]`, `/admin/packages/destinations`,
`/admin/packages/destinations/[id]`, all behind `packages.manage`.

* **`updatePackage`** reads every field from the form and runs
  `UPDATE travel_packages SET <all 16 fields>` — no base, no transaction, no
  comparison. It is exactly the Services form before Batch 23 (A.9 F1).
* **`updateDestination`** does the same for every destination field **and its
  slug** (A.9 F2).
* Create, publish toggle and delete read the row and act on it. Deleting a
  destination sets its packages' `destination_id` to null (they become
  "Build your own"); deleting a package deletes the row.
* A slug is refused if the *other* table holds it, checked from both screens,
  because the two share `/packages/<slug>`.

#### Identity, renames, moves, deletion

* A package's identity is `travel_packages.id`. A rename is an update of the
  row; reassigning it to another destination is an update of
  `destination_id`; its slug never changes after creation. **No package ever
  gets a new identity.**
* A destination's identity is `package_destinations.id`. Its **slug can
  change** on the Destinations screen; the old address then 404s (there is no
  redirect, and none is invented here).
* Deleting either deletes the row; ids are serial and never reused.

#### Media

`mediaUsage()` (the library's delete guard) counts a package's picture, but
**not a destination's** (A.9 F3).

#### Search and SEO

Search indexes published categories, services, packages and FAQs — not
destinations, not CMS pages. The SEO screen offers overrides for pages,
categories, services and packages — not destinations, and not the `/services`
or `/packages` overviews, which are not rows in `pages`.

### A.4 `/services` as found

* Eyebrow: dictionary (`sections.servicesEyebrow`).
* Heading: **source literal** ("Everything you need, handled from one desk").
* Introduction and meta description: **source literals**, one pair for the
  legacy six-category taxonomy and one for the restructured five, chosen by
  `isLegacyTaxonomy` so the sentence follows the data.
* Breadcrumbs: generated.
* One row per published category: icon, its number, title (a link), summary
  (or tagline), "Learn more" (dictionary), "N services" (generated), its
  picture, and its published services as links under their group names. All
  of it is the category's, its groups' and its services' — content already
  edited on those pages in the Visual Editor.

### A.5 `/search` as found

Heading, input placeholder, button, "no results" and its hint are dictionary
words (`nav.search`, `nav.searchPlaceholder`, `common.noResults`,
`common.noResultsHint`) shared with the header's search box; the result count
is a generated sentence; the results are generated from published records.
`noindex`.

### A.6 Global chrome as found

The Globals drawer (`globals-panel.tsx`, Batch 18–19) edits, live and with the
ordinary admin actions and their permissions: the header and footer menus,
brand (site name, tagline, legal name), contact, WhatsApp, disclaimers,
feature switches and social links. Footer words that are interface
(column titles, "Follow us", "Contact", "All rights reserved") are dictionary
UI. The footer's descriptive line — "One desk for travel, business setup and
government-related support in Saudi Arabia." — is a dictionary sentence
(`footer.builtLine`), separate from the brand tagline setting.

### A.7 Page blocks that draw records managed elsewhere

| Block | Its cards come from | Editable in the section |
|---|---|---|
| `service-grid` | categories and their groups | eyebrow, title, intro |
| `packages-grid` | packages (optionally one destination's) | eyebrow, title, intro, destination, limit |
| `testimonials` | Testimonials screen | eyebrow, title |
| `video-showcase` | Videos screen | eyebrow, title, intro, category, limit |
| `faq` | FAQs screen | eyebrow, title, scope |

None of their cards carries an editor address. A click on one selects the
section; the Inspector shows the section's own fields and nothing about the
cards' source. That is not dead, but it is not *explained* either (A.9 F7).
`travel-feature`, `destination-feature`, `featured-service` and `quick-links`
store every word they show and are fully editable.

### A.8 Hard-coded customer-visible copy

| Where | String | Source |
|---|---|---|
| `/packages` | "Travel & tourism" / "السفر والسياحة" (eyebrow) | literal |
| `/packages` | "Prepared itineraries, built to be changed" (heading) | literal |
| `/packages` | "Start from a prepared programme or ask for one…" (introduction) | literal |
| `/packages` | "View packages", "Build your own" and its introduction, "No results" | dictionary |
| `/packages` | region labels Egypt / International / Holiday / Corporate | literal (legacy mode only) |
| `/packages`, `/services` | `<title>` and meta description | literal |
| package page | "What the programme includes" (highlights heading) | literal |
| package page | "Packages" (eyebrow link), "Request a service", "WhatsApp us", form heading and line | dictionary |
| destination page | "Tour packages" (eyebrow), "Destinations" (link back), "No results" | dictionary |
| package card | "View details" | literal |
| `/services` | heading; introduction and meta description (two variants) | literal |
| footer | descriptive line | dictionary |
| 404 | "All services", "Business setup", "Travel packages", "Contact us" | literal (English on both editions) |
| error boundary | heading, sentence, buttons | literal |

### A.9 Findings

| # | Finding | Severity |
|---|---|---|
| F1 | `updatePackage` writes the whole row. A Packages form opened before a Visual Editor publication would put the old values back — the Batch 23 defect, waiting for package publication to exist. | Must fix before package pages publish (brief §9). |
| F2 | `updateDestination` writes the whole row, slug included. Same defect for destination publication. | Same. |
| F3 | A destination's picture is not counted by the media library's delete guard: a picture used only as a destination's can be deleted as unused, and the foreign key silently clears it. | Media safety (brief §12); fixed here. |
| F4 | The category page's `ItemList` lists every published service of the category, including those in a hidden group that the page does not show. | Narrow correctness bug (brief §22); fixed here. |
| F5 | SEO share images — a page's override (`seo_metadata.og_image_id`) and the site default (`settings.seo.ogImageId`) — are not counted by the delete guard either. | Outside the editor; recorded as a release follow-up. |
| F6 | The SEO screen has no destination entries and no entries for the `/services` and `/packages` overviews, although `buildMetadata` reads overrides for them. | SEO architecture is out of scope (brief §21); recorded. |
| F7 | Five page blocks show records managed elsewhere with no explanation in the editor. | Coverage (brief §2); fixed here. |

### A.10 Schema verdict

`route_nodes.owner_key` and `route_versions.route_key` are `varchar(64)`
without a foreign key, enum or check: they are application vocabulary. New
route kinds and region types fit the Batch 21 tables as they are. **No
migration is needed.**

---

## Part B — design of record

### B.1 Four more route kinds

Batch 21's machinery — a route adapter, drafts in `route_nodes`, a reviewed
and atomic publication, versions, Compare, Restore — opened the category
page; Batch 22 opened a service's page through a second adapter. Batch 24
adds four adapters to the same interface (`RouteAdapter`,
`src/lib/routes/adapter.ts`). Nothing above the adapters changes shape:
drafts, publish, discard, restore, history, compare, the Inspector, Layers,
style, motion, media and permissions are the shared code.

| Route kind | Route key | Page | Identity |
|---|---|---|---|
| `package` | `package:<travel_packages.id>` | `/packages/<package>` | the package row |
| `destination` | `destination:<package_destinations.id>` | `/packages/<destination>` | the destination row |
| `packageIndex` | `packageIndex:1` | `/packages` | one per site |
| `serviceIndex` | `serviceIndex:1` | `/services` | one per site |

The two overviews are singletons: their key carries the id `1` because the
key grammar requires one, and their adapters accept no other.

### B.2 Regions

Owner codes are append-only (`owners.ts`); 22–38 follow Batch 22's 21.

**A package's page** — every region keyed by the package's id:

| Owner | Code | Edits | Generated |
|---|---|---|---|
| `packageHero` | 22 | title, place, duration, summary (column pairs), picture; the request button's wording (copy) | the "Packages" link, WhatsApp |
| `packageCrumbs` | 23 | — | the trail; never moves |
| `packageBody` | 24 | the body (rich text) | — |
| `packageHighlights` | 25 | heading (copy), the highlights list | — |
| `packageRequest` | 26 | heading and introduction above the form (copy) | the form |

**A destination's page** — keyed by the destination's id:

| Owner | Code | Edits | Generated |
|---|---|---|---|
| `destinationHero` | 27 | eyebrow (copy), title, summary, picture | — |
| `destinationCrumbs` | 28 | — | the trail |
| `destinationPackages` | 29 | the link back's wording (copy) | the package cards, the empty state |

**The catalogue, `/packages`**:

| Owner | Code | Edits | Generated |
|---|---|---|---|
| `packageIndexHero` | 30 | eyebrow, heading, introduction (copy) | — |
| `packageIndexCrumbs` | 31 | — | the trail |
| `packageIndexCatalogue` | 32 | — | the legacy region headings, the empty state |
| `destinationGroup` | 33 | the destination's title; its link's wording (copy) | the link's destination |
| `packageCard` | 34 | title, place, duration, summary, picture, featured; destination and shown (structural) | "View details" |
| `packageIndexCustom` | 35 | "Build your own" heading and introduction (copy) | — |

**The services overview, `/services`**:

| Owner | Code | Edits | Generated |
|---|---|---|---|
| `serviceIndexHero` | 36 | eyebrow, heading, introduction (copy) | — |
| `serviceIndexCrumbs` | 37 | — | the trail |
| `serviceIndexCategories` | 38 | — | every category row: its title, summary, picture, services |

Layers names them as the page reads: *Package page → Hero, Breadcrumbs, Body,
Highlights, Request*; *Tour packages → Hero, Breadcrumbs, Catalogue → Egypt
→ cards…, Build your own → cards…*. A generated node is selectable, carries
the style (and where safe the motion) its capability allows, is never typed
into and never drafted; the Inspector says where it comes from and links to
the screen that controls it.

### B.3 Identity

* A package is `travel_packages.id`, a destination `package_destinations.id`.
  A rename, a new picture, a package moved to another destination, and a
  destination's **slug change** are all updates of the same row: the route
  key, every region key, the drafts, the presentation and the history follow
  the record. The address is computed from the current slug at every read and
  is never stored by the editor.
* A package's slug is fixed (A.3). A destination's slug changes on the
  Destinations screen; its old address then 404s, as it always has — no
  redirect is invented. An editor already open on that destination keeps the
  same document; its canvas finds the page at the new address after a reload.
* Deleting a package or a destination leaves its `route_nodes` and
  `route_versions` rows dormant: no route can load them, the editor no longer
  offers the record, its page and preview are a 404, and serial ids are never
  reused. A catalogue card or group whose record is gone is removed from the
  catalogue's stored regions at its next publication or discard.
* The editor lists every package and destination from the database on every
  load, so a package created after the build is editable the moment it
  exists. Nothing in the editor or route sources names a seeded package or
  destination (a test greps for every one).

### B.4 What is stored where

Every value an Inspector field or a direct edit writes is a **column of the
record**, with the limits the Packages and Destinations screens apply (title
190 with English required; place 120; duration 80; summary 2,000; body
20,000 of sanitised rich text; highlights ≤ 16 rows of ≤ 300; a picture
that exists), or **template copy** stored on the region's own
`route_nodes.copy`, empty meaning the site's standard wording *in that
edition* — Arabic copy never falls back to English copy.

Not editable in the Visual Editor, and ignored if a request names them: a
package's slug, its legacy `region`, its sort order; a destination's slug,
sort order and publication. They are identity and structure, kept on the
Packages and Destinations screens. A package's destination and whether it is
shown are structure the catalogue's card offers to a role that may change the
page's structure (`content.structure`), exactly as a service card offers its
group and its visibility; its featured flag is the card's own content, as a
service card's has been since Batch 21.

**Two pages, one record.** A package's columns are edited on its own page
(`packageHero`) and on its catalogue card (`packageCard`); a destination's
title on its page (`destinationHero`) and on its catalogue group
(`destinationGroup`). Each draft carries its own `base`, so whichever is
published second finds the column moved and is refused as a conflict, keeping
its draft to resolve (keep mine / use the live value). The cards on a
destination's page are generated — each one is owned by the catalogue, so two
routes never own one region.

### B.5 Rendering

The four templates draw every region through `regionOf` and decide their
answer through the shared table (`route-view.ts`): a visitor gets the
published page from the cached loaders and the cached presentation, with no
editor attribute, no draft and no bridge; `?preview=1` with `content.view`
draws the drafts; an authorised canvas draws every region, a hidden card
dimmed, an empty section as a placeholder. `/packages/<slug>` keeps its rule
— destination first — in every mode: a visitor's lookup is among published
rows, a private one among all rows, and the admin still refuses a slug the
other table holds.

Structured data describes the published package to a visitor; a preview's
`TouristTrip` describes the draft it shows (private, `noindex`, never cached);
`<title>` and the meta description are always the published ones.

### B.6 Publish, discard, restore

One transaction each, the shared code (`publish.ts`). What each adapter
locks, `FOR UPDATE`, before the route's regions:

| Route | Locks |
|---|---|
| `package:<id>` | the package row |
| `destination:<id>` | the destination row |
| `packageIndex:1` | every destination, then every package, each set in id order — a group writes its destination, a card its package, and a re-filed card moves between two destinations |
| `serviceIndex:1` | nothing but its regions — it writes only template copy |

Every writer takes destinations before packages and both before
`route_nodes`; the Packages and Destinations forms (B.8) lock one row, and the
Packages form, when it files a package under another destination, holds that
destination (`FOR KEY SHARE`) before the package — the foreign key would
otherwise take it after, the catalogue's order reversed (C.5). No two of them
can wait on each other in opposite orders. After the commit: the
`packages` tag (and `catalog` where services are concerned), the `routes`
tag, the admin paths; the activity log files the publication under the
package, the destination, or the route for the two overviews.

### B.7 Permissions

| Action | Needs |
|---|---|
| Open, read a region, summary, history, compare | `content.view` + `visual_editor.view` |
| A package's or destination's words or picture, the catalogue's wording | `content.edit` + `packages.manage` |
| A card's featured flag | `content.edit` + `packages.manage` (as a service card's) |
| A card's destination, shown/hidden | `content.structure` + `packages.manage` |
| The services overview's wording | `content.edit` + `services.manage` |
| Style / motion | `content.style` (+ `content.advanced_style`) / `content.motion` |
| Publish, discard, restore | `content.publish` + the capability of every region the drafts or the version change |

Every action re-checks the session and the CSRF token on the server. The
region a server action is asked about must belong to the route it names (the
IDOR check), as for every route.

### B.8 The Packages and Destinations screens

They keep saving live. Because a package or destination is now also
published from the Visual Editor, their update actions get the Batch 23
treatment (`docs/admin/services-form-concurrency.md`): the edit page signs a
per-field base; the update reads the row `FOR UPDATE`, writes only the
fields the form changed, refuses — whole, with nothing written — a field
changed elsewhere since the form was opened, and logs and drops caches only
after the commit. A destination's slug is one of its fields. This is two
forms that share fields with the editor, not an admin-wide change.

### B.9 Media

The library's delete guard counts a package page's, a catalogue card's and a
destination page's draft picture while the record exists
(`routeDraftMedia`), and a destination's published picture (A.9 F3).

### B.10 Page blocks drawing records managed elsewhere (A.9 F7)

A page block whose cards come from another screen declares where, once, on
its definition (`BlockDef.live`). The Inspector shows that sentence and the
screen's link whenever the section is selected — which is what a click on one
of its cards selects. The stored values do not change and nothing new is
saved.

### B.11 Template copy, decided

| String | Now | Class |
|---|---|---|
| `/packages` eyebrow, heading, introduction | catalogue template copy, literal fallback | editable template copy |
| "View packages" | the group's copy, dictionary fallback | editable template copy |
| "Build your own", its introduction | template copy, dictionary fallback | editable template copy |
| Legacy region labels | literal | generated (legacy mode only) |
| Highlights heading | template copy, literal fallback | editable template copy |
| Request button, form heading and line on a package page | template copy, dictionary fallback | editable template copy |
| "Packages" eyebrow link, breadcrumbs, "WhatsApp us", "View details" | unchanged | system UI / generated |
| Destination page eyebrow, "Destinations" link | template copy, dictionary fallback | editable template copy |
| `/services` eyebrow, heading, introduction | overview template copy; fallbacks as today (the introduction still follows the taxonomy) | editable template copy |
| Footer descriptive line | brand setting (Globals drawer, Site settings), dictionary fallback per edition | editable global copy |
| Search's words | unchanged | global interface dictionary |
| `/packages` and `/services` `<title>` and description | unchanged | SEO defaults (A.9 F6) |
| 404 and error boundary | unchanged | system pages |

### B.12 Not changed

No migration. The editor protocol (version 7), the page CMS and its
sections, and Batches 21–23's draft, publication and conflict rules on
category and service pages. Two corrections found while building reach every
editor, and are recorded in C.5: a card's words can be typed on the canvas
again (F8 — a category page's service cards included), and Layers keeps the
keyboard's place through a redraw (brief §23). The Visual Editor still never
creates or deletes a package or a destination — that is the Packages
screen's.

---

## Part C — coverage at the end of the batch

### C.1 Every public template, route by route (brief §18)

English is served at the root and Arabic under `/ar/` for every template
below while `settings.features.arabicEnabled` is on; the Visual Editor opens
both editions of every editable one (its language switch reloads the canvas
on the real `/ar` route, with the same addresses). The first table is what a
page is made of; the second is what the editor does with it.

| Template | EN | AR | Data source | Visual Editor | Selectable regions |
|---|---|---|---|---|---|
| `/` (CMS `home`) | ✓ | ✓ | `pages`, `page_sections`; five blocks also draw cards from other records (categories, packages, videos, testimonials, FAQs) | the page editor (Batches 5–19) | every section and every node it marks — headings, text, buttons, pictures, list rows; a live block's card selects its section |
| `/<slug>` — `about`, `contact`, `privacy`, `terms`, `disclaimer`, every admin-created page | ✓ | ✓ | the same | the page editor | the same |
| `/services` (overview) | ✓ | ✓ | its template copy (`route_nodes`, `serviceIndex:1`); every row is a category's, its groups' and its services' | route kind `serviceIndex` (24) | Hero, Breadcrumbs, Categories |
| `/services/<category>` | ✓ | ✓ | the category, its groups, services and questions; its copy (`category:<id>`) | route kind `category` (21) | Hero, Breadcrumbs, Body, Services (each group, each card), Hub, Questions (each question) |
| `/services/<category>/<service>` | ✓ | ✓ | the service row, its category's questions; its copy (`service:<id>`) | route kind `service` (22) | Hero, Breadcrumbs, Overview, Benefits, Audience, Requirements, Process, Notes, Questions, Notices, Request, Related |
| `/packages` (catalogue) | ✓ | ✓ | every destination and package; its copy (`packageIndex:1`) | route kind `packageIndex` (24) | Hero, Breadcrumbs, Catalogue → each destination's group → each package's card, Build your own → its cards |
| `/packages/<package>` | ✓ | ✓ | the package row; its copy (`package:<id>`) | route kind `package` (24) | Hero, Breadcrumbs, Body, Highlights, Request |
| `/packages/<destination>` | ✓ | ✓ | the destination row and its published packages; its copy (`destination:<id>`) | route kind `destination` (24) | Hero, Breadcrumbs, Packages |
| `/search?q=` | ✓ | ✓ | published categories, services, packages and FAQs; interface dictionary | none — read-only utility (E) | — |
| Header, footer, floating WhatsApp | ✓ | ✓ | settings: menus, brand (names, tagline, footer line), contact, WhatsApp, disclaimers, features, social links | the Globals drawer, opened from the editor | the drawer's fields |
| 404 (`not-found`) | ✓ | English on both | source literals | none — system (D) | — |
| Error boundary | ✓ | ✓ | source literals | none — system (D) | — |
| `/sitemap.xml`, `/robots.txt`, `/media/…`, `POST /api/enquiries` | — | — | generated / files / an endpoint | none — not pages (D) | — |

| Template | Editable fields | Generated or read-only (explained in the editor) | Style | Motion | Media | Draft | History |
|---|---|---|---|---|---|---|---|
| `/` and every CMS page | every field of every block; the layout (add, move, duplicate, hide, remove, restore); reusable components | the cards of the five live blocks — the Inspector names their screen and links to it (A.9 F7) | ✓ per device | ✓ | ✓ | section and layout drafts | page versions, Compare, Restore to draft |
| `/services` | eyebrow, heading, introduction (copy, each edition) | breadcrumbs; every category row — its title, summary, picture and services are the category's, edited on its own page | ✓ | ✓ (not the breadcrumbs) | — (no picture of its own) | ✓ | route versions, Compare, Restore to draft |
| `/services/<category>` | Batch 21's set: the category's words, icon, picture and button; groups' titles, summaries, order, visibility; cards' words, picture, featured, group, order, visibility; the template copy; questions, their order and visibility | breadcrumbs, links, counts, structured data | ✓ | ✓ | ✓ | ✓ | ✓ |
| `/services/<category>/<service>` | Batch 22's set: title, introduction, timeline, picture, overview, benefits, audience, requirements, steps, notes, the order of its questions, the template copy | breadcrumbs, notices, the request form, related services, structured data | ✓ | ✓ | ✓ | ✓ | ✓ |
| `/packages` | hero eyebrow, heading, introduction; a group's destination name and link wording; a card's title, place, duration, summary, picture, featured, destination and whether it is shown; "Build your own" heading and introduction | breadcrumbs, the legacy region headings, the empty state, "View details", where a link goes | ✓ | ✓ (not the breadcrumbs) | card picture | ✓ | ✓ |
| `/packages/<package>` | title, place, duration, summary, picture, the request button's wording, the description, the highlights heading and list, the request heading and introduction | breadcrumbs, the "Packages" link, WhatsApp, the enquiry form, structured data (`TouristTrip`) | ✓ | ✓ (not the breadcrumbs) | package picture | ✓ | ✓ |
| `/packages/<destination>` | eyebrow, title, summary, picture, the link back's wording | breadcrumbs, the package cards (the catalogue's — edited there), the empty state | ✓ | ✓ (not the breadcrumbs) | destination picture | ✓ | ✓ |
| `/search` | — | all of it (C.3) | — | — | — | — | — |
| Global chrome | menus, names, tagline, footer line (24), contact, WhatsApp, disclaimers, features, social links | interface words: column titles, "Follow us", "All rights reserved" | — | — | — | none: saved live, by V1 design | the activity log |
| 404, error boundary, generated files | — | all | — | — | — | — | — |

The remaining intentional limitation of each template is in C.8.

### C.2 Coverage before and after

| Template | Before (A.2) | After |
|---|---|---|
| `/` | B — four live blocks unexplained | **A** — every live block explains itself (F7) |
| CMS pages | A (`/contact` B, its FAQ block) | **A** |
| `/services` | C | **A** |
| `/services/<category>` | A, with F4 | **A** — F4 fixed |
| `/services/<category>/<service>` | A | **A** |
| `/packages` | C | **A** |
| `/packages/<package>` | C | **A** |
| `/packages/<destination>` | C | **A** |
| `/search` | E | **E** — decided (C.3) |
| Global chrome | A through the Globals drawer; footer line a dictionary sentence | **A** — the footer line is a brand setting per edition |
| 404, error boundary, generated files | D | **D** |

Every meaningful business-controlled region on every page is now selectable
and editable in the Visual Editor, editable through the Globals drawer it
opens, or selectable and explained there as generated, with its source.

### C.3 Search (brief §17)

`/search` stays generated and stays out of the editor. Its results are the
published records themselves — a result's words are edited where the record
is, and the page cannot contradict them; its count is derived; its heading,
placeholder, button and "no results" lines are the site's interface
dictionary, shared with the header's search box, translated per edition. A
second, page-level copy of those words would let the page and the header's box
say different things. It is `noindex`.

### C.4 Structured data (brief §21–22)

Public JSON-LD is built from published rows only: `TouristTrip` and the
breadcrumb on a package's page, the breadcrumb, `FAQPage` and `ItemList` on a
category page, `Service` and the breadcrumb on a service's page; the
catalogue, a destination's page and the services overview carry none of their
own. A preview's structured data describes the
draft it shows and is private (`noindex`, never cached); a visitor's never
carries a draft (`package-editor.test.ts`).

**The hidden-group `ItemList` (Batch 23's open item, A.9 F4) is fixed**, as
the narrow bug it was: the list was built from every published service of
the category, so a published service filed under a hidden group — which the
page does not draw — was still announced. It is now the cards the page draws
(`listedServices` in `category-model.ts`, one layout shared with the page via
`serviceLayout`), so the two cannot disagree again. Held by
`package-route-adapter.test.ts` (the rule) and `package-editor.test.ts` (the
served page).

### C.5 Found while building

* **F8 — a card's words could not be typed on the canvas** (since Batch 21).
  A double-click on a card title began a direct edit and ended it at once: the
  card is a link, the link took the focus, and the bridge ended every edit on
  any `focusout` in the document. The bridge now ends an edit only when the
  element being edited loses the focus (`editor-bridge.tsx`, `onEditBlur`).
  Held by `route-packages` (a package card and a category page's service card,
  typed on the canvas).
* **The Packages form's lock order.** A form re-filing a package took its
  package, then — through the foreign key — the new destination; the
  catalogue's publication takes every destination, then every package. Two
  such transactions deadlock: replayed against PostgreSQL, the publication is
  aborted with `40P01` every time. The form now holds the destination first
  (`FOR KEY SHARE`); both then commit, every round
  (`package-form-concurrency.test.ts`, stress `package-concurrency` P5).
* **A Layers control pressed from the keyboard lost the focus** with the
  rows the redraw removes — C.6.

### C.6 Layers through a redraw (brief §23)

Layers is drawn from the canvas's own report of its document, and every save
redraws the canvas: from the redraw until the new document reports in, the
tree has no rows (Batch 23, `2e611c6`).

* **The rows are not kept on screen in between — decided, not deferred.** Kept
  rows would describe the document being replaced: a Draft, Hidden or Locked
  badge that may no longer be true, an order a move has just changed, a card
  a re-file has just moved, and an address a click would send to a canvas that
  has not reported it. That is stale semantic data, which the brief rules out,
  and it is no smaller a change than the one below.
* **The keyboard's place is kept** (`layers-focus.ts`). When a redraw begins —
  or a layout step starts, since its buttons are disabled while it saves and a
  disabled button loses the focus at once — the editor notes which control had
  the focus: the row's address and which of its controls. When a panel has
  drawn its rows again, enabled, the focus goes back to that control, or to the
  row itself when the control is disabled there (a section moved to the top has
  no Move up), and only when nothing else has taken the focus in the meantime —
  a click into the Inspector or the canvas while the canvas came back was the
  person's own choice. Nothing is delayed or polled; the panels say when their
  rows are on screen. Both Layers panels — a page's and a route's — use it.
  Held by `inspector-focus` (a card hidden and shown again from the keyboard on
  Tour packages; a page's section moved down and back to the top) and by
  `direct-edit-readiness.test.ts`.
* The Inspector's focus through a redraw (Batch 23) is untouched: the two
  never compete, because the Layers focus is taken only when it is in Layers.
* What remains: for the length of a redraw (typically a few hundred
  milliseconds) the tree shows "Waiting for the canvas…" and has nothing to
  click, and a screen reader hears the focus leave and come back.

### C.7 Tabs and pages open across the upgrade (brief §11)

`docs/admin/services-form-concurrency.md` §11, and `DEPLOYMENT.md` §9 ("Admin
pages and editor tabs left open across a release") for the release note:
an edit page drawn before the upgrade is refused on save and needs one reload;
a Visual Editor tab opened before Batch 23 keeps working, can draft a value it
never changed until it is reloaded, and the conflict rules are not weakened to
accommodate it.

### C.8 Intentional remaining limitations

* **Records are created and deleted on their screens.** The Visual Editor
  edits packages, destinations, categories, services and questions; it never
  creates or deletes one. A package's address, legacy region and order, and a
  destination's address, order and publication, are the Packages and
  Destinations screens'.
* **A package page shows what the schema holds.** There is no gallery,
  itinerary, inclusions, exclusions or price in `travel_packages`, so there is
  none to edit; nothing was invented (brief §4).
* **Live block cards are edited on their own screens** — a homepage
  testimonial on Testimonials, a video on Videos. The editor says so and links
  there (F7); one record has one owner.
* **The cards on a destination's page are the catalogue's.** They are edited on
  Tour packages, where each card lives once.
* **A destination's new address does not redirect.** The old one is a 404, as
  it always was (B.3); no redirect is invented.
* **Globals save live** — no draft and no version history, by the V1 design;
  the activity log records each change.
* **The services overview's and the catalogue's `<title>` and meta
  description are SEO defaults**, and the SEO screen has no entries for them
  or for destinations (A.9 F6, a follow-up). SEO share images are not counted
  by the media library's delete guard (A.9 F5, a follow-up).
* **A direct edit of empty template copy starts empty.** The standard wording
  a field falls back to is shown on the page, but typing on the canvas begins
  from nothing rather than from that wording — as on service pages since
  Batch 22. The Inspector's field says that empty means the standard
  wording.
* **The 404 page is English on both editions** (it cannot read the request's
  language), and the error boundary is a source literal (it must render when
  nothing else can).
* **The list publish toggles and deletes** on the Packages and Destinations
  screens act on the row as it is (`services-form-concurrency.md` §10), as on
  the Services screen.
* **Layers is empty for the length of a redraw** (C.6).
* **A tab opened before the upgrade** behaves as C.7 says until it is
  reloaded.
