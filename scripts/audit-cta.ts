import "./env";

import { writeFileSync } from "node:fs";

import postgres from "postgres";

import {
  AUDITED_BLOCKS,
  auditSections,
  formatReport,
  type ComponentInput,
  type SectionInput,
  type VersionInput,
} from "./audit/cta";

/**
 * Read-only audit of the calls to action the pre-15b registry defect could
 * have dropped (`scripts/audit/cta.ts` says what and why).
 *
 *   npm run audit:cta                       the sections worth a look
 *   npm run audit:cta -- --all              every audited section
 *   npm run audit:cta -- --json report.json the whole result, for the review
 *
 * It connects with DATABASE_URL, like every other script here, and runs every
 * statement inside ONE `BEGIN READ ONLY` transaction: SELECT statements only,
 * and PostgreSQL itself refuses a write inside a read-only transaction, so the
 * guarantee does not rest on this file being written carefully. It works on a
 * database before or after this release's migrations — the tables a previous
 * release does not have (reusable components, page history) are skipped, not
 * created. It is meant for the production release gate, against production or
 * a restored copy of it, by an authorized person; nothing here decides what a
 * button should say.
 */

function option(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : (process.argv[index + 1] ?? "");
}

async function main(): Promise<number> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (see .env.example).");
    return 2;
  }
  const sql = postgres(url, { max: 1, onnotice: () => undefined });
  try {
    const { rows, where } = await sql.begin("read only", async (tx) => {
      const [info] = await tx<{ db: string; host: string | null; readonly: string }[]>`
        select current_database() as db, inet_server_addr()::text as host,
               current_setting('transaction_read_only') as readonly`;
      if (info?.readonly !== "on") throw new Error("the audit transaction is not read-only — refusing to continue");
      // What this database has: a previous release's schema lacks the
      // component and history tables and the draft-only column.
      const [present] = await tx<{ components: string | null; versions: string | null; draftOnly: boolean }[]>`
        select to_regclass('public.reusable_components')::text as components,
               to_regclass('public.page_versions')::text as versions,
               exists (select 1 from information_schema.columns
                        where table_schema = 'public' and table_name = 'page_sections'
                          and column_name = 'is_draft_only') as "draftOnly"`;
      const sections = await tx<SectionInput[]>`
        select s.id, s.page_id, p.slug, p.title_en as page_title, s.block_type, s.position,
               s.is_published,
               ${present?.draftOnly ? tx`s.is_draft_only` : tx`false`} as is_draft_only,
               s.published, s.draft
          from page_sections s
          join pages p on p.id = s.page_id
         where s.block_type = any(${[...AUDITED_BLOCKS]})
         order by p.id, s.position, s.id`;
      const components = present?.components
        ? await tx<ComponentInput[]>`select id, kind, status, published, published_version from reusable_components`
        : [];
      const pageIds = [...new Set(sections.map((section) => section.page_id))];
      const versions = present?.versions && pageIds.length
        ? await tx<VersionInput[]>`
            select id, page_id, created_at, snapshot from page_versions
             where page_id = any(${pageIds}) order by created_at desc, id desc`
        : [];
      return {
        rows: auditSections({ sections: [...sections], components: [...components], versions: [...versions] }),
        where: `${info?.db ?? "?"}${info?.host ? ` @ ${info.host}` : ""}`,
      };
    });

    console.log(`CTA audit — read-only — ${new Date().toISOString()} — database ${where}`);
    console.log(`Blocks: ${AUDITED_BLOCKS.join(", ")}\n`);
    console.log(formatReport(rows, { all: process.argv.includes("--all") }));
    const json = option("json");
    if (json) {
      writeFileSync(json, JSON.stringify({ generatedAt: new Date().toISOString(), database: where, rows }, null, 2));
      console.log(`\nJSON written to ${json}`);
    }
    console.log("\nNothing was written to the database: every statement ran in one read-only transaction.");
    return 0;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  },
);
