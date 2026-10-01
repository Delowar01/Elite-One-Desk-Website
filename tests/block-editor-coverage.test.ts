/**
 * Batch 19B: no registered editable field silently lacks an editor.
 *
 * The section editor is drawn from the block registry, field by field, and the
 * Visual Editor's Content tab and the classic admin form are the same
 * component in two shapes — so the claim "every field can be edited" is a
 * claim about one function and the registry it reads. This renders every
 * block the registry holds through that function, in both shapes and both
 * canvas languages, and asks the markup for each field's own control.
 *
 * What it would catch: a field type added to the registry and offered as the
 * fall-through text box, a localised field whose second edition goes missing,
 * a media or icon field drawn as free text, a list whose rows lose a field, or
 * a control without an accessible name. `FieldRow` is also exhaustive in the
 * type system (`never`), so a new type stops the build before it gets here.
 *
 * The component is rendered as static markup: no browser, no database. What
 * the controls *do* in the running editor is the browser probes' business.
 */
import assert from "node:assert/strict";
import { before, describe, test } from "node:test";
import * as React from "react";

import type { BlockDef, FieldDef, FieldType, ItemFieldDef } from "@/lib/cms/blocks";
import { BLOCKS } from "@/lib/cms/blocks";
import { ITEM_ID_KEY } from "@/lib/cms/item-id";
import { validateBlockValues } from "@/lib/cms/validate";
import { ICON_NAMES } from "@/lib/icons";

// The components are compiled with the classic JSX transform under the test
// runner, which expects `React` in scope; the app's own build never needs this.
(globalThis as { React?: unknown }).React = React;

type Render = (props: Record<string, unknown>) => string;
let render: Render;

before(async () => {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const { BlockEditor } = await import("@/components/admin/block-editor");
  render = (props) => renderToStaticMarkup(React.createElement(BlockEditor, props as never));
});

const FIELD_TYPES: readonly FieldType[] = [
  "text",
  "textarea",
  "richtext",
  "media",
  "link",
  "select",
  "boolean",
  "number",
  "items",
];
const ITEM_TYPES = ["text", "textarea", "media", "icon"] as const;
const itemType = (sub: ItemFieldDef) => sub.type ?? "text";

const MEDIA = { id: 7, filename: "coverage.webp", title: "Coverage", altEn: "", width: 1200, height: 800, folder: "" };
const ICON = ICON_NAMES[0];

/** A value for the block with every field filled and one row in every list. */
function seeded(block: BlockDef, mediaId: number | null): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const field of block.fields) {
    if (field.type === "media") raw[field.name] = mediaId;
    else if (field.type === "items") {
      const row: Record<string, unknown> = { [ITEM_ID_KEY]: "it_coverage01" };
      for (const sub of field.itemFields ?? []) {
        const kind = itemType(sub);
        row[sub.name] =
          kind === "media" ? mediaId : kind === "icon" ? ICON : sub.localised ? { en: "One", ar: "واحد" } : "one";
      }
      raw[field.name] = [row];
    } else if (field.localised) raw[field.name] = { en: "English", ar: "عربي" };
  }
  return validateBlockValues(block, raw);
}

const editor = (block: BlockDef, locale: "en" | "ar" | undefined, mediaId: number | null = MEDIA.id) =>
  render({ block, value: seeded(block, mediaId), onChange() {}, media: [MEDIA], locale });

/** The markup of each field, by name, cut at the field shells. */
function fields(html: string): Map<string, string> {
  const marks = [...html.matchAll(/<div data-field="([^"]+)"/g)];
  const out = new Map<string, string>();
  marks.forEach((mark, i) => {
    assert.ok(!out.has(mark[1]!), `field ${mark[1]} drawn twice`);
    out.set(mark[1]!, html.slice(mark.index, marks[i + 1]?.index ?? html.length));
  });
  return out;
}

/** The opening tag of the element with this id, or null. */
const tagById = (html: string, id: string): string | null =>
  html.match(new RegExp(`<(?:input|textarea|select|button)\\b[^>]*\\bid="${id.replace(/[-]/g, "\\-")}"[^>]*>`))?.[0] ?? null;

const lower = (label: string) => label.toLowerCase();

