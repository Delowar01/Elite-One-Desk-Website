/**
 * Batch 11: global site controls in the Visual Editor, and the permission model
 * around them.
 *
 * Two questions run through every test here, and they are not the same
 * question. *May this person see it* is answered by what the server sends —
 * a permission-scoped loader, so an unauthorised browser never receives the
 * data at all rather than receiving it behind a disabled control. *May this
 * person change it* is answered by the Server Action, which names one concrete
 * write permission and is tested by calling it directly, without a button.
 *
 * The third thread is separation: a global change is a different persistence
 * domain from a page. Saving the site's phone number must leave every page
 * draft exactly where it was, move no revision, and write no restore point.
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";

import { callAction } from "./helpers/action";
import { giveFresh } from "./helpers/fixtures";
import { get } from "./helpers/http";
import { connect, dropDatabase, type Sql } from "./helpers/pg";
import { seed } from "./helpers/run";
import { startServer, type Server } from "./helpers/server";
import { signIn, type TestSession } from "./helpers/session";

import { PERMISSIONS, ROLE_DEFAULTS, type PermissionKey } from "@/lib/auth/permissions";

const PORT = 3502;

const NAV_ACTIONS = "app/(backoffice)/admin/(shell)/navigation/actions.ts";
const SETTINGS_ACTIONS = "app/(backoffice)/admin/(shell)/settings/actions.ts";
const VE_ACTIONS = "app/(backoffice)/admin/visual-editor/actions.ts";
const USER_ACTIONS = "app/(backoffice)/admin/(shell)/users/actions.ts";

const VE_ROUTE = "/admin/visual-editor";

let database = "";
let server: Server;
let sql: Sql;
let owner: TestSession;

before(async () => {
  database = giveFresh("globals_perms");
  sql = connect(database);
  owner = await signIn(sql);
  defaults = await readGrants();

  const [role] = await sql<{ id: number }[]>`select id from roles where key = ${SPARE_ROLE}`;
  spareRoleId = role!.id;
  await sql`delete from users where email = ${SPARE_EMAIL}`;
  await sql`
    insert into users (email, name, password_hash, role_id, is_active)
    values (${SPARE_EMAIL}, 'Matrix Actor', 'x', ${spareRoleId}, true)
  `;
  spare = await signIn(sql, SPARE_ROLE);

  server = await startServer(database, PORT);
});

after(async () => {
  await server?.stop();
  await sql?.end({ timeout: 5 });
  if (database) dropDatabase(database);
});

/* -------------------------------------------------------------------------- */
/* One spare role, re-granted per case                                        */
/* -------------------------------------------------------------------------- */

/**
 * `roles.key` is a Postgres enum of exactly four values, so there is no such
 * thing as a new role row without a schema change — and this batch does not
 * make one.
 *
 * What a "custom role" means here is therefore a role holding a combination
 * the defaults never give it, which is the interesting half anyway: the
 * matrix below rewrites one spare role's grants before each case and signs in
 * as it. Permissions are resolved from the database on every request, so the
 * same cookie sees each new combination immediately — which is also what the
 * revocation tests are about.
 */
const SPARE_ROLE = "viewer";
const SPARE_EMAIL = "matrix-actor@eod.invalid";

let spareRoleId = 0;
let spare: TestSession;

/** Default grants, read before anything in this file starts moving them. */
let defaults = new Map<string, Set<string>>();

async function readGrants(): Promise<Map<string, Set<string>>> {
  const held = await sql<{ key: string; permission: string }[]>`
    select r.key, p.key as permission
      from roles r
      join role_permissions rp on rp.role_id = r.id
      join permissions p on p.id = rp.permission_id`;
  const byRole = new Map<string, Set<string>>();
  for (const row of held) {
    if (!byRole.has(row.key)) byRole.set(row.key, new Set());
    byRole.get(row.key)!.add(row.permission);
  }
  return byRole;
}

/** The spare role holds exactly these keys, and `spare` is signed in as it. */
async function as(keys: PermissionKey[]): Promise<TestSession> {
  await sql`delete from role_permissions where role_id = ${spareRoleId}`;
  if (keys.length) {
    await sql`
      insert into role_permissions (role_id, permission_id)
      select ${spareRoleId}, p.id from permissions p where p.key = any(${keys as string[]})
    `;
  }
  return spare;
}

async function grantSpare(key: PermissionKey) {
  await sql`
    insert into role_permissions (role_id, permission_id)
    select ${spareRoleId}, p.id from permissions p where p.key = ${key}
    on conflict do nothing
  `;
}

async function revokeSpare(key: PermissionKey) {
  await sql`
    delete from role_permissions
     where role_id = ${spareRoleId}
       and permission_id = (select id from permissions where key = ${key})
  `;
}

/* -------------------------------------------------------------------------- */
/* Calling the real actions                                                   */
/* -------------------------------------------------------------------------- */

type ActionState = { ok: boolean; message?: string; errors?: Record<string, string> };

const form = (session: TestSession, values: Record<string, string>) => {
  const data = new FormData();
  data.set("_csrf", session.csrfToken);
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};

const call = <T>(file: string, route: string, action: string, args: unknown[], session: TestSession) =>
  callAction<T>({ origin: server.origin, route, file, action, args, cookie: session.cookie });

const answered = <T>(response: { value: T | null; text: string }): T => {
  if (response.value === null) throw new Error(`no action result:\n${response.text.slice(0, 400)}`);
  return response.value;
};

const navAction = (action: string, session: TestSession, values: Record<string, string>) =>
  call<ActionState>(NAV_ACTIONS, "/admin/navigation", action, [{ ok: false }, form(session, values)], session);

const settingsAction = (action: string, session: TestSession, values: Record<string, string>) =>
  call<ActionState>(SETTINGS_ACTIONS, "/admin/settings", action, [{ ok: false }, form(session, values)], session);

const userAction = (action: string, session: TestSession, values: Record<string, string>) =>
  call<ActionState>(USER_ACTIONS, "/admin/users", action, [{ ok: false }, form(session, values)], session);

/* -------------------------------------------------------------------------- */
/* Page state, for the separation tests                                       */
/* -------------------------------------------------------------------------- */

type PageRow = { id: number; revision: number; draft_structure: unknown };
type SectionRow = {
  id: number;
  revision: number;
  draft: Record<string, unknown> | null;
  draft_styles: unknown;
  draft_animation: unknown;
};

const pageBySlug = async (slug: string) => {
  const [row] = await sql<PageRow[]>`
    select id, revision, draft_structure from pages where slug = ${slug}`;
  return row!;
};

const sectionsOf = (pageId: number) =>
  sql<SectionRow[]>`
    select id, revision, draft, draft_styles, draft_animation
      from page_sections where page_id = ${pageId} order by position, id`;

const versionCount = async () => {
  const [row] = await sql<{ n: number }[]>`select count(*)::int as n from page_versions`;
  return row!.n;
};

const activityCount = async (action: string) => {
  const [row] = await sql<{ n: number }[]>`
    select count(*)::int as n from activity_logs where action = ${action}`;
  return row!.n;
};

/* -------------------------------------------------------------------------- */

