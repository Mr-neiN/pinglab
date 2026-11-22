import net from "node:net";
import dns from "node:dns/promises";
import { performance } from "node:perf_hooks";
import { runPsJson } from "./ps.mjs";

const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Resolve once so DNS time is not counted inside the RTT sample. */
export async function resolveHost(host) {
  if (net.isIP(host)) return { ip: host, dnsMs: 0, error: null };
  const started = performance.now();
  try {
    const res = await dns.lookup(host, { family: 4 });
    return { ip: res.address, dnsMs: round(performance.now() - started), error: null };
  } catch (e) {
    return { ip: null, dnsMs: null, error: e.code || e.message };
  }
}

/** One TCP handshake RTT, in ms. Measured to an IP: this is what a game connection does. */
export function tcpPing(ip, port, timeout = 1500) {
  return new Promise((resolve) => {
    const started = performance.now();
    const socket = new net.Socket();
    let settled = false;
    const done = (ms, error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ms, error });
    };
    const timer = setTimeout(() => done(null, "timeout"), timeout);
    socket.once("connect", () => {
      clearTimeout(timer);
      done(round(performance.now() - started), null);
    });
    socket.once("error", (err) => {
      clearTimeout(timer);
      done(null, err.code || "error");
    });
    try {
      socket.connect({ host: ip, port });
    } catch (err) {
      clearTimeout(timer);
      done(null, err.code || "error");
    }
  });
}

/**
 * min / avg / p95 / jitter / loss from a list of samples.
 * `samples` must arrive in the order they were measured: jitter is the mean absolute
 * difference between *consecutive* round-trips, so it is computed before anything is
 * sorted. Percentiles and min/max are read off the sorted copy.
 */
export function summarize(samples, failures = 0, total) {
  const measured = samples.filter((n) => typeof n === "number" && Number.isFinite(n));
  const sorted = [...measured].sort((a, b) => a - b);
  const sent = total ?? measured.length + failures;
  if (!measured.length) {
    return { min: null, avg: null, max: null, p95: null, jitter: null, loss: sent ? 100 : 0, received: 0, sent };
  }
  const avg = measured.reduce((a, b) => a + b, 0) / measured.length;
  const jitter =
    measured.length > 1
      ? measured.slice(1).reduce((acc, v, i) => acc + Math.abs(v - measured[i]), 0) / (measured.length - 1)
      : 0;
  const p95 = sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * 0.95) - 1))];
  return {
    min: round(sorted[0]),
    avg: round(avg),
    max: round(sorted[sorted.length - 1]),
    p95: round(p95),
    jitter: round(jitter),
    loss: round((failures / Math.max(1, sent)) * 100),
    received: measured.length,
    sent,
  };
}

/** Probe one endpoint: resolve, then `count` TCP handshakes with a gap between them. */
async function probeEndpoint(endpoint, { count = 5, gap = 90, port = 443 } = {}) {
  const target = await resolveHost(endpoint.host);
  const base = { ...endpoint, port: endpoint.port ?? port, ip: target.ip, dnsMs: target.dnsMs };
  if (!target.ip) {
    return { ...base, ...summarize([], count, count), error: `DNS lookup failed (${target.error})`, samples: [] };
  }
  const samples = [];
  let failures = 0;
  for (let i = 0; i < count; i++) {
    const hit = await tcpPing(target.ip, base.port, 1500);
    if (typeof hit.ms === "number") samples.push(hit.ms);
    else failures += 1;
    if (i < count - 1) await sleep(gap);
  }
  const stats = summarize(samples, failures, count);
  const error = failures === count ? "no connection established" : null;
  return { ...base, ...stats, samples, error };
}

/** ICMP round-trips for many hosts in one PowerShell call (locale independent .NET Ping). */
async function icmpBatch(targets, { count = 4, timeoutMs = 1200 } = {}) {
  if (!targets.length) return [];
  const list = targets
    .map((t) => `[pscustomobject]@{ host = '${String(t).replace(/'/g, "''")}'; n = ${count} }`)
    .join(", ");
  const script = `
$targets = @(${list})
$ping = New-Object System.Net.NetworkInformation.Ping
$out = foreach ($t in $targets) {
  $times = @()
  $sent = 0
  for ($i = 0; $i -lt $t.n; $i++) {
    $sent++
    try {
      $reply = $ping.Send($t.host, ${timeoutMs})
      if ($reply.Status -eq 'Success') { $times += [double]$reply.RoundtripTime }
    } catch {}
    Start-Sleep -Milliseconds 70
  }
  [pscustomobject]@{ host = $t.host; sent = $sent; times = @($times) }
}
ConvertTo-Json -InputObject @($out) -Compress -Depth 5`;
  const { data } = await runPsJson(script, { timeout: 40000 });
  return (data || []).map((row) => {
    const times = (row.times || []).map(Number).filter(Number.isFinite);
    return { host: row.host, ...summarize(times, (row.sent || 0) - times.length, row.sent || 0) };
  });
}

/** Download streams used only by the bufferbloat test. */
const CHUNK_BYTES = 20_000_000;

async function drain(url, controller, counter) {
  const res = await fetch(url, { signal: controller.signal, cache: "no-store" });
  if (!res.ok || !res.body) throw new Error(`download failed (HTTP ${res.status})`);
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) counter.bytes += value.length;
  }
}

