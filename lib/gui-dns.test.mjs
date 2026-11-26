/**
 * The desktop GUI's DNS benchmark, headless, against the same answer the other surfaces get.
 *
 * `PINGLAB_GUI_DNSTEST=1 powershell.exe -File PingLab.ps1` builds the real window without
 * showing it, waits for the bridge's first state, runs the DNS handler the tab button calls,
 * and writes the filled table, verdict, current servers and winner as JSON.
 *
 * The same deterministic benchmark (`PINGLAB_DNS_STUB=cloudflare`) is run by:
 *   - this test, through lib/dns.mjs directly (the result the TUI renders),
 *   - the real server, through POST /api/dns-bench (the page's path),
 *   - the GUI, through the bridge's `dns` command.
 * All three must agree on every row, the verdict and the winner; the TUI's own viewDns() is
 * then rendered from the same result and has to print those rows and that verdict.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { benchmark } from "./dns.mjs";
import { dnsVerdict, dnsWinner } from "./report.mjs";
import { n1 } from "./tui-format.mjs";
import { createViews } from "./tui-views.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

if (process.platform !== "win32") {
  console.log("the GUI DNS test builds a WinForms window, so it only runs on Windows");
  console.log("\nall GUI DNS checks passed");
  process.exit(0);
}

process.env.PINGLAB_DNS_STUB = "cloudflare";

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
  stats: { rx: 1000, tx: 1000 },
};

const dir = mkdtempSync(join(tmpdir(), "pinglab-gui-dns-"));
const scenarioFile = join(dir, "scenario.json");
writeFileSync(scenarioFile, JSON.stringify(scenario, null, 2), "utf8");

const baseEnv = {
  ...process.env,
  PINGLAB_DATA_DIR: join(dir, "data"),
  PINGLAB_PS_STUB: join(ROOT, "lib", "ps-fake.mjs"),
  PINGLAB_PS_SCENARIO_FILE: scenarioFile,
  PINGLAB_DNS_STUB: "cloudflare",
  PINGLAB_UPDATE_URL: "http://127.0.0.1:9/releases/latest",
};

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
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The page's path: a real server and the same POST the DNS card sends. */
async function webResult() {
  const port = await freePort();
  const child = spawn(process.execPath, [join(ROOT, "server.mjs")], {
    cwd: ROOT,
    env: { ...baseEnv, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (b) => (log += b));
  child.stderr.on("data", (b) => (log += b));
  const base = `127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  try {
    let page;
    for (;;) {
      try {
        page = await request(port, { path: "/", headers: { host: base } });
        break;
      } catch (err) {
        if (err.code !== "ECONNREFUSED" && err.code !== "ECONNRESET") throw err;
        if (Date.now() > deadline) throw new Error(`server did not start: ${log}`);
        await sleep(100);
      }
    }
    const token = String(page.text).match(/<meta name="pinglab-token" content="([^"]+)"/)?.[1];
    assert.ok(token, "the page carries this run's token");
    const res = await request(port, {
      method: "POST",
      path: "/api/dns-bench",
      headers: {
        host: base,
        origin: `http://${base}`,
        "x-pinglab-token": token,
        "content-type": "application/json",
        "content-length": "2",
      },
      body: "{}",
    });
    assert.equal(res.status, 200, `POST /api/dns-bench answered ${res.status} ${res.text.slice(0, 200)}`);
    return JSON.parse(res.text);
  } finally {
    child.kill();
    await new Promise((r) => child.once("exit", r));
    await sleep(150);
  }
}

function runGui() {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(ROOT, "PingLab.ps1")],
      { cwd: ROOT, env: { ...baseEnv, PINGLAB_GUI_DNSTEST: "1" }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    let err = "";
    child.stdout.on("data", (b) => (out += b));
    child.stderr.on("data", (b) => (err += b));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`the GUI DNS self-test did not finish in 120 s\nstdout:\n${out}\nstderr:\n${err}`));
    }, 120_000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

