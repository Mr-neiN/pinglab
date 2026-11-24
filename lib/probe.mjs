import net from "node:net";
import dgram from "node:dgram";
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

/** A deliberately meaningless datagram: this does not pretend to speak a game's protocol. */
const UDP_PAYLOAD = Buffer.from("PingLab UDP probe", "ascii");

/**
 * What a failed UDP exchange means. Windows reports the ICMP "port unreachable" that answers
 * a datagram sent to a closed port as ECONNRESET (Linux uses ECONNREFUSED): the host
 * answered, so it is neither silence nor loss. Anything else completed no round trip.
 */
function udpFailure(err) {
  const code = err?.code;
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ECONNABORTED") return "closed";
  return "unreachable";
}

/**
 * One UDP round-trip: a small datagram out, then wait for the peer's own answer.
 *
 * This is a real measurement only when something answers the datagram. A game service
 * ignores a packet it does not recognise and a firewall may drop UDP, so silence is the
 * normal outcome against a real game port and is reported as unanswered - never as packet
 * loss. A "port closed" answer comes from the host's IP stack rather than the service, so
 * its elapsed time is returned as a path figure that callers must label as such.
 */
export function udpPing(ip, port, { timeoutMs = 900 } = {}) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket(net.isIP(ip) === 6 ? "udp6" : "udp4");
    const started = performance.now();
    let settled = false;
    const done = (ms, outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      resolve({ ms: typeof ms === "number" ? round(ms) : null, outcome });
    };
    const timer = setTimeout(() => done(null, "timeout"), timeoutMs);
    // A listener stays attached for the lifetime of the socket: closing it does not recall
    // an ICMP error the OS was already delivering, and an unheard 'error' would throw.
    socket.on("error", (err) => done(performance.now() - started, udpFailure(err)));
    socket.once("message", () => done(performance.now() - started, "reply"));
    try {
      socket.connect(port, ip, () => {
        socket.send(UDP_PAYLOAD, (err) => {
          if (err) done(null, udpFailure(err));
        });
      });
    } catch (err) {
      done(null, udpFailure(err));
    }
  });
}

/**
 * UDP figures from the probes that actually finished a round trip.
 *
 * `samples` are reply round-trips in the order they were measured, so the jitter rule is
 * the same one TCP and ICMP use. `closed` holds the elapsed times of "port closed"
 * answers, which are kept out of every latency and loss figure: they prove the host is
 * reachable, not that the game answered.
 *
 * Loss exists only once something answered. A port that stays silent - the usual answer to
 * an unknown UDP packet - is not a 100%-loss line, exactly as a blocked ICMP echo is not.
 */
export function summarizeUdp({ sent = 0, samples = [], closed = [], unreachable = 0 } = {}) {
  const measured = samples.filter((n) => typeof n === "number" && Number.isFinite(n));
  const closedTimes = closed.filter((n) => typeof n === "number" && Number.isFinite(n));
  const total = sent || measured.length;
  const stats = summarize(measured, total - measured.length, total);
  const state = measured.length
    ? "answered"
    : closedTimes.length
      ? "closed"
      : unreachable
        ? "unreachable"
        : total
          ? "silent"
          : "none";
  return {
    sent: total,
    replies: measured.length,
    state,
    min: stats.min,
    avg: stats.avg,
    max: stats.max,
    p95: stats.p95,
    jitter: stats.jitter,
    loss: measured.length ? stats.loss : null,
    closedCount: closedTimes.length,
    pathMs: closedTimes.length
      ? round(closedTimes.reduce((a, b) => a + b, 0) / closedTimes.length)
      : null,
    unreachable,
  };
}

const UDP_COUNT = 4;
const UDP_TIMEOUT_MS = 900;

/**
 * `count` UDP probes to one endpoint, on the address and port its TCP probe already resolved.
 * Only resolved endpoints are probed (a lookup that failed has no address to send to, so it
 * gets no UDP row), which is also why this carries no DNS figure: it measures none.
 */
