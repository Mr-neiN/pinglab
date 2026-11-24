/**
 * The before/after verdict rule, with fixed inputs.
 *
 * The point of this file is the part a user cannot check for themselves: what counts as a
 * change. It fixes the noise band by construction (identical repeats have zero spread, so the
 * floor is what decides), then moves one figure at a time across the line:
 *
 *   boundary      a difference exactly at the threshold is within noise, in both directions
 *   floor         a 1 ms move on a perfectly stable line is not an improvement
 *   spread        a difference smaller than the runs' own range is within noise
 *   directions    lower latency/jitter/loss is improved; higher is regressed
 *   insufficient  too few repeats, a repeat missing an endpoint, or two phases measured
 *                 differently are refused with a reason and no numbers
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

import {
  BENCH,
  analysePhase,
  baselineExpired,
  benchParams,
  benchSentence,
  compareBenchmark,
  paramsKey,
  VERDICT_TEXT,
} from "./bench.mjs";

/* A run with one game endpoint whose every sample is `ms`, unless a case says otherwise. */
function run({ ms = 20, p95 = null, jitter = 0, loss = 0, host = "game.example.com", port = 27015, samples } = {}) {
  const list = samples ?? [ms, ms, ms, ms, ms];
  return {
    results: [{ kind: "game", host, port, samples: list, p95: p95 ?? ms, jitter, loss }],
  };
}
const repeats = (n, spec) => Array.from({ length: n }, () => run(typeof spec === "function" ? spec() : spec));
/** For runs that need more than the single-endpoint builder above. */
const threeRuns = (make) => Array.from({ length: 3 }, make);
const phase = (runs, params) => ({ runs, params });
const paramsOf = (...hosts) =>
  benchParams(
    hosts.map((host, i) => ({ id: `ep${i}`, host, port: 27015, kind: "game" })),
  );

const PARAMS = paramsOf("game.example.com");

// 1. Exactly at the boundary is within noise - both directions, and the band is the floor when
//    repeated runs are identical (spread 0).
{
  const up = compareBenchmark({
    before: phase(repeats(3, { ms: 20 }), PARAMS),
    after: phase(repeats(3, { ms: 22 }), PARAMS),
  });
  assert.equal(up.ok, true);
  assert.equal(up.metrics[0].threshold, BENCH.floors.latencyMs, "the floor is the band on a zero-spread line");
  assert.equal(up.metrics[0].delta, 2);
  assert.equal(up.metrics[0].verdict, "within-noise", "2 ms at a 2 ms threshold is not a regression");
  assert.equal(up.verdict, "within-noise");

  const down = compareBenchmark({
    before: phase(repeats(3, { ms: 22 }), PARAMS),
    after: phase(repeats(3, { ms: 20 }), PARAMS),
  });
  assert.equal(down.metrics[0].verdict, "within-noise", "and -2 ms is not an improvement");
}

// 2. The "never call 1 ms an improvement" case: a perfectly stable line, one millisecond better.
{
  const result = compareBenchmark({
    before: phase(repeats(3, { ms: 24 }), PARAMS),
    after: phase(repeats(3, { ms: 23 }), PARAMS),
  });
  assert.equal(result.metrics[0].delta, -1);
  assert.equal(result.metrics[0].verdict, "within-noise");
  assert.equal(result.verdict, "within-noise");
  assert.match(benchSentence(result, { label: "Nagle" }), /no measurable change/);
}

// 3. A move beyond the floor is measurable, and lower is better for every metric.
{
  const result = compareBenchmark({
    before: phase(repeats(3, { ms: 30, p95: 45, jitter: 8, loss: 1 }), PARAMS),
    after: phase(repeats(3, { ms: 22, p95: 30, jitter: 4, loss: 0 }), PARAMS),
  });
  assert.equal(result.verdict, "improved");
  for (const metric of result.metrics) assert.equal(metric.verdict, "improved", `${metric.key} improved`);
  const latency = result.metrics[0];
  assert.equal(latency.before, 30);
  assert.equal(latency.after, 22);
  assert.equal(latency.delta, -8);
  assert.equal(latency.pct, -26.7, "percentage is signed and relative to before");
  assert.match(benchSentence(result, { label: "Nagle" }), /^Nagle: improved - median latency 30 → 22 ms \(-26\.7%\)/);

  const worse = compareBenchmark({
    before: phase(repeats(3, { ms: 22, p95: 30, jitter: 4, loss: 0 }), PARAMS),
    after: phase(repeats(3, { ms: 30, p95: 45, jitter: 8, loss: 1 }), PARAMS),
  });
  assert.equal(worse.verdict, "regressed");
  assert.match(benchSentence(worse, { label: "Nagle" }), /^Nagle: got worse/);
}

