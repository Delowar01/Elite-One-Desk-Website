"use client";

import { Icon } from "@/components/ui/icon";
import {
  ALIGNMENTS,
  BACKGROUNDS,
  BORDERS,
  FONT_SIZES,
  FONT_WEIGHTS,
  MAX_WIDTHS,
  OPACITY_MAX,
  OPACITY_MIN,
  OPACITY_SNAP,
  RADII,
  RESPONSIVE_WIDTHS,
  SHADOWS,
  SPACING_STEPS,
  TEXT_COLORS,
  type Breakpoint,
  type StyleDocument,
  type StyleTokens,
} from "@/lib/cms/styles";
import { describeAddress, describeStoredPath } from "@/lib/visual-editor/labels";
import {
  hiddenBasePaths,
  relativePath,
  tokenState,
  withToken,
  withoutBranch,
  type TokenState,
} from "@/lib/visual-editor/style-edit";
import type { EditorNodeMeta } from "@/lib/visual-editor/protocol";
import type { Locale } from "@/lib/i18n/config";
import {
  STYLE_GROUPS,
  STYLE_GROUP_LABELS,
  STYLE_TOKEN_LABELS,
  styleTargetFor,
  type StyleGroup,
} from "@/lib/visual-editor/style-targets";

/**
 * The Style tab: the selected node's overrides at the width being edited.
 *
 * Four rules the controls below exist to hold.
 *
 * **Absence is the default.** A token that is not in the document means "use
 * what you would have used anyway", and every control's first option is exactly
 * that. At Base that reads as the component's own design; at Tablet and Mobile
 * it reads as the branch above. Choosing it deletes the key rather than storing
 * a value that happens to match today — which would freeze a copy of the design,
 * or of Base, and stop following it the next time either changed.
 *
 * **Inherited never looks stored.** A control with no override at this
 * breakpoint says so in words, beside the value it would take. An editor who
 * cannot tell the two apart cannot tell what resetting would do.
 *
 * **Nothing here is free text.** Every option comes from the enumerations the
 * validator checks against, imported from the same module, so the panel cannot
 * offer something a save would silently drop. Spacing is a step on a scale;
 * colours, radii, borders and shadows are names. There is no field anywhere
 * that accepts a length, a class, or a colour of the editor's choosing.
 *
 * **One document, three branches.** Which branch is edited follows the device
 * being previewed and nothing else, and every write rebuilds the node by
 * spreading what was there, so the two branches not on screen survive an edit
 * and survive a reset.
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

const FROM_LABEL: Record<Breakpoint, string> = {
  base: "Base",
  tablet: "Tablet",
  mobile: "Mobile",
};

/* -------------------------------------------------------------------------- */

