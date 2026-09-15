"use client";

import { BlockEditor } from "@/components/admin/block-editor";
import type { MediaOption } from "@/components/admin/media-picker";
import type { BlockDef } from "@/lib/cms/blocks";
import type { Locale } from "@/lib/i18n/config";
import { focusOf } from "@/lib/visual-editor/content";
import type { EditorNodeMeta } from "@/lib/visual-editor/protocol";

import type { SectionBuffer } from "./inspector";

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
  canManage,
  onValues,
}: {
  node: EditorNodeMeta;
  block: BlockDef;
  buffer: SectionBuffer;
  media: MediaOption[];
  locale: Locale;
  canManage: boolean;
  onValues: (values: Record<string, unknown>) => void;
}) {
  return (
    /*
      A viewer sees the real content in the real controls, switched off. A
      screen of empty boxes would be a different, and false, answer to "what
      does this section say".
    */
    <fieldset disabled={!canManage} className="min-w-0 border-0 p-0">
      <BlockEditor
        block={block}
        value={buffer.values}
        onChange={onValues}
        media={media}
        locale={locale}
        focus={focusOf(node.relativePath)}
      />
    </fieldset>
  );
}
