import http from "node:http";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, extname, normalize, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { runProbe, summarizeProbe, bufferbloat } from "./lib/probe.mjs";
import { benchmark as dnsBenchmark, RESOLVERS } from "./lib/dns.mjs";
import { snapshot, wifi, dnsServers, routes } from "./lib/net.mjs";
import { analyseWifi, wifiAdvice, scanWifi } from "./lib/wifi.mjs";
import { dnsWinner, dnsVerdict, bloatVerdict, transportText, scanFreshnessText } from "./lib/report.mjs";
import { tweakState, runTweakAction, tweakOutcome, pendingTweaks, applyPreset, knownActions } from "./lib/tweaks.mjs";
import { driftStatus } from "./lib/drift.mjs";
import { createStateCache } from "./lib/state-cache.mjs";
import { TWEAKS, PRESETS, RISK, presetById } from "./lib/catalog.mjs";
import { loadConfig, saveConfig } from "./lib/config.mjs";
import { saveRun, listRuns, saveTweak, listTweaks, previousRun, dbStatus } from "./lib/db.mjs";
import { startSoak, stopSoak, soakStatus, listSoakRuns, getSoakRun, compareSoaks, soakLabel } from "./lib/soak.mjs";
import { openTarget } from "./lib/ps.mjs";
import {
  HttpError,
  refuse,
  bodyObject,
  bufferbloatRequest,
  endpointList,
  soakRequest,
  tweakRequest,
  pathId,
} from "./lib/api-input.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const requestedPort = Number(process.env.PORT);
const PORT =
  Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65536 ? requestedPort : 4747;

/**
 * How long a state read may be reused. Reads are driven by PowerShell and cost seconds; the
 * settings they describe change only when someone acts. Five seconds is short enough that an
 * outside change is echoed on the next refresh, and long enough that a page's own re-reads do
 * not each launch seven processes. After that the old value is still served once while a
 * background read refreshes it; only beyond the stale limit does a request wait for a read.
 */
const requestedTtl = Number(process.env.PINGLAB_STATE_TTL_MS);
const STATE_TTL_MS = Number.isFinite(requestedTtl) && requestedTtl >= 0 ? requestedTtl : 5000;
const requestedMaxStale = Number(process.env.PINGLAB_STATE_MAX_STALE_MS);
const STATE_MAX_STALE_MS =
  Number.isFinite(requestedMaxStale) && requestedMaxStale >= STATE_TTL_MS ? requestedMaxStale : 120000;

/**
 * One token per server run. index.html is served with it in a <meta> tag, the page sends it
 * back on every API call, and nothing else knows it: a script on another origin cannot read
 * this page (no CORS, same-origin policy), so it cannot learn the token. A tab left open
 * across a restart gets a 403 that says to reload instead of driving a server it no longer
 * belongs to.
 */
const TOKEN = randomBytes(32).toString("base64url");
const TOKEN_HEADER = "x-pinglab-token";

/** The only names this server answers to. Anything else is DNS rebinding. */
const HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`]);
const ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`, `http://[::1]:${PORT}`]);

/** Never let the run's token reach a log line, even inside an error message. */
function redact(value) {
  return String(value).split(TOKEN).join("[token]");
}

/** Headers every response carries, static files and JSON alike. */
function securityHeaders(contentType) {
  return {
    ...(contentType ? { "Content-Type": contentType } : {}),
    "Cache-Control": "no-store",
    // The page needs no inline script and loads nothing from another origin. Inline style
    // attributes are how the bar widths are drawn, so styles alone allow them.
    "Content-Security-Policy":
      "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
  };
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    ...securityHeaders("application/json; charset=utf-8"),
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, securityHeaders("text/plain; charset=utf-8"));
  res.end(text);
}

function fail(res, status, error) {
  sendJson(res, status, { ok: false, error });
}

/** Constant-time comparison, so the token cannot be guessed a character at a time. */
function tokenMatches(req) {
  const given = req.headers[TOKEN_HEADER];
  if (typeof given !== "string" || given.length !== TOKEN.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(TOKEN));
}

/** A state-changing request has to be JSON, which is what a form post cannot send. */
function isJson(req) {
  return String(req.headers["content-type"] || "").toLowerCase().split(";")[0].trim() === "application/json";
}

/**
 * Read a JSON object, or refuse it. Every failure here is the caller's, so it carries a
 * status and a fixed sentence: a parser message quotes the input it could not read, and an
 * error body is the last place a request's contents should appear.
 */
async function readJson(req, { limit = 2 * 1024 * 1024 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, "The request body is larger than 2 MB.");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  let parsed;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "The request body is not valid JSON.");
  }
  return bodyObject(parsed);
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
};

