/**
 * The icon set, by name.
 *
 * The drawings live in `components/ui/icon.tsx`; the names live here, in a
 * module with no React in it, because the allowlist is read by things that are
 * not components — the CMS validator and the category action both have to
 * decide whether a submitted key is one we can draw, and neither should be
 * pulling a component into its bundle to find out. (It also made the validator
 * impossible to import from a plain script, which is how this was noticed.)
 *
 * The two cannot drift: `PATHS` is typed `Record<IconName, ReactNode>`, so a
 * name added here without a drawing, or a drawing added there without a name,
 * fails the typecheck.
 */
export const ICON_NAMES = [
  "plane",
  "globe",
  "passport",
  "briefcase",
  "building",
  "idCard",
  "refresh",
  "landmark",
  "desk",
  "pyramid",
  "ship",
  "hotel",
  "shield",
  "phone",
  "mail",
  "whatsapp",
  "arrowRight",
  "arrowUpRight",
  "chevronDown",
  "chevronRight",
  "search",
  "menu",
  "close",
  "play",
  "quote",
  "check",
  "star",
  "mapPin",
  "clock",
  "sparkle",
  "route",
  "layers",
  "users",
  "eye",
  "eyeOff",
  "trash",
  "fileText",
] as const;

export type IconName = (typeof ICON_NAMES)[number];

const NAME_SET = new Set<string>(ICON_NAMES);

/** Is this a key the site can actually draw? */
export const isIconName = (value: string): value is IconName => NAME_SET.has(value);
