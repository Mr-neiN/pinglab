/**
 * The start-up update check.
 *
 * "Look for updates every time it starts" has one honest answer: ask GitHub's releases API for
 * the newest tag, compare it with the version in package.json, and say something only when the
 * comparison was actually made and the release is newer. This suite pins:
 *
 *   version     v1.0.10 is newer than 1.0.9, a tag with a suffix or junk is never newer
 *   available   a newer release becomes one sentence naming both versions and the releases page
 *   current     a copy that is current gets no sentence, so a normal start prints nothing
 *   unsettled   no published release, an unreadable body, a network error and a timeout all yield
 *               checked: false, no sentence, and no throw on the start-up path
 *   web         a server started against a loopback releases stub carries that sentence in
 *               /api/state, which is what the page, the GUI's bridge and the dashboard draw from
 *
 * Nothing here reaches github.com: the fetches are stubbed, and the one real request goes to a
 * server this suite runs on 127.0.0.1.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { RELEASES_URL, checkForUpdate, currentVersion, isNewer, parseVersion } from "./update.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, what, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
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

function request(port, { path = "/", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "GET", path, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(20_000, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    req.end();
  });
}

/** The fake Windows the engine reads; this suite only needs the server to start and serve. */
function writeScenario(file) {
  writeFileSync(
    file,
    JSON.stringify(
      {
        elevatedUser: false,
        adapters: [
          {
            Name: "WLAN",
            InterfaceDescription: "Intel Wi-Fi 6 AX201",
            Status: "Up",
            LinkSpeed: "1 Gbps",
            MacAddress: "AA-BB-CC-DD-EE-FF",
            ifIndex: 1,
            InterfaceGuid: "GUID-WLAN",
            DriverVersion: "1.0.0.0",
          },
        ],
        routes: [{ InterfaceAlias: "WLAN", NextHop: "192.168.1.1", RouteMetric: 25, ifIndex: 1 }],
        profiles: [{ Name: "HomeNet", InterfaceAlias: "WLAN", IPv4Connectivity: "Internet", NetworkCategory: "Private" }],
        machines: {
          WLAN: {
            guid: "GUID-WLAN",
            ack: null,
            nodelay: null,
            power: { planAc: 1, planDc: 2, ndis: "enabled", wmiEnable: true, scheme: "SCHEME-1" },
            tuning: { MIMOPowerSaveMode: 0, RoamAggressiveness: 2 },
            profile: "HomeNet",
          },
        },
        wlan: { wifi: true, joined: "HomeNet", profiles: ["HomeNet"] },
        dns: { WLAN: ["192.168.1.1"] },
        dnsStatic: { WLAN: false },
        stats: { rx: 1_000, tx: 1_000 },
      },
      null,
      2,
    ),
    "utf8",
  );
}

async function startServer(dir, port, extraEnv = {}) {
  const child = spawn(process.execPath, [join(ROOT, "server.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      PINGLAB_DATA_DIR: dir,
      PINGLAB_PS_STUB: join(ROOT, "lib", "ps-fake.mjs"),
      PINGLAB_PS_SCENARIO_FILE: join(dir, "scenario.json"),
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (b) => (log += b));
  child.stderr.on("data", (b) => (log += b));
  let page;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      page = await request(port, { path: "/" });
      break;
    } catch (err) {
      if (err.code !== "ECONNREFUSED" && err.code !== "ECONNRESET") throw err;
      if (Date.now() > deadline) throw new Error(`server did not start: ${log}`);
      await sleep(100);
    }
  }
  const token = page.text.match(/<meta name="pinglab-token" content="([^"]+)"/)?.[1];
  assert.ok(token, "the page carries the token");
  return { child, token };
}

/* ------------------------------------------------------------------- version */

console.log("version");
assert.deepEqual(parseVersion("v1.2.3"), [1, 2, 3], "a release tag parses");
assert.deepEqual(parseVersion("1.2.3"), [1, 2, 3], "the v is optional");
assert.equal(parseVersion("1.2"), null, "a two-part version is not a release tag");
assert.equal(parseVersion("v1.2.3-beta"), null, "a suffix is not this app's release format");
assert.equal(isNewer("v1.0.10", "1.0.9"), true, "the patch number is compared as a number");
assert.equal(isNewer("2.0.0", "1.9.9"), true, "the major number wins");
assert.equal(isNewer("v1.0.19", "1.0.19"), false, "the same release is not newer");
assert.equal(isNewer("1.0.18", "1.0.19"), false, "an older release is not newer");
assert.equal(isNewer("nightly", "1.0.18"), false, "junk is never newer");
assert.equal(
  currentVersion(),
  JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version,
  "the running copy reports the version in its own package.json",
);

/* ------------------------------------------------------------------ the check */

const stub = (payload, { ok = true, status = 200 } = {}) => async () => ({ ok, status, json: async () => payload });

console.log("available");
let asked = null;
const newer = await checkForUpdate({
  current: "1.0.18",
  url: "http://127.0.0.1:9/releases/latest",
  fetchImpl: async (url, init) => {
    asked = { url, init };
    return stub({ tag_name: "v1.0.19" })();
  },
});
assert.equal(asked.url, "http://127.0.0.1:9/releases/latest", "the URL is injectable, so a test never reaches GitHub");
assert.equal(asked.init.headers["user-agent"], "PingLab/1.0.18", "the request says which copy asked");
assert.equal(newer.checked, true, "the check answered");
assert.equal(newer.latest, "1.0.19");
assert.equal(newer.newer, true);
assert.match(newer.sentence, /PingLab 1\.0\.19 is available; this copy is 1\.0\.18\./, "the sentence names both versions");
assert.ok(newer.sentence.includes(RELEASES_URL), "the sentence says where to get it");