async function serveStatic(res, urlPath) {
  const rel = normalize(urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, ""));
  if (rel.includes("..") || isAbsolute(rel)) return sendText(res, 403, "Forbidden");
  const file = join(PUBLIC_DIR, rel);
  // The joined path must still sit under public/. The check above refuses dot segments; this
  // refuses anything the platform might interpret differently (a drive, a UNC share).
  const back = relative(PUBLIC_DIR, file);
  if (back.startsWith("..") || isAbsolute(back)) return sendText(res, 403, "Forbidden");
  try {
    const data = await readFile(file);
    if (rel === "index.html") {
      // The page learns the token here and nowhere else; nothing else is injected.
      const html = data.toString("utf8");
      const tagged = html.includes("</head>")
        ? html.replace("</head>", `    <meta name="pinglab-token" content="${TOKEN}" />\n  </head>`)
        : html;
      res.writeHead(200, securityHeaders(MIME[".html"]));
      res.end(tagged);
      return;
    }
    res.writeHead(200, securityHeaders(MIME[extname(file).toLowerCase()] || "application/octet-stream"));
    res.end(data);
  } catch {
    sendText(res, 404, "Not found");
  }
}

/**
 * Everything GET /api/state answers with, assembled once. The cache owns when it is called;
 * keeping the assembly here means the route and any test see the same shape.
 */
async function buildState() {
  const config = await loadConfig();
  const connection = await snapshot();
  const alias = connection.activeRoute?.alias || null;
  const [tw, tweaks] = await Promise.all([
    alias ? tweakState(alias, { dns: connection.dns }) : Promise.resolve(null),
    Promise.resolve(pendingTweaks()),
  ]);
  return {
    connection,
    tweakState: tw,
    pending: tweaks,
    // A change PingLab made that Windows has since put back travels with the state, so the
    // page can say it above the rows instead of leaving it to be noticed.
    drift: driftStatus(tw),
    // A database that had to be set aside during start-up is not a silent reset: the page
    // says so above the verdict, the way the GUI says it in its status row.
    history: dbStatus(),
    endpoints: config.endpoints,
    resolvers: RESOLVERS,
    recentRuns: listRuns(null, 12),
    // Same catalog the TUI and the GUI render, so labels, trade-offs, risk levels and
    // preset contents cannot differ between surfaces.
    catalog: { tweaks: TWEAKS, presets: PRESETS, risk: RISK },
  };
}

const stateCache = createStateCache({
  load: buildState,
  ttlMs: STATE_TTL_MS,
  maxStaleMs: STATE_MAX_STALE_MS,
  onError: (err) => console.error("[pinglab] state refresh failed:", redact(err?.message || err)),
});

