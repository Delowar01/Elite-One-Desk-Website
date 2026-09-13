import Link from "next/link";

import { MediaImage } from "@/components/site/media-image";
import { Reveal } from "@/components/site/reveal";
import { Icon } from "@/components/ui/icon";
import { toPlainText } from "@/lib/cms/sanitize";
import type { Locale } from "@/lib/i18n/config";
import { localeHref, pick } from "@/lib/i18n/config";
import type { MediaRef } from "@/lib/media/url";
import type { ServiceRow } from "@/lib/queries/catalog";

/**
 * Which icon a service wears.
 *
 * There is no per-service icon column, and there is deliberately no plan to add
 * one: a catalogue of 74 services would become 74 rows an editor has to keep
 * meaningful. What exists is `service_categories.icon`, which an admin already
 * chooses — so that is the floor, and every service is guaranteed an icon that
 * at least belongs to its category.
 *
 * Above that floor sits this list: a small set of semantic keywords matched
 * against the service **slug**, first match wins. The slug rather than the
 * title because it is stable, lower-case and English in both editions — an
 * Arabic page gets exactly the same icons as the English one, which is the
 * whole point of matching on a key instead of on copy.
 *
 * Order is the meaning here, and the awkward pairs are the reason it is a list
 * and not an object: `iqama-transfer-sponsorship-transfer-support` is an Iqama
 * service, not an airport transfer; `travel-insurance-for-visa` is insurance,
 * not a visa; `professional-tour-guide` is a guide, not a tour package; and
 * `vehicle-registration-guidance` is about a vehicle, not a building. Each of
 * those is settled by putting the more specific word first.
 *
 * Anything unmatched falls through to the category icon, so adding a service
 * never leaves a card blank and never needs an entry here.
 */
const ICON_RULES: ReadonlyArray<readonly [string, string]> = [
  ["iqama", "idCard"],
  ["residency", "idCard"],
  ["passport", "passport"],
  ["insurance", "shield"],
  ["compliance", "shield"],
  ["visa", "passport"],
  ["hotel", "hotel"],
  ["cruise", "ship"],
  ["airport", "route"],
  ["guide", "users"],
  ["itinerary", "route"],
  ["tour", "globe"],
  ["holiday", "globe"],
  ["honeymoon", "globe"],
  ["attraction", "star"],
  ["exit", "route"],
  ["muqeem", "landmark"],
  ["qiwa", "landmark"],
  ["absher", "landmark"],
  ["tga", "landmark"],
  ["vehicle", "route"],
  ["transport", "route"],
  ["permit", "fileText"],
  ["registration", "building"],
  ["formation", "building"],
  ["consultation", "desk"],
  ["eligibility", "check"],
  ["renewal", "refresh"],
  ["document", "fileText"],
];

export function serviceIcon(slug: string, categoryIcon: string): string {
  for (const [needle, icon] of ICON_RULES) {
    if (slug.includes(needle)) return icon;
  }
  return categoryIcon || "desk";
}

/**
 * The fallback wedge, varied four ways.
 *
 * Almost no service carries a picture — nothing seeds `services.image_id` and
 * the panel has no field for it, so today the abstract treatment *is* the
 * design rather than a stand-in for a missing one. Twenty-six identical
 * gradients read as wallpaper, so the angle and the weight of the two ambient
 * lights shift on a four-step cycle keyed to the row id: stable across
 * renders, the same on the server and in the browser, and quiet enough that
 * the grid still reads as one set rather than four.
 */
const tintOf = (id: number) => String(((id % 4) + 4) % 4);

type Props = {
  rows: ServiceRow[];
  locale: Locale;
  categorySlug: string;
  /** Last resort for a service whose slug matches no keyword above. */
  categoryIcon: string;
  /** Already loaded by the page — no card fetches anything of its own. */
  media: Map<number, MediaRef>;
  learnMore: string;
};

/**
 * The service list on a category page, as cards rather than rows.
 *
 * One `Reveal` for the whole list, not one per card: a category holds up to 26
 * services, and 26 IntersectionObservers to fade 26 boxes is a cost with
 * nothing to show for it. It is also better behaviour — the list is revealed
 * as a block when its top edge arrives, so a visitor scrolling a long category
 * never catches a card still at opacity 0.
 *
 * Everything else here is a server component and every interaction is CSS, so
 * a hover costs no JavaScript at all.
 */
export function ServiceCardGrid({
  rows,
  locale,
  categorySlug,
  categoryIcon,
  media,
  learnMore,
}: Props) {
  if (!rows.length) return null;

  return (
    <Reveal>
      <ul className="grid gap-4 sm:grid-cols-2 sm:gap-5 xl:grid-cols-3">
        {rows.map((service) => {
          const image = service.imageId ? media.get(service.imageId) ?? null : null;
          const intro = toPlainText(pick(locale, service.introEn, service.introAr), 150);
          return (
            <li key={service.id} className="min-w-0">
              <Link
                href={localeHref(locale, `/services/${categorySlug}/${service.slug}`)}
                className="svc-card"
              >
                <span className="svc-card-body">
                  <span className="svc-card-badge">
                    <Icon name={serviceIcon(service.slug, categoryIcon)} size={17} />
                  </span>
                  <span className="svc-card-title">
                    {pick(locale, service.titleEn, service.titleAr)}
                  </span>
                  {intro ? <span className="svc-card-intro">{intro}</span> : null}
                  <span className="svc-card-action">
                    {learnMore}
                    <Icon name="arrowRight" size={13} className="svc-card-arrow" />
                  </span>
                </span>

                {/* Decorative: the service is already named beside it, so the
                    picture is never the only copy of anything. */}
                <span className="svc-wedge" data-tint={tintOf(service.id)} data-image={image ? "true" : "false"} aria-hidden>
                  <span className="svc-wedge-fill">
                    {image ? (
                      <MediaImage
                        media={image}
                        locale={locale}
                        alt=""
                        sizes="(max-width: 640px) 28vw, (max-width: 1280px) 15vw, 10vw"
                        className="svc-wedge-img"
                      />
                    ) : null}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Reveal>
  );
}
