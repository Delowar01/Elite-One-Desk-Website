"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  addPageSection,
  detachVisualInstance,
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
import {
  discardRouteFromEditor,
  loadRouteCompare,
  loadRouteHistory,
  loadRouteRegion,
  loadRouteSummary,
  publishRouteFromEditor,
  resolveRouteConflict,
  restoreRouteFromEditor,
  saveRouteRegionDraft,
  saveRouteRegionMotion,
  saveRouteRegionStyles,
} from "@/app/(backoffice)/admin/visual-editor/route-actions";
import {
  createReusableFromSection,
  loadReusableCatalog,
} from "@/app/(backoffice)/admin/(shell)/components/actions";
import { ReuseEditor } from "@/components/admin/reuse/reuse-editor";
import {
  CAPABILITY_WORDS,
  deniedCapability,
  type Capabilities,
  type Capability,
} from "@/lib/auth/authority";
import type { MediaOption } from "@/components/admin/media-picker";
import { GlobalsPanel } from "@/components/admin/visual-editor/globals-panel";
import { Icon } from "@/components/ui/icon";
import type { BlockDef } from "@/lib/cms/blocks";
import type { MotionPreset } from "@/lib/cms/motion";
import type { MotionDocument } from "@/lib/cms/motion-doc";
import { kindNoun } from "@/lib/cms/reuse/kinds";
import { directEditDecision, linkSlot, readReuse, sameReuse, slotDef } from "@/lib/cms/reuse/reference";
import { usageHeadline } from "@/lib/cms/reuse/usage-view";
import type { ReuseCatalogEntry } from "@/lib/cms/reuse/view";
import { advancedStylesDiffer, type StyleDocument } from "@/lib/cms/styles";
import { removedSections, type PageStructure } from "@/lib/cms/structure";
import { LOCALE_LABELS, LOCALES, type Locale } from "@/lib/i18n/config";
import { previewPagePath, previewRoutePath } from "@/lib/page-path";
import { ORDER_KEY, ROUTE_LIST_OF, ROUTE_STRUCTURAL_FIELDS } from "@/lib/routes/blocks";
import { isRouteEditorKey, parseOwnerKey, type RouteKind } from "@/lib/routes/owners";
import type { RouteActionResult, RouteHistoryView, RouteSummaryView } from "@/lib/routes/views";
import type { RouteOwnerInfo, VisualSectionData, VisualStructureResult } from "@/lib/visual-editor/content";
import {
  describePending,
  describeRemoval,
  type PageHistoryView,
  type PageSummaryView,
} from "@/lib/visual-editor/publish";
import type { GlobalsState } from "@/lib/visual-editor/globals";
import type { EditorNodeMeta, EditorSectionMeta, ReplayMode, ReplayOutcome } from "@/lib/visual-editor/protocol";
import { DEVICE_BREAKPOINT, EDITOR_DEVICES, type DeviceKey } from "@/lib/visual-editor/viewport";

import {
  VisualCanvas,
  type CanvasState,
  type EditRequest,
  type ReplayRequest,
  type SelectRequest,
} from "./canvas";
import {
  dirtyOf,
  EDIT_DOMAINS,
  InspectorPanel,
  isDirty,
  type EditDomain,
  type SectionBuffer,
} from "./inspector";
import { formatNodePath, parseAddress } from "@/lib/cms/address";
import { applyTextAt, directEditAt, textAt } from "@/lib/visual-editor/tree";
import { acceptEdit, type DirectEditSession } from "@/lib/visual-editor/direct-edit";
import { acceptReplayResult, type ReplaySession } from "@/lib/visual-editor/replay";
import {
  applyContent,
  boundPages,
  closeGroup,
  describeContent,
  describeMotion,
  describeStructure,
  describeStyle,
  diffContent,
  emptyHistory,
  HISTORY_RESET,
  record,
  structureStep,
  takeRedo,
  takeUndo,
  UNDO_SCOPE_NOTE,
  type HistoryChange,
  type PageHistory,
  type StructureOp,
  type StructureStep,
} from "@/lib/visual-editor/history";
import { isTextTarget, shortcutFor, type ShortcutCommand } from "@/lib/visual-editor/protocol";
import { withDomainValue } from "@/lib/visual-editor/buffer-state";
import { ROUTE_KIND_TEXT } from "@/lib/visual-editor/route-kinds";
import { LayersPanel, type StructuralOps } from "./layers";
import { layersFocusOf, layersFocusTarget, type LayersFocus } from "./layers-focus";
import { PagePanel } from "./page-panel";
import { RouteLayersPanel } from "./route-layers";
import { RoutePanel } from "./route-panel";
import type { RouteControls } from "./route-source";
import type { ReuseControls, ReuseNotice } from "./reuse-panel";

export type EditablePage = {
  /** A page's id, or a dynamic route's document key (Batch 21, `lib/routes/owners.ts`). */
  id: number;
  /** A page's slug, or a route's key — `category:3`, `service:12`. Never a path. */
  slug: string;
  title: string;
  /** The public address, without a language prefix. */
  path: string;
  isPublished: boolean;
  /**
   * What the document is: a CMS page, a service category's route (Batch 21),
   * a service's own page (Batch 22), a package's or a destination's page, the
   * package catalogue or the services overview (Batch 24).
   */
  kind: "page" | RouteKind;
  /**
   * The group the picker lists it under, where its kind has groups: a
   * service's category, a package's destination.
   */
  group?: string;
  /**
   * Its search and sharing settings (Batch 25), for a role that may edit them:
   * the SEO target's reference, and whether the target has a record of its own.
   * The editor never edits SEO — it links to the one screen that does.
   */
  seo?: { ref: string; custom: boolean };
};

const STATUS: Record<CanvasState["status"], { label: string; tone: string }> = {
  loading: { label: "Loading canvas…", tone: "var(--color-muted)" },
  connecting: { label: "Connecting…", tone: "var(--color-peach)" },
  ready: { label: "Ready", tone: "#5ad19a" },
  error: { label: "Unable to connect", tone: "#ef8f8a" },
};

const EMPTY_CANVAS: CanvasState = { status: "loading", innerWidth: null, message: null };

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
 * What to select once a redrawn canvas is ready: an address, and what to fall
 * back to when the new document has nothing at that address.
 */
type RestoreTarget = { address: string; fallback: string };

/**
 * The outermost thing an address names — its section, or a route's region:
 * `section:15/field:items/item:a1` → `section:15`, `serviceHero:12/field:title`
 * → `serviceHero:12`. The nearest thing that still exists when the node itself
 * has gone.
 */
const rootOf = (address: string): string => address.split("/")[0]!;

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
/** The capability each of the three edit domains needs (Batch 18). */
const DOMAIN_CAPABILITY: Record<EditDomain, Capability> = {
  content: "editContent",
  style: "editStyle",
  motion: "editMotion",
};

