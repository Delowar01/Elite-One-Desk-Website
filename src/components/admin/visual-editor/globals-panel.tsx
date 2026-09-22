"use client";

import { useCallback, useMemo, useState } from "react";

import {
  deleteNavItem,
  moveNavItem,
  saveNavItem,
} from "@/app/(backoffice)/admin/(shell)/navigation/actions";
import {
  deleteSocialLink,
  moveSocialLink,
  saveBrand,
  saveContact,
  saveDisclaimers,
  saveFeatures,
  saveSocialLink,
  saveWhatsapp,
  toggleSocialLink,
} from "@/app/(backoffice)/admin/(shell)/settings/actions";
import { Icon } from "@/components/ui/icon";
import type { ActionState } from "@/lib/admin/actions";
import { SOCIAL_PLATFORMS, socialLabel } from "@/lib/social";
import type { GlobalNavRow, GlobalsState } from "@/lib/visual-editor/globals";

/**
 * The site's own drawer, beside the page's.
 *
 * Everything in here is **global**: the menus, the brand and contact details,
 * WhatsApp, the disclaimers, the visible feature switches and the social links.
 * None of it belongs to the page on the canvas, none of it has a draft, and
 * none of it appears in Version History — so it is a drawer of its own rather
 * than a fifth Inspector tab, which would read as "this section's settings".
 *
 * Two things follow from globals having no draft state, and the panel says both
 * rather than implying them:
 *
 *   1. There is no autosave here. Every change is an explicit Save, Move, Hide
 *      or Delete — because a keystroke that reaches the live site 1100ms later
 *      is not an edit anybody agreed to make.
 *   2. A save is live the moment it succeeds. The note at the top says so once,
 *      not under every field.
 *
 * Every write is the ordinary admin action for that domain, imported and called
 * directly: `navigation.manage` or `settings.manage` is checked on the server,
 * the same validator runs, the same audit line is written, and the same cache
 * tag is dropped. This panel is a second interface, never a second set of
 * rules — and the Navigation and Site settings screens keep working exactly as
 * they did.
 */

const MENUS = [
  { key: "header", title: "Header menu", note: "The main navigation. One level of sub-links." },
  { key: "footer_services", title: "Footer — Services", note: "The services column." },
  { key: "footer_company", title: "Footer — Company", note: "The company column." },
  { key: "footer_legal", title: "Footer — Legal", note: "The small print at the very bottom." },
] as const;

type Phase =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; message: string }
  | { kind: "error"; message: string; errors?: Record<string, string> };

type Runner = (prev: ActionState, form: FormData) => Promise<ActionState>;

const IDLE: ActionState = { ok: false };

/* -------------------------------------------------------------------------- */
/* Small pieces                                                               */
/* -------------------------------------------------------------------------- */

function Row({ label, hint, error, children }: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-[0.72rem]">
      <span className="font-medium text-muted">{label}</span>
      {children}
      {hint ? <span className="text-[0.68rem] text-muted">{hint}</span> : null}
      {error ? (
        <span className="text-[0.68rem]" style={{ color: "#ef8f8a" }}>
          {error}
        </span>
      ) : null}
    </label>
  );
}

function Switch({ name, label, defaultChecked }: {
  name: string;
  label: string;
  defaultChecked: boolean;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 text-[0.74rem] text-body">
      <input
        type="checkbox"
        name={name}
        defaultChecked={defaultChecked}
        className="size-4 accent-[var(--color-orange)]"
      />
      {label}
    </label>
  );
}

function Feedback({ phase }: { phase: Phase }) {
  if (phase.kind === "idle") return null;
  if (phase.kind === "saving") {
    return (
      <p className="text-[0.72rem] text-muted" role="status">
        Saving…
      </p>
    );
  }
  return (
    <p
      className="text-[0.72rem]"
      style={{ color: phase.kind === "saved" ? "#5ad19a" : "#ef8f8a" }}
      role={phase.kind === "saved" ? "status" : "alert"}
    >
      {phase.message}
    </p>
  );
}

