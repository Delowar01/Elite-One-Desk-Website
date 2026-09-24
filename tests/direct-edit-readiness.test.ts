/**
 * Direct editing may not begin until the row that will own it is loaded.
 *
 * The defect this exists for shipped in Batch 13. A double-click made a canvas
 * node editable on the spot, and two things followed from that:
 *
 *   · the shell dropped whatever was typed if no `SectionBuffer` happened to
 *     exist yet — text on screen that nothing was ever going to save; and
 *   · the text being edited came from the DOM, so an Arabic node with no
 *     translation began editing with the English fallback the page had
 *     rendered. Committing wrote that English back into the Arabic field, and
 *     with it the text of every annotated child inside the same element:
 *     measured, an empty `.ar` headline became
 *     "سفر.\nسفر., أعمال., خدمات حكومية.\n\nUntranslated headline" without a
 *     single keystroke.
 *
 * The correction is a request → ready → begin flow. The canvas asks; the editor
 * loads the section, reads the value out of that row and answers with the text
 * to begin from and a token for the session.
 *
 * Most of this is client behaviour, so most of it is asserted here from the
 * protocol and from the source — the same way Batch 12's revision/value pairing
 * is. What runs against a server is in `layers-editing.test.ts`, and the
 * browser half is the `layers-editing` probe.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { REPO_ROOT } from "./helpers/env";

import {
  EDITOR_CHANNEL,
  PROTOCOL_VERSION,
  readCanvasMessage,
  readEditorMessage,
} from "@/lib/visual-editor/protocol";
import { textAt } from "@/lib/visual-editor/tree";

const BRIDGE = "0123456789abcdef0123456789abcdef";
const wrap = (message: unknown) => ({
  channel: EDITOR_CHANNEL,
  v: PROTOCOL_VERSION,
  bridgeId: BRIDGE,
  message,
});

const read = (file: string) => readFileSync(path.join(REPO_ROOT, file), "utf8");
const BRIDGE_SOURCE = read("src/components/site/editor-bridge.tsx");
const SHELL_SOURCE = read("src/components/admin/visual-editor/shell.tsx");

/** Source with its prose removed, so a comment is never read as code. */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");

/**
 * Everything a declaration owns, up to the next one at its own indentation.
 *
 * Not brace matching from the first `{`: for `useCallback((edit: { … }) => …)`
 * the first brace opens an inline *type literal*, and matching it returns the
 * parameter's type rather than the function. Indentation is the reliable
 * boundary here — the shell's are at two spaces, the canvas bridge's are nested
 * inside its effect at four — so the depth is taken from the declaration itself
 * rather than assumed.
 */
