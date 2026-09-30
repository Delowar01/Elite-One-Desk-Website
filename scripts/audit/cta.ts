/**
 * The call-to-action content audit — the analysis, with no database in it.
 *
 * Why it exists. Until Batch 15b the block registry declared the unprefixed
 * call to action of four blocks as `CtaLabel` / `CtaHref`, while every renderer
 * and every stored row used `ctaLabel` / `ctaHref`. Saving one of those
 * sections through the admin therefore dropped its button — the validator
 * keeps only declared fields — and the form showed two empty, differently
 * named boxes in its place whose contents no page ever drew. The release in
 * production (`deploy/previous-release`) still carries that registry.
 *
 * What it does. For every section of those four types it reads what is stored
 * — published, draft, any `CtaLabel` / `CtaHref` the old form wrote, a
 * reusable-component link and what it resolves to, and the values earlier
 * published versions recorded — and says what a visitor sees and what looks
 * like loss. It classifies; it never supplies a value. Every value it prints
 * was read from the database, except the seed reference, which is labelled as
 * exactly that: the wording a fresh installation starts with, shown so a
 * reviewer has something to compare against, never a proposed replacement.
 *
 * An empty Arabic label is not treated as a defect by itself: the site draws
 * the English label on Arabic pages when the Arabic is empty, and a great deal
 * of this site's Arabic is deliberately left for a translator.
 */
import { readReuse, resolveReuse, type ComponentSource } from "../../src/lib/cms/reuse/reference";
import { HOME_SECTIONS, PAGE_SECTIONS, type SeedSection } from "../seed/content";

export const AUDITED_BLOCKS = ["one-desk", "featured-service", "travel-feature", "image-text"] as const;

type Values = Record<string, unknown>;

export type Cta = { labelEn: string; labelAr: string; href: string };

/** One stored document's call to action, and how it is stored. */
export type StoredCta = Cta & {
  /** Whether the `ctaLabel` / `ctaHref` keys exist at all — absent is what the defect left behind. */
  hasLabelKey: boolean;
  hasHrefKey: boolean;
  /** What the pre-15b form wrote under `CtaLabel` / `CtaHref`, if it wrote anything. Never drawn. */
  legacy: (Cta & { present: true }) | null;
};

export type Severity = "suspect" | "review" | "info";
export type Finding = { code: string; severity: Severity; message: string };

export type SectionInput = {
  id: number;
  page_id: number;
  slug: string;
  page_title: string;
  block_type: string;
  position: number;
  is_published: boolean;
  is_draft_only: boolean;
  published: Values | null;
  draft: Values | null;
};
export type ComponentInput = {
  id: number;
  kind: string;
  status: string;
  published: Values | null;
  published_version: number;
};
export type VersionInput = { id: number; page_id: number; created_at: Date | string; snapshot: unknown };

export type AuditRow = {
  pageId: number;
  slug: string;
  pageTitle: string;
  sectionId: number;
  blockType: string;
  position: number;
  visible: boolean;
  draftOnly: boolean;
  published: StoredCta;
  draft: StoredCta | null;
  links: { slot: string; componentId: number; overrides: string[]; state: string; reason?: string; version: number | null }[];
  /**
   * What a visitor is shown: the published content with any component link
   * resolved. The renderers draw a button only with a label and a link
   * (`ctaLabel && ctaHref`); an English page never falls back to the Arabic
   * label, an Arabic page falls back to the English one.
   */
  shown: Cta & { buttonEn: boolean; buttonAr: boolean };
  /** Earlier values this section's published versions recorded, newest first, non-empty only. */
  history: (Cta & { versionId: number; createdAt: string })[];
  /** The seeded wording for this block on this page — a reference, never a replacement. */
  seedReference: Cta | null;
  findings: Finding[];
  worst: Severity | "ok";
};

const isRecord = (value: unknown): value is Values =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const textOf = (value: unknown, locale: "en" | "ar"): string =>
  isRecord(value) && typeof value[locale] === "string" ? (value[locale] as string) : "";

const stringOf = (value: unknown): string => (typeof value === "string" ? value : "");

export function storedCta(values: Values | null | undefined): StoredCta {
  const v = values ?? {};
  const legacyPresent = "CtaLabel" in v || "CtaHref" in v;
  return {
    labelEn: textOf(v.ctaLabel, "en").trim(),
    labelAr: textOf(v.ctaLabel, "ar").trim(),
    href: stringOf(v.ctaHref).trim(),
    hasLabelKey: "ctaLabel" in v,
    hasHrefKey: "ctaHref" in v,
    legacy: legacyPresent
      ? {
          present: true,
          labelEn: textOf(v.CtaLabel, "en").trim(),
          labelAr: textOf(v.CtaLabel, "ar").trim(),
          href: stringOf(v.CtaHref).trim(),
        }
      : null,
  };
}

