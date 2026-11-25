/**
 * Long-term latency and jitter: what the stored probe runs say over days, not seconds.
 *
 * Every completed latency run is already kept in `runs` with its summary, so the history a user
 * needs for "is this getting worse?" exists; it just was never read back as a series. This module
 * turns those runs into one honest sentence and a small series, and it refuses to invent a trend
 * from too little data:
 *
 *   - only runs with a game-server figure (an answered UDP query) are used, because silence is
 *     not a sample - the same rule every other surface follows;
 *   - a trend needs at least four runs; with fewer the answer says how many there are instead of
 *     comparing two evenings as if they were a trajectory;
 *   - the comparison is between the earlier and later halves of the stored runs, so a single slow
 *     or fast run cannot flip the direction, and the direction is only stated in whole words with
 *     the medians it came from.
 *
 * Pure: stored runs in, points and a sentence out. The server calls it with `listRuns("probe")`,
 * which is newest first; this module sorts chronologically itself.
 */

const round1 = (value) => Math.round(value * 10) / 10;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const finite = (value) => typeof value === "number" && Number.isFinite(value);

/** The game-server figure of one stored probe run, or null when it has none to offer. */
function pointOf(run) {
  const summary = run?.data?.summary;
  if (!summary || !finite(summary.gameAvgMs)) return null;
  return {
    id: run.id ?? null,
    at: run.createdAt ?? null,
    ms: round1(summary.gameAvgMs),
    jitter: finite(summary.gameJitter) ? round1(summary.gameJitter) : null,
    loss: finite(summary.gameLoss) ? round1(summary.gameLoss) : null,
    udpMs: finite(summary.udp?.serviceMs) ? round1(summary.udp.serviceMs) : null,
  };
}

/**
 * The series and its sentence. `runs` may arrive newest-first (how the database lists them); the
 * points are always returned oldest-first, because a series read right to left is a different
 * claim.
 */
export function probeTrend(runs, { minRuns = 4 } = {}) {
  const points = (runs || [])
    .map(pointOf)
    .filter(Boolean)
    .sort((a, b) => String(a.at || "").localeCompare(String(b.at || "")) || (a.id ?? 0) - (b.id ?? 0));

  if (!points.length) {
    return {
      points: [],
      runs: 0,
      enough: false,
      medianMs: null,
      deltaMs: null,
      jitterDeltaMs: null,
      sentence:
        "No game-server round trip has been stored yet. Each latency test adds one, and this line becomes a trend once there are a few.",
    };
  }

  const medianMs = round1(median(points.map((p) => p.ms)));
  const jitterValues = points.map((p) => p.jitter).filter(finite);
  const medianJitter = jitterValues.length ? round1(median(jitterValues)) : null;
  const first = points[0];
  const last = points[points.length - 1];

  if (points.length < minRuns) {
    return {
      points,
      runs: points.length,
      enough: false,
      medianMs,
      medianJitterMs: medianJitter,
      deltaMs: null,
      jitterDeltaMs: null,
      sentence: `${points.length} stored game-server measurement${points.length === 1 ? "" : "s"} so far (median ${medianMs} ms). A trend is only stated from ${minRuns} runs on, so one evening cannot be read as a direction.`,
    };
  }

  // Halves, chronologically: a direction has to survive the middle of the series.
  const half = Math.floor(points.length / 2);
  const earlier = points.slice(0, half);
  const later = points.slice(points.length - half);
  const deltaMs = round1(median(later.map((p) => p.ms)) - median(earlier.map((p) => p.ms)));
  const earlierJitter = earlier.map((p) => p.jitter).filter(finite);
  const laterJitter = later.map((p) => p.jitter).filter(finite);
  const jitterDeltaMs =
    earlierJitter.length && laterJitter.length ? round1(median(laterJitter) - median(earlierJitter)) : null;

  const spanDays = spanInDays(first.at, last.at);
  const window = spanDays === null ? `${points.length} runs` : `${points.length} runs over ${spanDays} day${spanDays === 1 ? "" : "s"}`;
  const movement =
    deltaMs === 0
      ? "the same as the earlier half"
      : `${Math.abs(deltaMs)} ms ${deltaMs < 0 ? "lower" : "higher"} than the earlier half`;
  const jitter =
    jitterDeltaMs === null
      ? ""
      : ` Jitter is ${jitterDeltaMs === 0 ? "unchanged" : `${Math.abs(jitterDeltaMs)} ms ${jitterDeltaMs < 0 ? "lower" : "higher"}`} against that half.`;

  return {
    points,
    runs: points.length,
    enough: true,
    firstAt: first.at,
    lastAt: last.at,
    spanDays,
    medianMs,
    medianJitterMs: medianJitter,
    bestMs: round1(Math.min(...points.map((p) => p.ms))),
    worstMs: round1(Math.max(...points.map((p) => p.ms))),
    deltaMs,
    jitterDeltaMs,
    sentence: `Long-term (${window}): game-server RTT median ${medianMs} ms, ${movement}, range ${round1(
      Math.min(...points.map((p) => p.ms)),
    )}-${round1(Math.max(...points.map((p) => p.ms)))} ms.${jitter}`,
  };
}

/** Whole days between the first and last run, or null when a timestamp cannot be read. */
function spanInDays(firstAt, lastAt) {
  const a = Date.parse(firstAt || "");
  const b = Date.parse(lastAt || "");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}
