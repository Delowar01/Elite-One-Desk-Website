import Link from "next/link";

import { Breadcrumbs } from "@/components/site/breadcrumbs";
import { EditorBridge } from "@/components/site/editor-bridge";
import { MediaImage } from "@/components/site/media-image";
import { MotionRuntime } from "@/components/site/motion-runtime";
import { PackageCard } from "@/components/site/package-card";
import { PreviewBanner } from "@/components/site/preview-banner";
import { Reveal } from "@/components/site/reveal";
import { copyOf, motionSignature, needsRuntime, RegionRoot, regionOf } from "@/components/site/route-region";
import { StillPresentation } from "@/components/site/still-presentation";
import { Icon } from "@/components/ui/icon";
import type { Locale } from "@/lib/i18n/config";
import { localeHref, pick } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import type { MediaRef } from "@/lib/media/url";
import { documentEditorKey } from "@/lib/routes/owners";
import type { DestinationRender } from "@/lib/routes/package-view";

/**
 * One destination and the packages inside it — the middle step of
 * Tour Packages → destination → package, and the page that makes adding Nepal
 * an admin task rather than a code change.
 *
 * It shares the catalogue's route (`/packages/[slug]`) with package detail
 * pages. That is deliberate: giving destinations their own segment would have
 * moved every existing package URL, and a package address that has been shared
 * is not worth a tidier route.
 *
 * Drawn through `regionOf` (Batch 24): the destination's hero and the link
 * back are its own, edited here; the cards are its packages', drawn from the
 * catalogue and edited there — one region of the site, one owner.
 */
export function DestinationView({
  view,
  locale,
  media,
}: {
  view: DestinationRender;
  locale: Locale;
  media: Map<number, MediaRef>;
}) {
  const { destination, packages } = view.data;
  const dict = getDictionary(locale);
  const id = destination.id;
  const title = pick(locale, destination.titleEn, destination.titleAr);
  const summary = pick(locale, destination.summaryEn, destination.summaryAr);
  const image = destination.imageId ? (media.get(destination.imageId) ?? null) : null;

  const hero = regionOf(view, { type: "destinationHero", id });
  const crumbs = regionOf(view, { type: "destinationCrumbs", id });
  const listing = regionOf(view, { type: "destinationPackages", id });

  const eyebrow = hero.node.text("field:eyebrow", copyOf(hero, locale, "eyebrow", dict.common.tourPackages));
  const titlePart = hero.node.text("field:title", title);
  const summaryPart = summary ? hero.node.text("field:summary", summary) : null;
  const picture = hero.media("field:image");
  const regions = [hero, crumbs, listing];

  const page = (
    <>
      {view.mode === "preview" ? <PreviewBanner /> : null}

      <RegionRoot region={hero} atmosphere="landing" className="relative overflow-clip pb-8 pt-[clamp(6.5rem,9vw,9rem)]">
        <div className="grid-texture pointer-events-none absolute inset-0 -z-10" />
        <div className="shell shell-wide grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
          <div>
            <p {...eyebrow.attrs} className="eyebrow">
              {eyebrow.content}
            </p>
            <h1 {...titlePart.attrs} className="mt-5 max-w-2xl text-[length:var(--text-h1)]">
              {titlePart.content}
            </h1>
            {summaryPart ? (
              <p {...summaryPart.attrs} className="lede mt-5 max-w-2xl">
                {summaryPart.content}
              </p>
            ) : null}
          </div>
          {image ? (
            <Reveal variant="scale-in">
              <div {...picture.box} className="overflow-hidden rounded-[var(--radius-lg)] border border-line">
                <MediaImage
                  media={image}
                  locale={locale}
                  alt=""
                  sizes="(min-width: 1024px) 40vw, 100vw"
                  priority
                  className="aspect-[4/3] w-full object-cover"
                  {...picture.image}
                />
              </div>
            </Reveal>
          ) : null}
        </div>
      </RegionRoot>

      <Breadcrumbs
        locale={locale}
        label={dict.nav.breadcrumb}
        trail={[
          { name: dict.nav.home, path: "/" },
          { name: dict.common.tourPackages, path: "/packages" },
          { name: title, path: `/packages/${destination.slug}` },
        ]}
        marks={{ nav: crumbs.root, list: crumbs.node("field:trail") }}
      />

      <RegionRoot region={listing} as="div" className="shell shell-wide pb-[var(--spacing-section)] pt-10">
        {packages.length === 0 ? (
          <p {...listing.node("field:cards")} className="text-body">
            {dict.common.noResults}
          </p>
        ) : (
          <ul {...listing.node("field:cards")} className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
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
          <Link href={localeHref(locale, "/packages")} {...listing.node("field:backLabel")} className="link-underline">
            {copyOf(listing, locale, "backLabel", dict.common.destinations)}
            <Icon name="arrowRight" size={16} className="flip-rtl" />
          </Link>
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
          pageId={documentEditorKey({ kind: "destination", id })}
          slug={view.routeKey}
          locale={locale}
        />
      ) : null}
    </>
  );

  return view.still ? <StillPresentation>{page}</StillPresentation> : page;
}
