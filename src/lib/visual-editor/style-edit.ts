import { formatNodePath, parseNodePath } from "@/lib/cms/address";
import {
  STYLE_DOCUMENT_VERSION,
  type StyleDocument,
  type StyleNode,
  type StyleTokens,
} from "@/lib/cms/styles";

/**
 * The three edits the Style panel can make to a document.
 *
 * Kept out of the React component because they are the contract rather than
 * the controls: sparse in, sparse out, and never a branch the editor cannot
 * see. They are worth testing on their own, and a rule about what a reset must
 * not delete should not be buried in a `<select>`.
 *
 * Two invariants run through all three:
 *
 *   **Absence is the default.** A token set back to default is deleted, never
 *   stored as the value the design happens to use today. Storing it would
 *   freeze a copy of the design and stop following it the next time anybody
 *   changed the stylesheet.
 *
 *   **Responsive branches survive.** This batch edits `base` only, and tablet
 *   and mobile are branches nobody can see yet. Every write rebuilds the node
 *   by spreading what was there, so an edit — and a reset — leaves them exactly
 *   where they were. Deleting data the editor has no way to look at first is
 *   not a reset, it is a loss.
 */

const EMPTY_NODE: StyleNode = {};

/** The relative path an address names, normalised, or null if it names none. */
export function relativePath(path: string | undefined): string | null {
  const parsed = parseNodePath(path === undefined ? "root" : path);
  return parsed ? formatNodePath(parsed) : null;
}

export function withToken(
  document: StyleDocument,
  path: string,
  token: keyof StyleTokens,
  value: StyleTokens[keyof StyleTokens] | undefined,
): StyleDocument {
  const node = document.nodes[path] ?? EMPTY_NODE;
  const base: StyleTokens = { ...node.base };
  if (value === undefined) delete base[token];
  else (base as Record<string, unknown>)[token] = value;

  const next: StyleNode = { ...node };
  if (Object.keys(base).length) next.base = base;
  else delete next.base;

  const nodes = { ...document.nodes };
  if (Object.keys(next).length) nodes[path] = next;
  else delete nodes[path];

  return { v: STYLE_DOCUMENT_VERSION, nodes };
}

/** Removes one node's Base branch, keeping any responsive branches it has. */
export function withoutBase(document: StyleDocument, path: string): StyleDocument {
  const node = document.nodes[path];
  if (!node?.base) return document;
  const next: StyleNode = { ...node };
  delete next.base;
  const nodes = { ...document.nodes };
  if (Object.keys(next).length) nodes[path] = next;
  else delete nodes[path];
  return { v: STYLE_DOCUMENT_VERSION, nodes };
}
