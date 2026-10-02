import { getEditorBlock, type FieldDef, type ItemFieldDef } from "@/lib/cms/blocks";
import { ITEM_ID_KEY } from "@/lib/cms/item-id";
import type { MotionBranch, MotionDocument } from "@/lib/cms/motion-doc";
import { BREAKPOINTS, type Breakpoint, type StyleDocument, type StyleTokens } from "@/lib/cms/styles";
import type { DraftStructure } from "@/lib/cms/structure";
import type { Locale } from "@/lib/i18n/config";

import { blockNameOf, describeStoredPath } from "./labels";
import { MOTION_FIELD_LABELS } from "./motion-targets";
import { STYLE_TOKEN_LABELS } from "./style-targets";

/**
 * Undo and Redo for the Visual Editor (Batch 16): one page-scoped history of
 * what an editor did in this editing session.
 *
 * ## What it is, and what it is not
 *
 * **It is the session's list of recent actions on the page** — a heading
 * retyped, a gap changed at Mobile, an entrance set to Blur, a section moved —
 * in the order they happened, so Undo takes back the last one and Redo puts it
 * back. It lives in the browser, in memory, and nowhere else.
 *
 * **It is not a second save path, and not a rollback.** Undoing a content,
 * style or motion action writes the earlier value back into the section's
 * ordinary edit buffer, and the ordinary autosave carries it to the server —
 * the same debounce, the same Content → Style → Motion queue, the same
 * validator, revision guard, CSRF token and conflict behaviour as typing it.
 * Undoing a layout action runs the ordinary structural operation that reverses
 * it, guarded on the page revision like any other. Nothing here deletes a
 * database write or reverts a transaction: the draft simply moves on to the
 * state the editor wants, which is how autosaved work can be undone at all.
 * Published history is Version History's — a different thing, kept on the
 * server — and this module never touches it.
 *
 * ## One history, not four
 *
 * Content, Style, Motion and layout are one timeline because they are one
 * editor: undoing after "edit heading, change padding, set Blur, move section"
 * reverses the move first and the heading last. Per-domain stacks would make
 * Undo mean four different things depending on which tab was open.
 *
 * ## What an entry holds
 *
 * Only what the action changed, never application state:
 *
 *   · **content** — the changed values, each located by field, by row `_id` (never
 *     by position) and by edition, so an Arabic edit undoes the Arabic text
 *     whatever language the canvas has switched to since;
 *   · **style** / **motion** — the section's document before and after, which
 *     carries the breakpoint with it: a Mobile gap undoes at Mobile even while
 *     Desktop is on screen;
 *   · **layout** — the page's draft structure before and after, by section id.
 *
 * No DOM, no React state, no media bytes, no database rows.
 *
 * ## Grouping
 *
 * An entry is a meaningful action, not a render. Typing into one field, or
 * dragging one slider, is a single entry for as long as it continues — the
 * "group" — and a pause of `GROUP_IDLE_MS`, leaving the field, committing a
 * direct edit, or touching anything else closes it. A select, a toggle, a
 * reset, a row added or removed and every layout change are one entry each and
 * never merge.
 *
 * Pure on purpose, like `acceptEdit` and `acceptReplayResult`: the rules can
 * be tested without a browser, and the shell only decides when to call them.
 */

/** How many actions one page keeps. The oldest goes first. */
export const HISTORY_LIMIT = 100;
/** How many pages keep a history at once in one editing session. */
export const HISTORY_PAGES = 10;
/** A pause longer than this closes a typing or dragging group. */
export const GROUP_IDLE_MS = 1500;

/** The sentence the editor shows when a history has to be thrown away. */
export const HISTORY_RESET = {
  section: "Undo history was reset because this section changed elsewhere.",
  layout: "Undo history was reset because this page's layout changed elsewhere.",
  failed: "Undo history was reset because that change could not be reversed here.",
} as const;

/**
 * The difference between this and Version History, in the words the toolbar
 * and the page panel both use.
 */
