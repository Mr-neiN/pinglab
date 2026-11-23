/**
 * How an elevated script reaches administrator PowerShell.
 *
 * 1.0.11 wrote the script to `<data>\tmp\<id>.ps1` and handed that path to Windows with
 * `-Verb RunAs`. The folder belongs to the user, so the file could be replaced between the
 * write and the prompt, and the replacement ran elevated. These cases pin the replacement:
 * the script travels over a pipe this process owns, nothing is written to disk, and a result
 * that does not answer this exact call is discarded.
 *
 * The real bootstrap PowerShell is spawned here, but without the RunAs verb - that needs a
 * prompt nobody can click in a test run. Everything except the UAC hop is the shipped code
 * path: the same encoded bootstrap, the same pipe, the same result format.
 *
 * The cases use a throwaway folder as PINGLAB_DATA_DIR, so the "nothing appears on disk"
 * check is about a folder this test can account for completely.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { acceptsResult, encodeCommand, openChannel } from "./elevation-channel.mjs";

const isWindows = process.platform === "win32";
process.env.PINGLAB_DATA_DIR = mkdtempSync(join(tmpdir(), "pinglab-elevation-"));
const dataDir = process.env.PINGLAB_DATA_DIR;

let PS_EXE = null;
if (isWindows) ({ PS_EXE } = await import("./ps.mjs"));

const cases = [];
const test = (name, run) => cases.push({ name, run });

/** Run the exact bootstrap the elevated process receives, minus the RunAs verb. */
function runBootstrap(encoded) {
  return new Promise((resolve) => {
    execFile(
      PS_EXE,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 30000, encoding: "utf8" },
      (err, stdout, stderr) =>
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout || ""), stderr: String(stderr || "") }),
    );
  });
}

function walk(dir) {
  const found = [];
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(path));
    else if (entry.isFile()) found.push(path);
  }
  return found;
}

test("the elevated side runs the script it is sent over the pipe", async () => {
  const token = `pl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const channel = await openChannel(
    `$result = [ordered]@{ ok = $true; message = 'ran from the channel'; token = '${token}' }`,
  );
  const { code, stderr } = await runBootstrap(encodeCommand(channel.bootstrap));
  const payload = await channel.result(5000);
  const nonce = channel.nonce;
  channel.close();

  assert.equal(code, 0, `the bootstrap must exit cleanly, it said: ${stderr}`);
  assert.equal(payload?.nonce, nonce, "the answer must belong to this call");
  assert.equal(payload?.result?.token, token, "the script really executed");
  assert.equal(payload?.result?.ok, true);
});

test("the script never exists as a file, before, during or after the call", async () => {
  // A fresh token, so finding it anywhere under the data folder would mean it was written.
  const token = `disk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const channel = await openChannel(`$result = [ordered]@{ ok = $true; message = '${token}' }`);
  const { code } = await runBootstrap(encodeCommand(channel.bootstrap));
  await channel.result(5000);
  channel.close();

  assert.equal(code, 0);
  const files = walk(dataDir);
  assert.deepEqual(
    files.filter((f) => /\.ps1$|\.out\.json$/.test(f)),
    [],
    "elevation must not leave a script or a result file behind",
  );
  for (const file of files) {
    assert.equal(readFileSync(file, "utf8").includes(token), false, `${file} contains the script text`);
  }
});

test("a planted script in the data folder is neither run nor touched", async () => {
  mkdirSync(join(dataDir, "tmp"), { recursive: true });
  const planted = join(dataDir, "tmp", "t1.ps1");
  const plantedResult = join(dataDir, "tmp", "t1.out.json");
  writeFileSync(planted, "$result = [ordered]@{ ok = $true; message = 'swapped by someone else' }", "utf8");
  writeFileSync(plantedResult, JSON.stringify({ ok: true, message: "forged" }), "utf8");
  const before = statSync(planted).mtimeMs;

  const channel = await openChannel("$result = [ordered]@{ ok = $true; message = 'the real script' }");
  const { code } = await runBootstrap(encodeCommand(channel.bootstrap));
  const payload = await channel.result(5000);
  channel.close();

  assert.equal(code, 0);
  assert.equal(payload?.result?.message, "the real script", "the planted file must not decide what runs");
  assert.equal(readFileSync(planted, "utf8").includes("swapped by someone else"), true, "the planted file is left as it was");
  assert.equal(readFileSync(plantedResult, "utf8").includes("forged"), true, "a result file is not consulted");
  assert.equal(statSync(planted).mtimeMs, before);
});

test("with no channel listening the elevated side fails instead of falling back", async () => {
  const channel = await openChannel("$result = [ordered]@{ ok = $true; message = 'unreachable' }");
  const encoded = encodeCommand(channel.bootstrap);
  channel.close(); // the app is gone: nothing is serving the script

  const { code } = await runBootstrap(encoded);
  assert.notEqual(code, 0, "there is no file to fall back to, so this must fail");
  assert.equal(await channel.result(0), null, "and the caller gets no result to trust");
});

test("only a result carrying this call's nonce is accepted", () => {
  const nonce = "a".repeat(32);
  assert.equal(acceptsResult({ nonce, result: { ok: true } }, nonce), true);
  assert.equal(acceptsResult({ nonce: "b".repeat(32), result: { ok: true } }, nonce), false);
  assert.equal(acceptsResult({ nonce, result: "done" }, nonce), false);
  assert.equal(acceptsResult(null, nonce), false);
});

test("the elevated launch names the system PowerShell by full path", () => {
  if (!isWindows) return;
  assert.equal(isAbsolute(PS_EXE), true, "a bare name is resolved through the current folder first");
  assert.equal(existsSync(PS_EXE), true);
  assert.match(PS_EXE, /[\\/]System32[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/i);
});

/* --------------------------------------------------------------------- run */

try {
  for (const c of cases) await c.run();
  console.log("\nelevation channel");
  console.log(`  cases        ${cases.length}`);
  console.log("  transport    the script arrives over a one-shot pipe the app owns; nothing is written to disk");
  console.log("  tampering    a planted .ps1 or .out.json in the data folder is never run or read");
  console.log("  fail closed  no listener means no elevated run, never a file fallback");
  console.log("  result       accepted only with this call's nonce; the elevated side is System32's powershell.exe");
} finally {
  rmSync(dataDir, { recursive: true, force: true });
}
