import { getBlock, type FieldDef, type ItemFieldDef } from "@/lib/cms/blocks";
import { ITEM_ID_KEY } from "@/lib/cms/item-id";
import { motionOf } from "@/lib/cms/motion";
import {
  effectiveSectionTarget,
  type MotionBranch,
  type MotionDocument,
} from "@/lib/cms/motion-doc";
import { overrideLabel, readReuse, slotDef } from "@/lib/cms/reuse/reference";
import type { PageSnapshot, SnapshotSection } from "@/lib/cms/snapshot";
import { SPACING_STEPS, type StyleDocument, type StyleTokens } from "@/lib/cms/styles";

import {
  BREAKPOINT_LABEL,
  diffMotionDocuments,
  diffStyleDocuments,
  nodeLabel,
  sameValue,
  type DocumentLeaf,
} from "./history";
import { blockNameOf } from "./labels";
import { MOTION_FIELD_LABELS, motionValueLabel } from "./motion-targets";
import { STYLE_TOKEN_LABELS, STYLE_VALUE_LABELS } from "./style-targets";

/**
 * Version Compare's structured half (Batch 16): what differs between two
 * states of one page, said the way an editor would say it.
 *
 * Both sides are page snapshots — the immutable `page_versions` document for a
 * historical state, and the same shape captured from the live rows for the
 * current published page — so one comparison serves every pair. Nothing here
 * reads the database, writes anything or renders anything: it is a pure
 * function of two documents, tested on its own.
 *
 * Four rules keep it honest.
 *
 *   · **Identity, not position.** A section is matched by the id of the row it
 *     came from, and a repeatable row by its `_id`. A section that moved is a
 *     move, not a removal and an addition; two rows that swapped are a
 *     reorder, not two rewritten rows. A section with no id in common is
 *     Added or Removed — a section recreated by a restore is a new row, and
 *     nothing here pretends otherwise.
 *   · **Moves are the smallest set.** When several sections change place, the
 *     ones reported as moved are those outside the longest run that kept its
 *     relative order — moving one section down past three is one move, not
 *     three.
 *   · **Words, not documents.** A field is named by the registry's label, a
 *     style by its token's label, a motion setting by the Motion panel's
 *     label, a width as Desktop, Tablet or Mobile. No JSON, no CSS variables,
 *     no raw paths.
 *   · **The real choice, not the projection.** A section's entrance is
 *     compared as the section renders it — the document's own target with the
 *     legacy preset standing in only where the document names nothing — so a
 *     Blur is reported as Blur and never as the Fade the legacy column
 *     approximates it with.
 */

export type ValueChange = {
  /** Where, in words: "Card 2 → Label (English)", "Title → Mobile → Gap". */
  label: string;
  before: string;
  after: string;
};

export type SectionStatus = "added" | "removed" | "changed" | "unchanged";

export type SectionDiff = {
  /** Stable within one comparison: the section id, or the side and index for one without. */
  key: string;
  /** The row this section came from, when both sides agree on one. */
  sectionId: number | null;
  blockType: string;
  /** The block's name, and what the section says it is about when it says. */
  name: string;
  status: SectionStatus;
  /** 1-based places in each state's full order (hidden sections count). */
  position: { before: number | null; after: number | null };
  moved: boolean;
  visible: { before: boolean | null; after: boolean | null };
  content: ValueChange[];
  style: ValueChange[];
  motion: ValueChange[];
  /**
   * Reusable-component references (Batch 17): linked, detached, relinked, the
   * component's published version the page showed, and overrides switched on
   * or off — by component name. What the linked content *said* is in
   * `content`, because a snapshot keeps the words visitors saw.
   */
  reuse: ValueChange[];
};

export type PageDiff = {
  sections: SectionDiff[];
  counts: {
    added: number;
    removed: number;
    moved: number;
    visibility: number;
    content: number;
    style: number;
    motion: number;
    reuse: number;
    unchanged: number;
  };
};

/* -------------------------------------------------------------------------- */
/* Values in words                                                            */
/* -------------------------------------------------------------------------- */

const EXCERPT = 90;
const LANGUAGE = { en: "English", ar: "Arabic" } as const;

