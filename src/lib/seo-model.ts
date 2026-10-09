import { sql, type SQL } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { localeHref, stripLocale, type Locale } from "@/lib/i18n/config";

/**
 * Which SEO record a page uses, and how a record knows whose it is (Batch 25 —
 * docs/admin/seo-and-share-images.md, Part B).
 *
 * Until Batch 25 a record was found by the text of its key, and the key was
 * an address: a destination renamed, or a service moved to another category,
 * left its record behind under the old address, and a record that took the old
 * address later inherited it. The Visual Editor answered the same question in
 * Batches 21–24 by keying everything by the record's id — "its slug can change,
 * its id cannot" — and this is the same answer for SEO.
 *
 * Deliberately not `server-only`: `scripts/migrate.ts` binds rows with it at
 * every deploy, and the tests read the rule directly. Everything here is a pure
 * function, or a statement run on a connection the caller hands in.
 */

/* -------------------------------------------------------------------------- */
/* Targets                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Everything that has, or can have, an SEO record of its own. The references
 * are the Visual Editor's route keys wherever the editor has one, so the editor
 * links to a target by the key it already holds.
 */
export const SEO_KINDS = [
  "site",
  "page",
  "serviceIndex",
  "packageIndex",
  "category",
  "service",
  "package",
  "destination",
] as const;
export type SeoKind = (typeof SEO_KINDS)[number];

/** `destination:3` — a kind and the id of the record, never an address. */
export type SeoRef = { kind: SeoKind; id: number };

/** One of each: the site's defaults and the two overviews. Their id is always 1. */
export const SINGLETON_SEO_KINDS: ReadonlySet<SeoKind> = new Set(["site", "serviceIndex", "packageIndex"]);

const REF = /^(site|page|serviceIndex|packageIndex|category|service|package|destination):([1-9][0-9]{0,8})$/;

/** A reference as the browser sent it, or `null` for anything that is not exactly one. */
export function parseSeoRef(input: unknown): SeoRef | null {
  if (typeof input !== "string") return null;
  const match = REF.exec(input);
  if (!match) return null;
  const kind = match[1] as SeoKind;
  const id = Number(match[2]);
  if (SINGLETON_SEO_KINDS.has(kind) && id !== 1) return null;
  return { kind, id };
}

export const seoRefOf = (ref: SeoRef): string => `${ref.kind}:${ref.id}`;

/* -------------------------------------------------------------------------- */
/* Storage                                                                     */
/* -------------------------------------------------------------------------- */

/** The `entity_type` values a target is stored under. */
export type SeoEntityType = "page" | "category" | "service" | "package" | "destination";

/** The types whose rows belong to a record, and can therefore be bound to its id. */
export const RECORD_ENTITY_TYPES: readonly SeoEntityType[] = ["page", "category", "service", "package", "destination"];

/**
 * The two overviews are stored as pages under fixed keys — the keys their
 * routes have always looked up, and that no CMS page can take (both are
 * reserved slugs).
 */
export const OVERVIEW_KEYS = { serviceIndex: "services", packageIndex: "packages" } as const;

/** Where a target's record lives. `entityId` is null only for the overviews. */
export type SeoStorage = { entityType: SeoEntityType; entityKey: string; entityId: number | null };

/** `seo_metadata.entity_key` is `varchar(190)`. */
export const SEO_KEY_MAX = 190;

/**
 * The key a record's row carries: its present address, which is what the
 * previous release looks it up by. An address that will not fit the column —
 * a service whose two slugs together run past 190 characters — is one the
 * previous release never found anyway (it truncated the key on save and looked
 * up the whole address); such a row is keyed `#<id>`, which no slug can be,
 * and is found by its id.
 */
export const storedKeyOf = (address: string, id: number): string =>
  address.length <= SEO_KEY_MAX ? address : `#${id}`;

export const recordStorage = (entityType: SeoEntityType, address: string, id: number): SeoStorage => ({
  entityType,
  entityKey: storedKeyOf(address, id),
  entityId: id,
});

export const overviewStorage = (kind: keyof typeof OVERVIEW_KEYS): SeoStorage => ({
  entityType: "page",
  entityKey: OVERVIEW_KEYS[kind],
  entityId: null,
});

