"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import { restoreVersionFromEditor } from "@/app/(backoffice)/admin/visual-editor/actions";
import { RESTORE_CONFIRM } from "@/components/admin/page-history";
import { Icon } from "@/components/ui/icon";
import { LOCALE_LABELS, LOCALES, type Locale } from "@/lib/i18n/config";
import { compareFramePath } from "@/lib/page-path";
import {
  DYNAMIC_DISCLAIMER,
  GLOBAL_DISCLAIMER,
  MEDIA_DISCLAIMER,
  type PageDiff,
  type SectionDiff,
  type ValueChange,
} from "@/lib/visual-editor/compare";
import { deviceWidth, EDITOR_DEVICES, type DeviceKey } from "@/lib/visual-editor/viewport";

export type CompareVersion = { id: number; label: string; actorName: string; createdAt: string | null };

export type CompareState =
  | { ok: false; message: string }
  | {
      ok: true;
      page: { id: number; slug: string; title: string };
      /** The older state. Always a version. */
      left: CompareVersion;
      /** The newer state: the current published page, or a later version. */
      right: { kind: "published" } | ({ kind: "version" } & CompareVersion);
      /** The version the comparison was opened for — the one Restore would restore. */
      chosenVersionId: number;
      versions: CompareVersion[];
      diff: PageDiff;
      dynamic: { blockType: string; name: string; source: string }[];
      locale: Locale;
      device: DeviceKey;
      /** Present only for somebody who may restore; `blocked` says why they cannot now. */
      restore: { csrf: string; blocked: string | null } | null;
    };

