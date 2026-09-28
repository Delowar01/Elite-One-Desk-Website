/**
 * Usage, in the shapes and words the screens use (Batch 17). Pure, so the
 * warning before a publication reads the same sentence in the browser as the
 * server would write.
 */

export type UsageInstance = {
  pageId: number;
  slug: string;
  title: string;
  pagePublished: boolean;
  sectionId: number;
  blockType: string;
  blockName: string;
  slot: string;
  slotLabel: string;
  live: boolean;
  draft: boolean;
  hidden: boolean;
  /** How many keys this page overrides, in the state the pending page shows. */
  overrides: number;
};

export type UsageSummary = {
  pages: number;
  instances: number;
  livePages: number;
  liveInstances: number;
  draftPages: number;
  draftInstances: number;
  /** Pages whose pending draft uses it and whose live page does not. */
  draftOnlyPages: number;
  hidden: number;
  /** Any section, in any state, refers to it. */
  referenced: boolean;
};

export const EMPTY_USAGE: UsageSummary = {
  pages: 0,
  instances: 0,
  livePages: 0,
  liveInstances: 0,
  draftPages: 0,
  draftInstances: 0,
  draftOnlyPages: 0,
  hidden: 0,
  referenced: false,
};

export function summarise(instances: readonly UsageInstance[], referenced: boolean): UsageSummary {
  const counted = instances.filter((entry) => entry.live || entry.draft);
  const livePages = new Set(instances.filter((entry) => entry.live).map((entry) => entry.pageId));
  const draftPages = new Set(instances.filter((entry) => entry.draft).map((entry) => entry.pageId));
  return {
    pages: new Set(counted.map((entry) => entry.pageId)).size,
    instances: counted.length,
    livePages: livePages.size,
    liveInstances: instances.filter((entry) => entry.live).length,
    draftPages: draftPages.size,
    draftInstances: instances.filter((entry) => entry.draft).length,
    draftOnlyPages: [...draftPages].filter((id) => !livePages.has(id)).length,
    hidden: instances.filter((entry) => entry.hidden && !entry.live).length,
    referenced,
  };
}

/**
 * The sentence the dependency warning is built from — visitor impact first.
 * "This will update 5 linked instances across 3 published pages and 1 page draft."
 */
export function impactSentence(summary: UsageSummary): string {
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  if (!summary.liveInstances && !summary.draftOnlyPages) {
    return "No published page shows this component yet, so publishing it changes nothing visitors see today.";
  }
  const live = summary.liveInstances
    ? `update ${plural(summary.liveInstances, "linked instance")} across ${plural(summary.livePages, "published page")}`
    : "update no published page";
  const drafts = summary.draftOnlyPages ? ` and ${plural(summary.draftOnlyPages, "page draft")}` : "";
  return `This will ${live}${drafts}.`;
}

/** "Used on 3 pages · 5 instances", or "Used on 3 pages" when the two agree, or "Not used yet". */
export function usageHeadline(summary: Pick<UsageSummary, "pages" | "instances">): string {
  if (!summary.instances) return "Not used on any page yet";
  const pages = `Used on ${summary.pages} ${summary.pages === 1 ? "page" : "pages"}`;
  return summary.instances === summary.pages
    ? pages
    : `${pages} · ${summary.instances} ${summary.instances === 1 ? "instance" : "instances"}`;
}

/** What a publication did, in the same terms: "It is live on 5 linked instances across 3 published pages." */
export function publishedSentence(summary: UsageSummary): string {
  if (!summary.liveInstances) return "No published page shows it yet.";
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  return `It is live on ${plural(summary.liveInstances, "linked instance")} across ${plural(summary.livePages, "published page")}.`;
}
