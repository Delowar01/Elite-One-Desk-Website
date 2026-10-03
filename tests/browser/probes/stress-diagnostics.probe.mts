/**
 * Batch 21A: the stress diagnostics (`tests/helpers/diagnostics.ts`), proven in
 * a real Chromium. A stress failure that happens once in a CI run is only as
 * useful as what was recorded when it happened, so the recorder is made to see
 * each kind of failure on purpose, here, where nothing else is going on:
 *
 *  · a stub HTTP server (port 3734) serves pages that throw — one with a
 *    digest and a message longer than the 160 characters the stress script
 *    used to keep — reject, complain on the console, call a "Server Action"
 *    that answers 500 with an error row, fetch an RSC payload with an error
 *    row and one whose only error is a notFound, lose a connection, and cancel
 *    a request by navigating;
 *  · the real application server (port 3733) is started and stopped, and its
 *    output is kept line by line;
 *  · a process that writes a Next.js-style error and exits by itself.
 *
 * The page errors in this probe are provoked by its own stub pages; they are
 * what is being recorded, not a failure of the application. No application
 * page is visited.
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";

import { StressDiagnostics, type Incident } from "../../helpers/diagnostics";
import { giveFresh } from "../../helpers/fixtures";
import { dropDatabase } from "../../helpers/pg";
import { startServer, watchProcess, type Server } from "../../helpers/server";
import { launchChromium } from "../harness";
import { until } from "../wait";

const PORT = 3733;
const STUB = `http://127.0.0.1:${PORT + 1}`;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const SESSION = "77.Qm3vX9pL2rT8wZ5yB1nC4dF7hG0sK6jA";
const CSRF = "csrf-Hn4xR8vM2qW6tY0uP3sL7dK1fJ5gB9cE";
const DB_PASSWORD = "hunter2hunter2";
const LONG =
  "An error occurred in the Server Components render. The specific message is omitted in production builds to avoid leaking sensitive details. A digest property is included on this error instance which may provide additional details about the nature of the error.";

const page = (body: string) => `<!doctype html><html><head><title>stub</title></head><body>${body}</body></html>`;
const PAGES: Record<string, string> = {
  "/page/throw": page(
    `<script>setTimeout(() => { const e = new Error(${JSON.stringify(LONG)}); e.digest = "2338101830"; throw e; }, 0);</script>`,
  ),
  "/page/reject": page(`<script>Promise.reject(Object.assign(new Error("lost in a promise"), { digest: "1122334455" }));</script>`),
  "/page/console": page(`<img src="/missing.png" alt=""><script>console.error("Something the page itself complained about");</script>`),
  "/page/action": page(
    `<script>fetch("/act", { method: "POST", headers: { "Next-Action": "7f3a" }, body: "[]" }).then((r) => r.text()).then(() => { document.title = "done"; });</script>`,
  ),
  "/page/rsc": page(
    `<script>Promise.all(["bad", "notfound"].map((kind) => fetch("/flight?" + kind, { headers: { RSC: "1" } }).then((r) => r.text()))).then(() => { document.title = "done"; });</script>`,
  ),
  "/page/reset": page(`<script>fetch("/reset").catch(() => { document.title = "done"; });</script>`),
  "/page/cancel": page(`<script>fetch("/slow"); setTimeout(() => location.assign("/page/blank"), 150);</script>`),
  "/page/secret": page(
    `<script>fetch("/echo?_csrf=${CSRF}").then((r) => r.text()).then(() => { throw new Error("cookie value ${SESSION} leaked into a message"); });</script>`,
  ),
  "/page/blank": page("<p>blank</p>"),
};

const stub = createServer((request, response) => {
  const url = new URL(request.url ?? "/", STUB);
  const html = PAGES[url.pathname];
  if (html) return response.writeHead(200, { "content-type": "text/html" }).end(html);
  switch (url.pathname) {
    case "/act":
      return response.writeHead(500, { "content-type": "text/x-component" }).end('0:{"a":"$@1"}\n1:E{"digest":"4001"}\n');
    case "/flight":
      return response
        .writeHead(200, { "content-type": "text/x-component" })
        .end(url.search === "?bad" ? '0:["$","$L1",null]\n1:E{"digest":"4002"}\n' : '1:E{"digest":"NEXT_HTTP_ERROR_FALLBACK;404"}\n');
    case "/reset":
      return request.socket.destroy();
    case "/slow":
      return void setTimeout(() => response.writeHead(200).end("late"), 5_000).unref();
    case "/echo":
      return response.writeHead(500, { "content-type": "text/plain" }).end(`could not answer ${request.url}`);
    default:
      return response.writeHead(404).end();
  }
});
await new Promise<void>((resolve) => stub.listen(PORT + 1, "127.0.0.1", resolve));

const printed: string[] = [];
const diag = new StressDiagnostics("probe", { secrets: [SESSION, CSRF], print: (block) => printed.push(block) });
const browser = await launchChromium();
const database = giveFresh("stress_diagnostics");
let server: Server | undefined;
const has = (kind: Incident["kind"], test: (incident: Incident) => boolean = () => true) =>
  diag.incidents.some((incident) => incident.kind === kind && test(incident));
try {
  const context = await browser.newContext();
  await diag.watch(context);
  const tab = await context.newPage();
  const visit = async (round: number, path: string, until_: () => boolean) => {
    diag.at({ worker: 0, round, step: `visit ${path}` });
    await tab.goto(`${STUB}${path}`, { waitUntil: "load" });
    await until(async () => until_(), 10_000);
    return diag.flush();
  };

  /* 1–2. an uncaught error, whole, with the digest the page reported */
  const [thrown] = await visit(1, "/page/throw", () => has("pageerror"));
  say(
    "an uncaught page error is recorded whole: the full message (over 160 characters), its name and stack, the page and the step",
    thrown?.kind === "pageerror" &&
      thrown.message === LONG &&
      LONG.length > 160 &&
      thrown.name === "Error" &&
      Boolean(thrown.stack?.includes("Error:")) &&
      thrown.page === `${STUB}/page/throw` &&
      thrown.step?.step === "visit /page/throw",
    thrown ? `${thrown.message.length} chars, page ${thrown.page}` : "nothing recorded",
  );
  say(
    "…with the digest the page itself reported, which Playwright's page error loses",
    thrown?.digests.join() === "2338101830",
    thrown?.digests.join() || "no digest",
  );

  /* 3. an unhandled rejection */
  const [rejected] = await visit(2, "/page/reject", () => has("pageerror", (incident) => incident.message.includes("lost in a promise")));
  say(
    "an unhandled rejection is a page error too, with its digest",
    rejected?.message === "lost in a promise" && rejected.digests.join() === "1122334455",
    rejected ? `${rejected.message} [${rejected.digests.join()}]` : "nothing recorded",
  );

  /* 4. the console — the picture's 404, and the browser's own /favicon.ico */
  await visit(3, "/page/console", () => has("console") && diag.summary().console404 > 0);
  say(
    "an unexpected console error is an incident; a resource answering 404 is only counted",
    has("console", (incident) => incident.message === "Something the page itself complained about") &&
      diag.summary().console404 >= 1 &&
      !has("console", (incident) => incident.message.includes("404")),
    `console incidents ${diag.incidents.filter((incident) => incident.kind === "console").length}, 404s counted ${diag.summary().console404}`,
  );

  /* 5. a Server Action answering 500 */
  await visit(4, "/page/action", () => has("action"));
  const action = diag.incidents.find((incident) => incident.kind === "action");
  say(
    "a Server Action answering 500 is an incident carrying the digest from its body",
    action?.request?.flavour === "action" && action.request.status === 500 && action.digests.includes("4001"),
    action ? `${action.message} [${action.digests.join()}]` : "nothing recorded",
  );

  /* 6. RSC payloads */
  await visit(5, "/page/rsc", () => has("payload"));
  await until(async () => (await tab.title()) === "done", 5_000);
  diag.flush();
  const payloads = diag.incidents.filter((incident) => incident.kind === "payload");
  say(
    "an RSC payload with an error row is an incident with that digest; one whose only error row is a notFound is not",
    payloads.length === 1 && payloads[0]!.digests.join() === "4002" && payloads[0]!.request?.url.endsWith("/flight?bad") === true,
    payloads.map((incident) => `${incident.request?.url} [${incident.digests.join()}]`).join(" | ") || "nothing recorded",
  );

  /* 7. a dropped connection, and a cancelled request */
  await visit(6, "/page/reset", () => has("requestfailed"));
  await visit(7, "/page/cancel", () => tab.url().endsWith("/page/blank") && diag.summary().cancelledRequests > 0);
  const dropped = diag.incidents.filter((incident) => incident.kind === "requestfailed");
  say(
    "a connection the server dropped is an incident; a request the browser cancelled by navigating is only counted",
    dropped.length === 1 &&
      dropped[0]!.request?.url.endsWith("/reset") === true &&
      dropped[0]!.request.failure !== "net::ERR_ABORTED" &&
      diag.summary().cancelledRequests >= 1,
    `${dropped.map((incident) => incident.message).join(" | ")} · cancelled ${diag.summary().cancelledRequests}`,
  );

  /* 8. the real application server: its output, kept line by line, and a stop that reads as asked for */
  diag.at({ worker: 0, round: 8, step: "start and stop the application server" });
  server = await startServer(database, PORT);
  diag.adopt(server, `server ${PORT}`);
  diag.flush();
  const ready = server.lines().find((line) => line.stream === "out" && /Ready in/.test(line.text));
  await server.stop();
  diag.flush();
  say(
    "a real application server's output is kept line by line with the time it arrived, and its stop reads as asked for",
    Boolean(ready && ready.at > 0) &&
      server.exit()?.requested === true &&
      !has("server-exit") &&
      !has("server-log"),
    `ready line ${ready ? `at ${new Date(ready.at).toISOString()}` : "missing"}, exit ${JSON.stringify(server.exit())}`,
  );

  /* 9. a process that fails and exits by itself */
  diag.at({ worker: 0, round: 9, step: "a process that fails on its own" });
  const child = spawn(process.execPath, [
    "-e",
    `console.error(" ⨯ Error: connect failed for postgres://probe:${DB_PASSWORD}@127.0.0.1:5432/x"); console.error("  digest: '3150923467'"); setTimeout(() => process.exit(3), 50);`,
  ]);
  const watched = watchProcess(child);
  await new Promise((resolve) => child.once("close", resolve));
  diag.adopt({ origin: "", stop: async () => {}, log: watched.log, lines: watched.lines, pid: child.pid, exit: watched.exit }, "failing child");
  diag.flush();
  const burst = diag.incidents.find((incident) => incident.kind === "server-log");
  const exit = diag.incidents.find((incident) => incident.kind === "server-exit");
  say(
    "a process that writes an error and exits by itself is two incidents: the error, with its digest, and the exit",
    burst?.digests.join() === "3150923467" && Boolean(exit?.message.includes("code 3")),
    `${burst?.message ?? "no error recorded"} · ${exit?.message ?? "no exit recorded"}`,
  );

  /* 10. nothing secret is printed */
  await visit(10, "/page/secret", () => has("pageerror", (incident) => incident.message.includes("leaked")) && has("http"));
  const all = printed.join("\n");
  const leaked = [SESSION, CSRF, DB_PASSWORD, encodeURIComponent(CSRF)].filter((secret) => all.includes(secret));
  say(
    "nothing printed carries the session, the CSRF token or a database password, and every printed line starts with diag",
    printed.length >= 8 && leaked.length === 0 && all.split("\n").every((line) => line.startsWith("diag")),
    `${printed.length} incidents printed${leaked.length ? `, leaked ${leaked.length}` : ""}`,
  );
  await context.close();
} finally {
  await server?.stop();
  await browser.close();
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  dropDatabase(database);
}
