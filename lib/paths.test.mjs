/**
 * Where PingLab keeps its data.
 *
 * 1.0.2 wrote into `<app>\data`, so an uninstall could not remove the folder the installer
 * created: the restore points and the database stayed in it and stranded the directory. These
 * cases pin the folder rules that fix that, on described folder layouts rather than on this
 * machine:
 *
 *   installed copy    a per-user folder, never inside the program folder
 *   old install       the files 1.0.2 left next to the program are carried over once
 *   old transient     its scratch files are deleted, so the old folder never survives
 *   checkout          `data\` beside the code, which is what the developer docs describe
 *   PINGLAB_DATA_DIR  always wins, and never adopts anything from the app folder
 *
 * paths.mjs decides the folder from its own location, so each case gets its own copy of it.
 */
import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE = fileURLToPath(new URL("./paths.mjs", import.meta.url));
const saved = { ...process.env };
let n = 0;

/** Load a fresh paths.mjs from `root`, as if that were the folder the app runs from. */
async function loadFrom(root, env) {
  mkdirSync(join(root, "lib"), { recursive: true });
  copyFileSync(SOURCE, join(root, "lib", "paths.mjs"));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // A query string makes Node treat it as a different module, so the folder is decided again.
  return import(`${pathToFileURL(join(root, "lib", "paths.mjs")).href}?case=${(n += 1)}`);
}

function appRoot() {
  return mkdtempSync(join(tmpdir(), "pinglab-paths-"));
}

const cases = [];
const test = (name, run) => cases.push({ name, run });

test("installed copy: data lives in the per-user folder, not in the program folder", async () => {
  const root = appRoot();
  const home = appRoot();
  const { DATA_DIR } = await loadFrom(root, { PINGLAB_DATA_DIR: undefined, LOCALAPPDATA: home });
  assert.equal(DATA_DIR, join(home, "PingLab"));
  assert.equal(existsSync(DATA_DIR), true, "the folder must exist before the first write");
  assert.equal(existsSync(join(root, "data")), false, "nothing may be created in the program folder");
});

test("old install: the files left beside the program are carried over and then removed", async () => {
  const root = appRoot();
  const home = appRoot();
  mkdirSync(join(root, "data", "tmp"), { recursive: true });
  writeFileSync(join(root, "data", "backups.json"), '{"dns":{},"history":[]}', "utf8");
  writeFileSync(join(root, "data", "pinglab.sqlite"), "sqlite-bytes", "utf8");

  const { DATA_DIR } = await loadFrom(root, { PINGLAB_DATA_DIR: undefined, LOCALAPPDATA: home });
  assert.equal(DATA_DIR, join(home, "PingLab"));
  assert.equal(
    readFileSync(join(DATA_DIR, "backups.json"), "utf8"),
    '{"dns":{},"history":[]}',
    "restore points are the only way back from a change, so an upgrade must carry them",
  );
  assert.equal(readFileSync(join(DATA_DIR, "pinglab.sqlite"), "utf8"), "sqlite-bytes");
  assert.equal(existsSync(join(root, "data")), false, "the stranded folder must be gone, so the uninstaller can remove {app}");
});

test("old install: the transient files do not keep the old folder", async () => {
  const root = appRoot();
  const home = appRoot();
  mkdirSync(join(root, "data", "tmp"), { recursive: true });
  writeFileSync(join(root, "data", "backups.json"), '{"dns":{},"history":[]}', "utf8");
  writeFileSync(join(root, "data", "bridge-out.4321.jsonl"), '{"id":1}\n', "utf8");
  writeFileSync(join(root, "data", "gui.log"), "script start", "utf8");
  writeFileSync(join(root, "data", ".backups-99-ab12.tmp"), '{"half":true}', "utf8");
  writeFileSync(join(root, "data", "tmp", "t1.ps1"), "# elevated call", "utf8");
  writeFileSync(join(root, "data", "tmp", "t1.out.json"), "{}", "utf8");

  const { DATA_DIR } = await loadFrom(root, { PINGLAB_DATA_DIR: undefined, LOCALAPPDATA: home });
  assert.equal(
    readFileSync(join(DATA_DIR, "backups.json"), "utf8"),
    '{"dns":{},"history":[]}',
    "deleting the scratch must not disturb the restore points",
  );
  assert.equal(existsSync(join(root, "data")), false, "bridge files, gui.log and tmp\\ all go, so the folder goes");
});

test("old install: an unrecognised file is never deleted", async () => {
  const root = appRoot();
  const home = appRoot();
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data", "backups.json"), '{"dns":{},"history":[]}', "utf8");
  writeFileSync(join(root, "data", "notes.txt"), "mine", "utf8");

  const { DATA_DIR } = await loadFrom(root, { PINGLAB_DATA_DIR: undefined, LOCALAPPDATA: home });
  assert.equal(readFileSync(join(DATA_DIR, "backups.json"), "utf8"), '{"dns":{},"history":[]}');
  assert.equal(readFileSync(join(root, "data", "notes.txt"), "utf8"), "mine", "the folder survives rather than losing a file we did not write");
});

test("old install: a file that is already in the per-user folder is not overwritten", async () => {
  const root = appRoot();
  const home = appRoot();
  mkdirSync(join(home, "PingLab"), { recursive: true });
  writeFileSync(join(home, "PingLab", "backups.json"), '{"newer":true}', "utf8");
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data", "backups.json"), '{"older":true}', "utf8");

  const { DATA_DIR } = await loadFrom(root, { PINGLAB_DATA_DIR: undefined, LOCALAPPDATA: home });
  assert.equal(readFileSync(join(DATA_DIR, "backups.json"), "utf8"), '{"newer":true}', "the live record wins");
  assert.equal(
    existsSync(join(root, "data", "backups.json")),
    true,
    "a file that was not copied must not be deleted: it is still a restore point",
  );
});

test("checkout: data stays beside the code", async () => {
  const root = appRoot();
  const home = appRoot();
  mkdirSync(join(root, ".git"), { recursive: true });
  const { DATA_DIR } = await loadFrom(root, { PINGLAB_DATA_DIR: undefined, LOCALAPPDATA: home });
  assert.equal(DATA_DIR, join(root, "data"));
  assert.equal(existsSync(join(home, "PingLab")), false, "a checkout must not write into the user profile");
});

test("PINGLAB_DATA_DIR wins over everything and adopts nothing", async () => {
  const root = appRoot();
  const home = appRoot();
  const chosen = appRoot();
  mkdirSync(join(root, "data"), { recursive: true });
  writeFileSync(join(root, "data", "backups.json"), '{"legacy":true}', "utf8");

  const { DATA_DIR } = await loadFrom(root, { PINGLAB_DATA_DIR: chosen, LOCALAPPDATA: home });
  assert.equal(DATA_DIR, chosen);
  assert.equal(existsSync(join(root, "data", "backups.json")), true, "an explicit folder is not a migration");
  assert.equal(existsSync(join(home, "PingLab")), false);
});

/* --------------------------------------------------------------------- run */

try {
  for (const c of cases) await c.run();
  console.log("\npaths");
  console.log(`  cases        ${cases.length}`);
  console.log("  installed    per-user folder, program folder untouched");
  console.log("  upgrade      old <app>\\data carried over once, never overwriting or deleting a live record");
  console.log("  transient    bridge files, gui.log and tmp\\ deleted so the old folder always goes");
  console.log("  checkout     data beside the code; PINGLAB_DATA_DIR overrides both");
} finally {
  process.env = saved; // the cases above rewrote LOCALAPPDATA and PINGLAB_DATA_DIR
}
