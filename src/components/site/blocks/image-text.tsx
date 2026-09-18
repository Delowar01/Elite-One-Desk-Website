import Link from "next/link";

import { MediaImage } from "@/components/site/media-image";
import { Reveal } from "@/components/site/reveal";
import { Icon } from "@/components/ui/icon";
import { mediaId, str, text } from "@/lib/cms/values";
import { localeHref } from "@/lib/i18n/config";
import { blockNode, mediaNode } from "@/lib/cms/node";
import type { BlockProps } from "./context";

export function ImageTextBlock({ values, ctx, editor, styles }: BlockProps) {
  const { locale } = ctx;
  const image = ctx.media.get(mediaId(values, "image") ?? -1) ?? null;
  const imageSide = str(values, "imageSide", "start");
  const ctaHref = str(values, "ctaHref");
  const ctaLabel = text(values, "ctaLabel", locale);
  const body = text(values, "body", locale);
  const node = blockNode({ editor, styles });
  const imageNode = mediaNode({ editor, styles })("field:image");

  return (
    <section className="section-tight">
      <div
        className={`shell shell-wide grid items-center gap-10 lg:gap-16 ${
          image ? "lg:grid-cols-2" : "max-w-3xl"
        }`}
      >
        {image ? (
          <Reveal
            variant="slide-in"
            className={imageSide === "end" ? "lg:order-2" : undefined}
          >
            <div
              className="overflow-hidden rounded-[var(--radius-lg)] border border-line"
              {...imageNode.box}
            >
              <MediaImage
                media={image}
                locale={locale}
                sizes="(max-width: 1024px) 92vw, 45vw"
                ratio="4 / 3"
                className="w-full"
                {...imageNode.image}
              />
            </div>
          </Reveal>
        ) : null}

        <Reveal>
          {text(values, "eyebrow", locale) ? (
            <p className="eyebrow mb-4" {...node("field:eyebrow")}>
              {text(values, "eyebrow", locale)}
            </p>
          ) : null}
          {text(values, "title", locale) ? (
            <h2 className="mb-5 text-[length:var(--text-h2)]" {...node("field:title")}>
              {text(values, "title", locale)}
            </h2>
          ) : null}
          {body ? (
            <div
              className="prose-eod"
              {...node("field:body")}
              dangerouslySetInnerHTML={{ __html: body }}
            />
          ) : null}
          {ctaLabel && ctaHref ? (
            <div className="mt-7">
              <Link
                href={localeHref(locale, ctaHref)}
                className="btn btn-ghost"
                {...node("field:ctaLabel")}
              >
                {ctaLabel}
                <Icon name="arrowRight" size={16} className="flip-rtl" />
              </Link>
            </div>
          ) : null}
        </Reveal>
      </div>
    </section>
  );
}
