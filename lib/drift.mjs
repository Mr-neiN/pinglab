/**
 * Drift: a change PingLab made that is no longer in place.
 *
 * A restore point records what was there before PingLab touched a setting, and the live state
 * says what Windows reports now. Comparing them with the value PingLab set answers a question
 * neither source can answer alone: did the change stick?
 *
 * It often does not. A Windows or driver update resets NIC power management, switching power
 * plan leaves the row on the scheme that was tuned, a re-seated or replaced adapter gets a new
 * GUID, and DHCP hands the router's DNS back. Every surface used to show the live state and the
 * restore points side by side and leave the contradiction to the reader, so "your machine is
 * tuned" could quietly stop being true without anything saying so.
 *
 * Only a setting whose live value is plainly not what PingLab wrote is called drift. When the
 * reading cannot settle the question - the Wi-Fi profile was deleted, the plan values are
 * unreadable, DNS reads a list that is neither what PingLab set nor what it replaced - the row
 * says so instead of guessing, and it is not counted.
 */
import { readBackups } from "./tweaks.mjs";
import { schemeKey } from "./backups.mjs";
import { tweakById } from "./catalog.mjs";

const labelOf = (id) => tweakById(id)?.label || id;
const norm = (v) => String(v ?? "").trim().toLowerCase();
const list = (servers) => ((servers || []).length ? servers.join(", ") : "nothing");

/** Order-insensitive comparison of two server lists, as Windows reports them. */
function sameList(a, b) {
  const A = (a || []).map(norm);
  const B = (b || []).map(norm);
  return A.length === B.length && [...A].sort().join("\n") === [...B].sort().join("\n");
}

function row(id, at, state, observation) {
  return { key: id, setting: labelOf(id), appliedAt: at || null, state, observation };
}

