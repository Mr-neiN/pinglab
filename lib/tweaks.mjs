import { join } from "node:path";
import { runElevated, isElevated } from "./ps.mjs";
import { dnsServers } from "./net.mjs";
import { TWEAKS, PRESETS, presetById, presetTweaks, tweakById } from "./catalog.mjs";
import { sq, dnsSourceOf, looksDenied } from "./tweak-shared.mjs";
import { readBackups, backupStatus, updateBackups, WIRELESS_SUBGROUP, WIRELESS_SETTING, EMPTY, BACKUP_NAME } from "./backups.mjs";
import { applyDns, resetDns, setPlanPowerSave, setNicPowerSave, setNagle, tweakState, readPowerState, readNagleValues } from "./tweaks-apply.mjs";
import { ADAPTER_TUNING, TUNING_REASON, PS_TUNING, setAdapterTuning, readTuningValues } from "./tweaks-tuning.mjs";
import { setWlanOrderFirst, restoreWlanOrder, planOrderSteps, sameOrder, readWlanOrder } from "./tweaks-wlan.mjs";

/** The catalog owns every label; nothing below repeats one. */
const tweakLabel = (id) => tweakById(id)?.label || id;
/**
 * Apply a named preset. Every step goes through the same dispatch table as a single row,
 * so each one records its own restore point before changing anything, and a step that is
 * unsupported on this adapter or whose UAC prompt is dismissed is reported instead of
 * hidden. Nothing experimental is reachable from here: validateCatalog() refuses a preset
 * that lists one.
 */
export async function applyPreset(alias, presetId) {
  const preset = presetById(presetId);
  if (!preset) {
    return {
      ok: false,
      error: `Unknown preset "${presetId}". Known presets: ${PRESETS.map((p) => `${p.id} (${p.label})`).join(", ")}.`,
    };
  }
  const blocked = backupStatus().problem;
  if (blocked) return { ok: false, error: blocked.refusal, backupProblem: true };
  const wanted = presetTweaks(preset);
  const steps = [];
  for (const tweak of wanted) {
    let res;
    try {
      res = await runTweakAction(alias, tweak.actions.apply);
    } catch (err) {
      res = { ok: false, error: String(err?.message || err) };
    }
    const outcome = tweakOutcome(res);
    const skipped = res.unsupported ? "not available on this adapter" : res.cancelled ? "administrator prompt closed" : null;
    // "nothing to change" is a success but not a change, and the summary has to say so.
    const unchanged = res.ok && /nothing to change|already/i.test(outcome.message || "");
    steps.push({
      id: tweak.id,
      label: tweak.label,
      ok: Boolean(res.ok),
      status: res.ok ? (unchanged ? "already" : "applied") : skipped ? "skipped" : "failed",
      message: skipped && !res.ok ? `${skipped} - ${outcome.message}` : outcome.message,
    });
    // A closed UAC prompt would otherwise be asked for again on every remaining step.
    if (res.cancelled) break;
  }
  const count = (status) => steps.filter((s) => s.status === status).length;
  const bits = [`${count("applied")} applied`];
  if (count("already")) bits.push(`${count("already")} already in place`);
  if (count("skipped")) bits.push(`${count("skipped")} skipped`);
  if (count("failed")) bits.push(`${count("failed")} failed`);
  if (steps.length < wanted.length) bits.push(`${wanted.length - steps.length} not reached`);
  const ok = count("failed") === 0 && steps.length === wanted.length;
  return {
    ok,
    data: { ok, preset: preset.id, message: `${preset.label} preset: ${bits.join(", ")}.`, steps },
  };
}

/**
 * Which catalog entry an action belongs to, and which way it goes. Used only for the
 * elevation sentence, so every surface names the same setting and the same command.
 */
export function actionSpec(action) {
  if (action === "restore-all") {
    return { id: "restore-all", label: "Restore everything PingLab changed", cli: null, mode: "restore" };
  }
  for (const t of TWEAKS) {
    if (t.actions.apply === action) return { id: t.id, label: t.label, cli: t.cli, mode: "apply" };
    if (t.actions.revert === action) return { id: t.id, label: t.label, cli: t.cli, mode: "revert" };
  }
  return { id: action, label: action, cli: null, mode: "apply" };
}

/** The exact command that does this action from an elevated PowerShell window. */
export function elevationCommand(spec) {
  if (!spec) return null;
  if (spec.mode === "restore") return "node pinglab.mjs --restore";
  if (!spec.cli) return null;
  return spec.mode === "revert" ? `node pinglab.mjs --revert ${spec.cli}` : `node pinglab.mjs --apply ${spec.cli}`;
}

