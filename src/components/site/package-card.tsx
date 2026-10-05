import Link from "next/link";

import { MediaImage } from "@/components/site/media-image";
import { Icon } from "@/components/ui/icon";
import type { MediaNode, NodeAttrs, NodeText } from "@/lib/cms/node";
import type { Locale } from "@/lib/i18n/config";
import { localeHref, pick } from "@/lib/i18n/config";
import type { MediaRef } from "@/lib/media/url";
import type { PackageRow } from "@/lib/queries/catalog";

/**
 * What one card carries on the package catalogue in the Visual Editor
 * (Batch 24): each part's node attributes — the editor's selection marks in
 * the canvas, and the card's published styles and motion everywhere. The
 * card's own region root rides on the `<li>` the catalogue wraps it in.
 * Absent, the markup is exactly what it always was.
 */
export type PackageCardMarks = {
  link: NodeAttrs;
  place: NodeText | null;
  duration: NodeText | null;
  title: NodeText;
  summary: NodeText | null;
  action: NodeAttrs;
  image: MediaNode;
};

export function PackageCard({
  row,
  locale,
  image,
  marks,
}: {
  row: PackageRow;
  locale: Locale;
  image: MediaRef | null;
  marks?: (texts: { title: string; place: string; duration: string; summary: string }) => PackageCardMarks;
}) {
  const title = pick(locale, row.titleEn, row.titleAr);
  const destination = pick(locale, row.destinationEn, row.destinationAr);
  const duration = pick(locale, row.durationEn, row.durationAr);
  const summary = pick(locale, row.summaryEn, row.summaryAr);
  const mark = marks?.({ title, place: destination, duration, summary });

  return (
    <Link
      href={localeHref(locale, `/packages/${row.slug}`)}
      {...mark?.link}
      className="group flex h-full flex-col overflow-hidden rounded-[var(--radius-lg)] border border-line bg-[var(--surface)] transition-all duration-400 ease-[var(--ease-out-expo)] hover:-translate-y-1 hover:border-[color-mix(in_oklab,var(--color-peach)_45%,transparent)]"
    >
      {image ? (
        <span {...mark?.image.box} className="block overflow-hidden">
          <MediaImage
            media={image}
            locale={locale}
            alt=""
            sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
            ratio="16 / 11"
            className="w-full transition-transform duration-700 ease-[var(--ease-out-expo)] group-hover:scale-[1.05]"
            {...mark?.image.image}
          />
        </span>
      ) : null}

      <span className="flex flex-1 flex-col p-5">
        {destination || duration ? (
          <span className="mb-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.74rem] text-muted">
            {destination ? (
              <span className="inline-flex items-center gap-1.5">
                <Icon name="mapPin" size={13} />{" "}
                {mark?.place ? <span {...mark.place.attrs}>{mark.place.content}</span> : destination}
              </span>
            ) : null}
            {duration ? (
              <span className="inline-flex items-center gap-1.5">
                <Icon name="clock" size={13} />{" "}
                {mark?.duration ? <span {...mark.duration.attrs}>{mark.duration.content}</span> : duration}
              </span>
            ) : null}
          </span>
        ) : null}

        <span {...mark?.title.attrs} className="font-display text-[1.02rem] font-semibold leading-snug text-strong">
          {mark ? mark.title.content : title}
        </span>
        {summary ? (
          <span {...mark?.summary?.attrs} className="mt-2 line-clamp-3 text-small text-muted">
            {mark?.summary ? mark.summary.content : summary}
          </span>
        ) : null}

        <span {...mark?.action} className="mt-auto flex items-center gap-1.5 pt-5 text-[0.82rem] font-semibold text-strong">
          <span className="relative">
            {locale === "ar" ? "التفاصيل" : "View details"}
            <span
              aria-hidden
              className="absolute inset-x-0 -bottom-0.5 h-px origin-[inline-start] scale-x-0 transition-transform duration-400 ease-[var(--ease-out-expo)] group-hover:scale-x-100"
              style={{ background: "var(--color-orange)" }}
            />
          </span>
          <Icon name="arrowRight" size={14} className="flip-rtl" />
        </span>
      </span>
    </Link>
  );
}
