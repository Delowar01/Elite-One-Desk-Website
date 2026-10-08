/**
 * What the two overviews say about themselves in search results when no SEO
 * record says otherwise (Batch 25). Moved here unchanged from their routes so
 * the SEO screen can show the same words as the fallback it describes; the
 * routes read them from here.
 *
 * This is metadata, not the pages' visible wording — the heroes of `/services`
 * and `/packages` are edited in the Visual Editor (Batch 24) and are a separate
 * thing on purpose (brief §14).
 */

type Words = { en: string; ar: string };

/**
 * `/services`. Its description says how many groups the catalogue has, so it
 * follows the data rather than the release — the shared taxonomy-state check
 * decides which sentence (see the route).
 */
export const SERVICES_OVERVIEW_META: {
  title: Words;
  description: { legacy: Words; restructured: Words };
} = {
  title: { en: "Services", ar: "الخدمات" },
  description: {
    legacy: {
      en: "Every Elite One Desk service: travel and tourism, business setup, company formation, general services, licence renewal and government relations.",
      ar: "جميع خدمات إيليت ون ديسك: السفر والسياحة، تأسيس الأعمال، تسجيل الشركات، الخدمات العامة، تجديد الرخص والعلاقات الحكومية.",
    },
    restructured: {
      en: "Every Elite One Desk service: travel and tourism, business setup and company formation, Iqama and employee services, license renewal and compliance, and government and general services.",
      ar: "جميع خدمات إيليت ون ديسك: السفر والسياحة، تأسيس الأعمال والشركات، خدمات الإقامة والموظفين، تجديد التراخيص والامتثال، والخدمات الحكومية والعامة.",
    },
  },
};

/** `/packages`. */
export const PACKAGES_OVERVIEW_META: { title: Words; description: Words } = {
  title: { en: "Tour packages", ar: "البرامج السياحية" },
  description: {
    en: "Tour packages and prepared itineraries across our destinations — every one of them adjustable.",
    ar: "باقات سياحية وبرامج مُعدّة مسبقاً لوجهات مختارة — جميعها قابلة للتخصيص.",
  },
};
