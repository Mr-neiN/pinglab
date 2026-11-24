/**
 * The endpoints editor, executed.
 *
 * `public/app.js` is loaded unmodified into a node:vm context with a small DOM
 * (`lib/dom-shim.mjs`) against a real server, and the editor's own buttons are clicked. What is
 * asserted is what the page rendered and what it posted - not a copy of its logic:
 *
 *   preselected   an endpoint saved with `protocol: "a2s"` opens with that option selected, and
 *                 one saved before the field existed shows the controlled echo rather than a
 *                 blank value
 *   default       a row added with "+ Add endpoint" carries a protocol the server accepts, and
 *                 the select offers exactly the protocols api-input.mjs accepts - with no blank
 *                 option that would only fail once it was saved
 *   save          changing a row's protocol and pressing Save endpoints puts that value in the
 *                 posted payload, stores it on disk, and serves it back through /api/state
 *   refused       an unknown protocol is still refused by the server's own rule, and the refused
 *                 save writes nothing
 *   layout        the row's declared grid columns are counted against the controls it actually
 *                 renders, so the remove button cannot be pushed out of the row
 *
 * The layout check is structural on purpose: this harness has no CSS engine, so the only honest
 * check is that the rule's column count and the rendered child count agree.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openPage } from "./dom-shim.mjs";
import { DEFAULT_UDP_PROTOCOL, UDP_PROTOCOL_IDS } from "./udp-proto.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP = readFileSync(join(ROOT, "public", "app.js"), "utf8");
const HTML = readFileSync(join(ROOT, "public", "index.html"), "utf8");
const CSS = readFileSync(join(ROOT, "public", "styles.css"), "utf8");

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

function localEndpoint() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer((socket) => socket.end());
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve({ listener, port: listener.address().port }));
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
  return { child, token, origin: `http://127.0.0.1:${port}` };
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

/* ----------------------------------------------------------------- the editor */

console.log("endpoints editor");

const { listener, port: targetPort } = await localEndpoint();
const dir = mkdtempSync(join(tmpdir(), "pinglab-endpoints-ui-"));
writeScenario(join(dir, "scenario.json"));
writeFileSync(
  join(dir, "config.json"),
  JSON.stringify({
    endpoints: [
      { id: "alpha", label: "Alpha", host: "127.0.0.1", port: targetPort, kind: "game", protocol: "a2s" },
      // Saved before the field existed: no protocol, so the row has to show the echo default.
      { id: "beta", label: "Beta", host: "127.0.0.1", port: targetPort, kind: "game" },
    ],
  }),
  "utf8",
);
const port = await freePort();
const server = await startServer(dir, port);