describe("the permission catalogue carries the Visual Editor's own key", () => {
  test("a fresh database has it, in the Content group", async () => {
    const [row] = await sql<{ key: string; label: string; group_name: string }[]>`
      select key, label, group_name from permissions where key = 'visual_editor.view'`;
    assert.ok(row, "visual_editor.view is not in the catalogue");
    assert.equal(row!.label, "Access the Visual Editor");
    assert.equal(row!.group_name, "Content");
  });

  test("the four default roles hold what this release says they hold", () => {
    // `defaults` was read in `before`, ahead of anything in this file moving a
    // grant — the matrix below rewrites one role's permissions repeatedly.
    for (const role of ["owner", "admin", "editor", "viewer"]) {
      assert.ok(
        defaults.get(role)?.has("visual_editor.view"),
        `${role} lost Visual Editor access`,
      );
      assert.deepEqual(
        [...(defaults.get(role) ?? [])].sort(),
        [...ROLE_DEFAULTS[role]!].sort(),
        `${role}'s grants do not match ROLE_DEFAULTS`,
      );
    }
  });

  test("the editor's key is Content's, and the catalogue has no duplicate", () => {
    const keys = PERMISSIONS.map((p) => p.key);
    assert.equal(new Set(keys).size, keys.length, "a permission key appears twice");
    assert.ok(!keys.includes("visual_editor.manage" as PermissionKey));
  });
});

/* -------------------------------------------------------------------------- */

describe("the Visual Editor asks for both keys, and the sidebar says the same", () => {
  test("a role with content.view but no visual_editor.view is turned away", async () => {
    const actor = await as(["dashboard.view", "content.view"]);
    const page = await get(server.origin, VE_ROUTE, { cookie: actor.cookie });
    assert.equal(page.status, 307, `expected a redirect, got ${page.status}`);
    assert.match(page.location ?? "", /\/admin\?denied=1/);

    // …and the ordinary Pages screen is still theirs.
    const pages = await get(server.origin, "/admin/pages", { cookie: actor.cookie });
    assert.equal(pages.status, 200);

    // …and the sidebar does not offer what the route refuses.
    assert.ok(!pages.html.includes("Visual Editor"), "the sidebar still lists the Visual Editor");
  });

  test("a role with visual_editor.view but no content.view is turned away too", async () => {
    const actor = await as(["dashboard.view", "visual_editor.view"]);
    const page = await get(server.origin, VE_ROUTE, { cookie: actor.cookie });
    assert.equal(page.status, 307);
    assert.match(page.location ?? "", /\/admin\?denied=1/);

    // The canvas renders unpublished drafts; nothing of it may leak here.
    assert.ok(!page.html.includes("Page structure"), "editor markup reached a refused caller");
  });

  test("holding both opens it, and the sidebar lists it", async () => {
    const actor = await as([
      "dashboard.view",
      "content.view",
      "visual_editor.view",
    ]);
    const page = await get(server.origin, VE_ROUTE, { cookie: actor.cookie });
    assert.equal(page.status, 200);
    const dash = await get(server.origin, "/admin", { cookie: actor.cookie });
    assert.ok(dash.html.includes("Visual Editor"), "the sidebar does not list the Visual Editor");
  });

  test("taking the key away closes the door on the session already open", async () => {
    const actor = await as([
      "dashboard.view",
      "content.view",
      "visual_editor.view",
    ]);
    assert.equal((await get(server.origin, VE_ROUTE, { cookie: actor.cookie })).status, 200);

    await revokeSpare("visual_editor.view");
    const after = await get(server.origin, VE_ROUTE, { cookie: actor.cookie });
    assert.equal(after.status, 307, "the same cookie still opened the editor");
    assert.match(after.location ?? "", /denied=1/);
  });
});

/* -------------------------------------------------------------------------- */

describe("the Globals panel is sent only what its holder may manage", () => {
  const globals = (session: TestSession) =>
    call<{ navigation: unknown; settings: unknown }>(VE_ACTIONS, VE_ROUTE, "loadEditorGlobals", [], session);

  test("an owner gets both halves", async () => {
    const state = answered(await globals(owner));
    assert.ok(state.navigation, "no navigation for an owner");
    assert.ok(state.settings, "no settings for an owner");
  });

  test("a content editor with neither global permission gets neither half", async () => {
    const actor = await as([
      "dashboard.view",
      "content.view",
      "content.manage",
      "visual_editor.view",
    ]);
    const state = answered(await globals(actor));
    assert.equal(state.navigation, null);
    assert.equal(state.settings, null);
  });

  test("navigation.manage gets the menus and nothing else", async () => {
    const actor = await as([
      "dashboard.view",
      "content.view",
      "visual_editor.view",
      "navigation.manage",
    ]);
    const state = answered(await globals(actor));
    assert.ok(state.navigation, "the menus were withheld from their manager");
    assert.equal(state.settings, null, "settings reached somebody without settings.manage");
  });

  test("settings.manage gets the settings and nothing else", async () => {
    const actor = await as([
      "dashboard.view",
      "content.view",
      "visual_editor.view",
      "settings.manage",
    ]);
    const state = answered(await globals(actor));
    assert.equal(state.navigation, null, "menus reached somebody without navigation.manage");
    assert.ok(state.settings, "the settings were withheld from their manager");
  });

  test("what is withheld is withheld in full — not sent and disabled", async () => {
    // A value that is *not on the public site*: WhatsApp off, with a number and
    // the default messages still stored. Receiving it would be receiving a
    // setting nobody outside the panel is meant to see.
    await sql`
      insert into site_settings (key, value)
      values ('whatsapp', ${sql.json({
        enabled: false,
        number: "966500000123",
        defaultMessageEn: "A message no visitor can reach",
        defaultMessageAr: "",
        floatingEnabled: false,
      })}::jsonb)
      on conflict (key) do update set value = excluded.value
    `;
    // …and a hidden social row, likewise.
    await sql`
      insert into social_links (platform, url, is_published, sort_order)
      values ('tiktok', 'https://www.tiktok.com/@hidden-account', false, 99)
      on conflict do nothing
    `;

    const actor = await as([
      "dashboard.view",
      "content.view",
      "visual_editor.view",
      "content.manage",
    ]);
    const response = await call<unknown>(VE_ACTIONS, VE_ROUTE, "loadEditorGlobals", [], actor);
    assert.ok(
      !response.text.includes("966500000123"),
      "a stored WhatsApp number reached a caller without settings.manage",
    );
    assert.ok(
      !response.text.includes("A message no visitor can reach"),
      "a stored WhatsApp message reached a caller without settings.manage",
    );
    assert.ok(
      !response.text.includes("hidden-account"),
      "a hidden social link reached a caller without settings.manage",
    );
  });

  test("no analytics id and no SEO administration ride along with the globals", async () => {
    await sql`
      insert into site_settings (key, value)
      values ('analytics', ${sql.json({ ga4Id: "G-SECRETID9", gtmId: "", metaPixelId: "" })}::jsonb)
      on conflict (key) do update set value = excluded.value
    `;
    const response = await call<unknown>(VE_ACTIONS, VE_ROUTE, "loadEditorGlobals", [], owner);
    assert.ok(!response.text.includes("G-SECRETID9"), "an analytics id reached the editor payload");
    assert.ok(!response.text.includes("ga4Id"), "the analytics group reached the editor payload");
    assert.ok(!response.text.includes("titleTemplate"), "SEO defaults reached the editor payload");
  });

  test("a caller without the editor's own key gets nothing at all", async () => {
    const actor = await as([
      "dashboard.view",
      "content.view",
      "settings.manage",
      "navigation.manage",
    ]);
    const state = answered(await globals(actor));
    assert.equal(state.navigation, null);
    assert.equal(state.settings, null);
  });
});

