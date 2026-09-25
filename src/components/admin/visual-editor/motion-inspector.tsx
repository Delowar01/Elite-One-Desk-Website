"use client";

import { Icon } from "@/components/ui/icon";
import { MOTION_LABEL, type MotionPreset } from "@/lib/cms/motion";
import { motionFieldState, motionTargetOf, type MotionFieldState } from "@/lib/cms/motion-css";
import {
  DELAY_MAX,
  DELAY_STEP,
  DIRECTIONS,
  DURATIONS,
  EASINGS,
  emptyMotionDocument,
  STAGGERS,
  validateMotionDocument,
  type MotionBranch,
  type MotionDocument,
  type MotionTarget,
} from "@/lib/cms/motion-doc";
import { RESPONSIVE_WIDTHS, type Breakpoint } from "@/lib/cms/styles";
import type { Locale } from "@/lib/i18n/config";
import { describeAddress } from "@/lib/visual-editor/labels";
import {
  entrancesFor,
  MOTION_DEFAULT_LABELS,
  MOTION_FIELD_LABELS,
  MOTION_REFUSAL_LABELS,
  MOTION_VALUE_LABELS,
  motionTargetFor,
  offeredMotionFields,
  ownedByParentList,
} from "@/lib/visual-editor/motion-targets";
import type { EditorNodeMeta } from "@/lib/visual-editor/protocol";
import { relativePath } from "@/lib/visual-editor/style-edit";

/**
 * The Motion tab: how the selected thing arrives, at the width being edited.
 *
 * Batch 15a turned this from one five-way choice for the whole section into the
 * same shape as the Style tab — and it follows the Style tab's rules, because an
 * editor moving between the two should not have to learn a second set:
 *
 * **Section or element, said out loud.** Selecting the section edits the
 * section's entrance; selecting anything inside it edits *that* element's own
 * entrance. The heading says which, because the difference is the whole point.
 *
 * **Absence is the default.** Every setting's first option deletes the key —
 * "Default" at Base, "Inherit" at Tablet and Mobile — and never stores the value
 * the engine happens to use today.
 *
 * **Inherited never looks stored.** A setting with no value at this breakpoint
 * says where its value comes from, in words.
 *
 * **Nothing here is free text.** Every option comes from the enumerations the
 * validator checks, and delay is a stepped slider bounded by the same numbers.
 *
 * **A setting appears when it can change something.** Direction only for an
 * entrance that travels, timing only for something that moves at this width,
 * stagger only on a list — decided by `offeredMotionFields`, not here.
 */

const SCOPE: Record<Breakpoint, { title: string; note: string; first: string }> = {
  base: {
    title: "Base",
    note: "Applies at every width unless a narrower one overrides it.",
    first: "Default",
  },
  tablet: {
    title: "Tablet override",
    note: `Overrides Base at ${RESPONSIVE_WIDTHS.tablet}px and below.`,
    first: "Inherit",
  },
  mobile: {
    title: "Mobile override",
    note: `Overrides Tablet and Base at ${RESPONSIVE_WIDTHS.mobile}px and below.`,
    first: "Inherit",
  },
};

const FROM_LABEL: Record<Breakpoint, string> = { base: "Base", tablet: "Tablet", mobile: "Mobile" };

const GROUPS: { title: string; fields: (keyof MotionBranch)[] }[] = [
  { title: "Entrance", fields: ["entrance", "direction"] },
  { title: "Timing", fields: ["duration", "delay", "easing"] },
  { title: "Sequence", fields: ["stagger"] },
];

const DEFAULT = "__default__";

const valueLabel = (field: keyof MotionBranch, value: unknown): string => {
  if (value === undefined) return "";
  if (field === "delay" && typeof value === "number") return `${value}ms`;
  return MOTION_VALUE_LABELS[String(value)] ?? String(value);
};

/** Rebuilds one breakpoint's branch with one field set or cleared. Sparse in, sparse out. */
function withField(
  document: MotionDocument,
  path: string,
  breakpoint: Breakpoint,
  field: keyof MotionBranch,
  value: MotionBranch[keyof MotionBranch] | undefined,
): MotionDocument {
  const next = validateMotionDocument(document);
  const target: MotionTarget = { ...(path === "root" ? next.section : next.nodes[path]) };
  const branch: MotionBranch = { ...target[breakpoint] };
  if (value === undefined) delete branch[field];
  else (branch as Record<string, unknown>)[field] = value;
  if (Object.keys(branch).length) target[breakpoint] = branch;
  else delete target[breakpoint];

  if (path === "root") next.section = target;
  else if (Object.keys(target).length) next.nodes[path] = target;
  else delete next.nodes[path];
  return validateMotionDocument(next);
}

