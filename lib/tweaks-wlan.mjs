import { join } from "node:path";
import { runElevated, runPs } from "./ps.mjs";
import { sq } from "./tweak-shared.mjs";
import { oneLine } from "./one-line.mjs";
import { readBackups, recordRestorePoint, finishChange, updateBackups, logChange } from "./backups.mjs";
/**
 * The profile precedence list from `netsh wlan show profiles`. Windows prints one block
 * per profile class, each title underlined with dashes; the user profiles are the last
 * block, so read-only group-policy entries above it can never leak in. Null means "no
 * such block", and the caller refuses to guess rather than writing a wrong order.
 */
function parseWlanProfiles(text) {
  const lines = String(text || "").split(/\r?\n/);
  let start = -1;
  for (let i = 0; i < lines.length; i++) if (/^-{3,}\s*$/.test(lines[i])) start = i + 1;
  if (start < 0) return null;
  const names = [];
  for (const line of lines.slice(start)) {
    const m = line.match(/^\s+\S.*?\s*:\s*(.+?)\s*$/);
    // Profile names are SSIDs: shown in the page, the GUI and the terminal, and passed to
    // netsh, so a control byte in one never survives (lib/one-line.mjs).
    if (m) names.push(oneLine(m[1]));
  }
  return names;
}

/** SSID of the network the wireless adapter is joined to, if any. */
function parseJoinedSsid(text) {
  const name = String(text || "").match(/^\s*SSID\s*:\s*(.+?)\s*$/m)?.[1] || null;
  return name ? oneLine(name) : null;
}

/** True when `got` opens with every still-existing profile of `want`, in order. */
export function sameOrder(got, want) {
  const present = (want || []).filter((n) => got.some((g) => g.toLowerCase() === n.toLowerCase()));
  return present.every((n, i) => (got[i] || "").toLowerCase() === n.toLowerCase());
}

/**
 * The netsh calls that put `want` back on top of `current`. Assigning position k+1 to the
 * profile that belongs there, top down, leaves the prefix correct after every step, so the
 * final list matches `want` from any starting arrangement.
 */
export function planOrderSteps(alias, want, current, fail) {
  const sim = [...current];
  const steps = [];
  const present = (want || []).filter((n) => sim.some((c) => c.toLowerCase() === n.toLowerCase()));
  present.forEach((name, k) => {
    const idx = sim.findIndex((c) => c.toLowerCase() === name.toLowerCase());
    if (idx === k) return;
    const real = sim[idx];
    steps.push(
      `$n = '${sq(real)}'\nnetsh wlan set profileorder name="$n" interface="$alias" priority=${k + 1} | Out-Null\nif ($LASTEXITCODE -ne 0) { ${fail(real, k + 1)} }`,
    );
    sim.splice(idx, 1);
    sim.splice(k, 0, real);
  });
  return steps;
}

/** WLAN precedence list and the joined SSID. Never throws. */
export async function readWlanOrder(alias) {
  const iface = await runPs("netsh wlan show interfaces", { timeout: 15000 });
  const text = iface.stdout || "";
  // A machine without a wireless adapter answers with a plain "no wireless interface".
  if (!iface.ok || !/(\bSSID\s*:|\bBSSID\s*:|802\.11|\bName\s*:)/i.test(text)) return { wifi: false };
  const joined = parseJoinedSsid(text);
  const listed = await runPs(`netsh wlan show profiles interface="${String(alias).replace(/"/g, "")}"`, {
    timeout: 15000,
  });
  return { wifi: true, joined, profiles: parseWlanProfiles(listed.stdout) };
}

/** What the auto-connect row shows, and whether PingLab is the reason it changed. */
export async function wlanOrderState(alias) {
  const read = await readWlanOrder(alias);
  if (!read.wifi) return null;
  const profiles = read.profiles || [];
  const target = read.joined ? profiles.find((p) => p.toLowerCase() === read.joined.toLowerCase()) || null : null;
  const position = target ? profiles.indexOf(target) + 1 : null;
  return {
    readable: read.profiles !== null,
    profiles,
    joined: read.joined,
    target,
    position,
    isFirst: position === 1,
    appliedByUs: Boolean(readBackups().wifiOrder[alias]),
  };
}

/**
 * Move the joined network's profile to the top of the auto-connect order, so an adapter
 * reset rejoins it instead of whichever saved network happens to come first. The whole
 * previous order is recorded, and only when it actually changed - pressing this twice is
 * a no-op that stores nothing new and asks for no elevation.
 */
