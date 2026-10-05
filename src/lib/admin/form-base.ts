import "server-only";

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import { getAuthSecret } from "@/lib/env";

/**
 * A record's admin form, saved against the base it was drawn with (Batch 23
 * for the Services form; shared since Batch 24 by the Packages and
 * Destinations forms — docs/admin/services-form-concurrency.md).
 *
 * A form that writes every column it holds puts the older values back when it
 * is saved after somebody else's change — the Visual Editor publishing the
 * record's page, another admin, a toggle on the list. Instead the edit page
 * signs what each field was when it was drawn, the form posts that back, and
 * the update writes only what the form changed — refusing, whole, a change to
 * a field that moved elsewhere in the meantime.
 *
 * This module is the mechanism, and only that: units, fingerprints, the signed
 * token and the per-unit decision. Each form supplies its own list of units,
 * its own reader and its own transaction.
 */

/**
 * How a browser hands an untouched value back, so that it is never read as an
 * edit: a textarea posts its line breaks as CRLF, and a single-line input
 * strips them from its value altogether.
 */
export type Canon = "line" | "text" | "value";

export type FormUnit<F extends string = string> = {
  /** The key in the base, the activity log and `conflicts`. */
  key: string;
  /** What the operator calls it, in a conflict message. */
  label: string;
  fields: readonly F[];
  canon: Canon;
  /** A checkbox: absent from a submission means off, as in HTML. */
  checkbox?: true;
};

export type Prints = Record<string, string>;

export type SaveDecision = {
  /** Units the form changed from its base. */
  changed: string[];
  /** Changed here and, differently, elsewhere since the base: the save is refused. */
  conflicts: string[];
  /** Changed here and not already so: what is written. */
  writes: string[];
};

const canonical = (value: unknown, canon: Canon): unknown => {
  if (typeof value !== "string") return value;
  if (canon === "line") return value.replace(/[\r\n]/g, "");
  if (canon === "text") return value.replace(/\r\n?/g, "\n");
  return value;
};

const BASE_VERSION = 1;

/**
 * One form's base. `purpose` names the signing key — a key for this one form,
 * derived from `AUTH_SECRET`, so a base can never stand in for a session, a
 * preview token or another form's base.
 */
export function formBase<V extends Record<string, unknown>>(spec: {
  purpose: string;
  units: readonly FormUnit<Extract<keyof V, string>>[];
}) {
  const { units } = spec;
  const unitKeys = units.map((unit) => unit.key);

  /** A unit's value, as one comparable string: what is compared, never what is stored. */
  const fingerprint = (values: V, unit: FormUnit<Extract<keyof V, string>>): string =>
    createHash("sha256")
      .update(JSON.stringify(unit.fields.map((name) => canonical(values[name], unit.canon))))
      .digest("base64url")
      .slice(0, 22);

  const printsOf = (values: V): Prints => Object.fromEntries(units.map((unit) => [unit.key, fingerprint(values, unit)]));

  /**
   * The units a submission speaks for. A browser posts every field of the
   * form; anything else is not taken as an instruction to blank a column —
   * except a checkbox, whose absence is how HTML says "off".
   */
  const submittedUnits = (form: FormData): Set<string> =>
    new Set(units.filter((unit) => unit.checkbox || form.has(unit.fields[0]!)).map((unit) => unit.key));

  const signingKey = () => createHmac("sha256", getAuthSecret()).update(`elite-one-desk:${spec.purpose}:v1`).digest();
  const sign = (payload: string) => createHmac("sha256", signingKey()).update(payload).digest();

  /** The base the edit page renders beside the values it drew: fingerprints only, never values. */
  const signBase = (id: number, values: V): string => {
    const payload = Buffer.from(JSON.stringify({ v: BASE_VERSION, id, f: printsOf(values) })).toString("base64url");
    return `${payload}.${sign(payload).toString("base64url")}`;
  };

  /** The fingerprints a form was drawn with, if the token is ours, current and for this record — otherwise `null`. */
  const readBase = (token: string, id: number): Prints | null => {
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
    const [payload, signature] = parts as [string, string];
    const given = Buffer.from(signature, "base64url");
    const expected = sign(payload);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
    try {
      const body = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { v?: unknown; id?: unknown; f?: unknown };
      if (body.v !== BASE_VERSION || body.id !== id || typeof body.f !== "object" || body.f === null) return null;
      const prints = body.f as Record<string, unknown>;
      if (Object.keys(prints).length !== unitKeys.length) return null;
      for (const key of unitKeys) if (typeof prints[key] !== "string") return null;
      return prints as Prints;
    } catch {
      return null;
    }
  };

  /**
   * The rule, unit by unit (docs/admin/services-form-concurrency.md §4): an
   * untouched unit is never written; a changed one is written while the live
   * value is still the base, is already so when it equals the submission, and
   * is a conflict otherwise. Any conflict refuses the whole save.
   */
  const decide = (base: Prints, mine: Prints, live: Prints, submitted: Set<string>): SaveDecision => {
    const changed = unitKeys.filter((key) => submitted.has(key) && mine[key] !== base[key]);
    const conflicts = changed.filter((key) => live[key] !== base[key] && live[key] !== mine[key]);
    const writes = conflicts.length ? [] : changed.filter((key) => live[key] !== mine[key]);
    return { changed, conflicts, writes };
  };

  const unitLabel = (key: string): string => units.find((unit) => unit.key === key)?.label ?? key;

  /** The columns a set of units writes, taken from the submission. */
  const valuesOfUnits = (values: V, keys: string[]): Partial<V> => {
    const out: Partial<V> = {};
    for (const unit of units) {
      if (!keys.includes(unit.key)) continue;
      for (const name of unit.fields) out[name] = values[name];
    }
    return out;
  };

  /**
   * The refusal of a save that met a conflict: the fields named by their
   * labels, each marked on the form, and the unit keys for a caller that
   * shows them — no values, nothing stored, nothing secret.
   */
  const conflictMessage = (keys: string[]) => {
    const labels = keys.map(unitLabel);
    const named = labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : labels[0];
    const errors = Object.fromEntries(
      units
        .filter((unit) => keys.includes(unit.key))
        .flatMap((unit) => unit.fields.map((name) => [name, "Changed elsewhere since this form was opened."])),
    ) as Record<string, string>;
    return {
      message: `${named} ${labels.length > 1 ? "were" : "was"} changed elsewhere while this form was open, so nothing was saved. Reload the page to see the newer version, then make your change again.`,
      errors,
    };
  };

  return { units, printsOf, submittedUnits, signBase, readBase, decide, unitLabel, valuesOfUnits, conflictMessage };
}