const sameCta = (a: Cta, b: Cta) => a.labelEn === b.labelEn && a.labelAr === b.labelAr && a.href === b.href;
const hasAny = (cta: Cta) => Boolean(cta.labelEn || cta.labelAr || cta.href);
/** Whether an English page draws the button: an English label and a link. */
const drawsEn = (cta: Cta) => Boolean(cta.labelEn && cta.href);
/** Whether an Arabic page does: its own label, or the English one it falls back to, and a link. */
const drawsAr = (cta: Cta) => Boolean((cta.labelAr || cta.labelEn) && cta.href);

/** The seeded sections of a page, by block type, in order. */
function seedFor(slug: string, blockType: string, ordinal: number): Cta | null {
  const seeded: SeedSection[] = slug === "home" ? HOME_SECTIONS : (PAGE_SECTIONS[slug] ?? []);
  const same = seeded.filter((section) => section.blockType === blockType);
  const match = same[ordinal];
  if (!match) return null;
  const cta = storedCta(match.values);
  return hasAny(cta) ? { labelEn: cta.labelEn, labelAr: cta.labelAr, href: cta.href } : null;
}

/** The call to action each published version recorded for one section, newest first. */
function historyFor(sectionId: number, versions: VersionInput[]): AuditRow["history"] {
  const out: AuditRow["history"] = [];
  for (const version of versions) {
    const snapshot = version.snapshot;
    if (!isRecord(snapshot) || !Array.isArray(snapshot.sections)) continue;
    for (const entry of snapshot.sections) {
      if (!isRecord(entry) || entry.sourceSectionId !== sectionId) continue;
      const cta = storedCta(isRecord(entry.published) ? entry.published : null);
      if (!hasAny(cta)) continue;
      const value = { labelEn: cta.labelEn, labelAr: cta.labelAr, href: cta.href };
      if (out.some((seen) => sameCta(seen, value))) continue;
      out.push({ ...value, versionId: version.id, createdAt: new Date(version.created_at).toISOString() });
    }
  }
  return out;
}

const RANK: Record<Severity | "ok", number> = { ok: 0, info: 1, review: 2, suspect: 3 };

