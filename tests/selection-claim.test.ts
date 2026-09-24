/**
 * A selection must never be claimed for a node that was not selected.
 *
 * This is the committed half of a defect found in the browser probes during the
 * review of Batch 12. A probe's `select(address)` helper could only walk
 * *outwards* from whatever a click landed on, and when it never reached the
 * address it had been asked for it fell out of its loop **without a word**. The
 * caller went on to style what happened to be selected — the section root
 * instead of the field inside it — and the damage surfaced three assertions
 * later, a long way from the mistake, as a timeout waiting for a recovery list
 * the application was right not to draw.
 *
 * The probes are not in the repository, so the rule they broke is asserted here
 * instead, against the production vocabulary and the production source:
 *
 *   1. asking for a selection is not the same as getting one, and the protocol
 *      has no acknowledgement that could be mistaken for one;
 *   2. the only report of what is selected carries the address, so a caller can
 *      always tell whether it got what it asked for;
 *   3. a request that cannot be honoured clears the selection rather than
 *      leaving the previous one in place and looking successful;
 *   4. an edit aimed at a field is written at that field's path, never at the
 *      section root that contains it.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { REPO_ROOT } from "./helpers/env";

import { formatNodePath, parseAddress } from "@/lib/cms/address";
import { applyTextAt } from "@/lib/visual-editor/tree";
import { withToken } from "@/lib/visual-editor/style-edit";
import {
  EDITOR_CHANNEL,
  PROTOCOL_VERSION,
  readCanvasMessage,
  readEditorMessage,
} from "@/lib/visual-editor/protocol";

const BRIDGE = "0123456789abcdef0123456789abcdef";
const wrap = (message: unknown) => ({
  channel: EDITOR_CHANNEL,
  v: PROTOCOL_VERSION,
  bridgeId: BRIDGE,
  message,
});

const BRIDGE_SOURCE = readFileSync(
  path.join(REPO_ROOT, "src/components/site/editor-bridge.tsx"),
  "utf8",
);

/* -------------------------------------------------------------------------- */

