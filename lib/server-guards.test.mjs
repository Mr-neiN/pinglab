/**
 * The web server's door policy: who may call the API, and what every response carries.
 *
 * These guards are invisible when they work and invisible when they are removed - the app
 * still answers, it just answers anyone. So this runs the real server.mjs on a spare loopback
 * port and knocks on it the way an attacker would: no token, a guessed token, a request from
 * another origin, a form-shaped body, and a DNS-rebinding Host. The token is read from the
 * page exactly as the browser reads it, so the injection and the check are tested together.
 *
 * Only read-only endpoints are called (/ and /api/health, plus /api/soak/stop with no soak
 * running), so nothing on this machine is changed.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER = join(ROOT, "server.mjs");

/** A port that is free right now, so this never collides with a running `npm run dev`. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * A request with no opinions of its own: every header, including Host and Origin, is set by
 * the caller. fetch()/undici would not let us forge those, which is the whole point here.
 */
function request(port, { method = "GET", path = "/", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(chunk));
      res.on("end", () =>
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text: Buffer.concat(chunks).toString("utf8"),
        }),
      );
    });
    req.on("error", reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** The headers every response must carry, whatever its status. */
function assertSecurityHeaders(res, label) {
  const h = res.headers;
  assert.equal(h["cache-control"], "no-store", `${label}: Cache-Control`);
  assert.equal(h["x-content-type-options"], "nosniff", `${label}: X-Content-Type-Options`);
  assert.equal(h["x-frame-options"], "DENY", `${label}: X-Frame-Options`);
  assert.equal(h["referrer-policy"], "no-referrer", `${label}: Referrer-Policy`);
  assert.equal(h["cross-origin-opener-policy"], "same-origin", `${label}: Cross-Origin-Opener-Policy`);
  assert.equal(h["cross-origin-resource-policy"], "same-origin", `${label}: Cross-Origin-Resource-Policy`);
  assert.match(
    String(h["permissions-policy"] || ""),
    /camera=\(\), microphone=\(\), geolocation=\(\)/,
    `${label}: Permissions-Policy`,
  );
  const csp = String(h["content-security-policy"] || "");
  for (const part of ["default-src 'none'", "script-src 'self'", "frame-ancestors 'none'", "base-uri 'none'"]) {
    assert.ok(csp.includes(part), `${label}: CSP must keep "${part}" (got ${JSON.stringify(csp)})`);
  }
  assert.equal(h["access-control-allow-origin"], undefined, `${label}: no CORS grant may appear`);
}

const wantJson = (res, label) => {
  assert.match(String(res.headers["content-type"] || ""), /^application\/json/, `${label}: JSON content type`);
  return JSON.parse(res.text);
};

const status = (res, expected, label) =>
  assert.equal(res.status, expected, `${label}: expected ${expected}, got ${res.status} ${res.text.slice(0, 160)}`);

const port = await freePort();
const child = spawn(process.execPath, [SERVER], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(port) },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
child.stdout.on("data", (b) => (serverLog += b));
child.stderr.on("data", (b) => (serverLog += b));

const base = `127.0.0.1:${port}`;
const origin = `http://127.0.0.1:${port}`;
const host = { host: base };

try {
  // ---- The server has to come up on the port we asked for before any of this means anything.
  let page;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      page = await request(port, { path: "/", headers: host });
      break;
    } catch (err) {
      if (err.code !== "ECONNREFUSED" && err.code !== "ECONNRESET") throw err;
      if (Date.now() > deadline) {
        throw new Error(`server did not start on ${base}:\n${serverLog}`);
      }
      await sleep(100);
    }
  }

  // ---- 1. The page loads, carries the security headers, and holds the run's token.
  status(page, 200, "page");
  assert.equal(page.headers["content-type"], "text/html; charset=utf-8", "page: HTML content type");
  assertSecurityHeaders(page, "page");
  assert.ok(page.text.includes("app.js"), "page: this is the PingLab page");
  const match = page.text.match(/<meta name="pinglab-token" content="([^"]+)"\s*\/?>/);
  assert.ok(match, "page: the token meta tag must be injected");
  const token = match[1];
  assert.ok(token.length >= 32, `page: token looks too short (${token.length} chars)`);

  // ---- 2. No token: refused, and told to reload rather than handed a cryptic error.
  {
    const res = await request(port, { path: "/api/health", headers: host });
    status(res, 403, "no token");
    assertSecurityHeaders(res, "no token");
    assert.equal(wantJson(res, "no token").ok, false, "no token: ok:false");
    assert.match(res.text, /Reload the page/, "no token: the message says what to do");
  }

  // ---- 3. Wrong token, same length and different length: both 403, neither a 500 (a
  //         length mismatch must not reach timingSafeEqual and throw).
  for (const [label, wrong] of [
    ["wrong token", `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`],
    ["short token", token.slice(0, 8)],
    ["long token", `${token}extra`],
  ]) {
    const res = await request(port, { path: "/api/health", headers: { ...host, "x-pinglab-token": wrong } });
    status(res, 403, label);
    assertSecurityHeaders(res, label);
  }

  // ---- 4. Everything right on a GET: 200, JSON, and the same headers.
  {
    const res = await request(port, { path: "/api/health", headers: { ...host, "x-pinglab-token": token } });
    status(res, 200, "GET with token");
    assertSecurityHeaders(res, "GET with token");
    const body = wantJson(res, "GET with token");
    assert.equal(body.ok, true, "GET with token: ok:true");
    assert.equal(body.port, port, "GET with token: the server reports the port it was told to use");
  }

  // ---- 5. POST: token alone is not enough. A missing or foreign Origin is refused, because
  //         a page on another site can make the browser send a form-shaped request elsewhere.
  for (const [label, extra] of [
    ["POST without Origin", {}],
    ["POST from another origin", { origin: "http://evil.example" }],
    ["POST from a look-alike origin", { origin: `http://127.0.0.1:${port + 1}` }],
  ]) {
    const res = await request(port, {
      method: "POST",
      path: "/api/soak/stop",
      headers: {
        ...host,
        "x-pinglab-token": token,
        "content-type": "application/json",
        "content-length": "2",
        ...extra,
      },
      body: "{}",
    });
    status(res, 403, label);
    assertSecurityHeaders(res, label);
    assert.match(res.text, /did not come from the PingLab page/, `${label}: the message names the reason`);
  }

  // ---- 6. A form cannot pretend to be JSON: text/plain, form encoding and no type at all
  //         are 415 even with the token and the right Origin.
  for (const [label, contentType] of [
    ["POST text/plain", "text/plain"],
    ["POST form-encoded", "application/x-www-form-urlencoded"],
    ["POST with no content type", null],
  ]) {
    const headers = { ...host, origin, "x-pinglab-token": token, "content-length": "2" };
    if (contentType) headers["content-type"] = contentType;
    const res = await request(port, { method: "POST", path: "/api/soak/stop", headers, body: "{}" });
    status(res, 415, label);
    assertSecurityHeaders(res, label);
    assert.match(res.text, /only accepts application\/json/, `${label}: the message names the requirement`);
  }

  // ---- 7. Everything right on a POST: 200 and a real JSON answer, with no soak running.
  {
    const res = await request(port, {
      method: "POST",
      path: "/api/soak/stop",
      headers: {
        ...host,
        origin,
        "x-pinglab-token": token,
        "content-type": "application/json; charset=utf-8",
        "content-length": "2",
      },
      body: "{}",
    });
    status(res, 200, "POST with token + Origin + JSON");
    assertSecurityHeaders(res, "POST with token + Origin + JSON");
    const body = wantJson(res, "POST with token + Origin + JSON");
    assert.equal(body.ok, true, "POST: ok:true");
    assert.equal(body.stopped, false, "POST: no soak was running, so nothing was stopped");
  }

  // ---- 8. A foreign Host is DNS rebinding: someone points their own domain at 127.0.0.1 to
  //         read this page, and its token, as their own origin. Refused everywhere, and the
  //         refusal must not contain the token.
  for (const [label, opts] of [
    ["foreign Host on page", { path: "/", headers: { host: "evil.example:4747" } }],
    ["foreign Host on API", { path: "/api/health", headers: { host: "evil.example:4747", "x-pinglab-token": token } }],
    ["bare Host with our port", { path: "/api/health", headers: { host: `127.0.0.1` , "x-pinglab-token": token } }],
  ]) {
    const res = await request(port, opts);
    status(res, 421, label);
    assertSecurityHeaders(res, label);
    assert.equal(res.text.includes(token), false, `${label}: must not leak the token`);
    assert.match(res.text, /only answers 127\.0\.0\.1/, `${label}: the message names the rule`);
  }

  // ---- 9. The localhost spelling a person actually types is accepted, not just the IP.
  {
    const res = await request(port, { path: "/api/health", headers: { host: `localhost:${port}`, "x-pinglab-token": token } });
    status(res, 200, "localhost Host");
  }

  // ---- 10. A static asset is served with the same headers, so the CSP travels with app.js.
  {
    const res = await request(port, { path: "/app.js", headers: host });
    status(res, 200, "static asset");
    assertSecurityHeaders(res, "static asset");
    assert.match(String(res.headers["content-type"]), /^text\/javascript/, "static asset: JS content type");
  }

  console.log("\nserver guards");
  console.log(`  server       ${SERVER} on ${base}`);
  console.log("  token        403 without it, 403 for wrong/short/long, 200 with it");
  console.log("  origin       403 without it or from another origin, 415 for non-JSON");
  console.log("  host         421 for a foreign Host, no token leaked; localhost accepted");
  console.log("  headers      CSP + nosniff + frame/referrer/COOP/CORP/permissions on page, JSON and errors");
  console.log("\nall server guard checks passed");
} finally {
  // Never leave a listening server behind, even when an assertion failed.
  if (!child.killed) child.kill();
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    setTimeout(resolve, 3000);
  });
}
