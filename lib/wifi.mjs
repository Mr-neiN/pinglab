import { adapters, wifiScan, bandOf } from "./net.mjs";
import { triggerScan } from "./wlan-shim.mjs";

// The band rules live with the netsh parsing they describe; re-exported because every
// surface already asks this module for the label.
export { bandOf } from "./net.mjs";

/** Interference-weighted channel ranking for 2.4 GHz (2.4 channels overlap ±4). */
export function analyseWifi(scan, wifi) {
  const nets = (scan?.networks || []).map((n) => ({
    ssid: n.ssid || "(hidden)",
    channel: typeof n.channel === "number" ? n.channel : null,
    signal: typeof n.signalPct === "number" ? n.signalPct : n.signal ?? null,
    band: bandOf(typeof n.channel === "number" ? n.channel : null, n.band),
  }));
  const mySsid = wifi?.ssid || null;
  const myChannel = typeof wifi?.channel === "number" ? wifi.channel : null;
  const myBand = wifi?.band || bandOf(myChannel);

  const isMine = (n) => mySsid && n.ssid === mySsid && n.channel === myChannel;
  const others = nets.filter((n) => !isMine(n) && n.channel !== null);

  const overlap = (a, b) => {
    const d = Math.abs(a - b);
    return d >= 5 ? 0 : 1 - d / 5;
  };

  const score = (ch) =>
    others.filter((n) => (n.channel <= 14) === (ch <= 14)).reduce((sum, n) => sum + (n.signal ?? 0) * overlap(ch, n.channel), 0);

  // 5 and 6 GHz share channel numbers, so "same channel" only means something inside one
  // band: a 6 GHz AP on channel 149 does not interfere with a 5 GHz link on 149.
  // A channel 5 and 6 GHz both use, on a link Windows sent no Band line for: the link's own
  // band is unknown, so no neighbour can be placed in it.
  const bandUnknown = !myBand && myChannel !== null;
  // Only a definite band match is a neighbour. An AP on 149 whose band Windows did not name
  // may be 6 GHz, so counting it as a 5 GHz neighbour would be the guess this module avoids.
  const inMyBand = (n) => !bandUnknown && n.band !== null && n.band === myBand;
  const coChannel = others.filter((n) => n.channel === myChannel && inMyBand(n));
  const adjacent = others.filter(
    (n) => myChannel !== null && n.channel !== myChannel && overlap(myChannel, n.channel) > 0 && inMyBand(n),
  );
  const fiveGhz = others.filter((n) => n.band === "5 GHz");
  const sixGhz = others.filter((n) => n.band === "6 GHz");
  const bandUnknownAps = others.filter((n) => n.band === null);

  // Only the winner is kept: the callers show the cleanest channel, never the full ranking.
  const best24 = [1, 6, 11, 13]
    .map((ch) => ({ ch, score: Math.round(score(ch)) }))
    .sort((a, b) => a.score - b.score)[0];

  return {
    nets,
    others,
    mySsid,
    myChannel,
    myBand,
    coChannel,
    adjacent,
    fiveGhz,
    sixGhz,
    bandUnknown,
    bandUnknownAps,
    best24,
    myScore: myChannel !== null && myChannel <= 14 ? Math.round(score(myChannel)) : null,
  };
}

const names = (list, max = 4) => {
  const shown = list.slice(0, max).map((n) => `${n.ssid} (ch ${n.channel ?? "?"}, ${n.signal ?? "?"}%)`);
  return list.length > max ? `${shown.join(", ")} and ${list.length - max} more` : shown.join(", ");
};

/**
 * Plain-language verdicts, each tagged good / warn / bad / info / dim.
 *
 * Wi-Fi reporting is where a tool can be confidently wrong: Windows' signal figure is a
 * coarse quality percentage, it may answer the scan from a cache it never dates, and the
 * adapter's capabilities are not exposed at all. This function therefore only claims what
 * the inputs actually support: every count is a statement about what this scan returned
 * ("visible", "in this scan"), never about the air, and it neither invents an adapter limit
 * nor assumes which visible access point is the user's router.
 */
