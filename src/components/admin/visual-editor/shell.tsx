"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Icon } from "@/components/ui/icon";
import { LOCALE_LABELS, LOCALES, type Locale } from "@/lib/i18n/config";
import { previewPagePath } from "@/lib/page-path";
import { EDITOR_DEVICES, type DeviceKey } from "@/lib/visual-editor/viewport";

import { VisualCanvas, type CanvasState } from "./canvas";

export type EditablePage = {
  id: number;
  slug: string;
  title: string;
  path: string;
  isPublished: boolean;
};

const STATUS: Record<CanvasState["status"], { label: string; tone: string }> = {
  loading: { label: "Loading canvas…", tone: "var(--color-muted)" },
  connecting: { label: "Connecting…", tone: "var(--color-peach)" },
  ready: { label: "Ready", tone: "#5ad19a" },
  error: { label: "Unable to connect", tone: "#ef8f8a" },
};

/**
 * The Visual Editor's application shell.
 *
 * Three columns and a toolbar, which is the shape the finished editor has: the
 * side panels are empty in this batch on purpose, so that the spatial
 * architecture — how much room the canvas really gets once Layers and the
 * Inspector are in place — is settled now rather than discovered later.
 *
 * It does not render the website. It surrounds it. Everything inside the frame
 * is the real public route, rendered by the real `SectionRenderer` from the
 * real database, which is why what an editor sees here is what a visitor gets.
 */
