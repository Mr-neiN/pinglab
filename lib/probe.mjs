import net from "node:net";
import dgram from "node:dgram";
import dns from "node:dns/promises";
import { performance } from "node:perf_hooks";
import { randomBytes } from "node:crypto";

import { runPsJson } from "./ps.mjs";
import { DEFAULT_UDP_PROTOCOL, protocolById } from "./udp-proto.mjs";

export const round = (n, d = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** d) / 10 ** d : null);
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      // A TCP connect is already bound to the target by the OS, but the same rule as UDP is
      // applied here: only a connection to the exact address and port counts as a handshake.
      if (!sameEndpoint(ip, port, { address: socket.remoteAddress, port: socket.remotePort })) {
        done(null, "mismatched");
        return;
      }
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
 * What a failed UDP exchange means. Windows reports the ICMP "port unreachable" that answers
 * a datagram sent to a closed port as ECONNRESET (Linux uses ECONNREFUSED): the host
 * answered, so it is neither silence nor loss. Anything else completed no round trip.
 */
export function udpErrorOutcome(err) {
  const code = err?.code;
  if (code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ECONNABORTED") return "closed";
  return "unreachable";
}

/** Strip the IPv4-mapped IPv6 prefix so a dual-stack socket compares equal to its IPv4 peer. */
const bareAddress = (value) => String(value ?? "").trim().replace(/^::ffff:/i, "");

/**
 * Whether a datagram came from the exact endpoint this probe targeted. A connected UDP
 * socket normally lets the OS filter this, but an ICMP error, a proxy or a platform that
 * delivers a stray datagram must never become a timed reply just because its payload matches.
 */
export function sameEndpoint(ip, port, rinfo) {
  if (!rinfo) return false;
  return Number(rinfo.port) === Number(port) && bareAddress(rinfo.address) === bareAddress(ip);
}

/**
 * Classify one arriving datagram before any protocol matcher sees it:
 *   mismatched  it did not come from the exact address and port this probe targeted
 *   unexpected  it arrived before this probe had handed a query to the OS
 *   accepted    it may now be matched against the protocol response
 * A wrong-source or pre-send packet is never allowed to reach a matcher, so a payload that
 * happens to look right cannot turn into a reply.
 */
export function udpArrival(ip, port, rinfo, { armed = true } = {}) {
  if (!sameEndpoint(ip, port, rinfo)) return "mismatched";
  if (!armed) return "unexpected";
  return "accepted";
}

/**
 * One UDP round-trip: the endpoint's own query out, then wait for an answer this probe sent.
 *
 * This is a real measurement only when the service answers the datagram - and only when the
 * answer is the one the query expects. A game service ignores a packet it does not recognise
 * and a firewall may drop UDP, so silence is the normal outcome against a real game port and is
 * reported as unanswered, never as packet loss. A "port closed" answer comes from the host's IP
 * stack rather than the service, so its elapsed time is returned as a path figure that callers
 * must label as such. A datagram that comes back but is not this probe's answer (a keep-alive,
 * another service, someone else's packet) is counted as `unexpected` and never timed.
 */
export function udpPing(ip, port, { timeoutMs = 900, protocol = DEFAULT_UDP_PROTOCOL } = {}) {
  return new Promise((resolve) => {
    const spec = protocolById(protocol) ?? protocolById(DEFAULT_UDP_PROTOCOL);
    // An endpoint that publishes no query is not a silent service: nothing is sent, so there is
    // no exchange to time and no timeout to wait out.
    if (spec.measures === false) {
      resolve({
        ms: null,
        pathMs: null,
        outcome: "no-query",
        protocol: spec.id,
        unexpected: 0,
        mismatched: 0,
        challengeMs: null,
        challenged: false,
      });
      return;
    }
    // A fresh token per probe: the echo protocol answers only the bytes this probe sent, and
    // id Tech 3 echoes the challenge back inside its reply, so a reply can be tied to its query.
    const token = randomBytes(6).toString("hex");
    const payload = spec.build(token);
    const socket = dgram.createSocket(net.isIP(ip) === 6 ? "udp6" : "udp4");
    let lastSentAt = performance.now();
    let settled = false;
    // Only a datagram that arrives after our own send was handed to the OS can belong to this
    // exchange. An unsolicited/stale packet is counted, never timed.
    let armed = false;
    let unexpected = 0;
    let mismatched = 0;
    let challengeMs = null;
    let followUps = 0;
    let lastFollowUp = null;
    const done = (ms, outcome, extra = {}) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close();
      } catch {}
      resolve({
        // `ms` is a service round trip and exists only for a completed reply. A challenge
        // RTT lives in challengeMs, and an ICMP/path answer lives in pathMs: neither may be
        // mistaken for a reply latency by a consumer that reads this field.
        ms: outcome === "reply" && typeof ms === "number" ? round(ms) : null,
        pathMs: outcome === "closed" && typeof extra.pathMs === "number" ? round(extra.pathMs) : null,
        outcome,
        protocol: spec.id,
        unexpected,
        mismatched,
        // The first challenge's round trip, kept even when the follow-up never completed. It
        // dates the service answering, but it is not the answer to the query that was asked.
        challengeMs: typeof challengeMs === "number" ? round(challengeMs) : null,
        challenged: challengeMs !== null,
      });
    };
    const send = (bytes) => {
      armed = false;
      socket.send(bytes, (err) => {
        if (err) done(null, udpErrorOutcome(err));
        else {
          lastSentAt = performance.now();
          armed = true;
        }
      });
    };
    const timer = setTimeout(() => {
      // A challenge is the service answering, but the exchange is not finished: the query it
      // asked for never produced its answer. That is its own stage, not a reply and not
      // silence. The challenge RTT stays available as a separate diagnostic.
      if (challengeMs !== null) done(null, "challenge");
      else if (mismatched) done(null, "mismatched");
      else if (unexpected) done(null, "unexpected");
      else done(null, "timeout");
    }, timeoutMs);
    // A listener stays attached for the lifetime of the socket: closing it does not recall
    // an ICMP error the OS was already delivering, and an unheard 'error' would throw.
    socket.on("error", (err) => {
      const outcome = udpErrorOutcome(err);
      done(null, outcome, { pathMs: performance.now() - lastSentAt });
    });
    socket.on("message", (message, rinfo) => {
      const arrival = udpArrival(ip, port, rinfo, { armed });
      if (arrival === "mismatched") {
        mismatched += 1;
        return;
      }
      // The packet arrived while our query was still being handed to the OS (or before any
      // send): it cannot be the answer to a query this probe had already sent.
      if (arrival === "unexpected") {
        unexpected += 1;
        return;
      }
      // A protocol that asks to be repeated (A2S) gets its second datagram here. The figure is
      // timed from the send that produced the answer, so a challenge handshake is one round
      // trip, not the two it took to complete.
      const followUp = spec.next?.(message, token);
      if (followUp) {
        // The same challenge twice means asking again cannot produce the information block:
        // the service answered the challenge but never completed the query, so this is the
        // challenge stage, with its RTT kept apart from a completed reply.
        if (lastFollowUp && followUp.equals(lastFollowUp)) {
          done(null, "challenge");
          return;
        }
        if (followUps < 2) {
          followUps += 1;
          lastFollowUp = followUp;
          if (challengeMs === null) challengeMs = performance.now() - lastSentAt;
          send(followUp);
          return;
        }
      }
      // Only the protocol's own matcher may end the wait: an unrelated datagram cannot become a
      // latency figure, and the timeout still measures what the service failed to answer.
      if (spec.match(message, token)) done(performance.now() - lastSentAt, "reply");
      else unexpected += 1;
    });
    try {
      socket.connect(port, ip, () => send(payload));
    } catch (err) {
      done(null, udpErrorOutcome(err));
    }
  });
}

