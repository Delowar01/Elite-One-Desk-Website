import type { CSSProperties } from "react";

import type { MediaRef } from "@/lib/media/url";
import { mediaSrc, mediaSrcSet } from "@/lib/media/url";
import type { Locale } from "@/lib/i18n/config";
import { pick } from "@/lib/i18n/config";

type Props = {
  media: MediaRef | null | undefined;
  locale: Locale;
  /** Overrides the library's alt text — use for decorative or repeated images. */
  alt?: string;
  sizes?: string;
  className?: string;
  priority?: boolean;
  /** CSS aspect-ratio; without it the intrinsic size reserves the space. */
  ratio?: string;
  /**
   * A media node's own overrides, already mapped from validated tokens.
   *
   * Only ever what `mediaNodeStyle` decided belongs on the picture rather than
   * on the frame — today that is the focal point, at base and at each
   * breakpoint. It is merged *after* the ratio so an editor's crop wins, and
   * merged rather than replacing so the ratio and the object-fit that make the
   * crop mean anything survive it. No database string reaches here: the mapping
   * happened before the call.
   */
  style?: CSSProperties;
  /**
   * Which declarations the node overrides at tablet and at mobile.
   *
   * Passed through to the `<img>` untouched, because the stylesheet's
   * responsive rules match on them and the crop belongs to the picture at every
   * width, not to the frame. Blocks spread `mediaNode(...).image`, so this and
   * `style` arrive together or not at all.
   */
  "data-rs-t"?: string;
  "data-rs-m"?: string;
};

/**
 * Renders a library image against the derivatives written at upload time.
 * Width and height always come from the stored dimensions, so the box is
 * reserved before the bytes arrive and the layout never shifts.
 */
export function MediaImage({
  media,
  locale,
  alt,
  sizes = "(max-width: 768px) 100vw, 50vw",
  className,
  priority = false,
  ratio,
  style,
  "data-rs-t": responsiveTablet,
  "data-rs-m": responsiveMobile,
}: Props) {
  if (!media) return null;
  const altText = alt ?? pick(locale, media.altEn, media.altAr) ?? "";
  const own: CSSProperties | undefined = ratio
    ? { aspectRatio: ratio, objectFit: "cover" }
    : undefined;
  const applied = own || style ? { ...own, ...style } : undefined;
  return (
    <img
      src={mediaSrc(media, media.derivatives?.[1] ?? undefined)}
      srcSet={mediaSrcSet(media)}
      sizes={sizes}
      width={media.width || undefined}
      height={media.height || undefined}
      alt={altText}
      className={className}
      style={applied}
      data-rs-t={responsiveTablet}
      data-rs-m={responsiveMobile}
      loading={priority ? "eager" : "lazy"}
      fetchPriority={priority ? "high" : undefined}
      decoding="async"
    />
  );
}
