/* PingLab page — probe-view.js */
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
  if (b) {
    // The worst direction is the one that matters: a good download grade must never hide a
    // failing upload grade, which is what a household uploading a clip actually feels.
    const graded = [b.download, b.upload]
      .filter((p) => p && p.grade && p.grade !== "n/a")
      .sort((x, y) => "ABCDF".indexOf(y.grade) - "ABCDF".indexOf(x.grade));
    const worst = graded[0];
    const grade = b.overallGrade || b.grade;
    const delta = num(worst?.deltaMs ?? b.deltaMs, 0);
    const activity = worst?.direction === "upload" ? "uploading or streaming out" : "downloading or streaming";
    if (grade === "D" || grade === "F")
      issues.push({ sev: 3, text: `Bufferbloat grade ${grade}: ping rises by ${delta} ms while ${activity}. Anyone else using the line will spike your game.` });
    else if (grade === "C" || grade === "B")
      issues.push({ sev: 1, text: `Under load your ping rises ${delta} ms (grade ${grade}). Not fatal, but it explains the odd spike.` });
  }
  const w = state.connection?.wifi;
  if (w?.connected) {
    if (typeof w.signalPct === "number" && w.signalPct < 55)
      issues.push({ sev: 2, text: `Wi-Fi signal quality is only ${w.signalPct}%. It is a coarse Windows percentage, but weak radio is the most common cause of lag spikes — move closer or run a cable.` });
    if (w.band === "2.4 GHz")
      issues.push({ sev: 1, text: `You are on the crowded 2.4 GHz band (channel ${w.channel ?? "?"}). Switch to 5 GHz for lower latency and less interference.` });
  }
  const d = state.dns;
  if (d?.result?.best && d.result.resolvers?.length) {
    const best = d.result.resolvers.find((r) => r.id === d.result.best);
    const current = (state.connection?.dnsForActive?.servers || []).join(",");
    if (best && !current.includes(best.servers[0]) && best.median !== null && best.median < 40) {
      issues.push({ sev: 1, text: `${best.label} resolves faster than your current DNS (${num(best.median, 0)} ms median, every lookup answered). That helps store pages and sign-ins, not in-game ping.` });
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

// The version the running copy reports, from the same package.json the update check reads.
function renderVersion() {
  const pill = $("versionPill");
  pill.textContent = state.version ? `PingLab ${state.version}` : "PingLab";
}

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
      "TCP buffering / ACK timing",
      state.tweak?.nagleDisabled
        ? '<span class="ok">both off (TCPNoDelay=1, TcpAckFrequency=1)</span>'
        : state.tweak?.nagleAvailable === false
          ? '<span class="dim">not configurable</span>'
          : state.tweak?.nagleValues?.tcpAckFrequency === 1 || state.tweak?.nagleValues?.tcpNoDelay === 1
            ? '<span class="warn">partly applied — both values must be 1</span>'
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
  // 6 GHz reuses the 5 GHz channel numbers, so only a 5 GHz neighbour makes a 5 GHz channel busy.
  const busy5 = new Set(counts.filter((c) => c.band === "5 GHz").map((c) => c.channel));
  // Whether the scan was confirmed comes from the WLAN API through the engine; the page prints
  // that sentence and never infers freshness from the list itself.
  const freshness = scan.freshnessText ? `<p class="meta">${esc(scan.freshnessText)}</p>` : "";
  const free5 = preferred.filter((ch) => !busy5.has(ch)).slice(0, 4);
  const wifi = state.connection?.wifi || {};
  const current = wifi.channel;
  const mine = counts.find((c) => c.channel === current && (!wifi.band || !c.band || c.band === wifi.band));
  const advice = (state.wifiAdvice || []).map(([kind, text]) => `<li class="${esc(kind)}">${esc(text)}</li>`).join("");

  box.innerHTML = `
    ${freshness}
    <div class="channel-grid">
      ${counts
        .map(
          (c) => `<div class="channel-col" title="${c.count} network(s) on ${c.band ? esc(c.band) + " " : ""}channel ${c.channel}">
            <div class="bar-v" style="height:${clamp((c.count / max) * 60, 4, 60)}px"><i style="height:100%"></i></div>
            <span>${c.channel}</span>
          </div>`,
        )
        .join("")}
    </div>
    <p class="meta">${scan.networks.length} networks in this scan. ${
      free5.length
        ? `Emptiest visible 5 GHz channels: <b>${free5.join(", ")}</b>.`
        : "Every common 5 GHz channel has at least one neighbour in this scan."
    } ${
      mine
        ? `You are on ${wifi.band ? esc(wifi.band) + " " : ""}channel ${current}, which is shared with other visible networks.`
        : current
          ? `No other visible network is on channel ${current}.`
          : ""
    }${scan.truncated ? " The list was cut at 40 networks." : ""}</p>
    ${advice ? `<ul class="advice">${advice}</ul>` : ""}`;
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
  // Two round trips, named: the table's avg column is the network-path handshake, while a
  // game-server figure exists only where the service answered its own UDP query.
  meta.innerHTML = `${s.reachable ?? 0}/${s.endpoints ?? 0} endpoints answered · game-server RTT <b>${num(
    s.gameAvgMs,
  )} ms</b> (UDP, only where the service answered), jitter ${num(s.gameJitter)} ms, loss ${num(
    s.gameLoss,
  )}%${delta}`;

  // Long-term: the stored probe history, read as a series. It is drawn even before this
  // session's first test, because it describes runs from earlier days.
  renderTrend();

  const icmp = (p.icmp || []).filter((i) => i && (i.loss > 0 || i.avg !== null));
  const icmpBox = $("icmpBox");
  if (icmp.length) {
    icmpBox.classList.remove("hidden");
    const list = icmp
      .map((i) => {
        const seen = typeof i.received === "number" ? i.received : i.loss < 100 ? 1 : 0;
        if (!seen) return `${esc(i.host)}: no ICMP reply (usually blocked, not down)`;
        return `${esc(i.host)}: avg ${num(i.avg)} ms, jitter ${num(i.jitter)} ms, ${num(i.loss)}% loss`;
      })
      .join(" · ");
    icmpBox.innerHTML = `<b>ICMP echo (network path)</b> ${list}${
      p.transport ? `<div class="meta" style="margin-top:6px">${esc(p.transport)}</div>` : ""
    }`;
  } else {
    icmpBox.classList.add("hidden");
  }

  // UDP is timed only where a service answered. Silence and a closed port get their own
  // words here, from the same sentence the terminal and GUI print.
  const udp = p.udp || [];
  // Endpoints that publish no query were not probed at all; their count is in the note below,
  // so the list only names the exchanges that actually happened.
  const udpProbed = udp.filter((u) => u.state !== "no-query");
  const udpBox = $("udpBox");
  if (udp.length) {
    udpBox.classList.remove("hidden");
    const list = udpProbed
      .map((u) => {
        if (u.state === "answered") {
          const step = u.challenged ? ", answered after a challenge" : "";
          return `game-server RTT ${esc(u.label)}: avg ${num(u.avg)} ms, jitter ${num(u.jitter)} ms, ${num(
            u.loss,
          )}% loss${step}`;
        }
        // The service answered the challenge but never the query that followed: the challenge
        // RTT is a diagnostic, not a completed game-server query.
        if (u.state === "challenge") {
          const ms = u.challengeAvgMs === null ? "" : ` in ${num(u.challengeAvgMs)} ms`;
          return `${esc(u.label)}: challenge answered${ms}, follow-up never completed (not a reply)`;
        }
        if (u.state === "closed") {
          return `${esc(u.label)}: port closed${u.pathMs === null ? "" : ` (path ${num(u.pathMs)} ms)`}`;
        }
        // Traffic that came from another source or did not match this query is not a round trip.
        if (u.state === "mismatched") {
          return `${esc(u.label)}: datagrams from a different address/port, not this probe's target (untimed)`;
        }
        if (u.state === "unexpected") {
          return `${esc(u.label)}: reply did not match this probe's query (untimed)`;
        }
        return `${esc(u.label)}: no UDP reply (a service ignores unknown packets; not loss)`;
      })
      .join(" · ");
    const caveat = p.udpCaveat || state.udpCaveat;
    udpBox.innerHTML = `${list ? `<b>UDP</b> ${list}` : ""}${
      p.udpNote ? `<div class="meta" style="margin-top:6px">${esc(p.udpNote)}</div>` : ""
    }${caveat ? `<div class="meta" style="margin-top:6px">${esc(caveat)}</div>` : ""}`;
  } else {
    // Clear it, not just hide it: a probe that produced no UDP results (a failed lookup, an
    // older stored run) must not leave a previous run's UDP figures in the page.
    udpBox.innerHTML = "";
    udpBox.classList.add("hidden");
  }
}

// The long-term line under the latency table. It says how many runs it is based on and never
// claims a direction before lib/trend.mjs is willing to state one.
function renderTrend() {
  const box = $("trendBox");
  if (!box) return;
  const t = state.trend;
  if (!t || !t.sentence) {
    box.textContent = "";
    box.classList.add("hidden");
    return;
  }
  box.classList.remove("hidden");
  const points = (t.points || []).slice(-30);
  const spark = points.length >= 2 ? sparkline(points.map((p) => p.ms)) : "";
  box.innerHTML = `${spark ? `${spark} ` : ""}${esc(t.sentence)}`;
}

/** A tiny inline SVG line, scaled to its own range so a flat line reads as flat. */
function sparkline(values) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const points = values
    .map((v, i) => `${((i / (values.length - 1)) * 100).toFixed(1)},${(28 - ((v - lo) / span) * 24).toFixed(1)}`)
    .join(" ");
  return `<svg class="spark" viewBox="0 0 100 30" width="110" height="26" aria-hidden="true"><polyline points="${points}" fill="none" stroke="currentColor" stroke-width="1.5"/></svg>`;
}