export async function probeUdp(endpoint, { count = UDP_COUNT, timeoutMs = UDP_TIMEOUT_MS, gap = 100 } = {}) {
  const base = {
    id: endpoint.id,
    label: endpoint.label,
    host: endpoint.host,
    port: endpoint.port ?? 443,
    ip: endpoint.ip ?? null,
  };
  const samples = [];
  const closed = [];
  let unreachable = 0;
  for (let i = 0; i < count; i++) {
    const hit = await udpPing(base.ip, base.port, { timeoutMs });
    if (hit.outcome === "reply") samples.push(hit.ms);
    else if (hit.outcome === "closed") closed.push(hit.ms);
    else if (hit.outcome !== "timeout") unreachable += 1;
    if (i < count - 1) await sleep(gap);
  }
  return { ...base, ...summarizeUdp({ sent: count, samples, closed, unreachable }) };
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

/**
 * One full latency run: TCP handshakes per endpoint, a locale-safe ICMP batch, and UDP
 * probes to the game endpoints - the transport games actually use.
 */
export async function runProbe(endpoints, { count = 5, onProgress } = {}) {
  const results = [];
  for (const endpoint of endpoints) {
    onProgress?.(endpoint);
    results.push(await probeEndpoint(endpoint, { count }));
  }
  const icmpTargets = endpoints.filter((e) => e.kind === "dns").map((e) => e.host).slice(0, 3);
  const icmp = icmpTargets.length ? await icmpBatch(icmpTargets, { count: 4 }) : [];
  // Same host and port as each game endpoint's TCP probe. UDP is connectionless, so the
  // endpoints are probed at once: a port that never answers costs one timeout series
  // instead of one per endpoint in sequence.
  const udpTargets = results.filter((r) => r.kind === "game" && r.ip);
  const udp = await Promise.all(udpTargets.map((r) => probeUdp(r)));
  return { results, icmp, udp };
}

/** The one summary shape every surface (terminal, GUI, web UI) reports. */
export function summarizeProbe({ results, icmp = [], udp = [] }) {
  const live = results.filter((r) => r.avg !== null);
  const game = live.filter((r) => r.kind === "game");
  const worstLoss = results.reduce((w, r) => (r.loss > (w?.loss ?? -1) ? r : w), null);
  const worstJitter = results.reduce((w, r) => (r.jitter > (w?.jitter ?? -1) ? r : w), null);
  const avg = (list, key) => {
    const vals = list.map((r) => r[key]).filter((v) => typeof v === "number");
    return vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
  };

  // ICMP is measured as a cross-check, not as a second game figure. Keeping its avg and
  // jitter (instead of only its loss) is what lets a surface say whether a TCP handshake
  // is adding delay over the path, or whether the port never answered at all.
  const icmpRows = (icmp || []).filter((i) => i && typeof i.loss === "number");
  const icmpAnswered = icmpRows.filter((i) => (i.received ?? 0) > 0).length;
  const tcpAvg = avg(live, "avg");
  const icmpAvg = avg(icmpRows, "avg");
  const gapMs = tcpAvg !== null && icmpAvg !== null ? Math.round((tcpAvg - icmpAvg) * 10) / 10 : null;
  const transport = icmpRows.length
    ? {
        tcpMs: tcpAvg,
        icmpMs: icmpAvg,
        gapMs,
        targets: icmpRows.length,
        icmpAnswered,
        tcpUnreachable: results.filter((r) => r.avg === null).length,
      }
    : null;

  // UDP is timed only where a service answered the probe. The three outcomes stay apart:
  // a real service round-trip, a host that said "port closed" (path evidence only), and
  // silence, which is not loss.
  const udpRows = (udp || []).filter((u) => u && typeof u.state === "string");
  const udpAnswered = udpRows.filter((u) => u.state === "answered");
  const udpClosed = udpRows.filter((u) => u.state === "closed");
  const udpSummary = udpRows.length
    ? {
        targets: udpRows.length,
        answered: udpAnswered.length,
        closed: udpClosed.length,
        // Everything that is not a service reply or a closed port is "no service answer",
        // so the three counts always add up to targets.
        silent: udpRows.filter((u) => u.state !== "answered" && u.state !== "closed").length,
        serviceMs: avg(udpAnswered, "avg"),
        loss: udpAnswered.length ? Math.max(...udpAnswered.map((u) => u.loss ?? 0)) : null,
        pathMs: avg(udpClosed, "pathMs"),
      }
    : null;

  return {
    endpoints: results.length,
    reachable: live.length,
    gameAvgMs: avg(game, "avg"),
    gameJitter: avg(game, "jitter"),
    gameLoss: avg(game, "loss"),
    worstLoss: worstLoss ? { label: worstLoss.label, loss: worstLoss.loss } : null,
    worstJitter: worstJitter ? { label: worstJitter.label, jitter: worstJitter.jitter } : null,
    icmpAvgMs: icmpAvg,
    icmpJitter: avg(icmpRows, "jitter"),
    // No reply at all is usually a blocked ICMP echo, not a 100%-loss line; the transport
    // text names that difference instead of reporting a number that looks like packet loss.
    icmpLoss: icmpAnswered ? Math.max(...icmpRows.map((i) => i.loss ?? 0)) : null,
    icmpAnswered,
    icmpBlocked: icmpRows.length > 0 && icmpAnswered === 0,
    transport,
    udp: udpSummary,
  };
}

/* ------------------------------------------------------- bufferbloat (down/up) */

/** Download streams used only by the bufferbloat test. */
const CHUNK_BYTES = 20_000_000;
// Small upload requests on purpose: bytes are counted only when the server accepted the
// request, so a rejected upload cannot look like traffic, and even a ~0.5 Mbps uplink
// finishes one 256 KB request inside the test window.
const UPLOAD_BYTES = 256 * 1024;
const UPLOAD_PIECE = 64 * 1024;
/** Below these, the line was not actually busy in that direction and a grade would be a lie. */
const MIN_DOWNLOAD_BYTES = 3_000_000;
const MIN_UPLOAD_BYTES = 256 * 1024;
const MODES = new Set(["both", "down", "up", "duplex"]);
const GRADE_RANK = { A: 0, B: 1, C: 2, D: 3, F: 4 };
const DEFAULT_URLS = {
  down: "https://speed.cloudflare.com/__down",
  up: "https://speed.cloudflare.com/__up",
  // Mirror used only for download when the speed-test endpoint itself fails.
  fallback: "https://proof.ovh.net/files/100Mb.dat",
};

function downloadUrl(base) {
  const url = new URL(base);
  url.searchParams.set("bytes", String(CHUNK_BYTES));
  url.searchParams.set("r", Math.random().toString(36).slice(2));
  return url;
}

async function drain(base, controller, counter) {
  const res = await fetch(downloadUrl(base), { signal: controller.signal, cache: "no-store" });
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
async function saturateDown(base, controller, counter, fallback) {
  try {
    for (;;) {
      await drain(base, controller, counter);
      if (controller.signal.aborted) return;
    }
  } catch {
    if (controller.signal.aborted) return;
  }
  if (!fallback) return;
  try {
    // Fallback mirror in case the speed-test endpoint is blocked on this network.
    await drain(fallback, controller, counter);
  } catch {
    /* aborted at the end of the test, this is expected */
  }
}

/**
 * A fixed-size upload body, streamed in small pieces. Bytes are counted as they are handed
 * to the socket, so a slow uplink that has not finished one 8 MB request still contributes
 * the bytes it actually sent instead of reporting zero.
 */
function uploadBody(local) {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (sent >= UPLOAD_BYTES) {
        controller.close();
        return;
      }
      controller.enqueue(new Uint8Array(UPLOAD_PIECE));
      sent += UPLOAD_PIECE;
      local.bytes += UPLOAD_PIECE;
    },
  });
}

