import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { runElevated, runPsJson, runPs } from "./ps.mjs";
import { dnsServers } from "./net.mjs";
import { TWEAKS, PRESETS, presetById, presetTweaks } from "./catalog.mjs";

const DATA_DIR = join(process.cwd(), "data");
const BACKUP_FILE = join(DATA_DIR, "backups.json");
const sq = (s) => String(s).replace(/'/g, "''");

// Windows "Wireless Adapter Settings -> Power Saving Mode" under the active power scheme.
const WIRELESS_SUBGROUP = "19cbb8fa-5279-450e-9fac-8a3d5fedd0c1";
const WIRELESS_SETTING = "12bbebe6-58d6-4636-95bb-3217ef867c1a";
const POWER_LABELS = {
  0: "maximum performance",
  1: "low power saving",
  2: "medium power saving",
  3: "maximum power saving",
};

const EMPTY = { dns: {}, planPower: {}, nicPower: {}, nagle: {}, adapterTuning: {}, wifiOrder: {}, history: [] };

export function readBackups() {
  try {
    if (!existsSync(BACKUP_FILE)) return structuredClone(EMPTY);
    const merged = { ...structuredClone(EMPTY), ...JSON.parse(readFileSync(BACKUP_FILE, "utf8")) };
    // Earlier builds kept the power-plan values under "powerSave". Fold them into
    // "planPower" so a revert written by an older build still works.
    merged.planPower = { ...(merged.powerSave || {}), ...(merged.planPower || {}) };
    merged.nicPower = merged.nicPower || {};
    merged.adapterTuning = merged.adapterTuning || {};
    merged.wifiOrder = merged.wifiOrder || {};
    delete merged.powerSave;
    return merged;
  } catch {
    return structuredClone(EMPTY);
  }
}

function writeBackups(b) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(BACKUP_FILE, JSON.stringify(b, null, 2), "utf8");
}

function logChange(action, detail) {
  const b = readBackups();
  b.history.unshift({ action, detail, at: new Date().toISOString() });
  b.history = b.history.slice(0, 50);
  writeBackups(b);
}

const pwLabel = (v) => POWER_LABELS[v] ?? (v === null || v === undefined ? "unknown" : `index ${v}`);

/**
 * Read the real power-management state without trusting any write command.
 * Two independent sources:
 *  1. NDIS "allow the computer to turn off this device" — frequently unsupported by Wi-Fi drivers.
 *  2. Windows power scheme "Wireless Adapter Settings -> Power Saving Mode" (user override, else scheme default).
 * Plus the WMI record the NDIS setting is backed by, when the driver exposes it.
 */
function powerReadScript(alias) {
  return `
$alias = '${sq(alias)}'
$sub = '${WIRELESS_SUBGROUP}'
$setting = '${WIRELESS_SETTING}'
$scheme = $null
try { $scheme = (Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power\\User\\PowerSchemes' -Name 'ActivePowerScheme' -ErrorAction Stop).ActivePowerScheme } catch {}
$userKey = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power\\User\\PowerSchemes\\$scheme\\$sub\\$setting"
$defKey = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power\\PowerSettings\\$sub\\$setting\\DefaultPowerSchemeValues\\$scheme"
$ac = $null; $dc = $null; $acSource = 'none'; $dcSource = 'none'
try { $ac = (Get-ItemProperty -Path $userKey -Name 'ACSettingIndex' -ErrorAction Stop).ACSettingIndex; $acSource = 'user' } catch {}
if ($null -eq $ac) { try { $ac = (Get-ItemProperty -Path $defKey -Name 'ACSettingIndex' -ErrorAction Stop).ACSettingIndex; $acSource = 'default' } catch {} }
try { $dc = (Get-ItemProperty -Path $userKey -Name 'DCSettingIndex' -ErrorAction Stop).DCSettingIndex; $dcSource = 'user' } catch {}
if ($null -eq $dc) { try { $dc = (Get-ItemProperty -Path $defKey -Name 'DCSettingIndex' -ErrorAction Stop).DCSettingIndex; $dcSource = 'default' } catch {} }
$ndis = 'unreadable'
try { $ndis = [string](Get-NetAdapterPowerManagement -Name $alias -ErrorAction Stop | Select-Object -First 1).AllowComputerToTurnOffDevice } catch { $ndis = 'unreadable' }
$wmi = $null
$ad = Get-NetAdapter -Name $alias -ErrorAction SilentlyContinue
if ($ad -and $ad.PnPDeviceID) {
  $parts = $ad.PnPDeviceID -split '\\\\'
  $rec = Get-CimInstance -Namespace 'root\\wmi' -ClassName 'MSPower_DeviceEnable' -ErrorAction SilentlyContinue |
    Where-Object { $_.InstanceName -like ($parts[0] + '*') -and $_.InstanceName -like ('*' + $parts[1] + '*') } |
    Select-Object -First 1
  if ($rec) { $wmi = [bool]$rec.Enable }
}
[pscustomobject]@{
  scheme = $scheme; planAc = $ac; planDc = $dc; acSource = $acSource; dcSource = $dcSource;
  ndis = $ndis; wmiEnable = $wmi
} | ConvertTo-Json -Compress -Depth 4
`;
}

/** Raw power facts for one adapter. */
export async function readPowerState(alias) {
  const { data } = await runPsJson(powerReadScript(alias), { timeout: 25000 });
  const row = data?.[0];
  if (!row) return null;
  return {
    scheme: row.scheme || null,
    planAc: typeof row.planAc === "number" ? row.planAc : null,
    planDc: typeof row.planDc === "number" ? row.planDc : null,
    acSource: row.acSource || "none",
    dcSource: row.dcSource || "none",
    ndis: row.ndis || "unreadable",
    wmiEnable: typeof row.wmiEnable === "boolean" ? row.wmiEnable : null,
  };
}

