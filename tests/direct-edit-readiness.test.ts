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
import {
  acceptEdit,
  type DirectEditSession,
  type EditorContext,
  type IncomingEdit,
} from "@/lib/visual-editor/direct-edit";

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
    // The decision moved into `acceptEdit`, which compares the token, the
    // address, the section and the whole editor context — and is asserted
    // directly below. What is asserted here is that the handler abides by it
    // and has kept no opinion of its own.
    assert.match(apply, /const verdict = acceptEdit\(/);
    assert.match(apply, /if \(!verdict\.ok\) \{/);
    assert.ok(
      !/session\.token !== edit\.token/.test(apply),
      "the handler still carries its own copy of the rule",
    );
  });

  test("cancel restores the value the session started from", () => {
    // Decided by the guard, which hands back `session.started` for a cancel.
    const session: DirectEditSession = {
      token: 1, address: "section:4/field:title", sectionId: 4,
      pageId: 2, locale: "en", canvasKey: 0, started: "Original",
    };
    const verdict = acceptEdit(
      session,
      { pageId: 2, locale: "en", canvasKey: 0 },
      { address: "section:4/field:title", token: 1, phase: "cancel", text: "typed then abandoned" },
    );
    assert.ok(verdict.ok);
    assert.equal(verdict.text, "Original");
    assert.match(apply, /verdict\.text/, "the handler writes something other than the verdict's text");
  });

  test("…and never queues a write for it", () => {
    assert.match(apply, /if \(edit\.phase !== "cancel"\) scheduleAutosave\(verdict\.sectionId\);/);
  });

  test("a commit goes through the existing buffer and autosave, and nothing else", () => {
    assert.match(apply, /writeBuffers\(/);
    assert.match(apply, /scheduleAutosave\(verdict\.sectionId\)/);
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

/* -------------------------------------------------------------------------- */

describe("a message is only applied in the context its session was opened in", () => {
  /**
   * The race this closes: the session used to be identified by token and
   * address alone, and the text was then written using whatever language the
   * editor was showing *now*. Between React rendering a new page, language or
   * canvas and the effect that cancels the session actually running, a message
   * from the old session passed that check and was applied under the new
   * context — an English edit written into `.ar`, a page the editor had left
   * made dirty and queued for saving.
   *
   * These ask the rule directly rather than driving the component, because the
   * rule is the valuable part and it has to hold synchronously, before any
   * cleanup has had a chance to run.
   */
  const SESSION: DirectEditSession = {
    token: 7,
    address: "section:21/field:headline",
    sectionId: 21,
    pageId: 3,
    locale: "en",
    canvasKey: 5,
    started: "Where it began",
  };
  const HERE: EditorContext = { pageId: 3, locale: "en", canvasKey: 5 };
  const TYPED: IncomingEdit = {
    address: "section:21/field:headline",
    token: 7,
    phase: "input",
    text: "Being typed",
  };

  test("the session carries the page, the language, the canvas and the section", () => {
    // Everything the guard compares has to be *on* the session; a field it does
    // not carry is a field it cannot check.
    for (const key of ["token", "address", "sectionId", "pageId", "locale", "canvasKey", "started"] as const) {
      assert.ok(key in SESSION, `a session does not carry ${key}`);
    }
    assert.equal(typeof SESSION.pageId, "number");
    assert.equal(typeof SESSION.canvasKey, "number");
    assert.equal(SESSION.locale, "en");
    assert.equal(SESSION.sectionId, 21);
  });

  test("a message from the live session, in its own context, is accepted", () => {
    const verdict = acceptEdit(SESSION, HERE, TYPED);
    assert.equal(verdict.ok, true);
    assert.ok(verdict.ok);
    assert.equal(verdict.sectionId, 21);
    assert.equal(verdict.relativePath, "field:headline");
    assert.equal(verdict.locale, "en");
    assert.equal(verdict.text, "Being typed");
    assert.equal(verdict.ends, false, "typing ended the session");
  });

  test("…and a commit or a cancel ends it, where typing does not", () => {
    assert.equal((acceptEdit(SESSION, HERE, { ...TYPED, phase: "commit" }) as { ends: boolean }).ends, true);
    const cancelled = acceptEdit(SESSION, HERE, { ...TYPED, phase: "cancel", text: "abandoned" });
    assert.ok(cancelled.ok);
    assert.equal(cancelled.ends, true);
    assert.equal(cancelled.text, "Where it began", "cancel did not restore the starting value");
  });

  test("no session at all, a stale token, or another node", () => {
    assert.deepEqual(acceptEdit(null, HERE, TYPED), { ok: false, reason: "no-session" });
    assert.deepEqual(acceptEdit(SESSION, HERE, { ...TYPED, token: 6 }), { ok: false, reason: "token" });
    assert.deepEqual(acceptEdit(SESSION, HERE, { ...TYPED, token: 8 }), { ok: false, reason: "token" });
    assert.deepEqual(acceptEdit(SESSION, HERE, { ...TYPED, address: "section:21/field:lead" }), {
      ok: false,
      reason: "address",
    });
  });

  test("an address that does not parse, or names another section", () => {
    // The equality check comes first, so a *different* address is refused as
    // one — reaching the parser needs a session whose own address is the thing
    // that cannot be a node.
    assert.deepEqual(acceptEdit(SESSION, HERE, { ...TYPED, address: "section:21" }), {
      ok: false,
      reason: "address",
    });
    const rooted: DirectEditSession = { ...SESSION, address: "section:21" };
    assert.deepEqual(acceptEdit(rooted, HERE, { ...TYPED, address: "section:21" }), {
      ok: false,
      reason: "unparsable",
    });
    // The session and its own address disagreeing is a bug, not a race, and is
    // refused rather than reconciled.
    const crossed: DirectEditSession = { ...SESSION, sectionId: 22 };
    assert.deepEqual(acceptEdit(crossed, HERE, TYPED), { ok: false, reason: "section" });
  });

  test("the editor has moved to another page", () => {
    assert.deepEqual(acceptEdit(SESSION, { ...HERE, pageId: 4 }, TYPED), { ok: false, reason: "page" });
    assert.deepEqual(acceptEdit(SESSION, { ...HERE, pageId: null }, TYPED), { ok: false, reason: "page" });
  });

  test("the editor has switched language", () => {
    assert.deepEqual(acceptEdit(SESSION, { ...HERE, locale: "ar" }, TYPED), { ok: false, reason: "locale" });
    const arabic: DirectEditSession = { ...SESSION, locale: "ar" };
    assert.deepEqual(acceptEdit(arabic, { ...HERE, locale: "en" }, TYPED), { ok: false, reason: "locale" });
  });

  test("the canvas document has been replaced, even with everything else identical", () => {
    // Same page, same language, same address, same section, same token: the
    // canvas alone is different, and that is enough on its own.
    assert.deepEqual(acceptEdit(SESSION, { ...HERE, canvasKey: 6 }, TYPED), { ok: false, reason: "canvas" });
  });

  test("a stale English message can never be written as Arabic", () => {
    // The editor is now showing Arabic; the message belongs to the English
    // session that was open a moment ago.
    const verdict = acceptEdit(SESSION, { ...HERE, locale: "ar" }, TYPED);
    assert.equal(verdict.ok, false);
    assert.ok(!verdict.ok && verdict.reason === "locale");
  });

  test("…and a stale Arabic message can never be written as English", () => {
    const arabic: DirectEditSession = { ...SESSION, locale: "ar", started: "بدأ هنا" };
    const verdict = acceptEdit(arabic, HERE, { ...TYPED, text: "مكتوب" });
    assert.equal(verdict.ok, false);
    assert.ok(!verdict.ok && verdict.reason === "locale");
  });

  test("an accepted message is interpreted in the session's language, not the editor's", () => {
    // The one case where the two can legitimately differ is none: acceptance
    // requires them equal. What matters is that the verdict names the
    // session's, so the caller cannot reach for the current one by habit.
    const arabic: DirectEditSession = { ...SESSION, locale: "ar" };
    const verdict = acceptEdit(arabic, { ...HERE, locale: "ar" }, TYPED);
    assert.ok(verdict.ok);
    assert.equal(verdict.locale, "ar");
  });

  test("a stale message from a page the editor has left is refused before anything is written", () => {
    /**
     * The shape of the accident: buffers survive a page change on purpose, so
     * Page A's buffer is still there to be dirtied and autosaved by a keystroke
     * that belongs to a canvas nobody is looking at.
     */
    const onPageB: EditorContext = { pageId: 9, locale: "en", canvasKey: 5 };
    for (const phase of ["input", "commit", "cancel"] as const) {
      const verdict = acceptEdit(SESSION, onPageB, { ...TYPED, phase });
      assert.equal(verdict.ok, false, phase);
      assert.ok(!verdict.ok && verdict.reason === "page", phase);
    }
  });

  test("every rejection is a refusal to act, never a partial answer", () => {
    // A rejected verdict carries nothing a caller could write with: no section,
    // no text, no locale. It cannot be half-applied by accident.
    for (const context of [
      { ...HERE, pageId: 4 },
      { ...HERE, locale: "ar" as const },
      { ...HERE, canvasKey: 99 },
    ]) {
      const verdict = acceptEdit(SESSION, context, TYPED);
      assert.equal(verdict.ok, false);
      assert.deepEqual(Object.keys(verdict).sort(), ["ok", "reason"]);
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("the handler acts on the verdict and on nothing else", () => {
  const handler = bodyOf(code(SHELL_SOURCE), "const onCanvasEdit = useCallback(");

  test("it asks the guard before it touches a buffer", () => {
    const asked = handler.indexOf("acceptEdit(");
    const writes = handler.indexOf("writeBuffers(");
    assert.ok(asked > 0, "the handler no longer consults the guard");
    assert.ok(writes > asked, "a buffer is written before the context is checked");
    assert.match(handler, /if \(!verdict\.ok\) \{/, "a rejected verdict is not handled");
  });

  test("it passes the whole current context, from refs read at that moment", () => {
    assert.match(
      handler,
      /\{ pageId: pageRef\.current, locale: localeRef\.current, canvasKey: canvasKeyRef\.current \}/,
      "the guard is given something other than the editor's current context",
    );
  });

  test("it writes with the session's language, never the editor's", () => {
    assert.match(handler, /verdict\.locale/, "the write does not use the verdict's language");
    const write = handler.slice(handler.indexOf("applyTextAt("));
    assert.ok(
      !write.includes("localeRef.current"),
      "the write still reaches for the editor's current language",
    );
  });

  test("a rejected message schedules nothing and reports nothing", () => {
    const rejected = handler.slice(handler.indexOf("if (!verdict.ok)"), handler.indexOf("if (verdict.ends)"));
    for (const effect of ["scheduleAutosave", "setLoadError", "writeBuffers", "contentDirty"]) {
      assert.ok(!rejected.includes(effect), `a rejected message still does ${effect}`);
    }
  });

  test("a cancel still writes the restored value and still queues nothing", () => {
    assert.match(handler, /if \(edit\.phase !== "cancel"\) scheduleAutosave\(verdict\.sectionId\);/);
  });

  test("the session is bound to the context the request validated, not re-read later", () => {
    const request = bodyOf(code(SHELL_SOURCE), "const requestDirectEdit = useCallback(");
    const bind = request.slice(request.indexOf("editSession.current = {"));
    assert.match(bind, /pageId: pageAtRequest/);
    assert.match(bind, /locale: localeAtRequest/);
    assert.match(bind, /canvasKey: canvasAtRequest/);
    for (const reread of ["pageId: pageRef.current", "locale: localeRef.current", "canvasKey: canvasKeyRef.current"]) {
      assert.ok(!bind.includes(reread), `the session re-reads ${reread} instead of keeping what it checked`);
    }
  });

  test("the session holds no DOM node and no markup", () => {
    const source = code(read("src/lib/visual-editor/direct-edit.ts"));
    for (const banned of ["HTMLElement", "innerHTML", "outerHTML", "querySelector"]) {
      assert.ok(!source.includes(banned), `the session type mentions ${banned}`);
    }
    // …and the bridge id is not part of it: it correlates documents, it does
    // not authorise anything.
    assert.ok(!source.includes("bridgeId"), "the session treats the bridge id as identity");
  });
});
