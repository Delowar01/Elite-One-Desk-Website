import Link from "next/link";
import { notFound } from "next/navigation";

import { Breadcrumbs } from "@/components/site/breadcrumbs";
import { DestinationView } from "@/components/site/destination-view";
import { EditorBridge } from "@/components/site/editor-bridge";
import { EnquiryForm } from "@/components/site/enquiry-form";
import { JsonLd } from "@/components/site/json-ld";
import { MediaImage } from "@/components/site/media-image";
import { MotionRuntime } from "@/components/site/motion-runtime";
import { PreviewBanner } from "@/components/site/preview-banner";
import { Reveal } from "@/components/site/reveal";
import { copyOf, motionSignature, needsRuntime, RegionRoot, regionOf } from "@/components/site/route-region";
import { StillPresentation } from "@/components/site/still-presentation";
import { Icon } from "@/components/ui/icon";
import { toPlainText } from "@/lib/cms/sanitize";
import { isLocale, localeHref, pick } from "@/lib/i18n/config";
import { getDictionary } from "@/lib/i18n/dictionary";
import { getCatalog, getDestinationBySlug, getPackageBySlug } from "@/lib/queries/catalog";
import { getMediaMap } from "@/lib/queries/site";
import { documentEditorKey, type RouteOwner } from "@/lib/routes/owners";
import { resolvePackagesSlugRender } from "@/lib/routes/package-view";
import { breadcrumbJsonLd, buildMetadata } from "@/lib/seo";
import { getSettings, whatsappLink } from "@/lib/settings";

