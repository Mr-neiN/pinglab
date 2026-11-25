/**
 * Wording that more than one surface prints.
 *
 * The terminal, the desktop GUI and the web page each draw the same measurements. Every
 * sentence that can be shared lives here, computed from the measured object only: a
 * selector or threshold can then change once instead of three times, and the surfaces
 * cannot disagree about what a result means. Pure, so the text is testable with fixed
 * inputs (see report.test.mjs).
 */
import { verdictText } from "./dns.mjs";

/** The resolver a result may offer to apply, or null when the verdict found no winner. */
export function dnsWinner(result) {
  if (!result?.best) return null;
  const row = (result.resolvers || []).find((r) => r.id === result.best);
  if (!row) return null;
  return { id: row.id, label: row.label, servers: row.servers, median: row.median };
}

/** One sentence for the DNS panel; the same string on every surface. */
export function dnsVerdict(result) {
  if (!result) return "Run the DNS benchmark first; it changes nothing on its own.";
  return verdictText(result);
}

export const BLOAT_MEANING = {
  A: "Excellent. Gaming stays smooth even while the line is busy.",
  B: "Good. Barely noticeable while something else is downloading or uploading.",
  C: "Noticeable. Your game will feel worse when the connection is busy.",
  D: "Poor. Downloads, streams or uploads will visibly spike your ping.",
  F: "Bad. Your ping explodes under any load — the most common cause of 'random' lag.",
};

export function bloatMeaning(grade) {
  return BLOAT_MEANING[grade] || null;
}

const signed = (ms) => `${ms >= 0 ? "+" : ""}${ms} ms`;

/**
 * What a bufferbloat result means, direction by direction. A failed direction is named
 * with its reason instead of being left out, and a busy line that drops packets says so:
 * a good grade must never hide loss.
 */
export function bloatVerdict(result) {
  if (!result) return null;
  const parts = [];
  for (const [name, phase] of [
    ["download", result.download],
    ["upload", result.upload],
  ]) {
    if (!phase) continue;
    if (phase.grade === "n/a" || phase.deltaMs === null) {
      parts.push(`${name}: not measured (${phase.error || "no latency samples under load"})`);
      continue;
    }
    const loss = Number(phase.loaded?.loss) > 0 ? `, ${phase.loaded.loss}% of pings lost` : "";
    parts.push(`${name}: grade ${phase.grade}, ${signed(phase.deltaMs)}${loss}`);
  }
  if (!parts.length && result.grade && result.grade !== "n/a") {
    const loss = Number(result.loaded?.loss) > 0 ? `, ${result.loaded.loss}% of pings lost` : "";
    parts.push(`grade ${result.grade}, ${signed(result.deltaMs ?? 0)}${loss}`);
  }
  const overall = result.overallGrade || result.grade;
  if (!parts.length) return result.error || null;
  const meaning = bloatMeaning(overall);
  return `${parts.join(" · ")}${meaning ? ` — ${meaning}` : ""}`;
}

