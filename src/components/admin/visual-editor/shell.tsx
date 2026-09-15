"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  loadVisualSection,
  saveVisualSectionDraft,
  saveVisualSectionStyles,
} from "@/app/(backoffice)/admin/visual-editor/actions";
import type { MediaOption } from "@/components/admin/media-picker";
import { Icon } from "@/components/ui/icon";
import type { StyleDocument } from "@/lib/cms/styles";
import { LOCALE_LABELS, LOCALES, type Locale } from "@/lib/i18n/config";
import { previewPagePath } from "@/lib/page-path";
import { blockNameOf } from "@/lib/visual-editor/labels";
import type { VisualSectionData } from "@/lib/visual-editor/content";
import type { EditorNodeMeta, EditorSectionMeta } from "@/lib/visual-editor/protocol";
import { EDITOR_DEVICES, type DeviceKey } from "@/lib/visual-editor/viewport";

import { VisualCanvas, type CanvasState, type SelectRequest } from "./canvas";
import { InspectorPanel, isDirty, type EditDomain, type SectionBuffer } from "./inspector";

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
 * How long to wait for the canvas to answer a restored selection before
 * falling back to the section it was in.
 *
 * The canvas answers an address it cannot resolve by clearing the selection,
 * which is indistinguishable from not having answered yet — so this is a
 * timeout rather than a signal. Long enough that a slow frame is not mistaken
 * for a missing node, short enough that the fallback still feels like part of
 * the save.
 */
const RESTORE_FALLBACK_MS = 400;

/**
 * Whether two documents say the same thing, whatever order they say it in.
 *
 * The server rebuilds a document key by key in its own canonical order; the
 * panel builds one by spreading what it had and appending what changed. Two
 * documents that mean exactly the same thing can therefore serialise
 * differently, and a plain string comparison would call a section unsaved
 * because a token was set and unset again.
 */
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, raw) =>
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? Object.fromEntries(
          Object.keys(raw as Record<string, unknown>)
            .sort()
            .map((key) => [key, (raw as Record<string, unknown>)[key]]),
        )
      : raw,
  );

const sameValues = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/**
 * The Visual Editor's application shell.
 *
 * Three columns and a toolbar: Layers, the real website, and the inspector. It
 * does not render the website — it surrounds it. Everything inside the frame is
 * the real public route, rendered by the real `SectionRenderer` from the real
 * database, which is why what an editor sees here is what a visitor gets.
 *
 * The one thing it writes is content, and only ever as a draft: the inspector
 * edits a per-section buffer and saves it through a Server Action guarded on
 * the section's revision. Structure, style and motion are later batches, and
 * there is no disabled control here standing in for them.
 */
