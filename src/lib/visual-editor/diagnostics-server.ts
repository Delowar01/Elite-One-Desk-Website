import "server-only";

/**
 * The server's half of the readiness timeline (Batch 27 Correction 1); see
 * `diagnostics.ts` for what it is for.
 *
 * Read from the environment on every call, so it follows the process it runs
 * in rather than the machine the build ran on. Production never sets it.
 */
export function editorDiagnostics(): boolean {
  return process.env.EOD_EDITOR_DIAGNOSTICS === "1";
}

/**
 * Milliseconds since this was called, for a `diagnosticLine`'s `ms` — so a
 * server component can time its own step without reading the clock while it
 * renders.
 */
export function diagnosticTimer(): () => number {
  const started = Date.now();
  return () => Date.now() - started;
}

/**
 * One line on the server's own output, and only with diagnostics on:
 * `[eod-diag] <event> key=value … at=<ISO time>`.
 *
 * What goes in is chosen by the caller and is never a cookie, a token, a
 * session id or a query string — a slug, a bridge id (correlation, not
 * authority: it is in the canvas's address anyway), a decision and a duration.
 * The words are chosen so that `serverFailureLines` (tests/helpers) does not
 * mistake a diagnostic for a failure: none of them names an error.
 */
export function diagnosticLine(
  event: string,
  fields: Record<string, string | number | boolean | null | undefined>,
): void {
  if (!editorDiagnostics()) return;
  const parts = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${value}`);
  console.log(`[eod-diag] ${event} ${parts.join(" ")} at=${new Date().toISOString()}`);
}
