/**
 * Fixed-input checks for the latency math every surface reports.
 *
 * Jitter is the mean absolute difference between *consecutive* round-trips. summarize()
 * used to sort the samples first, which turned jitter into "average gap between sorted
 * neighbours" - a number that shrinks instead of growing when a line starts to stutter,
 * so a bad connection could look calmer than a good one. These cases pin the chronological
 * order (and the loss / percentile figures next to it) so a later refactor cannot quietly
 * reintroduce it.
 *
 * The UDP cases below pin the same rule for the transport games actually use: a latency or
 * loss figure exists only when the service answered the probe. Silence and a "port closed"
 * answer from the host are not loss, and only the answered endpoints may feed a service
 * average.
 */
import assert from "node:assert/strict";
import dgram from "node:dgram";

import { summarize, summarizeProbe, summarizeUdp, probeUdp } from "./probe.mjs";
import { protocolById, udpProtocol } from "./udp-proto.mjs";

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

// 9. UDP latency and loss mean what they mean for TCP - but only over probes that finished
//    a round trip. Silence and a host's "port closed" answer cannot become either figure.
{
  const answered = summarizeUdp({ sent: 5, samples: [10, 40, 20] });
  near(answered.state, "answered", "a reply makes the endpoint answered");
  near(answered.jitter, 25, "UDP jitter keeps the chronological order");
  near(answered.loss, 40, "two lost of five sent, once the service answered");
  near(answered.replies, 3, "replies");
  near(answered.sent, 5, "sent");
  near(answered.p95, 40, "p95");
  near(answered.min, 10, "min");
  near(answered.max, 40, "max");
  assert.equal(answered.pathMs, null, "an answered endpoint has no separate path figure");

  const closed = summarizeUdp({ sent: 4, closed: [12, 14.5] });
  near(closed.state, "closed", "a port-closed answer is its own state");
  assert.equal(closed.avg, null, "a closed port has no service latency");
  assert.equal(closed.loss, null, "a closed port is not 100% packet loss");
  near(closed.closedCount, 2, "closed answers counted");
  near(closed.pathMs, 13.3, "closed answers average into a path figure");

  const silent = summarizeUdp({ sent: 4 });
  near(silent.state, "silent", "silence is reported as silence");
  assert.equal(silent.avg, null);
  assert.equal(silent.loss, null, "silence is not packet loss");
  assert.equal(silent.jitter, null, "no jitter is invented for silence");
  assert.equal(silent.pathMs, null);

  const unreachable = summarizeUdp({ sent: 3, unreachable: 3 });
  near(unreachable.state, "unreachable", "a datagram that never completed is its own state");
  assert.equal(unreachable.loss, null);

  const mixed = summarizeUdp({ sent: 4, samples: [20], closed: [30] });
  near(mixed.state, "answered", "one reply outweighs closed answers");
  near(mixed.loss, 75, "loss is counted against everything sent");
  near(mixed.pathMs, 30, "the closed answer still has a path figure");

  near(summarizeUdp({}).state, "none", "no probes, no claim");
}

// 9b. The four exchange stages are counted apart, and every count adds up to the probes sent.
//     A challenge is an answer from the service, but not the answer to the query.
{
  const reply = summarizeUdp({ sent: 2, samples: [10, 20] });
  near(reply.state, "answered", "a completed reply is the answered stage");
  near(reply.stages.reply, 2, "both probes completed");
  near(reply.stages.challenge, 0, "no challenge was folded into the replies");

  const challenge = summarizeUdp({ sent: 2, challenges: 2, challengeTimes: [30, 50] });
  near(challenge.state, "challenge", "a challenge-only endpoint has its own state");
  near(challenge.replies, 0, "a challenge is not a reply");
  near(challenge.challenges, 2, "both challenges counted");
  near(challenge.challengeAvgMs, 40, "the challenge RTT stays a separate diagnostic");
  assert.equal(challenge.avg, null, "no service latency is invented from a partial exchange");
  assert.equal(challenge.loss, null, "a partial exchange is not packet loss");
  near(challenge.stages.challenge, 2, "stage counter");

  const timeout = summarizeUdp({ sent: 3, timeouts: 3 });
  near(timeout.state, "silent", "silence is still silence");
  near(timeout.stages.timeout, 3, "timeouts counted");
  assert.equal(timeout.challengeAvgMs, null, "no challenge RTT is invented");

  const closed = summarizeUdp({ sent: 2, closed: [4, 6] });
  near(closed.state, "closed", "a closed port is its own stage");
  near(closed.stages.closed, 2, "closed answers counted");

  const mixed = summarizeUdp({
    sent: 6,
    samples: [10, 20],
    challenges: 1,
    challengeTimes: [30],
    closed: [5],
    timeouts: 1,
    unreachable: 1,
  });
  near(mixed.state, "answered", "one completed reply makes the endpoint answered");
  near(mixed.replies, 2, "completed replies");
  near(mixed.challenges, 1, "challenge-only probes");
  near(mixed.timeouts, 1, "timeouts");
  near(mixed.closedCount, 1, "closed probes");
  near(mixed.unreachable, 1, "other socket failures");
  near(mixed.challengeAvgMs, 30, "challenge RTT averaged separately");
  assert.equal(
    Object.values(mixed.stages).reduce((a, b) => a + b, 0),
    mixed.sent,
    "the stage counts add up to the probes sent",
  );
  near(mixed.loss, 66.7, "loss is counted against everything sent");
}

