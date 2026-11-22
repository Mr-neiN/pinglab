import { runPsJson } from "./ps.mjs";

export const RESOLVERS = [
  { id: "cloudflare", label: "Cloudflare", servers: ["1.1.1.1", "1.0.0.1"] },
  { id: "google", label: "Google", servers: ["8.8.8.8", "8.8.4.4"] },
  { id: "quad9", label: "Quad9", servers: ["9.9.9.9", "149.112.112.112"] },
  { id: "opendns", label: "OpenDNS", servers: ["208.67.222.222", "208.67.220.220"] },
];

const DOMAINS = [
  "steamcommunity.com",
  "epicgames.com",
  "riotgames.com",
  "discord.com",
  "battle.net",
  "twitch.tv",
  "youtube.com",
  "google.com",
  "microsoft.com",
  "cloudflare.com",
];

const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);

/** Middle of the sorted times: one slow lookup cannot move it the way it moves an average. */
function median(times) {
  if (!times.length) return null;
  const mid = Math.floor(times.length / 2);
  return times.length % 2 ? times[mid] : (times[mid - 1] + times[mid]) / 2;
}

/** A resolver has to answer most lookups to be compared at all. */
const MIN_ANSWERED = 0.8;
/** A winner needs this much median advantage and has to win most head-to-head probes. */
const MIN_GAP_PCT = 10;
const MIN_WIN_RATE = 0.7;

/**
 * Every probe name is asked of every resolver, back to back. A random name under a real
 * domain can never come from the Windows or resolver cache, and interleaving means a
 * burst of Wi-Fi jitter lands on all four equally instead of making whichever run had a
 * quiet link look fast.
 */
function script(servers, domains) {
  const srv = servers.map((s) => `'${s}'`).join(", ");
  const list = domains.map((d) => `'${d}'`).join(", ");
  return `
$servers = @(${srv})
$bases = @(${list})
function New-Probe([string]$Base) { ([guid]::NewGuid().ToString('N').Substring(0, 10)) + '.' + $Base }
# Warm every server, so the first timed lookup is not a cold root recursion.
foreach ($s in $servers) {
  try { Resolve-DnsName -Name (New-Probe $bases[0]) -Server $s -Type A -DnsOnly -ErrorAction Stop | Out-Null } catch { }
}
$out = for ($i = 0; $i -lt $bases.Count; $i++) {
  foreach ($s in $servers) {
    # A fresh name per server: reusing one name would let the Windows client cache answer
    # the second, third and fourth resolver in a few milliseconds from the first reply.
    $probe = New-Probe $bases[$i]
    $sw = [System.Diagnostics.Stopwatch]::StartNew()
    $ok = $false
    try {
      [void](Resolve-DnsName -Name $probe -Server $s -Type A -DnsOnly -ErrorAction Stop)
      $ok = $true
    } catch {
      # NXDOMAIN arrives as an error here (DNS_ERROR_RCODE_NAME_ERROR), but it is a reply:
      # the resolver answered, which is what we are timing. A timeout is not.
      $id = [string]$_.FullyQualifiedErrorId
      $ok = ($id -match "RCODE") -and ($id -notmatch "TIMEOUT")
    }
    $sw.Stop()
    [pscustomobject]@{ index = $i; server = $s; ms = [math]::Round($sw.Elapsed.TotalMilliseconds, 1); ok = $ok }
  }
}
ConvertTo-Json -InputObject @($out) -Compress -Depth 4`;
}

/**
 * The verdict, computed from raw rows only. Pure on purpose: the thresholds can be
 * exercised with fixed inputs (see dns-verdict.test.mjs) instead of waiting for a live
 * run to happen to produce a winner.
 *
 * A winner needs a median gap of at least MIN_GAP_PCT and must be quicker on at least
 * MIN_WIN_RATE of the probes both it and the runner-up answered. Win counting is integer
 * arithmetic so "exactly 70%" means seven of ten, not a float comparison.
 */