/**
 * Switch 1 of 2: the active power scheme's "Wireless Adapter Settings -> Power Saving Mode".
 * This is what actually throttles the radio on battery, and it applies to every Wi-Fi adapter.
 */
export function normalizePlanPower(raw) {
  if (!raw) return { planPower: "unknown", planDetail: "state could not be read" };
  const readable = raw.planAc !== null || raw.planDc !== null;
  if (!readable) return { planPower: "unknown", planDetail: "state could not be read" };
  const planOff = raw.planAc === 0 && raw.planDc === 0;
  return {
    planPower: planOff ? "off" : "on",
    planDetail: planOff
      ? "maximum performance on AC and battery"
      : `AC ${pwLabel(raw.planAc)} · battery ${pwLabel(raw.planDc)}`,
  };
}

/**
 * Switch 2 of 2: the NIC's own device power management (Device Manager -> adapter ->
 * Power Management -> "Allow the computer to turn off this device to save power").
 * Separate registry/NDIS setting; many Wi-Fi drivers do not expose it at all.
 */
export function normalizeNicPower(raw) {
  if (!raw) return { nicPower: "unknown", nicDetail: "state could not be read" };
  const ndis = String(raw.ndis || "").toLowerCase();
  if (ndis === "disabled" || raw.wmiEnable === false) {
    return { nicPower: "off", nicDetail: "Windows is not allowed to power this device down" };
  }
  if (ndis === "enabled" || raw.wmiEnable === true) {
    return { nicPower: "on", nicDetail: "Windows may power this device down when it looks idle" };
  }
  return {
    nicPower: "unsupported",
    nicDetail:
      "This adapter's driver exposes no device power-management setting (no MSPower_DeviceEnable record and Get-NetAdapterPowerManagement returns nothing), so there is no NIC-level switch to turn off on this machine.",
  };
}

/** Current tweak state for one adapter (read-only, no elevation needed). */
export async function tweakState(alias) {
  if (!alias) return null;
  const script = `
$alias = '${sq(alias)}'
$ad = Get-NetAdapter -Name $alias -ErrorAction SilentlyContinue
$guid = $ad.InterfaceGuid
$key = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\$guid"
$ack = $null
$nodelay = $null
try { $ack = (Get-ItemProperty -Path $key -Name TcpAckFrequency -ErrorAction Stop).TcpAckFrequency } catch {}
try { $nodelay = (Get-ItemProperty -Path $key -Name TCPNoDelay -ErrorAction Stop).TCPNoDelay } catch {}
${PS_TUNING}
$tuning = @(Get-PingLabTuning -Alias $alias -Keywords @(${TUNING_KEYWORDS}))
[pscustomobject]@{ alias = $alias; guid = $guid; tcpAckFrequency = $ack; tcpNoDelay = $nodelay; key = $key; keyExists = (Test-Path $key); tuning = $tuning } | ConvertTo-Json -Compress -Depth 5
`;
  const { data } = await runPsJson(script, { timeout: 25000 });
  const row = data?.[0];
  if (!row) return null;
  const backups = readBackups();
  const [raw, wifiOrder] = await Promise.all([readPowerState(alias), wlanOrderState(alias)]);
  const plan = normalizePlanPower(raw);
  const nic = normalizeNicPower(raw);

  return {
    alias: row.alias,
    guid: row.guid,
    planPower: plan.planPower,
    planDetail: plan.planDetail,
    planAppliedByUs: Boolean(backups.planPower[row.alias]),
    nicPower: nic.nicPower,
    nicDetail: nic.nicDetail,
    nicNdis: raw?.ndis ?? null,
    nicAppliedByUs: Boolean(backups.nicPower[row.alias]),
    adapterTuning: tuningState(row.tuning),
    adapterTuningAppliedByUs: Boolean(backups.adapterTuning[row.alias]),
    wifiOrder,
    powerRaw: raw,
    nagleAvailable: Boolean(row.keyExists),
    nagleDisabled: Number(row.tcpAckFrequency) === 1 || Number(row.tcpNoDelay) === 1,
    nagleValues: {
      tcpAckFrequency: row.tcpAckFrequency === null || row.tcpAckFrequency === undefined ? null : Number(row.tcpAckFrequency),
      tcpNoDelay: row.tcpNoDelay === null || row.tcpNoDelay === undefined ? null : Number(row.tcpNoDelay),
    },
    nagleAppliedByUs: Boolean(backups.nagle[row.alias]),
    registryKey: row.key,
    currentDns: (await dnsServers()).find((d) => d.alias === row.alias)?.servers ?? [],
  };
}

/** Point an adapter at fixed DNS servers, remembering what was there before. */
export async function applyDns(alias, servers) {
  if (!Array.isArray(servers) || !servers.length) throw new Error("No DNS servers given");
  const list = servers.map((s) => `'${sq(s)}'`).join(", ");
  const script = `
$alias = '${sq(alias)}'
$servers = @(${list})
$before = @()
try { $before = @((Get-DnsClientServerAddress -InterfaceAlias $alias -AddressFamily IPv4 -ErrorAction Stop).ServerAddresses) } catch {}
Set-DnsClientServerAddress -InterfaceAlias $alias -ServerAddresses $servers -ErrorAction Stop
Clear-DnsClientCache
$after = @((Get-DnsClientServerAddress -InterfaceAlias $alias -AddressFamily IPv4).ServerAddresses)
$result = [ordered]@{ ok = $true; message = 'DNS updated'; before = @($before); after = @($after) }
`;
  const res = await runElevated(script);
  if (res.ok && res.data) {
    const b = readBackups();
    b.dns[alias] = { servers: res.data.before || [], at: new Date().toISOString() };
    writeBackups(b);
    logChange("dns", { alias, from: res.data.before, to: res.data.after });
  }
  return res;
}

