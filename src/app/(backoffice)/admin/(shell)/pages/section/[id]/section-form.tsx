"use client";

import { useCallback, useState } from "react";

import { AdminForm, ConfirmSubmit, InlineAction, SubmitButton } from "@/components/admin/form";
import { BlockEditor } from "@/components/admin/block-editor";
import type { MediaOption } from "@/components/admin/media-picker";
import { Icon } from "@/components/ui/icon";
import { ANIMATIONS, type BlockDef } from "@/lib/cms/blocks";
import { discardDraft, publishSection, saveSectionDraft } from "../../actions";

/**
 * Draft, preview, publish (§16) — the three states an editor actually works in.
 *
 * "Save draft" never touches the live site; "Save and publish" does both in one
 * step for a small correction. The publish and discard controls are separate
 * forms so they cannot be triggered by the Enter key inside the editor.
 *
 * Being separate forms costs them the message `AdminForm` draws, so the banner
 * draws it instead. That matters most for the one answer they can give that a
 * re-render does not explain: this screen has been overtaken, and nothing
 * happened. Without it a refused publish looks exactly like a button that does
 * not work, and the natural response is to press it again.
 */
export function SectionForm({
  csrf,
  section,
  block,
  media,
  previewHref,
}: {
  csrf: string;
  section: {
    id: number;
    animation: string;
    hasDraft: boolean;
    values: Record<string, unknown>;
    revision: number;
  };
  block: BlockDef;
  media: MediaOption[];
  previewHref: string;
}) {
  const [notice, setNotice] = useState<string | null>(null);
  const onResult = useCallback(
    (state: { ok: boolean; message?: string }) =>
      setNotice(state.ok ? null : (state.message ?? "That did not work. Reload the page.")),
    [],
  );

  return (
    <div className="space-y-5">
      {section.hasDraft ? (
        <div className="admin-card flex flex-wrap items-center gap-3 p-4">
          <span className="admin-badge" style={{ color: "#ffd166" }}>
            Unpublished draft
          </span>
          <p className="min-w-40 flex-1 text-[0.8rem] text-muted">
            You are editing a draft. The live site still shows the previous version.
          </p>
          <a href={previewHref} target="_blank" rel="noopener" className="admin-btn admin-btn-sm">
            <Icon name="arrowUpRight" size={12} />
            Preview
          </a>
          {/*
            Publish and Discard carry the same revision the editor below does.
            Without it the server could only guard its own fresh read, which
            protects nothing: this panel is drawn once and can sit open while
            somebody else saves. The button would then publish — or delete — a
            draft that was never on this screen.
          */}
          <InlineAction
            action={publishSection}
            hidden={{ _csrf: csrf, id: section.id, expectedRevision: section.revision }}
            onResult={onResult}
          >
            <ConfirmSubmit
              variant="primary"
              className="admin-btn-sm"
              message="Publish this section to the live site?"
            >
              Publish draft
            </ConfirmSubmit>
          </InlineAction>
          <InlineAction
            action={discardDraft}
            hidden={{ _csrf: csrf, id: section.id, expectedRevision: section.revision }}
            onResult={onResult}
          >
            <ConfirmSubmit className="admin-btn-sm" message="Discard this draft and keep the live version?">
              Discard
            </ConfirmSubmit>
          </InlineAction>

          {notice ? (
            <p
              role="alert"
              className="flex w-full items-start gap-2 rounded-[var(--radius-sm)] border p-3 text-[0.8rem]"
              style={{ borderColor: "#ef535066", background: "#ef53500f", color: "#ffb4ad" }}
            >
              <Icon name="close" size={14} className="mt-0.5 shrink-0" />
              {notice}
            </p>
          ) : null}
        </div>
      ) : null}

      <AdminForm action={saveSectionDraft} className="admin-card p-5">
        <input type="hidden" name="_csrf" value={csrf} />
        <input type="hidden" name="id" value={section.id} />
        {/*
          The revision this screen was built from. Saving names it, so a save
          that has been overtaken — by the Visual Editor, by a second tab, by a
          colleague — is refused rather than silently winning.
        */}
        <input type="hidden" name="expectedRevision" value={section.revision} />

        <BlockEditor block={block} initial={section.values} media={media} />

        <div className="mt-6 border-t border-[var(--admin-line)] pt-5">
          <label className="admin-label" htmlFor="animation">
            Entrance animation
          </label>
          <select
            id="animation"
            name="animation"
            defaultValue={section.animation}
            className="admin-select max-w-sm"
          >
            {ANIMATIONS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
          </select>
          <p className="mt-1.5 text-[0.73rem] text-muted">
            Ignored for visitors who have asked their device for reduced motion.
          </p>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-[var(--admin-line)] pt-5">
          <SubmitButton variant="ghost">Save draft</SubmitButton>
          <button
            type="submit"
            name="publishNow"
            value="true"
            className="admin-btn admin-btn-primary"
          >
            Save and publish
          </button>
          <a href={previewHref} target="_blank" rel="noopener" className="admin-btn">
            <Icon name="arrowUpRight" size={13} />
            Preview page
          </a>
        </div>
      </AdminForm>
    </div>
  );
}
