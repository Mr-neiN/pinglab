/**
 * Band labels: 6 GHz reuses the 1-233 channel numbering, so "channel above 14 is 5 GHz" is
 * wrong the moment a 6 GHz radio is in range - a 6 GHz link on channel 37 was reported as
 * 5 GHz everywhere. Windows names the band beside the channel ("Band : 6 GHz", German
 * "Bereich : 2,4 GHz"); bandOf() believes that name and only falls back to the numbers when
 * Windows sends none. Fixed inputs, so the checks run without a 6 GHz radio nearby.
 *
 * Sections 16 and 17 drive the real scan read against the fake Windows: freshness is never
 * inferred from the list, so neither a two-network list nor a cached one gets a verdict.
 * Sections 18-21 pin the other half: the WlanScan shim is asked first, only a real
 * scan-complete notification may date the list, and every way the shim can fail falls back to
 * reading netsh with no claim at all.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { bandFromText, bandOf, parseScanText, wifi } from "./net.mjs";
import { scanFreshnessText } from "./report.mjs";
import { analyseWifi, scanWifi, wifiAdvice } from "./wifi.mjs";
import { shimScript } from "./wlan-shim.mjs";

// The scan cases read through lib/net.mjs against a described Windows (lib/ps-fake.mjs, loaded
// through PINGLAB_PS_STUB), so they exercise the shipped scan path with no radio and no netsh.
// The folder is thrown away at the end.
const dir = mkdtempSync(join(tmpdir(), "pinglab-wifi-"));
process.env.PINGLAB_DATA_DIR = join(dir, "data");
process.env.PINGLAB_PS_STUB = fileURLToPath(new URL("../lib/ps-fake.mjs", import.meta.url));
process.env.PINGLAB_PS_LOG = join(dir, "ps.ndjson");

/** Point the fake Windows at a scan, and forget the calls of the previous case. */
function useScan(scenario) {
  writeFileSync(process.env.PINGLAB_PS_LOG, "", "utf8");
  process.env.PINGLAB_PS_SCENARIO = JSON.stringify(scenario);
}

