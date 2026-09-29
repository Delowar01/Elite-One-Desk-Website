/**
 * The permission catalogue. Roles are collections of these keys; every server
 * mutation names what it needs, so hiding a button is never the control.
 *
 * Page content is split by what an edit does (Batch 18): its words, its
 * standard styling, its advanced layout styling, its motion, its layout, and
 * publishing — and reusable components have their own four. Which of them an
 * operation needs, alone or together, is decided in `lib/auth/authority.ts`
 * and nowhere else, so a call site asks for a capability by name rather than
 * spelling out keys of its own.
 */
export const PERMISSIONS = [
  { key: "dashboard.view", label: "View dashboard", group: "General" },
  { key: "enquiries.view", label: "View enquiries", group: "Enquiries" },
  { key: "enquiries.manage", label: "Update enquiries, notes and status", group: "Enquiries" },
  { key: "enquiries.export", label: "Export enquiries", group: "Enquiries" },
  { key: "content.view", label: "View pages and sections", group: "Content" },
  { key: "visual_editor.view", label: "Access the Visual Editor", group: "Content" },
  { key: "content.edit", label: "Edit page text, links and media", group: "Content" },
  { key: "content.style", label: "Edit standard styles", group: "Content" },
  {
    key: "content.advanced_style",
    label: "Edit advanced layout styles — size, layout, overflow and glow (with standard styles)",
    group: "Content",
  },
  { key: "content.motion", label: "Edit motion", group: "Content" },
  { key: "content.structure", label: "Add, move, hide, remove and restore sections", group: "Content" },
  { key: "content.publish", label: "Publish, discard and restore pages", group: "Content" },
  { key: "services.manage", label: "Manage service categories and services", group: "Content" },
  { key: "packages.manage", label: "Manage tour packages and destinations", group: "Content" },
  { key: "videos.manage", label: "Manage the video showcase", group: "Content" },
  { key: "testimonials.manage", label: "Manage testimonials", group: "Content" },
  { key: "faqs.manage", label: "Manage FAQs", group: "Content" },
  { key: "media.manage", label: "Upload and delete media", group: "Content" },
  {
    key: "components.view",
    label: "View reusable components, where they are used and their history",
    group: "Reusable components",
  },
  {
    key: "components.edit",
    label: "Create, rename and edit reusable component drafts",
    group: "Reusable components",
  },
  { key: "components.publish", label: "Publish reusable components", group: "Reusable components" },
  {
    key: "components.lifecycle",
    label: "Archive, unarchive and delete reusable components",
    group: "Reusable components",
  },
  { key: "navigation.manage", label: "Manage navigation and footer", group: "Site" },
  { key: "seo.manage", label: "Manage SEO metadata", group: "Site" },
  { key: "settings.manage", label: "Manage site settings and contact details", group: "Site" },
  { key: "analytics.manage", label: "Manage analytics configuration", group: "Site" },
  { key: "users.manage", label: "Manage users", group: "Security" },
  { key: "roles.manage", label: "Change role permissions", group: "Security" },
  { key: "activity.view", label: "View the activity log", group: "Security" },
  /**
   * The key every page write used to need, kept rather than deleted (Batch 18).
   *
   * This release authorizes nothing with it: each page and component operation
   * names its own granular capability, and `content.manage` is **not** a
   * fallback for any of them. It stays in the catalogue, in the grants and in
   * the defaults because the release recorded in `deploy/previous-release`
   * checks it for every page write — a rollback to that runtime must find the
   * roles it relies on exactly as they were. Deleting it, or letting the Roles
   * screen drop it on the next save, would make a rollback lock every editor
   * out. The label says what it does now, so an owner reading the Roles screen
   * is not misled into thinking it grants anything here.
   */
  {
    key: "content.manage",
    label: "Previous release only: edit and publish pages if the site is rolled back",
    group: "Legacy",
  },
] as const;

export type PermissionKey = (typeof PERMISSIONS)[number]["key"];

const ALL = PERMISSIONS.map((p) => p.key) as PermissionKey[];

/**
 * Everything an Editor did under `content.manage`, named one capability at a
 * time — and `content.manage` itself, so a fresh installation rolled back to
 * the previous release still has a working Editor.
 */
const EDITOR: PermissionKey[] = [
  "dashboard.view",
  "enquiries.view",
  "content.view",
  "content.manage",
  "visual_editor.view",
  "content.edit",
  "content.style",
  "content.advanced_style",
  "content.motion",
  "content.structure",
  "content.publish",
  "components.view",
  "components.edit",
  "components.publish",
  "components.lifecycle",
  "services.manage",
  "packages.manage",
  "videos.manage",
  "testimonials.manage",
  "faqs.manage",
  "media.manage",
  "seo.manage",
];

