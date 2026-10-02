/**
 * Elite One Desk — database schema.
 *
 * Two conventions run through the whole file:
 *
 *  1. Localised text is a pair of columns (`titleEn` / `titleAr`) rather than a
 *     translations table. Every localisable field is known at build time, so a
 *     pair of columns keeps the types honest and a page render to one query.
 *     Arabic is optional everywhere: an empty Arabic field falls back to
 *     English at read time (see `lib/i18n/pick.ts`), which is what lets the
 *     Arabic edition ship before it is fully translated.
 *
 *  2. Anything an editor arranges freely — a list of benefits, the fields of a
 *     homepage block — is `jsonb` validated by a Zod schema on the way in
 *     (`lib/validation`). Anything queried, filtered or joined is a column.
 */
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from "drizzle-orm/pg-core";

/* -------------------------------------------------------------------------- */
/* Enums                                                                      */
/* -------------------------------------------------------------------------- */

export const roleKeyEnum = pgEnum("role_key", ["owner", "admin", "editor", "viewer"]);

export const enquiryStatusEnum = pgEnum("enquiry_status", [
  "new",
  "contacted",
  "in_progress",
  "waiting_customer",
  "completed",
  "closed",
  "spam",
]);

export const contactMethodEnum = pgEnum("contact_method", [
  "phone",
  "whatsapp",
  "email",
]);

export const pageKindEnum = pgEnum("page_kind", ["builtin", "custom"]);

export const navMenuEnum = pgEnum("nav_menu", [
  "header",
  "footer_services",
  "footer_company",
  "footer_legal",
]);

export const faqScopeEnum = pgEnum("faq_scope", ["global", "category", "service"]);

export const packageRegionEnum = pgEnum("package_region", [
  "egypt",
  "international",
  "holiday",
  "corporate",
]);

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
};

/* -------------------------------------------------------------------------- */
/* Identity, access control and audit                                          */
/* -------------------------------------------------------------------------- */

export const roles = pgTable("roles", {
  id: serial("id").primaryKey(),
  key: roleKeyEnum("key").notNull().unique(),
  name: varchar("name", { length: 64 }).notNull(),
  description: text("description").notNull().default(""),
  /** System roles cannot be renamed or deleted from the panel. */
  isSystem: boolean("is_system").notNull().default(true),
  ...timestamps,
});

export const permissions = pgTable("permissions", {
  id: serial("id").primaryKey(),
  /** Dotted key, e.g. `services.manage`. */
  key: varchar("key", { length: 64 }).notNull().unique(),
  label: varchar("label", { length: 128 }).notNull(),
  groupName: varchar("group_name", { length: 64 }).notNull().default("General"),
});

export const rolePermissions = pgTable(
  "role_permissions",
  {
    roleId: integer("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "cascade" }),
    permissionId: integer("permission_id")
      .notNull()
      .references(() => permissions.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.roleId, t.permissionId] })],
);