/** Text as a person reads it: tags, entities and runs of whitespace gone. */
function plainText(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Text as a person reads it, long text cut. */
export function excerpt(value: unknown): string {
  if (value === null || value === undefined || value === "") return "(empty)";
  if (typeof value === "boolean") return value ? "On" : "Off";
  if (typeof value !== "string") return String(value);
  const text = plainText(value);
  if (!text) return "(empty)";
  return text.length > EXCERPT ? `${text.slice(0, EXCERPT - 1).trimEnd()}…` : text;
}

/**
 * Two versions of one text, excerpted so the difference is visible.
 *
 * Two cases would otherwise print the same words on both sides: an edit past
 * the first few words of a long text, and an edit that only changed the
 * formatting (a word made bold, a paragraph split). The first is excerpted
 * from just before the first character that differs, on both sides alike; the
 * second is said in words, because there is no text to show.
 */
export function changedText(before: unknown, after: unknown): { before: string; after: string; formatting: boolean } {
  if (typeof before !== "string" || typeof after !== "string") {
    return { before: excerpt(before), after: excerpt(after), formatting: false };
  }
  const x = plainText(before);
  const y = plainText(after);
  if (x === y) return { before: excerpt(before), after: excerpt(after), formatting: before !== after };
  let at = 0;
  while (at < x.length && at < y.length && x[at] === y[at]) at += 1;
  const start = at > EXCERPT - 30 ? at - 30 : 0;
  const clip = (text: string): string => {
    if (!text) return "(empty)";
    const body = text.slice(start);
    const cut = body.length > EXCERPT ? `${body.slice(0, EXCERPT - 1).trimEnd()}…` : body;
    return start > 0 ? `…${cut.trimStart()}` : cut;
  };
  return { before: clip(x), after: clip(y), formatting: false };
}

/** One text field's change, in words — "formatting only" when that is all it was. */
const textChange = (label: string, before: unknown, after: unknown): ValueChange => {
  const shown = changedText(before, after);
  return { label: shown.formatting ? `${label} · formatting only` : label, before: shown.before, after: shown.after };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const rowIdOf = (row: unknown): string | null =>
  isRecord(row) && typeof row[ITEM_ID_KEY] === "string" ? (row[ITEM_ID_KEY] as string) : null;

/** A style value in the Style panel's own words. */
export function styleValueLabel(token: keyof StyleTokens, value: unknown): string {
  if (value === undefined) return "Default";
  if (token === "hidden") return value ? "Hidden" : "Shown";
  if (token === "opacity" && typeof value === "number") return `${Math.round(value * 100)}%`;
  if ((token === "objectX" || token === "objectY") && typeof value === "number") return `${value}%`;
  if (
    ["padBlock", "padInline", "marginBlock", "marginInline", "gap"].includes(token) &&
    typeof value === "number"
  ) {
    return `step ${value} of ${SPACING_STEPS}`;
  }
  if (token === "columns" && typeof value === "number") return `${value} column${value === 1 ? "" : "s"}`;
  const text = String(value);
  return STYLE_VALUE_LABELS[text] ?? text.charAt(0).toUpperCase() + text.slice(1);
}

/** A select field's value, by its option label. */
const optionLabel = (field: FieldDef, value: unknown): string =>
  field.options?.find((option) => option.value === value)?.label ?? excerpt(value);

/* -------------------------------------------------------------------------- */
/* Content                                                                    */
/* -------------------------------------------------------------------------- */

/** A row named by its first declared field — the one `items()` calls its primary text. */
function rowName(row: unknown, fields: readonly ItemFieldDef[]): string {
  if (!isRecord(row)) return "a row";
  const primary = fields[0];
  if (!primary) return "a row";
  const raw = row[primary.name];
  const text = isRecord(raw) ? String(raw.en || raw.ar || "") : typeof raw === "string" ? raw : "";
  return text.trim() ? `“${excerpt(text)}”` : "a row";
}

/** Items in one order kept their relative order in the other — longest such run. */
function longestKept(order: readonly number[]): Set<number> {
  // Longest increasing subsequence of positions, returned as the set of
  // indexes into `order` that belong to it.
  const tails: number[] = [];
  const tailIndex: number[] = [];
  const previous: number[] = new Array(order.length).fill(-1);
  for (let i = 0; i < order.length; i += 1) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid]! < order[i]!) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = order[i]!;
    tailIndex[lo] = i;
    previous[i] = lo > 0 ? tailIndex[lo - 1]! : -1;
  }
  const kept = new Set<number>();
  let at = tails.length ? tailIndex[tails.length - 1]! : -1;
  while (at >= 0) {
    kept.add(at);
    at = previous[at]!;
  }
  return kept;
}