// 10. The summary keeps the three UDP outcomes apart, so no surface can average a closed
//     port or silence into a service figure.
{
  const probe = summarizeProbe({
    results: [{ kind: "game", label: "ok", avg: 30, jitter: 2, loss: 0 }],
    icmp: [],
    udp: [
      { label: "a", state: "answered", avg: 40, jitter: 1, loss: 0 },
      { label: "b", state: "answered", avg: 60, jitter: 2, loss: 20 },
      { label: "c", state: "closed", pathMs: 25 },
      { label: "d", state: "silent" },
      { label: "e", state: "challenge", challengeAvgMs: 12.5 },
    ],
  });
  near(probe.udp.targets, 5, "UDP targets");
  near(probe.udp.answered, 2, "answered endpoints");
  near(probe.udp.challenge, 1, "challenge-only endpoints are not answered");
  near(probe.udp.closed, 1, "closed ports");
  near(probe.udp.silent, 1, "silent endpoints");
  near(probe.udp.serviceMs, 50, "service latency averages answered endpoints only");
  near(probe.udp.challengeMs, 12.5, "the challenge RTT is reported separately");
  near(probe.udp.loss, 20, "worst measured UDP loss");
  near(probe.udp.pathMs, 25, "path figure comes from closed ports only");
  near(
    probe.udp.answered + probe.udp.challenge + probe.udp.closed + probe.udp.silent,
    probe.udp.targets,
    "the endpoint stage counts add up to the targets",
  );
  assert.equal(summarizeProbe({ results: [] }).udp, null, "no UDP probes means no UDP claim");
}

// 11. The real socket path: a loopback echo is timed, and a port nobody listens on is
//     never turned into a latency or a loss figure.
{
  let echoAvg = null;
  const echo = dgram.createSocket("udp4");
  await new Promise((r) => echo.bind(0, "127.0.0.1", r));
  echo.on("message", (msg, from) => echo.send(msg, from.port, from.address));
  const port = echo.address().port;
  try {
    const answered = await probeUdp(
      { id: "echo", label: "loopback echo", host: "127.0.0.1", port, ip: "127.0.0.1" },
      { count: 3, timeoutMs: 800, gap: 20 },
    );
    near(answered.state, "answered", "a real UDP echo is answered");
    near(answered.replies, 3, "every loopback probe answered");
    near(answered.loss, 0, "loopback loss");
    near(answered.sent, 3, "loopback sent");
    assert.ok(
      answered.avg !== null && answered.avg >= 0 && answered.avg < 100,
      `loopback average should be small, got ${answered.avg}`,
    );
    echoAvg = answered.avg;
  } finally {
    echo.close();
  }

  const spare = dgram.createSocket("udp4");
  await new Promise((r) => spare.bind(0, "127.0.0.1", r));
  const deadPort = spare.address().port;
  await new Promise((r) => spare.close(r));
  const dead = await probeUdp(
    { id: "dead", label: "closed loopback port", host: "127.0.0.1", port: deadPort, ip: "127.0.0.1" },
    { count: 2, timeoutMs: 500, gap: 20 },
  );
  assert.notEqual(dead.state, "answered", `a closed port must not look answered (got ${dead.state})`);
  assert.equal(dead.avg, null, "no service latency is invented for a closed port");
  assert.equal(dead.loss, null, "a closed port is never reported as 100% loss");
  console.log(`  udp live    echo answered in ${echoAvg} ms; closed port reported as "${dead.state}"`);
}