export const UNDO_SCOPE_NOTE =
  "Undo and Redo affect your current editing session. Version History lets you review or restore earlier published page states.";

export type HistoryDomain = "content" | "style" | "motion" | "structure";

/* -------------------------------------------------------------------------- */
/* Changes                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Where one content value lives: a field, optionally one row of it by its
 * stable `_id` and one of that row's fields, and optionally one edition.
 */
export type ContentPath = { field: string; itemId?: string; sub?: string; locale?: Locale };
export type ContentChange = { path: ContentPath; before: unknown; after: unknown };

export type StructureOp = "add" | "duplicate" | "reorder" | "visibility" | "remove" | "restore";

export type HistoryChange =
  | { domain: "content"; sectionId: number; blockType: string; changes: ContentChange[] }
  | { domain: "style"; sectionId: number; blockType: string; before: StyleDocument; after: StyleDocument }
  | { domain: "motion"; sectionId: number; blockType: string; before: MotionDocument; after: MotionDocument }
  | {
      domain: "structure";
      op: StructureOp;
      /** The section the operation was about, when it was about one. */
      sectionId: number | null;
      before: DraftStructure;
      after: DraftStructure;
    };

export type HistoryEntry = {
  /** Rises with every entry, so a list can key on it. */
  id: number;
  /** What the action was, in words: "Change Title (Arabic)". */
  label: string;
  /** Present while the action may still grow — typing or dragging one thing. */
  group: string | null;
  change: HistoryChange;
};

export type PageHistory = {
  undo: HistoryEntry[];
  redo: HistoryEntry[];
  /** The group the newest undo entry may still absorb, and when it last did. */
  open: { group: string; at: number } | null;
};

export const emptyHistory = (): PageHistory => ({ undo: [], redo: [], open: null });

/* -------------------------------------------------------------------------- */
/* Comparing values                                                           */
/* -------------------------------------------------------------------------- */

/** Two values mean the same thing, whatever order their keys were written in. */
export const sameValue = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

const canonical = (value: unknown): string =>
  JSON.stringify(value === undefined ? null : value, (_key, raw) =>
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? Object.fromEntries(
          Object.keys(raw as Record<string, unknown>)
            .sort()
            .map((key) => [key, (raw as Record<string, unknown>)[key]]),
        )
      : raw,
  ) ?? "null";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `{ en, ar }` — the shape of every localised value. */
const isLocalised = (value: unknown): value is Record<Locale, unknown> =>
  isRecord(value) && ("en" in value || "ar" in value) && Object.keys(value).every((key) => key === "en" || key === "ar");

const LOCALE_KEYS: readonly Locale[] = ["en", "ar"];

const copy = <T>(value: T): T => (value === undefined ? value : (structuredClone(value) as T));

const rowIdOf = (row: unknown): string | null =>
  isRecord(row) && typeof row[ITEM_ID_KEY] === "string" ? (row[ITEM_ID_KEY] as string) : null;

/* -------------------------------------------------------------------------- */
/* Content                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * What changed between two versions of one section's values, at the finest
 * place it can be said.
 *
 * A localised value changes per edition. A repeatable list whose rows kept
 * their ids and their order changes per row, per row field and per edition —
 * the row found by `_id`, never by position. A list that gained, lost or
 * reordered rows changes as a whole list, because that is the action the
 * editor took. Anything else changes whole.
 */