// 4. The band is the phases' own spread when that is wider than the floor.
{
  const result = compareBenchmark({
    before: phase([run({ ms: 20 }), run({ ms: 26 }), run({ ms: 22 })], PARAMS),
    after: phase(repeats(3, { ms: 21 }), PARAMS),
  });
  assert.equal(result.metrics[0].spread, 6, "20..26 is a 6 ms run-to-run range");
  assert.equal(result.metrics[0].threshold, 6);
  assert.equal(result.metrics[0].verdict, "within-noise", "1 ms inside a 6 ms band is not a change");
}

// 5. Too few repeats: analysed and compared as insufficient, with no numbers invented.
{
  const analysed = analysePhase(repeats(2, { ms: 20 }));
  assert.equal(analysed.ok, false);
  assert.match(analysed.reason, /only 2 usable repeats instead of at least 3/);

  const result = compareBenchmark({
    before: phase(repeats(2, { ms: 20 }), PARAMS),
    after: phase(repeats(3, { ms: 30 }), PARAMS),
  });
  assert.equal(result.ok, false);
  assert.equal(result.verdict, "insufficient");
  assert.equal(result.metrics.length, 0, "no delta is reported");
  assert.match(result.reason, /^before: only 2 usable repeats/);
  assert.equal(VERDICT_TEXT[result.verdict], "Insufficient data");
  assert.match(benchSentence(result, { label: "Nagle" }), /not enough data to compare/);
}

// 6. A repeat that lost an endpoint is a failed measurement, not a thinner comparison.
{
  const without = { results: [] };
  const result = compareBenchmark({
    before: phase([run({ ms: 20 }), without, run({ ms: 20 })], PARAMS),
    after: phase(repeats(3, { ms: 20 }), PARAMS),
  });
  assert.equal(result.verdict, "insufficient");
  assert.match(result.reason, /repeat 2 measured different endpoints \(missing game\.example\.com:27015\)/);
}

// 7. Different parameters are refused, not compared - the baseline was taken against another
//    endpoint list and says nothing about this one.
{
  const result = compareBenchmark({
    before: phase(repeats(3, { ms: 20 }), paramsOf("game.example.com", "eu.example.com")),
    after: phase(repeats(3, { ms: 20 }), paramsOf("game.example.com")),
  });
  assert.equal(result.ok, false);
  assert.equal(result.rejected, true);
  assert.match(result.reason, /different parameters/);
  assert.equal(result.metrics.length, 0);
  assert.match(benchSentence(result, { label: "Nagle" }), /not compared/);

  // Same parameters on paper, but the after phase never measured the second endpoint, so the
  // two phases describe different paths.
  const twoEndpoints = threeRuns(() => ({
    results: [
      { kind: "game", host: "game.example.com", port: 27015, samples: [20], p95: 20, jitter: 0, loss: 0 },
      { kind: "game", host: "eu.example.com", port: 27015, samples: [30], p95: 30, jitter: 0, loss: 0 },
    ],
  }));
  const missing = compareBenchmark({
    before: phase(twoEndpoints, paramsOf("game.example.com", "eu.example.com")),
    after: phase(repeats(3, { ms: 20 }), paramsOf("game.example.com", "eu.example.com")),
  });
  assert.equal(missing.rejected, true);
  assert.match(missing.reason, /different endpoints/);
}

// 8. Loss is the worst endpoint's, not an average that hides one bad server; a zero baseline
//    has no meaningful percentage, so none is printed.
{
  const withTwo = (lossA, lossB) => ({
    runs: threeRuns(() => ({
      results: [
        { kind: "game", host: "a.example.com", port: 27015, samples: [20], p95: 20, jitter: 0, loss: lossA },
        { kind: "game", host: "b.example.com", port: 27015, samples: [20], p95: 20, jitter: 0, loss: lossB },
      ],
    })),
    params: paramsOf("a.example.com", "b.example.com"),
  });
  const result = compareBenchmark({ before: withTwo(0, 2), after: withTwo(0, 0), floors: { ...BENCH.floors } });
  const loss = result.metrics.find((m) => m.key === "lossPct");
  assert.equal(loss.before, 2, "the worst endpoint is the figure");
  assert.equal(loss.after, 0);
  assert.equal(loss.verdict, "improved");
  assert.equal(loss.pct, -100);

  const fromZero = compareBenchmark({ before: withTwo(0, 0), after: withTwo(0, 1) });
  const worse = fromZero.metrics.find((m) => m.key === "lossPct");
  assert.equal(worse.pct, null, "0% -> 1% has no percentage to print");
  assert.equal(worse.verdict, "regressed");
}

