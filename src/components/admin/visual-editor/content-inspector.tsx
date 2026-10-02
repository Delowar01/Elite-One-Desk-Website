"use client";

import { BlockEditor } from "@/components/admin/block-editor";
import type { MediaOption } from "@/components/admin/media-picker";
import type { BlockDef } from "@/lib/cms/blocks";
import { ROUTE_STRUCTURAL_FIELDS } from "@/lib/routes/blocks";
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
  canStructure = true,
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
  /**
   * `content.structure`, for a dynamic route's region (Batch 21): whether a
   * service, group or question may be shown, hidden or moved to another
   * group. Without it those fields are not offered as inputs here.
   */
  canStructure?: boolean;
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

  /**
   * A dynamic route's region (Batch 21). Generated fields are drawn as the
   * sentence that says where they come from, never as inputs; visibility and
   * grouping are offered only to a role that may change the page's structure;
   * and a choice only the route can supply — a card's groups — is filled in
   * from the region the server sent.
   */
  const route = buffer.data.route;
  const hidden = new Set(linked);
  const notes: Record<string, string> = {};
  let shown = block;
  if (route) {
    for (const field of block.fields) {
      if (field.generated) {
        hidden.add(field.name);
        notes[field.name] = field.generated.explain;
      } else if (!canStructure && ROUTE_STRUCTURAL_FIELDS.has(field.name)) {
        hidden.add(field.name);
        notes[field.name] = "Your role does not allow showing, hiding or moving parts of this page.";
      }
    }
    shown = {
      ...block,
      fields: block.fields.map((field) => (route.options[field.name] ? { ...field, options: route.options[field.name] } : field)),
    };
  }
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
          block={shown}
          value={buffer.values}
          onChange={onValues}
          media={media}
          locale={locale}
          focus={focus}
          hidden={hidden}
          notes={route ? notes : undefined}
        />
      </fieldset>
    </div>
  );
}
