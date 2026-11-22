const $ = (id) => document.getElementById(id);

const state = {
  connection: null,
  tweak: null,
  pending: null,
  endpoints: [],
  catalog: null,
  probe: null,
  bloat: null,
  dns: null,
  scan: null,
  alias: null,
};

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const num = (v, d = 1) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "—");
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

function timeOf(iso) {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

let toastTimer = null;
function toast(message, kind = "") {
  const el = $("toast");
  el.textContent = message;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add("hidden"), 5200);
}

// Written into the page by the server on every load. It is this run's only key to the API,
// and it is why another site cannot drive the app: it cannot read this page to get it.
const TOKEN = document.querySelector('meta[name="pinglab-token"]')?.content || "";

async function api(path, body) {
  try {
    const headers = { "X-PingLab-Token": TOKEN };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return await res.json();
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
}

function busy(btn, on, label) {
  if (!btn) return;
  if (on) {
    btn.dataset.idle = btn.textContent;
    btn.textContent = label || "Working…";
    btn.disabled = true;
  } else {
    btn.textContent = btn.dataset.idle || btn.textContent;
    btn.disabled = false;
  }
}

/* ------------------------------------------------------------------ verdict */

function collectIssues() {
  const issues = [];
  const s = state.probe?.summary;
  if (s) {
    if (s.gameLoss >= 1.5)
      issues.push({ sev: 3, text: `You are losing ${num(s.gameLoss)}% of packets toward game services. That is what causes rubber-banding and shots that do not register — fix this before anything else.` });
    if (s.gameJitter >= 12)
      issues.push({ sev: 2, text: `Jitter of ${num(s.gameJitter)} ms: your ping is unstable, which usually feels worse than a higher but steady ping.` });
    if (typeof s.gameAvgMs === "number" && s.gameAvgMs > 90)
      issues.push({ sev: 2, text: `Average ${num(s.gameAvgMs, 0)} ms to game services is high for EU. That is distance and ISP routing, not something on your PC.` });
  }
  const b = state.bloat;
  if (b && b.grade) {
    if (b.grade === "D" || b.grade === "F")
      issues.push({ sev: 3, text: `Bufferbloat grade ${b.grade}: ping rises by ${num(b.deltaMs, 0)} ms as soon as the line is busy. Anyone streaming or downloading will spike your game.` });
    else if (b.grade === "C" || b.grade === "B")
      issues.push({ sev: 1, text: `Under load your ping rises ${num(b.deltaMs, 0)} ms (grade ${b.grade}). Not fatal, but it explains the odd spike.` });
  }
  const w = state.connection?.wifi;
  if (w?.connected) {
    if (typeof w.signalPct === "number" && w.signalPct < 55)
      issues.push({ sev: 2, text: `Wi-Fi signal is only ${w.signalPct}%. Weak signal is the most common cause of lag spikes — move closer or run a cable.` });
    if (w.band === "2.4 GHz")
      issues.push({ sev: 1, text: `You are on the crowded 2.4 GHz band (channel ${w.channel ?? "?"}). Switch to 5 GHz for lower latency and less interference.` });
  }
  const d = state.dns;
  if (d?.result?.best && d.result.resolvers?.length) {
    const best = d.result.resolvers.find((r) => r.id === d.result.best);
    const current = (state.connection?.dnsForActive?.servers || []).join(",");
    if (best && !current.includes(best.servers[0]) && best.avg !== null && best.avg < 40) {
      issues.push({ sev: 1, text: `${best.label} resolves faster than your current DNS (${num(best.avg, 0)} ms average). That helps store pages and sign-ins, not in-game ping.` });
    }
  }
  return issues.sort((a, b) => b.sev - a.sev);
}

function updateVerdict() {
  const el = $("verdict");
  const text = $("verdictText");
  const issues = collectIssues();
  if (!state.probe && !state.bloat) {
    el.className = "verdict";
    text.textContent = "No measurement yet. Run the test to see what is actually limiting your connection.";
    return;
  }
  if (!issues.length) {
    el.className = "verdict verdict-good";
    text.textContent =
      "No significant problem found in what was measured: latency, loss and Wi-Fi look healthy. If a game still feels bad, the bottleneck is your ISP's route to that specific server — that is outside your control.";
    return;
  }
  const worst = issues[0];
  const extra = issues.slice(1, 3).map((i) => i.text);
  el.className = `verdict ${worst.sev >= 3 ? "verdict-bad" : "verdict-warn"}`;
  text.textContent = [worst.text, ...extra].join(" ");
}

/* --------------------------------------------------------------- connection */

function renderLink() {
  const c = state.connection;
  const pill = $("linkPill");
  if (!c?.activeAdapter) {
    pill.className = "pill pill-idle";
    pill.textContent = "no active adapter";
    return;
  }
  const speed = c.activeAdapter.linkSpeedMbps;
  const speedText = speed ? (speed >= 1000 ? `${num(speed / 1000, 1)} Gbps` : `${num(speed, 0)} Mbps`) : "?";
  if (c.usingWifi) {
    const sig = c.wifi?.signalPct;
    pill.className = "pill pill-wifi";
    pill.textContent = `Wi-Fi · ${speedText}${typeof sig === "number" ? ` · signal ${sig}%` : ""}`;
  } else {
    pill.className = "pill pill-cable";
    pill.textContent = `Ethernet · ${speedText}`;
  }
}

function signalClass(pct) {
  if (typeof pct !== "number") return "dim";
  if (pct >= 70) return "ok";
  if (pct >= 50) return "warn";
  return "bad";
}

function renderConnection() {
  const c = state.connection;
  const box = $("connectionBox");
  const hint = $("wifiHint");
  if (!c?.activeAdapter) {
    box.innerHTML = `<p class="empty">No active network route found.</p>`;
    hint.classList.add("hidden");
    return;
  }
  const a = c.activeAdapter;
  const w = c.wifi;
  const tp = c.throughput;
  const dns = c.dnsForActive?.servers?.length ? c.dnsForActive.servers.join(", ") : "automatic (DHCP)";

  const rows = [
    ["Adapter", esc(a.name)],
    ["Type", c.usingWifi ? "Wi-Fi" : "Ethernet"],
    ["Link speed", esc(a.linkSpeedText || "unknown")],
    ["Default route", `${esc(c.activeRoute?.alias || "?")} → ${esc(c.activeRoute?.nextHop || "?")}`],
    ["Live traffic", tp ? `<span class="ok">↓ ${num(tp.downMbps)}</span> / ↑ ${num(tp.upMbps)} Mbps` : "—"],
    ["DNS", esc(dns)],
    [
      "Power plan · wireless power saving",
      state.tweak?.planPower === "off"
        ? '<span class="ok">off</span>'
        : state.tweak?.planPower === "on"
          ? `<span class="warn">on</span> — ${esc(state.tweak.planDetail)}`
          : '<span class="dim">unknown</span>',
    ],
    [
      "NIC power management",
      state.tweak?.nicPower === "off"
        ? '<span class="ok">disabled</span>'
        : state.tweak?.nicPower === "on"
          ? '<span class="warn">on</span> — device may be powered down'
          : state.tweak?.nicPower === "unsupported"
            ? '<span class="dim">not exposed by this driver</span>'
            : '<span class="dim">unknown</span>',
    ],
    [
      "Nagle batching",
      state.tweak?.nagleDisabled
        ? '<span class="ok">disabled</span>'
        : state.tweak?.nagleAvailable === false
          ? '<span class="dim">not configurable</span>'
          : '<span class="warn">on</span>',
    ],
  ];
  if (w?.connected) {
    rows.push(["SSID", esc(w.ssid || "hidden")]);
    rows.push([
      "Band / channel",
      `${esc(w.band || "?")} · ch ${esc(w.channel ?? "?")}`,
    ]);
    rows.push(["Signal", `<span class="${signalClass(w.signalPct)}">${typeof w.signalPct === "number" ? w.signalPct + "%" : "—"}</span>`]);
    rows.push(["Radio", esc(w.radioType || "—")]);
    if (w.rxMbps) rows.push(["Phy rate", `${num(w.rxMbps, 0)} ↓ / ${num(w.txMbps, 0)} ↑ Mbps`]);
  }

  box.innerHTML = `
    <p class="big-line">${esc(a.description || a.name)}</p>
    <dl class="kv">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join("")}</dl>
    ${
      w?.connected
        ? `<p class="meta" style="margin-top:10px">These Wi-Fi details need Location services, which stay on until you turn them off — Settings → Privacy &amp; security → Location.</p>`
        : ""
    }
    ${
      c.adapters?.filter((x) => x.status === "Up" && !x.virtual).length > 1
        ? `<p class="meta" style="margin-top:10px">Other connections up: ${c.adapters
            .filter((x) => x.status === "Up" && !x.virtual && x.name !== a.name)
            .map((x) => esc(x.name))
            .join(", ")}</p>`
        : ""
    }`;

  if (c.usingWifi && w && !w.connected) {
    hint.classList.remove("hidden");
    hint.innerHTML = `<span>${esc(w.reason || "Wi-Fi details are hidden.")}</span>
      <button class="btn btn-small" data-action="open-location">Open Location settings</button>`;
  } else {
    hint.classList.add("hidden");
  }
}

function renderScan() {
  const box = $("scanBox");
  const scan = state.scan;
  if (!scan) {
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  if (!scan.ok) {
    box.innerHTML = `<p class="empty">${esc(scan.reason || "Scan unavailable.")}</p>`;
    return;
  }
  const counts = scan.channels;
  const max = Math.max(1, ...counts.map((c) => c.count));
  const preferred = [36, 40, 44, 48, 149, 153, 157, 161, 165];
  const busy = new Set(counts.filter((c) => c.count > 0).map((c) => c.channel));
  const free5 = preferred.filter((ch) => !busy.has(ch)).slice(0, 4);
  const current = state.connection?.wifi?.channel;

  box.innerHTML = `
    <div class="channel-grid">
      ${counts
        .map(
          (c) => `<div class="channel-col" title="${c.count} network(s) on channel ${c.channel}">
            <div class="bar-v" style="height:${clamp((c.count / max) * 60, 4, 60)}px"><i style="height:100%"></i></div>
            <span>${c.channel}</span>
          </div>`,
        )
        .join("")}
    </div>
    <p class="meta">${scan.networks.length} networks visible. ${
      free5.length
        ? `Emptiest 5 GHz channels: <b>${free5.join(", ")}</b>.`
        : "Every common 5 GHz channel has at least one neighbour."
    } ${
      current && busy.has(current)
        ? `You are on channel ${current}, which is shared with other networks.`
        : current
          ? `You are on channel ${current}, which looks clear.`
          : ""
    }</p>`;
}

/* ------------------------------------------------------------------- render */

function renderProbe() {
  const p = state.probe;
  const body = $("probeBody");
  const meta = $("probeMeta");
  if (!p) return;

  const rows = p.results || [];
  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">No endpoints configured.</td></tr>`;
    return;
  }
  body.innerHTML = rows
    .map((r) => {
      const avgCls = r.avg === null ? "dim" : r.avg >= 120 ? "bad" : r.avg >= 60 ? "warn" : "";
      const lossCls = r.loss >= 2 ? "bad" : r.loss > 0 ? "warn" : "dim";
      const barCls = r.avg >= 120 ? "bad" : r.avg >= 60 ? "warn" : "";
      const width = r.avg === null ? 0 : clamp((r.avg / 150) * 100, 4, 100);
      return `<tr>
        <td>
          <span class="label">${esc(r.label)}</span>${r.kind === "dns" ? '<span class="tag tag-dns">dns</span>' : ""}
          <div class="sub">${esc(r.host)}:${esc(r.port)}${r.error ? ` · ${esc(r.error)}` : ""}</div>
        </td>
        <td class="sub" style="font-family:ui-monospace,monospace">${esc(r.ip || "—")}</td>
        <td class="num ${avgCls}">${num(r.avg)}</td>
        <td class="num">${num(r.p95)}</td>
        <td class="num">${num(r.jitter)}</td>
        <td class="num ${lossCls}">${num(r.loss)}%</td>
        <td class="num"><div class="bar ${barCls}" style="margin-left:auto;width:70px"><i style="width:${width}%"></i></div></td>
      </tr>`;
    })
    .join("");

  const s = p.summary || {};
  const prev = p.previous?.data?.summary;
  let delta = "";
  if (prev && typeof prev.gameAvgMs === "number" && typeof s.gameAvgMs === "number") {
    const d = Math.round((s.gameAvgMs - prev.gameAvgMs) * 10) / 10;
    delta = ` · ${d === 0 ? "same as" : d > 0 ? `+${d} ms vs` : `${d} ms vs`} previous run`;
  }
  meta.innerHTML = `${s.reachable ?? 0}/${s.endpoints ?? 0} endpoints answered · game average <b>${num(s.gameAvgMs)} ms</b>, jitter ${num(
    s.gameJitter,
  )} ms, loss ${num(s.gameLoss)}%${delta}`;

  const icmp = (p.icmp || []).filter((i) => i && (i.loss > 0 || i.avg !== null));
  const icmpBox = $("icmpBox");
  if (icmp.length) {
    icmpBox.classList.remove("hidden");
    icmpBox.innerHTML =
      `<b>ICMP check</b> ` +
      icmp
        .map((i) => `${esc(i.host)}: ${i.loss}% loss, avg ${num(i.avg)} ms`)
        .join(" · ");
  } else {
    icmpBox.classList.add("hidden");
  }
}

function renderBloat() {
  const box = $("bloatBox");
  const b = state.bloat;
  if (!b) {
    box.innerHTML = `<p class="empty">Not tested. This downloads for ~7 s to load your line, so skip it on metered data.</p>`;
    return;
  }
  if (b.grade === undefined || b.grade === "n/a") {
    // A blocked test download and a line that drops every ping are different problems, and
    // the loss figure is what tells them apart.
    const why =
      b.error ||
      (Number(b.loaded?.loss) >= 100
        ? "every ping sent while the line was busy failed (100% loss), so there is no loaded latency to compare against idle."
        : "no latency samples came back under load.");
    box.innerHTML = `<p class="empty">${b.error ? esc(why) : `Could not measure — ${esc(why)}`}</p>`;
    return;
  }
  const meaning = {
    A: "Excellent. Gaming stays smooth even while the line is busy.",
    B: "Good. Barely noticeable while something else is downloading.",
    C: "Noticeable. Your game will feel worse when the connection is busy.",
    D: "Poor. Downloads and streams will visibly spike your ping.",
    F: "Bad. Your ping explodes under any load — the most common cause of 'random' lag.",
  }[b.grade];
  // A busy line that drops packets is worse than one that only adds latency, so the loss
  // is shown next to the added ping instead of being left out of a successful-looking result.
  const underLoadLoss = Number(b.loaded?.loss) || 0;
  const idleLoss = Number(b.idle?.loss) || 0;
  let lossNote = "";
  if (underLoadLoss > 0) {
    lossNote = `<br /><span class="bad">${num(underLoadLoss)}% of the pings under load were lost (${b.loaded?.received ?? 0} of ${b.loaded?.sent ?? 0} came back)</span>`;
  } else if (idleLoss > 0) {
    lossNote = `<br /><span class="bad">${num(idleLoss)}% of the idle pings were lost</span>`;
  }
  box.innerHTML = `
    <div class="grade grade-${b.grade.toLowerCase()}">${b.grade}</div>
    <div>
      <div class="bloat-facts">
        idle <b>${num(b.idle?.avg)} ms</b> → under load <b>${num(b.loaded?.avg)} ms</b><br />
        <span class="${b.grade <= "C" ? "ok" : "bad"}">${b.deltaMs >= 0 ? "+" : ""}${num(b.deltaMs, 0)} ms added</span>
        · ${num(b.downloadMbps, 1)} Mbps pulled${lossNote}
      </div>
      <p class="meta" style="margin:8px 0 0">${meaning}</p>
    </div>`;
}

function renderDns() {
  const box = $("dnsBox");
  const d = state.dns;
  if (!d) {
    box.innerHTML = `<p class="empty">Not tested. Fast DNS fixes slow store pages and sign-ins, not your in-game ping.</p>`;
    return;
  }
  const current = (state.connection?.dnsForActive?.servers || []).join(", ") || "automatic";
  box.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Resolver</th><th class="num">avg</th><th class="num">p95</th><th class="num">answered</th><th></th></tr></thead>
      <tbody>
      ${d.resolvers
        .map(
          (r) => `<tr class="${r.id === d.best ? "best-row" : ""}">
          <td><span class="label">${esc(r.label)}</span>${r.id === d.best ? ' <span class="tag">fastest</span>' : ""}
            <div class="sub">${esc(r.servers.join(", "))}</div></td>
          <td class="num ${r.avg !== null && r.avg < 40 ? "ok" : ""}">${num(r.avg, 0)}</td>
          <td class="num">${num(r.p95, 0)}</td>
          <td class="num ${r.failures ? "warn" : "dim"}">${r.answered}/${r.total}</td>
          <td class="num"><button class="btn btn-small" data-action="dns-apply" data-servers='${esc(
            JSON.stringify(r.servers),
          )}' data-label="${esc(r.label)}">Use</button></td>
        </tr>`,
        )
        .join("")}
      </tbody>
    </table>
    <p class="meta">Currently in use on ${esc(state.alias || "this adapter")}: <b>${esc(current)}</b> · fastest now: <b>${esc(
      d.bestLabel || "unknown",
    )}</b></p>`;
}

/* Fixes are described once, in lib/catalog.mjs. This file only decides what the live
   state says and which button follows from it, so a label or trade-off cannot differ
   between the web UI, the terminal and the desktop app. */

const meta = (id) => (state.catalog?.tweaks || []).find((t) => t.id === id) || null;

function riskBadge(risk) {
  const r = state.catalog?.risk?.[risk];
  return `<span class="risk risk-${esc(risk)}" title="${esc(r?.meaning || "")}">${esc(r?.label || risk)}</span>`;
}

/** Live state of one setting: what it says, and which action its button runs. */
function stateFor(id, tw) {
  switch (id) {
    case "dns": {
      const dnsNow = tw.currentDns?.length ? tw.currentDns.join(", ") : "automatic (DHCP)";
      const best = state.dns?.result?.bestLabel;
      const servers = state.dns?.result?.resolvers?.find((r) => r.id === state.dns.result.best)?.servers;
      return {
        on: Boolean(tw.currentDns?.length),
        note: tw.currentDns?.length
          ? `<span class="ok">fixed: ${esc(dnsNow)}</span>`
          : `<span class="ok">automatic — whatever your router hands out</span>`,
        actions: `${best && servers && state.dns.result.winner
          ? `<button class="btn btn-small" data-action="dns-apply" data-servers='${esc(JSON.stringify(servers))}' data-label="${esc(best)}">Use ${esc(best)}</button>`
          : `<button class="btn btn-small btn-ghost" data-action="dns-apply" disabled title="Run the DNS benchmark until one resolver wins clearly">Benchmark first</button>`}
          <button class="btn btn-small btn-ghost" data-action="dns-reset"${tw.currentDns?.length ? "" : " disabled"}>Automatic</button>`,
      };
    }
    case "plan-power": {
      const off = tw.planPower === "off";
      return {
        on: off,
        note: off
          ? `<span class="ok">maximum performance — verified: ${esc(tw.planDetail)}</span>`
          : tw.planPower === "on"
            ? `<span class="warn">on — verified: ${esc(tw.planDetail)}</span>`
            : `<span class="dim">state could not be read</span>`,
        actions: off
          ? `<button class="btn btn-small btn-ghost" data-action="plan-power-on">Revert</button>`
          : `<button class="btn btn-small" data-action="plan-power-off">Maximum performance</button>`,
      };
    }
    case "nic-power": {
      const off = tw.nicPower === "off";
      const unavailable = tw.nicPower === "unsupported" || tw.nicPower === "unknown";
      return {
        on: off,
        note: off
          ? `<span class="ok">disabled — verified: ${esc(tw.nicDetail)}</span>`
          : tw.nicPower === "on"
            ? `<span class="warn">on — verified: ${esc(tw.nicDetail)}</span>`
            : `<span class="dim">${esc(tw.nicDetail || "state could not be read")}</span>`,
        actions: unavailable
          ? `<button class="btn btn-small" disabled>Not available</button>`
          : off
            ? `<button class="btn btn-small btn-ghost" data-action="nic-power-on">Revert</button>`
            : `<button class="btn btn-small" data-action="nic-power-off">Disable</button>`,
      };
    }
    case "nagle": {
      const off = tw.nagleDisabled === true;
      const unavailable = tw.nagleAvailable === false;
      return {
        on: off,
        note: unavailable
          ? `<span class="dim">this adapter has no TCP/IP interface key to configure</span>`
          : off
            ? `<span class="ok">disabled — verified: TcpAckFrequency=${esc(tw.nagleValues?.tcpAckFrequency)}, TCPNoDelay=${esc(tw.nagleValues?.tcpNoDelay)}</span>`
            : `<span class="warn">on — Windows batches small packets</span>`,
        actions: unavailable
          ? `<button class="btn btn-small" disabled>Not available</button>`
          : off
            ? `<button class="btn btn-small btn-ghost" data-action="nagle-on">Revert</button>`
            : `<button class="btn btn-small" data-action="nagle-off">Disable</button>`,
      };
    }
    case "radio-tuning": {
      const at = tw.adapterTuning;
      return {
        on: Boolean(at && !at.needsFix),
        note: !at
          ? `<span class="dim">this driver exposes no MIMO power-save or roaming property</span>`
          : `<span class="${at.needsFix ? "warn" : "ok"}">${at.needsFix ? "vendor defaults" : "applied"}</span> — ${esc(at.items.map((i) => i.display).join(" · "))}`,
        actions: !at
          ? `<button class="btn btn-small" disabled>Not available</button>`
          : at.needsFix
            ? `<button class="btn btn-small" data-action="adapter-tuning-off">Apply anyway</button>`
            : `<button class="btn btn-small btn-ghost" data-action="adapter-tuning-on">Revert</button>`,
      };
    }
    case "wifi-order": {
      const wo = tw.wifiOrder;
      return {
        on: Boolean(wo?.appliedByUs && wo?.isFirst),
        note: !wo
          ? `<span class="dim">this adapter is not wireless</span>`
          : !wo.readable
            ? `<span class="warn">Windows returned no profile list, so nothing can be reordered</span>`
            : wo.isFirst
              ? `<span class="ok">first — ${esc(wo.target)}</span>${wo.appliedByUs ? " · applied by PingLab" : ""}`
              : `joined network is #${esc(wo.position)} of ${esc(wo.profiles.length)} — an adapter reset can land on another saved network`,
        actions: !wo || !wo.readable
          ? `<button class="btn btn-small" disabled>Not available</button>`
          : wo.isFirst && wo.appliedByUs
            ? `<button class="btn btn-small btn-ghost" data-action="wifi-order-restore">Revert</button>`
            : wo.isFirst
              ? `<button class="btn btn-small" disabled>Already first</button>`
              : `<button class="btn btn-small" data-action="wifi-order-first">Move first</button>`,
      };
    }
    default:
      return null;
  }
}

