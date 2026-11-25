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
 *   node pinglab.mjs --bloat    bufferbloat test, download and upload
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

import { snapshot, dnsServers, adapters } from "./lib/net.mjs";
import { runProbe as probeOnce, summarizeProbe } from "./lib/probe.mjs";
import { bufferbloat } from "./lib/bufferbloat.mjs";
import { benchmark as dnsBenchmark } from "./lib/dns.mjs";
import { scanFreshnessText } from "./lib/report.mjs";
import { tweakState, runTweakAction, tweakOutcome, pendingTweaks, auditRows, applyPreset, knownActions, actionSpec, elevationCommand, elevationText, backupStatus } from "./lib/tweaks.mjs";
import { driftStatus } from "./lib/drift.mjs";
import { TWEAKS, PRESETS, RISK, presetById, presetTweaks, validateCatalog } from "./lib/catalog.mjs";
import { loadConfig, DEFAULT_ENDPOINTS } from "./lib/config.mjs";
import { adapterChoices } from "./lib/target.mjs";
import { analyseWifi, wifiAdvice, bandOf, scanWifi } from "./lib/wifi.mjs";
import { saveRun, previousRun, listRuns, dbStatus } from "./lib/db.mjs";
import { startSoak, stopSoak, soakStatus, summarizeRun, listSoakRuns, soakLabel } from "./lib/soak.mjs";
import { isElevated } from "./lib/ps.mjs";
import { checkForUpdate, currentVersion } from "./lib/update.mjs";
import {
  R,
  B,
  D,
  RED,
  GRN,
  YEL,
  CYN,
  vis,
  pad,
  padL,
  wrapText,
} from "./lib/tui-format.mjs";
import { createViews } from "./lib/tui-views.mjs";
import { createBridge } from "./lib/gui-bridge.mjs";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
try {
  process.chdir(ROOT); // data/ paths in the engine modules resolve from here
} catch {}

/* ----------------------------------------------------------- update check */

/**
 * Asked once per process, in the background: no view waits for GitHub. A check that cannot be
 * made leaves `pending` or `checked: false` and no sentence, so nothing is ever called current
 * without having compared it.
 */
let updateInfo = { checked: false, pending: true };
checkForUpdate({ url: process.env.PINGLAB_UPDATE_URL || undefined }).then((result) => {
  updateInfo = result;
});

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
  bloat: null,
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
  // The adapter settings are aimed at is a saved choice, so the terminal, the GUI and the page
  // read the same one. The default route only decides it when nothing was chosen.
  const pick = adapterChoices({
    adapters: connection?.adapters,
    routes: connection?.routes,
    activeRoute: connection?.activeRoute,
    chosen: config.adapter,
  });
  const alias = pick.target?.alias || null;
  const tw = alias ? await tweakState(alias, { dns: connection?.dns }) : null;
  ui.core = {
    connection,
    alias,
    target: pick.target,
    adapterChoices: pick.choices,
    targetFallback: pick.fallback,
    tw,
    pending: pendingTweaks(),
    // A change PingLab made that Windows has since put back, so the fixes view can say it
    // above the rows instead of leaving the contradiction to be noticed.
    drift: driftStatus(tw),
    // A settings file that could not be used travels with the state, so the dashboard prints
    // it in the same sentence the page and the GUI use.
    configProblem: config.problem,
    // The last before/after comparison and the last rollback, so a change can be reviewed and
    // an undo reported here with the sentence the page shows - including what is still applied.
    benchmark: {
      latest: listRuns("benchmark", 1)[0] ?? null,
      lastRevert: listRuns("benchmark-revert", 1)[0] ?? null,
    },
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
  const { results, icmp, udp } = await probeOnce(endpoints, {
    onProgress: (endpoint) => {
      ui.busy = `measuring ${endpoint.label}…`;
    },
  });
  const summary = summarizeProbe({ results, icmp, udp });
  saveRun("probe", `avg ${summary.gameAvgMs ?? "?"} ms, loss ${summary.gameLoss ?? "?"}%`, { results, icmp, udp, summary });
  ui.probe = { results, icmp, udp, summary, previous: previousRun("probe"), at: Date.now() };
  ui.busy = null;
  say(`Probe done — game avg ${summary.gameAvgMs ?? "?"} ms.`, "good");
  ui.core = null;
  await refreshCore();
}

