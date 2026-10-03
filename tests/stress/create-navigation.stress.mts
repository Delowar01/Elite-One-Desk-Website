/**
 * Batch 19B stress: creating a reusable component opens it, and deleting one
 * returns to the list — every time, under load.
 *
 * Fresh-clone browser run 2 of the release-candidate gate caught the reusable
 * probe waiting thirty seconds on the list after "Create draft": the
 * component had been created, but the screen never moved. The screen opened
 * the new component with `router.push` the moment the server action answered,
 * while the action's own router update — the list it had revalidated — was
 * still rendering. React lost the ping of a stream chunk that resolved during
 * that render and left every transition lane suspended with nothing left to
 * wake it (see `components-client.tsx`). It needed load to show — a few
 * creates in a hundred, with three servers busy at once — so this script makes
 * that load: three servers, each on its own database with a list long enough
 * to prefetch, each creating components one after another from a cold start.
 *
 *   N1  every create lands on its own component's page
 *   N2  …because the browser loads that page: the list's document is gone,
 *       so there is no client transition left to hang
 *   N3  every component deleted from its page returns to the list, which no
 *       longer shows it
 *   N4  nothing created twice, no page errors
 *   N5  nothing failed behind the screen: no 5xx, no failed Server Action, no
 *       error row in any RSC payload, no failed request, no unexpected console
 *       error, no error in a server's output, no server exit nobody asked for
 *
 * Batch 21A: Stress run 37064560289 failed N4 with three page errors, "An error
 * occurred in the Server Components render…", and nothing to go on — the
 * messages cut at 160 characters, no digest, no step, the servers' output
 * gone. Everything here now runs under `helpers/diagnostics.ts`: an incident
 * is printed whole, with its digest, the worker, round and step, the requests
 * before it and what its server wrote around it (lines starting `diag`), and
 * the run ends with a `diag summary` line. N5 makes the server side of the same
 * failure count on its own, whether or not a page ever showed it.
 *
 *   STRESS_LOOPS=30      creates per server; deletes are a third of that
 *   STRESS_ACTIVITY=1    the application busy beside the browser on every
 *                        server (helpers/activity.ts): RSC navigations, Visual
 *                        Editor route reads, drafts, publishes, component
 *                        create/delete — 3 lanes a server, or STRESS_ACTIVITY=<n>
 */
import type { Browser, BrowserContext, Page } from "playwright";

import { callAction } from "../helpers/action";
import { activityLanes, startActivity, type Activity } from "../helpers/activity";
import { StressDiagnostics, mergeSummaries, type DiagnosticsSummary, type Incident } from "../helpers/diagnostics";
import { giveFresh } from "../helpers/fixtures";
import { connect, dropDatabase } from "../helpers/pg";
import { startServer, type Server } from "../helpers/server";
import { signIn } from "../helpers/session";
import { launchChromium } from "../browser/harness";

/** The first of three: each worker serves on PORT + its index (3812–3814). */
const PORT = 3812;
const WORKERS = 3;
const LOOPS = Number(process.env.STRESS_LOOPS ?? 30);
const DELETES = Math.max(1, Math.round(LOOPS / 3));
const LANES = activityLanes(process.env.STRESS_ACTIVITY);
/** Enough components that the list prefetches a page of links as it loads. */
const LISTED = 18;
const LANDING_MS = 20_000;
const RC = { route: "/admin/components", file: "app/(backoffice)/admin/(shell)/components/actions.ts" };
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

type Outcome = {
  creates: number;
  landed: number;
  documentLoads: number;
  deletes: number;
  returned: number;
  duplicates: number;
  misses: string[];
  diag: StressDiagnostics;
  activity: Record<string, number>;
};

