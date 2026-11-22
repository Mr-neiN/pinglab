#!/usr/bin/env node
/**
 * PingLab — terminal app.
 *
 * A runnable application, not a web interface: no HTTP server, no browser.
 * It drives the same engine modules the web UI used and draws a live console UI.
 *
 *   node pinglab.mjs            interactive dashboard
 *   node pinglab.mjs --once     render the dashboard once and exit
 *   node pinglab.mjs --wifi     Wi-Fi channel/band diagnosis, plain text
 *   node pinglab.mjs --probe    latency test against the game endpoints
 *   node pinglab.mjs --dns      DNS resolver benchmark
 *   node pinglab.mjs --soak 10  10-minute soak, printed live, stored in the database
 *   node pinglab.mjs --fixes    list the reversible fixes and their state
 *   node pinglab.mjs --apply plan|nic|nagle     apply one fix
 *   node pinglab.mjs --revert plan|nic|nagle    revert one fix
 *   node pinglab.mjs --restore  restore everything PingLab changed
 *   node pinglab.mjs --json     machine-readable snapshot
 */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { snapshot, dnsServers } from "./lib/net.mjs";
import { runProbe as probeOnce, summarizeProbe } from "./lib/probe.mjs";
import { benchmark as dnsBenchmark, verdictText, winnerChip } from "./lib/dns.mjs";
import { tweakState, runTweakAction, tweakOutcome, pendingTweaks, auditRows, applyPreset, knownActions, actionSpec, elevationCommand, elevationText, backupStatus } from "./lib/tweaks.mjs";
import { TWEAKS, PRESETS, RISK, presetById, presetTweaks, presetsFor, validateCatalog } from "./lib/catalog.mjs";
import { loadConfig, DEFAULT_ENDPOINTS } from "./lib/config.mjs";
import { DATA_DIR } from "./lib/paths.mjs";
import { analyseWifi, wifiAdvice, bandOf, scanWifi } from "./lib/wifi.mjs";
import { saveRun, previousRun, listRuns, dbStatus } from "./lib/db.mjs";
import { startSoak, stopSoak, soakStatus, summarizeRun, listSoakRuns, soakLabel } from "./lib/soak.mjs";
import { isElevated } from "./lib/ps.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
try {
  process.chdir(ROOT); // data/ paths in the engine modules resolve from here
} catch {}

/* ------------------------------------------------------------------ colours */

const R = "\x1b[0m";
const B = "\x1b[1m";
const D = "\x1b[2m";
const RED = "\x1b[31m";
const GRN = "\x1b[32m";
const YEL = "\x1b[33m";
const CYN = "\x1b[36m";
const GRY = "\x1b[90m";
const INV = "\x1b[7m";

const vis = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "");
const pad = (s, n) => {
  const t = String(s);
  const len = vis(t).length;
  return len >= n ? t : t + " ".repeat(n - len);
};
const padL = (s, n) => {
  const t = String(s);
  const len = vis(t).length;
  return len >= n ? t : " ".repeat(n - len) + t;
};

const n1 = (v, d = 1) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "—");
const n0 = (v) => (typeof v === "number" && Number.isFinite(v) ? String(Math.round(v)) : "—");
const clock = (t) => {
  if (!t) return "—";
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
};

function colour(value, good, warn) {
  if (value === null || value === undefined) return GRY;
  if (value <= good) return GRN;
  if (value <= warn) return YEL;
  return RED;
}

/* -------------------------------------------------------------- app state */

// The fixes view lists the catalog minus DNS, which has its own `d` view because choosing
// a resolver needs the benchmark first. Both tables come from the catalog, so a new row
// becomes a key and a CLI name without touching this file.
const FIX_ROWS = TWEAKS.filter((t) => t.id !== "dns");
const FIX_ACTIONS = Object.fromEntries(FIX_ROWS.map((t) => [t.rowKey, [t.actions.apply, t.actions.revert]]));

const ui = {
  view: "dash",
  busy: null,
  message: null,
  core: null,
  coreAt: 0,
  probe: null,
  dns: null,
  scan: null,
  soak: null,
  started: Date.now(),
};

function say(text, kind = "info", ms = 6000) {
  ui.message = { text, kind, until: Date.now() + ms };
}

async function refreshCore() {
  const config = await loadConfig();
  const connection = await snapshot();
  const alias = connection?.activeRoute?.alias || null;
  const tw = alias ? await tweakState(alias) : null;
  ui.core = {
    connection,
    alias,
    tw,
    pending: pendingTweaks(),
    endpoints: config.endpoints,
    runs: listRuns(null, 12),
    soaks: listSoakRuns(6),
  };
  ui.coreAt = Date.now();
  return ui.core;
}

async function runTweak(action) {
  const alias = ui.core?.alias;
  if (!alias) {
    say("No active adapter to change.", "bad");
    return;
  }
  // "best resolver" is a UI decision (it comes from the benchmark shown on screen).
  let servers;
  if (action === "dns-best") {
    const best = ui.dns?.result?.best;
    servers = ui.dns?.result?.resolvers?.find((r) => r.id === best)?.servers;
    if (!servers) {
      say(
        ui.dns?.result
          ? "No clear winner - the resolvers are within noise, so DNS is left alone."
          : "Run the DNS benchmark first (d).",
        ui.dns?.result ? "warn" : "bad",
      );
      return;
    }
  }
  ui.busy = "waiting for the Windows admin prompt…";
  let res;
  try {
    res = await runTweakAction(alias, action === "dns-best" ? "dns-apply" : action, { servers });
  } catch (err) {
    ui.busy = null;
    say(String(err?.message || err), "bad");
    return;
  }
  ui.busy = null;
  const outcome = tweakOutcome(res);
  say(outcome.message, outcome.kind, outcome.ok ? 6000 : 9000);
  await refreshCore();
}

