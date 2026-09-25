import "server-only";

import { isNotNull, or, type SQL } from "drizzle-orm";

import { pageSections } from "@/lib/db/schema";

/**
 * `draftDomainsOf(row).length > 0`, as SQL — for the screens that count
 * sections in the database rather than reading each row.
 *
 * Four columns, three domains: content, styles, and motion, which since Batch
 * 15 has two columns of its own. A count that tested `draft` alone would leave
 * a page whose only pending change is a layout override, an entrance or an
 * element's motion looking as though it had nothing waiting — the Publish
 * button would be armed on a page the list calls clean.
 */
export const sectionHasDraft: SQL = or(
  isNotNull(pageSections.draft),
  isNotNull(pageSections.draftStyles),
  isNotNull(pageSections.draftAnimation),
  isNotNull(pageSections.draftMotionConfig),
)!;