/**
 * The one sentence a user sees when Windows did not grant elevation, built here so the
 * GUI, the TUI and the CLI cannot word it differently. It says what was not changed, that
 * nothing was written, and exactly how to proceed.
 */
export function elevationText(spec, { cancelled = false, error = null } = {}) {
  const label = spec?.label || "This setting";
  const cmd = elevationCommand(spec);
  const manual = cmd
    ? `To do it yourself, right-click PingLab.cmd and choose "Run as administrator", or open an elevated PowerShell in the PingLab folder and run: ${cmd}`
    : `To do it yourself, right-click PingLab.cmd and choose "Run as administrator", then press the button again.`;
  if (cancelled) {
    return `${label} was not changed - the Windows administrator prompt was closed, so nothing was written. ${manual}`;
  }
  const why = error ? String(error).replace(/\s+/g, " ").trim() : "";
  // Windows' own "administrative rights" sentence adds nothing to ours; anything else
  // (policy, a driver, a German UAC message) is worth quoting.
  const detail = why && !/administr/i.test(why) ? ` (${why})` : "";
  return `${label} needs administrator rights and Windows did not grant them${detail}, so nothing was written. ${manual}`;
}

/**
 * The one dispatch table for every reversible action, shared by the terminal app, the
 * GUI bridge and the web API so the three cannot drift apart. `dns-apply` takes the
 * servers to write; picking "the fastest resolver" is a caller decision.
 *
 * Every action writes a machine setting, so every action goes through the Windows
 * administrator prompt. This wrapper makes the answer when that prompt is closed (or
 * refused by policy) the same sentence on all three surfaces, and attaches what the
 * caller needs to explain the requirement before it is attempted.
 */
export async function runTweakAction(alias, action, opts = {}) {
  const spec = actionSpec(action);
  const elevated = await isElevated();
  let res;
  try {
    res = await dispatchTweak(alias, action, opts);
  } catch (err) {
    res = { ok: false, error: String(err?.message || err) };
  }
  if (res?.cancelled) {
    res = {
      ...res,
      ok: false,
      needsAdmin: true,
      data: { ...(res.data || {}), message: elevationText(spec, { cancelled: true }) },
    };
  } else if (!res?.ok && !elevated && !res?.unsupported && looksDenied(res?.error || res?.data?.message)) {
    res = {
      ...res,
      needsAdmin: true,
      data: { ...(res.data || {}), message: elevationText(spec, { error: res.error }) },
    };
  }
  return {
    ...res,
    elevation: { needed: !elevated, elevated, label: spec.label, command: elevationCommand(spec) },
  };
}

