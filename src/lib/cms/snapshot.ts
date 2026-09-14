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
 * Dormant in this release: nothing writes a version row, and there is no
 * restore in the admin.
 */
import { getBlock } from "./blocks";
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
      animation: asString(row.animation, 32) || "fade-up",
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
      animation: row.animation || "fade-up",
    })),
  };
}
