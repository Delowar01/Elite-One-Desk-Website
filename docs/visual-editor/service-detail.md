# Visual Editor — service-detail routes (Batch 22)

Batch 21 opened the service-category route (`/[lang]/services/[category]`) in
the Visual Editor through a route adapter; its design of record is
`docs/visual-editor/dynamic-routes.md`. Batch 22 opens the route one level
down — one service's own page, `/[lang]/services/[category]/[service]` —
through the same adapter, extended rather than copied.

This document has two parts. **Part A** is the service-detail model exactly as
it stood at `02ce7dc` (main after the Batch 21 + 21A merge), written before any
source file changed, as the brief's §1 requires. **Part B** is the design of
record for what Batch 22 adds.

---

## Part A — the service-detail model as found (`02ce7dc`)

### A.1 Storage

| Table | What the service page reads from it |
|---|---|
| `services` | Almost the whole page: one row per service. |
| `service_categories` | The service's category: its title (eyebrow, breadcrumbs, `serviceType` in JSON-LD), its slug (the address), its publication. |
| `service_subcategories` | Nothing on the detail page. The group only places the service's card on the category page. |
| `faqs` | The page's questions: the service's own (`service_id`) and its category's (`scope = 'category'`). |
| `media` | The hero picture (`services.image_id`), also the page's `og:image`. |
| `site_settings` | WhatsApp number and switch, the two disclaimers and their switch, the brand's legal name (JSON-LD provider). |
| `seo_metadata` | An optional override keyed `entity_type = 'service'`, `entity_key = '<category-slug>/<service-slug>'`. |
| `enquiries` | Written by the page's request form; `service_id` references the service (`ON DELETE SET NULL`) and `service_label` keeps its name. |
| `route_nodes`, `route_versions` | Batch 21's tables. No service-detail rows exist yet. |

`services`, column by column:

| Column | Type | Meaning |
|---|---|---|
| `id` | `serial` PK | The service's identity. A sequence value, never reused. |
| `category_id` | `int NOT NULL` → `service_categories.id` `ON DELETE CASCADE` | Its category. |
| `subcategory_id` | `int NULL` → `service_subcategories.id` `ON DELETE SET NULL` | Its group, which must be in the same category (the Services screen checks — `groupProblem`). |
| `slug` | `varchar(120) NOT NULL`, unique **with** `category_id` (`services_slug_idx`) | The last segment of the address. |
| `title_en` / `title_ar` | `varchar(190)`; English required | The page's `<h1>`, the last breadcrumb, `<title>`, JSON-LD `name`. |
| `intro_en` / `intro_ar` | `text` | The hero's lede, the meta description, JSON-LD `description` (plain, ≤ 300). |
| `body_en` / `body_ar` | `text`, sanitised rich text | "Overview". |
| `benefits`, `audience`, `requirements` | `jsonb` `[{ en, ar }]`, default `[]` | "Key benefits", "Who this is for", "Documents and requirements". |
| `process_steps` | `jsonb` `[{ en, ar, detailEn, detailAr }]` | "How the process runs". |
| `timeline_en` / `timeline_ar` | `varchar(190)` | The hero's "Indicative timeline" pill. |
| `notes_en` / `notes_ar` | `text`, sanitised rich text | "Important notes". |
| `form_preset` | `varchar(32)`: `general` / `travel` / `visa` / `business` / `iqama` | Which extra questions the request form asks. |
| `image_id` | `int NULL` → `media.id` `ON DELETE SET NULL` | The hero picture. |
| `is_featured` | `bool` | Category page ordering and site search ranking. Not used on the detail page. |
| `is_published` | `bool` | Whether the page exists for visitors. |
| `sort_order` | `int` | Order on the category page and in "Related services". |
| `created_at`, `updated_at` | `timestamptz` | |

**JSON and array fields.** The four lists hold no item identity — a row is its
position. The Services screen (`services/actions.ts`) rebuilds them on every
save: trimmed, English and Arabic ≤ 400 characters (steps: ≤ 200, details
≤ 800), a row whose English and Arabic are both empty dropped, at most 16 items
(steps: 10).

**English and Arabic.** Every text is a column pair or an `{en, ar}` item.
Arabic falls back to English at read time (`pick`); English never falls back to
Arabic. So a section with only Arabic content renders on the Arabic page only.

### A.2 The public route