const VIEWER: PermissionKey[] = [
  "dashboard.view",
  "enquiries.view",
  "content.view",
  // Read-only in the canvas, exactly as it is on the Pages screen: each of the
  // editor's writes names its own capability and refuses without it.
  "visual_editor.view",
  // Reading shared content is reading page content — Batch 17 let a viewer see
  // reusable components through `content.view`, and this is that, by name.
  "components.view",
];

/**
 * Admin holds everything except `roles.manage` — rewriting what a role may do
 * is the owner's call. Guarding owner *accounts* is separate and lives in
 * `lib/auth/guard.ts`, because it is about the target row, not the permission.
 */
export const ROLE_DEFAULTS: Record<string, PermissionKey[]> = {
  owner: ALL,
  admin: ALL.filter((k) => k !== "roles.manage"),
  editor: EDITOR,
  viewer: VIEWER,
};

export const ROLE_LABELS: Record<string, { name: string; description: string }> = {
  owner: { name: "Owner", description: "Full access, including users, roles and security." },
  admin: {
    name: "Admin",
    description: "Everything except changing what each role is allowed to do.",
  },
  editor: {
    name: "Editor",
    description: "Content, services, packages, media and SEO. Reads enquiries.",
  },
  viewer: { name: "Viewer", description: "Read-only access to the dashboard and enquiries." },
};

/**
 * How a key reaches a role that **already exists** when the key is first
 * introduced (Batch 18) — by what that role could already do, not by what a
 * new role of its name would be given.
 *
 * The seed introduces a new key once: the run that first finds it missing from
 * the catalogue. For a role that already exists it ordinarily grants the key
 * if `ROLE_DEFAULTS` names it. That is wrong for a key that *splits* an old
 * one: an owner who took `content.manage` away from the Editor would find
 * every half of it handed back, and a Viewer an owner had trusted with
 * `content.manage` would lose the editing it had. So each key below goes to
 * exactly the roles holding its source at that moment — the same access under
 * a finer name, nothing wider and nothing narrower — and, because the key is
 * then in the catalogue, it is never granted again: a later seed cannot undo
 * a decision to remove it.
 *
 * `components.view` comes from `content.view` because that is what let a role
 * read reusable components in Batch 17; the four component writes and the six
 * page capabilities come from `content.manage`, which authorized all of them.
 *
 * The owner role is the exception, and the Roles screen is why: it refuses to
 * narrow the owner, so an owner missing a key would have no way to get it.
 */
export const INTRODUCED_FROM: Partial<Record<PermissionKey, PermissionKey>> = {
  "content.edit": "content.manage",
  "content.style": "content.manage",
  "content.advanced_style": "content.manage",
  "content.motion": "content.manage",
  "content.structure": "content.manage",
  "content.publish": "content.manage",
  "components.view": "content.view",
  "components.edit": "content.manage",
  "components.publish": "content.manage",
  "components.lifecycle": "content.manage",
};

/* -------------------------------------------------------------------------- */
/* What a screen needs                                                        */
/* -------------------------------------------------------------------------- */

/**
 * A permission requirement, as data.
 *
 * A single key was enough while every screen needed exactly one, and many
 * operations now do not:
 *
 *   Visual Editor   `content.view` **and** `visual_editor.view` — the canvas
 *                   holds unpublished drafts, so access to the editor is not a
 *                   substitute for being allowed to see page content.
 *   Users & roles   `users.manage` **or** `roles.manage` — one screen over two
 *                   separately-granted concerns, and holding either is a reason
 *                   to be let in to the half you hold.
 *   Page writes     always all-of: the key for what the write does, and
 *                   `content.view`, because nobody edits what they may not see
 *                   (Batch 18, `lib/auth/authority.ts`).
 *
 * Written as data rather than as special cases so the sidebar filter, the
 * route guard and the action guard read the same sentence. A *write* is never
 * an any-of: that would be two keys disagreeing about who may write.
 */
export type PermissionRequirement =
  | PermissionKey
  | { all: readonly PermissionKey[] }
  | { any: readonly PermissionKey[] };

export function satisfies(
  held: ReadonlySet<PermissionKey> | ReadonlySet<string>,
  need: PermissionRequirement,
): boolean {
  const has = (key: PermissionKey) => (held as ReadonlySet<string>).has(key);
  if (typeof need === "string") return has(need);
  if ("all" in need) return need.all.every(has);
  return need.any.some(has);
}

/** Every key a requirement mentions — for a refusal message or a test. */
export function requirementKeys(need: PermissionRequirement): PermissionKey[] {
  if (typeof need === "string") return [need];
  return [...("all" in need ? need.all : need.any)];
}
