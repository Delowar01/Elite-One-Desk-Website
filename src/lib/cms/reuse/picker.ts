import type { ReuseCatalogEntry } from "./view";

/**
 * What the picker offers (Batch 17): components of the kinds a slot takes,
 * archived ones left out, filtered by name. A component that has never been
 * published is listed — so an editor can see it exists — but marked not
 * linkable, because a page must never be linked to content no visitor could
 * be shown.
 */
export function pickerEntries(
  catalog: readonly ReuseCatalogEntry[] | null,
  kinds: readonly string[],
  query = "",
  kind = "all",
): { entry: ReuseCatalogEntry; linkable: boolean }[] {
  const needle = query.trim().toLowerCase();
  return (catalog ?? [])
    .filter(
      (entry) =>
        entry.status === "active" &&
        kinds.includes(entry.kind) &&
        (kind === "all" || entry.kind === kind) &&
        (!needle || entry.name.toLowerCase().includes(needle)),
    )
    .map((entry) => ({ entry, linkable: entry.published !== null && entry.publishedVersion > 0 }));
}
