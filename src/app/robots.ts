import type { MetadataRoute } from "next";

import { siteUrl } from "@/lib/env";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      {
        userAgent: "*",
        // `/media/share/` is where a page's share image is offered to the
        // crawlers that draw link previews (Batch 26, `shareSrc`): named
        // outright, so no broader rule added later can take it from them.
        allow: ["/", "/media/share/"],
        // The admin and the API are not content. `/search` is deliberately
        // crawlable but carries its own noindex, so a crawler reads the tag
        // rather than being blocked from ever seeing it. The resized copies of
        // every picture (`<stem>@<width>.webp`) stay out; a share image's
        // address has no `@` in it. The admin is `/admin` exactly, `/admin`
        // with a query (`/admin?denied=1`, where a refused permission lands)
        // and what is under `/admin/` — a bare `/admin` is a prefix, and kept
        // crawlers off a page the panel may make at `/administrative-services`
        // while the sitemap listed it (Batch 26). `?` is no wildcard here.
        disallow: ["/admin$", "/admin?", "/admin/", "/api/", "/media/*@*"],
      },
    ],
    sitemap: `${siteUrl}/sitemap.xml`,
    host: siteUrl,
  };
}