/* -------------------------------------------------------------------------- */

describe("a global write names its own permission, whatever the caller can see", () => {
  const READER: PermissionKey[] = ["dashboard.view", "content.view", "visual_editor.view"];
  const CONTENT: PermissionKey[] = [...READER, "content.manage"];
  const NAV: PermissionKey[] = [...READER, "navigation.manage"];
  const SETTINGS: PermissionKey[] = [...READER, "settings.manage"];

  const refusal = /permission|expired/i;

  test("a viewer may change nothing", async () => {
    const viewer = await as(READER);
    const before = await sql`select count(*)::int as n from navigation_items`;
    const navSave = answered(
      await navAction("saveNavItem", viewer, {
        menu: "header",
        labelEn: "Viewer was here",
        href: "/",
      }),
    );
    assert.equal(navSave.ok, false);
    assert.match(navSave.message ?? "", refusal);

    const brand = answered(await settingsAction("saveBrand", viewer, { siteNameEn: "Viewer Co" }));
    assert.equal(brand.ok, false);
    assert.match(brand.message ?? "", refusal);

    const after = await sql`select count(*)::int as n from navigation_items`;
    assert.deepEqual(after, before, "a refused navigation save still wrote a row");
    const [row] = await sql<{ value: { siteNameEn?: string } }[]>`
      select value from site_settings where key = 'brand'`;
    assert.notEqual(row?.value?.siteNameEn, "Viewer Co");
  });

  test("a content editor may not touch navigation or settings", async () => {
    const editor = await as(CONTENT);
    const navSave = answered(
      await navAction("saveNavItem", editor, { menu: "header", labelEn: "Nope", href: "/" }),
    );
    assert.equal(navSave.ok, false);
    const brand = answered(await settingsAction("saveBrand", editor, { siteNameEn: "Editor Co" }));
    assert.equal(brand.ok, false);
    const social = answered(
      await settingsAction("saveSocialLink", editor, { platform: "x", url: "https://x.com/eod" }),
    );
    assert.equal(social.ok, false);
  });

  test("a navigation manager may move a menu and nothing else", async () => {
    const nav = await as(NAV);
    const added = answered(
      await navAction("saveNavItem", nav, {
        menu: "footer_company",
        labelEn: "Careers",
        href: "/careers",
      }),
    );
    assert.equal(added.ok, true, added.message);

    const brand = answered(await settingsAction("saveBrand", nav, { siteNameEn: "Nav Co" }));
    assert.equal(brand.ok, false, "a navigation manager changed the brand");
    const whatsapp = answered(await settingsAction("saveWhatsapp", nav, { number: "966500000999" }));
    assert.equal(whatsapp.ok, false);
  });

  test("a settings manager may change settings and not the menus", async () => {
    const settings = await as(SETTINGS);
    const brand = answered(
      await settingsAction("saveBrand", settings, {
        siteNameEn: "Elite One Desk",
        legalNameEn: "Settings Manager Ltd",
      }),
    );
    assert.equal(brand.ok, true, brand.message);

    const navSave = answered(
      await navAction("saveNavItem", settings, { menu: "header", labelEn: "No", href: "/" }),
    );
    assert.equal(navSave.ok, false, "a settings manager edited the navigation");
    const [row] = await sql<{ id: number }[]>`
      select id from navigation_items where label_en = 'No'`;
    assert.equal(row, undefined);
  });

  test("a refused write leaves no activity line behind", async () => {
    const viewer = await as(READER);
    const before = await activityCount("settings.changed");
    assert.equal(answered(await settingsAction("saveBrand", viewer, { siteNameEn: "X" })).ok, false);
    assert.equal(await activityCount("settings.changed"), before);
  });

  test("a stolen form token is not a permission either", async () => {
    const settings = await as(SETTINGS);
    // The right permission, the wrong synchroniser token.
    const data = new FormData();
    data.set("_csrf", "not-the-token");
    data.set("siteNameEn", "CSRF Co");
    const result = answered(
      await call<ActionState>(
        SETTINGS_ACTIONS,
        "/admin/settings",
        "saveBrand",
        [{ ok: false }, data],
        settings,
      ),
    );
    assert.equal(result.ok, false);
    assert.match(result.message ?? "", /expired/i);
  });
});

/* -------------------------------------------------------------------------- */

