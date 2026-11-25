/**
 * One version, everywhere.
 *
 * The app reports its version from `package.json`, the release workflow tags a commit and refuses
 * to publish unless that file says the same number, and `installer/build.ps1` refuses to build a
 * package whose version differs from it. A copy that says 1.0.19 while carrying 1.0.20's fixes
 * cannot be told apart from the real 1.0.19 by the update check - it would be offered an upgrade
 * it already has, or told it is current while it is not.
 *
 * This suite pins the chain instead of trusting it:
 *
 *   source      package.json says a version update.mjs can parse and reports as its own
 *   shipped     the page and the API carry that same number, so a stale install is visible
 *   installer   pinglab.iss has no numeric version of its own (it includes the generated one)
 *   guards      the workflow and the build both refuse a tag/package mismatch
 *   refused     running the real build with a different version exits non-zero and writes nothing
 *
 * The build check runs the shipped PowerShell with -SkipInstaller: it is the guard itself, not a
 * copy of its rule.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { currentVersion, isNewer, parseVersion } from "./update.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

console.log("version synchronization");

/* ------------------------------------------------------------------ source */
{
  assert.equal(parseVersion(pkg.version) !== null, true, `package.json holds a release version (got ${pkg.version})`);
  assert.equal(currentVersion(), pkg.version, "the update check reports the version package.json says");
  assert.equal(isNewer(`v${pkg.version}`, pkg.version), false, "this copy is not newer than itself");
  console.log(`  source       package.json and lib/update.mjs agree on ${pkg.version}`);
}

/* ----------------------------------------------------------------- shipped */
function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
}

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

const dir = mkdtempSync(join(tmpdir(), "pinglab-version-"));
const dataDir = join(dir, "data");
let child = null;
try {
  const port = await freePort();
  child = spawn(process.execPath, [join(ROOT, "server.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      PINGLAB_DATA_DIR: dataDir,
      PINGLAB_PS_STUB: join(ROOT, "lib", "ps-fake.mjs"),
      PINGLAB_PS_SCENARIO_FILE: join(dir, "scenario.json"),
      PINGLAB_UPDATE_URL: "http://127.0.0.1:9/releases/latest",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  writeFileSync(join(dir, "scenario.json"), JSON.stringify({ adapters: [], routes: [] }), "utf8");
  let log = "";
  child.stdout.on("data", (b) => (log += b));
  child.stderr.on("data", (b) => (log += b));

  let page = null;
  const until = Date.now() + 20_000;
  for (;;) {
    try {
      page = await get(port, "/", { host: `127.0.0.1:${port}` });
      if (page.status === 200) break;
    } catch (err) {
      if (err.code !== "ECONNREFUSED" && err.code !== "ECONNRESET") throw err;
    }
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}:\n${log}`);
    if (Date.now() > until) throw new Error(`server did not start:\n${log}`);
    await sleep(150);
  }

  assert.match(page.text, /id="versionPill"/, "the page has a place to show the version");
  const token = /meta name="pinglab-token" content="([^"]+)"/.exec(page.text)?.[1];
  assert.ok(token, "the page hands out this run's API token");
  const stateRes = await get(port, "/api/state", { host: `127.0.0.1:${port}`, "X-PingLab-Token": token });
  assert.equal(stateRes.status, 200, "state reads without a problem");
  const state = JSON.parse(stateRes.text);
  assert.equal(state.version, pkg.version, "GET /api/state reports the version package.json says");
  assert.equal(state.benchPolicy?.repeats, 7, "state carries the benchmark repeat count the page quotes");
  console.log(`  shipped      /api/state and the page carry ${state.version}`);
} finally {
  if (child && !child.killed) {
    child.kill();
    await Promise.race([new Promise((r) => child.once("exit", r)), sleep(3000)]);
  }
  rmSync(dir, { recursive: true, force: true });
}

/* --------------------------------------------------------------- installer */
{
  const iss = readFileSync(join(ROOT, "installer", "pinglab.iss"), "utf8");
  assert.match(iss, /#include "version\.iss"/, "the installer includes the generated version");
  assert.match(iss, /AppVersion=\{#AppVersion\}/, "and takes its version from that include");
  assert.equal(
    /^\s*#define\s+AppVersion\s+"?\d/m.test(iss),
    false,
    "the installer has no numeric version of its own that could drift from package.json",
  );
  console.log("  installer    pinglab.iss borrows the version, it does not restate it");
}

/* ------------------------------------------------------------------ guards */
{
  const workflow = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  assert.match(workflow, /package\.json says .* but tag/, "the release workflow refuses a tag/package mismatch");
  const build = readFileSync(join(ROOT, "installer", "build.ps1"), "utf8");
  assert.match(build, /package\.json says .* but this build is/, "the build refuses a package/build mismatch");
  console.log("  guards       the tag, the build and the package are checked against each other");
}

/* ----------------------------------------------------------------- refused */
{
  const wrong = `${pkg.version.split(".")[0]}.${Number(pkg.version.split(".")[1]) + 1}.0`;
  const out = await new Promise((resolve, reject) => {
    const p = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "installer", "build.ps1"), "-Version", wrong, "-SkipInstaller"],
      { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] },
    );
    let text = "";
    p.stdout.on("data", (b) => (text += b));
    p.stderr.on("data", (b) => (text += b));
    p.on("error", reject);
    p.on("exit", (code) => resolve({ code, text }));
  });
  assert.notEqual(out.code, 0, `building ${wrong} over a ${pkg.version} package must fail (exit ${out.code})`);
  assert.match(out.text, /package\.json says/, "the refusal names the two versions");
  console.log(`  refused      a build at ${wrong} was refused before it produced anything`);
}

console.log("\nall version checks passed");
