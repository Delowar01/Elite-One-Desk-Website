/**
 * Social Media, through the panel.
 *
 * Every mutation here is driven by submitting the form the admin actually sees,
 * on a running production build, against a real database — so what is proved is
 * the behaviour an editor gets, not the shape of a function. The panel is
 * rendered entirely by the server for exactly this reason: there is nothing in
 * it that only works once the page has hydrated.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { giveFresh } from "./helpers/fixtures";
import { formContaining, formsOn, get, submitForm } from "./helpers/http";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { startServer, type Server } from "./helpers/server";
import { signIn, type TestSession } from "./helpers/session";

import { socialLabel } from "@/lib/social";

const PORT = 3441;
const PANEL = "/admin/settings?tab=social";
const REFRESH = "/admin/settings?tab=maintenance";

let database = "";
let server: Server;
let sql: Sql;
let session: TestSession;

before(async () => {
  database = giveFresh("social_admin");
  sql = connect(database);
  session = await signIn(sql);
  server = await startServer(database, PORT);
});

after(async () => {
  await server?.stop();
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
});

type Row = { id: number; platform: string; url: string; sort_order: number; is_published: boolean };

const rows = () =>
  sql<Row[]>`
    select id, platform, url, sort_order, is_published
      from social_links order by sort_order, id
  `;

const panel = () => get(server.origin, PANEL, { cookie: session.cookie });

/** The one form on the page whose markup carries this exact attribute pair. */
function formWith(html: string, ...needles: string[]): string {
  const form = formsOn(html).find((candidate) => needles.every((n) => candidate.includes(n)));
  if (!form) throw new Error(`no form contains ${needles.join(" + ")}`);
  return form;
}

/**
 * A row's arrow, addressed by id rather than by its label — two Other / Website
 * rows share a label, and the point of these tests is which row moved.
 */
const moveForm = (html: string, id: number, direction: "up" | "down") =>
  formWith(html, `value="${id}"`, `value="${direction}"`);

async function addLink(values: Record<string, string>) {
  const page = await panel();
  return submitForm(server.origin, PANEL, formContaining(page.html, "Add link"), session.cookie, values);
}

/** Presses Settings → Maintenance → Refresh caches, so a SQL-made row is live. */
async function refreshCaches() {
  const page = await get(server.origin, REFRESH, { cookie: session.cookie });
  const form = formContaining(page.html, "Refresh caches");
  const result = await submitForm(server.origin, REFRESH, form, session.cookie);
  assert.match(result.html, /Every cache was dropped/);
}

describe("adding networks", () => {
  test("each new link goes to the end of the list", async () => {
    for (const [platform, url] of [
      ["linkedin", "https://www.linkedin.com/company/elite"],
      ["instagram", "https://www.instagram.com/elite"],
      ["youtube", "https://www.youtube.com/@elite"],
    ]) {
      const result = await addLink({ platform: platform!, url: url! });
      assert.ok(result.status < 400, `${platform} should have been accepted`);
    }

    const stored = await rows();
    assert.deepEqual(
      stored.map((row) => row.platform),
      ["linkedin", "instagram", "youtube"],
      "the order is the order they were added",
    );
    assert.deepEqual(
      stored.map((row) => row.sort_order),
      [0, 1, 2],
      "each one appended rather than landing at the top",
    );
  });

  test("a second row for the same network is refused, and nothing is written", async () => {
    const before = await rows();
    const result = await addLink({ platform: "instagram", url: "https://www.instagram.com/other" });
    assert.match(result.html, /already a link for Instagram/);
    assert.deepEqual(
      (await rows()).map((row) => row.id),
      before.map((row) => row.id),
      "the refusal wrote nothing",
    );
  });

  test("an address that is not https is refused", async () => {
    const before = await rows();
    const result = await addLink({ platform: "telegram", url: "http://t.me/elite" });
    assert.match(result.html, /https/);
    assert.equal((await rows()).length, before.length);
  });

  test("Other / Website may repeat, because those are addresses rather than accounts", async () => {
    for (const url of ["https://booking.example.com", "https://group.example.com"]) {
      const result = await addLink({ platform: "website", url });
      assert.ok(result.status < 400, url);
    }
    const websites = (await rows()).filter((row) => row.platform === "website");
    assert.equal(websites.length, 2, "both addresses were kept");
  });
});

