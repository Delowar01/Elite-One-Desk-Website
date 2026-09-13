import "./env";

import { and, eq, inArray, isNull, sql } from "drizzle-orm";

import { db } from "../src/lib/db";
import {
  faqs,
  navigationItems,
  packageDestinations,
  pageSections,
  pages,
  serviceCategories,
  serviceSubcategories,
  services,
  travelPackages,
} from "../src/lib/db/schema";
import { NAVIGATION } from "./seed/content";
import { taxonomyState } from "./seed/state";

/**
 * The 2026 service restructure, as one transaction.
 *
 *   npm run restructure -- --dry-run   # does everything, then rolls back
 *   npm run restructure                # does everything, then commits
 *
 * Six categories become five: Company Formation merges into Business Setup,
 * General Services becomes Iqama & Employee Services, and the Egypt
 * subcategory dissolves — twelve of its fourteen services duplicated a generic
 * Travel service or belonged in the package catalogue, and the other two are
 * promoted. Egypt becomes a package destination, which is what it always was.
 *
 * Three properties, in the order they matter:
 *
 *  1. ATOMIC. Every statement runs in one transaction with every assertion
 *     inside it. A failure anywhere leaves production byte-identical.
 *  2. EXCLUSIVE. A transaction-scoped advisory lock stops two of these running
 *     at once, and SHARE ROW EXCLUSIVE on the eight tables it mutates stops an
 *     admin saving into the middle of it. Plain SELECT is unaffected, so the
 *     public site keeps serving and enquiries keep being written — the enquiry
 *     tables are not in the lock set.
 *  3. IDEMPOTENT. A second run detects the finished state and does nothing.
 *
 * It is never invoked by deploy.sh. The cutover is a decision somebody makes.
 */

const DRY_RUN = process.argv.includes("--dry-run");

/** Thrown to roll a dry run back once it has proved the whole thing works. */
const ROLLBACK = Symbol("dry-run rollback");

/** Arbitrary but fixed: any two runs must ask for the same lock. */
const ADVISORY_LOCK_KEY = 728_104_2026;

/**
 * A provisional position for the two promoted services: high enough to be last
 * inside Travel & Holiday whatever the live numbering is, and adjacent so the
 * two keep the order the catalogue lists them in. Step 8b renumbers it away.
 */
const PROMOTED_ORDER = 9_000;

const log = (line = "") => console.log(line);
const step = (line: string) => console.log(`· ${line}`);

/* -------------------------------------------------------------------------- */
/* What moves                                                                  */
/* -------------------------------------------------------------------------- */

/** Duplicates of a generic Travel service, or destination content. */
const DELETE_SERVICE_SLUGS = [
  "egypt-flight-booking",
  "cairo-hotel-packages",
  "cairo-city-tour",
  "giza-pyramid-tour",
  "egyptian-museum-visit",
  "nile-river-cruise",
  "sharm-el-sheikh-tour",
  "hurghada-holiday-package",
  "airport-pickup-and-drop-off",
  "group-tour-package",
  "family-tour-package",
  "customized-egypt-tour-package",
];

const CATEGORY_TITLES: Record<string, { en: string; ar: string }> = {
  "business-setup": { en: "Business Setup & Company Formation", ar: "تأسيس الأعمال والشركات" },
  "iqama-services": { en: "Iqama & Employee Services", ar: "خدمات الإقامة والموظفين" },
  "license-renewal": { en: "License Renewal & Compliance", ar: "تجديد التراخيص والامتثال" },
  "government-relations": { en: "Government & General Services", ar: "الخدمات الحكومية والعامة" },
};

const EGYPT = {
  slug: "egypt",
  titleEn: "Egypt",
  titleAr: "مصر",
  summaryEn:
    "Explore Egypt through curated travel packages covering Cairo, Giza, the Nile, Luxor, Aswan, Sharm El Sheikh and Hurghada. Choose a ready itinerary or contact us to tailor your trip.",
  summaryAr:
    "اكتشف مصر من خلال باقات سفر مختارة تشمل القاهرة والجيزة والنيل والأقصر وأسوان وشرم الشيخ والغردقة. اختر برنامجاً جاهزاً أو تواصل معنا لتخصيص رحلتك.",
  sortOrder: 0,
};

/**
 * Homepage copy that counts the categories out loud.
 *
 * Two blocks say "six" in one form or another, and after the cutover there are
 * five. They are editor-owned rows, though, not code — so each field is
 * replaced only when it still holds exactly what the seed wrote. A value that
 * has been edited since is somebody's work; it is left alone and named in the
 * output instead, in both the dry run and the real thing.
 *
 * `was` is the value as the pre-restructure seed wrote it. It is frozen here on
 * purpose: this is a record of what production holds, not a reference to a
 * constant that will keep moving.
 */
type SectionRewrite = {
  page: string;
  blockType: string;
  field: string;
  was: unknown;
  now: unknown;
};

