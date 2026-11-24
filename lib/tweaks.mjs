import {
  readFileSync,
  mkdirSync,
  statSync,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { runElevated, runPsJson, runPs, isElevated } from "./ps.mjs";
import { dnsServers } from "./net.mjs";
import { TWEAKS, PRESETS, presetById, presetTweaks, tweakById } from "./catalog.mjs";
import { DATA_DIR, dataPath } from "./paths.mjs";
import { keepUnreadableAside } from "./keep-unreadable.mjs";
import { acquireLock } from "./backup-lock.mjs";

/** The catalog owns every label; nothing below repeats one. */
const tweakLabel = (id) => tweakById(id)?.label || id;

const BACKUP_FILE = dataPath("backups.json");
/** How the file is named in messages: the folder the app runs from, not an absolute path. */
/** Named in messages by its real path: a user told to repair it has to be able to find it. */
const BACKUP_NAME = BACKUP_FILE;
const sq = (s) => String(s).replace(/'/g, "''");

/**
 * Where a recorded DNS list came from: "static" (set by hand), "automatic" (supplied by the
 * router) or "unknown". `staticDns` answers it directly. Builds before it recorded `dhcp` -
 * the address's source, used as their stand-in for the same question - so that keeps exactly
 * the meaning it had when it was written. A record with neither field (the first builds wrote
 * only the server list) is unknown, and the callers refuse to guess: "automatic" would hand
 * a hand-set list to DHCP, "static" would pin a router list that may have changed since.
 */
export function dnsSourceOf(rec) {
  if (!rec || typeof rec !== "object") return "unknown";
  if (typeof rec.staticDns === "boolean") return rec.staticDns ? "static" : "automatic";
  if (typeof rec.dhcp === "boolean") return rec.dhcp ? "automatic" : "static";
  return "unknown";
}

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

const isPlainObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** Sections a build may carry; each has to be a plain object when it is there at all. */
const BACKUP_SECTIONS = ["dns", "planPower", "nicPower", "nagle", "adapterTuning", "wifiOrder", "powerSave"];

function normalizeBackups(raw) {
  const merged = { ...structuredClone(EMPTY), ...raw };
  // Earlier builds kept the power-plan values under "powerSave". Fold them into
  // "planPower" so a revert written by an older build still works.
  merged.planPower = { ...(raw.powerSave || {}), ...(raw.planPower || {}) };
  merged.nicPower = merged.nicPower || {};
  merged.adapterTuning = merged.adapterTuning || {};
  merged.wifiOrder = merged.wifiOrder || {};
  merged.history = Array.isArray(merged.history) ? merged.history : [];
  delete merged.powerSave;
  return merged;
}

/** Size and mtime, so a repaired file is read again without restarting the app. */
function stampOfBackupFile() {
  try {
    const s = statSync(BACKUP_FILE);
    return `${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  } catch {
    return "missing";
  }
}

let backupCache = null;

/**
 * Read and validate backups.json. A missing file is a first run and is empty. A file that
 * exists but cannot be read, parsed or has the wrong shape is a different thing: it may be
 * the only record of what this machine looked like before PingLab changed it, so it is
 * reported as unreadable (never as empty), a copy of it is kept beside it, and every write
 * refuses to touch it.
 */
function inspectBackups({ fresh = false } = {}) {
  const stamp = stampOfBackupFile();
  if (!fresh && backupCache && backupCache.stamp === stamp) return backupCache.result;

  let result;
  if (stamp === "missing") {
    result = { data: structuredClone(EMPTY), problem: null };
  } else {
    let text;
    let flaw = null;
    try {
      text = readFileSync(BACKUP_FILE, "utf8");
    } catch (err) {
      flaw = `could not be read (${err?.code || err?.message || err})`;
    }
    let raw = null;
    if (!flaw) {
      try {
        raw = JSON.parse(text);
      } catch (err) {
        flaw = `is not valid JSON (${err.message})`;
      }
    }
    if (!flaw && !isPlainObject(raw)) {
      flaw = `does not hold a JSON object (it holds ${Array.isArray(raw) ? "a list" : raw === null ? "null" : typeof raw})`;
    }
    if (!flaw) {
      const broken = BACKUP_SECTIONS.find((k) => k in raw && !isPlainObject(raw[k]));
      if (broken) flaw = `has an unexpected value for "${broken}"`;
      else if ("history" in raw && !Array.isArray(raw.history)) flaw = `has an unexpected value for "history"`;
    }

    if (!flaw) {
      result = { data: normalizeBackups(raw), problem: null };
    } else {
      const kept = keepUnreadableAside(BACKUP_FILE, { suffix: ".json" });
      const where = kept.ok
        ? `A copy was kept as ${kept.path}, so its restore points are not lost.`
        : `A copy could not be made either (${kept.error}), so this file is the only copy - do not delete it.`;
      result = {
        data: structuredClone(EMPTY),
        problem: {
          file: BACKUP_NAME,
          detail: flaw,
          copy: kept.path,
          message: `${BACKUP_NAME} ${flaw}, so its restore points are unknown, not empty. ${where}`,
          refusal: `Refusing to change anything: ${BACKUP_NAME} ${flaw}, and overwriting it would destroy the only record of what this machine looked like before PingLab changed it. ${where} Repair the file, or move the copy back over ${BACKUP_NAME}, then try again.`,
        },
      };
    }
  }
  backupCache = { stamp, result };
  return result;
}

/** Restore points. Always a fresh copy, so a caller may edit what it gets back. */
export function readBackups() {
  return structuredClone(inspectBackups().data);
}

/**
 * The same read, never from the cache. Every write path uses it: a cached copy taken before
 * another process wrote would be written back over that process's change.
 */
function readBackupsFresh() {
  return structuredClone(inspectBackups({ fresh: true }).data);
}

/** Whether the restore points can be trusted, for every surface that reports a count. */
export function backupStatus() {
  const { problem } = inspectBackups();
  return problem ? { ok: false, problem } : { ok: true, problem: null };
}

/**
 * Windows refuses to replace a file another process has open, even briefly for a read: the
 * rename then fails with EPERM/EBUSY/EACCES. Readers here are short-lived - the GUI polling
 * state, the page refreshing, another PingLab instance reading its restore points - so retry
 * the rename for about a second instead of dropping the write. If the file stays locked the
 * error still surfaces, and the previous file is untouched.
 */
function replaceFile(from, to) {
  const transient = new Set(["EPERM", "EBUSY", "EACCES"]);
  const sleepCell = new Int32Array(new SharedArrayBuffer(4));
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if (!transient.has(err?.code) || attempt >= 40) throw err;
      Atomics.wait(sleepCell, 0, 0, 25);
    }
  }
}

/**
 * Replace backups.json atomically: the new content is written and flushed to a temporary
 * file in the same folder, then renamed over the original. A crash, a full disk or a locked
 * file therefore leaves the previous restore points intact instead of a truncated file.
 *
 * It refuses to write at all when the existing file cannot be read, because overwriting it
 * would destroy the only record of the machine's original values. That refusal is why each
 * action records its restore point before Windows is touched: if the record cannot be
 * written, the setting is left alone too.
 */
function writeBackupsUnlocked(b) {
  const { problem } = inspectBackups({ fresh: true });
  if (problem) throw new Error(problem.refusal);
  mkdirSync(DATA_DIR, { recursive: true });
  const tmp = join(DATA_DIR, `.backups-${process.pid}-${Math.random().toString(36).slice(2, 10)}.tmp`);
  let fd;
  try {
    fd = openSync(tmp, "w");
    writeSync(fd, `${JSON.stringify(b, null, 2)}\n`, null, "utf8");
    fsyncSync(fd); // the bytes are on disk before the name points at them
    closeSync(fd);
    fd = undefined;
    replaceFile(tmp, BACKUP_FILE); // atomic replace, retried through a transient reader
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already closed */
      }
    }
    try {
      unlinkSync(tmp);
    } catch {
      /* nothing to clean up */
    }
    throw new Error(`Could not save the restore points to ${BACKUP_NAME} (${err?.code || err?.message || err}).`);
  }
  // What is on disk just changed, so the next read must not come from the cached copy.
  backupCache = null;
  // The rename is atomic; flushing the folder entry makes it survive a power cut where the
  // platform allows it. Windows has no folder handle to flush, and NTFS has already
  // committed the rename by the time it returns.
  if (process.platform !== "win32") {
    try {
      const dir = openSync(DATA_DIR, "r");
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } catch {
      /* the file itself is durable already */
    }
  }
}

const BACKUP_LOCK = dataPath(".backups.lock");
/** What a second instance is told instead of silently overwriting the first one's record. */
export const BACKUP_BUSY = "Another PingLab action is writing restore points. Try again in a moment.";

/** How long to wait for another instance's write. A write takes milliseconds. */
const lockWaitMs = () => Number(process.env.PINGLAB_BACKUP_LOCK_WAIT_MS) || 5000;

/** Take the restore-point lock, or throw the sentence the user can act on. */
function lockBackups() {
  const release = acquireLock(BACKUP_LOCK, { waitMs: lockWaitMs() });
  if (!release) throw new Error(BACKUP_BUSY);
  return release;
}

/**
 * Read the file, let `mutate` change it, write it back - all under one exclusive lock, so a
 * second process cannot read the same version and have its write undo the first one's change.
 * The read is fresh, never cached: that is what stops a stale copy from resurrecting a
 * restore point another instance has already cleared. `mutate` returning false leaves the
 * file untouched, for the cases where there is nothing to write.
 */
function updateBackups(mutate) {
  const release = lockBackups();
  try {
    const b = readBackupsFresh();
    const outcome = mutate(b);
    if (outcome !== false) writeBackupsUnlocked(b);
    return outcome;
  } finally {
    release();
  }
}

/** Seed or replace the whole file from outside this module (tests, repair tools). */
export function writeBackups(b) {
  const release = lockBackups();
  try {
    writeBackupsUnlocked(structuredClone(b));
  } finally {
    release();
  }
}

/**
 * History is bookkeeping, so failing to record it never turns a real change into a reported
 * failure: the caller appends the returned sentence to the result instead.
 */
function logChange(action, detail) {
  try {
    updateBackups((b) => {
      b.history.unshift({ action, detail, at: new Date().toISOString() });
      b.history = b.history.slice(0, 50);
    });
    return null;
  } catch (err) {
    return `The setting changed, but the history entry could not be saved (${err?.message || err}).`;
  }
}

/**
 * Record the values in effect right now, before Windows is asked to change anything. The
 * first record wins: a second apply must not replace the original with the tuned value.
 * A record that cannot be written stops the action with the setting untouched.
 */
function recordRestorePoint(area, alias, value) {
  try {
    const out = updateBackups((b) => {
      // The read above happened under the lock, so "already recorded" is the file's answer,
      // not a cached one: a point another process wrote meanwhile is respected.
      if (b[area]?.[alias]) return { fresh: false, token: null };
      b[area] = { ...(b[area] || {}), [alias]: { ...value, at: new Date().toISOString() } };
      pauseForRaceTest();
      return { fresh: true, token: { area, alias } };
    });
    return { ok: true, fresh: out.fresh, token: out.token };
  } catch (err) {
    return { ok: false, error: `${err?.message || err} Nothing was changed, because the restore point could not be recorded.` };
  }
}

/**
 * Test hook: widens the critical section so two processes can be made to collide on purpose
 * (lib/concurrency.test.mjs). It only waits - there is no retry - so what makes the two writes
 * serialise has to be the lock, not luck.
 */
function pauseForRaceTest() {
  const ms = Number(process.env.PINGLAB_BACKUP_DELAY_MS) || 0;
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Drop a restore point written for an attempt Windows never carried out. */
function discardRestorePoint(token) {
  if (!token) return;
  try {
    updateBackups((b) => {
      if (!b[token.area]?.[token.alias]) return false;
      delete b[token.area][token.alias];
      return true;
    });
  } catch {
    // Keeping a point for a change that did not happen is the safe failure: it holds the
    // values that are still live, so restoring it writes them back and changes nothing.
  }
}

/**
 * Close out one action. Its restore point was written before elevation, so an attempt that
 * provably never ran (a closed prompt, a policy refusal) has to remove it again; anything
 * else, including a script that failed halfway, keeps it - a partial change still needs the
 * values it recorded. A bookkeeping problem is appended to the result rather than turning a
 * real change into a reported failure.
 */
function finishChange(res, { token, after, action, detail }) {
  if (!res?.ok) {
    if (res?.cancelled || looksDenied(res?.error || res?.data?.message)) discardRestorePoint(token);
    return res;
  }
  const notes = [];
  if (after) {
    try {
      updateBackups(after);
    } catch (err) {
      notes.push(`The setting changed, but ${BACKUP_NAME} could not be updated (${err?.message || err}).`);
    }
  }
  const warning = logChange(action, detail);
  if (warning) notes.push(warning);
  if (notes.length) {
    res.data = { ...(res.data || {}), message: `${res.data?.message ? `${res.data.message} ` : ""}${notes.join(" ")}` };
  }
  return res;
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
async function readPowerState(alias) {
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
    nagleDisabled: Number(row.tcpAckFrequency) === 1 || Number(row.tcpNoDelay) === 1,
    nagleValues: {
      tcpAckFrequency: row.tcpAckFrequency === null || row.tcpAckFrequency === undefined ? null : Number(row.tcpAckFrequency),
      tcpNoDelay: row.tcpNoDelay === null || row.tcpNoDelay === undefined ? null : Number(row.tcpNoDelay),
    },
    currentDns: dnsList.find((d) => d.alias === row.alias)?.servers ?? [],
  };
}

/** Point an adapter at fixed DNS servers, remembering what was there before. */
async function applyDns(alias, servers) {
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
async function resetDns(alias) {
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
async function setPlanPowerSave(alias, enabled) {
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
    point = recordRestorePoint("planPower", alias, {
      ac: raw.planAc,
      dc: raw.planDc,
      acSource: raw.acSource,
      dcSource: raw.dcSource,
      scheme: raw.scheme,
    });
    if (!point.ok) return point;
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
  return finishChange(res, {
    token: point.token,
    after: enabled
      ? (b) => {
          delete b.planPower[alias];
        }
      : null,
    action: enabled ? "plan-power-on" : "plan-power-off",
    detail: { alias, ac: targetAc, dc: targetDc },
  });
}

/**
 * Switch 2 of 2: the NIC's device power management ("allow the computer to turn off this
 * device"). Refused with a clear reason when the driver does not expose it, rather than
 * calling the cmdlet and reporting success for a change that could not happen.
 */
async function setNicPowerSave(alias, enabled) {
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
async function readNagleValues(alias) {
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
async function setNagle(alias, enabled) {
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
    if (Number(current.tcpAckFrequency) === 1 || Number(current.tcpNoDelay) === 1) {
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

/** True when a failure is Windows refusing elevation rather than the setting refusing the value. */
function looksDenied(text) {
  return /denied|zugriff|verweigert|privilege|administr|elevat|did not grant|0x80070005|0x800704c7|requires elevation/i.test(
    String(text || ""),
  );
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
async function setAdapterTuning(alias, restore = false) {
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

/**
 * The profile precedence list from `netsh wlan show profiles`. Windows prints one block
 * per profile class, each title underlined with dashes; the user profiles are the last
 * block, so read-only group-policy entries above it can never leak in. Null means "no
 * such block", and the caller refuses to guess rather than writing a wrong order.
 */
function parseWlanProfiles(text) {
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
async function setWlanOrderFirst(alias) {
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

  // The order read above is the restore point: it is saved before Windows is asked to move
  // anything, so a failed or timed-out netsh call cannot leave a changed order without it.
  const point = recordRestorePoint("wifiOrder", alias, { profiles: read.profiles, joined: read.joined });
  if (!point.ok) return point;

  const script = `
$alias = '${sq(alias)}'
$n = '${sq(target)}'
netsh wlan set profileorder name="$n" interface="$alias" priority=1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "netsh refused to move '$n' to the top (exit $LASTEXITCODE)" }
$result = [ordered]@{ ok = $true; message = 'auto-connect order updated' }
`;
  const detail = { alias, order: read.profiles, target };
  const res = await runElevated(script);
  if (!res.ok) return finishChange(res, { token: point.token, action: "wifi-order-first", detail });

  const after = await readWlanOrder(alias);
  if (!after.profiles || after.profiles[0] !== target) {
    // netsh ran, so the order may have moved even though the read-back does not show the
    // result asked for: the restore point stays, because it is what puts the order back.
    return {
      ok: false,
      error: `Windows accepted the command but the order still reads ${(after.profiles || []).join(" > ") || "unreadable"}.`,
    };
  }

  return finishChange(
    {
      ok: true,
      data: {
        ok: true,
        message: `"${target}" is now first in the Wi-Fi auto-connect order; an adapter reset rejoins it instead of another saved network.`,
        order: after.profiles,
      },
    },
    { token: point.token, action: "wifi-order-first", detail },
  );
}

/**
 * Put the recorded precedence back and drop the restore point. Profiles deleted since the
 * backup are left out rather than recreated, and the result is verified by reading the
 * order again instead of trusting netsh's exit code.
 */
async function restoreWlanOrder(alias) {
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
    updateBackups((b) => {
      delete b.wifiOrder[alias];
    });
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

  return finishChange(
    { ok: true, data: { ok: true, message: `Auto-connect order restored: ${(after.profiles || []).join(" > ")}.` } },
    {
      after: (b) => {
        delete b.wifiOrder[alias];
      },
      action: "wifi-order-restore",
      detail: { alias, order: rec.profiles },
    },
  );
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