export function diffContent(
  blockType: string,
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): ContentChange[] {
  const fields = getEditorBlock(blockType)?.fields ?? [];
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const changes: ContentChange[] = [];

  for (const field of keys) {
    const was = before[field];
    const now = after[field];
    if (sameValue(was, now)) continue;
    const def = fields.find((candidate) => candidate.name === field);

    if (def?.type === "items" && Array.isArray(was) && Array.isArray(now)) {
      const wasIds = was.map(rowIdOf);
      const nowIds = now.map(rowIdOf);
      const sameRows =
        wasIds.length === nowIds.length &&
        wasIds.every((id, index) => id !== null && id === nowIds[index]);
      if (!sameRows) {
        changes.push({ path: { field }, before: copy(was), after: copy(now) });
        continue;
      }
      for (const [index, rowWas] of was.entries()) {
        const rowNow = now[index];
        const itemId = wasIds[index]!;
        const subs = [
          ...new Set([...Object.keys(rowWas as object), ...Object.keys(rowNow as object)]),
        ].filter((key) => key !== ITEM_ID_KEY);
        for (const sub of subs) {
          const a = (rowWas as Record<string, unknown>)[sub];
          const b = (rowNow as Record<string, unknown>)[sub];
          if (sameValue(a, b)) continue;
          if (isLocalised(a) && isLocalised(b)) {
            for (const locale of LOCALE_KEYS) {
              if (!sameValue(a[locale], b[locale])) {
                changes.push({ path: { field, itemId, sub, locale }, before: copy(a[locale]), after: copy(b[locale]) });
              }
            }
          } else {
            changes.push({ path: { field, itemId, sub }, before: copy(a), after: copy(b) });
          }
        }
      }
      continue;
    }

    if (isLocalised(was) && isLocalised(now)) {
      for (const locale of LOCALE_KEYS) {
        if (!sameValue(was[locale], now[locale])) {
          changes.push({ path: { field, locale }, before: copy(was[locale]), after: copy(now[locale]) });
        }
      }
      continue;
    }

    changes.push({ path: { field }, before: copy(was), after: copy(now) });
  }
  return changes;
}

/**
 * The values with one entry's changes taken back (`undo`) or put back
 * (`redo`), or `null` when a change names a row that is not there.
 *
 * Each value goes back to exactly where it came from: its field, its row by
 * `_id`, its edition. Nothing else in the section is touched, so an English
 * edit undone after an Arabic one leaves the Arabic text as it is.
 */
export function applyContent(
  values: Record<string, unknown>,
  changes: readonly ContentChange[],
  direction: "undo" | "redo",
): Record<string, unknown> | null {
  const next = copy(values);
  const ordered = direction === "undo" ? [...changes].reverse() : changes;

  for (const change of ordered) {
    const value = copy(direction === "undo" ? change.before : change.after);
    const { field, itemId, sub, locale } = change.path;

    if (itemId !== undefined) {
      const rows = next[field];
      if (!Array.isArray(rows) || sub === undefined) return null;
      const row = rows.find((candidate) => rowIdOf(candidate) === itemId);
      if (!isRecord(row)) return null;
      if (locale) {
        const held = isRecord(row[sub]) ? (row[sub] as Record<string, unknown>) : { en: "", ar: "" };
        row[sub] = { ...held, [locale]: value };
      } else if (value === undefined) {
        delete row[sub];
      } else {
        row[sub] = value;
      }
      continue;
    }

    if (locale) {
      const held = isRecord(next[field]) ? (next[field] as Record<string, unknown>) : { en: "", ar: "" };
      next[field] = { ...held, [locale]: value };
    } else if (value === undefined) {
      delete next[field];
    } else {
      next[field] = value;
    }
  }
  return next;
}

/** The node path a content change is about, for naming it. */
const contentNode = (path: ContentPath): string =>
  [`field:${path.field}`, path.itemId ? `item:${path.itemId}` : null, path.sub ? `field:${path.sub}` : null]
    .filter(Boolean)
    .join("/");

const pathKey = (path: ContentPath): string => `${contentNode(path)}@${path.locale ?? "*"}`;

const LANGUAGE: Record<Locale, string> = { en: "English", ar: "Arabic" };

/** A field a person types into — the only content that groups. */
function typedField(blockType: string, path: ContentPath): boolean {
  const block = getEditorBlock(blockType);
  const field: FieldDef | undefined = block?.fields.find((candidate) => candidate.name === path.field);
  if (!field) return false;
  if (path.itemId !== undefined) {
    if (!path.sub) return false;
    const sub: ItemFieldDef | undefined = field.itemFields?.find((candidate) => candidate.name === path.sub);
    const type = sub?.type ?? "text";
    return type === "text" || type === "textarea";
  }
  return ["text", "textarea", "richtext", "link", "number"].includes(field.type ?? "text");
}