type Params = {
  params: Promise<{ lang: string; slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Pick<Params, "params">) {
  const { lang, slug } = await params;
  if (!isLocale(lang)) return {};

  // Destination first, exactly as the page body resolves, so the two can never
  // describe different pages at the same address.
  const destination = await getDestinationBySlug(slug);
  if (destination) {
    return buildMetadata({
      locale: lang,
      path: `/packages/${slug}`,
      entityType: "destination",
      entityKey: slug,
      title: pick(lang, destination.titleEn, destination.titleAr),
      description: toPlainText(pick(lang, destination.summaryEn, destination.summaryAr), 300),
      imageId: destination.imageId,
    });
  }

  const row = await getPackageBySlug(slug);
  if (!row) return {};
  return buildMetadata({
    locale: lang,
    path: `/packages/${slug}`,
    entityType: "package",
    entityKey: slug,
    title: pick(lang, row.titleEn, row.titleAr),
    description: toPlainText(pick(lang, row.summaryEn, row.summaryAr), 300),
    imageId: row.imageId,
    type: "article",
  });
}

/**
 * A package's own page — or, at a destination's address, the destination's.
 *
 * `/packages/[slug]` is one segment shared by two tables. Destination wins,
 * because a destination is the parent of the packages inside it; the admin
 * refuses a slug that would shadow the other table, so the order only ever
 * settles which page renders, never which content is reachable.
 *
 * Every region is drawn through `regionOf` (Batch 24): its published styles
 * and motion everywhere, its Visual Editor identity in an authorised editor
 * canvas only — `resolvePackagesSlugRender` decides which, from the session.
 * A visitor's page carries no editor attribute, no draft and no bridge, and
 * reads the same cached catalogue it always did. In the canvas an empty
 * section is drawn as a placeholder, so it can be selected and written; no
 * visitor ever sees one.
 */
export default async function PackagePage({ params, searchParams }: Params) {
  const { lang, slug } = await params;
  if (!isLocale(lang)) notFound();

  const resolved = await resolvePackagesSlugRender(slug, await searchParams);
  if (!resolved) notFound();

  if (resolved.kind === "destination") {
    return <DestinationView view={resolved.view} locale={lang} media={await getMediaMap()} />;
  }

  const view = resolved.view;
  const row = view.data.pkg;
  const [media, catalog, settings] = await Promise.all([getMediaMap(), getCatalog(), getSettings()]);
  const dict = getDictionary(lang);
  const id = row.id;
  const editing = Boolean(view.editor);

  const region = (type: RouteOwner["type"]) => regionOf(view, { type, id });
  const hero = region("packageHero");
  const crumbs = region("packageCrumbs");
  const body = region("packageBody");
  const highlightsRegion = region("packageHighlights");
  const request = region("packageRequest");

  const title = pick(lang, row.titleEn, row.titleAr);
  const place = pick(lang, row.destinationEn, row.destinationAr);
  const duration = pick(lang, row.durationEn, row.durationAr);
  const summary = pick(lang, row.summaryEn, row.summaryAr);
  const bodyHtml = pick(lang, row.bodyEn, row.bodyAr);
  const image = row.imageId ? media.get(row.imageId) : null;
  const whatsapp = whatsappLink(settings, lang, title);
  const highlights = (row.highlights ?? []).map((h) => pick(lang, h.en, h.ar)).filter(Boolean);

  const titlePart = hero.node.text("field:title", title);
  const placePart = place ? hero.node.text("field:place", place) : null;
  const durationPart = duration ? hero.node.text("field:duration", duration) : null;
  const summaryPart = summary ? hero.node.text("field:summary", summary) : null;
  const picture = hero.media("field:image");
  const highlightsHeading = highlightsRegion.node.text(
    "field:heading",
    copyOf(highlightsRegion, lang, "heading", lang === "ar" ? "أبرز ما يشمله البرنامج" : "What the programme includes"),
  );
  const formHeading = request.node.text("field:heading", copyOf(request, lang, "heading", dict.form.heading));
  const formIntro = request.node.text("field:intro", copyOf(request, lang, "intro", dict.form.subheading));

  /** What the canvas shows for a section with nothing in it yet. Never a visitor. */
  const placeholder = (words: string) => <p className="route-placeholder">{words}</p>;

  const trail = [
    { name: dict.nav.home, path: "/" },
    { name: dict.common.packages, path: "/packages" },
    { name: title, path: `/packages/${slug}` },
  ];

  const regions = [hero, crumbs, body, highlightsRegion, request];

  const page = (
    <>
      {view.mode === "preview" ? <PreviewBanner /> : null}

      <RegionRoot region={hero} className="relative overflow-clip pb-8 pt-[clamp(6.5rem,9vw,9rem)]">
        <div className="grid-texture pointer-events-none absolute inset-0 -z-10" />
        <div className="shell shell-wide grid gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
          <div>
            <Link
              href={localeHref(lang, "/packages")}
              {...hero.node("field:eyebrow")}
              className="eyebrow transition-opacity hover:opacity-75"
            >
              {dict.common.packages}
            </Link>
            <h1 {...titlePart.attrs} className="mt-5 text-[length:var(--text-h1)]">
              {titlePart.content}
            </h1>

            <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 text-small text-muted">
              {placePart ? (
                <span className="inline-flex items-center gap-1.5">
                  <Icon name="mapPin" size={15} />
                  <span {...placePart.attrs}>{placePart.content}</span>
                </span>
              ) : null}
              {durationPart ? (
                <span className="inline-flex items-center gap-1.5">
                  <Icon name="clock" size={15} />
                  <span {...durationPart.attrs}>{durationPart.content}</span>
                </span>
              ) : null}
            </div>

            {summaryPart ? (
              <p {...summaryPart.attrs} className="lede mt-5 max-w-xl">
                {summaryPart.content}
              </p>
            ) : null}

            <div className="mt-8 flex flex-wrap gap-3">
              <a href="#request" {...hero.node("field:ctaLabel")} className="btn btn-primary">
                {copyOf(hero, lang, "ctaLabel", dict.common.requestService)}
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
          </div>

          {image ? (
            <div {...picture.box} className="overflow-hidden rounded-[var(--radius-lg)] border border-line">
              <MediaImage
                media={image}
                locale={lang}
                sizes="(max-width: 1024px) 92vw, 45vw"
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
            <Reveal nodeAttrs={body.root}>
              {bodyHtml ? (
                <div {...body.node("field:body")} className="prose-eod" dangerouslySetInnerHTML={{ __html: bodyHtml }} />
              ) : (
                placeholder("No description yet. Select this section to write one.")
              )}
            </Reveal>
          ) : null}

          {highlights.length || editing ? (
            <Reveal className="mt-10" nodeAttrs={highlightsRegion.root}>
              <h2 {...highlightsHeading.attrs} className="mb-5 text-[length:var(--text-h3)]">
                {highlightsHeading.content}
              </h2>
              {highlights.length ? (
                <ul {...highlightsRegion.node("field:highlights")} className="grid gap-3 sm:grid-cols-2">
                  {highlights.map((item) => (
                    <li key={item} className="flex items-start gap-2.5 text-small text-body">
                      <Icon name="check" size={15} className="mt-1 shrink-0" style={{ color: "var(--color-orange)" }} />
                      {item}
                    </li>
                  ))}
                </ul>
              ) : (
                placeholder("No highlights yet. Select this section to add some.")
              )}
            </Reveal>
          ) : null}
        </div>

        <RegionRoot region={request} as="aside" className="min-w-0">
          <div id="request" className="scroll-mt-28 lg:sticky lg:top-28">
            <h2 {...formHeading.attrs} className="mb-1.5 text-[length:var(--text-h3)]">
              {formHeading.content}
            </h2>
            <p {...formIntro.attrs} className="mb-5 text-small text-muted">
              {formIntro.content}
            </p>
            <div {...request.node("field:form")}>
              <EnquiryForm
                locale={lang}
                dict={dict}
                forcedPreset="travel"
                categories={catalog.categories.map((c) => ({ id: c.id, title: pick(lang, c.titleEn, c.titleAr) }))}
                services={catalog.services.map((s) => ({
                  id: s.id,
                  categoryId: s.categoryId,
                  title: pick(lang, s.titleEn, s.titleAr),
                  preset: s.formPreset,
                }))}
              />
            </div>
          </div>
        </RegionRoot>
      </div>

      <JsonLd
        data={[
          breadcrumbJsonLd(lang, trail),
          {
            "@context": "https://schema.org",
            "@type": "TouristTrip",
            name: title,
            description: toPlainText(summary, 300),
            touristType: place || undefined,
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
          pageId={documentEditorKey({ kind: "package", id })}
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
