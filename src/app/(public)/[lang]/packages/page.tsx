import Link from "next/link";
import { notFound } from "next/navigation";

import { Breadcrumbs } from "@/components/site/breadcrumbs";
import { EditorBridge } from "@/components/site/editor-bridge";
import { MotionRuntime } from "@/components/site/motion-runtime";
import { PackageCard, type PackageCardMarks } from "@/components/site/package-card";
import { PreviewBanner } from "@/components/site/preview-banner";
import { Reveal } from "@/components/site/reveal";
import { copyOf, motionSignature, needsRuntime, RegionRoot, regionOf, type Region } from "@/components/site/route-region";
import { StillPresentation } from "@/components/site/still-presentation";
import { Icon } from "@/components/ui/icon";
import type { NodeAttrs } from "@/lib/cms/node";
import { isLocale, localeHref, pick } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import type { PackageRow } from "@/lib/queries/catalog";
import { getMediaMap } from "@/lib/queries/site";
import { groupCatalogue } from "@/lib/routes/catalogue-model";
import { documentEditorKey, SINGLETON_ID } from "@/lib/routes/owners";
import { resolveCatalogueRender } from "@/lib/routes/package-view";
import { buildMetadata } from "@/lib/seo";
import { PACKAGES_OVERVIEW_META } from "@/lib/seo-defaults";
import { overviewStorage } from "@/lib/seo-model";

