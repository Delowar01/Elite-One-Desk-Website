import Link from "next/link";
import { asc, sql } from "drizzle-orm";

import { AdminPageHeader, EmptyState } from "@/components/admin/page-header";
import { Icon } from "@/components/ui/icon";
import { requirePermission } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { packageDestinations, travelPackages } from "@/lib/db/schema";
import { DestinationRows } from "./destination-rows";

export const metadata = { title: "Destinations" };
export const dynamic = "force-dynamic";

export default async function DestinationsPage() {
  const session = await requirePermission("packages.manage", "/admin/packages");

  // The package count is the number that matters here: a destination with none
  // is invisible on the website, and an admin should be able to see that at a
  // glance rather than discover it on the live page.
  const rows = await db
    .select({
      id: packageDestinations.id,
      slug: packageDestinations.slug,
      titleEn: packageDestinations.titleEn,
      titleAr: packageDestinations.titleAr,
      isPublished: packageDestinations.isPublished,
      packages: sql<number>`(
        select count(*)::int from ${travelPackages}
        where ${travelPackages.destinationId} = ${packageDestinations.id}
          and ${travelPackages.isPublished} = true
      )`,
    })
    .from(packageDestinations)
    .orderBy(asc(packageDestinations.sortOrder), asc(packageDestinations.id));

  const [{ unassigned }] = await db
    .select({ unassigned: sql<number>`count(*)::int` })
    .from(travelPackages)
    .where(sql`${travelPackages.destinationId} is null and ${travelPackages.isPublished} = true`);

  return (
    <>
      <AdminPageHeader
        title="Destinations"
        description="Places tour packages are grouped under. Each one gets its own page; adding another is this screen and nothing else."
        crumbs={[{ label: "Travel packages", href: "/admin/packages" }, { label: "Destinations" }]}
        actions={
          <Link href="/admin/packages/destinations/new" className="admin-btn admin-btn-primary">
            <Icon name="sparkle" size={14} />
            New destination
          </Link>
        }
      />

      {rows.length === 0 ? (
        <EmptyState
          title="No destinations yet"
          body="Until a destination holds a published package, the packages page groups exactly as it does now."
          action={
            <Link href="/admin/packages/destinations/new" className="admin-btn admin-btn-primary">
              New destination
            </Link>
          }
        />
      ) : (
        <>
          <DestinationRows csrf={session.csrfToken} rows={rows} />
          {unassigned > 0 ? (
            <p className="mt-4 text-[0.8rem] text-muted">
              {unassigned} published package{unassigned === 1 ? "" : "s"} belong to no destination.
              They appear under “Build your own”.
            </p>
          ) : null}
        </>
      )}
    </>
  );
}
