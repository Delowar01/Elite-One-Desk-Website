# Visual Editor — dynamic routes (Batch 21)

Batch 21 extends the Visual Editor from `CMS page → sections → editable nodes`
to `public route → resources → editable nodes`, and makes the service-category
route (`/[lang]/services/[category]`) the first dynamic route the editor can
open. This document is the design of record: what is stored where, who may do
what, and what happens when two people disagree.

Nothing here replaces the page editor. Pages keep `pages` / `page_sections`,
their drafts, their layout draft, their history and their compare exactly as
Batch 16–19 left them. Every rule below is additive.

**Batch 22** opened the second route kind — a service's own page,
`/[lang]/services/[category]/[service]` — through the same adapter, now a
`RouteAdapter` interface (`src/lib/routes/adapter.ts`) with two
implementations. The category page's behaviour described here is unchanged;
the service page's design of record is
[`service-detail.md`](service-detail.md), Part B.

## 1. Vocabulary

| Term | Meaning |
|---|---|
| **Document** | What the editor opens: a CMS page (`pages` row) or a dynamic route. A category route's document key is `category:<service_categories.id>`. |
| **Route adapter** | Server code that knows one route kind: which owners it renders, where each field is stored, how a value is validated and how a draft is promoted. One adapter per route kind — never one per row. |
| **Owner** | One region of a route, bound to exactly one resource. It is the dynamic-route equivalent of a page section: it has a block definition, a root node, fields, a draft and a revision. |
| **Resource** | The record an owner edits: a `service_categories`, `service_subcategories`, `services` or `faqs` row, or the route's own template copy. |
| **Node** | One selectable element inside an owner, named by a relative path (`field:title`), exactly as inside a section. |

## 2. The category adapter

The category adapter is the only one in this batch, in two halves:
`src/lib/routes/category-model.ts` holds its rules with no database — which
owners a category has, where each field is stored, how a submitted value is
read and validated, what a patch is, when it conflicts, how a draft is drawn —
and `src/lib/routes/category.ts` adds the reads (`loadCategoryData`: four
queries, whatever the number of groups, cards and questions). It derives the
owners of a category route **from the database rows**, so every category —
Travel & Tourism, Business Setup, Iqama, License Renewal, Government
Relations, and any row created later — is editable with no code naming it.
`tests/route-adapter.test.ts` greps the Visual Editor and route sources for the
five production slugs and fails if one appears anywhere but `package-hub.ts`
(below).

| Owner type | Code | Block | Resource | Region on the page |
|---|---|---|---|---|
| `category` | 1 | `route-category-hero` | `service_categories` | Hero: icon, tagline, title, summary, background image, primary CTA, WhatsApp CTA |
| `categoryCrumbs` | 2 | `route-category-crumbs` | — (generated) | Breadcrumbs |
| `categoryBody` | 3 | `route-category-body` | `service_categories.body_*` | Category body |
| `categoryServices` | 4 | `route-category-services` | template copy | "Services" section: eyebrow, heading, group order, ungrouped order |
| `subcategory` | 5 | `route-subcategory` | `service_subcategories` | One group: title, summary, visibility, card order |
| `service` | 6 | `route-service-card` | `services` | One card: title, intro, image, group, featured, visibility |
| `categoryHub` | 7 | `route-category-hub` | template copy | Tour Packages panel (rendered where the route renders it) |
| `categoryFaqs` | 8 | `route-category-faqs` | template copy | FAQ section: eyebrow, heading, FAQ order |
| `faq` | 9 | `route-faq` | `faqs` (scope `category`) | One FAQ: question, answer, visibility |

The Tour Packages panel is rendered by the route for the category the route
has always given it to. That rule — the one place a slug is named — moved
verbatim out of the page into `hasPackageHub` (`src/lib/routes/package-hub.ts`),
and the page, the adapter and the editor all ask that one function, so the
panel is an owner exactly where the customer sees it and nowhere else. Giving
the panel to another category is a change to that rule, not to the editor.

### Route blocks

Each owner type has a block definition in `src/lib/routes/blocks.ts`. They use
the same `BlockDef` vocabulary as page blocks, so the Content tab
(`BlockEditor`), the Style and Motion capability models, Layers labels, Undo and
direct editing work on them unchanged. They are resolved through
`getEditorBlock()`, which the editor-side modules use; `getBlock()` — what the
page CMS uses to add, save, publish and restore sections — does not know them,
so a route block can never become a page section.

Elements that are shown but not edited as text are **generated fields** on
the route block (a field with `generated: { explain, source }`): the WhatsApp
button, the card link and its "Learn more", the card badge, the destination
list and the breadcrumb trail. A generated field is selectable, can carry the
style (and, where safe, motion) its capability allows, is never offered as an
input or to direct editing, and is never stored whatever a request sends. The
Inspector says, in a note, where its content comes from and links to the
screen that controls it; Layers labels it "Generated". Clicking one is never a
dead click. The breadcrumbs region is also `still`: it never takes motion.

