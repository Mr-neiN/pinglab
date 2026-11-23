import { execFile } from "node:child_process";
import { wifiScan, bandOf } from "./net.mjs";

// The band rules live with the netsh parsing they describe; re-exported because every
// surface already asks this module for the label.
export { bandOf } from "./net.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  const inMyBand = (n) => !myBand || !n.band || n.band === myBand;
  const coChannel = others.filter((n) => n.channel === myChannel && inMyBand(n));
  const adjacent = others.filter(
    (n) => myChannel !== null && n.channel !== myChannel && overlap(myChannel, n.channel) > 0 && inMyBand(n),
  );
  const fiveGhz = others.filter((n) => n.band === "5 GHz");
  const sixGhz = others.filter((n) => n.band === "6 GHz");

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
 * coarse quality percentage, the scan is often a cache holding only one or two networks,
 * and the adapter's capabilities are not exposed at all. This function therefore only
 * claims what the inputs actually support. A cached scan suppresses every count-based
 * claim (including "no co-channel interference"), and the advice never invents an adapter
 * limit or assumes which visible access point is the user's router.
 */
export function wifiAdvice(a, wifi, scan = null) {
  const out = [];
  if (!wifi?.connected) {
    out.push(["warn", "Windows is not reporting Wi-Fi details."]);
    return out;
  }
  const stale = Boolean(scan?.stale);
  const rates =
    wifi.rxMbps || wifi.txMbps
      ? ` Windows reports a ${wifi.rxMbps ?? "?"} Mbps receive rate${wifi.txMbps ? ` and ${wifi.txMbps} Mbps transmit rate` : ""}; that is the negotiated link rate, not a speed test.`
      : "";
  out.push([
    "info",
    `You are on ${a.mySsid || "your network"} — ${a.myBand || "?"}, channel ${a.myChannel ?? "?"}, signal quality ${wifi.signalPct ?? "?"}%.${rates}`,
  ]);

  if (stale) {
    out.push([
      "warn",
      "Windows returned a cached scan, so this is not a survey: neighbour counts and 'clean channel' claims are withheld until a fresh scan. The connection details above come from the live interface, not the cache.",
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
    if (!stale) {
      out.push([
        a.coChannel.length ? "warn" : "good",
        `${a.sixGhz.length} AP(s) on 6 GHz in range; ${a.coChannel.length} share your channel. 6 GHz has the most room and the shortest range — good in one room, poor through walls.`,
      ]);
    }
  } else if (a.myBand === "5 GHz" || (a.myChannel !== null && a.myChannel > 14)) {
    if (stale) {
      out.push(["info", "Above 2.4 GHz is the right place for gaming: more room than 2.4 GHz, more range than 6 GHz."]);
    } else {
      out.push([
        a.coChannel.length ? "warn" : "good",
        `${a.fiveGhz.length} AP(s) on 5 GHz in range; ${a.coChannel.length} share your channel.`,
      ]);
    }
  } else if (a.myChannel !== null) {
    if (!stale && a.fiveGhz.length) {
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

  if (scan?.truncated) {
    out.push(["dim", "The scan list was cut at 40 networks, so counts above are of the first 40 radio blocks Windows returned."]);
  }
  return out;
}

/**
 * Windows serves a cached scan list; a list holding only your AP (or your AP plus one
 * stale entry) is a cache, not a survey. Opening the network flyout makes Windows scan
 * for real, so the cache fills within ~3 s.
 */
function openWifiPanel() {
  return new Promise((resolve) => {
    try {
      execFile("powershell", ["-NoProfile", "-Command", "Start-Process 'ms-availablenetworks:'"], { timeout: 8000 }, () => resolve());
    } catch {
      resolve();
    }
  });
}

export async function scanWifi({ onStale } = {}) {
  let scan = await wifiScan();
  const first = scan?.networks?.length || 0;
  if (scan?.ok && first <= 2) {
    onStale?.();
    await openWifiPanel();
    await sleep(3600);
    const again = await wifiScan();
    if ((again?.networks?.length || 0) > first) {
      again.refreshed = true;
      scan = again;
    } else {
      scan.stale = true;
    }
  }
  return scan;
}
