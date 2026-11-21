# PingLab

A local Windows network doctor for gaming: it measures latency, jitter, loss, bufferbloat, DNS and Wi-Fi quality, explains what it finds, and applies a small set of **reversible** fixes. Every change is recorded before it is made and can be undone, and every claim is checked by reading the setting back from Windows rather than trusting a command that returned without error.

It runs entirely on your machine. The only network traffic is the measurements themselves (your endpoint pings, DNS lookups, bufferbloat transfer). There is no telemetry, no account and no cloud.

## Requirements

- Windows 10 or 11.
- **Node.js 22 or newer** for the terminal app and the local web UI (the run history uses Node's built-in `node:sqlite`).
- PowerShell 5.1, which ships with Windows, for the desktop GUI.
- A wireless adapter if you want the Wi-Fi rows; a machine without one shows those rows as "not applicable" instead of guessing.
- Location services enabled for your account if you want SSID/signal/channel detail on Windows 11. When Windows hides those fields, the web UI reports that reason and offers to open the Location settings page; elevation does not bypass it.
- Administrator approval (UAC) for each change; "apply every fix" bundles them into a single prompt. Reading state never needs it.

## Launching it

Three surfaces, one engine (`lib/`) and one dispatch table for every action (`lib/tweaks.mjs`), so they cannot drift apart.

| surface | how | notes |
|---|---|---|
| Desktop GUI | double-click `PingLab.cmd` | PowerShell WinForms; tabs for Overview, Fixes, Wi-Fi, Latency, Soak test |
| Terminal | `PingLab-TUI.cmd`, or `node pinglab.mjs` | keys shown at the bottom of each view |
| Web UI | `node server.mjs` (or `npm start`) → <http://127.0.0.1:4747> | bound to loopback only |

One-shot commands from a terminal:

```
node pinglab.mjs --once        render the dashboard once
node pinglab.mjs --fixes       list the reversible fixes and their state
node pinglab.mjs --audit       every managed setting vs what Windows/the driver reports
node pinglab.mjs --wifi        channel and band diagnosis
node pinglab.mjs --probe       latency to the configured game endpoints
node pinglab.mjs --dns         DNS resolver benchmark
node pinglab.mjs --soak [min]  soak test, default 10 minutes
node pinglab.mjs --apply X     X = plan | nic | nagle | wifi | order
node pinglab.mjs --revert X    undo that one setting
node pinglab.mjs --restore     restore everything PingLab changed
node pinglab.mjs --json        raw snapshot as JSON
```

In the terminal app, `f` opens the fixes view and `1`–`5` apply or revert a row, `A` applies all of them behind one prompt, `R` restores everything.

Which surface offers what:

| | plan | NIC | Nagle | radio | auto-connect order | DNS benchmark + apply |
|---|---|---|---|---|---|---|
| TUI | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ (`d` view) |
| GUI | ✓ | ✓ | ✓ | ✓ | ✓ | reads the current servers in Overview; no benchmark |
| Web | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

All three call the same `runTweakAction` dispatch table, so a row that exists on one surface exists on the others; the web UI has no separate allowlist of actions.


## What each setting changes

All of these are off until you press the button; nothing is applied at startup.

| # | setting | what changes on the system | effect you can see | undo |
|---|---|---|---|---|
| 1 | **Wireless power saving (power plan)** | `powercfg` AC/DC index for *Wireless Adapter Settings → Power Saving Mode* (subgroup `19cbb8fa…`, setting `12bbebe6…`) set to `0` = maximum performance | the radio is not throttled to save battery, so latency stops stepping up and down | press 1 again: the recorded AC/DC values are written back (`restore everything` additionally drops the per-scheme override when it matches the scheme default) |
| 2 | **NIC power management** | `Disable-NetAdapterPowerManagement` for the adapter | Windows may not power the device down while it looks idle | Revert re-enables it. Many Wi-Fi drivers expose no such setting; the row then says "not available" instead of pretending |
| 3 | **Nagle's algorithm** | `TcpAckFrequency=1`, `TCPNoDelay=1` under `HKLM\SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces\{adapter GUID}` | small TCP packets are sent immediately instead of being batched | original values are restored; keys that did not exist are removed again |
| 4 | **Wi-Fi radio power save (driver)** | driver properties `MIMOPowerSaveMode=3` (No SMPS) and `RoamAggressiveness=0` (Lowest) | kept as an option only: measured across repeated soaks here it showed **no** gain, so the row calls the vendor defaults "not tuned for a fixed desktop" rather than wrong | previous values are written back |
| 5 | **Wi-Fi auto-connect order** | `netsh wlan set profileorder` moves the profile of the network you are *currently joined to* to priority 1 | after an adapter reset or driver reload, Windows rejoins that network instead of whichever saved network happens to be first | the exact previous precedence is replayed, profile by profile, and verified by reading the list back |
| — | **DNS** | `Set-DnsClientServerAddress` on the adapter — only when you press the button (TUI and web UI), never automatically | lookups go to the resolver that won the benchmark | `dns-reset` hands the adapter back to DHCP-provided DNS |

Two rules the app holds itself to:

- **No winner, no change.** DNS is only offered when one resolver answered at least 80% of probes, leads the median by at least 10%, **and** wins at least 70% of the head-to-head probes. Otherwise the message says which resolver led and why that is noise, and DNS is left alone.
- **Verified, not assumed.** Every write is read back afterwards (registry values, `powercfg` indices, driver properties, DNS server list, the netsh precedence list). If the read-back disagrees, the change is reported as failed, not as done.

## Undoing things

- **One setting:** press its key in the terminal, its button in the GUI, or its button in the web UI. The inverse is always derived from the stored backup, never from a default.
- **Everything:** `R` in the terminal, *Restore everything PingLab changed* in the GUI, `node pinglab.mjs --restore`, or the *Restore everything* button in the web UI. One elevation prompt restores every recorded setting to the values captured before PingLab touched them, then clears the restore points.
- If a restore does not read back as recorded (for example a profile was deleted in the meantime), the restore point is **kept** and the result says what disagreed, so you can retry rather than losing the original values.

Restore points live in `data/backups.json`; `node pinglab.mjs --audit` prints them under "restore points". A count of 0 means the machine is at its original values.

## What it deliberately only advises

These are never changed automatically, because the right answer depends on your hardware, your flat or your ISP:

- **Which DNS resolver to use.** The app measures and recommends; you decide. The evidence bar is described above.
- **Wi-Fi channel and band.** Co-channel and adjacent-channel interference, and whether a 5 GHz channel is free, are reported. Moving the access point or changing its channel is your router's job.
- **Router-side settings** (QoS, SQM, band steering) and **ISP plans.** Out of scope by design; anything claiming a network speed-up from registry edits is not in this tool.
- **Windows Location services**, needed for Wi-Fi detail on Windows 11. The web UI can open the settings page for you; the app does not flip the switch.

## Files it writes

Everything stays inside this folder:

- `data/backups.json` — restore points and the change history. Keep it if you have changes applied.
- `data/pinglab.sqlite` — probe, DNS and soak history.
- `data/bridge-out.*.jsonl`, `data/tmp/` — transient files used by the GUI bridge and elevated calls.

Deleting the database resets history; deleting `backups.json` while changes are applied means PingLab can no longer undo them.

## Development

- `lib/dns.mjs` holds the resolver benchmark and the verdict rule; `lib/dns-verdict.test.mjs` drives both verdict branches and the 10% / 70% / tie boundaries with fixed inputs — run it with `node lib/dns-verdict.test.mjs`.
- `lib/tweaks.mjs` is the single dispatch table (`runTweakAction`); add a setting there and all three surfaces pick it up.
- `node pinglab.mjs --audit` is the check to run after touching any setting logic: it compares what the app claims against what Windows and the driver actually report.

## Limits

- Windows only, and localized `netsh` output is parsed — the profile list is found by its dashed section headers rather than by English keywords, but unusual formats make the row refuse to act instead of guessing.
- The auto-connect row needs a wireless adapter, at least one saved profile and a current connection; with no profiles, no joined network, or no profile matching the SSID it says exactly that and changes nothing. If a profile recorded in a backup has since been deleted, restore leaves it out rather than recreating it.
- One UAC prompt per change; a dismissed prompt is reported as "nothing changed", never as success.
- No installer, no license file, no telemetry. Copy the folder, install Node, run it.