/** A timestamp, written for the reader's own clock once the page is in their browser. */
function When({ iso }: { iso: string | null }) {
  const [text, setText] = useState<string | null>(null);
  useEffect(() => {
    if (!iso) return;
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return;
    setText(
      date.toLocaleString(undefined, {
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
  }, [iso]);
  if (!iso) return null;
  return <time dateTime={iso}>{text ?? iso.slice(0, 16).replace("T", " ")}</time>;
}

/**
 * Version Compare's screen (Batch 16): two real renderings of the page and a
 * list of what differs, side by side, read-only.
 *
 * The panes are the website itself — the same public route, layout and
 * renderer a visitor gets — each asked for one state of the page by id
 * (`compareFramePath`). Nothing is drawn into them and nothing is edited in
 * them: there is no bridge, no selection, no inspector. Scrolling stays in the
 * browser, and a language or width change reloads or resizes both panes
 * together, so the two are never showing different editions or widths.
 */
export function CompareView({ state }: { state: CompareState }) {
  if (!state.ok) {
    return (
      <div className="flex h-dvh items-center justify-center p-8 text-center">
        <div className="max-w-md">
          <p className="text-strong" role="alert">
            {state.message}
          </p>
          <Link href="/admin/pages" className="admin-btn admin-btn-sm mt-3">
            Go to Pages &amp; sections
          </Link>
        </div>
      </div>
    );
  }
  return <Comparison state={state} />;
}

function Comparison({ state }: { state: Extract<CompareState, { ok: true }> }) {
  const router = useRouter();
  const [locale, setLocale] = useState<Locale>(state.locale);
  const [device, setDevice] = useState<DeviceKey>(state.device);
  const [sync, setSync] = useState(true);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [restoring, setRestoring] = useState<{ busy: boolean; ok: boolean | null; message: string | null }>({
    busy: false,
    ok: null,
    message: null,
  });

  const { page, left, right, diff } = state;
  const leftTitle = `${left.label} #${left.id}`;
  const rightTitle = right.kind === "published" ? "Current published" : `${right.label} #${right.id}`;

  // The address is the screen's state, so a reload comes back to the same view.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    params.set("lang", locale);
    params.set("device", device);
    window.history.replaceState(null, "", `?${params}`);
  }, [locale, device]);

  /* ---------------------------------------------------------------- */
  /* Scrolling the two panes together                                  */
  /* ---------------------------------------------------------------- */

  const frames = useRef<[HTMLIFrameElement | null, HTMLIFrameElement | null]>([null, null]);
  /** A pane scrolled by the other one ignores its own scroll events until then. */
  const quietUntil = useRef<[number, number]>([0, 0]);
  const syncRef = useRef(sync);
  syncRef.current = sync;

  /**
   * By progress through the page, not by element: the two states need not have
   * the same sections, so "the same place" is the same fraction of the way
   * down. The pane that is moved is told to ignore the scroll that causes, so
   * the two never chase each other.
   */
  const follow = useCallback((from: 0 | 1) => {
    if (!syncRef.current) return;
    if (performance.now() < quietUntil.current[from]) return;
    const to = from === 0 ? 1 : 0;
    const source = frames.current[from]?.contentWindow;
    const target = frames.current[to]?.contentWindow;
    if (!source || !target) return;
    try {
      const sourceMax = source.document.documentElement.scrollHeight - source.innerHeight;
      const targetMax = target.document.documentElement.scrollHeight - target.innerHeight;
      const progress = sourceMax > 0 ? source.scrollY / sourceMax : 0;
      quietUntil.current[to] = performance.now() + 150;
      target.scrollTo({ top: Math.round(progress * Math.max(0, targetMax)), behavior: "instant" });
    } catch {
      // A pane that navigated somewhere else is not ours to read.
    }
  }, []);

  const attach = useCallback(
    (index: 0 | 1) => {
      const frame = frames.current[index];
      const view = frame?.contentWindow;
      if (!view) return;
      let pending = 0;
      view.addEventListener(
        "scroll",
        () => {
          if (pending) return;
          pending = view.requestAnimationFrame(() => {
            pending = 0;
            follow(index);
          });
        },
        { passive: true },
      );
    },
    [follow],
  );

  /** Both panes to one section, by the row it came from. */
  const showSection = useCallback((sectionId: number | null) => {
    if (sectionId === null) return;
    const until = performance.now() + 600;
    quietUntil.current = [until, until];
    for (const frame of frames.current) {
      try {
        const element = frame?.contentDocument?.querySelector(`[data-eod-compare="${sectionId}"]`);
        element?.scrollIntoView({ block: "start", behavior: "instant" });
      } catch {
        // As above: a pane that is not showing our page is left alone.
      }
    }
  }, []);

  /* ---------------------------------------------------------------- */
  /* Restore — the ordinary restore action, nothing of its own         */
  /* ---------------------------------------------------------------- */

  const restore = useCallback(async () => {
    if (!state.restore || state.restore.blocked) return;
    if (!window.confirm(RESTORE_CONFIRM)) return;
    setRestoring({ busy: true, ok: null, message: null });
    const form = new FormData();
    form.set("_csrf", state.restore.csrf);
    form.set("pageId", String(page.id));
    form.set("versionId", String(state.chosenVersionId));
    try {
      const answer = await restoreVersionFromEditor(form);
      setRestoring({ busy: false, ok: answer.ok, message: answer.message });
    } catch {
      setRestoring({ busy: false, ok: false, message: "That could not be sent. Try again." });
    }
  }, [page.id, state.chosenVersionId, state.restore]);

  const changed = diff.sections.filter((entry) => entry.status !== "unchanged");
  const listed = showUnchanged ? diff.sections : changed;

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-[var(--admin-bg)]">
      <header className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-[var(--admin-line)] bg-[var(--admin-shell)] px-3 py-2">
        <Link href={`/admin/visual-editor?page=${encodeURIComponent(page.slug)}`} className="admin-btn admin-btn-sm">
          <Icon name="arrowRight" size={13} className="rotate-180" />
          Visual Editor
        </Link>
        <h1 className="text-[0.82rem] font-semibold tracking-tight text-strong">
          Compare versions <span className="text-muted">· {page.title}</span>
        </h1>

        <div className="flex gap-1" role="group" aria-label="Language of both panes">
          {LOCALES.map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => setLocale(code)}
              aria-pressed={locale === code}
              className="admin-btn admin-btn-sm"
              style={locale === code ? { borderColor: "var(--color-orange)", color: "var(--color-strong)" } : undefined}
            >
              {LOCALE_LABELS[code].native}
            </button>
          ))}
        </div>

        <div className="flex gap-1" role="group" aria-label="Width of both panes">
          {EDITOR_DEVICES.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => setDevice(option.key)}
              aria-pressed={device === option.key}
              className="admin-btn admin-btn-sm"
              style={
                device === option.key ? { borderColor: "var(--color-orange)", color: "var(--color-strong)" } : undefined
              }
              title={`${option.label} — ${option.width}px`}
            >
              <Icon name={option.icon} size={12} />
              <span className="hidden md:inline">{option.label}</span>
              <span className="text-muted tabular-nums">{option.width}</span>
            </button>
          ))}
        </div>

        <label className="flex items-center gap-1.5 text-[0.75rem] text-body">
          <input type="checkbox" checked={sync} onChange={(event) => setSync(event.target.checked)} />
          Sync scrolling
        </label>

        <div className="ms-auto flex items-center gap-2">
          <label htmlFor="compare-against" className="text-[0.75rem] text-muted">
            Compare version #{state.chosenVersionId} with
          </label>
          <select
            id="compare-against"
            className="admin-input h-[1.9rem] max-w-[16rem] py-0 text-[0.78rem]"
            value={right.kind === "published" ? "published" : String(right.id === state.chosenVersionId ? left.id : right.id)}
            onChange={(event) => {
              const params = new URLSearchParams({
                page: String(page.id),
                version: String(state.chosenVersionId),
                against: event.target.value,
                lang: locale,
                device,
              });
              router.push(`/admin/compare?${params}`);
            }}
          >
            <option value="published">Current published</option>
            {state.versions
              .filter((version) => version.id !== state.chosenVersionId)
              .map((version) => (
                <option key={version.id} value={String(version.id)}>
                  {version.label} #{version.id}
                </option>
              ))}
          </select>
          {state.restore ? (
            <button
              type="button"
              onClick={() => void restore()}
              disabled={Boolean(state.restore.blocked) || restoring.busy || restoring.ok === true}
              className="admin-btn admin-btn-sm"
              title={state.restore.blocked ?? "Stages this version as saved changes. The live site does not change."}
            >
              <Icon name="refresh" size={12} />
              {restoring.busy ? "Restoring…" : `Restore version #${state.chosenVersionId} to draft`}
            </button>
          ) : null}
        </div>
      </header>

      <div className="flex shrink-0 flex-col gap-1 border-b border-[var(--admin-line)] px-3 py-2 text-[0.72rem] leading-relaxed text-muted" role="note" aria-label="What a page version does and does not contain">
        <p data-disclaimer="global">{GLOBAL_DISCLAIMER}</p>
        {state.dynamic.length ? (
          <p data-disclaimer="dynamic">
            {DYNAMIC_DISCLAIMER}{" "}
            <span className="text-body">
              On this page: {state.dynamic.map((entry) => `${entry.name} (${entry.source})`).join("; ")}.
            </span>
          </p>
        ) : null}
        <p data-disclaimer="media">{MEDIA_DISCLAIMER}</p>
        {state.restore?.blocked ? <p>{state.restore.blocked}</p> : null}
        {restoring.message ? (
          <p role="status" style={{ color: restoring.ok ? "#5ad19a" : "#ef8f8a" }}>
            {restoring.message}{" "}
            {restoring.ok ? (
              <Link href={`/admin/visual-editor?page=${encodeURIComponent(page.slug)}`} className="underline">
                Review it in the Visual Editor
              </Link>
            ) : null}
          </p>
        ) : null}
      </div>

      <div className="flex min-h-0 flex-1">
        <Pane
          side="Left"
          heading={leftTitle}
          meta={
            <>
              <When iso={left.createdAt} />
              {left.actorName ? ` · ${left.actorName}` : ""} — the published page just before that publication
            </>
          }
          frameTitle={`Left pane: ${leftTitle} (${LOCALE_LABELS[locale].native}, ${device})`}
          src={compareFramePath(page.slug, locale, left.id)}
          device={device}
          onFrame={(frame) => (frames.current[0] = frame)}
          onLoad={() => attach(0)}
        />
        <Pane
          side="Right"
          heading={rightTitle}
          meta={
            right.kind === "published" ? (
              "What visitors see now"
            ) : (
              <>
                <When iso={right.createdAt} />
                {right.actorName ? ` · ${right.actorName}` : ""} — the published page just before that publication
              </>
            )
          }
          frameTitle={`Right pane: ${rightTitle} (${LOCALE_LABELS[locale].native}, ${device})`}
          src={compareFramePath(page.slug, locale, right.kind === "published" ? "published" : right.id)}
          device={device}
          onFrame={(frame) => (frames.current[1] = frame)}
          onLoad={() => attach(1)}
        />

        <aside
          className="flex w-[22rem] shrink-0 flex-col border-s border-[var(--admin-line)] bg-[var(--admin-shell)]"
          aria-label="What changed"
        >
          <div className="shrink-0 px-3.5 pb-2 pt-3">
            <h2 className="text-[0.7rem] font-semibold uppercase tracking-[0.08em] text-muted">What changed</h2>
            <p className="mt-1 text-[0.74rem] leading-relaxed text-body" data-compare-counts>
              {countsLine(diff)}
            </p>
            <p className="mt-1 text-[0.7rem] leading-relaxed text-muted">
              From <span className="text-body">{leftTitle}</span> (left) to{" "}
              <span className="text-body">{rightTitle}</span> (right).
            </p>
            <label className="mt-2 flex items-center gap-1.5 text-[0.72rem] text-muted">
              <input
                type="checkbox"
                checked={showUnchanged}
                onChange={(event) => setShowUnchanged(event.target.checked)}
              />
              Show unchanged sections
            </label>
          </div>
          <ol className="min-h-0 flex-1 overflow-y-auto px-3.5 pb-6" data-compare-list>
            {!listed.length ? (
              <li className="text-[0.76rem] text-muted">The two states of this page are the same.</li>
            ) : (
              listed.map((entry) => <SectionEntry key={entry.key} entry={entry} onShow={showSection} />)
            )}
          </ol>
        </aside>
      </div>
    </div>
  );
}

