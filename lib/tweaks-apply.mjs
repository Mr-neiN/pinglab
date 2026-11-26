import { join } from "node:path";
import { runElevated, runPsJson } from "./ps.mjs";
import { dnsServers } from "./net.mjs";
import { sq, dnsSourceOf, POWER_LABELS } from "./tweak-shared.mjs";
import { readBackups, recordRestorePoint, finishChange, schemeKey, WIRELESS_SUBGROUP, WIRELESS_SETTING } from "./backups.mjs";
import { tuningState, PS_TUNING, TUNING_KEYWORDS } from "./tweaks-tuning.mjs";
import { wlanOrderState } from "./tweaks-wlan.mjs";
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
 * The wireless power-saving values of one named scheme, whether or not it is active.
 * Restoration must read back the scheme it wrote, not whatever plan happens to be active
 * afterwards. Returns `{ exists: false }` for a scheme Windows no longer has.
 */
export async function readPlanPowerForScheme(scheme) {
  const want = String(scheme || "").trim();
  if (!want) return null;
  const script = `
$planSchemeRead = $true
$scheme = '${sq(want)}'
$sub = '${WIRELESS_SUBGROUP}'
$setting = '${WIRELESS_SETTING}'
$root = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power\\User\\PowerSchemes'
if (-not (Test-Path (Join-Path $root $scheme))) {
  [pscustomobject]@{ scheme = $scheme; exists = $false; ac = $null; dc = $null } | ConvertTo-Json -Compress
  exit 0
}
$uk = Join-Path $root "$scheme\\$sub\\$setting"
$dk = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power\\PowerSettings\\$sub\\$setting\\DefaultPowerSchemeValues\\$scheme"
$ac = $null; $dc = $null; $acSource = 'none'; $dcSource = 'none'
try { $ac = (Get-ItemProperty -Path $uk -Name 'ACSettingIndex' -ErrorAction Stop).ACSettingIndex; $acSource = 'user' } catch {}
if ($null -eq $ac) { try { $ac = (Get-ItemProperty -Path $dk -Name 'ACSettingIndex' -ErrorAction Stop).ACSettingIndex; $acSource = 'default' } catch {} }
try { $dc = (Get-ItemProperty -Path $uk -Name 'DCSettingIndex' -ErrorAction Stop).DCSettingIndex; $dcSource = 'user' } catch {}
if ($null -eq $dc) { try { $dc = (Get-ItemProperty -Path $dk -Name 'DCSettingIndex' -ErrorAction Stop).DCSettingIndex; $dcSource = 'default' } catch {} }
[pscustomobject]@{ scheme = $scheme; exists = $true; ac = $ac; dc = $dc; acSource = $acSource; dcSource = $dcSource } | ConvertTo-Json -Compress
`;
  try {
    const { data } = await runPsJson(script, { timeout: 20000 });
    const row = data?.[0];
    if (!row) return null;
    return {
      scheme: row.scheme || want,
      exists: row.exists !== false,
      ac: typeof row.ac === "number" ? row.ac : null,
      dc: typeof row.dc === "number" ? row.dc : null,
      acSource: row.acSource || "none",
      dcSource: row.dcSource || "none",
    };
  } catch {
    return null;
  }
}

/**
 * Switch 1 of 2: the active power scheme's "Wireless Adapter Settings -> Power Saving Mode".
 * This is what actually throttles the radio on battery, and it applies to every Wi-Fi adapter.
 */
