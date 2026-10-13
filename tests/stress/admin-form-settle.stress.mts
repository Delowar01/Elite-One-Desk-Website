/**
 * Batch 19C stress: an admin save shows its answer without anybody touching
 * the screen — every time, under load.
 *
 * The 19C browser scenario caught the Users screen leaving "Create account"
 * on "Saving…" after the account had been created. Every admin form saves
 * through a Server Action that revalidates the page, and the React that Next
 * 15.5 bundles can drop the transition that would show the answer: a stream
 * chunk resolves while React is rendering, the ping is lost, and nothing is
 * scheduled again until the next update of any kind — a keystroke, a click
 * (see `useSettledActionState` in `components/admin/form.tsx`). Measured on
 * cold servers before the fix: 8 of 36 account creations and 15 of 36 question
 * saves never showed their answer.
 *
 * So this script does what makes it happen — three servers, each restarted
 * cold before every save — and then does nothing at all: no keystroke, no
 * click, no focus change, until the answer is on screen or the wait is over.
 *
 *   F1  every account created on the Users screen shows its confirmation and
 *       releases its button
 *   F2  every question added on the FAQ screen does the same
 *   F3  the database holds every one of them, exactly once
 *   F4  no page errors
 *   F5  every package created on the Packages screen lands on its own screen
 *       — an action that answers with `redirect()`, whose next screen stalls
 *       the same way (Batch 26) — stored exactly once
 *   F6  every package deleted from its screen lands on the list, and is gone
 *   F7  every category created on the Categories screen lands on its own
 *       screen, stored exactly once, and F8 every one deleted from its screen
 *       lands on the list, gone (Batch 27)
 *   F9  every service created on the Services screen does the same, and F10
 *       every one deleted (Batch 27)
 *
 * Packages, categories and services are the three screens whose create and
 * delete answer with a redirect; Batch 27 (the Next.js 16 qualification) added
 * the other two, so every one of them settles from cold, untouched.
 *
 *   STRESS_LOOPS=12 (saves per screen per server)
 */
import type { Browser, Page } from "playwright";

import { giveFresh } from "../helpers/fixtures";
import { connect, dropDatabase } from "../helpers/pg";
import { startServer, type Server } from "../helpers/server";
import { signIn } from "../helpers/session";
import { launchChromium } from "../browser/harness";

/** The first of three: each worker serves on PORT + its index (3815–3817). */
const PORT = 3815;
const WORKERS = 3;
const LOOPS = Number(process.env.STRESS_LOOPS ?? 12);
/** Far longer than a save takes; a dropped answer never arrives at all. */
const SETTLE_MS = 8_000;
const say = (label: string, ok: boolean, detail = "") =>
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);

/** The screens whose create sends the browser to the new record and whose delete sends it to the list. */
type Screen = "package" | "category" | "service";
const SCREENS: Record<Screen, { list: string; create: string; remove: string }> = {
  package: { list: "/admin/packages", create: "Create package", remove: "Delete package" },
  category: { list: "/admin/categories", create: "Create category", remove: "Delete category" },
  service: { list: "/admin/services", create: "Create service", remove: "Delete service" },
};
const perScreen = (): Record<Screen, number> => ({ package: 0, category: 0, service: 0 });

type Outcome = {
  users: number;
  faqs: number;
  stored: number;
  duplicates: number;
  /** Creates and deletes that landed, screen by screen (F5–F10). */
  creates: Record<Screen, number>;
  deletes: Record<Screen, number>;
  errors: string[];
  misses: string[];
  /** F5–F10's own, so F1's detail stays about the forms that answer. */
  unlanded: string[];
};

/** Waits, touching nothing, for the answer to be on screen and the button released. */
async function settles(page: Page, confirmation: string): Promise<boolean> {
  const shown = await page
    .getByRole("status")
    .filter({ hasText: confirmation })
    .waitFor({ timeout: SETTLE_MS })
    .then(() => true, () => false);
  const released = (await page.locator("form button[type=submit]", { hasText: "Saving…" }).count()) === 0;
  return shown && released;
}

/** Waits, touching nothing, for the browser to arrive where the action sent it. */
async function lands(page: Page, where: (path: string) => boolean): Promise<boolean> {
  return page.waitForURL((url) => where(url.pathname), { timeout: SETTLE_MS }).then(() => true, () => false);
}

