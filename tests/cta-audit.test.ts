/**
 * The read-only CTA audit (Batch 19A) — what it finds, and that it writes
 * nothing.
 *
 * The classification is tested on hand-made rows: each case is one way the
 * pre-15b registry defect (`CtaLabel`/`CtaHref` declared, `ctaLabel`/`ctaHref`
 * stored and drawn) can have left a section, or one way a section can look
 * wrong without being lost. The command itself is run against real databases —
 * this release's schema, the release in production's, and one from before the
 * Visual Editor — and the whole database is fingerprinted before and after,
 * table by table and sequence by sequence.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { REPO_ROOT, dbUrl, scriptEnv, uniqueName } from "./helpers/env";
import { WORK, compatTree, giveFresh, removeWorktree, worktreeAt } from "./helpers/fixtures";
import { connect, dropDatabase, recreateDatabase, type Sql } from "./helpers/pg";
import { runScript } from "./helpers/run";

import { auditSections, formatReport, storedCta, type SectionInput } from "../scripts/audit/cta";

type Values = Record<string, unknown>;

/**
 * Production before Batch 20, kept on the server as a historical rollback: a
 * schema without the component and history tables or the draft-only column,
 * which the audit has to skip. Pinned, because `deploy/previous-release` now
 * names a release that has all three (Batch 26, Correction 1).
 */
const BEFORE_THE_EDITOR = "b807663610982d32d84301852fff77fd7f36f9e8";

const section = (id: number, blockType: string, published: Values | null, extra: Partial<SectionInput> = {}): SectionInput => ({
  id,
  page_id: extra.page_id ?? 1,
  slug: extra.slug ?? "about",
  page_title: "About",
  block_type: blockType,
  position: extra.position ?? id,
  is_published: extra.is_published ?? true,
  is_draft_only: false,
  published,
  draft: extra.draft ?? null,
});
const cta = (en: string, ar: string, href: string) => ({ ctaLabel: { en, ar }, ctaHref: href });
const codes = (row: { findings: { code: string }[] }) => row.findings.map((finding) => finding.code).sort();
const audit = (sections: SectionInput[], extra: { components?: Parameters<typeof auditSections>[0]["components"]; versions?: Parameters<typeof auditSections>[0]["versions"] } = {}) =>
  auditSections({ sections, components: extra.components ?? [], versions: extra.versions ?? [] });