function fixCard(id, tw) {
  const t = meta(id);
  const st = t ? stateFor(id, tw) : null;
  if (!t || !st) return "";
  const inPresets = (state.catalog.presets || []).filter((p) => p.tweaks.includes(id)).map((p) => p.id);
  return `
    <div class="fix">
      <div class="fix-info">
        <div class="fix-title">${esc(t.label)} ${riskBadge(t.risk)}<span class="dim small">${inPresets.length ? `in ${esc(inPresets.join(", "))}` : "not in a preset"}</span></div>
        <div class="fix-note">${st.note}</div>
        <div class="sub-note"><b>Changes:</b> ${esc(t.what)}</div>
        <div class="sub-note"><b>Trade-off:</b> ${esc(t.tradeoff)}</div>
        <div class="sub-note dim">Windows default: ${esc(t.stock)}</div>
      </div>
      <div class="fix-actions">${st.actions}</div>
    </div>`;
}

function renderPresets() {
  const bar = $("presetBar");
  if (!bar) return;
  if (!state.catalog || !state.tweak) {
    bar.innerHTML = "";
    return;
  }
  const tw = state.tweak;
  bar.innerHTML = (state.catalog.presets || [])
    .map((p) => {
      const rows = p.tweaks
        .map((id) => {
          const t = meta(id);
          const st = t ? stateFor(id, tw) : null;
          return `<li><span class="${st?.on ? "ok" : "dim"}">${st?.on ? "✓" : "–"}</span> ${esc(t?.label || id)}</li>`;
        })
        .join("");
      return `<div class="preset">
        <div class="fix-title">${esc(p.label)}</div>
        <div class="sub-note">${esc(p.summary)}</div>
        <ul class="preset-list">${rows}</ul>
        <div class="sub-note dim">${esc(p.leaves)}</div>
        <button class="btn btn-small" data-action="apply-preset" data-preset="${esc(p.id)}">Apply ${esc(p.label)}</button>
      </div>`;
    })
    .join("");
}