/** Apply a named preset through the same rows, then show what happened. */
async function runPreset(presetId) {
  const alias = ui.core?.alias;
  if (!alias) {
    say("No active adapter to change.", "bad");
    return;
  }
  ui.busy = "applying the preset…";
  const res = await applyPreset(alias, presetId);
  ui.busy = null;
  const outcome = tweakOutcome(res);
  say(outcome.message, outcome.kind, 10000);
  await refreshCore();
}

async function runProbe() {
  const endpoints = ui.core?.endpoints || DEFAULT_ENDPOINTS;
  ui.busy = "measuring latency…";
  ui.view = "probe";
  const { results, icmp } = await probeOnce(endpoints, {
    onProgress: (endpoint) => {
      ui.busy = `measuring ${endpoint.label}…`;
    },
  });
  const summary = summarizeProbe({ results, icmp });
  saveRun("probe", `avg ${summary.gameAvgMs ?? "?"} ms, loss ${summary.gameLoss ?? "?"}%`, { results, icmp, summary });
  ui.probe = { results, icmp, summary, previous: previousRun("probe"), at: Date.now() };
  ui.busy = null;
  say(`Probe done — game avg ${summary.gameAvgMs ?? "?"} ms.`, "good");
  ui.core = null;
  await refreshCore();
}

async function runScan() {
  ui.busy = "scanning Wi-Fi…";
  ui.view = "wifi";
  const scan = await scanWifi({
    onStale: () => {
      ui.busy = "Windows returned a cached scan — refreshing…";
    },
  });
  ui.scan = { scan, at: Date.now() };
  ui.busy = null;
  if (!scan?.ok) say(scan?.reason || "Wi-Fi scan failed.", "bad", 9000);
  else if (scan.stale) say("Windows is still serving a cached scan — open the Wi-Fi panel (Win+A) and press s.", "warn", 12000);
}

async function runDns() {
  ui.busy = "benchmarking resolvers…";
  ui.view = "dns";
  const result = await dnsBenchmark();
  const current = (await dnsServers()).find((d) => d.servers?.length) || null;
  saveRun("dns", result.bestLabel ? `fastest ${result.bestLabel}` : "no clear winner", result);
  ui.dns = { result, current, at: Date.now() };
  ui.busy = null;
  say(`Fastest resolver: ${result.bestLabel ?? "unknown"}.`, "good");
}

async function soakStart(minutes = 10) {
  const alias = ui.core?.alias;
  if (alias && !ui.core?.tw) await refreshCore();
  const started = await startSoak({ seconds: Math.round(minutes * 60), label: soakLabel(ui.core?.tw) });
  ui.view = "soak";
  ui.soak = { runId: started.runId, summary: null, at: Date.now() };
  say(`Soak #${started.runId} started — ${minutes} min, ${started.expectedSamples} samples planned.`, "good");
}

async function soakStop() {
  const r = stopSoak();
  say(r?.stopped ? "Stopping the soak — summary will be written." : "No soak running.", r?.stopped ? "good" : "info");
}

/* ---------------------------------------------------------------- drawing */

function box(title, lines, W) {
  const out = [` ${B}${title}${R}`];
  for (const l of lines) out.push("  " + l);
  return out;
}

function kv(pairs, width = 13) {
  return pairs
    .filter(Boolean)
    .map(([k, v]) => `${D}${pad(k, width)}${R} ${v}`)
    .join("\n  ");
}

function viewDash(W) {
  const c = ui.core;
  if (!c) return ["", ` ${D}reading system state…${R}`];
  const conn = c.connection || {};
  const a = conn.activeAdapter || {};
  const w = conn.wifi || {};
  const tw = c.tw || {};
  const out = [];
  const dns = conn.dnsForActive?.servers?.length ? conn.dnsForActive.servers.join(", ") : "automatic";

  out.push(...box("Connection", [
    kv([
      ["adapter", `${B}${a.name || "?"}${R} ${D}${a.description || ""}${R}`],
      ["type", conn.usingWifi ? "Wi-Fi" : a.name ? "Ethernet / other" : "—"],
      ["link", `${a.linkSpeedText || "—"}`],
      ["route", `${conn.activeRoute?.alias || "?"} → ${conn.activeRoute?.nextHop || "?"}`],
      ["DNS", dns],
      w.connected
        ? ["Wi-Fi", `${B}${w.ssid || "hidden"}${R} · ${w.band || "?"} ch ${w.channel ?? "?"} · ${w.signalPct ?? "?"}% · ${w.radioType || "?"}`]
        : conn.usingWifi
          ? ["Wi-Fi", `${YEL}details hidden${R} ${D}${w.reason ? "— " + w.reason.slice(0, 60) : ""}${R}`]
          : null,
    ]),
  ]));

  const fix = (ok, label) => `${ok ? GRN + "✓" + R : GRY + "–" + R} ${label}`;
  out.push("");
  out.push(...box(
    `Fixes ${c.pending?.count ? `(${YEL}${c.pending.count} active${R})` : `${D}(none active)${R}`}`,
    [
      fix(tw.planPower === "off", `Wireless power saving (plan) ${D}${tw.planDetail || ""}${R}`),
      fix(tw.nicPower === "off", `NIC power management ${D}${tw.nicPower === "unsupported" ? "not available on this adapter" : tw.nicDetail || ""}${R}`),
      fix(tw.nagleDisabled === true, `Nagle's algorithm ${D}${tw.nagleDisabled ? "disabled (TcpAckFrequency=1, TCPNoDelay=1)" : "on"}${R}`),
    ],
  ));

  const last = c.runs?.find((r) => r.kind === "probe");
  const soak = soakStatus();
  out.push("");
  out.push(...box("Latest", [
    last ? `probe   ${D}${clock(last.createdAt)}${R}  ${last.summary}` : `${D}probe   never run${R}`,
    soak?.running
      ? `soak    ${YEL}running ${soak.elapsed}s / ${soak.seconds}s · ${soak.samples} samples${R}`
      : c.soaks?.[0]
        ? `soak    ${D}#${c.soaks[0].id} · ${Math.round((c.soaks[0].seconds || 0) / 60)} min · ${c.soaks[0].summary?.samples ?? "?"} samples${R}`
        : `${D}soak    never run${R}`,
  ]));
  return out;
}