async function push(base, controller, counter) {
  // Count this request only once the server has accepted it. Counting as the body is
  // queued made a 405 look like megabytes of traffic, which then earned a grade.
  const local = { bytes: 0 };
  const res = await fetch(base, {
    method: "POST",
    body: uploadBody(local),
    duplex: "half",
    signal: controller.signal,
    cache: "no-store",
    headers: { "Content-Type": "application/octet-stream" },
  });
  if (!res.ok) throw new Error(`upload failed (HTTP ${res.status})`);
  // Consume the empty answer so the connection can be reused for the next chunk.
  await res.arrayBuffer().catch(() => {});
  counter.bytes += local.bytes;
}

async function saturateUp(base, controller, counter) {
  try {
    for (;;) {
      await push(base, controller, counter);
      if (controller.signal.aborted) return;
    }
  } catch {
    /* aborted at the end of the test, this is expected */
  }
}

/**
 * One loaded window: start the traffic, let it congest, then time TCP handshakes for
 * `seconds`. Pings that fail while the line is busy are loss, not missing data: dropping
 * them made a line that starts dropping packets under load read as 0% loss, which is
 * exactly the connection someone is trying to diagnose.
 */
async function loadPhase({ target, port, seconds, streams, urls, mode }) {
  const controller = new AbortController();
  const down = { bytes: 0 };
  const up = { bytes: 0 };
  const started = performance.now();
  const tasks = [];
  if (mode === "down" || mode === "duplex") {
    for (let i = 0; i < streams; i++) tasks.push(saturateDown(urls.down, controller, down, urls.fallback));
  }
  if (mode === "up" || mode === "duplex") {
    for (let i = 0; i < streams; i++) tasks.push(saturateUp(urls.up, controller, up));
  }

  await sleep(1200); // let the link actually congest
  const loaded = [];
  let failures = 0;
  const until = performance.now() + seconds * 1000;
  while (performance.now() < until) {
    const hit = await tcpPing(target, port, 1500);
    if (typeof hit.ms === "number") loaded.push(hit.ms);
    else failures += 1;
    await sleep(200);
  }
  const elapsed = (performance.now() - started) / 1000;
  controller.abort();
  await Promise.allSettled(tasks);
  return { loaded, failures, elapsed, downBytes: down.bytes, upBytes: up.bytes };
}