/**
 * One explicit-save form.
 *
 * `key` on the caller's side is what resets a form after its data has been
 * re-read; nothing here writes into the fields, so a value an admin is part way
 * through typing is never replaced underneath them by a refresh.
 */
function GlobalForm({
  title,
  description,
  csrf,
  action,
  onSaved,
  submitLabel = "Save",
  children,
}: {
  title: string;
  description?: string;
  csrf: string;
  action: Runner;
  onSaved: () => Promise<void> | void;
  submitLabel?: string;
  children: (errors: Record<string, string>) => React.ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [dirty, setDirty] = useState(false);
  const errors = phase.kind === "error" ? (phase.errors ?? {}) : {};

  return (
    <form
      onChange={() => {
        setDirty(true);
        // A stale "Saved live." beside fields somebody is retyping is a lie
        // about the current state; an error stays until it is dealt with.
        if (phase.kind === "saved") setPhase({ kind: "idle" });
      }}
      onSubmit={async (event) => {
        event.preventDefault();
        const element = event.currentTarget;
        const form = new FormData(element);
        form.set("_csrf", csrf);
        setPhase({ kind: "saving" });
        let result: ActionState | null = null;
        try {
          result = await action(IDLE, form);
        } catch {
          result = null;
        }
        if (!result) {
          setPhase({ kind: "error", message: "That could not be sent. Try again." });
          return;
        }
        if (!result.ok) {
          setPhase({
            kind: "error",
            message: result.message ?? "That was not saved.",
            errors: result.errors,
          });
          return;
        }
        setPhase({ kind: "saved", message: "Saved live." });
        setDirty(false);
        await onSaved();
      }}
      className="flex flex-col gap-2.5"
    >
      <div>
        <h4 className="text-[0.78rem] font-semibold text-strong">{title}</h4>
        {description ? (
          <p className="mt-0.5 text-[0.7rem] leading-relaxed text-muted">{description}</p>
        ) : null}
      </div>
      {children(errors)}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          className="admin-btn admin-btn-sm admin-btn-primary"
          disabled={phase.kind === "saving"}
        >
          {submitLabel}
        </button>
        {dirty && phase.kind !== "saving" ? (
          <span className="text-[0.7rem]" style={{ color: "var(--color-peach)" }}>
            Not saved yet
          </span>
        ) : null}
        <Feedback phase={phase} />
      </div>
    </form>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="admin-card flex flex-col gap-3 p-3">
      <h3 className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted">{title}</h3>
      {children}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Navigation                                                                 */
/* -------------------------------------------------------------------------- */

function NavigationArea({
  rows,
  csrf,
  onChanged,
}: {
  rows: GlobalNavRow[];
  csrf: string;
  onChanged: () => Promise<void> | void;
}) {
  const [menu, setMenu] = useState<string>("header");
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * What the last change did, kept at the group level.
   *
   * A form that closes when it succeeds takes its own confirmation with it, and
   * a move, a hide or a delete never had a form to put one in. This is the one
   * place either can be read.
   */
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);

  const inMenu = useMemo(
    () => rows.filter((row) => row.menu === menu),
    [rows, menu],
  );
  /** Top-level links of this menu, the only legal parents. */
  const parents = useMemo(
    () => inMenu.filter((row) => row.parentId === null),
    [inMenu],
  );

  const runRow = useCallback(
    async (action: Runner, fields: Record<string, string>) => {
      setBusy(true);
      setNotice(null);
      const form = new FormData();
      form.set("_csrf", csrf);
      for (const [name, value] of Object.entries(fields)) form.set(name, value);
      let result: ActionState | null = null;
      try {
        result = await action(IDLE, form);
      } catch {
        result = null;
      }
      setBusy(false);
      if (!result || !result.ok) {
        setNotice({ ok: false, message: result?.message ?? "That could not be sent. Try again." });
        return;
      }
      setNotice({ ok: true, message: result.message ?? "Saved live." });
      await onChanged();
    },
    [csrf, onChanged],
  );

  const current = MENUS.find((entry) => entry.key === menu)!;

  return (
    <Group title="Navigation">
      <div className="flex flex-wrap gap-1.5">
        {MENUS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            onClick={() => {
              setMenu(entry.key);
              setEditing(null);
              setNotice(null);
            }}
            className="admin-btn admin-btn-sm"
            aria-pressed={menu === entry.key}
            style={
              menu === entry.key
                ? { borderColor: "var(--color-orange)", color: "var(--color-strong)" }
                : undefined
            }
          >
            {entry.title}
          </button>
        ))}
      </div>
      <p className="text-[0.7rem] text-muted">{current.note}</p>

      {notice ? (
        <p
          className="text-[0.72rem]"
          style={{ color: notice.ok ? "#5ad19a" : "#ef8f8a" }}
          role={notice.ok ? "status" : "alert"}
        >
          {notice.message}
        </p>
      ) : null}

      <ul className="flex flex-col gap-1">
        {inMenu.map((row, index) => (
          <li key={row.id} className="flex flex-col gap-1.5">
            <div
              className="flex items-center gap-1.5 rounded-lg border border-[var(--admin-line)] px-2 py-1.5"
              style={row.parentId ? { marginInlineStart: "1.1rem" } : undefined}
            >
              <span className="min-w-0 flex-1 truncate text-[0.74rem] text-body">
                {row.labelEn || "(no label)"}
                <span className="ms-1.5 text-[0.68rem] text-muted" dir="ltr">
                  {row.href}
                </span>
              </span>
              {!row.isPublished ? (
                <span className="text-[0.66rem] text-muted">Hidden</span>
              ) : null}
              {row.isHighlighted ? (
                <span className="text-[0.66rem]" style={{ color: "var(--color-peach)" }}>
                  Emphasised
                </span>
              ) : null}
              <button
                type="button"
                className="admin-btn admin-btn-sm"
                disabled={busy || index === 0}
                aria-label={`Move ${row.labelEn} up`}
                onClick={() => void runRow(moveNavItem, { id: String(row.id), direction: "up" })}
              >
                <Icon name="chevronDown" size={11} className="rotate-180" />
              </button>
              <button
                type="button"
                className="admin-btn admin-btn-sm"
                disabled={busy || index === inMenu.length - 1}
                aria-label={`Move ${row.labelEn} down`}
                onClick={() => void runRow(moveNavItem, { id: String(row.id), direction: "down" })}
              >
                <Icon name="chevronDown" size={11} />
              </button>
              <button
                type="button"
                className="admin-btn admin-btn-sm"
                onClick={() => setEditing(editing === row.id ? null : row.id)}
                aria-expanded={editing === row.id}
              >
                Edit
              </button>
              <button
                type="button"
                className="admin-btn admin-btn-sm"
                disabled={busy}
                aria-label={`Delete ${row.labelEn}`}
                onClick={() => {
                  if (!window.confirm(`Remove “${row.labelEn}” from the site?`)) return;
                  void runRow(deleteNavItem, { id: String(row.id) });
                }}
              >
                <Icon name="trash" size={11} />
              </button>
            </div>

            {editing === row.id ? (
              <div className="rounded-lg border border-[var(--admin-line)] p-2.5">
                <NavForm
                  key={`nav-${row.id}-${row.labelEn}-${row.href}`}
                  csrf={csrf}
                  menu={menu}
                  row={row}
                  parents={parents.filter((parent) => parent.id !== row.id)}
                  onSaved={async () => {
                    setEditing(null);
                    setNotice({ ok: true, message: "Saved live." });
                    await onChanged();
                  }}
                />
              </div>
            ) : null}
          </li>
        ))}
        {inMenu.length === 0 ? (
          <li className="text-[0.72rem] text-muted">Nothing in this menu yet.</li>
        ) : null}
      </ul>

      {editing === "new" ? (
        <div className="rounded-lg border border-[var(--admin-line)] p-2.5">
          <NavForm
            key={`nav-new-${menu}`}
            csrf={csrf}
            menu={menu}
            row={null}
            parents={parents}
            onSaved={async () => {
              setEditing(null);
              setNotice({ ok: true, message: "Added, live now." });
              await onChanged();
            }}
          />
        </div>
      ) : (
        <button type="button" className="admin-btn admin-btn-sm" onClick={() => setEditing("new")}>
          Add a link
        </button>
      )}
    </Group>
  );
}

