/**
 * Before/after benchmarking: did a setting actually change the connection?
 *
 * A tweak that reads back as applied has proved only that Windows accepted a value. This
 * module answers the other question, and it is built around one rule: a difference is called
 * an improvement only when it is larger than what repeated identical measurements of this line
 * already do on their own.
 *
 * Both phases are measured `repeats` times with the same probe call, the same endpoints and the
 * same sample count. The phase's value for a metric is the median of its repeats, and its
 * spread is the range (max - min) of those repeats. A change is measurable when
 *
 *     |after - before| > max(spread_before, spread_after, floor)
 *
 * taking the wider spread of the two phases and a per-metric floor. The floor keeps a
 * millisecond on a very stable line from being reported as an improvement, and the comparison
 * is strictly greater: a difference exactly at the threshold is still "within noise".
 *
 * Transport: games speak UDP, so when every repeat measured an endpoint over its UDP query
 * (lib/udp-proto.mjs: A2S_INFO, Quake 3 info, or a controlled echo) that series is the one
 * compared, and the sentence names it. Where UDP only answered in some repeats the phase falls
 * back to the TCP handshake and says so in a note, because a figure built from two of three
 * repeats is not the same measurement. The transport travels in the endpoint key, so a baseline
 * measured over UDP cannot be compared against an after-run measured over TCP: those are
 * different measurements and the comparison is refused rather than quietly mixed.
 *
 * Everything below is pure: text and numbers in, verdict out, no probing and no Windows. The
 * server measures; this decides, so the decision can be tested with fixed inputs and every
 * surface reports the same verdict from the same object.
 */
import { DEFAULT_UDP_PROTOCOL, protocolById } from "./udp-proto.mjs";

/**
 * The policy, in one place, so it can be tuned without reading the comparison code.
 *
 * repeats       measured runs per phase; 3 is the smallest count that gives a range to compare
 *               against, and 5 costs five full probes per phase (about a minute on a slow line).
 * minRepeats    below this a phase is not compared at all: a "spread" from two runs is the
 *               difference between two samples, not an estimate of noise.
 * count         TCP handshakes per endpoint per run, the same figure /api/probe uses.
 * floors        the smallest change worth calling a change, per metric, in its own unit. These
 *               are deliberately above what an idle local network jitters by (<1 ms) and below
 *               anything a user would notice or a tweak would claim.
 * maxAgeMs      how long a baseline stays usable. A measurement taken hours later is a
 *               different evening on a different line, not the same condition.
 */
export const BENCH = {
  repeats: 3,
  minRepeats: 3,
  count: 5,
  floors: { latencyMs: 2, p95Ms: 3, jitterMs: 1.5, lossPct: 0.5 },
  maxAgeMs: 30 * 60 * 1000,
};

/** The four figures a comparison reports, in the order the table shows them. */
const METRICS = [
  { key: "latencyMs", label: "Median latency", unit: "ms", floor: "latencyMs" },
  { key: "p95Ms", label: "P95 latency", unit: "ms", floor: "p95Ms" },
  { key: "jitterMs", label: "Jitter", unit: "ms", floor: "jitterMs" },
  { key: "lossPct", label: "Packet loss", unit: "%", floor: "lossPct" },
];

const round = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
const round1 = (value) => round(value, 1);
const round3 = (value) => round(value, 3);

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** `host:port`, so two endpoints on one host stay apart and a name change is visible. */
const endpointKey = (result) => `${result?.host ?? "?"}:${result?.port ?? "?"}`;

/** A key is `host:port|transport`: one endpoint can exist as a handshake and as a UDP query. */
const SEP = "|";
const keyFor = (identity, transport) => `${identity}${SEP}${transport}`;
const identityOf = (key) => key.slice(0, key.indexOf(SEP));
const transportOf = (key) => key.slice(key.indexOf(SEP) + 1);
/** `host:port/udp:a2s` - the endpoint and the transport its figure came from. */
const displayKey = (key) => `${identityOf(key)}/${transportOf(key)}`;

/** How a transport is named in a sentence, so no surface writes its own wording. */
export function transportLabel(transport) {
  if (transport === "tcp") return "TCP handshakes";
  if (typeof transport === "string" && transport.startsWith("udp:")) {
    const spec = protocolById(transport.slice(4));
    return `UDP ${spec ? spec.label : transport.slice(4)}`;
  }
  return "a mix of TCP handshakes and UDP queries";
}

