import { AUTHORITY, COMPOUND, DENIED } from "@/lib/auth/authority";
import { satisfies, type PermissionRequirement } from "@/lib/auth/permissions";

/**
 * Who may do what with reusable components — in one place (Batch 17, made
 * granular in Batch 18).
 *
 * Batch 17 rode the page permissions for all of it — `content.view` to read,
 * `content.manage` for every change — and said this was temporary: the batch
 * that introduced finer permissions would change this map and leave every
 * entry point alone, since each already asked for its operation by name. This
 * is that change. Every operation is now answered from the central table in
 * `lib/auth/authority.ts`, which is where page capabilities are answered too.
 *
 * A component is still page content that happens to be shared, never a site
 * setting: nothing here mentions `settings.manage` or `navigation.manage`, so
 * a person allowed to edit a reusable call to action is not thereby allowed
 * to change the site's WhatsApp number or its menus.
 *
 *   view        the list, one component whole, its usage, its history, its preview
 *   instances   a page's own use of one — link, unlink, override on or off,
 *               detach. Page content, plus seeing the definition it names; the
 *               text typed into an override is ordinary page content.
 *   edit        create, rename, save or discard the draft
 *   publish     publish — what every linked page shows from that moment
 *   restore     an earlier version back as the draft: an edit of the draft,
 *               reviewed and published like any other
 *   lifecycle   archive, unarchive, delete
 */
export const REUSE_AUTHORITY = {
  view: AUTHORITY.viewComponents,
  instances: COMPOUND.reuseInstance,
  edit: AUTHORITY.editComponents,
  publish: AUTHORITY.publishComponents,
  restore: AUTHORITY.editComponents,
  lifecycle: AUTHORITY.componentLifecycle,
} as const satisfies Record<string, PermissionRequirement>;

export type ReuseOperation = keyof typeof REUSE_AUTHORITY;

/** What each refusal says. */
export const REUSE_DENIED: Record<ReuseOperation, string> = {
  view: DENIED.viewComponents,
  instances: DENIED.reuseInstance,
  edit: DENIED.editComponents,
  publish: DENIED.publishComponents,
  restore: DENIED.editComponents,
  lifecycle: DENIED.componentLifecycle,
};

/** Whether a set of granted permissions allows one operation. */
export const reuseAllowed = (granted: ReadonlySet<string> | null | undefined, operation: ReuseOperation): boolean =>
  Boolean(granted && satisfies(granted, REUSE_AUTHORITY[operation]));
