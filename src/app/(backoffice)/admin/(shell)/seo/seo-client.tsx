"use client";

import { useCallback, useEffect, useState } from "react";

import { AdminForm, ConfirmSubmit, Field, InlineAction, SubmitButton } from "@/components/admin/form";
import type { ActionState } from "@/lib/admin/actions";
import { MediaPicker, type MediaOption } from "@/components/admin/media-picker";
import { clearSeo, saveSeo } from "./actions";

/** A record's fields, as the form edits them. */
export type SeoValues = {
  titleEn: string;
  titleAr: string;
  descriptionEn: string;
  descriptionAr: string;
  ogTitle: string;
  ogTitleAr: string;
  ogDescription: string;
  ogDescriptionAr: string;
  canonicalUrl: string;
  ogImageId: number | null;
  noindex: boolean;
};

/** One target as the screen lists it (Batch 25 — `lib/seo-targets.ts`). */
export type SeoEntry = {
  /** `destination:3` — what the form posts, never an address. */
  ref: string;
  group: "page" | "overview" | "category" | "service" | "destination" | "package";
  label: string;
  context: string | null;
  path: string;
  published: boolean;
  adminHref: string | null;
  /** What the page uses where its record says nothing. */
  own: { titleEn: string; titleAr: string; descriptionEn: string; descriptionAr: string; imageId: number | null };
  /** Its record, or `null` when it has none. */
  record: SeoValues | null;
  /** The signed base the form is drawn with. */
  base: string;
};

/** The site-wide fallbacks, shown so each page's fallback can be read in full. */
export type SiteDefaults = {
  defaultTitleEn: string;
  defaultTitleAr: string;
  titleTemplateEn: string;
  titleTemplateAr: string;
  defaultDescriptionEn: string;
  defaultDescriptionAr: string;
  ogImageId: number | null;
  twitterHandle: string;
};

const GROUPS: Array<{ group: SeoEntry["group"]; title: string; hint?: string }> = [
  { group: "page", title: "Pages" },
  {
    group: "overview",
    title: "Overviews",
    hint: "The Services and Tour packages pages. Their visible wording is edited in the Visual Editor; what they say in search results is set here.",
  },
  { group: "category", title: "Service categories" },
  { group: "service", title: "Services" },
  { group: "destination", title: "Destinations" },
  { group: "package", title: "Travel packages" },
];

/** The same address in the Arabic edition. */
const arabicPath = (path: string) => (path === "/" ? "/ar" : `/ar${path}`);

