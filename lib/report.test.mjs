/**
 * The shared verdict layer. The web page used to read DNS fields that did not exist
 * (`avg`, `p95`, `total`, `failures`, `winner`) and rendered "—" and "undefined" next to
 * a benchmark that was in fact fine; a winner selector and wording in one module is what
 * stops that drifting again. These are fixed inputs, no network and no Windows.
 */
import assert from "node:assert/strict";

import { RESOLVERS, summarise } from "./dns.mjs";
import { dnsWinner, dnsVerdict, bloatVerdict, bloatMeaning, transportText, udpText, scanFreshnessText } from "./report.mjs";

const ip = (label) => RESOLVERS.find((r) => r.label === label).servers[0];
const flat = (v) => Array.from({ length: 10 }, () => v);
const rows = (byLabel) => {
  const out = [];
  for (const [label, ms] of Object.entries(byLabel)) {
    ms.forEach((value, index) => out.push({ index, server: ip(label), ms: value, ok: true }));
  }
  return out;
};

// 1. A winner is selectable with the servers the row actually measured.
{
  const result = summarise(rows({ Cloudflare: flat(40), Google: flat(50), Quad9: flat(60), OpenDNS: flat(70) }), 10);
  assert.deepEqual(dnsWinner(result), {
    id: "cloudflare",
    label: "Cloudflare",
    servers: ["1.1.1.1", "1.0.0.1"],
    median: 40,
  });
  assert.match(dnsVerdict(result), /^D sets DNS to Cloudflare/);
}

// 2. No winner means nothing is offered to apply, however the result is shaped.
{
  const tie = summarise(rows({ Cloudflare: flat(50), Google: flat(50) }), 10);
  assert.equal(tie.best, null);
  assert.equal(dnsWinner(tie), null);
  assert.match(dnsVerdict(tie), /No clear winner/);

  const empty = summarise([], 10);
  assert.equal(dnsWinner(empty), null);
  assert.match(dnsVerdict(null), /Run the DNS benchmark first/);
}