export function VisualEditorShell({
  pages,
  initial,
  can,
  domains,
  canManageNavigation,
  canManageSettings,
  csrf,
  media,
  blocks,
}: {
  pages: EditablePage[];
  initial: { slug: string; locale: Locale; device: DeviceKey };
  /**
   * What this session may do to page content, one answer per capability
   * (Batch 18, `lib/auth/authority.ts`): content, standard and advanced style,
   * motion, layout, publishing, and the reusable-component four. They are
   * granted separately, so no control here stands in for another — and every
   * one of them is checked again by the action it calls.
   */
  can: Capabilities;
  /**
   * The resource capabilities a dynamic route's records need beside the page
   * ones (Batch 21): `services.manage` for a category, its groups, services
   * and template wording, `faqs.manage` for its questions. The route actions
   * check them again on every write.
   */
  domains: { services: boolean; faqs: boolean; packages: boolean };
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
  const [editRequest, setEditRequest] = useState<EditRequest>(null);
  /**
   * Replay (Batch 15b): what the canvas is asked to play, the session that
   * asked, and what the canvas said about it.
   *
   * Editor-session state and nothing more, like the locks below: none of it is
   * sent to a Server Action, written into a buffer, marked dirty or saved. A
   * Replay changes what the canvas shows for a few seconds and is gone.
   */
  const [replayRequest, setReplayRequest] = useState<ReplayRequest>(null);
  const [replayStatus, setReplayStatus] = useState<{ address: string; outcome: ReplayOutcome } | null>(null);
  const replayToken = useRef(0);
  const replaySession = useRef<ReplaySession | null>(null);
  /**
   * Which addresses the canvas pointer must ignore.
   *
   * Editor-session state and nothing more: it is held here for as long as this
   * page is open, it is never sent to a Server Action, never written to the
   * database, never part of the style document, the content, the page history
   * or a publish. Nobody else sees it and nothing survives a page change —
   * which is exactly what a lock is for, since it exists to stop *this* editor
   * mis-clicking while they work on *this* page.
   *
   * It is not a permission. Every save is still checked server-side exactly as
   * it was before, and an editor can always reach a locked node from Layers.
   */
  const [locks, setLocks] = useState<string[]>([]);

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
  /**
   * Reusable components (Batch 17): every component with its usage, as the
   * server last said. For showing names, inherited text and "Used on" — never
   * for deciding a save, which the server checks for itself.
   */
  const [catalog, setCatalog] = useState<ReuseCatalogEntry[] | null>(null);
  /** The direct-edit refusal being shown: this text is linked and not overridden here. */
  const [reuseNotice, setReuseNotice] = useState<ReuseNotice | null>(null);
  /** A detach or a save-as is on its way to the server. */
  const [reuseBusy, setReuseBusy] = useState(false);
  const [reuseMessage, setReuseMessage] = useState<{ ok: boolean; text: string } | null>(null);
  /** The component editor drawer, and where it opened. */
  const [componentDrawer, setComponentDrawer] = useState<{ id: number; focus: "edit" | "usage" } | null>(null);
  /** The catalogue re-read, reachable from the save queue that is declared above it. */
  const refreshCatalogRef = useRef<() => void>(() => {});
  /**
   * The page drawer's summary re-read, reachable from the save queue (Batch
   * 21). A page's saves revalidate the admin and hand the editor a new page
   * object, which re-reads its summary; a route's saves change nothing an
   * admin screen lists, so the queue asks for the route's summary itself.
   */
  const refreshPageStateRef = useRef<() => void>(() => {});
  /** Sections already asked for, so a re-render does not ask again. */
  /**
   * Loads that have been started and not yet answered, by section.
   *
   * Replaces the set of "sections we have asked about": a set could say a load
   * had happened but not hand the answer to a second asker, so a direct-edit
   * request arriving while a selection load was in flight either started its
   * own or gave up. A promise per section is the thing both of them can wait
   * on.
   */
  const inflight = useRef<Map<number, Promise<SectionBuffer | null>>>(new Map());
  /**
   * The direct-edit session: which request is the live one, and what it began
   * from.
   *
   * `token` rises with every request, so a message arriving from a superseded
   * session — a canvas that was replaced, an address the editor moved off,
   * a request the person changed their mind about — is recognised and ignored
   * rather than applied to whatever is selected now. `started` is the value the
   * session opened with, which is what Escape restores.
   */
  const editToken = useRef(0);
  const editSession = useRef<DirectEditSession | null>(null);
  /** Where the selection should go once the canvas comes back from a save. */
  const restoreTo = useRef<RestoreTarget | null>(null);
  const [restoreToken, setRestoreToken] = useState(0);
  /**
   * The selection being held across a redraw (Batch 23).
   *
   * A save redraws the canvas, and the canvas reports "nothing selected" twice
   * while its document is replaced — once when it is asked for a new one and
   * once when that one loads. Taken at their word, those emptied the
   * Inspector: the box being typed in was unmounted, the keyboard focus fell
   * to the page and the next keystrokes went nowhere. The editor knows those
   * two reports are the old document leaving, not an answer — so when a
   * redraw puts back the node that is selected now, the selection is kept
   * through it and the Inspector stays exactly as it is.
   *
   * Held until the canvas answers the restore (`asked` is set when it is
   * asked): the same node ends the hold; "nothing here" ends it and falls back
   * as before; a different node — somebody chose something else — ends it and
   * wins. Choosing anything from the editor ends it too (`ask`). Nothing here
   * ever moves the keyboard focus: the box keeps it because it is never
   * replaced.
   */
  const holding = useRef<(RestoreTarget & { asked: boolean }) | null>(null);
  /**
   * Where the keyboard focus was in Layers when the canvas began to redraw
   * (Batch 24): the tree has no rows until the new document reports in, so the
   * focus goes with them — and comes back to the same control of the same row
   * once the new tree draws it (`layers-focus.ts`). The rows themselves are
   * never kept: they would describe the document that is going away.
   */
  const layersFocus = useRef<LayersFocus | null>(null);
  /**
   * A redraw put off because a direct edit is under way on the canvas
   * (Batch 23): the section whose save asked for it.
   *
   * Redrawing replaces the document the person is typing into, which ends the
   * session and loses whatever is typed next. The save itself goes ahead —
   * only the redraw waits, and it happens when the session ends, or is made
   * unnecessary by whichever redraw comes first.
   */
  const deferredRedraw = useRef<number | null>(null);
  /** `settleDeferredRedraw`, reachable from the edit callbacks declared above it (the `drainRef` pattern). */
  const settleDeferredRef = useRef<() => void>(() => {});
  /**
   * A restore that has been asked for and not answered yet (Batch 19A).
   *
   * The canvas answers every `editor.select`: with the node, or — when nothing
   * in the new document answers to the address — by clearing the selection.
   * So the next selection it reports after a restore *is* the answer, and the
   * fallback to the section follows that answer rather than a clock. It used
   * to follow a 400 ms timer, and a canvas slower than that (a heavy page, a
   * busy machine) was taken for a missing node: the section was asked for as
   * well, arrived after the node, and the Inspector jumped from what was being
   * edited to its whole section.
   */
  const restoring = useRef<{ address: string; fallback: string } | null>(null);
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
  /** The same two answers for a dynamic route (Batch 21), from its own actions. */
  const [routeSummary, setRouteSummary] = useState<RouteSummaryView | null>(null);
  const [routeHistory, setRouteHistory] = useState<RouteHistoryView | null>(null);
  /** The fields a refused route publication named, so the drawer can list them. */
  const [pageErrorDetails, setPageErrorDetails] = useState<string[]>([]);
  /** A field conflict is being settled with the server. */
  const [resolving, setResolving] = useState(false);
  const [pageBusy, setPageBusy] = useState(false);
  const [pageMessage, setPageMessage] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);

  const page = useMemo(() => pages.find((row) => row.slug === slug) ?? pages[0], [pages, slug]);
  /**
   * A dynamic route rather than a CMS page: a service category's page
   * (Batch 21) or a service's own (Batch 22). The editor is the same editor;
   * what differs is underneath — where a region's data is read and saved,
   * what the page drawer publishes, and what Layers may do.
   */
  const isRoute = Boolean(page) && page.kind !== "page";
  const routeKind: RouteKind = page && page.kind !== "page" ? page.kind : "category";
  const routeNoun = page && page.kind !== "page" ? ROUTE_KIND_TEXT[page.kind].noun : "page";
  /**
   * Whether this session may change a route region's record — the capability
   * of the domain the server named for it (Batch 24: packages too).
   */
  const mayRecord = useCallback(
    (info: RouteOwnerInfo): boolean =>
      info.domain === "faqs.manage" ? domains.faqs : info.domain === "packages.manage" ? domains.packages : domains.services,
    [domains],
  );
  /** Whether the page's own structure — order, visibility — is this role's to change at all. */
  const routeStructureDomain =
    routeKind === "package" || routeKind === "destination" || routeKind === "packageIndex"
      ? domains.packages
      : domains.services || domains.faqs;
  /** Which page is being edited, as a value — `page` itself is a new object on every refresh. */
  const pageId = page?.id ?? null;
  pageRef.current = page?.id ?? null;
  /**
   * The language and the canvas document, mirrored for the readiness path.
   *
   * It has to compare what the editor is showing *now* against what it was
   * showing when the request was made, and a value captured in a closure would
   * only ever tell it what things were then.
   */
  const localeRef = useRef(locale);
  localeRef.current = locale;
  const canvasKeyRef = useRef(canvasKey);
  canvasKeyRef.current = canvasKey;

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

  /* ------------------------------------------------------------------ */
  /* What this session may change (Batch 18)                             */
  /* ------------------------------------------------------------------ */

  /**
   * Capabilities the server has refused since the editor opened.
   *
   * `can` is what the session held when the page was drawn. A permission
   * removed while the editor is open is not known here until the server says
   * so — every action reads the grants afresh — and when it does, that
   * capability stops being offered for the rest of the session: its controls
   * lock, its unsaved work stays where it is with the refusal beside it, and
   * the other domains carry on. Nothing is ever *granted* from here; a
   * capability can only be taken away, and a reload reads the truth again.
   */
  const [revoked, setRevoked] = useState<ReadonlySet<Capability>>(() => new Set());
  const revokedRef = useRef<ReadonlySet<Capability>>(new Set());

  /** For decisions made in callbacks: the grant as drawn, minus any refusal since. */
  const allowed = useCallback(
    (capability: Capability): boolean => can[capability] && !revokedRef.current.has(capability),
    [can],
  );
  /** For drawing: the same answer, from state, so a refusal redraws the controls. */
  const may = (capability: Capability): boolean => can[capability] && !revoked.has(capability);

  /** A refusal the server gave: stop offering what it was about, if it names one thing. */
  const noteRefusal = useCallback(
    (message: string | undefined) => {
      const capability = deniedCapability(message);
      if (!capability || revokedRef.current.has(capability)) return;
      const next = new Set(revokedRef.current);
      next.add(capability);
      revokedRef.current = next;
      setRevoked(next);
      // A direct edit already under way is content; it cannot carry on.
      if (capability === "editContent" && editSession.current) {
        const session = editSession.current;
        editSession.current = null;
        setEditRequest({ kind: "cancel", token: session.token });
      }
    },
    [],
  );

  /* ------------------------------------------------------------------ */
  /* Undo and Redo (Batch 16)                                            */
  /* ------------------------------------------------------------------ */

  /**
   * The editing session's history, one per page, most recently used last.
   *
   * Session state and nothing more, like the buffers and the locks: held in
   * memory for as long as the editor is open, never sent anywhere, never
   * saved. Per page because an action belongs to the page it was taken on —
   * Undo on About must never reach into Home — and kept across a page switch,
   * because the buffers it describes are kept across one too. Bounded twice:
   * `HISTORY_LIMIT` actions per page, `HISTORY_PAGES` pages.
   *
   * The map is the state and `historyTick` is how it gets drawn — the same
   * split as `buffersRef` and `buffers`, for the same reason: Undo reads it
   * between awaits.
   */
  const historiesRef = useRef<Map<number, PageHistory>>(new Map());
  const historyOrder = useRef<number[]>([]);
  const [historyTick, setHistoryTick] = useState(0);
  /** Why a history was just thrown away, in the words the toolbar shows. */
  const [historyNotice, setHistoryNotice] = useState<string | null>(null);
  /** A layout Undo is on its way to the server. */
  const [historyBusy, setHistoryBusy] = useState(false);
  /** A slider is under the pointer: its whole drag is one action. */
  const pointerHeld = useRef(false);

  const historyOf = useCallback(
    (pageId: number): PageHistory => historiesRef.current.get(pageId) ?? emptyHistory(),
    [],
  );

  const writeHistory = useCallback((pageId: number, next: PageHistory) => {
    const map = new Map(historiesRef.current);
    map.set(pageId, next);
    const order = [...historyOrder.current.filter((id) => id !== pageId), pageId];
    const bounded = boundPages(map, order);
    historiesRef.current = bounded.histories;
    historyOrder.current = bounded.order;
    setHistoryTick((n) => n + 1);
  }, []);

  /** One action, recorded on the page it was taken on. */
  const recordChange = useCallback(
    (pageId: number, change: HistoryChange, label: string, options: { held?: boolean } = {}) => {
      writeHistory(
        pageId,
        record(historyOf(pageId), change, label, Date.now(), { held: options.held || pointerHeld.current }),
      );
      setHistoryNotice(null);
    },
    [historyOf, writeHistory],
  );

  /** Ends whatever typing or dragging group is open on the page on screen. */
  const closeHistoryGroup = useCallback(() => {
    const pageId = pageRef.current;
    if (pageId === null) return;
    const current = historiesRef.current.get(pageId);
    if (current?.open) writeHistory(pageId, closeGroup(current));
  }, [writeHistory]);

  /**
   * Throws a page's history away, and says why when there is a reason worth
   * saying. Nothing is written anywhere: the drafts stay exactly as they are,
   * only the list of what could be taken back is gone.
   */
  const resetHistory = useCallback((pageId: number, notice: string | null) => {
    const map = new Map(historiesRef.current);
    map.delete(pageId);
    historiesRef.current = map;
    historyOrder.current = historyOrder.current.filter((id) => id !== pageId);
    setHistoryTick((n) => n + 1);
    setHistoryNotice(notice);
  }, []);

  /**
   * Autosave: a debounce per section, reset by every local edit.
   *
   * Per *section* rather than one for the editor, because two sections have
   * nothing to do with each other and a shared timer would let a flurry of
   * typing in one hold another's save hostage indefinitely.
   */
  const scheduleAutosave = useCallback(
    (sectionId: number) => {
      // Nothing this session may save: no timer to arm.
      if (!EDIT_DOMAINS.some((domain) => allowed(DOMAIN_CAPABILITY[domain]))) return;
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
    [allowed],
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
    const params = new URLSearchParams(
      page.kind !== "page"
        ? { route: page.slug, lang: locale, device }
        : { page: page.slug, lang: locale, device },
    );
    // Only when it changes. Every save that revalidates hands this effect a new
    // `page` object with the same slug, and Next.js turns each `replaceState`
    // into a router action that preempts the server action in flight and forces
    // a refresh of the whole screen — which can lose the layout's own reload and
    // leave the layout actions with nothing to act on.
    if (window.location.search === `?${params}`) return;
    window.history.replaceState(null, "", `?${params}`);
  }, [page, locale, device]);

  const onCanvasState = useCallback((next: CanvasState) => setCanvas(next), []);
  const onStructure = useCallback((next: EditorSectionMeta[]) => setSections(next), []);

  /**
   * A Layers panel has drawn its rows, enabled — the new tree after a redraw,
   * or the same one after a layout step that was refused (the panel says when:
   * only it knows when its rows are on screen). The focus that went with the old
   * rows, or with a disabled button, comes back to the same control — unless
   * something else has taken it since, which was the person's own doing and
   * wins.
   */
  const restoreLayersFocus = useCallback(() => {
    const wanted = layersFocus.current;
    if (!wanted) return;
    layersFocus.current = null;
    const active = document.activeElement;
    if (active && active !== document.body) return;
    layersFocusTarget(document, wanted)?.focus();
  }, []);
  /** One request to the canvas to select `address`, or to clear when it is `null`. */
  const requestSelection = useCallback(
    (address: string | null) =>
      setSelectRequest((current) => ({
        address,
        scrollIntoView: address !== null,
        token: (current?.token ?? 0) + 1,
      })),
    [],
  );

  const onSelection = useCallback(
    (node: EditorNodeMeta | null) => {
      const hold = holding.current;
      if (hold) {
        // The document being replaced and the one arriving both report
        // "nothing selected" before the restore is asked. Neither is an
        // answer, and the held selection stays — with the Inspector, and the
        // box that has the keyboard focus, exactly as they are.
        if (node === null && !hold.asked) return;
        holding.current = null;
        if (node === null) {
          // The answer: nothing in the new document answers to the address.
          // The node the save removed cannot come back, so the nearest thing
          // that still exists — never a stale reference to what has gone.
          restoring.current = null;
          if (hold.fallback !== hold.address) requestSelection(hold.fallback);
        } else if (node.address !== hold.address) {
          // A different node: somebody chose it while the canvas came back.
          // Their choice wins, and nothing is put back over it.
          restoreTo.current = null;
          restoring.current = null;
        }
        selectedRef.current = node;
        setSelected(node);
        return;
      }
      const pending = restoring.current;
      if (pending) {
        restoring.current = null;
        // The canvas's answer to a restore was "nothing here": the node the edit
        // removed — the row that was just deleted — cannot come back, so the
        // nearest thing that still exists, its section.
        if (node === null) requestSelection(pending.fallback);
      }
      selectedRef.current = node;
      setSelected(node);
    },
    [requestSelection],
  );

  /**
   * A new document: everything about the old one goes with it.
   *
   * Everything about the *document*, that is. The edit buffers are not part of
   * it — they are what the person typed, and reloading the frame they are being
   * previewed in is no reason to throw them away.
   *
   * `keep` is what a redraw will put back (`redrawTo`). When that is the node
   * selected now and its section's buffer survives the redraw, the selection is
   * held through it rather than emptied (`holding`), so the Inspector is never
   * unmounted. Anything else — another node, a section whose buffer was just
   * thrown away, a page or language change — starts from nothing, as before.
   */
  const freshCanvas = (keep?: RestoreTarget | null) => {
    // Layers loses its rows until the new document reports in; where the focus
    // was among them is kept for the new tree. A second redraw before that finds
    // no row focused and keeps what the first one took.
    layersFocus.current = layersFocusOf(document.activeElement) ?? layersFocus.current;
    setCanvas(EMPTY_CANVAS);
    setSections([]);
    setEditRequest(null);
    setReplayRequest(null);
    // A restore still waiting on the document being replaced has nobody left
    // to answer it; a new one is asked for once the new document is ready.
    restoring.current = null;
    // Whatever redraw was waiting for a direct edit to end is this one.
    deferredRedraw.current = null;
    const node = selectedRef.current;
    const hold =
      keep && node && node.address === keep.address && buffersRef.current[node.sectionId] !== undefined ? keep : null;
    holding.current = hold ? { ...hold, asked: false } : null;
    if (!hold) {
      selectedRef.current = null;
      setSelected(null);
    }
    setSelectRequest(null);
    setCanvasKey((n) => n + 1);
  };

  /** The selection as it stands, as something a redraw can put back. */
  const keptSelection = (): RestoreTarget | null => {
    const address = selectedRef.current?.address ?? null;
    return address ? { address, fallback: rootOf(address) } : null;
  };

  /**
   * The canvas drawn again, with `wanted` selected on the far side of it.
   *
   * The one way every write that changes what the canvas shows redraws it — an
   * autosave, Undo back to what is stored, a layout step, a component
   * publication, a global change — for a page section and a route region
   * alike, so they cannot differ in what happens to the selection.
   */
  const redrawTo = useCallback((wanted: RestoreTarget | null) => {
    restoreTo.current = wanted;
    freshCanvas(wanted);
    if (wanted) setRestoreToken((n) => n + 1);
  }, []);

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
    // Locks name section ids, and those belong to one page. Carrying them over
    // would be meaningless at best and would silently lock a section of the
    // new page that happens to share an id at worst.
    setLocks([]);
    // A route's regions are the template's: there is no layout draft to read.
    if (page.kind !== "page") return;
    loadPageStructure(page.id).then((next) => {
      if (!cancelled) setStructure(next);
    });
    return () => {
      cancelled = true;
    };
  }, [page]);

  /**
   * Locking, and what it is scoped to.
   *
   * Per page, because an address names a section id and those belong to one
   * page; carrying them across would be meaningless at best. A language or a
   * device switch reloads the canvas but keeps them, because the editor is
   * still looking at the same page and did not ask to unlock anything — the
   * canvas is re-told on every load.
   */
  const toggleLock = useCallback((address: string) => {
    setLocks((current) =>
      current.includes(address) ? current.filter((entry) => entry !== address) : [...current, address],
    );
  }, []);

  /**
   * The values the panel may name a repeatable row from.
   *
   * Only a section that is actually loaded has any — a row in a section nobody
   * has selected yet is named by what the canvas could see on it, and by the
   * neutral word when it could see nothing. The panel never triggers a load to
   * find a label out: that would mean opening a section in Layers quietly
   * fetching every section on the page.
   */
  const valuesOf = useCallback(
    (sectionId: number) => buffersRef.current[sectionId]?.values,
    [],
  );

  /**
   * Somebody chose what to select — from Layers, from the Inspector, by
   * starting a direct edit.
   *
   * Their choice ends any hold, and a restore still waiting for the canvas to
   * be ready is pointed at it instead: otherwise a save that was on its way
   * when they clicked would put back the node they had just moved away from.
   */
  const ask = useCallback(
    (address: string | null) => {
      holding.current = null;
      restoring.current = null;
      if (restoreTo.current) restoreTo.current = address ? { address, fallback: rootOf(address) } : null;
      requestSelection(address);
    },
    [requestSelection],
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
  /**
   * One section, loaded once, whoever asked.
   *
   * Both the selection effect and a direct-edit request need the row, and
   * before this they would each have started their own. The map of in-flight
   * loads is what makes a second asker wait on the first rather than race it,
   * and the buffer is installed exactly once: if one is already there — because
   * somebody has been typing into it — the server's answer does not replace it.
   *
   * A load that fails stays retryable, and a load whose page has moved on by
   * the time it lands installs nothing. No placeholder revision is ever
   * invented, and no buffer is ever built from the canvas.
   */
  const ensureSectionBuffer = useCallback(
    (sectionId: number): Promise<SectionBuffer | null> => {
      const held = buffersRef.current[sectionId];
      if (held) return Promise.resolve(held);
      const already = inflight.current.get(sectionId);
      if (already) return already;

      const pageId = pageRef.current;
      if (pageId === null) return Promise.resolve(null);

      setLoadingId(sectionId);
      setLoadError(null);
      // A route region is read through its route's actions (Batch 21); its
      // editor key says which it is, and the server checks it again.
      const request = isRouteEditorKey(sectionId) ? loadRouteRegion(sectionId, pageId) : loadVisualSection(sectionId, pageId);
      const load = request
        .then((result) => {
          inflight.current.delete(sectionId);
          setLoadingId((current) => (current === sectionId ? null : current));
          if (!result.ok) {
            setLoadError(result.message);
            return null;
          }
          // The editor moved to another page while this was in flight. Its
          // buffers were dropped with it; installing this now would put a
          // stranger's section into the new page's state.
          if (pageRef.current !== pageId) return null;

          let installed: SectionBuffer | null = null;
          writeBuffers((prev) => {
            const existing = prev[sectionId];
            if (existing) {
              installed = existing;
              return prev;
            }
            installed = {
              data: result.section,
              values: result.section.values,
              styles: result.section.styles,
              motion: result.section.motionDocument,
              contentDirty: false,
              styleDirty: false,
              motionDirty: false,
              saving: null,
              status: "idle",
              statusDomain: null,
            };
            return { ...prev, [sectionId]: installed };
          });
          return installed;
        })
        .catch(() => {
          inflight.current.delete(sectionId);
          setLoadingId((current) => (current === sectionId ? null : current));
          setLoadError("The section could not be read. Reload the canvas and try again.");
          return null;
        });

      inflight.current.set(sectionId, load);
      return load;
    },
    [writeBuffers],
  );

  useEffect(() => {
    if (activeId === null || !page) return;
    void ensureSectionBuffer(activeId);
  }, [activeId, page, ensureSectionBuffer]);

  /**
   * A direct-edit session belongs to one page, one language and one canvas
   * document. When any of those changes it is over.
   *
   * Explicit rather than left to the token checks alone: those stop a stale
   * request from *beginning*, and this stops one that already began from
   * carrying on into a document that is no longer the one it was opened
   * against. Nothing here waits on a promise — a background load that lands
   * afterwards finds a token that has moved and returns.
   */
  useEffect(() => {
    editToken.current += 1;
    const session = editSession.current;
    editSession.current = null;
    if (session) setEditRequest({ kind: "cancel", token: session.token });
  }, [page, locale, canvasKey]);

  /**
   * A Replay belongs to one page, one language, one canvas document and one
   * selected node, like a direct-edit session — and it ends with any of them.
   * The canvas stops a Replay itself when its selection moves or its document
   * goes; this is the editor's half, so a result still in the air is not taken
   * for the node that is selected now.
   */
  useEffect(() => {
    replayToken.current += 1;
    const session = replaySession.current;
    replaySession.current = null;
    setReplayStatus(null);
    if (session) setReplayRequest({ kind: "cancel", token: session.token });
  }, [page, locale, canvasKey]);

  const selectedAddress = selected?.address ?? null;
  useEffect(() => {
    const session = replaySession.current;
    if (session && session.address !== selectedAddress) {
      replaySession.current = null;
      setReplayRequest({ kind: "cancel", token: session.token });
    }
    setReplayStatus((current) => (current && current.address !== selectedAddress ? null : current));
  }, [selectedAddress]);

  /**
   * Plays the selected node's motion once on the canvas.
   *
   * The whole of Replay on the editor's side, and what it does not do is the
   * point: it reads the selection and the context, and posts one message. It
   * never touches a buffer, never schedules an autosave, never calls a Server
   * Action — so it cannot make anything dirty, move a revision, write a row,
   * log an activity or leave a draft to publish.
   */
  const requestReplay = useCallback((mode: ReplayMode) => {
    const node = selectedRef.current;
    const pageId = pageRef.current;
    if (!node || pageId === null) return;
    const token = replayToken.current + 1;
    replayToken.current = token;
    replaySession.current = {
      token,
      address: node.address,
      mode,
      pageId,
      locale: localeRef.current,
      canvasKey: canvasKeyRef.current,
    };
    setReplayStatus(null);
    setReplayRequest({ kind: "play", address: node.address, token, mode });
  }, []);

  /** What the canvas said. Anything that no longer belongs to this editor changes nothing. */
  const onReplayResult = useCallback(
    (result: { address: string; token: number; outcome: ReplayOutcome }) => {
      const verdict = acceptReplayResult(
        replaySession.current,
        {
          pageId: pageRef.current,
          locale: localeRef.current,
          canvasKey: canvasKeyRef.current,
          selected: selectedRef.current?.address ?? null,
        },
        result,
      );
      if (!verdict.ok) return;
      if (verdict.ends) replaySession.current = null;
      setReplayStatus({ address: result.address, outcome: verdict.outcome });
    },
    [],
  );

  /**
   * The one way direct editing ever begins — from the canvas or from Layers.
   *
   * The rule it exists to keep: **editing may not begin until the exact server
   * values and revision that will own the edit are in the buffer.** Before this,
   * a double-click made the node editable immediately and the shell dropped
   * whatever was typed if no buffer happened to exist — text on screen that
   * nothing was going to save — and the text it began from was whatever the
   * page had rendered, which for an Arabic node with no translation is the
   * English fallback plus the words of every annotated child inside it.
   *
   * So: select, load, check, read the value out of the row, and only then tell
   * the canvas to begin, handing it the text to begin with. Every step that
   * could have moved on while the load was in flight is re-checked against the
   * token: a newer request, a different page, a different language, a reloaded
   * canvas. A stale one returns without touching anything, and the canvas is
   * told to stop — it never entered edit mode, so there is nothing to undo.
   */
  const requestDirectEdit = useCallback(
    async (address: string) => {
      const parsed = parseAddress(address);
      if (!parsed || !parsed.path.length) return;
      const sectionId = parsed.sectionId;
      const relative = formatNodePath(parsed.path);

      // Supersede whatever was pending or running, and stop the canvas if it
      // is mid-session on something else.
      const token = editToken.current + 1;
      editToken.current = token;
      const previous = editSession.current;
      editSession.current = null;
      if (previous) setEditRequest({ kind: "cancel", token: previous.token });

      /**
       * No content capability, no session (Batch 18). The canvas is never told
       * to begin, so the text never becomes editable: a viewer, a stylist or a
       * motion editor double-clicking a heading gets a selection and nothing
       * more. The server refuses the save regardless — this is what keeps the
       * canvas from *looking* writable to somebody it would refuse.
       */
      if (!allowed("editContent")) return;
      // A locked node is protected from the *pointer*; reaching it deliberately
      // from Layers is still editing, and the canvas refuses the gesture on its
      // own side. Nothing more is needed here.

      // The inspector should be pointed at what is about to be typed into, and
      // this is also what loads the section on the ordinary path. A choice like
      // any other: it ends a hold and outranks a restore still on its way.
      ask(address);

      const pageAtRequest = pageRef.current;
      const localeAtRequest = localeRef.current;
      const canvasAtRequest = canvasKeyRef.current;
      // No page open is not a context a session can be bound to.
      if (pageAtRequest === null) return;

      const buffer = await ensureSectionBuffer(sectionId);

      // Everything that means "this request is no longer the one to honour".
      if (editToken.current !== token) return;
      if (pageRef.current !== pageAtRequest) return;
      if (localeRef.current !== localeAtRequest) return;
      if (canvasKeyRef.current !== canvasAtRequest) return;
      if (!buffer) return; // a failed load leaves the canvas exactly as it was
      // A section that has lost a race is not edited on top of: the existing
      // Reload latest workflow wins, as it does for every other write.
      if (buffer.status === "conflict") return;
      // A route region's record has its own authority (Batch 21): no session
      // begins on text the server would refuse to save.
      if (buffer.data.route && !mayRecord(buffer.data.route)) return;
      if (!directEditAt(buffer.data.blockType, relative)) return;

      /**
       * Linked content is never typed into (Batch 17).
       *
       * A field a reusable component supplies holds, in this section, only a
       * fallback copy — typing into it would change nothing anybody sees, and
       * the component itself is edited in exactly one place, its own editor.
       * So a linked field with no override in this edition does not begin a
       * session at all: the Inspector opens on it and says where the text
       * comes from, with the two honest ways forward — edit the global
       * component, or override it on this page. An overridden field is the
       * page's own, and edits exactly like any other field.
       */
      const decision = directEditDecision(buffer.data.blockType, buffer.values, relative, localeAtRequest);
      if (!decision.ok) {
        setTab("content");
        setReuseNotice({ sectionId, slot: decision.slot, key: decision.key });
        return;
      }

      const text = textAt(buffer.values, buffer.data.blockType, relative, localeAtRequest);
      if (text === null) return;

      /**
       * The session is bound to the context it was opened in.
       *
       * These are the same values the checks above were made against, kept
       * rather than re-read: a session that recorded the context as it is when
       * the *message* arrives would be describing the accident instead of
       * guarding against it.
       */
      editSession.current = {
        token,
        address,
        sectionId,
        pageId: pageAtRequest,
        locale: localeAtRequest,
        canvasKey: canvasAtRequest,
        started: text,
      };
      setEditRequest({ kind: "begin", address, token, text });
    },
    [allowed, ask, ensureSectionBuffer, mayRecord],
  );


  /**
   * A node on the canvas was typed into.
   *
   * This is the whole of direct editing on the editor's side, and what it does
   * *not* do is the point. It does not take the canvas's DOM as the document,
   * it does not store markup, it does not save anything itself and it has no
   * endpoint of its own. It takes the plain string the canvas reported, asks
   * the block registry which field that address names, writes it into the same
   * `SectionBuffer` the Content tab is editing, and lets the ordinary autosave
   * carry it — same debounce, same one-write-at-a-time queue, same validator,
   * same revision guard, same conflict behaviour.
   *
   * So the inspector and the canvas are two interfaces onto one buffer rather
   * than two copies of the content, and a value typed on the canvas is visible
   * in the inspector immediately because there is only one place it lives.
   *
   * The edition being edited is the canvas's own. An Arabic canvas writes the
   * Arabic value and leaves the English one exactly as it was; `applyTextAt`
   * will not copy one into the other, because a translation nobody wrote is
   * worse than an empty field.
   */
  const onCanvasEdit = useCallback(
    (edit: { address: string; token: number; phase: "input" | "commit" | "cancel"; text: string }) => {
      // A message from the canvas is not a permission: without the content
      // capability it changes nothing, however it arrived (Batch 18).
      if (!allowed("editContent")) return;
      /**
       * Does this message still belong to the editor it has arrived in?
       *
       * Asked synchronously, and asked about the whole context — page,
       * language and canvas document as well as the session's token and
       * address. The effect that cancels a session when the context changes is
       * still there and still tells the canvas to stop, but it runs after the
       * render that changed the context, and a message in that window used to
       * pass a token-and-address check and then be written using whatever
       * language the editor had just switched to.
       */
      const verdict = acceptEdit(
        editSession.current,
        { pageId: pageRef.current, locale: localeRef.current, canvasKey: canvasKeyRef.current },
        edit,
      );
      if (!verdict.ok) {
        /**
         * Nothing happens to a message that does not belong here: no write, no
         * dirty flag, no autosave, no error on screen. A stale keystroke is not
         * something an editor did wrong, and telling them about it would be
         * noise about a canvas they have already left.
         *
         * The session is dropped when the context has moved, so a stream of
         * them from a replaced document stops being considered at all.
         */
        if (verdict.reason === "page" || verdict.reason === "locale" || verdict.reason === "canvas") {
          editSession.current = null;
        }
        return;
      }

      if (verdict.ends) editSession.current = null;

      const held = buffersRef.current[verdict.sectionId];
      // Assigned inside the update below; typed wide so the check after it reads it.
      let written = null as Record<string, unknown> | null;
      writeBuffers((prev) => {
        const entry = prev[verdict.sectionId];
        // There is always a buffer by now: the session only exists because one
        // was loaded before editing was allowed to begin.
        if (!entry) return prev;
        if (entry.status === "conflict") return prev;

        const values = applyTextAt(
          entry.values,
          entry.data.blockType,
          verdict.relativePath,
          // The session's language, not the editor's current one.
          verdict.locale,
          verdict.text,
        );
        if (!values) return prev;
        written = values;

        return {
          ...prev,
          [verdict.sectionId]: {
            ...entry,
            values,
            contentDirty: !sameValues(values, entry.data.values),
            status: "idle",
            statusDomain: null,
            message: undefined,
          },
        };
      });

      /**
       * The same buffer the inspector edits, so the same history (Batch 16).
       *
       * A whole direct-edit session is one action: every keystroke grows it
       * while the session lasts — however long the pauses — and committing
       * closes it, so one Undo takes the edit back and the next Undo is
       * something else. Escape puts the text back, which grows the action back
       * into nothing, and an action that changes nothing is not kept. The
       * change is located in the session's own edition, never in whichever
       * language the editor is showing by the time Undo is pressed.
       */
      if (held && written) {
        const changes = diffContent(held.data.blockType, held.values, written);
        if (changes.length) {
          recordChange(
            held.data.pageId,
            { domain: "content", sectionId: verdict.sectionId, blockType: held.data.blockType, changes },
            describeContent(held.data.blockType, changes, written, verdict.locale),
            { held: true },
          );
        }
      }
      if (edit.phase !== "input") closeHistoryGroup();

      /**
       * A cancelled session saves nothing of its own.
       *
       * The section's autosave timer may already be running because of earlier
       * keystrokes, and it is deliberately left alone: it may also be carrying
       * unrelated style or motion work. When it wakes, the restored buffer is
       * no longer content-dirty, so it writes no content and moves no revision.
       *
       * Unless the session outlasted a save (Batch 23: a save no longer ends
       * it): then the server holds what was typed, Escape has put the text
       * back, and the buffer differs from what is stored — so that is saved,
       * or the page would keep the words the editor just took back.
       */
      const restored = buffersRef.current[verdict.sectionId];
      if (edit.phase !== "cancel" || (restored?.contentDirty ?? false)) scheduleAutosave(verdict.sectionId);
      if (verdict.ends) settleDeferredRef.current();
    },
    [allowed, closeHistoryGroup, recordChange, scheduleAutosave, writeBuffers],
  );

  /**
   * One content edit to a section's buffer, recorded in the page's history.
   *
   * `label` names an action the panel took rather than a value somebody typed
   * — linking, overriding or resetting a reusable component (Batch 17) — so
   * Undo says what it would take back. Those changes never group with typing:
   * each is several values at once, or a reference, and `groupOf` keeps both
   * out of any group. `target` is for the one caller that finishes after an
   * await — Save as reusable — by which time another section may be selected:
   * the edit belongs to the section it was made for, not the one on screen.
   */
  const onValues = useCallback(
    (values: Record<string, unknown>, label?: string, target?: number) => {
      const sectionId = target ?? activeId;
      if (sectionId === null || !allowed("editContent")) return;
      const held = buffersRef.current[sectionId];
      if (held) {
        // Recorded before the write, from the buffer as it stands: the action is
        // the difference between what the section held and what it will hold.
        const changes = diffContent(held.data.blockType, held.values, values);
        if (changes.length) {
          recordChange(
            held.data.pageId,
            { domain: "content", sectionId, blockType: held.data.blockType, changes },
            label ?? describeContent(held.data.blockType, changes, values, locale),
          );
        }
      }
      if (label) setReuseMessage(null);
      writeBuffers((prev) => {
        const entry = prev[sectionId];
        if (!entry) return prev;
        return {
          ...prev,
          [sectionId]: {
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
      scheduleAutosave(sectionId);
    },
    [activeId, allowed, locale, recordChange, scheduleAutosave, writeBuffers],
  );

  const onStyles = useCallback(
    (styles: StyleDocument) => {
      if (activeId === null || !allowed("editStyle")) return;
      const held = buffersRef.current[activeId];
      // The locked controls cannot send one, and the server would refuse it:
      // an advanced token moved without the capability is not taken in.
      if (held && !allowed("editAdvancedStyle") && advancedStylesDiffer(held.styles, styles)) return;
      if (held) {
        recordChange(
          held.data.pageId,
          { domain: "style", sectionId: activeId, blockType: held.data.blockType, before: held.styles, after: styles },
          describeStyle(held.data.blockType, held.styles, styles, held.values, locale),
        );
      }
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
    [activeId, allowed, locale, recordChange, scheduleAutosave, writeBuffers],
  );

  /**
   * The section's motion document, held in the buffer until it is saved.
   *
   * Not sent on change. A menu of entrances and a delay slider are exactly the
   * controls an editor sweeps through, and saving each step would write a
   * draft, bump the revision and reload the canvas every time — with no way
   * back to where they started that did not go through the server. So it is
   * dirty state like any other: the autosave debounce collects it, and the same
   * Save now and Discard changes sit beside it. Dirtiness is a comparison by
   * meaning (`sameValues`), so setting a value and clearing it again is clean.
   */
  const onMotion = useCallback(
    (motion: MotionDocument) => {
      if (activeId === null || !allowed("editMotion")) return;
      const held = buffersRef.current[activeId];
      if (held) {
        recordChange(
          held.data.pageId,
          { domain: "motion", sectionId: activeId, blockType: held.data.blockType, before: held.motion, after: motion },
          describeMotion(held.data.blockType, held.motion, motion, held.values, locale),
        );
      }
      writeBuffers((prev) => {
        const entry = prev[activeId];
        if (!entry) return prev;
        return {
          ...prev,
          [activeId]: {
            ...entry,
            motion,
            motionDirty: !sameValues(motion, entry.data.motionDocument),
            status: entry.status === "conflict" ? "conflict" : "idle",
            statusDomain: entry.status === "conflict" ? entry.statusDomain : null,
            message: entry.status === "conflict" ? entry.message : undefined,
          },
        };
      });
      scheduleAutosave(activeId);
    },
    [activeId, allowed, locale, recordChange, scheduleAutosave, writeBuffers],
  );

  /**
   * One domain of one section, set to a value Undo or Redo chose (Batch 16).
   *
   * The same write an edit makes — the buffer, the dirty flag measured against
   * what the server last said — so a section undone all the way back to its
   * saved state is clean and saves nothing, and anything else is saved by the
   * ordinary autosave like any other edit. A conflict is kept, never cleared:
   * the section really did change elsewhere.
   */
  const setDomainValue = useCallback(
    (sectionId: number, domain: EditDomain, value: unknown) => {
      writeBuffers((prev) => {
        const entry = prev[sectionId];
        if (!entry) return prev;
        return { ...prev, [sectionId]: withDomainValue(entry, domain, value) };
      });
    },
    [writeBuffers],
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
      /**
       * Discarding unsaved work in one domain is itself an action (Batch 16),
       * so it is recorded like one: Undo brings the work back, Redo discards it
       * again. It is not Discard *all saved changes* — that is a page act on
       * the server, and it resets the history instead.
       */
      const held = buffersRef.current[activeId];
      if (held) {
        const { blockType, pageId } = held.data;
        if (domain === "content") {
          const changes = diffContent(blockType, held.values, held.data.values);
          if (changes.length) {
            recordChange(pageId, { domain: "content", sectionId: activeId, blockType, changes }, "Discard unsaved content changes");
          }
        } else if (domain === "style") {
          recordChange(
            pageId,
            { domain: "style", sectionId: activeId, blockType, before: held.styles, after: held.data.styles },
            "Discard unsaved style changes",
          );
        } else {
          recordChange(
            pageId,
            { domain: "motion", sectionId: activeId, blockType, before: held.motion, after: held.data.motionDocument },
            "Discard unsaved motion changes",
          );
        }
      }
      writeBuffers((prev) => {
        const entry = prev[activeId];
        if (!entry) return prev;
        const reset =
          domain === "content"
            ? { values: entry.data.values, contentDirty: false }
            : domain === "style"
              ? { styles: entry.data.styles, styleDirty: false }
              : { motion: entry.data.motionDocument, motionDirty: false };
        // Discarding the work a refusal was about takes the refusal with it.
        const denied = { ...entry.denied };
        delete denied[domain];
        return {
          ...prev,
          [activeId]: { ...entry, ...reset, denied, status: "idle", statusDomain: null, message: undefined },
        };
      });
    },
    [activeId, recordChange, writeBuffers],
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
    /**
     * The section's history was built against the version that lost, so none
     * of it can be replayed over the one that won without merge rules nobody
     * has written (Batch 16). The page's whole history goes — the simpler rule
     * that is safe in every case — and the editor is told why.
     */
    const held = buffersRef.current[activeId];
    if (held) resetHistory(held.data.pageId, HISTORY_RESET.section);
    writeBuffers((prev) => {
      const entry = prev[activeId];
      if (!entry?.latest) return prev;
      return {
        ...prev,
        [activeId]: {
          data: entry.latest,
          values: entry.latest.values,
          styles: entry.latest.styles,
          motion: entry.latest.motionDocument,
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
  }, [activeId, resetHistory, writeBuffers]);

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
    async (sectionId: number, domain: EditDomain): Promise<"ok" | "conflict" | "error" | "denied"> => {
      const entry = buffersRef.current[sectionId];
      if (!entry || entry.saving !== null) return "error";
      if (!dirtyOf(entry)[domain]) return "ok";
      // Not this session's to save any more (Batch 18): kept, never sent. A
      // route region's content may be order and visibility alone, which is
      // layout — the server decides field by field (Batch 21).
      const permitted =
        domain === "content" && entry.data.route
          ? allowed("editContent") || allowed("editStructure")
          : allowed(DOMAIN_CAPABILITY[domain]);
      if (!permitted) return "denied";
      const routeRegion = isRouteEditorKey(sectionId);

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
      form.set(domain === "content" ? "values" : domain === "style" ? "styles" : "motionDocument", sent);
      // What `sent` derives from, so a route region's save writes only what this
      // editor changed (Batch 23): its record can change under it, on the
      // Services screen, while the buffer is open.
      const sentBase = entry.contentBase ?? entry.data.values;
      if (domain === "content" && routeRegion) form.set("baseValues", canonical(sentBase));

      const settle = (patch: Partial<SectionBuffer>) =>
        writeBuffers((prev) => {
          const live = prev[sectionId];
          if (!live) return prev;
          return { ...prev, [sectionId]: { ...live, saving: null, statusDomain: domain, ...patch } };
        });
      /**
       * A refusal on the grounds of permission (Batch 18): the work stays in
       * the buffer, unsaved and marked with what the server said, and the
       * capability stops being offered. The queue then goes on to the section's
       * other domains — a colour must not wait on a sentence the role may no
       * longer save.
       */
      const refused = (message: string): "denied" => {
        writeBuffers((prev) => {
          const live = prev[sectionId];
          if (!live) return prev;
          return {
            ...prev,
            [sectionId]: {
              ...live,
              saving: null,
              status: "error",
              statusDomain: domain,
              message,
              denied: { ...live.denied, [domain]: message },
            },
          };
        });
        noteRefusal(message);
        return "denied";
      };

      let accepted: {
        revision: number;
        section?: VisualSectionData;
        styles?: StyleDocument;
        motion?: { preset: MotionPreset; document: MotionDocument | null; legacy: MotionPreset };
      };
      try {
        if (domain === "content") {
          const answer = await (routeRegion ? saveRouteRegionDraft : saveVisualSectionDraft)(form);
          if (!answer.ok) {
            if (answer.reason === "conflict") {
              settle({ status: "conflict", message: answer.message, latest: answer.section });
              return "conflict";
            }
            if (answer.reason === "denied") return refused(answer.message);
            settle({ status: "error", message: answer.message });
            return "error";
          }
          accepted = { revision: answer.section.revision, section: answer.section };
          // A save that linked, unlinked or re-overrode a reusable component
          // changes "Used on" for it: the counts are read again (Batch 17).
          if (
            canonical(readReuse(entry.data.values, entry.data.blockType)) !==
            canonical(readReuse(answer.section.values, entry.data.blockType))
          ) {
            refreshCatalogRef.current();
          }
        } else if (domain === "style") {
          const answer = await (routeRegion ? saveRouteRegionStyles : saveVisualSectionStyles)(form);
          if (!answer.ok) {
            if (answer.reason === "conflict") {
              settle({ status: "conflict", message: answer.message, latest: answer.section });
              return "conflict";
            }
            if (answer.reason === "denied") return refused(answer.message);
            settle({ status: "error", message: answer.message });
            return "error";
          }
          accepted = { revision: answer.revision, styles: answer.styles };
        } else {
          const answer = await (routeRegion ? saveRouteRegionMotion : saveVisualSectionMotion)(form);
          if (!answer.ok) {
            if (answer.reason === "conflict") {
              settle({ status: "conflict", message: answer.message, latest: answer.section });
              return "conflict";
            }
            if (answer.reason === "denied") return refused(answer.message);
            settle({ status: "error", message: answer.message });
            return "error";
          }
          accepted = {
            revision: answer.revision,
            motion: { preset: answer.motion, document: answer.motionDocument, legacy: answer.legacyEntrance },
          };
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
              motionDocument: live.data.motionDocument,
              legacyEntrance: live.data.legacyEntrance,
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
                motion: accepted.motion?.preset ?? live.data.motion,
                // The server's rebuilt document — canonical, and cut down to
                // what this block can carry — is the new baseline.
                motionDocument: accepted.motion?.document ?? live.data.motionDocument,
                legacyEntrance: accepted.motion?.legacy ?? live.data.legacyEntrance,
                hasMotionDraft: true,
              };

        const domainState =
          domain === "content"
            ? {
                values: movedOn ? live.values : data.values,
                contentDirty: movedOn,
                // Typing went on during the save: the local values still derive
                // from the base that was sent, not from this answer.
                contentBase: movedOn ? sentBase : undefined,
              }
            : domain === "style"
              ? { styles: movedOn ? live.styles : data.styles, styleDirty: movedOn }
              : { motion: movedOn ? live.motion : data.motionDocument, motionDirty: movedOn };
        // A domain that saved is no longer refused.
        const denied = { ...live.denied };
        delete denied[domain];

        return {
          ...prev,
          [sectionId]: {
            ...live,
            data,
            ...domainState,
            denied,
            saving: null,
            status: movedOn ? ("idle" as const) : ("saved" as const),
            statusDomain: domain,
            message: undefined,
          },
        };
      });
      return "ok";
    },
    [allowed, csrf, noteRefusal, writeBuffers],
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
      if (draining.current.has(sectionId)) return;
      draining.current.add(sectionId);
      let wrote = false;
      // Domains refused in this pass: skipped, so the others still save (Batch 18).
      const skipped = new Set<EditDomain>();
      try {
        for (;;) {
          const entry = buffersRef.current[sectionId];
          if (!entry || entry.saving !== null) break;
          // A section already in conflict is not autosaved again at all.
          if (entry.status === "conflict") break;
          const dirty = dirtyOf(entry);
          const domain = EDIT_DOMAINS.find((key) => dirty[key] && !skipped.has(key));
          if (!domain) break;
          const result = await runSave(sectionId, domain);
          if (result === "denied") {
            skipped.add(domain);
            continue;
          }
          if (result !== "ok") {
            // The section moved elsewhere. Its history was built against the
            // version that lost, and nothing in it may be replayed over the
            // one that won (Batch 16).
            if (result === "conflict") resetHistory(entry.data.pageId, HISTORY_RESET.section);
            break;
          }
          wrote = true;
        }
      } finally {
        draining.current.delete(sectionId);
      }

      if (!wrote) return;
      if (isRouteEditorKey(sectionId)) refreshPageStateRef.current();
      // Only the page being looked at: a debounce that fired for a section on
      // another page has nothing to say about this canvas.
      if (buffersRef.current[sectionId]?.data.pageId !== pageRef.current) return;
      // A direct edit under way on this canvas would be ended by a new
      // document, and what is typed next lost with it. The save has landed;
      // only the redraw waits for the session to end (Batch 23).
      if (editSession.current && editSession.current.canvasKey === canvasKeyRef.current) {
        deferredRedraw.current = sectionId;
        return;
      }
      redrawTo(keptSelection());
    },
    [redrawTo, resetHistory, runSave],
  );

  drainRef.current = (sectionId: number) => void drainSection(sectionId);

  /* ------------------------------------------------------------------ */
  /* Reusable components (Batch 17)                                      */
  /* ------------------------------------------------------------------ */

  const refreshCatalog = useCallback(async () => {
    const next = await loadReusableCatalog();
    if (next) setCatalog(next);
  }, []);
  refreshCatalogRef.current = () => void refreshCatalog();
  useEffect(() => {
    void refreshCatalog();
  }, [refreshCatalog]);

  // A notice about one section's linked text says nothing about another's.
  useEffect(() => {
    setReuseNotice((current) => (current && current.sectionId !== activeId ? null : current));
    setReuseMessage(null);
  }, [activeId]);

  /**
   * Waits until a section has nothing unsaved and nothing in flight — for the
   * two operations the server performs on the section as it is *stored*,
   * detaching and saving as reusable. Either one reading a row the browser is
   * ahead of would act on something other than what the editor sees.
   */
  const settleSection = useCallback(
    async (sectionId: number): Promise<SectionBuffer | null> => {
      const pending = autosaveTimers.current.get(sectionId);
      if (pending) {
        window.clearTimeout(pending);
        autosaveTimers.current.delete(sectionId);
      }
      await drainSection(sectionId);
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const entry = buffersRef.current[sectionId];
        if (!entry) return null;
        if (!draining.current.has(sectionId) && entry.saving === null) return entry;
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
      return buffersRef.current[sectionId] ?? null;
    },
    [drainSection],
  );

  /** The canvas drawn again with the selection kept — after a write it cannot see. */
  const redrawKeeping = useCallback(() => redrawTo(keptSelection()), [redrawTo]);

  /**
   * A direct edit has ended: the redraw its saves put off is due now — unless
   * a write is still to come, which redraws when it lands as every save does.
   * A debounce armed over a buffer with nothing unsaved is not one: it wakes,
   * finds nothing to write and redraws nothing.
   */
  const settleDeferredRedraw = useCallback(() => {
    if (deferredRedraw.current === null || editSession.current) return;
    const writeToCome = Object.entries(buffersRef.current).some(
      ([id, entry]) =>
        entry.data.pageId === pageRef.current &&
        (isDirty(entry) || entry.saving !== null || draining.current.has(Number(id))),
    );
    if (writeToCome) return;
    redrawKeeping();
  }, [redrawKeeping]);
  settleDeferredRef.current = settleDeferredRedraw;

  /**
   * Detaches one instance: resolved by the server from the component's current
   * published content, entered into this page's history as one action — so
   * Undo puts the link back, and the ordinary save carries it — and the canvas
   * redrawn. The component is not touched.
   */
  const detachInstance = useCallback(
    async (slot: string, componentId: number, version: number) => {
      // Page content plus seeing the definition it copies (Batch 18).
      if (activeId === null || !allowed("editContent") || !allowed("viewComponents")) return;
      const sectionId = activeId;
      setReuseBusy(true);
      setReuseMessage(null);
      try {
        const entry = await settleSection(sectionId);
        if (!entry || isDirty(entry) || entry.status === "conflict") {
          setReuseMessage({ ok: false, text: "Save or reload this section first — detaching works on what is saved." });
          return;
        }
        const form = new FormData();
        form.set("_csrf", csrf);
        form.set("sectionId", String(sectionId));
        form.set("pageId", String(entry.data.pageId));
        form.set("expectedRevision", String(entry.data.revision));
        form.set("slot", slot);
        form.set("expectedComponentVersion", String(version));
        const answer = await detachVisualInstance(form);
        if (!answer.ok) {
          if (answer.reason === "conflict") {
            writeBuffers((prev) => {
              const live = prev[sectionId];
              if (!live) return prev;
              return {
                ...prev,
                [sectionId]: { ...live, status: "conflict", statusDomain: "content", message: answer.message, latest: answer.section },
              };
            });
            resetHistory(entry.data.pageId, HISTORY_RESET.section);
          }
          if (answer.reason === "component_conflict") {
            await refreshCatalog();
            redrawKeeping();
          }
          if (answer.reason === "denied") noteRefusal(answer.message);
          setReuseMessage({ ok: false, text: answer.message });
          return;
        }
        const name = catalog?.find((candidate) => candidate.id === componentId)?.name;
        const label = slotDef(entry.data.blockType, slot)?.label.toLowerCase() ?? "section";
        const changes = diffContent(entry.data.blockType, entry.values, answer.section.values);
        if (changes.length) {
          recordChange(
            entry.data.pageId,
            { domain: "content", sectionId, blockType: entry.data.blockType, changes },
            `Detach ${label} from “${name ?? "reusable component"}”`,
          );
        }
        writeBuffers((prev) => {
          const live = prev[sectionId];
          if (!live) return prev;
          return {
            ...prev,
            [sectionId]: {
              ...live,
              data: {
                ...answer.section,
                styles: live.data.styles,
                hasStyleDraft: live.data.hasStyleDraft,
                motion: live.data.motion,
                motionDocument: live.data.motionDocument,
                legacyEntrance: live.data.legacyEntrance,
                hasMotionDraft: live.data.hasMotionDraft,
              },
              values: answer.section.values,
              contentDirty: false,
              status: "saved",
              statusDomain: "content",
              message: undefined,
            },
          };
        });
        setReuseMessage({
          ok: true,
          text: `Detached. This page keeps the content as its own; “${name ?? "the component"}” is unchanged.`,
        });
        void refreshCatalog();
        redrawKeeping();
      } finally {
        setReuseBusy(false);
      }
    },
    [activeId, allowed, catalog, csrf, noteRefusal, recordChange, redrawKeeping, refreshCatalog, resetHistory, settleSection, writeBuffers],
  );

  /**
   * "Save as reusable CTA / component": the server makes the component from
   * the section as stored; with `publish`, its first version is published —
   * nothing links to it yet, so no visitor sees any change — and this slot is
   * then linked to it as an ordinary content edit, which Undo can take back.
   */
  const saveAsReusable = useCallback(
    async (slot: string, name: string, publish: boolean) => {
      /**
       * Every effect of what was chosen (Batch 18): a draft needs reading the
       * section and editing components; "Create, publish and link" also needs
       * publishing components and editing page content, for the link. The
       * server asks for exactly the same before it creates anything.
       */
      if (activeId === null || !allowed("viewPages") || !allowed("editComponents")) return;
      if (publish && (!allowed("publishComponents") || !allowed("editContent"))) return;
      const sectionId = activeId;
      setReuseBusy(true);
      setReuseMessage(null);
      try {
        const entry = await settleSection(sectionId);
        if (!entry || isDirty(entry) || entry.status === "conflict") {
          setReuseMessage({ ok: false, text: "Save or reload this section first — the component is made from what is saved." });
          return;
        }
        const form = new FormData();
        form.set("_csrf", csrf);
        form.set("sectionId", String(sectionId));
        form.set("pageId", String(entry.data.pageId));
        form.set("slot", slot);
        form.set("name", name);
        form.set("publish", publish ? "1" : "0");
        const answer = await createReusableFromSection(form);
        if (!answer.ok || !answer.component) {
          if (!answer.ok && answer.reason === "denied") noteRefusal(answer.message);
          setReuseMessage({ ok: false, text: answer.message });
          return;
        }
        const component = answer.component;
        await refreshCatalog();
        const noun = kindNoun(component.kind);
        if (publish && component.published) {
          const current = buffersRef.current[sectionId];
          const next = current
            ? linkSlot(current.data.blockType, current.values, slot, {
                id: component.id,
                kind: component.kind,
                values: component.published,
              })
            : null;
          const label = slotDef(entry.data.blockType, slot)?.label.toLowerCase() ?? "section";
          if (next) onValues(next, `Link ${label} to the new reusable ${noun} “${component.name}”`, sectionId);
          setReuseMessage({
            ok: true,
            text: `“${component.name}” was created and published, and this is linked to it. Nothing on the site changed.`,
          });
        } else {
          setReuseMessage({
            ok: true,
            text: `“${component.name}” was created as a draft. Publish it from its editor before linking anything to it.`,
          });
        }
      } finally {
        setReuseBusy(false);
      }
    },
    [activeId, allowed, csrf, noteRefusal, onValues, refreshCatalog, settleSection],
  );

  /**
   * What a section links to, for the Layers badge: the buffer when this editor
   * has the section loaded — it is what the canvas will show once saved — and
   * the server's layout otherwise.
   */
  const reuseOf = useCallback(
    (sectionId: number): { slot: string; name: string; fields: string[] }[] => {
      const held = buffersRef.current[sectionId];
      const row = structure?.sections.find((entry) => entry.sectionId === sectionId);
      const blockType = held?.data.blockType ?? row?.blockType;
      if (!blockType) return [];
      const links = held
        ? Object.entries(readReuse(held.values, blockType)).map(([slot, ref]) => ({ slot, componentId: ref.c }))
        : (row?.reuse ?? []);
      return links.map((link) => ({
        slot: link.slot,
        name: catalog?.find((entry) => entry.id === link.componentId)?.name ?? "reusable component",
        fields: slotDef(blockType, link.slot)?.fields.map((field) => field.name) ?? [],
      }));
    },
    // `buffers` so the badge follows a link made in this session before it saves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [buffers, catalog, structure],
  );

  /** What the reusable-component panel may offer (Batch 18) — each control its own capability. */
  const reuseAccess = useMemo(() => {
    const has = (capability: Capability) => can[capability] && !revoked.has(capability);
    return {
      typeOverride: has("editContent"),
      instances: has("editContent") && has("viewComponents"),
      saveDraft: has("viewPages") && has("editComponents"),
      savePublished: has("viewPages") && has("editContent") && has("editComponents") && has("publishComponents"),
      open: has("viewComponents"),
    };
  }, [can, revoked]);
  const reuseControls: ReuseControls = useMemo(
    () => ({
      access: reuseAccess,
      catalog,
      notice: reuseNotice,
      busy: reuseBusy,
      message: reuseMessage,
      onInstance: (values, label) => onValues(values, label),
      onDetach: (slot, componentId, version) => void detachInstance(slot, componentId, version),
      onSaveAs: (slot, name, publish) => void saveAsReusable(slot, name, publish),
      onOpen: (id, focus) => setComponentDrawer({ id, focus }),
      onDismissNotice: () => setReuseNotice(null),
    }),
    [catalog, detachInstance, onValues, reuseAccess, reuseBusy, reuseMessage, reuseNotice, saveAsReusable],
  );

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
      /**
       * What to record in the page's history, or `null` for a step that is
       * itself an Undo or a Redo — those move through the history rather than
       * adding to it (Batch 16).
       */
      history: { op: StructureOp; sectionId: number | null; visible?: boolean } | null,
    ): Promise<VisualStructureResult | null> => {
      if (!allowed("editStructure") || !page || !structure || structureBusy) return null;
      // The layout's buttons are disabled while the write is on its way, and a
      // disabled button loses the focus at once — before the redraw could see
      // it. Where it was is taken now, for the tree the redraw brings back.
      layersFocus.current = layersFocusOf(document.activeElement) ?? layersFocus.current;
      setStructureBusy(true);
      setStructureFailure(null);
      closeHistoryGroup();

      const before = structure.structure;
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
        // A layout that changed elsewhere invalidates every layout action in
        // the history, and the content ones are no safer for sitting beside
        // them: the page's history goes, and the editor is told why.
        if (result.reason === "conflict") resetHistory(page.id, HISTORY_RESET.layout);
        if (result.reason === "denied") noteRefusal(result.message);
        return result;
      }
      if (result.structure) setStructure(result.structure);
      // Adding, duplicating, removing, restoring and discarding sections all
      // change "Used on" for any reusable component they link to (Batch 17).
      refreshCatalogRef.current();

      if (history && result.structure) {
        const sectionId =
          history.op === "add" || history.op === "duplicate" ? (result.sectionId ?? null) : history.sectionId;
        const blockType =
          sectionId === null
            ? null
            : (result.structure.sections.find((row) => row.sectionId === sectionId)?.blockType ?? null);
        recordChange(
          page.id,
          { domain: "structure", op: history.op, sectionId, before, after: result.structure.structure },
          describeStructure(history.op, blockType, history.visible),
        );
      }

      // Where the selection goes, by section id — the one thing that survives a
      // document being rebuilt.
      const wanted =
        select === "clear"
          ? null
          : select === "new" && result.sectionId
            ? `section:${result.sectionId}`
            : previous;
      redrawTo(wanted ? { address: wanted, fallback: rootOf(wanted) } : null);
      return result;
    },
    [allowed, closeHistoryGroup, csrf, noteRefusal, page, recordChange, redrawTo, resetHistory, structure, structureBusy],
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
    // The layout that won is not the one this history describes.
    resetHistory(page.id, HISTORY_RESET.layout);

    // Keep the selection only if the section is still in the layout that won.
    const selected = selectedRef.current;
    const survives =
      selected && latest.structure.sections.some((entry) => entry.sectionId === selected.sectionId);
    redrawTo(survives ? keptSelection() : null);
  }, [page, redrawTo, resetHistory, structureBusy]);

  const ops: StructuralOps = useMemo(
    () => ({
      onAdd: (blockType, afterSectionId, componentId) =>
        void runStructural(
          addPageSection,
          (form) => {
            form.set("blockType", blockType);
            if (afterSectionId) form.set("afterSectionId", String(afterSectionId));
            if (componentId) form.set("componentId", String(componentId));
          },
          "new",
          { op: "add", sectionId: null },
        ),
      onDuplicate: (sectionId) =>
        void runStructural(
          duplicatePageSection,
          (form) => form.set("sectionId", String(sectionId)),
          "new",
          { op: "duplicate", sectionId: null },
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
          { op: "reorder", sectionId },
        );
      },
      onReorder: (order) =>
        void runStructural(
          reorderPageStructure,
          (form) => form.set("order", JSON.stringify(order)),
          "keep",
          { op: "reorder", sectionId: null },
        ),
      onVisibility: (sectionId, visible) =>
        void runStructural(
          setPageSectionVisibility,
          (form) => {
            form.set("sectionId", String(sectionId));
            form.set("visible", visible ? "true" : "false");
          },
          "keep",
          { op: "visibility", sectionId, visible },
        ),
      onRemove: (sectionId) =>
        void runStructural(
          removePageSection,
          (form) => form.set("sectionId", String(sectionId)),
          // A section that is no longer rendered cannot stay selected, and the
          // inspector describing something the canvas is not showing is worse
          // than an empty inspector.
          selectedRef.current?.sectionId === sectionId ? "clear" : "keep",
          { op: "remove", sectionId },
        ),
      onRestore: (sectionId) =>
        void runStructural(
          restorePageSection,
          (form) => form.set("sectionId", String(sectionId)),
          "new",
          { op: "restore", sectionId },
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
        // Deleting the new sections is not something an Undo could take back —
        // the rows are gone — so the history goes with them (Batch 16).
        void runStructural(discardPageLayout, () => undefined, "clear", null).then((result) => {
          if (result?.ok && page) {
            resetHistory(page.id, "Undo history was cleared because the layout changes were discarded.");
          }
        });
      },
    }),
    [dirtyIds, page, resetHistory, runStructural, sections, structure],
  );

  /* ------------------------------------------------------------------ */
  /* Undo and Redo: taking an action back                                */
  /* ------------------------------------------------------------------ */

  /** One layout step, run through the same structural request as the action it reverses. */
  const runLayoutStep = useCallback(
    (step: StructureStep) => {
      switch (step.action) {
        case "reorder":
          return runStructural(
            reorderPageStructure,
            (form) => form.set("order", JSON.stringify(step.order)),
            "keep",
            null,
          );
        case "visibility":
          return runStructural(
            setPageSectionVisibility,
            (form) => {
              form.set("sectionId", String(step.sectionId));
              form.set("visible", step.visible ? "true" : "false");
            },
            "keep",
            null,
          );
        case "remove":
          return runStructural(
            removePageSection,
            (form) => form.set("sectionId", String(step.sectionId)),
            selectedRef.current?.sectionId === step.sectionId ? "clear" : "keep",
            null,
          );
        case "restore":
          return runStructural(
            restorePageSection,
            (form) => {
              form.set("sectionId", String(step.sectionId));
              form.set("placement", "1");
              form.set("beforeSectionId", step.beforeSectionId === null ? "end" : String(step.beforeSectionId));
              form.set("visible", step.visible ? "true" : "false");
            },
            "keep",
            null,
          );
      }
    },
    [runStructural],
  );

  /**
   * Undo or Redo — the one way either happens, from the toolbar, the keyboard
   * or a key pressed on the canvas.
   *
   * **Content, style and motion** go back into the section's buffer, and the
   * ordinary autosave takes it from there: same debounce, same queue, same
   * guard. Nothing is un-saved. If the later state had already autosaved, the
   * earlier one is simply the new state of the draft and is saved on top of it,
   * a revision later — which is what lets autosaved work be undone at all.
   *
   * **Layout** runs the structural operation that reverses the action, through
   * the same request and the same page-revision guard as every layout change,
   * and only if the layout on screen is exactly the one the action left behind.
   *
   * What stops it, and why: a direct edit still being typed (Undo belongs to
   * the text field until it is committed); a layout or page request already on
   * its way; and a history that no longer describes the page — a section that
   * lost a race, a layout that is not the recorded one — which is thrown away
   * rather than replayed over somebody else's work.
   */
  const stepHistory = useCallback(
    async (direction: "undo" | "redo") => {
      if (!page || historyBusy || structureBusy || pageBusy) return;
      if (editSession.current) {
        setHistoryNotice("Finish typing on the canvas first — press Enter — then Undo takes the whole edit back.");
        return;
      }
      const pageId = page.id;
      const start = closeGroup(historyOf(pageId));
      const taken = direction === "undo" ? takeUndo(start) : takeRedo(start);
      if (!taken) return;
      const { entry } = taken;
      const change = entry.change;

      /**
       * Undo is not a way round a permission (Batch 18).
       *
       * Each step is replayed only if this session may make that change *now*
       * — the step's own domain, plus advanced styling for a style step that
       * moves an advanced token and component viewing for a content step that
       * links or unlinks one. A step that is not allowed is not taken: it stays
       * exactly where it is in the history, nothing is changed, and the toolbar
       * says why. The server checks the same again when the replay saves, so a
       * permission removed a moment ago is refused there too.
       */
      const refuse = (capability: Capability) => {
        setHistoryNotice(
          `${direction === "undo" ? "Undo" : "Redo"} cannot take this step: your role does not allow ` +
            `${CAPABILITY_WORDS[capability]}. It stays in the history, and nothing was changed.`,
        );
      };

      if (change.domain === "structure") {
        if (!allowed("editStructure")) {
          refuse("editStructure");
          return;
        }
        if (!structure) return;
        const step = structureStep(change, direction, structure.structure);
        if (!step) {
          resetHistory(pageId, HISTORY_RESET.layout);
          return;
        }
        setHistoryBusy(true);
        const result = await runLayoutStep(step);
        setHistoryBusy(false);
        // Not started — another request was on its way. Nothing moved.
        if (!result) return;
        if (!result.ok) {
          // A conflict has already reset the history, with its own reason.
          if (result.reason !== "conflict") resetHistory(pageId, HISTORY_RESET.failed);
          return;
        }
        // Moved relative to the history as it is *now*: anything recorded
        // while the request was in flight means the two no longer line up, and
        // a history that cannot say what it holds is not kept.
        const now = closeGroup(historyOf(pageId));
        const again = direction === "undo" ? takeUndo(now) : takeRedo(now);
        if (!again || again.entry.id !== entry.id) {
          resetHistory(pageId, HISTORY_RESET.failed);
          return;
        }
        writeHistory(pageId, again.history);
        setHistoryNotice(null);
        return;
      }

      const buffer = buffersRef.current[change.sectionId];
      if (!buffer || buffer.status === "conflict") {
        resetHistory(pageId, HISTORY_RESET.section);
        return;
      }
      if (change.domain === "content") {
        // Order and visibility on a dynamic route are layout, not words (Batch 21):
        // a step made only of them asks for the structure capability instead.
        const layoutOnly =
          Boolean(buffer.data.route) &&
          change.changes.every((item) => item.path.field === ORDER_KEY || ROUTE_STRUCTURAL_FIELDS.has(item.path.field));
        if (layoutOnly) {
          if (!allowed("editStructure")) {
            refuse("editStructure");
            return;
          }
        } else if (!allowed("editContent")) {
          refuse("editContent");
          return;
        }
        const values = applyContent(buffer.values, change.changes, direction);
        if (!values) {
          resetHistory(pageId, HISTORY_RESET.section);
          return;
        }
        const blockType = buffer.data.blockType;
        if (!sameReuse(readReuse(buffer.values, blockType), readReuse(values, blockType)) && !allowed("viewComponents")) {
          refuse("viewComponents");
          return;
        }
        setDomainValue(change.sectionId, "content", values);
      } else {
        const capability = DOMAIN_CAPABILITY[change.domain];
        if (!allowed(capability)) {
          refuse(capability);
          return;
        }
        const target = direction === "undo" ? change.before : change.after;
        if (change.domain === "style" && !allowed("editAdvancedStyle") && advancedStylesDiffer(buffer.styles, target)) {
          refuse("editAdvancedStyle");
          return;
        }
        setDomainValue(change.sectionId, change.domain, target);
      }
      writeHistory(pageId, taken.history);
      setHistoryNotice(null);
      scheduleAutosave(change.sectionId);

      /**
       * Back at exactly what the server holds, there is nothing to save — and
       * so nothing that would reload the canvas, which may still be showing
       * text typed straight onto it and never saved. Redraw it from the server
       * now, the way a save would have, so it shows what the section holds.
       * Anything still dirty is left to the autosave, which reloads it anyway.
       */
      const after = buffersRef.current[change.sectionId];
      if (after && !isDirty(after) && after.data.pageId === pageRef.current) redrawTo(keptSelection());
    },
    [
      allowed,
      historyBusy,
      historyOf,
      page,
      pageBusy,
      redrawTo,
      resetHistory,
      runLayoutStep,
      scheduleAutosave,
      setDomainValue,
      structure,
      structureBusy,
      writeHistory,
    ],
  );

  /** The latest Undo and Redo, reachable from listeners attached once. */
  const undoRef = useRef<() => void>(() => {});
  const redoRef = useRef<() => void>(() => {});
  undoRef.current = () => void stepHistory("undo");
  redoRef.current = () => void stepHistory("redo");

  /** Undo or Redo pressed on the canvas, forwarded by the bridge. */
  const onShortcut = useCallback(
    (command: ShortcutCommand) => (command === "undo" ? undoRef.current() : redoRef.current()),
    [],
  );

  /**
   * The keyboard, and the two gestures that end an action.
   *
   * Ctrl/⌘+Z and Ctrl/⌘+Shift+Z (and Ctrl+Y) anywhere in the editor — except
   * inside a text field, a select or anything editable, where the key is the
   * field's own undo and is left alone. Once the field is left, the whole
   * typing burst is one action for the editor's Undo.
   *
   * Leaving a field closes the action it was growing, and so does letting go
   * of a slider: one drag, however many values it passed through, is one
   * action — and the next drag of the same slider is another.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const command = shortcutFor(event);
      if (!command || isTextTarget(event.target)) return;
      event.preventDefault();
      (command === "undo" ? undoRef : redoRef).current();
    };
    const onPointerDown = (event: PointerEvent) => {
      pointerHeld.current = event.target instanceof HTMLInputElement && event.target.type === "range";
    };
    const onPointerUp = () => {
      if (!pointerHeld.current) return;
      pointerHeld.current = false;
      closeHistoryGroup();
    };
    const onFocusOut = (event: FocusEvent) => {
      if (isTextTarget(event.target)) closeHistoryGroup();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
    window.addEventListener("focusout", onFocusOut, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
      window.removeEventListener("focusout", onFocusOut, true);
    };
  }, [closeHistoryGroup]);

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
  const mayPublish = may("publish");
  const publishBlocked = useMemo(() => {
    if (!mayPublish) return null;
    if (pageLocal.conflicted) {
      return "A section on this page has a conflict. Reload the latest version of it first.";
    }
    if (pageLocal.saving) return "Saving drafts…";
    if (pageLocal.dirty) return "Saving drafts…";
    if (structureBusy) return "Finishing a layout change…";
    return null;
  }, [mayPublish, pageLocal, structureBusy]);

  const refreshPageState = useCallback(async () => {
    if (!page) return;
    if (page.kind !== "page") {
      const [next, past] = await Promise.all([loadRouteSummary(page.slug), loadRouteHistory(page.slug)]);
      setRouteSummary(next);
      setRouteHistory(past);
      return;
    }
    const [next, past] = await Promise.all([loadPageSummary(page.id), loadPageHistory(page.id)]);
    setSummary(next);
    setHistory(past);
    // The layout's own revision is what a publication names, and a publication
    // moves it — so the panel re-reads it rather than assuming.
    if (next) {
      setStructure((current) => (current ? { ...current, revision: next.revision } : current));
    }
  }, [page]);

  refreshPageStateRef.current = () => void refreshPageState();

  useEffect(() => {
    if (!page) return;
    let cancelled = false;
    setSummary(null);
    setHistory(null);
    setRouteSummary(null);
    setRouteHistory(null);
    if (page.kind !== "page") {
      void Promise.all([loadRouteSummary(page.slug), loadRouteHistory(page.slug)]).then(([next, past]) => {
        if (cancelled) return;
        setRouteSummary(next);
        setRouteHistory(past);
      });
      return () => {
        cancelled = true;
      };
    }
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
    setPageErrorDetails([]);
    // A reset reported on one page says nothing about the next one.
    setHistoryNotice(null);
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
    async (keepSelection: boolean, historyNotice: string) => {
      if (!page) return;
      const pageId = page.id;
      /**
       * First, the session's history (Batch 16). A publication, a discard and
       * a restore are durable acts on the server, and a local Undo after one
       * must not masquerade as reversing it: publishing is reversed from
       * Version History, a discard is not something Redo may resurrect, and a
       * restore is reversed by restoring again. So the page's history is
       * cleared before anything is re-read, and the editor is told why.
       */
      resetHistory(pageId, historyNotice);
      // Publishing, discarding and restoring change which pages use which
      // reusable components, live and in draft (Batch 17).
      refreshCatalogRef.current();
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
      for (const id of mine) inflight.current.delete(id);

      // A route has no layout to re-read; its regions are the template's.
      const latest = page.kind !== "page" ? null : await loadPageStructure(pageId);
      if (latest) setStructure(latest);
      setStructureFailure(null);
      await refreshPageState();

      const selected = selectedRef.current;
      const survives =
        keepSelection &&
        selected &&
        (page.kind !== "page" || latest?.structure.sections.some((entry) => entry.sectionId === selected.sectionId));
      redrawTo(survives ? keptSelection() : null);
    },
    [page, redrawTo, refreshPageState, resetHistory, writeBuffers],
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
    redrawTo(keptSelection());
  }, [redrawTo, refreshGlobals]);

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
      /** What the toolbar says about the session's history once this succeeds. */
      historyNotice: string,
    ) => {
      if (!page || !allowed("publish") || pageBusy) return;
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
        noteRefusal(answer.message);
        // The refusal may well be "you are out of date", so re-read rather than
        // leave the panel quoting the numbers that were just rejected.
        await refreshPageState();
        return;
      }

      await afterPageAction(keepSelection, historyNotice);
      setPageBusy(false);
      setPageMessage(answer.message);
    },
    [afterPageAction, allowed, csrf, noteRefusal, page, pageBusy, refreshPageState, structure, summary],
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
    void runPageAction(
      publishPageFromEditor,
      () => undefined,
      true,
      "Undo history was cleared: this page was published. Version History keeps the state before it.",
    );
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
    void runPageAction(
      discardPageFromEditor,
      () => undefined,
      false,
      "Undo history was cleared: the saved changes were discarded, and Redo cannot bring them back.",
    );
  }, [runPageAction]);

  const restoreVersion = useCallback(
    (versionId: number) => {
      void runPageAction(
        restoreVersionFromEditor,
        (form) => form.set("versionId", String(versionId)),
        false,
        "Undo history was cleared: a version was restored into saved changes. Version History is how a restore is reversed.",
      );
    },
    [runPageAction],
  );

  /* ------------------------------------------------------------------ */
  /* Dynamic routes: publish, order, visibility, conflicts (Batch 21)     */
  /* ------------------------------------------------------------------ */

  /**
   * A route-wide act — publish, discard, restore — through the route's own
   * actions. The same shape as `runPageAction`: the session's token, what the
   * drawer reviewed (the summary's token, so what is published is exactly what
   * was shown), and afterwards everything this editor believed about the page
   * is re-read.
   */
  const runRouteAction = useCallback(
    async (
      operate: (form: FormData) => Promise<RouteActionResult>,
      fill: (form: FormData) => void,
      keepSelection: boolean,
      historyNotice: string,
    ) => {
      if (!page || page.kind === "page" || !allowed("publish") || pageBusy) return;
      setPageBusy(true);
      setPageMessage(null);
      setPageError(null);
      setPageErrorDetails([]);

      const form = new FormData();
      form.set("_csrf", csrf);
      form.set("routeKey", page.slug);
      form.set("token", routeSummary?.token ?? "");
      fill(form);

      let answer: RouteActionResult;
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
        setPageErrorDetails(answer.details ?? []);
        noteRefusal(answer.message);
        await refreshPageState();
        return;
      }
      await afterPageAction(keepSelection, historyNotice);
      setPageBusy(false);
      setPageMessage(answer.message);
    },
    [afterPageAction, allowed, csrf, noteRefusal, page, pageBusy, refreshPageState, routeSummary],
  );

  const publishRoute = useCallback(() => {
    const lines = (routeSummary?.owners ?? []).map((owner) => `${owner.label}: ${[...owner.fields, owner.style ? "Style" : null, owner.motion ? "Motion" : null].filter(Boolean).join(", ")}`);
    const question = [`Publish the saved changes on this ${routeNoun}?`, lines.slice(0, 12).join("\n")]
      .filter(Boolean)
      .join("\n\n");
    if (!window.confirm(question)) return;
    void runRouteAction(
      publishRouteFromEditor,
      () => undefined,
      true,
      "Undo history was cleared: this page was published. Version History keeps the state before it.",
    );
  }, [routeNoun, routeSummary, runRouteAction]);

  const discardRoute = useCallback(() => {
    if (!window.confirm(`Discard every saved change on this ${routeNoun}? The live page does not change.`)) return;
    void runRouteAction(
      discardRouteFromEditor,
      () => undefined,
      false,
      "Undo history was cleared: the saved changes were discarded, and Redo cannot bring them back.",
    );
  }, [routeNoun, runRouteAction]);

  const restoreRouteVersion = useCallback(
    (versionId: number) => {
      void runRouteAction(
        restoreRouteFromEditor,
        (form) => form.set("versionId", String(versionId)),
        false,
        "Undo history was cleared: a version was restored into saved changes. Version History is how a restore is reversed.",
      );
    },
    [runRouteAction],
  );

  /**
   * Order and visibility on a dynamic route: an edit of the records' drafts,
   * through the ordinary buffer, history and autosave — one Undo takes a move
   * back. The container's `_order` holds a list's order; a record's own
   * `published` holds whether it is shown.
   */
  const routeStructural = useCallback(
    (sectionId: number, values: Record<string, unknown>, label: string) => {
      const held = buffersRef.current[sectionId];
      if (!held || held.status === "conflict") return;
      const changes = diffContent(held.data.blockType, held.values, values);
      if (!changes.length) return;
      closeHistoryGroup();
      recordChange(held.data.pageId, { domain: "content", sectionId, blockType: held.data.blockType, changes }, label);
      writeBuffers((prev) => {
        const entry = prev[sectionId];
        if (!entry) return prev;
        return {
          ...prev,
          [sectionId]: {
            ...entry,
            values,
            contentDirty: !sameValues(values, entry.data.values),
            status: "idle",
            statusDomain: null,
            message: undefined,
          },
        };
      });
      scheduleAutosave(sectionId);
    },
    [closeHistoryGroup, recordChange, scheduleAutosave, writeBuffers],
  );

  /**
   * Moves a group, a card or a question one place within its list.
   *
   * Who is in the list, and in what order, is what the canvas draws: the
   * regions it reports under the same parent, of the same kind — the canvas
   * draws the drafts, so that is the order this editor is holding, including
   * a card moved into the group a moment ago. The list itself is the parent
   * region's stored order, read from its buffer. Every region is read through
   * the one loading primitive, once. Featured cards lead their group whatever
   * their order, so a card only trades places with a neighbour on the same
   * side of that line; a move across it would change nothing a visitor sees.
   */
  const routeMove = useCallback(
    async (section: EditorSectionMeta, direction: "up" | "down") => {
      if (!allowed("editStructure") || !section.parent) return;
      const parentKey = parseAddress(section.parent)?.sectionId;
      const listName = ROUTE_LIST_OF[section.blockType];
      if (parentKey === undefined || !listName) return;
      const idOf = (entry: EditorSectionMeta) => parseOwnerKey(entry.address)?.id ?? null;
      const siblings = sections.filter((entry) => entry.parent === section.parent && entry.blockType === section.blockType);
      const display = siblings.map(idOf).filter((id): id is number => id !== null);
      const mine = idOf(section);
      const at = mine === null ? -1 : display.indexOf(mine);
      const neighbour = display[direction === "up" ? at - 1 : at + 1];
      const other = siblings.find((entry) => idOf(entry) === neighbour);
      if (mine === null || at < 0 || neighbour === undefined || !other) return;
      const [container, own, theirs] = await Promise.all([
        ensureSectionBuffer(parentKey),
        ensureSectionBuffer(section.sectionId),
        ensureSectionBuffer(other.sectionId),
      ]);
      if (!container || !own || !theirs) return;
      if (Boolean(own.values.featured) !== Boolean(theirs.values.featured)) {
        setHistoryNotice("Featured services always come first in their group. Change Featured to move past that line.");
        return;
      }
      const held = (container.values[ORDER_KEY] ?? {}) as Record<string, number[]>;
      const kept = held[listName] ?? [];
      // The order this editor holds, completed against who is in the list now.
      const order = [...kept.filter((id) => display.includes(id)), ...display.filter((id) => !kept.includes(id))];
      const from = order.indexOf(mine);
      const to = order.indexOf(neighbour);
      [order[from], order[to]] = [order[to]!, order[from]!];
      routeStructural(
        parentKey,
        { ...container.values, [ORDER_KEY]: { ...held, [listName]: order } },
        `Move “${own.data.route?.label ?? "this part"}” ${direction}`,
      );
    },
    [allowed, ensureSectionBuffer, routeStructural, sections],
  );

  /** Shows or hides a group, a card or a question when the page is published. */
  const routeVisibility = useCallback(
    async (section: EditorSectionMeta, visible: boolean) => {
      if (!allowed("editStructure")) return;
      const buffer = await ensureSectionBuffer(section.sectionId);
      if (!buffer || buffer.status === "conflict") return;
      routeStructural(
        section.sectionId,
        { ...buffer.values, published: visible },
        `${visible ? "Show" : "Hide"} “${buffer.data.route?.label ?? "this part"}”`,
      );
    },
    [allowed, ensureSectionBuffer, routeStructural],
  );

  /**
   * Settles one field changed outside the Visual Editor since its draft began.
   * The region is saved first, so the choice is made against what is stored;
   * then the server keeps the draft (re-based on the live value) or drops it.
   * Taking the live value changes what the draft says, so the history that
   * described the old value goes with it.
   */
  const resolveConflict = useCallback(
    async (field: string, choice: "mine" | "live") => {
      if (activeId === null) return;
      const sectionId = activeId;
      setResolving(true);
      try {
        const entry = await settleSection(sectionId);
        if (!entry || isDirty(entry) || entry.status === "conflict") {
          setLoadError("Save or reload this part of the page first — conflicts are settled against what is saved.");
          return;
        }
        const form = new FormData();
        form.set("_csrf", csrf);
        form.set("sectionId", String(sectionId));
        form.set("pageId", String(entry.data.pageId));
        form.set("expectedRevision", String(entry.data.revision));
        form.set("field", field);
        form.set("choice", choice);
        const answer = await resolveRouteConflict(form);
        if (!answer.ok) {
          if (answer.reason === "conflict") {
            writeBuffers((prev) => {
              const live = prev[sectionId];
              if (!live) return prev;
              return {
                ...prev,
                [sectionId]: { ...live, status: "conflict", statusDomain: "content", message: answer.message, latest: answer.section },
              };
            });
          }
          if (answer.reason === "denied") noteRefusal(answer.message);
          setLoadError(answer.message);
          return;
        }
        if (choice === "live") {
          resetHistory(entry.data.pageId, "Undo history was reset because a field now follows its live value.");
        }
        writeBuffers((prev) => {
          const live = prev[sectionId];
          if (!live) return prev;
          return {
            ...prev,
            [sectionId]: {
              ...live,
              data: { ...answer.section, styles: live.data.styles, hasStyleDraft: live.data.hasStyleDraft, motionDocument: live.data.motionDocument, hasMotionDraft: live.data.hasMotionDraft },
              values: answer.section.values,
              contentDirty: false,
              status: "saved",
              statusDomain: "content",
              message: undefined,
            },
          };
        });
        setLoadError(null);
        void refreshPageState();
        redrawKeeping();
      } finally {
        setResolving(false);
      }
    },
    [activeId, csrf, noteRefusal, redrawKeeping, refreshPageState, resetHistory, settleSection, writeBuffers],
  );

  const routeControls: RouteControls = useMemo(
    () => ({
      mayRecord,
      canStructure: can.editStructure && !revoked.has("editStructure"),
      busy: resolving,
      onResolve: (field, choice) => void resolveConflict(field, choice),
    }),
    [can, mayRecord, resolveConflict, resolving, revoked],
  );

  /**
   * Puts the selection back after the canvas has reloaded.
   *
   * By address, which is the whole point of the address model: the element is a
   * different DOM node in a different document, and it is still the same
   * heading. A node that the edit removed — the row that was just deleted —
   * cannot come back, so the fallback is its section, which is the nearest
   * thing that still exists and keeps the inspector on the right block — asked
   * for when the canvas says the node is gone, never on a timer (`restoring`).
   */
  useEffect(() => {
    if (!restoreToken || canvas.status !== "ready") return;
    const wanted = restoreTo.current;
    if (!wanted) return;
    restoreTo.current = null;

    // The next selection the canvas reports is its answer (`onSelection`).
    const hold = holding.current;
    if (hold && hold.address === wanted.address) hold.asked = true;
    else restoring.current = wanted.fallback !== wanted.address ? wanted : null;
    requestSelection(wanted.address);
  }, [restoreToken, canvas.status, requestSelection]);

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

  /** The history of the page on screen, redrawn whenever any history moves. */
  const pageHistory = useMemo(
    () => (pageId === null ? emptyHistory() : historyOf(pageId)),
    // `historyTick` is what says the map behind `historyOf` has changed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pageId, historyOf, historyTick],
  );
  const nextUndo = pageHistory.undo[pageHistory.undo.length - 1] ?? null;
  const nextRedo = pageHistory.redo[pageHistory.redo.length - 1] ?? null;
  const historyIdle = !historyBusy && !structureBusy && !pageBusy;
  /**
   * Nothing here this session may change — the toolbar says so in words. A
   * claim about the whole editor, so it is made only when it is true of all of
   * it: no page capability, no reusable draft made from a section, and no
   * Globals drawer. A navigation manager who may not touch a page is not read
   * only here; Globals is theirs.
   */
  const readOnly =
    !canManageNavigation &&
    !canManageSettings &&
    !(["editContent", "editStyle", "editMotion", "editStructure", "publish", "editComponents"] as const).some(may);

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
            {readOnly ? (
              <span
                className="rounded-full border border-[var(--admin-line)] px-2 py-0.5 text-[0.66rem] font-semibold uppercase tracking-wide text-muted"
                title="You can look at every page here, but your role does not allow changing anything."
                data-permission-badge="read-only"
              >
                Read only
              </span>
            ) : null}
          </span>
        </div>

        {/*
          Undo and Redo (Batch 16): this editing session's own actions on this
          page, newest first. Named for what they would take back, so a person
          knows before pressing; described as the session's, so nobody mistakes
          them for Version History.
        */}
        <div className="flex items-center gap-1" role="group" aria-label="Undo and redo">
          <button
            type="button"
            onClick={() => undoRef.current()}
            disabled={!historyIdle || !nextUndo}
            className="admin-btn admin-btn-sm"
            aria-label={nextUndo ? `Undo: ${nextUndo.label}` : "Undo — nothing to undo"}
            aria-describedby="ve-undo-scope"
            aria-keyshortcuts="Control+Z Meta+Z"
            title={`${nextUndo ? `Undo: ${nextUndo.label}` : "Nothing to undo"} (Ctrl+Z / ⌘Z)`}
            data-history="undo"
          >
            <HistoryGlyph direction="undo" />
            <span className="hidden 2xl:inline">Undo</span>
          </button>
          <button
            type="button"
            onClick={() => redoRef.current()}
            disabled={!historyIdle || !nextRedo}
            className="admin-btn admin-btn-sm"
            aria-label={nextRedo ? `Redo: ${nextRedo.label}` : "Redo — nothing to redo"}
            aria-describedby="ve-undo-scope"
            aria-keyshortcuts="Control+Shift+Z Meta+Shift+Z Control+Y"
            title={`${nextRedo ? `Redo: ${nextRedo.label}` : "Nothing to redo"} (Ctrl+Shift+Z / ⇧⌘Z)`}
            data-history="redo"
          >
            <HistoryGlyph direction="redo" />
            <span className="hidden 2xl:inline">Redo</span>
          </button>
          <span id="ve-undo-scope" className="sr-only">
            {UNDO_SCOPE_NOTE}
          </span>
        </div>
        {historyNotice ? (
          <p
            className="flex max-w-[26rem] items-center gap-1.5 text-[0.72rem] leading-snug"
            style={{ color: "var(--color-peach)" }}
            role="status"
            data-history-notice
          >
            {historyNotice}
            <button
              type="button"
              onClick={() => setHistoryNotice(null)}
              className="admin-btn admin-btn-sm px-1.5 py-0"
              aria-label="Dismiss"
            >
              <Icon name="close" size={10} />
            </button>
          </p>
        ) : null}

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
            {/*
              Groups when there is anything but pages (Batch 21): the CMS
              pages, every service category, and every service under its
              category (Batch 22) — named by the database and listed by it,
              so a category or a service created tomorrow is here tomorrow.
            */}
            {pickerGroups(pages).map(({ key, label, rows }) => {
              const options = rows.map((row) => (
                <option key={row.slug} value={row.slug}>
                  {row.title} — {row.path}
                  {row.isPublished ? "" : " (unpublished)"}
                </option>
              ));
              return pages.some((row) => row.kind !== "page") ? (
                <optgroup key={key} label={label}>
                  {options}
                </optgroup>
              ) : (
                options
              );
            })}
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
          {/* Below lg the words are hidden from the eye, never from a screen reader. */}
          <button type="button" onClick={() => freshCanvas()} className="admin-btn admin-btn-sm">
            <Icon name="refresh" size={12} />
            <span className="sr-only lg:not-sr-only">Reload</span>
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
            onClick={() =>
              setPagePanel((value) => {
                // A route's drawer reads what is waiting as it opens (Batch 21).
                if (!value && isRoute) void refreshPageState();
                return !value;
              })
            }
            aria-expanded={pagePanel}
            aria-describedby={(isRoute ? routeSummary?.publishable : summary?.publishable) ? "ve-publish-pending" : undefined}
            className="admin-btn admin-btn-sm"
            style={
              (isRoute ? routeSummary?.publishable : summary?.publishable)
                ? { borderColor: "var(--color-orange)", color: "var(--color-strong)" }
                : undefined
            }
          >
            <Icon name="check" size={12} />
            <span className="sr-only lg:not-sr-only">Publish</span>
            {(isRoute ? routeSummary?.publishable : summary?.publishable) ? (
              <span aria-hidden className="inline-block size-1.5 rounded-full" style={{ background: "var(--color-orange)" }} />
            ) : null}
          </button>
          {/* The dot and the border are colour; this is the same fact in words —
              the button's description, so its name stays what it does (19B). */}
          {(isRoute ? routeSummary?.publishable : summary?.publishable) ? (
            <span id="ve-publish-pending" className="sr-only">
              This page has unpublished changes.
            </span>
          ) : null}
          <a
            href={isRoute ? previewRoutePath(page.path, locale) : previewPagePath(page.slug, locale)}
            target="_blank"
            rel="noopener"
            className="admin-btn admin-btn-sm"
            title="Open this page's ordinary draft preview in a new tab"
          >
            <Icon name="arrowUpRight" size={12} />
            <span className="hidden lg:inline">Preview</span>
          </a>
          {/* Search and sharing are the SEO screen's, not the editor's (Batch 25):
              one place edits them, and this opens it at this page. The dot is the
              page having settings of its own; the same fact is in the name. */}
          {page.seo ? (
            <a
              href={`/admin/seo?target=${encodeURIComponent(page.seo.ref)}`}
              target="_blank"
              rel="noopener"
              className="admin-btn admin-btn-sm"
              data-ve-seo={page.seo.ref}
              title={
                page.seo.custom
                  ? "This page has its own search and sharing settings. Open them on the SEO screen in a new tab."
                  : "This page follows its own content for search and sharing. Open its settings on the SEO screen in a new tab."
              }
              aria-label={page.seo.custom ? "SEO — this page has its own settings" : "SEO — following the page's own content"}
            >
              <Icon name="search" size={12} />
              <span className="hidden lg:inline">SEO</span>
              {page.seo.custom ? (
                <span aria-hidden className="inline-block size-1.5 rounded-full" style={{ background: "var(--color-peach)" }} />
              ) : null}
            </a>
          ) : null}
        </div>
      </header>

      {/* ---------------------------------------------------------------- */}
      {/* Body                                                              */}
      {/* ---------------------------------------------------------------- */}
      <div className="flex min-h-0 flex-1">
        {isRoute ? (
          <RouteLayersPanel
            kind={routeKind}
            title={page.title}
            sections={sections}
            selectedSectionId={activeId}
            selectedAddress={selected?.address ?? null}
            locks={locks}
            locale={locale}
            valuesOf={valuesOf}
            dirtyIds={dirtyIds}
            ready={ready}
            canStructure={may("editStructure") && routeStructureDomain}
            canEditText={may("editContent")}
            onSelect={ask}
            onToggleLock={toggleLock}
            onEditText={requestDirectEdit}
            onMove={(section, direction) => void routeMove(section, direction)}
            onVisibility={(section, visible) => void routeVisibility(section, visible)}
            busy={pageBusy}
            onRowsDrawn={restoreLayersFocus}
          />
        ) : (
        <LayersPanel
          sections={sections}
          structure={structure}
          removed={structure ? removedSections(structure) : []}
          selectedSectionId={activeId}
          selectedAddress={selected?.address ?? null}
          locks={locks}
          locale={locale}
          valuesOf={valuesOf}
          dirtyIds={dirtyIds}
          ready={ready}
          canStructure={may("editStructure")}
          canEditText={may("editContent")}
          canAddReusable={may("editStructure") && may("editContent") && may("viewComponents")}
          busy={structureBusy}
          failure={structureFailure}
          onReloadLayout={reloadLayout}
          blocks={blocks[page.slug] ?? []}
          ops={ops}
          onSelect={ask}
          onToggleLock={toggleLock}
          onEditText={requestDirectEdit}
          reuseOf={reuseOf}
          reusableBlocks={(catalog ?? [])
            .filter((entry) => entry.status === "active" && entry.published && entry.kind.startsWith("block:"))
            .map((entry) => ({
              id: entry.id,
              name: entry.name,
              blockType: entry.kind.slice("block:".length),
              usage: usageHeadline(entry.usage),
            }))}
          onRowsDrawn={restoreLayersFocus}
        />
        )}

        <section
          className="relative flex min-w-0 flex-1 flex-col bg-[color-mix(in_oklab,#05070d_72%,var(--admin-bg))] p-4"
          aria-label="Website canvas"
        >
          <div className="min-h-0 flex-1">
            <VisualCanvas
              slug={page.slug}
              publicPath={isRoute ? page.path : undefined}
              locale={locale}
              device={device}
              canvasKey={canvasKey}
              title={page.title}
              selectRequest={selectRequest}
              editRequest={editRequest}
              replayRequest={replayRequest}
              locks={locks}
              onState={onCanvasState}
              onStructure={onStructure}
              onSelection={onSelection}
              onEdit={onCanvasEdit}
              onEditRequest={requestDirectEdit}
              onReplayResult={onReplayResult}
              onShortcut={onShortcut}
            />
          </div>

          {isRoute ? (
            <RoutePanel
              kind={routeKind}
              open={pagePanel}
              onClose={() => setPagePanel(false)}
              locale={locale}
              summary={routeSummary}
              history={routeHistory}
              canPublish={may("publish")}
              busy={pageBusy}
              blockedReason={publishBlocked}
              message={pageMessage}
              error={pageError}
              errorDetails={pageErrorDetails}
              onPublish={publishRoute}
              onDiscard={discardRoute}
              onRestore={restoreRouteVersion}
              onCompare={(versionId, against) => loadRouteCompare(page.slug, versionId, against)}
              onRefresh={() => void refreshPageState()}
            />
          ) : (
            <PagePanel
              open={pagePanel}
              onClose={() => setPagePanel(false)}
              title={page.title}
              summary={summary}
              history={history}
              canPublishPage={may("publish")}
              busy={pageBusy}
              blockedReason={publishBlocked}
              message={pageMessage}
              error={pageError}
              onPublish={publishPage}
              onDiscard={discardPage}
              onRestore={restoreVersion}
              onRefresh={() => void refreshPageState()}
            />
          )}

          <GlobalsPanel
            open={globalsPanel}
            onClose={() => setGlobalsPanel(false)}
            csrf={csrf}
            globals={globals}
            loading={globalsLoading}
            onRefresh={() => void refreshGlobals()}
            onChanged={afterGlobalChange}
            reusable={catalog}
            onOpenComponent={(id) => setComponentDrawer({ id, focus: "edit" })}
          />

          {componentDrawer ? (
            <aside
              className="absolute inset-y-0 end-0 z-30 flex w-[26rem] flex-col border-s border-[var(--admin-line)] bg-[var(--admin-shell)] shadow-2xl"
              aria-label="Reusable component"
              data-reuse-drawer={componentDrawer.id}
            >
              <header className="flex shrink-0 items-center gap-2 border-b border-[var(--admin-line)] px-3.5 py-2.5">
                <h2 className="flex-1 truncate text-[0.82rem] font-semibold text-strong">Reusable component</h2>
                <Link href={`/admin/components/${componentDrawer.id}`} className="admin-btn admin-btn-sm" target="_blank">
                  Open full screen
                </Link>
                <button
                  type="button"
                  onClick={() => setComponentDrawer(null)}
                  className="admin-btn admin-btn-sm"
                  aria-label="Close"
                >
                  <Icon name="close" size={12} />
                </button>
              </header>
              <div className="min-h-0 flex-1 overflow-y-auto p-3.5">
                <ReuseEditor
                  key={componentDrawer.id}
                  componentId={componentDrawer.id}
                  csrf={csrf}
                  can={{
                    edit: may("editComponents"),
                    publish: may("publishComponents"),
                    lifecycle: may("componentLifecycle"),
                  }}
                  media={media}
                  locale={locale}
                  focus={componentDrawer.focus}
                  onChanged={(_view, event) => {
                    /**
                     * A component edit is the component's, never this page's:
                     * nothing here touches a buffer, the layout or the page's
                     * Undo. A publication changes what linked sections show,
                     * so the counts are re-read and the canvas is redrawn with
                     * the selection kept — and the history stays exactly as
                     * it was, because nothing in it has become untrue.
                     */
                    void refreshCatalog();
                    if (event === "published" && activeId !== null) redrawKeeping();
                    else if (event === "published") freshCanvas();
                    if (event === "deleted") setComponentDrawer(null);
                  }}
                />
              </div>
            </aside>
          ) : null}

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
          access={{
            content: may("editContent"),
            style: may("editStyle"),
            advancedStyle: may("editAdvancedStyle"),
            motion: may("editMotion"),
          }}
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
          replay={{ ready: canvas.status === "ready", status: replayStatus, onReplay: requestReplay }}
          reuse={reuseControls}
          route={isRoute ? routeControls : undefined}
        />
      </div>
    </div>
  );
}

