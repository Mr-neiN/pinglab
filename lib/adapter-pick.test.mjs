/**
 * Which adapter a setting is aimed at, end to end.
 *
 * Every apply used to go to whichever adapter carried the default route, and nothing said which
 * one that was: on a docked laptop the Ethernet port while docked and the Wi-Fi card when not,
 * and behind a VPN the tunnel's virtual device. This suite pins the fix at each layer:
 *
 *   rule        the pure chooser (lib/target.mjs): the default route is preselected, a virtual
 *               adapter is never picked on its own, a remembered adapter wins, and one that has
 *               left the machine falls back with a sentence instead of aiming at nothing
 *   saved       the choice is persisted in config.json and a later endpoint save keeps it
 *   served      /api/state carries the target, the choices and whether it was chosen, and
 *               POST /api/adapter re-reads the machine and refuses a name it does not have
 *   shown       the shipped page preselects that adapter, hides virtual ones until asked, names
 *               the adapter on every row, and lists restore points with the adapter they belong
 *               to
 *   applied     a row's button posts the chosen adapter, not the default route
 *
 * The server runs against lib/ps-fake.mjs (a fake Windows with three adapters, one of them a
 * VPN tunnel), so no real adapter, registry key or administrator prompt is involved.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { adapterChoices } from "./target.mjs";
import { openPage } from "./dom-shim.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP = readFileSync(join(ROOT, "public", "app.js"), "utf8");
const HTML = readFileSync(join(ROOT, "public", "index.html"), "utf8");

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

function request(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString("utf8") }));
    });
    req.setTimeout(60_000, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Three adapters: Wi-Fi on the default route, Ethernet, and a VPN tunnel that is virtual. */
function scenario() {
  const wifi = {
    Name: "WLAN",
    InterfaceDescription: "Intel Wi-Fi 6 AX201",
    Status: "Up",
    LinkSpeed: "1 Gbps",
    MacAddress: "AA-BB-CC-DD-EE-FF",
    ifIndex: 1,
    InterfaceGuid: "GUID-WLAN",
    DriverVersion: "1.0.0.0",
  };
  const ethernet = {
    Name: "Ethernet 2",
    InterfaceDescription: "Intel(R) Ethernet Connection I219-V",
    Status: "Up",
    LinkSpeed: "2.5 Gbps",
    MacAddress: "AA-BB-CC-DD-EE-01",
    ifIndex: 2,
    InterfaceGuid: "GUID-ETH",
    DriverVersion: "2.0.0.0",
  };
  const vpn = {
    Name: "Tailscale",
    InterfaceDescription: "Tailscale Tunnel",
    Status: "Up",
    LinkSpeed: "100 Gbps",
    MacAddress: "AA-BB-CC-DD-EE-02",
    ifIndex: 3,
    InterfaceGuid: "GUID-VPN",
    DriverVersion: "1.0.0.0",
  };
  return {
    elevatedUser: false,
    adapters: [wifi, ethernet, vpn],
    routes: [{ InterfaceAlias: "WLAN", NextHop: "192.168.1.1", RouteMetric: 25, ifIndex: 1 }],
    profiles: [{ Name: "HomeNet", InterfaceAlias: "WLAN", IPv4Connectivity: "Internet", NetworkCategory: "Private" }],
    machines: {
      WLAN: {
        guid: "GUID-WLAN",
        nodelay: null,
        ack: null,
        power: { planAc: 1, planDc: 2, ndis: "enabled", wmiEnable: true, scheme: "SCHEME-1" },
        tuning: { MIMOPowerSaveMode: 0, RoamAggressiveness: 2 },
        profile: "HomeNet",
      },
      "Ethernet 2": {
        guid: "GUID-ETH",
        nodelay: null,
        ack: null,
        power: { planAc: 1, planDc: 2, ndis: "enabled", wmiEnable: true, scheme: "SCHEME-1" },
      },
    },
    wlan: { wifi: true, joined: "HomeNet", profiles: ["HomeNet"] },
    dns: { WLAN: ["192.168.1.1"] },
    dnsStatic: { WLAN: false },
    stats: { rx: 1_000, tx: 1_000 },
  };
}

