"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Icon } from "@/components/ui/icon";
import { LOCALE_LABELS, LOCALES, type Locale } from "@/lib/i18n/config";
import { previewPagePath } from "@/lib/page-path";
import { blockNameOf, describeAddress } from "@/lib/visual-editor/labels";
import type { EditorNodeMeta, EditorSectionMeta } from "@/lib/visual-editor/protocol";
import { EDITOR_DEVICES, type DeviceKey } from "@/lib/visual-editor/viewport";

import { VisualCanvas, type CanvasState, type SelectRequest } from "./canvas";

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

const EMPTY_CANVAS: CanvasState = { status: "loading", innerWidth: null, message: null };

/**
 * The Visual Editor's application shell.
 *
 * Three columns and a toolbar: Layers, the real website, and the inspector. It
 * does not render the website — it surrounds it. Everything inside the frame is
 * the real public route, rendered by the real `SectionRenderer` from the real
 * database, which is why what an editor sees here is what a visitor gets.
 *
 * Nothing here writes anything. Selection is the whole of this batch: the
 * inspector reads, and the panels that will eventually edit are not pretending
 * to yet.
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
  /**
   * Bumped whenever a genuinely new canvas document is wanted — a different
   * page, a different language, or Reload. A device change is deliberately not
   * one of them: it resizes the document that is already there, so the
   * selection survives it.
   */
  const [canvasKey, setCanvasKey] = useState(0);
  const [canvas, setCanvas] = useState<CanvasState>(EMPTY_CANVAS);
  const [sections, setSections] = useState<EditorSectionMeta[]>([]);
  const [selected, setSelected] = useState<EditorNodeMeta | null>(null);
  const [selectRequest, setSelectRequest] = useState<SelectRequest>(null);

  const page = useMemo(() => pages.find((row) => row.slug === slug) ?? pages[0], [pages, slug]);

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
  const onStructure = useCallback((next: EditorSectionMeta[]) => setSections(next), []);
  const onSelection = useCallback((node: EditorNodeMeta | null) => setSelected(node), []);

  /** A new document: everything about the old one goes with it. */
  const freshCanvas = () => {
    setCanvas(EMPTY_CANVAS);
    setSections([]);
    setSelected(null);
    setSelectRequest(null);
    setCanvasKey((n) => n + 1);
  };

  const ask = (address: string | null) =>
    setSelectRequest((current) => ({
      address,
      scrollIntoView: address !== null,
      token: (current?.token ?? 0) + 1,
    }));

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
  const ready = canvas.status === "ready";

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[var(--admin-bg)]">
      {/* ---------------------------------------------------------------- */}
      {/* Toolbar                                                           */}
      {/* ---------------------------------------------------------------- */}
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--admin-line)] bg-[var(--admin-shell)] px-3 py-2">
        <div className="flex items-center gap-2.5">
          <Link href="/admin/pages" className="admin-btn admin-btn-sm" title="Leave the Visual Editor">
            <Icon name="arrowRight" size={13} className="rotate-180" />
            Admin
          </Link>
          <span className="hidden items-center gap-2 sm:flex">
            <span className="text-[0.82rem] font-semibold tracking-tight text-strong">Visual Editor</span>
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
            onChange={(event) => {
              setSlug(event.target.value);
              freshCanvas();
            }}
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
              onClick={() => {
                if (code === locale) return;
                setLocale(code);
                freshCanvas();
              }}
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
            <span aria-hidden className="inline-block size-1.5 rounded-full" style={{ background: status.tone }} />
            {status.label}
          </p>
          <button type="button" onClick={freshCanvas} className="admin-btn admin-btn-sm">
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
        <LayersPanel
          sections={sections}
          selectedSectionId={selected?.sectionId ?? null}
          ready={ready}
          onSelect={ask}
        />

        <section
          className="relative flex min-w-0 flex-1 flex-col bg-[color-mix(in_oklab,#05070d_72%,var(--admin-bg))] p-4"
          aria-label="Website canvas"
        >
          <div className="min-h-0 flex-1">
            <VisualCanvas
              slug={page.slug}
              locale={locale}
              device={device}
              canvasKey={canvasKey}
              title={page.title}
              selectRequest={selectRequest}
              onState={onCanvasState}
              onStructure={onStructure}
              onSelection={onSelection}
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

        <InspectorPanel node={selected} locale={locale} sections={sections} onClear={() => ask(null)} />
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Layers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The page's sections, as the canvas actually rendered them.
 *
 * The list comes over the bridge rather than from a second database query, and
 * that is the point: the canvas has already been through the structural draft,
 * the draft-only rows and the preview membership, so anything else could only
 * produce a list that disagrees with what is on screen.
 *
 * Section-level only. A tree with every heading and paragraph in it would be
 * accurate and unusable; the canvas is where you point at a sentence.
 */
