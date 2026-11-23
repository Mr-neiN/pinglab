/**
 * The state cache: fast repeats, but never a stale answer after a change.
 *
 * Two levels are tested.
 *
 *   Unit: a fake clock proves the fresh window, the stale-while-revalidate window, the
 *   max-stale blocking read, single flight and invalidation. If a future edit made the cache
 *   permanent, the TTL case fails; if it bypassed the cache, the fresh-hit case fails.
 *
 *   Server: the real server.mjs runs on a spare loopback port with lib/ps-fake.mjs as Windows.
 *   The fake reads a scenario file and writes back when an elevated power-plan change runs, so
 *   a POST /api/tweak really changes what the next read reports. The test then changes the
 *   machine file behind the server's back and proves the cached value is refreshed once its
 *   lifetime passes. A repeat read immediately beforehand proves it was served without any
 *   PowerShell call at all.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createStateCache } from "./state-cache.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------- unit */

{
  let clock = 1_000;
  let loads = 0;
  let machine = { plan: "on" };
  const cache = createStateCache({
    load: async () => {
      loads += 1;
      return structuredClone(machine);
    },
    ttlMs: 1_000,
    maxStaleMs: 5_000,
    now: () => clock,
  });

  assert.deepEqual(await cache.get(), { plan: "on" }, "cold read loads");
  assert.equal(loads, 1);

  clock += 500;
  assert.deepEqual(await cache.get(), { plan: "on" }, "fresh repeat is served");
  assert.equal(loads, 1, "a fresh repeat must not start another read");

  // A completed apply/revert drops the value: the next read may not hand back the pre-click
  // answer, even though it is still inside the fresh window.
  machine = { plan: "off" };
  cache.invalidate();
  assert.deepEqual(await cache.get(), { plan: "off" }, "an invalidated read reflects the change");
  assert.equal(loads, 2);

  // Past the fresh window the old value is served immediately, one background read runs, and
  // the following read sees the new machine. A cache that ignored its lifetime stays on "off".
  machine = { plan: "on" };
  clock += 1_001;
  assert.deepEqual(await cache.get(), { plan: "off" }, "stale value is served while refreshing");
  await sleep(10);
  assert.equal(loads, 3, "exactly one background read");
  assert.deepEqual(await cache.get(), { plan: "on" }, "the refreshed value replaces the stale one");

  // Concurrent callers share one read instead of each launching PowerShell.
  {
    let n = 0;
    const slow = createStateCache({
      load: async () => {
        n += 1;
        await sleep(20);
        return { n };
      },
      ttlMs: 100,
      maxStaleMs: 1_000,
    });
    const [a, b, c] = await Promise.all([slow.get(), slow.get(), slow.get()]);
    assert.deepEqual([a, b, c], [{ n: 1 }, { n: 1 }, { n: 1 }], "all callers get the same read");
    assert.equal(n, 1, "three concurrent cold reads launch the loader once");
  }

  // Beyond the stale limit the read is awaited: showing an ancient value is guessing.
  machine = { plan: "fresh-again" };
  clock += 10_000;
  const awaited = await cache.get();
  assert.deepEqual(awaited, { plan: "fresh-again" }, "past maxStale the read is not stale");
  assert.equal(loads, 4);

  console.log("state cache unit");
  console.log("  fresh       repeats inside the window do not read the machine");
  console.log("  invalidate  an apply/revert is reflected by the next read");
  console.log("  stale       one background read after the window, then the new value");
  console.log("  max stale   an ancient value is not served");
  console.log("  single      concurrent callers share one read");
}

/* ---------------------------------------------------------------- server */

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