function itemChanges(field: FieldDef, before: unknown, after: unknown): ValueChange[] {
  const fields = field.itemFields ?? [];
  const was = Array.isArray(before) ? before : [];
  const now = Array.isArray(after) ? after : [];
  const wasById = new Map(was.map((row) => [rowIdOf(row), row] as const).filter(([id]) => id !== null));
  const nowById = new Map(now.map((row) => [rowIdOf(row), row] as const).filter(([id]) => id !== null));
  const out: ValueChange[] = [];

  for (const row of was) {
    const id = rowIdOf(row);
    if (id === null || !nowById.has(id)) {
      out.push({ label: `${field.label} → row removed`, before: rowName(row, fields), after: "(none)" });
    }
  }
  for (const row of now) {
    const id = rowIdOf(row);
    if (id === null || !wasById.has(id)) {
      out.push({ label: `${field.label} → row added`, before: "(none)", after: rowName(row, fields) });
    }
  }

  // Rows on both sides: did they keep their order, and what changed inside them?
  const common = now.map(rowIdOf).filter((id): id is string => id !== null && wasById.has(id));
  const wasOrder = was.map(rowIdOf).filter((id): id is string => id !== null && nowById.has(id));
  const kept = longestKept(common.map((id) => wasOrder.indexOf(id)));
  const moved = common.filter((_, index) => !kept.has(index));
  if (moved.length) {
    out.push({
      label: `${field.label} → rows reordered`,
      before: wasOrder.map((id) => rowName(wasById.get(id), fields)).join(", "),
      after: common.map((id) => rowName(nowById.get(id), fields)).join(", "),
    });
  }

  for (const id of common) {
    const a = wasById.get(id) as Record<string, unknown>;
    const b = nowById.get(id) as Record<string, unknown>;
    const name = rowName(b, fields);
    for (const sub of fields) {
      const x = a[sub.name];
      const y = b[sub.name];
      if (sameValue(x, y)) continue;
      if (sub.localised && isRecord(x) && isRecord(y)) {
        for (const locale of ["en", "ar"] as const) {
          if (!sameValue(x[locale], y[locale])) {
            out.push(textChange(`${field.label} → ${name} → ${sub.label} (${LANGUAGE[locale]})`, x[locale], y[locale]));
          }
        }
        continue;
      }
      out.push(
        sub.type === "media"
          ? { label: `${field.label} → ${name} → ${sub.label}`, before: mediaLabel(x), after: mediaLabel(y) }
          : textChange(`${field.label} → ${name} → ${sub.label}`, x, y),
      );
    }
  }
  return out;
}

const mediaLabel = (value: unknown): string =>
  typeof value === "number" && value > 0 ? `library picture #${value}` : "(none)";