function wrapText(text, width) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const lines = [];
  let line = "";
  for (const w of words) {
    if (line && (line + " " + w).length > width) {
      lines.push(line);
      line = w;
    } else line = line ? line + " " + w : w;
  }
  if (line) lines.push(line);
  return lines;
}

/** Current state of one catalog row, in the words the fixes view prints. */
function fixState(id, tw) {
  switch (id) {
    case "plan-power":
      return {
        on: tw.planPower === "off",
        state: tw.planPower === "off" ? "maximum performance" : tw.planDetail || tw.planPower,
      };
    case "nic-power":
      return {
        on: tw.nicPower === "off",
        state: tw.nicPower === "unsupported" ? "not available on this adapter" : tw.nicDetail || tw.nicPower,
        disabled: tw.nicPower === "unsupported" || tw.nicPower === "unknown",
      };
    case "nagle":
      return {
        on: tw.nagleDisabled === true,
        state: tw.nagleDisabled
          ? `disabled · TcpAckFrequency=${tw.nagleValues?.tcpAckFrequency ?? "—"}, TCPNoDelay=${tw.nagleValues?.tcpNoDelay ?? "—"}`
          : "on · Windows batches small packets",
        disabled: tw.nagleAvailable === false,
      };
    case "radio-tuning":
      return {
        on: tw.adapterTuning ? !tw.adapterTuning.needsFix : false,
        state: !tw.adapterTuning
          ? "not readable on this adapter"
          : `${tw.adapterTuning.needsFix ? "vendor defaults" : "applied"} · ${tw.adapterTuning.items.map((i) => i.display).join(", ")}`,
        disabled: !tw.adapterTuning,
      };
    case "wifi-order":
      return {
        on: Boolean(tw.wifiOrder?.appliedByUs && tw.wifiOrder?.isFirst),
        state: !tw.wifiOrder
          ? "not the wireless adapter"
          : !tw.wifiOrder.readable
            ? "profile list unreadable"
            : tw.wifiOrder.isFirst
              ? `first: ${tw.wifiOrder.target}`
              : tw.wifiOrder.target
                ? `${tw.wifiOrder.target} is #${tw.wifiOrder.position} of ${tw.wifiOrder.profiles.length}`
                : "not joined to a saved profile",
        disabled: !tw.wifiOrder || !tw.wifiOrder.readable,
      };
    default:
      return { on: false, state: "unknown" };
  }
}

function viewFixes(W) {
  const tw = ui.core?.tw;
  if (!tw) return ["", ` ${D}reading system state…${R}`];
  const out = [""];
  const width = Math.max(52, Math.min(W - 12, 92));
  for (const t of FIX_ROWS) {
    const st = fixState(t.id, tw);
    const mark = st.disabled ? `${GRY}⨯${R}` : st.on ? `${GRN}✓${R}` : `${GRY}–${R}`;
    const risk = RISK[t.risk]?.label || t.risk;
    const riskColour = t.risk === "safe" ? GRN : t.risk === "moderate" ? YEL : RED;
    const where = presetsFor(t.id).map((p) => p.id).join(", ");
    out.push(`  ${INV} ${t.rowKey} ${R} ${mark} ${B}${t.label}${R}  ${riskColour}[${risk}]${R}${where ? ` ${D}in: ${where}${R}` : ""}`);
    out.push(`       ${D}now:${R} ${st.state}`);
    out.push(`       ${D}sets:${R}`);
    for (const line of wrapText(t.what, width)) out.push(`         ${D}${line}${R}`);
    out.push(`       ${D}trade:${R}`);
    for (const line of wrapText(t.tradeoff, width)) out.push(`         ${D}${line}${R}`);
    out.push("");
  }
  out.push(`  ${D}Press 1-5 to apply or revert one. S applies the safe preset, L the lowest-latency preset, R restores everything. DNS lives in the d view.${R}`);
  out.push(`  ${D}Every apply records a restore point first, and no preset contains the experimental radio row.${R}`);
  return out;
}

function viewProbe(W) {
  const p = ui.probe;
  if (!p) return ["", ` ${D}no probe yet — press p${R}`];
  const out = [""];
  const cols = [22, 8, 8, 8, 8, 7];
  out.push(`  ${D}${pad("endpoint", cols[0])}${padL("avg", cols[1])}${padL("p95", cols[2])}${padL("jitter", cols[3])}${padL("loss", cols[4])}${padL("sent", cols[5])}${R}`);
  for (const r of p.results) {
    const col = colour(r.avg, 60, 110);
    out.push(
      `  ${pad(r.label, cols[0])}${col}${padL(n1(r.avg), cols[1])}${padL(n1(r.p95), cols[2])}${padL(n1(r.jitter), cols[3])}${R}${r.loss > 0 ? RED : GRY}${padL(n0(r.loss) + "%", cols[4])}${R}${GRY}${padL(r.sent ?? "—", cols[5])}${R}`,
    );
  }
  out.push("");
  out.push(`  ${D}game avg${R} ${B}${n1(p.summary.gameAvgMs)} ms${R}   ${D}jitter${R} ${n1(p.summary.gameJitter)} ms   ${D}loss${R} ${n1(p.summary.gameLoss)}%   ${D}reachable${R} ${p.summary.reachable}/${p.summary.endpoints}`);
  if (p.icmp?.length) {
    out.push("");
    out.push(`  ${D}ICMP cross-check: ${p.icmp.map((i) => `${i.host} ${i.loss}% loss`).join(" · ")}${R}`);
  }
  if (p.previous) out.push(`  ${D}previous run: ${p.previous.summary}${R}`);
  return out;
}