/**
 * UDP figures from the probes that actually finished a round trip.
 *
 * Every exchange outcome is counted apart, and the stages add up to the probes sent:
 *   reply      the query's own answer arrived (samples)
 *   challenge  the service asked for a challenge, then never completed the query
 *              (`challengeTimes` keeps those round trips as a diagnostic, not a reply)
 *   timeout    nothing came back
 *   closed     the host's stack answered "port unreachable"
 *   unreachable  a different socket error completed no exchange
 *   mismatched   the only datagrams came from a source other than the target
 *   unexpected   the only datagrams came from the target but were not this probe's answer
 * `samples` are reply round-trips in the order they were measured, so the jitter rule is
 * the same one TCP and ICMP use. `closed` holds the elapsed times of "port closed" answers,
 * which are kept out of every latency and loss figure: they prove the host is reachable, not
 * that the game answered. `mismatched`/`unexpected` count probes whose only traffic was a
 * wrong-source or wrong-payload datagram; `mismatchedPackets`/`unexpectedPackets` keep the raw
 * datagram counts for diagnosis. Neither is ever timed or counted as received.
 *
 * Loss exists only once something answered. A port that stays silent - the usual answer to
 * an unknown UDP packet - is not a 100%-loss line, exactly as a blocked ICMP echo is not.
 */
