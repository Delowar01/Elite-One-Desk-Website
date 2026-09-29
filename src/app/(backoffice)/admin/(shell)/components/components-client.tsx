"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { componentStatus } from "@/components/admin/visual-editor/reuse-panel";
import { kindDef } from "@/lib/cms/reuse/kinds";
import { usageHeadline } from "@/lib/cms/reuse/usage-view";
import type { ReuseCatalogEntry } from "@/lib/cms/reuse/view";

import { createReusableComponent } from "./actions";

type Status = "all" | "published" | "draft" | "unpublished" | "archived";

const STATUS_LABEL: Record<Status, string> = {
  all: "Every status",
  published: "Published",
  draft: "Draft pending",
  unpublished: "Not published yet",
  archived: "Archived",
};

function matches(entry: ReuseCatalogEntry, status: Status): boolean {
  switch (status) {
    case "all":
      return entry.status === "active";
    case "archived":
      return entry.status === "archived";
    case "published":
      return entry.status === "active" && entry.publishedVersion > 0;
    case "draft":
      return entry.status === "active" && entry.hasDraft;
    case "unpublished":
      return entry.status === "active" && entry.publishedVersion < 1;
  }
}

/**
 * The list of reusable components: searchable by name, filtered by type and
 * status, each with where it is used. Archived components are their own
 * filter, out of the default list — they are kept for the pages that still
 * show them, not offered for anything new.
 */
export function ComponentsClient({
  entries,
  kinds,
  canCreate,
  csrf,
}: {
  entries: ReuseCatalogEntry[];
  kinds: { kind: string; label: string }[];
  /** `components.edit` (Batch 18) — a new component starts as a draft, so creating one is editing. */
  canCreate: boolean;
  csrf: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState("all");
  const [status, setStatus] = useState<Status>("all");
  const [creating, setCreating] = useState(false);
  const [newKind, setNewKind] = useState(kinds[0]?.kind ?? "cta");
  const [newName, setNewName] = useState("");
  const [message, setMessage] = useState<string | null>(null);

  const needle = query.trim().toLowerCase();
  const list = useMemo(
    () =>
      entries.filter(
        (entry) =>
          matches(entry, status) &&
          (kind === "all" || entry.kind === kind) &&
          (!needle || entry.name.toLowerCase().includes(needle)),
      ),
    [entries, kind, needle, status],
  );

  const create = async () => {
    setMessage(null);
    const form = new FormData();
    form.set("_csrf", csrf);
    form.set("kind", newKind);
    form.set("name", newName);
    form.set("publish", "0");
    const result = await createReusableComponent(form);
    if (!result.ok || !result.component) {
      setMessage(result.message);
      return;
    }
    router.push(`/admin/components/${result.component.id}`);
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3" role="search" aria-label="Find a reusable component">
        <label className="flex flex-col text-[0.75rem] text-muted">
          Search
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Name"
            className="admin-input mt-1 w-60"
          />
        </label>
        <label className="flex flex-col text-[0.75rem] text-muted">
          Type
          <select value={kind} onChange={(event) => setKind(event.target.value)} className="admin-select mt-1">
            <option value="all">Every type</option>
            {kinds.map((entry) => (
              <option key={entry.kind} value={entry.kind}>
                {entry.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-[0.75rem] text-muted">
          Status
          <select value={status} onChange={(event) => setStatus(event.target.value as Status)} className="admin-select mt-1">
            {(Object.keys(STATUS_LABEL) as Status[]).map((value) => (
              <option key={value} value={value}>
                {STATUS_LABEL[value]}
              </option>
            ))}
          </select>
        </label>
        {canCreate ? (
          <button type="button" className="admin-btn admin-btn-primary ms-auto" onClick={() => setCreating((open) => !open)} aria-expanded={creating}>
            New reusable component
          </button>
        ) : (
          <p className="ms-auto text-[0.74rem] text-muted" role="note" data-permission-note="components.edit">
            You can view reusable components, but your role does not allow creating or editing them.
          </p>
        )}
      </div>

      {creating ? (
        <form
          className="admin-card flex flex-wrap items-end gap-3 p-4"
          aria-label="New reusable component"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <label className="flex flex-col text-[0.75rem] text-muted">
            Type
            <select value={newKind} onChange={(event) => setNewKind(event.target.value)} className="admin-select mt-1">
              {kinds.map((entry) => (
                <option key={entry.kind} value={entry.kind}>
                  {entry.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-[0.75rem] text-muted">
            Name <span className="sr-only">(for the admin — visitors never see it)</span>
            <input value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={120} required className="admin-input mt-1 w-64" />
          </label>
          <button type="submit" className="admin-btn admin-btn-primary" disabled={!newName.trim()}>
            Create draft
          </button>
          <p className="basis-full text-[0.74rem] text-muted">
            It starts as a draft. Fill it in, then publish it before linking anything to it. Or make one from a page:
            select a call to action in the Visual Editor and choose “Save as reusable CTA”.
          </p>
          {message ? (
            <p className="basis-full text-[0.76rem]" role="alert" style={{ color: "#ef8f8a" }}>
              {message}
            </p>
          ) : null}
        </form>
      ) : null}

      {list.length ? (
        <div className="admin-card overflow-x-auto">
          <table className="w-full text-start text-[0.8rem]" data-components-table>
            <caption className="sr-only">Reusable components</caption>
            <thead>
              <tr className="border-b border-[var(--admin-line)] text-[0.7rem] uppercase tracking-wide text-muted">
                <th scope="col" className="px-3 py-2 text-start font-semibold">Name</th>
                <th scope="col" className="px-3 py-2 text-start font-semibold">Type</th>
                <th scope="col" className="px-3 py-2 text-start font-semibold">Status</th>
                <th scope="col" className="px-3 py-2 text-start font-semibold">Used on</th>
                <th scope="col" className="px-3 py-2 text-start font-semibold">Updated</th>
              </tr>
            </thead>
            <tbody>
              {list.map((entry) => (
                <tr key={entry.id} className="border-b border-[var(--admin-line)] last:border-0" data-component-row={entry.id}>
                  <td className="px-3 py-2">
                    <Link href={`/admin/components/${entry.id}`} className="font-medium text-strong underline">
                      {entry.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-muted">{kindDef(entry.kind)?.label ?? entry.kind}</td>
                  <td className="px-3 py-2 text-muted">{componentStatus(entry)}</td>
                  <td className="px-3 py-2 text-muted">{usageHeadline(entry.usage)}</td>
                  <td className="px-3 py-2 text-muted">
                    <time dateTime={entry.updatedAt}>{entry.updatedAt.slice(0, 10)}</time>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="text-[0.82rem] text-muted">
          {entries.length ? "Nothing matches." : "No reusable components yet."}
        </p>
      )}
    </div>
  );
}
