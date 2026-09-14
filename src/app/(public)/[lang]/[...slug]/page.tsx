import { notFound } from "next/navigation";

import { EditorBridge } from "@/components/site/editor-bridge";
import { SectionRenderer, buildBlockContext } from "@/components/site/section-renderer";
import { PreviewBanner } from "@/components/site/preview-banner";
import { isLocale } from "@/lib/i18n/config";
import { getPage } from "@/lib/queries/content";
import { resolvePageForRender } from "@/lib/preview";
import { buildMetadata } from "@/lib/seo";

type Params = {
  params: Promise<{ lang: string; slug: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

/**
 * Every page that is not the homepage, the catalogue or search: About, Contact,
 * the legal pages and anything an admin creates. They are all rows in `pages`
 * carrying a list of sections, so a new page needs no code.
 *
 * A multi-segment address never legitimately reaches here — `/services/x/y` is
 * matched by its own route first — so anything with a slash is a 404.
 */
export async function generateMetadata({ params }: Pick<Params, "params">) {
  const { lang, slug } = await params;
  if (!isLocale(lang) || slug.length !== 1) return {};
  const page = await getPage(slug[0]!);
  if (!page) return {};
  return buildMetadata({
    locale: lang,
    path: `/${slug[0]}`,
    entityType: "page",
    entityKey: slug[0]!,
    title: lang === "ar" && page.titleAr ? page.titleAr : page.titleEn,
  });
}

export default async function CmsPage({ params, searchParams }: Params) {
  const { lang, slug } = await params;
  if (!isLocale(lang) || slug.length !== 1) notFound();

  const { page, isPreview, editor } = await resolvePageForRender(slug[0]!, await searchParams);
  // An unpublished page is still viewable in preview, which is the point of it.
  if (!page || (!page.isPublished && !isPreview)) notFound();

  const ctx = await buildBlockContext(lang);
  return (
    <>
      {/* Suppressed inside the Visual Editor only — see the homepage route. */}
      {isPreview && !editor ? <PreviewBanner /> : null}
      <SectionRenderer sections={page.sections} locale={lang} ctx={ctx} editorMode={Boolean(editor)} />
      {editor ? (
        <EditorBridge bridgeId={editor.bridgeId} pageId={page.id} slug={page.slug} locale={lang} />
      ) : null}
    </>
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