export function summarizeUdp({
  sent = 0,
  samples = [],
  closed = [],
  challenges = 0,
  challengeTimes = [],
  timeouts = 0,
  unreachable = 0,
  mismatched = 0,
  unexpected = 0,
  mismatchedPackets = 0,
  unexpectedPackets = 0,
  challenged = 0,
} = {}) {
  const measured = samples.filter((n) => typeof n === "number" && Number.isFinite(n));
  const closedTimes = closed.filter((n) => typeof n === "number" && Number.isFinite(n));
  const challengeRtts = challengeTimes.filter((n) => typeof n === "number" && Number.isFinite(n));
  const challengeCount = Math.max(0, Number(challenges) || 0);
  const timeoutCount = Math.max(0, Number(timeouts) || 0);
  const unreachableCount = Math.max(0, Number(unreachable) || 0);
  const mismatchedCount = Math.max(0, Number(mismatched) || 0);
  const unexpectedCount = Math.max(0, Number(unexpected) || 0);
  const total =
    sent ||
    measured.length + challengeCount + closedTimes.length + timeoutCount + unreachableCount + mismatchedCount + unexpectedCount;
  // Loss is a question about probes that could have been answered and were not. Traffic that
  // never was this probe's answer (wrong source, wrong payload), a partial challenge exchange,
  // an ICMP rejection and an unreachable host are excluded from both sides of that ratio;
  // unaccounted probes still count as loss, so an older stored run without per-stage counts keeps
  // its old figure.
  const excluded = challengeCount + closedTimes.length + mismatchedCount + unexpectedCount + unreachableCount;
  const lossBase = Math.max(measured.length + timeoutCount, total - excluded);
  const stats = summarize(measured, Math.max(0, lossBase - measured.length), lossBase);
  const state = measured.length
    ? "answered"
    : challengeCount
      ? "challenge"
      : closedTimes.length
        ? "closed"
        : mismatchedCount
          ? "mismatched"
          : unexpectedCount
            ? "unexpected"
            : unreachableCount
              ? "unreachable"
              : total
                ? "silent"
                : "none";
  return {
    sent: total,
    received: measured.length,
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
    unreachable: unreachableCount,
    mismatched: mismatchedCount,
    unexpected: unexpectedCount,
    mismatchedPackets: Math.max(0, Number(mismatchedPackets) || 0),
    unexpectedPackets: Math.max(0, Number(unexpectedPackets) || 0),
    // How many probes a service answered only as far as the challenge: the follow-up never
    // completed, so none of them is a reply. Their RTTs average into `challengeAvgMs`.
    challenges: challengeCount,
    challengeAvgMs: challengeRtts.length
      ? round(challengeRtts.reduce((a, b) => a + b, 0) / challengeRtts.length)
      : null,
    timeouts: timeoutCount,
    // Every stage, so a surface can show that the counts add up to `sent` instead of folding
    // an incomplete exchange into the reply count.
    stages: {
      reply: measured.length,
      challenge: challengeCount,
      timeout: timeoutCount,
      closed: closedTimes.length,
      unreachable: unreachableCount,
      mismatched: mismatchedCount,
      unexpected: unexpectedCount,
    },
    // How many probes saw a challenge at all, including ones that later completed.
    challenged,
  };
}

