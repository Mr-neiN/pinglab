/**
 * A fake Windows, for lib/tweaks.test.mjs.
 *
 * lib/ps.mjs loads this module only when PINGLAB_PS_STUB points at it, and then sends every
 * PowerShell script here instead of spawning powershell.exe. It answers the real scripts from
 * lib/tweaks.mjs by matching what they ask for (a power-plan read, the TCP registry values,
 * the WLAN profile list, ...), so the apply/revert paths can be exercised on a described
 * machine instead of on this one.
 *
 * The machine comes from PINGLAB_PS_SCENARIO (JSON):
 *
 *   {
 *     "elevatedUser": false,                 // what isElevated() answers
 *     "machines": { "WLAN": {                // per adapter alias
 *        "ack": null, "nodelay": null,       // Nagle registry values
 *        "power": { planAc, planDc, ndis, wmiEnable, scheme },
 *        "tuning": { MIMOPowerSaveMode, RoamAggressiveness } | null,
 *        "profile": "HomeNet",
 *        "elevated": { "mode": "ok" | "cancel" | "fail", "error": "..." }
 *     } },
 *     "wlan": { "wifi": true, "joined": "HomeNet",
 *               "profiles": [...], "profilesAfter": [...] },
 *     "dns": { "WLAN": ["192.168.1.1"] },     // the servers in use
 *     "dnsStatic": { "WLAN": true },         // typed in by hand, or handed out by DHCP
 *     "scan": [ { "ssid": "Mine", "channel": 6, "signal": 80, "band": "2.4 GHz" } ],
 *     "scanAfter": [ ... ],                  // what a second read would return, if asked
 *     "wlanScan": { "mode": "complete" | "failed" | "timeout" | "denied" | "unavailable",
 *                   "elapsedMs": 320 }     // what the WlanScan shim answers
 *   }
 *
 * Every call is appended to PINGLAB_PS_LOG as one JSON line, so a test can prove that an
 * already-in-place action asked for no elevation at all, and can read the exact script an
 * elevated call would have run.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const DEFAULTS = {
  ack: null,
  nodelay: null,
  power: { planAc: 1, planDc: 2, ndis: "enabled", wmiEnable: true, scheme: "SCHEME-1" },
  tuning: { MIMOPowerSaveMode: 0, RoamAggressiveness: 2 },
  profile: "HomeNet",
  elevated: { mode: "ok" },
};

const calls = new Map(); // alias -> { elevated: n }

/**
 * The described machine. A file can stand in for the variable: a test that starts the real
 * server in another process can change the machine between reads (and the elevated handler
 * can write back to it), which is how "the next state read reflects the change" is proved.
 */
function scenario() {
  try {
    const file = process.env.PINGLAB_PS_SCENARIO_FILE;
    return JSON.parse(file ? readFileSync(file, "utf8") : process.env.PINGLAB_PS_SCENARIO || "{}");
  } catch {
    return {};
  }
}

function state(alias) {
  if (!calls.has(alias)) calls.set(alias, { elevated: 0 });
  return calls.get(alias);
}

function machine(alias) {
  const spec = scenario().machines?.[alias] || {};
  return {
    ...DEFAULTS,
    ...spec,
    power: { ...DEFAULTS.power, ...(spec.power || {}) },
    elevated: { ...DEFAULTS.elevated, ...(spec.elevated || {}) },
    guid: spec.guid || `GUID-${alias ?? "none"}`,
    key: spec.key || `HKLM\\...\\Interfaces\\GUID-${alias ?? "none"}`,
  };
}

function log(entry) {
  const path = process.env.PINGLAB_PS_LOG;
  if (!path) return;
  try {
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    /* the log is evidence, not a dependency */
  }
}

