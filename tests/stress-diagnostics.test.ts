/**
 * The stress diagnostics (Batch 21A) — the tooling that turns the next
 * create-navigation failure into evidence — tested on their own, without a
 * browser or a server: redaction, the digests and error rows of Next.js
 * failures, the server-output reader, the page-side reporter, the recorder fed
 * Playwright's own events, and what a log line looks like.
 *
 * The same code is exercised in a real browser by the stress-diagnostics probe
 * (tests/browser/probes), against a stub server that fails on purpose.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, test } from "node:test";
import vm from "node:vm";

import type { BrowserContext } from "playwright";

import { activityLanes } from "./helpers/activity";
import {
  PAGE_SCRIPT,
  REDACTED,
  StressDiagnostics,
  bursts,
  digestsIn,
  formatIncident,
  isNavigationDigest,
  mergeSummaries,
  payloadErrors,
  redact,
  requestFlavour,
  serverFailureLines,
  type Incident,
} from "./helpers/diagnostics";
import { lineCollector, type Server, type ServerExit, type ServerLine } from "./helpers/server";

const SESSION = "41.k3J9vQ2mX8pL5rT7wZ1yB4nC6dF0hG2s";
const CSRF = "csrf-Tq8zN3vX5bR7mK1pW9yL2cJ4hF6dS0aE";

describe("redact", () => {
  test("removes the exact values a script knows, raw and URL-encoded", () => {
    const text = `cookie eod_session=${SESSION}; form _csrf=${CSRF}; encoded ${encodeURIComponent(SESSION)} and ${SESSION} again`;
    const out = redact(text, [SESSION, CSRF]);
    assert.ok(!out.includes(SESSION) && !out.includes(CSRF) && !out.includes(encodeURIComponent(SESSION)), out);
    assert.ok(out.includes(REDACTED));
  });

  test("removes secret-shaped values it was never told about", () => {
    const cases: [string, string][] = [
      ["postgres://elite_one_desk:devpassword@127.0.0.1:5432/db", "devpassword"],
      ["postgresql://user:p%40ss@db.internal/x", "p%40ss"],
      ["DATABASE_URL=postgres://a:b@c/d", "postgres://a:b@c/d"],
      ["AUTH_SECRET=s3cr3t-value-here", "s3cr3t-value-here"],
      ["PGPASSWORD=hunter2hunter2", "hunter2hunter2"],
      ["RESEND_API_KEY=re_live_abcdef123456", "re_live_abcdef123456"],
      ["Cookie: eod_session=1.abcdef; other=1", "abcdef"],
      ["set-cookie: eod_session=9.zzzzzz; Path=/; HttpOnly", "zzzzzz"],
      ["Authorization: Bearer abc.def.ghi", "abc.def.ghi"],
      ['{"password":"correct horse battery staple"}', "correct horse battery staple"],
      ["_csrf=AbCdEf123456&name=x", "AbCdEf123456"],
      ['{"csrfToken":"tok-123456789"}', "tok-123456789"],
      ["eod_session=12.qwertyuiop", "qwertyuiop"],
    ];
    for (const [input, secret] of cases) {
      const out = redact(input);
      assert.ok(!out.includes(secret), `${input} → ${out}`);
      assert.ok(out.includes(REDACTED), `${input} → ${out}`);
    }
  });

  test("leaves what a failure is diagnosed by alone", () => {
    const text =
      "Error: An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details. digest: '2338101830' at http://127.0.0.1:3812/admin/components/41";
    assert.equal(redact(text, [SESSION]), text);
  });

  test("ignores a known value too short to be a secret rather than erase ordinary text", () => {
    assert.equal(redact("the id is 41", ["41"]), "the id is 41");
  });
});

describe("Next.js failures", () => {
  test("digests are read from a Node error dump and from JSON", () => {
    const dump = ["⨯ Error: boom", "    at render (page.js:1:2) {", "  digest: '2338101830'", "}"].join("\n");
    assert.deepEqual(digestsIn(dump), ["2338101830"]);
    assert.deepEqual(digestsIn('{"digest":"NEXT_HTTP_ERROR_FALLBACK;404"}'), ["NEXT_HTTP_ERROR_FALLBACK;404"]);
    assert.deepEqual(digestsIn("no failure here"), []);
  });

  test("a navigation digest is told from a failure", () => {
    assert.equal(isNavigationDigest("NEXT_REDIRECT;replace;/admin/components;307;"), true);
    assert.equal(isNavigationDigest("NEXT_HTTP_ERROR_FALLBACK;404"), true);
    assert.equal(isNavigationDigest("NEXT_NOT_FOUND"), true);
    assert.equal(isNavigationDigest("2338101830"), false);
    assert.equal(isNavigationDigest("NEXT_REDIRECTED_ELSEWHERE"), false);
  });

  test("error rows are found in a Flight payload, and text rows are not read as rows", () => {
    // A text row carries its byte length, and its text may hold anything —
    // including what looks like an error row.
    const text = "says\n7:E{\"digest\":\"999\"} inside";
    const payload = [
      '0:{"a":"$@1","f":"","b":"build"}',
      `3:T${Buffer.byteLength(text).toString(16)},${text}1:E{"digest":"2338101830"}`,
      '2:E{"digest":"NEXT_HTTP_ERROR_FALLBACK;404"}',
      '4:I["(app)/page",[]]',
      "5:E{not json}",
      "",
    ].join("\n");
    const rows = payloadErrors(payload);
    assert.deepEqual(
      rows.map((row) => row.digest),
      ["2338101830", "NEXT_HTTP_ERROR_FALLBACK;404", "(unreadable error row)"],
    );
    assert.ok(rows[0]!.row.startsWith("1:E{"));
    assert.deepEqual(payloadErrors('0:{"a":"$@1"}\n1:{"ok":true}\n'), []);
  });

  test("a server's output: every stderr line but Node's notices, and stdout only when it is an error", () => {
    const line = (stream: ServerLine["stream"], text: string): ServerLine => ({ at: 1, stream, text });
    const lines = [
      line("out", "   ▲ Next.js 15.5.25"),
      line("out", "   - Local:        http://127.0.0.1:3812"),
      line("out", " ✓ Ready in 120ms"),
      line("err", "(node:1234) [DEP0040] DeprecationWarning: The `punycode` module is deprecated."),
      line("err", "(Use `node --trace-deprecation ...` to show where the warning was created)"),
      line("err", " ⨯ Error: connect ECONNREFUSED 127.0.0.1:5432"),
      line("err", "[reuse:catalog] Error: write CONNECTION_ENDED"),
      line("out", "TypeError: Cannot read properties of undefined (reading 'id')"),
      line("err", ""),
    ];
    assert.deepEqual(
      serverFailureLines(lines).map((entry) => entry.text),
      [" ⨯ Error: connect ECONNREFUSED 127.0.0.1:5432", "[reuse:catalog] Error: write CONNECTION_ENDED", "TypeError: Cannot read properties of undefined (reading 'id')"],
    );
  });

  test("lines written in one burst are one failure", () => {
    const at = (ms: number, text: string, stream: ServerLine["stream"] = "err"): ServerLine => ({ at: ms, stream, text });
    const groups = bursts([at(0, "⨯ Error: boom"), at(3, "    at x"), at(5, "  digest: '1'"), at(500, "[media] later"), at(502, "out line", "out")]);
    assert.deepEqual(
      groups.map((group) => group.map((line) => line.text)),
      [["⨯ Error: boom", "    at x", "  digest: '1'"], ["[media] later"], ["out line"]],
    );
  });

  test("requests are told apart the way the app router sends them", () => {
    assert.equal(requestFlavour({ "next-action": "7f3a" }, "fetch"), "action");
    assert.equal(requestFlavour({ rsc: "1", "next-router-prefetch": "1" }, "fetch"), "prefetch");
    assert.equal(requestFlavour({ rsc: "1" }, "fetch"), "rsc");
    assert.equal(requestFlavour({}, "document"), "document");
    assert.equal(requestFlavour({}, "script"), "other");
  });
});

describe("a server's output, line by line", () => {
  test("chunks are split into timestamped lines, partial lines wait, and the end flushes them", () => {
    let now = 1_000;
    const collect = lineCollector(3, () => now);
    collect.write("out", "▲ Next.js\n - Local: http://127.0.0.1:3812\n ✓ Rea");
    now = 1_050;
    collect.write("out", "dy in 80ms\n");
    collect.write("err", "⨯ Error: boom\r\n  digest: '12");
    now = 1_100;
    collect.end();
    assert.deepEqual(
      collect.lines().map((line) => [line.at, line.stream, line.text]),
      // Bounded to the last three lines.
      [
        [1_050, "out", " ✓ Ready in 80ms"],
        [1_050, "err", "⨯ Error: boom"],
        [1_100, "err", "  digest: '12"],
      ],
    );
  });
});

describe("the page-side reporter", () => {
  /** Runs PAGE_SCRIPT in a stand-in for a document: its listeners, its console and its binding. */
  function page() {
    class ErrorEvent extends Event {
      error: unknown;
      message: string;
      constructor(type: string, init: { error?: unknown; message?: string }) {
        super(type);
        this.error = init.error;
        this.message = init.message ?? "";
      }
    }
    const target = new EventTarget();
    const reports: Record<string, unknown>[] = [];
    const printed: unknown[][] = [];
    const sandbox: Record<string, unknown> = {
      addEventListener: target.addEventListener.bind(target),
      ErrorEvent,
      Error,
      console: { error: (...args: unknown[]) => printed.push(args) },
      location: { href: "http://127.0.0.1:3812/admin/components" },
      __eodStressReport: (report: Record<string, unknown>) => reports.push(report),
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(PAGE_SCRIPT, sandbox);
    return { target, reports, printed, sandbox, ErrorEvent };
  }

  test("an uncaught error is reported with the digest Playwright's page error loses", () => {
    const { target, reports, ErrorEvent } = page();
    const error = Object.assign(new Error("An error occurred in the Server Components render."), { digest: "2338101830" });
    target.dispatchEvent(new ErrorEvent("error", { error }));
    assert.equal(reports.length, 1);
    assert.equal(reports[0]!.kind, "error");
    assert.equal(reports[0]!.digest, "2338101830");
    assert.equal(reports[0]!.name, "Error");
    assert.equal(reports[0]!.url, "http://127.0.0.1:3812/admin/components");
    assert.ok(String(reports[0]!.stack).includes("Error: An error occurred"));
  });

  test("an unhandled rejection and an error passed to console.error are reported; console still prints", () => {
    const { target, reports, printed, sandbox } = page();
    const rejection = Object.assign(new Event("unhandledrejection"), { reason: Object.assign(new Error("lost"), { digest: "77" }) });
    target.dispatchEvent(rejection);
    const consoleError = (sandbox.console as { error: (...args: unknown[]) => void }).error;
    consoleError("React caught:", Object.assign(new Error("caught"), { digest: "88" }));
    assert.deepEqual(
      reports.map((report) => [report.kind, report.digest]),
      [
        ["unhandledrejection", "77"],
        ["console.error", "88"],
      ],
    );
    assert.equal(printed.length, 1);
    assert.equal(printed[0]![0], "React caught:");
  });

  test("a resource that failed to load is not an error event of the page", () => {
    const { target, reports } = page();
    target.dispatchEvent(new Event("error"));
    assert.equal(reports.length, 0);
  });
});