/* -------------------------------------------------------------------------- */
/* Style and motion                                                           */
/* -------------------------------------------------------------------------- */

/** One token or motion field that differs between two documents. */
export type DocumentLeaf = {
  /** The node path, or `root` for the section's own target. */
  node: string;
  breakpoint: Breakpoint;
  key: string;
  before: unknown;
  after: unknown;
};

type Targets = Record<string, Partial<Record<Breakpoint, Record<string, unknown>>> | undefined>;

function diffTargets(before: Targets, after: Targets): DocumentLeaf[] {
  const out: DocumentLeaf[] = [];
  const nodes = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  for (const node of nodes) {
    for (const breakpoint of BREAKPOINTS) {
      const was = before[node]?.[breakpoint] ?? {};
      const now = after[node]?.[breakpoint] ?? {};
      const keys = [...new Set([...Object.keys(was), ...Object.keys(now)])].sort();
      for (const key of keys) {
        if (sameValue(was[key], now[key])) continue;
        out.push({ node, breakpoint, key, before: was[key], after: now[key] });
      }
    }
  }
  return out;
}

/** Every token that differs between two style documents, by node and width. */
export const diffStyleDocuments = (before: StyleDocument, after: StyleDocument): DocumentLeaf[] =>
  diffTargets(before.nodes as Targets, after.nodes as Targets);

/**
 * Every motion field that differs between two motion documents. The section's
 * own target is the node `root`, which is what its address calls it.
 */
export const diffMotionDocuments = (before: MotionDocument, after: MotionDocument): DocumentLeaf[] =>
  diffTargets(
    { root: before.section as Targets[string], ...(before.nodes as Targets) },
    { root: after.section as Targets[string], ...(after.nodes as Targets) },
  );

/**
 * The style tokens set with a slider, and the one motion field that is. A drag
 * through twenty values is one action; a choice from a menu is one action per
 * choice. `tests/undo-history.test.ts` holds these against the inspectors'
 * own controls.
 */
export const CONTINUOUS_STYLE_TOKENS: ReadonlySet<keyof StyleTokens> = new Set<keyof StyleTokens>([
  "opacity",
  "objectX",
  "objectY",
  "padBlock",
  "padInline",
  "marginBlock",
  "marginInline",
  "gap",
]);
export const CONTINUOUS_MOTION_FIELDS: ReadonlySet<keyof MotionBranch> = new Set<keyof MotionBranch>(["delay"]);

export const BREAKPOINT_LABEL: Record<Breakpoint, string> = { base: "Desktop", tablet: "Tablet", mobile: "Mobile" };

/* -------------------------------------------------------------------------- */
/* Naming                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A node, named the way the inspector names it — by the registry's field
 * labels and a row's own words, found by `_id` in the section's values.
 */
export function nodeLabel(
  blockType: string,
  node: string,
  values: Record<string, unknown>,
  locale: Locale,
): string {
  if (node === "root") return blockNameOf(blockType);
  const described = describeStoredPath(blockType, node, values, locale);
  return described.crumbs.slice(1).join(" → ") || described.blockName;
}

/** What one content action was, in words. */
export function describeContent(
  blockType: string,
  changes: readonly ContentChange[],
  values: Record<string, unknown>,
  locale: Locale,
): string {
  if (!changes.length) return "Edit content";
  if (changes.length > 1) {
    const fields = new Set(changes.map((change) => change.path.field));
    return fields.size === 1
      ? `Change ${nodeLabel(blockType, `field:${changes[0]!.path.field}`, values, locale)}`
      : `Change ${fields.size} fields`;
  }
  const [change] = changes;
  const { path } = change!;
  const where = nodeLabel(blockType, contentNode(path), values, locale);
  if (path.itemId === undefined && Array.isArray(change!.before) && Array.isArray(change!.after)) {
    const was = change!.before.map(rowIdOf);
    const now = change!.after.map(rowIdOf);
    if (now.length > was.length) return `Add a row to ${where}`;
    if (now.length < was.length) return `Remove a row from ${where}`;
    return `Reorder ${where}`;
  }
  return `Change ${where}${path.locale ? ` (${LANGUAGE[path.locale]})` : ""}`;
}

