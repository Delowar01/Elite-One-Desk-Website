/**
 * Two invariants that live in the shape of the source rather than in its
 * output, asserted from the source itself.
 *
 * Both are the written half of a defect that shipped. Each is stated in a
 * comment somewhere in `src/`, each is load-bearing — the code around it is
 * only correct while it holds — and neither can be observed by running the
 * application on a machine that behaves. A test that can only see the output
 * would go on passing for as long as the timing happened to be kind, which is
 * exactly what both of these did.
 *
 * Nothing here needs a database or a server, so it costs a few milliseconds and
 * runs beside everything else.
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { REPO_ROOT } from "./helpers/env";

const read = (file: string): string => readFileSync(path.join(REPO_ROOT, file), "utf8");

const VERSIONS = "src/lib/versions.ts";
const REVISION = "src/lib/db/revision.ts";
const PUBLISH_SERVICE = "src/lib/cms/publish-service.ts";
const PAGE_ACTIONS = "src/app/(backoffice)/admin/(shell)/pages/actions.ts";
const SECTION_FORM = "src/app/(backoffice)/admin/(shell)/pages/section/[id]/section-form.tsx";
const SECTION_PAGE = "src/app/(backoffice)/admin/(shell)/pages/section/[id]/page.tsx";

/**
 * Every application source file, so these rules are about the application and
 * not about the two or three files somebody remembered to list.
 *
 * The first version of this checked `versions.ts` and two named callers, and
 * concluded from their silence that no other writer existed. That is not a
 * proof, it is a restatement of the assumption — and the thing it missed was
 * sitting in the file it did read.
 */
const SOURCES: { file: string; source: string }[] = readdirSync(path.join(REPO_ROOT, "src"), {
  recursive: true,
  encoding: "utf8",
})
  .filter((entry) => /\.tsx?$/.test(entry))
  .map((entry) => {
    const file = path.posix.join("src", entry.split(path.sep).join("/"));
    return { file, source: read(file) };
  });

/**
 * Source with its prose removed, so a comment naming a writer is not read as a
 * call to one.
 *
 * Only block comments and whole-line `//` comments go. String literals are left
 * exactly as they are: stripping more would risk hiding a real call behind a
 * quotation mark, and these rules have to fail closed on executable code even
 * at the cost of being strict about where a comment may sit.
 */
const code = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^[ \t]*\/\/.*$/gm, " ");

