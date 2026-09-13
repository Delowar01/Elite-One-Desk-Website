import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";

import { Breadcrumbs } from "@/components/site/breadcrumbs";
import { FaqAccordion } from "@/components/site/faq-accordion";
import { JsonLd } from "@/components/site/json-ld";
import { MediaImage } from "@/components/site/media-image";
import { Reveal } from "@/components/site/reveal";
import { SectionHeading } from "@/components/site/section-heading";
import { Icon } from "@/components/ui/icon";
import { isLocale, localeHref, pick } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCatalog, getCategoryBySlug, getFaqs, getPackageCatalog } from "@/lib/queries/catalog";
import { getMediaMap } from "@/lib/queries/site";
import { breadcrumbJsonLd, buildMetadata, faqJsonLd } from "@/lib/seo";
import { getSettings, whatsappLink } from "@/lib/settings";
import { categoryMove } from "@/lib/taxonomy-moves";
import { toPlainText } from "@/lib/cms/sanitize";

/**
 * The one category that fronts a package catalogue. A constant rather than a
 * column because exactly one does, and a column nobody would ever set twice is
 * a column that misleads the next reader.
 */
const PACKAGE_HUB_CATEGORY = "travel-tourism";

type Params = { params: Promise<{ lang: string; category: string }> };

export async function generateMetadata({ params }: Params) {
  const { lang, category: slug } = await params;
  if (!isLocale(lang)) return {};
  const category = await getCategoryBySlug(slug);
  // A retired slug renders no metadata: the page body issues the redirect, and
  // metadata for a page that will 308 away is metadata nobody reads.
  if (!category) return {};
  return buildMetadata({
    locale: lang,
    path: `/services/${slug}`,
    entityType: "category",
    entityKey: slug,
    title: pick(lang, category.titleEn, category.titleAr),
    description:
      pick(lang, category.summaryEn, category.summaryAr) ||
      pick(lang, category.taglineEn, category.taglineAr),
    imageId: category.imageId,
  });
}