describe("editing one link", () => {
  test("correcting the URL does not move the row", async () => {
    const before = await rows();
    const target = before.find((row) => row.platform === "linkedin")!;
    assert.equal(target.sort_order, 0, "LinkedIn starts at the top");

    const page = await panel();
    const form = formWith(page.html, "Save link", `value="${target.id}"`);
    const saved = await submitForm(server.origin, PANEL, form, session.cookie, {
      url: "https://www.linkedin.com/company/elite-one-desk",
    });
    assert.ok(saved.status < 400);

    const [after] = await sql<Row[]>`select * from social_links where id = ${target.id}`;
    assert.equal(after!.url, "https://www.linkedin.com/company/elite-one-desk");
    assert.equal(after!.sort_order, 0, "an ordinary edit must not reorder the footer");
    assert.deepEqual(
      (await rows()).map((row) => row.id),
      before.map((row) => row.id),
      "and must not move anything else either",
    );
  });

  test("the edit is logged as what it was", async () => {
    const [entry] = await sql<{ action: string; summary: string }[]>`
      select action, summary from activity_logs
       where entity_type = 'social' order by id desc limit 1
    `;
    assert.equal(entry!.action, "social.updated");
    assert.match(entry!.summary, /Updated the LinkedIn URL/);
  });
});

describe("showing and hiding", () => {
  test("one click hides a network, another shows it, and both say so", async () => {
    const target = (await rows()).find((row) => row.platform === "youtube")!;

    const hide = await submitForm(
      server.origin,
      PANEL,
      formWith((await panel()).html, "Hide YouTube"),
      session.cookie,
    );
    assert.ok(hide.status < 400);
    let [row] = await sql<Row[]>`select * from social_links where id = ${target.id}`;
    assert.equal(row!.is_published, false);

    let [entry] = await sql<{ action: string; summary: string }[]>`
      select action, summary from activity_logs where entity_type = 'social' order by id desc limit 1
    `;
    assert.equal(entry!.action, "social.disabled");
    assert.match(entry!.summary, /Disabled the YouTube social link/);

    const show = await submitForm(
      server.origin,
      PANEL,
      formWith((await panel()).html, "Show YouTube"),
      session.cookie,
    );
    assert.ok(show.status < 400);
    [row] = await sql<Row[]>`select * from social_links where id = ${target.id}`;
    assert.equal(row!.is_published, true);

    [entry] = await sql<{ action: string; summary: string }[]>`
      select action, summary from activity_logs where entity_type = 'social' order by id desc limit 1
    `;
    assert.equal(entry!.action, "social.enabled");
    assert.match(entry!.summary, /Enabled the YouTube social link/);
  });

  test("a hidden row still holds its place in the order", async () => {
    const before = (await rows()).map((row) => row.id);
    await submitForm(server.origin, PANEL, formWith((await panel()).html, "Hide Instagram"), session.cookie);
    assert.deepEqual((await rows()).map((row) => row.id), before);
    await submitForm(server.origin, PANEL, formWith((await panel()).html, "Show Instagram"), session.cookie);
  });
});

describe("reordering", () => {
  test("down and up move exactly one place, and renumber contiguously", async () => {
    const before = (await rows()).map((row) => row.platform);
    const first = before[0]!;
    const second = before[1]!;

    await submitForm(
      server.origin,
      PANEL,
      formWith((await panel()).html, `Move ${socialLabel(first)} down`),
      session.cookie,
    );

    let after = await rows();
    assert.deepEqual(
      after.map((row) => row.platform).slice(0, 2),
      [second, first],
      "the two swapped and nothing else moved",
    );
    assert.deepEqual(
      after.map((row) => row.sort_order),
      after.map((_, index) => index),
      "the list is renumbered 0..n-1",
    );

    await submitForm(
      server.origin,
      PANEL,
      formWith((await panel()).html, `Move ${socialLabel(first)} up`),
      session.cookie,
    );
    after = await rows();
    assert.deepEqual(after.map((row) => row.platform), before, "and back again");
  });

  test("it is logged as a reorder rather than as an edit", async () => {
    const [entry] = await sql<{ action: string; summary: string }[]>`
      select action, summary from activity_logs where entity_type = 'social' order by id desc limit 1
    `;
    assert.equal(entry!.action, "social.reordered");
    assert.match(entry!.summary, /Moved the .+ social link (up|down)/);
  });

  test("duplicate sort_order values in the table do not break the order", async () => {
    // The column never guaranteed uniqueness, so rows can already share a
    // number. Reordering has to be defined anyway: it reads the order, moves
    // one row and writes the whole run back.
    await sql`update social_links set sort_order = 0`;
    const ordered = await rows();
    const last = ordered[ordered.length - 1]!;

    await submitForm(server.origin, PANEL, moveForm((await panel()).html, last.id, "up"), session.cookie);

    const after = await rows();
    assert.deepEqual(
      after.map((row) => row.sort_order),
      after.map((_, index) => index),
      "whatever it was, it is contiguous now",
    );
    assert.equal(after[after.length - 2]!.id, last.id, "the moved row came up one place");
    assert.deepEqual(
      new Set(after.map((row) => row.id)),
      new Set(ordered.map((row) => row.id)),
      "and no row was lost or duplicated on the way",
    );
  });

  test("the first row cannot be moved up", async () => {
    const before = (await rows()).map((row) => row.id);
    const first = (await rows())[0]!;
    // The button is disabled in the panel; this is the server's own guard,
    // which is what a stale page would hit.
    const result = await submitForm(
      server.origin,
      PANEL,
      moveForm((await panel()).html, first.id, "up"),
      session.cookie,
    );
    assert.ok(result.status < 400);
    assert.deepEqual((await rows()).map((row) => row.id), before, "nothing moved");
  });
});

