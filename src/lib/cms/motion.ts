/**
 * Section entrance motion: the vocabulary, and the only thing allowed to read
 * one in.
 *
 * Motion is the third draft domain a section has, beside its content and its
 * styles, and it is the smallest of the three: one value out of five, chosen
 * from a closed list. That smallness is exactly why it needs a module of its
 * own rather than a `string` passed around. A preset is stored in two columns,
 * submitted by two different screens, promoted by three different publish
 * paths and rendered by one wrapper — and every one of those is a place where
 * a value that is not one of the five could otherwise get in.
 *
 * So there is **one** validator, `readMotion`, and it is strict in the way
 * input has to be strict: a value is one of the five exactly, or it is not
 * readable. Nothing is trimmed, nothing is lower-cased, nothing is guessed. A
 * `"fade-up "` with a space on the end is a bug in whatever sent it, and
 * quietly repairing it would hide that bug and teach the next caller that
 * approximate values work.
 *
 * `motionOf` is the other direction and deliberately forgiving, because it is
 * not reading input: it is reading a column. `page_sections.animation` is
 * `NOT NULL DEFAULT 'fade-up'` and predates this vocabulary being enforced
 * anywhere, so a row may hold something nobody would accept today. Rendering
 * such a row must not blank the page; it falls back to the default, which is
 * what the column's own default says the section meant.
 */

export const MOTION_PRESETS = [
  { value: "fade-up", label: "Fade up" },
  { value: "fade", label: "Fade only" },
  { value: "slide-in", label: "Slide in from the leading edge" },
  { value: "scale-in", label: "Scale in" },
  { value: "none", label: "No entrance animation" },
] as const;

export type MotionPreset = (typeof MOTION_PRESETS)[number]["value"];

/** What a section does when nobody has chosen — and what the column defaults to. */
export const DEFAULT_MOTION: MotionPreset = "fade-up";

const VALUES: readonly string[] = MOTION_PRESETS.map((preset) => preset.value);

export const MOTION_LABEL = Object.fromEntries(
  MOTION_PRESETS.map((preset) => [preset.value, preset.label]),
) as Record<MotionPreset, string>;

/**
 * A submitted preset, or `null`.
 *
 * `null` means "this could not be read", never "the editor chose nothing" —
 * the absence of a choice is the caller's to notice, because what it should do
 * about it differs: a form that omitted the field entirely is leaving the
 * current value alone, while a form that sent something unrecognisable is a
 * request to refuse.
 */
export function readMotion(raw: unknown): MotionPreset | null {
  if (typeof raw !== "string") return null;
  return VALUES.includes(raw) ? (raw as MotionPreset) : null;
}

/** A stored column, normalised for rendering. Never used on input. */
export function motionOf(stored: string | null | undefined): MotionPreset {
  return readMotion(stored) ?? DEFAULT_MOTION;
}

/**
 * Which CSS classes a preset renders as.
 *
 * The same table `Reveal` uses for its own `variant`, and deliberately the
 * same one: a section's entrance and a block's inner reveal are the same four
 * movements, and two tables would eventually disagree about what "slide in"
 * looks like. `none` is the empty string — no class, and therefore no reveal
 * lifecycle at all, rather than a lifecycle that happens to end where it
 * started.
 */
export const MOTION_CLASS: Record<MotionPreset, string> = {
  "fade-up": "reveal",
  fade: "reveal",
  "slide-in": "reveal reveal-left",
  "scale-in": "reveal reveal-scale",
  none: "",
};
