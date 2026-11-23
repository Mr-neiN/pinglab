/**
 * The HTTP surface as an attacker would walk it, route by route.
 *
 * lib/server-guards.test.mjs pins the door policy on a few endpoints (token, Origin, Host,
 * headers). This file enumerates the whole surface and treats every route as untrusted input:
 *
 *   every API route       no token, wrong token, foreign Origin, foreign Host, odd methods
 *   request bodies        malformed JSON, null, oversized, unknown action, unbounded lists
 *   values that are used  endpoint hosts/ports, latency target, soak run ids
 *   static serving        traversal attempts, dot segments, encoded slashes, NUL
 *   error paths           no internal text, and never the token - in the body or the log
 *   normal use            the same page and the same calls still work, so hardening that
 *                         breaks the app cannot pass
 *
 * It runs the real server.mjs on a spare loopback port against a throwaway data folder, so
 * the endpoint list it saves lands in temp, not in the real config.json. No setting is
 * applied and no elevation is attempted: the only tweak call uses an action that does not
 * exist, which fails before anything touches Windows.
 *
 * Each case is a check, not an abort: the run reports every failing route at once.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER = join(ROOT, "server.mjs");
const DATA_DIR = mkdtempSync(join(tmpdir(), "pinglab-api-"));

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
 * A raw HTTP request: every header, including Host and Origin, is the caller's to forge.
 * The budget is generous because /api/state reads the live machine through several PowerShell
 * processes and can take tens of seconds on a loaded machine or a cold first run; this suite
 * is about what a route answers, not how fast. Checks that assert an immediate refusal set
 * their own short timeout.
 */
function request(port, { method = "GET", path = "/", headers = {}, body, timeoutMs = 60_000 } = {}) {
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
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error(`request timed out after ${timeoutMs}ms`), { code: "ETIMEDOUT" }));
    });
    req.on("error", (err) => reject(err));
    if (body !== undefined) req.write(body);
    req.end();
  });
}

/** Bytes straight down the socket, for a request line Node's parser will reject. */
function raw(port, text) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let data = "";
    socket.setTimeout(5000, () => socket.destroy());
    socket.on("data", (chunk) => (data += chunk.toString("utf8")));
    socket.on("error", reject);
    socket.on("close", () => resolve(data));
    socket.write(text);
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const assertGuarded = (res, label) => {
  assert.equal(res.headers["access-control-allow-origin"], undefined, `${label}: no CORS grant`);
  assert.equal(res.headers["cache-control"], "no-store", `${label}: no-store`);
};

