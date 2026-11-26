/**
 * UDP response classification, pinned at the edges that used to be blurred.
 *
 * A reply is a datagram from the exact address and port this probe targeted, arriving after the
 * query was handed to the OS, whose payload matches the protocol's answer. Everything else is
 * one of its own outcomes: a wrong-source datagram is `mismatched`, a wrong-payload one is
 * `unexpected`, an ICMP rejection is `closed` (path evidence only), and no datagram is
 * `timeout`. None of the non-reply outcomes contributes a latency sample, a received count or a
 * loss figure.
 */
import assert from "node:assert/strict";
import dgram from "node:dgram";

import { summarizeUdp, udpPing, udpArrival, sameEndpoint, udpErrorOutcome } from "./probe.mjs";

const near = (actual, expected, what) => assert.equal(actual, expected, `${what} (got ${actual})`);

async function serve(handler) {
  const socket = dgram.createSocket("udp4");
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  socket.on("message", (message, from) => handler(message, from, socket));
  return {
    port: socket.address().port,
    close: () => new Promise((resolve) => socket.close(resolve)),
  };
}

console.log("udp classification");

/* --------------------------------------------------------- genuine reply */
{
  const echo = await serve((message, from, socket) => socket.send(message, from.port, from.address));
  try {
    const hit = await udpPing("127.0.0.1", echo.port, { timeoutMs: 800, protocol: "echo" });
    near(hit.outcome, "reply", "the echo server's own bytes are a reply");
    assert.ok(typeof hit.ms === "number" && hit.ms >= 0 && hit.ms < 200, `a reply carries its RTT (got ${hit.ms})`);
    assert.equal(hit.pathMs, null, "a reply is not a path figure");
    near(hit.unexpected, 0, "no unexpected datagrams");
    near(hit.mismatched, 0, "no wrong-source datagrams");
    const row = summarizeUdp({ sent: 1, samples: [hit.ms] });
    near(row.received, 1, "exactly one reply was received");
    near(row.replies, 1, "and counted as a reply");
    near(row.loss, 0, "no loss");
  } finally {
    await echo.close();
  }
}

/* ----------------------------------------------------------------- timeout */
{
  const silent = await serve(() => {});
  try {
    const hit = await udpPing("127.0.0.1", silent.port, { timeoutMs: 250, protocol: "echo" });
    near(hit.outcome, "timeout", "silence is a timeout");
    assert.equal(hit.ms, null, "a timeout has no latency");
    assert.equal(hit.pathMs, null, "and no path figure");
    const row = summarizeUdp({ sent: 1, timeouts: 1 });
    near(row.received, 0, "nothing was received");
    assert.equal(row.avg, null, "no latency is invented");
    assert.equal(row.loss, null, "silence is not packet loss");
    near(row.stages.timeout, 1, "the timeout stage is counted");
  } finally {
    await silent.close();
  }
}

/* --------------------------------------------------------- ICMP rejection */
{
  // The OS reports an ICMP port-unreachable as ECONNREFUSED (Linux) or ECONNRESET (Windows).
  // That is its own outcome, never a reply and never a latency sample.
  near(udpErrorOutcome({ code: "ECONNREFUSED" }), "closed", "ICMP refusal on Linux is closed");
  near(udpErrorOutcome({ code: "ECONNRESET" }), "closed", "ICMP refusal on Windows is closed");
  near(udpErrorOutcome({ code: "EHOSTUNREACH" }), "unreachable", "a routing failure is unreachable, not closed");
  const spare = dgram.createSocket("udp4");
  await new Promise((resolve) => spare.bind(0, "127.0.0.1", resolve));
  const closedPort = spare.address().port;
  await new Promise((resolve) => spare.close(resolve));
  const hit = await udpPing("127.0.0.1", closedPort, { timeoutMs: 400, protocol: "echo" });
  // A loopback closed port may surface the ICMP error as `closed` or, where the stack drops
  // it, wait out the timeout; both are honest and neither may carry a reply latency.
  if (hit.outcome === "closed") {
    assert.equal(hit.ms, null, "an ICMP rejection is never a latency sample");
    assert.ok(typeof hit.pathMs === "number" && hit.pathMs >= 0, "it keeps a separately named path figure");
  } else {
    near(hit.outcome, "timeout", "an ICMP error the stack did not surface is a timeout");
    assert.equal(hit.ms, null, "nothing that is not a reply may carry ms");
    assert.equal(hit.pathMs, null, "and no path figure is invented");
  }
  const row = summarizeUdp({ sent: 1, closed: [hit.pathMs ?? 1] });
  near(row.received, 0, "an ICMP rejection is not received");
  assert.equal(row.avg, null, "and contributes no latency sample");
  assert.equal(row.loss, null, "and no loss arithmetic");
  near(row.stages.closed, 1, "it is counted in its own stage");
}