function renderBloat() {
  const box = $("bloatBox");
  const b = state.bloat;
  if (!b) {
    box.innerHTML = `<p class="empty">Not tested. This loads your line with downloads, then uploads, for about 15 s, so skip it on metered data.</p>`;
    return;
  }
  const phases = [b.download, b.upload].filter(Boolean);
  const graded = phases.filter((p) => p.grade && p.grade !== "n/a");
  // Older stored runs only carry the download figures; keep them readable.
  const legacy = !phases.length && b.grade && b.grade !== "n/a";
  if (!graded.length && !legacy) {
    // A blocked test download and a line that drops every ping are different problems, and
    // the loss figure is what tells them apart.
    const why =
      b.error ||
      b.verdict ||
      phases.map((p) => p.error).filter(Boolean).join(" ") ||
      (Number(b.loaded?.loss) >= 100
        ? "every ping sent while the line was busy failed (100% loss), so there is no loaded latency to compare against idle."
        : "no latency samples came back under load.");
    box.innerHTML = `<p class="empty">${esc(why)}</p>`;
    return;
  }
  const phase = (name, p) => {
    if (!p) return "";
    if (p.grade === "n/a" || p.deltaMs === null) {
      return `<div class="bloat-facts"><b>${name}</b> not measured — ${esc(p.error || "no latency samples under load.")}</div>`;
    }
    const loss = Number(p.loaded?.loss) || 0;
    return `<div class="bloat-facts">
      <b>${name}</b> ${num(p.mbps, 1)} Mbps moved · idle <b>${num(p.idle?.avg)} ms</b> → under load <b>${num(p.loaded?.avg)} ms</b><br />
      <span class="${"ABCDF".indexOf(p.grade) <= 2 ? "ok" : "bad"}">${p.deltaMs >= 0 ? "+" : ""}${num(p.deltaMs, 0)} ms added</span> · grade ${p.grade}${
        loss > 0 ? ` · <span class="bad">${num(loss)}% of pings under load lost</span>` : ""
      }
    </div>`;
  };
  const legacyHtml = legacy
    ? `<div class="bloat-facts">idle <b>${num(b.idle?.avg)} ms</b> → under load <b>${num(b.loaded?.avg)} ms</b><br />
        <span class="${"ABCDF".indexOf(b.grade) <= 2 ? "ok" : "bad"}">${b.deltaMs >= 0 ? "+" : ""}${num(b.deltaMs, 0)} ms added</span> · ${num(
          b.downloadMbps,
          1,
        )} Mbps pulled</div>`
    : `${phase("Download", b.download)}${phase("Upload", b.upload)}`;
  const grade = b.overallGrade || b.grade;
  box.innerHTML = `
    <div class="grade grade-${esc(String(grade).toLowerCase())}">${esc(grade)}</div>
    <div>
      ${legacyHtml}
      <p class="meta" style="margin:8px 0 0">${esc(b.verdict || "")}</p>
    </div>`;
}