function NavForm({
  csrf,
  menu,
  row,
  parents,
  onSaved,
}: {
  csrf: string;
  menu: string;
  row: GlobalNavRow | null;
  parents: GlobalNavRow[];
  onSaved: () => Promise<void> | void;
}) {
  return (
    <GlobalForm
      title={row ? "Edit link" : "New link"}
      csrf={csrf}
      action={saveNavItem}
      onSaved={onSaved}
      submitLabel={row ? "Save link" : "Add link"}
    >
      {(errors) => (
        <>
          <input type="hidden" name="menu" value={menu} />
          {row ? <input type="hidden" name="id" value={row.id} /> : null}
          <div className="grid gap-2 sm:grid-cols-2">
            <Row label="Label (English)" error={errors.labelEn}>
              <input name="labelEn" defaultValue={row?.labelEn ?? ""} required className="admin-input" />
            </Row>
            <Row label="Label (العربية)">
              <input name="labelAr" defaultValue={row?.labelAr ?? ""} dir="rtl" className="admin-input" />
            </Row>
          </div>
          <Row
            label="Link"
            hint="A site path such as /services, or a full https:// address."
            error={errors.href}
          >
            <input name="href" defaultValue={row?.href ?? ""} required dir="ltr" className="admin-input" />
          </Row>
          {menu === "header" ? (
            <Row label="Sits under" hint="Leave as Top level for a main link." error={errors.parentId}>
              <select
                name="parentId"
                defaultValue={row?.parentId ? String(row.parentId) : ""}
                className="admin-select"
              >
                <option value="">Top level</option>
                {parents.map((parent) => (
                  <option key={parent.id} value={parent.id}>
                    {parent.labelEn}
                  </option>
                ))}
              </select>
            </Row>
          ) : null}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <Switch name="isPublished" label="Visible on the site" defaultChecked={row?.isPublished ?? true} />
            {menu === "header" ? (
              <Switch
                name="isHighlighted"
                label="Emphasised"
                defaultChecked={row?.isHighlighted ?? false}
              />
            ) : null}
          </div>
        </>
      )}
    </GlobalForm>
  );
}

