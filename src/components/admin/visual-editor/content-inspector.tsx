"use client";

import { BlockEditor } from "@/components/admin/block-editor";
import type { MediaOption } from "@/components/admin/media-picker";
import type { BlockDef } from "@/lib/cms/blocks";
import { readReuse, slotDef } from "@/lib/cms/reuse/reference";
import type { Locale } from "@/lib/i18n/config";
import { focusOf } from "@/lib/visual-editor/content";
import type { EditorNodeMeta } from "@/lib/visual-editor/protocol";

import type { SectionBuffer } from "./inspector";
import { ReusePanel, type ReuseControls } from "./reuse-panel";

/**
 * The Content tab's body: the block's registry-driven editor, pointed at the
 * field the canvas has selected.
 *
 * The panel around it — the node's name, the tabs, the save bar, the conflict
 * card — belongs to `InspectorPanel`, which both domains share. This file is
 * only what makes content content.
 */
export function ContentBody({
  node,
  block,
  buffer,
  media,
  locale,
  canContent,
  onValues,
  reuse,
}: {
  node: EditorNodeMeta;
  block: BlockDef;
  buffer: SectionBuffer;
  media: MediaOption[];
  locale: Locale;
  /** `content.edit` (Batch 18). Without it the fields show the real content, switched off. */
  canContent: boolean;
  onValues: (values: Record<string, unknown>) => void;
  /** Reusable components (Batch 17): the catalogue and the instance actions. */
  reuse?: ReuseControls;
}) {
  /**
   * The fields a reusable component supplies are not drawn as this section's
   * own inputs: the panel above shows them as inherited, with the override and
   * detach controls, so a global value can never look like a local one.
   */
  const links = readReuse(buffer.values, block.type);
  const linked = new Set(
    Object.keys(links).flatMap((slot) => slotDef(block.type, slot)?.fields.map((field) => field.name) ?? []),
  );
  const focus = focusOf(node.relativePath);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      {reuse ? (
        <ReusePanel
          blockType={block.type}
          sectionId={buffer.data.sectionId}
          values={buffer.values}
          locale={locale}
          focusField={focus?.field ?? null}
          controls={reuse}
          onValues={onValues}
        />
      ) : null}
      {/*
        A viewer sees the real content in the real controls, switched off. A
        screen of empty boxes would be a different, and false, answer to "what
        does this section say".
      */}
      {canContent ? null : (
        <p className="text-[0.72rem] leading-relaxed text-muted" role="note" data-permission-note="content.edit">
          You can view this section’s content, but your role does not allow editing it.
        </p>
      )}
      <fieldset disabled={!canContent} className="min-w-0 border-0 p-0">
        <BlockEditor
          block={block}
          value={buffer.values}
          onChange={onValues}
          media={media}
          locale={locale}
          focus={focus}
          hidden={linked}
        />
      </fieldset>
    </div>
  );
}
