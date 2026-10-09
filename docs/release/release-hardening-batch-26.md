# Release hardening — Batch 26

**Status: development record, not a release approval.** Production deployment
is not authorized by this document. Batch 26 did not access the VPS or the
production database, did not create a tag, and did not change
`deploy/previous-release`.

| | |
|---|---|
| Base | `7c3a00d` — Batch 25, fast-forwarded onto `main` in Phase 0 (`da96625` → `7c3a00d`, ten commits, none rewritten) |
| Branch | `batch-26-final-release-readiness` |
| Migrations | none added; `0007` byte-identical to `7c3a00d` |
| Dependencies | none changed |

The batch closes what Batch 25 left recorded rather than fixed and puts the
release decision on evidence: §1 the media delete against pictures named
outside a foreign key, §2 the sitemap and `noindex`, §3 the share image and
`robots.txt`, §4 the site's SEO defaults, §5–§7 the open browser incidents,
§8–§10 regression, tabs left open and the deployment process, §11 what stays
limited.

## 1. Pictures named outside a foreign key (brief §1–§5)

### 1.1 The race Batch 25 left

Batch 25 made the media library's delete atomic (`deleteMedia`, C.3 F5c): one
transaction locks the picture's row `FOR UPDATE`, recounts every use on that
connection (`mediaUsage`) and deletes only when there is none. A writer that
names a picture through a foreign key — a record's `image_id`, an SEO record's
`og_image_id` — takes the picture `FOR KEY SHARE` by itself (the foreign-key
check does), so it and the delete cannot pass each other. A writer that names
a picture **inside jsonb** took nothing: it could store the id in the moment
between the delete's recount and its commit, and leave an id that names
nothing. Re-reading the delete for this batch found two further holes that no
lock could close on its own:

- **X1 — Quick Links cards were never counted.** The count read the top level
  of a section's values only, and a card keeps its picture one level down
  (`links[].image`). Such a picture could be deleted outright, with no race,
  while the card showed it.
- **X3 — restores copied history back unchecked.** History is not counted
  (decision B), so a page or component version could restore an id the library
  had deleted since, and a later publication put it live.

### 1.2 Inventory

Five independent sweeps, each blind to the others — by table and column, by
entry point (all 19 `"use server"` modules, every exported function; the three
route handlers; the scripts), by value shape, by copy path, and by the guard's
own reads — were merged, every disagreement re-read against the source, and
the result checked by three critics. Every jsonb column in `schema.ts` was
classified: the only ones that can hold a live or draft picture id are
`page_sections.published`/`draft` (seven top-level `media` fields and one
nested one, Quick Links' `links[].image`), `reusable_components.published`/
`draft` (`block:image-text`'s `image`), `route_nodes.draft_content` (the
`imageId` value of six region types — never its `base`) and `site_settings`
key `seo` (`ogImageId`). History holds them too: `page_versions.snapshot`,
`reusable_component_versions.values`, `route_versions.snapshot` **and**
`route_versions.changes`. Nothing else can — styles and motion are closed
vocabularies, `route_nodes.copy` is strings, `pages.draft_structure` is
section ids, and the services and packages lists are text.

**A — can create a live or draft reference.** Every one now holds what it
stores (§1.3).

| Writer | Entry point | Stores | How it holds |
|---|---|---|---|
| Visual Editor content save (autosave), with and without reusable links | `saveVisualSectionDraft` | section `draft` | one transaction: components `FOR SHARE` (linked), the guarded row update, then the pictures; refuses a missing new picture by its field |
| Visual Editor detach | `detachVisualInstance` | section `draft` (the component's picture becomes the section's) | component `FOR SHARE` → row → pictures |
| Pages screen: Save draft | `saveSectionDraft` | section `draft` | a transaction now (it was one pool statement): row → pictures |
| Pages screen: Save and publish; Publish | `saveSectionAndPublish`, `publishSection` → `publishSectionIn` | section `published`, restore point | page and sections (`lockPageForWrite`) → guarded update → pictures, inside the restore point's transaction |
| Publish page (both screens) | `publishPageChanges` | every pending section's `published` | page and sections → components `FOR SHARE` → pictures → restore point → promotions |
| Add a reusable block | `addStructureSection` with a component | new section `published`/`draft` | component `FOR SHARE` → insert → pictures → page revision |
| Duplicate a section | `duplicateStructureSection` | new section `published`/`draft` | components `FOR SHARE` → insert → pictures → page revision; a picture the original named and the library has deleted since refuses the copy |
| Restore a page version (Pages screen, Visual Editor, the Compare page's "Restore to draft") | `restoreVersionToDraft` → `applyRestorePlanIn`; the test-only wrapper `applyRestorePlan` | section `draft`s, recreated sections | page and sections → pictures; a picture gone since is left out and named (decision B) |
| Create a reusable component; Save as reusable | `createComponent`, `createReusableFromSection` | component `published` or `draft` | a transaction now: insert → pictures; every picture is new to it |
| Reusable component: Save draft | `saveComponentDraft` | component `draft` | a transaction now: guarded update → pictures |
| Reusable component: Publish | `publishComponent` | component `published` | component `FOR UPDATE` → version → guarded update → pictures |
| Reusable component: Restore a version | `restoreComponentVersion` | component `draft` | a transaction now: component `FOR NO KEY UPDATE` → pictures → update; a picture gone since is left out and named |
| Visual Editor route draft save; conflict resolution | `saveRouteRegionDraft`, `resolveRouteConflict` | `route_nodes.draft_content` (`imageId` value) | a transaction now (it was one pool statement): guarded node write → the patch's picture values, never `base` |
| Visual Editor route publication | `publishRoute` | the record's `image_id` (foreign key) | records and regions `FOR UPDATE` → pictures (before the records are written, so a deleted picture is a refusal by name, not a foreign-key error) |
| Visual Editor route restore | `restoreRouteVersion` | `route_nodes` drafts | records and regions → pictures by the region specs' `media` keys only (it used to collect every number, group ids included); a picture gone since is skipped and named |
| The deploy's seed: shipped artwork | `seedImagery` (`npm run db:seed`, deploy step 10) | `published.image` of empty featured-service, travel-feature, destination-feature and image-text sections; category and package `image_id` | per row, a transaction: the section `FOR NO KEY UPDATE`, re-read → the artwork `FOR KEY SHARE` → update; an artwork deleted meanwhile is left unattached (and never fails a foreign key, which would stop the deploy) |
| The deploy's row-id backfill | `backfillRowIds` (`npm run db:migrate`, deploy step 10) | every section's `published`/`draft`, rewritten with item ids stamped — on the next deploy, every section with a list, since no release in production has stamped one | per section, a transaction: the row `FOR NO KEY UPDATE`, re-read, stamped from what it holds then. It used to stamp the copy it had read ahead in pages of 500, so a save by the release still serving in between was overwritten — the edit lost and a picture it had removed brought back. It introduces no id the row does not hold at that moment, so it holds no picture |

**B — history only.** Not counted by the delete and not pinned (brief §5,
decision B); read back only by the restores above, which handle a missing
picture: `page_versions` (restore points), `reusable_component_versions`,
`route_versions` (snapshot and changes).

**C — generated, read-only or maintenance that introduces no picture id.**
The seed's pages and settings (insert-if-absent, every
picture `null`); the one-off restructure (copy and links only); the SQL
migrations (DDL only); the deploy's SEO reconcile (no jsonb); the history,
compare and load reads; the Visual Editor's Undo/Redo (memory only — every
replay goes through a writer above, so an Undo that re-sends a picture deleted
meanwhile is refused by name); the read-only scripts the deploy and an operator
run (`db:check-permissions`, `db:check-password-flags`, `audit:cta`, each in a
`READ ONLY` transaction); the dev reset, the nightly dump and the test harness.