## 3. Addresses and identity

The runtime address grammar is unchanged — `<owner>/<relative path>` — with
the owner now one of:

```
section:42/field:headline            a page section (unchanged)
category:3/field:title               the hero of category 3
service:12/field:intro               the card of service 12
faq:7/field:question                 FAQ 7
categoryHub:3/field:destinations     generated node inside the hub of category 3
```

Locale is never part of an address. The relative path is what styles and
motion are stored under, so a style binds to *resource and node identity*,
not to DOM position: retitling a service, re-ordering it or moving it to
another group does not move its style.

Inside the editor, buffers, Undo and Layers key owners by a number. A page
section's key is its id. A route owner's key is the negative number
`-(code × 10⁹ + id)` — a lossless encoding of `type:id`
(`src/lib/routes/owners.ts`). The two ranges cannot collide, a negative key can
never reach the section actions (they refuse ids ≤ 0), and the address the
canvas and the server exchange is always the readable `type:id` form.

## 4. Storage (migration `0006`)

Additive only. Two tables and one column.

### `route_nodes` — one row per owner that has presentation or a draft

| Column | Holds |
|---|---|
| `owner_key` (PK) | `service:12` |
| `route_key` | `category:3`, the route it was last edited on |
| `styles`, `motion`, `copy` | **Published** presentation: the StyleDocument, the MotionDocument and the template copy. These have no other home — they did not exist before this batch. |
| `draft_content` | **Unpublished** field patches: `{ "titleEn": { "value": "…", "base": "…" } }` |
| `draft_styles`, `draft_motion` | Unpublished presentation documents |
| `revision` | Optimistic-concurrency counter for this owner |
| `created_by`, `updated_by`, timestamps | Audit |

**One source of truth.** The published values of category, group, service and
FAQ content stay in their own tables; `route_nodes` never holds a copy of them.
`draft_content` holds only the fields an editor changed and has not published,
each with the published value it started from (`base`). An owner with nothing
pending and no presentation has no row. A row whose draft equals the live value
field for field is not pending (a patch equal to its live value is dropped on
save).

### `route_versions` — one row per route publication

`snapshot` is the route's published state after the publication (every
adapter field of every owner, plus styles, motion and copy); `changes` lists
each changed field with its before and after value; `created_by` and
`created_at` are the actor and the time. The first publication of a route also
records a baseline — the state before it — so the earliest state can be
compared and restored. The newest 30 are kept.

### `service_categories.cta_href`

`varchar(255) NOT NULL DEFAULT ''`. The hero's primary CTA used to be the
literal `/contact`; the destination is now the category's own data, editable
in the Visual Editor and in the Service Categories form, validated with the
page CMS's link rule. Empty means `/contact`, so every existing row renders
exactly as before.

## 5. Drafts

1. Content, style and motion edits write **only** `route_nodes.draft_*`, through
   the same debounced autosave the page editor uses (one request per pause, not
   per keystroke).
2. The public route reads published values: the domain tables and
   `route_nodes.styles / motion / copy`. Its one new query never selects a draft
   column.
3. The editor canvas and `?preview=1` (signed in, `content.view`) render the
   domain rows **with the drafts applied**, including unpublished groups,
   cards and FAQs, which are drawn dimmed and labelled.
4. Drafts are rows in PostgreSQL. They survive a browser restart, a sign-out
   and a server restart; nothing is held in `localStorage`.
5. Undo and Redo are the page editor's own history: a route edit — words, a
   style, an entrance, a move or a hide — is one step, and stepping writes the
   draft back (an Undo that returns a field to its live value removes the
   patch). Neither ever publishes, discards or reaches live content, and a
   publication is not a step: the way back from one is Restore to draft.

## 6. Publish, discard and concurrency

**Draft saves** are guarded per owner by `route_nodes.revision`: a save names
the revision it was built on, and a save against a moved revision is refused
with the latest state, exactly like a page section.

**Publish** (`publishRoute` in `src/lib/routes/publish.ts`, behind
`publishRouteFromEditor`) is one transaction:

1. lock the category row, its groups, services and questions, and every
   `route_nodes` row of the route (`FOR UPDATE`, always in that order);
2. compare the **review token** — the owners and revisions the summary showed
   the publisher — and refuse (`stale`) if any draft changed since it was
   reviewed, so nothing is published unseen;
3. compare every patched field's `base` with its live value; **any mismatch
   refuses the whole publication** (`conflict`) with the list of fields —
   nothing is written;
4. check the publisher holds the capability of every resource the content
   drafts touch;