/* -------------------------------------------------------------------------- */
/* The recorder, fed Playwright's events by stand-ins                         */
/* -------------------------------------------------------------------------- */

class FakePage extends EventEmitter {
  address = "http://127.0.0.1:3812/admin/components";
  url() {
    return this.address;
  }
}
class FakeContext extends EventEmitter {
  binding: ((source: unknown, report: unknown) => void) | null = null;
  scripts: string[] = [];
  async exposeBinding(_name: string, fn: (source: unknown, report: unknown) => void) {
    this.binding = fn;
  }
  async addInitScript(script: { content: string }) {
    this.scripts.push(script.content);
  }
}
const request = (url: string, headers: Record<string, string> = {}, type = "fetch", failure: string | null = null, method = "GET") => ({
  url: () => url,
  method: () => method,
  headers: () => headers,
  resourceType: () => type,
  failure: () => (failure ? { errorText: failure } : null),
});
const response = (req: ReturnType<typeof request>, status: number, body: string | null) => ({
  request: () => req,
  status: () => status,
  statusText: () => (status >= 500 ? "Internal Server Error" : "OK"),
  text: () => (body === null ? Promise.reject(new Error("body unavailable")) : Promise.resolve(body)),
});
const fakeServer = (lines: ServerLine[], exit: ServerExit | null = null): Server => ({
  origin: "http://127.0.0.1:3812",
  stop: async () => {},
  log: () => lines.map((line) => line.text).join("\n"),
  lines: () => lines,
  pid: 4242,
  exit: () => exit,
});