export function VisualEditorShell({
  pages,
  initial,
  canManage,
  csrf,
  media,
}: {
  pages: EditablePage[];
  initial: { slug: string; locale: Locale; device: DeviceKey };
  canManage: boolean;
  /** The session's synchroniser token — every save carries it, like any admin form. */
  csrf: string;
  media: MediaOption[];
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

  /**
   * One edit buffer per section, keyed by its database id.
   *
   * Deliberately kept here rather than inside the inspector, and deliberately
   * not thrown away when the selection moves: an editor who types into a hero,
   * clicks a card to check something and comes back should find their sentence
   * where they left it. Section ids are unique across the site, so the buffers
   * survive a page change too — and the toolbar says how many are unsaved, so a
   * draft left on a page nobody is looking at is not a silent one.
   */
  const [buffers, setBuffers] = useState<Record<number, SectionBuffer>>({});
  /** Which domain the inspector is showing. One choice for the whole editor. */
  const [tab, setTab] = useState<EditDomain>("content");
  const [loadingId, setLoadingId] = useState<number | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Sections already asked for, so a re-render does not ask again. */
  const requested = useRef<Set<number>>(new Set());
  /** Where the selection should go once the canvas comes back from a save. */
  const restoreTo = useRef<{ address: string; fallback: string } | null>(null);
  const [restoreToken, setRestoreToken] = useState(0);
  /** `selected` readable from a timer without making it a dependency. */
  const selectedRef = useRef<EditorNodeMeta | null>(null);

  const page = useMemo(() => pages.find((row) => row.slug === slug) ?? pages[0], [pages, slug]);
  const activeId = selected?.sectionId ?? null;
  const buffer = activeId === null ? null : buffers[activeId] ?? null;
  const dirtyIds = useMemo(() => {
    const ids = new Set<number>();
    for (const [id, entry] of Object.entries(buffers)) if (isDirty(entry)) ids.add(Number(id));
    return ids;
  }, [buffers]);
  const dirtyCount = dirtyIds.size;

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
  const onSelection = useCallback((node: EditorNodeMeta | null) => {
    selectedRef.current = node;
    setSelected(node);
  }, []);

  /**
   * A new document: everything about the old one goes with it.
   *
   * Everything about the *document*, that is. The edit buffers are not part of
   * it — they are what the person typed, and reloading the frame they are being
   * previewed in is no reason to throw them away.
   */
  const freshCanvas = () => {
    setCanvas(EMPTY_CANVAS);
    setSections([]);
    selectedRef.current = null;
    setSelected(null);
    setSelectRequest(null);
    setCanvasKey((n) => n + 1);
  };

  const ask = useCallback(
    (address: string | null) =>
      setSelectRequest((current) => ({
        address,
        scrollIntoView: address !== null,
        token: (current?.token ?? 0) + 1,
      })),
    [],
  );

  /* ------------------------------------------------------------------ */
  /* Content: load, edit, save                                           */
  /* ------------------------------------------------------------------ */

  /**
   * The section's values come from the server, not from the canvas.
   *
   * The frame is showing a rendering — decorated, localised, with empty fields
   * omitted — and reading an editable document back out of it would mean
   * storing whatever the renderer happened to produce. So the panel asks for
   * the row. The page id travels with the request and is checked against the
   * row, so this canvas can only ever edit its own page's sections.
   */
  useEffect(() => {
    if (activeId === null || !page) return;
    if (requested.current.has(activeId)) return;
    requested.current.add(activeId);

    const wanted = activeId;
    let cancelled = false;
    setLoadingId(wanted);
    setLoadError(null);

    loadVisualSection(wanted, page.id)
      .then((result) => {
        if (cancelled) return;
        setLoadingId((current) => (current === wanted ? null : current));
        if (!result.ok) {
          // Let a later selection try again rather than remembering a failure.
          requested.current.delete(wanted);
          setLoadError(result.message);
          return;
        }
        setBuffers((prev) =>
          prev[wanted]
            ? prev
            : {
                ...prev,
                [wanted]: {
                  data: result.section,
                  values: result.section.values,
                  styles: result.section.styles,
                  contentDirty: false,
                  styleDirty: false,
                  saving: null,
                  status: "idle",
                  statusDomain: null,
                },
              },
        );
      })
      .catch(() => {
        if (cancelled) return;
        requested.current.delete(wanted);
        setLoadingId((current) => (current === wanted ? null : current));
        setLoadError("The section could not be read. Reload the canvas and try again.");
      });

    return () => {
      cancelled = true;
    };
  }, [activeId, page]);

  const onValues = useCallback(
    (values: Record<string, unknown>) => {
      if (activeId === null || !canManage) return;
      setBuffers((prev) => {
        const entry = prev[activeId];
        if (!entry) return prev;
        return {
          ...prev,
          [activeId]: {
            ...entry,
            values,
            contentDirty: !sameValues(values, entry.data.values),
            // Typing clears a stale outcome, but never a conflict: the section
            // really has moved, and hiding that the moment somebody keeps
            // typing is how the second save loses too.
            status: entry.status === "conflict" ? "conflict" : "idle",
            statusDomain: entry.status === "conflict" ? entry.statusDomain : null,
            message: entry.status === "conflict" ? entry.message : undefined,
          },
        };
      });
    },
    [activeId, canManage],
  );

  const onStyles = useCallback(
    (styles: StyleDocument) => {
      if (activeId === null || !canManage) return;
      setBuffers((prev) => {
        const entry = prev[activeId];
        if (!entry) return prev;
        return {
          ...prev,
          [activeId]: {
            ...entry,
            styles,
            styleDirty: !sameValues(styles, entry.data.styles),
            status: entry.status === "conflict" ? "conflict" : "idle",
            statusDomain: entry.status === "conflict" ? entry.statusDomain : null,
            message: entry.status === "conflict" ? entry.message : undefined,
          },
        };
      });
    },
    [activeId, canManage],
  );

  /** Puts one domain back to what the server last said, leaving the other alone. */
  const revert = useCallback(
    (domain: EditDomain) => {
      if (activeId === null) return;
      setBuffers((prev) => {
        const entry = prev[activeId];
        if (!entry) return prev;
        const reset =
          domain === "content"
            ? { values: entry.data.values, contentDirty: false }
            : { styles: entry.data.styles, styleDirty: false };
        return {
          ...prev,
          [activeId]: { ...entry, ...reset, status: "idle", statusDomain: null, message: undefined },
        };
      });
    },
    [activeId],
  );

  /**
   * Take the version that won the race — both domains of it.
   *
   * They share a revision, so adopting one and keeping the other would leave
   * the kept half addressed to a revision that no longer exists: the next save
   * of it would conflict too, and the editor would have no way out of the loop.
   */
  const takeLatest = useCallback(() => {
    if (activeId === null) return;
    setBuffers((prev) => {
      const entry = prev[activeId];
      if (!entry?.latest) return prev;
      return {
        ...prev,
        [activeId]: {
          data: entry.latest,
          values: entry.latest.values,
          styles: entry.latest.styles,
          contentDirty: false,
          styleDirty: false,
          saving: null,
          status: "idle",
          statusDomain: null,
        },
      };
    });
    freshCanvas();
  }, [activeId]);

  /**
   * Saves one domain of one section.
   *
   * Two things this deliberately does not do. It does not save the other
   * domain — pressing "Save styles" with unsaved text must not publish that
   * text into a draft nobody asked to save. And it does not start while the
   * other domain is writing: they share one row and one revision, so two
   * requests in flight would be a race this browser manufactured out of two
   * intentions that were each correct when they left.
   *
   * What it does do is adopt the new revision for the *whole* buffer. The
   * counter belongs to the row, not to a column, so an editor who saves a
   * style and then saves text is naming the revision their own last save
   * produced rather than conflicting with themselves.
   */
  const save = useCallback(
    async (domain: EditDomain) => {
      if (activeId === null || !canManage) return;
      const entry = buffers[activeId];
      if (!entry || entry.saving !== null) return;
      const dirty = domain === "content" ? entry.contentDirty : entry.styleDirty;
      if (!dirty) return;

      const sent = canonical(domain === "content" ? entry.values : entry.styles);
      const address = selectedRef.current?.address ?? null;

      setBuffers((prev) => {
        const live = prev[activeId];
        if (!live) return prev;
        return { ...prev, [activeId]: { ...live, saving: domain, message: undefined } };
      });

      const form = new FormData();
      form.set("_csrf", csrf);
      form.set("sectionId", String(activeId));
      form.set("pageId", String(entry.data.pageId));
      form.set("expectedRevision", String(entry.data.revision));
      form.set(domain === "content" ? "values" : "styles", sent);

      const fail = (message: string) =>
        setBuffers((prev) => {
          const live = prev[activeId];
          if (!live) return prev;
          return {
            ...prev,
            [activeId]: { ...live, saving: null, status: "error", statusDomain: domain, message },
          };
        });

      const refuse = (message: string, latest?: VisualSectionData) =>
        setBuffers((prev) => {
          const live = prev[activeId];
          if (!live) return prev;
          return {
            ...prev,
            [activeId]: {
              ...live,
              saving: null,
              status: "conflict",
              statusDomain: domain,
              message,
              latest,
            },
          };
        });

      /**
       * The two actions answer with different documents — a content save owns
       * the values, a style save owns the document — and this is where the two
       * become one fact: the revision the row is now at, plus whichever half
       * was written. Narrowing here rather than later keeps each action's
       * result typed as what it actually is.
       */
      let accepted: { revision: number; section?: VisualSectionData; styles?: StyleDocument };
      try {
        if (domain === "content") {
          const answer = await saveVisualSectionDraft(form);
          if (!answer.ok) {
            if (answer.reason === "conflict") refuse(answer.message, answer.section);
            else fail(answer.message);
            return;
          }
          accepted = { revision: answer.section.revision, section: answer.section };
        } else {
          const answer = await saveVisualSectionStyles(form);
          if (!answer.ok) {
            if (answer.reason === "conflict") refuse(answer.message, answer.section);
            else fail(answer.message);
            return;
          }
          accepted = { revision: answer.revision, styles: answer.styles };
        }
      } catch {
        fail("The save could not be sent. Try again.");
        return;
      }

      setBuffers((prev) => {
        const live = prev[activeId];
        if (!live) return prev;
        /**
         * Somebody who kept editing while the save was in flight keeps their
         * newer work — adopting the server's copy would delete the last thing
         * they did. The revision moves either way, so the next save is guarded
         * against the one that just landed rather than the one before.
         */
        const movedOn = canonical(domain === "content" ? live.values : live.styles) !== sent;

        // The revision belongs to the row, so both domains adopt it. The other
        // domain's stored document and its unsaved edits are left alone.
        const data: VisualSectionData =
          accepted.section
            ? { ...accepted.section, styles: live.data.styles, hasStyleDraft: live.data.hasStyleDraft }
            : {
                ...live.data,
                revision: accepted.revision,
                styles: accepted.styles ?? live.data.styles,
                hasStyleDraft: true,
              };

        const domainState =
          domain === "content"
            ? { values: movedOn ? live.values : data.values, contentDirty: movedOn }
            : { styles: movedOn ? live.styles : data.styles, styleDirty: movedOn };

        return {
          ...prev,
          [activeId]: {
            ...live,
            data,
            ...domainState,
            saving: null,
            status: movedOn ? ("idle" as const) : ("saved" as const),
            statusDomain: domain,
            message: undefined,
          },
        };
      });

      // The canvas is a rendering of the drafts, so it is stale the moment
      // either changes. Reload it, and put the selection back where it was.
      if (address) restoreTo.current = { address, fallback: `section:${activeId}` };
      freshCanvas();
      setRestoreToken((n) => n + 1);
    },
    [activeId, buffers, canManage, csrf],
  );

  /**
   * Puts the selection back after the canvas has reloaded.
   *
   * By address, which is the whole point of the address model: the element is a
   * different DOM node in a different document, and it is still the same
   * heading. A node that the edit removed — the row that was just deleted —
   * cannot come back, so the fallback is its section, which is the nearest
   * thing that still exists and keeps the inspector on the right block.
   */
  useEffect(() => {
    if (!restoreToken || canvas.status !== "ready") return;
    const wanted = restoreTo.current;
    if (!wanted) return;
    restoreTo.current = null;

    ask(wanted.address);
    const timer = window.setTimeout(() => {
      if (!selectedRef.current && wanted.fallback !== wanted.address) ask(wanted.fallback);
    }, RESTORE_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [restoreToken, canvas.status, ask]);

  /**
   * An unsaved edit is worth one browser prompt.
   *
   * Only the browser's own dialog: a custom message is ignored by every current
   * browser, and the listener is attached only while something is actually
   * dirty so an editor who has saved everything is never asked.
   */
  useEffect(() => {
    if (!dirtyCount) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtyCount]);

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
          {/*
            Buffers survive a page change, so an unsaved edit can be sitting on
            a page nobody is looking at. Counting them here is what keeps that
            from being a silent loss.
          */}
          {dirtyCount ? (
            <span
              className="rounded-full px-2 py-0.5 text-[0.7rem] font-semibold"
              style={{
                background: "color-mix(in oklab, var(--color-orange) 18%, transparent)",
                color: "var(--color-peach)",
              }}
            >
              {dirtyCount} unsaved
            </span>
          ) : null}
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
          dirtyIds={dirtyIds}
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

        <InspectorPanel
          node={selected}
          sections={sections}
          locale={locale}
          media={media}
          canManage={canManage}
          buffer={buffer}
          tab={tab}
          onTab={setTab}
          loading={loadingId !== null && loadingId === activeId}
          loadError={loadError}
          onValues={onValues}
          onStyles={onStyles}
          onSave={save}
          onRevert={revert}
          onTakeLatest={takeLatest}
          onClear={() => ask(null)}
        />
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
  dirtyIds,
  ready,
  onSelect,
}: {
  sections: EditorSectionMeta[];
  selectedSectionId: number | null;
  /** Sections with edits in the panel that have not been saved yet. */
  dirtyIds: Set<number>;
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
                      {dirtyIds.has(section.sectionId) ? <Badge tone="draft">Unsaved</Badge> : null}
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
