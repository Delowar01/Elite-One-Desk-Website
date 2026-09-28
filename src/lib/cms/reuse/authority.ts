import type { PermissionKey } from "@/lib/auth/permissions";

/**
 * Who may do what with reusable components — in one place (Batch 17).
 *
 * **Temporary, and deliberately so.** The final granular permission model is
 * not this batch's to build, so reusable components ride the permissions that
 * already govern page content: seeing them is `content.view`, and every
 * change — linking an instance, overriding it, detaching it, creating,
 * editing, publishing, restoring, archiving or deleting a component — is
 * `content.manage`. Never `settings.manage`: a reusable component is page
 * content that happens to be shared, not a site setting, whatever the word
 * "global" suggests.
 *
 * Every entry point asks this map rather than naming a key itself, so the
 * batch that introduces finer permissions changes this file and nothing else:
 * each operation already has its own name here.
 */
export const REUSE_AUTHORITY = {
  /** Reading components, their usage, their history and their previews. */
  view: "content.view",
  /** Linking, overriding, resetting and detaching an instance on a page. */
  instances: "content.manage",
  /** Creating a component, renaming it and saving or discarding its draft. */
  edit: "content.manage",
  /** Publishing a component — the change every linked page receives. */
  publish: "content.manage",
  /** Restoring a historical version to the draft. */
  restore: "content.manage",
  /** Archiving, unarchiving and deleting. */
  lifecycle: "content.manage",
} as const satisfies Record<string, PermissionKey>;

export type ReuseOperation = keyof typeof REUSE_AUTHORITY;

/** Whether a set of granted permissions allows one operation. */
export const reuseAllowed = (granted: ReadonlySet<string> | null | undefined, operation: ReuseOperation): boolean =>
  Boolean(granted?.has(REUSE_AUTHORITY[operation]));