function aliasOf(script) {
  const text = String(script || "");
  // Only real adapter arguments: a bare `-Name 'ActivePowerScheme'` is a registry value,
  // not an adapter, and treating it as one would send the script to the wrong machine.
  return (
    /\$alias = '([^']+)'/.exec(text)?.[1] ||
    /-(?:Interface)?Alias ['"]([^'"]+)['"]/.exec(text)?.[1] ||
    /interface="([^"]+)"/.exec(text)?.[1] ||
    /(?:Get|Set|Enable|Disable)-NetAdapter(?:PowerManagement|AdvancedProperty)? -Name '([^']+)'/.exec(text)?.[1] ||
    null
  );
}

/** Which question a real script is asking. Matching on the script body keeps the fixture honest. */
function classify(script) {
  const text = String(script || "");
  if (/IsInRole\(/.test(text)) return "elevation-check";
  if (/\$out\[\$r\.keyword\]/.test(text)) return "tuning-values";
  if (/keyExists/.test(text)) return "tweak-state";
  if (/tcpAckFrequency/.test(text) && /\$nd = \$null/.test(text)) return "nagle-values";
  if (/planSchemeRead/.test(text)) return "plan-scheme";
  if (/Get-NetAdapterPowerManagement/.test(text) && /planAc/.test(text)) return "power";
  if (/@\{n='servers'/.test(text)) return "dns-list";
  if (/IPv4Connectivity/.test(text)) return "connection-profiles";
  if (/Get-NetAdapterStatistics/.test(text)) return "throughput";
  if (/Get-NetAdapter \| Select-Object Name,InterfaceDescription/.test(text)) return "adapters";
  if (/Get-NetRoute/.test(text)) return "routes";
  if (/Get-NetConnectionProfile/.test(text)) return "profile-name";
  if (/PingLabWlanScan/.test(text)) return "wlan-shim";
  if (/netsh wlan show interfaces/.test(text)) return "wlan-interfaces";
  if (/netsh wlan show profiles/.test(text)) return "wlan-profiles";
  if (/netsh wlan show networks/.test(text)) return "wlan-scan";
  return "unknown";
}

const json = (value) => ({ ok: true, stdout: JSON.stringify(value), stderr: "" });

function wlanInterfacesText(wlan) {
  if (wlan.wifi === false) {
    return "Es ist kein Drahtlosadapter auf diesem System vorhanden.\r\n";
  }
  return [
    "Es ist 1 Schnittstelle auf dem System vorhanden:",
    "",
    "    Name                   : WLAN",
    `    SSID                   : ${wlan.joined ?? "HomeNet"}`,
    "    BSSID                  : e4:8f:34:dd:1f:85",
    "    Status                 : Verbunden",
    "",
  ].join("\r\n");
}

let scanCount = { key: null, calls: 0 };

/** One BSSID block per network, in the German spelling Windows 11 prints on this machine. */
function wlanScanText(list) {
  const lines = ["Schnittstellenname : WLAN", "", `Momentan sind ${list.length} Netzwerke sichtbar.`, ""];
  list.forEach((n, i) => {
    lines.push(`SSID ${i + 1} : ${n.ssid ?? "HomeNet"}`);
    lines.push("    Netzwerktyp             : Infrastruktur");
    lines.push(`    BSSID ${i + 1}               : aa:bb:cc:dd:ee:${String(16 + i).padStart(2, "0")}`);
    lines.push(`         Signal             : ${n.signal ?? 70}%  `);
    if (n.band) lines.push(`         Band               : ${String(n.band).replace("2.4", "2,4")}`);
    if (typeof n.channel === "number") lines.push(`         Kanal              : ${n.channel} `);
    lines.push("");
  });
  return lines.join("\r\n");
}

function wlanProfilesText(names) {
  return [
    "Profile auf Schnittstelle WLAN:",
    "",
    "-----------------------------",
    "Benutzerprofile",
    "-----------------------------",
    ...names.map((n) => `    Alle Benutzerprofile      : ${n}`),
    "",
  ].join("\r\n");
}

export async function ps(script, { timeout } = {}) {
  const alias = aliasOf(script);
  const kind = classify(script);
  // The shim script names the adapter it scans; recording it lets a test prove the GUID came
  // from the adapter Windows reported rather than from nowhere.
  const guid = /\[PingLabWlanScan\]::Run\('([^']*)'/.exec(String(script))?.[1] ?? null;
  log({ kind, alias, guid, timeout: timeout ?? null, script: String(script) });
  const m = machine(alias);
  const wlan = scenario().wlan || {};

  switch (kind) {
    case "elevation-check":
      return { ok: true, stdout: String(scenario().elevatedUser ?? false), stderr: "" };
    case "power":
      return json({
        scheme: m.power.scheme,
        planAc: m.power.planAc,
        planDc: m.power.planDc,
        acSource: "user",
        dcSource: "user",
        ndis: m.power.ndis,
        wmiEnable: m.power.wmiEnable,
      });
    case "plan-scheme": {
      // A named scheme, active or not. Tests that switch plans between apply and restore seed
      // `schemes` with the values each plan should read back.
      const scheme = /\$scheme = '([^']+)'/.exec(String(script))?.[1] || null;
      const schemes = scenario().schemes || {};
      const named = scheme ? schemes[scheme] ?? schemes[String(scheme).toLowerCase()] : null;
      if (named && named.exists === false) {
        return json({ scheme, exists: false, ac: null, dc: null, acSource: "none", dcSource: "none" });
      }
      const active = scheme && m.power.scheme && String(scheme).toLowerCase() === String(m.power.scheme).toLowerCase();
      const values = named || (active ? { ac: m.power.planAc, dc: m.power.planDc } : { ac: 1, dc: 2 });
      return json({
        scheme,
        exists: true,
        ac: typeof values.ac === "number" ? values.ac : null,
        dc: typeof values.dc === "number" ? values.dc : null,
        acSource: "user",
        dcSource: "user",
      });
    }
    case "tweak-state":
      return json({
        alias,
        guid: m.guid,
        tcpAckFrequency: m.ack,
        tcpNoDelay: m.nodelay,
        key: m.key,
        keyExists: true,
        tuning: m.tuning
          ? Object.entries(m.tuning).map(([keyword, value]) => ({ keyword, value, display: `${keyword}=${value}` }))
          : [],
      });
    case "nagle-values":
      return json({ guid: m.guid, key: m.key, tcpAckFrequency: m.ack, tcpNoDelay: m.nodelay });
    case "tuning-values":
      return json(m.tuning || {});
    case "dns-list": {
      const dns = scenario().dns || {};
      const staticDns = scenario().dnsStatic || {};
      return json(
        Object.entries(dns).map(([iface, servers]) => ({
          InterfaceAlias: iface,
          servers: servers.join(","),
          // Default: the router handed them out, like this machine. A test that needs a
          // hand-set list sets dnsStatic: { iface: true }; that is independent of whether
          // the address itself is DHCP, which says nothing about the DNS configuration.
          staticDns: typeof staticDns[iface] === "boolean" ? staticDns[iface] : false,
        })),
      );
    }
    case "profile-name":
      return json(m.profile);
    case "adapters":
      return json(
        scenario().adapters || [
          {
            Name: alias || "WLAN",
            InterfaceDescription: "Intel Wi-Fi 6 AX201",
            Status: "Up",
            LinkSpeed: "1 Gbps",
            MacAddress: "AA-BB-CC-DD-EE-FF",
            ifIndex: 1,
            InterfaceGuid: m.guid,
            DriverVersion: "1.0.0.0",
          },
        ],
      );
    case "routes":
      return json(scenario().routes || [{ InterfaceAlias: alias || "WLAN", NextHop: "192.168.1.1", RouteMetric: 25, ifIndex: 1 }]);
    case "connection-profiles":
      return json(
        scenario().profiles || [
          { Name: "HomeNet", InterfaceAlias: alias || "WLAN", IPv4Connectivity: "Internet", NetworkCategory: "Private" },
        ],
      );
    case "throughput": {
      const stats = scenario().stats || {};
      return json([{ ReceivedBytes: Number(stats.rx ?? 1000), SentBytes: Number(stats.tx ?? 1000) }]);
    }
    case "wlan-shim": {
      // What the real shim answers: a state, the time from request to completion notice and,
      // for a refused scan, the Windows error number. "unavailable" is the catch in the
      // PowerShell that a machine without an in-box C# compiler reaches.
      const spec = scenario().wlanScan || {};
      const mode = spec.mode || "complete";
      const elapsedMs = Number(spec.elapsedMs ?? 320);
      if (mode === "unavailable") return json({ state: "unavailable", elapsedMs: null, code: null });
      if (mode === "denied") return json({ state: "scan", elapsedMs: null, code: 5 });
      if (mode === "failed") return json({ state: "failed", elapsedMs, code: null });
      if (mode === "timeout") return json({ state: "timeout", elapsedMs, code: null });
      return json({ state: "complete", elapsedMs, code: null });
    }
    case "wlan-interfaces":
      return { ok: true, stdout: wlanInterfacesText(wlan), stderr: "" };
    case "wlan-scan": {
      // A second read answers with scanAfter when the scenario gives one: that is what the
      // old freshness guess re-read (and what its "refreshed" label came from).
      const sc = scenario();
      const key = JSON.stringify([sc.scan || null, sc.scanAfter || null]);
      if (scanCount.key !== key) scanCount = { key, calls: 0 };
      scanCount.calls += 1;
      const list = (scanCount.calls === 1 ? sc.scan : sc.scanAfter || sc.scan) || [];
      return { ok: true, stdout: wlanScanText(list), stderr: "" };
    }
    case "wlan-profiles": {
      // After an elevated write the fake lets the order change, so a read-back can be made
      // to agree (or, with profilesAfter left as the old list, to disagree).
      const changed = state(alias).elevated > 0;
      const names = changed ? wlan.profilesAfter || wlan.profiles || [] : wlan.profiles || [];
      return { ok: true, stdout: wlanProfilesText(names), stderr: "" };
    }
    default:
      return { ok: false, stdout: "", stderr: "ps-fake: no handler for this script" };
  }
}