describe("a permission taken away stops the very next write", () => {
  test("navigation, on the session that was already signed in", async () => {
    const actor = await as([
      "dashboard.view",
      "content.view",
      "visual_editor.view",
      "navigation.manage",
    ]);
    const first = answered(
      await navAction("saveNavItem", actor, {
        menu: "footer_legal",
        labelEn: "Terms",
        href: "/terms",
      }),
    );
    assert.equal(first.ok, true, first.message);

    await revokeSpare("navigation.manage");

    const second = answered(
      await navAction("saveNavItem", actor, {
        menu: "footer_legal",
        labelEn: "Privacy",
        href: "/privacy",
      }),
    );
    assert.equal(second.ok, false, "the same cookie still saved a link");
    const [row] = await sql<{ id: number }[]>`
      select id from navigation_items where label_en = 'Privacy' and menu = 'footer_legal'`;
    assert.equal(row, undefined, "a refused save still wrote the row");
  });

  test("settings, the same way — and it comes back when the grant does", async () => {
    const actor = await as([
      "dashboard.view",
      "content.view",
      "visual_editor.view",
      "settings.manage",
    ]);
    assert.equal(
      answered(await settingsAction("saveFeatures", actor, { searchEnabled: "on" })).ok,
      true,
    );

    await revokeSpare("settings.manage");
    assert.equal(
      answered(await settingsAction("saveFeatures", actor, { searchEnabled: "on" })).ok,
      false,
      "a revoked permission still wrote",
    );

    await grantSpare("settings.manage");
    assert.equal(
      answered(await settingsAction("saveFeatures", actor, { searchEnabled: "on" })).ok,
      true,
      "restoring the grant did not restore the ability",
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("a global change is not a page change", () => {
  /** A page with all four kinds of pending work on it. */
  async function dirtyPage(slug: string) {
    const page = await pageBySlug(slug);
    const rows = await sectionsOf(page.id);
    const first = rows[0]!;
    await sql`
      update page_sections
         set draft = ${sql.json({ title: { en: "Pending words", ar: "" } })}::jsonb,
             draft_styles = ${sql.json({ v: 1, breakpoints: {} })}::jsonb,
             draft_animation = 'fade'
       where id = ${first.id}`;
    await sql`
      update pages
         set draft_structure = ${sql.json({
           v: 1,
           sections: rows.map((row, index) => ({
             id: row.id,
             position: index,
             isPublished: true,
           })),
         })}::jsonb
       where id = ${page.id}`;
    return { page: await pageBySlug(slug), sections: await sectionsOf(page.id) };
  }

  async function assertUntouched(
    slug: string,
    before: { page: PageRow; sections: SectionRow[] },
    versions: number,
  ) {
    const page = await pageBySlug(slug);
    assert.equal(page.revision, before.page.revision, "a global save moved pages.revision");
    assert.deepEqual(
      page.draft_structure,
      before.page.draft_structure,
      "a global save rewrote the layout draft",
    );
    const sections = await sectionsOf(before.page.id);
    assert.deepEqual(
      sections.map((row) => ({ ...row })),
      before.sections.map((row) => ({ ...row })),
      "a global save changed a section's drafts or revision",
    );
    assert.equal(await versionCount(), versions, "a global save wrote a restore point");
  }

  test("saving Contact leaves every page draft exactly where it was", async () => {
    const before = await dirtyPage("about");
    const versions = await versionCount();

    const result = answered(
      await settingsAction("saveContact", owner, {
        phone: "+966500001111",
        phoneDisplay: "+966 50 000 1111",
        email: "hello@example.test",
        addressEn: "1 Test Street",
        countryEn: "Saudi Arabia",
      }),
    );
    assert.equal(result.ok, true, result.message);

    await assertUntouched("about", before, versions);

    // …and the change itself is live, without anybody publishing a page.
    const visitor = await get(server.origin, "/contact");
    assert.ok(visitor.html.includes("+966 50 000 1111"), "the new phone number is not on the site");
  });

  test("saving a navigation link leaves them alone too", async () => {
    const before = await dirtyPage("terms");
    const versions = await versionCount();

    const result = answered(
      await navAction("saveNavItem", owner, {
        menu: "footer_company",
        labelEn: "Press",
        href: "/about",
        isPublished: "on",
      }),
    );
    assert.equal(result.ok, true, result.message);

    await assertUntouched("terms", before, versions);

    const visitor = await get(server.origin, "/");
    assert.ok(visitor.html.includes("Press"), "the new footer link is not on the site");
  });

  test("and a social change writes no page version", async () => {
    const before = await dirtyPage("privacy");
    const versions = await versionCount();
    const result = answered(
      await settingsAction("saveSocialLink", owner, {
        platform: "linkedin",
        url: "https://www.linkedin.com/company/elite-one-desk",
        isPublished: "on",
      }),
    );
    assert.equal(result.ok, true, result.message);
    await assertUntouched("privacy", before, versions);
  });

  test("the audit line says what changed, not which screen changed it", async () => {
    const before = await activityCount("settings.changed");
    assert.equal(
      answered(await settingsAction("saveDisclaimers", owner, { governmentEn: "Notice." })).ok,
      true,
    );
    assert.equal(await activityCount("settings.changed"), before + 1);
    // No second, UI-flavoured event on top of the domain one.
    assert.equal(await activityCount("visual_editor.global_saved"), 0);
  });
});

/* -------------------------------------------------------------------------- */

describe("the menus keep their shape", () => {
  test("an unknown menu is refused rather than quietly becoming the header", async () => {
    const before = await sql<{ n: number }[]>`
      select count(*)::int as n from navigation_items where menu = 'header'`;
    const result = answered(
      await navAction("saveNavItem", owner, {
        menu: "footer_sidebar",
        labelEn: "Smuggled",
        href: "/",
      }),
    );
    assert.equal(result.ok, false, "an unknown menu was accepted");
    const after = await sql<{ n: number }[]>`
      select count(*)::int as n from navigation_items where menu = 'header'`;
    assert.deepEqual(after, before, "the link landed in the header anyway");
  });

  test("a parent that does not exist is refused", async () => {
    const result = answered(
      await navAction("saveNavItem", owner, {
        menu: "header",
        labelEn: "Orphan",
        href: "/",
        parentId: "999999",
      }),
    );
    assert.equal(result.ok, false);
    const [row] = await sql<{ id: number }[]>`select id from navigation_items where label_en = 'Orphan'`;
    assert.equal(row, undefined);
  });

  test("a parent in another menu is refused", async () => {
    const [footer] = await sql<{ id: number }[]>`
      select id from navigation_items where menu = 'footer_company' and parent_id is null limit 1`;
    assert.ok(footer, "no footer link to try to adopt from");
    const result = answered(
      await navAction("saveNavItem", owner, {
        menu: "header",
        labelEn: "Cross menu",
        href: "/",
        parentId: String(footer!.id),
      }),
    );
    assert.equal(result.ok, false, "a header link took a footer parent");
  });

  test("a link cannot sit under itself, and sub-menus stop at one level", async () => {
    const added = answered(
      await navAction("saveNavItem", owner, { menu: "header", labelEn: "Level one", href: "/" }),
    );
    assert.equal(added.ok, true, added.message);
    const [parent] = await sql<{ id: number }[]>`
      select id from navigation_items where label_en = 'Level one'`;

    const itself = answered(
      await navAction("saveNavItem", owner, {
        id: String(parent!.id),
        menu: "header",
        labelEn: "Level one",
        href: "/",
        parentId: String(parent!.id),
      }),
    );
    assert.equal(itself.ok, false);

    const child = answered(
      await navAction("saveNavItem", owner, {
        menu: "header",
        labelEn: "Level two",
        href: "/",
        parentId: String(parent!.id),
      }),
    );
    assert.equal(child.ok, true, child.message);
    const [childRow] = await sql<{ id: number }[]>`
      select id from navigation_items where label_en = 'Level two'`;

    const third = answered(
      await navAction("saveNavItem", owner, {
        menu: "header",
        labelEn: "Level three",
        href: "/",
        parentId: String(childRow!.id),
      }),
    );
    assert.equal(third.ok, false, "a third level was created");

    // …and a link with children of its own cannot become a child.
    const demote = answered(
      await navAction("saveNavItem", owner, {
        id: String(parent!.id),
        menu: "header",
        labelEn: "Level one",
        href: "/",
        parentId: String(
          (
            await sql<{ id: number }[]>`
              select id from navigation_items
               where menu = 'header' and parent_id is null and id <> ${parent!.id} limit 1`
          )[0]!.id,
        ),
      }),
    );
    assert.equal(demote.ok, false, "a parent was demoted under another link");
  });

  test("editing a link does not move it to the top of its menu", async () => {
    const rows = await sql<{ id: number; sort_order: number; label_en: string }[]>`
      select id, sort_order, label_en from navigation_items
       where menu = 'header' and parent_id is null order by sort_order, id`;
    const target = rows[rows.length - 1]!;
    assert.ok(target.sort_order > 0, "the fixture has no header link below the first");

    const result = answered(
      await navAction("saveNavItem", owner, {
        id: String(target.id),
        menu: "header",
        labelEn: `${target.label_en} `.trim(),
        href: "/about",
        isPublished: "on",
      }),
    );
    assert.equal(result.ok, true, result.message);

    const [after] = await sql<{ sort_order: number }[]>`
      select sort_order from navigation_items where id = ${target.id}`;
    assert.equal(after!.sort_order, target.sort_order, "an ordinary edit changed the order");
  });

  test("the header's emphasis can be set and cleared, and the site shows it", async () => {
    const [row] = await sql<{ id: number; label_en: string }[]>`
      select id, label_en from navigation_items
       where menu = 'header' and parent_id is null and is_published order by sort_order limit 1`;

    assert.equal(
      answered(
        await navAction("saveNavItem", owner, {
          id: String(row!.id),
          menu: "header",
          labelEn: row!.label_en,
          href: "/",
          isPublished: "on",
          isHighlighted: "on",
        }),
      ).ok,
      true,
    );
    const [on] = await sql<{ is_highlighted: boolean }[]>`
      select is_highlighted from navigation_items where id = ${row!.id}`;
    assert.equal(on!.is_highlighted, true, "emphasis was not stored");

    assert.equal(
      answered(
        await navAction("saveNavItem", owner, {
          id: String(row!.id),
          menu: "header",
          labelEn: row!.label_en,
          href: "/",
          isPublished: "on",
        }),
      ).ok,
      true,
    );
    const [off] = await sql<{ is_highlighted: boolean }[]>`
      select is_highlighted from navigation_items where id = ${row!.id}`;
    assert.equal(off!.is_highlighted, false, "emphasis could be set but never cleared");
  });

  test("a footer edit leaves the stored emphasis alone", async () => {
    const [row] = await sql<{ id: number; label_en: string }[]>`
      select id, label_en from navigation_items where menu = 'footer_company' limit 1`;
    await sql`update navigation_items set is_highlighted = true where id = ${row!.id}`;
    assert.equal(
      answered(
        await navAction("saveNavItem", owner, {
          id: String(row!.id),
          menu: "footer_company",
          labelEn: row!.label_en,
          href: "/about",
          sortOrder: "0",
          isPublished: "on",
        }),
      ).ok,
      true,
    );
    const [after] = await sql<{ is_highlighted: boolean }[]>`
      select is_highlighted from navigation_items where id = ${row!.id}`;
    assert.equal(after!.is_highlighted, true, "a footer edit cleared a stored flag it never showed");
  });
});

/* -------------------------------------------------------------------------- */

describe("Users & roles is one screen over two permissions", () => {
  test("users.manage alone gets the people, not the permission grid", async () => {
    const actor = await as(["dashboard.view", "users.manage"]);
    const page = await get(server.origin, "/admin/users", { cookie: actor.cookie });
    assert.equal(page.status, 200);
    assert.ok(page.html.includes("Add person"), "the people controls are missing");
    assert.ok(
      !page.html.includes("Roles &amp; permissions"),
      "the roles tab was offered without roles.manage",
    );
  });

  test("roles.manage alone gets the grid, not the people", async () => {
    const actor = await as(["dashboard.view", "roles.manage"]);
    const page = await get(server.origin, "/admin/users", { cookie: actor.cookie });
    assert.equal(page.status, 200, "the permission with no door still has no door");
    assert.ok(page.html.includes("Roles &amp; permissions"), "the roles tab is missing");
    assert.ok(!page.html.includes("Add person"), "account controls reached somebody without users.manage");
    assert.ok(
      !page.html.includes("Has never signed in") && !page.html.includes("Last signed in"),
      "an account list reached somebody without users.manage",
    );
  });

  test("holding both gets both", async () => {
    const actor = await as([
      "dashboard.view",
      "users.manage",
      "roles.manage",
    ]);
    const page = await get(server.origin, "/admin/users", { cookie: actor.cookie });
    assert.equal(page.status, 200);
    assert.ok(page.html.includes("Add person"));
    assert.ok(page.html.includes("Roles &amp; permissions"));
  });

  test("holding neither is refused, and the sidebar does not offer it", async () => {
    const actor = await as(["dashboard.view", "content.view"]);
    const page = await get(server.origin, "/admin/users", { cookie: actor.cookie });
    /**
     * A refusal inside the admin shell is a redirect the browser is told to
     * follow rather than an HTTP 307: the shell's layout has already rendered
     * by the time the page guard runs, so Next answers 200 and carries the
     * redirect in the payload. What matters is the same either way — the
     * screen is not in it.
     */
    assert.ok(page.html.includes("denied"), "the refusal did not redirect");
    assert.ok(!page.html.includes("Add person"), "account controls survived the refusal");
    assert.ok(!page.html.includes("Roles &amp; permissions"), "role controls survived the refusal");

    const dash = await get(server.origin, "/admin", { cookie: actor.cookie });
    assert.ok(!dash.html.includes("Users &amp; roles"), "the sidebar offered a refused screen");
  });

  test("roles.manage does not imply users.manage at the action", async () => {
    const actor = await as(["dashboard.view", "roles.manage"]);
    const created = answered(
      await userAction("createUser", actor, {
        name: "Smuggled",
        email: "smuggled@eod.invalid",
        password: "Str0ngEnoughPassphrase",
        roleId: String(
          (await sql<{ id: number }[]>`select id from roles where key = 'editor'`)[0]!.id,
        ),
      }),
    );
    assert.equal(created.ok, false, "a roles manager created an account");
    const [row] = await sql<{ id: number }[]>`
      select id from users where email = 'smuggled@eod.invalid'`;
    assert.equal(row, undefined);
  });

  test("users.manage does not imply roles.manage at the action", async () => {
    const actor = await as(["dashboard.view", "users.manage"]);
    const [role] = await sql<{ id: number }[]>`select id from roles where key = 'viewer'`;
    const before = await sql<{ n: number }[]>`
      select count(*)::int as n from role_permissions where role_id = ${role!.id}`;
    const saved = answered(
      await userAction("saveRolePermissions", actor, {
        roleId: String(role!.id),
        "perm:dashboard.view": "on",
      }),
    );
    assert.equal(saved.ok, false, "a user manager rewrote a role");
    const after = await sql<{ n: number }[]>`
      select count(*)::int as n from role_permissions where role_id = ${role!.id}`;
    assert.deepEqual(after, before);
  });
});

/* -------------------------------------------------------------------------- */

describe("the owner role stays the way back in", () => {
  test("it holds the new key like every other one", async () => {
    const [row] = await sql<{ n: number }[]>`
      select count(*)::int as n
        from roles r
        join role_permissions rp on rp.role_id = r.id
        join permissions p on p.id = rp.permission_id
       where r.key = 'owner' and p.key = 'visual_editor.view'`;
    assert.equal(row!.n, 1);
  });

  test("narrowing it is refused, whoever asks", async () => {
    const [role] = await sql<{ id: number }[]>`select id from roles where key = 'owner'`;
    const before = await sql<{ n: number }[]>`
      select count(*)::int as n from role_permissions where role_id = ${role!.id}`;
    const result = answered(
      await userAction("saveRolePermissions", owner, {
        roleId: String(role!.id),
        "perm:dashboard.view": "on",
      }),
    );
    assert.equal(result.ok, false);
    assert.match(result.message ?? "", /owner role always has every permission/i);
    const after = await sql<{ n: number }[]>`
      select count(*)::int as n from role_permissions where role_id = ${role!.id}`;
    assert.deepEqual(after, before);
  });

  test("an admin cannot touch an owner account", async () => {
    const admin = await as(["dashboard.view", "users.manage"]);
    const [target] = await sql<{ id: number }[]>`
      select u.id from users u join roles r on r.id = u.role_id where r.key = 'owner' limit 1`;
    const result = answered(
      await userAction("resetUserPassword", admin, {
        id: String(target!.id),
        password: "AnotherStr0ngPassphrase",
      }),
    );
    assert.equal(result.ok, false);
    assert.match(result.message ?? "", /only an owner/i);
  });

  test("the last active owner cannot be demoted", async () => {
    const [target] = await sql<{ id: number }[]>`
      select u.id from users u join roles r on r.id = u.role_id
       where r.key = 'owner' and u.is_active order by u.id limit 1`;
    const [viewerRole] = await sql<{ id: number }[]>`select id from roles where key = 'viewer'`;
    const result = answered(
      await userAction("updateUser", owner, {
        id: String(target!.id),
        name: "Owner",
        roleId: String(viewerRole!.id),
        isActive: "on",
      }),
    );
    assert.equal(result.ok, false);
    assert.match(result.message ?? "", /at least one active owner/i);
  });
});

/* -------------------------------------------------------------------------- */

describe("a release can add a permission to a site that is already running", () => {
  /**
   * The seed is the upgrade path, and the grant loop it has always used only
   * fills a role that holds nothing at all — so on a database that has been
   * running, a key added in a release would land in the catalogue and reach
   * nobody. Whatever it guards would quietly stop working for everyone.
   *
   * The fix cannot be "grant anything missing", because that would hand back
   * every permission an owner had deliberately taken away, on every deploy. So
   * the seed reads the catalogue *before* it writes it and backfills only keys
   * this database had never heard of. This test is that distinction: one key
   * removed as if the release had not happened yet, one grant removed as a
   * decision, and only the first comes back.
   */
  test("a new key reaches the roles that want it, and a removed grant stays removed", async () => {
    const upgrading = giveFresh("globals_upgrade");
    const other = connect(upgrading);
    try {
      const roleId = async (key: string) =>
        (await other<{ id: number }[]>`select id from roles where key = ${key}`)[0]!.id;
      const holds = async (role: string, key: string) =>
        (
          await other<{ n: number }[]>`
            select count(*)::int as n
              from roles r
              join role_permissions rp on rp.role_id = r.id
              join permissions p on p.id = rp.permission_id
             where r.key = ${role} and p.key = ${key}`
        )[0]!.n > 0;

      // Rewind: this database is one that was seeded before the key existed.
      await other`
        delete from role_permissions
         where permission_id = (select id from permissions where key = 'visual_editor.view')`;
      await other`delete from permissions where key = 'visual_editor.view'`;

      // …and an owner has since decided the Editor role may not manage media.
      const editor = await roleId("editor");
      await other`
        delete from role_permissions
         where role_id = ${editor}
           and permission_id = (select id from permissions where key = 'media.manage')`;
      assert.equal(await holds("editor", "media.manage"), false);

      const result = seed(upgrading);
      assert.equal(result.code, 0, result.stderr);

      const [row] = await other<{ key: string }[]>`
        select key from permissions where key = 'visual_editor.view'`;
      assert.ok(row, "the new permission did not reach the catalogue");

      for (const role of ["owner", "admin", "editor", "viewer"]) {
        assert.ok(
          await holds(role, "visual_editor.view"),
          `${role} did not receive the newly introduced permission`,
        );
      }

      assert.equal(
        await holds("editor", "media.manage"),
        false,
        "the seed put back a grant somebody had removed",
      );

      // Running it again changes nothing — including not undoing that decision.
      assert.equal(seed(upgrading).code, 0);
      assert.equal(await holds("editor", "media.manage"), false);
    } finally {
      await other.end({ timeout: 5 });
      dropDatabase(upgrading);
    }
  });

  /**
   * The defect this test exists for: a role with no grants at all is not a new
   * role.
   *
   * The seed used to decide "was this role just created" by asking whether it
   * currently holds any permission. The Roles screen lets an owner take every
   * permission off a non-owner role, and that is a decision — but it produced
   * exactly the state the seed read as "uninitialised", so the next deployment
   * handed the whole default set back. In a release about permissions, an
   * upgrade that silently re-grants is the worst possible failure.
   *
   * The answer is to record which role *keys* existed before the seed wrote
   * anything. An empty existing role is still an existing role: it may receive
   * a key this run introduced, and nothing else.
   */
  test("an intentionally emptied role is not mistaken for a new one", async () => {
    const upgrading = giveFresh("globals_empty_role");
    const other = connect(upgrading);
    try {
      const grantsOf = async (role: string) =>
        (
          await other<{ key: string }[]>`
            select p.key
              from roles r
              join role_permissions rp on rp.role_id = r.id
              join permissions p on p.id = rp.permission_id
             where r.key = ${role}
             order by p.key`
        ).map((row) => row.key);

      // An installation from before this release…
      await other`
        delete from role_permissions
         where permission_id = (select id from permissions where key = 'visual_editor.view')`;
      await other`delete from permissions where key = 'visual_editor.view'`;

      // …whose owner has emptied the Editor role completely.
      const [editor] = await other<{ id: number }[]>`select id from roles where key = 'editor'`;
      await other`delete from role_permissions where role_id = ${editor!.id}`;
      assert.deepEqual(await grantsOf("editor"), []);

      // Another role, left alone, to prove the run is not simply doing nothing.
      const viewerBefore = await grantsOf("viewer");
      assert.ok(viewerBefore.length > 0);

      assert.equal(seed(upgrading).code, 0);

      /**
       * Editor gets the newly introduced key and **only** that key: it is in
       * `ROLE_DEFAULTS.editor`, and everything else in that list was removed on
       * purpose.
       */
      assert.deepEqual(
        await grantsOf("editor"),
        ["visual_editor.view"],
        "the seed re-granted an emptied role's defaults",
      );
      for (const key of ["content.manage", "media.manage", "seo.manage", "services.manage", "packages.manage"]) {
        assert.ok(
          !(await grantsOf("editor")).includes(key),
          `${key} came back to a role it had been taken from`,
        );
      }

      // Viewer keeps what it had, plus the introduced key its defaults name.
      assert.deepEqual(
        await grantsOf("viewer"),
        [...viewerBefore, "visual_editor.view"].sort(),
        "an untouched role did not receive the introduced key cleanly",
      );

      // And a second run is byte-for-byte the same.
      const after = await grantsOf("editor");
      assert.equal(seed(upgrading).code, 0);
      assert.deepEqual(await grantsOf("editor"), after, "a repeat seed moved the grants");
    } finally {
      await other.end({ timeout: 5 });
      dropDatabase(upgrading);
    }
  });

  /**
   * A permission is only "introduced" once, and the catalogue write and the
   * grants that follow it have to stand or fall together — otherwise a run that
   * died between them would leave the key in the catalogue, already counted as
   * known, guarding something nobody holds. Both halves are one transaction;
   * this asserts the outcome that proves it, on a fresh database where every
   * role and every key is new at once.
   */
  test("a fresh database gets every default, and a second run changes nothing", async () => {
    const fresh = giveFresh("globals_first_run");
    const other = connect(fresh);
    try {
      const grantsOf = async (role: string) =>
        (
          await other<{ key: string }[]>`
            select p.key from roles r
              join role_permissions rp on rp.role_id = r.id
              join permissions p on p.id = rp.permission_id
             where r.key = ${role} order by p.key`
        ).map((row) => row.key);

      for (const role of ["owner", "admin", "editor", "viewer"]) {
        assert.deepEqual(
          await grantsOf(role),
          [...ROLE_DEFAULTS[role]!].sort(),
          `${role} did not get its defaults on a first run`,
        );
        assert.ok((await grantsOf(role)).includes("visual_editor.view"));
      }

      const snapshot = await Promise.all(
        ["owner", "admin", "editor", "viewer"].map((role) => grantsOf(role)),
      );
      assert.equal(seed(fresh).code, 0);
      assert.deepEqual(
        await Promise.all(["owner", "admin", "editor", "viewer"].map((role) => grantsOf(role))),
        snapshot,
        "running the seed twice changed the grants",
      );
    } finally {
      await other.end({ timeout: 5 });
      dropDatabase(fresh);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("the ordinary Navigation screen still does everything it did", () => {
  const SCREEN = "/admin/navigation";
  const panel = () => get(server.origin, SCREEN, { cookie: owner.cookie });

  test("the screen renders every menu, and its own actions still add, edit, move and delete", async () => {
    /**
     * The add and edit forms on this screen appear when an admin presses Add
     * link or Manage, so there is nothing to submit from a plain GET — the
     * browser probe drives those. What this proves is the other half: the
     * screen still renders, and the actions its forms post to still do the
     * four things they did before `saveNavItem` was tightened.
     */
    const before = await panel();
    assert.equal(before.status, 200);
    for (const title of ["Header menu", "Footer — Services", "Footer — Company", "Footer — Legal"]) {
      assert.ok(before.html.includes(title), `the ${title} section is missing`);
    }

    const added = answered(
      await navAction("saveNavItem", owner, {
        menu: "footer_legal",
        labelEn: "Regression link",
        href: "/about",
        sortOrder: "5",
        isPublished: "on",
      }),
    );
    assert.equal(added.ok, true, added.message);

    const [row] = await sql<{ id: number; sort_order: number }[]>`
      select id, sort_order from navigation_items where label_en = 'Regression link'`;
    assert.ok(row, "the link was not created");

    const listed = await panel();
    assert.ok(listed.html.includes("Regression link"), "the new link is not on the screen");

    const edited = answered(
      await navAction("saveNavItem", owner, {
        id: String(row!.id),
        menu: "footer_legal",
        labelEn: "Regression link renamed",
        href: "/contact",
        sortOrder: String(row!.sort_order),
        isPublished: "on",
      }),
    );
    assert.equal(edited.ok, true, edited.message);
    const [after] = await sql<{ label_en: string; href: string; sort_order: number }[]>`
      select label_en, href, sort_order from navigation_items where id = ${row!.id}`;
    assert.equal(after!.label_en, "Regression link renamed");
    assert.equal(after!.href, "/contact");
    assert.equal(after!.sort_order, row!.sort_order, "an edit moved the link");

    const moved = answered(
      await navAction("moveNavItem", owner, { id: String(row!.id), direction: "up" }),
    );
    assert.equal(moved.ok, true, moved.message);

    const removed = answered(await navAction("deleteNavItem", owner, { id: String(row!.id) }));
    assert.equal(removed.ok, true, removed.message);
    const [gone] = await sql<{ id: number }[]>`
      select id from navigation_items where id = ${row!.id}`;
    assert.equal(gone, undefined);
  });

  test("a parent with children underneath it is still refused", async () => {
    const [parent] = await sql<{ id: number }[]>`
      select id from navigation_items where menu = 'header' and parent_id is null order by id limit 1`;
    const child = answered(
      await navAction("saveNavItem", owner, {
        menu: "header",
        labelEn: "Temporary child",
        href: "/about",
        parentId: String(parent!.id),
        isPublished: "on",
      }),
    );
    assert.equal(child.ok, true, child.message);

    const refused = answered(await navAction("deleteNavItem", owner, { id: String(parent!.id) }));
    assert.equal(refused.ok, false);
    assert.match(refused.message ?? "", /underneath it first/i);

    const [{ id }] = await sql<{ id: number }[]>`
      select id from navigation_items where label_en = 'Temporary child'`;
    assert.equal(answered(await navAction("deleteNavItem", owner, { id: String(id) })).ok, true);
  });
});

/* -------------------------------------------------------------------------- */

describe("a navigation row cannot be put into a shape the site cannot draw", () => {
  /**
   * Both editing screens refuse these by having no control for them, which is
   * not the same as refusing them. Everything here is a handcrafted request —
   * the shape a stale tab, a copied form or a curious admin can produce — and
   * both surfaces share this action, so one set of refusals covers both.
   */

  const rowsIn = (menu: string) =>
    sql<{ id: number; parent_id: number | null; label_en: string; sort_order: number }[]>`
      select id, parent_id, label_en, sort_order from navigation_items
       where menu = ${menu} order by sort_order, id`;

  const rowById = async (id: number) =>
    (
      await sql<{ menu: string; parent_id: number | null; label_en: string; href: string }[]>`
        select menu, parent_id, label_en, href from navigation_items where id = ${id}`
    )[0]!;

  test("A · an existing link cannot be moved to another menu", async () => {
    const [header] = await rowsIn("header");
    const before = await rowById(header!.id);
    const auditBefore = (
      await sql<{ n: number }[]>`
        select count(*)::int as n from activity_logs
         where action in ('navigation.updated', 'navigation.created')`
    )[0]!.n;

    const result = answered(
      await navAction("saveNavItem", owner, {
        id: String(header!.id),
        menu: "footer_services",
        labelEn: before.label_en,
        href: before.href,
        isPublished: "on",
      }),
    );
    assert.equal(result.ok, false, "a header link was moved into a footer column");
    assert.match(result.message ?? "", /cannot change its menu/i);

    const after = await rowById(header!.id);
    assert.equal(after.menu, "header", "the menu changed anyway");
    assert.equal(after.parent_id, before.parent_id);
    assert.equal(after.label_en, before.label_en);

    // …and nothing was written to the activity log as a success.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from activity_logs
       where action in ('navigation.updated', 'navigation.created')`;
    assert.equal(n, auditBefore, "a refused move still wrote an audit line");
  });

  test("B · a parent with children cannot be moved, and no cross-menu tree appears", async () => {
    const parents = await rowsIn("header");
    const parent = parents.find((row) => row.parent_id === null)!;
    const child = answered(
      await navAction("saveNavItem", owner, {
        menu: "header",
        labelEn: "A child of its parent",
        href: "/about",
        parentId: String(parent.id),
        isPublished: "on",
      }),
    );
    assert.equal(child.ok, true, child.message);

    const moved = answered(
      await navAction("saveNavItem", owner, {
        id: String(parent.id),
        menu: "footer_company",
        labelEn: parent.label_en,
        href: "/",
        isPublished: "on",
      }),
    );
    assert.equal(moved.ok, false, "a parent was moved into a footer column");

    assert.equal((await rowById(parent.id)).menu, "header");
    const [orphan] = await sql<{ menu: string; parent_id: number | null }[]>`
      select menu, parent_id from navigation_items where label_en = 'A child of its parent'`;
    assert.equal(orphan!.menu, "header");
    assert.equal(orphan!.parent_id, parent.id);

    // No row anywhere points at a parent in a different menu.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n
        from navigation_items child
        join navigation_items parent on parent.id = child.parent_id
       where child.menu <> parent.menu`;
    assert.equal(n, 0, "the stored tree crosses menus");

    const [{ id }] = await sql<{ id: number }[]>`
      select id from navigation_items where label_en = 'A child of its parent'`;
    assert.equal(answered(await navAction("deleteNavItem", owner, { id: String(id) })).ok, true);
  });

  test("C · a footer link cannot be nested under another", async () => {
    const first = answered(
      await navAction("saveNavItem", owner, {
        menu: "footer_company",
        labelEn: "Footer root one",
        href: "/about",
        isPublished: "on",
      }),
    );
    assert.equal(first.ok, true, first.message);
    const second = answered(
      await navAction("saveNavItem", owner, {
        menu: "footer_company",
        labelEn: "Footer root two",
        href: "/contact",
        isPublished: "on",
      }),
    );
    assert.equal(second.ok, true, second.message);

    const [one] = await sql<{ id: number }[]>`
      select id from navigation_items where label_en = 'Footer root one'`;
    const [two] = await sql<{ id: number }[]>`
      select id from navigation_items where label_en = 'Footer root two'`;

    const nested = answered(
      await navAction("saveNavItem", owner, {
        id: String(two!.id),
        menu: "footer_company",
        labelEn: "Footer root two",
        href: "/contact",
        parentId: String(one!.id),
        isPublished: "on",
      }),
    );
    assert.equal(nested.ok, false, "a footer link was given a parent");
    assert.match(nested.message ?? "", /only the header menu has sub-links/i);

    assert.equal((await rowById(one!.id)).parent_id, null);
    assert.equal((await rowById(two!.id)).parent_id, null);

    // …and the same refusal on creation, not only on an edit.
    const created = answered(
      await navAction("saveNavItem", owner, {
        menu: "footer_legal",
        labelEn: "Nested from birth",
        href: "/privacy",
        parentId: String(one!.id),
        isPublished: "on",
      }),
    );
    assert.equal(created.ok, false);
    const [absent] = await sql<{ id: number }[]>`
      select id from navigation_items where label_en = 'Nested from birth'`;
    assert.equal(absent, undefined);

    for (const row of [one, two]) {
      assert.equal(
        answered(await navAction("deleteNavItem", owner, { id: String(row!.id) })).ok,
        true,
      );
    }
  });

  test("D · a header child under a header root still works", async () => {
    const roots = (await rowsIn("header")).filter((row) => row.parent_id === null);
    const root = roots[0]!;
    const added = answered(
      await navAction("saveNavItem", owner, {
        menu: "header",
        labelEn: "Legitimate sub-link",
        href: "/services",
        parentId: String(root.id),
        isPublished: "on",
      }),
    );
    assert.equal(added.ok, true, added.message);
    const [row] = await sql<{ parent_id: number | null; menu: string }[]>`
      select parent_id, menu from navigation_items where label_en = 'Legitimate sub-link'`;
    assert.equal(row!.parent_id, root.id);
    assert.equal(row!.menu, "header");

    const [{ id }] = await sql<{ id: number }[]>`
      select id from navigation_items where label_en = 'Legitimate sub-link'`;
    assert.equal(answered(await navAction("deleteNavItem", owner, { id: String(id) })).ok, true);
  });

  test("E · an ordinary footer add and edit still work", async () => {
    const added = answered(
      await navAction("saveNavItem", owner, {
        menu: "footer_services",
        labelEn: "Ordinary footer link",
        href: "/services",
        sortOrder: "3",
        isPublished: "on",
      }),
    );
    assert.equal(added.ok, true, added.message);
    const [row] = await sql<{ id: number; sort_order: number }[]>`
      select id, sort_order from navigation_items where label_en = 'Ordinary footer link'`;

    const edited = answered(
      await navAction("saveNavItem", owner, {
        id: String(row!.id),
        menu: "footer_services",
        labelEn: "Ordinary footer link, renamed",
        href: "/contact",
        isPublished: "on",
      }),
    );
    assert.equal(edited.ok, true, edited.message);
    const [after] = await sql<{ label_en: string; href: string; sort_order: number }[]>`
      select label_en, href, sort_order from navigation_items where id = ${row!.id}`;
    assert.equal(after!.label_en, "Ordinary footer link, renamed");
    assert.equal(after!.href, "/contact");
    assert.equal(after!.sort_order, row!.sort_order, "an ordinary footer edit moved the link");

    assert.equal(answered(await navAction("deleteNavItem", owner, { id: String(row!.id) })).ok, true);
  });

  test("a move with no sibling to swap with says so instead of claiming a save", async () => {
    const roots = (await rowsIn("header")).filter((row) => row.parent_id === null);
    const first = roots[0]!;
    const before = await sql<{ id: number; sort_order: number }[]>`
      select id, sort_order from navigation_items order by id`;

    const result = answered(
      await navAction("moveNavItem", owner, { id: String(first.id), direction: "up" }),
    );
    assert.match(
      result.message ?? "",
      /already first in its group/i,
      `a no-op move reported: ${JSON.stringify(result.message ?? null)}`,
    );

    const after = await sql<{ id: number; sort_order: number }[]>`
      select id, sort_order from navigation_items order by id`;
    assert.deepEqual(after.map((r) => ({ ...r })), before.map((r) => ({ ...r })));
  });

  test("a first child is also at the top of its own group", async () => {
    const roots = (await rowsIn("header")).filter((row) => row.parent_id === null);
    const root = roots[0]!;
    assert.equal(
      answered(
        await navAction("saveNavItem", owner, {
          menu: "header",
          labelEn: "Only child",
          href: "/about",
          parentId: String(root.id),
          isPublished: "on",
        }),
      ).ok,
      true,
    );
    const [child] = await sql<{ id: number }[]>`
      select id from navigation_items where label_en = 'Only child'`;

    /**
     * The row sits well down the flat list of its menu, so an index taken from
     * that list would have offered it a Move up. Its sibling group has one
     * member, and the server says so.
     */
    const up = answered(
      await navAction("moveNavItem", owner, { id: String(child!.id), direction: "up" }),
    );
    assert.match(up.message ?? "", /already first in its group/i);
    const down = answered(
      await navAction("moveNavItem", owner, { id: String(child!.id), direction: "down" }),
    );
    assert.match(down.message ?? "", /already last in its group/i);

    assert.equal(
      answered(await navAction("deleteNavItem", owner, { id: String(child!.id) })).ok,
      true,
    );
  });
});