function countsLine(diff: PageDiff): string {
  const { counts } = diff;
  const parts = [
    counts.added ? `${counts.added} added` : null,
    counts.removed ? `${counts.removed} removed` : null,
    counts.moved ? `${counts.moved} moved` : null,
    counts.visibility ? `${counts.visibility} shown or hidden` : null,
    counts.content ? `${counts.content} with content changes` : null,
    counts.style ? `${counts.style} with style changes` : null,
    counts.motion ? `${counts.motion} with motion changes` : null,
  ].filter(Boolean);
  const sections = `${counts.unchanged} unchanged`;
  return parts.length ? `${parts.join(" · ")} · ${sections}` : `No differences · ${sections}`;
}

/** Words for what happened to a section — never colour alone. */
function badges(entry: SectionDiff): string[] {
  const out: string[] = [];
  if (entry.status === "added") out.push("Added");
  if (entry.status === "removed") out.push("Removed");
  if (entry.moved) out.push(`Moved ${entry.position.before} → ${entry.position.after}`);
  if (entry.visible.before !== null && entry.visible.after !== null && entry.visible.before !== entry.visible.after) {
    out.push(entry.visible.after ? "Shown" : "Hidden");
  }
  if (entry.content.length) out.push(`Content ${entry.content.length}`);
  if (entry.style.length) out.push(`Style ${entry.style.length}`);
  if (entry.motion.length) out.push(`Motion ${entry.motion.length}`);
  if (entry.status === "unchanged") out.push("Unchanged");
  return out;
}

