/**
 * Evidence for a stress failure that does not reproduce on demand (Batch 21A).
 *
 * Stress run 37064560289 failed create-navigation's N4 with three browser page
 * errors, "An error occurred in the Server Components render…", and nothing
 * else: the script kept 160 characters of each message, so not the digest, not
 * the page, not the step it was on, and the three servers' own output was
 * thrown away with them. One clean run later proves nothing about a failure
 * nobody could see. This module records what the next one needs:
 *
 *  · every browser-side error in full — name, message, stack, the Next.js
 *    digest (read in the page, because a page error loses it on its way to
 *    Playwright), the page's address, the worker, round and step, the time;
 *  · the requests around it, and on their own account: failed requests, 5xx
 *    answers, failed Server Actions, and any RSC payload carrying an error row
 *    that is not a navigation (notFound, redirect) — a render that failed on
 *    the server whether or not the screen ever showed it;
 *  · unexpected console errors;
 *  · each server's output line by line with the time it arrived, and how each
 *    server process ended — so an incident is printed beside what the server
 *    said in the seconds around it, and a crash is told from a restart.
 *
 * Nothing secret is printed. `redact` removes cookies, session and CSRF tokens,
 * passwords, credentials inside URLs, the database URL and the auth secret
 * from every line written here, and the exact values a script knows — its
 * session cookie, its CSRF token — are removed by value as well.
 */
import type { BrowserContext, ConsoleMessage, Page, Request, Response } from "playwright";

import type { Server, ServerLine } from "./server";

/* -------------------------------------------------------------------------- */
/* Redaction                                                                  */
/* -------------------------------------------------------------------------- */

export const REDACTED = "[redacted]";

