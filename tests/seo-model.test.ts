/**
 * Batch 25 · the SEO model itself — the rules every reader shares, without a
 * server (docs/admin/seo-and-share-images.md Part B).
 *
 * `lib/seo-model.ts` is deliberately free of `server-only` (`scripts/migrate.ts`
 * binds rows with it), so its rules are read here directly: what a reference
 * may name, which stored row a target uses, which text a page shows in each
 * language, and which canonical addresses a record may hold.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  canonicalOverride,
  canonicalProblem,
  indexSeoRows,
  overviewStorage,
  parseSeoRef,
  recordStorage,
  seoRefOf,
  seoRowFor,
  shareTextFor,
  storedCanonical,
  storedKeyOf,
  textFor,
} from "@/lib/seo-model";

const SITE = "https://eliteonedesk.com";

describe("25 · a reference names a kind and an id, never an address", () => {
  test("every kind parses; the singletons only as :1", () => {
    for (const ref of ["site:1", "page:3", "serviceIndex:1", "packageIndex:1", "category:2", "service:41", "package:7", "destination:1"]) {
      const parsed = parseSeoRef(ref);
      assert.ok(parsed, ref);
      assert.equal(seoRefOf(parsed), ref);
    }
    for (const bad of ["serviceIndex:2", "packageIndex:0", "site:2"]) assert.equal(parseSeoRef(bad), null, bad);
  });

  test("anything else is refused — ids, shapes, addresses, injection", () => {
    for (const bad of [
      "",
      "page:0",
      "page:01",
      "page:-1",
      "page:1x",
      "page:1.5",
      "page:1234567890",
      "page:about",
      "destination:egypt",
      "video:1",
      "Page:1",
      " page:1",
      "page:1 ",
      "page:1;drop table seo_metadata",
      "category:1/service:2",
      undefined,
      null,
      42,
    ]) {
      assert.equal(parseSeoRef(bad), null, String(bad));
    }
  });
});

describe("25 · which stored row a target uses (B.2)", () => {
  const row = (entityType: string, entityKey: string, entityId: number | null, title: string) => ({ entityType, entityKey, entityId, title });

  test("a bound row follows its record wherever its address goes", () => {
    const index = indexSeoRows([row("destination", "old-address", 3, "bound")]);
    assert.equal(seoRowFor(index, recordStorage("destination", "new-address", 3))?.title, "bound");
  });

  test("an unbound row at the present address is used while the record has no bound row — as the previous release used it", () => {
    const index = indexSeoRows([row("category", "visas", null, "legacy")]);
    assert.equal(seoRowFor(index, recordStorage("category", "visas", 9))?.title, "legacy");
    assert.equal(seoRowFor(index, recordStorage("category", "other", 9)), null);
  });

  test("the bound row wins over an unbound one; a detached row is never used", () => {
    const index = indexSeoRows([
      row("service", "travel/visa", 5, "bound"),
      row("service", "business/visa", null, "unbound twin"),
      row("service", "gone/thing", 0, "detached"),
    ]);
    assert.equal(seoRowFor(index, recordStorage("service", "business/visa", 5))?.title, "bound");
    assert.equal(seoRowFor(index, recordStorage("service", "gone/thing", 77)), null, "a detached row at an address is not inherited");
  });

  test("a row bound to another record is never used by the record now at its address", () => {
    const index = indexSeoRows([row("destination", "egypt", 3, "destination 3")]);
    assert.equal(seoRowFor(index, recordStorage("destination", "egypt", 9)), null);
  });

  test("types never cross: a destination and a package can share /packages/<slug> and never each other's record", () => {
    const index = indexSeoRows([row("destination", "nile", 1, "destination"), row("package", "nile", null, "package")]);
    assert.equal(seoRowFor(index, recordStorage("destination", "nile", 1))?.title, "destination");
    assert.equal(seoRowFor(index, recordStorage("package", "nile", 2))?.title, "package");
  });

  test("the overviews are fixed keys, never bound", () => {
    assert.deepEqual(overviewStorage("serviceIndex"), { entityType: "page", entityKey: "services", entityId: null });
    assert.deepEqual(overviewStorage("packageIndex"), { entityType: "page", entityKey: "packages", entityId: null });
    const index = indexSeoRows([row("page", "services", null, "services overview")]);
    assert.equal(seoRowFor(index, overviewStorage("serviceIndex"))?.title, "services overview");
    assert.equal(seoRowFor(index, overviewStorage("packageIndex")), null);
  });

  test("an address too long for the key column is keyed by id, and found by id", () => {
    const long = `${"c".repeat(120)}/${"s".repeat(120)}`;
    assert.equal(storedKeyOf(long, 12), "#12");
    assert.equal(storedKeyOf("travel/visa", 12), "travel/visa");
    const index = indexSeoRows([row("service", "#12", 12, "long")]);
    assert.equal(seoRowFor(index, recordStorage("service", long, 12))?.title, "long");
  });
});

describe("25 · each language on its own (B.4, brief §10)", () => {
  const fallback = { en: "Default EN", ar: "افتراضي" };

  test("English: the record, then the page's own, then the default", () => {
    assert.equal(textFor("en", { en: "SEO EN", ar: "" }, { en: "Own EN", ar: "خاص" }, fallback).text, "SEO EN");
    assert.equal(textFor("en", { en: "", ar: "SEO AR" }, { en: "Own EN", ar: "خاص" }, fallback).text, "Own EN");
    assert.equal(textFor("en", null, { en: "", ar: "خاص" }, fallback).text, "Default EN");
  });

  test("an empty Arabic record follows the page's own Arabic — never the English record", () => {
    const chosen = textFor("ar", { en: "SEO EN", ar: "" }, { en: "Own EN", ar: "خاص" }, fallback);
    assert.deepEqual(chosen, { text: "خاص", arabic: true });
  });

  test("an Arabic record wins in Arabic", () => {
    assert.deepEqual(textFor("ar", { en: "SEO EN", ar: "SEO عربي" }, { en: "Own EN", ar: "خاص" }, fallback), {
      text: "SEO عربي",
      arabic: true,
    });
  });

  test("where the page has no Arabic at all, the English record beats raw English content", () => {
    assert.deepEqual(textFor("ar", { en: "SEO EN", ar: "" }, { en: "Own EN", ar: "" }, fallback), { text: "SEO EN", arabic: false });
    assert.deepEqual(textFor("ar", null, { en: "Own EN", ar: "" }, fallback), { text: "Own EN", arabic: false });
  });

  test("with nothing of its own the Arabic page takes the Arabic default, then the English one", () => {
    assert.deepEqual(textFor("ar", null, null, fallback), { text: "افتراضي", arabic: true });
    assert.deepEqual(textFor("ar", null, null, { en: "Default EN", ar: "" }), { text: "Default EN", arabic: false });
  });

  test("whitespace is nothing", () => {
    assert.equal(textFor("ar", { en: "SEO EN", ar: "   " }, { en: "", ar: " \n" }, fallback).text, "SEO EN");
  });

  test("share text: the record's own in that language, else what the page shows — English share text only where the page shows English", () => {
    assert.equal(shareTextFor("en", { en: "Share EN", ar: "مشاركة" }, { text: "Title", arabic: false }), "Share EN");
    assert.equal(shareTextFor("en", { en: "", ar: "مشاركة" }, { text: "Title", arabic: false }), "Title");
    assert.equal(shareTextFor("ar", { en: "Share EN", ar: "مشاركة" }, { text: "عنوان", arabic: true }), "مشاركة");
    assert.equal(shareTextFor("ar", { en: "Share EN", ar: "" }, { text: "عنوان", arabic: true }), "عنوان", "never the English share text over Arabic");
    assert.equal(shareTextFor("ar", { en: "Share EN", ar: "" }, { text: "Title", arabic: false }), "Share EN");
    assert.equal(shareTextFor("ar", null, { text: "عنوان", arabic: true }), "عنوان");
  });
});

describe("25 · canonical addresses (B.15, brief §16)", () => {
  test("a page of this site is accepted, as a path or as a full address on the site's own origin", () => {
    for (const ok of ["/about", "/", "/services/visas", "/packages/egypt", "/ar/about", `${SITE}/about`, `${SITE}/ar/packages/egypt`]) {
      assert.equal(canonicalProblem(ok, SITE), null, ok);
    }
    assert.equal(canonicalProblem("", SITE), null, "empty means none");
  });

  test("nothing that carries state, leaves the site or names something that is not a page", () => {
    for (const bad of [
      "/about?preview=1",
      "/about?compare=published",
      "/about#team",
      "//evil.example/about",
      "https://evil.example/about",
      "http://eliteonedesk.com/about",
      "https://user:pass@eliteonedesk.com/about",
      "javascript:alert(1)",
      "data:text/html,x",
      "/about page",
      "/about\nX-Injected: 1",
      "/../admin",
      "/./about",
      "/admin",
      "/admin/seo",
      "/api/enquiries",
      "/_next/static/x.js",
      "/media/photo.webp",
      "/search",
      "/home",
      "/ar/admin",
      "/en/api/x",
      "/%61dmin",
      "/ar/%61pi/x",
      `${SITE}/ar/admin`,
      `${SITE}/search`,
      "/%zz",
      "about",
      `/${"a".repeat(260)}`,
    ]) {
      assert.ok(canonicalProblem(bad, SITE), `accepted ${JSON.stringify(bad)}`);
    }
  });

  test("stored language-neutral: a prefix or this site's origin is dropped", () => {
    assert.equal(storedCanonical("/ar/about", SITE), "/about");
    assert.equal(storedCanonical("/en/about", SITE), "/about");
    assert.equal(storedCanonical(`${SITE}/ar/packages/egypt`, SITE), "/packages/egypt");
    assert.equal(storedCanonical("/ar", SITE), "/");
    assert.equal(storedCanonical("  /about  ", SITE), "/about");
    assert.equal(storedCanonical("/about?x=1", SITE), "/about?x=1", "a refused value is kept for the refusal to name");
  });

  test("drawn in the language being rendered — never one edition's address on the other's page", () => {
    assert.equal(canonicalOverride("/about", "en", SITE), `${SITE}/about`);
    assert.equal(canonicalOverride("/about", "ar", SITE), `${SITE}/ar/about`);
    assert.equal(canonicalOverride("/", "ar", SITE), `${SITE}/ar`);
    assert.equal(canonicalOverride("/ar/about", "en", SITE), `${SITE}/about`);
    assert.equal(canonicalOverride(`${SITE}/about`, "ar", SITE), `${SITE}/ar/about`);
  });

  test("a value stored before Batch 25 that would be refused today is ignored, not emitted", () => {
    assert.equal(canonicalOverride("https://other.example/x", "en", SITE), null);
    assert.equal(canonicalOverride("/about?preview=1", "en", SITE), null);
    assert.equal(canonicalOverride("//host/x", "en", SITE), null);
    assert.equal(canonicalOverride("/ar/admin", "ar", SITE), null);
    assert.equal(canonicalOverride("", "en", SITE), null);
  });
});
