import Link from "next/link";
import { notFound, permanentRedirect } from "next/navigation";

import { Breadcrumbs } from "@/components/site/breadcrumbs";
import { EditorBridge } from "@/components/site/editor-bridge";
import { EnquiryForm } from "@/components/site/enquiry-form";
import { FaqAccordion, type FaqEntry } from "@/components/site/faq-accordion";
import { JsonLd } from "@/components/site/json-ld";
import { MediaImage } from "@/components/site/media-image";
import { MotionRuntime } from "@/components/site/motion-runtime";
import { PreviewBanner } from "@/components/site/preview-banner";
import { Reveal } from "@/components/site/reveal";
import { copyOf, motionSignature, needsRuntime, RegionRoot, regionOf } from "@/components/site/route-region";
import { StillPresentation } from "@/components/site/still-presentation";
import { Icon } from "@/components/ui/icon";
import { withNodeStyle } from "@/lib/cms/node";
import { toPlainText } from "@/lib/cms/sanitize";
import { isLocale, localeHref, pick } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCatalog } from "@/lib/queries/catalog";
import { getMediaMap } from "@/lib/queries/site";
import { documentEditorKey, type RouteOwner } from "@/lib/routes/owners";
import { questionsOf } from "@/lib/routes/service-model";
import { resolveServiceRender } from "@/lib/routes/service-view";
import { breadcrumbJsonLd, buildMetadata, faqJsonLd } from "@/lib/seo";
import { recordStorage } from "@/lib/seo-model";
import { getSettings, whatsappLink } from "@/lib/settings";
import { serviceMove } from "@/lib/taxonomy-moves";

