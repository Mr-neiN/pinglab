/**
 * The queries a UDP round-trip can be measured with, and the rule for accepting an answer.
 *
 * A UDP probe measures something only when the datagram is one the far end answers. PingLab
 * used to send the same meaningless string ("PingLab UDP probe") to every game endpoint, which
 * only a deliberate echo can answer; a real game server ignores a packet it does not recognise,
 * so the probe could never time the service it was aimed at.
 *
 * This module holds the queries that can actually elicit an answer, and one matcher each:
 *
 *   a2s   Source Engine (CS2, CS:GO, TF2, Rust, Garry's Mod, ...) A2S_INFO. The service answers
 *         with an info block ('I') or, before that, a challenge ('A'); both are the service
 *         itself replying, which is all a round-trip needs.
 *   q3    id Tech 3 (Quake 3, Quake Live, OpenArena) getinfo, answered with "infoResponse".
 *   echo  A controlled echo: the payload carries a per-probe token and only those exact bytes
 *         coming back count. This is the transport check that works against any echo endpoint,
 *         including one the user runs - and the only case where "a datagram came back" really
 *         is the round-trip this probe sent.
 *
 * Pure on purpose: payload in, matcher out, no sockets and no I/O. `lib/probe.mjs` sends the
 * datagram; the matcher decides whether a reply may become a latency figure, so an unrelated
 * answer (a keep-alive, another service, someone else's packet) can never be timed as if it
 * were this probe's.
 */

const PREFIX = Buffer.from([0xff, 0xff, 0xff, 0xff]);

/** All three protocols under test answer inside this header; it is not part of any payload. */
function startsWithPrefix(reply) {
  return reply.length >= 4 && reply[0] === 0xff && reply[1] === 0xff && reply[2] === 0xff && reply[3] === 0xff;
}

export const UDP_PROTOCOLS = {
  a2s: {
    id: "a2s",
    label: "A2S_INFO (Source Engine)",
    describe: "the information query a game browser sends to a Source Engine server",
    build: () => Buffer.concat([PREFIX, Buffer.from("TSource Engine Query\0", "ascii")]),
    // 'I' is the info block; 'A' is the challenge a server answers the first query with (the
    // client is meant to repeat the query with that challenge appended). Both come from the
    // game service, so both are a round trip to it - the challenge is simply not the final one.
    match: (reply) => startsWithPrefix(reply) && reply.length >= 5 && (reply[4] === 0x49 || reply[4] === 0x41),
  },
  q3: {
    id: "q3",
    label: "Quake 3 info",
    describe: "the getinfo query id Tech 3 servers answer",
    // The challenge string is echoed inside the reply, so it proves the answer belongs to this
    // query rather than being an unrelated packet the server happened to send.
    build: (token) => Buffer.concat([PREFIX, Buffer.from(`getinfo pinglab-${String(token).slice(0, 8)}\n`, "ascii")]),
    match: (reply, token) =>
      startsWithPrefix(reply) &&
      reply.includes("infoResponse") &&
      reply.toString("latin1").includes(`pinglab-${String(token).slice(0, 8)}`),
  },
  echo: {
    id: "echo",
    label: "UDP echo",
    describe: "a controlled echo that sends the probe's own bytes back unchanged",
    build: (token) => Buffer.from(`PingLab echo ${String(token)}`, "ascii"),
    match: (reply, token) => reply.equals(Buffer.from(`PingLab echo ${String(token)}`, "ascii")),
  },
};

export const UDP_PROTOCOL_IDS = new Set(Object.keys(UDP_PROTOCOLS));

/** The transport every endpoint gets unless it says otherwise: the one that needs no game. */
export const DEFAULT_UDP_PROTOCOL = "echo";

/** The named protocol, or null for a name this app does not know (never a guess). */
export function protocolById(id) {
  const key = typeof id === "string" ? id.trim().toLowerCase() : "";
  return Object.hasOwn(UDP_PROTOCOLS, key) ? UDP_PROTOCOLS[key] : null;
}

/** The descriptor to use for an endpoint: its own protocol when known, the echo otherwise. */
export function udpProtocol(id) {
  return protocolById(id) ?? UDP_PROTOCOLS[DEFAULT_UDP_PROTOCOL];
}