function describeLeaves(
  leaves: readonly DocumentLeaf[],
  blockType: string,
  values: Record<string, unknown>,
  locale: Locale,
  labelOf: (key: string) => string,
  noun: string,
): string {
  if (!leaves.length) return `Edit ${noun}`;
  if (leaves.length > 1) {
    const nodes = new Set(leaves.map((leaf) => leaf.node));
    return nodes.size === 1
      ? `Change ${noun} of ${nodeLabel(blockType, leaves[0]!.node, values, locale)}`
      : `Change ${noun} of ${nodes.size} elements`;
  }
  const [leaf] = leaves;
  const verb = leaf!.after === undefined ? "Reset" : "Change";
  return `${verb} ${labelOf(leaf!.key)} · ${BREAKPOINT_LABEL[leaf!.breakpoint]} · ${nodeLabel(blockType, leaf!.node, values, locale)}`;
}

export const describeStyle = (
  blockType: string,
  before: StyleDocument,
  after: StyleDocument,
  values: Record<string, unknown>,
  locale: Locale,
): string =>
  describeLeaves(
    diffStyleDocuments(before, after),
    blockType,
    values,
    locale,
    (key) => STYLE_TOKEN_LABELS[key as keyof StyleTokens] ?? key,
    "styles",
  );

export const describeMotion = (
  blockType: string,
  before: MotionDocument,
  after: MotionDocument,
  values: Record<string, unknown>,
  locale: Locale,
): string =>
  describeLeaves(
    diffMotionDocuments(before, after),
    blockType,
    values,
    locale,
    (key) => MOTION_FIELD_LABELS[key as keyof MotionBranch] ?? key,
    "motion",
  );

const STRUCTURE_VERB: Record<StructureOp, string> = {
  add: "Add",
  duplicate: "Duplicate",
  reorder: "Move",
  visibility: "Change visibility of",
  remove: "Remove",
  restore: "Restore",
};

export function describeStructure(op: StructureOp, blockType: string | null, visible?: boolean): string {
  const name = blockType ? blockNameOf(blockType) : "section";
  if (op === "visibility") return `${visible ? "Show" : "Hide"} ${name}`;
  if (op === "reorder") return blockType ? `Move ${name}` : "Reorder sections";
  return `${STRUCTURE_VERB[op]} ${name}`;
}

/* -------------------------------------------------------------------------- */
/* Grouping                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The group a change may merge into, or `null` for an action that always
 * stands alone.
 *
 * Only one thing being typed or dragged groups: one content value in a field a
 * person types into; one slider token at one width; the Delay slider. Two
 * values, a reset, a menu choice, a toggle, a row added and every layout change
 * return `null`.
 */
export function groupOf(change: HistoryChange): string | null {
  if (change.domain === "structure") return null;
  if (change.domain === "content") {
    if (change.changes.length !== 1) return null;
    const [only] = change.changes;
    if (!typedField(change.blockType, only!.path)) return null;
    return `content:${change.sectionId}:${pathKey(only!.path)}`;
  }
  const leaves =
    change.domain === "style"
      ? diffStyleDocuments(change.before, change.after)
      : diffMotionDocuments(change.before, change.after);
  if (leaves.length !== 1) return null;
  const [leaf] = leaves;
  if (typeof leaf!.after !== "number") return null;
  const continuous =
    change.domain === "style"
      ? CONTINUOUS_STYLE_TOKENS.has(leaf!.key as keyof StyleTokens)
      : CONTINUOUS_MOTION_FIELDS.has(leaf!.key as keyof MotionBranch);
  if (!continuous) return null;
  return `${change.domain}:${change.sectionId}:${leaf!.node}:${leaf!.breakpoint}:${leaf!.key}`;
}