function request(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.setTimeout(30_000, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const dir = mkdtempSync(join(tmpdir(), "pinglab-state-cache-"));
const scenarioFile = join(dir, "machine.json");
const logFile = join(dir, "ps-calls.ndjson");
const dataDir = join(dir, "data");

const initial = {
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
  wlan: { wifi: true, joined: "HomeNet", profiles: ["HomeNet", "Neighbour"] },
  dns: { WLAN: ["192.168.1.1"] },
  dnsStatic: { WLAN: false },
  stats: { rx: 1_000, tx: 1_000 },
};
const writeMachine = (v) => writeFileSync(scenarioFile, JSON.stringify(v, null, 2), "utf8");
const readMachine = () => JSON.parse(readFileSync(scenarioFile, "utf8"));
const psCalls = () =>
  existsSync(logFile)
    ? readFileSync(logFile, "utf8")
        .split("\n")
        .filter(Boolean).length
    : 0;
writeMachine(initial);

const port = await freePort();
const child = spawn(process.execPath, [join(ROOT, "server.mjs")], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(port),
    PINGLAB_DATA_DIR: dataDir,
    PINGLAB_PS_STUB: join(ROOT, "lib", "ps-fake.mjs"),
    PINGLAB_PS_SCENARIO_FILE: scenarioFile,
    PINGLAB_PS_LOG: logFile,
    PINGLAB_STATE_TTL_MS: "1200",
    PINGLAB_STATE_MAX_STALE_MS: "15000",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (b) => (log += b));
child.stderr.on("data", (b) => (log += b));

const base = `127.0.0.1:${port}`;
const origin = `http://127.0.0.1:${port}`;
const host = { host: base };

try {
  let page;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      page = await request(port, { path: "/", headers: host });
      break;
    } catch (err) {
      if (err.code !== "ECONNREFUSED" && err.code !== "ECONNRESET") throw err;
      if (Date.now() > deadline) throw new Error(`server did not start on ${base}:\n${log}`);
      await sleep(100);
    }
  }
  const token = page.text.match(/<meta name="pinglab-token" content="([^"]+)"/)?.[1];
  assert.ok(token, "the page carries the token");
  const authed = { ...host, "x-pinglab-token": token };

  const state = async () => {
    const res = await request(port, { path: "/api/state", headers: authed });
    assert.equal(res.status, 200, `state: ${res.status} ${res.text.slice(0, 160)}`);
    return JSON.parse(res.text);
  };

  // 1. Cold read reports the described machine.
  const first = await state();
  assert.equal(first.tweakState?.planPower, "on", "the fake machine starts with power saving on");
  assert.ok(first.catalog?.tweaks?.length, "the complete state travels, catalog included");
  assert.ok(first.connection?.activeRoute, "the complete state travels, connection included");

  // 2. A repeat is served without launching a single PowerShell process.
  const beforeCalls = psCalls();
  const second = await state();
  assert.equal(second.tweakState?.planPower, "on");
  assert.equal(psCalls(), beforeCalls, "a cached state read launches no PowerShell");

  // 3. Apply a real tweak through the API. The fake's elevated handler writes the machine file,
  //    so a cache that survived the action would visibly answer "on" on the next read.
  const applied = await request(port, {
    method: "POST",
    path: "/api/tweak",
    headers: {
      ...authed,
      origin,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(JSON.stringify({ action: "plan-power-off", alias: "WLAN" }))),
    },
    body: JSON.stringify({ action: "plan-power-off", alias: "WLAN" }),
  });
  assert.equal(applied.status, 200, `apply: ${applied.status} ${applied.text.slice(0, 200)}`);
  assert.equal(JSON.parse(applied.text).ok, true);
  assert.equal(readMachine().machines.WLAN.power.planAc, 0, "the fake machine really changed");

  const afterApply = await state();
  assert.equal(afterApply.tweakState?.planPower, "off", "the state after an apply is not the cached pre-apply answer");
  assert.ok(afterApply.pending?.count >= 1, "the restore point is in the next state");

  // 4. A change made outside PingLab is picked up after the cache's lifetime. The stale value
  //    may be served once while the refresh runs; the read after that must be the new one.
  const changed = readMachine();
  changed.machines.WLAN.power.planAc = 2;
  changed.machines.WLAN.power.planDc = 3;
  writeMachine(changed);
  await sleep(1_500);
  await state(); // stale-while-revalidate: serves the old value and starts the one refresh
  await sleep(1_500);
  const refreshed = await state();
  assert.equal(refreshed.tweakState?.planPower, "on", "a cached answer may not outlive its lifetime");
  assert.match(String(refreshed.tweakState?.planDetail), /AC medium power saving/, "the new plan values are reported");

  console.log("state cache server");
  console.log(`  server       ${base}, fake Windows from a scenario file`);
  console.log("  repeat       served from cache with zero PowerShell calls");
  console.log("  apply        POST /api/tweak invalidates: the next state reads the new value");
  console.log("  lifetime     an outside change is reflected after the TTL, not before");
} finally {
  if (!child.killed) child.kill();
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    setTimeout(resolve, 3_000);
  });
  rmSync(dir, { recursive: true, force: true });
}

console.log("\nall state cache checks passed");
