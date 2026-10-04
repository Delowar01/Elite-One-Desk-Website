# The Services form and concurrent changes (Batch 23)

Written before the change, as the record of what the update path was and which
concurrency model replaces it. Sections 1–2 describe `64922a6` (Batch 22);
sections 3–8 are the design Batch 23 implements.

## 1. The update path before Batch 23

`/admin/services/[id]` (`services/[id]/page.tsx`) reads the service row and
renders `ServiceForm`, an `AdminForm` posting to `updateService`
(`services/actions.ts`). Fields are uncontrolled inputs with `defaultValue`s,
except four kinds of state the form keeps on the client: the Category select
(controlled by `categoryId` state), the picture (`imageId` state, posted in a
hidden input), and the four list editors (benefits, audience, requirements,
process steps), which hold their rows in component state and post them as
hidden JSON.

`updateService` then:

1. `guardAction("services.manage", form)` — session, permission, CSRF;
2. `readService(form)` — every field the form posts, trimmed, capped and
   sanitized (rich text through `sanitizeRichText`, lists through
   `itemList`/`stepList`);
3. validates the title, the category and the group-in-category rule
   (`groupProblem`);
4. writes **the whole row**: `UPDATE services SET <all 21 columns>,
   updated_at WHERE id = $id` — no transaction, no lock, no revision, no
   comparison with anything;
5. logs `service.updated` and drops the `catalog` cache and the admin path.