/** Hand the adapter back to DHCP-provided DNS. */
export async function resetDns(alias) {
  const script = `
$alias = '${sq(alias)}'
Set-DnsClientServerAddress -InterfaceAlias $alias -ResetServerAddresses -ErrorAction Stop
Clear-DnsClientCache
$after = @((Get-DnsClientServerAddress -InterfaceAlias $alias -AddressFamily IPv4).ServerAddresses)
$result = [ordered]@{ ok = $true; message = 'DNS reset to automatic'; after = @($after) }
`;
  const res = await runElevated(script);
  if (res.ok) {
    const b = readBackups();
    delete b.dns[alias];
    writeBackups(b);
    logChange("dns-reset", { alias });
  }
  return res;
}

/**
 * Switch 1 of 2: power plan "Wireless Adapter Settings -> Power Saving Mode".
 *   off -> maximum performance on AC and battery (index 0/0)
 *   on  -> the values that were in effect before PingLab changed them
 * Touches only the power scheme; the NIC device setting is handled by setNicPowerSave.
 */
export async function setPlanPowerSave(alias, enabled) {
  const raw = await readPowerState(alias);
  const saved = readBackups().planPower[alias];

  // Already there and already recorded: pressing the button again must not ask for
  // elevation, and must not overwrite the recorded original with the tuned value - that
  // would leave a restore point that restores nothing.
  if (!enabled && saved && raw && raw.planAc === 0 && raw.planDc === 0) {
    return { ok: true, data: { ok: true, message: "Wireless power saving is already at maximum performance - nothing to change." } };
  }
  if (enabled && !saved) {
    return { ok: false, error: "Nothing recorded to restore for wireless power saving." };
  }

  const targetAc = enabled ? (saved?.ac ?? raw?.planAc ?? 1) : 0;
  const targetDc = enabled ? (saved?.dc ?? raw?.planDc ?? 2) : 0;

  const script = `
$alias = '${sq(alias)}'
$sub = '${WIRELESS_SUBGROUP}'
$setting = '${WIRELESS_SETTING}'
$scheme = (Get-ItemProperty -Path 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power\\User\\PowerSchemes' -Name 'ActivePowerScheme' -ErrorAction Stop).ActivePowerScheme
powercfg /setacvalueindex $scheme $sub $setting ${targetAc}
powercfg /setdcvalueindex $scheme $sub $setting ${targetDc}
powercfg /setactive $scheme
$uk = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power\\User\\PowerSchemes\\$scheme\\$sub\\$setting"
$nowAc = (Get-ItemProperty -Path $uk -Name 'ACSettingIndex' -ErrorAction SilentlyContinue).ACSettingIndex
$nowDc = (Get-ItemProperty -Path $uk -Name 'DCSettingIndex' -ErrorAction SilentlyContinue).DCSettingIndex
if ($nowAc -ne ${targetAc} -or $nowDc -ne ${targetDc}) { throw "Power plan did not take the new value (AC=$nowAc DC=$nowDc)" }
$result = [ordered]@{
  ok = $true
  message = '${enabled ? "Wireless power saving restored in the power plan" : "Wireless power saving set to maximum performance in the power plan"}'
  targetAc = ${targetAc}; targetDc = ${targetDc}; nowAc = $nowAc; nowDc = $nowDc
}
`;
  const res = await runElevated(script);
  if (res.ok) {
    const b = readBackups();
    if (enabled) {
      delete b.planPower[alias];
    } else if (!b.planPower[alias]) {
      b.planPower[alias] = {
        ac: raw?.planAc ?? null,
        dc: raw?.planDc ?? null,
        acSource: raw?.acSource ?? "default",
        dcSource: raw?.dcSource ?? "default",
        scheme: raw?.scheme ?? null,
        at: new Date().toISOString(),
      };
    }
    writeBackups(b);
    logChange(enabled ? "plan-power-on" : "plan-power-off", { alias, ac: targetAc, dc: targetDc });
  }
  return res;
}

/**
 * Switch 2 of 2: the NIC's device power management ("allow the computer to turn off this
 * device"). Refused with a clear reason when the driver does not expose it, rather than
 * calling the cmdlet and reporting success for a change that could not happen.
 */
export async function setNicPowerSave(alias, enabled) {
  const raw = await readPowerState(alias);
  const ndis = String(raw?.ndis || "").toLowerCase();
  const supported = ndis === "enabled" || ndis === "disabled" || raw?.wmiEnable !== null;
  if (!supported) {
    return {
      ok: false,
      cancelled: false,
      unsupported: true,
      error:
        "This adapter's driver has no device power-management setting (no MSPower_DeviceEnable record), so there is nothing to change at the NIC level. The power-plan switch is the one that applies here.",
    };
  }
  // Same rule as the plan row: already disabled and already recorded is a no-op, and a
  // second apply never replaces the first restore point.
  if (!enabled && ndis === "disabled" && readBackups().nicPower[alias]) {
    return { ok: true, data: { ok: true, message: "NIC power management is already disabled - nothing to change." } };
  }
  const before = raw?.ndis ?? null;
  const cmd = enabled ? "Enable-NetAdapterPowerManagement" : "Disable-NetAdapterPowerManagement";
  const script = `
$alias = '${sq(alias)}'
try { ${cmd} -Name $alias -ErrorAction Stop | Out-Null } catch { throw "The driver refused the change: $($_.Exception.Message)" }
$after = $null
try { $after = [string](Get-NetAdapterPowerManagement -Name $alias -ErrorAction Stop | Select-Object -First 1).AllowComputerToTurnOffDevice } catch {}
if ($after -ne '${enabled ? "Enabled" : "Disabled"}') { throw "Change did not take effect (device reports '$after')" }
$result = [ordered]@{ ok = $true; message = 'NIC power management ${enabled ? "re-enabled" : "disabled"}'; after = $after }
`;
  const res = await runElevated(script);
  if (res.ok) {
    const b = readBackups();
    if (enabled) delete b.nicPower[alias];
    else if (!b.nicPower[alias]) b.nicPower[alias] = { before, at: new Date().toISOString() };
    writeBackups(b);
    logChange(enabled ? "nic-power-on" : "nic-power-off", { alias, before });
  }
  return res;
}