/** What one field must have drawn, in the shape asked for. */
function assertField(where: string, field: FieldDef, html: string, langs: ("en" | "ar")[]) {
  const id = `field-${field.name}`;
  const named = (text: string) => assert.ok(html.includes(text), `${where}: missing ${text}`);

  switch (field.type) {
    case "text":
    case "textarea":
    case "richtext": {
      const element = field.type === "text" ? "input" : "textarea";
      if (!field.localised) {
        const tag = tagById(html, id);
        assert.ok(tag?.startsWith(`<${element}`), `${where}: no <${element}> #${id}`);
        named(`for="${id}"`);
        break;
      }
      for (const lang of ["en", "ar"] as const) {
        const tag = tagById(html, `${id}-${lang}`);
        if (!langs.includes(lang)) {
          assert.equal(tag, null, `${where}: the ${lang} box is offered on a canvas showing the other edition`);
          continue;
        }
        assert.ok(tag?.startsWith(`<${element}`), `${where}: no <${element}> #${id}-${lang}`);
        assert.match(tag!, new RegExp(`dir="${lang === "ar" ? "rtl" : "ltr"}"`), `${where}: ${lang} box direction`);
        assert.match(tag!, new RegExp(`aria-labelledby="${id}-label`), `${where}: ${lang} box is not named by the field`);
      }
      named(`id="${id}-label"`);
      if (field.type === "richtext") named("Bold, italic, links, lists");
      break;
    }
    case "link": {
      const tag = tagById(html, id);
      assert.ok(tag?.startsWith("<input") && /dir="ltr"/.test(tag), `${where}: no left-to-right <input> #${id}`);
      named(`for="${id}"`);
      break;
    }
    case "select": {
      const tag = tagById(html, id);
      assert.ok(tag?.startsWith("<select"), `${where}: no <select> #${id}`);
      assert.equal((html.match(/<option\b/g) ?? []).length, field.options?.length ?? 0, `${where}: options`);
      named(`for="${id}"`);
      break;
    }
    case "boolean":
      assert.match(html, /<label\b[^>]*><input type="checkbox"/, `${where}: no checkbox inside its label`);
      named(field.label);
      break;
    case "number": {
      const tag = tagById(html, id);
      assert.ok(tag?.startsWith("<input") && /type="number"/.test(tag) && /min="0"/.test(tag), `${where}: no number input`);
      named(`for="${id}"`);
      break;
    }
    case "media":
      named(`aria-label="Change ${lower(field.label)}"`);
      named(`src="/media/${MEDIA.filename}"`);
      break;
    case "items": {
      named(`Add ${lower(field.label).replace(/s$/, "")}`);
      for (const name of ["Move up", "Move down", "Remove"]) named(`aria-label="${name}"`);
      for (const sub of field.itemFields ?? []) {
        const subId = `${field.name}-0-${sub.name}`;
        const kind = itemType(sub);
        if (kind === "media") named(`aria-label="Change ${lower(sub.label)}"`);
        else if (kind === "icon") {
          const tag = tagById(html, subId);
          assert.ok(tag?.startsWith("<button"), `${where}.${sub.name}: no icon chooser`);
          assert.match(tag!, new RegExp(`aria-label="${sub.label}: ${ICON}"`), `${where}.${sub.name}: icon chooser name`);
        } else if (!sub.localised) {
          const tag = tagById(html, subId);
          assert.ok(tag?.startsWith("<input"), `${where}.${sub.name}: no <input>`);
          named(`for="${subId}"`);
        } else {
          for (const lang of ["en", "ar"] as const) {
            const tag = tagById(html, `${subId}-${lang}`);
            if (!langs.includes(lang)) {
              assert.equal(tag, null, `${where}.${sub.name}: ${lang} box offered on the other edition's canvas`);
              continue;
            }
            assert.ok(tag?.startsWith(kind === "textarea" ? "<textarea" : "<input"), `${where}.${sub.name}: ${lang} control`);
            named(`for="${subId}-${lang}"`);
          }
        }
      }
      break;
    }
    default: {
      const unhandled: never = field.type;
      assert.fail(`${where}: no expectation for field type ${String(unhandled)}`);
    }
  }
}

/**
 * Every form control is named — by `aria-labelledby` ids that exist, by a
 * `<label for>`, or by the label it sits in — and every button has words or an
 * `aria-label`. A walk over the static markup; React's output is well formed.
 */
function unnamedControls(html: string): string[] {
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]!));
  const labelled = new Set([...html.matchAll(/<label\b[^>]*\bfor="([^"]+)"/g)].map((m) => m[1]!));
  // HTML's void elements only: React closes every SVG child (`<path></path>`).
  const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
  const problems: string[] = [];
  const stack: { name: string; attrs: string; text: string }[] = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*?)(\/?)>|([^<]+)/g;
  for (const m of html.matchAll(tagRe)) {
    if (m[5] !== undefined) {
      for (const open of stack) if (open.name === "button") open.text += m[5];
      continue;
    }
    const [, closing, rawName, attrs = "", selfClosing] = m;
    const name = rawName!.toLowerCase();
    if (closing) {
      const open = stack.pop();
      if (open?.name === "button" && !/aria-label="[^"]+"/.test(open.attrs) && !open.text.trim()) {
        problems.push(`button without a name: <button${open.attrs}>`);
      }
      continue;
    }
    if (["input", "textarea", "select"].includes(name) && !/type="hidden"/.test(attrs)) {
      const id = attrs.match(/\bid="([^"]+)"/)?.[1];
      const by = attrs.match(/aria-labelledby="([^"]+)"/)?.[1];
      const named =
        (by && by.split(" ").every((ref) => ids.has(ref))) ||
        /aria-label="[^"]+"/.test(attrs) ||
        (id && labelled.has(id)) ||
        stack.some((open) => open.name === "label");
      if (!named) problems.push(`${name} without a name: <${name}${attrs}>`);
    }
    if (!selfClosing && !VOID.has(name)) stack.push({ name, attrs, text: "" });
  }
  return problems;
}

