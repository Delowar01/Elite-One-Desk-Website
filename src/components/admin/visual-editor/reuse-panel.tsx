"use client";

import { useState } from "react";

import { Icon } from "@/components/ui/icon";
import { kindDef } from "@/lib/cms/reuse/kinds";
import {
  BLOCK_SLOT,
  effectiveSlotValues,
  hasSeparateLinks,
  linkSlot,
  overrideLabel,
  readReuse,
  setOverride,
  slotsOf,
  WHOLE_BLOCK_REFUSAL,
  type SlotDef,
  type SlotRef,
} from "@/lib/cms/reuse/reference";
import { pickerEntries } from "@/lib/cms/reuse/picker";
import { usageHeadline } from "@/lib/cms/reuse/usage-view";
import type { ReuseCatalogEntry } from "@/lib/cms/reuse/view";
import type { Locale } from "@/lib/i18n/config";

/**
 * The Content tab's reusable-component panel (Batch 17): what a selected
 * section links to, and the controls that change the link.
 *
 * Every control here edits the section's *own* draft — never the component.
 * Linking, switching an override on or off and resetting one are content edits
 * in the section's buffer, saved by the ordinary autosave and taken back by the
 * page's Undo, each named for what it was. Detaching is resolved by the server
 * and enters the same history. The component itself is changed in one place
 * only — its own editor, behind "Edit global component" — so no field in this
 * panel can look local while being global.
 */

type Values = Record<string, unknown>;

/** The direct-edit refusal the canvas asked for: this text is linked and not overridden here. */
export type ReuseNotice = { sectionId: number; slot: string; key: string };

/**
 * What this panel may offer (Batch 18), answered from `lib/auth/authority.ts`
 * by the shell. Each control asks for exactly its own capability, and the
 * server checks the same one again.
 */
export type ReuseAccess = {
  /** Typing into an override that is already on — ordinary page content (`content.edit`). */
  typeOverride: boolean;
  /**
   * Link, unlink, switch an override on or off, detach — page content plus
   * seeing the shared definition (`content.edit` and `components.view`).
   */
  instances: boolean;
  /** Save as reusable, as a draft (`content.view` and `components.edit`). */
  saveDraft: boolean;
  /** "Create, publish and link" — `content.edit`, `components.edit` and `components.publish`. */
  savePublished: boolean;
  /** Open a component's own editor or its usage (`components.view`). */
  open: boolean;
};

export type ReuseControls = {
  access: ReuseAccess;
  /** Every component, with usage; `null` until it has been read, or for nobody allowed to. */
  catalog: ReuseCatalogEntry[] | null;
  notice: ReuseNotice | null;
  /** A detach or a save-as is on its way to the server. */
  busy: boolean;
  message: { ok: boolean; text: string } | null;
  /** A labelled instance action — link, override on, reset — as one content edit. */
  onInstance: (values: Values, label: string) => void;
  onDetach: (slot: string, componentId: number, version: number) => void;
  onSaveAs: (slot: string, name: string, publish: boolean) => void;
  /** Opens the component's own editor — to edit it, or at its usage list. */
  onOpen: (componentId: number, focus: "edit" | "usage") => void;
  onDismissNotice: () => void;
};

const asLocalised = (value: unknown): { en: string; ar: string } => {
  const source = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return { en: String(source.en ?? ""), ar: String(source.ar ?? "") };
};

/** The string one key names inside a set of section values. */
function valueAt(values: Values, key: string): string {
  const [field, edition] = key.split(".") as [string, "en" | "ar" | undefined];
  const raw = values[field];
  if (edition) return asLocalised(raw)[edition];
  return typeof raw === "string" ? raw : "";
}

/** "Published v3 · draft pending", said in words, never colour alone. */
export function componentStatus(entry: Pick<ReuseCatalogEntry, "status" | "publishedVersion" | "hasDraft">): string {
  if (entry.status === "archived") return "Archived";
  if (entry.publishedVersion < 1) return "Not published yet";
  return `Published v${entry.publishedVersion}${entry.hasDraft ? " · draft pending" : ""}`;
}

