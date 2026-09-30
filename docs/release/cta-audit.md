# Call-to-action content audit — production release gate

**Status: prepared, not run against production.** This document and
`npm run audit:cta` are for a later, authorized release gate.

## Why

Until Batch 15b the block registry declared the unprefixed call to action of
four blocks — **one-desk, featured-service, travel-feature, image-text** — as
`CtaLabel` / `CtaHref`, while every renderer and every stored row used
`ctaLabel` / `ctaHref`. Saving one of those sections through the admin dropped
its button (the validator keeps only declared fields), and the admin form
showed two empty, differently named boxes whose contents no page ever drew.

The release currently in production (`deploy/previous-release`, `b807663`)
still has that registry, so any save of those blocks in production since then
may have removed a button. The fix (Batch 15b) stops further loss; it cannot
put back what was dropped. **No missing value may be invented** — the audit
finds; people decide.

## The audit — `npm run audit:cta`

`scripts/audit-cta.ts` (analysis in `scripts/audit/cta.ts`). It connects with
`DATABASE_URL` and runs every statement in **one `BEGIN READ ONLY`
transaction**: SELECT only, and PostgreSQL refuses any write inside it. It
works on a database before or after this release's migrations (tables the
previous release lacks are skipped). `tests/cta-audit.test.ts` proves it
changes nothing in a whole-database comparison.

```sh
npm run audit:cta                          # the sections that need a look
npm run audit:cta -- --all                 # every audited section
npm run audit:cta -- --json cta-audit.json # everything, for the review record
```

For each section of the four block types it reports:

| Field | Meaning |
|-------|---------|
| page id / slug, section id, block type, position, visible, draft-only | where it is |
| published EN / AR label, link | `published.ctaLabel.en/.ar`, `published.ctaHref`, plus whether the keys exist at all (a missing key is what the defect left) |
| draft EN / AR label, link | the same for a pending draft, when there is one |
| legacy keys | `CtaLabel` / `CtaHref` written by the pre-15b form — never displayed; may hold what an admin typed |
| links | reusable-component references (slot, component id, overrides, linked / unavailable) |
| visitors see | the published content with any component link resolved — what the page draws; a button needs both a label and a link |
| history | non-empty values earlier published versions recorded for this section (none exist before this release: production's release has no page history) |
| seed reference | the wording a fresh installation seeds for this block on this page — **reference only, never a proposed value** |
| findings | classified, below |

### Classification

| Finding | Severity | Meaning |
|---------|----------|---------|
| `legacy-keys` | suspect | Saved through the defective form. Its `ctaLabel`/`ctaHref` were dropped unless still present; any legacy text shown was typed and never displayed. |
| `button-hidden` | suspect | A label without a link, or a link without a label: the page draws no button. An intentional removal clears both. |
| `no-button-with-evidence` | suspect | No button, and an earlier value exists (history or legacy keys). |
| `no-button` | review | No button and nothing stored says there was one. May be intended — compare with the seed reference. |
| `english-missing` | suspect | Arabic label set, English empty. |
| `arabic-falls-back` | review | English set, Arabic empty: Arabic pages show the English label. **Often intentional**; not a defect by itself. |
| `link-unavailable` | suspect | Linked to a reusable component that cannot be drawn; the fallback is shown. |
| `draft-hides-button` | suspect | Publishing the pending draft would remove the button. |
| `shown-differs-from-fallback`, `draft-changes-cta`, `differs-from-history` | info | Context for the reviewer. |

## Evidence has a shelf life

The current validator keeps only declared fields, so **the first save of an
affected section in this release discards its `CtaLabel` / `CtaHref`** — the
only record of what an admin typed into the defective form. Therefore:

- the **pre-deploy backup** (`deploy.sh` step 8) is the evidence of record:
  restore it into a scratch database and audit that copy;
- audit production **right after the deploy, before editors work on these
  sections**, and keep the JSON output.

## Remediation plan (later, authorized)

1. **Inspect.** Run the audit against a restored copy of the pre-deploy backup
   and against production; keep both JSON files with the release record.
2. **Identify.** List every `suspect` section, and every `review` section a
   business owner has not confirmed as intended.
3. **Verify the intended wording and link** for each with the business owner —
   from the legacy-key text, earlier history, marketing material or the seed
   reference as *prompts*, never as automatic answers. Check every link resolves
   on the live site (`/services/...` paths exist and are published).
4. **Approve.** The owner signs off the exact EN label, AR label (or a decision
   to leave Arabic empty and fall back) and link for each section.
5. **Back up** the affected rows (the release backup already covers the whole
   database; take a fresh one if time has passed).
6. **Stage** each correction as a draft through the admin — the Visual Editor
   or the section form — never by SQL. That keeps revisions, history, activity
   and permissions (`content.edit`) in force.
7. **Review in Preview**, English and Arabic, desktop and mobile: the button is
   drawn, the label reads correctly, the link goes where approved.
8. **Publish through the normal authority** (`content.publish`), page by page,
   and re-run `npm run audit:cta` to confirm the findings are gone.