/* -------------------------------------------------------------------------- */
/* Social                                                                     */
/* -------------------------------------------------------------------------- */

function SocialArea({
  rows,
  csrf,
  onChanged,
}: {
  rows: NonNullable<GlobalsState["settings"]>["social"];
  csrf: string;
  onChanged: () => Promise<void> | void;
}) {
  const [editing, setEditing] = useState<number | "new" | null>(null);
  const [busy, setBusy] = useState(false);
  /** As in the navigation group: the row actions have nowhere else to report. */
  const [notice, setNotice] = useState<{ ok: boolean; message: string } | null>(null);

  const runRow = useCallback(
    async (action: Runner, fields: Record<string, string>) => {
      setBusy(true);
      setNotice(null);
      const form = new FormData();
      form.set("_csrf", csrf);
      for (const [name, value] of Object.entries(fields)) form.set(name, value);
      let result: ActionState | null = null;
      try {
        result = await action(IDLE, form);
      } catch {
        result = null;
      }
      setBusy(false);
      if (!result || !result.ok) {
        setNotice({ ok: false, message: result?.message ?? "That could not be sent. Try again." });
        return;
      }
      setNotice({ ok: true, message: result.message ?? "Saved live." });
      await onChanged();
    },
    [csrf, onChanged],
  );

  return (
    <Group title="Social links">
      {notice ? (
        <p
          className="text-[0.72rem]"
          style={{ color: notice.ok ? "#5ad19a" : "#ef8f8a" }}
          role={notice.ok ? "status" : "alert"}
        >
          {notice.message}
        </p>
      ) : null}
      <ul className="flex flex-col gap-1">
        {rows.map((row, index) => (
          <li key={row.id} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5 rounded-lg border border-[var(--admin-line)] px-2 py-1.5">
              <span className="min-w-0 flex-1 truncate text-[0.74rem] text-body">
                {socialLabel(row.platform)}
                <span className="ms-1.5 text-[0.68rem] text-muted" dir="ltr">
                  {row.url}
                </span>
              </span>
              {!row.isPublished ? <span className="text-[0.66rem] text-muted">Hidden</span> : null}
              <button
                type="button"
                className="admin-btn admin-btn-sm"
                disabled={busy || index === 0}
                aria-label={`Move ${socialLabel(row.platform)} up`}
                onClick={() => void runRow(moveSocialLink, { id: String(row.id), direction: "up" })}
              >
                <Icon name="chevronDown" size={11} className="rotate-180" />
              </button>
              <button
                type="button"
                className="admin-btn admin-btn-sm"
                disabled={busy || index === rows.length - 1}
                aria-label={`Move ${socialLabel(row.platform)} down`}
                onClick={() => void runRow(moveSocialLink, { id: String(row.id), direction: "down" })}
              >
                <Icon name="chevronDown" size={11} />
              </button>
              <button
                type="button"
                className="admin-btn admin-btn-sm"
                disabled={busy}
                onClick={() => void runRow(toggleSocialLink, { id: String(row.id) })}
              >
                {row.isPublished ? "Hide" : "Show"}
              </button>
              <button
                type="button"
                className="admin-btn admin-btn-sm"
                onClick={() => setEditing(editing === row.id ? null : row.id)}
                aria-expanded={editing === row.id}
              >
                Edit
              </button>
              <button
                type="button"
                className="admin-btn admin-btn-sm"
                disabled={busy}
                aria-label={`Delete ${socialLabel(row.platform)}`}
                onClick={() => {
                  if (!window.confirm(`Remove the ${socialLabel(row.platform)} link?`)) return;
                  void runRow(deleteSocialLink, { id: String(row.id) });
                }}
              >
                <Icon name="trash" size={11} />
              </button>
            </div>
            {editing === row.id ? (
              <div className="rounded-lg border border-[var(--admin-line)] p-2.5">
                <SocialForm
                  key={`social-${row.id}-${row.url}`}
                  csrf={csrf}
                  row={row}
                  onSaved={async () => {
                    setEditing(null);
                    setNotice({ ok: true, message: "Saved live." });
                    await onChanged();
                  }}
                />
              </div>
            ) : null}
          </li>
        ))}
        {rows.length === 0 ? (
          <li className="text-[0.72rem] text-muted">No social links yet.</li>
        ) : null}
      </ul>

      {editing === "new" ? (
        <div className="rounded-lg border border-[var(--admin-line)] p-2.5">
          <SocialForm
            key="social-new"
            csrf={csrf}
            row={null}
            onSaved={async () => {
              setEditing(null);
              setNotice({ ok: true, message: "Added, live now." });
              await onChanged();
            }}
          />
        </div>
      ) : (
        <button type="button" className="admin-btn admin-btn-sm" onClick={() => setEditing("new")}>
          Add a social link
        </button>
      )}
    </Group>
  );
}

