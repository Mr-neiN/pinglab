import http from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, extname, normalize, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { runProbe, summarizeProbe, bufferbloat } from "./lib/probe.mjs";
import {
  BENCH,
  analysePhase,
  baselineExpired,
  benchParams,
  benchSentence,
  compareBenchmark,
  paramsKey,
  revertSentence,
} from "./lib/bench.mjs";
import { benchmark as dnsBenchmark, RESOLVERS } from "./lib/dns.mjs";
import { snapshot, adapters, wifi, dnsServers, routes } from "./lib/net.mjs";
import { analyseWifi, wifiAdvice, scanWifi } from "./lib/wifi.mjs";
import { dnsWinner, dnsVerdict, bloatVerdict, transportText, udpText, scanFreshnessText } from "./lib/report.mjs";
import { tweakState, runTweakAction, tweakOutcome, pendingTweaks, applyPreset, knownActions, actionSpec } from "./lib/tweaks.mjs";
import { driftStatus } from "./lib/drift.mjs";
import { probeTrend } from "./lib/trend.mjs";
import { createStateCache } from "./lib/state-cache.mjs";
import { checkForUpdate, currentVersion } from "./lib/update.mjs";
import { UDP_PROTOCOLS } from "./lib/udp-proto.mjs";
import { TWEAKS, PRESETS, RISK, presetById, tweakById } from "./lib/catalog.mjs";
import { loadConfig, saveConfig, saveAdapter } from "./lib/config.mjs";
import { adapterChoices } from "./lib/target.mjs";
import { saveRun, listRuns, saveTweak, listTweaks, previousRun, dbStatus, getRun } from "./lib/db.mjs";
import { startSoak, stopSoak, soakStatus, listSoakRuns, getSoakRun, compareSoaks, soakLabel } from "./lib/soak.mjs";
import { openTarget } from "./lib/ps.mjs";
import {
  HttpError,
  refuse,
  bodyObject,
  adapterRequest,
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
  // Which adapter the settings are aimed at is a persisted choice, not an inference: the rows,
  // the restore points and every apply read the same answer, so a docked laptop or a VPN cannot
  // have one surface tuning Wi-Fi while another says it is tuning Ethernet.
  const pick = adapterChoices({
    adapters: connection.adapters,
    routes: connection.routes,
    activeRoute: connection.activeRoute,
    chosen: config.adapter,
  });
  const alias = pick.target?.alias || null;
  const dnsForTarget = alias ? connection.dns.find((d) => d.alias === alias) || null : null;
  const [tw, tweaks] = await Promise.all([
    alias ? tweakState(alias, { dns: connection.dns }) : Promise.resolve(null),
    Promise.resolve(pendingTweaks()),
  ]);
  return {
    // The version this copy actually runs as, read from package.json beside it. The page shows
    // it, so a copy that was upgraded (or one that was not) is visible instead of inferred,
    // and it is the same value the update check compares against the newest release.
    version: currentVersion(),
    // The benchmark policy, so a surface can say how many repeats a phase takes without
    // keeping a second copy of the number that can drift from lib/bench.mjs.
    benchPolicy: benchPolicy(),
    connection: { ...connection, dnsForTarget },
    // The adapter every setting below is read from and written to, and the list a picker may
    // offer. The default route is marked on it; a virtual adapter is offered but never picked
    // on its own (lib/target.mjs), and `fallback` explains a remembered adapter that is gone.
    target: pick.target,
    adapterChoices: pick.choices,
    targetFallback: pick.fallback,
    tweakState: tw,
    pending: tweaks,
    // A change PingLab made that Windows has since put back travels with the state, so the
    // page can say it above the rows instead of leaving it to be noticed.
    drift: driftStatus(tw),
    // A database that had to be set aside during start-up is not a silent reset: the page
    // says so above the verdict, the way the GUI says it in its status row.
    history: dbStatus(),
    // A settings file that could not be used is reported the same way, once, in the state
    // every surface draws: the page above the verdict, the GUI in its status row.
    config: { problem: config.problem },
    endpoints: config.endpoints,
    resolvers: RESOLVERS,
    recentRuns: listRuns(null, 12),
    // Long-term latency and jitter from the stored probe runs - the same history the page's
    // "previous run" figure comes from, read back as a series instead of one comparison.
    trend: probeTrend(listRuns("probe", 60)),
    // The last comparison and the last rollback travel with the state, so the GUI and the
    // terminal print the same words the page shows rather than only a history row.
    benchmark: {
      latest: listRuns("benchmark", 1)[0] ?? null,
      lastRevert: listRuns("benchmark-revert", 1)[0] ?? null,
    },
    // Same catalog the TUI and the GUI render, so labels, trade-offs, risk levels and
    // preset contents cannot differ between surfaces.
    catalog: { tweaks: TWEAKS, presets: PRESETS, risk: RISK },
    // The UDP queries an endpoint may name, from the engine's own registry: the page's editor
    // cannot offer a protocol the server would refuse, or miss one it accepts.
    protocols: Object.values(UDP_PROTOCOLS).map(({ id, label, describe }) => ({ id, label, describe })),
  };
}

