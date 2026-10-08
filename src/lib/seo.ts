import "server-only";

import type { Metadata } from "next";

import { siteUrl } from "@/lib/env";
import type { Locale } from "@/lib/i18n/config";
import { DEFAULT_LOCALE, localeHref, pick } from "@/lib/i18n/config";
import { getMediaMap, getSocialLinks } from "@/lib/queries/site";
import { getPage, getSeoRecord } from "@/lib/queries/content";
import { getSettings } from "@/lib/settings";
import { isGenericLink } from "@/lib/social";
import { mediaSrc } from "@/lib/media/url";
import { toPlainText } from "@/lib/cms/sanitize";
import { canonicalOverride, recordStorage, shareTextFor, textFor, type Bilingual, type SeoStorage } from "@/lib/seo-model";

type BuildArgs = {
  locale: Locale;
  /** Canonical path without a language prefix, e.g. "/services/business-setup". */
  path: string;
  /**
   * Where this page's SEO record lives (`lib/seo-model.ts`): the record's type,
   * its present address and — for a record-backed page — its id, by which a
   * record follows the page through a rename. Absent for a page that can have
   * no record (`/search`).
   */
  seo?: SeoStorage;
  /**
   * The page's own title and description in both languages, as stored — not
   * pre-picked, so the Arabic edition can tell real Arabic from English
   * standing in for it (`textFor`) — and its own picture.
   */
  title?: Partial<Bilingual>;
  description?: Partial<Bilingual>;
  imageId?: number | null;
  noindex?: boolean;
  type?: "website" | "article";
};

const absolute = (path: string) => `${siteUrl}${path}`;

/** The static picture every page falls back to, declared at its real size. */
const DEFAULT_SHARE_IMAGE = { url: "/brand/og-default.jpg", width: 1200, height: 630 };

/** The 1600-pixel rendition when the library made one; the original otherwise. */
const SHARE_WIDTH = 1600;

type ShareImage = { url: string; width?: number; height?: number; alt: string };

/**
 * The share image: the first candidate — the record's picture, the page's own,
 * the site default — that is still in the library and is a raster image. A
 * picture deleted since (decision B: a missing asset is skipped, never emitted)
 * or an SVG (no social network shows one) is passed over for the next, rather
 * than ending the chain at the static default. Declared with its real width and
 * height and its alt text in this language.
 */
async function shareImage(
  candidates: Array<number | null | undefined>,
  locale: Locale,
  siteName: string,
): Promise<ShareImage> {
  const ids = candidates.filter((id): id is number => typeof id === "number" && Number.isInteger(id) && id > 0);
  if (ids.length) {
    const mediaMap = await getMediaMap();
    for (const id of ids) {
      const found = mediaMap.get(id);
      if (!found || /\.svg$/i.test(found.filename)) continue;
      const derived = found.derivatives?.includes(SHARE_WIDTH) && found.width > SHARE_WIDTH;
      const width = derived ? SHARE_WIDTH : found.width;
      const height = derived && found.width ? Math.round((found.height * SHARE_WIDTH) / found.width) : found.height;
      return {
        url: absolute(mediaSrc(found, derived ? SHARE_WIDTH : undefined)),
        ...(width > 0 && height > 0 ? { width, height } : {}),
        alt: pick(locale, found.altEn, found.altAr) || siteName,
      };
    }
  }
  return { ...DEFAULT_SHARE_IMAGE, url: absolute(DEFAULT_SHARE_IMAGE.url), alt: siteName };
}

/**
 * One place builds every page's metadata, so a canonical, an OG tag and a
 * hreflang can never describe different addresses. The order is always: the
 * page's SEO record, then the page's own values, then the site defaults — and
 * each language on its own (Batch 25, docs/admin/seo-and-share-images.md B.4):
 * an empty Arabic field in a record means "follow this page's own Arabic",
 * never "use the English record".
 */
