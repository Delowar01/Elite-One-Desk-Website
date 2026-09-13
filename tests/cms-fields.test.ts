/**
 * The controlled field types, the link→image resolver and the social registry.
 *
 * No database and no server: these are the pure decisions the panel and the
 * renderers are built on, and the point of testing them here is that a
 * regression shows up in milliseconds rather than as a wrong picture on a page
 * somebody happens to look at.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { getBlock } from "@/lib/cms/blocks";
import { validateBlockValues } from "@/lib/cms/validate";
import { itemMediaId, items } from "@/lib/cms/values";
import { imageForHref, type LinkCatalogue } from "@/lib/link-image";
import {
  SOCIAL_PLATFORMS,
  allowsMultiple,
  isGenericLink,
  isSocialPlatform,
  normalizeSocialPlatformKey,
  socialLabel,
  socialPlatform,
} from "@/lib/social";

const QUICK_LINKS = getBlock("quick-links")!;
const LINK_FIELDS = QUICK_LINKS.fields.find((field) => field.name === "links")!.itemFields!;

/** One row through the panel's save path and back out the renderer's. */
function roundTrip(row: Record<string, unknown>) {
  const stored = validateBlockValues(QUICK_LINKS, { links: [row] }) as {
    links: Record<string, unknown>[];
  };
  const read = items(stored, "links", "en", LINK_FIELDS);
  return { stored: stored.links[0]!, read: read[0] };
}

describe("a repeatable row can hold an icon and an image", () => {
  test("the block declares both, so the form and the validator agree", () => {
    const byName = new Map(LINK_FIELDS.map((field) => [field.name, field]));
    assert.equal(byName.get("icon")?.type, "icon");
    assert.equal(byName.get("image")?.type, "media");
    assert.equal(byName.get("label")?.localised, true);
  });

  test("a key in the icon set survives", () => {
    const { stored, read } = roundTrip({ label: { en: "Plan a Trip" }, icon: "plane" });
    assert.equal(stored.icon, "plane");
    assert.equal(read!.icon, "plane");
  });

  test("a key that is not in the set is stored as nothing, not as a broken name", () => {
    // `id-card` is the mistake the old free-text field invited; the glyph is
    // `idCard`, and the page used to silently render the unknown-icon fallback.
    for (const bad of ["id-card", "IDCARD", "<svg onload=1>", "plane;rm -rf", "  "]) {
      const { stored } = roundTrip({ label: { en: "x" }, icon: bad });
      assert.equal(stored.icon, "", `${bad} should not be stored`);
    }
  });

  test("stray whitespace around a real key is forgiven, not rejected", () => {
    assert.equal(roundTrip({ label: { en: "x" }, icon: " sparkle " }).stored.icon, "sparkle");
  });

  test("a media id survives, a numeric string is normalised, junk becomes null", () => {
    assert.equal(roundTrip({ label: { en: "a" }, image: 7 }).stored.image, 7);
    assert.equal(roundTrip({ label: { en: "a" }, image: "12" }).stored.image, 12);
    for (const junk of [{ nope: true }, "abc", -3, 0, null, undefined, []]) {
      assert.equal(
        roundTrip({ label: { en: "a" }, image: junk }).stored.image,
        null,
        `${JSON.stringify(junk)} is not an image`,
      );
    }
  });

  test("the renderer reads a stored id back as a number", () => {
    const { read } = roundTrip({ label: { en: "a" }, image: 7 });
    assert.equal(itemMediaId(read!, "image"), 7);
    assert.equal(itemMediaId(roundTrip({ label: { en: "a" } }).read!, "image"), null);
  });

  test("a dangerous href is still sanitised", () => {
    for (const href of ["javascript:alert(1)", "data:text/html,<script>", " vbscript:x"]) {
      assert.equal(roundTrip({ label: { en: "a" }, href }).stored.href, "", href);
    }
    assert.equal(
      roundTrip({ label: { en: "a" }, href: "/services/travel-tourism" }).stored.href,
      "/services/travel-tourism",
    );
  });

  test("the localised label still falls back to English when Arabic is empty", () => {
    const stored = validateBlockValues(QUICK_LINKS, {
      links: [{ label: { en: "Plan a Trip", ar: "" }, href: "/services" }],
    });
    assert.deepEqual(items(stored, "links", "ar", LINK_FIELDS)[0]!.label, "Plan a Trip");
    const both = validateBlockValues(QUICK_LINKS, {
      links: [{ label: { en: "Plan a Trip", ar: "خطّط لرحلة" }, href: "/services" }],
    });
    assert.equal(items(both, "links", "ar", LINK_FIELDS)[0]!.label, "خطّط لرحلة");
    assert.equal(items(both, "links", "en", LINK_FIELDS)[0]!.label, "Plan a Trip");
  });
});

