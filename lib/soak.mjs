import { resolveHost, tcpPing } from "./probe.mjs";
import {
  createSoakRun,
  insertSoakSample,
  finishSoakRun,
  getSoakSamples,
  getSoakRun,
  listSoakRuns,
} from "./db.mjs";

export const SOAK_TARGETS = [
  { id: "riot", label: "Riot / Valorant EUW", host: "euw1.chat.si.riotgames.com", port: 443 },
  { id: "discord", label: "Discord gateway", host: "gateway.discord.gg", port: 443 },
  { id: "steam", label: "Steam", host: "steamcommunity.com", port: 443 },
  { id: "cloudflare", label: "Cloudflare 1.1.1.1", host: "1.1.1.1", port: 443 },
];

const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

let active = null;
let lastStatus = null;

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return round(sorted[idx]);
}

/** Summarize one target's samples: percentiles, jitter, loss, spikes and the worst minute. */
function summarizeTarget(rows, startTs) {
  const okMs = rows.filter((r) => r.ms !== null && Number.isFinite(r.ms)).map((r) => r.ms);
  const sorted = [...okMs].sort((a, b) => a - b);
  const sent = rows.length;
  const received = okMs.length;

  let jitter = null;
  if (okMs.length > 1) {
    let sum = 0;
    for (let i = 1; i < okMs.length; i++) sum += Math.abs(okMs[i] - okMs[i - 1]);
    jitter = round(sum / (okMs.length - 1));
  }

  const p50 = percentile(sorted, 50);
  const spikes = p50 === null ? 0 : okMs.filter((v) => v > p50 + 50).length;

  // Group into minute buckets so a single bad stretch cannot hide inside the average.
  const buckets = new Map();
  for (const r of rows) {
    if (r.ms === null || !Number.isFinite(r.ms)) continue;
    const minute = Math.floor((r.ts - startTs) / 60000);
    if (!buckets.has(minute)) buckets.set(minute, []);
    buckets.get(minute).push(r.ms);
  }
  let worstMinute = null;
  for (const [minute, values] of buckets) {
    const avg = values.reduce((a, b) => a + b, 0) / values.length;
    if (!worstMinute || avg > worstMinute.avg) worstMinute = { minute, avg: round(avg), samples: values.length };
  }

  return {
    sent,
    received,
    loss: round(((sent - received) / Math.max(1, sent)) * 100),
    min: sorted.length ? round(sorted[0]) : null,
    avg: okMs.length ? round(okMs.reduce((a, b) => a + b, 0) / okMs.length) : null,
    p50,
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length ? round(sorted[sorted.length - 1]) : null,
    jitter,
    spikes,
    worstMinute,
    minutes: buckets.size,
  };
}

export function summarizeRun(runId) {
  const run = getSoakRun(runId);
  if (!run) return null;
  const rows = getSoakSamples(runId);
  const startTs = Math.min(...rows.map((r) => r.ts), Date.parse(run.startedAt));
  const byTarget = new Map();
  for (const row of rows) {
    if (!byTarget.has(row.target)) byTarget.set(row.target, []);
    byTarget.get(row.target).push(row);
  }
  const targets = (run.config?.targets || []).map((t) => {
    const stats = summarizeTarget(byTarget.get(t.id) || [], startTs);
    return { id: t.id, label: t.label, host: t.host, ...stats };
  });

  const allOk = targets.map((t) => t.avg).filter((v) => v !== null);
  const overall = {
    avg: allOk.length ? round(allOk.reduce((a, b) => a + b, 0) / allOk.length) : null,
    p95: targets.length ? Math.max(...targets.map((t) => t.p95 ?? 0)) : null,
    jitter: (() => {
      const j = targets.map((t) => t.jitter).filter((v) => v !== null);
      return j.length ? round(j.reduce((a, b) => a + b, 0) / j.length) : null;
    })(),
    loss: (() => {
      const sent = targets.reduce((a, t) => a + t.sent, 0);
      const recv = targets.reduce((a, t) => a + t.received, 0);
      return sent ? round(((sent - recv) / sent) * 100) : null;
    })(),
  };

  return {
    runId,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
    seconds: run.seconds,
    label: run.config?.label || null,
    samples: rows.length,
    targets,
    overall,
  };
}

