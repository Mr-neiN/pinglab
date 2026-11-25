/* PingLab page — bench-view.js */
function benchTweakChoices() {
  const select = $("benchTweak");
  const keep = select.value;
  // DNS changes lookup time, which this probe does not measure, so the server refuses it here.
  const tweaks = (state.catalog?.tweaks || []).filter((t) => t.id !== "dns");
  select.innerHTML = tweaks.map((t) => `<option value="${esc(t.id)}">${esc(t.label)}</option>`).join("");
  if (keep) select.value = keep;
}

function benchMetricRow(metric) {
  const cls = metric.verdict === "improved" ? "ok" : metric.verdict === "regressed" ? "bad" : "dim";
  const word = { improved: "improved", regressed: "regressed", "within-noise": "within noise" }[metric.verdict];
  return `<tr>
    <td>${esc(metric.label)}</td>
    <td class="num">${num(metric.before)} ${esc(metric.unit)}</td>
    <td class="num">${num(metric.after)} ${esc(metric.unit)}</td>
    <td class="num">${metric.delta > 0 ? "+" : ""}${num(metric.delta)}</td>
    <td class="num">${metric.pct === null ? "—" : `${metric.pct > 0 ? "+" : ""}${num(metric.pct)}%`}</td>
    <td class="num dim">±${num(metric.threshold)}</td>
    <td class="${cls}">${esc(word)}</td>
  </tr>`;
}

function renderBench() {
  benchTweakChoices();
  const pending = state.bench.pending;
  const latest = state.bench.latest;
  const applyBtn = $("benchApply");
  const finishBtn = $("benchFinish");
  const revertBtn = $("benchRevert");
  const box = $("benchResult");

  applyBtn.disabled = !pending;
  finishBtn.disabled = !pending;
  if (pending) applyBtn.textContent = `2. Apply ${pending.label}`;
  $("benchMsg").textContent = pending
    ? `Baseline captured ${timeOf(pending.at)}: median ${num(pending.baseline?.values?.latencyMs)} ms, p95 ${num(
        pending.baseline?.values?.p95Ms,
      )} ms, jitter ${num(pending.baseline?.values?.jitterMs)} ms, loss ${num(pending.baseline?.values?.lossPct)}%${
        pending.baseline?.transport && pending.baseline.transport !== "tcp"
          ? ` over ${esc(pending.baseline.transportLabel)}`
          : ""
      }. Apply the setting, then measure again.`
    : latest
      ? `Last comparison ${timeOf(latest.createdAt)}.`
      : `Not started. A baseline is ${state.benchPolicy?.repeats ?? 7} full latency runs with the endpoints above, and so is the measurement after the change.`;

  const result = latest?.data?.result;
  if (!result) {
    box.innerHTML = "";
    revertBtn.classList.add("hidden");
    return;
  }
  if (result.verdict === "insufficient") {
    box.innerHTML = `<p class="warn">${esc(result.reason || "Not enough data to compare.")}</p>`;
    revertBtn.classList.add("hidden");
    return;
  }
  const tone = result.verdict === "improved" ? "ok" : result.verdict === "regressed" ? "bad" : "dim";
  const word = { improved: "Improved", regressed: "Regressed", "within-noise": "Within noise" }[result.verdict];
  box.innerHTML = `
    <p><strong class="${tone}">${esc(word)}</strong> — ${esc(latest.data.label || "this setting")}. ${esc(latest.summary || "")}${
      state.bench.reverted ? " Rolled back from its restore point." : ""
    }</p>
    <table class="data-table">
      <thead><tr><th>Metric</th><th class="num">Before</th><th class="num">After</th><th class="num">Δ</th><th class="num">%</th><th class="num">noise</th><th>Verdict</th></tr></thead>
      <tbody>${result.metrics.map(benchMetricRow).join("")}</tbody>
    </table>`;
  revertBtn.textContent = `Roll back ${latest.data.label || "this setting"}`;
  // A comparison that has already been rolled back must not invite the same no-op again; the
  // recorded revert is the evidence, not a local flag that a reload would forget.
  revertBtn.classList.toggle("hidden", state.bench.reverted);
}

async function refreshBenchmark() {
  const r = await api("/api/benchmark");
  if (r.ok) {
    state.bench.pending = r.pending;
    state.bench.latest = r.latest;
    state.bench.reverted = (r.reverts || []).some((v) => v.data?.comparisonId === r.latest?.id);
  }
  renderBench();
}

async function captureBaseline() {
  const tweakId = $("benchTweak").value;
  if (!tweakId) return;
  const btn = $("benchBaseline");
  busy(btn, true, "Measuring 3 runs…");
  const r = await api("/api/benchmark/baseline", { tweak: tweakId });
  busy(btn, false);
  if (!r.ok) {
    toast(r.error || "Could not capture a baseline", "bad");
    return;
  }
  state.bench.pending = {
    id: r.id,
    tweak: r.tweak,
    label: r.label,
    applyAction: r.applyAction,
    at: new Date().toISOString(),
    baseline: r.baseline,
  };
  renderBench();
  toast("Baseline captured. Apply the setting, then measure again.", "good");
}

async function applyBenchTweak() {
  const pending = state.bench.pending;
  if (!pending) return;
  // A baseline restored from /api/benchmark after a reload does not carry the action, so the
  // catalog is the source for it either way - one place names the apply step of a setting.
  const action = pending.applyAction || (state.catalog?.tweaks || []).find((t) => t.id === pending.tweak)?.actions?.apply;
  if (!action) return toast("That setting has no apply step in this build", "bad");
  const btn = $("benchApply");
  busy(btn, true, "Requesting admin…");
  const r = await tweak(action);
  busy(btn, false);
  if (r?.ok) {
    $("benchMsg").textContent = `${pending.label} applied. Now measure again with the same endpoints.`;
    $("benchFinish").disabled = false;
  }
}

async function finishBenchmark() {
  const pending = state.bench.pending;
  if (!pending) return;
  const btn = $("benchFinish");
  busy(btn, true, "Measuring 3 runs…");
  const r = await api("/api/benchmark/finish", { id: pending.id, tweak: pending.tweak });
  busy(btn, false);
  if (!r.ok) {
    $("benchMsg").textContent = r.error || "The comparison could not be completed.";
    toast(r.error || "Could not complete the comparison", "bad");
    return;
  }
  state.bench.pending = null;
  await refreshBenchmark();
  // The history card is part of "later review": refresh it so the stored comparison is visible
  // now, not only after the next reload.
  await loadState();
  const regressed = r.result?.verdict === "regressed";
  toast(
    regressed ? "Measured: the change looks worse. Roll back if you agree." : "Measured: comparison ready.",
    regressed ? "warn" : "good",
  );
}

async function rollBackBenchmark() {
  const latest = state.bench.latest;
  if (!latest) return;
  const label = latest.data?.label || "this setting";
  // Explicit approval, not a consequence of the verdict: a regression is information, and the
  // person decides whether the setting goes back.
  if (!confirm(`Roll back ${label} from its restore point?\n\nThis puts the setting back the way Windows had it before PingLab changed it. Nothing is reverted unless you approve it here.`))
    return;
  const btn = $("benchRevert");
  busy(btn, true, "Restoring…");
  const r = await api("/api/benchmark/revert", { id: latest.id, approve: true });
  busy(btn, false);
  // The server's sentence is the same one the GUI and the terminal print, and it names what is
  // still applied when the rollback did not restore everything.
  toast(r.sentence || r.message || (r.restored ? "Rolled back." : "The rollback did not complete."), r.restored ? "good" : "bad");
  await loadState();
  await refreshBenchmark();
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