export const users = pgTable(
  "users",
  {
    id: serial("id").primaryKey(),
    email: varchar("email", { length: 190 }).notNull(),
    name: varchar("name", { length: 120 }).notNull(),
    /** `scrypt$N$r$p$saltB64$hashB64` — see lib/auth/password.ts. */
    passwordHash: text("password_hash").notNull(),
    roleId: integer("role_id")
      .notNull()
      .references(() => roles.id, { onDelete: "restrict" }),
    isActive: boolean("is_active").notNull().default(true),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [uniqueIndex("users_email_lower_idx").on(sql`lower(${t.email})`)],
);

export const sessions = pgTable(
  "sessions",
  {
    id: varchar("id", { length: 48 }).primaryKey(),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** SHA-256 of the cookie secret half; the raw value never touches the DB. */
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    /** Double-submit CSRF token for admin mutations. */
    csrfToken: varchar("csrf_token", { length: 64 }).notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    ipHash: varchar("ip_hash", { length: 64 }).notNull().default(""),
    userAgent: varchar("user_agent", { length: 255 }).notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const loginAttempts = pgTable(
  "login_attempts",
  {
    id: serial("id").primaryKey(),
    /** Lower-cased email, or `ip:<hash>` when the email is unknown. */
    identifier: varchar("identifier", { length: 190 }).notNull(),
    ipHash: varchar("ip_hash", { length: 64 }).notNull().default(""),
    successful: boolean("successful").notNull().default(false),
    attemptedAt: timestamp("attempted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("login_attempts_lookup_idx").on(t.identifier, t.attemptedAt)],
);

export const activityLogs = pgTable(
  "activity_logs",
  {
    id: serial("id").primaryKey(),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    /** Actor name captured at write time so the log survives a deleted user. */
    actorName: varchar("actor_name", { length: 120 }).notNull().default("System"),
    action: varchar("action", { length: 64 }).notNull(),
    entityType: varchar("entity_type", { length: 48 }).notNull().default(""),
    entityId: varchar("entity_id", { length: 64 }).notNull().default(""),
    summary: varchar("summary", { length: 255 }).notNull().default(""),
    metadata: jsonb("metadata").$type<Record<string, unknown>>(),
    ipHash: varchar("ip_hash", { length: 64 }).notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("activity_logs_created_idx").on(t.createdAt)],
);

/* -------------------------------------------------------------------------- */
/* Media                                                                       */
/* -------------------------------------------------------------------------- */

export const media = pgTable(
  "media",
  {
    id: serial("id").primaryKey(),
    /** Stored file name inside UPLOAD_DIR; the public path is /media/<name>. */
    filename: varchar("filename", { length: 190 }).notNull().unique(),
    originalName: varchar("original_name", { length: 190 }).notNull().default(""),
    mimeType: varchar("mime_type", { length: 64 }).notNull(),
    byteSize: integer("byte_size").notNull().default(0),
    width: integer("width").notNull().default(0),
    height: integer("height").notNull().default(0),
    /** Derivative widths written next to the original, e.g. [400, 800, 1600]. */
    derivatives: jsonb("derivatives").$type<number[]>().notNull().default(sql`'[]'::jsonb`),
    title: varchar("title", { length: 190 }).notNull().default(""),
    altEn: varchar("alt_en", { length: 255 }).notNull().default(""),
    altAr: varchar("alt_ar", { length: 255 }).notNull().default(""),
    folder: varchar("folder", { length: 64 }).notNull().default("general"),
    uploadedBy: integer("uploaded_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("media_folder_idx").on(t.folder), index("media_created_idx").on(t.createdAt)],
);

/* -------------------------------------------------------------------------- */
/* Pages and the section-based homepage CMS                                    */
/* -------------------------------------------------------------------------- */

export const pages = pgTable("pages", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 120 }).notNull().unique(),
  kind: pageKindEnum("kind").notNull().default("custom"),
  titleEn: varchar("title_en", { length: 190 }).notNull(),
  titleAr: varchar("title_ar", { length: 190 }).notNull().default(""),
  isPublished: boolean("is_published").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  /**
   * The page's structure as it is being edited, not as it is being served.
   *
   * Today reorder, hide and delete write straight to the live rows
   * (`pageSections.position`, `.isPublished`, and an actual DELETE), so there
   * is nowhere for "I have rearranged this page but not published it" to live.
   * This column is that place: a validated document listing section ids in
   * draft order with their intended visibility — see `lib/cms/structure.ts`.
   *
   * Written by `cms/structure-service` — every structural operation on either
   * editing screen edits this and nothing live — read by `composePreview` so an
   * editor can see what publishing would do, and turned into rows by
   * `cms/publish-service`. `NULL` means no pending structural change; a stored
   * document this build cannot read is refused by publication rather than
   * treated as either of those.
   */
  draftStructure: jsonb("draft_structure").$type<Record<string, unknown>>(),
  /**
   * Optimistic-concurrency token for the page's structure. Not a timestamp:
   * two saves inside the same clock tick are indistinguishable by time and are
   * not by this. See `lib/db/revision.ts`.
   */
  revision: integer("revision").notNull().default(0),
  updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
  ...timestamps,
});

export const pageSections = pgTable(
  "page_sections",
  {
    id: serial("id").primaryKey(),
    pageId: integer("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    /** One of the fixed block types in lib/cms/blocks.ts — never free markup. */
    blockType: varchar("block_type", { length: 48 }).notNull(),
    position: integer("position").notNull().default(0),
    /**
     * Whether the live site draws this section. Visibility, not membership —
     * see `isDraftOnly`, which is the other question and a different one.
     */
    isPublished: boolean("is_published").notNull().default(true),
    /**
     * Whether this row is part of the page's established composition at all.
     *
     * `false` — an ordinary section. It belongs to the page as published,
     * whether it is visible (`isPublished`) or deliberately hidden.
     * `true` — the row exists only because of a pending structural draft: a
     * block added in the visual editor and not published yet, or a section a
     * version restore brought back. It is not part of the published page.
     *
     * The two are not the same question and neither can be inferred from the
     * other. A hidden established section and a pending new one both sit at
     * `isPublished = false`, both may have empty published values, and both may
     * carry a draft — so `isPublished`, emptiness, position and draft presence
     * are all ambiguous, and code that guesses gets it wrong in the direction
     * that deletes somebody's hidden section. This column says which it is, and
     * it is the only thing that says so.
     *
     * What reads it: `capturePageSnapshot`, which records the published
     * composition and so takes `isDraftOnly = false` — hidden sections
     * included, pending ones not. Batch 8 and 10 add the rest: discarding a
     * structural draft may remove draft-only rows and must never remove an
     * established hidden one; publishing one clears the flag.
     */
    isDraftOnly: boolean("is_draft_only").notNull().default(false),
    /** What the live site renders. */
    published: jsonb("published").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** Pending edits. Never rendered publicly; visible in preview mode only. */
    draft: jsonb("draft").$type<Record<string, unknown>>(),
    /**
     * The **published** entrance preset — one of the five in `lib/cms/motion`.
     *
     * What `SectionRenderer` puts on the section's wrapper for a visitor, and
     * therefore the column an edit must not reach until somebody publishes it.
     * Only three writers touch it: publishing a section, publishing a page's
     * drafts, and the ordinary section form's "Save and publish". A draft save
     * used to write it too, which meant that the moment anything rendered the
     * value a draft would have changed the live page; that is closed, and
     * `tests/data-foundation.test.ts` asserts the closure rather than the leak.
     *
     * Read through `motionOf`, never raw: the column is `NOT NULL DEFAULT
     * 'fade-up'` and predates the vocabulary being enforced, so a row may hold
     * a string that is not a preset.
     */
    animation: varchar("animation", { length: 32 }).notNull().default("fade-up"),
    /**
     * Published visual overrides — a validated, closed-vocabulary document,
     * never CSS text. Keys are section-*relative* node paths (`root`,
     * `field:headline`, …); the row already says which section this is. See
     * `lib/cms/styles.ts`.
     *
     * Read by the public renderer through `composePublished`, and by preview
     * through `composePreview`, which prefers `draft_styles` when there is one.
     */
    styles: jsonb("styles").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    /** The same document, unpublished. Promoted beside `draft` → `published`. */
    draftStyles: jsonb("draft_styles").$type<Record<string, unknown>>(),
    /**
     * The pending entrance preset — motion's draft column, beside `draft` and
     * `draft_styles`.
     *
     * `NULL` and a value are different answers, and the difference is
     * load-bearing in the same way it is for `draft_styles`: `NULL` means "no
     * motion draft, show what is published", while `'none'` is a real preset
     * meaning "publishing me removes this section's entrance". If emptiness
     * were the test, turning an animation off would be indistinguishable from
     * never having touched it, and publishing would leave it running.
     *
     * Read by `composePreview` — so the canvas and `?preview=1` show it and
     * the live page does not — and promoted into `animation` by the same
     * guarded write that promotes the other two domains.
     */
    draftAnimation: varchar("draft_animation", { length: 32 }),
    /**
     * Published advanced motion — a validated, closed-vocabulary document, never
     * CSS, a class, a transform or a timing function. Keys under `nodes` are
     * section-*relative* node paths, the same identity styles and Layers use.
     * See `lib/cms/motion-doc.ts`.
     *
     * **Additive, and beside the legacy columns rather than instead of them.**
     * `animation` and `draft_animation` keep their exact meaning: the release in
     * `deploy/previous-release` reads those two and understands five preset
     * strings, so a publication continues to write one of the five into
     * `animation` (`legacyProjection`) even when the advanced document says
     * something richer. An older build therefore still shows a sensible section
     * entrance and simply cannot see these two columns; a newer build prefers
     * this document where it names something and the legacy preset otherwise.
     * Reinterpreting the varchar columns would have been the destructive
     * alternative, and it would have broken rollback.
     *
     * `NULL` is the one spelling of "no advanced motion" on the published side:
     * publishing an emptied document writes `NULL` (`motionPromotion`), so a
     * row that never had advanced motion and one whose motion was reset render,
     * snapshot and restore identically — as the legacy preset alone.
     */
    motionConfig: jsonb("motion_config").$type<Record<string, unknown>>(),
    /**
     * The same document, unpublished — motion's second draft column.
     *
     * `NULL` means "no advanced motion draft"; an empty-but-present document is
     * a real draft meaning "publishing me removes every advanced motion this
     * section has". `drafts.ts` folds it into the existing `motion` domain
     * rather than inventing a fourth, so a section still has seven ways to be
     * pending and one Motion save owns both motion columns together.
     */
    draftMotionConfig: jsonb("draft_motion_config").$type<Record<string, unknown>>(),
    /** Optimistic-concurrency token — see `lib/db/revision.ts`. */
    revision: integer("revision").notNull().default(0),
    updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [
    index("page_sections_page_idx").on(t.pageId, t.position),
    /**
     * The sections that reference a reusable component (Batch 17).
     *
     * A reference lives inside the section's own content document, under the
     * reserved `_reuse` key — see `lib/cms/reuse/reference.ts` for why there is
     * no separate instances table. Partial, so it holds only the few rows that
     * carry one, and it is what lets "Used on X pages" be a query over those
     * rows rather than a scan of every page's content. Additive: nothing reads
     * it but the planner.
     */
    index("page_sections_reuse_idx")
      .on(t.pageId)
      .where(sql`(${t.published} ? '_reuse') OR (${t.draft} ? '_reuse')`),
  ],
);

/* -------------------------------------------------------------------------- */
/* Reusable content components (Batch 17)                                     */
/* -------------------------------------------------------------------------- */

/**
 * A piece of content several page sections deliberately share.
 *
 * Not a site global. Navigation, contact details, WhatsApp and social links are
 * site settings with their own screens and their own immediate-live rules, and
 * they stay exactly as they are. This is the other kind: a call to action, or a
 * whole closing panel, that an editor chose to reuse — edited once, published
 * once, and followed by every section that links to it.
 *
 * What a component is, deliberately, is **values of a registered kind** — the
 * same validated, closed-vocabulary documents a section's content already is,
 * checked by the same validator. Never markup, never CSS, never a selector.
 * `kind` names the shape (`cta`, or `block:<type>` for a whole block); the list
 * of kinds lives in code (`lib/cms/reuse/kinds.ts`), not here.
 *
 * It has a draft and a published form, like a section, and for the same
 * reason: a change that reaches every linked page at once has to be looked at
 * before it goes out. `published` is what linked pages show; `draft` is pending
 * work, `NULL` when there is none. `published` is `NULL` until the first
 * publication, and a component nobody has published cannot be linked.
 *
 * The component owns its content and nothing else. Where it sits, how it is
 * styled and how it moves belong to each section that uses it, so one token is
 * never decided in two places.
 */
export const reusableComponents = pgTable(
  "reusable_components",
  {
    id: serial("id").primaryKey(),
    /** `cta` or `block:<type>` — a key in the in-code kind registry. */
    kind: varchar("kind", { length: 48 }).notNull(),
    /** Admin metadata. Never rendered; references are by id, so a rename breaks nothing. */
    name: varchar("name", { length: 120 }).notNull(),
    /** What linked sections render. `NULL` until the first publication. */
    published: jsonb("published").$type<Record<string, unknown>>(),
    /** Pending edits, or `NULL` for none. Seen only in the component's own preview. */
    draft: jsonb("draft").$type<Record<string, unknown>>(),
    /**
     * How many times the component has been published: 0 before the first
     * publication, then 1, 2, … A page version records the number it was
     * showing, which is how history can say which content a page had.
     */
    publishedVersion: integer("published_version").notNull().default(0),
    /**
     * The component's own concurrency token. Not a section's and not a page's:
     * editing a component never moves a page's revision, and every write to
     * the component names this one.
     */
    revision: integer("revision").notNull().default(0),
    /** `active` or `archived`. Archived components keep rendering and cannot be newly linked. */
    status: varchar("status", { length: 16 }).notNull().default("active"),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
    publishedBy: integer("published_by").references(() => users.id, { onDelete: "set null" }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    ...timestamps,
  },
  (t) => [index("reusable_components_status_idx").on(t.status, t.name)],
);

/**
 * A component as it was published, kept so it can be put back.
 *
 * The component's counterpart to `page_versions`, and deliberately not that
 * table: a page version is a page's composition, and rolling one component
 * back must not roll any page back. One row per publication, holding the
 * definition that publication replaced — so the first publication writes none,
 * and "Current live" is always the component row itself. Written and pruned
 * inside the publishing transaction.
 */
export const reusableComponentVersions = pgTable(
  "reusable_component_versions",
  {
    id: serial("id").primaryKey(),
    componentId: integer("component_id")
      .notNull()
      .references(() => reusableComponents.id, { onDelete: "cascade" }),
    /** The published version number these values were. */
    version: integer("version").notNull(),
    values: jsonb("values").$type<Record<string, unknown>>().notNull(),
    label: varchar("label", { length: 120 }).notNull().default(""),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    /** Captured at write time so the row survives a deleted user. */
    actorName: varchar("actor_name", { length: 120 }).notNull().default("System"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("reusable_component_versions_version_idx").on(t.componentId, t.version),
    index("reusable_component_versions_component_idx").on(t.componentId, t.id),
  ],
);

/* -------------------------------------------------------------------------- */
/* Service taxonomy                                                            */
/* -------------------------------------------------------------------------- */

/**
 * A published page, kept so it can be put back.
 *
 * One row is one moment: the sections of one page as they were published, in
 * order, with their values, their styles and their motion value. Deliberately
 * *not* the page's own title or settings, and deliberately not anything global —
 * those have no draft form, so restoring them would take effect the instant the
 * row was written, and a restore has to be previewable before it is live. See
 * `lib/cms/snapshot.ts` for the document and what it excludes.
 *
 * One row per successful live publication, holding the page as it stood
 * immediately *before* it — a restore point rather than a record of what went
 * out, because what an editor reaches for after publishing something wrong is
 * the state they just left. Written inside the publishing transaction and
 * pruned there too, so a rolled-back publication leaves neither a version nor a
 * changed retention. `lib/versions.ts` owns both ends.
 */
export const pageVersions = pgTable(
  "page_versions",
  {
    id: serial("id").primaryKey(),
    pageId: integer("page_id")
      .notNull()
      .references(() => pages.id, { onDelete: "cascade" }),
    label: varchar("label", { length: 120 }).notNull().default(""),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    /** Captured at write time so the row survives a deleted user. */
    actorName: varchar("actor_name", { length: 120 }).notNull().default("System"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("page_versions_page_idx").on(t.pageId, t.createdAt)],
);

export const serviceCategories = pgTable("service_categories", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 120 }).notNull().unique(),
  titleEn: varchar("title_en", { length: 190 }).notNull(),
  titleAr: varchar("title_ar", { length: 190 }).notNull().default(""),
  /** Short line under the title on cards and category heroes. */
  taglineEn: varchar("tagline_en", { length: 255 }).notNull().default(""),
  taglineAr: varchar("tagline_ar", { length: 255 }).notNull().default(""),
  summaryEn: text("summary_en").notNull().default(""),
  summaryAr: text("summary_ar").notNull().default(""),
  bodyEn: text("body_en").notNull().default(""),
  bodyAr: text("body_ar").notNull().default(""),
  /** Key into the in-code icon set — never raw SVG from the panel. */
  icon: varchar("icon", { length: 48 }).notNull().default("desk"),
  imageId: integer("image_id").references(() => media.id, { onDelete: "set null" }),
  ctaLabelEn: varchar("cta_label_en", { length: 64 }).notNull().default(""),
  ctaLabelAr: varchar("cta_label_ar", { length: 64 }).notNull().default(""),
  /**
   * Where the hero's primary call to action goes (Batch 21). Empty means
   * `/contact`, which is what the button always pointed at before the column
   * existed — so every row written before it renders exactly as it did.
   * Validated with the page CMS's link rule: a site path or an https address.
   */
  ctaHref: varchar("cta_href", { length: 255 }).notNull().default(""),
  sortOrder: integer("sort_order").notNull().default(0),
  isPublished: boolean("is_published").notNull().default(true),
  ...timestamps,
});

export const serviceSubcategories = pgTable(
  "service_subcategories",
  {
    id: serial("id").primaryKey(),
    categoryId: integer("category_id")
      .notNull()
      .references(() => serviceCategories.id, { onDelete: "cascade" }),
    slug: varchar("slug", { length: 120 }).notNull(),
    titleEn: varchar("title_en", { length: 190 }).notNull(),
    titleAr: varchar("title_ar", { length: 190 }).notNull().default(""),
    summaryEn: text("summary_en").notNull().default(""),
    summaryAr: text("summary_ar").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    isPublished: boolean("is_published").notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex("service_subcategories_slug_idx").on(t.categoryId, t.slug)],
);

export const services = pgTable(
  "services",
  {
    id: serial("id").primaryKey(),
    categoryId: integer("category_id")
      .notNull()
      .references(() => serviceCategories.id, { onDelete: "cascade" }),
    subcategoryId: integer("subcategory_id").references(() => serviceSubcategories.id, {
      onDelete: "set null",
    }),
    slug: varchar("slug", { length: 120 }).notNull(),
    titleEn: varchar("title_en", { length: 190 }).notNull(),
    titleAr: varchar("title_ar", { length: 190 }).notNull().default(""),
    introEn: text("intro_en").notNull().default(""),
    introAr: text("intro_ar").notNull().default(""),
    /** Sanitised rich text (p / h3 / h4 / lists / emphasis / safe links). */
    bodyEn: text("body_en").notNull().default(""),
    bodyAr: text("body_ar").notNull().default(""),
    /** Editor-ordered lists: [{ en, ar }] — see lib/validation/service.ts. */
    benefits: jsonb("benefits").$type<LocalisedItem[]>().notNull().default(sql`'[]'::jsonb`),
    audience: jsonb("audience").$type<LocalisedItem[]>().notNull().default(sql`'[]'::jsonb`),
    requirements: jsonb("requirements").$type<LocalisedItem[]>().notNull().default(sql`'[]'::jsonb`),
    processSteps: jsonb("process_steps").$type<LocalisedStep[]>().notNull().default(sql`'[]'::jsonb`),
    /** Free text, not a promise: "typically 5–10 working days", or empty. */
    timelineEn: varchar("timeline_en", { length: 190 }).notNull().default(""),
    timelineAr: varchar("timeline_ar", { length: 190 }).notNull().default(""),
    notesEn: text("notes_en").notNull().default(""),
    notesAr: text("notes_ar").notNull().default(""),
    /** Which extra fields the request form shows: travel | visa | business | iqama | general. */
    formPreset: varchar("form_preset", { length: 32 }).notNull().default("general"),
    imageId: integer("image_id").references(() => media.id, { onDelete: "set null" }),
    isFeatured: boolean("is_featured").notNull().default(false),
    isPublished: boolean("is_published").notNull().default(true),
    sortOrder: integer("sort_order").notNull().default(0),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("services_slug_idx").on(t.categoryId, t.slug),
    index("services_category_idx").on(t.categoryId, t.sortOrder),
  ],
);

export type LocalisedItem = { en: string; ar: string };
export type LocalisedStep = { en: string; ar: string; detailEn: string; detailAr: string };

/* -------------------------------------------------------------------------- */
/* Tour packages and their destinations                                        */
/* -------------------------------------------------------------------------- */

/**
 * A destination is a place packages are grouped under — Egypt today, Nepal or
 * Turkey whenever somebody types them in. It exists so that adding a country is
 * data entry rather than a schema change: the older `region` enum could only
 * grow by migration, which is exactly the wrong shape for a growing catalogue.
 *
 * Deliberately the same columns as `serviceCategories`, so the admin list, the
 * public grouping and the sitemap all follow code paths that already exist.
 */
export const packageDestinations = pgTable("package_destinations", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 120 }).notNull().unique(),
  titleEn: varchar("title_en", { length: 190 }).notNull(),
  titleAr: varchar("title_ar", { length: 190 }).notNull().default(""),
  summaryEn: text("summary_en").notNull().default(""),
  summaryAr: text("summary_ar").notNull().default(""),
  imageId: integer("image_id").references(() => media.id, { onDelete: "set null" }),
  sortOrder: integer("sort_order").notNull().default(0),
  isPublished: boolean("is_published").notNull().default(true),
  ...timestamps,
});

export const travelPackages = pgTable("travel_packages", {
  id: serial("id").primaryKey(),
  slug: varchar("slug", { length: 120 }).notNull().unique(),
  /**
   * LEGACY. Kept for backward compatibility and no longer the grouping
   * mechanism — `destinationId` is. Nothing rewrites the values it already
   * holds, and no new record can be given `egypt`; see the admin package form.
   */
  region: packageRegionEnum("region").notNull().default("international"),
  /**
   * Nullable on purpose. It is what lets a release that adds this column run
   * against a runtime that knows nothing about it, and it lets a package exist
   * without belonging anywhere — `custom-itinerary` is "Anywhere", which is not
   * a destination. SET NULL rather than CASCADE: deleting a destination must
   * never delete the packages inside it.
   */
  destinationId: integer("destination_id").references(() => packageDestinations.id, {
    onDelete: "set null",
  }),
  titleEn: varchar("title_en", { length: 190 }).notNull(),
  titleAr: varchar("title_ar", { length: 190 }).notNull().default(""),
  destinationEn: varchar("destination_en", { length: 120 }).notNull().default(""),
  destinationAr: varchar("destination_ar", { length: 120 }).notNull().default(""),
  /** Deliberately free text — "5 nights", "flexible" — never a computed price. */
  durationEn: varchar("duration_en", { length: 80 }).notNull().default(""),
  durationAr: varchar("duration_ar", { length: 80 }).notNull().default(""),
  summaryEn: text("summary_en").notNull().default(""),
  summaryAr: text("summary_ar").notNull().default(""),
  bodyEn: text("body_en").notNull().default(""),
  bodyAr: text("body_ar").notNull().default(""),
  highlights: jsonb("highlights").$type<LocalisedItem[]>().notNull().default(sql`'[]'::jsonb`),
  imageId: integer("image_id").references(() => media.id, { onDelete: "set null" }),
  isFeatured: boolean("is_featured").notNull().default(false),
  isPublished: boolean("is_published").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  ...timestamps,
}, (t) => [index("travel_packages_destination_idx").on(t.destinationId, t.sortOrder)]);

/* -------------------------------------------------------------------------- */
/* Videos, testimonials, FAQs                                                  */
/* -------------------------------------------------------------------------- */

export const videos = pgTable("videos", {
  id: serial("id").primaryKey(),
  /** Validated 11-character YouTube id; the pasted URL is kept for reference. */
  youtubeId: varchar("youtube_id", { length: 16 }).notNull(),
  sourceUrl: varchar("source_url", { length: 255 }).notNull().default(""),
  titleEn: varchar("title_en", { length: 190 }).notNull(),
  titleAr: varchar("title_ar", { length: 190 }).notNull().default(""),
  descriptionEn: text("description_en").notNull().default(""),
  descriptionAr: text("description_ar").notNull().default(""),
  category: varchar("category", { length: 64 }).notNull().default("general"),
  /** Uploaded still. When absent the page falls back to YouTube's own poster. */
  thumbnailId: integer("thumbnail_id").references(() => media.id, { onDelete: "set null" }),
  durationLabel: varchar("duration_label", { length: 16 }).notNull().default(""),
  isFeatured: boolean("is_featured").notNull().default(false),
  isPublished: boolean("is_published").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  ...timestamps,
});

export const testimonials = pgTable("testimonials", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 120 }).notNull(),
  company: varchar("company", { length: 120 }).notNull().default(""),
  country: varchar("country", { length: 80 }).notNull().default(""),
  quoteEn: text("quote_en").notNull().default(""),
  quoteAr: text("quote_ar").notNull().default(""),
  imageId: integer("image_id").references(() => media.id, { onDelete: "set null" }),
  /** 1–5, or null when the client did not give one. */
  rating: integer("rating"),
  isFeatured: boolean("is_featured").notNull().default(false),
  isPublished: boolean("is_published").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  ...timestamps,
});

