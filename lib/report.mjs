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

/**
 * How the TCP handshake figures relate to the ICMP echo cross-check. Both are proxies:
 * games send UDP, and timing that needs the game's own server. Saying so is the honest
 * alternative to presenting either number as "your game ping".
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
    return `TCP handshakes average ${t.tcpMs} ms against ${t.icmpMs} ms for ICMP echo (${signed(t.gapMs)}): that gap is connection setup and queueing on that port, not the path. Games send UDP, which PingLab cannot time without the game's own server, so both figures are proxies.`;
  }
  return `TCP handshakes average ${t.tcpMs} ms and ICMP echo ${t.icmpMs} ms; the two agree, so the handshake is not adding delay. Both are proxies: games send UDP, which needs the game's own server to time.`;
}
