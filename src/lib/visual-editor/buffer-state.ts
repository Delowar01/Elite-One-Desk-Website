/**
 * One domain of a section's edit buffer, set to a new value — the rule both an
 * edit and an Undo go through (Batch 16).
 *
 * Kept apart from the shell so it can be asked directly, because it carries the
 * promise Undo depends on: **dirty means "differs from what the server last
 * said", measured by meaning.** Undo back to exactly the saved state makes the
 * domain clean, so nothing pointless is saved; Redo away from it makes it dirty
 * again, so the ordinary autosave carries it. A conflict is never cleared by
 * this: the section really did change elsewhere, and only Reload latest may
 * say otherwise.
 *
 * Structural, not nominal: it knows the handful of fields it reads and writes
 * and passes everything else through untouched, so the buffer type can stay
 * where the inspector declares it.
 */
export type BufferDomain = "content" | "style" | "motion";

type DomainFields = {
  data: { values: unknown; styles: unknown; motionDocument: unknown };
  values: unknown;
  styles: unknown;
  motion: unknown;
  contentDirty: boolean;
  styleDirty: boolean;
  motionDirty: boolean;
  status: string;
  statusDomain: unknown;
  message?: string;
};

/** Two documents mean the same thing whatever order their keys were written in. */
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, raw) =>
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? Object.fromEntries(
          Object.keys(raw as Record<string, unknown>)
            .sort()
            .map((key) => [key, (raw as Record<string, unknown>)[key]]),
        )
      : raw,
  ) ?? "undefined";

export const sameValues = (a: unknown, b: unknown): boolean => canonical(a) === canonical(b);

export function withDomainValue<T extends DomainFields>(entry: T, domain: BufferDomain, value: unknown): T {
  const patch =
    domain === "content"
      ? { values: value, contentDirty: !sameValues(value, entry.data.values) }
      : domain === "style"
        ? { styles: value, styleDirty: !sameValues(value, entry.data.styles) }
        : { motion: value, motionDirty: !sameValues(value, entry.data.motionDocument) };
  const conflict = entry.status === "conflict";
  return {
    ...entry,
    ...patch,
    status: conflict ? "conflict" : "idle",
    statusDomain: conflict ? entry.statusDomain : null,
    message: conflict ? entry.message : undefined,
  } as T;
}
