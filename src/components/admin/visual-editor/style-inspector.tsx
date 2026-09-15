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
  SHADOWS,
  SPACING_STEPS,
  TEXT_COLORS,
  type StyleDocument,
  type StyleTokens,
} from "@/lib/cms/styles";
import { describeAddress } from "@/lib/visual-editor/labels";
import { relativePath, withToken, withoutBase } from "@/lib/visual-editor/style-edit";
import type { EditorNodeMeta } from "@/lib/visual-editor/protocol";
import {
  STYLE_GROUPS,
  STYLE_GROUP_LABELS,
  STYLE_TOKEN_LABELS,
  styleTargetFor,
  type StyleGroup,
} from "@/lib/visual-editor/style-targets";

/**
 * The Style tab: the selected node's Base overrides, and nothing else.
 *
 * Three rules the controls below exist to hold.
 *
 * **Absence is the default.** A token that is not in the document means "use the
 * component's own design", and every control's first option is exactly that.
 * Choosing it deletes the key rather than storing a value that happens to match
 * today's design — which would freeze a copy of the design and stop following
 * it the next time somebody changes the stylesheet.
 *
 * **Nothing here is free text.** Every option comes from the enumerations the
 * validator checks against, imported from the same module, so the panel cannot
 * offer something a save would silently drop. Spacing is a step on a scale;
 * colours, radii, borders and shadows are names. There is no field anywhere
 * that accepts a length, a class, or a colour of the editor's choosing.
 *
 * **Base only.** The document has tablet and mobile branches and this batch does
 * not edit them — but every write below rebuilds the node by spreading what was
 * there, so a branch nobody can see yet survives an edit and survives a reset.
 */

type Domain = { styles: StyleDocument; path: string; blockType: string };

/* -------------------------------------------------------------------------- */

export function StyleInspector({
  node,
  styles,
  canManage,
  onChange,
}: {
  node: EditorNodeMeta | null;
  styles: StyleDocument;
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

  const domain: Domain = { styles, path, blockType: node.blockType };
  const target = styleTargetFor(node.blockType, path);
  const offered = new Set(target.tokens);
  const base: StyleTokens = styles.nodes[path]?.base ?? {};
  const overrides = Object.keys(base).length;
  const described = describeAddress(node.blockType, node.relativePath, node.text);

  const set = (token: keyof StyleTokens, value: StyleTokens[keyof StyleTokens] | undefined) =>
    onChange(withToken(domain.styles, domain.path, token, value));

  const groups = (Object.keys(STYLE_GROUPS) as StyleGroup[])
    .map((group) => ({ group, tokens: STYLE_GROUPS[group].filter((token) => offered.has(token)) }))
    .filter((entry) => entry.tokens.length > 0);

  return (
    <div className="flex flex-col gap-3.5">
      <div>
        <p className="text-[0.8rem] font-semibold text-strong">Base style</p>
        <p className="mt-0.5 text-[0.7rem] leading-relaxed text-muted">
          Applies at every width. Tablet and mobile overrides arrive in the responsive batch.
        </p>
      </div>

      <p className="text-[0.72rem] text-muted">
        Styling <span className="text-body">{described.label}</span>
        {overrides ? ` · ${overrides} override${overrides === 1 ? "" : "s"}` : " · no overrides"}
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
                  <Control key={token} token={token} value={base[token]} onChange={set} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </fieldset>

      {canManage ? (
        <button
          type="button"
          onClick={() => onChange(withoutBase(domain.styles, domain.path))}
          disabled={!overrides}
          className="admin-btn admin-btn-sm self-start"
        >
          <Icon name="refresh" size={12} />
          Reset styles for this element
        </button>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

const DEFAULT = "__default__";

function Control({
  token,
  value,
  onChange,
}: {
  token: keyof StyleTokens;
  value: StyleTokens[keyof StyleTokens] | undefined;
  onChange: (token: keyof StyleTokens, value: StyleTokens[keyof StyleTokens] | undefined) => void;
}) {
  const label = STYLE_TOKEN_LABELS[token];
  // A real label bound to a real control: the token name is the one stable
  // thing about a row, so it is what the pair is keyed on.
  const id = `style-${token}`;

  if (token === "opacity") {
    return (
      <Row token={token} id={id} label={label} isSet={value !== undefined} onClear={() => onChange(token, undefined)}>
        <input
          id={id}
          type="range"
          min={OPACITY_MIN}
          max={OPACITY_MAX}
          step={OPACITY_SNAP}
          value={typeof value === "number" ? value : OPACITY_MAX}
          onChange={(event) => onChange(token, Number(event.target.value))}
          className="w-full accent-[var(--color-orange)]"
        />
        <span className="w-9 shrink-0 text-end text-[0.72rem] tabular-nums text-muted">
          {typeof value === "number" ? `${Math.round(value * 100)}%` : "—"}
        </span>
      </Row>
    );
  }

  if (token === "objectX" || token === "objectY") {
    return (
      <Row token={token} id={id} label={label} isSet={value !== undefined} onClear={() => onChange(token, undefined)}>
        <input
          id={id}
          type="range"
          min={0}
          max={100}
          step={1}
          value={typeof value === "number" ? value : 50}
          onChange={(event) => onChange(token, Number(event.target.value))}
          className="w-full accent-[var(--color-orange)]"
        />
        <span className="w-9 shrink-0 text-end text-[0.72rem] tabular-nums text-muted">
          {typeof value === "number" ? `${value}%` : "—"}
        </span>
      </Row>
    );
  }

  if (SPACING.has(token)) {
    return (
      <Row token={token} id={id} label={label} isSet={value !== undefined} onClear={() => onChange(token, undefined)}>
        <input
          id={id}
          type="range"
          min={0}
          max={SPACING_STEPS}
          step={1}
          value={typeof value === "number" ? value : 0}
          onChange={(event) => onChange(token, Number(event.target.value))}
          className="w-full accent-[var(--color-orange)]"
        />
        <span className="w-9 shrink-0 text-end text-[0.72rem] tabular-nums text-muted">
          {typeof value === "number" ? value : "—"}
        </span>
      </Row>
    );
  }

  const options = OPTIONS[token] ?? [];
  return (
    <Row token={token} id={id} label={label} isSet={value !== undefined} onClear={() => onChange(token, undefined)}>
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
        <option value={DEFAULT}>Default</option>
        {options.map((option) => (
          <option key={String(option)} value={String(option)}>
            {String(option)}
          </option>
        ))}
      </select>
    </Row>
  );
}

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
  isSet,
  onClear,
  children,
}: {
  token: keyof StyleTokens;
  id: string;
  label: string;
  isSet: boolean;
  onClear: () => void;
  children: React.ReactNode;
}) {
  return (
    <div data-style-token={token}>
      <div className="mb-1 flex items-center justify-between gap-2">
        <label className="text-[0.72rem] text-body" htmlFor={id}>
          {label}
        </label>
        {/* A set token says so, and says how to put it back. Without this an
            editor cannot tell an override from the design underneath it. */}
        {isSet ? (
          <button
            type="button"
            onClick={onClear}
            className="text-[0.66rem] font-semibold uppercase tracking-wide"
            style={{ color: "var(--color-peach)" }}
          >
            Set · clear
          </button>
        ) : (
          <span className="text-[0.66rem] uppercase tracking-wide text-muted">Default</span>
        )}
      </div>
      <div className="flex items-center gap-2">{children}</div>
    </div>
  );
}