/* -------------------------------------------------------------------------- */
/* The rule                                                                    */
/* -------------------------------------------------------------------------- */

export type SeoRowLike = { entityType: string; entityKey: string; entityId: number | null };

/**
 * The rows, sorted the way the rule reads them. A row is
 *
 *   · bound (`entity_id > 0`) — it belongs to that record, wherever the
 *     record's address goes;
 *   · unbound (`entity_id` null) — only its address names it: the two
 *     overviews always, and a row the previous release wrote that has not
 *     been bound yet. Unless its key is in a reserved form, which no address
 *     is: only a hand-made request to that release's form writes one (A.9),
 *     it names nothing, and it is as dead as the next one (W2³);
 *   · detached (`entity_id = 0`) — dead: it named no record when it was
 *     last examined, its record was deleted, or a newer row replaced it. It is
 *     kept, never used, and keyed `~<row id>`.
 */
export type SeoRowIndex<R extends SeoRowLike> = { bound: Map<string, R>; unbound: Map<string, R> };

/**
 * A key in one of the forms only this release writes: `#<id>`, a record's own
 * row's when its address is too long for the column or while it is parked, and
 * `~<n>`, row n's once it is set aside.
 */
export const isReservedSeoKey = (key: string): boolean => key.startsWith("#") || key.startsWith("~");

export function indexSeoRows<R extends SeoRowLike>(rows: readonly R[]): SeoRowIndex<R> {
  const bound = new Map<string, R>();
  const unbound = new Map<string, R>();
  for (const row of rows) {
    if (row.entityId === null) {
      if (!isReservedSeoKey(row.entityKey)) unbound.set(`${row.entityType}:${row.entityKey}`, row);
    } else if (row.entityId > 0) bound.set(`${row.entityType}#${row.entityId}`, row);
  }
  return { bound, unbound };
}

/**
 * Of a target's two possible rows — its bound row, and the unbound row at its
 * present address — the one it uses. Its bound row, normally. But a bound row
 * keyed at another address beside an unbound row at the present one means the
 * previous release moved the record and then saved its SEO by address: the
 * newer, unbound row is what that release shows, and what the next deploy keeps
 * (`reconcileSeoRows`, step 2) — so it is what this release shows too. One rule,
 * at runtime and at deploy.
 */
export function preferredSeoRow<R extends SeoRowLike>(bound: R | null, unbound: R | null, storage: SeoStorage): R | null {
  if (bound && unbound && bound.entityKey !== storage.entityKey) return unbound;
  return bound ?? unbound;
}

/**
 * The record a target uses (`preferredSeoRow`): its bound row if it has one,
 * otherwise the unbound row at its present address — exactly the row the
 * previous release would have used. Every reader calls this: the public pages,
 * the SEO screen, the media library's guard and the Visual Editor's indicator.
 */
export function seoRowFor<R extends SeoRowLike>(index: SeoRowIndex<R>, storage: SeoStorage): R | null {
  const bound = storage.entityId !== null ? index.bound.get(`${storage.entityType}#${storage.entityId}`) ?? null : null;
  const unbound = index.unbound.get(`${storage.entityType}:${storage.entityKey}`) ?? null;
  return preferredSeoRow(bound, unbound, storage);
}

/* -------------------------------------------------------------------------- */
/* Text, in each language                                                      */
/* -------------------------------------------------------------------------- */

/** A text in both languages, as stored — never pre-picked. */
export type Bilingual = { en: string; ar: string };

const clean = (value: string | null | undefined): string => (value ?? "").trim();

/**
 * Which text a page shows in one language — its title or its description —
 * from its SEO record, its own content and the site default (B.4):
 *
 *   English: the record's English → the page's own English → the site default.
 *   Arabic:  the record's Arabic → the page's own Arabic → and only where there
 *            is no Arabic at all: the record's English → the page's own English
 *            → the site default (its Arabic, else its English).
 *
 * So an English record never replaces real Arabic content — an empty Arabic
 * field means "follow this page's own Arabic", as the SEO screen has always
 * said — while an English record still beats raw English content on an
 * Arabic page that has no Arabic of its own. `arabic` says which kind of text
 * won, for the share text that follows it.
 */