const current = await checkForUpdate({ current: "1.0.19", fetchImpl: stub({ tag_name: "v1.0.19" }) });
assert.equal(current.checked, true);
assert.equal(current.sentence, null, "a current copy has nothing to say on a normal start");

console.log("unsettled");
const notFound = await checkForUpdate({
  current: "1.0.18",
  fetchImpl: stub({ message: "Not Found" }, { ok: false, status: 404 }),
});
assert.equal(notFound.checked, false, "no published release is not a comparison");
assert.equal(notFound.sentence, null);

const unreadable = await checkForUpdate({ current: "1.0.18", fetchImpl: stub({ tag_name: "nightly" }) });
assert.equal(unreadable.checked, false, "a tag that is not a version is not compared");
assert.equal(unreadable.sentence, null);

const offline = await checkForUpdate({
  current: "1.0.18",
  fetchImpl: async () => {
    throw new Error("getaddrinfo ENOTFOUND api.github.com");
  },
});
assert.equal(offline.checked, false, "an offline machine does not fail the start");
assert.equal(offline.sentence, null, "an unanswered check never becomes an up-to-date claim");

const hung = await checkForUpdate({
  current: "1.0.18",
  timeoutMs: 50,
  fetchImpl: (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(new Error("aborted")));
    }),
});
assert.equal(hung.checked, false, "a hung request is a failed check, not a hung start");

/* ------------------------------------------------------------------------ web */

console.log("web");
const release = http.createServer((req, res) => {
  if (!String(req.headers["user-agent"] || "").startsWith("PingLab/")) {
    res.writeHead(400);
    res.end();
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ tag_name: "v99.9.9" }));
});
await new Promise((resolve) => release.listen(0, "127.0.0.1", resolve));
// Kept open for the GUI check below too, and unref'd so a failed assertion cannot hold the run.
release.unref();
const releaseUrl = `http://127.0.0.1:${release.address().port}/releases/latest`;

const dir = mkdtempSync(join(tmpdir(), "pinglab-update-"));
writeScenario(join(dir, "scenario.json"));
const port = await freePort();
const server = await startServer(dir, port, { PINGLAB_UPDATE_URL: releaseUrl });

try {
  const state = await until(async () => {
    const res = await request(port, { path: "/api/state", headers: { "x-pinglab-token": server.token } });
    if (res.status !== 200) return null;
    const body = JSON.parse(res.text);
    return body.update?.checked ? body : null;
  }, "/api/state to carry the update answer");

  assert.equal(state.update.latest, "99.9.9", "the newest tag from the releases API");
  assert.equal(state.update.newer, true);
  assert.match(
    state.update.sentence,
    /PingLab 99\.9\.9 is available; this copy is \d+\.\d+\.\d+\./,
    "the state carries the sentence every surface draws",
  );
  assert.ok(state.connection, "the rest of the state is unchanged");
} finally {
  // The server holds its history database open, so the folder can only go after it has exited.
  server.child.kill();
  if (server.child.exitCode === null) {
    await new Promise((resolve) => server.child.once("exit", resolve));
  }
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/* ------------------------------------------------------------------------ gui */

// The desktop GUI reads its status row from the bridge, so the same answer has to travel there.
console.log("gui");
const guiDir = mkdtempSync(join(tmpdir(), "pinglab-update-gui-"));
writeScenario(join(guiDir, "scenario.json"));
const bridgeOut = join(guiDir, "bridge.jsonl");
const bridge = spawn(process.execPath, [join(ROOT, "pinglab.mjs"), "--bridge", "--out", bridgeOut], {
  cwd: ROOT,
  env: {
    ...process.env,
    PINGLAB_DATA_DIR: guiDir,
    PINGLAB_PS_STUB: join(ROOT, "lib", "ps-fake.mjs"),
    PINGLAB_PS_SCENARIO_FILE: join(guiDir, "scenario.json"),
    PINGLAB_UPDATE_URL: releaseUrl,
  },
  stdio: ["pipe", "ignore", "ignore"],
});
const answers = () => {
  try {
    return readFileSync(bridgeOut, "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line));
  } catch {
    // The bridge creates its response file when it starts; the first poll can arrive before that.
    return [];
  }
};
try {
  bridge.stdin.write(`${JSON.stringify({ id: "1", cmd: "state" })}\n`);
  await until(() => answers().some((a) => a.id === "1"), "the bridge's first state answer");
  bridge.stdin.write(`${JSON.stringify({ id: "2", cmd: "state" })}\n`);
  const answer = await until(
    () => answers().find((a) => a.id === "2" && a.data?.update?.checked),
    "the bridge to report the update answer",
  );
  assert.equal(answer.ok, true, "the bridge answered");
  assert.match(
    answer.data.update.sentence,
    /PingLab 99\.9\.9 is available; this copy is \d+\.\d+\.\d+\./,
    "the GUI's state carries the same sentence as the page",
  );
} finally {
  bridge.kill();
  if (bridge.exitCode === null) await new Promise((resolve) => bridge.once("exit", resolve));
  rmSync(guiDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  await new Promise((resolve) => release.close(resolve));
}

console.log("  version     numeric comparison, same release, suffix and junk");
console.log("  available   a newer tag becomes one sentence naming both versions and the releases page");
console.log("  current     a copy that is current prints nothing");
console.log("  unsettled   404, an unreadable body, a network error and a timeout say nothing, without throwing");
console.log("  web         /api/state carries the sentence the page, the bridge and the dashboard draw");
console.log("  gui         the bridge's state answer carries it too, which is what the status row reads");
console.log("\nall update checks passed");