/** The two registry values this row writes, read without elevation. */
async function readNagleValues(alias) {
  try {
    const { data } = await runPsJson(
      `$alias = '${sq(alias)}'
$guid = (Get-NetAdapter -Name $alias -ErrorAction Stop).InterfaceGuid
$key = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\$guid"
$ack = $null; $nd = $null
try { $ack = (Get-ItemProperty -Path $key -Name TcpAckFrequency -ErrorAction Stop).TcpAckFrequency } catch {}
try { $nd = (Get-ItemProperty -Path $key -Name TCPNoDelay -ErrorAction Stop).TCPNoDelay } catch {}
[pscustomobject]@{ tcpAckFrequency = $ack; tcpNoDelay = $nd } | ConvertTo-Json -Compress`,
      { timeout: 20000 },
    );
    return data?.[0] || null;
  } catch {
    return null;
  }
}

/** Disable (or restore) Nagle's algorithm for one adapter's TCP stack. */
export async function setNagle(alias, enabled) {
  const saved = readBackups().nagle[alias];
  // Undo needs the values captured before PingLab wrote anything. Reading the live values
  // and "restoring" them would write back exactly what is already there - a revert that
  // reports success and changes nothing.
  if (!enabled && !saved?.before) {
    return { ok: false, error: "Nothing recorded to restore for Nagle's algorithm." };
  }
  // Already disabled: no elevation, and above all no new restore point that would record
  // the tuned values as the original.
  if (enabled) {
    const cur = await readNagleValues(alias);
    if (cur && (Number(cur.tcpAckFrequency) === 1 || Number(cur.tcpNoDelay) === 1)) {
      return { ok: true, data: { ok: true, message: "Nagle's algorithm is already disabled on this adapter - nothing to change." } };
    }
  }
  const ackWant = enabled ? 1 : (saved?.before?.TcpAckFrequency ?? null);
  const ndWant = enabled ? 1 : (saved?.before?.TCPNoDelay ?? null);
  const applyBody = enabled
    ? `Set-ItemProperty -Path $key -Name TcpAckFrequency -Value 1 -Type DWord
Set-ItemProperty -Path $key -Name TCPNoDelay -Value 1 -Type DWord`
    : ["TcpAckFrequency", "TCPNoDelay"]
        .map((n) => {
          const v = saved.before[n];
          return v === null || v === undefined
            ? `Remove-ItemProperty -Path $key -Name ${n} -ErrorAction SilentlyContinue`
            : `Set-ItemProperty -Path $key -Name ${n} -Value ${Number(v)} -Type DWord`;
        })
        .join("\n");
  const script = `
$alias = '${sq(alias)}'
$guid = (Get-NetAdapter -Name $alias -ErrorAction Stop).InterfaceGuid
$key = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\$guid"
if (-not (Test-Path $key)) { throw "TCP/IP registry key not found for this adapter: $key" }
$before = [ordered]@{}
foreach ($n in @('TcpAckFrequency','TCPNoDelay')) {
  $v = $null
  try { $v = (Get-ItemProperty -Path $key -Name $n -ErrorAction Stop).$n } catch { $v = $null }
  $before[$n] = $v
}
${applyBody}
# Read back: a write that returned is not proof, and a revert that put back the live values
# instead of the recorded ones must be caught here rather than reported as done.
$ack = (Get-ItemProperty -Path $key -Name TcpAckFrequency -ErrorAction SilentlyContinue).TcpAckFrequency
$nd = (Get-ItemProperty -Path $key -Name TCPNoDelay -ErrorAction SilentlyContinue).TCPNoDelay
if (-not ${ackWant === null ? "($null -eq $ack)" : `($ack -eq ${Number(ackWant)})`} -or -not ${ndWant === null ? "($null -eq $nd)" : `($nd -eq ${Number(ndWant)})`}) {
  throw "registry left TcpAckFrequency=$ack TCPNoDelay=$nd"
}
$result = [ordered]@{ ok = $true; guid = $guid; key = $key; before = $before; message = 'Nagle ${enabled ? "disabled" : "restored"}' }
`;
  const res = await runElevated(script);
  if (res.ok && res.data) {
    const b = readBackups();
    const before = res.data.before || {};
    if (enabled) {
      // Keep the first record: a second apply must not turn the original into the tuned value.
      const differs = Number(before.TcpAckFrequency) !== 1 || Number(before.TCPNoDelay) !== 1;
      if (!b.nagle[alias] && differs) {
        b.nagle[alias] = { guid: res.data.guid, key: res.data.key, before, at: new Date().toISOString() };
      }
    } else {
      delete b.nagle[alias];
    }
    writeBackups(b);
    logChange(enabled ? "nagle-off" : "nagle-on", { alias });
  }
  return res;
}

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
 * The one dispatch table for every reversible action, shared by the terminal app, the
 * GUI bridge and the web API so the three cannot drift apart. `dns-apply` takes the
 * servers to write; picking "the fastest resolver" is a caller decision.
 */
