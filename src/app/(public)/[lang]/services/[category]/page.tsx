import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";

import { Breadcrumbs } from "@/components/site/breadcrumbs";
import { EditorBridge } from "@/components/site/editor-bridge";
import { FaqAccordion } from "@/components/site/faq-accordion";
import { JsonLd } from "@/components/site/json-ld";
import { MediaImage } from "@/components/site/media-image";
import { MotionRuntime } from "@/components/site/motion-runtime";
import { PreviewBanner } from "@/components/site/preview-banner";
import { Reveal } from "@/components/site/reveal";
import { copyOf, motionSignature, needsRuntime, RegionRoot, regionOf } from "@/components/site/route-region";
import { SectionHeading } from "@/components/site/section-heading";
import { ServiceCardGrid, type CardMarks } from "@/components/site/service-card";
import { StillPresentation } from "@/components/site/still-presentation";
import { Icon } from "@/components/ui/icon";
import { withNodeStyle } from "@/lib/cms/node";
import { isLocale, localeHref, pick, type Locale } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCategoryBySlug, getPackageCatalog, type ServiceRow } from "@/lib/queries/catalog";
import { getMediaMap } from "@/lib/queries/site";
import { listedServices, serviceLayout } from "@/lib/routes/category-model";
import { resolveCategoryRender } from "@/lib/routes/category-view";
import { documentEditorKey } from "@/lib/routes/owners";
import { hasPackageHub } from "@/lib/routes/package-hub";
import { breadcrumbJsonLd, buildMetadata, faqJsonLd } from "@/lib/seo";
import { recordStorage } from "@/lib/seo-model";
import { getSettings, whatsappLink } from "@/lib/settings";
import { categoryMove } from "@/lib/taxonomy-moves";

