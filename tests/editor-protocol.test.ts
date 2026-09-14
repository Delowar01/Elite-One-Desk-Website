/**
 * The closed vocabulary the editor and its canvas speak, and the widths they
 * agree on.
 *
 * Both are pure decisions, and both are the kind that fail quietly if they go
 * wrong: a protocol that accepts one message too many is an opening, and a
 * viewport contract that drifts means an editor designing a page at a width no
 * visitor ever sees.
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { localisedPagePath, previewPagePath, publicPathForPage } from "@/lib/page-path";
import {
  BRIDGE_ID_PATTERN,
  EDITOR_CHANNEL,
  PROTOCOL_VERSION,
  envelope,
  isBridgeId,
  newBridgeId,
  readCanvasMessage,
  readEditorMessage,
} from "@/lib/visual-editor/protocol";
import {
  DEFAULT_DEVICE,
  EDITOR_DEVICES,
  deviceOrDefault,
  deviceWidth,
  isDeviceKey,
} from "@/lib/visual-editor/viewport";

const BRIDGE = "0123456789abcdef0123456789abcdef";
const READY = {
  type: "canvas.ready" as const,
  pageId: 7,
  slug: "home",
  locale: "en" as const,
  innerWidth: 1440,
};

const wrap = (message: unknown, over: Record<string, unknown> = {}) => ({
  ...envelope(BRIDGE, message),
  ...over,
});

/* -------------------------------------------------------------------------- */

describe("a bridge id is opaque, checkable, and not a credential", () => {
  test("generated ids match the pattern and do not repeat", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i += 1) {
      const id = newBridgeId();
      assert.match(id, BRIDGE_ID_PATTERN);
      assert.ok(!seen.has(id));
      seen.add(id);
    }
  });

  test("anything that is not one is refused before it can reach a payload", () => {
    for (const bad of ["", "short", "../../etc/passwd", "a".repeat(65), "has space", "has.dot", 42, null, {}]) {
      assert.ok(!isBridgeId(bad), String(bad));
    }
    assert.ok(isBridgeId(BRIDGE));
  });
});

/* -------------------------------------------------------------------------- */

describe("the editor reads only what the canvas is allowed to say", () => {
  test("a well-formed announcement is accepted", () => {
    assert.deepEqual(readCanvasMessage(wrap(READY), { bridgeId: BRIDGE }), READY);
    assert.deepEqual(readCanvasMessage(wrap(READY), { bridgeId: BRIDGE, slug: "home" }), READY);
  });

  test("pong and error are accepted; nothing else is", () => {
    assert.deepEqual(readCanvasMessage(wrap({ type: "canvas.pong", at: 5 }), { bridgeId: BRIDGE }), {
      type: "canvas.pong",
      at: 5,
    });
    assert.deepEqual(
      readCanvasMessage(wrap({ type: "canvas.error", message: "no" }), { bridgeId: BRIDGE }),
      { type: "canvas.error", message: "no" },
    );
    for (const type of [
      "editor.ping",
      "canvas.select",
      "canvas.mutate",
      "eval",
      "__proto__",
      "",
      1,
      null,
    ]) {
      assert.equal(readCanvasMessage(wrap({ type }), { bridgeId: BRIDGE }), null, String(type));
    }
  });

  test("a message on another channel is not ours", () => {
    assert.equal(readCanvasMessage(wrap(READY, { channel: "something-else" }), { bridgeId: BRIDGE }), null);
    assert.equal(readCanvasMessage(wrap(READY, { channel: undefined }), { bridgeId: BRIDGE }), null);
    assert.equal(EDITOR_CHANNEL, "eod.visual-editor");
  });

  test("a message from another protocol version is silence, not a guess", () => {
    for (const v of [PROTOCOL_VERSION + 1, PROTOCOL_VERSION - 1, "1", null, undefined]) {
      assert.equal(readCanvasMessage(wrap(READY, { v }), { bridgeId: BRIDGE }), null, String(v));
    }
  });

  test("a message carrying another bridge id is rejected — that is what makes a stale frame harmless", () => {
    const other = "f".repeat(32);
    assert.equal(readCanvasMessage(wrap(READY), { bridgeId: other }), null);
    assert.equal(readCanvasMessage(wrap(READY, { bridgeId: "nope" }), { bridgeId: BRIDGE }), null);
    assert.equal(readCanvasMessage(wrap(READY, { bridgeId: undefined }), { bridgeId: BRIDGE }), null);
  });

  test("an announcement from a page the editor did not ask for is rejected", () => {
    assert.equal(readCanvasMessage(wrap(READY), { bridgeId: BRIDGE, slug: "about" }), null);
  });

  test("a malformed payload is rejected field by field", () => {
    for (const over of [
      { pageId: 0 },
      { pageId: -1 },
      { pageId: 1.5 },
      { pageId: "7" },
      { slug: "" },
      { slug: 7 },
      { locale: "fr" },
      { locale: "" },
      { locale: null },
      { innerWidth: 0 },
      { innerWidth: -100 },
      { innerWidth: "1440" },
      { innerWidth: 1440.5 },
    ]) {
      assert.equal(
        readCanvasMessage(wrap({ ...READY, ...over }), { bridgeId: BRIDGE }),
        null,
        JSON.stringify(over),
      );
    }
  });

  test("an envelope that is not an object, or has no message, is nothing", () => {
    for (const junk of [null, undefined, "string", 42, [], { channel: EDITOR_CHANNEL }]) {
      assert.equal(readCanvasMessage(junk, { bridgeId: BRIDGE }), null);
    }
    assert.equal(readCanvasMessage(wrap("not an object"), { bridgeId: BRIDGE }), null);
  });
});