function SectionEntry({ entry, onShow }: { entry: SectionDiff; onShow: (sectionId: number | null) => void }) {
  const hiddenBoth = entry.visible.before === false && entry.visible.after === false;
  const visibleSomewhere = entry.visible.before === true || entry.visible.after === true;
  return (
    <li className="admin-card mb-1.5 p-2.5" data-compare-section={entry.key} data-compare-status={entry.status}>
      <details open={entry.status !== "unchanged"}>
        <summary className="cursor-pointer text-[0.78rem] font-medium leading-snug text-strong">
          {entry.name}
          <span className="mt-1 flex flex-wrap gap-1">
            {badges(entry).map((badge) => (
              <span
                key={badge}
                className="rounded-full border border-[var(--admin-line)] px-1.5 py-0.5 text-[0.64rem] font-semibold uppercase tracking-wide text-muted"
              >
                {badge}
              </span>
            ))}
          </span>
        </summary>
        <div className="mt-2 flex flex-col gap-2">
          <p className="text-[0.7rem] text-muted">
            Position {entry.position.before ?? "—"} → {entry.position.after ?? "—"}
            {entry.visible.before === false || entry.visible.after === false
              ? ` · ${visibility(entry.visible.before)} → ${visibility(entry.visible.after)}`
              : ""}
          </p>
          <Changes title="Content" changes={entry.content} />
          <Changes title="Style" changes={entry.style} />
          <Changes title="Motion" changes={entry.motion} />
          {entry.sectionId !== null && visibleSomewhere && !hiddenBoth ? (
            <button type="button" onClick={() => onShow(entry.sectionId)} className="admin-btn admin-btn-sm self-start">
              Show in the panes
            </button>
          ) : null}
        </div>
      </details>
    </li>
  );
}

