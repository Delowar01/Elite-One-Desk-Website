/**
 * Builds the two fixture databases before the test files start.
 *
 * `node --test` runs one process per file and starts them together, so without
 * this the first thing each of them would do is try to build the same fixture at
 * the same time. They lock, so it would be correct either way — but doing it
 * once, up front, is faster and says plainly what the slow part is.
 */
import { freshSql, legacySql } from "./helpers/fixtures";
import { LEGACY_REF, PG_BASE } from "./helpers/env";

const started = Date.now();
console.log(`· postgres        ${PG_BASE}`);
console.log(`· legacy ref      ${LEGACY_REF}`);
console.log("· building fixtures (cached in .data/test — REBUILD_FIXTURES=1 to redo)");
console.log(`  legacy          ${legacySql()}`);
console.log(`  restructured    ${freshSql()}`);
console.log(`· ready in ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