/**
 * The page picker's groups, in the order the editor lists documents: the CMS
 * pages, the two overviews (Batch 24), the service categories, one group per
 * category holding its services (Batch 22), the destinations, and one group
 * per destination holding its packages (Batch 24) — so seventy services and
 * every package are found by the place a person already knows them by.
 */
function pickerGroups(pages: EditablePage[]): { key: string; label: string; rows: EditablePage[] }[] {
  const out: { key: string; label: string; rows: EditablePage[] }[] = [];
  const pagesOnly = pages.filter((row) => row.kind === "page");
  if (pagesOnly.length) out.push({ key: "page", label: "Pages", rows: pagesOnly });
  const overviews = pages.filter((row) => row.kind === "serviceIndex" || row.kind === "packageIndex");
  if (overviews.length) out.push({ key: "overview", label: "Overviews", rows: overviews });
  const categories = pages.filter((row) => row.kind === "category");
  if (categories.length) out.push({ key: "category", label: "Service Categories", rows: categories });
  const grouped = (kind: "service" | "package", fallback: string, prefix: string) => {
    const byGroup = new Map<string, EditablePage[]>();
    for (const row of pages) {
      if (row.kind !== kind) continue;
      const group = row.group ?? fallback;
      byGroup.set(group, [...(byGroup.get(group) ?? []), row]);
    }
    for (const [group, rows] of byGroup) out.push({ key: `${kind}:${group}`, label: `${prefix} · ${group}`, rows });
  };
  grouped("service", "Services", "Services");
  const destinations = pages.filter((row) => row.kind === "destination");
  if (destinations.length) out.push({ key: "destination", label: "Destinations", rows: destinations });
  grouped("package", "No destination", "Packages");
  return out;
}

/**
 * The toolbar's two arrows. Drawn here rather than added to the site's icon
 * set, because that set is also the list of icons an editor may choose for a
 * page — and an Undo arrow is not a picture anybody should put on a card.
 */
function HistoryGlyph({ direction }: { direction: "undo" | "redo" }) {
  return (
    <svg
      aria-hidden
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={direction === "redo" ? { transform: "scaleX(-1)" } : undefined}
    >
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
    </svg>
  );
}
