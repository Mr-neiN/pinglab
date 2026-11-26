/**
 * The GUI's bridge protocol: one JSON request per line in, one answer per line in the file.
 *
 * Windows PowerShell writes the first stdin line on the runner with a UTF-8 byte-order mark.
 * The engine used to keep that mark in the line, fail to parse it, and drop the request
 * without an answer - the window then sat on "Reading system state..." while every later
 * command worked. The first request must survive a preamble, and answers must be routed by
 * the id they carry: a delayed answer may never be handed to a different request.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "pinglab-bridge-"));
const out = join(dir, "answers.jsonl");
const child = spawn(process.execPath, [join(ROOT, "pinglab.mjs"), "--bridge", "--out", out], {
  cwd: ROOT,
  env: { ...process.env, PINGLAB_DATA_DIR: dir },
  stdio: ["pipe", "ignore", "ignore"],
});

const line = (message) => JSON.stringify(message) + "\r\n";

try {
  // The BOM is what the runner's PowerShell put in front of the first message.
  child.stdin.write("\uFEFF" + line({ id: "first", cmd: "soakStatus", args: {} }));
  child.stdin.write(line({ id: "second", cmd: "soakStatus", args: {} }));

  const deadline = Date.now() + 10_000;
  let answers = [];
  while (Date.now() < deadline) {
    try {
      answers = readFileSync(out, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((text) => JSON.parse(text));
    } catch {
      answers = [];
    }
    if (answers.length >= 2) break;
    await new Promise((r) => setTimeout(r, 50));
  }

  assert.deepEqual(
    answers.map((a) => a.id),
    ["first", "second"],
    "both requests are answered, including the one behind a byte-order mark",
  );
  assert.equal(answers[0].ok, true, "the BOM-prefixed request succeeded");
  assert.equal(answers[0].data.soak !== undefined, true, "its answer is the soak status it asked for");

  console.log("\ngui bridge");
  console.log("  preamble     a BOM-prefixed first request is parsed, not dropped");
  console.log("  routing      every answer names the request it belongs to");
  console.log("\nall GUI bridge checks passed");
} finally {
  child.kill();
  await new Promise((r) => child.once("exit", r));
  rmSync(dir, { recursive: true, force: true });
}