// 3. Bufferbloat wording names each direction, its grade and loss; a failed direction is
//    named with the reason instead of disappearing.
{
  const result = {
    mode: "both",
    overallGrade: "D",
    download: { direction: "download", grade: "A", deltaMs: 4, loaded: { loss: 0 } },
    upload: { direction: "upload", grade: "D", deltaMs: 120, loaded: { loss: 2 } },
  };
  const text = bloatVerdict(result);
  assert.match(text, /download: grade A, \+4 ms/);
  assert.match(text, /upload: grade D, \+120 ms, 2% of pings lost/);
  assert.match(text, /Poor\./);
  assert.equal(bloatMeaning("F"), "Bad. Your ping explodes under any load — the most common cause of 'random' lag.");

  const half = {
    mode: "both",
    overallGrade: "B",
    download: { direction: "download", grade: "B", deltaMs: 45, loaded: { loss: 0 } },
    upload: { direction: "upload", grade: "n/a", deltaMs: null, error: "not enough upload traffic moved (0.4 Mbps)" },
  };
  const halfText = bloatVerdict(half);
  assert.match(halfText, /download: grade B, \+45 ms/);
  assert.match(halfText, /upload: not measured \(not enough upload traffic/);
  assert.equal(bloatVerdict(null), null);
}

// 4. Transport wording: every branch says what it actually knows.
{
  const gapText = transportText({
    tcpMs: 42,
    icmpMs: 27,
    gapMs: 15,
    targets: 2,
    icmpAnswered: 2,
    tcpUnreachable: 0,
  });
  assert.match(gapText, /TCP handshakes average 42 ms against 27 ms for ICMP echo \(\+15 ms\)/);
  // The sentence used to say UDP could not be timed at all; the probe does run it now.
  assert.doesNotMatch(gapText, /cannot time|needs the game's own server/);
  assert.match(
    transportText({ tcpMs: 42, icmpMs: 41, gapMs: 1, targets: 2, icmpAnswered: 2, tcpUnreachable: 0 }),
    /the two agree/,
  );
  assert.match(
    transportText({ tcpMs: null, icmpMs: 20, gapMs: null, targets: 2, icmpAnswered: 2, tcpUnreachable: 3 }),
    /TCP handshakes failed to every endpoint while ICMP echo answered 2 target\(s\)/,
  );
  assert.match(
    transportText({ tcpMs: 40, icmpMs: 25, gapMs: 15, targets: 2, icmpAnswered: 2, tcpUnreachable: 1 }),
    /1 endpoint\(s\) refused TCP while ICMP echo answered/,
  );
  assert.match(
    transportText({ tcpMs: 40, icmpMs: null, gapMs: null, targets: 2, icmpAnswered: 0, tcpUnreachable: 0 }),
    /ICMP echo did not answer here/,
  );
  assert.equal(transportText(null), null);
}

// 5. UDP wording keeps a service round-trip, a host's "port closed" and silence apart:
//    only the first is a latency figure, and only an answered endpoint can have loss.
{
  assert.match(
    udpText({ targets: 3, answered: 1, closed: 1, silent: 1, serviceMs: 44.2, loss: 25, pathMs: 18 }),
    /1 of 3 game endpoint\(s\) answered the probe — 44\.2 ms average, 25% of those probes lost/,
  );
  assert.match(
    udpText({ targets: 3, answered: 0, closed: 2, silent: 1, serviceMs: null, loss: null, pathMs: 18.4 }),
    /2 of 3 game endpoint\(s\) replied “port closed” after 18\.4 ms/,
  );
  assert.match(
    udpText({ targets: 2, answered: 0, closed: 0, silent: 2, serviceMs: null, loss: null, pathMs: null }),
    /reported as unanswered — not as packet loss/,
  );
  assert.doesNotMatch(
    udpText({ targets: 2, answered: 0, closed: 0, silent: 2, serviceMs: null, loss: null, pathMs: null }),
    /0 ms|100%/,
  );
  assert.equal(udpText(null), null);
}

// 6. The Wi-Fi scan sentence dates a scan the WLAN API confirmed, and without a confirmation
//    it says so instead of implying freshness.
{
  const confirmed = scanFreshnessText({ attempted: true, ok: true, elapsedMs: 412, reason: null });
  assert.match(confirmed, /confirmed a scan finished 412 ms after PingLab asked for one/);
  assert.match(confirmed, /dates the scan, not every network in it/);
  assert.match(
    scanFreshnessText({ attempted: true, ok: true, elapsedMs: 1200, reason: null }),
    /1\.2 s after PingLab asked/,
    "a slow scan is printed in seconds",
  );

  const fallback = scanFreshnessText({
    attempted: true,
    ok: false,
    elapsedMs: null,
    reason: "no scan-complete notification arrived inside the time limit",
  });
  assert.match(fallback, /No scan-complete confirmation \(no scan-complete notification arrived inside the time limit\)/);
  assert.match(fallback, /no fresh-or-cached verdict/i);
  assert.doesNotMatch(fallback, /confirmed a scan finished/i, "a fallback never reads as a confirmation");
  assert.match(
    scanFreshnessText({ attempted: false, ok: false, reason: "no Wi-Fi adapter id was available to scan with" }),
    /no Wi-Fi adapter id/,
  );
  assert.equal(scanFreshnessText(null), null);
}

console.log("\nreport");
console.log("  dns         one winner selector and one verdict sentence for every surface");
console.log("  bloat       each direction named with grade, added ping and loss");
console.log("  transport   TCP versus ICMP says which one is a proxy and which one failed");
console.log("  udp         a service round-trip, a closed port and silence are never conflated");
console.log("  scan        a confirmed scan is dated; without one the sentence claims nothing");
console.log("\nall report checks passed");
