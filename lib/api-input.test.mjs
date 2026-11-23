/**
 * The rules the API applies to what it is sent, exercised without a socket.
 *
 * api-hardening.test.mjs proves the routes use them; this pins the boundary itself: what is
 * refused, with which status, and that the legitimate shapes every caller sends still pass.
 * The values here are the ones that reach a PowerShell script, a DNS lookup, the saved
 * endpoint list or a measured duration, so "accepted but odd" is a bug, not a preference.
 */
import assert from "node:assert/strict";
import {
  HttpError,
  bodyObject,
  textField,
  hostField,
  serverList,
  endpointList,
  secondsField,
  bufferbloatRequest,
  soakRequest,
  tweakRequest,
  pathId,
} from "./api-input.mjs";

const cases = [];
const test = (name, run) => cases.push({ name, run });

function denies(fn, status, pattern) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof HttpError, `expected an HttpError, got ${err?.name}: ${err?.message}`);
    assert.equal(err.status, status, `expected ${status}, got ${err.status} (${err.message})`);
    if (pattern) assert.match(err.message, pattern);
    return;
  }
  assert.fail("expected a refusal, got a value");
}

test("a body has to be an object", () => {
  assert.deepEqual(bodyObject({ a: 1 }), { a: 1 });
  for (const value of [null, [], 5, "text", true]) denies(() => bodyObject(value), 400, /JSON object/);
});

test("text fields are trimmed, bounded and single-line", () => {
  assert.equal(textField("  WLAN  ", { name: "alias", max: 10 }), "WLAN");
  assert.equal(textField(undefined, { name: "preset", max: 10, required: false }), null);
  denies(() => textField(undefined, { name: "alias", max: 10 }), 400, /required/);
  denies(() => textField("   ", { name: "alias", max: 10 }), 400, /required/);
  denies(() => textField(42, { name: "alias", max: 10 }), 400, /text/);
  denies(() => textField("a".repeat(11), { name: "alias", max: 10 }), 400, /too long/);
  denies(() => textField("two\nlines", { name: "alias", max: 10 }), 400, /control/);
});

test("hosts may not be option-shaped or carry a path", () => {
  assert.equal(hostField("example.com"), "example.com");
  assert.equal(hostField(" 1.1.1.1 "), "1.1.1.1");
  assert.equal(hostField("2606:4700:4700::1111"), "2606:4700:4700::1111");
  assert.equal(hostField(undefined, { fallback: "1.1.1.1" }), "1.1.1.1");
  assert.equal(hostField("münchen.example"), "münchen.example", "IDN hosts still resolve");
  denies(() => hostField("-f"), 400, /dash/);
  denies(() => hostField("1.1.1.1 -t"), 400, /host name|IP/);
  denies(() => hostField("example.com/path"), 400, /host name|IP/);
  denies(() => hostField("user@example.com"), 400, /host name|IP/);
  denies(() => hostField(`${"a".repeat(260)}.com`), 400, /too long/);
  denies(() => hostField(7), 400, /text/);
});

test("DNS server lists are real addresses, and few", () => {
  assert.deepEqual(serverList(["1.1.1.1", " 8.8.8.8 "]), ["1.1.1.1", "8.8.8.8"]);
  assert.equal(serverList(undefined), null);
  denies(() => serverList("1.1.1.1"), 400, /list/);
  denies(() => serverList([]), 400, /at least one/);
  denies(() => serverList(["1.1.1.1", "2.2.2.2", "3.3.3.3", "4.4.4.4", "5.5.5.5"]), 400, /Too many/);
  denies(() => serverList(["8.8.8.8; calc"]), 400, /IP addresses/);
  denies(() => serverList([8]), 400, /IP addresses/);
});

test("an endpoint list is bounded, and each entry is checked", () => {
  const ok = endpointList([{ host: "1.1.1.1", port: 443, kind: "game", label: "one", id: "one" }]);
  assert.deepEqual(ok, [{ id: "one", label: "one", host: "1.1.1.1", port: 443, kind: "game" }]);

  const clamped = endpointList([{ host: "example.com", label: "x".repeat(100), id: "a b c" }]);
  assert.equal(clamped[0].label.length, 60, "a long label is clamped, not refused");
  assert.equal(clamped[0].id, "abc");
  assert.equal(clamped[0].port, 443, "the default port stays 443");

  denies(() => endpointList("nope"), 400, /list/);
  denies(() => endpointList([]), 400, /At least one/);
  denies(() => endpointList(Array.from({ length: 26 }, () => ({ host: "1.1.1.1" }))), 400, /limit is 25/);
  denies(() => endpointList([null]), 400, /must be an object/);
  denies(() => endpointList([{ host: "" }]), 400, /required/);
  denies(() => endpointList([{ host: "1.1.1.1", port: 0 }]), 400, /port/);
  denies(() => endpointList([{ host: "1.1.1.1", port: 65536 }]), 400, /port/);
  denies(() => endpointList([{ host: "1.1.1.1", port: 4.5 }]), 400, /port/);
});