export async function runTweakAction(alias, action, { servers } = {}) {
  switch (action) {
    case "plan-power-off":
    case "powersave-off": // name used by the first build
      return setPlanPowerSave(alias, false);
    case "plan-power-on":
    case "powersave-on":
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
    case "apply-all":
      // Kept for older callers: "apply everything" is the safe preset now, never the whole
      // catalog. The radio experiment is unreachable from any bundled action.
      return applyPreset(alias, "safe");
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
  names.add("apply-all");
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
    return { ok: false, kind: "warn", message: "The administrator prompt was closed, so nothing changed." };
  }
  if (result?.unsupported) return { ok: false, kind: "warn", message: message || "Not available on this adapter." };
  return { ok: false, kind: "bad", message: message || "The change did not complete." };
}

/**
 * Adapter properties a fixed desktop can plausibly benefit from, read from the driver's
 * own advanced properties. Nothing here comes from a generic "gaming tweak" list.
 *
 * Both were applied on this machine and measured across repeated 60 s soaks: no gain in
 * latency or jitter. So the vendor defaults stay defaults, the row says "not tuned for a
 * fixed desktop" rather than "wrong", and TUNING_REASON travels with it. If a soak ever
 * shows a cost, that reason is what has to change first.
 *
 * The PowerShell that reads and writes them lives once, in PS_TUNING below.
 */
const ADAPTER_TUNING = [
  { keyword: "MIMOPowerSaveMode", want: 3, wantText: "No SMPS" },
  { keyword: "RoamAggressiveness", want: 0, wantText: "Lowest" },
];

/**
 * What the app is allowed to claim about these vendor defaults. Until a soak shows they
 * cost something, they are "not tuned for a fixed desktop", never "wrong".
 */
const TUNING_REASON = "Vendor defaults assume battery life; no soak here has measured a cost.";

const TUNING_KEYWORDS = ADAPTER_TUNING.map((t) => `'${t.keyword}'`).join(", ");

/** The recommended values, as a PowerShell ordered dictionary. */
const TUNING_TARGETS = `[ordered]@{ ${ADAPTER_TUNING.map((t) => `'${t.keyword}' = ${t.want}`).join("; ")} }`;

/**
 * The only copy of the radio get/set/read-back logic. Every script that touches these
 * properties defines these two functions and calls them, so "apply one fix", "apply
 * every fix" and "restore everything" cannot drift apart:
 *
 *   Get-PingLabTuning -Alias WLAN -Keywords @('MIMOPowerSaveMode')  -> keyword/value/display
 *   Set-PingLabTuning -Alias WLAN -Targets $targets                 -> previous values, verified
 *
 * Set-PingLabTuning throws when the driver does not report back the value it was given:
 * a command that returns is not proof the setting stuck.
 */
const PS_TUNING = `
function Get-PingLabTuning {
  param([string]$Alias, [string[]]$Keywords)
  $rows = @(Get-NetAdapterAdvancedProperty -Name $Alias -ErrorAction Stop)
  foreach ($k in $Keywords) {
    $p = $rows | Where-Object { $_.RegistryKeyword -eq $k } | Select-Object -First 1
    if ($null -eq $p) { continue }
    $v = $p.RegistryValue
    if ($v -is [array]) { $v = $v[0] }
    if ($null -eq $v) { continue }
    [pscustomobject]@{ keyword = $k; value = [int]$v; display = [string]$p.DisplayValue }
  }
}
# One property, read with patience. The driver resets the adapter after a write and
# applies the value asynchronously, so a read taken during that window can return the
# old value, return nothing, or throw. Five polls 800 ms apart cover a 1-3 s reset with
# room to spare, and still end quickly enough for a real failure to be reported.
#
# -Expect waits for that value; without it, the first successful read wins (used for the
# pre-write read, where any current value is a valid answer). The last row seen is
# returned even if it never matched, so the caller can report what the driver says.
function Read-PingLabTuning {
  param([string]$Alias, [string]$Keyword, [Nullable[int]]$Expect)
  $last = $null
  for ($attempt = 1; $attempt -le 5; $attempt++) {
    try {
      $cur = @(Get-PingLabTuning -Alias $Alias -Keywords @($Keyword))
      if ($cur.Count -gt 0) {
        $last = $cur[0]
        if ($null -eq $Expect -or $last.value -eq $Expect) { return $last }
      }
    } catch { }
    if ($attempt -lt 5) { Start-Sleep -Milliseconds 800 }
  }
  return $last
}

function Set-PingLabTuning {
  param([string]$Alias, [System.Collections.IDictionary]$Targets)
  $before = [ordered]@{}
  $written = @()
  foreach ($k in $Targets.Keys) {
    $row = Read-PingLabTuning -Alias $Alias -Keyword $k
    if ($null -eq $row) { throw "This adapter has no '$k' setting" }
    $before[$k] = $row.value
    # Writing a value the driver already reports costs an adapter reset, which can drop
    # the link and land the machine on a different network. Only touch what is wrong.
    if ($row.value -eq [int]$Targets[$k]) { continue }
    Set-NetAdapterAdvancedProperty -Name $Alias -RegistryKeyword $k -RegistryValue $Targets[$k] -ErrorAction Stop
    $written += $k
  }
  # Only what was written needs proving: a skipped key matched the target a moment ago.
  foreach ($k in $written) {
    $want = [int]$Targets[$k]
    $row = Read-PingLabTuning -Alias $Alias -Keyword $k -Expect $want
    if ($null -eq $row -or $row.value -ne $want) {
      $reported = if ($null -eq $row) { 'nothing' } else { $row.value }
      throw "$k did not take the new value (the driver reports $reported after repeated checks)"
    }
  }
  return $before
}
`;

