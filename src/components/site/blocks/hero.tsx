import Link from "next/link";

import { HeroWords } from "@/components/site/hero-words";
import { MediaImage } from "@/components/site/media-image";
import { OrbitComposition } from "@/components/site/orbit-composition";
import { Icon } from "@/components/ui/icon";
import { getBlock } from "@/lib/cms/blocks";
import { items, mediaId, str, text } from "@/lib/cms/values";
import { localeHref } from "@/lib/i18n/config";
import { blockNode, mediaNode } from "@/lib/cms/node";
import type { BlockProps } from "./context";

/**
 * The opening screen. The headline is set as a fixed line plus one animated
 * word rather than animating the whole sentence: the fixed part is in the HTML
 * a crawler reads, and the motion is confined to a single element.
 */
export function HeroBlock({ values, ctx, editor, styles, motion }: BlockProps) {
  const { locale, dict } = ctx;
  const def = getBlock("hero")!;
  const wordField = def.fields.find((f) => f.name === "words")!;

  const eyebrow = text(values, "eyebrow", locale);
  const headline = text(values, "headline", locale);
  const lead = text(values, "lead", locale);
  const words = items(values, "words", locale, wordField.itemFields ?? []).map((w) => w.label);
  const background = ctx.media.get(mediaId(values, "backgroundImage") ?? -1) ?? null;

  const primaryHref = str(values, "primaryCtaHref", "/contact");
  const secondaryHref = str(values, "secondaryCtaHref", "/services");
  const primaryLabel = text(values, "primaryCtaLabel", locale) || dict.nav.primaryCta;
  const secondaryLabel = text(values, "secondaryCtaLabel", locale) || dict.nav.secondaryCta;
  const node = blockNode({ editor, styles, motion });
  const backgroundNode = mediaNode({ editor, styles, motion })("field:backgroundImage");

  return (
    <section
      data-atmosphere="home"
      // The top padding clears the fixed header and is part of the hero.
      // The bottom padding is half of the gap to the section below it, and
      // that gap is what was too big — see `.home-rhythm` in globals.css.
      className="relative overflow-clip pb-[clamp(2.5rem,3.9vw,3.7rem)] pt-[clamp(7rem,11vw,10.5rem)]"
    >
      {background ? (
        <div className="pointer-events-none absolute inset-0 -z-20" {...backgroundNode.box}>
          <MediaImage
            media={background}
            locale={locale}
            alt=""
            sizes="100vw"
            priority
            className="size-full object-cover opacity-25"
            {...backgroundNode.image}
          />
          <div
            className="absolute inset-0"
            style={{
              background:
                "linear-gradient(to bottom, color-mix(in oklab, var(--color-ink-900) 82%, transparent), var(--color-ink-800))",
            }}
          />
        </div>
      ) : null}

      <div className="grid-texture pointer-events-none absolute inset-x-0 top-0 -z-10 h-[70%]" />

      <div className="shell shell-wide grid items-center gap-10 lg:grid-cols-[1.05fr_0.95fr] lg:gap-6">
        <div className="max-w-2xl">
          {eyebrow ? (
            <p
              className="eyebrow motion-safe:animate-[eod-fade-up_.7s_var(--ease-out-expo)_both]"
              {...node("field:eyebrow")}
            >
              {eyebrow}
            </p>
          ) : null}

          <h1
            className="mt-5 text-[length:var(--text-display)] leading-[var(--text-display--line-height)] tracking-[var(--text-display--letter-spacing)] motion-safe:animate-[eod-fade-up_.8s_var(--ease-out-expo)_.08s_both]"
            {...node("field:headline")}
          >
            {words.length ? (
              <>
                {/* The rotating words are one animated element cycling through
                    the list, so the list is what is selectable — annotating
                    each word would mean either adding DOM the public page does
                    not have, or marking a node that is replaced every few
                    seconds. Editing the individual rows is the inspector's job
                    once it can edit anything. */}
                <span {...node("field:words")}>
                  <HeroWords words={words} />
                </span>
                <br />
              </>
            ) : null}
            {headline}
          </h1>

          {lead ? (
            <p
              className="lede mt-6 max-w-xl motion-safe:animate-[eod-fade-up_.8s_var(--ease-out-expo)_.16s_both]"
              {...node("field:lead")}
            >
              {lead}
            </p>
          ) : null}

          <div className="mt-9 flex flex-wrap items-center gap-3 motion-safe:animate-[eod-fade-up_.8s_var(--ease-out-expo)_.24s_both]">
            <Link
              href={localeHref(locale, primaryHref)}
              className="btn btn-primary"
              {...node("field:primaryCtaLabel")}
            >
              {primaryLabel}
              <Icon name="arrowRight" size={17} className="flip-rtl" />
            </Link>
            <Link
              href={localeHref(locale, secondaryHref)}
              className="btn btn-ghost"
              {...node("field:secondaryCtaLabel")}
            >
              {secondaryLabel}
            </Link>
          </div>
        </div>

        <div className="relative mx-auto w-full max-w-[min(100%,34rem)] motion-safe:animate-[eod-fade_1.1s_var(--ease-out-expo)_.1s_both] lg:max-w-none">
          <OrbitComposition />
        </div>
      </div>
    </section>
  );
}
