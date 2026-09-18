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
const RECT = { x: 10, y: 20, width: 300, height: 40 };
const NODE = {
  address: "section:7/field:links/item:i_aaaaaaaaaa/field:label",
  kind: "field" as const,
  sectionId: 7,
  blockType: "quick-links",
  relativePath: "field:links/item:i_aaaaaaaaaa/field:label",
  text: "Plan a Trip",
};
const SECTION = {
  address: "section:7",
  sectionId: 7,
  blockType: "quick-links",
  position: 1,
  isDraft: false,
  isDraftOnly: false,
  visible: true,
};
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

  test("this build speaks version 2, and a version 1 canvas is not half-understood", () => {
    assert.equal(PROTOCOL_VERSION, 2);
    // A document served by the previous release answers in v1. Selection did
    // not exist there, so the two simply do not recognise each other — which is
    // the outcome that cannot go subtly wrong.
    assert.equal(readCanvasMessage(wrap(READY, { v: 1 }), { bridgeId: BRIDGE }), null);
    assert.equal(readEditorMessage(wrap({ type: "editor.ping", at: 1 }, { v: 1 }), { bridgeId: BRIDGE }), null);
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

describe("version 2: structure, hover, selection and bounds", () => {
  test("a structure message is read entry by entry", () => {
    const message = readCanvasMessage(wrap({ type: "canvas.structure", sections: [SECTION] }), {
      bridgeId: BRIDGE,
    });
    assert.deepEqual(message, { type: "canvas.structure", sections: [SECTION] });
  });

  test("one malformed entry loses a row, not the whole panel", () => {
    const message = readCanvasMessage(
      wrap({
        type: "canvas.structure",
        sections: [
          SECTION,
          { ...SECTION, address: "div > p" },
          { ...SECTION, sectionId: 9 },
          { ...SECTION, visible: "yes" },
          null,
          "nope",
        ],
      }),
      { bridgeId: BRIDGE },
    );
    assert.deepEqual(message, { type: "canvas.structure", sections: [SECTION] });
  });

  test("a section entry has to be a section, not a field pretending", () => {
    for (const over of [
      { address: "section:7/field:title" },
      { address: "field:title" },
      { sectionId: 0 },
      { blockType: "" },
      { position: -1 },
      { position: 1.5 },
      { isDraft: 1 },
      { isDraftOnly: null },
    ]) {
      const message = readCanvasMessage(
        wrap({ type: "canvas.structure", sections: [{ ...SECTION, ...over }] }),
        { bridgeId: BRIDGE },
      );
      assert.deepEqual(message, { type: "canvas.structure", sections: [] }, JSON.stringify(over));
    }
  });

  test("hover and selection carry a node and a rectangle, or nothing", () => {
    for (const type of ["canvas.hover", "canvas.selection"] as const) {
      assert.deepEqual(readCanvasMessage(wrap({ type, node: NODE, rect: RECT }), { bridgeId: BRIDGE }), {
        type,
        node: NODE,
        rect: RECT,
      });
      assert.deepEqual(readCanvasMessage(wrap({ type, node: null, rect: null }), { bridgeId: BRIDGE }), {
        type,
        node: null,
        rect: null,
      });
      // A rectangle with nothing it belongs to is half a message.
      assert.equal(readCanvasMessage(wrap({ type, rect: RECT }), { bridgeId: BRIDGE }), null);
    }
  });

  test("a selection may have nothing to draw; a hover may not", () => {
    // The asymmetry is deliberate. A hover is the answer to "what is under the
    // pointer", and something with no box is not under anything. A selection is
    // the answer to "what is being edited", and an element hidden at the width
    // being previewed is exactly that — still in the document, measuring 0×0,
    // and the only place the control that un-hides it can be reached from.
    assert.deepEqual(
      readCanvasMessage(wrap({ type: "canvas.selection", node: NODE, rect: null }), { bridgeId: BRIDGE }),
      { type: "canvas.selection", node: NODE, rect: null },
    );
    assert.equal(
      readCanvasMessage(wrap({ type: "canvas.hover", node: NODE, rect: null }), { bridgeId: BRIDGE }),
      null,
    );
    // A selection still has to name a node the reader can rebuild.
    assert.equal(
      readCanvasMessage(wrap({ type: "canvas.selection", node: { ...NODE, address: "div > p" }, rect: null }), {
        bridgeId: BRIDGE,
      }),
      null,
    );
  });

  test("an explicit null is a claim; a rectangle that cannot be read is a fault", () => {
    /**
     * `rect: null` says "the canvas looked and there was nothing to draw".
     * A *non-null* rectangle the reader cannot make sense of says something
     * went wrong on the way here. Collapsing the second into the first would
     * file a bug under a legitimate state: the editor would show a selection
     * with no outline and no reason, and whatever produced the `NaN` would
     * never be noticed. Every one of these is refused outright.
     */
    const malformed: unknown[] = [
      { x: 0, y: 0, width: 0, height: 10 },
      { x: 0, y: 0, width: 10, height: 0 },
      { x: 0, y: 0, width: 0, height: 0 },
      { x: Number.NaN, y: 0, width: 10, height: 10 },
      { x: 0, y: Number.POSITIVE_INFINITY, width: 10, height: 10 },
      { x: 0, y: 0, width: Number.NaN, height: 10 },
      { x: 0, y: 0, width: 10, height: Number.NEGATIVE_INFINITY },
      { x: "0", y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: "10", height: 10 },
      { x: 0, y: 0, width: 1e9, height: 10 },
      { x: -1e9, y: 0, width: 10, height: 10 },
      { x: 0, y: 0, width: 10 },
      { left: 0, top: 0, width: 10, height: 10 },
      {},
      [],
      "bad",
      0,
      true,
    ];
    for (const rect of malformed) {
      for (const type of ["canvas.hover", "canvas.selection"] as const) {
        assert.equal(
          readCanvasMessage(wrap({ type, node: NODE, rect }), { bridgeId: BRIDGE }),
          null,
          `${type} accepted ${JSON.stringify(rect)}`,
        );
      }
    }
    // `undefined` is not `null`: a message that simply left the field out is
    // not a claim about anything.
    assert.equal(
      readCanvasMessage(wrap({ type: "canvas.selection", node: NODE }), { bridgeId: BRIDGE }),
      null,
    );
  });

  test("nothing selected and nothing hovered have exactly one spelling", () => {
    for (const type of ["canvas.hover", "canvas.selection"] as const) {
      assert.deepEqual(readCanvasMessage(wrap({ type, node: null, rect: null }), { bridgeId: BRIDGE }), {
        type,
        node: null,
        rect: null,
      });
      // A rectangle belonging to nothing is not a message, however valid the
      // rectangle is.
      assert.equal(readCanvasMessage(wrap({ type, node: null, rect: RECT }), { bridgeId: BRIDGE }), null);
      assert.equal(
        readCanvasMessage(wrap({ type, node: null, rect: { x: 0, y: 0, width: 0, height: 0 } }), {
          bridgeId: BRIDGE,
        }),
        null,
      );
      assert.equal(readCanvasMessage(wrap({ type, node: null }), { bridgeId: BRIDGE }), null);
    }
  });

  test("node metadata is rebuilt field by field, and the two halves must agree", () => {
    for (const over of [
      { address: "div > p" },
      { address: "field:title" },
      { address: "" },
      { kind: "anything" },
      { kind: "" },
      // The section id beside the address has to be the one inside it.
      { sectionId: 8 },
      { sectionId: 0 },
      // The relative path has to be the address without its section.
      { relativePath: "field:title" },
      { relativePath: "" },
      { blockType: "" },
      { blockType: "x".repeat(60) },
      // A section node cannot have a path.
      { kind: "section" },
    ]) {
      assert.equal(
        readCanvasMessage(wrap({ type: "canvas.hover", node: { ...NODE, ...over }, rect: RECT }), {
          bridgeId: BRIDGE,
        }),
        null,
        JSON.stringify(over),
      );
    }
  });

  test("a rectangle has to be finite, sized and sane", () => {
    for (const rect of [
      { x: 0, y: 0, width: 0, height: 10 },
      { x: 0, y: 0, width: 10, height: 0 },
      { x: Number.NaN, y: 0, width: 10, height: 10 },
      { x: 0, y: Number.POSITIVE_INFINITY, width: 10, height: 10 },
      { x: 0, y: 0, width: Number.NaN, height: 10 },
      { x: 0, y: 0, width: 10, height: Number.NEGATIVE_INFINITY },
      { x: "0", y: 0, width: 10, height: 10 },
      // An element inside an animating container can measure absurdly for one
      // frame, and an overlay drawn from it covers the editor.
      { x: 0, y: 0, width: 5_000_000, height: 10 },
      { x: -9_000_000, y: 0, width: 10, height: 10 },
      null,
      "big",
    ]) {
      assert.equal(
        readCanvasMessage(wrap({ type: "canvas.hover", node: NODE, rect }), { bridgeId: BRIDGE }),
        null,
        JSON.stringify(rect),
      );
    }
  });

  /**
   * The two "nothing" messages do not mean the same thing, and the handlers
   * must not treat them as if they did.
   *
   *   `canvas.selection` with a null node — the node is gone from the document.
   *   Nothing is selected any more: no overlay, no inspector, no lit layer.
   *
   *   `canvas.bounds` with a null rect — the node is still there and cannot be
   *   measured this frame: mid-transition, collapsed, not yet revealed. The
   *   overlay goes; the selection stays, and the outline returns when the
   *   element does.
   *
   * Collapsing the second into the first empties the inspector because an
   * animation was halfway through.
   */
  test("bounds names an address and a rectangle, or an address and nothing", () => {
    assert.deepEqual(
      readCanvasMessage(wrap({ type: "canvas.bounds", address: NODE.address, rect: RECT }), {
        bridgeId: BRIDGE,
      }),
      { type: "canvas.bounds", address: NODE.address, rect: RECT },
    );
    assert.deepEqual(
      readCanvasMessage(wrap({ type: "canvas.bounds", address: NODE.address, rect: null }), {
        bridgeId: BRIDGE,
      }),
      { type: "canvas.bounds", address: NODE.address, rect: null },
    );
    assert.equal(
      readCanvasMessage(wrap({ type: "canvas.bounds", address: "div > p", rect: RECT }), { bridgeId: BRIDGE }),
      null,
    );

    // A bounds message never carries a node, so it can never be read as an
    // answer to "what is selected" — only to "where is it".
    const bounds = readCanvasMessage(
      wrap({ type: "canvas.bounds", address: NODE.address, rect: null }),
      { bridgeId: BRIDGE },
    );
    assert.ok(bounds && !("node" in bounds));
  });
});

/* -------------------------------------------------------------------------- */

describe("the canvas reads only what the editor is allowed to say", () => {
  test("ping, select and clear are the whole vocabulary", () => {
    assert.deepEqual(readEditorMessage(wrap({ type: "editor.ping", at: 9 }), { bridgeId: BRIDGE }), {
      type: "editor.ping",
      at: 9,
    });
    assert.deepEqual(
      readEditorMessage(wrap({ type: "editor.select", address: "section:7", scrollIntoView: true }), {
        bridgeId: BRIDGE,
      }),
      { type: "editor.select", address: "section:7", scrollIntoView: true },
    );
    // Absent means no, rather than unknown.
    assert.deepEqual(
      readEditorMessage(wrap({ type: "editor.select", address: "section:7" }), { bridgeId: BRIDGE }),
      { type: "editor.select", address: "section:7", scrollIntoView: false },
    );
    assert.deepEqual(readEditorMessage(wrap({ type: "editor.clearSelection" }), { bridgeId: BRIDGE }), {
      type: "editor.clearSelection",
    });
  });

  test("nothing that writes anything is in it — however plausible it sounds", () => {
    // This batch selects. A canvas that honoured any of these would be editing
    // the page from a message, which is not a thing that exists yet.
    for (const message of [
      { type: "editor.setContent", address: "section:7/field:title", value: "x" },
      { type: "editor.setStyle", address: "section:7", tokens: {} },
      { type: "editor.setMedia", address: "section:7/field:image", mediaId: 3 },
      { type: "editor.reorder", from: 0, to: 1 },
      { type: "editor.delete", address: "section:7" },
      { type: "editor.publish" },
      { type: "editor.save" },
      { type: "canvas.ready" },
      { type: "" },
      { type: 1 },
    ]) {
      assert.equal(readEditorMessage(wrap(message), { bridgeId: BRIDGE }), null, JSON.stringify(message));
    }
  });

  test("a select has to name an address the parser accepts", () => {
    for (const address of ["", "div > p", "field:title", "section:0", "section:7/field:a@ar", 42, null]) {
      assert.equal(
        readEditorMessage(wrap({ type: "editor.select", address, scrollIntoView: true }), {
          bridgeId: BRIDGE,
        }),
        null,
        JSON.stringify(address),
      );
    }
  });

  test("a malformed ping is not a ping", () => {
    for (const message of [
      { type: "editor.ping" },
      { type: "editor.ping", at: "now" },
      { type: "editor.ping", at: -1 },
      { type: "editor.ping", at: 1.5 },
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