type Params = {
  params: Promise<{ lang: string; category: string; service: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/** The published page's rows, for its metadata: the same cached catalogue every visitor's page reads. */
async function load(categorySlug: string, serviceSlug: string) {
  const catalog = await getCatalog();
  const category = catalog.categories.find((c) => c.slug === categorySlug);
  if (!category) return null;
  const service = (catalog.byCategory.get(category.id) ?? []).find((s) => s.slug === serviceSlug);
  if (!service) return null;
  return { catalog, category, service };
}

/**
 * Metadata is always the published page's. A preview, a canvas and a
 * comparison are never indexed and never cached (the middleware says so), so
 * their `<title>` has nothing to gain from a draft — and a draft title in a
 * `<title>` is one more place it could be mistaken for the live one.
 */
export async function generateMetadata({ params }: Pick<Params, "params">) {
  const { lang, category, service } = await params;
  if (!isLocale(lang)) return {};
  const found = await load(category, service);
  if (!found) return {};
  return buildMetadata({
    locale: lang,
    path: `/services/${category}/${service}`,
    seo: recordStorage("service", `${category}/${service}`, found.service.id),
    title: { en: found.service.titleEn, ar: found.service.titleAr },
    description: { en: toPlainText(found.service.introEn, 300), ar: toPlainText(found.service.introAr, 300) },
    imageId: found.service.imageId,
    type: "article",
  });
}

/**
 * The service detail template (§12). Every block below disappears when its
 * field is empty, so a service with only an intro is a clean short page rather
 * than a page of empty headings — which is what lets one template carry
 * seventy very different services.
 *
 * Every part of it is drawn through `regionOf` (Batch 22), which gives it its
 * published styles and motion everywhere and its Visual Editor identity in an
 * authorised editor canvas only — `resolveServiceRender` decides which, from
 * the session. A visitor's page carries no editor attribute, no draft and no
 * bridge, and reads the same cached catalogue it always did. In the canvas an
 * empty section is drawn as a placeholder instead of nothing, so it can be
 * selected and written; no visitor ever sees one.
 */
export default async function ServicePage({ params, searchParams }: Params) {
  const { lang, category: categorySlug, service: serviceSlug } = await params;
  if (!isLocale(lang)) notFound();

  const [view, catalog, media, settings] = await Promise.all([
    resolveServiceRender(categorySlug, serviceSlug, await searchParams),
    getCatalog(),
    getMediaMap(),
    getSettings(),
  ]);

  if (!view) {
    // Only a slug the database does not have reaches the move map, so this is
    // inert until the restructure retires the address.
    const moved = serviceMove(categorySlug, serviceSlug);
    if (moved) permanentRedirect(localeHref(lang, moved));
    notFound();
  }

  const { service, category } = view.data;
  const dict = getDictionary(lang);
  const id = service.id;
  const editing = Boolean(view.editor);

  const region = (type: RouteOwner["type"]) => regionOf(view, { type, id });
  const hero = region("serviceHero");
  const crumbs = region("serviceCrumbs");
  const overview = region("serviceOverview");
  const benefitsRegion = region("serviceBenefits");
  const audienceRegion = region("serviceAudience");
  const requirementsRegion = region("serviceRequirements");
  const processRegion = region("serviceProcess");
  const notesRegion = region("serviceNotes");
  const faqsRegion = region("serviceFaqs");
  const noticesRegion = region("serviceNotices");
  const requestRegion = region("serviceRequest");
  const relatedRegion = region("serviceRelated");
  const faqRegions = new Map(view.data.faqs.map((faq) => [faq.id, regionOf(view, { type: "faq", id: faq.id })]));

  const title = pick(lang, service.titleEn, service.titleAr);
  const categoryTitle = pick(lang, category.titleEn, category.titleAr);
  const intro = pick(lang, service.introEn, service.introAr);
  const timeline = pick(lang, service.timelineEn, service.timelineAr);
  const image = service.imageId ? media.get(service.imageId) : null;
  const whatsapp = whatsappLink(settings, lang, title);

  const local = (list: Array<{ en: string; ar: string }> | null | undefined) =>
    (list ?? []).map((item) => pick(lang, item.en, item.ar)).filter(Boolean);

  const benefits = local(service.benefits);
  const audience = local(service.audience);
  const requirements = local(service.requirements);
  const steps = (service.processSteps ?? [])
    .map((step) => ({
      label: pick(lang, step.en, step.ar),
      detail: pick(lang, step.detailEn, step.detailAr),
    }))
    .filter((step) => step.label);
  const bodyHtml = pick(lang, service.bodyEn, service.bodyAr);
  const notesHtml = pick(lang, service.notesEn, service.notesAr);

  // The service's own questions are regions of this page; its category's are
  // shown between them and edited on the category's page.
  const own = new Set(view.data.faqs.map((faq) => faq.id));
  const faqs: (FaqEntry & { shown: boolean })[] = questionsOf(view.data).map((faq) => {
    const mine = faqRegions.get(faq.id);
    return {
      id: faq.id,
      question: pick(lang, faq.questionEn, faq.questionAr),
      answer: pick(lang, faq.answerEn, faq.answerAr),
      ...(own.has(faq.id) && mine
        ? { marks: { item: mine.root, question: mine.node("field:question"), answer: mine.node("field:answer") } }
        : {}),
      shown: !view.hidden.has(`faq:${faq.id}`),
    };
  });
  // Structured data describes the page a visitor gets: only what is shown.
  const shownFaqs = faqs.filter((faq) => faq.shown);
  const inheritedCount = view.data.inherited.length;

  const related = (catalog.byCategory.get(category.id) ?? []).filter((s) => s.id !== service.id).slice(0, 4);

  const trail = [
    { name: dict.nav.home, path: "/" },
    { name: dict.common.services, path: "/services" },
    { name: categoryTitle, path: `/services/${categorySlug}` },
    { name: title, path: `/services/${categorySlug}/${serviceSlug}` },
  ];

  // Visa services get the embassy-decides notice on top of the standing
  // government one; both are editable in Site Settings.
  const isVisa = /visa/i.test(service.slug) || /visa/i.test(category.slug);
  const disclaimers = [
    settings.disclaimers.showOnServicePages
      ? pick(lang, settings.disclaimers.governmentEn, settings.disclaimers.governmentAr)
      : "",
    isVisa ? pick(lang, settings.disclaimers.visaEn, settings.disclaimers.visaAr) : "",
  ].filter(Boolean);

  const titlePart = hero.node.text("field:title", title);
  const introPart = intro ? hero.node.text("field:intro", intro) : null;
  const timelinePart = timeline ? hero.node.text("field:timeline", timeline) : null;
  const ctaLabel = copyOf(hero, lang, "ctaLabel", dict.common.requestService);
  const picture = hero.media("field:image");

  /** A section's heading: its own wording for this edition, else the standard one. */
  const heading = (owner: ReturnType<typeof region>, standard: string, className = "mb-5 text-[length:var(--text-h3)]") => {
    const part = owner.node.text("field:heading", copyOf(owner, lang, "heading", standard));
    return (
      <h2 {...part.attrs} className={className}>
        {part.content}
      </h2>
    );
  };
  // The ruled list paints its own border colour; an override composes with it.
  const requirementsList = requirementsRegion.node("field:requirements");

  /** What the canvas shows for a section with nothing in it yet. Never a visitor. */
  const placeholder = (words: string) => <p className="route-placeholder">{words}</p>;

  const regions = [
    hero,
    crumbs,
    overview,
    benefitsRegion,
    audienceRegion,
    requirementsRegion,
    processRegion,
    notesRegion,
    faqsRegion,
    ...faqRegions.values(),
    noticesRegion,
    requestRegion,
    relatedRegion,
  ];

  const page = (
    <>
      {view.mode === "preview" ? <PreviewBanner /> : null}

      <RegionRoot region={hero} className="relative overflow-clip pb-8 pt-[clamp(6.5rem,9vw,9rem)]">
        <div className="grid-texture pointer-events-none absolute inset-0 -z-10" />
        <div className="shell shell-wide grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
          <div>
            <Link
              href={localeHref(lang, `/services/${categorySlug}`)}
              {...hero.node("field:category")}
              className="eyebrow transition-opacity hover:opacity-75"
            >
              {categoryTitle}
            </Link>
            <h1 {...titlePart.attrs} className="mt-5 max-w-2xl text-[length:var(--text-h1)]">
              {titlePart.content}
            </h1>
            {introPart ? (
              <p {...introPart.attrs} className="lede mt-5 max-w-xl">
                {introPart.content}
              </p>
            ) : null}

            <div className="mt-8 flex flex-wrap gap-3">
              <a href="#request" {...hero.node("field:ctaLabel")} className="btn btn-primary">
                {ctaLabel}
                <Icon name="arrowRight" size={16} className="flip-rtl" />
              </a>
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

            {timelinePart ? (
              <p className="mt-6 inline-flex items-center gap-2 rounded-full border border-line px-3.5 py-2 text-[0.8rem] text-muted">
                <Icon name="clock" size={14} />
                <span className="font-medium text-body">{dict.service.timeline}:</span>
                <span {...timelinePart.attrs}>{timelinePart.content}</span>
              </p>
            ) : null}
          </div>

          {image ? (
            <div {...picture.box} className="overflow-hidden rounded-[var(--radius-lg)] border border-line">
              <MediaImage
                media={image}
                locale={lang}
                sizes="(max-width: 1024px) 92vw, 42vw"
                ratio="4 / 3"
                priority
                className="w-full"
                {...picture.image}
              />
            </div>
          ) : null}
        </div>
      </RegionRoot>

      <Breadcrumbs
        locale={lang}
        label={dict.nav.breadcrumb}
        trail={trail}
        marks={{ nav: crumbs.root, list: crumbs.node("field:trail") }}
      />

      <div className="shell shell-wide grid gap-12 py-12 lg:grid-cols-[1.15fr_0.85fr] lg:gap-16">
        <div className="min-w-0">
          {bodyHtml || editing ? (
            <Reveal nodeAttrs={overview.root}>
              {heading(overview, dict.service.overview)}
              {bodyHtml ? (
                <div {...overview.node("field:body")} className="prose-eod" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
              ) : (
                placeholder("No overview yet. Select this section to write one.")
              )}
            </Reveal>
          ) : null}

          {benefits.length || editing ? (
            <Reveal className="mt-12" nodeAttrs={benefitsRegion.root}>
              {heading(benefitsRegion, dict.service.benefits)}
              {benefits.length ? (
                <ul {...benefitsRegion.node("field:benefits")} className="grid gap-3 sm:grid-cols-2">
                  {benefits.map((item) => (
                    <li key={item} className="flex items-start gap-2.5 text-small text-body">
                      <Icon name="check" size={15} className="mt-1 shrink-0" style={{ color: "var(--color-orange)" }} />
                      {item}
                    </li>
                  ))}
                </ul>
              ) : (
                placeholder("No benefits yet. Select this section to add some.")
              )}
            </Reveal>
          ) : null}

          {audience.length || editing ? (
            <Reveal className="mt-12" nodeAttrs={audienceRegion.root}>
              {heading(audienceRegion, dict.service.audience)}
              {audience.length ? (
                <ul {...audienceRegion.node("field:audience")} className="flex flex-wrap gap-2">
                  {audience.map((item) => (
                    <li key={item} className="rounded-full border border-line px-3.5 py-2 text-[0.82rem] text-body">
                      {item}
                    </li>
                  ))}
                </ul>
              ) : (
                placeholder("Nobody listed yet. Select this section to say who this service is for.")
              )}
            </Reveal>
          ) : null}

          {requirements.length || editing ? (
            <Reveal className="mt-12" nodeAttrs={requirementsRegion.root}>
              {heading(requirementsRegion, dict.service.requirements)}
              {requirements.length ? (
                <ul
                  {...requirementsList}
                  className="divide-y border-y"
                  style={withNodeStyle({ borderColor: "var(--border-color)" }, requirementsList)}
                >
                  {requirements.map((item) => (
                    <li key={item} className="flex items-start gap-3 py-3 text-small text-body">
                      <Icon name="fileText" size={15} className="mt-0.5 shrink-0 text-muted" />
                      {item}
                    </li>
                  ))}
                </ul>
              ) : (
                placeholder("No requirements yet. Select this section to list them.")
              )}
            </Reveal>
          ) : null}

          {steps.length || editing ? (
            <Reveal className="mt-12" nodeAttrs={processRegion.root}>
              {heading(processRegion, dict.service.process, "mb-6 text-[length:var(--text-h3)]")}
              {steps.length ? (
                <ol {...processRegion.node("field:steps")} className="relative">
                  <span
                    aria-hidden
                    className="absolute inset-y-0 w-px"
                    style={{ insetInlineStart: "1.125rem", background: "var(--border-color)" }}
                  />
                  {steps.map((step, index) => (
                    <li key={step.label} className="relative ps-12 pb-7 last:pb-0">
                      <span
                        className="absolute top-0 flex size-9 items-center justify-center rounded-full border font-display text-[0.72rem] font-bold tabular-nums"
                        style={{
                          insetInlineStart: 0,
                          borderColor: "color-mix(in oklab, var(--color-orange) 45%, transparent)",
                          background: "var(--color-ink-800)",
                          color: "var(--color-peach)",
                        }}
                      >
                        {String(index + 1).padStart(2, "0")}
                      </span>
                      <h3 className="pt-1.5 text-[0.98rem]">{step.label}</h3>
                      {step.detail ? <p className="mt-1.5 text-small text-muted">{step.detail}</p> : null}
                    </li>
                  ))}
                </ol>
              ) : (
                placeholder("No steps yet. Select this section to describe how the process runs.")
              )}
            </Reveal>
          ) : null}

          {notesHtml || editing ? (
            <Reveal className="mt-12" nodeAttrs={notesRegion.root}>
              {heading(notesRegion, dict.service.notes, "mb-4 text-[length:var(--text-h3)]")}
              {notesHtml ? (
                <div
                  {...notesRegion.node("field:notes")}
                  className="prose-eod rounded-[var(--radius-md)] border border-line p-5 text-small"
                  dangerouslySetInnerHTML={{ __html: notesHtml }}
                />
              ) : (
                placeholder("No notes yet. Select this section to add any conditions or caveats.")
              )}
            </Reveal>
          ) : null}

          {faqs.length || editing ? (
            <Reveal className="mt-12" nodeAttrs={faqsRegion.root}>
              {heading(faqsRegion, dict.service.faq, "mb-4 text-[length:var(--text-h3)]")}
              {editing && inheritedCount ? (
                <p {...faqsRegion.node("field:inherited")} className="route-placeholder mb-4">
                  {inheritedCount === 1
                    ? `One question here belongs to “${category.titleEn}” and is edited on the category's page.`
                    : `${inheritedCount} questions here belong to “${category.titleEn}” and are edited on the category's page.`}
                </p>
              ) : null}
              {faqs.length ? (
                <FaqAccordion entries={faqs} />
              ) : (
                placeholder("No questions for this service yet. Questions are added on the FAQs screen.")
              )}
            </Reveal>
          ) : null}

          {disclaimers.length ? (
            <RegionRoot region={noticesRegion} as="div" className="mt-12">
              <div {...noticesRegion.node("field:notes")} className="space-y-3">
                {disclaimers.map((note) => (
                  <p
                    key={note.slice(0, 40)}
                    className="rounded-[var(--radius-md)] border border-line bg-[color-mix(in_oklab,var(--color-warm)_3%,transparent)] p-4 text-[0.78rem] leading-relaxed text-muted"
                  >
                    {note}
                  </p>
                ))}
              </div>
            </RegionRoot>
          ) : null}
        </div>

        <RegionRoot region={requestRegion} as="aside" className="min-w-0">
          <div id="request" className="lg:sticky lg:top-28 scroll-mt-28">
            {(() => {
              const formHeading = requestRegion.node.text("field:heading", copyOf(requestRegion, lang, "heading", dict.form.heading));
              const formIntro = requestRegion.node.text("field:intro", copyOf(requestRegion, lang, "intro", dict.form.subheading));
              return (
                <>
                  <h2 {...formHeading.attrs} className="mb-1.5 text-[length:var(--text-h3)]">
                    {formHeading.content}
                  </h2>
                  <p {...formIntro.attrs} className="mb-5 text-small text-muted">
                    {formIntro.content}
                  </p>
                </>
              );
            })()}
            <div {...requestRegion.node("field:form")}>
              <EnquiryForm
                locale={lang}
                dict={dict}
                categories={catalog.categories.map((c) => ({
                  id: c.id,
                  title: pick(lang, c.titleEn, c.titleAr),
                }))}
                services={catalog.services.map((s) => ({
                  id: s.id,
                  categoryId: s.categoryId,
                  title: pick(lang, s.titleEn, s.titleAr),
                  preset: s.formPreset,
                }))}
                initialCategoryId={category.id}
                initialServiceId={service.id}
              />
            </div>
          </div>
        </RegionRoot>
      </div>

      {related.length ? (
        <RegionRoot region={relatedRegion} className="section-tight border-t border-line">
          <div className="shell shell-wide">
            {heading(relatedRegion, dict.common.relatedServices, "mb-6 text-[length:var(--text-h3)]")}
            <ul {...relatedRegion.node("field:items")} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {related.map((item) => (
                <li key={item.id}>
                  <Link
                    href={localeHref(lang, `/services/${categorySlug}/${item.slug}`)}
                    className="group flex h-full flex-col rounded-[var(--radius-md)] border border-line p-4 transition-colors hover:border-[color-mix(in_oklab,var(--color-peach)_45%,transparent)]"
                  >
                    <span className="text-[0.9rem] font-semibold leading-snug text-strong">
                      {pick(lang, item.titleEn, item.titleAr)}
                    </span>
                    <Icon
                      name="arrowUpRight"
                      size={14}
                      className="mt-auto flip-rtl pt-3 text-muted transition-colors group-hover:text-[var(--color-peach)]"
                    />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </RegionRoot>
      ) : null}

      <JsonLd
        data={[
          breadcrumbJsonLd(lang, trail),
          ...(faqJsonLd(shownFaqs) ? [faqJsonLd(shownFaqs)!] : []),
          {
            "@context": "https://schema.org",
            "@type": "Service",
            name: title,
            serviceType: categoryTitle,
            description: toPlainText(intro, 300),
            areaServed: { "@type": "Country", name: "Saudi Arabia" },
            provider: {
              "@type": "Organization",
              name: pick(lang, settings.brand.legalNameEn, settings.brand.legalNameAr),
              url: process.env.NEXT_PUBLIC_SITE_URL ?? "",
            },
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
          pageId={documentEditorKey({ kind: "service", id })}
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
