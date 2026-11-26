/* PingLab page — fixes-view.js */
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
      const ack = tw.nagleValues?.tcpAckFrequency;
      const nd = tw.nagleValues?.tcpNoDelay;
      const partial = !off && (ack === 1 || nd === 1);
      return {
        on: off,
        note: unavailable
          ? `<span class="dim">this adapter has no TCP/IP interface key to configure</span>`
          : off
            ? `<span class="ok">disabled — verified: TcpAckFrequency=${esc(tw.nagleValues?.tcpAckFrequency)}, TCPNoDelay=${esc(tw.nagleValues?.tcpNoDelay)}</span>`
            : partial
              ? `<span class="warn">partly applied — verified: TcpAckFrequency=${esc(ack)}, TCPNoDelay=${esc(nd)}; both must be 1</span>`
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

/* Which adapter the rows below are read from and written to. The server decides the target
   (the default route, physical before virtual) and hands over the list; this renders it and
   sends the pick back, so the same device is tuned by the page, the GUI and the terminal. */

function adapterChoiceText(c) {
  const tags = [];
  if (c.defaultRoute) tags.push("default route");
  if (c.virtual) tags.push("virtual / VPN");
  if (c.status && c.status !== "Up") tags.push(c.status);
  return `${c.alias}${c.description ? ` — ${c.description}` : ""}${tags.length ? ` (${tags.join(", ")})` : ""}`;
}

/** A virtual or VPN adapter is offered only once the box is ticked, or when it is the target. */
function visibleAdapterChoices() {
  const target = state.target?.alias;
  return (state.adapterChoices || []).filter((c) => !c.virtual || state.showVirtual || c.alias === target);
}

function renderAdapterPick() {
  const pick = $("adapterPick");
  const note = $("adapterNote");
  if (!pick || !note) return;
  const target = state.target;
  const choices = visibleAdapterChoices();
  pick.innerHTML = choices
    .map(
      (c) =>
        `<option value="${esc(c.alias)}"${c.alias === target?.alias ? " selected" : ""}>${esc(adapterChoiceText(c))}</option>`,
    )
    .join("");
  pick.disabled = choices.length === 0;
  const lines = [target?.note, state.targetFallback].filter(Boolean);
  note.textContent = lines.join(" ");
  note.classList.toggle("hidden", lines.length === 0);
  const box = $("showVirtual");
  if (box) box.checked = Boolean(state.showVirtual);
}

/** Persist the pick, then redraw the rows from the values the server read back. */
async function setAdapter(alias) {
  const r = await api("/api/adapter", { alias });
  if (!r.ok) {
    toast(r.error || "That adapter could not be selected", "bad");
    renderAdapterPick();
    return null;
  }
  if (r.target) state.target = r.target;
  if (r.adapterChoices) state.adapterChoices = r.adapterChoices;
  state.targetFallback = r.targetFallback || null;
  if (r.tweakState !== undefined) state.tweak = r.tweakState;
  if (r.pending) state.pending = r.pending;
  if (r.drift !== undefined) state.drift = r.drift;
  renderAdapterPick();
  renderFixes();
  toast(`Settings now apply to ${r.target?.alias || alias}.`, "good");
  return r;
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
        <div class="sub-note dim">Applies to <b>${esc(state.target?.alias || "no adapter")}</b>${state.target?.virtual ? " (virtual / VPN)" : state.target?.defaultRoute ? " — the adapter with the default route" : ""}</div>
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

  // A restore point records the adapter it belongs to. The change log names it per line, and
  // this lists what is still applied per adapter, so "restore" is never a guess about the device.
  const points = $("restorePoints");
  const pointsBox = $("restorePointsBox");
  if (points && pointsBox) {
    const live = pending?.problem ? [] : pending?.items || [];
    points.innerHTML = live
      .map((it) => `<li>${esc(it.label)} · on ${esc(it.alias)}${it.scope ? ` (${esc(it.scope)})` : ""} · ${timeOf(it.at)}</li>`)
      .join("");
    pointsBox.classList.toggle("hidden", live.length === 0);
  }

  const log = $("changeLog");
  const items = state.pending?.history || [];
  log.innerHTML = items.length
    ? items.map((h) => `<li>${esc(h.action)} · ${esc(h.detail?.alias || "")} · ${timeOf(h.at)}</li>`).join("")
    : "";

  renderDriftNotice();
  renderPresets();
}

/**
 * A setting PingLab wrote that Windows has since put back cannot be read off the cards: the
 * live state looks like a machine you never tuned. The server compares the restore points with
 * the live state and hands the page the same sentence the terminal and the GUI print.
 */
function renderDriftNotice() {
  const el = $("driftNotice");
  const drift = state.drift;
  if (!drift?.count) {
    el.classList.add("hidden");
    el.innerHTML = "";
    return;
  }
  el.innerHTML = `<strong>${esc(drift.text)}</strong><ul>${drift.drifted
    .map((r) => `<li>${esc(r.setting)}: ${esc(r.observation)}</li>`)
    .join("")}</ul>`;
  el.title = drift.drifted.map((r) => `${r.setting}: ${r.observation}`).join("\n");
  el.classList.remove("hidden");
}

/**
 * A database that had to be set aside at start-up is not a silent reset. The server reports
 * it once per run in /api/state, and it belongs above the verdict rather than in a log.
 */
function renderHistoryNotice() {
  const el = $("historyNotice");
  const problem = state.history?.problem;
  if (!problem) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.textContent = problem.message;
  el.title = problem.message;
  el.classList.remove("hidden");
}

/**
 * A settings file that could not be used is not a silent fall back to the built-in endpoint
 * list: the server reports it once per run in /api/state, and it belongs above the verdict,
 * beside the database warning, rather than in a log nobody opens.
 */
function renderConfigNotice() {
  const el = $("configNotice");
  const problem = state.config?.problem;
  if (!problem) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.textContent = problem.message;
  el.title = problem.message;
  el.classList.remove("hidden");
}

/**
 * A newer release is reported in the sentence the TUI and the GUI print. The server asks GitHub
 * once per start, so a check that could not be made has no sentence and no notice: an unchecked
 * copy is never drawn as "up to date".
 */
function renderUpdateNotice() {
  const el = $("updateNotice");
  const sentence = state.update?.sentence;
  if (!sentence) {
    el.classList.add("hidden");
    el.textContent = "";
    return;
  }
  el.textContent = sentence;
  el.title = sentence;
  el.classList.remove("hidden");
}

/* ------------------------------------------------------------ before / after */

/**
 * Baseline, one change, second measurement. The page does not decide whether a change was an
 * improvement: the server compares the two phases with lib/bench.mjs and returns the verdict,
 * so this table, the toast and the history row cannot disagree.
 */
