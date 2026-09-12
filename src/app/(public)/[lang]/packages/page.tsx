import Link from "next/link";
import { notFound } from "next/navigation";

import { Breadcrumbs } from "@/components/site/breadcrumbs";
import { PackageCard } from "@/components/site/package-card";
import { Reveal } from "@/components/site/reveal";
import { Icon } from "@/components/ui/icon";
import { isLocale, localeHref, pick } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getPackageCatalog } from "@/lib/queries/catalog";
import { getMediaMap } from "@/lib/queries/site";
import { buildMetadata } from "@/lib/seo";

type Params = { params: Promise<{ lang: string }> };

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

export async function generateMetadata({ params }: Params) {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return buildMetadata({
    locale: lang,
    path: "/packages",
    entityType: "page",
    entityKey: "packages",
    title: lang === "ar" ? "البرامج السياحية" : "Tour packages",
    description:
      lang === "ar"
        ? "باقات سياحية وبرامج مُعدّة مسبقاً لوجهات مختارة — جميعها قابلة للتخصيص."
        : "Tour packages and prepared itineraries across our destinations — every one of them adjustable.",
  });
}

export default async function PackagesPage({ params }: Params) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();

  const dict = getDictionary(lang);
  const [catalog, media] = await Promise.all([getPackageCatalog(), getMediaMap()]);
  const { packages: rows, grouped, ungrouped, destinationMode } = catalog;

  const regions = Array.from(new Set(rows.map((r) => r.region)));

  const cards = (list: typeof rows) => (
    <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
      {list.map((row, index) => (
        <Reveal as="li" key={row.id} delay={index * 55} className="h-full">
          <PackageCard
            row={row}
            locale={lang}
            image={row.imageId ? (media.get(row.imageId) ?? null) : null}
          />
        </Reveal>
      ))}
    </ul>
  );

  return (
    <>
      <section
        data-atmosphere="landing"
        className="relative overflow-clip pb-8 pt-[clamp(6.5rem,9vw,9rem)]"
      >
        <div className="grid-texture pointer-events-none absolute inset-0 -z-10" />
        <div className="shell shell-wide">
          <p className="eyebrow">{lang === "ar" ? "السفر والسياحة" : "Travel & tourism"}</p>
          <h1 className="mt-5 max-w-3xl text-[length:var(--text-h1)]">
            {lang === "ar" ? "برامج مُعدّة، وقابلة للتعديل" : "Prepared itineraries, built to be changed"}
          </h1>
          <p className="lede mt-5 max-w-2xl">
            {lang === "ar"
              ? "ابدأ من برنامج جاهز أو اطلب برنامجًا مخصصًا بالكامل — التذاكر والفنادق والتنقلات والمرشد."
              : "Start from a prepared programme or ask for one built around you — flights, hotels, transfers and a guide."}
          </p>
        </div>
      </section>

      <Breadcrumbs
        locale={lang}
        label={dict.nav.breadcrumb}
        trail={[
          { name: dict.nav.home, path: "/" },
          { name: dict.common.packages, path: "/packages" },
        ]}
      />

      <div className="shell shell-wide pb-[var(--spacing-section)] pt-10">
        {rows.length === 0 ? (
          <p className="text-body">{dict.common.noResults}</p>
        ) : destinationMode ? (
          <>
            {grouped.map(({ destination, packages }) => (
              <section key={destination.id} className="mb-14 last:mb-0">
                <div className="mb-6 flex flex-wrap items-baseline justify-between gap-3">
                  <h2 className="text-[length:var(--text-h3)]">
                    {pick(lang, destination.titleEn, destination.titleAr)}
                  </h2>
                  <Link
                    href={localeHref(lang, `/packages/${destination.slug}`)}
                    className="link-underline text-small"
                  >
                    {dict.common.viewPackages}
                    <Icon name="arrowRight" size={15} className="flip-rtl" />
                  </Link>
                </div>
                {cards(packages)}
              </section>
            ))}

            {ungrouped.length ? (
              <section className="mb-14 last:mb-0">
                <h2 className="text-[length:var(--text-h3)]">{dict.common.buildYourOwn}</h2>
                <p className="lede mt-3 max-w-2xl">{dict.common.buildYourOwnIntro}</p>
                <div className="mt-6">{cards(ungrouped)}</div>
              </section>
            ) : null}
          </>
        ) : (
          // No destination holds a package yet — group exactly as this page
          // always has, so the destination work is invisible until the cutover.
          regions.map((region) => {
            const inRegion = rows.filter((r) => r.region === region);
            const label = REGION_LABELS[region];
            return (
              <section key={region} className="mb-14 last:mb-0">
                <h2 className="mb-6 text-[length:var(--text-h3)]">
                  {label ? (lang === "ar" ? label.ar : label.en) : region}
                </h2>
                {cards(inRegion)}
              </section>
            );
          })
        )}
      </div>
    </>
  );
}
