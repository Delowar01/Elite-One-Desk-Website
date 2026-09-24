import { formatAddress, formatNodePath, parseAddress } from "@/lib/cms/address";
import { LOCALES, type Locale } from "@/lib/i18n/config";
import { isUsableRect, type Rect } from "./overlay";
import type { EditorNodeKind } from "./render";

/**
 * The only language the Visual Editor and its canvas speak.
 *
 * The canvas is the real public page in an iframe, so editor and website are
 * two documents that have to talk. `postMessage` is the mechanism; this module
 * is the vocabulary, and it is deliberately closed — a message that is not one
 * of the shapes declared here is not a message, it is noise from something
 * else on the page, and it is dropped without comment.
 *
 * Three things this is NOT:
 *
 *   · **Authentication.** `bridgeId` correlates one editor shell with one
 *     canvas document so a stale iframe cannot answer for a fresh one. It is
 *     not a credential and proves nothing about who is asking. Authority comes
 *     from the admin session cookie on the canvas request, checked server-side
 *     in `lib/preview.ts` before editor mode exists at all.
 *   · **A place for secrets.** No cookie, CSRF token, password or key ever
 *     travels in a payload or an iframe URL. A `postMessage` is readable by any
 *     script in the receiving document.
 *   · **Finished.** Version 2 adds selection: what the page is made of, what
 *     the pointer is over, what is selected and where it sits. That is the
 *     whole vocabulary of V1 — content, style and motion are edited through
 *     Server Actions and never travel over this channel, so nothing in the
 *     finished editor raised it again.
 *
 * Both ends check origin and source as well as the fields below; neither alone
 * is enough. See `bridgeOrigin` for why the origin is the window's own.
 */

export const EDITOR_CHANNEL = "eod.visual-editor";

/**
 * Raised whenever a message shape changes. A mismatch is silence, not a guess.
 *
 * 1 — the page-level handshake.
 * 2 — selection: structure, hover, selection, bounds, and the editor's own
 *     `select` / `clearSelection`.
 * 3 — the full tree, locking and direct text editing: every annotated node
 *     rides with its section, the editor can tell the canvas which addresses
 *     the pointer must ignore, and a node being typed into reports what it
 *     now says. Still nothing that writes: `canvas.edit` carries the text a
 *     person typed, and the editor decides which field that belongs in.
 *
 * Bumped rather than extended in place: a canvas document served by an older
 * build must not answer a newer editor with a message the editor will read
 * half of. The two simply do not recognise each other, which is the outcome
 * that cannot go subtly wrong.
 */
export const PROTOCOL_VERSION = 3;

/* -------------------------------------------------------------------------- */
/* Bridge ids                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Opaque, url-safe, and long enough that a stale iframe cannot collide with a
 * fresh one. Not secret — it rides in the canvas URL, which is in the browser's
 * history and the server's access log.
 */
export const BRIDGE_ID_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export const isBridgeId = (value: unknown): value is string =>
  typeof value === "string" && BRIDGE_ID_PATTERN.test(value);

