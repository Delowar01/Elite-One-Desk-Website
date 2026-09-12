/**
 * The point of the whole restructure, exercised through the panel: a new
 * country is data entry.
 *
 * Nepal is added here the way an editor would add it — the destination form,
 * then the package form, then the refresh — and the site groups by it. No
 * migration, no enum, no deployment. That is the acceptance case; the rest of
 * this file is the guard rails around it.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { giveRestructured } from "./helpers/fixtures";
import { formContaining, get, submitForm } from "./helpers/http";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { startServer, type Server } from "./helpers/server";
import { signIn, type TestSession } from "./helpers/session";

const PORT = 3431;
const NEW_DESTINATION = "/admin/packages/destinations/new";
const REFRESH = "/admin/settings?tab=maintenance";

let database = "";
let server: Server;
let sql: Sql;
let session: TestSession;

before(async () => {
  database = giveRestructured("admin_dest");
  sql = connect(database);
  session = await signIn(sql);
  server = await startServer(database, PORT);
});

after(async () => {
  await server?.stop();
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
});

/** Presses Settings → Maintenance → Refresh caches. */
async function refreshCaches() {
  const page = await get(server.origin, REFRESH, { cookie: session.cookie });
  const form = formContaining(page.html, "Refresh caches");
  const result = await submitForm(server.origin, REFRESH, form, session.cookie);
  assert.match(result.html, /Every cache was dropped/);
}

/** Fills in the new-destination form and submits it. */
async function createDestination(values: Record<string, string>) {
  const page = await get(server.origin, NEW_DESTINATION, { cookie: session.cookie });
  assert.equal(page.status, 200, "the destination editor should be reachable");
  const form = formContaining(page.html, "Create destination");
  return submitForm(server.origin, NEW_DESTINATION, form, session.cookie, values);
}

describe("adding a country is data entry", () => {
  test("Nepal: create the destination, file a package in it, refresh — and the site groups by it", async () => {
    const created = await createDestination({
      slug: "nepal",
      titleEn: "Nepal",
      titleAr: "نيبال",
      summaryEn: "Himalayan itineraries from Kathmandu to Pokhara.",
      summaryAr: "برامج في جبال الهيمالايا من كاتماندو إلى بوخارا.",
      sortOrder: "1",
      isPublished: "on",
    });
    assert.ok(created.status < 400, `the form should have been accepted, got ${created.status}`);

    const [destination] = await sql<{ id: number; slug: string }[]>`
      select id, slug from package_destinations where slug = 'nepal'
    `;
    assert.ok(destination, "Nepal should exist as a destination");

    // File an existing package under it, through the package form.
    const [pkg] = await sql<{ id: number }[]>`
      select id from travel_packages where slug = 'custom-itinerary'
    `;
    const editor = `/admin/packages/${pkg!.id}`;
    const page = await get(server.origin, editor, { cookie: session.cookie });
    const form = formContaining(page.html, "Save changes");
    const saved = await submitForm(server.origin, editor, form, session.cookie, {
      destinationId: String(destination!.id),
    });
    assert.ok(saved.status < 400);

    const [moved] = await sql<{ destination_id: number | null; region: string }[]>`
      select destination_id, region from travel_packages where slug = 'custom-itinerary'
    `;
    assert.equal(moved!.destination_id, destination!.id);

    await refreshCaches();

    const packages = await get(server.origin, "/packages");
    assert.ok(packages.html.includes('href="/packages/nepal"'), "Nepal should be a group");
    assert.ok(packages.html.includes("Nepal"));

    const nepal = await get(server.origin, "/packages/nepal");
    assert.equal(nepal.status, 200);
    assert.ok(nepal.html.includes('href="/packages/custom-itinerary"'), "its package should list");

    const arabic = await get(server.origin, "/ar/packages/nepal");
    assert.equal(arabic.status, 200);
    assert.ok(arabic.html.includes("نيبال"), "the Arabic name should be used in the Arabic edition");

    // Egypt is unaffected: it is one destination among several now, not a special case.
    assert.equal((await get(server.origin, "/packages/egypt")).status, 200);
  });
});

