"use client";

import Link from "next/link";

import { InlineAction } from "@/components/admin/form";
import { Icon } from "@/components/ui/icon";
import { toggleDestination } from "./actions";

type Row = {
  id: number;
  slug: string;
  titleEn: string;
  titleAr: string;
  isPublished: boolean;
  packages: number;
};

export function DestinationRows({ csrf, rows }: { csrf: string; rows: Row[] }) {
  return (
    <div className="admin-card overflow-x-auto">
      <table className="admin-table">
        <thead>
          <tr>
            <th>Destination</th>
            <th>العربية</th>
            <th>Packages</th>
            <th>State</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              <td>
                <Link
                  href={`/admin/packages/destinations/${row.id}`}
                  className="font-semibold text-strong hover:text-[var(--color-peach)]"
                >
                  {row.titleEn}
                </Link>
                <span className="block text-[0.72rem] text-muted" dir="ltr">
                  /packages/{row.slug}
                </span>
              </td>
              <td className="text-muted" dir="rtl">
                {row.titleAr || "—"}
              </td>
              <td className="text-muted tabular-nums">
                {row.packages}
                {row.packages === 0 && row.isPublished ? (
                  <span className="ms-2 text-[0.72rem]">not shown on the site</span>
                ) : null}
              </td>
              <td>
                <span
                  className="admin-badge"
                  style={{ color: row.isPublished ? "#63c98c" : "#9aa2b5" }}
                >
                  {row.isPublished ? "Published" : "Hidden"}
                </span>
              </td>
              <td className="text-end">
                <span className="flex justify-end gap-1.5">
                  <InlineAction action={toggleDestination} hidden={{ _csrf: csrf, id: row.id }}>
                    <button
                      type="submit"
                      className="admin-btn admin-btn-sm"
                      title={row.isPublished ? "Unpublish" : "Publish"}
                    >
                      <Icon name={row.isPublished ? "eyeOff" : "eye"} size={12} />
                    </button>
                  </InlineAction>
                  <Link
                    href={`/admin/packages/destinations/${row.id}`}
                    className="admin-btn admin-btn-sm"
                  >
                    Edit
                  </Link>
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
