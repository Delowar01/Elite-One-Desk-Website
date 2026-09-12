import Link from "next/link";
import { notFound } from "next/navigation";
import { asc, eq, sql } from "drizzle-orm";

import { AdminPageHeader } from "@/components/admin/page-header";
import { requirePermission } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { media, packageDestinations, travelPackages } from "@/lib/db/schema";
import { DeleteDestination, DestinationForm, type DestinationValues } from "../destination-form";

export const dynamic = "force-dynamic";

const BLANK: DestinationValues = {
  slug: "",
  titleEn: "",
  titleAr: "",
  summaryEn: "",
  summaryAr: "",
  imageId: null,
  isPublished: true,
  sortOrder: 0,
};

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (id === "new") return { title: "New destination" };
  const [row] = await db
    .select({ titleEn: packageDestinations.titleEn })
    .from(packageDestinations)
    .where(eq(packageDestinations.id, Number(id) || 0))
    .limit(1);
  return { title: row?.titleEn ?? "Destination" };
}

export default async function DestinationEditor({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission("packages.manage");
  const { id: rawId } = await params;
  const isNew = rawId === "new";
  const id = isNew ? 0 : Number(rawId) || 0;

  const library = await db
    .select({
      id: media.id,
      filename: media.filename,
      title: media.title,
      altEn: media.altEn,
      width: media.width,
      height: media.height,
      folder: media.folder,
    })
    .from(media)
    .orderBy(asc(media.folder), asc(media.title));

  const crumbs = [
    { label: "Travel packages", href: "/admin/packages" },
    { label: "Destinations", href: "/admin/packages/destinations" },
  ];

  if (isNew) {
    return (
      <>
        <AdminPageHeader
          title="New destination"
          crumbs={[...crumbs, { label: "New" }]}
          actions={
            <Link href="/admin/packages/destinations" className="admin-btn">
              Cancel
            </Link>
          }
        />
        <div className="max-w-4xl">
          <DestinationForm csrf={session.csrfToken} destination={BLANK} media={library} />
        </div>
      </>
    );
  }

  const [row] = await db
    .select()
    .from(packageDestinations)
    .where(eq(packageDestinations.id, id))
    .limit(1);
  if (!row) notFound();

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(travelPackages)
    .where(eq(travelPackages.destinationId, id));

  return (
    <>
      <AdminPageHeader
        title={row.titleEn}
        description={`/packages/${row.slug}`}
        crumbs={[...crumbs, { label: row.titleEn }]}
        actions={
          <Link href="/admin/packages/destinations" className="admin-btn">
            Back
          </Link>
        }
      />
      <div className="max-w-4xl space-y-6">
        <DestinationForm
          csrf={session.csrfToken}
          destination={{
            id: row.id,
            slug: row.slug,
            titleEn: row.titleEn,
            titleAr: row.titleAr,
            summaryEn: row.summaryEn,
            summaryAr: row.summaryAr,
            imageId: row.imageId,
            isPublished: row.isPublished,
            sortOrder: row.sortOrder,
          }}
          media={library}
        />
        <DeleteDestination
          csrf={session.csrfToken}
          id={row.id}
          title={row.titleEn}
          packageCount={count}
        />
      </div>
    </>
  );
}