describe("the shared address space is guarded in both directions", () => {
  test("a destination may not take a package's address", async () => {
    const result = await createDestination({
      slug: "cairo-and-giza-classic",
      titleEn: "Clash",
      isPublished: "on",
    });
    assert.match(result.html, /already uses that address/);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from package_destinations where title_en = 'Clash'
    `;
    assert.equal(n, 0, "nothing should have been created");
  });

  test("a new package may not take a destination's address", async () => {
    const page = await get(server.origin, "/admin/packages/new", { cookie: session.cookie });
    assert.equal(page.status, 200);
    const form = formContaining(page.html, "Create package");
    const result = await submitForm(server.origin, "/admin/packages/new", form, session.cookie, {
      slug: "egypt",
      titleEn: "Clashing package",
    });
    assert.match(result.html, /already uses that address/);
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from travel_packages where slug = 'egypt'
    `;
    assert.equal(n, 0, "nothing should have been created at a destination's address");
  });

  test("an existing package's address is fixed, and a forged submission cannot move it", async () => {
    const [pkg] = await sql<{ id: number }[]>`
      select id from travel_packages where slug = 'cairo-and-giza-classic'
    `;
    const editor = `/admin/packages/${pkg!.id}`;
    const page = await get(server.origin, editor, { cookie: session.cookie });
    const field = /<input[^>]*id="slug"[^>]*>/.exec(page.html)?.[0] ?? "";
    assert.ok(field, "the address should still be shown");
    assert.match(field, /readonly/i, "an address that may have been shared is not an editable field");

    const form = formContaining(page.html, "Save changes");
    const result = await submitForm(server.origin, editor, form, session.cookie, { slug: "egypt" });
    assert.ok(result.status < 400, "the save itself is fine — the address is simply not read");

    const [after] = await sql<{ slug: string }[]>`
      select slug from travel_packages where id = ${pkg!.id}
    `;
    assert.equal(after!.slug, "cairo-and-giza-classic", "the address must not have moved");
  });

  test("a destination may keep the address it already has", async () => {
    const [destination] = await sql<{ id: number }[]>`
      select id from package_destinations where slug = 'egypt'
    `;
    const editor = `/admin/packages/destinations/${destination!.id}`;
    const page = await get(server.origin, editor, { cookie: session.cookie });
    const form = formContaining(page.html, "Save changes");
    const result = await submitForm(server.origin, editor, form, session.cookie, {
      summaryEn: "Edited.",
    });
    assert.ok(!/already uses that address/.test(result.html), result.html.slice(0, 400));
    const [row] = await sql<{ summary_en: string }[]>`
      select summary_en from package_destinations where id = ${destination!.id}
    `;
    assert.equal(row!.summary_en, "Edited.");
  });
});

describe("region is legacy, and stays where it is", () => {
  test("saving an Egypt package through the panel leaves region = egypt", async () => {
    const [pkg] = await sql<{ id: number; region: string }[]>`
      select id, region from travel_packages where slug = 'nile-cruise-luxor-aswan'
    `;
    assert.equal(pkg!.region, "egypt");

    const editor = `/admin/packages/${pkg!.id}`;
    const page = await get(server.origin, editor, { cookie: session.cookie });
    assert.ok(
      /<option value="egypt"/.test(page.html),
      "the legacy value has to remainselectable on a record that carries it, or saving would silently change it",
    );

    const form = formContaining(page.html, "Save changes");
    const saved = await submitForm(server.origin, editor, form, session.cookie, {
      summaryEn: "Edited through the panel.",
    });
    assert.ok(saved.status < 400);

    const [after] = await sql<{ region: string; summary_en: string }[]>`
      select region, summary_en from travel_packages where id = ${pkg!.id}
    `;
    assert.equal(after!.region, "egypt", "an ordinary save must not rewrite the legacy region");
    assert.equal(after!.summary_en, "Edited through the panel.");
  });

  test("a package that never was Egypt is not offered the retired value", async () => {
    const [pkg] = await sql<{ id: number; region: string }[]>`
      select id, region from travel_packages where region <> 'egypt' limit 1
    `;
    const page = await get(server.origin, `/admin/packages/${pkg!.id}`, { cookie: session.cookie });
    const select = /<select[^>]*name="region"[\s\S]*?<\/select>/.exec(page.html)?.[0] ?? "";
    assert.ok(select, "the region field should still be on the form");
    assert.ok(!select.includes('value="egypt"'), "Egypt is not a region anybody may choose again");
  });
});

describe("deleting a destination", () => {
  test("removes the folder, never the packages inside it", async () => {
    const [destination] = await sql<{ id: number }[]>`
      select id from package_destinations where slug = 'egypt'
    `;
    const before = await sql<{ slug: string }[]>`
      select slug from travel_packages where destination_id = ${destination!.id} order by slug
    `;
    assert.equal(before.length, 4);

    const editor = `/admin/packages/destinations/${destination!.id}`;
    const page = await get(server.origin, editor, { cookie: session.cookie });
    const form = formContaining(page.html, "Delete destination");
    const result = await submitForm(server.origin, editor, form, session.cookie);
    assert.ok(result.status < 400);

    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from package_destinations where id = ${destination!.id}
    `;
    assert.equal(n, 0, "the destination should be gone");

    const survivors = await sql<{ slug: string; destination_id: number | null; region: string }[]>`
      select slug, destination_id, region from travel_packages
       where slug in ${sql(before.map((row) => row.slug))} order by slug
    `;
    assert.equal(survivors.length, 4, "every package should still exist");
    for (const row of survivors) {
      assert.equal(row.destination_id, null, `${row.slug} should be unassigned, not deleted`);
      assert.equal(row.region, "egypt", "and its legacy region is still its own business");
    }

    await refreshCaches();
    assert.equal((await get(server.origin, "/packages/egypt")).status, 404);
    for (const row of survivors) {
      assert.equal((await get(server.origin, `/packages/${row.slug}`)).status, 200, row.slug);
    }
  });
});
