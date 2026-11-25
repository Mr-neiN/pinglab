/**
 * The benchmark panel, executed.
 *
 * `lib/bench.test.mjs` proves the rule and the API. This file proves the shipped page can drive
 * it: `public/app.js` is loaded unmodified into a node:vm context with a small DOM
 * (`lib/dom-shim.mjs`), against a real server and a real local endpoint, and the panel's own
 * buttons are clicked. What is asserted is what the page put in the DOM - the message line, the
 * per-metric table, the toast - not a copy of the logic.
 *
 *   panel       baseline, apply exactly one setting, measure again, the rendered four-metric
 *               table with verdicts, and the comparison stored on the server
 *   reload      a second page against the same server rehydrates the pending baseline, and its
 *               Apply button still sends the real action (the GET response does not carry it)
 *   rollback    the confirm is required: refusing it sends no revert request and changes
 *               nothing; approving it reports what was restored and hides the button
 *   insufficient a stored comparison with too little data renders its reason and no numbers
 *   surfaces    /api/state, the terminal dashboard and the GUI bridge all report the comparison
 *               and the rollback outcome, including what is still applied
 */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

import { revertSentence } from "./bench.mjs";
import { openPage } from "./dom-shim.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const APP = ["core.js", "probe-view.js", "fixes-view.js", "bench-view.js", "app.js"]
  .map((name) => readFileSync(join(ROOT, "public", name), "utf8"))
  .join("\n");
