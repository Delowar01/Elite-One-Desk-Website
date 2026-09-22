import type { PermissionRequirement } from "@/lib/auth/permissions";

/**
 * The admin sidebar. Each entry names the permission it needs, so the menu and
 * the server guard on the page behind it are driven by the same key — a link
 * cannot appear for someone who would be refused when they follow it.
 */
export type AdminNavItem = {
  href: string;
  label: string;
  icon: string;
  /**
   * What the route behind this link asks for, in the same shape the route asks
   * for it — a key, `{ all: [...] }` or `{ any: [...] }`. Expressed here rather
   * than as a special case in the sidebar, so adding a compound screen is one
   * entry in this file.
   */
  permission: PermissionRequirement;
  /** Marks the entry active for its own sub-routes too. */
  exact?: boolean;
};

export type AdminNavGroup = { title: string; items: AdminNavItem[] };

export const ADMIN_NAV: AdminNavGroup[] = [
  {
    title: "Overview",
    items: [
      { href: "/admin", label: "Dashboard", icon: "layers", permission: "dashboard.view", exact: true },
      { href: "/admin/enquiries", label: "Enquiries", icon: "mail", permission: "enquiries.view" },
    ],
  },
  {
    title: "Content",
    items: [
      { href: "/admin/pages", label: "Pages & sections", icon: "fileText", permission: "content.view" },
      // An additional interface over the same CMS, not a replacement for the
      // screen above it: the two edit the same rows and both stay.
      // All-of: the canvas shows unpublished drafts, so being allowed into the
      // editor is not a substitute for being allowed to see page content.
      {
        href: "/admin/visual-editor",
        label: "Visual Editor",
        icon: "sparkle",
        permission: { all: ["content.view", "visual_editor.view"] },
      },
      { href: "/admin/categories", label: "Service categories", icon: "layers", permission: "services.manage" },
      { href: "/admin/services", label: "Services", icon: "briefcase", permission: "services.manage" },
      { href: "/admin/packages/destinations", label: "Destinations", icon: "mapPin", permission: "packages.manage" },
      { href: "/admin/packages", label: "Travel packages", icon: "plane", permission: "packages.manage", exact: true },
      { href: "/admin/videos", label: "Videos", icon: "play", permission: "videos.manage" },
      { href: "/admin/testimonials", label: "Testimonials", icon: "quote", permission: "testimonials.manage" },
      { href: "/admin/faqs", label: "FAQs", icon: "sparkle", permission: "faqs.manage" },
      { href: "/admin/media", label: "Media library", icon: "layers", permission: "media.manage" },
    ],
  },
  {
    title: "Site",
    items: [
      { href: "/admin/navigation", label: "Navigation & footer", icon: "route", permission: "navigation.manage" },
      { href: "/admin/settings", label: "Site settings", icon: "desk", permission: "settings.manage" },
      { href: "/admin/seo", label: "SEO", icon: "search", permission: "seo.manage" },
      { href: "/admin/analytics", label: "Analytics", icon: "globe", permission: "analytics.manage" },
    ],
  },
  {
    title: "Administration",
    items: [
      // Any-of: one screen over two separately-granted concerns. Holding either
      // is a reason to be let in to the half you hold.
      {
        href: "/admin/users",
        label: "Users & roles",
        icon: "users",
        permission: { any: ["users.manage", "roles.manage"] },
      },
      { href: "/admin/activity", label: "Activity log", icon: "clock", permission: "activity.view" },
    ],
  },
];