const SECTION_REWRITES: SectionRewrite[] = [
  {
    page: "home",
    blockType: "service-grid",
    field: "title",
    was: { en: "Six categories, one point of contact", ar: "ست فئات، ونقطة تواصل واحدة" },
    now: {
      en: "Five service groups, one point of contact",
      ar: "خمس مجموعات خدمات، ونقطة تواصل واحدة",
    },
  },
  {
    page: "home",
    blockType: "service-grid",
    field: "intro",
    was: {
      en: "Each category has its own specialists. You still speak to one person.",
      ar: "لكل فئة مختصوها. ومع ذلك تتحدث أنت إلى شخص واحد.",
    },
    now: {
      en: "Each service group has its own specialists. You still speak to one person.",
      ar: "لكل مجموعة خدمات مختصوها. ومع ذلك تتحدث أنت إلى شخص واحد.",
    },
  },
  {
    page: "home",
    blockType: "service-grid",
    field: "limit",
    was: 6,
    now: 5,
  },
  {
    page: "home",
    blockType: "one-desk",
    field: "paths",
    was: [
      { label: { en: "Travel & tourism", ar: "السفر والسياحة" } },
      { label: { en: "Business setup", ar: "تأسيس الأعمال" } },
      { label: { en: "Company formation", ar: "تأسيس الشركات" } },
      { label: { en: "Iqama & khidamat", ar: "الإقامة والمعاملات" } },
      { label: { en: "Licence renewal", ar: "تجديد التراخيص" } },
      { label: { en: "Government relations", ar: "العلاقات الحكومية" } },
    ],
    now: [
      { label: { en: "Travel & Tourism", ar: "السفر والسياحة" } },
      { label: { en: "Business Setup & Company Formation", ar: "تأسيس الأعمال والشركات" } },
      { label: { en: "Iqama & Employee Services", ar: "خدمات الإقامة والموظفين" } },
      { label: { en: "License Renewal & Compliance", ar: "تجديد التراخيص والامتثال" } },
      { label: { en: "Government & General Services", ar: "الخدمات الحكومية والعامة" } },
    ],
  },
  {
    page: "home",
    blockType: "quick-links",
    field: "links",
    was: [
      { label: { en: "Plan a Trip", ar: "خطّط لرحلة" }, href: "/services/travel-tourism", icon: "plane" },
      {
        label: { en: "Visa Assistance", ar: "المساعدة في التأشيرات" },
        href: "/services/travel-tourism/schengen-visa-assistance",
        icon: "passport",
      },
      {
        label: { en: "Investor Licence", ar: "رخصة المستثمر" },
        href: "/services/business-setup/investor-license-assistance",
        icon: "briefcase",
      },
      { label: { en: "Start a Company", ar: "تأسيس شركة" }, href: "/services/company-formation", icon: "building" },
      { label: { en: "Iqama & Khidamat", ar: "الإقامة والمعاملات" }, href: "/services/general-services", icon: "idCard" },
      { label: { en: "Renew a Licence", ar: "تجديد ترخيص" }, href: "/services/license-renewal", icon: "refresh" },
      {
        label: { en: "Premium Residency", ar: "الإقامة المميزة" },
        href: "/services/government-relations/premium-residency-consultation",
        icon: "shield",
      },
      {
        label: { en: "TGA Services", ar: "خدمات النقل" },
        href: "/services/government-relations/tga-license-consultation",
        icon: "route",
      },
    ],
    now: [
      { label: { en: "Plan a Trip", ar: "خطّط لرحلة" }, href: "/services/travel-tourism", icon: "plane" },
      {
        label: { en: "Visa Assistance", ar: "المساعدة في التأشيرات" },
        href: "/services/travel-tourism/schengen-visa-assistance",
        icon: "passport",
      },
      {
        label: { en: "Investor Licence", ar: "رخصة المستثمر" },
        href: "/services/business-setup/investor-license-assistance",
        icon: "briefcase",
      },
      {
        label: { en: "Start a Company", ar: "تأسيس شركة" },
        href: "/services/business-setup#company-formation-registration",
        icon: "building",
      },
      {
        label: { en: "Iqama & Employee Services", ar: "خدمات الإقامة والموظفين" },
        href: "/services/iqama-services",
        icon: "idCard",
      },
      { label: { en: "Renew a Licence", ar: "تجديد ترخيص" }, href: "/services/license-renewal", icon: "refresh" },
      {
        label: { en: "Premium Residency", ar: "الإقامة المميزة" },
        href: "/services/government-relations/premium-residency-consultation",
        icon: "shield",
      },
      {
        label: { en: "TGA Services", ar: "خدمات النقل" },
        href: "/services/government-relations/tga-license-consultation",
        icon: "route",
      },
    ],
  },
  {
    page: "home",
    blockType: "why-us",
    field: "points",
    was: [
      {
        label: { en: "One point of contact", ar: "نقطة تواصل واحدة" },
        text: {
          en: "The same person across your travel, your company and your residency file.",
          ar: "الشخص نفسه لسفرك وشركتك وملف إقامتك.",
        },
      },
      {
        label: { en: "Multiple service categories", ar: "فئات خدمات متعددة" },
        text: {
          en: "Six categories under one roof, so a request rarely has to go elsewhere.",
          ar: "ست فئات تحت سقف واحد، فنادرًا ما يحتاج طلبك إلى جهة أخرى.",
        },
      },
      {
        label: { en: "Professional coordination", ar: "تنسيق مهني" },
        text: {
          en: "Documents prepared before a step opens, not after it has been rejected.",
          ar: "المستندات تُجهَّز قبل بدء الخطوة، لا بعد رفضها.",
        },
      },
      {
        label: { en: "Saudi market knowledge", ar: "معرفة بالسوق السعودي" },
        text: {
          en: "Familiar with the portals, the sequencing and what each authority expects to see.",
          ar: "إلمام بالبوابات وترتيب الخطوات وما تتوقعه كل جهة.",
        },
      },
      {
        label: { en: "Travel and business together", ar: "السفر والأعمال معًا" },
        text: {
          en: "An investor who also needs flights and a family visa is one conversation here.",
          ar: "المستثمر الذي يحتاج أيضًا إلى تذاكر وتأشيرة عائلية هو محادثة واحدة هنا.",
        },
      },
      {
        label: { en: "Corporate and individual", ar: "للشركات والأفراد" },
        text: {
          en: "A single traveller and a company with fifty employees are both served properly.",
          ar: "المسافر الفرد والشركة بخمسين موظفًا يُخدمان بالجودة نفسها.",
        },
      },
    ],
    now: [
      {
        label: { en: "One point of contact", ar: "نقطة تواصل واحدة" },
        text: {
          en: "The same person across your travel, your company and your residency file.",
          ar: "الشخص نفسه لسفرك وشركتك وملف إقامتك.",
        },
      },
      {
        label: { en: "Multiple service categories", ar: "فئات خدمات متعددة" },
        text: {
          en: "Five service groups under one roof, so a request rarely has to go elsewhere.",
          ar: "خمس مجموعات خدمات تحت سقف واحد، فنادرًا ما يحتاج طلبك إلى جهة أخرى.",
        },
      },
      {
        label: { en: "Professional coordination", ar: "تنسيق مهني" },
        text: {
          en: "Documents prepared before a step opens, not after it has been rejected.",
          ar: "المستندات تُجهَّز قبل بدء الخطوة، لا بعد رفضها.",
        },
      },
      {
        label: { en: "Saudi market knowledge", ar: "معرفة بالسوق السعودي" },
        text: {
          en: "Familiar with the portals, the sequencing and what each authority expects to see.",
          ar: "إلمام بالبوابات وترتيب الخطوات وما تتوقعه كل جهة.",
        },
      },
      {
        label: { en: "Travel and business together", ar: "السفر والأعمال معًا" },
        text: {
          en: "An investor who also needs flights and a family visa is one conversation here.",
          ar: "المستثمر الذي يحتاج أيضًا إلى تذاكر وتأشيرة عائلية هو محادثة واحدة هنا.",
        },
      },
      {
        label: { en: "Corporate and individual", ar: "للشركات والأفراد" },
        text: {
          en: "A single traveller and a company with fifty employees are both served properly.",
          ar: "المسافر الفرد والشركة بخمسين موظفًا يُخدمان بالجودة نفسها.",
        },
      },
    ],
  },
];