export async function buildMetadata(args: BuildArgs): Promise<Metadata> {
  const settings = await getSettings();
  const record = args.seo ? await getSeoRecord(args.seo) : null;

  const isArabic = args.locale === "ar";
  const template = isArabic ? settings.seo.titleTemplateAr : settings.seo.titleTemplateEn;
  const siteName = isArabic ? settings.brand.siteNameAr : settings.brand.siteNameEn;

  const chosenTitle = textFor(
    args.locale,
    record && { en: record.titleEn, ar: record.titleAr },
    args.title,
    { en: settings.seo.defaultTitleEn, ar: settings.seo.defaultTitleAr },
  );
  const chosenDescription = textFor(
    args.locale,
    record && { en: record.descriptionEn, ar: record.descriptionAr },
    args.description,
    { en: settings.seo.defaultDescriptionEn, ar: settings.seo.defaultDescriptionAr },
  );
  const description = toPlainText(chosenDescription.text, 300) || undefined;

  // A page title already ending in the brand name is left alone rather than
  // repeating it.
  const rawTitle = chosenTitle.text;
  const title =
    rawTitle.includes(siteName) || !template
      ? rawTitle
      : template.replace("%s", rawTitle);

  const canonical =
    (record ? canonicalOverride(record.canonicalUrl, args.locale, siteUrl) : null) ??
    absolute(localeHref(args.locale, args.path));

  // One picture serves both editions: a record holds one share image (B.4).
  const image = await shareImage([record?.ogImageId, args.imageId, settings.seo.ogImageId], args.locale, siteName);

  const noindex = record?.noindex || args.noindex || false;

  const shareTitle = shareTextFor(
    args.locale,
    record && { en: record.ogTitle, ar: record.ogTitleAr },
    { text: title, arabic: chosenTitle.arabic },
  );
  const shareDescription =
    shareTextFor(
      args.locale,
      record && { en: record.ogDescription, ar: record.ogDescriptionAr },
      { text: description ?? "", arabic: chosenDescription.arabic },
    ) || undefined;

  const languages: Record<string, string> = {
    [DEFAULT_LOCALE]: absolute(localeHref(DEFAULT_LOCALE, args.path)),
    "x-default": absolute(localeHref(DEFAULT_LOCALE, args.path)),
  };
  if (settings.features.arabicEnabled) languages.ar = absolute(localeHref("ar", args.path));

  return {
    title,
    description,
    metadataBase: new URL(siteUrl),
    alternates: { canonical, languages },
    robots: noindex
      ? { index: false, follow: true }
      : { index: true, follow: true, "max-image-preview": "large" },
    openGraph: {
      type: args.type ?? "website",
      siteName,
      locale: isArabic ? "ar_SA" : "en_US",
      // The other edition is named only while it exists.
      ...(settings.features.arabicEnabled ? { alternateLocale: isArabic ? "en_US" : "ar_SA" } : {}),
      url: canonical,
      title: shareTitle,
      description: shareDescription,
      images: [image],
    },
    twitter: {
      // X shows no large card for a picture under 300×157; it shows a small one.
      card: image.width !== undefined && image.height !== undefined && (image.width < 300 || image.height < 157)
        ? "summary"
        : "summary_large_image",
      site: settings.seo.twitterHandle || undefined,
      title: shareTitle,
      description: shareDescription,
      images: [{ url: image.url, alt: image.alt }],
    },
  };
}

/**
 * The homepage's metadata — one function for `/` and for `/home`, which
 * serves the same page (B.14), so the two addresses can never describe it
 * differently: the homepage's record, the site default title and description
 * (the homepage names none of its own), and `/` as its address.
 */
export async function homeMetadata(locale: Locale): Promise<Metadata> {
  const home = await getPage("home");
  return buildMetadata({ locale, path: "/", seo: home ? recordStorage("page", home.slug, home.id) : undefined });
}

/**
 * Organization data for the homepage. `Organization`, never `GovernmentOffice`
 * or anything that would imply an official role — §28 of the brief, and simply
 * true: Elite One Desk is an independent provider.
 */
export async function organizationJsonLd(locale: Locale) {
  const [settings, social] = await Promise.all([getSettings(), getSocialLinks()]);
  const { contact, brand } = settings;
  /**
   * The accounts an admin has published.
   *
   * `sameAs` states that these addresses refer to the same entity as this
   * Organization. It is an identity claim, not a verification — nothing here
   * proves ownership, and a comment that said "verified profile" was promising
   * something the markup does not deliver. It was also declared and never
   * filled, guarded by `if (sameAs.length)`, so every account the business
   * published was in the footer and invisible to a search engine.
   *
   * `getSocialLinks` returns published rows only. Blank addresses are dropped
   * and duplicates collapsed, so the list is deterministic rather than a
   * transcription of whatever the table happens to hold. `Other / Website` is
   * left out on purpose: that row is for an address that is ours but is not an
   * account — a booking portal, a group site — and listing it would assert an
   * identity equivalence we cannot stand behind.
   */
  const sameAs = [
    ...new Set(
      social
        .filter((row) => !isGenericLink(row.platform))
        .map((row) => row.url.trim())
        .filter(Boolean),
    ),
  ];

  const data: Record<string, unknown> = {
    "@context": "https://schema.org",
    "@type": "Organization",
    name: pick(locale, brand.legalNameEn, brand.legalNameAr),
    url: siteUrl,
    logo: absolute("/brand/logo-320.png"),
    image: absolute("/brand/og-default.jpg"),
    description: pick(
      locale,
      settings.seo.defaultDescriptionEn,
      settings.seo.defaultDescriptionAr,
    ),
  };

  if (contact.phone) {
    data.contactPoint = [
      {
        "@type": "ContactPoint",
        telephone: contact.phone,
        contactType: "customer service",
        availableLanguage: ["English", "Arabic"],
      },
    ];
  }
  if (contact.email) data.email = contact.email;

  const street = pick(locale, contact.addressEn, contact.addressAr);
  const city = pick(locale, contact.cityEn, contact.cityAr);
  if (street || city) {
    data.address = {
      "@type": "PostalAddress",
      streetAddress: street || undefined,
      addressLocality: city || undefined,
      addressCountry: "SA",
    };
  }
  if (sameAs.length) data.sameAs = sameAs;
  return data;
}

export function breadcrumbJsonLd(
  locale: Locale,
  trail: Array<{ name: string; path: string }>,
) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: trail.map((item, index) => ({
      "@type": "ListItem",
      position: index + 1,
      name: item.name,
      item: absolute(localeHref(locale, item.path)),
    })),
  };
}

export function faqJsonLd(entries: Array<{ question: string; answer: string }>) {
  if (!entries.length) return null;
  return {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: entries.map((entry) => ({
      "@type": "Question",
      name: entry.question,
      acceptedAnswer: { "@type": "Answer", text: toPlainText(entry.answer, 900) },
    })),
  };
}