describe("what the audit classifies — no database", () => {
  test("a complete button is ok; an empty Arabic label is a review item, not a defect", () => {
    const [complete, englishOnly] = audit([
      section(1, "image-text", { title: { en: "t", ar: "" }, ...cta("See our services", "اطّلع على خدماتنا", "/services") }),
      section(2, "one-desk", cta("About us", "", "/about")),
    ]);
    assert.equal(complete!.worst, "ok");
    assert.equal(complete!.shown.buttonEn && complete!.shown.buttonAr, true);
    assert.deepEqual(codes(englishOnly!), ["arabic-falls-back"]);
    assert.equal(englishOnly!.worst, "review");
  });

  test("the defect's signature: legacy keys, the real keys gone, what was typed shown as never displayed", () => {
    const [row] = audit([section(3, "featured-service", { title: { en: "x", ar: "" }, CtaLabel: { en: "Book a call", ar: "" }, CtaHref: "/contact" })]);
    assert.equal(row!.published.hasLabelKey, false);
    assert.equal(row!.published.hasHrefKey, false);
    assert.deepEqual(row!.published.legacy, { present: true, labelEn: "Book a call", labelAr: "", href: "/contact" });
    assert.deepEqual(codes(row!), ["legacy-keys", "no-button-with-evidence"]);
    assert.equal(row!.worst, "suspect");
    assert.equal(row!.shown.buttonEn || row!.shown.buttonAr, false, "legacy text is evidence, never a value the page draws");
    assert.match(formatReport([row!]), /never displayed/);
  });

  test("half a button — a label without a link, or a link without a label — draws nothing and is suspect", () => {
    const rows = audit([
      section(4, "travel-feature", cta("Plan a trip", "خطط لرحلة", "")),
      section(5, "image-text", cta("", "", "/services")),
    ]);
    for (const row of rows) {
      assert.deepEqual(codes(row), ["button-hidden"]);
      assert.equal(row.shown.buttonEn || row.shown.buttonAr, false);
    }
  });

  test("no button and no evidence is a question, not a finding of loss — and the seed reference is only a reference", () => {
    const [row] = audit([section(6, "one-desk", { title: { en: "x", ar: "" } }, { slug: "home", page_id: 2 })]);
    assert.deepEqual(codes(row!), ["no-button"]);
    assert.equal(row!.worst, "review");
    assert.ok(row!.seedReference, "the home page seeds a one-desk button");
    assert.equal(row!.shown.buttonEn || row!.shown.buttonAr, false, "the seed reference is never drawn or proposed as a value");
    assert.match(formatReport([row!]), /reference only — not a proposed value/);
  });

  test("history is evidence: an earlier published value turns a missing button into suspected loss", () => {
    const [row] = audit([section(7, "image-text", { title: { en: "x", ar: "" } })], {
      versions: [
        { id: 11, page_id: 1, created_at: "2026-09-01T10:00:00Z", snapshot: { v: 1, sections: [{ sourceSectionId: 7, blockType: "image-text", published: cta("Our services", "", "/services") }] } },
        { id: 12, page_id: 1, created_at: "2026-09-02T10:00:00Z", snapshot: { v: 1, sections: [{ sourceSectionId: 99, blockType: "image-text", published: cta("Someone else", "", "/x") }] } },
      ],
    });
    assert.deepEqual(codes(row!), ["differs-from-history", "no-button-with-evidence"]);
    assert.deepEqual(row!.history.map((entry) => entry.versionId), [11], "only this section's own versions count");
  });

  test("a linked component supplies what visitors see; the stored fallback is reported beside it", () => {
    const linked = { ...cta("Old words", "", "/old"), _reuse: { cta: { c: 5 } } };
    const overridden = { ...cta("Old words", "", "/mine"), _reuse: { cta: { c: 5, o: ["ctaHref"] } } };
    const components = [{ id: 5, kind: "cta", status: "active", published: { label: { en: "Talk to us", ar: "تحدث إلينا" }, href: "/contact" }, published_version: 3 }];
    const [plain, own] = audit([section(8, "image-text", linked), section(9, "image-text", overridden)], { components });
    assert.deepEqual({ en: plain!.shown.labelEn, href: plain!.shown.href }, { en: "Talk to us", href: "/contact" });
    assert.deepEqual(codes(plain!), ["shown-differs-from-fallback"]);
    assert.equal(own!.shown.href, "/mine", "an overridden key is the page's own");
    assert.equal(own!.links[0]!.overrides.join(), "ctaHref");
  });

  test("an unavailable component draws the fallback and is suspect", () => {
    const [row] = audit([section(10, "image-text", { ...cta("Fallback", "", "/f"), _reuse: { cta: { c: 77 } } })]);
    assert.ok(codes(row!).includes("link-unavailable"));
    assert.equal(row!.shown.labelEn, "Fallback");
  });

  test("a pending draft that would remove the button is suspect; any other change is noted", () => {
    const [hides, changes] = audit([
      section(12, "one-desk", cta("A", "أ", "/a"), { draft: cta("", "", "") }),
      section(13, "one-desk", cta("A", "أ", "/a"), { draft: cta("B", "ب", "/b") }),
    ]);
    assert.ok(codes(hides!).includes("draft-hides-button"));
    assert.equal(hides!.worst, "suspect");
    assert.deepEqual(codes(changes!), ["draft-changes-cta"]);
  });

  test("an English label missing while the Arabic is set is suspect: English pages draw no button", () => {
    const [row] = audit([section(14, "travel-feature", cta("", "اكتشف", "/travel"))]);
    assert.deepEqual(codes(row!), ["english-missing"]);
    assert.deepEqual([row!.shown.buttonEn, row!.shown.buttonAr], [false, true]);
  });

  test("storedCta reads exactly the stored keys, and nothing else", () => {
    assert.deepEqual(storedCta({ ctaLabel: { en: " Go ", ar: "" }, ctaHref: "/go", primaryCtaLabel: { en: "not me", ar: "" } }), {
      labelEn: "Go",
      labelAr: "",
      href: "/go",
      hasLabelKey: true,
      hasHrefKey: true,
      legacy: null,
    });
  });
});

