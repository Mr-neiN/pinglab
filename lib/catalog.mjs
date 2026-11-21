/**
 * The tweak catalog: every setting a user can turn on or off, described once, here.
 *
 * The terminal app, the WinForms GUI and the web UI all render from this list instead of
 * each carrying their own copy of the names, so a setting can never be described one way
 * in one surface and another way somewhere else.
 *
 * Fields
 *   id        stable key, also used by presets
 *   rowKey    number shown in the terminal fixes view
 *   cli       the name `--apply <name>` / `--revert <name>` takes
 *   label     short name, one line
 *   what      plain language: what actually changes on the system
 *   tradeoff  what it costs - latency, throughput, battery or stability
 *   risk      "safe" | "moderate" | "experimental" (see RISK below)
 *   stock     what Windows does when you leave the setting alone
 *   undo      how the change is reversed
 *   actions   { apply, revert } names for runTweakAction
 *
 * Every entry is off by default: nothing here is applied at startup, and `default` is
 * checked by validateCatalog() so no future edit can quietly make one aggressive.
 */

export const RISK = {
  safe: {
    label: "safe",
    meaning: "Cannot strand the machine: the change is one Windows setting, it is read back, and the recorded value is restored by one press.",
  },
  moderate: {
    label: "moderate",
    meaning: "Reversible, but it changes behaviour beyond this app's own measurements: worth knowing what it trades before you apply it.",
  },
  experimental: {
    label: "experimental",
    meaning: "No measurement here has shown a gain, and it changes a hardware property. Never part of a preset; off unless you ask for it by name.",
  },
};

const OFF = { default: "off" };

