import "server-only";

import { inArray, isNotNull } from "drizzle-orm";

import { db } from "@/lib/db";
import type { Executor } from "@/lib/db/revision";
import { packageDestinations, routeNodes, serviceCategories, services, travelPackages } from "@/lib/db/schema";

import { isPackageRegion } from "./package-model";
import { parseOwnerKey, SINGLETON_ID, type RouteOwner } from "./owners";
import { isServiceRegion } from "./service-model";
import { resourceOf, SPECS } from "./specs";

/**
 * Pictures a Visual Editor draft of a dynamic route has chosen (Batch 22;
 * packages and destinations since Batch 24).
 *
 * Batch 21 let a category's hero and a service's card choose a picture as a
 * draft, Batch 22 adds a service's own page, and Batch 24 a package's hero,
 * a package's card on the Tour packages page and a destination's hero; the
 * choice lives in
 * `route_nodes.draft_content` until it is published. The media library's
 * delete guard counted page-section drafts and reusable-component drafts but
 * not these, so a picture a pending draft was about to publish could be
 * deleted as "unused" — and the publication would then be refused, losing the
 * choice. This is the missing count, and it is deliberately narrow:
 *
 *   · **Only a draft's own choice counts** — the patch's `value` of a field the
 *     adapter declares a picture (`check: "media"`), never its `base`. The base
 *     is the live value the draft started from; the live column counts it
 *     already, through the record itself.
 *   · **Only a draft that can still be published counts.** A region whose
 *     record has been deleted — a service removed on the Services screen — is
 *     dormant: no route can load it, so nothing can publish it, and a picture
 *     it names would otherwise be undeletable for ever.
 *   · **Found by declared field, not by searching values**, so a group id or an
 *     order that happens to equal a picture's id is never mistaken for one.
 *
 * Published presentation (`styles`, `motion`, `copy`) holds no picture, and a
 * version row is history: restoring one skips a picture that has since gone,
 * exactly as it skips any other value that can no longer be stored.
 */

export type RouteDraftMedia = {
  mediaId: number;
  ownerKey: string;
  /** What the draft is, in words: "Visa Assistance — service page draft". */
  label: string;
  /** Where to clear it: the route, open in the Visual Editor. */
  href: string;
};

/** Which records a region's picture belongs to, and where that region is edited now. */
type Resolved = {
  title: string;
  routeKey: string;
  kind:
    | "category page"
    | "card on its category page"
    | "service page"
    | "package page"
    | "card on the Tour packages page"
    | "destination page";
};

export async function routeDraftMedia(on: Executor = db): Promise<RouteDraftMedia[]> {
  const rows = await on
    .select({ ownerKey: routeNodes.ownerKey, draftContent: routeNodes.draftContent })
    .from(routeNodes)
    .where(isNotNull(routeNodes.draftContent));

  const picks: { owner: RouteOwner; ownerKey: string; mediaId: number }[] = [];
  for (const row of rows) {
    const owner = parseOwnerKey(row.ownerKey);
    if (!owner) continue;
    const patch = (row.draftContent ?? {}) as Record<string, unknown>;
    for (const spec of SPECS[owner.type]) {
      if (spec.check !== "media") continue;
      const entry = patch[spec.key];
      const value = entry && typeof entry === "object" ? (entry as { value?: unknown }).value : undefined;
      if (typeof value === "number" && Number.isInteger(value) && value > 0) {
        picks.push({ owner, ownerKey: row.ownerKey, mediaId: value });
      }
    }
  }
  if (!picks.length) return [];

  // The records behind them, one query per kind of record whatever the number of drafts.
  const idsOf = (kind: ReturnType<typeof resourceOf>["kind"]) => [
    ...new Set(picks.filter((pick) => resourceOf(pick.owner).kind === kind).map((pick) => pick.owner.id)),
  ];
  const categoryIds = idsOf("category");
  const serviceIds = idsOf("service");
  const packageIds = idsOf("package");
  const destinationIds = idsOf("destination");
  const categories = categoryIds.length
    ? await on
        .select({ id: serviceCategories.id, title: serviceCategories.titleEn })
        .from(serviceCategories)
        .where(inArray(serviceCategories.id, categoryIds))
    : [];
  const serviceRows = serviceIds.length
    ? await on
        .select({ id: services.id, title: services.titleEn, categoryId: services.categoryId })
        .from(services)
        .where(inArray(services.id, serviceIds))
    : [];
  const packageRows = packageIds.length
    ? await on
        .select({ id: travelPackages.id, title: travelPackages.titleEn })
        .from(travelPackages)
        .where(inArray(travelPackages.id, packageIds))
    : [];
  const destinationRows = destinationIds.length
    ? await on
        .select({ id: packageDestinations.id, title: packageDestinations.titleEn })
        .from(packageDestinations)
        .where(inArray(packageDestinations.id, destinationIds))
    : [];
  const categoryById = new Map(categories.map((row) => [row.id, row]));
  const serviceById = new Map(serviceRows.map((row) => [row.id, row]));
  const packageById = new Map(packageRows.map((row) => [row.id, row]));
  const destinationById = new Map(destinationRows.map((row) => [row.id, row]));

  const resolve = (owner: RouteOwner): Resolved | null => {
    if (owner.type === "category") {
      const row = categoryById.get(owner.id);
      return row ? { title: row.title, routeKey: `category:${row.id}`, kind: "category page" } : null;
    }
    if (owner.type === "service") {
      // A card is edited on whichever category page the service is in now.
      const row = serviceById.get(owner.id);
      return row ? { title: row.title, routeKey: `category:${row.categoryId}`, kind: "card on its category page" } : null;
    }
    if (isServiceRegion(owner.type)) {
      const row = serviceById.get(owner.id);
      return row ? { title: row.title, routeKey: `service:${row.id}`, kind: "service page" } : null;
    }
    if (owner.type === "packageCard") {
      // A package's card is edited on the one catalogue, wherever it is filed.
      const row = packageById.get(owner.id);
      return row
        ? { title: row.title, routeKey: `packageIndex:${SINGLETON_ID}`, kind: "card on the Tour packages page" }
        : null;
    }
    if (isPackageRegion(owner.type)) {
      const row = packageById.get(owner.id);
      return row ? { title: row.title, routeKey: `package:${row.id}`, kind: "package page" } : null;
    }
    if (owner.type === "destinationHero") {
      const row = destinationById.get(owner.id);
      return row ? { title: row.title, routeKey: `destination:${row.id}`, kind: "destination page" } : null;
    }
    return null;
  };

  const out: RouteDraftMedia[] = [];
  for (const pick of picks) {
    const resolved = resolve(pick.owner);
    if (!resolved) continue; // dormant: its record is gone, so nothing can publish it
    out.push({
      mediaId: pick.mediaId,
      ownerKey: pick.ownerKey,
      label: `${resolved.title} — ${resolved.kind} draft`,
      href: `/admin/visual-editor?route=${resolved.routeKey}`,
    });
  }
  return out;
}