/**
 * Per-endpoint figures for one measured run, from the samples the probe already kept.
 *
 * A game endpoint that produced no sample is simply absent: whether that makes the phase
 * unusable is decided by the phase analysis, not silently averaged away here. A UDP row counts
 * only when its state is "answered" - a closed port and silence are not samples, exactly as in
 * the probe summary.
 */
function runStats(run) {
  const stats = new Map();
  const put = (row, transport) => {
    const samples = (row.samples || []).filter((n) => typeof n === "number" && Number.isFinite(n));
    if (!samples.length) return;
    stats.set(keyFor(endpointKey(row), transport), {
      latencyMs: median(samples),
      p95Ms: typeof row.p95 === "number" ? row.p95 : median(samples),
      jitterMs: typeof row.jitter === "number" ? row.jitter : 0,
      // Loss is the share of probes that never came back; `summarize()`/`summarizeUdp()` know it.
      lossPct: typeof row.loss === "number" ? row.loss : transport === "tcp" ? 100 : 0,
    });
  };
  for (const result of run?.results || []) {
    if (result?.kind === "game") put(result, "tcp");
  }
  for (const row of run?.udp || []) {
    if (row?.state === "answered") put(row, `udp:${row.protocol || DEFAULT_UDP_PROTOCOL}`);
  }
  return stats;
}

/**
 * One phase: its value and its run-to-run spread per metric, or the reason it cannot be used.
 *
 * Endpoints are compared, not pooled: latency on two different game servers are two different
 * paths, so the phase's figure is the median of the endpoints' medians (and the worst endpoint's
 * loss, because a line that drops packets to one server has a problem whatever the others do).
 * The same endpoints must appear in every repeat - a repeat that lost one is a failed
 * measurement, not a thinner comparison.
 *
 * The transport is chosen per endpoint for the whole phase, because a metric has to be measured
 * the same way on both sides of the change. UDP wins when every repeat measured it; otherwise
 * the TCP handshake is used and a note records why, so a partial UDP answer is never presented
 * as a complete one.
 */
export function analysePhase(runs, { minRepeats = BENCH.minRepeats } = {}) {
  const usable = (runs || []).filter(Boolean);
  if (usable.length < minRepeats) {
    return {
      ok: false,
      runs: usable.length,
      reason: `only ${usable.length} usable repeat${usable.length === 1 ? "" : "s"} instead of at least ${minRepeats}`,
    };
  }

  const perRun = usable.map(runStats);
  const identities = [...new Set(perRun.flatMap((stats) => [...stats.keys()].map(identityOf)))].sort();
  if (!identities.length) {
    return { ok: false, runs: usable.length, reason: "no game endpoint returned a sample in any repeat" };
  }

  const chosen = [];
  const notes = [];
  for (const identity of identities) {
    const udpKeys = perRun.map((stats) =>
      [...stats.keys()].filter((key) => identityOf(key) === identity && transportOf(key).startsWith("udp:")),
    );
    // One UDP protocol in every repeat: that series is the game's own transport.
    if (udpKeys.every((keys) => keys.length === 1) && new Set(udpKeys.map((keys) => keys[0])).size === 1) {
      chosen.push(udpKeys[0][0]);
      continue;
    }
    const answered = udpKeys.flat();
    if (answered.length) {
      notes.push(
        `${displayKey(answered[0])} answered in only ${udpKeys.filter((keys) => keys.length).length} of ${perRun.length} repeats, so this phase compared it over TCP`,
      );
    }
    // Present in every repeat, or named as missing below - either way the comparison refuses to
    // build a figure from a phase that did not measure the same thing each time.
    chosen.push(keyFor(identity, "tcp"));
  }

  for (const [index, stats] of perRun.entries()) {
    const missing = chosen.filter((key) => !stats.has(key));
    if (missing.length) {
      return {
        ok: false,
        runs: usable.length,
        reason: `repeat ${index + 1} measured different endpoints (missing ${missing.map(displayKey).join(", ")})`,
      };
    }
  }

  const values = {};
  const spreads = {};
  for (const metric of METRICS) {
    const perEndpoint = chosen.map((key) =>
      perRun.map((stats) => stats.get(key)[metric.key]).filter((n) => typeof n === "number" && Number.isFinite(n)),
    );
    if (perEndpoint.some((series) => series.length !== perRun.length)) {
      return { ok: false, runs: usable.length, reason: `${metric.label.toLowerCase()} is missing from at least one repeat` };
    }
    const endpointValues = perEndpoint.map(median);
    // Worst run-to-run range across the endpoints: the threshold has to hold for all of them.
    spreads[metric.key] = round3(Math.max(...perEndpoint.map((series) => Math.max(...series) - Math.min(...series))));
    values[metric.key] = round1(
      metric.key === "lossPct" ? Math.max(...endpointValues) : median(endpointValues),
    );
  }

  const transports = {};
  for (const key of chosen) {
    const transport = transportOf(key);
    transports[transport] = (transports[transport] ?? 0) + 1;
  }
  const names = Object.keys(transports).sort();
  const transport = names.length === 1 ? names[0] : "mixed";

  return {
    ok: true,
    runs: usable.length,
    endpoints: chosen.map(displayKey),
    transport,
    transportLabel: transportLabel(transport),
    transports,
    notes,
    values,
    spreads,
  };
}