/** Every PowerShell call the shipped path made, in order. */
function psEntries() {
  return readFileSync(process.env.PINGLAB_PS_LOG, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** How many times the shipped scan path asked Windows for the list. */
function scanCalls() {
  return psEntries().filter((c) => c.kind === "wlan-scan").length;
}

/** The WlanScan triggers, so a test can prove a scan was (or was not) requested. */
function shimCalls() {
  return psEntries().filter((c) => c.kind === "wlan-shim");
}

/** The adapter a described Windows reports, with a real-looking GUID: the shim is given it. */
const ADAPTER = {
  Name: "WLAN",
  InterfaceDescription: "Intel Wi-Fi 6 AX201",
  Status: "Up",
  LinkSpeed: "867 Mbps",
  MacAddress: "AA-BB-CC-DD-EE-FF",
  ifIndex: 1,
  InterfaceGuid: "11111111-2222-3333-4444-555555555555",
  DriverVersion: "1.0.0.0",
};

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
//    cannot exist are not guessed at. 36-177 is shared with 6 GHz, so it stays unknown.
{
  for (const channel of [1, 6, 11, 13, 14]) eq(bandOf(channel), "2.4 GHz", `channel ${channel}`);
  for (const channel of [36, 40, 100, 144, 149, 165, 177]) eq(bandOf(channel), null, `channel ${channel} is shared`);
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

// 9. A scan holding only two networks is a real answer, not a cache. Windows dates no scan,
//    so nothing may call this list cached; the counts are reported, each worded as what this
//    scan saw. The old code read "2 or fewer networks" as a cache and withheld all of it.
{
  const wifi = { connected: true, ssid: "Mine", channel: 6, band: "2.4 GHz", signalPct: 80 };
  const scan = {
    networks: [
      { ssid: "Mine", channel: 6, signalPct: 80, band: "2.4 GHz" },
      { ssid: "Neighbour", channel: 11, signalPct: 60, band: "2.4 GHz" },
    ],
  };
  const text = wifiAdvice(analyseWifi(scan, wifi), wifi, scan)
    .map(([kind, line]) => `${kind}: ${line}`)
    .join("\n");
  assert.match(text, /No other visible access point shares channel 6/, "a quiet scan still gets its co-channel answer");
  assert.match(text, /none in this scan/, "and the answer is scoped to the scan");
  assert.match(text, /nothing visible is overlapping it/, "and its interference score");
  assert.doesNotMatch(text, /cached|fresh|refreshed/i, "nothing claims a freshness the scan cannot report");
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

// 13. A channel both bands use, with Windows sending no Band line, is unknown - not 5 GHz.
//     This was the app's confident mistake: an AP on 149 was reported, and counted, as a
//     5 GHz neighbour when it may have been 6 GHz.
{
  for (const channel of [36, 40, 100, 144, 149, 165, 177]) eq(bandOf(channel), null, `channel ${channel}`);
  const text = `SSID 1 : Old
    BSSID 1 : 00:11:22:33:44:88
         Signal : 70%
         Channel : 149
`;
  const { networks, channels } = parseScanText(text);
  eq(networks[0].band, null, "an unconfirmed 149 stays unknown");
  eq(channels[0].band, null, "the congestion list does not invent a band either");
}

// 14. An unconfirmed link suppresses the co-channel claim instead of answering "none", and
//     an AP on the shared range is counted as neither band.
{
  const scan = {
    networks: [
      { ssid: "Mine", channel: 149, signalPct: 80, band: null },
      { ssid: "Five", channel: 36, signalPct: 70, band: "5 GHz" },
      { ssid: "Six", channel: 149, signalPct: 60, band: "6 GHz" },
    ],
  };
  const wifi = { connected: true, ssid: "Mine", channel: 149, signalPct: 80 };
  const a = analyseWifi(scan, wifi);
  eq(a.myBand, null, "the link's band is unknown");
  eq(a.bandUnknown, true, "and the analysis says so");
  eq(a.coChannel.length, 0, "nothing is claimed to share the channel");
  assert.deepEqual(a.fiveGhz.map((n) => n.ssid), ["Five"], "the unknown AP is not a 5 GHz AP");
  assert.deepEqual(a.sixGhz.map((n) => n.ssid), ["Six"], "nor a 6 GHz one");
  const lines = wifiAdvice(a, wifi, scan)
    .map(([, line]) => line)
    .join("\n");
  assert.match(lines, /did not name the band for this link/);
  assert.doesNotMatch(lines, /No other visible access point shares/);
  assert.doesNotMatch(lines, /AP\(s\) on 5 GHz in range/);
}

// 15. A definite 5 GHz link still does not adopt an AP whose band Windows left out: it is
//     counted as neither, and the advice says that instead of adding it to the 5 GHz total.
{
  const scan = {
    networks: [
      { ssid: "Mine", channel: 36, signalPct: 80, band: "5 GHz" },
      { ssid: "Maybe", channel: 149, signalPct: 60, band: null },
    ],
  };
  const wifi = { connected: true, ssid: "Mine", channel: 36, band: "5 GHz", signalPct: 80 };
  const a = analyseWifi(scan, wifi);
  eq(a.myBand, "5 GHz", "the link's band is known");
  eq(a.fiveGhz.length, 0, "an unknown-band AP is not a 5 GHz AP");
  assert.deepEqual(a.bandUnknownAps.map((n) => n.ssid), ["Maybe"], "it is reported separately");
  const lines = wifiAdvice(a, wifi, scan)
    .map(([, line]) => line)
    .join("\n");
  assert.match(lines, /counted as neither/);
  assert.match(lines, /0 AP\(s\) on 5 GHz in range/);
}

// 16. A genuine two-network environment: the scan is read once, reported as the two
//     observations it holds, and the advice is complete. The old code read "2 or fewer
//     networks" as a cache, opened the network flyout, waited, re-read, and withheld every
//     count-based line - on a quiet home that is simply wrong.
try {
  useScan({
    scan: [
      { ssid: "Mine", channel: 6, signal: 80, band: "2.4 GHz" },
      { ssid: "Neighbour", channel: 11, signal: 60, band: "2.4 GHz" },
    ],
    // What a second read would have returned: what the old "refresh" was for.
    scanAfter: [
      { ssid: "Mine", channel: 6, signal: 80, band: "2.4 GHz" },
      { ssid: "Neighbour", channel: 11, signal: 60, band: "2.4 GHz" },
      { ssid: "Farther", channel: 1, signal: 25, band: "2.4 GHz" },
    ],
  });
  const scan = await scanWifi();
  eq(scanCalls(), 1, "a two-network scan is read once, not re-read as a refresh");
  eq(scan.networks.length, 2, "both networks are reported");
  eq("stale" in scan, false, "no stale verdict is invented");
  eq("refreshed" in scan, false, "no refreshed verdict is invented");
  const link = { connected: true, ssid: "Mine", channel: 6, band: "2.4 GHz", signalPct: 80 };
  const text = wifiAdvice(analyseWifi(scan, link), link, scan)
    .map(([kind, line]) => `${kind}: ${line}`)
    .join("\n");
  assert.match(text, /No other visible access point shares channel 6/, "the co-channel answer survives");
  assert.match(text, /nothing visible is overlapping it/, "so does the interference score");
  assert.doesNotMatch(text, /cached|fresh|refreshed/i, "and no freshness claim is added");

  // 17. A list Windows really did serve from its cache is not relabelled as freshly scanned:
  //     nothing re-reads it, so nothing can call the result fresh (or stale).
  useScan({
    scan: [{ ssid: "Mine", channel: 6, signal: 80, band: "2.4 GHz" }],
    scanAfter: [
      { ssid: "Mine", channel: 6, signal: 80, band: "2.4 GHz" },
      { ssid: "A", channel: 1, signal: 55, band: "2.4 GHz" },
      { ssid: "B", channel: 11, signal: 50, band: "2.4 GHz" },
      { ssid: "C", channel: 36, signal: 45, band: "5 GHz" },
      { ssid: "D", channel: 149, signal: 40, band: "5 GHz" },
    ],
  });
  const cached = await scanWifi();
  eq(scanCalls(), 1, "there is no second read that could be called a fresh scan");
  eq(cached.networks.length, 1, "the list is reported exactly as Windows returned it");
  eq("refreshed" in cached, false, "nothing relabels it as refreshed");
  eq("stale" in cached, false, "and nothing guesses that it is stale either");
  const cachedText = wifiAdvice(analyseWifi(cached, link), link, cached)
    .map(([kind, line]) => `${kind}: ${line}`)
    .join("\n");
  assert.doesNotMatch(cachedText, /cached|fresh|refreshed/i);
  assert.match(cachedText, /none in this scan/, "the claim stays scoped to what the scan held");

  // 18. A scan Windows itself confirms: the shim asks for it before netsh is read, and the
  //     result carries the measured time from the request to the completion notification.
  {
    useScan({
      adapters: [ADAPTER],
      scan: [{ ssid: "Mine", channel: 6, signal: 80, band: "2.4 GHz" }],
      wlanScan: { mode: "complete", elapsedMs: 412 },
    });
    const scan = await scanWifi();
    const kinds = psEntries().map((e) => e.kind);
    eq(scan.freshness.attempted, true, "the shim is attempted");
    eq(scan.freshness.ok, true, "a completion notice confirms the scan");
    eq(scan.freshness.elapsedMs, 412, "the measured time is carried through");
    eq(scan.freshness.reason, null, "a confirmed scan carries no reason");
    eq(kinds.filter((k) => k === "wlan-shim").length, 1, "one scan is triggered");
    eq(kinds.filter((k) => k === "wlan-scan").length, 1, "one list is read");
    assert.ok(
      kinds.indexOf("wlan-shim") < kinds.indexOf("wlan-scan"),
      "the scan is triggered before the list is read",
    );
    eq(shimCalls()[0].guid, ADAPTER.InterfaceGuid, "the adapter Windows reported is the one scanned");
    const text = scanFreshnessText(scan.freshness);
    assert.match(text, /confirmed a scan finished 412 ms after PingLab asked for one/);
    assert.match(text, /dates the scan, not every network in it/);
    assert.doesNotMatch(text, /cached/i, "a confirmed scan does not talk about a cache");
    const link = { connected: true, ssid: "Mine", channel: 6, band: "2.4 GHz", signalPct: 80 };
    const advice = wifiAdvice(analyseWifi(scan, link), link, scan)
      .map(([, line]) => line)
      .join("\n");
    assert.doesNotMatch(advice, /cached|fresh|refreshed|confirmed/i, "the advice itself still claims no freshness");
  }

  // 19. Every way the shim can fail falls back to the old behaviour: the list is still read,
  //     and the sentence says there is no confirmation instead of implying one.
  for (const [mode, reason] of [
    ["denied", /access denied/],
    ["timeout", /time limit/],
    ["unavailable", /could not be loaded/],
    ["failed", /scan failed/],
  ]) {
    useScan({
      adapters: [ADAPTER],
      scan: [{ ssid: "Mine", channel: 6, signal: 80, band: "2.4 GHz" }],
      wlanScan: { mode },
    });
    const scan = await scanWifi();
    eq(scan.freshness.ok, false, `${mode}: not confirmed`);
    eq(scan.networks.length, 1, `${mode}: the list is still reported`);
    eq(scanCalls(), 1, `${mode}: netsh is still read once`);
    const text = scanFreshnessText(scan.freshness);
    assert.match(text, /no scan-complete confirmation/i, `${mode}: says there is none`);
    assert.match(text, /no fresh-or-cached verdict/i, `${mode}: claims no freshness`);
    assert.match(text, reason, `${mode}: names the reason`);
    assert.doesNotMatch(text, /confirmed a scan finished/i, `${mode}: does not imply a confirmation`);
  }

  // 20. No usable Wi-Fi adapter id: nothing is triggered, the list is still read, and the
  //     result says why it cannot date the scan.
  {
    useScan({
      adapters: [
        {
          Name: "Ethernet",
          InterfaceDescription: "Realtek PCIe GbE Family Controller",
          Status: "Up",
          LinkSpeed: "1 Gbps",
          MacAddress: "AA-BB-CC-DD-EE-FF",
          ifIndex: 2,
          InterfaceGuid: "22222222-3333-4444-5555-666666666666",
          DriverVersion: "1.0.0.0",
        },
      ],
      scan: [{ ssid: "Mine", channel: 6, signal: 80, band: "2.4 GHz" }],
    });
    const scan = await scanWifi();
    eq(shimCalls().length, 0, "no Wi-Fi adapter means no scan is triggered");
    eq(scanCalls(), 1, "the list is still read");
    eq(scan.freshness.attempted, false, "nothing was attempted");
    assert.match(scanFreshnessText(scan.freshness), /no Wi-Fi adapter id/);
  }

  // 21. The emitted shim is the bounded one: the caller's timeout is clamped into the script,
  //     and the scan targets the GUID that was passed rather than anything else.
  {
    const script = shimScript(ADAPTER.InterfaceGuid, 5000);
    assert.match(script, /Add-Type -TypeDefinition @'/);
    assert.match(script, /WlanRegisterNotification/);
    assert.match(script, /WlanScan\(handle, ref guid/);
    assert.match(script, /code == WLAN_NOTIFICATION_ACM_SCAN_COMPLETE/);
    assert.match(script, /::Run\('11111111-2222-3333-4444-555555555555', 5000\)/);
    assert.match(shimScript(ADAPTER.InterfaceGuid, 999999), /, 15000\)/, "the wait is capped");
    assert.match(shimScript(ADAPTER.InterfaceGuid, 1), /, 1000\)/, "and floored");
  }
  // 22. An SSID is chosen by whoever runs the access point, and it is printed on a terminal.
  //     A control byte in it must never arrive as an escape sequence: ESC in an SSID could
  //     clear the screen or repaint a line PingLab printed. It becomes a visible "?" instead,
  //     so the name is still shown and cannot drive the terminal.
  {
    const ESC = String.fromCharCode(27);
    const hostile = `Cafe${ESC}[2J${ESC}[31mPWNED${ESC}[0m`;
    useScan({ wlan: { joined: hostile }, scan: [{ ssid: hostile, channel: 6, signal: 80, band: "2.4 GHz" }] });
    const link = await wifi();
    eq(link.ssid, "Cafe?[2J?[31mPWNED?[0m", "the joined SSID cannot carry terminal controls");
    assert.doesNotMatch(link.ssid, /[\u0000-\u001f\u007f-\u009f]/, "no control character survives");

    const { networks } = parseScanText(
      `SSID 1 : ${hostile}\n    BSSID 1 : aa:bb:cc:dd:ee:00\n         Signal : 80%\n         Kanal : 6\n`,
    );
    eq(networks[0].ssid, "Cafe?[2J?[31mPWNED?[0m", "a scanned SSID cannot either");
    // Each advice line is one line by contract; check the text itself, not the join.
    const advice = wifiAdvice(analyseWifi({ networks }, link), link, { networks });
    for (const [, text] of advice) {
      assert.doesNotMatch(text, /[\u0000-\u001f\u007f-\u009f]/, "and the advice built from it is clean");
    }
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("\nwifi band");
console.log("  reported   Windows' Band value wins, German comma and label included");
console.log("  fallback   1-14 2.4 GHz, 15-35 and 178-233 6 GHz only, 36-177 shared so unknown");
console.log("  unknown    a shared channel with no Band line is counted as neither band");
console.log("  scan       per-BSSID Band parsed, bands kept apart in the congestion list");
console.log("  freshness  never inferred from the list: a 2-network scan is read once, a cached one is never called fresh");
console.log("  shim       WlanScan + scan-complete dates the list; every failure falls back to no claim");
console.log("\nall wifi band checks passed");