async function worker(index: number): Promise<Outcome> {
  const watched = new StressDiagnostics(`w${index}`);
  const out: Outcome = {
    creates: 0,
    landed: 0,
    documentLoads: 0,
    deletes: 0,
    returned: 0,
    duplicates: 0,
    misses: [],
    diag: watched,
    activity: {},
  };
  const browser: Browser = await launchChromium();
  const database = giveFresh(`create_nav_${index}`);
  const sql = connect(database);
  let server: Server | undefined;
  let activity: Activity | undefined;
  try {
    const owner = await signIn(sql);
    const [cookieName, cookieValue] = owner.cookie.split("=");
    // Never printed: the session and its CSRF token are removed by value from every diag line.
    watched.addSecrets(cookieValue!, owner.csrfToken);
    if (LANES) {
      activity = startActivity({
        lanes: LANES,
        cookie: owner.cookie,
        csrf: owner.csrfToken,
        sql,
        report: (incident) => watched.record({ kind: "activity", ...incident }),
      });
    }
    /** A step the script cannot go on without: what it was doing is recorded with what went wrong. */
    const must = async <T,>(page: Page | null, what: () => Promise<T>): Promise<T> => {
      try {
        return await what();
      } catch (error) {
        watched.record({
          kind: "step",
          page: page?.url(),
          name: error instanceof Error ? error.name : undefined,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        watched.flush();
        throw error;
      }
    };
    const restart = async () => {
      // From cold, as the probe meets it: a fresh server, nothing warmed.
      watched.flush();
      await activity?.pause();
      await server?.stop();
      server = await startServer(database, PORT + index);
      watched.adopt(server, `server ${PORT + index}`);
      activity?.resume(server.origin);
      return server.origin;
    };
    const create = async (origin: string, name: string, publish = false) => {
      const form = new FormData();
      form.set("_csrf", owner.csrfToken);
      form.set("kind", "cta");
      form.set("name", name);
      form.set("publish", publish ? "1" : "0");
      const result = await callAction<{ ok: boolean; message: string; component?: { id: number } }>({
        ...RC,
        origin,
        action: "createReusableComponent",
        args: [form],
        cookie: owner.cookie,
      });
      if (!result.value?.ok || !result.value.component) throw new Error(`could not seed ${name}: ${result.value?.message}`);
      return result.value.component.id;
    };
    watched.at({ worker: index, step: "seed: start a server" });
    let origin = await restart();
    watched.at({ worker: index, step: `seed: create ${LISTED} listed components` });
    for (let n = 1; n <= LISTED; n += 1) await must(null, () => create(origin, `Listed CTA ${index}-${n}`));

    const open = async (): Promise<{ context: BrowserContext; page: Page }> => {
      const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
      await context.addCookies([{ name: cookieName!, value: cookieValue!, domain: "127.0.0.1", path: "/" }]);
      await context.addInitScript({ content: "window.__name = window.__name || ((fn) => fn);" });
      await watched.watch(context);
      const page = await context.newPage();
      return { context, page };
    };

    for (let round = 1; round <= LOOPS; round += 1) {
      watched.at({ worker: index, round, step: "create: restart the server" });
      origin = await restart();
      const name = `Stress CTA ${index}-${round}`;
      const { context, page } = await open();
      try {
        watched.at({ worker: index, round, step: "create: open the list" });
        await must(page, () => page.goto(`${origin}/admin/components`, { waitUntil: "load" }));
        watched.at({ worker: index, round, step: "create: fill the form" });
        await must(page, () => page.getByRole("button", { name: "New reusable component" }).click());
        const form = page.getByRole("form", { name: "New reusable component" });
        await must(page, () => form.getByLabel("Type").selectOption("cta"));
        await must(page, () => form.getByLabel(/^Name/).fill(name));
        // Marks this document; a page loaded by the browser starts without it.
        await page.evaluate(() => ((window as unknown as { __eodList?: boolean }).__eodList = true));
        watched.at({ worker: index, round, step: "create: Create draft, then wait for the component's page" });
        await must(page, () => form.getByRole("button", { name: "Create draft" }).click());
        out.creates += 1;
        const landed = await page
          .waitForURL(/\/admin\/components\/\d+$/, { timeout: LANDING_MS })
          .then(() => true, () => false);
        watched.at({ worker: index, round, step: "create: check the component's page" });
        const [row] = await sql<{ id: number }[]>`select id from reusable_components where name = ${name}`;
        const rows = await sql<{ n: number }[]>`select count(*)::int as n from reusable_components where name = ${name}`;
        if (rows[0]!.n > 1) out.duplicates += 1;
        if (landed && row && page.url().endsWith(`/admin/components/${row.id}`)) {
          out.landed += 1;
          const listSurvived = await page.evaluate(() => Boolean((window as unknown as { __eodList?: boolean }).__eodList));
          if (!listSurvived) out.documentLoads += 1;
        } else {
          const miss = `server ${index} round ${round}: created ${row ? `#${row.id}` : "nothing"}, still on ${page.url()}`;
          out.misses.push(miss);
          watched.record({ kind: "navigation", page: page.url(), message: miss });
        }
      } finally {
        watched.flush();
        await context.close();
      }

      if (round % 3 !== 0 || out.deletes >= DELETES) continue;
      // Delete from the component's own page: an unused draft, so Delete is offered.
      watched.at({ worker: index, round, step: "delete: create the doomed component" });
      const doomedName = `Doomed CTA ${index}-${round}`;
      const doomed = await must(null, () => create(origin, doomedName));
      const { context: deleting, page: detail } = await open();
      try {
        watched.at({ worker: index, round, step: "delete: open the component's page" });
        await must(detail, () => detail.goto(`${origin}/admin/components/${doomed}`, { waitUntil: "load" }));
        watched.at({ worker: index, round, step: "delete: Delete permanently, confirm, then wait for the list" });
        await must(detail, () => detail.locator("[data-reuse-delete]").click());
        await must(detail, () =>
          detail.getByRole("alertdialog", { name: "Delete the component" }).getByRole("button", { name: "Delete" }).click(),
        );
        out.deletes += 1;
        const back = await detail
          .waitForURL(/\/admin\/components$/, { timeout: LANDING_MS })
          .then(() => true, () => false);
        watched.at({ worker: index, round, step: "delete: check the list" });
        const gone = (await sql`select 1 from reusable_components where id = ${doomed}`).length === 0;
        const listed = back ? await detail.getByText(doomedName, { exact: true }).count() : -1;
        if (back && gone && listed === 0) out.returned += 1;
        else {
          const miss = `server ${index} delete #${doomed}: returned ${back}, removed ${gone}, still listed ${listed}`;
          out.misses.push(miss);
          watched.record({ kind: "navigation", page: detail.url(), message: miss });
        }
      } finally {
        watched.flush();
        await deleting.close();
      }
    }
    watched.at({ worker: index, step: "finish: stop the server" });
  } finally {
    if (activity) out.activity = await activity.stop();
    await server?.stop();
    watched.flush();
    await browser.close();
    await sql.end({ timeout: 5 });
    dropDatabase(database);
  }
  return out;
}

const outcomes = await Promise.all(Array.from({ length: WORKERS }, (_, index) => worker(index)));
const total = (key: "creates" | "landed" | "documentLoads" | "deletes" | "returned" | "duplicates") =>
  outcomes.reduce((sum, outcome) => sum + outcome[key], 0);
const misses = outcomes.flatMap((outcome) => outcome.misses);
const pageErrors = outcomes.flatMap((outcome) => outcome.diag.pageErrors());
const behind = outcomes.flatMap((outcome) => outcome.diag.unexpected());
/** One incident in a line: what failed, its digest, and where the script was. */
const brief = (incident: Incident) =>
  `${incident.name ? `${incident.name}: ` : ""}${incident.message}` +
  (incident.digests.length ? ` [digest ${incident.digests.join(", ")}]` : "") +
  (incident.step ? ` (worker ${incident.step.worker}${incident.step.round !== undefined ? ` round ${incident.step.round}` : ""}, ${incident.step.step})` : "");

say(
  "N1. every create lands on its own component's page, three servers at once, each from cold",
  total("creates") === WORKERS * LOOPS && total("landed") === total("creates"),
  `${total("landed")}/${total("creates")} (${WORKERS} × ${LOOPS})${misses.length ? ` · ${misses.slice(0, 3).join(" | ")}` : ""}`,
);
say(
  "N2. …because the browser loads that page: the list's document is gone, so no client transition is left to hang",
  total("landed") > 0 && total("documentLoads") === total("landed"),
  `${total("documentLoads")}/${total("landed")} by a document load`,
);
say(
  "N3. every component deleted from its page returns to the list, which no longer shows it",
  total("deletes") === WORKERS * DELETES && total("returned") === total("deletes"),
  `${total("returned")}/${total("deletes")}`,
);
say(
  "N4. nothing created twice, and no page errors",
  total("duplicates") === 0 && pageErrors.length === 0,
  [total("duplicates") ? `${total("duplicates")} created twice` : "", ...pageErrors.map(brief)].filter(Boolean).join(" | "),
);
say(
  "N5. nothing failed behind the screen: no 5xx, failed action, error row in a payload, failed request, console error, server error line or unasked server exit",
  behind.length === 0,
  behind.slice(0, 5).map(brief).join(" | ") + (behind.length > 5 ? ` | … ${behind.length - 5} more (diag lines above)` : ""),
);

const summary: DiagnosticsSummary & { activityLanes?: number; activity?: Record<string, number> } = mergeSummaries(
  outcomes.map((outcome) => outcome.diag.summary()),
);
if (LANES) {
  summary.activityLanes = LANES * WORKERS;
  summary.activity = {};
  for (const outcome of outcomes) {
    for (const [key, count] of Object.entries(outcome.activity)) summary.activity[key] = (summary.activity[key] ?? 0) + count;
  }
}
console.log(`diag summary ${JSON.stringify(summary)}`);