function renderFixes() {
  const box = $("fixesBox");
  const tw = state.tweak;
  if (!tw) {
    box.innerHTML = `<p class="empty">No adapter selected, so nothing can be tuned.</p>`;
    return;
  }
  if (!state.catalog) {
    box.innerHTML = `<p class="empty">The tweak catalog did not load. Restart the server (node server.mjs) and refresh.</p>`;
    return;
  }

  box.innerHTML = `<div class="fixes">${["dns", "plan-power", "nic-power", "nagle", "radio-tuning", "wifi-order"]
    .map((id) => fixCard(id, tw))
    .join("")}</div>`;

  const pending = state.pending;
  const badge = $("pendingBadge");
  if (pending?.problem) {
    // A count cannot be trusted when the file holding the restore points is unreadable.
    badge.classList.remove("hidden");
    badge.textContent = "restore points unreadable";
    badge.title = pending.problem.message;
  } else if (pending?.count) {
    badge.classList.remove("hidden");
    badge.textContent = `${pending.count} active`;
    badge.title = "Changes PingLab can undo";
  } else {
    badge.classList.add("hidden");
  }

  const log = $("changeLog");
  const items = state.pending?.history || [];
  log.innerHTML = items.length
    ? items.map((h) => `<li>${esc(h.action)} · ${esc(h.detail?.alias || "")} · ${timeOf(h.at)}</li>`).join("")
    : "";

  renderPresets();
}

