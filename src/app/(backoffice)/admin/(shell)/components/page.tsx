import { AdminPageHeader } from "@/components/admin/page-header";
import { may } from "@/lib/auth/authority";
import { requirePermissions } from "@/lib/auth/guard";
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
 * Read with `components.view` (Batch 18); every change is made in a
 * component's own editor and checked there, each with its own capability.
 * Admin-only, like everything under `/admin` — never indexed, never cached,
 * no public address.
 */
export default async function ReusableComponentsPage() {
  const session = await requirePermissions(REUSE_AUTHORITY.view, "/admin/components");
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
        canCreate={may(session.permissions, "editComponents")}
        csrf={session.csrfToken}
      />
    </>
  );
}