type Params = {
  params: Promise<{ lang: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * LEGACY. The grouping this page used before destinations existed, kept for
 * exactly one situation: a database where no destination yet holds a package.
 * It is what makes shipping the destination work invisible until the data
 * cutover happens, rather than dropping every package into one unnamed group
 * on the day the code deploys. The cleanup release deletes it.
 */
const REGION_LABELS: Record<string, { en: string; ar: string }> = {
  egypt: { en: "Egypt", ar: "مصر" },
  international: { en: "International", ar: "دولي" },
  holiday: { en: "Holiday", ar: "عطلات" },
  corporate: { en: "Corporate", ar: "شركات" },
};

export async function generateMetadata({ params }: Pick<Params, "params">) {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return buildMetadata({
    locale: lang,
    path: "/packages",
    seo: overviewStorage("packageIndex"),
    title: PACKAGES_OVERVIEW_META.title,
    description: PACKAGES_OVERVIEW_META.description,
  });
}

/**
 * The package catalogue: hero, breadcrumbs, then every published package —
 * grouped under its destination, with "Build your own" for the ones filed
 * under none.
 *
 * Every region is drawn through `regionOf` (Batch 24, as the category page
 * since Batch 21): its styles and motion everywhere, its Visual Editor identity
 * in an authorised editor canvas only. `resolveCatalogueRender` decides which,
 * from the session; a visitor's page carries no editor attribute, no draft and
 * no bridge, and reads the same cached catalogue it always did.
 */
export default async function PackagesPage({ params, searchParams }: Params) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();

  const [view, media] = await Promise.all([resolveCatalogueRender(await searchParams), getMediaMap()]);
  if (!view) notFound();

  const dict = getDictionary(lang);
  const id = SINGLETON_ID;
  // The canvas draws every package where it is filed, a hidden one dimmed —
  // the only way to show it again is to select it. Everywhere else the rows
  // are already the ones a visitor gets.
  const { packages: rows, grouped, ungrouped, destinationMode } = groupCatalogue(
    view.data.destinations,
    view.data.packages,
    view.editor ? () => true : undefined,
  );

  const hero = regionOf(view, { type: "packageIndexHero", id });
  const crumbs = regionOf(view, { type: "packageIndexCrumbs", id });
  const catalogue = regionOf(view, { type: "packageIndexCatalogue", id });
  const custom = regionOf(view, { type: "packageIndexCustom", id });
  const groupRegions = new Map(
    grouped.map(({ destination }) => [destination.id, regionOf(view, { type: "destinationGroup", id: destination.id })]),
  );
  const cardRegions = new Map(rows.map((row) => [row.id, regionOf(view, { type: "packageCard", id: row.id })]));

  const eyebrow = hero.node.text(
    "field:eyebrow",
    copyOf(hero, lang, "eyebrow", lang === "ar" ? "السفر والسياحة" : "Travel & tourism"),
  );
  const heading = hero.node.text(
    "field:heading",
    copyOf(hero, lang, "heading", lang === "ar" ? "برامج مُعدّة، وقابلة للتعديل" : "Prepared itineraries, built to be changed"),
  );
  const intro = hero.node.text(
    "field:intro",
    copyOf(
      hero,
      lang,
      "intro",
      lang === "ar"
        ? "ابدأ من برنامج جاهز أو اطلب برنامجًا مخصصًا بالكامل — التذاكر والفنادق والتنقلات والمرشد."
        : "Start from a prepared programme or ask for one built around you — flights, hotels, transfers and a guide.",
    ),
  );

  const cardMarks =
    (region: Region) =>
    (texts: { title: string; place: string; duration: string; summary: string }): PackageCardMarks => ({
      link: region.node("field:link"),
      place: texts.place ? region.node.text("field:place", texts.place) : null,
      duration: texts.duration ? region.node.text("field:duration", texts.duration) : null,
      title: region.node.text("field:title", texts.title),
      summary: texts.summary ? region.node.text("field:summary", texts.summary) : null,
      action: region.node("field:action"),
      image: region.media("field:image"),
    });

  const cards = (list: PackageRow[], listAttrs?: NodeAttrs) => (
    <ul {...listAttrs} className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {list.map((row, index) => {
        const region = cardRegions.get(row.id)!;
        return (
          <Reveal as="li" key={row.id} delay={index * 55} className="h-full" nodeAttrs={region.root}>
            <PackageCard
              row={row}
              locale={lang}
              image={row.imageId ? (media.get(row.imageId) ?? null) : null}
              marks={cardMarks(region)}
            />
          </Reveal>
        );
      })}
    </ul>
  );

  const customHeading = custom.node.text("field:heading", copyOf(custom, lang, "heading", dict.common.buildYourOwn));
  const customIntro = custom.node.text("field:intro", copyOf(custom, lang, "intro", dict.common.buildYourOwnIntro));

  const regions = [hero, crumbs, catalogue, custom, ...groupRegions.values(), ...cardRegions.values()];

  const page = (
    <>
      {view.mode === "preview" ? <PreviewBanner /> : null}

      <RegionRoot region={hero} atmosphere="landing" className="relative overflow-clip pb-8 pt-[clamp(6.5rem,9vw,9rem)]">
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
          { name: dict.common.packages, path: "/packages" },
        ]}
        marks={{ nav: crumbs.root, list: crumbs.node("field:trail") }}
      />

      <RegionRoot region={catalogue} as="div" className="shell shell-wide pb-[var(--spacing-section)] pt-10">
        {rows.length === 0 ? (
          <p {...catalogue.node("field:empty")} className="text-body">
            {dict.common.noResults}
          </p>
        ) : destinationMode ? (
          <>
            {grouped.map(({ destination, packages }) => {
              const region = groupRegions.get(destination.id)!;
              const title = region.node.text("field:title", pick(lang, destination.titleEn, destination.titleAr));
              return (
                <RegionRoot key={destination.id} region={region} className="mb-14 last:mb-0">
                  <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
                    <h2 {...title.attrs} className="text-[length:var(--text-h3)]">
                      {title.content}
                    </h2>
                    <Link
                      href={localeHref(lang, `/packages/${destination.slug}`)}
                      {...region.node("field:linkLabel")}
                      className="link-underline text-small"
                    >
                      {copyOf(region, lang, "linkLabel", dict.common.viewPackages)}
                      <Icon name="arrowRight" size={15} className="flip-rtl" />
                    </Link>
                  </div>
                  {cards(packages, region.node("field:cards"))}
                </RegionRoot>
              );
            })}

            {ungrouped.length ? (
              <RegionRoot region={custom} className="mb-14 last:mb-0">
                <h2 {...customHeading.attrs} className="text-[length:var(--text-h3)]">
                  {customHeading.content}
                </h2>
                <p {...customIntro.attrs} className="lede mt-3 max-w-2xl">
                  {customIntro.content}
                </p>
                <div {...custom.node("field:cards")} className="mt-6">
                  {cards(ungrouped)}
                </div>
              </RegionRoot>
            ) : null}
          </>
        ) : (
          // No destination holds a package yet — group exactly as this page
          // always has, so the destination work is invisible until the cutover.
          // The headings are generated, so they are marked as one node.
          <div {...catalogue.node("field:regions")}>
            {Array.from(new Set(rows.map((row) => row.region))).map((legacy) => {
              const label = REGION_LABELS[legacy];
              return (
                <section key={legacy} className="mb-14 last:mb-0">
                  <h2 className="mb-6 text-[length:var(--text-h3)]">
                    {label ? (lang === "ar" ? label.ar : label.en) : legacy}
                  </h2>
                  {cards(rows.filter((row) => row.region === legacy))}
                </section>
              );
            })}
          </div>
        )}
      </RegionRoot>

      {needsRuntime(regions) ? (
        // The server's decision, not the browser's: live parallax is paused in
        // the Visual Editor's canvas and nowhere else.
        <MotionRuntime signature={motionSignature(regions)} parallax={view.editor ? "paused" : "live"} />
      ) : null}
      {view.editor ? (
        <EditorBridge
          bridgeId={view.editor.bridgeId}
          pageId={documentEditorKey({ kind: "packageIndex", id })}
          slug={view.routeKey}
          locale={lang}
        />
      ) : null}
    </>
  );

  return view.still ? <StillPresentation>{page}</StillPresentation> : page;
}
