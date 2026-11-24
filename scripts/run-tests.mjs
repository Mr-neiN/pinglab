#!/usr/bin/env node
/**
 * Run every `lib/*.test.mjs` suite and say which ones failed.
 *
 * The list of suites is not repeated in the workflows any more: a test added next to a fix is
 * picked up here, so it cannot stay out of CI the way a hand-written list lets it. Each suite
 * runs as its own process, in file name order, with its output passed straight through, and a
 * failure does not stop the rest - one run says everything that is broken.
 *
 * Usage:
 *   node scripts/run-tests.mjs            every suite
 *   node scripts/run-tests.mjs config wifi  only the suites whose file name contains one of
 *                                          these (for a quick loop while working)
 */
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LIB = join(ROOT, "lib");

const all = readdirSync(LIB)
  .filter((name) => name.endsWith(".test.mjs"))
  .sort();
const filters = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const picked = filters.length ? all.filter((name) => filters.some((f) => name.includes(f))) : all;

if (!picked.length) {
  console.error(`No suite matches ${filters.join(", ")}. Suites: ${all.join(", ")}`);
  process.exit(1);
}

const failed = [];
const startedAt = Date.now();
for (const name of picked) {
  process.stdout.write(`\n=== ${name} ===\n`);
  const at = Date.now();
  const run = spawnSync(process.execPath, [join(LIB, name)], { stdio: "inherit" });
  const seconds = ((Date.now() - at) / 1000).toFixed(1);
  if (run.status === 0) {
    process.stdout.write(`--- ${name}: passed (${seconds}s)\n`);
  } else {
    failed.push(name);
    const how = run.signal ? `signal ${run.signal}` : `exit ${run.status}`;
    process.stdout.write(`--- ${name}: FAILED (${how}) after ${seconds}s\n`);
  }
}

const total = ((Date.now() - startedAt) / 1000).toFixed(1);
process.stdout.write(`\n${picked.length - failed.length}/${picked.length} suites passed in ${total}s\n`);
if (failed.length) {
  process.stdout.write(`failed: ${failed.join(", ")}\n`);
  process.exit(1);
}
