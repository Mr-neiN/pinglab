/**
 * A history database that had to be set aside has to be visible where a user actually looks.
 *
 * It used to be reported only by `--audit` and `--self-check`, so someone who simply started
 * the desktop GUI or opened the web page got a working app with silently empty history. These
 * cases drive the two normal entry points against a data folder holding a text file where
 * `pinglab.sqlite` belongs:
 *
 *   web      GET /api/state carries the report, so the page can show it above the verdict
 *   gui      the bridge's "state" answer carries it, so the GUI status row can show it
 *   tui      the terminal dashboard draws it above the view, where `--once` can be read
 *
 * Each case has its own throwaway data folder, so each proves the recovery and the report on
 * its own. Nothing outside the temp folders is touched, and nothing is changed on this machine.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const junk = "this is not a database, it is a text file someone put in the wrong place\n";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dirs = [];

/** A data folder with the damage already in it, and nothing else. */
function damagedDataDir() {
  const root = mkdtempSync(join(tmpdir(), "pinglab-dbwarn-"));
  dirs.push(root);
  const dataDir = join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "pinglab.sqlite"), junk, "utf8");
  return dataDir;
}

const copiesIn = (dir) => readdirSync(dir).filter((f) => /^pinglab\.corrupt-.*\.sqlite$/.test(f)).sort();

/** Every surface must report the same thing: what was wrong, which copy holds the bytes, what took its place. */
function assertReported(report, dataDir, label) {
  assert.equal(report?.ok, false, `${label}: the damaged database must be reported`);
  assert.match(String(report?.problem?.detail || ""), /not a database/i, `${label}: the reason is SQLite's`);
  assert.equal(report.problem.file, join(dataDir, "pinglab.sqlite"), `${label}: the file is named`);
  const copies = copiesIn(dataDir);
  assert.equal(copies.length, 1, `${label}: exactly one copy is kept (${copies.join(", ") || "none"})`);
  assert.equal(report.problem.copy, join(dataDir, copies[0]), `${label}: the report names that copy`);
  assert.equal(readFileSync(report.problem.copy, "utf8"), junk, `${label}: the copy holds the original bytes`);
  assert.match(String(report.problem.message), /A copy was kept as/, `${label}: the warning names the copy`);
  assert.equal(existsSync(join(dataDir, "pinglab.sqlite")), true, `${label}: a usable database took its place`);
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

/** A GET with the headers set by hand, the way the page's own fetch sends them. */
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

async function stop(child) {
  if (!child.killed) child.kill();
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    setTimeout(resolve, 3000);
  });
}

/** The real server, on a spare loopback port, using its own data folder. */
async function startServer(dataDir) {
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, "server.mjs")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), PINGLAB_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (b) => (log += b));
  child.stderr.on("data", (b) => (log += b));
  const until = Date.now() + 20_000;
  for (;;) {
    try {
      const page = await get(port, "/", { host: `127.0.0.1:${port}` });
      if (page.status === 200) return { port, child, page, log: () => log };
    } catch (err) {
      if (err.code !== "ECONNREFUSED" && err.code !== "ECONNRESET") throw err;
    }
    if (child.exitCode !== null) throw new Error(`server exited with ${child.exitCode}:\n${log}`);
    if (Date.now() > until) throw new Error(`server did not start on 127.0.0.1:${port}:\n${log}`);
    await sleep(150);
  }
}

/**
 * The terminal dashboard, as the person starting `node pinglab.mjs` sees it. `--once` draws the
 * same frame the interactive TUI redraws, without needing a terminal, so what it prints is
 * what the dashboard shows.
 */
