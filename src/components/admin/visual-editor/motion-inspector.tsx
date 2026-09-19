"use client";

import { MOTION_PRESETS, type MotionPreset } from "@/lib/cms/motion";
import type { Locale } from "@/lib/i18n/config";

/**
 * The third domain: how the whole section arrives.
 *
 * One choice out of five, for the section — not for the selected node. That is
 * the thing this panel has to say out loud, because every other tab in the
 * inspector acts on whatever is selected and an editor who has just clicked a
 * heading will reasonably assume this one does too. Section entrance is the
 * whole of V1: a per-element entrance, a duration, a delay and an easing are
 * all things somebody will ask for, and none of them is here.
 *
 * It is also not breakpoint-specific, which is the second surprise worth
 * heading off. The Style tab writes into whichever branch the device switch is
 * showing; this writes one preset that holds at every width. A per-breakpoint
 * entrance would need a second storage shape and a second set of rules about
 * what a tablet inherits from base, and `draft_animation` is one column.
 */
export function MotionInspector({
  motion,
  locale,
  canManage,
  onChange,
}: {
  motion: MotionPreset;
  locale: Locale;
  canManage: boolean;
  onChange: (next: MotionPreset) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        <p className="admin-label">Section entrance</p>
        <p className="mt-1 text-[0.72rem] leading-relaxed text-muted">
          How this whole section arrives when a visitor scrolls to it. One choice for the section,
          at every screen width — the device switch above does not change it.
        </p>
      </div>

      <div role="radiogroup" aria-label="Section entrance" className="flex flex-col gap-1">
        {MOTION_PRESETS.map((preset) => {
          const active = preset.value === motion;
          return (
            <button
              key={preset.value}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={!canManage}
              onClick={() => canManage && onChange(preset.value)}
              className="admin-btn admin-btn-sm justify-start"
              style={
                active
                  ? { borderColor: "var(--color-orange)", color: "var(--color-strong)" }
                  : undefined
              }
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      <p className="text-[0.7rem] leading-relaxed text-muted">
        {/*
          Two truths an editor cannot see from the canvas, so they are written
          down. The first is a promise the stylesheet keeps in both the
          reduced-motion and the print rules; the second is why "Slide in" has
          no left or right in its name.
        */}
        Every entrance is skipped for visitors who have asked their device for reduced motion, and
        on a printed page — the section is simply there.{" "}
        {locale === "ar"
          ? "“Slide in” enters from the leading edge, which in Arabic is the right."
          : "“Slide in” enters from the leading edge, which in English is the left and in Arabic the right."}
      </p>
    </div>
  );
}
