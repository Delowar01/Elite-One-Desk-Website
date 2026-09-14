import { notFound } from "next/navigation";

import { EditorBridge } from "@/components/site/editor-bridge";
import { JsonLd } from "@/components/site/json-ld";
import { SectionRenderer, buildBlockContext } from "@/components/site/section-renderer";
import { PreviewBanner } from "@/components/site/preview-banner";
import { isLocale } from "@/lib/i18n/config";
import { resolvePageForRender } from "@/lib/preview";
import { buildMetadata, organizationJsonLd } from "@/lib/seo";

type Params = {
  params: Promise<{ lang: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export async function generateMetadata({ params }: Pick<Params, "params">) {
  const { lang } = await params;
  if (!isLocale(lang)) return {};
  return buildMetadata({ locale: lang, path: "/", entityType: "page", entityKey: "home" });
}

export default async function HomePage({ params, searchParams }: Params) {
  const { lang } = await params;
  if (!isLocale(lang)) notFound();

  const [{ page, isPreview, editor }, ctx, organization] = await Promise.all([
    resolvePageForRender("home", await searchParams),
    buildBlockContext(lang),
    organizationJsonLd(lang),
  ]);
  if (!page) notFound();

  return (
    <>
      {/* The Visual Editor's own chrome already says where the admin is, and
          the banner would sit inside the canvas pretending to be part of the
          page. Every other preview keeps it. */}
      {isPreview && !editor ? <PreviewBanner /> : null}
      {/* The homepage stacks thirteen sections, so it sets a tighter vertical
          rhythm than the rest of the site — see `.home-rhythm` in globals.css.
          A wrapper rather than a change to the tokens, so no other page moves. */}
      <div className="home-rhythm">
        <SectionRenderer sections={page.sections} locale={lang} ctx={ctx} editorMode={Boolean(editor)} />
      </div>
      {editor ? (
        <EditorBridge bridgeId={editor.bridgeId} pageId={page.id} slug={page.slug} locale={lang} />
      ) : null}
      <JsonLd
        data={[
          organization,
          {
            "@context": "https://schema.org",
            "@type": "WebSite",
            name: ctx.settings.brand.siteNameEn,
            url: process.env.NEXT_PUBLIC_SITE_URL ?? "",
            potentialAction: {
              "@type": "SearchAction",
              target: `${process.env.NEXT_PUBLIC_SITE_URL ?? ""}/search?q={search_term_string}`,
              "query-input": "required name=search_term_string",
            },
          },
        ]}
      />
    </>
  );
}
