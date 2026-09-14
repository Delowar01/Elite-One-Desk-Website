import { LOCALES, type Locale } from "@/lib/i18n/config";

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
 *   · **Finished.** Batch 3 is a page-level handshake only. Selection, styles
 *     and content commands arrive in later batches and will raise the version.
 *
 * Both ends check origin and source as well as the fields below; neither alone
 * is enough. See `bridgeOrigin` for why the origin is the window's own.
 */

export const EDITOR_CHANNEL = "eod.visual-editor";

/** Raised whenever a message shape changes. A mismatch is silence, not a guess. */
export const PROTOCOL_VERSION = 1;

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

/** The canvas could not do something. One safe sentence, never an exception. */
export type CanvasError = { type: "canvas.error"; message: string };

export type EditorPing = { type: "editor.ping"; at: number };

export type CanvasMessage = CanvasReady | CanvasPong | CanvasError;
export type EditorMessage = EditorPing;

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
    default:
      return null;
  }
}

/** A message from the editor, as the canvas should read it. */
export function readEditorMessage(
  data: unknown,
  expect: { bridgeId: string },
): EditorMessage | null {
  const message = openEnvelope(data, expect);
  if (!message) return null;
  if (message.type !== "editor.ping") return null;
  return isInt(message.at) ? { type: "editor.ping", at: message.at } : null;
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