const HTML = readFileSync(join(ROOT, "public", "index.html"), "utf8");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Wait for something the page's own async handler is doing, without guessing at a fixed delay. */
async function until(check, what, timeoutMs = 60_000) {
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
    req.setTimeout(120_000, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** The fake Windows the engine reads, with an unset Nagle value so applying is a real change. */
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

function prepareDir({ endpoints = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "pinglab-bench-ui-"));
  writeScenario(join(dir, "scenario.json"));
  if (endpoints) writeFileSync(join(dir, "config.json"), JSON.stringify({ endpoints }), "utf8");
  return dir;
}

/** Insert history rows before the server opens the database, so nothing is racing its lock. */
function seed(dbDir, runs) {
  const dbUrl = pathToFileURL(join(ROOT, "lib", "db.mjs")).href;
  const script = `
    const { saveRun } = await import(${JSON.stringify(dbUrl)});
    for (const r of ${JSON.stringify(runs)}) saveRun(r.kind, r.summary, r.data);
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: ROOT,
    env: { ...process.env, PINGLAB_DATA_DIR: dbDir },
    stdio: "pipe",
  });
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

async function apiJson(origin, token, path, body) {
  const res = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "X-PingLab-Token": token },
    body: body ? JSON.stringify(body) : undefined,
  });
  return JSON.parse(await res.text());
}

/* ------------------------------------------------------------------- the panel */

console.log("bench panel");

const { listener, port: targetPort } = await localEndpoint();
const panelDir = prepareDir({
  endpoints: [{ id: "local", label: "Local test", host: "127.0.0.1", port: targetPort, kind: "game" }],
});
const panelPort = await freePort();
const panelServer = await startServer(panelDir, panelPort);

try {
  const first = await openPage({ source: APP, html: HTML, origin: panelServer.origin, token: panelServer.token });
  const { dom, page } = first;

  // The card exists, the picker offers the settings the catalog names, and nothing is enabled
  // before a baseline: the whole card is inert until there is something to compare with.
  assert.ok(dom.el("benchTweak").innerHTML.includes('value="plan-power"'), "the picker offers the power-plan setting");
  assert.ok(!dom.el("benchTweak").innerHTML.includes('value="dns"'), "DNS is not offered: the probe does not time lookups");
  assert.equal(dom.el("benchApply").disabled, true, "Apply is disabled with no baseline");
  assert.equal(dom.el("benchFinish").disabled, true, "Measure again is disabled with no baseline");
  assert.match(dom.el("benchMsg").textContent, /Not started/, "the card starts by explaining itself");

  dom.el("benchTweak").value = "plan-power";
  assert.equal(dom.el("benchBaseline").click(), 1, "the baseline button has a click handler");
  const pending = await until(() => page.state.bench.pending, "the baseline to be captured");
  assert.equal(pending.tweak, "plan-power");
  assert.match(dom.el("benchMsg").textContent, /Baseline captured .* median \d+(\.\d+)? ms/, "the card shows the baseline figures");
  assert.doesNotMatch(dom.el("benchMsg").textContent, /undefined|NaN/, "no placeholder leaked into the message");
  assert.equal(dom.el("benchApply").disabled, false, "Apply becomes available after a baseline");
  assert.match(dom.el("benchApply").textContent, /^2\. Apply \S/, "the button names the setting");
  assert.ok(
    first.requests.some((r) => r.url.includes("/api/benchmark/baseline") && r.body.includes('"tweak":"plan-power"')),
    "the baseline was requested over HTTP, not faked locally",
  );

  // A reload: a new page against the same server has to rehydrate the pending baseline from
  // GET /api/benchmark. That response carries no apply action, so this is also the check that
  // the panel resolves one from the catalog instead of posting an undefined action.
  const second = await openPage({ source: APP, html: HTML, origin: panelServer.origin, token: panelServer.token });
  assert.equal(second.page.state.bench.pending?.id, pending.id, "the reloaded page knows the pending baseline");
  assert.equal(second.page.state.bench.pending.applyAction, undefined, "the GET response is the reason the panel needs the catalog");
  assert.equal(second.dom.el("benchApply").disabled, false, "Apply is enabled on the reloaded page");

  assert.equal(second.dom.el("benchApply").click(), 1, "Apply has a click handler");
  await until(() => second.page.state.tweak?.planPower === "off", "the setting to be applied");
  const applyRequest = second.requests.find((r) => r.url.includes("/api/tweak"));
  assert.ok(applyRequest, "Apply went through the same /api/tweak dispatch every button uses");
  assert.match(applyRequest.body, /plan-power-off/, "the reloaded page sent the real action, not undefined");

  assert.equal(second.dom.el("benchFinish").click(), 1, "Measure again has a click handler");
  const latest = await until(
    () =>
      second.page.state.bench.latest?.data?.result && !second.page.state.bench.pending
        ? second.page.state.bench.latest
        : null,
    "the comparison",
  );
  assert.ok(
    second.requests.some((r) => r.url.includes("/api/benchmark/finish") && r.body.includes(`"id":"${pending.id}"`)),
    "Measure again compared the baseline the panel holds",
  );
  assert.equal(second.dom.el("benchMsg").textContent.startsWith("Last comparison"), true, "the card moves on to the comparison");

  const html = second.dom.el("benchResult").innerHTML;
  assert.match(html, /<table/, "the comparison renders a table");
  for (const label of ["Median latency", "P95", "Jitter", "Packet loss"]) {
    assert.ok(html.includes(label), `the table has a ${label} row`);
  }
  assert.match(html, /(Improved|Regressed|Within noise)/, "the verdict is named in words");
  assert.match(html, /<th class="num">%/, "the table has a percentage column");
  assert.match(html, /<td class="num">[+\u2212-]?\d/, "a numeric delta is shown");
  assert.match(html, /±/, "the noise band is shown next to the delta");
  assert.doesNotMatch(html, /NaN|undefined|Infinity/, "no fabricated or broken figure reached the table");
  for (const metric of latest.data.result.metrics) {
    assert.ok(html.includes(metric.label), `the rendered table has the server's ${metric.label} metric`);
  }

  // Stored, not just displayed: a fresh read of the API and the history list both have it.
  const stored = await apiJson(panelServer.origin, panelServer.token, "/api/benchmark");
  assert.equal(stored.latest.id, latest.id, "the comparison is persisted and read back");
  const historyItems = await until(
    () => (second.dom.el("historyList").innerHTML.includes("benchmark") ? second.dom.el("historyList").innerHTML : null),
    "the stored comparison to reach the history card",
  );
  assert.match(historyItems, /benchmark/, "the comparison appears in the page's history list without a reload");

  // The confirm is the gate: refusing it must send no request and change nothing.
  second.dom.confirmAnswer = false;
  assert.equal(second.dom.el("benchRevert").click(), 1, "Roll back has a click handler");
  await sleep(300);
  assert.equal(second.dom.confirmCalls.length, 1, "the rollback asked for approval");
  assert.doesNotMatch(second.dom.confirmCalls[0], /undefined/, "the approval names the setting");
  assert.equal(
    second.requests.filter((r) => r.url.includes("/api/benchmark/revert")).length,
    0,
    "refusing the confirm sent no revert request",
  );
  assert.equal(second.page.state.tweak.planPower, "off", "refusing the confirm left the setting applied");
  assert.equal(second.page.state.bench.reverted, false, "refusing the confirm recorded nothing");

  second.dom.confirmAnswer = true;
  second.dom.el("benchRevert").click();
  await until(() => second.page.state.bench.reverted === true, "the rollback to be recorded");
  const revertRequest = second.requests.find((r) => r.url.includes("/api/benchmark/revert"));
  assert.match(revertRequest.body, /"approve":true/, "the approved rollback says so on the wire");
  const toastText = second.dom.el("toast").textContent;
  assert.match(toastText, /rolled back from its restore point/, "the page says what happened");
  assert.match(toastText, /Nothing else PingLab changed is still applied/, "the page says what is (not) still applied");
  assert.equal(second.dom.el("benchRevert").classList.contains("hidden"), true, "an undone comparison does not invite a second undo");
  assert.equal(second.page.state.tweak.planPower, "on", "the setting is back the way it was");
  assert.match(second.dom.el("benchResult").innerHTML, /Rolled back from its restore point/, "the rendered card records the undo");
  const afterRevert = await apiJson(panelServer.origin, panelServer.token, "/api/benchmark");
  assert.equal(afterRevert.reverts[0].data.comparisonId, latest.id, "the undo is stored against the comparison");
  assert.equal(afterRevert.reverts[0].data.restored, true);

  console.log("  panel       baseline, apply, measure, table, stored comparison");
  console.log("  reload      pending baseline rehydrated, Apply sends the real action");
  console.log("  rollback    confirm required, refused sends nothing, approved reports and undoes");
} finally {
  panelServer.child.kill();
  listener.close();
}