/**
 * The one FAQ whose question names a category that stops existing.
 *
 * Treated as a single unit: all four columns are replaced, or none are. A
 * half-replaced FAQ — a new question over an old answer — would be worse than
 * either state.
 */
const FAQ_REWRITE = {
  match: "What is the difference between General Services and visa services?",
  was: {
    questionAr: "ما الفرق بين الخدمات العامة وخدمات التأشيرات؟",
    answerEn:
      "<p>General Services — khidamat and Iqama — is residency and employee paperwork inside Saudi Arabia: issuing and renewing an Iqama, transfers, exit and re-entry, Muqeem and Qiwa. Visa services under Travel &amp; Tourism are about travelling abroad: Schengen, UK, US and other visit visas.</p>",
    answerAr:
      "<p>الخدمات العامة — الخدمات والإقامة — هي معاملات الإقامة والموظفين داخل المملكة: إصدار الإقامة وتجديدها ونقل الكفالة والخروج والعودة ومقيم وقوى. أما خدمات التأشيرات ضمن السفر والسياحة فتخص السفر إلى الخارج: شنغن وبريطانيا وأمريكا وغيرها.</p>",
  },
  now: {
    questionEn: "What is the difference between Iqama & Employee Services and visa services?",
    questionAr: "ما الفرق بين خدمات الإقامة والموظفين وخدمات التأشيرات؟",
    answerEn:
      "<p>Iqama &amp; Employee Services covers residency and employee paperwork inside Saudi Arabia: issuing and renewing an Iqama, transfers, exit and re-entry, Muqeem and Qiwa. Visa services under Travel &amp; Tourism are about travelling abroad: Schengen, UK, US and other visit visas.</p>",
    answerAr:
      "<p>خدمات الإقامة والموظفين تشمل معاملات الإقامة والموظفين داخل المملكة: إصدار الإقامة وتجديدها ونقل الخدمات والخروج والعودة ومقيم وقوى. أما خدمات التأشيرات ضمن السفر والسياحة فتخص السفر إلى الخارج: شنغن وبريطانيا وأمريكا وغيرها.</p>",
  },
} satisfies { match: string; was: Record<string, string>; now: Record<string, string> };

/**
 * Where a service-scoped FAQ goes when the service it is attached to is one of
 * the twelve duplicates being deleted. `faqs.service_id` cascades, so without
 * this the FAQ would go with it, silently.
 *
 * Only the six whose replacement is another service are listed. The other six
 * moved to a package or to the Egypt destination, where a service-scoped FAQ
 * has nothing to attach to — the cutover stops rather than guess, and says
 * which ones and why.
 */
const FAQ_SERVICE_MOVES: Record<string, string> = {
  "egypt-flight-booking": "air-ticket-booking",
  "cairo-hotel-packages": "hotel-reservation",
  "airport-pickup-and-drop-off": "airport-transfer",
  "group-tour-package": "group-tour-packages",
  "family-tour-package": "family-tour-packages",
  "customized-egypt-tour-package": "customized-travel-itinerary",
};

/* -------------------------------------------------------------------------- */
/* The menu as it was seeded                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The navigation the pre-restructure seed wrote, frozen.
 *
 * The cutover replaces the menu wholesale, which is only safe if the menu is
 * still the one nobody has touched. Counting rows does not establish that: a
 * renamed label, a moved link, a reordered item, a hidden one, or a row deleted
 * and replaced all leave the count at twenty-four. So the whole shape is
 * compared instead, and a single difference stops the run.
 */
const LEGACY_NAVIGATION: Array<{
  menu: string;
  label: { en: string; ar: string };
  href: string;
  children?: Array<{ label: { en: string; ar: string }; href: string }>;
}> = [
  { menu: "header", label: { en: "Home", ar: "الرئيسية" }, href: "/" },
  {
    menu: "header",
    label: { en: "Travel & Tourism", ar: "السفر والسياحة" },
    href: "/services/travel-tourism",
  },
  {
    menu: "header",
    label: { en: "Business", ar: "الأعمال" },
    href: "/services/business-setup",
    children: [
      { label: { en: "Business Setup", ar: "تأسيس الأعمال" }, href: "/services/business-setup" },
      { label: { en: "Company Formation", ar: "تأسيس الشركات" }, href: "/services/company-formation" },
    ],
  },
  {
    menu: "header",
    label: { en: "Government Services", ar: "الخدمات الحكومية" },
    href: "/services/general-services",
    children: [
      { label: { en: "General Services", ar: "الخدمات العامة" }, href: "/services/general-services" },
      { label: { en: "License Renewal", ar: "تجديد التراخيص" }, href: "/services/license-renewal" },
      {
        label: { en: "Government Relations", ar: "العلاقات الحكومية" },
        href: "/services/government-relations",
      },
    ],
  },
  { menu: "header", label: { en: "About Us", ar: "من نحن" }, href: "/about" },
  { menu: "header", label: { en: "Contact", ar: "تواصل" }, href: "/contact" },

  {
    menu: "footer_services",
    label: { en: "Travel & Tourism", ar: "السفر والسياحة" },
    href: "/services/travel-tourism",
  },
  {
    menu: "footer_services",
    label: { en: "Business Setup", ar: "تأسيس الأعمال" },
    href: "/services/business-setup",
  },
  {
    menu: "footer_services",
    label: { en: "Company Formation", ar: "تأسيس الشركات" },
    href: "/services/company-formation",
  },
  {
    menu: "footer_services",
    label: { en: "General Services", ar: "الخدمات العامة" },
    href: "/services/general-services",
  },
  {
    menu: "footer_services",
    label: { en: "License Renewal", ar: "تجديد التراخيص" },
    href: "/services/license-renewal",
  },
  {
    menu: "footer_services",
    label: { en: "Government Relations", ar: "العلاقات الحكومية" },
    href: "/services/government-relations",
  },

  { menu: "footer_company", label: { en: "About Us", ar: "من نحن" }, href: "/about" },
  { menu: "footer_company", label: { en: "All Services", ar: "جميع الخدمات" }, href: "/services" },
  { menu: "footer_company", label: { en: "Travel Packages", ar: "البرامج السياحية" }, href: "/packages" },
  { menu: "footer_company", label: { en: "Contact", ar: "تواصل" }, href: "/contact" },

  { menu: "footer_legal", label: { en: "Privacy Policy", ar: "سياسة الخصوصية" }, href: "/privacy" },
  { menu: "footer_legal", label: { en: "Terms", ar: "الشروط" }, href: "/terms" },
  { menu: "footer_legal", label: { en: "Disclaimer", ar: "إخلاء المسؤولية" }, href: "/disclaimer" },
];