const stateCache = createStateCache({
  load: buildState,
  ttlMs: STATE_TTL_MS,
  maxStaleMs: STATE_MAX_STALE_MS,
  onError: (err) => console.error("[pinglab] state refresh failed:", redact(err?.message || err)),
});

/* ------------------------------------------------- before/after benchmarking */

/**
 * Two measurements with exactly one change between them, split into two requests on purpose:
 * the person chooses the change, and the server never applies a setting on its own. Only one
 * baseline is pending at a time, because "which before does this after belong to" has to have
 * one answer; a second capture replaces it and says so.
 */
let benchmarkPending = null;

/** One phase: `BENCH.repeats` full probes with the same endpoints and sample count. */
async function measurePhase(endpoints) {
  const runs = [];
  for (let i = 0; i < BENCH.repeats; i += 1) {
    const probe = await runProbe(endpoints, { count: BENCH.count });
    // The UDP rows are kept with the TCP ones: lib/bench.mjs compares whichever transport
    // answered in every repeat, and refuses a comparison that switched between the two.
    runs.push({
      at: new Date().toISOString(),
      results: probe.results,
      udp: probe.udp,
      summary: summarizeProbe(probe),
    });
  }
  return runs;
}

const benchPolicy = () => ({
  repeats: BENCH.repeats,
  minRepeats: BENCH.minRepeats,
  count: BENCH.count,
  floors: BENCH.floors,
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
      // The update answer is merged at send time rather than inside buildState: it is not a
      // machine reading, and it can arrive after the state snapshot it would be cached in.
      return sendJson(res, 200, { ...(await stateCache.get()), update });
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
        // Same rule for UDP: the sentence is computed once from the summary, so no surface
        // can turn silence or a closed port into a latency or loss figure of its own.
        udpNote: udpText(summary.udp),
        previous: previousRun("probe"),
      });
    }

    if (req.method === "GET" && path === "/api/trend") {
      // The stored probe history read as a series, so the page can update its long-term line
      // after a run without paying for a full state read (which asks Windows for everything).
      return sendJson(res, 200, { ok: true, trend: probeTrend(listRuns("probe", 60)) });
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
      // Read before writing. If the file this replaces could not be used, its reason and the
      // name of the copy made from it ride back with this save instead of being replaced
      // without a word - the silent overwrite that used to lose a hand-edited file.
      const previous = await loadConfig();
      await saveConfig({ endpoints });
      // The endpoint list is part of the state the page renders.
      stateCache.invalidate();
      return sendJson(res, 200, { ok: true, endpoints, previousProblem: previous.problem });
    }

    if (req.method === "GET" && path === "/api/benchmark") {
      // The pending baseline and the stored comparisons, so a page reload can pick the workflow
      // up and an old comparison can be read again without repeating the measurements.
      const pending = benchmarkPending
        ? {
            id: benchmarkPending.id,
            tweak: benchmarkPending.tweak,
            label: benchmarkPending.label,
            at: benchmarkPending.at,
            params: benchmarkPending.params,
            baseline: analysePhase(benchmarkPending.before),
          }
        : null;
      return sendJson(res, 200, {
        ok: true,
        pending,
        latest: listRuns("benchmark", 1)[0] ?? null,
        recent: listRuns("benchmark", 5),
        reverts: listRuns("benchmark-revert", 3),
        policy: benchPolicy(),
      });
    }

    if (req.method === "POST" && path === "/api/benchmark/baseline") {
      const body = bodyObject(await readJson(req));
      const tweakId = typeof body.tweak === "string" ? body.tweak : "";
      const entry = tweakById(tweakId);
      if (!entry) throw refuse("tweak must be one of PingLab's settings.");
      // DNS changes lookup time, which this probe does not measure (it times handshakes and
      // UDP to an already-resolved host). Claiming a verdict on it would be a lie, so the
      // request is refused instead of measured and dismissed as noise.
      if (tweakId === "dns") {
        throw refuse("DNS has its own benchmark. This probe times handshakes and UDP, not lookups, so it cannot judge a resolver change.");
      }

      const config = await loadConfig();
      const params = benchParams(config.endpoints, { repeats: BENCH.repeats, count: BENCH.count });
      const before = await measurePhase(config.endpoints);
      benchmarkPending = {
        id: randomUUID(),
        tweak: tweakId,
        label: entry.label,
        alias: (await routes())[0]?.alias || null,
        at: new Date().toISOString(),
        startedAt: Date.now(),
        params,
        before,
        // How many changes PingLab had recorded when the baseline was taken: the finish step
        // requires exactly one more, so a second tweak cannot be folded into the result.
        tweakMark: listTweaks(1)[0]?.id ?? 0,
      };
      return sendJson(res, 200, {
        ok: true,
        id: benchmarkPending.id,
        tweak: tweakId,
        label: entry.label,
        applyAction: entry.actions.apply,
        params,
        baseline: analysePhase(before),
        policy: benchPolicy(),
      });
    }

    if (req.method === "POST" && path === "/api/benchmark/finish") {
      const body = bodyObject(await readJson(req));
      const pending = benchmarkPending;
      if (!pending) {
        return sendJson(res, 409, { ok: false, error: "There is no baseline to compare. Capture one before changing anything." });
      }
      if (body.id !== pending.id) {
        return sendJson(res, 409, {
          ok: false,
          error: "That baseline is no longer the active one, so this measurement would be compared with a different before-run.",
        });
      }
      if (body.tweak !== pending.tweak) {
        return sendJson(res, 409, { ok: false, error: "The measurement belongs to a different setting than the one benchmarked." });
      }
      if (baselineExpired(pending.startedAt)) {
        return sendJson(res, 409, {
          ok: false,
          error: `The baseline was taken more than ${Math.round(BENCH.maxAgeMs / 60000)} minutes ago, so the line may no longer be in the same condition. Capture a fresh baseline.`,
        });
      }

      const config = await loadConfig();
      const current = benchParams(config.endpoints, { repeats: BENCH.repeats, count: BENCH.count });
      if (paramsKey(current) !== paramsKey(pending.params)) {
        return sendJson(res, 409, {
          ok: false,
          error: "The endpoint list changed since the baseline, so the two runs would not measure the same targets. Capture a new baseline.",
        });
      }

      const changes = listTweaks(50).filter((t) => t.id > pending.tweakMark);
      if (changes.length !== 1) {
        return sendJson(res, 409, {
          ok: false,
          error:
            changes.length === 0
              ? "Nothing was changed between the two measurements. Apply exactly one setting, then measure again."
              : `${changes.length} settings were changed between the measurements, so a difference could not be attributed to one of them. Capture a new baseline and change exactly one setting.`,
        });
      }
      const applied = changes[0];
      const spec = actionSpec(applied.action);
      if (spec.mode !== "apply" || spec.id !== pending.tweak) {
        return sendJson(res, 409, {
          ok: false,
          error: `The change recorded since the baseline was "${applied.action}", not the apply step of ${pending.label}.`,
        });
      }

      const after = await measurePhase(config.endpoints);
      const result = compareBenchmark({
        before: pending.before,
        after,
        beforeParams: pending.params,
        afterParams: current,
      });
      const sentence = benchSentence(result, { label: pending.label });
      const id = saveRun("benchmark", sentence, {
        tweak: pending.tweak,
        label: pending.label,
        alias: pending.alias,
        params: pending.params,
        before: pending.before,
        after,
        result,
        baselineAt: pending.at,
        finishedAt: new Date().toISOString(),
      });
      benchmarkPending = null;
      stateCache.invalidate();
      return sendJson(res, 200, {
        ok: true,
        id,
        tweak: pending.tweak,
        label: pending.label,
        result,
        sentence,
        revertAction: tweakById(pending.tweak)?.actions?.revert ?? null,
        policy: benchPolicy(),
      });
    }

    if (req.method === "POST" && path === "/api/benchmark/revert") {
      const body = bodyObject(await readJson(req));
      // The approval is this flag, sent only after the person confirms in the page. No code path
      // rolls a setting back because a comparison happened to regress.
      if (body.approve !== true) throw refuse("Rolling back a setting needs an explicit approval.");
      const id = Number(body.id);
      if (!Number.isInteger(id) || id <= 0) throw refuse("id must be the recorded comparison to roll back.");
      const run = getRun(id);
      if (!run || run.kind !== "benchmark") return sendJson(res, 404, { ok: false, error: "No such comparison." });

      const tweakId = run.data?.tweak;
      const entry = tweakById(tweakId);
      const revertAction = entry?.actions?.revert;
      if (!revertAction) throw refuse("That comparison has no setting to roll back.");
      const alias = run.data?.alias || (await routes())[0]?.alias || null;

      // The same dispatch table every other undo uses, so the restore point, the read-back and
      // the sentence are the ones the GUI and the terminal already show for that setting.
      const outcome = await runTweakAction(alias, revertAction);
      const message = tweakOutcome(outcome).message;
      const restored = Boolean(outcome.ok);
      const pending = pendingTweaks();
      // One sentence for every surface: what happened, and what is still not back the way it
      // was. The count includes this setting when the rollback failed, which is exactly what
      // the user needs to know.
      const sentence = revertSentence({ label: entry.label, restored, message, stillPending: pending.count });
      saveRun("benchmark-revert", sentence, {
        comparisonId: id,
        tweak: tweakId,
        restored,
        message,
        sentence,
        data: outcome.data ?? null,
        // What PingLab still has on record as changed, so "not restored" is not left implicit.
        stillPending: pending.count,
        pendingProblem: pending.problem,
      });
      stateCache.invalidate();
      return sendJson(res, 200, {
        ok: restored,
        restored,
        message,
        sentence,
        data: outcome.data ?? null,
        tweakState: alias ? await tweakState(alias) : null,
        pending,
      });
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

    // Which adapter settings are aimed at is a persisted choice: the rows, the restore points
    // and every apply read it, so the page and the GUI cannot disagree about the device.
    if (req.method === "POST" && path === "/api/adapter") {
      const { alias } = adapterRequest(await readJson(req));
      const known = (await adapters()).find((a) => a.name === alias);
      if (!known) throw refuse(`"${alias}" is not an adapter on this machine.`);
      const saved = await saveAdapter(known.name);
      if (!saved.ok) {
        return sendJson(res, 409, {
          ok: false,
          error: saved.error,
          config: saved.problem ? { problem: saved.problem } : undefined,
        });
      }
      // Every row is read from the chosen adapter, so the cached state is stale by definition.
      stateCache.invalidate();
      const fresh = await stateCache.get();
      return sendJson(res, 200, {
        ok: true,
        target: fresh.target,
        adapterChoices: fresh.adapterChoices,
        targetFallback: fresh.targetFallback,
        tweakState: fresh.tweakState,
        pending: fresh.pending,
        drift: fresh.drift,
      });
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

/**
 * Asked once per run, and never awaited: a state read must not wait for GitHub. A check that
 * cannot be made leaves `checked: false` with no sentence, so an offline machine and a current
 * one both start quietly, and neither is called up to date.
 */
let update = { checked: false, pending: true };
checkForUpdate({ url: process.env.PINGLAB_UPDATE_URL || undefined }).then((result) => {
  update = result;
  if (result.sentence) console.log(`[pinglab] ${result.sentence}`);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`PingLab running at http://127.0.0.1:${PORT}`);
});
