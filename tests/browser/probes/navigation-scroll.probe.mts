/**
 * Batch 27: a page reached by a link opens at its top, at once.
 *
 * `globals.css` sets `html { scroll-behavior: smooth }` so that an in-page
 * anchor glides. Up to Next 15 the router switched that off by itself while it
 * scrolled a new page into place, and back on afterwards. Next 16 does so only
 * when `<html>` carries `data-scroll-behavior="smooth"`; without it, every
 * client-side navigation would glide from wherever the reader was to the top
 * of the next page (docs/release/next16-qualification-batch-27.md §3).
 *
 *   N1  both root layouts carry the attribute: a public page and the panel
 *   N2  a link followed from the foot of a long page: the next page reaches
 *       its top without gliding — at most one position between the old place
 *       and the top, where a glide passes through dozens
 *   N3  and the stylesheet's smooth scrolling is back once the page is in
 *       place, for the anchors it is there for
 */

import { giveFresh } from "../../helpers/fixtures";
import { dropDatabase } from "../../helpers/pg";
import { startServer } from "../../helpers/server";
import { launchChromium } from "../harness";

const PORT = 3740;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

const browser = await launchChromium();
const database = giveFresh("navigation_scroll_probe");
let server;
try {
  server = await startServer(database, PORT);
  // Motion as a visitor without a reduced-motion preference has it: the
  // stylesheet turns smooth scrolling off under `prefers-reduced-motion`.
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "no-preference" });
  const page = await context.newPage();
  page.on("pageerror", (error) => console.log("   [pageerror]", error.message.slice(0, 140)));

  const attribute = async (path: string) => {
    await page.goto(`${server!.origin}${path}`, { waitUntil: "load" });
    return page.evaluate(() => document.documentElement.getAttribute("data-scroll-behavior"));
  };
  const publicAttr = await attribute("/services");
  const adminAttr = await attribute("/admin/login");
  say("N1 · both root layouts mark smooth scrolling for the router", publicAttr === "smooth" && adminAttr === "smooth", `public ${publicAttr}, panel ${adminAttr}`);

  await page.goto(`${server.origin}/services`, { waitUntil: "networkidle" });
  const start = await page.evaluate(() => {
    const top = document.documentElement.scrollHeight - window.innerHeight;
    window.scrollTo({ top, behavior: "instant" });
    return top;
  });
  await page.waitForFunction((top) => Math.abs(window.scrollY - top) < 2, start, { timeout: 5_000 });
  // Every frame from here on: which page, and where it is scrolled to. A string,
  // so tsx has no named function to wrap in a `__name` the page does not have.
  await page.evaluate(`(() => {
    window.frames_ = [];
    const tick = () => {
      window.frames_.push([location.pathname, Math.round(window.scrollY)]);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  })()`);
  // The navigation stays in reach at the foot of the page.
  await page.locator('nav a[href="/packages"]').first().click();
  await page.waitForURL(/\/packages$/, { timeout: 15_000 });
  // Long enough to see a glide through: one takes about 400 ms, this is ~750.
  await page.waitForFunction(
    () => (window as unknown as { frames_: [string, number][] }).frames_.filter(([path]) => path === "/packages").length >= 45,
    undefined,
    { timeout: 15_000 },
  );
  const frames = await page.evaluate(() => (window as unknown as { frames_: [string, number][] }).frames_);
  const arrived = frames.filter(([path]) => path === "/packages").map(([, y]) => y);
  const firstTop = arrived.indexOf(0);
  const between = new Set(arrived.slice(0, Math.max(0, firstTop)).filter((y) => y !== start));
  say(
    "N2 · a link followed from the foot of a long page opens the next page at its top, without gliding",
    start > 2_000 && arrived.length > 0 && firstTop >= 0 && between.size <= 1 && arrived.slice(firstTop).every((y) => y === 0),
    `from ${start}px: ${arrived.length} frames on the new page, top reached at frame ${firstTop}, ${between.size} position(s) in between`,
  );

  const behaviour = await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior);
  say("N3 · the stylesheet's smooth scrolling is back once the page is in place", behaviour === "smooth", behaviour);
  await context.close();
} finally {
  await browser.close();
  await server?.stop();
  dropDatabase(database);
}
