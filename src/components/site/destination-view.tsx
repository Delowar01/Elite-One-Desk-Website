import Link from "next/link";

import { Breadcrumbs } from "@/components/site/breadcrumbs";
import { MediaImage } from "@/components/site/media-image";
import { PackageCard } from "@/components/site/package-card";
import { Reveal } from "@/components/site/reveal";
import { Icon } from "@/components/ui/icon";
import type { Locale } from "@/lib/i18n/config";
import { localeHref, pick } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import type { DestinationRow, PackageRow } from "@/lib/queries/catalog";
import type { MediaRef } from "@/lib/media/url";

/**
 * One destination and the packages inside it — the middle step of
 * Tour Packages → destination → package, and the page that makes adding Nepal
 * an admin task rather than a code change.
 *
 * It shares the catalogue's route (`/packages/[slug]`) with package detail
 * pages. That is deliberate: giving destinations their own segment would have
 * moved every existing package URL, and a package address that has been shared
 * is not worth a tidier route.
 */
export function DestinationView({
  destination,
  packages,
  locale,
  media,
}: {
  destination: DestinationRow;
  packages: PackageRow[];
  locale: Locale;
  media: Map<number, MediaRef>;
}) {
  const dict = getDictionary(locale);
  const title = pick(locale, destination.titleEn, destination.titleAr);
  const summary = pick(locale, destination.summaryEn, destination.summaryAr);
  const image = destination.imageId ? (media.get(destination.imageId) ?? null) : null;

  return (
    <>
      <section
        data-atmosphere="landing"
        className="relative overflow-clip pb-8 pt-[clamp(6.5rem,9vw,9rem)]"
      >
        <div className="grid-texture pointer-events-none absolute inset-0 -z-10" />
        <div className="shell shell-wide grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
          <div>
            <p className="eyebrow">{dict.common.tourPackages}</p>
            <h1 className="mt-5 max-w-2xl text-[length:var(--text-h1)]">{title}</h1>
            {summary ? <p className="lede mt-5 max-w-2xl">{summary}</p> : null}
          </div>
          {image ? (
            <Reveal variant="scale-in">
              <div className="overflow-hidden rounded-[var(--radius-lg)] border border-line">
                <MediaImage
                  media={image}
                  locale={locale}
                  alt=""
                  sizes="(min-width: 1024px) 40vw, 100vw"
                  priority
                  className="aspect-[4/3] w-full object-cover"
                />
              </div>
            </Reveal>
          ) : null}
        </div>
      </section>

      <Breadcrumbs
        locale={locale}
        label={dict.nav.breadcrumb}
        trail={[
          { name: dict.nav.home, path: "/" },
          { name: dict.common.tourPackages, path: "/packages" },
          { name: title, path: `/packages/${destination.slug}` },
        ]}
      />

      <div className="shell shell-wide pb-[var(--spacing-section)] pt-10">
        {packages.length === 0 ? (
          <p className="text-body">{dict.common.noResults}</p>
        ) : (
          <ul className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {packages.map((row, index) => (
              <Reveal as="li" key={row.id} delay={index * 55} className="h-full">
                <PackageCard
                  row={row}
                  locale={locale}
                  image={row.imageId ? (media.get(row.imageId) ?? null) : null}
                />
              </Reveal>
            ))}
          </ul>
        )}

        <div className="mt-12">
          <Link href={localeHref(locale, "/packages")} className="link-underline">
            {dict.common.destinations}
            <Icon name="arrowRight" size={16} className="flip-rtl" />
          </Link>
        </div>
      </div>
    </>
  );
}
