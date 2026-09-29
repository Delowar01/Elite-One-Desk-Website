/**
 * The granular permission model as data (Batch 18) — no database, no server.
 *
 * What each capability needs, which operations need several at once, the
 * advanced style vocabulary and the comparison that enforces it, and the
 * places in the code that must ask. The behaviour of every one of these
 * against the running application is `permissions-granular.test.ts`; the
 * upgrade is `permissions-migration.test.ts`.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { REPO_ROOT } from "./helpers/env";

import {
  allOf,
  AUTHORITY,
  CAPABILITIES,
  capabilitiesOf,
  COMPOUND,
  DENIED,
  deniedCapability,
  may,
} from "@/lib/auth/authority";
import { PERMISSIONS, requirementKeys, satisfies, type PermissionKey } from "@/lib/auth/permissions";
import { REUSE_AUTHORITY } from "@/lib/cms/reuse/authority";
import { sameReuse } from "@/lib/cms/reuse/reference";
import {
  ADVANCED_STYLE_TOKENS,
  advancedStylesDiffer,
  isAdvancedToken,
  STYLE_TOKEN_KEYS,
  validateStyleDocument,
} from "@/lib/cms/styles";
import { withoutBranch } from "@/lib/visual-editor/style-edit";

const source = (file: string) => readFileSync(path.join(REPO_ROOT, file), "utf8");
const held = (...keys: PermissionKey[]) => new Set<string>(keys);

describe("1 · the catalogue names the required capabilities, and keeps the legacy key", () => {
  test("every key the brief names exists, grouped where an owner will look for it", () => {
    const group = (key: string) => PERMISSIONS.find((entry) => entry.key === key)?.group;
    for (const key of [
      "content.view", "visual_editor.view", "content.edit", "content.style", "content.advanced_style",
      "content.motion", "content.structure", "content.publish",
    ]) {
      assert.equal(group(key), "Content", key);
    }
    for (const key of ["components.view", "components.edit", "components.publish", "components.lifecycle"]) {
      assert.equal(group(key), "Reusable components", key);
    }
    for (const key of ["navigation.manage", "settings.manage", "media.manage", "users.manage", "roles.manage"]) {
      assert.ok(group(key), `${key} left the catalogue`);
    }
    assert.equal(group("content.manage"), "Legacy");
    const keys = PERMISSIONS.map((entry) => entry.key);
    assert.equal(new Set(keys).size, keys.length, "a key appears twice");
    for (const entry of PERMISSIONS) assert.ok(entry.label.length <= 128 && entry.group.length <= 64, entry.key);
  });
});

describe("4 · one table decides every capability, through satisfies()", () => {
  test("each capability needs exactly these keys", () => {
    assert.deepEqual(AUTHORITY, {
      viewPages: "content.view",
      openEditor: { all: ["content.view", "visual_editor.view"] },
      editContent: { all: ["content.view", "content.edit"] },
      editStyle: { all: ["content.view", "content.style"] },
      editAdvancedStyle: { all: ["content.view", "content.style", "content.advanced_style"] },
      editMotion: { all: ["content.view", "content.motion"] },
      editStructure: { all: ["content.view", "content.structure"] },
      publish: { all: ["content.view", "content.publish"] },
      viewComponents: "components.view",
      editComponents: { all: ["components.view", "components.edit"] },
      publishComponents: { all: ["components.view", "components.publish"] },
      componentLifecycle: { all: ["components.view", "components.lifecycle"] },
    });
  });

  test("13 · an operation with several effects needs every one of them", () => {
    const keys = (name: keyof typeof COMPOUND) => requirementKeys(COMPOUND[name]).sort();
    assert.deepEqual(keys("reuseInstance"), ["components.view", "content.edit", "content.view"]);
    assert.deepEqual(keys("addReusableSection"), ["components.view", "content.edit", "content.structure", "content.view"]);
    assert.deepEqual(keys("saveAsReusableDraft"), ["components.edit", "components.view", "content.view"]);
    assert.deepEqual(keys("saveAsReusablePublished"), ["components.edit", "components.publish", "components.view", "content.edit", "content.view"]);
    assert.deepEqual(keys("createPublishedComponent"), ["components.edit", "components.publish", "components.view"]);
    assert.deepEqual(keys("saveAndPublish"), ["content.edit", "content.publish", "content.view"]);
    assert.deepEqual(keys("renamePage"), ["content.edit", "content.publish", "content.view"]);
    assert.deepEqual(keys("createPage"), ["content.edit", "content.structure", "content.view"]);
    assert.deepEqual(keys("deletePage"), ["content.publish", "content.structure", "content.view"]);
    assert.deepEqual(keys("previewComponent"), ["components.view", "content.view"]);
    // Every compound is an all-of: a write is never an any-of.
    for (const need of Object.values(COMPOUND)) assert.ok(typeof need === "object" && "all" in need);
    assert.deepEqual(requirementKeys(allOf("editStyle", "editStyle")).sort(), ["content.style", "content.view"]);
  });

  test("the reusable-component operations are that table's, never settings.manage or content.manage", () => {
    assert.deepEqual(REUSE_AUTHORITY, {
      view: AUTHORITY.viewComponents,
      instances: COMPOUND.reuseInstance,
      edit: AUTHORITY.editComponents,
      publish: AUTHORITY.publishComponents,
      restore: AUTHORITY.editComponents,
      lifecycle: AUTHORITY.componentLifecycle,
    });
    const every = [...Object.values(AUTHORITY), ...Object.values(COMPOUND)].flatMap((need) => requirementKeys(need));
    for (const forbidden of ["content.manage", "settings.manage", "navigation.manage"]) {
      assert.ok(!every.includes(forbidden as PermissionKey), `${forbidden} decides a page capability`);
    }
  });

  test("11 · mixed roles get exactly the capabilities their keys add up to", () => {
    const base: PermissionKey[] = ["content.view", "visual_editor.view"];
    const cases: [string, PermissionKey[], string[]][] = [
      ["viewer", base, ["viewPages", "openEditor"]],
      ["content only", [...base, "content.edit"], ["viewPages", "openEditor", "editContent"]],
      ["style only", [...base, "content.style"], ["viewPages", "openEditor", "editStyle"]],
      ["advanced stylist", [...base, "content.style", "content.advanced_style"], ["viewPages", "openEditor", "editStyle", "editAdvancedStyle"]],
      ["advanced key alone", [...base, "content.advanced_style"], ["viewPages", "openEditor"]],
      ["motion", [...base, "content.motion"], ["viewPages", "openEditor", "editMotion"]],
      ["layout", [...base, "content.structure"], ["viewPages", "openEditor", "editStructure"]],
      ["publisher", [...base, "content.publish"], ["viewPages", "openEditor", "publish"]],
      ["component editor", ["components.view", "components.edit"], ["viewComponents", "editComponents"]],
      ["component publisher", ["components.view", "components.publish"], ["viewComponents", "publishComponents"]],
      ["legacy key only", [...base, "content.manage"], ["viewPages", "openEditor"]],
      ["writes without the view key", ["content.edit", "content.publish", "components.edit"], []],
    ];
    for (const [name, keys, expected] of cases) {
      const answers = capabilitiesOf(held(...keys));
      assert.deepEqual(
        CAPABILITIES.filter((capability) => answers[capability]).sort(),
        expected.sort(),
        name,
      );
      for (const capability of CAPABILITIES) {
        assert.equal(may(held(...keys), capability), satisfies(held(...keys), AUTHORITY[capability]));
      }
    }
    assert.deepEqual(capabilitiesOf(held(...PERMISSIONS.map((entry) => entry.key))), Object.fromEntries(CAPABILITIES.map((c) => [c, true])));
  });

  test("a refusal names its capability in words, and reads back to it", () => {
    for (const capability of CAPABILITIES) {
      assert.match(DENIED[capability], /does not allow/);
      assert.equal(deniedCapability(DENIED[capability]), capability);
    }
    for (const name of Object.keys(COMPOUND) as (keyof typeof COMPOUND)[]) {
      assert.equal(deniedCapability(DENIED[name]), null, `${name} names several capabilities and must not be read as one`);
    }
    assert.equal(deniedCapability("This form expired. Reload the page and try again."), null);
    assert.equal(deniedCapability(undefined), null);
  });
});

describe("5 · the advanced style vocabulary, and the comparison the server makes", () => {
  test("advanced is exactly Batch 14's layout half; every other token is standard", () => {
    assert.deepEqual([...ADVANCED_STYLE_TOKENS], [
      "width", "height", "minHeight", "layout", "direction", "wrap", "justify", "alignItems", "columns", "overflow", "glow",
    ]);
    for (const token of STYLE_TOKEN_KEYS) {
      assert.equal(isAdvancedToken(token), (ADVANCED_STYLE_TOKENS as readonly string[]).includes(token), token);
    }
    for (const standard of ["align", "fontSize", "textColor", "background", "padBlock", "gap", "radius", "shadow", "opacity", "maxWidth", "hidden"]) {
      assert.equal(isAdvancedToken(standard), false, standard);
    }
  });

  test("17 · any change to an advanced token, anywhere, is a difference — a standard change is not", () => {
    const base = { v: 1, nodes: { root: { base: { width: "half", textColor: "muted" }, tablet: { layout: "grid", columns: 2 } } } };
    assert.equal(advancedStylesDiffer(base, { v: 1, nodes: { root: { tablet: { columns: 2, layout: "grid" }, base: { textColor: "strong", width: "half", padBlock: 4 } } } }), false, "order and standard tokens");
    assert.equal(advancedStylesDiffer(base, { v: 1, nodes: { root: { base: { width: "third", textColor: "muted" }, tablet: { layout: "grid", columns: 2 } } } }), true, "altered");
    assert.equal(advancedStylesDiffer(base, { v: 1, nodes: { root: { base: { width: "half" } } } }), true, "removed at one width");
    assert.equal(advancedStylesDiffer(base, { v: 1, nodes: {} }), true, "reset");
    assert.equal(advancedStylesDiffer(base, { v: 1, nodes: { ...base.nodes, "field:title": { mobile: { glow: "soft" } } } }), true, "added elsewhere");
    assert.equal(advancedStylesDiffer({ v: 1, nodes: {} }, { v: 1, nodes: { root: { base: { padBlock: 2 } } } }), false, "a standard token on an empty document");
    // Compared as stored: a value the validator drops is no change, an unknown version is the empty document.
    assert.equal(advancedStylesDiffer({ v: 1, nodes: {} }, { v: 1, nodes: { root: { base: { width: "enormous" } } } }), false);
    assert.equal(advancedStylesDiffer(null, { v: 99, nodes: { root: { base: { width: "full" } } } }), false);
    assert.deepEqual(validateStyleDocument({ v: 1, nodes: { root: { base: { width: "enormous" } } } }), { v: 1, nodes: {} });
  });

  test("10 · a standard-only reset keeps every advanced token in the branch", () => {
    const doc = validateStyleDocument({ v: 1, nodes: { root: { base: { width: "half", padBlock: 3, glow: "soft", textColor: "muted" }, tablet: { padBlock: 1 } } } });
    const reset = withoutBranch(doc, "root", "base", isAdvancedToken);
    assert.deepEqual(reset, { v: 1, nodes: { root: { base: { width: "half", glow: "soft" }, tablet: { padBlock: 1 } } } });
    assert.equal(advancedStylesDiffer(doc, reset), false, "the reset is a document the server accepts from a standard-only role");
    assert.deepEqual(withoutBranch(doc, "root", "tablet", isAdvancedToken), { v: 1, nodes: { root: { base: doc.nodes.root!.base } } });
    // With the capability, a reset takes the whole branch, as it always did.
    assert.deepEqual(withoutBranch(doc, "root", "base"), { v: 1, nodes: { root: { tablet: { padBlock: 1 } } } });
  });

  test("a change to a reference map is recognised whatever order it was written in", () => {
    assert.equal(sameReuse({ a: { c: 1, o: ["x.en", "y"] }, b: { c: 2 } }, { b: { c: 2 }, a: { c: 1, o: ["y", "x.en"] } }), true);
    assert.equal(sameReuse({ a: { c: 1 } }, { a: { c: 1, o: ["x.en"] } }), false, "an override switched on");
    assert.equal(sameReuse({ a: { c: 1 } }, { a: { c: 2 } }), false, "a different component");
    assert.equal(sameReuse({}, { a: { c: 1 } }), false, "a new link");
  });
});

describe("12, 14, 16 · the places that must ask, as the source states them", () => {
  const files = (dir: string): string[] =>
    readdirSync(path.join(REPO_ROOT, dir)).flatMap((name) => {
      const relative = path.join(dir, name);
      return statSync(path.join(REPO_ROOT, relative)).isDirectory() ? files(relative) : [relative];
    });

  test("2 · nothing in the application authorizes with content.manage any more", () => {
    for (const file of files("src").filter((name) => /\.(ts|tsx)$/.test(name))) {
      if (file === path.join("src", "lib", "auth", "permissions.ts")) continue;
      const text = source(file);
      assert.doesNotMatch(text, /guardAction\("content\.manage"|permissions\.has\("content\.manage"\)|"content\.manage"\s*[,)]/, file);
    }
  });

  test("16 · every page, section and component write names its capability at the door", () => {
    const pages = source("src/app/(backoffice)/admin/(shell)/pages/actions.ts");
    const editor = source("src/app/(backoffice)/admin/visual-editor/actions.ts");
    for (const text of [pages, editor]) {
      for (const call of text.matchAll(/guardAction\(([^,]+),/g)) {
        assert.match(call[1]!, /^(AUTHORITY\.\w+|COMPOUND\.\w+|REUSE_AUTHORITY\.\w+|requirement\.need)$/, call[0]);
      }
    }
    // The second check is made before the write it depends on.
    assert.match(editor, /if \(advancedStylesDiffer\(baseline, styles\)\) \{\s*assertAllowed\(session, AUTHORITY\.editAdvancedStyle, DENIED\.editAdvancedStyle\);\s*\}\s*const result = await updateSectionGuarded/);
    assert.match(editor, /if \(!sameReuse\(before, reuse\.map\)\) \{\s*assertAllowed\(session, REUSE_AUTHORITY\.instances, REUSE_DENIED\.instances\);/);
    assert.match(pages, /if \(motionEdited\) assertAllowed\(session, AUTHORITY\.editMotion, DENIED\.editMotion\);/);
    assert.match(pages, /assertAllowed\(session, COMPOUND\.renamePage, DENIED\.renamePage\);/);
  });

  test("14 · a direct edit begins only with the content capability, and a canvas message is not one", () => {
    const shell = source("src/components/admin/visual-editor/shell.tsx");
    const request = shell.slice(shell.indexOf("const requestDirectEdit = useCallback("), shell.indexOf("const onCanvasEdit = useCallback("));
    const gate = request.indexOf('if (!allowed("editContent")) return;');
    assert.ok(gate > 0 && gate < request.indexOf('setEditRequest({ kind: "begin"'), "a session could begin before the capability is checked");
    const edit = shell.slice(shell.indexOf("const onCanvasEdit = useCallback("), shell.indexOf("const onValues = useCallback("));
    assert.ok(edit.indexOf('if (!allowed("editContent")) return;') < edit.indexOf("acceptEdit("));
    const layers = source("src/components/admin/visual-editor/layers.tsx");
    assert.match(layers, /editable=\{canEditText \? editableOf\(section\) : NO_ADDRESSES\}/);
  });

  test("13 · Undo and Redo check the step's capability before anything is replayed or consumed", () => {
    const shell = source("src/components/admin/visual-editor/shell.tsx");
    const step = shell.slice(shell.indexOf("const stepHistory = useCallback("), shell.indexOf("/** The latest Undo and Redo"));
    const structureGate = step.indexOf('if (!allowed("editStructure")) {');
    assert.ok(structureGate > 0 && structureGate < step.indexOf("runLayoutStep(step)"));
    const contentGate = step.indexOf('if (!allowed("editContent")) {');
    assert.ok(contentGate > 0 && contentGate < step.indexOf('setDomainValue(change.sectionId, "content", values)'));
    assert.ok(step.indexOf('refuse("viewComponents")') < step.indexOf('setDomainValue(change.sectionId, "content", values)'));
    assert.ok(step.indexOf('refuse("editAdvancedStyle")') < step.indexOf("setDomainValue(change.sectionId, change.domain, target)"));
    // A refused step is not taken off the history.
    assert.ok(step.indexOf("writeHistory(pageId, taken.history)") > step.indexOf("setDomainValue(change.sectionId, change.domain, target)"));
  });

  test("15 · a refused save keeps its work and lets the other domains save", () => {
    const shell = source("src/components/admin/visual-editor/shell.tsx");
    const drain = shell.slice(shell.indexOf("const drainSection = useCallback("), shell.indexOf("drainRef.current ="));
    assert.match(drain, /if \(result === "denied"\) \{\s*skipped\.add\(domain\);\s*continue;\s*\}/);
    const save = shell.slice(shell.indexOf("const runSave = useCallback("), shell.indexOf("const drainSection = useCallback("));
    assert.match(save, /if \(answer\.reason === "denied"\) return refused\(answer\.message\);/);
    assert.match(save, /denied: \{ \.\.\.live\.denied, \[domain\]: message \}/);
    assert.doesNotMatch(save, /contentDirty: false|styleDirty: false|motionDirty: false/, "a refusal must not mark the work saved");
  });

  test("12 · the controls follow the capabilities — locked advanced tokens, Replay kept for readers", () => {
    const style = source("src/components/admin/visual-editor/style-inspector.tsx");
    assert.match(style, /isAdvancedToken\(token\) && !canAdvanced \? \(\s*<fieldset\s+key=\{token\}\s+disabled/);
    assert.match(style, /withoutBranch\(styles, path, breakpoint, canAdvanced \? undefined : isAdvancedToken\)/);
    const motion = source("src/components/admin/visual-editor/motion-inspector.tsx");
    assert.ok(motion.indexOf("data-motion-replay") < motion.indexOf("<fieldset disabled={!canMotion}"), "Replay sits inside the locked controls");
    const form = source("src/app/(backoffice)/admin/(shell)/pages/section/[id]/section-form.tsx");
    assert.match(form, /disabled=\{!can\.motion \|\| !can\.edit\}/);
    const nav = source("src/lib/admin/nav.ts");
    assert.match(nav, /label: "Reusable components", icon: "layers", permission: "components\.view"/);
  });
});
