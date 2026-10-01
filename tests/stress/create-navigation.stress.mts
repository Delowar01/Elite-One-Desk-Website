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
 *
 *   STRESS_LOOPS=30 (creates per server; deletes are a third of that)
 */
import type { Browser } from "playwright";

import { callAction } from "../helpers/action";
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
  errors: string[];
  misses: string[];
};

async function worker(index: number): Promise<Outcome> {
  const out: Outcome = { creates: 0, landed: 0, documentLoads: 0, deletes: 0, returned: 0, duplicates: 0, errors: [], misses: [] };
  const browser: Browser = await launchChromium();
  const database = giveFresh(`create_nav_${index}`);
  const sql = connect(database);
  let server: Server | undefined;
  try {
    const owner = await signIn(sql);
    const [cookieName, cookieValue] = owner.cookie.split("=");
    const restart = async () => {
      // From cold, as the probe meets it: a fresh server, nothing warmed.
      await server?.stop();
      server = await startServer(database, PORT + index);
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
    let origin = await restart();
    for (let n = 1; n <= LISTED; n += 1) await create(origin, `Listed CTA ${index}-${n}`);

    const open = async () => {
      const context = await browser.newContext({ viewport: { width: 1720, height: 1020 } });
      await context.addCookies([{ name: cookieName!, value: cookieValue!, domain: "127.0.0.1", path: "/" }]);
      await context.addInitScript({ content: "window.__name = window.__name || ((fn) => fn);" });
      const page = await context.newPage();
      page.on("pageerror", (error) => out.errors.push(error.message.slice(0, 160)));
      return { context, page };
    };

    for (let round = 1; round <= LOOPS; round += 1) {
      origin = await restart();
      const name = `Stress CTA ${index}-${round}`;
      const { context, page } = await open();
      try {
        await page.goto(`${origin}/admin/components`, { waitUntil: "load" });
        await page.getByRole("button", { name: "New reusable component" }).click();
        const form = page.getByRole("form", { name: "New reusable component" });
        await form.getByLabel("Type").selectOption("cta");
        await form.getByLabel(/^Name/).fill(name);
        // Marks this document; a page loaded by the browser starts without it.
        await page.evaluate(() => ((window as unknown as { __eodList?: boolean }).__eodList = true));
        await form.getByRole("button", { name: "Create draft" }).click();
        out.creates += 1;
        const landed = await page
          .waitForURL(/\/admin\/components\/\d+$/, { timeout: LANDING_MS })
          .then(() => true, () => false);
        const [row] = await sql<{ id: number }[]>`select id from reusable_components where name = ${name}`;
        const rows = await sql<{ n: number }[]>`select count(*)::int as n from reusable_components where name = ${name}`;
        if (rows[0]!.n > 1) out.duplicates += 1;
        if (landed && row && page.url().endsWith(`/admin/components/${row.id}`)) {
          out.landed += 1;
          const listSurvived = await page.evaluate(() => Boolean((window as unknown as { __eodList?: boolean }).__eodList));
          if (!listSurvived) out.documentLoads += 1;
        } else {
          out.misses.push(`server ${index} round ${round}: created ${row ? `#${row.id}` : "nothing"}, still on ${page.url()}`);
        }
      } finally {
        await context.close();
      }

      if (round % 3 !== 0 || out.deletes >= DELETES) continue;
      // Delete from the component's own page: an unused draft, so Delete is offered.
      const doomedName = `Doomed CTA ${index}-${round}`;
      const doomed = await create(origin, doomedName);
      const { context: deleting, page: detail } = await open();
      try {
        await detail.goto(`${origin}/admin/components/${doomed}`, { waitUntil: "load" });
        await detail.locator("[data-reuse-delete]").click();
        await detail.getByRole("alertdialog", { name: "Delete the component" }).getByRole("button", { name: "Delete" }).click();
        out.deletes += 1;
        const back = await detail
          .waitForURL(/\/admin\/components$/, { timeout: LANDING_MS })
          .then(() => true, () => false);
        const gone = (await sql`select 1 from reusable_components where id = ${doomed}`).length === 0;
        const listed = back ? await detail.getByText(doomedName, { exact: true }).count() : -1;
        if (back && gone && listed === 0) out.returned += 1;
        else out.misses.push(`server ${index} delete #${doomed}: returned ${back}, removed ${gone}, still listed ${listed}`);
      } finally {
        await deleting.close();
      }
    }
  } finally {
    await server?.stop();
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
const errors = outcomes.flatMap((outcome) => outcome.errors);

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
say("N4. nothing created twice, and no page errors", total("duplicates") === 0 && errors.length === 0, errors.slice(0, 3).join(" | "));
