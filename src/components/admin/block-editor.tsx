"use client";

import { useEffect, useRef, useState } from "react";

import { Icon } from "@/components/ui/icon";
import type { BlockDef, FieldDef, ItemFieldDef } from "@/lib/cms/blocks";
import { ITEM_ID_KEY, newItemId } from "@/lib/cms/item-id";
import type { Locale } from "@/lib/i18n/config";
import type { FieldFocus } from "@/lib/visual-editor/content";
import { IconSelect } from "./icon-select";
import { MediaPicker, type MediaOption } from "./media-picker";

type Values = Record<string, unknown>;
type Localised = { en: string; ar: string };
type Lang = "en" | "ar";

const asLocalised = (value: unknown): Localised => {
  const source = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  return { en: String(source.en ?? ""), ar: String(source.ar ?? "") };
};

const RICH_HINT = "Bold, italic, links, lists, and h3/h4 headings are kept. Everything else becomes plain text.";

const rowId = (row: Record<string, unknown>): string | null =>
  typeof row[ITEM_ID_KEY] === "string" ? (row[ITEM_ID_KEY] as string) : null;

/**
 * One editor for every section type.
 *
 * The fields come from the block registry rather than from hand-written forms,
 * so adding a block type is a registry entry and nothing else — the editor, the
 * validator and the renderer all read the same definition.
 *
 * Two shapes, one implementation:
 *
 *  · **Uncontrolled** — the ordinary admin form. State is held here and
 *    serialised into one hidden input, which is what the server re-validates
 *    field by field on submit.
 *  · **Controlled** (`value` + `onChange`) — the Visual Editor's inspector,
 *    which owns a per-section edit buffer, knows whether it is dirty and saves
 *    it through a Server Action. It renders no hidden input because it is not
 *    inside a form.
 *
 * Forking a second editor for the Visual Editor would have been the quick
 * version and the wrong one: two registry-driven forms drift, and the one that
 * drifts is always the one fewer people use.
 *
 * `locale` narrows the editor to the language being looked at, for the Visual
 * Editor, where the canvas is showing one edition and offering both would
 * invite an editor to type Arabic into the English box. Omitted — the admin
 * form — both are shown side by side, exactly as before.
 */
export function BlockEditor({
  block,
  initial,
  value,
  onChange,
  media,
  name = "values",
  locale,
  focus = null,
}: {
  block: BlockDef;
  /** Uncontrolled mode: the starting values. */
  initial?: Values;
  /** Controlled mode: the current values. Requires `onChange`. */
  value?: Values;
  onChange?: (next: Values) => void;
  media: MediaOption[];
  name?: string;
  /** Edit one language only. Omit for the two-column admin form. */
  locale?: Locale;
  /** The node selected on the canvas, so its field can be pointed at. */
  focus?: FieldFocus;
}) {
  const [internal, setInternal] = useState<Values>(initial ?? {});
  const controlled = Boolean(onChange);
  const values = controlled ? (value ?? {}) : internal;

  const set = (key: string, next: unknown) => {
    const merged = { ...values, [key]: next };
    if (onChange) onChange(merged);
    else setInternal(merged);
  };

  return (
    <>
      {controlled ? null : <input type="hidden" name={name} value={JSON.stringify(values)} />}
      <div className="space-y-5">
        {block.fields.map((field) => (
          <FieldRow
            key={field.name}
            field={field}
            value={values[field.name]}
            media={media}
            locale={locale}
            focus={focus?.field === field.name ? focus : null}
            onChange={(next) => set(field.name, next)}
          />
        ))}
      </div>
    </>
  );
}

/**
 * Brings the field the editor just selected on the canvas into view, once.
 *
 * Only on the transition into focus: re-scrolling on every keystroke would
 * fight the person typing, and scrolling a field that is already on screen for
 * no reason is its own kind of rude.
 */