function LayersPanel({
  sections,
  selectedSectionId,
  ready,
  onSelect,
}: {
  sections: EditorSectionMeta[];
  selectedSectionId: number | null;
  ready: boolean;
  onSelect: (address: string) => void;
}) {
  return (
    <aside
      className="hidden w-60 shrink-0 flex-col border-e border-[var(--admin-line)] bg-[var(--admin-shell)] xl:flex"
      aria-label="Page structure"
    >
      <h2 className="shrink-0 px-3.5 pb-2 pt-3.5 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted">
        Page structure
      </h2>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {!sections.length ? (
          <p className="px-1.5 text-[0.76rem] leading-relaxed text-muted">
            {ready ? "This page has no sections yet." : "Waiting for the canvas…"}
          </p>
        ) : (
          <ol className="flex flex-col gap-0.5">
            {sections.map((section) => {
              const active = section.sectionId === selectedSectionId;
              return (
                <li key={section.sectionId}>
                  <button
                    type="button"
                    onClick={() => onSelect(section.address)}
                    aria-current={active ? "true" : undefined}
                    className="flex w-full flex-col gap-0.5 rounded-[var(--radius-xs)] border px-2.5 py-1.5 text-start transition-colors"
                    style={{
                      borderColor: active ? "var(--color-orange)" : "transparent",
                      background: active ? "color-mix(in oklab, var(--color-orange) 12%, transparent)" : "transparent",
                    }}
                  >
                    <span className="flex items-center gap-1.5">
                      <span className="truncate text-[0.8rem] font-medium text-strong">
                        {blockNameOf(section.blockType)}
                      </span>
                      {/* Badges, not colours: the state has to survive a screenshot
                          in greyscale and a screen reader reading the row. */}
                      {section.isDraftOnly ? <Badge tone="new">New</Badge> : null}
                      {section.isDraft && !section.isDraftOnly ? <Badge tone="draft">Draft</Badge> : null}
                      {!section.visible ? <Badge tone="muted">Hidden</Badge> : null}
                    </span>
                    <span className="truncate text-[0.68rem] text-muted">{section.blockType}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>
    </aside>
  );
}

function Badge({ tone, children }: { tone: "draft" | "new" | "muted"; children: React.ReactNode }) {
  const colour =
    tone === "new" ? "#5ad19a" : tone === "draft" ? "var(--color-peach)" : "var(--color-muted)";
  return (
    <span
      className="shrink-0 rounded-full border px-1.5 text-[0.6rem] font-semibold uppercase tracking-wide"
      style={{ borderColor: `color-mix(in oklab, ${colour} 45%, transparent)`, color: colour }}
    >
      {children}
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* Inspector                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What is selected, described. Read-only, and honestly so: there is not a
 * disabled input anywhere here pretending that editing is one click away.
 * Content controls arrive with the batch that can actually save them.
 */
function InspectorPanel({
  node,
  locale,
  sections,
  onClear,
}: {
  node: EditorNodeMeta | null;
  locale: Locale;
  sections: EditorSectionMeta[];
  onClear: () => void;
}) {
  const section = node ? sections.find((row) => row.sectionId === node.sectionId) : undefined;
  const described = node ? describeAddress(node.blockType, node.relativePath, node.text) : null;

  return (
    <aside
      className="hidden w-72 shrink-0 flex-col border-s border-[var(--admin-line)] bg-[var(--admin-shell)] xl:flex"
      aria-label="Inspector"
    >
      <h2 className="shrink-0 px-3.5 pb-2 pt-3.5 text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted">
        Inspector
      </h2>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-4">
        {!node || !described ? (
          <p className="text-[0.76rem] leading-relaxed text-muted">
            Select something on the canvas or in Page structure.
          </p>
        ) : (
          <div className="flex flex-col gap-3.5">
            <div>
              <p className="text-[0.92rem] font-semibold leading-snug text-strong">{described.label}</p>
              <p className="mt-1 text-[0.7rem] leading-relaxed text-muted">
                {described.crumbs.join(" → ")}
              </p>
            </div>

            {node.text && node.kind !== "section" ? (
              <Row label="Current text">
                <span className="block max-h-24 overflow-y-auto whitespace-pre-wrap break-words text-[0.76rem] text-body">
                  {node.text}
                </span>
              </Row>
            ) : null}

            <Row label="Kind">{node.kind}</Row>
            <Row label="Block">
              {described.blockName} <span className="text-muted">({node.blockType})</span>
            </Row>
            <Row label="Section">#{node.sectionId}</Row>
            {section ? (
              <Row label="State">
                {section.isDraftOnly
                  ? "New — not published yet"
                  : section.isDraft
                    ? "Has unpublished edits"
                    : "Published"}
                {section.visible ? "" : " · hidden"}
              </Row>
            ) : null}
            <Row label="Language">{locale === "ar" ? "Arabic" : "English"}</Row>
            <Row label="Address">
              <code className="block break-all text-[0.68rem] text-muted">{node.address}</code>
            </Row>

            <button type="button" onClick={onClear} className="admin-btn admin-btn-sm self-start">
              Clear selection
            </button>
          </div>
        )}
      </div>
    </aside>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <p className="text-[0.66rem] font-semibold uppercase tracking-[0.07em] text-muted">{label}</p>
      <p className="mt-0.5 text-[0.78rem] text-body">{children}</p>
    </div>
  );
}