describe("the command writes nothing — real databases, whole-database fingerprints", () => {
  let fresh = "";
  const others: string[] = [];
  let sql: Sql;
  let work = "";

  /** Every table's rows and every sequence's position, as one string. */
  async function fingerprint(db: Sql): Promise<string> {
    const tables = await db<{ name: string }[]>`
      select quote_ident(table_name) as name from information_schema.tables
       where table_schema = 'public' and table_type = 'BASE TABLE' order by table_name`;
    const parts: string[] = [];
    for (const { name } of tables) {
      const [row] = await db.unsafe<{ n: string; h: string | null }[]>(
        `select count(*)::text as n, md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h from ${name} t`,
      );
      parts.push(`${name}:${row!.n}:${row!.h}`);
    }
    const sequences = await db<{ name: string; last: string | null }[]>`
      select sequencename as name, last_value::text as last from pg_sequences where schemaname = 'public' order by sequencename`;
    for (const sequence of sequences) parts.push(`seq ${sequence.name}:${sequence.last}`);
    return parts.join("\n");
  }

  before(async () => {
    work = mkdtempSync(path.join(tmpdir(), "eod-cta-audit-"));
    fresh = giveFresh("cta_audit");
    sql = connect(fresh);
    // The defect, reproduced by hand on the seeded About image-text section:
    // the real keys gone and the misnamed form's text left behind.
    const [target] = await sql<{ id: number; published: Values }[]>`
      select s.id, s.published from page_sections s join pages p on p.id = s.page_id
       where p.slug = 'about' and s.block_type = 'image-text' order by s.position limit 1`;
    assert.ok(target, "the fixture has an About image-text section");
    const damaged = { ...target.published, CtaLabel: { en: "Typed into the wrong box", ar: "" }, CtaHref: "" };
    delete (damaged as Values).ctaLabel;
    delete (damaged as Values).ctaHref;
    await sql`update page_sections set published = ${sql.json(damaged as never)} where id = ${target.id}`;
  });

  after(async () => {
    await sql?.end({ timeout: 5 });
    if (fresh) dropDatabase(fresh);
    for (const name of others) dropDatabase(name);
    if (work) rmSync(work, { recursive: true, force: true });
  });

  test("on this release's schema: the damaged section is found, and not one row, table or sequence changes", async () => {
    const json = path.join(work, "fresh.json");
    const beforeAudit = await fingerprint(sql);
    const result = runScript("scripts/audit-cta.ts", fresh, ["--json", json, "--all"]);
    assert.equal(result.code, 0, result.output);
    assert.equal(await fingerprint(sql), beforeAudit, "the audit changed the database");
    assert.match(result.stdout, /one read-only transaction/);
    const report = JSON.parse(readFileSync(json, "utf8")) as { rows: { blockType: string; slug: string; findings: { code: string }[]; published: { legacy: unknown } }[] };
    const damaged = report.rows.find((row) => row.slug === "about" && row.blockType === "image-text");
    assert.ok(damaged, "the About image-text section is audited");
    assert.ok(damaged.findings.some((finding) => finding.code === "legacy-keys"), JSON.stringify(damaged.findings));
    assert.ok(damaged.findings.some((finding) => finding.code === "no-button-with-evidence"));
    // Every seeded section of the four types is audited.
    const [{ n }] = await sql<{ n: number }[]>`
      select count(*)::int as n from page_sections
       where block_type in ('one-desk', 'featured-service', 'travel-feature', 'image-text')`;
    assert.equal(report.rows.length, n);
  });

  /** What the audit looks for before it reads: the component and history tables and the draft-only column. */
  async function shapeOf(db: Sql) {
    const [shape] = await db<{ components: string | null; versions: string | null; draftOnly: boolean }[]>`
      select to_regclass('public.reusable_components')::text as components,
             to_regclass('public.page_versions')::text as versions,
             exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = 'page_sections'
                        and column_name = 'is_draft_only') as "draftOnly"`;
    return shape;
  }

  /** A release's own migrate and seed, from its own checkout; then the audit over it, which must write nothing. */
  async function auditOwnSchema(tree: string, label: string, shape: Awaited<ReturnType<typeof shapeOf>>) {
    const database = uniqueName(label);
    recreateDatabase(database);
    others.push(database);
    for (const script of ["scripts/migrate.ts", "scripts/seed.ts"]) {
      const made = spawnSync("npx", ["tsx", script], { cwd: tree, encoding: "utf8", env: scriptEnv(dbUrl(database)), maxBuffer: 32 * 1024 * 1024 });
      assert.equal(made.status, 0, `that release's ${script} failed: ${made.stderr || made.stdout}`);
    }
    const db = connect(database);
    try {
      assert.deepEqual(await shapeOf(db), shape, "that release's schema is not the shape this case is about");
      const beforeAudit = await fingerprint(db);
      const json = path.join(work, `${label}.json`);
      const result = runScript("scripts/audit-cta.ts", database, ["--json", json]);
      assert.equal(result.code, 0, result.output);
      assert.equal(await fingerprint(db), beforeAudit, "the audit changed that release's database");
      const report = JSON.parse(readFileSync(json, "utf8")) as { rows: unknown[] };
      assert.ok(report.rows.length > 0, "that release's seeded sections are audited");
    } finally {
      await db.end({ timeout: 5 });
    }
  }

  test("on the release in production's own schema (`deploy/previous-release`): it reads everything there is, and writes nothing", async () => {
    await auditOwnSchema(compatTree(), "cta_audit_prev", { components: "reusable_components", versions: "page_versions", draftOnly: true });
  });

  test("on a schema from before the Visual Editor (b807663): it runs, skips what is not there, writes nothing", async () => {
    const dir = path.join(WORK, `cta-before-editor-${process.pid}`);
    try {
      await auditOwnSchema(worktreeAt(BEFORE_THE_EDITOR, dir), "cta_audit_old", { components: null, versions: null, draftOnly: false });
    } finally {
      removeWorktree(dir);
    }
  });

  test("the source can only read: one read-only transaction, and no statement that writes", () => {
    const cli = readFileSync(path.join(REPO_ROOT, "scripts", "audit-cta.ts"), "utf8");
    const analysis = readFileSync(path.join(REPO_ROOT, "scripts", "audit", "cta.ts"), "utf8");
    assert.match(cli, /sql\.begin\("read only"/);
    assert.match(cli, /current_setting\('transaction_read_only'\)/);
    for (const text of [cli, analysis]) {
      assert.doesNotMatch(text, /\b(insert\s+into|update\s+\w+\s+set|delete\s+from|truncate|alter\s+table|drop\s+(table|database)|create\s+(table|database))\b/i);
    }
  });
});