// Ten probes, 100 ms apart: enough consecutive samples for the jitter rule to mean something on
// a line that stutters briefly, while a silent service still costs one bounded window instead of
// a soak. A longer characterisation is what the soak and the long-term trend are for.
const UDP_COUNT = 10;
const UDP_TIMEOUT_MS = 900;
// A service that has completed none of its first three probes is not going to complete the
// rest: further datagrams only buy timeouts or repeat challenges. The limit applies only while
// nothing has replied, so a service that replied and then went quiet keeps its full series and
// its loss figure.
const UDP_SILENT_MISSES = 3;
/** The sampling policy, so a surface can say how many probes a figure came from without a copy. */
export const UDP_POLICY = { count: UDP_COUNT, timeoutMs: UDP_TIMEOUT_MS, gapMs: 100 };

/**
 * Up to `count` UDP probes to one endpoint, on the address and port its TCP probe already
 * resolved. A service that completes none of the first three probes is not asked again: silence
 * is not a loss series, and a challenge that never leads to the answer is not one either. Only resolved
 * endpoints are probed (a lookup that failed has no address to send to, so it
 * gets no UDP row), which is also why this carries no DNS figure: it measures none.
 *
 * The query is the endpoint's own: A2S_INFO (including its challenge handshake), Quake 3 info,
 * the Bedrock unconnected ping or the UT2004 info request when it names a game protocol, the
 * controlled echo otherwise (one carrying a per-probe token), so what is timed is a packet that
 * service could actually answer rather than a string nothing speaks. An endpoint that names
 * `none` publishes no query, so it is not probed at all and gets a "no-query" row instead of a
 * timeout that would read like a silent game server.
 */
