import { formatNodePath, parseNodePath } from "@/lib/cms/address";
import {
  STYLE_DOCUMENT_VERSION,
  type Breakpoint,
  type StyleDocument,
  type StyleNode,
  type StyleTokens,
} from "@/lib/cms/styles";

/**
 * The edits the Style panel can make to a document, and what a control has to
 * know to draw itself honestly.
 *
 * Kept out of the React component because they are the contract rather than
 * the controls: sparse in, sparse out, and never a branch the editor cannot
 * see. They are worth testing on their own, and a rule about what a reset must
 * not delete should not be buried in a `<select>`.
 *
 * Two invariants run through all of it:
 *
 *   **Absence is the default.** A token set back to default is deleted, never
 *   stored as the value the design happens to use today. At a breakpoint the
 *   same rule reads as *inherit*: deleting the tablet key is what makes tablet
 *   follow base again, and writing base's current value into tablet would
 *   freeze a copy of it — the two would then part company the next time
 *   anybody changed base, and nothing in the panel would say so.
 *
 *   **The other branches survive.** Every write rebuilds the node by spreading
 *   what was there, so editing mobile leaves base and tablet exactly where they
 *   were, and resetting one breakpoint is not a reset of the node. Deleting
 *   data the editor is not looking at is not a reset, it is a loss.
 */

const EMPTY_NODE: StyleNode = {};

/**
 * Which branches a breakpoint inherits from, nearest last.
 *
 * Mobile inherits **through** tablet: a phone shows the tablet's smaller
 * heading unless mobile says otherwise. Listing base first and tablet second is
 * what makes "the last one that has it wins" produce that.
 */
export const INHERITS_FROM: Record<Breakpoint, readonly Breakpoint[]> = {
  base: [],
  tablet: ["base"],
  mobile: ["base", "tablet"],
};

/** The relative path an address names, normalised, or null if it names none. */
export function relativePath(path: string | undefined): string | null {
  const parsed = parseNodePath(path === undefined ? "root" : path);
  return parsed ? formatNodePath(parsed) : null;
}

/** Sets or clears one token on one branch. Clearing is `undefined`. */
export function withToken(
  document: StyleDocument,
  path: string,
  breakpoint: Breakpoint,
  token: keyof StyleTokens,
  value: StyleTokens[keyof StyleTokens] | undefined,
): StyleDocument {
  const node = document.nodes[path] ?? EMPTY_NODE;
  const branch: StyleTokens = { ...node[breakpoint] };
  if (value === undefined) delete branch[token];
  else (branch as Record<string, unknown>)[token] = value;

  const next: StyleNode = { ...node };
  if (Object.keys(branch).length) next[breakpoint] = branch;
  else delete next[breakpoint];

  const nodes = { ...document.nodes };
  if (Object.keys(next).length) nodes[path] = next;
  else delete nodes[path];

  return { v: STYLE_DOCUMENT_VERSION, nodes };
}

/** Removes one node's branch at one breakpoint, keeping the other two. */
export function withoutBranch(
  document: StyleDocument,
  path: string,
  breakpoint: Breakpoint,
): StyleDocument {
  const node = document.nodes[path];
  if (!node?.[breakpoint]) return document;
  const next: StyleNode = { ...node };
  delete next[breakpoint];
  const nodes = { ...document.nodes };
  if (Object.keys(next).length) nodes[path] = next;
  else delete nodes[path];
  return { v: STYLE_DOCUMENT_VERSION, nodes };
}

/**
 * What one control should say about itself.
 *
 * `value` is what this breakpoint stores — an override, or nothing.
 * `inherited` is what the element would show without it, and `from` is the
 * branch that supplies it, or `null` for "whatever the component's own design
 * does". That last answer is deliberately vague: the honest way to know the
 * design's colour is to read the stylesheet, and a panel that scraped a
 * computed value would be storing a copy of the design the moment anybody
 * pressed a button.
 */
export type TokenState = {
  value: StyleTokens[keyof StyleTokens] | undefined;
  inherited: StyleTokens[keyof StyleTokens] | undefined;
  from: Breakpoint | null;
};

export function tokenState(
  node: StyleNode | undefined,
  breakpoint: Breakpoint,
  token: keyof StyleTokens,
): TokenState {
  const value = node?.[breakpoint]?.[token];
  let inherited: StyleTokens[keyof StyleTokens] | undefined;
  let from: Breakpoint | null = null;
  for (const parent of INHERITS_FROM[breakpoint]) {
    const candidate = node?.[parent]?.[token];
    if (candidate !== undefined) {
      inherited = candidate;
      from = parent;
    }
  }
  return { value, inherited, from };
}

/**
 * The paths a section has hidden at Base, in the order they were written.
 *
 * This is the one override an editor cannot undo by looking somewhere else. A
 * mobile hide is recoverable by switching to Tablet, a tablet hide by switching
 * to Desktop — the element comes back, gets clicked, and the control is right
 * there. A *Base* hide is `display: none` at every width, so the moment the
 * selection that made it is gone — a reload, a new session tomorrow — there is
 * nothing on the canvas left to point at, and Layers is section-level by
 * design.
 *
 * So the section's own document is the index: the panel reads the hidden
 * descendants back out of it and offers each one by name. `root` is excluded
 * because a hidden section is still a row in Layers, and clicking that row
 * selects it however much of it is drawn.
 */
export function hiddenBasePaths(document: StyleDocument): string[] {
  return Object.entries(document.nodes)
    .filter(([path, node]) => path !== "root" && node.base?.hidden === true)
    .map(([path]) => path);
}
