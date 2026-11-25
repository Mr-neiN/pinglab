/**
 * Real sockets, real protocol bytes: every UDP query PingLab can time, answered by a server that
 * speaks it.
 *
 * `lib/probe-math.test.mjs` pins the matchers as pure functions; this suite proves the whole path
 * (dgram socket -> the engine's own query -> a server that parses it -> the reply -> a timed
 * sample) for each protocol. The servers here are real UDP servers on loopback and they speak the
 * wire format, not a stub of it: the A2S port challenges and only answers the repeated query, the
 * Bedrock port echoes the timestamp it was sent, the Java port checks the session id it was given,
 * and so on. That is what makes a figure possible only when the service answered the packet this
 * probe sent.
 *
 * Then, with PINGLAB_LIVE=1, the same prober is pointed at the four public game servers shipped in
 * `lib/config.mjs` - other people's machines, so nothing is asserted about whether they answer;
 * only the invariants are: an answered row has a finite latency, a silent one has no latency and
 * no loss figure. Run `PINGLAB_LIVE=1 node lib/udp-live.test.mjs` on a machine with internet.
 */
import assert from "node:assert/strict";
import dgram from "node:dgram";

import { probeUdp, resolveHost } from "./probe.mjs";
import { protocolById } from "./udp-proto.mjs";
import { DEFAULT_ENDPOINTS } from "./config.mjs";

// This suite loads the shipped config defaults, which import the settings module: that is
// read-only, and the prober below is pointed at loopback in every non-live check.

const PREFIX = Buffer.from([0xff, 0xff, 0xff, 0xff]);
const near = (actual, expected, what) => assert.equal(actual, expected, `${what} (got ${actual})`);

/** A real UDP server on loopback, running `handler(message, from, socket)`. */
async function serve(handler) {
  const socket = dgram.createSocket("udp4");
  await new Promise((resolve) => socket.bind(0, "127.0.0.1", resolve));
  socket.on("message", (message, from) => handler(message, from, socket));
  return {
    port: socket.address().port,
    close: () => new Promise((resolve) => socket.close(resolve)),
  };
}

const endpoint = (id, port, protocol) => ({
  id,
  label: id,
  host: "127.0.0.1",
  port,
  ip: "127.0.0.1",
  protocol,
});

async function measured(protocol, server, { count = 3 } = {}) {
  return probeUdp(endpoint(protocol, server.port, protocol), { count, timeoutMs: 800, gap: 10 });
}

function assertAnswered(row, what) {
  near(row.state, "answered", `${what}: the service answered`);
  near(row.replies, row.sent, `${what}: every probe answered`);
  near(row.loss, 0, `${what}: no loss`);
  assert.ok(typeof row.avg === "number" && row.avg >= 0 && row.avg < 200, `${what}: plausible latency (got ${row.avg})`);
  assert.ok(Array.isArray(row.samples) && row.samples.length === row.sent, `${what}: samples kept for the benchmark`);
}

console.log("udp integration (real sockets)");

/* ---------------------------------------------------------------- A2S_INFO */
{
  const server = await serve((message, from, socket) => {
    if (!message.includes(Buffer.from("TSource Engine Query", "ascii"))) return;
    // The first query is the bare A2S_INFO; the repeated one appends the challenge, which is
    // how a real Source server asks to be asked again.
    if (message.length === 25) {
      return socket.send(Buffer.concat([PREFIX, Buffer.from("A", "ascii"), Buffer.from([7, 7, 7, 7])]), from.port, from.address);
    }
    socket.send(
      Buffer.concat([PREFIX, Buffer.from("I", "ascii"), Buffer.from("loopback server", "ascii")]),
      from.port,
      from.address,
    );
  });
  try {
    const row = await measured("a2s", server);
    assertAnswered(row, "a2s");
    near(row.challenged, row.sent, "a2s: every probe completed the challenge handshake");
    console.log(`  a2s          answered after a challenge in ${row.avg} ms`);
  } finally {
    await server.close();
  }
}

/* ------------------------------------------------------------- Quake 3 info */
{
  const server = await serve((message, from, socket) => {
    const text = message.toString("latin1");
    const match = /getinfo (pinglab-[0-9a-f]+)/.exec(text);
    if (!match) return;
    socket.send(
      Buffer.concat([PREFIX, Buffer.from(`infoResponse\n\\challenge\\${match[1]}\\hostname\\loopback`, "latin1")]),
      from.port,
      from.address,
    );
  });
  try {
    assertAnswered(await measured("q3", server), "q3");
    console.log("  q3           infoResponse carrying this probe's challenge");
  } finally {
    await server.close();
  }
}

/* --------------------------------------------------------- Bedrock / RakNet */
{
  const server = await serve((message, from, socket) => {
    if (message[0] !== 0x01) return;
    socket.send(
      Buffer.concat([
        Buffer.from([0x1c]),
        message.subarray(1, 9),
        Buffer.from("87654321", "ascii"),
        message.subarray(9, 25),
        Buffer.from([0, 2]),
        Buffer.from("MCPE", "ascii"),
      ]),
      from.port,
      from.address,
    );
  });
  try {
    assertAnswered(await measured("minecraft", server), "minecraft");
    console.log("  minecraft    RakNet pong echoing this probe's timestamp");
  } finally {
    await server.close();
  }
}

