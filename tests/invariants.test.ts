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
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { REPO_ROOT } from "./helpers/env";

const read = (file: string): string => readFileSync(path.join(REPO_ROOT, file), "utf8");

const VERSIONS = "src/lib/versions.ts";
const PUBLISH_SERVICE = "src/lib/cms/publish-service.ts";
const PAGE_ACTIONS = "src/app/(backoffice)/admin/(shell)/pages/actions.ts";
const SECTION_FORM = "src/app/(backoffice)/admin/(shell)/pages/section/[id]/section-form.tsx";
const SECTION_PAGE = "src/app/(backoffice)/admin/(shell)/pages/section/[id]/page.tsx";

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
   * So a history writer that does not take the lock does not merely race — it
   * silently breaks the order the whole screen is built on, and no test of the
   * running application would see it except intermittently. This is the check
   * that a new one cannot appear quietly.
   */
  test("history is inserted in exactly one place", () => {
    const source = read(VERSIONS);
    const inserts = [...source.matchAll(/\.insert\(pageVersions\)/g)];
    assert.equal(inserts.length, 1, `${inserts.length} places insert a page version`);

    const body = source.slice(source.indexOf("export async function savePageVersionIn"));
    assert.ok(
      body.includes(".insert(pageVersions)"),
      "the insert is no longer inside savePageVersionIn",
    );

    // …and nowhere else in the application writes that table directly.
    for (const file of [PUBLISH_SERVICE, PAGE_ACTIONS]) {
      assert.ok(
        !read(file).includes(".insert(pageVersions)"),
        `${file} inserts a page version without going through savePageVersionIn`,
      );
    }
  });

  test("every writer holds the page before it writes one", () => {
    // `recordRestorePointIn` is the only way in, and both of its callers must
    // already be inside a transaction that has taken the page row.
    const callers = [
      { file: PUBLISH_SERVICE, lock: /readPage\(tx, pageId, true\)/ },
      { file: PAGE_ACTIONS, lock: /lockPageForWrite\(tx, [^)]+\)/ },
    ];
    for (const caller of callers) {
      const source = read(caller.file);
      const calls = [...source.matchAll(/await recordRestorePointIn\(/g)];
      assert.ok(calls.length > 0, `${caller.file} no longer writes a restore point`);
      for (const call of calls) {
        const opened = source.lastIndexOf("db.transaction(", call.index);
        assert.ok(opened >= 0, `a restore point is written outside a transaction in ${caller.file}`);
        const preamble = source.slice(opened, call.index);
        assert.match(
          preamble,
          caller.lock,
          `a restore point is written before the page is locked in ${caller.file}`,
        );
      }
    }

    // And the lock itself still takes the page row first, which is what makes
    // the id an order rather than a coincidence.
    assert.match(
      read("src/lib/db/revision.ts"),
      /export async function lockPageForWrite/,
      "lockPageForWrite has moved; the ordering invariant needs re-checking",
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
