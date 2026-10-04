/**
 * Reading one value out of a submitted form: trimmed and capped, ticked or
 * not, a number, an optional id. Nothing else — no session, no database — so
 * anything that reads a form can use them (`lib/admin/actions.ts` re-exports
 * them for the actions).
 */

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