/* -------------------------------------------------------------------- UT2004 */
{
  const server = await serve((message, from, socket) => {
    if (message.length !== 5 || message[0] !== 0x79) return;
    socket.send(Buffer.concat([Buffer.from([0x80, 0, 0, 0, 0]), Buffer.from("loopback", "ascii")]), from.port, from.address);
  });
  try {
    assertAnswered(await measured("ut2004", server), "ut2004");
    console.log("  ut2004       server-info reply to the five-byte request");
  } finally {
    await server.close();
  }
}

/* ------------------------------------------------------------ Minecraft Java */
{
  const server = await serve((message, from, socket) => {
    if (message.length < 7 || message[0] !== 0xfe || message[1] !== 0xfd) return;
    if (message[2] === 0x09) {
      // The server answers with the session id it was given, then its challenge.
      socket.send(
        Buffer.concat([Buffer.from([0x09]), message.subarray(3, 7), Buffer.from("246810\0", "ascii")]),
        from.port,
        from.address,
      );
      return;
    }
    if (message[2] === 0x00) {
      const challenge = message.readUInt32BE(7);
      if (challenge !== 246810) return;
      socket.send(
        Buffer.concat([
          Buffer.from([0x00]),
          message.subarray(3, 7),
          Buffer.from("splitnum\0\x80\0hostname\0loopback\0gametype\0SMP\0", "latin1"),
        ]),
        from.port,
        from.address,
      );
    }
  });
  try {
    const row = await measured("minecraftjava", server);
    assertAnswered(row, "minecraftjava");
    near(row.challenged, row.sent, "minecraftjava: every probe used the session-id handshake");
    console.log(`  minecraftjava answered in ${row.avg} ms with the session id this probe chose`);
  } finally {
    await server.close();
  }
}

/* -------------------------------------------------------------------- Doom 3 */
{
  const server = await serve((message, from, socket) => {
    if (message.toString("latin1") !== "ÿÿgetInfo") return;
    socket.send(
      Buffer.concat([
        Buffer.from([0xff, 0xff]),
        Buffer.from("infoResponse\0", "latin1"),
        Buffer.from("si_version\x00DOOM 1.0\x00si_maxPlayers\x008\x00", "latin1"),
      ]),
      from.port,
      from.address,
    );
  });
  try {
    assertAnswered(await measured("doom3", server), "doom3");
    console.log("  doom3        infoResponse with si_version");
  } finally {
    await server.close();
  }
}

/* --------------------------------------------------------------- no query */
{
  // A platform service publishes nothing a client can send: no datagram may leave, and the row
  // must not read as a game server that stayed silent.
  let received = 0;
  const server = await serve(() => {
    received += 1;
  });
  try {
    const row = await probeUdp(endpoint("none", server.port, "none"), { count: 5, timeoutMs: 300, gap: 10 });
    near(row.state, "no-query", "an endpoint that publishes no query is not probed");
    near(row.sent, 0, "nothing was sent");
    near(received, 0, "no datagram reached the port");
    assert.equal(row.avg, null, "no latency is invented");
    assert.equal(row.loss, null, "no loss is invented");
    console.log("  none         no datagram sent, so no silent-service row");
  } finally {
    await server.close();
  }
}

/* -------------------------------------------------- what must not be timed */
{
  // A service that ignores an unknown packet: the normal answer to UDP, and not packet loss.
  const silent = await serve(() => {});
  try {
    const row = await measured("a2s", silent, { count: 2 });
    near(row.state, "silent", "a port that ignores the query is silent");
    assert.equal(row.avg, null, "silence is not a latency");
    assert.equal(row.loss, null, "silence is not 100% packet loss");
  } finally {
    await silent.close();
  }

  // A closed port answers with the host's ICMP error: a path figure, never a game figure.
  const spare = dgram.createSocket("udp4");
  await new Promise((resolve) => spare.bind(0, "127.0.0.1", resolve));
  const closedPort = spare.address().port;
  await new Promise((resolve) => spare.close(resolve));
  const closed = await probeUdp(endpoint("closed", closedPort, "a2s"), { count: 2, timeoutMs: 500, gap: 10 });
  assert.notEqual(closed.state, "answered", `a closed port must not look answered (got ${closed.state})`);
  assert.equal(closed.avg, null, "a closed port yields no service latency");
  assert.equal(closed.loss, null, "a closed port is not loss");
  console.log(`  closed       reported as "${closed.state}", with no latency and no loss`);
}

/* ------------------------------------------------------------------- live */
if (process.env.PINGLAB_LIVE) {
  console.log("\nlive game servers (PINGLAB_LIVE=1; other people's machines)");
  const targets = DEFAULT_ENDPOINTS.filter((e) => e.kind === "game" && protocolById(e.protocol)?.measures !== false);
  for (const target of targets) {
    // Resolve first, as the app does, and ask five times: a single dropped datagram is normal
    // for a public server and must not make a live default look dead.
    const resolved = await resolveHost(target.host);
    assert.ok(resolved.ip, `${target.label}: the shipped default host resolves (${resolved.error})`);
    const row = await probeUdp({ ...target, ip: resolved.ip }, { count: 5, timeoutMs: 900, gap: 100 });
    if (row.state === "answered") {
      assert.ok(typeof row.avg === "number" && Number.isFinite(row.avg), `${target.label}: answered with a finite latency`);
      assert.ok(row.avg >= 0, `${target.label}: latency is not negative`);
    } else {
      assert.equal(row.avg, null, `${target.label}: no figure without an answer`);
      assert.equal(row.loss, null, `${target.label}: silence is never reported as loss`);
    }
    console.log(`  ${target.label.padEnd(30)} ${row.state.padEnd(9)} ${row.avg === null ? "—" : `${row.avg} ms`}`);
  }
}

console.log("\nall UDP integration checks passed");
