/**
 * The desktop GUI is loaded from `gui/*.ps1` by `PingLab.ps1`; this pins that the split moved
 * the window's PowerShell without editing it.
 *
 * The fixture is the SHA-256 of the concatenated modules (in the entry point's load order)
 * plus the code after the `# --- entry point` marker, with the single `$root = $PSScriptRoot`
 * line that moved into the loader removed. That is exactly the pre-split file, so matching
 * the hash proves every other byte is still there, in order, unchanged.
 *
 * Line endings are normalised to LF before hashing: Git on Windows may check the same commit
 * out with CRLF (core.autocrlf), and that is a checkout setting, not a change to the script.
 * `.gitattributes` asks for LF, and this keeps the test honest even where it is ignored.
 *
 * An intentional GUI change makes this fail; regenerate the fixture in the same commit with
 * `node lib/ps1-split.test.mjs --update`, which rewrites the snapshot from the current files.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const ENTRY = join(ROOT, "PingLab.ps1");
const FIXTURE = join(ROOT, "lib", "pinglab-ps1.snapshot.json");
const MARKER = "# --- entry point";

const sha = (text) => createHash("sha256").update(text).digest("hex");
const lf = (text) => text.replace(/\r\n/g, "\n");
const loader = lf(readFileSync(ENTRY, "utf8"));

const rootLine = /^\$root = \$PSScriptRoot\r?$/gm;
assert.equal((loader.match(rootLine) || []).length, 1, "the entry point assigns $root exactly once");

const modules = [...loader.matchAll(/^\. \(Join-Path \$root '([^']+)'\)\r?$/gm)].map((m) => m[1]);
assert.ok(modules.length >= 10, `the entry point loads the GUI modules (found ${modules.length})`);

const markerAt = loader.indexOf(MARKER);
assert.ok(markerAt >= 0, "the entry point has its marker before the start-up code");
const tail = loader.slice(markerAt + MARKER.length).replace(/^\r?\n/, "");

const bodies = modules.map((name) => lf(readFileSync(join(ROOT, name.replace(/\\/g, "/")), "utf8")));
for (const [i, body] of bodies.entries()) {
  assert.equal(body.includes("$PSScriptRoot"), false, `${modules[i]} must not compute its own $root`);
}
const moved = bodies.join("") + tail;

if (process.argv.includes("--update")) {
  const files = modules.map((name, i) => ({
    path: name.replace(/\\/g, "/"),
    lines: bodies[i].split(/\r?\n/).length - 1,
  }));
  writeFileSync(
    FIXTURE,
    JSON.stringify(
      {
        note: "SHA-256 (LF line endings) of the concatenated gui/*.ps1 modules (entry-point order) plus the entry point's tail, with `$root = $PSScriptRoot` moved to the loader. lib/ps1-split.test.mjs reassembles the same text and compares. Regenerate with `node lib/ps1-split.test.mjs --update` after an intentional GUI change.",
        sha256: sha(moved),
        bytes: Buffer.byteLength(moved, "utf8"),
        files,
      },
      null,
      2,
    ) + "\n",
  );
}

const snapshot = JSON.parse(readFileSync(FIXTURE, "utf8"));
assert.equal(Buffer.byteLength(moved, "utf8"), snapshot.bytes, "the moved PowerShell has the same byte count as the pre-split file");
assert.equal(sha(moved), snapshot.sha256, "the moved PowerShell is byte-identical to the pre-split file");
assert.deepEqual(
  modules.map((name) => name.replace(/\\/g, "/")),
  snapshot.files.map((f) => f.path),
  "the entry point loads exactly the snapshot's modules, in order",
);

const lineCounts = modules.map((name, i) => ({ path: name, lines: bodies[i].split(/\r?\n/).length - 1 }));
const largest = lineCounts.reduce((a, b) => (b.lines > a.lines ? b : a));
assert.ok(largest.lines < 600, `no module may stay a monolith (largest: ${largest.path}, ${largest.lines} lines)`);
assert.ok(loader.split(/\r?\n/).length < 150, `the entry point stays an entry point (${loader.split(/\r?\n/).length} lines)`);

console.log("\nGUI module split");
console.log(`  modules      ${modules.length} files loaded in order, largest ${largest.path} (${largest.lines} lines)`);
console.log(`  bytes        ${snapshot.bytes} bytes byte-identical to the pre-split file`);
console.log("  entry point  only $root plus the dot-source list, then the start-up code");
console.log("\nall GUI split checks passed");
