import "server-only";

import { asc } from "drizzle-orm";

import { db } from "@/lib/db";
import { media } from "@/lib/db/schema";

/** The media library as the block editor's picture chooser reads it. */
export const loadMediaOptions = () =>
  db
    .select({
      id: media.id,
      filename: media.filename,
      title: media.title,
      altEn: media.altEn,
      width: media.width,
      height: media.height,
      folder: media.folder,
    })
    .from(media)
    .orderBy(asc(media.folder), asc(media.title));
