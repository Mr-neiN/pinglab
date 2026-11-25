import {
  performance,
} from "node:perf_hooks";

import { resolveHost, tcpPing, summarize, round, sleep } from "./probe.mjs";

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