type Params = {
  params: Promise<{ lang: string; category: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Pick<Params, "params">) {
  const { lang, category: slug } = await params;
  if (!isLocale(lang)) return {};
  const category = await getCategoryBySlug(slug);
  // A retired slug renders no metadata: the page body issues the redirect, and
  // metadata for a page that will 308 away is metadata nobody reads.
  if (!category) return {};
  return buildMetadata({
    locale: lang,
    path: `/services/${slug}`,
    seo: recordStorage("category", slug, category.id),
    title: { en: category.titleEn, ar: category.titleAr },
    // Its summary, else its tagline — in each language on its own.
    description: {
      en: category.summaryEn.trim() || category.taglineEn,
      ar: category.summaryAr.trim() || category.taglineAr,
    },
    imageId: category.imageId,
  });
}

/** A call to action's destination: a site path in this edition, or an address as given. */
const ctaTarget = (locale: Locale, href: string): { href: string; external: boolean } =>
  href.startsWith("/") ? { href: localeHref(locale, href), external: false } : { href, external: true };

/**
 * A service category's page: hero, breadcrumbs, body, the services in their
 * groups, the Tour Packages panel where the route has one, and the
 * category's questions.
 *
 * Every region is drawn through `regionOf` (Batch 21), which gives it its
 * styles and motion everywhere and its Visual Editor identity in an authorised
 * editor canvas only — `resolveCategoryRender` decides which, from the
 * session. A visitor's page carries no editor attribute, no draft and no
 * bridge, and reads the same cached catalogue it always did.
 */
export default async function CategoryPage({ params, searchParams }: Params) {
  const { lang, category: slug } = await params;
  if (!isLocale(lang)) notFound();

  const [view, media, settings] = await Promise.all([
    resolveCategoryRender(slug, await searchParams),
    getMediaMap(),
    getSettings(),
  ]);

  if (!view) {
    // Absent from the database is the only condition under which a retired
    // address is recognised — so before the restructure these slugs resolve
    // normally and nothing here runs.
    const moved = categoryMove(slug);
    if (moved) permanentRedirect(localeHref(lang, moved));
    notFound();
  }

  const { category, groups, services, faqs: questions } = view.data;
  const dict = getDictionary(lang);
  const id = category.id;
  const image = category.imageId ? media.get(category.imageId) : null;
  const title = pick(lang, category.titleEn, category.titleAr);
  const whatsapp = whatsappLink(settings, lang, title);

  const hero = regionOf(view, { type: "category", id });
  const crumbs = regionOf(view, { type: "categoryCrumbs", id });
  const body = regionOf(view, { type: "categoryBody", id });
  const servicesRegion = regionOf(view, { type: "categoryServices", id });
  const faqsRegion = regionOf(view, { type: "categoryFaqs", id });
  const groupRegions = new Map(groups.map((group) => [group.id, regionOf(view, { type: "subcategory", id: group.id })]));
  const cardRegions = new Map(services.map((service) => [service.id, regionOf(view, { type: "service", id: service.id })]));
  const faqRegions = new Map(questions.map((faq) => [faq.id, regionOf(view, { type: "faq", id: faq.id })]));

  const faqs = questions.map((faq) => {
    const region = faqRegions.get(faq.id)!;
    return {
      id: faq.id,
      question: pick(lang, faq.questionEn, faq.questionAr),
      answer: pick(lang, faq.answerEn, faq.answerAr),
      marks: { item: region.root, question: region.node("field:question"), answer: region.node("field:answer") },
    };
  });
  // Structured data describes the page a visitor gets: only what is shown.
  const shownFaqs = faqs.filter((faq) => !view.hidden.has(`faq:${faq.id}`));

  const trail = [
    { name: dict.nav.home, path: "/" },
    { name: dict.common.services, path: "/services" },
    { name: title, path: `/services/${slug}` },
  ];

  // Featured first inside each group, then the editor's order — so the two
  // services a customer most often wants lead the list they are in. The same
  // layout decides the ItemList below, so the two cannot disagree.
  const { grouped, ungrouped } = serviceLayout({ groups, services });

  // The Tour Packages panel renders only where there is a catalogue to point
  // at: the route's own package-hub category, and at least one destination
  // that actually holds a published package.
  const hub = hasPackageHub(category) ? (await getPackageCatalog()).grouped : [];
  const hubRegion = hub.length ? regionOf(view, { type: "categoryHub", id }) : null;

  const cardMarks = (service: ServiceRow, intro: string): CardMarks => {
    const region = cardRegions.get(service.id)!;
    return {
      item: region.root,
      link: region.node("field:link"),
      badge: region.node("field:badge"),
      title: region.node.text("field:title", pick(lang, service.titleEn, service.titleAr)),
      intro: intro ? region.node.text("field:intro", intro) : null,
      action: region.node("field:action"),
      image: region.media("field:image"),
    };
  };

  const tagline = pick(lang, category.taglineEn, category.taglineAr);
  const summary = pick(lang, category.summaryEn, category.summaryAr);
  const bodyHtml = pick(lang, category.bodyEn, category.bodyAr);
  const cta = ctaTarget(lang, category.ctaHref || "/contact");
  const ctaLabel = pick(lang, category.ctaLabelEn, category.ctaLabelAr) || dict.nav.primaryCta;
  const iconAttrs = hero.node("field:icon");
  const titlePart = hero.node.text("field:title", title);
  const taglinePart = tagline ? hero.node.text("field:tagline", tagline) : null;
  const summaryPart = summary ? hero.node.text("field:summary", summary) : null;
  const backdrop = hero.media("field:image");

  const hubEyebrow = hubRegion
    ? hubRegion.node.text("field:eyebrow", copyOf(hubRegion, lang, "eyebrow", dict.common.tourPackages))
    : null;
  const hubHeading = hubRegion
    ? hubRegion.node.text(
        "field:heading",
        copyOf(hubRegion, lang, "heading", lang === "ar" ? "اختر وجهتك" : "Choose your destination"),
      )
    : null;
  const hubDescription = hubRegion
    ? hubRegion.node.text(
        "field:description",
        copyOf(
          hubRegion,
          lang,
          "description",
          lang === "ar"
            ? "برامج مُعدّة لكل وجهة — اختر واحداً كما هو أو اطلب تعديله."
            : "Prepared programmes for every destination — take one as it stands, or ask us to change it.",
        ),
      )
    : null;

  const regions = [
    hero,
    crumbs,
    body,
    servicesRegion,
    faqsRegion,
    ...groupRegions.values(),
    ...cardRegions.values(),
    ...faqRegions.values(),
    ...(hubRegion ? [hubRegion] : []),
  ];

  const page = (
    <>
      {view.mode === "preview" ? <PreviewBanner /> : null}

      <RegionRoot region={hero} className="relative overflow-clip pb-8 pt-[clamp(6.5rem,9vw,9rem)]">
        {image ? (
          <div {...backdrop.box} className="pointer-events-none absolute inset-0 -z-20">
            <MediaImage
              media={image}
              locale={lang}
              alt=""
              sizes="100vw"
              priority
              className="size-full object-cover opacity-25"
              {...backdrop.image}
            />
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
              {...iconAttrs}
              className="flex size-11 items-center justify-center rounded-[var(--radius-sm)] border border-line"
              style={withNodeStyle({ color: "var(--color-peach)" }, iconAttrs)}
            >
              <Icon name={category.icon} size={20} />
            </span>
            {taglinePart ? (
              <p {...taglinePart.attrs} className="eyebrow">
                {taglinePart.content}
              </p>
            ) : null}
          </div>

          <h1 {...titlePart.attrs} className="mt-5 max-w-3xl text-[length:var(--text-h1)]">
            {titlePart.content}
          </h1>
          {summaryPart ? (
            <p {...summaryPart.attrs} className="lede mt-5 max-w-2xl">
              {summaryPart.content}
            </p>
          ) : null}

          <div className="mt-8 flex flex-wrap gap-3">
            {cta.external ? (
              <a href={cta.href} {...hero.node("field:ctaLabel")} className="btn btn-primary">
                {ctaLabel}
                <Icon name="arrowRight" size={16} className="flip-rtl" />
              </a>
            ) : (
              <Link href={cta.href} {...hero.node("field:ctaLabel")} className="btn btn-primary">
                {ctaLabel}
                <Icon name="arrowRight" size={16} className="flip-rtl" />
              </Link>
            )}
            {whatsapp ? (
              <a
                href={whatsapp}
                target="_blank"
                rel="noopener noreferrer"
                {...hero.node("field:whatsapp")}
                className="btn btn-ghost"
              >
                <Icon name="whatsapp" size={16} strokeWidth={1.6} />
                {dict.common.whatsappUs}
              </a>
            ) : null}
          </div>
        </div>
      </RegionRoot>

      <Breadcrumbs
        locale={lang}
        label={dict.nav.breadcrumb}
        trail={trail}
        marks={{ nav: crumbs.root, list: crumbs.node("field:trail") }}
      />

      {bodyHtml || view.editor ? (
        <RegionRoot region={body} className="section-tight">
          <div className="shell">
            <Reveal className="max-w-3xl">
              {bodyHtml ? (
                <div {...body.node("field:body")} className="prose-eod" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
              ) : (
                // The editor canvas only: an empty body has nothing to click,
                // so the region says it is there and empty.
                <p className="route-placeholder">No category body yet. Select this region to write one.</p>
              )}
            </Reveal>
          </div>
        </RegionRoot>
      ) : null}

      <RegionRoot region={servicesRegion} className="section-tight">
        <div className="shell shell-wide">
          <SectionHeading
            eyebrow={copyOf(servicesRegion, lang, "eyebrow", dict.service.inThisCategory)}
            title={copyOf(servicesRegion, lang, "heading", dict.common.services)}
            editor={servicesRegion.editor}
            styles={servicesRegion.styles}
            motion={servicesRegion.motion}
            fields={{ eyebrow: "eyebrow", title: "heading" }}
          />

          <div className="mt-10 space-y-14">
            {grouped.map((group) => {
              const region = groupRegions.get(group.sub.id)!;
              const groupTitle = region.node.text("field:title", pick(lang, group.sub.titleEn, group.sub.titleAr));
              const groupSummary = pick(lang, group.sub.summaryEn, group.sub.summaryAr);
              const summaryText = groupSummary ? region.node.text("field:summary", groupSummary) : null;
              return (
                // The subcategory slug is the anchor the header dropdown points
                // at, so a menu entry can land on a group rather than the top of
                // a long page. scroll-padding-top on <html> keeps it clear of the
                // fixed header.
                <RegionRoot key={group.sub.id} region={region} as="div" id={group.sub.slug} className="scroll-mt-28">
                  <div className="mb-6">
                    <h3 {...groupTitle.attrs} className="text-[length:var(--text-h3)]">
                      {groupTitle.content}
                    </h3>
                    {summaryText ? (
                      <p {...summaryText.attrs} className="mt-2 max-w-2xl text-small text-muted">
                        {summaryText.content}
                      </p>
                    ) : null}
                  </div>
                  <ServiceCardGrid
                    rows={group.rows}
                    locale={lang}
                    categorySlug={slug}
                    categoryIcon={category.icon}
                    media={media}
                    learnMore={dict.common.learnMore}
                    marks={cardMarks}
                  />
                </RegionRoot>
              );
            })}

            {hubRegion && hubEyebrow && hubHeading && hubDescription ? (
              <Reveal>
                <RegionRoot region={hubRegion} as="div" className="panel p-7 sm:p-9">
                  <p {...hubEyebrow.attrs} className="eyebrow">
                    {hubEyebrow.content}
                  </p>
                  <h3 {...hubHeading.attrs} className="mt-4 text-[length:var(--text-h3)]">
                    {hubHeading.content}
                  </h3>
                  <p {...hubDescription.attrs} className="lede mt-3 max-w-2xl">
                    {hubDescription.content}
                  </p>
                  <ul {...hubRegion.node("field:destinations")} className="mt-7 flex flex-wrap gap-2.5">
                    {hub.map(({ destination, packages }) => (
                      <li key={destination.id}>
                        <Link href={localeHref(lang, `/packages/${destination.slug}`)} className="btn btn-ghost btn-sm">
                          {pick(lang, destination.titleEn, destination.titleAr)}
                          <span className="text-muted">{packages.length}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                  <div className="mt-7">
                    <Link
                      href={localeHref(lang, "/packages")}
                      {...hubRegion.node("field:ctaLabel")}
                      className="btn btn-primary btn-sm"
                    >
                      {copyOf(hubRegion, lang, "ctaLabel", dict.common.viewPackages)}
                      <Icon name="arrowRight" size={15} className="flip-rtl" />
                    </Link>
                  </div>
                </RegionRoot>
              </Reveal>
            ) : null}

            {ungrouped.length ? (
              <ServiceCardGrid
                rows={ungrouped}
                locale={lang}
                categorySlug={slug}
                categoryIcon={category.icon}
                media={media}
                learnMore={dict.common.learnMore}
                marks={cardMarks}
              />
            ) : null}
          </div>
        </div>
      </RegionRoot>

      {faqs.length ? (
        <RegionRoot region={faqsRegion} className="section-tight">
          <div className="shell shell-wide grid gap-10 lg:grid-cols-[0.75fr_1.25fr] lg:gap-16">
            <div className="lg:sticky lg:top-28 lg:self-start">
              <SectionHeading
                eyebrow={copyOf(faqsRegion, lang, "eyebrow", dict.sections.faqEyebrow)}
                title={copyOf(faqsRegion, lang, "heading", dict.service.faq)}
                editor={faqsRegion.editor}
                styles={faqsRegion.styles}
                motion={faqsRegion.motion}
                fields={{ eyebrow: "eyebrow", title: "heading" }}
              />
            </div>
            <FaqAccordion entries={faqs} />
          </div>
        </RegionRoot>
      ) : null}

      <JsonLd
        data={[
          breadcrumbJsonLd(lang, trail),
          ...(faqJsonLd(shownFaqs) ? [faqJsonLd(shownFaqs)!] : []),
          {
            "@context": "https://schema.org",
            "@type": "ItemList",
            name: title,
            // The cards a visitor gets — never a published service filed
            // under a hidden group, which the page draws nowhere.
            itemListElement: listedServices({ groups, services }, view.hidden).map((service, index) => ({
              "@type": "ListItem",
              position: index + 1,
              name: pick(lang, service.titleEn, service.titleAr),
              url: `${process.env.NEXT_PUBLIC_SITE_URL ?? ""}${localeHref(lang, `/services/${slug}/${service.slug}`)}`,
            })),
          },
        ]}
      />

      {needsRuntime(regions) ? (
        // The server's decision, not the browser's: live parallax is paused in
        // the Visual Editor's canvas and nowhere else.
        <MotionRuntime signature={motionSignature(regions)} parallax={view.editor ? "paused" : "live"} />
      ) : null}
      {view.editor ? (
        <EditorBridge
          bridgeId={view.editor.bridgeId}
          pageId={documentEditorKey({ kind: "category", id })}
          slug={view.routeKey}
          locale={lang}
        />
      ) : null}
    </>
  );

  return view.still ? <StillPresentation>{page}</StillPresentation> : page;
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
