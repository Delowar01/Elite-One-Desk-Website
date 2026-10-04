import "server-only";

import { AccessError } from "@/lib/auth/guard";
import type { DraftKind } from "@/lib/cms/drafts";

import { numberField } from "./form-readers";

/**
 * What a section screen must adopt after a write that succeeded.
 *
 * Returned by the action itself, through the same channel as the message,
 * because that channel is the only one that cannot be lost. The re-rendered
 * page Next includes in a Server Action's response is applied to the router
 * best-effort, and measurably is not always applied: twelve consecutive saves
 * on the section editor, two of them left the screen on the previous revision
 * while the server had rendered the new one twice. The screen then submitted a
 * revision the row had moved past and was told it had been overtaken — by
 * itself.
 *
 * So the authoritative facts come back with the answer: what the row is now,
 * what kind of draft it has, which entrance it is showing, and — where the
 * write replaced what the form should display — the values to show.
 */
export type SectionSnapshot = {
  revision: number;
  draftKind: DraftKind;
  /** The preset this screen should now show: the motion draft, or the live one. */
  animation: string;
  /**
   * Whether the section also has motion this screen's one menu cannot show —
   * element entrances, timing, widths or an entrance beyond the five (Batch
   * 15). The menu then shows the nearest preset, and the screen says so.
   */
  advancedMotion: boolean;
  isDraftOnly: boolean;
  /**
   * Present only when the write changed what the fields should hold — a
   * discard, which puts the published wording back. A save must not send them:
   * replacing the fields with the server's copy of what was just typed would
   * move the caret and lose an in-progress edit.
   */
  values?: Record<string, unknown>;
};

/** The shape every admin Server Action returns, so one client hook reads them all. */
export type ActionState = {
  ok: boolean;
  message?: string;
  /** Field name → message, for inline validation. */
  errors?: Record<string, string>;
  /** Echoed back so a client can act on what was created. */
  id?: number;
  /** The row this action wrote, for a screen that must stay authoritative. */
  section?: SectionSnapshot;
  /**
   * Fields changed elsewhere since the form was opened, when that refused the
   * save (Batch 23: the Services form). Keys, never values.
   */
  conflicts?: string[];
};

export const ok = (message?: string, id?: number): ActionState => ({ ok: true, message, id });

export const fail = (message: string, errors?: Record<string, string>): ActionState => ({
  ok: false,
  message,
  errors,
});

/**
 * Wraps an action body so a permission or validation failure comes back as a
 * message the form can render, while anything unexpected is logged server-side
 * and reported as one safe sentence (§44).
 */
export async function runAction(
  label: string,
  body: () => Promise<ActionState>,
): Promise<ActionState> {
  try {
    return await body();
  } catch (error) {
    if (error instanceof AccessError) return fail(error.message);
    // A redirect() inside an action throws by design; let it through.
    if (error && typeof error === "object" && "digest" in error) throw error;
    console.error(`[admin:${label}]`, error);
    return fail("Something went wrong. The change was not saved.");
  }
}

// The plain readers live on their own, so a module that only reads a form
// (the Services form's fields, Batch 23) need not import the action machinery.
export { checkbox, field, numberField, optionalId } from "./form-readers";

/**
 * The revision the submitting screen was built from, or -1 when the form did
 * not carry a readable one. Every row starts at revision 0, so reading an
 * absent field as `Number(null)` — 0 — would wave a request that names no
 * revision through on any row nobody has edited yet. -1 matches no row, so it
 * is refused like any other stale screen (19B).
 */
export const revisionField = (form: FormData, name = "expectedRevision"): number => {
  const value = numberField(form, name, -1);
  return Number.isInteger(value) && value >= 0 ? value : -1;
};