// 12. The protocol is what makes a UDP round-trip a game measurement: the queries are fixed, so
//     a reply can be tied to the packet this probe sent instead of being counted because it
//     arrived.
{
  const a2s = protocolById("a2s");
  const info = Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    Buffer.from("I", "ascii"),
    Buffer.from("127.0.0.1:27015", "ascii"),
  ]);
  const challenge = Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from("A", "ascii"), Buffer.from([1, 2, 3, 4])]);
  assert.ok(a2s.match(info, "token"), "an A2S info block is the service answering");
  assert.equal(a2s.match(challenge, "token"), false, "a challenge alone is not the info block");
  const retry = a2s.next(challenge, "token");
  assert.ok(retry, "a challenge produces the second query");
  assert.ok(
    retry.includes(Buffer.from("TSource Engine Query\0", "ascii")) &&
      retry.subarray(-4).equals(Buffer.from([1, 2, 3, 4])),
    "the retry is the info query with the server's challenge appended",
  );
  assert.equal(a2s.next(info, "token"), null, "an info block is not a challenge to repeat");
  assert.equal(
    a2s.match(Buffer.from("PingLab echo abc", "ascii"), "token"),
    false,
    "our own echo bytes are not an A2S reply",
  );
  assert.ok(
    a2s.build("token").includes(Buffer.from("TSource Engine Query\0", "ascii")),
    "the A2S query is the real packet, not a placeholder",
  );

  const q3 = protocolById("q3");
  const infoResponse = Buffer.concat([
    Buffer.from([0xff, 0xff, 0xff, 0xff]),
    Buffer.from("infoResponse\n\\challenge\\pinglab-abc123", "ascii"),
  ]);
  assert.ok(q3.match(infoResponse, "abc123"), "a Quake 3 infoResponse carrying our challenge is an answer");
  assert.equal(q3.match(infoResponse, "other"), false, "a reply for another challenge is not this probe's");
  assert.equal(q3.match(info, "abc123"), false, "another protocol's reply is not a Quake 3 answer");

  // Minecraft Bedrock: the pong must echo the timestamp this ping carried, so a pong for a
  // different ping (or a different RakNet service) is not this probe's answer.
  const mc = protocolById("minecraft");
  const ping = mc.build("abc123");
  const pong = Buffer.concat([
    Buffer.from([0x1c]),
    ping.subarray(1, 9),
    Buffer.from("12345678", "ascii"),
    ping.subarray(9, 25),
    Buffer.from([0, 2]),
    Buffer.from("MCPE", "ascii"),
  ]);
  assert.ok(mc.match(pong, "abc123"), "a RakNet pong echoing our timestamp is an answer");
  assert.equal(mc.match(pong, "othertoken"), false, "a pong for another ping is not this probe's");
  assert.equal(mc.match(info, "abc123"), false, "another protocol's reply is not a RakNet pong");

  // UT2004: the 0x80 header with reply type 0 is the server info this query asked for; a rules
  // reply (type 1) is not.
  const ut = protocolById("ut2004");
  assert.deepEqual([...ut.build("token")], [0x79, 0, 0, 0, 0], "the UT2004 query is the five-byte server-info request");
  assert.ok(ut.match(Buffer.from([0x80, 0, 0, 0, 0, 0, 0, 0]), "token"), "the server-info reply is an answer");
  assert.equal(
    ut.match(Buffer.from([0x80, 0, 0, 0, 1, 0]), "token"),
    false,
    "a rules reply is not the info reply this query asked for",
  );

  // A challenge is exactly 'A' plus four bytes. A longer 'A' reply is not one this probe can
  // answer, so it is left alone instead of being cut into a bogus query.
  assert.equal(
    a2s.next(Buffer.concat([challenge, Buffer.from([0, 0])]), "token"),
    null,
    "a reply longer than a challenge is not treated as one",
  );

  // Minecraft Java: a session id this probe chose, then the server's challenge. The full-stat
  // query carries both back, and only an answer with our session id is this probe's.
  const java = protocolById("minecraftjava");
  const session = Number.parseInt("abc123", 16) >>> 0;
  const handshake = java.build("abc123");
  assert.deepEqual([...handshake.subarray(0, 3)], [0xfe, 0xfd, 0x09], "the Java query is the GameSpy handshake");
  assert.equal(handshake.readUInt32BE(3), session, "the handshake carries this probe's session id");
  const javaChallenge = Buffer.concat([Buffer.from([0x09]), uint32(session), Buffer.from("424242\0", "ascii")]);
  const full = java.next(javaChallenge, "abc123");
  assert.ok(full, "a challenge with our session id produces the full-stat query");
  assert.deepEqual([...full.subarray(0, 3)], [0xfe, 0xfd, 0x00], "the full-stat query is what follows");
  assert.equal(full.readUInt32BE(3), session, "it repeats our session id");
  assert.equal(full.readUInt32BE(7), 424242, "and the challenge the server gave");
  const javaAnswer = Buffer.concat([
    Buffer.from([0x00]),
    uint32(session),
    Buffer.from("splitnum\0\x80\0hostname\0loopback\0", "latin1"),
  ]);
  assert.ok(java.match(javaAnswer, "abc123"), "a full-stat answer with our session id is the service answering");
  assert.equal(java.match(javaAnswer, "other123"), false, "an answer for another session is not this probe's");
  assert.equal(java.match(javaChallenge, "abc123"), false, "the challenge alone is not the full-stat answer");

  // Doom 3 has no client token: the answer must carry the engine's own infoResponse header and
  // the si_version key, so another service's datagram cannot be timed as it.
  const doom = protocolById("doom3");
  assert.deepEqual([...doom.build("token")], [0xff, 0xff, 0x67, 0x65, 0x74, 0x49, 0x6e, 0x66, 0x6f], "the Doom 3 query is getInfo");
  const doomReply = Buffer.concat([
    Buffer.from([0xff, 0xff]),
    Buffer.from("infoResponse\0", "latin1"),
    Buffer.from("si_version\0DOOM 1.0\0", "latin1"),
  ]);
  assert.ok(doom.match(doomReply, "token"), "an infoResponse with si_version is the Doom 3 answer");
  assert.equal(
    doom.match(Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from("infoResponse\0", "latin1")]), "token"),
    false,
    "a reply without the engine's info keys is not an answer",
  );

  const echo = protocolById("echo");
  const payload = echo.build("abc123");
  assert.ok(echo.match(payload, "abc123"), "the identical bytes back are the echo");
  assert.equal(echo.match(Buffer.from("PingLab echo abc124", "ascii"), "abc123"), false, "a different token is not this probe");
  assert.equal(protocolById("nope"), null, "an unknown protocol is never guessed");
  assert.equal(udpProtocol(undefined).id, "echo", "an endpoint without a protocol gets the controlled echo");
  near(protocolById("none").measures, false, "a protocol that publishes no query says so");
  assert.equal(protocolById("none").build("abc123"), null, "and there is no datagram to send");
  near(udpProtocol("none").id, "none", "the named protocol is the one used");
}

