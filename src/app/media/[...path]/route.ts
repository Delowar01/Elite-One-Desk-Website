import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

import { resolveUpload } from "@/lib/media/store";
import { shareFile } from "@/lib/media/url";

const TYPES: Record<string, string> = {
  webp: "image/webp",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  avif: "image/avif",
  gif: "image/gif",
  svg: "image/svg+xml",
};

/**
 * Serves uploaded media from UPLOAD_DIR.
 *
 * Files are immutable once written — a replacement is a new upload with a new
 * name — so everything is cached for a year. In production Nginx serves this
 * directory directly (see deploy/nginx.conf) and never reaches Node; this route
 * is what makes development identical and what keeps the app working if the
 * alias is ever removed.
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path: segments } = await params;
  // The store is flat: one segment, and nothing that looks like a traversal —
  // or `share/<stem>.webp`, a share image's 1600 rendition at the address
  // crawlers may fetch (`shareSrc`, Batch 26). That form names a rendition and
  // nothing else: never an original, never an SVG, which has none.
  const name =
    segments.length === 1 ? segments[0]! : segments.length === 2 && segments[0] === "share" ? shareFile(segments[1]!) : null;
  if (!name) return new Response("Not found", { status: 404 });

  const full = await resolveUpload(name);
  if (!full) return new Response("Not found", { status: 404 });

  let info;
  try {
    info = await stat(full);
    if (!info.isFile()) return new Response("Not found", { status: 404 });
  } catch {
    return new Response("Not found", { status: 404 });
  }

  const extension = name.split(".").pop()?.toLowerCase() ?? "";
  const contentType = TYPES[extension];
  if (!contentType) return new Response("Not found", { status: 404 });

  const headers = new Headers({
    "content-type": contentType,
    "content-length": String(info.size),
    "cache-control": "public, max-age=31536000, immutable",
    "x-content-type-options": "nosniff",
  });

  // An SVG is a document, not just pixels: even after sanitising, it is served
  // with nothing it could use if something slipped through.
  if (contentType === "image/svg+xml") {
    headers.set(
      "content-security-policy",
      "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    );
  }

  const stream = Readable.toWeb(createReadStream(full)) as WebReadableStream<Uint8Array>;
  return new Response(stream as unknown as BodyInit, { headers });
}
