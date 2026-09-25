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
import { animatesAnywhere, motionStyle } from "@/lib/cms/motion-css";
import {
  effectiveSectionTarget,
  legacySectionPreset,
  type MotionDocument,
  type MotionTarget,
} from "@/lib/cms/motion-doc";
import { blockNode, withMotion } from "@/lib/cms/node";
import { motionForBlock } from "@/lib/visual-editor/motion-targets";
import type { EditorRender } from "@/lib/visual-editor/render";

import { MotionRuntime } from "./motion-runtime";
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
 * A short, stable fingerprint of the page's node motion.
 *
 * `MotionRuntime` re-scans the page when this changes, so it has to change when
 * the motion does; it is a hash rather than the document itself because it is
 * serialised into the page, and a page with a lot of motion should not ship all
 * of it twice.
 */
function fingerprint(value: unknown): string {
  const text = JSON.stringify(value);
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) | 0;
  }
  return (hash >>> 0).toString(36);
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

  /**
   * Each section's advanced motion, cut down to what its block's nodes can
   * carry. Done here because this is where the block is known, and done at
   * render as well as at save because it is a correctness rule, not a panel
   * preference: an entrance stored against an element that already runs its
   * own keyframes would be a second animation on that element's opacity.
   */
  const motions: (MotionDocument | null)[] = sections.map((section) =>
    section.motion ? motionForBlock(section.motion, section.blockType) : null,
  );

  /**
   * Whether anything below a section wrapper moves on its own. Only then does
   * the page get a `MotionRuntime` — a page with no node motion ships exactly
   * the client code it shipped before Batch 15.
   */
  const nodeMotion = motions.map((motion, index) =>
    motion && Object.values(motion.nodes).some((target: MotionTarget) => animatesAnywhere(target))
      ? [sections[index]!.id, motion.nodes]
      : null,
  );
  const runtime = nodeMotion.some((entry) => entry !== null);

  return (
    <>
      {sections.map((section, index) => {
        const Renderer = RENDERERS[section.blockType];
        if (!Renderer) return null;

        const editor: EditorRender = editorMode
          ? { sectionId: section.id, blockType: section.blockType }
          : null;
        const advancedMotion = motions[index] ?? null;
        // The wrapper is the section's `root` node: the thing Layers selects,
        // and the thing a root style override lands on. One element, one
        // address, whether or not anybody is editing.
        const node = blockNode({ editor, styles: section.styles, motion: advancedMotion });

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
            motion={advancedMotion}
          />
        );

        /**
         * The section's own entrance: the document's section target, with the
         * legacy preset standing in for Base's entrance wherever the document
         * names none — so retiming a section does not quietly change how it
         * moves.
         *
         * A target that is nothing more than one of the legacy presets renders
         * on the legacy classes below, which is also where every section with
         * no document lands. Only a target that needs more — Blur, Mask, a
         * direction, timing, a narrower width — takes the advanced layer.
         */
        const target = effectiveSectionTarget(advancedMotion, motionOf(section.animation));
        // A target that moves at no width is the plain element, exactly as the
        // legacy `none` is — whatever timing it happens to carry.
        const motion = legacySectionPreset(target) ?? (animatesAnywhere(target) ? null : "none");

        /** An advanced section entrance (Batch 15). */
        if (motion === null) {
          const { style, ...rest } = attrs;
          const moved = withMotion(rest, style, "reveal", motionStyle(target));
          const advanced = {
            ...moved.attrs,
            ...(moved.style ? { style: moved.style } : {}),
          } as SectionWrapperAttrs;
          return (
            <SectionMotion key={section.id} motion={motionOf(section.animation)} attrs={advanced}>
              {body}
            </SectionMotion>
          );
        }

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
      {runtime ? <MotionRuntime signature={fingerprint(nodeMotion)} /> : null}
    </>
  );
}
