/**
 * Durability checks for data/backups.json - the only record of what this machine looked
 * like before PingLab changed it.
 *
 * The app reads its data folder from the working directory, so this runs in a throwaway
 * folder: `node lib/backups.test.mjs` must never touch the real data/backups.json.
 *
 * Covered: the atomic replace (no half-written file, no temp files left behind), an
 * unreadable file never being reported as "no restore points", a copy of it being kept,
 * writes refusing to overwrite it, and a write that cannot happen leaving the old file
 * alone.
 */
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "pinglab-backups-"));
const dataDir = join(dir, "data");
const file = join(dataDir, "backups.json");
const previousCwd = process.cwd();
process.chdir(dir); // DATA_DIR is derived from the working directory when tweaks.mjs loads
const tw = await import("../lib/tweaks.mjs");

const empty = () => ({ dns: {}, planPower: {}, nicPower: {}, nagle: {}, adapterTuning: {}, wifiOrder: {}, history: [] });
const files = () => (existsSync(dataDir) ? readdirSync(dataDir).sort() : []);
const temps = () => files().filter((n) => n.endsWith(".tmp"));
const corruptCopies = () => files().filter((n) => n.startsWith("backups.corrupt-"));
const read = () => readFileSync(file, "utf8");

// 1. First run: a missing file is empty, not a problem.
assert.equal(tw.backupStatus().ok, true, "a missing backups.json is not an error");
assert.equal(tw.backupStatus().problem, null);
assert.equal(tw.pendingTweaks().count, 0);
assert.equal(tw.pendingTweaks().problem, null);

// 2. A write leaves one valid file and no temporary files behind.
{
  const b = empty();
  b.dns["Wi-Fi"] = { servers: ["192.168.1.1"], at: "2026-01-01T00:00:00.000Z" };
  tw.writeBackups(b);
  assert.deepEqual(files(), ["backups.json"], "one file, no leftovers");
  assert.deepEqual(tw.readBackups().dns["Wi-Fi"].servers, ["192.168.1.1"]);
  assert.equal(read().endsWith("\n"), true, "the file ends with a newline");

  b.dns["Wi-Fi"].servers = ["1.1.1.1"];
  tw.writeBackups(b);
  assert.deepEqual(files(), ["backups.json"], "replacing keeps one file");
  assert.deepEqual(tw.readBackups().dns["Wi-Fi"].servers, ["1.1.1.1"], "the new content is in place");
  assert.equal(tw.pendingTweaks().count, 1, "the record is counted");
}

// 3. An unreadable file is unknown, never empty: a copy is kept, the count is not claimed,
//    and every write refuses to touch the original bytes.
{
  const broken = '{"dns": {"Wi-Fi": {"servers": ["192.168.1.1"], "at": "20';
  writeFileSync(file, broken, "utf8");
  const status = tw.backupStatus();
  assert.equal(status.ok, false, "a truncated file is a problem");
  assert.match(status.problem.detail, /not valid JSON/);
  assert.equal(status.problem.file, "data/backups.json");
  assert.ok(status.problem.copy, "the unreadable file is copied aside");
  assert.equal(readFileSync(join(dir, status.problem.copy), "utf8"), broken, "the copy holds the original bytes");
  assert.match(status.problem.message, /unknown, not empty/);

  assert.equal(tw.pendingTweaks().problem.message, status.problem.message, "the surfaces get the same sentence");

  assert.throws(() => tw.writeBackups(empty()), /Refusing to change anything/, "a write refuses to overwrite it");
  assert.equal(read(), broken, "the original bytes are untouched");
  assert.deepEqual(temps(), [], "a refused write leaves no temporary file");

  // Reading again must not pile up one copy per read.
  tw.backupStatus();
  tw.pendingTweaks();
  assert.equal(corruptCopies().length, 1, "one copy per broken file, not one per read");
}

// 4. A file that parses but cannot be used is the same kind of problem, not a crash.
{
  const cases = [
    ["[]", /does not hold a JSON object/],
    ["null", /does not hold a JSON object/],
    ['{"history": {}}', /unexpected value for "history"/],
    ['{"dns": []}', /unexpected value for "dns"/],
    ["", /not valid JSON/],
  ];
  for (const [text, expected] of cases) {
    writeFileSync(file, text, "utf8");
    const status = tw.backupStatus();
    assert.equal(status.ok, false, `${JSON.stringify(text)} must be reported`);
    assert.match(status.problem.detail, expected);
    assert.equal(tw.pendingTweaks().count, 0, "no count is invented from an unreadable file");
  }
}

// 5. Repairing the file clears the problem without restarting: the file is re-read when its
//    size or modification time changes.
{
  const repaired = empty();
  repaired.planPower["Wi-Fi"] = { ac: 1, dc: 2, at: "2026-01-01T00:00:00.000Z" };
  writeFileSync(file, `${JSON.stringify(repaired, null, 2)}\n`, "utf8");
  assert.equal(tw.backupStatus().ok, true, "a repaired file is read again");
  assert.equal(tw.pendingTweaks().count, 1);
  assert.equal(tw.pendingTweaks().items[0].restoreWillSet, "AC 1 · battery 2");
}

// 6. A write that the filesystem refuses (read-only file, locked by another program,
//    full disk) throws with a sentence instead of leaving a partial file. Windows is the
//    target here; on POSIX a read-only file can still be replaced by its folder owner, so
//    this half is asserted only where it means something.
if (process.platform === "win32") {
  const before = read();
  chmodSync(file, 0o444);
  try {
    assert.throws(() => tw.writeBackups(empty()), /Could not save the restore points/);
    assert.equal(read(), before, "the previous restore points survive a failed write");
    assert.deepEqual(temps(), [], "the temporary file is cleaned up");
  } finally {
    chmodSync(file, 0o666);
  }
  tw.writeBackups(empty());
  assert.equal(tw.pendingTweaks().count, 0, "writing works again once the file is writable");
}

console.log("\nbackups");
console.log(`  folder       ${dataDir}`);
console.log(`  files        ${files().join(", ") || "(none)"}`);
console.log("  atomic       one file, no .tmp leftovers, previous content kept on a refused write");
console.log("  unreadable   copied aside, reported as unknown, refuses every write");
console.log("\nall backup checks passed");

process.chdir(previousCwd);
rmSync(dir, { recursive: true, force: true });