function viewWifi(W) {
  const s = ui.scan;
  if (!s) return ["", ` ${D}no scan yet — press w${R}`];
  if (!s.scan?.ok) {
    return ["", `  ${RED}${s.scan?.reason || "scan failed"}${R}`, "", `  ${D}Scanning needs Location services. Open Settings → Privacy & security → Location.${R}`];
  }
  const wifi = ui.core?.connection?.wifi || {};
  const a = analyseWifi(s.scan, wifi);
  const out = [""];
  out.push(`  ${D}${pad("network", 24)}${padL("band", 8)}${padL("ch", 5)}${padL("signal", 8)}${R}`);
  const sorted = [...a.nets].sort((x, y) => (x.channel ?? 0) - (y.channel ?? 0));
  for (const n of sorted) {
    const mine = a.mySsid && n.ssid === a.mySsid && n.channel === a.myChannel;
    const line = `${pad(n.ssid, 24)}${padL(n.band || bandOf(n.channel) || "?", 8)}${padL(n.channel ?? "?", 5)}${padL((n.signal ?? "?") + "%", 8)}`;
    out.push(`  ${mine ? B + CYN : ""}${line}${mine ? R + " " + D + "← you" + R : ""}`);
  }
  out.push("");
  for (const [kind, text] of wifiAdvice(a, wifi)) {
    const c = kind === "good" ? GRN : kind === "warn" ? YEL : kind === "bad" ? RED : kind === "dim" ? D : CYN;
    out.push(`  ${c}${text}${R}`);
  }
  out.push("");
  if (s.scan.stale) {
    out.push(`  ${YEL}This list is a cached scan from Windows, not a fresh one — press s to refresh.${R}`);
  } else if (s.scan.refreshed) {
    out.push(`  ${D}Windows' scan cache was stale, so the Wi-Fi panel was opened briefly to refresh it.${R}`);
  }
  out.push(`  ${D}snapshot ${clock(s.at)} — signal % is coarse; hidden SSIDs are undercounted. s rescans.${R}`);
  return out;
}

function viewDns(W) {
  const d = ui.dns;
  if (!d) return ["", ` ${D}no benchmark yet — press d${R}`];
  const out = [""];
  out.push(`  ${D}${pad("resolver", 22)}${padL("median", 9)}${padL("worst", 8)}${padL("ok", 8)}${R}`);
  for (const r of d.result.resolvers || []) {
    const best = r.id === d.result.best;
    out.push(
      `  ${best ? B + CYN : ""}${pad(r.label, 22)}${colour(r.median, 25, 60)}${padL(n1(r.median), 9)}${padL(n1(r.worst), 8)}${padL(`${r.answered}/${d.result.domains}`, 8)}${R}${D}${winnerChip(d.result, r.id)}${R}`,
    );
  }
  out.push("");
  out.push(`  ${D}current:${R} ${d.current?.servers?.join(", ") || "automatic"}`);
  out.push(`  ${D}${verdictText(d.result)}${R}`);
  return out;
}

function viewSoak(W) {
  const st = soakStatus();
  const out = [""];
  if (st?.running) {
    const pct = Math.min(100, Math.round((st.elapsed / Math.max(1, st.seconds)) * 100));
    const width = Math.max(20, Math.min(W - 24, 60));
    const filled = Math.round((pct / 100) * width);
    out.push(`  ${B}Soak #${st.runId}${R} ${D}${st.elapsed}s of ${st.seconds}s${R}`);
    out.push("");
    out.push(`  ${GRN}${"█".repeat(filled)}${R}${GRY}${"░".repeat(width - filled)}${R} ${pct}%`);
    out.push("");
    out.push(`  ${D}${st.samples} samples stored · about ${Math.ceil((st.seconds - st.elapsed) / 60)} min left${R}`);
    out.push(`  ${D}Every sample is in the database already. t stops it early.${R}`);
    return out;
  }
  const summary = ui.soak?.summary || (ui.soak?.runId ? summarizeRun(ui.soak.runId) : null);
  if (!summary) {
    const prev = listSoakRuns(1)[0];
    if (!prev) return ["", `  ${D}No soak yet. t starts a 10-minute run (~4,800 samples).${R}`];
    const s = prev.summary;
    out.push(`  ${D}last run #${prev.id} · ${Math.round(prev.seconds / 60)} min · ${s?.samples ?? "?"} samples · ${s?.label || ""}${R}`);
    out.push("");
    return [...out, ...soakTable(s)];
  }
  out.push(`  ${D}run #${summary.runId} · ${Math.round(summary.seconds / 60)} min · ${summary.samples} samples · ${summary.label || ""}${R}`);
  out.push("");
  return [...out, ...soakTable(summary)];
}

function soakTable(summary) {
  if (!summary?.targets) return [`  ${D}no summary${R}`];
  const out = [];
  const cols = [22, 8, 8, 8, 8, 7, 7];
  out.push(`  ${D}${pad("target", cols[0])}${padL("avg", cols[1])}${padL("p95", cols[2])}${padL("p99", cols[3])}${padL("jitter", cols[4])}${padL("loss", cols[5])}${padL("spikes", cols[6])}${R}`);
  for (const t of summary.targets) {
    out.push(
      `  ${pad(t.label, cols[0])}${colour(t.avg, 50, 90)}${padL(n1(t.avg), cols[1])}${padL(n1(t.p95), cols[2])}${padL(n1(t.p99), cols[3])}${padL(n1(t.jitter), cols[4])}${R}${t.loss > 0 ? YEL : GRY}${padL(n1(t.loss) + "%", cols[5])}${R}${GRY}${padL(t.spikes, cols[6])}${R}`,
    );
  }
  if (summary.overall) {
    out.push("");
    out.push(`  ${D}overall${R} avg ${n1(summary.overall.avg)} ms · p95 ${n1(summary.overall.p95)} ms · jitter ${n1(summary.overall.jitter)} ms · loss ${n1(summary.overall.loss)}%`);
  }
  return out;
}