/* ------------------------------------------------------------- not enough data */

console.log("bench panel, insufficient data");

const thinDir = prepareDir();
seed(thinDir, [
  {
    kind: "benchmark",
    summary: "Not enough data to compare: the before run had only 2 usable repeats (3 needed).",
    data: {
      label: "Wireless power saving",
      result: {
        verdict: "insufficient",
        reason: "Not enough data to compare: the before run had only 2 usable repeats (3 needed).",
        metrics: [],
      },
    },
  },
]);
const thinPort = await freePort();
const thinServer = await startServer(thinDir, thinPort);

try {
  const { dom } = await openPage({ source: APP, html: HTML, origin: thinServer.origin, token: thinServer.token });
  const html = dom.el("benchResult").innerHTML;
  assert.match(html, /Not enough data to compare/, "the stored reason is shown");
  assert.match(html, /class="warn"/, "it is marked as a warning, not a result");
  assert.doesNotMatch(html, /<table/, "no table is rendered for a comparison that did not happen");
  assert.doesNotMatch(html, /±|NaN|undefined|Infinity/, "no fabricated delta or band is rendered");
  assert.equal(dom.el("benchRevert").classList.contains("hidden"), true, "there is nothing to roll back");
  console.log("  insufficient  reason shown, no numbers, nothing to roll back");
} finally {
  thinServer.child.kill();
}

/* ------------------------------------------------------------------- surfaces */

console.log("bench surfaces");

const surfaceSuffix = revertSentence({ label: "Wireless power saving", restored: true, stillPending: 0 });
const failedSuffix = revertSentence({ label: "Nagle's algorithm", restored: false, message: "Windows refused the write.", stillPending: 1 });
const comparisonText = "Within noise on every metric - Wireless power saving: median latency 24.0 ms to 23.0 ms.";

const surfaceDir = prepareDir();
seed(surfaceDir, [
  {
    kind: "benchmark",
    summary: comparisonText,
    data: { label: "Wireless power saving", result: { verdict: "within-noise", metrics: [] } },
  },
  {
    kind: "benchmark-revert",
    summary: surfaceSuffix,
    data: { comparisonId: "comparison-1", restored: true, stillPending: 0, sentence: surfaceSuffix },
  },
]);
const surfacePort = await freePort();
const surfaceServer = await startServer(surfaceDir, surfacePort);