// 9. Params identity does not depend on the order the endpoints are listed in.
{
  // Ids travel with their endpoint: reordering the saved list is not a different measurement.
  const a = benchParams([
    { id: "ep0", host: "a.example.com", port: 27015, kind: "game" },
    { id: "ep1", host: "b.example.com", port: 27015, kind: "game" },
  ]);
  const b = benchParams([
    { id: "ep1", host: "b.example.com", port: 27015, kind: "game" },
    { id: "ep0", host: "a.example.com", port: 27015, kind: "game" },
  ]);
  assert.equal(paramsKey(a), paramsKey(b));
  assert.notEqual(paramsKey(a), paramsKey(paramsOf("a.example.com")));
  assert.equal(paramsKey(null), paramsKey(undefined));
}

console.log("\nbench");
console.log("  boundary   a difference exactly at the threshold is within noise, both directions");
console.log("  floor      a 1 ms move on a stable line is not called an improvement");
console.log("  spread     a move inside the runs' own range is not a change");
console.log("  refused    different parameters or endpoints are refused, with no deltas");
console.log("  insufficient  too few repeats or a lost endpoint yields Insufficient data");

// 10. A baseline older than the policy allows is refused: a measurement taken an evening later
//     is a different condition, not the same one.
{
  const at = 1_700_000_000_000;
  assert.equal(baselineExpired(at, at + BENCH.maxAgeMs), false, "exactly at the age limit is still usable");
  assert.equal(baselineExpired(at, at + BENCH.maxAgeMs + 1), true, "one millisecond past it is not");
  assert.equal(baselineExpired(undefined), true, "a baseline with no timestamp cannot be trusted");
}

/* ------------------------------------------------------ the workflow, end to end */

console.log("bench workflow");

// A measured endpoint that accepts TCP immediately: these tests are about the workflow, not
// about the network, so the handshakes must succeed the same way every time.
function localEndpoint() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer((socket) => socket.end());
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => resolve({ listener, port: listener.address().port }));
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