async function dispatchTweak(alias, action, { servers } = {}) {
  // Every action below records its restore point before it asks Windows for anything, so
  // an unreadable backup file stops the action here instead of being written over.
  const blocked = backupStatus().problem;
  if (blocked) return { ok: false, error: blocked.refusal, backupProblem: true };
  switch (action) {
    case "plan-power-off":
      return setPlanPowerSave(alias, false);
    case "plan-power-on":
      return setPlanPowerSave(alias, true);
    case "nic-power-off":
      return setNicPowerSave(alias, false);
    case "nic-power-on":
      return setNicPowerSave(alias, true);
    case "nagle-off":
      return setNagle(alias, true);
    case "nagle-on":
      return setNagle(alias, false);
    case "dns-apply":
      return applyDns(alias, servers);
    case "dns-reset":
      return resetDns(alias);
    case "adapter-tuning-off":
      return setAdapterTuning(alias, false);
    case "adapter-tuning-on":
      return setAdapterTuning(alias, true);
    case "wifi-order-first":
      return setWlanOrderFirst(alias);
    case "wifi-order-restore":
      return restoreWlanOrder(alias);
    case "restore-all":
      return restoreAll();
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

/**
 * Every action the dispatch table can execute. `--self-check` compares the catalog against
 * this list, so a typo in catalog.mjs shows up as a failed check instead of a button that
 * throws "Unknown action" on a user's machine.
 */
export function knownActions() {
  const names = new Set(TWEAKS.flatMap((t) => [t.actions.apply, t.actions.revert]));
  names.add("restore-all");
  return names;
}

/**
 * What a tweak result means to the user. A dismissed UAC prompt and an adapter that
 * cannot do the thing are expected outcomes, not errors — and neither is ever success.
 */
export function tweakOutcome(result) {
  const message = result?.data?.message || result?.error || null;
  if (result?.ok) return { ok: true, kind: "good", message: message || "Done." };
  if (result?.cancelled) {
    return {
      ok: false,
      kind: "warn",
      message: result.data?.message || "The administrator prompt was closed, so nothing changed.",
    };
  }
  if (result?.unsupported) return { ok: false, kind: "warn", message: message || "Not available on this adapter." };
  return { ok: false, kind: "bad", message: message || "The change did not complete." };
}

/** Revert every tweak this app applied, in one elevation prompt. */
export async function restoreAll() {
  const b = readBackups();
  const parts = [];
  const summary = { dns: [], planPower: [], nicPower: [], nagle: [], adapterTuning: [], wifiOrder: [] };

  // DNS goes back to the servers that were recorded, not blindly to DHCP: on a machine that
  // had fixed servers before PingLab wrote its own, "automatic" is a different setting, not
  // the original one. An empty record means it really was automatic, and only then is the
  // adapter reset.
  const dnsChecks = [];
  const unknownDns = [];
  for (const [alias, rec] of Object.entries(b.dns)) {
    const want = (rec.servers || []).filter((s) => typeof s === "string" && s.trim());
    // A non-empty record is not the same as a fixed DNS list: the router's servers are recorded
    // too. Handing those back as static DNS would leave the adapter pinned to whatever the
    // router said that day, so the record's source decides, exactly as the single-row undo does.
    const dnsSource = dnsSourceOf(rec);
    if (dnsSource === "unknown") {
      unknownDns.push({ alias, want });
      summary.dns.push({ alias, was: want, skipped: "the record does not name where its servers came from" });
      continue;
    }
    const restoreStatic = dnsSource === "static" && want.length > 0;
    const body = restoreStatic
      ? `Set-DnsClientServerAddress -InterfaceAlias '${sq(alias)}' -ServerAddresses @(${want.map((s) => `'${sq(s)}'`).join(", ")}) -ErrorAction Stop`
      : `Set-DnsClientServerAddress -InterfaceAlias '${sq(alias)}' -ResetServerAddresses -ErrorAction Stop`;
    parts.push(`${body}\nClear-DnsClientCache`);
    dnsChecks.push({ alias, want, static: restoreStatic });
    summary.dns.push({ alias, was: want, wasStatic: restoreStatic });
  }

  const planChecks = [];
  const nicChecks = [];
  for (const [alias, rec] of Object.entries(b.planPower)) {
    const sub = `'${WIRELESS_SUBGROUP}'`;
    const setting = `'${WIRELESS_SETTING}'`;
    // Write the recorded values first: this is what actually restores the effective behaviour.
    // Deleting the override alone does not stick, because /setactive writes the in-memory
    // profile back into the registry. So: set values -> activate -> then drop the override
    // so the scheme inherits its defaults again.
    const acVal = Number.isInteger(rec.ac) ? rec.ac : 0;
    const dcVal = Number.isInteger(rec.dc) ? rec.dc : 2;
    // After the values are written and activated, drop the user override again when what we
    // restored is exactly the scheme default. That returns the registry to "inherits defaults",
    // which is the state most machines were in before PingLab touched them.
    parts.push(`$scheme = (Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power\\User\\PowerSchemes' -Name 'ActivePowerScheme' -ErrorAction SilentlyContinue).ActivePowerScheme
$uk = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power\\User\\PowerSchemes\\$scheme\\${WIRELESS_SUBGROUP}\\${WIRELESS_SETTING}"
$dk = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power\\PowerSettings\\${WIRELESS_SUBGROUP}\\${WIRELESS_SETTING}\\DefaultPowerSchemeValues\\$scheme"
powercfg /setacvalueindex $scheme ${sub} ${setting} ${acVal}
powercfg /setdcvalueindex $scheme ${sub} ${setting} ${dcVal}
powercfg /setactive $scheme
$defAc = (Get-ItemProperty -Path $dk -Name 'ACSettingIndex' -ErrorAction SilentlyContinue).ACSettingIndex
$defDc = (Get-ItemProperty -Path $dk -Name 'DCSettingIndex' -ErrorAction SilentlyContinue).DCSettingIndex
if ($null -ne $defAc -and $defAc -eq ${acVal}) { Remove-ItemProperty -Path $uk -Name 'ACSettingIndex' -ErrorAction SilentlyContinue }
if ($null -ne $defDc -and $defDc -eq ${dcVal}) { Remove-ItemProperty -Path $uk -Name 'DCSettingIndex' -ErrorAction SilentlyContinue }`);
    planChecks.push({ alias, ac: acVal, dc: dcVal });
    summary.planPower.push({ alias, wasAc: acVal, wasDc: dcVal });
  }

  // NIC device power management is its own switch; only touch it if PingLab turned it off.
  for (const [alias] of Object.entries(b.nicPower)) {
    parts.push(`try {
  $n = [string](Get-NetAdapterPowerManagement -Name '${sq(alias)}' -ErrorAction Stop | Select-Object -First 1).AllowComputerToTurnOffDevice
  if ($n -eq 'Disabled') {
    Enable-NetAdapterPowerManagement -Name '${sq(alias)}' -ErrorAction Stop | Out-Null
    $n = [string](Get-NetAdapterPowerManagement -Name '${sq(alias)}' -ErrorAction Stop | Select-Object -First 1).AllowComputerToTurnOffDevice
    if ($n -ne 'Enabled') { [void]$restoreWarnings.Add("NIC ${sq(alias)}: device still reports '$n'") }
  }
} catch { [void]$restoreWarnings.Add("NIC ${sq(alias)}: $($_.Exception.Message)") }`);
    nicChecks.push(alias);
    summary.nicPower.push(alias);
  }

  const nagleChecks = [];
  for (const [alias, rec] of Object.entries(b.nagle)) {
    const ack = rec.before?.TcpAckFrequency ?? null;
    const nd = rec.before?.TCPNoDelay ?? null;
    // The key is built from an explicit $guid, and every write is read back. The older
    // version interpolated Get-NetAdapter inside the path and used -ErrorAction
    // SilentlyContinue, so a lookup that came back empty made the whole block a no-op
    // that still reported "All tweaks restored".
    const write = (name, value) =>
      value === null
        ? `if ($null -ne (Get-ItemProperty -Path $k -Name ${name} -ErrorAction SilentlyContinue).${name}) { Remove-ItemProperty -Path $k -Name ${name} -ErrorAction Stop }`
        : `Set-ItemProperty -Path $k -Name ${name} -Value ${Number(value)} -Type DWord -ErrorAction Stop`;
    const expect = (value, v) => (value === null ? `$null -eq $${v}` : `$${v} -eq ${Number(value)}`);
    parts.push(`try {
  $guid = (Get-NetAdapter -Name '${sq(alias)}' -ErrorAction Stop).InterfaceGuid
  $k = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\$guid"
  if (-not (Test-Path $k)) { throw "TCP/IP registry key not found: $k" }
  ${write("TcpAckFrequency", ack)}
  ${write("TCPNoDelay", nd)}
  $ackNow = (Get-ItemProperty -Path $k -Name TcpAckFrequency -ErrorAction SilentlyContinue).TcpAckFrequency
  $ndNow = (Get-ItemProperty -Path $k -Name TCPNoDelay -ErrorAction SilentlyContinue).TCPNoDelay
  if (-not (${expect(ack, "ackNow")}) -or -not (${expect(nd, "ndNow")})) {
    [void]$restoreWarnings.Add("Nagle ${sq(alias)}: registry reads TcpAckFrequency=$ackNow TCPNoDelay=$ndNow")
  }
} catch { [void]$restoreWarnings.Add("Nagle ${sq(alias)}: $($_.Exception.Message)") }`);
    nagleChecks.push({ alias, ack, nd });
    summary.nagle.push(alias);
  }

  for (const [alias, rec] of Object.entries(b.adapterTuning || {})) {
    const sets = Object.entries(rec.values || {})
      .map(([k, v]) => `'${k}' = ${Number(v)}`)
      .join("; ");
    if (sets) {
      parts.push(
        `try { [void](Set-PingLabTuning -Alias '${sq(alias)}' -Targets ([ordered]@{ ${sets} })) } catch { [void]$restoreWarnings.Add("radio ${sq(alias)}: $($_.Exception.Message)") }`,
      );
    }
    summary.adapterTuning.push({ alias, values: rec.values });
  }

  // Auto-connect order: replay the recorded precedence. Steps run top down, so the prefix
  // is correct after each one and the final list matches the backup whatever the current
  // order is. A profile deleted since the backup is left out, never invented back.
  // These run first, before anything that resets the adapter: a driver reset makes netsh
  // accept a profileorder call and drop it, which read as success until the order was
  // checked afterwards.
  const orderParts = [];
  const orderChecks = [];
  for (const [alias, rec] of Object.entries(b.wifiOrder || {})) {
    const cur = await readWlanOrder(alias);
    const steps = planOrderSteps(alias, rec.profiles || [], cur.profiles || [], (name, k) =>
      `[void]$restoreWarnings.Add("auto-connect order: netsh refused '${name}' at position ${k}")`,
    );
    if (steps.length) orderParts.push(`$alias = '${sq(alias)}'\n${steps.join("\n")}`);
    orderChecks.push({ alias, want: rec.profiles || [] });
    summary.wifiOrder.push({ alias, order: rec.profiles || null });
  }
  if (orderParts.length) parts.unshift(...orderParts);

  if (!parts.length) {
    if (unknownDns.length) {
      return {
        ok: false,
        error: `${unknownDns.map((u) => `the DNS record for "${u.alias}" (${u.want.join(", ") || "no servers"}) does not say whether those servers were set by hand or supplied by the router`).join("; ")}, so nothing was guessed and nothing was changed. That record is kept.`,
      };
    }
    return { ok: true, data: { ok: true, message: "Nothing to restore" }, empty: true };
  }

  const script = `${PS_TUNING}
$restoreWarnings = New-Object System.Collections.ArrayList
${parts.join("\n")}
$result = if ($restoreWarnings.Count -gt 0) {
  [ordered]@{ ok = $true; message = 'Restored, with warnings: ' + ($restoreWarnings -join '; ') }
} else { [ordered]@{ ok = $true; message = 'All tweaks restored' } }`;
  const res = await runElevated(script);
  if (res.ok) {
    // Read the precedence back instead of trusting exit codes. Only a matching list may
    // drop the record; if it did not come back, the user still needs it to try again.
    const bad = [];
    for (const check of orderChecks) {
      const after = await readWlanOrder(check.alias);
      if (!sameOrder(after.profiles || [], check.want)) {
        bad.push(`${check.alias}: now ${(after.profiles || []).join(" > ") || "unreadable"}`);
      }
    }
    // DNS read back the same way: a restore that did not stick keeps its record so the
    // recorded servers are not lost behind a success message.
    const badDns = [];
    for (const check of dnsChecks) {
      const live = (await dnsServers()).find((d) => d.alias === check.alias) || null;
      const now = live?.servers ?? [];
      if (check.static) {
        const same = check.want.length === now.length && check.want.every((s, i) => String(now[i]) === String(s));
        if (!same) {
          badDns.push(`${check.alias}: DNS now ${now.join(", ") || "automatic"}, recorded ${check.want.join(", ")}`);
        }
      } else if (!live || live.staticDns !== false) {
        // Automatic means the adapter is no longer pinned to a list. Reading the router's current
        // servers is not the question: after the reset they arrive from DHCP and can differ.
        badDns.push(
          !live
            ? `${check.alias}: the adapter's DNS state could not be read, recorded automatic`
            : `${check.alias}: DNS is still static (${now.join(", ") || "no servers listed"}), recorded automatic`,
        );
      }
    }
    // Every restored area is read back, not just the two that already were. Whatever did
    // not come back keeps its record and the call is reported as not ok: a restore that
    // silently skipped a setting used to clear the record and claim success.
    const badPlan = [];
    for (const check of planChecks) {
      const now = await readPowerState(check.alias);
      if (!now || now.planAc !== check.ac || now.planDc !== check.dc) {
        badPlan.push(`${check.alias}: plan reads AC ${now?.planAc ?? "?"} DC ${now?.planDc ?? "?"}, recorded ${check.ac}/${check.dc}`);
      }
    }
    const badNic = [];
    for (const alias of nicChecks) {
      const now = await readPowerState(alias);
      if (String(now?.ndis || "").toLowerCase() !== "enabled") {
        badNic.push(`${alias}: device reads ${now?.ndis || "unreadable"}, expected Enabled`);
      }
    }
    const badNagle = [];
    for (const check of nagleChecks) {
      const cur = await readNagleValues(check.alias);
      const ackNow = cur ? (cur.tcpAckFrequency ?? null) : undefined;
      const ndNow = cur ? (cur.tcpNoDelay ?? null) : undefined;
      const same = (value, want) => (want === null ? value === null : value !== undefined && value !== null && Number(value) === Number(want));
      if (!same(ackNow, check.ack) || !same(ndNow, check.nd)) {
        const show = (v) => (v === undefined ? "unreadable" : v === null ? "absent" : v);
        badNagle.push(`${check.alias}: registry reads TcpAckFrequency=${show(ackNow)} TCPNoDelay=${show(ndNow)}, recorded ${check.ack ?? "absent"}/${check.nd ?? "absent"}`);
      }
    }
    // Restore points are cleared only as they are proven to have come back. The change
    // history is the record of what this app did to the machine, so it survives the
    // restore; the restore-all entry is appended to it right below.
    const next = { ...structuredClone(EMPTY), history: b.history };
    const keep = [];
    if (bad.length) {
      next.wifiOrder = b.wifiOrder;
      keep.push(`the auto-connect order did not come back as recorded (${bad.join("; ")})`);
    }
    if (unknownDns.length) {
      // Kept as well, and by alias, so the areas this run did restore are still dropped.
      next.dns = { ...(next.dns || {}), ...Object.fromEntries(unknownDns.map((u) => [u.alias, b.dns[u.alias]])) };
      keep.push(
        `DNS was left alone for ${unknownDns.map((u) => `"${u.alias}"`).join(", ")}: the servers recorded there do not say whether they were set by hand or supplied by the router, so guessing could throw a hand-set list away or pin a router list`,
      );
    }
    if (badDns.length) {
      next.dns = b.dns;
      keep.push(`DNS did not come back as recorded (${badDns.join("; ")})`);
    }
    if (badPlan.length) {
      next.planPower = b.planPower;
      keep.push(`the power plan did not come back as recorded (${badPlan.join("; ")})`);
    }
    if (badNic.length) {
      next.nicPower = b.nicPower;
      keep.push(`NIC power management did not come back (${badNic.join("; ")})`);
    }
    if (badNagle.length) {
      next.nagle = b.nagle;
      keep.push(`Nagle's algorithm did not come back (${badNagle.join("; ")})`);
    }
    // The radio properties are read back like everything else: a driver that ignored the
    // restore used to keep its recorded values cleared behind a success message.
    const badTuning = [];
    for (const [alias, rec] of Object.entries(b.adapterTuning || {})) {
      const want = rec.values || {};
      const now = await readTuningValues(alias);
      const disagree = Object.keys(want).filter((k) => !now || Number(now[k]) !== Number(want[k]));
      if (!disagree.length) continue;
      const shows = disagree
        .map((k) => `${k} ${now && now[k] !== undefined ? `reads ${now[k]}` : "unreadable"}, recorded ${want[k]}`)
        .join("; ");
      badTuning.push(`${alias}: ${shows}`);
    }
    if (badTuning.length) {
      next.adapterTuning = b.adapterTuning;
      keep.push(`the radio properties did not come back as recorded (${badTuning.join("; ")})`);
    }
    if (keep.length) {
      if (res.data) {
        res.data.message = `${res.data.message} Restore not complete: ${keep.join(". ")}. The restore points for those settings are kept.`;
        res.data.ok = false;
      }
      res.ok = false;
    }
    try {
      // Merge with what is on disk now rather than writing this run's snapshot: another
      // instance may have recorded a point while the restore was running, and that point is
      // not this restore's to drop.
      updateBackups((fresh) => {
        for (const area of ["dns", "planPower", "nicPower", "nagle", "adapterTuning", "wifiOrder"]) {
          const before = Object.keys(b[area] || {});
          const kept = Object.keys(next[area] || {});
          const merged = {};
          for (const [key, rec] of Object.entries(fresh[area] || {})) {
            if (!before.includes(key)) merged[key] = rec;
            else if (kept.includes(key)) merged[key] = rec;
          }
          fresh[area] = merged;
        }
        fresh.history.unshift({ action: "restore-all", detail: summary, at: new Date().toISOString() });
        fresh.history = fresh.history.slice(0, 50);
      });
    } catch (err) {
      // The settings came back but their records could not be dropped, so those restore
      // points stay listed; saying that beats reporting a clean restore.
      if (res.data) {
        res.data.message = `${res.data.message} ${BACKUP_NAME} could not be updated (${err?.message || err}), so the old restore points are still listed.`;
        res.data.ok = false;
      }
      res.ok = false;
    }
  }
  return res;
}

/** Plain-language description of every restore point, so a count is never unexplained. */
function describeChanges(b) {
  const items = [];
  for (const alias of Object.keys(b.planPower)) {
    const r = b.planPower[alias];
    items.push({
      area: "planPower",
      alias,
      label: tweakLabel("plan-power"),
      changedTo: "maximum performance on AC and battery",
      restoreWillSet: `AC ${r.ac} · battery ${r.dc}`,
      at: r.at,
    });
  }
  for (const alias of Object.keys(b.nicPower)) {
    const r = b.nicPower[alias];
    items.push({
      area: "nicPower",
      alias,
      label: tweakLabel("nic-power"),
      changedTo: "Windows may not power the device down",
      restoreWillSet: r.before ? `device power setting ${r.before}` : "power saving enabled",
      at: r.at,
    });
  }
  for (const alias of Object.keys(b.nagle)) {
    const r = b.nagle[alias];
    items.push({
      area: "nagle",
      alias,
      label: tweakLabel("nagle"),
      changedTo: "TcpAckFrequency=1, TCPNoDelay=1",
      restoreWillSet: `TcpAckFrequency=${r.before?.TcpAckFrequency ?? "absent"}, TCPNoDelay=${r.before?.TCPNoDelay ?? "absent"}`,
      at: r.at,
    });
  }
  for (const alias of Object.keys(b.adapterTuning || {})) {
    const r = b.adapterTuning[alias];
    const vals = r.values || {};
    items.push({
      area: "adapterTuning",
      alias,
      label: tweakLabel("radio-tuning"),
      changedTo: ADAPTER_TUNING.map((t) => `${t.keyword}=${t.want} (${t.wantText})`).join(", "),
      restoreWillSet: Object.entries(vals).map(([k, v]) => `${k}=${v}`).join(", ") || "nothing recorded",
      at: r.at,
    });
  }
  for (const alias of Object.keys(b.wifiOrder || {})) {
    const r = b.wifiOrder[alias];
    items.push({
      area: "wifiOrder",
      alias,
      label: tweakLabel("wifi-order"),
      changedTo: `"${r.joined || "the joined network"}" moved first`,
      restoreWillSet: (r.profiles || []).join(" > ") || "nothing recorded",
      at: r.at,
    });
  }
  for (const alias of Object.keys(b.dns)) {
    const r = b.dns[alias] || {};
    const applied = (b.history || []).find(
      (h) => h?.action === "dns" && h?.detail?.alias === alias && Array.isArray(h.detail.to) && h.detail.to.length,
    )?.detail.to;
    const dnsSource = dnsSourceOf(r);
    const recorded = (r.servers || []).filter((s) => typeof s === "string" && s.trim());
    items.push({
      area: "dns",
      alias,
      label: tweakLabel("dns"),
      changedTo: applied ? `DNS set to ${applied.join(", ")}` : "DNS servers set by PingLab",
      // What restore-all would do, in the same words as the DNS row's own undo. Without this
      // entry the audit printed a restore-point count larger than the list below it.
      restoreWillSet:
        dnsSource === "static" && recorded.length
          ? recorded.join(", ")
          : dnsSource === "automatic"
            ? "automatic (DHCP-provided) DNS"
            : `not known (${recorded.length ? `${recorded.join(", ")} was in effect` : "the record holds no servers"}, but it does not say if they were set by hand)`,
      at: r.at,
    });
  }
  return items;
}

/**
 * Reported state vs the raw value the OS/driver returned, for every setting this app
 * manages. A row with match=false is a bug in the detection logic, not a preference.
 */
export function auditRows(tw) {
  if (!tw) return [];
  const raw = tw.powerRaw || {};
  const pw = (v) => (v === null || v === undefined ? "unreadable" : String(v));
  const rows = [];

  const planOff = raw.planAc === 0 && raw.planDc === 0;
  rows.push({
    key: "planPower",
    setting: tweakLabel("plan-power"),
    reported: tw.planPower === "off" ? "off" : tw.planPower === "on" ? "on" : "unreadable",
    observed: `AC ${pw(raw.planAc)} · DC ${pw(raw.planDc)} (0 = max)`,
    match: tw.planPower !== "unknown" && (tw.planPower === "off") === planOff,
    note: planOff ? "maximum performance on both power sources" : "Windows may throttle the radio",
  });

  const ndis = String(raw.ndis || "").toLowerCase();
  const nicOff = ndis === "disabled" || raw.wmiEnable === false;
  rows.push({
    key: "nicPower",
    setting: tweakLabel("nic-power"),
    reported: tw.nicPower === "off" ? "off" : tw.nicPower === "on" ? "on" : "not applicable",
    observed:
      raw.ndis === "unreadable" && (raw.wmiEnable === null || raw.wmiEnable === undefined)
        ? "no device/WMI setting"
        : `device ${raw.ndis} · WMI ${raw.wmiEnable}`,
    match:
      (tw.nicPower === "off" && nicOff) ||
      (tw.nicPower === "on" && (ndis === "enabled" || raw.wmiEnable === true)) ||
      (tw.nicPower === "unsupported" && ndis !== "enabled" && ndis !== "disabled" && raw.wmiEnable !== true && raw.wmiEnable !== false),
    note:
      raw.ndis === "disabled"
        ? "power saving off"
        : "the driver exposes no device power-management setting (no MSPower_DeviceEnable record, Get-NetAdapterPowerManagement returns nothing), so there is no NIC switch to turn off",
  });

  const ack = tw.nagleValues?.tcpAckFrequency ?? null;
  const nd = tw.nagleValues?.tcpNoDelay ?? null;
  rows.push({
    key: "nagle",
    setting: tweakLabel("nagle"),
    reported: tw.nagleDisabled ? "disabled" : "on",
    observed: `AckFreq ${ack ?? "absent"} · NoDelay ${nd ?? "absent"}`,
    match: tw.nagleDisabled === (ack === 1 || nd === 1),
    note: tw.nagleDisabled ? "small packets are not batched" : "Windows batches small packets",
  });

  const at = tw.adapterTuning;
  // `match` is about whether the app's claim agrees with the driver. Whether PingLab holds
  // a restore point for the values is bookkeeping and goes in the note, like the Wi-Fi
  // order row: folding it in made a fresh install on an already-tuned machine fail this
  // check while printing the same reading on both sides.
  rows.push({
    key: "adapterTuning",
    setting: tweakLabel("radio-tuning"),
    reported: !at ? "unreadable" : at.needsFix ? "not tuned for a fixed desktop" : "tuned",
    observed: at ? at.items.map((i) => i.display).join(" · ") : "driver exposes no such property",
    match: !!at && at.items.every((i) => i.value === i.want) === !at.needsFix,
    note: !at
      ? "nothing to change here"
      : at.needsFix
        ? TUNING_REASON
        : tw.adapterTuningAppliedByUs
          ? "applied on request; no soak here has shown a gain"
          : "values are in place; this install holds no restore point for them",
  });

  const wo = tw.wifiOrder;
  rows.push({
    key: "wifiOrder",
    setting: tweakLabel("wifi-order"),
    reported: !wo
      ? "not applicable"
      : !wo.readable
        ? "unreadable"
        : wo.target
          ? wo.isFirst
            ? `first: ${wo.target}`
            : `${wo.target} at #${wo.position}`
          : wo.joined
            ? "no matching profile"
            : "not joined",
    observed: !wo
      ? "adapter is not wireless"
      : !wo.readable
        ? "netsh returned no profile list"
        : wo.profiles.length
          ? `#1 ${wo.profiles[0]}`
          : "no saved profiles",
    match: !wo
      ? true
      : !wo.readable
        ? false
        : wo.target
          ? wo.isFirst === Boolean(wo.profiles[0] && wo.profiles[0].toLowerCase() === wo.target.toLowerCase())
          : true,
    note: !wo
      ? "this adapter has no wireless profile list to order"
      : wo.appliedByUs
        ? "applied by PingLab; restore puts the previous order back"
        : "Windows rejoins the first profile it can see - an adapter reset can land on the wrong network",
  });

  return rows;
}

export function pendingTweaks() {
  const b = readBackups();
  return {
    items: describeChanges(b),
    // Null when the file is readable. Otherwise a count cannot be trusted, and every
    // surface shows this instead of "0 active changes".
    problem: backupStatus().problem,
    dns: Object.keys(b.dns),
    planPower: Object.keys(b.planPower),
    nicPower: Object.keys(b.nicPower),
    nagle: Object.keys(b.nagle),
    adapterTuning: Object.keys(b.adapterTuning || {}),
    wifiOrder: Object.keys(b.wifiOrder || {}),
    history: b.history.slice(0, 10),
    count:
      Object.keys(b.dns).length +
      Object.keys(b.planPower).length +
      Object.keys(b.nicPower).length +
      Object.keys(b.nagle).length +
      Object.keys(b.adapterTuning || {}).length +
      Object.keys(b.wifiOrder || {}).length,
  };
}


export { readBackups, writeBackups, backupStatus, BACKUP_BUSY } from "./backups.mjs";
export { dnsSourceOf } from "./tweak-shared.mjs";
export { tweakState } from "./tweaks-apply.mjs";