async function runScan() {
  ui.busy = "scanning Wi-Fi…";
  ui.view = "wifi";
  // The engine resolves the Wi-Fi adapter and asks Windows for a scan before reading the list;
  // the result says whether Windows confirmed that scan.
  const scan = await scanWifi();
  ui.scan = { scan, at: Date.now() };
  ui.busy = null;
  // A confirmed scan is dated; without one the list stands alone and no freshness is claimed.
  // Either way every count in the advice stays scoped to this scan.
  if (!scan?.ok) say(scan?.reason || "Wi-Fi scan failed.", "bad", 9000);
}

async function runDns() {
  ui.busy = "benchmarking resolvers…";
  ui.view = "dns";
  const result = await dnsBenchmark();
  const current = (await dnsServers()).find((d) => d.servers?.length) || null;
  saveRun("dns", result.bestLabel ? `fastest ${result.bestLabel}` : "no clear winner", result);
  ui.dns = { result, current, at: Date.now() };
  ui.busy = null;
  say(`Fastest resolver: ${result.bestLabel ?? "unknown"}.`, result.bestLabel ? "good" : "warn");
}

/**
 * Bufferbloat in both directions. The terminal used to have no way to run this test at
 * all, so "ping under load" existed only in the web UI; the same engine call now feeds
 * the terminal, the GUI and the page.
 */