// 13. Live sockets: a service that answers with its own bytes is not an echo, so it yields no
//     latency; a port that speaks A2S_INFO is timed only after completing its challenge, and a
//     port that challenges but never sends the block is still an answer, not silence.
{
  const noisy = dgram.createSocket("udp4");
  await new Promise((r) => noisy.bind(0, "127.0.0.1", r));
  noisy.on("message", (msg, from) => noisy.send(Buffer.from("keep-alive", "ascii"), from.port, from.address));
  const noisyPort = noisy.address().port;
  try {
    const wrong = await probeUdp(
      { id: "wrong", label: "not an echo", host: "127.0.0.1", port: noisyPort, ip: "127.0.0.1" },
      { count: 2, timeoutMs: 400, gap: 10 },
    );
    near(wrong.state, "unexpected", "an answer that is not this probe's echo is not a round trip");
    assert.equal(wrong.avg, null, "no latency is invented from an unrelated datagram");
    assert.equal(wrong.loss, null, "and it is not packet loss either");
    near(wrong.unexpected, 2, "the unrelated datagrams are counted");
  } finally {
    noisy.close();
  }

  const game = dgram.createSocket("udp4");
  await new Promise((r) => game.bind(0, "127.0.0.1", r));
  game.on("message", (msg, from) => {
    if (!msg.includes(Buffer.from("TSource Engine Query", "ascii"))) return;
    // The first query (no challenge appended) gets a challenge; the repeated query gets the
    // info block. Only the second exchange may become the latency figure.
    if (msg.length === 24) {
      game.send(
        Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from("A", "ascii"), Buffer.from([9, 9, 9, 9])]),
        from.port,
        from.address,
      );
      return;
    }
    const reply = Buffer.concat([
      Buffer.from([0xff, 0xff, 0xff, 0xff]),
      Buffer.from("I", "ascii"),
      Buffer.from("127.0.0.1:27015", "ascii"),
    ]);
    game.send(reply, from.port, from.address);
  });
  const gamePort = game.address().port;
  try {
    const answered = await probeUdp(
      { id: "a2s", label: "A2S_INFO", host: "127.0.0.1", port: gamePort, ip: "127.0.0.1", protocol: "a2s" },
      { count: 3, timeoutMs: 800, gap: 20 },
    );
    near(answered.state, "answered", "the A2S query is answered by the game port");
    near(answered.protocol, "a2s", "the row names the protocol it used");
    near(answered.replies, 3, "every A2S probe completed its challenge and got the info block");
    near(answered.unexpected, 0, "the challenge was not counted as an unrelated datagram");

    const challengeOnly = dgram.createSocket("udp4");
    await new Promise((r) => challengeOnly.bind(0, "127.0.0.1", r));
    challengeOnly.on("message", (_msg, from) => {
      challengeOnly.send(
        Buffer.concat([Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from("A", "ascii"), Buffer.from([1, 1, 1, 1])]),
        from.port,
        from.address,
      );
    });
    try {
      const onlyChallenge = await probeUdp(
        { id: "challenge", label: "challenge only", host: "127.0.0.1", port: challengeOnly.address().port, ip: "127.0.0.1", protocol: "a2s" },
        { count: 1, timeoutMs: 300, gap: 10 },
      );
      near(onlyChallenge.state, "challenge", "a service that only challenges is the challenge stage");
      near(onlyChallenge.replies, 0, "the challenge round trip is not a completed reply");
      near(onlyChallenge.challenges, 1, "the challenge-only probe is counted as such");
      near(onlyChallenge.challenged, 1, "the row records that a challenge was seen");
      assert.ok(
        onlyChallenge.challengeAvgMs !== null && onlyChallenge.challengeAvgMs >= 0,
        "the challenge RTT is still available as a diagnostic",
      );
      assert.equal(onlyChallenge.avg, null, "no service latency is invented for a partial exchange");
      near(
        Object.values(onlyChallenge.stages).reduce((a, b) => a + b, 0),
        onlyChallenge.sent,
        "the stage counts reconcile with the probe count",
      );
    } finally {
      challengeOnly.close();
    }
    console.log(
      `  udp protocol an A2S_INFO port answered in ${answered.avg} ms after its challenge; a challenge-only port stayed in the challenge stage`,
    );
  } finally {
    game.close();
  }
}

// 14. An endpoint that publishes no query is not probed: no socket traffic, no timeout, and a
//     row the surfaces cannot read as a game server that stayed silent.
{
  let received = 0;
  const server = dgram.createSocket("udp4");
  await new Promise((r) => server.bind(0, "127.0.0.1", r));
  server.on("message", () => {
    received += 1;
  });
  try {
    const row = await probeUdp(
      {
        id: "store",
        label: "storefront",
        host: "127.0.0.1",
        port: server.address().port,
        ip: "127.0.0.1",
        protocol: "none",
      },
      { count: 4, timeoutMs: 200, gap: 10 },
    );
    near(row.state, "no-query", "an endpoint with no query says so");
    near(row.sent, 0, "nothing was sent");
    near(row.replies, 0, "nothing was answered");
    assert.equal(row.avg, null, "no latency is invented");
    assert.equal(row.loss, null, "and no loss either");
    near(received, 0, "no datagram reached the port");
    console.log("  udp none    an endpoint that publishes no query sends nothing and reports no-query");
  } finally {
    server.close();
  }
}

function uint32(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0, 0);
  return out;
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
console.log("  udp         latency and loss only from answered probes; silence and closed ports stay out");
console.log("\nall probe math checks passed");