function renderHistory(runs) {
  const list = $("historyList");
  if (!runs || !runs.length) {
    list.innerHTML = `<li class="empty">No runs yet.</li>`;
    return;
  }
  list.innerHTML = runs
    .map(
      (r) => `<li><span class="kind">${esc(r.kind)}</span> · ${esc(r.summary || "")}<br /><span class="dim">${timeOf(
        r.createdAt,
      )}</span></li>`,
    )
    .join("");
}

/* ------------------------------------------------------------------ actions */

async function loadState() {
  const s = await api("/api/state");
  if (!s || !s.connection) {
    toast(s?.error || "Could not read the network state", "bad");
    return;
  }
  state.connection = s.connection;
  state.tweak = s.tweakState;
  state.pending = s.pending;
  state.endpoints = s.endpoints || [];
  state.catalog = s.catalog || null;
  state.alias = s.connection.activeRoute?.alias || null;
  renderLink();
  renderConnection();
  renderFixes();
  renderEndpoints();
  renderHistory(s.recentRuns);
  updateVerdict();
}

async function runProbe() {
  const btn = $("runProbe");
  busy(btn, true, "Testing…");
  $("probeMeta").textContent = "Probing endpoints — 5 handshakes each…";
  const r = await api("/api/probe", {});
  busy(btn, false);
  if (!r.ok) {
    $("probeMeta").textContent = "Probe failed.";
    toast(r.error || "Probe failed", "bad");
    return;
  }
  state.probe = r;
  renderProbe();
  updateVerdict();
}