export async function startSoak({ seconds = 600, intervalMs = 500, targets = SOAK_TARGETS, label = null } = {}) {
  if (active) throw new Error("A soak test is already running");
  const duration = Math.min(3600, Math.max(10, Math.floor(seconds)));
  const interval = Math.min(5000, Math.max(200, Math.floor(intervalMs)));

  const resolved = [];
  for (const t of targets) {
    const r = await resolveHost(t.host);
    resolved.push({ id: t.id, label: t.label, host: t.host, port: t.port, ip: r.ip });
  }

  const runId = createSoakRun({
    seconds: duration,
    intervalMs: interval,
    label,
    targets: resolved.map(({ id, label, host, port, ip }) => ({ id, label, host, port, ip })),
  });

  const state = {
    runId,
    startedAt: Date.now(),
    seconds: duration,
    intervalMs: interval,
    cycles: 0,
    expectedCycles: Math.max(1, Math.floor((duration * 1000) / interval)),
    samples: 0,
    running: true,
    stopRequested: false,
    finished: false,
    error: null,
  };
  active = state;
  lastStatus = state;

  (async () => {
    const endAt = Date.now() + duration * 1000;
    try {
      while (Date.now() < endAt && !state.stopRequested) {
        const tick = Date.now();
        for (const t of resolved) {
          const hit = t.ip ? await tcpPing(t.ip, t.port, 1500) : { ms: null, error: "unresolved" };
          insertSoakSample(runId, tick, t.id, hit.ms, hit.ms !== null);
          state.samples += 1;
        }
        state.cycles += 1;
        const wait = interval - (Date.now() - tick);
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }
    } catch (err) {
      state.error = String(err?.message || err);
    } finally {
      state.running = false;
      state.finished = true;
      state.endedAt = Date.now();
      try {
        const summary = summarizeRun(runId);
        finishSoakRun(runId, summary);
        state.summary = summary;
      } catch (err) {
        state.error = state.error || String(err?.message || err);
      }
      active = null;
      lastStatus = state;
    }
  })();

  return {
    runId,
    seconds: duration,
    intervalMs: interval,
    label,
    expectedSamples: state.expectedCycles * resolved.length,
    targets: resolved.map((t) => ({ id: t.id, label: t.label, host: t.host })),
  };
}

export function stopSoak() {
  if (!active) return { stopped: false, reason: "no soak running" };
  active.stopRequested = true;
  return { stopped: true, runId: active.runId };
}

export function soakStatus() {
  const s = active || lastStatus;
  if (!s) return { running: false, last: null };
  return {
    running: Boolean(s.running),
    runId: s.runId,
    seconds: s.seconds,
    elapsed: Math.round((Date.now() - s.startedAt) / 1000),
    cycles: s.cycles,
    expectedCycles: s.expectedCycles,
    samples: s.samples,
    finished: Boolean(s.finished),
    error: s.error || null,
    summary: s.summary || null,
  };
}

/** Human label describing which settings were live, so a later comparison cannot misread a run. */
export function soakLabel(tw) {
  if (!tw) return "settings unknown";
  return `power plan ${tw.planPower === "off" ? "off" : "on"} · NIC ${tw.nicPower} · Nagle ${tw.nagleDisabled ? "disabled" : "on"}`;
}

/** Compare two stored runs target by target (b minus a). */
export function compareSoaks(aId, bId) {
  const a = getSoakRun(aId)?.summary;
  const b = getSoakRun(bId)?.summary;
  if (!a || !b) return null;
  const targets = a.targets.map((ta) => {
    const tb = b.targets.find((t) => t.id === ta.id) || {};
    const d = (x, y) => (x === null || y === null || x === undefined || y === undefined ? null : round(y - x));
    return {
      id: ta.id,
      label: ta.label,
      avg: { a: ta.avg, b: tb.avg, delta: d(ta.avg, tb.avg) },
      p95: { a: ta.p95, b: tb.p95, delta: d(ta.p95, tb.p95) },
      jitter: { a: ta.jitter, b: tb.jitter, delta: d(ta.jitter, tb.jitter) },
      loss: { a: ta.loss, b: tb.loss, delta: d(ta.loss, tb.loss) },
    };
  });
  return { a: { runId: a.runId, startedAt: a.startedAt, seconds: a.seconds }, b: { runId: b.runId, startedAt: b.startedAt, seconds: b.seconds }, targets };
}

export { listSoakRuns, getSoakRun };
