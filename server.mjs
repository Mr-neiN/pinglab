import http from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { runProbe, summarizeProbe, bufferbloat } from "./lib/probe.mjs";
import { benchmark as dnsBenchmark, RESOLVERS } from "./lib/dns.mjs";
import { snapshot, wifiScan, dnsServers, routes } from "./lib/net.mjs";
import { tweakState, runTweakAction, tweakOutcome, pendingTweaks, applyPreset } from "./lib/tweaks.mjs";
import { TWEAKS, PRESETS, RISK, presetById } from "./lib/catalog.mjs";
import { loadConfig, saveConfig } from "./lib/config.mjs";
import { saveRun, listRuns, saveTweak, listTweaks, previousRun } from "./lib/db.mjs";
import { startSoak, stopSoak, soakStatus, listSoakRuns, getSoakRun, compareSoaks, soakLabel } from "./lib/soak.mjs";
import { openTarget } from "./lib/ps.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const PUBLIC_DIR = join(ROOT, "public");
const requestedPort = Number(process.env.PORT);
const PORT =
  Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65536 ? requestedPort : 4747;

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req, limit = 2 * 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error("Request body too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
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
  if (rel.includes("..")) {
    res.writeHead(403).end("Forbidden");
    return;
  }
  const file = join(PUBLIC_DIR, rel);
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      "Content-Type": MIME[extname(file).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(data);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }).end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const path = url.pathname;

  if (req.method === "GET" && (path === "/" || path === "/index.html" || path === "/app.js" || path === "/styles.css")) {
    return serveStatic(res, path);
  }

  if (!path.startsWith("/api/")) {
    if (req.method === "GET") return serveStatic(res, path);
    res.writeHead(405).end();
    return;
  }

  try {
    if (req.method === "GET" && path === "/api/state") {
      const config = await loadConfig();
      const connection = await snapshot();
      const alias = connection.activeRoute?.alias || null;
      const [tw, tweaks] = await Promise.all([
        alias ? tweakState(alias) : Promise.resolve(null),
        Promise.resolve(pendingTweaks()),
      ]);
      return sendJson(res, 200, {
        connection,
        tweakState: tw,
        pending: tweaks,
        endpoints: config.endpoints,
        resolvers: RESOLVERS,
        recentRuns: listRuns(null, 12),
        // Same catalog the TUI and the GUI render, so labels, trade-offs, risk levels and
        // preset contents cannot differ between surfaces.
        catalog: { tweaks: TWEAKS, presets: PRESETS, risk: RISK },
      });
    }

    if (req.method === "POST" && path === "/api/probe") {
      const body = await readJson(req);
      const config = await loadConfig();
      const selected =
        Array.isArray(body.endpointIds) && body.endpointIds.length
          ? config.endpoints.filter((e) => body.endpointIds.includes(e.id))
          : config.endpoints;
      const probe = await runProbe(selected);
      const summary = summarizeProbe(probe);
      const id = saveRun("probe", `avg ${summary.gameAvgMs ?? "?"} ms, loss ${summary.gameLoss ?? "?"}%`, {
        ...probe,
        summary,
      });
      return sendJson(res, 200, {
        ok: true,
        runId: id,
        ...probe,
        summary,
        previous: previousRun("probe"),
      });
    }

    if (req.method === "POST" && path === "/api/bufferbloat") {
      const body = await readJson(req);
      const result = await bufferbloat({ host: body.host || "1.1.1.1", seconds: Number(body.seconds) || 6 });
      const id = saveRun(
        "bufferbloat",
        `grade ${result.grade} (${result.deltaMs ?? "?"} ms added under load)`,
        result,
      );
      return sendJson(res, 200, { ok: result.ok, runId: id, result, previous: previousRun("bufferbloat") });
    }

    if (req.method === "POST" && path === "/api/dns-bench") {
      const result = await dnsBenchmark();
      const current = (await dnsServers()).find((d) => d.servers?.length) || null;
      const id = saveRun("dns", `fastest ${result.bestLabel ?? "unknown"}`, result);
      return sendJson(res, 200, { ok: true, runId: id, result, current });
    }

    if (req.method === "POST" && path === "/api/endpoints") {
      const body = await readJson(req);
      const endpoints = (body.endpoints || [])
        .filter((e) => e && typeof e.host === "string" && e.host.trim())
        .map((e, i) => ({
          id: String(e.id || `ep${i}`).replace(/[^a-z0-9_-]/gi, "").slice(0, 40) || `ep${i}`,
          label: String(e.label || e.host).slice(0, 60),
          host: String(e.host).trim().slice(0, 200),
          port: Math.min(65535, Math.max(1, Number(e.port) || 443)),
          kind: e.kind === "dns" ? "dns" : "game",
        }));
      if (!endpoints.length) return sendJson(res, 400, { ok: false, error: "At least one endpoint is required" });
      const config = await loadConfig();
      await saveConfig({ ...config, endpoints });
      return sendJson(res, 200, { ok: true, endpoints });
    }

    if (req.method === "POST" && path === "/api/wifi-scan") {
      const scan = await wifiScan();
      return sendJson(res, 200, { ok: scan.ok, scan });
    }

    if (req.method === "POST" && path === "/api/tweak") {
      const body = await readJson(req);
      const action = body.action;
      const alias = body.alias;
      if (!alias) return sendJson(res, 400, { ok: false, error: "No network adapter selected" });

      let result;
      try {
        if (action === "apply-preset") {
          if (!presetById(body.preset)) {
            return sendJson(res, 400, { ok: false, error: `Unknown preset: ${body.preset ?? "(none)"}` });
          }
          result = await applyPreset(alias, String(body.preset));
        } else {
          result = await runTweakAction(alias, action, { servers: body.servers });
        }
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: String(err?.message || err) });
      }
      if (result.ok) saveTweak(action, { alias, servers: body.servers, preset: body.preset, data: result.data ?? null });
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
      const body = await readJson(req);
      const minutes = Number(body.minutes);
      // Record which settings were live, so a later comparison cannot be misread.
      const alias = (await routes())[0]?.alias || null;
      const tw = alias ? await tweakState(alias) : null;
      const label = soakLabel(tw);
      const started = await startSoak({
        seconds: Number.isFinite(minutes) && minutes > 0 ? minutes * 60 : Number(body.seconds) || 600,
        intervalMs: Number(body.intervalMs) || 500,
        label,
      });
      return sendJson(res, 200, { ok: true, ...started });
    }

    if (req.method === "POST" && path === "/api/soak/stop") {
      return sendJson(res, 200, { ok: true, ...stopSoak() });
    }

    if (req.method === "GET" && path === "/api/soak/status") {
      return sendJson(res, 200, { ok: true, ...soakStatus() });
    }

    if (req.method === "GET" && path === "/api/soak/runs") {
      const runs = listSoakRuns(10);
      return sendJson(res, 200, { ok: true, runs, latest: runs[0] ?? null, previous: runs[1] ?? null });
    }

    if (req.method === "GET" && path.startsWith("/api/soak/run/")) {
      const id = Number(path.split("/").pop());
      const run = getSoakRun(id);
      if (!run) return sendJson(res, 404, { ok: false, error: "No such soak run" });
      return sendJson(res, 200, { ok: true, run });
    }

    if (req.method === "GET" && path === "/api/soak/compare") {
      const a = Number(url.searchParams.get("a"));
      const b = Number(url.searchParams.get("b"));
      const cmp = compareSoaks(a, b);
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
    console.error("[pinglab]", err);
    return sendJson(res, 500, { ok: false, error: String(err?.message || err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`PingLab running at http://127.0.0.1:${PORT}`);
});
