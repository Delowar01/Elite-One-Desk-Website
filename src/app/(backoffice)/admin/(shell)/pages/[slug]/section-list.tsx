"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef, useState } from "react";

import { ConfirmSubmit, InlineAction, SubmitButton } from "@/components/admin/form";
import { Icon } from "@/components/ui/icon";
import type { ActionState } from "@/lib/admin/actions";
import type { BlockDef } from "@/lib/cms/blocks";
import { DRAFT_BADGE, DRAFT_LABEL, hasDraft, type DraftKind } from "@/lib/cms/drafts";
import {
  addSection,
  deleteSection,
  discardLayout,
  duplicateSection,
  moveSection,
  reorderSections,
  restoreSection,
  toggleSection,
} from "../actions";

export type SectionRow = {
  id: number;
  blockType: string;
  blockName: string;
  blockDescription: string;
  summary: string;
  /** What the live page does with it today. */
  publishedVisible: boolean;
  /** What the layout draft intends, or `null` when the draft leaves it out. */
  layoutVisible: boolean | null;
  isDraftOnly: boolean;
  draftKind: DraftKind;
};

const EMPTY: ActionState = { ok: false };

/**
 * The section list is the page's **layout draft**.
 *
 * Every control here edits a document that says what publishing the layout
 * would do. Nothing on this screen changes what a visitor is getting: moving a
 * section, hiding it or removing it are all intentions, and the live page keeps
 * its current order and membership until the layout is published — which is not
 * a button that exists yet.
 *
 * That is why the wording is careful. "Hidden" would be a lie about a section a
 * visitor can still see, so the badges say what *will* happen, and a removed
 * section is listed rather than gone, one click from coming back.
 *
 * Each control is still its own tiny form, so every one of them is a real POST
 * that works before hydration and is checked against the same permission and
 * the same page revision on the server.
 */