/** Radio row state: stock values stay stock unless the user opts in. */
function tuningState(rows) {
  const byKey = new Map((rows || []).map((r) => [r.keyword, r]));
  const items = ADAPTER_TUNING.filter((t) => byKey.has(t.keyword)).map((t) => ({ ...t, ...byKey.get(t.keyword) }));
  if (!items.length) return null;
  return { items, needsFix: items.some((i) => i.value !== i.want), reason: TUNING_REASON };
}

/** Profile name of the network the adapter is joined to, or null. */
async function connectionProfile(alias) {
  if (!alias) return null;
  try {
    const { data } = await runPsJson(
      `(Get-NetConnectionProfile -InterfaceAlias '${sq(alias)}' -ErrorAction SilentlyContinue | Select-Object -First 1).Name | ConvertTo-Json -Compress`,
      { timeout: 15000 },
    );
    return typeof data?.[0] === "string" ? data[0] : null;
  } catch {
    return null;
  }
}

/** Current values as { keyword: number }, read through the shared helper. */
async function readTuningValues(alias) {
  try {
    const { data } = await runPsJson(
      `$alias = '${sq(alias)}'
${PS_TUNING}
$out = [ordered]@{}
foreach ($r in @(Get-PingLabTuning -Alias $alias -Keywords @(${TUNING_KEYWORDS}))) { $out[$r.keyword] = $r.value }
$out | ConvertTo-Json -Compress`,
      { timeout: 25000 },
    );
    return data?.[0] || null;
  } catch {
    return null;
  }
}

/**
 * Set (or restore) the adapter's latency-relevant properties. Reversible: the previous
 * values are stored so restore-all can put the driver back exactly as it was.
 */
export async function setAdapterTuning(alias, restore = false) {
  const saved = readBackups().adapterTuning[alias];
  const targets = restore
    ? saved?.values || null
    : Object.fromEntries(ADAPTER_TUNING.map((t) => [t.keyword, t.want]));
  if (!targets) return { ok: false, error: "Nothing recorded to restore for this adapter." };

  // Nothing to do, so do not ask for elevation and do not reset the adapter.
  if (!restore) {
    const cur = await readTuningValues(alias);
    if (cur && ADAPTER_TUNING.every((t) => Number(cur[t.keyword]) === t.want)) {
      return { ok: true, data: { ok: true, message: "Already at the recommended values - nothing to change." } };
    }
  }

  const sets = Object.entries(targets)
    .map(([k, v]) => `'${k}' = ${Number(v)}`)
    .join("; ");
  const script = `
$alias = '${sq(alias)}'
${PS_TUNING}
$before = Set-PingLabTuning -Alias $alias -Targets ([ordered]@{ ${sets} })
$result = [ordered]@{
  ok = $true
  message = '${restore ? "Wi-Fi radio settings restored" : "Wi-Fi radio set for latency: MIMO power save off, roaming at its lowest"}'
  before = $before
}
`;
  const joinedBefore = await connectionProfile(alias);
  const res = await runElevated(script);
  if (res.ok) {
    // Changing these properties makes the driver reset the adapter, and a reset can
    // land the machine on a different network profile than the one it was using.
    await new Promise((r) => setTimeout(r, 3000));
    const joinedAfter = await connectionProfile(alias);
    if (joinedBefore && joinedAfter && joinedBefore !== joinedAfter && res.data) {
      res.data.message = `${res.data.message} Heads up: Windows rejoined "${joinedAfter}" instead of "${joinedBefore}".`;
    }
    const b = readBackups();
    // A restore point is only worth storing when something actually changed, otherwise
    // "restore" would put back the very values we just wrote.
    const before = res.data?.before || {};
    const changed = Object.entries(before).some(([k, v]) => Number(v) !== Number(targets[k]));
    if (restore) delete b.adapterTuning[alias];
    else if (changed) b.adapterTuning[alias] = { values: before, at: new Date().toISOString() };
    writeBackups(b);
    logChange(restore ? "adapter-tuning-on" : "adapter-tuning-off", { alias, values: res.data?.before || null });
  }
  return res;
}

/* ------------------------------------------------- Wi-Fi auto-connect order */

/**
 * The profile precedence list from `netsh wlan show profiles`. Windows prints one block
 * per profile class, each title underlined with dashes; the user profiles are the last
 * block, so read-only group-policy entries above it can never leak in. Null means "no
 * such block", and the caller refuses to guess rather than writing a wrong order.
 */
export function parseWlanProfiles(text) {
  const lines = String(text || "").split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (/^-{3,}\s*$/.test(lines[i])) start = i + 1;
  if (start < 0) return null;
  const names = [];
  for (const line of lines.slice(start)) {
    const m = line.match(/^\s+\S.*?\s*:\s*(.+?)\s*$/);
    if (m) names.push(m[1]);
  }
  return names;
}

/** SSID of the network the wireless adapter is joined to, if any. */
function parseJoinedSsid(text) {
  return String(text || "").match(/^\s*SSID\s*:\s*(.+?)\s*$/m)?.[1] || null;
}

/** True when `got` opens with every still-existing profile of `want`, in order. */
function sameOrder(got, want) {
  const present = (want || []).filter((n) => got.some((g) => g.toLowerCase() === n.toLowerCase()));
  return present.every((n, i) => (got[i] || "").toLowerCase() === n.toLowerCase());
}

/**
 * The netsh calls that put `want` back on top of `current`. Assigning position k+1 to the
 * profile that belongs there, top down, leaves the prefix correct after every step, so the
 * final list matches `want` from any starting arrangement.
 */