export async function setWlanOrderFirst(alias) {
  const read = await readWlanOrder(alias);
  if (!read.wifi) return { ok: false, error: "This adapter is not wireless, so it has no auto-connect order." };
  if (read.profiles === null) {
    return { ok: false, error: "Windows returned no readable WLAN profile list (netsh wlan show profiles)." };
  }
  if (!read.profiles.length) {
    return { ok: false, error: "No saved Wi-Fi profiles on this adapter, so there is no order to change." };
  }
  if (!read.joined) {
    return { ok: false, error: "This adapter is not joined to a Wi-Fi network, so there is no profile to move first." };
  }
  const target = read.profiles.find((p) => p.toLowerCase() === read.joined.toLowerCase());
  if (!target) {
    return { ok: false, error: `Wi-Fi is joined to "${read.joined}", but Windows has no saved profile of that name.` };
  }
  if (read.profiles[0] === target) {
    return {
      ok: true,
      data: { ok: true, message: `"${target}" is already first in the auto-connect order - nothing to change.` },
    };
  }

  // The order read above is the restore point: it is saved before Windows is asked to move
  // anything, so a failed or timed-out netsh call cannot leave a changed order without it.
  const point = recordRestorePoint("wifiOrder", alias, { profiles: read.profiles, joined: read.joined });
  if (!point.ok) return point;

  const script = `
$alias = '${sq(alias)}'
$n = '${sq(target)}'
netsh wlan set profileorder name="$n" interface="$alias" priority=1 | Out-Null
if ($LASTEXITCODE -ne 0) { throw "netsh refused to move '$n' to the top (exit $LASTEXITCODE)" }
$result = [ordered]@{ ok = $true; message = 'auto-connect order updated' }
`;
  const detail = { alias, order: read.profiles, target };
  const res = await runElevated(script);
  if (!res.ok) return finishChange(res, { token: point.token, action: "wifi-order-first", detail });

  const after = await readWlanOrder(alias);
  if (!after.profiles || after.profiles[0] !== target) {
    // netsh ran, so the order may have moved even though the read-back does not show the
    // result asked for: the restore point stays, because it is what puts the order back.
    return {
      ok: false,
      error: `Windows accepted the command but the order still reads ${(after.profiles || []).join(" > ") || "unreadable"}.`,
    };
  }

  return finishChange(
    {
      ok: true,
      data: {
        ok: true,
        message: `"${target}" is now first in the Wi-Fi auto-connect order; an adapter reset rejoins it instead of another saved network.`,
        order: after.profiles,
      },
    },
    { token: point.token, action: "wifi-order-first", detail },
  );
}

/**
 * Put the recorded precedence back and drop the restore point. Profiles deleted since the
 * backup are left out rather than recreated, and the result is verified by reading the
 * order again instead of trusting netsh's exit code.
 */
export async function restoreWlanOrder(alias) {
  const rec = readBackups().wifiOrder?.[alias];
  if (!rec?.profiles?.length) return { ok: false, error: "Nothing recorded to restore for the Wi-Fi auto-connect order." };
  const cur = await readWlanOrder(alias);
  if (cur.profiles === null) {
    return { ok: false, error: "The WLAN profile list is unreadable right now, so the order cannot be restored safely." };
  }

  const steps = planOrderSteps(alias, rec.profiles, cur.profiles, (name, k) =>
    `throw "netsh refused to move '${name}' to position ${k} (exit $LASTEXITCODE)"`,
  );
  if (!steps.length) {
    updateBackups((b) => {
      delete b.wifiOrder[alias];
    });
    logChange("wifi-order-restore", { alias, order: rec.profiles, noop: true });
    return {
      ok: true,
      data: { ok: true, message: `The auto-connect order already matches what was recorded (${rec.profiles.join(" > ")}).` },
    };
  }

  const script = `$alias = '${sq(alias)}'\n${steps.join("\n")}\n$result = [ordered]@{ ok = $true; message = 'auto-connect order restored' }`;
  const res = await runElevated(script);
  if (!res.ok) return res;

  const after = await readWlanOrder(alias);
  if (!sameOrder(after.profiles || [], rec.profiles)) {
    return {
      ok: false,
      error: `The order did not come back as recorded: now ${(after.profiles || []).join(" > ") || "unreadable"}.`,
    };
  }

  return finishChange(
    { ok: true, data: { ok: true, message: `Auto-connect order restored: ${(after.profiles || []).join(" > ")}.` } },
    {
      after: (b) => {
        delete b.wifiOrder[alias];
      },
      action: "wifi-order-restore",
      detail: { alias, order: rec.profiles },
    },
  );
}

