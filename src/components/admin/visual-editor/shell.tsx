"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  addPageSection,
  discardPageFromEditor,
  discardPageLayout,
  duplicatePageSection,
  loadEditorGlobals,
  loadPageHistory,
  loadPageSummary,
  publishPageFromEditor,
  loadPageStructure,
  loadVisualSection,
  removePageSection,
  reorderPageStructure,
  restorePageSection,
  restoreVersionFromEditor,
  saveVisualSectionDraft,
  saveVisualSectionMotion,
  saveVisualSectionStyles,
  setPageSectionVisibility,
} from "@/app/(backoffice)/admin/visual-editor/actions";
import type { MediaOption } from "@/components/admin/media-picker";
import { GlobalsPanel } from "@/components/admin/visual-editor/globals-panel";
import { Icon } from "@/components/ui/icon";
import type { BlockDef } from "@/lib/cms/blocks";
import type { MotionPreset } from "@/lib/cms/motion";
import type { StyleDocument } from "@/lib/cms/styles";
import { removedSections, type PageStructure } from "@/lib/cms/structure";
import { LOCALE_LABELS, LOCALES, type Locale } from "@/lib/i18n/config";
import { previewPagePath } from "@/lib/page-path";
import type { VisualSectionData, VisualStructureResult } from "@/lib/visual-editor/content";
import {
  describePending,
  describeRemoval,
  type PageHistoryView,
  type PageSummaryView,
} from "@/lib/visual-editor/publish";
import type { GlobalsState } from "@/lib/visual-editor/globals";
import type { EditorNodeMeta, EditorSectionMeta } from "@/lib/visual-editor/protocol";
import { DEVICE_BREAKPOINT, EDITOR_DEVICES, type DeviceKey } from "@/lib/visual-editor/viewport";

import { VisualCanvas, type CanvasState, type SelectRequest } from "./canvas";
import {
  dirtyOf,
  EDIT_DOMAINS,
  InspectorPanel,
  isDirty,
  type EditDomain,
  type SectionBuffer,
} from "./inspector";
import { LayersPanel, type StructuralOps } from "./layers";
import { PagePanel } from "./page-panel";

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
 * How long after the last local edit a section's drafts are saved.
 *
 * One constant, one number. Long enough that ordinary typing produces one save
 * rather than one per keystroke — a word is roughly 300ms of typing, so a
 * sentence is one request — and short enough that an editor who pauses to read
 * what they wrote sees "Saved" before they look away.
 *
 * It is a debounce rather than an interval: every edit resets it, so a save
 * happens when somebody stops, not on a metronome that can fire mid-word.
 */
export const AUTOSAVE_DELAY_MS = 1100;

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
 * What it writes is drafts, and only ever drafts: the inspector edits a
 * per-section buffer in one of three domains — content, style, motion — and
 * saves it through a Server Action guarded on the section's revision. The
 * layout is the fourth thing it writes and is guarded on the *page's* revision
 * instead, because a layout draft belongs to the page rather than to any one
 * section. Nothing here publishes anything.
 */