describe("a card's picture is resolved from where the link goes", () => {
  const catalogue: LinkCatalogue = {
    categories: [
      { id: 1, slug: "travel-tourism", imageId: 11 },
      { id: 2, slug: "business-setup", imageId: 22 },
      { id: 3, slug: "no-picture", imageId: null },
    ],
    services: [
      { slug: "schengen-visa-assistance", categoryId: 1, imageId: 101 },
      { slug: "air-ticket-booking", categoryId: 1, imageId: null },
      // Same slug in another category: service slugs are unique per category,
      // not site-wide, so the lookup has to be scoped.
      { slug: "air-ticket-booking", categoryId: 2, imageId: 202 },
    ],
    destinations: [{ slug: "egypt", imageId: 33 }],
    packages: [
      { slug: "cairo-and-giza-classic", imageId: 44 },
      // A package whose slug matches a destination must lose to it, because
      // that is the order the public route resolves them in.
      { slug: "egypt", imageId: 99 },
    ],
  };

  test("a category link wears the category's picture", () => {
    assert.equal(imageForHref("/services/travel-tourism", catalogue), 11);
  });

  test("a service link wears the service's own picture", () => {
    assert.equal(imageForHref("/services/travel-tourism/schengen-visa-assistance", catalogue), 101);
  });

  test("a service with no picture falls back to its category", () => {
    assert.equal(imageForHref("/services/travel-tourism/air-ticket-booking", catalogue), 11);
    assert.equal(imageForHref("/services/business-setup/air-ticket-booking", catalogue), 202);
  });

  test("a language prefix is not a different page", () => {
    assert.equal(imageForHref("/ar/services/travel-tourism", catalogue), 11);
    assert.equal(imageForHref("/en/services/travel-tourism", catalogue), 11);
  });

  test("a query string or a fragment is not a different page", () => {
    assert.equal(imageForHref("/services/business-setup#company-formation", catalogue), 22);
    assert.equal(imageForHref("/services/business-setup?from=home", catalogue), 22);
    assert.equal(imageForHref("/ar/services/business-setup?a=1#b", catalogue), 22);
  });

  test("a destination resolves before a package that shares its slug", () => {
    assert.equal(imageForHref("/packages/egypt", catalogue), 33);
    assert.equal(imageForHref("/packages/cairo-and-giza-classic", catalogue), 44);
  });

  test("anything else resolves to nothing, and the card falls back", () => {
    for (const href of [
      "/services/does-not-exist",
      "/services/no-picture",
      "/contact",
      "/services",
      "/packages",
      "https://example.com",
      "mailto:hello@example.com",
      "",
    ]) {
      const resolved = imageForHref(href, catalogue);
      assert.ok(resolved === null, `${href || "(empty)"} should resolve to null, got ${resolved}`);
    }
  });
});

describe("the social registry", () => {
  const REQUIRED = [
    "facebook",
    "instagram",
    "linkedin",
    "x",
    "youtube",
    "tiktok",
    "snapchat",
    "whatsapp",
    "telegram",
    "threads",
    "pinterest",
    "website",
  ];

  test("every platform an admin must be able to choose is on it", () => {
    const keys = SOCIAL_PLATFORMS.map((platform) => platform.key);
    for (const key of REQUIRED) assert.ok(keys.includes(key), `${key} should be selectable`);
    assert.equal(keys.length, REQUIRED.length, "no extras, no gaps");
    assert.equal(new Set(keys).size, keys.length, "keys are unique");
  });

  test("every entry can actually be drawn and labelled", () => {
    for (const platform of SOCIAL_PLATFORMS) {
      assert.match(platform.path, /^M/, `${platform.key} needs path data`);
      assert.ok(platform.label.length > 0);
      assert.match(platform.urlHint, /^https:\/\//, `${platform.key} needs an https example`);
    }
  });

  test("twitter is X — mark, label and identity", () => {
    assert.equal(normalizeSocialPlatformKey("twitter"), "x");
    assert.equal(socialLabel("twitter"), "X");
    assert.equal(socialPlatform("twitter")?.key, "x");
    assert.equal(socialPlatform("twitter")?.path, socialPlatform("x")?.path);
    assert.ok(isSocialPlatform("twitter"));
  });

  test("casing and whitespace do not make a second platform", () => {
    for (const spelling of ["X", " x ", "Twitter", " TWITTER ", "twitter_x", "Twitter-X"]) {
      assert.equal(normalizeSocialPlatformKey(spelling), "x", spelling);
    }
    assert.equal(normalizeSocialPlatformKey(" LinkedIn "), "linkedin");
    assert.equal(normalizeSocialPlatformKey("linked in"), "linkedin");
  });

  test("a key the registry has never known stays readable and is not claimed", () => {
    assert.equal(normalizeSocialPlatformKey("Myspace"), "myspace");
    assert.equal(socialPlatform("myspace"), null);
    assert.equal(socialLabel("myspace"), "Myspace");
    assert.equal(isSocialPlatform("myspace"), false);
    assert.equal(isGenericLink("myspace"), false);
    // Empty is not a platform, and must not read as one.
    assert.equal(socialPlatform(""), null);
    assert.equal(socialPlatform(null), null);
    assert.equal(socialLabel(null), "Link");
  });

  test("only Other / Website may repeat, and only it is left out of sameAs", () => {
    assert.ok(isGenericLink("website"));
    assert.ok(allowsMultiple("website"));
    for (const key of REQUIRED.filter((k) => k !== "website")) {
      assert.equal(isGenericLink(key), false, `${key} is an account, not an address`);
    }
  });
});