// The dashboard is a terminal frame: strip colour and erase codes and box borders, and join
// wrapped lines with a space so a sentence that the terminal wrapped is still one sentence.
const plain = (text) =>
  text
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
    .replace(/[│─╭╮╰╯]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

function runOnce() {
  return plain(
    execFileSync(process.execPath, [join(ROOT, "pinglab.mjs"), "--once"], {
      cwd: ROOT,
      env: {
        ...process.env,
        PINGLAB_DATA_DIR: surfaceDir,
        PINGLAB_PS_STUB: join(ROOT, "lib", "ps-fake.mjs"),
        PINGLAB_PS_SCENARIO_FILE: join(surfaceDir, "scenario.json"),
      },
      encoding: "utf8",
    }),
  );
}

function bridgeState(dir) {
  return new Promise((resolve, reject) => {
    const outFile = join(dir, "bridge-out.jsonl");
    const child = spawn(process.execPath, [join(ROOT, "pinglab.mjs"), "--bridge", "--out", outFile], {
      cwd: ROOT,
      env: {
        ...process.env,
        PINGLAB_DATA_DIR: dir,
        PINGLAB_PS_STUB: join(ROOT, "lib", "ps-fake.mjs"),
        PINGLAB_PS_SCENARIO_FILE: join(dir, "scenario.json"),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let log = "";
    child.stdout.on("data", (b) => (log += b));
    child.stderr.on("data", (b) => (log += b));
    child.stdin.write(JSON.stringify({ id: "s1", cmd: "state", args: {} }) + "\n");
    const deadline = Date.now() + 30_000;
    const poll = () => {
      let text = "";
      try {
        text = readFileSync(outFile, "utf8");
      } catch {}
      const line = text
        .split("\n")
        .filter(Boolean)
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .find((m) => m && m.id === "s1");
      if (line) {
        child.stdin.end();
        child.kill();
        resolve(line);
        return;
      }
      if (Date.now() > deadline) {
        child.kill();
        reject(new Error(`bridge did not answer: ${log}`));
        return;
      }
      setTimeout(poll, 50);
    };
    child.on("error", reject);
    poll();
  });
}

try {
  const state = await apiJson(surfaceServer.origin, surfaceServer.token, "/api/state");
  assert.equal(state.benchmark.latest.summary, comparisonText, "/api/state carries the comparison");
  assert.equal(state.benchmark.lastRevert.summary, surfaceSuffix, "/api/state carries the rollback outcome");
  assert.equal(state.benchmark.lastRevert.data.restored, true);

  const dashboard = runOnce();
  assert.ok(dashboard.includes(comparisonText), "the terminal dashboard prints the comparison sentence");
  assert.ok(dashboard.includes("rolled back from its restore point."), "and the rollback outcome");
  assert.ok(dashboard.includes("Nothing else PingLab changed is still applied."), "including that nothing else is still applied");

  // The GUI reads exactly this bridge response; the sentence and the unanswered part of it
  // must be in it, or the window cannot report an undo truthfully.
  const bridge = await bridgeState(surfaceDir);
  assert.equal(bridge.ok, true, "the bridge answered");
  assert.equal(bridge.data.benchmark.latest.summary, comparisonText, "the GUI's state carries the comparison");
  assert.equal(bridge.data.benchmark.lastRevert.summary, surfaceSuffix, "the GUI's state carries the rollback sentence");
  assert.equal(bridge.data.benchmark.lastRevert.data.stillPending, 0);

  // A rollback that did not restore everything has to say so, not just "rolled back".
  const failedDir = prepareDir();
  seed(failedDir, [
    {
      kind: "benchmark",
      summary: comparisonText,
      data: { label: "Nagle's algorithm", result: { verdict: "regressed", metrics: [] } },
    },
    {
      kind: "benchmark-revert",
      summary: failedSuffix,
      data: { comparisonId: "comparison-2", restored: false, message: "Windows refused the write.", stillPending: 1, sentence: failedSuffix },
    },
  ]);
  const failedServer = await startServer(failedDir, await freePort());
  try {
    const text = plain(
      execFileSync(process.execPath, [join(ROOT, "pinglab.mjs"), "--once"], {
        cwd: ROOT,
        env: {
          ...process.env,
          PINGLAB_DATA_DIR: failedDir,
          PINGLAB_PS_STUB: join(ROOT, "lib", "ps-fake.mjs"),
          PINGLAB_PS_SCENARIO_FILE: join(failedDir, "scenario.json"),
        },
        encoding: "utf8",
      }),
    );
    assert.ok(text.includes("did not complete - Windows refused the write."), "a failed rollback is reported as failed");
    assert.ok(text.includes("1 change PingLab made is still applied."), "and the change it left behind is counted");
  } finally {
    failedServer.child.kill();
  }

  console.log("  surfaces    /api/state, the dashboard and the GUI bridge report both outcomes");
} finally {
  surfaceServer.child.kill();
}

/* The GUI itself is WinForms and cannot run headless here; what can be checked is that the
   script still parses after adding its benchmark reporting. */
const psParse = execFileSync(
  "powershell",
  [
    "-NoProfile",
    "-Command",
    "$t = $null; $e = $null; [System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path 'PingLab.ps1').Path, [ref]$t, [ref]$e) > $null; if ($e.Count -gt 0) { $e | ForEach-Object { Write-Output $_.Message }; exit 1 }",
  ],
  { cwd: ROOT, encoding: "utf8" },
);
assert.equal(psParse.trim(), "", "PingLab.ps1 parses after the benchmark reporting was added");
console.log("  gui         PingLab.ps1 parses");

// Housekeeping: Windows keeps the SQLite file locked for a moment after a killed server.
for (const dir of [panelDir, thinDir, surfaceDir]) {
  for (let i = 0; i < 20; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      break;
    } catch {
      await sleep(100);
    }
  }
}

console.log("\nall bench UI checks passed");