function planOrderSteps(alias, want, current, fail) {
  const sim = [...current];
  const steps = [];
  const present = (want || []).filter((n) => sim.some((c) => c.toLowerCase() === n.toLowerCase()));
  present.forEach((name, k) => {
    const idx = sim.findIndex((c) => c.toLowerCase() === name.toLowerCase());
    if (idx === k) return;
    const real = sim[idx];
    steps.push(
      `$n = '${sq(real)}'\nnetsh wlan set profileorder name="$n" interface="$alias" priority=${k + 1} | Out-Null\nif ($LASTEXITCODE -ne 0) { ${fail(real, k + 1)} }`,
    );
    sim.splice(idx, 1);
    sim.splice(k, 0, real);
  });
  return steps;
}

/** WLAN precedence list and the joined SSID. Never throws. */
async function readWlanOrder(alias) {
  const iface = await runPs("netsh wlan show interfaces", { timeout: 15000 });
  const text = iface.stdout || "";
  // A machine without a wireless adapter answers with a plain "no wireless interface".
  if (!iface.ok || !/(\bSSID\s*:|\bBSSID\s*:|802\.11|\bName\s*:)/i.test(text)) return { wifi: false };
  const joined = parseJoinedSsid(text);
  const listed = await runPs(`netsh wlan show profiles interface="${String(alias).replace(/"/g, "")}"`, {
    timeout: 15000,
  });
  return { wifi: true, joined, profiles: parseWlanProfiles(listed.stdout) };
}

/** What the auto-connect row shows, and whether PingLab is the reason it changed. */
async function wlanOrderState(alias) {
  const read = await readWlanOrder(alias);
  if (!read.wifi) return null;
  const profiles = read.profiles || [];
  const target = read.joined ? profiles.find((p) => p.toLowerCase() === read.joined.toLowerCase()) || null : null;
  const position = target ? profiles.indexOf(target) + 1 : null;
  return {
    readable: read.profiles !== null,
    profiles,
    joined: read.joined,
    target,
    position,
    isFirst: position === 1,
    appliedByUs: Boolean(readBackups().wifiOrder[alias]),
  };
}

/**
 * Move the joined network's profile to the top of the auto-connect order, so an adapter
 * reset rejoins it instead of whichever saved network happens to come first. The whole
 * previous order is recorded, and only when it actually changed - pressing this twice is
 * a no-op that stores nothing new and asks for no elevation.
 */
export async function setWlanOrderFirst(alias) {
  const read = await readWlanOrder(alias);
  if (!read.wifi) return { ok: false, error: "This adapter is not wireless, so it has no auto-connect order." };
  if (read.profiles === null) {
    return { ok: false, error: "Windows returned no readable WLAN profile list (netsh wlan show profiles)." };
  }
  if (!read.profiles.length) {
    return { ok: false, error: "No saved Wi-Fi profiles on this adapter, so there is no order to change." };
  }
  if (!read.joined) {
    return { ok: false, error: "This adapter is not joined to a Wi-Fi network, so there is no profile to move first." };
  }
  const target = read.profiles.find((p) => p.toLowerCase() === read.joined.toLowerCase());
  if (!target) {
    return { ok: false, error: `Wi-Fi is joined to "${read.joined}", but Windows has no saved profile of that name.` };
  }
  if (read.profiles[0] === target) {
    return {
      ok: true,
      data: { ok: true, message: `"${target}" is already first in the auto-connect order - nothing to change.` },
    };
  }

  const script = `
$alias = '${sq(alias)}'
$n = '${sq(target)}'
netsh wlan set profileorder name="$n" interface="$alias" priority=1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "netsh refused to move '$n' to the top (exit $LASTEXITCODE)" }
$result = [ordered]@{ ok = $true; message = 'auto-connect order updated' }
`;
  const res = await runElevated(script);
  if (!res.ok) return res;

  const after = await readWlanOrder(alias);
  if (!after.profiles || after.profiles[0] !== target) {
    return {
      ok: false,
      error: `Windows accepted the command but the order still reads ${(after.profiles || []).join(" > ") || "unreadable"}.`,
    };
  }

  const b = readBackups();
  if (!b.wifiOrder[alias]) {
    b.wifiOrder[alias] = { profiles: read.profiles, joined: read.joined, at: new Date().toISOString() };
  }
  writeBackups(b);
  logChange("wifi-order-first", { alias, order: read.profiles, target });
  return {
    ok: true,
    data: {
      ok: true,
      message: `"${target}" is now first in the Wi-Fi auto-connect order; an adapter reset rejoins it instead of another saved network.`,
      order: after.profiles,
    },
  };
}

/**
 * Put the recorded precedence back and drop the restore point. Profiles deleted since the
 * backup are left out rather than recreated, and the result is verified by reading the
 * order again instead of trusting netsh's exit code.
 */
export async function restoreWlanOrder(alias) {
  const rec = readBackups().wifiOrder?.[alias];
  if (!rec?.profiles?.length) return { ok: false, error: "Nothing recorded to restore for the Wi-Fi auto-connect order." };
  const cur = await readWlanOrder(alias);
  if (cur.profiles === null) {
    return { ok: false, error: "The WLAN profile list is unreadable right now, so the order cannot be restored safely." };
  }

  const steps = planOrderSteps(alias, rec.profiles, cur.profiles, (name, k) =>
    `throw "netsh refused to move '${name}' to position ${k} (exit $LASTEXITCODE)"`,
  );
  if (!steps.length) {
    const b = readBackups();
    delete b.wifiOrder[alias];
    writeBackups(b);
    logChange("wifi-order-restore", { alias, order: rec.profiles, noop: true });
    return {
      ok: true,
      data: { ok: true, message: `The auto-connect order already matches what was recorded (${rec.profiles.join(" > ")}).` },
    };
  }

  const script = `$alias = '${sq(alias)}'\n${steps.join("\n")}\n$result = [ordered]@{ ok = $true; message = 'auto-connect order restored' }`;
  const res = await runElevated(script);
  if (!res.ok) return res;

  const after = await readWlanOrder(alias);
  if (!sameOrder(after.profiles || [], rec.profiles)) {
    return {
      ok: false,
      error: `The order did not come back as recorded: now ${(after.profiles || []).join(" > ") || "unreadable"}.`,
    };
  }

  const b = readBackups();
  delete b.wifiOrder[alias];
  writeBackups(b);
  logChange("wifi-order-restore", { alias, order: rec.profiles });
  return {
    ok: true,
    data: { ok: true, message: `Auto-connect order restored: ${(after.profiles || []).join(" > ")}.` },
  };
}