async function runBloat() {
  const btn = $("runBloat");
  busy(btn, true, "Loading line…");
  $("bloatBox").innerHTML = `<p class="empty">Measuring idle latency, then saturating the link for a few seconds…</p>`;
  const r = await api("/api/bufferbloat", { seconds: 6 });
  busy(btn, false);
  if (!r.ok && !r.result?.ok) {
    // Even a failed test carries figures worth showing: how many pings were lost under
    // load, or why the download never loaded the line. renderBloat explains both.
    if (r.result) {
      state.bloat = r.result;
      renderBloat();
      return;
    }
    $("bloatBox").innerHTML = `<p class="empty">${esc(r.error || "Test did not complete.")}</p>`;
    toast(r.error || "Bufferbloat test did not complete", "bad");
    return;
  }
  state.bloat = r.result;
  renderBloat();
  updateVerdict();
}

async function runDns() {
  const btn = $("runDns");
  busy(btn, true, "Benchmarking…");
  $("dnsBox").innerHTML = `<p class="empty">Timing 10 domains against 4 resolvers…</p>`;
  const r = await api("/api/dns-bench", {});
  busy(btn, false);
  if (!r.ok) {
    $("dnsBox").innerHTML = `<p class="empty">Benchmark failed.</p>`;
    toast(r.error || "DNS benchmark failed", "bad");
    return;
  }
  state.dns = r.result;
  renderDns();
  updateVerdict();
}

