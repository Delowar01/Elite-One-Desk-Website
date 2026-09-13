import type { SVGProps } from "react";

import { socialPlatform } from "@/lib/social";

/**
 * A social network's own mark.
 *
 * Separate from `ui/icon.tsx` on purpose. That set is one stroked line family
 * at a fixed weight, which is what keeps the interface coherent; a brand mark
 * is solid, drawn by its owner, and rendering it through a stroke pipeline
 * produces a hollow outline of somebody else's logo. So this component fills
 * with `currentColor` and never strokes, and the path data lives in the same
 * registry the admin menu and the validator read.
 *
 * A key the registry does not know still renders — an outward arrow, which is
 * true of any link — rather than leaving a hole in the row.
 */
export function SocialIcon({
  platform,
  size = 20,
  ...rest
}: SVGProps<SVGSVGElement> & { platform: string; size?: number }) {
  const known = socialPlatform(platform);
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {known ? (
        <path d={known.path} />
      ) : (
        <path d="M7.5 4.5h12v12h-2.4V8.6L6.2 19.5 4.5 17.8 15.4 6.9H7.5Z" />
      )}
    </svg>
  );
}