export function SectionList({
  csrf,
  pageId,
  pageRevision,
  hasLayoutDraft,
  sections,
  removed,
  blocks,
  canManage,
}: {
  csrf: string;
  pageId: number;
  /**
   * The page revision this screen was built from, carried by every structural
   * form. Not inferred in the action: a revision the server read for itself
   * would guard the microseconds around its own write rather than the hour this
   * tab has been open.
   */
  pageRevision: number;
  hasLayoutDraft: boolean;
  sections: SectionRow[];
  removed: SectionRow[];
  blocks: BlockDef[];
  canManage: boolean;
}) {
  const [addState, addAction] = useActionState<ActionState, FormData>(addSection, EMPTY);
  const [reorderState, reorderAction] = useActionState<ActionState, FormData>(reorderSections, EMPTY);

  // Local order, so a drag lands immediately rather than after a round trip.
  // The server is the authority: once it answers, the page revalidates and the
  // prop below replaces this.
  const [order, setOrder] = useState<SectionRow[]>(sections);
  const [dragging, setDragging] = useState<number | null>(null);
  const [over, setOver] = useState<number | null>(null);
  const submitRef = useRef<HTMLButtonElement>(null);
  const signature = sections.map((s) => `${s.id}:${s.layoutVisible}`).join(",");

  useEffect(() => {
    setOrder(sections);
    // Re-syncs whenever the page sends a different set or a different order.
  }, [signature, sections]);

  const dropOnto = (target: number) => {
    if (dragging === null || dragging === target) return;
    const next = [...order];
    const [moved] = next.splice(dragging, 1);
    next.splice(target, 0, moved!);
    setOrder(next);
    setDragging(null);
    setOver(null);
    // Persist on the next tick, once the hidden input carries the new order.
    queueMicrotask(() => submitRef.current?.click());
  };

  const pendingEdits = removed.length > 0 || sections.some((s) => s.isDraftOnly);

  return (
    <div className="space-y-5">
      <section className="admin-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--admin-line)] px-4 py-3">
          <h2>Sections</h2>
          <p className="text-[0.74rem] text-muted">
            {order.length} section{order.length === 1 ? "" : "s"} · top to bottom
            {canManage ? " · drag a row, or use the arrows" : null}
          </p>
        </div>

        {hasLayoutDraft || pendingEdits ? (
          <div className="flex flex-wrap items-center gap-3 border-b border-[var(--admin-line)] bg-[color-mix(in_oklab,#ffd166_8%,transparent)] px-4 py-2.5">
            <span className="admin-badge" style={{ color: "#ffd166" }}>
              Layout draft
            </span>
            <p className="min-w-40 flex-1 text-[0.78rem] text-muted">
              The order, visibility and membership below are unpublished. The live page still shows
              the layout it had before these changes.
            </p>
            {canManage ? (
              <InlineAction
                action={discardLayout}
                hidden={{ _csrf: csrf, pageId, expectedRevision: pageRevision }}
              >
                <ConfirmSubmit
                  className="admin-btn-sm"
                  message="Discard the layout changes? Sections added here are deleted; content drafts on existing sections are kept."
                >
                  Discard layout changes
                </ConfirmSubmit>
              </InlineAction>
            ) : null}
          </div>
        ) : null}

        {reorderState.message && !reorderState.ok ? (
          <p
            role="alert"
            className="border-b border-[var(--admin-line)] px-4 py-2 text-[0.78rem]"
            style={{ color: "#ffb4ad" }}
          >
            {reorderState.message}
          </p>
        ) : null}

        {/* Submitted by the drop handler. Keyboard users reorder with the
            arrow buttons on each row, which post the same way. */}
        <form action={reorderAction} className="hidden">
          <input type="hidden" name="_csrf" value={csrf} />
          <input type="hidden" name="pageId" value={pageId} />
          <input type="hidden" name="expectedRevision" value={pageRevision} />
          <input type="hidden" name="order" value={JSON.stringify(order.map((s) => s.id))} />
          <button ref={submitRef} type="submit" tabIndex={-1} aria-hidden />
        </form>

        {order.length === 0 ? (
          <p className="px-4 py-10 text-center text-[0.83rem] text-muted">
            This layout has no sections. Add one below.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--admin-line)]">
            {order.map((section, index) => (
              <li
                key={section.id}
                draggable={canManage}
                onDragStart={(event) => {
                  setDragging(index);
                  event.dataTransfer.effectAllowed = "move";
                  // Firefox will not start a drag without data on the transfer.
                  event.dataTransfer.setData("text/plain", String(section.id));
                }}
                onDragOver={(event) => {
                  if (dragging === null) return;
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setOver(index);
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  dropOnto(index);
                }}
                onDragEnd={() => {
                  setDragging(null);
                  setOver(null);
                }}
                data-dragging={dragging === index || undefined}
                data-over={over === index && dragging !== index ? true : undefined}
                data-section-id={section.id}
                className="flex flex-wrap items-start gap-3 px-4 py-3.5 transition-colors data-[dragging]:opacity-45 data-[over]:bg-[color-mix(in_oklab,var(--color-orange)_12%,transparent)]"
              >
                {canManage ? (
                  <span
                    aria-hidden
                    title="Drag to reorder"
                    className="mt-1.5 shrink-0 cursor-grab select-none text-[0.8rem] leading-none text-muted active:cursor-grabbing"
                  >
                    ⠿
                  </span>
                ) : null}
                <span className="mt-1 w-6 shrink-0 text-[0.72rem] tabular-nums text-muted">
                  {String(index + 1).padStart(2, "0")}
                </span>

                <div className="min-w-52 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={`/admin/pages/section/${section.id}`}
                      className="font-semibold text-strong hover:text-[var(--color-peach)]"
                    >
                      {section.blockName}
                    </Link>
                    <Badges section={section} />
                  </div>
                  <p className="mt-0.5 line-clamp-1 text-[0.78rem] text-muted">
                    {section.summary || section.blockDescription}
                  </p>
                </div>

                {canManage ? (
                  <div className="flex flex-wrap items-center gap-1">
                    <Structural csrf={csrf} revision={pageRevision} id={section.id} direction="up">
                      <IconButton label="Move up" icon="chevronDown" rotate disabled={index === 0} />
                    </Structural>
                    <Structural csrf={csrf} revision={pageRevision} id={section.id} direction="down">
                      <IconButton
                        label="Move down"
                        icon="chevronDown"
                        disabled={index === order.length - 1}
                      />
                    </Structural>
                    <InlineAction
                      action={duplicateSection}
                      hidden={{ _csrf: csrf, id: section.id, expectedRevision: pageRevision }}
                      className="contents"
                    >
                      <IconButton label="Duplicate" icon="layers" />
                    </InlineAction>
                    <InlineAction
                      action={toggleSection}
                      hidden={{
                        _csrf: csrf,
                        id: section.id,
                        expectedRevision: pageRevision,
                        visible: section.layoutVisible ? "false" : "true",
                      }}
                      className="contents"
                    >
                      <IconButton
                        label={
                          section.layoutVisible
                            ? "Hide when the layout is published"
                            : "Show when the layout is published"
                        }
                        icon={section.layoutVisible ? "eyeOff" : "eye"}
                      />
                    </InlineAction>
                    <InlineAction
                      action={deleteSection}
                      hidden={{ _csrf: csrf, id: section.id, expectedRevision: pageRevision }}
                      className="contents"
                    >
                      <ConfirmSubmit
                        className="admin-btn-sm"
                        message={`Remove the ${section.blockName} section from the layout draft? It stays on the live page until the layout is published, and you can restore it.`}
                      >
                        <Icon name="trash" size={12} />
                        <span className="sr-only">Remove from layout</span>
                      </ConfirmSubmit>
                    </InlineAction>
                    <Link
                      href={`/admin/pages/section/${section.id}`}
                      className="admin-btn admin-btn-sm ms-1"
                    >
                      Edit
                    </Link>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {removed.length ? (
        <section className="admin-card overflow-hidden" data-removed-sections>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--admin-line)] px-4 py-3">
            <h2>Removed from the layout</h2>
            <p className="text-[0.74rem] text-muted">
              Still on the live page until the layout is published
            </p>
          </div>
          <ul className="divide-y divide-[var(--admin-line)]">
            {removed.map((section) => (
              <li
                key={section.id}
                data-section-id={section.id}
                className="flex flex-wrap items-center gap-3 px-4 py-3"
              >
                <div className="min-w-52 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-strong">{section.blockName}</span>
                    <Badges section={section} removed />
                  </div>
                  <p className="mt-0.5 line-clamp-1 text-[0.78rem] text-muted">
                    {section.summary || section.blockDescription}
                  </p>
                </div>
                {canManage ? (
                  <InlineAction
                    action={restoreSection}
                    hidden={{ _csrf: csrf, id: section.id, expectedRevision: pageRevision }}
                  >
                    <SubmitButton pendingLabel="Restoring…">Restore</SubmitButton>
                  </InlineAction>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {canManage ? (
        <section className="admin-card p-5">
          <h2 className="mb-1">Add a section</h2>
          <p className="mb-4 text-[0.8rem] text-muted">
            Sections come from a fixed set, which is what keeps the design consistent. A new one
            joins the end of the layout draft and reaches the site when the layout is published.
          </p>

          {addState.message ? (
            <p
              role="status"
              className="mb-4 rounded-[var(--radius-sm)] border p-3 text-[0.8rem]"
              style={
                addState.ok
                  ? { borderColor: "#3ddc8466", background: "#3ddc840f", color: "#9ff0c4" }
                  : { borderColor: "#ef535066", background: "#ef53500f", color: "#ffb4ad" }
              }
            >
              {addState.message}
            </p>
          ) : null}

          <form action={addAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="_csrf" value={csrf} />
            <input type="hidden" name="pageId" value={pageId} />
            <input type="hidden" name="expectedRevision" value={pageRevision} />
            <div className="min-w-56 flex-1">
              <label className="admin-label" htmlFor="blockType">
                Section type
              </label>
              <select id="blockType" name="blockType" className="admin-select" defaultValue="">
                <option value="" disabled>
                  Choose a section…
                </option>
                {blocks.map((block) => (
                  <option key={block.type} value={block.type}>
                    {block.name} — {block.description}
                  </option>
                ))}
              </select>
            </div>
            <SubmitButton pendingLabel="Adding…">Add section</SubmitButton>
          </form>
        </section>
      ) : null}
    </div>
  );
}

/**
 * What is pending about a section, in as few words as fit.
 *
 * Four different things can be unpublished about one row and they are not the
 * same thing: its text, its layout position, whether it is going to be shown,
 * and whether it exists on the live site at all. One generic "Draft" badge for
 * all of them would tell an editor that something is pending and nothing about
 * what.
 */
function Badges({ section, removed }: { section: SectionRow; removed?: boolean }) {
  return (
    <>
      {section.isDraftOnly ? (
        <span className="admin-badge" style={{ color: "#5ad19a" }}>
          New
        </span>
      ) : null}
      {removed ? (
        <span className="admin-badge" style={{ color: "#ffb4ad" }}>
          Will be removed
        </span>
      ) : section.layoutVisible === false ? (
        <span className="admin-badge" style={{ color: "#9aa2b5" }}>
          Will be hidden
        </span>
      ) : null}
      {/* What the live page is doing now, when that differs from the intent. */}
      {!section.isDraftOnly && !section.publishedVisible ? (
        <span className="admin-badge" style={{ color: "#9aa2b5" }}>
          Hidden on the site
        </span>
      ) : null}
      {hasDraft(section.draftKind) ? (
        <span
          className="admin-badge"
          style={{ color: "#ffd166" }}
          title={DRAFT_LABEL[section.draftKind]}
        >
          {DRAFT_BADGE[section.draftKind]}
        </span>
      ) : null}
    </>
  );
}

/** A move form, which is a reorder of one step on the server. */
function Structural({
  csrf,
  revision,
  id,
  direction,
  children,
}: {
  csrf: string;
  revision: number;
  id: number;
  direction: "up" | "down";
  children: React.ReactNode;
}) {
  return (
    <InlineAction
      action={moveSection}
      hidden={{ _csrf: csrf, id, direction, expectedRevision: revision }}
      className="contents"
    >
      {children}
    </InlineAction>
  );
}

function IconButton({
  label,
  icon,
  rotate,
  disabled,
}: {
  label: string;
  icon: string;
  rotate?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="submit"
      disabled={disabled}
      aria-label={label}
      title={label}
      className="admin-btn admin-btn-sm"
    >
      <Icon name={icon} size={12} className={rotate ? "rotate-180" : undefined} />
    </button>
  );
}