describe("a row stored under an old key", () => {
  test("twitter is X everywhere a visitor and an admin can see", async () => {
    await sql`
      insert into social_links (platform, url, sort_order, is_published)
      values ('twitter', 'https://x.com/legacy', 99, true)
    `;
    await refreshCaches();

    const home = await get(server.origin, "/");
    assert.equal(home.status, 200);
    assert.match(home.html, /aria-label="X"/, "the footer announces it as X");
    assert.ok(
      !/aria-label="Twitter"/.test(home.html),
      "and never as the name the network no longer uses",
    );

    const page = await panel();
    assert.match(page.html, /Edit X/, "the admin row is labelled X");
    const form = formWith(page.html, "Save link", "https://x.com/legacy");
    assert.match(
      form,
      /<option[^>]*value="x"[^>]*selected/,
      "and its menu opens on X rather than on an unknown network",
    );
  });

  test("adding an X link while the twitter row exists is refused as a duplicate", async () => {
    const before = await rows();
    const result = await addLink({ platform: "x", url: "https://x.com/elite" });
    assert.match(result.html, /already a link for X/);
    assert.equal((await rows()).length, before.length);
  });

  test("saving the legacy row canonicalises it, and says that is what happened", async () => {
    const page = await panel();
    const form = formWith(page.html, "Save link", "https://x.com/legacy");
    const saved = await submitForm(server.origin, PANEL, form, session.cookie);
    assert.ok(saved.status < 400);

    const [row] = await sql<Row[]>`select * from social_links where url = 'https://x.com/legacy'`;
    assert.equal(row!.platform, "x", "stored under the current key now");

    const [entry] = await sql<{ summary: string }[]>`
      select summary from activity_logs where entity_type = 'social' order by id desc limit 1
    `;
    assert.match(entry!.summary, /Changed the X row \(twitter\) to X/);
  });
});

describe("what the site does with them", () => {
  test("sameAs lists the accounts, once each, and leaves the plain addresses out", async () => {
    await refreshCaches();
    const home = await get(server.origin, "/");
    const organization = [...home.html.matchAll(/<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs)]
      .flatMap((match) => {
        try {
          const parsed = JSON.parse(match[1]!);
          return Array.isArray(parsed) ? parsed : [parsed];
        } catch {
          return [];
        }
      })
      .find((item) => item?.["@type"] === "Organization");
    assert.ok(organization, "the homepage carries Organization data");

    const sameAs: string[] = organization.sameAs ?? [];
    const stored = (await rows()).filter((row) => row.is_published);
    for (const row of stored) {
      if (row.platform === "website") {
        assert.ok(!sameAs.includes(row.url), `${row.url} is an address, not an identity`);
      } else {
        assert.ok(sameAs.includes(row.url), `${row.url} should be listed`);
      }
    }
    assert.equal(new Set(sameAs).size, sameAs.length, "no duplicates");
    assert.ok(sameAs.every((url) => url.trim().length > 0), "no blanks");
  });

  test("a hidden network is in neither the footer nor sameAs", async () => {
    await submitForm(server.origin, PANEL, formWith((await panel()).html, "Hide Instagram"), session.cookie);
    await refreshCaches();
    const home = await get(server.origin, "/");
    assert.ok(!home.html.includes("instagram.com/elite"), "hidden means hidden");
    assert.ok(!/aria-label="Instagram"/.test(home.html));
  });
});

describe("removing one", () => {
  test("delete takes the row away and names it in the log", async () => {
    const target = (await rows()).find((row) => row.platform === "youtube")!;
    const form = formWith((await panel()).html, "Remove YouTube");
    const result = await submitForm(server.origin, PANEL, form, session.cookie);
    assert.ok(result.status < 400);

    const [gone] = await sql<Row[]>`select * from social_links where id = ${target.id}`;
    assert.equal(gone, undefined);

    const [entry] = await sql<{ action: string; summary: string }[]>`
      select action, summary from activity_logs where entity_type = 'social' order by id desc limit 1
    `;
    assert.equal(entry!.action, "social.deleted");
    assert.match(entry!.summary, /Removed the YouTube link/);
  });
});