/**
 * Keep the line busy for the whole test. Downloads are repeated in 20 MB chunks: the
 * speed-test endpoint answers very large `bytes` values with HTTP 403, which would
 * silently leave the link idle and produce a meaningless "A" grade.
 */
async function saturate(controller, counter) {
  const nonce = Math.random().toString(36).slice(2);
  try {
    for (;;) {
      await drain(`https://speed.cloudflare.com/__down?bytes=${CHUNK_BYTES}&r=${nonce}`, controller, counter);
      if (controller.signal.aborted) return;
    }
  } catch {
    if (controller.signal.aborted) return;
  }
  try {
    // Fallback mirror in case the speed-test endpoint is blocked on this network.
    await drain("https://proof.ovh.net/files/100Mb.dat", controller, counter);
  } catch {
    /* aborted at the end of the test, this is expected */
  }
}

function gradeBloat(delta) {
  if (delta === null) return "n/a";
  if (delta < 30) return "A";
  if (delta < 60) return "B";
  if (delta < 100) return "C";
  if (delta < 200) return "D";
  return "F";
}

/**
 * Bufferbloat: measure latency idle, then while the link is saturated.
 * This is the real detector of "my ping spikes when someone streams".
 */
/** One full latency run: TCP handshakes per endpoint, then a locale-safe ICMP batch. */
export async function runProbe(endpoints, { count = 5, onProgress } = {}) {
  const results = [];
  for (const endpoint of endpoints) {
    onProgress?.(endpoint);
    results.push(await probeEndpoint(endpoint, { count }));
  }
  const icmpTargets = endpoints.filter((e) => e.kind === "dns").map((e) => e.host).slice(0, 3);
  const icmp = icmpTargets.length ? await icmpBatch(icmpTargets, { count: 4 }) : [];
  return { results, icmp };
}

/** The one summary shape every surface (terminal, GUI, web UI) reports. */
export function summarizeProbe({ results, icmp = [] }) {
  const live = results.filter((r) => r.avg !== null);
  const game = live.filter((r) => r.kind === "game");
  const worstLoss = results.reduce((w, r) => (r.loss > (w?.loss ?? -1) ? r : w), null);
  const worstJitter = results.reduce((w, r) => (r.jitter > (w?.jitter ?? -1) ? r : w), null);
  const avg = (list, key) => {
    const vals = list.map((r) => r[key]).filter((v) => typeof v === "number");
    return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
  };
  return {
    endpoints: results.length,
    reachable: live.length,
    gameAvgMs: avg(game, "avg"),
    gameJitter: avg(game, "jitter"),
    gameLoss: avg(game, "loss"),
    worstLoss: worstLoss ? { label: worstLoss.label, loss: worstLoss.loss } : null,
    worstJitter: worstJitter ? { label: worstJitter.label, jitter: worstJitter.jitter } : null,
    icmpLoss: icmp.length ? Math.max(...icmp.map((i) => i.loss ?? 0)) : null,
  };
}

export async function bufferbloat({ host = "1.1.1.1", port = 443, seconds = 6, streams = 3 } = {}) {
  const target = await resolveHost(host);
  if (!target.ip) return { ok: false, error: "Could not resolve the latency target" };

  const idle = [];
  for (let i = 0; i < 6; i++) {
    const hit = await tcpPing(target.ip, port, 1500);
    if (typeof hit.ms === "number") idle.push(hit.ms);
    await sleep(150);
  }
  const controller = new AbortController();
  const counter = { bytes: 0 };
  const started = performance.now();
  const downloads = Array.from({ length: streams }, () => saturate(controller, counter));

  await sleep(1200); // let the link actually congest
  const loaded = [];
  const measureUntil = performance.now() + seconds * 1000;
  while (performance.now() < measureUntil) {
    const hit = await tcpPing(target.ip, port, 1500);
    if (typeof hit.ms === "number") loaded.push(hit.ms);
    await sleep(200);
  }
  const elapsed = (performance.now() - started) / 1000;
  controller.abort();
  await Promise.allSettled(downloads);

  const idleStats = summarize(idle, 6 - idle.length, 6);
  const loadedStats = summarize(loaded, loaded.length ? 0 : seconds, loaded.length || seconds);
  const delta =
    idleStats.avg !== null && loadedStats.avg !== null ? round(loadedStats.avg - idleStats.avg) : null;
  const mbps = round((counter.bytes * 8) / elapsed / 1e6);

  // Without real traffic there is no congestion, so a "grade" would be a lie.
  if (counter.bytes < 3_000_000) {
    return {
      ok: false,
      target: host,
      idle: idleStats,
      loaded: loadedStats,
      deltaMs: null,
      grade: "n/a",
      downloadMbps: mbps,
      seconds: round(elapsed),
      error: "Could not pull enough data to load the line (the test download was blocked), so this result means nothing.",
    };
  }

  return {
    ok: loaded.length > 0,
    target: host,
    idle: idleStats,
    loaded: loadedStats,
    deltaMs: delta,
    grade: gradeBloat(delta),
    downloadMbps: mbps,
    seconds: round(elapsed),
  };
}
