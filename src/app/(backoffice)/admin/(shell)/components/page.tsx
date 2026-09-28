import { AdminPageHeader } from "@/components/admin/page-header";
import { requirePermission } from "@/lib/auth/guard";
import { REUSE_AUTHORITY } from "@/lib/cms/reuse/authority";
import { REUSABLE_KINDS } from "@/lib/cms/reuse/kinds";

import { loadReusableCatalog } from "./actions";
import { ComponentsClient } from "./components-client";

export const metadata = { title: "Reusable components" };
export const dynamic = "force-dynamic";

/**
 * Reusable components (Batch 17): every call to action and section content
 * that several pages share, with what uses it.
 *
 * Read with `content.view`, like the pages it serves; every change is made in
 * a component's own editor and checked there. Admin-only, like everything
 * under `/admin` — never indexed, never cached, no public address.
 */
export default async function ReusableComponentsPage() {
  const session = await requirePermission(REUSE_AUTHORITY.view, "/admin/components");
  const catalog = (await loadReusableCatalog()) ?? [];
  return (
    <>
      <AdminPageHeader
        title="Reusable components"
        description="Content shared by several pages — a call to action, or a whole closing panel. Edit it once, publish it once, and every page that links to it follows. Site settings such as the menus and contact details are separate."
      />
      <ComponentsClient
        entries={catalog}
        kinds={REUSABLE_KINDS.map((entry) => ({ kind: entry.kind, label: entry.label }))}
        canManage={session.permissions.has(REUSE_AUTHORITY.edit)}
        csrf={session.csrfToken}
      />
    </>
  );
}