/** What the live reading says about every setting PingLab holds a restore point for. */
export function driftRows(tw) {
  if (!tw) return [];
  const b = readBackups();
  const alias = tw.alias;
  const rows = [];

  // Wireless power saving is written to the scheme that was active. Two ways it goes back:
  // Windows resets the value, or the user switches to another plan (which then reads stock).
  // The power-plan point belongs to the scheme, not the adapter that happened to apply it.
  // When the user switched plans afterwards and only one scheme was ever recorded, that record
  // is the one this row is about: it is the change that is no longer in effect.
  const planRecords = Object.values(b.planPower || {});
  const planAt = b.planPower?.[schemeKey(tw.powerRaw?.scheme)] ?? (planRecords.length === 1 ? planRecords[0] : null);
  if (planAt) {
    const raw = tw.powerRaw || {};
    const ac = typeof raw.planAc === "number" ? raw.planAc : null;
    const dc = typeof raw.planDc === "number" ? raw.planDc : null;
    const switchedNow = Boolean(planAt.scheme && raw.scheme && norm(raw.scheme) !== norm(planAt.scheme));
    if (ac === 0 && dc === 0) {
      rows.push(
        row(
          "plan-power",
          planAt.at,
          "in-place",
          switchedNow
            ? "the active power plan is a different one, but it also reads maximum performance on both power sources"
            : "the active power plan still reads maximum performance on both power sources",
        ),
      );
    } else if (ac === null || dc === null) {
      rows.push(row("plan-power", planAt.at, "unknown", "the power-plan values cannot be read right now"));
    } else {
      rows.push(
        row(
          "plan-power",
          planAt.at,
          "reverted",
          switchedNow
            ? `the power plan was switched after PingLab tuned it, so the plan in use reads AC ${ac} / battery ${dc} instead of 0/0`
            : `the plan reads AC ${ac} / battery ${dc} again instead of 0/0`,
        ),
      );
    }
  }

  const nicAt = b.nicPower?.[alias];
  if (nicAt) {
    if (tw.nicPower === "off") {
      rows.push(row("nic-power", nicAt.at, "in-place", "Windows still may not power the device down"));
    } else if (tw.nicPower === "unknown" || tw.nicPower === null || tw.nicPower === undefined) {
      rows.push(row("nic-power", nicAt.at, "unknown", "the device power setting cannot be read right now"));
    } else if (tw.nicPower === "unsupported") {
      rows.push(
        row(
          "nic-power",
          nicAt.at,
          "reverted",
          "the driver no longer exposes a device power-management setting, so the change is gone",
        ),
      );
    } else {
      rows.push(
        row(
          "nic-power",
          nicAt.at,
          "reverted",
          `Windows may power the device down again - it reads "${tw.nicDetail || "on"}"`,
        ),
      );
    }
  }

  // Nagle's values live under the adapter's current GUID, so a new GUID is itself the drift:
  // the two values are still written under the old adapter's key and this one reads stock.
  const nagleAt = b.nagle?.[alias];
  if (nagleAt) {
    if (tw.nagleDisabled) {
      rows.push(row("nagle", nagleAt.at, "in-place", "the two registry values are still 1"));
    } else {
      const moved = Boolean(nagleAt.guid && tw.guid && norm(nagleAt.guid) !== norm(tw.guid));
      rows.push(
        row(
          "nagle",
          nagleAt.at,
          "reverted",
          moved
            ? `the adapter's GUID changed since PingLab wrote this (recorded ${nagleAt.guid}, now ${tw.guid}), so the values are under the old adapter's key`
            : `TcpAckFrequency and TCPNoDelay read ${tw.nagleValues?.tcpAckFrequency ?? "absent"} / ${tw.nagleValues?.tcpNoDelay ?? "absent"} again`,
        ),
      );
    }
  }

  const tuningAt = b.adapterTuning?.[alias];
  if (tuningAt) {
    const at = tw.adapterTuning;
    if (!at) {
      rows.push(
        row("radio-tuning", tuningAt.at, "unknown", "the driver no longer reports MIMO power save or roaming aggressiveness"),
      );
    } else if (at.needsFix) {
      const now = (at.items || []).map((i) => i.display).join(", ") || "its stock values";
      rows.push(row("radio-tuning", tuningAt.at, "reverted", `the driver reads ${now} again`));
    } else {
      rows.push(row("radio-tuning", tuningAt.at, "in-place", "the driver still reports the tuned values"));
    }
  }

  // The auto-connect row moved the joined network first. Another saved network taking first
  // place again is the drift; a deleted profile or a disconnected adapter cannot be judged.
  const orderAt = b.wifiOrder?.[alias];
  if (orderAt) {
    const wo = tw.wifiOrder;
    // The change moved the profile recorded in the restore point. The network joined *now* is a
    // different question: on a laptop that later connects elsewhere, asking about the current
    // profile called the change in place (or undone) depending on a network PingLab never moved.
    const moved = orderAt.joined || null;
    if (!wo) {
      rows.push(row("wifi-order", orderAt.at, "unknown", "this adapter is not wireless any more"));
    } else if (!wo.readable) {
      rows.push(row("wifi-order", orderAt.at, "unknown", "the WLAN profile list is unreadable right now"));
    } else if (!moved) {
      rows.push(row("wifi-order", orderAt.at, "unknown", "the restore point does not name the profile it moved"));
    } else if (!wo.profiles.some((p) => norm(p) === norm(moved))) {
      rows.push(row("wifi-order", orderAt.at, "unknown", `the saved profile for "${moved}" is gone`));
    } else {
      const position = wo.profiles.findIndex((p) => norm(p) === norm(moved)) + 1;
      if (position === 1) {
        rows.push(row("wifi-order", orderAt.at, "in-place", `"${moved}" is still first`));
      } else {
        rows.push(
          row(
            "wifi-order",
            orderAt.at,
            "reverted",
            `"${moved}" is #${position} again, so an adapter reset can rejoin another saved network`,
          ),
        );
      }
    }
  }

  // DNS has no fixed target: what PingLab wrote is the `to` list in the change history. That
  // is what makes "back to the recorded servers" distinguishable from "someone else chose".
  const dnsAt = b.dns?.[alias];
  if (dnsAt) {
    const live = tw.currentDns || [];
    const applied =
      (b.history || []).find(
        (h) => h?.action === "dns" && h?.detail?.alias === alias && Array.isArray(h.detail.to) && h.detail.to.length,
      )?.detail.to || null;
    if (sameList(live, dnsAt.servers)) {
      rows.push(
        row("dns", dnsAt.at, "reverted", `the adapter reads ${list(live)} again, the servers recorded before the change`),
      );
    } else if (applied && sameList(live, applied)) {
      rows.push(row("dns", dnsAt.at, "in-place", `the adapter still reads ${list(applied)}`));
    } else if (!live.length) {
      rows.push(row("dns", dnsAt.at, "unknown", "the adapter reads no DNS servers right now"));
    } else {
      rows.push(
        row(
          "dns",
          dnsAt.at,
          "unknown",
          `the adapter reads ${list(live)}, neither what PingLab set${applied ? ` (${list(applied)})` : ""} nor what it replaced (${list(dnsAt.servers)}), so something else changed it`,
        ),
      );
    }
  }

  return rows;
}

/**
 * The one sentence every surface prints, so the fixes view, the GUI's Fixes tab, the page and
 * `--audit` cannot describe the same drift differently. The ports (row keys, buttons) differ per
 * surface, so this names only the settings and what is true of all of them: the record is intact.
 */
export function driftText(drifted) {
  const n = (drifted || []).length;
  if (!n) return null;
  const names = drifted.map((r) => r.setting);
  const named = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return n === 1
    ? `1 change PingLab made has since been undone by something else: ${named}. The restore point is still there, so applying that row again puts it back.`
    : `${n} changes PingLab made have since been undone by something else: ${named}. Their restore points are still there, so applying those rows again puts them back.`;
}

/** Rows, the drifted subset, and the shared sentence. `count` is what surfaces key on. */
export function driftStatus(tw) {
  const rows = driftRows(tw);
  const drifted = rows.filter((r) => r.state === "reverted");
  return { rows, drifted, count: drifted.length, text: driftText(drifted) };
}
