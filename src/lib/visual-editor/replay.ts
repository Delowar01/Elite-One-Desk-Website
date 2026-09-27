import type { Locale } from "@/lib/i18n/config";
import type { ReplayMode, ReplayOutcome } from "./protocol";

/**
 * Whether a Replay result still belongs to the editor it arrives in (Batch 15b).
 *
 * The same lesson as a direct-edit session, applied to a second message: a
 * Replay is asked for on one page, in one language, on one canvas document,
 * for one selected node — and every one of those can change while the canvas
 * is still playing it. A result that arrives after the editor has moved on
 * must change nothing on screen: it would say "Replayed" about a node nobody
 * is looking at, or clear the status of a newer Replay that is still running.
 *
 * Replay stores nothing, so the worst a stale result could do is mislead — but
 * the rule is kept exactly as strictly as the one that guards writes, because a
 * guard that is only strict when the stakes are high is one somebody loosens.
 *
 * Pure on purpose, like `acceptEdit`: the rule can be asked directly.
 */
export type ReplaySession = {
  /** Rises with every request, so a superseded Replay is recognisable. */
  token: number;
  address: string;
  mode: ReplayMode;
  /** The context the Replay was asked for in, captured once and never re-read. */
  pageId: number;
  locale: Locale;
  canvasKey: number;
};

/** What the editor is showing at the moment a result arrives. */
export type ReplayContext = {
  pageId: number | null;
  locale: Locale;
  canvasKey: number;
  /** The address selected now, or null. A Replay is for the node it was asked about. */
  selected: string | null;
};

export type ReplayRejection = "no-session" | "token" | "address" | "page" | "locale" | "canvas" | "selection";

export type ReplayVerdict =
  | { ok: true; outcome: ReplayOutcome; ends: boolean }
  | { ok: false; reason: ReplayRejection };

const no = (reason: ReplayRejection): ReplayVerdict => ({ ok: false, reason });

export function acceptReplayResult(
  session: ReplaySession | null,
  context: ReplayContext,
  result: { address: string; token: number; outcome: ReplayOutcome },
): ReplayVerdict {
  if (!session) return no("no-session");
  if (session.token !== result.token) return no("token");
  if (session.address !== result.address) return no("address");
  if (context.pageId !== session.pageId) return no("page");
  if (context.locale !== session.locale) return no("locale");
  if (context.canvasKey !== session.canvasKey) return no("canvas");
  if (context.selected !== session.address) return no("selection");
  return { ok: true, outcome: result.outcome, ends: result.outcome !== "started" };
}

/** What the Motion panel says about the last Replay, in words. */
export const REPLAY_STATUS: Record<ReplayOutcome, string> = {
  started: "Replaying…",
  finished: "Replayed. Nothing was saved.",
  cancelled: "Replay stopped.",
  missing: "This element is not on the canvas right now.",
  nothing: "Nothing to replay here at this width.",
  reduced: "This device asks for reduced motion, so everything is shown already in place.",
  busy: "Finish typing into this element first.",
};