5. validate the final values with the same rules the admin forms apply
   (lengths, required English title, `sanitizeRichText`, the icon allowlist,
   media that exists, a group from the same category);
6. write the patched columns (and only those), apply orderings, promote
   presentation, clear the drafts, bump revisions;
7. insert the baseline on a first publication and the `route_versions` row,
   keep the newest 30, and remove rows of owners whose records are gone.

After the commit the action logs the activity (`route.published`, with the
actor, the route and the summary) and revalidates the `catalog`, `faqs` and
`routes` caches. Any refusal rolls the transaction back whole.
`tests/stress/route-concurrency.stress.mts` races publications against each
other, against new edits and against the Services screens, and checks every
outcome in the database: one winner, whole or nothing.

**Discard** deletes the drafts the reviewed summary listed (review token again)
and nothing else; published values and presentation are untouched.

**Ordering** is a field of the container owner (`categoryServices`,
`subcategory`, `categoryFaqs`): the list of child ids in order. Publishing it
re-numbers only the listed rows' `sort_order`, so rows outside the list keep
their place. Its conflict check compares the relative order of the ids the
draft started from with their live order.

## 7. Existing admin forms — the conflict policy

The Service Categories, Services, FAQs and Packages screens are unchanged in
what they do: they write live, immediately, as before. They never read or write
`route_nodes`.

| Situation | What happens |
|---|---|
| Admin form saves a field **no draft patches** | Live immediately. A later Visual Editor publish does not touch that column, so the form's value survives. |
| Admin form saves a field while an editor **already has the owner loaded** (Batch 23) | Live immediately. The editor's next save names the values its buffer began from (`baseValues`): a field it did not change is not drafted from the buffer (`withUntouchedFromServer`), so the form's value survives; a field it did change is drafted from the value it began from (`staleStartingPoints`), so publishing it meets the form's newer value as a conflict, with the same two choices. Before Batch 23 the buffer's old value was drafted as if typed, and the next publish put it back. |
| Admin form saves a field **a draft patches** | Live immediately. The draft's `base` no longer matches. The editor marks the field "Changed outside the Visual Editor" as soon as the owner is loaded, and **publish is refused** until the editor chooses, per field, **Keep my draft** (re-base: publishing will then replace the form's value, deliberately) or **Use the live value** (drop that patch). |
| Admin form deletes a record a draft patches | The owner disappears from the route; its draft is ignored and is removed by the next publish or discard of that route. |
| Admin reorders rows an order draft covers | Publish is refused for that order field, with the same two choices. |
| Visual Editor publishes | Writes only the patched columns, through one transaction. |

A pending draft is never silently overwritten, and the rule is the same for
every category.

One form needed a field to keep this promise: the group form on the Service
Categories screen saved both group summaries but showed only the English one,
so every save emptied the Arabic summary. Harmless while nothing else could
set it; the Visual Editor can, so the form now carries "Summary (العربية)"
(browser-tested: shown, saved, kept). One case is the forms' own, unchanged: a form opened *before*
a Visual Editor publication and saved *after* it writes every field it holds,
as it always has — the same last-save-wins the forms have between two people
using the forms. The admin forms carry no revision check today; adding one
would change their behaviour for every user and is listed as an open item.

## 8. History, Compare, Restore

The route's Version History lists each publication: actor, time, which
resources changed and how many fields. **What changed** shows, per resource
and field, the before and after values of a publication; **Compare with live**
shows where a version differs from the live page; **View** opens the version
itself, rendered by the real route (`?compare=v<id>`), read-only and still. **Restore** never writes live: it is refused while the
route has pending drafts (publish or discard them first), and otherwise builds a
draft from the version's snapshot — every field that differs from live becomes
a patch based on the live value — which the editor then reviews and publishes
like any other draft.

## 9. Style and motion

The same closed vocabulary as pages: `validateStyleDocument`, the style-target
capability model (`styleTargetFor`), Desktop / Tablet / Mobile, the advanced
token gate, `motionForBlock`, `validateMotionDocument`, reduced motion and
Replay. Styles render as inline declarations plus `data-rs-*` and `--rs-*`
variables through `blockNode`, identical to page sections; there is no CSS
text, no selector and no class an editor can type. A region's root entrance
uses the section-entrance renderer; node motion ships the shared
`MotionRuntime` only when a node animates.

## 10. Permissions

Every Server Action checks the session again; the editor's buttons are a
convenience, never the authority.

