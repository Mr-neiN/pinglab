import { join } from "node:path";
import { runElevated, runPsJson } from "./ps.mjs";
import { sq } from "./tweak-shared.mjs";
import { readBackups, recordRestorePoint, finishChange } from "./backups.mjs";
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
export const ADAPTER_TUNING = [
  { keyword: "MIMOPowerSaveMode", want: 3, wantText: "No SMPS" },
  { keyword: "RoamAggressiveness", want: 0, wantText: "Lowest" },
];

/**
 * What the app is allowed to claim about these vendor defaults. Until a soak shows they
 * cost something, they are "not tuned for a fixed desktop", never "wrong".
 */
export const TUNING_REASON = "Vendor defaults assume battery life; no soak here has measured a cost.";

export const TUNING_KEYWORDS = ADAPTER_TUNING.map((t) => `'${t.keyword}'`).join(", ");

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
export const PS_TUNING = `
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
export function tuningState(rows) {
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
export async function readTuningValues(alias) {
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

  // Nothing to do, so do not ask for elevation and do not reset the adapter; otherwise the
  // values read here are the restore point, written before the elevated change.
  let point = { ok: true, token: null };
  if (!restore) {
    const cur = await readTuningValues(alias);
    if (!cur) {
      return {
        ok: false,
        error: "The adapter's current radio properties could not be read, so there is no original value to record. Nothing was changed.",
      };
    }
    if (ADAPTER_TUNING.every((t) => Number(cur[t.keyword]) === t.want)) {
      return { ok: true, data: { ok: true, message: "Already at the recommended values - nothing to change." } };
    }
    // A property the driver does not report cannot be put back later, and recording it as
    // 0 would restore a value the adapter never had.
    const missing = ADAPTER_TUNING.filter((t) => cur[t.keyword] === null || cur[t.keyword] === undefined);
    if (missing.length) {
      return {
        ok: false,
        error: `The driver did not report ${missing.map((t) => t.keyword).join(", ")}, so the original values could not be recorded. Nothing was changed.`,
      };
    }
    const before = Object.fromEntries(ADAPTER_TUNING.map((t) => [t.keyword, cur[t.keyword]]));
    point = recordRestorePoint("adapterTuning", alias, { values: before });
    if (!point.ok) return point;
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
  }
  return finishChange(res, {
    token: point.token,
    after: restore
      ? (b) => {
          delete b.adapterTuning[alias];
        }
      : null,
    action: restore ? "adapter-tuning-on" : "adapter-tuning-off",
    detail: { alias, values: res.data?.before || null },
  });
}

/* ------------------------------------------------- Wi-Fi auto-connect order */