export const faqs = pgTable(
  "faqs",
  {
    id: serial("id").primaryKey(),
    scope: faqScopeEnum("scope").notNull().default("global"),
    categoryId: integer("category_id").references(() => serviceCategories.id, {
      onDelete: "cascade",
    }),
    serviceId: integer("service_id").references(() => services.id, { onDelete: "cascade" }),
    questionEn: varchar("question_en", { length: 255 }).notNull(),
    questionAr: varchar("question_ar", { length: 255 }).notNull().default(""),
    answerEn: text("answer_en").notNull().default(""),
    answerAr: text("answer_ar").notNull().default(""),
    sortOrder: integer("sort_order").notNull().default(0),
    isPublished: boolean("is_published").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("faqs_scope_idx").on(t.scope, t.categoryId, t.serviceId)],
);

/* -------------------------------------------------------------------------- */
/* Dynamic routes in the Visual Editor (Batch 21)                              */
/* -------------------------------------------------------------------------- */

/**
 * One editable region of a dynamic route — a category's hero, one service
 * card, one FAQ — and only when it has something to hold.
 *
 * Two kinds of thing live here, and the split is the point:
 *
 *   · **Published presentation** — `styles`, `motion` and `copy` (the
 *     template wording a category page used to hard-code). Nothing held these
 *     before Batch 21, so this is their one home rather than a copy of
 *     anything.
 *   · **Unpublished changes** — `draft_content`, `draft_styles` and
 *     `draft_motion`. `draft_content` is a patch of the fields an editor
 *     changed, each with the published value it started from (`base`); the
 *     published values of category, group, service and FAQ content stay in
 *     their own tables and are never mirrored here.
 *
 * `owner_key` (`service:12`) names the region by resource identity, so a
 * style or a draft follows the service, not a DOM position. `revision` guards
 * every draft write, as `page_sections.revision` does for sections. See
 * `docs/visual-editor/dynamic-routes.md`.
 */