| Action | Requirement |
|---|---|
| Open the editor on a route | `content.view` + `visual_editor.view` (unchanged door) |
| Read an owner | the same |
| Save content of a category, group, card or template copy | `content.edit` + `services.manage` |
| Save content of an FAQ | `content.edit` + `faqs.manage` |
| Save an ordering or a visibility (group, card, FAQ) | `content.structure` + the resource's capability |
| Save style | `content.style` (+ `content.advanced_style` for advanced tokens) |
| Save motion | `content.motion` |
| Publish / discard / restore to draft | `content.publish` + the capability of every resource the draft touches |
| Resolve a field conflict | `content.edit` + the resource's capability |
| Choose an image | the editor's media list; the id is checked to exist on save |

Uploading stays in the Media library; the editor only chooses.

## 11. Rendering and security

`resolveCategoryRender` (`src/lib/routes/category-view.ts`) decides, on the
server, from the session — never from the parameters alone:

| Request | Result |
|---|---|
| Anyone, no parameters | Published page. No `data-eod-*`, no bridge, no draft column read. |
| `?preview=1` without `content.view` | Published page, as above. |
| `?preview=1` with `content.view` | Drafts applied, preview banner. |
| `…&editor=1&bridge=<id>` with `content.view` | Drafts applied, editor attributes, `EditorBridge`. |
| `?compare=v<id>` or `?compare=published` with `content.view` | One version (or the live state), read-only and still. |
| Any of the above without `content.view` | The published page, exactly as for a visitor. |

Unknown or unpublished categories stay 404 for visitors. The middleware marks
preview, editor and compare responses private and not indexable. The bridge
keeps the origin and bridge-id checks of protocol v7.

## 12. Hard-coded copy audit (category template)

Every customer-visible string on the template, classified:

| String | Was | Now | Class |
|---|---|---|---|
| Hero eyebrow, title, summary, body | category row | category row | editable content |
| Primary CTA label | category row, else "Request a Service" | same | editable content (fallback: system UI) |
| Primary CTA destination | literal `/contact` | `cta_href`, else `/contact` | editable content |
| "WhatsApp us" | dictionary | dictionary | system UI (button chrome, every page) |
| WhatsApp message text | `settings.ts` template | unchanged | generated from settings + title |
| Breadcrumb "Home", "Services", trail | dictionary + title | unchanged | generated / system UI |
| "In this category" (services eyebrow) | dictionary | template copy, dictionary fallback | category-template content |
| "Services" (services heading) | dictionary | template copy, dictionary fallback | category-template content |
| Group titles and summaries | subcategory rows | same | editable content |
| Card title, intro | service rows | same | editable content |
| "Learn more" | dictionary | dictionary | system UI |
| "Tour Packages" (hub eyebrow) | dictionary | template copy, dictionary fallback | category-template content |
| "Choose your destination" / "اختر وجهتك" | **source literal** | template copy, literal fallback | category-template content |
| "Prepared programmes for every destination…" | **source literal** | template copy, literal fallback | category-template content |
| Destination names | `package_destinations` | same | generated (Packages › Destinations) |
| Package counts | computed | same | generated |
| "View packages" | dictionary | template copy, dictionary fallback | category-template content |
| `/packages` destination | literal | unchanged | generated route |
| "Questions" (FAQ eyebrow) | dictionary | template copy, dictionary fallback | category-template content |
| "Frequently asked questions" | dictionary | template copy, dictionary fallback | category-template content |
| FAQ questions and answers | faq rows | same | editable content |
| JSON-LD (breadcrumb, FAQ, item list) | generated | unchanged | generated, not visible |

Reasoning: words that belong to *this page's sales message* moved to storage
an owner controls; words that are the site's interface on every page (button
chrome, breadcrumbs, "Learn more") stay translated system UI, so a single
category cannot drift from the rest of the site; derived text stays generated
so it cannot contradict the data it is derived from. Empty template copy means
"use the standard wording", decided per language: an empty Arabic heading
shows the standard Arabic wording, never the English custom one, and Arabic is
never seeded from English.

## 13. Performance

The public route keeps its cached loaders and adds one cached, tagged query
(`routes`) for published presentation — one row per owner that has any, read
once and shared by every category. Warm cache: no extra round trip; cold: one.
The editor's preview reads the category's own rows directly (unpublished rows
included) with a fixed number of queries regardless of the number of cards:
four for the category, its groups, services and questions, one for the route's
`route_nodes`. Editor attributes are computed only in editor mode; a visitor's
render carries none and does no editor work.

## 14. Rollback compatibility with `902a0e6`

The migration only creates `route_nodes`, `route_versions` and the
`cta_href` column (with a default). `902a0e6` selects and inserts its own
column lists, so it runs against the upgraded database unchanged
(`COMPAT_REF=902a0e6 node --import tsx --test tests/schema-compat.test.ts`).
After a rollback, content published through the Visual Editor stays live (it
is in the domain tables); presentation, template copy and `cta_href` are
ignored, so those regions render the pre-Batch-21 defaults; drafts stay
dormant and reappear on roll-forward.