/** Whether a change leaves everything as it was. */
export function isNoop(change: HistoryChange): boolean {
  if (change.domain === "content") return change.changes.every((entry) => sameValue(entry.before, entry.after));
  return sameValue(change.before, change.after);
}

/** Two actions in one group, as one: the first's "before", the second's "after". */
function merge(first: HistoryChange, second: HistoryChange): HistoryChange {
  if (first.domain === "content" && second.domain === "content") {
    const merged = first.changes.map((change) => ({ ...change }));
    for (const change of second.changes) {
      const existing = merged.find((candidate) => pathKey(candidate.path) === pathKey(change.path));
      if (existing) existing.after = change.after;
      else merged.push(change);
    }
    return { ...first, changes: merged };
  }
  if (first.domain === "style" && second.domain === "style") return { ...first, after: second.after };
  if (first.domain === "motion" && second.domain === "motion") return { ...first, after: second.after };
  return second;
}

let nextId = 0;

/**
 * Adds an action to a page's history.
 *
 * A new action clears Redo — the standard rule, and the only one V1 has: after
 * A → B → C, Undo to B and a new edit D, the history is A → B → D and C is gone.
 * There is no branching.
 *
 * An action in the same group as the newest entry, within `GROUP_IDLE_MS` of
 * its last growth (or at any delay while `held` — a slider still under the
 * pointer), extends that entry instead of adding one. An entry that grows back
 * into exactly where it started is dropped: typing a word and deleting it
 * again is not an action worth undoing.
 */
export function record(
  history: PageHistory,
  change: HistoryChange,
  label: string,
  now: number,
  options: { held?: boolean } = {},
): PageHistory {
  if (isNoop(change)) return history;
  const group = groupOf(change);
  const newest = history.undo[history.undo.length - 1];

  if (
    group !== null &&
    newest &&
    history.open?.group === group &&
    newest.group === group &&
    (options.held || now - history.open.at <= GROUP_IDLE_MS)
  ) {
    const grown = merge(newest.change, change);
    const undo = history.undo.slice(0, -1);
    if (isNoop(grown)) return { undo, redo: [], open: null };
    return { undo: [...undo, { ...newest, label, change: grown }], redo: [], open: { group, at: now } };
  }

  nextId += 1;
  const entry: HistoryEntry = { id: nextId, label, group, change };
  const undo = [...history.undo, entry];
  return {
    undo: undo.length > HISTORY_LIMIT ? undo.slice(undo.length - HISTORY_LIMIT) : undo,
    redo: [],
    open: group ? { group, at: now } : null,
  };
}

/** Ends the group in progress, so the next action is an entry of its own. */
export const closeGroup = (history: PageHistory): PageHistory =>
  history.open ? { ...history, open: null } : history;

/** Takes the newest action off the Undo list and puts it on Redo. */
export function takeUndo(history: PageHistory): { history: PageHistory; entry: HistoryEntry } | null {
  const entry = history.undo[history.undo.length - 1];
  if (!entry) return null;
  return {
    entry,
    history: { undo: history.undo.slice(0, -1), redo: [...history.redo, entry], open: null },
  };
}

/** Takes the newest undone action off Redo and puts it back on Undo. */
export function takeRedo(history: PageHistory): { history: PageHistory; entry: HistoryEntry } | null {
  const entry = history.redo[history.redo.length - 1];
  if (!entry) return null;
  return {
    entry,
    history: { undo: [...history.undo, entry], redo: history.redo.slice(0, -1), open: null },
  };
}

/**
 * Keeps at most `HISTORY_PAGES` page histories, dropping the one used least
 * recently. `order` is the page ids, most recently used last.
 */