export function auditSections(input: {
  sections: SectionInput[];
  components: ComponentInput[];
  versions: VersionInput[];
}): AuditRow[] {
  const sources = new Map<number, ComponentSource>();
  for (const component of input.components) {
    sources.set(component.id, {
      id: component.id,
      kind: component.kind,
      values: component.published,
      version: component.published_version,
    });
  }
  const lookup = (id: number) => sources.get(id);
  const ordinals = new Map<string, number>();
  const rows: AuditRow[] = [];

  for (const section of input.sections) {
    const key = `${section.page_id}:${section.block_type}`;
    const ordinal = ordinals.get(key) ?? 0;
    ordinals.set(key, ordinal + 1);

    const publishedValues = section.published ?? {};
    const published = storedCta(publishedValues);
    const draft = section.draft ? storedCta(section.draft) : null;
    const resolved = resolveReuse(section.block_type, publishedValues, lookup);
    const shownStored = storedCta(resolved.values);
    const shown = { labelEn: shownStored.labelEn, labelAr: shownStored.labelAr, href: shownStored.href };
    const references = readReuse(publishedValues, section.block_type);
    const links = resolved.instances.map((instance) => ({
      slot: instance.slot,
      componentId: instance.componentId,
      overrides: references[instance.slot]?.o ?? [],
      state: instance.state,
      ...(instance.reason ? { reason: instance.reason } : {}),
      version: instance.version ?? null,
    }));
    const history = historyFor(section.id, input.versions);
    const seedReference = seedFor(section.slug, section.block_type, ordinal);
    const findings: Finding[] = [];
    const legacyText = published.legacy && hasAny(published.legacy);

    if (published.legacy) {
      findings.push({
        code: "legacy-keys",
        severity: "suspect",
        message:
          "Saved through the admin form that had the registry defect: it stores CtaLabel/CtaHref" +
          (legacyText ? `, holding ${quote(published.legacy)} — text that was never displayed` : ", empty") +
          (published.hasLabelKey || published.hasHrefKey ? "." : ", and its ctaLabel/ctaHref were dropped."),
      });
    }
    const buttonEn = drawsEn(shown);
    const buttonAr = drawsAr(shown);
    if (!buttonEn && !buttonAr && hasAny(shown)) {
      findings.push({
        code: "button-hidden",
        severity: "suspect",
        message: `Visitors see no button: ${shown.href ? "the label is empty" : "the link is empty"} while the ${shown.href ? "link" : "label"} is set.`,
      });
    } else if (!buttonEn && !buttonAr) {
      const evidence = history.length > 0 || Boolean(legacyText);
      findings.push({
        code: evidence ? "no-button-with-evidence" : "no-button",
        severity: evidence ? "suspect" : "review",
        message: evidence
          ? "Visitors see no button, and an earlier value exists (see history / legacy keys)."
          : "Visitors see no button and nothing stored says there ever was one — confirm this is intended" +
            (seedReference ? " (a fresh installation seeds one; see the seed reference)." : "."),
      });
    }
    if (buttonEn && !shown.labelAr) {
      findings.push({
        code: "arabic-falls-back",
        severity: "review",
        message: "The Arabic label is empty, so Arabic pages show the English label. Often intended — confirm.",
      });
    }
    if (!buttonEn && buttonAr) {
      findings.push({
        code: "english-missing",
        severity: "suspect",
        message: "The English label is empty while the Arabic one is set: English pages draw no button.",
      });
    }
    for (const link of links) {
      if (link.state !== "linked") {
        findings.push({
          code: "link-unavailable",
          severity: "suspect",
          message: `Linked to reusable component #${link.componentId} (${link.reason ?? "unavailable"}); the section's own fallback is drawn.`,
        });
      }
    }
    if (links.length && !sameCta(shown, published)) {
      findings.push({
        code: "shown-differs-from-fallback",
        severity: "info",
        message: `Visitors see the component's ${quote(shown)}; the section's stored fallback is ${quote(published)}.`,
      });
    }
    if (draft && !sameCta(draft, published)) {
      const hides = drawsEn(published) && !drawsEn(draft) && !Object.keys(readReuse(section.draft, section.block_type)).length;
      findings.push({
        code: hides ? "draft-hides-button" : "draft-changes-cta",
        severity: hides ? "suspect" : "info",
        message: hides
          ? `The pending draft would remove the button (draft: ${quote(draft)}).`
          : `The pending draft changes the call to action to ${quote(draft)}.`,
      });
    }
    if (history.length && !history.some((entry) => sameCta(entry, shown))) {
      findings.push({
        code: "differs-from-history",
        severity: "info",
        message: `Earlier published versions recorded ${history.map((entry) => `${quote(entry)} (#${entry.versionId})`).join(", ")}.`,
      });
    }

    const worst = findings.reduce<Severity | "ok">((acc, finding) => (RANK[finding.severity] > RANK[acc] ? finding.severity : acc), "ok");
    rows.push({
      pageId: section.page_id,
      slug: section.slug,
      pageTitle: section.page_title,
      sectionId: section.id,
      blockType: section.block_type,
      position: section.position,
      visible: section.is_published,
      draftOnly: section.is_draft_only,
      published,
      draft,
      links,
      shown: { ...shown, buttonEn, buttonAr },
      history,
      seedReference,
      findings,
      worst,
    });
  }
  return rows;
}

export function quote(cta: Cta): string {
  return `EN "${cta.labelEn}" · AR "${cta.labelAr}" · link "${cta.href}"`;
}

export function formatReport(rows: AuditRow[], options: { all?: boolean } = {}): string {
  const lines: string[] = [];
  const shown = options.all ? rows : rows.filter((row) => row.worst !== "ok" && row.worst !== "info");
  const order = [...shown].sort((a, b) => RANK[b.worst] - RANK[a.worst] || a.pageId - b.pageId || a.position - b.position);
  for (const row of order) {
    lines.push(
      `${row.worst.toUpperCase().padEnd(7)} /${row.slug === "home" ? "" : row.slug} · section ${row.sectionId} · ${row.blockType} ` +
        `(position ${row.position}${row.visible ? "" : ", hidden"}${row.draftOnly ? ", draft only" : ""})`,
    );
    const keys = [row.published.hasLabelKey ? "" : "ctaLabel key missing", row.published.hasHrefKey ? "" : "ctaHref key missing"].filter(Boolean);
    lines.push(`  published    ${quote(row.published)}${keys.length ? `   [${keys.join(" · ")}]` : ""}`);
    if (row.published.legacy) lines.push(`  legacy keys  ${quote(row.published.legacy)}   (written by the pre-15b form; never displayed)`);
    if (row.draft) lines.push(`  draft        ${quote(row.draft)}`);
    for (const link of row.links) {
      lines.push(`  linked       ${link.slot} → component #${link.componentId} (${link.state}${link.reason ? `: ${link.reason}` : ""}${link.overrides.length ? `; overrides ${link.overrides.join(", ")}` : ""})`);
    }
    lines.push(
      `  visitors see ${row.shown.buttonEn || row.shown.buttonAr ? quote(row.shown) : "no button"}` +
        (row.shown.buttonEn !== row.shown.buttonAr ? `   (button on ${row.shown.buttonEn ? "English" : "Arabic"} pages only)` : ""),
    );
    for (const entry of row.history) lines.push(`  history #${entry.versionId} ${entry.createdAt}  ${quote(entry)}`);
    if (row.seedReference) lines.push(`  seed ref.    ${quote(row.seedReference)}   (reference only — not a proposed value)`);
    for (const finding of row.findings) lines.push(`  - [${finding.severity}] ${finding.code}: ${finding.message}`);
    lines.push("");
  }
  const count = (severity: Severity | "ok") => rows.filter((row) => row.worst === severity).length;
  lines.push(
    `Summary: ${rows.length} section(s) audited · ${count("suspect")} suspect · ${count("review")} review · ${count("info")} info only · ${count("ok")} ok`,
  );
  return lines.join("\n");
}
