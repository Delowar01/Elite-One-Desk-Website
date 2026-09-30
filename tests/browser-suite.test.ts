/**
 * The tracked browser QA itself, checked by the ordinary suite (Batch 19A).
 *
 * The probes and stress scripts run in a real browser and are not part of
 * `npm test`, so nothing else would notice them drifting: a probe added
 * without an expected PASS count (the runner would refuse it), two probes on
 * one port (they would fight over it the first time they ran in parallel), a
 * machine path copied in from a workstation, a probe launching its own
 * Chromium instead of the harness's, or the autosave constant the probes'
 * observation windows are built on silently changing underneath them.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";

import { REPO_ROOT } from "./helpers/env";

const PROBES = path.join(REPO_ROOT, "tests", "browser", "probes");
const STRESS = path.join(REPO_ROOT, "tests", "stress");

const scripts = (dir: string, suffix: string) =>
  readdirSync(dir)
    .filter((file) => file.endsWith(suffix))
    .map((file) => ({ name: file.slice(0, -suffix.length), file: path.join(dir, file), text: readFileSync(path.join(dir, file), "utf8") }));
const probes = scripts(PROBES, ".probe.mts");
const stress = scripts(STRESS, ".stress.mts");
const expected = (dir: string) => JSON.parse(readFileSync(path.join(dir, "expected.json"), "utf8")) as Record<string, number>;

describe("19A · the tracked browser suite", () => {
  test("every probe and stress script has an expected PASS count, and every count a script", () => {
    for (const [dir, list] of [[PROBES, probes], [STRESS, stress]] as const) {
      const counts = expected(dir);
      assert.deepEqual(
        list.map((script) => script.name).sort(),
        Object.keys(counts).sort(),
        `${path.relative(REPO_ROOT, dir)}/expected.json and the scripts beside it disagree`,
      );
      for (const [name, count] of Object.entries(counts)) {
        assert.ok(Number.isInteger(count) && count > 0, `${name}: ${count} is not a PASS count`);
      }
    }
    assert.equal(probes.length, 30, "Batch 19A tracks thirty probes");
  });

  test("each script has a port of its own, apart from the automated suite's", () => {
    const ports = new Map<number, string>();
    for (const script of [...probes, ...stress]) {
      const match = /const PORT = (\d+);/.exec(script.text);
      if (!match) {
        // A script that starts no server needs no port.
        assert.ok(!script.text.includes("startServer("), `${script.name} starts a server without a PORT`);
        continue;
      }
      const port = Number(match[1]);
      assert.ok(!ports.has(port), `${script.name} and ${ports.get(port)} both use port ${port}`);
      ports.set(port, script.name);
    }
    for (const file of readdirSync(path.join(REPO_ROOT, "tests")).filter((name) => name.endsWith(".test.ts"))) {
      for (const match of readFileSync(path.join(REPO_ROOT, "tests", file), "utf8").matchAll(/PORT(?:_[A-Z]+)? = (\d+);/g)) {
        assert.ok(!ports.has(Number(match[1])), `tests/${file} and ${ports.get(Number(match[1]))} share port ${match[1]}`);
      }
    }
  });

  test("no machine path, no private browser, no gitignored import", () => {
    for (const script of [...probes, ...stress]) {
      assert.ok(!/\/(opt|home|tmp|root|Users)\//.test(script.text), `${script.name} names a path on one machine`);
      assert.ok(!/chromium\.launch\(/.test(script.text), `${script.name} launches its own Chromium — use launchChromium()`);
      assert.ok(!script.text.includes(".data/test/probes") && !script.text.includes(".data/test/stress"), `${script.name} reaches into .data`);
      if (script.text.includes("playwright")) {
        assert.ok(!/import \{[^}]*\bchromium\b[^}]*\} from "playwright"/.test(script.text), `${script.name} imports chromium directly`);
      }
    }
  });

  test("the probes' autosave constant is the editor's", () => {
    const shell = readFileSync(path.join(REPO_ROOT, "src", "components", "admin", "visual-editor", "shell.tsx"), "utf8");
    const wait = readFileSync(path.join(REPO_ROOT, "tests", "browser", "wait.ts"), "utf8");
    const app = /export const AUTOSAVE_DELAY_MS = (\d+);/.exec(shell)?.[1];
    const probe = /export const AUTOSAVE_DELAY_MS = (\d+);/.exec(wait)?.[1];
    assert.ok(app && probe, "both files declare AUTOSAVE_DELAY_MS");
    assert.equal(probe, app);
  });

  test("nothing in the tracked suite sleeps for seconds to wait for something to happen", () => {
    // A multi-second fixed wait is either a condition that should be polled
    // (`until`, `holdsStill`, `waitForInspector`…) or an observation window,
    // which is named and says why (`quietFor`). Literal sleeps of a second or
    // more are neither.
    for (const script of [...probes, ...stress]) {
      const long = [...script.text.matchAll(/waitForTimeout\(\s*([\d_]+)\s*\)/g)].filter((match) => Number(match[1]!.replace(/_/g, "")) >= 1000);
      assert.deepEqual(long.map((match) => match[0]), [], `${script.name} sleeps for a second or more`);
    }
  });

  test("the runner, its harness and the documentation are where the README says", () => {
    for (const file of ["tests/browser/run.ts", "tests/browser/harness.ts", "tests/browser/canvas.ts", "tests/browser/wait.ts", "tests/browser/README.md", "tests/stress/README.md", "tests/browser/.env.example"]) {
      assert.ok(existsSync(path.join(REPO_ROOT, file)), `${file} is missing`);
    }
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    assert.match(pkg.scripts["test:browser"] ?? "", /tests\/browser\/run\.ts --suite browser/);
    assert.match(pkg.scripts["test:stress"] ?? "", /tests\/browser\/run\.ts --suite stress/);
    assert.match(pkg.devDependencies.playwright ?? "", /^\d+\.\d+\.\d+$/, "playwright is pinned to an exact version");
  });
});
