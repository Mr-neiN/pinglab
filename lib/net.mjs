import { runPs, runPsJson } from "./ps.mjs";

const sq = (s) => String(s).replace(/'/g, "''");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "432 Mbps" / "100 Gbps" / "0 bps" -> megabits per second (number). */
function parseLinkSpeed(text) {
  if (!text) return null;
  const m = String(text).match(/([\d.,]+)\s*(Gbps|Mbps|Kbps|bps)/i);
  if (!m) return null;
  const value = Number(m[1].replace(",", "."));
  if (!Number.isFinite(value)) return null;
  switch (m[2].toLowerCase()) {
    case "gbps":
      return value * 1000;
    case "mbps":
      return value;
    case "kbps":
      return value / 1000;
    default:
      return value / 1e6;
  }
}

const VIRTUAL_HINTS = ["tailscale", "vpn", "openvpn", "tap-windows", "virtual", "hyper-v", "loopback", "bluetooth"];

export async function adapters() {
  const { data } = await runPsJson(
    `Get-NetAdapter | Select-Object Name,InterfaceDescription,Status,LinkSpeed,MacAddress,ifIndex,InterfaceGuid,DriverVersion | ConvertTo-Json -Compress -Depth 3`,
    { timeout: 20000 },
  );
  return (data || []).map((a) => ({
    name: a.Name,
    description: a.InterfaceDescription,
    status: a.Status,
    linkSpeedText: a.LinkSpeed,
    linkSpeedMbps: parseLinkSpeed(a.LinkSpeed),
    mac: a.MacAddress,
    ifIndex: a.ifIndex,
    guid: a.InterfaceGuid,
    driver: a.DriverVersion,
    virtual: VIRTUAL_HINTS.some((h) => String(a.InterfaceDescription || "").toLowerCase().includes(h)),
    wifi: /wi-?fi|wireless|wlan|802\.11/i.test(`${a.InterfaceDescription} ${a.Name}`),
  }));
}

export async function routes() {
  const { data } = await runPsJson(
    `Get-NetRoute -DestinationPrefix '0.0.0.0/0' -ErrorAction SilentlyContinue |
       Sort-Object RouteMetric | Select-Object InterfaceAlias,NextHop,RouteMetric,ifIndex |
       ConvertTo-Json -Compress -Depth 3`,
    { timeout: 20000 },
  );
  return (data || []).map((r) => ({
    alias: r.InterfaceAlias,
    nextHop: r.NextHop,
    metric: r.RouteMetric,
    ifIndex: r.ifIndex,
  }));
}

async function connectionProfiles() {
  const { data } = await runPsJson(
    `Get-NetConnectionProfile -ErrorAction SilentlyContinue | Select-Object Name,InterfaceAlias,IPv4Connectivity,NetworkCategory | ConvertTo-Json -Compress -Depth 3`,
    { timeout: 20000 },
  );
  return (data || []).map((p) => ({
    name: p.Name,
    alias: p.InterfaceAlias,
    ipv4: p.IPv4Connectivity,
    category: p.NetworkCategory,
  }));
}

export async function dnsServers() {
  // `staticDns` is a different question from whether the address came from DHCP: a Pi-hole
  // setup can take its IP from the router and still have its resolvers typed in, and undo
  // has to tell those apart (`-ResetServerAddresses` would throw a typed-in list away).
  // `NameServer` under the interface's Tcpip key is the locale-independent record of a
  // hand-set DNS list, and it is what both Settings and Set-DnsClientServerAddress write.
  const { data } = await runPsJson(
    `$guids = @{}
try { Get-NetAdapter -ErrorAction SilentlyContinue | ForEach-Object { $guids[$_.Name] = $_.InterfaceGuid } } catch {}
Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Select-Object InterfaceAlias,@{n='servers';e={(($_.ServerAddresses | Where-Object { $_ }) -join ',')}},@{n='staticDns';e={ $guid = $guids[$_.InterfaceAlias]; if ($guid) { $ns = (Get-ItemProperty -Path "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\Tcpip\\Parameters\\Interfaces\\$guid" -Name NameServer -ErrorAction SilentlyContinue).NameServer; -not [string]::IsNullOrWhiteSpace([string]$ns) } else { $null } }} | ConvertTo-Json -Compress -Depth 4`,
    { timeout: 20000 },
  );
  // ConvertTo-Json collapses single-element arrays to scalars, so the addresses arrive comma joined.
  return (data || []).map((d) => ({
    alias: d.InterfaceAlias,
    servers: String(d.servers || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    // null means the interface's registry key could not be found, not "automatic".
    staticDns: typeof d.staticDns === "boolean" ? d.staticDns : null,
  }));
}

/**
 * The band Windows prints next to the channel: "Band : 5 GHz" in both views, "Bereich"
 * instead of "Band" on a German install, "2,4 GHz" with a decimal comma. Only the value is
 * read, never the label, because the label is localized and the unit is not.
 */
export function bandFromText(text) {
  const m = String(text ?? "").match(/(2[.,]4|5|6)\s*GHz/i);
  if (!m) return null;
  const value = m[1].replace(",", ".");
  return value === "2.4" ? "2.4 GHz" : `${value} GHz`;
}

/**
 * The band a channel belongs to. A channel number alone cannot answer this: 6 GHz reuses
 * the 1-233 numbering, so channel 37 is a 6 GHz channel and 149 exists on both 5 and
 * 6 GHz. When Windows reports the band beside the channel, that value wins. Without it,
 * only the numbers one band owns can be placed: 1-14 is 2.4 GHz, 36-177 is 5 GHz, and
 * 15-35 or 178-233 exist on 6 GHz alone.
 */
export function bandOf(channel, reported) {
  const named = bandFromText(reported);
  if (named) return named;
  if (typeof channel !== "number" || !Number.isInteger(channel)) return null;
  if (channel >= 1 && channel <= 14) return "2.4 GHz";
  if (channel >= 36 && channel <= 177) return "5 GHz";
  if (channel >= 15 && channel <= 233) return "6 GHz";
  return null;
}

function collectRates(text) {
  const rates = [];
  for (const m of text.matchAll(/([\d]+(?:[.,][\d]+)?)\s*(Gbps|Mbps)/gi)) {
    rates.push(m[2].toLowerCase() === "gbps" ? Number(m[1].replace(",", ".")) * 1000 : Number(m[1].replace(",", ".")));
  }
  for (const m of text.matchAll(/(Gbps|Mbps)\s*[:=]?\s*([\d]+(?:[.,][\d]+)?)/gi)) {
    rates.push(m[1].toLowerCase() === "gbps" ? Number(m[2].replace(",", ".")) * 1000 : Number(m[2].replace(",", ".")));
  }
  return rates.filter((n) => Number.isFinite(n));
}

/**
 * Wi-Fi detail. Windows 11 gates SSID/signal/channel behind Location services and
 * netsh needs elevation for some fields, so this degrades instead of failing.
 */
export async function wifi() {
  const { stdout: text } = await runPs("netsh wlan show interfaces", { timeout: 15000 });

  const blocked = /positionsdienste|location|standort|erhöhte rechte|elevated|error 5|fehler 5|access is denied/i.test(text);
  const ssid = text.match(/^\s*SSID\s*:\s*(.+)$/m)?.[1]?.trim() || null;
  const signal = text.match(/(\d{1,3})\s*%\s*$/m)?.[1];
  const channel = text.match(/(?:kanal|channel|canal|canale|kanał|канал|信道|チャネル)\s*[:=]\s*(\d+)/i)?.[1];
  // The interface block names its own band; believe it over the channel number.
  const reportedBand = bandFromText(text);
  const radio = text.match(/(802\.11\s?[a-z]{1,3})/i)?.[1] || null;
  const bssid = text.match(/BSSID\s*:\s*([0-9a-f]{2}(?:[:-][0-9a-f]{2}){5})/i)?.[1] || null;
  const rates = collectRates(text);
  const connected = Boolean(ssid || signal);

  return {
    ok: connected,
    connected,
    blocked,
    reason: connected
      ? null
      : blocked
        ? "Windows is hiding Wi-Fi details because Location services are off for your account. Turn on Location services in Settings → Privacy & security → Location, then rescan (elevation does not bypass this)."
        : "No Wi-Fi interface is reporting details (it may be disconnected).",
    ssid,
    bssid,
    radioType: radio,
    signalPct: signal ? Number(signal) : null,
    channel: channel ? Number(channel) : null,
    band: bandOf(channel ? Number(channel) : null, reportedBand),
    rxMbps: rates.length ? rates[0] : null,
    txMbps: rates.length > 1 ? rates[1] : null,
    raw: connected ? undefined : text.split("\n").slice(0, 4).join(" ").slice(0, 240),
  };
}

/**
 * Reads `netsh wlan show networks mode=bssid` text into networks. Every BSSID block
 * carries its own Band line, which is the only reliable answer for 6 GHz: the channel
 * number there reuses 5 GHz values. Text in, objects out, so the fixed-input test can
 * feed it a captured scan without needing a 6 GHz radio in range.
 */
export function parseScanText(text) {
  const networks = [];
  let currentSsid = null;
  let last = null;
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const ssidLine = line.match(/^\s*SSID\s+(\d+)\s*:\s*(.*)$/i);
    if (ssidLine) {
      currentSsid = ssidLine[2].trim() || "(hidden)";
      last = null;
      continue;
    }
    if (/BSSID/i.test(line) && /[0-9a-f]{2}([:-][0-9a-f]{2}){5}/i.test(line)) {
      last = { ssid: currentSsid || "(hidden)", channel: null, signalPct: null, reportedBand: null };
      networks.push(last);
      continue;
    }
    const named = bandFromText(line);
    if (named) {
      if (last && !last.reportedBand) last.reportedBand = named;
      continue;
    }
    const ch = line.match(/(?:kanal|channel|canal|canale|kanał|канал|信道|チャネル)\s*[:=]\s*(\d+)/i);
    if (ch) {
      const channel = Number(ch[1]);
      if (last && last.channel === null) last.channel = channel;
      else networks.push({ ssid: currentSsid || "(hidden)", channel, signalPct: null, reportedBand: null });
      last = networks[networks.length - 1];
      continue;
    }
    const sig = line.match(/(\d{1,3})\s*%\s*$/);
    if (sig && last && last.signalPct === null) last.signalPct = Number(sig[1]);
  }

  const withBand = networks.map((n) => ({
    ssid: n.ssid,
    channel: n.channel,
    signalPct: n.signalPct,
    band: bandOf(n.channel, n.reportedBand),
  }));

  // Counted per band: channel 149 on 5 GHz and channel 149 on 6 GHz are different channels
  // and cannot share a bar in the congestion grid.
  const usage = new Map();
  for (const n of withBand) {
    if (!n.channel) continue;
    const key = `${n.band ?? "unknown"}|${n.channel}`;
    const row = usage.get(key) || { channel: n.channel, band: n.band, count: 0 };
    row.count += 1;
    usage.set(key, row);
  }
  const channels = [...usage.values()].sort(
    (a, b) => a.channel - b.channel || String(a.band).localeCompare(String(b.band)),
  );

  return { networks: withBand, channels };
}

/** Channel congestion scan. Needs Location + admin; returns a clear reason if blocked. */
export async function wifiScan() {
  const { stdout: text } = await runPs("netsh wlan show networks mode=bssid", { timeout: 25000 });
  if (!text) return { ok: false, reason: "The scan returned nothing.", networks: [], channels: [] };
  if (/(erhöhte rechte|elevated|error 5|fehler 5|positionsdienste|location)/i.test(text) && !/BSSID/i.test(text)) {
    return {
      ok: false,
      reason: "The channel scan needs administrator rights and Location services. Use the Scan button and approve the prompt.",
      networks: [],
      channels: [],
    };
  }

  const { networks, channels } = parseScanText(text);
  return { ok: networks.length > 0, reason: null, networks: networks.slice(0, 40), channels };
}

/** Live throughput for one adapter, sampled over a short window. */
export async function throughput(alias) {
  if (!alias) return null;
  const script = `Get-NetAdapterStatistics -Name '${sq(alias)}' -ErrorAction SilentlyContinue |
    Select-Object ReceivedBytes,SentBytes | ConvertTo-Json -Compress`;
  const first = await runPsJson(script, { timeout: 15000 });
  await sleep(700);
  const second = await runPsJson(script, { timeout: 15000 });
  const a = first.data?.[0];
  const b = second.data?.[0];
  if (!a || !b) return null;
  const seconds = 0.7;
  const downMbps = ((Number(b.ReceivedBytes) - Number(a.ReceivedBytes)) * 8) / seconds / 1e6;
  const upMbps = ((Number(b.SentBytes) - Number(a.SentBytes)) * 8) / seconds / 1e6;
  return {
    downMbps: Math.max(0, Math.round(downMbps * 10) / 10),
    upMbps: Math.max(0, Math.round(upMbps * 10) / 10),
  };
}

/** Everything the connection panel needs. */
export async function snapshot() {
  const [adapterList, routeList, profiles, dns] = await Promise.all([
    adapters(),
    routes(),
    connectionProfiles(),
    dnsServers(),
  ]);
  const active = routeList[0] || null;
  const activeAdapter = active ? adapterList.find((a) => a.name === active.alias) || null : null;
  const [wifiInfo, live] = await Promise.all([
    activeAdapter?.wifi ? wifi() : Promise.resolve(null),
    throughput(active?.alias),
  ]);
  const dnsForActive = dns.find((d) => d.alias === active?.alias) || null;

  return {
    adapters: adapterList,
    activeRoute: active,
    activeAdapter,
    profiles,
    dns,
    dnsForActive,
    wifi: wifiInfo,
    throughput: live,
    usingWifi: Boolean(activeAdapter?.wifi),
  };
}
