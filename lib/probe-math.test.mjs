/**
 * Fixed-input checks for the latency math every surface reports.
 *
 * Jitter is the mean absolute difference between *consecutive* round-trips. summarize()
 * used to sort the samples first, which turned jitter into "average gap between sorted
 * neighbours" - a number that shrinks instead of growing when a line starts to stutter,
 * so a bad connection could look calmer than a good one. These cases pin the chronological
 * order (and the loss / percentile figures next to it) so a later refactor cannot quietly
 * reintroduce it.
 */
import assert from "node:assert/strict";

import { summarize, summarizeProbe } from "./probe.mjs";

const near = (actual, expected, label) =>
  assert.equal(actual, expected, `${label}: expected ${expected}, got ${actual}`);

// 1. The regression itself: 10 -> 40 -> 20 in that order. Consecutive differences are
//    30 and 20, so jitter is 25. Sorting first would have produced 15 (10|20|40), i.e.
//    the smoother-sounding figure for the same three probes.
{
  const s = summarize([10, 40, 20]);
  near(s.jitter, 25, "jitter from chronological order");
  assert.notEqual(s.jitter, 15, "sorted-order jitter (15) must not come back");
  near(s.min, 10, "min");
  near(s.avg, 23.3, "avg");
  near(s.max, 40, "max");
  near(s.p95, 40, "p95 for three samples is the max");
  near(s.received, 3, "received");
  near(s.sent, 3, "sent defaults to received when no failures are passed");
  near(s.loss, 0, "loss");
}

// 2. A spike and the return from it are two deviations, not one - and the spike is what
//    jitter has to show. Sorting would report 20 here instead of 40.
{
  const s = summarize([20, 20, 20, 120, 20, 20]);
  near(s.jitter, 40, "spike up and down both count");
  near(s.avg, 36.7, "avg includes the spike");
  near(s.min, 20, "min");
  near(s.max, 120, "max");
}

// 3. Percentiles read the sorted copy, so the order of a shuffled population does not
//    change min/avg/max/p95. Jitter does change, which is the point of case 1.
{
  const ascending = Array.from({ length: 100 }, (_, i) => i + 1);
  const shuffled = [...ascending].reverse();
  const a = summarize(ascending);
  const b = summarize(shuffled);
  near(a.p95, 95, "p95 of 1..100");
  near(a.avg, 50.5, "avg of 1..100");
  near(a.min, 1, "min of 1..100");
  near(a.max, 100, "max of 1..100");
  for (const key of ["min", "avg", "max", "p95", "loss", "received", "sent"]) {
    near(b[key], a[key], `${key} ignores input order`);
  }
  near(a.jitter, 1, "evenly rising samples have 1 ms of jitter");
  near(b.jitter, 1, "evenly falling samples have the same 1 ms");
}

// 4. Small counts: p95 never drops below the maximum, and one sample has no jitter.
{
  const five = summarize([10, 20, 30, 40, 50]);
  near(five.p95, 50, "p95 of five samples");
  const one = summarize([42]);
  near(one.jitter, 0, "a single sample has no jitter");
  near(one.p95, 42, "a single sample is its own p95");
  const flat = summarize([50, 50, 50, 50]);
  near(flat.jitter, 0, "a steady line has zero jitter");
  near(flat.avg, 50, "avg of a steady line");
}

// 5. Loss comes from the failure count against what was actually sent - not from the
//    number of usable samples, which is why the probe passes the planned count in.
{
  const partial = summarize([10, 20, 30], 2, 5);
  near(partial.loss, 40, "2 lost of 5 sent");
  near(partial.received, 3, "received");
  near(partial.sent, 5, "sent honours the planned count");
  near(summarize([10, 20, 30], 2).sent, 5, "sent is derived when no total is passed");
  near(summarize([10, 20, 30], 2).loss, 40, "derived total gives the same loss");

  const dead = summarize([], 5, 5);
  near(dead.loss, 100, "every probe lost is 100% loss");
  near(dead.received, 0, "a dead endpoint received nothing");
  assert.equal(dead.min, null);
  assert.equal(dead.avg, null);
  assert.equal(dead.max, null);
  assert.equal(dead.p95, null, "no percentile is invented without samples");
  assert.equal(dead.jitter, null, "no jitter is invented without samples");
  near(summarize([], 0, 0).loss, 0, "an empty run is 0% loss, not 100%");
}

// 6. Non-numeric entries are not probes: they cannot add a sample or a fake deviation.
{
  const s = summarize([10, null, 20, undefined, NaN, 30], 0, 6);
  near(s.received, 3, "only finite numbers are received");
  near(s.jitter, 10, "gaps are measured between the real samples");
  near(s.loss, 0, "dropped entries are not counted as loss here");
}