/** Every field that differs between two sections' published values, in registry order. */
export function contentChanges(
  blockType: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ValueChange[] {
  const block = getBlock(blockType);
  if (!block) return [];
  const out: ValueChange[] = [];
  for (const field of block.fields) {
    const x = before[field.name];
    const y = after[field.name];
    if (sameValue(x, y)) continue;
    if (field.type === "items") {
      out.push(...itemChanges(field, x, y));
      continue;
    }
    if (field.localised && isRecord(x) && isRecord(y)) {
      for (const locale of ["en", "ar"] as const) {
        if (!sameValue(x[locale], y[locale])) out.push(textChange(`${field.label} (${LANGUAGE[locale]})`, x[locale], y[locale]));
      }
      continue;
    }
    out.push(
      field.type === "media"
        ? { label: field.label, before: mediaLabel(x), after: mediaLabel(y) }
        : field.type === "select"
          ? { label: field.label, before: optionLabel(field, x), after: optionLabel(field, y) }
          : textChange(field.label, x, y),
    );
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Style and motion                                                           */
/* -------------------------------------------------------------------------- */

const where = (leaf: DocumentLeaf, blockType: string, values: Record<string, unknown>) =>
  `${nodeLabel(blockType, leaf.node, values, "en")} → ${BREAKPOINT_LABEL[leaf.breakpoint]}`;

export function styleChanges(
  blockType: string,
  before: StyleDocument,
  after: StyleDocument,
  values: Record<string, unknown>,
): ValueChange[] {
  return diffStyleDocuments(before, after).map((leaf) => ({
    label: `${where(leaf, blockType, values)} → ${STYLE_TOKEN_LABELS[leaf.key as keyof StyleTokens] ?? leaf.key}`,
    before: styleValueLabel(leaf.key as keyof StyleTokens, leaf.before),
    after: styleValueLabel(leaf.key as keyof StyleTokens, leaf.after),
  }));
}

/**
 * A section's motion as it renders: the document, with the section's own
 * target made effective the way `SectionRenderer` makes it.
 */
const effectiveMotion = (section: SnapshotSection): MotionDocument => ({
  v: 1,
  section: effectiveSectionTarget(section.motion ?? null, motionOf(section.animation)),
  nodes: section.motion?.nodes ?? {},
});

const motionValue = (key: keyof MotionBranch, value: unknown): string =>
  value === undefined ? "Default" : motionValueLabel(key, value) || String(value);

export function motionChanges(before: SnapshotSection, after: SnapshotSection): ValueChange[] {
  return diffMotionDocuments(effectiveMotion(before), effectiveMotion(after)).map((leaf) => ({
    label: `${where(leaf, after.blockType, after.published)} → ${MOTION_FIELD_LABELS[leaf.key as keyof MotionBranch] ?? leaf.key}`,
    before: motionValue(leaf.key as keyof MotionBranch, leaf.before),
    after: motionValue(leaf.key as keyof MotionBranch, leaf.after),
  }));
}

/* -------------------------------------------------------------------------- */
/* Reusable components                                                        */
/* -------------------------------------------------------------------------- */

/** A component by name — never by id, and honestly when it has gone. */
const componentName = (id: number, names: ReadonlyMap<number, string>): string => {
  const name = names.get(id);
  return name ? `“${name}”` : "a reusable component that no longer exists";
};

/**
 * What changed about a section's reusable-component references between two
 * states: a slot linked (from local content), detached (to local content),
 * linked to a different component, the component's published version the page
 * showed, and overrides switched on or off. Names, not ids.
 */
export function reuseChanges(
  blockType: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  names: ReadonlyMap<number, string> = new Map(),
): ValueChange[] {
  const was = readReuse(before, blockType, { pins: true });
  const now = readReuse(after, blockType, { pins: true });
  const out: ValueChange[] = [];
  for (const slot of [...new Set([...Object.keys(was), ...Object.keys(now)])].sort()) {
    const label = slotDef(blockType, slot)?.label ?? slot;
    const a = was[slot];
    const b = now[slot];
    if (!a && b) {
      out.push({ label: `${label} → reusable component`, before: "Local content", after: `Linked to ${componentName(b.c, names)}` });
      continue;
    }
    if (a && !b) {
      out.push({ label: `${label} → reusable component`, before: `Linked to ${componentName(a.c, names)}`, after: "Detached — local content" });
      continue;
    }
    if (!a || !b) continue;
    if (a.c !== b.c) {
      out.push({
        label: `${label} → reusable component`,
        before: `Linked to ${componentName(a.c, names)}`,
        after: `Linked to ${componentName(b.c, names)}`,
      });
      continue;
    }
    if (a.v !== undefined && b.v !== undefined && a.v !== b.v) {
      out.push({
        label: `${label} → ${componentName(b.c, names)} · global change`,
        before: `Version ${a.v}`,
        after: `Version ${b.v}`,
      });
    }
    const had = new Set(a.o ?? []);
    const has = new Set(b.o ?? []);
    for (const key of [...has].filter((entry) => !had.has(entry)).sort()) {
      out.push({ label: `${label} → ${overrideLabel(blockType, slot, key)}`, before: "Inherited", after: "Override added on this page" });
    }
    for (const key of [...had].filter((entry) => !has.has(entry)).sort()) {
      out.push({ label: `${label} → ${overrideLabel(blockType, slot, key)}`, before: "Override on this page", after: "Override reset — inherited" });
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* The page                                                                   */
/* -------------------------------------------------------------------------- */

/** What a section is called in the summary: its block, and its own title when it has one. */
function sectionName(section: SnapshotSection): string {
  const values = section.published;
  const title = ["title", "headline", "heading", "eyebrow"]
    .map((key) => values[key])
    .map((value) => (isRecord(value) ? String(value.en || value.ar || "") : typeof value === "string" ? value : ""))
    .find((text) => text.trim());
  const block = blockNameOf(section.blockType);
  return title ? `${block} — “${excerpt(title)}”` : block;
}

const idOf = (section: SnapshotSection): number | null =>
  Number.isInteger(section.sourceSectionId) && section.sourceSectionId > 0 ? section.sourceSectionId : null;

/**
 * The difference between two states of one page, `before` → `after`, in the
 * order a person reads the page: the newer state's order, with anything that
 * is gone shown where it used to be.
 */
export function diffSnapshots(
  before: PageSnapshot,
  after: PageSnapshot,
  names: ReadonlyMap<number, string> = new Map(),
): PageDiff {
  // Identity: an id that appears once on each side. A repeated or missing id
  // proves nothing, and the section is compared as added and removed.
  const counted = (snapshot: PageSnapshot) => {
    const seen = new Map<number, number>();
    for (const section of snapshot.sections) {
      const id = idOf(section);
      if (id !== null) seen.set(id, (seen.get(id) ?? 0) + 1);
    }
    return seen;
  };
  const beforeIds = counted(before);
  const afterIds = counted(after);
  const shared = new Set(
    [...beforeIds.keys()].filter((id) => beforeIds.get(id) === 1 && afterIds.get(id) === 1),
  );
  const beforeAt = new Map<number, number>();
  before.sections.forEach((section, index) => {
    const id = idOf(section);
    if (id !== null && shared.has(id)) beforeAt.set(id, index);
  });

  // Moves: outside the longest run of shared sections that kept their order.
  const sharedAfter = after.sections
    .map((section, index) => ({ id: idOf(section), index }))
    .filter((entry): entry is { id: number; index: number } => entry.id !== null && shared.has(entry.id));
  const kept = longestKept(sharedAfter.map((entry) => beforeAt.get(entry.id)!));
  const movedIds = new Set(sharedAfter.filter((_, index) => !kept.has(index)).map((entry) => entry.id));

  const diffs: SectionDiff[] = [];
  const emittedBefore = new Set<number>();

  const removed = (section: SnapshotSection, index: number): SectionDiff => ({
    key: `before:${index}`,
    sectionId: idOf(section),
    blockType: section.blockType,
    name: sectionName(section),
    status: "removed",
    position: { before: index + 1, after: null },
    moved: false,
    visible: { before: section.visible, after: null },
    content: [],
    style: [],
    motion: [],
    reuse: [],
  });

  const emitRemovedBefore = (limit: number) => {
    for (let index = 0; index < limit; index += 1) {
      const section = before.sections[index]!;
      const id = idOf(section);
      if (emittedBefore.has(index)) continue;
      if (id !== null && shared.has(id)) continue;
      emittedBefore.add(index);
      diffs.push(removed(section, index));
    }
  };

  after.sections.forEach((section, afterIndex) => {
    const id = idOf(section);
    if (id === null || !shared.has(id)) {
      diffs.push({
        key: `after:${afterIndex}`,
        sectionId: id,
        blockType: section.blockType,
        name: sectionName(section),
        status: "added",
        position: { before: null, after: afterIndex + 1 },
        moved: false,
        visible: { before: null, after: section.visible },
        content: [],
        style: [],
        motion: [],
        reuse: reuseChanges(section.blockType, {}, section.published, names),
      });
      return;
    }
    const beforeIndex = beforeAt.get(id)!;
    emitRemovedBefore(beforeIndex);
    const was = before.sections[beforeIndex]!;
    // A block type that changed under one id is not an edit of one section.
    if (was.blockType !== section.blockType) {
      diffs.push(removed(was, beforeIndex));
      diffs.push({
        key: `after:${afterIndex}`,
        sectionId: null,
        blockType: section.blockType,
        name: sectionName(section),
        status: "added",
        position: { before: null, after: afterIndex + 1 },
        moved: false,
        visible: { before: null, after: section.visible },
        content: [],
        style: [],
        motion: [],
        reuse: reuseChanges(section.blockType, {}, section.published, names),
      });
      return;
    }
    const content = contentChanges(section.blockType, was.published, section.published);
    const style = styleChanges(section.blockType, was.styles, section.styles, section.published);
    const motion = motionChanges(was, section);
    const reuse = reuseChanges(section.blockType, was.published, section.published, names);
    const moved = movedIds.has(id);
    const visibilityChanged = was.visible !== section.visible;
    const changed =
      moved || visibilityChanged || content.length > 0 || style.length > 0 || motion.length > 0 || reuse.length > 0;
    diffs.push({
      key: `section:${id}`,
      sectionId: id,
      blockType: section.blockType,
      name: sectionName(section),
      status: changed ? "changed" : "unchanged",
      position: { before: beforeIndex + 1, after: afterIndex + 1 },
      moved,
      visible: { before: was.visible, after: section.visible },
      content,
      style,
      motion,
      reuse,
    });
  });
  emitRemovedBefore(before.sections.length);

  const counts = {
    added: diffs.filter((entry) => entry.status === "added").length,
    removed: diffs.filter((entry) => entry.status === "removed").length,
    moved: diffs.filter((entry) => entry.moved).length,
    visibility: diffs.filter(
      (entry) => entry.visible.before !== null && entry.visible.after !== null && entry.visible.before !== entry.visible.after,
    ).length,
    content: diffs.filter((entry) => entry.content.length > 0).length,
    style: diffs.filter((entry) => entry.style.length > 0).length,
    motion: diffs.filter((entry) => entry.motion.length > 0).length,
    reuse: diffs.filter((entry) => entry.reuse.length > 0).length,
    unchanged: diffs.filter((entry) => entry.status === "unchanged").length,
  };
  return { sections: diffs, counts };
}

/* -------------------------------------------------------------------------- */
/* What a snapshot does not hold                                              */
/* -------------------------------------------------------------------------- */

/**
 * The blocks that draw something from live data rather than from their own
 * stored values, and what that data is.
 *
 * A page version keeps each block's configuration — its text, its choices,
 * its limits — and not a copy of the catalogue, the testimonials or the site
 * settings it read when it was published. Compare renders both sides with
 * today's data, so for these blocks the two panes can agree where the page did
 * not, and the screen says so. `tests/version-compare.test.ts` holds this list
 * against what each block's source actually reads.
 */
export const DYNAMIC_SOURCES: Readonly<Record<string, string>> = {
  "service-grid": "the service catalogue",
  "packages-grid": "tour packages and destinations",
  "video-showcase": "the video library and the “show videos” site setting",
  testimonials: "testimonials and the “show testimonials” site setting",
  faq: "the FAQ list",
  "contact-details": "contact settings, the WhatsApp number and the service catalogue",
  "quick-links": "catalogue pictures, for links without a picture of their own",
  stats: "the “show statistics” site setting",
  "final-cta": "the WhatsApp setting",
};

/** The live sources two states of a page depend on, once each, in page order. */
export function dynamicSourcesOf(...snapshots: PageSnapshot[]): { blockType: string; name: string; source: string }[] {
  const seen = new Set<string>();
  const out: { blockType: string; name: string; source: string }[] = [];
  for (const snapshot of snapshots) {
    for (const section of snapshot.sections) {
      const source = DYNAMIC_SOURCES[section.blockType];
      if (!source || seen.has(section.blockType)) continue;
      seen.add(section.blockType);
      out.push({ blockType: section.blockType, name: blockNameOf(section.blockType), source });
    }
  }
  return out;
}

/** Said on every comparison: the page's own content is versioned, the site around it is not. */
export const GLOBAL_DISCLAIMER =
  "Global site elements use their current settings and are not part of this page version.";

/**
 * Said whenever a compared state links to a reusable component (Batch 17), and
 * said as the distinction it is: site globals above are today's, but a
 * version keeps what its linked sections showed — the component's content as
 * it was published then, with the version number — so both panes are
 * historical. Restoring brings the link back rather than a frozen copy.
 */
export const REUSE_DISCLAIMER =
  "Reusable components are not site globals: this page version records which component version each " +
  "linked section showed, and both panes show that content as it was published then. Restoring the " +
  "version links those sections again, and they then show the component's current published content.";

/** Whether any compared state links to a reusable component. */
export const hasReuse = (...snapshots: PageSnapshot[]): boolean =>
  snapshots.some((snapshot) =>
    snapshot.sections.some((section) => Object.keys(readReuse(section.published, section.blockType)).length > 0),
  );

/** Every component id the compared states link to — for looking their names up. */
export const reusedIds = (...snapshots: PageSnapshot[]): number[] => [
  ...new Set(
    snapshots.flatMap((snapshot) =>
      snapshot.sections.flatMap((section) =>
        Object.values(readReuse(section.published, section.blockType)).map((entry) => entry.c),
      ),
    ),
  ),
];

/** Said whenever a compared state contains a block from `DYNAMIC_SOURCES`. */
export const DYNAMIC_DISCLAIMER =
  "Dynamic catalogue/global content reflects current data; the page version stores the block configuration, not a historical copy of that dataset.";

/** Said about pictures, which every version refers to by library id. */
export const MEDIA_DISCLAIMER =
  "Pictures are shown from the current media library: a version stores which picture was chosen, not the file.";