test("durations are numbers inside the range the work can finish in", () => {
  assert.equal(secondsField(6, { min: 1, max: 30, fallback: 6 }), 6);
  assert.equal(secondsField("6", { min: 1, max: 30 }), 6);
  assert.equal(secondsField(undefined, { min: 1, max: 30, fallback: 6 }), 6);
  denies(() => secondsField("abc", { min: 1, max: 30 }), 400, /number/);
  denies(() => secondsField(0, { min: 1, max: 30 }), 400, /between/);
  denies(() => secondsField(31, { min: 1, max: 30 }), 400, /between/);
  denies(() => secondsField(Infinity, { min: 1, max: 30 }), 400, /between|number/);
});

test("bufferbloat keeps its defaults and refuses an option-shaped target", () => {
  assert.deepEqual(bufferbloatRequest({}), { host: "1.1.1.1", seconds: 6, direction: "both" });
  assert.deepEqual(bufferbloatRequest({ host: "9.9.9.9", seconds: 10 }), {
    host: "9.9.9.9",
    seconds: 10,
    direction: "both",
  });
  for (const direction of ["down", "up", "both", "duplex"]) {
    assert.equal(bufferbloatRequest({ direction }).direction, direction);
  }
  denies(() => bufferbloatRequest({ host: "-t" }), 400, /dash/);
  denies(() => bufferbloatRequest({ seconds: 3600 }), 400, /between/);
  // A direction is a closed set: an unknown one is refused, never silently turned into
  // "both", because that would load the opposite direction of what was asked for.
  for (const direction of ["sideways", "", 5, ["both"], "BOTH"]) {
    denies(() => bufferbloatRequest({ direction }), 400, /direction must be one of/);
  }
});

test("a soak request maps minutes to seconds and stays inside the clamp", () => {
  assert.deepEqual(soakRequest({ minutes: 10 }), { seconds: 600, intervalMs: 500 });
  assert.deepEqual(soakRequest({ minutes: 1 }), { seconds: 60, intervalMs: 500 });
  assert.deepEqual(soakRequest({ seconds: 90, intervalMs: 1000 }), { seconds: 90, intervalMs: 1000 });
  assert.deepEqual(soakRequest({}), { seconds: 600, intervalMs: 500 });
  denies(() => soakRequest({ minutes: 61 }), 400, /between/);
  denies(() => soakRequest({ minutes: 0 }), 400, /between/);
  denies(() => soakRequest({ seconds: 5 }), 400, /between/);
  denies(() => soakRequest({ intervalMs: 100 }), 400, /between/);
  denies(() => soakRequest({ intervalMs: 250.5 }), 400, /whole number/);
});

test("a tweak request carries only a known shape", () => {
  assert.deepEqual(tweakRequest({ action: "nagle", alias: "WLAN" }), {
    action: "nagle",
    alias: "WLAN",
    preset: null,
    servers: null,
  });
  assert.deepEqual(tweakRequest({ action: "apply-preset", alias: "WLAN", preset: "safe" }), {
    action: "apply-preset",
    alias: "WLAN",
    preset: "safe",
    servers: null,
  });
  assert.deepEqual(tweakRequest({ action: "dns-apply", alias: "WLAN", servers: ["1.1.1.1"] }).servers, ["1.1.1.1"]);
  denies(() => tweakRequest({ alias: "WLAN" }), 400, /action/);
  denies(() => tweakRequest({ action: "nagle" }), 400, /alias/);
  denies(() => tweakRequest({ action: "nagle; calc", alias: "WLAN" }), 400, /format/);
  denies(() => tweakRequest({ action: "nagle", alias: "a".repeat(129) }), 400, /too long/);
  denies(() => tweakRequest({ action: "nagle", alias: "WLAN", servers: "1.1.1.1" }), 400, /list/);
});

test("a soak run id is one numeric path segment", () => {
  assert.equal(pathId("/api/soak/run/12", "/api/soak/run/"), 12);
  assert.equal(pathId("/api/soak/run/1/extra", "/api/soak/run/"), null);
  assert.equal(pathId("/api/soak/run/abc", "/api/soak/run/"), null);
  assert.equal(pathId("/api/soak/run/", "/api/soak/run/"), null);
  assert.equal(pathId("/api/soak/other/1", "/api/soak/run/"), null);
  assert.equal(pathId("/api/soak/run/1234567890123", "/api/soak/run/"), null);
});

/* --------------------------------------------------------------------- run */

try {
  for (const c of cases) await c.run();
  console.log("\napi input");
  console.log(`  cases        ${cases.length}`);
  console.log("  bodies       objects only; text fields trimmed, bounded and single-line");
  console.log("  hosts        no leading dash, no whitespace, no path or userinfo separators");
  console.log("  lists        endpoints (25) and DNS servers (4) bounded; ports must be real");
  console.log("  durations    bufferbloat 1-30 s, soak 10-3600 s with a whole-millisecond interval");
  console.log("  tweaks       action, alias, preset and servers checked before any dispatch");
} finally {
  /* nothing to clean up: these are pure functions */
}