async function scanWifi() {
  const btn = $("scanWifi");
  const msg = $("scanMsg");
  busy(btn, true, "Scanning…");
  msg.textContent = "";
  const r = await api("/api/wifi-scan", {});
  busy(btn, false);
  if (!r.ok && !r.scan?.networks?.length) {
    msg.textContent = r.scan?.reason || "Scan failed";
    toast(r.scan?.reason || "Wi-Fi scan failed — it needs administrator rights and Location services.", "bad");
  }
  state.scan = r.scan;
  renderScan();
}

async function tweak(action, extra = {}) {
  if (!state.alias) return toast("No active adapter to change", "bad");
  if (action === "restore-all" && !confirm("Restore every setting this app changed back to how it was?")) return;
  if (
    action === "apply-preset" &&
    !confirm("Apply this preset? Every setting in it records its own restore point first, so each step can still be undone on its own.")
  )
    return;
  const label =
    {
      "dns-apply": "Applying DNS…",
      "dns-reset": "Resetting DNS…",
      "plan-power-off": "Requesting admin…",
      "plan-power-on": "Requesting admin…",
      "nic-power-off": "Checking this adapter…",
      "nic-power-on": "Checking this adapter…",
      "nagle-off": "Requesting admin…",
      "nagle-on": "Requesting admin…",
      "adapter-tuning-off": "Requesting admin…",
      "adapter-tuning-on": "Requesting admin…",
      "wifi-order-first": "Requesting admin…",
      "wifi-order-restore": "Requesting admin…",
      "restore-all": "Requesting admin…",
      "apply-preset": "Applying preset…",
    }[action] || "Working…";
  toast(`${label} Approve the Windows prompt if it appears.`);
  const r = await api("/api/tweak", { action, alias: state.alias, ...extra });
  if (r.cancelled) {
    toast("Nothing changed — the administrator prompt was closed.", "bad");
  } else if (!r.ok) {
    toast(r.error || r.message || "The change did not complete", "bad");
  } else {
    toast(r.message || "Done", "good");
  }
  if (r.tweakState) state.tweak = r.tweakState;
  if (r.pending) state.pending = r.pending;
  renderFixes();
  const fresh = await api("/api/state");
  if (fresh?.connection) {
    state.connection = fresh.connection;
    state.tweak = fresh.tweakState;
    state.pending = fresh.pending;
    renderLink();
    renderConnection();
    renderFixes();
  }
}

