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
import { tweakState, runTweakAction, tweakOutcome, pendingTweaks, auditRows } from "./lib/tweaks.mjs";
import { loadConfig, DEFAULT_ENDPOINTS } from "./lib/config.mjs";
import { analyseWifi, wifiAdvice, bandOf, scanWifi } from "./lib/wifi.mjs";
import { saveRun, previousRun, listRuns } from "./lib/db.mjs";
import { startSoak, stopSoak, soakStatus, summarizeRun, listSoakRuns, soakLabel } from "./lib/soak.mjs";

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

// One table for the three reversible fixes: [apply, revert] by the key that toggles them.
const FIX_ACTIONS = {
  "1": ["plan-power-off", "plan-power-on"],
  "2": ["nic-power-off", "nic-power-on"],
  "3": ["nagle-off", "nagle-on"],
  "4": ["adapter-tuning-off", "adapter-tuning-on"],
  "5": ["wifi-order-first", "wifi-order-restore"],
};
const FIX_KEY_BY_NAME = { plan: "1", nic: "2", nagle: "3", wifi: "4", order: "5" };

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

function viewFixes(W) {
  const tw = ui.core?.tw;
  if (!tw) return ["", ` ${D}reading system state…${R}`];
  const items = [
    {
      key: "1",
      on: tw.planPower === "off",
      title: "Wireless power saving (power plan)",
      state: tw.planPower === "off" ? `maximum performance` : `${tw.planDetail || tw.planPower}`,
      detail: "Power Options → Wireless Adapter Settings → Power Saving Mode.",
      action: tw.planPower === "off" ? "plan-power-on" : "plan-power-off",
    },
    {
      key: "2",
      on: tw.nicPower === "off",
      title: "NIC power management (device)",
      state: tw.nicPower === "unsupported" ? "not available on this adapter" : tw.nicDetail || tw.nicPower,
      detail: tw.nicPower === "unsupported" ? "Driver exposes no power-management setting." : "Allow the computer to turn off this device.",
      action: tw.nicPower === "off" ? "nic-power-on" : "nic-power-off",
      disabled: tw.nicPower === "unsupported" || tw.nicPower === "unknown",
    },
    {
      key: "3",
      on: tw.nagleDisabled === true,
      title: "Nagle's algorithm",
      state: tw.nagleDisabled ? "disabled" : "on",
      detail: `TcpAckFrequency=${tw.nagleValues?.tcpAckFrequency ?? "—"}, TCPNoDelay=${tw.nagleValues?.tcpNoDelay ?? "—"}`,
      action: tw.nagleDisabled ? "nagle-on" : "nagle-off",
    },
    {
      key: "4",
      on: tw.adapterTuning ? !tw.adapterTuning.needsFix : false,
      title: "Wi-Fi radio power save (desktop)",
      state: !tw.adapterTuning
        ? "not readable on this adapter"
        : tw.adapterTuning.needsFix
          ? "not tuned for a fixed desktop"
          : `tuned: ${tw.adapterTuning.items.map((i) => i.display).join(", ")}`,
      detail: !tw.adapterTuning
        ? "The driver exposes neither setting."
        : `Now ${tw.adapterTuning.items.map((i) => i.display).join(", ")}. ${
            tw.adapterTuning.needsFix ? tw.adapterTuning.reason : "Applied on request; no soak here has shown a gain."
          }`,
      action: tw.adapterTuning && !tw.adapterTuning.needsFix ? "adapter-tuning-on" : "adapter-tuning-off",
      disabled: !tw.adapterTuning,
    },
    {
      key: "5",
      on: Boolean(tw.wifiOrder?.appliedByUs && tw.wifiOrder?.isFirst),
      title: "Wi-Fi auto-connect order",
      state: !tw.wifiOrder
        ? "not the wireless adapter"
        : !tw.wifiOrder.readable
          ? "profile list unreadable"
          : tw.wifiOrder.isFirst
            ? `first: ${tw.wifiOrder.target}`
            : tw.wifiOrder.target
              ? `${tw.wifiOrder.target} is #${tw.wifiOrder.position} of ${tw.wifiOrder.profiles.length}`
              : "not joined to a saved profile",
      detail: !tw.wifiOrder || !tw.wifiOrder.readable
        ? "netsh wlan show profiles reported nothing to reorder."
        : `Order: ${tw.wifiOrder.profiles.slice(0, 4).join(" > ")}${tw.wifiOrder.profiles.length > 4 ? " > …" : ""}. Windows rejoins the first profile it can see after an adapter reset.`,
      action: tw.wifiOrder?.appliedByUs && tw.wifiOrder?.isFirst ? "wifi-order-restore" : "wifi-order-first",
      disabled: !tw.wifiOrder || !tw.wifiOrder.readable,
    },
  ];
  const out = [""];
  for (const it of items) {
    const mark = it.disabled ? `${GRY}⨯${R}` : it.on ? `${GRN}✓${R}` : `${GRY}–${R}`;
    out.push(`  ${INV} ${it.key} ${R} ${mark} ${B}${it.title}${R}`);
    out.push(`       ${D}${it.state}${R}`);
    out.push(`       ${D}${it.detail}${R}`);
    out.push("");
  }
  out.push(`  ${D}Press 1-5 to apply or revert. A applies every fix behind one admin prompt. R restores everything PingLab changed.${R}`);
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
    const line = `${pad(n.ssid, 24)}${padL(bandOf(n.channel) || "?", 8)}${padL(n.channel ?? "?", 5)}${padL((n.signal ?? "?") + "%", 8)}`;
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
      const tw = ui.core?.tw || {};
      const isOn = {
        "1": tw.planPower === "off",
        "2": tw.nicPower === "off",
        "3": tw.nagleDisabled === true,
        "4": tw.adapterTuning ? !tw.adapterTuning.needsFix : false,
        "5": Boolean(tw.wifiOrder?.appliedByUs && tw.wifiOrder?.isFirst),
      }[ch];
      return runTweak(pair[isOn ? 1 : 0]);
    }
    if (ch === "A") return runTweak("apply-all");
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
  print(a.nets.map((n) => `  ${pad(n.ssid, 24)} ${pad(bandOf(n.channel) || "?", 8)} ch ${padL(n.channel ?? "?", 3)}  ${n.signal ?? "?"}%`));
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
      await runTweak(String(args.action || ""));
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
  const outFile = outPath ? resolve(ROOT, outPath) : join(ROOT, "data", `bridge-out.${process.pid}.jsonl`);
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
      "  node pinglab.mjs --audit       every managed setting vs what Windows reports",
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
  if (has("--audit")) {
    const tw = ui.core?.tw;
    const rows = auditRows(tw);
    const pending = ui.core?.pending || { items: [], count: 0 };
    const w1 = 35, w2 = 33, w3 = 24;
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
    lines.push("", ` ${B}restore points (${pending.count}) — changes PingLab can undo, not outstanding work${R}`);
    if (!pending.count) lines.push(`  ${D}none: this machine is at its original values${R}`);
    for (const it of pending.items || []) {
      lines.push(`  ${D}·${R} ${it.label} (${it.alias}) → ${it.changedTo}`);
      lines.push(`    ${D}restore-all would set: ${it.restoreWillSet}${R}`);
    }
    lines.push("");
    print(lines);
    return;
  }
  if (has("--apply") || has("--revert")) {
    const which = after(has("--apply") ? "--apply" : "--revert");
    const on = has("--apply");
    const action = FIX_ACTIONS[FIX_KEY_BY_NAME[which]]?.[on ? 0 : 1];
    if (!action) {
      print([`Unknown fix "${which}". Use plan, nic, nagle, wifi or order.`]);
      process.exitCode = 1;
      return;
    }
    ui.busy = null;
    await runTweak(action);
    print([ui.message?.text || "done"]);
    await refreshCore();
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