`src/app/(public)/[lang]/services/[category]/[service]/page.tsx`. English at
`/services/<category-slug>/<service-slug>`, Arabic at `/ar/services/…` (the
middleware rewrites the root onto `/en`). `load()` finds the category by slug in
the cached, **published** catalogue (`getCatalog`: published categories,
published services, published groups — tag `catalog`), then the service by
slug among that category's published services. A miss consults
`serviceMove()` (`src/lib/taxonomy-moves.ts`: a static map of the 2026
restructure's retired addresses, consulted only when the database does not have
the slug) for a 308, and is otherwise a 404. No `generateStaticParams`: every
public route renders per request (the CSP nonce).

What it draws, top to bottom — each block only when its field is non-empty:

1. **Hero** (`<section>`): the category's title as an eyebrow link to the
   category page; the title (`<h1>`); the intro; two buttons — "Request this
   service" (dictionary `common.requestService`) to `#request` on the same page,
   and WhatsApp (when switched on in settings, with a message naming the
   service); the timeline pill (clock icon, "Indicative timeline:", the value);
   the picture (4:3).
2. **Breadcrumbs**: Home › Services › category › service.
3. **Main column**: Overview (rich text); Key benefits (checked list); Who this
   is for (pills); Documents and requirements (list); How the process runs
   (numbered steps, title and detail); Important notes (rich text, boxed);
   Frequently asked questions (accordion); the disclaimers. The section
   headings are dictionary words (`service.overview` … `service.faq`).
4. **Aside**: "Request a service" and its line (dictionary `form.heading`,
   `form.subheading`) above the enquiry form — every published category and
   service, the service's preset, this service pre-selected.
5. **Related services**: up to four other published services of the same
   category, in catalogue order, each a link; heading `common.relatedServices`.
6. **JSON-LD**: `BreadcrumbList` (the trail); `FAQPage` when any question is
   shown; `Service` — `name` (title), `serviceType` (category title),
   `description` (plain intro, ≤ 300), `areaServed`, `provider` (legal name
   and site URL).

**Questions.** `getFaqs()` (published only, ordered `sort_order, id` across
all scopes), filtered to `service_id = this service` **or** `scope = category
AND category_id = this category`. The two kinds interleave by their own
`sort_order`. The seed has only global questions, which never appear here.

**Disclaimers.** The government notice when
`settings.disclaimers.showOnServicePages`; the visa notice when `/visa/i`
matches the service's slug or its category's slug. A pre-existing rendering
rule on slugs; it decides wording, not editing.

**Calls to action.** The services table has no CTA column. The primary button is
the dictionary's wording pointing at the page's own form; WhatsApp is the
site's. `form_preset` decides the form's extra questions.

**Metadata.** `generateMetadata` → `buildMetadata` with the canonical path,
`entityType 'service'`, `entityKey '<category>/<service>'`, the title, the
plain intro as description, the service picture as `og:image`, `type:
article`; an SEO-screen override wins. It reads the same published catalogue.

### A.3 Related records

