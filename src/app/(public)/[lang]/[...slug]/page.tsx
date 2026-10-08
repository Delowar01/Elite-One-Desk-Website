import { notFound } from "next/navigation";

import { EditorBridge } from "@/components/site/editor-bridge";
import { SectionRenderer, buildBlockContext } from "@/components/site/section-renderer";
import { PreviewBanner } from "@/components/site/preview-banner";
import { isLocale } from "@/lib/i18n/config";
import { getPage } from "@/lib/queries/content";
import { resolvePageForRender } from "@/lib/preview";
import { buildMetadata, homeMetadata } from "@/lib/seo";
import { recordStorage } from "@/lib/seo-model";

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
  // An unpublished page answers 404 to a visitor, and its title and record must
  // not ride along in that answer (Batch 25, B.14). Preview is private and gets
  // the generic metadata too.
  if (!page || !page.isPublished) return {};
  // `/home` serves the homepage too, so it says exactly what `/` says — the
  // homepage's metadata, `/` as its address — rather than being a second
  // indexable address for the same page (B.14).
  if (page.slug === "home") return homeMetadata(lang);
  return buildMetadata({
    locale: lang,
    path: `/${page.slug}`,
    seo: recordStorage("page", page.slug, page.id),
    title: { en: page.titleEn, ar: page.titleAr },
  });
}

export default async function CmsPage({ params, searchParams }: Params) {
  const { lang, slug } = await params;
  if (!isLocale(lang) || slug.length !== 1) notFound();

  const { page, isPreview, editor, compare, componentPreview } = await resolvePageForRender(
    slug[0]!,
    await searchParams,
  );
  // An unpublished page is still viewable in preview, which is the point of it
  // — and in an authorised comparison, which reads its history (Batch 16).
  if (!page || (!page.isPublished && !isPreview && !compare)) notFound();

  const ctx = await buildBlockContext(lang);
  return (
    <>
      {/* Suppressed inside the Visual Editor only — see the homepage route. */}
      {isPreview && !editor ? <PreviewBanner component={componentPreview?.name ?? null} /> : null}
      <SectionRenderer
        sections={page.sections}
        locale={lang}
        ctx={ctx}
        editorMode={Boolean(editor)}
        still={Boolean(compare)}
      />
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
