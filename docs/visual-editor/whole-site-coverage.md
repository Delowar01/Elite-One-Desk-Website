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
