import { runPs, runPsJson } from "./ps.mjs";

const sq = (s) => String(s).replace(/'/g, "''");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** "432 Mbps" / "100 Gbps" / "0 bps" -> megabits per second (number). */
export function parseLinkSpeed(text) {
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

export async function connectionProfiles() {
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
  const { data } = await runPsJson(
    `Get-DnsClientServerAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
       Select-Object InterfaceAlias,@{n='servers';e={(($_.ServerAddresses | Where-Object { $_ }) -join ',')}} | ConvertTo-Json -Compress -Depth 4`,
    { timeout: 20000 },
  );
  // ConvertTo-Json collapses single-element arrays to scalars, so the addresses arrive comma joined.
  return (data || []).map((d) => ({
    alias: d.InterfaceAlias,
    servers: String(d.servers || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  }));
}

function bandForChannel(channel) {
  if (!channel) return null;
  if (channel <= 14) return "2.4 GHz";
  if (channel <= 233) return "5 GHz";
  return "6 GHz";
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
    band: channel ? bandForChannel(Number(channel)) : null,
    rxMbps: rates.length ? rates[0] : null,
    txMbps: rates.length > 1 ? rates[1] : null,
    raw: connected ? undefined : text.split("\n").slice(0, 4).join(" ").slice(0, 240),
  };
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

  const networks = [];
  let currentSsid = null;
  let last = null;
  for (const line of text.split(/\r?\n/)) {
    const ssidLine = line.match(/^\s*SSID\s+(\d+)\s*:\s*(.*)$/i);
    if (ssidLine) {
      currentSsid = ssidLine[2].trim() || "(hidden)";
      last = null;
      continue;
    }
    if (/BSSID/i.test(line) && /[0-9a-f]{2}([:-][0-9a-f]{2}){5}/i.test(line)) {
      last = { ssid: currentSsid || "(hidden)", channel: null, signalPct: null };
      networks.push(last);
      continue;
    }
    const ch = line.match(/(?:kanal|channel|canal|canale|kanał|канал|信道|チャネル)\s*[:=]\s*(\d+)/i);
    if (ch) {
      const channel = Number(ch[1]);
      if (last && last.channel === null) last.channel = channel;
      else networks.push({ ssid: currentSsid || "(hidden)", channel, signalPct: null });
      last = networks[networks.length - 1];
      continue;
    }
    const sig = line.match(/(\d{1,3})\s*%\s*$/);
    if (sig && last && last.signalPct === null) last.signalPct = Number(sig[1]);
  }

  const usage = new Map();
  for (const n of networks) {
    if (!n.channel) continue;
    usage.set(n.channel, (usage.get(n.channel) || 0) + 1);
  }
  const channels = [...usage.entries()]
    .map(([channel, count]) => ({ channel, count, band: bandForChannel(channel) }))
    .sort((a, b) => a.channel - b.channel);

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

/** Which local processes hold the most connections (first guess at bandwidth hogs). */
export async function topTalkers() {
  const { data } = await runPsJson(
    `Get-NetTCPConnection -State Established -ErrorAction SilentlyContinue |
       Group-Object OwningProcess | Sort-Object Count -Descending | Select-Object -First 6 |
       ForEach-Object {
         $p = Get-Process -Id ([int]$_.Name) -ErrorAction SilentlyContinue
         [pscustomobject]@{ process = $(if ($p) { $p.ProcessName } else { 'pid ' + $_.Name }); connections = $_.Count }
       } | ConvertTo-Json -Compress -Depth 3`,
    { timeout: 20000 },
  );
  return (data || []).map((t) => ({ process: t.process, connections: t.connections }));
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