export function newBridgeId(): string {
  const bytes = new Uint8Array(18);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

/* -------------------------------------------------------------------------- */
/* Messages                                                                   */
/* -------------------------------------------------------------------------- */

/* -------------------------------------------------------------------------- */
/* Nodes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * One thing an editor can point at.
 *
 * Identity is the stable address and nothing else. No `outerHTML`, no class
 * list, no CSS selector, no DOM index — those are descriptions of how the page
 * happens to be built today, and a selection that survives an edit cannot be
 * built on any of them.
 *
 * `text` is a short plain-text excerpt of what the node currently shows, for
 * the inspector to label a row by. It is text, trimmed and capped; it is never
 * markup, and nothing is ever written back from it.
 */
export type EditorNodeMeta = {
  address: string;
  kind: EditorNodeKind;
  sectionId: number;
  blockType: string;
  /** The address without its section — what Batch 2 persists a style under. */
  relativePath: string;
  text?: string;
};

/**
 * One annotated node inside a section, as the canvas found it.
 *
 * Lighter than `EditorNodeMeta` because everything it would repeat is already
 * on the section it rides with: a page with two hundred nodes would otherwise
 * send the block type two hundred times to say what one section header already
 * says. The address is still the whole identity.
 *
 * `edit` is what the *renderer* decided, from the block registry, about whether
 * this node's text may be typed into directly. It is advice to the panel about
 * which rows to offer an "Edit text" action on; it is not permission, and the
 * editor checks the registry again before it writes anything.
 */
export type EditorTreeNode = {
  address: string;
  kind: EditorNodeKind;
  /** The address without its section — what Batch 2 persists a style under. */
  relativePath: string;
  text?: string;
  edit?: "text" | "multiline";
};

/**
 * One section of the page as the canvas actually rendered it.
 *
 * The canvas is the source of truth for Layers on purpose: it has been through
 * the draft structure, the draft-only rows and the preview membership, so
 * asking the database a second question could only produce a list that
 * disagrees with what is on screen.
 */
export type EditorSectionMeta = {
  address: string;
  sectionId: number;
  blockType: string;
  /** Position in the rendered composition, from DOM order. */
  position: number;
  isDraft: boolean;
  isDraftOnly: boolean;
  /** The visibility this section would have once published. */
  visible: boolean;
  /**
   * Every annotated node inside this section, in the order the document has
   * them — the material the Layers tree is built from.
   *
   * Flat, and nested afterwards by parsing the addresses, because the DOM's
   * containment and the address's are two different questions and only one of
   * them is stable. A card's label is inside its row because the *path* says
   * so, whatever the markup does to lay it out.
   */
  nodes: EditorTreeNode[];
};

const MAX_TEXT = 120;
const MAX_SECTIONS = 200;
const MAX_NODES = 400;
const MAX_LOCKS = 400;
const MAX_RECT = 200_000;

/**
 * The canvas announcing what it is.
 *
 * Posted when the bridge mounts and again in answer to every `editor.ping`.
 * Repeating it is deliberate: it makes the handshake self-healing. If the very
 * first announcement is posted a fraction before the editor attaches its
 * listener, the next ping recovers it rather than leaving the canvas stuck on
 * "Connecting…" forever.
 *
 * `innerWidth` is the canvas document's own `window.innerWidth`. It is what
 * proves the iframe really has the logical width the device switch claims,
 * measured by the page rather than asserted by the editor.
 */
export type CanvasReady = {
  type: "canvas.ready";
  pageId: number;
  slug: string;
  locale: Locale;
  innerWidth: number;
};

/** Liveness. The channel works in both directions, whatever else is true. */
export type CanvasPong = { type: "canvas.pong"; at: number };

/** What the page is made of, in the order it rendered. Sent with every ready. */
export type CanvasStructure = { type: "canvas.structure"; sections: EditorSectionMeta[] };

/** What the pointer is over, or nothing. Rect is in canvas-viewport space. */
export type CanvasHover = { type: "canvas.hover"; node: EditorNodeMeta; rect: Rect } | {
  type: "canvas.hover";
  node: null;
  rect: null;
};

/**
 * What is selected, or nothing.
 *
 * `rect: null` with a node is a real state, not a malformed message: the
 * element is in the document and has nothing to draw around. A section hidden
 * at this breakpoint is the ordinary case — `display: none` measures 0×0 — and
 * so is a reveal that has not run, or anything mid-transition. Selecting it is
 * how an editor gets the control that un-hides it back, so "no rectangle" has
 * to mean "no outline this frame" rather than "no selection". Hover is
 * different and stays strict: there is nothing to hover if there is nothing
 * under the pointer.
 *
 * Three shapes are legal and nothing else is: `{node, rect}`, `{node, null}`
 * and `{null, null}`. A rectangle the reader cannot make sense of is refused
 * rather than rounded down to the second of those — see the reader.
 */
export type CanvasSelection =
  | { type: "canvas.selection"; node: EditorNodeMeta; rect: Rect | null }
  | { type: "canvas.selection"; node: null; rect: null };

/**
 * The selected node has moved.
 *
 * Its own message rather than a re-sent selection, because this fires on every
 * scroll and resize: repeating the whole node each time would be sending the
 * address, block type and excerpt over and over to say one rectangle changed.
 * `rect: null` means the node is no longer measurable — gone, or collapsed.
 */
export type CanvasBounds =
  | { type: "canvas.bounds"; address: string; rect: Rect }
  | { type: "canvas.bounds"; address: string; rect: null };

/**
 * A node is being typed into, and what it now says.
 *
 * `text` is plain text taken from the element being edited — never markup, and
 * never the document. It is the same kind of thing an `<input>`'s `value` is:
 * what a person typed. The editor resolves the address against the section's
 * server-loaded values and writes that string into the field the registry says
 * it belongs to, and the ordinary validator and autosave do the rest. The
 * canvas is an input device here, not a source document.
 *
 * Four phases, so the editor can tell a commit from an abandonment: `start`
 * when editing begins, `input` while it changes, `commit` when it is accepted
 * (blur, Enter on a single-line field, or the panel closing it) and `cancel`
 * when Escape puts it back.
 */
export type CanvasEdit = {
  type: "canvas.edit";
  address: string;
  phase: "start" | "input" | "commit" | "cancel";
  text: string;
};

/** The canvas could not do something. One safe sentence, never an exception. */
export type CanvasError = { type: "canvas.error"; message: string };

/**
 * Which addresses the canvas pointer must ignore.
 *
 * The whole set, every time, rather than add/remove deltas: a delta protocol
 * has to be applied in order and survives neither a reload nor a dropped
 * message, and "what is locked" is small enough to state outright. An empty
 * list is a legitimate message and means nothing is locked.
 *
 * Locking is an editing convenience and never a permission. It stops a pointer
 * inside this one canvas; it is not sent to the server, not stored, and grants
 * and denies nothing. Every write still goes through the same Server Action
 * checks it always did.
 */
export type EditorLocks = { type: "editor.locks"; addresses: string[] };

/**
 * Begin — or end — direct text editing of one node.
 *
 * Sent when an editor asks for it explicitly from the panel. A double-click on
 * the canvas needs no message: the canvas starts it and reports back.
 */
export type EditorEdit = { type: "editor.edit"; address: string; active: boolean };

export type EditorPing = { type: "editor.ping"; at: number };

/** Select by stable address — what a click on a Layers row sends. */
export type EditorSelect = { type: "editor.select"; address: string; scrollIntoView: boolean };

export type EditorClearSelection = { type: "editor.clearSelection" };

export type CanvasMessage =
  | CanvasReady
  | CanvasPong
  | CanvasError
  | CanvasStructure
  | CanvasHover
  | CanvasSelection
  | CanvasBounds
  | CanvasEdit;

export type EditorMessage =
  | EditorPing
  | EditorSelect
  | EditorClearSelection
  | EditorLocks
  | EditorEdit;

export type Envelope<T> = {
  channel: typeof EDITOR_CHANNEL;
  v: number;
  bridgeId: string;
  message: T;
};

export const envelope = <T>(bridgeId: string, message: T): Envelope<T> => ({
  channel: EDITOR_CHANNEL,
  v: PROTOCOL_VERSION,
  bridgeId,
  message,
});

/* -------------------------------------------------------------------------- */
/* Reading                                                                    */
/* -------------------------------------------------------------------------- */

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const isInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= 0;

const isSectionId = (value: unknown): value is number => isInt(value) && value > 0;

const NODE_KINDS = new Set<string>(["section", "field", "item", "slot"]);

/**
 * A rectangle worth accepting.
 *
 * `isUsableRect` already refuses NaN, Infinity and zero size. The bound on top
 * of it is not paranoia about a hostile canvas — it is the same origin — but
 * about a measurement taken mid-transition: an element inside an animating
 * container can report a width in the millions for one frame, and an overlay
 * drawn from it paints over the whole editor.
 */
function readRect(value: unknown): Rect | null {
  if (!isUsableRect(value)) return null;
  const { x, y, width, height } = value;
  if (Math.abs(x) > MAX_RECT || Math.abs(y) > MAX_RECT) return null;
  if (width > MAX_RECT || height > MAX_RECT) return null;
  return { x, y, width, height };
}

/**
 * Node metadata, rebuilt field by field.
 *
 * The address is parsed with the Batch 2 parser rather than pattern-matched
 * here, so there is exactly one definition of what an address is; and the
 * section id inside it has to agree with the one alongside it, because two
 * fields that can disagree are a bug waiting for the day they do.
 */
function readNode(value: unknown): EditorNodeMeta | null {
  const source = asRecord(value);
  if (!source) return null;

  const { address, kind, sectionId, blockType, relativePath, text } = source;
  if (typeof address !== "string") return null;
  const parsed = parseAddress(address);
  if (!parsed) return null;
  if (typeof kind !== "string" || !NODE_KINDS.has(kind)) return null;
  if (!isSectionId(sectionId) || sectionId !== parsed.sectionId) return null;
  if (typeof blockType !== "string" || !blockType || blockType.length > 48) return null;
  if (typeof relativePath !== "string" || !relativePath) return null;
  // The relative half must be the address without its section, not a second
  // opinion about where the node is.
  if (relativePath !== formatNodePath(parsed.path)) return null;
  if (kind === "section" && parsed.path.length) return null;

  const meta: EditorNodeMeta = {
    address: formatAddress(parsed.sectionId, parsed.path),
    kind: kind as EditorNodeKind,
    sectionId: parsed.sectionId,
    blockType,
    relativePath,
  };
  if (typeof text === "string" && text.trim()) meta.text = text.slice(0, MAX_TEXT);
  return meta;
}

/**
 * One node of a section's tree.
 *
 * The address is parsed with the same parser everything else uses, and it must
 * name *this* section: a node claiming to belong to a section it is not inside
 * would put a row under the wrong parent in Layers and select the wrong thing
 * when clicked. A section root is not a node of its own tree — it is the tree.
 */
function readTreeNode(value: unknown, sectionId: number): EditorTreeNode | null {
  const source = asRecord(value);
  if (!source) return null;

  const { address, kind, relativePath, text, edit } = source;
  if (typeof address !== "string") return null;
  const parsed = parseAddress(address);
  if (!parsed || parsed.sectionId !== sectionId) return null;
  if (!parsed.path.length) return null;
  if (typeof kind !== "string" || !NODE_KINDS.has(kind) || kind === "section") return null;
  if (typeof relativePath !== "string" || relativePath !== formatNodePath(parsed.path)) return null;

  const node: EditorTreeNode = {
    address: formatAddress(parsed.sectionId, parsed.path),
    kind: kind as EditorNodeKind,
    relativePath,
  };
  if (typeof text === "string" && text.trim()) node.text = text.slice(0, MAX_TEXT);
  if (edit === "text" || edit === "multiline") node.edit = edit;
  return node;
}

function readSection(value: unknown): EditorSectionMeta | null {
  const source = asRecord(value);
  if (!source) return null;
  const parsed = typeof source.address === "string" ? parseAddress(source.address) : null;
  if (!parsed || parsed.path.length) return null;
  if (!isSectionId(source.sectionId) || source.sectionId !== parsed.sectionId) return null;
  if (typeof source.blockType !== "string" || !source.blockType) return null;
  if (!isInt(source.position)) return null;
  if (typeof source.isDraft !== "boolean") return null;
  if (typeof source.isDraftOnly !== "boolean") return null;
  if (typeof source.visible !== "boolean") return null;
  /**
   * A node the reader refuses loses a Layers row; refusing the section would
   * lose the section. The same rule the structure message already applies to a
   * bad section, one level down.
   */
  const nodes: EditorTreeNode[] = [];
  if (source.nodes !== undefined) {
    if (!Array.isArray(source.nodes)) return null;
    if (source.nodes.length > MAX_NODES) return null;
    for (const entry of source.nodes) {
      const node = readTreeNode(entry, parsed.sectionId);
      if (node) nodes.push(node);
    }
  }

  return {
    address: formatAddress(parsed.sectionId, []),
    sectionId: parsed.sectionId,
    blockType: source.blockType,
    position: source.position,
    isDraft: source.isDraft,
    isDraftOnly: source.isDraftOnly,
    visible: source.visible,
    nodes,
  };
}

/** The envelope, or null. Nothing inside it is trusted until the type is known. */
function openEnvelope(data: unknown, expect: { bridgeId: string }): Record<string, unknown> | null {
  const outer = asRecord(data);
  if (!outer) return null;
  if (outer.channel !== EDITOR_CHANNEL) return null;
  if (outer.v !== PROTOCOL_VERSION) return null;
  if (!isBridgeId(outer.bridgeId) || outer.bridgeId !== expect.bridgeId) return null;
  return asRecord(outer.message);
}

/**
 * A message from the canvas, as the editor should read it.
 *
 * `slug` is checked when the caller names one, because the editor asks a
 * specific page to load: an answer from a document that is on some other page
 * means the canvas navigated, and acting on it would attach the editor to the
 * wrong page.
 */
export function readCanvasMessage(
  data: unknown,
  expect: { bridgeId: string; slug?: string },
): CanvasMessage | null {
  const message = openEnvelope(data, expect);
  if (!message) return null;

  switch (message.type) {
    case "canvas.ready": {
      const { pageId, slug, locale, innerWidth } = message;
      if (!isInt(pageId) || pageId <= 0) return null;
      if (typeof slug !== "string" || !slug) return null;
      if (typeof locale !== "string" || !(LOCALES as readonly string[]).includes(locale)) return null;
      if (!isInt(innerWidth) || innerWidth <= 0) return null;
      if (expect.slug !== undefined && expect.slug !== slug) return null;
      return { type: "canvas.ready", pageId, slug, locale: locale as Locale, innerWidth };
    }
    case "canvas.pong":
      return isInt(message.at) ? { type: "canvas.pong", at: message.at } : null;
    case "canvas.error":
      return typeof message.message === "string"
        ? { type: "canvas.error", message: message.message.slice(0, 300) }
        : null;
    case "canvas.structure": {
      if (!Array.isArray(message.sections)) return null;
      if (message.sections.length > MAX_SECTIONS) return null;
      const sections: EditorSectionMeta[] = [];
      for (const entry of message.sections) {
        const section = readSection(entry);
        // One bad entry is not a bad page. Dropping it loses a Layers row;
        // refusing the whole message loses the panel.
        if (section) sections.push(section);
      }
      return { type: "canvas.structure", sections };
    }
    case "canvas.hover": {
      // Nothing hovered is one shape and one only: both fields null. A node
      // with no rectangle, or a rectangle with no node, is half a message.
      if (message.node === null) return message.rect === null ? { type: "canvas.hover", node: null, rect: null } : null;
      const node = readNode(message.node);
      const rect = readRect(message.rect);
      if (!node || !rect) return null;
      return { type: "canvas.hover", node, rect };
    }
    case "canvas.selection": {
      if (message.node === null) {
        return message.rect === null ? { type: "canvas.selection", node: null, rect: null } : null;
      }
      const node = readNode(message.node);
      if (!node) return null;
      /**
       * `null` is a claim; a bad rectangle is a bug.
       *
       * An explicit `rect: null` says "this node is connected and measures
       * nothing" — the canvas decided that, and it is the state a node hidden
       * at the width being previewed is in. A *non-null* rectangle that cannot
       * be read says something went wrong on the way here, and quietly
       * rewriting it to `null` would file a fault under a legitimate state:
       * the editor would show a selection with no outline and no reason, and
       * whatever produced `NaN` would never be noticed. So the message is
       * refused, exactly as a malformed hover is.
       */
      if (message.rect === null) return { type: "canvas.selection", node, rect: null };
      const rect = readRect(message.rect);
      return rect ? { type: "canvas.selection", node, rect } : null;
    }
    case "canvas.edit": {
      if (typeof message.address !== "string") return null;
      const parsed = parseAddress(message.address);
      // A section root has no text of its own to type into.
      if (!parsed || !parsed.path.length) return null;
      const phase = message.phase;
      if (phase !== "start" && phase !== "input" && phase !== "commit" && phase !== "cancel") return null;
      if (typeof message.text !== "string") return null;
      return {
        type: "canvas.edit",
        address: formatAddress(parsed.sectionId, parsed.path),
        phase,
        // Long enough for any field the registry declares as text, and bounded
        // so a runaway canvas cannot post the page into the editor.
        text: message.text.slice(0, 20_000),
      };
    }
    case "canvas.bounds": {
      if (typeof message.address !== "string" || !parseAddress(message.address)) return null;
      const address = message.address;
      if (message.rect === null) return { type: "canvas.bounds", address, rect: null };
      const rect = readRect(message.rect);
      return rect ? { type: "canvas.bounds", address, rect } : null;
    }
    default:
      return null;
  }
}

/**
 * A message from the editor, as the canvas should read it.
 *
 * Still a closed set, and still a short one: nothing here writes anything. An
 * `editor.setContent` — or any other command that sounds plausible — falls
 * through to `null`, because a message type is recognised by being listed, not
 * by being well formed.
 */
export function readEditorMessage(
  data: unknown,
  expect: { bridgeId: string },
): EditorMessage | null {
  const message = openEnvelope(data, expect);
  if (!message) return null;

  switch (message.type) {
    case "editor.ping":
      return isInt(message.at) ? { type: "editor.ping", at: message.at } : null;
    case "editor.select": {
      if (typeof message.address !== "string") return null;
      const parsed = parseAddress(message.address);
      if (!parsed) return null;
      return {
        type: "editor.select",
        address: formatAddress(parsed.sectionId, parsed.path),
        scrollIntoView: message.scrollIntoView === true,
      };
    }
    case "editor.clearSelection":
      return { type: "editor.clearSelection" };
    case "editor.locks": {
      if (!Array.isArray(message.addresses)) return null;
      if (message.addresses.length > MAX_LOCKS) return null;
      const addresses: string[] = [];
      for (const entry of message.addresses) {
        if (typeof entry !== "string") continue;
        const parsed = parseAddress(entry);
        // A malformed lock is dropped rather than refusing the whole set: the
        // safe failure is one node that can still be clicked, not a canvas
        // that forgets every lock it had.
        if (parsed) addresses.push(formatAddress(parsed.sectionId, parsed.path));
      }
      return { type: "editor.locks", addresses };
    }
    case "editor.edit": {
      if (typeof message.address !== "string") return null;
      const parsed = parseAddress(message.address);
      if (!parsed || !parsed.path.length) return null;
      if (typeof message.active !== "boolean") return null;
      return {
        type: "editor.edit",
        address: formatAddress(parsed.sectionId, parsed.path),
        active: message.active,
      };
    }
    default:
      return null;
  }
}

/**
 * Where messages may come from and go to: this document's own origin, always.
 *
 * The canvas is a route of this same application, so there is never a reason to
 * post to or accept from anywhere else. Passing an explicit origin to
 * `postMessage` rather than `"*"` is what stops the payload being delivered to
 * a document that replaced the expected one.
 */
export const bridgeOrigin = (): string => window.location.origin;
