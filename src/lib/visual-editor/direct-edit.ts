import { parseAddress, formatNodePath } from "@/lib/cms/address";
import type { Locale } from "@/lib/i18n/config";

/**
 * Whether a message from the canvas still belongs to the editor it arrives in.
 *
 * A direct-edit session is opened against one page, in one language, on one
 * canvas document. All three can change while a keystroke is still travelling,
 * and the editor goes on existing across every one of them — buffers survive a
 * page change on purpose, so there is always something for a late message to
 * damage.
 *
 * The session used to be identified by its token and address alone, and the
 * text was then written using whatever language the editor was showing *now*.
 * Between React rendering a new context and the effect that cancels the session
 * actually running, a message from the old session passed that guard and was
 * applied under the new context: an English edit written into `.ar`, a page the
 * editor had left made dirty and queued for saving. Correctness cannot depend
 * on how quickly a cleanup effect happens to run, so the check is here, it is
 * synchronous, and it compares the whole context.
 *
 * Pure on purpose. The rule is the valuable part, and a rule inside a component
 * can only be tested by driving the component; this one can be asked directly.
 */
export type DirectEditSession = {
  /** Rises with every request, so a superseded session is recognisable. */
  token: number;
  address: string;
  sectionId: number;
  /** The context the session was opened in, captured once and never re-read. */
  pageId: number;
  locale: Locale;
  canvasKey: number;
  /** The value the canvas was seeded with — what Escape restores. */
  started: string;
};

/** What the editor is showing at the moment a message arrives. */
export type EditorContext = { pageId: number | null; locale: Locale; canvasKey: number };

export type IncomingEdit = {
  address: string;
  token: number;
  phase: "input" | "commit" | "cancel";
  text: string;
};

export type EditRejection =
  | "no-session"
  | "token"
  | "address"
  | "unparsable"
  | "section"
  | "page"
  | "locale"
  | "canvas";

export type EditVerdict =
  | {
      ok: true;
      sectionId: number;
      relativePath: string;
      /** The session's own language, never the editor's current one. */
      locale: Locale;
      /** What to write: the typed text, or the starting value on a cancel. */
      text: string;
      /** Whether this message ends the session. */
      ends: boolean;
    }
  | { ok: false; reason: EditRejection };

const no = (reason: EditRejection): EditVerdict => ({ ok: false, reason });

export function acceptEdit(
  session: DirectEditSession | null,
  context: EditorContext,
  edit: IncomingEdit,
): EditVerdict {
  if (!session) return no("no-session");
  if (session.token !== edit.token) return no("token");
  if (session.address !== edit.address) return no("address");

  const parsed = parseAddress(edit.address);
  if (!parsed || !parsed.path.length) return no("unparsable");
  // The address and the session must agree about which row this is; two fields
  // that can disagree are a bug waiting for the day they do.
  if (parsed.sectionId !== session.sectionId) return no("section");

  /**
   * The context, compared whole.
   *
   * Each of these is a different accident. The page: the editor has moved on
   * and the buffers of the page it left are still there to be written to. The
   * language: the same node means a different field, so the edit would land in
   * the wrong edition. The canvas: a document that has been replaced can still
   * have a message in the air, and its token would normally differ — but a
   * rule that holds only because of another rule is one rule, not two.
   */
  if (context.pageId !== session.pageId) return no("page");
  if (context.locale !== session.locale) return no("locale");
  if (context.canvasKey !== session.canvasKey) return no("canvas");

  return {
    ok: true,
    sectionId: session.sectionId,
    relativePath: formatNodePath(parsed.path),
    // The language the edit was *begun* in. Reading the current one here is
    // what let a stale English message write Arabic.
    locale: session.locale,
    text: edit.phase === "cancel" ? session.started : edit.text,
    ends: edit.phase !== "input",
  };
}
