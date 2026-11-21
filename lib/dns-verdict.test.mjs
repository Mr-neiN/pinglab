// Fixed-input checks for the DNS verdict. These drive the real thresholds in dns.mjs —
// nothing here re-implements the rule, so a change to MIN_GAP_PCT / MIN_WIN_RATE or to
// the message text is caught here.
import assert from "node:assert/strict";
import { RESOLVERS, summarise, verdictText, winnerChip } from "./dns.mjs";

const LOOKUPS = 10;
const ip = (label) => RESOLVERS.find((r) => r.label === label).servers[0];

/**
 * rows({ Cloudflare: [ms per lookup], ... }) -> measurement rows in the shape the
 * PowerShell script emits (index, server, ms, ok).
 */
function rows(byLabel) {
  const out = [];
  for (const [label, ms] of Object.entries(byLabel)) {
    ms.forEach((value, index) => out.push({ index, server: ip(label), ms: value, ok: true }));
  }
  return out;
}

const flat = (v, n = LOOKUPS) => Array.from({ length: n }, () => v);

const cases = [];
function check(name, input, expect) {
  const result = summarise(input, LOOKUPS);
  const text = verdictText(result);
  cases.push({ name, result, text, expect });
  return { result, text };
}

// 1. A resolver clearly ahead on both figures.
{
  const { result, text } = check(
    "clear winner (20% gap, 10/10 probes)",
    rows({
      Cloudflare: flat(40),
      Google: flat(50),
      Quad9: flat(55),
      OpenDNS: flat(60),
    }),
    {},
  );
  assert.equal(result.best, "cloudflare", "winner should be Cloudflare");
  assert.equal(result.gapPct, 20, "gap should be 20%");
  assert.equal(result.winsPct, 100, "should win every shared probe");
  assert.equal(text, "D sets DNS to Cloudflare, A restores automatic. DNS affects joins, not in-game latency.");
}

// 2. The shape the live runs produced: everything inside a few percent. OpenDNS median
//    47 (five 40s, five 54s) against Google's flat 50, so it leads by 6% but wins only
//    half the probes.
{
  const { result, text } = check(
    "within noise (6% gap, 50% of probes)",
    rows({
      OpenDNS: [40, 40, 40, 40, 40, 54, 54, 54, 54, 54],
      Cloudflare: flat(51),
      Google: flat(50),
      Quad9: flat(52),
    }),
    {},
  );
  assert.equal(result.best, null, "no winner inside noise");
  assert.equal(result.leader, "OpenDNS");
  assert.equal(result.gapPct, 6, "gap should be 6%");
  assert.equal(result.winsPct, 50, "splitting the probes should read 50%");
  assert.equal(
    text,
    "No clear winner (OpenDNS led on medians by 6% but was quicker on only 50% of probes) - DNS is not a lever here. A restores automatic DNS.",
  );
}

// 3. Boundary: exactly 10% median gap, every probe won -> must be a winner.
{
  const { result, text } = check(
    "boundary: exactly 10% gap, 100% probes",
    rows({ Cloudflare: flat(90), Google: flat(100), Quad9: flat(110), OpenDNS: flat(120) }),
    {},
  );
  assert.equal(result.gapPct, 10);
  assert.equal(result.best, "cloudflare", "10% is enough, inclusive");
  assert.match(text, /^D sets DNS to Cloudflare/);
}

// 4. Boundary: exactly 70% of shared probes won (7 of 10), gap well over 10%.
{
  const ms = [40, 40, 40, 40, 40, 40, 40, 60, 60, 60]; // median 40, faster on 7
  const { result, text } = check(
    "boundary: 20% gap, exactly 7/10 probes",
    rows({ Cloudflare: ms, Google: flat(50), Quad9: flat(55), OpenDNS: flat(60) }),
    {},
  );
  assert.equal(result.gapPct, 20);
  assert.equal(result.winsPct, 70);
  assert.equal(result.best, "cloudflare", "70% is enough, inclusive");
  assert.match(text, /^D sets DNS to Cloudflare/);
}

