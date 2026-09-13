"use client";

import { useEffect, useState } from "react";

import { ICON_NAMES, Icon } from "@/components/ui/icon";

/**
 * Picks an icon by looking at it.
 *
 * The field used to be a text input labelled "Icon key", which asked an editor
 * to remember that the identity-card glyph is called `idCard` and gave them no
 * signal when they typed `id-card` instead — the page simply rendered the
 * unknown-icon fallback. The set is fixed and small, so it can just be shown.
 *
 * `ICON_NAMES` is the same allowlist the validator checks against, so nothing
 * offered here can be rejected on save and nothing rejected on save can be
 * offered here.
 */
export function IconSelect({
  value,
  onChange,
  label = "Icon",
  id,
}: {
  value: string;
  onChange: (name: string) => void;
  label?: string;
  id?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const known = ICON_NAMES.includes(value as (typeof ICON_NAMES)[number]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const filtered = query.trim()
    ? ICON_NAMES.filter((name) => name.toLowerCase().includes(query.trim().toLowerCase()))
    : ICON_NAMES;

  return (
    <div>
      <div className="flex items-center gap-2">
        <span
          className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-sm)] border border-[var(--admin-line)]"
          style={{ color: "var(--color-peach)" }}
        >
          <Icon name={value || "sparkle"} size={17} />
        </span>
        <button
          type="button"
          id={id}
          onClick={() => setOpen(true)}
          className="admin-btn admin-btn-sm"
        >
          {value ? value : "Choose an icon"}
        </button>
        {value ? (
          <button type="button" onClick={() => onChange("")} className="admin-btn admin-btn-sm">
            Clear
          </button>
        ) : null}
        {value && !known ? (
          <span className="text-[0.72rem] text-muted">not in the set — pick a replacement</span>
        ) : null}
      </div>

      {open ? (
        <div className="fixed inset-0 z-70 flex items-center justify-center p-4">
          <button
            type="button"
            aria-label="Close"
            onClick={() => setOpen(false)}
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={`Choose ${label.toLowerCase()}`}
            className="admin-card relative z-10 flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden"
          >
            <div className="flex items-center gap-3 border-b border-[var(--admin-line)] p-3.5">
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search icons"
                className="admin-input"
                autoFocus
              />
              <button type="button" onClick={() => setOpen(false)} className="admin-btn admin-btn-sm">
                <Icon name="close" size={14} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-3.5">
              {filtered.length === 0 ? (
                <p className="py-10 text-center text-[0.83rem] text-muted">
                  No icon matches that.
                </p>
              ) : (
                <ul className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                  {filtered.map((name) => (
                    <li key={name}>
                      <button
                        type="button"
                        onClick={() => {
                          onChange(name);
                          setOpen(false);
                        }}
                        aria-pressed={name === value}
                        className="flex w-full flex-col items-center gap-1.5 rounded-[var(--radius-sm)] border p-2.5 transition-colors hover:border-[var(--color-orange)]"
                        style={{
                          borderColor:
                            name === value ? "var(--color-orange)" : "var(--admin-line)",
                          color: name === value ? "var(--color-peach)" : "var(--text-body-color)",
                        }}
                      >
                        <Icon name={name} size={20} />
                        <span className="w-full truncate text-center text-[0.68rem] text-muted">
                          {name}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
