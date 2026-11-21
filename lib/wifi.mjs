import { execFile } from "node:child_process";
import { wifiScan } from "./net.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const bandOf = (channel) => (typeof channel === "number" ? (channel <= 14 ? "2.4 GHz" : "5 GHz") : null);

/** Interference-weighted channel ranking for 2.4 GHz (2.4 channels overlap ±4). */
export function analyseWifi(scan, wifi) {
  const nets = (scan?.networks || []).map((n) => ({
    ssid: n.ssid || "(hidden)",
    channel: typeof n.channel === "number" ? n.channel : null,
    signal: typeof n.signalPct === "number" ? n.signalPct : n.signal ?? null,
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

  const coChannel = others.filter((n) => n.channel === myChannel);
  const adjacent = others.filter((n) => myChannel !== null && n.channel !== myChannel && overlap(myChannel, n.channel) > 0);
  const fiveGhz = others.filter((n) => n.channel > 14);

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
    best24,
    myScore: myChannel !== null && myChannel <= 14 ? Math.round(score(myChannel)) : null,
  };
}

/** Plain-language verdicts, each tagged good / warn / bad / info / dim. */
export function wifiAdvice(a, wifi) {
  const out = [];
  if (!wifi?.connected) {
    out.push(["warn", "Windows is not reporting Wi-Fi details."]);
    return out;
  }
  out.push(["info", `You are on ${a.mySsid} — ${a.myBand || "?"}, channel ${a.myChannel ?? "?"}, signal ${wifi.signalPct ?? "?"}%.`]);

  if (a.coChannel.length === 0) {
    out.push(["good", `No other access point is on channel ${a.myChannel}. Co-channel interference: none.`]);
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
      `${a.adjacent.length} nearby AP(s) partially overlap your channel: ${a.adjacent
        .map((n) => `${n.ssid} (ch ${n.channel}, ${n.signal ?? "?"}%)`)
        .join(", ")}.`,
    ]);
  }

  if (a.myChannel !== null && a.myChannel <= 14) {
    if (a.myScore === 0) {
      out.push(["good", `Channel ${a.myChannel} scores ${a.myScore} — leave it alone.`]);
    } else if (a.best24 && a.best24.ch !== a.myChannel) {
      out.push([
        "info",
        `Cleanest 2.4 GHz choice here is channel ${a.best24.ch} (interference score ${a.best24.score}); yours scores ${a.myScore}.`,
      ]);
    } else {
      out.push(["good", `Channel ${a.myChannel} is already the cleanest 2.4 GHz choice (score ${a.myScore}).`]);
    }
    out.push(["dim", "2.4 GHz caps out around 144 Mbps on this adapter (2x2, 20 MHz). A 5 GHz link is the bigger win, not a channel change."]);
  }

  if (a.myChannel !== null && a.myChannel > 14) {
    const same = a.others.filter((n) => n.channel === a.myChannel).length;
    out.push([same ? "warn" : "good", `${a.fiveGhz.length} AP(s) on 5 GHz in range; ${same} share your channel.`]);
  } else if (a.fiveGhz.length) {
    out.push([
      "info",
      `5 GHz is visible and lightly used: ${a.fiveGhz
        .map((n) => `${n.ssid} ch ${n.channel} (${n.signal ?? "?"}%)`)
        .join(", ")}. None of these is your router — enable 5 GHz on it if it has a radio, and prefer ch 36.`,
    ]);
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