function normalizePlanPower(raw) {
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
function normalizeNicPower(raw) {
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
export async function tweakState(alias, { dns = null } = {}) {
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
  // /api/state already read DNS for the connection panel; passing that list here avoids a
  // second PowerShell launch for the same answer. Everything else reads it itself.
  const dnsList = dns || (await dnsServers());
  const plan = normalizePlanPower(raw);
  const nic = normalizeNicPower(raw);

  return {
    alias: row.alias,
    guid: row.guid,
    planPower: plan.planPower,
    planDetail: plan.planDetail,
    nicPower: nic.nicPower,
    nicDetail: nic.nicDetail,
    adapterTuning: tuningState(row.tuning),
    adapterTuningAppliedByUs: Boolean(backups.adapterTuning[row.alias]),
    wifiOrder,
    powerRaw: raw,
    nagleAvailable: Boolean(row.keyExists),
    // Both values are the target. One of them being 1 is a half-applied state, not "disabled":
    // treating it as done would skip the other write forever and the UI would claim a state
    // the adapter does not have.
    nagleDisabled: Number(row.tcpAckFrequency) === 1 && Number(row.tcpNoDelay) === 1,
    nagleAckDisabled: Number(row.tcpAckFrequency) === 1,
    nagleNoDelayDisabled: Number(row.tcpNoDelay) === 1,
    nagleValues: {
      tcpAckFrequency: row.tcpAckFrequency === null || row.tcpAckFrequency === undefined ? null : Number(row.tcpAckFrequency),
      tcpNoDelay: row.tcpNoDelay === null || row.tcpNoDelay === undefined ? null : Number(row.tcpNoDelay),
    },
    currentDns: dnsList.find((d) => d.alias === row.alias)?.servers ?? [],
  };
}

/** Point an adapter at fixed DNS servers, remembering what was there before. */
export async function applyDns(alias, servers) {
  if (!Array.isArray(servers) || !servers.length) throw new Error("No DNS servers given");
  // The servers in effect now are the restore point, so they are read and saved before
  // Windows is asked to change them.
  const current = (await dnsServers()).find((d) => d.alias === alias);
  if (!current) {
    return {
      ok: false,
      error: `Could not read the current DNS servers for "${alias}", so there is no original value to record. Nothing was changed.`,
    };
  }
  // Whether the DNS list was typed in goes into the record: without it, undo cannot tell
  // "hand back to automatic" from "put my static servers back". The adapter's DHCP state
  // is not that answer - a machine can take its address from the router and still have
  // its resolvers configured by hand.
  const point = recordRestorePoint("dns", alias, { servers: current.servers, staticDns: current.staticDns });
  if (!point.ok) return point;
  const list = servers.map((s) => `'${sq(s)}'`).join(", ");
  const script = `
$alias = '${sq(alias)}'
$servers = @(${list})
$before = @()
try { $before = @((Get-DnsClientServerAddress -InterfaceAlias $alias -AddressFamily IPv4 -ErrorAction Stop).ServerAddresses) } catch {}
Set-DnsClientServerAddress -InterfaceAlias $alias -ServerAddresses $servers -ErrorAction Stop
Clear-DnsClientCache
$after = @((Get-DnsClientServerAddress -InterfaceAlias $alias -AddressFamily IPv4).ServerAddresses)
# Read back and compare: Set-DnsClientServerAddress returning is not proof the adapter
# kept the list, and this row used to report "DNS updated" without ever comparing.
if ((($servers | ForEach-Object { [string]$_ } | Sort-Object) -join ',') -ne (($after | ForEach-Object { [string]$_ } | Sort-Object) -join ',')) {
  throw "DNS did not take the new servers (the adapter reads $($after -join ', '))"
}
$result = [ordered]@{ ok = $true; message = 'DNS updated'; before = @($before); after = @($after) }
`;
  const res = await runElevated(script);
  return finishChange(res, {
    token: point.token,
    action: "dns",
    detail: { alias, from: current.servers, to: res.data?.after },
  });
}

/**
 * Undo the DNS row. The inverse has to come from the record, not from a default: handing
 * the adapter back to DHCP is right only when the servers it had before were DHCP's. A
 * static configuration is written back exactly, or nudging a resolver would silently
 * discard a Pi-hole or a split-DNS setup that was there first.
 */
export async function resetDns(alias) {
  const rec = readBackups().dns[alias];
  const recorded = (rec?.servers || []).filter((s) => typeof s === "string" && s.trim());
  // The record's source decides. dnsSourceOf keeps the old `dhcp` field's meaning and refuses
  // to translate a record that names neither, which the branch below reports.
  const dnsSource = dnsSourceOf(rec);
  if (dnsSource === "unknown") {
    // 1.0.0 and 1.0.1 wrote the server list alone. Handing that to DHCP can throw a hand-set
    // resolver list away; writing it back as static can pin a router list that has since
    // changed. Neither is chosen for the user, and the record is left where it is.
    return {
      ok: false,
      error: `The restore point for "${alias}" does not say whether its DNS servers (${recorded.join(", ") || "none recorded"}) were set by hand or supplied by the router, so undo will not guess. Nothing was changed and the record is kept. Set the DNS servers you want in Settings \u2192 Network & internet \u2192 Wi-Fi or Ethernet \u2192 DNS server assignment, then apply the change again.`,
    };
  }
  const staticBefore = dnsSource === "static" && recorded.length > 0;
  const script = staticBefore
    ? `
$alias = '${sq(alias)}'
$servers = @(${recorded.map((s) => `'${sq(s)}'`).join(", ")})
Set-DnsClientServerAddress -InterfaceAlias $alias -ServerAddresses $servers -ErrorAction Stop
Clear-DnsClientCache
$after = @((Get-DnsClientServerAddress -InterfaceAlias $alias -AddressFamily IPv4).ServerAddresses)
if ((($servers | ForEach-Object { [string]$_ } | Sort-Object) -join ',') -ne (($after | ForEach-Object { [string]$_ } | Sort-Object) -join ',')) {
  throw "DNS was not restored (the adapter reads $($after -join ', '))"
}
$result = [ordered]@{ ok = $true; message = 'DNS restored to the servers recorded before the change'; after = @($after) }
`
    : `
$alias = '${sq(alias)}'
Set-DnsClientServerAddress -InterfaceAlias $alias -ResetServerAddresses -ErrorAction Stop
Clear-DnsClientCache
$after = @((Get-DnsClientServerAddress -InterfaceAlias $alias -AddressFamily IPv4).ServerAddresses)
$result = [ordered]@{ ok = $true; message = 'DNS reset to automatic'; after = @($after) }
`;
  const res = await runElevated(script);
  return finishChange(res, {
    after: (b) => {
      delete b.dns[alias];
    },
    action: "dns-reset",
    detail: { alias },
  });
}

/**
 * Switch 1 of 2: power plan "Wireless Adapter Settings -> Power Saving Mode".
 *   off -> maximum performance on AC and battery (index 0/0)
 *   on  -> the values that were in effect before PingLab changed them
 * Touches only the power scheme; the NIC device setting is handled by setNicPowerSave.
 */
export async function setPlanPowerSave(alias, enabled) {
  const raw = await readPowerState(alias);
  const activeScheme = raw?.scheme ? String(raw.scheme) : null;
  const activeKey = schemeKey(activeScheme);
  // The restore point belongs to the plan, not the adapter: the same scheme can be tuned
  // from any Wi-Fi adapter, and a second adapter must not create a second record.
  const points = readBackups().planPower;
  let saved = activeKey ? points[activeKey] : null;
  // The plan may have been switched after PingLab tuned it. With exactly one recorded scheme
  // there is no ambiguity about which plan the request means; with several, choosing one for
  // the user would restore the wrong plan, so the request is refused and the records stay.
  if (enabled && !saved) {
    const recorded = Object.entries(points);
    if (recorded.length === 1) saved = recorded[0][1];
    else if (recorded.length > 1) {
      return {
        ok: false,
        error: `PingLab has restore points for ${recorded.length} power plans (${recorded.map(([, r]) => r.scheme || "unknown scheme").join(", ")}) and none is the plan in use now. Nothing was changed, because restoring the wrong plan would leave the one you meant modified.`,
      };
    }
  }

  // Already there and already recorded: pressing the button again must not ask for
  // elevation, and must not overwrite the recorded original with the tuned value - that
  // would leave a restore point that restores nothing.
  if (!enabled && saved && raw && raw.planAc === 0 && raw.planDc === 0) {
    return { ok: true, data: { ok: true, message: "Wireless power saving is already at maximum performance - nothing to change." } };
  }
  if (enabled && !saved) {
    return { ok: false, error: "Nothing recorded to restore for wireless power saving." };
  }

  // Restore against the plan that was recorded. The active scheme at this moment may be a
  // different one; writing the recorded values there would tune the wrong plan and leave the
  // original modified.
  const targetScheme = enabled ? String(saved?.scheme || "") : activeScheme;
  const targetKey = schemeKey(targetScheme);
  if (!targetKey) {
    return {
      ok: false,
      error: enabled
        ? "The restore point does not name the power scheme it was recorded from, so PingLab will not guess which plan to write. Nothing was changed and the record is kept."
        : "The active power scheme could not be read, so there is no scheme to record or change. Nothing was changed.",
    };
  }

  // Record what the plan reads right now, before the elevated write, so a crash between
  // the two leaves a restore point instead of a changed machine with none.
  let point = { ok: true, token: null };
  if (!enabled) {
    if (!raw || raw.planAc === null || raw.planDc === null) {
      return {
        ok: false,
        error: "The current power-plan values could not be read, so there is no original value to record. Nothing was changed.",
      };
    }
    point = recordRestorePoint("planPower", targetKey, {
      ac: raw.planAc,
      dc: raw.planDc,
      acSource: raw.acSource,
      dcSource: raw.dcSource,
      scheme: targetScheme,
      alias,
    });
    if (!point.ok) return point;
  }

  const targetAc = enabled ? (saved?.ac ?? raw?.planAc ?? 1) : 0;
  const targetDc = enabled ? (saved?.dc ?? raw?.planDc ?? 2) : 0;

  const script = `
$alias = '${sq(alias)}'
$sub = '${WIRELESS_SUBGROUP}'
$setting = '${WIRELESS_SETTING}'
$root = 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power\\User\\PowerSchemes'
$scheme = '${sq(targetScheme)}'
if (-not (Test-Path (Join-Path $root $scheme))) { throw "Power scheme $scheme no longer exists on this machine, so its recorded values cannot be restored." }
$active = (Get-ItemProperty -Path $root -Name 'ActivePowerScheme' -ErrorAction Stop).ActivePowerScheme
powercfg /setacvalueindex $scheme $sub $setting ${targetAc}
powercfg /setdcvalueindex $scheme $sub $setting ${targetDc}
# Only apply the plan if it is the one in use. Switching the user back to a plan they left
# would be a second, silent change; a non-active plan keeps its values for when it is used.
if ($active -eq $scheme) { powercfg /setactive $scheme }
$uk = Join-Path $root "$scheme\\$sub\\$setting"
$dk = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Power\\PowerSettings\\$sub\\$setting\\DefaultPowerSchemeValues\\$scheme"
$nowAc = (Get-ItemProperty -Path $uk -Name 'ACSettingIndex' -ErrorAction SilentlyContinue).ACSettingIndex
if ($null -eq $nowAc) { $nowAc = (Get-ItemProperty -Path $dk -Name 'ACSettingIndex' -ErrorAction SilentlyContinue).ACSettingIndex }
$nowDc = (Get-ItemProperty -Path $uk -Name 'DCSettingIndex' -ErrorAction SilentlyContinue).DCSettingIndex
if ($null -eq $nowDc) { $nowDc = (Get-ItemProperty -Path $dk -Name 'DCSettingIndex' -ErrorAction SilentlyContinue).DCSettingIndex }
if ($nowAc -ne ${targetAc} -or $nowDc -ne ${targetDc}) { throw "Power plan did not take the new value (AC=$nowAc DC=$nowDc)" }
$result = [ordered]@{
  ok = $true
  message = '${enabled ? "Wireless power saving restored in the power plan" : "Wireless power saving set to maximum performance in the power plan"}'
  scheme = $scheme; targetAc = ${targetAc}; targetDc = ${targetDc}; nowAc = $nowAc; nowDc = $nowDc
}
`;
  const res = await runElevated(script);
  return finishChange(res, {
    token: point.token,
    after: enabled
      ? (b) => {
          delete b.planPower[targetKey];
        }
      : null,
    action: enabled ? "plan-power-on" : "plan-power-off",
    detail: { alias, scheme: targetScheme, ac: targetAc, dc: targetDc },
  });
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
  // Saved before the elevated write, so a crash cannot leave the NIC disabled with no
  // record of what it was.
  let point = { ok: true, token: null };
  if (!enabled) {
    point = recordRestorePoint("nicPower", alias, { before });
    if (!point.ok) return point;
  }
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
  return finishChange(res, {
    token: point.token,
    after: enabled
      ? (b) => {
          delete b.nicPower[alias];
        }
      : null,
    action: enabled ? "nic-power-on" : "nic-power-off",
    detail: { alias, before },
  });
}

/** The two registry values this row writes, read without elevation. */
export async function readNagleValues(alias) {
  try {
    const { data } = await runPsJson(
      `$alias = '${sq(alias)}'
$guid = (Get-NetAdapter -Name $alias -ErrorAction Stop).InterfaceGuid
$key = "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\$guid"
$ack = $null; $nd = $null
try { $ack = (Get-ItemProperty -Path $key -Name TcpAckFrequency -ErrorAction Stop).TcpAckFrequency } catch {}
try { $nd = (Get-ItemProperty -Path $key -Name TCPNoDelay -ErrorAction Stop).TCPNoDelay } catch {}
[pscustomobject]@{ guid = $guid; key = $key; tcpAckFrequency = $ack; tcpNoDelay = $nd } | ConvertTo-Json -Compress`,
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
  const current = enabled ? await readNagleValues(alias) : null;
  // Already disabled: no elevation, and above all no new restore point that would record
  // the tuned values as the original.
  if (enabled) {
    if (!current) {
      return {
        ok: false,
        error: "The adapter's current TCP registry values could not be read, so there is no original value to record. Nothing was changed.",
      };
    }
    // Both values make up the state. Treating either one as done used to skip the write that
    // was still missing, so a half-applied adapter stayed half-applied behind a success message.
    if (Number(current.tcpAckFrequency) === 1 && Number(current.tcpNoDelay) === 1) {
      return { ok: true, data: { ok: true, message: "Nagle's algorithm is already disabled on this adapter - nothing to change." } };
    }
  }
  // The values read a moment ago are the restore point, written before the elevated write.
  let point = { ok: true, token: null };
  if (enabled) {
    point = recordRestorePoint("nagle", alias, {
      guid: current.guid,
      key: current.key,
      before: { TcpAckFrequency: current.tcpAckFrequency ?? null, TCPNoDelay: current.tcpNoDelay ?? null },
    });
    if (!point.ok) return point;
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
  return finishChange(res, {
    token: point.token,
    after: enabled
      ? null
      : (b) => {
          delete b.nagle[alias];
        },
    action: enabled ? "nagle-off" : "nagle-on",
    detail: { alias },
  });
}

