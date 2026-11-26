/**
 * The four UDP exchange stages as the product speaks them: reply, challenge, timeout, closed.
 *
 * The probe's own sockets are covered by lib/probe-math.test.mjs and lib/udp-live.test.mjs.
 * This suite takes the rows those probes produce and drives the surfaces that print them:
 * the stage counters in the summary, the terminal's probe view, and the shipped page's UDP
 * card - the same renderProbe() a browser runs, loaded from public/ into the DOM shim.
 *
 * A challenge-only endpoint answered the service, but the query that was actually asked never
 * came back. It must read as a partial exchange with its challenge RTT, never as a reply.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { summarizeUdp } from "./probe.mjs";
import { udpText, udpCaveatText } from "./report.mjs";
import { createViews } from "./tui-views.mjs";
import { openPage } from "./dom-shim.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const udp = [
  { label: "Complete", state: "answered", avg: 40, p95: 42, jitter: 1, loss: 0, challenged: true },
  { label: "Partial", state: "challenge", challengeAvgMs: 12.5, avg: null },
  { label: "Closed", state: "closed", pathMs: 25, avg: null },
  { label: "Silent", state: "silent", avg: null },
];
const summary = {
  targets: 4,
  answered: 1,
  challenge: 1,
  closed: 1,
  silent: 1,
  serviceMs: 40,
  challengeMs: 12.5,
  loss: 0,
  pathMs: 25,
  unqueried: 0,
};
const probe = {
  results: [{ label: "Game", avg: 30, p95: 35, jitter: 2, loss: 0 }],
  icmp: [],
  udp,
  udpNote: udpText(summary),
  udpCaveat: udpCaveatText({ count: 10 }),
  summary: {
    gameAvgMs: 30,
    gameJitter: 2,
    gameLoss: 0,
    reachable: 1,
    endpoints: 1,
    transport: null,
    udp: summary,
  },
};

/* --------------------------------------------------------------- summary */

assert.deepEqual(
  summarizeUdp({ sent: 4, samples: [10], challenges: 1, challengeTimes: [12.5], timeouts: 1, closed: [25] }).stages,
  { reply: 1, challenge: 1, timeout: 1, closed: 1, unreachable: 0 },
  "the aggregate names every stage once",
);
assert.match(
  udpText(summary),
  /1 more answered only the challenge, so their follow-up never completed and they are not replies/,
  "the aggregate sentence does not fold a challenge into the reply count",
);

/* ------------------------------------------------------------------- TUI */

const views = createViews({
  ui: { probe, core: {}, message: null },
  refreshCore: async () => {},
  say: () => {},
});
const tui = views.viewProbe(160).join("\n").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
for (const [label, expected] of [
  ["Complete", /Complete \(game server\): 40\.0 ms/],
  ["Partial", /Partial: challenge answered in 12\.5 ms, follow-up never completed \(not a reply\)/],
  ["Closed", /Closed: port closed \(path 25\.0 ms\)/],
  ["Silent", /Silent: no UDP reply/],
]) {
  assert.match(tui, expected, `TUI: ${label} has its own row`);
}
assert.doesNotMatch(tui, /Partial \(game server\)/, "TUI: a challenge-only endpoint is never a game-server reply");

/* ------------------------------------------------------------------- web */

function freePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const { port } = listener.address();
      listener.close(() => resolve(port));
    });
  });
}

function request(port, path = "/") {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject);
    req.end();
  });
}

const dir = mkdtempSync(join(tmpdir(), "pinglab-udp-stages-"));
writeFileSync(
  join(dir, "scenario.json"),
  JSON.stringify({
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
    machines: { WLAN: { guid: "GUID-WLAN", ack: null, nodelay: null } },
    wlan: { wifi: true, joined: "HomeNet", profiles: ["HomeNet"] },
    dns: { WLAN: ["192.168.1.1"] },
    dnsStatic: { WLAN: false },
    stats: { rx: 1000, tx: 1000 },
  }),
  "utf8",
);

const APP = ["core.js", "probe-view.js", "fixes-view.js", "bench-view.js", "app.js"]
  .map((name) => readFileSync(join(ROOT, "public", name), "utf8"))
  .join("\n");
const HTML = readFileSync(join(ROOT, "public", "index.html"), "utf8");

const port = await freePort();
const server = spawn(process.execPath, [join(ROOT, "server.mjs")], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(port),
    PINGLAB_DATA_DIR: dir,
    PINGLAB_PS_STUB: join(ROOT, "lib", "ps-fake.mjs"),
    PINGLAB_PS_SCENARIO_FILE: join(dir, "scenario.json"),
    PINGLAB_UPDATE_URL: "http://127.0.0.1:9/releases/latest",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
server.stdout.on("data", (b) => (log += b));
server.stderr.on("data", (b) => (log += b));

try {
  let page;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      page = await request(port);
      break;
    } catch (err) {
      if (err.code !== "ECONNREFUSED" && err.code !== "ECONNRESET") throw err;
      if (Date.now() > deadline) throw new Error(`server did not start: ${log}`);
      await sleep(100);
    }
  }
  const token = page.match(/<meta name="pinglab-token" content="([^"]+)"/)?.[1];
  assert.ok(token, "the page carries this run's token");
  const { dom, page: app } = await openPage({ source: APP, html: HTML, origin: `http://127.0.0.1:${port}`, token });
  app.state.probe = probe;
  app.renderProbe();
  const html = dom.el("udpBox").innerHTML;
  assert.match(html, /Partial: challenge answered in 12\.5 ms, follow-up never completed \(not a reply\)/, "web: challenge row");
  assert.match(html, /Complete: avg 40\.0 ms/, "web: completed reply row");
  assert.match(html, /Closed: port closed \(path 25\.0 ms\)/, "web: closed row");
  assert.match(html, /Silent: no UDP reply \(a service ignores unknown packets; not loss\)/, "web: timeout row");
  assert.doesNotMatch(html, /Partial: avg/, "web: a challenge-only endpoint has no latency row");
  assert.match(html, /1 more answered only the challenge/, "web: the note repeats the aggregate sentence");
} finally {
  server.kill();
  await new Promise((r) => server.once("exit", r));
  rmSync(dir, { recursive: true, force: true });
}

console.log("\nudp stages");
console.log("  summary      reply, challenge, timeout and closed counted apart and reconciled");
console.log("  tui          each stage has its own row, and a challenge is never a game-server reply");
console.log("  web          the shipped probe card prints the same four stages");
console.log("\nall UDP stage checks passed");