/** Revert every tweak this app applied, in one elevation prompt. */
export async function restoreAll() {
  const b = readBackups();
  const parts = [];
  const summary = { dns: [], planPower: [], nicPower: [], nagle: [], adapterTuning: [], wifiOrder: [] };

  for (const [alias, rec] of Object.entries(b.dns)) {
    parts.push(`Set-DnsClientServerAddress -InterfaceAlias '${sq(alias)}' -ResetServerAddresses -ErrorAction SilentlyContinue
Clear-DnsClientCache`);
    summary.dns.push({ alias, was: rec.servers });
  }

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
    summary.planPower.push({ alias, wasAc: acVal, wasDc: dcVal });
  }

  // NIC device power management is its own switch; only touch it if PingLab turned it off.
  for (const [alias] of Object.entries(b.nicPower)) {
    parts.push(`$n = $null
try { $n = [string](Get-NetAdapterPowerManagement -Name '${sq(alias)}' -ErrorAction Stop | Select-Object -First 1).AllowComputerToTurnOffDevice } catch {}
if ($n -eq 'Disabled') { Enable-NetAdapterPowerManagement -Name '${sq(alias)}' -ErrorAction SilentlyContinue }`);
    summary.nicPower.push(alias);
  }

  for (const [alias, rec] of Object.entries(b.nagle)) {
    const key = `HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\$((Get-NetAdapter -Name '${sq(alias)}' -ErrorAction SilentlyContinue).InterfaceGuid)`;
    const restoreAck =
      rec.before?.TcpAckFrequency === null || rec.before?.TcpAckFrequency === undefined
        ? `Remove-ItemProperty -Path $k -Name TcpAckFrequency -ErrorAction SilentlyContinue`
        : `Set-ItemProperty -Path $k -Name TcpAckFrequency -Value ${Number(rec.before.TcpAckFrequency)} -Type DWord -ErrorAction SilentlyContinue`;
    const restoreNodelay =
      rec.before?.TCPNoDelay === null || rec.before?.TCPNoDelay === undefined
        ? `Remove-ItemProperty -Path $k -Name TCPNoDelay -ErrorAction SilentlyContinue`
        : `Set-ItemProperty -Path $k -Name TCPNoDelay -Value ${Number(rec.before.TCPNoDelay)} -Type DWord -ErrorAction SilentlyContinue`;
    parts.push(`$k = "${key}"
if (Test-Path $k) { ${restoreAck}; ${restoreNodelay} }`);
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

  if (!parts.length) return { ok: true, data: { ok: true, message: "Nothing to restore" }, empty: true };

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
    const next = structuredClone(EMPTY);
    if (bad.length) {
      next.wifiOrder = b.wifiOrder;
      if (res.data) {
        res.data.message = `${res.data.message} The auto-connect order did not come back as recorded (${bad.join("; ")}).`;
      }
    }
    writeBackups(next);
    logChange("restore-all", summary);
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
      label: "Wireless power saving (power plan)",
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
      label: "NIC power management",
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
      label: "Nagle's algorithm",
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
      label: "Wi-Fi radio power save (driver)",
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
      label: "Wi-Fi auto-connect order",
      changedTo: `"${r.joined || "the joined network"}" moved first`,
      restoreWillSet: (r.profiles || []).join(" > ") || "nothing recorded",
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
    setting: "Wireless power saving (power plan)",
    reported: tw.planPower === "off" ? "off" : tw.planPower === "on" ? "on" : "unreadable",
    observed: `AC ${pw(raw.planAc)} · DC ${pw(raw.planDc)} (0 = max)`,
    match: tw.planPower !== "unknown" && (tw.planPower === "off") === planOff,
    note: planOff ? "maximum performance on both power sources" : "Windows may throttle the radio",
  });

  const ndis = String(raw.ndis || "").toLowerCase();
  const nicOff = ndis === "disabled" || raw.wmiEnable === false;
  rows.push({
    key: "nicPower",
    setting: "NIC power management",
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
    setting: "Nagle's algorithm",
    reported: tw.nagleDisabled ? "disabled" : "on",
    observed: `AckFreq ${ack ?? "absent"} · NoDelay ${nd ?? "absent"}`,
    match: tw.nagleDisabled === (ack === 1 || nd === 1),
    note: tw.nagleDisabled ? "small packets are not batched" : "Windows batches small packets",
  });

  const at = tw.adapterTuning;
  rows.push({
    key: "adapterTuning",
    setting: "Wi-Fi radio power save (driver)",
    reported: !at ? "unreadable" : at.needsFix ? "not tuned for a fixed desktop" : "tuned",
    observed: at ? at.items.map((i) => i.display).join(" · ") : "driver exposes no such property",
    match: !!at && at.needsFix === at.items.some((i) => i.value !== i.want) && tw.adapterTuningAppliedByUs === !at.needsFix,
    note: !at
      ? "nothing to change here"
      : at.needsFix
        ? TUNING_REASON
        : "applied on request; no soak here has shown a gain",
  });

  const wo = tw.wifiOrder;
  rows.push({
    key: "wifiOrder",
    setting: "Wi-Fi auto-connect order",
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