export const TWEAKS = [
  {
    id: "plan-power",
    rowKey: "1",
    cli: "plan",
    label: "Wireless power saving (power plan)",
    what:
      "Sets Power Options → Wireless Adapter Settings → Power Saving Mode to maximum performance on both mains and battery, for the power plan that is active right now. This is the switch Windows uses to idle the Wi-Fi radio down.",
    tradeoff:
      "Battery: the radio stays at full power instead of stepping down, so a laptop loses some runtime. Latency: it stops the radio waking up mid-fight, which is what causes the occasional 10–50 ms spike and the odd packet drop.",
    risk: "safe",
    stock: "Windows power plan decides: usually medium power saving on battery, light saving on mains.",
    undo: "the AC and battery values recorded before the change are written back, so the same power plan value returns (restore-all additionally drops the per-scheme override when it matches the scheme default).",
    actions: { apply: "plan-power-off", revert: "plan-power-on" },
    ...OFF,
  },
  {
    id: "nic-power",
    rowKey: "2",
    cli: "nic",
    label: "NIC power management (device)",
    what:
      "Turns off “Allow the computer to turn off this device to save power” on the adapter itself (Device Manager → adapter → Power Management). Separate from the power-plan row above; both can matter, and most Wi-Fi drivers expose only one of them.",
    tradeoff:
      "Battery: Windows can no longer park the device while it looks idle. Stability: a card that sleeps can miss the first packets after waking, which reads as a stutter — this removes that. Nothing is gained on a driver that does not expose the setting, and the row then says so instead of pretending.",
    risk: "safe",
    stock: "Whatever the driver's INF asks for; usually power saving is allowed.",
    undo: "the power-management setting is re-enabled, but only if PingLab was the one that disabled it.",
    actions: { apply: "nic-power-off", revert: "nic-power-on" },
    ...OFF,
  },
  {
    id: "nagle",
    rowKey: "3",
    cli: "nagle",
    label: "Nagle's algorithm (per adapter)",
    what:
      "Writes TcpAckFrequency=1 and TCPNoDelay=1 under this adapter's TCP/IP interface key, so small TCP packets are sent immediately instead of being held for the next acknowledgement.",
    tradeoff:
      "Latency: removes the added delay for small request/response traffic, which is the shape of most game and voice traffic. Throughput: more, smaller packets on the wire — on a saturated or high-latency uplink this can cost a little bandwidth and a little CPU, and some ISPs' traffic shaping reacts to it. It also bypasses Windows' delayed-ACK timer for this adapter only.",
    risk: "moderate",
    stock: "Windows batches small packets and delays acknowledgements (the 200 ms timer).",
    undo: "the two values recorded before the change are written back; keys that did not exist before are removed again.",
    actions: { apply: "nagle-off", revert: "nagle-on" },
    ...OFF,
  },
  {
    id: "radio-tuning",
    rowKey: "4",
    cli: "wifi",
    label: "Wi-Fi radio power save (driver properties)",
    what:
      "Sets the driver's own MIMOPowerSaveMode to No SMPS and RoamAggressiveness to its lowest value. This is a hardware property, not a Windows preference.",
    tradeoff:
      "Battery: MIMO power save off means the card keeps both streams awake. Stability: lowest roaming aggressiveness makes the card hold on to the current access point until the link actually drops, which is good in a one-router flat and bad in a mesh, where it can sit on a weak AP. Measured here across repeated 60 s soaks: no latency or jitter gain, which is why it is experimental and in no preset.",
    risk: "experimental",
    stock: "Driver defaults (MIMO power save on, medium roaming aggressiveness).",
    undo: "the values the driver reported before the write are written back and verified.",
    actions: { apply: "adapter-tuning-off", revert: "adapter-tuning-on" },
    ...OFF,
  },
  {
    id: "wifi-order",
    rowKey: "5",
    cli: "order",
    label: "Wi-Fi auto-connect order",
    what:
      "Moves the profile of the network you are joined to now to priority 1 in the saved-profile list (netsh wlan set profileorder).",
    tradeoff:
      "Stability: after an adapter reset, driver reload or reconnect, Windows rejoins this network instead of whichever saved network it lists first — the usual cause of “it came back on the wrong Wi-Fi”. Cost: if you deliberately keep another profile first, this overrides that until you restore.",
    risk: "safe",
    stock: "Whichever profile Windows happens to list first decides, which may not be the one you are on.",
    undo: "the exact previous precedence is replayed profile by profile and read back; profiles deleted since are left out, never recreated.",
    actions: { apply: "wifi-order-first", revert: "wifi-order-restore" },
    ...OFF,
  },
  {
    id: "dns",
    rowKey: "6",
    cli: "dns",
    label: "DNS servers on this adapter",
    what:
      "Points the adapter at fixed DNS servers, either the ones that won the benchmark or ones you type in. Lookups then bypass whatever the router handed out over DHCP.",
    tradeoff:
      "Page loads and sign-ins: usually a little faster. Privacy: your queries go to the resolver you pick instead of your ISP's. Stability: anything local that lives in your router's DNS — Pi-hole filtering, .lan/.home hostnames, some ISP captive portals — stops resolving unless you point at the router itself. It does not change in-game ping.",
    risk: "moderate",
    stock: "DNS handed out by your router over DHCP.",
    undo: "the adapter is handed back to DHCP-provided DNS; the servers that were in use are recorded first.",
    actions: { apply: "dns-apply", revert: "dns-reset" },
    ...OFF,
  },
];

/**
 * Named presets. A preset is a short list of catalog ids, applied in order through the
 * same dispatch table as a single row, each with its own restore point. No preset may
 * contain an experimental tweak (validateCatalog enforces it), and none touches DNS,
 * because which resolver is fastest is a measurement, not a preset.
 */
export const PRESETS = [
  {
    id: "safe",
    label: "Safe / recommended",
    summary:
      "The three changes that cost only laptop battery and are undone by a single press each: no radio throttling, no device sleep, and the network you are on rejoins first.",
    tweaks: ["plan-power", "nic-power", "wifi-order"],
    leaves:
      "Nagle stays on (moderate) and the radio power-save experiment is not touched. DNS is left to your router.",
  },
  {
    id: "latency",
    label: "Lowest latency",
    summary:
      "The safe preset plus Nagle's algorithm disabled on this adapter, for small request/response traffic like games and voice.",
    tweaks: ["plan-power", "nic-power", "wifi-order", "nagle"],
    leaves:
      "The radio power-save experiment still is not included: it measured no gain here and can hurt roaming on a mesh.",
  },
];

