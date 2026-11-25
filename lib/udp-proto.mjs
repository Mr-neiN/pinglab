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
 *   a2s        Source Engine (CS2, CS:GO, TF2, Rust, Garry's Mod, Valheim, ...) A2S_INFO. The
 *              service may answer with a challenge ('A') first; `next` repeats the query with
 *              that challenge and `lib/probe.mjs` times the exchange that returns the info
 *              block ('I'). Only the block - or the obsolete GoldSrc block ('m') - is accepted
 *              as the answer.
 *   q3         id Tech 3 (Quake III Arena, OpenArena, Enemy Territory) getinfo, answered with
 *              "infoResponse". Quake Live is id Tech 3 but does not answer it; it speaks A2S.
 *   minecraft  Minecraft Bedrock (RakNet) unconnected ping. The reply echoes the timestamp this
 *              probe carried, so a pong for someone else's ping is not this probe's answer.
 *   minecraftjava  Minecraft Java's own query port (`enable-query`), a GameSpy-style handshake:
 *              a client-chosen session id and a server challenge. Both are echoed, so only the
 *              answer to this probe's full-stat query can be timed.
 *   doom3      id Tech 4 (Doom 3, Quake 4, Enemy Territory: Quake Wars) getInfo, answered with
 *              the engine's infoResponse block. The reply carries no client token, so the
 *              matcher requires the engine's own header and its `si_version` key: another
 *              service cannot produce it, and an unrelated datagram cannot be timed as it.
 *   ut2004     Unreal Tournament 2004 server-info query (0x79 0 0 0 0), answered with the
 *              0x80 0 0 0 header and the info reply type (0x00). The query port is game port + 1.
 *   echo       A controlled echo: the payload carries a per-probe token and only those exact
 *              bytes coming back count. This is the transport check that works against any
 *              echo endpoint, including one the user runs - and the only case where "a datagram
 *              came back" really is the round-trip this probe sent.
 *
 * Pure on purpose: payload in, matcher out, no sockets and no I/O. `lib/probe.mjs` sends the
 * datagram; the matcher decides whether a reply may become a latency figure, so an unrelated
 * answer (a keep-alive, another service, someone else's packet) can never be timed as if it
 * were this probe's.
 */

const PREFIX = Buffer.from([0xff, 0xff, 0xff, 0xff]);
/** RakNet's fixed magic, present in every unconnected ping and pong. */
const RAKNET_MAGIC = Buffer.from([
  0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe, 0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78,
]);
const A2S_QUERY = Buffer.concat([PREFIX, Buffer.from("TSource Engine Query\0", "ascii")]);
const DOOM3_QUERY = Buffer.concat([Buffer.from([0xff, 0xff]), Buffer.from("getInfo", "ascii")]);
const JAVA_HANDSHAKE = Buffer.from([0xfe, 0xfd, 0x09]);
/** Java's query session id: the first four bytes of the probe token, so it is ours. */
const javaSession = (token) => Number.parseInt(String(token).slice(0, 8), 16) >>> 0;

/** Source and id Tech 3 replies start with this header; it is not part of either payload. */
function startsWithPrefix(reply) {
  return reply.length >= 4 && reply[0] === 0xff && reply[1] === 0xff && reply[2] === 0xff && reply[3] === 0xff;
}

/** The 8-byte ping timestamp a Bedrock pong echoes back, derived from this probe's token. */
/** A big-endian 32-bit integer, for the query protocols that frame numbers that way. */
function uint32BE(value) {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value >>> 0, 0);
  return out;
}

function bedrockStamp(token) {
  const stamp = Buffer.alloc(8);
  stamp.writeUInt32BE(0, 0);
  stamp.writeUInt32BE(Number.parseInt(String(token).slice(0, 8), 16) >>> 0, 4);
  return stamp;
}

export const UDP_PROTOCOLS = {
  a2s: {
    id: "a2s",
    label: "A2S_INFO (Source Engine)",
    describe: "the information query a game browser sends to a Source Engine server",
    build: () => A2S_QUERY,
    // A server may answer the first query with a 4-byte challenge ('A'). The client is meant to
    // repeat the query with that challenge appended, and only the information block ('I') is
    // the answer. Returning the second datagram here keeps the socket and the timing in
    // lib/probe.mjs, and keeps this module pure.
    // A challenge is exactly four bytes after the 'A' header. A longer reply is not a
    // challenge this probe can answer, so it is not turned into a query with four bytes
    // taken from the middle of something else.
    next: (reply) => {
      if (!startsWithPrefix(reply) || reply.length !== 9 || reply[4] !== 0x41) return null;
      return Buffer.concat([A2S_QUERY, reply.subarray(5, 9)]);
    },
    // 'I' is the info block; 'm' is the obsolete GoldSrc info block old servers still send.
    match: (reply) => startsWithPrefix(reply) && reply.length >= 5 && (reply[4] === 0x49 || reply[4] === 0x6d),
  },
  q3: {
    id: "q3",
    label: "Quake 3 info",
    describe: "the getinfo query id Tech 3 servers answer (Quake Live speaks A2S instead)",
    // The challenge string is echoed inside the reply, so it proves the answer belongs to this
    // query rather than being an unrelated packet the server happened to send.
    build: (token) => Buffer.concat([PREFIX, Buffer.from(`getinfo pinglab-${String(token).slice(0, 8)}\n`, "ascii")]),
    match: (reply, token) =>
      startsWithPrefix(reply) &&
      reply.includes("infoResponse") &&
      reply.toString("latin1").includes(`pinglab-${String(token).slice(0, 8)}`),
  },
  minecraft: {
    id: "minecraft",
    label: "Minecraft Bedrock ping",
    describe: "the unconnected ping a Bedrock (RakNet) server answers on its game port",
    // 0x01, the 8-byte send time, RakNet's magic, then a client GUID. The pong repeats all three,
    // so the reply can be tied to this ping.
    build: (token) =>
      Buffer.concat([
        Buffer.from([0x01]),
        bedrockStamp(token),
        RAKNET_MAGIC,
        Buffer.from("PingLab\0", "ascii"),
      ]),
    // 0x1c, echoed send time, server GUID, then RakNet's magic at offset 17.
    match: (reply, token) =>
      reply.length >= 35 &&
      reply[0] === 0x1c &&
      reply.subarray(1, 9).equals(bedrockStamp(token)) &&
      reply.subarray(17, 33).equals(RAKNET_MAGIC),
  },
  minecraftjava: {
    id: "minecraftjava",
    label: "Minecraft Java query",
    describe: "the GameSpy-style query a Minecraft Java server answers when enable-query is on",
    // 0xFE 0xFD 0x09, then the session id this probe chose. The server answers with the
    // session id and a challenge, and only the full-stat fetch carries both back.
    build: (token) => Buffer.concat([JAVA_HANDSHAKE, uint32BE(javaSession(token))]),
    next: (reply, token) => {
      if (reply.length < 6 || reply[0] !== 0x09 || reply.readUInt32BE(1) !== javaSession(token)) return null;
      const text = reply.subarray(5).toString("latin1");
      const nul = text.indexOf("\0");
      const challenge = Number.parseInt((nul >= 0 ? text.slice(0, nul) : text).trim(), 10);
      if (!Number.isFinite(challenge) || challenge < 0 || challenge > 0xffffffff) return null;
      const out = Buffer.alloc(15);
      out[0] = 0xfe;
      out[1] = 0xfd;
      out[2] = 0x00;
      out.writeUInt32BE(javaSession(token), 3);
      out.writeUInt32BE(challenge >>> 0, 7);
      // Four padding bytes, as the protocol requires; they are zero on every client.
      out.writeUInt32BE(0, 11);
      return out;
    },
    // 0x00, our session id, then the splitnum header every full-stat answer starts with.
    match: (reply, token) =>
      reply.length >= 16 && reply[0] === 0x00 && reply.readUInt32BE(1) === javaSession(token) && reply.includes("splitnum"),
  },
  doom3: {
    id: "doom3",
    label: "Doom 3 info",
    describe: "the getInfo query id Tech 4 servers answer (Doom 3, Quake 4, ET: Quake Wars)",
    build: () => DOOM3_QUERY,
    // No client token exists in this protocol, so the answer must carry the engine's own
    // infoResponse header and the si_version key its info block always has.
    match: (reply) =>
      reply.length > 20 &&
      reply[0] === 0xff &&
      reply[1] === 0xff &&
      reply.subarray(2, 15).toString("latin1") === "infoResponse\0" &&
      reply.includes("si_version"),
  },
  ut2004: {
    id: "ut2004",
    label: "UT2004 query",
    describe: "the server-info query Unreal Tournament 2004 answers (query port = game port + 1)",
    build: () => Buffer.from([0x79, 0x00, 0x00, 0x00, 0x00]),
    // The reply header is 80 00 00 00 followed by the reply type; 0x00 is the server info this
    // query asked for, so a rules or player reply cannot be timed as it.
    match: (reply) =>
      reply.length >= 5 && reply[0] === 0x80 && reply[1] === 0 && reply[2] === 0 && reply[3] === 0 && reply[4] === 0x00,
  },
  echo: {
    id: "echo",
    label: "controlled echo",
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