/* -------------------------------------------------------------------------- */

describe("the canvas reads only what the editor is allowed to say", () => {
  test("a ping is accepted; nothing else is", () => {
    assert.deepEqual(readEditorMessage(wrap({ type: "editor.ping", at: 9 }), { bridgeId: BRIDGE }), {
      type: "editor.ping",
      at: 9,
    });
    for (const message of [
      { type: "editor.select", address: "section:1" },
      { type: "editor.write", values: {} },
      { type: "canvas.ready" },
      { type: "editor.ping" },
      { type: "editor.ping", at: "now" },
      { type: "editor.ping", at: -1 },
    ]) {
      assert.equal(readEditorMessage(wrap(message), { bridgeId: BRIDGE }), null, JSON.stringify(message));
    }
  });

  test("the same envelope checks apply in this direction too", () => {
    const ping = { type: "editor.ping", at: 1 };
    assert.equal(readEditorMessage(wrap(ping, { channel: "x" }), { bridgeId: BRIDGE }), null);
    assert.equal(readEditorMessage(wrap(ping, { v: 99 }), { bridgeId: BRIDGE }), null);
    assert.equal(readEditorMessage(wrap(ping), { bridgeId: "a".repeat(32) }), null);
  });
});

/* -------------------------------------------------------------------------- */

describe("the viewport contract", () => {
  test("the three widths are fixed, and these are them", () => {
    assert.deepEqual(
      Object.fromEntries(EDITOR_DEVICES.map((device) => [device.key, device.width])),
      { desktop: 1440, tablet: 834, mobile: 390 },
    );
    assert.equal(deviceWidth("desktop"), 1440);
    assert.equal(deviceWidth("tablet"), 834);
    assert.equal(deviceWidth("mobile"), 390);
  });

  test("desktop is the default, and an unknown value falls back rather than throwing", () => {
    assert.equal(DEFAULT_DEVICE, "desktop");
    for (const junk of ["watch", "", null, undefined, 1440, {}]) {
      assert.equal(deviceOrDefault(junk), "desktop", String(junk));
      assert.ok(!isDeviceKey(junk));
    }
    assert.equal(deviceOrDefault("mobile"), "mobile");
  });

  test("every width is a real number of pixels, not a maximum or a ratio", () => {
    for (const device of EDITOR_DEVICES) {
      assert.ok(Number.isInteger(device.width) && device.width >= 320, device.key);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("the canvas address is built from a page, never from a query string", () => {
  test("home is the site root; every other page is its slug", () => {
    assert.equal(publicPathForPage("home"), "/");
    assert.equal(publicPathForPage("about"), "/about");
  });

  test("english stays at the root and arabic sits under /ar — never /en", () => {
    assert.equal(localisedPagePath("home", "en"), "/");
    assert.equal(localisedPagePath("home", "ar"), "/ar");
    assert.equal(localisedPagePath("about", "en"), "/about");
    assert.equal(localisedPagePath("about", "ar"), "/ar/about");
    for (const path of ["home", "about"].flatMap((slug) => ["en", "ar"].map((l) => localisedPagePath(slug, l as "en")))) {
      assert.ok(!path.startsWith("/en"), path);
    }
  });

  test("the preview address carries preview, and editor mode carries the bridge", () => {
    assert.equal(previewPagePath("about", "en"), "/about?preview=1");
    assert.equal(previewPagePath("home", "ar", { nonce: 2 }), "/ar?preview=1&r=2");

    const canvas = previewPagePath("about", "ar", { nonce: 0, editor: { bridgeId: BRIDGE } });
    const url = new URL(canvas, "http://x.invalid");
    assert.equal(url.pathname, "/ar/about");
    assert.equal(url.searchParams.get("preview"), "1");
    assert.equal(url.searchParams.get("editor"), "1");
    assert.equal(url.searchParams.get("bridge"), BRIDGE);
  });

  test("the standalone preview link is an ordinary preview — no bridge on it", () => {
    const standalone = previewPagePath("home", "en");
    assert.ok(!standalone.includes("editor="));
    assert.ok(!standalone.includes("bridge="));
  });
});
