import "server-only";

import { asc } from "drizzle-orm";

import type { AdminSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { navigationItems, socialLinks } from "@/lib/db/schema";
import { getSettings } from "@/lib/settings";

/**
 * What the Visual Editor's Globals panel is allowed to know.
 *
 * Global site chrome — the menus, the brand and contact details, WhatsApp, the
 * disclaimers, the visible feature switches and the social links — has no draft
 * state and no page history. It is the same data the ordinary Navigation and
 * Site settings screens edit, through the same actions; this module only
 * decides what reaches the editor's browser.
 *
 * **Permission-scoped by construction.** A domain the caller may not manage is
 * not fetched and is not serialized: the panel does not receive it with the
 * controls disabled. That matters because some of these values are not on the
 * public site at all — a hidden social link, a WhatsApp number with the switch
 * off, the default messages, a feature nobody has turned on — and sending them
 * to anybody who can open a canvas would be handing out settings on the
 * strength of `content.view`.
 *
 * Nothing here carries analytics ids, SEO administration, user or role data, or
 * anything from a page snapshot. `settings.analytics` and `settings.seo` are
 * read by `getSettings()` and deliberately dropped on the way out.
 */

export type GlobalNavRow = {
  id: number;
  menu: string;
  parentId: number | null;
  labelEn: string;
  labelAr: string;
  href: string;
  sortOrder: number;
  isHighlighted: boolean;
  isPublished: boolean;
};

export type GlobalSocialRow = {
  id: number;
  platform: string;
  url: string;
  isPublished: boolean;
};

export type GlobalsState = {
  /** `null` means "not yours to manage", which is also "not sent". */
  navigation: { rows: GlobalNavRow[] } | null;
  settings: {
    brand: Record<string, string>;
    contact: Record<string, string>;
    whatsapp: { enabled: boolean; number: string; defaultMessageEn: string; defaultMessageAr: string; floatingEnabled: boolean };
    disclaimers: { governmentEn: string; governmentAr: string; visaEn: string; visaAr: string; showOnServicePages: boolean };
    features: Record<string, boolean>;
    social: GlobalSocialRow[];
  } | null;
};

/**
 * What this session may do in the editor, one capability per domain.
 *
 * Four separate answers rather than one "may edit" boolean, because they are
 * granted separately and a single flag would hand all of them to whoever held
 * any one. `canViewContent` is the route's own precondition — nobody is inside
 * the editor without it — so it is computed here for the guard to read and is
 * not passed down as a prop the canvas would never consult.
 */
export type EditorCapabilities = {
  canViewContent: boolean;
  canManageContent: boolean;
  canManageNavigation: boolean;
  canManageSettings: boolean;
};

export function globalsCapabilities(session: AdminSession): EditorCapabilities {
  return {
    canViewContent: session.permissions.has("content.view"),
    canManageContent: session.permissions.has("content.manage"),
    canManageNavigation: session.permissions.has("navigation.manage"),
    canManageSettings: session.permissions.has("settings.manage"),
  };
}

async function readNavigation(): Promise<{ rows: GlobalNavRow[] }> {
  const rows = await db
    .select({
      id: navigationItems.id,
      menu: navigationItems.menu,
      parentId: navigationItems.parentId,
      labelEn: navigationItems.labelEn,
      labelAr: navigationItems.labelAr,
      href: navigationItems.href,
      sortOrder: navigationItems.sortOrder,
      isHighlighted: navigationItems.isHighlighted,
      isPublished: navigationItems.isPublished,
    })
    .from(navigationItems)
    .orderBy(asc(navigationItems.menu), asc(navigationItems.sortOrder), asc(navigationItems.id));
  return { rows };
}

async function readSettings(): Promise<NonNullable<GlobalsState["settings"]>> {
  const [settings, social] = await Promise.all([
    getSettings(),
    db
      .select({
        id: socialLinks.id,
        platform: socialLinks.platform,
        url: socialLinks.url,
        isPublished: socialLinks.isPublished,
      })
      .from(socialLinks)
      .orderBy(asc(socialLinks.sortOrder), asc(socialLinks.id)),
  ]);

  // Named field by field rather than spread, so a group added to
  // `SETTINGS_DEFAULTS` later cannot reach a browser by accident.
  return {
    brand: { ...settings.brand },
    contact: { ...settings.contact },
    whatsapp: { ...settings.whatsapp },
    disclaimers: { ...settings.disclaimers },
    features: { ...settings.features },
    social,
  };
}

export async function loadEditorGlobals(session: AdminSession): Promise<GlobalsState> {
  const { canManageNavigation, canManageSettings } = globalsCapabilities(session);
  const [navigation, settings] = await Promise.all([
    canManageNavigation ? readNavigation() : Promise.resolve(null),
    canManageSettings ? readSettings() : Promise.resolve(null),
  ]);
  return { navigation, settings };
}