const port = await freePort();
const child = spawn(process.execPath, [SERVER], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(port), PINGLAB_DATA_DIR: DATA_DIR, PINGLAB_ELEVATION: "refuse" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
child.stdout.on("data", (b) => (serverLog += b));
child.stderr.on("data", (b) => (serverLog += b));

const base = `127.0.0.1:${port}`;
const origin = `http://127.0.0.1:${port}`;
const host = { host: base };

const API_ROUTES = [
  ["GET", "/api/state"],
  ["POST", "/api/probe"],
  ["POST", "/api/bufferbloat"],
  ["POST", "/api/dns-bench"],
  ["POST", "/api/endpoints"],
  ["POST", "/api/wifi-scan"],
  ["POST", "/api/tweak"],
  ["GET", "/api/history"],
  ["POST", "/api/soak/start"],
  ["POST", "/api/soak/stop"],
  ["GET", "/api/soak/status"],
  ["GET", "/api/soak/runs"],
  ["GET", "/api/soak/run/1"],
  ["GET", "/api/soak/compare?a=1&b=2"],
  ["POST", "/api/open-location"],
  ["GET", "/api/health"],
  ["GET", "/api/not-a-route"],
  ["POST", "/api/not-a-route"],
];

const results = [];
async function check(name, fn) {
  try {
    await fn();
    results.push({ name, error: null });
  } catch (err) {
    results.push({ name, error: err });
  }
}

const jsonBody = (value) => ({ body: JSON.stringify(value), contentType: "application/json" });

/** Token + Origin + JSON, i.e. a request the page itself could send. */
function allowed(method, path, value = {}, extra = {}) {
  return {
    method,
    path,
    headers: {
      ...host,
      origin,
      "x-pinglab-token": token,
      "content-type": "application/json",
      "content-length": String(Buffer.byteLength(JSON.stringify(value))),
      ...extra,
    },
    body: JSON.stringify(value),
  };
}

let token = "";

try {
  // ---- Start-up: the page has to come up before the sweep means anything.
  {
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const page = await request(port, { path: "/", headers: host });
        if (page.status !== 200) throw new Error(`page returned ${page.status}`);
        break;
      } catch (err) {
        if (err.code !== "ECONNREFUSED" && err.code !== "ECONNRESET") throw err;
        if (Date.now() > deadline) throw new Error(`server did not start on ${base}:\n${serverLog}`);
        await sleep(100);
      }
    }
    const page = await request(port, { path: "/", headers: host });
    token = page.text.match(/<meta name="pinglab-token" content="([^"]+)"/)?.[1] || "";
    assert.ok(token.length >= 32, "the page must carry the run's token");
  }

  // ---- 1. Every API route refuses a request with no token, and with a wrong token, before
  //         anything else can happen - including body parsing and Origin checks.
  await check("every API route rejects a missing token", async () => {
    for (const [method, path] of API_ROUTES) {
      const body = method === "POST" ? jsonBody({}) : {};
      const res = await request(port, { method, path, headers: { ...host, origin }, ...body });
      assert.equal(res.status, 403, `${method} ${path} without a token`);
      assertGuarded(res, `${method} ${path} without a token`);
      assert.equal(res.text.includes(token), false, `${method} ${path}: no token in the refusal`);
      assert.match(res.text, /Reload the page/, `${method} ${path}: the refusal says what to do`);
    }
  });

  await check("every API route rejects a wrong token", async () => {
    for (const [method, path] of API_ROUTES) {
      const body = method === "POST" ? jsonBody({}) : {};
      const res = await request(port, {
        method,
        path,
        headers: { ...host, origin, "x-pinglab-token": "x".repeat(token.length) },
        ...body,
      });
      assert.equal(res.status, 403, `${method} ${path} with a wrong token`);
      assert.equal(res.text.includes(token), false, `${method} ${path}: no token in the refusal`);
    }
  });

  // ---- 2. Every state-changing route refuses a foreign or absent Origin, and refuses a
  //         non-JSON body, whatever the body actually contains.
  await check("every POST route refuses a foreign or missing Origin", async () => {
    for (const [, path] of API_ROUTES.filter(([m]) => m === "POST")) {
      for (const [label, headers] of [
        ["no Origin", {}],
        ["evil Origin", { origin: "http://evil.example" }],
        ["look-alike Origin", { origin: `http://127.0.0.1:${port + 1}` }],
      ]) {
        const res = await request(port, {
          method: "POST",
          path,
          headers: {
            ...host,
            "x-pinglab-token": token,
            "content-type": "application/json",
            "content-length": "2",
            ...headers,
          },
          body: "{}",
        });
        assert.equal(res.status, 403, `POST ${path}, ${label}`);
        assert.match(res.text, /did not come from the PingLab page/, `POST ${path}, ${label}: reason`);
      }
    }
  });

  await check("every POST route refuses a non-JSON body type", async () => {
    for (const [, path] of API_ROUTES.filter(([m]) => m === "POST")) {
      const res = await request(port, {
        method: "POST",
        path,
        headers: { ...host, origin, "x-pinglab-token": token, "content-type": "text/plain", "content-length": "2" },
        body: "{}",
      });
      assert.equal(res.status, 415, `POST ${path} as text/plain`);
    }
  });

  // ---- 3. DNS rebinding: no route answers a foreign Host, tokened or not, and the refusal
  //         never contains the token.
  await check("every route refuses a foreign Host", async () => {
    for (const [method, path] of [...API_ROUTES, ["GET", "/"], ["GET", "/app.js"], ["GET", "/nope.js"]]) {
      for (const foreign of ["evil.example:4747", `evil.example:${port}`, "127.0.0.1"]) {
        const res = await request(port, {
          method,
          path,
          headers: {
            host: foreign,
            origin: `http://${foreign}`,
            "x-pinglab-token": token,
            ...(method === "POST" ? { "content-type": "application/json", "content-length": "2" } : {}),
          },
          ...(method === "POST" ? { body: "{}" } : {}),
        });
        assert.equal(res.status, 421, `${method} ${path} with Host ${foreign}`);
        assert.equal(res.text.includes(token), false, `${method} ${path} Host ${foreign}: no token`);
        assertGuarded(res, `${method} ${path} Host ${foreign}`);
      }
    }
  });

  // ---- 4. Methods that are not part of the API are refused after the token check.
  await check("unexpected methods are refused, not routed", async () => {
    for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "TRACE"]) {
      const res = await request(port, {
        method,
        path: "/api/health",
        headers: { ...host, "x-pinglab-token": token },
      });
      assert.equal(res.status, 405, `${method} /api/health`);
    }
  });

  // ---- 5. Static serving: no traversal, no dot segments, no NUL, and missing files are 404.
  await check("static serving cannot leave the public folder", async () => {
    const legs = [
      ["/%2e%2e/package.json", [404]],
      ["/%2e%2e/%2e%2e/server.mjs", [404]],
      ["/..%2f..%2fserver.mjs", [403]],
      ["/..%5c..%5cserver.mjs", [403]],
      // URL parsing turns \\ into / for http URLs, so this arrives as /server.mjs: a miss, not a read.
      ["/..\\..\\server.mjs", [403, 404]],
      ["/C:/Windows/win.ini", [403, 404]],
      ["/app.js%00.txt", [400, 404]],
      ["/nope.js", [404]],
    ];
    for (const [path, allowedStatuses] of legs) {
      const res = await request(port, { path, headers: host });
      assert.ok(
        allowedStatuses.includes(res.status),
        `GET ${path}: expected ${allowedStatuses.join(" or ")}, got ${res.status}`,
      );
      assert.equal(res.text.includes("root:x"), false, `GET ${path}: no file content leaked`);
      assert.equal(res.text.includes("import http"), false, `GET ${path}: no source leaked`);
    }
  });

  // ---- 6. Bodies: malformed JSON, a null document, an oversized body and an unknown action
  //         are client errors with a stable message, not a 500 with parser or runtime text.
  await check("malformed JSON is a 400 that echoes nothing", async () => {
    const body = '{"action": "nagle", "alias": ';
    const res = await request(port, {
      method: "POST",
      path: "/api/tweak",
      headers: {
        ...host,
        origin,
        "x-pinglab-token": token,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      },
      body,
    });
    assert.equal(res.status, 400, `malformed JSON: ${res.status} ${res.text.slice(0, 200)}`);
    assert.equal(res.text.includes(token), false, "malformed JSON: no token reflected");
    for (const leak of ["Unexpected", "position", "JSON at", "SyntaxError", ":\\", "node:"]) {
      assert.equal(res.text.includes(leak), false, `malformed JSON: response mentions ${leak}`);
    }
  });

  await check("a null JSON body is a 400, not a crash", async () => {
    const res = await request(port, allowed("POST", "/api/tweak", null));
    assert.equal(res.status, 400, `null body: ${res.status} ${res.text.slice(0, 200)}`);
    assert.match(res.text, /JSON object/i, "null body: the message names the requirement");
  });

  await check("an oversized body is a 413", async () => {
    const huge = `{"endpoints":"${"a".repeat(2 * 1024 * 1024 + 10)}"}`;
    const res = await request(port, {
      method: "POST",
      path: "/api/endpoints",
      headers: {
        ...host,
        origin,
        "x-pinglab-token": token,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(huge)),
      },
      body: huge,
      timeoutMs: 10_000,
    });
    assert.equal(res.status, 413, `oversized body: ${res.status} ${res.text.slice(0, 120)}`);
    assert.equal(res.text.includes("aaaa"), false, "oversized body: no body text reflected");
  });

  await check("an unknown tweak action is a 400 before any work", async () => {
    const res = await request(port, allowed("POST", "/api/tweak", { action: "not-an-action", alias: "WLAN" }));
    assert.equal(res.status, 400, `unknown action: ${res.status} ${res.text.slice(0, 160)}`);
    assert.match(res.text, /action/i, "unknown action: the message names the field");
  });

  // ---- 7. Values that reach the network or the filesystem are bounded and validated.
  await check("the endpoint list is bounded and hosts are validated", async () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ host: `10.0.0.${i}`, port: 443, kind: "game" }));
    const tooMany = await request(port, allowed("POST", "/api/endpoints", { endpoints: many }));
    assert.equal(tooMany.status, 400, `40 endpoints: ${tooMany.status}`);
    assert.match(tooMany.text, /too many/i, "40 endpoints: the message names the limit");

    for (const [label, endpoint] of [
      ["leading dash host", { host: "-f", port: 443 }],
      ["space in host", { host: "1.1.1.1 -t", port: 443 }],
      ["very long host", { host: `${"a".repeat(300)}.com`, port: 443 }],
      ["port out of range", { host: "1.1.1.1", port: 70000 }],
      ["fractional port", { host: "1.1.1.1", port: 4.5 }],
    ]) {
      const res = await request(port, allowed("POST", "/api/endpoints", { endpoints: [endpoint] }));
      assert.equal(res.status, 400, `${label}: ${res.status} ${res.text.slice(0, 120)}`);
    }
  });

  await check("the bufferbloat target and duration are validated", async () => {
    const badHost = await request(port, allowed("POST", "/api/bufferbloat", { host: "-t", seconds: 6 }));
    assert.equal(badHost.status, 400, `bufferbloat host "-t": ${badHost.status} ${badHost.text.slice(0, 120)}`);

    const tooLong = await request(port, allowed("POST", "/api/bufferbloat", { host: "1.1.1.1", seconds: 120 }), {
      timeoutMs: 4000,
    });
    assert.equal(tooLong.status, 400, `bufferbloat 120s: ${tooLong.status} ${tooLong.text.slice(0, 120)}`);

    const zero = await request(port, allowed("POST", "/api/bufferbloat", { host: "1.1.1.1", seconds: 0 }), {
      timeoutMs: 4000,
    });
    assert.equal(zero.status, 400, `bufferbloat 0s: ${zero.status} ${zero.text.slice(0, 120)}`);
  });

  // ---- 8. Error paths must never carry the token, in the response or in the server's log.
  await check("a failing body cannot leak the token into the response or the log", async () => {
    const body = `{"action": "${token}" "alias": "x"}`;
    const res = await request(port, {
      method: "POST",
      path: "/api/tweak",
      headers: {
        ...host,
        origin,
        "x-pinglab-token": token,
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(body)),
      },
      body,
    });
    assert.equal(res.status, 400, `token-in-body: ${res.status}`);
    assert.equal(res.text.includes(token), false, "token-in-body: the response echoed the token");
    await sleep(300);
    assert.equal(serverLog.includes(token), false, `token-in-body: the server log contains the token:\n${serverLog.slice(-400)}`);
  });

  // ---- 9. A malformed request line is answered by the app, with the same headers and no echo.
  await check("a malformed request line is a guarded 400", async () => {
    const text = await raw(port, "GARBAGE / HTTP/9.9\r\nHost: nope\r\n\r\n");
    assert.match(text, /^HTTP\/1\.[01] 400/, `raw garbage: ${JSON.stringify(text.slice(0, 120))}`);
    assert.equal(text.includes(token), false, "raw garbage: no token");
    assert.match(text, /Content-Security-Policy:/i, "raw garbage: the app's headers still apply");
  });

  // ---- 10. Normal use still works, so the hardening cannot pass by breaking the app.
  await check("the page, its assets and its API still work", async () => {
    const page = await request(port, { path: "/", headers: host });
    assert.equal(page.status, 200, "page");
    assert.match(page.text, /pinglab-token/, "page: token still injected");

    const js = await request(port, { path: "/app.js", headers: host });
    assert.equal(js.status, 200, "app.js");
    assert.match(String(js.headers["content-type"]), /^text\/javascript/, "app.js: content type");

    const health = await request(port, { path: "/api/health", headers: { ...host, "x-pinglab-token": token } });
    assert.equal(health.status, 200, "health");
    assert.equal(JSON.parse(health.text).port, port, "health: the port we asked for");

    const state = await request(port, {
      path: "/api/state",
      headers: { ...host, "x-pinglab-token": token },
      timeoutMs: 60_000,
    });
    assert.equal(state.status, 200, `state: ${state.text.slice(0, 200)}`);
    const parsed = JSON.parse(state.text);
    assert.ok(parsed.catalog?.tweaks?.length, "state: the catalog travels");

    const localhost = await request(port, {
      path: "/api/health",
      headers: { host: `localhost:${port}`, "x-pinglab-token": token },
    });
    assert.equal(localhost.status, 200, "localhost Host is accepted");

    const stopped = await request(port, allowed("POST", "/api/soak/stop", {}));
    assert.equal(stopped.status, 200, `soak/stop: ${stopped.text.slice(0, 200)}`);
    assert.equal(JSON.parse(stopped.text).stopped, false, "soak/stop: nothing was running");

    const valid = [
      { id: "one", label: "1.1.1.1", host: "1.1.1.1", port: 443, kind: "game" },
      { id: "two", label: "IPv6", host: "2606:4700:4700::1111", port: 53, kind: "dns" },
    ];
    const saved = await request(port, allowed("POST", "/api/endpoints", { endpoints: valid }));
    assert.equal(saved.status, 200, `endpoints save: ${saved.text.slice(0, 200)}`);
    assert.equal(JSON.parse(saved.text).endpoints.length, 2, "endpoints save: both kept");

    const after = await request(port, { path: "/api/state", headers: { ...host, "x-pinglab-token": token } });
    assert.equal(JSON.parse(after.text).endpoints.length, 2, "endpoints save: persisted");
  });

  // ---- 11. Nothing in the hostile sweep started work: no soak, and only the two endpoints.
  await check("the hostile requests changed no state", async () => {
    const status = await request(port, { path: "/api/soak/status", headers: { ...host, "x-pinglab-token": token } });
    assert.equal(status.status, 200, "soak status");
    assert.equal(JSON.parse(status.text).running, false, "no soak was started by a hostile body");
  });
} finally {
  if (!child.killed) child.kill();
  await new Promise((resolve) => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    setTimeout(resolve, 3000);
  });
  rmSync(DATA_DIR, { recursive: true, force: true });
}

/* --------------------------------------------------------------------- report */

const failed = results.filter((r) => r.error);
for (const r of results) {
  if (!r.error) continue;
  console.log(`  FAIL ${r.name}`);
  console.log(`       ${String(r.error.message).split("\n").join("\n       ")}`);
}
console.log("\napi hardening");
console.log(`  cases        ${results.length} (${results.length - failed.length} passed, ${failed.length} failed)`);
console.log("  routes       every API route: token, Origin, JSON type, Host, methods, unknown paths");
console.log("  bodies       malformed, null, oversized, unknown action, unbounded lists and ports");
console.log("  static       dot segments, encoded slashes, NUL, absolute paths: never leaves public");
console.log("  leaks        no token or parser text in a refusal, an error body, or the server log");
console.log("  normal use   page, app.js, health, state, soak/stop and saving endpoints still work");
if (failed.length) {
  throw new Error(`${failed.length} api-hardening check(s) failed`);
}
console.log("\nall api hardening checks passed");