describe("asking for a selection is not the same as having one", () => {
  test("the canvas has no way to say 'selected' without saying what", () => {
    /**
     * There is no `canvas.selected` or `canvas.ack`, and that absence is the
     * design. The only report of a selection is `canvas.selection`, which
     * carries the node — so "did I get what I asked for" is always answerable
     * by comparing addresses, and can never be answered by the mere arrival of
     * a message.
     */
    for (const type of ["canvas.selected", "canvas.ack", "canvas.ok", "canvas.selectDone"]) {
      assert.equal(
        readCanvasMessage(wrap({ type, address: "section:7/field:title" }), { bridgeId: BRIDGE }),
        null,
        type,
      );
    }
  });

  test("a selection report names the node it is about", () => {
    const message = readCanvasMessage(
      wrap({
        type: "canvas.selection",
        node: {
          address: "section:7/field:title",
          kind: "field",
          sectionId: 7,
          blockType: "quick-links",
          relativePath: "field:title",
        },
        rect: null,
      }),
      { bridgeId: BRIDGE },
    );
    assert.ok(message && message.type === "canvas.selection" && message.node);
    assert.equal(message.node.address, "section:7/field:title");
  });

  test("…and a report whose address and section disagree is refused, not reconciled", () => {
    // Two fields that can disagree are a bug waiting for the day they do, and
    // quietly believing one of them is how a caller ends up told it selected a
    // node in a section it is not in.
    assert.equal(
      readCanvasMessage(
        wrap({
          type: "canvas.selection",
          node: {
            address: "section:7/field:title",
            kind: "field",
            sectionId: 9,
            blockType: "quick-links",
            relativePath: "field:title",
          },
          rect: null,
        }),
        { bridgeId: BRIDGE },
      ),
      null,
    );
    // …and the same for a relative path that is not the address without its
    // section, which is the other way the two halves could drift.
    assert.equal(
      readCanvasMessage(
        wrap({
          type: "canvas.selection",
          node: {
            address: "section:7/field:title",
            kind: "field",
            sectionId: 7,
            blockType: "quick-links",
            relativePath: "field:lead",
          },
          rect: null,
        }),
        { bridgeId: BRIDGE },
      ),
      null,
    );
  });

  test("a request carries one exact address, and a malformed one is not a request", () => {
    const message = readEditorMessage(
      wrap({ type: "editor.select", address: "section:7/field:links/item:i_8Gk3pZmQ2v", scrollIntoView: true }),
      { bridgeId: BRIDGE },
    );
    assert.ok(message && message.type === "editor.select");
    assert.equal(message.address, "section:7/field:links/item:i_8Gk3pZmQ2v");

    for (const address of ["", "section:0/field:title", "section:7/field:title[0]", "field:title", 7]) {
      assert.equal(
        readEditorMessage(wrap({ type: "editor.select", address, scrollIntoView: false }), {
          bridgeId: BRIDGE,
        }),
        null,
        String(address),
      );
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("a request the canvas cannot honour fails closed", () => {
  /**
   * Asserted from the source because it is a property of one branch that no
   * amount of running the application exercises on a machine that behaves: the
   * page either has the address or it does not, and in the build under test it
   * always does.
   */
  const handler = (() => {
    const start = BRIDGE_SOURCE.indexOf('case "editor.select": {');
    assert.ok(start > 0, "the canvas no longer handles editor.select");
    const end = BRIDGE_SOURCE.indexOf('case "editor.clearSelection"', start);
    assert.ok(end > start);
    return BRIDGE_SOURCE.slice(start, end);
  })();

  test("it looks the address up exactly, rather than searching near it", () => {
    assert.match(
      handler,
      /querySelector\(`\[data-eod-address="\$\{message\.address\}"\]`\)/,
      "the canvas resolves a selection request by something other than the address it was given",
    );
    for (const loose of ["closest(", "elementsFromPoint(", "startsWith(", "includes("]) {
      assert.ok(!handler.includes(loose), `the lookup was widened with ${loose}`);
    }
  });

  test("nothing found clears the selection instead of leaving the last one standing", () => {
    assert.match(
      handler,
      /if \(!element\) \{[\s\S]*?setSelection\(null\);[\s\S]*?return;/,
      "a request naming a node this page does not have leaves the previous selection in place, " +
        "which reads to the caller as success",
    );
  });

  test("and every path out of it reports through the one selection message", () => {
    // `setSelection` is what posts `canvas.selection`. A branch that returned
    // without calling it would leave the editor believing whatever it believed
    // before — the silent-success shape this whole file is about.
    const returns = handler.split("return;").length - 1;
    const reports = handler.split("setSelection(").length - 1;
    assert.ok(reports >= 1, "the handler no longer reports what it selected");
    assert.equal(
      returns,
      reports,
      "a branch of editor.select returns without saying what is now selected",
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("an edit aimed at a field never lands on the section that contains it", () => {
  const ROW = "i_8Gk3pZmQ2v";

  test("a style written for a field is stored under that field's path", () => {
    // The concrete shape of the probe defect: the target was
    // `field:title` and what actually got hidden was `root`.
    const document = withToken({ v: 1, nodes: {} }, "field:title", "base", "hidden", true);
    assert.deepEqual(Object.keys(document.nodes), ["field:title"]);
    assert.ok(!("root" in document.nodes), "a field's override was written onto the section root");
  });

  test("…and one written for a row lands on the row, by its `_id`", () => {
    const document = withToken(
      { v: 1, nodes: {} },
      `field:links/item:${ROW}`,
      "base",
      "hidden",
      true,
    );
    assert.deepEqual(Object.keys(document.nodes), [`field:links/item:${ROW}`]);
  });

  test("text typed into a field is written into that field, not into its parent", () => {
    const values = {
      title: { en: "Where to next", ar: "" },
      links: [{ _id: ROW, label: { en: "Travel", ar: "" }, href: "/travel" }],
    };
    const next = applyTextAt(values, "quick-links", `field:links/item:${ROW}/field:label`, "en", "Tours")!;
    assert.deepEqual((next.links as Record<string, unknown>[])[0]!.label, { en: "Tours", ar: "" });
    assert.deepEqual(next.title, { en: "Where to next", ar: "" }, "a sibling field was written");
  });

  test("an address that names a section root is not a text target at all", () => {
    // A section has no text of its own, so a request to type into one is
    // refused rather than being applied to the first field inside it.
    const values = { title: { en: "Where to next", ar: "" } };
    assert.equal(applyTextAt(values, "quick-links", "root", "en", "Nope"), null);

    const parsed = parseAddress("section:7");
    assert.ok(parsed);
    assert.equal(formatNodePath(parsed.path), "root");
    // …and the protocol refuses to carry one, so it cannot reach the editor.
    assert.equal(
      readCanvasMessage(wrap({ type: "canvas.edit", address: "section:7", phase: "commit", text: "Nope" }), {
        bridgeId: BRIDGE,
      }),
      null,
    );
  });
});
