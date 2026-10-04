/**
 * Concurrent application activity beside a stress script (Batch 21A, opt-in).
 *
 * create-navigation drives a browser through the Components screen against a
 * cold server. The failure it once recorded — three page errors in one CI run
 * out of several — might depend on what else the server was doing, so the
 * reproduction matrix runs it again with the application busy on the same
 * server and database, several lanes at once:
 *
 *  · server-component navigations (RSC requests) and document loads of the
 *    Components list, a component's page, the Visual Editor on a service
 *    category and on a service's own page (Batch 22), both pages in public
 *    and their draft previews;
 *  · the Visual Editor's route reads (the route summary, a region), of the
 *    category page and of the service page;
 *  · route drafts written and discarded, and now and then published — which
 *    revalidates the catalog, FAQ and route caches — on both pages;
 *  · reusable components created and deleted through their own actions.
 *
 * It never runs across a restart: `pause` waits for every request in flight
 * before the script stops its server, and `resume` hands over the next one, so
 * a refused connection here is a failure rather than a restart. Refusals the
 * application gives on purpose — a stale review, two lanes conflicting over
 * one draft — are outcomes, and counted; transport errors, 5xx answers, error
 * rows in a payload and exceptions are incidents.
 */
import type { Sql } from "postgres";

import { callAction } from "./action";
import { isNavigationDigest, payloadErrors, type Flavour } from "./diagnostics";

import { documentEditorKey, editorKeyOf } from "@/lib/routes/owners";

const ROUTE = { route: "/admin/visual-editor", file: "app/(backoffice)/admin/visual-editor/route-actions.ts" };
const COMPONENTS = { route: "/admin/components", file: "app/(backoffice)/admin/(shell)/components/actions.ts" };

export type ActivityIncident = {
  message: string;
  detail?: string;
  digests: string[];
  request: { method: string; url: string; flavour: Flavour; status?: number };
};

export type Activity = {
  /** The server to work against from now on. */
  resume: (origin: string) => void;
  /** Stops starting work and waits for whatever is in flight. */
  pause: () => Promise<void>;
  /** Ends every lane; what each kind of operation came to. */
  stop: () => Promise<Record<string, number>>;
};

/** How many activity lanes per worker STRESS_ACTIVITY asks for: off, "1" (three) or a number. */
export function activityLanes(value: string | undefined): number {
  if (!value || value === "0") return 0;
  const lanes = Number(value);
  return Number.isInteger(lanes) && lanes > 1 ? Math.min(lanes, 8) : 3;
}

