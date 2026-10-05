"use client";

import { Icon } from "@/components/ui/icon";
import { parseNodePath } from "@/lib/cms/address";
import type { BlockDef } from "@/lib/cms/blocks";
import type { RouteOwnerInfo } from "@/lib/visual-editor/content";
import type { EditorNodeMeta } from "@/lib/visual-editor/protocol";

/** What the Inspector needs from the shell to act on a dynamic route's region (Batch 21). */
export type RouteControls = {
  /**
   * Whether this session may change the region's record: the capability its
   * domain names — `services.manage`, `faqs.manage` for a question,
   * `packages.manage` for a package, a destination or the catalogue (Batch 24).
   */
  mayRecord: (info: RouteOwnerInfo) => boolean;
  /** `content.structure`: order and visibility. */
  canStructure: boolean;
  busy: boolean;
  /** Settle one field changed outside the Visual Editor: keep the draft, or take the live value. */
  onResolve: (field: string, choice: "mine" | "live") => void;
};

const KIND_WORD: Record<RouteOwnerInfo["resource"]["kind"], string> = {
  category: "Service category",
  subcategory: "Service group",
  service: "Service",
  faq: "FAQ",
  package: "Package",
  destination: "Destination",
  template: "This page's wording",
};

/** What a role without the region's capability may not change, in words. */
const DOMAIN_WORDS: Record<RouteOwnerInfo["domain"], string> = {
  "services.manage": "services and categories",
  "faqs.manage": "FAQs",
  "packages.manage": "packages and destinations",
};

/**
 * Where a region's content lives, and what is in the way of publishing it.
 *
 * Three things a page section never needed to say, because its content lived
 * in the section:
 *
 *   · **Which record this is** — the service, the group, the question — with
 *     the screen that also manages it, because the Visual Editor is one more
 *     way into the same data, not a copy of it.
 *   · **Where generated content comes from** — a card's link, a destination
 *     list, the breadcrumbs. Selecting one is never a dead click: it says
 *     where the content is controlled and links there.
 *   · **What changed elsewhere** — a field somebody saved in an admin form
 *     after this draft began. Publishing is refused until each is settled,
 *     and the choice is the editor's: keep the draft, which will replace the
 *     form's value when published, or take the live value and drop the draft
 *     for that field. Nothing is ever overwritten silently, in either
 *     direction.
 */
export function RouteSource({
  info,
  node,
  block,
  controls,
}: {
  info: RouteOwnerInfo;
  node: EditorNodeMeta;
  block: BlockDef | null;
  controls: RouteControls;
}) {
  const path = parseNodePath(node.relativePath);
  const field = path?.[0]?.kind === "field" ? block?.fields.find((entry) => entry.name === path[0]!.name) : undefined;
  const generated = field?.generated;
  const mayRecord = controls.mayRecord(info);

  return (
    <div className="flex flex-col gap-2" data-route-source={info.ownerKey}>
      <div className="admin-card p-2.5">
        <p className="text-[0.66rem] font-semibold uppercase tracking-[0.07em] text-muted">
          {KIND_WORD[info.resource.kind]}
          {info.resource.kind === "template" ? null : ` #${info.resource.id}`}
        </p>
        <p className="mt-0.5 text-[0.78rem] text-strong">{info.label}</p>
        {info.resource.kind === "template" ? (
          <p className="mt-1 text-[0.7rem] leading-relaxed text-muted">
            This wording belongs to this page. Left empty, each language shows the site’s standard wording.
          </p>
        ) : null}
        {info.adminHref ? (
          <a href={info.adminHref} target="_blank" rel="noopener" className="admin-btn admin-btn-sm mt-1.5">
            <Icon name="arrowUpRight" size={11} />
            Open its admin screen
          </a>
        ) : null}
        {!info.visible ? (
          <p className="mt-1.5 text-[0.7rem]" style={{ color: "var(--color-peach)" }} data-route-hidden>
            Hidden — publishing keeps this off the live page.
          </p>
        ) : null}
        {!mayRecord && info.resource.kind !== "template" ? (
          <p className="mt-1.5 text-[0.7rem] leading-relaxed text-muted" role="note" data-permission-note={info.domain}>
            Your role does not allow changing {DOMAIN_WORDS[info.domain]}. You can still view it here.
          </p>
        ) : null}
      </div>

      {generated ? (
        <div className="admin-card p-2.5" role="note" data-route-generated={node.address}>
          <p className="text-[0.74rem] font-semibold text-strong">Generated — not typed here</p>
          <p className="mt-1 text-[0.72rem] leading-relaxed text-muted">{generated.explain}</p>
          {generated.source ? (
            <a href={generated.source.href} target="_blank" rel="noopener" className="admin-btn admin-btn-sm mt-1.5">
              <Icon name="arrowUpRight" size={11} />
              {generated.source.label}
            </a>
          ) : null}
          <p className="mt-1.5 text-[0.7rem] text-muted">Its style can still be changed on the Style tab where offered.</p>
        </div>
      ) : null}

      {info.conflicts.length ? (
        <div
          className="admin-card p-2.5"
          role="alert"
          style={{ borderColor: "color-mix(in oklab, #ef8f8a 50%, var(--admin-line))" }}
          data-route-conflicts={info.ownerKey}
        >
          <p className="text-[0.76rem] font-semibold text-strong">Changed outside the Visual Editor</p>
          <p className="mt-1 text-[0.72rem] leading-relaxed text-muted">
            These fields were saved on another screen after this draft began. Publishing is blocked until each is
            settled.
          </p>
          <ul className="mt-2 flex flex-col gap-2">
            {info.conflicts.map((conflict) => (
              <li key={conflict.key} data-route-conflict-field={conflict.key}>
                <p className="text-[0.74rem] font-medium text-body">{conflict.label}</p>
                <p className="text-[0.7rem] text-muted">Live now: {conflict.live}</p>
                <p className="text-[0.7rem] text-muted">Your draft: {conflict.draft}</p>
                <div className="mt-1 flex flex-wrap gap-1">
                  <button
                    type="button"
                    className="admin-btn admin-btn-sm"
                    disabled={controls.busy || !mayRecord}
                    onClick={() => controls.onResolve(conflict.key, "mine")}
                    data-route-keep={conflict.key}
                  >
                    Keep my draft
                  </button>
                  <button
                    type="button"
                    className="admin-btn admin-btn-sm"
                    disabled={controls.busy || !mayRecord}
                    onClick={() => controls.onResolve(conflict.key, "live")}
                    data-route-take-live={conflict.key}
                  >
                    Use the live value
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
