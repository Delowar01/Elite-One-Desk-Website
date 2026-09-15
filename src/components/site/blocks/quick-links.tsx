import Link from "next/link";

import { MediaImage } from "@/components/site/media-image";
import { Reveal } from "@/components/site/reveal";
import { SectionHeading } from "@/components/site/section-heading";
import { Icon } from "@/components/ui/icon";
import { getBlock } from "@/lib/cms/blocks";
import { itemMediaId, items, text } from "@/lib/cms/values";
import { localeHref } from "@/lib/i18n/config";
import { imageForHref } from "@/lib/link-image";
import { blockNode } from "@/lib/cms/node";
import { itemFieldPath, itemPath } from "@/lib/visual-editor/render";
import type { BlockProps } from "./context";

/**
 * The direct entry points under the hero. A visitor who already knows they want
 * an investor licence should reach it in one click without reading the rest of
 * the page — so these are pictures of where they are going rather than a row of
 * labelled boxes, and they stay small enough that the whole set is one glance.
 *
 * Each card's picture is resolved in three steps: the image an admin chose for
 * this card, then the image belonging to the page it links to, then a branded
 * fill. Nothing here needs a photograph to exist, and nothing here holds a
 * media id of its own.
 *
 * One `Reveal` for the list rather than one per card, and every hover is CSS:
 * the homepage is the heaviest page on the site and this section is the last
 * place that should be adding observers to it.
 */
export function QuickLinksBlock({ values, ctx, editor, styles }: BlockProps) {
  const { locale, media, catalog, packages, destinations } = ctx;
  const def = getBlock("quick-links")!;
  const fields = def.fields.find((f) => f.name === "links")!.itemFields ?? [];
  const links = items(values, "links", locale, fields);
  if (!links.length) return null;
  const node = blockNode({ editor, styles });

  const catalogue = { ...catalog, packages, destinations };

  return (
    <section className="section-tight relative">
      <div className="shell shell-wide">
        <SectionHeading
          editor={editor}
          fields={{ eyebrow: "title", intro: "intro" }}
          eyebrow={text(values, "title", locale) || ctx.dict.sections.quickAccess}
          intro={text(values, "intro", locale)}
        />

        <Reveal className="mt-9">
          <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 xl:grid-cols-4">
            {links.map((link, index) => {
              const chosen = itemMediaId(link, "image") ?? imageForHref(link.href, catalogue);
              const image = chosen ? media.get(chosen) ?? null : null;
              return (
                <li
                  key={`${link.href}-${index}`}
                  className="min-w-0"
                  {...node(itemPath("links", link), "item")}
                >
                  <Link
                    href={localeHref(locale, link.href || "/services")}
                    className="ql-card"
                    data-tint={index % 4}
                  >
                    {/* Decorative: the card names its own destination. */}
                    <span className="ql-shot" aria-hidden {...node(itemFieldPath("links", link, "image"))}>
                      {image ? (
                        <MediaImage
                          media={image}
                          locale={locale}
                          alt=""
                          sizes="(max-width: 640px) 46vw, (max-width: 1280px) 31vw, 23vw"
                          className="ql-img"
                        />
                      ) : null}
                    </span>

                    <span className="ql-body">
                      <span className="ql-badge">
                        <Icon name={link.icon || "sparkle"} size={16} />
                      </span>
                      <span className="ql-foot">
                        <span className="ql-title" {...node(itemFieldPath("links", link, "label"))}>
                          {link.label}
                        </span>
                        <Icon name="arrowRight" size={15} className="ql-arrow" />
                      </span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Reveal>
      </div>
    </section>
  );
}
