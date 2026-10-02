/**
 * Batch 19C: staging a test server's tree never rewrites a file another
 * server is serving.
 *
 * The GitHub Stress run on the first 19C candidate lost `create-navigation`
 * without printing a line. That script restarts three servers at once, and
 * every start used to copy the build's static chunks and `public/` into the
 * shared `.next/standalone` — the tree every running server is hard-linked to.
 * `cpSync` onto an existing file truncates the inode and writes it again, so a
 * running server could serve a chunk while it was empty: measured, 7,734 of
 * 956,472 reads made during the copies found a chunk at 0 bytes. In the browser
 * that is "Loading chunk … failed (missing …)" — the script loaded and
 * installed nothing — and the stress script's next click waits out its timeout.
 *
 * `stageServer` now links each tree to the build's own files and writes
 * nothing shared. These checks start no server: they stage trees and compare
 * every file before and after, which is the whole of what changed.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { REPO_ROOT } from "./helpers/env";
import { BUILD_HINT, isBuilt, stageServer } from "./helpers/server";

/** Trees only — no server is started on these ports; they name the directories. */
const MINE = 3505;
const OTHER = 3506;
const SERVERS = path.join(REPO_ROOT, ".data", "test", "servers");
const BUILD_STATIC = path.join(REPO_ROOT, ".next", "static");
const SHARED = path.join(REPO_ROOT, ".next", "standalone");

/** Every file under `dir`, relative to it. */
function files(dir: string, prefix = ""): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(path.join(dir, entry.name), path.join(prefix, entry.name))
      : [path.join(prefix, entry.name)],
  );
}

/**
 * What a file is, when its content last changed, and the content itself — for
 * every file a server serves. Not its ctime: linking the same inode into
 * another tree moves the ctime (the link count changed) and nothing else.
 */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of [path.join(".next", "static"), "public"]) {
    for (const file of files(path.join(root, part))) {
      const full = path.join(root, part, file);
      const stat = statSync(full);
      const digest = createHash("sha1").update(readFileSync(full)).digest("hex");
      out[path.join(part, file)] = `${stat.ino}:${stat.size}:${stat.mtimeMs}:${digest}`;
    }
  }
  return out;
}

describe("19C · staging a server tree writes nothing another server reads", () => {
  test("a tree serves the build's own chunks and public files, linked — not copies in a shared tree", () => {
    if (!isBuilt()) throw new Error(BUILD_HINT);
    const root = stageServer(MINE, false);
    const chunks = files(BUILD_STATIC);
    assert.ok(chunks.length > 20, `the build has static files to serve: ${chunks.length}`);
    for (const file of chunks) {
      const served = statSync(path.join(root, ".next", "static", file));
      const built = statSync(path.join(BUILD_STATIC, file));
      assert.equal(served.ino, built.ino, `${file} is not the build's own file`);
    }
    const pub = files(path.join(REPO_ROOT, "public")).slice(0, 50);
    for (const file of pub) {
      assert.equal(
        statSync(path.join(root, "public", file)).ino,
        statSync(path.join(REPO_ROOT, "public", file)).ino,
        `public/${file} is not the repository's own file`,
      );
    }
  });

  test("staging other trees — again and again — leaves every file a staged tree serves exactly as it was", () => {
    if (!isBuilt()) throw new Error(BUILD_HINT);
    const root = stageServer(MINE, false);
    const before = snapshot(root);
    const shared = snapshot(SHARED);
    assert.ok(Object.keys(before).length > 20);
    for (let n = 0; n < 3; n += 1) stageServer(OTHER, false);
    assert.deepEqual(snapshot(root), before, "a file the first tree serves was rewritten by staging another");
    assert.deepEqual(snapshot(SHARED), shared, "the shared standalone tree was written to");
  });

  test("a restaged tree starts without the previous tree's cache", () => {
    if (!isBuilt()) throw new Error(BUILD_HINT);
    const root = stageServer(MINE, false);
    assert.equal(existsSync(path.join(root, ".next", "cache")), false);
    assert.ok(existsSync(path.join(root, "server.js")));
    for (const port of [MINE, OTHER]) assert.ok(existsSync(path.join(SERVERS, String(port))));
  });
});
