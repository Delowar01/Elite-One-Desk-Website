import type { UsageInstance, UsageSummary } from "./usage-view";

/**
 * What the screens are told about reusable components (Batch 17) — plain,
 * serialisable shapes, dates as ISO strings. Admin-only by construction: every
 * loader that returns one checks `REUSE_AUTHORITY.view` first, and none of
 * this ever reaches a public page.
 */

type Values = Record<string, unknown>;

/** One component in a picker or a list. Published values ride along: linking copies them as the fallback. */
export type ReuseCatalogEntry = {
  id: number;
  kind: string;
  name: string;
  status: "active" | "archived";
  revision: number;
  publishedVersion: number;
  published: Values | null;
  hasDraft: boolean;
  updatedAt: string;
  usage: UsageSummary;
};

export type ReuseVersionEntry = {
  id: number;
  version: number;
  label: string;
  actorName: string;
  createdAt: string;
};

/** One component, whole — its editor, its usage and its history. */
export type ReuseComponentView = ReuseCatalogEntry & {
  draft: Values | null;
  publishedAt: string | null;
  instances: UsageInstance[];
  versions: ReuseVersionEntry[];
  /** The version numbers retained — the last N publications are kept. */
  keepVersions: number;
};

export type ReuseActionFailure =
  | "denied"
  | "missing"
  | "conflict"
  | "invalid"
  | "nothing"
  | "archived"
  | "in_use";

export type ReuseActionResult =
  | { ok: true; message: string; component: ReuseComponentView | null }
  | {
      ok: false;
      reason: ReuseActionFailure;
      message: string;
      /** After a lost race: the version that won, so the screen can offer it rather than merge. */
      latest?: ReuseComponentView | null;
    };