function viewHistory(W) {
  const runs = ui.core?.runs || [];
  const out = [""];
  if (!runs.length) return ["", `  ${D}nothing recorded yet${R}`];
  for (const r of runs.slice(0, 12)) {
    out.push(`  ${D}${clock(r.createdAt)}${R}  ${pad(r.kind, 11)}  ${r.summary}`);
  }
  return out;
}

function footer(view) {
  if (ui.message && Date.now() < ui.message.until) {
    const c = ui.message.kind === "good" ? GRN : ui.message.kind === "bad" ? RED : ui.message.kind === "warn" ? YEL : CYN;
    return `${c}${ui.message.text}${R}`;
  }
  const nav = "p probe · w wi-fi · d dns · t soak · f fixes · h history · r refresh · ? help · q quit";
  const back = view === "dash" ? "" : "esc back · ";
  return `${D}${back}${nav}${R}`;
}

const VIEWS = { dash: viewDash, fixes: viewFixes, probe: viewProbe, wifi: viewWifi, dns: viewDns, soak: viewSoak, history: viewHistory };
const TITLES = {
  dash: "Overview",
  fixes: "Fixes — reversible, each with a stored backup",
  probe: "Latency to the endpoints that matter",
  wifi: "Wi-Fi channel & band diagnosis",
  dns: "DNS resolver benchmark",
  soak: "Soak test — sustained jitter & loss",
  history: "Recent runs",
};

function render() {
  const W = Math.max(64, Math.min(process.stdout.columns || 100, 118));
  const lines = [];
  lines.push("");
  const busy = ui.busy ? `  ${YEL}⟳ ${ui.busy}${R}` : "";
  lines.push(` ${B}${CYN}PingLab${R} ${D}· network doctor${R}${busy}`);
  lines.push(` ${D}${"─".repeat(W - 2)}${R}`);
  lines.push(` ${D}${TITLES[ui.view] || ""}${R}`);
  const body = (VIEWS[ui.view] || viewDash)(W);
  for (const entry of body) {
    for (const l of String(entry).split("\n")) {
      lines.push(l.includes("\x1b") || l === "" ? l : ` ${D}${l}${R}`);
    }
  }
  while (lines.length < (process.stdout.rows ? process.stdout.rows - 2 : 30)) lines.push("");
  lines.push(` ${D}${"─".repeat(W - 2)}${R}`);
  lines.push(` ${footer(ui.view)}`);
  process.stdout.write("\x1b[H" + lines.map((l) => l + "\x1b[K").join("\n") + "\x1b[J");
}

/* ------------------------------------------------------------------- keys */

async function handleKey(ch) {
  if (ch === "\u0003" || ch === "q") return quit();
  if (ch === "\u001b") {
    ui.view = "dash";
    return;
  }
  if (ui.busy) return;
  switch (ch) {
    case "?":
      ui.view = "history";
      say("Keys: p probe, w wifi, d dns, t soak, f fixes, h history, r refresh, q quit", "info", 12000);
      return;
    case "p":
      return runProbe();
    case "w":
      return runScan();
    case "d":
      return runDns();
    case "t":
      return soakStatus()?.running ? soakStop() : soakStart(10);
    case "f":
      ui.view = "fixes";
      return;
    case "h":
      ui.view = "history";
      return;
    case "r":
      ui.busy = "refreshing…";
      await refreshCore();
      ui.busy = null;
      say("Refreshed.", "good", 2000);
      return;
    default:
      break;
  }
  if (ui.view === "fixes") {
    const pair = FIX_ACTIONS[ch];
    if (pair) {
      const row = FIX_ROWS.find((t) => t.rowKey === ch);
      const on = row ? fixState(row.id, ui.core?.tw || {}).on : false;
      return runTweak(pair[on ? 1 : 0]);
    }
    if (ch === "S") return runPreset("safe");
    if (ch === "L") return runPreset("latency");
    if (ch === "R") return runTweak("restore-all");
  }
    if (ui.view === "wifi" && ch === "s") return runScan();
  if (ui.view === "dns") {
    if (ch === "D") return runTweak("dns-best");
    if (ch === "A") return runTweak("dns-reset");
  }
}

async function quit() {
  const st = soakStatus();
  if (st?.running) {
    stopSoak();
    await new Promise((r) => setTimeout(r, 1500));
  }
  process.stdout.write("\x1b[?25h\x1b[0m\n");
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  process.exit(0);
}

/* ------------------------------------------------------- one-shot modes */

function print(lines) {
  process.stdout.write(lines.join("\n") + "\n");
}

function textWifi() {
  const scanData = ui.scan || { scan: null };
  const a = analyseWifi(scanData.scan, ui.core?.connection?.wifi || {});
  if (!scanData.scan?.ok) {
    print([`Wi-Fi scan failed: ${scanData.scan?.reason || "unknown"}`]);
    return;
  }
  print(["", ` ${B}Wi-Fi scan${R}`, ""]);
  print(a.nets.map((n) => `  ${pad(n.ssid, 24)} ${pad(n.band || bandOf(n.channel) || "?", 8)} ch ${padL(n.channel ?? "?", 3)}  ${n.signal ?? "?"}%`));
  print([""]);
  for (const [kind, text] of wifiAdvice(a, ui.core?.connection?.wifi || {})) print([`  ${text}`]);
  print([""]);
}

/* ---------------------------------------------------------------- bridge */

/**
 * Line-delimited JSON over stdin/stdout, used by the desktop GUI so it can drive
 * the engine in-process instead of through a web server.
 *   in : {"id":"1","cmd":"state"}
 *   out: {"id":"1","ok":true,"data":{...}}
 */