export function gradeBloat(delta) {
  if (delta === null) return "n/a";
  if (delta < 30) return "A";
  if (delta < 60) return "B";
  if (delta < 100) return "C";
  if (delta < 200) return "D";
  return "F";
}

function phaseResult(idle, raw, direction) {
  const bytes = direction === "upload" ? raw.upBytes : raw.downBytes;
  const loaded = summarize(raw.loaded, raw.failures, raw.loaded.length + raw.failures);
  const enough = bytes >= (direction === "upload" ? MIN_UPLOAD_BYTES : MIN_DOWNLOAD_BYTES);
  const delta = enough && idle.avg !== null && loaded.avg !== null ? round(loaded.avg - idle.avg) : null;
  const mbps = round((bytes * 8) / Math.max(0.001, raw.elapsed) / 1e6);
  return {
    direction,
    ok: enough && loaded.received > 0,
    idle,
    loaded,
    deltaMs: delta,
    grade: enough ? gradeBloat(delta) : "n/a",
    mbps,
    bytes,
    seconds: round(raw.elapsed),
    error: enough
      ? null
      : `not enough ${direction === "upload" ? "upload" : "download"} traffic moved (${mbps} Mbps), so the line was not loaded and this result means nothing.`,
  };
}

/**
 * Bufferbloat in both directions: measure latency idle, then while the link is saturated
 * by downloads, uploads, or both at once. This is the real detector of "my ping spikes
 * when someone streams" (down) and "when someone uploads a clip" (up).
 *
 * `urls` exists for the test suite: a local HTTP server can serve the same downloads and
 * accept the same uploads, so the whole down/up path is exercised without the internet.
 */
export async function bufferbloat({
  host = "1.1.1.1",
  port = 443,
  seconds = 6,
  streams = 3,
  direction = "both",
  urls = DEFAULT_URLS,
} = {}) {
  const mode = MODES.has(direction) ? direction : "both";
  const target = await resolveHost(host);
  if (!target.ip) {
    return {
      ok: false,
      mode,
      target: host,
      download: null,
      upload: null,
      grade: "n/a",
      overallGrade: "n/a",
      deltaMs: null,
      error: "Could not resolve the latency target",
    };
  }

  const idle = [];
  let idleFailures = 0;
  for (let i = 0; i < 6; i++) {
    const hit = await tcpPing(target.ip, port, 1500);
    if (typeof hit.ms === "number") idle.push(hit.ms);
    else idleFailures += 1;
    await sleep(150);
  }
  const idleStats = summarize(idle, idleFailures, 6);
  const base = { target: target.ip, port, seconds, streams, urls };

  let download = null;
  let upload = null;
  if (mode === "duplex") {
    const raw = await loadPhase({ ...base, mode: "duplex" });
    download = phaseResult(idleStats, raw, "download");
    upload = phaseResult(idleStats, raw, "upload");
  } else if (mode === "both") {
    // Sequential on purpose: each direction gets a clean window, so a congested uplink
    // cannot make the download figure look better than it is (or the reverse).
    download = phaseResult(idleStats, await loadPhase({ ...base, mode: "down" }), "download");
    upload = phaseResult(idleStats, await loadPhase({ ...base, mode: "up" }), "upload");
  } else if (mode === "up") {
    upload = phaseResult(idleStats, await loadPhase({ ...base, mode: "up" }), "upload");
  } else {
    download = phaseResult(idleStats, await loadPhase({ ...base, mode: "down" }), "download");
  }

  const phases = [download, upload].filter(Boolean);
  const graded = phases.filter((p) => p.grade !== "n/a");
  const worst = [...graded].sort((a, b) => GRADE_RANK[b.grade] - GRADE_RANK[a.grade])[0] ?? null;
  const error = graded.length
    ? null
    : phases.map((p) => p.error).filter(Boolean).join(" ") || "Neither direction could load the line.";

  return {
    ok: phases.some((p) => p.ok),
    mode,
    target: host,
    idle: idleStats,
    download,
    upload,
    overallGrade: worst?.grade ?? "n/a",
    // The top-level figures keep the meaning older surfaces expect: the worst direction,
    // because a good download grade must never hide a failing upload grade.
    grade: worst?.grade ?? "n/a",
    deltaMs: worst?.deltaMs ?? null,
    loaded: worst?.loaded ?? null,
    downloadMbps: download?.mbps ?? null,
    uploadMbps: upload?.mbps ?? null,
    seconds: round(phases.reduce((sum, p) => sum + (p.seconds || 0), 0)),
    error,
  };
}