Nothing records what the form was opened with. So when anything else changes
the row while the form is open — the service page's Visual Editor publishing
(Batch 22), the category page's editor publishing a card's visibility or group
(Batch 21), a second admin on the same screen, the publish toggle on the list
— the stale form's next save writes every value it was opened with back over
the newer ones. Batch 22 recorded this as B.8 ("a form opened before a
publication and saved after it puts back the values it was opened with") and
stress S5 counted it.

## 2. What could be reused

* **A revision column** (the `page_sections`/`pages` pattern, or
  `route_nodes.revision`) would need `services.revision` — migration 0007. A
  single counter would also turn *every* concurrent change into a conflict,
  including two edits of different fields, which the brief asks to merge.
  Not chosen: no migration is required for a safe design.
* **The Visual Editor's route drafts** carry a per-field `base` and refuse a
  publication whose base has moved. That is the right *rule*, but routing the
  Services screen through route drafts would couple an ordinary admin form to
  the editor's draft, review-token and history machinery. Not chosen.
* **The per-field base itself** is reused as the model: the form carries what
  each field was when it was opened, and the server compares.

## 3. The model: a signed per-field base

`src/lib/services/form-fields.ts` holds one list of the form's fields and the
one reader that normalizes them (`readServiceForm`, moved out of
`actions.ts`). For each field it computes a **fingerprint**: the SHA-256 of
the field's normalized value, canonicalized so that what a browser does to an
untouched value cannot read as an edit — textarea line endings (`\r\n`) are
compared as `\n`, and a single-line input's value is compared without the line
breaks a browser strips from it.

A stored row is fingerprinted by passing it through **the same reader** the
submitted form goes through (the row is turned into the form a browser would
post for it), so an untouched field always fingerprints the same on both
sides.

The edit page renders a **base token**: `{v: 1, id, f: {field: fingerprint}}`,
base64url-encoded and signed with HMAC-SHA256 under a key derived from
`AUTH_SECRET` for this purpose only. The token holds fingerprints, never
values. A token that is missing, unsigned, signed for another service, or of
another version is refused before anything is read: "This form is out of
date. Reload the page …".

**Conflict units.** One per column, with two exceptions:

* **Placement** — `category_id` and `subcategory_id` together. A group belongs
  to a category, so a stale form that changes the group while the service was
  moved elsewhere must not pair the old category's group with the new
  category (scenario D).
* **Lists** — each of `benefits`, `audience`, `requirements`, `process_steps`
  is one unit. They are positional arrays with no row ids (Batch 22), so there
  is nothing finer to merge on: an overlapping list edit conflicts whole
  (scenario G).

English and Arabic are separate units (`title_en`, `title_ar`, …): an English
correction and an Arabic one made at the same time both survive.

**Fields the form posts.** Every unit the base covers is compared. A text,
select or hidden field absent from the submission counts as unchanged (a
truncated post never blanks a column); a checkbox follows HTML — absent is off.
`slug` is not a unit: `updateService` has never written it (Batch 22 A.5), and
this change does not start.

## 4. The decision, per unit

With `base` = the token's fingerprint, `mine` = the submission's, `live` = the
row's, read under lock:

| base vs mine | live | Outcome |
|---|---|---|
| equal | anything | **untouched** — not written; the live value stays, however new |
| differ | = base | **write** mine |
| differ | = mine | already so — nothing to write |
| differ | neither | **conflict** |

Any conflict refuses the **whole** save: nothing is written, not even the
units that would have merged. The answer names the conflicting fields by their
labels ("Newer changes to Title (English) and Key benefits were saved while
this form was open …") and carries them as `conflicts`; it contains no values,
no SQL and nothing secret. Nothing is auto-resolved.

## 5. The transaction

```
guardAction (session, services.manage, CSRF)
verify the base token                      -> refuse, write nothing
read + normalize the submission            -> per-unit fingerprints
BEGIN
  SELECT … FROM services WHERE id = $id FOR UPDATE   (services row first —
                                     the order every route publication takes)
  decide every unit (§4)            any conflict -> ROLLBACK, refuse
  validate the merged row: title, category, group-in-category
                                     -> ROLLBACK, refuse (the field errors)
  UPDATE services SET <written units only>, updated_at WHERE id = $id
COMMIT
log service.updated with metadata.fields = the written units   (after commit)
drop the catalog cache and the admin paths                     (after commit)
```

The row lock is the same one the Visual Editor's service publication
(`loadServiceData(..., {lock: true})`) and the category publication take
first, so the three writers serialize on the row and cannot deadlock. A
refused save logs nothing and drops no cache. A save that changed nothing
writes nothing, logs nothing and says so.

## 6. The form

The page renders the token beside the values it was computed from, and
`ServiceForm` posts it as `_base`. The fields are keyed by the token: when a
save succeeds and the page is re-rendered with the stored row, the fields are
mounted afresh from that row — inputs, Category, picture and list editors
alike — together with its new token. So what the form shows and the base it
posts always describe the same snapshot. A refused save does not re-render the
page: the form keeps the snapshot it was opened with, the banner says which
fields are newer elsewhere, and reloading shows them.

## 7. The scenarios (brief §5)

| | What happens |
|---|---|
| A non-overlap | The form changed Y only; X is untouched in the form, so the editor's newer X stays and Y is written. |
| B overlap | The form changed X; live X moved since the base: refused, nothing written, X keeps the other value. |
| C reverse order | The Services save lands first; the editor's draft carries its own per-field base, so its publication conflicts only on a field the form changed — Batch 22's rule, unchanged. |
| D category move | The stale form's placement equals its base: not written, the service stays where it was moved. A stale form that changed the group meets a moved placement: conflict. |
| E media | `image_id` is its own unit: a stale form that did not touch the picture never writes it back. |
| F visibility | `is_published` / `is_featured` / `sort_order` are units: a stale ordinary edit cannot reverse a publication change made elsewhere. |
| G lists | Each list is one unit: a stale form editing another field keeps the newer list; two edits of the same list conflict. |

## 8. Unchanged

`createService` (a new row has nothing to be stale against), the list's
publish toggle (it reads the row and flips it), `deleteService`, the Visual
Editor's publication rules, permissions, and the schema — no migration.

## 9. The editor's half (found by the Batch 23 stress)

The stress script written for this change (`service-form-concurrency`, F5)
found the same defect running the other way. A Visual Editor buffer holds every
field of a region from the moment it is loaded. When the Services form saved
the introduction while that buffer was open, the editor's next save of a
*different* field sent the whole region back, old introduction included, and
`nextPatchWith` drafted every value that differed from live — so the old
introduction became a patch, based on the new live value, and the next
publication put it back without a conflict. Not new in Batch 23 (the patch
rule dates from Batch 21); it was masked while the form overwrote everything
anyway.

The correction keeps the region save's shape and adds one field:

* The editor posts `baseValues` — the server values its buffer was last
  reconciled with (`SectionBuffer.contentBase`, or `data.values`). When a save
  is answered while the editor kept typing, the buffer keeps its local values
  and the base they derive from, never the newer answer.
* `saveRouteRegionDraft` reads the base exactly as it reads the submission.
  A field equal to its base was not edited in this buffer: it is taken from
  the draft, or from the record (`withUntouchedFromServer`), never from the
  buffer.
* A field the editor did edit is drafted from the value the editor began
  from — but only where that differs from what a fresh load shows now
  (`staleStartingPoints`), so an unnormalised column causes no false
  conflict. Its publication then meets the newer value as Batch 21's field
  conflict, with the same two choices.
* A save without `baseValues` (an old client) behaves exactly as before.

Held by `tests/service-form-concurrency.test.ts` (three cases), the
`services-form` probe (the real editor's buffer) and stress F5.