const expectedRows = (result) =>
  result.resolvers.map((r) => ({
    label: r.label,
    median: n1(r.median),
    worst: n1(r.worst),
    answered: `${r.answered}/${result.domains}`,
    note: result.best === r.id ? "winner" : "",
  }));

console.log("gui dns benchmark");

try {
  const expected = await benchmark();
  const expectedWinner = dnsWinner(expected);
  const expectedVerdict = dnsVerdict(expected);

  const web = await webResult();
  assert.equal(web.ok, true, "the page's benchmark succeeded");
  assert.deepEqual(
    web.result.resolvers.map((r) => ({ id: r.id, label: r.label, median: r.median, worst: r.worst, answered: r.answered, missed: r.missed })),
    expected.resolvers.map((r) => ({ id: r.id, label: r.label, median: r.median, worst: r.worst, answered: r.answered, missed: r.missed })),
    "web: the resolver rows are this run's measured rows",
  );
  assert.equal(web.result.verdict, expectedVerdict, "web: the verdict is the shared sentence");
  assert.equal(web.result.winner?.id, expectedWinner?.id, "web: the winner is the shared selector");

  const gui = await runGui();
  const line = String(gui.out)
    .split(/\r?\n/)
    .find((l) => l.startsWith("GUIDNSTEST "));
  assert.ok(line, `no GUIDNSTEST line (exit ${gui.code})\nstdout:\n${gui.out}\nstderr:\n${gui.err}`);
  const resultFile = line.slice("GUIDNSTEST ".length).trim();
  assert.ok(existsSync(resultFile), `the self-test result file was not written: ${resultFile}`);
  const seen = JSON.parse(readFileSync(resultFile, "utf8"));

  // The hidden window's own log says whether state arrived and what it rendered; on a CI
  // failure that is the difference between a diagnosis and a guess.
  let guiLog = "";
  try {
    guiLog = readFileSync(join(dir, "data", "gui.log"), "utf8");
  } catch {
    guiLog = "(no gui.log written)";
  }
  assert.equal(
    gui.code,
    0,
    `the GUI self-test reported a failure (exit ${gui.code})\nchecks: ${JSON.stringify(seen.checks)}\n${gui.out}\ngui.log:\n${guiLog}`,
  );
  assert.equal(seen.ok, true, `the GUI benchmark produced no table: ${JSON.stringify(seen.checks)}`);
  assert.deepEqual(seen.rows, expectedRows(expected), "GUI: the table is the same rows the web path measured");
  assert.equal(seen.verdict, expectedVerdict, "GUI: the verdict is the shared sentence");
  assert.equal(seen.verdict, web.result.verdict, "GUI and web print the same verdict");
  assert.equal(seen.winnerId, expectedWinner?.id, "GUI: the winner is the shared selector");
  assert.equal(seen.winnerId, web.result.winner?.id, "GUI and web select the same winner");
  assert.equal(seen.current, "Current: 192.168.1.1", "GUI: the DNS in use is the adapter's, not a guess");

  // The TUI draws the same result through viewDns, the function its d key and --view dns use.
  const views = createViews({
    ui: { dns: { result: expected, current: { servers: ["192.168.1.1"] } }, core: { connection: {} }, message: null },
    refreshCore: async () => {},
    say: () => {},
  });
  const tui = views.viewDns(120).join("\n").replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  for (const row of expectedRows(expected)) {
    assert.ok(tui.includes(row.label), `TUI: ${row.label} is in the table`);
    assert.ok(tui.includes(row.median), `TUI: ${row.label}'s median is printed`);
  }
  assert.ok(tui.includes(expectedVerdict), "TUI: the shared verdict sentence is printed");

  console.log("  rows         GUI, web and TUI report the same four resolvers and medians");
  console.log("  verdict      one sentence from lib/report.mjs on every surface");
  console.log("  winner       the same resolver id is offered, and no DNS change happens in the test");
  console.log("  current      the GUI names the servers the adapter is actually using");
  console.log("\nall GUI DNS checks passed");
} finally {
  for (let i = 0; i < 20; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      break;
    } catch {
      await sleep(100);
    }
  }
}