**D — no picture id.** Style and motion drafts, discards (they only remove
references), layout edits (section ids), a plain new section, a new custom
page's empty hero, page settings and deletes, component rename/archive/delete,
route presentation promotion, the record apply of a route publication (text
lists; the picture is the foreign key above), route discards, every Site
Settings group (none writes `seo`), the SEO screen and the record forms
(foreign keys, protected by the database), record deletes, navigation, the
activity log (the enquiry export's included), enquiries (and marking one read),
media uploads, sign-out, the cache refresh, the editor's loaders and the seed's
other tables.

### 1.3 The protocol

`src/lib/media/hold.ts`, used by every A writer (the seed keeps the same rule
inline: a script cannot import a `server-only` module):

1. the writer takes the content rows it writes, as it always has;
2. it collects the distinct positive picture ids it is about to store — **by
   declaration**, never by searching values: `src/lib/cms/media-refs.ts` reads
   a block's declared `media` fields and the `media` fields of its `items`
   rows, a component by its kind's definition, a route draft by the region
   specs' `check: "media"` keys — so a section's `limit` of 6 is never taken
   for picture 6; ids are whole numbers from 1 to 2,147,483,647, each once,
   ascending;
3. it holds them with one statement — `SELECT id FROM media WHERE id IN (…)
   ORDER BY id FOR KEY SHARE` — in id order, so two writers holding the same
   pictures in opposite input order take them in the same order;
4. a picture it would **newly** bring in that is not there refuses the write,
   by the place it was chosen for ("The picture in “Links — card 2, Image” is
   no longer in the media library. Nothing was saved. Choose another picture,
   then save again."), and the transaction takes everything back; a restore
   leaves such a picture out instead and names it (§1.6);
5. it writes, and commits.

`FOR KEY SHARE` is what a foreign-key check takes. It conflicts with the
delete's `FOR UPDATE` and with nothing else, so writers never wait for one
another, and editing a picture's title or alt text (`FOR NO KEY UPDATE`) is not
held up. Whichever of a write and a delete reaches the picture second waits for
the other and then sees it: the delete counts the new reference and refuses, or
the write finds the row gone and refuses. There is no global lock, no timing,
no retry.

### 1.4 Lock order

| Transaction | Takes, in order |
|---|---|
| Media delete | the picture's row `FOR UPDATE` → the SEO rows naming it, `FOR NO KEY UPDATE NOWAIT` in id order — one being changed refuses the delete ("… is being saved right now. Nothing was deleted") → reads only (the recount, several statements) → `DELETE`, whose `ON DELETE SET NULL` reaches only those SEO rows (every other use was counted, so it refused) |
| Section writers (autosave, Pages forms, detach) | [linked components `FOR SHARE`, ascending] → the section row (guarded update) → pictures `FOR KEY SHARE`, ascending |
| Publish a page (`publishPageChanges`) | the page `FOR UPDATE` → its sections `FOR UPDATE`, ascending → components `FOR SHARE` → pictures → restore point (`page_versions` insert and prune) → guarded section updates and deletes → the page's guarded revision |
| Publish a section, save and publish (`publishSectionIn`) | the page `FOR UPDATE` → its sections `FOR UPDATE`, ascending → components `FOR SHARE` → restore point → the guarded section update → pictures; no `pages` write (one section's words do not move the page's revision) |
| Restore a version into drafts (`restoreVersionToDraft`) | the page `FOR UPDATE` → its sections `FOR UPDATE`, ascending → pictures (`holdMedia`; a missing one is left out) → section drafts and recreated sections, unguarded updates that bump `revision` → the page row; no restore point |
| Discard page changes | the page and its sections, as above; it writes back no picture id that was not already stored, so it holds none |
| Structure writers (add a reusable block, duplicate) | [components `FOR SHARE`] → the inserted section → pictures → the page's guarded revision |
| Reusable components | the component row → pictures (publish: `FOR UPDATE` → version → update → pictures) |
| Route draft save, conflict resolution | the region's row (`route_nodes`, guarded write) → the patch's pictures |
| Route publication, restore | records `FOR UPDATE` in each kind's fixed order → regions `FOR UPDATE` by key → pictures → record and region writes, history |
| SEO save (Batch 25, B.11) | the target's advisory lock → the record `FOR KEY SHARE` → **the picture** → the SEO rows `FOR UPDATE`, in id order |
| The deploy's seed | the section `FOR NO KEY UPDATE` → the artwork; for a category or package, the artwork → the record |
| The deploy's row-id backfill | one section at a time, `FOR NO KEY UPDATE`; no picture |

Why no cycle can form with a delete: it takes its one picture while holding
nothing, and after that it waits for nothing. The SEO rows its `SET NULL`
reaches are taken `NOWAIT`, before the recount, and no row can come to name a
picture held `FOR UPDATE` (naming it takes `KEY SHARE` on it); every other
table its cascade touches holds no row naming the picture, or the recount
would have refused. A transaction that never waits while it holds a lock
cannot be part of a cycle with any application writer. (Table locks are the
one thing it can still meet: the deploy's SEO reconcile takes `seo_metadata`
in `EXCLUSIVE` mode and the one-off restructure cutover takes eight content
tables against writes — neither ever waits for a picture — and a later
deploy's schema migration, which runs while this release serves and takes
its tables `ACCESS EXCLUSIVE` one after another in one transaction, can meet
a delete in the other order. PostgreSQL then aborts one of the two with
`40P01`: if it is the migration, the deploy stops before the switch; if it
is the delete, the editor is told something went wrong and nothing was
deleted. A delete in the minutes a deploy migrates is the whole window.) Writers never wait for one another on a picture
(`KEY SHARE` is shared), and their content-row order is the one each family
already kept, so a writer may take its pictures at any point after it has
locked what it reads to decide what it stores — which is where every A writer
takes them. The SEO save still takes its picture before its SEO rows (B.11).

This closes a cycle Batch 25 left (found by the Batch 26 review): before, the
delete's cascade met unused SEO rows in heap order while an SEO writer that
holds two rows at once — `moveSeoRow` (`lockOwnSeoRows`, id order), or a
category delete taking its own rows and then its services' in two statements
— could hold them in the other order; with two rows naming the picture and
neither of them used, Postgres would abort one side with `40P01`. The forced
test holds one such row from a second connection and requires the delete to
answer at once instead of waiting.

The recount is several statements, each with its own snapshot; that is sound
because every writer of a picture id holds it, so none can commit a reference
to the picture the delete holds between them.

### 1.5 What the delete counts

`jsonbPictureIds` (`src/lib/media/usage.ts`) is now used by the delete and by
the library card alike: every whole number at the top level of a section's or
a component's values, published and draft, **and every whole number in an
object inside a top-level list** — Quick Links' cards (X1, fixed). It searches
by value, so a block that gains a picture field later is covered without
anyone coming back to it, and it stays a superset of what writers hold: a
picture a writer held and the count could not see would be deleted the moment
the writer committed. The superset counts a section's `limit` of 6 as a use of
picture 6 (X2, kept: it errs towards keeping a picture). Route drafts are
counted by their declared `imageId` value (Batch 22), and the site default
share image by the SEO count (Batch 25).

**One reading of a picture id** (`src/lib/cms/media-id.ts`). The review found
the validator, the hold, the count and the renderer reading a stored value
four different ways: the validator kept `12.5`, a Quick Links card turned it
into the text "12.5" and drew picture 12, and neither the hold nor the count
saw a picture at all — so picture 12 could be deleted from under a live card
by a hand-made request, with no race needed. Now a picture id in a block's
values is a whole number from 1 to 2,147,483,647, as a JSON number — what the
media picker sends. The validator stores only that — anything else, `12.5`,
`1e21` or text, even a string of digits, becomes no picture, never another
one (it used to turn `"12"` into 12; nothing but a hand-made request ever sent
one) — and the hold and the renderer read only that. The count reads at least that: those
readers take a JSON number after JavaScript has parsed it as a double, so the
count takes every number whose value as a double is whole (`12`, `12.0`, and
`12.0000000000000001`, which JavaScript reads as 12), compared as `float8`,
the same double. Text never counts: a Statistics figure "15" is not picture
15 (a first version of this change counted strings of digits and would have
made such a picture undeletable; the second review caught it). A document
that is not an object names nothing rather than failing every delete in the
library.

**How it is computed.** The cast sits inside a `case`: a caller's
`image_id = $1` is pushed down into the count, and Postgres orders the
conditions it ends up with by cost rather than as written, so a filter beside
the cast did not keep a word from reaching it — the first version of the
widened count failed every delete that way, in the tests, before it was
committed. And the values are read with two `jsonb_path_query` calls rather
than nested `jsonb_each`/`jsonb_array_elements`: the planner estimates every
set-returning function at a hundred rows or more, the nesting multiplied the
estimate past the JIT threshold, and the library page — re-rendered by every
successful delete — spent about a second compiling the query on a few hundred
sections. Measured on 628 sections: 850–1,400 ms before, 35 ms after; a
successful delete from 1.5 s to 65 ms. A number below 0.1 never reaches the
cast: it cannot be a whole double, and a hand-written `1e-400` — beyond a
double altogether — made the cast fail, and with it every delete in the
library and the library page's count (found by the review's verification).

### 1.6 Ids a row already holds, publication and restores

- **Carried, never refused.** An id a row already names is not new: the delete
  counts the row as committed, so it cannot be deleted under a write that keeps
  it. One that is missing all the same was deleted before Batch 26 could see it
  (X1) or brought back by an unchecked restore (X3); it is kept as it was and is
  never the reason an unrelated edit is refused.
- **A publication refuses an invalid live reference (decision B).** Publishing
  a section, a page, Save and publish, and publishing a reusable component keep
  a picture that is live already as it is, but refuse — by the section and
  field — one the draft would newly put live that has left the library (judged
  section by section: a picture one section of the page shows already is no
  licence for another to start showing it; a hidden section that the
  publication shows is judged as new, and one that stays hidden puts nothing
  live; a page publication names the section by its place, "(Image and text,
  section 2)"): "The
  picture in “Image” (Image and text, section 1) is no longer in the media
  library. Nothing was published — choose another picture, then publish
  again." A route publication always did. So a carried id can stay in a draft,
  but nothing that names no picture goes live that was not live already — save
  in a field a linked reusable component supplies, which is carried, never
  judged: the page draws the component's picture there, a picture is never
  something a linked section can override, and refusing would leave an editor
  nothing to choose (`linkedMediaIds`; found by the review). A Visual Editor route
  draft carries its own pictures the same way: an edit of a region's words is
  never refused because its draft names a picture deleted since; publishing it
  is.
- **Copies refuse.** Duplicating a section, adding a reusable block and saving
  one as reusable are new rows, so every picture they name is new: one that has
  gone refuses the copy by name rather than copying a dead id.
- **Restores (decision B, brief §5).** History is not pinned. A page version,
  a component version and a route version each hold the pictures they would
  restore; one deleted since is left out — the field emptied, as an editor
  clearing it would leave it — and named in the answer, place by place ("One
  picture this version used is no longer in the media library and was left
  out: Image and text (section 1): Image. Choose another before publishing.";
  the places are listed, and the sentence counts pictures apart from them —
  one picture in two places is "One picture … was left out in 2 places: …;
  …", two pictures are "Pictures … were left out in 2 places: …; …"; a route
  restore: "Left
  out, because it can no longer be restored: … — Background image."), and the
  rest of the version comes back. Before Batch 26 a page or component restore
  copied such an id back silently (X3, fixed). Two consequences, both held by
  tests: a linked section's own copy of its component's picture is emptied
  but not named, because the page shows the component's picture there and a
  linked section cannot choose one; and a component version that differs from
  what is live only by a picture that has gone is "nothing to restore" rather
  than a draft identical to the live content.

### 1.7 The deploy's scripts

Two A writers run outside the application, at deploy step 10, while the
previous release still serves.

The **row-id backfill** (`npm run db:migrate`) gives every section's list rows
the stable ids new saves get. No release in production has stamped one, so the
next deploy rewrites every section with a list. It read sections ahead in
pages of 500 and wrote each back from that copy, so a save the serving release
made in between was overwritten: the edit lost, and a picture the save removed
brought back — after which the serving release's delete could remove the
picture. It now stamps each section from what it holds under its own row lock,
read again just before the write; the release still serving has no revision
column to compare against, so the lock is the comparison.

`seedImagery` attaches the shipped artwork wherever one of four section types
has an empty picture. It now keeps the protocol (§1.2). Two of its behaviours
are older than this batch, are not changed by it, and are recorded:

- **A picture an owner cleared is filled again at the next deploy.** A cleared
  picture is stored as `null`, which is what the function fills — contrary to
  its own comment, which said a cleared picture was kept. It also fills an
  image-text section on a custom page that never had a picture. It writes
  `published` directly without moving the revision.
- **It cannot be protected against the release it is deployed over.** During
  the deploy window the serving release deletes media its own way (below).

### 1.8 Proof

`tests/media-references.test.ts` forces every race — never by timing. Two gates
are armed by the test and invisible otherwise: a deferred constraint trigger
that asks at commit for a shared advisory lock the test holds exclusively (the
**commit gate**: a write stopped there has done everything and holds every lock
it took; a delete stopped there has deleted the picture in its own
transaction), and the same before an insert. "The write first" stops the write
at its commit, sends the delete and requires it to be seen **waiting on a row
lock** (`pg_stat_activity`) before letting the write go; "the delete first"
does the reverse. A writer that did not hold its pictures would not make the
delete wait, and the test says so. Every write and delete goes through its own
Server Action against a production build; after each race nothing names a
picture the library no longer has.

| Writer family | The write first — the delete waits, then refuses | The delete first — the write waits, then refuses or leaves out |
|---|---|---|
| Visual Editor autosave | a save stopped at its commit holds its picture | the save refuses the picture by its field; nothing stored, no revision moved |
| …many pictures in one save | three Quick Links cards held in id order; the delete of the middle one waits | one card's picture gone refuses the save by that card ("Links — card 2, Image") |
| …a picture replaced while being deleted | the old one still counted until the save commits; the new one held | — |
| …two saves in opposite orders, two deletes | both saves land, both deletes refused; nothing deadlocks | both deletes land, both saves refused by name |
| Pages screen: Save draft, Save and publish | each holds its picture | each refused by name; no restore point left |
| Publish a saved draft; Publish page | the pictures going live are held | (the draft is counted, so the delete refuses in either order) |
| Discard | the delete is refused until the discard commits, then succeeds | — |
| Duplicate; Save as reusable; Add a reusable block; Detach | each copy holds its picture though the original let it go | a copy made while the original's picture is deleted refuses it by name |
| Page version restore (both screens) | the version's picture held; the restored draft counted | the picture left out and named by its section's place; the rest restored; also for a picture deleted long before; two sections losing one each are two places, and one picture used in two sections is one picture named at both places; a linked section's own copy of its component's picture emptied but not named |
| Reusable component: create, draft, publish, restore | each holds | creation and draft save refused by name; restore leaves it out and names it; a version that differs from live only by a gone picture is "nothing to restore", with no draft left pending |
| Route draft, publication, restore | the region's picture held; the record shows it (the publication's wait is the record's foreign key as much as the hold — every route picture lands in an `image_id` column) | the draft save refused; the restore skips and names it, the rest restored |
| A publication of a picture deleted before Batch 26 | — | a section, a page and a component publication refused by the field; nothing live changes; one already live is kept (Publish, Save and publish, a component's Publish) — judged section by section, so a picture one section shows is no licence for another to start showing it, and the refusal names the section by its place; a hidden section the publication shows is judged as new, one kept hidden is not; a field a linked component supplies is carried, never judged (Publish page, Publish, Save and publish) |
| A draft that already names a picture deleted since | — | an edit of its words saves through the autosave, the Pages screen's draft and a component's draft, keeping the id; publishing it is refused |
| SEO rows naming the picture | — | a writer holding one: the delete refuses at once ("… is being saved right now. Nothing was deleted") instead of waiting; with the writer gone it deletes and both rows lose the picture |
| One reading of a picture id | — | a crafted `12.5` or `1e21` in a card is stored as no picture; a hand-written `12.0` or `12.0000000000000001` is counted as picture 12; a Statistics figure `"12"`, a hand-written `"12"`, a document that is not an object and a number beyond a double (`1e-400`) stop no delete |
| The deploy's seed | the artwork it attaches held; the delete waits and refuses | the artwork deleted first: the seed waits, then leaves the picture empty |
| The deploy's row-id backfill | — | a save in progress when it reaches the section is kept, with the picture it removed still removed |
| X1 | a Quick Links card's picture counted by the delete and on the library card | — |
| X2 | a section's `limit` naming an id that is no picture saves | — |

The last test reads the server's whole output: no `deadlock detected`, no
unexpected failure, through every race above.

The stress script `tests/stress/media-references.stress.mts` asks the same
question with no gate, many times at once: each round brings in ten pictures
and, in a shuffled order, autosaves on image-text and Quick Links sections
(three pictures each, in a random order), the Pages screen's draft and
save-and-publish, component drafts and every service category's route draft,
while every picture of the round is deleted — and every picture the previous
round left named is deleted the moment these writes replace it. R1–R6: every
answer definite, nothing dangling after any round, a done delete gone and a
refused one kept, every stored write holding exactly what it named, the public
pages whole throughout, no deadlock and no failure in the server's output.

**Reviewed, and every test proven by mutation.** The changes went through
adversarial review in rounds, each finding checked against the working tree by
two independent verifiers. The last round (locking, picture ids, restores,
SEO, tests and docs) raised 17 findings. Ten were refuted because the tree
already carried the fix when their verifiers read it — the hidden section a
publication shows, the linked component's fallback copy, the section's place
in a refusal, the deploy's DDL migration in the lock-order note, text and
rounded decimals in the count, the classic form's reading of a picture id,
`/admin?`, the restore's picture count and the component restore's
comparison; two on their merits — a component restore that finds nothing to
restore leaves a colleague's pending draft as it is, as the exact match always
did (§11), and the SEO-row test's bound is a time limit on failure, as every
forced race here has, not a verdict by timing. Five were confirmed: three
documentation corrections and a missing test, made, and a pre-existing
rich-text defect, measured and recorded (§11). Its verifiers also found one more: a hand-written
`1e-400` made the count's cast fail every delete (§1.5, fixed).

Then each of the 30 changes below was applied to the source alone, the
application rebuilt (`next build`) and the test file run against it; a
mutation the tests did not catch would be a test that proves nothing
(scratch driver, not tracked). All 30 were caught. One survived its first
pass — Publish page judging a picture against the pictures the other sections
of the same publication show: the test only had the licensing section
unchanged, so it was strengthened to publish that section in the same
publication too, and the mutation and a whole-page variant of it (30) were
then caught.

| # | Mutation | What it breaks | Run | Result — the first test that failed |
|---|---|---|---|---|
| 1 | `ve-save-hold` | The Visual Editor autosave stops holding its pictures. | `media-references.test.ts` | caught: “the save first: the delete waits for it, then counts the new picture and refuses” |
| 2 | `pages-draft-hold` | The Pages screen's draft save stops holding its pictures. | `media-references.test.ts` | caught: “saveSectionDraft first: the delete waits for it and refuses” |
| 3 | `component-draft-hold` | A reusable component's draft save stops holding its pictures. | `media-references.test.ts` | caught: “draft save: held; the delete first, the save is refused and the draft is untouched” |
| 4 | `route-draft-hold` | A route region's draft save stops holding its pictures. | `media-references.test.ts` | caught: “a region's draft: held — the delete waits and refuses; the delete first, the save is refused by name” |
| 5 | `page-restore-hold` | A page version restore stops holding the pictures it brings back. | `media-references.test.ts` | caught: “the restore first: the version's picture is held — the delete waits, then counts the restored draft and refuses” |
| 6 | `guard-top-level-only` | The delete guard goes back to reading the top level only (Batch 25 X1). | `media-references.test.ts` | caught: “a Quick Links card's picture is counted — on the card, by the delete and on the library card” |
| 7 | `delete-seo-nowait` | The delete waits for SEO rows again instead of taking them without waiting. | `media-references.test.ts` | caught: “two SEO rows nothing shows name the picture and a writer holds one: the delete refuses at once instead of waiting; with the w” |
| 8 | `validator-decimal` | The validator goes back to keeping any positive number (12.5, 1e21). | `cms-fields.test.ts`, `media-references.test.ts` | caught: “a media id survives; junk becomes null — and so does a string, even of digits: a picture id is a number (Batch 26)” |
| 9 | `count-strings` | The count takes text for a picture again (a Statistics figure "15" blocks picture 15). | `media-references.test.ts` | caught: “one reading of a picture id: a crafted decimal in a card is stored as no picture, never as another; a hand-written 12.0 is co” |
| 10 | `count-exact-text` | The count reads a number's text exactly, missing what JavaScript rounds to a whole one. | `media-references.test.ts` | caught: “one reading of a picture id: a crafted decimal in a card is stored as no picture, never as another; a hand-written 12.0 is co” |
| 11 | `count-tiny-cast` | The count casts a number beyond a double again: one hand-written 1e-400 fails every delete. | `media-references.test.ts` | caught: “one reading of a picture id: a crafted decimal in a card is stored as no picture, never as another; a hand-written 12.0 is co” |
| 12 | `restore-place` | A restore's left-out entries lose their section's place. | `media-references.test.ts` | caught: “the delete first: the restore waits, finds the picture gone, leaves it out and says so — the rest comes back” |
| 13 | `restore-count-pictures` | A restore counts places as pictures again: one picture used twice reads as "Pictures … are". | `media-references.test.ts` | caught: “one picture in two places is one picture: named at both places, counted once” |
| 14 | `restore-linked` | A restore names a linked section's hidden copy of its component's picture again. | `media-references.test.ts` | caught: “a linked section's own copy of its component's picture is emptied with the rest, but not named: the page shows the component'” |
| 15 | `component-restore-same` | A component restore stores a draft identical to what is live again. | `media-references.test.ts` | caught: “a version that differs from what is live only by a picture deleted since: nothing to restore, and no draft left pending — l” |
| 16 | `component-restore-normalized` | A component restore compares with the raw live row again, not as every screen reads it. | `media-references.test.ts` | caught: “a version that differs from what is live only by a picture deleted since: nothing to restore, and no draft left pending — l” |
| 17 | `route-carried` | A route region's carried picture is refused again before the transaction. | `media-references.test.ts` | caught: “a region whose draft names a picture deleted since: an edit of its words still saves — the picture is carried — and publi” |
| 18 | `publish-page-per-section` | Publish page lets a picture another section of the same publication shows live license this one. | `media-references.test.ts` | caught: “a page: a picture one section shows already is no licence for another to start showing it — judged section by section” — survived the first pass; the test was strengthened, then caught |
| 19 | `publish-page-hidden` | Publish page treats a hidden section's stored pictures as live. | `media-references.test.ts` | caught: “a page: a hidden section that the publication shows is judged as new — a picture it held while hidden that has gone refuses” |
| 20 | `publish-page-place` | Publish page's refusal stops naming the section's place. | `media-references.test.ts` | caught: “a page: Publish page is refused by the section and field, and nothing on the page goes live” |
| 21 | `publish-linked-page` | Publish page judges a linked section's fallback copy of its component's picture again. | `media-references.test.ts` | caught: “a field a linked component supplies is never the reason a publication is refused: the page draws the component's picture ther” |
| 22 | `publish-linked-single` | The Pages screen's Publish judges it again. | `media-references.test.ts` | caught: “a field a linked component supplies is never the reason a publication is refused: the page draws the component's picture ther” |
| 23 | `publish-linked-form` | The Pages screen's Save and publish judges it again. | `media-references.test.ts` | caught: “a field a linked component supplies is never the reason a publication is refused: the page draws the component's picture ther” |
| 24 | `site-owned-slugs` | Panel pages may take the language prefixes and /monitoring again. | `seo-metadata.test.ts` | caught: “the sitemap lists what is published and indexable, in both languages — and nothing a record marks noindex” |
| 25 | `page-slugs-local-list` | The Pages screen goes back to the names it reserved before: a page may take /en, /ar or /monitoring. | `seo-admin.test.ts` | caught: “the language prefixes and /monitoring are refused by name like the names reserved before, and no page is made” |
| 26 | `robots-admin-prefix` | robots.txt goes back to the bare `/admin` prefix. | `seo-metadata.test.ts`, `robots-matcher.test.ts` | caught: “robots.txt: everything but the admin, the API and the resized media files; the sitemap at the site's own address” |
| 27 | `robots-admin-query` | robots.txt stops keeping crawlers off `/admin?<query>`. | `seo-metadata.test.ts` | caught: “robots.txt: everything but the admin, the API and the resized media files; the sitemap at the site's own address” |
| 28 | `sitemap-noindex` | The sitemap stops leaving out what a record marks noindex. | `seo-metadata.test.ts` | caught: “the sitemap lists what is published and indexable, in both languages — and nothing a record marks noindex” |
| 29 | `share-address` | The share image goes back to the robots-disallowed rendition address. | `seo-metadata.test.ts` | caught: “the record's picture at its 1600 rendition, its real size and its alt text in each language — one picture for both editions” |
| 30 | `publish-page-whole-page` | Publish page lets a picture any section of the page shows live license every other section. | `media-references.test.ts` | caught: “a page: a picture one section shows already is no licence for another to start showing it — judged section by section” |

### 1.9 What the protocol does not cover

- **The previous release.** The release production runs today
  (`deploy/previous-release`, `b807663`) deletes media with a plain select,
  count and `DELETE`, outside any transaction, and its count reads neither
  Quick Links cards, reusable components, route drafts nor SEO. While it serves
  — the deploy window between migrate and the switch, and after a runtime
  rollback — a hold delays its `DELETE` but cannot make it recount, so the
  race and X1 exist exactly as they do in production now. Its writers hold
  nothing either — its section saves, publications and duplicates (it has no
  reusable components, route drafts or page versions at all) — and it still
  exports `saveSeoDefaults`, which stores
  `site_settings.seo.ogImageId` from any positive number posted
  (`optionalId`) with no existence check and no lock: no screen of that
  release calls it, so at most a hand-made request reaches it. The protection
  is a property of the release that is serving.
- **Pictures already dangling.** Ids a delete or a restore left dangling
  before Batch 26 stay where they are (carried, §1.6); the renderer draws
  nothing for a missing picture.
- **A route draft whose record has gone.** Deleting a category (and with it
  its services), a service, a package or a destination leaves that record's
  `route_nodes` draft in place but dormant: nothing can publish it, so the
  delete stops counting its picture (`routeDraftMedia` reads drafts only while
  their record exists) and the picture may then be deleted under it. Harmless
  by construction — there is no page left to show it — and unchanged here.
- **The seed's refill** (§1.7).
- **A linked section's own copy of its component's picture.** If that copy
  names a picture deleted before Batch 26, a publication carries it live as it
  is (§1.6): the page draws the component's picture there, and only an older
  build after a rollback — which cannot read the link — draws the copy, as no
  picture. Only an id left dangling before this batch can reach it — the
  delete counts a draft's fallback copy like any other value.
- **A picture referenced by its address.** A link field — a section's or a
  card's link, a rich-text anchor, a reusable call to action, a route's
  call-to-action address, a navigation item — may hold `/media/<file>` (or a
  rendition's or share address). That is not an id: no writer holds it and
  the delete does not count it, so deleting the picture leaves a dead link.
  Every such field renders as a link, never as a picture, so no page shows a
  broken image.
- **The ids a row already holds are read before the transaction** (the
  `already` sets of the autosave, the Pages screen's draft, a component's
  draft and a route region's draft). That is sound because the guarded write
  then requires the revision it read, and every application writer moves the
  revision. The scripts that do not — the seed, the row-id backfill and the
  one-off restructure — never remove a picture from a row (the seed only adds
  one; the backfill keeps what the row holds), and the previous release never
  serves beside this one.

## 2. The sitemap and `noindex` (brief §6)

**As found** (Batch 25, `docs/admin/seo-and-share-images.md` A.14 F6j): the
sitemap listed every published address, including one whose SEO record says
`noindex` — telling engines about a page while the page asks not to be indexed.

**Now** (`src/app/sitemap.ts`): the candidates are what they were — the
publication rule is unchanged, so an unpublished page, record or destination is
still never listed — and every candidate carries the storage its own
`generateMetadata` reads its record from: `homeSeo()` for `/`, the overview
keys for `/services` and `/packages`, `recordStorage(type, address, id)` for a
CMS page, a category, a service, a destination and a package. One rule then
applies to all of them alike: a candidate whose record says `noindex` is left
out, in both languages. No address is named in that rule. A `pages` row whose
slug the site itself answers (`SITE_OWNED_SLUGS`, `src/lib/page-path.ts` —
the set the Pages screen already refused for new pages) is not listed under its
slug, which is how the homepage's row stays `/` and the search page stays out.
The review found that set short of what the site answers: it lacked the
language prefixes and `/monitoring`, so a panel page called `ar` would have
listed the Arabic homepage a second time — under that page's record, so a
`noindex` on the homepage would not have taken `/ar` out — and pages called
`en` (a redirect to `/`) or `monitoring` (never routed to a page) would have
been listed at addresses that are not them. `en`, `ar` and `monitoring` are
now in it: the Pages screen refuses them for a new page, and the sitemap
passes over a row written before the rule (tested with all three).

- **One record, two readers.** The sitemap reads the record with
  `getSeoRecord` and the storage the page itself uses, so a page's robots tag
  and its sitemap entry cannot disagree.
- **The cache follows the change.** The sitemap route is `force-dynamic`, and
  the rows it reads are the one `seo`-tagged cache entry that every write to
  SEO rows drops (B.12) — the same entry each page's own metadata reads. A
  `noindex` saved on the SEO screen leaves the sitemap at the next request;
  cleared, the address is back (tested through the screen's own save and
  removal; the other writers drop the same tag and are tested against the
  pages, Batch 25).
- **EN/AR.** The sitemap lists each address once per language, as before;
  both editions leave and return together, because the record is one.
- **No preview address** can appear: the list is built from published rows
  and fixed addresses only.

Held by `tests/seo-metadata.test.ts` — "noindex saved on the SEO screen takes
every kind of page out of the sitemap in both editions at the next request;
cleared, it is back (Batch 26)", over a CMS page, the homepage, both
overviews, a category, a service, a destination and a package, with the
sitemap's size checked so nothing else leaves with them — and by "every address
the sitemap lists says index on its own page, in both languages".

## 3. The share image and `robots.txt` (brief §7)

**As found.** `/media/[...path]` served one flat segment from the upload store:
an original (`/media/<stem>.<ext>`) or a rendition (`/media/<stem>@<width>.webp`).
nginx serves the same files from disk first (`try_files $uri @app`).
`robots.txt` allows `/` and disallows `/admin`, `/api/` and `/media/*@*` — every
rendition. A share image with a 1600 rendition was named by `og:image` and
`twitter:image` as `/media/<stem>@1600.webp`: exactly the address `robots.txt`
told crawlers not to fetch. X's link-preview crawler honours that.

**Now — the narrowest fix that changes no other address.** A share image's
1600 rendition is offered at `/media/share/<stem>.webp` (`shareSrc`,
`src/lib/media/url.ts`), and only pages name that address, only as their share
image (`src/lib/seo.ts`). The route maps it back to the one file it can mean —
`shareFile`: a plain stem of letters, digits, `.`, `_`, `-` (no `..`, at most
171 characters) plus `.webp`, read as `<stem>@1600.webp`. Nothing else is
reachable there: not an original, not another width, not an SVG (an SVG has no
rendition and `shareImage` already refuses one), and anything else is a 404.
nginx finds no file at `/media/share/…` and hands the request to the app, so its
configuration does not change. `robots.txt` adds `Allow: /media/share/`; the
`Disallow: /media/*@*` rule is unchanged, so every other rendition stays out,
and originals are as they were. The admin rule became `Disallow: /admin$`,
`Disallow: /admin?` and `Disallow: /admin/` (found by the reviews): the bare
prefix `/admin` also kept crawlers off a panel page whose address merely begins
with "admin" (`/administrative-services`) while the sitemap listed it, and the
query form (`/admin?denied=1`, where a refused permission lands — `?` is no
wildcard in robots.txt) is named so the narrower rule blocks everything the old
prefix did that is the admin's. The route is public,
as `/media/` always was —
no permission or admin boundary moves, and the file it serves was already
public at its `@1600` address.

Held by `tests/seo-metadata.test.ts` — "a link-preview crawler may fetch the
exact picture a page names, by robots.txt as served — and nothing but the
rendition is there (Batch 26)": it reads the `og:image` the page actually
emits, checks it against the `robots.txt` the server actually answers with
under RFC 9309's matching (`tests/helpers/robots.ts`: the longest rule wins,
`Allow` wins a tie, `*` and `$`) for `Twitterbot`, `facebookexternalhit`,
`LinkedInBot`, `Slackbot`, `WhatsApp`, `Discordbot`, `Googlebot` and `*` — the
deciding rule is `Allow: /media/share/`, every `@` rendition stays disallowed
and the original stays allowed — then fetches it as Twitterbot with no
session: 200, `image/webp`, `nosniff`, the very bytes of `<stem>@1600.webp`,
1600 wide. The same route answers 404 for an original's name, an SVG, an
`@1600` name, an encoded traversal, a leading dot, a nested path and an empty
name, and the originals and other renditions are served exactly as before. The
browser probe `seo-media` (S8) fetches the emitted `og:image` as Twitterbot:
200, `image/webp`, 1600 wide. The static fallback a page without a usable
picture names, `/brand/og-default.jpg`, is checked against the same rules and
fetched the same way (200, `image/jpeg`). Production routing is held
statically: nginx's `location /media/` must keep `try_files $uri @app;` — it
serves the upload directory first and has no file at `/media/share/…`, so it
hands the request to the application — and no nginx location may intercept
`/media/share/` itself; nothing here runs nginx.

## 4. The site's SEO defaults (brief §8)

**Classification: NO — the operator cannot change them anywhere.** The
defaults — default title, title template, description (each EN/AR), the
default share image and the X handle — live in `site_settings` under the key
`seo` (`SETTINGS_DEFAULTS.seo`, `src/lib/settings-defaults.ts`). The SEO screen
shows them read-only (`SiteDefaultsCard`, `seo-client.tsx`). Site Settings has
seven panels — Brand, Contact, WhatsApp, Social Media, Disclaimers, Features,
Maintenance (`settings/tabs.ts`) — and none of its actions writes the `seo`
key (`settings/actions.ts`); `saveSeoDefaults`, which no screen called, was
removed in Batch 25. Brand's site name is editable and is what the title
template places after a page title, but the template, the default title and
description, the default share image and the handle are not.

**Remaining owner-control gap — recorded, not implemented.** The brief asks
for the gap to be reported before anything is built, and keeps Batch 26 free
of features. It is not a release blocker: every public page has its own SEO
record on the SEO screen, which takes precedence over these fallbacks; the
seeded defaults are the site's real name and description in both languages;
and with no default share image every page without one of its own falls back
to the static `/brand/og-default.jpg`. A change today needs a developer.

The tiny integration that would close it, for a separately authorized change:
an "SEO defaults" panel in Site Settings that saves the `seo` key through
`saveSettingsGroup` — the same row the resolver already reads, so there is no
second copy — under `settings.manage`, with the default share image picked
from the library and held like every other picture named outside a foreign key
(§1.3): the row, then the picture `FOR KEY SHARE`, refused by name if it has
gone. The delete already counts that picture (`mediaUsage`).

## 5. React #418 (brief §9–§10)

### 5.1 What Batch 25 recorded

`ROOT-CAUSED · PRE-EXISTING · UPSTREAM` (tests/browser/README.md, *Known
issue*): the `react-dom` Next.js 15.5.25 vendors (`19.2.0-canary-0bdb9206-20250818`)
replays a host element that suspended during hydration with its cursor already
inside it, so a long streamed list's `<ul>` claims its own first `<li>`, and
React recovers by rendering on the client. React 19.3.0 resets the cursor.
Batch 25 reproduced it only with three busy loops beside the server, in the
editor's canvas.

### 5.2 The matrix

`tests/browser/matrix/hydration.matrix.mts` (tracked; how to run it and what it
records: tests/browser/README.md, *The hydration matrix*). Every canvas or page
document the browser loads is an attempt; every error React recovers from is
an occurrence, with its route and React's own component stack. For each run it
also records whether Layers still selected after every load, whether anything
was stored that nobody asked for (a fingerprint of every draft and published
column), whether a save was lost (the last value typed against the value
stored), Server Action failures, 5xx answers, failure lines in the server's
output, and whether the server stayed up or restarted. Release candidate:
this branch's working tree on `7c3a00d`, production build, one run at a time,
nothing else on the machine (4 CPUs).

| Class | Mode | Network | Attempts | #418 | Where | Selection | Unasked writes | Saves lost | Action failures | 5xx | Server |
|---|---|---|---|---|---|---|---|---|---|---|---|
| normal | editor loads | loopback | 40 | **0** | — | 40/40 | 0 | — | 0 | 0 | up, no restart |
| normal | editor loads | broadband | 40 | **0** | — | 40/40 | 0 | — | 0 | 0 | up |
| normal | editor redraws (40 saves) | loopback | 81 | **0** | — | — | 0 | 0 of 40 | 0 | 0 | up |
| normal | editor redraws (30 saves) | broadband | 61 | **0** | — | — | 0 | 0 of 30 | 0 | 0 | up |
| normal | public visits | broadband | 40 | **0** | — | — | 0 | — | — | 0 | up |
| normal | editor loads | slow | 30 | **0** | — | 30/30 | 0 | — | 0 | 0 | up |
| normal | public visits | slow | 40 | **4** | `/services/business-setup` ×2, `/services/iqama-services`, `/ar/services/license-renewal` | — | 0 | — | — | 0 | up |
| moderate | editor loads + 2nd editor + 3 visitors | loopback | 107 | **0** | — | 40/40 | — | 0 of 33 | 0 | 0 | up |
| moderate | same, again | loopback | 107 | **0** | — | 40/40 | — | 0 of 33 | 0 | 0 | up |
| moderate | same | broadband | 107 | **1** | `/services` (the 2nd editor's redraw) | 40/40 | — | 0 of 33 | 0 | 0 | up |
| moderate | editor redraws + 2nd editor + 3 visitors | loopback | 158 | **0** | — | — | — | 0 of 78 | 0 | 0 | up |
| moderate | same, other routes | loopback | 166 | **1** | `/services` (the 2nd editor's redraw) | — | — | 0 of 82 | 0 | 0 | up |
| moderate | public visits + 2nd editor | broadband | 77 | **0** | — | — | — | 0 of 18 | 0 | 0 | up |
| heavy (synthetic) | editor loads | loopback | 30 | **1** | `/services/travel-tourism` | 30/30 | 0 | — | 0 | 0 | up |
| heavy (synthetic) | public visits | loopback | 30 | **2** | `/services/travel-tourism`, `/services/iqama-services` | — | 0 | — | — | 0 | up |

Then, to find where the network threshold lies and to rule out the matrix itself:

| Class | Mode | Network | Attempts | #418 | Where |
|---|---|---|---|---|---|
| normal | public visits | loopback | 40 | **0** | — (the control: the same visits, no throttling) |
| normal | public visits | slow, two more runs | 80 | **3** | `/services/iqama-services`, `/ar/services/license-renewal` (the footer), `/services/business-setup` |
| normal | public visits | mobile (80 ms, 5 Mbit/s), two runs | 80 | **0** | — |
| normal | editor loads | mobile | 40 | **0** | — |
| normal | editor redraws (30 saves) | slow | 61 | **0** | — |

In all, with nothing else running: **0 in 302** canvas and page documents on
loopback or broadband, **0 in 120** on the mobile profile, and on the slow one
0 in 91 editor documents but **7 in 120** public visits. In the moderate class
**2 in 722**; under the synthetic load **3 in 60**.

Every occurrence carried one of two component stacks: the Batch 25 signature —
a services list's `<ul>` under `Reveal` (minified `p`):
`ul ← div ← p ← div ← div ← div ← section`, and on `/services` the same list a
few levels deeper (`ul ← div ← div ← div ← div ← p ← div ← div`) — and, on
public pages, a place of its own: the footer's
`ul ← div ← footer ← body ← html`. The same replay, in another long list. It is
the root-caused upstream defect, not a new one.

### 5.3 Persistence and recovery

In every run: React rendered the page again on the client and the page worked;
the editor selected from Layers after every load; every save stored exactly
the last value typed (0 lost of 377 saves across the redraw and moderate
runs); no draft or published column changed that nobody edited; no Server
Action failed; nothing answered 5xx; the server wrote no failure and never
restarted. A visitor's client re-render replaces the server-drawn page, so text
typed into a form in the moment before hydration finished would be redrawn
empty — not observed, and no server state is involved.

### 5.4 Classification and decision

The brief's rule: *if #418 appears under normal or realistically moderate
production-like conditions, or causes data loss or action corruption —
`PRODUCTION BLOCKED`, stop, and recommend a separate Next.js 16 qualification
batch.*

- It **does** appear under the brief's moderate class — two editors at work and
  three visitors, no busy loop, no throttling (2 in 722 canvas documents) — on
  the second editor's redraws of `/services`.
- It **does** appear for signed-out visitors on public pages, with nothing
  else running, under the slow network profile — the throttling Lighthouse
  applies to its mobile runs — 7 in 120 over three runs (4, 2 and 1 in 40).
- It causes **no** data loss and no action corruption.

So Batch 25's classification does not hold in full: the defect is upstream and
pre-existing, but it is **not** confined to artificial CPU pressure or to the
editor's canvas. **Classification: `PRODUCTION BLOCKED`** under the brief's
rule. It is not called fixed, and nothing in React or Next.js was changed or
patched.

### 5.5 Next.js 15 or 16 (brief §10)

**B — block production and run a separate Next.js 16 qualification batch.**
The decision rests on the matrix: the condition reproduces in the moderate
class and on public pages under a standard mobile profile, which is what the
brief's rule names. React 19.3.0 resets the cursor; Next.js 15.5.25 vendors a
19.2 canary, so the fix arrives only with a newer Next.js that vendors it.
Which Next.js 16 release does, and what moves with it, is that batch's first
question — a hardening batch is not the place for the upgrade.

**The release production serves today shows it too.** b807663 — the runtime
`deploy/previous-release` names — was built from its own commit with the same
`next` 15.5.25 and the same vendored React chunk (`1255-7316b50163a428e6.js`),
served against a copy of the same catalogue, and given the same public visits
on the same profiles, counted the same way (React's own recoverable-error
report):

| Release | Network | Visits | #418 | Where |
|---|---|---|---|---|
| this branch | slow | 120 | **7** | services lists and the footer, as above |
| b807663 (production) | slow | 80 | **1** | `/services/iqama-services` — `ul ← div ← (list) ← div ← div ← div ← section`, the same services list compiled into that release's page chunk |
| this branch | mobile | 80 | **0** | — |
| b807663 (production) | mobile | 40 | **0** | — |

So #418 is not something this branch brings: visitors on slow connections can
meet it on the live site today. The two rates (7 in 120, 1 in 80) are too
small to tell apart (Fisher's exact test, two-sided p ≈ 0.15). This does not
change the rule's verdict — the rule asks whether it appears under
production-like conditions, not which release introduced it — but it does
mean that holding this release back does not keep #418 away from visitors,
and that the Next.js 16 batch is worth running for production as it stands,
not only for this release. The scratch harness for this comparison (a
worktree of b807663, its standalone build, a server on a copy of the test
catalogue, the visits) is not tracked; the matrix's own visits mode is.

## 6. The route-services timeline incident (brief §11)

**Status: `UNREPRODUCED — DIAGNOSTICS RETAINED`.** The Batch 25 failure did
not come back: the timeline field appeared, took its value, saved and
published in all 25 runs of the final matrix and in the 47 route-services runs
before it this batch — 72 in all, none of them failing on it.

**What Batch 25 recorded.** One route-services CI failure, on a candidate
since superseded: the probe timed out at its first wait for the service's
timeline field in the Inspector (`await timeline.waitFor({ timeout: 15_000 })`),
and it was not reproduced. The probe's diagnostics are kept as they were —
every page error, every recovered React error with its route and component
stack, the server's output on a failure (`tests/browser/evidence.ts`), and,
should the field never appear, a line saying what the click selected and what
the Inspector holds — and every run below goes through the timeline field on
the way: typed in the Inspector and saved as a draft of the service, left
alone by Undo, published and shown on the public page, restored and
discarded, and typed, saved and published again on a service the probe
creates.

**The matrix** (`npm run test:browser -- --only route-services`, on the final
code; scratch driver not tracked): ten consecutive runs with nothing else on
the machine; ten beside two busy loops on its 4 CPUs (moderate contention);
five while a second, signed-in editor works on the probe's own server —
opening the Visual Editor on services the probe does not touch and reading
every category and service page the probe walks, in both languages, with
their RSC payloads, about 1,300 requests a run, every answer timed and every
failure's cause recorded — and the services and routes stress scripts
(`service-concurrency`, `service-form-concurrency`, `route-concurrency`) run
on servers of their own.

| Class | Conditions | Runs | Clean | Checks passed / failed | Recovered React errors | Time per run |
|---|---|---|---|---|---|---|
| normal | nothing else on the machine | 10 | **10** | 1,110 / 0 | 0 | 121–128 s |
| moderate CPU | two busy loops on the 4 CPUs | 10 | **10** | 1,110 / 0 | 0 | 138–145 s |
| concurrent | a second signed-in editor on the probe's server — 6,574 requests over the five runs, none failed while the server served — and the services and routes stress scripts on servers of their own, 15 of 15 clean (`service-concurrency` 13/13, `service-form-concurrency` 9/9, `route-concurrency` 8/8 each time) | 5 | **5** | 555 / 0 | 0 | 137–146 s |

The only failed requests the second editor recorded came as each probe's server
stopped — a refused connection once the server stopped listening, and in run 5
two plain-text answers `Internal Server Error` (one to a request sent 286 ms
before the first refused connection, one on a connection already open), the
answer Next's router gives when a stop has closed its own port. That is the
server's shutdown, not its service, measured on its own (scratch test, not
tracked): under a 12-way load, 180 of 180 answers before
`SIGTERM` were 200; of the requests in flight across it, 2 answered 500 and 10
answered 200; requests that arrived afterwards on connections already open got
500 while Next's router failed to reach its own closed port ("Failed to proxy
… ECONNREFUSED") until the process ended. The deploy stops and starts the
service the same way, so a visitor whose connection is open in those seconds
can see that 500 — Next's behaviour, before this batch as after it.

**Two failures on the way, one cause, root-caused — not retried away.** Each
was a different check from the timeline, and each time every other check of
the run passed and no page error was recorded:

- the first CPU-contention set (before the last review's fixes), run 2:
  *"Created: …its page is gone, and the editor no longer offers it"*;
- the first attempt at the final matrix, CPU run 8: *"Move: moved back on the
  same screen, it answers at its first address again"*. That attempt was
  stopped during its tenth CPU run and the matrix run again from the start on
  the corrected probe (restarted once more three minutes in, because a type
  check had loaded the machine during its first normal run).

The Services screen's actions commit, write the activity log, and only then
drop the catalogue's cache — and only then redirect (create, delete) or answer
"Service saved." (a move); a Visual Editor publication does the same before it
answers. The probe polled the database until the row had changed and read the
public page at once: inside that window the page is the catalogue as it was
a moment before. Forced deterministically (scratch test, not tracked): with
`activity_logs` locked so the action waits at its activity insert, a deleted
service's row is gone 227 ms after the request while its page still answers
**200** in both languages, then **404** in both once the action answers; a
service moved to another category has its row moved while the old address
still answers **200** and the new one **404**, then **404** and **200** once
the action answers "Service saved.". So both failures were the probe reading
too early, not the application: no state was wrong, and an editor's own next
screen comes after the cache is dropped. The probe now waits for each
screen action's answer before it reads a public page — the delete's redirect,
the create's redirect, "Service saved." after a move, the canvas drawn again
after a publication — and `route-packages`, which read its pages the same way
after a create, a publication and a delete, now waits the same way. A visitor
who requests the page inside that window — milliseconds, unless the activity
insert itself waits — sees it as it was a moment before; that is recorded,
not changed.

**`route-packages`, once it waited: two pre-existing defects, one of them the
application's.** With those waits in place `route-packages` failed in 5 of 22
runs on this branch, at one of three checks — the create's redirect never
arriving, or a direct edit of a package card's or a service card's title never
beginning — and in none of 8 on Batch 25's build. That looked like a
regression until the steps were repeated on their own, on both builds, with
every request, bridge message, focus change and pointer event and React's root
lanes recorded (scratch harness, not tracked), 25 times each on a warm server
with nothing touched while waiting:

| | Batch 25 (`7c3a00d`) | this branch, before the fix |
|---|---|---|
| package created on the Packages screen — the browser never reaches its screen | 2 of 25 | 4 of 26 |
| package deleted from its screen — the browser never returns to the list | 0 of 25 | 1 of 25 |
| package card title double-clicked — the double-click lands elsewhere | 2 of 25 | 0 of 25 |
| service card title double-clicked — the same | 4 of 25 | 1 of 25 |

Neither is this branch's, and both are now closed:

- *A redirect left uncommitted — an application defect, fixed.* Every stalled
  create was answered by the server with its 303 and the new package's screen
  in under 100 ms and its row was stored, while the browser stayed on
  `/admin/packages/new` with the button on "Saving…": React's root pending =
  suspended (two transition lanes), pinged 0, nothing scheduled — the
  React 19.2-canary dropped ping that 19B and 19C recorded
  (`docs/release/visual-editor-v1-acceptance.md`, defects 6 and 9). A Shift
  key changed nothing; one keystroke in a field landed it at once. 19C's
  `useSettledActionState` nudges once an action has *answered*, and an action
  that ends in `redirect()` does not answer — it throws — so the ten create and
  delete actions of the Pages, Services, Categories, Packages and Destinations
  screens were never nudged. The hook now nudges a throw as well, until the
  form has gone — which is the next screen arriving — and hands the throw on
  to Next.js as it came (`src/components/admin/form.tsx`). Held by
  `admin-form-settle` F5 and F6, a package created and then deleted from its
  own screen on three servers at once, each from cold, nothing touched
  afterwards: before the fix 29 of 36 creates arrived (the deletes 36 of
  36), with it 36 of 36 and 36 of 36, twice.
- *A double-click that lands somewhere else — a probe race, fixed in the
  probe.* The card's title sat on the canvas's bottom edge; Playwright's own
  `dblclick()` scrolled it into view — a glide, under the site's
  `html { scroll-behavior: smooth }` — scrolled again on its retry, and
  clicked while the canvas was still moving (traced: the canvas scrolled to
  102 px, back to 75 and on to 208 px, and the clicks landed 16–47 px above
  or below where the title had got to) — on the card's summary, which the
  editor rightly opened for editing, or between lines, where nothing is
  editable. That is 19A's finding 2 (`tests/browser/canvas.ts`): the probe
  now double-clicks through `clickCanvasNode(…, { double: true })`, which
  scrolls at once and waits for the canvas to hold still. The probes that
  still double-click natively (`route-categories`, `route-services`,
  `undo-compare`, `inspector-focus`, `layers-editing`) do so on targets at
  the top of the page, where nothing glides; none of them failed in this
  batch.

With both: `route-packages` 10 of 10 runs clean (840 checks), and the harness
on the fixed build 15 of 15 creates and 15 of 15 deletes, none slower than
1.2 s.

**Also recorded.** An investigation run under the concurrent conditions,
between the sets, failed its "no page errors" check with a **React #418**
that React recovered from, on the editor's canvas of
`/services/travel-tourism/air-ticket-booking` (component stack
`div ← p ← div ← div` — under `Reveal`, the replay §5 classifies). It is that
defect, counted with it, not the timeline incident. The first concurrent set's
second editor reported failed requests at the end of its runs 3–5 that its own
log could not place in time; the instrumented second editor used since (every
answer timed, each failure's cause recorded, stopping when the probe's server
stops) recorded none while the server served — they are the shutdown answers
measured above.

The diagnostics stay as they are, and the second editor's request ledger is
kept as a pattern for the next investigation.

## 7. Stress 37064560289 (brief §12)

`UNREPRODUCED INTERMITTENT FAILURE — ROOT CAUSE UNKNOWN`, unchanged. The 21A
diagnostics stay permanent (`tests/helpers/diagnostics.ts`, the
`create-navigation` stress script); nothing in Batch 26 touched them, and no run
of this batch — the local stress runs and the remote Stress run on the final
commit — showed its failure shape (page errors "An error occurred in the Server
Components render" in `create-navigation` N4). It is a different failure from
React #418: a server render error with a digest, not a client hydration
mismatch, and it is kept apart from it.

## 8. Regression (brief §13–§15)

### 8.1 SEO (§13)

Every Batch 25 behaviour the brief lists is held by a tracked test and was run
again on the final commit (`npm test`, the browser and stress suites, and
CI): stable target identity, a
destination's new address, a service's move, every kind of target, `/services`,
`/packages`, both editions, canonical, alternates, Open Graph and X, real image
dimensions, share-image fallbacks, no SVG, unpublished isolation, `/home`,
search `noindex`, previews private and `noindex`, JSON-LD isolation, cache
invalidation, signed-base concurrency, IDOR and CSRF (`tests/seo-model`,
`seo-admin`, `seo-metadata`, `seo-media`, `seo-reconcile`, the `seo-media`
probe and the `seo-media-concurrency` stress script). F5 and F6 were not
weakened. Batch 26 closed three gaps the coverage audit found: **Remove
override** is now posted with a forged token, no token and no session, as the
save always was (nothing is removed); the rest of the card — `og:type`,
`og:site_name` in each language, `twitter:description` and no `twitter:site`
while the handle is empty — is asserted; and the `robots.txt` reader the crawl
test relies on has tests of its own (`tests/robots-matcher.test.ts`).

What the audit found **held only in part**, recorded rather than built out
(each is Batch 25 behaviour Batch 26 did not change; none is a known defect):

| Area | Asserted | Not asserted |
|---|---|---|
| Open Graph and X | titles EN/AR, description EN, `og:url`, locales and alternates, image with size and alt, card size, `og:type` website, `og:site_name`, `twitter:description` EN, no `twitter:site` without a handle | a record's own share description rendered, `og:description` on an Arabic page, `og:type` article (packages, services), `twitter:site` with a handle |
| Share-image fallbacks | each step of the chain on its own: record, page picture, site default, static default | that a missing or SVG candidate is skipped for the *next usable* one (in every case under test nothing usable follows, so skip and stop give the same answer); `og:image` read again after a share image is deleted |
| JSON-LD isolation | an SEO record never reaches a package's `TouristTrip` or breadcrumbs; a Visual Editor draft never reaches public JSON-LD; a preview's JSON-LD describes its draft | record isolation for the `Service`, category, destination and `Organization` nodes; JSON-LD on a request with a query string |
| Cache invalidation | a save and a removal reach both editions at the next request; creates drop the tag; the sitemap follows `noindex`; defaults are uncached | the `seo` tag dropped by a destination rename, a service move, a record delete and a media delete, observed through a primed public cache |
| Share address in production | the page's `og:image` against the served `robots.txt`, fetched as Twitterbot; nginx's fall-through held statically | the request through a running nginx |

### 8.2 Media

The media tests (`seo-media`, `media-pipeline`, the X1 test and every race in
`media-references`) and the `seo-media` probe: the delete refuses while
anything shows a picture — a Quick Links card now included — and deletes the
row and its files when nothing does; an upload is stored, sized and rendered
as before; originals and renditions are served exactly as before, and the
share address serves only the 1600 rendition.

### 8.3 Migration `0007` (§14)

Not edited — byte-identical to `7c3a00d` — and no `0008`: nothing in Batch 26
needs a schema change (the protocol is row locks; the sitemap and the share
address read existing columns). Held, on the final commit, by:

- **a fresh install** — every test database is made by this tree's migrate
  and seed from empty;
- **an upgrade from a real Batch 24 database** — new in Batch 26,
  `tests/seo-upgrade.test.ts`: Batch 24 (`da96625`, migrations `0000`–`0006`)
  is checked out in its own worktree and builds the database with its own
  migrate and seed; seven SEO rows are written the way Batch 24's screen wrote
  them (by type and address, five with a share image, one `noindex`, the
  services overview, one at an address no record has); this release's migrate
  then runs as a deploy runs it. Every row is kept with its words, its share
  image and its `noindex`, the two new Arabic columns empty; each record's row
  is bound to its record at its own address; the overview stays unbound; the
  dead row is set aside to `~<id>`; `0007` is the eighth migration; and a
  second run reports "nothing to reconcile" and leaves a byte-identical dump;
- **every row state and the re-run** — `seo-reconcile`: every state the
  previous release can leave, moved, renamed and deleted records, rows showing
  share images moved or parked (their keys; by construction no reconcile
  statement writes `og_image_id`), no row deleted, a second run changing
  nothing;
- **the previous runtime** — `schema-compat`: `b807663`'s own table
  definitions, reads and writes, its SEO upsert and delete included, against
  the schema this release produces.

### 8.4 Dependencies (§15)

No dependency changed (`package.json` and `package-lock.json` are identical to
`7c3a00d`); `npm audit fix` was not run. `npm audit --json` on 2026-10-09
(`docs/release/evidence/batch-26-npm-audit-2026-10-09.json`, the lockfile of
every Batch 26 commit): **12** vulnerable packages — 0 critical, 7 high,
5 moderate — byte for byte the report Batch 25 recorded
(`docs/release/evidence/batch-25-npm-audit-2026-10-08.json`,
`docs/release/dependency-advisories-batch-25.md`). Nothing new, so nothing is
reclassified and nothing stops the assessment; every decision Batch 23 and
Batch 25 recorded stands.

## 9. Tabs left open (brief §16)

Unchanged and not weakened: every editor reloads any admin page and any Visual
Editor tab once the release is live (`DEPLOYMENT.md`, *Admin pages and editor
tabs left open across a release*; the checklist in §10). No signed-base,
stale-form or revision guard was relaxed in Batch 26: the guarded updates
every writer already made are the ones it still makes — inside a transaction
now, with the pictures held after them.

## 10. Deployment, read only (brief §17)

Audited from source; nothing deployed, nothing on the server touched.

| Requirement | Finding |
|---|---|
| Exact `RELEASE_SHA` pinning | Works as designed: the format is checked before anything else runs, the commit must exist after the fetch and be a commit, the target is read-only once decided and drives the build, the marker, the checkout, the rollback names and the report (`tests/deploy-target.test.ts`, in `npm test`). **But not for the next release** — see the bootstrap below |
| The approved SHA must be an ancestor of `origin/main` | Yes: `merge-base --is-ancestor` against the fetched tip, before anything is built |
| The runtime marker is the exact SHA | Yes: written from the target in the build, checked before anything changes, re-read on the runtime straight after the switch (before the checkout and the start — `DEPLOYMENT.md` now says so). Nothing reads what the *started* process serves: the health checks look at HTTP status only, and no route exposes the marker |
| Migrations before the runtime switch | Yes: build → stamp → backup → `db:migrate` (migrations, row-id backfill, SEO reconcile) → `db:seed` → `db:check-permissions` → stage → stop → switch — all database work while the previous release serves; a failure there stops the release with that release still serving |
| Rollback runtime | The live runtime becomes `standalone.rollback-<old-sha>-<stamp>` (0700); a failure after the stop restores it, resets the checkout and health-checks it. Migrations are never rolled back, which is why each must be readable by the release before it. Not covered: a failing `systemctl stop` exits before the rollback is armed and nothing starts the unit again; the artwork files `db:seed` writes to the upload directory are not removed; the rollback directory is named after the checkout, not the marker, so in the drift case it reports a mismatch and the run ends INCOMPLETE; and none of the rollback paths has a test |
| `0007` against the deployed runtime | `tests/schema-compat.test.ts` checks out `deploy/previous-release` (`b807663`) and runs its own reads and writes against this schema |
| Backup and restore | `DEPLOYMENT.md` §8: `deploy/backup.sh` dumps the database and the uploads before any migration; restore is `gunzip … | psql` and a `tar` of the uploads |
| `deploy/previous-release` | `b807663610982d32d84301852fff77fd7f36f9e8`, unchanged; read only by the tests; updated by hand in a later commit once a release is live and verified |

**The bootstrap gap — the most important deployment finding.** The documented
command runs the `deploy.sh` in the production checkout, which is
`b807663`'s copy: it predates `RELEASE_SHA`, the `db:check-permissions` gate
and the checkout read-back, ignores `RELEASE_SHA` and releases the tip of
`origin/main`. The next release must run the approved commit's own script,
taken from git; `DEPLOYMENT.md` now says so and how (*The first release over
`b807663`*). Several step numbers and descriptions in `DEPLOYMENT.md` that had
drifted from the script (the forced checkout, the marker re-read, the
permission check, what a failure leaves) were corrected; the script itself is
unchanged. The Batch 20 runbook's production gates (`visual-editor-v1-rc.md`)
put the CTA and password-flag audits between the seed and the switch, which
`deploy.sh` runs as one uninterrupted step: those audits belong against a
restored copy of the pre-release dump, before the script starts, and the
`--strict` permission preflight can only run after the switch (the script runs
it non-strict).

### 10.1 The next deployment's baseline

| | |
|---|---|
| Expected production runtime before it | `b807663610982d32d84301852fff77fd7f36f9e8` — the repository's record (`deploy/previous-release`); not verified on the server (no access in this batch). Confirm there first: `git -C /var/www/elite-one-desk/app rev-parse HEAD` and `.next/standalone/.eod-release-sha` |
| Expected rollback runtime | `b807663`'s, moved by the release to `/var/www/elite-one-desk/standalone.rollback-b807663-<stamp>`; with it, the backup the release takes before migrating |
| Database | recorded at migrations `0000`–`0001` (`docs/release/visual-editor-v1-rc.md`); the next release applies `0002`–`0007`, the row-id backfill and the first SEO reconcile, all additive and readable by `b807663` |
| `deploy/previous-release` | `b807663…`, unchanged in Batch 26; to be updated in a commit of its own once a new release is live and verified |

### 10.2 Checklist for the eventual, separately authorized deployment

1. Confirm the running runtime and checkout are `b807663` (above); stop if not.
2. Before the script starts: prove the latest dump restores into a scratch
   database, and run the CTA and password-flag audits against that copy
   (`visual-editor-v1-rc.md`, gates 2, 6–8) — the script runs migrate, seed,
   the permission check and the switch as one step.
3. Tell every editor before the switch that they will reload any open admin
   page and Visual Editor tab once the release is live (§9).
4. Run the approved commit's own `deploy.sh`, with `RELEASE_SHA` set to it
   (`DEPLOYMENT.md`, *The first release over `b807663`*).
5. Keep the dumps the release names; the database is not rolled back. Check
   the log for the `SEO records: …` reconcile line and the permission check;
   once live, run the strict permission preflight
   (`docs/release/permission-upgrade.md`).
6. **Have every editor reload any open admin page and Visual Editor tab** now
   that the release is live (§9).
7. By hand, beyond the script's health checks: `/robots.txt` shows
   `Allow: /media/share/`; `/sitemap.xml` answers and leaves out a page marked
   `noindex`; a page's `og:image`, fetched as `Twitterbot` through nginx,
   answers 200 `image/webp`; `.next/standalone/.eod-release-sha` names the
   approved commit.
8. Then record the new runtime in `deploy/previous-release`, in its own commit.

## 11. Known limitations

- **React #418 (§5)** — upstream, pre-existing, recovers on its own with no data
  loss, and reproduces under the brief's moderate class and on public pages
  under a slow mobile network. Blocks production by the brief's rule; fixed
  only by the newer vendored React (Next.js 16).
- **The first release over `b807663` must run the approved commit's own
  `deploy.sh`** (§10) — the production checkout's copy ignores `RELEASE_SHA`.
- **While the previous release serves** — the deploy window and after a
  runtime rollback — its media delete takes no lock and counts neither Quick
  Links cards, reusable components, route drafts nor SEO, so the jsonb race and
  X1 are as they are in production today (§1.9). Its sitemap lists `noindex`
  addresses and its `robots.txt` keeps the share rendition out.
- **Pictures already dangling** stay as they are, carried, until an editor
  replaces them; a publication refuses one that would newly go live (§1.6).
- **The seed refills a picture an owner cleared** in four section types at
  every deploy, and fills empty image-text sections on custom pages (§1.7).
- **The site's SEO defaults have no form** (§4) — an owner-control gap.
- **A layout discard and a page publication of the same page can deadlock**
  (pre-existing, not media): `discardLayoutDraft` deletes pending sections
  before it takes the page row, the opposite order to every page-wide writer.
  PostgreSQL aborts one with a generic error and nothing is written twice;
  recorded for a later batch.
- **Coverage not added**: no test checks the rest of `deploy.sh` beyond the
  target pinning (the rollback paths, the migrate → seed → permission-check →
  switch order) — as before; the seed race and the backfill race are forced
  through the scripts themselves, not through `deploy.sh`, and against this
  release's delete, not `b807663`'s.
- **A pre-existing SEO finding of the review, not changed here**: the sitemap
  lists an address whose SEO record names a different canonical — two signals
  that disagree. Leaving such an entry out, as the `noindex` rule does, would
  not; it changes which addresses are offered, so it waits for its own
  decision.
- **Rich text is escaped again every time it is saved again** (pre-existing —
  the sanitizer is unchanged since the first commit and `b807663` has it —
  found by the review, measured, not changed here). `sanitizeRichText`
  escapes the `&` of a character reference it wrote itself, so it is not
  idempotent, and an editor's rich-text box is a plain textarea holding the
  stored markup. Measured through the real actions: the Pages screen's
  section form saves `<p>We're open & ready</p>` as `We&#39;re open &amp;
  ready` (right), and saving that form again unchanged stores `We&amp;#39;re
  open &amp;amp; ready` — the public page then reads "We&#39;re open &amp;
  ready". The Visual Editor escapes once more when it loads a section
  (`toData` re-validates the stored values), so an autosave of a section that
  holds such text stores it two escapes further (measured: `We&#39;re` loads
  as `We&amp;#39;re` and saves as `We&amp;amp;#39;re`); page and component
  restores re-validate the same way. Any
  apostrophe, ampersand, quote or angle bracket in a rich-text body, or an `&`
  in a link inside one, is affected. The fix is not a one-liner — a link's
  address has to be decoded before it is checked, or `/&sol;host` would pass
  as a site path and render as `//host`, and content already stored escaped
  twice cannot be told apart from text that meant it — so it needs a batch of
  its own with a security review and a data decision. Recommended before
  editors rely on rich text in production, independently of this release.
- **Three forms outside the admin form still leave a redirect to a client
  transition** (pre-existing; the React defect of §6's `route-packages`
  finding): signing in and choosing a new password use `useActionState`
  directly, and the two sign-out buttons are bare forms, so the nudge
  `useSettledActionState` now gives a redirect does not reach them. None
  stalled in this batch — `password-change` waits for the sign-in redirect on
  every run (P9) — and a keystroke or a click releases one that does; the same
  hook is the fix, left for a later batch rather than widened here.
- **A component restore that finds nothing to restore leaves a pending draft
  as it is**: when the version — without a picture that has gone, or exactly —
  is what is live, the answer is "nothing to restore" and a colleague's
  different pending draft stays pending, as the exact-match case always did
  (Batch 17); the dialog's "it becomes the draft" is not literally kept.
- **A forced-race file that hangs instead of failing**: a few races in
  `tests/media-references.test.ts` await a delete or a write while a gate is
  held, without a timer; a change that moved a lock could leave that file
  waiting rather than failing with a message. CI's job timeout bounds it.
- **SEO coverage held in part** (§8.1): a record's own share description and
  the Arabic share description at render, `og:type` article, `twitter:site`
  with a handle, skip-to-next among share-image candidates, record isolation
  in the `Service`, category, destination and `Organization` JSON-LD, the
  `seo` tag after a rename, move or delete through a primed cache, and the
  share address through a running nginx.
- Everything Batch 25 recorded in `docs/admin/seo-and-share-images.md` C.4 that
  Batch 26 did not close (F6k, Arabic where a page has none, the rollback
  corners, sizes stored before Batch 25, preview JSON-LD).