/** A navigation row, reduced to the fields an editor can change. */
type NavNode = {
  /** Opaque: a database id for a stored row, a synthetic one for the seed. */
  key: string;
  parent: string | null;
  menu: string;
  labelEn: string;
  labelAr: string;
  href: string;
  sortOrder: number;
  isPublished: boolean;
  isHighlighted: boolean;
};

/** The rows the legacy seed wrote, with the numbering it gave them. */
function legacyNavigationNodes(): NavNode[] {
  const nodes: NavNode[] = [];
  let order = 0;
  LEGACY_NAVIGATION.forEach((item, index) => {
    const key = `seed-${index}`;
    nodes.push({
      key,
      parent: null,
      menu: item.menu,
      labelEn: item.label.en,
      labelAr: item.label.ar,
      href: item.href,
      sortOrder: order++,
      isPublished: true,
      isHighlighted: false,
    });
    (item.children ?? []).forEach((child, childIndex) => {
      nodes.push({
        key: `${key}-${childIndex}`,
        parent: key,
        menu: item.menu,
        labelEn: child.label.en,
        labelAr: child.label.ar,
        href: child.href,
        sortOrder: order++,
        isPublished: true,
        isHighlighted: false,
      });
    });
  });
  return nodes;
}

/**
 * The menu as a list of lines, in an order the database cannot influence.
 *
 * Ids and timestamps are not compared — they differ between any two databases
 * and mean nothing to an editor. Everything an editor *can* change is: the
 * menu, the hierarchy, both labels, the address, the position, and whether the
 * item is published or highlighted. Children are nested under their parent by
 * walking the tree rather than by joining on a parent id, so a parent id being
 * 41 here and 7 there is not a difference.
 *
 * A row whose parent is missing is walked at the root instead of being dropped:
 * a menu that has lost a parent is a customised menu, and it has to show up.
 */
function navigationSignature(nodes: NavNode[]): string[] {
  const present = new Set(nodes.map((node) => node.key));
  const children = new Map<string | null, NavNode[]>();
  for (const node of nodes) {
    const parent = node.parent && present.has(node.parent) ? node.parent : null;
    const list = children.get(parent) ?? [];
    list.push(node);
    children.set(parent, list);
  }

  const order = (a: NavNode, b: NavNode) =>
    a.menu.localeCompare(b.menu) ||
    a.sortOrder - b.sortOrder ||
    a.labelEn.localeCompare(b.labelEn) ||
    a.href.localeCompare(b.href);

  const lines: string[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const node of (children.get(parent) ?? []).slice().sort(order)) {
      lines.push(
        `${"  ".repeat(depth)}${"↳ ".repeat(depth)}${node.menu} · ${node.labelEn} / ${node.labelAr}` +
          ` → ${node.href} · #${node.sortOrder}${node.isPublished ? "" : " · unpublished"}` +
          `${node.isHighlighted ? " · highlighted" : ""}`,
      );
      walk(node.key, depth + 1);
    }
  };
  walk(null, 0);
  return lines;
}

/** Sorted-key JSON, so two equal values compare equal whatever their key order. */
function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

/** Editor-owned values the cutover found changed and therefore did not touch. */
const customised: string[] = [];

/**
 * Addresses stored inside section content, not in the catalogue. Only whole
 * hrefs are replaced, so a longer address that merely starts the same way is
 * left alone. The Company Formation category becomes a subcategory of Business
 * Setup, so its link becomes the anchor for that block on the category page.
 */
const SECTION_HREF_MOVES: Record<string, string> = {
  "/services/company-formation": "/services/business-setup#company-formation-registration",
  "/services/general-services": "/services/iqama-services",
};

const EGYPT_PACKAGE_SLUGS = [
  "cairo-and-giza-classic",
  "nile-cruise-luxor-aswan",
  "red-sea-sharm-el-sheikh",
  "egypt-family-programme",
];

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`assertion failed — ${message}`);
}

async function inventory(tx: Tx) {
  const rows = await tx
    .select({
      category: serviceCategories.slug,
      categoryTitle: serviceCategories.titleEn,
      subcategory: serviceSubcategories.slug,
      service: services.slug,
    })
    .from(services)
    .innerJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
    .leftJoin(serviceSubcategories, eq(serviceSubcategories.id, services.subcategoryId));

  const byCategory = new Map<string, number>();
  for (const row of rows) byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + 1);

  const [packageRows, navRows, sectionRows] = await Promise.all([
    tx
      .select({
        slug: travelPackages.slug,
        region: travelPackages.region,
        destinationId: travelPackages.destinationId,
      })
      .from(travelPackages),
    tx.select({ n: sql<number>`count(*)::int` }).from(navigationItems),
    tx.select({ blockType: pageSections.blockType }).from(pageSections),
  ]);

  return {
    services: rows.length,
    byCategory,
    packages: packageRows,
    // A multiset, sorted, so it can be compared before and after without caring
    // about row order — the machine check that `region` was left alone.
    regions: packageRows.map((p) => p.region).sort(),
    navigation: navRows[0]?.n ?? 0,
    egyptBlocks: sectionRows.filter((s) => s.blockType === "egypt-feature").length,
    destinationBlocks: sectionRows.filter((s) => s.blockType === "destination-feature").length,
  };
}

function printInventory(label: string, inv: Awaited<ReturnType<typeof inventory>>) {
  log(`  ${label}`);
  log(`    services            ${inv.services}`);
  for (const [slug, n] of [...inv.byCategory].sort()) log(`      ${slug.padEnd(24)}${n}`);
  log(`    navigation rows     ${inv.navigation}`);
  log(`    packages            ${inv.packages.length}`);
  log(`      with destination  ${inv.packages.filter((p) => p.destinationId != null).length}`);
  log(`    region values       ${inv.regions.join(", ")}`);
  log(`    egypt-feature       ${inv.egyptBlocks}`);
  log(`    destination-feature ${inv.destinationBlocks}`);
}