/* ---------------------------------------------------------------- endpoints */

function endpointRow(ep = { id: "", label: "", host: "", port: 443, kind: "game" }) {
  const row = document.createElement("div");
  row.className = "endpoint-row";
  row.innerHTML = `
    <input data-field="label" placeholder="Label" value="${esc(ep.label)}" />
    <input data-field="host" placeholder="host or IP" value="${esc(ep.host)}" />
    <input data-field="port" type="number" min="1" max="65535" value="${esc(ep.port)}" />
    <select data-field="kind">
      <option value="game"${ep.kind === "game" ? " selected" : ""}>game</option>
      <option value="dns"${ep.kind === "dns" ? " selected" : ""}>dns</option>
    </select>
    <button class="btn btn-small btn-ghost" data-remove="1" title="Remove">✕</button>`;
  row.dataset.id = ep.id || "";
  row.querySelector("[data-remove]").addEventListener("click", () => row.remove());
  return row;
}

function renderEndpoints() {
  const box = $("endpointRows");
  box.innerHTML = "";
  if (!state.endpoints.length) {
    box.appendChild(endpointRow());
    return;
  }
  for (const ep of state.endpoints) box.appendChild(endpointRow(ep));
}

async function saveEndpoints() {
  const rows = [...$("endpointRows").querySelectorAll(".endpoint-row")];
  const endpoints = rows
    .map((row, i) => {
      const get = (f) => row.querySelector(`[data-field="${f}"]`).value.trim();
      return {
        id: row.dataset.id || `ep${i}`,
        label: get("label") || get("host"),
        host: get("host"),
        port: Number(get("port")) || 443,
        kind: row.querySelector('[data-field="kind"]').value,
      };
    })
    .filter((e) => e.host);
  const r = await api("/api/endpoints", { endpoints });
  if (r.ok) {
    state.endpoints = r.endpoints;
    renderEndpoints();
    $("endpointMsg").textContent = "Saved.";
    toast("Endpoints saved", "good");
  } else {
    $("endpointMsg").textContent = r.error || "Save failed";
    toast(r.error || "Could not save endpoints", "bad");
  }
}

/* --------------------------------------------------------------------- soak */

let soakTimer = null;