async function dashboardOnce(dataDir) {
  const child = spawn(process.execPath, [join(ROOT, "pinglab.mjs"), "--once"], {
    cwd: ROOT,
    env: { ...process.env, PINGLAB_DATA_DIR: dataDir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  let err = "";
  child.stdout.on("data", (b) => (out += b));
  child.stderr.on("data", (b) => (err += b));
  const code = await new Promise((resolve) => {
    child.once("exit", resolve);
    setTimeout(() => {
      child.kill();
      resolve(null);
    }, 120_000);
  });
  // Colour is not what this checks, and the terminal escape codes would break the matches.
  return { code, err, out: out.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "") };
}

/** The desktop GUI's protocol: one JSON request on stdin, one JSON answer appended to `--out`. */
async function bridgeState(dataDir) {
  const out = join(dataDir, "..", "bridge.jsonl");
  const child = spawn(process.execPath, [join(ROOT, "pinglab.mjs"), "--bridge", "--out", out], {
    cwd: ROOT,
    env: { ...process.env, PINGLAB_DATA_DIR: dataDir },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (b) => (log += b));
  child.stderr.on("data", (b) => (log += b));
  child.stdin.write(`${JSON.stringify({ id: "1", cmd: "state" })}\n`);
  const until = Date.now() + 120_000;
  try {
    for (;;) {
      if (existsSync(out)) {
        const lines = readFileSync(out, "utf8").split("\n").filter((line) => line.trim());
        if (lines.length) {
          const answer = JSON.parse(lines[0]);
          assert.equal(answer.ok, true, `gui: the bridge refused "state" (${answer.error})`);
          return answer.data;
        }
      }
      if (child.exitCode !== null) throw new Error(`the bridge exited with ${child.exitCode}:\n${log}`);
      if (Date.now() > until) throw new Error(`the bridge never answered "state":\n${log}`);
      await sleep(150);
    }
  } finally {
    await stop(child);
  }
}

try {
  /* 1. The page's data: /api/state has to carry the warning the page draws above the verdict. */
  const webDir = damagedDataDir();
  const server = await startServer(webDir);
  try {
    const token = server.page.text.match(/<meta name="pinglab-token" content="([^"]+)"/)?.[1];
    assert.ok(token, "web: the page carries this run's token");
    const res = await get(server.port, "/api/state", {
      host: `127.0.0.1:${server.port}`,
      "x-pinglab-token": token,
    });
    assert.equal(res.status, 200, `web: /api/state answered ${res.status} ${res.text.slice(0, 160)}`);
    const body = JSON.parse(res.text);
    assertReported(body.history, webDir, "web");
  } finally {
    await stop(server.child);
  }

  /* 2. The GUI's data: the same report over the bridge, which is what its status row reads. */
  const guiDir = damagedDataDir();
  const state = await bridgeState(guiDir);
  assertReported(state.history, guiDir, "gui");

  /* 3. The terminal dashboard: `--once` draws the frame the interactive TUI draws, so the
   *    warning has to be in it, above the view a user starts on. */
  const tuiDir = damagedDataDir();
  const frame = await dashboardOnce(tuiDir);
  assert.equal(frame.code, 0, `tui: --once exited ${frame.code}: ${frame.err}`);
  const copies = copiesIn(tuiDir);
  assert.equal(copies.length, 1, `tui: exactly one copy is kept (${copies.join(", ") || "none"})`);
  const flat = frame.out.replace(/\s+/g, " ");
  assert.match(flat, /network doctor/, "tui: this is the dashboard, not one of the plain-text modes");
  assert.match(flat, /Connection/, "tui: the overview is drawn");
  assert.match(flat, /file is not a database/, "tui: the dashboard says why the history is gone");
  assert.ok(flat.includes(copies[0]), `tui: it names the copy that holds the old history (${copies[0]})`);
  assert.match(flat, /A new, empty database was started/, "tui: and what took its place");
  const warningAt = flat.indexOf("is not a database");
  const viewAt = flat.indexOf("Overview");
  assert.ok(warningAt > 0 && viewAt > warningAt, "tui: the warning sits above the view, where it is read first");

  console.log("\ndb warning");
  console.log(`  web          /api/state reports ${JSON.stringify(state.history.problem.detail)}`);
  console.log("  gui          bridge state reports the same problem, copy and fresh database");
  console.log("  tui          the dashboard draws it above the overview, naming the copy");
  console.log("  message      every surface carries the sentence the others print");
  console.log("\nall database warning checks passed");
} finally {
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* a leftover temp folder is not a failed check */
    }
  }
}
