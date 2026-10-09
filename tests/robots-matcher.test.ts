/**
 * Batch 26 · the `robots.txt` reader the share-image test relies on
 * (`tests/helpers/robots.ts`): RFC 9309 as Google and X apply it. The
 * share-image verdict in `seo-metadata.test.ts` is only as good as this, so it
 * is held to the RFC's own examples and to the rules this site serves.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { decidingRule, parseRobots, robotsAllows } from "./helpers/robots";

const SITE = ["User-agent: *", "Allow: /", "Allow: /media/share/", "Disallow: /admin$", "Disallow: /admin?", "Disallow: /admin/", "Disallow: /api/", "Disallow: /media/*@*", "", "Sitemap: https://example.test/sitemap.xml"].join("\n");

describe("26 · robots.txt, read as RFC 9309 reads it", () => {
  test("the longest matching rule decides, whichever comes first", () => {
    const text = "User-agent: *\nDisallow: /media/\nAllow: /media/share/";
    assert.equal(robotsAllows(text, "Twitterbot", "/media/share/a.webp"), true);
    assert.equal(robotsAllows(text, "Twitterbot", "/media/a.webp"), false);
    const reversed = "User-agent: *\nAllow: /media/share/\nDisallow: /media/";
    assert.equal(robotsAllows(reversed, "Twitterbot", "/media/share/a.webp"), true);
  });

  test("an Allow wins a tie of equal length; a path no rule matches is allowed", () => {
    assert.equal(robotsAllows("User-agent: *\nDisallow: /page\nAllow: /page", "x", "/page"), true);
    assert.equal(robotsAllows("User-agent: *\nAllow: /page\nDisallow: /page", "x", "/page"), true);
    assert.equal(robotsAllows("User-agent: *\nDisallow: /private", "x", "/public"), true);
    assert.equal(decidingRule("User-agent: *\nDisallow: /private", "x", "/public"), null);
  });

  test("`*` stands for any run of characters and a final `$` anchors the end; anything else is a prefix", () => {
    const text = "User-agent: *\nDisallow: /*.pdf$\nDisallow: /media/*@*";
    assert.equal(robotsAllows(text, "x", "/files/a.pdf"), false);
    assert.equal(robotsAllows(text, "x", "/files/a.pdf?x=1"), true, "$ anchors the end");
    assert.equal(robotsAllows(text, "x", "/media/a@1600.webp"), false);
    assert.equal(robotsAllows(text, "x", "/media/a.webp"), true);
    assert.equal(robotsAllows("User-agent: *\nDisallow: /fish", "x", "/fish.html"), false, "a prefix");
    assert.equal(robotsAllows("User-agent: *\nDisallow: /fish", "x", "/Fish"), true, "paths are case-sensitive");
    // Characters that mean something to a regular expression mean nothing here.
    assert.equal(robotsAllows("User-agent: *\nDisallow: /a+b(c)", "x", "/a+b(c)/d"), false);
    assert.equal(robotsAllows("User-agent: *\nDisallow: /a+b(c)", "x", "/aab(c)"), true);
  });

  test("a crawler's own group replaces the `*` group; consecutive agent lines share one group; an empty Disallow forbids nothing", () => {
    const text = [
      "User-agent: *",
      "Disallow: /",
      "",
      "User-agent: Twitterbot",
      "User-agent: LinkedInBot",
      "Allow: /media/share/",
      "Disallow: /media/",
      "",
      "User-agent: Slackbot",
      "Disallow:",
    ].join("\n");
    assert.equal(parseRobots(text).length, 3);
    assert.equal(robotsAllows(text, "Twitterbot", "/media/share/a.webp"), true);
    assert.equal(robotsAllows(text, "linkedinbot", "/media/a.webp"), false, "matched without regard to case");
    assert.equal(robotsAllows(text, "Twitterbot", "/about"), true, "its own group says nothing about /about");
    assert.equal(robotsAllows(text, "Googlebot", "/about"), false, "the `*` group");
    assert.equal(robotsAllows(text, "Slackbot", "/anything"), true);
  });

  test("comments are ignored, and so is everything that is not a rule", () => {
    const text = "# a comment\nUser-agent: * # everyone\nDisallow: /admin # the back office\nCrawl-delay: 10\nSitemap: https://example.test/s.xml";
    assert.equal(robotsAllows(text, "x", "/admin/users"), false);
    assert.equal(robotsAllows(text, "x", "/about"), true);
  });

  test("the rules this site serves: a share image allowed, every other rendition kept out, originals as they were", () => {
    for (const agent of ["Twitterbot", "facebookexternalhit", "*"]) {
      assert.deepEqual(decidingRule(SITE, agent, "/media/share/hero.webp"), { allow: true, pattern: "/media/share/" });
      assert.equal(robotsAllows(SITE, agent, "/media/hero@1600.webp"), false);
      assert.equal(robotsAllows(SITE, agent, "/media/share/hero@1600.webp"), true, "the longer Allow wins over `/media/*@*`");
      assert.equal(robotsAllows(SITE, agent, "/media/hero.jpg"), true);
      assert.equal(robotsAllows(SITE, agent, "/admin"), false);
      assert.equal(robotsAllows(SITE, agent, "/admin?denied=1"), false, "where a refused permission lands");
      assert.equal(robotsAllows(SITE, agent, "/admin/seo"), false);
      assert.equal(robotsAllows(SITE, agent, "/administrative-services"), true, "a page whose address only begins like the admin's");
      assert.equal(robotsAllows(SITE, agent, "/api/enquiries"), false);
    }
  });
});
