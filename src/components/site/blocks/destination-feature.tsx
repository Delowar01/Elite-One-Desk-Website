import Link from "next/link";

import { MediaImage } from "@/components/site/media-image";
import { Reveal } from "@/components/site/reveal";
import { Icon } from "@/components/ui/icon";
import { getBlock } from "@/lib/cms/blocks";
import { items, mediaId, str, text } from "@/lib/cms/values";
import { localeHref } from "@/lib/i18n/config";
import { blockNode, mediaNode, withNodeStyle } from "@/lib/cms/node";
import { itemFieldPath, itemPath } from "@/lib/visual-editor/render";
import type { BlockProps } from "./context";

/**
 * A destination feature on a warm-white ground for contrast.
 *
 * Every string it renders is an editable block value — it queries no packages
 * and reads no region — so generalising it away from Egypt was a rename, not a
 * rewrite, and the copy an editor already wrote stays exactly as they wrote it.
 */
export function DestinationFeatureBlock({ values, ctx, editor, styles }: BlockProps) {
  const { locale } = ctx;
  const def = getBlock("destination-feature")!;
  const fields = def.fields.find((f) => f.name === "destinations")!.itemFields ?? [];
  const destinations = items(values, "destinations", locale, fields);
  const image = ctx.media.get(mediaId(values, "image") ?? -1) ?? null;

  const primaryHref = str(values, "primaryCtaHref", "/packages");
  const primaryLabel = text(values, "primaryCtaLabel", locale);
  const secondaryHref = str(values, "secondaryCtaHref", "/contact");
  const secondaryLabel = text(values, "secondaryCtaLabel", locale);
  const node = blockNode({ editor, styles });
  const imageNode = mediaNode({ editor, styles })("field:image");
  const eyebrowNode = node("field:eyebrow");

  return (
    <section data-tone="light" className="section relative overflow-clip">
      <div
        className={`shell shell-wide grid gap-12 lg:items-center lg:gap-16 ${
          image ? "lg:grid-cols-[1fr_0.92fr]" : ""
        }`}
      >
        <div>
          {/* Composed rather than spread: this element paints its own colour, and
              an override must win over it without erasing it when there is none. */}
          <p
            className="eyebrow"
            {...eyebrowNode}
            style={withNodeStyle({ color: "var(--color-orange)" }, eyebrowNode)}
          >
            {text(values, "eyebrow", locale)}
          </p>
          <h2 className="mt-4 text-[length:var(--text-h2)]" {...node("field:title")}>
            {text(values, "title", locale)}
          </h2>
          <p className="lede mt-5 max-w-xl" {...node("field:body")}>
            {text(values, "body", locale)}
          </p>

          {destinations.length ? (
            <ul className={`mt-9 grid gap-x-8 gap-y-4 sm:grid-cols-2 ${image ? "" : "lg:grid-cols-3"}`}>
              {destinations.map((destination, index) => (
                <Reveal
                  as="li"
                  key={destination.label}
                  delay={index * 40}
                  nodeAttrs={node(itemPath("destinations", destination), "item")}
                >
                  <div className="flex items-start gap-3 border-t pt-3" style={{ borderColor: "var(--border-color)" }}>
                    <span
                      className="mt-1 font-display text-[0.7rem] font-semibold tabular-nums"
                      style={{ color: "var(--color-orange)" }}
                    >
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <div className="min-w-0">
                      <p
                        className="font-display text-[0.95rem] font-semibold text-strong"
                        {...node(itemFieldPath("destinations", destination, "label"))}
                      >
                        {destination.label}
                      </p>
                      {destination.note ? (
                        <p
                          className="mt-0.5 text-small text-muted"
                          {...node(itemFieldPath("destinations", destination, "note"))}
                        >
                          {destination.note}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </Reveal>
              ))}
            </ul>
          ) : null}

          <div className="mt-10 flex flex-wrap gap-3">
            {primaryLabel ? (
              <Link
                href={localeHref(locale, primaryHref)}
                className="btn btn-primary"
                {...node("field:primaryCtaLabel")}
              >
                {primaryLabel}
                <Icon name="arrowRight" size={16} className="flip-rtl" />
              </Link>
            ) : null}
            {secondaryLabel ? (
              <Link
                href={localeHref(locale, secondaryHref)}
                className="btn btn-ghost"
                {...node("field:secondaryCtaLabel")}
              >
                {secondaryLabel}
              </Link>
            ) : null}
          </div>
        </div>

        {image ? (
          <Reveal variant="scale-in">
            <div className="relative overflow-hidden rounded-[var(--radius-xl)]" {...imageNode.box}>
              <MediaImage
                media={image}
                locale={locale}
                sizes="(max-width: 1024px) 92vw, 42vw"
                ratio="4 / 5"
                className="w-full"
                {...imageNode.image}
              />
              <span
                aria-hidden
                className="absolute inset-x-4 bottom-4 h-px"
                style={{ background: "var(--color-orange)" }}
              />
            </div>
          </Reveal>
        ) : null}
      </div>
    </section>
  );
}