export async function elevated(script, { timeout } = {}) {
  const alias = aliasOf(script);
  // restore-all sends one script with no adapter in it when only the power plan or the
  // drivers' own properties are being put back, so the prompt policy can also be global.
  const policy = alias
    ? machine(alias).elevated
    : { mode: scenario().elevatedMode || "ok", error: scenario().elevatedError || null };
  const mode = policy.mode;
  state(alias).elevated += 1;
  log({ kind: "elevated", alias, mode, timeout: timeout ?? null, script: String(script) });
  if (mode === "cancel") {
    return { ok: false, data: null, cancelled: true, reason: "cancelled", error: "the administrator prompt was closed" };
  }
  if (mode === "fail") {
    return { ok: false, data: null, cancelled: false, reason: "refused", error: policy.error || "Access is denied" };
  }
  // A file-backed machine records what a successful power-plan write would have done, so a
  // server reading it afterwards sees the change - and only then can a state-cache test tell
  // a fresh read from a cached one.
  const file = process.env.PINGLAB_PS_SCENARIO_FILE;
  if (file && alias && /powercfg \/setacvalueindex/.test(script)) {
    const ac = /powercfg \/setacvalueindex \$scheme \S+ \S+ (\d+)/.exec(script)?.[1];
    const dc = /powercfg \/setdcvalueindex \$scheme \S+ \S+ (\d+)/.exec(script)?.[1];
    if (ac !== undefined && dc !== undefined) {
      const data = scenario();
      const scheme = /\$scheme = '([^']+)'/.exec(script)?.[1];
      if (scheme) {
        data.schemes ||= {};
        data.schemes[scheme] = { ac: Number(ac), dc: Number(dc) };
      }
      data.machines ||= {};
      data.machines[alias] ||= {};
      data.machines[alias].power = {
        ...(data.machines[alias].power || {}),
        planAc: Number(ac),
        planDc: Number(dc),
      };
      try {
        writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
      } catch {
        /* the scenario is test furniture; a failed write surfaces as a stale reading */
      }
    }
  }
  return { ok: true, data: { ok: true, message: "written by the fake" }, cancelled: false, reason: null };
}