Category (eyebrow, breadcrumbs, related list, JSON-LD); sibling services
(related list, request form); questions (own and the category's); the media
library (picture); site settings (WhatsApp, disclaimers, legal name); enquiries
(written by the form). No package or destination record appears on a service
page.

### A.4 Visibility and ordering

| Flag | Effect on the service page |
|---|---|
| `services.is_published = false` | 404 for visitors; also off the category page, search, sitemap and request form. |
| `service_categories.is_published = false` | Every service page in it is a 404 (`load` reads published categories only). |
| `service_subcategories.is_published = false` | **No effect** on the detail page. A service in a hidden group keeps its page and stays in its siblings' "Related services"; only the category page's grouped listing hides it. Existing behaviour, preserved. |
| `faqs.is_published = false` | The question is not shown. |

Order: services by `sort_order, id`; questions by `sort_order, id` across
scopes; list items by array position.

### A.5 Addresses, moves, renames, deletion

* **Slug.** Lower-case words joined by hyphens, set when the service is created.
  `updateService` never reads the slug: the "Address" input on the edit form is
  shown, but a change to it is ignored on save (pre-existing; recorded here,
  not changed in this batch). A category's slug is likewise fixed at creation.
  **The application has no slug-change flow for a service.**
* **Category move.** The Services screen's Category select: `updateService`
  writes `category_id` on the same row. The unique `(category_id, slug)` index
  refuses a move into a category that already uses the slug (the form reports
  the failure). The 2026 restructure script moves services the same way, in
  place. After a move the old address is a 404 unless the static move map names
  it — and that map only names the 2026 restructure's addresses. A move creates
  no redirect.
* **Rename.** English or Arabic title: an update of the same row.
* **Deletion.** `deleteService` deletes the row; its own questions cascade;
  enquiries keep their label and lose the reference. Deleting a category
  cascades to its services.

**Identity verdict (brief §3).** The application never gives a service a new
semantic identity on a rename, a category move or — since it never changes a
slug after creation — a slug change: `services.id` survives all of them, and
the restructure script keeps it too. So the service's editor identity is
`services.id`, with no change to the data model, and nothing here requires the
batch to stop.

### A.6 Caching and revalidation

| Loader | Tag | Dropped by |
|---|---|---|
| `getCategories`, `getServices`, `getSubcategories` | `catalog` | Services, Service Categories screens; route publication |
| `getFaqs` | `faqs` | FAQs screen; route publication |
| `getMediaMap` | `media` | Media library |
| `getSettings` | `settings` | Settings screens |
| `getSeo` | `seo` | SEO screen |
| `publishedPresentations` (Batch 21) | `routes` | Route publication |

All `unstable_cache` with a one-hour revalidate. Pages render per request, so a
dropped tag is visible on the very next request.

### A.7 Admin flows

Services screen (`/admin/services`, `/admin/services/[id]`, `services.manage`):
every column above, create, update, publish toggle, delete. FAQs screen
(`faqs.manage`): scope, attachment, wording, order, publication. SEO screen:
the per-service override.

### A.8 Schema verdict (brief §29)

`route_nodes.owner_key` and `route_versions.route_key` are `varchar(64)`
with no foreign key, enum or check: owner and route keys are application
vocabulary. A service route (`service:<id>`) and its regions fit the Batch 21
tables as they are. **No migration is needed.**

### A.9 Every service-detail route in the test fixtures

The fresh seed — the database every integration test and browser probe
starts from — holds 74 services in 5 categories: `travel-tourism` 26
(`travel-holiday` 14, `visa-services` 12), `business-setup` 14,
`iqama-services` 13, `license-renewal` 6, `government-relations` 15. All are
published and filed in a group; all have English and Arabic titles and an
English intro; none has a body, a list, a step, a timeline, notes or a picture;
the 6 seeded questions are global, so none appears on a service page. Each
address below also exists under `/ar` (148 addresses).

| id | English address | group |
|---|---|---|
| 1 | `/services/travel-tourism/air-ticket-booking` | travel-holiday |
| 2 | `/services/travel-tourism/hotel-reservation` | travel-holiday |
| 3 | `/services/travel-tourism/international-tour-packages` | travel-holiday |
| 4 | `/services/travel-tourism/holiday-packages` | travel-holiday |
| 5 | `/services/travel-tourism/airport-transfer` | travel-holiday |
| 6 | `/services/travel-tourism/cruise-booking` | travel-holiday |
| 7 | `/services/travel-tourism/travel-insurance` | travel-holiday |
| 8 | `/services/travel-tourism/customized-travel-itinerary` | travel-holiday |
| 9 | `/services/travel-tourism/family-tour-packages` | travel-holiday |
| 10 | `/services/travel-tourism/group-tour-packages` | travel-holiday |
| 11 | `/services/travel-tourism/corporate-travel-services` | travel-holiday |
| 12 | `/services/travel-tourism/attraction-and-activity-tickets` | travel-holiday |
| 13 | `/services/travel-tourism/honeymoon-packages` | travel-holiday |
| 14 | `/services/travel-tourism/professional-tour-guide` | travel-holiday |
| 15 | `/services/travel-tourism/schengen-visa-assistance` | visa-services |
| 16 | `/services/travel-tourism/usa-visit-visa-assistance` | visa-services |
| 17 | `/services/travel-tourism/uk-visa-assistance` | visa-services |
| 18 | `/services/travel-tourism/canada-visa-assistance` | visa-services |
| 19 | `/services/travel-tourism/australia-visa-assistance` | visa-services |
| 20 | `/services/travel-tourism/japan-visa-assistance` | visa-services |
| 21 | `/services/travel-tourism/tourist-visa-processing` | visa-services |
| 22 | `/services/travel-tourism/visit-visa-services` | visa-services |
| 23 | `/services/travel-tourism/visa-documentation-support` | visa-services |
| 24 | `/services/travel-tourism/visa-appointment-assistance` | visa-services |
| 25 | `/services/travel-tourism/visa-application-form-assistance` | visa-services |
| 26 | `/services/travel-tourism/travel-insurance-for-visa` | visa-services |
| 27 | `/services/business-setup/investor-license-assistance` | investor-business-setup |
| 28 | `/services/business-setup/investor-license-consultation` | investor-business-setup |
| 29 | `/services/business-setup/investor-eligibility-assessment` | investor-business-setup |
| 30 | `/services/business-setup/investor-documentation-support` | investor-business-setup |
| 31 | `/services/business-setup/investor-license-application-assistance` | investor-business-setup |
| 32 | `/services/business-setup/business-setup-consultation` | investor-business-setup |
| 33 | `/services/business-setup/transportation-activity-support` | investor-business-setup |
| 34 | `/services/business-setup/tga-business-setup-consultation` | investor-business-setup |
| 35 | `/services/business-setup/business-consultation` | investor-business-setup |
| 36 | `/services/business-setup/company-registration-assistance` | company-formation-registration |
| 37 | `/services/business-setup/transport-company-setup-consultation` | company-formation-registration |
| 38 | `/services/business-setup/company-formation-documentation` | company-formation-registration |
| 39 | `/services/business-setup/business-registration-support` | company-formation-registration |
| 40 | `/services/business-setup/transportation-company-formation` | company-formation-registration |
| 41 | `/services/iqama-services/iqama-issuance-assistance` | khidamat-iqama |
| 42 | `/services/iqama-services/iqama-renewal-assistance` | khidamat-iqama |
| 43 | `/services/iqama-services/iqama-transfer-sponsorship-transfer-support` | khidamat-iqama |
| 44 | `/services/iqama-services/profession-change-assistance` | khidamat-iqama |
| 45 | `/services/iqama-services/exit-and-re-entry-services` | khidamat-iqama |
| 46 | `/services/iqama-services/final-exit-services` | khidamat-iqama |
| 47 | `/services/iqama-services/family-dependent-iqama-services` | khidamat-iqama |
| 48 | `/services/iqama-services/employee-documentation-services` | khidamat-iqama |
| 49 | `/services/iqama-services/muqeem-services` | khidamat-iqama |
| 50 | `/services/iqama-services/qiwa-services` | khidamat-iqama |
| 51 | `/services/iqama-services/absher-business-services` | khidamat-iqama |
| 52 | `/services/iqama-services/labor-related-documentation-support` | khidamat-iqama |
| 53 | `/services/iqama-services/passport-and-residency-documentation-support` | khidamat-iqama |
| 54 | `/services/license-renewal/tga-license-renewal-assistance` | license-permit-renewal |
| 55 | `/services/license-renewal/transportation-license-renewal` | license-permit-renewal |
| 56 | `/services/license-renewal/operating-permit-renewal` | license-permit-renewal |
| 57 | `/services/license-renewal/compliance-documentation-for-renewal` | license-permit-renewal |
| 58 | `/services/license-renewal/investor-license-renewal-assistance` | license-permit-renewal |
| 59 | `/services/license-renewal/premium-residency-renewal-assistance` | license-permit-renewal |
| 60 | `/services/government-relations/premium-residency-consultation` | premium-residency |
| 61 | `/services/government-relations/eligibility-assessment` | premium-residency |
| 62 | `/services/government-relations/document-preparation` | premium-residency |
| 63 | `/services/government-relations/application-assistance` | premium-residency |
| 64 | `/services/government-relations/investment-residency-guidance` | premium-residency |
| 65 | `/services/government-relations/business-owner-residency-guidance` | premium-residency |
| 66 | `/services/government-relations/real-estate-owner-residency-guidance` | premium-residency |
| 67 | `/services/government-relations/special-talent-residency-guidance` | premium-residency |
| 68 | `/services/government-relations/family-residency-guidance` | premium-residency |
| 69 | `/services/government-relations/tga-license-consultation` | tga-services |
| 70 | `/services/government-relations/vehicle-registration-guidance` | tga-services |
| 71 | `/services/government-relations/driver-documentation-support` | tga-services |
| 72 | `/services/government-relations/operating-permit-assistance` | tga-services |
| 73 | `/services/government-relations/compliance-documentation-support` | tga-services |
| 74 | `/services/government-relations/transportation-activity-government-support` | tga-services |

---

## Part B — design of record

*(Written with the implementation; see below.)*