async function idOfCategory(tx: Tx, slug: string) {
  const [row] = await tx
    .select({ id: serviceCategories.id })
    .from(serviceCategories)
    .where(eq(serviceCategories.slug, slug))
    .limit(1);
  return row?.id ?? null;
}

async function idOfSubcategory(tx: Tx, slug: string) {
  const [row] = await tx
    .select({ id: serviceSubcategories.id })
    .from(serviceSubcategories)
    .where(eq(serviceSubcategories.slug, slug))
    .limit(1);
  return row?.id ?? null;
}

/**
 * Rewrites the homepage copy that counts categories, field by field, and only
 * where the stored value is still exactly what the seed wrote.
 *
 * `draft` is handled the same way and independently: pending editor work is as
 * much theirs as published work is.
 */
async function rewriteSections(tx: Tx) {
  let changed = 0;
  for (const rewrite of SECTION_REWRITES) {
    const rows = await tx
      .select({ id: pageSections.id, published: pageSections.published, draft: pageSections.draft })
      .from(pageSections)
      .innerJoin(pages, eq(pages.id, pageSections.pageId))
      .where(and(eq(pages.slug, rewrite.page), eq(pageSections.blockType, rewrite.blockType)));

    if (rows.length === 0) {
      customised.push(`${rewrite.page}/${rewrite.blockType} — no such section, nothing to update`);
      continue;
    }

    for (const row of rows) {
      const next: { published?: Record<string, unknown>; draft?: Record<string, unknown> } = {};
      for (const column of ["published", "draft"] as const) {
        const values = row[column] as Record<string, unknown> | null;
        if (!values || !(rewrite.field in values)) continue;
        if (!same(values[rewrite.field], rewrite.was)) {
          customised.push(
            `${rewrite.page}/${rewrite.blockType}.${rewrite.field} (${column}) — edited since it was seeded, left as it is`,
          );
          continue;
        }
        next[column] = { ...values, [rewrite.field]: rewrite.now };
      }
      if (Object.keys(next).length === 0) continue;
      await tx.update(pageSections).set({ ...next, updatedAt: new Date() }).where(eq(pageSections.id, row.id));
      changed += 1;
    }
  }
  return changed;
}

/** All four columns or none — see FAQ_REWRITE. */
async function rewriteFaqText(tx: Tx) {
  const [row] = await tx
    .select()
    .from(faqs)
    .where(eq(faqs.questionEn, FAQ_REWRITE.match))
    .limit(1);
  if (!row) return 0;

  const untouched =
    row.questionAr === FAQ_REWRITE.was.questionAr &&
    row.answerEn === FAQ_REWRITE.was.answerEn &&
    row.answerAr === FAQ_REWRITE.was.answerAr;
  if (!untouched) {
    customised.push(
      `the “General Services vs visa services” FAQ — edited since it was seeded, left as it is (its question still names a category that no longer exists; update it in the panel)`,
    );
    return 0;
  }

  await tx.update(faqs).set({ ...FAQ_REWRITE.now, updatedAt: new Date() }).where(eq(faqs.id, row.id));
  return 1;
}

/**
 * `faqs.category_id` and `faqs.service_id` both cascade, so anything the
 * cutover deletes would take its FAQs with it without a word. Re-point them
 * first; where there is nowhere sensible to point, stop and say so rather than
 * delete somebody's answer.
 */
async function protectCategoryFaqs(tx: Tx, companyId: number, businessId: number) {
  const moved = await tx
    .update(faqs)
    .set({ categoryId: businessId, updatedAt: new Date() })
    .where(eq(faqs.categoryId, companyId))
    .returning({ id: faqs.id });
  return moved.length;
}

async function protectServiceFaqs(tx: Tx, travelId: number) {
  const attached = await tx
    .select({ id: faqs.id, question: faqs.questionEn, slug: services.slug })
    .from(faqs)
    .innerJoin(services, eq(services.id, faqs.serviceId))
    .where(and(eq(services.categoryId, travelId), inArray(services.slug, DELETE_SERVICE_SLUGS)));
  if (attached.length === 0) return 0;

  const stranded = attached.filter((row) => !FAQ_SERVICE_MOVES[row.slug]);
  assert(
    stranded.length === 0,
    `${stranded.length} FAQ(s) are attached to a service that becomes a package or a destination, ` +
      `where a service FAQ cannot follow: ${stranded
        .map((row) => `“${row.question}” (${row.slug})`)
        .join(", ")}. Move or delete them in the panel, then run this again.`,
  );

  for (const row of attached) {
    const target = FAQ_SERVICE_MOVES[row.slug]!;
    const [replacement] = await tx
      .select({ id: services.id })
      .from(services)
      .where(and(eq(services.categoryId, travelId), eq(services.slug, target)))
      .limit(1);
    assert(replacement, `the replacement service ${target} is missing`);
    await tx
      .update(faqs)
      .set({ serviceId: replacement.id, updatedAt: new Date() })
      .where(eq(faqs.id, row.id));
  }
  return attached.length;
}

/* -------------------------------------------------------------------------- */
/* The cutover                                                                 */
/* -------------------------------------------------------------------------- */

