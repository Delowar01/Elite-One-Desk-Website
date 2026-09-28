import Link from "next/link";
import { notFound } from "next/navigation";

import { AdminPageHeader } from "@/components/admin/page-header";
import { requirePermission } from "@/lib/auth/guard";
import { REUSE_AUTHORITY } from "@/lib/cms/reuse/authority";
import { getComponent } from "@/lib/cms/reuse/service";

import { loadMediaOptions } from "../media";
import { ComponentDetail } from "./component-detail";

export const metadata = { title: "Reusable component" };
export const dynamic = "force-dynamic";

/** One reusable component: its content, where it is used, its history and its lifecycle. */
export default async function ReusableComponentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id: raw } = await params;
  const session = await requirePermission(REUSE_AUTHORITY.view, `/admin/components/${raw}`);
  const id = /^[1-9][0-9]{0,9}$/.test(raw) ? Number(raw) : 0;
  const component = id ? await getComponent(id) : null;
  if (!component) notFound();
  const media = await loadMediaOptions();
  return (
    <>
      <AdminPageHeader
        title={component.name}
        crumbs={[{ label: "Reusable components", href: "/admin/components" }, { label: component.name }]}
        actions={
          <Link href="/admin/components" className="admin-btn">
            All reusable components
          </Link>
        }
      />
      <div className="max-w-3xl">
        <ComponentDetail
          id={component.id}
          csrf={session.csrfToken}
          canManage={session.permissions.has(REUSE_AUTHORITY.edit)}
          media={media}
        />
      </div>
    </>
  );
}