// 7. The one summary shape every surface prints: the worst endpoint is chosen on jitter
//    and loss independently, and an unreachable endpoint cannot win either by being null.
{
  const probe = summarizeProbe({
    results: [
      { kind: "game", label: "fast but spiky", avg: 20, jitter: 15, loss: 2 },
      { kind: "game", label: "steady", avg: 30, jitter: 5, loss: 1 },
      { kind: "dns", label: "Cloudflare", avg: 12, jitter: 9, loss: 1 },
      { kind: "game", label: "down", avg: null, jitter: null, loss: 100 },
    ],
    icmp: [
      { host: "1.1.1.1", loss: 25, received: 3, sent: 4, avg: 30, jitter: 4 },
      { host: "8.8.8.8", loss: 0, received: 4, sent: 4, avg: 18, jitter: 2 },
    ],
  });
  near(probe.endpoints, 4, "endpoints counted");
  near(probe.reachable, 3, "unreachable endpoint excluded from reachable");
  near(probe.gameAvgMs, 25, "game average across reachable game endpoints");
  near(probe.gameJitter, 10, "game jitter averaged");
  near(probe.gameLoss, 1.5, "game loss averaged over reachable games only (2% and 1%)");
  assert.deepEqual(probe.worstLoss, { label: "down", loss: 100 });
  assert.deepEqual(probe.worstJitter, { label: "fast but spiky", jitter: 15 });
  near(probe.icmpLoss, 25, "worst ICMP loss");
  near(probe.icmpAvgMs, 24, "ICMP average surfaced, not just its loss");
  near(probe.icmpJitter, 3, "ICMP jitter averaged");
  near(probe.icmpAnswered, 2, "two ICMP targets answered");
  assert.equal(probe.transport.tcpMs, 20.7, "TCP average from the reachable endpoints");
  assert.equal(probe.transport.icmpMs, 24, "ICMP average in the transport cross-check");
  assert.equal(probe.transport.gapMs, -3.3, "TCP minus ICMP, in the direction printed");
  assert.equal(probe.transport.tcpUnreachable, 1, "the dead endpoint is counted");
  assert.equal(summarizeProbe({ results: [] }).icmpLoss, null);

  const noIcmp = summarizeProbe({ results: [{ kind: "game", label: "ok", avg: 30, jitter: 1, loss: 0 }], icmp: [] });
  assert.equal(noIcmp.transport, null, "no ICMP cross-check means no transport claim");
}

// 8. ICMP that never answers is usually blocked, not a 100%-loss line: it must not be
//    reported as packet loss, and the transport object has to say nobody answered.
{
  const blocked = summarizeProbe({
    results: [{ kind: "game", label: "down", avg: null, jitter: null, loss: 100 }],
    icmp: [{ host: "1.1.1.1", avg: null, jitter: null, loss: 100, received: 0, sent: 4 }],
  });
  assert.equal(blocked.icmpLoss, null, "a blocked ICMP echo is not 100% packet loss");
  assert.equal(blocked.icmpBlocked, true, "blocked is a separate fact");
  assert.equal(blocked.transport.icmpAnswered, 0);
  assert.equal(blocked.transport.tcpMs, null);
  assert.equal(blocked.transport.icmpMs, null);
  assert.equal(blocked.transport.gapMs, null);

  // One target answering and one blocked is partial loss, not a block.
  const partial = summarizeProbe({
    results: [{ kind: "game", label: "ok", avg: 30, jitter: 1, loss: 0 }],
    icmp: [
      { host: "1.1.1.1", avg: 25, jitter: 1, loss: 50, received: 2, sent: 4 },
      { host: "8.8.8.8", avg: null, jitter: null, loss: 100, received: 0, sent: 4 },
    ],
  });
  assert.equal(partial.icmpBlocked, false);
  assert.equal(partial.icmpLoss, 100, "the worst row still reports its real loss");
}

const raw = [18, 22, 19, 60, 21, 20];
const demo = summarize(raw, 1, 7);
const sortedDemo = summarize([...raw].sort((a, b) => a - b), 1, 7);
console.log("\nprobe math");
console.log(`  samples     ${raw.join(", ")} (1 of 7 lost)`);
console.log(`  min/avg/max ${demo.min} / ${demo.avg} / ${demo.max} ms`);
console.log(`  p95         ${demo.p95} ms`);
console.log(`  jitter      ${demo.jitter} ms (chronological; sorting would report ${sortedDemo.jitter})`);
console.log(`  loss        ${demo.loss}%`);
console.log("\nall probe math checks passed");
