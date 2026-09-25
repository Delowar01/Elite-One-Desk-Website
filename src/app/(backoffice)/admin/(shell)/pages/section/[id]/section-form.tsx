"use client";

import { useCallback, useState } from "react";

import {
  AdminForm,
  AlternateSubmit,
  ConfirmSubmit,
  InlineAction,
  SubmitButton,
} from "@/components/admin/form";
import { BlockEditor } from "@/components/admin/block-editor";
import type { MediaOption } from "@/components/admin/media-picker";
import { Icon } from "@/components/ui/icon";
import type { ActionState } from "@/lib/admin/actions";
import type { BlockDef } from "@/lib/cms/blocks";
import { DRAFT_LABEL, hasDraft, type DraftKind } from "@/lib/cms/drafts";
import { MOTION_PRESETS } from "@/lib/cms/motion";
import {
  discardDraft,
  publishSection,
  saveSectionAndPublish,
  saveSectionDraft,
} from "../../actions";

/**
 * Draft, preview, publish (§16) — the three states an editor actually works in.
 *
 * "Save draft" never touches the live site; "Save and publish" writes straight
 * to it in one guarded step, for a small correction. They are two actions on
 * one form rather than one action told which to do, so the Enter key — which
 * always submits the form's own action — can only ever save a draft. The
 * publish and discard controls are separate forms again, so Enter cannot reach
 * them either.
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
    /** The preset this screen is editing — the motion draft when there is one. */
    animation: string;
    /** The section also has motion set in the Visual Editor that one menu cannot show. */
    advancedMotion: boolean;
    draftKind: DraftKind;
    /**
     * Whether this section exists only in the page's layout draft.
     *
     * A pending section cannot be published on its own: the live page is
     * composed from membership, and this row is not a member. Saving drafts is
     * ordinary work, so the editor below is unchanged — what changes is that
     * the two buttons which would have claimed the change was live are not
     * offered, because offering them would be a promise the site cannot keep.
     */
    isDraftOnly: boolean;
    values: Record<string, unknown>;
    revision: number;
  };
  block: BlockDef;
  media: MediaOption[];
  previewHref: string;
}) {
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * One server state, held as one value — the fix for a pairing this screen
   * could otherwise get wrong.
   *
   * Everything below is derived from a single row as the server read it: the
   * words in the fields, the entrance in the menu, which draft is pending, and
   * the revision the save names. A save is only safe when those travel
   * together. Splitting them — revision in one state, values in another —
   * admitted a state nothing else on the screen announces: old words on screen,
   * new revision in the hidden input. The server checks the revision and
   * nothing else, so such a save would be accepted, and an edit somebody else
   * had just made would be overwritten by wording this editor never saw.
   *
   * So there is one object, and exactly one thing moves it: an action of this
   * screen's own that succeeded and reported what it wrote. That is the one
   * case where the pair is still honest — the words on screen are the words
   * this tab just sent, and the revision is the one the server gave them.
   *
   * It is moved that way, rather than by the re-render, because the re-render
   * is not guaranteed to arrive: the server produces it correctly every time,
   * and the router applies it *nearly* every time — two of twelve consecutive
   * saves left this component un-rendered while the row had moved on. The next
   * save then named a revision the row had passed, and an editor who had just
   * saved successfully was told somebody else had changed the section.
   *
   * A newer server state is deliberately NOT adopted here. When the Visual
   * Editor, a second tab or a colleague moves the row, this screen keeps
   * showing what it has, its save is refused with the banner below, and the
   * editor reloads — which remounts this component and brings words and
   * revision forward together. Adopting only the revision would silently arm
   * the overwrite described above; adopting the values too would delete
   * whatever is half-typed in the fields. Refusing is the only answer that
   * loses nothing.
   */
  const [screen, setScreen] = useState({
    /**
     * Bumped only when a write replaced what the fields should hold — a
     * discard, putting the published wording back. A save must not bump it:
     * the fields already hold what was typed, and rebuilding them would move
     * the caret.
     */
    token: 0,
    id: section.id,
    revision: section.revision,
    draftKind: section.draftKind,
    animation: section.animation,
    advancedMotion: section.advancedMotion,
    isDraftOnly: section.isDraftOnly,
    values: section.values,
  });

  const adopt = useCallback((state: ActionState) => {
    const next = state.section;
    if (!next) return;
    setScreen((current) => ({
      ...current,
      // `values` present means the write replaced them, so the fields must be
      // rebuilt from it; absent means the fields already hold what was sent.
      // Either way the revision that arrives with them is the one those exact
      // values now carry.
      token: next.values ? current.token + 1 : current.token,
      revision: next.revision,
      draftKind: next.draftKind,
      animation: next.animation,
      advancedMotion: next.advancedMotion,
      isDraftOnly: next.isDraftOnly,
      values: next.values ?? current.values,
    }));
  }, []);

  const onResult = useCallback(
    (state: ActionState) => {
      setNotice(state.ok ? null : (state.message ?? "That did not work. Reload the page."));
      adopt(state);
    },
    [adopt],
  );

  return (
    <div className="space-y-5">
      {screen.isDraftOnly ? (
        <div className="admin-card flex flex-wrap items-center gap-3 p-4">
          <span className="admin-badge" style={{ color: "#5ad19a" }}>
            New section
          </span>
          <p className="min-w-40 flex-1 text-[0.8rem] text-muted">
            This section is part of an unpublished layout. Save it as a draft; it will become live
            when the page layout is published.
          </p>
          <a href={previewHref} target="_blank" rel="noopener" className="admin-btn admin-btn-sm">
            <Icon name="arrowUpRight" size={12} />
            Preview
          </a>
        </div>
      ) : null}

      {hasDraft(screen.draftKind) && !screen.isDraftOnly ? (
        <div className="admin-card flex flex-wrap items-center gap-3 p-4">
          <span className="admin-badge" style={{ color: "#ffd166" }}>
            Unpublished draft
          </span>
          <p className="min-w-40 flex-1 text-[0.8rem] text-muted">
            {/*
              Which domain, because they are edited in different places: text
              here, layout in the Visual Editor. Publishing and discarding take
              both, so an editor about to press either should know what is in
              the pile.
            */}
            {DRAFT_LABEL[screen.draftKind]}. The live site still shows the previous version.
            {screen.draftKind === "style"
              ? " Styles are edited in the Visual Editor."
              : ""}
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
            hidden={{ _csrf: csrf, id: screen.id, expectedRevision: screen.revision }}
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
            hidden={{ _csrf: csrf, id: screen.id, expectedRevision: screen.revision }}
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

      <AdminForm
        action={saveSectionDraft}
        alternate={saveSectionAndPublish}
        className="admin-card p-5"
        onSaved={onResult}
      >
        <input type="hidden" name="_csrf" value={csrf} />
        <input type="hidden" name="id" value={screen.id} />
        {/*
          The revision the words below came from. Saving names it, so a save
          that has been overtaken — by the Visual Editor, by a second tab, by a
          colleague — is refused rather than silently winning. It moves only
          with them, never on its own; see `screen` above.
        */}
        <input type="hidden" name="expectedRevision" value={screen.revision} />

        {/*
          `screen.token` changes only when an action replaced the values — a
          discard putting the published wording back. A save must not remount
          this: the fields already hold what was typed, and rebuilding them
          would move the caret.
        */}
        <BlockEditor key={screen.token} block={block} initial={screen.values} media={media} />

        <div className="mt-6 border-t border-[var(--admin-line)] pt-5">
          <label className="admin-label" htmlFor="animation">
            Section entrance
          </label>
          <select
            id="animation"
            name="animation"
            key={`motion-${screen.animation}-${screen.token}`}
            defaultValue={screen.animation}
            className="admin-select max-w-sm"
          >
            {MOTION_PRESETS.map((preset) => (
              <option key={preset.value} value={preset.value}>
                {preset.label}
              </option>
            ))}
          </select>
          {/*
            Said plainly because it changed: this used to write the live value
            on every save, so an editor who only meant to fix a typo could move
            the site. It is a draft now, like the words above it.
          */}
          <p className="mt-1.5 text-[0.73rem] text-muted">
            How the whole section arrives when a visitor scrolls to it. Saved as a draft with
            everything else on this screen, and ignored for visitors who have asked their device
            for reduced motion.
          </p>
          {/*
            One menu cannot show a Blur, a timing or an element's own entrance,
            so the screen says it is showing the nearest preset — and that the
            menu, left alone, leaves all of that exactly as it is.
          */}
          {screen.advancedMotion ? (
            <p className="mt-1.5 text-[0.73rem] text-muted" data-advanced-motion="true">
              This section also has motion set in the Visual Editor, which this menu shows as the
              nearest of these five. Leaving the menu as it is keeps all of it; choosing another
              entrance replaces only the section’s own entrance.
            </p>
          ) : null}
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-2 border-t border-[var(--admin-line)] pt-5">
          <SubmitButton variant="ghost">Save draft</SubmitButton>
          {screen.isDraftOnly ? null : (
            <AlternateSubmit pendingLabel="Publishing…">Save and publish</AlternateSubmit>
          )}
          <a href={previewHref} target="_blank" rel="noopener" className="admin-btn">
            <Icon name="arrowUpRight" size={13} />
            Preview page
          </a>
        </div>
      </AdminForm>
    </div>
  );
}