function SocialForm({
  csrf,
  row,
  onSaved,
}: {
  csrf: string;
  row: { id: number; platform: string; url: string; isPublished: boolean } | null;
  onSaved: () => Promise<void> | void;
}) {
  /**
   * A row stored under a key the registry has never known keeps its own key
   * until somebody deliberately changes it — so it is offered as itself rather
   * than silently becoming the first entry in the menu.
   */
  const known = SOCIAL_PLATFORMS.some((platform) => platform.key === row?.platform);
  return (
    <GlobalForm
      title={row ? "Edit social link" : "New social link"}
      csrf={csrf}
      action={saveSocialLink}
      onSaved={onSaved}
      submitLabel={row ? "Save link" : "Add link"}
    >
      {(errors) => (
        <>
          {row ? <input type="hidden" name="id" value={row.id} /> : null}
          <Row label="Network" error={errors.platform}>
            <select name="platform" defaultValue={row?.platform ?? ""} className="admin-select">
              <option value="">Choose…</option>
              {!known && row ? <option value={row.platform}>{row.platform}</option> : null}
              {SOCIAL_PLATFORMS.map((platform) => (
                <option key={platform.key} value={platform.key}>
                  {platform.label}
                </option>
              ))}
            </select>
          </Row>
          <Row label="Address" hint="https:// only." error={errors.url}>
            <input name="url" defaultValue={row?.url ?? ""} dir="ltr" className="admin-input" />
          </Row>
          <Switch name="isPublished" label="Shown in the footer" defaultChecked={row?.isPublished ?? true} />
        </>
      )}
    </GlobalForm>
  );
}