function soakTable(summary, previousSummary) {
  const prevFor = (id) => previousSummary?.targets?.find((t) => t.id === id);
  const delta = (cur, prev) => {
    if (typeof cur !== "number" || typeof prev !== "number") return "";
    const d = Math.round((cur - prev) * 10) / 10;
    if (d === 0) return '<span class="dim">=</span>';
    return `<span class="${d > 0 ? "warn" : "ok"}">${d > 0 ? "+" : ""}${d}</span>`;
  };
  const rows = summary.targets
    .map((t) => {
      const p = prevFor(t.id);
      return `<tr>
        <td><span class="label">${esc(t.label)}</span><div class="sub">${t.sent} samples · ${esc(t.host || "")}</div></td>
        <td class="num">${num(t.avg)} ${p ? delta(t.avg, p.avg) : ""}</td>
        <td class="num">${num(t.p95)} ${p ? delta(t.p95, p.p95) : ""}</td>
        <td class="num">${num(t.p99)}</td>
        <td class="num">${num(t.jitter)} ${p ? delta(t.jitter, p.jitter) : ""}</td>
        <td class="num ${t.loss >= 1 ? "bad" : t.loss > 0 ? "warn" : "dim"}">${num(t.loss)}%</td>
        <td class="num ${t.spikes ? "warn" : "dim"}">${t.spikes}</td>
        <td class="num">${t.worstMinute ? `${num(t.worstMinute.avg)} <span class="sub">@${t.worstMinute.minute}m</span>` : "—"}</td>
      </tr>`;
    })
    .join("");
  return `<table class="data-table">
      <thead><tr><th>Target</th><th class="num">avg</th><th class="num">p95</th><th class="num">p99</th><th class="num">jitter</th><th class="num">loss</th><th class="num">spikes</th><th class="num">worst min</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function renderSoak(status, runs) {
  const box = $("soakBox");
  const startBtn = $("startSoak");
  const stopBtn = $("stopSoak");
  if (!box) return;

  if (status?.running) {
    startBtn.disabled = true;
    stopBtn.disabled = false;
    const pct = Math.min(100, Math.round((status.elapsed / Math.max(1, status.seconds)) * 100));
    const remaining = Math.max(0, status.seconds - status.elapsed);
    box.innerHTML = `<p class="meta">Running — ${status.elapsed}s of ${status.seconds}s (${pct}%) · ${status.samples} samples stored · about ${Math.ceil(
      remaining / 60,
    )} min left</p>
      <div class="bar" style="margin:10px 0 6px"><i style="width:${pct}%"></i></div>
      <p class="empty">Samples are already in the database. Leaving this page does not stop the test.</p>`;
    return;
  }

  startBtn.disabled = false;
  stopBtn.disabled = true;

  const latest = runs?.latest;
  const previous = runs?.previous;
  if (!latest?.summary) {
    box.innerHTML = `<p class="empty">Not run. A 4-second burst cannot measure jitter or loss; a 10-minute soak can.</p>`;
    return;
  }
  const s = latest.summary;
  const deltas = previous?.summary ? ` · colour shows the change vs run #${previous.id}` : "";
  box.innerHTML = `<p class="meta">Run #${latest.id} · ${Math.round(latest.seconds / 60)} min · ${s.samples} samples · ${timeOf(
    latest.endedAt,
  )}${s.label ? ` · ${esc(s.label)}` : ""}${deltas}</p>`
    + soakTable(s, previous?.summary)
    + `<p class="meta">Overall: avg ${num(s.overall?.avg)} ms · worst p95 ${num(s.overall?.p95)} ms · avg jitter ${num(
      s.overall?.jitter,
    )} ms · loss ${num(s.overall?.loss)}%</p>`;
}

async function loadSoak() {
  const [status, runs] = await Promise.all([api("/api/soak/status"), api("/api/soak/runs")]);
  renderSoak(status, runs);
  if (status?.running) {
    if (!soakTimer) {
      soakTimer = setInterval(async () => {
        const [s, r] = await Promise.all([api("/api/soak/status"), api("/api/soak/runs")]);
        renderSoak(s, r);
        if (!s?.running) {
          clearInterval(soakTimer);
          soakTimer = null;
        }
      }, 5000);
    }
  } else if (soakTimer) {
    clearInterval(soakTimer);
    soakTimer = null;
  }
}

/* ------------------------------------------------------------------- wiring */

$("runProbe").addEventListener("click", runProbe);
$("runBloat").addEventListener("click", runBloat);
$("runDns").addEventListener("click", runDns);
$("scanWifi").addEventListener("click", scanWifi);
$("refreshLink").addEventListener("click", loadState);
$("refreshHistory").addEventListener("click", async () => {
  const h = await api("/api/history");
  renderHistory(h.runs);
});
$("addEndpoint").addEventListener("click", () => $("endpointRows").appendChild(endpointRow()));
$("saveEndpoints").addEventListener("click", saveEndpoints);
$("restoreAll").addEventListener("click", () => tweak("restore-all"));
$("startSoak").addEventListener("click", async () => {
  const minutes = Math.min(60, Math.max(1, Number($("soakMinutes").value) || 10));
  const r = await api("/api/soak/start", { minutes });
  if (!r.ok) return toast(r.error || "Could not start the soak test", "bad");
  toast(`Soak started — ${minutes} min, ${r.expectedSamples} samples planned`, "good");
  loadSoak();
});
$("stopSoak").addEventListener("click", async () => {
  const r = await api("/api/soak/stop", {});
  toast(r.stopped ? "Stopping the soak — results will be summarised." : "No soak is running.");
  setTimeout(loadSoak, 1500);
});

$("runAll").addEventListener("click", async () => {
  const btn = $("runAll");
  busy(btn, true, "Running…");
  await runProbe();
  await runBloat();
  await runDns();
  busy(btn, false);
  toast("Full test finished", "good");
});

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-action]");
  if (!el) return;
  const action = el.dataset.action;
  if (action === "open-location") {
    const r = await api("/api/open-location", {});
    toast(r.ok ? "Opened Windows Location settings — enable it, then press Refresh." : r.message || "Could not open settings");
    return;
  }
  if (action === "apply-preset") {
    el.disabled = true;
    await tweak(action, { preset: el.dataset.preset });
    return;
  }
  if (action === "dns-apply") {
    let servers = [];
    try {
      servers = JSON.parse(el.dataset.servers || "[]");
    } catch {}
    if (!servers.length) return;
    el.disabled = true;
    el.textContent = "…";
    await tweak("dns-apply", { servers });
    return;
  }
  // Anything left is a tweak action. The server's dispatch table (runTweakAction) is the
  // one allowlist, so a new row only needs its button - it cannot be silently dropped here.
  el.disabled = true;
  await tweak(action);
});

loadState();
loadSoak();
