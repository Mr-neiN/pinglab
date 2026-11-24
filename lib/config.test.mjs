/**
 * The persisted settings file: what a broken one does, and what a valid one must contain.
 *
 * This file used to be the one unreadable file PingLab swallowed. A malformed or
 * wrong-shaped config.json read back as the built-in endpoints with nothing said anywhere,
 * and the next save replaced the user's file with those defaults. Three things are pinned
 * here, in the order they matter:
 *
 *   reported    a broken file produces a `problem` sentence that names the file and the
 *               reason, and the same sentence travels through /api/state to the page and the
 *               GUI (the server half below).
 *   preserved   the bytes are kept as config.corrupt-<time>.json, exactly, once per distinct
 *               broken file, and a read never changes the live file - including after the
 *               save that used to clobber it.
 *   validated   what the file holds is checked with the API's own rule (endpointList), not a
 *               second copy: the reason a corrupt endpoint is refused is the API's sentence.
 *               A save validates too, so the app cannot write a file its loader would refuse.
 *
 * Both halves run: the module against a throwaway data folder, then the real server.mjs on a
 * spare loopback port with a broken settings file, proving the report reaches the surface.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

// Before config.mjs is imported: it resolves the file path once, from the data folder.
const dir = mkdtempSync(join(tmpdir(), "pinglab-config-"));
process.env.PINGLAB_DATA_DIR = dir;

const { loadConfig, saveConfig, DEFAULT_ENDPOINTS } = await import("./config.mjs");
const { endpointList } = await import("./api-input.mjs");

const CONFIG = join(dir, "config.json");
const copies = () => readdirSync(dir).filter((n) => n.startsWith("config.corrupt-") && n.endsWith(".json"));
const written = (value) => writeFileSync(CONFIG, typeof value === "string" ? value : JSON.stringify(value), "utf8");

/* ------------------------------------------------------------- module level */

// 1. A missing file is a first run: the built-in list, no complaint, and no file created by
//    a read (creating one would turn "not configured" into "configured with defaults").
{
  const got = await loadConfig();
  assert.deepEqual(got.endpoints, DEFAULT_ENDPOINTS, "missing file: the built-in endpoints");
  assert.equal(got.problem, null, "missing file is not a problem");
  assert.equal(existsSync(CONFIG), false, "a read must not create the file");
}

// 2. A malformed file is reported, and its bytes are kept exactly, once.
{
  const broken = '{ "endpoints": [ {"host": "1.1.1.1" ';
  written(broken);
  const got = await loadConfig();
  assert.ok(got.problem, "malformed JSON is reported");
  assert.match(got.problem.message, /is not valid JSON/, "the sentence names the parse failure");
  assert.match(got.problem.message, /config\.corrupt-\d{8}-\d{6}\.json/, "the sentence names the kept copy");
  assert.deepEqual(got.endpoints, DEFAULT_ENDPOINTS, "the built-in endpoints are used meanwhile");
  assert.equal(readFileSync(CONFIG, "utf8"), broken, "a read leaves the live file exactly as it is");

  const kept = copies();
  assert.equal(kept.length, 1, "one copy of the broken file");
  assert.equal(readFileSync(join(dir, kept[0]), "utf8"), broken, "the copy holds the original bytes");
  assert.equal(got.problem.copy, join(dir, kept[0]), "problem.copy points at it");

  // Loading again reports the same problem without filling the folder with identical copies.
  const again = await loadConfig();
  assert.equal(copies().length, 1, "the same bytes are not copied twice");
  assert.equal(again.problem.copy, got.problem.copy, "the copy already made is reused");
}

// 3. Wrong shape: a settings object whose endpoints the API would refuse. The reason is the
//    API's own sentence, because the load runs the API's own rule.
{
  const shape = { endpoints: [{ label: "mine", port: 443 }] };
  written(shape);
  const got = await loadConfig();
  assert.ok(got.problem, "an endpoint without a host is refused");
  let shared = null;
  try {
    endpointList(shape.endpoints);
  } catch (err) {
    shared = err.message;
  }
  assert.ok(shared, "the API refuses the same value");
  assert.ok(
    got.problem.message.includes(shared),
    `the load must report the API's sentence (${shared}), got: ${got.problem.message}`,
  );
  assert.deepEqual(got.endpoints, DEFAULT_ENDPOINTS);
}

// 4. Out-of-range port, an empty list, no settings object and no endpoints key are each
//    refused rather than accepted because the file happens to parse.
{
  const cases = [
    [{ endpoints: [{ host: "1.1.1.1", port: 70000 }] }, /port must be a whole number from 1 to 65535/],
    [{ endpoints: [] }, /At least one endpoint is required/],
    [[], /does not hold a settings object/],
    [{}, /has no endpoints list/],
  ];
  for (const [value, pattern] of cases) {
    written(value);
    const got = await loadConfig();
    assert.ok(got.problem, `${JSON.stringify(value)} must be reported`);
    assert.match(got.problem.message, pattern, `${JSON.stringify(value)}: reason`);
    assert.deepEqual(got.endpoints, DEFAULT_ENDPOINTS, `${JSON.stringify(value)}: built-in endpoints`);
  }
}