/** A declaration's body, by brace matching from its opening `{`. */
function bodyOf(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} is no longer in the source`);
  const open = source.indexOf("{", start);
  assert.ok(open > start, `${declaration} has no body`);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`${declaration} has an unbalanced body`);
}

/** Every top-level `export` in a module, with the chunk of source it owns. */
function exportedChunks(source: string): { name: string; chunk: string }[] {
  const text = code(source);
  const heads = [...text.matchAll(/^export\s+(?:async\s+)?(?:function|const)\s+(\w+)/gm)];
  return heads.map((head, index) => ({
    name: head[1]!,
    chunk: text.slice(head.index!, heads[index + 1]?.index ?? text.length),
  }));
}

/* -------------------------------------------------------------------------- */

describe("a restore point's id is the order it was published in", () => {
  /**
   * `listPageVersions` orders history by `id`, and the retention ceiling counts
   * from the same end. That is sound for one reason only: every row is inserted
   * while its page is held `FOR UPDATE`, so `page_versions.id` — allocated by
   * the INSERT — is publication order for that page.
   *
   * It replaced ordering by `created_at`, which is not: `defaultNow()` is the
   * transaction timestamp, so a publication that began earlier and serialized
   * later carries the earlier stamp.
   *
   * A history writer that does not take the lock therefore does not merely
   * race — it silently breaks the order the whole screen is built on, and no
   * test of the running application would see it except intermittently. These
   * rules exist so that writer cannot be added, or left lying about, quietly.
   */
  const AUDITED_CALLERS = [PAGE_ACTIONS, PUBLISH_SERVICE];

  test("the application inserts a page version in exactly one place", () => {
    const inserting = SOURCES.filter(({ source }) => code(source).includes(".insert(pageVersions)"));
    assert.deepEqual(
      inserting.map(({ file }) => file),
      [VERSIONS],
      "a page version is inserted outside versions.ts",
    );
    assert.equal(
      [...code(read(VERSIONS)).matchAll(/\.insert\(pageVersions\)/g)].length,
      1,
      "versions.ts inserts a page version in more than one place",
    );
  });

  test("…inside a primitive no other module can reach", () => {
    const source = read(VERSIONS);
    assert.ok(
      bodyOf(source, "async function savePageVersionIn").includes(".insert(pageVersions)"),
      "the insert has moved out of savePageVersionIn",
    );

    // Private: not exported at its declaration, and not re-exported later.
    assert.ok(
      !/export\s+(?:async\s+)?function\s+savePageVersionIn\b/.test(code(source)),
      "savePageVersionIn is exported again — any module could then write history unlocked",
    );
    assert.ok(
      !/export\s*\{[^}]*\bsavePageVersionIn\b/.test(code(source)),
      "savePageVersionIn is re-exported through an export list",
    );

    // …and nothing outside the module names it, which is what makes the
    // previous assertion worth making.
    assert.deepEqual(
      SOURCES.filter(
        ({ file, source: other }) => file !== VERSIONS && code(other).includes("savePageVersionIn"),
      ).map(({ file }) => file),
      [],
      "another module reaches the private version writer",
    );
  });

  test("no exported helper reaches that primitive except recordRestorePointIn", () => {
    /**
     * The escape hatch this replaced: `export const savePageVersion = (input) =>
     * savePageVersionIn(db, input)` — the pool, no transaction, no lock. It had
     * no production caller, which is why nothing failed; it was reachable, which
     * is why the ordering invariant was a convention rather than a property of
     * the module.
     */
    const reaching = exportedChunks(read(VERSIONS))
      .filter(({ chunk }) =>
        // The declaration itself is not a call to itself.
        chunk
          .replace(/(?:export\s+)?(?:async\s+)?function\s+savePageVersionIn\s*\([^)]*\)/g, " ")
          .includes("savePageVersionIn("),
      )
      .map(({ name }) => name);
    assert.deepEqual(
      reaching,
      ["recordRestorePointIn"],
      "an exported helper other than recordRestorePointIn can create a restore point",
    );
    assert.ok(
      !/\bsavePageVersion\b\s*[=(]/.test(code(read(VERSIONS)).replace(/savePageVersionIn/g, " ")),
      "a pool-level savePageVersion exists again",
    );
  });

  test("every production caller is enumerated, and a new one fails this test", () => {
    const callers = SOURCES.filter(
      ({ file, source }) => file !== VERSIONS && /\brecordRestorePointIn\s*\(/.test(code(source)),
    );
    assert.deepEqual(
      callers.map(({ file }) => file).sort(),
      [...AUDITED_CALLERS].sort(),
      "a restore-point writer appeared or disappeared: audit its transaction and its " +
        "lock, then list it in AUDITED_CALLERS — the id ordering depends on it",
    );
  });

  test("…and each one writes inside a transaction that already holds the page", () => {
    for (const file of AUDITED_CALLERS) {
      const text = code(read(file));
      const calls = [...text.matchAll(/\brecordRestorePointIn\s*\(/g)];
      assert.ok(calls.length > 0, `${file} no longer writes a restore point`);
      for (const call of calls) {
        const opened = text.lastIndexOf(".transaction(", call.index);
        assert.ok(opened >= 0, `a restore point is written outside a transaction in ${file}`);
        const preamble = text.slice(opened, call.index);
        assert.match(
          preamble,
          /lockPageForWrite\(|readPage\([^,]+,[^,]+,\s*true\)/,
          `a restore point is written before the page is locked in ${file}`,
        );
      }
    }
  });

  test("the lock itself still takes the page row before the section rows", () => {
    // Which is what makes the id an order rather than a coincidence: the page
    // row is the one thing every publication of that page queues on.
    const body = bodyOf(read(REVISION), "export async function lockPageForWrite");
    const page = body.indexOf("from(pages)");
    const sections = body.indexOf("from(pageSections)");
    assert.ok(page > 0, "lockPageForWrite no longer locks the page row");
    assert.ok(sections > page, "the section rows are locked before the page row");
    assert.match(
      body.slice(page, sections),
      /\.for\("update"\)/,
      "the page row is read without FOR UPDATE",
    );
  });
});

/* -------------------------------------------------------------------------- */

describe("a section screen holds one server state, and moves it only by writing", () => {
  /**
   * The rule: the revision the form submits must be the revision of the exact
   * server state the values in that form came from. Old values beside a new
   * revision is a silent overwrite of whoever wrote in between — the server
   * compares the number and cannot see the mismatch.
   *
   * The screen keeps that pair together by holding it as one value, seeded once
   * from the server render and moved only when one of its own writes comes back
   * with a new one. That is a property of the source, not of the rendered
   * output: the component went most of a batch with a render-phase adoption
   * that would have created the forbidden pair, and no test failed, because
   * nothing in the application happened to hand it a newer revision.
   */
  const source = read(SECTION_FORM);
  const seed = (() => {
    const start = source.indexOf("const [screen, setScreen] = useState({");
    assert.ok(start >= 0, "SectionForm no longer holds its server state in one value");
    const end = source.indexOf("});", start);
    assert.ok(end > start);
    return source.slice(start, end);
  })();

  test("the props it was rendered with are read once, into that value", () => {
    const everywhere = [...source.matchAll(/\bsection\.\w+/g)].map((match) => match[0]);
    const inSeed = [...seed.matchAll(/\bsection\.\w+/g)].map((match) => match[0]);
    assert.deepEqual(
      everywhere,
      inSeed,
      "the `section` prop is read after the initial state — a newer server " +
        "state would be adopted without the values it belongs to",
    );
    for (const field of ["id", "revision", "draftKind", "animation", "isDraftOnly", "values"]) {
      assert.ok(inSeed.includes(`section.${field}`), `the initial state does not carry ${field}`);
    }
  });

  test("the revision and the words it belongs to come from that one value", () => {
    assert.match(
      source,
      /name="expectedRevision" value=\{screen\.revision\}/,
      "the form's revision does not come from the held state",
    );
    assert.equal(
      [...source.matchAll(/expectedRevision: screen\.revision/g)].length,
      2,
      "Publish and Discard do not both carry the held revision",
    );
    assert.ok(
      !/expectedRevision[:=]\s*\{?section\.revision/.test(source),
      "a control submits the prop's revision rather than the held one",
    );
    assert.match(
      source,
      /<BlockEditor key=\{screen\.token\} block=\{block\} initial=\{screen\.values\}/,
      "the fields are not seeded from the same value as the revision",
    );
  });

  test("nothing moves it but an answered write of its own", () => {
    const setters = [...source.matchAll(/setScreen\(/g)];
    assert.equal(setters.length, 1, `${setters.length} places move the held state`);
    const adopt = source.slice(source.indexOf("const adopt = useCallback("));
    assert.ok(adopt.includes("setScreen("), "the one setter is not inside `adopt`");
    assert.match(adopt, /const next = state\.section;\s*\n\s*if \(!next\) return;/);

    // No timer, no poll, no router refresh: a pairing cannot be kept correct by
    // arranging for the wrong one to be short-lived.
    for (const banned of ["setTimeout", "setInterval", "router.refresh", "useEffect"]) {
      assert.ok(!source.includes(banned), `SectionForm uses ${banned}`);
    }
  });

  test("a different section gets a different form, not the last one's state", () => {
    assert.match(
      read(SECTION_PAGE),
      /<SectionForm\s*\n\s*key=\{row\.section\.id\}/,
      "the screen is not keyed on the row, so one section's state can outlive it",
    );
  });
});