// 5. One probe short of the win-rate boundary -> no winner, honest figures.
{
  const ms = [40, 40, 40, 40, 40, 40, 60, 60, 60, 60]; // median 40, faster on 6
  const { result, text } = check(
    "just below boundary: 20% gap, 6/10 probes",
    rows({ Cloudflare: ms, Google: flat(50), Quad9: flat(55), OpenDNS: flat(60) }),
    {},
  );
  assert.equal(result.winsPct, 60);
  assert.equal(result.best, null);
  assert.equal(
    text,
    "No clear winner (Cloudflare led on medians by 20% but was quicker on only 60% of probes) - DNS is not a lever here. A restores automatic DNS.",
  );
}

// 6. Exact tie between the top two -> must not claim anyone is ahead by 0%.
{
  const { result, text } = check(
    "exact tie",
    rows({ Cloudflare: flat(50), Google: flat(50), Quad9: flat(60), OpenDNS: flat(70) }),
    {},
  );
  assert.equal(result.gapPct, 0);
  assert.equal(result.best, null);
  assert.equal(
    text,
    "No clear winner (Cloudflare is level with the next resolver on medians) - DNS is not a lever here. A restores automatic DNS.",
  );
  assert.doesNotMatch(text, /by 0%/);
}

// 7. Too few answers to compare anyone.
{
  const few = (v) => [v, v, v]; // 3 of 10 answered, below the 8/10 bar
  const { result, text } = check(
    "unanswered",
    rows({ Cloudflare: few(40), Google: few(50), Quad9: few(55), OpenDNS: few(60) }),
    {},
  );
  assert.equal(result.reason, "unanswered");
  assert.equal(
    text,
    "No clear winner (no resolver answered 8 of 10 lookups) - DNS is not a lever here. A restores automatic DNS.",
  );
}

// 8. Only one resolver answered enough to be compared: nothing to be close to, so the
//    leader stands, and no percentage is invented for it.
{
  const few = (v) => [v, v, v];
  const { result, text } = check(
    "single qualifier",
    rows({ Cloudflare: flat(40), Google: few(50), Quad9: few(55), OpenDNS: few(60) }),
    {},
  );
  assert.equal(result.best, "cloudflare");
  assert.equal(result.gapPct, null, "no runner-up means no gap to report");
  assert.equal(text, "D sets DNS to Cloudflare, A restores automatic. DNS affects joins, not in-game latency.");
}

// 9. The row chip: percentage for a normal win, a plain note when there is no runner-up,
//    and nothing at all on the losing rows.
{
  const withGap = summarise(rows({ Cloudflare: flat(40), Google: flat(50) }), LOOKUPS);
  assert.equal(winnerChip(withGap, "cloudflare"), " ← fastest by 20%");
  assert.equal(winnerChip(withGap, "google"), "");

  const solo = summarise(rows({ Cloudflare: flat(40), Google: [50, 50, 50] }), LOOKUPS);
  assert.equal(winnerChip(solo, "cloudflare"), " ← only resolver with enough answers");
  assert.doesNotMatch(winnerChip(solo, "cloudflare"), /null/);
  console.log("\nrow chip");
  console.log(`  winner      "${winnerChip(withGap, "cloudflare")}"`);
  console.log(`  solo        "${winnerChip(solo, "cloudflare")}"`);
  console.log(`  non-winner  "${winnerChip(withGap, "google")}"`);
}

for (const c of cases) {
  console.log(`\n${c.name}`);
  console.log(`  inputs      best/leader=${c.result.leader ?? "-"} gap=${c.result.gapPct}% wins=${c.result.winsPct}% clear=${c.result.best ?? "no"}`);
  console.log(`  message     ${c.text}`);
}
console.log("\nall DNS verdict checks passed");