export function tweakById(id) {
  return TWEAKS.find((t) => t.id === id) || null;
}

export function tweakByRowKey(key) {
  return TWEAKS.find((t) => t.rowKey === String(key)) || null;
}

export function tweakByCli(name) {
  return TWEAKS.find((t) => t.cli === String(name)) || null;
}

export function presetById(id) {
  return PRESETS.find((p) => p.id === String(id)) || null;
}

export function presetTweaks(preset) {
  return (preset?.tweaks || []).map(tweakById).filter(Boolean);
}

/** The presets a tweak belongs to - used to show "in: safe, latency" on a row. */
export function presetsFor(tweakId) {
  return PRESETS.filter((p) => p.tweaks.includes(tweakId));
}

/**
 * Catalog rules checked by `node pinglab.mjs --self-check`. A failure here is a bug in
 * this file, not a preference: it means some surface would show a setting without a
 * description, a risk level, or a way back.
 */
export function validateCatalog() {
  const problems = [];
  const seen = { id: new Set(), rowKey: new Set(), cli: new Set(), apply: new Set() };
  for (const t of TWEAKS) {
    for (const field of ["id", "rowKey", "cli", "label", "what", "tradeoff", "stock", "undo"]) {
      if (!t[field] || !String(t[field]).trim()) problems.push(`${t.id || "(no id)"}: missing ${field}`);
    }
    // The row key is a single character by design; everything else has to be a real sentence.
    for (const field of ["id", "cli", "label", "what", "tradeoff", "stock", "undo"]) {
      if (t[field] && String(t[field]).trim().length < 3) problems.push(`${t.id}: ${field} is too short to be useful`);
    }
    for (const key of ["id", "rowKey", "cli"]) {
      if (seen[key].has(t[key])) problems.push(`${t.id}: duplicate ${key} "${t[key]}"`);
      seen[key].add(t[key]);
    }
    if (!RISK[t.risk]) problems.push(`${t.id}: unknown risk "${t.risk}"`);
    if (t.default !== "off") problems.push(`${t.id}: default must be "off", found "${t.default}"`);
    if (!t.actions?.apply || !t.actions?.revert) problems.push(`${t.id}: needs both apply and revert actions`);
    if (t.actions?.apply === t.actions?.revert) problems.push(`${t.id}: apply and revert are the same action`);
    if (t.actions?.apply && seen.apply.has(t.actions.apply)) problems.push(`${t.id}: duplicate action "${t.actions.apply}"`);
    if (t.actions?.apply) seen.apply.add(t.actions.apply);
    if (t.risk === "experimental" && PRESETS.some((p) => p.tweaks.includes(t.id))) {
      problems.push(`${t.id}: experimental tweak listed in a preset`);
    }
    if (t.tradeoff && !/(latency|throughput|battery|stability|privacy|page)/i.test(t.tradeoff)) {
      problems.push(`${t.id}: tradeoff does not name a cost (latency/throughput/battery/stability/privacy)`);
    }
    if (t.what && t.what.length < 40) problems.push(`${t.id}: what it changes is too vague to be a description`);
  }
  for (const p of PRESETS) {
    for (const field of ["id", "label", "summary", "leaves"]) {
      if (!p[field] || String(p[field]).trim().length < 3) problems.push(`preset ${p.id || "(no id)"}: missing ${field}`);
    }
    if (!Array.isArray(p.tweaks) || !p.tweaks.length) problems.push(`preset ${p.id}: lists no tweaks`);
    for (const id of p.tweaks || []) {
      const t = tweakById(id);
      if (!t) problems.push(`preset ${p.id}: unknown tweak "${id}"`);
      else if (t.risk === "experimental") problems.push(`preset ${p.id}: would apply experimental "${id}"`);
    }
    if (new Set(p.tweaks || []).size !== (p.tweaks || []).length) problems.push(`preset ${p.id}: lists a tweak twice`);
  }
  if (!PRESETS.some((p) => p.id === "safe")) problems.push("no preset called \"safe\"");
  return { ok: problems.length === 0, problems };
}