const duration = (ms) => (ms >= 1000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms)} ms`);

/**
 * The one sentence that says whether the Wi-Fi scan was confirmed, and what that means.
 *
 * A completed scan is a real measurement - WLAN AutoConfig said a scan finished - so it can be
 * dated. It is still not a claim that each visible network is live, so the sentence says what
 * the time belongs to. Without a confirmation this falls back to the honest sentence the scan
 * used before the shim existed: it is the list netsh returned, and no fresh-or-cached verdict
 * is claimed.
 */
export function scanFreshnessText(freshness) {
  if (!freshness) return null;
  if (freshness.ok && Number.isFinite(freshness.elapsedMs)) {
    return `Windows confirmed a scan finished ${duration(freshness.elapsedMs)} after PingLab asked for one, and this list was read straight after. That dates the scan, not every network in it.`;
  }
  const why = freshness.reason || "no scan-complete notification arrived";
  return `No scan-complete confirmation (${why}), so this list is only what netsh returned — no fresh-or-cached verdict is claimed.`;
}

/**
 * What the UDP probes established, kept apart from what they did not.
 *
 * UDP has no handshake, so a game service that does not recognise the probe stays silent
 * and nothing can be timed. That silence is not packet loss, and a "port closed" answer
 * from the host's stack is not the game answering either: it dates the network path, not
 * the service. Each of the three outcomes is named instead of being printed as a figure
 * that would read like a game ping.
 */
export function udpText(u) {
  if (!u) return null;
  const unqueried = u.unqueried
    ? ` ${u.unqueried} game endpoint(s) publish no query PingLab can send, so only their TCP handshake is measured.`
    : "";
  if (!u.targets) {
    if (u.unqueried) {
      return `UDP: ${u.unqueried} game endpoint(s) publish no query PingLab can send, so only their TCP handshake is measured — a UDP figure exists only where the service answers its own query.`;
    }
    return null;
  }
  const targets = `${u.targets} game endpoint(s)`;
  if (u.answered) {
    const loss = Number.isFinite(u.loss) ? `, ${u.loss}% of those probes lost` : "";
    return `UDP: ${u.answered} of ${targets} answered the probe — ${u.serviceMs} ms average${loss}. That is a real UDP round-trip, but only a service that answers an unknown packet can be timed.${unqueried}`;
  }
  if (u.closed) {
    const path = Number.isFinite(u.pathMs) ? ` after ${u.pathMs} ms` : "";
    return `UDP: no game service answered; ${u.closed} of ${targets} replied “port closed”${path}. That figure times the network path to the host, not the game, and unanswered probes are not counted as packet loss.${unqueried}`;
  }
  return `UDP: none of ${targets} answered. A game service ignores packets it does not recognise and a firewall may drop UDP, so this is reported as unanswered — not as packet loss.${unqueried}`;
}

/**
 * What a UDP figure is, and is not.
 *
 * A query round-trip is the service's own answer over the transport a game uses, but it is not
 * in-game ping: it is not the match server a round was played on, and it is not the packets a
 * match sends. The probe count is part of the sentence (from lib/probe.mjs's policy) because ten
 * consecutive probes can show jitter now without characterising a line over an evening.
 */
export function udpCaveatText(policy = {}) {
  const count = Number.isFinite(policy.count) ? policy.count : null;
  const sampling = count
    ? `Each endpoint gets up to ${count} probes, enough to see jitter now but not to characterise a line over an evening — the soak and the long-term trend cover longer windows.`
    : "The probes are a short burst, enough to see jitter now but not to characterise a line over an evening — the soak and the long-term trend cover longer windows.";
  return `A UDP figure is the round trip of the query this service answered. It is not in-game ping, not the match server, and not the packets a match sends. ${sampling}`;
}

/**
 * How the TCP handshake figures relate to the ICMP echo cross-check. Both are proxies;
 * the UDP probes are the game-transport check, and they only produce a figure where the
 * service answered. Saying so is the honest alternative to presenting any of them as
 * "your game ping".
 */
export function transportText(t) {
  if (!t) return null;
  if (t.icmpAnswered === 0) {
    return "ICMP echo did not answer here, so the TCP handshake figures stand alone; many hosts and networks block ICMP.";
  }
  if (t.tcpMs === null) {
    return `TCP handshakes failed to every endpoint while ICMP echo answered ${t.icmpAnswered} target(s): the port is blocked or the host refuses connections, so this is not a dead network.`;
  }
  if (t.tcpUnreachable > 0) {
    return `${t.tcpUnreachable} endpoint(s) refused TCP while ICMP echo answered: the path is fine, the port is not. TCP figures cover the endpoints that answered.`;
  }
  if (t.icmpMs === null) return null;
  if (Math.abs(t.gapMs) >= 15) {
    return `TCP handshakes average ${t.tcpMs} ms against ${t.icmpMs} ms for ICMP echo (${signed(t.gapMs)}): that gap is connection setup and queueing on that port, not the path. The UDP probes are the game-transport check, and only report a figure where the service answers.`;
  }
  return `TCP handshakes average ${t.tcpMs} ms and ICMP echo ${t.icmpMs} ms; the two agree, so the handshake is not adding delay. The UDP probes travel the game transport itself and report a figure only where the service answers.`;
}