export function startActivity(options: {
  lanes: number;
  cookie: string;
  csrf: string;
  sql: Sql;
  report: (incident: ActivityIncident) => void;
}): Activity {
  const outcomes: Record<string, number> = {};
  const count = (key: string) => (outcomes[key] = (outcomes[key] ?? 0) + 1);
  let origin: string | null = null;
  let stopped = false;
  let inFlight = 0;
  let wake: (() => void)[] = [];
  let idle: (() => void)[] = [];
  const notify = () => {
    const waiting = wake;
    wake = [];
    for (const resolve of waiting) resolve();
  };
  const settled = () => {
    if (inFlight > 0) return;
    const waiting = idle;
    idle = [];
    for (const resolve of waiting) resolve();
  };
  const ready = async (): Promise<string | null> => {
    while (!stopped && !origin) await new Promise<void>((resolve) => wake.push(resolve));
    return stopped ? null : origin;
  };

  const form = (fields: Record<string, string | number>) => {
    const data = new FormData();
    data.set("_csrf", options.csrf);
    for (const [key, value] of Object.entries(fields)) data.set(key, String(value));
    return data;
  };

  /** Checks an answer the way a browser would meet it: 5xx, and error rows that are not navigations. */
  const inspect = (method: string, url: string, flavour: Flavour, status: number, body: string) => {
    const failed = payloadErrors(body).filter((row) => !isNavigationDigest(row.digest));
    if (status >= 500 || failed.length) {
      options.report({
        message: `${status} — ${method} ${new URL(url).pathname}${new URL(url).search} [${flavour}]${failed.length ? `, ${failed.length} error row(s)` : ""}`,
        detail: failed.length ? failed.map((row) => row.row).join("\n") : body.slice(0, 600),
        digests: failed.map((row) => row.digest),
        request: { method, url, flavour, status },
      });
      return false;
    }
    return true;
  };

  const act = async <T,>(at: string, target: typeof ROUTE, action: string, args: unknown[]) => {
    const answer = await callAction<T>({ ...target, origin: at, action, args, cookie: options.cookie });
    inspect("POST", `${at}${target.route}`, "action", answer.status, answer.text);
    return answer.value;
  };

  const page = async (at: string, path: string, rsc: boolean) => {
    const url = `${at}${path}`;
    const response = await fetch(url, { headers: { cookie: options.cookie, ...(rsc ? { RSC: "1" } : {}) }, redirect: "manual" });
    const body = await response.text();
    count(inspect("GET", url, rsc ? "rsc" : "document", response.status, body) ? `${rsc ? "rsc" : "document"} ${response.status}` : "failed");
  };

  const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)]!;

  /** The first service of the first category, and its public address. */
  const serviceOf = async () =>
    (
      await options.sql<{ id: number; path: string }[]>`
        select s.id, '/services/' || c.slug || '/' || s.slug as path
          from services s join service_categories c on c.id = s.category_id
         order by c.id, s.id limit 1`
    )[0];

  const operations: ((at: string, lane: number, turn: number) => Promise<void>)[] = [
    // Server-component navigations and document loads.
    async (at, _lane, turn) => {
      const [category] = await options.sql<{ id: number; slug: string }[]>`select id, slug from service_categories order by id limit 1`;
      const [component] = await options.sql<{ id: number }[]>`select id from reusable_components order by random() limit 1`;
      const service = await serviceOf();
      const paths = [
        "/admin/components",
        component ? `/admin/components/${component.id}` : "/admin/components",
        category ? `/admin/visual-editor?route=category:${category.id}` : "/admin/visual-editor",
        category ? `/services/${category.slug}` : "/services",
        category ? `/services/${category.slug}?preview=1` : "/services",
        service ? `/admin/visual-editor?route=service:${service.id}` : "/admin/visual-editor",
        service ? service.path : "/services",
        service ? `${service.path}?preview=1` : "/services",
      ];
      await page(at, pick(paths), turn % 3 !== 0);
    },
    // The Visual Editor reading a service category.
    async (at) => {
      const [category] = await options.sql<{ id: number }[]>`select id from service_categories order by id limit 1`;
      if (!category) return void count("no category");
      const pageId = documentEditorKey({ kind: "category", id: category.id });
      const summary = await act<{ token?: string }>(at, ROUTE, "loadRouteSummary", [`category:${category.id}`]);
      count(summary ? "route summary" : "route summary refused");
      const region = await act<{ ok: boolean }>(at, ROUTE, "loadRouteRegion", [editorKeyOf({ type: "category", id: category.id }), pageId]);
      count(region?.ok ? "route region" : "route region refused");
    },
    // A route draft written, then discarded — or, one turn in four, published.
    async (at, lane, turn) => {
      const [category] = await options.sql<{ id: number }[]>`select id from service_categories order by id limit 1`;
      if (!category) return void count("no category");
      const pageId = documentEditorKey({ kind: "category", id: category.id });
      const sectionId = editorKeyOf({ type: "category", id: category.id });
      const region = await act<{ ok: boolean; section?: { revision: number; values: Record<string, unknown> } }>(
        at,
        ROUTE,
        "loadRouteRegion",
        [sectionId, pageId],
      );
      if (!region?.ok || !region.section) return void count("draft: region refused");
      const values = region.section.values;
      const saved = await act<{ ok: boolean; reason?: string }>(at, ROUTE, "saveRouteRegionDraft", [
        form({
          sectionId,
          pageId,
          expectedRevision: region.section.revision,
          values: JSON.stringify({ ...values, title: { ...(values.title as object), en: `Activity title ${lane}-${turn}` } }),
        }),
      ]);
      count(saved?.ok ? "draft saved" : `draft refused (${saved?.reason ?? "?"})`);
      const summary = await act<{ token: string }>(at, ROUTE, "loadRouteSummary", [`category:${category.id}`]);
      if (!summary?.token) return void count("summary refused");
      const verb = turn % 4 === 0 ? "publishRouteFromEditor" : "discardRouteFromEditor";
      const done = await act<{ ok: boolean; reason?: string }>(at, ROUTE, verb, [
        form({ routeKey: `category:${category.id}`, token: summary.token }),
      ]);
      count(`${verb === "publishRouteFromEditor" ? "publish" : "discard"} ${done?.ok ? "ok" : `refused (${done?.reason ?? "?"})`}`);
    },
    // The Visual Editor reading a service's own page (Batch 22).
    async (at) => {
      const service = await serviceOf();
      if (!service) return void count("no service");
      const pageId = documentEditorKey({ kind: "service", id: service.id });
      const summary = await act<{ token?: string }>(at, ROUTE, "loadRouteSummary", [`service:${service.id}`]);
      count(summary ? "service summary" : "service summary refused");
      const region = await act<{ ok: boolean }>(at, ROUTE, "loadRouteRegion", [editorKeyOf({ type: "serviceHero", id: service.id }), pageId]);
      count(region?.ok ? "service region" : "service region refused");
    },
    // A service page draft written, then discarded — or, one turn in four, published.
    async (at, lane, turn) => {
      const service = await serviceOf();
      if (!service) return void count("no service");
      const pageId = documentEditorKey({ kind: "service", id: service.id });
      const sectionId = editorKeyOf({ type: "serviceHero", id: service.id });
      const region = await act<{ ok: boolean; section?: { revision: number; values: Record<string, unknown> } }>(
        at,
        ROUTE,
        "loadRouteRegion",
        [sectionId, pageId],
      );
      if (!region?.ok || !region.section) return void count("service draft: region refused");
      const values = region.section.values;
      const saved = await act<{ ok: boolean; reason?: string }>(at, ROUTE, "saveRouteRegionDraft", [
        form({
          sectionId,
          pageId,
          expectedRevision: region.section.revision,
          values: JSON.stringify({ ...values, timeline: { ...(values.timeline as object), en: `Activity timeline ${lane}-${turn}` } }),
        }),
      ]);
      count(saved?.ok ? "service draft saved" : `service draft refused (${saved?.reason ?? "?"})`);
      const summary = await act<{ token: string }>(at, ROUTE, "loadRouteSummary", [`service:${service.id}`]);
      if (!summary?.token) return void count("service summary refused");
      const verb = turn % 4 === 0 ? "publishRouteFromEditor" : "discardRouteFromEditor";
      const done = await act<{ ok: boolean; reason?: string }>(at, ROUTE, verb, [
        form({ routeKey: `service:${service.id}`, token: summary.token }),
      ]);
      count(`service ${verb === "publishRouteFromEditor" ? "publish" : "discard"} ${done?.ok ? "ok" : `refused (${done?.reason ?? "?"})`}`);
    },
    // A reusable component created and deleted through its own actions.
    async (at, lane, turn) => {
      const name = `Activity CTA ${lane}-${turn}-${Date.now()}`;
      const created = await act<{ ok: boolean; component?: { id: number; revision: number } }>(at, COMPONENTS, "createReusableComponent", [
        form({ kind: "cta", name, publish: "0" }),
      ]);
      if (!created?.ok || !created.component) return void count("component create refused");
      const removed = await act<{ ok: boolean; reason?: string }>(at, COMPONENTS, "deleteReusable", [
        form({ id: created.component.id, expectedRevision: created.component.revision }),
      ]);
      count(removed?.ok ? "component created and deleted" : `component delete refused (${removed?.reason ?? "?"})`);
    },
  ];

  const lane = async (index: number) => {
    for (let turn = 1; ; turn += 1) {
      const at = await ready();
      if (!at) return;
      inFlight += 1;
      try {
        await operations[(index + turn) % operations.length]!(at, index, turn);
      } catch (error) {
        options.report({
          message: `activity lane ${index}: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`,
          detail: error instanceof Error && error.cause ? String(error.cause) : undefined,
          digests: [],
          request: { method: "?", url: at, flavour: "other" },
        });
      } finally {
        inFlight -= 1;
        settled();
      }
    }
  };
  const lanes = Array.from({ length: options.lanes }, (_, index) => lane(index + 1));

  return {
    resume(next) {
      origin = next;
      notify();
    },
    async pause() {
      origin = null;
      if (inFlight > 0) await new Promise<void>((resolve) => idle.push(resolve));
    },
    async stop() {
      stopped = true;
      origin = null;
      notify();
      await Promise.all(lanes);
      return outcomes;
    },
  };
}