export function VisualEditorShell({
  pages,
  initial,
  canManageContent,
  canManageNavigation,
  canManageSettings,
  csrf,
  media,
  blocks,
}: {
  pages: EditablePage[];
  initial: { slug: string; locale: Locale; device: DeviceKey };
  /**
   * `content.manage` — may edit and publish page content, styles, motion and
   * layout. Deliberately one capability per domain rather than one boolean for
   * the editor: navigation and site settings are granted separately, and a
   * single flag would have handed all three to whoever held any one of them.
   */
  canManageContent: boolean;
  /** `navigation.manage` — may edit the header and footer menus. */
  canManageNavigation: boolean;
  /** `settings.manage` — may edit brand, contact, WhatsApp, disclaimers, features, social. */
  canManageSettings: boolean;
  /** The session's synchroniser token — every save carries it, like any admin form. */
  csrf: string;
  media: MediaOption[];
  /** What may be added, per page, from the registry the admin form uses. */
  blocks: Record<string, BlockDef[]>;
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
  /**
   * The buffers as they are *now* — the authoritative copy, not a mirror.
   *
   * Autosave's queue awaits a round trip between decisions, and by the time it
   * resumes, anything it captured in a closure is old. A ref assigned during
   * render is not enough either: React renders when it chooses, so a loop that
   * saves three domains back to back can read the ref between two of its own
   * updates and see a section that is still "saving" — and stop, leaving two
   * domains unsaved with no error and nothing to retry them.
   *
   * So every mutation goes through `writeBuffers`, which updates this ref
   * synchronously and hands the same object to React for rendering. The ref is
   * the state; `buffers` is how it gets drawn.
   */
  const buffersRef = useRef<Record<number, SectionBuffer>>({});
  /** Which page is on screen, for a drain that finished after a navigation. */
  const pageRef = useRef<number | null>(null);
  /** One pending debounce per section. */
  const autosaveTimers = useRef<Map<number, number>>(new Map());
  /** Sections whose queue is running, so a second trigger does not start one. */
  const draining = useRef<Set<number>>(new Set());
  /**
   * The drain, reachable from a timer armed before it was declared.
   *
   * The edit callbacks arm the debounce and are defined above the queue that
   * empties it, which is the ordinary shape of this file — reading state, then
   * editing it, then writing it. A ref keeps that order without making the
   * schedule depend on a function it sits above.
   */
  const drainRef = useRef<(sectionId: number) => void>(() => {});

  /**
   * The page's layout, as the server holds it.
   *
   * Two things the canvas cannot tell the panel: which sections the layout
   * draft is leaving out — they are not rendered, so they are not in
   * `canvas.structure` — and which revision of the layout this is, which every
   * structural write has to name. Kept beside the canvas rather than derived
   * from it, and replaced by whatever the server answers after each change.
   */
  const [structure, setStructure] = useState<PageStructure | null>(null);
  const [structureBusy, setStructureBusy] = useState(false);
  /**
   * The last structural refusal, whole.
   *
   * The reason is kept rather than flattened into a sentence, because the panel
   * has to offer a way out of a *conflict* specifically and inferring that from
   * the wording of a message would break the first time somebody edited the
   * wording.
   */
  const [structureFailure, setStructureFailure] = useState<
    { reason: "conflict" | "invalid" | "denied"; message: string } | null
  >(null);

  /**
   * The page's own state: what the *server* says is waiting, and its history.
   *
   * Deliberately not derived from the buffers. The buffers say what this
   * browser is holding; these say what the page actually has, which is the only
   * thing a publication can act on and the only honest thing to put in front of
   * somebody about to press Publish.
   */
  const [pagePanel, setPagePanel] = useState(false);
  const [globalsPanel, setGlobalsPanel] = useState(false);
  const [globals, setGlobals] = useState<GlobalsState | null>(null);
  const [globalsLoading, setGlobalsLoading] = useState(false);
  const [summary, setSummary] = useState<PageSummaryView | null>(null);
  const [history, setHistory] = useState<PageHistoryView | null>(null);
  const [pageBusy, setPageBusy] = useState(false);
  const [pageMessage, setPageMessage] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  const page = useMemo(() => pages.find((row) => row.slug === slug) ?? pages[0], [pages, slug]);
  /** Which page is being edited, as a value — `page` itself is a new object on every refresh. */
  const pageId = page?.id ?? null;
  pageRef.current = page?.id ?? null;

  /**
   * The one way a buffer changes.
   *
   * Reads the ref, computes the next map, writes both. Synchronous by
   * construction, so the autosave queue's next decision is made against what
   * its own last write produced rather than against whatever React has got
   * round to rendering.
   */
  const writeBuffers = useCallback(
    (update: (prev: Record<number, SectionBuffer>) => Record<number, SectionBuffer>) => {
      const next = update(buffersRef.current);
      buffersRef.current = next;
      setBuffers(next);
    },
    [],
  );

  /**
   * Autosave: a debounce per section, reset by every local edit.
   *
   * Per *section* rather than one for the editor, because two sections have
   * nothing to do with each other and a shared timer would let a flurry of
   * typing in one hold another's save hostage indefinitely.
   */
  const scheduleAutosave = useCallback(
    (sectionId: number) => {
      if (!canManageContent) return;
      const existing = autosaveTimers.current.get(sectionId);
      if (existing) window.clearTimeout(existing);
      autosaveTimers.current.set(
        sectionId,
        window.setTimeout(() => {
          autosaveTimers.current.delete(sectionId);
          drainRef.current(sectionId);
        }, AUTOSAVE_DELAY_MS),
      );
    },
    [canManageContent],
  );
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

  /**
   * The layout, re-read whenever the page changes.
   *
   * Structural state is per page and must switch with it: leaving Home's
   * revision in place while About is on screen would mean the next structural
   * write named a revision belonging to a different page, and the guard would
   * be protecting nothing.
   */
  useEffect(() => {
    if (!page) return;
    let cancelled = false;
    setStructure(null);
    setStructureFailure(null);
    loadPageStructure(page.id).then((next) => {
      if (!cancelled) setStructure(next);
    });
    return () => {
      cancelled = true;
    };
  }, [page]);

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
        writeBuffers((prev) =>
          prev[wanted]
            ? prev
            : {
                ...prev,
                [wanted]: {
                  data: result.section,
                  values: result.section.values,
                  styles: result.section.styles,
                  motion: result.section.motion,
                  contentDirty: false,
                  styleDirty: false,
                  motionDirty: false,
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
  }, [activeId, page, writeBuffers]);

  const onValues = useCallback(
    (values: Record<string, unknown>) => {
      if (activeId === null || !canManageContent) return;
      writeBuffers((prev) => {
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
      scheduleAutosave(activeId);
    },
    [activeId, canManageContent, scheduleAutosave, writeBuffers],
  );

  const onStyles = useCallback(
    (styles: StyleDocument) => {
      if (activeId === null || !canManageContent) return;
      writeBuffers((prev) => {
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
      scheduleAutosave(activeId);
    },
    [activeId, canManageContent, scheduleAutosave, writeBuffers],
  );

  /**
   * The chosen entrance, held in the buffer until somebody saves it.
   *
   * Not sent on click. A five-button radio group is exactly the control an
   * editor tries all of, and saving each press would write five drafts, bump
   * the revision five times and reload the canvas five times — and there would
   * be no way back to where they started that did not go through the server.
   * So it is dirty state like any other, with the same Save and the same
   * Discard changes beside it.
   */
  const onMotion = useCallback(
    (motion: MotionPreset) => {
      if (activeId === null || !canManageContent) return;
      writeBuffers((prev) => {
        const entry = prev[activeId];
        if (!entry) return prev;
        return {
          ...prev,
          [activeId]: {
            ...entry,
            motion,
            motionDirty: motion !== entry.data.motion,
            status: entry.status === "conflict" ? "conflict" : "idle",
            statusDomain: entry.status === "conflict" ? entry.statusDomain : null,
            message: entry.status === "conflict" ? entry.message : undefined,
          },
        };
      });
      scheduleAutosave(activeId);
    },
    [activeId, canManageContent, scheduleAutosave, writeBuffers],
  );

  /** Puts one domain back to what the server last said, leaving the others alone. */
  const revert = useCallback(
    (domain: EditDomain) => {
      if (activeId === null) return;
      // Whatever was about to be saved is no longer what the person wants. The
      // queue would notice on its own — the domain stops being dirty — but
      // cancelling is the honest thing to do with a timer nobody is waiting on.
      const pending = autosaveTimers.current.get(activeId);
      if (pending) {
        window.clearTimeout(pending);
        autosaveTimers.current.delete(activeId);
      }
      writeBuffers((prev) => {
        const entry = prev[activeId];
        if (!entry) return prev;
        const reset =
          domain === "content"
            ? { values: entry.data.values, contentDirty: false }
            : domain === "style"
              ? { styles: entry.data.styles, styleDirty: false }
              : { motion: entry.data.motion, motionDirty: false };
        return {
          ...prev,
          [activeId]: { ...entry, ...reset, status: "idle", statusDomain: null, message: undefined },
        };
      });
    },
    [activeId, writeBuffers],
  );

  /**
   * Take the version that won the race — all three domains of it.
   *
   * They share a revision, so adopting one and keeping the others would leave
   * the kept ones addressed to a revision that no longer exists: the next save
   * of them would conflict too, and the editor would have no way out of the
   * loop.
   */
  const takeLatest = useCallback(() => {
    if (activeId === null) return;
    writeBuffers((prev) => {
      const entry = prev[activeId];
      if (!entry?.latest) return prev;
      return {
        ...prev,
        [activeId]: {
          data: entry.latest,
          values: entry.latest.values,
          styles: entry.latest.styles,
          motion: entry.latest.motion,
          contentDirty: false,
          styleDirty: false,
          motionDirty: false,
          saving: null,
          status: "idle",
          statusDomain: null,
        },
      };
    });
    freshCanvas();
  }, [activeId, writeBuffers]);

  /**
   * One domain of one section, written.
   *
   * The primitive both autosave and "Save now" go through — there is no second
   * write path, because a save that reached the server a different way would be
   * a save with a different concurrency story, and the whole point of the
   * revision guard is that nothing moves a row without moving the counter.
   *
   * It takes the section id rather than reading the selection, because the
   * section being saved is very often not the one on screen: a debounce fires
   * after the editor has clicked elsewhere, and buffers survive a page change
   * entirely. It reads the live buffer out of a ref for the same reason — by
   * the time an await resolves, the state this closure captured is old.
   *
   * What it does do, as before, is adopt the new revision for the *whole*
   * buffer. The counter belongs to the row, not to a column, so an editor
   * whose styles save and then whose text saves is naming the revision their
   * own last save produced rather than conflicting with themselves.
   */
  const runSave = useCallback(
    async (sectionId: number, domain: EditDomain): Promise<"ok" | "conflict" | "error"> => {
      const entry = buffersRef.current[sectionId];
      if (!entry || entry.saving !== null || !canManageContent) return "error";
      if (!dirtyOf(entry)[domain]) return "ok";

      const sent = canonical(
        domain === "content" ? entry.values : domain === "style" ? entry.styles : entry.motion,
      );

      writeBuffers((prev) => {
        const live = prev[sectionId];
        if (!live) return prev;
        return { ...prev, [sectionId]: { ...live, saving: domain, message: undefined } };
      });

      const form = new FormData();
      form.set("_csrf", csrf);
      form.set("sectionId", String(sectionId));
      form.set("pageId", String(entry.data.pageId));
      form.set("expectedRevision", String(entry.data.revision));
      if (domain === "motion") form.set("motion", entry.motion);
      else form.set(domain === "content" ? "values" : "styles", sent);

      const settle = (patch: Partial<SectionBuffer>) =>
        writeBuffers((prev) => {
          const live = prev[sectionId];
          if (!live) return prev;
          return { ...prev, [sectionId]: { ...live, saving: null, statusDomain: domain, ...patch } };
        });

      let accepted: {
        revision: number;
        section?: VisualSectionData;
        styles?: StyleDocument;
        motion?: MotionPreset;
      };
      try {
        if (domain === "content") {
          const answer = await saveVisualSectionDraft(form);
          if (!answer.ok) {
            if (answer.reason === "conflict") {
              settle({ status: "conflict", message: answer.message, latest: answer.section });
              return "conflict";
            }
            settle({ status: "error", message: answer.message });
            return "error";
          }
          accepted = { revision: answer.section.revision, section: answer.section };
        } else if (domain === "style") {
          const answer = await saveVisualSectionStyles(form);
          if (!answer.ok) {
            if (answer.reason === "conflict") {
              settle({ status: "conflict", message: answer.message, latest: answer.section });
              return "conflict";
            }
            settle({ status: "error", message: answer.message });
            return "error";
          }
          accepted = { revision: answer.revision, styles: answer.styles };
        } else {
          const answer = await saveVisualSectionMotion(form);
          if (!answer.ok) {
            if (answer.reason === "conflict") {
              settle({ status: "conflict", message: answer.message, latest: answer.section });
              return "conflict";
            }
            settle({ status: "error", message: answer.message });
            return "error";
          }
          accepted = { revision: answer.revision, motion: answer.motion };
        }
      } catch {
        settle({ status: "error", message: "The save could not be sent. Try again." });
        return "error";
      }

      writeBuffers((prev) => {
        const live = prev[sectionId];
        if (!live) return prev;
        /**
         * Somebody who kept editing while the save was in flight keeps their
         * newer work — adopting the server's copy would delete the last thing
         * they did. The revision moves either way, so the next save is guarded
         * against the one that just landed rather than the one before, and the
         * domain stays dirty so the queue comes back for it.
         */
        const movedOn =
          canonical(
            domain === "content" ? live.values : domain === "style" ? live.styles : live.motion,
          ) !== sent;

        const data: VisualSectionData = accepted.section
          ? {
              ...accepted.section,
              styles: live.data.styles,
              hasStyleDraft: live.data.hasStyleDraft,
              motion: live.data.motion,
              hasMotionDraft: live.data.hasMotionDraft,
            }
          : accepted.styles
            ? {
                ...live.data,
                revision: accepted.revision,
                styles: accepted.styles,
                hasStyleDraft: true,
              }
            : {
                ...live.data,
                revision: accepted.revision,
                motion: accepted.motion ?? live.data.motion,
                hasMotionDraft: true,
              };

        const domainState =
          domain === "content"
            ? { values: movedOn ? live.values : data.values, contentDirty: movedOn }
            : domain === "style"
              ? { styles: movedOn ? live.styles : data.styles, styleDirty: movedOn }
              : { motion: movedOn ? live.motion : data.motion, motionDirty: movedOn };

        return {
          ...prev,
          [sectionId]: {
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
      return "ok";
    },
    [canManageContent, csrf, writeBuffers],
  );

  /**
   * Everything one section has waiting, saved in turn.
   *
   * The three domains share `page_sections.revision`, so they cannot be written
   * in parallel: two requests in flight against one row is a race this browser
   * would have manufactured out of two intentions that were each correct when
   * they left. So a section drains **sequentially**, in a fixed order — content,
   * style, motion — each save naming the revision the one before it produced.
   *
   * Different sections drain independently, because they have independent
   * counters and nothing about saving one says anything about another.
   *
   * It stops on anything that is not success. A conflict has to be resolved by
   * the editor choosing Reload latest — retrying it would either fail forever
   * or, worse, eventually win and overwrite the work that beat it. A failure
   * leaves the buffer dirty and stops too: an autosave that retried on its own
   * would be an infinite loop against a server that is down, and the next edit
   * schedules another attempt anyway.
   *
   * The canvas is reloaded once, at the end, rather than after each domain: it
   * is a rendering of all three.
   */
  const drainSection = useCallback(
    async (sectionId: number) => {
      if (!canManageContent || draining.current.has(sectionId)) return;
      draining.current.add(sectionId);
      let wrote = false;
      try {
        for (;;) {
          const entry = buffersRef.current[sectionId];
          if (!entry || entry.saving !== null) break;
          // A section already in conflict is not autosaved again at all.
          if (entry.status === "conflict") break;
          const dirty = dirtyOf(entry);
          const domain = EDIT_DOMAINS.find((key) => dirty[key]);
          if (!domain) break;
          const result = await runSave(sectionId, domain);
          if (result !== "ok") break;
          wrote = true;
        }
      } finally {
        draining.current.delete(sectionId);
      }

      if (!wrote) return;
      // Only the page being looked at: a debounce that fired for a section on
      // another page has nothing to say about this canvas.
      if (buffersRef.current[sectionId]?.data.pageId !== pageRef.current) return;
      const address = selectedRef.current?.address ?? null;
      restoreTo.current = address
        ? { address, fallback: `section:${sectionId}` }
        : null;
      freshCanvas();
      if (address) setRestoreToken((n) => n + 1);
    },
    [canManageContent, runSave],
  );

  drainRef.current = (sectionId: number) => void drainSection(sectionId);

  /** "Save now": the same queue, without waiting for the debounce. */
  const save = useCallback(() => {
    if (activeId === null) return;
    const pending = autosaveTimers.current.get(activeId);
    if (pending) {
      window.clearTimeout(pending);
      autosaveTimers.current.delete(activeId);
    }
    void drainSection(activeId);
  }, [activeId, drainSection]);

  /* ------------------------------------------------------------------ */
  /* Structure                                                           */
  /* ------------------------------------------------------------------ */

  /**
   * One structural request, the same shape every time.
   *
   * The form carries what every admin mutation carries — the session's token,
   * the page, and the revision *this screen* was built from — and the server
   * answers with the page's whole layout rather than a delta, so the panel
   * redraws from what is now true instead of from what it hoped would happen.
   *
   * Then the canvas reloads. It has to: the frame is a rendering of the layout,
   * and a reorder that patched the iframe's DOM would be the editor inventing a
   * page rather than showing one. `select` says where the selection should land
   * once the new document is ready, which is the only thing the caller has an
   * opinion about.
   *
   * Edit buffers are untouched throughout. A section keeps its id through a
   * move, a hide and a removal, so the sentence somebody was typing is still
   * theirs when it comes back.
   */
  const runStructural = useCallback(
    async (
      operate: (form: FormData) => Promise<VisualStructureResult>,
      fill: (form: FormData) => void,
      select: "new" | "keep" | "clear",
    ) => {
      if (!canManageContent || !page || !structure || structureBusy) return;
      setStructureBusy(true);
      setStructureFailure(null);

      const form = new FormData();
      form.set("_csrf", csrf);
      form.set("pageId", String(page.id));
      form.set("expectedRevision", String(structure.revision));
      fill(form);

      const previous = selectedRef.current?.address ?? null;
      const result = await operate(form);
      setStructureBusy(false);

      if (!result.ok) {
        setStructureFailure({ reason: result.reason, message: result.message });
        return;
      }
      if (result.structure) setStructure(result.structure);

      // Where the selection goes, by section id — the one thing that survives a
      // document being rebuilt.
      const wanted =
        select === "clear"
          ? null
          : select === "new" && result.sectionId
            ? `section:${result.sectionId}`
            : previous;
      restoreTo.current = wanted
        ? { address: wanted, fallback: wanted.split("/")[0]! }
        : null;
      freshCanvas();
      if (wanted) setRestoreToken((n) => n + 1);
    },
    [canManageContent, csrf, page, structure, structureBusy],
  );

  /**
   * The way out of a layout conflict: take the layout that won.
   *
   * It reads, it does not merge. Folding this screen's order into the newer one
   * would be guessing at an intention nobody expressed — the other editor moved
   * things for a reason, and a silent blend of two layouts is a third layout
   * neither of them asked for. So the server's answer replaces this screen's
   * copy whole, the revision comes with it, and the next structural action is
   * guarded against that.
   *
   * What it does not touch is the section buffers. Somebody's half-written
   * paragraph has nothing to do with the order of the page, and losing it
   * because a colleague dragged a section would be the most expensive possible
   * way to report a conflict. They are keyed by section id, so a section that
   * survived the other editor's change comes back to its own unsaved work.
   */
  const reloadLayout = useCallback(async () => {
    if (!page || structureBusy) return;
    setStructureBusy(true);
    const latest = await loadPageStructure(page.id);
    setStructureBusy(false);
    if (!latest) {
      setStructureFailure({
        reason: "invalid",
        message: "That page could not be read. Reload the editor.",
      });
      return;
    }

    setStructure(latest);
    setStructureFailure(null);

    // Keep the selection only if the section is still in the layout that won.
    const selected = selectedRef.current;
    const survives =
      selected && latest.structure.sections.some((entry) => entry.sectionId === selected.sectionId);
    restoreTo.current = survives
      ? { address: selected.address, fallback: `section:${selected.sectionId}` }
      : null;
    freshCanvas();
    if (survives) setRestoreToken((n) => n + 1);
  }, [page, structureBusy]);

  const ops: StructuralOps = useMemo(
    () => ({
      onAdd: (blockType, afterSectionId) =>
        void runStructural(
          addPageSection,
          (form) => {
            form.set("blockType", blockType);
            if (afterSectionId) form.set("afterSectionId", String(afterSectionId));
          },
          "new",
        ),
      onDuplicate: (sectionId) =>
        void runStructural(
          duplicatePageSection,
          (form) => form.set("sectionId", String(sectionId)),
          "new",
        ),
      onMove: (sectionId, direction) => {
        const order = sections.map((row) => row.sectionId);
        const at = order.indexOf(sectionId);
        const to = direction === "up" ? at - 1 : at + 1;
        if (at < 0 || to < 0 || to >= order.length) return;
        [order[at], order[to]] = [order[to]!, order[at]!];
        void runStructural(
          reorderPageStructure,
          (form) => form.set("order", JSON.stringify(order)),
          "keep",
        );
      },
      onReorder: (order) =>
        void runStructural(
          reorderPageStructure,
          (form) => form.set("order", JSON.stringify(order)),
          "keep",
        ),
      onVisibility: (sectionId, visible) =>
        void runStructural(
          setPageSectionVisibility,
          (form) => {
            form.set("sectionId", String(sectionId));
            form.set("visible", visible ? "true" : "false");
          },
          "keep",
        ),
      onRemove: (sectionId) =>
        void runStructural(
          removePageSection,
          (form) => form.set("sectionId", String(sectionId)),
          // A section that is no longer rendered cannot stay selected, and the
          // inspector describing something the canvas is not showing is worse
          // than an empty inspector.
          selectedRef.current?.sectionId === sectionId ? "clear" : "keep",
        ),
      onRestore: (sectionId) =>
        void runStructural(
          restorePageSection,
          (form) => form.set("sectionId", String(sectionId)),
          "new",
        ),
      onDiscard: () => {
        // A pending section's unsaved text would go with the row. Saying so and
        // stopping is the only honest answer: there is nowhere to put it back.
        const pendingIds = new Set(
          (structure?.sections ?? []).filter((row) => row.isDraftOnly).map((row) => row.sectionId),
        );
        const unsaved = [...dirtyIds].some((id) => pendingIds.has(id));
        if (unsaved) {
          setStructureFailure({
            reason: "invalid",
            message: "Save or revert unsaved edits in new sections before discarding the layout.",
          });
          return;
        }
        if (!window.confirm("Discard the layout changes? Sections added here are deleted.")) return;
        void runStructural(discardPageLayout, () => undefined, "clear");
      },
    }),
    [dirtyIds, runStructural, sections, structure],
  );

  /* ------------------------------------------------------------------ */
  /* The page: publish, discard, restore                                 */
  /* ------------------------------------------------------------------ */

  /**
   * What this browser is still holding for the page on screen.
   *
   * Page-scoped on purpose. Buffers survive a page change, so an unsaved
   * paragraph on another page is real and worth counting in the toolbar — but
   * it has nothing to do with whether *this* page can be published, and letting
   * it block the button would leave an editor unable to publish anything
   * without hunting down a tab-worth of state they cannot see.
   */
  const pageLocal = useMemo(() => {
    let dirty = 0;
    let saving = 0;
    let conflicted = 0;
    for (const entry of Object.values(buffers)) {
      if (!page || entry.data.pageId !== page.id) continue;
      if (isDirty(entry)) dirty += 1;
      if (entry.saving !== null) saving += 1;
      if (entry.status === "conflict") conflicted += 1;
    }
    return { dirty, saving, conflicted };
  }, [buffers, page]);

  /**
   * Why publishing cannot start, in one sentence, or null.
   *
   * Local work first, because a publication that ignored it would put out a
   * page missing the sentence somebody is in the middle of typing — and the
   * autosave that would have carried it is a second away.
   */
  const publishBlocked = useMemo(() => {
    if (!canManageContent) return null;
    if (pageLocal.conflicted) {
      return "A section on this page has a conflict. Reload the latest version of it first.";
    }
    if (pageLocal.saving) return "Saving drafts…";
    if (pageLocal.dirty) return "Saving drafts…";
    if (structureBusy) return "Finishing a layout change…";
    return null;
  }, [canManageContent, pageLocal, structureBusy]);

  const refreshPageState = useCallback(async () => {
    if (!page) return;
    const [next, past] = await Promise.all([loadPageSummary(page.id), loadPageHistory(page.id)]);
    setSummary(next);
    setHistory(past);
    // The layout's own revision is what a publication names, and a publication
    // moves it — so the panel re-reads it rather than assuming.
    if (next) {
      setStructure((current) => (current ? { ...current, revision: next.revision } : current));
    }
  }, [page]);

  useEffect(() => {
    if (!page) return;
    let cancelled = false;
    setSummary(null);
    setHistory(null);
    void Promise.all([loadPageSummary(page.id), loadPageHistory(page.id)]).then(([next, past]) => {
      if (cancelled) return;
      setSummary(next);
      setHistory(past);
    });
    return () => {
      cancelled = true;
    };
  }, [page]);

  /**
   * What the last page-level act reported is cleared when the editor moves to
   * another page — and only then.
   *
   * It used to be cleared by the effect above, which runs on every new `page`
   * object. A publication triggers a server refresh, that refresh hands down a
   * fresh `page`, and the effect ran roughly twenty milliseconds after the
   * message was set: the sentence describing what had just happened appeared
   * and vanished inside the same frame. Whether an admin is told "the saved
   * changes are live now" or "this page is still unpublished, so visitors
   * cannot see it yet" only matters if the sentence stays on screen long
   * enough to read.
   */
  useEffect(() => {
    setPageMessage(null);
    setPageError(null);
  }, [pageId]);

  /**
   * After a page-level act, everything this editor believes is stale.
   *
   * The drafts it was showing are live, or gone; the rows it was numbering have
   * new positions; the page revision every structural write names has moved.
   * So the buffers for this page are dropped rather than patched — a buffer
   * whose `data` describes a draft that no longer exists is worse than no
   * buffer, because the panel would keep offering to save it — and the layout,
   * the canvas and the summary are re-read from the server.
   */
  const afterPageAction = useCallback(
    async (keepSelection: boolean) => {
      if (!page) return;
      const pageId = page.id;
      for (const [id, timer] of autosaveTimers.current) {
        const entry = buffersRef.current[Number(id)];
        if (!entry || entry.data.pageId === pageId) {
          window.clearTimeout(timer);
          autosaveTimers.current.delete(Number(id));
        }
      }
      /**
       * Which sections belonged to this page, worked out *before* the buffers
       * go — afterwards there is nothing left to ask.
       *
       * `requested` is what stops the panel asking the server for the same
       * section twice. A section dropped from the buffers but left in that set
       * is a section the editor will never load again: selecting it shows a
       * spinner that never resolves, because the one thing that would have
       * fetched it has already decided it did.
       */
      const mine = new Set(
        Object.entries(buffersRef.current)
          .filter(([, entry]) => entry.data.pageId === pageId)
          .map(([id]) => Number(id)),
      );
      writeBuffers((prev) => {
        const next: Record<number, SectionBuffer> = {};
        for (const [id, entry] of Object.entries(prev)) {
          if (entry.data.pageId !== pageId) next[Number(id)] = entry;
        }
        return next;
      });
      requested.current = new Set([...requested.current].filter((id) => !mine.has(id)));

      const latest = await loadPageStructure(pageId);
      if (latest) setStructure(latest);
      setStructureFailure(null);
      await refreshPageState();

      const selected = selectedRef.current;
      const survives =
        keepSelection &&
        selected &&
        latest?.structure.sections.some((entry) => entry.sectionId === selected.sectionId);
      restoreTo.current = survives
        ? { address: selected.address, fallback: `section:${selected.sectionId}` }
        : null;
      freshCanvas();
      if (survives) setRestoreToken((n) => n + 1);
    },
    [page, refreshPageState, writeBuffers],
  );

  /* ------------------------------------------------------------------ */
  /* Global site chrome                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * The site's own settings, read when somebody opens the drawer.
   *
   * Not with the page: they are not the page's, and fetching them on every
   * canvas load would send site-wide settings to a browser that never asked
   * for them. The server decides what comes back — a session without
   * `navigation.manage` gets no menus at all, not menus with the buttons
   * greyed out.
   */
  const refreshGlobals = useCallback(async () => {
    if (!canManageNavigation && !canManageSettings) return;
    setGlobalsLoading(true);
    try {
      setGlobals(await loadEditorGlobals());
    } catch {
      // The drawer keeps whatever it had and offers its own Refresh.
    } finally {
      setGlobalsLoading(false);
    }
  }, [canManageNavigation, canManageSettings]);

  /**
   * After a global change, and the list of what it does **not** do is the
   * point.
   *
   * A Contact address or a menu label has nothing to do with the paragraph
   * somebody is part way through typing, so this is deliberately not
   * `afterPageAction`: the edit buffers stay, the page's draft summary and
   * history stay, no page or section revision moves, and no restore point is
   * written. The canvas is reloaded because the header, the footer and the
   * floating button are part of the document it is showing, and the selection
   * is put back on the far side of it.
   */
  const afterGlobalChange = useCallback(async () => {
    await refreshGlobals();
    const selected = selectedRef.current;
    restoreTo.current = selected
      ? { address: selected.address, fallback: `section:${selected.sectionId}` }
      : null;
    freshCanvas();
    if (selected) setRestoreToken((n) => n + 1);
  }, [refreshGlobals]);

  const toggleGlobals = useCallback(() => {
    setGlobalsPanel((value) => {
      const next = !value;
      if (next) void refreshGlobals();
      return next;
    });
  }, [refreshGlobals]);

  const runPageAction = useCallback(
    async (
      operate: (form: FormData) => Promise<{ ok: boolean; message: string }>,
      fill: (form: FormData) => void,
      keepSelection: boolean,
    ) => {
      if (!page || !canManageContent || pageBusy) return;
      setPageBusy(true);
      setPageMessage(null);
      setPageError(null);

      const form = new FormData();
      form.set("_csrf", csrf);
      form.set("pageId", String(page.id));
      form.set("expectedRevision", String(summary?.revision ?? structure?.revision ?? -1));
      fill(form);

      let answer: { ok: boolean; message: string };
      try {
        answer = await operate(form);
      } catch {
        setPageBusy(false);
        setPageError("That could not be sent. Try again.");
        return;
      }

      if (!answer.ok) {
        setPageBusy(false);
        setPageError(answer.message);
        // The refusal may well be "you are out of date", so re-read rather than
        // leave the panel quoting the numbers that were just rejected.
        await refreshPageState();
        return;
      }

      await afterPageAction(keepSelection);
      setPageBusy(false);
      setPageMessage(answer.message);
    },
    [afterPageAction, canManageContent, csrf, page, pageBusy, refreshPageState, structure, summary],
  );

  const publishPage = useCallback(() => {
    const removal = summary ? describeRemoval(summary) : null;
    const lines = summary ? describePending(summary) : [];
    const question = [
      "Publish the saved changes on this page?",
      lines.length ? lines.join(", ") + "." : "",
      removal ?? "",
    ]
      .filter(Boolean)
      .join("\n\n");
    if (!window.confirm(question)) return;
    void runPageAction(publishPageFromEditor, () => undefined, true);
  }, [runPageAction, summary]);

  const discardPage = useCallback(() => {
    if (
      !window.confirm(
        "Discard every saved change on this page? Sections added here are deleted. The live page " +
          "does not change.",
      )
    ) {
      return;
    }
    void runPageAction(discardPageFromEditor, () => undefined, false);
  }, [runPageAction]);

  const restoreVersion = useCallback(
    (versionId: number) => {
      void runPageAction(
        restoreVersionFromEditor,
        (form) => form.set("versionId", String(versionId)),
        false,
      );
    },
    [runPageAction],
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
  const savingCount = useMemo(
    () => Object.values(buffers).filter((entry) => entry.saving !== null).length,
    [buffers],
  );

  useEffect(() => {
    // Autosave shortens this window; it does not remove it. Something dirty is
    // something only this browser has, and something in flight has not been
    // acknowledged yet — both are worth one prompt.
    if (!dirtyCount && !savingCount) return;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtyCount, savingCount]);

  /** A debounce that outlived the editor would save into a closed screen. */
  useEffect(() => {
    const timers = autosaveTimers.current;
    return () => {
      for (const timer of timers.values()) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);

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
            {!canManageContent ? (
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
          {dirtyCount || savingCount ? (
            <span
              className="rounded-full px-2 py-0.5 text-[0.7rem] font-semibold"
              style={{
                background: "color-mix(in oklab, var(--color-orange) 18%, transparent)",
                color: "var(--color-peach)",
              }}
              aria-live="polite"
            >
              {/* Sections, not domains: three edits to one section is one
                  section waiting, and saying "3 unsaved" would read as three. */}
              {dirtyCount ? `${dirtyCount} unsaved` : `Saving ${savingCount}…`}
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
          {/*
            The site's controls, beside the page's and never mixed into them.
            Offered only to somebody who may actually change something: a
            drawer that opens to explain it is empty is a worse answer than a
            button that was never there.
          */}
          {canManageNavigation || canManageSettings ? (
            <button
              type="button"
              onClick={toggleGlobals}
              aria-expanded={globalsPanel}
              className="admin-btn admin-btn-sm"
              title="Header, footer, brand, contact and other site-wide settings"
            >
              <Icon name="globe" size={12} />
              <span className="hidden lg:inline">Globals</span>
            </button>
          ) : null}
          {/*
            The page's own controls, behind one button, because none of them
            act on the selection: publishing, discarding and history all belong
            to the page and would read as the section's beside the Inspector's
            tabs.
          */}
          <button
            type="button"
            onClick={() => setPagePanel((value) => !value)}
            aria-expanded={pagePanel}
            className="admin-btn admin-btn-sm"
            style={
              summary?.publishable
                ? { borderColor: "var(--color-orange)", color: "var(--color-strong)" }
                : undefined
            }
          >
            <Icon name="check" size={12} />
            <span className="hidden lg:inline">Publish</span>
            {summary?.publishable ? (
              <span aria-hidden className="inline-block size-1.5 rounded-full" style={{ background: "var(--color-orange)" }} />
            ) : null}
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
          structure={structure}
          removed={structure ? removedSections(structure) : []}
          selectedSectionId={activeId}
          dirtyIds={dirtyIds}
          ready={ready}
          canManage={canManageContent}
          busy={structureBusy}
          failure={structureFailure}
          onReloadLayout={reloadLayout}
          blocks={blocks[page.slug] ?? []}
          ops={ops}
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

          <PagePanel
            open={pagePanel}
            onClose={() => setPagePanel(false)}
            title={page.title}
            summary={summary}
            history={history}
            canManage={canManageContent}
            busy={pageBusy}
            blockedReason={publishBlocked}
            message={pageMessage}
            error={pageError}
            onPublish={publishPage}
            onDiscard={discardPage}
            onRestore={restoreVersion}
            onRefresh={() => void refreshPageState()}
          />

          <GlobalsPanel
            open={globalsPanel}
            onClose={() => setGlobalsPanel(false)}
            csrf={csrf}
            globals={globals}
            loading={globalsLoading}
            onRefresh={() => void refreshGlobals()}
            onChanged={afterGlobalChange}
          />

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
          canManage={canManageContent}
          buffer={buffer}
          breakpoint={DEVICE_BREAKPOINT[device]}
          tab={tab}
          onTab={setTab}
          loading={loadingId !== null && loadingId === activeId}
          loadError={loadError}
          onValues={onValues}
          onStyles={onStyles}
          onMotion={onMotion}
          onSave={save}
          onRevert={revert}
          onTakeLatest={takeLatest}
          onClear={() => ask(null)}
          onSelect={ask}
        />
      </div>
    </div>
  );
}