export function VisualEditorShell({
  pages,
  initial,
  canManage,
}: {
  pages: EditablePage[];
  initial: { slug: string; locale: Locale; device: DeviceKey };
  canManage: boolean;
}) {
  const [slug, setSlug] = useState(initial.slug);
  const [locale, setLocale] = useState<Locale>(initial.locale);
  const [device, setDevice] = useState<DeviceKey>(initial.device);
  const [nonce, setNonce] = useState(0);
  const [canvas, setCanvas] = useState<CanvasState>({
    status: "loading",
    innerWidth: null,
    message: null,
  });

  const page = useMemo(
    () => pages.find((row) => row.slug === slug) ?? pages[0],
    [pages, slug],
  );

  /**
   * The address is the editor's state, so a refresh comes back to the same
   * page. Written with `replaceState` rather than the router: this is the same
   * screen with a different selection, not a navigation, and a round trip to
   * the server would tear down the canvas to rebuild the shell around it.
   */
  useEffect(() => {
    if (!page) return;
    const params = new URLSearchParams({ page: page.slug, lang: locale, device });
    window.history.replaceState(null, "", `?${params}`);
  }, [page, locale, device]);

  const onCanvasState = useCallback((next: CanvasState) => setCanvas(next), []);

  // A fresh nonce is a fresh document *and* a fresh bridge id, so an iframe
  // that is on its way out cannot answer for the one replacing it.
  const reload = () => {
    setCanvas({ status: "loading", innerWidth: null, message: null });
    setNonce((n) => n + 1);
  };

  const select = (next: string) => {
    setCanvas({ status: "loading", innerWidth: null, message: null });
    setSlug(next);
  };

  const chooseLocale = (next: Locale) => {
    if (next === locale) return;
    setCanvas({ status: "loading", innerWidth: null, message: null });
    setLocale(next);
  };

  if (!page) {
    return (
      <div className="flex h-dvh items-center justify-center p-8 text-center">
        <div>
          <p className="text-strong">There are no pages to edit yet.</p>
          <Link href="/admin/pages" className="admin-btn admin-btn-sm mt-3">
            Go to Pages &amp; sections
          </Link>
        </div>
      </div>
    );
  }

  const status = STATUS[canvas.status];

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[var(--admin-bg)]">
      {/* ---------------------------------------------------------------- */}
      {/* Toolbar                                                           */}
      {/* ---------------------------------------------------------------- */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--admin-line)] bg-[var(--admin-shell)] px-3 py-2">
        <div className="flex items-center gap-2.5">
          <Link
            href="/admin/pages"
            className="admin-btn admin-btn-sm"
            title="Leave the Visual Editor"
          >
            <Icon name="arrowRight" size={13} className="rotate-180" />
            Admin
          </Link>
          <span className="hidden items-center gap-2 sm:flex">
            <span className="text-[0.82rem] font-semibold tracking-tight text-strong">
              Visual Editor
            </span>
            {!canManage ? (
              <span
                className="rounded-full border border-[var(--admin-line)] px-2 py-0.5 text-[0.66rem] font-semibold uppercase tracking-wide text-muted"
                title="You can look at every page here, but not change anything."
              >
                Read only
              </span>
            ) : null}
          </span>
        </div>

        <div className="flex items-center gap-2">
          <label htmlFor="ve-page" className="sr-only">
            Page to edit
          </label>
          <select
            id="ve-page"
            value={page.slug}
            onChange={(event) => select(event.target.value)}
            className="admin-input h-[1.9rem] max-w-[19rem] py-0 text-[0.8rem]"
          >
            {pages.map((row) => (
              <option key={row.slug} value={row.slug}>
                {row.title} — {row.path}
                {row.isPublished ? "" : " (unpublished)"}
              </option>
            ))}
          </select>
        </div>

        <div className="flex gap-1" role="group" aria-label="Canvas language">
          {LOCALES.map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => chooseLocale(code)}
              aria-pressed={locale === code}
              className="admin-btn admin-btn-sm"
              style={
                locale === code
                  ? { borderColor: "var(--color-orange)", color: "var(--color-strong)" }
                  : undefined
              }
            >
              {LOCALE_LABELS[code].native}
            </button>
          ))}
        </div>

        <div className="flex gap-1" role="group" aria-label="Canvas width">
          {EDITOR_DEVICES.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => {
                if (option.key === device) return;
                // The canvas re-announces on resize, but until it does the old
                // reading belongs to the old device. Drop it rather than show it.
                setCanvas((current) => ({ ...current, innerWidth: null }));
                setDevice(option.key);
              }}
              aria-pressed={device === option.key}
              className="admin-btn admin-btn-sm"
              style={
                device === option.key
                  ? { borderColor: "var(--color-orange)", color: "var(--color-strong)" }
                  : undefined
              }
              title={`${option.label} — ${option.width}px`}
            >
              <Icon name={option.icon} size={12} />
              <span className="hidden md:inline">{option.label}</span>
              <span className="text-muted tabular-nums">{option.width}</span>
            </button>
          ))}
        </div>

        <div className="ms-auto flex items-center gap-2">
          {/* Text as well as colour: the state has to be readable without it. */}
          <p className="flex items-center gap-1.5 text-[0.75rem] text-muted" aria-live="polite">
            <span
              aria-hidden
              className="inline-block size-1.5 rounded-full"
              style={{ background: status.tone }}
            />
            {status.label}
          </p>
          <button type="button" onClick={reload} className="admin-btn admin-btn-sm">
            <Icon name="refresh" size={12} />
            <span className="hidden lg:inline">Reload</span>
          </button>
          <a
            href={previewPagePath(page.slug, locale)}
            target="_blank"
            rel="noopener"
            className="admin-btn admin-btn-sm"
            title="Open this page's ordinary draft preview in a new tab"
          >
            <Icon name="arrowUpRight" size={12} />
            <span className="hidden lg:inline">Preview</span>
          </a>
        </div>
      </header>

      {/* ---------------------------------------------------------------- */}
      {/* Body                                                              */}
      {/* ---------------------------------------------------------------- */}
      <div className="flex min-h-0 flex-1">
        <EditorPanel side="start" title="Page structure">
          Layers arrive in the next editor batch. This panel is here now so the
          canvas is already sized for it.
        </EditorPanel>

        <section
          className="relative flex min-w-0 flex-1 flex-col bg-[color-mix(in_oklab,#05070d_72%,var(--admin-bg))] p-4"
          aria-label="Website canvas"
        >
          <div className="min-h-0 flex-1">
            <VisualCanvas
              slug={page.slug}
              locale={locale}
              device={device}
              nonce={nonce}
              title={page.title}
              onState={onCanvasState}
            />
          </div>

          <p className="mt-2.5 flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 text-[0.72rem] text-muted">
            <span>
              {page.title} · {locale === "ar" ? "Arabic" : "English"} ·{" "}
              {EDITOR_DEVICES.find((d) => d.key === device)?.label}
            </span>
            {canvas.innerWidth ? (
              <span className="tabular-nums">Canvas reports {canvas.innerWidth}px</span>
            ) : null}
            {canvas.message ? (
              <span style={{ color: "#ef8f8a" }} role="status">
                {canvas.message}
              </span>
            ) : null}
          </p>
        </section>

        <EditorPanel side="end" title="Inspector">
          Select an element to inspect it — selection arrives in the next batch.
        </EditorPanel>
      </div>
    </div>
  );
}

/**
 * A panel with nothing in it yet, and deliberately restrained about saying so.
 * Hidden below `xl` so the canvas keeps the room on a small admin screen.
 */
function EditorPanel({
  side,
  title,
  children,
}: {
  side: "start" | "end";
  title: string;
  children: React.ReactNode;
}) {
  return (
    <aside
      className={`hidden w-60 shrink-0 flex-col bg-[var(--admin-shell)] p-3.5 xl:flex ${
        side === "start"
          ? "border-e border-[var(--admin-line)]"
          : "border-s border-[var(--admin-line)]"
      }`}
      aria-label={title}
    >
      <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted">
        {title}
      </h2>
      <p className="mt-2 text-[0.76rem] leading-relaxed text-muted">{children}</p>
    </aside>
  );
}