export default async function CategoryPage({ params }: Params) {
  const { lang, category: slug } = await params;
  if (!isLocale(lang)) notFound();

  const [catalog, media, allFaqs, settings] = await Promise.all([
    getCatalog(),
    getMediaMap(),
    getFaqs(),
    getSettings(),
  ]);

  const category = catalog.categories.find((c) => c.slug === slug);
  if (!category) {
    // Absent from the database is the only condition under which a retired
    // address is recognised — so before the restructure these slugs resolve
    // normally and nothing here runs.
    const moved = categoryMove(slug);
    if (moved) permanentRedirect(localeHref(lang, moved));
    notFound();
  }

  const dict = getDictionary(lang);
  const services = catalog.byCategory.get(category.id) ?? [];
  const subs = catalog.subcategories.filter((s) => s.categoryId === category.id);
  const image = category.imageId ? media.get(category.imageId) : null;
  const title = pick(lang, category.titleEn, category.titleAr);
  const whatsapp = whatsappLink(settings, lang, title);

  const faqs = allFaqs
    .filter((faq) => faq.scope === "category" && faq.categoryId === category.id)
    .map((faq) => ({
      id: faq.id,
      question: pick(lang, faq.questionEn, faq.questionAr),
      answer: pick(lang, faq.answerEn, faq.answerAr),
    }));

  const trail = [
    { name: dict.nav.home, path: "/" },
    { name: dict.common.services, path: "/services" },
    { name: title, path: `/services/${slug}` },
  ];

  // Featured first inside each group, then the editor's order — so the two
  // services a customer most often wants lead the list they are in.
  const featuredFirst = (rows: typeof services) =>
    [...rows].sort((a, b) => Number(b.isFeatured) - Number(a.isFeatured));

  const grouped = subs
    .map((sub) => ({ sub, rows: featuredFirst(services.filter((s) => s.subcategoryId === sub.id)) }))
    .filter((group) => group.rows.length > 0);
  const ungrouped = featuredFirst(services.filter((s) => !s.subcategoryId));

  // The Tour Packages panel renders only where there is a catalogue to point
  // at: the right category, and at least one destination that actually holds a
  // published package. Before the data cutover that is false, so this page is
  // unchanged.
  const hub =
    slug === PACKAGE_HUB_CATEGORY ? (await getPackageCatalog()).grouped : [];

  return (
    <>
      <section className="relative overflow-clip pb-8 pt-[clamp(6.5rem,9vw,9rem)]">
        {image ? (
          <div className="pointer-events-none absolute inset-0 -z-20">
            <MediaImage media={image} locale={lang} alt="" sizes="100vw" priority className="size-full object-cover opacity-25" />
            <div
              className="absolute inset-0"
              style={{
                background:
                  "linear-gradient(to bottom, color-mix(in oklab, var(--color-ink-900) 84%, transparent), var(--color-ink-800))",
              }}
            />
          </div>
        ) : (
          <div className="grid-texture pointer-events-none absolute inset-0 -z-10" />
        )}

        <div className="shell shell-wide">
          <div className="flex items-center gap-3">
            <span
              className="flex size-11 items-center justify-center rounded-[var(--radius-sm)] border border-line"
              style={{ color: "var(--color-peach)" }}
            >
              <Icon name={category.icon} size={20} />
            </span>
            {pick(lang, category.taglineEn, category.taglineAr) ? (
              <p className="eyebrow">{pick(lang, category.taglineEn, category.taglineAr)}</p>
            ) : null}
          </div>

          <h1 className="mt-5 max-w-3xl text-[length:var(--text-h1)]">{title}</h1>
          {pick(lang, category.summaryEn, category.summaryAr) ? (
            <p className="lede mt-5 max-w-2xl">{pick(lang, category.summaryEn, category.summaryAr)}</p>
          ) : null}

          <div className="mt-8 flex flex-wrap gap-3">
            <Link href={localeHref(lang, "/contact")} className="btn btn-primary">
              {pick(lang, category.ctaLabelEn, category.ctaLabelAr) || dict.nav.primaryCta}
              <Icon name="arrowRight" size={16} className="flip-rtl" />
            </Link>
            {whatsapp ? (
              <a href={whatsapp} target="_blank" rel="noopener noreferrer" className="btn btn-ghost">
                <Icon name="whatsapp" size={16} strokeWidth={1.6} />
                {dict.common.whatsappUs}
              </a>
            ) : null}
          </div>
        </div>
      </section>

      <Breadcrumbs locale={lang} label={dict.nav.breadcrumb} trail={trail} />

      {pick(lang, category.bodyEn, category.bodyAr) ? (
        <section className="section-tight">
          <div className="shell">
            <Reveal className="max-w-3xl">
              <div
                className="prose-eod"
                dangerouslySetInnerHTML={{ __html: pick(lang, category.bodyEn, category.bodyAr) }}
              />
            </Reveal>
          </div>
        </section>
      ) : null}

      <section className="section-tight">
        <div className="shell shell-wide">
          <SectionHeading eyebrow={dict.service.inThisCategory} title={dict.common.services} />

          <div className="mt-10 space-y-12">
            {grouped.map((group) => (
              // The subcategory slug is the anchor the header dropdown points
              // at, so a menu entry can land on a group rather than the top of
              // a long page. scroll-padding-top on <html> keeps it clear of the
              // fixed header.
              <div key={group.sub.id} id={group.sub.slug} className="scroll-mt-28">
                <h3 className="mb-1.5 text-[length:var(--text-h3)]">
                  {pick(lang, group.sub.titleEn, group.sub.titleAr)}
                </h3>
                {pick(lang, group.sub.summaryEn, group.sub.summaryAr) ? (
                  <p className="mb-5 max-w-2xl text-small text-muted">
                    {pick(lang, group.sub.summaryEn, group.sub.summaryAr)}
                  </p>
                ) : null}
                <ServiceList rows={group.rows} lang={lang} categorySlug={slug} learnMore={dict.common.learnMore} />
              </div>
            ))}

            {hub.length ? (
              <Reveal>
                <div className="panel p-7 sm:p-9">
                  <p className="eyebrow">{dict.common.tourPackages}</p>
                  <h3 className="mt-4 text-[length:var(--text-h3)]">
                    {lang === "ar" ? "اختر وجهتك" : "Choose your destination"}
                  </h3>
                  <p className="lede mt-3 max-w-2xl">
                    {lang === "ar"
                      ? "برامج مُعدّة لكل وجهة — اختر واحداً كما هو أو اطلب تعديله."
                      : "Prepared programmes for every destination — take one as it stands, or ask us to change it."}
                  </p>
                  <ul className="mt-7 flex flex-wrap gap-2.5">
                    {hub.map(({ destination, packages }) => (
                      <li key={destination.id}>
                        <Link
                          href={localeHref(lang, `/packages/${destination.slug}`)}
                          className="btn btn-ghost btn-sm"
                        >
                          {pick(lang, destination.titleEn, destination.titleAr)}
                          <span className="text-muted">{packages.length}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-7">
                    <Link href={localeHref(lang, "/packages")} className="btn btn-primary btn-sm">
                      {dict.common.viewPackages}
                      <Icon name="arrowRight" size={15} className="flip-rtl" />
                    </Link>
                  </div>
                </div>
              </Reveal>
            ) : null}

            {ungrouped.length ? (
              <ServiceList rows={ungrouped} lang={lang} categorySlug={slug} learnMore={dict.common.learnMore} />
            ) : null}
          </div>
        </div>
      </section>

      {faqs.length ? (
        <section className="section-tight">
          <div className="shell shell-wide grid gap-10 lg:grid-cols-[0.75fr_1.25fr] lg:gap-16">
            <div className="lg:sticky lg:top-28 lg:self-start">
              <SectionHeading eyebrow={dict.sections.faqEyebrow} title={dict.service.faq} />
            </div>
            <FaqAccordion entries={faqs} />
          </div>
        </section>
      ) : null}

      <JsonLd
        data={[
          breadcrumbJsonLd(lang, trail),
          ...(faqJsonLd(faqs) ? [faqJsonLd(faqs)!] : []),
          {
            "@context": "https://schema.org",
            "@type": "ItemList",
            name: title,
            itemListElement: services.map((service, index) => ({
              "@type": "ListItem",
              position: index + 1,
              name: pick(lang, service.titleEn, service.titleAr),
              url: `${process.env.NEXT_PUBLIC_SITE_URL ?? ""}${localeHref(lang, `/services/${slug}/${service.slug}`)}`,
            })),
          },
        ]}
      />
    </>
  );
}

function ServiceList({
  rows,
  lang,
  categorySlug,
  learnMore,
}: {
  rows: Array<{ id: number; slug: string; titleEn: string; titleAr: string; introEn: string; introAr: string }>;
  lang: "en" | "ar";
  categorySlug: string;
  learnMore: string;
}) {
  return (
    <ul className="grid gap-px overflow-hidden rounded-[var(--radius-md)] border border-line sm:grid-cols-2">
      {rows.map((service, index) => (
        <Reveal
          as="li"
          key={service.id}
          delay={index * 40}
          className="bg-[var(--surface)]"
        >
          <Link
            href={localeHref(lang, `/services/${categorySlug}/${service.slug}`)}
            className="group flex h-full flex-col p-5 transition-colors hover:bg-[var(--surface-raised)]"
          >
            <span className="font-display text-[0.98rem] font-semibold leading-snug text-strong">
              {pick(lang, service.titleEn, service.titleAr)}
            </span>
            {pick(lang, service.introEn, service.introAr) ? (
              <span className="mt-2 line-clamp-2 text-small text-muted">
                {toPlainText(pick(lang, service.introEn, service.introAr), 150)}
              </span>
            ) : null}
            <span className="mt-auto flex items-center gap-1.5 pt-4 text-[0.8rem] font-semibold text-muted transition-colors group-hover:text-[var(--color-peach)]">
              {learnMore}
              <Icon name="arrowRight" size={13} className="flip-rtl" />
            </span>
          </Link>
        </Reveal>
      ))}
    </ul>
  );
}

/**
 * No `generateStaticParams` here, deliberately.
 *
 * Every public route renders per request: the layout reads the CSP nonce from
 * `headers()`, which opts the whole subtree out of prerendering. Enumerating
 * paths from the database therefore produced a list nothing was ever built
 * from — while making `next build` depend on the production schema. That is
 * what broke the release adding `travel_packages.destination_id`: the build
 * could not run until the column existed, and the column could not exist until
 * the build had run. See DEPLOYMENT.md §9.2.
 *
 * If prerendering is ever wanted, the nonce has to be solved first, and the
 * build's isolation from the database (deploy.sh step 7) reconsidered with it.
 */