async function cutover(tx: Tx) {
  // --- 0. exclusivity ------------------------------------------------------
  // Transaction-scoped: released by COMMIT or ROLLBACK, never leaked.
  await tx.execute(sql`select pg_advisory_xact_lock(${ADVISORY_LOCK_KEY})`);

  // SHARE ROW EXCLUSIVE is the weakest mode that conflicts with ROW EXCLUSIVE
  // (every INSERT / UPDATE / DELETE) and with itself, while leaving ACCESS
  // SHARE — a plain SELECT — free. So: no admin write lands mid-cutover, no
  // second cutover runs beside this one, and the public site never blocks.
  await tx.execute(sql`
    lock table
      service_categories, service_subcategories, services,
      package_destinations, travel_packages,
      navigation_items, page_sections, faqs
    in share row exclusive mode
  `);
  step("locks acquired (advisory + 8 tables, share row exclusive)");

  // --- 1. preconditions ----------------------------------------------------
  const state = await taxonomyState(tx);
  if (state === "restructured") {
    log();
    log("  Already restructured — nothing to do.");
    throw ROLLBACK;
  }
  if (state === "fresh") {
    throw new Error(
      "this database holds no service catalogue at all. There is nothing to restructure — " +
        "check DATABASE_URL points at the database you meant, and seed it first if it is new.",
    );
  }

  const before = await inventory(tx);
  printInventory("before", before);
  log();

  assert(before.byCategory.size === 6, `expected 6 categories, found ${before.byCategory.size}`);
  assert(before.services === 86, `expected 86 services, found ${before.services}`);
  assert(before.packages.length === 5, `expected 5 packages, found ${before.packages.length}`);

  const travelId = await idOfCategory(tx, "travel-tourism");
  const businessId = await idOfCategory(tx, "business-setup");
  const companyId = await idOfCategory(tx, "company-formation");
  const generalId = await idOfCategory(tx, "general-services");
  const travelHolidayId = await idOfSubcategory(tx, "travel-holiday");
  const egyptToursId = await idOfSubcategory(tx, "egypt-tours");
  const companySubId = await idOfSubcategory(tx, "company-formation-registration");
  assert(travelId && businessId && companyId && generalId, "a legacy category is missing");
  assert(travelHolidayId && egyptToursId && companySubId, "a legacy subcategory is missing");

  // --- 2. the Egypt destination -------------------------------------------
  const [destination] = await tx
    .insert(packageDestinations)
    .values(EGYPT)
    .onConflictDoUpdate({
      target: packageDestinations.slug,
      set: { titleEn: EGYPT.titleEn, titleAr: EGYPT.titleAr, updatedAt: new Date() },
    })
    .returning({ id: packageDestinations.id });
  assert(destination, "the Egypt destination was not created");
  step(`destination “Egypt” (#${destination.id})`);

  // Matched on the four package slugs, never on region = 'egypt': a slug list
  // is auditable, and a region match would sweep in any future package that
  // happened to carry the legacy value.
  const assigned = await tx
    .update(travelPackages)
    .set({ destinationId: destination.id, updatedAt: new Date() })
    .where(inArray(travelPackages.slug, EGYPT_PACKAGE_SLUGS))
    .returning({ slug: travelPackages.slug });
  assert(assigned.length === 4, `expected to assign 4 packages, assigned ${assigned.length}`);
  step(`4 packages assigned to Egypt · custom-itinerary left unassigned by design`);

  // --- 3. promote the two Travel services out of the Egypt subcategory -----
  // The two provisional numbers put them last inside Travel & Holiday and in
  // the order the catalogue definition lists them. They do not survive: step 8b
  // renumbers every category contiguously and these become ordinary positions.
  const promotedHoneymoon = await tx
    .update(services)
    .set({
      subcategoryId: travelHolidayId,
      slug: "honeymoon-packages",
      sortOrder: PROMOTED_ORDER,
      updatedAt: new Date(),
    })
    .where(and(eq(services.slug, "honeymoon-package"), eq(services.categoryId, travelId)))
    .returning({ id: services.id });
  assert(promotedHoneymoon.length === 1, "honeymoon-package was not promoted");

  const promotedGuide = await tx
    .update(services)
    .set({ subcategoryId: travelHolidayId, sortOrder: PROMOTED_ORDER + 1, updatedAt: new Date() })
    .where(and(eq(services.slug, "professional-tour-guide"), eq(services.categoryId, travelId)))
    .returning({ id: services.id });
  assert(promotedGuide.length === 1, "professional-tour-guide was not promoted");
  step("2 services promoted into Travel & Holiday (tour guide keeps its address)");

  // The featured flag follows the survivor, not the duplicate being deleted.
  await tx
    .update(services)
    .set({ isFeatured: true, updatedAt: new Date() })
    .where(and(eq(services.slug, "customized-travel-itinerary"), eq(services.categoryId, travelId)));

  // --- 4. Company Formation merges into Business Setup ---------------------
  // Order matters: both foreign keys cascade, so the category may only be
  // deleted once nothing points at it.
  await tx
    .update(serviceSubcategories)
    .set({ categoryId: businessId, sortOrder: 1, updatedAt: new Date() })
    .where(eq(serviceSubcategories.id, companySubId));

  const moved = await tx
    .update(services)
    .set({ categoryId: businessId, updatedAt: new Date() })
    .where(eq(services.categoryId, companyId))
    .returning({ id: services.id });
  assert(moved.length === 5, `expected to move 5 services, moved ${moved.length}`);

  const [{ left }] = await tx
    .select({ left: sql<number>`count(*)::int` })
    .from(services)
    .where(eq(services.categoryId, companyId));
  assert(left === 0, `${left} services still reference company-formation`);

  // faqs.category_id cascades, so anything filed under Company Formation has to
  // move before the row it points at disappears.
  const movedFaqs = await protectCategoryFaqs(tx, companyId, businessId);

  await tx.delete(serviceCategories).where(eq(serviceCategories.id, companyId));
  step(
    `Company Formation merged into Business Setup (5 services, 1 subcategory` +
      `${movedFaqs ? `, ${movedFaqs} FAQ${movedFaqs === 1 ? "" : "s"}` : ""})`,
  );

  // --- 5. renames and titles ----------------------------------------------
  await tx
    .update(serviceCategories)
    .set({
      slug: "iqama-services",
      taglineEn: "Residency and employee paperwork",
      taglineAr: "أوراق الإقامة والموظفين",
      updatedAt: new Date(),
    })
    .where(eq(serviceCategories.id, generalId));

  await tx
    .update(serviceSubcategories)
    .set({
      titleEn: "Iqama & Employee Services",
      titleAr: "خدمات الإقامة والموظفين",
      updatedAt: new Date(),
    })
    .where(eq(serviceSubcategories.slug, "khidamat-iqama"));

  for (const [slug, title] of Object.entries(CATEGORY_TITLES)) {
    await tx
      .update(serviceCategories)
      .set({ titleEn: title.en, titleAr: title.ar, updatedAt: new Date() })
      .where(eq(serviceCategories.slug, slug));
  }
  step("general-services → iqama-services · 4 categories retitled (EN + AR)");

  // --- 6. navigation -------------------------------------------------------
  // Replaced wholesale from the same constant the seed uses, so a restructured
  // database and a freshly seeded one end up with an identical menu.
  //
  // Wholesale replacement is only defensible if the menu is provably still the
  // one the seed wrote, so that is what is checked — the whole normalised shape,
  // not the row count. A renamed label, a moved link, a reordered item, one
  // hidden, one highlighted, or a row deleted and replaced by another all keep
  // the count at twenty-four, and every one of them is somebody's work.
  const storedNav = await tx
    .select({
      id: navigationItems.id,
      parentId: navigationItems.parentId,
      menu: navigationItems.menu,
      labelEn: navigationItems.labelEn,
      labelAr: navigationItems.labelAr,
      href: navigationItems.href,
      sortOrder: navigationItems.sortOrder,
      isPublished: navigationItems.isPublished,
      isHighlighted: navigationItems.isHighlighted,
    })
    .from(navigationItems);

  const found = navigationSignature(
    storedNav.map((row) => ({
      key: String(row.id),
      parent: row.parentId === null ? null : String(row.parentId),
      menu: row.menu,
      labelEn: row.labelEn,
      labelAr: row.labelAr,
      href: row.href,
      sortOrder: row.sortOrder,
      isPublished: row.isPublished,
      isHighlighted: row.isHighlighted,
    })),
  );
  const seeded = navigationSignature(legacyNavigationNodes());

  if (found.join("\n") !== seeded.join("\n")) {
    const inDatabase = found.filter((line) => !seeded.includes(line));
    const inSeed = seeded.filter((line) => !found.includes(line));
    log();
    log("  Navigation has been customised since the original seed. The restructure will");
    log("  not replace editor-owned navigation. Review the differences before continuing.");
    log();
    log(`    rows: ${found.length} stored, ${seeded.length} in the original seed`);
    for (const line of inSeed.slice(0, 12)) log(`    − ${line.trim()}`);
    for (const line of inDatabase.slice(0, 12)) log(`    + ${line.trim()}`);
    if (inSeed.length + inDatabase.length > 24) log("    … and more");
    log();
    log("  Either restore the menu to its seeded state, or update NAVIGATION in");
    log("  scripts/seed/content.ts to carry those changes forward and re-run.");
    throw new Error("navigation has been customised — it is not being replaced");
  }

  await tx.delete(navigationItems);

  let order = 0;
  for (const item of NAVIGATION) {
    const [row] = await tx
      .insert(navigationItems)
      .values({
        menu: item.menu,
        labelEn: item.label.en,
        labelAr: item.label.ar,
        href: item.href,
        sortOrder: order++,
      })
      .returning({ id: navigationItems.id });
    for (const child of item.children ?? []) {
      await tx.insert(navigationItems).values({
        menu: item.menu,
        parentId: row!.id,
        labelEn: child.label.en,
        labelAr: child.label.ar,
        href: child.href,
        sortOrder: order++,
      });
    }
  }
  step(`navigation rewritten (${order} rows)`);

  // --- 7. the homepage block type -----------------------------------------
  // Only the type. The values an editor wrote about Egypt are correct content
  // and are not touched.
  const retyped = await tx
    .update(pageSections)
    .set({ blockType: "destination-feature", updatedAt: new Date() })
    .where(eq(pageSections.blockType, "egypt-feature"))
    .returning({ id: pageSections.id });
  step(`${retyped.length} section(s) retyped to destination-feature`);

  // The copy first, because it replaces whole values and has to recognise them
  // exactly as the old seed wrote them — hrefs included.
  const rewritten = await rewriteSections(tx);
  const faqRewritten = await rewriteFaqText(tx);

  // Then any retired address still stored in a section an editor has changed
  // since. Left alone they would still work — the route redirects — but the
  // site would be linking to its own redirect from its most prominent block,
  // which is a thing to fix rather than to ship. Matched with the surrounding
  // quotes so only a whole href is replaced.
  for (const [from, to] of Object.entries(SECTION_HREF_MOVES)) {
    for (const column of ["published", "draft"] as const) {
      await tx.execute(sql`
        update page_sections
           set ${sql.raw(column)} = replace(${sql.raw(column)}::text, ${`"${from}"`}, ${`"${to}"`})::jsonb,
               updated_at = now()
         where ${sql.raw(column)}::text like ${`%"${from}"%`}
      `);
    }
  }
  step("stored links to the retired categories repointed");

  step(
    `homepage copy updated for five service groups (${rewritten} section field${rewritten === 1 ? "" : "s"}` +
      `, ${faqRewritten} FAQ)`,
  );

  // --- 8. deletions, last --------------------------------------------------
  // Same cascade, on faqs.service_id this time.
  const rehomedFaqs = await protectServiceFaqs(tx, travelId);
  if (rehomedFaqs) step(`${rehomedFaqs} FAQ(s) moved to the surviving service`);

  const deleted = await tx
    .delete(services)
    .where(and(eq(services.categoryId, travelId), inArray(services.slug, DELETE_SERVICE_SLUGS)))
    .returning({ slug: services.slug });
  assert(
    deleted.length === DELETE_SERVICE_SLUGS.length,
    `expected to delete ${DELETE_SERVICE_SLUGS.length} services, deleted ${deleted.length}`,
  );

  const [{ stranded }] = await tx
    .select({ stranded: sql<number>`count(*)::int` })
    .from(services)
    .where(eq(services.subcategoryId, egyptToursId));
  assert(stranded === 0, `${stranded} services still sit in egypt-tours`);

  await tx.delete(serviceSubcategories).where(eq(serviceSubcategories.id, egyptToursId));
  step(`${deleted.length} duplicate services and the egypt-tours subcategory deleted`);

  // --- 8b. close the holes -------------------------------------------------
  // Deleting a row leaves a gap in `sort_order`, and merging a category brings
  // in a second run of numbers that interleaves with the first. Neither changes
  // what a visitor sees, and both would make a restructured database differ
  // from a freshly seeded one for no reason anybody could point at later.
  //
  // Relative order is preserved exactly, so an editor's own arrangement
  // survives: the only thing that changes is which integers express it. The
  // subcategory comes first in the ordering because that is the shape the
  // catalogue is defined in — a merged category's services belong in their own
  // block, not interleaved with the ones they arrived beside.
  await tx.execute(sql`
    update services s
       set sort_order = o.position, updated_at = now()
      from (
        select s2.id,
               (row_number() over (
                  partition by s2.category_id
                  order by coalesce(sc.sort_order, 9999), s2.sort_order, s2.id
                ))::int - 1 as position
          from services s2
          left join service_subcategories sc on sc.id = s2.subcategory_id
      ) o
     where o.id = s.id and s.sort_order <> o.position
  `);

  await tx.execute(sql`
    update service_categories c
       set sort_order = o.position, updated_at = now()
      from (
        select id, (row_number() over (order by sort_order, id))::int - 1 as position
          from service_categories
      ) o
     where o.id = c.id and c.sort_order <> o.position
  `);
  step("sort order renumbered contiguously (relative order unchanged)");

  // --- 9. invariants -------------------------------------------------------
  const after = await inventory(tx);
  log();
  printInventory("after", after);
  log();

  assert(after.byCategory.size === 5, `expected 5 categories, found ${after.byCategory.size}`);
  assert(after.services === 74, `expected 74 services, found ${after.services}`);
  assert(after.byCategory.get("travel-tourism") === 26, "Travel should hold 26 services");
  assert(after.byCategory.get("business-setup") === 14, "Business Setup should hold 14 services");
  assert(after.byCategory.get("iqama-services") === 13, "Iqama should hold 13 services");
  assert(after.byCategory.get("license-renewal") === 6, "License Renewal should hold 6 services");
  assert(after.byCategory.get("government-relations") === 15, "Government should hold 15 services");

  assert((await idOfCategory(tx, "company-formation")) === null, "company-formation still exists");
  assert((await idOfCategory(tx, "general-services")) === null, "general-services still exists");
  assert((await idOfCategory(tx, "iqama-services")) !== null, "iqama-services is missing");
  assert((await idOfSubcategory(tx, "egypt-tours")) === null, "egypt-tours still exists");

  const [{ orphans }] = await tx
    .select({ orphans: sql<number>`count(*)::int` })
    .from(services)
    .leftJoin(serviceCategories, eq(serviceCategories.id, services.categoryId))
    .where(isNull(serviceCategories.id));
  assert(orphans === 0, `${orphans} services have no category`);

  const dupes = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(services)
    .groupBy(services.categoryId, services.slug)
    .having(sql`count(*) > 1`);
  assert(dupes.length === 0, `${dupes.length} duplicate slugs within a category`);

  assert(
    after.packages.filter((p) => p.destinationId != null).length === 4,
    "expected 4 packages in the Egypt destination",
  );
  assert(
    after.packages.find((p) => p.slug === "custom-itinerary")?.destinationId == null,
    "custom-itinerary should belong to no destination",
  );

  // D3: nothing rewrites region. Compared as a sorted multiset.
  assert(
    JSON.stringify(after.regions) === JSON.stringify(before.regions),
    `region values changed: ${before.regions.join(",")} → ${after.regions.join(",")}`,
  );

  const [{ stale }] = await tx
    .select({ stale: sql<number>`count(*)::int` })
    .from(pageSections)
    .where(
      sql`published::text like '%"/services/company-formation"%'
          or published::text like '%"/services/general-services"%'
          or coalesce(draft::text, '') like '%"/services/company-formation"%'
          or coalesce(draft::text, '') like '%"/services/general-services"%'`,
    );
  assert(stale === 0, `${stale} section(s) still link to a retired category`);

  assert(after.egyptBlocks === 0, "an egypt-feature section survived");
  assert(after.destinationBlocks === before.egyptBlocks, "the destination section was lost");

  const [homePage] = await tx.select({ id: pages.id }).from(pages).where(eq(pages.slug, "home")).limit(1);
  if (homePage) {
    const [{ sections }] = await tx
      .select({ sections: sql<number>`count(*)::int` })
      .from(pageSections)
      .where(eq(pageSections.pageId, homePage.id));
    assert(sections === 13, `the homepage should still have 13 sections, found ${sections}`);
  }

  const navHrefs = await tx.select({ href: navigationItems.href }).from(navigationItems);
  const categorySlugs = new Set((await tx.select({ slug: serviceCategories.slug }).from(serviceCategories)).map((c) => c.slug));
  for (const { href } of navHrefs) {
    const match = /^\/services\/([a-z0-9-]+)/.exec(href);
    if (match) assert(categorySlugs.has(match[1]!), `navigation points at a missing category: ${href}`);
  }

  // Nothing is still sitting on the exact wording the old seed wrote: either it
  // was replaced above, or an editor had already changed it and it was reported.
  const [{ staleFaq }] = await tx
    .select({ staleFaq: sql<number>`count(*)::int` })
    .from(faqs)
    .where(
      and(
        eq(faqs.questionEn, FAQ_REWRITE.match),
        eq(faqs.questionAr, FAQ_REWRITE.was.questionAr),
        eq(faqs.answerEn, FAQ_REWRITE.was.answerEn),
        eq(faqs.answerAr, FAQ_REWRITE.was.answerAr),
      ),
    );
  assert(staleFaq === 0, "the General Services FAQ still holds its seeded wording");

  for (const rewrite of SECTION_REWRITES) {
    const rows = await tx
      .select({ published: pageSections.published })
      .from(pageSections)
      .innerJoin(pages, eq(pages.id, pageSections.pageId))
      .where(and(eq(pages.slug, rewrite.page), eq(pageSections.blockType, rewrite.blockType)));
    for (const row of rows) {
      const values = (row.published ?? {}) as Record<string, unknown>;
      assert(
        !(rewrite.field in values) || !same(values[rewrite.field], rewrite.was),
        `${rewrite.page}/${rewrite.blockType}.${rewrite.field} still holds its seeded value`,
      );
    }
  }

  const [{ orphanFaqs }] = await tx
    .select({ orphanFaqs: sql<number>`count(*)::int` })
    .from(faqs)
    .where(and(isNull(faqs.categoryId), isNull(faqs.serviceId), eq(faqs.scope, "category")));
  assert(orphanFaqs === 0, `${orphanFaqs} category FAQ(s) lost the category they belonged to`);

  step("all invariants hold");

  if (customised.length) {
    log();
    log("  Editor-owned content left untouched — check these by hand:");
    for (const note of customised) log(`    · ${note}`);
  }
}

/* -------------------------------------------------------------------------- */

async function main() {
  log(DRY_RUN ? "Restructure — DRY RUN (nothing will be committed)" : "Restructure — LIVE");
  log();

  try {
    await db.transaction(async (tx) => {
      await cutover(tx);
      if (DRY_RUN) throw ROLLBACK;
    });
  } catch (error) {
    if (error === ROLLBACK) {
      log();
      log(DRY_RUN ? "Rolled back. Nothing was written." : "Nothing to do. Rolled back.");
      process.exit(0);
    }
    log();
    console.error(error instanceof Error ? error.message : error);
    log();
    log("Rolled back. The database is exactly as it was.");
    process.exit(1);
  }

  log();
  log("Committed.");
  log();
  log("Next: refresh the running application's caches, or it will keep serving the");
  log("old catalogue for up to an hour. Sign in and open");
  log("    /admin/settings?tab=maintenance");
  log("then press “Refresh caches” — see DEPLOYMENT.md, section 9.1.");
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