// 5. A valid file is used as it stands, with the normalisations the API applies on save.
{
  const saved = endpointList([
    { id: "my server!!", label: "x".repeat(80), host: "game.example.com", port: 27015, kind: "game" },
    { id: "d", label: "Cloudflare", host: "1.1.1.1", port: 443, kind: "dns" },
  ]);
  written({ endpoints: saved });
  const got = await loadConfig();
  assert.equal(got.problem, null, "a valid file is not a problem");
  assert.deepEqual(got.endpoints, saved, "the stored list loads unchanged");
  assert.equal(got.endpoints[0].label.length, 60, "the API's label clamp is what was stored");
}

// 6. Saving writes only what the loader reads, writes a valid file, and refuses an invalid
//    list without touching what is on disk.
{
  await saveConfig({ endpoints: [{ host: "203.0.113.9", label: "New", port: 27015, kind: "game" }] });
  const stored = JSON.parse(readFileSync(CONFIG, "utf8"));
  assert.deepEqual(Object.keys(stored), ["endpoints"], "only the settings the loader reads are written");
  const back = await loadConfig();
  assert.equal(back.problem, null, "what the app wrote loads cleanly");
  assert.equal(back.endpoints[0].host, "203.0.113.9", "and reads back as saved");

  const before = readFileSync(CONFIG, "utf8");
  await assert.rejects(
    () => saveConfig({ endpoints: [{ host: "1.1.1.1", port: 70000 }] }),
    /port must be a whole number from 1 to 65535/,
    "a save of an endpoint the loader would refuse is refused too",
  );
  assert.equal(readFileSync(CONFIG, "utf8"), before, "a refused save writes nothing");
}

// 7. The overwrite that used to lose the file: load a broken one (copy made), then save a
//    new list. The live file becomes valid; the broken bytes are still held by the copy.
{
  const broken = '{"endpoints": "not even a list"}';
  written(broken);
  const reported = await loadConfig();
  assert.ok(reported.problem, "broken list reported");
  await saveConfig({ endpoints: [{ host: "198.51.100.7", port: 443 }] });
  assert.equal(readFileSync(reported.problem.copy, "utf8"), broken, "the original bytes survive the save");
  const live = await loadConfig();
  assert.equal(live.problem, null, "the file the save wrote is valid");
  assert.equal(live.endpoints[0].host, "198.51.100.7", "and holds the new list");
}

console.log("config module");
console.log("  load     broken JSON, wrong shape and bad values are reported with the API's reasoning");
console.log("  preserve the bytes are kept as config.corrupt-<time>.json, once, and survive the next save");
console.log("  validate what loads is what the API accepts; what the app writes always loads");

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
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(30_000, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpDir = mkdtempSync(join(tmpdir(), "pinglab-config-http-"));
const brokenText = '{"endpoints": [{"host": ""}]}';
writeFileSync(join(httpDir, "config.json"), brokenText, "utf8");

// A described machine, so /api/state does not read this one through PowerShell.
const scenario = {
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
};

const port = await freePort();
const child = spawn(process.execPath, [join(ROOT, "server.mjs")], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(port),
    PINGLAB_DATA_DIR: httpDir,
    PINGLAB_PS_STUB: join(ROOT, "lib", "ps-fake.mjs"),
    PINGLAB_PS_SCENARIO: JSON.stringify(scenario),
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (b) => (log += b));
child.stderr.on("data", (b) => (log += b));

try {
  const base = `127.0.0.1:${port}`;
  const origin = `http://127.0.0.1:${port}`;
  const host = { host: base };

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

  // 8. The state the page and the GUI draw carries the report, with the built-in list.
  const state = JSON.parse((await request(port, { path: "/api/state", headers: authed })).text);
  assert.ok(state.config?.problem, "the state reports the settings file");
  assert.match(state.config.problem.message, /config\.corrupt-/, "with the name of the kept copy");
  assert.equal(state.endpoints.length, DEFAULT_ENDPOINTS.length, "the built-in endpoint list is in use");

  // 9. Saving a new list says the old file could not be used, instead of replacing it silently.
  const saved = await request(port, {
    method: "POST",
    path: "/api/endpoints",
    headers: { ...authed, origin, "content-type": "application/json" },
    body: JSON.stringify({ endpoints: [{ label: "Saved", host: "203.0.113.9", port: 27015, kind: "game" }] }),
  });
  assert.equal(saved.status, 200, `save: ${saved.status} ${saved.text.slice(0, 200)}`);
  const answer = JSON.parse(saved.text);
  assert.ok(answer.previousProblem, "the save reports the file it replaced");
  assert.match(answer.previousProblem.message, /config\.corrupt-/, "and the copy holding it");
  assert.deepEqual(
    readdirSync(httpDir).filter((n) => n.startsWith("config.corrupt-")),
    [answer.previousProblem.copy.split(/[\\/]/).pop()],
    "the broken file is on disk under the name the answer gives",
  );
  assert.equal(
    readFileSync(answer.previousProblem.copy, "utf8"),
    brokenText,
    "the bytes the user had are still there after the save",
  );
  const after = JSON.parse((await request(port, { path: "/api/state", headers: authed })).text);
  assert.equal(after.config?.problem, null, "the file the save wrote reports no problem");
  assert.equal(after.endpoints[0].host, "203.0.113.9", "and the page reads the new list");

  console.log("config server");
  console.log("  state    /api/state carries the problem sentence and the kept copy's name");
  console.log("  save     /api/endpoints answers with previousProblem, and the broken bytes survive");
  console.log("  after    the file the save wrote loads cleanly and the new list is served");
} finally {
  child.kill();
}

console.log("\nall config checks passed");
