/* PingLab page — app.js */
async function loadState() {
  const s = await api("/api/state");
  if (!s || !s.connection) {
    toast(s?.error || "Could not read the network state", "bad");
    return;
  }
  state.version = s.version || null;
  state.benchPolicy = s.benchPolicy || null;
  state.udpPolicy = s.udpPolicy || null;
  state.udpCaveat = s.udpCaveat || null;
  state.trend = s.trend || null;
  state.connection = s.connection;
  state.tweak = s.tweakState;
  state.pending = s.pending;
  state.history = s.history || null;
  state.config = s.config || null;
  state.endpoints = s.endpoints || [];
  state.catalog = s.catalog || null;
  state.protocols = s.protocols || null;
  state.update = s.update || null;
  state.target = s.target || null;
  state.adapterChoices = s.adapterChoices || [];
  state.targetFallback = s.targetFallback || null;
  state.alias = s.connection.activeRoute?.alias || null;
  renderVersion();
  renderLink();
  renderConnection();
  renderAdapterPick();
  renderFixes();
  renderEndpoints();
  renderHistoryNotice();
  renderConfigNotice();
  renderUpdateNotice();
  renderBench();
  renderTrend();
  renderHistory(s.recentRuns);
  updateVerdict();
}

async function runProbe() {
  const btn = $("runProbe");
  busy(btn, true, "Testing…");
  $("probeMeta").textContent =
    "Probing endpoints — 5 handshakes each (network path), then the game's own query (game-server RTT)…";
  const r = await api("/api/probe", {});
  busy(btn, false);
  if (!r.ok) {
    $("probeMeta").textContent = "Probe failed.";
    toast(r.error || "Probe failed", "bad");
    return;
  }
  state.probe = r;
  renderProbe();
  // This run is now stored, so the long-term line is re-read rather than left describing the
  // runs that existed when the page loaded.
  const trend = await api("/api/trend");
  if (trend?.ok) {
    state.trend = trend.trend;
    renderTrend();
  }
  updateVerdict();
}

async function runBloat() {
  const btn = $("runBloat");
  busy(btn, true, "Loading line…");
  $("bloatBox").innerHTML = `<p class="empty">Measuring idle latency, then loading the line with downloads, then uploads…</p>`;
  const r = await api("/api/bufferbloat", { seconds: 6, direction: "both" });
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
  // A failed request carries no scan at all: keep it null so renderScan stays hidden instead
  // of drawing an empty "unavailable" panel over a toast that already explained it.
  state.scan = r.scan ? { ...r.scan, freshnessText: r.freshnessText || null } : null;
  state.wifiAdvice = r.advice || [];
  renderScan();
}

async function tweak(action, extra = {}) {
  const alias = state.target?.alias;
  if (!alias) return toast("No adapter is selected to change", "bad");
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
  const r = await api("/api/tweak", { action, alias, ...extra });
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
    state.target = fresh.target || state.target;
    state.adapterChoices = fresh.adapterChoices || state.adapterChoices;
    state.targetFallback = fresh.targetFallback || null;
    renderLink();
    renderConnection();
    renderAdapterPick();
    renderFixes();
  }
  return r;
}

/* ---------------------------------------------------------------- endpoints */

/**
 * The protocol options come from the server (`state.protocols`, built from lib/udp-proto.mjs), so
 * a protocol added to the engine is offered here without a second list going stale.
 */
function protocolOptions(selected) {
  const list = state.protocols?.length ? state.protocols : [{ id: "echo", label: "controlled echo" }];
  const chosen = list.some((p) => p.id === selected) ? selected : list.some((p) => p.id === "echo") ? "echo" : list[0].id;
  return list
    .map((p) => `<option value="${esc(p.id)}"${p.id === chosen ? " selected" : ""}>UDP: ${esc(p.label)}</option>`)
    .join("");
}

function endpointRow(ep = { id: "", label: "", host: "", port: 443, kind: "game", protocol: "echo" }) {
  const row = document.createElement("div");
  // The row always carries a real protocol. The server refuses a name it does not know, and the
  // blank value a select shows with no default is not one; an endpoint saved before this field
  // existed gets the controlled echo, which is the same choice the probe itself makes.
  const protocol = ep.protocol || "echo";
  row.className = "endpoint-row";
  row.innerHTML = `
    <input data-field="label" placeholder="Label" value="${esc(ep.label)}" />
    <input data-field="host" placeholder="host or IP" value="${esc(ep.host)}" />
    <input data-field="port" type="number" min="1" max="65535" value="${esc(ep.port)}" />
    <select data-field="kind">
      <option value="game"${ep.kind === "game" ? " selected" : ""}>game</option>
      <option value="dns"${ep.kind === "dns" ? " selected" : ""}>dns</option>
    </select>
    <select data-field="protocol" title="The UDP query this endpoint is timed with">
      ${protocolOptions(protocol)}
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
        // Sent as chosen: the select only offers protocols the server accepts, and an empty
        // value is refused there rather than being silently turned into an echo.
        protocol: row.querySelector('[data-field="protocol"]').value,
      };
    })
    .filter((e) => e.host);
  const r = await api("/api/endpoints", { endpoints });
  if (r.ok) {
    state.endpoints = r.endpoints;
    // The file just written loads cleanly, so a notice about the old one is no longer true.
    // The toast below still says where the old bytes were kept.
    state.config = { problem: null };
    renderEndpoints();
    renderConfigNotice();
    $("endpointMsg").textContent = "Saved.";
    if (r.previousProblem) {
      // The file this replaced could not be used and was kept beside it. Saying so is the
      // point: the old version replaced it with the defaults and mentioned nothing.
      $("endpointMsg").textContent = "Saved. The previous file was kept aside.";
      toast(r.previousProblem.message, "warn");
    } else {
      toast("Endpoints saved", "good");
    }
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
$("adapterPick").addEventListener("change", () => setAdapter($("adapterPick").value));
$("showVirtual").addEventListener("change", () => {
  state.showVirtual = $("showVirtual").checked;
  renderAdapterPick();
});
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

$("benchBaseline").addEventListener("click", captureBaseline);
$("benchApply").addEventListener("click", applyBenchTweak);
$("benchFinish").addEventListener("click", finishBenchmark);
$("benchRevert").addEventListener("click", rollBackBenchmark);

loadState();
loadSoak();
refreshBenchmark();
