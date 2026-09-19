import { getDictionary } from "@/lib/i18n/dictionary";
import type { Locale } from "@/lib/i18n/config";
import {
  getCatalog,
  getDestinations,
  getFaqs,
  getPackages,
  getTestimonials,
  getVideos,
} from "@/lib/queries/catalog";
import { getMediaMap } from "@/lib/queries/site";
import type { RenderedSection } from "@/lib/queries/content";
import { getSettings, whatsappLink } from "@/lib/settings";
import { motionOf } from "@/lib/cms/motion";
import { blockNode } from "@/lib/cms/node";
import type { EditorRender } from "@/lib/visual-editor/render";

import { SectionMotion, type SectionWrapperAttrs } from "./section-motion";
import { ContactDetailsBlock } from "./blocks/contact-details";
import type { BlockContext, BlockProps } from "./blocks/context";
import { DestinationFeatureBlock } from "./blocks/destination-feature";
import { FaqBlock } from "./blocks/faq";
import { FeaturedServiceBlock } from "./blocks/featured-service";
import { FinalCtaBlock } from "./blocks/final-cta";
import { HeroBlock } from "./blocks/hero";
import { ImageTextBlock } from "./blocks/image-text";
import { OneDeskBlock } from "./blocks/one-desk";
import { PackagesGridBlock } from "./blocks/packages-grid";
import { PageHeroBlock } from "./blocks/page-hero";
import { ProcessBlock } from "./blocks/process";
import { QuickLinksBlock } from "./blocks/quick-links";
import { RichTextBlock } from "./blocks/rich-text";
import { ServiceGridBlock } from "./blocks/service-grid";
import { StatsBlock } from "./blocks/stats";
import { TestimonialsBlock } from "./blocks/testimonials";
import { TravelFeatureBlock } from "./blocks/travel-feature";
import { VideoShowcaseBlock } from "./blocks/video-showcase";
import { WhyUsBlock } from "./blocks/why-us";

type BlockComponent = (props: BlockProps) => React.ReactNode | Promise<React.ReactNode>;

/** Block type → renderer. A type with no entry here is skipped, not crashed on. */
const RENDERERS: Record<string, BlockComponent> = {
  hero: HeroBlock,
  "quick-links": QuickLinksBlock,
  "one-desk": OneDeskBlock,
  "service-grid": ServiceGridBlock,
  "featured-service": FeaturedServiceBlock,
  "travel-feature": TravelFeatureBlock,
  "destination-feature": DestinationFeatureBlock,
  // The type this block carried before it was generalised. Mapped so a section
  // stored either way renders the same, whichever order the code and the data
  // arrive in.
  "egypt-feature": DestinationFeatureBlock,
  "packages-grid": PackagesGridBlock,
  "video-showcase": VideoShowcaseBlock,
  process: ProcessBlock,
  "why-us": WhyUsBlock,
  stats: StatsBlock,
  testimonials: TestimonialsBlock,
  faq: FaqBlock,
  "final-cta": FinalCtaBlock,
  "page-hero": PageHeroBlock,
  "rich-text": RichTextBlock,
  "image-text": ImageTextBlock,
  "contact-details": ContactDetailsBlock,
};

/**
 * Builds the shared context once, then renders the sections in order. Each
 * loader is individually cached and tagged, so a page with twelve sections
 * still costs at most one round trip per dataset — and usually none.
 */
export async function buildBlockContext(locale: Locale): Promise<BlockContext> {
  const [settings, media, catalog, packages, destinations, videos, testimonials, faqs] =
    await Promise.all([
      getSettings(),
      getMediaMap(),
      getCatalog(),
      getPackages(),
      getDestinations(),
      getVideos(),
      getTestimonials(),
      getFaqs(),
    ]);

  return {
    locale,
    dict: getDictionary(locale),
    settings,
    media,
    catalog,
    packages,
    destinations,
    videos,
    testimonials,
    faqs,
    whatsappHref: whatsappLink(settings, locale),
  };
}

/**
 * `editorMode` is the one switch that turns the public renderer into a
 * selectable canvas, and it is passed in from the server rather than sniffed.
 *
 * Nothing here reads `window`, a query string or a cookie: the decision was
 * made in `resolvePageForRender`, behind the session check, and travels down as
 * a prop. A block that worked it out for itself would be a block that could
 * work it out wrongly — and the wrong answer is editor attributes on a public
 * page.
 */
export async function SectionRenderer({
  sections,
  locale,
  ctx,
  editorMode = false,
}: {
  sections: RenderedSection[];
  locale: Locale;
  ctx?: BlockContext;
  editorMode?: boolean;
}) {
  const context = ctx ?? (await buildBlockContext(locale));

  return (
    <>
      {sections.map((section, index) => {
        const Renderer = RENDERERS[section.blockType];
        if (!Renderer) return null;

        const editor: EditorRender = editorMode
          ? { sectionId: section.id, blockType: section.blockType }
          : null;
        // The wrapper is the section's `root` node: the thing Layers selects,
        // and the thing a root style override lands on. One element, one
        // address, whether or not anybody is editing.
        const node = blockNode({ editor, styles: section.styles });

        const attrs: SectionWrapperAttrs = {
          "data-section": section.blockType,
          ...(section.isDraft ? { "data-draft": true as const } : {}),
          ...node(undefined, "section"),
          // Layers is built from what actually rendered, so the facts it
          // needs travel with the element rather than being asked of the
          // database a second time and risking a different answer.
          ...(editorMode
            ? {
                "data-eod-draft": String(section.isDraft),
                "data-eod-draft-only": String(section.isDraftOnly),
                "data-eod-visible": String(section.visible),
              }
            : {}),
        };

        const body = (
          <Renderer
            values={section.values}
            ctx={context}
            index={index}
            editor={editor}
            styles={section.styles}
          />
        );

        /**
         * The entrance the editor chose, on the wrapper that already exists.
         *
         * `composition` has already decided which value this is — published on
         * the live site, the motion draft in preview — so there is nothing to
         * choose here beyond whether the wrapper needs a lifecycle at all.
         * "No entrance animation" gets the plain element: no class, no
         * observer, no client component, and markup identical to what this
         * renderer produced before motion existed. That is what makes `none` a
         * real answer rather than an animation that happens to end where it
         * began.
         */
        const motion = motionOf(section.animation);
        return motion === "none" ? (
          <div key={section.id} {...attrs}>
            {body}
          </div>
        ) : (
          <SectionMotion key={section.id} motion={motion} attrs={attrs}>
            {body}
          </SectionMotion>
        );
      })}
    </>
  );
}