try {
  const page = await openPage({ source: APP, html: HTML, origin: server.origin, token: server.token });
  const { dom } = page;
  const rows = () => dom.el("endpointRows").querySelectorAll(".endpoint-row");
  const protocolOf = (row) => row.querySelector('[data-field="protocol"]');

  // 1. The saved protocol is what the row opens with: the value saveEndpoints would read.
  assert.equal(rows().length, 2, "both saved endpoints rendered a row");
  assert.equal(rows()[0].dataset.id, "alpha", "the row keeps its endpoint id");
  assert.equal(protocolOf(rows()[0]).value, "a2s", "the saved protocol is what the select reports");
  assert.equal(
    protocolOf(rows()[1]).value,
    DEFAULT_UDP_PROTOCOL,
    "an endpoint saved without a protocol shows the controlled echo default",
  );

  // 2. The select offers exactly what the server accepts - no blank option to save a non-protocol.
  const offered = protocolOf(rows()[0])
    .children.filter((option) => option.tagName === "OPTION")
    .map((option) => option.value);
  assert.deepEqual(
    [...offered].sort(),
    [...UDP_PROTOCOL_IDS].sort(),
    "the select offers the protocols the server accepts, and nothing else",
  );

  // 3. A row added from the button carries a protocol the server accepts, not a blank value.
  assert.equal(dom.el("addEndpoint").click(), 1, "the add button has a handler");
  assert.equal(rows().length, 3, "the new row was appended");
  const added = protocolOf(rows().at(-1)).value;
  assert.ok(added, "a new row is not blank");
  assert.ok(UDP_PROTOCOL_IDS.has(added), `a new row defaults to ${added}, which the server accepts`);

  // 4. The row fits its controls: one declared grid column per rendered control, remove last.
  const rule = CSS.match(/\.endpoint-row\s*\{[^}]*grid-template-columns:\s*([^;]+);/);
  assert.ok(rule, "public/styles.css declares the row's grid columns");
  const columns = rule[1].trim().split(/\s+/).filter(Boolean);
  const controls = rows()[0].children;
  assert.equal(columns.length, controls.length, "a declared column for every control, so none wraps");
  assert.ok(
    controls.every((control) => ["INPUT", "SELECT", "BUTTON"].includes(control.tagName)),
    "every child of the row is a control the grid has a column for",
  );
  assert.equal(controls.at(-1).dataset.remove, "1", "the remove button is the last control in the row");

  // 5. Changing a protocol and saving posts it, and the server stores and serves it back.
  protocolOf(rows()[0]).value = "q3";
  const fresh = rows()[2];
  fresh.querySelector('[data-field="host"]').value = "127.0.0.1";
  fresh.querySelector('[data-field="label"]').value = "Echo";
  fresh.querySelector('[data-field="port"]').value = String(targetPort);
  assert.equal(dom.el("saveEndpoints").click(), 1, "the save button has a handler");
  await until(() => dom.el("endpointMsg").textContent === "Saved.", "the endpoint save to finish");

  const save = [...page.requests].reverse().find((r) => r.url.includes("/api/endpoints"));
  assert.ok(save, "the page posted the endpoint list");
  const payload = JSON.parse(save.body).endpoints;
  assert.deepEqual(
    payload.map((endpoint) => endpoint.protocol),
    ["q3", "echo", "echo"],
    "the chosen protocol and both defaults reached the saved payload",
  );

  const stored = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).endpoints;
  assert.deepEqual(
    stored.map((endpoint) => endpoint.protocol),
    ["q3", "echo", "echo"],
    "the file on disk holds the protocols the page sent",
  );
  const state = await call(server, "/api/state");
  assert.deepEqual(
    state.json.endpoints.map((endpoint) => endpoint.protocol),
    ["q3", "echo", "echo"],
    "/api/state serves them back",
  );
  assert.equal(rows().length, 3, "the editor re-rendered from the server's answer");

  // 6. An unknown protocol is refused by the rule the server uses, and nothing is written.
  const refused = await call(server, "/api/endpoints", {
    method: "POST",
    body: { endpoints: [{ id: "bad", label: "bad", host: "127.0.0.1", port: 443, kind: "game", protocol: "icmp" }] },
  });
  assert.equal(refused.status, 400, "the server refuses a protocol it does not know");
  assert.match(refused.json.error, /protocol must be one of/, "and names the accepted values");
  const afterRefusal = JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).endpoints;
  assert.deepEqual(
    afterRefusal.map((endpoint) => endpoint.protocol),
    ["q3", "echo", "echo"],
    "a refused save wrote nothing",
  );

  console.log("  preselected the saved protocol is the selected option; a missing one shows echo");
  console.log("  default     a new row carries a valid protocol, and the select offers only those");
  console.log("  save        a changed protocol is posted, stored on disk and served by /api/state");
  console.log(`  layout      ${columns.length} declared columns for ${controls.length} rendered controls`);
  console.log("  refused     unknown protocol refused by the server's rule, nothing written");
} finally {
  server.child.kill();
  listener.close();
  for (let i = 0; i < 20; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      break;
    } catch {
      await sleep(100);
    }
  }
}

console.log("\nall endpoints editor checks passed");