/* ------------------------------------------ wrong source / wrong payload */
{
  assert.equal(sameEndpoint("127.0.0.1", 27015, { address: "127.0.0.2", port: 27015 }), false, "a different address is not the target");
  assert.equal(sameEndpoint("127.0.0.1", 27015, { address: "127.0.0.1", port: 27016 }), false, "a different port is not the target");
  assert.equal(sameEndpoint("127.0.0.1", 27015, { address: "::ffff:127.0.0.1", port: 27015 }), true, "an IPv4-mapped peer is the same IPv4 target");
  near(udpArrival("127.0.0.1", 27015, { address: "127.0.0.2", port: 27015 }, { armed: true }), "mismatched", "wrong source");
  near(udpArrival("127.0.0.1", 27015, { address: "127.0.0.1", port: 27016 }, { armed: true }), "mismatched", "wrong source port");
  near(udpArrival("127.0.0.1", 27015, { address: "127.0.0.1", port: 27015 }, { armed: false }), "unexpected", "arrived before the send");
  near(udpArrival("127.0.0.1", 27015, { address: "127.0.0.1", port: 27015 }, { armed: true }), "accepted", "target and send both verified");

  const bad = summarizeUdp({
    sent: 3,
    mismatched: 1,
    mismatchedPackets: 2,
    unexpected: 1,
    unexpectedPackets: 3,
    timeouts: 1,
  });
  near(bad.state, "mismatched", "wrong-source traffic has its own state");
  near(bad.received, 0, "it never counts as received");
  near(bad.replies, 0, "nor as a reply");
  assert.equal(bad.avg, null, "nor as latency");
  assert.equal(bad.loss, null, "and without a reply there is no loss arithmetic");
  near(bad.mismatched, 1, "the wrong-source probe is counted");
  near(bad.mismatchedPackets, 2, "the raw wrong-source datagrams are kept apart");
  near(bad.unexpected, 1, "the wrong-payload probe is counted");
  near(bad.unexpectedPackets, 3, "the raw wrong-payload datagrams are kept apart");
  near(
    Object.values(bad.stages).reduce((a, b) => a + b, 0),
    bad.sent,
    "every probe is in exactly one stage",
  );

  const mixed = summarizeUdp({ sent: 4, samples: [12], mismatched: 1, unexpected: 1, timeouts: 1 });
  near(mixed.received, 1, "one genuine reply is the only received sample");
  near(mixed.avg, 12, "its RTT is the only sample averaged");
  near(mixed.stages.mismatched, 1, "the wrong-source stage is kept");
  near(mixed.stages.unexpected, 1, "the wrong-payload stage is kept");
}

console.log("  reply        only the target's matching datagram after our send is timed");
console.log("  timeout      no datagram: no received, latency or loss figure");
console.log("  closed       ICMP rejection: path figure only, never latency");
console.log("  mismatched   wrong address/port: its own outcome, never received");
console.log("  unexpected   wrong payload or pre-send datagram: never a reply");
console.log("\nall UDP classification checks passed");
