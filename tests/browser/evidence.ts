/**
 * What a browser probe saw go wrong behind the screen, said where a CI job
 * shows it (Batch 25).
 *
 * A CI job keeps a probe's own log only in an artifact, which is not always
 * within reach — CI run 37850382078 lost two probes with nothing in the job log
 * but a stack trace. The runner prints a probe's `diag` lines in the job log
 * whenever its run is not clean, and only then (tests/browser/run.ts), so the
 * evidence is written as it happens and costs nothing on a clean run:
 *
 *  · a request that failed other than by being cancelled, and any answer of
 *    400 or more — a refused or failed Server Action included;
 *  · a console error, in the editor or in its canvas;
 *  · an error React recovered from — a hydration mismatch — with the component
 *    stack React gives it, which the page error itself does not carry;
 *  · when the probe dies, the lines its server wrote that say something failed.
 *
 * Every line is redacted (`helpers/diagnostics.ts`): the session cookie by
 * value, and anything shaped like a secret.
 */
import type { Page } from "playwright";

import { redact, serverFailureLines } from "../helpers/diagnostics";
import type { Server } from "../helpers/server";

const pathOf = (url: string) => {
  try {
    return new URL(url).pathname;
  } catch {
    return "?";
  }
};

/** Marks the console lines `RECOVERED` writes, so only this file reads them. */
const RECOVERED_PREFIX = "eod-evidence recovered: ";

/**
 * Where a recovered error happened, in React's own words.
 *
 * A production build reports a hydration mismatch as "Minified React error
 * #418" and nothing more: React hands the component stack to
 * `onRecoverableError`, and Next.js drops it. A stand-in for the DevTools
 * hook — the documented way React announces each root it commits — wraps that
 * callback before React calls it, and writes the stack to the console. It
 * installs nothing when a real hook is already there, and changes nothing the
 * page does. (Batch 25: this is how the stack `ul ← div ← Reveal` pointed at
 * the vendored React's replay defect — tests/browser/README.md.)
 */
const RECOVERED = `(() => {
  if (window.__REACT_DEVTOOLS_GLOBAL_HOOK__) return;
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(),
    supportsFiber: true,
    isDisabled: false,
    checkDCE() {},
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    setStrictMode() {},
    inject(renderer) {
      const id = this.renderers.size + 1;
      this.renderers.set(id, renderer);
      return id;
    },
    onCommitFiberRoot(id, root) {
      if (!root || root.__eodEvidence || typeof root.onRecoverableError !== "function") return;
      const original = root.onRecoverableError;
      root.onRecoverableError = function (error, info) {
        try {
          const stack = String((info && info.componentStack) || "").replace(/\\s+/g, " ").trim();
          const message = String((error && error.message) || error).slice(0, 60);
          console.info(${JSON.stringify(RECOVERED_PREFIX)} + location.pathname + " — " + message + " — " + stack.slice(0, 240));
        } catch (_) {}
        return original.apply(this, arguments);
      };
      root.__eodEvidence = true;
    },
  };
})();`;

/** Writes a `diag` line for each failed request, error answer, console error and recovered error on `page`. */
export async function recordEvidence(page: Page, secrets: string[]): Promise<void> {
  const say = (line: string) => console.log(`diag ${redact(line, secrets).replace(/\s+/g, " ").slice(0, 400)}`);
  await page.addInitScript({ content: RECOVERED });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText ?? "unknown";
    // Cancelled is how a canvas that was replaced, or a stream read to its end, leaves.
    if (failure !== "net::ERR_ABORTED") say(`request failed: ${failure} — ${request.method()} ${pathOf(request.url())}`);
  });
  page.on("response", (response) => {
    if (response.status() < 400) return;
    const request = response.request();
    const action = request.headers()["next-action"] ? " (Server Action)" : "";
    say(`answer ${response.status()} — ${request.method()} ${pathOf(response.url())}${action}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") say(`console error: ${message.text()}`);
    else if (message.text().startsWith(RECOVERED_PREFIX)) say(`recovered: ${message.text().slice(RECOVERED_PREFIX.length)}`);
  });
}

/** Writes a `diag` line for each line `server` wrote that says something failed. */
export function serverEvidence(server: Server | undefined, secrets: string[]): void {
  for (const line of serverFailureLines(server?.lines() ?? []).slice(-40)) {
    console.log(`diag server ${line.stream}: ${redact(line.text, secrets).slice(0, 400)}`);
  }
}