/** The parameters two phases must share. Anything that changes the measurement is in here. */
export function benchParams(endpoints, { repeats = BENCH.repeats, count = BENCH.count } = {}) {
  return {
    repeats,
    count,
    endpoints: (endpoints || []).map((e) => ({
      id: e.id ?? null,
      host: e.host ?? null,
      port: e.port ?? null,
      kind: e.kind ?? "game",
      // The UDP query is part of the measurement: a different protocol is a different probe.
      protocol: e.protocol ?? null,
    })),
  };
}

/** A stable string for "were these measured the same way?", insensitive to list order. */
export function paramsKey(params) {
  const endpoints = (params?.endpoints || [])
    .map((e) => `${e.id ?? ""}|${e.host ?? ""}|${e.port ?? ""}|${e.kind ?? ""}|${e.protocol ?? ""}`)
    .sort();
  return JSON.stringify({
    repeats: params?.repeats ?? BENCH.repeats,
    count: params?.count ?? BENCH.count,
    endpoints,
  });
}

/**
 * Compare the two phases and name every metric.
 *
 * `verdict` is one of:
 *   improved      at least one figure moved beyond noise and none regressed
 *   regressed     at least one figure got worse beyond noise (the reason to roll back)
 *   within-noise  every figure stayed inside the band - the honest answer to "did it help?"
 *   insufficient  there is nothing to compare, and `reason` says why
 *
 * A parameters mismatch is refused (`rejected: true`) rather than compared: a baseline taken
 * against three endpoints and an after-run against two is not a measurement of anything. So is a
 * phase pair that ended up on different transports for the same endpoint, because a handshake
 * and a UDP query are not the same figure.
 */
export function compareBenchmark({ before, after, beforeParams, afterParams, floors = BENCH.floors } = {}) {
  const beforeRuns = Array.isArray(before) ? before : before?.runs;
  const afterRuns = Array.isArray(after) ? after : after?.runs;
  const keyBefore = paramsKey(beforeParams ?? (Array.isArray(before) ? null : before?.params));
  const keyAfter = paramsKey(afterParams ?? (Array.isArray(after) ? null : after?.params));

  if (keyBefore !== keyAfter) {
    return {
      ok: false,
      rejected: true,
      verdict: "insufficient",
      reason: "the two phases were measured with different parameters (endpoints, sample count or repeat count), so they cannot be compared",
      metrics: [],
    };
  }

  const a = analysePhase(beforeRuns);
  const b = analysePhase(afterRuns);
  if (!a.ok || !b.ok) {
    const reasons = [a.ok ? null : `before: ${a.reason}`, b.ok ? null : `after: ${b.reason}`].filter(Boolean);
    return { ok: false, rejected: false, verdict: "insufficient", reason: reasons.join("; "), metrics: [] };
  }
  if (JSON.stringify(a.endpoints) !== JSON.stringify(b.endpoints)) {
    return {
      ok: false,
      rejected: true,
      verdict: "insufficient",
      reason: `the phases measured different endpoints or transports (${a.endpoints.join(", ")} before, ${b.endpoints.join(", ")} after)`,
      metrics: [],
    };
  }

  const metrics = METRICS.map((metric) => {
    const beforeValue = a.values[metric.key];
    const afterValue = b.values[metric.key];
    const floor = typeof floors[metric.floor] === "number" ? floors[metric.floor] : 0;
    const spread = Math.max(a.spreads[metric.key], b.spreads[metric.key]);
    // Strictly greater than the band: equal to it is still what this line does by itself.
    const threshold = round3(Math.max(spread, floor));
    const delta = round3(afterValue - beforeValue);
    const pct = Math.abs(beforeValue) > 0 ? round1((delta / beforeValue) * 100) : null;
    const verdict = Math.abs(delta) <= threshold ? "within-noise" : delta < 0 ? "improved" : "regressed";
    return {
      key: metric.key,
      label: metric.label,
      unit: metric.unit,
      before: round1(beforeValue),
      after: round1(afterValue),
      delta: round1(delta),
      pct,
      floor,
      spread,
      threshold,
      verdict,
    };
  });

  const regressed = metrics.some((m) => m.verdict === "regressed");
  const improved = metrics.some((m) => m.verdict === "improved");
  return {
    ok: true,
    rejected: false,
    verdict: regressed ? "regressed" : improved ? "improved" : "within-noise",
    reason: null,
    repeats: { before: a.runs, after: b.runs },
    endpoints: a.endpoints,
    transport: b.transport,
    transportLabel: b.transportLabel,
    notes: [...a.notes, ...b.notes],
    metrics,
  };
}

