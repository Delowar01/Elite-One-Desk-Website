/**
 * Batch 27: the router's prefetches come to an end.
 *
 * Next 16.3 turned `experimental.optimisticRouting` on by default, and with this
 * site's routes — `[lang]` beside a catch-all, every English address rewritten
 * onto `/en/…` by the middleware — the router never settled on an Arabic page:
 * it asked for the language switch's English twin, cancelled the request and
 * asked again, about a hundred times a second for as long as the page stayed
 * open, each one a render on the server (vercel/next.js#98345, fixed by #98998
 * in 16.4.0; the setting and the measurements are in next.config.ts and
 * docs/release/next16-qualification-batch-27.md §3).
 *
 *   B1  an Arabic page whose switch leads to a rewritten English address: a
 *       few requests per link in the seconds after it loads, then quiet
 *   B2  the English pages the same
 */

import { giveFresh } from "../../helpers/fixtures";
import { dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { launchChromium } from "../harness";

const PORT = 3741;
/** A link costs the router its route tree, its metadata and a segment or two. */
const PER_LINK = 8;
const WATCH_MS = 6_000;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("prefetch_bounded_probe");
let server;
try {
  server = await startServer(database, PORT);

  /** The router's RSC requests from `path`, per address, in the seconds after it loads. */
  const traffic = async (path: string) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    const counts = new Map<string, number>();
    page.on("request", (request) => {
      if (!request.headers()["rsc"]) return;
      const target = new URL(request.url()).pathname;
      counts.set(target, (counts.get(target) ?? 0) + 1);
    });
    await page.goto(`${server!.origin}${path}`, { waitUntil: "load" });
    await page.waitForTimeout(WATCH_MS);
    await context.close();
    const [busiest = "—", most = 0] = [...counts].sort((a, b) => b[1] - a[1])[0] ?? [];
    return { busiest, most, total: [...counts.values()].reduce((sum, n) => sum + n, 0) };
  };

  for (const [check, paths] of [
    ["B1 · Arabic pages", ["/ar/about", "/ar/services", "/ar/packages", "/ar/search"]],
    ["B2 · English pages", ["/about", "/services", "/packages", "/search"]],
  ] as const) {
    const seen = [];
    for (const path of paths) seen.push({ path, ...(await traffic(path)) });
    const worst = seen.reduce((a, b) => (b.most > a.most ? b : a));
    say(
      `${check}: every link is prefetched a few times and then left alone`,
      seen.every((row) => row.most <= PER_LINK),
      seen.map((row) => `${row.path} ${row.total} (most ${row.most}× ${row.busiest})`).join(", ") + ` — worst ${worst.most}`,
    );
  }
} finally {
  await browser.close();
  await server?.stop();
  dropDatabase(database);
}
