import Link from "next/link";
import { notFound } from "next/navigation";

import { Breadcrumbs } from "@/components/site/breadcrumbs";
import { EditorBridge } from "@/components/site/editor-bridge";
import { MediaImage } from "@/components/site/media-image";
import { MotionRuntime } from "@/components/site/motion-runtime";
import { PreviewBanner } from "@/components/site/preview-banner";
import { Reveal } from "@/components/site/reveal";
import { copyOf, motionSignature, needsRuntime, RegionRoot, regionOf } from "@/components/site/route-region";
import { StillPresentation } from "@/components/site/still-presentation";
import { Icon } from "@/components/ui/icon";
import { isLocale, localeHref, pick, plural } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCatalog } from "@/lib/queries/catalog";
import { getMediaMap } from "@/lib/queries/site";
import { documentEditorKey, SINGLETON_ID } from "@/lib/routes/owners";
import { resolveServiceIndexRender } from "@/lib/routes/package-view";
import { buildMetadata } from "@/lib/seo";
import { isLegacyTaxonomy } from "@/lib/taxonomy-state";

type Params = {
  params: Promise<{ lang: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * This page says in words how many groups the catalogue has, so the words have
 * to follow the data rather than the release.
 *
 * One build serves both states: before the cutover the database still holds the
 * six legacy categories and this page reads exactly as it always has; after it,
 * the approved five-group wording. The test is the shared taxonomy-state check,
 * not a count of rows — an editor adding a seventh category must not push the
 * site back into its old sentence.
 */
const COPY = {
  legacy: {
    intro: {
      en: "Six categories covering travel, business, residency, licensing and government-related support.",
      ar: "ست فئات رئيسية تغطي السفر والأعمال والإقامة والتراخيص والدعم المرتبط بالجهات الحكومية.",
    },
    description: {
      en: "Every Elite One Desk service: travel and tourism, business setup, company formation, general services, licence renewal and government relations.",
      ar: "جميع خدمات إيليت ون ديسك: السفر والسياحة، تأسيس الأعمال، تسجيل الشركات، الخدمات العامة، تجديد الرخص والعلاقات الحكومية.",
    },
  },
  restructured: {
    intro: {
      en: "Five service groups covering travel, business setup and company formation, residency and employee services, licensing and government support.",
      ar: "خمس مجموعات خدمات تغطي السفر، وتأسيس الأعمال والشركات، وخدمات الإقامة والموظفين، والتراخيص، والخدمات الحكومية.",
    },
    description: {
      en: "Every Elite One Desk service: travel and tourism, business setup and company formation, Iqama and employee services, license renewal and compliance, and government and general services.",
      ar: "جميع خدمات إيليت ون ديسك: السفر والسياحة، تأسيس الأعمال والشركات، خدمات الإقامة والموظفين، تجديد التراخيص والامتثال، والخدمات الحكومية والعامة.",
    },
  },
} as const;

/** `getCatalog` is cached and already loaded by the page, so this is free. */
async function copyForCatalogue() {
  const { categories, subcategories } = await getCatalog();
  return isLegacyTaxonomy(
    categories.map((category) => category.slug),
    subcategories.map((subcategory) => subcategory.slug),
  )
    ? COPY.legacy
    : COPY.restructured;
}

export async function generateMetadata({ params }: Pick<Params, "params">) {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  const copy = await copyForCatalogue();
  return buildMetadata({
    locale: lang,
    path: "/services",
    entityType: "page",
    entityKey: "services",
    title: lang === "ar" ? "الخدمات" : "Services",
    description: pick(lang, copy.description.en, copy.description.ar),
  });
}

/**
 * The catalogue overview. Categories are laid out as alternating editorial
 * rows with their subcategories listed underneath, so a visitor can see the
 * whole shape of what the company does on one screen without a grid of
 * identical tiles.
 *
 * Drawn through `regionOf` (Batch 24): the hero's wording is the overview's
 * own, edited here; every row is a service category's, drawn from the cached
 * catalogue in every mode and edited on that category's own page — so the
 * rows are one generated region that says so. A visitor's page carries no
 * editor attribute, no draft and no bridge.
 */
export default async function ServicesPage({ params, searchParams }: Params) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();

  const dict = getDictionary(lang);
  const [view, catalog, media, copy] = await Promise.all([
    resolveServiceIndexRender(await searchParams),
    getCatalog(),
    getMediaMap(),
    copyForCatalogue(),
  ]);
  if (!view) notFound();

  const id = SINGLETON_ID;
  const hero = regionOf(view, { type: "serviceIndexHero", id });
  const crumbs = regionOf(view, { type: "serviceIndexCrumbs", id });
  const rows = regionOf(view, { type: "serviceIndexCategories", id });
  const eyebrow = hero.node.text("field:eyebrow", copyOf(hero, lang, "eyebrow", dict.sections.servicesEyebrow));
  const heading = hero.node.text(
    "field:heading",
    copyOf(hero, lang, "heading", lang === "ar" ? "كل ما تحتاجه — من مكتب واحد" : "Everything you need, handled from one desk"),
  );
  const intro = hero.node.text("field:intro", copyOf(hero, lang, "intro", pick(lang, copy.intro.en, copy.intro.ar)));
  const regions = [hero, crumbs, rows];

  const page = (
    <>
      {view.mode === "preview" ? <PreviewBanner /> : null}

      <RegionRoot region={hero} atmosphere="landing" className="relative overflow-clip pb-10 pt-[clamp(6.5rem,9vw,9rem)]">
        <div className="grid-texture pointer-events-none absolute inset-0 -z-10" />
        <div className="shell shell-wide">
          <p {...eyebrow.attrs} className="eyebrow">
            {eyebrow.content}
          </p>
          <h1 {...heading.attrs} className="mt-5 max-w-3xl text-[length:var(--text-h1)]">
            {heading.content}
          </h1>
          <p {...intro.attrs} className="lede mt-5 max-w-2xl">
            {intro.content}
          </p>
        </div>
      </RegionRoot>

      <Breadcrumbs
        locale={lang}
        label={dict.nav.breadcrumb}
        trail={[
          { name: dict.nav.home, path: "/" },
          { name: dict.common.services, path: "/services" },
        ]}
        marks={{ nav: crumbs.root, list: crumbs.node("field:trail") }}
      />

      <RegionRoot region={rows} as="div" className="shell shell-wide pb-[var(--spacing-section)] pt-10">
        <div {...rows.node("field:categories")}>
          {catalog.categories.map((category, index) => {
            const services = catalog.byCategory.get(category.id) ?? [];
            const subs = catalog.subcategories.filter((s) => s.categoryId === category.id);
            const image = category.imageId ? media.get(category.imageId) : null;
            const href = `/services/${category.slug}`;

            return (
              <Reveal
                key={category.id}
                className="grid items-start gap-8 border-t border-line py-11 lg:grid-cols-[0.42fr_0.58fr] lg:gap-14"
              >
                <div className={index % 2 === 1 ? "lg:order-2" : undefined}>
                  <div className="flex items-center gap-3">
                    <span
                      className="flex size-10 items-center justify-center rounded-[var(--radius-sm)] border border-line"
                      style={{ color: "var(--color-peach)" }}
                    >
                      <Icon name={category.icon} size={19} />
                    </span>
                    <span className="font-display text-[0.72rem] font-semibold tabular-nums text-muted">
                      {String(index + 1).padStart(2, "0")}
                    </span>
                  </div>

                  <h2 className="mt-5 text-[length:var(--text-h2)]">
                    <Link href={localeHref(lang, href)} className="transition-colors hover:text-[var(--color-peach)]">
                      {pick(lang, category.titleEn, category.titleAr)}
                    </Link>
                  </h2>
                  <p className="mt-3 max-w-md text-body">
                    {pick(lang, category.summaryEn, category.summaryAr) ||
                      pick(lang, category.taglineEn, category.taglineAr)}
                  </p>

                  <div className="mt-6 flex flex-wrap items-center gap-4">
                    <Link href={localeHref(lang, href)} className="btn btn-ghost btn-sm">
                      {dict.common.learnMore}
                      <Icon name="arrowRight" size={15} className="flip-rtl" />
                    </Link>
                    {services.length ? (
                      <span className="text-[0.78rem] text-muted">{plural(lang, dict.service.servicesCount, services.length)}</span>
                    ) : null}
                  </div>

                  {image ? (
                    <div className="mt-7 hidden overflow-hidden rounded-[var(--radius-lg)] border border-line lg:block">
                      <MediaImage
                        media={image}
                        locale={lang}
                        alt=""
                        sizes="(max-width: 1024px) 0px, 36vw"
                        ratio="16 / 9"
                        className="w-full"
                      />
                    </div>
                  ) : null}
                </div>

                <div className={index % 2 === 1 ? "lg:order-1" : undefined}>
                  {subs.length ? (
                    <div className="grid gap-7 sm:grid-cols-2">
                      {subs.map((sub) => {
                        const inSub = services.filter((s) => s.subcategoryId === sub.id);
                        if (!inSub.length) return null;
                        return (
                          <div key={sub.id}>
                            <h3 className="mb-3 text-[0.8rem] font-semibold uppercase tracking-[0.1em] text-muted rtl:tracking-normal">
                              {pick(lang, sub.titleEn, sub.titleAr)}
                            </h3>
                            <ul className="space-y-1.5">
                              {inSub.map((service) => (
                                <li key={service.id}>
                                  <Link
                                    href={localeHref(lang, `/services/${category.slug}/${service.slug}`)}
                                    className="group inline-flex items-start gap-2 text-[0.87rem] text-body transition-colors hover:text-strong"
                                  >
                                    <Icon
                                      name="chevronRight"
                                      size={12}
                                      className="mt-1.5 shrink-0 flip-rtl opacity-40 transition-opacity group-hover:opacity-90"
                                    />
                                    {pick(lang, service.titleEn, service.titleAr)}
                                  </Link>
                                </li>
                              ))}
                            </ul>
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <ul className="grid gap-1.5 sm:grid-cols-2">
                      {services.map((service) => (
                        <li key={service.id}>
                          <Link
                            href={localeHref(lang, `/services/${category.slug}/${service.slug}`)}
                            className="group inline-flex items-start gap-2 text-[0.87rem] text-body transition-colors hover:text-strong"
                          >
                            <Icon
                              name="chevronRight"
                              size={12}
                              className="mt-1.5 shrink-0 flip-rtl opacity-40 transition-opacity group-hover:opacity-90"
                            />
                            {pick(lang, service.titleEn, service.titleAr)}
                          </Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Reveal>
            );
          })}
        </div>
      </RegionRoot>

      {needsRuntime(regions) ? (
        // The server's decision, not the browser's: live parallax is paused in
        // the Visual Editor's canvas and nowhere else.
        <MotionRuntime signature={motionSignature(regions)} parallax={view.editor ? "paused" : "live"} />
      ) : null}
      {view.editor ? (
        <EditorBridge
          bridgeId={view.editor.bridgeId}
          pageId={documentEditorKey({ kind: "serviceIndex", id })}
          slug={view.routeKey}
          locale={lang}
        />
      ) : null}
    </>
  );

  return view.still ? <StillPresentation>{page}</StillPresentation> : page;
}