describe("19B · every registered field has an editor (CI-10)", () => {
  test("the registry declares only the nine field types and four item types the editor draws", () => {
    for (const block of BLOCKS) {
      for (const field of block.fields) {
        assert.ok(FIELD_TYPES.includes(field.type), `${block.type}.${field.name}: unknown type ${field.type}`);
        if (field.type === "select") assert.ok(field.options?.length, `${block.type}.${field.name}: a select with no options`);
        if (field.type !== "items") continue;
        assert.ok(field.itemFields?.length, `${block.type}.${field.name}: a list whose rows have no fields`);
        for (const sub of field.itemFields ?? []) {
          assert.ok(ITEM_TYPES.includes(itemType(sub)), `${block.type}.${field.name}.${sub.name}: unknown item type ${sub.type}`);
          // A plain (non-localised) row textarea would be drawn as a one-line
          // input; none is declared, and declaring one must come with its box.
          assert.ok(!(itemType(sub) === "textarea" && !sub.localised), `${block.type}.${field.name}.${sub.name}: plain row textarea`);
        }
      }
    }
  });

  test("the Visual Editor shape: every field of every block is drawn with its own control, in the canvas's language only", () => {
    for (const block of BLOCKS) {
      const drawn = fields(editor(block, "en"));
      assert.deepEqual([...drawn.keys()], block.fields.map((f) => f.name), `${block.type}: fields drawn`);
      for (const field of block.fields) assertField(`${block.type}.${field.name} (en)`, field, drawn.get(field.name)!, ["en"]);
    }
  });

  test("the Arabic canvas: every localised field offers the Arabic box, right to left, and no English one", () => {
    for (const block of BLOCKS) {
      const drawn = fields(editor(block, "ar"));
      for (const field of block.fields) assertField(`${block.type}.${field.name} (ar)`, field, drawn.get(field.name)!, ["ar"]);
    }
  });

  test("the admin form shape: every localised field offers both editions side by side", () => {
    for (const block of BLOCKS) {
      const drawn = fields(editor(block, undefined));
      assert.deepEqual([...drawn.keys()], block.fields.map((f) => f.name), `${block.type}: fields drawn`);
      for (const field of block.fields) assertField(`${block.type}.${field.name} (both)`, field, drawn.get(field.name)!, ["en", "ar"]);
    }
  });

  test("an empty picture field offers Choose, named after the field, and no Remove", () => {
    for (const block of BLOCKS) {
      const drawn = fields(editor(block, "en", null));
      for (const field of block.fields.filter((f) => f.type === "media")) {
        const html = drawn.get(field.name)!;
        assert.ok(html.includes(`aria-label="Choose ${lower(field.label)}"`), `${block.type}.${field.name}: Choose`);
        assert.ok(html.includes("No image selected"), `${block.type}.${field.name}: says it is empty`);
        assert.ok(!html.includes(`aria-label="Remove ${lower(field.label)}"`), `${block.type}.${field.name}: Remove on nothing`);
      }
    }
  });

  test("every control the editor draws has an accessible name, in both shapes and both languages", () => {
    for (const block of BLOCKS) {
      for (const locale of ["en", "ar", undefined] as const) {
        for (const mediaId of [MEDIA.id, null]) {
          const problems = unnamedControls(editor(block, locale, mediaId));
          assert.deepEqual(problems, [], `${block.type} (${locale ?? "both"}, media ${mediaId ?? "empty"})`);
        }
      }
    }
  });

  test("the render exercised all nine field types and all four item types", () => {
    const seen = new Set<string>();
    const seenItems = new Set<string>();
    for (const block of BLOCKS) {
      for (const field of block.fields) {
        seen.add(field.type);
        for (const sub of field.itemFields ?? []) seenItems.add(itemType(sub));
      }
    }
    assert.deepEqual([...seen].sort(), [...FIELD_TYPES].sort());
    assert.deepEqual([...seenItems].sort(), [...ITEM_TYPES].sort());
  });
});