async function bridgeCommand(cmd, args = {}) {
  switch (cmd) {
    case "state": {
      await refreshCore();
      return {
        connection: ui.core?.connection || null,
        tweak: ui.core?.tw || null,
        pending: ui.core?.pending || null,
        runs: ui.core?.runs || [],
        soaks: ui.core?.soaks || [],
        soak: soakStatus(),
        // The catalog travels with the state so the GUI draws its own labels and preset
        // buttons from the same list the other surfaces use.
        catalog: { tweaks: TWEAKS, presets: PRESETS, risk: RISK },
      };
    }
    case "probe":
      await runProbe();
      return { probe: ui.probe, message: ui.message?.text || null };
    case "wifi": {
      // The diagnosis reads ui.core.connection.wifi; without core state it would report
      // "not reporting Wi-Fi details" no matter what the adapter is doing.
      if (!ui.core) await refreshCore();
      await runScan();
      const scan = ui.scan?.scan || null;
      const advice = scan?.ok ? wifiAdvice(analyseWifi(scan, ui.core?.connection?.wifi || {}), ui.core?.connection?.wifi || {}) : [];
      return { scan, advice, message: ui.message?.text || null };
    }
    case "dns":
      await runDns();
      return { dns: ui.dns, message: ui.message?.text || null };
    case "soakStart": {
      const minutes = args.seconds ? Number(args.seconds) / 60 : Number(args.minutes) || 10;
      await soakStart(minutes);
      return { soak: soakStatus() };
    }
    case "soakStop":
      await soakStop();
      return { soak: soakStatus() };
    case "soakStatus": {
      const st = soakStatus();
      return { soak: st, summary: st?.summary || (ui.soak?.runId ? summarizeRun(ui.soak.runId) : null) };
    }
    case "apply":
      // A bridge client may apply before it ever asked for state; without core state
      // runTweak would bail out with "No active adapter to change.".
      if (!ui.core) await refreshCore();
      if (args.preset) {
        const preset = presetById(String(args.preset));
        if (!preset) throw new Error(`Unknown preset: ${args.preset}`);
        if (!ui.core?.alias) throw new Error("No active adapter to change.");
        const res = await applyPreset(ui.core.alias, preset.id);
        const outcome = tweakOutcome(res);
        say(outcome.message, outcome.kind, 10000);
      } else {
        await runTweak(String(args.action || ""));
      }
      return {
        message: ui.message?.text || null,
        kind: ui.message?.kind || null,
        tweak: ui.core?.tw || null,
        pending: ui.core?.pending || null,
      };
    case "history":
      return { runs: listRuns(null, 30) };
    default:
      throw new Error(`Unknown command: ${cmd}`);
  }
}

async function bridge(outPath) {
  const { createInterface } = await import("node:readline");
  const { appendFileSync, writeFileSync } = await import("node:fs");
  // Responses go to a file the client polls: a Windows GUI process reading a pipe
  // asynchronously from PowerShell 5.1 cannot deliver the callbacks reliably.
  // The file is per process so a second bridge can never truncate one a client is
  // still polling; callers may name it themselves with --out.
  const outFile = outPath ? resolve(ROOT, outPath) : join(DATA_DIR, `bridge-out.${process.pid}.jsonl`);
  try {
    writeFileSync(outFile, "");
  } catch {}
  const rl = createInterface({ input: process.stdin, terminal: false });
  const send = (obj) => {
    try {
      appendFileSync(outFile, JSON.stringify(obj) + "\n");
    } catch {}
  };
  let chain = Promise.resolve();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    chain = chain.then(async () => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      try {
        const data = await bridgeCommand(msg.cmd, msg.args || {});
        send({ id: msg.id, ok: true, data });
      } catch (err) {
        send({ id: msg.id, ok: false, error: String(err?.message || err) });
      }
    });
  });
  rl.on("close", () => chain.then(() => process.exit(0)));
}