function bodyOf(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} is no longer in the source`);
  const lineStart = source.lastIndexOf("\n", start) + 1;
  const indent = source.slice(lineStart, start).length;
  const rest = source.slice(start + declaration.length);
  const next = rest.search(new RegExp(`\\n {${indent}}(?:const|function|useEffect\\(|return|\\})`));
  return declaration + (next === -1 ? rest : rest.slice(0, next));
}

/* -------------------------------------------------------------------------- */

describe("the vocabulary makes asking and beginning two different things", () => {
  test("this build speaks version 4", () => {
    assert.equal(PROTOCOL_VERSION, 4);
  });

  test("a canvas may ask to edit, and asking carries nothing but the address", () => {
    const message = readCanvasMessage(
      wrap({ type: "canvas.editRequest", address: "section:7/field:headline" }),
      { bridgeId: BRIDGE },
    );
    assert.deepEqual(message, { type: "canvas.editRequest", address: "section:7/field:headline" });

    // No text, no markup, no instruction to the editor about what to do.
    assert.deepEqual(Object.keys(message!), ["type", "address"]);

    for (const address of ["section:7", "", "field:headline", "section:7/field:x[0]", 7]) {
      assert.equal(
        readCanvasMessage(wrap({ type: "canvas.editRequest", address }), { bridgeId: BRIDGE }),
        null,
        String(address),
      );
    }
  });

  test("only the editor may say begin, and it must supply the text and a token", () => {
    const begin = readEditorMessage(
      wrap({ type: "editor.editBegin", address: "section:7/field:headline", token: 3, text: "Hello" }),
      { bridgeId: BRIDGE },
    );
    assert.deepEqual(begin, {
      type: "editor.editBegin",
      address: "section:7/field:headline",
      token: 3,
      text: "Hello",
    });

    // Fail closed on every missing or wrong-typed part.
    for (const broken of [
      { address: "section:7/field:headline", token: 3 },
      { address: "section:7/field:headline", text: "Hello" },
      { address: "section:7/field:headline", token: "3", text: "Hello" },
      { address: "section:7", token: 3, text: "Hello" },
      { address: "section:7/field:headline", token: -1, text: "Hello" },
      { address: "section:7/field:headline", token: 3, text: 5 },
    ]) {
      assert.equal(
        readEditorMessage(wrap({ type: "editor.editBegin", ...broken }), { bridgeId: BRIDGE }),
        null,
        JSON.stringify(broken),
      );
    }
  });

  test("a cancel names the session it is cancelling", () => {
    assert.deepEqual(
      readEditorMessage(wrap({ type: "editor.editCancel", token: 9 }), { bridgeId: BRIDGE }),
      { type: "editor.editCancel", token: 9 },
    );
    assert.equal(readEditorMessage(wrap({ type: "editor.editCancel" }), { bridgeId: BRIDGE }), null);
  });

  test("the old command that let the canvas begin on its own is gone", () => {
    // `editor.edit {active: true}` was how Batch 13 told the canvas to start.
    // A message type is recognised by being listed, so this is now silence.
    assert.equal(
      readEditorMessage(
        wrap({ type: "editor.edit", address: "section:7/field:headline", active: true }),
        { bridgeId: BRIDGE },
      ),
      null,
    );
  });

  test("what comes back from an edit is tokened, and has no 'start' phase", () => {
    const input = readCanvasMessage(
      wrap({ type: "canvas.edit", address: "section:7/field:headline", token: 2, phase: "input", text: "hi" }),
      { bridgeId: BRIDGE },
    );
    assert.ok(input && input.type === "canvas.edit" && input.token === 2);

    // `start` belonged to the canvas deciding it had started. It cannot now.
    assert.equal(
      readCanvasMessage(
        wrap({ type: "canvas.edit", address: "section:7/field:headline", token: 2, phase: "start", text: "" }),
        { bridgeId: BRIDGE },
      ),
      null,
    );
    // …and a message with no session is not a message.
    assert.equal(
      readCanvasMessage(
        wrap({ type: "canvas.edit", address: "section:7/field:headline", phase: "commit", text: "hi" }),
        { bridgeId: BRIDGE },
      ),
      null,
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("the canvas asks; it does not decide", () => {
  const dblclick = bodyOf(code(BRIDGE_SOURCE), "const onDoubleClick =");

  test("a double-click posts a request and changes nothing", () => {
    assert.match(dblclick, /post\(\{ type: "canvas\.editRequest", address \}\)/);
    for (const mutation of ["contenteditable", "textContent", "focus(", "beginEditing("]) {
      assert.ok(!dblclick.includes(mutation), `a double-click still does ${mutation}`);
    }
  });

  test("a locked node is not even asked about", () => {
    assert.match(dblclick, /if \(isLocked\(address\)\) return;/);
  });

  test("becoming editable happens in one place, reached only by the editor's instruction", () => {
    const source = code(BRIDGE_SOURCE);
    const sets = [...source.matchAll(/setAttribute\("contenteditable"/g)];
    assert.equal(sets.length, 1, `${sets.length} places make a node editable`);
    const begin = bodyOf(source, "const beginEditing =");
    assert.ok(begin.includes('setAttribute("contenteditable"'), "the one place is not beginEditing");

    // Its declaration reads `beginEditing = (`, so every match here is a call.
    const callers = [...source.matchAll(/beginEditing\(/g)];
    assert.equal(callers.length, 1, `beginEditing is called from ${callers.length} places`);
    assert.match(source, /case "editor\.editBegin":\s*beginEditing\(message\.address, message\.token, message\.text\);/);
  });

  test("it begins from the text it was handed, not from the page", () => {
    const begin = bodyOf(code(BRIDGE_SOURCE), "const beginEditing =");
    assert.match(begin, /element\.textContent = text;/, "the supplied text is not put on screen");
    assert.ok(
      !/before:\s*textOf\(/.test(begin),
      "the session still remembers what the page had rendered rather than what it was given",
    );
    assert.match(begin, /before: text/, "cancel would not restore the value the session began with");
  });
});

/* -------------------------------------------------------------------------- */

describe("the editor loads the row before it allows a keystroke", () => {
  const request = bodyOf(code(SHELL_SOURCE), "const requestDirectEdit = useCallback(");

  test("one entry path, used by both gestures", () => {
    assert.match(SHELL_SOURCE, /onEditText=\{requestDirectEdit\}/, "Layers uses a different path");
    assert.match(SHELL_SOURCE, /onEditRequest=\{requestDirectEdit\}/, "the canvas uses a different path");
    assert.ok(!SHELL_SOURCE.includes("startCanvasEdit"), "the old second implementation is still here");
  });

  test("it awaits the buffer, and only then says begin", () => {
    const awaited = request.indexOf("await ensureSectionBuffer(");
    const begins = request.indexOf('setEditRequest({ kind: "begin"');
    assert.ok(awaited > 0, "the readiness path no longer loads the section");
    assert.ok(begins > awaited, "editing is allowed to begin before the row is loaded");
  });

  test("everything that could have moved on is re-checked after the load", () => {
    const after = request.slice(request.indexOf("await ensureSectionBuffer("));
    for (const [what, pattern] of [
      ["a newer request", /editToken\.current !== token/],
      ["a page change", /pageRef\.current !== pageAtRequest/],
      ["a language change", /localeRef\.current !== localeAtRequest/],
      ["a canvas reload", /canvasKeyRef\.current !== canvasAtRequest/],
      ["a failed load", /if \(!buffer\) return;/],
      ["a conflict", /buffer\.status === "conflict"/],
      ["an uneditable node", /!directEditAt\(/],
    ] as const) {
      assert.match(after, pattern, `${what} does not cancel a pending edit`);
    }
  });

  test("the text it hands over is read from the buffer, never from the canvas", () => {
    assert.match(
      request,
      /textAt\(buffer\.values, buffer\.data\.blockType, relative, localeAtRequest\)/,
      "the seed is not the row's own value",
    );
    for (const dom of ["innerText", "textContent", "querySelector", "getAttribute"]) {
      assert.ok(!request.includes(dom), `the readiness path reads ${dom} from the page`);
    }
  });

  test("and that helper reads the edition being edited, with no fallback", () => {
    // The behaviour the seed depends on, stated here too because this is the
    // defect's centre: a rendered Arabic heading falls back to English, and the
    // value does not.
    const values = { headline: { en: "Untranslated headline", ar: "" } };
    assert.equal(textAt(values, "hero", "field:headline", "ar"), "");
    assert.equal(textAt(values, "hero", "field:headline", "en"), "Untranslated headline");
  });

  test("a session is cancelled when the page, the language or the canvas changes", () => {
    const effect = code(SHELL_SOURCE).slice(code(SHELL_SOURCE).indexOf("editToken.current += 1;"));
    assert.match(effect, /setEditRequest\(\{ kind: "cancel", token: session\.token \}\)/);
    assert.match(effect, /\}, \[page, locale, canvasKey\]\);/, "the cancellation watches the wrong things");
  });
});

/* -------------------------------------------------------------------------- */

describe("what comes back is applied only to the session that asked for it", () => {
  const apply = bodyOf(code(SHELL_SOURCE), "const onCanvasEdit = useCallback(");

  test("a message from a superseded session, or another node, is ignored", () => {
    assert.match(
      apply,
      /if \(!session \|\| session\.token !== edit\.token \|\| session\.address !== edit\.address\) return;/,
      "a late message can still write into whatever is selected now",
    );
  });

  test("cancel restores the value the session started from", () => {
    assert.match(apply, /edit\.phase === "cancel" \? session\.started : edit\.text/);
  });

  test("…and never queues a write for it", () => {
    assert.match(apply, /if \(edit\.phase !== "cancel"\) scheduleAutosave\(sectionId\);/);
  });

  test("a commit goes through the existing buffer and autosave, and nothing else", () => {
    assert.match(apply, /writeBuffers\(/);
    assert.match(apply, /scheduleAutosave\(sectionId\)/);
    for (const banned of ["saveVisualSectionDraft", "fetch(", "loadVisualSection"]) {
      assert.ok(!apply.includes(banned), `the edit path calls ${banned} directly`);
    }
  });

  test("a section in conflict is not written to", () => {
    assert.match(apply, /if \(entry\.status === "conflict"\) return prev;/);
  });
});

/* -------------------------------------------------------------------------- */

describe("one section is loaded once, whoever asked", () => {
  const ensure = bodyOf(code(SHELL_SOURCE), "const ensureSectionBuffer = useCallback(");

  test("a buffer already held is handed back without a request", () => {
    assert.match(ensure, /const held = buffersRef\.current\[sectionId\];\s*if \(held\) return Promise\.resolve\(held\);/);
  });

  test("a load already in flight is shared rather than repeated", () => {
    assert.match(ensure, /const already = inflight\.current\.get\(sectionId\);\s*if \(already\) return already;/);
    assert.match(ensure, /inflight\.current\.set\(sectionId, load\);/);
  });

  test("it is the only place the application loads a section", () => {
    const calls = [...code(SHELL_SOURCE).matchAll(/loadVisualSection\(/g)];
    // The import, and the one call inside this primitive.
    assert.equal(calls.length, 1, `${calls.length} call sites load a section`);
    assert.ok(ensure.includes("loadVisualSection("), "the one call site is not inside ensureSectionBuffer");
  });

  test("a failure stays retryable and installs nothing", () => {
    assert.match(ensure, /inflight\.current\.delete\(sectionId\);/);
    assert.match(ensure, /if \(!result\.ok\) \{[\s\S]*?return null;/);
  });

  test("an answer that arrives after the page moved on is discarded", () => {
    assert.match(ensure, /if \(pageRef\.current !== pageId\) return null;/);
  });

  test("it never overwrites a buffer somebody is already typing into", () => {
    assert.match(ensure, /const existing = prev\[sectionId\];\s*if \(existing\) \{[\s\S]*?return prev;/);
  });

  test("and it invents nothing — no placeholder revision, no canvas-built buffer", () => {
    assert.match(ensure, /data: result\.section/);
    assert.match(ensure, /values: result\.section\.values/);
    for (const invented of ["revision: 0", "revision: 1", "innerText", "textContent"]) {
      assert.ok(!ensure.includes(invented), `the loader invents ${invented}`);
    }
  });
});