const visibility = (value: boolean | null) => (value === null ? "—" : value ? "shown" : "hidden");

function Changes({ title, changes }: { title: string; changes: ValueChange[] }) {
  if (!changes.length) return null;
  return (
    <div>
      <p className="text-[0.66rem] font-semibold uppercase tracking-[0.07em] text-muted">{title}</p>
      <ul className="mt-1 flex flex-col gap-1.5">
        {changes.map((change, index) => (
          <li key={`${change.label}-${index}`} className="text-[0.72rem] leading-snug">
            <p className="text-body">{change.label}</p>
            <p className="text-muted">
              <span className="font-semibold">Before:</span> {change.before}
            </p>
            <p className="text-muted">
              <span className="font-semibold">After:</span> {change.after}
            </p>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * One pane: the real page at the device's own width, scaled to fit. The same
 * rule the Visual Editor canvas keeps — a 1440px page is laid out at 1440px
 * and shrunk, never squeezed into the space available.
 */
function Pane({
  side,
  heading,
  meta,
  frameTitle,
  src,
  device,
  onFrame,
  onLoad,
}: {
  side: "Left" | "Right";
  heading: string;
  meta: React.ReactNode;
  frameTitle: string;
  src: string;
  device: DeviceKey;
  onFrame: (frame: HTMLIFrameElement | null) => void;
  onLoad: () => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [stage, setStage] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    const measure = () => setStage({ width: node.clientWidth, height: node.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const width = deviceWidth(device);
  const scale = stage.width > 0 ? Math.min(1, stage.width / width) : 1;

  return (
    <section
      className="flex min-w-0 flex-1 flex-col border-e border-[var(--admin-line)]"
      aria-label={`${side} pane: ${heading}`}
      data-compare-pane={side.toLowerCase()}
    >
      <div className="shrink-0 px-3 py-2">
        <p className="text-[0.66rem] font-semibold uppercase tracking-[0.08em] text-muted">{side}</p>
        <p className="text-[0.8rem] font-semibold text-strong">{heading}</p>
        <p className="text-[0.7rem] text-muted">{meta}</p>
      </div>
      <div ref={stageRef} className="relative min-h-0 flex-1 overflow-hidden bg-[color-mix(in_oklab,#05070d_72%,var(--admin-bg))]">
        {stage.width > 0 ? (
          <iframe
            ref={onFrame}
            src={src}
            title={frameTitle}
            onLoad={onLoad}
            className="absolute start-0 top-0 border-0 bg-white"
            style={{
              width,
              height: stage.height / scale,
              transform: `scale(${scale})`,
              transformOrigin: "top left",
            }}
          />
        ) : null}
      </div>
    </section>
  );
}
