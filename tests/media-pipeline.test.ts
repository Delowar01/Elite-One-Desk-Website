/**
 * Batch 19B · the media pipeline on the release's image decoder.
 *
 * Every raster upload is decoded by sharp (`src/lib/media/process.ts`) and
 * written back out as WebP, so the decoder sees bytes an editor chose. Two
 * advisories sit on that path: GHSA-f88m-g3jw-g9cj (libvips, fixed in sharp
 * 0.35.0 — the GIF, TIFF and VIPS loaders) and GHSA-rgj7-g3m4-5g8c (libheif,
 * fixed in 0.35.4 — HEIF decoding, which an AVIF reaches, and so does any HEIF
 * file branded `mif1`, because the sniffer reads that brand as AVIF). The
 * release therefore carries a fixed sharp, and these tests prove two things
 * about it: that it is the fixed one, and that every format the library accepts
 * still decodes into exactly what it did before — nothing about the upgrade is
 * taken on trust.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { REPO_ROOT } from "./helpers/env";
import { giveFresh } from "./helpers/fixtures";
import { dropDatabase } from "./helpers/pg";
import { probeValue } from "./helpers/probe";

const UPLOADS = path.join(REPO_ROOT, ".data", "test-uploads");
const REFUSED = "That file is not a JPG, PNG, WebP, AVIF, GIF or SVG image.";

type Stored = {
  format: string;
  result: { ok: true; id: number; filename: string } | { ok: false; error: string };
  row: { mimeType: string; width: number; height: number; derivatives: number[] } | null;
};

type Run = { sharp: string; vips: string; stored: Stored[] };

const isWebp = (bytes: Buffer) =>
  bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP";

describe("19B · the media pipeline on the release's sharp", () => {
  let database = "";
  let run: Run;

  before(() => {
    database = giveFresh("media_pipeline");
    run = probeValue<Run>(
      database,
      `
import { eq } from "drizzle-orm";
import sharp from "sharp";

import { db } from "@/lib/db";
import { media } from "@/lib/db/schema";
import { processUpload } from "@/lib/media/process";

const picture = () =>
  sharp({ create: { width: 1000, height: 600, channels: 3, background: { r: 200, g: 120, b: 40 } } });

// A HEIF container whose major brand is "heic": the sniffer must not take it
// for an AVIF. Only the box header matters — it is refused by its bytes.
const heic = Buffer.alloc(64);
heic.writeUInt32BE(24, 0);
heic.write("ftypheic", 4, "ascii");
heic.write("mif1heic", 16, "ascii");

const inputs: [string, Buffer][] = [
  ["jpeg", await picture().jpeg().toBuffer()],
  ["png", await picture().png().toBuffer()],
  ["webp", await picture().webp().toBuffer()],
  ["avif", await picture().avif().toBuffer()],
  ["gif", await picture().gif().toBuffer()],
  ["tiff", await picture().tiff().toBuffer()],
  ["heic", heic],
  [
    "svg",
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 20"><script>alert(1)</script><rect width="40" height="20" fill="#c87828"/></svg>',
    ),
  ],
];

const stored = [];
for (const [format, bytes] of inputs) {
  const result = await processUpload(bytes, { originalName: "pipeline-" + format + "." + format, folder: "test" });
  const [row] = result.ok
    ? await db
        .select({ mimeType: media.mimeType, width: media.width, height: media.height, derivatives: media.derivatives })
        .from(media)
        .where(eq(media.id, result.id))
    : [null];
  stored.push({ format, result, row });
}
emit({ sharp: sharp.versions.sharp, vips: sharp.versions.vips, stored });
process.exit(0);
`,
    );
  });

  const of = (format: string) => run.stored.find((entry) => entry.format === format)!;
  const files = (entry: Stored) => {
    assert.ok(entry.result.ok, `${entry.format}: ${JSON.stringify(entry.result)}`);
    const stem = entry.result.filename.replace(/\.webp$/, "");
    return [entry.result.filename, ...(entry.row?.derivatives ?? []).map((width) => `${stem}@${width}.webp`)];
  };

  after(() => {
    for (const entry of run?.stored ?? []) {
      if (entry.result.ok) for (const name of files(entry)) rmSync(path.join(UPLOADS, name), { force: true });
    }
    if (database) dropDatabase(database);
  });

  test("the release carries the sharp that fixes the libvips and libheif advisories (0.35.4 or later)", () => {
    const [major, minor, patch] = run.sharp.split(".").map(Number);
    assert.ok(major! > 0 || minor! > 35 || (minor === 35 && patch! >= 4), `sharp ${run.sharp} (libvips ${run.vips}) is older than 0.35.4`);
  });

  test("every raster format the library accepts — JPG, PNG, WebP, AVIF, GIF — is decoded and stored as WebP with its derivatives", () => {
    for (const format of ["jpeg", "png", "webp", "avif", "gif"]) {
      const entry = of(format);
      assert.ok(entry.result.ok, `${format} was refused: ${JSON.stringify(entry.result)}`);
      assert.deepEqual(entry.row, { mimeType: "image/webp", width: 1000, height: 600, derivatives: [400, 800] }, format);
      for (const name of files(entry)) {
        const full = path.join(UPLOADS, name);
        assert.ok(existsSync(full), `${format}: ${name} was not written`);
        assert.ok(isWebp(readFileSync(full)), `${format}: ${name} is not a WebP`);
      }
    }
  });

  test("a format outside the allowlist — a TIFF, or a HEIF branded heic — is refused by its bytes and nothing is stored", () => {
    for (const format of ["tiff", "heic"]) {
      const entry = of(format);
      assert.deepEqual(entry.result, { ok: false, error: REFUSED }, format);
      assert.equal(entry.row, null, format);
    }
  });

  test("an SVG never reaches the decoder: it is stored as sanitised SVG, without its script", () => {
    const entry = of("svg");
    assert.ok(entry.result.ok, JSON.stringify(entry.result));
    assert.equal(entry.row?.mimeType, "image/svg+xml");
    assert.deepEqual(entry.row?.derivatives, []);
    const saved = readFileSync(path.join(UPLOADS, entry.result.filename), "utf8");
    assert.doesNotMatch(saved, /<script/i);
    assert.match(saved, /<rect/);
  });
});