function useScrollIntoViewWhenFocused(focused: boolean) {
  const ref = useRef<HTMLDivElement>(null);
  const was = useRef(false);
  useEffect(() => {
    if (focused && !was.current) {
      ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
    was.current = focused;
  }, [focused]);
  return ref;
}

/** The highlight a focused field wears. Never the only signal — see the label. */
const focusRing = (on: boolean) =>
  on
    ? {
        borderColor: "var(--color-orange)",
        background: "color-mix(in oklab, var(--color-orange) 6%, transparent)",
      }
    : { borderColor: "transparent" };

function FieldRow({
  field,
  value,
  media,
  locale,
  focus,
  onChange,
}: {
  field: FieldDef;
  value: unknown;
  media: MediaOption[];
  locale?: Locale;
  focus: FieldFocus;
  onChange: (next: unknown) => void;
}) {
  const id = `field-${field.name}`;
  const focused = Boolean(focus);
  const ref = useScrollIntoViewWhenFocused(focused);

  const shell = (children: React.ReactNode) => (
    <div
      ref={ref}
      data-field={field.name}
      data-focused={focused ? "true" : undefined}
      className="rounded-[var(--radius-sm)] border p-0.5 transition-colors"
      style={focusRing(focused)}
    >
      {children}
    </div>
  );

  if (field.type === "items") {
    return shell(
      <ItemsField
        field={field}
        value={value}
        media={media}
        locale={locale}
        focusItemId={focus?.itemId ?? null}
        onChange={onChange}
      />,
    );
  }

  if (field.type === "media") {
    return shell(
      <div>
        <span className="admin-label">{field.label}</span>
        <MediaPicker
          value={typeof value === "number" ? value : null}
          onChange={(next) => onChange(next)}
          options={media}
          label={field.label}
        />
        {field.help ? <p className="mt-1.5 text-[0.73rem] text-muted">{field.help}</p> : null}
      </div>,
    );
  }

  if (field.type === "boolean") {
    return shell(
      <label className="flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(event.target.checked)}
          className="mt-0.5 size-4 accent-[var(--color-orange)]"
        />
        <span>
          <span className="block text-[0.85rem] text-strong">{field.label}</span>
          {field.help ? <span className="block text-[0.73rem] text-muted">{field.help}</span> : null}
        </span>
      </label>,
    );
  }

  if (field.type === "select") {
    return shell(
      <div>
        <label className="admin-label" htmlFor={id}>
          {field.label}
        </label>
        <select
          id={id}
          value={String(value ?? field.options?.[0]?.value ?? "")}
          onChange={(event) => onChange(event.target.value)}
          className="admin-select"
        >
          {(field.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {field.help ? <p className="mt-1.5 text-[0.73rem] text-muted">{field.help}</p> : null}
      </div>,
    );
  }

  if (field.type === "number") {
    return shell(
      <div className="max-w-40">
        <label className="admin-label" htmlFor={id}>
          {field.label}
        </label>
        <input
          id={id}
          type="number"
          min={0}
          value={Number(value ?? 0)}
          onChange={(event) => onChange(Number(event.target.value))}
          className="admin-input"
        />
        {field.help ? <p className="mt-1.5 text-[0.73rem] text-muted">{field.help}</p> : null}
      </div>,
    );
  }

  if (field.type === "link") {
    return shell(
      <div>
        <label className="admin-label" htmlFor={id}>
          {field.label}
        </label>
        <input
          id={id}
          value={String(value ?? "")}
          onChange={(event) => onChange(event.target.value)}
          placeholder={field.placeholder}
          className="admin-input"
          dir="ltr"
        />
        {field.help ? <p className="mt-1.5 text-[0.73rem] text-muted">{field.help}</p> : null}
      </div>,
    );
  }

  // text / textarea / richtext — localised or not.
  if (!field.localised) {
    return shell(
      <div>
        <label className="admin-label" htmlFor={id}>
          {field.label}
        </label>
        {field.type === "text" ? (
          <input
            id={id}
            value={String(value ?? "")}
            onChange={(event) => onChange(event.target.value)}
            placeholder={field.placeholder}
            className="admin-input"
          />
        ) : (
          <textarea
            id={id}
            rows={field.rows ?? 3}
            value={String(value ?? "")}
            onChange={(event) => onChange(event.target.value)}
            className="admin-textarea"
          />
        )}
        {field.help ? <p className="mt-1.5 text-[0.73rem] text-muted">{field.help}</p> : null}
      </div>,
    );
  }

  const pair = asLocalised(value);
  const hint = field.type === "richtext" ? RICH_HINT : field.help;
  const langs: Lang[] = locale ? [locale] : ["en", "ar"];

  return shell(
    <div>
      <span className="admin-label">{field.label}</span>
      <div className={langs.length > 1 ? "grid gap-2.5 lg:grid-cols-2" : undefined}>
        {langs.map((lang) => (
          <div key={lang}>
            {langs.length > 1 ? (
              <label
                className="mb-1 block text-[0.68rem] font-semibold uppercase tracking-[0.08em] text-muted"
                htmlFor={`${id}-${lang}`}
              >
                {lang === "en" ? "English" : "العربية"}
              </label>
            ) : null}
            {field.type === "text" ? (
              <input
                id={`${id}-${lang}`}
                value={pair[lang]}
                onChange={(event) => onChange({ ...pair, [lang]: event.target.value })}
                placeholder={field.placeholder}
                dir={lang === "ar" ? "rtl" : "ltr"}
                className="admin-input"
              />
            ) : (
              <textarea
                id={`${id}-${lang}`}
                rows={field.rows ?? (field.type === "richtext" ? 8 : 3)}
                value={pair[lang]}
                onChange={(event) => onChange({ ...pair, [lang]: event.target.value })}
                dir={lang === "ar" ? "rtl" : "ltr"}
                className="admin-textarea"
              />
            )}
          </div>
        ))}
      </div>
      <FieldNote hint={hint} locale={locale} pair={pair} />
    </div>,
  );
}

/**
 * What a localised field has to say for itself.
 *
 * The Arabic case is the one that matters. An empty Arabic value is not a gap
 * in the page — the site falls back to the English text — so the note says so
 * and quotes what a visitor will actually read. What it deliberately does not
 * do is put that English text into the Arabic box: a copy looks like a
 * translation, and a page full of English pretending to be Arabic is worse than
 * a page that is honestly falling back.
 */
function FieldNote({
  hint,
  locale,
  pair,
}: {
  hint?: string;
  locale?: Locale;
  pair: Localised;
}) {
  if (!locale) {
    return (
      <p className="mt-1.5 text-[0.73rem] text-muted">
        {hint ? `${hint} ` : ""}Leave Arabic empty to fall back to the English text.
      </p>
    );
  }

  const fallingBack = locale === "ar" && !pair.ar.trim() && Boolean(pair.en.trim());
  return (
    <>
      {hint ? <p className="mt-1.5 text-[0.73rem] text-muted">{hint}</p> : null}
      {fallingBack ? (
        <p className="mt-1.5 text-[0.73rem]" style={{ color: "var(--color-peach)" }}>
          Empty in Arabic — the site shows the English text: “{pair.en.slice(0, 80)}
          {pair.en.length > 80 ? "…" : ""}”
        </p>
      ) : null}
      {locale === "en" ? (
        <p className="mt-1.5 text-[0.73rem] text-muted">
          Switch the canvas to العربية to edit the Arabic wording.
        </p>
      ) : null}
    </>
  );
}

function ItemsField({
  field,
  value,
  media,
  locale,
  focusItemId,
  onChange,
}: {
  field: FieldDef;
  value: unknown;
  media: MediaOption[];
  locale?: Locale;
  focusItemId: string | null;
  onChange: (next: unknown) => void;
}) {
  const fields: ItemFieldDef[] = field.itemFields ?? [];
  const rows = Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
  const atLimit = rows.length >= (field.maxItems ?? 24);
  const langs: Lang[] = locale ? [locale] : ["en", "ar"];

  const update = (index: number, key: string, next: unknown) => {
    const copy = rows.map((row, i) => (i === index ? { ...row, [key]: next } : row));
    onChange(copy);
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= rows.length) return;
    const copy = [...rows];
    [copy[index], copy[target]] = [copy[target]!, copy[index]!];
    onChange(copy);
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-3">
        <span className="admin-label mb-0">{field.label}</span>
        <span className="text-[0.72rem] text-muted">
          {rows.length}
          {field.maxItems ? ` / ${field.maxItems}` : ""}
        </span>
      </div>
      {field.help ? <p className="mb-2 text-[0.73rem] text-muted">{field.help}</p> : null}

      <ul className="space-y-2.5">
        {rows.map((row, index) => {
          const id = rowId(row);
          const focused = Boolean(id && id === focusItemId);
          return (
            <li
              key={id ?? `row-${index}`}
              data-item-id={id ?? undefined}
              className="rounded-[var(--radius-sm)] border p-3 transition-colors"
              style={
                focused
                  ? {
                      borderColor: "var(--color-orange)",
                      background: "color-mix(in oklab, var(--color-orange) 8%, transparent)",
                    }
                  : { borderColor: "var(--admin-line)" }
              }
            >
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="text-[0.72rem] font-semibold text-muted">
                  #{index + 1}
                  {focused ? " · selected" : ""}
                </span>
                <div className="flex gap-1">
                  <button
                    type="button"
                    onClick={() => move(index, -1)}
                    disabled={index === 0}
                    aria-label="Move up"
                    className="admin-btn admin-btn-sm"
                  >
                    <Icon name="chevronDown" size={12} className="rotate-180" />
                  </button>
                  <button
                    type="button"
                    onClick={() => move(index, 1)}
                    disabled={index === rows.length - 1}
                    aria-label="Move down"
                    className="admin-btn admin-btn-sm"
                  >
                    <Icon name="chevronDown" size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => onChange(rows.filter((_, i) => i !== index))}
                    aria-label="Remove"
                    className="admin-btn admin-btn-sm admin-btn-danger"
                  >
                    <Icon name="close" size={12} />
                  </button>
                </div>
              </div>

              <div className="space-y-2.5">
                {fields.map((sub) => {
                  const raw = row[sub.name];
                  const subId = `${field.name}-${index}-${sub.name}`;

                  if (sub.type === "media") {
                    return (
                      <div key={sub.name}>
                        <span className="mb-1 block text-[0.68rem] font-semibold text-muted">
                          {sub.label}
                        </span>
                        <MediaPicker
                          value={typeof raw === "number" ? raw : null}
                          onChange={(next) => update(index, sub.name, next)}
                          options={media}
                          label={sub.label}
                        />
                        {sub.help ? (
                          <p className="mt-1.5 text-[0.72rem] text-muted">{sub.help}</p>
                        ) : null}
                      </div>
                    );
                  }

                  if (sub.type === "icon") {
                    return (
                      <div key={sub.name}>
                        <span className="mb-1 block text-[0.68rem] font-semibold text-muted">
                          {sub.label}
                        </span>
                        <IconSelect
                          id={subId}
                          value={typeof raw === "string" ? raw : ""}
                          onChange={(next) => update(index, sub.name, next)}
                          label={sub.label}
                        />
                        {sub.help ? (
                          <p className="mt-1.5 text-[0.72rem] text-muted">{sub.help}</p>
                        ) : null}
                      </div>
                    );
                  }

                  if (!sub.localised) {
                    return (
                      <div key={sub.name}>
                        <label
                          className="mb-1 block text-[0.68rem] font-semibold text-muted"
                          htmlFor={subId}
                        >
                          {sub.label}
                        </label>
                        <input
                          id={subId}
                          value={String(raw ?? "")}
                          onChange={(event) => update(index, sub.name, event.target.value)}
                          className="admin-input"
                          dir={sub.name === "href" ? "ltr" : undefined}
                        />
                      </div>
                    );
                  }

                  const pair = asLocalised(raw);
                  return (
                    <div
                      key={sub.name}
                      className={langs.length > 1 ? "grid gap-2 lg:grid-cols-2" : undefined}
                    >
                      {langs.map((lang) => (
                        <div key={lang}>
                          <label
                            className="mb-1 block text-[0.68rem] font-semibold text-muted"
                            htmlFor={`${field.name}-${index}-${sub.name}-${lang}`}
                          >
                            {sub.label}
                            {langs.length > 1 ? ` · ${lang === "en" ? "EN" : "AR"}` : ""}
                          </label>
                          {sub.type === "textarea" ? (
                            <textarea
                              id={`${field.name}-${index}-${sub.name}-${lang}`}
                              rows={2}
                              value={pair[lang]}
                              onChange={(event) =>
                                update(index, sub.name, { ...pair, [lang]: event.target.value })
                              }
                              dir={lang === "ar" ? "rtl" : "ltr"}
                              className="admin-textarea"
                            />
                          ) : (
                            <input
                              id={`${field.name}-${index}-${sub.name}-${lang}`}
                              value={pair[lang]}
                              onChange={(event) =>
                                update(index, sub.name, { ...pair, [lang]: event.target.value })
                              }
                              dir={lang === "ar" ? "rtl" : "ltr"}
                              className="admin-input"
                            />
                          )}
                        </div>
                      ))}
                      {locale === "ar" && !pair.ar.trim() && pair.en.trim() ? (
                        <p className="text-[0.7rem]" style={{ color: "var(--color-peach)" }}>
                          Empty in Arabic — the site shows “{pair.en.slice(0, 60)}
                          {pair.en.length > 60 ? "…" : ""}”
                        </p>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </li>
          );
        })}
      </ul>

      <button
        type="button"
        onClick={() => onChange([...rows, emptyRow(fields)])}
        disabled={atLimit}
        className="admin-btn admin-btn-sm mt-2.5"
      >
        <Icon name="sparkle" size={12} />
        Add {field.label.toLowerCase().replace(/s$/, "")}
      </button>
      {atLimit ? (
        <p className="mt-1.5 text-[0.73rem] text-muted">
          That is the maximum for this section — more would not lay out well.
        </p>
      ) : null}
    </div>
  );
}

/**
 * A new row, with its identity already on it.
 *
 * The id is minted here rather than waiting for the server so the row has a
 * stable address from the moment it appears: it is the React key, it is what a
 * selection on the canvas will point at, and it is what a style override in a
 * later batch will be filed under. `ensureItemIds` still checks it on the way
 * in — same alphabet, same uniqueness rule — and replaces anything it would not
 * have produced itself, so minting it in the browser buys convenience without
 * buying trust.
 */
function emptyRow(fields: ItemFieldDef[]): Record<string, unknown> {
  const row: Record<string, unknown> = { [ITEM_ID_KEY]: newItemId() };
  for (const field of fields) {
    row[field.name] = field.type === "media" ? null : field.localised ? { en: "", ar: "" } : "";
  }
  return row;
}