async function recorder() {
  const printed: string[] = [];
  const diag = new StressDiagnostics("w0", { secrets: [SESSION], print: (block) => printed.push(block) });
  diag.addSecrets(CSRF);
  const context = new FakeContext();
  await diag.watch(context as unknown as BrowserContext);
  const pageStub = new FakePage();
  context.emit("page", pageStub);
  return { diag, context, page: pageStub, printed };
}
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe("StressDiagnostics", () => {
  test("instruments a context: the page-side reporter goes in before the first page", async () => {
    const { context } = await recorder();
    assert.ok(context.binding, "a binding for the page's own reports");
    assert.deepEqual(context.scripts, [PAGE_SCRIPT]);
  });

  test("a page error is kept whole, with its step and page, and gains the digest the page reported", async () => {
    const { diag, context, page: p, printed } = await recorder();
    diag.at({ worker: 0, round: 17, step: "create: Create draft, then wait for the component's page" });
    const message = `An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details. A digest property is included on this error instance which may provide additional details about the nature of the error.`;
    assert.ok(message.length > 160);
    const error = Object.assign(new Error(message), { stack: `Error: ${message}\n    at https://x/_next/static/chunks/app.js:1:2` });
    p.emit("pageerror", error);
    context.binding!(null, { kind: "error", name: "Error", message, stack: null, digest: "2338101830", url: p.address, at: Date.now() });
    const [incident] = diag.flush();
    assert.equal(incident!.kind, "pageerror");
    assert.equal(incident!.message, message, "never cut at 160 characters");
    assert.deepEqual(incident!.digests, ["2338101830"]);
    assert.deepEqual(incident!.step, { worker: 0, round: 17, step: "create: Create draft, then wait for the component's page" });
    assert.equal(incident!.page, p.address);
    assert.equal(diag.pageErrors().length, 1);
    assert.equal(diag.unexpected().length, 0, "a page error is N4's, not N5's");
    assert.equal(printed.length, 1);
    assert.ok(printed[0]!.includes("digest    2338101830"));
    assert.ok(printed[0]!.includes("round 17"));
  });

  test("console errors count, except a resource answering 404", async () => {
    const { diag, page: p } = await recorder();
    const message = (text: string) => ({ type: () => "error", text: () => text, location: () => ({ url: "http://x/a.js", lineNumber: 1, columnNumber: 2 }) });
    p.emit("console", message("Failed to load resource: the server responded with a status of 404 (Not Found)"));
    p.emit("console", message("Warning: something React said"));
    p.emit("console", { type: () => "log", text: () => "fine", location: () => ({}) });
    diag.flush();
    assert.deepEqual(diag.unexpected().map((incident) => incident.kind), ["console"]);
    assert.equal(diag.summary().console404, 1);
  });

  test("a cancelled request is counted; a reset is an incident", async () => {
    const { diag, page: p } = await recorder();
    p.emit("requestfailed", request("http://127.0.0.1:3812/admin/components/9", { rsc: "1", "next-router-prefetch": "1" }, "fetch", "net::ERR_ABORTED"));
    p.emit("requestfailed", request("http://127.0.0.1:3812/admin/components", {}, "document", "net::ERR_CONNECTION_RESET"));
    diag.flush();
    const [reset] = diag.unexpected();
    assert.equal(reset!.kind, "requestfailed");
    assert.equal(reset!.request!.flavour, "document");
    assert.equal(diag.summary().cancelledRequests, 1);
  });

  test("a failed action, a 5xx and an error row in a payload are incidents; a notFound row is not", async () => {
    const { diag, page: p } = await recorder();
    const action = request("http://127.0.0.1:3812/admin/components", { "next-action": "7f3a" }, "fetch", null, "POST");
    p.emit("response", response(action, 500, '0:{"a":"$@1"}\n1:E{"digest":"4001"}\n'));
    const doc = request("http://127.0.0.1:3812/admin/components", {}, "document");
    p.emit("response", response(doc, 502, "Bad Gateway"));
    const rsc = request("http://127.0.0.1:3812/admin/components/12", { rsc: "1" });
    p.emit("response", response(rsc, 200, '0:["$","$L1",null]\n1:E{"digest":"4002"}\n'));
    const notFound = request("http://127.0.0.1:3812/admin/components/13", { rsc: "1" });
    p.emit("response", response(notFound, 200, '1:E{"digest":"NEXT_HTTP_ERROR_FALLBACK;404"}\n'));
    const gone = request("http://127.0.0.1:3812/admin/components/14", { rsc: "1", "next-router-prefetch": "1" });
    p.emit("response", response(gone, 200, null));
    await settle();
    diag.flush();
    assert.deepEqual(
      diag.unexpected().map((incident) => [incident.kind, incident.digests]),
      [
        ["action", ["4001"]],
        ["http", []],
        ["payload", ["4002"]],
      ],
    );
    const summary = diag.summary();
    assert.equal(summary.payloadsRead, 4);
    assert.equal(summary.payloadsUnread, 1);
    assert.deepEqual(summary.digests.sort(), ["4001", "4002"]);
  });

  test("a server's error burst is one incident with its digest; its lines are printed beside the incidents of its time", async () => {
    const { diag, page: p, printed } = await recorder();
    const now = Date.now();
    const lines: ServerLine[] = [
      { at: now - 50, stream: "out", text: " ✓ Ready in 90ms" },
      { at: now, stream: "err", text: " ⨯ Error: write CONNECTION_ENDED 127.0.0.1:5432" },
      { at: now + 2, stream: "err", text: "    at Socket.end (postgres/connection.js:1:1) {" },
      { at: now + 3, stream: "err", text: "  digest: '3150923467'" },
      { at: now + 4, stream: "err", text: "}" },
    ];
    diag.adopt(fakeServer(lines), "server 3812");
    p.emit("pageerror", new Error("An error occurred in the Server Components render."));
    diag.flush();
    const log = diag.unexpected().filter((incident) => incident.kind === "server-log");
    assert.equal(log.length, 1);
    assert.deepEqual(log[0]!.digests, ["3150923467"]);
    const pageError = diag.pageErrors()[0]!;
    assert.equal(pageError.server?.label, "server 3812");
    assert.ok(pageError.server!.lines.some((line) => line.text.includes("CONNECTION_ENDED")));
    assert.ok(printed.some((block) => block.includes("server server 3812 (pid 4242)")));
  });

  test("a server that exits by itself is an incident; one that was stopped is not", async () => {
    const { diag } = await recorder();
    diag.adopt(fakeServer([], { at: 1, code: null, signal: "SIGTERM", requested: true }), "server 3812");
    diag.adopt(fakeServer([], { at: 2, code: 1, signal: null, requested: false }), "server 3812");
    diag.flush();
    diag.flush();
    assert.deepEqual(diag.unexpected().map((incident) => incident.kind), ["server-exit"]);
    assert.equal(diag.summary().serverExitsUnasked, 1);
    assert.equal(diag.summary().serverStarts, 2);
  });

  test("a page that never arrived and a step that threw are printed but are not N5's", async () => {
    const { diag, printed } = await recorder();
    diag.record({ kind: "navigation", message: "server 0 round 3: created #12, still on /admin/components" });
    diag.record({ kind: "step", name: "TimeoutError", message: "page.goto: Timeout 30000ms exceeded." });
    diag.flush();
    assert.equal(diag.unexpected().length, 0);
    assert.equal(printed.length, 2);
  });

  test("nothing printed carries a secret, whichever field it arrived in", async () => {
    const { diag, page: p, context, printed } = await recorder();
    p.address = `http://127.0.0.1:3812/admin/components?_csrf=${CSRF}`;
    p.emit("pageerror", Object.assign(new Error(`boom with cookie value ${SESSION}`), { stack: `Error: x\n at y (eod_session=${SESSION})` }));
    context.binding!(null, { kind: "error", name: "Error", message: `boom with cookie value ${SESSION}`, stack: null, digest: "1", url: p.address, at: Date.now() });
    diag.adopt(fakeServer([{ at: Date.now(), stream: "err", text: `[auth] DATABASE_URL=postgres://u:pw@h/d AUTH_SECRET=xyz123456 token ${CSRF}` }]), "server 3812");
    diag.flush();
    const all = printed.join("\n");
    assert.ok(printed.length >= 2);
    for (const secret of [SESSION, CSRF, "postgres://u:pw@", "xyz123456"]) assert.ok(!all.includes(secret), `printed ${secret}`);
    for (const line of all.split("\n")) assert.ok(line.startsWith("diag"), line);
  });
});