export const routeNodes = pgTable(
  "route_nodes",
  {
    ownerKey: varchar("owner_key", { length: 64 }).primaryKey(),
    /** The route the region was last edited on, e.g. `category:3`. */
    routeKey: varchar("route_key", { length: 64 }).notNull(),
    styles: jsonb("styles").$type<Record<string, unknown>>(),
    motion: jsonb("motion").$type<Record<string, unknown>>(),
    copy: jsonb("copy").$type<Record<string, string>>(),
    draftContent: jsonb("draft_content").$type<Record<string, { value: unknown; base: unknown }>>(),
    draftStyles: jsonb("draft_styles").$type<Record<string, unknown>>(),
    draftMotion: jsonb("draft_motion").$type<Record<string, unknown>>(),
    revision: integer("revision").notNull().default(1),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
    ...timestamps,
  },
  (t) => [index("route_nodes_route_idx").on(t.routeKey)],
);

/**
 * One publication of a dynamic route: what it looked like afterwards
 * (`snapshot`), what changed (`changes`, field by field, before and after),
 * who and when. `kind` is `baseline` for the state recorded before a route's
 * first publication, so the earliest state can be compared and restored too.
 */
export const routeVersions = pgTable(
  "route_versions",
  {
    id: serial("id").primaryKey(),
    routeKey: varchar("route_key", { length: 64 }).notNull(),
    kind: varchar("kind", { length: 16 }).notNull().default("publish"),
    summary: varchar("summary", { length: 255 }).notNull().default(""),
    snapshot: jsonb("snapshot").$type<Record<string, unknown>>().notNull(),
    changes: jsonb("changes").$type<unknown[]>().notNull().default(sql`'[]'::jsonb`),
    createdBy: integer("created_by").references(() => users.id, { onDelete: "set null" }),
    /** Captured at write time so the row survives a deleted user. */
    actorName: varchar("actor_name", { length: 120 }).notNull().default("System"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("route_versions_route_idx").on(t.routeKey, t.createdAt)],
);

/* -------------------------------------------------------------------------- */
/* Enquiries                                                                   */
/* -------------------------------------------------------------------------- */

export const enquiries = pgTable(
  "enquiries",
  {
    id: serial("id").primaryKey(),
    /** Human reference shown to the customer, e.g. EOD-26-0148. */
    reference: varchar("reference", { length: 24 }).notNull().unique(),
    name: varchar("name", { length: 120 }).notNull(),
    email: varchar("email", { length: 190 }).notNull().default(""),
    phone: varchar("phone", { length: 40 }).notNull().default(""),
    whatsapp: varchar("whatsapp", { length: 40 }).notNull().default(""),
    nationality: varchar("nationality", { length: 80 }).notNull().default(""),
    categoryId: integer("category_id").references(() => serviceCategories.id, {
      onDelete: "set null",
    }),
    serviceId: integer("service_id").references(() => services.id, { onDelete: "set null" }),
    /** Names captured at submit time so the record survives a renamed service. */
    categoryLabel: varchar("category_label", { length: 190 }).notNull().default(""),
    serviceLabel: varchar("service_label", { length: 190 }).notNull().default(""),
    message: text("message").notNull().default(""),
    /** Preset-specific answers (travel dates, business activity, …). */
    details: jsonb("details").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    preferredContact: contactMethodEnum("preferred_contact").notNull().default("whatsapp"),
    sourcePage: varchar("source_page", { length: 255 }).notNull().default(""),
    locale: varchar("locale", { length: 5 }).notNull().default("en"),
    utm: jsonb("utm").$type<Record<string, string>>().notNull().default(sql`'{}'::jsonb`),
    status: enquiryStatusEnum("status").notNull().default("new"),
    assignedTo: integer("assigned_to").references(() => users.id, { onDelete: "set null" }),
    isRead: boolean("is_read").notNull().default(false),
    ...timestamps,
  },
  (t) => [
    index("enquiries_status_idx").on(t.status, t.createdAt),
    index("enquiries_created_idx").on(t.createdAt),
  ],
);

export const enquiryNotes = pgTable(
  "enquiry_notes",
  {
    id: serial("id").primaryKey(),
    enquiryId: integer("enquiry_id")
      .notNull()
      .references(() => enquiries.id, { onDelete: "cascade" }),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    authorName: varchar("author_name", { length: 120 }).notNull().default(""),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("enquiry_notes_enquiry_idx").on(t.enquiryId)],
);

/* -------------------------------------------------------------------------- */
/* Navigation, settings, SEO, social                                           */
/* -------------------------------------------------------------------------- */

export const navigationItems = pgTable(
  "navigation_items",
  {
    id: serial("id").primaryKey(),
    menu: navMenuEnum("menu").notNull().default("header"),
    parentId: integer("parent_id"),
    labelEn: varchar("label_en", { length: 120 }).notNull(),
    labelAr: varchar("label_ar", { length: 120 }).notNull().default(""),
    /** Always a site-relative path without a language prefix, e.g. /services. */
    href: varchar("href", { length: 255 }).notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
    isPublished: boolean("is_published").notNull().default(true),
    isHighlighted: boolean("is_highlighted").notNull().default(false),
    ...timestamps,
  },
  (t) => [index("navigation_menu_idx").on(t.menu, t.sortOrder)],
);

export const siteSettings = pgTable("site_settings", {
  key: varchar("key", { length: 64 }).primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  updatedBy: integer("updated_by").references(() => users.id, { onDelete: "set null" }),
});

export const seoMetadata = pgTable(
  "seo_metadata",
  {
    id: serial("id").primaryKey(),
    /** page | category | service | package | video */
    entityType: varchar("entity_type", { length: 32 }).notNull(),
    /** Slug or numeric id, as text, so one table covers every entity. */
    entityKey: varchar("entity_key", { length: 190 }).notNull(),
    titleEn: varchar("title_en", { length: 190 }).notNull().default(""),
    titleAr: varchar("title_ar", { length: 190 }).notNull().default(""),
    descriptionEn: varchar("description_en", { length: 320 }).notNull().default(""),
    descriptionAr: varchar("description_ar", { length: 320 }).notNull().default(""),
    canonicalUrl: varchar("canonical_url", { length: 255 }).notNull().default(""),
    ogTitle: varchar("og_title", { length: 190 }).notNull().default(""),
    ogDescription: varchar("og_description", { length: 320 }).notNull().default(""),
    ogImageId: integer("og_image_id").references(() => media.id, { onDelete: "set null" }),
    noindex: boolean("noindex").notNull().default(false),
    ...timestamps,
  },
  (t) => [uniqueIndex("seo_entity_idx").on(t.entityType, t.entityKey)],
);

export const socialLinks = pgTable("social_links", {
  id: serial("id").primaryKey(),
  platform: varchar("platform", { length: 32 }).notNull(),
  url: varchar("url", { length: 255 }).notNull(),
  sortOrder: integer("sort_order").notNull().default(0),
  isPublished: boolean("is_published").notNull().default(true),
  ...timestamps,
});

/* -------------------------------------------------------------------------- */
/* Relations                                                                   */
/* -------------------------------------------------------------------------- */

export const rolesRelations = relations(roles, ({ many }) => ({
  users: many(users),
  rolePermissions: many(rolePermissions),
}));

export const usersRelations = relations(users, ({ one }) => ({
  role: one(roles, { fields: [users.roleId], references: [roles.id] }),
}));

export const rolePermissionsRelations = relations(rolePermissions, ({ one }) => ({
  role: one(roles, { fields: [rolePermissions.roleId], references: [roles.id] }),
  permission: one(permissions, {
    fields: [rolePermissions.permissionId],
    references: [permissions.id],
  }),
}));

export const serviceCategoriesRelations = relations(serviceCategories, ({ many, one }) => ({
  services: many(services),
  subcategories: many(serviceSubcategories),
  image: one(media, { fields: [serviceCategories.imageId], references: [media.id] }),
}));

export const serviceSubcategoriesRelations = relations(serviceSubcategories, ({ one, many }) => ({
  category: one(serviceCategories, {
    fields: [serviceSubcategories.categoryId],
    references: [serviceCategories.id],
  }),
  services: many(services),
}));

export const servicesRelations = relations(services, ({ one, many }) => ({
  category: one(serviceCategories, {
    fields: [services.categoryId],
    references: [serviceCategories.id],
  }),
  subcategory: one(serviceSubcategories, {
    fields: [services.subcategoryId],
    references: [serviceSubcategories.id],
  }),
  image: one(media, { fields: [services.imageId], references: [media.id] }),
  faqs: many(faqs),
}));

export const pagesRelations = relations(pages, ({ many }) => ({
  sections: many(pageSections),
}));

export const pageSectionsRelations = relations(pageSections, ({ one }) => ({
  page: one(pages, { fields: [pageSections.pageId], references: [pages.id] }),
}));

export const enquiriesRelations = relations(enquiries, ({ one, many }) => ({
  category: one(serviceCategories, {
    fields: [enquiries.categoryId],
    references: [serviceCategories.id],
  }),
  service: one(services, { fields: [enquiries.serviceId], references: [services.id] }),
  assignee: one(users, { fields: [enquiries.assignedTo], references: [users.id] }),
  notes: many(enquiryNotes),
}));

export const enquiryNotesRelations = relations(enquiryNotes, ({ one }) => ({
  enquiry: one(enquiries, { fields: [enquiryNotes.enquiryId], references: [enquiries.id] }),
  user: one(users, { fields: [enquiryNotes.userId], references: [users.id] }),
}));

export const videosRelations = relations(videos, ({ one }) => ({
  thumbnail: one(media, { fields: [videos.thumbnailId], references: [media.id] }),
}));

export const testimonialsRelations = relations(testimonials, ({ one }) => ({
  image: one(media, { fields: [testimonials.imageId], references: [media.id] }),
}));

export const travelPackagesRelations = relations(travelPackages, ({ one }) => ({
  image: one(media, { fields: [travelPackages.imageId], references: [media.id] }),
}));

export const faqsRelations = relations(faqs, ({ one }) => ({
  category: one(serviceCategories, {
    fields: [faqs.categoryId],
    references: [serviceCategories.id],
  }),
  service: one(services, { fields: [faqs.serviceId], references: [services.id] }),
}));