async function runBloat() {
  ui.busy = "loading the line (download, then upload)…";
  ui.view = "probe";
  const result = await bufferbloat({ seconds: 6, direction: "both" });
  saveRun("bufferbloat", `grade ${result.overallGrade} (down ${result.download?.grade ?? "n/a"}, up ${result.upload?.grade ?? "n/a"})`, result);
  ui.bloat = { result, at: Date.now() };
  ui.busy = null;
  say(
    result.overallGrade === "n/a" ? "Bufferbloat could not be measured." : `Bufferbloat: worst direction grade ${result.overallGrade}.`,
    result.overallGrade === "n/a" ? "warn" : "good",
  );
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


const { VIEWS, TITLES, footer, fixState, chooseAdapter, saveTargetAdapter } = createViews({ ui, refreshCore, say });

function render() {
  const W = Math.max(64, Math.min(process.stdout.columns || 100, 118));
  // The frame is drawn to exactly this height. One line more and the terminal scrolls, which
  // pushes the title - and the damaged-database warning above it - off the top where nobody
  // sees it. Piped output has no window size, so it keeps the 32 lines it always drew.
  const H = Math.max(12, process.stdout.rows || 32);
  const lines = [];
  lines.push("");
  const busy = ui.busy ? `  ${YEL}⟳ ${ui.busy}${R}` : "";
  // The version is the one package.json says, so a copy that was upgraded - or one that was
  // not - is visible on the dashboard instead of inferred from a release date.
  const version = currentVersion();
  lines.push(` ${B}${CYN}PingLab${R}${version ? ` ${D}v${version}${R}` : ""} ${D}· network doctor${R}${busy}`);
  lines.push(` ${D}${"─".repeat(W - 2)}${R}`);
  // A database that had to be set aside is not a silent reset. The dashboard is a normal way
  // to start PingLab, so the warning stays at the top of every view for the whole run, in the
  // same sentence --audit, --self-check, the GUI and the page use.
  const history = dbStatus();
  if (history.problem) {
    wrapText(history.problem.message, W - 6).forEach((l, i) => {
      lines.push(` ${i === 0 ? `${YEL}!${R}` : " "} ${YEL}${l}${R}`);
    });
  }
  // The endpoint list falling back to the built-in one because the settings file could not be
  // used is reported the same way, in the same sentence every other surface prints.
  const configProblem = ui.core?.configProblem;
  if (configProblem) {
    wrapText(configProblem.message, W - 6).forEach((l, i) => {
      lines.push(` ${i === 0 ? `${YEL}!${R}` : " "} ${YEL}${l}${R}`);
    });
  }
  // A newer release is one line, in the same sentence the page and the GUI show. Nothing is
  // printed for a copy that is current, and nothing at all when the check could not be made.
  if (updateInfo.sentence) {
    wrapText(updateInfo.sentence, W - 6).forEach((l, i) => {
      lines.push(` ${i === 0 ? `${CYN}↑${R}` : " "} ${CYN}${l}${R}`);
    });
  }
  // Both are reported, not just the newer one: the rollback comes first because it is the
  // newer event and says what is still applied, and the comparison it undid stays visible so
  // "why was this rolled back" has an answer without a history command.
  const bench = ui.core?.benchmark;
  const benchLines = [];
  if (bench?.lastRevert?.summary) benchLines.push({ mark: "↩", tone: YEL, text: bench.lastRevert.summary });
  if (bench?.latest?.summary) benchLines.push({ mark: "⇄", tone: D, text: bench.latest.summary });
  for (const item of benchLines) {
    wrapText(item.text, W - 6).forEach((l, i) => {
      lines.push(` ${i === 0 ? `${item.tone}${item.mark}${R}` : " "} ${item.tone}${l}${R}`);
    });
  }
  lines.push(` ${D}${TITLES[ui.view] || ""}${R}`);
  const body = (VIEWS[ui.view] || viewDash)(W).flatMap((entry) => String(entry).split("\n"));
  // A view taller than the window is clipped instead of being allowed to scroll the frame,
  // and the line that says how much is missing is part of the frame, so nothing can hide the
  // warning by making a view long.
  const room = H - 2 - lines.length;
  const shown = body.length > room ? body.slice(0, Math.max(0, room - 1)) : body;
  for (const l of shown) {
    lines.push(l.includes("\x1b") || l === "" ? l : ` ${D}${l}${R}`);
  }
  if (body.length > shown.length && room >= 2) {
    const dropped = body.length - shown.length;
    lines.push(` ${YEL}… ${dropped} more line${dropped === 1 ? "" : "s"} than this ${H}-row window holds${R}`);
  }
  while (lines.length < H - 2) lines.push("");
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
      say("Keys: p probe, b bufferbloat, w wifi, d dns, t soak, f fixes, a adapters, h history, r refresh, q quit", "info", 12000);
      return;
    case "p":
      return runProbe();
    case "b":
      return runBloat();
    case "w":
      return runScan();
    case "d":
      return runDns();
    case "t":
      return soakStatus()?.running ? soakStop() : soakStart(10);
    case "f":
      ui.view = "fixes";
      return;
    case "a":
      ui.view = "adapters";
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
  if (ui.view === "adapters") {
    const n = Number(ch);
    const pick = Number.isInteger(n) && n >= 1 ? (ui.core?.adapterChoices || [])[n - 1] : null;
    if (pick) return chooseAdapter(pick.alias);
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
  for (const [kind, text] of wifiAdvice(a, ui.core?.connection?.wifi || {}, scanData.scan)) print([`  ${text}`]);
  // The one-shot CLI path prints the scan confirmation too, from the same sentence the
  // interactive view, the page and the GUI use.
  const freshness = scanFreshnessText(scanData.scan?.freshness);
  if (freshness) print(["", `  ${freshness}`]);
  print([""]);
}


const { bridge } = createBridge({ ui, refreshCore, runProbe, runScan, runDns, soakStart, soakStop, runTweak, say, saveTargetAdapter, getUpdateInfo: () => updateInfo, root: ROOT });

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
      "  node pinglab.mjs --view NAME   draw one dashboard view once: dash, fixes, adapters, probe, wifi, dns, soak, history",
      "  node pinglab.mjs --wifi        Wi-Fi channel & band diagnosis",
      "  node pinglab.mjs --probe       latency to game endpoints",
      "  node pinglab.mjs --bloat       bufferbloat, download and upload",
      "  node pinglab.mjs --dns         DNS resolver benchmark",
      "  node pinglab.mjs --soak [min]  soak test (default 10 min)",
      "  node pinglab.mjs --fixes       show reversible fixes",
      "  node pinglab.mjs --presets     named presets and exactly what each applies",
      "  node pinglab.mjs --preset X    X = safe | latency (applies that preset)",
      "  node pinglab.mjs --audit       every managed setting vs what Windows reports",
      "  node pinglab.mjs --self-check  catalog, presets, dispatch and live state, no changes",
      "  node pinglab.mjs --apply X     X = plan | nic | nagle | wifi | order",
      "  node pinglab.mjs --revert X    undo one fix",
      "  node pinglab.mjs --adapter X   aim the settings at adapter X (saved for every surface)",
      "  node pinglab.mjs --restore     restore everything PingLab changed",
      "  node pinglab.mjs --json        raw snapshot as JSON",
      "",
    ]);
    return;
  }

  if (has("--bridge")) return bridge(has("--out") ? after("--out") : null);

  // Which adapter settings are aimed at is saved, not passed per call: aim it once and every
  // surface - this terminal, the GUI and the page - reads the same device.
  if (has("--adapter")) {
    const saved = await saveTargetAdapter(after("--adapter"));
    if (!saved.ok) {
      print([saved.error]);
      process.exitCode = 1;
      return;
    }
    await refreshCore();
    print([`settings apply to ${ui.core?.target?.alias || saved.adapter}`]);
    return;
  }

  await refreshCore();

  if (has("--json")) {
    print([
      JSON.stringify(
        {
          connection: ui.core.connection,
          target: ui.core.target,
          adapterChoices: ui.core.adapterChoices,
          tweak: ui.core.tw,
          pending: ui.core.pending,
          drift: ui.core.drift,
        },
        null,
        2,
      ),
    ]);
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
    // Drift is not a mismatch: the app reads Windows correctly, and what it reads is a setting
    // that is no longer the one PingLab left there. It gets its own section for that reason.
    const drift = driftStatus(tw);
    lines.push("", ` ${B}drift${R} — changes PingLab made that are no longer in place`);
    if (!drift.count) {
      lines.push(`  ${D}none: every change PingLab made is still in place${R}`);
    } else {
      lines.push(`  ${YEL}${drift.text}${R}`);
      for (const r of drift.drifted) lines.push(`   ${D}·${R} ${r.setting}: ${r.observation}`);
    }
    for (const r of drift.rows.filter((x) => x.state === "unknown")) {
      lines.push(`   ${D}? ${r.setting}: ${r.observation}${R}`);
    }
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
    // Read-only: drift is the user's machine, not a bug in the app, so it is reported and
    // never counted as a self-check failure.
    const driftNow = driftStatus(tw);
    lines.push(
      `  drift        ${driftNow.count ? `${driftNow.count} change(s) no longer in place - see --audit` : "every change PingLab made is still in place"}`,
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
  if (has("--bloat")) {
    await runBloat();
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
  // One view of the dashboard, drawn once: the same frame the keys draw, so what a support
  // report or a test sees is what the interactive session shows. Handled before the
  // "stdin is not a terminal" fallback, which only ever draws the overview.
  if (has("--view")) {
    const name = String(after("--view") || "");
    if (!VIEWS[name]) {
      print([`Unknown view "${name}". Known views: ${Object.keys(VIEWS).join(", ")}.`]);
      process.exitCode = 2;
      return;
    }
    ui.view = name;
    process.stdout.write("\x1b[H\x1b[2J");
    render();
    process.stdout.write("\n");
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
