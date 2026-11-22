/**
 * The history database must never stop PingLab from starting.
 *
 * Every surface - terminal UI, GUI, web UI, `--audit`, `--self-check` - imports lib/db.mjs
 * while it is starting, so a database file that is not a database used to take all of them
 * down with "file is not a database" before any of them could say anything.
 *
 * These cases feed it exactly that: a `pinglab.sqlite` holding text.
 *
 *   damaged     starts anyway, keeps the bad bytes aside, reports it through dbStatus()
 *   recording   the fresh database accepts writes and reads them back
 *   repeat      a second run with the same bad bytes reuses the copy instead of adding one
 *   healthy     a normal file reports no problem at all
 *
 * db.mjs and paths.mjs decide their folder at import time, so each case loads its own copy
 * of both from a throwaway app root, as paths.test.mjs does.
 */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const saved = { ...process.env };
let n = 0;

/** Load a fresh db.mjs (+ its paths.mjs) as if the app lived in `root` and kept data in `dataDir`. */
async function load(root, dataDir) {
  mkdirSync(join(root, "lib"), { recursive: true });
  copyFileSync(join(HERE, "db.mjs"), join(root, "lib", "db.mjs"));
  copyFileSync(join(HERE, "paths.mjs"), join(root, "lib", "paths.mjs"));
  copyFileSync(join(HERE, "keep-unreadable.mjs"), join(root, "lib", "keep-unreadable.mjs"));
  mkdirSync(dataDir, { recursive: true });
  process.env.PINGLAB_DATA_DIR = dataDir;
  process.env.LOCALAPPDATA = join(root, "home");
  return import(`${pathToFileURL(join(root, "lib", "db.mjs")).href}?case=${(n += 1)}`);
}

const scratch = () => mkdtempSync(join(tmpdir(), "pinglab-db-"));
const corruptCopies = (dataDir) => readdirSync(dataDir).filter((f) => /^pinglab\.corrupt-.*\.sqlite$/.test(f)).sort();

const junk = "this is not a database, it is a text file someone put in the wrong place\n";

try {
  /* 1. The damaged file: the app starts, the history is kept aside, the warning says so. */
  const root = scratch();
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "pinglab.sqlite"), junk, "utf8");

  const db = await load(root, dataDir);
  const status = db.dbStatus();
  assert.equal(status.ok, false, "a file that is not a database must be reported");
  assert.match(status.problem.detail, /not a database/i, "the reason is what SQLite said");
  assert.equal(status.problem.file, join(dataDir, "pinglab.sqlite"));
  assert.ok(status.problem.copy, "the unreadable file is kept, not thrown away");
  assert.equal(readFileSync(status.problem.copy, "utf8"), junk, "the copy holds the original bytes");
  assert.match(status.problem.message, /A copy was kept as/, "the warning names the copy");
  assert.match(status.problem.message, /new, empty database was started/i, "and says what took its place");
  assert.equal(existsSync(join(dataDir, "pinglab.sqlite")), true, "a fresh file is in place");

  /* 2. The fresh database is usable: history is recorded again, not silently dropped. */
  const id = db.saveRun("probe", "after recovery", { ms: 11 });
  assert.equal(id, 1);
  const runs = db.listRuns();
  assert.equal(runs.length, 1);
  assert.equal(runs[0].summary, "after recovery");
  assert.deepEqual(db.getSoakSamples(1), [], "the soak tables exist in the new file too");

  /* 3. A later run that finds the same bad bytes reuses the copy already kept, so the
   *    folder does not fill with identical files. */
  const reuseDir = join(root, "reuse");
  mkdirSync(reuseDir, { recursive: true });
  const earlier = "pinglab.corrupt-20260101-000000.sqlite";
  writeFileSync(join(reuseDir, "pinglab.sqlite"), junk, "utf8");
  writeFileSync(join(reuseDir, earlier), junk, "utf8");
  const again = await load(join(root, "second"), reuseDir);
  assert.equal(again.dbStatus().ok, false);
  assert.equal(again.dbStatus().problem.copy, join(reuseDir, earlier), "the same bytes reuse the copy already kept");
  assert.deepEqual(corruptCopies(reuseDir), [earlier], "exactly one copy");
  assert.equal(existsSync(join(reuseDir, "pinglab.sqlite")), true, "and a usable file takes its place");

  /* 4. A healthy database is no problem at all. */
  const clean = await load(scratch(), join(scratch(), "data"));
  assert.equal(clean.dbStatus().ok, true);
  assert.equal(clean.dbStatus().problem, null);
  assert.equal(clean.saveRun("probe", "first run", {}), 1, "a normal start records history as before");

  console.log("\ndb");
  console.log(`  damaged      ${status.problem.detail} - kept aside as ${status.problem.copy.split(/[\\/]/).pop()}`);
  console.log("  recording    the fresh database takes writes and reads them back");
  console.log("  repeat       identical bad bytes reuse the copy instead of adding another");
  console.log("  healthy      no problem reported, history recorded as before");
  console.log("\nall database checks passed");
} finally {
  process.env = saved; // the cases above rewrote PINGLAB_DATA_DIR and LOCALAPPDATA
}