describe("what a log keeps", () => {
  const incident: Incident = {
    kind: "pageerror",
    at: Date.parse("2026-10-03T18:00:00.000Z"),
    step: { worker: 2, round: 17, step: "create: Create draft" },
    page: "http://127.0.0.1:3814/admin/components",
    name: "Error",
    message: "x".repeat(400),
    stack: "Error: x\n    at a (b.js:1:2)",
    digests: ["2338101830"],
    request: { method: "POST", url: "http://127.0.0.1:3814/admin/components", flavour: "action", status: 200, statusText: "OK" },
  };

  test("every field, whole, on lines a suite runner never counts as PASS or FAIL", () => {
    const block = formatIncident("w2", 1, incident, [
      { at: incident.at - 100, what: "request", method: "POST", url: "http://127.0.0.1:3814/admin/components", flavour: "action" },
      { at: incident.at - 50, what: "failed", method: "GET", url: "http://127.0.0.1:3814/admin/components/4?x=1", flavour: "prefetch", failure: "net::ERR_ABORTED" },
    ]);
    const lines = block.split("\n");
    assert.match(lines[0]!, /^diag w2 #1 pageerror · worker 2 · round 17 · create: Create draft · 2026-10-03T18:00:00\.000Z$/);
    assert.ok(block.includes("x".repeat(400)), "the whole message");
    assert.ok(block.includes("digest    2338101830"));
    assert.ok(block.includes("POST http://127.0.0.1:3814/admin/components [action] → 200 OK"));
    assert.ok(block.includes("GET /admin/components/4?x=1 [prefetch] ✗ net::ERR_ABORTED"));
    assert.ok(block.includes("    at a (b.js:1:2)"));
    for (const line of lines) {
      assert.ok(line.startsWith("diag"), line);
      assert.ok(!/^(PASS|FAIL)/.test(line));
    }
  });

  test("several workers' summaries add up", () => {
    const one = {
      pageErrors: 1,
      unexpected: { http: 1 },
      digests: ["1"],
      console404: 2,
      cancelledRequests: 10,
      payloadsRead: 5,
      payloadsUnread: 1,
      serverStarts: 31,
      serverExitsUnasked: 0,
      rounds: 30,
      slowestRoundMs: 4_000,
    };
    const merged = mergeSummaries([one, { ...one, unexpected: { http: 2, payload: 1 }, digests: ["1", "2"], slowestRoundMs: 9_000 }]);
    assert.equal(merged.pageErrors, 2);
    assert.deepEqual(merged.unexpected, { http: 3, payload: 1 });
    assert.deepEqual(merged.digests, ["1", "2"]);
    assert.equal(merged.serverStarts, 62);
    assert.equal(merged.slowestRoundMs, 9_000);
  });
});

describe("concurrent activity", () => {
  test("STRESS_ACTIVITY: off, three lanes by default, a number up to eight", () => {
    assert.equal(activityLanes(undefined), 0);
    assert.equal(activityLanes(""), 0);
    assert.equal(activityLanes("0"), 0);
    assert.equal(activityLanes("1"), 3);
    assert.equal(activityLanes("yes"), 3);
    assert.equal(activityLanes("5"), 5);
    assert.equal(activityLanes("40"), 8);
  });
});
