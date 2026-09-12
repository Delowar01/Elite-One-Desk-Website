import { asc } from "drizzle-orm";

import { AdminPageHeader } from "@/components/admin/page-header";
import { requirePermission } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { socialLinks } from "@/lib/db/schema";
import { getSettings } from "@/lib/settings";
import { SettingsClient, type SocialRow } from "./settings-client";
import { isSettingsTab } from "./tabs";

export const metadata = { title: "Site settings" };
export const dynamic = "force-dynamic";

/**
 * `?tab=` picks the panel. It makes a section linkable — the restructure script
 * prints `/admin/settings?tab=maintenance` for exactly that reason — and it
 * means each panel is rendered by the server rather than only appearing once
 * the page has hydrated, so every form here works without JavaScript.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const session = await requirePermission("settings.manage", "/admin/settings");
  const requested = (await searchParams).tab;
  const [settings, social] = await Promise.all([
    getSettings(),
    db.select().from(socialLinks).orderBy(asc(socialLinks.sortOrder), asc(socialLinks.id)),
  ]);

  return (
    <>
      <AdminPageHeader
        title="Site settings"
        description="Everything the site reads about the business itself. Nothing here is guessed: an empty field renders as nothing rather than as a placeholder."
      />
      <SettingsClient
        csrf={session.csrfToken}
        settings={settings}
        social={social as SocialRow[]}
        initialTab={isSettingsTab(requested) ? requested : "brand"}
      />
    </>
  );
}
