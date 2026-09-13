/**
 * The cutover is a database change made from outside the running application,
 * and the application caches its catalogue for an hour. So the last step of the
 * cutover is a cache refresh — and this is the proof that the refresh works,
 * that it is needed, and that a restart is not a substitute for it.
 *
 * One server, one database, one build, start to finish:
 *
 *   A  warm  — the pre-cutover catalogue, cached
 *   B  after `npm run restructure`, before anything else — still the old one
 *   C  after a full restart — still the old one, because the cache is on disk
 *   D  after pressing “Refresh caches” — the new one, immediately
 *
 * The button is pressed the way a browser with no JavaScript presses it: the
 * rendered form is submitted back, through the same session cookie, the same
 * CSRF token and the same `settings.manage` check.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { giveLegacy } from "./helpers/fixtures";
import { formContaining, get, submitForm } from "./helpers/http";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { restructure } from "./helpers/run";
import { startServer, type Server } from "./helpers/server";
import { signIn, type TestSession } from "./helpers/session";

const PORT = 3421;
const SETTINGS = "/admin/settings?tab=maintenance";

let database = "";
let server: Server;
let sql: Sql;
let session: TestSession;

before(async () => {
  database = giveLegacy("cache");
  sql = connect(database);
  session = await signIn(sql);
  server = await startServer(database, PORT);
});

after(async () => {
  await server?.stop();
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
});

/** The handful of answers that change, and only change, at the cutover. */
async function snapshot() {
  const [home, services, general, iqama, egypt, packages, arGeneral] = await Promise.all([
    get(server.origin, "/"),
    get(server.origin, "/services"),
    get(server.origin, "/services/general-services"),
    get(server.origin, "/services/iqama-services"),
    get(server.origin, "/packages/egypt"),
    get(server.origin, "/packages"),
    get(server.origin, "/ar/services/general-services"),
  ]);
  return {
    menuOffersTourPackages: /Tour Packages/.test(home.html),
    servicesListsGeneral: services.html.includes('href="/services/general-services"'),
    servicesListsIqama: services.html.includes('href="/services/iqama-services"'),
    generalServices: `${general.status}${general.location ? ` → ${general.location}` : ""}`,
    arabicGeneralServices: `${arGeneral.status}${arGeneral.location ? ` → ${arGeneral.location}` : ""}`,
    iqamaServices: iqama.status,
    egyptDestination: egypt.status,
    packagesGroupByEgypt: packages.html.includes('href="/packages/egypt"'),
  };
}

const BEFORE = {
  menuOffersTourPackages: false,
  servicesListsGeneral: true,
  servicesListsIqama: false,
  generalServices: "200",
  arabicGeneralServices: "200",
  iqamaServices: 404,
  egyptDestination: 404,
  packagesGroupByEgypt: false,
};

const AFTER = {
  menuOffersTourPackages: true,
  servicesListsGeneral: false,
  servicesListsIqama: true,
  generalServices: "308 → /services/iqama-services",
  arabicGeneralServices: "308 → /ar/services/iqama-services",
  iqamaServices: 200,
  egyptDestination: 200,
  packagesGroupByEgypt: true,
};

test("A · the pre-cutover catalogue is served, and caching it", async () => {
  assert.deepEqual(await snapshot(), BEFORE);
  // A second pass so every loader is certainly warm before the database moves.
  assert.deepEqual(await snapshot(), BEFORE);
});

test("B · the cutover alone changes nothing a visitor can see", async () => {
  const result = restructure(database);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /Committed\./);
  assert.match(result.output, /\/admin\/settings\?tab=maintenance/, "the script says what to do next");

  assert.deepEqual(
    await snapshot(),
    BEFORE,
    "the running application is still serving its cached copy — which is the whole reason the refresh exists",
  );
});

test("C · restarting the application is not a refresh — it leaves a mixed site", async () => {
  await server.stop();
  server = await startServer(database, PORT, { reuse: true });
  const restarted = await snapshot();

  // Not the refreshed site. That is the claim that matters, and it is the
  // reason the cutover ends with a button rather than a `systemctl restart`.
  assert.notDeepEqual(restarted, AFTER, "a restart must not be mistaken for a refresh");

  // It is not the old site either, which is worse than either: some surfaces
  // moved and some did not. The navigation is the one a visitor sees on every
  // page, and it is still the old menu.
  assert.equal(
    restarted.menuOffersTourPackages,
    false,
    "the navigation is still the pre-cutover menu after a restart",
  );
  assert.equal(
    restarted.servicesListsGeneral,
    true,
    "and still links to the category the cutover retired",
  );
});

test("D · pressing “Refresh caches” makes the new catalogue live immediately", async () => {
  const page = await get(server.origin, SETTINGS, { cookie: session.cookie });
  assert.equal(page.status, 200);

  const form = formContaining(page.html, "Refresh caches");
  assert.ok(form.includes(session.csrfToken), "the form carries this session's CSRF token");

  const result = await submitForm(server.origin, SETTINGS, form, session.cookie);
  assert.equal(result.status, 200);
  assert.match(result.html, /Every cache was dropped/);

  assert.deepEqual(await snapshot(), AFTER, "the same process now serves the restructured site");
});

test("the refresh is an ordinary admin action — no session, no refresh", async () => {
  const page = await get(server.origin, SETTINGS, { cookie: session.cookie });
  const form = formContaining(page.html, "Refresh caches");

  const anonymous = await submitForm(server.origin, SETTINGS, form, "");
  assert.ok(
    anonymous.status >= 300 || !/Every cache was dropped/.test(anonymous.html),
    "an unauthenticated POST must not refresh anything",
  );

  const forged = await submitForm(server.origin, SETTINGS, form, session.cookie, {
    _csrf: "not-the-token",
  });
  assert.match(forged.html, /This form expired/, "a mismatched CSRF token is refused");
});

test("it is recorded in the activity log, like every other admin action", async () => {
  const rows = await sql<{ action: string; summary: string }[]>`
    select action, summary from activity_logs where action = 'cache.refreshed'
  `;
  assert.ok(rows.length >= 1, "the refresh should be auditable");
  assert.match(rows[0]!.summary, /Refreshed every site cache/);
});

test("the sitemap followed the refresh too — it is read per request, not baked", async () => {
  const page = await get(server.origin, "/sitemap.xml");
  assert.equal(page.status, 200);
  const site = /<loc>(https?:\/\/[^/]+)/.exec(page.html)?.[1] ?? "";
  assert.ok(site, "the sitemap should contain absolute URLs");
  assert.ok(
    page.html.includes(`<loc>${site}/services/iqama-services</loc>`),
    "the renamed category should be in the sitemap immediately after the refresh",
  );
  assert.ok(
    !page.html.includes(`<loc>${site}/services/general-services</loc>`),
    "and the retired one should be gone",
  );
  assert.ok(page.html.includes(`<loc>${site}/packages/egypt</loc>`), "as should the new destination");
});