const server = http.createServer(async (req, res) => {
  // A Host that is not one of this machine's loopback names means someone pointed their own
  // domain at 127.0.0.1 to read the page (and its token) as their own origin. Refuse before
  // anything is served.
  if (!HOSTS.has(String(req.headers.host || "").toLowerCase())) {
    return sendText(res, 421, "Misdirected request: this server only answers 127.0.0.1.");
  }

  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const path = url.pathname;

  if (!path.startsWith("/api/")) {
    if (req.method === "GET") return serveStatic(res, path);
    return sendText(res, 405, "Method not allowed");
  }

  // Every API call has to come from this run's page: it holds the token, a form post from
  // another site does not, and a same-origin fetch is the only way to present it.
  if (!tokenMatches(req)) {
    return fail(res, 403, "This server only answers the PingLab page it just served. Reload the page and try again.");
  }
  if (req.method !== "GET" && req.method !== "POST") {
    return fail(res, 405, "Method not allowed");
  }
  if (req.method === "POST") {
    // Same-origin check first: a browser sends Origin on every POST, so its absence or a
    // foreign value means the request did not come from the page.
    if (!ORIGINS.has(String(req.headers.origin || "").toLowerCase())) {
      return fail(res, 403, "Refused: the request did not come from the PingLab page.");
    }
    if (!isJson(req)) {
      return fail(res, 415, "Refused: this endpoint only accepts application/json request bodies.");
    }
  }

  try {
    if (req.method === "GET" && path === "/api/state") {
      return sendJson(res, 200, await stateCache.get());
    }

    if (req.method === "POST" && path === "/api/probe") {
      const body = await readJson(req);
      if (body.endpointIds !== undefined && !Array.isArray(body.endpointIds)) {
        throw refuse("endpointIds must be a list of endpoint ids.");
      }
      if (Array.isArray(body.endpointIds) && body.endpointIds.length > 25) {
        throw refuse("Too many endpointIds (the limit is 25).");
      }
      const config = await loadConfig();
      const wanted = Array.isArray(body.endpointIds)
        ? body.endpointIds.filter((id) => typeof id === "string")
        : [];
      const selected = wanted.length
        ? config.endpoints.filter((e) => wanted.includes(e.id))
        : config.endpoints;
      const probe = await runProbe(selected);
      const summary = summarizeProbe(probe);
      const id = saveRun("probe", `avg ${summary.gameAvgMs ?? "?"} ms, loss ${summary.gameLoss ?? "?"}%`, {
        ...probe,
        summary,
      });
      // recentRuns travels with the state, so a new run makes the cached copy incomplete.
      stateCache.invalidate();
      return sendJson(res, 200, {
        ok: true,
        runId: id,
        ...probe,
        summary,
        // The TCP-versus-ICMP sentence is computed once, from the summary every surface
        // already receives, rather than assembled again on the page.
        transport: transportText(summary.transport),
        previous: previousRun("probe"),
      });
    }

    if (req.method === "POST" && path === "/api/bufferbloat") {
      const body = bufferbloatRequest(await readJson(req));
      const measured = await bufferbloat({ host: body.host, seconds: body.seconds, direction: body.direction });
      // The verdict and both direction grades travel with the result, so the page, the
      // terminal and the GUI print the same sentence from the same measured object.
      const result = { ...measured, verdict: bloatVerdict(measured) };
      const label =
        measured.mode === "both" || measured.mode === "duplex"
          ? `grade ${measured.overallGrade} (down ${measured.download?.grade ?? "n/a"}, up ${measured.upload?.grade ?? "n/a"})`
          : `${measured.download ? "download" : "upload"} grade ${measured.overallGrade}`;
      const id = saveRun("bufferbloat", label, result);
      stateCache.invalidate();
      return sendJson(res, 200, { ok: result.ok, runId: id, result, previous: previousRun("bufferbloat") });
    }

    if (req.method === "POST" && path === "/api/dns-bench") {
      const measured = await dnsBenchmark();
      // One verdict, one winner selector, shared with the terminal and the GUI, so the page
      // cannot offer a resolver the rule refused (or hide one it accepted).
      const result = { ...measured, verdict: dnsVerdict(measured), winner: dnsWinner(measured) };
      const current = (await dnsServers()).find((d) => d.servers?.length) || null;
      const id = saveRun("dns", result.bestLabel ? `fastest ${result.bestLabel}` : "no clear winner", result);
      stateCache.invalidate();
      return sendJson(res, 200, { ok: true, runId: id, result, current });
    }

    if (req.method === "POST" && path === "/api/endpoints") {
      const body = await readJson(req);
      const endpoints = endpointList(body.endpoints);
      const config = await loadConfig();
      await saveConfig({ ...config, endpoints });
      // The endpoint list is part of the state the page renders.
      stateCache.invalidate();
      return sendJson(res, 200, { ok: true, endpoints });
    }

    if (req.method === "POST" && path === "/api/wifi-scan") {
      // The same scan the terminal and the GUI read. The engine asks Windows to scan and waits
      // for the completion notice; the page gets that sentence from the same function the
      // other surfaces print, so no surface can claim more (or less) than the shim confirmed.
      const scan = await scanWifi();
      let advice = [];
      if (scan?.ok) {
        try {
          const link = await wifi();
          advice = wifiAdvice(analyseWifi(scan, link || {}), link || {}, scan);
        } catch {
          advice = [];
        }
      }
      return sendJson(res, 200, { ok: scan.ok, scan, advice, freshnessText: scanFreshnessText(scan.freshness) });
    }

    if (req.method === "POST" && path === "/api/tweak") {
      const { action, alias, preset, servers } = tweakRequest(await readJson(req));
      if (action === "apply-preset") {
        if (!preset || !presetById(preset)) throw refuse("preset must be one of PingLab's presets.");
      } else if (!knownActions().has(action)) {
        throw refuse("action is not one of PingLab's settings.");
      }

      let result;
      try {
        result =
          action === "apply-preset"
            ? await applyPreset(alias, preset)
            : await runTweakAction(alias, action, { servers: servers ?? undefined });
      } catch {
        // runTweakAction reports its own outcomes; a throw here is not something the page
        // can act on, and its text is ours, not the caller's.
        return sendJson(res, 400, { ok: false, error: "That setting could not be started." });
      }
      if (result.ok) saveTweak(action, { alias, servers, preset, data: result.data ?? null });
      // Every attempt can have recorded a restore point or partially changed a setting, and a
      // successful one has changed the very rows the cached state reports. Drop it before the
      // response, so the page's next state read cannot be served the pre-click answer.
      stateCache.invalidate();
      const tw = await tweakState(alias);
      // "This adapter cannot do that" and a closed UAC prompt are expected outcomes, not
      // server errors; only a real failure is a 500.
      const status = result.ok ? 200 : result.cancelled || result.unsupported ? 409 : 500;
      return sendJson(res, status, {
        ok: Boolean(result.ok),
        cancelled: Boolean(result.cancelled),
        unsupported: Boolean(result.unsupported),
        message: tweakOutcome(result).message,
        data: result.data ?? null,
        tweakState: tw,
        pending: pendingTweaks(),
      });
    }

    if (req.method === "GET" && path === "/api/history") {
      return sendJson(res, 200, { runs: listRuns(null, 40), tweaks: listTweaks(20) });
    }

    if (req.method === "POST" && path === "/api/soak/start") {
      const { seconds, intervalMs } = soakRequest(await readJson(req));
      if (soakStatus().running) return sendJson(res, 409, { ok: false, error: "A soak test is already running." });
      // Record which settings were live, so a later comparison cannot be misread.
      const alias = (await routes())[0]?.alias || null;
      const tw = alias ? await tweakState(alias) : null;
      const label = soakLabel(tw);
      const started = await startSoak({ seconds, intervalMs, label });
      stateCache.invalidate();
      return sendJson(res, 200, { ok: true, ...started });
    }

    if (req.method === "POST" && path === "/api/soak/stop") {
      const stopped = stopSoak();
      stateCache.invalidate();
      return sendJson(res, 200, { ok: true, ...stopped });
    }

    if (req.method === "GET" && path === "/api/soak/status") {
      return sendJson(res, 200, { ok: true, ...soakStatus() });
    }

    if (req.method === "GET" && path === "/api/soak/runs") {
      const runs = listSoakRuns(10);
      return sendJson(res, 200, { ok: true, runs, latest: runs[0] ?? null, previous: runs[1] ?? null });
    }

    if (req.method === "GET" && path.startsWith("/api/soak/run/")) {
      const id = pathId(path, "/api/soak/run/");
      if (id === null) return sendJson(res, 404, { ok: false, error: "No such soak run" });
      const run = getSoakRun(id);
      if (!run) return sendJson(res, 404, { ok: false, error: "No such soak run" });
      return sendJson(res, 200, { ok: true, run });
    }

    if (req.method === "GET" && path === "/api/soak/compare") {
      const a = url.searchParams.get("a") || "";
      const b = url.searchParams.get("b") || "";
      if (!/^\d{1,12}$/.test(a) || !/^\d{1,12}$/.test(b)) {
        return sendJson(res, 400, { ok: false, error: "Comparing soaks needs two run ids." });
      }
      const cmp = compareSoaks(Number(a), Number(b));
      if (!cmp) return sendJson(res, 404, { ok: false, error: "Both soak runs need a stored summary" });
      return sendJson(res, 200, { ok: true, ...cmp });
    }

    if (req.method === "POST" && path === "/api/open-location") {
      const r = await openTarget("ms-settings:privacy-location");
      return sendJson(res, 200, { ok: r.ok, message: r.ok ? "Opened Windows Location settings" : r.error });
    }

    if (req.method === "GET" && path === "/api/health") {
      return sendJson(res, 200, { ok: true, port: PORT, uptime: Math.round(process.uptime()) });
    }

    return sendJson(res, 404, { ok: false, error: "Unknown endpoint" });
  } catch (err) {
    // A refusal names the field it rejected and is safe to show. Anything else is ours: the
    // log gets it (with the token redacted), the page gets a sentence without internals.
    if (err instanceof HttpError) return fail(res, err.status, err.message);
    console.error("[pinglab]", redact(err?.stack || err));
    return fail(
      res,
      500,
      "PingLab hit an internal error while handling that request. The terminal running PingLab has the details.",
    );
  }
});

/**
 * Requests Node's parser rejects never reach the handler above, and Node's default 400
 * carries none of this app's headers. Answer them the same way, without echoing the request.
 */
server.on("clientError", (err, socket) => {
  if (err?.code === "ECONNRESET" || !socket.writable) return socket.destroy();
  const body = JSON.stringify({ ok: false, error: "Bad request" });
  const lines = Object.entries({
    ...securityHeaders("application/json; charset=utf-8"),
    "Content-Length": Buffer.byteLength(body),
    Connection: "close",
  }).map(([name, value]) => `${name}: ${value}`);
  socket.end(`HTTP/1.1 400 Bad Request\r\n${lines.join("\r\n")}\r\n\r\n${body}`);
});

// A small JSON body may not hold a connection open indefinitely.
server.headersTimeout = 15000;
server.requestTimeout = 30000;

server.listen(PORT, "127.0.0.1", () => {
  console.log(`PingLab running at http://127.0.0.1:${PORT}`);
});
