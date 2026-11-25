/**
 * Long-term tracking has to stay honest with little data.
 *
 * Every latency run is already stored, so "is my connection getting worse?" is a question the
 * history can answer - if the answer refuses to be a trend when there is nothing to base one on.
 * These cases pin that:
 *
 *   empty       no stored run: a sentence that says so, no numbers
 *   one         a single measurement is a measurement, not a direction
 *   three       below four, a trend is refused and the count is named
 *   halves      a direction is the later half against the earlier half, not the newest run
 *   silence     a run whose game endpoint never answered is not a sample
 *   jitter      jitter moves with the series and is omitted when no run recorded one
 *
 * Pure: stored run shapes in, points and one sentence out. The page draws the points and prints
 * the sentence; no surface assembles its own version of either.
 */
import assert from "node:assert/strict";

import { probeTrend } from "./trend.mjs";

const run = (id, at, gameAvgMs, gameJitter = null, gameLoss = 0) => ({
  id,
  createdAt: at,
  summary: `avg ${gameAvgMs ?? "?"} ms`,
  data: { summary: { gameAvgMs, gameJitter, gameLoss } },
});
const day = (n) => `2026-11-${String(10 + n).padStart(2, "0")}T09:00:00.000Z`;

console.log("long-term trend");

/* ------------------------------------------------------------------- empty */
{
  const trend = probeTrend([]);
  assert.equal(trend.runs, 0);
  assert.equal(trend.enough, false);
  assert.deepEqual(trend.points, []);
  assert.match(trend.sentence, /No game-server round trip has been stored yet/);
  console.log("  empty        no history says so, without inventing a figure");
}

/* --------------------------------------------------------------------- one */
{
  const trend = probeTrend([run(1, day(0), 24)]);
  assert.equal(trend.runs, 1);
  assert.equal(trend.enough, false);
  assert.equal(trend.medianMs, 24);
  assert.equal(trend.deltaMs, null);
  assert.match(trend.sentence, /1 stored game-server measurement/);
  assert.match(trend.sentence, /only stated from 4 runs/);
  console.log("  one          one run is a measurement, not a direction");
}

/* ------------------------------------------------------------------- three */
{
  const trend = probeTrend([run(3, day(0), 30), run(2, day(-1), 20), run(1, day(-2), 22)]);
  assert.equal(trend.runs, 3);
  assert.equal(trend.enough, false);
  assert.match(trend.sentence, /3 stored game-server measurements/);
  console.log("  three        three runs still refuse a trend");
}

/* ------------------------------------------------------------------ halves */
{
  // Newest first, as the database lists them. The last run alone is fast, but the later half is
  // not: the direction has to come from the halves, so this must not read as an improvement.
  const runs = [
    run(6, day(5), 40),
    run(5, day(4), 20),
    run(4, day(3), 20),
    run(3, day(2), 20),
    run(2, day(1), 20),
    run(1, day(0), 20),
  ];
  const trend = probeTrend(runs);
  assert.equal(trend.enough, true);
  assert.deepEqual(
    trend.points.map((p) => p.id),
    [1, 2, 3, 4, 5, 6],
    "the series is chronological even when the runs arrive newest-first",
  );
  assert.equal(trend.deltaMs, 0, "later half median 20 against earlier half median 20");
  assert.match(trend.sentence, /the same as the earlier half/);
  assert.equal(trend.spanDays, 5);
  assert.match(trend.sentence, /6 runs over 5 days/);

  const worse = probeTrend([
    run(4, day(3), 40),
    run(3, day(2), 38),
    run(2, day(1), 22),
    run(1, day(0), 20),
  ]);
  assert.equal(worse.deltaMs > 0, true);
  assert.match(worse.sentence, /higher than the earlier half/);
  console.log(`  halves       later half against earlier half: ${worse.deltaMs} ms higher, not the newest run`);
}

/* ----------------------------------------------------------------- silence */
{
  // A run where nothing answered has no game figure, so it is not a point in the series - the
  // same rule the probe summary and the benchmark follow.
  const trend = probeTrend([
    run(5, day(2), 26),
    run(4, day(2), null),
    run(3, day(1), 25, 3),
    run(2, day(1), 24, 2),
    run(1, day(0), 23, 2),
  ]);
  assert.equal(trend.runs, 4, "the unanswered run is not counted as a measurement");
  assert.equal(trend.enough, true);
  assert.equal(trend.points.some((p) => p.ms === null), false);
  // Only the runs that recorded jitter count for the jitter figure: the unanswered run is not
  // in the series at all, and a run without a jitter reading contributes nothing to it.
  assert.match(trend.sentence, /Jitter is 1 ms higher/);
  console.log("  silence      a run with no game answer is not a sample");
}

/* ------------------------------------------------------------------ jitter */
{
  const trend = probeTrend([
    run(4, day(3), 30, 6),
    run(3, day(2), 29, 6),
    run(2, day(1), 24, 2),
    run(1, day(0), 23, 2),
  ]);
  assert.equal(trend.jitterDeltaMs, 4);
  assert.match(trend.sentence, /Jitter is 4 ms higher/);

  const noJitter = probeTrend([run(2, day(1), 24), run(1, day(0), 23), run(3, day(2), 25), run(4, day(3), 26)]);
  assert.equal(noJitter.medianJitterMs, null);
  assert.equal(noJitter.jitterDeltaMs, null);
  assert.doesNotMatch(noJitter.sentence, /Jitter is/);
  console.log("  jitter       moves with the series, and is left out when no run recorded one");
}

console.log("\nall long-term trend checks passed");