/** Removes one breakpoint's whole branch for one target, keeping the other two. */
function withoutBranch(document: MotionDocument, path: string, breakpoint: Breakpoint): MotionDocument {
  const next = validateMotionDocument(document);
  const target: MotionTarget = { ...(path === "root" ? next.section : next.nodes[path]) };
  delete target[breakpoint];
  if (path === "root") next.section = target;
  else if (Object.keys(target).length) next.nodes[path] = target;
  else delete next.nodes[path];
  return validateMotionDocument(next);
}

export function MotionInspector({
  node,
  document,
  legacy,
  breakpoint,
  locale,
  canManage,
  onChange,
}: {
  node: EditorNodeMeta | null;
  document: MotionDocument;
  /** The preset the section's Base entrance falls back to — `legacyFallback`. */
  legacy: MotionPreset;
  breakpoint: Breakpoint;
  locale: Locale;
  canManage: boolean;
  onChange: (next: MotionDocument) => void;
}) {
  const path = node ? relativePath(node.relativePath) : null;
  if (!node || !path) {
    return (
      <p className="text-[0.76rem] leading-relaxed text-muted">
        Select the section or something inside it to set how it arrives.
      </p>
    );
  }

  const isSection = path === "root";
  const capability = motionTargetFor(node.blockType, path);
  const described = describeAddress(node.blockType, node.relativePath, node.text);
  const scope = SCOPE[breakpoint];
  const doc = document ?? emptyMotionDocument();
  const target = motionTargetOf(doc, path);

  const header = (
    <div>
      <p className="admin-label" data-motion-target={isSection ? "section" : "element"}>
        {isSection ? "Section motion" : "Element motion"}
      </p>
      <p className="mt-1 text-[0.72rem] leading-relaxed text-muted">
        {isSection
          ? "How this whole section arrives when a visitor scrolls to it."
          : (
              <>
                How <span className="text-body">{described.label}</span> arrives on its own, inside
                its section.
              </>
            )}
      </p>
    </div>
  );

  if (capability.kind === null) {
    return (
      <div className="flex flex-col gap-3">
        {header}
        <p className="text-[0.74rem] leading-relaxed text-muted" data-motion-refusal={capability.reason}>
          {MOTION_REFUSAL_LABELS[capability.reason]}
        </p>
      </div>
    );
  }

  // A row of a list that sends its rows in turn: the list owns its entrance.
  if (!isSection && ownedByParentList(doc, path)) {
    return (
      <div className="flex flex-col gap-3">
        {header}
        <p className="text-[0.74rem] leading-relaxed text-muted" data-motion-owned="list">
          This row arrives with its list, which sends its rows in turn. Select the list to change how
          they arrive; the row’s own motion is set aside while the list has a stagger.
        </p>
      </div>
    );
  }

  const offered = new Set(
    offeredMotionFields(capability, target, breakpoint, isSection ? legacy : undefined),
  );
  const branch = target?.[breakpoint] ?? {};
  const overrides = Object.keys(branch).length;
  const set = (field: keyof MotionBranch, value: MotionBranch[keyof MotionBranch] | undefined) =>
    onChange(withField(doc, path, breakpoint, field, value));

  return (
    <div className="flex flex-col gap-3.5">
      {header}

      <div>
        <p className="text-[0.8rem] font-semibold text-strong">{scope.title}</p>
        <p className="mt-0.5 text-[0.7rem] leading-relaxed text-muted">{scope.note}</p>
      </div>

      <p className="text-[0.72rem] text-muted">
        {overrides
          ? `${overrides} setting${overrides === 1 ? "" : "s"} here`
          : breakpoint === "base"
            ? "Nothing set here"
            : "Nothing overridden here"}
      </p>

      <fieldset disabled={!canManage} className="min-w-0 border-0 p-0">
        <div className="flex flex-col gap-4">
          {GROUPS.map(({ title, fields }) => {
            const shown = fields.filter((field) => offered.has(field));
            if (!shown.length) return null;
            return (
              <div key={title} data-motion-group={title.toLowerCase()}>
                <p className="mb-1.5 text-[0.66rem] font-semibold uppercase tracking-[0.07em] text-muted">
                  {title}
                </p>
                <div className="flex flex-col gap-2">
                  {shown.map((field) => (
                    <MotionControl
                      key={field}
                      field={field}
                      state={motionFieldState(target, breakpoint, field)}
                      breakpoint={breakpoint}
                      entrances={entrancesFor(capability)}
                      sectionLegacy={isSection ? legacy : undefined}
                      onChange={set}
                    />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </fieldset>

      {canManage ? (
        <button
          type="button"
          onClick={() => onChange(withoutBranch(doc, path, breakpoint))}
          disabled={!overrides}
          className="admin-btn admin-btn-sm self-start"
        >
          <Icon name="refresh" size={12} />
          {breakpoint !== "base"
            ? `Reset ${FROM_LABEL[breakpoint].toLowerCase()} motion`
            : isSection
              ? "Reset section motion"
              : "Reset motion for this element"}
        </button>
      ) : null}

      <p className="text-[0.7rem] leading-relaxed text-muted">
        {/*
          The truths an editor cannot see from the canvas, written down. The
          first is a promise the stylesheet keeps in its reduced-motion and
          print rules; the second is why Start has no left or right in it.
        */}
        Visitors who ask their device for reduced motion see every element already in place, and so
        does a printed page. A narrower width inherits whatever it does not override.{" "}
        {locale === "ar"
          ? "“From the start edge” follows the reading direction — in Arabic, the right."
          : "“From the start edge” follows the reading direction — the left in English, the right in Arabic."}
      </p>
    </div>
  );
}

function MotionControl({
  field,
  state,
  breakpoint,
  entrances,
  sectionLegacy,
  onChange,
}: {
  field: keyof MotionBranch;
  state: MotionFieldState;
  breakpoint: Breakpoint;
  entrances: readonly string[];
  /** Present for the section wrapper only: the preset its Base entrance falls back to. */
  sectionLegacy?: MotionPreset;
  onChange: (field: keyof MotionBranch, value: MotionBranch[keyof MotionBranch] | undefined) => void;
}) {
  const id = `motion-${field}`;
  const isSet = state.value !== undefined;
  const label = MOTION_FIELD_LABELS[field];

  /**
   * What "no value here" means, said as a name. At Base on the section wrapper
   * the entrance falls back to the legacy preset, and the option says which
   * one, so choosing it is never a guess.
   */
  const defaultText =
    field === "entrance"
      ? sectionLegacy
        ? `${MOTION_LABEL[sectionLegacy]} (legacy default)`
        : "no entrance"
      : MOTION_DEFAULT_LABELS[field];
  const firstLabel =
    breakpoint !== "base"
      ? SCOPE[breakpoint].first
      : field === "entrance" && sectionLegacy
        ? `Legacy default — ${MOTION_LABEL[sectionLegacy]}`
        : `Default — ${defaultText}`;

  const options: readonly (string | number)[] =
    field === "entrance"
      ? entrances
      : field === "direction"
        ? DIRECTIONS
        : field === "duration"
          ? DURATIONS
          : field === "easing"
            ? EASINGS
            : field === "stagger"
              ? STAGGERS
              : [];

  const control =
    field === "delay" ? (
      <>
        <input
          id={id}
          type="range"
          min={0}
          max={DELAY_MAX}
          step={DELAY_STEP}
          value={typeof state.value === "number" ? state.value : typeof state.inherited === "number" ? state.inherited : 0}
          onChange={(event) => onChange(field, Number(event.target.value))}
          className="w-full accent-[var(--color-orange)]"
          aria-valuetext={
            typeof state.value === "number"
              ? `${state.value} milliseconds`
              : typeof state.inherited === "number"
                ? `Inherited: ${state.inherited} milliseconds`
                : "Default: no delay"
          }
        />
        <span className="w-14 shrink-0 text-end text-[0.72rem] tabular-nums text-muted">
          {typeof state.value === "number" ? `${state.value}ms` : "—"}
        </span>
      </>
    ) : (
      <select
        id={id}
        value={state.value === undefined ? DEFAULT : String(state.value)}
        onChange={(event) => {
          const raw = event.target.value;
          onChange(field, raw === DEFAULT ? undefined : (raw as MotionBranch[keyof MotionBranch]));
        }}
        className="admin-select h-[1.8rem] w-full py-0 text-[0.76rem]"
      >
        <option value={DEFAULT}>{firstLabel}</option>
        {options.map((option) => (
          <option key={String(option)} value={String(option)}>
            {valueLabel(field, option)}
          </option>
        ))}
      </select>
    );

  return (
    <div data-motion-field={field} data-motion-state={isSet ? "override" : "inherited"}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className="text-[0.72rem] text-body" htmlFor={id}>
          {label}
        </label>
        {isSet ? (
          <button
            type="button"
            onClick={() => onChange(field, undefined)}
            className="text-[0.66rem] font-semibold uppercase tracking-wide"
            style={{ color: "var(--color-peach)" }}
          >
            {breakpoint === "base" ? "Set · clear" : "Override · inherit"}
          </button>
        ) : (
          <span className="text-[0.66rem] uppercase tracking-wide text-muted">
            {breakpoint === "base" ? "Default" : "Inherited"}
          </span>
        )}
      </div>
      <div className="flex items-center gap-2">{control}</div>
      {!isSet && breakpoint !== "base" ? (
        <p className="mt-1 text-[0.66rem] text-muted">
          {state.from
            ? `Inherited from ${FROM_LABEL[state.from]}: ${valueLabel(field, state.inherited)}`
            : `Inherited: the default — ${defaultText}`}
        </p>
      ) : null}
    </div>
  );
}