export async function probeUdp(endpoint, { count = UDP_COUNT, timeoutMs = UDP_TIMEOUT_MS, gap = UDP_POLICY.gapMs } = {}) {
  const spec = protocolById(endpoint.protocol) ?? protocolById(DEFAULT_UDP_PROTOCOL);
  const base = {
    id: endpoint.id,
    label: endpoint.label,
    host: endpoint.host,
    port: endpoint.port ?? 443,
    ip: endpoint.ip ?? null,
    protocol: spec.id,
    protocolLabel: spec.label,
  };
  // A platform service has no query to answer, so this is not a probe that stayed silent. The
  // row exists so every surface can say why no UDP figure was attempted, and it carries no sent
  // count, no timeout and no loss.
  if (spec.measures === false) {
    return {
      ...base,
      sent: 0,
      received: 0,
      replies: 0,
      state: "no-query",
      min: null,
      avg: null,
      max: null,
      p95: null,
      jitter: null,
      loss: null,
      closedCount: 0,
      pathMs: null,
      unreachable: 0,
      challenged: 0,
      challenges: 0,
      challengeAvgMs: null,
      timeouts: 0,
      stages: {
        reply: 0,
        challenge: 0,
        timeout: 0,
        closed: 0,
        unreachable: 0,
        mismatched: 0,
        unexpected: 0,
      },
      mismatched: 0,
      unexpected: 0,
      mismatchedPackets: 0,
      unexpectedPackets: 0,
      samples: [],
    };
  }
  const samples = [];
  const closed = [];
  const challengeTimes = [];
  let sent = 0;
  let challenges = 0;
  let timeouts = 0;
  let unreachable = 0;
  let mismatchedProbes = 0;
  let unexpectedProbes = 0;
  let mismatchedPackets = 0;
  let unexpectedPackets = 0;
  let challenged = 0;
  for (let i = 0; i < count; i++) {
    sent += 1;
    const hit = await udpPing(base.ip, base.port, { timeoutMs, protocol: spec.id });
    unexpectedPackets += hit.unexpected ?? 0;
    mismatchedPackets += hit.mismatched ?? 0;
    if (hit.challengeMs !== null && hit.challengeMs !== undefined) {
      challenged += 1;
      challengeTimes.push(hit.challengeMs);
    }
    if (hit.outcome === "reply") samples.push(hit.ms);
    else if (hit.outcome === "challenge") challenges += 1;
    else if (hit.outcome === "closed") closed.push(hit.pathMs);
    else if (hit.outcome === "timeout") timeouts += 1;
    else if (hit.outcome === "mismatched") mismatchedProbes += 1;
    else if (hit.outcome === "unexpected") unexpectedProbes += 1;
    else unreachable += 1;
    if (!samples.length && timeouts + challenges + mismatchedProbes + unexpectedProbes >= UDP_SILENT_MISSES) break;
    if (i < count - 1) await sleep(gap);
  }
  return {
    ...base,
    ...summarizeUdp({
      sent,
      samples,
      closed,
      challenges,
      challengeTimes,
      timeouts,
      unreachable,
      mismatched: mismatchedProbes,
      unexpected: unexpectedProbes,
      mismatchedPackets,
      unexpectedPackets,
      challenged,
    }),
    // The samples are kept so a benchmark can build the same median and p95 the TCP series uses.
    samples: [...samples],
  };
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

  // UDP is timed only where a service answered the probe. The stages stay apart: a completed
  // reply, a challenge whose follow-up never came (not a reply), a host that said "port
  // closed" (path evidence only), and silence, which is not loss.
  const udpRows = (udp || []).filter((u) => u && typeof u.state === "string");
  // A "no-query" row is not an endpoint that failed to answer: it publishes no datagram a
  // client can send, so it is counted apart and kept out of the answered/closed/silent figures.
  const udpProbed = udpRows.filter((u) => u.state !== "no-query");
  const udpUnqueried = udpRows.length - udpProbed.length;
  const udpAnswered = udpProbed.filter((u) => u.state === "answered");
  const udpChallenge = udpProbed.filter((u) => u.state === "challenge");
  const udpClosed = udpProbed.filter((u) => u.state === "closed");
  const udpMismatched = udpProbed.filter((u) => u.state === "mismatched");
  const udpUnexpected = udpProbed.filter((u) => u.state === "unexpected");
  const udpSummary = udpProbed.length
    ? {
        targets: udpProbed.length,
        answered: udpAnswered.length,
        // A challenge-only endpoint answered the service's first question and never the query
        // that was actually asked, so it is counted here, not as an answered target.
        challenge: udpChallenge.length,
        closed: udpClosed.length,
        // Wrong-source and wrong-payload traffic get their own buckets; only endpoints with no
        // datagram at all are silent. Every bucket adds up to targets.
        mismatched: udpMismatched.length,
        unexpected: udpUnexpected.length,
        silent: udpProbed.filter(
          (u) => !["answered", "challenge", "closed", "mismatched", "unexpected"].includes(u.state),
        ).length,
        unqueried: udpUnqueried,
        serviceMs: avg(udpAnswered, "avg"),
        challengeMs: avg(udpChallenge, "challengeAvgMs"),
        loss: udpAnswered.length ? Math.max(...udpAnswered.map((u) => u.loss ?? 0)) : null,
        pathMs: avg(udpClosed, "pathMs"),
      }
    : udpUnqueried
      ? {
          targets: 0,
          answered: 0,
          challenge: 0,
          closed: 0,
          mismatched: 0,
          unexpected: 0,
          silent: 0,
          unqueried: udpUnqueried,
          serviceMs: null,
          challengeMs: null,
          loss: null,
          pathMs: null,
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
