/**
 * What the Visual Editor's route panel is sent (Batch 21).
 *
 * Plain data, client-safe, computed on the server from the database. The panel
 * never counts its own buffers to say what is waiting: the only honest source
 * for "what would Publish do to this page" is what is stored.
 */

/** How many publications a route keeps. The oldest goes first; the baseline is kept with them. */
export const KEEP_ROUTE_VERSIONS = 30;

/** One region with something pending. */
export type RouteOwnerSummary = {
  ownerKey: string;
  label: string;
  /** The fields its content draft changes, in words. */
  fields: string[];
  style: boolean;
  motion: boolean;
  /** Fields changed outside the Visual Editor since the draft began. */
  conflicts: string[];
};

export type RouteSummaryView = {
  routeKey: string;
  title: string;
  /** The public path, without a locale prefix: `/services/<slug>`. */
  path: string;
  isPublished: boolean;
  /**
   * The drafts this summary describes, as `owner@revision` pairs. Publish and
   * Discard send it back, and are refused if the drafts moved since — so what
   * is published is exactly what was reviewed.
   */
  token: string;
  owners: RouteOwnerSummary[];
  contentChanges: number;
  styleDrafts: number;
  motionDrafts: number;
  conflicts: number;
  publishable: boolean;
  discardable: boolean;
};

export type RouteVersionView = {
  id: number;
  kind: "publish" | "baseline";
  summary: string;
  actorName: string;
  /** ISO 8601. */
  createdAt: string;
  changeCount: number;
  /** The regions it changed, in words. */
  resources: string[];
};

export type RouteHistoryView = {
  routeKey: string;
  versions: RouteVersionView[];
  keep: number;
};

/** One field that differs between two states of a route, ready to read. */
export type RouteChangeView = {
  owner: string;
  field: string;
  before: string;
  after: string;
};

export type RouteCompareView = {
  versionId: number;
  /** What the version is compared with. */
  against: "previous" | "live";
  title: string;
  changes: RouteChangeView[];
};

export type RouteActionResult =
  | { ok: true; message: string }
  | {
      ok: false;
      reason: "conflict" | "stale" | "denied" | "invalid" | "missing" | "blocked";
      message: string;
      /** For a conflict: the fields that block it, in words. */
      details?: string[];
    };