function renderDns() {
  const box = $("dnsBox");
  const d = state.dns;
  if (!d) {
    box.innerHTML = `<p class="empty">Not tested. Fast DNS fixes slow store pages and sign-ins, not your in-game ping.</p>`;
    return;
  }
  const current = (state.connection?.dnsForTarget?.servers || state.connection?.dnsForActive?.servers || []).join(", ") || "automatic";
  box.innerHTML = `
    <table class="data-table">
      <thead><tr><th>Resolver</th><th class="num">median</th><th class="num">worst</th><th class="num">answered</th><th class="num">missed</th><th></th></tr></thead>
      <tbody>
      ${d.resolvers
        .map(
          (r) => `<tr class="${r.id === d.best ? "best-row" : ""}">
          <td><span class="label">${esc(r.label)}</span>${r.id === d.best ? ' <span class="tag">fastest</span>' : ""}
            <div class="sub">${esc(r.servers.join(", "))}</div></td>
          <td class="num ${r.median !== null && r.median < 40 ? "ok" : ""}">${num(r.median, 0)}</td>
          <td class="num">${num(r.worst, 0)}</td>
          <td class="num ${r.reliable ? "dim" : "warn"}">${r.answered}/${d.domains}</td>
          <td class="num ${r.missed ? "warn" : "dim"}">${r.missed ? `${r.missed} missed` : "—"}</td>
          <td class="num"><button class="btn btn-small" data-action="dns-apply" data-servers='${esc(
            JSON.stringify(r.servers),
          )}' data-label="${esc(r.label)}"${r.reliable ? "" : ' disabled title="This resolver missed lookups in this benchmark, so it is not recommended."'}>Use</button></td>
        </tr>`,
        )
        .join("")}
      </tbody>
    </table>
    <p class="meta">Currently in use on ${esc(state.target?.alias || state.alias || "this adapter")}: <b>${esc(current)}</b>. ${esc(
      d.verdict || "No verdict.",
    )}</p>`;
}

/* Fixes are described once, in lib/catalog.mjs. This file only decides what the live
   state says and which button follows from it, so a label or trade-off cannot differ
   between the web UI, the terminal and the desktop app. */