/* -------------------------------------------------------------------------- */
/* The drawer                                                                 */
/* -------------------------------------------------------------------------- */

export function GlobalsPanel({
  open,
  onClose,
  csrf,
  globals,
  loading,
  onRefresh,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  csrf: string;
  globals: GlobalsState | null;
  loading: boolean;
  onRefresh: () => void;
  /** Re-read the globals and reload the canvas. Never touches page drafts. */
  onChanged: () => Promise<void> | void;
}) {
  if (!open) return null;

  const navigation = globals?.navigation ?? null;
  const settings = globals?.settings ?? null;
  const nothing = !loading && !navigation && !settings;

  return (
    <aside
      className="absolute inset-y-0 end-0 z-20 flex w-[25rem] flex-col border-s border-[var(--admin-line)] bg-[var(--admin-shell)] shadow-2xl"
      aria-label="Global site settings"
    >
      <header className="flex shrink-0 items-center gap-2 border-b border-[var(--admin-line)] px-3.5 py-2.5">
        <h2 className="flex-1 truncate text-[0.82rem] font-semibold text-strong">
          Global site settings
        </h2>
        <button type="button" onClick={onRefresh} className="admin-btn admin-btn-sm" disabled={loading}>
          <Icon name="refresh" size={12} />
        </button>
        <button type="button" onClick={onClose} className="admin-btn admin-btn-sm" aria-label="Close">
          <Icon name="close" size={12} />
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-3">
        {/*
          One note, at the top, once. Globals have no draft and no history in
          this release, and an editor who has just learned that a page edit
          waits for Publish will assume the same of these unless told.
        */}
        <p
          className="admin-card p-3 text-[0.74rem] leading-relaxed"
          style={{ color: "var(--color-peach)" }}
        >
          Global changes are saved directly to the live site. They are not part of this page&rsquo;s
          drafts or Version History.
        </p>

        {loading ? (
          <p className="mt-3 text-[0.76rem] text-muted">Reading the site&rsquo;s settings&hellip;</p>
        ) : null}

        {nothing ? (
          <p className="mt-3 text-[0.76rem] leading-relaxed text-muted">
            You can edit this page&rsquo;s content, but not the site-wide navigation or settings.
            Those need the Navigation or Site settings permission.
          </p>
        ) : null}

        <div className="mt-3 flex flex-col gap-3">
          {navigation ? (
            <NavigationArea rows={navigation.rows} csrf={csrf} onChanged={onChanged} />
          ) : null}

          {settings ? (
            <>
              <Group title="Brand">
                <GlobalForm
                  key={`brand-${settings.brand.siteNameEn}`}
                  title="Names and tagline"
                  description="Used in the header, the footer and the copyright line."
                  csrf={csrf}
                  action={saveBrand}
                  onSaved={onChanged}
                >
                  {() => (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Row label="Site name (English)">
                        <input name="siteNameEn" defaultValue={settings.brand.siteNameEn} className="admin-input" />
                      </Row>
                      <Row label="Site name (العربية)">
                        <input name="siteNameAr" defaultValue={settings.brand.siteNameAr} dir="rtl" className="admin-input" />
                      </Row>
                      <Row label="Tagline (English)">
                        <input name="taglineEn" defaultValue={settings.brand.taglineEn} className="admin-input" />
                      </Row>
                      <Row label="Tagline (العربية)">
                        <input name="taglineAr" defaultValue={settings.brand.taglineAr} dir="rtl" className="admin-input" />
                      </Row>
                      <Row label="Legal name (English)">
                        <input name="legalNameEn" defaultValue={settings.brand.legalNameEn} className="admin-input" />
                      </Row>
                      <Row label="Legal name (العربية)">
                        <input name="legalNameAr" defaultValue={settings.brand.legalNameAr} dir="rtl" className="admin-input" />
                      </Row>
                    </div>
                  )}
                </GlobalForm>
              </Group>

              <Group title="Contact">
                <GlobalForm
                  key={`contact-${settings.contact.phone}-${settings.contact.email}`}
                  title="How people reach the business"
                  description="Shown in the footer and on the contact page."
                  csrf={csrf}
                  action={saveContact}
                  onSaved={onChanged}
                >
                  {(errors) => (
                    <div className="grid gap-2 sm:grid-cols-2">
                      <Row label="Phone" hint="Dialled — digits and + only.">
                        <input name="phone" defaultValue={settings.contact.phone} dir="ltr" className="admin-input" />
                      </Row>
                      <Row label="Phone, as displayed">
                        <input name="phoneDisplay" defaultValue={settings.contact.phoneDisplay} dir="ltr" className="admin-input" />
                      </Row>
                      <Row label="Email">
                        <input name="email" defaultValue={settings.contact.email} dir="ltr" className="admin-input" />
                      </Row>
                      <Row label="Address (English)">
                        <input name="addressEn" defaultValue={settings.contact.addressEn} className="admin-input" />
                      </Row>
                      <Row label="Address (العربية)">
                        <input name="addressAr" defaultValue={settings.contact.addressAr} dir="rtl" className="admin-input" />
                      </Row>
                      <Row label="City (English)">
                        <input name="cityEn" defaultValue={settings.contact.cityEn} className="admin-input" />
                      </Row>
                      <Row label="City (العربية)">
                        <input name="cityAr" defaultValue={settings.contact.cityAr} dir="rtl" className="admin-input" />
                      </Row>
                      <Row label="Country (English)">
                        <input name="countryEn" defaultValue={settings.contact.countryEn} className="admin-input" />
                      </Row>
                      <Row label="Country (العربية)">
                        <input name="countryAr" defaultValue={settings.contact.countryAr} dir="rtl" className="admin-input" />
                      </Row>
                      <Row label="Hours (English)">
                        <input name="hoursEn" defaultValue={settings.contact.hoursEn} className="admin-input" />
                      </Row>
                      <Row label="Hours (العربية)">
                        <input name="hoursAr" defaultValue={settings.contact.hoursAr} dir="rtl" className="admin-input" />
                      </Row>
                      <div className="sm:col-span-2">
                        <Row
                          label="Google Maps embed address"
                          hint="The https://www.google.com/maps/embed… address. Nothing else is accepted."
                          error={errors.mapEmbedUrl}
                        >
                          <input
                            name="mapEmbedUrl"
                            defaultValue={settings.contact.mapEmbedUrl}
                            dir="ltr"
                            className="admin-input"
                          />
                        </Row>
                      </div>
                    </div>
                  )}
                </GlobalForm>
              </Group>

              <Group title="WhatsApp">
                <GlobalForm
                  key={`whatsapp-${settings.whatsapp.number}-${String(settings.whatsapp.enabled)}`}
                  title="The floating button and the chat links"
                  csrf={csrf}
                  action={saveWhatsapp}
                  onSaved={onChanged}
                >
                  {(errors) => (
                    <>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
                        <Switch name="enabled" label="WhatsApp is on" defaultChecked={settings.whatsapp.enabled} />
                        <Switch
                          name="floatingEnabled"
                          label="Show the floating button"
                          defaultChecked={settings.whatsapp.floatingEnabled}
                        />
                      </div>
                      <Row
                        label="Number"
                        hint="Digits only, with the country code — for example 9665XXXXXXXX."
                        error={errors.number}
                      >
                        <input name="number" defaultValue={settings.whatsapp.number} dir="ltr" className="admin-input" />
                      </Row>
                      <Row label="Opening message (English)">
                        <textarea
                          name="defaultMessageEn"
                          defaultValue={settings.whatsapp.defaultMessageEn}
                          rows={2}
                          className="admin-input"
                        />
                      </Row>
                      <Row label="Opening message (العربية)">
                        <textarea
                          name="defaultMessageAr"
                          defaultValue={settings.whatsapp.defaultMessageAr}
                          rows={2}
                          dir="rtl"
                          className="admin-input"
                        />
                      </Row>
                    </>
                  )}
                </GlobalForm>
              </Group>

              <Group title="Disclaimers">
                <GlobalForm
                  key={`disclaimers-${settings.disclaimers.governmentEn.slice(0, 24)}`}
                  title="The notices shown with services"
                  csrf={csrf}
                  action={saveDisclaimers}
                  onSaved={onChanged}
                >
                  {() => (
                    <>
                      <Row label="Government notice (English)">
                        <textarea
                          name="governmentEn"
                          defaultValue={settings.disclaimers.governmentEn}
                          rows={3}
                          className="admin-input"
                        />
                      </Row>
                      <Row label="Government notice (العربية)">
                        <textarea
                          name="governmentAr"
                          defaultValue={settings.disclaimers.governmentAr}
                          rows={3}
                          dir="rtl"
                          className="admin-input"
                        />
                      </Row>
                      <Row label="Visa notice (English)">
                        <textarea
                          name="visaEn"
                          defaultValue={settings.disclaimers.visaEn}
                          rows={3}
                          className="admin-input"
                        />
                      </Row>
                      <Row label="Visa notice (العربية)">
                        <textarea
                          name="visaAr"
                          defaultValue={settings.disclaimers.visaAr}
                          rows={3}
                          dir="rtl"
                          className="admin-input"
                        />
                      </Row>
                      <Switch
                        name="showOnServicePages"
                        label="Show them on service pages"
                        defaultChecked={settings.disclaimers.showOnServicePages}
                      />
                    </>
                  )}
                </GlobalForm>
              </Group>

              <Group title="Features">
                <GlobalForm
                  key={`features-${Object.values(settings.features).join("")}`}
                  title="What the site shows"
                  description="Only the switches whose effect is visible on the page beside this panel."
                  csrf={csrf}
                  action={saveFeatures}
                  onSaved={onChanged}
                >
                  {() => (
                    <div className="flex flex-col gap-1.5">
                      <Switch name="customCursor" label="Pointer companion (desktop)" defaultChecked={Boolean(settings.features.customCursor)} />
                      <Switch name="showTestimonials" label="Testimonials" defaultChecked={Boolean(settings.features.showTestimonials)} />
                      <Switch name="showVideos" label="Video showcase" defaultChecked={Boolean(settings.features.showVideos)} />
                      <Switch name="showStats" label="Statistics" defaultChecked={Boolean(settings.features.showStats)} />
                      <Switch name="searchEnabled" label="Search" defaultChecked={Boolean(settings.features.searchEnabled)} />
                      <Switch name="arabicEnabled" label="Arabic edition" defaultChecked={Boolean(settings.features.arabicEnabled)} />
                    </div>
                  )}
                </GlobalForm>
              </Group>

              <SocialArea rows={settings.social} csrf={csrf} onChanged={onChanged} />
            </>
          ) : null}
        </div>
      </div>
    </aside>
  );
}