export function SeoClient({
  csrf,
  entries,
  media,
  site,
  open,
}: {
  csrf: string;
  entries: SeoEntry[];
  media: MediaOption[];
  site: SiteDefaults;
  open: string | null;
}) {
  const [editing, setEditing] = useState<string | null>(open);
  const [query, setQuery] = useState("");

  // A link from the Media library or the Visual Editor names one target: show it.
  useEffect(() => {
    if (!open) return;
    document.querySelector(`[data-seo-target="${CSS.escape(open)}"]`)?.scrollIntoView({ block: "start" });
  }, [open]);

  const needle = query.trim().toLowerCase();
  const filtered = needle
    ? entries.filter((entry) =>
        `${entry.label} ${entry.path} ${entry.context ?? ""}`.toLowerCase().includes(needle),
      )
    : entries;

  return (
    <div className="space-y-5">
      <input
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter by name or address"
        aria-label="Filter"
        className="admin-input max-w-md"
      />

      <SiteDefaultsCard site={site} media={media} />

      {GROUPS.map((group) => {
        const rows = filtered.filter((entry) => entry.group === group.group);
        if (!rows.length) return null;
        return (
          <section key={group.group} className="admin-card overflow-hidden" data-seo-group={group.group}>
            <div className="flex items-center justify-between gap-3 border-b border-[var(--admin-line)] px-4 py-3">
              <div>
                <h2>{group.title}</h2>
                {group.hint ? <p className="mt-0.5 text-[0.74rem] text-muted">{group.hint}</p> : null}
              </div>
              <span className="shrink-0 text-[0.74rem] text-muted">
                {rows.filter((row) => row.record).length} of {rows.length} with their own settings
              </span>
            </div>
            <ul className="divide-y divide-[var(--admin-line)]">
              {rows.map((entry) => {
                const isOpen = editing === entry.ref;
                return (
                  <li key={entry.ref} className="px-4 py-3" data-seo-target={entry.ref}>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold text-strong">{entry.label}</span>
                      {entry.context ? <span className="text-[0.74rem] text-muted">in {entry.context}</span> : null}
                      <span className="text-[0.74rem] text-muted" dir="ltr">
                        {entry.path}
                      </span>
                      {!entry.published ? (
                        <span className="admin-badge" title="Visitors do not see this page now. Its settings apply once it is published.">
                          Unpublished
                        </span>
                      ) : null}
                      {entry.record ? (
                        <span className="admin-badge" style={{ color: "var(--color-peach)" }}>
                          Custom
                        </span>
                      ) : null}
                      {entry.record?.noindex ? (
                        <span className="admin-badge" style={{ color: "#ff8a80" }}>
                          noindex
                        </span>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => setEditing(isOpen ? null : entry.ref)}
                        className="admin-btn admin-btn-sm ms-auto"
                        aria-expanded={isOpen}
                      >
                        {isOpen ? "Close" : "Edit"}
                      </button>
                    </div>

                    {!isOpen ? (
                      <p className="mt-1 line-clamp-1 text-[0.76rem] text-muted">
                        {entry.record?.titleEn || entry.own.titleEn || site.defaultTitleEn}
                      </p>
                    ) : (
                      <div className="mt-3 border-t border-[var(--admin-line)] pt-3">
                        <SeoForm csrf={csrf} entry={entry} media={media} site={site} />
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/**
 * The site-wide fallbacks, read-only: every page without its own value uses
 * these. They have no form yet (docs/admin/seo-and-share-images.md A.14 F6k);
 * they are here so the fallback each page names can be read in full.
 */
function SiteDefaultsCard({ site, media }: { site: SiteDefaults; media: MediaOption[] }) {
  const image = site.ogImageId ? media.find((option) => option.id === site.ogImageId) ?? null : null;
  return (
    <section className="admin-card px-4 py-3" data-seo-site-defaults>
      <h2>Site defaults</h2>
      <p className="mt-0.5 text-[0.74rem] text-muted">
        What a page uses when neither its own settings nor its own content give a value. Shown for reference.
      </p>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-[0.8rem] sm:grid-cols-2">
        <div>
          <dt className="text-muted">Default title</dt>
          <dd className="text-strong">{site.defaultTitleEn || "—"}</dd>
          <dd className="text-strong" dir="rtl">{site.defaultTitleAr || "—"}</dd>
        </div>
        <div>
          <dt className="text-muted">Title template</dt>
          <dd className="text-strong" dir="ltr">{site.titleTemplateEn || "—"}</dd>
          <dd className="text-strong" dir="rtl">{site.titleTemplateAr || "—"}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-muted">Default description</dt>
          <dd>{site.defaultDescriptionEn || "—"}</dd>
          <dd dir="rtl">{site.defaultDescriptionAr || "—"}</dd>
        </div>
        <div>
          <dt className="text-muted">Default share image</dt>
          <dd>{image ? image.title || image.filename : site.ogImageId ? `Picture #${site.ogImageId}` : "The site's built-in picture"}</dd>
        </div>
        <div>
          <dt className="text-muted">X handle</dt>
          <dd dir="ltr">{site.twitterHandle || "—"}</dd>
        </div>
      </dl>
    </section>
  );
}

function SeoForm({
  csrf,
  entry,
  media,
  site,
}: {
  csrf: string;
  entry: SeoEntry;
  media: MediaOption[];
  site: SiteDefaults;
}) {
  return (
    <div className="space-y-3">
      <p className="text-[0.74rem] text-muted">
        English: <span dir="ltr">{entry.path}</span> · Arabic: <span dir="ltr">{arabicPath(entry.path)}</span>
        {entry.adminHref ? (
          <>
            {" · "}
            <a href={entry.adminHref} className="underline">
              Edit the page itself
            </a>
          </>
        ) : null}
      </p>
      {!entry.published ? (
        <p className="text-[0.74rem] text-muted">
          This page is not published, so visitors do not see it. These settings apply as soon as it is.
        </p>
      ) : null}

      {/*
        The form and its result banner stay mounted across a save; only the
        fields are keyed by the base (as on the Services, Packages and
        Destinations forms). A save comes back with the stored record and its
        new base, every field is drawn afresh from that record — so what the
        form shows and the base it posts are always one snapshot — and "SEO
        saved." is still there to be read.
      */}
      <AdminForm action={saveSeo} successMessage="SEO saved.">
        <input type="hidden" name="_csrf" value={csrf} />
        <input type="hidden" name="target" value={entry.ref} />
        <input type="hidden" name="_base" value={entry.base} />
        <SeoFields key={entry.base} entry={entry} media={media} site={site} />
        <div className="mt-4">
          <SubmitButton className="admin-btn-sm">Save</SubmitButton>
        </div>
      </AdminForm>

      {entry.record ? <RemoveOverride key={entry.base} csrf={csrf} entry={entry} /> : null}
    </div>
  );
}

/** The record's fields, drawn from the record the base describes. */
function SeoFields({ entry, media, site }: { entry: SeoEntry; media: MediaOption[]; site: SiteDefaults }) {
  const record = entry.record;
  const [ogImageId, setOgImageId] = useState<number | null>(record?.ogImageId ?? null);
  const key = entry.ref.replace(/[^a-z0-9]/gi, "-");
  const quote = (text: string) => `“${text.length > 90 ? `${text.slice(0, 90)}…` : text}”`;
  // The rule the public page follows (`textFor`): each language on its own; an
  // Arabic page falls back to English only where it has no Arabic at all.
  const titleHintEn = entry.own.titleEn
    ? `Empty: the page's own title, ${quote(entry.own.titleEn)}.`
    : `Empty: the site default, ${quote(site.defaultTitleEn)}.`;
  const titleHintAr = entry.own.titleAr
    ? `Empty: the page's own Arabic title, ${quote(entry.own.titleAr)} — never the English one.`
    : "This page has no Arabic title of its own, so empty means the English title above, then the page's English title or the site default.";
  const descriptionHintEn = entry.own.descriptionEn
    ? `Around 150–160 characters reads well in a result. Empty: the page's own text, ${quote(entry.own.descriptionEn)}.`
    : "Around 150–160 characters reads well in a result. Empty: the site default description.";
  const descriptionHintAr = entry.own.descriptionAr
    ? `Empty: the page's own Arabic text, ${quote(entry.own.descriptionAr)}.`
    : "This page has no Arabic text of its own, so empty means the English description above, then the page's English text or the site default.";
  const ownImage = entry.own.imageId ? "the page's own picture" : site.ogImageId ? "the site default share image" : "the site's built-in picture";
  const chosen = ogImageId ? media.find((option) => option.id === ogImageId) ?? null : null;

  return (
    <>
      <input type="hidden" name="ogImageId" value={ogImageId ?? ""} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Title (English)"
          name={`titleEn-${key}`}
          hint={titleHintEn}
        >
          <input id={`titleEn-${key}`} name="titleEn" defaultValue={record?.titleEn ?? ""} maxLength={190} className="admin-input" />
        </Field>
        <Field
          label="Title (العربية)"
          name={`titleAr-${key}`}
          hint={titleHintAr}
        >
          <input
            id={`titleAr-${key}`}
            name="titleAr"
            defaultValue={record?.titleAr ?? ""}
            maxLength={190}
            dir="rtl"
            className="admin-input"
          />
        </Field>

        <Field
          label="Meta description (English)"
          name={`descriptionEn-${key}`}
          hint={descriptionHintEn}
        >
          <textarea
            id={`descriptionEn-${key}`}
            name="descriptionEn"
            rows={2}
            maxLength={320}
            defaultValue={record?.descriptionEn ?? ""}
            className="admin-textarea"
          />
        </Field>
        <Field
          label="Meta description (العربية)"
          name={`descriptionAr-${key}`}
          hint={descriptionHintAr}
        >
          <textarea
            id={`descriptionAr-${key}`}
            name="descriptionAr"
            rows={2}
            maxLength={320}
            defaultValue={record?.descriptionAr ?? ""}
            dir="rtl"
            className="admin-textarea"
          />
        </Field>

        <Field label="Share title (English)" name={`ogTitle-${key}`} hint="Used when the page is shared. Empty: the English title.">
          <input id={`ogTitle-${key}`} name="ogTitle" defaultValue={record?.ogTitle ?? ""} maxLength={190} className="admin-input" />
        </Field>
        <Field label="Share title (العربية)" name={`ogTitleAr-${key}`} hint="Empty: the Arabic title.">
          <input
            id={`ogTitleAr-${key}`}
            name="ogTitleAr"
            defaultValue={record?.ogTitleAr ?? ""}
            maxLength={190}
            dir="rtl"
            className="admin-input"
          />
        </Field>
        <Field label="Share description (English)" name={`ogDescription-${key}`} hint="Empty: the English description.">
          <textarea
            id={`ogDescription-${key}`}
            name="ogDescription"
            rows={2}
            maxLength={320}
            defaultValue={record?.ogDescription ?? ""}
            className="admin-textarea"
          />
        </Field>
        <Field label="Share description (العربية)" name={`ogDescriptionAr-${key}`} hint="Empty: the Arabic description.">
          <textarea
            id={`ogDescriptionAr-${key}`}
            name="ogDescriptionAr"
            rows={2}
            maxLength={320}
            defaultValue={record?.ogDescriptionAr ?? ""}
            dir="rtl"
            className="admin-textarea"
          />
        </Field>

        <Field
          label="Canonical address"
          name={`canonicalUrl-${key}`}
          hint="Only if the same content also lives at another address of this site, such as /about. It is given the /ar prefix on the Arabic page. Empty: the page is its own canonical."
        >
          <input
            id={`canonicalUrl-${key}`}
            name="canonicalUrl"
            defaultValue={record?.canonicalUrl ?? ""}
            maxLength={255}
            dir="ltr"
            className="admin-input"
          />
        </Field>

        <div>
          <span className="admin-label">Share image</span>
          <MediaPicker value={ogImageId} onChange={setOgImageId} options={media} label="Share image" />
          <p className="mt-1 text-[0.73rem] text-muted">
            One picture for both languages. Empty: {ownImage}.
          </p>
          {chosen && chosen.width > 0 && chosen.height > 0 && (chosen.width < 1200 || chosen.height < 630) ? (
            <p className="mt-1 text-[0.73rem]" style={{ color: "var(--color-peach)" }}>
              This picture is {chosen.width} × {chosen.height}. Social networks show a picture smaller than
              1200 × 630 as a small thumbnail{chosen.width < 300 || chosen.height < 157 ? ", and X as a small card" : ""}.
            </p>
          ) : null}
        </div>
      </div>

      <label className="mt-3 flex cursor-pointer items-start gap-2.5">
        <input
          type="checkbox"
          name="noindex"
          defaultChecked={record?.noindex ?? false}
          className="mt-0.5 size-4 accent-[var(--color-orange)]"
        />
        <span>
          <span className="block text-[0.85rem] text-strong">Keep out of search engines</span>
          <span className="block text-[0.73rem] text-muted">
            The page still works and is still linked — search engines are simply asked not to list it.
          </span>
        </span>
      </label>
    </>
  );
}

/**
 * Remove override: held to the same base as the form, so it refuses when the
 * record changed since the screen was drawn. Keyed by the base, so a refusal
 * shown here is cleared once the screen is drawn again.
 */
function RemoveOverride({ csrf, entry }: { csrf: string; entry: SeoEntry }) {
  const [removal, setRemoval] = useState<ActionState | null>(null);
  const onRemoved = useCallback((state: ActionState) => setRemoval(state), []);
  return (
    <div className="flex flex-wrap items-center gap-2">
      <InlineAction action={clearSeo} hidden={{ _csrf: csrf, target: entry.ref, _base: entry.base }} onResult={onRemoved}>
        <ConfirmSubmit
          className="admin-btn-sm"
          message="Remove this page's own search and sharing settings, so it follows its own title and description again?"
        >
          Remove override
        </ConfirmSubmit>
      </InlineAction>
      {removal && !removal.ok ? (
        <p role="alert" className="text-[0.74rem]" style={{ color: "#ff9a95" }}>
          {removal.message}
        </p>
      ) : null}
    </div>
  );
}