export function textFor(
  locale: Locale,
  record: Partial<Bilingual> | null,
  own: Partial<Bilingual> | null | undefined,
  fallback: Partial<Bilingual>,
): { text: string; arabic: boolean } {
  const r = { en: clean(record?.en), ar: clean(record?.ar) };
  const o = { en: clean(own?.en), ar: clean(own?.ar) };
  const f = { en: clean(fallback.en), ar: clean(fallback.ar) };
  if (locale !== "ar") return { text: r.en || o.en || f.en, arabic: false };
  if (r.ar) return { text: r.ar, arabic: true };
  if (o.ar) return { text: o.ar, arabic: true };
  if (r.en) return { text: r.en, arabic: false };
  if (o.en) return { text: o.en, arabic: false };
  if (f.ar) return { text: f.ar, arabic: true };
  return { text: f.en, arabic: false };
}

/**
 * The share title or description in one language: the record's own share text
 * in that language, else the text the page already shows — except that an
 * Arabic page showing English (it has no Arabic) takes the English share text
 * before the English title, as the English page does.
 */
export function shareTextFor(
  locale: Locale,
  record: Partial<Bilingual> | null,
  shown: { text: string; arabic: boolean },
): string {
  const en = clean(record?.en);
  const ar = clean(record?.ar);
  if (locale !== "ar") return en || shown.text;
  if (ar) return ar;
  if (!shown.arabic && en) return en;
  return shown.text;
}

/* -------------------------------------------------------------------------- */
/* Canonical addresses                                                         */
/* -------------------------------------------------------------------------- */

export const CANONICAL_MAX = 255;

/**
 * Addresses that are not pages — the admin, the API, the build's assets, the
 * media files — or that are pages no canonical should name: search results
 * (always `noindex`) and `/home` (the homepage's second address, B.14).
 * Tested on the path with its language prefix removed and its escapes
 * decoded, so `/ar/admin` and `/%61dmin` are the admin as surely as `/admin`.
 */
const NOT_A_PAGE = /^\/(?:admin|api|_next|media|search|home)(?:\/|$)/i;

/**
 * The path a canonical names, or why it names none. What it returns is what a
 * page emits, so every test runs on that: the path decoded once and with its
 * language prefix removed — and it must then be final. Anything a second
 * decoding or a second prefix would still change is refused, because the save
 * stores this path and the page decodes and strips it again: `%253F` would
 * pass as `%3F` and be drawn as `?`, and `/ar/ar/search` as `/ar/search`. So is
 * an empty segment anywhere: `/en//search` is `//search` once its prefix is
 * gone, and Next answers any address with `//` in it by redirecting to another.
 * A trailing slash is dropped for the same reason: `/about/` redirects to `/about`.
 */