async function main() {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  const after = (f) => args[args.indexOf(f) + 1];

  if (has("--help") || has("-h")) {
    print([
      "",
      ` ${B}PingLab${R} — terminal network doctor`,
      "",
      "  node pinglab.mjs               interactive dashboard",
      "  node pinglab.mjs --once        render the dashboard once",
      "  node pinglab.mjs --wifi        Wi-Fi channel & band diagnosis",
      "  node pinglab.mjs --probe       latency to game endpoints",
      "  node pinglab.mjs --dns         DNS resolver benchmark",
      "  node pinglab.mjs --soak [min]  soak test (default 10 min)",
      "  node pinglab.mjs --fixes       show reversible fixes",
      "  node pinglab.mjs --presets     named presets and exactly what each applies",
      "  node pinglab.mjs --preset X    X = safe | latency (applies that preset)",
      "  node pinglab.mjs --audit       every managed setting vs what Windows reports",
      "  node pinglab.mjs --self-check  catalog, presets, dispatch and live state, no changes",
      "  node pinglab.mjs --apply X     X = plan | nic | nagle | wifi | order",
      "  node pinglab.mjs --revert X    undo one fix",
      "  node pinglab.mjs --restore     restore everything PingLab changed",
      "  node pinglab.mjs --json        raw snapshot as JSON",
      "",
    ]);
    return;
  }

  if (has("--bridge")) return bridge(has("--out") ? after("--out") : null);

  await refreshCore();

  if (has("--json")) {
    print([JSON.stringify({ connection: ui.core.connection, tweak: ui.core.tw, pending: ui.core.pending }, null, 2)]);
    return;
  }
  if (has("--fixes")) {
    ui.view = "fixes";
    print(viewFixes(100).filter((l) => vis(l).trim()));
    return;
  }
  if (has("--presets")) {
    const lines = ["", ` ${B}PingLab${R} · presets`, ""];
    for (const p of PRESETS) {
      lines.push(`  ${B}${p.id}${R}  ${p.label}`);
      for (const line of wrapText(p.summary, 86)) lines.push(`    ${line}`);
      lines.push(`    ${D}applies, in this order:${R}`);
      for (const t of presetTweaks(p)) lines.push(`      · ${t.label} ${D}[${RISK[t.risk]?.label || t.risk}]${R}`);
      for (const line of wrapText(p.leaves, 86)) lines.push(`    ${D}${line}${R}`);
      lines.push("");
    }
    lines.push(`  ${D}Each step goes through the same row as pressing its number, so each records its own restore point.${R}`);
    lines.push(`  ${D}No preset contains an experimental setting, and none changes DNS.${R}`);
    print(lines);
    return;
  }
  if (has("--audit")) {
    const tw = ui.core?.tw;
    const rows = auditRows(tw);
    const pending = ui.core?.pending || { items: [], count: 0 };
    const w1 = Math.max(35, ...rows.map((r) => String(r.setting).length + 2));
    const w2 = 33, w3 = 24;
    const pad = (s, n) => {
      const t = String(s ?? "");
      return (t.length > n ? `${t.slice(0, n - 2)}..` : t).padEnd(n);
    };
    const conn = ui.core?.connection || {};
    const lines = [
      "",
      ` ${B}PingLab${R} · settings audit`,
      ` adapter ${tw?.alias ?? "?"} · ${conn.wifi?.ssid ?? "not on Wi-Fi"}`,
      "",
      `  ${pad("setting", w1)}${pad("app reports", w2)}${pad("windows reports", w3)}verdict`,
      `  ${D}${"-".repeat(w1 + w2 + w3 + 7)}${R}`,
    ];
    for (const r of rows) {
      const verdict = r.match ? `${GRN}match${R}` : `${RED}MISMATCH${R}`;
      lines.push(`  ${pad(r.setting, w1)}${pad(r.reported, w2)}${pad(r.observed, w3)}${verdict}`);
    }
    const bad = rows.filter((r) => !r.match).length;
    lines.push(
      "",
      `  ${bad === 0 ? `${GRN}${rows.length}/${rows.length} settings match what Windows reports${R}` : `${RED}${bad} setting(s) disagree with Windows${R}`}`,
      "",
      ` ${B}why each one reads that way${R}`,
    );
    for (const r of rows) lines.push(`  ${D}·${R} ${r.setting}: ${r.note}`);
    const backupProblem = pending.problem || null;
    lines.push(
      "",
      ` ${B}restore points${backupProblem ? "" : ` (${pending.count})`} — changes PingLab can undo, not outstanding work${R}`,
    );
    if (backupProblem) {
      // A count of 0 here would be a claim about the machine, and the file that backs it is
      // unreadable. Say that instead of printing "at its original values".
      lines.push(`  ${RED}${backupProblem.message}${R}`);
      lines.push(`  ${RED}Nothing will be applied or reverted until this is fixed.${R}`);
    } else if (!pending.count) lines.push(`  ${D}none: this machine is at its original values${R}`);
    for (const it of pending.items || []) {
      lines.push(`  ${D}·${R} ${it.label} (${it.alias}) → ${it.changedTo}`);
      lines.push(`    ${D}restore-all would set: ${it.restoreWillSet}${R}`);
    }
    // History is not a restore point, but a database that had to be set aside this run is
    // still something the user needs to hear about, not a silent reset.
    const history = dbStatus();
    if (history.problem) {
      lines.push("", ` ${B}history${R}`, `  ${RED}${history.problem.message}${R}`);
    }
    lines.push("");
    print(lines);
    return;
  }
  if (has("--self-check")) {
    // Read-only: validates the catalog and presets, then checks the live machine against
    // them. A failure here is a bug in the app, not a setting the user chose.
    const problems = [...validateCatalog().problems];
    const actions = knownActions();
    for (const t of TWEAKS) {
      for (const a of [t.actions.apply, t.actions.revert]) {
        if (!actions.has(a)) problems.push(`${t.id}: action "${a}" is not in runTweakAction`);
      }
    }
    // Every action has to be able to explain a refused prompt the same way everywhere, and
    // the command it names has to be the one that actually exists on the CLI.
    for (const t of TWEAKS) {
      for (const [mode, a] of [
        ["apply", t.actions.apply],
        ["revert", t.actions.revert],
      ]) {
        const spec = actionSpec(a);
        const cmd = elevationCommand(spec);
        const sentence = elevationText(spec, { cancelled: true });
        if (spec.id !== t.id) problems.push(`${t.cli}: action ${a} maps to ${spec.id} instead of ${t.id}`);
        if (cmd !== `node pinglab.mjs --${mode} ${t.cli}`) problems.push(`${t.cli}: elevation command reads "${cmd}"`);
        if (!sentence.includes(t.label) || !sentence.includes(cmd)) {
          problems.push(`${t.cli}: the elevation sentence does not name the setting and its command`);
        }
      }
    }
    const elevated = await isElevated();
    const tw = ui.core?.tw;
    if (!tw) problems.push("no active adapter, so no setting could be read");
    const rows = auditRows(tw);
    // The restore points are the only record of how to undo what this app changed, so an
    // unreadable file is a problem this check names rather than hides.
    const backups = backupStatus();
    if (backups.problem) problems.push(`backups: ${backups.problem.message}`);
    // The database holds measurements, not the way to undo a change, so a damaged one is
    // reported and recovered from rather than fatal - see lib/db.mjs.
    const history = dbStatus();
    if (history.problem) problems.push(`history: ${history.problem.message}`);
    for (const r of rows) {
      if (!r.match) problems.push(`audit: ${r.setting} reports "${r.reported}" but Windows says "${r.observed}"`);
    }
    if (tw) {
      for (const t of FIX_ROWS) {
        if (fixState(t.id, tw).state === "unknown") problems.push(`${t.id}: the fixes view has no state text for this setting`);
      }
      if (!Array.isArray(tw.currentDns)) problems.push("dns: current servers could not be read");
    }
    const lines = ["", ` ${B}PingLab${R} · self-check`, ""];
    lines.push(`  catalog      ${TWEAKS.length} settings, every one with what it changes, what it trades, a risk level and an undo`);
    lines.push(`  defaults     all off until applied: ${TWEAKS.filter((t) => t.default === "off").length}/${TWEAKS.length}`);
    lines.push(`  presets      ${PRESETS.map((p) => `${p.id} (${p.tweaks.length})`).join(", ")} · none experimental`);
    lines.push(`  dispatch     ${actions.size} actions, every catalog action present`);
    lines.push(
      `  elevation    every action names its setting and command · ${elevated ? "running elevated, no prompt needed" : `running without admin rights, Windows will ask once per change`}`,
    );
    lines.push(`  audit        ${rows.filter((r) => r.match).length}/${rows.length} settings match what Windows reports`);
    lines.push(
      `  backups      ${backups.problem ? "unreadable - nothing will be written until it is repaired" : `${pendingTweaks().count} restore point(s), each saved before the change it undoes`}`,
    );
    lines.push(
      `  history      ${history.problem ? "damaged - set aside and started again, so this run's history begins empty" : "readable, so runs and soak tests are recorded"}`,
    );
    lines.push("");
    if (problems.length) {
      lines.push(`  ${RED}${problems.length} problem(s)${R}`);
      for (const p of problems) lines.push(`   ${RED}·${R} ${p}`);
      process.exitCode = 1;
    } else {
      lines.push(`  ${GRN}ok: catalog, presets, dispatch and live state all agree${R}`);
    }
    print(lines);
    return;
  }
  if (has("--preset")) {
    const id = after("--preset");
    if (!presetById(id)) {
      print([`Unknown preset "${id}". Use: ${PRESETS.map((p) => p.id).join(", ")}.`]);
      process.exitCode = 1;
      return;
    }
    const alias = ui.core?.alias;
    const res = alias ? await applyPreset(alias, id) : { ok: false, error: "No active adapter to change." };
    const outcome = tweakOutcome(res);
    print([outcome.message]);
    for (const step of res.data?.steps || []) {
      const mark = step.ok ? "✓" : step.status === "skipped" ? "–" : "✗";
      print([`  ${mark} ${step.label}: ${step.message}`]);
    }
    await refreshCore();
    print([`pending=${ui.core?.pending?.count}`]);
    if (!res.ok) process.exitCode = 1;
    return;
  }
  if (has("--apply") || has("--revert")) {
    const which = after(has("--apply") ? "--apply" : "--revert");
    const on = has("--apply");
    const spec = TWEAKS.find((t) => t.cli === which);
    if (!spec) {
      print([`Unknown fix "${which}". Use ${TWEAKS.map((t) => t.cli).join(", ")}.`]);
      process.exitCode = 1;
      return;
    }
    ui.busy = null;
    // Which resolver is fastest is a measurement, so `--apply dns` benchmarks first and only
    // writes a winner; without one it says so and leaves DNS alone, like the TUI's D key.
    if (on && spec.id === "dns") {
      await runDns();
      await runTweak("dns-best");
    } else {
      await runTweak(on ? spec.actions.apply : spec.actions.revert);
    }
    print([ui.message?.text || "done"]);
    await refreshCore();
    // A refused or failed change must not look like success to a script that checks $?.
    if (ui.message?.kind === "bad") process.exitCode = 1;
    const tw = ui.core?.tw || {};
    const order = tw.wifiOrder ? (tw.wifiOrder.isFirst ? "first" : `#${tw.wifiOrder.position}`) : "n/a";
    print([
      `plan=${tw.planPower} nic=${tw.nicPower} nagle=${tw.nagleDisabled} order=${order} pending=${ui.core?.pending?.count}`,
    ]);
    return;
  }
  if (has("--restore")) {
    await runTweak("restore-all");
    print([ui.message?.text || "done", `pending=${ui.core?.pending?.count}`]);
    // A restore that did not put a setting back must not look like success to a script.
    if (ui.message?.kind === "bad") process.exitCode = 1;
    return;
  }
  if (has("--wifi")) {
    await runScan();
    textWifi();
    return;
  }
  if (has("--probe")) {
    await runProbe();
    print(["", ...viewProbe(100).filter((l) => vis(l).trim())]);
    return;
  }
  if (has("--dns")) {
    await runDns();
    print(["", ...viewDns(100).filter((l) => vis(l).trim())]);
    return;
  }
  if (has("--soak")) {
    const minutes = Math.max(1, Math.min(60, Number(after("--soak")) || 10));
    await soakStart(minutes);
    const id = ui.soak.runId;
    while (soakStatus()?.running) {
      const st = soakStatus();
      print([`  ${st.elapsed}s / ${st.seconds}s · ${st.samples} samples`]);
      await new Promise((r) => setTimeout(r, 15000));
    }
    const summary = summarizeRun(id);
    print(["", ...soakTable(summary), ""]);
    return;
  }
  if (has("--once") || !process.stdin.isTTY) {
    process.stdout.write("\x1b[H\x1b[2J");
    render();
    process.stdout.write("\n");
    return;
  }

  // interactive
  process.stdout.write("\x1b[?25l\x1b[2J");
  render();
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => {
      for (const ch of d) handleKey(ch).catch((e) => say(String(e?.message || e), "bad", 8000));
    });
  }
  let tick = 0;
  setInterval(() => {
    tick++;
    if (!ui.busy && (tick % 30 === 0) && !soakStatus()?.running) {
      // refresh system state every ~30 s, quietly
      refreshCore().catch(() => {});
    }
    render();
    const st = soakStatus();
    if (st && !st.running && ui.soak?.runId && !ui.soak.summary) {
      const s = summarizeRun(ui.soak.runId);
      if (s && s.targets) {
        ui.soak.summary = s;
        say(`Soak #${s.runId} finished — ${s.samples} samples.`, "good");
      }
    }
  }, 1000);
}

main().catch((err) => {
  process.stdout.write(`\nPingLab failed: ${err?.message || err}\n`);
  process.exitCode = 1;
});