/** Shapes that carry a secret whatever its value. Applied after the exact values. */
const SECRET_SHAPES: [RegExp, string][] = [
  // Credentials inside a URL: scheme://user:password@host.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"']+:[^\s/@"']*@/gi, `$1${REDACTED}@`],
  // NAME=value for a variable that names a secret.
  [
    /\b(DATABASE_URL|TEST_PG_URL|AUTH_SECRET|PGPASSWORD|[A-Z][A-Z0-9_]*(?:SECRET|PASSWORD|TOKEN|_KEY))=("[^"]*"|'[^']*'|\S+)/g,
    `$1=${REDACTED}`,
  ],
  // Cookie, Set-Cookie and Authorization headers, to the end of the line.
  [/\b(cookie|set-cookie|authorization)(\s*[:=]\s*)[^\r\n]*/gi, `$1$2${REDACTED}`],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/g, `Bearer ${REDACTED}`],
  // A cookie pair whose name says session: eod_session=<id>.<secret>.
  [/\b([A-Za-z0-9_-]*session[A-Za-z0-9_-]*)=([^\s;&,"']+)/gi, `$1=${REDACTED}`],
  // A field named like a secret, in JSON, a form or a log line.
  [
    /(["']?)\b(password|passwd|_csrf|csrf[_-]?token|csrfToken|secret|token)\1(\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s&,;}]+)/gi,
    `$1$2$1$3${REDACTED}`,
  ],
];

/** `text` with every known secret value, and every secret-shaped field, removed. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    // A short value would erase ordinary text that happens to contain it.
    if (!secret || secret.length < 8) continue;
    for (const form of new Set([secret, encodeURIComponent(secret)])) out = out.split(form).join(REDACTED);
  }
  for (const [shape, replacement] of SECRET_SHAPES) out = out.replace(shape, replacement);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Reading Next.js failures                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The digests named in a server log, an error's text or a JSON body:
 * `digest: '2338101830'` (how Node prints an error object) and
 * `"digest":"2338101830"`.
 */
export function digestsIn(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(/["']?\bdigest["']?\s*[:=]\s*["']([^"'\s]+)["']/g)) found.add(match[1]!);
  return [...found];
}

/** A digest Next.js uses to navigate — notFound(), redirect(), forbidden() — rather than to fail. */
export const isNavigationDigest = (digest: string): boolean =>
  /^(NEXT_REDIRECT|NEXT_HTTP_ERROR_FALLBACK|NEXT_NOT_FOUND)(;|$)/.test(digest);

/**
 * The error rows of an RSC (Flight) payload. A row is `<hex id>:<tag><data>`;
 * tag `E` is an error, `{"digest":"…"}` in a production build. That row is what
 * a browser turns into "An error occurred in the Server Components render", so
 * finding one in a response names the request that carried the failure.
 *
 * Rows are walked, not searched: a text or binary row is `<tag><hex byte
 * length>,<bytes>` with no newline after it, and its bytes may hold anything —
 * including text that looks like an error row.
 */
export function payloadErrors(body: string | Buffer): { digest: string; row: string }[] {
  const payload = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const rows: { digest: string; row: string }[] = [];
  let at = 0;
  while (at < payload.length) {
    const colon = payload.indexOf(0x3a, at);
    if (colon < 0) break;
    const newline = payload.indexOf(0x0a, colon + 1);
    const end = newline < 0 ? payload.length : newline;
    const id = payload.toString("utf8", at, colon);
    if (!/^[0-9a-f]+$/.test(id)) {
      // Not a row (an HTML error page, a partial line): on to the next line.
      at = end + 1;
      continue;
    }
    const tag = String.fromCharCode(payload[colon + 1] ?? 0);
    const sized = /^([0-9a-f]+),/.exec(payload.toString("latin1", colon + 2, Math.min(colon + 20, payload.length)));
    if (tag !== "E" && /[A-Za-z]/.test(tag) && sized) {
      at = colon + 2 + sized[0].length + Number.parseInt(sized[1]!, 16);
      if (payload[at] === 0x0a) at += 1;
      continue;
    }
    if (tag === "E") {
      const json = payload.toString("utf8", colon + 2, end);
      let digest = "(no digest)";
      try {
        const parsed = JSON.parse(json) as { digest?: unknown };
        if (typeof parsed.digest === "string") digest = parsed.digest;
      } catch {
        digest = "(unreadable error row)";
      }
      rows.push({ digest, row: `${id}:E${json}`.slice(0, 300) });
    }
    at = end + 1;
  }
  return rows;
}

/**
 * The lines of a server's output that say something failed.
 *
 * A healthy production server writes its banner to stdout and nothing to
 * stderr: Next.js reports a failed render as `⨯ <error>` with `console.error`,
 * and this application logs every error it catches with `console.error` too
 * (`[reuse:catalog]`, `[visual-editor:route-save]`, …), so every stderr line
 * counts — except Node's own deprecation and experimental-feature notices,
 * which say nothing about a request. On stdout only an error's own shape does.
 */
export function serverFailureLines(lines: readonly ServerLine[]): ServerLine[] {
  const nodeNotice = /^\(node:\d+\) \[?[A-Z0-9]*\]? ?\w*Warning\b|^\(Use `node --trace-(warnings|deprecation)/;
  const failure = /⨯|\b[A-Z]?[A-Za-z]*Error\b|\bdigest\b|unhandled|uncaught|\bE(CONNRESET|CONNREFUSED|PIPE|ADDRINUSE|TIMEDOUT)\b/i;
  return lines.filter((line) =>
    line.stream === "err" ? Boolean(line.text.trim()) && !nodeNotice.test(line.text) : failure.test(line.text),
  );
}

/* -------------------------------------------------------------------------- */
/* What is recorded                                                           */
/* -------------------------------------------------------------------------- */

/** What the script was doing: set before every step, attached to everything recorded during it. */
export type Step = { worker: number; round?: number; step: string };

/** Which part of the app router a request belongs to. */
export type Flavour = "action" | "rsc" | "prefetch" | "document" | "other";

export function requestFlavour(headers: Record<string, string>, resourceType: string): Flavour {
  if (headers["next-action"]) return "action";
  if (headers["next-router-prefetch"]) return "prefetch";
  if (headers["rsc"]) return "rsc";
  return resourceType === "document" ? "document" : "other";
}

export type IncidentKind =
  | "pageerror" // an uncaught error in the page — what N4 counts
  | "console" // console.error, other than a resource answering 404
  | "requestfailed" // a request that failed for a reason other than being cancelled
  | "http" // a 5xx answer
  | "action" // a Server Action that answered 5xx
  | "payload" // an RSC payload with an error row that is not a navigation
  | "server-log" // a line a server wrote that says something failed
  | "server-exit" // a server process that ended without being asked to
  | "crash" // the page's renderer crashed
  | "activity" // concurrent activity (helpers/activity.ts) that met a 5xx, an error row or an exception
  | "navigation" // the page did not reach the address a step waits for — N1 and N3 count these
  | "step"; // a step of the script that threw: a navigation that failed, a control that never came

export type Incident = {
  kind: IncidentKind;
  at: number;
  step: Step | null;
  /** The page's address when it happened. */
  page?: string;
  name?: string;
  message: string;
  stack?: string;
  digests: string[];
  request?: { method: string; url: string; flavour: Flavour; status?: number; statusText?: string; failure?: string };
  /** Part of a response or the page's own report — only what is useful and safe. */
  detail?: string;
  /** The server that served the step, and what it wrote around the incident. */
  server?: { label: string; pid?: number; lines: ServerLine[] };
};

type NetEvent = {
  at: number;
  what: "request" | "response" | "failed";
  method: string;
  url: string;
  flavour: Flavour;
  status?: number;
  failure?: string;
};

/** What the page's own listeners saw — carries the digest a page error loses. */
type PageReport = {
  kind: string;
  name: string | null;
  message: string;
  stack: string | null;
  digest: string | null;
  url: string;
  at: number;
};

const BINDING = "__eodStressReport";

/**
 * Runs in every document before its own scripts. Playwright's page error is an
 * Error rebuilt from the exception's text, so properties such as React's
 * `digest` do not survive the trip; the page reports its own errors here, with
 * the digest, through a binding. It changes nothing the page does: listeners
 * only observe, and `console.error` still prints what it was given.
 */
export const PAGE_SCRIPT = `(() => {
  const report = (kind, value) => {
    try {
      const error = value instanceof Error ? value : null;
      const send = window[${JSON.stringify(BINDING)}];
      if (typeof send !== "function") return;
      send({
        kind,
        name: error ? String(error.name) : null,
        message: error ? String(error.message) : String(value),
        stack: error && error.stack ? String(error.stack) : null,
        digest: error && typeof error.digest === "string" ? error.digest : null,
        url: String(location.href),
        at: Date.now(),
      });
    } catch (_) {}
  };
  addEventListener("error", (event) => {
    if (event instanceof ErrorEvent) report("error", event.error ?? event.message);
  }, true);
  addEventListener("unhandledrejection", (event) => report("unhandledrejection", event.reason), true);
  const original = console.error;
  console.error = function (...args) {
    for (const arg of args) if (arg instanceof Error) report("console.error", arg);
    return original.apply(this, args);
  };
})();`;

const NET_KEPT = 400;
const pathOf = (url: string): string => {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
};
const iso = (at: number) => new Date(at).toISOString();
const clock = (at: number) => iso(at).slice(11, 23);

/* -------------------------------------------------------------------------- */
/* The recorder                                                               */
/* -------------------------------------------------------------------------- */

export type DiagnosticsSummary = {
  pageErrors: number;
  /** Incidents other than page errors, by kind. */
  unexpected: Partial<Record<IncidentKind, number>>;
  digests: string[];
  console404: number;
  cancelledRequests: number;
  payloadsRead: number;
  payloadsUnread: number;
  serverStarts: number;
  serverExitsUnasked: number;
  rounds: number;
  slowestRoundMs: number;
};

export class StressDiagnostics {
  readonly incidents: Incident[] = [];
  private readonly reports: PageReport[] = [];
  private readonly net: NetEvent[] = [];
  private readonly servers: { label: string; server: Server; seen: number; since: number }[] = [];
  private adopted = 0;
  private printed = 0;
  private current: Step | null = null;
  private roundStarted: number | null = null;
  private readonly counts = {
    console404: 0,
    cancelledRequests: 0,
    payloadsRead: 0,
    payloadsUnread: 0,
    rounds: 0,
    slowestRoundMs: 0,
  };

  constructor(
    readonly label: string,
    private readonly options: {
      /** Exact values never to print: the session cookie, the CSRF token. */
      secrets?: string[];
      /** Where incidents are written; `console.log` by default. */
      print?: (block: string) => void;
      /** How far either side of an incident the server's lines are kept, in ms. */
      windowMs?: number;
    } = {},
  ) {
    this.known = [...(options.secrets ?? [])];
  }

  private readonly known: string[];

  private get secrets(): readonly string[] {
    return this.known;
  }

  /** Values never to print, learnt after the recorder started — a session signed in later. */
  addSecrets(...values: string[]): void {
    this.known.push(...values.filter(Boolean));
  }

  /** What the script is doing now; everything recorded until the next call is attributed to it. */
  at(step: Step): void {
    if (step.round !== undefined && step.round !== this.current?.round) {
      const now = Date.now();
      if (this.roundStarted !== null) this.counts.slowestRoundMs = Math.max(this.counts.slowestRoundMs, now - this.roundStarted);
      this.roundStarted = now;
      this.counts.rounds += 1;
    }
    this.current = step;
  }

  /** A server this worker now talks to; its output is read for every incident from here on. */
  adopt(server: Server, label: string): void {
    this.servers.push({ label, server, seen: 0, since: Date.now() });
    this.adopted += 1;
  }

  /** Records an incident, redacted, attributed to the current step. */
  record(incident: Omit<Incident, "at" | "step" | "digests"> & { at?: number; digests?: string[] }): Incident {
    const secrets = this.secrets;
    const clean = (value: string | undefined) => (value === undefined ? undefined : redact(value, secrets));
    const entry: Incident = {
      ...incident,
      at: incident.at ?? Date.now(),
      step: this.current,
      digests: incident.digests ?? [],
      message: redact(incident.message, secrets),
      stack: clean(incident.stack),
      detail: clean(incident.detail),
      page: clean(incident.page),
      request: incident.request ? { ...incident.request, url: redact(incident.request.url, secrets) } : undefined,
    };
    this.incidents.push(entry);
    return entry;
  }

  /**
   * Instruments a browser context: the page-side report, and listeners on
   * every page it opens. Call before the context's first page.
   */
  async watch(context: BrowserContext): Promise<void> {
    await context.exposeBinding(BINDING, (_source, report: PageReport) => {
      this.reports.push(report);
      if (this.reports.length > NET_KEPT) this.reports.splice(0, this.reports.length - NET_KEPT);
    });
    await context.addInitScript({ content: PAGE_SCRIPT });
    context.on("page", (page) => this.attach(page));
  }

  private keep(event: NetEvent) {
    this.net.push(event);
    if (this.net.length > NET_KEPT) this.net.splice(0, this.net.length - NET_KEPT);
  }

  private attach(page: Page): void {
    page.on("pageerror", (error) =>
      this.record({ kind: "pageerror", page: page.url(), name: error.name, message: error.message, stack: error.stack }),
    );
    page.on("console", (message) => this.onConsole(page, message));
    page.on("request", (request) =>
      this.keep({ at: Date.now(), what: "request", method: request.method(), url: request.url(), flavour: this.flavour(request) }),
    );
    page.on("requestfailed", (request) => this.onFailed(page, request));
    page.on("response", (response) => void this.onResponse(page, response));
    page.on("crash", () => this.record({ kind: "crash", page: page.url(), message: "the page's renderer crashed" }));
  }

  private flavour(request: Request): Flavour {
    return requestFlavour(request.headers(), request.resourceType());
  }

  private onConsole(page: Page, message: ConsoleMessage): void {
    if (message.type() !== "error") return;
    const text = message.text();
    // A resource answering 404 is what a deleted component's prefetch gets;
    // counted, and printed only beside another incident's requests.
    if (/^Failed to load resource: the server responded with a status of 404\b/.test(text)) {
      this.counts.console404 += 1;
      return;
    }
    const where = message.location();
    this.record({
      kind: "console",
      page: page.url(),
      message: text,
      detail: where.url ? `at ${pathOf(where.url)}:${where.lineNumber}:${where.columnNumber}` : undefined,
    });
  }

  private onFailed(page: Page, request: Request): void {
    const failure = request.failure()?.errorText ?? "unknown";
    const flavour = this.flavour(request);
    this.keep({ at: Date.now(), what: "failed", method: request.method(), url: request.url(), flavour, failure });
    // A request the browser cancelled — a prefetch or a stream cut off by the
    // next navigation, a page closed — is how these pages leave; anything else
    // (a reset, an empty answer, a refused connection) is the server failing.
    if (failure === "net::ERR_ABORTED") {
      this.counts.cancelledRequests += 1;
      return;
    }
    this.record({
      kind: "requestfailed",
      page: page.url(),
      message: `${failure} — ${request.method()} ${pathOf(request.url())}`,
      request: { method: request.method(), url: request.url(), flavour, failure },
    });
  }

  private async onResponse(page: Page, response: Response): Promise<void> {
    const request = response.request();
    const flavour = this.flavour(request);
    const status = response.status();
    this.keep({ at: Date.now(), what: "response", method: request.method(), url: request.url(), flavour, status });
    const reads = status >= 500 || flavour === "action" || flavour === "rsc" || flavour === "prefetch";
    if (!reads) return;
    const pageAt = page.url();
    const body = await response.text().catch(() => null);
    if (body === null) {
      this.counts.payloadsUnread += 1;
      if (status < 500) return;
    } else {
      this.counts.payloadsRead += 1;
    }
    const rows = body ? payloadErrors(body) : [];
    const failed = rows.filter((row) => !isNavigationDigest(row.digest));
    const requestInfo = { method: request.method(), url: request.url(), flavour, status, statusText: response.statusText() };
    if (status >= 500) {
      this.record({
        kind: flavour === "action" ? "action" : "http",
        page: pageAt,
        message: `${status} ${response.statusText()} — ${request.method()} ${pathOf(request.url())} [${flavour}]`,
        request: requestInfo,
        digests: [...new Set([...rows.map((row) => row.digest), ...(body ? digestsIn(body) : [])])],
        detail: body ? (failed.length ? failed.map((row) => row.row).join("\n") : body.slice(0, 600)) : "(body not readable)",
      });
    } else if (failed.length) {
      this.record({
        kind: "payload",
        page: pageAt,
        message: `${failed.length} error row(s) in the ${flavour} payload of ${request.method()} ${pathOf(request.url())} (${status})`,
        request: requestInfo,
        digests: failed.map((row) => row.digest),
        detail: failed.map((row) => row.row).join("\n"),
      });
    }
  }

  /** The digest the page reported for a page error: same message, within three seconds. */
  private digestFor(incident: Incident): string[] {
    const matching = this.reports.filter(
      (report) =>
        report.digest &&
        Math.abs(report.at - incident.at) < 3_000 &&
        redact(report.message, this.secrets).slice(0, 200) === incident.message.slice(0, 200),
    );
    return [...new Set(matching.map((report) => report.digest!))];
  }

  /**
   * Reads every adopted server's new output and exits into incidents, gives
   * each new incident its digest, requests and server lines, prints them, and
   * returns them. Call when a step ends and before its server is replaced.
   */
  flush(): Incident[] {
    const windowMs = this.options.windowMs ?? 5_000;
    for (const entry of this.servers) {
      const lines = entry.server.lines();
      const fresh = lines.slice(entry.seen);
      entry.seen = lines.length;
      // One failure is often many lines — `⨯ Error: …`, its stack, `digest: '…'`
      // — written in one burst: a burst is one incident, not one per line.
      for (const burst of bursts(serverFailureLines(fresh))) {
        const text = burst.map((line) => line.text).join("\n");
        this.record({
          kind: "server-log",
          at: burst[0]!.at,
          message: `${entry.label} ${burst[0]!.stream}: ${burst[0]!.text}`,
          detail: burst.length > 1 ? burst.slice(1).map((line) => line.text).join("\n") : undefined,
          digests: digestsIn(text),
        });
      }
      const exit = entry.server.exit();
      if (exit && !exit.requested && !this.incidents.some((incident) => incident.kind === "server-exit" && incident.at === exit.at)) {
        this.record({
          kind: "server-exit",
          at: exit.at,
          message: `${entry.label} (pid ${entry.server.pid ?? "?"}) exited by itself: code ${exit.code}, signal ${exit.signal}`,
        });
      }
    }
    const fresh = this.incidents.slice(this.printed);
    this.printed = this.incidents.length;
    for (const incident of fresh) {
      if (incident.kind === "pageerror" && !incident.digests.length) incident.digests = this.digestFor(incident);
      // The server that was serving at the time: the last one adopted before it.
      const serving = [...this.servers].reverse().find((entry) => entry.since <= incident.at) ?? this.servers[0];
      if (serving) {
        incident.server = {
          label: serving.label,
          pid: serving.server.pid,
          lines: serving.server
            .lines()
            .filter((line) => Math.abs(line.at - incident.at) <= windowMs)
            .slice(-40)
            .map((line) => ({ ...line, text: redact(line.text, this.secrets) })),
        };
      }
      this.print(incident);
    }
    // A server that has been replaced will say nothing more: stop reading it.
    while (this.servers.length > 1 && this.servers[0]!.server.exit()) this.servers.shift();
    return fresh;
  }

  private print(incident: Incident): void {
    const near = this.net.filter((event) => event.at <= incident.at + 1_000 && event.at >= incident.at - 5_000).slice(-25);
    const block = formatIncident(this.label, this.incidents.indexOf(incident) + 1, incident, near, this.secrets);
    (this.options.print ?? ((text: string) => console.log(text)))(block);
  }

  pageErrors(): Incident[] {
    return this.incidents.filter((incident) => incident.kind === "pageerror");
  }

  /**
   * What N5 counts: everything behind the screen. Page errors are N4's, and a
   * page that never arrived (`navigation`) or a step that threw (`step`) is
   * already a failure of N1, N3 or the script; those are printed, not counted
   * twice.
   */
  unexpected(): Incident[] {
    return this.incidents.filter((incident) => !["pageerror", "navigation", "step"].includes(incident.kind));
  }

  summary(): DiagnosticsSummary {
    const unexpected: Partial<Record<IncidentKind, number>> = {};
    for (const incident of this.unexpected()) unexpected[incident.kind] = (unexpected[incident.kind] ?? 0) + 1;
    if (this.roundStarted !== null) this.counts.slowestRoundMs = Math.max(this.counts.slowestRoundMs, Date.now() - this.roundStarted);
    return {
      pageErrors: this.pageErrors().length,
      unexpected,
      digests: [...new Set(this.incidents.flatMap((incident) => incident.digests))],
      console404: this.counts.console404,
      cancelledRequests: this.counts.cancelledRequests,
      payloadsRead: this.counts.payloadsRead,
      payloadsUnread: this.counts.payloadsUnread,
      serverStarts: this.adopted,
      serverExitsUnasked: this.incidents.filter((incident) => incident.kind === "server-exit").length,
      rounds: this.counts.rounds,
      slowestRoundMs: this.counts.slowestRoundMs,
    };
  }
}

/** Lines written within 100 ms of the one before, on the same stream, as one group. */
export function bursts(lines: readonly ServerLine[], gapMs = 100): ServerLine[][] {
  const groups: ServerLine[][] = [];
  for (const line of lines) {
    const last = groups.at(-1)?.at(-1);
    if (last && last.stream === line.stream && line.at - last.at <= gapMs) groups.at(-1)!.push(line);
    else groups.push([line]);
  }
  return groups;
}

/** Several workers' summaries as one. */
export function mergeSummaries(summaries: DiagnosticsSummary[]): DiagnosticsSummary {
  const unexpected: Partial<Record<IncidentKind, number>> = {};
  for (const summary of summaries) {
    for (const [kind, count] of Object.entries(summary.unexpected) as [IncidentKind, number][]) {
      unexpected[kind] = (unexpected[kind] ?? 0) + count;
    }
  }
  const sum = (key: keyof DiagnosticsSummary) => summaries.reduce((total, summary) => total + (summary[key] as number), 0);
  return {
    pageErrors: sum("pageErrors"),
    unexpected,
    digests: [...new Set(summaries.flatMap((summary) => summary.digests))],
    console404: sum("console404"),
    cancelledRequests: sum("cancelledRequests"),
    payloadsRead: sum("payloadsRead"),
    payloadsUnread: sum("payloadsUnread"),
    serverStarts: sum("serverStarts"),
    serverExitsUnasked: sum("serverExitsUnasked"),
    rounds: sum("rounds"),
    slowestRoundMs: Math.max(0, ...summaries.map((summary) => summary.slowestRoundMs)),
  };
}

/**
 * One incident as the lines a log keeps: every field, the requests of the five
 * seconds before it and what the server wrote around it. Each line starts with
 * `diag` — never with PASS or FAIL, which the suite runner counts — and every
 * line is redacted again on the way out.
 */
export function formatIncident(
  label: string,
  index: number,
  incident: Incident,
  near: readonly NetEvent[] = [],
  secrets: readonly string[] = [],
): string {
  const step = incident.step
    ? `worker ${incident.step.worker}${incident.step.round !== undefined ? ` · round ${incident.step.round}` : ""} · ${incident.step.step}`
    : "no step";
  const out: string[] = [`diag ${label} #${index} ${incident.kind} · ${step} · ${iso(incident.at)}`];
  const field = (name: string, value: string | undefined) => {
    if (!value) return;
    const [first, ...rest] = value.split("\n");
    out.push(`diag   ${name.padEnd(9)} ${first}`);
    for (const line of rest) out.push(`diag   ${"".padEnd(9)} ${line}`);
  };
  field("page", incident.page);
  field("error", `${incident.name ? `${incident.name}: ` : ""}${incident.message}`);
  field("digest", incident.digests.length ? incident.digests.join(", ") : undefined);
  if (incident.request) {
    const r = incident.request;
    field(
      "request",
      `${r.method} ${r.url} [${r.flavour}]${r.status !== undefined ? ` → ${r.status} ${r.statusText ?? ""}` : ""}${r.failure ? ` (${r.failure})` : ""}`,
    );
  }
  field("detail", incident.detail);
  field("stack", incident.stack);
  if (near.length) {
    out.push("diag   requests (5 s before):");
    for (const event of near) {
      const result = event.what === "response" ? `→ ${event.status}` : event.what === "failed" ? `✗ ${event.failure}` : "…";
      out.push(`diag     ${clock(event.at)} ${event.method} ${pathOf(event.url)} [${event.flavour}] ${result}`);
    }
  }
  if (incident.server) {
    out.push(`diag   server ${incident.server.label} (pid ${incident.server.pid ?? "?"}), ±5 s:`);
    if (!incident.server.lines.length) out.push("diag     (nothing written)");
    for (const line of incident.server.lines) out.push(`diag     ${clock(line.at)} ${line.stream} ${line.text}`);
  }
  return out.map((line) => redact(line, secrets)).join("\n");
}