function request(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    req.setTimeout(120_000, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { listener, port: targetPort } = await localEndpoint();
const httpDir = mkdtempSync(join(tmpdir(), "pinglab-bench-http-"));
writeFileSync(
  join(httpDir, "config.json"),
  JSON.stringify({ endpoints: [{ id: "local", label: "Local test", host: "127.0.0.1", port: targetPort, kind: "game" }] }),
  "utf8",
);

// The fake Windows the engine reads: one adapter, one Wi-Fi profile, and an unset Nagle value
// so applying the tweak is a real change in the recorded state.
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

// The scenario is a file, not an environment variable: the stub writes registry changes back
// to it, which is what makes "the setting is applied before the after-run" checkable here.
const scenarioFile = join(httpDir, "scenario.json");
writeFileSync(scenarioFile, JSON.stringify(scenario, null, 2), "utf8");

const port = await freePort();
const child = spawn(process.execPath, [join(ROOT, "server.mjs")], {
  cwd: ROOT,
  env: {
    ...process.env,
    PORT: String(port),
    PINGLAB_DATA_DIR: httpDir,
    PINGLAB_PS_STUB: join(ROOT, "lib", "ps-fake.mjs"),
    PINGLAB_PS_SCENARIO_FILE: scenarioFile,
  },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
child.stdout.on("data", (b) => (log += b));
child.stderr.on("data", (b) => (log += b));

try {
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
  const host = { host: `127.0.0.1:${port}` };
  const authed = { ...host, "x-pinglab-token": token };
  const post = (path, body) =>
    request(port, {
      method: "POST",
      path,
      headers: { ...authed, origin: `http://127.0.0.1:${port}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const state = async () => JSON.parse((await request(port, { path: "/api/state", headers: authed })).text);

  // 11. A baseline is measured, and the workflow refuses to finish before anything changed.
  const baselineResponse = await post("/api/benchmark/baseline", { tweak: "plan-power" });
  assert.equal(baselineResponse.status, 200, `baseline: ${baselineResponse.status} ${baselineResponse.text.slice(0, 300)}`);
  const baseline = JSON.parse(baselineResponse.text);
  assert.equal(baseline.ok, true);
  assert.equal(baseline.baseline.runs, 3, "three repeats were measured");
  assert.equal(baseline.baseline.endpoints.length, 1);
  assert.equal(typeof baseline.baseline.values.latencyMs, "number", "the baseline has numbers, not promises");
  assert.equal(baseline.applyAction, "plan-power-off", "the workflow names the apply step of the chosen setting");

  const tooEarly = await post("/api/benchmark/finish", { id: baseline.id, tweak: "plan-power" });
  assert.equal(tooEarly.status, 409, "finishing without a change is refused");
  assert.match(JSON.parse(tooEarly.text).error, /Nothing was changed/);

  // 12. Applying exactly one setting, then measuring again, produces a comparison with every
  //     metric and a verdict - not a guessed improvement.
  const alias = (await state()).connection.activeRoute?.alias;
  assert.ok(alias, "an adapter is active");
  const applied = await post("/api/tweak", { action: baseline.applyAction, alias });
  assert.equal(applied.status, 200, `apply: ${applied.status} ${applied.text.slice(0, 300)}`);
  assert.equal((await state()).tweakState.planPower, "off", "the setting is applied before the after-run");

  const finishedResponse = await post("/api/benchmark/finish", { id: baseline.id, tweak: "plan-power" });
  assert.equal(finishedResponse.status, 200, `finish: ${finishedResponse.status} ${finishedResponse.text.slice(0, 300)}`);
  const finished = JSON.parse(finishedResponse.text);
  assert.equal(finished.ok, true);
  assert.equal(finished.result.metrics.length, 4, "median, p95, jitter and loss");
  for (const metric of finished.result.metrics) {
    assert.equal(typeof metric.before, "number", `${metric.key}: before is a number`);
    assert.equal(typeof metric.after, "number", `${metric.key}: after is a number`);
    assert.ok(["improved", "regressed", "within-noise"].includes(metric.verdict), `${metric.key}: verdict`);
    assert.ok(metric.threshold >= metric.floor, `${metric.key}: the band is at least the floor`);
  }
  assert.ok(["improved", "regressed", "within-noise"].includes(finished.result.verdict));
  assert.match(finished.sentence, /^Wireless power saving/);

  // 13. The comparison is stored and can be read back later, with the runs it was made from.
  const stored = JSON.parse((await request(port, { path: "/api/benchmark", headers: authed })).text);
  assert.ok(stored.latest, "the latest comparison is served");
  assert.equal(stored.latest.id, finished.id);
  assert.equal(stored.latest.data.tweak, "plan-power");
  assert.equal(stored.latest.data.before.length, 3, "the before runs are kept");
  assert.equal(stored.latest.data.after.length, 3, "the after runs are kept");
  assert.equal(stored.latest.data.result.verdict, finished.result.verdict);
  assert.equal(stored.pending, null, "the baseline was consumed");

  // 14. A rollback without explicit approval is refused and changes nothing; with approval it
  //     runs the same revert every other surface uses and says what happened.
  const refused = await post("/api/benchmark/revert", { id: finished.id });
  assert.equal(refused.status, 400, "no approval, no rollback");
  assert.match(JSON.parse(refused.text).error, /explicit approval/);
  assert.equal((await state()).tweakState.planPower, "off", "the refused rollback left the setting applied");

  const rolledBack = await post("/api/benchmark/revert", { id: finished.id, approve: true });
  assert.equal(rolledBack.status, 200, `revert: ${rolledBack.status} ${rolledBack.text.slice(0, 300)}`);
  const revert = JSON.parse(rolledBack.text);
  assert.equal(revert.restored, true, "the rollback reports what it did");
  // The sentence itself comes from the dispatch table (the fake answers with its own), so what
  // is asserted here is that one travels, not its wording.
  assert.equal(typeof revert.message, "string");
  assert.ok(revert.message.length > 0, "the response says what happened");
  assert.equal(typeof revert.pending.count, "number", "what is still changed is reported too");
  assert.equal((await state()).tweakState.planPower, "on", "the setting is back to how it was");

  const afterRevert = JSON.parse((await request(port, { path: "/api/benchmark", headers: authed })).text);
  assert.equal(afterRevert.reverts[0].data.comparisonId, finished.id, "the rollback is recorded");
  assert.equal(afterRevert.reverts[0].data.restored, true);
  assert.equal(afterRevert.reverts[0].data.message, revert.message, "with the sentence the caller saw");

  console.log("  baseline   3 repeats measured, and finishing before a change is refused");
  console.log("  compare    four metrics with before/after, band and verdict; stored with its runs");
  console.log("  rollback   refused without approval, applied with it, and recorded");
} finally {
  child.kill();
  listener.close();
  // The database file stays locked for a moment after the server is killed. Cleaning the temp
  // folder is housekeeping, not an assertion, so retry instead of failing the suite.
  for (let i = 0; i < 20; i += 1) {
    try {
      rmSync(httpDir, { recursive: true, force: true });
      break;
    } catch {
      await sleep(100);
    }
  }
}

console.log("\nall bench checks passed");