export function wifiAdvice(a, wifi, scan = null) {
  const out = [];
  if (!wifi?.connected) {
    out.push(["warn", "Windows is not reporting Wi-Fi details."]);
    return out;
  }
  const rates =
    wifi.rxMbps || wifi.txMbps
      ? ` Windows reports a ${wifi.rxMbps ?? "?"} Mbps receive rate${wifi.txMbps ? ` and ${wifi.txMbps} Mbps transmit rate` : ""}; that is the negotiated link rate, not a speed test.`
      : "";
  out.push([
    "info",
    `You are on ${a.mySsid || "your network"} — ${a.myBand || "?"}, channel ${a.myChannel ?? "?"}, signal quality ${wifi.signalPct ?? "?"}%.${rates}`,
  ]);

  if (a.bandUnknown) {
    out.push([
      "dim",
      `Windows did not name the band for this link, and channel ${a.myChannel} is used by both 5 GHz and 6 GHz, so co-channel and "clean channel" claims are withheld rather than guessed.`,
    ]);
  } else {
    if (a.coChannel.length === 0) {
      out.push(["good", `No other visible access point shares channel ${a.myChannel}. Co-channel interference: none in this scan.`]);
    } else {
      const worst = a.coChannel.reduce((w, n) => ((n.signal ?? 0) > (w.signal ?? 0) ? n : w), a.coChannel[0]);
      out.push([
        a.coChannel.length > 2 ? "bad" : "warn",
        `${a.coChannel.length} other AP(s) share channel ${a.myChannel}, strongest ${worst.ssid} at ${worst.signal ?? "?"}%.`,
      ]);
    }

    if (a.adjacent.length) {
      out.push([
        "warn",
        `${a.adjacent.length} nearby AP(s) partially overlap your channel: ${names(a.adjacent)}.`,
      ]);
    }

    if (a.myChannel !== null && a.myChannel <= 14) {
      if (a.myScore === 0) {
        out.push(["good", `Channel ${a.myChannel} scores ${a.myScore} — nothing visible is overlapping it.`]);
      } else if (a.best24 && a.best24.ch !== a.myChannel) {
        out.push([
          "info",
          `Cleanest visible 2.4 GHz channel is ${a.best24.ch} (interference score ${a.best24.score}); yours scores ${a.myScore}. Moving the router is your decision, not PingLab's.`,
        ]);
      } else {
        out.push(["good", `Channel ${a.myChannel} is already the cleanest visible 2.4 GHz choice (score ${a.myScore}).`]);
      }
    }
  }

  if (typeof wifi.signalPct === "number" && wifi.signalPct < 55) {
    out.push([
      "warn",
      `Signal quality ${wifi.signalPct}% is weak. Windows' percentage is coarse and is not a speed measurement; it is still the best reason to move closer or use a cable.`,
    ]);
  }

  if (a.myBand === "6 GHz") {
    out.push([
      a.coChannel.length ? "warn" : "good",
      `${a.sixGhz.length} AP(s) on 6 GHz in range; ${a.coChannel.length} share your channel. 6 GHz has the most room and the shortest range — good in one room, poor through walls.`,
    ]);
  } else if (a.myBand === "5 GHz") {
    out.push([
      a.coChannel.length ? "warn" : "good",
      `${a.fiveGhz.length} AP(s) on 5 GHz in range; ${a.coChannel.length} share your channel.`,
    ]);
  } else if (a.myChannel !== null && a.myChannel > 14) {
    out.push([
      "info",
      `${a.fiveGhz.length} AP(s) on 5 GHz and ${a.sixGhz.length} on 6 GHz are visible, but Windows did not say which of the two this link is on. 5 GHz reaches further, 6 GHz has more room; PingLab will not guess.`,
    ]);
  } else if (a.myChannel !== null) {
    if (a.fiveGhz.length) {
      out.push([
        "info",
        `5 GHz is visible: ${names(a.fiveGhz)}. PingLab cannot tell which AP is yours; if one is your router, joining its 5 GHz network avoids the crowded 2.4 GHz band.`,
      ]);
    }
    out.push([
      "dim",
      "2.4 GHz is shared with Bluetooth, microwaves and every nearby network; the band, not this channel setting, is the limit. Its extra range is exactly why it is crowded.",
    ]);
  }

  if (!a.bandUnknown && a.bandUnknownAps.length) {
    out.push([
      "dim",
      `${a.bandUnknownAps.length} visible AP(s) sit on channels both 5 GHz and 6 GHz use and Windows named no band for them, so they are counted as neither.`,
    ]);
  }

  if (scan?.truncated) {
    out.push(["dim", "The scan list was cut at 40 networks, so counts above are of the first 40 radio blocks Windows returned."]);
  }
  return out;
}

/** The GUID of the Wi-Fi adapter, when Windows reports one that can be scanned. */
async function wifiAdapterGuid() {
  try {
    const list = await adapters();
    return list.find((a) => a.wifi && a.guid)?.guid || null;
  } catch {
    return null;
  }
}

/**
 * The channel scan every surface reads.
 *
 * Windows can answer `netsh wlan show networks` from a list it never dates, so the list alone
 * cannot say whether it was just built or sat there for an hour. What the WLAN API can say is
 * when a scan finished: this now asks Windows to scan (WlanScan, via a small bounded C# shim)
 * and waits for WLAN AutoConfig's scan-complete notification *before* reading netsh.
 *
 * `freshness` therefore says exactly what happened: ok only when a completion notification
 * arrived after the request, with the measured time from request to completion; otherwise the
 * reason, and no claim at all. The list is read either way, so a machine where the shim cannot
 * run keeps the old behaviour instead of losing the scan. Even a confirmed scan dates the
 * scan, not every network in it, and the advice still scopes every count to "visible" /
 * "in this scan".
 *
 * 1.0.18 guessed freshness from the number of visible networks: two or fewer meant "cached",
 * so it opened the network flyout, waited, re-read, and withheld every count-based line. That
 * invented a stale verdict on a quiet two-network home and hid a stale five-network list
 * behind a fresh one. This module never infers freshness from the list; it only reports what
 * the WLAN API confirmed.
 *
 * The adapter is looked up here rather than passed in, so every surface scans the same card
 * from the same place and a stale id from a cached dashboard cannot turn into a failed scan.
 */
export async function scanWifi() {
  const freshness = await triggerScan({ guid: await wifiAdapterGuid() });
  const scan = await wifiScan();
  return { ...scan, freshness };
}