export function ReusePanel({
  blockType,
  sectionId,
  values,
  locale,
  focusField,
  controls,
  onValues,
}: {
  blockType: string;
  sectionId: number;
  values: Values;
  locale: Locale;
  /** The field the canvas has selected, so its slot can be pointed at. */
  focusField: string | null;
  controls: ReuseControls;
  /** Typing into an override is ordinary typing — it groups like any other field. */
  onValues: (values: Values) => void;
}) {
  const slots = slotsOf(blockType);
  if (!slots.length) return null;
  const links = readReuse(values, blockType);
  const whole = links[BLOCK_SLOT];
  // A whole-section link supplies the calls to action too, so their own slots
  // are not offered beside it.
  const shown = whole ? slots.filter((slot) => slot.slot === BLOCK_SLOT) : slots;

  return (
    <section className="flex flex-col gap-2" aria-label="Reusable components" data-reuse-panel={sectionId}>
      {controls.message ? (
        <p
          role="status"
          className="admin-card p-2.5 text-[0.74rem] leading-relaxed"
          style={{ color: controls.message.ok ? "#5ad19a" : "#ef8f8a" }}
        >
          {controls.message.text}
        </p>
      ) : null}
      {shown.map((slot) => {
        const ref = links[slot.slot];
        const focused = focusField !== null && slot.fields.some((field) => field.name === focusField);
        return ref ? (
          <LinkedSlot
            key={slot.slot}
            blockType={blockType}
            sectionId={sectionId}
            slot={slot}
            reference={ref}
            values={values}
            locale={locale}
            focused={focused || slot.slot === BLOCK_SLOT}
            controls={controls}
            onValues={onValues}
          />
        ) : (
          <UnlinkedSlot
            key={slot.slot}
            blockType={blockType}
            slot={slot}
            values={values}
            focused={focused}
            controls={controls}
            blocked={slot.slot === BLOCK_SLOT && hasSeparateLinks(blockType, values) ? WHOLE_BLOCK_REFUSAL : null}
          />
        );
      })}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* A linked slot                                                              */
/* -------------------------------------------------------------------------- */

function LinkedSlot({
  blockType,
  sectionId,
  slot,
  reference,
  values,
  locale,
  focused,
  controls,
  onValues,
}: {
  blockType: string;
  sectionId: number;
  slot: SlotDef;
  reference: SlotRef;
  values: Values;
  locale: Locale;
  focused: boolean;
  controls: ReuseControls;
  onValues: (values: Values) => void;
}) {
  const overrides = reference.o ?? [];
  const [overriding, setOverriding] = useState(overrides.length > 0);
  const [confirmDetach, setConfirmDetach] = useState(false);
  const entry = controls.catalog?.find((candidate) => candidate.id === reference.c) ?? null;
  const kind = kindDef(slot.kind);
  const available = Boolean(entry && entry.kind === slot.kind && entry.published);
  const name = entry?.name ?? "a reusable component";
  const shown = effectiveSlotValues(slot, values, available ? entry!.published : null, overrides);
  const inherited = effectiveSlotValues(slot, values, available ? entry!.published : null, []);
  // The edition on screen, plus every key that has no edition.
  const keys = slot.overridable.filter((key) => !key.includes(".") || key.endsWith(`.${locale}`));
  const fixed = slot.fields.filter((field) => !["text", "textarea", "link"].includes(field.type));
  const notice = controls.notice?.sectionId === sectionId && controls.notice.slot === slot.slot ? controls.notice : null;
  const { access } = controls;

  const toggle = (key: string, on: boolean) => {
    const next = setOverride(blockType, values, slot.slot, key, on, on ? valueAt(shown, key) : valueAt(inherited, key));
    if (!next) return;
    const what = overrideLabel(blockType, slot.slot, key);
    controls.onInstance(next, on ? `Override ${what} on this page` : `Reset override of ${what}`);
  };

  const type = (key: string, text: string) => {
    const [field, edition] = key.split(".") as [string, "en" | "ar" | undefined];
    onValues({
      ...values,
      [field]: edition ? { ...asLocalised(values[field]), [edition]: text } : text,
    });
  };

  return (
    <div
      className="admin-card flex flex-col gap-2 p-2.5"
      data-reuse-slot={slot.slot}
      data-reuse-component={reference.c}
      style={focused ? { borderColor: "var(--color-orange)" } : undefined}
    >
      <div>
        <p className="flex flex-wrap items-center gap-1.5 text-[0.66rem] font-semibold uppercase tracking-[0.07em] text-muted">
          <Icon name="layers" size={11} />
          {kind?.label ?? "Reusable component"}
          <span className="normal-case tracking-normal">· {slot.label}</span>
        </p>
        <p className="mt-0.5 text-[0.86rem] font-semibold leading-snug text-strong" data-reuse-name>
          {name}
        </p>
        <p className="mt-0.5 text-[0.7rem] text-muted" data-reuse-usage>
          {entry ? `${usageHeadline(entry.usage)} · ${componentStatus(entry)}` : "Reusable component unavailable"}
        </p>
      </div>

      {!available ? (
        <p className="text-[0.74rem] leading-relaxed" role="note" style={{ color: "#ef8f8a" }} data-reuse-unavailable>
          Reusable component unavailable — this section is showing the copy it kept when it was linked. Detach it to
          keep that content as this page’s own.
        </p>
      ) : null}

      {notice ? (
        <div className="rounded-[var(--radius-xs)] border border-[var(--admin-line)] p-2" role="alert" data-reuse-notice>
          <p className="text-[0.74rem] leading-relaxed text-body">
            {access.instances || access.open ? (
              <>
                This text comes from reusable component “{name}”. Edit the global component, or create an override for
                this page.
              </>
            ) : (
              "This text comes from a reusable component. Your role does not allow changing how this page uses it."
            )}
          </p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {access.open ? (
              <button type="button" className="admin-btn admin-btn-sm" onClick={() => controls.onOpen(reference.c, "edit")}>
                Edit global component
              </button>
            ) : null}
            {access.instances && available ? (
              <button
                type="button"
                className="admin-btn admin-btn-sm"
                onClick={() => {
                  setOverriding(true);
                  toggle(notice.key, true);
                  controls.onDismissNotice();
                }}
              >
                Override on this page
              </button>
            ) : null}
            <button type="button" className="admin-btn admin-btn-sm" onClick={controls.onDismissNotice}>
              Dismiss
            </button>
          </div>
        </div>
      ) : null}

      <ul className="flex flex-col gap-1.5" aria-label={`Content of ${slot.label.toLowerCase()}`}>
        {keys.map((key) => {
          const label = overrideLabel(blockType, slot.slot, key);
          const local = overrides.includes(key);
          const field = slot.fields.find((candidate) => candidate.name === key.split(".")[0]);
          const inputId = `reuse-${sectionId}-${key.replace(".", "-")}`;
          return (
            <li key={key} className="text-[0.74rem] leading-snug" data-reuse-key={key} data-reuse-mode={local ? "override" : "inherited"}>
              {local ? (
                <>
                  <label htmlFor={inputId} className="block font-medium text-strong">
                    Override on this page — {label}
                  </label>
                  {field?.type === "textarea" ? (
                    <textarea
                      id={inputId}
                      rows={3}
                      value={valueAt(values, key)}
                      disabled={!access.typeOverride}
                      onChange={(event) => type(key, event.target.value)}
                      className="admin-input mt-1"
                    />
                  ) : (
                    <input
                      id={inputId}
                      value={valueAt(values, key)}
                      disabled={!access.typeOverride}
                      onChange={(event) => type(key, event.target.value)}
                      className="admin-input mt-1"
                    />
                  )}
                  <p className="mt-0.5 text-muted">
                    Inherited value: {valueAt(inherited, key) || "(empty)"}
                  </p>
                  {access.instances ? (
                    <button type="button" className="admin-btn admin-btn-sm mt-1" onClick={() => toggle(key, false)}>
                      Reset override
                    </button>
                  ) : null}
                </>
              ) : (
                <>
                  <p className="text-muted">
                    <span className="font-medium text-body">{label}</span> — inherited from “{name}”
                  </p>
                  <p className="mt-0.5 break-words text-strong">{valueAt(shown, key) || "(empty)"}</p>
                  {overriding && access.instances && available ? (
                    <button type="button" className="admin-btn admin-btn-sm mt-1" onClick={() => toggle(key, true)}>
                      Override on this page
                    </button>
                  ) : null}
                </>
              )}
            </li>
          );
        })}
      </ul>
      {fixed.length ? (
        <p className="text-[0.7rem] text-muted">
          Also inherited: {fixed.map((field) => field.label).join(", ")}. Detach to change these on this page only.
        </p>
      ) : null}

      {!access.open ? (
        <p className="text-[0.7rem] leading-relaxed text-muted" role="note" data-permission-note="components.view">
          Your role does not allow viewing reusable components, so this one cannot be opened, linked or detached here.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        {access.open ? (
          <>
            <button type="button" className="admin-btn admin-btn-sm" onClick={() => controls.onOpen(reference.c, "edit")}>
              Edit global component
            </button>
            <button type="button" className="admin-btn admin-btn-sm" onClick={() => controls.onOpen(reference.c, "usage")}>
              View usage
            </button>
          </>
        ) : null}
        {access.instances && available ? (
          <button
            type="button"
            className="admin-btn admin-btn-sm"
            aria-expanded={overriding}
            onClick={() => setOverriding((open) => !open)}
          >
            Override this instance
          </button>
        ) : null}
        {access.instances ? (
          <button
            type="button"
            className="admin-btn admin-btn-sm"
            disabled={controls.busy}
            onClick={() => setConfirmDetach(true)}
          >
            Detach from global
          </button>
        ) : null}
      </div>

      {confirmDetach && access.instances ? (
        <div className="rounded-[var(--radius-xs)] border border-[var(--admin-line)] p-2" role="alertdialog" aria-label="Detach this instance" data-reuse-detach-confirm>
          <p className="text-[0.76rem] font-semibold text-strong">Detach this instance from “{name}”?</p>
          <p className="mt-1 text-[0.74rem] leading-relaxed text-body">
            It will keep its current content but will no longer receive future global updates. The change is a draft
            on this page, and Undo takes it back.
          </p>
          <div className="mt-2 flex gap-1.5">
            <button
              type="button"
              className="admin-btn admin-btn-sm admin-btn-danger"
              disabled={controls.busy}
              onClick={() => {
                setConfirmDetach(false);
                controls.onDetach(slot.slot, reference.c, available ? entry!.publishedVersion : 0);
              }}
            >
              Detach
            </button>
            {/* The warning takes the focus, onto the choice that changes nothing,
                so a keyboard reaches it before Detach and a screen reader reads
                it out (19B). */}
            <button type="button" className="admin-btn admin-btn-sm" onClick={() => setConfirmDetach(false)} autoFocus>
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* An unlinked slot                                                           */
/* -------------------------------------------------------------------------- */

function UnlinkedSlot({
  blockType,
  slot,
  values,
  focused,
  controls,
  blocked,
}: {
  blockType: string;
  slot: SlotDef;
  values: Values;
  focused: boolean;
  controls: ReuseControls;
  /** Why this slot cannot be linked or saved as reusable right now, if it cannot. */
  blocked: string | null;
}) {
  const [mode, setMode] = useState<null | "link" | "save">(null);
  const cta = slot.kind === "cta";
  const noun = cta ? "CTA" : "component";
  const { access } = controls;
  // Nothing to offer: a reader sees the section's own content in the fields below.
  if (!access.instances && !access.saveDraft) return null;
  if (blocked) {
    return (
      <div
        className="rounded-[var(--radius-xs)] border border-dashed border-[var(--admin-line)] p-2"
        data-reuse-slot={slot.slot}
        data-reuse-unlinked
        style={focused ? { borderColor: "var(--color-orange)" } : undefined}
      >
        <p className="text-[0.72rem] text-muted">
          <span className="font-medium text-body">{slot.label}</span> — this page’s own content
        </p>
        <p className="mt-1.5 text-[0.72rem] leading-relaxed text-muted" role="note" data-reuse-blocked>
          {blocked}
        </p>
      </div>
    );
  }

  return (
    <div
      className="rounded-[var(--radius-xs)] border border-dashed border-[var(--admin-line)] p-2"
      data-reuse-slot={slot.slot}
      data-reuse-unlinked
      style={focused ? { borderColor: "var(--color-orange)" } : undefined}
    >
      <p className="text-[0.72rem] text-muted">
        <span className="font-medium text-body">{slot.label}</span> — this page’s own content
      </p>
      <div className="mt-1.5 flex flex-wrap gap-1.5">
        {access.instances ? (
          <button
            type="button"
            className="admin-btn admin-btn-sm"
            aria-expanded={mode === "link"}
            onClick={() => setMode(mode === "link" ? null : "link")}
          >
            {cta ? "Link to reusable CTA…" : "Link section to reusable component…"}
          </button>
        ) : null}
        {access.saveDraft ? (
          <button
            type="button"
            className="admin-btn admin-btn-sm"
            aria-expanded={mode === "save"}
            onClick={() => setMode(mode === "save" ? null : "save")}
          >
            {cta ? "Save as reusable CTA…" : "Save section as reusable component…"}
          </button>
        ) : null}
      </div>
      {mode === "link" && access.instances ? (
        <ReusePicker
          kinds={[slot.kind]}
          catalog={controls.catalog}
          label={cta ? "Choose a reusable CTA" : "Choose a reusable component"}
          onClose={() => setMode(null)}
          onPick={(entry) => {
            const next = linkSlot(blockType, values, slot.slot, { id: entry.id, kind: entry.kind, values: entry.published! });
            if (!next) return;
            setMode(null);
            controls.onInstance(next, `Link ${slot.label.toLowerCase()} to “${entry.name}”`);
          }}
        />
      ) : null}
      {mode === "save" && access.saveDraft ? (
        <SaveAsForm
          noun={noun}
          canPublish={access.savePublished}
          busy={controls.busy}
          onCancel={() => setMode(null)}
          onSave={(name, publish) => {
            setMode(null);
            controls.onSaveAs(slot.slot, name, publish);
          }}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Picker and save-as                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Choosing a component: searchable, filtered to the kinds the slot takes,
 * archived components left out. One that has never been published is listed
 * but cannot be chosen — a page must never be linked to content no visitor
 * could be shown — and says why.
 */
function ReusePicker({
  kinds,
  catalog,
  label,
  onPick,
  onClose,
}: {
  kinds: string[];
  catalog: ReuseCatalogEntry[] | null;
  label: string;
  onPick: (entry: ReuseCatalogEntry) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const list = pickerEntries(catalog, kinds, query, kind);
  const searchId = `reuse-search-${kinds.join("-").replace(/[^a-z-]/g, "")}`;

  return (
    <div className="mt-2 flex flex-col gap-1.5" role="group" aria-label={label} data-reuse-picker>
      <label htmlFor={searchId} className="text-[0.68rem] font-semibold uppercase tracking-wide text-muted">
        {label}
      </label>
      <input
        id={searchId}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Search by name"
        className="admin-input"
        autoFocus
      />
      {kinds.length > 1 ? (
        <select
          aria-label="Type"
          value={kind}
          onChange={(event) => setKind(event.target.value)}
          className="admin-select"
        >
          <option value="all">Every type</option>
          {kinds.map((value) => (
            <option key={value} value={value}>
              {kindDef(value)?.label ?? value}
            </option>
          ))}
        </select>
      ) : null}
      {catalog === null ? (
        <p className="text-[0.72rem] text-muted">Reading reusable components…</p>
      ) : list.length ? (
        <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto" aria-label="Reusable components">
          {list.map(({ entry, linkable: ready }) => {
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  disabled={!ready}
                  onClick={() => onPick(entry)}
                  data-reuse-choice={entry.id}
                  className="w-full rounded-[var(--radius-xs)] border border-[var(--admin-line)] px-2 py-1.5 text-start transition-colors enabled:hover:bg-[color-mix(in_oklab,var(--color-orange)_12%,transparent)] disabled:opacity-60"
                >
                  <span className="block truncate text-[0.78rem] font-medium text-strong">{entry.name}</span>
                  <span className="block text-[0.66rem] text-muted">
                    {kindDef(entry.kind)?.label ?? entry.kind} · {usageHeadline(entry.usage)} · {componentStatus(entry)}
                  </span>
                  {!ready ? (
                    <span className="block text-[0.66rem] text-muted">Publish it before linking anything to it.</span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-[0.72rem] leading-relaxed text-muted">
          No reusable component matches. Make one with “Save as reusable…”, or on the Reusable components screen.
        </p>
      )}
      <button type="button" className="admin-btn admin-btn-sm self-start" onClick={onClose}>
        Close
      </button>
    </div>
  );
}

function SaveAsForm({
  noun,
  canPublish,
  busy,
  onSave,
  onCancel,
}: {
  noun: string;
  /**
   * Publishing in the same step is offered only to a role that may do all of
   * it — edit page content, and edit and publish reusable components (Batch 18).
   */
  canPublish: boolean;
  busy: boolean;
  onSave: (name: string, publish: boolean) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  // Draft first: publishing is a deliberate second choice, never the default.
  const [publish, setPublish] = useState(false);
  return (
    <form
      className="mt-2 flex flex-col gap-1.5"
      aria-label={`Save as reusable ${noun}`}
      data-reuse-save-as
      onSubmit={(event) => {
        event.preventDefault();
        if (name.trim()) onSave(name.trim(), publish && canPublish);
      }}
    >
      <label className="text-[0.72rem] font-medium text-strong">
        Name <span className="font-normal text-muted">(for the admin — visitors never see it)</span>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={120}
          required
          className="admin-input mt-1"
        />
      </label>
      <fieldset className="flex flex-col gap-1 border-0 p-0">
        <legend className="sr-only">How to create it</legend>
        <label className="flex items-start gap-2 text-[0.74rem]">
          <input
            type="radio"
            name="reuse-publish"
            checked={!publish}
            onChange={() => setPublish(false)}
            className="mt-0.5"
            data-reuse-save-mode="draft"
          />
          <span>
            <span className="block font-medium text-strong">Create a draft only</span>
            <span className="block text-muted">Nothing is linked. Publish it from its own editor first.</span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-[0.74rem]">
          <input
            type="radio"
            name="reuse-publish"
            checked={publish}
            disabled={!canPublish}
            onChange={() => setPublish(true)}
            className="mt-0.5"
            data-reuse-save-mode="publish"
          />
          <span>
            <span className="block font-medium text-strong">Create, publish and link</span>
            <span className="block text-muted">
              {canPublish
                ? `Publishes its first version with exactly this content and links this ${noun} to it. Nothing on the site changes — nothing else uses it yet, and this page’s link stays a draft until you publish the page.`
                : "Your role does not allow this: it needs permission to edit page content and to edit and publish reusable components."}
            </span>
          </span>
        </label>
      </fieldset>
      <div className="flex gap-1.5">
        <button
          type="submit"
          className="admin-btn admin-btn-sm admin-btn-primary"
          disabled={busy || !name.trim()}
          data-reuse-save-submit
        >
          {publish ? "Create, publish and link" : `Create ${noun} draft`}
        </button>
        <button type="button" className="admin-btn admin-btn-sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