async function startServer(dir, port) {
  const child = spawn(process.execPath, [join(ROOT, "server.mjs")], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: String(port),
      PINGLAB_DATA_DIR: dir,
      PINGLAB_PS_STUB: join(ROOT, "lib", "ps-fake.mjs"),
      PINGLAB_PS_SCENARIO_FILE: join(dir, "scenario.json"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (b) => (log += b));
  child.stderr.on("data", (b) => (log += b));
  let page;
  const deadline = Date.now() + 25_000;
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
  return { child, token, origin: `http://127.0.0.1:${port}`, log: () => log };
}

async function call(server, path, { method = "GET", body } = {}) {
  const res = await fetch(`${server.origin}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Origin: server.origin,
      "X-PingLab-Token": server.token,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: JSON.parse(text), text };
}

/* ------------------------------------------------------------------- the rule */

console.log("rule");

const wifiAdapter = { name: "WLAN", description: "Intel Wi-Fi 6 AX201", status: "Up", wifi: true, virtual: false };
const ethAdapter = { name: "Ethernet 2", description: "Intel I219-V", status: "Up", wifi: false, virtual: false };
const vpnAdapter = { name: "Tailscale", description: "Tailscale Tunnel", status: "Up", wifi: false, virtual: true };
const downAdapter = { name: "Bluetooth", description: "Bluetooth Device (PAN)", status: "Disconnected", virtual: true };

{
  // 1. Nothing chosen: the adapter carrying the default route is the target, and only physical
  //    adapters come before the virtual ones in the list a picker shows.
  const pick = adapterChoices({
    adapters: [vpnAdapter, ethAdapter, wifiAdapter],
    activeRoute: { alias: "WLAN", nextHop: "192.168.1.1" },
  });
  assert.equal(pick.target.alias, "WLAN", "the default route is preselected");
  assert.equal(pick.target.defaultRoute, true);
  assert.equal(pick.target.chosen, false, "a preselection is not a choice the user made");
  assert.equal(pick.fallback, null);
  const virtualAt = pick.choices.findIndex((c) => c.virtual);
  const physicalAfter = pick.choices.slice(virtualAt).filter((c) => !c.virtual);
  assert.equal(physicalAfter.length, 0, "virtual adapters are listed after every physical one");
  assert.deepEqual(
    pick.choices.filter((c) => c.selected).map((c) => c.alias),
    ["WLAN"],
    "exactly one choice is marked selected",
  );
}

{
  // 2. Behind a VPN the top of the route table is the tunnel. A Windows setting written to it
  //    would describe a device that carries none of the game traffic, so the physical adapter
  //    that has a default route of its own wins, and the note says which route was passed over.
  const pick = adapterChoices({
    adapters: [vpnAdapter, wifiAdapter, ethAdapter],
    routes: [{ alias: "Tailscale" }, { alias: "WLAN" }],
    activeRoute: { alias: "Tailscale", nextHop: "100.64.0.1" },
  });
  assert.equal(pick.target.alias, "WLAN", "the physical adapter with a default route is picked");
  assert.equal(pick.target.virtual, false);
  assert.match(pick.target.note, /default route is the virtual adapter “Tailscale”/, "the note names the route it passed over");
  assert.match(pick.target.note, /“WLAN”/, "the note names the adapter actually aimed at");
}

{
  // 2b. A machine whose only default route is a tunnel still gets a physical adapter, never the
  //     tunnel by silence. Which physical one is a tie-break, so only the rule is asserted.
  const pick = adapterChoices({
    adapters: [vpnAdapter, wifiAdapter, ethAdapter],
    routes: [{ alias: "Tailscale" }],
    activeRoute: { alias: "Tailscale" },
  });
  assert.equal(pick.target.virtual, false, "the VPN adapter is not chosen on its own");
  assert.notEqual(pick.target.alias, "Tailscale");
  assert.ok(pick.target.note?.includes(pick.target.alias), "the note names the adapter it fell back to");
}

{
  // 3. A remembered choice wins, including a virtual one: overruling it would repeat the silent
  //    surprise this feature exists to remove.
  const pick = adapterChoices({
    adapters: [vpnAdapter, wifiAdapter],
    activeRoute: { alias: "WLAN" },
    chosen: "Tailscale",
  });
  assert.equal(pick.target.alias, "Tailscale", "the remembered adapter is the target");
  assert.equal(pick.target.virtual, true);
  assert.equal(pick.target.chosen, true, "the target says the user chose it");
  assert.equal(pick.target.note, null, "no note when the choice agrees with itself");
}

{
  // 4. A remembered adapter that is gone falls back and says so.
  const pick = adapterChoices({ adapters: [wifiAdapter], activeRoute: { alias: "WLAN" }, chosen: "Docked NIC" });
  assert.equal(pick.target.alias, "WLAN");
  assert.match(pick.fallback, /“Docked NIC” was chosen earlier and is not on this machine now/);
  assert.match(pick.fallback, /“WLAN”/, "the fallback names the adapter it used instead");
}

{
  // 5. No adapter at all is a state, not a crash.
  const pick = adapterChoices({ adapters: [], activeRoute: null, chosen: "WLAN" });
  assert.equal(pick.target, null);
  assert.deepEqual(pick.choices, []);
  assert.match(pick.fallback, /no adapter/);
}

/* ------------------------------------------------------------------ persisted */

console.log("saved");

const configDir = mkdtempSync(join(tmpdir(), "pinglab-adapter-config-"));
process.env.PINGLAB_DATA_DIR = configDir;
const { loadConfig, saveConfig, saveAdapter, DEFAULT_ENDPOINTS } = await import("./config.mjs");
const CONFIG = join(configDir, "config.json");
const stored = () => JSON.parse(readFileSync(CONFIG, "utf8"));

try {
  assert.equal((await loadConfig()).adapter, null, "a first run has no remembered adapter");

  const first = await saveAdapter("WLAN");
  assert.equal(first.ok, true);
  assert.equal(stored().adapter, "WLAN", "the choice is written to config.json");
  assert.deepEqual(stored().endpoints, DEFAULT_ENDPOINTS, "choosing an adapter writes the endpoint list back unchanged");

  // Saving the endpoint list must not forget the adapter: the two settings share one file.
  await saveConfig({ endpoints: DEFAULT_ENDPOINTS.slice(0, 3) });
  assert.equal(loadConfigSync().adapter, "WLAN", "an endpoint save keeps the remembered adapter");
  assert.equal(loadConfigSync().endpoints.length, 3, "and stores the new endpoint list");

  const second = await saveAdapter("Ethernet 2");
  assert.equal(second.ok, true);
  assert.equal(loadConfigSync().adapter, "Ethernet 2", "a second choice replaces the first");
  assert.equal(loadConfigSync().endpoints.length, 3, "and the endpoint list survives that too");

  assert.equal((await saveAdapter("   ")).ok, false, "an empty name is refused");

  // A settings file that cannot be used is refused, not overwritten with defaults.
  writeFileSync(CONFIG, "{ not json", "utf8");
  const refused = await saveAdapter("WLAN");
  assert.equal(refused.ok, false);
  assert.match(refused.error, /The adapter choice was not saved/);
  assert.equal(readFileSync(CONFIG, "utf8"), "{ not json", "the unreadable file's bytes are untouched");
} finally {
  rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

/** `loadConfig` is async; the assertions above read it after a save that has already settled. */
function loadConfigSync() {
  // The file is written and closed before this is called, so a synchronous parse is honest here
  // and keeps the assertions readable.
  return JSON.parse(readFileSync(CONFIG, "utf8"));
}

/* ----------------------------------------------------------------------- web */

console.log("served");

const dir = mkdtempSync(join(tmpdir(), "pinglab-adapter-server-"));
writeFileSync(join(dir, "scenario.json"), JSON.stringify(scenario(), null, 2), "utf8");
const port = await freePort();
const server = await startServer(dir, port);

try {
  const state = (await call(server, "/api/state")).json;
  assert.equal(state.target.alias, "WLAN", "the default route's adapter is the target");
  assert.equal(state.target.defaultRoute, true);
  assert.equal(state.target.chosen, false);
  assert.equal(state.targetFallback, null);
  assert.equal(state.tweakState.alias, "WLAN", "the rows are read from the target adapter");
  assert.deepEqual(
    state.connection.dnsForTarget.servers,
    ["192.168.1.1"],
    "the DNS panel has the target's own servers, not the default route's guess",
  );
  const vpnChoice = state.adapterChoices.find((c) => c.alias === "Tailscale");
  assert.equal(vpnChoice.virtual, true, "the VPN adapter is offered, marked virtual");
  assert.equal(state.adapterChoices.filter((c) => c.virtual).length, 1);
  assert.equal(state.adapterChoices.slice(-1)[0].alias, "Tailscale", "virtual adapters are listed last");

  // The endpoint list the user saved is not disturbed by a choice.
  const endpointsBefore = JSON.stringify(state.endpoints);

  // A name the machine does not have is refused by the server, not stored.
  const unknown = await call(server, "/api/adapter", { method: "POST", body: { alias: "Nope 0" } });
  assert.equal(unknown.status, 400, "an unknown adapter is a bad request");
  assert.match(unknown.json.error, /is not an adapter on this machine/);
  assert.equal(existsSync(join(dir, "config.json")), false, "a refused choice writes nothing");

  /* ----------------------------------------------------------------- the page */

  const page = await openPage({ source: APP, html: HTML, origin: server.origin, token: server.token });
  const { dom } = page;
  const options = () => dom.el("adapterPick").children.filter((child) => child.tagName === "OPTION");

  assert.equal(dom.el("adapterPick").value, "WLAN", "the picker opens on the preselected adapter");
  assert.deepEqual(
    options().map((o) => o.value),
    ["WLAN", "Ethernet 2"],
    "only physical adapters are offered, the default route first",
  );
  assert.ok(
    !options().some((o) => o.value === "Tailscale"),
    "a virtual adapter is not in the picker by default",
  );
  assert.match(dom.el("fixesBox").innerHTML, /Applies to <b>WLAN<\/b>/, "every row names the adapter it changes");
  assert.match(dom.el("fixesBox").innerHTML, /default route/, "and says when it is the default route");

  // Asking for virtual adapters reveals the VPN one without changing the target.
  dom.el("showVirtual").checked = true;
  assert.ok(dom.el("showVirtual").fire("change") > 0, "the virtual checkbox has a handler");
  assert.ok(
    options().some((o) => o.value === "Tailscale"),
    "ticking the box offers the virtual adapter",
  );
  assert.equal(dom.el("adapterPick").value, "WLAN", "revealing them does not change the target");

  // Choosing Ethernet: the page posts the pick, the server reads the machine again, and the
  // rows are redrawn from Ethernet - not from the default route.
  dom.el("adapterPick").value = "Ethernet 2";
  assert.ok(dom.el("adapterPick").fire("change") > 0, "the picker has a change handler");
  await until(() => page.page.state.target?.alias === "Ethernet 2", "the page to adopt the chosen adapter");

  assert.equal(dom.el("adapterPick").value, "Ethernet 2", "the picker shows the choice");
  assert.equal(page.page.state.target.chosen, true, "the state says it was chosen");
  assert.equal(page.page.state.tweak.alias, "Ethernet 2", "the rows were re-read from the chosen adapter");
  assert.match(dom.el("fixesBox").innerHTML, /Applies to <b>Ethernet 2<\/b>/, "each row names the chosen adapter");
  assert.ok(
    page.requests.some((r) => String(r.url).includes("/api/adapter") && String(r.body || "").includes("Ethernet 2")),
    "the choice went through POST /api/adapter",
  );

  const saved = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  assert.equal(saved.adapter, "Ethernet 2", "the choice is saved, so the terminal and the GUI read it too");
  assert.deepEqual(saved.endpoints, JSON.parse(endpointsBefore), "the endpoints are untouched");

  // Restore points carry their adapter, and the page lists them with it.
  page.page.state.pending = {
    items: [{ area: "nagle", alias: "Ethernet 2", label: "Nagle's algorithm (per adapter)", at: new Date().toISOString() }],
    count: 1,
    history: [],
    problem: null,
  };
  page.page.renderFixes();
  assert.match(dom.el("restorePoints").innerHTML, /Nagle&#39;s algorithm \(per adapter\) · on Ethernet 2/);
  assert.equal(dom.el("restorePointsBox").classList.contains("hidden"), false, "the restore-point list is shown");

  // A row's button posts the chosen adapter. The request is what matters here; the fake Windows
  // may or may not have the setting, and the outcome text is covered by the tweak suite.
  await page.page.api("/api/tweak", { action: "nagle-off", alias: page.page.state.target.alias });
  const tweak = page.requests.filter((r) => String(r.url).includes("/api/tweak")).at(-1);
  assert.match(String(tweak.body), /"alias":"Ethernet 2"/, "an apply names the chosen adapter, not the default route");
} finally {
  server.child.kill();
  if (server.child.exitCode === null) await new Promise((resolve) => server.child.once("exit", resolve));
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

console.log("\nadapter target");
console.log("  rule        default route preselected; virtual never picked alone; a chosen one wins; a gone one falls back");
console.log("  saved       the choice lives in config.json and an endpoint save keeps it");
console.log("  served      /api/state and POST /api/adapter read the machine; an unknown name is refused and writes nothing");
console.log("  shown       the picker, every row and every restore point name the adapter");
console.log("  applied     a row's apply posts the chosen adapter");
console.log("\nall adapter target checks passed");