async function worker(index: number): Promise<Outcome> {
  const out: Outcome = { users: 0, faqs: 0, stored: 0, duplicates: 0, creates: perScreen(), deletes: perScreen(), errors: [], misses: [], unlanded: [] };
  const browser: Browser = await launchChromium();
  const database = giveFresh(`form_settle_${index}`);
  const sql = connect(database);
  let server: Server | undefined;
  try {
    const owner = await signIn(sql);
    const [cookieName, cookieValue] = owner.cookie.split("=");
    const cold = async () => {
      await server?.stop();
      server = await startServer(database, PORT + index);
      return server.origin;
    };
    const open = async () => {
      const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
      await context.addCookies([{ name: cookieName!, value: cookieValue!, domain: "127.0.0.1", path: "/" }]);
      const page = await context.newPage();
      page.on("pageerror", (error) => out.errors.push(error.message.slice(0, 160)));
      // "Delete …? This cannot be undone." — answered yes, as the editor would.
      page.on("dialog", (dialog) => void dialog.accept());
      return { context, page };
    };

    const [category] = await sql<{ id: number }[]>`select id from service_categories where is_published order by id limit 1`;
    const idsBySlug = (screen: Screen, slug: string) =>
      screen === "package"
        ? sql<{ id: number }[]>`select id from travel_packages where slug = ${slug}`
        : screen === "category"
          ? sql<{ id: number }[]>`select id from service_categories where slug = ${slug}`
          : sql<{ id: number }[]>`select id from services where slug = ${slug}`;
    const countById = async (screen: Screen, id: number) => {
      const [left] =
        screen === "package"
          ? await sql<{ n: number }[]>`select count(*)::int as n from travel_packages where id = ${id}`
          : screen === "category"
            ? await sql<{ n: number }[]>`select count(*)::int as n from service_categories where id = ${id}`
            : await sql<{ n: number }[]>`select count(*)::int as n from services where id = ${id}`;
      return left!.n;
    };

    /**
     * A create that redirects to the new record's screen, from cold; then, from
     * cold again, its delete, which redirects to the list.
     */
    const createAndDelete = async (screen: Screen, round: number) => {
      const { list, create, remove } = SCREENS[screen];
      const slug = `settle-${index}-${round}`;
      let origin = await cold();
      let { context, page } = await open();
      try {
        await page.goto(`${origin}${list}/new`, { waitUntil: "load" });
        await page.locator("#titleEn").fill(`Settle ${index}-${round}`);
        await page.locator("#slug").fill(slug);
        if (screen === "service") {
          await page.locator("#introEn").fill("A service made to see its screen arrive.");
          await page.locator("#categoryId").selectOption(String(category!.id));
        }
        await page.getByRole("button", { name: create }).click();
        const landed = await lands(page, (path) => path.startsWith(`${list}/`) && /^\d+$/.test(path.slice(list.length + 1)));
        const made = await idsBySlug(screen, slug);
        if (landed && made.length === 1) out.creates[screen] += 1;
        else out.unlanded.push(`server ${index} round ${round}: the new ${screen}'s screen never arrived (rows ${made.length})`);
      } finally {
        await context.close();
      }
      const [row] = await idsBySlug(screen, slug);
      if (!row) return;
      origin = await cold();
      ({ context, page } = await open());
      try {
        await page.goto(`${origin}${list}/${row.id}`, { waitUntil: "load" });
        await page.getByRole("button", { name: remove }).click();
        const landed = await lands(page, (path) => path === list);
        const left = await countById(screen, row.id);
        if (landed && left === 0) out.deletes[screen] += 1;
        else out.unlanded.push(`server ${index} round ${round}: the ${screen} list never arrived after the delete (rows ${left})`);
      } finally {
        await context.close();
      }
    };

    for (let round = 1; round <= LOOPS; round += 1) {
      const email = `settle-${index}-${round}@stress.invalid`;
      let origin = await cold();
      let { context, page } = await open();
      try {
        await page.goto(`${origin}/admin/users`, { waitUntil: "load" });
        await page.getByRole("button", { name: "Add person" }).click();
        await page.locator("#new-name").fill(`Settle ${index}-${round}`);
        await page.locator("#new-email").fill(email);
        await page.locator("#new-roleId").selectOption({ index: 3 });
        await page.locator("#new-password").fill("Temporary-Pass-2026");
        await page.getByRole("button", { name: "Create account" }).click();
        if (await settles(page, "Account created with a temporary password")) out.users += 1;
        else out.misses.push(`server ${index} round ${round}: the Users screen never showed its answer`);
      } finally {
        await context.close();
      }

      const question = `Does the answer settle ${index}-${round}?`;
      origin = await cold();
      ({ context, page } = await open());
      try {
        await page.goto(`${origin}/admin/faqs`, { waitUntil: "load" });
        await page.getByRole("button", { name: "Add question" }).first().click();
        await page.locator("[id^=questionEn-]").first().fill(question);
        await page.locator("form button[type=submit]", { hasText: "Add question" }).click();
        if (await settles(page, "Question added.")) out.faqs += 1;
        else out.misses.push(`server ${index} round ${round}: the FAQ screen never showed its answer`);
      } finally {
        await context.close();
      }

      for (const screen of ["package", "category", "service"] as const) await createAndDelete(screen, round);

      const [users] = await sql<{ n: number }[]>`select count(*)::int as n from users where email = ${email}`;
      const [faqs] = await sql<{ n: number }[]>`select count(*)::int as n from faqs where question_en = ${question}`;
      if (users!.n === 1 && faqs!.n === 1) out.stored += 1;
      if (users!.n > 1 || faqs!.n > 1) out.duplicates += 1;
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
const total = (key: "users" | "faqs" | "stored" | "duplicates") => outcomes.reduce((sum, outcome) => sum + outcome[key], 0);
const landed = (key: "creates" | "deletes", screen: Screen) => outcomes.reduce((sum, outcome) => sum + outcome[key][screen], 0);
const misses = outcomes.flatMap((outcome) => outcome.misses);
const errors = outcomes.flatMap((outcome) => outcome.errors);
const unlanded = (what: string) => {
  const lines = outcomes.flatMap((outcome) => outcome.unlanded).filter((line) => line.includes(what));
  return lines.length ? ` · ${lines.slice(0, 3).join(" | ")}` : "";
};
const runs = WORKERS * LOOPS;

say(
  "F1. every account created on the Users screen shows its confirmation and releases its button, untouched, three servers at once, each from cold",
  total("users") === runs,
  `${total("users")}/${runs}${misses.length ? ` · ${misses.slice(0, 3).join(" | ")}` : ""}`,
);
say("F2. every question added on the FAQ screen does the same", total("faqs") === runs, `${total("faqs")}/${runs}`);
say("F3. the database holds every account and question, exactly once", total("stored") === runs && total("duplicates") === 0, `${total("stored")}/${runs}`);
say("F4. no page errors", errors.length === 0, errors.slice(0, 3).join(" | "));
say(
  "F5. every package created on the Packages screen lands on its own screen, untouched, each from cold — an action that redirects (Batch 26)",
  landed("creates", "package") === runs,
  `${landed("creates", "package")}/${runs}${unlanded("new package")}`,
);
say(
  "F6. every package deleted from its screen lands on the list, untouched, and is gone",
  landed("deletes", "package") === runs,
  `${landed("deletes", "package")}/${runs}${unlanded("package list never arrived")}`,
);
say(
  "F7. every category created on the Categories screen lands on its own screen, untouched, each from cold (Batch 27)",
  landed("creates", "category") === runs,
  `${landed("creates", "category")}/${runs}${unlanded("new category")}`,
);
say(
  "F8. every category deleted from its screen lands on the list, untouched, and is gone",
  landed("deletes", "category") === runs,
  `${landed("deletes", "category")}/${runs}${unlanded("category list never arrived")}`,
);
say(
  "F9. every service created on the Services screen lands on its own screen, untouched, each from cold (Batch 27)",
  landed("creates", "service") === runs,
  `${landed("creates", "service")}/${runs}${unlanded("new service")}`,
);
say(
  "F10. every service deleted from its screen lands on the list, untouched, and is gone",
  landed("deletes", "service") === runs,
  `${landed("deletes", "service")}/${runs}${unlanded("service list never arrived")}`,
);