export function StyleInspector({
  node,
  styles,
  values,
  locale,
  breakpoint,
  canManage,
  onChange,
}: {
  node: EditorNodeMeta | null;
  styles: StyleDocument;
  /** The section's own content, only ever read to name a hidden row. */
  values: Record<string, unknown>;
  locale: Locale;
  breakpoint: Breakpoint;
  canManage: boolean;
  onChange: (next: StyleDocument) => void;
}) {
  const path = node ? relativePath(node.relativePath) : null;
  if (!node || !path) {
    return (
      <p className="text-[0.76rem] leading-relaxed text-muted">
        Select something on the canvas to style it.
      </p>
    );
  }

  const target = styleTargetFor(node.blockType, path);
  const offered = new Set(target.tokens);
  const stored = styles.nodes[path];
  const branch: StyleTokens = stored?.[breakpoint] ?? {};
  const overrides = Object.keys(branch).length;
  const described = describeAddress(node.blockType, node.relativePath, node.text);
  const scope = SCOPE[breakpoint];

  const set = (token: keyof StyleTokens, value: StyleTokens[keyof StyleTokens] | undefined) =>
    onChange(withToken(styles, path, breakpoint, token, value));

  const groups = (Object.keys(STYLE_GROUPS) as StyleGroup[])
    .map((group) => ({ group, tokens: STYLE_GROUPS[group].filter((token) => offered.has(token)) }))
    .filter((entry) => entry.tokens.length > 0);

  return (
    <div className="flex flex-col gap-3.5">
      <div>
        <p className="text-[0.8rem] font-semibold text-strong">{scope.title}</p>
        <p className="mt-0.5 text-[0.7rem] leading-relaxed text-muted">{scope.note}</p>
      </div>

      <p className="text-[0.72rem] text-muted">
        Styling <span className="text-body">{described.label}</span>
        {overrides
          ? ` · ${overrides} override${overrides === 1 ? "" : "s"} here`
          : breakpoint === "base"
            ? " · no overrides"
            : " · nothing overridden here"}
      </p>

      <fieldset disabled={!canManage} className="min-w-0 border-0 p-0">
        <div className="flex flex-col gap-4">
          {groups.map(({ group, tokens }) => (
            <div key={group}>
              <p className="mb-1.5 text-[0.66rem] font-semibold uppercase tracking-[0.07em] text-muted">
                {STYLE_GROUP_LABELS[group]}
              </p>
              <div className="flex flex-col gap-2">
                {tokens.map((token) => (
                  <Control
                    key={token}
                    token={token}
                    state={tokenState(stored, breakpoint, token)}
                    breakpoint={breakpoint}
                    onChange={set}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      </fieldset>

      {canManage ? (
        <button
          type="button"
          onClick={() => onChange(withoutBranch(styles, path, breakpoint))}
          disabled={!overrides}
          className="admin-btn admin-btn-sm self-start"
        >
          <Icon name="refresh" size={12} />
          {breakpoint === "base"
            ? "Reset styles for this element"
            : `Reset ${FROM_LABEL[breakpoint].toLowerCase()} overrides`}
        </button>
      ) : null}

      {path === "root" ? (
        <HiddenElements
          styles={styles}
          blockType={node.blockType}
          values={values}
          locale={locale}
          canManage={canManage}
          onChange={onChange}
        />
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * The way back from a Base hide.
 *
 * Hiding at Tablet or Mobile is its own undo: switch device, the element comes
 * back, click it, clear the override. Hiding at **Base** is `display: none` at
 * every width, so once the selection that made it is gone — a reload, a new
 * session tomorrow — there is nothing on the canvas to point at. Layers is
 * section-level and stays that way, so the section's own style document is the
 * index instead: a list of what it has hidden, by name, with the one button
 * that undoes it.
 *
 * It lives under the section root because that is the node an editor can always
 * reach — a hidden section is still a row in Layers — and because the question
 * "what has this section got hidden?" is a question about the section.
 *
 * Restore is an edit like any other: it clears the token in the local buffer,
 * the panel goes dirty, and nothing reaches the database until Save styles.
 * There is no second action and nothing is done to the canvas directly.
 */
function HiddenElements({
  styles,
  blockType,
  values,
  locale,
  canManage,
  onChange,
}: {
  styles: StyleDocument;
  blockType: string;
  values: Record<string, unknown>;
  locale: Locale;
  canManage: boolean;
  onChange: (next: StyleDocument) => void;
}) {
  const hidden = hiddenBasePaths(styles);
  if (!hidden.length) return null;

  return (
    <div className="border-t border-[var(--admin-line)] pt-3">
      <p className="mb-1.5 text-[0.66rem] font-semibold uppercase tracking-[0.07em] text-muted">
        Hidden elements
      </p>
      <ul className="flex flex-col gap-1.5" data-hidden-elements>
        {hidden.map((target) => {
          const described = describeStoredPath(blockType, target, values, locale);
          return (
            <li
              key={target}
              data-hidden-path={target}
              className="flex items-center justify-between gap-2"
            >
              <span className="min-w-0">
                <span className="block truncate text-[0.74rem] text-body">{described.label}</span>
                <span className="block text-[0.66rem] text-muted">Hidden at all widths</span>
              </span>
              {canManage ? (
                <button
                  type="button"
                  onClick={() => onChange(withToken(styles, target, "base", "hidden", undefined))}
                  className="admin-btn admin-btn-sm shrink-0"
                >
                  Restore
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

const DEFAULT = "__default__";

/** A token's value in words, for the line that says what is inherited. */
export function describeValue(
  token: keyof StyleTokens,
  value: StyleTokens[keyof StyleTokens] | undefined,
): string {
  if (value === undefined) return "";
  if (token === "hidden") return value ? "Hidden" : "Shown";
  if (token === "opacity" && typeof value === "number") return `${Math.round(value * 100)}%`;
  if ((token === "objectX" || token === "objectY") && typeof value === "number") return `${value}%`;
  if (SPACING.has(token)) return `step ${value}`;
  const text = String(value);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function Control({
  token,
  state,
  breakpoint,
  onChange,
}: {
  token: keyof StyleTokens;
  state: TokenState;
  breakpoint: Breakpoint;
  onChange: (token: keyof StyleTokens, value: StyleTokens[keyof StyleTokens] | undefined) => void;
}) {
  const label = STYLE_TOKEN_LABELS[token];
  // A real label bound to a real control: the token name is the one stable
  // thing about a row, so it is what the pair is keyed on.
  const id = `style-${token}`;
  const { value } = state;
  const row = { token, id, label, state, breakpoint, onClear: () => onChange(token, undefined) };
  // What a slider should sit at when this breakpoint says nothing: the value
  // the element actually has, so dragging it starts where the eye is.
  const shown = value !== undefined ? value : state.inherited;

  if (token === "hidden") {
    return (
      <Row {...row}>
        <select
          id={id}
          value={value === true ? "hide" : DEFAULT}
          onChange={(event) => onChange(token, event.target.value === "hide" ? true : undefined)}
          className="admin-select h-[1.8rem] w-full py-0 text-[0.76rem]"
        >
          {/*
            Two options, not three. "Shown" as a stored value would mean an
            element could be hidden at tablet and brought back at mobile, and
            the panel would then have to explain a node that is invisible in the
            middle of the range and visible either side of it. Hiding runs
            downwards: hide at a width and it stays hidden below it.
          */}
          <option value={DEFAULT}>{SCOPE[breakpoint].first}</option>
          <option value="hide">Hide</option>
        </select>
      </Row>
    );
  }

  if (token === "opacity") {
    return (
      <Row {...row}>
        <input
          id={id}
          type="range"
          min={OPACITY_MIN}
          max={OPACITY_MAX}
          step={OPACITY_SNAP}
          value={typeof shown === "number" ? shown : OPACITY_MAX}
          onChange={(event) => onChange(token, Number(event.target.value))}
          className="w-full accent-[var(--color-orange)]"
        />
        <Readout>{typeof value === "number" ? `${Math.round(value * 100)}%` : "—"}</Readout>
      </Row>
    );
  }

  if (token === "objectX" || token === "objectY") {
    return (
      <Row {...row}>
        <input
          id={id}
          type="range"
          min={0}
          max={100}
          step={1}
          value={typeof shown === "number" ? shown : 50}
          onChange={(event) => onChange(token, Number(event.target.value))}
          className="w-full accent-[var(--color-orange)]"
        />
        <Readout>{typeof value === "number" ? `${value}%` : "—"}</Readout>
      </Row>
    );
  }

  if (SPACING.has(token)) {
    return (
      <Row {...row}>
        <input
          id={id}
          type="range"
          min={0}
          max={SPACING_STEPS}
          step={1}
          value={typeof shown === "number" ? shown : 0}
          onChange={(event) => onChange(token, Number(event.target.value))}
          className="w-full accent-[var(--color-orange)]"
        />
        <Readout>{typeof value === "number" ? value : "—"}</Readout>
      </Row>
    );
  }

  const options = OPTIONS[token] ?? [];
  return (
    <Row {...row}>
      <select
        id={id}
        value={value === undefined ? DEFAULT : String(value)}
        onChange={(event) => {
          const raw = event.target.value;
          if (raw === DEFAULT) return onChange(token, undefined);
          const numeric = options.find((option) => typeof option === "number" && String(option) === raw);
          onChange(token, (numeric ?? raw) as StyleTokens[keyof StyleTokens]);
        }}
        className="admin-select h-[1.8rem] w-full py-0 text-[0.76rem]"
      >
        <option value={DEFAULT}>{SCOPE[breakpoint].first}</option>
        {options.map((option) => (
          <option key={String(option)} value={String(option)}>
            {String(option)}
          </option>
        ))}
      </select>
    </Row>
  );
}

const Readout = ({ children }: { children: React.ReactNode }) => (
  <span className="w-9 shrink-0 text-end text-[0.72rem] tabular-nums text-muted">{children}</span>
);

const SPACING = new Set<keyof StyleTokens>([
  "padBlock",
  "padInline",
  "marginBlock",
  "marginInline",
  "gap",
]);

/**
 * The options each control offers, taken from the validator's own lists. A
 * value the panel can show is a value the save will keep, by construction.
 */
const OPTIONS: Partial<Record<keyof StyleTokens, readonly (string | number)[]>> = {
  align: ALIGNMENTS,
  fontSize: FONT_SIZES,
  fontWeight: FONT_WEIGHTS,
  textColor: TEXT_COLORS,
  background: BACKGROUNDS,
  radius: RADII,
  border: BORDERS,
  shadow: SHADOWS,
  maxWidth: MAX_WIDTHS,
};

function Row({
  token,
  id,
  label,
  state,
  breakpoint,
  onClear,
  children,
}: {
  token: keyof StyleTokens;
  id: string;
  label: string;
  state: TokenState;
  breakpoint: Breakpoint;
  onClear: () => void;
  children: React.ReactNode;
}) {
  const isSet = state.value !== undefined;
  const inherited = state.inherited !== undefined ? describeValue(token, state.inherited) : "";

  return (
    <div data-style-token={token} data-style-state={isSet ? "override" : "inherited"}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className="text-[0.72rem] text-body" htmlFor={id}>
          {label}
        </label>
        {/* A set token says so, and says how to put it back. Without this an
            editor cannot tell an override from what is underneath it. */}
        {isSet ? (
          <button
            type="button"
            onClick={onClear}
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
      <div className="flex items-center gap-2">{children}</div>
      {/*
        What this row would show if nobody overrode it here, and where that
        comes from. "Component default" rather than a colour or a size, because
        the only honest source for the design's own value is the stylesheet —
        and a panel that read it back would be one button away from storing a
        copy of it.
      */}
      {!isSet && breakpoint !== "base" ? (
        <p className="mt-1 text-[0.66rem] text-muted">
          {state.from
            ? `Inherited from ${FROM_LABEL[state.from]}: ${inherited}`
            : "Inherited: component default"}
        </p>
      ) : null}
    </div>
  );
}
