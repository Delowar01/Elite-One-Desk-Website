import "server-only";

import { AccessError } from "@/lib/auth/guard";
import type { DraftKind } from "@/lib/cms/drafts";

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

/** Reads a trimmed string from a form, with a length cap. */
export const field = (form: FormData, name: string, max = 5000): string =>
  String(form.get(name) ?? "").trim().slice(0, max);

export const checkbox = (form: FormData, name: string): boolean =>
  form.get(name) === "on" || form.get(name) === "true";

export const numberField = (form: FormData, name: string, fallback = 0): number => {
  const raw = String(form.get(name) ?? "").trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? value : fallback;
};

export const optionalId = (form: FormData, name: string): number | null => {
  const value = numberField(form, name, 0);
  return value > 0 ? value : null;
};