export function boundPages<T>(histories: Map<number, T>, order: number[]): { histories: Map<number, T>; order: number[] } {
  if (order.length <= HISTORY_PAGES) return { histories, order };
  const next = new Map(histories);
  const keep = order.slice(order.length - HISTORY_PAGES);
  for (const id of order.slice(0, order.length - HISTORY_PAGES)) next.delete(id);
  return { histories: next, order: keep };
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                     */
/* -------------------------------------------------------------------------- */

/** The one structural operation that moves a layout from one state to the next. */
export type StructureStep =
  | { action: "reorder"; order: number[] }
  | { action: "visibility"; sectionId: number; visible: boolean }
  | { action: "remove"; sectionId: number }
  | { action: "restore"; sectionId: number; beforeSectionId: number | null; visible: boolean };

const sameEntries = (a: DraftStructure["sections"], b: DraftStructure["sections"]): boolean =>
  a.length === b.length &&
  a.every((entry, index) => entry.sectionId === b[index]!.sectionId && entry.visible === b[index]!.visible);

/**
 * How to take a layout action back (or put it back) with the operations the
 * structure service already has — or `null` when the page's layout is not the
 * one the action left behind.
 *
 * The layout on screen must be exactly the state the action produced (for
 * Undo) or the state it was taken back to (for Redo): same sections, same
 * order, same visibility, by section id. Anything else means the page changed
 * underneath this history, and replaying an old inverse over it would be
 * guessing — so the caller resets the history instead.
 *
 * The difference between the two states is always one operation:
 *
 *   · same sections, new order → **reorder** to the target order;
 *   · same sections and order, one visibility → **visibility**;
 *   · one section more in the target → **restore** it, before the section
 *     that follows it there, with the visibility it has there — the same
 *     section, by id, never a new one;
 *   · one section fewer → **remove** it (a new section stays a pending row in
 *     Removed, so Redo can restore the very same row, with its content).
 */
export function structureStep(
  change: Extract<HistoryChange, { domain: "structure" }>,
  direction: "undo" | "redo",
  current: DraftStructure,
): StructureStep | null {
  const expected = direction === "undo" ? change.after : change.before;
  const target = direction === "undo" ? change.before : change.after;
  if (!sameEntries(current.sections, expected.sections)) return null;

  const from = expected.sections;
  const to = target.sections;
  const fromIds = new Set(from.map((entry) => entry.sectionId));
  const toIds = new Set(to.map((entry) => entry.sectionId));

  if (from.length === to.length && [...fromIds].every((id) => toIds.has(id))) {
    const sameOrder = from.every((entry, index) => entry.sectionId === to[index]!.sectionId);
    if (!sameOrder) {
      // A reorder carries visibility across; a target that also changed one
      // would not be one operation.
      const visibilityKept = to.every(
        (entry) => from.find((candidate) => candidate.sectionId === entry.sectionId)!.visible === entry.visible,
      );
      return visibilityKept ? { action: "reorder", order: to.map((entry) => entry.sectionId) } : null;
    }
    const changed = to.filter((entry, index) => entry.visible !== from[index]!.visible);
    if (changed.length !== 1) return null;
    return { action: "visibility", sectionId: changed[0]!.sectionId, visible: changed[0]!.visible };
  }

  if (to.length === from.length + 1) {
    const added = to.filter((entry) => !fromIds.has(entry.sectionId));
    if (added.length !== 1) return null;
    const entry = added[0]!;
    const without = to.filter((candidate) => candidate.sectionId !== entry.sectionId);
    if (!sameEntries(without, from)) return null;
    const at = to.findIndex((candidate) => candidate.sectionId === entry.sectionId);
    return {
      action: "restore",
      sectionId: entry.sectionId,
      beforeSectionId: to[at + 1]?.sectionId ?? null,
      visible: entry.visible,
    };
  }

  if (to.length === from.length - 1) {
    const gone = from.filter((entry) => !toIds.has(entry.sectionId));
    if (gone.length !== 1) return null;
    const without = from.filter((candidate) => candidate.sectionId !== gone[0]!.sectionId);
    if (!sameEntries(without, to)) return null;
    return { action: "remove", sectionId: gone[0]!.sectionId };
  }

  return null;
}

/** Whether an entry is about this section, for naming what a reset was about. */
export const touchesSection = (entry: HistoryEntry, sectionId: number): boolean =>
  entry.change.domain === "structure"
    ? entry.change.sectionId === sectionId
    : entry.change.sectionId === sectionId;
