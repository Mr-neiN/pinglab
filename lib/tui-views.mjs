import { analyseWifi, wifiAdvice, bandOf } from "./wifi.mjs";
import { bloatVerdict, transportText, udpText, udpCaveatText, scanFreshnessText } from "./report.mjs";
import { UDP_POLICY } from "./probe.mjs";
import { verdictText, winnerChip } from "./dns.mjs";
import { soakStatus, summarizeRun, listSoakRuns } from "./soak.mjs";
import { RISK, presetsFor, TWEAKS } from "./catalog.mjs";
import { adapters } from "./net.mjs";
import { saveAdapter } from "./config.mjs";
import { R, B, D, RED, GRN, YEL, CYN, GRY, INV, pad, padL, n1, n0, clock, colour, wrapText, box, kv } from "./tui-format.mjs";

/** The catalog owns the rows; this module only draws them. */
export function createViews({ ui, refreshCore, say }) {
  const FIX_ROWS = TWEAKS.filter((t) => t.id !== "dns");
/* ---------------------------------------------------------------- drawing */

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
      ["applies to", `${ui.core?.target?.alias || "—"}${ui.core?.target?.defaultRoute ? " (default route)" : ""}${ui.core?.target?.virtual ? " (virtual / VPN)" : ""}`],
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
  // A setting PingLab wrote that Windows has since put back is the one thing a reader of this
  // view cannot work out from the rows alone: "now" and the restore points both look fine.
  const drift = ui.core?.drift;
  if (drift?.count) {
    const sentences = wrapText(drift.text, width);
    out.push(`  ${YEL}${sentences[0]}${R}`);
    for (const line of sentences.slice(1)) out.push(`  ${YEL}${line}${R}`);
    for (const r of drift.drifted) out.push(`   ${D}·${R} ${r.setting}: ${r.observation}`);
    out.push("");
  }
  const target = ui.core?.target;
  if (target) {
    out.push(
      `  ${D}changes:${R} ${B}${target.alias}${R}${target.defaultRoute ? ` ${D}(default route)${R}` : ""}${target.virtual ? ` ${YEL}(virtual / VPN)${R}` : ""}  ${D}a picks a different adapter${R}`,
    );
    if (target.note) for (const line of wrapText(target.note, width)) out.push(`  ${D}${line}${R}`);
    out.push("");
  }
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

/** Which adapter the settings are aimed at, and the one press that changes it. */
function viewAdapters(W) {
  const choices = ui.core?.adapterChoices || [];
  const target = ui.core?.target;
  const width = Math.max(52, Math.min(W - 12, 92));
  const out = [""];
  if (!choices.length) return [...out, `  ${D}No adapter was found on this machine.${R}`];
  out.push("");
  choices.forEach((c, i) => {
    const mark = c.alias === target?.alias ? `${GRN}✓${R}` : `${GRY}–${R}`;
    const tags = [
      c.defaultRoute ? "default route" : null,
      c.virtual ? "virtual / VPN" : null,
      c.status && c.status !== "Up" ? c.status : null,
    ].filter(Boolean);
    out.push(
      `  ${INV} ${i + 1} ${R} ${mark} ${B}${c.alias}${R}${c.description ? ` ${D}${c.description}${R}` : ""}${tags.length ? ` ${YEL}(${tags.join(", ")})${R}` : ""}`,
    );
  });
  if (target?.note) {
    out.push("");
    for (const line of wrapText(target.note, width)) out.push(`  ${D}${line}${R}`);
  }
  out.push("");
  out.push(`  ${D}Press a number to aim every setting at that adapter. Virtual and VPN adapters are listed last; choosing one is deliberate.${R}`);
  return out;
}

/** Save a pick, but only for an adapter this machine actually has. */
async function saveTargetAdapter(name) {
  const wanted = String(name || "").trim();
  const known = (await adapters()).find((a) => a.name === wanted);
  if (!known) return { ok: false, error: `"${wanted}" is not an adapter on this machine.` };
  return saveAdapter(known.name);
}

/** Save the pick, so every surface reads the same adapter from then on. */
async function chooseAdapter(alias) {
  const saved = await saveTargetAdapter(alias);
  if (!saved.ok) return say(saved.error || "That adapter could not be selected.", "bad");
  await refreshCore();
  say(`Settings now apply to ${ui.core?.target?.alias || alias}.`, "good", 4000);
}

/** The bufferbloat block, shown even when no latency probe has been run. */
function bloatLines(W) {
  const b = ui.bloat?.result;
  if (!b) return [];
  const out = ["", `  ${B}Bufferbloat${R} ${D}ping while the line is busy${R}`];
  for (const [name, phase] of [
    ["download", b.download],
    ["upload", b.upload],
  ]) {
    if (!phase) continue;
    out.push(
      `  ${pad(name, 10)}${phase.grade === "n/a" ? `${YEL}n/a${R}` : `${colour(phase.deltaMs, 29, 99)}grade ${phase.grade}${R}`} ${D}${n0(phase.deltaMs)} ms added · ${n1(phase.mbps)} Mbps${R}`,
    );
  }
  const note = bloatVerdict(b);
  if (note) for (const line of wrapText(note, W - 4)) out.push(`  ${D}${line}${R}`);
  return out;
}

function viewProbe(W) {
  const p = ui.probe;
  if (!p) return ["", ` ${D}no probe yet — press p${R}`, ...bloatLines(W)];
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
  out.push(
    `  ${D}game-server RTT${R} ${B}${n1(p.summary.gameAvgMs)} ms${R} ${D}(UDP, only where the service answered)   jitter${R} ${n1(p.summary.gameJitter)} ms   ${D}loss${R} ${n1(p.summary.gameLoss)}%   ${D}reachable${R} ${p.summary.reachable}/${p.summary.endpoints}`,
  );
  if (p.icmp?.length) {
    out.push("");
    out.push(
      `  ${D}ICMP echo (network path): ${p.icmp.map((i) => `${i.host} avg ${n1(i.avg)} ms · jitter ${n1(i.jitter)} ms · ${n0(i.loss)}% loss`).join(" · ")}${R}`,
    );
    const note = transportText(p.summary.transport);
    if (note) for (const line of wrapText(note, W - 4)) out.push(`  ${D}${line}${R}`);
  }
  if (p.udp?.length) {
    out.push("");
    // Endpoints that publish no query were not probed; the note below counts them.
    const udpProbed = p.udp.filter((u) => u.state !== "no-query");
    const rows = udpProbed.map((u) => {
      if (u.state === "answered") {
        return `${u.label} (game server): ${n1(u.avg)} ms · jitter ${n1(u.jitter)} ms · ${n0(u.loss)}% loss${
          u.challenged ? " · after a challenge" : ""
        }`;
      }
      if (u.state === "closed") return `${u.label}: port closed${u.pathMs === null ? "" : ` (path ${n1(u.pathMs)} ms)`}`;
      if (u.state === "unexpected") return `${u.label}: not this probe's reply (untimed)`;
      return `${u.label}: no UDP reply`;
    });
    if (rows.length) {
      out.push(
        `  ${D}UDP (${udpProbed.length} game endpoint${udpProbed.length === 1 ? "" : "s"}): ${rows.join(" · ")}${R}`,
      );
    }
    const note = udpText(p.summary.udp);
    if (note) for (const line of wrapText(note, W - 4)) out.push(`  ${D}${line}${R}`);
    for (const line of wrapText(udpCaveatText(UDP_POLICY), W - 4)) out.push(`  ${D}${line}${R}`);
  }
  out.push(...bloatLines(W));
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
  for (const [kind, text] of wifiAdvice(a, wifi, s.scan)) {
    const c = kind === "good" ? GRN : kind === "warn" ? YEL : kind === "bad" ? RED : kind === "dim" ? D : CYN;
    out.push(`  ${c}${text}${R}`);
  }
  out.push("");
  const freshness =
    scanFreshnessText(s.scan.freshness) ||
    "This is only the list netsh returned; no fresh-or-cached verdict is claimed.";
  out.push(
    `  ${D}snapshot ${clock(s.at)} — ${freshness} signal % is coarse and hidden SSIDs are undercounted. s rescans.${R}`,
  );
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
  const nav = "p probe · b bloat · w wi-fi · d dns · t soak · f fixes · h history · r refresh · ? help · q quit";
  const back = view === "dash" ? "" : "esc back · ";
  return `${D}${back}${nav}${R}`;
}

const VIEWS = { dash: viewDash, fixes: viewFixes, adapters: viewAdapters, probe: viewProbe, wifi: viewWifi, dns: viewDns, soak: viewSoak, history: viewHistory };
const TITLES = {
  dash: "Overview",
  fixes: "Fixes — reversible, each with a stored backup",
  adapters: "Which adapter settings are aimed at",
  probe: "Latency to the endpoints that matter",
  wifi: "Wi-Fi channel & band diagnosis",
  dns: "DNS resolver benchmark",
  soak: "Soak test — sustained jitter & loss",
  history: "Recent runs",
};


  return { VIEWS, TITLES, viewDash, viewFixes, viewAdapters, viewProbe, viewWifi, viewDns, viewSoak, viewHistory, footer, fixState, saveTargetAdapter, chooseAdapter };
}
