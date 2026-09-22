/**
 * A page's published composition, kept so it can be put back.
 *
 * The boundary is the whole design of this file, so it is stated plainly:
 *
 *   In    block type · order · published visibility · published values ·
 *         published styles · the published `animation` value
 *   Out   drafts · draft styles · the page's own title and settings ·
 *         site settings · navigation · footer · social links · catalogue
 *         records · media bytes
 *
 * Drafts are out because a snapshot is of what was *published*; restoring
 * somebody's unfinished edit is not what "restore this version" means.
 *
 * Page settings and anything global are out for a harder reason: none of them
 * has a draft form. Restoring them would take effect the moment the row was
 * written, so a restore could not be previewed — and a restore that goes live
 * on click is the most dangerous button a CMS can have. Media is referenced by
 * id, never by bytes; the library's own delete guard (`lib/media/usage.ts`)
 * is what keeps those ids resolvable.
 *
 * A version row is written by every path that changes live section content —
 * publishing one section, and publishing a page's saved changes — always as
 * the state immediately *before* that publication, in the same transaction, so
 * a publication that rolls back leaves no history behind. `readPageSnapshot`
 * at the end of this file is the strict reader a restore uses; the tolerant
 * one above is for describing a version, not for acting on it.
 */
import { getBlock } from "./blocks";
import { motionOf } from "./motion";
import { validateStyleDocument, type StyleDocument } from "./styles";
import { validateBlockValues } from "./validate";

export const PAGE_SNAPSHOT_VERSION = 1;

export type SnapshotSection = {
  /** The row this came from. A hint for matching, never an identity to restore. */
  sourceSectionId: number;
  blockType: string;
  visible: boolean;
  published: Record<string, unknown>;
  styles: StyleDocument;
  animation: string;
};

export type PageSnapshot = { v: number; sections: SnapshotSection[] };

export const EMPTY_PAGE_SNAPSHOT: PageSnapshot = { v: PAGE_SNAPSHOT_VERSION, sections: [] };

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const asString = (value: unknown, max: number): string =>
  typeof value === "string" ? value.slice(0, max) : "";

const isId = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

/**
 * Rebuilt entry by entry, like every other document here, and this is the trust
 * boundary: a stored snapshot is a JSON column, and a restore writes it into
 * `draft` — from where the ordinary publish path can promote it without ever
 * passing it through the block form parser again. So a snapshot must not be a
 * way round the CMS's own rules, and the content is rebuilt through
 * `validateBlockValues`: the registry's field allowlist, the rich-text
 * sanitizer, the link sanitizer, media parsing, the icon allowlist and `_id`
 * normalisation, all of them the same ones a save goes through. There is no
 * second validator here; there is only that one.
 *
 * Capture (`snapshotFromSections`) deliberately does not do this. It records
 * what was published, faithfully, including a field the registry has since
 * stopped declaring — the sanitising belongs at the moment the content is about
 * to be written back, not at the moment it is filed away.
 *
 * A row whose block type the registry does not know is dropped, for the same
 * reason `applyRestorePlan` will not recreate one: there is no form that can
 * edit it and no renderer that can draw it, so keeping its arbitrary values
 * would be carrying unvalidatable content for no one's benefit. The live
 * section keeps its row and is simply left alone. Deprecated-but-registered
 * types (`egypt-feature`) are still known to `getBlock`, so they restore
 * normally. Array order is preserved exactly, because the order *is* the data.
 */
export function validatePageSnapshot(input: unknown): PageSnapshot {
  const source = asRecord(input);
  const version = source.v;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return { v: PAGE_SNAPSHOT_VERSION, sections: [] };
  }
  if (version > PAGE_SNAPSHOT_VERSION) return { v: PAGE_SNAPSHOT_VERSION, sections: [] };

  const raw = Array.isArray(source.sections) ? source.sections : [];
  const sections: SnapshotSection[] = [];

  for (const entry of raw) {
    const row = asRecord(entry);
    const blockType = asString(row.blockType, 48);
    if (!blockType) continue;
    const block = getBlock(blockType);
    if (!block) continue;
    sections.push({
      sourceSectionId: isId(row.sourceSectionId) ? row.sourceSectionId : 0,
      blockType,
      visible: row.visible === false ? false : true,
      published: validateBlockValues(block, row.published),
      styles: validateStyleDocument(row.styles),
      // Normalised, not merely length-capped. A snapshot is replayed into
      // `draft_animation` by a restore, and `draft_animation` is rendered —
      // so a version captured before the vocabulary existed must come back as
      // a preset rather than as whatever string it happened to hold.
      animation: motionOf(asString(row.animation, 32)),
    });
  }

  return { v: PAGE_SNAPSHOT_VERSION, sections };
}

/** Rows as the database holds them → the document that will be stored. */
export function snapshotFromSections(
  rows: readonly {
    id: number;
    blockType: string;
    isPublished: boolean;
    published: Record<string, unknown> | null;
    styles: Record<string, unknown> | null;
    animation: string;
  }[],
): PageSnapshot {
  return {
    v: PAGE_SNAPSHOT_VERSION,
    sections: rows.map((row) => ({
      sourceSectionId: row.id,
      blockType: row.blockType,
      visible: row.isPublished,
      published: row.published ?? {},
      styles: validateStyleDocument(row.styles),
      animation: motionOf(row.animation),
    })),
  };
}

/**
 * The strict reading, for restoring rather than for describing.
 *
 * `validatePageSnapshot` above rebuilds whatever it is handed into a valid
 * document, and for a *reader* that is right: a history row nobody can parse
 * should still draw a list entry rather than crash a screen. For a **restore**
 * it is dangerous, because the shape it rebuilds an unreadable snapshot into is
 * `{ v: 1, sections: [] }` — a page with no sections. Restoring that would
 * stage the removal of every section on the page, and publishing the restore
 * would carry it out, all from a column that could not be read.
 *
 * A genuinely empty V1 snapshot is a real historical state: a page that had no
 * sections. It has to stay restorable. So emptiness cannot be the test, and
 * this answers the other question instead — is this a document this build
 * wrote? A future version, a missing array, a malformed entry and a block type
 * the registry has forgotten are all "not restorable by this build", and they
 * are refused by name rather than flattened into an empty page.
 */
export type SnapshotRead =
  | { ok: true; snapshot: PageSnapshot }
  | { ok: false; reason: "unsupported" };

const UNSUPPORTED: SnapshotRead = { ok: false, reason: "unsupported" };

export function readPageSnapshot(input: unknown): SnapshotRead {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return UNSUPPORTED;
  const source = input as Record<string, unknown>;
  const version = source.v;
  if (typeof version !== "number" || !Number.isInteger(version)) return UNSUPPORTED;
  if (version < 1 || version > PAGE_SNAPSHOT_VERSION) return UNSUPPORTED;
  if (!Array.isArray(source.sections)) return UNSUPPORTED;

  for (const entry of source.sections) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return UNSUPPORTED;
    const row = entry as Record<string, unknown>;
    if (typeof row.blockType !== "string" || !row.blockType) return UNSUPPORTED;
    // A type the registry has forgotten cannot be rendered or edited, and
    // `validatePageSnapshot` drops it — which would silently restore a page
    // *without* that section. Refusing says so instead.
    if (!getBlock(row.blockType)) return UNSUPPORTED;
    if (typeof row.visible !== "boolean") return UNSUPPORTED;
  }

  // Shape accepted; the values still go through the same sanitiser a save does.
  return { ok: true, snapshot: validatePageSnapshot(source) };
}