export function summarise(rows, domainCount) {
  const primaries = RESOLVERS.map((r) => r.servers[0]);
  const needed = Math.ceil(domainCount * MIN_ANSWERED);
  const times = new Map(primaries.map((s) => [s, []]));
  const byIndex = new Map(primaries.map((s) => [s, new Map()]));
  for (const row of rows || []) {
    if (!row.ok || typeof row.ms !== "number") continue;
    times.get(row.server)?.push(row.ms);
    byIndex.get(row.server)?.set(row.index, row.ms);
  }

  const resolvers = RESOLVERS.map((r) => {
    const mine = times.get(r.servers[0]) ?? [];
    const sorted = [...mine].sort((a, b) => a - b);
    return {
      id: r.id,
      label: r.label,
      servers: r.servers,
      median: round(median(sorted)),
      worst: sorted.length ? round(sorted[sorted.length - 1]) : null,
      answered: mine.length,
    };
  });

  const ranked = resolvers
    .filter((r) => r.median !== null && r.answered >= needed)
    .sort((a, b) => a.median - b.median);
  const best = ranked[0] ?? null;
  const runnerUp = ranked[1] ?? null;

  // The decision uses the same rounded numbers the message prints, so the two can never
  // disagree: "led by 10%" with a failed win-rate is the only way a percentage appears
  // without a winner, and it is the same 10 the rule just tested.
  let gapPct = null;
  let winsPct = null;
  let clear = false;
  if (best) {
    if (runnerUp === null) {
      clear = true;
    } else {
      gapPct = Math.round((1 - best.median / runnerUp.median) * 100);
      const a = byIndex.get(best.servers[0]) ?? new Map();
      const b = byIndex.get(runnerUp.servers[0]) ?? new Map();
      const both = [...a.keys()].filter((i) => b.has(i));
      const wins = both.filter((i) => a.get(i) < b.get(i)).length;
      winsPct = both.length ? Math.round((wins / both.length) * 100) : 0;
      clear = gapPct >= MIN_GAP_PCT && wins >= Math.ceil(both.length * MIN_WIN_RATE);
    }
  }

  return {
    domains: domainCount,
    resolvers,
    best: clear ? best.id : null,
    bestLabel: clear ? best.label : null,
    leader: best ? best.label : null,
    gapPct,
    winsPct,
    needed,
    reason: clear ? null : best === null ? "unanswered" : "noise",
  };
}

/** Benchmark every resolver, one at a time, then let summarise decide. */
export async function benchmark(domains = DOMAINS) {
  // A deterministic run with one clear winner, so the "write the winner" path can be
  // proven on a network where the real resolvers are within noise. Only reachable when
  // the variable is set; the rows go through the same summarise() as real measurements.
  const stub = process.env.PINGLAB_DNS_STUB;
  if (stub) {
    const winner = RESOLVERS.find((r) => r.id === stub) || RESOLVERS[0];
    const rows = [];
    RESOLVERS.forEach((r, idx) => {
      const base = r.id === winner.id ? 9 : 48 + idx * 4;
      domains.forEach((_, i) => rows.push({ index: i, server: r.servers[0], ms: base + (i % 3), ok: true }));
    });
    return { ...summarise(rows, domains.length), stubbed: true };
  }
  const primaries = RESOLVERS.map((r) => r.servers[0]);
  const { data } = await runPsJson(script(primaries, domains), { timeout: 120000 });
  return summarise(data || [], domains.length);
}

/** Row chip for the winning resolver; empty for every other row. */
export function winnerChip(r, id) {
  if (r.best !== id) return "";
  return r.gapPct === null ? " ← only resolver with enough answers" : ` ← fastest by ${r.gapPct}%`;
}

/**
 * The one line the DNS panel prints. Kept here so the wording is part of the tested
 * verdict rather than being assembled inside the TUI, and so it can never contradict the
 * numbers it was given.
 */
export function verdictText(r) {
  if (r.best) return `D sets DNS to ${r.bestLabel}, A restores automatic. DNS affects joins, not in-game latency.`;
  if (r.reason === "unanswered") {
    return `No clear winner (no resolver answered ${r.needed} of ${r.domains} lookups) - DNS is not a lever here. A restores automatic DNS.`;
  }
  if (r.gapPct === null || r.gapPct <= 0) {
    return `No clear winner (${r.leader} is level with the next resolver on medians) - DNS is not a lever here. A restores automatic DNS.`;
  }
  return `No clear winner (${r.leader} led on medians by ${r.gapPct}% but was quicker on only ${r.winsPct}% of probes) - DNS is not a lever here. A restores automatic DNS.`;
}
