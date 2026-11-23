/**
 * Band labels: 6 GHz reuses the 1-233 channel numbering, so "channel above 14 is 5 GHz" is
 * wrong the moment a 6 GHz radio is in range - a 6 GHz link on channel 37 was reported as
 * 5 GHz everywhere. Windows names the band beside the channel ("Band : 6 GHz", German
 * "Bereich : 2,4 GHz"); bandOf() believes that name and only falls back to the numbers when
 * Windows sends none. Fixed inputs, so the checks run without a 6 GHz radio nearby.
 */
import assert from "node:assert/strict";

import { bandFromText, bandOf, parseScanText } from "./net.mjs";
import { analyseWifi, wifiAdvice } from "./wifi.mjs";

const eq = (actual, expected, label) =>
  assert.equal(actual, expected, `${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

// 1. The reported band wins over what the number suggests.
{
  eq(bandOf(37, "6 GHz"), "6 GHz", "6 GHz channel 37");
  eq(bandOf(5, "6 GHz"), "6 GHz", "6 GHz also uses 2.4-numbered channels");
  eq(bandOf(1, "6 GHz"), "6 GHz", "6 GHz channel 1");
  eq(bandOf(149, "6 GHz"), "6 GHz", "6 GHz channel 149");
  eq(bandOf(149, "5 GHz"), "5 GHz", "5 GHz channel 149");
  eq(bandOf(37, "5 GHz"), "5 GHz", "5 GHz channel 37");
  eq(bandOf(37, "2.4 GHz"), "2.4 GHz", "an odd report still wins");
  eq(bandOf(null, "6 GHz"), "6 GHz", "the band is known even when the channel is not");
}

// 2. The value is read in the spellings netsh actually prints; the label is never matched,
//    because "Band" is "Bereich" on a German install and "Kanal" is not "Channel".
{
  eq(bandFromText("    Band                   : 5 GHz"), "5 GHz", "English interface line");
  eq(bandFromText("    Bereich                   : 2,4 GHz"), "2.4 GHz", "German interface line");
  eq(bandFromText("         Band               : 6 GHz"), "6 GHz", "scan BSSID line");
  eq(bandFromText("Frequenzband: 2.4 GHz"), "2.4 GHz", "decimal point");
  eq(bandFromText("Channel : 36"), null, "a channel is not a band");
  eq(bandFromText("         Kanal            : 1"), null, "a German channel is not a band");
  eq(bandFromText(""), null, "empty text");
  eq(bandFromText(null), null, "missing text");
}

// 3. Without a reported band only the numbers one band owns are placed, and numbers that
//    cannot exist are not guessed at.
{
  for (const channel of [1, 6, 11, 13, 14]) eq(bandOf(channel), "2.4 GHz", `channel ${channel}`);
  for (const channel of [36, 40, 100, 144, 149, 165, 177]) eq(bandOf(channel), "5 GHz", `channel ${channel}`);
  for (const channel of [15, 17, 33, 178, 229, 233]) eq(bandOf(channel), "6 GHz", `channel ${channel}`);
  eq(bandOf(234), null, "no band has channel 234");
  eq(bandOf(0), null, "channel 0");
  eq(bandOf(-5), null, "negative channel");
  eq(bandOf(36.5), null, "fractional channel");
  eq(bandOf("36"), null, "a string is not a channel");
  eq(bandOf(null), null, "no channel");
  eq(bandOf(undefined), null, "undefined channel");
}

// 4. A captured German scan with all three bands, the way Windows 11 writes it: the same
//    SSID on 2.4, 5 and 6 GHz, and the 6 GHz block on a channel number 5 GHz also owns.
{
  const text = `
Schnittstellenname : WLAN 

Momentan sind 3 Netzwerke sichtbar.

SSID 1 : Vodafone-A85410201
    Netzwerktyp             : Infrastruktur
    Authentifizierung       : WPA2-Personal
    BSSID 1                 : e4:8f:34:dd:1f:85
         Signal             : 83%  
         Funktyp         : 802.11n
         Band               : 2,4 GHz
         Kanal            : 1 
         Basisraten (MBit/s)   : 1 2 5.5 11

SSID 2 : Vodafone-A85410201
    Netzwerktyp             : Infrastruktur
    BSSID 1                 : e4:8f:34:dd:1f:86
         Signal             : 70%  
         Funktyp         : 802.11ax
         Band               : 5 GHz
         Kanal            : 36 
         Andere Raten (MBit/s) : 6 9 12 18 24 36 48 54

SSID 3 : Vodafone-A85410201
    Netzwerktyp             : Infrastruktur
    BSSID 1                 : e4:8f:34:dd:1f:87
         Signal             : 55%  
         Funktyp         : 802.11be
         Band               : 6 GHz
         Kanal            : 37 
`;
  const { networks, channels } = parseScanText(text);
  eq(networks.length, 3, "three BSSIDs");
  assert.deepEqual(
    networks.map((n) => [n.channel, n.band]),
    [
      [1, "2.4 GHz"],
      [36, "5 GHz"],
      [37, "6 GHz"],
    ],
    "each BSSID is labelled with the band Windows named",
  );
  assert.deepEqual(
    networks.map((n) => n.signalPct),
    [83, 70, 55],
    "signals still land in the right block",
  );
  assert.deepEqual(
    channels.map((c) => [c.channel, c.band, c.count]),
    [
      [1, "2.4 GHz", 1],
      [36, "5 GHz", 1],
      [37, "6 GHz", 1],
    ],
    "the congestion list keeps bands apart",
  );
}

// 5. A 6 GHz channel that looks exactly like a 2.4 GHz one stays 6 GHz, in English output.
{
  const text = `SSID 1 : Lab
    BSSID 1 : 00:11:22:33:44:55
         Signal : 88%
         Radio type : 802.11ax
         Band : 6 GHz
         Channel : 5
`;
  const { networks } = parseScanText(text);
  eq(networks[0].channel, 5, "channel");
  eq(networks[0].band, "6 GHz", "a 6 GHz channel 5 is not 2.4 GHz");
}

// 6. A build that prints no Band line still parses: the channel number decides, and only
//    where it can.
{
  const text = `SSID 1 : Old
    BSSID 1 : 00:11:22:33:44:66
         Signal : 60%
         Channel : 6

SSID 2 : Old
    BSSID 1 : 00:11:22:33:44:77
         Signal : 40%
         Channel : 181
`;
  const { networks } = parseScanText(text);
  assert.deepEqual(
    networks.map((n) => n.band),
    ["2.4 GHz", "6 GHz"],
    "channel 181 exists only on 6 GHz",
  );
}

// 7. Numbers shared between bands are not neighbours: a 6 GHz AP on channel 149 does not
//    interfere with a 5 GHz link on 149, and is not counted as a 5 GHz AP either.
{
  const scan = {
    networks: [
      { ssid: "Mine", channel: 149, signalPct: 80, band: "5 GHz" },
      { ssid: "Six", channel: 149, signalPct: 90, band: "6 GHz" },
      { ssid: "Five", channel: 36, signalPct: 70, band: "5 GHz" },
    ],
  };
  const wifi = { connected: true, ssid: "Mine", channel: 149, band: "5 GHz", signalPct: 80 };
  const a = analyseWifi(scan, wifi);
  eq(a.myBand, "5 GHz", "connection band");
  eq(a.coChannel.length, 0, "a 6 GHz AP on channel 149 is not a co-channel neighbour");
  assert.deepEqual(a.fiveGhz.map((n) => n.ssid), ["Five"], "6 GHz is not reported as 5 GHz");
  eq(a.nets.find((n) => n.ssid === "Six").band, "6 GHz", "the scan keeps the 6 GHz label");
}

// 8. Advice only claims what the inputs support. A 2.4 GHz link with a 5 GHz neighbour
//    visible: the word "visible" is in every count, the adapter cap is not invented, and
//    PingLab does not pretend to know which AP is the user's router.
{
  const wifi = { connected: true, ssid: "Mine", channel: 6, band: "2.4 GHz", signalPct: 80, rxMbps: 144, txMbps: 144 };
  const scan = {
    networks: [
      { ssid: "Mine", channel: 6, signalPct: 80, band: "2.4 GHz" },
      { ssid: "Upstairs", channel: 36, signalPct: 60, band: "5 GHz" },
    ],
  };
  const text = wifiAdvice(analyseWifi(scan, wifi), wifi, scan)
    .map(([kind, line]) => `${kind}: ${line}`)
    .join("\n");
  assert.match(text, /No other visible access point shares channel 6/);
  assert.match(text, /PingLab cannot tell which AP is yours/);
  assert.match(text, /negotiated link rate/);
  assert.doesNotMatch(text, /caps out around/);
  assert.doesNotMatch(text, /2x2/);
  assert.doesNotMatch(text, /20 MHz/);
  assert.doesNotMatch(text, /None of these is your router/);
  assert.doesNotMatch(text, /prefer ch 36/);
}

// 9. A cached scan is not a survey: no co-channel claim, no "cleanest channel" advice.
{
  const wifi = { connected: true, ssid: "Mine", channel: 6, band: "2.4 GHz", signalPct: 80 };
  const scan = {
    networks: [{ ssid: "Mine", channel: 6, signalPct: 80, band: "2.4 GHz" }],
    stale: true,
  };
  const text = wifiAdvice(analyseWifi(scan, wifi), wifi, scan)
    .map(([kind, line]) => `${kind}: ${line}`)
    .join("\n");
  assert.match(text, /cached scan/);
  assert.doesNotMatch(text, /No other visible access point/);
  assert.doesNotMatch(text, /Cleanest visible/);
  assert.doesNotMatch(text, /nothing visible is overlapping/);
}

// 10. A 6 GHz link gets 6 GHz advice, not "0 APs on 5 GHz".
{
  const wifi = { connected: true, ssid: "Lab", channel: 37, band: "6 GHz", signalPct: 70 };
  const scan = { networks: [{ ssid: "Lab", channel: 37, signalPct: 70, band: "6 GHz" }] };
  const text = wifiAdvice(analyseWifi(scan, wifi), wifi, scan)
    .map(([, line]) => line)
    .join("\n");
  assert.match(text, /6 GHz has the most room/);
  assert.doesNotMatch(text, /5 GHz in range/);
}

// 11. A weak radio is called what it is: a coarse Windows quality percentage, not a speed.
{
  const wifi = { connected: true, ssid: "Mine", channel: 6, band: "2.4 GHz", signalPct: 40 };
  const scan = { networks: [{ ssid: "Mine", channel: 6, signalPct: 40, band: "2.4 GHz" }] };
  const text = wifiAdvice(analyseWifi(scan, wifi), wifi, scan)
    .map(([, line]) => line)
    .join("\n");
  assert.match(text, /Signal quality 40% is weak/);
  assert.match(text, /not a speed measurement/);
}

// 12. A truncated scan says so, because its counts are of the first 40 radio blocks only.
{
  const wifi = { connected: true, ssid: "Mine", channel: 1, band: "2.4 GHz", signalPct: 80 };
  const scan = {
    networks: [{ ssid: "Mine", channel: 1, signalPct: 80, band: "2.4 GHz" }],
    truncated: true,
  };
  const text = wifiAdvice(analyseWifi(scan, wifi), wifi, scan)
    .map(([, line]) => line)
    .join("\n");
  assert.match(text, /cut at 40 networks/);
}

console.log("\nwifi band");
console.log("  reported   Windows' Band value wins, German comma and label included");
console.log("  fallback   1-14 2.4 GHz, 36-177 5 GHz, 15-35 and 178-233 6 GHz only");
console.log("  scan       per-BSSID Band parsed, bands kept apart in the congestion list");
console.log("\nall wifi band checks passed");