const num = (value) => (Number.isInteger(value) ? String(value) : value.toFixed(1));
const signed = (value) => `${value > 0 ? "+" : ""}${num(value)}`;

/**
 * One sentence for the history row and any surface that cannot draw the table. It never states
 * a number as a change when the comparison was refused or had too little data, and it names the
 * transport whenever that is not the TCP handshake, so "latency 30 → 22 ms" cannot be read as a
 * handshake figure when it came from the game query.
 */
export function benchSentence(result, { label = "This setting" } = {}) {
  if (!result) return `${label}: no comparison recorded.`;
  if (result.verdict === "insufficient") {
    return result.rejected
      ? `${label}: not compared - ${result.reason}.`
      : `${label}: not enough data to compare - ${result.reason}.`;
  }
  const over = result.transport && result.transport !== "tcp" ? ` Measured over ${result.transportLabel}.` : "";
  const notable = result.metrics.filter((m) => m.verdict !== "within-noise");
  if (!notable.length) {
    const widest = Math.max(...result.metrics.map((m) => m.threshold));
    return `${label}: no measurable change - every figure stayed inside the ${num(widest)} noise band of repeated runs.${over}`;
  }
  const parts = notable.map(
    (m) =>
      `${m.label.toLowerCase()} ${num(m.before)} → ${num(m.after)} ${m.unit}${m.pct === null ? "" : ` (${signed(m.pct)}%)`}`,
  );
  return `${label}: ${result.verdict === "regressed" ? "got worse" : "improved"} - ${parts.join("; ")}.${over}`;
}

/**
 * A baseline older than the policy allows is not the same condition any more: an evening of
 * congestion can start between the two measurements. Strictly beyond the limit, like the noise
 * band, and a missing timestamp counts as expired - there is no honest "probably recent".
 */
export function baselineExpired(startedAt, now = Date.now(), maxAgeMs = BENCH.maxAgeMs) {
  return !Number.isFinite(startedAt) || now - startedAt > maxAgeMs;
}

/**
 * What a rollback did, in one sentence, including what is still not back the way it was.
 *
 * The page, the GUI and the terminal print this text instead of assembling their own, so
 * "restored" cannot mean three different things. `stillPending` is the count PingLab still has
 * on record as changed: after a successful rollback it is the other settings, and after a
 * failed one it includes this setting.
 */
export function revertSentence({ label = "The setting", restored = false, message = null, stillPending = 0 } = {}) {
  const why = message ? String(message).replace(/\s+/g, " ").trim() : "";
  const base = restored
    ? `${label}: rolled back from its restore point.`
    : `${label}: the rollback did not complete${why ? ` - ${why}` : ""}.`;
  const count = Number.isFinite(stillPending) ? stillPending : 0;
  if (count <= 0) return `${base} Nothing else PingLab changed is still applied.`;
  return `${base} ${count} change${count === 1 ? "" : "s"} PingLab made ${count === 1 ? "is" : "are"} still applied.`;
}

/** The verdict wording every surface uses. */
export const VERDICT_TEXT = {
  improved: "Improved",
  regressed: "Regressed",
  "within-noise": "Within noise",
  insufficient: "Insufficient data",
};