function pagePathOf(path: string): { path: string } | { problem: string } {
  if (path.startsWith("//")) return { problem: "Start with a single / for a page of this site." };
  let decoded: string;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    return { problem: "That address could not be read." };
  }
  if (/[\s\u0000-\u001f\u007f\\]/.test(decoded)) return { problem: "An address has no spaces, line breaks or backslashes." };
  if (/[?#]/.test(decoded)) return { problem: "Leave out the ? and # parts: a canonical address is the page itself." };
  if (decoded.includes("%")) return { problem: "Write the page's address as it reads, without encoded characters." };
  if (decoded.includes("//")) return { problem: "Use single slashes: an address with // in it is not a page's own address." };
  if (/(^|\/)\.{1,2}(\/|$)/.test(decoded)) return { problem: "Write the page's own address, without . or .. in it." };
  const bare = stripLocale(decoded);
  if (stripLocale(bare) !== bare) return { problem: "Write the page's address with one language prefix at most." };
  if (NOT_A_PAGE.test(bare)) return { problem: "That address is not a page that can be canonical." };
  // Next answers `/about/` by redirecting to `/about`: a page's own address ends without one.
  return { path: bare.length > 1 ? bare.replace(/\/$/, "") : bare };
}

/**
 * Why a canonical address cannot be stored, in a sentence — or `null` when it
 * can. A canonical override names another page **of this site**: a site path
 * (`/about`), or a full address on the site's own origin. Never another site —
 * a cross-domain canonical moves a page's ranking elsewhere with no visible
 * sign on the page, and nothing the brief asks for needs one. Nothing that
 * could carry state either: no query string (a preview parameter can never
 * become a canonical), no fragment, no whitespace or control character, no
 * protocol-relative `//host`, no `.` or `..` segment.
 */
export function canonicalProblem(raw: string, siteUrl: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (value.length > CANONICAL_MAX) return `Keep it under ${CANONICAL_MAX} characters.`;
  if (/[\s\u0000-\u001f\u007f]/.test(value)) return "An address has no spaces or line breaks.";
  if (/[?#]/.test(value)) return "Leave out the ? and # parts: a canonical address is the page itself.";
  if (value.startsWith("/")) {
    const page = pagePathOf(value);
    return "problem" in page ? page.problem : null;
  }
  let url: URL;
  let site: URL;
  try {
    url = new URL(value);
    site = new URL(siteUrl);
  } catch {
    return "Write a page of this site, starting with /.";
  }
  if (url.username || url.password) return "An address with a user name or password in it cannot be a canonical.";
  if (url.origin !== site.origin) return "A canonical address must be a page of this site. Write it starting with /.";
  const page = pagePathOf(url.pathname);
  return "problem" in page ? page.problem : null;
}

/**
 * A canonical as it is stored: the page's path without a language prefix
 * (`/ar/about` and `https://<site>/en/about` are both `/about`). Stored that
 * way it is language-neutral — this release gives it the right prefix per
 * edition, and the previous release, after a rollback, emits the English
 * address rather than one edition's address on the other's page. A value that
 * would be refused is returned as given, for the refusal to name.
 */
export function storedCanonical(raw: string, siteUrl: string): string {
  const value = raw.trim();
  if (!value || canonicalProblem(value, siteUrl)) return value;
  const page = pagePathOf(value.startsWith("/") ? value : new URL(value).pathname);
  return "problem" in page ? value : page.path;
}

/**
 * The canonical a page declares in one language for a stored override, or
 * `null` to use its own address.
 *
 * The override names a page, and the page is drawn in the language being
 * rendered: `/about` is `/ar/about` on the Arabic page, so a canonical never
 * sends one edition to the other. A stored value that would not be accepted
 * today — saved before Batch 25, a foreign address included — is ignored
 * rather than emitted.
 */
export function canonicalOverride(raw: string, locale: Locale, siteUrl: string): string | null {
  const value = raw.trim();
  if (!value || canonicalProblem(value, siteUrl)) return null;
  const page = pagePathOf(value.startsWith("/") ? value : new URL(value).pathname);
  if ("problem" in page) return null;
  return `${siteUrl}${localeHref(locale, page.path)}`;
}

/* -------------------------------------------------------------------------- */
/* Binding rows at deploy                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The records each type of row belongs to, and the present address of each —
 * one fixed query per type, written as SQL in code and never built from input
 * (no raw SQL or identifier API: tests/dependency-advisories.test.ts).
 */
const RECORDS: Record<SeoEntityType, SQL> = {
  page: sql`select id, slug as address from pages`,
  category: sql`select id, slug as address from service_categories`,
  service: sql`select v.id, c.slug || '/' || v.slug as address from services v join service_categories c on c.id = v.category_id`,
  package: sql`select id, slug as address from travel_packages`,
  destination: sql`select id, slug as address from package_destinations`,
};

/** Each record with the key its row should carry (`storedKeyOf`, in SQL). */
const keyed = (type: SeoEntityType) =>
  sql`(select id, case when length(address) <= ${SEO_KEY_MAX} then address else '#' || id end as k from (${RECORDS[type]}) x)`;

/**
 * Every record of every type with the key its row should carry — `type`, `id`
 * and `k` — as one subquery, so a reader can take the records and the rows in
 * one statement, at one moment (`seoMediaUsage`, W5³).
 */
export const seoRecordKeys = (): SQL =>
  sql.join(
    RECORD_ENTITY_TYPES.map((type) => sql`select ${type}::text as type, id, k from ${keyed(type)} r`),
    sql` union all `,
  );

/** The overview keys are pages' rows that are never bound. */
const notOverview = (type: SeoEntityType) => (type === "page" ? sql`and entity_key not in ('services', 'packages')` : sql``);

export type SeoReconcileCounts = { bound: number; rekeyed: number; setAside: number; parked: number };

/**
 * Brings every stored SEO row into line with the records it belongs to
 * (docs/admin/seo-and-share-images.md B.3). Run by `scripts/migrate.ts` after
 * the migrations, on every deploy; a second run changes nothing, except to
 * finish moving rows the first had to leave at `#<id>` (step 5). Nothing is
 * deleted.
 *
 * The previous release reads and writes rows by address only, and it keeps
 * serving during the deploy window — and again after a rollback. So the rows a
 * deploy finds can be in any of the states that release leaves behind. What the
 * run settles them to is what this release's own rule (`preferredSeoRow`)
 * already shows for them, so the deploy changes nothing this release shows:
 * a record's own row is its record's, wherever it sits; a row written by
 * address at a record's present address is that record's, and newer than a
 * row of its own left at an old address; any other row is dead — kept, never
 * used, and keyed `~<row id>`, which no address and no record can reach.
 *
 * The table is locked `EXCLUSIVE` first. A write that has not touched the
 * table yet waits for the run — the previous release's saves and this
 * release's alike — while every read goes on. A write already under way is
 * waited for instead, including one of this release's that has locked its rows
 * `FOR UPDATE` and has yet to write them: its own later statements go ahead of
 * the queued lock, so the two never wait on each other, where a weaker lock
 * would have deadlocked. The transaction is `REPEATABLE READ`, so every
 * statement below reads the records as they were when the first one ran: a
 * record the previous release moves meanwhile is settled where it was, and is
 * the next run's to settle.
 *
 * No row is updated twice where it shows a picture. A second update of a row
 * in one transaction makes PostgreSQL check its `og_image_id` against `media`
 * again, which would lock the picture after the SEO table — the opposite of a
 * media delete, which holds the picture and then clears the rows that show it,
 * and the two could wait on each other (D1³). So rows move once each, straight
 * to where they belong, in as many passes as it takes; only rows that hold one
 * another's addresses need a key on the way, and only a row with no picture is
 * moved through one. Then, type by type:
 *
 *   0. a row that is not bound but holds a key in one of the reserved forms —
 *      `#<id>` is a record's own row's, `~<n>` row n's, and only a hand-made
 *      request to the previous release's form can write one (A.9) — is set
 *      aside to its own `~<id>` once nothing holds that; rows that hold each
 *      other's are set aside under a key nobody can have written instead;
 *   1. a row bound to a record that no longer exists is set aside: its record
 *      is gone (the previous release deleted it and left the row);
 *   2. a record's own row at an old address, beside a row written by address
 *      at its present one — the previous release moved the record, then saved
 *      its SEO — is set aside: the newer row is the one in use;
 *   3. a row written by address at a record's present address is bound to it;
 *   4. a detached row at an address is set aside, so the address is free;
 *   5. a bound row at an address its record no longer has is moved to the
 *      present one as soon as that is free. Rows that hold each other's
 *      addresses — two records the previous release swapped — move through
 *      their record's own `#<id>`, those with no picture first; where every
 *      one of them shows a picture they stay at `#<id>`, bound and in use as
 *      before, and reach their address at the next run or their record's next
 *      save or move;
 *   6. any other row written by address names no record: it is set aside.
 *      The overviews' two keys are left alone.
 */
export async function reconcileSeoRows<S extends Record<string, unknown>>(
  db: PostgresJsDatabase<S>,
): Promise<SeoReconcileCounts> {
  // Step 0 sets a ring of hand-made keys aside under a key with this in it: one nobody can have posted.
  const nonce = globalThis.crypto.randomUUID();
  return db.transaction(
    async (tx) => {
      await tx.execute(sql`lock table seo_metadata in exclusive mode`);
      const counts: SeoReconcileCounts = { bound: 0, rekeyed: 0, setAside: 0, parked: 0 };
      const ids = async (statement: SQL) => (await tx.execute<{ id: number }>(statement)).map((row) => Number(row.id));
      /**
       * The same statement again until it changes nothing: each pass moves the
       * rows whose destination is free, which frees the next ones'. Every row
       * it changes, it changes once — the statement only matches a row that is
       * not where it belongs, and puts it there.
       */
      const passes = async (statement: () => SQL) => {
        const changed: number[] = [];
        for (;;) {
          const pass = await ids(statement());
          if (!pass.length) return changed;
          changed.push(...pass);
        }
      };

      for (const type of RECORD_ENTITY_TYPES) {
        const records = keyed(type);
        const all = sql`(${RECORDS[type]})`;
        /**
         * A row not bound to a record, holding a key in one of the reserved
         * forms that is not its own — nor the one a run gave it below
         * (`~<id>~<nonce>`), which is as out of use and as final as its own.
         */
        const handMade = sql`entity_type = ${type}
                             and (entity_id is null or (entity_id = 0 and entity_key not like '~' || id || '~%'))
                             and (entity_key like '#%' or entity_key like '~%') and entity_key <> '~' || id`;

        counts.setAside += (
          await passes(
            () => sql`
              update seo_metadata x set entity_id = 0, entity_key = '~' || x.id
               where ${handMade}
                 and not exists (select 1 from seo_metadata o where o.entity_type = ${type} and o.entity_key = '~' || x.id)
              returning x.id`,
          )
        ).length;
        // What is left holds the `~<id>` of another row left, all the way round:
        // set aside under a key nobody can have written, where it stays.
        counts.setAside += (
          await ids(sql`
            update seo_metadata set entity_id = 0, entity_key = '~' || id || '~' || ${nonce}
             where ${handMade}
            returning id`)
        ).length;

        counts.setAside += (
          await ids(sql`
            update seo_metadata s set entity_id = 0, entity_key = '~' || s.id
             where s.entity_type = ${type} and s.entity_id > 0
               and not exists (select 1 from ${all} r where r.id = s.entity_id)
            returning s.id`)
        ).length;

        counts.setAside += (
          await ids(sql`
            update seo_metadata b set entity_id = 0, entity_key = '~' || b.id
              from ${records} r
             where b.entity_type = ${type} and b.entity_id = r.id and b.entity_key <> r.k
               and exists (select 1 from seo_metadata u
                            where u.entity_type = ${type} and u.entity_id is null and u.entity_key = r.k)
            returning b.id`)
        ).length;

        counts.bound += (
          await ids(sql`
            update seo_metadata u set entity_id = r.id
              from ${records} r
             where u.entity_type = ${type} and u.entity_id is null and u.entity_key = r.k
            returning u.id`)
        ).length;

        // Step 0 left every detached row with a reserved key at its own `~<id>`,
        // or at the key it had to take instead; what is left is at an address.
        counts.setAside += (
          await ids(sql`
            update seo_metadata d set entity_key = '~' || d.id
             where d.entity_type = ${type} and d.entity_id = 0
               and d.entity_key not like '~%' and d.entity_key not like '#%'
            returning d.id`)
        ).length;

        /** A bound row moved to its record's present address, once nothing holds that. */
        const settle = () => sql`
          update seo_metadata s set entity_key = r.k
            from ${records} r
           where s.entity_type = ${type} and s.entity_id = r.id and s.entity_key <> r.k
             and not exists (select 1 from seo_metadata o where o.entity_type = ${type} and o.entity_key = r.k)
          returning s.id`;
        /** A bound row still not at its address — each holds another's — moved to its record's own key. */
        const park = (pictured: boolean) => sql`
          update seo_metadata s set entity_key = '#' || s.entity_id
            from ${records} r
           where s.entity_type = ${type} and s.entity_id = r.id
             and s.entity_key <> r.k and s.entity_key <> '#' || s.entity_id
             and s.og_image_id is ${pictured ? sql`not null` : sql`null`}
          returning s.id`;
        const moved = await passes(settle);
        // A ring: rows with no picture step aside to `#<id>`, so the rest move
        // once each, and then they move again — a second update with no picture
        // to check.
        const through = await ids(park(false));
        moved.push(...(await passes(settle)));
        // A ring every row of which shows a picture waits at `#<id>`, in use as
        // before, for the next run or its record's next save or move.
        const waiting = await ids(park(true));
        counts.rekeyed += new Set([...moved, ...through]).size;
        counts.parked += waiting.length;

        counts.setAside += (
          await ids(sql`
            update seo_metadata set entity_id = 0, entity_key = '~' || id
             where entity_type = ${type} and entity_id is null ${notOverview(type)}
            returning id`)
        ).length;
      }
      return counts;
    },
    { isolationLevel: "repeatable read" },
  );
}
