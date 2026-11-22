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
 *     "dnsStatic": { "WLAN": true }          // typed in by hand, or handed out by DHCP
 *   }
 *
 * Every call is appended to PINGLAB_PS_LOG as one JSON line, so a test can prove that an
 * already-in-place action asked for no elevation at all, and can read the exact script an
 * elevated call would have run.
 */
import { appendFileSync } from "node:fs";

const DEFAULTS = {
  ack: null,
  nodelay: null,
  power: { planAc: 1, planDc: 2, ndis: "enabled", wmiEnable: true, scheme: "SCHEME-1" },
  tuning: { MIMOPowerSaveMode: 0, RoamAggressiveness: 2 },
  profile: "HomeNet",
  elevated: { mode: "ok" },
};

const calls = new Map(); // alias -> { elevated: n }

function scenario() {
  try {
    return JSON.parse(process.env.PINGLAB_PS_SCENARIO || "{}");
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
  if (/Get-NetAdapterPowerManagement/.test(text) && /planAc/.test(text)) return "power";
  if (/@\{n='servers'/.test(text)) return "dns-list";
  if (/Get-NetConnectionProfile/.test(text)) return "profile-name";
  if (/netsh wlan show interfaces/.test(text)) return "wlan-interfaces";
  if (/netsh wlan show profiles/.test(text)) return "wlan-profiles";
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
  log({ kind, alias, timeout: timeout ?? null, script: String(script) });
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
    case "wlan-interfaces":
      return { ok: true, stdout: wlanInterfacesText(wlan), stderr: "" };
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
  return { ok: true, data: { ok: true, message: "written by the fake" }, cancelled: false, reason: null };
}
